"use strict";

const socket = io();
const $ = SI.$;

const els = {
  connection: $("#connection"),
  soundToggle: $("#soundToggle"),
  soundIcon: $("#soundIcon"),
  soundLabel: $("#soundLabel"),
  roundLabel: $("#roundLabel"),
  phaseBadge: $("#phaseBadge"),
  selectorBanner: $("#selectorBanner"),
  selectorName: $("#selectorName"),
  headerTimer: $("#headerTimer"),
  headerTimerValue: $("#headerTimerValue"),
  headerTimerLabel: $("#headerTimerLabel"),

  lobbyView: $("#lobbyView"),
  gameView: $("#gameView"),
  finishView: $("#finishView"),

  joinUrl: $("#joinUrl"),
  qrImage: $("#qrImage"),
  qrPlaceholder: $("#qrPlaceholder"),
  ipList: $("#ipList"),
  lobbyPlayerCount: $("#lobbyPlayerCount"),
  lobbyPlayerLabel: $("#lobbyPlayerLabel"),
  lobbyTeamGrid: $("#lobbyTeamGrid"),

  roundEyebrow: $("#roundEyebrow"),
  roundTitle: $("#roundTitle"),
  remainingCount: $("#remainingCount"),
  boardSelectorMeta: $("#boardSelectorMeta"),
  gameBoard: $("#gameBoard"),
  boardNotice: $("#boardNotice"),
  boardNoticeText: $("#boardNoticeText"),
  onlinePlayers: $("#onlinePlayers"),
  scoreList: $("#scoreList"),
  scoreRound: $("#scoreRound"),
  totalQuestions: $("#totalQuestions"),

  finishCrown: $("#finishCrown"),
  finishEyebrow: $("#finishEyebrow"),
  finishTitle: $("#finishTitle"),
  finishSubtitle: $("#finishSubtitle"),
  podium: $("#podium"),
  finalTable: $("#finalTable"),
  finishFooter: $("#finishFooter"),

  questionOverlay: $("#questionOverlay"),
  qTheme: $("#qTheme"),
  qValue: $("#qValue"),
  qTimer: $("#qTimer"),
  qTimerValue: $("#qTimerValue"),
  qTimerLabel: $("#qTimerLabel"),
  qBadge: $("#qBadge"),
  qKicker: $("#qKicker"),
  qText: $("#qText"),
  qImageWrap: $("#qImageWrap"),
  qImage: $("#qImage"),
  qStatus: $("#qStatus"),
  qStatusInner: $("#qStatusInner"),
  questionContent: $("#questionContent"),
  votePanel: $("#votePanel"),
  voteContinue: $("#voteContinue"),
  votePass: $("#votePass"),
  voteContinueBar: $("#voteContinueBar"),
  votePassBar: $("#votePassBar"),
  voteContinueCard: $("#voteContinueCard"),
  votePassCard: $("#votePassCard"),
  voteStatusText: $("#voteStatusText"),
  voteTimerText: $("#voteTimerText"),
  voteChips: $("#voteChips"),
  voteHint: $("#voteHint"),
  overlayTeams: $("#overlayTeams"),

  effectLayer: $("#effectLayer"),
  effectContent: $("#effectContent"),
  effectConfetti: $("#effectConfetti")
};

const THEME_COLORS = [
  "#ffbd59",
  "#6fa8ff",
  "#67e6b3",
  "#ff7d9e",
  "#b995ff"
];

let state = null;
let initialized = false;
let lastEventSeq = 0;
let overlayVisible = false;
let effectHideTimer = null;
let effectCleanupTimer = null;
let lastTimerEndsAt = null;
let lastTickSecond = null;
let soundEnabled = localStorage.getItem("si_sound") === "1";
let audioContext = null;

SI.bindConnection(socket, els.connection);

/* ------------------------------------------------------------------ */
/* Подключение                                                         */
/* ------------------------------------------------------------------ */

socket.on("connect", () => {
  SI.request(socket, "join", { role: "screen" }, { silent: true }).then((response) => {
    if (!response.ok) {
      SI.toast(response.error || "Не удалось подключиться как экран.", "error");
    }
  });
});

socket.on("screen:state", (nextState) => {
  if (!nextState) return;
  SI.acceptState(nextState);
  state = nextState;
  render();

  const event = nextState.lastEvent;
  if (!initialized) {
    lastEventSeq = event?.seq || 0;
    initialized = true;
  } else if (event && event.seq > lastEventSeq) {
    lastEventSeq = event.seq;
    handleGameEvent(event);
  }

  updateTimerDisplay();
});

/* ------------------------------------------------------------------ */
/* Отрисовка                                                           */
/* ------------------------------------------------------------------ */

