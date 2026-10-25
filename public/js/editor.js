"use strict";

const socket = io();
const $ = SI.$;
const EDITOR_TOKEN_KEY = "si_editor_token";

const els = {
  shell: $("#editorShell"),
  connection: $("#editorConnection"),
  subtitle: $("#editorSubtitle"),
  gameName: $("#gameName"),
  gameDescription: $("#gameDescription"),
  categoryCount: $("#categoryCount"),
  questionCount: $("#questionCount"),
  imageCount: $("#imageCount"),
  categories: $("#categories"),
  workspaceTitle: $("#workspaceTitle"),
  saveStatus: $("#saveStatus"),
  saveStatusText: $("#saveStatusText"),
  saveGameBtn: $("#saveGameBtn"),
  savedGames: $("#savedGames"),

  imageFileInput: $("#imageFileInput"),
  gameFileInput: $("#gameFileInput"),

  confirm: $("#editorConfirm"),
  confirmTitle: $("#editorConfirmTitle"),
  confirmText: $("#editorConfirmText"),
  confirmAccept: $('[data-action="confirm-accept"]', $("#editorConfirm")),

  auth: $("#editorAuth"),
  authForm: $("#editorAuthForm"),
  password: $("#editorPassword"),
  authError: $("#editorAuthError"),
  authSubmit: $("#editorAuthSubmit"),
  authConnection: $("#editorAuthConnection")
};

const CATEGORY_COLORS = ["#ffbd59", "#6fa8ff", "#67e6b3", "#ff7d9e", "#b995ff", "#4dd8d0", "#ff9e6d"];
const MAX_IMAGE_CHARS = 3_800_000;

let editorToken = sessionStorage.getItem(EDITOR_TOKEN_KEY) || "";
let authorized = false;
let savedGames = [];
let dirty = false;
let saveInFlight = false;
let activeImageTarget = null;
let confirmAction = null;
let draft = createStarterDraft();

SI.bindConnection(socket, els.connection);
SI.bindConnection(socket, els.authConnection);

/* ------------------------------------------------------------------ */
/* Авторизация                                                         */
/* ------------------------------------------------------------------ */

function showAuth(message = "") {
  authorized = false;
  els.shell.classList.add("is-locked");
  els.auth.classList.remove("hidden");
  els.authError.classList.toggle("hidden", !message);
  els.authError.textContent = message;
  setTimeout(() => els.password.focus(), 80);
}

function hideAuth() {
  authorized = true;
  els.shell.classList.remove("is-locked");
  els.auth.classList.add("hidden");
  els.authError.classList.add("hidden");
}

async function joinEditor() {
  if (!editorToken) {
    showAuth();
    return;
  }
  const response = await SI.request(
    socket,
    "join",
    { role: "editor", token: editorToken },
    { silent: true }
  );
  if (response.ok) {
    hideAuth();
    renderEditor();
    return;
  }
  if (response.code === "AUTH_REQUIRED") {
    editorToken = "";
    sessionStorage.removeItem(EDITOR_TOKEN_KEY);
    showAuth("Сессия истекла. Введите пароль заново.");
  } else {
    showAuth(response.error || "Не удалось открыть редактор.");
  }
}

socket.on("connect", joinEditor);

socket.on("editor:state", (nextState) => {
  savedGames = Array.isArray(nextState?.games) ? nextState.games : [];
  renderSavedGames();
});

