"use strict";

const path = require("path");
const http = require("http");
const os = require("os");
const crypto = require("crypto");
const express = require("express");
const QRCode = require("qrcode");
const { Server } = require("socket.io");
const { rounds, TEAM_COLORS } = require("./data/questions");
const {
  normalizeGameSet,
  toEditorGame,
  summarizeGameSet,
  imageDataForQuestion,
  loadCustomGames,
  saveCustomGames
} = require("./lib/custom-games");

const PORT = Number(process.env.PORT) || 3000;
const MAX_TEAMS = 8;
const HOST_PASSWORD = process.env.HOST_PASSWORD || "svoya";
const CUSTOM_GAMES_FILE = process.env.CUSTOM_GAMES_FILE
  ? path.resolve(process.env.CUSTOM_GAMES_FILE)
  : path.join(__dirname, "data", "custom-games.json");
const AUTH_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingTimeout: 20000,
  pingInterval: 10000,
  maxHttpBufferSize: 40 * 1024 * 1024
});

const authTokens = new Map();
let customGames = new Map();
let selectedGameId = "builtin";
let persistQueue = Promise.resolve();

const BUILTIN_GAME_SET = {
  id: "builtin",
  name: "Классическая игра",
  description: "Два раунда по пять тем и пять вопросов",
  builtin: true,
  source: "builtin",
  createdAt: null,
  updatedAt: null,
  rounds
};

function activeGameSet() {
  if (selectedGameId !== "builtin" && customGames.has(selectedGameId)) {
    return customGames.get(selectedGameId);
  }
  return BUILTIN_GAME_SET;
}

function gameSetSummary(definition = activeGameSet()) {
  return summarizeGameSet(definition);
}

function availableGameSets() {
  return [
    summarizeGameSet(BUILTIN_GAME_SET),
    ...Array.from(customGames.values())
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .map(summarizeGameSet)
  ];
}

function customGameSummaries() {
  return Array.from(customGames.values())
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map(summarizeGameSet);
}

/* ------------------------------------------------------------------ */
/* Сеть и QR-код                                                       */
/* ------------------------------------------------------------------ */

function listLanAddresses() {
  const result = [];
  const interfaces = os.networkInterfaces();

  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (entry.address.startsWith("169.254.")) continue;
      result.push({ name, address: entry.address });
    }
  }

  const score = (entry) => {
    if (/^192\.168\./.test(entry.address)) return 3;
    if (/^10\./.test(entry.address)) return 2;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(entry.address)) return 1;
    return 0;
  };

  return result.sort((a, b) => score(b) - score(a));
}

const lanAddresses = listLanAddresses();
const hostOverride = (process.env.HOST_IP || "").trim();
const publicHost = hostOverride || lanAddresses[0]?.address || "127.0.0.1";
const joinUrl = `http://${publicHost}:${PORT}/player`;
let qrDataUrl = "";

async function buildQrCode() {
  try {
    qrDataUrl = await QRCode.toDataURL(joinUrl, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 760,
      color: { dark: "#0d1120", light: "#ffffff" }
    });
  } catch (error) {
    console.error("Не удалось построить QR-код:", error.message);
  }
}

/* ------------------------------------------------------------------ */
/* Пароль и токены                                                     */
/* ------------------------------------------------------------------ */

function passwordMatches(candidate) {
  if (typeof candidate !== "string") return false;
  const expected = crypto.createHash("sha256").update(HOST_PASSWORD).digest();
  const actual = crypto.createHash("sha256").update(candidate).digest();
  return crypto.timingSafeEqual(expected, actual);
}

function issueAuthToken(role) {
  const token = crypto.randomBytes(28).toString("hex");
  authTokens.set(token, {
    role,
    expiresAt: Date.now() + AUTH_TOKEN_TTL_MS
  });
  return token;
}

function verifyAuthToken(token, role) {
  if (typeof token !== "string" || !token) return false;
  const entry = authTokens.get(token);
  if (!entry) return false;
  if (entry.expiresAt <= Date.now()) {
    authTokens.delete(token);
    return false;
  }
  return entry.role === role;
}

function cleanupAuthTokens() {
  const now = Date.now();
  for (const [token, entry] of authTokens) {
    if (entry.expiresAt <= now) authTokens.delete(token);
  }
}
setInterval(cleanupAuthTokens, 30 * 60 * 1000).unref();

/* ------------------------------------------------------------------ */
/* Сохранение пользовательских игр                                     */
/* ------------------------------------------------------------------ */

function persistCustomGames() {
  const snapshot = Array.from(customGames.values());
  persistQueue = persistQueue
    .then(() => saveCustomGames(CUSTOM_GAMES_FILE, snapshot))
    .catch((error) => {
      console.error("Не удалось сохранить пользовательские игры:", error.message);
    });
  return persistQueue;
}

function editorState() {
  return {
    games: customGameSummaries(),
    serverNow: Date.now()
  };
}

function sendEditorState(socket) {
  socket.emit("editor:state", editorState());
}

function broadcastEditorState() {
  io.to("role:editor").emit("editor:state", editorState());
}

/* ------------------------------------------------------------------ */
/* Состояние игры                                                      */
/* ------------------------------------------------------------------ */

const DEFAULT_SETTINGS = Object.freeze({
  questionTimerEnabled: true,
  questionTimerSeconds: 60,
  answerTimerEnabled: true,
  answerTimerSeconds: 30,
  votingTimerEnabled: true,
  votingTimerSeconds: 15,
  wrongAnswerPenaltyEnabled: false,
  manualBuzzControlEnabled: false
});

const game = {
  phase: "lobby", // lobby | themeSelect | question | voting | finished
  roundIndex: 0,
  board: buildBoard(0),
  teams: [],
  currentSelectorTeamId: null,
  currentQuestion: null,
  voting: null,
  votes: new Map(),
  settings: { ...DEFAULT_SETTINGS },
  startedAt: null,
  lastEvent: { seq: 0, type: "boot", data: {}, at: Date.now() }
};

const timers = {
  question: null,
  answer: null,
  voting: null,
  reveal: null,
  autoClose: null,
  autoVote: null
};

let eventSeq = 0;

/* ------------------------------------------------------------------ */
/* Утилиты состояния                                                   */
/* ------------------------------------------------------------------ */

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function randomId(prefix) {
  return `${prefix}-${crypto.randomBytes(5).toString("hex")}`;
}

function findTeam(teamId) {
  return game.teams.find((team) => team.id === teamId) || null;
}

function findPlayer(playerId) {
  for (const team of game.teams) {
    const player = team.players.find((item) => item.id === playerId);
    if (player) return { player, team };
  }
  return null;
}

function onlineCount(team) {
  return team.players.reduce((count, player) => count + (player.connected ? 1 : 0), 0);
}

function isTeamOnline(team) {
  return onlineCount(team) > 0;
}

function onlineTeams() {
  return game.teams.filter(isTeamOnline);
}

function teamStatus(team) {
  if (game.currentQuestion?.buzzedTeamId === team.id) return "answering";
  if (team.blocked) return "blocked";
  if (onlineCount(team) === 0) return team.players.length ? "offline" : "empty";
  return "ready";
}

function publicTeam(team, detailed = false) {
  const base = {
    id: team.id,
    name: team.name,
    color: team.color,
    score: team.score,
    blocked: Boolean(team.blocked),
    status: teamStatus(team),
    onlineCount: onlineCount(team),
    playerCount: team.players.length,
    isSelector: game.currentSelectorTeamId === team.id
  };
  if (detailed) {
    base.players = team.players.map((player) => ({
      id: player.id,
      name: player.name,
      connected: Boolean(player.connected)
    }));
  }
  return base;
}

function buildBoard(roundIndex, definition = activeGameSet()) {
  const round = definition.rounds[roundIndex] || definition.rounds[0];
  const cells = [];
  if (!round) return cells;

  round.themes.forEach((theme, themeIndex) => {
    theme.questions.forEach((question, valueIndex) => {
      let imageUrl = null;
      if (question.image && !definition.builtin) {
        imageUrl =
          `/api/game-image/${encodeURIComponent(definition.id)}/` +
          `${roundIndex}/${themeIndex}/${valueIndex}?v=${definition.updatedAt || 0}`;
      }
      cells.push({
        id: `r${roundIndex + 1}-t${themeIndex}-v${valueIndex}`,
        themeIndex,
        valueIndex,
        theme: theme.title,
        value: question.value,
        text: question.text,
        answer: question.answer,
        image: question.image || null,
        imageUrl,
        played: false
      });
    });
  });
  return cells;
}