function render() {
  if (!state) return;

  const gameName = state.gameSet?.name || "Своя игра";
  els.roundLabel.textContent =
    state.phase === "lobby"
      ? `${gameName} · подключение команд`
      : `${gameName} · ${state.round?.name || "Раунд"}`.trim();

  els.phaseBadge.textContent = SI.phaseLabel(state);

  const showSelector =
    state.selectorTeam && state.phase === "themeSelect";
  els.selectorBanner.classList.toggle("hidden", !showSelector);
  if (showSelector) {
    els.selectorName.textContent = state.selectorTeam.name;
    els.selectorBanner.style.setProperty("--team-color", state.selectorTeam.color);
  }

  const isLobby = state.phase === "lobby";
  const isFinished = state.phase === "finished";
  const isGame = ["themeSelect", "question", "voting"].includes(state.phase);

  els.lobbyView.classList.toggle("hidden", !isLobby);
  els.gameView.classList.toggle("hidden", !isGame);
  els.finishView.classList.toggle("hidden", !isFinished);

  renderLobby();
  renderGame();
  if (isFinished) renderFinish();
  renderQuestionOverlay();
  updateSoundButton();
}

function renderLobby() {
  const join = state.join || {};
  els.joinUrl.textContent = join.url || "—";
  els.ipList.innerHTML = "";

  if (Array.isArray(join.addresses) && join.addresses.length > 1) {
    const rest = join.addresses.filter((entry) => entry.address !== join.host);
    for (const entry of rest.slice(0, 3)) {
      const chip = document.createElement("span");
      chip.textContent = `${entry.address} · ${entry.name}`;
      chip.title = "Дополнительный сетевой адрес";
      els.ipList.appendChild(chip);
    }
  }

  if (join.qrDataUrl) {
    if (els.qrImage.getAttribute("src") !== join.qrDataUrl) {
      els.qrImage.src = join.qrDataUrl;
    }
    els.qrImage.parentElement.classList.remove("is-empty");
  } else {
    els.qrImage.removeAttribute("src");
    els.qrImage.parentElement.classList.add("is-empty");
  }

  const online = state.stats?.onlinePlayers || 0;
  els.lobbyPlayerCount.textContent = String(online);
  els.lobbyPlayerLabel.textContent = SI.plural(online, "игрок", "игрока", "игроков");

  els.lobbyTeamGrid.innerHTML = "";
  if (!state.teams.length) {
    const empty = document.createElement("div");
    empty.className = "lobby-empty";
    empty.textContent = "Пока никого. Отсканируйте QR-код и создайте первую команду.";
    els.lobbyTeamGrid.appendChild(empty);
    return;
  }

  for (const team of state.teams) {
    const card = document.createElement("div");
    card.className = "lobby-team-card";
    card.style.setProperty("--team-color", team.color);

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = SI.teamInitials(team.name);

    const copy = document.createElement("div");
    copy.style.minWidth = "0";
    copy.style.flex = "1";

    const name = document.createElement("div");
    name.className = "lobby-team-name";
    name.textContent = team.name;

    const meta = document.createElement("div");
    meta.className = "lobby-team-meta";
    meta.textContent =
      team.playerCount === 0
        ? "Ожидаем игроков"
        : `${team.onlineCount} из ${team.playerCount} на связи`;

    const status = document.createElement("span");
    status.className = "status-pill";
    status.dataset.status = team.status;
    status.textContent =
      state.phase === "lobby" && team.onlineCount > 0
        ? "В лобби"
        : SI.statusLabel(team.status);

    copy.append(name, meta);
    card.append(avatar, copy, status);
    els.lobbyTeamGrid.appendChild(card);
  }
}

function renderGame() {
  const round = state.round || {};
  els.roundEyebrow.textContent = round.name || "Раунд";
  els.roundTitle.textContent = round.subtitle || "Игра";
  els.scoreRound.textContent = `${round.number || 1} / ${round.total || state.totalRounds || 2}`;
  els.onlinePlayers.textContent = `${state.stats?.onlinePlayers || 0} онлайн`;
  const totalQuestions = (state.board || []).reduce(
    (sum, theme) => sum + theme.cells.length,
    0
  );
  els.totalQuestions.textContent = String(totalQuestions);

  renderBoard();
  renderScoreboard();
  renderOverlayTeams();

  const question = state.currentQuestion;
  const waitingSelection = state.phase === "question" && question?.status === "selected";
  els.boardNotice.classList.toggle("hidden", !waitingSelection);
  if (waitingSelection) {
    els.boardNoticeText.textContent = `${question.theme} · ${SI.formatScore(
      question.value
    )} — ведущий сейчас откроет вопрос`;
  }

  if (state.phase === "themeSelect" && state.selectorTeam) {
    els.boardSelectorMeta.textContent = `Выбирает: ${state.selectorTeam.name}`;
    els.boardSelectorMeta.style.color = state.selectorTeam.color;
  } else if (state.phase === "question" && question) {
    els.boardSelectorMeta.textContent =
      question.status === "buzzed"
        ? "Команда отвечает"
        : `Тема: ${question.theme}`;
    els.boardSelectorMeta.style.color = "";
  } else if (state.phase === "voting") {
    els.boardSelectorMeta.textContent = "Голосование за пас";
    els.boardSelectorMeta.style.color = "";
  } else {
    els.boardSelectorMeta.textContent = "Ход команды —";
    els.boardSelectorMeta.style.color = "";
  }
}

