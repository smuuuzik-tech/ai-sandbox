// Integration — финал Day 5, объединяет все 5 дней AI-Expert-Journey
// в один работающий pipeline.
//
// Продуктовый кейс: обработчик сырых заметок после созвона (как Granola/Fathom/
// Notion AI). Вход — многострочный текст встречи. Выход — структурированный
// список action items с owner/priority/due_date, плюс summary, плюс алерты
// на неясные пункты.
//
// Что внутри из какого дня:
//   Day 1 — setup: dotenv, SDK, API ключ
//   Day 2 — system prompt, параметры модели (temperature, max_tokens), multi-turn
//   Day 3 — tool use (get_current_date) в agent loop
//   Day 4 — финальный structured output через tool_choice forced + Zod валидация
//   Day 5 — streaming (видим ход мысли Claude), retry на транзиентах, logger
//
// Архитектура:
//   1. Первый вызов (streaming) — Claude видит заметки, рассуждает вслух,
//      в какой-то момент решает вызвать get_current_date через tool_use.
//   2. Код выполняет tool, возвращает результат через tool_result.
//   3. Второй вызов — с tool_choice: {type:'tool', name:'submit_action_items'}
//      форсированный structured output с финальной JSON-структурой.
//   4. Zod валидирует семантику (бизнес-правила).
//   5. Всё оборачивается в withRetry + logger.

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { logCall, summarize, LOG_FILE_PATH } from './logger.js';

const client = new Anthropic({ maxRetries: 2, timeout: 30_000 });

// ============================================================================
// Входные данные — сырые заметки со встречи
// (избегаю продажных сценариев под табу; взял созвон с ментором по курсу)
// ============================================================================
const MEETING_NOTES = `
созвон с ментором по AI-курсу, 22 апреля

- обсудили MVP: надо валидировать идею на 30 интервью до 15 мая, это критично
- у меня сомнения насчёт Supabase vs Firebase, ментор сказал погуглить и сравнить до следующего созвона
- решили что pricing думать потом, сначала product — не тратить время сейчас
- я должен отправить ментору список из 10 конкурентов к пятнице
- обсудили здоровье — пора пройти чекап, давление скачет последние дни
- книга Mom Test — купить и прочитать за неделю (очень важно перед интервью)
- ментор предложил созвониться через 2 недели для синтеза
- что-то он говорил про observability стек — то ли Langfuse, то ли Helicone, не запомнил точно
`;

// ============================================================================
// Tool #1: get_current_date — Day 3 pattern
// Простейший tool: возвращает сегодняшнюю дату в ISO.
// Claude вызовет его сам когда поймёт что относительные даты («через 2 недели»,
// «к пятнице») требуют привязки к реальной сегодня.
// ============================================================================
const TOOLS = [
  {
    name: 'get_current_date',
    description:
      'Returns today\'s date in ISO 8601 format (YYYY-MM-DD) and day of week. ' +
      'Use this whenever you need to compute absolute dates from relative expressions like "in 2 weeks" or "by Friday".',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

function executeTool(name, input) {
  if (name === 'get_current_date') {
    const now = new Date();
    const iso = now.toISOString().split('T')[0];
    const dayOfWeek = now.toLocaleDateString('en-US', { weekday: 'long' });
    return { date: iso, day_of_week: dayOfWeek };
  }
  throw new Error(`Unknown tool: ${name}`);
}

// ============================================================================
// Schema финального structured output — Day 4 pattern
// Определяет форму JSON который Claude обязан вернуть.
// ============================================================================
const ACTION_ITEM_SCHEMA = {
  name: 'submit_action_items',
  description: 'Submit the structured list of action items extracted from the meeting notes.',
  input_schema: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: 'One-paragraph human-readable summary of the meeting (2-3 sentences).',
      },
      action_items: {
        type: 'array',
        description: 'List of concrete action items extracted from the notes.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short imperative title of the task.' },
            owner: {
              type: 'string',
              enum: ['me', 'mentor', 'both', 'unclear'],
              description: 'Who is responsible. "me" = the person who took notes, "mentor" = the other side.',
            },
            category: {
              type: 'string',
              enum: ['mvp', 'product', 'learning', 'health', 'admin', 'other'],
            },
            priority: {
              type: 'string',
              enum: ['critical', 'high', 'medium', 'low'],
            },
            due_date: {
              type: ['string', 'null'],
              description: 'Absolute date in YYYY-MM-DD format if a deadline is mentioned or derivable. Null otherwise.',
            },
            estimated_minutes: {
              type: ['number', 'null'],
              description: 'Rough estimate of time needed in minutes. Null if not estimable.',
            },
            notes: {
              type: ['string', 'null'],
              description: 'Additional context or caveats from the notes.',
            },
          },
          required: ['title', 'owner', 'category', 'priority', 'due_date', 'estimated_minutes', 'notes'],
        },
      },
      has_unclear_items: {
        type: 'boolean',
        description: 'True if some notes were ambiguous and the agent had to guess.',
      },
      unclear_items: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of notes that were ambiguous (e.g. "observability стек — Langfuse или Helicone, не запомнил"). Empty array if all clear.',
      },
    },
    required: ['summary', 'action_items', 'has_unclear_items', 'unclear_items'],
  },
};