function currentRoundMeta() {
  const definition = activeGameSet();
  const round = definition.rounds[game.roundIndex] || definition.rounds[0];
  const complete = Boolean(game.board && game.board.length && game.board.every((cell) => cell.played));
  return {
    index: game.roundIndex,
    number: game.roundIndex + 1,
    total: definition.rounds.length,
    name: round?.name || "",
    subtitle: round?.subtitle || "",
    complete
  };
}

function boardThemes() {
  if (!game.board) return [];
  const definition = activeGameSet();
  const round = definition.rounds[game.roundIndex] || definition.rounds[0];
  if (!round) return [];
  return round.themes.map((theme, themeIndex) => ({
    index: themeIndex,
    title: theme.title,
    cells: game.board
      .filter((cell) => cell.themeIndex === themeIndex)
      .sort((a, b) => a.value - b.value)
      .map((cell) => ({
        id: cell.id,
        value: cell.value,
        valueIndex: cell.valueIndex,
        played: cell.played,
        current: game.currentQuestion?.cellId === cell.id
      }))
  }));
}

function markCurrentCellPlayed() {
  if (!game.currentQuestion) return;
  const cell = game.board?.find((item) => item.id === game.currentQuestion.cellId);
  if (cell) cell.played = true;
}

function resetBlocks() {
  for (const team of game.teams) team.blocked = false;
}

function sortedStandings() {
  const sorted = [...game.teams].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.name.localeCompare(b.name, "ru");
  });
  let previousScore = null;
  let previousRank = 0;
  return sorted.map((team, index) => {
    if (team.score !== previousScore) {
      previousRank = index + 1;
      previousScore = team.score;
    }
    return {
      ...publicTeam(team),
      rank: previousRank
    };
  });
}

function winnerTeams() {
  if (!game.teams.length) return [];
  const best = Math.max(...game.teams.map((team) => team.score));
  return game.teams
    .filter((team) => team.score === best)
    .map((team) => publicTeam(team));
}

function isGameOver() {
  return game.phase === "finished" && game.roundIndex >= activeGameSet().rounds.length - 1;
}

function roundIsComplete() {
  return Boolean(game.board && game.board.length && game.board.every((cell) => cell.played));
}

function nextSelectorAfter(previousId) {
  if (!game.teams.length) return null;
  const pool = onlineTeams().length ? onlineTeams() : game.teams;
  if (!previousId) return pool[0]?.id || null;
  const index = pool.findIndex((team) => team.id === previousId);
  if (index === -1) return pool[0]?.id || null;
  return pool[(index + 1) % pool.length]?.id || null;
}

function firstSelector() {
  return onlineTeams()[0]?.id || game.teams[0]?.id || null;
}

function selectorSummary() {
  const team = findTeam(game.currentSelectorTeamId);
  return team ? publicTeam(team) : null;
}

function setEvent(type, data = {}) {
  game.lastEvent = {
    seq: ++eventSeq,
    type,
    data,
    at: Date.now()
  };
}

/* ------------------------------------------------------------------ */
/* Таймеры                                                             */
/* ------------------------------------------------------------------ */

function clearQuestionTimer() {
  if (timers.question) clearTimeout(timers.question);
  timers.question = null;
  if (game.currentQuestion) game.currentQuestion.timer = null;
}

function clearAnswerTimer() {
  if (timers.answer) clearTimeout(timers.answer);
  timers.answer = null;
  if (game.currentQuestion) game.currentQuestion.answerTimer = null;
}

function clearVotingTimer() {
  if (timers.voting) clearTimeout(timers.voting);
  timers.voting = null;
}

function clearRevealTimer() {
  if (timers.reveal) clearTimeout(timers.reveal);
  timers.reveal = null;
}

function clearAutoClose() {
  if (timers.autoClose) clearTimeout(timers.autoClose);
  timers.autoClose = null;
}

function clearAutoVote() {
  if (timers.autoVote) clearTimeout(timers.autoVote);
  timers.autoVote = null;
}

function clearAllTimers() {
  clearQuestionTimer();
  clearAnswerTimer();
  clearVotingTimer();
  clearRevealTimer();
  clearAutoClose();
  clearAutoVote();
}

function armQuestionTimer() {
  clearQuestionTimer();
  const question = game.currentQuestion;
  if (!question || game.phase !== "question" || question.status !== "shown") return;
  if (!game.settings.questionTimerEnabled) return;
  if (game.settings.manualBuzzControlEnabled && !question.buzzUnlocked) return;

  const durationMs = game.settings.questionTimerSeconds * 1000;
  const endsAt = Date.now() + durationMs;
  question.timer = {
    endsAt,
    durationSeconds: game.settings.questionTimerSeconds
  };

  timers.question = setTimeout(() => {
    timers.question = null;
    const current = game.currentQuestion;
    if (
      game.phase === "question" &&
      current &&
      current.status === "shown" &&
      current.timer?.endsAt === endsAt
    ) {
      current.timer = null;
      startVotingInternal("timer");
      broadcast();
    }
  }, durationMs);
}

function armAnswerTimer() {
  clearAnswerTimer();
  const question = game.currentQuestion;
  if (
    !question ||
    game.phase !== "question" ||
    question.status !== "buzzed" ||
    !question.buzzedTeamId ||
    !game.settings.answerTimerEnabled
  ) {
    return;
  }

  const durationSeconds = game.settings.answerTimerSeconds;
  const durationMs = durationSeconds * 1000;
  const endsAt = Date.now() + durationMs;
  question.answerTimer = { endsAt, durationSeconds };

  timers.answer = setTimeout(() => {
    timers.answer = null;
    const current = game.currentQuestion;
    if (
      game.phase === "question" &&
      current &&
      current.status === "buzzed" &&
      current.answerTimer?.endsAt === endsAt &&
      current.buzzedTeamId
    ) {
      const teamId = current.buzzedTeamId;
      current.answerTimer = null;
      applyWrongAnswer(teamId, "answer_timeout");
    }
  }, durationMs);
}

function armVotingTimer() {
  clearVotingTimer();
  if (!game.voting || !game.voting.endsAt) return;
  const endsAt = game.voting.endsAt;
  const delay = Math.max(0, endsAt - Date.now());

  timers.voting = setTimeout(() => {
    timers.voting = null;
    if (game.phase !== "voting" || !game.voting || game.voting.endsAt !== endsAt) return;

    const outcome = computedVotingOutcome();
    if (outcome) {
      applyVotingOutcome(outcome, "timer");
    } else {
      game.voting.timedOut = true;
      game.voting.endsAt = null;
      game.voting.outcome = null;
      setEvent("voting:tie", {
        counts: votingCounts(),
        message: "Время вышло, голоса разделились. Решение за ведущим."
      });
      broadcast();
    }
  }, delay);
}

/* ------------------------------------------------------------------ */
/* Состояние для разных ролей                                          */
/* ------------------------------------------------------------------ */

function timerView(now) {
  if (game.phase === "voting" && game.voting?.endsAt) {
    return {
      type: "voting",
      endsAt: game.voting.endsAt,
      durationSeconds: game.voting.durationSeconds,
      remainingMs: Math.max(0, game.voting.endsAt - now)
    };
  }
  if (game.phase === "question" && game.currentQuestion?.answerTimer?.endsAt) {
    return {
      type: "answer",
      endsAt: game.currentQuestion.answerTimer.endsAt,
      durationSeconds: game.currentQuestion.answerTimer.durationSeconds,
      remainingMs: Math.max(0, game.currentQuestion.answerTimer.endsAt - now)
    };
  }
  if (game.phase === "question" && game.currentQuestion?.timer?.endsAt) {
    return {
      type: "question",
      endsAt: game.currentQuestion.timer.endsAt,
      durationSeconds: game.currentQuestion.timer.durationSeconds,
      remainingMs: Math.max(0, game.currentQuestion.timer.endsAt - now)
    };
  }
  return null;
}

function questionView(audience) {
  const question = game.currentQuestion;
  if (!question) return null;

  const textVisible = audience === "host" || question.status !== "selected";
  const answerVisible =
    audience === "host" ||
    question.status === "revealed" ||
    (question.status === "result" && question.result?.correct);
  const buzzLocked = Boolean(
    question.status === "shown" &&
      game.settings.manualBuzzControlEnabled &&
      !question.buzzUnlocked
  );

  return {
    cellId: question.cellId,
    theme: question.theme,
    value: question.value,
    status: question.status,
    text: textVisible ? question.text : null,
    imageUrl:
      question.imageUrl && (audience === "host" || textVisible) ? question.imageUrl : null,
    answer: answerVisible ? question.answer : null,
    answerVisible,
    buzzLocked,
    buzzUnlocked: question.buzzUnlocked !== false,
    buzzedTeamId: question.buzzedTeamId || null,
    buzzedTeamName: question.buzzedTeamId
      ? findTeam(question.buzzedTeamId)?.name || null
      : null,
    buzzedTeamColor: question.buzzedTeamId
      ? findTeam(question.buzzedTeamId)?.color || null
      : null,
    blockedTeamIds: game.teams.filter((team) => team.blocked).map((team) => team.id),
    result: question.result || null,
    revealReason: question.revealReason || null,
    selectedAt: question.selectedAt || null,
    shownAt: question.shownAt || null,
    revealedAt: question.revealedAt || null
  };
}

