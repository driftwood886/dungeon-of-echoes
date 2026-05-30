/**
 * db.js — Módulo de acceso a SQLite (via sql.js / WebAssembly)
 *
 * sql.js usa SQLite compilado a WASM, sin dependencias nativas.
 * La base de datos vive en memoria durante el proceso; se persiste a disco
 * periódicamente y al apagar el servidor.
 */

'use strict';

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

// Soportar DB_PATH via variable de entorno (Fly.io usa /data/dungeon.sqlite en volumen)
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../db/dungeon.sqlite');

let db = null; // instancia global de sql.js Database

// ─── Inicialización ──────────────────────────────────────────────────────────

async function init() {
  const SQL = await initSqlJs();

  // Cargar desde disco si existe
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
    console.log('[db] Cargada BD existente desde', DB_PATH);
  } else {
    db = new SQL.Database();
    console.log('[db] Nueva BD en memoria');
  }

  // Crear tablas
  db.run(`
    CREATE TABLE IF NOT EXISTS players (
      id          TEXT PRIMARY KEY,
      username    TEXT UNIQUE NOT NULL,
      hp          INTEGER NOT NULL DEFAULT 30,
      max_hp      INTEGER NOT NULL DEFAULT 30,
      attack      INTEGER NOT NULL DEFAULT 5,
      defense     INTEGER NOT NULL DEFAULT 2,
      current_room_id INTEGER NOT NULL DEFAULT 1,
      inventory   TEXT NOT NULL DEFAULT '[]',
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen   TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS rooms (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT NOT NULL,
      exits       TEXT NOT NULL DEFAULT '{}',
      items       TEXT NOT NULL DEFAULT '[]',
      is_generated INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS monsters (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT NOT NULL,
      hp          INTEGER NOT NULL,
      max_hp      INTEGER NOT NULL,
      attack      INTEGER NOT NULL DEFAULT 4,
      room_id     INTEGER,
      loot        TEXT NOT NULL DEFAULT '[]',
      respawn_room_id INTEGER,
      respawn_at  TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id TEXT,
      room_id   INTEGER,
      action    TEXT NOT NULL,
      result    TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Guardar al disco periódicamente (cada 30 segundos)
  setInterval(persist, 30_000);

  // Tabla de mensajes offline (tell)
  db.run(`
    CREATE TABLE IF NOT EXISTS offline_messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_username TEXT NOT NULL,
      target_player_id TEXT NOT NULL,
      message     TEXT NOT NULL,
      delivered   INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Migraciones: agregar columnas nuevas si no existen
  // sql.js lanza error si la columna ya existe, lo ignoramos.
  // Tabla de guilds
  db.run(`
    CREATE TABLE IF NOT EXISTS guilds (
      id          TEXT PRIMARY KEY,
      name        TEXT UNIQUE NOT NULL,
      leader_id   TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const migrations = [
    `ALTER TABLE players ADD COLUMN xp     INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE players ADD COLUMN level  INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE players ADD COLUMN kills  INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE players ADD COLUMN equipped_weapon TEXT`,
    `ALTER TABLE rooms   ADD COLUMN trap   TEXT`,
    `ALTER TABLE players ADD COLUMN last_rest TEXT`,
    `ALTER TABLE players ADD COLUMN deaths INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE players ADD COLUMN status_effects TEXT NOT NULL DEFAULT '{}'`,
    `ALTER TABLE players ADD COLUMN gold INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE players ADD COLUMN achievements TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE players ADD COLUMN quest_progress TEXT NOT NULL DEFAULT '{}'`,
    `ALTER TABLE players ADD COLUMN guild TEXT`,
    `ALTER TABLE players ADD COLUMN duel_wins INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE players ADD COLUMN duel_losses INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE players ADD COLUMN tutorial_step INTEGER`,
    `ALTER TABLE players ADD COLUMN forage_data TEXT NOT NULL DEFAULT '{}'`,
    `ALTER TABLE players ADD COLUMN pet TEXT`,
    `ALTER TABLE players ADD COLUMN last_meditate TEXT`,
    `ALTER TABLE players ADD COLUMN party_id TEXT`,  // T102: sistema de grupos
    `ALTER TABLE players ADD COLUMN mana INTEGER NOT NULL DEFAULT 20`,    // T104: sistema de magia
    `ALTER TABLE players ADD COLUMN max_mana INTEGER NOT NULL DEFAULT 20`, // T104
    `ALTER TABLE players ADD COLUMN last_mana_regen TEXT`,                // T104: timestamp última recarga
    `ALTER TABLE players ADD COLUMN shield_active INTEGER NOT NULL DEFAULT 0`, // T104: escudo activo
    `ALTER TABLE players ADD COLUMN player_class TEXT NOT NULL DEFAULT 'sin_clase'`, // T107: clase de personaje
    `ALTER TABLE players ADD COLUMN bestiary TEXT NOT NULL DEFAULT '{}'`, // T108: bestiario personal
    `ALTER TABLE monsters ADD COLUMN status_effects TEXT NOT NULL DEFAULT '{}'`, // T110: efectos on_hit en monstruos
    `ALTER TABLE players ADD COLUMN journal TEXT NOT NULL DEFAULT '[]'`, // T113: diario del aventurero
    `ALTER TABLE players ADD COLUMN skill_cooldowns TEXT NOT NULL DEFAULT '{}'`, // T114: cooldowns de habilidades activas
    `ALTER TABLE players ADD COLUMN gold_spent INTEGER NOT NULL DEFAULT 0`,    // T115: logros secretos (oro gastado)
    `ALTER TABLE players ADD COLUMN crafts_count INTEGER NOT NULL DEFAULT 0`,  // T115: logros secretos (crafteos)
    `ALTER TABLE players ADD COLUMN rooms_visited TEXT NOT NULL DEFAULT '[]'`, // T115: logros secretos (salas visitadas)
    `ALTER TABLE players ADD COLUMN notes TEXT NOT NULL DEFAULT '[]'`,          // T116: notas personales del jugador
    `ALTER TABLE players ADD COLUMN reputation INTEGER NOT NULL DEFAULT 0`,      // T125: sistema de reputación
    `ALTER TABLE players ADD COLUMN last_recall TEXT`,                            // T131: comando recall
    `ALTER TABLE players ADD COLUMN runes TEXT NOT NULL DEFAULT '{}'`,             // T140: runas coleccionables
    `ALTER TABLE players ADD COLUMN daily_challenge TEXT NOT NULL DEFAULT '{}'`,  // T141: desafío diario personal
  ];
  for (const sql of migrations) {
    try { db.run(sql); } catch (_) { /* columna ya existe */ }
  }

  // Tabla de historial de eventos globales (T093)
  db.run(`
    CREATE TABLE IF NOT EXISTS global_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      type       TEXT NOT NULL,
      message    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Tabla de subastas (T098)
  db.run(`
    CREATE TABLE IF NOT EXISTS auctions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      seller_id     TEXT NOT NULL,
      seller_name   TEXT NOT NULL,
      item_name     TEXT NOT NULL,
      min_price     INTEGER NOT NULL,
      current_bid   INTEGER NOT NULL DEFAULT 0,
      bidder_id     TEXT,
      bidder_name   TEXT,
      ends_at       TEXT NOT NULL,
      closed        INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Guardar al apagar
  process.on('exit', persist);
  process.on('SIGINT', () => { persist(); process.exit(0); });
  process.on('SIGTERM', () => { persist(); process.exit(0); });

  console.log('[db] Inicializada OK');
  return db;
}

function persist() {
  if (!db) return;
  try {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
    console.log('[db] Persistida en disco');
  } catch (err) {
    console.error('[db] Error al persistir:', err.message);
  }
}

// ─── Helpers internos ────────────────────────────────────────────────────────

function one(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function all(sql, params = []) {
  const results = db.exec(sql, params);
  if (!results.length) return [];
  const { columns, values } = results[0];
  return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

function run(sql, params = []) {
  db.run(sql, params);
}

// ─── Players ─────────────────────────────────────────────────────────────────

function getPlayer(id) {
  const p = one('SELECT * FROM players WHERE id = ?', [id]);
  if (p) {
    p.inventory = JSON.parse(p.inventory);
    p.status_effects = p.status_effects ? JSON.parse(p.status_effects) : {};
  }
  return p;
}

function getPlayerByUsername(username) {
  const p = one('SELECT * FROM players WHERE username = ?', [username]);
  if (p) {
    p.inventory = JSON.parse(p.inventory);
    p.status_effects = p.status_effects ? JSON.parse(p.status_effects) : {};
  }
  return p;
}

function createPlayer(username) {
  const id = randomUUID();
  run(
    `INSERT INTO players (id, username) VALUES (?, ?)`,
    [id, username]
  );
  return getPlayer(id);
}

function updatePlayer(id, fields) {
  const updates = Object.keys(fields)
    .map(k => `${k} = ?`)
    .join(', ');
  const values = Object.values(fields).map(v =>
    typeof v === 'object' ? JSON.stringify(v) : v
  );
  run(`UPDATE players SET ${updates} WHERE id = ?`, [...values, id]);
}

function touchPlayer(id) {
  run(`UPDATE players SET last_seen = datetime('now') WHERE id = ?`, [id]);
}

/**
 * T108: Registrar un kill en el bestiario personal del jugador.
 * @param {string} playerId
 * @param {string} monsterName
 */
function addBestiaryKill(playerId, monsterName) {
  const player = one('SELECT bestiary FROM players WHERE id = ?', [playerId]);
  if (!player) return;
  const bestiary = player.bestiary ? JSON.parse(player.bestiary) : {};
  const key = monsterName.toLowerCase();
  if (!bestiary[key]) {
    bestiary[key] = { name: monsterName, kills: 0, first_kill: new Date().toISOString(), last_kill: null };
  }
  bestiary[key].kills += 1;
  bestiary[key].last_kill = new Date().toISOString();
  run('UPDATE players SET bestiary = ? WHERE id = ?', [JSON.stringify(bestiary), playerId]);
}

/**
 * T113: Agregar entrada al diario personal del aventurero.
 * @param {string} playerId
 * @param {string} type — tipo de evento: 'boss'|'quest'|'achievement'|'level'|'death'
 * @param {string} message — texto corto del evento
 */
function addJournalEntry(playerId, type, message) {
  const player = one('SELECT journal FROM players WHERE id = ?', [playerId]);
  if (!player) return;
  const journal = player.journal ? JSON.parse(player.journal) : [];
  journal.push({
    type,
    message,
    at: new Date().toISOString(),
  });
  // Mantener solo los últimos 50 entries para no inflar la BD
  if (journal.length > 50) journal.splice(0, journal.length - 50);
  run('UPDATE players SET journal = ? WHERE id = ?', [JSON.stringify(journal), playerId]);
}

function getPlayersInRoom(roomId) {
  return all('SELECT * FROM players WHERE current_room_id = ?', [roomId])
    .map(p => ({ ...p, inventory: JSON.parse(p.inventory), status_effects: p.status_effects ? JSON.parse(p.status_effects) : {} }));
}

/**
 * Obtiene todos los miembros de un grupo (T102).
 * @param {string} partyId
 * @returns {object[]}
 */
function getPartyMembers(partyId) {
  if (!partyId) return [];
  return all('SELECT id, username, hp, max_hp, level, current_room_id, kills, party_id FROM players WHERE party_id = ?', [partyId]);
}

// ─── Rooms ───────────────────────────────────────────────────────────────────

function getRoom(id) {
  const r = one('SELECT * FROM rooms WHERE id = ?', [id]);
  if (r) {
    r.exits = JSON.parse(r.exits);
    r.items = JSON.parse(r.items);
    r.trap  = r.trap ? JSON.parse(r.trap) : null;
  }
  return r;
}

function getAllRooms() {
  return all('SELECT * FROM rooms').map(r => ({
    ...r,
    exits: JSON.parse(r.exits),
    items: JSON.parse(r.items),
    trap:  r.trap ? JSON.parse(r.trap) : null,
  }));
}

function upsertRoom(room) {
  run(
    `INSERT OR REPLACE INTO rooms (id, name, description, exits, items, is_generated, trap)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      room.id,
      room.name,
      room.description,
      JSON.stringify(room.exits),
      JSON.stringify(room.items || []),
      room.is_generated ? 1 : 0,
      room.trap ? JSON.stringify(room.trap) : null,
    ]
  );
}

