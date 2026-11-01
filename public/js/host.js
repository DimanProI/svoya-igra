"use strict";

const socket = io();
const $ = SI.$;

const els = {
  connection: $("#hostConnection"),
  hostShell: $(".host-shell"),
  roundLabel: $("#hostRoundLabel"),
  phasePill: $("#hostPhasePill"),
  timer: $("#hostTimer"),
  timerValue: $("#hostTimerValue"),
  timerLabel: $("#hostTimerLabel"),

  selectorCard: $("#selectorCard"),
  selectorAvatar: $("#selectorAvatar"),
  selectorTeamName: $("#selectorTeamName"),
  selectorHint: $("#selectorHint"),
  nextSelectorBtn: $("#nextSelectorBtn"),

  miniBoard: $("#miniBoard"),
  miniRoundLabel: $("#miniRoundLabel"),
  miniBoardHint: $("#miniBoardHint"),

  teamsMeta: $("#teamsMeta"),
  teamList: $("#hostTeamList"),

  controlTitle: $("#controlTitle"),
  controlPhase: $("#controlPhase"),
  controlContent: $("#controlContent"),
  controlActions: $("#controlActions"),

  nextRoundBtn: $("#nextRoundBtn"),
  settingsForm: $("#settingsForm"),
  questionTimerEnabled: $("#questionTimerEnabled"),
  questionTimerSeconds: $("#questionTimerSeconds"),
  answerTimerEnabled: $("#answerTimerEnabled"),
  answerTimerSeconds: $("#answerTimerSeconds"),
  votingTimerEnabled: $("#votingTimerEnabled"),
  votingTimerSeconds: $("#votingTimerSeconds"),
  wrongAnswerPenaltyEnabled: $("#wrongAnswerPenaltyEnabled"),
  manualBuzzControlEnabled: $("#manualBuzzControlEnabled"),

  hostAuth: $("#hostAuth"),
  hostAuthForm: $("#hostAuthForm"),
  hostPassword: $("#hostPassword"),
  hostAuthError: $("#hostAuthError"),
  hostAuthSubmit: $("#hostAuthSubmit"),
  hostAuthConnection: $("#hostAuthConnection"),

  newGameDialog: $("#newGameDialog"),
  newGameDialogText: $("#newGameDialogText"),
  importGameFile: $("#importGameFile"),

  hostConfirmDialog: $("#hostConfirmDialog"),
  hostConfirmTitle: $("#hostConfirmTitle"),
  hostConfirmText: $("#hostConfirmText"),
  hostConfirmAccept: $("#hostConfirmDialog [data-action='host-confirm-accept']")
};

const HOST_TOKEN_KEY = "si_host_token";

const THEME_COLORS = ["#ffbd59", "#6fa8ff", "#67e6b3", "#ff7d9e", "#b995ff"];
const VOTING_REASON_LABELS = {
  host: "Ведущий запустил голосование",
  timer: "Истекло время на ответ",
  "all-failed": "Все команды ошиблись",
  "host-close": "Ведущий закрыл вопрос"
};

let state = null;
let commandPending = false;
let settingsDirty = false;
let answerOpen = false;
let authorized = false;
let hostToken = sessionStorage.getItem(HOST_TOKEN_KEY) || "";
let hostConfirmCallback = null;

SI.bindConnection(socket, els.connection);
SI.bindConnection(socket, els.hostAuthConnection);

/* ------------------------------------------------------------------ */
/* Пароль и подключение                                                */
/* ------------------------------------------------------------------ */

function showAuth(message = "") {
  authorized = false;
  els.hostShell.classList.add("is-locked");
  els.hostAuth.classList.remove("hidden");
  els.hostAuthError.classList.toggle("hidden", !message);
  els.hostAuthError.textContent = message;
  setTimeout(() => els.hostPassword.focus(), 80);
}

function hideAuth() {
  authorized = true;
  els.hostShell.classList.remove("is-locked");
  els.hostAuth.classList.add("hidden");
  els.hostAuthError.classList.add("hidden");
}

async function joinHost() {
  if (!hostToken) {
    showAuth();
    return;
  }
  const response = await SI.request(
    socket,
    "join",
    { role: "host", token: hostToken },
    { silent: true }
  );
  if (response.ok) {
    hideAuth();
    return;
  }

  if (response.code === "AUTH_REQUIRED") {
    hostToken = "";
    sessionStorage.removeItem(HOST_TOKEN_KEY);
    showAuth("Сессия истекла. Введите пароль заново.");
  } else {
    showAuth(response.error || "Не удалось открыть пульт.");
  }
}

socket.on("connect", () => {
  joinHost();
});

els.hostAuthForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!socket.connected) {
    showAuth("Нет связи с сервером. Проверьте, что он запущен.");
    return;
  }

  const password = els.hostPassword.value;
  if (!password) {
    showAuth("Введите пароль.");
    return;
  }

  els.hostAuthSubmit.disabled = true;
  els.hostAuthSubmit.textContent = "Проверяем…";

  const auth = await SI.request(
    socket,
    "auth:login",
    { role: "host", password },
    { silent: true }
  );
  if (!auth.ok) {
    els.hostAuthSubmit.disabled = false;
    els.hostAuthSubmit.textContent = "Войти";
    showAuth(auth.error || "Неверный пароль.");
    return;
  }

  hostToken = auth.token;
  sessionStorage.setItem(HOST_TOKEN_KEY, hostToken);
  els.hostPassword.value = "";
  const joined = await SI.request(
    socket,
    "join",
    { role: "host", token: hostToken },
    { silent: true }
  );
  els.hostAuthSubmit.disabled = false;
  els.hostAuthSubmit.textContent = "Войти";

  if (!joined.ok) {
    showAuth(joined.error || "Не удалось открыть пульт.");
    return;
  }

  hideAuth();
});

socket.on("host:state", (nextState) => {
  if (!nextState) return;
  SI.acceptState(nextState);
  state = nextState;
  render();
});

/* ------------------------------------------------------------------ */
/* Общая отрисовка                                                     */
/* ------------------------------------------------------------------ */