function votingCounts() {
  const counts = { continue: 0, pass: 0 };
  for (const vote of game.votes.values()) {
    if (vote.choice === "continue") counts.continue += 1;
    if (vote.choice === "pass") counts.pass += 1;
  }
  return counts;
}

function computedVotingOutcome() {
  const counts = votingCounts();
  if (counts.continue > counts.pass) return "continue";
  if (counts.pass > counts.continue) return "pass";
  return null;
}

function votingDetails(audience) {
  const ids = new Set(onlineTeams().map((team) => team.id));
  for (const teamId of game.votes.keys()) ids.add(teamId);

  return game.teams
    .filter((team) => ids.has(team.id))
    .map((team) => {
      const vote = game.votes.get(team.id);
      const detail = {
        teamId: team.id,
        name: team.name,
        color: team.color,
        choice: vote?.choice || null,
        voted: Boolean(vote)
      };
      if (audience === "host") {
        detail.voterName = vote?.playerName || null;
        detail.votedAt = vote?.at || null;
      }
      return detail;
    });
}

function votingView(now, audience, viewerTeamId = null) {
  if (!game.voting) return null;
  const counts = votingCounts();
  const details = votingDetails(audience);
  const eligibleCount = onlineTeams().length;
  return {
    active: game.phase === "voting",
    reason: game.voting.reason,
    endsAt: game.voting.endsAt,
    durationSeconds: game.voting.durationSeconds,
    timedOut: Boolean(game.voting.timedOut),
    allVoted: Boolean(game.voting.allVoted),
    counts,
    outcome: computedVotingOutcome(),
    details,
    votesCast: game.votes.size,
    eligibleCount,
    yourVote: viewerTeamId ? game.votes.get(viewerTeamId)?.choice || null : null
  };
}

function baseState(audience, now) {
  return {
    phase: game.phase,
    gameSet: gameSetSummary(),
    selectedGameId,
    round: currentRoundMeta(),
    board: boardThemes(),
    teams: game.teams.map((team) => publicTeam(team, audience === "host")),
    standings: sortedStandings(),
    selectorTeamId: game.currentSelectorTeamId,
    selectorTeam: selectorSummary(),
    currentQuestion: questionView(audience),
    timer: timerView(now),
    totalRounds: activeGameSet().rounds.length,
    isGameOver: isGameOver(),
    roundComplete: roundIsComplete(),
    winners: isGameOver() ? winnerTeams() : [],
    join: {
      url: joinUrl,
      qrDataUrl,
      addresses: lanAddresses,
      host: publicHost,
      port: PORT
    },
    stats: {
      teams: game.teams.length,
      onlinePlayers: game.teams.reduce((sum, team) => sum + onlineCount(team), 0),
      totalPlayers: game.teams.reduce((sum, team) => sum + team.players.length, 0)
    },
    lastEvent: game.lastEvent,
    serverNow: now
  };
}

function hostState(now = Date.now()) {
  return {
    ...baseState("host", now),
    voting: votingView(now, "host"),
    settings: { ...game.settings },
    availableGameSets: availableGameSets()
  };
}

function screenState(now = Date.now()) {
  return {
    ...baseState("screen", now),
    voting: votingView(now, "screen")
  };
}

function playerState(player, now = Date.now()) {
  const team = findTeam(player.teamId);
  const question = game.currentQuestion;
  const status = team ? teamStatus(team) : "empty";
  const canBuzz = Boolean(
    team &&
      game.phase === "question" &&
      question?.status === "shown" &&
      !team.blocked &&
      onlineCount(team) > 0 &&
      (!game.settings.manualBuzzControlEnabled || question.buzzUnlocked)
  );

  return {
    ...baseState("player", now),
    voting: votingView(now, "player", team?.id || null),
    you: {
      playerId: player.id,
      name: player.name,
      team: team
        ? {
            ...publicTeam(team),
            members: team.players.map((item) => ({
              id: item.id,
              name: item.name,
              connected: Boolean(item.connected)
            }))
          }
        : null,
      canBuzz,
      hasBuzzed:
        Boolean(team && question?.buzzedTeamId === team.id && question?.status === "buzzed"),
      isBlocked: Boolean(team?.blocked),
      yourVote: team ? game.votes.get(team.id)?.choice || null : null
    }
  };
}

function playerLobbyState(now = Date.now()) {
  return {
    phase: game.phase,
    round: currentRoundMeta(),
    teams: game.teams.map((team) => publicTeam(team)),
    joinUrl,
    serverNow: now,
    started: game.phase !== "lobby",
    stats: {
      onlinePlayers: game.teams.reduce((sum, team) => sum + onlineCount(team), 0),
      teams: game.teams.length
    }
  };
}

function sendInitialState(socket, role) {
  const now = Date.now();
  if (role === "host") socket.emit("host:state", hostState(now));
  if (role === "screen") socket.emit("screen:state", screenState(now));
  if (role === "observer") socket.emit("lobby:state", playerLobbyState(now));
}

function broadcast() {
  const now = Date.now();
  io.to("role:screen").emit("screen:state", screenState(now));
  io.to("role:host").emit("host:state", hostState(now));
  io.to("role:editor").emit("editor:state", editorState());
  io.to("role:player-observer").emit("lobby:state", playerLobbyState(now));

  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.role !== "player" || !socket.data.playerId) continue;
    const found = findPlayer(socket.data.playerId);
    if (found && found.player.socketId === socket.id) {
      socket.emit("player:state", playerState(found.player, now));
    }
  }
}

/* ------------------------------------------------------------------ */
/* Игровые переходы                                                    */
/* ------------------------------------------------------------------ */

function startVotingInternal(reason = "host") {
  if (game.phase !== "question" || !game.currentQuestion) return false;
  if (!["shown", "buzzed"].includes(game.currentQuestion.status)) return false;

  clearQuestionTimer();
  clearAnswerTimer();
  clearAutoVote();
  clearAutoClose();

  game.phase = "voting";
  game.currentQuestion.status = "voting";
  game.currentQuestion.buzzedTeamId = null;
  game.currentQuestion.buzzAt = null;
  game.currentQuestion.timer = null;
  game.currentQuestion.answerTimer = null;
  game.votes.clear();

  const durationSeconds = game.settings.votingTimerSeconds;
  const endsAt = game.settings.votingTimerEnabled ? Date.now() + durationSeconds * 1000 : null;

  game.voting = {
    reason,
    startedAt: Date.now(),
    durationSeconds,
    endsAt,
    timedOut: false,
    allVoted: false,
    outcome: null
  };

  setEvent("voting:start", {
    reason,
    questionTheme: game.currentQuestion.theme,
    questionValue: game.currentQuestion.value,
    durationSeconds,
    endsAt
  });
  armVotingTimer();
  return true;
}

function applyWrongAnswer(teamId, reason = "host") {
  if (game.phase !== "question" || !game.currentQuestion) return null;
  const question = game.currentQuestion;
  if (question.status !== "buzzed" || !question.buzzedTeamId) return null;

  const team = findTeam(teamId || question.buzzedTeamId);
  if (!team) return null;

  clearQuestionTimer();
  clearAnswerTimer();
  clearAutoVote();
  clearAutoClose();

  const penalty = game.settings.wrongAnswerPenaltyEnabled ? question.value : 0;
  if (penalty) team.score -= penalty;

  team.blocked = true;
  question.status = "shown";
  question.buzzedTeamId = null;
  question.buzzAt = null;
  question.answerTimer = null;
  question.buzzUnlocked = !game.settings.manualBuzzControlEnabled;
  question.result = {
    correct: false,
    type: "wrong",
    reason,
    timedOut: reason === "answer_timeout",
    teamId: team.id,
    teamName: team.name,
    teamColor: team.color,
    penalty,
    score: team.score,
    at: Date.now()
  };

  setEvent("wrong", {
    teamId: team.id,
    teamName: team.name,
    teamColor: team.color,
    theme: question.theme,
    value: question.value,
    penalty,
    score: team.score,
    reason,
    timedOut: reason === "answer_timeout"
  });

  const online = onlineTeams();
  const remaining = online.filter((item) => !item.blocked);
  if (online.length > 0 && remaining.length === 0) {
    clearQuestionTimer();
    timers.autoVote = setTimeout(() => {
      timers.autoVote = null;
      if (
        game.phase === "question" &&
        game.currentQuestion?.status === "shown" &&
        onlineTeams().length > 0 &&
        onlineTeams().every((item) => item.blocked)
      ) {
        startVotingInternal("all-failed");
        broadcast();
      }
    }, 2400);
  } else if (!game.settings.manualBuzzControlEnabled) {
    armQuestionTimer();
  }

  broadcast();
  return { team, penalty };
}

