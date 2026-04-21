// tool-use-basics.js — Day 3, блок 2
// Первый tool use: один tool get_weather(city) с моковыми данными.
// Цель — руками пройти полный цикл: запрос → tool_use → выполнение → tool_result → финальный ответ.

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

// ─── (A) Реальная функция на моей стороне ────────────────────
// Claude её не исполняет — только описывает какой tool хочет вызвать.
// Возвращаем моковые данные: на этом этапе нам важна МЕХАНИКА tool use,
// а не настоящий API погоды. Это всё равно что заглушка для тестов.
function getWeather(city) {
  const mockDB = {
    'Paris':   { temp_c: 15, condition: 'облачно', wind_kmh: 12 },
    'Madrid':  { temp_c: 22, condition: 'солнечно', wind_kmh: 8 },
    'Moscow':  { temp_c: 3,  condition: 'снег',     wind_kmh: 20 },
    'Tokyo':   { temp_c: 18, condition: 'дождь',    wind_kmh: 15 },
  };
  return mockDB[city] ?? { error: `Нет данных по городу "${city}"` };
}

// ─── (B) Описание tool для Claude ────────────────────────────
// Это схема, которую Claude читает и на её основе решает: звать или нет, с какими аргументами.
// name        — имя функции (должно совпадать с тем, что ты ищешь в своём switch/map)
// description — ПРОДАВАЕМ инструмент модели. От качества зависит, позовёт ли Claude его вовремя.
// input_schema — стандартный JSON Schema: типы аргументов, обязательные поля.
const tools = [
  {
    name: 'get_weather',
    description:
      'Возвращает текущую погоду для указанного города. ' +
      'Используй когда пользователь спрашивает о погоде, температуре или условиях на улице.',
    input_schema: {
      type: 'object',
      properties: {
        city: {
          type: 'string',
          description: 'Название города на английском, например "Paris" или "Tokyo".',
        },
      },
      required: ['city'],
    },
  },
];

// ─── (C) Первый запрос: user + tools ────────────────────────
const userQuestion = 'Какая сейчас погода в Париже? Стоит ли брать зонт?';
console.log(`\n[Пользователь]: ${userQuestion}`);

const messages = [
  { role: 'user', content: userQuestion },
];

const firstResponse = await client.messages.create({
  model: 'claude-sonnet-4-5',
  max_tokens: 1024,
  tools,                          // вот тут отдаём массив описаний
  messages,
});

console.log('\n━━━ ОТВЕТ #1 ━━━');
console.log(`stop_reason: ${firstResponse.stop_reason}`);
console.log(`токенов: ${firstResponse.usage.input_tokens} in / ${firstResponse.usage.output_tokens} out`);
console.log('content blocks:', JSON.stringify(firstResponse.content, null, 2));

// ─── (D) Разбор: хочет ли Claude позвать tool? ──────────────
// Когда Claude просит tool, stop_reason === 'tool_use'
// и в content[] появляется блок { type: 'tool_use', id, name, input }.
if (firstResponse.stop_reason !== 'tool_use') {
  console.log('\nClaude ответил сразу, без tool use. Финал:');
  console.log(firstResponse.content[0].text);
  process.exit(0);
}

// Ищем блок tool_use (их может быть несколько — сегодня один)
const toolUseBlock = firstResponse.content.find((b) => b.type === 'tool_use');
console.log(`\n[Claude решил вызвать]: ${toolUseBlock.name}(${JSON.stringify(toolUseBlock.input)})`);
console.log(`tool_use_id: ${toolUseBlock.id}`);

// ─── (E) Выполняем tool на своей стороне ─────────────────────
const toolResult = getWeather(toolUseBlock.input.city);
console.log(`\n[Мой код отработал]: ${JSON.stringify(toolResult)}`);

// ─── (F) Второй запрос: отдаём Claude результат ──────────────
// ВАЖНО: ассистентский ответ из шага (C) добавляем в историю ЦЕЛИКОМ —
// Claude ожидает видеть свой же tool_use блок, чтобы связать с tool_result по id.
// tool_result идёт в роли "user" — это входные данные извне для модели.
messages.push({ role: 'assistant', content: firstResponse.content });
messages.push({
  role: 'user',
  content: [
    {
      type: 'tool_result',
      tool_use_id: toolUseBlock.id,         // ← связываем ответ с запросом
      content: JSON.stringify(toolResult),  // обычно строка; может быть массив блоков
    },
  ],
});

const secondResponse = await client.messages.create({
  model: 'claude-sonnet-4-5',
  max_tokens: 1024,
  tools,                          // tools снова отдаём — API требует их в каждом запросе цикла
  messages,
});

console.log('\n━━━ ОТВЕТ #2 (финальный) ━━━');
console.log(`stop_reason: ${secondResponse.stop_reason}`);
console.log(`токенов: ${secondResponse.usage.input_tokens} in / ${secondResponse.usage.output_tokens} out`);

const finalText = secondResponse.content
  .filter((b) => b.type === 'text')
  .map((b) => b.text)
  .join('\n');

console.log(`\n[Claude пользователю]:\n${finalText}`);

// ─── (G) Метрики ─────────────────────────────────────────────
const totalIn  = firstResponse.usage.input_tokens  + secondResponse.usage.input_tokens;
const totalOut = firstResponse.usage.output_tokens + secondResponse.usage.output_tokens;
const costUSD  = (totalIn / 1_000_000) * 3 + (totalOut / 1_000_000) * 15;

console.log('\n━━━━━━━━━ ИТОГО ЦИКЛА ━━━━━━━━━');
console.log(`Запросов к API: 2`);
console.log(`Токенов: ${totalIn} in / ${totalOut} out`);
console.log(`Стоимость: $${costUSD.toFixed(6)}`);
