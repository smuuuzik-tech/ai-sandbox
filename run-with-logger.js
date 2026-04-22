// Демо логгера — Day 5 AI-Expert-Journey
// Делает 4 разных вызова (короткий/длинный/стрим/фейл), каждый пишет в лог,
// в конце печатает агрегат. Запускай несколько раз — увидишь как лог растёт.

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { logCall, summarize, LOG_FILE_PATH } from './logger.js';

const client = new Anthropic({ maxRetries: 2, timeout: 30_000 });

// ============================================================================
// Сценарий 1 — короткий Haiku-запрос
// Самая дешёвая модель, короткий ответ. Минимальная стоимость.
// ============================================================================
async function call1_haiku_short() {
  const tStart = Date.now();
  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 50,
    messages: [{ role: 'user', content: 'Назови одно число от 1 до 100.' }],
  });
  const entry = logCall({ tag: 'haiku_short', response, tStart });
  console.log(`[1] haiku_short: "${response.content[0].text.trim()}" → $${entry.cost_usd}, ${entry.latency_ms}ms`);
}

// ============================================================================
// Сценарий 2 — длинный Sonnet-запрос
// Более дорогая модель + большой ответ. Видно разницу в cost и latency.
// ============================================================================
async function call2_sonnet_long() {
  const tStart = Date.now();
  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: 'Напиши короткое эссе (5 абзацев) о том, почему observability важна для LLM-продуктов.',
      },
    ],
  });
  const entry = logCall({ tag: 'sonnet_long', response, tStart });
  console.log(`[2] sonnet_long: ${entry.output_tokens} токенов → $${entry.cost_usd}, ${entry.latency_ms}ms`);
}

// ============================================================================
// Сценарий 3 — стрим (с метрикой ttft)
// Показывает как логируется ttft (time-to-first-token) отдельно от latency.
// ============================================================================
async function call3_stream() {
  const tStart = Date.now();
  let tFirstToken = null;

  const stream = client.messages.stream({
    model: 'claude-sonnet-4-5',
    max_tokens: 300,
    messages: [{ role: 'user', content: 'Опиши Марс в 2 абзацах по-русски.' }],
  });

  stream.on('text', () => {
    if (tFirstToken === null) tFirstToken = Date.now();
  });

  const response = await stream.finalMessage();
  const entry = logCall({ tag: 'sonnet_stream', response, tStart, tFirstToken });
  console.log(`[3] sonnet_stream: ttft=${entry.ttft_ms}ms, total=${entry.latency_ms}ms, $${entry.cost_usd}`);
}

// ============================================================================
// Сценарий 4 — фейл (неверная модель)
// Показывает что логгер умеет писать ошибки: success=false, cost=0, error={...}
// ============================================================================
async function call4_error() {
  const tStart = Date.now();
  try {
    await client.messages.create({
      model: 'claude-does-not-exist',
      max_tokens: 50,
      messages: [{ role: 'user', content: 'test' }],
    });
  } catch (err) {
    const entry = logCall({
      tag: 'fail_case',
      response: { model: 'claude-does-not-exist', usage: { input_tokens: 0, output_tokens: 0 } },
      tStart,
      success: false,
      error: err,
    });
    console.log(`[4] fail_case: ${err.status || '?'} ${err.name} → залогировано как error`);
  }
}

// ============================================================================
// Запуск и финальный агрегат
// ============================================================================
console.log('--- Прогон 4 сценариев ---\n');

await call1_haiku_short();
await call2_sonnet_long();
await call3_stream();
await call4_error();

console.log('\n--- Агрегат по всему логу (весь файл requests.jsonl) ---');
const stats = summarize();
console.log(`Всего вызовов: ${stats.total_calls} (ошибок: ${stats.errors})`);
console.log(`Суммарная стоимость: $${stats.total_cost.toFixed(6)}`);
console.log(`Input токенов: ${stats.total_input}, output: ${stats.total_output}`);
console.log(`Средняя латентность: ${stats.avg_latency_ms}ms`);
console.log('\nПо моделям:');
for (const [model, s] of Object.entries(stats.by_model)) {
  console.log(`  ${model}: ${s.calls} вызовов, $${s.cost.toFixed(6)}, ${s.input}in/${s.output}out`);
}

console.log(`\nЛог-файл: ${LOG_FILE_PATH}`);
console.log('Посмотреть сырые записи: cat logs/requests.jsonl');
