// conversation-compare.js — Day 2, блок 2 (расширение)
// Тот же multi-turn диалог, но прогоняем через три модели: Haiku / Sonnet / Opus.
// Смотрим разницу в качестве, скорости и стоимости.

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

const systemPrompt = `Ты терпеливый наставник для человека, который только переехал на macOS.
Твоя задача — помогать ему разбираться в системе пошагово.

Правила:
- Отвечай коротко, по делу. Без длинных вступлений.
- Давай одно действие за раз. Не вываливай сразу весь чеклист.
- Если пользователь говорит что-то попробовал — отталкивайся от его результата, не повторяй инструкцию.
- Используй русские названия пунктов меню, как они называются в macOS на русском.
- Если вопрос выходит за рамки Mac — честно говори «не моя зона».`;

const userTurns = [
  'Как узнать какие программы едят много памяти на моём Mac?',
  'Я открыл Activity Monitor, там куча процессов. На что смотреть?',
  'Chrome показывает 4 ГБ. Это норма или много?'
];

// Тарифы — цена за 1M токенов, актуально на апрель 2026
const MODELS = [
  { id: 'claude-haiku-4-5',   label: 'HAIKU  ', priceIn: 1,  priceOut: 5  },
  { id: 'claude-sonnet-4-5',  label: 'SONNET ', priceIn: 3,  priceOut: 15 },
  { id: 'claude-opus-4-6',    label: 'OPUS   ', priceIn: 15, priceOut: 75 },
];

// Функция — прогоняет весь сценарий через одну модель, собирает метрики и последний ответ
async function runConversation(modelId) {
  const messages = [];
  let totalIn = 0;
  let totalOut = 0;
  const t0 = Date.now();
  let lastReply = '';

  for (const userText of userTurns) {
    messages.push({ role: 'user', content: userText });

    const response = await client.messages.create({
      model: modelId,
      max_tokens: 500,
      system: systemPrompt,
      messages: messages,
    });

    const reply = response.content[0].text;
    messages.push({ role: 'assistant', content: reply });

    totalIn += response.usage.input_tokens;
    totalOut += response.usage.output_tokens;
    lastReply = reply;
  }

  const elapsedMs = Date.now() - t0;
  return { totalIn, totalOut, elapsedMs, lastReply };
}

// ─── Основной цикл по моделям ────────────────────────────
console.log('Прогоняю один и тот же 3-ходовый диалог на трёх моделях.\n');

const results = [];

for (const m of MODELS) {
  console.log(`▶ ${m.label.trim()} работает...`);
  const r = await runConversation(m.id);
  const cost = (r.totalIn / 1_000_000) * m.priceIn + (r.totalOut / 1_000_000) * m.priceOut;

  results.push({ ...m, ...r, cost });

  console.log(`   ↳ ${r.elapsedMs}ms, ${r.totalIn} in / ${r.totalOut} out, $${cost.toFixed(6)}\n`);
}

// ─── Итоговая таблица ─────────────────────────────────────
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Сравнительная таблица:');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Модель   |  Время  |  Токены in/out  |  Стоимость');
console.log('---------|---------|-----------------|-----------');
for (const r of results) {
  const time = `${r.elapsedMs}ms`.padEnd(8);
  const tokens = `${r.totalIn}/${r.totalOut}`.padEnd(16);
  const cost = `$${r.cost.toFixed(6)}`;
  console.log(`${r.label} |  ${time}|  ${tokens} |  ${cost}`);
}

// ─── Последний ответ каждой модели — смотрим разницу в стиле ────
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Последний ответ каждой модели (на «Chrome 4 ГБ — норма?»):');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
for (const r of results) {
  console.log(`\n▶ ${r.label.trim()}:`);
  console.log(r.lastReply);
}