function renderBoard() {
  const themes = state.board || [];
  if (!themes.length) {
    els.gameBoard.innerHTML = "";
    return;
  }

  const remaining = themes.reduce(
    (sum, theme) => sum + theme.cells.filter((cell) => !cell.played).length,
    0
  );
  els.remainingCount.textContent = String(remaining);

  const fragment = document.createDocumentFragment();

  themes.forEach((theme, index) => {
    const header = document.createElement("div");
    header.className = "board-cell board-cell--theme";
    header.style.setProperty("--theme-color", THEME_COLORS[index % THEME_COLORS.length]);
    const name = document.createElement("div");
    name.className = "board-theme-name";
    name.textContent = theme.title;
    header.appendChild(name);
    fragment.appendChild(header);
  });

  const rowCount = Math.max(0, ...themes.map((theme) => theme.cells.length));
  els.gameBoard.style.gridTemplateColumns = `repeat(${themes.length}, minmax(0, 1fr))`;
  els.gameBoard.style.gridTemplateRows = `minmax(0, 1.02fr) repeat(${rowCount}, minmax(0, 1fr))`;

  for (let row = 0; row < rowCount; row += 1) {
    for (const theme of themes) {
      const cell = theme.cells[row];
      if (!cell) {
        const spacer = document.createElement("div");
        spacer.className = "board-cell board-cell--value is-played";
        fragment.appendChild(spacer);
        continue;
      }
      const el = document.createElement("div");
      el.className = "board-cell board-cell--value";
      if (cell.played) el.classList.add("is-played");
      if (cell.current) el.classList.add("is-current");
      const value = document.createElement("div");
      value.className = "board-value";
      value.textContent = SI.formatScore(cell.value);
      el.appendChild(value);
      fragment.appendChild(el);
    }
  }

  els.gameBoard.replaceChildren(fragment);
  requestAnimationFrame(sizeScreenBoard);
}

function sizeScreenBoard() {
  if (!state?.board?.length) return;
  const cols = state.board.length;
  const rows = Math.max(1, ...state.board.map((theme) => theme.cells.length)) + 1;
  const width = els.gameBoard.clientWidth;
  const height = els.gameBoard.clientHeight;
  if (!width || !height) return;

  const gap = Math.max(5, Math.min(12, window.innerWidth * 0.0065));
  const cellW = Math.max(30, (width - gap * (cols - 1)) / cols);
  const cellH = Math.max(24, (height - gap * (rows - 1)) / rows);
  const valueFont = Math.max(14, Math.min(64, Math.floor(Math.min(cellW * 0.3, cellH * 0.42))));
  const themeFont = Math.max(9, Math.min(28, Math.floor(Math.min(cellW * 0.13, cellH * 0.27))));

  els.gameBoard.style.setProperty("--board-value-font", `${valueFont}px`);
  els.gameBoard.style.setProperty("--board-theme-font", `${themeFont}px`);
}

window.addEventListener("resize", () => {
  requestAnimationFrame(sizeScreenBoard);
  requestAnimationFrame(fitQuestionText);
});

if (els.qImage) {
  els.qImage.addEventListener("load", () => {
    requestAnimationFrame(fitQuestionText);
  });
}

function renderScoreboard() {
  els.scoreList.innerHTML = "";
  const rows = state.standings || [];

  for (const team of rows) {
    const row = document.createElement("div");
    row.className = "score-row";
    row.style.setProperty("--team-color", team.color);
    if (team.status === "answering") row.classList.add("is-answering");
    if (team.status === "blocked") row.classList.add("is-blocked");
    if (team.isSelector && state.phase === "themeSelect") row.classList.add("is-selector");

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = SI.teamInitials(team.name);

    const copy = document.createElement("div");
    copy.className = "score-team-copy";

    const name = document.createElement("div");
    name.className = "score-team-name";
    name.textContent = team.name;

    const meta = document.createElement("div");
    meta.className = "score-team-meta";
    if (team.status === "answering") {
      meta.textContent = "Отвечает прямо сейчас";
      meta.style.color = "var(--accent)";
    } else if (team.status === "blocked") {
      meta.textContent = "Ошиблась в этом вопросе";
      meta.style.color = "var(--red)";
    } else if (team.onlineCount === 0) {
      meta.textContent = "Нет связи";
    } else {
      meta.textContent =
        team.isSelector && state.phase === "themeSelect"
          ? "Выбирает вопрос"
          : `${team.onlineCount} ${SI.plural(team.onlineCount, "игрок", "игрока", "игроков")} на связи`;
    }

    const valueBlock = document.createElement("div");
    valueBlock.className = "score-value-block";

    const value = document.createElement("div");
    value.className = "score-value";
    if (team.score > 0) value.classList.add("is-positive");
    if (team.score < 0) value.classList.add("is-negative");
    value.textContent = SI.formatScore(team.score);

    const rank = document.createElement("div");
    rank.className = "score-rank";
    rank.textContent = `${team.rank} место`;

    valueBlock.append(value, rank);
    copy.append(name, meta);
    row.append(avatar, copy, valueBlock);
    els.scoreList.appendChild(row);
  }
}

