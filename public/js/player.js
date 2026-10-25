"use strict";

const socket = io();
const $ = SI.$;
const STORAGE_KEY = "si_player_v2";

const els = {
  joinView: $("#joinView"),
  gameView: $("#gameView"),
  joinConnection: $("#joinConnection"),
  playerConnection: $("#playerConnection"),
  playerName: $("#playerName"),
  newTeamName: $("#newTeamName"),
  teamChoices: $("#teamChoices"),
  teamCountLabel: $("#teamCountLabel"),
  joinSubmit: $("#joinSubmit"),
  joinError: $("#joinError"),
  joinStarted: $("#joinStarted"),

  teamAvatar: $("#teamAvatar"),
  myTeamName: $("#myTeamName"),
  myTeamMeta: $("#myTeamMeta"),
  myScore: $("#myScore"),
  playerPhase: $("#playerPhase"),
  playerRound: $("#playerRound"),
  playerMain: $("#playerMain"),
  playerFooterNote: $("#playerFooterNote"),
  offlineOverlay: $("#offlineOverlay")
};

let identity = loadIdentity();
let state = null;
let lobbyState = null;
let isJoined = false;
let observerActive = false;
let restoring = false;
let registering = false;
let selectedTeamId = null;
let gameStarted = false;
let stateInitialized = false;
let lastEventSeq = 0;
let pendingBuzz = false;
let pendingVote = false;
let pendingTimer = null;
let lastRenderKey = "";

SI.bindConnection(socket, els.joinConnection);
SI.bindConnection(socket, els.playerConnection);

/* ------------------------------------------------------------------ */
/* Сессия                                                              */
/* ------------------------------------------------------------------ */

function loadIdentity() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.playerId) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveIdentity(next) {
  identity = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Приватный режим Safari может запрещать localStorage — играем без него.
  }
}