function render() {
  if (!state) return;

  const round = state.round || {};
  const inLobby = state.phase === "lobby";
  const gameName = state.gameSet?.name || "Своя игра";
  els.roundLabel.textContent = inLobby
    ? `${gameName} · лобби`
    : `${gameName} · ${round.name || "Раунд"}`;
  els.phasePill.textContent = SI.phaseLabel(state);
  els.miniRoundLabel.textContent = inLobby
    ? "До старта"
    : `${round.name || "Раунд"} · ${round.number || 1}/${round.total || 1}`;
  document.title = `Пульт · ${SI.phaseLabel(state)}`;

  els.nextRoundBtn.disabled = !(state.phase === "finished" && !state.isGameOver);

  renderSelector();
  renderMiniBoard();
  renderTeams();
  renderControl();
  syncSettings();
  updateTimer();
}

function renderSelector() {
  const team = state.selectorTeam;
  if (state.phase === "finished" && state.isGameOver) {
    const winner = state.winners?.[0];
    els.selectorAvatar.style.removeProperty("--team-color");
    els.selectorAvatar.textContent = "🏆";
    els.selectorTeamName.textContent = "Игра окончена";
    els.selectorHint.textContent = winner
      ? `Победитель: ${winner.name}`
      : "Итоговая таблица на экране";
    els.nextSelectorBtn.classList.add("hidden");
    return;
  }

  if (team) {
    els.selectorAvatar.style.setProperty("--team-color", team.color);
    els.selectorAvatar.textContent = SI.teamInitials(team.name);
    els.selectorTeamName.textContent = team.name;
  } else {
    els.selectorAvatar.style.removeProperty("--team-color");
    els.selectorAvatar.textContent = "?";
    els.selectorTeamName.textContent =
      state.phase === "finished" ? "Раунд завершён" : "Ожидание команд";
  }

  if (state.phase === "themeSelect" && team) {
    els.selectorHint.textContent = "Кликните по ячейке на мини-поле";
  } else if (state.phase === "question" && state.currentQuestion) {
    els.selectorHint.textContent =
      state.currentQuestion.status === "buzzed"
        ? "Команда отвечает — оцените ответ"
        : state.currentQuestion.status === "selected"
          ? "Вопрос выбран, но ещё не показан"
          : "Идёт вопрос, ждём нажатия";
  } else if (state.phase === "voting") {
    els.selectorHint.textContent = "Команды голосуют за пас";
  } else if (state.phase === "finished") {
    els.selectorHint.textContent = state.isGameOver ? "Игра окончена" : "Готов следующий раунд";
  } else if (state.phase === "lobby") {
    els.selectorHint.textContent = state.teams.length
      ? "Нажмите «Начать игру», когда все готовы"
      : "Подключите телефоны игроков";
  } else {
    els.selectorHint.textContent = "Ход игры";
  }

  const showNext =
    state.phase === "themeSelect" && state.teams.filter((item) => item.onlineCount > 0).length > 1;
  els.nextSelectorBtn.classList.toggle("hidden", !showNext);
}

function renderMiniBoard() {
  const themes = state.board || [];
  els.miniBoard.innerHTML = "";

  if (!themes.length) {
    els.miniBoard.style.removeProperty("grid-template-columns");
    els.miniBoard.style.removeProperty("grid-template-rows");
    const empty = document.createElement("div");
    empty.className = "mini-board-empty";
    empty.style.gridColumn = "1 / -1";
    empty.textContent = "Поле появится после начала игры";
    els.miniBoard.appendChild(empty);
    els.miniBoardHint.textContent = "Подключите команды и нажмите «Начать игру».";
    return;
  }

  const canSelect = state.phase === "themeSelect";
  const rowCount = Math.max(0, ...themes.map((theme) => theme.cells.length));
  els.miniBoard.style.gridTemplateColumns = `repeat(${themes.length}, minmax(0, 1fr))`;
  els.miniBoard.style.gridTemplateRows = `minmax(0, 0.92fr) repeat(${rowCount}, minmax(0, 1fr))`;

  themes.forEach((theme, index) => {
    const header = document.createElement("div");
    header.className = "mini-cell mini-cell--theme";
    header.style.setProperty("--theme-color", THEME_COLORS[index % THEME_COLORS.length]);
    header.textContent = theme.title;
    els.miniBoard.appendChild(header);
  });

  for (let row = 0; row < rowCount; row += 1) {
    for (const theme of themes) {
      const cell = theme.cells[row];
      if (!cell) {
        const spacer = document.createElement("div");
        spacer.className = "mini-cell is-played";
        els.miniBoard.appendChild(spacer);
        continue;
      }

      const button = document.createElement("button");
      button.type = "button";
      button.className = "mini-cell";
      button.dataset.action = "select-cell";
      button.dataset.cellId = cell.id;
      button.disabled = !canSelect || cell.played;
      button.textContent = cell.played ? "—" : SI.formatScore(cell.value);
      button.title = cell.played
        ? `${theme.title} · ${SI.formatScore(cell.value)} — уже разыгран`
        : `${theme.title} · ${SI.formatScore(cell.value)}`;
      if (cell.played) button.classList.add("is-played");
      if (cell.current) button.classList.add("is-current");
      if (canSelect && !cell.played) button.classList.add("is-selectable");
      els.miniBoard.appendChild(button);
    }
  }

  requestAnimationFrame(sizeMiniBoard);

  if (state.phase === "themeSelect") {
    els.miniBoardHint.innerHTML =
      "Кликните по ячейке, чтобы выбрать вопрос. <strong>Ход: " +
      SI.escapeHtml(state.selectorTeam?.name || "не определён") +
      "</strong>";
  } else if (state.phase === "question" && state.currentQuestion) {
    els.miniBoardHint.innerHTML = `Текущий вопрос: <strong>${SI.escapeHtml(
      state.currentQuestion.theme
    )} · ${SI.formatScore(state.currentQuestion.value)}</strong>`;
  } else if (state.phase === "voting") {
    els.miniBoardHint.textContent = "Идёт голосование. Поле вернётся после решения.";
  } else {
    els.miniBoardHint.textContent = "Разыгранные вопросы отмечены и недоступны.";
  }
}

