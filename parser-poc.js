// parser-poc.js — мини-POC AI-парсера, Day 6 AI-Expert-Journey
//
// Что делаем:
//   1. Берём URL карточки товара (WB / Ozon / любой e-commerce)
//   2. Прогоняем через Jina Reader (https://r.jina.ai/<url>) — он рендерит JS,
//      обходит базовые защиты и отдаёт ЧИСТЫЙ markdown страницы
//   3. Скармливаем markdown в Claude через forced tool_choice — получаем
//      structured JSON с полями товара
//   4. Zod валидация + метрики: стоимость, латентность, confidence
//
// Зачем Jina Reader:
//   Ozon/WB — это SPA с тяжёлым JS. Голый fetch получит пустой HTML-скелет.
//   Jina рендерит страницу и возвращает markdown — это де-факто стандарт
//   "LLM-friendly page preview". Альтернатива — Playwright/Puppeteer (сложнее).
//   Jina без ключа: лимит 20 RPM — для POC достаточно.
//
// Что это доказывает (или нет):
//   Это тех-срез к вердикту Idea Pressure Tester. Получаем РЕАЛЬНЫЕ цифры
//   стоимости парсинга одной страницы — то чего не было в unit economics 3/10.
//   Одного прогона мало для уверенного суждения, но это datapoint.

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { logCall } from './logger.js';

// ============================================================================
// CLI
// ============================================================================
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const URL = args.url;
const MODEL = args.model || 'claude-sonnet-4-5';

if (!URL) {
  console.error(`
Использование:
  node parser-poc.js --url <URL карточки товара>

Примеры URL:
  --url https://www.wildberries.ru/catalog/<id>/detail.aspx
  --url https://www.ozon.ru/product/<slug>
  --url https://market.yandex.ru/product--<slug>/<id>

Совет: открой любой товар в браузере, скопируй URL, запусти.
`);
  process.exit(1);
}

// ============================================================================
// Zod + JSON Schema для structured extract
// ============================================================================
const productSchema = z.object({
  title: z.string(),
  brand: z.string().nullable(),
  price_rub: z.number().nullable(),
  price_original_rub: z.number().nullable(),
  discount_percent: z.number().nullable(),
  currency: z.string(),
  rating: z.number().nullable(),
  reviews_count: z.number().nullable(),
  in_stock: z.boolean(),
  seller: z.string().nullable(),
  category: z.string().nullable(),
  main_image_url: z.string().nullable(),
  key_attributes: z.array(
    z.object({ name: z.string(), value: z.string() }),
  ),
  confidence: z.number().min(0).max(1),
});

// Маленькая хитрость: просим Claude в схеме сам оценить свою confidence.
// Это НЕ заменяет внешний eval, но даёт сигнал "я в этом не уверен" — в проде
// будет гейт: если confidence < 0.5, шлём страницу на ручной review или
// второй проход через более сильную модель.
const EXTRACT_TOOL = {
  name: 'extract_product',
  description:
    'Extract product data from marketplace page markdown. NEVER invent numbers or fields that are not in the markdown. If unsure — set to null. Confidence must reflect how firmly each field is grounded in the markdown.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Product title as on page' },
      brand: { type: ['string', 'null'] },
      price_rub: {
        type: ['number', 'null'],
        description: 'Current price in rubles (number only, no symbols)',
      },
      price_original_rub: {
        type: ['number', 'null'],
        description: 'Original/crossed-out price before discount',
      },
      discount_percent: { type: ['number', 'null'] },
      currency: { type: 'string', description: 'RUB if Russian marketplace' },
      rating: { type: ['number', 'null'], description: 'Average rating 1-5' },
      reviews_count: { type: ['number', 'null'] },
      in_stock: { type: 'boolean' },
      seller: { type: ['string', 'null'] },
      category: { type: ['string', 'null'] },
      main_image_url: {
        type: ['string', 'null'],
        description: 'Main product image URL if present in markdown',
      },
      key_attributes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['name', 'value'],
        },
        description:
          'Up to 10 most important product characteristics (size, color, material, etc.)',
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description:
          'Your own 0-1 confidence that the extracted data is correct. 1.0 = every field directly present in markdown. 0.5 = some fields inferred from context. 0.2 = many fields null or content looks like noise.',
      },
    },
    required: ['title', 'in_stock', 'key_attributes', 'confidence', 'currency'],
  },
};

// ============================================================================
// 1. Jina Reader fetch
// ============================================================================
console.log(`\n═══ AI-парсер POC ═══`);
console.log(`  URL:   ${URL}`);
console.log(`  Model: ${MODEL}\n`);

const jinaUrl = `https://r.jina.ai/${URL}`;
console.log(`[1/2] Jina Reader fetch...`);
const t0 = Date.now();

let markdown;
try {
  const res = await fetch(jinaUrl);
  if (!res.ok) {
    console.error(`  [!] Jina вернула ${res.status} ${res.statusText}`);
    console.error(`      Частые причины: rate limit (20 RPM без ключа), region block, invalid URL.`);
    process.exit(1);
  }
  markdown = await res.text();
} catch (err) {
  console.error(`  [!] Fetch error: ${err.message}`);
  process.exit(1);
}