function beginAnswerReveal({
  reason = "host_closed",
  eventType = "question:reveal",
  eventData = {}
}) {
  if (game.phase !== "question" && game.phase !== "voting") return false;
  const question = game.currentQuestion;
  if (!question || question.status === "selected" || question.status === "revealed") {
    return false;
  }

  clearQuestionTimer();
  clearAnswerTimer();
  clearVotingTimer();
  clearAutoVote();
  clearAutoClose();

  markCurrentCellPlayed();
  resetBlocks();
  question.status = "revealed";
  question.buzzedTeamId = null;
  question.buzzAt = null;
  question.timer = null;
  question.answerTimer = null;
  question.revealedAt = Date.now();
  question.revealReason = reason;
  if (!question.result || question.result.correct !== true) {
    question.result = {
      correct: false,
      type: "revealed",
      reason,
      at: Date.now()
    };
  }

  game.phase = "question";
  game.voting = null;
  game.votes.clear();

  setEvent(eventType, {
    ...eventData,
    answer: question.answer,
    reason,
    theme: question.theme,
    value: question.value
  });

  clearRevealTimer();
  timers.reveal = setTimeout(() => {
    timers.reveal = null;
    if (
      game.phase === "question" &&
      game.currentQuestion?.status === "revealed"
    ) {
      completeQuestion({
        eventType: "question:close",
        eventData: { reason: "reveal_timeout" }
      });
    }
  }, 6500);

  broadcast();
  return true;
}

function completeQuestion({ eventType, eventData = {} }) {
  clearQuestionTimer();
  clearAnswerTimer();
  clearVotingTimer();
  clearRevealTimer();
  clearAutoClose();
  clearAutoVote();

  const wasQuestion = Boolean(game.currentQuestion);
  const previousSelector = game.currentSelectorTeamId;
  const wasCompleteBefore = roundIsComplete();

  if (wasQuestion) markCurrentCellPlayed();
  resetBlocks();
  game.votes.clear();
  game.voting = null;
  game.currentQuestion = null;

  if (roundIsComplete()) {
    game.phase = "finished";
    game.currentSelectorTeamId = null;
    const gameOver = game.roundIndex >= activeGameSet().rounds.length - 1;
    setEvent(gameOver ? "game:finished" : "round:finished", {
      ...eventData,
      round: currentRoundMeta(),
      isGameOver: gameOver
    });
  } else {
    game.phase = "themeSelect";
    game.currentSelectorTeamId = nextSelectorAfter(previousSelector);
    setEvent(eventType, {
      ...eventData,
      nextSelectorTeamId: game.currentSelectorTeamId
    });
  }

  broadcast();
  return { wasCompleteBefore };
}

function applyVotingOutcome(outcome, source) {
  if (game.phase !== "voting" || !game.voting) return false;
  const counts = votingCounts();
  const details = votingDetails("host");
  const questionTheme = game.currentQuestion?.theme;
  const questionValue = game.currentQuestion?.value;

  clearVotingTimer();
  game.voting.outcome = outcome;

  if (outcome === "continue") {
    game.phase = "question";
    game.currentQuestion.status = "shown";
    game.currentQuestion.buzzedTeamId = null;
    game.currentQuestion.buzzAt = null;
    game.currentQuestion.result = null;
    game.currentQuestion.answerTimer = null;
    game.currentQuestion.buzzUnlocked = !game.settings.manualBuzzControlEnabled;
    game.votes.clear();
    resetBlocks();
    game.voting = null;
    if (game.settings.manualBuzzControlEnabled) {
      clearQuestionTimer();
    } else {
      armQuestionTimer();
    }
    setEvent("voting:resume", {
      outcome,
      source,
      counts,
      details,
      questionTheme,
      questionValue,
      buzzLocked: Boolean(game.settings.manualBuzzControlEnabled)
    });
    broadcast();
    return true;
  }

  game.voting = null;
  beginAnswerReveal({
    reason: "voting_pass",
    eventType: "voting:pass",
    eventData: {
      outcome: "pass",
      source,
      counts,
      details,
      questionTheme,
      questionValue
    }
  });
  return true;
}

function finishQuestionAsPass(source = "host") {
  if (game.phase === "voting") return applyVotingOutcome("pass", source);
  if (game.phase !== "question" || !game.currentQuestion) return false;
  if (game.currentQuestion.status === "selected") return cancelSelectedQuestion();

  const questionTheme = game.currentQuestion.theme;
  const questionValue = game.currentQuestion.value;
  beginAnswerReveal({
    reason: "skip",
    eventType: "voting:pass",
    eventData: {
      outcome: "pass",
      source,
      counts: { continue: 0, pass: 0 },
      details: [],
      questionTheme,
      questionValue
    }
  });
  return true;
}

function cancelSelectedQuestion() {
  clearQuestionTimer();
  clearAnswerTimer();
  clearVotingTimer();
  clearRevealTimer();
  clearAutoClose();
  clearAutoVote();
  const question = game.currentQuestion;
  if (!question || question.status !== "selected") return false;
  game.currentQuestion = null;
  game.voting = null;
  game.votes.clear();
  resetBlocks();
  game.phase = "themeSelect";
  setEvent("question:cancel", {
    theme: question.theme,
    value: question.value
  });
  broadcast();
  return true;
}

/* ------------------------------------------------------------------ */
/* Express                                                             */
/* ------------------------------------------------------------------ */

app.use(express.json());
app.use(
  express.static(path.join(__dirname, "public"), {
    extensions: ["html"],
    etag: true,
    setHeaders(res, filePath) {
      if (/\.(html|js|css)$/i.test(filePath)) {
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
      }
    }
  })
);

app.get("/favicon.ico", (_req, res) => {
  res.status(204).end();
});
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.get("/screen", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "screen.html"));
});
app.get("/host", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "host.html"));
});
app.get("/player", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "player.html"));
});
app.get("/editor", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "editor.html"));
});
app.get("/api/game-image/:gameId/:roundIndex/:themeIndex/:questionIndex", (req, res) => {
  const definition = customGames.get(req.params.gameId);
  if (!definition) {
    res.status(404).end();
    return;
  }
  const image = imageDataForQuestion(
    definition,
    Number.parseInt(req.params.roundIndex, 10),
    Number.parseInt(req.params.themeIndex, 10),
    Number.parseInt(req.params.questionIndex, 10)
  );
  if (!image) {
    res.status(404).end();
    return;
  }
  res.set("Content-Type", image.mime);
  res.set("Cache-Control", "public, max-age=86400");
  res.send(image.buffer);
});
app.get("/api/info", (_req, res) => {
  res.json({
    ok: true,
    joinUrl,
    addresses: lanAddresses,
    port: PORT,
    phase: game.phase,
    teams: game.teams.map((team) => publicTeam(team)),
    serverNow: Date.now()
  });
});
app.get("/health", (_req, res) => {
  res.json({ ok: true, phase: game.phase, teams: game.teams.length });
});

/* ------------------------------------------------------------------ */
/* Socket.IO: подключение                                              */
/* ------------------------------------------------------------------ */