function sizeMiniBoard() {
  if (!state?.board?.length) return;
  const cols = state.board.length;
  const rows = Math.max(1, ...state.board.map((theme) => theme.cells.length)) + 1;
  const width = els.miniBoard.clientWidth;
  const height = els.miniBoard.clientHeight;
  if (!width || !height) return;

  const gap = 5;
  const cellW = Math.max(18, (width - 20 - gap * (cols - 1)) / cols);
  const cellH = Math.max(16, (height - 14 - gap * (rows - 1)) / rows);
  const valueFont = Math.max(7, Math.min(18, Math.floor(Math.min(cellW * 0.31, cellH * 0.4))));
  const themeFont = Math.max(6, Math.min(11, Math.floor(Math.min(cellW * 0.1, cellH * 0.24))));

  els.miniBoard.style.setProperty("--mini-value-font", `${valueFont}px`);
  els.miniBoard.style.setProperty("--mini-theme-font", `${themeFont}px`);
}

window.addEventListener("resize", () => {
  requestAnimationFrame(sizeMiniBoard);
});

function renderTeams() {
  const teams = state.teams || [];
  const online = state.stats?.onlinePlayers || 0;
  els.teamsMeta.textContent = `${teams.length} ${SI.plural(
    teams.length,
    "команда",
    "команды",
    "команд"
  )} · ${online} онлайн`;
  els.teamList.innerHTML = "";

  if (!teams.length) {
    const empty = document.createElement("div");
    empty.className = "host-team-empty";
    empty.textContent = "Команды появятся, когда игроки отсканируют QR-код.";
    els.teamList.appendChild(empty);
    return;
  }

  for (const team of teams) {
    const row = document.createElement("div");
    row.className = "host-team-row";
    row.style.setProperty("--team-color", team.color);
    if (team.status === "answering") row.classList.add("is-answering");
    if (team.status === "blocked") row.classList.add("is-blocked");
    if (team.isSelector && state.phase === "themeSelect") row.classList.add("is-selector");

    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.textContent = SI.teamInitials(team.name);

    const copy = document.createElement("div");
    copy.className = "host-team-copy";

    const topLine = document.createElement("div");
    topLine.className = "host-team-topline";
    const name = document.createElement("span");
    name.className = "host-team-name";
    name.textContent = team.name;
    const pill = document.createElement("span");
    pill.className = "status-pill";
    pill.dataset.status = team.status;
    pill.textContent =
      state.phase === "lobby" && team.onlineCount > 0
        ? "В лобби"
        : SI.statusLabel(team.status);
    topLine.append(name, pill);

    const members = document.createElement("div");
    members.className = "host-team-members";
    if (!team.players?.length) {
      const empty = document.createElement("span");
      empty.textContent = "нет игроков";
      members.appendChild(empty);
    } else {
      for (const player of team.players) {
        const member = document.createElement("span");
        member.className = "host-team-member";
        if (!player.connected) member.classList.add("is-offline");
        member.title = player.connected ? "В сети" : "Нет связи";

        const memberName = document.createElement("span");
        memberName.className = "host-team-member-name";
        memberName.textContent = player.name;
        member.appendChild(memberName);

        if (state.phase === "lobby") {
          const kick = document.createElement("button");
          kick.type = "button";
          kick.className = "host-member-kick";
          kick.dataset.action = "kick-player";
          kick.dataset.playerId = player.id;
          kick.dataset.teamId = team.id;
          kick.dataset.playerName = player.name;
          kick.title = `Исключить игрока ${player.name}`;
          kick.setAttribute("aria-label", `Исключить игрока ${player.name}`);
          kick.textContent = "×";
          member.appendChild(kick);
        }

        members.appendChild(member);
      }
    }
    copy.append(topLine, members);

    const score = document.createElement("span");
    score.className = "host-team-score";
    score.textContent = SI.formatScore(team.score);

    const buttons = document.createElement("div");
    buttons.className = "host-score-buttons";

    const minus = document.createElement("button");
    minus.type = "button";
    minus.className = "host-score-button host-score-button--minus";
    minus.dataset.action = "adjust-score";
    minus.dataset.teamId = team.id;
    minus.dataset.delta = "-100";
    minus.title = "Снять 100 баллов";
    minus.textContent = "−";

    const plus = document.createElement("button");
    plus.type = "button";
    plus.className = "host-score-button";
    plus.dataset.action = "adjust-score";
    plus.dataset.teamId = team.id;
    plus.dataset.delta = "100";
    plus.title = "Начислить 100 баллов";
    plus.textContent = "+";

    buttons.append(minus, plus);

    let removeTeamButton = null;
    if (state.phase === "lobby") {
      removeTeamButton = document.createElement("button");
      removeTeamButton.type = "button";
      removeTeamButton.className = "host-team-remove";
      removeTeamButton.dataset.action = "remove-team";
      removeTeamButton.dataset.teamId = team.id;
      removeTeamButton.dataset.teamName = team.name;
      removeTeamButton.title = `Исключить команду ${team.name}`;
      removeTeamButton.setAttribute("aria-label", `Исключить команду ${team.name}`);
      removeTeamButton.textContent = "✕";
    }

    row.append(avatar, copy, score, buttons);
    if (removeTeamButton) row.appendChild(removeTeamButton);
    els.teamList.appendChild(row);
  }
}

/* ------------------------------------------------------------------ */
/* Панель управления                                                   */
/* ------------------------------------------------------------------ */