const jinaMs = Date.now() - t0;
console.log(`  ✓ получено ${markdown.length.toLocaleString()} символов за ${jinaMs} ms`);

// Обрезка чтобы не палить токены на длинные "подвальные" блоки
const MAX_MD = 30000;
let markdownForClaude = markdown;
if (markdown.length > MAX_MD) {
  markdownForClaude = markdown.slice(0, MAX_MD);
  console.log(
    `  ⚠ обрезаю до первых ${MAX_MD.toLocaleString()} симв. (исходно ${markdown.length.toLocaleString()})`,
  );
}

// ============================================================================
// 2. Claude structured extract
// ============================================================================
console.log(`\n[2/2] Claude extract (forced tool_choice)...`);
const client = new Anthropic();
const tStart = Date.now();

const response = await client.messages.create({
  model: MODEL,
  max_tokens: 2048,
  temperature: 0, // детерминированный extract
  tools: [EXTRACT_TOOL],
  tool_choice: { type: 'tool', name: 'extract_product' },
  messages: [
    {
      role: 'user',
      content: `Extract product data from this marketplace page markdown. Do not invent data. If a field is unclear or missing — set to null.\n\n<markdown>\n${markdownForClaude}\n</markdown>`,
    },
  ],
});

const logEntry = logCall({ tag: 'parser-poc', response, tStart });

const toolUse = response.content.find((c) => c.type === 'tool_use');
if (!toolUse) {
  console.error(`  [!] Claude не вызвал tool. stop_reason: ${response.stop_reason}`);
  process.exit(1);
}

const parsed = productSchema.safeParse(toolUse.input);
const extracted = parsed.success ? parsed.data : toolUse.input;

console.log(`  ✓ извлечено за ${logEntry.latency_ms} ms`);
if (!parsed.success) {
  console.log(`  ⚠ Zod нашёл расхождения (показываю сырые данные):`);
  parsed.error.issues.forEach((i) =>
    console.log(`    - ${i.path.join('.')}: ${i.message}`),
  );
}

// ============================================================================
// 3. Красивый вывод
// ============================================================================
const line = (l, v) => console.log(`  ${l.padEnd(22)} ${v ?? '—'}`);

console.log(`\n═══ ИЗВЛЕЧЕНО ═══`);
line('Title', extracted.title);
line('Brand', extracted.brand);
line('Price (RUB)', extracted.price_rub);
line('Original (RUB)', extracted.price_original_rub);
line('Discount', extracted.discount_percent ? `${extracted.discount_percent}%` : null);
line('Rating', extracted.rating);
line('Reviews', extracted.reviews_count);
line('In stock', extracted.in_stock);
line('Seller', extracted.seller);
line('Category', extracted.category);
line(
  'Confidence',
  extracted.confidence != null ? `${(extracted.confidence * 100).toFixed(0)}%` : null,
);

if (extracted.key_attributes && extracted.key_attributes.length) {
  console.log(`\n  Key attributes:`);
  extracted.key_attributes.slice(0, 10).forEach((a) =>
    console.log(`    - ${a.name}: ${a.value}`),
  );
}

console.log(`\n═══ МЕТРИКИ ═══`);
console.log(`  Jina Reader:       ${jinaMs} ms, ${markdown.length.toLocaleString()} chars`);
console.log(`  Claude:            ${logEntry.latency_ms} ms`);
console.log(`  Input tokens:      ${logEntry.input_tokens.toLocaleString()}`);
console.log(`  Output tokens:     ${logEntry.output_tokens.toLocaleString()}`);
console.log(`  Cost 1 req:        $${logEntry.cost_usd.toFixed(6)}`);
console.log(`  Cost ×1 000:       $${(logEntry.cost_usd * 1000).toFixed(2)}`);
console.log(`  Cost ×100 000:     $${(logEntry.cost_usd * 100000).toFixed(0)}`);

// ============================================================================
// 4. Сохраняем артефакт
// ============================================================================
const outputDir = path.join(process.cwd(), 'output');
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
const outputFile = path.join(outputDir, `parser-poc-${Date.now()}.json`);
fs.writeFileSync(
  outputFile,
  JSON.stringify(
    {
      url: URL,
      model: MODEL,
      timestamp: new Date().toISOString(),
      extracted,
      metrics: {
        jina_ms: jinaMs,
        jina_chars: markdown.length,
        claude_latency_ms: logEntry.latency_ms,
        input_tokens: logEntry.input_tokens,
        output_tokens: logEntry.output_tokens,
        cost_usd: logEntry.cost_usd,
        zod_valid: parsed.success,
        zod_issues: parsed.success
          ? []
          : parsed.error.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
      },
    },
    null,
    2,
  ),
);

console.log(`\n[лог] JSON → ${outputFile}`);