io.on("connection", (socket) => {
  socket.data.role = null;
  socket.data.playerId = null;
  socket.data.authFailures = 0;
  socket.data.authBlockedUntil = 0;

  socket.on("auth:login", (payload = {}, ack) => {
    const role = payload?.role;
    if (!["host", "editor"].includes(role)) {
      if (typeof ack === "function") {
        ack({ ok: false, code: "BAD_ROLE", error: "Неизвестная защищённая зона." });
      }
      return;
    }

    const now = Date.now();
    if (socket.data.authBlockedUntil > now) {
      if (typeof ack === "function") {
        ack({
          ok: false,
          code: "TOO_MANY_ATTEMPTS",
          error: "Слишком много попыток. Подождите полминуты."
        });
      }
      return;
    }

    if (!passwordMatches(payload?.password)) {
      socket.data.authFailures += 1;
      if (socket.data.authFailures >= 8) {
        socket.data.authFailures = 0;
        socket.data.authBlockedUntil = now + 30_000;
        if (typeof ack === "function") {
          ack({
            ok: false,
            code: "TOO_MANY_ATTEMPTS",
            error: "Слишком много попыток. Подождите полминуты."
          });
        }
        return;
      }
      if (typeof ack === "function") {
        ack({ ok: false, code: "BAD_PASSWORD", error: "Неверный пароль." });
      }
      return;
    }

    socket.data.authFailures = 0;
    const token = issueAuthToken(role);
    if (typeof ack === "function") {
      ack({ ok: true, token, expiresInMs: AUTH_TOKEN_TTL_MS });
    }
  });

  socket.on("join", (payload = {}, ack) => {
    const role = payload?.role;

    if (role === "screen") {
      socket.data.role = "screen";
      socket.join("role:screen");
      sendInitialState(socket, "screen");
      if (typeof ack === "function") ack({ ok: true, role: "screen" });
      return;
    }

    if (role === "host") {
      if (!verifyAuthToken(payload?.token, "host")) {
        if (typeof ack === "function") {
          ack({
            ok: false,
            code: "AUTH_REQUIRED",
            error: "Для пульта ведущего нужен пароль."
          });
        }
        return;
      }
      socket.data.role = "host";
      socket.join("role:host");
      sendInitialState(socket, "host");
      if (typeof ack === "function") ack({ ok: true, role: "host" });
      return;
    }

    if (role === "editor") {
      if (!verifyAuthToken(payload?.token, "editor")) {
        if (typeof ack === "function") {
          ack({
            ok: false,
            code: "AUTH_REQUIRED",
            error: "Для редактора нужен пароль."
          });
        }
        return;
      }
      socket.data.role = "editor";
      socket.join("role:editor");
      sendEditorState(socket);
      if (typeof ack === "function") ack({ ok: true, role: "editor" });
      return;
    }

    if (role === "player") {
      handlePlayerJoin(socket, payload, ack);
      return;
    }

    if (typeof ack === "function") {
      ack({ ok: false, error: "Неизвестная роль подключения." });
    }
  });

  /* -------------------------- Игрок ------------------------------- */
  function handlePlayerJoin(socket, payload, ack) {
    const suppliedPlayerId = cleanText(payload.playerId, 80);
    const name = cleanText(payload.name, 24);
    const teamId = cleanText(payload.teamId, 80);
    const teamName = cleanText(payload.teamName, 24);

    // Восстановление сессии после перезагрузки телефона.
    if (suppliedPlayerId) {
      const existing = findPlayer(suppliedPlayerId);
      if (existing) {
        const { player, team } = existing;
        if (player.socketId && player.socketId !== socket.id) {
          const oldSocket = io.sockets.sockets.get(player.socketId);
          if (oldSocket) {
            oldSocket.data.playerId = null;
            oldSocket.disconnect(true);
          }
        }

        player.socketId = socket.id;
        player.connected = true;
        if (name) player.name = name;
        socket.data.role = "player";
        socket.data.playerId = player.id;
        socket.leave("role:player-observer");
        socket.join("role:player");
        if (typeof ack === "function") {
          ack({
            ok: true,
            restored: true,
            playerId: player.id,
            teamId: team.id,
            teamName: team.name
          });
        }
        socket.emit("player:state", playerState(player));
        broadcast();
        return;
      }
    }

    // Режим "только смотрю список команд" до регистрации.
    if (!name && !suppliedPlayerId) {
      socket.data.role = "player-observer";
      socket.data.playerId = null;
      socket.join("role:player-observer");
      sendInitialState(socket, "observer");
      if (typeof ack === "function") ack({ ok: true, observer: true });
      return;
    }

    if (game.phase !== "lobby") {
      if (typeof ack === "function") {
        ack({
          ok: false,
          code: "GAME_STARTED",
          error: "Игра уже началась. Попросите ведущего нажать «Новая игра»."
        });
      }
      return;
    }

    if (!name) {
      if (typeof ack === "function") {
        ack({ ok: false, code: "NAME_REQUIRED", error: "Введите имя игрока." });
      }
      return;
    }

    let team = teamId ? findTeam(teamId) : null;

    if (!team && teamName) {
      team = game.teams.find(
        (item) => item.name.toLocaleLowerCase("ru") === teamName.toLocaleLowerCase("ru")
      );
      if (!team) {
        if (game.teams.length >= MAX_TEAMS) {
          if (typeof ack === "function") {
            ack({
              ok: false,
              code: "TEAM_LIMIT",
              error: `В игре уже ${MAX_TEAMS} команд — это максимум.`
            });
          }
          return;
        }
        team = {
          id: randomId("team"),
          name: teamName,
          color: TEAM_COLORS[game.teams.length % TEAM_COLORS.length],
          score: 0,
          blocked: false,
          players: []
        };
        game.teams.push(team);
      }
    }

    if (!team) {
      if (typeof ack === "function") {
        ack({
          ok: false,
          code: "TEAM_REQUIRED",
          error: "Выберите команду или создайте новую."
        });
      }
      return;
    }

    const duplicate = team.players.find(
      (player) => player.name.toLocaleLowerCase("ru") === name.toLocaleLowerCase("ru")
    );
    if (duplicate) {
      if (typeof ack === "function") {
        ack({
          ok: false,
          code: "NAME_TAKEN",
          error: "В этой команде уже есть игрок с таким именем. Добавьте фамилию или цифру."
        });
      }
      return;
    }

    const player = {
      id: randomId("player"),
      name,
      teamId: team.id,
      socketId: socket.id,
      connected: true,
      joinedAt: Date.now()
    };
    team.players.push(player);
    socket.data.role = "player";
    socket.data.playerId = player.id;
    socket.leave("role:player-observer");
    socket.join("role:player");

    if (typeof ack === "function") {
      ack({
        ok: true,
        playerId: player.id,
        teamId: team.id,
        teamName: team.name
      });
    }

    setEvent("player:joined", {
      playerName: player.name,
      teamName: team.name,
      teamColor: team.color
    });
    socket.emit("player:state", playerState(player));
    broadcast();
  }

  socket.on("disconnect", () => {
    if (socket.data.role !== "player" || !socket.data.playerId) return;
    const found = findPlayer(socket.data.playerId);
    if (!found) return;
    if (found.player.socketId !== socket.id) return;
    found.player.connected = false;
    found.player.socketId = null;
    broadcast();
  });

  /* ------------------------- Команды хоста ------------------------ */

  function hostOnly(ack) {
    if (socket.data.role === "host") return true;
    if (typeof ack === "function") {
      ack({ ok: false, code: "NOT_HOST", error: "Это действие доступно только ведущему." });
    }
    return false;
  }

  function editorOnly(ack) {
    if (socket.data.role === "editor") return true;
    if (typeof ack === "function") {
      ack({ ok: false, code: "NOT_EDITOR", error: "Это действие доступно только редактору." });
    }
    return false;
  }

  function reply(ack, result, extra = {}) {
    if (typeof ack === "function") ack({ ...result, ...extra });
  }

  function detachPlayerSocket(player, payload) {
    if (!player?.socketId) return;
    const target = io.sockets.sockets.get(player.socketId);
    if (!target) return;

    target.emit("player:kicked", payload);
    target.leave("role:player");
    target.data.role = "player-observer";
    target.data.playerId = null;
    target.join("role:player-observer");
    target.emit("lobby:state", playerLobbyState());
  }

  socket.on("startGame", (_payload, ack) => {
    if (!hostOnly(ack)) return;
    if (game.phase !== "lobby") {
      reply(ack, { ok: false, error: "Игра уже запущена." });
      return;
    }
    if (!game.teams.length) {
      reply(ack, { ok: false, error: "Сначала подключите хотя бы одну команду с игроком." });
      return;
    }
    if (!onlineTeams().length) {
      reply(ack, { ok: false, error: "Ни один игрок не в сети. Подключите телефоны." });
      return;
    }

    clearAllTimers();
    game.phase = "themeSelect";
    game.roundIndex = 0;
    game.board = buildBoard(0);
    game.currentQuestion = null;
    game.voting = null;
    game.votes.clear();
    game.currentSelectorTeamId = firstSelector();
    game.startedAt = Date.now();
    resetBlocks();
    setEvent("game:start", {
      round: currentRoundMeta(),
      selectorTeamId: game.currentSelectorTeamId
    });
    reply(ack, { ok: true });
    broadcast();
  });

  socket.on("selectQuestion", (payload = {}, ack) => {
    if (!hostOnly(ack)) return;
    if (game.phase !== "themeSelect") {
      reply(ack, { ok: false, error: "Сейчас нельзя выбрать вопрос." });
      return;
    }
    const cell = game.board?.find((item) => item.id === payload.cellId);
    if (!cell) {
      reply(ack, { ok: false, error: "Вопрос не найден." });
      return;
    }
    if (cell.played) {
      reply(ack, { ok: false, error: "Этот вопрос уже разыгран." });
      return;
    }

    clearAllTimers();
    resetBlocks();
    game.votes.clear();
    game.voting = null;
    game.currentQuestion = {
      cellId: cell.id,
      themeIndex: cell.themeIndex,
      valueIndex: cell.valueIndex,
      theme: cell.theme,
      value: cell.value,
      text: cell.text,
      answer: cell.answer,
      image: cell.image || null,
      imageUrl: cell.imageUrl || null,
      status: "selected",
      selectedAt: Date.now(),
      shownAt: null,
      buzzedTeamId: null,
      buzzAt: null,
      result: null,
      timer: null
    };
    game.phase = "question";
    if (!game.currentSelectorTeamId) game.currentSelectorTeamId = firstSelector();
    setEvent("question:selected", {
      theme: cell.theme,
      value: cell.value,
      selectorTeamId: game.currentSelectorTeamId
    });
    reply(ack, { ok: true });
    broadcast();
  });

  socket.on("showQuestion", (_payload, ack) => {
    if (!hostOnly(ack)) return;
    if (game.phase !== "question" || !game.currentQuestion) {
      reply(ack, { ok: false, error: "Сначала выберите вопрос на поле." });
      return;
    }
    if (game.currentQuestion.status !== "selected") {
      reply(ack, { ok: false, error: "Вопрос уже показан." });
      return;
    }

    game.currentQuestion.status = "shown";
    game.currentQuestion.shownAt = Date.now();
    game.currentQuestion.result = null;
    game.currentQuestion.buzzUnlocked = !game.settings.manualBuzzControlEnabled;
    game.currentQuestion.answerTimer = null;
    resetBlocks();
    if (game.settings.manualBuzzControlEnabled) {
      clearQuestionTimer();
    } else {
      armQuestionTimer();
    }
    setEvent("question:show", {
      theme: game.currentQuestion.theme,
      value: game.currentQuestion.value,
      buzzLocked: Boolean(game.settings.manualBuzzControlEnabled),
      durationSeconds:
        game.settings.questionTimerEnabled && !game.settings.manualBuzzControlEnabled
          ? game.settings.questionTimerSeconds
          : 0
    });
    reply(ack, { ok: true });
    broadcast();
  });

  socket.on("unlockBuzz", (_payload, ack) => {
    if (!hostOnly(ack)) return;
    if (game.phase !== "question" || !game.currentQuestion) {
      reply(ack, { ok: false, error: "Сейчас нет открытого вопроса." });
      return;
    }
    if (game.currentQuestion.status !== "shown") {
      reply(ack, { ok: false, error: "Кнопки открываются только до нажатия команды." });
      return;
    }
    if (!game.settings.manualBuzzControlEnabled) {
      reply(ack, { ok: false, error: "Ручная блокировка кнопок выключена в настройках." });
      return;
    }
    if (game.currentQuestion.buzzUnlocked) {
      reply(ack, { ok: false, error: "Кнопки уже открыты." });
      return;
    }

    game.currentQuestion.buzzUnlocked = true;
    armQuestionTimer();
    setEvent("buzz:unlocked", {
      theme: game.currentQuestion.theme,
      value: game.currentQuestion.value
    });
    reply(ack, { ok: true });
    broadcast();
  });

  socket.on("buzz", (_payload, ack) => {
    if (socket.data.role !== "player" || !socket.data.playerId) {
      reply(ack, { ok: false, code: "NOT_PLAYER", error: "Только игрок может нажать кнопку." });
      return;
    }
    const found = findPlayer(socket.data.playerId);
    if (!found) {
      reply(ack, { ok: false, code: "PLAYER_NOT_FOUND", error: "Игрок не найден." });
      return;
    }
    const { player, team } = found;

    if (game.phase !== "question" || !game.currentQuestion) {
      reply(ack, { ok: false, code: "NO_QUESTION", error: "Сейчас нет активного вопроса." });
      return;
    }
    if (game.currentQuestion.status !== "shown") {
      reply(ack, {
        ok: false,
        code: "ALREADY_BUZZED",
        error: "Кнопка уже нажата другой командой."
      });
      return;
    }
    if (
      game.settings.manualBuzzControlEnabled &&
      !game.currentQuestion.buzzUnlocked
    ) {
      reply(ack, {
        ok: false,
        code: "BUZZ_LOCKED",
        error: "Ведущий ещё не открыл кнопки."
      });
      return;
    }
    if (team.blocked) {
      reply(ack, {
        ok: false,
        code: "TEAM_BLOCKED",
        error: "Ваша команда уже ошиблась в этом вопросе."
      });
      return;
    }
    if (!isTeamOnline(team)) {
      reply(ack, { ok: false, code: "TEAM_OFFLINE", error: "Команда не в сети." });
      return;
    }

    clearQuestionTimer();
    clearAutoVote();
    clearAnswerTimer();
    game.currentQuestion.status = "buzzed";
    game.currentQuestion.buzzedTeamId = team.id;
    game.currentQuestion.buzzAt = Date.now();
    game.currentQuestion.buzzedByPlayerId = player.id;
    game.currentQuestion.result = null;
    armAnswerTimer();
    setEvent("buzz", {
      teamId: team.id,
      teamName: team.name,
      teamColor: team.color,
      playerName: player.name,
      theme: game.currentQuestion.theme,
      value: game.currentQuestion.value,
      answerTimerEnabled: game.settings.answerTimerEnabled,
      answerTimerSeconds: game.settings.answerTimerSeconds
    });
    reply(ack, { ok: true, teamId: team.id });
    broadcast();
  });

  socket.on("judgeAnswer", (payload = {}, ack) => {
    if (!hostOnly(ack)) return;
    if (game.phase !== "question" || !game.currentQuestion) {
      reply(ack, { ok: false, error: "Сейчас нет вопроса, который можно оценить." });
      return;
    }
    if (game.currentQuestion.status !== "buzzed" || !game.currentQuestion.buzzedTeamId) {
      reply(ack, { ok: false, error: "Сначала команда должна нажать кнопку." });
      return;
    }
    const team = findTeam(game.currentQuestion.buzzedTeamId);
    if (!team) {
      reply(ack, { ok: false, error: "Команда не найдена." });
      return;
    }

    if (payload.correct === true) {
      clearQuestionTimer();
      clearAnswerTimer();
      clearAutoVote();
      clearAutoClose();

      team.score += game.currentQuestion.value;
      game.currentQuestion.status = "result";
      game.currentQuestion.result = {
        correct: true,
        type: "correct",
        teamId: team.id,
        teamName: team.name,
        teamColor: team.color,
        delta: game.currentQuestion.value,
        score: team.score,
        at: Date.now()
      };
      game.currentQuestion.buzzedTeamId = null;
      game.currentQuestion.buzzAt = null;
      game.currentQuestion.answerTimer = null;
      game.currentQuestion.buzzUnlocked = false;
      markCurrentCellPlayed();
      setEvent("correct", {
        teamId: team.id,
        teamName: team.name,
        teamColor: team.color,
        delta: game.currentQuestion.value,
        score: team.score,
        theme: game.currentQuestion.theme,
        value: game.currentQuestion.value,
        answer: game.currentQuestion.answer
      });

      timers.autoClose = setTimeout(() => {
        timers.autoClose = null;
        if (game.phase === "question" && game.currentQuestion?.status === "result") {
          completeQuestion({
            eventType: "question:close",
            eventData: { reason: "correct" }
          });
        }
      }, 6500);
      reply(ack, { ok: true });
      broadcast();
      return;
    }

    const result = applyWrongAnswer(team.id, "host");
    if (!result) {
      reply(ack, { ok: false, error: "Не удалось зафиксировать неверный ответ." });
      return;
    }
    reply(ack, { ok: true });
  });

  socket.on("startVoting", (_payload, ack) => {
    if (!hostOnly(ack)) return;
    if (!startVotingInternal("host")) {
      reply(ack, { ok: false, error: "Голосование можно запустить только во время вопроса." });
      return;
    }
    reply(ack, { ok: true });
    broadcast();
  });

  socket.on("vote", (payload = {}, ack) => {
    if (socket.data.role !== "player" || !socket.data.playerId) {
      reply(ack, { ok: false, error: "Голосовать могут только игроки." });
      return;
    }
    if (game.phase !== "voting" || !game.voting) {
      reply(ack, { ok: false, error: "Голосование сейчас не идёт." });
      return;
    }
    const found = findPlayer(socket.data.playerId);
    if (!found) {
      reply(ack, { ok: false, error: "Игрок не найден." });
      return;
    }
    const { player, team } = found;
    if (game.votes.has(team.id)) {
      reply(ack, {
        ok: false,
        code: "ALREADY_VOTED",
        error: "Ваша команда уже проголосовала."
      });
      return;
    }
    if (!["continue", "pass"].includes(payload.choice)) {
      reply(ack, { ok: false, error: "Неизвестный вариант голоса." });
      return;
    }

    game.votes.set(team.id, {
      choice: payload.choice,
      playerId: player.id,
      playerName: player.name,
      at: Date.now()
    });

    const eligibleIds = onlineTeams().map((item) => item.id);
    const allVoted = eligibleIds.length > 0 && eligibleIds.every((id) => game.votes.has(id));
    if (allVoted) {
      game.voting.allVoted = true;
      game.voting.endsAt = null;
      clearVotingTimer();
    }

    setEvent("vote", {
      teamId: team.id,
      teamName: team.name,
      choice: payload.choice,
      counts: votingCounts(),
      votesCast: game.votes.size,
      eligibleCount: eligibleIds.length,
      allVoted
    });
    reply(ack, { ok: true, allVoted });
    broadcast();
  });

  socket.on("finishVoting", (payload = {}, ack) => {
    if (!hostOnly(ack)) return;
    if (game.phase !== "voting" || !game.voting) {
      reply(ack, { ok: false, error: "Голосование не активно." });
      return;
    }

    const manual = payload.outcome;
    const computed = computedVotingOutcome();
    const outcome = manual === "continue" || manual === "pass" ? manual : computed;

    if (!outcome) {
      reply(ack, {
        ok: false,
        code: "VOTE_TIE",
        error: "Голоса разделились. Выберите «Продолжить» или «Пас»."
      });
      return;
    }

    applyVotingOutcome(outcome, "host");
    reply(ack, { ok: true, outcome });
  });

  socket.on("closeQuestion", (_payload, ack) => {
    if (!hostOnly(ack)) return;

    if (game.phase === "voting") {
      applyVotingOutcome("pass", "host-close");
      reply(ack, { ok: true, outcome: "pass" });
      return;
    }

    if (game.phase !== "question" || !game.currentQuestion) {
      reply(ack, { ok: false, error: "Сейчас нет открытого вопроса." });
      return;
    }

    if (game.currentQuestion.status === "selected") {
      cancelSelectedQuestion();
      reply(ack, { ok: true, cancelled: true });
      return;
    }

    if (
      game.currentQuestion.status === "revealed" ||
      game.currentQuestion.status === "result"
    ) {
      completeQuestion({
        eventType: "question:close",
        eventData: { reason: "host" }
      });
      reply(ack, { ok: true });
      return;
    }

    beginAnswerReveal({
      reason: "host_closed",
      eventType: "question:reveal",
      eventData: { source: "host" }
    });
    reply(ack, { ok: true, revealed: true });
  });

  socket.on("nextSelector", (_payload, ack) => {
    if (!hostOnly(ack)) return;
    if (game.phase !== "themeSelect") {
      reply(ack, { ok: false, error: "Сменить выбирающего можно только перед выбором вопроса." });
      return;
    }
    game.currentSelectorTeamId = nextSelectorAfter(game.currentSelectorTeamId);
    setEvent("selector:change", {
      selectorTeamId: game.currentSelectorTeamId
    });
    reply(ack, { ok: true, selectorTeamId: game.currentSelectorTeamId });
    broadcast();
  });

  socket.on("nextRound", (_payload, ack) => {
    if (!hostOnly(ack)) return;
    if (game.phase !== "finished") {
      reply(ack, { ok: false, error: "Текущий раунд ещё не завершён." });
      return;
    }
    if (game.roundIndex >= activeGameSet().rounds.length - 1) {
      reply(ack, { ok: false, error: "Это был последний раунд. Начните новую игру." });
      return;
    }

    clearAllTimers();
    game.roundIndex += 1;
    game.board = buildBoard(game.roundIndex);
    game.phase = "themeSelect";
    game.currentQuestion = null;
    game.voting = null;
    game.votes.clear();
    resetBlocks();
    game.currentSelectorTeamId = firstSelector();
    setEvent("round:start", {
      round: currentRoundMeta(),
      selectorTeamId: game.currentSelectorTeamId
    });
    reply(ack, { ok: true });
    broadcast();
  });

  socket.on("newGame", (_payload, ack) => {
    if (!hostOnly(ack)) return;

    clearAllTimers();
    game.phase = "lobby";
    game.roundIndex = 0;
    game.board = buildBoard(0);
    game.currentSelectorTeamId = null;
    game.currentQuestion = null;
    game.voting = null;
    game.votes.clear();
    game.startedAt = null;
    resetBlocks();
    for (const team of game.teams) team.score = 0;
    setEvent("new:game", {});
    reply(ack, { ok: true });
    broadcast();
  });

  socket.on("adjustScore", (payload = {}, ack) => {
    if (!hostOnly(ack)) return;
    const team = findTeam(payload.teamId);
    const delta = Number(payload.delta);
    if (!team) {
      reply(ack, { ok: false, error: "Команда не найдена." });
      return;
    }
    if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 10000) {
      reply(ack, { ok: false, error: "Некорректная величина изменения счёта." });
      return;
    }
    team.score += Math.trunc(delta);
    setEvent("score:adjust", {
      teamId: team.id,
      teamName: team.name,
      delta: Math.trunc(delta),
      score: team.score
    });
    reply(ack, { ok: true, score: team.score });
    broadcast();
  });

  socket.on("updateSettings", (payload = {}, ack) => {
    if (!hostOnly(ack)) return;

    const previous = game.settings;
    const next = {
      questionTimerEnabled:
        typeof payload.questionTimerEnabled === "boolean"
          ? payload.questionTimerEnabled
          : previous.questionTimerEnabled,
      questionTimerSeconds: clampInt(
        payload.questionTimerSeconds,
        5,
        300,
        previous.questionTimerSeconds
      ),
      answerTimerEnabled:
        typeof payload.answerTimerEnabled === "boolean"
          ? payload.answerTimerEnabled
          : previous.answerTimerEnabled,
      answerTimerSeconds: clampInt(
        payload.answerTimerSeconds,
        5,
        120,
        previous.answerTimerSeconds
      ),
      votingTimerEnabled:
        typeof payload.votingTimerEnabled === "boolean"
          ? payload.votingTimerEnabled
          : previous.votingTimerEnabled,
      votingTimerSeconds: clampInt(
        payload.votingTimerSeconds,
        5,
        120,
        previous.votingTimerSeconds
      ),
      wrongAnswerPenaltyEnabled:
        typeof payload.wrongAnswerPenaltyEnabled === "boolean"
          ? payload.wrongAnswerPenaltyEnabled
          : previous.wrongAnswerPenaltyEnabled,
      manualBuzzControlEnabled:
        typeof payload.manualBuzzControlEnabled === "boolean"
          ? payload.manualBuzzControlEnabled
          : previous.manualBuzzControlEnabled
    };

    game.settings = next;

    if (game.phase === "question" && game.currentQuestion) {
      const question = game.currentQuestion;
      if (question.status === "shown") {
        if (
          previous.manualBuzzControlEnabled !== next.manualBuzzControlEnabled
        ) {
          question.buzzUnlocked = !next.manualBuzzControlEnabled;
        }
        if (next.manualBuzzControlEnabled && !question.buzzUnlocked) {
          clearQuestionTimer();
        } else {
          armQuestionTimer();
        }
      } else if (
        question.status === "buzzed" &&
        (previous.answerTimerEnabled !== next.answerTimerEnabled ||
          previous.answerTimerSeconds !== next.answerTimerSeconds)
      ) {
        if (next.answerTimerEnabled) {
          armAnswerTimer();
        } else {
          clearAnswerTimer();
        }
      }
    }

    setEvent("settings:update", { settings: { ...game.settings } });
    reply(ack, { ok: true, settings: { ...game.settings } });
    broadcast();
  });

  /* ------------------------- Игровые наборы ----------------------- */

  socket.on("selectGameSet", (payload = {}, ack) => {
    if (!hostOnly(ack)) return;
    if (game.phase !== "lobby") {
      reply(ack, { ok: false, error: "Выбрать игру можно только в лобби." });
      return;
    }
    const gameSetId = cleanText(payload.gameSetId, 90);
    const definition = gameSetId === "builtin" ? BUILTIN_GAME_SET : customGames.get(gameSetId);
    if (!definition) {
      reply(ack, { ok: false, error: "Игровой набор не найден." });
      return;
    }

    clearAllTimers();
    selectedGameId = definition.id;
    game.roundIndex = 0;
    game.board = buildBoard(0, definition);
    game.currentQuestion = null;
    game.voting = null;
    game.votes.clear();
    game.currentSelectorTeamId = null;
    resetBlocks();
    setEvent("game:set", {
      gameSet: summarizeGameSet(definition),
      selectedGameId
    });
    reply(ack, { ok: true, gameSet: summarizeGameSet(definition) });
    broadcast();
  });

  socket.on("importGameSet", async (payload = {}, ack) => {
    if (!hostOnly(ack)) return;
    if (game.phase !== "lobby") {
      reply(ack, { ok: false, error: "Импортировать игру можно только в лобби." });
      return;
    }

    try {
      const raw = payload.gameSet || payload;
      const definition = normalizeGameSet(raw);
      customGames.set(definition.id, definition);
      await persistCustomGames();

      clearAllTimers();
      selectedGameId = definition.id;
      game.roundIndex = 0;
      game.board = buildBoard(0, definition);
      game.currentQuestion = null;
      game.voting = null;
      game.votes.clear();
      game.currentSelectorTeamId = null;
      resetBlocks();
      setEvent("game:set", {
        gameSet: summarizeGameSet(definition),
        selectedGameId
      });
      reply(ack, {
        ok: true,
        gameSetId: definition.id,
        gameSet: summarizeGameSet(definition)
      });
      broadcastEditorState();
      broadcast();
    } catch (error) {
      reply(ack, { ok: false, error: error.message || "Не удалось импортировать игру." });
    }
  });

  socket.on("saveGameSet", async (payload = {}, ack) => {
    if (!editorOnly(ack)) return;

    const requestedId = cleanText(payload.id, 90);
    const existing = requestedId ? customGames.get(requestedId) : null;
    if (requestedId && !existing) {
      reply(ack, {
        ok: false,
        code: "GAME_NOT_FOUND",
        error: "Сохранённая игра не найдена. Возможно, её удалили."
      });
      return;
    }

    try {
      const definition = normalizeGameSet(payload.gameSet || payload, {
        id: existing?.id,
        createdAt: existing?.createdAt
      });
      customGames.set(definition.id, definition);
      await persistCustomGames();

      if (selectedGameId === definition.id && game.phase === "lobby") {
        game.roundIndex = 0;
        game.board = buildBoard(0, definition);
        game.currentQuestion = null;
        game.voting = null;
        game.votes.clear();
        resetBlocks();
      }

      reply(ack, {
        ok: true,
        id: definition.id,
        gameSet: summarizeGameSet(definition)
      });
      broadcastEditorState();
      broadcast();
    } catch (error) {
      reply(ack, { ok: false, error: error.message || "Не удалось сохранить игру." });
    }
  });

  socket.on("getGameSet", (payload = {}, ack) => {
    if (!editorOnly(ack)) return;
    const definition = customGames.get(cleanText(payload.id, 90));
    if (!definition) {
      reply(ack, { ok: false, error: "Игра не найдена." });
      return;
    }
    reply(ack, {
      ok: true,
      id: definition.id,
      gameSet: toEditorGame(definition),
      summary: summarizeGameSet(definition)
    });
  });

  socket.on("deleteGameSet", async (payload = {}, ack) => {
    if (!editorOnly(ack)) return;
    const gameSetId = cleanText(payload.id, 90);
    const definition = customGames.get(gameSetId);
    if (!definition) {
      reply(ack, { ok: false, error: "Игра не найдена." });
      return;
    }
    if (selectedGameId === gameSetId && game.phase !== "lobby") {
      reply(ack, {
        ok: false,
        error: "Нельзя удалить игру, которая сейчас идёт. Сначала нажмите «Новая игра»."
      });
      return;
    }

    customGames.delete(gameSetId);
    if (selectedGameId === gameSetId) {
      selectedGameId = "builtin";
      game.roundIndex = 0;
      game.board = buildBoard(0, BUILTIN_GAME_SET);
      game.currentQuestion = null;
      game.voting = null;
      game.votes.clear();
      resetBlocks();
    }
    await persistCustomGames();
    reply(ack, { ok: true });
    broadcastEditorState();
    broadcast();
  });

  socket.on("removeTeam", (payload = {}, ack) => {
    if (!hostOnly(ack)) return;
    if (game.phase !== "lobby") {
      reply(ack, { ok: false, error: "Удалять команды можно только в лобби." });
      return;
    }
    const team = findTeam(payload.teamId);
    if (!team) {
      reply(ack, { ok: false, error: "Команда не найдена." });
      return;
    }

    const removedPlayers = [...team.players];
    game.teams = game.teams.filter((item) => item.id !== team.id);
    if (game.currentSelectorTeamId === team.id) game.currentSelectorTeamId = null;
    setEvent("team:removed", {
      teamId: team.id,
      teamName: team.name,
      playersRemoved: removedPlayers.length
    });

    for (const player of removedPlayers) {
      detachPlayerSocket(player, {
        reason: "team_removed",
        teamName: team.name,
        message: `Команда «${team.name}» исключена из лобби ведущим.`
      });
    }

    reply(ack, {
      ok: true,
      teamName: team.name,
      removedPlayers: removedPlayers.length
    });
    broadcast();
  });

  socket.on("kickPlayer", (payload = {}, ack) => {
    if (!hostOnly(ack)) return;
    if (game.phase !== "lobby") {
      reply(ack, { ok: false, error: "Исключать игроков можно только в лобби." });
      return;
    }

    const found = findPlayer(cleanText(payload.playerId, 90));
    if (!found) {
      reply(ack, { ok: false, error: "Игрок не найден." });
      return;
    }

    const { player, team } = found;
    team.players = team.players.filter((item) => item.id !== player.id);
    const teamRemoved = team.players.length === 0;
    if (teamRemoved) {
      game.teams = game.teams.filter((item) => item.id !== team.id);
      if (game.currentSelectorTeamId === team.id) game.currentSelectorTeamId = null;
    }

    setEvent("player:removed", {
      playerId: player.id,
      playerName: player.name,
      teamId: team.id,
      teamName: team.name,
      teamRemoved
    });

    detachPlayerSocket(player, {
      reason: "player_removed",
      teamName: team.name,
      message: "Ведущий исключил вас из лобби."
    });

    reply(ack, {
      ok: true,
      playerName: player.name,
      teamName: team.name,
      teamRemoved
    });
    broadcast();
  });
});

