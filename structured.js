// Day 4 — Structured Outputs через Tool Use
// Задача: превратить сырой баг-репорт от клиента в структурированный JSON
// для передачи в баг-трекер (Linear/Jira/внутренняя система)

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import 'dotenv/config';

const client = new Anthropic();

// ===== Схема баг-репорта как tool =====
// Мы не даём Claude настоящий инструмент — мы используем tool-use
// как способ получить гарантированно валидный JSON.
// API Anthropic валидирует input по input_schema перед тем как отдать нам ответ.

const bugReportTool = {
  name: 'submit_bug_report',
  description:
    'Структурирует сырой баг-репорт от клиента в формат для баг-трекера. ' +
    'Вызывай этот инструмент всегда, когда пользователь прислал описание проблемы. ' +
    'Не отвечай текстом — только через вызов tool.',
  input_schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description:
          'Короткий заголовок тикета, 5-10 слов, в повелительном наклонении или как констатация. ' +
          'Без точки в конце. Пример: "Не приходит код подтверждения на почту"',
      },
      summary: {
        type: 'string',
        description:
          'Развёрнутый абзац 2-4 предложения: что случилось, в каком контексте. ' +
          'Пиши от третьего лица, нейтрально, без эмоций клиента.',
      },
      severity: {
        type: 'string',
        enum: ['low', 'medium', 'high', 'critical'],
        description:
          'low = косметика или неудобство. medium = функция работает криво, но есть обход. ' +
          'high = важная функция не работает, обхода нет. critical = прод лёг, платежи не идут, данные теряются.',
      },
      component: {
        type: 'string',
        enum: ['auth', 'billing', 'ui', 'api', 'performance', 'other'],
        description:
          'Компонент системы: auth = логин/регистрация/пароли, billing = оплата/подписки, ' +
          'ui = интерфейс/отображение, api = бекенд-эндпоинты, performance = скорость/зависания, other = не подходит под остальные.',
      },
      steps_to_reproduce: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 10,
        description:
          'Шаги воспроизведения, 1-10 штук. Один шаг = одно конкретное действие. ' +
          'Начинай каждый с глагола: "Открыть...", "Нажать...", "Ввести...". ' +
          'Если шаги не восстанавливаются из текста — один элемент с "Не указаны в обращении".',
      },
      expected_behavior: {
        type: 'string',
        description: 'Как должно работать по мнению клиента или по логике продукта. 1-2 предложения.',
      },
      actual_behavior: {
        type: 'string',
        description: 'Что происходит на самом деле по словам клиента. 1-2 предложения.',
      },
      environment: {
        type: ['string', 'null'],
        description:
          'Окружение: браузер, ОС, устройство, версия приложения. ' +
          'null если в обращении ничего про окружение не сказано. Не выдумывай.',
      },
      customer_quote: {
        type: ['string', 'null'],
        description:
          'Дословная цитата из обращения клиента, если есть эмоционально яркая или информативная фраза. ' +
          'null если цитировать нечего. Максимум 200 символов.',
      },
      has_enough_info: {
        type: 'boolean',
        description:
          'true если информации достаточно чтобы разработчик взял тикет в работу. ' +
          'false если критично не хватает данных (нет шагов воспроизведения, непонятно где именно ошибка и т.п.).',
      },
      missing_info: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Список уточняющих вопросов для support-агента. ' +
          'Заполняется если has_enough_info=false. Пустой массив если has_enough_info=true.',
      },
    },
    required: [
      'title',
      'summary',
      'severity',
      'component',
      'steps_to_reproduce',
      'expected_behavior',
      'actual_behavior',
      'environment',
      'customer_quote',
      'has_enough_info',
      'missing_info',
    ],
  },
};

// ===== Zod-схема: семантическая валидация на нашей стороне =====
// API Anthropic уже проверил структуру (типы, enum, required).
// Здесь мы проверяем БИЗНЕС-ПРАВИЛА — отношения между полями,
// которые API не может знать.

