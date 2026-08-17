const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const port = process.env.PORT || 10000;

app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    status: 'ONLINE',
    system: 'GÉNESIS Core v1.0',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('⚡ Cliente conectado a GÉNESIS');
  ws.send(JSON.stringify({ type: 'SYSTEM', message: 'Conexión establecida con GÉNESIS Core' }));

  ws.on('message', (message) => {
    console.log(`[Recibido]: ${message}`);
  });
});

server.listen(port, () => {
  console.log(`🚀 GÉNESIS Core ejecutándose en el puerto ${port}`);
});