function renderOverlayTeams() {
  els.overlayTeams.innerHTML = "";
  const teams = state.standings || [];
  if (!teams.length) return;

  for (const team of teams) {
    const chip = document.createElement("div");
    chip.className = "overlay-team";
    chip.style.setProperty("--team-color", team.color);
    if (team.status === "answering") chip.classList.add("is-answering");
    if (team.status === "blocked") chip.classList.add("is-blocked");

    const dot = document.createElement("span");
    dot.className = "overlay-team-dot";

    const name = document.createElement("span");
    name.className = "overlay-team-name";
    name.textContent = team.name;

    const score = document.createElement("span");
    score.className = "overlay-team-score";
    score.textContent = SI.formatScore(team.score);

    chip.append(dot, name, score);
    els.overlayTeams.appendChild(chip);
  }
}

function renderQuestionOverlay() {
  const question = state.currentQuestion;
  overlayVisible =
    (state.phase === "question" && question && question.status !== "selected") ||
    state.phase === "voting";

  els.questionOverlay.classList.toggle("hidden", !overlayVisible);
  if (!overlayVisible) {
    document.body.classList.remove("question-open");
    return;
  }

  document.body.classList.add("question-open");
  const voting = state.phase === "voting";
  els.questionOverlay.classList.toggle("is-voting", voting);

  els.qTheme.textContent = question?.theme || "Вопрос";
  els.qValue.textContent = SI.formatScore(question?.value || 0);
  els.qKicker.textContent = `${state.round?.name || "Раунд"} · ${
    voting ? "голосование" : "вопрос"
  }`;
  els.qText.textContent = question?.text || "";
  els.qText.classList.toggle("hidden", !question?.text);

  const imageUrl = question?.imageUrl || null;
  els.questionOverlay.classList.toggle("has-image", Boolean(imageUrl));
  els.qImageWrap.classList.toggle("hidden", !imageUrl);
  if (imageUrl) {
    if (els.qImage.getAttribute("src") !== imageUrl) els.qImage.src = imageUrl;
  } else {
    els.qImage.removeAttribute("src");
  }

  els.qBadge.textContent = voting
    ? "Голосование"
    : question?.status === "buzzed"
      ? "Ответ"
      : question?.status === "result"
        ? "Результат"
        : question?.status === "revealed"
          ? "Правильный ответ"
          : question?.buzzLocked
            ? "Кнопки закрыты"
            : "Вопрос";

  if (voting) {
    els.votePanel.classList.remove("hidden");
    els.qStatus.classList.add("hidden");
    renderVoting();
  } else {
    els.votePanel.classList.add("hidden");
    els.qStatus.classList.remove("hidden");
    renderQuestionStatus(question);
  }

  updateTimerDisplay();
  requestAnimationFrame(fitQuestionText);
  setTimeout(fitQuestionText, 80);
}

function answerRevealHtml(question, { title = "Правильный ответ", note = "" } = {}) {
  return `
    <div class="answer-reveal">
      <span class="answer-reveal__eyebrow">${SI.escapeHtml(title)}</span>
      <div class="answer-reveal__text">${SI.escapeHtml(
        question?.answer || "Ответ не указан"
      )}</div>
      ${note ? `<div class="answer-reveal__note">${SI.escapeHtml(note)}</div>` : ""}
    </div>`;
}

function fitQuestionText() {
  if (
    !state ||
    els.questionOverlay.classList.contains("hidden") ||
    els.questionOverlay.classList.contains("is-voting")
  ) {
    return;
  }
  const text = els.qText;
  if (!text || text.classList.contains("hidden")) return;

  const wrap = text.closest(".question-text-wrap");
  if (!wrap) return;

  text.style.fontSize = "";
  text.style.maxHeight = "";
  text.style.overflow = "hidden";
  els.qImage.style.removeProperty("max-height");

  requestAnimationFrame(() => {
    if (!state || els.questionOverlay.classList.contains("hidden")) return;
    const wrapStyle = getComputedStyle(wrap);
    const paddingY =
      (Number.parseFloat(wrapStyle.paddingTop) || 0) +
      (Number.parseFloat(wrapStyle.paddingBottom) || 0);
    const kickerStyle = getComputedStyle(els.qKicker);
    const kickerHeight =
      els.qKicker.getBoundingClientRect().height +
      (Number.parseFloat(kickerStyle.marginBottom) || 0);

    const wrapHeight = wrap.clientHeight;
    if (!wrapHeight) return;
    let available = Math.max(90, wrapHeight - paddingY - kickerHeight - 10);
    const imageVisible = !els.qImageWrap.classList.contains("hidden");

    if (imageVisible) {
      let imageHeight = els.qImageWrap.getBoundingClientRect().height;
      const maxImageHeight = Math.max(100, available * 0.58);
      if (imageHeight > maxImageHeight) {
        els.qImage.style.maxHeight = `${Math.floor(maxImageHeight)}px`;
        imageHeight = els.qImageWrap.getBoundingClientRect().height;
      }
      available = Math.max(80, available - imageHeight - 10);
    }

    const maxHeight = Math.max(60, available);
    text.style.maxHeight = `${Math.floor(maxHeight)}px`;

    let size = imageVisible
      ? Math.min(window.innerWidth * 0.038, 58)
      : Math.min(window.innerWidth * 0.047, 92);
    const minSize = imageVisible ? 18 : 20;
    text.style.fontSize = `${size}px`;

    let guard = 0;
    while (text.scrollHeight > maxHeight + 2 && size > minSize && guard < 50) {
      size -= 2;
      text.style.fontSize = `${size}px`;
      guard += 1;
    }

    if (text.scrollHeight > maxHeight + 2) {
      text.style.overflowY = "auto";
      text.style.overflowX = "hidden";
    }
  });
}

