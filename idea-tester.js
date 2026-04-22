// Idea Pressure Tester — Day 6 AI-Expert-Journey
//
// Что это:
//   CLI-агент который играет роль инвестора-скептика. Читает файл с идеей,
//   задаёт уточняющие вопросы (интерактивно в терминал, максимум 5), и в конце
//   выдаёт structured verdict по 6 критериям + топ-3 риска + kill criteria.
//
// Что из пройденного используем:
//   Day 2 — system prompt (promptes/investor-skeptic.js), temperature=0.3
//   Day 3 — tool use: 3 tool'а в параллельном выборе (read_idea, ask_clarification, deliver_verdict)
//   Day 3 + D10 предвкушение — AGENT LOOP: while-цикл крутится пока не вызвали deliver_verdict
//   Day 4 — forced structured output через дескрипшены tool'а + Zod-валидация tool input
//   Day 5 — withRetry (локально, как в integration.js), logCall из logger.js
//
// Чего НЕТ (специально, для ограничения скоупа):
//   — streaming (в agent loop без него проще; промежуточный текст Claude мы всё равно выводим)
//   — параллельные tool_uses в одной итерации (Claude может их делать, мы обрабатываем все
//     подряд, но для ask_clarification force одно-на-одно чтобы юзер не путался)
//   — restart при упавшем verdict-валидаторе больше одного раза (надёжности ради —
//     только одна попытка корректировки schema, дальше падаем)

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { logCall } from './logger.js';
import { INVESTOR_SKEPTIC_PROMPT } from './prompts/investor-skeptic.js';
import { VERDICT_TOOL, verdictSchema } from './schemas/verdict.js';

// ============================================================================
// CLI парсинг — минимальный, без внешних зависимостей
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
const IDEA_PATH = args.idea || 'ideas/ai-parser.md';
const MAX_CLARIFICATIONS = Number(args.depth) || 5;
const MAX_TOTAL_ITERATIONS = 20; // hard safety против бесконечного цикла
const MODEL = args.model || 'claude-sonnet-4-5';

// ============================================================================
// withRetry — локальная копия паттерна из integration.js
// Зачем не импорт: errors.js не экспортирует withRetry (был учебный).
// Для Day 6 проще скопировать, чем рефакторить errors.js.
// ============================================================================
async function withRetry(fn, maxAttempts = 3) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const retryable = [408, 429, 500, 502, 503, 504, 529].includes(err.status);
      if (!retryable || attempt === maxAttempts - 1) throw err;
      const delay = 1000 * Math.pow(2, attempt) * (0.7 + Math.random() * 0.6);
      console.log(`  [retry ${attempt + 2}/${maxAttempts} через ${Math.round(delay)}ms]`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ============================================================================
// Tool definitions — массив что получает Claude
// ============================================================================
function buildTools() {
  return [
    {
      name: 'read_idea',
      description:
        'Read the markdown file with the founder\'s idea description. Call this first, before anything else.',
      input_schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the markdown file, relative to cwd.',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'ask_clarification',
      description: `Ask the founder ONE sharp clarifying question to close a specific gap before giving a verdict. Follow Mom Test discipline: ask about past behavior, specific names, concrete numbers. AVOID hypothetical "would you" questions. Budget: maximum ${MAX_CLARIFICATIONS} clarifications across the whole session. Use them only on questions whose answer would materially change the verdict.`,
      input_schema: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description:
              'The clarifying question in Russian. One question. Specific. About past behavior or verifiable facts.',
          },
        },
        required: ['question'],
      },
    },
    VERDICT_TOOL,
  ];
}

// ============================================================================
// Tool handlers — что делает наш код когда Claude вызывает tool
// ============================================================================
function handleReadIdea(input) {
  const filePath = path.resolve(process.cwd(), input.path);
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return { ok: true, content };
  } catch (err) {
    return { ok: false, error: `Failed to read ${filePath}: ${err.message}` };
  }
}

async function handleAskClarification(input, roundNum, rl) {
  console.log(`\n┌─ Вопрос ${roundNum}/${MAX_CLARIFICATIONS} ─────────────────────────`);
  console.log(`│ ${input.question}`);
  console.log(`└──────────────────────────────────────────────\n`);
  const answer = await rl.question('Твой ответ (Enter для завершения): ');
  return { answer: answer.trim() || '(нет ответа)' };
}

// ============================================================================
// Красивый вывод финального verdict в терминал
// ============================================================================
function printVerdict(v) {
  const divider = '═'.repeat(64);
  console.log(`\n${divider}`);
  console.log(`  ВЕРДИКТ: ${v.verdict.toUpperCase()}`);
  console.log(divider);
  console.log(`\n${v.idea_summary}\n`);

  console.log(`─── Оценки (1–10) ───────────────────────────────────────────`);
  const labels = {
    pain_severity: 'Острота боли',
    icp_clarity: 'Чёткость ICP',
    differentiation: 'Дифференциация',
    unit_economics_realistic: 'Unit economics',
    founder_market_fit: 'Founder–market fit',
    timing: 'Timing',
  };
  for (const [k, s] of Object.entries(v.scores)) {
    const label = (labels[k] || k).padEnd(22);
    console.log(`  ${label} ${String(s.score).padStart(2)}/10  — ${s.note}`);
  }

  console.log(`\n─── Топ-3 риска ─────────────────────────────────────────────`);
  v.top_3_risks.forEach((r, i) => console.log(`  ${i + 1}. ${r}`));

  console.log(`\n─── Что валидировать в первую очередь ───────────────────────`);
  v.top_3_things_to_validate.forEach((r, i) => console.log(`  ${i + 1}. ${r}`));

  console.log(`\n─── Kill criteria ───────────────────────────────────────────`);
  console.log(`  ${v.kill_criteria}\n`);
}