const BugReportSchema = z
  .object({
    // Базовые типы дублируем — защита от изменений API и для transform
    title: z
      .string()
      .min(10, 'Заголовок слишком короткий — меньше 10 символов')
      .max(120, 'Заголовок слишком длинный — больше 120 символов'),
    summary: z.string().min(20),
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    component: z.enum(['auth', 'billing', 'ui', 'api', 'performance', 'other']),
    steps_to_reproduce: z.array(z.string()).min(1).max(10),
    expected_behavior: z.string().min(5),
    actual_behavior: z.string().min(5),
    environment: z.string().nullable(),
    customer_quote: z.string().nullable(),
    has_enough_info: z.boolean(),
    missing_info: z.array(z.string()),
  })
  // .refine — это кастомные бизнес-правила поверх базовой схемы.
  // Каждый refine проверяет одно инвариантное отношение.

  // Правило 1: has_enough_info и missing_info должны быть консистентны
  .refine(
    (d) => (d.has_enough_info ? d.missing_info.length === 0 : d.missing_info.length > 0),
    {
      message:
        'Нарушена связка: has_enough_info=true требует пустой missing_info, а false — непустой',
      path: ['missing_info'],
    }
  )
  // Правило 2: critical-баги не могут быть в компоненте "other" —
  // если что-то критично сломано, мы должны знать в каком компоненте
  .refine((d) => !(d.severity === 'critical' && d.component === 'other'), {
    message:
      'Баг с severity=critical не может быть в component=other. Уточни компонент или снизь severity.',
    path: ['component'],
  })
  // Правило 3: если steps_to_reproduce содержит только заглушку,
  // то has_enough_info должен быть false — не можем воспроизвести = не хватает инфы
  .refine(
    (d) => {
      const onlyStub =
        d.steps_to_reproduce.length === 1 &&
        d.steps_to_reproduce[0].toLowerCase().includes('не указан');
      return !(onlyStub && d.has_enough_info);
    },
    {
      message:
        'Шаги воспроизведения отсутствуют (заглушка), но has_enough_info=true. Логическое противоречие.',
      path: ['has_enough_info'],
    }
  );

// ===== Функция валидации — возвращает { ok, data | errors } =====

function validateReport(rawInput) {
  // safeParse не бросает исключение, а возвращает результат —
  // удобнее для пайплайнов, где один битый тикет не должен ронять весь прогон.
  const result = BugReportSchema.safeParse(rawInput);

  if (result.success) {
    return { ok: true, data: result.data, errors: [] };
  }

  // result.error.issues — массив всех найденных проблем.
  // Каждая issue содержит path (где нарушение) и message (что сломано).
  const errors = result.error.issues.map((issue) => ({
    field: issue.path.join('.'),
    message: issue.message,
  }));

  return { ok: false, data: null, errors };
}

// ===== Пять тестовых кейсов разного типа =====
// 1. Полный баг-репорт (control, уже проверен)
// 2. Злое короткое сообщение без деталей
// 3. Технический отчёт от опытного юзера со stack trace
// 4. Спутанный рассказ с отвлечёнными деталями
// 5. Не баг вообще — запрос фичи