function clearIdentity() {
  identity = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

if (identity?.name) {
  els.playerName.value = identity.name;
  els.newTeamName.value = identity.teamName || "";
}

/* ------------------------------------------------------------------ */
/* Подключение                                                         */
/* ------------------------------------------------------------------ */

socket.on("connect", () => {
  hideOffline();

  if (identity?.playerId) {
    restoreSession();
  } else if (!isJoined) {
    startObserving();
  }
});

socket.on("disconnect", () => {
  observerActive = false;
  if (isJoined) showOffline();
});

socket.on("lobby:state", (nextState) => {
  if (!nextState) return;
  SI.acceptState(nextState);
  lobbyState = nextState;
  const wasStarted = gameStarted;
  gameStarted = Boolean(nextState.started);
  if (wasStarted && !gameStarted) {
    showJoinError("");
  }
  if (!isJoined) {
    renderJoinTeams();
    updateJoinAvailability();
  }
});

socket.on("player:kicked", (payload = {}) => {
  pendingBuzz = false;
  pendingVote = false;
  clearTimeout(pendingTimer);
  isJoined = false;
  observerActive = false;
  stateInitialized = false;
  state = null;
  gameStarted = false;
  selectedTeamId = null;
  els.newTeamName.value = "";
  clearIdentity();
  showJoinView(payload.message || "Ведущий исключил вас из лобби.");
  startObserving();
});

socket.on("player:state", (nextState) => {
  if (!nextState?.you?.team) return;
  SI.acceptState(nextState);
  state = nextState;

  if (!isJoined) {
    isJoined = true;
    observerActive = false;
    selectedTeamId = nextState.you.team.id;
    identity = {
      playerId: nextState.you.playerId,
      name: nextState.you.name,
      teamId: nextState.you.team.id,
      teamName: nextState.you.team.name
    };
    saveIdentity(identity);
    showGameView();
    stateInitialized = false;
  } else {
    identity = {
      ...(identity || {}),
      playerId: nextState.you.playerId,
      name: nextState.you.name,
      teamId: nextState.you.team.id,
      teamName: nextState.you.team.name
    };
    saveIdentity(identity);
  }

  pendingBuzz = false;
  pendingVote = false;
  clearTimeout(pendingTimer);
  renderGame();

  const event = nextState.lastEvent;
  if (!stateInitialized) {
    stateInitialized = true;
    lastEventSeq = event?.seq || 0;
  } else if (event && event.seq > lastEventSeq) {
    lastEventSeq = event.seq;
    handlePlayerEvent(event);
  }
});

async function restoreSession() {
  if (restoring) return;
  restoring = true;
  const attempt = identity;
  const response = await SI.request(
    socket,
    "join",
    {
      role: "player",
      playerId: attempt.playerId,
      name: attempt.name,
      teamId: attempt.teamId,
      teamName: attempt.teamName
    },
    { silent: true }
  );
  restoring = false;

  if (response.ok) {
    identity = {
      playerId: response.playerId,
      name: attempt.name || "",
      teamId: response.teamId,
      teamName: response.teamName || attempt.teamName || ""
    };
    saveIdentity(identity);
    isJoined = true;
    showGameView();
    hideOffline();
    return;
  }

  const previousName = attempt.name || "";
  const previousTeam = attempt.teamName || "";
  clearIdentity();
  isJoined = false;
  showJoinView(response.error);
  els.playerName.value = previousName;
  els.newTeamName.value = previousTeam;
  gameStarted = response.code === "GAME_STARTED";
  updateJoinAvailability();
  startObserving();
}

function startObserving() {
  if (observerActive || isJoined || registering) return;
  observerActive = true;
  SI.request(socket, "join", { role: "player" }, { silent: true }).then((response) => {
    if (!response.ok) {
      observerActive = false;
      SI.toast(response.error || "Не удалось получить список команд.", "error");
    }
  });
}

/* ------------------------------------------------------------------ */
/* Вход                                                                */
/* ------------------------------------------------------------------ */

function renderJoinTeams() {
  const teams = lobbyState?.teams || [];
  els.teamCountLabel.textContent = `${teams.length} ${SI.plural(
    teams.length,
    "команда",
    "команды",
    "команд"
  )}`;

  if (selectedTeamId && !teams.some((team) => team.id === selectedTeamId)) {
    selectedTeamId = null;
  }

  els.teamChoices.innerHTML = "";
  if (!teams.length) {
    const empty = document.createElement("div");
    empty.className = "team-choice-empty";
    empty.textContent = gameStarted
      ? "Игра уже началась. Новые команды не принимаются."
      : "Команд пока нет — создайте первую!";
    els.teamChoices.appendChild(empty);
    return;
  }

  for (const team of teams) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "team-choice";
    button.dataset.teamId = team.id;
    button.style.setProperty("--team-color", team.color);
    button.disabled = gameStarted;
    if (team.id === selectedTeamId) button.classList.add("is-selected");

    const avatar = document.createElement("span");
    avatar.className = "team-choice-avatar";
    avatar.textContent = SI.teamInitials(team.name);

    const copy = document.createElement("span");
    copy.className = "team-choice-copy";
    const name = document.createElement("span");
    name.className = "team-choice-name";
    name.textContent = team.name;
    const meta = document.createElement("span");
    meta.className = "team-choice-meta";
    meta.textContent = `${team.onlineCount} из ${team.playerCount} на связи`;
    copy.append(name, meta);

    const check = document.createElement("span");
    check.className = "team-choice-check";
    check.textContent = "✓";

    button.append(avatar, copy, check);
    els.teamChoices.appendChild(button);
  }
}

function updateJoinAvailability() {
  const disabled = gameStarted || registering;
  els.playerName.disabled = disabled;
  els.newTeamName.disabled = disabled;
  els.joinSubmit.disabled = disabled;
  els.joinStarted.classList.toggle("hidden", !gameStarted);
  els.joinSubmit.style.opacity = disabled ? "0.45" : "";
  for (const button of els.teamChoices.querySelectorAll("button")) {
    button.disabled = disabled;
  }
}

