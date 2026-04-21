// Первый API-вызов к Claude — Day 1 AI-Expert-Journey
// Задача: спросить у Claude "What is 2+2?" и напечатать ответ.

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic(); // ключ автоматически читается из ANTHROPIC_API_KEY в .env

const response = await client.messages.create({
  model: 'claude-sonnet-4-5',   // модель средней мощности — хороший баланс цена/качество
  max_tokens: 1024,              // сколько максимум токенов может сгенерировать модель
  messages: [
    { role: 'user', content: 'What is 2+2? Answer in one short sentence.' }
  ]
});

console.log('--- Ответ Claude ---');
console.log(response.content[0].text);
console.log('\n--- Мета ---');
console.log('Модель:', response.model);
console.log('Input токены:', response.usage.input_tokens);
console.log('Output токены:', response.usage.output_tokens);
console.log('Stop reason:', response.stop_reason);
