"use strict";

/**
 * Небольшой набор общих функций для трёх интерфейсов.
 * Никаких внешних библиотек, кроме Socket.IO, не используется.
 */
window.SI = (function () {
  const scoreFormatter = new Intl.NumberFormat("ru-RU");
  let serverOffset = 0;
  let toastLayer = null;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function acceptState(state) {
    if (state && Number.isFinite(state.serverNow)) {
      serverOffset = state.serverNow - Date.now();
    }
  }

  function now() {
    return Date.now() + serverOffset;
  }

  function remainingMs(endsAt) {
    if (!endsAt) return 0;
    return Math.max(0, endsAt - now());
  }

  function formatScore(value) {
    const number = Number(value) || 0;
    return scoreFormatter.format(number);
  }

  function signedScore(value) {
    const number = Number(value) || 0;
    if (number > 0) return `+${formatScore(number)}`;
    return formatScore(number);
  }

  function formatClock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    if (minutes > 0) return `${minutes}:${String(seconds).padStart(2, "0")}`;
    return String(seconds);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function teamInitials(name) {
    return String(name || "?")
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() || "")
      .join("");
  }

  const statusLabels = {
    ready: "В игре",
    blocked: "Ошиблась",
    answering: "Отвечает",
    offline: "Нет связи",
    empty: "Нет игроков"
  };

  function statusLabel(status) {
    return statusLabels[status] || "В игре";
  }

  function plural(number, one, few, many) {
    const n = Math.abs(number) % 100;
    const n1 = n % 10;
    if (n > 10 && n < 20) return many;
    if (n1 > 1 && n1 < 5) return few;
    if (n1 === 1) return one;
    return many;
  }

  function phaseLabel(state) {
    if (!state) return "Подключение";
    switch (state.phase) {
      case "lobby":
        return "Лобби";
      case "themeSelect":
        return `Выбор вопроса · ${state.selectorTeam?.name || "нет команды"}`;
      case "question": {
        const status = state.currentQuestion?.status;
        if (status === "selected") return "Вопрос выбран";
        if (status === "buzzed") return "Команда отвечает";
        if (status === "result") return "Ответ принят";
        return "Идёт вопрос";
      }
      case "voting":
        return "Голосование за пас";
      case "finished":
        return state.isGameOver ? "Игра окончена" : "Раунд завершён";
      default:
        return "Игра";
    }
  }

  function ensureToastLayer() {
    if (toastLayer && document.body.contains(toastLayer)) return toastLayer;
    toastLayer = document.createElement("div");
    toastLayer.className = "toast-layer";
    toastLayer.setAttribute("aria-live", "polite");
    document.body.appendChild(toastLayer);
    return toastLayer;
  }

  function toast(message, type = "info", duration = 3200) {
    if (!message) return;
    const layer = ensureToastLayer();
    while (layer.children.length >= 3) {
      layer.firstElementChild?.remove();
    }
    const el = document.createElement("div");
    el.className = `toast toast--${type}`;
    const icon = type === "success" ? "✓" : type === "error" ? "!" : "i";
    const iconEl = document.createElement("span");
    iconEl.className = "toast__icon";
    iconEl.textContent = icon;
    const textEl = document.createElement("span");
    textEl.textContent = message;
    el.append(iconEl, textEl);
    layer.appendChild(el);
    requestAnimationFrame(() => el.classList.add("is-visible"));
    setTimeout(() => {
      el.classList.remove("is-visible");
      setTimeout(() => el.remove(), 220);
    }, duration);
  }

  function request(socket, event, payload = {}, options = {}) {
    return new Promise((resolve) => {
      if (!socket || !socket.connected) {
        if (!options.silent) toast("Нет связи с сервером.", "error");
        resolve({ ok: false, error: "Нет связи с сервером." });
        return;
      }

      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (!options.silent) toast("Сервер не ответил. Проверьте соединение.", "error");
        resolve({ ok: false, error: "Сервер не ответил." });
      }, 6000);

      socket.emit(event, payload, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        const result = response || { ok: false, error: "Пустой ответ сервера." };
        if (!result.ok && !options.silent) {
          toast(result.error || "Не удалось выполнить действие.", "error");
        }
        resolve(result);
      });
    });
  }

  function bindConnection(socket, element, options = {}) {
    if (!element) return;
    const onlineText = options.onlineText || "На связи";
    const offlineText = options.offlineText || "Нет связи";
    const render = () => {
      const online = socket.connected;
      element.classList.toggle("is-online", online);
      element.classList.toggle("is-offline", !online);
      element.textContent = online ? onlineText : offlineText;
      element.title = online ? "Соединение с сервером установлено" : "Соединение потеряно";
    };
    socket.on("connect", render);
    socket.on("disconnect", render);
    render();
  }

  function scrollIntoViewSoft(element) {
    if (element) element.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function animateNumber(element, from, to, duration = 700) {
    if (!element) return;
    const start = performance.now();
    const diff = to - from;
    function frame(current) {
      const progress = Math.min(1, (current - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      element.textContent = formatScore(Math.round(from + diff * eased));
      if (progress < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function confetti(container, count = 70) {
    if (!container) return;
    const colors = ["#ff5470", "#4da3ff", "#59e3a7", "#ffc857", "#b083ff", "#ffffff"];
    for (let index = 0; index < count; index += 1) {
      const piece = document.createElement("span");
      piece.className = "confetti-piece";
      piece.style.left = `${Math.random() * 100}%`;
      piece.style.background = colors[index % colors.length];
      piece.style.animationDelay = `${Math.random() * 1.5}s`;
      piece.style.animationDuration = `${2.4 + Math.random() * 2.4}s`;
      piece.style.setProperty("--drift", `${-80 + Math.random() * 160}px`);
      piece.style.width = `${6 + Math.random() * 9}px`;
      piece.style.height = `${9 + Math.random() * 15}px`;
      piece.style.transform = `rotate(${Math.random() * 360}deg)`;
      container.appendChild(piece);
      setTimeout(() => piece.remove(), 5200);
    }
  }

  return {
    $,
    $$,
    acceptState,
    now,
    remainingMs,
    formatScore,
    signedScore,
    formatClock,
    escapeHtml,
    teamInitials,
    statusLabel,
    plural,
    phaseLabel,
    toast,
    request,
    bindConnection,
    scrollIntoViewSoft,
    animateNumber,
    confetti
  };
})();