function showJoinError(message) {
  if (!message) {
    els.joinError.classList.add("hidden");
    els.joinError.textContent = "";
    return;
  }
  els.joinError.classList.remove("hidden");
  els.joinError.textContent = message;
}

async function joinGame() {
  if (registering) return;
  const name = els.playerName.value.trim();
  const teamId = selectedTeamId;
  const teamName = els.newTeamName.value.trim();

  if (!name) {
    showJoinError("Введите имя — оно будет видно команде и ведущему.");
    els.playerName.focus();
    return;
  }
  if (!teamId && !teamName) {
    showJoinError("Выберите команду или введите название новой.");
    return;
  }

  showJoinError("");
  registering = true;
  updateJoinAvailability();

  const response = await SI.request(
    socket,
    "join",
    { role: "player", name, teamId, teamName },
    { silent: true }
  );

  registering = false;
  if (!response.ok) {
    reportJoinError(response);
    updateJoinAvailability();
    return;
  }

  identity = {
    playerId: response.playerId,
    name,
    teamId: response.teamId,
    teamName: response.teamName || teamName
  };
  saveIdentity(identity);
  isJoined = true;
  observerActive = false;
  gameStarted = false;
  showGameView();
  SI.toast(`Вы в команде «${response.teamName || teamName}».`, "success");
}

function reportJoinError(response) {
  const messages = {
    GAME_STARTED: "Игра уже началась. Попросите ведущего начать новую игру.",
    TEAM_LIMIT: "Команд уже максимум. Выберите существующую.",
    TEAM_REQUIRED: "Выберите команду или создайте новую.",
    NAME_TAKEN: "В этой команде уже есть игрок с таким именем.",
    NAME_REQUIRED: "Введите имя."
  };
  const message = messages[response.code] || response.error || "Не удалось войти в игру.";
  showJoinError(message);
  if (response.code === "GAME_STARTED") {
    gameStarted = true;
    updateJoinAvailability();
    startObserving();
  }
}

function showJoinView(message = "") {
  isJoined = false;
  els.gameView.classList.add("hidden");
  els.joinView.classList.remove("hidden");
  showJoinError(message);
  updateJoinAvailability();
}

function showGameView() {
  els.joinView.classList.add("hidden");
  els.gameView.classList.remove("hidden");
  if (!state) {
    els.playerMain.innerHTML = `
      <div class="p-card p-center">
        <div class="p-emoji">⏳</div>
        <span class="p-eyebrow">Подключение</span>
        <h2 class="p-title">Синхронизируем команду</h2>
        <p class="p-text">Ещё секунда — и вы на связи.</p>
      </div>`;
  } else {
    renderGame();
  }
}

function showOffline() {
  els.offlineOverlay.classList.remove("hidden");
}

function hideOffline() {
  els.offlineOverlay.classList.add("hidden");
}

els.teamChoices.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-team-id]");
  if (!button || button.disabled) return;
  selectedTeamId = button.dataset.teamId;
  els.newTeamName.value = "";
  renderJoinTeams();
  showJoinError("");
});

els.newTeamName.addEventListener("input", () => {
  if (els.newTeamName.value.trim()) {
    selectedTeamId = null;
    renderJoinTeams();
  }
});

els.joinSubmit.addEventListener("click", joinGame);

for (const input of [els.playerName, els.newTeamName]) {
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      joinGame();
    }
  });
}

/* ------------------------------------------------------------------ */
/* Игровое состояние                                                   */
/* ------------------------------------------------------------------ */