els.authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!socket.connected) {
    showAuth("Нет связи с сервером. Проверьте, что он запущен.");
    return;
  }
  const password = els.password.value;
  if (!password) {
    showAuth("Введите пароль.");
    return;
  }

  els.authSubmit.disabled = true;
  els.authSubmit.textContent = "Проверяем…";
  const auth = await SI.request(
    socket,
    "auth:login",
    { role: "editor", password },
    { silent: true }
  );
  if (!auth.ok) {
    els.authSubmit.disabled = false;
    els.authSubmit.textContent = "Войти";
    showAuth(auth.error || "Неверный пароль.");
    return;
  }

  editorToken = auth.token;
  sessionStorage.setItem(EDITOR_TOKEN_KEY, editorToken);
  els.password.value = "";
  const joined = await SI.request(
    socket,
    "join",
    { role: "editor", token: editorToken },
    { silent: true }
  );
  els.authSubmit.disabled = false;
  els.authSubmit.textContent = "Войти";

  if (!joined.ok) {
    showAuth(joined.error || "Не удалось открыть редактор.");
    return;
  }
  hideAuth();
  renderEditor();
});

/* ------------------------------------------------------------------ */
/* Модель черновика                                                    */
/* ------------------------------------------------------------------ */

function uid(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}-${Date.now().toString(36)}`;
}

function newQuestion(value) {
  return {
    id: uid("q"),
    value: String(value || 100),
    text: "",
    answer: "",
    image: null
  };
}

function newCategory(name) {
  return {
    id: uid("c"),
    name,
    questions: [newQuestion(100)]
  };
}

function createStarterDraft() {
  return {
    id: null,
    name: "",
    description: "",
    categories: [newCategory("Новая категория")]
  };
}

function createBlankDraft() {
  return {
    id: null,
    name: "",
    description: "",
    categories: []
  };
}

function countDraft() {
  const categories = draft.categories.length;
  const questions = draft.categories.reduce(
    (sum, category) => sum + category.questions.length,
    0
  );
  const images = draft.categories.reduce(
    (sum, category) =>
      sum + category.questions.filter((question) => Boolean(question.image)).length,
    0
  );
  return { categories, questions, images };
}

function findCategory(categoryId) {
  return draft.categories.find((category) => category.id === categoryId) || null;
}

function findQuestion(categoryId, questionId) {
  const category = findCategory(categoryId);
  return category?.questions.find((question) => question.id === questionId) || null;
}

function markDirty() {
  dirty = true;
  updateSaveStatus();
  els.subtitle.textContent = `${draft.name || "Без названия"} · есть изменения`;
}

function updateSaveStatus() {
  const counts = countDraft();
  els.categoryCount.textContent = String(counts.categories);
  els.questionCount.textContent = String(counts.questions);
  els.imageCount.textContent = String(counts.images);

  els.saveStatus.classList.toggle("is-dirty", dirty);
  els.saveStatus.classList.toggle("is-saved", !dirty && Boolean(draft.id));
  if (dirty) {
    els.saveStatusText.textContent = "Есть несохранённые изменения";
  } else if (draft.id) {
    els.saveStatusText.textContent = "Сохранено в библиотеке";
  } else {
    els.saveStatusText.textContent = "Черновик не сохранён";
  }
}

/* ------------------------------------------------------------------ */
/* Отрисовка                                                           */
/* ------------------------------------------------------------------ */

function renderEditor() {
  els.gameName.value = draft.name;
  els.gameDescription.value = draft.description;
  els.workspaceTitle.textContent = draft.name.trim() || "Новая игра";
  els.subtitle.textContent = draft.name
    ? `${draft.name}${dirty ? " · есть изменения" : ""}`
    : "Своя игра · конструктор";

  renderCategories();
  updateSaveStatus();
  renderSavedGames();
}

function renderCategories() {
  els.categories.innerHTML = "";

  if (!draft.categories.length) {
    const empty = document.createElement("div");
    empty.className = "editor-empty";
    empty.innerHTML = `
      <strong>Пока нет ни одной категории</strong>
      <span>Добавьте категорию и наполните её вопросами. Количество не ограничено.</span>`;
    els.categories.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  draft.categories.forEach((category, categoryIndex) => {
    fragment.appendChild(renderCategory(category, categoryIndex));
  });
  els.categories.replaceChildren(fragment);
}

function renderCategory(category, categoryIndex) {
  const element = document.createElement("article");
  element.className = "category-card";
  element.dataset.categoryId = category.id;
  element.style.setProperty(
    "--category-color",
    CATEGORY_COLORS[categoryIndex % CATEGORY_COLORS.length]
  );

  const head = document.createElement("div");
  head.className = "category-head";

  const number = document.createElement("span");
  number.className = "category-number";
  number.textContent = String(categoryIndex + 1);

  const nameWrap = document.createElement("div");
  nameWrap.className = "category-name-wrap";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "category-name-input";
  nameInput.value = category.name;
  nameInput.placeholder = "Название категории";
  nameInput.maxLength = 80;
  nameInput.dataset.field = "category-name";
  nameWrap.appendChild(nameInput);

  const count = document.createElement("span");
  count.className = "category-count";
  count.textContent = `${category.questions.length} ${SI.plural(
    category.questions.length,
    "вопрос",
    "вопроса",
    "вопросов"
  )}`;

  const actions = document.createElement("div");
  actions.className = "category-actions";
  actions.append(
    iconButton("↑", "Переместить выше", "move-category-up", {
      categoryId: category.id,
      disabled: categoryIndex === 0
    }),
    iconButton("↓", "Переместить ниже", "move-category-down", {
      categoryId: category.id,
      disabled: categoryIndex === draft.categories.length - 1
    }),
    iconButton("✕", "Удалить категорию", "delete-category", {
      categoryId: category.id,
      danger: true
    })
  );

  head.append(number, nameWrap, count, actions);

  const questions = document.createElement("div");
  questions.className = "questions";
  if (!category.questions.length) {
    const empty = document.createElement("div");
    empty.className = "image-placeholder";
    empty.textContent = "В этой категории пока нет вопросов.";
    questions.appendChild(empty);
  } else {
    category.questions.forEach((question, questionIndex) => {
      questions.appendChild(
        renderQuestion(category, question, categoryIndex, questionIndex)
      );
    });
  }

  const addQuestion = document.createElement("button");
  addQuestion.type = "button";
  addQuestion.className = "add-question-wide";
  addQuestion.dataset.action = "add-question";
  addQuestion.dataset.categoryId = category.id;
  addQuestion.innerHTML = "<span>+</span> Добавить вопрос";

  element.append(head, questions, addQuestion);
  return element;
}

function iconButton(label, title, action, { categoryId, questionId, disabled, danger } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `icon-btn${danger ? " icon-btn--danger" : ""}`;
  button.textContent = label;
  button.title = title;
  button.disabled = Boolean(disabled);
  button.dataset.action = action;
  if (categoryId) button.dataset.categoryId = categoryId;
  if (questionId) button.dataset.questionId = questionId;
  return button;
}

function renderQuestion(category, question, categoryIndex, questionIndex) {
  const card = document.createElement("article");
  card.className = "question-card";
  card.dataset.categoryId = category.id;
  card.dataset.questionId = question.id;

  const head = document.createElement("div");
  head.className = "question-head";

  const number = document.createElement("input");
  number.type = "number";
  number.className = "q-number";
  number.min = "1";
  number.max = "1000000";
  number.step = "50";
  number.value = question.value;
  number.title = "Стоимость вопроса";
  number.dataset.field = "question-value";

  const label = document.createElement("span");
  label.className = "q-head-label";
  label.textContent = `Вопрос ${questionIndex + 1}`;

  const actions = document.createElement("div");
  actions.className = "q-actions";
  actions.append(
    iconButton("↑", "Переместить выше", "move-question-up", {
      categoryId: category.id,
      questionId: question.id,
      disabled: questionIndex === 0
    }),
    iconButton("↓", "Переместить ниже", "move-question-down", {
      categoryId: category.id,
      questionId: question.id,
      disabled: questionIndex === category.questions.length - 1
    }),
    iconButton("✕", "Удалить вопрос", "delete-question", {
      categoryId: category.id,
      questionId: question.id,
      danger: true
    })
  );

  head.append(number, label, actions);

  const body = document.createElement("div");
  body.className = "question-body";

  const fields = document.createElement("div");
  fields.className = "q-fields";

  fields.append(
    labeledTextarea("Текст вопроса", "question-text", question.text, "Введите вопрос…", "q-input--question"),
    labeledTextarea("Правильный ответ", "question-answer", question.answer, "Ответ для ведущего…", "q-input--answer")
  );

  const imageBox = document.createElement("div");
  imageBox.className = `q-image-box${question.image ? " has-image" : ""}`;
  if (question.image) {
    const image = document.createElement("img");
    image.className = "q-image-preview";
    image.src = question.image;
    image.alt = "Изображение к вопросу";
    const imageActions = document.createElement("div");
    imageActions.className = "image-actions";
    const change = document.createElement("button");
    change.type = "button";
    change.className = "editor-btn";
    change.dataset.action = "choose-image";
    change.dataset.categoryId = category.id;
    change.dataset.questionId = question.id;
    change.textContent = "Заменить";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "editor-btn editor-btn--ghost";
    remove.dataset.action = "remove-image";
    remove.dataset.categoryId = category.id;
    remove.dataset.questionId = question.id;
    remove.textContent = "Удалить";
    imageActions.append(change, remove);
    imageBox.append(image, imageActions);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "image-placeholder";
    placeholder.textContent = "Изображение не прикреплено";
    const choose = document.createElement("button");
    choose.type = "button";
    choose.className = "editor-btn";
    choose.dataset.action = "choose-image";
    choose.dataset.categoryId = category.id;
    choose.dataset.questionId = question.id;
    choose.textContent = "Прикрепить";
    const actionsWrap = document.createElement("div");
    actionsWrap.className = "image-actions";
    actionsWrap.appendChild(choose);
    imageBox.append(placeholder, actionsWrap);
  }

  body.append(fields, imageBox);
  card.append(head, body);
  return card;
}

function labeledTextarea(label, field, value, placeholder, extraClass = "") {
  const wrapper = document.createElement("label");
  wrapper.className = "q-field";
  const span = document.createElement("span");
  span.textContent = label;
  const textarea = document.createElement("textarea");
  textarea.className = `q-input ${extraClass}`.trim();
  textarea.dataset.field = field;
  textarea.placeholder = placeholder;
  textarea.value = value || "";
  wrapper.append(span, textarea);
  return wrapper;
}

function renderSavedGames() {
  const currentId = draft.id;
  els.savedGames.innerHTML = "";

  if (!savedGames.length) {
    const empty = document.createElement("div");
    empty.className = "saved-empty";
    empty.textContent =
      "Пока нет сохранённых игр. Создайте набор и нажмите «Сохранить в игру».";
    els.savedGames.appendChild(empty);
    return;
  }

  for (const game of savedGames) {
    const item = document.createElement("div");
    item.className = "saved-game";
    if (game.id === currentId) item.classList.add("is-current");

    const top = document.createElement("div");
    top.className = "saved-game-top";
    const copy = document.createElement("div");
    copy.className = "saved-game-copy";
    const title = document.createElement("strong");
    title.textContent = game.name;
    const meta = document.createElement("span");
    meta.textContent = `${game.categoryCount} кат. · ${game.questionCount} вопр.`;
    copy.append(title, meta);
    top.appendChild(copy);

    const actions = document.createElement("div");
    actions.className = "saved-game-actions";
    const load = document.createElement("button");
    load.type = "button";
    load.className = "saved-action";
    load.dataset.action = "load-saved-game";
    load.dataset.id = game.id;
    load.textContent = "Открыть";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "saved-action saved-action--danger";
    remove.dataset.action = "delete-saved-game";
    remove.dataset.id = game.id;
    remove.textContent = "Удалить";
    actions.append(load, remove);

    item.append(top, actions);
    els.savedGames.appendChild(item);
  }
}

/* ------------------------------------------------------------------ */
/* Работа с формой                                                     */
/* ------------------------------------------------------------------ */

els.gameName.addEventListener("input", () => {
  draft.name = els.gameName.value;
  els.workspaceTitle.textContent = draft.name.trim() || "Новая игра";
  markDirty();
});

els.gameDescription.addEventListener("input", () => {
  draft.description = els.gameDescription.value;
  markDirty();
});

els.categories.addEventListener("input", (event) => {
  const field = event.target.dataset?.field;
  if (!field) return;
  const categoryEl = event.target.closest(".category-card");
  const questionEl = event.target.closest(".question-card");
  const category = findCategory(categoryEl?.dataset.categoryId);
  if (!category) return;

  if (field === "category-name") {
    category.name = event.target.value;
    markDirty();
    return;
  }

  const question = findQuestion(category.id, questionEl?.dataset.questionId);
  if (!question) return;
  if (field === "question-value") question.value = event.target.value;
  if (field === "question-text") question.text = event.target.value;
  if (field === "question-answer") question.answer = event.target.value;
  markDirty();
});

els.categories.addEventListener("blur", (event) => {
  if (event.target.dataset?.field === "question-value") {
    const el = event.target.closest(".question-card");
    const category = findCategory(el?.dataset.categoryId);
    const question = findQuestion(category?.id, el?.dataset.questionId);
    if (question) {
      const parsed = Number.parseInt(question.value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) question.value = "100";
    }
  }
}, true);

/* ------------------------------------------------------------------ */
/* Действия конструктора                                               */
/* ------------------------------------------------------------------ */

function addCategory() {
  draft.categories.push(newCategory(`Категория ${draft.categories.length + 1}`));
  dirty = true;
  renderCategories();
  updateSaveStatus();
  markDirty();
  setTimeout(() => {
    els.categories.lastElementChild?.querySelector(".category-name-input")?.focus();
  }, 30);
}

function addQuestion(categoryId) {
  const category = findCategory(categoryId);
  if (!category) return;
  const values = category.questions
    .map((question) => Number.parseInt(question.value, 10))
    .filter((value) => Number.isFinite(value));
  const nextValue = values.length ? Math.max(...values) + 100 : 100;
  category.questions.push(newQuestion(nextValue));
  markDirty();
  renderCategories();
}

function moveItem(array, index, direction) {
  const target = index + direction;
  if (target < 0 || target >= array.length) return false;
  const [item] = array.splice(index, 1);
  array.splice(target, 0, item);
  return true;
}

function deleteCategory(categoryId) {
  const index = draft.categories.findIndex((category) => category.id === categoryId);
  if (index === -1) return;
  askConfirm({
    title: "Удалить категорию?",
    text: `Категория «${draft.categories[index].name}» и все её вопросы будут удалены.`,
    confirmLabel: "Удалить категорию",
    onAccept: () => {
      draft.categories.splice(index, 1);
      markDirty();
      renderCategories();
    }
  });
}

function deleteQuestion(categoryId, questionId) {
  const category = findCategory(categoryId);
  if (!category) return;
  const index = category.questions.findIndex((question) => question.id === questionId);
  if (index === -1) return;
  askConfirm({
    title: "Удалить вопрос?",
    text: `Вопрос ${index + 1} в категории «${category.name}» будет удалён.`,
    confirmLabel: "Удалить вопрос",
    onAccept: () => {
      category.questions.splice(index, 1);
      markDirty();
      renderCategories();
    }
  });
}

/* ------------------------------------------------------------------ */
/* Картинки                                                            */
/* ------------------------------------------------------------------ */

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Не удалось прочитать файл."));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Не удалось открыть изображение."));
    image.src = dataUrl;
  });
}

async function compressImage(file) {
  if (!file.type.startsWith("image/")) {
    throw new Error("Выберите файл изображения.");
  }
  if (file.size > 15 * 1024 * 1024) {
    throw new Error("Файл больше 15 МБ. Уменьшите изображение.");
  }

  const dataUrl = await readFileAsDataUrl(file);
  const image = await loadImage(dataUrl);
  let maxSide = 1600;
  let quality = 0.84;
  let result = "";

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    result = canvas.toDataURL("image/jpeg", quality);
    if (result.length <= MAX_IMAGE_CHARS) break;
    maxSide = Math.max(700, Math.round(maxSide * 0.78));
    quality = Math.max(0.65, quality - 0.07);
  }

  if (result.length > MAX_IMAGE_CHARS) {
    throw new Error("Даже после сжатия изображение слишком большое. Попробуйте другую картинку.");
  }
  return result;
}

function chooseImage(categoryId, questionId) {
  activeImageTarget = { categoryId, questionId };
  els.imageFileInput.value = "";
  els.imageFileInput.click();
}

async function applyImageFile(file) {
  if (!file || !activeImageTarget) return;
  const target = activeImageTarget;
  activeImageTarget = null;
  try {
    const compressed = await compressImage(file);
    const question = findQuestion(target.categoryId, target.questionId);
    if (!question) return;
    question.image = compressed;
    markDirty();
    renderCategories();
    SI.toast("Изображение прикреплено.", "success", 1800);
  } catch (error) {
    SI.toast(error.message || "Не удалось прикрепить изображение.", "error", 4000);
  }
}

els.imageFileInput.addEventListener("change", () => {
  const file = els.imageFileInput.files?.[0];
  els.imageFileInput.value = "";
  applyImageFile(file);
});

/* ------------------------------------------------------------------ */
/* Сохранение, импорт, экспорт                                         */
/* ------------------------------------------------------------------ */

function buildExportGame() {
  return {
    format: "svoya-igra-custom",
    version: 1,
    name: draft.name.trim() || "Моя игра",
    description: draft.description.trim(),
    categories: draft.categories.map((category) => ({
      name: (category.name || "").trim() || "Без названия",
      questions: category.questions.map((question) => ({
        value: Number.parseInt(question.value, 10) || 100,
        text: question.text,
        answer: question.answer,
        image: question.image || null
      }))
    }))
  };
}

function validateDraft() {
  if (!draft.name.trim()) return "Введите название игры.";
  if (!draft.categories.length) return "Добавьте хотя бы одну категорию.";
  for (let categoryIndex = 0; categoryIndex < draft.categories.length; categoryIndex += 1) {
    const category = draft.categories[categoryIndex];
    if (!category.name.trim()) {
      return `У категории ${categoryIndex + 1} нет названия.`;
    }
    if (!category.questions.length) {
      return `В категории «${category.name}» нет вопросов.`;
    }
    for (let questionIndex = 0; questionIndex < category.questions.length; questionIndex += 1) {
      const question = category.questions[questionIndex];
      if (!question.text.trim() && !question.image) {
        return `Вопрос ${questionIndex + 1} в категории «${category.name}» пуст: добавьте текст или изображение.`;
      }
      const value = Number.parseInt(question.value, 10);
      if (!Number.isFinite(value) || value <= 0) {
        return `У вопроса ${questionIndex + 1} в категории «${category.name}» некорректная стоимость.`;
      }
    }
  }
  return "";
}

async function saveGame() {
  if (saveInFlight) return;
  const error = validateDraft();
  if (error) {
    SI.toast(error, "error", 4500);
    return;
  }

  saveInFlight = true;
  els.saveGameBtn.disabled = true;
  els.saveGameBtn.textContent = "Сохраняем…";

  const payload = {
    id: draft.id || undefined,
    gameSet: buildExportGame()
  };
  const response = await SI.request(socket, "saveGameSet", payload, { silent: true });

  saveInFlight = false;
  els.saveGameBtn.disabled = false;
  els.saveGameBtn.textContent = "Сохранить в игру";

  if (!response.ok) {
    SI.toast(response.error || "Не удалось сохранить игру.", "error", 5000);
    return;
  }

  draft.id = response.id;
  dirty = false;
  updateSaveStatus();
  SI.toast("Игра сохранена и доступна в лобби ведущего.", "success", 3000);
}

function exportGame() {
  const error = validateDraft();
  if (error) {
    SI.toast(error, "error", 4500);
    return;
  }
  const data = buildExportGame();
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json;charset=utf-8"
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const safeName =
    (draft.name.trim() || "svoya-igra")
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, "-")
      .slice(0, 60) || "svoya-igra";
  link.href = url;
  link.download = `${safeName}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  SI.toast("JSON-файл игры скачан.", "success", 2200);
}