function renderControl() {
  const q = state.currentQuestion;
  let title = "Лобби";
  let phaseLabel = "Ожидание";
  let content = "";
  let actions = "";

  if (state.phase === "lobby") {
    title = "Лобби";
    phaseLabel = "Подключение";
    content = lobbyContent();
    actions = `
      <button class="host-action-btn host-action-btn--primary host-action-btn--wide"
        data-action="start-game" ${state.stats?.onlinePlayers ? "" : "disabled"}>
        ▶ Начать игру
      </button>`;
    if (!state.stats?.onlinePlayers) {
      actions += `<div class="ctl-warning ctl-warning--danger" style="flex-basis:100%">Подключите хотя бы одного игрока — иначе старт невозможен.</div>`;
    }
  } else if (state.phase === "themeSelect") {
    title = "Выбор вопроса";
    phaseLabel = "Ход команды";
    content = themeSelectContent();
    actions = `
      <button class="host-action-btn host-action-btn--ghost"
        data-action="next-selector" ${state.teams.filter((team) => team.onlineCount > 0).length > 1 ? "" : "disabled"}>
        ↻ Передать выбор
      </button>`;
  } else if (state.phase === "question" && q) {
    if (q.status === "selected") {
      title = "Вопрос выбран";
      phaseLabel = "Подготовка";
      content = selectedContent(q);
      actions = `
        <button class="host-action-btn host-action-btn--primary host-action-btn--wide" data-action="show-question">
          ▶ Показать вопрос
        </button>
        <button class="host-action-btn host-action-btn--ghost" data-action="close-question">
          Отменить выбор
        </button>`;
    } else if (q.status === "revealed") {
      title = "Правильный ответ";
      phaseLabel = "Показ ответа";
      content = revealedContent(q);
      actions = `
        <button class="host-action-btn host-action-btn--primary host-action-btn--wide" data-action="close-question">
          К выбору темы →
        </button>`;
    } else if (q.status === "result") {
      title = "Ответ верный";
      phaseLabel = "Результат";
      content = resultContent(q);
      actions = `
        <button class="host-action-btn host-action-btn--primary host-action-btn--wide" data-action="close-question">
          К выбору темы →
        </button>`;
    } else if (q.status === "buzzed") {
      title = "Команда отвечает";
      phaseLabel = "Ответ";
      content = buzzedContent(q);
      actions = `
        <button class="host-action-btn host-action-btn--success" data-action="judge-correct">
          ✓ Верно
        </button>
        <button class="host-action-btn host-action-btn--danger" data-action="judge-wrong">
          ✕ Неверно
        </button>
        <button class="host-action-btn host-action-btn--warning" data-action="start-voting">
          🗳 Голосование за пас
        </button>
        <button class="host-action-btn host-action-btn--ghost" data-action="close-question">
          Закрыть вопрос
        </button>`;
    } else if (q.buzzLocked) {
      title = "Кнопки закрыты";
      phaseLabel = "Ждём ведущего";
      content = shownContent(q);
      actions = `
        <button class="host-action-btn host-action-btn--primary host-action-btn--wide" data-action="unlock-buzz">
          🔓 Разрешить ответы
        </button>
        <button class="host-action-btn host-action-btn--warning" data-action="start-voting">
          🗳 Запустить голосование
        </button>
        <button class="host-action-btn host-action-btn--ghost" data-action="close-question">
          Закрыть вопрос
        </button>`;
    } else {
      title = "Вопрос открыт";
      phaseLabel = "Ждём нажатия";
      content = shownContent(q);
      actions = `
        <button class="host-action-btn host-action-btn--success" disabled>✓ Верно</button>
        <button class="host-action-btn host-action-btn--danger" disabled>✕ Неверно</button>
        <button class="host-action-btn host-action-btn--warning" data-action="start-voting">
          🗳 Запустить голосование
        </button>
        <button class="host-action-btn host-action-btn--ghost" data-action="close-question">
          Закрыть вопрос
        </button>`;
    }
  } else if (state.phase === "voting") {
    title = "Голосование за пас";
    phaseLabel = "Голосование";
    content = votingContent();
    const outcome = state.voting?.outcome;
    if (outcome === "continue") {
      actions = `
        <button class="host-action-btn host-action-btn--success host-action-btn--wide"
          data-action="finish-vote" data-outcome="continue">
          Применить результат: продолжить
        </button>
        <button class="host-action-btn host-action-btn--ghost" data-action="finish-vote" data-outcome="pass">
          Всё равно пас
        </button>`;
    } else if (outcome === "pass") {
      actions = `
        <button class="host-action-btn host-action-btn--warning host-action-btn--wide"
          data-action="finish-vote" data-outcome="pass">
          Применить результат: пас
        </button>
        <button class="host-action-btn host-action-btn--ghost" data-action="finish-vote" data-outcome="continue">
          Всё равно продолжить
        </button>`;
    } else {
      actions = `
        <button class="host-action-btn host-action-btn--success host-action-btn--wide"
          data-action="finish-vote" data-outcome="continue">
          Продолжить игру
        </button>
        <button class="host-action-btn host-action-btn--warning host-action-btn--wide"
          data-action="finish-vote" data-outcome="pass">
          Пас вопроса
        </button>`;
    }
  } else if (state.phase === "finished") {
    title = state.isGameOver ? "Игра окончена" : "Раунд завершён";
    phaseLabel = state.isGameOver ? "Финал" : "Следующий раунд";
    content = finishedContent();
    if (state.isGameOver) {
      actions = `
        <button class="host-action-btn host-action-btn--primary host-action-btn--wide" data-action="new-game">
          Начать новую игру
        </button>`;
    } else {
      actions = `
        <button class="host-action-btn host-action-btn--primary host-action-btn--wide" data-action="next-round">
          Следующий раунд →
        </button>
        <button class="host-action-btn host-action-btn--ghost" data-action="new-game">
          Новая игра
        </button>`;
    }
  }

  els.controlTitle.textContent = title;
  els.controlPhase.textContent = phaseLabel;
  els.controlContent.innerHTML = content;
  els.controlActions.innerHTML = actions;

  if (answerOpen) {
    const details = els.controlContent.querySelector(".ctl-answer");
    if (details) details.open = true;
  }
}