function renderGame() {
  if (!state?.you?.team) return;

  const myTeam = state.you.team;
  const round = state.round || {};

  document.documentElement.style.setProperty("--my-team-color", myTeam.color);
  els.teamAvatar.style.setProperty("--my-team-color", myTeam.color);
  els.teamAvatar.textContent = SI.teamInitials(myTeam.name);
  els.myTeamName.textContent = myTeam.name;
  els.myTeamMeta.textContent = `${myTeam.onlineCount} из ${myTeam.playerCount} на связи`;
  els.myScore.textContent = SI.formatScore(myTeam.score);
  els.playerPhase.textContent = shortPhaseLabel(state);
  els.playerRound.textContent = `Раунд ${round.number || 1} из ${round.total || 2}`;
  els.playerFooterNote.textContent =
    state.phase === "lobby"
      ? "Ожидаем старта"
      : state.phase === "finished"
        ? state.isGameOver
          ? "Игра окончена"
          : "Раунд завершён"
        : 'Создано при поддержке "Ячейка 9.11"';

  const content = gameContent();
  const key = [
    state.phase,
    state.currentQuestion?.status,
    state.currentQuestion?.buzzedTeamId,
    state.you.yourVote,
    state.isGameOver ? "final" : ""
  ].join(":");

  els.playerMain.innerHTML = content;
  updatePlayerTimer();

  if (lastRenderKey && key !== lastRenderKey) {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  lastRenderKey = key;
}

function shortPhaseLabel(snapshot) {
  if (snapshot.phase === "lobby") return "Лобби";
  if (snapshot.phase === "themeSelect") return "Выбор вопроса";
  if (snapshot.phase === "voting") return "Голосование";
  if (snapshot.phase === "finished") return snapshot.isGameOver ? "Финал" : "Конец раунда";
  const status = snapshot.currentQuestion?.status;
  if (status === "selected") return "Подготовка";
  if (status === "buzzed") return "Ответ";
  if (status === "result") return "Результат";
  return "Идёт вопрос";
}

function gameContent() {
  switch (state.phase) {
    case "lobby":
      return lobbyContent();
    case "themeSelect":
      return themeSelectContent();
    case "question":
      return questionContent();
    case "voting":
      return votingContent();
    case "finished":
      return finishedContent();
    default:
      return "";
  }
}

function lobbyContent() {
  const myTeam = state.you.team;
  const members = (myTeam.members || [])
    .map((member) => {
      const classes = ["p-member"];
      if (!member.connected) classes.push("is-offline");
      if (member.id === state.you.playerId) classes.push("is-you");
      return `<div class="${classes.join(" ")}">
        <span>${SI.escapeHtml(member.name)}</span>
        ${member.id === state.you.playerId ? `<span class="p-member-you">это вы</span>` : ""}
      </div>`;
    })
    .join("");

  return `
    <div class="p-screen">
      <div class="p-card p-center">
        <div class="p-emoji">👋</div>
        <span class="p-eyebrow">Вы в игре</span>
        <h2 class="p-title p-title--team">${SI.escapeHtml(myTeam.name)}</h2>
        <p class="p-text">Ждём, когда ведущий начнёт игру. Оставайтесь на этой странице — всё обновится автоматически.</p>
        <div class="p-members">${members}</div>
      </div>
      <div class="p-note">Когда откроется вопрос, на экране появится большая кнопка «Ответить». Нажимает первый успевший игрок команды.</div>
    </div>`;
}

function themeSelectContent() {
  const selector = state.selectorTeam;
  const mine = selector && selector.id === state.you.team.id;
  return `
    <div class="p-screen">
      <div class="p-card p-center">
        <div class="p-emoji">🎯</div>
        <span class="p-eyebrow">Переменка</span>
        <h2 class="p-title">${mine ? "Ваша команда выбирает" : "Сейчас выбирает"}</h2>
        ${
          selector
            ? `<div class="p-selector-team">
                <span class="p-selector-avatar" style="--selector-color:${SI.escapeHtml(
                  selector.color
                )}">${SI.teamInitials(selector.name)}</span>
                <div class="p-selector-copy">
                  <strong>${SI.escapeHtml(selector.name)}</strong>
                  <span>${mine ? "Объявите тему и стоимость ведущему" : "Следите за большим экраном"}</span>
                </div>
              </div>`
            : `<p class="p-text">Ведущий готовит следующее поле.</p>`
        }
        <p class="p-text">${
          mine
            ? "Назовите тему и стоимость — ведущий откроет выбранный вопрос."
            : "Когда ведущий откроет вопрос, кнопка ответа станет активной."
        }</p>
      </div>
      <div class="p-note">Количество вопросов на поле: ${
        (state.board || []).reduce(
          (sum, theme) => sum + theme.cells.filter((cell) => !cell.played).length,
          0
        )
      }.</div>
    </div>`;
}

