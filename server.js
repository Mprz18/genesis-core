const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const port = process.env.PORT || 10000;

app.use(express.json());

// Sanitiza espacios o comillas en las claves de Render
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
  res.json({ status: 'ONLINE', system: 'GÉNESIS Core v2.3 Dynamic-Models Active' });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 1. Groq con auto-descubrimiento de modelos disponibles
async function callGroqDynamic(apiKey, prompt) {
  const modelsRes = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { 'Authorization': `Bearer ${apiKey}` }
  });
  const modelsData = await modelsRes.json();

  if (!modelsRes.ok) {
    throw new Error(`Auth Error (${modelsRes.status}): ${modelsData.error?.message || 'Llave o acceso inválido'}`);
  }

  const availableModels = (modelsData.data || []).map(m => m.id);
  if (availableModels.length === 0) {
    throw new Error('Esta cuenta no tiene modelos asignados.');
  }

  let lastError = null;
  for (const modelId of availableModels) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: prompt }]
        })
      });
      const data = await res.json();
      if (res.ok && data.choices?.[0]?.message?.content) {
        console.log(`🎯 Groq respondió usando modelo: ${modelId}`);
        return data.choices[0].message.content;
      }
      if (data.error) lastError = data.error.message;
    } catch (e) {
      lastError = e.message;
    }
  }
  throw new Error(`Modelos fallaron. Último motivo: ${lastError}`);
}

// 2. Gemini con auto-descubrimiento de modelos disponibles
async function callGeminiDynamic(apiKey, prompt) {
  const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
  const modelsRes = await fetch(listUrl);
  const modelsData = await modelsRes.json();

  if (!modelsRes.ok) {
    throw new Error(`Auth Error (${modelsRes.status}): ${modelsData.error?.message || 'Llave o acceso inválido'}`);
  }

  const validModels = (modelsData.models || [])
    .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
    .map(m => m.name);

  if (validModels.length === 0) {
    throw new Error('No hay modelos de generación para esta llave.');
  }

  let lastError = null;
  for (const modelName of validModels) {
    try {
      const genUrl = `https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent?key=${apiKey}`;
      const res = await fetch(genUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        })
      });
      const data = await res.json();
      if (res.ok && data.candidates?.[0]?.content?.parts?.[0]?.text) {
        console.log(`🎯 Gemini respondió usando modelo: ${modelName}`);
        return data.candidates[0].content.parts[0].text;
      }
      if (data.error) lastError = data.error.message;
    } catch (e) {
      lastError = e.message;
    }
  }
  throw new Error(`Modelos fallaron. Último motivo: ${lastError}`);
}

async function generateAIResponse(prompt) {
  const groqKeys = getCleanKeys('GROQ_API_KEY');
  const geminiKeys = getCleanKeys('GEMINI_API_KEY');

  let errors = [];

  // Probar Groq
  for (const k of groqKeys) {
    try {
      console.log(`⚡ Consultando modelos de Groq (${k.name})...`);
      const reply = await callGroqDynamic(k.value, prompt);
      if (reply) return reply;
    } catch (err) {
      console.warn(`⚠️ ${k.name} falló:`, err.message);
      errors.push(`${k.name}: ${err.message}`);
    }
  }

  // Probar Gemini
  for (const k of geminiKeys) {
    try {
      console.log(`🤖 Consultando modelos de Gemini (${k.name})...`);
      const reply = await callGeminiDynamic(k.value, prompt);
      if (reply) return reply;
    } catch (err) {
      console.warn(`⚠️ ${k.name} falló:`, err.message);
      errors.push(`${k.name}: ${err.message}`);
    }
  }

  throw new Error(`Ninguna cuenta respondió. Detalles: ${errors.join(' | ')}`);
}

wss.on('connection', (ws) => {
  console.log('⚡ Cliente conectado a la terminal');
  ws.send(JSON.stringify({ type: 'SYSTEM', message: 'GÉNESIS Core v2.3 listo' }));

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
  console.log(`🚀 GÉNESIS Core v2.3 activo en puerto ${port}`);
});