function updateRoomItems(roomId, items) {
  run('UPDATE rooms SET items = ? WHERE id = ?', [JSON.stringify(items), roomId]);
}

function updateRoomTrap(roomId, trap) {
  run('UPDATE rooms SET trap = ? WHERE id = ?', [trap ? JSON.stringify(trap) : null, roomId]);
}

/**
 * Reactivar trampas que ya cumplieron su tiempo de respawn.
 * Devuelve la cantidad de trampas reactivadas.
 */
function checkTrapRespawns() {
  const now = new Date().toISOString();
  // Obtener todas las salas con trampa inactiva que tienen respawn_at
  const rooms = all(`SELECT id, trap FROM rooms WHERE trap IS NOT NULL`);
  let count = 0;
  for (const row of rooms) {
    let trap;
    try { trap = JSON.parse(row.trap); } catch (_) { continue; }
    if (!trap || trap.active) continue;
    if (!trap.respawn_at) continue;
    if (trap.respawn_at <= now) {
      // Reactivar trampa
      const reactivated = { ...trap, active: true, respawn_at: null };
      run('UPDATE rooms SET trap = ? WHERE id = ?', [JSON.stringify(reactivated), row.id]);
      count++;
      console.log(`[traps] Trampa reactivada en sala ${row.id} (${trap.type})`);
    }
  }
  return count;
}