const testCases = [
  {
    name: '1. Полный баг-репорт',
    text: `
Здравствуйте! У меня второй день не получается оплатить подписку на PRO-план.
Захожу с айфона через сафари, жму "Оплатить", ввожу карту — и всё, кнопка крутится вечно.
На ноутбуке (chrome, макось) та же история. Карта рабочая, в других сервисах оплачиваю.
Это критично, у меня сегодня дедлайн по проекту а я без PRO не могу экспортировать в PDF.
`,
  },
  {
    name: '2. Злое короткое',
    text: `Ничего не работает!!! Верните деньги немедленно или буду писать в суд!`,
  },
  {
    name: '3. Технический со stack trace',
    text: `
При попытке загрузить файл больше 10МБ через /api/upload получаю 500.
В консоли браузера:
POST /api/upload 500 (Internal Server Error)
В Network — response body: {"error":"ECONNRESET","trace":"at TCPConnectWrap.afterConnect [as oncomplete] (net.js:1146:16)"}
Воспроизводится стабильно на файлах >10MB, на меньших всё ок.
Env: Chrome 121, macOS 14.3, app version 2.8.1
`,
  },
  {
    name: '4. Спутанный с отвлечёнными деталями',
    text: `
Добрый день. Пишу вам из Новосибирска, у нас тут снег пошёл, представляете, в апреле!
Так вот, моя собачка Тузик сегодня грызла провода, но не в этом дело.
В общем у меня какие-то проблемы с вашим приложением. Кажется когда я что-то нажимаю
ничего не происходит. Или происходит, но не то. Я вчера хотела отправить письмо жене
друга моего двоюродного брата, и вроде отправила, но он говорит не получил.
Разберитесь пожалуйста.
`,
  },
  {
    name: '5. Запрос фичи (не баг)',
    text: `
Хочу предложить добавить тёмную тему в приложение. Глаза устают вечером от яркого фона.
Также было бы круто если бы можно было настраивать шрифт. И ещё — экспорт в Markdown,
а не только в PDF. Спасибо, в остальном всё супер!
`,
  },
];

// ===== Основная функция =====

async function parseReport(caseName, rawText) {
  console.log('\n============================================================');
  console.log(`КЕЙС: ${caseName}`);
  console.log('============================================================');
  console.log('\n--- СЫРОЙ ВХОД ---');
  console.log(rawText.trim());

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 2000,
    tools: [bugReportTool],
    // tool_choice заставляет модель гарантированно вызвать именно этот tool.
    // Без него Claude может решить "ответить текстом" и structured output сломается.
    tool_choice: { type: 'tool', name: 'submit_bug_report' },
    system:
      'Ты парсер клиентских обращений в баг-трекер. ' +
      'Твоя задача — превратить сырой текст в структурированный тикет через вызов submit_bug_report. ' +
      'Не додумывай факты которых нет в обращении. Если данных не хватает — ставь null или отмечай в missing_info.',
    messages: [
      {
        role: 'user',
        content: `Структурируй это обращение клиента:\n\n${rawText}`,
      },
    ],
  });

  // Достаём блок tool_use из ответа. Он всегда один — мы форсировали его через tool_choice.
  const toolUseBlock = response.content.find((block) => block.type === 'tool_use');

  if (!toolUseBlock) {
    console.error('Claude не вызвал tool. Ответ:', JSON.stringify(response.content, null, 2));
    return null;
  }

  console.log('\n--- СТРУКТУРИРОВАННЫЙ ТИКЕТ ---');
  console.log(JSON.stringify(toolUseBlock.input, null, 2));

  // ===== Валидация =====
  const validation = validateReport(toolUseBlock.input);
  if (validation.ok) {
    console.log('\n--- ВАЛИДАЦИЯ --- ✓ прошла все правила');
  } else {
    console.log('\n--- ВАЛИДАЦИЯ --- ✗ НЕ ПРОШЛА. Нарушения:');
    for (const err of validation.errors) {
      console.log(`  • [${err.field}] ${err.message}`);
    }
  }

  const cost =
    (response.usage.input_tokens * 3 + response.usage.output_tokens * 15) / 1_000_000;
  console.log(
    `\n--- USAGE --- in: ${response.usage.input_tokens}, out: ${response.usage.output_tokens}, стоимость: $${cost.toFixed(5)}`
  );

  return {
    result: toolUseBlock.input,
    usage: response.usage,
    cost,
    valid: validation.ok,
    validationErrors: validation.errors,
  };
}

// ===== Запуск всех кейсов последовательно =====

