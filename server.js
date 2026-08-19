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

// Limpia el razonamiento interno (<think>...</think>) de los modelos de IA
function sanitizeAIOutput(text) {
  if (!text) return '';
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

app.get('/', (req, res) => {
  res.json({ status: 'ONLINE', system: 'GÉNESIS Core v3.2 Active Memory & Clean Output' });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// --- MÓDULO SUPABASE REST ---
async function saveMessage(userId, role, content) {
  const url = cleanKey(process.env.SUPABASE_URL);
  const key = cleanKey(process.env.SUPABASE_ANON_KEY);
  if (!url || !key) return;

  try {
    const res = await fetch(`${url}/rest/v1/chat_history`, {
      method: 'POST',
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ user_id: String(userId), role, content })
    });
    if (!res.ok) {
      console.warn('⚠️ Supabase Save Failed:', await res.text());
    }
  } catch (e) {
    console.warn('⚠️ Error guardando en Supabase:', e.message);
  }
}

async function getRecentHistory(userId, limit = 8) {
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
    if (!res.ok) {
      console.warn('⚠️ Supabase Fetch Failed:', await res.text());
      return [];
    }
    const data = await res.json();
    return data.reverse();
  } catch (e) {
    console.warn('⚠️ Error leyendo historial:', e.message);
    return [];
  }
}

// --- MOTORES DE IA ---
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
  throw new Error('Groq no pudo procesar la solicitud');
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
  throw new Error('Gemini no pudo procesar la solicitud');
}

async function generateAIResponseWithMemory(userId, newPrompt) {
  const history = await getRecentHistory(userId, 8);
  
  const messages = [
    { 
      role: 'system', 
      content: 'Eres GÉNESIS, un asistente de IA proactivo, inteligente y empático. Tienes acceso al historial reciente de conversación para recordar los gustos y datos del usuario.' 
    },
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

  if (!reply) throw new Error('Ninguna IA pudo generar respuesta.');

  // Guardar en Supabase en segundo plano
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
  ws.send(JSON.stringify({ type: 'SYSTEM', message: 'GÉNESIS Core v3.2 listo' }));
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
  console.log(`🚀 GÉNESIS Core v3.2 activo en puerto ${port}`);
  pollTelegram();
});