/* ------------------------------------------------------------------ */
/* Запуск                                                              */
/* ------------------------------------------------------------------ */

async function start() {
  await buildQrCode();
  try {
    const loaded = await loadCustomGames(CUSTOM_GAMES_FILE);
    customGames = new Map(loaded.map((definition) => [definition.id, definition]));
    game.board = buildBoard(0);
  } catch (error) {
    console.error("Не удалось загрузить пользовательские игры:", error.message);
  }

  server.listen(PORT, "0.0.0.0", () => {
    const otherAddresses = lanAddresses
      .filter((entry) => entry.address !== publicHost)
      .map((entry) => entry.address);

    console.log("");
    console.log("  ╔════════════════════════════════════════════════════╗");
    console.log("  ║                  СВОЯ ИГРА                        ║");
    console.log("  ╚════════════════════════════════════════════════════╝");
    console.log("");
    console.log(`  Экран показа :  http://localhost:${PORT}/screen`);
    console.log(`  Пульт        :  http://localhost:${PORT}/host`);
    console.log(`  Редактор     :  http://localhost:${PORT}/editor`);
    console.log(`  Игроки       :  ${joinUrl}`);
    if (otherAddresses.length) {
      console.log(`  Другие IP    :  ${otherAddresses.map((ip) => `http://${ip}:${PORT}/player`).join(", ")}`);
    }
    console.log("");
    console.log(`  Пароль /host и /editor: ${HOST_PASSWORD}`);
    console.log("  Изменить пароль: переменная окружения HOST_PASSWORD.");
    console.log("  Сервер слушает все сетевые интерфейсы (0.0.0.0).");
    console.log("  Для телефонов откройте QR-код на /screen или адрес игроков.");
    console.log("");
  });
}

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`\n  Порт ${PORT} уже занят. Остановите другой процесс или задайте PORT.\n`);
  } else {
    console.error("\n  Ошибка сервера:", error.message, "\n");
  }
  process.exitCode = 1;
});

start();
