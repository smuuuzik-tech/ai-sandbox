// tool-use-multi.js — Day 3, блок 3
// Мини-агент: узнать где я → какая погода завтра здесь.
// Три tools, зависящие друг от друга: IP → локация → прогноз.
// Первый в курсе агентный цикл (while stop_reason === 'tool_use').

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

// ═══════════════════════════════════════════════════════════════
// (A) РЕАЛЬНЫЕ ФУНКЦИИ НА МОЕЙ СТОРОНЕ
// Все API бесплатные, без ключа. fetch встроен в Node 18+.
// ═══════════════════════════════════════════════════════════════

// Публичный IP. Без параметров.
async function getMyPublicIp() {
  const res = await fetch('https://api.ipify.org?format=json');
  return await res.json(); // { ip: "1.2.3.4" }
}

// Геолокация по IP. Возвращает город, координаты, таймзону + флаг прокси.
// freeipapi.com — HTTPS, без ключа, отдаёт isProxy (полезно для VPN-детекта).
async function getLocationByIp(ip) {
  const res = await fetch(`https://freeipapi.com/api/json/${ip}`);
  const data = await res.json();
  // freeipapi не имеет явного success-флага — проверяем что пришли координаты
  if (!data.latitude || !data.longitude || (data.latitude === 0 && data.longitude === 0)) {
    return { error: 'Не удалось определить координаты по IP', ip, raw: data };
  }
  return {
    ip,
    city: data.cityName,
    region: data.regionName,
    country: data.countryName,
    latitude: data.latitude,
    longitude: data.longitude,
    timezone: Array.isArray(data.timeZones) ? data.timeZones[0] : undefined,
    is_proxy: data.isProxy,  // true если IP относится к VPN/прокси-диапазону
  };
}

// Прогноз погоды по координатам. Берём ЗАВТРА (индекс 1 в daily).
async function getWeatherForecast(latitude, longitude) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', latitude);
  url.searchParams.set('longitude', longitude);
  url.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode,windspeed_10m_max');
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('forecast_days', 2);
  const res = await fetch(url);
  const data = await res.json();
  return {
    date: data.daily.time[1],                          // завтрашняя дата YYYY-MM-DD
    temp_max_c: data.daily.temperature_2m_max[1],
    temp_min_c: data.daily.temperature_2m_min[1],
    precipitation_mm: data.daily.precipitation_sum[1], // сумма осадков мм
    wind_max_kmh: data.daily.windspeed_10m_max[1],
    weathercode: data.daily.weathercode[1],            // код WMO (0=ясно, 61=дождь, 71=снег и т.д.)
    timezone: data.timezone,
  };
}

// ═══════════════════════════════════════════════════════════════
// (B) ОПИСАНИЯ TOOLS ДЛЯ CLAUDE
// Description — это «продажа» tool модели. От неё зависит,
// позовёт ли Claude его в нужный момент.
// ═══════════════════════════════════════════════════════════════

const tools = [
  {
    name: 'get_my_public_ip',
    description:
      'Возвращает публичный IP-адрес текущего клиента. Без аргументов. ' +
      'Используй первым шагом, когда нужно определить местонахождение пользователя.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_location_by_ip',
    description:
      'По IP-адресу возвращает город, регион, страну, широту, долготу и часовой пояс. ' +
      'Используй после get_my_public_ip, чтобы получить координаты пользователя.',
    input_schema: {
      type: 'object',
      properties: {
        ip: { type: 'string', description: 'IPv4-адрес, например "93.184.216.34"' },
      },
      required: ['ip'],
    },
  },
  {
    name: 'get_weather_forecast',
    description:
      'Возвращает прогноз погоды НА ЗАВТРА для координат: макс/мин температура, ' +
      'сумма осадков (мм), макс ветер, WMO-код. Используй когда известны широта и долгота.',
    input_schema: {
      type: 'object',
      properties: {
        latitude: { type: 'number', description: 'Широта в десятичных градусах, напр. 48.85' },
        longitude: { type: 'number', description: 'Долгота в десятичных градусах, напр. 2.35' },
      },
      required: ['latitude', 'longitude'],
    },
  },
];