async function runAll() {
  const results = [];
  for (const testCase of testCases) {
    const r = await parseReport(testCase.name, testCase.text);
    if (r) results.push({ name: testCase.name, ...r });
  }

  // ===== Финальная сводка =====
  console.log('\n\n============================================================');
  console.log('СВОДКА');
  console.log('============================================================');

  console.log('\n| Кейс | severity | component | has_enough_info | missing_info | valid |');
  console.log('|------|----------|-----------|-----------------|--------------|-------|');
  for (const r of results) {
    const mi = r.result.missing_info.length > 0 ? r.result.missing_info.length + ' шт' : '—';
    const v = r.valid ? '✓' : '✗';
    console.log(
      `| ${r.name} | ${r.result.severity} | ${r.result.component} | ${r.result.has_enough_info} | ${mi} | ${v} |`
    );
  }

  const validCount = results.filter((r) => r.valid).length;
  console.log(`\nПрошли валидацию: ${validCount} из ${results.length}`);

  const totalIn = results.reduce((s, r) => s + r.usage.input_tokens, 0);
  const totalOut = results.reduce((s, r) => s + r.usage.output_tokens, 0);
  const totalCost = results.reduce((s, r) => s + r.cost, 0);

  console.log(`\nВсего запросов: ${results.length}`);
  console.log(`Суммарно входных токенов: ${totalIn}`);
  console.log(`Суммарно выходных токенов: ${totalOut}`);
  console.log(`Общая стоимость: $${totalCost.toFixed(5)}`);
  console.log(`Средняя стоимость за тикет: $${(totalCost / results.length).toFixed(5)}`);
}

// ===== Демо: как ведёт себя Zod когда данные РЕАЛЬНО сломаны =====
// Никаких API-вызовов — это симуляция того, что Claude теоретически мог бы вернуть,
// если бы промахнулся. Каждый кейс нарушает одно конкретное правило.

function demoValidationFailures() {
  console.log('\n\n============================================================');
  console.log('ДЕМО FAILURE MODES — синтетические битые данные');
  console.log('============================================================');

  // База — валидный объект. Мутируем по одному полю на кейс.
  const base = {
    title: 'Баг при загрузке файла больше 10МБ',
    summary: 'Пользователь не может загрузить файл размером больше 10МБ через /api/upload',
    severity: 'high',
    component: 'api',
    steps_to_reproduce: ['Выбрать файл 15МБ', 'Нажать Upload', 'Наблюдать ошибку 500'],
    expected_behavior: 'Файл должен успешно загрузиться',
    actual_behavior: 'Сервер возвращает 500',
    environment: 'Chrome 121, macOS 14',
    customer_quote: null,
    has_enough_info: true,
    missing_info: [],
  };

  const brokenCases = [
    {
      name: 'A. Нарушение правила 1 (has_enough_info=true, а missing_info заполнен)',
      data: {
        ...base,
        has_enough_info: true,
        missing_info: ['Нужна версия приложения', 'Нужны шаги воспроизведения'],
      },
    },
    {
      name: 'B. Нарушение правила 2 (severity=critical + component=other)',
      data: { ...base, severity: 'critical', component: 'other' },
    },
    {
      name: 'C. Нарушение правила 3 (stub-шаги, но has_enough_info=true)',
      data: {
        ...base,
        steps_to_reproduce: ['Не указаны в обращении'],
        has_enough_info: true,
        missing_info: [],
      },
    },
    {
      name: 'D. Нарушение базового типа (severity не из enum)',
      data: { ...base, severity: 'blocker' }, // blocker нет в enum
    },
    {
      name: 'E. Слишком короткий title',
      data: { ...base, title: 'Баг' }, // меньше 10 символов
    },
  ];

  for (const { name, data } of brokenCases) {
    console.log(`\n→ ${name}`);
    const v = validateReport(data);
    if (v.ok) {
      console.log('  ✓ прошло (неожиданно!)');
    } else {
      console.log('  ✗ поймано:');
      for (const err of v.errors) {
        console.log(`    • [${err.field || 'root'}] ${err.message}`);
      }
    }
  }
}

runAll()
  .then(() => demoValidationFailures())
  .catch((err) => {
    console.error('Ошибка:', err.message);
    process.exit(1);
  });
