// Zod-схема + JSON Schema для финального verdict.
// Zod-схема — для нашей валидации после того как Claude вернул tool_use.
// JSON Schema (VERDICT_TOOL.input_schema) — это то что получает сам Claude
// в описании tool-а. Пишем JSON Schema руками (а не генерим из Zod) чтобы
// явно контролировать description'ы, которые Claude реально читает.

import { z } from 'zod';

// Один скор (1–10) + обоснование в одно концентрированное предложение
const scoreWithNote = z.object({
  score: z.number().int().min(1).max(10),
  note: z.string().min(10).max(300),
});

export const verdictSchema = z.object({
  idea_summary: z.string().min(20).max(600),
  verdict: z.enum(['go', 'pivot', 'kill']),
  scores: z.object({
    pain_severity: scoreWithNote,
    icp_clarity: scoreWithNote,
    differentiation: scoreWithNote,
    unit_economics_realistic: scoreWithNote,
    founder_market_fit: scoreWithNote,
    timing: scoreWithNote,
  }),
  top_3_risks: z.array(z.string().min(15)).length(3),
  top_3_things_to_validate: z.array(z.string().min(15)).length(3),
  kill_criteria: z.string().min(30),
});

// JSON Schema вспомогательные куски
const SCORE_WITH_NOTE = {
  type: 'object',
  properties: {
    score: { type: 'integer', minimum: 1, maximum: 10 },
    note: {
      type: 'string',
      description:
        'ODNO concrete sentence explaining why exactly this score (not one higher, not one lower). In Russian.',
    },
  },
  required: ['score', 'note'],
};

// Описание tool-а для Claude. Эти description'ы Claude реально читает
// и использует как инструкцию — формулируем их точно.
export const VERDICT_TOOL = {
  name: 'deliver_verdict',
  description:
    'Finalize evaluation of the founder\'s idea. Call this ONLY when you have enough information to give a SPECIFIC, non-generic verdict. If the answers are still vague or you have open questions — ask one more clarification instead. Every score must be specific (not "hard to say"). Risks and validation items must be concrete actions the founder can take THIS WEEK. All text fields — in Russian.',
  input_schema: {
    type: 'object',
    properties: {
      idea_summary: {
        type: 'string',
        description:
          'How you understood the core idea after reading the file and the founder\'s answers. 1-2 sentences in Russian. Be concrete — mention the specific ICP and the specific wedge.',
      },
      verdict: {
        type: 'string',
        enum: ['go', 'pivot', 'kill'],
        description:
          'go = survives pressure, worth spending week-3 interviews on. pivot = core pain is real but the solution or ICP are wrong — founder should reformulate before interviews. kill = founder should drop this and pick another idea.',
      },
      scores: {
        type: 'object',
        properties: {
          pain_severity: SCORE_WITH_NOTE,
          icp_clarity: SCORE_WITH_NOTE,
          differentiation: SCORE_WITH_NOTE,
          unit_economics_realistic: SCORE_WITH_NOTE,
          founder_market_fit: SCORE_WITH_NOTE,
          timing: SCORE_WITH_NOTE,
        },
        required: [
          'pain_severity',
          'icp_clarity',
          'differentiation',
          'unit_economics_realistic',
          'founder_market_fit',
          'timing',
        ],
      },
      top_3_risks: {
        type: 'array',
        items: { type: 'string' },
        minItems: 3,
        maxItems: 3,
        description:
          'EXACTLY 3 risks in Russian. Each — one sentence, concrete. Not "market risk" (generic), but "российские селлеры могут предпочесть бесплатные no-code решения типа X вместо платной подписки".',
      },
      top_3_things_to_validate: {
        type: 'array',
        items: { type: 'string' },
        minItems: 3,
        maxItems: 3,
        description:
          'EXACTLY 3 items in Russian. Each — a concrete, cheap action for this week: "позвонить 10 селлерам WB в категории косметики и спросить сколько часов в месяц они тратят на поддержку своих парсеров".',
      },
      kill_criteria: {
        type: 'string',
        description:
          'In Russian. What specifically in week-3 customer interviews would make this a definitive NO. Must be measurable: "если из 30 интервью меньше 8 людей скажут что они УЖЕ сейчас платят за подобное решение (не "хотели бы", а "платят") — kill".',
      },
    },
    required: [
      'idea_summary',
      'verdict',
      'scores',
      'top_3_risks',
      'top_3_things_to_validate',
      'kill_criteria',
    ],
  },
};
