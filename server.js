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

// Limpia el razonamiento interno (<think>...</think>)
function sanitizeAIOutput(text) {
  if (!text) return '';
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

app.get('/', (req, res) => {
  res.json({ 
    status: 'ONLINE', 
    system: 'GÉNESIS Core v4.0 — Agentic JARVIS Architecture',
    tools: ['Live Web Search', 'Satellite Weather API', 'System Clock', 'Persistent Supabase Memory']
  });
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

// --- HERRAMIENTAS EN TIEMPO REAL (JARVIS TOOLS) ---
function toolGetDateTime() {
  const now = new Date();
  const options = { 
    timeZone: 'America/Mexico_City',
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', 
    hour: '2-digit', minute: '2-digit', second: '2-digit' 
  };
  return `[HERRAMIENTA: HORA Y FECHA REAL] Hora local actual: ${now.toLocaleDateString('es-MX', options)}`;
}

async function toolGetWeather(location) {
  try {
    const cleanLocation = location.replace(/clima|tiempo|temperatura|en|de|por favor|cuál es el|cómo está el|como esta el/gi, '').trim() || 'Ciudad de Mexico';
    const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cleanLocation)}&count=1&language=es&format=json`);
    const geoData = await geoRes.json();
    if (!geoData.results || geoData.results.length === 0) {
      return `[HERRAMIENTA: CLIMA] No se encontraron coordenadas para "${cleanLocation}".`;
    }
    const { latitude, longitude, name, country } = geoData.results[0];
    const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true&timezone=auto`);
    const weatherData = await weatherRes.json();
    const cur = weatherData.current_weather;
    return `[HERRAMIENTA: CLIMA SATELEITAL EN VIVO] ${name}, ${country}: Temperatura ${cur.temperature}°C, Viento: ${cur.windspeed} km/h, Código de clima: ${cur.weathercode}.`;
  } catch (e) {
    return `[HERRAMIENTA: CLIMA] Error al consultar clima: ${e.message}`;
  }
}

async function toolWebSearch(query) {
  try {
    const results = [];
    // DuckDuckGo Instant Answer API
    const ddgApiUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const apiRes = await fetch(ddgApiUrl);
    const apiData = await apiRes.json();
    
    if (apiData.AbstractText) {
      results.push(`Resumen: ${apiData.AbstractText}`);
    }
    if (apiData.RelatedTopics && apiData.RelatedTopics.length > 0) {
      apiData.RelatedTopics.slice(0, 3).forEach(topic => {
        if (topic.Text) results.push(`• ${topic.Text}`);
      });
    }

    // DuckDuckGo HTML Search Fallback
    if (results.length < 2) {
      const htmlRes = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
      const htmlText = await htmlRes.text();
      const matches = [...htmlText.matchAll(/<a class="result__snippet[^">]*?>(.*?)<\/a>/gs)];
      const snippets = matches.slice(0, 3).map(m => m[1].replace(/<[^>]+>/g, '').trim());
      if (snippets.length > 0) {
        results.push('Resultados web:', ...snippets);
      }
    }

    if (results.length === 0) {
      return `[HERRAMIENTA: BÚSQUEDA WEB] Búsqueda realizada para "${query}". Sin datos directos.`;
    }
    return `[HERRAMIENTA: BÚSQUEDA WEB EN TIEMPO REAL para "${query}"]:\n` + results.join('\n');
  } catch (e) {
    return `[HERRAMIENTA: BÚSQUEDA WEB] Error en búsqueda: ${e.message}`;
  }
}

// ORQUESTADOR DE HERRAMIENTAS (Detecta la intención antes de consultar la IA)
async function executeAgentTools(userPrompt) {
  const lower = userPrompt.toLowerCase();
  const toolOutputs = [];

  // 1. Detectar consulta de hora o fecha
  if (lower.includes('hora') || lower.includes('fecha') || lower.includes('qué día') || lower.includes('que dia')) {
    toolOutputs.push(toolGetDateTime());
  }

  // 2. Detectar consulta de clima
  if (lower.includes('clima') || lower.includes('tiempo') || lower.includes('temperatura') || lower.includes('llover') || lower.includes('lluvia')) {
    const weatherData = await toolGetWeather(userPrompt);
    toolOutputs.push(weatherData);
  }

  // 3. Detectar búsqueda web (noticias, precios, datos en tiempo real)
  const isSearchIntent = lower.includes('noticia') || lower.includes('precio') || lower.includes('dólar') || 
                         lower.includes('dolar') || lower.includes('bitcoin') || lower.includes('crypto') || 
                         lower.includes('hoy') || lower.includes('quién es') || lower.includes('quien es') || 
                         lower.includes('resultado') || lower.includes('partido') || lower.includes('buscar');

  if (isSearchIntent) {
    const searchData = await toolWebSearch(userPrompt);
    toolOutputs.push(searchData);
  }

  return toolOutputs.length > 0 ? toolOutputs.join('\n\n') : null;
}

// --- MOTORES DE IA CON PERSONALIDAD Y HERRAMIENTAS ---
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
  // 1. Ejecución autónoma de herramientas según la pregunta
  const liveToolData = await executeAgentTools(newPrompt);

  // 2. Lectura de memoria continua en Supabase
  const history = await getRecentHistory(userId, 8);
  
  const systemMessage = { 
    role: 'system', 
    content: `Eres GÉNESIS, un Sistema de Inteligencia Artificial Avanzado inspirado en JARVIS de Marvel.
Tu estilo de comunicación:
- Altamente sofisticado, eficiente, servicial y con un toque formal.
- Te diriges al usuario con respeto ("Señor" o de forma muy profesional).
- Si se te proporcionan [DATOS DE HERRAMIENTAS EN TIEMPO REAL], úsalos para dar respuestas exactas y actualizadas al segundo. Jamás digas que no tienes acceso a internet si dispones de estos datos.
- Tienes memoria constante gracias a Supabase.

${liveToolData ? `\n[DATOS OBTENIDOS POR HERRAMIENTAS EN TIEMPO REAL]:\n${liveToolData}\n` : ''}`
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
  ws.send(JSON.stringify({ type: 'SYSTEM', message: 'GÉNESIS Core v4.0 Agentic JARVIS Active' }));
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
  console.log(`🚀 GÉNESIS Core v4.0 Agentic JARVIS activo en puerto ${port}`);
  pollTelegram();
});
