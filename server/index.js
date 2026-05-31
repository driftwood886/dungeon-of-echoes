/**
 * server/index.js — Entry point de Dungeon of Echoes
 */

'use strict';

const express = require('express');
const cors    = require('cors');
const http    = require('http');
const path    = require('path');

const db                     = require('./db/db');
const { seedIfEmpty, migrateAuctionRoom, migrateFountainRoom, migrateEchoRooms, migrateTrainingRoom, migrateArmorLoot, migrateScrollLoot, migrateCryptRoom } = require('./db/seed');
const { execute, getOrCreatePlayer, ROOM_EFFECTS, resolveExpiredAuctions } = require('./game/engine');
const { checkRespawns, wanderMonsters } = require('./game/combat');
const quests                 = require('./game/quests');
const worldEvents            = require('./game/worldEvents');
const weather                = require('./game/weather');
const { registerHandlers, playerSockets, previousRoomMap } = require('./socket/handlers');

const PORT = process.env.PORT || 3000;
const SERVER_START = Date.now(); // T119: uptime del servidor

async function main() {
  // 1. Inicializar base de datos
  await db.init();
  seedIfEmpty();
  migrateAuctionRoom();
  migrateFountainRoom();
  migrateEchoRooms();
  migrateTrainingRoom();
  migrateArmorLoot(); // T152
  migrateScrollLoot(); // T153
  migrateCryptRoom(); // T179

  // 2. Crear app Express
  const app = express();
  app.use(cors());
  app.use(express.json());

  // 3. Servir archivos estáticos del cliente
  app.use(express.static(path.join(__dirname, '../client')));

  // 4. Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'OK', game: 'Dungeon of Echoes', version: '0.6.0' });
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
        trap: room.trap ? { active: room.trap.active, type: room.trap.type } : null,
        room_effect: ROOM_EFFECTS[room.id] ? { label: ROOM_EFFECTS[room.id].label, type: ROOM_EFFECTS[room.id].type } : null,
      },
      player: {
        id: player.id,
        username: player.username,
        hp: player.hp,
        max_hp: player.max_hp,
        attack: player.attack,
        defense: player.defense,
        inventory: player.inventory,
        level: player.level || 1,
        xp: player.xp || 0,
        kills: player.kills || 0,
        equipped_weapon: player.equipped_weapon || null,
        equipped_armor: player.equipped_armor || null,
        pending_messages: db.countPendingMessages(player.id),
        status_effects: player.status_effects || {},
        gold: player.gold || 0,
        achievements: JSON.parse(player.achievements || '[]'),
        mana: player.mana != null ? player.mana : 20,
        max_mana: player.max_mana || 20,
        shield_active: player.shield_active || 0,
        player_class: player.player_class || 'sin_clase',
        playtime_minutes: player.playtime_minutes || 0,
      },
      other_players: others,
      recent_events: events,
      party: player.party_id
        ? db.getPartyMembers(player.party_id)
            .filter(m => m.id !== player.id)
            .map(m => ({ username: m.username, hp: m.hp, max_hp: m.max_hp, level: m.level || 1 }))
        : null,
    });
  });

  /**
   * GET /api/players/online
   * Lista jugadores que estuvieron activos en los últimos 5 minutos.
   * Útil para que LLMs y clientes puedan mostrar quién está conectado.
   */
  app.get('/api/players/online', (req, res) => {
    // SQLite datetime('now') usa formato 'YYYY-MM-DD HH:MM:SS' (sin T ni Z)
    const cutoffDate = new Date(Date.now() - 5 * 60 * 1000);
    const cutoff = cutoffDate.toISOString().replace('T', ' ').split('.')[0];
    const activePlayers = db.getActivePlayers(cutoff);
    res.json({
      count: activePlayers.length,
      players: activePlayers.map(p => ({
        username: p.username,
        hp: p.hp,
        max_hp: p.max_hp,
        room: p.room_name || `sala #${p.current_room_id}`,
        last_seen: p.last_seen,
      })),
    });
  });

  /**
   * GET /api/leaderboard
   * Devuelve la tabla de líderes global (top 10 por kills, luego XP).
   * Útil para que clientes externos y LLMs consulten el ranking.
   */
  app.get('/api/leaderboard', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
    const leaders = db.getLeaderboard(limit);
    res.json({
      count: leaders.length,
      leaderboard: leaders.map((p, idx) => ({
        rank: idx + 1,
        username: p.username,
        level: p.level || 1,
        xp: p.xp || 0,
        kills: p.kills || 0,
        hp: p.hp,
        max_hp: p.max_hp,
      })),
    });
  });

  /**
   * GET /api/room/:id
   * Devuelve el estado completo de una habitación (para LLMs y clientes).
   * Incluye monstruos, ítems, salidas y jugadores presentes.
   */
  app.get('/api/room/:id', (req, res) => {
    const roomId = parseInt(req.params.id, 10);
    if (isNaN(roomId)) {
      return res.status(400).json({ error: 'ID de habitación inválido.' });
    }
    const room = db.getRoom(roomId);
    if (!room) {
      return res.status(404).json({ error: `Habitación ${roomId} no encontrada.` });
    }
    const monsters = db.getMonstersInRoom(roomId);
    const players  = db.getPlayersInRoom(roomId);

    res.json({
      id: room.id,
      name: room.name,
      description: room.description,
      exits: room.exits,
      items: room.items,
      monsters: monsters.map(m => ({
        id: m.id,
        name: m.name,
        hp: m.hp,
        max_hp: m.max_hp,
        attack: m.attack,
      })),
      players: players.map(p => ({
        username: p.username,
        hp: p.hp,
        max_hp: p.max_hp,
        level: p.level || 1,
      })),
    });
  });

  // ─── Admin endpoints (T072 — persistencia de BD) ──────────────────────────

  /**
   * GET /api/admin/db-export
   * Descarga la BD SQLite actual como archivo binario.
   * Protegido por ADMIN_TOKEN env var. Útil para backup manual antes de reinicios.
   * curl -H "Authorization: Bearer <token>" https://tu-server/api/admin/db-export > dungeon.sqlite
   */
  app.get('/api/admin/db-export', (req, res) => {
    const adminToken = process.env.ADMIN_TOKEN;
    if (adminToken) {
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (token !== adminToken) {
        return res.status(401).json({ error: 'Unauthorized. Provide: Authorization: Bearer <ADMIN_TOKEN>' });
      }
    }
    try {
      const data = db.raw().export();
      const buf = Buffer.from(data);
      res.set('Content-Type', 'application/octet-stream');
      res.set('Content-Disposition', `attachment; filename="dungeon-${Date.now()}.sqlite"`);
      res.set('Content-Length', buf.length);
      res.send(buf);
      console.log('[admin] DB exportada via /api/admin/db-export');
    } catch (err) {
      res.status(500).json({ error: 'Error al exportar BD: ' + err.message });
    }
  });

  /**
   * GET /api/stats — Estadísticas públicas del servidor (T119)
   */
  app.get('/api/stats', (req, res) => {
    try {
      const cutoff5min = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const totalPlayers = db.raw().exec('SELECT COUNT(*) as cnt FROM players')[0];
      const activePlayers = db.raw().exec(
        `SELECT COUNT(*) as cnt FROM players WHERE last_seen >= '${cutoff5min}'`
      )[0];
      const totalKills = db.raw().exec('SELECT SUM(kills) as s FROM players')[0];
      const totalGold = db.raw().exec('SELECT SUM(gold) as s FROM players')[0];
      const activeMonsters = db.raw().exec('SELECT COUNT(*) as cnt FROM monsters WHERE room_id IS NOT NULL')[0];
      const uptimeSec = Math.floor((Date.now() - SERVER_START) / 1000);
      const uptimeMin = Math.floor(uptimeSec / 60);
      const uptimeHrs = Math.floor(uptimeMin / 60);

      res.json({
        players_total:   totalPlayers   ? totalPlayers.values[0][0]   : 0,
        players_online:  activePlayers  ? activePlayers.values[0][0]  : 0,
        kills_total:     totalKills     ? (totalKills.values[0][0] || 0)     : 0,
        gold_in_economy: totalGold      ? (totalGold.values[0][0] || 0)      : 0,
        monsters_active: activeMonsters ? activeMonsters.values[0][0] : 0,
        uptime_seconds:  uptimeSec,
        uptime_human:    uptimeHrs > 0
          ? `${uptimeHrs}h ${uptimeMin % 60}m`
          : `${uptimeMin}m ${uptimeSec % 60}s`,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/admin/stats
   * Estadísticas del servidor: jugadores totales, monstruos, salas, etc.
   * Protegido por ADMIN_TOKEN env var.
   */
  app.get('/api/admin/stats', (req, res) => {
    const adminToken = process.env.ADMIN_TOKEN;
    if (adminToken) {
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (token !== adminToken) {
        return res.status(401).json({ error: 'Unauthorized.' });
      }
    }
    const players = db.raw().exec('SELECT COUNT(*) as cnt FROM players')[0];
    const rooms   = db.raw().exec('SELECT COUNT(*) as cnt FROM rooms')[0];
    const monsters = db.raw().exec('SELECT COUNT(*) as cnt FROM monsters')[0];
    const events  = db.raw().exec('SELECT COUNT(*) as cnt FROM events')[0];
    res.json({
      players:  players  ? players.values[0][0]  : 0,
      rooms:    rooms    ? rooms.values[0][0]    : 0,
      monsters: monsters ? monsters.values[0][0] : 0,
      events:   events   ? events.values[0][0]   : 0,
      db_path:  process.env.DB_PATH || 'db/dungeon.sqlite',
      uptime_s: process.uptime(),
    });
  });

  /**
   * GET /api/world — Evento global activo del dungeon (T090)
   */
  app.get('/api/world', (req, res) => {
    const ev = worldEvents.getCurrentEvent();
    const nextText = worldEvents.getNextEventText();
    res.json({
      active_event: ev || null,
      next_event_info: ev ? null : nextText,
    });
  });

  /**
   * GET  /api/admin/cleanup?dry=true  — Listar jugadores candidatos a borrado (DIS-007)
   * POST /api/admin/cleanup           — Eliminar jugadores de test / inactivos
   *
   * Body JSON opcional para POST:
   *   { "olderThanDays": 7, "includeTestNames": true, "ids": ["id1","id2"] }
   *   - ids: lista explícita (borra solo esos); si se omite, borra todos los candidatos
   *
   * Protegido por ADMIN_TOKEN env var.
   */
  function _adminAuth(req, res) {
    const adminToken = process.env.ADMIN_TOKEN;
    if (!adminToken) return true;
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (token !== adminToken) {
      res.status(401).json({ error: 'Unauthorized. Provide: Authorization: Bearer <ADMIN_TOKEN>' });
      return false;
    }
    return true;
  }

  app.get('/api/admin/cleanup', (req, res) => {
    if (!_adminAuth(req, res)) return;
    const olderThanDays = parseInt(req.query.olderThanDays || '7', 10);
    const includeTestNames = req.query.includeTestNames !== 'false';
    const candidates = db.getTestPlayers({ olderThanDays, includeTestNames });
    res.json({
      count: candidates.length,
      note: 'GET lista candidatos. POST /api/admin/cleanup para eliminarlos.',
      players: candidates,
    });
  });

  app.post('/api/admin/cleanup', (req, res) => {
    if (!_adminAuth(req, res)) return;
    const { olderThanDays = 7, includeTestNames = true, ids } = req.body || {};
    let toDelete;
    if (Array.isArray(ids) && ids.length > 0) {
      toDelete = ids.map(id => ({ id }));
    } else {
      toDelete = db.getTestPlayers({ olderThanDays, includeTestNames });
    }
    const deleted = [];
    for (const p of toDelete) {
      db.deletePlayer(p.id);
      deleted.push(p.id || p);
    }
    db.persist();
    console.log(`[admin] cleanup: ${deleted.length} jugadores eliminados.`);
    res.json({ deleted: deleted.length, ids: deleted });
  });

  // 5. Crear servidor HTTP
  /**
   * POST /api/action  — Endpoint LLM-friendly (T034)
   * Devuelve: resultado de texto + estado completo post-acción
   */
  app.post('/api/action', (req, res) => {
    const { player_id, command } = req.body;
    if (!player_id || !command) {
      return res.status(400).json({ error: 'Se requiere player_id y command.' });
    }

    const result = execute(player_id, command);

    // Construir estado post-acción igual que /api/state
    const player  = db.getPlayer(player_id);
    if (!player) return res.status(404).json({ error: 'Jugador no encontrado.' });

    const room     = db.getRoom(player.current_room_id);
    const monsters = db.getMonstersInRoom(player.current_room_id);
    const others   = db.getPlayersInRoom(player.current_room_id)
                       .filter(p => p.id !== player.id)
                       .map(p => `${p.username} (HP: ${p.hp}/${p.max_hp})`);
    const events   = db.getRecentEvents(player.current_room_id, 5)
                       .map(e => e.result);

    res.json({
      result: result.text,
      state: {
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
          level: player.level || 1,
          xp: player.xp || 0,
          kills: player.kills || 0,
          equipped_weapon: player.equipped_weapon || null,
          equipped_armor: player.equipped_armor || null,
          playtime_minutes: player.playtime_minutes || 0,
        },
        other_players: others,
        recent_events: events,
      },
    });
  });

  // 5. Crear servidor HTTP
  const server = http.createServer(app);

  // 6. Socket.io — Multijugador en tiempo real (Fase 4)
  const { Server } = require('socket.io');
  const io = new Server(server, {
    cors: { origin: '*' },
  });
  registerHandlers(io);

  // 7. Arrancar servidor
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🏰 Dungeon of Echoes corriendo en http://0.0.0.0:${PORT}`);
    console.log(`   Versión 0.6.0 — Fases 1-6 completas (Frontend + API LLM)`);
    console.log(`   Presioná Ctrl+C para apagar\n`);
  });

  // 8. Respawn loop: checar cada 60 segundos
  setInterval(checkRespawns, 60_000);

  // 9. Trap respawn loop: reactivar trampas desactivadas cada 60 segundos
  setInterval(() => db.checkTrapRespawns(), 60_000);

  // T143: Training dummy regen loop — regenerar maniquíes en sala 21 cada 10 segundos
  const TRAINING_DUMMY_IDS_SERVER = [23, 24, 25];
  setInterval(() => {
    for (const dummyId of TRAINING_DUMMY_IDS_SERVER) {
      const dummy = db.getMonster(dummyId);
      if (dummy && dummy.hp < dummy.max_hp) {
        db.updateMonster(dummyId, { hp: dummy.max_hp, room_id: 21 });
      }
    }
  }, 10_000);

  // T144: Bounty expiration loop — expirar recompensas vencidas y devolver oro cada minuto
  setInterval(() => {
    db.expireOldBounties();
  }, 60_000);

  // T181: Expirar anuncios del mercado cada 5 minutos (devolver ítems a vendedores)
  setInterval(() => {
    const expired = db.expireOldMarketListings();
    for (const listing of expired) {
      // Devolver el ítem al vendedor si existe
      const seller = db.getPlayer(listing.seller_id);
      if (seller) {
        const inv = seller.inventory || [];
        inv.push(listing.item_name);
        db.updatePlayer(listing.seller_id, { inventory: JSON.stringify(inv) });
        // Notificar al vendedor si está online
        const { playerSockets } = require('./socket/handlers');
        const sellerSocket = playerSockets.get(listing.seller_id);
        if (sellerSocket) {
          sellerSocket.emit('event', {
            type: 'info',
            text: `⏰ Tu anuncio de "${listing.item_name}" expiró sin venderse. El ítem fue devuelto a tu inventario.`,
          });
        }
      }
    }
  }, 5 * 60_000);

  // 10. Quest loop: iniciar quest activa + rotar cada 5 minutos si pasaron 30 min
  quests.loadQuest();
  setInterval(() => {
    const newQuest = quests.maybeRotateQuest();
    if (newQuest) {
      // Anunciar nueva quest a todos los jugadores conectados
      io.emit('shout', {
        username: '📜 SISTEMA',
        message: `¡Nueva quest disponible! "${newQuest.questDef.title}" — Escribí "quest" para ver los detalles.`,
      });
      console.log(`[quests] Quest rotada: ${newQuest.questDef.title}`);
    }
  }, 5 * 60_000);

  // 11. World Events loop: verificar cada 60 segundos si hay que activar/desactivar evento
  setInterval(() => {
    const result = worldEvents.tick();
    if (result) {
      io.emit('shout', {
        username: '🌍 DUNGEON',
        message: result.message,
      });
      console.log(`[worldEvents] ${result.type}: ${result.event.name}`);
    }

    // T166: Weather tick — cambiar clima cada 60 minutos
    const weatherResult = weather.tick();
    if (weatherResult) {
      io.emit('shout', {
        username: '🌦️ CLIMA',
        message: weatherResult.message,
      });
      console.log(`[weather] Nuevo clima: ${weatherResult.weather.name}`);
    }
  }, 60_000);

  // 12. Auction resolution loop: resolver subastas expiradas cada 30 segundos
  setInterval(() => {
    resolveExpiredAuctions((msg) => {
      io.emit('shout', { username: '🔨 REMATE', message: msg });
      console.log(`[auctions] ${msg}`);
    });
  }, 30_000);

  // 13. T130: Regeneración periódica de sala sagrada (sala 1 — Entrada del Dungeon)
  // Cada 10s, los jugadores con HP < max que estén en la sala sagrada recuperan 1 HP.
  const SACRED_ROOM_ID = 1;
  setInterval(() => {
    try {
      const players = db.getPlayersInRoom(SACRED_ROOM_ID);
      for (const p of players) {
        if (p.hp > 0 && p.hp < p.max_hp) {
          const newHp = Math.min(p.max_hp, p.hp + 1);
          db.updatePlayer(p.id, { hp: newHp });
          // Notificar solo al jugador afectado (si está conectado)
          const targetSocket = playerSockets.get(p.id);
          if (targetSocket) {
            targetSocket.emit('event', {
              type: 'sacred_regen',
              message: `✨ El aura sagrada te restaura 1 HP. (${newHp}/${p.max_hp} HP)`,
            });
          }
        }
      }
    } catch (e) {
      console.error('[sacredRegen] Error:', e.message);
    }
  }, 10_000);

  // 14. T188: Expiración de posts del tablón cada hora
  setInterval(() => {
    try {
      db.expireOldBulletinPosts();
    } catch (e) {
      console.error('[bulletin] Error expirando posts:', e.message);
    }
  }, 60 * 60 * 1000);

  // 15. T203: Monstruos errantes — el Goblin Merodeador y la Rata Gigante se mueven cada 90 segundos
  setInterval(() => {
    try {
      wanderMonsters((monsterId, monsterName, fromRoomId, toRoomId) => {
        const { playerSockets } = require('./socket/handlers');
        // Notificar a jugadores en la sala de origen
        const fromPlayers = db.getPlayersInRoom(fromRoomId);
        for (const p of fromPlayers) {
          const sock = playerSockets.get(p.id);
          if (sock) {
            sock.emit('event', {
              type: 'info',
              text: `👣 El ${monsterName} abandona la sala y desaparece entre las sombras...`,
            });
          }
        }
        // Notificar a jugadores en la sala destino
        const toPlayers = db.getPlayersInRoom(toRoomId);
        for (const p of toPlayers) {
          const sock = playerSockets.get(p.id);
          if (sock) {
            sock.emit('event', {
              type: 'warning',
              text: `⚠️  ¡Un ${monsterName} aparece en la sala desde la oscuridad!`,
            });
          }
        }
      });
    } catch (e) {
      console.error('[wander] Error en loop de monstruos errantes:', e.message);
    }
  }, 90_000);
}

main().catch(err => {
  console.error('Error fatal al arrancar:', err);
  process.exit(1);
});
