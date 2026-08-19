const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const port = process.env.PORT || 10000;

app.use(express.json());

// Sanitiza llaves de entorno
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

app.get('/', (req, res) => {
  res.json({ status: 'ONLINE', system: 'GÉNESIS Core v3.0 Telegram-Integrated' });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 1. Motor Groq Dinámico
async function callGroqDynamic(apiKey, prompt) {
  const modelsRes = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { 'Authorization': `Bearer ${apiKey}` }
  });
  const modelsData = await modelsRes.json();
  if (!modelsRes.ok) throw new Error(modelsData.error?.message || 'Error Groq');

  const availableModels = (modelsData.data || []).map(m => m.id);
  let lastError = null;
  for (const modelId of availableModels) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: prompt }] })
      });
      const data = await res.json();
      if (res.ok && data.choices?.[0]?.message?.content) return data.choices[0].message.content;
      if (data.error) lastError = data.error.message;
    } catch (e) { lastError = e.message; }
  }
  throw new Error(`Groq falló: ${lastError}`);
}

// 2. Motor Gemini Dinámico
async function callGeminiDynamic(apiKey, prompt) {
  const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
  const modelsRes = await fetch(listUrl);
  const modelsData = await modelsRes.json();
  if (!modelsRes.ok) throw new Error(modelsData.error?.message || 'Error Gemini');

  const validModels = (modelsData.models || [])
    .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
    .map(m => m.name);

  let lastError = null;
  for (const modelName of validModels) {
    try {
      const genUrl = `https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent?key=${apiKey}`;
      const res = await fetch(genUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });
      const data = await res.json();
      if (res.ok && data.candidates?.[0]?.content?.parts?.[0]?.text) {
        return data.candidates[0].content.parts[0].text;
      }
      if (data.error) lastError = data.error.message;
    } catch (e) { lastError = e.message; }
  }
  throw new Error(`Gemini falló: ${lastError}`);
}

// Generador Unificado de Inteligencia
async function generateAIResponse(prompt) {
  const groqKeys = getCleanKeys('GROQ_API_KEY');
  const geminiKeys = getCleanKeys('GEMINI_API_KEY');
  let errors = [];

  for (const k of groqKeys) {
    try { return await callGroqDynamic(k.value, prompt); } 
    catch (err) { errors.push(`${k.name}: ${err.message}`); }
  }

  for (const k of geminiKeys) {
    try { return await callGeminiDynamic(k.value, prompt); } 
    catch (err) { errors.push(`${k.name}: ${err.message}`); }
  }

  throw new Error(`Sin respuesta. Detalle: ${errors.join(' | ')}`);
}

// --- INTEGRADOR TELEGRAM BOT ---
let telegramOffset = 0;
async function pollTelegram() {
  const token = cleanKey(process.env.TELEGRAM_BOT_TOKEN);
  if (!token) {
    setTimeout(pollTelegram, 5000);
    return;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=${telegramOffset}&timeout=10`);
    const data = await res.json();

    if (data.ok && data.result && data.result.length > 0) {
      for (const update of data.result) {
        telegramOffset = update.update_id + 1;

        if (update.message && update.message.text) {
          const chatId = update.message.chat.id;
          const userText = update.message.text;
          console.log(`📱 [Telegram User ${chatId}]: ${userText}`);

          // Indicador de "Escribiendo..."
          fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, action: 'typing' })
          }).catch(() => {});

          try {
            const aiReply = await generateAIResponse(userText);
            await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: chatId, text: aiReply })
            });
          } catch (err) {
            await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: chatId, text: `⚠️ Error interno: ${err.message}` })
            });
          }
        }
      }
    }
  } catch (e) {
    console.warn('⚠️ Error en Polling de Telegram:', e.message);
  }

  setTimeout(pollTelegram, 1000);
}

// Conexión WebSocket (Terminal Web)
wss.on('connection', (ws) => {
  console.log('⚡ Cliente conectado a Terminal Web');
  ws.send(JSON.stringify({ type: 'SYSTEM', message: 'GÉNESIS Core v3.0 listo' }));

  ws.on('message', async (message) => {
    try {
      const reply = await generateAIResponse(message.toString());
      ws.send(JSON.stringify({ type: 'AI_RESPONSE', text: reply }));
    } catch (error) {
      ws.send(JSON.stringify({ type: 'ERROR', message: error.message }));
    }
  });
});

server.listen(port, () => {
  console.log(`🚀 GÉNESIS Core v3.0 activo en puerto ${port}`);
  pollTelegram(); // Inicia la escucha de Telegram
});
