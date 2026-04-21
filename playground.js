// Playground — сравниваем поведение моделей и параметров
// Запускай: node playground.js

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

// Утилита чтобы не дублировать код
async function ask({ label, model, max_tokens, temperature, prompt }) {
  const start = Date.now();
  const response = await client.messages.create({
    model,
    max_tokens,
    temperature,
    messages: [{ role: 'user', content: prompt }]
  });
  const ms = Date.now() - start;

  console.log('━'.repeat(60));
  console.log(`▶ ${label}`);
  console.log(`  model=${model}  max_tokens=${max_tokens}  temp=${temperature}`);
  console.log(`  latency: ${ms}ms  |  tokens: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out`);
  console.log(`  stop_reason: ${response.stop_reason}`);
  console.log('');
  console.log(response.content[0].text);
  console.log('');
}

const prompt = 'Придумай слоган для стартапа который делает AI-ассистента для продажников. Один слоган, одна строка.';

// 1. Быстрая модель Haiku — дешевле, быстрее, проще
await ask({
  label: '1. HAIKU (дешёвая, быстрая)',
  model: 'claude-haiku-4-5',
  max_tokens: 100,
  temperature: 0.7,
  prompt
});

// 2. Sonnet — баланс
await ask({
  label: '2. SONNET (баланс)',
  model: 'claude-sonnet-4-5',
  max_tokens: 100,
  temperature: 0.7,
  prompt
});

// 3. Sonnet с низкой температурой — консервативный, предсказуемый ответ
await ask({
  label: '3. SONNET + temperature=0 (консервативно)',
  model: 'claude-sonnet-4-5',
  max_tokens: 100,
  temperature: 0,
  prompt
});

// 4. Sonnet с высокой температурой — максимум креатива
await ask({
  label: '4. SONNET + temperature=1 (креативно)',
  model: 'claude-sonnet-4-5',
  max_tokens: 100,
  temperature: 1,
  prompt
});

// 5. Что будет если max_tokens=10? Обрежется на середине
await ask({
  label: '5. SONNET + max_tokens=10 (урежется)',
  model: 'claude-sonnet-4-5',
  max_tokens: 10,
  temperature: 0.7,
  prompt: 'Напиши двухпредложенческое описание что делает хороший продажник.'
});

console.log('━'.repeat(60));
console.log('Готово. Смотри внимательно:');
console.log('• Haiku обычно быстрее Sonnet в 2-3 раза');
console.log('• temp=0 даёт одинаковый ответ при повторных запусках');
console.log('• temp=1 каждый раз разный');
console.log('• max_tokens=10 → stop_reason будет "max_tokens", текст обрежется');
