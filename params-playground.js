// params-playground.js — Day 2, блок 3
// Показываем как на ОДНОМ И ТОМ ЖЕ промпте меняются ответы от настройки параметров.
// Три эксперимента: temperature, max_tokens, stop_sequences.

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

// Одна задача — «придумай слоган для кофейни в центре города».
// Нейтральная, короткая, результат легко глазами сравнить.
const basePrompt = 'Придумай короткий слоган для кофейни в центре города. Одна строка, без объяснений.';

// Маленький хелпер чтобы не дублировать код
async function ask({ prompt, temperature = 1, max_tokens = 100, stop_sequences, system }) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens,
    temperature,
    ...(stop_sequences ? { stop_sequences } : {}),
    ...(system ? { system } : {}),
    messages: [{ role: 'user', content: prompt }],
  });
  return {
    text: response.content[0]?.text ?? '',
    stop_reason: response.stop_reason,
    in: response.usage.input_tokens,
    out: response.usage.output_tokens,
  };
}

// ─── Эксперимент 1: temperature ────────────────────────────
// Запускаем один и тот же промпт по 3 раза при temp=0, temp=0.7, temp=1.
// Смотрим: при 0 — стабильно одно и то же. При 1 — каждый раз другое.

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Эксперимент 1: TEMPERATURE (3 запуска на каждое значение)');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

for (const t of [0, 0.7, 1]) {
  console.log(`\n▶ temperature = ${t}`);
  for (let i = 1; i <= 3; i++) {
    const r = await ask({ prompt: basePrompt, temperature: t, max_tokens: 60 });
    console.log(`   ${i}. ${r.text.trim()}`);
  }
}

// ─── Эксперимент 2: max_tokens ────────────────────────────
// На одном и том же промпте с temperature=0 меняем только max_tokens.
// Ждём: 10 → обрыв (stop_reason: max_tokens). 300 → нормальный end_turn.

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Эксперимент 2: MAX_TOKENS (temperature=0, разные лимиты)');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

const longerPrompt = 'Объясни простыми словами что такое API, в 2-3 предложениях.';

for (const mt of [10, 50, 300]) {
  const r = await ask({ prompt: longerPrompt, temperature: 0, max_tokens: mt });
  console.log(`\n▶ max_tokens = ${mt}  |  stop_reason: ${r.stop_reason}  |  out: ${r.out} токенов`);
  console.log(`   "${r.text.trim()}"`);
}

// ─── Эксперимент 3: stop_sequences ────────────────────────
// Просим 5 слоганов нумерованным списком. Ставим stop на "3." —
// модель физически не сможет начать третий пункт и оборвётся.

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Эксперимент 3: STOP_SEQUENCES (обрываем на "3.")');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

const listPrompt = 'Придумай 5 слоганов для кофейни. Формат: нумерованный список "1.", "2.", "3.", "4.", "5.". Только список, без вступления.';

// Сначала БЕЗ stop_sequences — чтобы увидеть "как было бы"
const withoutStop = await ask({ prompt: listPrompt, temperature: 0, max_tokens: 300 });
console.log(`\n▶ БЕЗ stop_sequences  |  stop_reason: ${withoutStop.stop_reason}`);
console.log(withoutStop.text);

// Теперь СО stop_sequences: ['3.']
const withStop = await ask({
  prompt: listPrompt,
  temperature: 0,
  max_tokens: 300,
  stop_sequences: ['3.'],
});
console.log(`\n▶ СО stop_sequences=['3.']  |  stop_reason: ${withStop.stop_reason}`);
console.log(withStop.text);

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Готово. Сравни три эксперимента — увидишь эффект каждого параметра в чистом виде.');