function normalizeImportedDraft(input) {
  if (!input || typeof input !== "object") {
    throw new Error("Файл не содержит объекта игры.");
  }
  let categories = null;
  if (Array.isArray(input.categories)) {
    categories = input.categories;
  } else if (Array.isArray(input.rounds) && input.rounds[0]?.themes) {
    categories = input.rounds[0].themes.map((theme) => ({
      name: theme.title,
      questions: theme.questions
    }));
  }
  if (!categories?.length) {
    throw new Error("В файле нет категорий с вопросами.");
  }

  return {
    id: null,
    name: String(input.name || "Импортированная игра").slice(0, 100),
    description: String(input.description || "").slice(0, 500),
    categories: categories.map((category, categoryIndex) => ({
      id: uid("c"),
      name: String(category.name || `Категория ${categoryIndex + 1}`).slice(0, 80),
      questions: (Array.isArray(category.questions) ? category.questions : []).map(
        (question, questionIndex) => ({
          id: uid("q"),
          value: String(
            Number.isFinite(Number.parseInt(question.value, 10))
              ? Number.parseInt(question.value, 10)
              : (questionIndex + 1) * 100
          ),
          text: String(question.text || ""),
          answer: String(question.answer || ""),
          image:
            typeof question.image === "string" &&
            /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(question.image)
              ? question.image
              : null
        })
      )
    }))
  };
}

