const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Groq = require('groq-sdk');

const app = express();
const port = process.env.PORT || 10000;

app.get('/', (req, res) => res.json({ status: 'ONLINE', system: 'GÉNESIS v2.1 Multi-Account Active' }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Detecta automáticamente cualquier llave en Render que empiece por el prefijo dado
function getEnvKeys(prefix) {
  return Object.keys(process.env)
    .filter(key => key.startsWith(prefix) && process.env[key].trim() !== '')
    .map(key => ({ name: key, value: process.env[key].trim() }));
}

async function generateAIResponse(prompt) {
  const groqKeys = getEnvKeys('GROQ_API_KEY');
  const geminiKeys = getEnvKeys('GEMINI_API_KEY');

  let errorLogs = [];

  // 1. Probar todas las cuentas de Groq que tengas registradas
  for (const k of groqKeys) {
    try {
      console.log(`⚡ Probando ${k.name}...`);
      const groq = new Groq({ apiKey: k.value });
      const completion = await groq.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model: 'llama-3.3-70b-versatile',
      });
      const reply = completion.choices[0]?.message?.content;
      if (reply) {
        console.log(`✅ Éxito con ${k.name}`);
        return reply;
      }
    } catch (err) {
      console.warn(`⚠️ ${k.name} falló:`, err.message);
      errorLogs.push(`${k.name}: ${err.message}`);
    }
  }

  // 2. Si fallan las de Groq, probar todas las cuentas de Google/Gemini
  for (const k of geminiKeys) {
    try {
      console.log(`🤖 Probando ${k.name}...`);
      const genAI = new GoogleGenerativeAI(k.value);
      const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
      const result = await model.generateContent(prompt);
      const reply = result.response.text();
      if (reply) {
        console.log(`✅ Éxito con ${k.name}`);
        return reply;
      }
    } catch (err) {
      console.warn(`⚠️ ${k.name} falló:`, err.message);
      errorLogs.push(`${k.name}: ${err.message}`);
    }
  }

  throw new Error(`Ninguna cuenta respondió. Errores: ${errorLogs.join(' | ')}`);
}

wss.on('connection', (ws) => {
  console.log('⚡ Cliente conectado');
  ws.send(JSON.stringify({ type: 'SYSTEM', message: 'GÉNESIS Core v2.1 listo' }));

  ws.on('message', async (message) => {
    try {
      const userText = message.toString();
      console.log(`[Usuario]: ${userText}`);
      
      const reply = await generateAIResponse(userText);
      ws.send(JSON.stringify({ type: 'AI_RESPONSE', text: reply }));
    } catch (error) {
      console.error('❌ Error:', error.message);
      ws.send(JSON.stringify({ type: 'ERROR', message: error.message }));
    }
  });
});

server.listen(port, () => console.log(`🚀 Servidor GÉNESIS v2.1 escuchando en puerto ${port}`));
