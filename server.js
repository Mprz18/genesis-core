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
    system: 'GÉNESIS Core v1.5 - Multi-Model Fallback',
    timestamp: new Date().toISOString()
  });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const geminiModels = ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash-exp'];
const groqModels = ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'llama3-70b-8192', 'mixtral-8x7b-32768'];

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

  // 1. Iterar llaves y modelos Gemini
  for (let i = 0; i < geminiKeys.length; i++) {
    const genAI = new GoogleGenerativeAI(geminiKeys[i]);
    for (const modelName of geminiModels) {
      try {
        console.log(`🤖 Probando Gemini Key #${i + 1} (${modelName})...`);
        const model = genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent(prompt);
        return result.response.text();
      } catch (err) {
        console.warn(`⚠️ Falló ${modelName} en Gemini Key #${i + 1}:`, err.message);
        errors.push(`Gemini K#${i + 1} [${modelName}]: ${err.message}`);
      }
    }
  }

  // 2. Iterar llaves y modelos Groq
  for (let j = 0; j < groqKeys.length; j++) {
    const groq = new Groq({ apiKey: groqKeys[j] });
    for (const modelName of groqModels) {
      try {
        console.log(`⚡ Probando Groq Key #${j + 1} (${modelName})...`);
        const completion = await groq.chat.completions.create({
          messages: [{ role: 'user', content: prompt }],
          model: modelName,
        });
        const content = completion.choices[0]?.message?.content;
        if (content) return content;
      } catch (err) {
        console.warn(`⚠️ Falló ${modelName} en Groq Key #${j + 1}:`, err.message);
        errors.push(`Groq K#${j + 1} [${modelName}]: ${err.message}`);
      }
    }
  }

  throw new Error(`Fallback agotado. Último error: ${errors[errors.length - 1] || 'Sin respuesta'}`);
}

wss.on('connection', (ws) => {
  console.log('⚡ Cliente conectado');
  ws.send(JSON.stringify({ type: 'SYSTEM', message: 'GÉNESIS Core v1.5 listo' }));

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
  console.log(`🚀 GÉNESIS Core v1.5 activo en puerto ${port}`);
});
