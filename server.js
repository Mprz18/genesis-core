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
    system: 'GÉNESIS Core v1.6 - Active Models Only',
    timestamp: new Date().toISOString()
  });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Identificadores de modelos oficialmente soportados y vigentes
const geminiModels = ['gemini-1.5-flash', 'gemini-2.0-flash', 'gemini-1.5-pro'];
const groqModels = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'gemma2-9b-it'];

async function generateAIResponse(prompt) {
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

  let errors = [];

  // 1. Probar llaves y modelos de Gemini
  for (let i = 0; i < geminiKeys.length; i++) {
    const genAI = new GoogleGenerativeAI(geminiKeys[i]);
    for (const modelName of geminiModels) {
      try {
        console.log(`🤖 Probando Gemini K#${i + 1} (${modelName})...`);
        const model = genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent(prompt);
        return result.response.text();
      } catch (err) {
        console.warn(`⚠️ Error Gemini K#${i + 1} [${modelName}]:`, err.message);
        errors.push(`Gemini K#${i + 1} [${modelName}]: ${err.message}`);
      }
    }
  }

  // 2. Probar llaves y modelos de Groq
  for (let j = 0; j < groqKeys.length; j++) {
    const groq = new Groq({ apiKey: groqKeys[j] });
    for (const modelName of groqModels) {
      try {
        console.log(`⚡ Probando Groq K#${j + 1} (${modelName})...`);
        const completion = await groq.chat.completions.create({
          messages: [{ role: 'user', content: prompt }],
          model: modelName,
        });
        const content = completion.choices[0]?.message?.content;
        if (content) return content;
      } catch (err) {
        console.warn(`⚠️ Error Groq K#${j + 1} [${modelName}]:`, err.message);
        errors.push(`Groq K#${j + 1} [${modelName}]: ${err.message}`);
      }
    }
  }

  throw new Error(`Fallback agotado. Último reporte: ${errors[errors.length - 1] || 'Sin respuesta'}`);
}

wss.on('connection', (ws) => {
  console.log('⚡ Cliente conectado');
  ws.send(JSON.stringify({ type: 'SYSTEM', message: 'GÉNESIS Core v1.6 listo' }));

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
  console.log(`🚀 GÉNESIS Core v1.6 activo en puerto ${port}`);
});
