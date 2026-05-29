/**
 * server/index.js — Entry point de Dungeon of Echoes
 */

'use strict';

const express = require('express');
const cors    = require('cors');
const http    = require('http');
const path    = require('path');

const db                     = require('./db/db');
const { seedIfEmpty }        = require('./db/seed');
const { execute, getOrCreatePlayer } = require('./game/engine');
const { checkRespawns }      = require('./game/combat');

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

  // 4. Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'OK', game: 'Dungeon of Echoes', version: '0.2.0' });
  });

  // ─── Rutas del juego (API simple, sin Socket.io aún) ───────────────────────

  /**
   * POST /api/login
   * Body: { username: string }
   * Crea o recupera un jugador y devuelve su estado.
   */
  app.post('/api/login', (req, res) => {
    const { username } = req.body;
    if (!username || typeof username !== 'string' || !username.trim()) {
      return res.status(400).json({ error: 'Se requiere un username.' });
    }
    const player = getOrCreatePlayer(username.trim().slice(0, 20));
    // Auto-look al entrar
    const lookResult = execute(player.id, 'look');
    res.json({ player_id: player.id, username: player.username, welcome: lookResult.text });
  });

  /**
   * POST /api/command
   * Body: { player_id: string, command: string }
   * Ejecuta un comando y devuelve el resultado.
   */
  app.post('/api/command', (req, res) => {
    const { player_id, command } = req.body;
    if (!player_id || !command) {
      return res.status(400).json({ error: 'Se requiere player_id y command.' });
    }
    const result = execute(player_id, command);
    res.json({ result: result.text });
  });

  /**
   * GET /api/state/:player_id
   * Devuelve el estado completo del jugador como JSON estructurado (para LLMs).
   */
  app.get('/api/state/:player_id', (req, res) => {
    const player = db.getPlayer(req.params.player_id);
    if (!player) return res.status(404).json({ error: 'Jugador no encontrado.' });

    const room     = db.getRoom(player.current_room_id);
    const monsters = db.getMonstersInRoom(player.current_room_id);
    const others   = db.getPlayersInRoom(player.current_room_id)
                       .filter(p => p.id !== player.id)
                       .map(p => `${p.username} (HP: ${p.hp}/${p.max_hp})`);
    const events   = db.getRecentEvents(player.current_room_id, 5)
                       .map(e => e.result);

    res.json({
      room: {
        id: room.id,
        name: room.name,
        description: room.description,
        exits: Object.keys(room.exits),
        monsters: monsters.map(m => ({ name: m.name, hp: m.hp, max_hp: m.max_hp })),
        items: room.items,
      },
      player: {
        id: player.id,
        username: player.username,
        hp: player.hp,
        max_hp: player.max_hp,
        attack: player.attack,
        defense: player.defense,
        inventory: player.inventory,
      },
      other_players: others,
      recent_events: events,
    });
  });

  // 5. Crear servidor HTTP
  const server = http.createServer(app);

  // 6. Socket.io (se va a configurar en Fase 4)
  // const io = require('socket.io')(server, { cors: { origin: '*' } });
  // require('./socket/handlers')(io);

  // 7. Arrancar servidor
  server.listen(PORT, () => {
    console.log(`\n🏰 Dungeon of Echoes corriendo en http://localhost:${PORT}`);
    console.log(`   Versión 0.3.0 — Combate + ítems activos`);
    console.log(`   Presioná Ctrl+C para apagar\n`);
  });

  // 8. Respawn loop: checar cada 60 segundos
  setInterval(checkRespawns, 60_000);
}

main().catch(err => {
  console.error('Error fatal al arrancar:', err);
  process.exit(1);
});
