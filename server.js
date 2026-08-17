const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Groq = require('groq-sdk');

const app = express();
const port = process.env.PORT || 10000;

app.use(express.json());
app.get('/', (req, res) => res.json({ status: 'ONLINE', system: 'GÉNESIS v1.8' }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

async function generateAIResponse(prompt) {
  // 1. Intentar con Groq (Modelo activo: llama-3.3-70b-versatile)
  const groqKeys = [
    process.env.GROQ_API_KEY_1,
    process.env.GROQ_API_KEY_2,
    process.env.GROQ_API_KEY_3,
    process.env.GROQ_API_KEY_4,
    process.env.GROQ_API_KEY_5
  ].filter(Boolean);

  for (let i = 0; i < groqKeys.length; i++) {
    try {
      const groq = new Groq({ apiKey: groqKeys[i] });
      const completion = await groq.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model: 'llama-3.3-70b-versatile',
      });
      const text = completion.choices[0]?.message?.content;
      if (text) return text;
    } catch (err) {
      console.warn(`Groq Key #${i + 1} falló:`, err.message);
    }
  }

  // 2. Intentar con Gemini (Modelo activo: gemini-1.5-flash)
  const geminiKeys = [
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2
  ].filter(Boolean);

  for (let j = 0; j < geminiKeys.length; j++) {
    try {
      const genAI = new GoogleGenerativeAI(geminiKeys[j]);
      const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
      const result = await model.generateContent(prompt);
      return result.response.text();
    } catch (err) {
      console.warn(`Gemini Key #${j + 1} falló:`, err.message);
    }
  }

  throw new Error('No se pudo obtener respuesta. Revisa que tus API Keys creadas en console.groq.com o aistudio.google.com sean válidas.');
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'SYSTEM', message: 'GÉNESIS Core v1.8 listo' }));

  ws.on('message', async (message) => {
    try {
      const reply = await generateAIResponse(message.toString());
      ws.send(JSON.stringify({ type: 'AI_RESPONSE', text: reply }));
    } catch (error) {
      ws.send(JSON.stringify({ type: 'ERROR', message: error.message }));
    }
  });
});

server.listen(port, () => console.log(`Servidor activo en puerto ${port}`));