async function importGame(file) {
  if (!file) return;
  if (file.size > 30 * 1024 * 1024) {
    SI.toast("Файл слишком большой (максимум 30 МБ).", "error");
    return;
  }
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    draft = normalizeImportedDraft(parsed);
    dirty = true;
    renderEditor();
    SI.toast("Игра загружена в редактор. Проверьте её и сохраните.", "success", 4000);
  } catch (error) {
    SI.toast(
      error instanceof SyntaxError
        ? "Файл не является корректным JSON."
        : error.message || "Не удалось загрузить игру.",
      "error",
      5000
    );
  }
}

els.gameFileInput.addEventListener("change", () => {
  const file = els.gameFileInput.files?.[0];
  els.gameFileInput.value = "";
  importGame(file);
});

async function loadSavedGame(gameSetId) {
  const response = await SI.request(
    socket,
    "getGameSet",
    { id: gameSetId },
    { silent: true }
  );
  if (!response.ok) {
    SI.toast(response.error || "Не удалось открыть игру.", "error");
    return;
  }
  draft = normalizeImportedDraft(response.gameSet);
  draft.id = response.id;
  dirty = false;
  renderEditor();
  SI.toast(`Игра «${draft.name}» открыта.`, "success", 2200);
}

function newDraft() {
  const doReset = () => {
    draft = createBlankDraft();
    dirty = false;
    renderEditor();
    els.gameName.focus();
  };
  if (dirty) {
    askConfirm({
      title: "Создать новый набор?",
      text: "Несохранённые изменения текущего черновика будут потеряны.",
      confirmLabel: "Создать новый",
      onAccept: doReset
    });
  } else {
    doReset();
  }
}