function lobbyContent() {
  const join = state.join || {};
  const qr = join.qrDataUrl
    ? `<img class="ctl-qr" src="${join.qrDataUrl}" alt="QR-код для игроков" />`
    : `<div class="ctl-qr-empty">QR-код<br />недоступен</div>`;

  const sets = state.availableGameSets?.length
    ? state.availableGameSets
    : [state.gameSet].filter(Boolean);
  const selected = sets.find((item) => item.id === state.selectedGameId) || state.gameSet || {};
  const options = sets
    .map(
      (item) =>
        `<option value="${SI.escapeHtml(item.id)}" ${
          item.id === state.selectedGameId ? "selected" : ""
        }>${SI.escapeHtml(item.name)}${
          item.builtin ? " · классика" : item.questionCount ? ` · ${item.questionCount} вопр.` : ""
        }</option>`
    )
    .join("");

  return `
    <div class="ctl-hero">
      <span class="ctl-eyebrow">Лобби</span>
      <h3 class="ctl-title">Соберите команды</h3>
      <p class="ctl-desc">Выберите игровой набор, подключите телефоны и начните игру. Пользовательские вопросы создаются в <strong>редакторе</strong>.</p>
    </div>
    <div class="game-set-box">
      <div class="game-set-head">
        <span>Игровой набор</span>
        <button class="host-small-btn" type="button" data-action="import-game-file">Импорт .json</button>
      </div>
      <select class="game-set-select" data-action="game-set-select" aria-label="Игровой набор">
        ${options}
      </select>
      <div class="game-set-meta">
        <span>${selected.categoryCount || 0} ${SI.plural(
          selected.categoryCount || 0,
          "категория",
          "категории",
          "категорий"
        )} · ${selected.questionCount || 0} ${SI.plural(
          selected.questionCount || 0,
          "вопрос",
          "вопроса",
          "вопросов"
        )} · ${selected.roundCount || 1} ${SI.plural(
          selected.roundCount || 1,
          "раунд",
          "раунда",
          "раундов"
        )}</span>
        <strong>${selected.builtin ? "встроенная" : "своя"}</strong>
      </div>
    </div>
    <div class="ctl-lobby">
      ${qr}
      <div>
        <div class="ctl-code">${SI.escapeHtml(join.url || "—")}</div>
        <button class="host-small-btn ctl-copy" type="button" data-action="copy-url">Скопировать адрес</button>
        <div class="ctl-warning">${
          state.teams.length
            ? "Когда все игроки подключились, нажмите «Начать игру»."
            : "Пока никто не подключился. QR-код ждёт игроков."
        }</div>
      </div>
    </div>
    <div class="ctl-stat-grid">
      <div class="ctl-stat"><span>Команд</span><strong>${state.teams.length}</strong></div>
      <div class="ctl-stat"><span>Игроков онлайн</span><strong>${state.stats?.onlinePlayers || 0}</strong></div>
      <div class="ctl-stat"><span>Раундов</span><strong>${state.totalRounds || 1}</strong></div>
    </div>
  `;
}

function themeSelectContent() {
  const team = state.selectorTeam;
  const remaining = (state.board || []).reduce(
    (sum, theme) => sum + theme.cells.filter((cell) => !cell.played).length,
    0
  );

  return `
    <div class="ctl-hero">
      <span class="ctl-eyebrow">Переменка</span>
      <h3 class="ctl-title ${team ? "ctl-title--accent" : ""}">${
        team ? `Ход: ${SI.escapeHtml(team.name)}` : "Ожидание выбора"
      }</h3>
      <p class="ctl-desc">Кликните по любой неразыгранной ячейке на мини-поле слева — вопрос откроется на пульте, но ещё не на экране.</p>
    </div>
    <div class="ctl-warning">
      На поле осталось <strong>${remaining}</strong> ${SI.plural(
        remaining,
        "вопрос",
        "вопроса",
        "вопросов"
      )}. Выбор делает команда «${SI.escapeHtml(team?.name || "—")}».
    </div>
    <div class="ctl-question-card" style="margin-top:10px">
      <div class="ctl-q-meta">
        <span class="ctl-q-theme">Как играть</span>
      </div>
      <p class="ctl-q-text">Ведущий выбирает ячейку по указанию команды, затем нажимает «Показать вопрос». После этого на телефонах активируется кнопка «Ответить».</p>
    </div>
  `;
}

function questionHead(q, label = "Вопрос") {
  return `
    <div class="ctl-hero">
      <span class="ctl-eyebrow">${SI.escapeHtml(label)}</span>
      <h3 class="ctl-title">${SI.escapeHtml(q.theme)} <span style="color:var(--accent)">· ${SI.formatScore(
        q.value
      )}</span></h3>
    </div>
    <div class="ctl-question-card">
      <div class="ctl-q-meta">
        <span class="ctl-q-theme">${SI.escapeHtml(q.theme)}</span>
        <span class="ctl-q-value">${SI.formatScore(q.value)}</span>
      </div>
      <p class="ctl-q-text">${SI.escapeHtml(q.text || "Вопрос с изображением")}</p>
      ${
        q.imageUrl
          ? `<img class="ctl-q-image" src="${SI.escapeHtml(q.imageUrl)}" alt="Иллюстрация к вопросу" />`
          : ""
      }
      ${
        q.answer
          ? `<details class="ctl-answer"><summary>Показать правильный ответ</summary><p>${SI.escapeHtml(
              q.answer
            )}</p></details>`
          : ""
      }
    </div>`;
}

function selectedContent(q) {
  const buzzMode = state.settings?.manualBuzzControlEnabled
    ? "После показа кнопки будут закрыты до нажатия «Разрешить ответы»."
    : "После показа кнопки игроков активируются сразу.";
  return `
    ${questionHead(q, "Подготовка вопроса")}
    <div class="ctl-status-line"><span class="ctl-status-dot"></span>Вопрос выбран, но ещё не показан игрокам</div>
    <div class="ctl-warning">${buzzMode} Таймер вопроса: ${
      state.settings?.questionTimerEnabled
        ? `${state.settings.questionTimerSeconds} сек`
        : "выключен"
    }.</div>
  `;
}

