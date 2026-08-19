const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const port = process.env.PORT || 10000;

app.use(express.json());

// Limpia comillas, espacios o caracteres invisibles de las llaves
function cleanKey(key) {
  if (!key) return null;
  return key.trim().replace(/^["']|["']$/g, '');
}

// Extrae y sanitiza las llaves del entorno
function getCleanKeys(prefix) {
  return Object.keys(process.env)
    .filter(k => k.startsWith(prefix))
    .map(k => ({ name: k, value: cleanKey(process.env[k]) }))
    .filter(item => item.value && item.value.length > 10);
}

app.get('/', (req, res) => {
  res.json({ status: 'ONLINE', system: 'GÉNESIS Core v2.2 Direct-REST Active' });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Petición directa a la API de Groq
async function callGroq(apiKey, prompt) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || `HTTP Error ${response.status}`);
  }
  return data.choices[0]?.message?.content;
}

// Petición directa a la API de Gemini
async function callGemini(apiKey, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }]
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || `HTTP Error ${response.status}`);
  }
  return data.candidates[0]?.content?.parts[0]?.text;
}

async function generateAIResponse(prompt) {
  const groqKeys = getCleanKeys('GROQ_API_KEY');
  const geminiKeys = getCleanKeys('GEMINI_API_KEY');

  let errors = [];

  // 1. Probar llaves de Groq
  for (const k of groqKeys) {
    try {
      console.log(`⚡ Conectando a Groq (${k.name})...`);
      const reply = await callGroq(k.value, prompt);
      if (reply) {
        console.log(`✅ Respuesta recibida con éxito de ${k.name}`);
        return reply;
      }
    } catch (err) {
      console.warn(`⚠️ ${k.name} falló:`, err.message);
      errors.push(`${k.name}: ${err.message}`);
    }
  }

  // 2. Probar llaves de Gemini
  for (const k of geminiKeys) {
    try {
      console.log(`🤖 Conectando a Gemini (${k.name})...`);
      const reply = await callGemini(k.value, prompt);
      if (reply) {
        console.log(`✅ Respuesta recibida con éxito de ${k.name}`);
        return reply;
      }
    } catch (err) {
      console.warn(`⚠️ ${k.name} falló:`, err.message);
      errors.push(`${k.name}: ${err.message}`);
    }
  }

  throw new Error(`Ninguna cuenta pudo responder. Detalle: ${errors.join(' | ')}`);
}

wss.on('connection', (ws) => {
  console.log('⚡ Cliente conectado a la terminal');
  ws.send(JSON.stringify({ type: 'SYSTEM', message: 'GÉNESIS Core v2.2 listo' }));

  ws.on('message', async (message) => {
    try {
      const userText = message.toString();
      console.log(`[Usuario]: ${userText}`);
      
      const reply = await generateAIResponse(userText);
      ws.send(JSON.stringify({ type: 'AI_RESPONSE', text: reply }));
    } catch (error) {
      console.error('❌ Error general:', error.message);
      ws.send(JSON.stringify({ type: 'ERROR', message: error.message }));
    }
  });
});

server.listen(port, () => {
  const groqCount = getCleanKeys('GROQ_API_KEY').length;
  const geminiCount = getCleanKeys('GEMINI_API_KEY').length;
  console.log(`🚀 GÉNESIS v2.2 activo en puerto ${port}`);
  console.log(`🔑 Llaves cargadas: ${groqCount} de Groq | ${geminiCount} de Gemini`);
});
