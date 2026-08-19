const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const port = process.env.PORT || 10000;

app.use(express.json());

function cleanKey(key) {
  if (!key) return null;
  return key.trim().replace(/^["']|["']$/g, '');
}

function getCleanKeys(prefix) {
  return Object.keys(process.env)
    .filter(k => k.startsWith(prefix))
    .map(k => ({ name: k, value: cleanKey(process.env[k]) }))
    .filter(item => item.value && item.value.length > 10);
}

function sanitizeAIOutput(text) {
  if (!text) return '';
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

app.get('/', (req, res) => {
  res.json({ 
    status: 'ONLINE', 
    system: 'GÉNESIS Core v4.2 — Corrected JARVIS Architecture',
    tools: ['CoinGecko Financial API', 'Open-Meteo Satellite Weather', 'Extended Supabase Memory', 'System Clock']
  });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// --- MÓDULO SUPABASE REST (MEMORIA AMPLIADA) ---
async function saveMessage(userId, role, content) {
  const url = cleanKey(process.env.SUPABASE_URL);
  const key = cleanKey(process.env.SUPABASE_ANON_KEY);
  if (!url || !key) return;

  try {
    await fetch(`${url}/rest/v1/chat_history`, {
      method: 'POST',
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ user_id: String(userId), role, content })
    });
  } catch (e) {
    console.warn('⚠️ Error guardando en Supabase:', e.message);
  }
}

async function getRecentHistory(userId, limit = 25) {
  const url = cleanKey(process.env.SUPABASE_URL);
  const key = cleanKey(process.env.SUPABASE_ANON_KEY);
  if (!url || !key) return [];

  try {
    const res = await fetch(`${url}/rest/v1/chat_history?user_id=eq.${userId}&order=created_at.desc&limit=${limit}`, {
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`
      }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.reverse();
  } catch (e) {
    return [];
  }
}

// --- HERRAMIENTAS DIRECTAS Y PRECISAS ---
function toolGetDateTime() {
  const now = new Date();
  const options = { 
    timeZone: 'America/Mexico_City',
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', 
    hour: '2-digit', minute: '2-digit'
  };
  return `[HERRAMIENTA HORA/FECHA]: Hora exacta en México: ${now.toLocaleDateString('es-MX', options)}`;
}

async function toolGetCryptoPrice(query) {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,tether&vs_currencies=usd,mxn&include_24hr_change=true');
    const data = await res.json();
    
    return `[HERRAMIENTA FINANCIERA EN VIVO]:
• Bitcoin (BTC): $${data.bitcoin.usd.toLocaleString()} USD ($${data.bitcoin.mxn.toLocaleString()} MXN) | Cambio 24h: ${data.bitcoin.usd_24h_change.toFixed(2)}%
• Ethereum (ETH): $${data.ethereum.usd.toLocaleString()} USD ($${data.ethereum.mxn.toLocaleString()} MXN)
• Solana (SOL): $${data.solana.usd.toLocaleString()} USD ($${data.solana.mxn.toLocaleString()} MXN)`;
  } catch (e) {
    return `[HERRAMIENTA FINANCIERA]: No se pudo obtener la cotización en tiempo real.`;
  }
}

async function toolGetWeather(userPrompt) {
  try {
    // Extracción limpia del nombre de la ciudad
    let city = 'Monterrey';
    const match = userPrompt.match(/(?:clima|tiempo|temperatura)\s+(?:en|de|para)?\s*([a-záéíóúñ\s,]+)/i);
    if (match && match[1]) {
      city = match[1].replace(/y\s+que\s+hora.*/i, '').trim();
    }

    const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=es&format=json`);
    const geoData = await geoRes.json();
    
    if (!geoData.results || geoData.results.length === 0) {
      return `[HERRAMIENTA CLIMA]: No se encontraron coordenadas exactas para "${city}".`;
    }

    const { latitude, longitude, name, admin1, country } = geoData.results[0];
    const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true&timezone=auto`);
    const weatherData = await weatherRes.json();
    const cur = weatherData.current_weather;

    return `[HERRAMIENTA CLIMA EN VIVO]:
Ubicación: ${name}, ${admin1 || ''}, ${country}
Temperatura actual: ${cur.temperature}°C
Velocidad del viento: ${cur.windspeed} km/h`;
  } catch (e) {
    return `[HERRAMIENTA CLIMA]: Error al consultar servicio meteorológico.`;
  }
}

async function executeAgentTools(userPrompt) {
  const lower = userPrompt.toLowerCase();
  const toolOutputs = [];

  // 1. Reloj del sistema
  if (lower.includes('hora') || lower.includes('fecha') || lower.includes('día') || lower.includes('dia')) {
    toolOutputs.push(toolGetDateTime());
  }

  // 2. Cotización de Criptomonedas / Bitcoin
  if (lower.includes('bitcoin') || lower.includes('btc') || lower.includes('crypto') || lower.includes('cripto') || lower.includes('precio')) {
    const cryptoData = await toolGetCryptoPrice(userPrompt);
    toolOutputs.push(cryptoData);
  }

  // 3. Clima Satelital
  if (lower.includes('clima') || lower.includes('tiempo') || lower.includes('temperatura') || lower.includes('llover') || lower.includes('lluvia')) {
    const weatherData = await toolGetWeather(userPrompt);
    toolOutputs.push(weatherData);
  }

  return toolOutputs.length > 0 ? toolOutputs.join('\n\n') : null;
}

// --- GENERACIÓN DE RESPUESTA ---
async function callGroqDynamic(apiKey, messages) {
  const modelsRes = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { 'Authorization': `Bearer ${apiKey}` }
  });
  const modelsData = await modelsRes.json();
  if (!modelsRes.ok) throw new Error('Error Groq Auth');

  const availableModels = (modelsData.data || []).map(m => m.id);
  for (const modelId of availableModels) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId, messages })
      });
      const data = await res.json();
      if (res.ok && data.choices?.[0]?.message?.content) {
        return sanitizeAIOutput(data.choices[0].message.content);
      }
    } catch (e) {}
  }
  throw new Error('Groq no disponible');
}

async function callGeminiDynamic(apiKey, promptText) {
  const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
  const modelsRes = await fetch(listUrl);
  const modelsData = await modelsRes.json();
  if (!modelsRes.ok) throw new Error('Error Gemini Auth');

  const validModels = (modelsData.models || [])
    .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
    .map(m => m.name);

  for (const modelName of validModels) {
    try {
      const genUrl = `https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent?key=${apiKey}`;
      const res = await fetch(genUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: promptText }] }] })
      });
      const data = await res.json();
      if (res.ok && data.candidates?.[0]?.content?.parts?.[0]?.text) {
        return sanitizeAIOutput(data.candidates[0].content.parts[0].text);
      }
    } catch (e) {}
  }
  throw new Error('Gemini no disponible');
}

async function generateAIResponseWithMemory(userId, newPrompt) {
  // 1. Ejecutar herramientas directas
  const liveToolData = await executeAgentTools(newPrompt);

  // 2. Obtener un historial más amplio (hasta 25 mensajes)
  const history = await getRecentHistory(userId, 25);

  const systemMessage = { 
    role: 'system', 
    content: `Eres GÉNESIS, una Inteligencia Artificial Avanzada inspirada en JARVIS.
Directrices de respuesta:
- Háblale al usuario llamándolo "Señor". Mantén una personalidad atenta, profesional y precisa.
- Si dispones de [DATOS DE HERRAMIENTAS EN TIEMPO REAL], preséntalos directamente con números claros. Jamás digas que no tienes acceso a la información si la herramienta te la proporcionó.
- Revisa meticulosamente el historial de mensajes anterior para recordar datos personales expresados previamente por el usuario (gustos, preferencias, nombre, etc.).

${liveToolData ? `\n[DATOS OBTENIDOS POR LAS HERRAMIENTAS EN TIEMPO REAL]:\n${liveToolData}\n` : ''}`
  };

  const messages = [
    systemMessage,
    ...history.map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content })),
    { role: 'user', content: newPrompt }
  ];

  const fullPromptGemini = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');

  const groqKeys = getCleanKeys('GROQ_API_KEY');
  const geminiKeys = getCleanKeys('GEMINI_API_KEY');

  let reply = null;

  for (const k of groqKeys) {
    try { reply = await callGroqDynamic(k.value, messages); if (reply) break; } catch (e) {}
  }

  if (!reply) {
    for (const k of geminiKeys) {
      try { reply = await callGeminiDynamic(k.value, fullPromptGemini); if (reply) break; } catch (e) {}
    }
  }

  if (!reply) throw new Error('No se pudo establecer comunicación con el núcleo de IA.');

  // Guardar en Supabase
  await saveMessage(userId, 'user', newPrompt);
  await saveMessage(userId, 'assistant', reply);

  return reply;
}

// --- TELEGRAM BOT POLL ---
let telegramOffset = 0;
async function pollTelegram() {
  const token = cleanKey(process.env.TELEGRAM_BOT_TOKEN);
  if (!token) { setTimeout(pollTelegram, 5000); return; }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=${telegramOffset}&timeout=10`);
    const data = await res.json();

    if (data.ok && data.result?.length > 0) {
      for (const update of data.result) {
        telegramOffset = update.update_id + 1;
        if (update.message?.text) {
          const chatId = update.message.chat.id;
          const userText = update.message.text;

          fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, action: 'typing' })
          }).catch(() => {});

          try {
            const reply = await generateAIResponseWithMemory(`telegram_${chatId}`, userText);
            await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: chatId, text: reply })
            });
          } catch (err) {
            await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: chatId, text: `⚠️ ${err.message}` })
            });
          }
        }
      }
    }
  } catch (e) {}
  setTimeout(pollTelegram, 1000);
}

// --- WEBSOCKET TERMINAL ---
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'SYSTEM', message: 'GÉNESIS Core v4.2 Active' }));
  ws.on('message', async (message) => {
    try {
      const reply = await generateAIResponseWithMemory('web_terminal_user', message.toString());
      ws.send(JSON.stringify({ type: 'AI_RESPONSE', text: reply }));
    } catch (error) {
      ws.send(JSON.stringify({ type: 'ERROR', message: error.message }));
    }
  });
});

server.listen(port, () => {
  console.log(`🚀 GÉNESIS Core v4.2 activo en puerto ${port}`);
  pollTelegram();
});
