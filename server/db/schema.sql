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

-- EPIC-QD (IMPL-QD-1572): Sistema de Quests Dinámicas

CREATE TABLE IF NOT EXISTS quest_definitions (
  id                TEXT PRIMARY KEY,        -- ej: 'kill_esqueletos_generic', 'chain_velas_1'
  name              TEXT NOT NULL,           -- nombre visible: "El Cazador de Sombras"
  description       TEXT NOT NULL,           -- descripción completa al jugador
  type              TEXT NOT NULL,           -- 'kill' | 'explore' | 'craft' | 'trade' | 'ritual' | 'boss' | 'chain'
  slot              TEXT NOT NULL,           -- 'principal' | 'secundaria' | 'narrativa'
  condition         TEXT NOT NULL,           -- JSON de condición de completado
  reward            TEXT NOT NULL,           -- JSON de recompensa
  require_level     INTEGER NOT NULL DEFAULT 1,
  require_faction   TEXT,                    -- 'orden_filo' | 'conclave_arcano' | 'hermandad_mercado' | NULL
  require_class     TEXT,                    -- 'guerrero' | 'mago' | 'clerigo' | NULL
  chain_id          TEXT,                    -- ID de la cadena narrativa o NULL
  chain_step        INTEGER,                 -- paso en la cadena o NULL
  chain_prev_id     TEXT,                    -- quest anterior prerequisito o NULL
  weekly_seed_group TEXT,                    -- grupo de rotación semanal o NULL
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS player_quests (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id            TEXT NOT NULL,        -- FK → players.id
  quest_id             TEXT NOT NULL,        -- FK → quest_definitions.id
  status               TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'completed' | 'abandoned'
  progress             TEXT NOT NULL DEFAULT '{}',      -- JSON de progreso actual
  assigned_at          TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at         TEXT,
  abandoned_at         TEXT,
  abandon_cooldown_until TEXT,
  slot                 TEXT NOT NULL         -- 'principal' | 'secundaria' | 'narrativa'
);

CREATE INDEX IF NOT EXISTS idx_player_quests_player_status
  ON player_quests(player_id, status);
