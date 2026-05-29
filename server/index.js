/**
 * server/index.js — Entry point de Dungeon of Echoes
 */

'use strict';

const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');

const db = require('./db/db');
const { seedIfEmpty } = require('./db/seed');

const PORT = process.env.PORT || 3000;

async function main() {
  // 1. Inicializar base de datos
  await db.init();
  seedIfEmpty();

  // 2. Crear app Express
  const app = express();
  app.use(cors());
  app.use(express.json());

  // 3. Servir archivos estáticos del cliente
  app.use(express.static(path.join(__dirname, '../client')));

  // 4. Ruta de health check
  app.get('/', (req, res) => {
    res.json({ status: 'OK', game: 'Dungeon of Echoes', version: '0.1.0' });
  });

  // 5. Rutas de API (se van a agregar en Fase 2+)
  // app.use('/api', require('./api/routes'));

  // 6. Crear servidor HTTP
  const server = http.createServer(app);

  // 7. Socket.io (se va a configurar en Fase 4)
  // const io = require('socket.io')(server, { cors: { origin: '*' } });
  // require('./socket/handlers')(io);

  // 8. Arrancar servidor
  server.listen(PORT, () => {
    console.log(`\n🏰 Dungeon of Echoes corriendo en http://localhost:${PORT}`);
    console.log(`   Presioná Ctrl+C para apagar\n`);
  });
}

main().catch(err => {
  console.error('Error fatal al arrancar:', err);
  process.exit(1);
});