// ============================================================================
// Zod schema для валидации семантики — Day 4 pattern
// API валидирует форму (типы, enum). Zod валидирует бизнес-правила.
// ============================================================================
const ActionItemZod = z.object({
  title: z.string().min(3),
  owner: z.enum(['me', 'mentor', 'both', 'unclear']),
  category: z.enum(['mvp', 'product', 'learning', 'health', 'admin', 'other']),
  priority: z.enum(['critical', 'high', 'medium', 'low']),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  estimated_minutes: z.number().positive().nullable(),
  notes: z.string().nullable(),
});

const ResultZod = z
  .object({
    summary: z.string().min(20),
    action_items: z.array(ActionItemZod).min(1),
    has_unclear_items: z.boolean(),
    unclear_items: z.array(z.string()),
  })
  // Бизнес-правило 1: связка has_unclear_items ↔ unclear_items
  .refine((d) => d.has_unclear_items === d.unclear_items.length > 0, {
    message: 'has_unclear_items должно совпадать с unclear_items.length > 0',
  })
  // Бизнес-правило 2: critical задачи обязаны иметь due_date
  .refine(
    (d) => d.action_items.filter((i) => i.priority === 'critical').every((i) => i.due_date !== null),
    {
      message: 'critical item без due_date — это противоречие',
    }
  );