// ============================================================================
// AGENT LOOP — основная механика
// ============================================================================
async function runAgent() {
  const client = new Anthropic();
  const rl = readline.createInterface({ input, output });

  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║     Idea Pressure Tester  (Day 6)           ║`);
  console.log(`╚══════════════════════════════════════════════╝`);
  console.log(`  Идея: ${IDEA_PATH}`);
  console.log(`  Макс уточнений: ${MAX_CLARIFICATIONS}`);
  console.log(`  Модель: ${MODEL}\n`);

  const tools = buildTools();
  const messages = [
    {
      role: 'user',
      content: `Оцени идею из файла \`${IDEA_PATH}\`. Прочитай файл, задавай уточнения если нужно (максимум ${MAX_CLARIFICATIONS}), затем дай вердикт. Все вопросы и финальный вердикт — по-русски.`,
    },
  ];

  let clarificationCount = 0;
  let verdict = null;
  let totalIterations = 0;
  let verdictRetried = false;

  try {
    while (!verdict && totalIterations < MAX_TOTAL_ITERATIONS) {
      totalIterations++;

      const tStart = Date.now();
      const response = await withRetry(() =>
        client.messages.create({
          model: MODEL,
          max_tokens: 4096,
          temperature: 0.3, // чуть вариативности в вопросах, но сдержанно
          system: INVESTOR_SKEPTIC_PROMPT,
          tools,
          messages,
        }),
      );
      logCall({ tag: `idea-tester_iter${totalIterations}`, response, tStart });

      // добавляем assistant turn в историю как есть
      messages.push({ role: 'assistant', content: response.content });

      // вывод промежуточного текста (если Claude рассуждал перед tool_use)
      const textBlocks = response.content.filter((c) => c.type === 'text');
      for (const tb of textBlocks) {
        if (tb.text.trim()) console.log(`\n[скептик]: ${tb.text.trim()}`);
      }

      // обработка tool_use блоков
      const toolUses = response.content.filter((c) => c.type === 'tool_use');
      if (toolUses.length === 0) {
        console.log(`\n[!] Claude не вызвал tool. stop_reason: ${response.stop_reason}. Прерываемся.`);
        break;
      }

      const toolResults = [];
      for (const tu of toolUses) {
        if (tu.name === 'read_idea') {
          const r = handleReadIdea(tu.input);
          console.log(`  • read_idea(${tu.input.path}) → ${r.ok ? 'ok' : 'ERROR'}`);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: r.ok ? r.content : r.error,
            is_error: !r.ok,
          });
        } else if (tu.name === 'ask_clarification') {
          clarificationCount++;
          const r = await handleAskClarification(tu.input, clarificationCount, rl);
          let resultContent = r.answer;
          // если бюджет исчерпан — говорим Claude явно
          if (clarificationCount >= MAX_CLARIFICATIONS) {
            resultContent += `\n\n[SYSTEM NOTE: это был последний вопрос из ${MAX_CLARIFICATIONS}. Следующий шаг — deliver_verdict.]`;
          }
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: resultContent,
          });
        } else if (tu.name === 'deliver_verdict') {
          const parsed = verdictSchema.safeParse(tu.input);
          if (parsed.success) {
            verdict = parsed.data;
            toolResults.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: 'Verdict accepted.',
            });
          } else {
            // одна попытка дать Claude исправиться
            const issues = parsed.error.issues.map(
              (i) => `${i.path.join('.')}: ${i.message}`,
            );
            console.log(`\n[!] Verdict не прошёл Zod-валидацию:\n  ${issues.join('\n  ')}`);
            if (verdictRetried) {
              console.log(`[!] Уже пробовали — сохраняем как есть с пометкой.`);
              verdict = { ...tu.input, _validation_failed: issues };
              toolResults.push({
                type: 'tool_result',
                tool_use_id: tu.id,
                content: 'Accepted despite validation issues.',
              });
            } else {
              verdictRetried = true;
              toolResults.push({
                type: 'tool_result',
                tool_use_id: tu.id,
                content: `Verdict failed validation. Issues:\n${issues.join('\n')}\nPlease retry with corrected fields.`,
                is_error: true,
              });
            }
          }
        } else {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: `Unknown tool: ${tu.name}`,
            is_error: true,
          });
        }
      }

      // пушим tool_results обратно в историю как один user turn
      messages.push({ role: 'user', content: toolResults });
    }

    if (!verdict) {
      console.log(`\n[!] Вердикт не получен за ${totalIterations} итераций. Выход.`);
      return;
    }

    printVerdict(verdict);

    // сохраняем полный JSON прогона
    const outputDir = path.join(process.cwd(), 'output');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const outputFile = path.join(
      outputDir,
      `idea-test-${Date.now()}.json`,
    );
    fs.writeFileSync(
      outputFile,
      JSON.stringify(
        {
          idea_path: IDEA_PATH,
          model: MODEL,
          generated_at: new Date().toISOString(),
          clarifications_used: clarificationCount,
          iterations: totalIterations,
          verdict,
        },
        null,
        2,
      ),
    );
    console.log(`[лог] полный JSON → ${outputFile}`);
  } finally {
    rl.close();
  }
}

runAgent().catch((err) => {
  console.error(`\n[FATAL]`, err);
  process.exit(1);
});