function shownContent(q) {
  const online = state.teams.filter((team) => team.onlineCount > 0);
  const allBlocked = online.length > 0 && online.every((team) => team.blocked);
  const wrong = q.result && !q.result.correct;
  const locked = Boolean(q.buzzLocked);

  const statusBlock = wrong
    ? `<div class="ctl-result ctl-result--wrong">
        <div class="ctl-result-copy">
          <span>${q.result.timedOut ? "Время на ответ истекло" : "Неверный ответ"}</span>
          <strong>${SI.escapeHtml(q.result.teamName)}</strong>
          <small>Команда заблокирована до конца вопроса${
            q.result.penalty
              ? ` · штраф ${SI.formatScore(-q.result.penalty)} · счёт ${SI.formatScore(q.result.score)}`
              : ""
          }</small>
        </div>
        <div class="ctl-result-score">${q.result.penalty ? `−${SI.formatScore(q.result.penalty)}` : "✕"}</div>
      </div>`
    : locked
      ? `<div class="ctl-warning ctl-warning--danger">Кнопки закрыты. Нажмите «Разрешить ответы», когда будете готовы принимать ответы.</div>`
      : `<div class="ctl-status-line"><span class="ctl-status-dot"></span>Ждём, кто первым нажмёт «Ответить»</div>`;

  const bottomWarning = allBlocked
    ? `<div class="ctl-warning ctl-warning--danger">Все команды в сети уже ошиблись. Голосование за пас запустится автоматически через пару секунд.</div>`
    : locked
      ? `<div class="ctl-warning">Игроки видят, что кнопки ещё закрыты. Ведущий откроет их вручную.</div>`
      : `<div class="ctl-warning">На телефонах игроков кнопка активна. После первого нажатия она заблокируется у остальных.</div>`;

  return `
    ${questionHead(q, "Вопрос на экране")}
    ${statusBlock}
    ${bottomWarning}
  `;
}

function buzzedContent(q) {
  const team = state.teams.find((item) => item.id === q.buzzedTeamId);
  return `
    <div class="ctl-hero">
      <span class="ctl-eyebrow">Первое нажатие</span>
      <h3 class="ctl-title">Слушаем ответ</h3>
      <p class="ctl-desc">На большом экране уже горит название команды. Оцените устный ответ.</p>
    </div>
    <div class="ctl-team-banner" style="--team-color:${SI.escapeHtml(
      q.buzzedTeamColor || team?.color || "#ffca57"
    )}">
      <span class="avatar">${SI.teamInitials(q.buzzedTeamName || team?.name)}</span>
      <div class="ctl-team-banner-copy">
        <span>Отвечает</span>
        <strong>${SI.escapeHtml(q.buzzedTeamName || team?.name || "Команда")}</strong>
      </div>
    </div>
    ${questionHead(q, "Вопрос открыт")}
    <div class="ctl-status-line"><span class="ctl-status-dot"></span>Нажмите «Верно» или «Неверно» после ответа</div>
  `;
}

function answerCard(q) {
  return `
    <div class="ctl-answer-reveal">
      <span>Правильный ответ</span>
      <strong>${SI.escapeHtml(q.answer || "Ответ не был указан")}</strong>
    </div>`;
}

function resultContent(q) {
  const result = q.result || {};
  return `
    <div class="ctl-result">
      <div class="ctl-result-copy">
        <span>Верный ответ</span>
        <strong>${SI.escapeHtml(result.teamName || "Команда")}</strong>
        <small>Счёт команды: ${SI.formatScore(result.score || 0)}</small>
      </div>
      <div class="ctl-result-score">+${SI.formatScore(result.delta || q.value)}</div>
    </div>
    ${answerCard(q)}
    ${questionHead(q, "Ответ засчитан")}
    <div class="ctl-warning">Правильный ответ уже на экране. Через несколько секунд вопрос закроется автоматически — или нажмите «К выбору темы».</div>
  `;
}

function revealedContent(q) {
  const reason =
    q.revealReason === "voting_pass"
      ? "Вопрос закрыт голосованием"
      : q.revealReason === "host_closed"
        ? "Вопрос пропущен ведущим"
        : "Вопрос закрыт";
  return `
    <div class="ctl-hero">
      <span class="ctl-eyebrow">${SI.escapeHtml(reason)}</span>
      <h3 class="ctl-title">${SI.escapeHtml(q.theme)} <span style="color:var(--accent)">· ${SI.formatScore(
        q.value
      )}</span></h3>
    </div>
    ${answerCard(q)}
    ${questionHead(q, "Правильный ответ на экране")}
    <div class="ctl-warning">Ответ показан на большом экране и телефонах. Вопрос закроется автоматически через несколько секунд.</div>
  `;
}

function votingContent() {
  const voting = state.voting;
  if (!voting) return `<div class="ctl-empty">Голосование недоступно.</div>`;

  const continueCount = voting.counts?.continue || 0;
  const passCount = voting.counts?.pass || 0;
  const eligible = Math.max(1, voting.eligibleCount || 0);
  const rows = (voting.details || [])
    .map((detail) => {
      const label = detail.voted
        ? detail.choice === "continue"
          ? "Продолжить"
          : "Пас"
        : "Ждём";
      return `
        <div class="ctl-vote-row" style="--team-color:${SI.escapeHtml(detail.color)}">
          <div class="ctl-vote-team">
            <span class="ctl-vote-dot"></span>
            <strong>${SI.escapeHtml(detail.name)}</strong>
          </div>
          <span class="ctl-vote-choice ${
            detail.voted
              ? detail.choice === "continue"
                ? "is-continue"
                : "is-pass"
              : "is-waiting"
          }">${label}</span>
        </div>`;
    })
    .join("");

  return `
    <div class="ctl-hero">
      <span class="ctl-eyebrow">Голосование</span>
      <h3 class="ctl-title">За пас или продолжить?</h3>
      <p class="ctl-desc">${SI.escapeHtml(
        VOTING_REASON_LABELS[voting.reason] || "Команды решают судьбу вопроса"
      )}. Один голос от команды.</p>
    </div>
    <div class="ctl-vote-counts">
      <div class="ctl-vote-stat">
        <span>Продолжить</span>
        <strong>${continueCount}</strong>
        <div class="ctl-vote-bar"><i style="width:${Math.min(
          100,
          (continueCount / eligible) * 100
        )}%"></i></div>
      </div>
      <div class="ctl-vote-stat ctl-vote-stat--pass">
        <span>Пас вопроса</span>
        <strong>${passCount}</strong>
        <div class="ctl-vote-bar"><i style="width:${Math.min(
          100,
          (passCount / eligible) * 100
        )}%"></i></div>
      </div>
    </div>
    ${
      voting.timedOut
        ? `<div class="ctl-tie">⏱ Время вышло, голоса разделились. Примите решение вручную.</div>`
        : ""
    }
    <div class="ctl-vote-list">${rows || `<div class="ctl-empty">Нет команд в сети.</div>`}</div>
    <div class="ctl-vote-footer">
      <span>${voting.votesCast} из ${voting.eligibleCount} команд проголосовали</span>
      <span>${voting.allVoted ? "Все голоса получены" : voting.timedOut ? "Решение за ведущим" : "Голосование идёт"}</span>
    </div>
    ${
      !voting.outcome && voting.votesCast > 0
        ? `<div class="ctl-warning">Голоса разделились. Выберите исход вручную кнопками ниже — это и есть решение ведущего.</div>`
        : ""
    }
  `;
}