function renderQuestionStatus(question) {
  const voted = state.voting?.counts;
  let html = "";

  if (!question) {
    els.qStatusInner.innerHTML = "";
    return;
  }

  if (question.status === "buzzed") {
    html = `
      <div class="answer-plaque" style="--team-color:${SI.escapeHtml(
        question.buzzedTeamColor || "#ffca57"
      )}">
        <span class="answer-plaque__eyebrow">Отвечает</span>
        <strong class="answer-plaque__name">${SI.escapeHtml(
          question.buzzedTeamName || "Команда"
        )}</strong>
        <span class="answer-plaque__note">Ведущий слушает ответ</span>
      </div>`;
  } else if (question.status === "revealed") {
    html = answerRevealHtml(question, {
      title: "Правильный ответ",
      note:
        question.revealReason === "voting_pass"
          ? "Вопрос закрыт голосованием"
          : "Экран скоро вернётся к игровому полю"
    });
  } else if (question.status === "result" && question.result?.correct) {
    html = `
      <div class="result-inline">
        <span class="result-inline__label">ВЕРНО!</span>
        <span class="result-inline__team">${SI.escapeHtml(
          question.result.teamName
        )} <span style="color:var(--accent)">+${SI.formatScore(
          question.result.delta
        )}</span></span>
        <span class="result-inline__note">Счёт обновлён на табло</span>
      </div>
      ${answerRevealHtml(question, { title: "Правильный ответ" })}`;
  } else if (question.status === "shown" && question.result && !question.result.correct) {
    html = `
      <div class="next-answer">
        <span class="live-dot"></span>
        <span>${
          question.result.timedOut
            ? `Время на ответ истекло: ${SI.escapeHtml(question.result.teamName)}`
            : `${SI.escapeHtml(question.result.teamName)} ошиблась${
                question.result.penalty
                  ? ` · штраф −${SI.formatScore(question.result.penalty)}`
                  : ""
              }`
        }. Кто следующий?</span>
      </div>`;
  } else if (question.buzzLocked) {
    html = `
      <div class="answer-call answer-call--locked">
        <div class="answer-lock-icon">🔒</div>
        <div class="answer-call__title">Кнопки ещё закрыты</div>
        <div class="answer-call__hint">Ведущий откроет приём ответов</div>
      </div>`;
  } else {
    html = `
      <div class="answer-call">
        <div class="answer-call__rings"><span></span></div>
        <div class="answer-call__title">Кто первым нажмёт кнопку?</div>
        <div class="answer-call__hint">Кнопка «Ответить» — на телефоне игрока</div>
      </div>`;
  }

  els.qStatusInner.innerHTML = html;
  void voted;
}

function renderVoting() {
  const voting = state.voting;
  if (!voting) return;

  const continueCount = voting.counts?.continue || 0;
  const passCount = voting.counts?.pass || 0;
  const eligible = Math.max(1, voting.eligibleCount || 0);

  els.voteContinue.textContent = String(continueCount);
  els.votePass.textContent = String(passCount);
  els.voteContinueBar.style.width = `${Math.min(100, (continueCount / eligible) * 100)}%`;
  els.votePassBar.style.width = `${Math.min(100, (passCount / eligible) * 100)}%`;

  els.voteContinueCard.classList.toggle("is-leading", continueCount > passCount);
  els.votePassCard.classList.toggle("is-leading", passCount > continueCount);

  if (voting.timedOut) {
    els.voteStatusText.textContent = "Время вышло — решение принимает ведущий";
  } else if (voting.allVoted) {
    els.voteStatusText.textContent = "Все команды проголосовали";
  } else {
    els.voteStatusText.textContent = `${voting.votesCast || 0} из ${
      voting.eligibleCount || 0
    } команд проголосовали`;
  }

  els.voteChips.innerHTML = "";
  const details = voting.details || [];
  if (!details.length) {
    const empty = document.createElement("span");
    empty.className = "vote-chip is-pending";
    empty.textContent = "Нет команд в сети";
    els.voteChips.appendChild(empty);
  } else {
    for (const detail of details) {
      const chip = document.createElement("span");
      chip.className = "vote-chip";
      chip.style.setProperty("--team-color", detail.color);
      if (detail.voted) chip.classList.add("is-voted");
      else chip.classList.add("is-pending");

      const name = document.createElement("span");
      name.textContent = detail.name;

      chip.appendChild(name);
      if (detail.voted) {
        const choice = document.createElement("strong");
        choice.textContent = detail.choice === "continue" ? "продолжить" : "пас";
        chip.appendChild(choice);
      } else {
        const pending = document.createElement("span");
        pending.textContent = "ждём";
        chip.appendChild(pending);
      }
      els.voteChips.appendChild(chip);
    }
  }

  if (voting.timedOut) {
    els.voteHint.textContent = "Ничья или нет решения — ведущий нажмёт «Применить результат».";
  } else if (voting.outcome === "continue") {
    els.voteHint.textContent = "Большинство за продолжение. Ведущий подтверждает результат.";
  } else if (voting.outcome === "pass") {
    els.voteHint.textContent = "Большинство за пас. Ведущий подтверждает результат.";
  } else {
    els.voteHint.textContent = "Один голос от команды. Результат подтверждает ведущий.";
  }

  updateTimerDisplay();
}

