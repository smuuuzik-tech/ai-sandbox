// conversation.js — Day 2, блок 2
// Multi-turn диалог с Claude. System prompt в стиле Khanmigo (наставник).
// Тема: AI-наставник для человека, только что переехавшего на macOS.

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

// ─── System prompt ──────────────────────────────────────────
// Три обязательных части: кто ты / что делаешь / как
const systemPrompt = `Ты терпеливый наставник для человека, который только переехал на macOS.
Твоя задача — помогать ему разбираться в системе пошагово.

Правила:
- Отвечай коротко, по делу. Без длинных вступлений.
- Давай одно действие за раз. Не вываливай сразу весь чеклист.
- Если пользователь говорит что-то попробовал — отталкивайся от его результата, не повторяй инструкцию.
- Используй русские названия пунктов меню, как они называются в macOS на русском.
- Если вопрос выходит за рамки Mac — честно говори «не моя зона».`;

// ─── Реплики пользователя ──────────────────────────────────
// Это наш "сценарий" — 3 последовательных хода
const userTurns = [
  'Как узнать какие программы едят много памяти на моём Mac?',
  'Я открыл Activity Monitor, там куча процессов. На что смотреть?',
  'Chrome показывает 4 ГБ. Это норма или много?'
];

// ─── Главный multi-turn цикл ──────────────────────────────
const messages = [];              // живая история разговора, растёт по ходу
let totalInput = 0;
let totalOutput = 0;
const startTime = Date.now();

for (let i = 0; i < userTurns.length; i++) {
  // (1) Добавляем очередной вопрос пользователя в историю
  messages.push({ role: 'user', content: userTurns[i] });

  console.log(`\n━━━ ХОД ${i + 1} ━━━`);
  console.log(`[Пользователь]: ${userTurns[i]}`);

  // (2) Зовём API — передаём системный промпт и ВСЮ накопленную историю
  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 500,
    system: systemPrompt,
    messages: messages,           // именно весь массив, не только свежий вопрос
  });

  // (3) Достаём текст ответа
  const assistantReply = response.content[0].text;

  console.log(`\n[Claude]: ${assistantReply}`);
  console.log(
    `   ↳ токенов: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out  ` +
    `|  stop_reason: ${response.stop_reason}`
  );

  // (4) Дописываем ответ модели в историю — чтобы на следующем ходе она его помнила
  messages.push({ role: 'assistant', content: assistantReply });

  // (5) Аккумулируем метрики
  totalInput += response.usage.input_tokens;
  totalOutput += response.usage.output_tokens;
}

// ─── Итоговые метрики ──────────────────────────────────────
const elapsedMs = Date.now() - startTime;
const PRICE_INPUT = 3;            // Sonnet 4.5: $3 за 1M input-токенов
const PRICE_OUTPUT = 15;          // Sonnet 4.5: $15 за 1M output-токенов
const costUSD = (totalInput / 1_000_000) * PRICE_INPUT + (totalOutput / 1_000_000) * PRICE_OUTPUT;

console.log('\n━━━━━━━━━━━━━ ИТОГО ━━━━━━━━━━━━━');
console.log(`Ходов: ${userTurns.length}`);
console.log(`Токенов: ${totalInput} in / ${totalOutput} out`);
console.log(`Время:   ${elapsedMs} ms`);
console.log(`Стоимость разговора: $${costUSD.toFixed(6)}`);