// ─── Monsters ────────────────────────────────────────────────────────────────

function getMonster(id) {
  const m = one('SELECT * FROM monsters WHERE id = ?', [id]);
  if (m) m.loot = JSON.parse(m.loot);
  return m;
}

function getMonstersInRoom(roomId) {
  return all('SELECT * FROM monsters WHERE room_id = ?', [roomId])
    .map(m => ({ ...m, loot: JSON.parse(m.loot) }));
}

function upsertMonster(monster) {
  run(
    `INSERT OR REPLACE INTO monsters
       (id, name, description, hp, max_hp, attack, room_id, loot, respawn_room_id, respawn_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      monster.id,
      monster.name,
      monster.description,
      monster.hp,
      monster.max_hp,
      monster.attack,
      monster.room_id,
      JSON.stringify(monster.loot || []),
      monster.respawn_room_id,
      monster.respawn_at || null,
    ]
  );
}

function updateMonster(id, fields) {
  const updates = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  const values = Object.values(fields).map(v =>
    typeof v === 'object' ? JSON.stringify(v) : v
  );
  run(`UPDATE monsters SET ${updates} WHERE id = ?`, [...values, id]);
}

// ─── Events ──────────────────────────────────────────────────────────────────

function logEvent(playerId, roomId, action, result) {
  run(
    `INSERT INTO events (player_id, room_id, action, result) VALUES (?, ?, ?, ?)`,
    [playerId, roomId, action, result]
  );
}

function getRecentEvents(roomId, limit = 5) {
  return all(
    `SELECT * FROM events WHERE room_id = ? ORDER BY id DESC LIMIT ?`,
    [roomId, limit]
  ).reverse();
}

function getActivePlayers(cutoff) {
  return all(
    `SELECT p.*, r.name AS room_name
     FROM players p
     LEFT JOIN rooms r ON r.id = p.current_room_id
     WHERE p.last_seen >= ?
     ORDER BY p.last_seen DESC`,
    [cutoff]
  ).map(p => ({
    ...p,
    inventory: JSON.parse(p.inventory || '[]'),
  }));
}

function getLeaderboard(limit = 10) {
  return all(
    `SELECT username, level, xp, kills, hp, max_hp, deaths, gold, duel_wins
     FROM players
     ORDER BY kills DESC, xp DESC, level DESC
     LIMIT ?`,
    [limit]
  );
}

// T112: Rankings alternativos
function getLeaderboardByGold(limit = 10) {
  return all(
    `SELECT username, level, gold, kills
     FROM players
     ORDER BY gold DESC, level DESC
     LIMIT ?`,
    [limit]
  );
}

function getLeaderboardByDuels(limit = 10) {
  return all(
    `SELECT username, level, duel_wins, duel_losses, kills
     FROM players
     ORDER BY duel_wins DESC, level DESC
     LIMIT ?`,
    [limit]
  );
}

function getLeaderboardByReputation(limit = 10) {
  return all(
    `SELECT username, level, reputation, kills
     FROM players
     ORDER BY reputation DESC, level DESC
     LIMIT ?`,
    [limit]
  );
}

// T135: Ranking por crafteos
function getLeaderboardByCrafts(limit = 10) {
  return all(
    `SELECT username, level, crafts_count, kills
     FROM players
     ORDER BY crafts_count DESC, level DESC
     LIMIT ?`,
    [limit]
  );
}

// ─── Offline Messages (tell) ─────────────────────────────────────────────────

function saveOfflineMessage(senderUsername, targetPlayerId, message) {
  run(
    `INSERT INTO offline_messages (sender_username, target_player_id, message) VALUES (?, ?, ?)`,
    [senderUsername, targetPlayerId, message]
  );
}

function getPendingMessages(targetPlayerId) {
  return all(
    `SELECT * FROM offline_messages WHERE target_player_id = ? AND delivered = 0 ORDER BY id ASC`,
    [targetPlayerId]
  );
}

function markMessagesDelivered(targetPlayerId) {
  run(
    `UPDATE offline_messages SET delivered = 1 WHERE target_player_id = ? AND delivered = 0`,
    [targetPlayerId]
  );
}

function countPendingMessages(targetPlayerId) {
  const row = one(
    `SELECT COUNT(*) as cnt FROM offline_messages WHERE target_player_id = ? AND delivered = 0`,
    [targetPlayerId]
  );
  return row ? row.cnt : 0;
}

function getRecentMessages(targetPlayerId, limit = 5) {
  return all(
    `SELECT * FROM offline_messages WHERE target_player_id = ? ORDER BY id DESC LIMIT ?`,
    [targetPlayerId, limit]
  ).reverse();
}

// ─── Guilds ───────────────────────────────────────────────────────────────────

function getGuild(name) {
  return one('SELECT * FROM guilds WHERE name = ?', [name]);
}

function getGuildMembers(guildName) {
  return all(
    'SELECT id, username, level, hp, max_hp, kills, current_room_id FROM players WHERE guild = ?',
    [guildName]
  );
}

function createGuild(id, name, leaderId) {
  run('INSERT INTO guilds (id, name, leader_id) VALUES (?, ?, ?)', [id, name, leaderId]);
}

function deleteGuild(name) {
  run('DELETE FROM guilds WHERE name = ?', [name]);
}

function setPlayerGuild(playerId, guildName) {
  run('UPDATE players SET guild = ? WHERE id = ?', [guildName || null, playerId]);
}

function getAllGuilds() {
  return all(`
    SELECT g.name, g.leader_id, p.username AS leader_name,
           COUNT(m.id) AS member_count
    FROM guilds g
    LEFT JOIN players p ON p.id = g.leader_id
    LEFT JOIN players m ON m.guild = g.name
    GROUP BY g.name
  `);
}

// ─── Eventos Globales (T093) ─────────────────────────────────────────────────

/**
 * Registra un evento global en la crónica del dungeon.
 * @param {string} type    — Categoría: 'boss', 'quest', 'achievement', 'duel', 'level', 'misc'
 * @param {string} message — Descripción del evento para mostrar a los jugadores
 */
function logGlobalEvent(type, message) {
  run('INSERT INTO global_events (type, message) VALUES (?, ?)', [type, message]);
}

/**
 * Devuelve los últimos N eventos globales, ordenados del más reciente al más viejo.
 * @param {number} limit — Máximo de eventos a devolver (default 10)
 */
function getGlobalEvents(limit = 10) {
  return all(
    'SELECT * FROM global_events ORDER BY id DESC LIMIT ?',
    [limit]
  );
}

/**
 * Devuelve eventos globales ocurridos después de una fecha.
 * @param {string} afterIso — ISO timestamp
 * @param {number} limit
 */
function getGlobalEventsSince(afterIso, limit = 20) {
  return all(
    'SELECT * FROM global_events WHERE created_at > ? ORDER BY id DESC LIMIT ?',
    [afterIso, limit]
  );
}

/**
 * Cuenta kills totales en el dungeon (desde global_events tipo 'level' o de events tabla).
 * Aproximación: contar eventos de tipo 'boss' o 'achievement' desde una fecha.
 */
function countKillsSince(afterIso) {
  const result = one(
    `SELECT COUNT(*) as total FROM events WHERE action LIKE 'attack%' AND timestamp > ?`,
    [afterIso]
  );
  return result ? result.total : 0;
}

// ─── Subastas (T098) ─────────────────────────────────────────────────────────

/**
 * Crear una nueva subasta.
 * @param {string} sellerId — ID del vendedor
 * @param {string} sellerName — username del vendedor
 * @param {string} itemName — nombre del ítem
 * @param {number} minPrice — precio mínimo (en oro)
 * @param {number} durationMs — duración en ms (default 5 minutos)
 * @returns {object} — la subasta creada
 */
function createAuction(sellerId, sellerName, itemName, minPrice, durationMs = 5 * 60 * 1000) {
  const endsAt = new Date(Date.now() + durationMs).toISOString();
  run(
    `INSERT INTO auctions (seller_id, seller_name, item_name, min_price, current_bid, ends_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [sellerId, sellerName, itemName, minPrice, 0, endsAt]
  );
  const row = one(`SELECT * FROM auctions WHERE seller_id = ? AND item_name = ? AND closed = 0 ORDER BY id DESC LIMIT 1`, [sellerId, itemName]);
  return row;
}

/**
 * Obtener subastas activas (no cerradas y no expiradas).
 */
function getActiveAuctions() {
  return all(
    `SELECT * FROM auctions WHERE closed = 0 AND ends_at > datetime('now') ORDER BY ends_at ASC`
  );
}

/**
 * Obtener una subasta por ID.
 */
function getAuction(id) {
  return one(`SELECT * FROM auctions WHERE id = ?`, [id]);
}

/**
 * Realizar una puja en una subasta.
 * @returns {{ ok: boolean, error?: string }}
 */
function placeBid(auctionId, bidderId, bidderName, amount) {
  const auction = getAuction(auctionId);
  if (!auction) return { ok: false, error: 'Subasta no encontrada.' };
  if (auction.closed) return { ok: false, error: 'Esa subasta ya está cerrada.' };
  const now = new Date().toISOString();
  if (auction.ends_at <= now) return { ok: false, error: 'Esa subasta ya expiró.' };
  if (auction.seller_id === bidderId) return { ok: false, error: 'No podés pujar en tu propia subasta.' };

  const minBid = auction.current_bid > 0 ? auction.current_bid + 1 : auction.min_price;
  if (amount < minBid) {
    return { ok: false, error: `La puja mínima es ${minBid}g. (actual: ${auction.current_bid}g, mínimo inicial: ${auction.min_price}g)` };
  }

  run(
    `UPDATE auctions SET current_bid = ?, bidder_id = ?, bidder_name = ? WHERE id = ?`,
    [amount, bidderId, bidderName, auctionId]
  );
  return { ok: true, prevBidder: auction.bidder_id, prevBidderAmount: auction.current_bid };
}

/**
 * Cerrar subastas expiradas y resolver el remate (pagar al vendedor, dar ítem al ganador).
 * Devuelve lista de subastas cerradas con resultado para broadcast.
 * La lógica de inventario/gold se maneja en engine.js ya que requiere conocimiento de ítems.
 */
function closeExpiredAuctions() {
  const expired = all(
    `SELECT * FROM auctions WHERE closed = 0 AND ends_at <= datetime('now')`
  );
  for (const a of expired) {
    run(`UPDATE auctions SET closed = 1 WHERE id = ?`, [a.id]);
  }
  return expired;
}

// ─── T115: Helpers para logros secretos ───────────────────────────────────────

/**
 * Registra una visita a una sala. Devuelve el array actualizado de salas visitadas.
 * @param {string|number} playerId
 * @param {number} roomId
 * @returns {number[]} array de IDs de salas visitadas (sin duplicados)
 */
function trackRoomVisit(playerId, roomId) {
  const p = getPlayer(playerId);
  if (!p) return [];
  let visited = [];
  try { visited = JSON.parse(p.rooms_visited || '[]'); } catch (_) {}
  if (!visited.includes(roomId)) {
    visited.push(roomId);
    updatePlayer(playerId, { rooms_visited: JSON.stringify(visited) });
  }
  return visited;
}

/**
 * Incrementa gold_spent del jugador en `amount`.
 * @param {string|number} playerId
 * @param {number} amount
 * @returns {number} nuevo total de gold_spent
 */
function addGoldSpent(playerId, amount) {
  const p = getPlayer(playerId);
  if (!p) return 0;
  const newTotal = (p.gold_spent || 0) + amount;
  updatePlayer(playerId, { gold_spent: newTotal });
  return newTotal;
}

/**
 * Incrementa crafts_count del jugador en 1 y devuelve el nuevo total.
 * @param {string|number} playerId
 * @returns {number} nuevo total de crafteos
 */
function addCraftsCount(playerId) {
  const p = getPlayer(playerId);
  if (!p) return 0;
  const newTotal = (p.crafts_count || 0) + 1;
  updatePlayer(playerId, { crafts_count: newTotal });
  return newTotal;
}

// ─── Reputación (T125) ────────────────────────────────────────────────────────

/**
 * Niveles de reputación con umbrales de puntos.
 * Desconocido: 0–9 | Conocido: 10–24 | Respetado: 25–49 | Famoso: 50–99 | Legendario: 100+
 */
const REPUTATION_LEVELS = [
  { min: 0,   name: 'Desconocido', icon: '👤' },
  { min: 10,  name: 'Conocido',    icon: '🗣️' },
  { min: 25,  name: 'Respetado',   icon: '🏅' },
  { min: 50,  name: 'Famoso',      icon: '⭐' },
  { min: 100, name: 'Legendario',  icon: '🌟' },
];

/**
 * Devuelve el nivel de reputación para una cantidad de puntos.
 * @param {number} points
 * @returns {{ name: string, icon: string, points: number, nextThreshold: number|null }}
 */
function getReputationLevel(points) {
  let level = REPUTATION_LEVELS[0];
  for (const l of REPUTATION_LEVELS) {
    if (points >= l.min) level = l;
  }
  const idx = REPUTATION_LEVELS.indexOf(level);
  const next = idx < REPUTATION_LEVELS.length - 1 ? REPUTATION_LEVELS[idx + 1].min : null;
  return { ...level, points, nextThreshold: next };
}

/**
 * Incrementa la reputación del jugador en `amount` puntos.
 * @param {string|number} playerId
 * @param {number} amount — puntos a agregar (kill=1, quest=5, logro=3)
 * @returns {{ newPoints: number, level: object, leveledUp: boolean }}
 */
function addReputation(playerId, amount) {
  const p = getPlayer(playerId);
  if (!p) return { newPoints: 0, level: getReputationLevel(0), leveledUp: false };
  const oldPoints = p.reputation || 0;
  const newPoints = oldPoints + amount;
  updatePlayer(playerId, { reputation: newPoints });
  const oldLevel = getReputationLevel(oldPoints);
  const newLevel = getReputationLevel(newPoints);
  const leveledUp = newLevel.name !== oldLevel.name;
  return { newPoints, level: newLevel, leveledUp };
}

// ─── Sistema de Runas (T140) ─────────────────────────────────────────────────

const RUNE_TYPES = ['fuego', 'hielo', 'sombra', 'luz', 'caos'];
const RUNE_EMOJIS = { fuego: '🔥', hielo: '❄️', sombra: '🌑', luz: '✨', caos: '🌀' };
// Al completar set de 3, bonus permanente
const RUNE_BONUSES = {
  fuego:  { stat: 'attack',  amount: 1,  label: '+1 ATK permanente' },
  hielo:  { stat: 'max_hp',  amount: 5,  label: '+5 HP máximo permanente' },
  sombra: { stat: 'defense', amount: 1,  label: '+1 DEF permanente' },
  luz:    { stat: 'max_hp',  amount: 3,  label: '+3 HP máximo permanente' },
  caos:   { stat: 'mana',    amount: 3,  label: '+3 maná máximo permanente' },
};

/**
 * Intenta dar una runa aleatoria al jugador (15% de chance).
 * Si el jugador ya tiene 2 del mismo tipo y recibe una 3ra, se fusionan automáticamente
 * y se aplica el bonus permanente. Devuelve un mensaje o null.
 */
function tryAddRune(playerId) {
  if (Math.random() > 0.15) return null; // 15% de chance

  const player = getPlayer(playerId);
  if (!player) return null;

  let runes;
  try { runes = JSON.parse(player.runes || '{}'); } catch (_) { runes = {}; }

  // Elegir runa aleatoria, priorizando las que el jugador no tiene en máximo (2)
  const available = RUNE_TYPES.filter(t => (runes[t] || 0) < 2);
  const pool = available.length > 0 ? available : RUNE_TYPES;
  const type = pool[Math.floor(Math.random() * pool.length)];

  const current = runes[type] || 0;

  if (current >= 2) {
    // Fusión: se completa el set de 3
    delete runes[type];
    updatePlayer(playerId, { runes: JSON.stringify(runes) });

    // Aplicar bonus permanente
    const bonus = RUNE_BONUSES[type];
    const pFresh = getPlayer(playerId);
    const newVal = (pFresh[bonus.stat] || 0) + bonus.amount;
    updatePlayer(playerId, { [bonus.stat]: newVal });

    return `✨ ¡Obtuviste la Runa de ${type.charAt(0).toUpperCase() + type.slice(1)} ${RUNE_EMOJIS[type]}!\n¡Completaste un set de 3! Las runas se FUSIONAN → ${bonus.label}`;
  } else {
    // Agregar runa normal
    runes[type] = current + 1;
    updatePlayer(playerId, { runes: JSON.stringify(runes) });
    const needed = 3 - (current + 1);
    return `🔮 Encontrás una Runa de ${type.charAt(0).toUpperCase() + type.slice(1)} ${RUNE_EMOJIS[type]}! (${current + 1}/3 — necesitás ${needed} más para la fusión)`;
  }
}

function getPlayerRunes(playerId) {
  const player = getPlayer(playerId);
  if (!player) return {};
  try { return JSON.parse(player.runes || '{}'); } catch (_) { return {}; }
}

// ─── Daily Challenge (T141) ───────────────────────────────────────────────────

const DAILY_CHALLENGE_TYPES = [
  { type: 'kill',  target: 'Goblin Merodeador',   goal: 3,  desc: 'Matar 3 Goblins Merodeadores' },
  { type: 'kill',  target: 'Esqueleto Guerrero',  goal: 2,  desc: 'Matar 2 Esqueletos Guerreros' },
  { type: 'kill',  target: 'Rata Gigante',        goal: 4,  desc: 'Matar 4 Ratas Gigantes' },
  { type: 'kill',  target: 'Murciélago Vampiro',  goal: 3,  desc: 'Matar 3 Murciélagos Vampiro' },
  { type: 'kill',  target: 'Araña Tejedora',      goal: 2,  desc: 'Matar 2 Arañas Tejedoras' },
  { type: 'kill',  target: 'Espectro del Corredor', goal: 2, desc: 'Matar 2 Espectros del Corredor' },
  { type: 'kill',  target: 'Gólem de Piedra',     goal: 1,  desc: 'Matar al Gólem de Piedra' },
  { type: 'gold',  target: null,                  goal: 50, desc: 'Recoger 50 monedas de oro' },
  { type: 'gold',  target: null,                  goal: 80, desc: 'Recoger 80 monedas de oro' },
  { type: 'craft', target: null,                  goal: 1,  desc: 'Craftear 1 ítem' },
  { type: 'craft', target: null,                  goal: 2,  desc: 'Craftear 2 ítems' },
  { type: 'forage',target: null,                  goal: 2,  desc: 'Explorar (forage) 2 veces con éxito' },
  { type: 'rooms', target: null,                  goal: 5,  desc: 'Visitar 5 salas diferentes' },
];

function getDailyChallenge(player) {
  let ch = {};
  try { ch = JSON.parse(player.daily_challenge || '{}'); } catch (_) { ch = {}; }
  const today = new Date().toISOString().slice(0, 10);
  if (ch.date !== today) {
    // Generar nuevo desafío para hoy (determinístico basado en player.id + fecha)
    const seed = (player.id * 31 + parseInt(today.replace(/-/g, ''), 10)) % DAILY_CHALLENGE_TYPES.length;
    const template = DAILY_CHALLENGE_TYPES[seed];
    ch = { date: today, type: template.type, target: template.target, goal: template.goal, desc: template.desc, progress: 0, done: false };
    updatePlayer(player.id, { daily_challenge: JSON.stringify(ch) });
  }
  return ch;
}

function updateDailyChallengeProgress(playerId, type, target, amount = 1) {
  const player = getPlayer(playerId);
  if (!player) return null;
  const ch = getDailyChallenge(player);
  if (ch.done) return null;
  const today = new Date().toISOString().slice(0, 10);
  if (ch.date !== today) return null;
  if (ch.type !== type) return null;
  if (type === 'kill' && target && ch.target && ch.target.toLowerCase() !== target.toLowerCase()) return null;
  ch.progress = (ch.progress || 0) + amount;
  let reward = null;
  if (ch.progress >= ch.goal) {
    ch.done = true;
    ch.progress = ch.goal;
    reward = { xp: 30, gold: 20, reputation: 5 };
    // Aplicar recompensas
    const xp = (player.xp || 0) + 30;
    const gold = (player.gold || 0) + 20;
    updatePlayer(playerId, { xp, gold, daily_challenge: JSON.stringify(ch) });
    addReputation(playerId, 5);
    addJournalEntry(playerId, '🏆 Desafío diario completado: ' + ch.desc);
  } else {
    updatePlayer(playerId, { daily_challenge: JSON.stringify(ch) });
  }
  return { challenge: ch, reward };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  init, persist,
  // players
  getPlayer, getPlayerByUsername, createPlayer, updatePlayer, touchPlayer, addBestiaryKill, addJournalEntry, getPlayersInRoom, getActivePlayers, getLeaderboard, getLeaderboardByGold, getLeaderboardByDuels, getPartyMembers,
  // reputación (T125)
  addReputation, getReputationLevel, getLeaderboardByReputation, getLeaderboardByCrafts,
  // rooms
  getRoom, getAllRooms, upsertRoom, updateRoomItems, updateRoomTrap, checkTrapRespawns,
  // monsters
  getMonster, getMonstersInRoom, upsertMonster, updateMonster,
  // events
  logEvent, getRecentEvents,
  // offline messages (tell)
  saveOfflineMessage, getPendingMessages, markMessagesDelivered, countPendingMessages, getRecentMessages,
  // guilds
  getGuild, getGuildMembers, createGuild, deleteGuild, setPlayerGuild, getAllGuilds,
  // global events (T093)
  logGlobalEvent, getGlobalEvents, getGlobalEventsSince, countKillsSince,
  // subastas (T098)
  createAuction, getActiveAuctions, getAuction, placeBid, closeExpiredAuctions,
  // acceso raw (por si acaso)
  raw: () => db,
  // T115: logros secretos
  trackRoomVisit, addGoldSpent, addCraftsCount,
  // T140: runas coleccionables
  tryAddRune, getPlayerRunes, RUNE_TYPES, RUNE_EMOJIS, RUNE_BONUSES,
  // T141: desafío diario personal
  getDailyChallenge, updateDailyChallengeProgress,
};