/* ------------------------------------------------------------------ */
/* Финал                                                               */
/* ------------------------------------------------------------------ */

function renderFinish() {
  const standings = state.standings || [];
  const gameOver = Boolean(state.isGameOver);
  const winner = standings[0];
  const topScore = standings[0]?.score ?? 0;
  const coWinners = standings.filter((team) => team.score === topScore);

  els.finishCrown.textContent = gameOver ? "🏆" : "🎬";
  els.finishEyebrow.textContent = gameOver
    ? "Игра окончена"
    : `${state.round?.name || "Раунд"} завершён`;
  els.finishTitle.textContent = gameOver
    ? coWinners.length > 1
      ? "Ничья!"
      : winner?.name || "Победитель"
    : "Итоги раунда";
  els.finishSubtitle.textContent = gameOver
    ? coWinners.length > 1
      ? "Победители набрали одинаковое количество баллов"
      : `Победитель набрал ${SI.formatScore(topScore)} ${SI.plural(
          topScore,
          "балл",
          "балла",
          "баллов"
        )}`
    : "Счёт сохраняется — впереди следующий раунд";

  renderPodium(standings, gameOver);
  renderFinalTable(standings);

  els.finishFooter.innerHTML = gameOver
    ? "<strong>Спасибо за игру!</strong> Ведущий может нажать «Новая игра» на пульте."
    : "Ведущий запустит следующий раунд со своего пульта. <strong>Экран обновится автоматически.</strong>";
}

function renderPodium(standings, gameOver) {
  els.podium.innerHTML = "";
  const places = standings.slice(0, 3);
  if (!places.length) return;

  const order = [places[1], places[0], places[2]].filter(Boolean);
  for (const team of order) {
    const place = team.rank;
    const item = document.createElement("div");
    item.className = `podium-place place-${Math.min(place, 3)}`;
    item.style.setProperty("--team-color", team.color);

    const medal = document.createElement("div");
    medal.className = "podium-medal";
    medal.textContent = place === 1 ? (gameOver ? "🥇" : "①") : place === 2 ? "🥈" : "🥉";

    const name = document.createElement("div");
    name.className = "podium-team";
    name.textContent = team.name;

    const score = document.createElement("div");
    score.className = "podium-score";
    score.textContent = SI.formatScore(team.score);

    item.append(medal, name, score);
    els.podium.appendChild(item);
  }
}

function renderFinalTable(standings) {
  els.finalTable.innerHTML = "";
  for (const team of standings) {
    const row = document.createElement("div");
    row.className = "final-row";

    const rank = document.createElement("span");
    rank.className = "final-rank";
    rank.textContent = `${team.rank}.`;

    const teamWrap = document.createElement("span");
    teamWrap.className = "final-team";
    teamWrap.style.setProperty("--team-color", team.color);
    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.textContent = SI.teamInitials(team.name);
    const name = document.createElement("span");
    name.textContent = team.name;
    teamWrap.append(avatar, name);

    const players = document.createElement("span");
    players.className = "final-players";
    players.textContent = `${team.onlineCount} из ${team.playerCount} на связи`;

    const score = document.createElement("span");
    score.className = "final-score";
    score.textContent = SI.formatScore(team.score);

    row.append(rank, teamWrap, players, score);
    els.finalTable.appendChild(row);
  }
}

function celebrate() {
  let layer = document.getElementById("finishConfetti");
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "finishConfetti";
    layer.className = "confetti-layer";
    els.finishView.appendChild(layer);
  }
  SI.confetti(layer, 90);
  setTimeout(() => {
    layer?.replaceChildren();
  }, 6500);
}

/* ------------------------------------------------------------------ */
/* Таймер                                                              */
/* ------------------------------------------------------------------ */

