// Streaming — Day 5 AI-Expert-Journey
// Задача: увидеть как ответ Claude приходит по кусочкам (Server-Sent Events)
// и напечатать его в консоль по мере генерации.
//
// Что тут происходит на уровне событий:
//   message_start        — сервер открыл сообщение (input_tokens уже есть, output=1 placeholder)
//   content_block_start  — начался блок контента (текст или tool_use)
//   content_block_delta  — кусочек текста (text_delta) или аргументов тулзы (input_json_delta)
//   content_block_stop   — блок закрыт
//   message_delta        — финальные output_tokens + stop_reason
//   message_stop         — стрим закрыт, TCP-соединение закрывается

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

// Засекаем время, чтобы увидеть разницу между «первый токен» и «последний токен»
const t0 = Date.now();
let tFirstToken = null;

// Инициируем стрим. Обрати внимание: .stream() вместо .create().
// Это другая функция SDK — она возвращает объект с async iterator и событиями.
const stream = client.messages.stream({
  model: 'claude-sonnet-4-5',
  max_tokens: 1024,
  messages: [
    {
      role: 'user',
      content: 'Объясни простыми словами что такое Server-Sent Events в 3 коротких абзацах. Пиши по-русски.',
    },
  ],
});

console.log('--- Стрим начат ---\n');

// Способ 1: подписка через .on('text', ...) — самый высокий уровень.
// SDK сам разбирает события и дёргает колбэк только с готовыми кусками текста.
// process.stdout.write (в отличие от console.log) не ставит \n — текст льётся
// сплошным потоком, как в ChatGPT или Claude.ai.
stream.on('text', (delta) => {
  if (tFirstToken === null) {
    tFirstToken = Date.now();
  }
  process.stdout.write(delta);
});

// Ждём пока стрим закроется и SDK соберёт финальное сообщение целиком.
// Только здесь мы гарантированно знаем output_tokens и можем считать стоимость.
const finalMessage = await stream.finalMessage();

const tEnd = Date.now();
const ttft = tFirstToken - t0;           // time-to-first-token, мс
const totalLatency = tEnd - t0;          // полное время запроса, мс

// Цены Sonnet 4.5 (актуально на 22.04.2026): $3/млн input, $15/млн output
const COST_INPUT = 3 / 1_000_000;
const COST_OUTPUT = 15 / 1_000_000;
const cost =
  finalMessage.usage.input_tokens * COST_INPUT +
  finalMessage.usage.output_tokens * COST_OUTPUT;

console.log('\n\n--- Мета ---');
console.log('Модель:', finalMessage.model);
console.log('Input токены:', finalMessage.usage.input_tokens);
console.log('Output токены:', finalMessage.usage.output_tokens);
console.log('Stop reason:', finalMessage.stop_reason);
console.log('Time to first token:', ttft, 'мс');
console.log('Полная латентность:', totalLatency, 'мс');
console.log('Стоимость запроса: $' + cost.toFixed(6));