/* ------------------------------------------------------------------ */
/* Подтверждения                                                       */
/* ------------------------------------------------------------------ */

function askConfirm({ title, text, confirmLabel, onAccept }) {
  confirmAction = onAccept;
  els.confirmTitle.textContent = title;
  els.confirmText.textContent = text;
  els.confirmAccept.textContent = confirmLabel || "Удалить";
  els.confirm.classList.remove("hidden");
}

function closeConfirm() {
  confirmAction = null;
  els.confirm.classList.add("hidden");
}

els.confirm.addEventListener("click", (event) => {
  if (event.target === els.confirm) closeConfirm();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !els.confirm.classList.contains("hidden")) {
    closeConfirm();
  }
});

/* ------------------------------------------------------------------ */
/* Делегирование действий                                              */
/* ------------------------------------------------------------------ */

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  const categoryId = button.dataset.categoryId;
  const questionId = button.dataset.questionId;

  if (action === "add-category") {
    addCategory();
    return;
  }
  if (action === "add-question") {
    addQuestion(categoryId);
    return;
  }
  if (action === "delete-category") {
    deleteCategory(categoryId);
    return;
  }
  if (action === "delete-question") {
    deleteQuestion(categoryId, questionId);
    return;
  }
  if (action === "move-category-up" || action === "move-category-down") {
    const index = draft.categories.findIndex((category) => category.id === categoryId);
    if (moveItem(draft.categories, index, action.endsWith("up") ? -1 : 1)) {
      markDirty();
      renderCategories();
    }
    return;
  }
  if (action === "move-question-up" || action === "move-question-down") {
    const category = findCategory(categoryId);
    if (!category) return;
    const index = category.questions.findIndex((question) => question.id === questionId);
    if (moveItem(category.questions, index, action.endsWith("up") ? -1 : 1)) {
      markDirty();
      renderCategories();
    }
    return;
  }
  if (action === "choose-image") {
    chooseImage(categoryId, questionId);
    return;
  }
  if (action === "remove-image") {
    const question = findQuestion(categoryId, questionId);
    if (question) {
      question.image = null;
      markDirty();
      renderCategories();
    }
    return;
  }
  if (action === "save-game") {
    saveGame();
    return;
  }
  if (action === "export-game") {
    exportGame();
    return;
  }
  if (action === "import-game") {
    els.gameFileInput.click();
    return;
  }
  if (action === "new-draft") {
    newDraft();
    return;
  }
  if (action === "load-saved-game") {
    const id = button.dataset.id;
    if (!id) return;
    if (dirty) {
      askConfirm({
        title: "Открыть другую игру?",
        text: "Несохранённые изменения текущего черновика будут потеряны.",
        confirmLabel: "Открыть игру",
        onAccept: () => loadSavedGame(id)
      });
    } else {
      loadSavedGame(id);
    }
    return;
  }
  if (action === "delete-saved-game") {
    const id = button.dataset.id;
    const game = savedGames.find((item) => item.id === id);
    if (!game) return;
    askConfirm({
      title: "Удалить игру из библиотеки?",
      text: `Набор «${game.name}» будет удалён с сервера. Экспортированный JSON-файл останется у вас.`,
      confirmLabel: "Удалить игру",
      onAccept: async () => {
        const response = await SI.request(
          socket,
          "deleteGameSet",
          { id },
          { silent: true }
        );
        if (!response.ok) {
          SI.toast(response.error || "Не удалось удалить игру.", "error");
          return;
        }
        if (draft.id === id) {
          draft.id = null;
          dirty = true;
        }
        SI.toast("Игра удалена из библиотеки.", "info", 2200);
      }
    });
    return;
  }
  if (action === "confirm-cancel") {
    closeConfirm();
    return;
  }
  if (action === "confirm-accept") {
    const callback = confirmAction;
    closeConfirm();
    if (callback) await callback();
    return;
  }
  if (action === "logout") {
    sessionStorage.removeItem(EDITOR_TOKEN_KEY);
    window.location.reload();
  }
});

renderEditor();
