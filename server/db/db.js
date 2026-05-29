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

function getPlayersInRoom(roomId) {
  return all('SELECT * FROM players WHERE current_room_id = ?', [roomId])
    .map(p => ({ ...p, inventory: JSON.parse(p.inventory), status_effects: p.status_effects ? JSON.parse(p.status_effects) : {} }));
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
    `SELECT username, level, xp, kills, hp, max_hp, deaths
     FROM players
     ORDER BY kills DESC, xp DESC, level DESC
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

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  init, persist,
  // players
  getPlayer, getPlayerByUsername, createPlayer, updatePlayer, touchPlayer, getPlayersInRoom, getActivePlayers, getLeaderboard,
  // rooms
  getRoom, getAllRooms, upsertRoom, updateRoomItems, updateRoomTrap, checkTrapRespawns,
  // monsters
  getMonster, getMonstersInRoom, upsertMonster, updateMonster,
  // events
  logEvent, getRecentEvents,
  // offline messages (tell)
  saveOfflineMessage, getPendingMessages, markMessagesDelivered, countPendingMessages,
  // guilds
  getGuild, getGuildMembers, createGuild, deleteGuild, setPlayerGuild, getAllGuilds,
  // global events (T093)
  logGlobalEvent, getGlobalEvents,
  // acceso raw (por si acaso)
  raw: () => db,
};