// ═══════════════════════════════════════════════════════════════
// (C) ДИСПЕТЧЕР: имя tool → реальная функция
// Клиент-side only. Claude НЕ вызывает это — он только просит.
// ═══════════════════════════════════════════════════════════════

async function executeTool(name, input) {
  try {
    switch (name) {
      case 'get_my_public_ip':    return await getMyPublicIp();
      case 'get_location_by_ip':  return await getLocationByIp(input.ip);
      case 'get_weather_forecast':return await getWeatherForecast(input.latitude, input.longitude);
      default:                    return { error: `Неизвестный tool: ${name}` };
    }
  } catch (err) {
    // Возвращаем ошибку как валидный tool_result —
    // Claude сможет её прочитать и, например, попробовать другой подход
    return { error: String(err.message || err) };
  }
}

// ═══════════════════════════════════════════════════════════════
// (D) АГЕНТНЫЙ ЦИКЛ
// Крутимся пока stop_reason === 'tool_use'. Выходим на 'end_turn'.
// MAX_ITERATIONS — safety-лимит, чтобы не зависнуть при багах в tools.
// ═══════════════════════════════════════════════════════════════

const userQuestion = 'Узнай где я сейчас нахожусь и какая будет погода завтра в моём городе.';
console.log(`\n[Пользователь]: ${userQuestion}\n`);

const messages = [{ role: 'user', content: userQuestion }];
const MAX_ITERATIONS = 10;
let iteration = 0;
let totalIn = 0;
let totalOut = 0;

while (iteration < MAX_ITERATIONS) {
  iteration++;
  console.log(`━━━ ИТЕРАЦИЯ ${iteration} ━━━`);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    tools,
    messages,
  });

  totalIn  += response.usage.input_tokens;
  totalOut += response.usage.output_tokens;
  console.log(`stop_reason: ${response.stop_reason} | токены: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out`);

  // --- Финал: модель написала ответ и не просит ничего ---
  if (response.stop_reason === 'end_turn') {
    const finalText = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    console.log(`\n[Claude пользователю]:\n${finalText}`);
    break;
  }

  // --- Модель хочет вызвать один или несколько tools ---
  if (response.stop_reason === 'tool_use') {
    // 1. Кладём ответ ассистента в историю ЦЕЛИКОМ (там лежат tool_use блоки)
    messages.push({ role: 'assistant', content: response.content });

    // 2. Выполняем ВСЕ tool_use блоки. В этом запросе может быть один или несколько.
    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
    const toolResults = [];

    for (const block of toolUseBlocks) {
      console.log(`  → вызов: ${block.name}(${JSON.stringify(block.input)})`);
      const result = await executeTool(block.name, block.input);
      console.log(`  ← результат: ${JSON.stringify(result).slice(0, 250)}`);

      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,              // обязательная связка с запросом
        content: JSON.stringify(result),    // может быть строкой или массивом блоков
      });
    }

    // 3. Все результаты в ОДНОМ user-сообщении. Не по одному!
    messages.push({ role: 'user', content: toolResults });
    continue;
  }

  // Другие stop_reason (max_tokens, refusal и т.д.) — выходим
  console.log(`Неожиданный stop_reason: ${response.stop_reason} — выхожу`);
  break;
}

if (iteration >= MAX_ITERATIONS) {
  console.log(`\n⚠ Достигнут MAX_ITERATIONS=${MAX_ITERATIONS}. Цикл остановлен принудительно.`);
}

// ═══════════════════════════════════════════════════════════════
// (E) МЕТРИКИ
// ═══════════════════════════════════════════════════════════════

const costUSD = (totalIn / 1_000_000) * 3 + (totalOut / 1_000_000) * 15;
console.log(`\n━━━━━━━━━ ИТОГО ━━━━━━━━━`);
console.log(`Итераций цикла: ${iteration}`);
console.log(`Всего токенов: ${totalIn} in / ${totalOut} out`);
console.log(`Стоимость: $${costUSD.toFixed(6)}`);
