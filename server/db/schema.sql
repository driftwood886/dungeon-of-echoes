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

-- EPIC-GREMIOS (GUILD-DEF-001): Sistema de Gremios de Jugadores

CREATE TABLE IF NOT EXISTS guilds (
  id                      TEXT PRIMARY KEY,
  name                    TEXT UNIQUE NOT NULL,
  leader_id               TEXT NOT NULL,              -- FK → players.id (fundador/líder actual)
  rank                    INTEGER NOT NULL DEFAULT 1, -- 1=Banda, 2=Gremio, 3=Forjado, 4=Legendario
  gold                    INTEGER NOT NULL DEFAULT 0,
  items_json              TEXT NOT NULL DEFAULT '[]', -- JSON array de ítems en el banco del gremio
  weekly_kills            INTEGER NOT NULL DEFAULT 0, -- kills acumulados esta semana
  weekly_quests           INTEGER NOT NULL DEFAULT 0, -- quests completadas esta semana
  total_hazanas           INTEGER NOT NULL DEFAULT 0, -- hazañas totales (determina rango)
  lore                    TEXT,                        -- descripción/lore personalizable
  weekly_reset_at         TEXT,                        -- timestamp del último reset semanal
  weekly_objective_type   TEXT,                        -- slug del objetivo especial semanal
  weekly_objective_progress INTEGER NOT NULL DEFAULT 0, -- progreso del objetivo especial
  hall_description        TEXT,                        -- descripción Guarida (Rango 2+)
  hall_bulletin           TEXT NOT NULL DEFAULT '[]', -- JSON array de mensajes del tablón
  created_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

-- guild_id en players: NULL = sin gremio
-- ALTER TABLE players ADD COLUMN guild_id TEXT REFERENCES guilds(id);

CREATE INDEX IF NOT EXISTS idx_guilds_name ON guilds(name);
CREATE INDEX IF NOT EXISTS idx_players_guild_id ON players(guild_id);
CREATE INDEX IF NOT EXISTS idx_guilds_rank ON guilds(rank);


-- EPIC-ECOS (EPIC-2327-IMPL): Sistema Ecos de los Caídos

CREATE TABLE IF NOT EXISTS room_scars (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id     INTEGER NOT NULL,
  scar_type   TEXT NOT NULL,
  -- 'combat_intense' | 'player_death' | 'boss_kill'
  context     TEXT NOT NULL DEFAULT '{}',
  -- JSON: { player_name, damage_dealt?, monster_name?, class?, level?, cause?, boss_name?, player_won? }
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL   -- combat_intense: 3h; player_death: 6h; boss_kill: 8h
);

CREATE INDEX IF NOT EXISTS idx_room_scars_room    ON room_scars(room_id);
CREATE INDEX IF NOT EXISTS idx_room_scars_expires ON room_scars(expires_at);

CREATE TABLE IF NOT EXISTS fallen_loot (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id       INTEGER NOT NULL,
  fallen_player TEXT NOT NULL,
  fallen_class  TEXT,
  fallen_level  INTEGER,
  item_name     TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT NOT NULL   -- 2 horas desde la muerte
);

CREATE INDEX IF NOT EXISTS idx_fallen_loot_room    ON fallen_loot(room_id);
CREATE INDEX IF NOT EXISTS idx_fallen_loot_player  ON fallen_loot(fallen_player);
CREATE INDEX IF NOT EXISTS idx_fallen_loot_expires ON fallen_loot(expires_at);