function updateTimerDisplay() {
  if (!state) return;
  const timer = state.timer;
  const remaining = timer ? SI.remainingMs(timer.endsAt) : 0;
  const overlay = !els.questionOverlay.classList.contains("hidden");

  if (timer && timer.endsAt !== lastTimerEndsAt) {
    lastTimerEndsAt = timer.endsAt;
    lastTickSecond = null;
  }
  if (!timer) {
    lastTimerEndsAt = null;
    lastTickSecond = null;
  }

  els.headerTimer.classList.toggle("hidden", !timer || overlay);
  if (timer) {
    const seconds = Math.max(0, Math.ceil(remaining / 1000));
    els.headerTimerValue.textContent = String(seconds);
    els.headerTimerLabel.textContent = timer.type === "answer" ? "на ответ" : "сек";
    els.headerTimer.classList.toggle("is-urgent", remaining <= 10000);
  }

  els.qTimer.classList.toggle("hidden", !timer || !overlay);
  if (timer && overlay) {
    const seconds = Math.max(0, Math.ceil(remaining / 1000));
    els.qTimerValue.textContent = String(seconds);
    els.qTimerLabel.textContent = timer.type === "answer" ? "на ответ" : "сек";
    els.qTimer.classList.toggle("is-urgent", remaining <= 10000);
    els.voteTimerText.textContent =
      timer.type === "voting"
        ? `До конца голосования: ${seconds} сек`
        : timer.type === "answer"
          ? `Время на ответ: ${seconds} сек`
          : `До конца вопроса: ${seconds} сек`;

    if (remaining <= 5000 && remaining > 0) {
      const second = Math.ceil(remaining / 1000);
      if (second !== lastTickSecond) {
        lastTickSecond = second;
        playTick();
      }
    }
  } else {
    els.voteTimerText.textContent = "";
  }
}

setInterval(updateTimerDisplay, 200);

/* ------------------------------------------------------------------ */
/* События и эффекты                                                   */
/* ------------------------------------------------------------------ */

function handleGameEvent(event) {
  const data = event.data || {};

  switch (event.type) {
    case "buzz":
      playBuzz();
      if (navigator.vibrate) navigator.vibrate([60, 40, 90]);
      break;

    case "correct":
      playCorrect();
      showEffect("correct", {
        title: "ВЕРНО!",
        eyebrow: "Правильный ответ",
        name: data.teamName,
        note: "Очки начислены",
        score: data.delta ? `+${SI.formatScore(data.delta)}` : ""
      });
      break;

    case "wrong":
      playWrong();
      showEffect("wrong", {
        title: data.timedOut || data.reason === "answer_timeout" ? "ВРЕМЯ ВЫШЛО!" : "НЕВЕРНО!",
        eyebrow:
          data.timedOut || data.reason === "answer_timeout"
            ? "Команда не успела ответить"
            : "Ответ не принят",
        name: data.teamName,
        note: data.penalty
          ? `Штраф −${SI.formatScore(data.penalty)} · команда выбывает из вопроса`
          : "Команда ошибается и выбывает из вопроса",
        score: data.penalty ? `−${SI.formatScore(data.penalty)}` : ""
      });
      break;

    case "buzz:unlocked":
      playResume();
      showEffect(
        "resume",
        {
          title: "КНОПКИ ОТКРЫТЫ",
          eyebrow: "Ведущий разрешил ответ",
          name: "Кто первый?",
          note: "Можно нажимать «Ответить»"
        },
        1300
      );
      break;

    case "question:reveal":
      playPass();
      break;

    case "voting:start":
      playVoting();
      showEffect(
        "voting",
        {
          title: "ГОЛОСОВАНИЕ",
          eyebrow: "Все попытки использованы",
          name: "Продолжить или пас?",
          note: "Команды решают на телефонах"
        },
        1550
      );
      break;

    case "voting:resume":
      playResume();
      showEffect(
        "resume",
        {
          title: "ИГРАЕМ ДАЛЬШЕ!",
          eyebrow: "Решение команд",
          name: data.buzzLocked ? "Кнопки откроет ведущий" : "Кнопки снова активны",
          note: data.buzzLocked
            ? "Ведущий разрешит ответ на пульте"
            : "Можно отвечать всем командам"
        },
        1900
      );
      break;

    case "voting:pass":
      playPass();
      showEffect(
        "pass",
        {
          title: "ПАС ВОПРОСА",
          eyebrow: "Решение команд",
          name: "Без баллов",
          note: "Сейчас появится правильный ответ"
        },
        1700
      );
      break;

    case "voting:tie":
      playTie();
      showEffect(
        "tie",
        {
          title: "НИЧЬЯ",
          eyebrow: "Голоса разделились",
          name: "Решает ведущий",
          note: "Он подтвердит результат на пульте"
        },
        2600
      );
      break;

    case "game:start":
      playStart();
      hideEffect();
      break;

    case "round:start":
      playStart();
      hideEffect();
      break;

    case "game:finished":
      playFinish();
      setTimeout(celebrate, 350);
      break;

    case "round:finished":
      playFinish();
      setTimeout(celebrate, 350);
      break;

    case "new:game":
      hideEffect();
      break;

    default:
      break;
  }
}

