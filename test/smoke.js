"use strict";

/**
 * Полный smoke-тест игрового сценария через настоящий Socket.IO.
 * Запускает отдельный сервер на тестовом порту, чтобы не трогать игру на :3000.
 *
 *   npm test
 */

const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const assert = require("assert");
const { io } = require("socket.io-client");

const TEST_PORT = 3107;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const HOST_PASSWORD = process.env.HOST_PASSWORD || "svoya";
const TEST_GAMES_FILE = path.join(__dirname, ".smoke-custom-games.json");
try {
  fs.unlinkSync(TEST_GAMES_FILE);
} catch {
  // файла ещё нет
}
const clients = [];
let serverProcess = null;
let passed = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ok(message) {
  passed += 1;
  console.log(`  ✓ ${message}`);
}

function assertOk(result, label) {
  assert.ok(result && result.ok, `${label}: ${result?.error || "команда не выполнена"}`);
}

function connect() {
  const socket = io(BASE_URL, {
    forceNew: true,
    reconnection: false,
    transports: ["websocket"],
    timeout: 5000
  });
  clients.push(socket);
  return socket;
}

function emitAck(socket, event, payload = {}, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Таймаут Socket.IO: ${event}`)), timeout);
    socket.emit(event, payload, (response) => {
      clearTimeout(timer);
      resolve(response || { ok: false, error: "Пустой ответ" });
    });
  });
}

async function waitFor(predicate, label, timeout = 7000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      if (predicate()) return;
    } catch {
      // состояние ещё не готово
    }
    await sleep(50);
  }
  throw new Error(`Не дождались: ${label}`);
}

async function waitHttp(url, timeout = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // сервер ещё поднимается
    }
    await sleep(120);
  }
  throw new Error("Тестовый сервер не поднялся");
}

function firstUnplayed(host) {
  for (const theme of host.board || []) {
    for (const cell of theme.cells) {
      if (!cell.played) return cell;
    }
  }
  return null;
}

function teamByName(host, name) {
  return host.teams.find((team) => team.name === name);
}

function sortedCellIds(host) {
  return (host.board || []).flatMap((theme) => theme.cells.map((cell) => cell.id));
}

async function main() {
  console.log("\n  SMOKE TEST · Своя игра\n");

  serverProcess = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      CUSTOM_GAMES_FILE: TEST_GAMES_FILE
    },
    stdio: "ignore",
    windowsHide: true
  });

  await waitHttp(`${BASE_URL}/health`);
  console.log(`  Сервер запущен на ${BASE_URL}\n`);

  /* --------------------------- Подключение ------------------------ */

  const hostSocket = connect();
  const screenSocket = connect();
  let host = null;
  let screen = null;

  hostSocket.on("host:state", (state) => {
    host = state;
  });
  screenSocket.on("screen:state", (state) => {
    screen = state;
  });

  const noAuthHost = await emitAck(hostSocket, "join", { role: "host" });
  assert.strictEqual(noAuthHost.ok, false);
  assert.strictEqual(noAuthHost.code, "AUTH_REQUIRED");
  const badPassword = await emitAck(hostSocket, "auth:login", {
    role: "host",
    password: "definitely-wrong"
  });
  assert.strictEqual(badPassword.ok, false);
  assert.strictEqual(badPassword.code, "BAD_PASSWORD");
  const hostAuth = await emitAck(hostSocket, "auth:login", {
    role: "host",
    password: HOST_PASSWORD
  });
  assertOk(hostAuth, "Пароль ведущего");
  assert.ok(hostAuth.token, "Выдан токен ведущего");
  assertOk(
    await emitAck(hostSocket, "join", { role: "host", token: hostAuth.token }),
    "Вход ведущего"
  );
  assertOk(await emitAck(screenSocket, "join", { role: "screen" }), "Вход экрана");
  await waitFor(() => host && screen, "стартовые состояния");
  assert.strictEqual(host.phase, "lobby");
  assert.ok(host.board.length > 0, "поле должно быть видно ведущему ещё в лобби");
  assert.strictEqual(screen.currentQuestion, null);
  assert.ok(screen.join.qrDataUrl.startsWith("data:image/png"), "QR-код сгенерирован");
  ok("лобби, QR-код и мини-поле доступны до старта");

  /* ----------------------------- Игроки --------------------------- */

  const suffix = String(Date.now()).slice(-5);
  const alphaName = `Альфа-${suffix}`;
  const betaName = `Бета-${suffix}`;

  const p1 = connect();
  let p1State = null;
  p1.on("player:state", (state) => {
    p1State = state;
  });
  assertOk(
    await emitAck(p1, "join", { role: "player", name: "Аня", teamName: alphaName }),
    "Первый игрок"
  );
  await waitFor(() => p1State?.you?.team, "состояние первого игрока");

  const p2 = connect();
  let p2State = null;
  let p2Kicked = null;
  p2.on("player:state", (state) => {
    p2State = state;
  });
  p2.on("player:kicked", (payload) => {
    p2Kicked = payload;
  });
  assertOk(
    await emitAck(p2, "join", { role: "player", name: "Борис", teamName: betaName }),
    "Второй игрок"
  );
  await waitFor(() => p2State?.you?.team, "состояние второго игрока");

  const p3 = connect();
  let p3State = null;
  let p3Kicked = null;
  p3.on("player:state", (state) => {
    p3State = state;
  });
  p3.on("player:kicked", (payload) => {
    p3Kicked = payload;
  });
  assertOk(
    await emitAck(p3, "join", {
      role: "player",
      name: "Вера",
      teamName: alphaName
    }),
    "Третий игрок в существующую команду"
  );
  await waitFor(() => p3State?.you?.team, "состояние третьего игрока");

  await waitFor(
    () =>
      host.teams.length === 2 &&
      host.stats.onlinePlayers === 3 &&
      teamByName(host, alphaName)?.playerCount === 2,
    "две команды и три игрока"
  );
  assert.strictEqual(
    teamByName(host, alphaName).id,
    p3State.you.team.id,
    "третий игрок попал в ту же команду"
  );
  ok("несколько игроков могут войти в одну команду");

  /* --------------------------- Настройки -------------------------- */

  assertOk(
    await emitAck(hostSocket, "updateSettings", {
      questionTimerEnabled: false,
      questionTimerSeconds: 10,
      votingTimerEnabled: false,
      votingTimerSeconds: 5,
      wrongAnswerPenaltyEnabled: true
    }),
    "Настройки таймеров"
  );
  await waitFor(() => host.settings.questionTimerEnabled === false, "таймер выключен");
  await waitFor(() => host.settings.wrongAnswerPenaltyEnabled === true, "штраф включён");
  ok("настройки таймеров и штрафа применяются");

  /* ----------------------------- Старт ---------------------------- */

  assertOk(await emitAck(hostSocket, "startGame", {}), "Старт игры");
  await waitFor(() => host.phase === "themeSelect", "фаза выбора вопроса");
  assert.strictEqual(screen.phase, "themeSelect");
  assert.ok(p1State.you.canBuzz === false, "до вопроса нельзя отвечать");
  assert.ok(host.selectorTeamId, "выбирающая команда назначена");
  ok("игра стартовала, поле активно");

  /* ------------------- Первый вопрос: неверно + верно -------------- */

  let cell = firstUnplayed(host);
  assertOk(
    await emitAck(hostSocket, "selectQuestion", { cellId: cell.id }),
    "Выбор вопроса"
  );
  await waitFor(() => host.phase === "question" && host.currentQuestion, "вопрос выбран");
  assert.strictEqual(host.currentQuestion.status, "selected");
  assert.ok(host.currentQuestion.text, "ведущий видит текст вопроса в превью");
  assert.ok(host.currentQuestion.answer, "ведущий видит правильный ответ");
  assert.strictEqual(screen.currentQuestion.text, null, "до показа текст скрыт от экрана");
  assert.ok(!screen.currentQuestion.answer, "ответ не уходит на экран");
  assert.ok(p1State.currentQuestion.text === null, "до показа текст скрыт от игрока");
  ok("выбранный вопрос не показывается до команды ведущего");

  assertOk(await emitAck(hostSocket, "showQuestion", {}), "Показ вопроса");
  await waitFor(() => host.currentQuestion.status === "shown", "вопрос показан");
  await waitFor(() => p1State.currentQuestion?.text, "текст у игроков");
  assert.strictEqual(screen.currentQuestion.text, host.currentQuestion.text);
  assert.ok(!screen.currentQuestion.answer, "ответ не уходит на экран");
  assert.strictEqual(p1State.you.canBuzz, true);
  assert.ok(host.timer === null, "таймер вопроса выключен");
  ok("вопрос появился на экране и телефонах, кнопка активна");

  assertOk(await emitAck(p1, "buzz", {}), "Нажатие первой команды");
  await waitFor(() => host.currentQuestion.status === "buzzed", "buzz зафиксирован");
  assert.strictEqual(host.currentQuestion.buzzedTeamId, p1State.you.team.id);
  await waitFor(() => p1State.you.hasBuzzed === true, "игрок видит свой buzz");
  assert.strictEqual(p2State.you.canBuzz, false, "остальные не могут нажать");
  const secondBuzz = await emitAck(p2, "buzz", {});
  assert.strictEqual(secondBuzz.ok, false);
  assert.strictEqual(secondBuzz.code, "ALREADY_BUZZED");
  ok("сервер фиксирует только первое нажатие");

  const alphaBeforeWrong = teamByName(host, alphaName).score;
  assertOk(
    await emitAck(hostSocket, "judgeAnswer", { correct: false }),
    "Неверный ответ"
  );
  await waitFor(() => host.currentQuestion.status === "shown", "вопрос вернулся в игру");
  await waitFor(() => p1State.you.isBlocked === true, "команда заблокирована");
  assert.strictEqual(
    teamByName(host, alphaName).score,
    alphaBeforeWrong - cell.value,
    "за неверный ответ снята стоимость вопроса"
  );
  assert.strictEqual(host.currentQuestion.result.penalty, cell.value);
  assert.strictEqual(p2State.you.canBuzz, true, "другая команда снова может нажать");
  ok("после «Неверно» снимается штраф, команда блокируется, остальные отвечают");

  assertOk(await emitAck(p2, "buzz", {}), "Нажатие второй команды");
  await waitFor(() => host.currentQuestion.status === "buzzed", "второй buzz");
  assertOk(
    await emitAck(hostSocket, "judgeAnswer", { correct: true }),
    "Верный ответ"
  );
  await waitFor(() => host.currentQuestion.status === "result", "результат верного ответа");
  const beta = teamByName(host, betaName);
  assert.strictEqual(
    beta.score,
    cell.value,
    "команда получила стоимость вопроса"
  );
  assert.ok(
    host.board.flatMap((theme) => theme.cells).find((item) => item.id === cell.id).played,
    "ячейка отмечена разыгранной"
  );
  await waitFor(() => screen.teams.find((team) => team.name === betaName)?.score === cell.value, "счёт на экране");
  await waitFor(() => screen.currentQuestion?.answer === host.currentQuestion.answer, "ответ показан на экране");
  assert.strictEqual(screen.currentQuestion.status, "result", "экран остаётся на результате");
  ok("верный ответ начисляет баллы, обновляет экран и показывает правильный ответ");

  assertOk(await emitAck(hostSocket, "closeQuestion", {}), "Закрытие вопроса");
  await waitFor(() => host.phase === "themeSelect", "возврат к выбору темы");
  assert.notStrictEqual(host.selectorTeamId, p1State.you.team.id, "ход перешёл дальше");
  ok("после закрытия ход переходит следующей команде");

  /* -------------------- Вопрос 2: все ошиблись -------------------- */

  cell = firstUnplayed(host);
  assertOk(await emitAck(hostSocket, "selectQuestion", { cellId: cell.id }), "Выбор 2");
  await waitFor(() => host.currentQuestion?.status === "selected", "2 выбран");
  assertOk(await emitAck(hostSocket, "showQuestion", {}), "Показ 2");
  await waitFor(() => host.currentQuestion?.status === "shown", "2 показан");

  assertOk(await emitAck(p1, "buzz", {}), "Buzz 2.1");
  await waitFor(() => host.currentQuestion?.status === "buzzed", "2 buzz 1");
  assertOk(
    await emitAck(hostSocket, "judgeAnswer", { correct: false }),
    "Неверно 2.1"
  );
  await waitFor(() => host.currentQuestion?.status === "shown", "2 ждём дальше");
  assertOk(await emitAck(p2, "buzz", {}), "Buzz 2.2");
  await waitFor(() => host.currentQuestion?.status === "buzzed", "2 buzz 2");
  assertOk(
    await emitAck(hostSocket, "judgeAnswer", { correct: false }),
    "Неверно 2.2"
  );
  await waitFor(() => host.phase === "voting", "автоголосование после двух ошибок", 8000);
  assert.strictEqual(screen.phase, "voting");
  ok("когда все команды ошиблись, голосование запускается автоматически");

  assertOk(await emitAck(p1, "vote", { choice: "continue" }), "Голос Альфы");
  await waitFor(() => host.voting?.votesCast === 1, "первый голос");
  assertOk(await emitAck(p2, "vote", { choice: "continue" }), "Голос Беты");
  await waitFor(() => host.voting?.allVoted === true, "все проголосовали");
  const duplicateVote = await emitAck(p3, "vote", { choice: "pass" });
  assert.strictEqual(duplicateVote.ok, false);
  assert.strictEqual(duplicateVote.code, "ALREADY_VOTED");
  ok("один голос на команду; второй игрок той же команды не может голосовать");

  const applyContinue = await emitAck(hostSocket, "finishVoting", {});
  assertOk(applyContinue, "Применение продолжения");
  await waitFor(() => host.phase === "question" && host.currentQuestion?.status === "shown", "вопрос возобновлён");
  await waitFor(() => !p1State.you.isBlocked && p1State.you.canBuzz === true, "блокировки сняты");
  assert.ok(p2State.you.canBuzz, "вторая команда тоже разблокирована");
  ok("большинство «продолжить» снимает блокировки и возвращает вопрос");

  /* ------------------ Вопрос 2: ручное голосование, ничья --------- */

  assertOk(await emitAck(p1, "buzz", {}), "Buzz после возобновления");
  await waitFor(() => host.currentQuestion?.status === "buzzed", "buzz после resume");
  assertOk(
    await emitAck(hostSocket, "judgeAnswer", { correct: false }),
    "Снова неверно"
  );
  await waitFor(() => host.currentQuestion?.status === "shown", "ждём");
  assertOk(await emitAck(hostSocket, "startVoting", {}), "Ручное голосование");
  await waitFor(() => host.phase === "voting", "голосование вручную");

  assertOk(await emitAck(p1, "vote", { choice: "continue" }), "Голос continue");
  assertOk(await emitAck(p2, "vote", { choice: "pass" }), "Голос pass");
  await waitFor(() => host.voting?.counts.continue === 1 && host.voting?.counts.pass === 1, "ничья голосов");
  const tieResult = await emitAck(hostSocket, "finishVoting", {});
  assert.strictEqual(tieResult.ok, false);
  assert.strictEqual(tieResult.code, "VOTE_TIE");
  assertOk(
    await emitAck(hostSocket, "finishVoting", { outcome: "pass" }),
    "Ведущий решает пас"
  );
  await waitFor(
    () => host.phase === "question" && host.currentQuestion?.status === "revealed",
    "после паса показан ответ"
  );
  const passedCell = host.board
    .flatMap((theme) => theme.cells)
    .find((item) => item.id === cell.id);
  assert.ok(passedCell.played, "пас закрывает ячейку без баллов");
  assert.strictEqual(host.currentQuestion.revealReason, "voting_pass");
  assert.ok(host.currentQuestion.answer, "правильный ответ доступен ведущему");
  await waitFor(() => screen.currentQuestion?.answer === host.currentQuestion.answer, "ответ на экране после паса");
  await waitFor(() => p1State.currentQuestion?.answer === host.currentQuestion.answer, "ответ на телефонах после паса");
  assertOk(await emitAck(hostSocket, "closeQuestion", {}), "Закрыть показ ответа");
  await waitFor(() => host.phase === "themeSelect", "вопрос закрыт пасом");
  ok("ничья требует решения ведущего; пас закрывает вопрос и показывает ответ");

  /* ----------------------- Счёт и переподключение ----------------- */

  const alpha = teamByName(host, alphaName);
  const beforeAdjust = alpha.score;
  assertOk(
    await emitAck(hostSocket, "adjustScore", { teamId: alpha.id, delta: -100 }),
    "Снять баллы"
  );
  await waitFor(() => teamByName(host, alphaName).score === beforeAdjust - 100, "счёт уменьшен");
  assertOk(
    await emitAck(hostSocket, "adjustScore", { teamId: alpha.id, delta: 100 }),
    "Начислить баллы"
  );
  await waitFor(() => teamByName(host, alphaName).score === beforeAdjust, "счёт восстановлен");
  ok("ведущий может начислить и снять баллы");

  const p1PlayerId = p1State.you.playerId;
  p1.disconnect();
  await waitFor(
    () =>
      host.teams
        .flatMap((team) => team.players || [])
        .find((player) => player.id === p1PlayerId)?.connected === false,
    "игрок помечен offline"
  );
  const p1Again = connect();
  let p1AgainState = null;
  let p1AgainKicked = null;
  p1Again.on("player:state", (state) => {
    p1AgainState = state;
  });
  p1Again.on("player:kicked", (payload) => {
    p1AgainKicked = payload;
  });
  assertOk(
    await emitAck(p1Again, "join", { role: "player", playerId: p1PlayerId, name: "Аня" }),
    "Переподключение игрока"
  );
  await waitFor(() => p1AgainState?.you?.playerId === p1PlayerId, "состояние после reconnect");
  ok("отключение помечается, а игрок может восстановить сессию");

  const late = connect();
  const lateJoin = await emitAck(late, "join", {
    role: "player",
    name: "Поздний",
    teamName: `Поздние-${suffix}`
  });
  assert.strictEqual(lateJoin.ok, false);
  assert.strictEqual(lateJoin.code, "GAME_STARTED");
  late.disconnect();
  ok("новый игрок не может войти в уже идущую игру");

  /* ------------------------- Завершение раунда -------------------- */

  let guard = 0;
  while (host.phase === "themeSelect" && guard < 30) {
    guard += 1;
    const nextCell = firstUnplayed(host);
    assert.ok(nextCell, "есть неразыгранная ячейка");
    assertOk(
      await emitAck(hostSocket, "selectQuestion", { cellId: nextCell.id }),
      "Быстрый выбор"
    );
    await waitFor(() => host.currentQuestion?.status === "selected", "Быстрый выбор: selected");
    assertOk(await emitAck(hostSocket, "showQuestion", {}), "Быстрый показ");
    await waitFor(() => host.currentQuestion?.status === "shown", "Быстрый показ: shown");
    assertOk(await emitAck(hostSocket, "closeQuestion", {}), "Быстрое закрытие");
    await waitFor(
      () => host.currentQuestion?.status === "revealed" || host.phase === "finished",
      "Быстрый показ ответа"
    );
    if (host.currentQuestion?.status === "revealed") {
      assertOk(await emitAck(hostSocket, "closeQuestion", {}), "Закрыть показ ответа");
    }
    await waitFor(
      () => host.phase === "themeSelect" || host.phase === "finished",
      "Быстрый переход"
    );
  }

  await waitFor(() => host.phase === "finished", "раунд завершён");
  assert.strictEqual(host.roundComplete, true);
  assert.strictEqual(host.isGameOver, false, "первый раунд ещё не финал");
  assert.strictEqual(screen.phase, "finished");
  assert.ok(host.standings.length === 2);
  ok("все вопросы разыграны — раунд завершён, показана таблица");

  const betaScoreBeforeRound2 = teamByName(host, betaName).score;
  assertOk(await emitAck(hostSocket, "nextRound", {}), "Следующий раунд");
  await waitFor(() => host.phase === "themeSelect" && host.round.number === 2, "раунд 2");
  assert.strictEqual(
    host.teams.find((team) => team.name === betaName).score,
    betaScoreBeforeRound2,
    "счёт сохраняется между раундами"
  );
  assert.ok(
    host.board.every((theme) => theme.cells.every((item) => !item.played)),
    "новое поле чистое"
  );
  assert.deepStrictEqual(sortedCellIds(host).length, 25);
  ok("«Следующий раунд» сохраняет счёт и открывает новое поле");

  /* ----------------------------- Новая игра ----------------------- */

  const beforeNewGameScores = host.teams.map((team) => team.score);
  assert.ok(
    beforeNewGameScores.some((score) => score !== 0),
    "к концу раунда есть ненулевой счёт"
  );
  assertOk(await emitAck(hostSocket, "newGame", {}), "Новая игра");
  await waitFor(() => host.phase === "lobby", "лобби после новой игры");
  assert.strictEqual(host.teams.length, 2, "команды остаются");
  assert.ok(host.teams.every((team) => team.score === 0), "счёт сброшен");
  assert.ok(
    host.board.every((theme) => theme.cells.every((item) => !item.played)),
    "поле снова чистое"
  );
  assert.strictEqual(host.stats.onlinePlayers, 3, "игроки остаются онлайн");
  ok("«Новая игра» сбрасывает поле и счёт без перезапуска сервера");

  /* --------------------------- Таймеры ---------------------------- */

  assertOk(
    await emitAck(hostSocket, "updateSettings", {
      questionTimerEnabled: true,
      questionTimerSeconds: 5,
      votingTimerEnabled: false,
      votingTimerSeconds: 5
    }),
    "Включение таймера вопроса"
  );
  assertOk(await emitAck(hostSocket, "startGame", {}), "Старт для проверки таймера");
  await waitFor(() => host.phase === "themeSelect", "поле для таймера");

  cell = firstUnplayed(host);
  assertOk(await emitAck(hostSocket, "selectQuestion", { cellId: cell.id }), "Вопрос таймера");
  await waitFor(() => host.currentQuestion?.status === "selected", "Выбран вопрос таймера");
  assertOk(await emitAck(hostSocket, "showQuestion", {}), "Показ вопроса таймера");
  await waitFor(() => host.currentQuestion?.status === "shown", "Вопрос таймера показан");
  assert.ok(host.timer?.type === "question", "таймер вопроса идёт");
  await waitFor(() => host.phase === "voting", "голосование по истечении таймера", 9000);
  assert.strictEqual(host.voting.reason, "timer");
  assert.strictEqual(screen.phase, "voting");
  ok("по истечении таймера вопроса автоматически запускается голосование");

  assertOk(
    await emitAck(hostSocket, "finishVoting", { outcome: "pass" }),
    "Закрыть вопрос после таймера"
  );
  await waitFor(() => host.currentQuestion?.status === "revealed", "ответ после таймера");
  assertOk(await emitAck(hostSocket, "closeQuestion", {}), "Закрыть ответ после таймера");
  await waitFor(() => host.phase === "themeSelect", "поле после таймера");

  assertOk(
    await emitAck(hostSocket, "updateSettings", {
      questionTimerEnabled: false,
      questionTimerSeconds: 5,
      votingTimerEnabled: true,
      votingTimerSeconds: 5
    }),
    "Включение таймера голосования"
  );

  cell = firstUnplayed(host);
  assertOk(await emitAck(hostSocket, "selectQuestion", { cellId: cell.id }), "Вопрос для голосования");
  await waitFor(() => host.currentQuestion?.status === "selected", "Вопрос выбран");
  assertOk(await emitAck(hostSocket, "showQuestion", {}), "Показать вопрос");
  await waitFor(() => host.currentQuestion?.status === "shown", "Вопрос показан");
  assertOk(await emitAck(hostSocket, "startVoting", {}), "Голосование по таймеру");
  await waitFor(() => host.phase === "voting", "голосование идёт");
  assert.ok(host.voting?.endsAt, "у голосования есть дедлайн");

  assertOk(await emitAck(p1Again, "vote", { choice: "continue" }), "Один голос за продолжение");
  await waitFor(() => host.voting?.votesCast === 1, "голос учтён");
  await waitFor(
    () => host.phase === "question" && host.currentQuestion?.status === "shown",
    "автоприменение большинства по таймеру",
    9000
  );
  assert.ok(host.teams.every((team) => !team.blocked), "блокировки сняты после автоголосования");
  ok("по истечении таймера голосования большинство применяется автоматически");

  /* ------------------- Таймер ответа после кнопки ------------------ */

  assertOk(await emitAck(hostSocket, "newGame", {}), "Сброс после тестов таймеров");
  await waitFor(() => host.phase === "lobby", "лобби после тестов таймеров");

  assertOk(
    await emitAck(hostSocket, "updateSettings", {
      questionTimerEnabled: false,
      answerTimerEnabled: true,
      answerTimerSeconds: 5,
      votingTimerEnabled: false,
      wrongAnswerPenaltyEnabled: false,
      manualBuzzControlEnabled: false
    }),
    "Включение таймера ответа"
  );

  assertOk(await emitAck(hostSocket, "startGame", {}), "Старт для таймера ответа");
  await waitFor(() => host.phase === "themeSelect", "поле для таймера ответа");
  cell = firstUnplayed(host);
  assertOk(await emitAck(hostSocket, "selectQuestion", { cellId: cell.id }), "Вопрос для ответа");
  await waitFor(() => host.currentQuestion?.status === "selected", "Вопрос для ответа выбран");
  assertOk(await emitAck(hostSocket, "showQuestion", {}), "Показать вопрос для ответа");
  await waitFor(() => host.currentQuestion?.status === "shown", "Вопрос для ответа показан");

  assertOk(await emitAck(p1Again, "buzz", {}), "Нажатие перед таймером ответа");
  await waitFor(() => host.currentQuestion?.status === "buzzed", "Команда отвечает по таймеру");
  await waitFor(() => host.timer?.type === "answer", "Запущен таймер на ответ");
  assert.strictEqual(host.timer.durationSeconds, 5);
  assert.strictEqual(screen.timer?.type, "answer", "таймер ответа виден на экране");
  await waitFor(
    () =>
      host.currentQuestion?.status === "shown" &&
      host.currentQuestion.result?.timedOut === true,
    "время на ответ истекло",
    9000
  );
  await waitFor(() => p1AgainState?.you?.isBlocked === true, "команда заблокирована по таймеру");
  assert.strictEqual(host.currentQuestion.result.reason, "answer_timeout");
  assert.strictEqual(host.currentQuestion.result.penalty, 0);
  assert.strictEqual(screen.currentQuestion.answer, null, "ответ не раскрыт после ошибки");
  ok("по истечении таймера ответ засчитывается неверным и команда блокируется");

  /* ------------------ Ручная блокировка кнопок --------------------- */

  assertOk(await emitAck(hostSocket, "newGame", {}), "Сброс перед проверкой блокировки");
  await waitFor(() => host.phase === "lobby", "лобби перед проверкой блокировки");
  assertOk(
    await emitAck(hostSocket, "updateSettings", {
      questionTimerEnabled: false,
      answerTimerEnabled: false,
      votingTimerEnabled: false,
      manualBuzzControlEnabled: true
    }),
    "Ручная блокировка кнопок включена"
  );

  assertOk(await emitAck(hostSocket, "startGame", {}), "Старт с закрытыми кнопками");
  await waitFor(() => host.phase === "themeSelect", "поле с закрытыми кнопками");
  cell = firstUnplayed(host);
  assertOk(await emitAck(hostSocket, "selectQuestion", { cellId: cell.id }), "Вопрос с закрытыми кнопками");
  await waitFor(() => host.currentQuestion?.status === "selected", "Вопрос с закрытыми кнопками выбран");
  assertOk(await emitAck(hostSocket, "showQuestion", {}), "Показать вопрос с закрытыми кнопками");
  await waitFor(() => host.currentQuestion?.status === "shown", "Вопрос с закрытыми кнопками показан");
  await waitFor(() => host.currentQuestion?.buzzLocked === true, "кнопки заблокированы");
  assert.strictEqual(p1AgainState?.you?.canBuzz, false, "игрок не может нажать при блокировке");

  const lockedBuzz = await emitAck(p1Again, "buzz", {});
  assert.strictEqual(lockedBuzz.ok, false);
  assert.strictEqual(lockedBuzz.code, "BUZZ_LOCKED");

  assertOk(await emitAck(hostSocket, "unlockBuzz", {}), "Ведущий открыл кнопки");
  await waitFor(() => host.currentQuestion?.buzzLocked === false, "кнопки открыты");
  await waitFor(() => p1AgainState?.you?.canBuzz === true, "игрок снова может нажать");
  assertOk(await emitAck(p1Again, "buzz", {}), "Нажатие после разрешения");
  await waitFor(() => host.currentQuestion?.status === "buzzed", "нажатие после разрешения принято");
  assertOk(await emitAck(hostSocket, "judgeAnswer", { correct: false }), "Ошибка после разрешения");
  await waitFor(
    () => host.currentQuestion?.status === "shown" && host.currentQuestion?.buzzLocked === true,
    "кнопки снова закрыты после ошибки"
  );
  assert.strictEqual(p2State?.you?.canBuzz, false, "вторая команда ждёт ведущего");
  assertOk(await emitAck(hostSocket, "unlockBuzz", {}), "Повторно открыть кнопки");
  await waitFor(() => p2State?.you?.canBuzz === true, "вторая команда может нажать");
  ok("ведущий вручную открывает кнопки после показа вопроса и после ошибки");

  assertOk(await emitAck(hostSocket, "newGame", {}), "Сброс после проверки блокировки");
  await waitFor(() => host.phase === "lobby", "лобби после проверки блокировки");
  assertOk(
    await emitAck(hostSocket, "updateSettings", { manualBuzzControlEnabled: false }),
    "Ручная блокировка выключена"
  );

  /* --------------------- Редактор и своя игра --------------------- */

  const editorSocket = connect();
  let editor = null;
  editorSocket.on("editor:state", (nextState) => {
    editor = nextState;
  });

  const editorWithoutToken = await emitAck(editorSocket, "join", { role: "editor" });
  assert.strictEqual(editorWithoutToken.ok, false);
  assert.strictEqual(editorWithoutToken.code, "AUTH_REQUIRED");

  const editorAuth = await emitAck(editorSocket, "auth:login", {
    role: "editor",
    password: HOST_PASSWORD
  });
  assertOk(editorAuth, "Пароль редактора");
  assertOk(
    await emitAck(editorSocket, "join", { role: "editor", token: editorAuth.token }),
    "Вход редактора"
  );
  await waitFor(() => editor, "состояние редактора");
  ok("редактор и пульт защищены паролем");

  const tinyPng =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z7WQAAAAASUVORK5CYII=";
  const customName = `Своя-${suffix}`;
  const customGameSet = {
    format: "svoya-igra-custom",
    version: 1,
    name: customName,
    description: "Тестовая пользовательская игра",
    categories: [
      {
        name: "Кино",
        questions: [
          {
            value: 100,
            text: "Вопрос с картинкой?",
            answer: "Да",
            image: tinyPng
          },
          { value: 300, text: "Второй вопрос кино", answer: "Ответ 300" }
        ]
      },
      {
        name: "Наука",
        questions: [
          { value: 200, text: "Первый вопрос науки", answer: "Ответ 200" },
          { value: 400, text: "Второй вопрос науки", answer: "Ответ 400" },
          { value: 600, text: "Третий вопрос науки", answer: "Ответ 600" }
        ]
      },
      {
        name: "Третья категория",
        questions: [{ value: 500, text: "Один вопрос", answer: "Ответ" }]
      }
    ]
  };

  const saved = await emitAck(editorSocket, "saveGameSet", {
    gameSet: customGameSet
  });
  assertOk(saved, "Сохранение своей игры");
  assert.ok(saved.id.startsWith("custom-"), "Своей игре выдан id");
  await waitFor(
    () => editor?.games.some((item) => item.id === saved.id),
    "игра появилась в библиотеке"
  );
  await waitFor(
    () => host.availableGameSets.some((item) => item.id === saved.id),
    "игра появилась у ведущего"
  );

  const loadedGame = await emitAck(editorSocket, "getGameSet", { id: saved.id });
  assertOk(loadedGame, "Загрузка игры в редактор");
  assert.strictEqual(loadedGame.gameSet.categories.length, 3);
  assert.strictEqual(loadedGame.gameSet.categories[0].questions[0].image, tinyPng);
  ok("редактор сохраняет категории, вопросы и изображения");

  assertOk(
    await emitAck(hostSocket, "selectGameSet", { gameSetId: saved.id }),
    "Выбор своей игры"
  );
  await waitFor(() => host.selectedGameId === saved.id, "своя игра выбрана");
  assert.strictEqual(host.board.length, 3);
  assert.strictEqual(host.board[0].cells.length, 2);
  assert.strictEqual(host.board[1].cells.length, 3);
  assert.strictEqual(host.totalRounds, 1);
  ok("ведущий может выбрать свою игру в лобби");

  assertOk(await emitAck(hostSocket, "startGame", {}), "Старт своей игры");
  await waitFor(() => host.phase === "themeSelect", "своё поле готово");
  cell = firstUnplayed(host);
  assertOk(await emitAck(hostSocket, "selectQuestion", { cellId: cell.id }), "Выбор своего вопроса");
  await waitFor(() => host.currentQuestion?.status === "selected", "Свой вопрос выбран");
  assert.ok(host.currentQuestion.answer, "Ведущий видит ответ");
  assertOk(await emitAck(hostSocket, "showQuestion", {}), "Показ своего вопроса");
  await waitFor(() => screen.currentQuestion?.status === "shown", "Свой вопрос на экране");
  assert.ok(
    screen.currentQuestion.imageUrl?.startsWith("/api/game-image/"),
    "Изображение отдаётся отдельным URL"
  );
  const imageResponse = await fetch(`${BASE_URL}${screen.currentQuestion.imageUrl}`);
  assert.strictEqual(imageResponse.status, 200);
  assert.ok((imageResponse.headers.get("content-type") || "").includes("image/png"));
  ok("вопросы с изображениями работают на большом экране");

  assertOk(await emitAck(hostSocket, "newGame", {}), "Сброс своей игры");
  await waitFor(() => host.phase === "lobby", "своя игра сброшена");
  assert.strictEqual(host.selectedGameId, saved.id, "выбранная своя игра сохраняется");
  assert.strictEqual(host.board.length, 3, "поле своей игры снова готово");

  const importedPayload = {
    name: `Импорт-${suffix}`,
    description: "",
    categories: [
      {
        name: "Импорт",
        questions: [{ value: 500, text: "Импортированный вопрос", answer: "Ответ" }]
      }
    ]
  };
  const imported = await emitAck(hostSocket, "importGameSet", {
    gameSet: importedPayload
  });
  assertOk(imported, "Импорт файла игры ведущим");
  await waitFor(() => host.selectedGameId === imported.gameSetId, "импорт выбран");
  assert.strictEqual(host.board.length, 1);
  assert.strictEqual(host.board[0].cells[0].value, 500);
  ok("игра импортируется в лобби прямо с пульта");

  assertOk(
    await emitAck(editorSocket, "deleteGameSet", { id: imported.gameSetId }),
    "Удаление выбранной игры"
  );
  await waitFor(() => host.selectedGameId === "builtin", "выбор вернулся к классике");
  await waitFor(
    () => !host.availableGameSets.some((item) => item.id === imported.gameSetId),
    "удалённая игра исчезла из списка"
  );
  ok("удаление выбранной игры в лобби возвращает классический набор");

  /* --------------------- Исключение из лобби --------------------- */

  const p3PlayerId = p3State.you.playerId;
  const kickedPlayer = await emitAck(hostSocket, "kickPlayer", {
    playerId: p3PlayerId
  });
  assertOk(kickedPlayer, "Исключение игрока");
  await waitFor(
    () => teamByName(host, alphaName)?.playerCount === 1,
    "игрок удалён из команды"
  );
  await waitFor(() => p3Kicked?.reason === "player_removed", "событие исключения игрока");
  assert.ok(p3Kicked.message.includes("исключил"));
  ok("ведущий может исключить отдельного игрока из лобби");

  const alphaTeam = teamByName(host, alphaName);
  const removedTeam = await emitAck(hostSocket, "removeTeam", {
    teamId: alphaTeam.id
  });
  assertOk(removedTeam, "Исключение команды");
  await waitFor(
    () => !host.teams.some((team) => team.name === alphaName),
    "команда удалена из лобби"
  );
  await waitFor(() => p1AgainKicked?.reason === "team_removed", "событие исключения команды");
  assert.ok(p1AgainKicked.message.includes("исключена"));
  ok("ведущий может исключить команду вместе с игроками");

  const betaTeam = teamByName(host, betaName);
  assertOk(
    await emitAck(hostSocket, "removeTeam", { teamId: betaTeam.id }),
    "Исключение второй команды"
  );
  await waitFor(() => host.teams.length === 0, "лобби очищено");
  await waitFor(() => p2Kicked?.reason === "team_removed", "второй игрок исключён");
  assert.strictEqual(host.stats.onlinePlayers, 0);
  ok("после исключения всех команд лобби остаётся пустым и рабочим");

  console.log(`\n  ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ: ${passed}\n`);
}

async function cleanup() {
  for (const socket of clients) {
    try {
      socket.close();
    } catch {
      // ignore
    }
  }
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
    await sleep(150);
  }
  try {
    fs.unlinkSync(TEST_GAMES_FILE);
  } catch {
    // файла уже нет
  }
}

main()
  .then(async () => {
    await cleanup();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error("\n  ✕ ОШИБКА:", error.message);
    if (error.stack) console.error(error.stack.split("\n").slice(0, 4).join("\n"));
    await cleanup();
    process.exit(1);
  });
