// Logger — Day 5 AI-Expert-Journey
// Минимальный observability-слой: каждый вызов Claude пишется одной строкой
// в JSONL-файл. JSONL = JSON Lines: одна запись = одна строка JSON + \n.
// Почему JSONL а не CSV/обычный JSON:
//   - можно аппендить не перечитывая файл (важно для 1000+ записей)
//   - каждая строка парсится независимо (одна битая не ломает всё)
//   - jq grep читают напрямую, BigQuery/ClickHouse импортируют как есть
//   - это де-факто стандарт для LLM-логов (Langfuse/Helicone тоже так)

import fs from 'node:fs';
import path from 'node:path';

const LOG_DIR = path.join(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'requests.jsonl');

// Цены на 22.04.2026, $ за 1 млн токенов
// Обновлять когда Anthropic меняет прайс или добавляет модели
const PRICING = {
  'claude-sonnet-4-5': { input: 3,    output: 15 },
  'claude-opus-4-5':   { input: 15,   output: 75 },
  'claude-haiku-4-5':  { input: 1,    output: 5  },
  // fallback на Sonnet если модель неизвестна
  default:             { input: 3,    output: 15 },
};

function calcCost(model, usage) {
  // API возвращает точную версию модели типа claude-sonnet-4-5-20250929
  // находим совпадение по префиксу
  const key = Object.keys(PRICING).find((k) => model.startsWith(k)) || 'default';
  const { input, output } = PRICING[key];
  return (usage.input_tokens * input + usage.output_tokens * output) / 1_000_000;
}

// Главная функция: логирует один вызов.
// Принимает результат вызова Claude + мета (tag, t_start, t_first_token).
// Возвращает сформированную запись (чтобы можно было её распечатать вызывающему).
export function logCall({ tag, response, tStart, tFirstToken = null, success = true, error = null }) {
  const tEnd = Date.now();
  const usage = response?.usage || { input_tokens: 0, output_tokens: 0 };
  const model = response?.model || 'unknown';

  const entry = {
    ts: new Date().toISOString(),
    tag,
    model,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    latency_ms: tEnd - tStart,
    ttft_ms: tFirstToken ? tFirstToken - tStart : null,
    cost_usd: success ? Number(calcCost(model, usage).toFixed(6)) : 0,
    stop_reason: response?.stop_reason || null,
    success,
    error: error ? { name: error.name, message: error.message, status: error.status } : null,
  };

  // Создаём папку logs/ при первой записи
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  // Аппендим одну строку JSON + \n. Синхронно — для учебного скрипта норм,
  // в продакшене лучше асинхронная очередь с батчем.
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');

  return entry;
}

// Читает весь лог и считает агрегаты.
// В продакшене эту логику делает не код, а SQL в BigQuery/Langfuse —
// но базовую версию полезно понимать руками.
export function summarize() {
  if (!fs.existsSync(LOG_FILE)) {
    console.log('[logger] файл логов ещё не создан');
    return null;
  }

  const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
  const entries = lines.map((l) => JSON.parse(l));

  const stats = {
    total_calls: entries.length,
    total_cost: entries.reduce((s, e) => s + e.cost_usd, 0),
    total_input: entries.reduce((s, e) => s + e.input_tokens, 0),
    total_output: entries.reduce((s, e) => s + e.output_tokens, 0),
    avg_latency_ms: Math.round(
      entries.reduce((s, e) => s + e.latency_ms, 0) / entries.length
    ),
    errors: entries.filter((e) => !e.success).length,
    by_model: {},
  };

  // Разбивка по моделям (в продакшене это базовый разрез в дешборде)
  for (const e of entries) {
    if (!stats.by_model[e.model]) {
      stats.by_model[e.model] = { calls: 0, cost: 0, input: 0, output: 0 };
    }
    stats.by_model[e.model].calls += 1;
    stats.by_model[e.model].cost += e.cost_usd;
    stats.by_model[e.model].input += e.input_tokens;
    stats.by_model[e.model].output += e.output_tokens;
  }

  return stats;
}

export const LOG_FILE_PATH = LOG_FILE;