function showEffect(kind, data, duration = 2400) {
  clearTimeout(effectHideTimer);
  clearTimeout(effectCleanupTimer);

  els.effectLayer.classList.remove("hidden", "is-hiding");
  els.effectLayer.dataset.kind = kind;
  void els.effectLayer.offsetWidth;

  const eyebrow = SI.escapeHtml(data.eyebrow || "");
  const title = SI.escapeHtml(data.title || "");
  const name = SI.escapeHtml(data.name || "");
  const note = SI.escapeHtml(data.note || "");
  const score = data.score
    ? `<div class="effect-score">${SI.escapeHtml(data.score)}</div>`
    : "";

  els.effectContent.innerHTML = `
    <span class="effect-eyebrow">${eyebrow}</span>
    <h2 class="effect-title">${title}</h2>
    ${name ? `<div class="effect-name">${name}</div>` : ""}
    ${score}
    ${note ? `<div class="effect-note">${note}</div>` : ""}
  `;

  els.effectConfetti.replaceChildren();
  if (["correct", "resume", "game"].includes(kind)) {
    SI.confetti(els.effectConfetti, kind === "correct" ? 55 : 30);
  }

  effectHideTimer = setTimeout(() => {
    els.effectLayer.classList.add("is-hiding");
    effectCleanupTimer = setTimeout(() => {
      els.effectLayer.classList.add("hidden");
      els.effectLayer.classList.remove("is-hiding");
      els.effectConfetti.replaceChildren();
    }, 260);
  }, duration);
}

function hideEffect() {
  clearTimeout(effectHideTimer);
  clearTimeout(effectCleanupTimer);
  els.effectLayer.classList.add("hidden");
  els.effectLayer.classList.remove("is-hiding");
  els.effectConfetti.replaceChildren();
}

/* ------------------------------------------------------------------ */
/* Звук (Web Audio, без файлов)                                        */
/* ------------------------------------------------------------------ */

function updateSoundButton() {
  els.soundToggle.classList.toggle("is-on", soundEnabled);
  els.soundIcon.textContent = soundEnabled ? "🔊" : "🔇";
  els.soundLabel.textContent = soundEnabled ? "Звук" : "Включить звук";
  els.soundToggle.setAttribute(
    "aria-label",
    soundEnabled ? "Выключить звук" : "Включить звук"
  );
}

function ensureAudio() {
  if (!audioContext) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioContext = new Ctx();
  }
  if (audioContext.state === "suspended") {
    audioContext.resume().catch(() => {});
  }
  return audioContext;
}

function tone(frequency, offset, duration, options = {}) {
  if (!soundEnabled) return;
  const ctx = ensureAudio();
  if (!ctx) return;

  const start = ctx.currentTime + offset;
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = options.type || "sine";
  oscillator.frequency.setValueAtTime(frequency, start);
  if (options.slideTo) {
    oscillator.frequency.exponentialRampToValueAtTime(
      Math.max(1, options.slideTo),
      start + duration
    );
  }

  const volume = options.volume ?? 0.055;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.018);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

function playBuzz() {
  tone(540, 0, 0.15, { type: "square", volume: 0.04 });
  tone(810, 0.11, 0.18, { type: "square", volume: 0.035 });
}

function playCorrect() {
  [523.25, 659.25, 783.99, 1046.5].forEach((frequency, index) => {
    tone(frequency, index * 0.09, 0.26, { type: "triangle", volume: 0.06 });
  });
  tone(1318.5, 0.4, 0.45, { type: "sine", volume: 0.04 });
}

function playWrong() {
  tone(220, 0, 0.32, { type: "sawtooth", volume: 0.045, slideTo: 110 });
  tone(160, 0.2, 0.32, { type: "sawtooth", volume: 0.03, slideTo: 80 });
}

function playVoting() {
  tone(392, 0, 0.18, { type: "triangle", volume: 0.05 });
  tone(523.25, 0.16, 0.2, { type: "triangle", volume: 0.05 });
  tone(392, 0.36, 0.26, { type: "triangle", volume: 0.04 });
}

function playResume() {
  [440, 554.37, 659.25].forEach((frequency, index) => {
    tone(frequency, index * 0.1, 0.3, { type: "sine", volume: 0.055 });
  });
}

function playPass() {
  tone(392, 0, 0.3, { type: "sine", volume: 0.05, slideTo: 196 });
  tone(196, 0.27, 0.4, { type: "sine", volume: 0.045 });
}

function playTie() {
  tone(329.63, 0, 0.22, { type: "triangle", volume: 0.045 });
  tone(329.63, 0.26, 0.36, { type: "triangle", volume: 0.04 });
}

function playTick() {
  tone(880, 0, 0.045, { type: "square", volume: 0.012 });
}

function playStart() {
  tone(261.63, 0, 0.16, { type: "triangle", volume: 0.045 });
  tone(392, 0.13, 0.16, { type: "triangle", volume: 0.045 });
  tone(523.25, 0.26, 0.28, { type: "triangle", volume: 0.05 });
}

function playFinish() {
  [523.25, 659.25, 783.99, 1046.5, 1318.51].forEach((frequency, index) => {
    tone(frequency, index * 0.13, 0.38, { type: "triangle", volume: 0.055 });
  });
  tone(1567.98, 0.7, 0.75, { type: "sine", volume: 0.035 });
}

els.soundToggle.addEventListener("click", () => {
  soundEnabled = !soundEnabled;
  localStorage.setItem("si_sound", soundEnabled ? "1" : "0");
  updateSoundButton();
  if (soundEnabled) {
    ensureAudio();
    playStart();
  }
});

document.addEventListener(
  "pointerdown",
  () => {
    if (soundEnabled) ensureAudio();
  },
  { once: true }
);

if (soundEnabled) {
  ensureAudio();
}
updateSoundButton();
