const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Groq = require('groq-sdk');

const app = express();
const port = process.env.PORT || 10000;

app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    status: 'ONLINE',
    system: 'GÉNESIS Core v1.3 - Active',
    timestamp: new Date().toISOString()
  });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const geminiKeys = [
  process.env.GEMINI_API_KEY_1,
  process.env.GEMINI_API_KEY_2
].filter(Boolean);

const groqKeys = [
  process.env.GROQ_API_KEY_1,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
  process.env.GROQ_API_KEY_4,
  process.env.GROQ_API_KEY_5
].filter(Boolean);

async function generateAIResponse(prompt) {
  // 1. Probar llaves Gemini (Modelo oficial: gemini-1.5-flash)
  for (let i = 0; i < geminiKeys.length; i++) {
    try {
      console.log(`🤖 Probando Gemini Key #${i + 1}...`);
      const genAI = new GoogleGenerativeAI(geminiKeys[i]);
      const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
      const result = await model.generateContent(prompt);
      return result.response.text();
    } catch (err) {
      console.warn(`⚠️ Error en Gemini Key #${i + 1}:`, err.message);
    }
  }

  // 2. Probar llaves Groq de respaldo
  for (let j = 0; j < groqKeys.length; j++) {
    try {
      console.log(`⚡ Probando Groq Key #${j + 1}...`);
      const groq = new Groq({ apiKey: groqKeys[j] });
      const completion = await groq.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model: 'llama-3.3-70b-versatile',
      });
      return completion.choices[0]?.message?.content || '';
    } catch (err) {
      console.warn(`⚠️ Error en Groq Key #${j + 1}:`, err.message);
    }
  }

  throw new Error('Todas las API Keys fallaron o no están configuradas.');
}

wss.on('connection', (ws) => {
  console.log('⚡ Cliente conectado');
  ws.send(JSON.stringify({ type: 'SYSTEM', message: 'GÉNESIS Core listo' }));

  ws.on('message', async (message) => {
    try {
      const userText = message.toString();
      console.log(`[Usuario]: ${userText}`);
      
      const reply = await generateAIResponse(userText);
      ws.send(JSON.stringify({ type: 'AI_RESPONSE', text: reply }));
    } catch (error) {
      console.error('❌ Error general:', error.message);
      ws.send(JSON.stringify({ type: 'ERROR', message: `Error: ${error.message}` }));
    }
  });
});

server.listen(port, () => {
  console.log(`🚀 GÉNESIS Core v1.3 ejecutándose en puerto ${port}`);
});