function finishedContent() {
  const standings = state.standings || [];
  const winner = standings[0];
  const coWinners = standings.filter((team) => team.score === (winner?.score ?? 0));
  const rows = standings
    .map(
      (team) => `
      <div class="ctl-final-row ${team.rank === 1 ? "is-winner" : ""}">
        <span class="ctl-final-rank">${team.rank}</span>
        <span class="ctl-final-name">${team.rank === 1 ? "🏆 " : ""}${SI.escapeHtml(
          team.name
        )}</span>
        <span class="ctl-final-score">${SI.formatScore(team.score)}</span>
      </div>`
    )
    .join("");

  const headline = state.isGameOver
    ? coWinners.length > 1
      ? "Ничья по очкам"
      : `Победитель: ${SI.escapeHtml(winner?.name || "—")}`
    : `Раунд ${state.round?.number || 1} завершён`;

  return `
    <div class="ctl-hero">
      <span class="ctl-eyebrow">${state.isGameOver ? "Игра окончена" : "Итоги раунда"}</span>
      <h3 class="ctl-title ctl-title--accent">${headline}</h3>
      <p class="ctl-desc">${
        state.isGameOver
          ? "Можно начать новую игру без перезапуска сервера. Команды сохранятся в лобби."
          : "Счёт сохраняется. Нажмите «Следующий раунд», чтобы открыть новое поле."
      }</p>
    </div>
    <div class="ctl-final">${rows}</div>
  `;
}

/* ------------------------------------------------------------------ */
/* Таймер                                                              */
/* ------------------------------------------------------------------ */

function updateTimer() {
  if (!state) return;
  const timer = state.timer;
  els.timer.classList.toggle("hidden", !timer);
  if (!timer) return;

  const remaining = SI.remainingMs(timer.endsAt);
  const seconds = Math.max(0, Math.ceil(remaining / 1000));
  els.timerValue.textContent = String(seconds);
  els.timerLabel.textContent =
    timer.type === "voting"
      ? "до голосования"
      : timer.type === "answer"
        ? "на ответ"
        : "сек";
  els.timer.classList.toggle("is-urgent", remaining <= 10000);
}

setInterval(updateTimer, 250);

/* ------------------------------------------------------------------ */
/* Настройки                                                           */
/* ------------------------------------------------------------------ */

function syncSettings() {
  if (!state?.settings || settingsDirty) return;
  els.questionTimerEnabled.checked = Boolean(state.settings.questionTimerEnabled);
  els.questionTimerSeconds.value = String(state.settings.questionTimerSeconds);
  els.answerTimerEnabled.checked = Boolean(state.settings.answerTimerEnabled);
  els.answerTimerSeconds.value = String(state.settings.answerTimerSeconds);
  els.votingTimerEnabled.checked = Boolean(state.settings.votingTimerEnabled);
  els.votingTimerSeconds.value = String(state.settings.votingTimerSeconds);
  els.wrongAnswerPenaltyEnabled.checked = Boolean(
    state.settings.wrongAnswerPenaltyEnabled
  );
  els.manualBuzzControlEnabled.checked = Boolean(
    state.settings.manualBuzzControlEnabled
  );
}

els.settingsForm.addEventListener("input", () => {
  settingsDirty = true;
});

els.settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = await command("updateSettings", {
    questionTimerEnabled: els.questionTimerEnabled.checked,
    questionTimerSeconds: Number(els.questionTimerSeconds.value),
    answerTimerEnabled: els.answerTimerEnabled.checked,
    answerTimerSeconds: Number(els.answerTimerSeconds.value),
    votingTimerEnabled: els.votingTimerEnabled.checked,
    votingTimerSeconds: Number(els.votingTimerSeconds.value),
    wrongAnswerPenaltyEnabled: els.wrongAnswerPenaltyEnabled.checked,
    manualBuzzControlEnabled: els.manualBuzzControlEnabled.checked
  });
  if (result.ok) {
    settingsDirty = false;
    SI.toast("Настройки сохранены.", "success", 1800);
  }
});

/* ------------------------------------------------------------------ */
/* Действия                                                            */
/* ------------------------------------------------------------------ */

async function command(eventName, payload = {}, button = null, options = {}) {
  if (commandPending) return { ok: false, error: "Дождитесь выполнения команды." };
  commandPending = true;
  if (button) button.classList.add("is-busy");

  const response = await SI.request(socket, eventName, payload, options);
  commandPending = false;
  if (button) button.classList.remove("is-busy");
  return response;
}

function openNewGameDialog() {
  els.newGameDialogText.textContent =
    state?.phase === "lobby"
      ? "Сбросить счёт и вернуть поле в исходное состояние? Команды останутся в лобби, настройки сохранятся."
      : "Текущие очки и прогресс раунда будут сброшены. Команды останутся и вернутся в лобби.";
  els.newGameDialog.classList.remove("hidden");
  document.body.classList.add("dialog-open");
}