function questionContent() {
  const question = state.currentQuestion;
  if (!question) {
    return `<div class="p-card p-center"><div class="p-emoji">⏳</div><h2 class="p-title">Готовим вопрос</h2></div>`;
  }

  if (question.status === "selected") {
    return `
      <div class="p-screen">
        <div class="p-card p-center">
          <div class="p-emoji">🎬</div>
          <span class="p-eyebrow">Вопрос выбран</span>
          <h2 class="p-title">${SI.escapeHtml(question.theme)} · ${SI.formatScore(
            question.value
          )}</h2>
          <p class="p-text">Ведущий готовит показ. Приготовьтесь нажать «Ответить» — вопрос вот-вот появится на экране.</p>
        </div>
      </div>`;
  }

  const myTeam = state.you.team;
  const result = question.result;
  const buzzedTeam = state.teams.find((team) => team.id === question.buzzedTeamId);
  const myBuzz = Boolean(question.buzzedTeamId === myTeam.id);
  const myBlocked = Boolean(myTeam.blocked);

  let statusClass = "p-status--warn";
  let statusIcon = "⚡";
  let statusTitle = "Кто первым нажмёт кнопку?";
  let statusText = "Если готовы отвечать — жмите большую кнопку.";

  if (question.status === "buzzed") {
    if (myBuzz) {
      statusClass = "p-status--good p-status--you";
      statusIcon = "✋";
      statusTitle = "Вы нажали первыми!";
      statusText = "Отвечайте вслух. Ведущий засчитает ответ.";
    } else {
      statusClass = "p-status--warn";
      statusIcon = "⏳";
      statusTitle = `Отвечает ${buzzedTeam?.name || question.buzzedTeamName || "другая команда"}`;
      statusText = "Кнопка останется заблокированной, пока ведущий не оценит ответ.";
    }
  } else if (result?.correct) {
    if (result.teamId === myTeam.id) {
      statusClass = "p-status--good p-status--you";
      statusIcon = "✓";
      statusTitle = `Верно! +${SI.formatScore(result.delta)}`;
      statusText = "Отличная работа. Очки уже на табло.";
    } else {
      statusClass = "p-status--neutral";
      statusIcon = "🏁";
      statusTitle = `Команда «${result.teamName}» ответила верно`;
      statusText = "Готовьтесь к следующему вопросу.";
    }
  } else if (result && !result.correct) {
    if (result.teamId === myTeam.id) {
      statusClass = "p-status--bad";
      statusIcon = "✕";
      statusTitle = result.penalty
        ? `Неверно · −${SI.formatScore(result.penalty)}`
        : "Неверно";
      statusText = result.penalty
        ? "Штраф снят со счёта. Команда заблокирована до конца вопроса."
        : "Команда заблокирована до конца вопроса. Дождитесь следующего шанса или голосования.";
    } else {
      statusClass = "p-status--warn";
      statusIcon = "⚡";
      statusTitle = `Команда «${result.teamName}» ошиблась${
        result.penalty ? ` · −${SI.formatScore(result.penalty)}` : ""
      }`;
      statusText = myBlocked
        ? "Вы уже ошиблись в этом вопросе."
        : "Ваш шанс! Кнопка снова активна.";
    }
  } else if (myBlocked) {
    statusClass = "p-status--bad";
    statusIcon = "✕";
    statusTitle = "Команда ошиблась";
    statusText = "Кнопка недоступна до конца вопроса.";
  }

  let action = "";
  if (question.status === "shown") {
    const canBuzz = state.you.canBuzz && !pendingBuzz;
    let label = "ОТВЕТИТЬ";
    let hint = "Нажмите, если готовы";
    if (myBlocked) {
      label = "ЗАБЛОКИРОВАНО";
      hint = "Команда уже ошиблась";
    } else if (!state.you.canBuzz && !pendingBuzz) {
      label = "ЖДЁМ...";
      hint = "Кнопка пока недоступна";
    } else if (pendingBuzz) {
      label = "ОТПРАВЛЯЕМ...";
      hint = "Фиксируем нажатие";
    }
    action = `
      <button class="p-buzz ${pendingBuzz ? "is-pending" : ""}" type="button"
        data-action="buzz" ${canBuzz ? "" : "disabled"}>
        <span class="p-buzz-label">${label}</span>
        <span class="p-buzz-hint">${hint}</span>
      </button>`;
  } else if (question.status === "buzzed") {
    action = `
      <button class="p-buzz" type="button" disabled>
        <span class="p-buzz-label">${myBuzz ? "ВЫ ОТВЕЧАЕТЕ" : "ОТВЕЧАЕТ ДРУГАЯ"}</span>
        <span class="p-buzz-hint">${
          myBuzz ? "Слушайте вопрос ведущего" : "Дождитесь своей очереди"
        }</span>
      </button>`;
  }

  const timer = timerMarkup();

  return `
    <div class="p-screen">
      <div class="p-question-card">
        <div class="p-qmeta">
          <span class="p-qtheme">${SI.escapeHtml(question.theme)}</span>
          <span class="p-qvalue">${SI.formatScore(question.value)}</span>
        </div>
        ${
          question.imageUrl
            ? `<img class="p-question-image" src="${SI.escapeHtml(
                question.imageUrl
              )}" alt="Иллюстрация к вопросу" />`
            : ""
        }
        ${
          question.text
            ? `<p class="p-question">${SI.escapeHtml(question.text)}</p>`
            : ""
        }
        ${timer}
      </div>
      <div class="p-status ${statusClass}">
        <span class="p-status-icon">${statusIcon}</span>
        <div class="p-status-copy">
          <div class="p-status-title">${SI.escapeHtml(statusTitle)}</div>
          <div class="p-status-text">${SI.escapeHtml(statusText)}</div>
        </div>
      </div>
      ${action}
    </div>`;
}

function votingContent() {
  const voting = state.voting;
  if (!voting) {
    return `<div class="p-card p-center"><h2 class="p-title">Голосование завершается</h2></div>`;
  }

  const question = state.currentQuestion;
  const yourVote = state.you.yourVote || voting.yourVote;
  const disabled = Boolean(yourVote) || pendingVote;
  const continueSelected = yourVote === "continue";
  const passSelected = yourVote === "pass";

  return `
    <div class="p-screen">
      ${
        question?.text
          ? `<div class="p-card">
              <div class="p-qmeta">
                <span class="p-qtheme">${SI.escapeHtml(question.theme)}</span>
                <span class="p-qvalue">${SI.formatScore(question.value)}</span>
              </div>
              <p class="p-question p-question--compact">${SI.escapeHtml(question.text)}</p>
            </div>`
          : ""
      }
      <div class="p-vote-card">
        <span class="p-eyebrow">Голосование за пас</span>
        <h2 class="p-vote-title">Продолжить или пас?</h2>
        <p class="p-vote-desc">${
          voting.reason === "all-failed"
            ? "Все команды ошиблись. Решите, продолжать ли вопрос."
            : voting.reason === "timer"
              ? "Время на ответ истекло. Решите, продолжать ли вопрос."
              : "Ведущий запустил голосование. Один голос от команды."
        }</p>
        <div class="p-vote-counts">
          <div class="p-vote-count">
            <span>Продолжить</span>
            <strong>${voting.counts?.continue || 0}</strong>
          </div>
          <div class="p-vote-count p-vote-count--pass">
            <span>Пас</span>
            <strong>${voting.counts?.pass || 0}</strong>
          </div>
        </div>
        <div class="p-vote-actions">
          <button class="p-vote-btn p-vote-btn--continue ${continueSelected ? "is-selected" : ""}"
            type="button" data-action="vote" data-choice="continue" ${disabled ? "disabled" : ""}>
            <span>▶</span>
            Продолжить
            <small>вернуть всех в игру</small>
          </button>
          <button class="p-vote-btn p-vote-btn--pass ${passSelected ? "is-selected" : ""}"
            type="button" data-action="vote" data-choice="pass" ${disabled ? "disabled" : ""}>
            <span>✋</span>
            Пас вопроса
            <small>перейти к новой теме</small>
          </button>
        </div>
        ${
          yourVote
            ? `<div class="p-vote-done">Ваш голос: ${
                yourVote === "continue" ? "продолжить игру" : "пас вопроса"
              }. Ждём остальные команды.</div>`
            : pendingVote
              ? `<div class="p-vote-done">Отправляем голос…</div>`
              : `<div class="p-note" style="margin-top:10px">Голос от команды засчитывается один раз. После голосования кнопки блокируются.</div>`
        }
        ${timerMarkup()}
      </div>
    </div>`;
}

function finishedContent() {
  const myTeam = state.you.team;
  const standings = state.standings || [];
  const rank = standings.find((team) => team.id === myTeam.id)?.rank || "—";
  const winner = standings[0];
  const coWinners = standings.filter((team) => team.score === (winner?.score ?? 0));
  const rows = standings
    .map(
      (team) => `
      <div class="p-final-row ${team.id === myTeam.id ? "is-me" : ""}">
        <span class="p-final-rank">${team.rank}</span>
        <span class="p-final-name">${team.rank === 1 ? "🏆 " : ""}${SI.escapeHtml(
          team.name
        )}</span>
        <span class="p-final-score">${SI.formatScore(team.score)}</span>
      </div>`
    )
    .join("");

  const title = state.isGameOver
    ? coWinners.length > 1
      ? "Ничья!"
      : "Игра окончена"
    : "Раунд завершён";

  return `
    <div class="p-screen">
      <div class="p-card p-center p-final-head">
        <div class="p-emoji">${state.isGameOver ? (rank === 1 ? "🏆" : "🎉") : "🎬"}</div>
        <span class="p-eyebrow">${state.isGameOver ? "Финал" : `Раунд ${state.round?.number || ""}`}</span>
        <h2 class="p-title">${title}</h2>
        <p class="p-text">${
          state.isGameOver
            ? coWinners.length > 1
              ? "Победители набрали одинаковое количество баллов."
              : `Победила команда «${SI.escapeHtml(winner?.name || "—")}».`
            : "Счёт сохранён. Следующий раунд запустит ведущий."
        }</p>
        <div class="p-highlight"><strong>Ваше место: ${rank}.</strong> Счёт команды: ${SI.formatScore(
          myTeam.score
        )}.</div>
      </div>
      <div class="p-card">
        <span class="p-eyebrow">Таблица</span>
        <div class="p-final-list">${rows}</div>
      </div>
    </div>`;
}

function timerMarkup() {
  const timer = state.timer;
  return `
    <div class="p-timer ${timer ? "" : "hidden"}" id="playerTimer">
      <span>${timer?.type === "voting" ? "Голосование" : "До конца"}</span>
      <strong data-timer-value>${timer ? Math.ceil(SI.remainingMs(timer.endsAt) / 1000) : 0}</strong>
      <small>сек</small>
    </div>`;
}

function updatePlayerTimer() {
  const element = document.getElementById("playerTimer");
  if (!element) return;
  const timer = state?.timer;
  if (!timer) {
    element.classList.add("hidden");
    return;
  }
  const remaining = SI.remainingMs(timer.endsAt);
  element.classList.remove("hidden");
  const value = element.querySelector("[data-timer-value]");
  if (value) value.textContent = String(Math.max(0, Math.ceil(remaining / 1000)));
  element.classList.toggle("is-urgent", remaining <= 10000);
}

setInterval(updatePlayerTimer, 250);

/* ------------------------------------------------------------------ */
/* Нажатия и голоса                                                    */
/* ------------------------------------------------------------------ */

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button || !isJoined) return;
  if (button.dataset.action === "buzz") {
    handleBuzz(button);
  } else if (button.dataset.action === "vote") {
    handleVote(button.dataset.choice, button);
  }
});

async function handleBuzz(button) {
  if (pendingBuzz || !state?.you?.canBuzz) return;
  pendingBuzz = true;
  button.disabled = true;
  button.classList.add("is-pending");
  const label = button.querySelector(".p-buzz-label");
  const hint = button.querySelector(".p-buzz-hint");
  if (label) label.textContent = "ОТПРАВЛЯЕМ...";
  if (hint) hint.textContent = "Фиксируем нажатие";
  if (navigator.vibrate) navigator.vibrate(35);

  const response = await SI.request(socket, "buzz", {}, { silent: true });
  if (!response.ok) {
    pendingBuzz = false;
    SI.toast(response.error || "Не удалось нажать кнопку.", "error");
    renderGame();
    return;
  }

  if (navigator.vibrate) navigator.vibrate([70, 45, 120]);
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    if (pendingBuzz) {
      pendingBuzz = false;
      renderGame();
    }
  }, 2500);
}

async function handleVote(choice, button) {
  if (pendingVote || state?.you?.yourVote) return;
  if (!["continue", "pass"].includes(choice)) return;
  pendingVote = true;
  const buttons = els.playerMain.querySelectorAll(".p-vote-btn");
  for (const item of buttons) item.disabled = true;
  button.classList.add("is-selected");

  const response = await SI.request(socket, "vote", { choice }, { silent: true });
  if (!response.ok) {
    pendingVote = false;
    SI.toast(response.error || "Не удалось проголосовать.", "error");
    renderGame();
    return;
  }

  if (navigator.vibrate) navigator.vibrate(45);
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    if (pendingVote) {
      pendingVote = false;
      renderGame();
    }
  }, 2500);
}

/* ------------------------------------------------------------------ */
/* Уведомления о событиях                                              */
/* ------------------------------------------------------------------ */

function handlePlayerEvent(event) {
  const data = event.data || {};
  const myTeam = state?.you?.team;
  if (!myTeam) return;

  switch (event.type) {
    case "buzz": {
      if (data.teamId === myTeam.id) {
        SI.toast("Вы нажали первыми!", "success", 1800);
        if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
      } else if (data.teamName) {
        SI.toast(`Отвечает «${data.teamName}».`, "info", 1700);
      }
      break;
    }
    case "correct": {
      if (data.teamId === myTeam.id) {
        SI.toast(`Верно! +${SI.formatScore(data.delta)}`, "success");
        if (navigator.vibrate) navigator.vibrate([50, 35, 50, 35, 90]);
      }
      break;
    }
    case "wrong": {
      if (data.teamId === myTeam.id) {
        SI.toast(
          data.penalty
            ? `Неверно. Штраф −${SI.formatScore(data.penalty)}. Команда заблокирована.`
            : "Неверно. Команда заблокирована до конца вопроса.",
          "error"
        );
        if (navigator.vibrate) navigator.vibrate(80);
      }
      break;
    }
    case "voting:start":
      SI.toast("Голосование за пас: сделайте выбор.", "info");
      if (navigator.vibrate) navigator.vibrate([40, 50, 40]);
      break;
    case "voting:resume":
      SI.toast("Играем дальше! Кнопка ответа снова активна.", "success");
      break;
    case "voting:pass":
      SI.toast("Пас вопроса. Переходим к выбору темы.", "info");
      break;
    case "voting:tie":
      SI.toast("Голоса разделились. Решает ведущий.", "info");
      break;
    case "game:finished":
      SI.toast("Игра окончена! Смотрите итоговую таблицу.", "success", 3000);
      if (navigator.vibrate) navigator.vibrate([50, 40, 50, 40, 120]);
      break;
    case "round:finished":
      SI.toast("Раунд завершён. Ждём следующий.", "info");
      break;
    case "new:game":
      SI.toast("Ведущий начал новую игру. Счёт сброшен.", "info");
      break;
    case "player:joined":
      break;
    default:
      break;
  }
}
