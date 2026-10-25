"use strict";

const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const FORMAT = "svoya-igra-custom";
const VERSION = 1;
const MAX_IMAGE_CHARS = 4_500_000;
const MAX_TOTAL_IMAGE_CHARS = 24_000_000;
const IMAGE_RE = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([a-z0-9+/=\s]+)$/i;

function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.replace(/\r\n/g, "\n").replace(/\u0000/g, "").trim().slice(0, maxLength);
}

function normalizeImage(value, totalState) {
  if (!value) return null;
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  const match = IMAGE_RE.exec(trimmed);
  if (!match) {
    throw new Error("Изображение должно быть файлом PNG, JPEG, WebP или GIF.");
  }

  const mime = match[1].toLowerCase() === "image/jpg" ? "image/jpeg" : match[1].toLowerCase();
  const base64 = match[2].replace(/\s+/g, "");
  if (base64.length > MAX_IMAGE_CHARS) {
    throw new Error("Одно изображение слишком большое. Максимум — около 3 МБ.");
  }

  totalState.imageChars += base64.length;
  if (totalState.imageChars > MAX_TOTAL_IMAGE_CHARS) {
    throw new Error("Суммарный размер изображений слишком большой. Уменьшите картинки.");
  }

  return `data:${mime};base64,${base64}`;
}

function extractCategories(input) {
  if (!input || typeof input !== "object") {
    throw new Error("Файл игры повреждён или имеет неверный формат.");
  }

  if (Array.isArray(input.categories)) {
    return input.categories;
  }

  if (Array.isArray(input.rounds) && input.rounds[0]?.themes) {
    return input.rounds[0].themes.map((theme) => ({
      name: theme.title,
      questions: theme.questions
    }));
  }

  throw new Error("В игре должна быть хотя бы одна категория с вопросами.");
}

function normalizeGameSet(input, options = {}) {
  if (!input || typeof input !== "object") {
    throw new Error("Нет данных игры.");
  }

  const name = cleanText(input.name, 100) || "Моя игра";
  const description = cleanText(input.description, 500);
  const categories = extractCategories(input);

  if (!Array.isArray(categories) || categories.length === 0) {
    throw new Error("Добавьте хотя бы одну категорию.");
  }

  const totalState = { imageChars: 0 };
  let totalQuestions = 0;

  const themes = categories.map((category, categoryIndex) => {
    const title =
      cleanText(category?.name, 80) || `Категория ${categoryIndex + 1}`;
    const rawQuestions = Array.isArray(category?.questions) ? category.questions : [];
    if (!rawQuestions.length) {
      throw new Error(`В категории «${title}» нет ни одного вопроса.`);
    }

    const questions = rawQuestions.map((question, questionIndex) => {
      const text = cleanText(question?.text, 5000);
      const answer = cleanText(question?.answer, 3000);
      const image = normalizeImage(question?.image, totalState);
      if (!text && !image) {
        throw new Error(
          `Категория «${title}», вопрос ${questionIndex + 1}: добавьте текст или изображение.`
        );
      }

      const parsedValue = Number.parseInt(question?.value, 10);
      const value =
        Number.isFinite(parsedValue) && parsedValue > 0
          ? Math.min(parsedValue, 1_000_000)
          : (questionIndex + 1) * 100;

      totalQuestions += 1;
      return { value, text, answer, image };
    });

    return { title, questions };
  });

  if (!totalQuestions) {
    throw new Error("В игре нет ни одного вопроса.");
  }

  const now = Date.now();
  return {
    id: options.id || `custom-${crypto.randomBytes(7).toString("hex")}`,
    name,
    description,
    builtin: false,
    source: "custom",
    createdAt: options.createdAt || now,
    updatedAt: options.updatedAt || now,
    rounds: [
      {
        name: "Раунд 1",
        subtitle: description || "Своя игра",
        themes
      }
    ]
  };
}

function toEditorGame(def) {
  const round = def.rounds?.[0];
  return {
    format: FORMAT,
    version: VERSION,
    name: def.name || "Моя игра",
    description: def.description || "",
    categories: (round?.themes || []).map((theme) => ({
      name: theme.title,
      questions: (theme.questions || []).map((question) => ({
        value: question.value,
        text: question.text || "",
        answer: question.answer || "",
        image: question.image || null
      }))
    }))
  };
}

function summarizeGameSet(def) {
  const rounds = Array.isArray(def.rounds) ? def.rounds : [];
  const categories = rounds[0]?.themes || [];
  const questionCount = rounds.reduce(
    (sum, round) =>
      sum +
      (round.themes || []).reduce(
        (roundSum, category) => roundSum + (category.questions?.length || 0),
        0
      ),
    0
  );
  return {
    id: def.id,
    name: def.name,
    description: def.description || "",
    builtin: Boolean(def.builtin),
    categoryCount: categories.length,
    questionCount,
    roundCount: rounds.length,
    createdAt: def.createdAt || null,
    updatedAt: def.updatedAt || null
  };
}

function imageDataForQuestion(def, roundIndex, themeIndex, questionIndex) {
  const round = def?.rounds?.[roundIndex];
  const question = round?.themes?.[themeIndex]?.questions?.[questionIndex];
  const image = question?.image;
  if (!image) return null;
  const match = IMAGE_RE.exec(image);
  if (!match) return null;
  const mime = match[1].toLowerCase() === "image/jpg" ? "image/jpeg" : match[1].toLowerCase();
  return {
    mime,
    buffer: Buffer.from(match[2].replace(/\s+/g, ""), "base64")
  };
}

async function loadCustomGames(file) {
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("Файл custom-games.json повреждён — сохранённые игры не загружены.");
    return [];
  }

  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.games) ? parsed.games : [];
  const games = [];

  for (const item of list) {
    try {
      const normalized = normalizeGameSet(item, {
        id: /^custom-[a-z0-9]+$/i.test(item?.id || "") ? item.id : undefined,
        createdAt: Number(item?.createdAt) || undefined,
        updatedAt: Number(item?.updatedAt) || undefined
      });
      games.push(normalized);
    } catch (error) {
      console.error("Пропущена сохранённая игра:", error.message);
    }
  }

  return games;
}

async function saveCustomGames(file, games) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  const data = JSON.stringify(
    {
      format: FORMAT,
      version: VERSION,
      savedAt: Date.now(),
      games
    },
    null,
    2
  );
  await fs.writeFile(temporary, data, "utf8");
  await fs.rename(temporary, file);
}

module.exports = {
  FORMAT,
  VERSION,
  normalizeGameSet,
  toEditorGame,
  summarizeGameSet,
  imageDataForQuestion,
  loadCustomGames,
  saveCustomGames
};