function closeNewGameDialog() {
  els.newGameDialog.classList.add("hidden");
  document.body.classList.remove("dialog-open");
}

function openHostConfirm({ title, text, confirmLabel = "Исключить", onAccept }) {
  hostConfirmCallback = onAccept;
  els.hostConfirmTitle.textContent = title;
  els.hostConfirmText.textContent = text;
  els.hostConfirmAccept.textContent = confirmLabel;
  els.hostConfirmDialog.classList.remove("hidden");
}

function closeHostConfirm() {
  hostConfirmCallback = null;
  els.hostConfirmDialog.classList.add("hidden");
}

els.newGameDialog.addEventListener("click", (event) => {
  if (event.target === els.newGameDialog) closeNewGameDialog();
});

els.hostConfirmDialog.addEventListener("click", (event) => {
  if (event.target === els.hostConfirmDialog) closeHostConfirm();
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!els.newGameDialog.classList.contains("hidden")) closeNewGameDialog();
  if (!els.hostConfirmDialog.classList.contains("hidden")) closeHostConfirm();
});

async function importGameFile(file) {
  if (!file) return;
  if (file.size > 30 * 1024 * 1024) {
    SI.toast("Файл игры слишком большой (максимум 30 МБ).", "error");
    return;
  }
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const response = await command(
      "importGameSet",
      { gameSet: parsed },
      null,
      { silent: true }
    );
    if (!response.ok) {
      SI.toast(response.error || "Не удалось импортировать игру.", "error", 5000);
      return;
    }
    SI.toast(`Игра «${response.gameSet?.name || "без названия"}» импортирована и выбрана.`, "success", 3500);
  } catch (error) {
    SI.toast(
      error instanceof SyntaxError
        ? "Файл не является корректным JSON."
        : error.message || "Не удалось импортировать игру.",
      "error",
      5000
    );
  }
}

els.importGameFile.addEventListener("change", () => {
  const file = els.importGameFile.files?.[0];
  els.importGameFile.value = "";
  importGameFile(file);
});

document.addEventListener("change", (event) => {
  if (event.target?.matches?.('[data-action="game-set-select"]')) {
    command("selectGameSet", { gameSetId: event.target.value }).then((response) => {
      if (!response.ok) renderControl();
    });
  }
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;

  const action = button.dataset.action;
  if (!action) return;

  if (action === "select-cell") {
    if (state?.phase !== "themeSelect") return;
    const cellId = button.dataset.cellId;
    if (!cellId) return;
    await command("selectQuestion", { cellId }, button);
    return;
  }

  if (action === "adjust-score") {
    const teamId = button.dataset.teamId;
    const delta = Number(button.dataset.delta);
    if (!teamId || !Number.isFinite(delta)) return;
    await command("adjustScore", { teamId, delta }, button);
    return;
  }

  if (action === "kick-player") {
    if (state?.phase !== "lobby") return;
    const playerId = button.dataset.playerId;
    const playerName = button.dataset.playerName || "игрока";
    if (!playerId) return;
    openHostConfirm({
      title: "Исключить игрока?",
      text: `Игрок «${playerName}» будет удалён из команды и вернётся на экран входа.`,
      confirmLabel: "Исключить игрока",
      onAccept: async () => {
        await command("kickPlayer", { playerId });
      }
    });
    return;
  }

  if (action === "remove-team") {
    if (state?.phase !== "lobby") return;
    const teamId = button.dataset.teamId;
    const teamName = button.dataset.teamName || "команду";
    if (!teamId) return;
    openHostConfirm({
      title: "Исключить команду?",
      text: `Команда «${teamName}» и все её игроки будут удалены из лобби. Игроки вернутся на экран входа.`,
      confirmLabel: "Исключить команду",
      onAccept: async () => {
        await command("removeTeam", { teamId });
      }
    });
    return;
  }

  if (action === "host-confirm-cancel") {
    closeHostConfirm();
    return;
  }

  if (action === "host-confirm-accept") {
    const callback = hostConfirmCallback;
    closeHostConfirm();
    if (callback) await callback();
    return;
  }

  switch (action) {
    case "start-game":
      await command("startGame", {}, button);
      break;
    case "show-question":
      await command("showQuestion", {}, button);
      break;
    case "unlock-buzz":
      await command("unlockBuzz", {}, button);
      break;
    case "judge-correct":
      await command("judgeAnswer", { correct: true }, button);
      break;
    case "judge-wrong":
      await command("judgeAnswer", { correct: false }, button);
      break;
    case "start-voting":
      await command("startVoting", {}, button);
      break;
    case "finish-vote":
      await command("finishVoting", { outcome: button.dataset.outcome }, button);
      break;
    case "close-question":
      await command("closeQuestion", {}, button);
      break;
    case "next-selector":
      await command("nextSelector", {}, button);
      break;
    case "next-round":
      await command("nextRound", {}, button);
      break;
    case "new-game":
      openNewGameDialog();
      break;
    case "close-new-game":
      closeNewGameDialog();
      break;
    case "confirm-new-game": {
      closeNewGameDialog();
      const response = await command("newGame", {}, button);
      if (!response.ok) {
        SI.toast(response.error || "Не удалось начать новую игру.", "error");
      }
      break;
    }
    case "import-game-file":
      els.importGameFile.click();
      break;
    case "logout":
      sessionStorage.removeItem(HOST_TOKEN_KEY);
      hostToken = "";
      authorized = false;
      window.location.reload();
      break;
    case "copy-url": {
      const url = state?.join?.url;
      if (!url) {
        SI.toast("Адрес ещё не определён.", "error");
        break;
      }
      try {
        await navigator.clipboard.writeText(url);
        SI.toast("Адрес скопирован.", "success");
      } catch {
        SI.toast(`Адрес: ${url}`, "info", 6000);
      }
      break;
    }
    default:
      break;
  }
});

document.addEventListener(
  "toggle",
  (event) => {
    if (event.target?.classList?.contains("ctl-answer")) {
      answerOpen = event.target.open;
    }
  },
  true
);
