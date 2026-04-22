// Error handling + retry — Day 5 AI-Expert-Journey
// Задача: понять какие ошибки бросает Anthropic SDK, какие ретраим, какие нет,
// и как встроенный retry работает. Плюс своя обёртка withRetry для иллюстрации.
//
// Категории ошибок:
//   транзиентные  — 429 rate limit, 529 overloaded, 500/502/503 server, таймауты
//                   → ретраить с exponential backoff + уважать Retry-After
//   фатальные     — 401/403 auth, 400 bad request, 404
//                   → НЕ ретраить, проблема в коде/настройках
//   обрыв стрима  — серая зона, обычно ретраим с осторожностью

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

// ============================================================================
// Конфигурация клиента с retry-политикой
// ============================================================================
// SDK умеет ретраить сам: 429/500/502/503/529 + уважает Retry-After header.
// По умолчанию maxRetries=2, timeout=60_000 ms. Увеличим для демонстрации.
const client = new Anthropic({
  maxRetries: 3,           // до 3 автоматических ретраев при транзиентных ошибках
  timeout: 30_000,         // 30 сек таймаут на один запрос
});

// ============================================================================
// Своя обёртка withRetry — чтобы видеть что происходит в логах
// ============================================================================
// SDK ретраит молча. Наша обёртка логирует каждую попытку и показывает
// механику exponential backoff + jitter наглядно.
async function withRetry(fn, { maxAttempts = 3, baseDelayMs = 1000 } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`  [попытка ${attempt}/${maxAttempts}]`);
      const result = await fn();
      if (attempt > 1) {
        console.log(`  ✓ удалось с ${attempt}-й попытки`);
      }
      return result;
    } catch (err) {
      lastError = err;

      // Классификация ошибки: ретраим или нет?
      const isTransient = isRetryableError(err);
      console.log(`  × ошибка: ${err.status || '?'} ${err.name}: ${err.message}`);

      if (!isTransient) {
        console.log(`  ✗ фатальная ошибка — не ретраим`);
        throw err;
      }

      if (attempt === maxAttempts) {
        console.log(`  ✗ исчерпаны попытки`);
        break;
      }

      // Exponential backoff with jitter:
      //   1000ms × 2^(attempt-1) × (1 ± 0.3)
      //   попытка 1: ~1000ms, 2: ~2000ms, 3: ~4000ms — с рандомным разбросом
      const exponential = baseDelayMs * Math.pow(2, attempt - 1);
      const jitter = exponential * (Math.random() * 0.6 - 0.3); // ±30%
      const delay = Math.round(exponential + jitter);

      console.log(`  ⏳ ждём ${delay}ms до следующей попытки...`);
      await sleep(delay);
    }
  }

  throw lastError;
}

// Классификатор: надо ли ретраить эту ошибку
function isRetryableError(err) {
  // Anthropic SDK бросает экземпляры Anthropic.APIError с .status (HTTP-код)
  if (!err.status) {
    // Сетевая ошибка или таймаут — обычно ретраим
    return err.name === 'APIConnectionError' || err.name === 'APIConnectionTimeoutError';
  }
  // Транзиентные HTTP-коды
  return [408, 409, 429, 500, 502, 503, 504, 529].includes(err.status);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Сценарии
// ============================================================================

// Сценарий 1: нормальный запрос — должен пройти с первой попытки
async function scenario1_success() {
  console.log('\n[Сценарий 1] Нормальный запрос');
  const response = await withRetry(() =>
    client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Скажи "привет" одним словом.' }],
    })
  );
  console.log(`  ответ: ${response.content[0].text.trim()}`);
}

// Сценарий 2: фатальная ошибка — невалидная модель
// SDK бросит 404, наш классификатор скажет «не ретраить», фейл сразу
async function scenario2_fatal() {
  console.log('\n[Сценарий 2] Фатальная ошибка (невалидная модель)');
  try {
    await withRetry(() =>
      client.messages.create({
        model: 'claude-never-existed-9000',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'тест' }],
      })
    );
  } catch (err) {
    console.log(`  итог: поймали ${err.status} ${err.name} без ретраев ✓`);
  }
}

// Сценарий 3: симуляция транзиентной ошибки с успешным восстановлением
// Первые 2 попытки падают с "429", 3-я — успех.
// Это имитирует ситуацию когда Anthropic под нагрузкой.
async function scenario3_transient_recovery() {
  console.log('\n[Сценарий 3] Транзиентная ошибка → восстановление');
  let attempts = 0;

  await withRetry(async () => {
    attempts++;
    if (attempts < 3) {
      const err = new Error('Rate limit exceeded');
      err.status = 429;
      err.name = 'RateLimitError';
      throw err;
    }
    // На 3-й попытке настоящий запрос
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 50,
      messages: [{ role: 'user', content: 'Напиши одно слово: "работает".' }],
    });
    console.log(`  ответ: ${response.content[0].text.trim()}`);
    return response;
  });
}

// Сценарий 4: демонстрация встроенного SDK retry без нашей обёртки
// SDK сам ретраит молча — видно только финальный успех/фейл.
async function scenario4_sdk_builtin() {
  console.log('\n[Сценарий 4] Встроенный SDK retry (молча)');
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 50,
      messages: [{ role: 'user', content: 'Одно слово: "ок".' }],
    });
    console.log(`  ответ: ${response.content[0].text.trim()}`);
    console.log('  SDK бы сам ретраил при 429/529/500 — нам не пришлось писать цикл');
  } catch (err) {
    console.log(`  упало даже после ретраев SDK: ${err.message}`);
  }
}

// ============================================================================
// Запускаем все сценарии по очереди
// ============================================================================
await scenario1_success();
await scenario2_fatal();
await scenario3_transient_recovery();
await scenario4_sdk_builtin();

console.log('\n--- Все сценарии пройдены ---');
