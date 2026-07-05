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
const xpSystem = require('../game/xp.js');

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
  setInterval(persist, 30000);

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
    `ALTER TABLE players ADD COLUMN macros TEXT NOT NULL DEFAULT '{}'`,           // T142: macros personales
    `ALTER TABLE players ADD COLUMN equipped_armor TEXT`,                         // T152: sistema de armaduras
    `ALTER TABLE players ADD COLUMN active_scrolls TEXT NOT NULL DEFAULT '{}'`,   // T153: pergaminos mágicos activos
    `ALTER TABLE players ADD COLUMN stance TEXT NOT NULL DEFAULT 'equilibrado'`,  // T161: postura de combate
    `ALTER TABLE players ADD COLUMN playtime_minutes INTEGER NOT NULL DEFAULT 0`, // T157: tiempo de juego total
    `ALTER TABLE players ADD COLUMN nickname TEXT`,                                // T163: apodo del personaje
    `ALTER TABLE players ADD COLUMN name_color TEXT`,                              // T171: color de nombre en chat
    `ALTER TABLE players ADD COLUMN friends TEXT NOT NULL DEFAULT '[]'`,           // T173: lista de amigos (JSON array de usernames)
    `ALTER TABLE players ADD COLUMN is_hardcore INTEGER NOT NULL DEFAULT 0`,       // T175: modo hardcore
    `ALTER TABLE players ADD COLUMN fallen INTEGER NOT NULL DEFAULT 0`,            // T175: caído en modo hardcore
    `ALTER TABLE players ADD COLUMN fallen_at TEXT`,                               // T175: timestamp de caída
    `ALTER TABLE players ADD COLUMN hardcore_generation INTEGER NOT NULL DEFAULT 1`, // T175: generación del personaje (I, II, III...)
    `ALTER TABLE guilds   ADD COLUMN guild_quest TEXT`,                               // T189: quest colectiva de guild (JSON)
    `ALTER TABLE players ADD COLUMN vault TEXT NOT NULL DEFAULT '[]'`,                // T200: bóveda personal
    `ALTER TABLE players ADD COLUMN epitaph TEXT`,                                    // T201: epitafio personal
    `ALTER TABLE players ADD COLUMN battlecry TEXT`,                                  // T211: grito de batalla personal
    `ALTER TABLE players ADD COLUMN hourly_kills INTEGER NOT NULL DEFAULT 0`,         // T212: kills en la hora actual
    `ALTER TABLE players ADD COLUMN hourly_kills_reset TEXT`,                         // T212: timestamp del último reset horario
    `ALTER TABLE players ADD COLUMN room_notes TEXT NOT NULL DEFAULT '{}'`,           // T218: notas de exploración por sala
     `ALTER TABLE players ADD COLUMN login_streak INTEGER NOT NULL DEFAULT 0`,         // T219: racha de login diario
     `ALTER TABLE players ADD COLUMN last_login_date TEXT`,                             // T219: fecha del último login (YYYY-MM-DD)
    `ALTER TABLE players ADD COLUMN weekly_contract TEXT NOT NULL DEFAULT '{}'`,       // T222: contrato de caza semanal
    `ALTER TABLE players ADD COLUMN aldric_quest TEXT NOT NULL DEFAULT 'none'`,        // T242: quest narrativa con Aldric
    `ALTER TABLE players ADD COLUMN lich_kills INTEGER NOT NULL DEFAULT 0`,             // DIS-D291: ciclos post-endgame
    `ALTER TABLE players ADD COLUMN cycle_best_time INTEGER`,                           // DIS-D291: mejor tiempo de ciclo (minutos de playtime al matar Lich)
    `ALTER TABLE players ADD COLUMN endgame_challenges TEXT NOT NULL DEFAULT '{}'`,     // DIS-D291: desafíos post-boss completados
    `ALTER TABLE players ADD COLUMN last_hp_regen TEXT`,                                // DIS-D326: timestamp última regen pasiva de HP
    `ALTER TABLE players ADD COLUMN known_traps TEXT NOT NULL DEFAULT '{}'`,             // DIS-D370: trampas aprendidas (persistente entre sesiones)
    `ALTER TABLE players ADD COLUMN last_project TEXT`,                                  // DIS-450: timestamp última proyección arcana (habilidad exclusiva de Mago)
    `ALTER TABLE players ADD COLUMN inventory_bonus INTEGER NOT NULL DEFAULT 0`,         // DIS-595: slots extra de inventario (bolsa de lona: +4 por bolsa, máx 2)
    `ALTER TABLE monsters ADD COLUMN defense INTEGER NOT NULL DEFAULT 0`,                // BUG-462: columna defense faltante en monsters (crash en Fase 2 de bosses)
    `ALTER TABLE players ADD COLUMN cycle_start_at TEXT`,                                // DIS-691: timestamp de inicio del ciclo actual (para calcular tiempo de ciclo)
    `ALTER TABLE players ADD COLUMN specialization TEXT`,                                 // DIS-914: especialización de clase (Paladín, Evoker, Asesino, Sanador…)
    `ALTER TABLE players ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0`,              // EPIC-962: personaje archivado por ascensión
    `ALTER TABLE players ADD COLUMN account_username TEXT`,                               // EPIC-962: username original de la cuenta
    `ALTER TABLE players ADD COLUMN ascension_count INTEGER NOT NULL DEFAULT 0`,          // EPIC-962: número de ascensiones de esta cuenta
    `ALTER TABLE players ADD COLUMN legacy_bonus TEXT NOT NULL DEFAULT '{}'`,             // EPIC-962: JSON del bonus de legado a aplicar al siguiente personaje
    `ALTER TABLE legacies ADD COLUMN item_claimed INTEGER NOT NULL DEFAULT 0`,            // T970: ítem heredado reclamado por el sucesor
    `ALTER TABLE players ADD COLUMN npc_memory TEXT NOT NULL DEFAULT '{}'`,               // EPIC-MR-1079: memoria de NPCs (Aldric, Anciano, Escriba)
    `ALTER TABLE players ADD COLUMN aldric_rep INTEGER NOT NULL DEFAULT 0`,                // T-1233: reputación con Aldric (desafíos diarios completados)
    `ALTER TABLE players ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0`,                    // BUG-1247: flag de bot de playtest para excluir del leaderboard
    ];
  for (const sql of migrations) {
    try { db.run(sql); } catch (_) { /* columna ya existe */ }
  }

  // BUG-1247: migración para marcar bots de playtest existentes (nombres con patrones conocidos)
  // Se ejecuta cada vez que se inicia, pero es idempotente (solo actualiza donde is_bot=0)
  try {
    db.run(`
      UPDATE players SET is_bot = 1
      WHERE is_bot = 0 AND (
        username LIKE 'BotTester%' OR username LIKE 'bottest%' OR
        username LIKE 'playtest%' OR username LIKE 'PTBot%' OR
        username LIKE 'DisTester%' OR username LIKE 'PTBotD%' OR
        username LIKE 'DisDesign%' OR username LIKE 'PlayBot%' OR
        username LIKE 'bot\_%' ESCAPE '\\' OR
        username LIKE 'BotPlaytest%' OR username LIKE 'tester%' OR
        username LIKE 'testbot%' OR username LIKE 'pt\_%' ESCAPE '\\' OR
        username LIKE '%_pt' OR username LIKE '%_bot' OR
        username LIKE 'PTDesign%' OR username LIKE '%bugbot%' OR
        username LIKE 'diseno%' OR username LIKE 'diseñador%' OR
        username LIKE 'diseñ%' OR
        username LIKE 'design%' OR username LIKE '%MagoBot%' OR
        username LIKE 'DesignBot%' OR username LIKE 'DesignTest%' OR
        username LIKE 'DesignTester%' OR username LIKE 'DesignerBot%' OR
        username LIKE 'Designer%' OR username LIKE 'DisenoBot%' OR
        username LIKE 'epic_bot%' OR username LIKE 'epicbot%' OR
        username LIKE 'EpicBot%' OR username LIKE 'EpicTest%' OR
        username LIKE 'EpicDesign%' OR
        username LIKE 'pb\_%' ESCAPE '\\' OR
        username LIKE 'HermesPlay%' OR
        username LIKE 'bugtest%' OR username LIKE 'debugbot%' OR
        username LIKE 'BotVerify%' OR username LIKE 'BotTest%' OR
        username LIKE 'BotSearch%' OR username LIKE 'BotJulio%' OR
        username LIKE 'BotMago%' OR username LIKE 'BotBugs%' OR
        username LIKE 'BotFresco%' OR username LIKE 'BotDesign%' OR
        username LIKE 'bot2_%' OR username LIKE 'bot_ciclo%' OR
        username LIKE 'DisDesigner%' OR username LIKE 'DiseñadorPD%' OR
        username LIKE 'playtestbot%' OR username LIKE 'playbot%' OR
        username LIKE 'Cler%Design%' OR username LIKE 'ClerDesign%' OR
        username LIKE 'Verify%' OR username LIKE '%Berser%Test%' OR
        username LIKE 'TestSello%' OR
        username LIKE 'audit\_%' ESCAPE '\\' OR username LIKE 'audit%dis%' OR
        username LIKE 'craft_test%' OR username LIKE 'debug\_%' ESCAPE '\\' OR
        username LIKE 'fix%test%' OR username LIKE 'verif%test%' OR
        username LIKE 'verif_test%' OR username LIKE 'veriftest%'
      )
    `);
  } catch (e) {
    console.error('[db] Error en migración is_bot:', e.message);
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

  // T144: Tabla de bounties (recompensas PvP)
  db.run(`
    CREATE TABLE IF NOT EXISTS bounties (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      poster_id     TEXT NOT NULL,
      poster_name   TEXT NOT NULL,
      target_id     TEXT NOT NULL,
      target_name   TEXT NOT NULL,
      amount        INTEGER NOT NULL,
      expires_at    TEXT NOT NULL,
      claimed       INTEGER NOT NULL DEFAULT 0,
      claimed_by    TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // T181: Tabla de mercado de jugadores (precio fijo)
  db.run(`
    CREATE TABLE IF NOT EXISTS market_listings (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      seller_id   TEXT NOT NULL,
      seller_name TEXT NOT NULL,
      item_name   TEXT NOT NULL,
      price       INTEGER NOT NULL,
      expires_at  TEXT NOT NULL,
      sold        INTEGER NOT NULL DEFAULT 0,
      buyer_name  TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // T147: Tabla de mensajes en las paredes (graffiti)
  db.run(`
    CREATE TABLE IF NOT EXISTS wall_messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id    INTEGER NOT NULL,
      player_name TEXT NOT NULL,
      message    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // T188: Tablón global de anuncios
  db.run(`
    CREATE TABLE IF NOT EXISTS bulletin_board (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      author_id   TEXT NOT NULL,
      author_name TEXT NOT NULL,
      message     TEXT NOT NULL,
      expires_at  TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // T194: Tabla de metas globales (world goals)
  db.run(`
    CREATE TABLE IF NOT EXISTS world_goals (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      category   TEXT NOT NULL,
      milestone  INTEGER NOT NULL,
      value      INTEGER NOT NULL DEFAULT 0,
      reached_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // T195: Tabla de récords del servidor
  db.run(`
    CREATE TABLE IF NOT EXISTS server_records (
      record_key   TEXT PRIMARY KEY,
      value        INTEGER NOT NULL DEFAULT 0,
      holder_name  TEXT,
      achieved_at  TEXT NOT NULL DEFAULT (datetime('now')),
      description  TEXT
    )
  `);

  // EPIC-MR-1083: Tabla de World State colectivo (estado semanal del dungeon)
  db.run(`
    CREATE TABLE IF NOT EXISTS world_state (
      key        TEXT PRIMARY KEY,
      value      INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // EPIC-1156: Tabla de Expediciones (sistema de misiones narrativas de sesión)
  db.run(`
    CREATE TABLE IF NOT EXISTS expeditions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id       TEXT    NOT NULL,
      expedition_id   TEXT    NOT NULL,
      state           TEXT    NOT NULL DEFAULT 'active',
      step            INTEGER NOT NULL DEFAULT 1,
      data            TEXT    NOT NULL DEFAULT '{}',
      started_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      completed_at    TEXT,
      last_updated    TEXT    NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (player_id) REFERENCES players(id)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_expeditions_player_state ON expeditions (player_id, state)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_expeditions_expedition_completed ON expeditions (expedition_id, state)`);

  // T-1224 / EPIC Gaceta del Corredor — Tabla de eventos globales activos del dungeon
  db.run(`
    CREATE TABLE IF NOT EXISTS active_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id    TEXT    NOT NULL,
      event_type  TEXT    NOT NULL DEFAULT 'global',
      room_id     INTEGER,
      started_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      expires_at  TEXT    NOT NULL,
      data        TEXT    NOT NULL DEFAULT '{}'
    )
  `);

  // Inicializar World State (lazy reset semanal si corresponde)
  initWorldState();

  // EPIC-962: Tabla de legados (Salón de los Caídos — historial de ascensiones)
  db.run(`
    CREATE TABLE IF NOT EXISTS legacies (
      id                TEXT    PRIMARY KEY,
      account_username  TEXT    NOT NULL,
      character_name    TEXT    NOT NULL,
      character_class   TEXT    NOT NULL DEFAULT 'sin_clase',
      specialization    TEXT,
      level_reached     INTEGER NOT NULL DEFAULT 1,
      lich_kills        INTEGER NOT NULL DEFAULT 0,
      legacy_type       TEXT    NOT NULL,
      epitaph           TEXT,
      item_left         TEXT,
      item_room_id      INTEGER,
      ascended_at       TEXT    NOT NULL DEFAULT (datetime('now')),
      ascension_number  INTEGER NOT NULL DEFAULT 1
    )
  `);

  // T156: Tabla de historial de sesiones
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id     TEXT NOT NULL,
      start_time    TEXT NOT NULL,
      duration_min  INTEGER NOT NULL DEFAULT 0,
      kills         INTEGER NOT NULL DEFAULT 0,
      xp_gained     INTEGER NOT NULL DEFAULT 0,
      gold_gained   INTEGER NOT NULL DEFAULT 0,
      commands      INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // T157: Columna playtime_minutes en players
  try { db.run(`ALTER TABLE players ADD COLUMN playtime_minutes INTEGER NOT NULL DEFAULT 0`); } catch (_) {}

  // Fix DIS-P02: Migración automática — corregir monstruos con room_id = "null" (string, bug histórico)
  // Estos monstruos quedaron con room_id = '"null"' en lugar de NULL real por un bug en updateMonster.
  // Los resucitamos en su respawn_room_id si ya pasó el respawn_at (o directamente si no tiene respawn_at).
  try {
    const now = new Date().toISOString();
    const allMonsters = db.exec('SELECT * FROM monsters');
    if (allMonsters.length > 0) {
      const { columns, values } = allMonsters[0];
      const toFix = values.filter(row => {
        const roomId = row[columns.indexOf('room_id')];
        return roomId === 'null' || roomId === null;
      });
      for (const row of toFix) {
        const mId = row[columns.indexOf('id')];
        const maxHp = row[columns.indexOf('max_hp')];
        const respawnRoomId = row[columns.indexOf('respawn_room_id')];
        const respawnAt = row[columns.indexOf('respawn_at')];
        if (!respawnRoomId) continue; // Sin sala de respawn, no hay nada que hacer
        // Resucitar si el respawn_at ya pasó o es null
        if (!respawnAt || respawnAt <= now) {
          db.run('UPDATE monsters SET hp = ?, room_id = ?, respawn_at = NULL WHERE id = ?',
            [maxHp, respawnRoomId, mId]);
          console.log(`[db] Fix DIS-P02: Resucitado monstruo id=${mId} en sala ${respawnRoomId}`);
        }
      }
    }
  } catch (fixErr) {
    console.error('[db] Fix DIS-P02 error:', fixErr.message);
  }

  // BUG-030: Restaurar HP de monstruos vivos con HP < max_hp al reiniciar el servidor
  // Esto evita que monstruos que sobrevivieron con HP bajo entre sesiones queden permanentemente dañados
  try {
    db.run(`UPDATE monsters SET hp = max_hp WHERE room_id IS NOT NULL AND hp < max_hp AND hp > 0`);
    // BUG-050: también mover monstruos con hp=0 pero room_id activo al respawn
    // Estos son zombies que "murieron" sin que se registrara el respawn correctamente
    const now050 = new Date().toISOString();
    const respawnDelay050 = new Date(Date.now() + 60000).toISOString(); // 1 minuto
    db.run(`UPDATE monsters SET hp = max_hp, room_id = NULL, respawn_at = ? WHERE room_id IS NOT NULL AND hp <= 0 AND id NOT IN (23, 24, 25)`, [respawnDelay050]);
    // BUG-643: limpiar status_effects de monstruos vivos al reiniciar
    // Los efectos de veneno/aturdimiento de sesiones anteriores no deben persistir
    db.run(`UPDATE monsters SET status_effects = '{}' WHERE room_id IS NOT NULL`);
    console.log('[db] BUG-030/050/643: HP y status_effects de monstruos vivos restaurados al reiniciar');
  } catch (hpRestoreErr) {
    console.error('[db] BUG-030 HP restore error:', hpRestoreErr.message);
  }

  // T-1229: Tablas para desafíos diarios y semanal colectivo (Gaceta del Corredor - Fase 2)
  db.run(`
    CREATE TABLE IF NOT EXISTS daily_challenge_progress (
      player_id    TEXT NOT NULL,
      challenge_id TEXT NOT NULL,
      count        INTEGER NOT NULL DEFAULT 0,
      date_utc     TEXT NOT NULL,
      PRIMARY KEY (player_id, challenge_id, date_utc)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS weekly_challenge_state (
      week_key    TEXT PRIMARY KEY,
      challenge_id TEXT NOT NULL,
      progress    INTEGER NOT NULL DEFAULT 0,
      target      INTEGER NOT NULL DEFAULT 0,
      reward      TEXT NOT NULL DEFAULT '{}',
      expires_at  TEXT NOT NULL
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
    p.known_traps = p.known_traps ? JSON.parse(p.known_traps) : {};
  }
  return p;
}

function getPlayerByUsername(username) {
  const p = one('SELECT * FROM players WHERE username = ?', [username]);
  if (p) {
    p.inventory = JSON.parse(p.inventory);
    p.status_effects = p.status_effects ? JSON.parse(p.status_effects) : {};
    p.known_traps = p.known_traps ? JSON.parse(p.known_traps) : {};
  }
  return p;
}

/**
 * BUG-1248: Detecta si un username corresponde a un bot de playtest.
 * Centraliza la misma lógica que la migración de BUG-1247 para que aplique
 * también en el momento de creación, no solo al reiniciar el servidor.
 * @param {string} username
 * @returns {boolean}
 */
function isBotUsername(username) {
  if (!username) return false;
  const u = username.toLowerCase();
  return (
    u.startsWith('bottester') || u.startsWith('bottest') ||
    u.startsWith('playtest') || u.startsWith('ptbot') ||
    u.startsWith('distester') || u.startsWith('ptbotd') ||
    u.startsWith('disdesign') || u.startsWith('playbot') ||
    u.startsWith('bot_') || u.startsWith('botplaytest') ||
    u.startsWith('tester') || u.startsWith('testbot') ||
    u.startsWith('pt_') || u.endsWith('_pt') || u.endsWith('_bot') ||
    u.startsWith('ptdesign') || u.includes('bugbot') ||
    u.startsWith('diseno') || u.startsWith('diseñ') || u.startsWith('design') ||
    u.includes('magobot') || u.startsWith('designbot') ||
    u.startsWith('designtest') || u.startsWith('designtester') ||
    u.startsWith('designerbot') || u.startsWith('designer') ||
    u.startsWith('disenobot') || u.startsWith('epic_bot') ||
    u.startsWith('epicbot') || u.startsWith('epictest') ||
    u.startsWith('epicdesign') || u.startsWith('pb_') ||
    u.startsWith('hermesplay') || u.startsWith('bugtest') ||
    u.startsWith('debugbot') || u.startsWith('botverify') ||
    u.startsWith('bottest') || u.startsWith('botsearch') ||
    u.startsWith('botjulio') || u.startsWith('botmago') ||
    u.startsWith('botbugs') || u.startsWith('botfresco') ||
    u.startsWith('botdesign') || u.startsWith('bot2_') ||
    u.startsWith('bot_ciclo') || u.startsWith('disdesigner') ||
    u.startsWith('diseñadorpd') || u.startsWith('playtestbot') ||
    u.startsWith('clerdesign') || u.startsWith('verify') ||
    u.includes('berser') && u.includes('test') ||
    u.startsWith('testsello') || u.startsWith('audit_') ||
    u.includes('audit') && u.includes('dis') ||
    u.startsWith('craft_test') || u.startsWith('debug_') ||
    u.includes('fix') && u.includes('test') ||
    u.includes('verif') && u.includes('test')
  );
}

function createPlayer(username) {
  const id = randomUUID();
  // BUG-1248: detectar bots al crear, no solo al reiniciar el servidor
  const isBot = isBotUsername(username) ? 1 : 0;
  run(
    `INSERT INTO players (id, username, is_bot) VALUES (?, ?, ?)`,
    [id, username, isBot]
  );
  return getPlayer(id);
}

/** T202: Obtener todos los jugadores para calcular promedios del servidor. */
function getAllPlayers() {
  return all(`SELECT hp, max_hp, attack, defense, level, kills, gold, reputation, xp FROM players`, []);
}

/** DIS-691: Obtener IDs de todos los jugadores para resetear cycle_start_at. */
function getAllPlayerIds() {
  return all(`SELECT id FROM players`, []);
}

function updatePlayer(id, fields) {
  const updates = Object.keys(fields)
    .map(k => `${k} = ?`)
    .join(', ');
  const values = Object.values(fields).map(v =>
    (v !== null && typeof v === 'object') ? JSON.stringify(v) : v
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
  // Normalizar nombre: eliminar prefijo de élite "⭐ " para que monstruos élite y normales
  // se registren como el mismo tipo en el bestiario (BUG-040)
  const baseName = monsterName.replace(/^⭐\s*/, '');
  const key = baseName.toLowerCase();
  if (!bestiary[key]) {
    bestiary[key] = { name: baseName, kills: 0, first_kill: new Date().toISOString(), last_kill: null };
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
  // Fix DIS-P07: solo mostrar jugadores activos en los últimos 15 minutos para evitar fantasmas
  // EPIC-962: excluir personajes archivados (ascendidos)
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  return all('SELECT * FROM players WHERE current_room_id = ? AND last_seen > ? AND is_archived = 0', [roomId, cutoff])
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
      // DIS-D279: al reactivarse, la trampa varía su daño base levemente (+/-1)
      // Esto evita que los jugadores memoricen el daño exacto
      const baseDmg = trap.base_damage || trap.damage;
      const roll = Math.random();
      const newDamage = Math.max(1, baseDmg + (roll < 0.33 ? 1 : roll < 0.66 ? 0 : -1));
      const reactivated = { ...trap, active: true, respawn_at: null, base_damage: baseDmg, damage: newDamage };
      run('UPDATE rooms SET trap = ? WHERE id = ?', [JSON.stringify(reactivated), row.id]);
      count++;
      console.log(`[traps] Trampa reactivada en sala ${row.id} (${trap.type}) — daño: ${newDamage}`);
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

function getAllMonsters() {
  return all('SELECT * FROM monsters')
    .map(m => ({ ...m, loot: JSON.parse(m.loot) }));
}

/**
 * DIS-D357: Devuelve solo monstruos vivos (hp > 0) que están en una sala (room_id IS NOT NULL).
 * Usado por el mapa para mostrar ⚔ solo en salas con monstruos activos.
 * Filtra en SQL para evitar edge cases de null-checking en JS con sql.js/WASM.
 */
function getLivingMonstersWithRoom() {
  return all('SELECT * FROM monsters WHERE room_id IS NOT NULL AND hp > 0')
    .map(m => ({ ...m, loot: JSON.parse(m.loot || '[]') }));
}

/**
 * Fix DIS-P02: devuelve monstruos muertos cuyo respawn_at ya pasó.
 * Reemplaza el uso de raw().exec() en combat.js que fallaba silenciosamente.
 */
function getMonstersForRespawn(now) {
  return all(
    `SELECT * FROM monsters WHERE room_id IS NULL AND respawn_at IS NOT NULL AND respawn_at <= ?`,
    [now]
  ).map(m => ({ ...m, loot: JSON.parse(m.loot || '[]') }));
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
    // Fix DIS-P02: null tiene typeof 'object', debería guardarse como NULL real (no "null" string)
    v === null ? null : typeof v === 'object' ? JSON.stringify(v) : v
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
  // EPIC-962: excluir personajes archivados (ascendidos)
  return all(
    `SELECT p.*, r.name AS room_name
     FROM players p
     LEFT JOIN rooms r ON r.id = p.current_room_id
     WHERE p.last_seen >= ? AND p.is_archived = 0
     ORDER BY p.last_seen DESC`,
    [cutoff]
  ).map(p => ({
    ...p,
    inventory: JSON.parse(p.inventory || '[]'),
  }));
}

function getLeaderboard(limit = 10) {
  // EPIC-962: excluir personajes archivados
  // BUG-1247: excluir bots de playtest (is_bot = 1); se hace aquí en la query para evitar
  // el problema anterior donde pedir pocos registros dejaba al filtro JS sin reales disponibles.
  return all(
    `SELECT username, level, xp, kills, hp, max_hp, deaths, gold, duel_wins, is_hardcore, fallen
     FROM players
     WHERE is_archived = 0 AND (is_bot IS NULL OR is_bot = 0)
     ORDER BY kills DESC, xp DESC, level DESC
     LIMIT ?`,
    [limit]
  );
}

// BUG-1247: versión sin filtro de bots (para ?bots=true en /api/leaderboard)
function getLeaderboardAll(limit = 10) {
  return all(
    `SELECT username, level, xp, kills, hp, max_hp, deaths, gold, duel_wins, is_hardcore, fallen
     FROM players
     WHERE is_archived = 0
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
     WHERE is_archived = 0
     ORDER BY gold DESC, level DESC
     LIMIT ?`,
    [limit]
  );
}

function getLeaderboardByDuels(limit = 10) {
  return all(
    `SELECT username, level, duel_wins, duel_losses, kills
     FROM players
     WHERE is_archived = 0
     ORDER BY duel_wins DESC, level DESC
     LIMIT ?`,
    [limit]
  );
}

function getLeaderboardByReputation(limit = 10) {
  return all(
    `SELECT username, level, reputation, kills
     FROM players
     WHERE is_archived = 0
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
     WHERE is_archived = 0
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

// ─── Guild Quests (T189) ──────────────────────────────────────────────────────

/**
 * Obtener la fila completa del guild (incluyendo guild_quest).
 */
function getGuildFull(name) {
  return one('SELECT * FROM guilds WHERE name = ?', [name]);
}

/**
 * Guardar la quest activa del guild (JSON stringificado).
 */
function setGuildQuest(guildName, questJson) {
  run('UPDATE guilds SET guild_quest = ? WHERE name = ?', [questJson, guildName]);
}

// ─── Eventos Globales (T093) ─────────────────────────────────────────────────

/**
 * Registra un evento global en la crónica del dungeon.
 * @param {string} type    — Categoría: 'boss', 'quest', 'achievement', 'duel', 'level', 'misc'
 * @param {string} message — Descripción del evento para mostrar a los jugadores
 */
function logGlobalEvent(type, message) {
  // BUG-020: deduplicar eventos de nivel — si el mismo mensaje se registró en los últimos 10s, no repetir
  if (type === 'level') {
    try {
      const existing = all(
        "SELECT id FROM global_events WHERE type = ? AND message = ? AND created_at >= datetime('now', '-10 seconds') LIMIT 1",
        [type, message]
      );
      if (existing && existing.length > 0) return;
    } catch (e) { /* silencioso si la query falla */ }
  }
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
  // BUG-312: usar formato SQLite (YYYY-MM-DD HH:MM:SS) en lugar de ISO 8601 (con 'T' y 'Z')
  // porque SQLite compara fechas como strings, y 'T' > ' ' haría que toda subasta parezca activa
  const endsAt = new Date(Date.now() + durationMs).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
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
  // BUG-312: usar replace(ends_at,'T',' ') para normalizar tanto fechas ISO ('T') como SQLite (' ')
  // BUG-314: pasar now como parámetro en lugar de usar datetime('now') de SQLite/WASM
  const now = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
  return all(
    `SELECT * FROM auctions WHERE closed = 0 AND replace(ends_at,'T',' ') > ? ORDER BY ends_at ASC`,
    [now]
  );
}

/**
 * Obtener una subasta por ID.
 */
function getAuction(id) {
  return one(`SELECT * FROM auctions WHERE id = ?`, [id]);
}
/**
 * DIS-500: Obtener las últimas subastas cerradas (para mostrar historial cuando no hay activas).
 * @param {number} limit - máximo de filas a devolver (default 5)
 */
function getRecentClosedAuctions(limit = 5) {
  return all(
    `SELECT * FROM auctions WHERE closed = 1 ORDER BY id DESC LIMIT ?`,
    [limit]
  );
}


/**
 * Realizar una puja en una subasta.
 * @returns {{ ok: boolean, error?: string }}
 */
function placeBid(auctionId, bidderId, bidderName, amount) {
  const auction = getAuction(auctionId);
  if (!auction) return { ok: false, error: 'Subasta no encontrada.' };
  if (auction.closed) return { ok: false, error: 'Esa subasta ya está cerrada.' };
  const now = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
  const endsAtNorm = (auction.ends_at || '').replace('T', ' ').replace(/\.\d{3}Z$/, '');
  if (endsAtNorm <= now) return { ok: false, error: 'Esa subasta ya expiró.' };
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
  // BUG-312: usar replace(ends_at,'T',' ') para normalizar tanto fechas ISO ('T') como SQLite (' ')
  // BUG-314: pasar now como parámetro para consistencia con getActiveAuctions
  const now = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
  const expired = all(
    `SELECT * FROM auctions WHERE closed = 0 AND replace(ends_at,'T',' ') <= ?`,
    [now]
  );
  for (const a of expired) {
    run(`UPDATE auctions SET closed = 1 WHERE id = ?`, [a.id]);
  }
  return expired;
}

/**
 * DIS-535: Crear una subasta pasiva (mercado pasivo) para ítems sin postor.
 * Dura 30 minutos y el Mercader la compra garantizado al 50% del precio mínimo.
 */
function createPassiveAuction(sellerId, sellerName, itemName, minPrice) {
  const PASSIVE_DURATION_MS = 30 * 60 * 1000; // 30 minutos
  // BUG-946: la regex estaba escapada doble (/\\\\.\\\\d{3}Z$/) y no removía el sufijo ".000Z"
  // Esto causaba que las subastas pasivas nunca expiraran (la fecha con ".000Z" es mayor que
  // cualquier fecha sin sufijo en comparación de strings SQLite).
  const endsAt = new Date(Date.now() + PASSIVE_DURATION_MS).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ''); // BUG-946 fix: era /\\\\.\\\\d{3}Z$/ (doble escape) → nunca removía .000Z
  run(
    `INSERT INTO auctions (seller_id, seller_name, item_name, min_price, current_bid, ends_at, is_passive)
     VALUES (?, ?, ?, ?, 0, ?, 1)`,
    [sellerId, sellerName, itemName, minPrice, endsAt]
  );
  const row = one(
    `SELECT * FROM auctions WHERE seller_id = ? AND item_name = ? AND closed = 0 AND is_passive = 1 ORDER BY id DESC LIMIT 1`,
    [sellerId, itemName]
  );
  return row;
}

/**
 * DIS-535: Obtener subastas pasivas activas (pendientes de venta al Mercader).
 */
function getActivePassiveAuctions() {
  const now = new Date().toISOString().replace('T', ' ').replace(/\\.\\d{3}Z$/, '');
  return all(
    `SELECT * FROM auctions WHERE closed = 0 AND is_passive = 1 AND replace(ends_at,'T',' ') > ? ORDER BY ends_at ASC`,
    [now]
  );
}



/**
 * Registra una visita a una sala. Devuelve el array actualizado de salas visitadas.
 * @param {string|number} playerId
 * @param {number} roomId
 * @returns {number[]} array de IDs de salas visitadas (sin duplicados)
 */
function trackRoomVisit(playerId, roomId) {
  const p = getPlayer(playerId);
  if (!p) return { visited: [], isNew: false };
  let visited = [];
  try { visited = JSON.parse(p.rooms_visited || '[]'); } catch (_) {}
  // DIS-795: normalizar a Number para evitar mismatch string/number
  const roomIdNum = Number(roomId);
  const isNew = !visited.some(v => Number(v) === roomIdNum);
  if (isNew) {
    visited.push(roomIdNum);
    updatePlayer(playerId, { rooms_visited: JSON.stringify(visited) });
  }
  return { visited, isNew };
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
  // DIS-1127: subido de 0.15 a 0.20 para que el sistema sea más visible durante el early game
  if (Math.random() > 0.20) return null; // 20% de chance

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
    const bonus = RUNE_BONUSES[type];
    // DIS-587: hint de enchant en la primera runa obtenida
    const isFirstRune = Object.values(runes).reduce((a, b) => a + b, 0) === 1;
    const enchantHint = isFirstRune
      ? `\n   🪄 ¡Primera runa! Podés usarla: "enchant ${type}" encanta tu arma por 3 min (consume la runa). O guardar 3 del mismo tipo para fusión permanente (+ATK). Decidí según tu situación.`
      : '';
    return `🔮 Encontrás una Runa de ${type.charAt(0).toUpperCase() + type.slice(1)} ${RUNE_EMOJIS[type]}! (${current + 1}/3)\n   Al juntar 3 del mismo tipo se fusionan → ${bonus.label}.\n   ${needed === 1 ? '⚡ ¡Solo necesitás 1 más para la fusión!' : `Necesitás ${needed} más para fusionar.`}\n   Usá "runas" para ver tu colección.${enchantHint}`;
  }
}

function getPlayerRunes(playerId) {
  const player = getPlayer(playerId);
  if (!player) return {};
  try { return JSON.parse(player.runes || '{}'); } catch (_) { return {}; }
}

// ─── Daily Challenge (T141) ───────────────────────────────────────────────────

const DAILY_CHALLENGE_TYPES = [
  { type: 'kill',  target: 'Goblin Merodeador',      goal: 3,  desc: 'Matar 3 Goblins Merodeadores',               minLevel: 1 },
  { type: 'kill',  target: 'Esqueleto Guerrero',      goal: 2,  desc: 'Matar 2 Esqueletos Guerreros',               minLevel: 1 },
  { type: 'kill',  target: 'Rata Gigante',            goal: 4,  desc: 'Matar 4 Ratas Gigantes',                     minLevel: 1 },
  { type: 'kill',  target: 'Murciélago Vampiro',      goal: 3,  desc: 'Matar 3 Murciélagos Vampiro',               minLevel: 1 },
  { type: 'kill',  target: 'Araña Tejedora',          goal: 2,  desc: 'Matar 2 Arañas Tejedoras',                  minLevel: 3 },
  { type: 'kill',  target: 'Espectro del Corredor',   goal: 2,  desc: 'Matar 2 Espectros del Corredor',            minLevel: 3 },
  { type: 'kill',  target: 'Gólem de Piedra',         goal: 1,  desc: 'Matar al Gólem de Piedra',                  minLevel: 5 }, // DIS-1134: solo para nivel 5+
  { type: 'gold',  target: null,                      goal: 25, desc: 'Ganar 25 de oro (recoger monedas o abrir cofres)', minLevel: 1 },
  { type: 'gold',  target: null,                      goal: 40, desc: 'Ganar 40 de oro (recoger monedas o abrir cofres)', minLevel: 1 },
  { type: 'craft', target: null,                      goal: 1,  desc: 'Craftear 1 ítem',                           minLevel: 1 },
  { type: 'craft', target: null,                      goal: 2,  desc: 'Craftear 2 ítems',                          minLevel: 3 },
  { type: 'forage',target: null,                      goal: 2,  desc: 'Explorar (forage) 2 veces con éxito',       minLevel: 1 },
  { type: 'rooms', target: null,                      goal: 5,  desc: 'Visitar 5 salas diferentes',                minLevel: 1 },
];

function getDailyChallenge(player) {
  let ch = {};
  try { ch = JSON.parse(player.daily_challenge || '{}'); } catch (_) { ch = {}; }
  const today = new Date().toISOString().slice(0, 10);
  if (ch.date !== today) {
    // DIS-1117: guardar el tipo del desafío previo para evitar repetirlo
    const prevType = ch.type || null;

    // Generar nuevo desafío para hoy (determinístico basado en player.id + fecha)
    // Fix DIS-P01: player.id es UUID string → calcular hash numérico para el seed
    const idStr = String(player.id);
    let idHash = 0;
    for (let i = 0; i < idStr.length; i++) { idHash = (idHash * 31 + idStr.charCodeAt(i)) >>> 0; }
    const dateNum = parseInt(today.replace(/-/g, ''), 10);
    const seed = (idHash + dateNum) % DAILY_CHALLENGE_TYPES.length;
    let template = DAILY_CHALLENGE_TYPES[seed];
    const playerLevel = player.level || 1;

    // DIS-1134: Filtrar desafíos que requieran nivel superior al del jugador
    if (template && (template.minLevel || 1) > playerLevel) {
      for (let offset = 1; offset < DAILY_CHALLENGE_TYPES.length; offset++) {
        const alt = DAILY_CHALLENGE_TYPES[(seed + offset) % DAILY_CHALLENGE_TYPES.length];
        if ((alt.minLevel || 1) <= playerLevel) {
          template = alt;
          break;
        }
      }
    }

    // DIS-D33: Evitar solapamiento con la quest activa (mismo tipo+target)
    try {
      const quests = require('../game/quests.js');
      const activeQuest = quests.getActiveQuest();
      if (activeQuest) {
        const qDef = activeQuest.questDef || activeQuest;
        const qType = qDef.type || '';
        const qTarget = qDef.target || '';
        // Si el template seleccionado solapa con la quest activa, buscar uno alternativo
        const sameType = template && template.type === qType;
        const sameTarget = template && qTarget && template.target &&
          template.target.toLowerCase() === qTarget.toLowerCase();
        if (sameType && (template.type !== 'kill' || sameTarget)) {
          // Buscar el siguiente template que no solape
          for (let offset = 1; offset < DAILY_CHALLENGE_TYPES.length; offset++) {
            const alt = DAILY_CHALLENGE_TYPES[(seed + offset) % DAILY_CHALLENGE_TYPES.length];
            const altSameType = alt.type === qType;
            const altSameTarget = qTarget && alt.target && alt.target.toLowerCase() === qTarget.toLowerCase();
            if (!(altSameType && (alt.type !== 'kill' || altSameTarget))) {
              template = alt;
              break;
            }
          }
        }
      }
    } catch (_) { /* quests module no disponible — ignorar */ }

    // DIS-1117: Evitar repetir el mismo tipo de desafío dos días seguidos
    if (template && prevType && template.type === prevType) {
      // Buscar el siguiente template que tenga un tipo diferente
      for (let offset = 1; offset < DAILY_CHALLENGE_TYPES.length; offset++) {
        const alt = DAILY_CHALLENGE_TYPES[(seed + offset) % DAILY_CHALLENGE_TYPES.length];
        if (alt.type !== prevType) {
          template = alt;
          break;
        }
      }
    }
    // DIS-1117: Excluir "Rata Gigante" del pool si el jugador tiene <3 kills totales
    // (probablemente recién empieza — las ratas de sala 0 son el único lugar fácil)
    if (template && template.target === 'Rata Gigante') {
      const totalKills = player.kills || 0;
      if (totalKills < 10) {
        // Jugador nuevo — asignar alternativa que no sea sala 0
        for (let offset = 1; offset < DAILY_CHALLENGE_TYPES.length; offset++) {
          const alt = DAILY_CHALLENGE_TYPES[(seed + offset) % DAILY_CHALLENGE_TYPES.length];
          if (alt.target !== 'Rata Gigante' && alt.type !== prevType) {
            template = alt;
            break;
          }
        }
      }
    }

    if (!template) {
      // Fallback seguro si por alguna razón el template es undefined
      const fallback = DAILY_CHALLENGE_TYPES[0];
      ch = { date: today, type: fallback.type, target: fallback.target, goal: fallback.goal, desc: fallback.desc, progress: 0, done: false };
    } else {
      ch = { date: today, type: template.type, target: template.target, goal: template.goal, desc: template.desc, progress: 0, done: false };
    }
    updatePlayer(player.id, { daily_challenge: JSON.stringify(ch) });
  }
  return ch;
}

function updateDailyChallengeProgress(playerId, type, target, amount = 1, roomId = null) {
  const player = getPlayer(playerId);
  if (!player) return null;
  let ch = getDailyChallenge(player);
  if (ch.done) return null;
  const today = new Date().toISOString().slice(0, 10);
  if (ch.date !== today) return null;
  if (ch.type !== type) return null;
  // Strip ⭐ elite prefix from monster name before comparing (T221 elites should count)
  const targetBaseName = (target && typeof target === 'string' && target.startsWith('⭐ ')) ? target.slice(2) : target;
  if (type === 'kill' && targetBaseName && ch.target && ch.target.toLowerCase() !== targetBaseName.toLowerCase()) return null;

  // DIS-1117: Excluir kills de Rata Gigante en sala 0 (tutorial) — el jugador ya limpió esa sala
  if (type === 'kill' && ch.target === 'Rata Gigante' && roomId !== null && roomId === 0) return null;

  // BUG-999: Para desafíos de tipo 'rooms', usar rooms_today (salas visitadas hoy)
  // en lugar del amount externo (que antes dependía de visitResult.isNew — sala nunca visitada en toda la vida).
  // Ahora target es el roomId visitado; solo suma si esa sala no fue visitada en la sesión de hoy.
  if (type === 'rooms') {
    const roomsToday = Array.isArray(ch.rooms_today) ? ch.rooms_today : [];
    const roomKey = String(targetBaseName); // targetBaseName aquí es el roomId (number o string)
    if (roomsToday.includes(roomKey)) {
      // Ya visitada hoy — no sumar
      return null;
    }
    roomsToday.push(roomKey);
    ch.rooms_today = roomsToday;
    amount = 1;
  }
  ch.progress = (ch.progress || 0) + amount;
  let reward = null;
  if (ch.progress >= ch.goal) {
    ch.done = true;
    ch.progress = ch.goal;
    reward = { xp: 30, gold: 20, reputation: 5 };
    // BUG-464: Aplicar recompensas recalculando el nivel
    const xp = (player.xp || 0) + 30;
    const gold = (player.gold || 0) + 20;
    const newLevel = xpSystem.levelFromXp(xp);
    const levelUpdates = { xp, gold, daily_challenge: JSON.stringify(ch), level: newLevel };
    if (newLevel > (player.level || 1)) {
      levelUpdates.max_hp = (player.max_hp || 30) + 5;
      const healOnLevelUp = Math.ceil(levelUpdates.max_hp * 0.20);
      levelUpdates.hp = Math.min(levelUpdates.max_hp, (player.hp || 1) + healOnLevelUp);
      levelUpdates.attack = (player.attack || 5) + 1;
    }
    updatePlayer(playerId, levelUpdates);
    addReputation(playerId, 5);
    addJournalEntry(playerId, '🏆 Desafío diario completado: ' + ch.desc);
  } else {
    updatePlayer(playerId, { daily_challenge: JSON.stringify(ch) });
  }
  return { challenge: ch, reward };
}

// ─── T222: Contrato de Caza Semanal ──────────────────────────────────────────

const WEEKLY_CONTRACT_TARGETS = [
  { target: 'Guardia Espectral',     goal: 3,  reward_xp: 60, reward_gold: 40, reward_item: 'pergamino de furia',      difficulty: '⚔⚔⚔',  desc: 'Eliminar 3 Guardias Espectrales de la Prisión Olvidada.' },
  { target: 'Gólem de Piedra',       goal: 2,  reward_xp: 70, reward_gold: 45, reward_item: 'poción de poder',         difficulty: '⚔⚔⚔',  desc: 'Destruir 2 Gólems de Piedra del Santuario Profano.' },
  { target: 'Araña Tejedora',        goal: 5,  reward_xp: 50, reward_gold: 35, reward_item: 'antídoto',                difficulty: '⚔⚔',    desc: 'Limpiar el nido — matar 5 Arañas Tejedoras.' },
  { target: 'Espectro del Corredor', goal: 3,  reward_xp: 55, reward_gold: 38, reward_item: 'pergamino de escudo',     difficulty: '⚔⚔',    desc: 'Purgar 3 Espectros del Corredor del Ala Norte.' },
  { target: 'Murciélago Vampiro',    goal: 6,  reward_xp: 45, reward_gold: 30, reward_item: 'poción de vida',          difficulty: '⚔',     desc: 'Exterminar 6 Murciélagos Vampiro de la Capilla.' },
  { target: 'Esqueleto Guerrero',    goal: 3,  reward_xp: 55, reward_gold: 35, reward_item: 'pergamino de velocidad',  difficulty: '⚔⚔',    desc: 'Reducir a polvo 3 Esqueletos Guerreros del Tesoro.' },
  { target: 'Campeón Espectral',     goal: 2,  reward_xp: 75, reward_gold: 50, reward_item: 'cota de malla',           difficulty: '⚔⚔⚔⚔', desc: 'Derrotar 2 Campeones Espectrales (zona norte).' },
  { target: 'Sombra del Vacío',      goal: 2,  reward_xp: 80, reward_gold: 55, reward_item: 'tomo sellado',            difficulty: '⚔⚔⚔⚔', desc: 'Erradicar 2 Sombras del Vacío del Abismo Eterno.' },
];

/**
 * Obtiene o genera el contrato semanal de un jugador.
 * La semana se calcula como el número de semana ISO del año.
 */
function getWeeklyContract(player) {
  let ct = {};
  try { ct = JSON.parse(player.weekly_contract || '{}'); } catch (_) { ct = {}; }
  // Número de semana: días desde epoch / 7
  const weekNumber = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
  if (ct.week !== weekNumber) {
    // Nueva semana: generar contrato (determinístico por jugador y semana)
    const idStr = String(player.id);
    let idHash = 0;
    for (let i = 0; i < idStr.length; i++) { idHash = (idHash * 31 + idStr.charCodeAt(i)) >>> 0; }
    const idx = (idHash + weekNumber) % WEEKLY_CONTRACT_TARGETS.length;
    const template = WEEKLY_CONTRACT_TARGETS[idx];
    ct = {
      week: weekNumber,
      target: template.target,
      goal: template.goal,
      progress: 0,
      done: false,
      reward_xp: template.reward_xp,
      reward_gold: template.reward_gold,
      reward_item: template.reward_item,
      difficulty: template.difficulty,
      desc: template.desc,
    };
    updatePlayer(player.id, { weekly_contract: JSON.stringify(ct) });
  }
  return ct;
}

/**
 * Actualiza el progreso del contrato semanal al matar un monstruo.
 * Retorna { contract, reward } si se completó, o { contract, reward: null } si no.
 */
function updateWeeklyContractProgress(playerId, killedMonsterName) {
  const player = getPlayer(playerId);
  if (!player) return null;
  const ct = getWeeklyContract(player);
  if (ct.done) return null;
  // Comparar por nombre base (sin prefijo élite)
  const baseName = killedMonsterName.startsWith('⭐ ') ? killedMonsterName.slice(2) : killedMonsterName;
  if (baseName !== ct.target) return null;
  ct.progress = (ct.progress || 0) + 1;
  let reward = null;
  if (ct.progress >= ct.goal) {
    ct.done = true;
    reward = { xp: ct.reward_xp, gold: ct.reward_gold, item: ct.reward_item };
    const freshP = getPlayer(playerId);
    // BUG-466: Recalcular nivel al aplicar recompensa de XP
    const newContractXp = (freshP.xp || 0) + ct.reward_xp;
    const newContractLevel = xpSystem.levelFromXp(newContractXp);
    const contractUpdates = {
      xp: newContractXp,
      gold: (freshP.gold || 0) + ct.reward_gold,
      weekly_contract: JSON.stringify(ct),
      level: newContractLevel,
    };
    if (newContractLevel > (freshP.level || 1)) {
      contractUpdates.max_hp = (freshP.max_hp || 30) + 5;
      const healOnLevelUp = Math.ceil(contractUpdates.max_hp * 0.20);
      contractUpdates.hp = Math.min(contractUpdates.max_hp, (freshP.hp || 1) + healOnLevelUp);
      contractUpdates.attack = (freshP.attack || 5) + 1;
    }
    updatePlayer(playerId, contractUpdates);
    // Agregar ítem al inventario
    try {
      const inv = JSON.parse(freshP.inventory || '[]');
      inv.push(ct.reward_item);
      updatePlayer(playerId, { inventory: JSON.stringify(inv) });
    } catch (_) {}
    // Registrar en crónica
    logGlobalEvent('contract', `📜 ${freshP.username} completó su Contrato de Caza: ${ct.desc} (+${ct.reward_xp} XP · +${ct.reward_gold}g · ${ct.reward_item})`);
  } else {
    updatePlayer(playerId, { weekly_contract: JSON.stringify(ct) });
  }
  return { contract: ct, reward };
}



/**
 * Crea una nueva bounty sobre un jugador objetivo.
 * Descuenta el oro del poster inmediatamente.
 */
function addBounty(posterId, posterName, targetId, targetName, amount) {
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  db.run(
    `INSERT INTO bounties (poster_id, poster_name, target_id, target_name, amount, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [posterId, posterName, targetId, targetName, amount, expiresAt]
  );
  // Descontar oro del poster
  const poster = getPlayer(posterId);
  updatePlayer(posterId, { gold: Math.max(0, (poster.gold || 0) - amount) });
}

/**
 * Obtiene todas las bounties activas (no reclamadas, no expiradas) sobre un jugador.
 */
function getBountiesOnPlayer(targetId) {
  const now = new Date().toISOString();
  const rows = db.exec(
    `SELECT * FROM bounties WHERE target_id = ? AND claimed = 0 AND expires_at > ? ORDER BY created_at DESC`,
    [targetId, now]
  );
  if (!rows || !rows[0] || !rows[0].values) return [];
  return rows[0].values.map(r => _mapRow(rows[0].columns, r));
}

/**
 * Obtiene todas las bounties activas en el dungeon.
 */
function getAllActiveBounties() {
  const now = new Date().toISOString();
  const rows = db.exec(
    `SELECT * FROM bounties WHERE claimed = 0 AND expires_at > ? ORDER BY amount DESC, created_at DESC`,
    [now]
  );
  if (!rows || !rows[0] || !rows[0].values) return [];
  return rows[0].values.map(r => _mapRow(rows[0].columns, r));
}

/**
 * Reclama todas las bounties activas sobre targetId y da el oro al claimerId.
 * Retorna el total de oro reclamado.
 */
function claimBounty(targetId, claimerId, claimerName) {
  const bounties = getBountiesOnPlayer(targetId);
  if (bounties.length === 0) return 0;
  let total = 0;
  for (const b of bounties) {
    db.run(
      `UPDATE bounties SET claimed = 1, claimed_by = ? WHERE id = ?`,
      [claimerName, b.id]
    );
    total += b.amount;
  }
  if (total > 0) {
    const claimer = getPlayer(claimerId);
    updatePlayer(claimerId, { gold: (claimer.gold || 0) + total });
  }
  return total;
}

/**
 * Expira las bounties vencidas y devuelve el oro a los poster.
 * Retorna cuántas se expiraron.
 */
function expireOldBounties() {
  const now = new Date().toISOString();
  const rows = db.exec(
    `SELECT * FROM bounties WHERE claimed = 0 AND expires_at <= ?`,
    [now]
  );
  if (!rows || !rows[0] || !rows[0].values) return 0;
  const expired = rows[0].values.map(r => _mapRow(rows[0].columns, r));
  for (const b of expired) {
    db.run(`UPDATE bounties SET claimed = 1 WHERE id = ?`, [b.id]);
    const poster = getPlayer(b.poster_id);
    if (poster) {
      updatePlayer(b.poster_id, { gold: (poster.gold || 0) + b.amount });
    }
  }
  return expired.length;
}

// Helper: mapear columnas y valores sql.js a objeto
function _mapRow(cols, vals) {
  const obj = {};
  cols.forEach((c, i) => { obj[c] = vals[i]; });
  return obj;
}

// ─── Mensajes en las paredes / Graffiti (T147) ───────────────────────────────

/**
 * Escribe un mensaje en la pared de la sala.
 * Máximo 10 mensajes por sala; si se supera se borra el más antiguo.
 */
function addWallMessage(roomId, playerName, message) {
  run('INSERT INTO wall_messages (room_id, player_name, message) VALUES (?, ?, ?)', [roomId, playerName, message]);
  // Limpiar mensajes más viejos si hay más de 10
  const oldest = all(
    'SELECT id FROM wall_messages WHERE room_id = ? ORDER BY id ASC',
    [roomId]
  );
  if (oldest.length > 10) {
    const toDelete = oldest.slice(0, oldest.length - 10);
    for (const row of toDelete) {
      run('DELETE FROM wall_messages WHERE id = ?', [row.id]);
    }
  }
}

/**
 * Devuelve los mensajes escritos en la pared de una sala (hasta limit).
 */
function getWallMessages(roomId, limit = 10) {
  return all(
    'SELECT player_name, message, created_at FROM wall_messages WHERE room_id = ? ORDER BY id ASC LIMIT ?',
    [roomId, limit]
  );
}
// DIS-498: Limpia inscripciones de jugadores-bot de las paredes
function cleanBotWallMessages() {
  run(`DELETE FROM wall_messages WHERE player_name LIKE 'PTBot_%' OR player_name LIKE 'Critico_Diseno_%' OR player_name LIKE 'PlaytestBot_%' OR player_name LIKE 'TestBot_%' OR player_name LIKE 'PlayBot%' OR player_name LIKE 'bot_%' OR player_name LIKE 'BotPlaytest%'`);
}


// ─── Monstruos muertos recientes (T149) ──────────────────────────────────────

/**
 * Devuelve monstruos que murieron recientemente en una sala (respawn_room_id = roomId,
 * room_id IS NULL, respawn_at dentro de los próximos `withinMinutes` minutos).
 * Si murieron hace poco, el cadáver todavía "está" en la sala.
 */
function getRecentlyDeadMonsters(roomId, withinMinutes = 2) {
  // BUG-1137: La lógica anterior usaba cutoff = now+2min y filtraba respawn_at <= cutoff,
  // lo que nunca matcheaba (respawn_at es now+3min o más). Fix: buscar monstruos con
  // room_id IS NULL (muertos, no respawnearon) y respawn_at > now (todavía en respawn).
  // Para acotar a "recientemente muertos", calculamos died_at aproximado:
  // un monstruo murió hace menos de withinMinutes si respawn_at - now < (maxRespawn - withinMinutes).
  // En la práctica, si respawn es 3-5 min, un monstruo que murió hace < 2 min tiene
  // respawn_at > now + (respawnMinutes - withinMinutes) minutos.
  // Simplificación pragmática: aceptar cualquier monstruo muerto en esta sala (room_id IS NULL,
  // respawn_at > now) — el jugador solo puede llegar inmediatamente después del combate de todas formas.
  const now = new Date(Date.now()).toISOString();
  return all(
    `SELECT * FROM monsters WHERE respawn_room_id = ? AND room_id IS NULL AND respawn_at IS NOT NULL AND respawn_at > ?`,
    [roomId, now]
  );
}

// DIS-508: todos los monstruos en respawn para una sala dada (sin límite de tiempo)
function getDeadMonstersForRoom(roomId) {
  return all(
    `SELECT * FROM monsters WHERE respawn_room_id = ? AND room_id IS NULL AND respawn_at IS NOT NULL`,
    [roomId]
  );
}

// T156: Guardar sesión al desconectar
function saveSession(playerId, { startTime, kills, xpGained, goldGained, commands }) {
  const startIso = new Date(startTime).toISOString().replace('T', ' ').split('.')[0];
  const durationMin = Math.floor((Date.now() - startTime) / 60000);
  run(
    `INSERT INTO sessions (player_id, start_time, duration_min, kills, xp_gained, gold_gained, commands)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [playerId, startIso, durationMin, kills || 0, xpGained || 0, goldGained || 0, commands || 0]
  );
  // Acumular playtime_minutes en el jugador (T157)
  run(
    `UPDATE players SET playtime_minutes = COALESCE(playtime_minutes, 0) + ? WHERE id = ?`,
    [durationMin, playerId]
  );
}

// T156: Últimas 5 sesiones de un jugador
function getPlayerSessions(playerId, limit = 5) {
  return all(
    `SELECT start_time, duration_min, kills, xp_gained, gold_gained, commands
     FROM sessions
     WHERE player_id = ?
     ORDER BY id DESC
     LIMIT ?`,
    [playerId, limit]
  );
}

// T208: Estadísticas semanales de un jugador (últimos 7 días)
function getWeeklyStats(playerId) {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const rows = all(
    `SELECT duration_min, kills, xp_gained, gold_gained, commands
     FROM sessions
     WHERE player_id = ? AND start_time >= ?
     ORDER BY id ASC`,
    [playerId, cutoff]
  );
  if (!rows || rows.length === 0) return null;
  return {
    sessions: rows.length,
    totalMin: rows.reduce((a, r) => a + (r.duration_min || 0), 0),
    totalKills: rows.reduce((a, r) => a + (r.kills || 0), 0),
    totalXP: rows.reduce((a, r) => a + (r.xp_gained || 0), 0),
    totalGold: rows.reduce((a, r) => a + (r.gold_gained || 0), 0),
    totalCmds: rows.reduce((a, r) => a + (r.commands || 0), 0),
    bestKills: Math.max(...rows.map(r => r.kills || 0)),
    bestMin: Math.max(...rows.map(r => r.duration_min || 0)),
  };
}

// T158: Ranking por tiempo de juego total
function getLeaderboardByPlaytime(limit = 10) {
  return all(
    `SELECT username, level, playtime_minutes, kills
     FROM players
     WHERE is_archived = 0
     ORDER BY playtime_minutes DESC, level DESC
     LIMIT ?`,
    [limit]
  );
}

// T178: Obtener todos los jugadores caídos en modo Hardcore, ordenados por nivel desc
// ─── DIS-007: Cleanup de jugadores de test ───────────────────────────────────

/**
 * Devuelve jugadores que parecen de test:
 * - username empieza con test_, testfind, killtest_, bot_, llm_ o similares
 * - O no han tenido actividad en los últimos N días
 */
function getTestPlayers({ olderThanDays = 7, includeTestNames = true } = {}) {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
  const rows = all(
    `SELECT id, username, level, kills, last_seen, current_room_id
     FROM players
     ORDER BY last_seen ASC`
  );
  return rows.filter(p => {
    const name = (p.username || '').toLowerCase();
    const isTest = includeTestNames && (
      name.startsWith('test') ||
      name.startsWith('bot_') ||
      name.startsWith('llm_') ||
      name.startsWith('kill') ||
      name === 'testplayer' ||
      /^test\d/.test(name) ||
      /^player\d{3,}$/.test(name)
    );
    const isStale = p.last_seen < cutoff;
    return isTest || isStale;
  });
}

/**
 * Elimina un jugador por ID junto con sus eventos.
 */
function deletePlayer(playerId) {
  run(`DELETE FROM events WHERE player_id = ?`, [playerId]);
  run(`DELETE FROM players WHERE id = ?`, [playerId]);
}

function getFallenHardcorePlayers() {
  return all(
    `SELECT username, level, kills, fallen_at, hardcore_generation
     FROM players
     WHERE is_hardcore = 1 AND fallen = 1
     ORDER BY level DESC, kills DESC`
  );
}

// ─── T181: Mercado de jugadores (precio fijo) ─────────────────────────────────

function createMarketListing(sellerId, sellerName, itemName, price, durationMs = 60 * 60 * 1000) {
  const expiresAt = new Date(Date.now() + durationMs).toISOString();
  run(
    `INSERT INTO market_listings (seller_id, seller_name, item_name, price, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    [sellerId, sellerName, itemName, price, expiresAt]
  );
  return one(`SELECT * FROM market_listings WHERE seller_id = ? AND item_name = ? AND sold = 0 ORDER BY id DESC LIMIT 1`, [sellerId, itemName]);
}

function getActiveMarketListings() {
  return all(
    `SELECT * FROM market_listings WHERE sold = 0 AND expires_at > datetime('now') ORDER BY created_at ASC`
  );
}

function getPlayerMarketListings(sellerId) {
  return all(
    `SELECT * FROM market_listings WHERE seller_id = ? AND sold = 0 AND expires_at > datetime('now') ORDER BY created_at ASC`,
    [sellerId]
  );
}

function getMarketListing(id) {
  return one(`SELECT * FROM market_listings WHERE id = ?`, [id]);
}

function buyMarketItem(listingId, buyerName) {
  run(`UPDATE market_listings SET sold = 1, buyer_name = ? WHERE id = ?`, [buyerName, listingId]);
}

function cancelMarketListing(listingId) {
  run(`UPDATE market_listings SET sold = 1 WHERE id = ?`, [listingId]);
}

function expireOldMarketListings() {
  const expired = all(
    `SELECT * FROM market_listings WHERE sold = 0 AND expires_at <= datetime('now')`
  );
  for (const l of expired) {
    run(`UPDATE market_listings SET sold = 1 WHERE id = ?`, [l.id]);
  }
  return expired;
}

// ─── T188: Tablón global de anuncios ─────────────────────────────────────────

function addBulletinPost(authorId, authorName, message) {
  const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(); // 6 horas
  run(
    `INSERT INTO bulletin_board (author_id, author_name, message, expires_at) VALUES (?, ?, ?, ?)`,
    [authorId, authorName, message, expiresAt]
  );
}

function getBulletinPosts(limit = 10) {
  return all(
    `SELECT * FROM bulletin_board WHERE expires_at > datetime('now') ORDER BY created_at DESC LIMIT ?`,
    [limit]
  );
}

function getPlayerBulletinPosts(authorId) {
  return all(
    `SELECT * FROM bulletin_board WHERE author_id = ? AND expires_at > datetime('now') ORDER BY created_at DESC`,
    [authorId]
  );
}

function deleteBulletinPost(id, authorId) {
  const post = one(`SELECT * FROM bulletin_board WHERE id = ?`, [id]);
  if (!post) return false;
  if (post.author_id !== authorId) return 'unauthorized';
  run(`DELETE FROM bulletin_board WHERE id = ?`, [id]);
  return true;
}

function expireOldBulletinPosts() {
  run(`DELETE FROM bulletin_board WHERE expires_at <= datetime('now')`);
}

// ─── Server Records (T195) ────────────────────────────────────────────────────

const SERVER_RECORDS_DEFS = {
  max_level:         { label: '🏆 Nivel más alto alcanzado', unit: 'nivel',    icon: '🎖️' },
  max_kills:         { label: '⚔️  Más monstruos matados',  unit: 'kills',    icon: '⚔️' },
  max_combo:         { label: '⚡ Combo de ataque más alto', unit: 'combo x',  icon: '⚡' },
  max_gold:          { label: '💰 Mayor riqueza acumulada',  unit: 'oro',      icon: '💰' },
  max_duel_kills:    { label: '🥊 Más duelos ganados',       unit: 'duelos',   icon: '🥊' },
  max_session_kills: { label: '🔥 Más kills en una sesión',  unit: 'kills',    icon: '🔥' },
};

function getServerRecord(key) {
  return one(`SELECT * FROM server_records WHERE record_key = ?`, [key]);
}

function getAllServerRecords() {
  const rows = all(`SELECT * FROM server_records ORDER BY record_key`);
  return rows;
}

// Intenta actualizar el récord; si el nuevo valor supera el anterior, actualiza y devuelve true
function trySetServerRecord(key, value, holderName, description) {
  const existing = getServerRecord(key);
  if (!existing || value > existing.value) {
    if (existing) {
      run(`UPDATE server_records SET value = ?, holder_name = ?, achieved_at = datetime('now'), description = ? WHERE record_key = ?`,
        [value, holderName, description || null, key]);
    } else {
      run(`INSERT INTO server_records (record_key, value, holder_name, description) VALUES (?, ?, ?, ?)`,
        [key, value, holderName, description || null]);
    }
    return true; // récord batido
  }
  return false;
}


// Definición de hitos por categoría
const WORLD_GOAL_MILESTONES = {
  kills:    [100, 500, 1000, 5000, 10000],
  crafts:   [50, 200, 500, 2000],
  gold:     [1000, 5000, 20000, 100000],
  duels:    [20, 100, 500],
};

const WORLD_GOAL_LABELS = {
  kills: '⚔️  Monstruos abatidos',
  crafts: '⚗️  Ítems crafteados',
  gold:  '🪙 Oro recolectado',
  duels: '🥊 Duelos jugados',
};

function getWorldGoalState(category) {
  // Devuelve el acumulado actual en la BD
  const row = one(`SELECT value FROM world_goals WHERE category = ? ORDER BY id DESC LIMIT 1`, [category]);
  return row ? row.value : 0;
}

// Incrementar contador; si alcanza un hito nuevo, devuelve el hito
function incrementWorldGoal(category, amount) {
  if (!WORLD_GOAL_MILESTONES[category]) return null;

  const currentRow = one(
    `SELECT value FROM world_goals WHERE category = ? AND reached_at IS NULL ORDER BY id DESC LIMIT 1`,
    [category]
  );
  const current = currentRow ? currentRow.value : 0;
  const newValue = current + amount;

  if (currentRow) {
    run(`UPDATE world_goals SET value = ? WHERE category = ? AND reached_at IS NULL AND rowid = (SELECT rowid FROM world_goals WHERE category = ? AND reached_at IS NULL ORDER BY id DESC LIMIT 1)`,
      [newValue, category, category]);
  } else {
    run(`INSERT INTO world_goals (category, milestone, value) VALUES (?, 0, ?)`, [category, newValue]);
  }

  // Verificar si se superó algún hito no alcanzado
  const milestones = WORLD_GOAL_MILESTONES[category];
  for (const m of milestones) {
    if (current < m && newValue >= m) {
      // Hito alcanzado — SQLite no soporta ORDER BY en UPDATE, usar subquery
      run(
        `UPDATE world_goals SET reached_at = datetime('now'), milestone = ?
         WHERE rowid = (
           SELECT rowid FROM world_goals WHERE category = ? AND reached_at IS NULL ORDER BY id DESC LIMIT 1
         )`,
        [m, category]
      );
      return m;
    }
  }
  return null;
}

function getWorldGoalsDisplay() {
  const result = {};
  for (const [cat, milestones] of Object.entries(WORLD_GOAL_MILESTONES)) {
    const current = getWorldGoalState(cat);
    // Próximo hito sin alcanzar
    const next = milestones.find(m => {
      const reached = one(`SELECT id FROM world_goals WHERE category = ? AND milestone = ? AND reached_at IS NOT NULL`, [cat, m]);
      return !reached;
    }) || milestones[milestones.length - 1];
    result[cat] = { current, next, label: WORLD_GOAL_LABELS[cat], milestones };
  }
  return result;
}


// ─── T212: Sistema de campeón de la hora ─────────────────────────────────────

/**
 * Incrementa hourly_kills del jugador. Si la hora cambió desde el último reset,
 * resetea el contador primero. Retorna el nuevo conteo.
 */
function incrementHourlyKills(playerId) {
  const player = one('SELECT hourly_kills, hourly_kills_reset FROM players WHERE id = ?', [playerId]);
  if (!player) return 0;

  const now = new Date();
  const thisHour = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${now.getUTCHours()}`;
  const lastReset = player.hourly_kills_reset;

  let newCount;
  if (lastReset !== thisHour) {
    // Nueva hora: resetear
    newCount = 1;
    run('UPDATE players SET hourly_kills = 1, hourly_kills_reset = ? WHERE id = ?', [thisHour, playerId]);
  } else {
    newCount = (player.hourly_kills || 0) + 1;
    run('UPDATE players SET hourly_kills = ? WHERE id = ?', [newCount, playerId]);
  }
  return newCount;
}

/**
 * Retorna el jugador con más hourly_kills en la hora actual (o null si nadie tiene >0).
 */
function getHourlyChampion() {
  const now = new Date();
  const thisHour = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${now.getUTCHours()}`;
  const row = one(
    `SELECT id, username, hourly_kills, level FROM players
     WHERE hourly_kills_reset = ? AND hourly_kills > 0
     ORDER BY hourly_kills DESC LIMIT 1`,
    [thisHour]
  );
  return row || null;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

// ─── T219: Racha de login diario ──────────────────────────────────────────────

/**
 * Procesa la racha de login diario del jugador.
 * Si el último login fue ayer, incrementa la racha (máx 7).
 * Si fue hace más de 1 día, resetea la racha a 1.
 * Si fue hoy, no hace nada (ya fue procesado).
 * @param {string} playerId
 * @returns {{ streak: number, isNew: boolean, reward: { gold: number, xp: number } | null }}
 */
function processLoginStreak(playerId) {
  const player = getPlayer(playerId);
  if (!player) return { streak: 0, isNew: false, reward: null };

  const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  const lastLoginDate = player.last_login_date || null;

  // Ya fue procesado hoy — no duplicar recompensa
  if (lastLoginDate === todayStr) {
    return { streak: player.login_streak || 0, isNew: false, reward: null };
  }

  let newStreak = 1;
  if (lastLoginDate) {
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const yesterdayStr = yesterday.toISOString().slice(0, 10);
    if (lastLoginDate === yesterdayStr) {
      // Día consecutivo — incrementar racha
      newStreak = Math.min((player.login_streak || 0) + 1, 7);
    }
    // else: más de 1 día de ausencia — racha vuelve a 1
  }

  // Calcular recompensa según racha (5g y 3 XP por día de racha)
  const goldReward = newStreak * 5;
  const xpReward   = newStreak * 3;

  // Aplicar recompensa
  updatePlayer(playerId, {
    login_streak: newStreak,
    last_login_date: todayStr,
    gold: (player.gold || 0) + goldReward,
    xp:   (player.xp   || 0) + xpReward,
  });

  return {
    streak: newStreak,
    isNew: true,
    reward: { gold: goldReward, xp: xpReward },
  };
}

// ─── EPIC-962: Legados (Sistema de Ascensión) ────────────────────────────────

/**
 * Registra una entrada en la tabla `legacies` al ascender.
 * @param {object} data
 * @param {string} data.id               - UUID único
 * @param {string} data.account_username - username original de la cuenta
 * @param {string} data.character_name   - nombre del personaje archivado (ej: 'kaelthas#1')
 * @param {string} data.character_class  - clase del personaje
 * @param {string} [data.specialization] - especialización (puede ser null)
 * @param {number} data.level_reached    - nivel al momento de ascender
 * @param {number} data.lich_kills       - ciclos completados
 * @param {string} data.legacy_type      - ID del legado elegido
 * @param {string} [data.epitaph]        - frase del jugador
 * @param {string} [data.item_left]      - JSON del ítem enterrado
 * @param {number} [data.item_room_id]   - sala del ítem enterrado
 * @param {number} data.ascension_number - número de ascensión
 */
function createLegacyEntry(data) {
  run(
    `INSERT INTO legacies
      (id, account_username, character_name, character_class, specialization,
       level_reached, lich_kills, legacy_type, epitaph, item_left, item_room_id, ascension_number)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.id,
      data.account_username,
      data.character_name,
      data.character_class || 'sin_clase',
      data.specialization || null,
      data.level_reached || 1,
      data.lich_kills || 0,
      data.legacy_type,
      data.epitaph || null,
      data.item_left || null,
      data.item_room_id || null,
      data.ascension_number || 1,
    ]
  );
}

/**
 * Obtiene todos los legados de una cuenta, ordenados por fecha desc.
 * @param {string} accountUsername
 * @returns {object[]}
 */
function getLegaciesByAccount(accountUsername) {
  return all(
    `SELECT * FROM legacies WHERE account_username = ? ORDER BY ascended_at DESC`,
    [accountUsername]
  );
}

/**
 * Obtiene todos los legados del servidor (para el Salón de los Caídos), ordenados por fecha desc.
 * @param {number} [limit=50]
 * @returns {object[]}
 */
function getAllLegacies(limit = 50) {
  return all(
    `SELECT * FROM legacies ORDER BY ascended_at DESC LIMIT ?`,
    [limit]
  );
}

/**
 * T970: Obtiene el ítem heredado más reciente no reclamado para una cuenta.
 * @param {string} accountUsername
 * @returns {object|null} — fila de legacies con item_left, item_room_id, character_name; o null
 */
function getUnclaimedLegacyItem(accountUsername) {
  return one(
    `SELECT * FROM legacies
     WHERE account_username = ? AND item_left IS NOT NULL AND item_claimed = 0
     ORDER BY ascension_number DESC LIMIT 1`,
    [accountUsername]
  ) || null;
}

/**
 * T970: Marca el ítem heredado de un legado como reclamado.
 * @param {string} legacyId — id de la fila en legacies
 */
function claimLegacyItem(legacyId) {
  run(`UPDATE legacies SET item_claimed = 1 WHERE id = ?`, [legacyId]);
}

/**
 * T967: Registra un ítem enterrado en un legado existente.
 * @param {string} legacyId
 * @param {string} itemName
 * @param {number} roomId
 */
function setLegacyItem(legacyId, itemName, roomId) {
  run(`UPDATE legacies SET item_left = ?, item_room_id = ? WHERE id = ?`, [itemName, roomId, legacyId]);
}


// ─── EPIC-MR-1083: World State colectivo ─────────────────────────────────────

/**
 * Calcula el número de semana actual (consistente con getWeeklyContract).
 * @returns {number}
 */
function getCurrentWeekNumber() {
  return Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
}

/**
 * Inicializa las claves del world_state con valor 0 si no existen,
 * y ejecuta un lazy reset semanal si el week_number cambió.
 * Llamado desde init() después de crear la tabla.
 */
function initWorldState() {
  const INITIAL_KEYS = [
    'aranas_semana',
    'esqueletos_semana',
    'goblins_semana',
    'elementales_semana',
    'lich_derrotado_semana',
    'subastas_semana',
    'items_crafteados_semana',
    'week_number',
    'lich_last_kill_ts',
  ];

  // Insertar claves que no existan
  for (const key of INITIAL_KEYS) {
    try {
      run(
        `INSERT OR IGNORE INTO world_state (key, value, updated_at) VALUES (?, 0, datetime('now'))`,
        [key]
      );
    } catch (_) {}
  }

  // Lazy reset semanal
  const currentWeek = getCurrentWeekNumber();
  const storedRow = one(`SELECT value FROM world_state WHERE key = 'week_number'`);
  const storedWeek = storedRow ? storedRow.value : null;

  if (storedWeek !== null && storedWeek !== currentWeek) {
    // Semana nueva — guardar snapshot antes de resetear
    const snapshot = getWorldStateSnapshot();
    const snapshotMsg = `Semana ${storedWeek}: aranas=${snapshot.aranas_semana}, esqueletos=${snapshot.esqueletos_semana}, goblins=${snapshot.goblins_semana}, elementales=${snapshot.elementales_semana}, lich=${snapshot.lich_derrotado_semana}, subastas=${snapshot.subastas_semana}, crafts=${snapshot.items_crafteados_semana}`;
    try {
      run(
        `INSERT INTO global_events (type, message) VALUES ('world_state_reset', ?)`,
        [snapshotMsg]
      );
    } catch (_) {}

    // Resetear contadores semanales (no lich_last_kill_ts ni week_number)
    run(
      `UPDATE world_state SET value = 0, updated_at = datetime('now') WHERE key LIKE '%_semana'`
    );
    console.log(`[world_state] Reset semanal ejecutado. ${snapshotMsg}`);
  }

  // Actualizar week_number al valor actual
  run(
    `UPDATE world_state SET value = ?, updated_at = datetime('now') WHERE key = 'week_number'`,
    [currentWeek]
  );
}

/**
 * Incrementa un contador de world_state en 1.
 * @param {string} key — clave del contador (ej: 'aranas_semana')
 */
function incrementWorldState(key) {
  try {
    run(
      `INSERT INTO world_state (key, value, updated_at) VALUES (?, 1, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = value + 1, updated_at = datetime('now')`,
      [key]
    );
  } catch (e) {
    console.error(`[world_state] Error incrementando ${key}:`, e.message);
  }
}

/**
 * Setea un valor específico en world_state (usado para lich_last_kill_ts).
 * @param {string} key
 * @param {number} value
 */
function setWorldState(key, value) {
  try {
    run(
      `INSERT INTO world_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`,
      [key, value, value]
    );
  } catch (e) {
    console.error(`[world_state] Error seteando ${key}:`, e.message);
  }
}

/**
 * Lee múltiples claves del world_state y retorna un objeto { key: value }.
 * @param {string[]} keys
 * @returns {Object}
 */
function getWorldStateValues(keys) {
  const result = {};
  for (const key of keys) {
    const row = one(`SELECT value FROM world_state WHERE key = ?`, [key]);
    result[key] = row ? row.value : 0;
  }
  return result;
}

/**
 * Obtiene un snapshot completo del world_state (todas las claves).
 * @returns {Object} — { key: value, ... }
 */
function getWorldStateSnapshot() {
  const rows = all(`SELECT key, value FROM world_state`);
  const result = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

// ─── EPIC-1156: Expediciones ─────────────────────────────────────────────────

/**
 * Devuelve la expedición activa del jugador, o null si no tiene ninguna.
 * @param {string} playerId
 * @returns {{ id, player_id, expedition_id, state, step, data, started_at, completed_at } | null}
 */
function getActiveExpedition(playerId) {
  const row = one(
    `SELECT * FROM expeditions WHERE player_id = ? AND state = 'active' LIMIT 1`,
    [playerId]
  );
  if (!row) return null;
  row.data = JSON.parse(row.data || '{}');
  return row;
}

/**
 * Asigna una nueva expedición al jugador.
 * Prerrequisito: verificar que no tiene una activa antes de llamar.
 * @param {string} playerId
 * @param {string} expeditionId - slug de la expedición (ej: 'sello_carcelero')
 */
function assignExpeditionToDB(playerId, expeditionId) {
  run(
    `INSERT INTO expeditions (player_id, expedition_id, state, step, data) VALUES (?, ?, 'active', 1, '{}')`,
    [playerId, expeditionId]
  );
}

/**
 * Avanza el paso actual de la expedición activa del jugador.
 * @param {string} playerId
 * @param {object} newData - nuevo estado interno (se serializa a JSON)
 */
function advanceExpeditionStep(playerId, newData = {}) {
  run(
    `UPDATE expeditions SET step = step + 1, data = ?, last_updated = datetime('now') WHERE player_id = ? AND state = 'active'`,
    [JSON.stringify(newData), playerId]
  );
}

/**
 * Marca la expedición activa del jugador como completada.
 * @param {string} playerId
 * @param {object} finalData - estado final (decisión tomada, efectos mundiales, etc.)
 */
function completeExpeditionInDB(playerId, finalData = {}) {
  run(
    `UPDATE expeditions SET state = 'completed', completed_at = datetime('now'), data = ?, last_updated = datetime('now') WHERE player_id = ? AND state = 'active'`,
    [JSON.stringify(finalData), playerId]
  );
}

/**
 * Devuelve todos los expedition_id que el jugador completó alguna vez.
 * Usado por el motor de asignación para evitar repetir expediciones.
 * @param {string} playerId
 * @returns {string[]} array de slugs completados
 */
function getCompletedExpeditions(playerId) {
  const rows = all(
    `SELECT expedition_id FROM expeditions WHERE player_id = ? AND state = 'completed'`,
    [playerId]
  );
  return rows.map(r => r.expedition_id);
}

// ─── Eventos cíclicos globales (T-1224 / Gaceta del Corredor) ────────────────

/**
 * Devuelve el evento global activo actual (no expirado), o null si no hay.
 * @returns {{ id, event_id, event_type, started_at, expires_at, data }|null}
 */
function getActiveGlobalEvent() {
  const now = new Date().toISOString();
  const row = one(
    `SELECT * FROM active_events WHERE event_type = 'global' AND expires_at > ? ORDER BY id DESC LIMIT 1`,
    [now]
  );
  if (!row) return null;
  try { row.data = JSON.parse(row.data); } catch (_) { row.data = {}; }
  return row;
}

/**
 * Inserta un nuevo evento global en la tabla. Limpia eventos expirados antes de insertar.
 * @param {string} eventId - ej: 'BLOOD_MOON', 'ARCANE_SURGE'
 * @param {number} durationMs - duración en milisegundos
 * @param {object} [data={}] - parámetros adicionales del evento
 */
function setActiveGlobalEvent(eventId, durationMs, data = {}) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + durationMs).toISOString();
  clearExpiredGlobalEvents();
  db.run(
    `INSERT INTO active_events (event_id, event_type, started_at, expires_at, data) VALUES (?, 'global', ?, ?, ?)`,
    [eventId, now.toISOString(), expiresAt, JSON.stringify(data)]
  );
}

/**
 * Borra todos los eventos globales expirados de la tabla.
 */
function clearExpiredGlobalEvents() {
  const now = new Date().toISOString();
  db.run(`DELETE FROM active_events WHERE expires_at <= ?`, [now]);
}

// ─────────────────────────────────────────────────────────────────────────────


// ─── Desafíos Diarios y Semanal Colectivo (T-1229 / Gaceta del Corredor Fase 2) ─

/**
 * Obtiene el progreso de todos los desafíos asignados a un jugador en una fecha UTC.
 * @param {string} playerId
 * @param {string} dateUtc — formato 'YYYY-MM-DD'
 * @returns {object[]} — array de { challenge_id, count }
 */
function getDailyChallengeProgress(playerId, dateUtc) {
  const rows = db.exec(
    `SELECT challenge_id, count FROM daily_challenge_progress WHERE player_id = ? AND date_utc = ?`,
    [playerId, dateUtc]
  );
  if (!rows.length || !rows[0].values.length) return [];
  const { columns, values } = rows[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

/**
 * Incrementa el contador de progreso de un desafío para un jugador hoy.
 * Crea la fila si no existe (upsert).
 * @param {string} playerId
 * @param {string} challengeId — ej: 'CHAL-C01'
 * @param {string} dateUtc — formato 'YYYY-MM-DD'
 * @param {number} [increment=1]
 */
function updateChallengeProgress(playerId, challengeId, dateUtc, increment = 1) {
  db.run(
    `INSERT INTO daily_challenge_progress (player_id, challenge_id, count, date_utc)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(player_id, challenge_id, date_utc)
     DO UPDATE SET count = count + ?`,
    [playerId, challengeId, increment, dateUtc, increment]
  );
}

/**
 * Obtiene el estado actual del desafío semanal colectivo.
 * @returns {object|null}
 */
function getWeeklyChallengeState() {
  const rows = db.exec(`SELECT * FROM weekly_challenge_state ORDER BY rowid DESC LIMIT 1`);
  if (!rows.length || !rows[0].values.length) return null;
  const { columns, values } = rows[0];
  const obj = {};
  columns.forEach((col, i) => { obj[col] = values[0][i]; });
  try { obj.reward = JSON.parse(obj.reward); } catch (_) { obj.reward = {}; }
  return obj;
}

/**
 * Establece (o reemplaza) el desafío semanal colectivo actual.
 * @param {string} weekKey — ej: '2026-W27'
 * @param {string} challengeId — ej: 'CHAL-S01'
 * @param {number} target — cantidad objetivo
 * @param {object} reward — { description: string, ... }
 * @param {string} expiresAt — ISO timestamp del lunes siguiente 00:00 UTC
 */
function setWeeklyChallenge(weekKey, challengeId, target, reward, expiresAt) {
  db.run(
    `INSERT OR REPLACE INTO weekly_challenge_state (week_key, challenge_id, progress, target, reward, expires_at)
     VALUES (?, ?, 0, ?, ?, ?)`,
    [weekKey, challengeId, target, JSON.stringify(reward), expiresAt]
  );
}

/**
 * Incrementa el progreso colectivo del desafío semanal actual.
 * @param {number} [amount=1]
 */
function incrementWeeklyProgress(amount = 1) {
  db.run(
    `UPDATE weekly_challenge_state SET progress = progress + ? WHERE expires_at > ?`,
    [amount, new Date().toISOString()]
  );
}

// ─── T-1233: Utilidades de world_state por clave individual y Aldric Rep ──────

/**
 * Lee una clave individual del world_state. Retorna null si no existe.
 * Nota: world_state.value es INTEGER — para timestamps usamos este int.
 * @param {string} key
 * @returns {number|null}
 */
function getWorldStateValue(key) {
  try {
    const row = one(`SELECT value FROM world_state WHERE key = ?`, [key]);
    return row ? row.value : null;
  } catch (_) {
    return null;
  }
}

/**
 * Obtiene la reputación de Aldric del jugador (campo aldric_rep).
 * @param {string} playerId
 * @returns {number}
 */
function getAldricRep(playerId) {
  const p = getPlayer(playerId);
  return p ? (p.aldric_rep || 0) : 0;
}

/**
 * Incrementa la reputación con Aldric en `amount` puntos.
 * @param {string} playerId
 * @param {number} amount
 * @returns {number} — nueva reputación
 */
function addAldricRep(playerId, amount) {
  const p = getPlayer(playerId);
  if (!p) return 0;
  const newRep = (p.aldric_rep || 0) + amount;
  updatePlayer(playerId, { aldric_rep: newRep });
  return newRep;
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  init, persist,
  // players
  getPlayer, getPlayerByUsername, createPlayer, isBotUsername, updatePlayer, touchPlayer, addBestiaryKill, addJournalEntry, getPlayersInRoom, getActivePlayers, getLeaderboard, getLeaderboardAll, getLeaderboardByGold, getLeaderboardByDuels, getPartyMembers, getAllPlayers, getAllPlayerIds,
  // DIS-007: cleanup de test players
  getTestPlayers, deletePlayer,
  // reputación (T125)
  addReputation, getReputationLevel, getLeaderboardByReputation, getLeaderboardByCrafts,
  // rooms
  getRoom, getAllRooms, upsertRoom, updateRoomItems, updateRoomTrap, checkTrapRespawns,
  // monsters
  getMonster, getMonstersInRoom, getAllMonsters, getLivingMonstersWithRoom, getMonstersForRespawn, upsertMonster, updateMonster,
  // events
  logEvent, getRecentEvents,
  // offline messages (tell)
  saveOfflineMessage, getPendingMessages, markMessagesDelivered, countPendingMessages, getRecentMessages,
  // guilds
  getGuild, getGuildMembers, createGuild, deleteGuild, setPlayerGuild, getAllGuilds,
  // guild quests (T189)
  getGuildFull, setGuildQuest,
  // global events (T093)
  logGlobalEvent, getGlobalEvents, getGlobalEventsSince, countKillsSince,
  // subastas (T098)
  createAuction, getActiveAuctions, getAuction, placeBid, closeExpiredAuctions, getRecentClosedAuctions,
  createPassiveAuction, getActivePassiveAuctions, // DIS-535
  // acceso raw (por si acaso)
  raw: () => db,
  // T115: logros secretos
  trackRoomVisit, addGoldSpent, addCraftsCount,
  // T140: runas coleccionables
  tryAddRune, getPlayerRunes, RUNE_TYPES, RUNE_EMOJIS, RUNE_BONUSES,
  // T141: desafío diario personal
  getDailyChallenge, updateDailyChallengeProgress,
  getWeeklyContract, updateWeeklyContractProgress,
  // T144: bounties
  addBounty, getBountiesOnPlayer, getAllActiveBounties, claimBounty, expireOldBounties,
  // T147: mensajes en las paredes (graffiti)
  addWallMessage, getWallMessages, cleanBotWallMessages,
  // T149: monstruos muertos recientes
  getRecentlyDeadMonsters,
  getDeadMonstersForRoom,
  // T156-T158: sesiones e historial de tiempo
  saveSession, getPlayerSessions, getLeaderboardByPlaytime, getWeeklyStats,
  getFallenHardcorePlayers,
  // T181: mercado de jugadores
  createMarketListing, getActiveMarketListings, getMarketListing, buyMarketItem, cancelMarketListing, expireOldMarketListings, getPlayerMarketListings,
  // T188: tablón global de anuncios
  addBulletinPost, getBulletinPosts, getPlayerBulletinPosts, deleteBulletinPost, expireOldBulletinPosts,
  // T194: metas globales del servidor
  incrementWorldGoal, getWorldGoalsDisplay, WORLD_GOAL_MILESTONES, WORLD_GOAL_LABELS,
  // T195: récords del servidor
  trySetServerRecord, getAllServerRecords, SERVER_RECORDS_DEFS,
  // T212: campeón de la hora
  incrementHourlyKills, getHourlyChampion,
   // T219: racha de login diario
   processLoginStreak,
  // EPIC-962: legados (Sistema de Ascensión)
  createLegacyEntry, getLegaciesByAccount, getAllLegacies, getUnclaimedLegacyItem, claimLegacyItem, setLegacyItem,
  // EPIC-MR-1083: World State colectivo
  initWorldState, incrementWorldState, setWorldState, getWorldStateValues, getWorldStateSnapshot,
  // EPIC-1156: Expediciones
  getActiveExpedition, assignExpeditionToDB, advanceExpeditionStep, completeExpeditionInDB, getCompletedExpeditions,
  // T-1224: Eventos cíclicos globales (La Gaceta del Corredor)
  getActiveGlobalEvent, setActiveGlobalEvent, clearExpiredGlobalEvents,
  // T-1229: Desafíos diarios y semanal colectivo (Gaceta del Corredor Fase 2)
  getDailyChallengeProgress, updateChallengeProgress,
  getWeeklyChallengeState, setWeeklyChallenge, incrementWeeklyProgress,
  // T-1233: world_state por clave individual, Aldric Rep
  getWorldStateValue, getAldricRep, addAldricRep,
  };