// ============================================================================
// Retry wrapper — Day 5 pattern (короткая версия)
// ============================================================================
async function withRetry(fn, maxAttempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const retryable = [408, 429, 500, 502, 503, 504, 529].includes(err.status);
      if (!retryable || attempt === maxAttempts) throw err;
      const delay = 1000 * Math.pow(2, attempt - 1) * (1 + (Math.random() * 0.6 - 0.3));
      console.log(`  ⏳ retry ${attempt + 1}/${maxAttempts} через ${Math.round(delay)}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

// ============================================================================
// Шаг 1: Streaming-вызов с tools — Day 2 + Day 3 + Day 5
// Claude видит заметки, думает вслух (стримом), в какой-то момент решает
// вызвать get_current_date через tool_use.
// ============================================================================
async function step1_analyze(notes) {
  console.log('\n--- Шаг 1: Анализ и tool use (streaming) ---\n');
  const tStart = Date.now();
  let tFirstToken = null;

  const systemPrompt =
    'You are a meeting notes processor. Analyze raw notes from the user\'s meeting, ' +
    'think through the content out loud in Russian, then use get_current_date tool when you ' +
    'need to compute absolute dates from relative expressions. Keep reasoning concise.';

  const stream = client.messages.stream({
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    temperature: 0.3, // низкая температура — извлечение фактов, не креатив
    system: systemPrompt,
    tools: TOOLS,
    messages: [
      {
        role: 'user',
        content: `Here are my raw meeting notes. Analyze them and figure out what absolute date information you need:\n\n${notes}`,
      },
    ],
  });

  stream.on('text', (delta) => {
    if (tFirstToken === null) tFirstToken = Date.now();
    process.stdout.write(delta);
  });

  const response = await stream.finalMessage();
  console.log('\n');

  logCall({ tag: 'integration_step1', response, tStart, tFirstToken });
  return response;
}

// ============================================================================
// Шаг 2: Выполнение tool + продолжение диалога
// Если Claude вызвал tool — выполняем его и шлём tool_result обратно.
// Это classic agent loop pattern.
// ============================================================================
async function step2_run_tools(analyzeResponse, notes, systemPrompt) {
  const toolUseBlocks = analyzeResponse.content.filter((b) => b.type === 'tool_use');

  if (toolUseBlocks.length === 0) {
    console.log('--- Шаг 2: Пропущен (Claude не вызвал ни одного tool) ---');
    return null;
  }

  console.log(`--- Шаг 2: Выполнение ${toolUseBlocks.length} tool(s) ---\n`);

  const toolResults = toolUseBlocks.map((block) => {
    console.log(`  → Вызов: ${block.name}(${JSON.stringify(block.input)})`);
    const result = executeTool(block.name, block.input);
    console.log(`  ← Результат: ${JSON.stringify(result)}`);
    return {
      type: 'tool_result',
      tool_use_id: block.id,
      content: JSON.stringify(result),
    };
  });

  // Собираем полную историю диалога (multi-turn, Day 2)
  const messages = [
    { role: 'user', content: `Here are my raw meeting notes:\n\n${notes}` },
    { role: 'assistant', content: analyzeResponse.content },
    { role: 'user', content: toolResults },
  ];

  // Этот вызов уже не интерактивный — Claude коротко подтвердит что у него
  // есть вся нужная информация, и мы перейдём к финальному structured output.
  const tStart = Date.now();
  const response = await withRetry(() =>
    client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 300,
      temperature: 0.3,
      system: systemPrompt,
      tools: TOOLS,
      messages,
    })
  );
  logCall({ tag: 'integration_step2', response, tStart });

  console.log('');
  return { response, messages };
}

// ============================================================================
// Шаг 3: Финальный structured output — Day 4 pattern
// tool_choice forced заставляет Claude вернуть ровно ACTION_ITEM_SCHEMA.
// Никакого свободного текста, чистый JSON через tool_use block.
// ============================================================================
async function step3_extract(step2Context, notes, systemPrompt) {
  console.log('--- Шаг 3: Структурированное извлечение (forced tool) ---\n');
  const tStart = Date.now();

  const messages = step2Context
    ? [
        ...step2Context.messages,
        { role: 'assistant', content: step2Context.response.content },
        {
          role: 'user',
          content:
            'Now use the submit_action_items tool to return the final structured extraction. ' +
            'Use the current date you just retrieved to compute absolute due_date values where possible. ' +
            'Be thorough: every action item from the notes must appear.',
        },
      ]
    : [
        { role: 'user', content: `Here are my raw meeting notes:\n\n${notes}` },
        {
          role: 'user',
          content:
            'Use the submit_action_items tool to return the structured extraction. Be thorough.',
        },
      ];

  const response = await withRetry(() =>
    client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 2048,
      temperature: 0,
      system: systemPrompt,
      tools: [ACTION_ITEM_SCHEMA],
      tool_choice: { type: 'tool', name: 'submit_action_items' },
      messages,
    })
  );
  logCall({ tag: 'integration_step3', response, tStart });

  const toolUseBlock = response.content.find((b) => b.type === 'tool_use');
  return toolUseBlock.input;
}

// ============================================================================
// Main pipeline
// ============================================================================
const systemPrompt =
  'You are a meeting notes processor. Analyze raw notes from the user\'s meeting, ' +
  'think through the content out loud in Russian, then use get_current_date tool when you ' +
  'need to compute absolute dates from relative expressions. Keep reasoning concise.';

console.log('╔════════════════════════════════════════════════════════╗');
console.log('║  Integration Day 1-5: Meeting Notes → Action Items      ║');
console.log('╚════════════════════════════════════════════════════════╝');

const step1Response = await withRetry(() => step1_analyze(MEETING_NOTES));
const step2Context = await step2_run_tools(step1Response, MEETING_NOTES, systemPrompt);
const rawOutput = await step3_extract(step2Context, MEETING_NOTES, systemPrompt);

// Zod-валидация — Day 4
console.log('--- Шаг 4: Zod-валидация бизнес-правил ---\n');
const parsed = ResultZod.safeParse(rawOutput);
if (!parsed.success) {
  console.log('✗ Zod-валидация провалена:');
  console.log(parsed.error.issues);
  process.exit(1);
}
console.log('✓ Все бизнес-правила прошли\n');

// Рендер результата
const data = parsed.data;
console.log('--- Результат ---\n');
console.log(`Summary: ${data.summary}\n`);
console.log(`Action items (${data.action_items.length}):`);
data.action_items.forEach((item, i) => {
  const due = item.due_date || 'no deadline';
  const est = item.estimated_minutes ? `, ~${item.estimated_minutes}min` : '';
  console.log(`  ${i + 1}. [${item.priority.toUpperCase()}] ${item.title}`);
  console.log(`     owner: ${item.owner}, category: ${item.category}, due: ${due}${est}`);
  if (item.notes) console.log(`     note: ${item.notes}`);
});

if (data.has_unclear_items) {
  console.log(`\n⚠ Неясные пункты (${data.unclear_items.length}):`);
  data.unclear_items.forEach((item) => console.log(`  - ${item}`));
}

// Финальный cost-отчёт по всему пайплайну
console.log('\n--- Общая стоимость пайплайна (последние 3 вызова) ---');
const stats = summarize();
const recent = stats.total_cost; // весь файл лога; для чистоты можно фильтровать по tag
console.log(`Всего в логе: ${stats.total_calls} вызовов, $${stats.total_cost.toFixed(6)}`);
console.log(`Лог-файл: ${LOG_FILE_PATH}`);
