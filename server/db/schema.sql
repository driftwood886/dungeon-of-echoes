-- Dungeon of Echoes — Schema SQL
-- Nota: este archivo es referencia. La inicialización real se hace en db.js
-- usando sql.js (SQLite via WebAssembly, sin dependencias nativas).

CREATE TABLE IF NOT EXISTS players (
  id          TEXT PRIMARY KEY,          -- UUID
  username    TEXT UNIQUE NOT NULL,
  hp          INTEGER NOT NULL DEFAULT 30,
  max_hp      INTEGER NOT NULL DEFAULT 30,
  attack      INTEGER NOT NULL DEFAULT 5,
  defense     INTEGER NOT NULL DEFAULT 2,
  current_room_id INTEGER NOT NULL DEFAULT 1,
  inventory   TEXT NOT NULL DEFAULT '[]', -- JSON array
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rooms (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  exits       TEXT NOT NULL DEFAULT '{}', -- JSON: {"north": 2, "east": 3}
  items       TEXT NOT NULL DEFAULT '[]', -- JSON array of item names on the floor
  is_generated INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS monsters (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  hp          INTEGER NOT NULL,
  max_hp      INTEGER NOT NULL,
  attack      INTEGER NOT NULL DEFAULT 4,
  room_id     INTEGER,                   -- NULL = dead / no room
  loot        TEXT NOT NULL DEFAULT '[]', -- JSON array
  respawn_room_id INTEGER,               -- habitación donde respawnea
  respawn_at  TEXT                       -- ISO timestamp, NULL = no respawn pendiente
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id   TEXT,
  room_id     INTEGER,
  action      TEXT NOT NULL,
  result      TEXT NOT NULL,
  timestamp   TEXT NOT NULL DEFAULT (datetime('now'))
);
