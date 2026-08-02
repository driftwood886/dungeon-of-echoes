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
const { generateRunState, generateNewSeed } = require('../game/run-state.js'); // EPIC-VV-1755

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
  // GUILD-DEF-001: Tabla de gremios (schema completo — Epic Gremios de Jugadores)
  db.run(`
    CREATE TABLE IF NOT EXISTS guilds (
      id                      TEXT PRIMARY KEY,
      name                    TEXT UNIQUE NOT NULL,
      leader_id               TEXT NOT NULL,
      rank                    INTEGER NOT NULL DEFAULT 1,
      gold                    INTEGER NOT NULL DEFAULT 0,
      items_json              TEXT NOT NULL DEFAULT '[]',
      weekly_kills            INTEGER NOT NULL DEFAULT 0,
      weekly_quests           INTEGER NOT NULL DEFAULT 0,
      total_hazanas           INTEGER NOT NULL DEFAULT 0,
      lore                    TEXT,
      weekly_reset_at         TEXT,
      weekly_objective_type   TEXT,
      weekly_objective_progress INTEGER NOT NULL DEFAULT 0,
      hall_description        TEXT,
      hall_bulletin           TEXT NOT NULL DEFAULT '[]',
      created_at              TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // EPIC-PARTY-1626: Tabla del Sistema de Party
  db.run(`
    CREATE TABLE IF NOT EXISTS parties (
      id           TEXT PRIMARY KEY,
      leader_id    TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      status       TEXT NOT NULL DEFAULT 'active',
      dissolved_at TEXT,
      last_active  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_parties_status ON parties(status)`);

  // EPIC-QD: Tablas del Sistema de Quests Dinámicas (IMPL-QD-1572)
  db.run(`
    CREATE TABLE IF NOT EXISTS quest_definitions (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      description       TEXT NOT NULL,
      type              TEXT NOT NULL,
      slot              TEXT NOT NULL,
      condition         TEXT NOT NULL,
      reward            TEXT NOT NULL,
      require_level     INTEGER NOT NULL DEFAULT 1,
      require_faction   TEXT,
      require_class     TEXT,
      chain_id          TEXT,
      chain_step        INTEGER,
      chain_prev_id     TEXT,
      weekly_seed_group TEXT,
      is_active         INTEGER NOT NULL DEFAULT 1,
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS player_quests (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id            TEXT NOT NULL,
      quest_id             TEXT NOT NULL,
      status               TEXT NOT NULL DEFAULT 'active',
      progress             TEXT NOT NULL DEFAULT '{}',
      assigned_at          TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at         TEXT,
      abandoned_at         TEXT,
      abandon_cooldown_until TEXT,
      slot                 TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_player_quests_player_status
      ON player_quests(player_id, status)
  `);

  // EPIC-QD: Seed del pool inicial de 15 quests genéricas (IMPL-QD-1579)
  // INSERT OR IGNORE — idempotente: solo inserta si la quest no existe aún
  const QUEST_POOL_SEED = [
    // ── KILL QUESTS (4) ──────────────────────────────────────────────────────
    {
      id: 'kill_goblin_generic',
      name: 'La Caza en el Corredor', // DIS-1590: renombrado para reflejar que acepta cualquier goblin del Corredor de las Sombras
      description: 'Los goblins del Corredor de las Sombras han estado robando provisiones. Aldric necesita garras de goblin para un encantamiento de protección. Merodeadores, Exploradores — cualquiera sirve. Los encontrarás hacia el este desde la entrada.',
      type: 'kill',
      slot: 'secundaria',
      condition: JSON.stringify({ event: 'kill', target_type: 'goblin', count: 5 }),
      reward: JSON.stringify({ gold: 30, xp: 20, aldric_rep: 3 }),
      require_level: 1,
      require_faction: null,
      require_class: null,
      chain_id: null,
      chain_step: null,
      chain_prev_id: null,
      weekly_seed_group: 'kill_A',
      is_active: 1,
    },
    {
      id: 'kill_esqueleto_generic',
      name: 'Polvo al Polvo',
      description: 'Los Esqueletos Guerreros de la Cámara del Tesoro se han vuelto más activos. La magia que los anima se debilita si se destruyen — pero vuelven. Destruye 3 antes de que se reagrupen.',
      type: 'kill',
      slot: 'secundaria',
      condition: JSON.stringify({ event: 'kill', target_type: 'esqueleto', count: 3 }),
      reward: JSON.stringify({ gold: 35, xp: 25, aldric_rep: 3 }),
      require_level: 1,
      require_faction: null,
      require_class: null,
      chain_id: null,
      chain_step: null,
      chain_prev_id: null,
      weekly_seed_group: 'kill_B',
      is_active: 1,
    },
    {
      id: 'kill_murcielago_generic',
      name: 'Las Sombras Aladas',
      description: 'Los Murciélagos Vampiro que anidan en los techos de la Capilla Olvidada se han vuelto agresivos — alguien perturbó sus colonias. Derrota 4 antes de que el altar quede inaccesible.',
      type: 'kill',
      slot: 'secundaria',
      condition: JSON.stringify({ event: 'kill', target_type: 'murciélago', count: 4 }),
      reward: JSON.stringify({ gold: 28, xp: 18 }),
      require_level: 1,
      require_faction: null,
      require_class: null,
      chain_id: null,
      chain_step: null,
      chain_prev_id: null,
      weekly_seed_group: 'kill_C',
      is_active: 1,
    },
    {
      id: 'kill_araña_generic',
      name: 'Limpieza del Nido',
      description: 'Las Arañas Tejedoras del Pozo Sin Fondo están expandiendo su territorio hacia el norte. Si no se controlan, bloquearán el paso a zonas más profundas. Elimina 3 antes de que el nido crezca.',
      type: 'kill',
      slot: 'secundaria',
      condition: JSON.stringify({ event: 'kill', target_type: 'araña', count: 3 }),
      reward: JSON.stringify({ gold: 40, xp: 30 }),
      require_level: 3,
      require_faction: null,
      require_class: null,
      chain_id: null,
      chain_step: null,
      chain_prev_id: null,
      weekly_seed_group: 'kill_A',
      is_active: 1,
    },
    // ── EXPLORE QUESTS (3) ───────────────────────────────────────────────────
    {
      id: 'explore_santuario_profano',
      name: 'El Santuario Olvidado',
      description: 'El anciano menciona que el Santuario Profano guarda inscripciones que nadie transcribió en generaciones. No pide que las leas — solo que confirmes que siguen ahí. Visita el Santuario y regresa vivo.',
      type: 'explore',
      slot: 'secundaria',
      condition: JSON.stringify({ event: 'explore', target_room_id: 10, require_not_visited: true }),
      reward: JSON.stringify({ gold: 25, xp: 35 }),
      require_level: 3,
      require_faction: null,
      require_class: null,
      chain_id: null,
      chain_step: null,
      chain_prev_id: null,
      weekly_seed_group: 'explore_A',
      is_active: 1,
    },
    {
      id: 'explore_catedral',
      name: 'La Catedral de la Oscuridad',
      description: 'Pocos se atreven a poner un pie en la Catedral de la Oscuridad — el dominio del Lich Anciano. El anciano quiere saber si las ruinas que recuerda siguen en pie. Visita la Catedral y vuelve para contarlo.',
      type: 'explore',
      slot: 'secundaria',
      condition: JSON.stringify({ event: 'explore', target_room_id: 15, require_not_visited: true }),
      reward: JSON.stringify({ gold: 50, xp: 60 }),
      require_level: 5,
      require_faction: null,
      require_class: null,
      chain_id: null,
      chain_step: null,
      chain_prev_id: null,
      weekly_seed_group: 'explore_B',
      is_active: 1,
    },
    {
      id: 'explore_salas_nuevas',
      name: 'El Explorador',
      description: 'El dungeon es más grande de lo que parece. Explora 3 salas que nunca hayas pisado — el anciano dice que el simple acto de ver algo nuevo cambia al viajero.',
      type: 'explore',
      slot: 'secundaria',
      condition: JSON.stringify({ event: 'explore', target_room_id: null, new_rooms_count: 3, require_not_visited: true }),
      reward: JSON.stringify({ gold: 20, xp: 25 }),
      require_level: 1,
      require_faction: null,
      require_class: null,
      chain_id: null,
      chain_step: null,
      chain_prev_id: null,
      weekly_seed_group: 'explore_C',
      is_active: 1,
    },
    // ── CRAFT QUESTS (3) ─────────────────────────────────────────────────────
    {
      id: 'craft_pocion_vida',
      name: 'El Alquimista',
      description: 'Aldric necesita una poción de vida preparada fresca. Craftea una mezclando hierba curativa con una poción menor o una poción de salud.',
      type: 'craft',
      slot: 'secundaria',
      condition: JSON.stringify({ event: 'craft', target_item: 'poción de vida', count: 1 }),
      reward: JSON.stringify({ gold: 35, xp: 20, aldric_rep: 3 }),
      require_level: 1,
      require_faction: null,
      require_class: null,
      chain_id: null,
      chain_step: null,
      chain_prev_id: null,
      weekly_seed_group: 'craft_A',
      is_active: 1,
    },
    {
      id: 'craft_arma_veneno',
      name: 'El Herrero Improvisado',
      description: 'Un arma envenenada puede cambiar el resultado de un combate. Fabricá una espada envenenada combinando veneno concentrado con una espada oxidada.',
      type: 'craft',
      slot: 'secundaria',
      condition: JSON.stringify({ event: 'craft', target_item: 'espada envenenada', count: 1 }),
      reward: JSON.stringify({ gold: 40, xp: 30 }),
      require_level: 2,
      require_faction: null,
      require_class: null,
      chain_id: null,
      chain_step: null,
      chain_prev_id: null,
      weekly_seed_group: 'craft_B',
      is_active: 1,
    },
    {
      id: 'craft_escudo_gladiador',
      name: 'La Defensa del Gladiador',
      description: 'Con los materiales correctos, hasta un escudo roto puede convertirse en algo digno. Consigue una garra de esqueleto y un escudo roto, y craftea el Escudo de Gladiador.',
      type: 'craft',
      slot: 'secundaria',
      condition: JSON.stringify({ event: 'craft', target_item: 'escudo de gladiador', count: 1 }),
      reward: JSON.stringify({ gold: 45, xp: 35 }),
      require_level: 2,
      require_faction: null,
      require_class: null,
      chain_id: null,
      chain_step: null,
      chain_prev_id: null,
      weekly_seed_group: null,  // BUG-1934: no entra al pool aleatorio — se asigna por trigger (recoger escudo roto/garra)
      is_active: 1,
    },
    // ── TRADE QUESTS (3) ─────────────────────────────────────────────────────
    {
      id: 'trade_vender_loot',
      name: 'El Comerciante del Dungeon',
      description: 'Aldric siempre necesita materiales frescos del dungeon. Vende 2 ítems en su tienda (sala 4). No importa qué ítems — lo que traigas del dungeon tiene valor.',
      type: 'trade',
      slot: 'secundaria',
      condition: JSON.stringify({ event: 'trade', action: 'sell', count: 2 }),
      reward: JSON.stringify({ gold: 25, xp: 15, aldric_rep: 3 }),
      require_level: 1,
      require_faction: null,
      require_class: null,
      chain_id: null,
      chain_step: null,
      chain_prev_id: null,
      weekly_seed_group: 'trade_A',
      is_active: 1,
    },
    {
      id: 'trade_subasta',
      name: 'El Corredor de Subastas',
      description: 'La Casa de Subastas necesita más participantes activos. Subastá un ítem — lo que sea — y ponelo en circulación. El escriba lo agradecerá.',
      type: 'trade',
      slot: 'secundaria',
      condition: JSON.stringify({ event: 'trade', action: 'auction', count: 1 }),
      reward: JSON.stringify({ gold: 30, xp: 20 }),
      require_level: 1,
      require_faction: null,
      require_class: null,
      chain_id: null,
      chain_step: null,
      chain_prev_id: null,
      weekly_seed_group: 'trade_B',
      is_active: 1,
    },
    {
      id: 'trade_comprar_equipo',
      name: 'Inversión Táctica',
      description: 'Aldric vende equipamiento que puede salvarte la vida en el dungeon. Comprá algo por al menos 20 gold en su tienda — una inversión que vale la pena.',
      type: 'trade',
      slot: 'secundaria',
      condition: JSON.stringify({ event: 'trade', action: 'buy', min_value: 20, count: 1 }),
      reward: JSON.stringify({ gold: 25, xp: 5 }),
      require_level: 1,
      require_faction: null,
      require_class: null,
      chain_id: null,
      chain_step: null,
      chain_prev_id: null,
      weekly_seed_group: 'trade_C',
      is_active: 1,
    },
    // ── RITUAL QUESTS (2) ────────────────────────────────────────────────────
    {
      id: 'ritual_pray_capilla',
      name: 'La Devoción del Corredor',
      description: 'La Capilla Olvidada tiene un altar que lleva años sin recibir devotos regulares. Reza 2 veces ante él — el anciano dice que los rituales repetidos tienen un efecto distinto al de una oración solitaria.',
      type: 'ritual',
      slot: 'secundaria',
      condition: JSON.stringify({ event: 'ritual', action: 'pray', count: 2 }),
      reward: JSON.stringify({ gold: 25, xp: 20 }),
      require_level: 1,
      require_faction: null,
      require_class: null,
      chain_id: null,
      chain_step: null,
      chain_prev_id: null,
      weekly_seed_group: 'ritual_A',
      is_active: 1,
    },
    {
      id: 'ritual_expedicion',
      name: 'El Explorador Profundo',
      description: 'Las expediciones revelan secretos del dungeon que la exploración normal no alcanza. Completá una expedición desde el altar de la Capilla Olvidada.',
      type: 'ritual',
      slot: 'secundaria',
      condition: JSON.stringify({ event: 'ritual', action: 'use_altar', count: 1 }),
      reward: JSON.stringify({ gold: 50, xp: 40 }),
      require_level: 2,
      require_faction: null,
      require_class: null,
      chain_id: null,
      chain_step: null,
      chain_prev_id: null,
      weekly_seed_group: 'ritual_B',
      is_active: 1,
    },
    // ── QUESTS DE FACCIÓN — slot principal (DIS-1589) ────────────────────────
    // Orden del Filo: combate con postura agresiva
    {
      id: 'faccion_orden_filo_purga',
      name: 'La Purga de la Orden',
      description: 'La Orden del Filo no tolera monstruos incontrolados en el dungeon. Tu capitán tiene una orden clara: eliminá 4 criaturas en postura agresiva, sin piedad ni defensa. La Orden mide a sus miembros por el rastro de sangre que dejan.',
      type: 'kill',
      slot: 'principal',
      condition: JSON.stringify({ event: 'kill', target_type: 'any', require_stance: 'agresivo', count: 4 }),
      reward: JSON.stringify({ gold: 45, xp: 35, faction_influence: 5 }),
      require_level: 1,
      require_faction: 'orden_filo',
      require_class: null,
      chain_id: null,
      chain_step: null,
      chain_prev_id: null,
      weekly_seed_group: 'faccion_orden_A',
      is_active: 1,
    },
    // Orden del Filo: caza de élite (nivel 3+)
    {
      id: 'faccion_orden_filo_elite',
      name: 'El Contrato de Élite',
      description: 'Los guerreros curtidos de la Orden cumplen contratos que otros rechazan. Tu misión esta semana: eliminá 5 monstruos en postura agresiva. Nada de escudos, nada de rodeos — la Orden paga bien a quienes no hacen preguntas.',
      type: 'kill',
      slot: 'principal',
      condition: JSON.stringify({ event: 'kill', target_type: 'any', require_stance: 'agresivo', count: 5 }),
      reward: JSON.stringify({ gold: 65, xp: 50, faction_influence: 8 }),
      require_level: 3,
      require_faction: 'orden_filo',
      require_class: null,
      chain_id: null,
      chain_step: null,
      chain_prev_id: null,
      weekly_seed_group: 'faccion_orden_B',
      is_active: 1,
    },
    // Cónclave Arcano: exploración de salas clave
    {
      id: 'faccion_conclave_cartografia',
      name: 'Cartografía Arcana',
      description: 'El Cónclave necesita registros de primera mano de zonas poco exploradas del dungeon. Tu tarea: visitá 3 salas que no hayas pisado antes y reportá mentalmente los detalles al Cónclave al regresar. El conocimiento es poder — y el Cónclave lo sabe.',
      type: 'explore',
      slot: 'principal',
      condition: JSON.stringify({ event: 'explore', target_room_id: null, new_rooms_count: 3, require_not_visited: true }),
      reward: JSON.stringify({ gold: 35, xp: 45, faction_influence: 5 }),
      require_level: 1,
      require_faction: 'conclave_arcano',
      require_class: null,
      chain_id: null,
      chain_step: null,
      chain_prev_id: null,
      weekly_seed_group: 'faccion_conclave_A',
      is_active: 1,
    },
    // Cónclave Arcano: ritual en zona peligrosa
    // BUG-1654: era type='explore' — se completaba al entrar a sala 10, no al rezar.
    // La descripción prometía "rezar ante su altar" pero el trigger era onExplore.
    // Fix: type='ritual', condition action='pray', count=1.
    {
      id: 'faccion_conclave_ritual_profundo',
      name: 'Ritual en la Oscuridad',
      description: 'El Cónclave estudia los patrones mágicos del dungeon. Para esta semana: andá al Santuario Profano (sala 10) y rezá ante el altar de la estatua de diez brazos. Ofrendá cualquier ítem con `pray <ítem>`. Los datos rituales que recopiles serán invaluables para la investigación arcana.',
      type: 'ritual',
      slot: 'principal',
      condition: JSON.stringify({ action: 'pray', count: 1, target_room_id: 10 }),
      reward: JSON.stringify({ gold: 50, xp: 60, faction_influence: 8 }),
      require_level: 3,
      require_faction: 'conclave_arcano',
      require_class: null,
      chain_id: null,
      chain_step: null,
      chain_prev_id: null,
      weekly_seed_group: 'faccion_conclave_B',
      is_active: 1,
    },
    // Hermandad del Mercado: movimiento económico
    {
      id: 'faccion_hermandad_flujo',
      name: 'El Flujo del Mercado',
      description: 'La Hermandad necesita que el oro circule. Esta semana, tu cuota: vendé 3 ítems en la tienda de Aldric. No importa el precio — lo que importa es que el mercado se mantenga activo. Una Hermandad que no comercia es una Hermandad que muere.',
      type: 'trade',
      slot: 'principal',
      condition: JSON.stringify({ event: 'trade', action: 'sell', count: 3 }),
      reward: JSON.stringify({ gold: 40, xp: 25, faction_influence: 5 }),
      require_level: 1,
      require_faction: 'hermandad_mercado',
      require_class: null,
      chain_id: null,
      chain_step: null,
      chain_prev_id: null,
      weekly_seed_group: 'faccion_hermandad_A',
      is_active: 1,
    },
    // Hermandad del Mercado: subasta como movimiento táctico
    {
      id: 'faccion_hermandad_subasta_tactita',
      name: 'La Movida de la Subasta',
      description: 'La Casa de Subastas es territorio de la Hermandad. Esta semana: subastá un ítem y comprá algo por al menos 30 gold. La Hermandad recompensa a quienes entienden que el verdadero poder está en controlar quién compra y quién vende.',
      type: 'trade',
      slot: 'principal',
      condition: JSON.stringify({ event: 'trade', action: 'buy', min_value: 30, count: 1 }),
      reward: JSON.stringify({ gold: 55, xp: 35, faction_influence: 8 }),
      require_level: 2,
      require_faction: 'hermandad_mercado',
      require_class: null,
      chain_id: null,
      chain_step: null,
      chain_prev_id: null,
      weekly_seed_group: 'faccion_hermandad_B',
      is_active: 1,
    },
    // ── QUESTS SECUNDARIAS MID-GAME (nivel 8+) — DIS-2084 ────────────────────
    {
      id: 'kill_espectro_elite',
      name: 'Cazador de Espectros',
      description: 'Los Espectros del Corredor de las Sombras han comenzado a manifestarse con mayor intensidad. Se necesita alguien con experiencia real — no un novato. Derrota 6 Espectros antes de que consoliden su presencia en el corredor este.',
      type: 'kill',
      slot: 'secundaria',
      condition: JSON.stringify({ event: 'kill', target_type: 'espectro', count: 6 }),
      reward: JSON.stringify({ gold: 80, xp: 70, aldric_rep: 5 }),
      require_level: 8,
      require_faction: null,
      require_class: null,
      chain_id: null,
      chain_step: null,
      chain_prev_id: null,
      weekly_seed_group: 'mid_kill_A',
      is_active: 1,
    },
    {
      id: 'kill_campeon_espectral_elite',
      name: 'El Contrato del Coliseo',
      description: 'El Campeón Espectral del Coliseo reclama víctimas regularmente. Aldric necesita muestras de su energía residual — cosa que solo se obtiene derrotándolo. Entrá al Coliseo y terminá con él.',
      type: 'kill',
      slot: 'secundaria',
      condition: JSON.stringify({ event: 'kill', target_type: 'campeón', count: 1 }),
      reward: JSON.stringify({ gold: 100, xp: 90, aldric_rep: 8 }),
      require_level: 8,
      require_faction: null,
      require_class: null,
      chain_id: null,
      chain_step: null,
      chain_prev_id: null,
      weekly_seed_group: 'mid_kill_B',
      is_active: 1,
    },
    {
      id: 'trade_vender_loot_masivo',
      name: 'El Proveedor de Aldric',
      description: 'Aldric tiene pedidos acumulados que un aventurero común no podría satisfacer. Necesita 8 ítems — de lo que sea. Un veterano del dungeon como vos debería poder limpiar el botín suficiente sin problema.',
      type: 'trade',
      slot: 'secundaria',
      condition: JSON.stringify({ event: 'trade', action: 'sell', count: 8 }),
      reward: JSON.stringify({ gold: 90, xp: 60, aldric_rep: 10 }),
      require_level: 8,
      require_faction: null,
      require_class: null,
      chain_id: null,
      chain_step: null,
      chain_prev_id: null,
      weekly_seed_group: 'mid_trade_A',
      is_active: 1,
    },
    {
      id: 'explore_salas_profundas',
      name: 'El Cartógrafo del Abismo',
      description: 'El dungeon tiene zonas que ni los mapas más completos registran. Explorá 5 salas que nunca hayas visitado — en las profundidades, no en los corredores conocidos. Aldric paga bien por datos frescos.',
      type: 'explore',
      slot: 'secundaria',
      condition: JSON.stringify({ event: 'explore', target_room_id: null, new_rooms_count: 5, require_not_visited: true }),
      reward: JSON.stringify({ gold: 75, xp: 80 }),
      require_level: 8,
      require_faction: null,
      require_class: null,
      chain_id: null,
      chain_step: null,
      chain_prev_id: null,
      weekly_seed_group: 'mid_explore_A',
      is_active: 1,
    },
    // ── QUESTS SECUNDARIAS LATE-GAME (nivel 12+) — DIS-2084 ──────────────────
    {
      id: 'kill_lich_anciano_caceria',
      name: 'La Gran Cacería',
      description: 'El Lich Anciano es el apex predator del dungeon. Cazarlo es un rito de paso que pocos completan. La Alianza de Aventureros ofrece una recompensa excepcional — pero no para quienes lleguen sin preparación.',
      type: 'kill',
      slot: 'secundaria',
      condition: JSON.stringify({ event: 'kill', target_type: 'lich', count: 1 }),
      reward: JSON.stringify({ gold: 150, xp: 130, aldric_rep: 15 }),
      require_level: 12,
      require_faction: null,
      require_class: null,
      chain_id: null,
      chain_step: null,
      chain_prev_id: null,
      weekly_seed_group: 'late_kill_A',
      is_active: 1,
    },
    {
      id: 'kill_masacre_profunda',
      name: 'La Masacre Profunda',
      description: 'Las criaturas de las zonas más profundas del dungeon se han vuelto caóticas. Se necesita un exterminador con experiencia real. Eliminá 10 criaturas de cualquier tipo — pero en las zonas profundas (no vale farmear en los corredores del inicio).',
      type: 'kill',
      slot: 'secundaria',
      condition: JSON.stringify({ event: 'kill', target_type: 'any', count: 10, min_room_id: 9 }),
      reward: JSON.stringify({ gold: 120, xp: 100 }),
      require_level: 12,
      require_faction: null,
      require_class: null,
      chain_id: null,
      chain_step: null,
      chain_prev_id: null,
      weekly_seed_group: 'late_kill_B',
      is_active: 1,
    },
    {
      id: 'trade_inversor_experto',
      name: 'El Inversor Experto',
      description: 'Aldric busca un socio comercial de alto nivel — alguien que mueva oro de verdad. Comprá equipamiento por un total de 200 gold esta semana. Él te devuelve el favor con interés.',
      type: 'trade',
      slot: 'secundaria',
      condition: JSON.stringify({ event: 'trade', action: 'buy', min_value: 200, count: 1 }),
      reward: JSON.stringify({ gold: 140, xp: 80, aldric_rep: 15 }),
      require_level: 12,
      require_faction: null,
      require_class: null,
      chain_id: null,
      chain_step: null,
      chain_prev_id: null,
      weekly_seed_group: 'late_trade_A',
      is_active: 1,
    },
    // ── QUEST CHAIN: LAS VELAS DEL ALTAR (4 quests narrativas) ───────────────
    {
      id: 'chain_velas_1',
      name: 'Las Velas del Altar — I. La Cera Fresca',
      description: 'En la Capilla Olvidada, entre las velas del altar, notaste algo extraño: la cera está fresca — encendida hoy. El anciano dice que él no viene aquí. ¿Quién visita este altar?\n\nHablá con Vartan (el guardián anciano en la Entrada de la Cripta, sala 1) y luego regresá a la Capilla.',
      type: 'chain',
      slot: 'narrativa',
      condition: JSON.stringify({ event: 'chain_trigger', trigger: 'talk_npc', npc_id: 'anciano', and_then_visit_room: 5 }),
      reward: JSON.stringify({ gold: 10, xp: 15 }),
      require_level: 1,
      require_faction: null,
      require_class: null,
      chain_id: 'velas_altar',
      chain_step: 1,
      chain_prev_id: null,
      weekly_seed_group: null,
      is_active: 1,
    },
    {
      id: 'chain_velas_2',
      name: 'Las Velas del Altar — II. El Rastro de Cera',
      description: 'Volviste a la Capilla y las velas siguen encendidas. Esta vez notaste gotas de cera en el piso que llevan hacia el norte — hacia la Prisión. El rastro se pierde en el corredor.\n\nSeguí las gotas. Visitá la Prisión Subterránea y luego la Casa de Subastas al norte.',
      type: 'chain',
      slot: 'narrativa',
      condition: JSON.stringify({ event: 'chain_trigger', trigger: 'visit_room', room_id: 17 }),
      reward: JSON.stringify({ gold: 15, xp: 20 }),
      require_level: 1,
      require_faction: null,
      require_class: null,
      chain_id: 'velas_altar',
      chain_step: 2,
      chain_prev_id: 'chain_velas_1',
      weekly_seed_group: null,
      is_active: 1,
    },
    {
      id: 'chain_velas_3',
      name: 'Las Velas del Altar — III. La Escriba y el Altar',
      description: 'La escriba de la Casa de Subastas tiene cera en el escritorio del mismo color que las velas del altar. Cuando mencionaste las velas, algo cambió en su cara — solo por un momento.\n\nHablá con ella. Después, hablá con Aldric — él lleva años aquí y conoce a todos.',
      type: 'chain',
      slot: 'narrativa',
      condition: JSON.stringify({ event: 'chain_trigger', trigger: 'talk_npc', npc_id: 'aldric', quest_context: 'chain_velas' }),
      reward: JSON.stringify({ gold: 20, xp: 25, aldric_rep: 5 }),
      require_level: 1,
      require_faction: null,
      require_class: null,
      chain_id: 'velas_altar',
      chain_step: 3,
      chain_prev_id: 'chain_velas_2',
      weekly_seed_group: null,
      is_active: 1,
    },
    {
      id: 'chain_velas_4',
      name: 'Las Velas del Altar — IV. Lo que Deja la Cera',
      description: 'Aldric te dio una nota vieja con el símbolo de dos llaves cruzadas. Dice: "Capilla, tercer altar desde la izquierda. Acá espero."\n\nVolvé a la Capilla Olvidada y dejá la nota en el tercer altar.',
      type: 'chain',
      slot: 'narrativa',
      condition: JSON.stringify({ event: 'chain_trigger', trigger: 'visit_room', room_id: 5, requires_item_in_inv: 'nota de las dos llaves' }),
      reward: JSON.stringify({ gold: 50, xp: 75, title: 'Investigador del Altar' }),
      require_level: 1,
      require_faction: null,
      require_class: null,
      chain_id: 'velas_altar',
      chain_step: 4,
      chain_prev_id: 'chain_velas_3',
      weekly_seed_group: null,
      is_active: 1,
    },
  ];

  // BUG-1580: sql.js requiere que las keys de named params tengan el prefijo '@'
  // (ej: {"@id": val} en vez de {id: val}). Sin el prefijo, todos los params
  // bindean como NULL y el INSERT falla silenciosamente por NOT NULL en 'name'.
  const _insertQuest = db.prepare(`
    INSERT OR IGNORE INTO quest_definitions
      (id, name, description, type, slot, condition, reward,
       require_level, require_faction, require_class,
       chain_id, chain_step, chain_prev_id, weekly_seed_group, is_active)
    VALUES
      (@id, @name, @description, @type, @slot, @condition, @reward,
       @require_level, @require_faction, @require_class,
       @chain_id, @chain_step, @chain_prev_id, @weekly_seed_group, @is_active)
  `);
  let _questsSeeded = 0;
  for (const _q of QUEST_POOL_SEED) {
    // Transformar keys: {id: ...} → {"@id": ...}
    const _qPrefixed = Object.fromEntries(Object.entries(_q).map(([k, v]) => [`@${k}`, v]));
    _insertQuest.run(_qPrefixed);
    _questsSeeded++;
  }
  console.log(`[db] EPIC-QD: ${_questsSeeded} quests en pool (INSERT OR IGNORE — idempotente)`);

  // BUG-1684: Tabla de control de migrations para evitar re-ejecutar ALTER TABLE en cada boot.
  // Sin esto, los ~84 ALTER TABLE lanzan excepciones (columna ya existe) en cada arranque
  // → ~13 segundos de inicio que crecen con cada migration nueva.
  // Con schema_migrations: cada migration se verifica con un SELECT O(1) y se skipea si ya está aplicada.
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Función auxiliar: aplica una migration solo si no fue registrada aún
  function applyMigration(sql) {
    const key = sql.trim();
    const rows = db.exec(`SELECT 1 FROM schema_migrations WHERE id = ?`, [key]);
    if (rows.length > 0 && rows[0].values.length > 0) return; // ya aplicada
    try {
      db.run(sql);
    } catch (_) {
      // columna ya existía (BD pre-sistema de migrations): igualmente registrar
    }
    try {
      db.run(`INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)`, [key]);
    } catch (_) {}
  }

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
    `ALTER TABLE players ADD COLUMN faction TEXT`,                                          // EPIC-1373: facción del jugador ('orden_filo' | 'conclave_arcano' | 'hermandad_mercado')
    `ALTER TABLE players ADD COLUMN faction_influence INTEGER NOT NULL DEFAULT 0`,          // EPIC-1373: contribución histórica total a su facción
    `ALTER TABLE players ADD COLUMN faction_week_influence INTEGER NOT NULL DEFAULT 0`,     // EPIC-1373: contribución a su facción esta semana (resetea lunes UTC)
    `ALTER TABLE players ADD COLUMN faction_changed_at TEXT`,                               // EPIC-1373: timestamp del último cambio de facción (cooldown 7 días)
    `ALTER TABLE players ADD COLUMN faction_notified INTEGER NOT NULL DEFAULT 0`,           // EPIC-1373: 1 si ya recibió el mensaje narrativo de invitación a facciones (nivel 3)
    `ALTER TABLE players ADD COLUMN party_follow INTEGER NOT NULL DEFAULT 0`,               // EPIC-PARTY-1626: 1 si está siguiendo al líder automáticamente (Fase 3: movimiento sincronizado)
    `ALTER TABLE players ADD COLUMN run_seed INTEGER`,                                       // EPIC-VV-1755: semilla del run actual (NULL = jugador pre-Epic)
    `ALTER TABLE players ADD COLUMN run_event TEXT`,                                         // EPIC-VV-1755: slug del evento activo (NULL = sin evento)
    `ALTER TABLE players ADD COLUMN run_monster_variants TEXT NOT NULL DEFAULT '{}'`,        // EPIC-VV-1755: JSON de variantes de monstruo por sala
    `ALTER TABLE players ADD COLUMN run_loot_positions TEXT NOT NULL DEFAULT '{}'`,          // EPIC-VV-1755: JSON de posición de ítems raros
    `ALTER TABLE players ADD COLUMN rune_hp_bonus INTEGER NOT NULL DEFAULT 0`,               // DIS-1770: tracking del HP máximo obtenido via fusión de runas (hielo +5, luz +3)
    `ALTER TABLE players ADD COLUMN last_target_monster_id INTEGER`,                          // BUG-1921: ID del último monstruo atacado con 'attack' (para que skills sin target apunten al target activo)
    `ALTER TABLE players ADD COLUMN main_quest_data TEXT NOT NULL DEFAULT '{}'`,              // EPIC-KAELTHAS (DIS-1967): JSON con estado de la quest principal — { fragments_found: [], main_quest_state: 'inactive'|'active'|'completed'|'ended', kaelthas_fragments_count: 0, lich_died_with_quest: false, started_at: null }
    // GUILD-DEF-001: Epic Gremios — ampliar tabla guilds con schema completo
    `ALTER TABLE guilds ADD COLUMN rank INTEGER NOT NULL DEFAULT 1`,                          // GUILD-DEF-001: rango del gremio (1=Banda, 2=Gremio, 3=Forjado, 4=Legendario)
    `ALTER TABLE guilds ADD COLUMN gold INTEGER NOT NULL DEFAULT 0`,                          // GUILD-DEF-001: oro en el banco del gremio
    `ALTER TABLE guilds ADD COLUMN items_json TEXT NOT NULL DEFAULT '[]'`,                    // GUILD-DEF-001: JSON array de ítems en el banco del gremio
    `ALTER TABLE guilds ADD COLUMN weekly_kills INTEGER NOT NULL DEFAULT 0`,                  // GUILD-DEF-001: kills acumulados esta semana (todos los miembros)
    `ALTER TABLE guilds ADD COLUMN weekly_quests INTEGER NOT NULL DEFAULT 0`,                 // GUILD-DEF-001: quests completadas esta semana (todos los miembros)
    `ALTER TABLE guilds ADD COLUMN total_hazanas INTEGER NOT NULL DEFAULT 0`,                 // GUILD-DEF-001: hazañas totales históricas (determina rango)
    `ALTER TABLE guilds ADD COLUMN lore TEXT`,                                                // GUILD-DEF-001: descripción/lore personalizable por el fundador
    `ALTER TABLE guilds ADD COLUMN weekly_reset_at TEXT`,                                     // GUILD-DEF-001: timestamp del último reset semanal de objetivos
    `ALTER TABLE guilds ADD COLUMN weekly_objective_type TEXT`,                               // GUILD-DEF-001: tipo de objetivo especial de la semana (slug)
    `ALTER TABLE guilds ADD COLUMN weekly_objective_progress INTEGER NOT NULL DEFAULT 0`,     // GUILD-DEF-001: progreso del objetivo especial
    `ALTER TABLE guilds ADD COLUMN hall_description TEXT`,                                    // GUILD-DEF-001: descripción personalizada de la Guarida (Rango 2+)
    `ALTER TABLE guilds ADD COLUMN hall_bulletin TEXT NOT NULL DEFAULT '[]'`,                 // GUILD-DEF-001: JSON array de mensajes del tablón de anuncios
    `ALTER TABLE players ADD COLUMN guild_id TEXT`,                                           // GUILD-DEF-001: FK a guilds.id (NULL = sin gremio)
    ];
  for (const sql of migrations) {
    applyMigration(sql);
  }

  // DIS-1954: Ajustar reward de quest 'trade_comprar_equipo' (Inversión Táctica)
  // Reward anterior: {gold: 20, xp: 15} — causaba level-up al comprar (nivel 2→3 requiere +90 XP).
  // Reward nuevo:   {gold: 25, xp: 5}  — inversión táctica = más gold, menos XP (el combate da el nivel).
  applyMigration(`UPDATE quest_definitions SET reward = '{"gold":25,"xp":5}' WHERE id = 'trade_comprar_equipo'`);

  // GUILD-DEF-001: Índices para el sistema de gremios
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_guilds_name ON guilds(name)`); } catch (_) {}
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_players_guild_id ON players(guild_id)`); } catch (_) {}
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_guilds_rank ON guilds(rank)`); } catch (_) {}

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
        username LIKE 'verif_test%' OR username LIKE 'veriftest%' OR
        -- DIS-1844: patrones históricos no cubiertos antes (detectados en leaderboard)
        username LIKE 'test%' OR
        username LIKE 'tpared%' OR
        username LIKE 'NuevoJugador%' OR username LIKE 'nuevojugador%' OR
        username LIKE 'NuevoJug%' OR username LIKE 'nuevojug%' OR
        username LIKE 'AgentTest%' OR username LIKE 'agenttest%' OR
        username LIKE 'admin' OR username LIKE 'Admin' OR username LIKE 'ADMIN' OR
        -- BUG-2081: patrones bot*_test (e.g. botclerico_test, botguardia_test)
        username LIKE 'bot%\_test' ESCAPE '\\'
      )
    `);
  } catch (e) {
    console.error('[db] Error en migración is_bot:', e.message);
  }

  // Tabla de facciones (EPIC-1373)
  db.run(`
    CREATE TABLE IF NOT EXISTS factions (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      icon             TEXT NOT NULL,
      description      TEXT,
      playstyle        TEXT,
      week_influence   INTEGER NOT NULL DEFAULT 0,
      total_influence  INTEGER NOT NULL DEFAULT 0,
      control_streak   INTEGER NOT NULL DEFAULT 0,
      last_reset_week  TEXT
    )
  `);
  // Seed: insertar las 3 facciones fijas si no existen
  try {
    db.run(`INSERT OR IGNORE INTO factions (id, name, icon, description, playstyle) VALUES
      ('orden_filo',        'La Orden del Filo',        '🗡️',  'Guerreros y mercenarios que controlan el dungeon por la fuerza. Matan más, ganan más.',         'combate'),
      ('conclave_arcano',   'El Cónclave Arcano',       '🔮',  'Magos e investigadores que estudian el dungeon. El conocimiento es su arma.',                   'exploracion'),
      ('hermandad_mercado', 'La Hermandad del Mercado', '🪙',  'Comerciantes y pícaros que controlan el flujo económico. El oro es su poder.',                  'economia')`);
  } catch (_) { /* ya existen */ }

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

  // T157: Columna playtime_minutes en players (ya incluida en el array migrations arriba con applyMigration)
  // applyMigration(`ALTER TABLE players ADD COLUMN playtime_minutes INTEGER NOT NULL DEFAULT 0`);

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

  // T-1974: Migration retroactiva de la quest principal de Kaelthas.
  // Para jugadores reales que ya leyeron la Sala del Trono (kaelthas_nota_trono_9_read === true en status_effects)
  // y cuya quest todavía está 'inactive', activar la quest con el fragmento 'trono' ya registrado.
  // Idempotente: solo actúa si main_quest_state === 'inactive' (default).
  try {
    const allPlayersForKQ = db.exec(`SELECT id, status_effects, main_quest_data FROM players WHERE is_bot = 0`);
    if (allPlayersForKQ.length > 0) {
      const { columns, values } = allPlayersForKQ[0];
      let migratedCount = 0;
      for (const row of values) {
        const pid = row[columns.indexOf('id')];
        let se = {};
        try { se = JSON.parse(row[columns.indexOf('status_effects')] || '{}'); } catch (_) {}
        if (!se.kaelthas_nota_trono_9_read) continue; // No leyó el trono

        let mqd = {};
        try { mqd = JSON.parse(row[columns.indexOf('main_quest_data')] || '{}'); } catch (_) {}
        const state = mqd.main_quest_state || 'inactive';
        if (state !== 'inactive') continue; // Ya tiene quest activa/completada, no tocar

        // Activar quest con fragmento 'trono'
        const updatedMqd = {
          fragments_found: ['trono'],
          main_quest_state: 'active',
          kaelthas_fragments_count: 1,
          lich_died_with_quest: false,
          started_at: new Date().toISOString(),
        };
        db.run(
          `UPDATE players SET main_quest_data = ? WHERE id = ?`,
          [JSON.stringify(updatedMqd), pid]
        );
        migratedCount++;
      }
      if (migratedCount > 0) {
        console.log(`[db] T-1974: Migration retroactiva Kaelthas — ${migratedCount} jugador(es) con quest activada (fragmento 'trono' retroactivo).`);
      }
    }
  } catch (kqMigErr) {
    console.error('[db] T-1974 Kaelthas retroactive migration error:', kqMigErr.message);
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

  // EPIC Facciones Vivas: tabla de definiciones de misiones de facción (pool estático)
  db.run(`
    CREATE TABLE IF NOT EXISTS faction_mission_definitions (
      id                   TEXT PRIMARY KEY,
      faction              TEXT NOT NULL,
      name                 TEXT NOT NULL,
      description_template TEXT NOT NULL,
      event_hook           TEXT NOT NULL,
      target_filter        TEXT,
      base_target          INTEGER NOT NULL,
      scale_per_level      REAL NOT NULL DEFAULT 0.0,
      reward_xp            INTEGER NOT NULL DEFAULT 0,
      reward_gold          INTEGER NOT NULL DEFAULT 0,
      reward_influence     INTEGER NOT NULL DEFAULT 5,
      require_level        INTEGER NOT NULL DEFAULT 1,
      priority             INTEGER NOT NULL DEFAULT 10,
      is_active            INTEGER NOT NULL DEFAULT 1
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_fmdef_faction_active ON faction_mission_definitions(faction, is_active, require_level)`);

  // EPIC Facciones Vivas: tabla de misiones activas por jugador/semana
  db.run(`
    CREATE TABLE IF NOT EXISTS faction_missions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id         TEXT NOT NULL,
      faction           TEXT NOT NULL,
      definition_id     TEXT NOT NULL,
      week              INTEGER NOT NULL,
      week_start_iso    TEXT NOT NULL,
      target            INTEGER NOT NULL,
      progress          INTEGER NOT NULL DEFAULT 0,
      status            TEXT NOT NULL DEFAULT 'active',
      reward_claimed    INTEGER NOT NULL DEFAULT 0,
      completed_at      TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_faction_missions_player_week ON faction_missions(player_id, week)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_faction_missions_faction_week_status ON faction_missions(faction, week, status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_faction_missions_status ON faction_missions(status, week)`);

  // IMPL-WM-1710: Misiones de Guerra Semanal — tabla colectiva por facción
  db.run(`
    CREATE TABLE IF NOT EXISTS faction_war_missions (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      faction               TEXT NOT NULL,
      week                  TEXT NOT NULL,
      objective_type        TEXT NOT NULL,
      target_name           TEXT,
      target_global         INTEGER NOT NULL DEFAULT 0,
      progress_global       INTEGER NOT NULL DEFAULT 0,
      completed             INTEGER NOT NULL DEFAULT 0,
      completed_at          TEXT,
      reward_xp_per_member  INTEGER NOT NULL DEFAULT 100,
      created_at            TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_fwm_faction_week ON faction_war_missions(faction, week)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_fwm_week ON faction_war_missions(week)`);

  // EPIC-1817: Epic Memoria del Dungeon — tablas de persistencia histórica
  db.run(`
    CREATE TABLE IF NOT EXISTS room_stats (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id       INTEGER NOT NULL,
      monster_name  TEXT NOT NULL DEFAULT '_player_death',
      event_type    TEXT NOT NULL,
      count_total   INTEGER NOT NULL DEFAULT 0,
      count_week    INTEGER NOT NULL DEFAULT 0,
      week_start    TEXT NOT NULL,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(room_id, monster_name, event_type, week_start)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_room_stats_room_id ON room_stats(room_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_room_stats_week ON room_stats(week_start, event_type)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS player_history_meta (
      username            TEXT PRIMARY KEY,
      total_runs          INTEGER NOT NULL DEFAULT 0,
      total_kills         INTEGER NOT NULL DEFAULT 0,
      total_deaths        INTEGER NOT NULL DEFAULT 0,
      total_ascensions    INTEGER NOT NULL DEFAULT 0,
      max_level_reached   INTEGER NOT NULL DEFAULT 1,
      max_kill_streak     INTEGER NOT NULL DEFAULT 0,
      first_lich_kill_at  TEXT,
      last_active_at      TEXT NOT NULL DEFAULT (datetime('now')),
      kills_this_week     INTEGER NOT NULL DEFAULT 0,
      week_start          TEXT NOT NULL DEFAULT (strftime('%Y-%W','now'))
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_phm_kills_total ON player_history_meta(total_kills DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_phm_ascensions ON player_history_meta(total_ascensions DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_phm_last_active ON player_history_meta(last_active_at DESC)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS dungeon_chronicle (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      week_start    TEXT NOT NULL UNIQUE,
      chronicle_text TEXT NOT NULL,
      generated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      stats_snapshot TEXT NOT NULL DEFAULT '{}'
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_chronicle_week ON dungeon_chronicle(week_start DESC)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS crypt_plaques (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      slot        TEXT NOT NULL UNIQUE,
      username    TEXT NOT NULL,
      plaque_text TEXT NOT NULL,
      category    TEXT NOT NULL,
      generated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // EPIC Facciones Vivas: seed del pool de misiones (9 misiones, 3 por facción) — IMPL-FM-1705
  try {
    const fmSeed = [
      // ─── La Orden del Filo ──────────────────────────────────────────────────
      {
        id: 'fm_orden_caza_general',
        faction: 'orden_filo',
        name: 'Purgar la Sala de los Ecos',
        description_template: 'La Orden necesita el dungeon limpio de amenazas. Matá {target} criaturas esta semana para demostrar tu valía.',
        event_hook: 'kill',
        target_filter: null,
        base_target: 10,
        scale_per_level: 2.0,
        reward_xp: 150,
        reward_gold: 80,
        reward_influence: 8,
        require_level: 1,
        priority: 10,
        is_active: 1,
      },
      {
        id: 'fm_orden_caza_agresiva',
        faction: 'orden_filo',
        name: 'El Contrato Sangriento',
        description_template: 'Los mejores guerreros de la Orden no se esconden detrás de escudos. Matá {target} criaturas en postura agresiva (desde que te uniste a la Orden).',
        event_hook: 'kill',
        target_filter: JSON.stringify({ stance: 'agresivo' }),
        base_target: 5,
        scale_per_level: 1.0,
        reward_xp: 200,
        reward_gold: 100,
        reward_influence: 10,
        require_level: 2,
        priority: 8,
        is_active: 1,
      },
      {
        id: 'fm_orden_caza_boss',
        faction: 'orden_filo',
        name: 'El Cazador de Jefes',
        description_template: 'La Orden paga bien por cabezas difíciles. Matá {target} enemigo de élite esta semana.',
        event_hook: 'kill',
        target_filter: JSON.stringify({ min_max_hp: 50 }),
        base_target: 1,
        scale_per_level: 0.0,
        reward_xp: 250,
        reward_gold: 120,
        reward_influence: 15,
        require_level: 3,
        priority: 6,
        is_active: 1,
      },
      // ─── El Cónclave Arcano ─────────────────────────────────────────────────
      {
        id: 'fm_conclave_explorar_salas',
        faction: 'conclave_arcano',
        name: 'Cartografía de las Sombras',
        description_template: 'El Cónclave necesita registros de primera mano. Explorá {target} salas nuevas que no hayas visitado antes.',
        event_hook: 'explore_new',
        target_filter: null,
        base_target: 3,
        scale_per_level: 1.0,
        reward_xp: 180,
        reward_gold: 60,
        reward_influence: 8,
        require_level: 1,
        priority: 10,
        is_active: 1,
      },
      {
        id: 'fm_conclave_examine_salas',
        faction: 'conclave_arcano',
        name: 'El Ojo del Cónclave',
        description_template: 'Cada detalle del dungeon tiene valor. Examiná {target} cosas distintas del dungeon esta semana.',
        event_hook: 'examine',
        target_filter: null,
        base_target: 5,
        scale_per_level: 0.5,
        reward_xp: 160,
        reward_gold: 50,
        reward_influence: 6,
        require_level: 1,
        priority: 8,
        is_active: 1,
      },
      {
        id: 'fm_conclave_sala_secreta',
        faction: 'conclave_arcano',
        name: 'El Registro Prohibido',
        description_template: 'El Cónclave sospecha de algo en el Santuario. Visitá esa sala y volvé con tus observaciones.',
        event_hook: 'explore_room',
        target_filter: JSON.stringify({ room_id: 10 }),
        base_target: 1,
        scale_per_level: 0.0,
        reward_xp: 220,
        reward_gold: 90,
        reward_influence: 12,
        require_level: 2,
        priority: 6,
        is_active: 1,
      },
      // ─── La Hermandad del Mercado ────────────────────────────────────────────
      {
        id: 'fm_hermandad_compras',
        faction: 'hermandad_mercado',
        name: 'Provisiones del Gremio',
        description_template: 'La Hermandad necesita que sus miembros mantengan el comercio activo. Comprá {target} ítems en la tienda de Aldric esta semana.',
        event_hook: 'buy',
        target_filter: null,
        base_target: 3,
        scale_per_level: 1.0,
        reward_xp: 140,
        reward_gold: 50,
        reward_influence: 6,
        require_level: 1,
        priority: 10,
        is_active: 1,
      },
      {
        id: 'fm_hermandad_bids',
        faction: 'hermandad_mercado',
        name: 'El Arte de la Puja',
        description_template: 'El mercado no perdona la timidez. Realizá {target} pujas serias esta semana (cada puja debe ser al menos el 50% del precio mínimo de la subasta).',
        event_hook: 'bid',
        target_filter: JSON.stringify({ min_bid_pct: 0.5 }),
        base_target: 2,
        scale_per_level: 0.0,
        reward_xp: 160,
        reward_gold: 60,
        reward_influence: 8,
        require_level: 1,
        priority: 8,
        is_active: 1,
      },
      {
        id: 'fm_hermandad_ganar_subasta',
        faction: 'hermandad_mercado',
        name: 'El Negociador',
        description_template: 'No basta con pujar — hay que ganar. Cerrá {target} subasta esta semana.',
        event_hook: 'auction_win',
        target_filter: null,
        base_target: 1,
        scale_per_level: 0.0,
        reward_xp: 250,
        reward_gold: 100,
        reward_influence: 15,
        require_level: 1,
        priority: 6,
        is_active: 1,
      },
    ];

    for (const m of fmSeed) {
      db.run(
        `INSERT OR IGNORE INTO faction_mission_definitions
           (id, faction, name, description_template, event_hook, target_filter,
            base_target, scale_per_level, reward_xp, reward_gold, reward_influence,
            require_level, priority, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [m.id, m.faction, m.name, m.description_template, m.event_hook,
         m.target_filter || null, m.base_target, m.scale_per_level,
         m.reward_xp, m.reward_gold, m.reward_influence,
         m.require_level, m.priority, m.is_active]
      );
      // DIS-2143: Actualizar definiciones existentes que hayan cambiado (description, target_filter)
      db.run(
        `UPDATE faction_mission_definitions
         SET description_template = ?, target_filter = ?, name = ?
         WHERE id = ?`,
        [m.description_template, m.target_filter || null, m.name, m.id]
      );
    }
    console.log('[db] EPIC-FM: 9 misiones de facción en pool (INSERT OR IGNORE — idempotente)');
  } catch (e) {
    console.error('[db] EPIC-FM: Error al seed pool misiones:', e.message);
  }

  // IMPL-WM-1710: Seed de definiciones de Misiones de Guerra Semanal (pool estático de objetivos)
  // Las filas activas se crean semana a semana en ensureWarMissionsForWeek(), NO aquí.
  // Este bloque solo registra los tipos disponibles en world_state para que el motor los lea.
  // (No hay tabla de definiciones separada — los 3 tipos están hardcodeados en ensureWarMissionsForWeek)
  console.log('[db] IMPL-WM-1710: faction_war_missions tabla lista (seed dinámico vía ensureWarMissionsForWeek)');

  // EPIC-CAMP: Sistema de Campaña Narrativa — tablas
  // campaigns: pool de campañas diseñadas (estáticas, escritas por el diseñador)
  db.run(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id                TEXT PRIMARY KEY,        -- 'arquinecromante_veth', 'plaga_esporas', etc.
      name              TEXT NOT NULL,           -- "La Invasión de Veth"
      lore_intro        TEXT NOT NULL,           -- texto que dice el Anciano al inicio de campaña
      lore_midpoint     TEXT NOT NULL,           -- texto en la segunda semana
      lore_victory      TEXT NOT NULL,           -- texto si se gana (Anciano post-victoria)
      lore_defeat       TEXT NOT NULL,           -- texto si se pierde (Anciano post-derrota)
      goal_type         TEXT NOT NULL,           -- 'deposit_items' | 'kill_count' | 'explore_rooms'
      goal_target       INTEGER NOT NULL,        -- umbral absoluto (ej: 120 rituales)
      goal_key          TEXT NOT NULL,           -- clave en world_state para el contador colectivo
      duration_days     INTEGER NOT NULL DEFAULT 14,
      reward_victory    TEXT NOT NULL DEFAULT '{}', -- JSON: { xp_global_bonus_pct, duration_hours }
      consequence_defeat TEXT NOT NULL DEFAULT '{}', -- JSON: { enemy_hp_bonus_pct, duration_days }
      active_effects    TEXT NOT NULL DEFAULT '{}'   -- JSON: drops, sala_modificada, npc_items
    )
  `);

  // active_campaign: tabla de una sola fila — la campaña en curso (NULL si no hay ninguna)
  db.run(`
    CREATE TABLE IF NOT EXISTS active_campaign (
      id              INTEGER PRIMARY KEY DEFAULT 1,
      campaign_id     TEXT NOT NULL,
      started_at      TEXT NOT NULL DEFAULT (datetime('now')),
      ends_at         TEXT NOT NULL,
      state           TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'victory' | 'defeat' | 'concluded'
      conclusion_seen INTEGER NOT NULL DEFAULT 0         -- 1 si ya se mostró el texto de resolución global
    )
  `);

  // campaign_contributions: contribuciones individuales (para títulos y recompensas al final)
  db.run(`
    CREATE TABLE IF NOT EXISTS campaign_contributions (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id      TEXT NOT NULL,
      player_username  TEXT NOT NULL,
      contribution     INTEGER NOT NULL DEFAULT 1,   -- cuánto aportó en esta acción puntual
      contributed_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_camp_contrib_player ON campaign_contributions(player_username, campaign_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_camp_contrib_campaign ON campaign_contributions(campaign_id, contributed_at)`);
  console.log('[db] EPIC-CAMP: tablas campaigns, active_campaign, campaign_contributions listas');

  // EPIC-2045: Boss Stats — kill counter global por boss (alimenta diálogos y Crónica del Dungeon)
  db.run(`
    CREATE TABLE IF NOT EXISTS boss_stats (
      boss_id          TEXT PRIMARY KEY,     -- ej: 'lich_anciano', 'guardia_espectral'
      total_kills      INTEGER NOT NULL DEFAULT 0,
      kills_this_week  INTEGER NOT NULL DEFAULT 0,
      last_killed_by   TEXT,                 -- username del último en matarlo
      last_killed_at   TEXT,                 -- ISO timestamp
      first_killed_by  TEXT,                 -- username del primero en matarlo
      first_killed_at  TEXT,
      week_start       TEXT                  -- inicio de la semana actual para resets
    )
  `);
  console.log('[db] EPIC-2045: tabla boss_stats lista');

  // EPIC-CAMP: Seed de la campaña "La Invasión de Veth" (INSERT OR IGNORE — idempotente)
  try {
    db.run(`
      INSERT OR IGNORE INTO campaigns
        (id, name, lore_intro, lore_midpoint, lore_victory, lore_defeat,
         goal_type, goal_target, goal_key, duration_days,
         reward_victory, consequence_defeat, active_effects)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      'arquinecromante_veth',
      'La Invasión de Veth',
      'Forastero. Escuchá con atención — hay algo en el dungeon que no estaba hace tres días. El Arquinecromante Veth llegó desde las profundidades. No vino a conquistar — vino a terminar algo. Sus rituales consumen la energía de los cristales de las salas inferiores. Si llega a la Catedral, el Lich resurgirá de forma permanente. No como un ciclo más. Permanente.\n\nLos no-muertos que ya conocés — los esqueletos, los zombis, el espectro — ahora cargan algo. Fragmentos de los rituales de Veth. Si los derrotás y llevás esos fragmentos a la Capilla Olvidada, podés neutralizarlos en el altar.\n\nNo te pido que mates a Veth. Todavía. Te pido que detengas sus rituales mientras podamos.',
      'Los rituales siguen llegando. Veth no se detiene — trabaja en turnos. Lo que neutralizaron hasta ahora cuenta, pero no alcanza todavía.\n\nEscucho las pisadas de más aventureros en el corredor. Algunos vinieron esta semana por primera vez; otros ya trajeron fragmentos antes. El altar de la Capilla los reconoce — la energía acumulada es palpable.\n\nQuedan días. Cada fragmento neutralizado es tiempo ganado. No paren ahora.',
      'Quedó registrado. Los aventureros de esta semana contuvieron los rituales de Veth antes de que llegaran a la Catedral. El Lich sigue en su ciclo — no resurgió de forma permanente.\n\nVeth escapó. Eso no es una victoria limpia. Pero lo que hicieron importa: el dungeon tiene memoria. El altar de la Capilla guarda el rastro de cada fragmento que neutralizaron. En algún momento, Veth va a volver. Cuando pase, van a saber que ya lo detuvieron antes.\n\nGracias.',
      'No alcanzó. Los rituales llegaron a la Catedral antes de que los detuviéramos. El Lich absorbió suficiente energía para fortalecer a los no-muertos del dungeon — no de forma permanente, pero sí lo suficiente como para que la próxima semana sea más pesada.\n\nNo es culpa de nadie en particular. A veces el dungeon gana. Pero esto quedó registrado también — la derrota tiene peso propio. Cuando Veth vuelva, y va a volver, saber que ya perdimos una vez debería ser razón suficiente para no perder dos.',
      'deposit_items',
      120,
      'campana_veth_rituales_neutralizados',
      14,
      JSON.stringify({ type: 'global_xp_bonus', xp_bonus_pct: 25, duration_hours: 24, message: '🏆 ¡La Invasión de Veth fue contenida! Los aventureros neutralizaron los rituales. +25% XP durante las próximas 24 horas.' }),
      JSON.stringify({ type: 'undead_hp_bonus', hp_bonus_pct: 10, duration_days: 3, message: '💀 Los rituales de Veth llegaron a la Catedral. Los no-muertos están fortalecidos. +10% HP a todos los no-muertos durante 3 días.' }),
      JSON.stringify({
        drop_items: [
          { monster_type: 'esqueleto', item: 'Fragmento de Ritual de Veth', rate: 0.40 },
          { monster_type: 'zombie',    item: 'Fragmento de Ritual de Veth', rate: 0.50 },
          { monster_type: 'espectro',  item: 'Fragmento de Ritual de Veth', rate: 0.60 },
          { monster_type: 'lich',      item: 'Fragmento de Ritual de Veth', rate: 1.00, count: 3 },
        ],
        room_effects: [
          { room_id: 10, extra_description: '⚠️ Un círculo de runas oscuras pulsa en el suelo — trazado recientemente. Huele a la misma energía que los Fragmentos de Ritual que cargan los no-muertos. Veth estuvo aquí.' },
        ],
        deposit_room_id: 5,
        deposit_item: 'Fragmento de Ritual de Veth',
        deposit_message: '✨ Depositaste el Fragmento de Ritual en el altar de la Capilla. La energía oscura se disipa lentamente. Contribuiste a la campaña contra Veth.',
      }),
    ]);
    console.log('[db] EPIC-CAMP: Campaña "La Invasión de Veth" sembrada (INSERT OR IGNORE)');
  } catch (e) {
    console.error('[db] EPIC-CAMP seed Veth:', e.message);
  }

  // EPIC-2124: Pool de campañas adicionales — La Plaga de las Esporas
  try {
    db.run(`
      INSERT OR IGNORE INTO campaigns
        (id, name, lore_intro, lore_midpoint, lore_victory, lore_defeat,
         goal_type, goal_target, goal_key, duration_days,
         reward_victory, consequence_defeat, active_effects)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      'plaga_esporas',
      'La Plaga de las Esporas',
      'Las Arañas Tejedoras del Pozo Sin Fondo están cambiando. Forastero — no es agresividad normal. Sus esporas se esparcen hacia los pasillos superiores. En tres días el Corredor de las Sombras va a ser intransitable sin antídoto.\n\nHay una sola persona que puede hacer algo al respecto: Aldric. Puede sintetizar un neutralizante si le traés suficientes glándulas venenosas de las mismas arañas. No es irónico — es química.\n\nCada Araña Tejedora del Pozo tiene las glándulas que Aldric necesita. Matá las arañas, recogé la glándula si la soltaron, y llevala directamente a la tienda (sala 4). Él hace el resto.',
      'Las arañas siguen reproductores. El Pozo huele diferente — un ácido orgánico que irrita los ojos. Aldric está procesando las glándulas que le trajeron, pero necesita más.\n\nCada glándula que entreguen le da diez minutos más de trabajo. No para — lleva dos días despierto. Cuando esto termine, el dungeon va a deberle algo.',
      'Suficientes glándulas. Aldric terminó el trabajo — el neutralizante está distribuido por los pasillos. Las esporas que quedaban en el aire se descomponen en contacto con el agente. El Pozo Sin Fondo está limpio.\n\nLas Arañas Tejedoras están quietas. No van a estarlo para siempre, pero esta semana sí. Buen trabajo.',
      'No llegamos. El neutralizante no estuvo listo a tiempo — las esporas se asentaron en las paredes del Corredor. Aldric tuvo que cerrar el frasco a la mitad. Las arañas están más activas que nunca, y sus glándulas venenosas ahora son un poco más potentes.\n\nEl Pozo va a ser un lugar más difícil la próxima semana. Preparate.',
      'deposit_items',
      80,
      'campana_esporas_glandulas_entregadas',
      14,
      JSON.stringify({ type: 'room_special_text', duration_hours: 48, room_id: 7, message: '🕷️ El Pozo Sin Fondo está silencioso. Las arañas sobrevivientes se replegaron hacia las fisuras. El suelo está limpio — ya no hay esporas flotantes. Los aventureros de esta semana lo lograron.' }),
      JSON.stringify({ type: 'monster_hp_bonus', monster_type: 'araña', hp_bonus_pct: 15, duration_days: 3, message: '🕷️ La Plaga de las Esporas no fue contenida. Las Arañas Tejedoras del Pozo están más resistentes. +15% HP durante 3 días.' }),
      JSON.stringify({
        drop_items: [
          { monster_type: 'araña', item: 'glándula venenosa', rate: 0.50 },
        ],
        deposit_room_id: 4,
        deposit_item: 'glándula venenosa',
        deposit_message: '🧪 Entregás la Glándula Venenosa a Aldric. Él la examina con cuidado y la añade a su proceso. \"Esto ayuda\", dice sin levantar la vista. Contribuiste a la campaña contra la Plaga de las Esporas.',
        campaign_drop_message: '🕷️ ¡La araña cargaba una Glándula Venenosa intacta! Aldric puede usarla para el neutralizante. Llevala a su tienda (sala 4) y usá `usar glándula venenosa`.',
      }),
    ]);
    console.log('[db] EPIC-2124: Campaña "La Plaga de las Esporas" sembrada (INSERT OR IGNORE)');
  } catch (e) {
    console.error('[db] EPIC-2124 seed plaga_esporas:', e.message);
  }

  // EPIC-2124: Pool de campañas adicionales — El Sello Roto
  try {
    db.run(`
      INSERT OR IGNORE INTO campaigns
        (id, name, lore_intro, lore_midpoint, lore_victory, lore_defeat,
         goal_type, goal_target, goal_key, duration_days,
         reward_victory, consequence_defeat, active_effects)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      'sello_roto',
      'El Sello Roto',
      'Algo salió mal hace siglos en las profundidades. Un sello que mantenía separadas dos energías incompatibles — lo que hay en la Catedral y lo que hay más abajo — se fragmentó. Los pedazos se esparcieron por los guardianes de las zonas profundas. Los cargan sin saberlo.\n\nNecesitamos cinco fragmentos para reconstruir el sello y ponerlo en la Sala del Trono, donde las dos energías se cruzan. Los bosses de las zonas más profundas del dungeon los tienen. No todos, no siempre — pero cuando caen, hay que mirar bien.\n\nSi juntamos los cinco fragmentos y los depositamos en el trono antes de que termine la semana, el sello queda restaurado. Si no — las dos energías van a seguir filtrándose una en la otra.',
      'Algunos fragmentos llegaron. El altar del Trono los acepta — se anclan solos cuando los ponés cerca. Pero quedan espacios vacíos en la estructura del sello. Los guardianes más profundos todavía portan los que faltan.\n\nLas profundidades se sienten diferentes esta semana — algo está cambiando. Apurate.',
      'El sello está completo. Los cinco fragmentos se fusionaron en el altar del Trono con un sonido que se sintió en todo el dungeon. La filtración se detuvo — las dos energías volvieron a sus zonas.\n\nLas zonas profundas van a estar un poco más tranquilas por un tiempo. El Lich no sabe lo que perdió.',
      'El sello no se completó. Los fragmentos que llegaron fueron insuficientes — la estructura parcial se desestabilizó y los fragmentos depositados se perdieron con ella. La filtración entre las dos energías continúa.\n\nEl Lich está absorbiendo esa energía. Va a estar más resistente la próxima semana. Preparate para una pelea más difícil.',
      'deposit_items',
      5,
      'campana_sello_fragmentos_depositados',
      14,
      JSON.stringify({ type: 'xp_bonus', xp_bonus_pct: 20, zone: 'deep', duration_hours: 48, message: '🔮 El Sello fue restaurado. Las zonas profundas del dungeon irradian energía estabilizada. +20% XP en salas profundas durante 48 horas.' }),
      JSON.stringify({ type: 'boss_hp_bonus', boss_id: 'lich', hp_bonus_pct: 10, duration_days: 7, message: '💀 El Sello Roto no fue restaurado. La energía filtrada fortaleció al Lich. +10% HP al Lich Anciano durante 1 semana.' }),
      JSON.stringify({
        drop_items: [
          { monster_type: 'gólem de forja', item: 'fragmento de sello', rate: 0.80 },
          { monster_type: 'campeón espectral', item: 'fragmento de sello', rate: 0.70 },
          { monster_type: 'lich', item: 'fragmento de sello', rate: 1.00 },
          { monster_type: 'sombra del vacío', item: 'fragmento de sello', rate: 0.90 },
          { monster_type: 'eco viviente', item: 'fragmento de sello', rate: 0.80 },
        ],
        deposit_room_id: 9,
        deposit_item: 'fragmento de sello',
        deposit_message: '🔮 Colocás el Fragmento de Sello en el altar del Trono. Se adhiere solo a la estructura parcial — una luz fría lo recorre por un momento. Contribuiste a restaurar el Sello Roto.',
        campaign_drop_message: '🔮 ¡El guardián portaba un Fragmento de Sello! Necesita ser depositado en la Sala del Trono (sala 9). Usá `usar fragmento de sello` allí para contribuir a la campaña.',
      }),
    ]);
    console.log('[db] EPIC-2124: Campaña "El Sello Roto" sembrada (INSERT OR IGNORE)');
  } catch (e) {
    console.error('[db] EPIC-2124 seed sello_roto:', e.message);
  }

  // EPIC-2124: Pool de campañas adicionales — La Vigilia del Corredor
  try {
    db.run(`
      INSERT OR IGNORE INTO campaigns
        (id, name, lore_intro, lore_midpoint, lore_victory, lore_defeat,
         goal_type, goal_target, goal_key, duration_days,
         reward_victory, consequence_defeat, active_effects)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      'vigilia_corredor',
      'La Vigilia del Corredor',
      'Los Gnolls Merodeadores están reagrupándose. En condiciones normales hay uno, dos a lo sumo en el Corredor de las Sombras. Esta semana llegaron refuerzos desde fuera del dungeon — hay marcas frescas de manada.\n\nSi no se controla, el Corredor va a quedar inaccesible. Los Gnolls no atacan solos — esperan en grupos. Para cuando un aventurero nuevo llegue a la sala 2, ya es tarde.\n\nLa respuesta es simple: 300 kills colectivos en el Corredor antes de que terminen los 14 días. No hay ítem que recoger, no hay altar que alimentar. Solo un recuento. Cada Gnoll que cae en la sala 2 suma. Los aventureros llevan el conteo solos — el dungeon lleva el registro.',
      'Van a mitad. Los Gnolls siguen llegando pero las marcas frescas ya no se ven en los muros del Corredor. Los que cazaron esta semana dejaron espacio. Sigan — falta la otra mitad.',
      'El Corredor está limpio. Trescientos Gnolls eliminados — el dungeon registró cada uno. Los refuerzos que llegaron esta semana ya no tienen manada a la que sumarse. El Corredor de las Sombras vuelve a ser un pasillo transitable.\n\nLas marcas de gnoll en las paredes están secas — ya no son frescas. Por unas horas, el loot de la zona es más rico. Los Gnolls que quedan están asustados y cargan todo lo que tienen.',
      'No llegamos a 300. Los Gnolls establecieron una presencia permanente en el Corredor. Sus marcas están en las paredes — territorio reclamado. Son más agresivos ahora, y atacan con más fuerza. El Corredor va a ser más difícil la próxima semana.',
      'kill_count',
      300,
      'campana_vigilia_gnolls_eliminados',
      14,
      JSON.stringify({ type: 'room_loot_bonus', room_id: 2, duration_hours: 24, message: '⚔️ ¡La Vigilia del Corredor fue exitosa! 300 Gnolls eliminados. El Corredor de las Sombras está limpio — loot mejorado en sala 2 durante 24 horas.' }),
      JSON.stringify({ type: 'monster_atk_bonus', monster_type: 'gnoll', atk_bonus_pct: 10, duration_days: 3, message: '⚔️ La Vigilia del Corredor falló. Los Gnolls se establecieron en el Corredor. +10% ATK a Gnolls durante 3 días.' }),
      JSON.stringify({
        kill_monster_type: 'gnoll',
        kill_room_id: 2,
        kill_message: '⚔️ Kill de Gnoll registrado para la Vigilia del Corredor.',
      }),
    ]);
    console.log('[db] EPIC-2124: Campaña "La Vigilia del Corredor" sembrada (INSERT OR IGNORE)');
  } catch (e) {
    console.error('[db] EPIC-2124 seed vigilia_corredor:', e.message);
  }

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
    u.includes('verif') && u.includes('test') ||
    // DIS-1844: nuevos patrones de nombres de prueba detectados en leaderboard
    u.startsWith('test') ||           // testdis*, testpared*, testuser, testbug*, etc.
    u.startsWith('tpared') ||         // tpared001, tpared002, tpared99
    u.startsWith('nuevojugador') ||   // NuevoJugador2026, NuevoJugador_Test, etc.
    u.startsWith('nuevojug') ||       // NuevoJug2026
    u.startsWith('agenttest') ||      // AgentTest
    u.startsWith('admin') ||           // admin (cuenta de prueba administrativa)
    // BUG-2081: patrones bot*_test (e.g. botclerico_test, botguardia_test)
    (u.startsWith('bot') && u.endsWith('_test'))
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
  // EPIC-VV-1755: asignar semilla de run al crear personaje (Variación Viva)
  const runSeed = generateNewSeed();
  const runState = generateRunState(runSeed);
  run(
    `UPDATE players SET run_seed = ?, run_event = ?, run_monster_variants = ?, run_loot_positions = ? WHERE id = ?`,
    [
      runSeed,
      runState.event.id,
      JSON.stringify(runState.monster_variants),
      JSON.stringify(runState.rare_loot_positions),
      id,
    ]
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
  // BUG-1642: usar formato SQLite (YYYY-MM-DD HH:MM:SS) en lugar de ISO 8601 (con T y Z)
  // porque datetime('now') en SQLite usa espacio, no T, y la comparación de strings falla.
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString().replace('T', ' ').split('.')[0];
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

// ─── Party (EPIC-PARTY-1626) ─────────────────────────────────────────────────

/**
 * Crea una party en la tabla parties y asigna party_id al líder.
 * @param {string} leaderId
 * @param {string} partyId  — formato 'party-{leaderId}-{timestamp}'
 * @returns {object} la party creada
 */
function createParty(leaderId, partyId) {
  db.run(
    `INSERT OR IGNORE INTO parties (id, leader_id) VALUES (?, ?)`,
    [partyId, leaderId]
  );
  return getParty(partyId);
}

/**
 * Obtiene una party por ID.
 * @param {string} partyId
 * @returns {object|null}
 */
function getParty(partyId) {
  if (!partyId) return null;
  return one('SELECT * FROM parties WHERE id = ?', [partyId]) || null;
}

/**
 * Actualiza el líder de una party.
 * @param {string} partyId
 * @param {string} newLeaderId
 */
function updatePartyLeader(partyId, newLeaderId) {
  db.run(`UPDATE parties SET leader_id = ? WHERE id = ?`, [newLeaderId, partyId]);
}

/**
 * Marca una party como disuelta y quita party_id a todos sus miembros.
 * @param {string} partyId
 */
function dissolveParty(partyId) {
  db.run(
    `UPDATE parties SET status = 'dissolved', dissolved_at = datetime('now') WHERE id = ?`,
    [partyId]
  );
  db.run(`UPDATE players SET party_id = NULL WHERE party_id = ?`, [partyId]);
}

/**
 * Actualiza last_active de la party (llamar en cada acción de un miembro).
 * @param {string} partyId
 */
function touchParty(partyId) {
  if (!partyId) return;
  db.run(`UPDATE parties SET last_active = datetime('now') WHERE id = ?`, [partyId]);
}

/**
 * Retorna parties activas que llevan más de `minutesInactive` minutos inactivas.
 * Usado para auto-disolución (30 min de inactividad).
 * @param {number} minutesInactive
 * @returns {object[]}
 */
function getStaleParties(minutesInactive) {
  return all(
    `SELECT * FROM parties WHERE status = 'active' AND last_active < datetime('now', ? || ' minutes')`,
    [`-${minutesInactive}`]
  );
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

/**
 * DIS-2021: Devuelve monstruos muertos cuyo respawn_room_id tiene jugadores activos
 * y cuyo respawn_at es mayor a `minRespawnAt` (aún no es hora, pero podría acelerarse).
 * Se usa para implementar la mecánica de "acecho": el jugador espera en la sala
 * y el monstruo respawnea antes.
 */
function getMonstersAwaitingRespawnWithPlayers(minRespawnAt) {
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString().replace('T', ' ').split('.')[0];
  // Obtener monstruos muertos con respawn_room_id en salas donde hay jugadores activos
  return all(
    `SELECT m.* FROM monsters m
     WHERE m.room_id IS NULL
       AND m.respawn_at IS NOT NULL
       AND m.respawn_at > ?
       AND m.respawn_room_id IN (
         SELECT current_room_id FROM players
         WHERE is_archived = 0 AND last_seen > ?
       )`,
    [minRespawnAt, cutoff]
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
    status_effects: p.status_effects ? (() => { try { return JSON.parse(p.status_effects); } catch(_) { return {}; } })() : {},
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
     WHERE is_archived = 0 AND (is_bot IS NULL OR is_bot = 0)
     ORDER BY gold DESC, level DESC
     LIMIT ?`,
    [limit]
  );
}

function getLeaderboardByDuels(limit = 10) {
  return all(
    `SELECT username, level, duel_wins, duel_losses, kills
     FROM players
     WHERE is_archived = 0 AND (is_bot IS NULL OR is_bot = 0)
     ORDER BY duel_wins DESC, level DESC
     LIMIT ?`,
    [limit]
  );
}

function getLeaderboardByReputation(limit = 10) {
  return all(
    `SELECT username, level, reputation, kills
     FROM players
     WHERE is_archived = 0 AND (is_bot IS NULL OR is_bot = 0)
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
     WHERE is_archived = 0 AND (is_bot IS NULL OR is_bot = 0)
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

// ─── GUILD-DEF-002: API interna del Epic Gremios ─────────────────────────────

/**
 * Crear un gremio nuevo y asignar al creador como líder.
 * @param {string} leaderId   — ID del jugador fundador
 * @param {string} guildName  — Nombre único del gremio (ya validado: único, no vacío)
 * @returns {{ ok: true, guild } | { ok: false, error: string }}
 */
function createGuildEpic(leaderId, guildName) {
  const { randomUUID } = require('crypto');
  const existing = one('SELECT id FROM guilds WHERE LOWER(name) = LOWER(?)', [guildName]);
  if (existing) return { ok: false, error: `Ya existe un gremio llamado "${guildName}".` };
  const player = one('SELECT id, gold, guild_id FROM players WHERE id = ?', [leaderId]);
  if (!player) return { ok: false, error: 'Jugador no encontrado.' };
  if (player.guild_id) {
    const existingGuild = one('SELECT name FROM guilds WHERE id = ?', [player.guild_id]);
    return { ok: false, error: `Ya pertenecés a un gremio (${existingGuild ? existingGuild.name : 'desconocido'}). Salí primero con «gremio salir».` };
  }
  if ((player.gold || 0) < 50) return { ok: false, error: 'Necesitás 50 monedas de oro para fundar un gremio.' };
  const guildId = randomUUID();
  const now = new Date().toISOString();
  run('INSERT INTO guilds (id, name, leader_id, created_at) VALUES (?, ?, ?, ?)', [guildId, guildName, leaderId, now]);
  run('UPDATE players SET guild_id = ?, gold = gold - 50 WHERE id = ?', [guildId, leaderId]);
  const guild = one('SELECT * FROM guilds WHERE id = ?', [guildId]);
  return { ok: true, guild };
}

/**
 * Unir un jugador a un gremio existente.
 * @param {string} playerId   — ID del jugador que se une
 * @param {string} guildId    — ID del gremio a unirse
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function joinGuild(playerId, guildId) {
  const player = one('SELECT id, guild_id FROM players WHERE id = ?', [playerId]);
  if (!player) return { ok: false, error: 'Jugador no encontrado.' };
  if (player.guild_id) {
    const existingGuild = one('SELECT name FROM guilds WHERE id = ?', [player.guild_id]);
    return { ok: false, error: `Ya pertenecés al gremio "${existingGuild ? existingGuild.name : 'desconocido'}". Salí primero con «gremio salir».` };
  }
  const guild = one('SELECT id, name FROM guilds WHERE id = ?', [guildId]);
  if (!guild) return { ok: false, error: 'Gremio no encontrado.' };
  run('UPDATE players SET guild_id = ? WHERE id = ?', [guildId, playerId]);
  // Actualizar rango si corresponde
  _updateGuildRank(guildId);
  return { ok: true, guildName: guild.name };
}

/**
 * Retirar a un jugador de su gremio actual.
 * Si el jugador era el líder y hay otros miembros, se transfiere el liderazgo al miembro más antiguo.
 * Si era el único miembro, el gremio se disuelve.
 * @param {string} playerId — ID del jugador que sale
 * @returns {{ ok: true, dissolved?: boolean } | { ok: false, error: string }}
 */
function leaveGuild(playerId) {
  const player = one('SELECT id, guild_id FROM players WHERE id = ?', [playerId]);
  if (!player || !player.guild_id) return { ok: false, error: 'No pertenecés a ningún gremio.' };
  const guild = one('SELECT * FROM guilds WHERE id = ?', [player.guild_id]);
  if (!guild) {
    // Estado inconsistente: limpiar
    run('UPDATE players SET guild_id = NULL WHERE id = ?', [playerId]);
    return { ok: true, dissolved: true };
  }
  const members = all('SELECT id FROM players WHERE guild_id = ?', [guild.id]);
  if (members.length <= 1) {
    // Único miembro — disolver
    run('UPDATE players SET guild_id = NULL WHERE id = ?', [playerId]);
    run('DELETE FROM guilds WHERE id = ?', [guild.id]);
    return { ok: true, dissolved: true, guildName: guild.name };
  }
  // Hay otros miembros
  run('UPDATE players SET guild_id = NULL WHERE id = ?', [playerId]);
  // Si era el líder, transferir liderazgo
  if (guild.leader_id === playerId) {
    const newLeader = members.find(m => m.id !== playerId);
    if (newLeader) {
      run('UPDATE guilds SET leader_id = ? WHERE id = ?', [newLeader.id, guild.id]);
    }
  }
  _updateGuildRank(guild.id);
  return { ok: true, dissolved: false, guildName: guild.name };
}

/**
 * Obtener información completa de un gremio.
 * @param {string} guildNameOrId — Nombre o ID del gremio
 * @returns {object | null}
 */
function getGuildInfo(guildNameOrId) {
  let guild = one('SELECT * FROM guilds WHERE id = ?', [guildNameOrId]);
  if (!guild) guild = one('SELECT * FROM guilds WHERE LOWER(name) = LOWER(?)', [guildNameOrId]);
  if (!guild) return null;
  const members = all(
    'SELECT id, username, level, player_class, kills, last_seen FROM players WHERE guild_id = ? ORDER BY level DESC, kills DESC',
    [guild.id]
  );
  const leader = one('SELECT username FROM players WHERE id = ?', [guild.leader_id]);
  return {
    ...guild,
    items_json: (() => { try { return JSON.parse(guild.items_json || '[]'); } catch { return []; } })(),
    hall_bulletin: (() => { try { return JSON.parse(guild.hall_bulletin || '[]'); } catch { return []; } })(),
    members,
    leader_username: leader ? leader.username : '?',
    member_count: members.length,
    rank_name: ['', 'Banda', 'Gremio', 'Forjado', 'Legendario'][guild.rank] || 'Desconocido',
  };
}

/**
 * Depositar un ítem en el banco del gremio.
 * @param {string} playerId  — ID del jugador que deposita
 * @param {string} itemName  — Nombre del ítem a depositar
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function depositItem(playerId, itemName) {
  const player = one('SELECT id, guild_id, inventory FROM players WHERE id = ?', [playerId]);
  if (!player || !player.guild_id) return { ok: false, error: 'No pertenecés a ningún gremio.' };
  let inv;
  try { inv = JSON.parse(player.inventory || '[]'); } catch { inv = []; }
  const idx = inv.findIndex(i => i === itemName || (typeof i === 'object' && i.name === itemName));
  if (idx === -1) return { ok: false, error: `No tenés "${itemName}" en el inventario.` };
  const guild = one('SELECT id, items_json, rank FROM guilds WHERE id = ?', [player.guild_id]);
  if (!guild) return { ok: false, error: 'Gremio no encontrado.' };
  let items;
  try { items = JSON.parse(guild.items_json || '[]'); } catch { items = []; }
  // Límite por rango: 1→20, 2→40, 3+→80
  const maxItems = guild.rank >= 3 ? 80 : guild.rank >= 2 ? 40 : 20;
  if (items.length >= maxItems) return { ok: false, error: `El banco del gremio está lleno (máximo ${maxItems} ítems para Rango ${guild.rank}).` };
  // Remover del inventario y agregar al banco
  inv.splice(idx, 1);
  items.push(itemName);
  run('UPDATE players SET inventory = ? WHERE id = ?', [JSON.stringify(inv), playerId]);
  run('UPDATE guilds SET items_json = ? WHERE id = ?', [JSON.stringify(items), guild.id]);
  return { ok: true };
}

/**
 * Retirar un ítem del banco del gremio.
 * @param {string} playerId  — ID del jugador que retira
 * @param {string} itemName  — Nombre del ítem a retirar
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function withdrawItem(playerId, itemName) {
  const player = one('SELECT id, guild_id, inventory FROM players WHERE id = ?', [playerId]);
  if (!player || !player.guild_id) return { ok: false, error: 'No pertenecés a ningún gremio.' };
  let inv;
  try { inv = JSON.parse(player.inventory || '[]'); } catch { inv = []; }
  const guild = one('SELECT id, items_json, leader_id FROM guilds WHERE id = ?', [player.guild_id]);
  if (!guild) return { ok: false, error: 'Gremio no encontrado.' };
  // Solo el líder puede retirar ítems del banco
  if (guild.leader_id !== playerId) return { ok: false, error: '❌ Solo el líder del gremio puede retirar ítems del banco. Los miembros pueden depositar pero no retirar.' };
  let items;
  try { items = JSON.parse(guild.items_json || '[]'); } catch { items = []; }
  const idx = items.findIndex(i => i === itemName || (typeof i === 'object' && i.name === itemName));
  if (idx === -1) return { ok: false, error: `El banco del gremio no tiene "${itemName}".` };
  // Verificar capacidad de inventario
  const maxInv = 8 + (player.inventory_bonus || 0);
  if (inv.length >= maxInv) return { ok: false, error: 'Tu inventario está lleno.' };
  items.splice(idx, 1);
  inv.push(itemName);
  run('UPDATE guilds SET items_json = ? WHERE id = ?', [JSON.stringify(items), guild.id]);
  run('UPDATE players SET inventory = ? WHERE id = ?', [JSON.stringify(inv), playerId]);
  return { ok: true };
}

/**
 * Transferir el liderazgo del gremio a otro miembro.
 * @param {string} currentLeaderId — ID del jugador que transfiere
 * @param {string} targetUsername  — Username del nuevo líder
 * @returns {{ ok: true, newLeaderName: string } | { ok: false, error: string }}
 */
function transferGuildLeadership(currentLeaderId, targetUsername) {
  const leader = one('SELECT id, guild_id FROM players WHERE id = ?', [currentLeaderId]);
  if (!leader || !leader.guild_id) return { ok: false, error: 'No pertenecés a ningún gremio.' };
  const guild = one('SELECT id, leader_id, name FROM guilds WHERE id = ?', [leader.guild_id]);
  if (!guild) return { ok: false, error: 'Gremio no encontrado.' };
  if (guild.leader_id !== currentLeaderId) return { ok: false, error: '❌ Solo el líder puede transferir el liderazgo.' };
  const target = one('SELECT id, username, guild_id FROM players WHERE username = ?', [targetUsername]);
  if (!target) return { ok: false, error: `❌ No existe ningún jugador con el nombre "${targetUsername}".` };
  if (target.guild_id !== leader.guild_id) return { ok: false, error: `❌ ${targetUsername} no pertenece a tu gremio.` };
  if (target.id === currentLeaderId) return { ok: false, error: '❌ Ya sos el líder.' };
  run('UPDATE guilds SET leader_id = ? WHERE id = ?', [target.id, guild.id]);
  return { ok: true, newLeaderName: target.username };
}

/**
 * Actualizar el rango del gremio según número de miembros y hazañas.
 * Rango 1=Banda (1-3), Rango 2=Gremio (4-6), Rango 3=Forjado (7+ o ≥10 hazañas), Rango 4=Legendario (solo hazañas épicas)
 * @param {string} guildId
 */
function _updateGuildRank(guildId) {
  const guild = one('SELECT id, rank, total_hazanas FROM guilds WHERE id = ?', [guildId]);
  if (!guild) return;
  const members = all('SELECT id FROM players WHERE guild_id = ?', [guildId]);
  const count = members.length;
  const hazanas = guild.total_hazanas || 0;
  let newRank = 1;
  if (hazanas >= 10 || count >= 7) newRank = 3;
  else if (count >= 4) newRank = 2;
  if (newRank !== guild.rank && newRank > guild.rank) {
    run('UPDATE guilds SET rank = ? WHERE id = ?', [newRank, guildId]);
  }
}

/**
 * Incrementar kills/quests semanales del gremio de un jugador.
 * @param {string} playerId
 * @param {'kills'|'quests'} type
 * @param {number} amount
 */
function incrementGuildWeeklyStat(playerId, type, amount = 1) {
  const player = one('SELECT guild_id FROM players WHERE id = ?', [playerId]);
  if (!player || !player.guild_id) return;
  if (type === 'kills') {
    run('UPDATE guilds SET weekly_kills = weekly_kills + ? WHERE id = ?', [amount, player.guild_id]);
  } else if (type === 'quests') {
    run('UPDATE guilds SET weekly_quests = weekly_quests + ? WHERE id = ?', [amount, player.guild_id]);
  }
}

/**
 * Obtener el gremio de un jugador por ID.
 * @param {string} playerId
 * @returns {object | null}
 */
function getPlayerGuild(playerId) {
  const player = one('SELECT guild_id FROM players WHERE id = ?', [playerId]);
  if (!player || !player.guild_id) return null;
  return getGuildInfo(player.guild_id);
}

/**
 * Obtener todos los gremios activos con info básica.
 * @returns {Array}
 */
function getAllGuildsEpic() {
  const guilds = all('SELECT g.*, p.username AS leader_username FROM guilds g LEFT JOIN players p ON p.id = g.leader_id ORDER BY g.rank DESC, g.total_hazanas DESC');
  return guilds.map(g => ({
    ...g,
    member_count: (all('SELECT COUNT(*) AS c FROM players WHERE guild_id = ?', [g.id])[0] || {}).c || 0,
    rank_name: ['', 'Banda', 'Gremio', 'Forjado', 'Legendario'][g.rank] || 'Desconocido',
  }));
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
 * Devuelve eventos de tipo boss que contengan la cadena `pattern` en el mensaje,
 * desde una fecha dada. Útil para buscar kills al Lich sin cargar todos los eventos.
 * @param {string} afterIso — fecha ISO (YYYY-MM-DD)
 * @param {string} pattern — fragmento a buscar en el mensaje (SQL LIKE)
 * @returns {object[]}
 */
function getBossEventsSince(afterIso, pattern) {
  return all(
    "SELECT * FROM global_events WHERE type = 'boss' AND message LIKE ? AND created_at > ? ORDER BY id ASC",
    [`%${pattern}%`, afterIso]
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
  caos:   { stat: 'max_mana', amount: 3,  label: '+3 maná máximo permanente' },
};

// DIS-1364: afinidades temáticas de monstruos normales (no-boss)
// Cuando el jugador no tiene runas del tipo afín, estos monstruos
// añaden peso extra a su tipo temático (x3 adicional)
const MONSTER_RUNE_AFFINITY = {
  2:  'sombra',  // Esqueleto Guerrero
  4:  'sombra',  // Espectro del Corredor
  9:  'sombra',  // Guardia de la Prisión (no-boss variante)
  11: 'hielo',   // Elemental de Hielo
  18: 'sombra',  // Esqueleto Arquero (si existe)
};

// DIS-1354: mapa de bosses a su tipo de runa temático
// Cada boss suelta su tipo característico (no aleatorio)
const BOSS_RUNE_TYPES = {
  13: 'sombra',  // Lich Anciano — no-muerto de naturaleza oscura
  22: 'sombra',  // Sombra del Vacío — pura oscuridad
  21: 'caos',    // Eco Viviente — aberración caótica
  10: 'fuego',   // Golem de Forja — creado en fuego eterno
  12: 'luz',     // Campeón Espectral — guerrero espectral sagrado
  8:  'luz',     // Guardia Espectral — no-muerto sagrado
  5:  'hielo',   // Gólem de Piedra — debilidad al frío
};

/**
 * Intenta dar una runa al jugador (40% de chance base, 100% si isBoss=true).
 * DIS-1354: sistema de pesos — los tipos que el jugador ya acumula tienen mayor
 *   probabilidad de aparecer, facilitando completar sets sin depender solo del RNG.
 *   Los bosses sueltan su tipo temático fijo (ver BOSS_RUNE_TYPES).
 * Si el jugador ya tiene 2 del mismo tipo y recibe una 3ra, se fusionan automáticamente
 * y se aplica el bonus permanente. Devuelve un mensaje o null.
 */
function tryAddRune(playerId, isBoss = false, monsterId = null) {
  // DIS-1127: subido de 0.15 a 0.20 para que el sistema sea más visible durante el early game
  // DIS-1341: subido de 0.20 a 0.28 — en 10 kills se obtienen ~2.8 runas (antes ~2)
  // DIS-1690: subido de 0.28 a 0.40 — en 10 kills se obtienen ~4 runas (más visible, fusión accesible en sesión normal)
  //           Los bosses garantizan una runa (isBoss=true → saltea el check de probabilidad)
  if (!isBoss && Math.random() > 0.40) return null; // 40% de chance base

  const player = getPlayer(playerId);
  if (!player) return null;

  let runes;
  try { runes = JSON.parse(player.runes || '{}'); } catch (_) { runes = {}; }

  let type;

  // DIS-1354: bosses sueltan su tipo temático fijo
  if (isBoss && monsterId !== null && BOSS_RUNE_TYPES[monsterId]) {
    type = BOSS_RUNE_TYPES[monsterId];
  } else {
    // DIS-1354: sistema de pesos — runas que el jugador ya acumula tienen más probabilidad
    // Peso: 0 acumuladas → 1, 1 acumulada → 3, 2 acumuladas → 6
    // DIS-1690: subido a 1→4→8 — completar un set ya iniciado es mucho más probable
    // Esto hace que una vez que tenés 1 runa de un tipo, completar sea ~4-8x más probable
    // DIS-1364: bonus de afinidad temática para monstruos no-boss con tipo definido
    const WEIGHT_BY_COUNT = [1, 4, 8];
    const weightedPool = [];
    for (const t of RUNE_TYPES) {
      const count = runes[t] || 0;
      let weight = WEIGHT_BY_COUNT[count] || 1;
      // Bonus temático: si el monstruo tiene afinidad con este tipo, añadir peso extra x3
      if (monsterId !== null && MONSTER_RUNE_AFFINITY[monsterId] === t) {
        weight += 3;
      }
      for (let i = 0; i < weight; i++) weightedPool.push(t);
    }
    type = weightedPool[Math.floor(Math.random() * weightedPool.length)];
  }

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
    // DIS-1770: trackear el HP bonus acumulado de runas para mostrarlo en status
    if (bonus.stat === 'max_hp') {
      const newRuneHpBonus = (pFresh.rune_hp_bonus || 0) + bonus.amount;
      updatePlayer(playerId, { rune_hp_bonus: newRuneHpBonus });
    }

    const statDisplayName = bonus.stat === 'max_hp' ? 'HP máximo' : bonus.stat === 'attack' ? 'Ataque' : bonus.stat === 'defense' ? 'Defensa' : bonus.stat === 'max_mana' ? 'Maná máximo' : bonus.stat;
    return `✨ ¡Obtuviste la Runa de ${type.charAt(0).toUpperCase() + type.slice(1)} ${RUNE_EMOJIS[type]}!\n🌟 ¡FUSIÓN DE RUNAS! Las 3 runas de ${type} se combinan → ${bonus.label}\n   ${statDisplayName} ahora: ${newVal} ✨`;
  } else {
    // Agregar runa normal
    runes[type] = current + 1;
    updatePlayer(playerId, { runes: JSON.stringify(runes) });
    const needed = 3 - (current + 1);
    const bonus = RUNE_BONUSES[type];
    // DIS-587: hint de enchant en la primera runa obtenida
    // DIS-2170: guía de decisión enchant vs fusión — más clara sobre cuándo conviene cada opción
    const isFirstRune = Object.values(runes).reduce((a, b) => a + b, 0) === 1;
    const enchantHint = isFirstRune
      ? `\n   🪄 ¡Primera runa! Dos opciones:\n   • \"enchant ${type}\" — consume esta runa, encanta tu arma 3 min. Ideal antes de un boss o si estás en apuros.\n   • Guardar y acumular 3 del mismo tipo → FUSIÓN: ${bonus.label} (permanente, vale más a largo plazo).\n   Regla rápida: boss cerca → enchant. Podés farmear → esperá la fusión. Más info: \"runas\".`
      : `\n   💡 Recordá: \"enchant ${type}\" la consume (buff 3 min), o juntá 3 → fusión permanente (${bonus.label}). Ver: \"runas\".`;
    // DIS-1942: primer drop de este tipo → explicar sistema; drops siguientes → solo conteo
    if (current === 0) {
      // Primera runa de este tipo — mostrar descripción del sistema
      return `🔮 Encontrás una Runa de ${type.charAt(0).toUpperCase() + type.slice(1)} ${RUNE_EMOJIS[type]}! (1/3)\n   Al juntar 3 del mismo tipo se fusionan → ${bonus.label}.\n   Necesitás ${needed} más para fusionar.${enchantHint}`;
    } else {
      // Ya tenés al menos 1 de este tipo — mensaje compacto, sin repetir el sistema
      const progressNote = needed === 1 ? '⚡ ¡Solo 1 más para la fusión!' : `${needed} más para fusionar.`;
      return `🔮 Otra Runa de ${type.charAt(0).toUpperCase() + type.slice(1)} ${RUNE_EMOJIS[type]} (${current + 1}/3). ${progressNote}`;
    }
  }
}

function getPlayerRunes(playerId) {
  const player = getPlayer(playerId);
  if (!player) return {};
  try { return JSON.parse(player.runes || '{}'); } catch (_) { return {}; }
}

/**
 * DIS-1538: Agrega una runa de un tipo específico al jugador.
 * Si alcanza 3, se fusionan automáticamente igual que en tryAddRune.
 * Devuelve un mensaje breve para mostrar en el chat, o null si falla.
 */
function addRuneOfType(playerId, type) {
  const player = getPlayer(playerId);
  if (!player) return null;
  let runes;
  try { runes = JSON.parse(player.runes || '{}'); } catch (_) { runes = {}; }

  const current = runes[type] || 0;
  if (current >= 2) {
    // Fusión
    delete runes[type];
    updatePlayer(playerId, { runes: JSON.stringify(runes) });
    const bonus = RUNE_BONUSES[type];
    const pFresh = getPlayer(playerId);
    const newVal = (pFresh[bonus.stat] || 0) + bonus.amount;
    updatePlayer(playerId, { [bonus.stat]: newVal });
    // DIS-1770: trackear el HP bonus acumulado de runas
    if (bonus.stat === 'max_hp') {
      const newRuneHpBonus = (pFresh.rune_hp_bonus || 0) + bonus.amount;
      updatePlayer(playerId, { rune_hp_bonus: newRuneHpBonus });
    }
    return `Runa de ${type.charAt(0).toUpperCase() + type.slice(1)} ${RUNE_EMOJIS[type]} — ¡SET COMPLETO! 🌟 FUSIÓN → ${bonus.label} (ahora: ${newVal})`;
  } else {
    runes[type] = current + 1;
    updatePlayer(playerId, { runes: JSON.stringify(runes) });
    const needed = 3 - (current + 1);
    return `Runa de ${type.charAt(0).toUpperCase() + type.slice(1)} ${RUNE_EMOJIS[type]} (${current + 1}/3)${needed === 1 ? ' — ¡Solo 1 más para fusionar!' : ''}`;
  }
}



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
  // BUG-1643: usar formato SQLite para expires_at (datetime('now') retorna 'YYYY-MM-DD HH:MM:SS')
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString().replace('T', ' ').split('.')[0];
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
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
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
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
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
  // BUG-1643: usar formato SQLite para comparar contra expires_at
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
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
  // BUG-1642-follow: sessions.start_time usa formato SQLite (YYYY-MM-DD HH:MM:SS), no ISO 8601
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').split('.')[0];
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
     WHERE is_archived = 0 AND (is_bot IS NULL OR is_bot = 0)
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
  // BUG-1642-follow: usar formato SQLite para comparar contra last_seen
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').split('.')[0];
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
  // BUG-1643: usar formato SQLite para expires_at (las queries usan datetime('now') para comparar)
  const expiresAt = new Date(Date.now() + durationMs).toISOString().replace('T', ' ').split('.')[0];
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
  // BUG-1643: usar formato SQLite para expires_at (getBulletinPosts usa datetime('now'))
  const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString().replace('T', ' ').split('.')[0]; // 6 horas
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

  // Aplicar recompensa — BUG-1475: recalcular nivel para evitar desincronización
  const newXpStreak = (player.xp || 0) + xpReward;
  const newLevelStreak = xpSystem.levelFromXp(newXpStreak);
  const streakUpdates = {
    login_streak: newStreak,
    last_login_date: todayStr,
    gold: (player.gold || 0) + goldReward,
    xp:   newXpStreak,
    level: newLevelStreak,
  };
  if (newLevelStreak > (player.level || 1)) {
    streakUpdates.max_hp = (player.max_hp || 30) + 5;
    const healOnStreakUp = Math.ceil(streakUpdates.max_hp * 0.20);
    streakUpdates.hp = Math.min(streakUpdates.max_hp, (player.hp || 1) + healOnStreakUp);
    streakUpdates.attack = (player.attack || 5) + 1;
  }
  updatePlayer(playerId, streakUpdates);

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
function assignExpeditionToDB(playerId, expeditionId, initialData = {}) {
  run(
    `INSERT INTO expeditions (player_id, expedition_id, state, step, data) VALUES (?, ?, 'active', 1, ?)`,
    [playerId, expeditionId, JSON.stringify(initialData)]
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

// ─── EPIC-1373: Sistema de Facciones ─────────────────────────────────────────

/**
 * Obtener la facción de un jugador.
 * @param {string} playerId
 * @returns {string|null}
 */
function getPlayerFaction(playerId) {
  const p = one('SELECT faction FROM players WHERE id = ?', [playerId]);
  return p ? p.faction : null;
}

/**
 * Obtener la fila completa de una facción.
 * @param {string} factionId
 * @returns {object|null}
 */
function getFaction(factionId) {
  return one('SELECT * FROM factions WHERE id = ?', [factionId]);
}

/**
 * Obtener las 3 facciones ordenadas por week_influence desc.
 * @returns {Array<object>}
 */
function getAllFactions() {
  return all('SELECT * FROM factions ORDER BY week_influence DESC', []);
}

/**
 * Obtener el ranking semanal.
 * @returns {{ leader: object|null, ranking: Array<object> }}
 */
function getWeeklyLeaders() {
  const ranking = getAllFactions();
  return { leader: ranking[0] || null, ranking };
}

/**
 * Obtener los top contribuidores de una facción esta semana.
 * @param {string} factionId
 * @param {number} limit
 * @returns {Array<object>}
 */
function getFactionTopContributors(factionId, limit = 5) {
  return all(
    `SELECT id, username, faction_week_influence
     FROM players
     WHERE faction = ? AND is_bot = 0
     ORDER BY faction_week_influence DESC
     LIMIT ?`,
    [factionId, limit]
  );
}

/**
 * Asignar facción a un jugador. Resetea faction_week_influence a 0.
 * @param {string} playerId
 * @param {string|null} factionId
 */
function setPlayerFaction(playerId, factionId) {
  run('UPDATE players SET faction = ?, faction_week_influence = 0 WHERE id = ?', [factionId || null, playerId]);
}

/**
 * Registrar timestamp del cambio de facción.
 * @param {string} playerId
 */
function recordFactionChange(playerId) {
  run('UPDATE players SET faction_changed_at = datetime(\'now\') WHERE id = ?', [playerId]);
}

/**
 * Agregar puntos de influencia a un jugador y a su facción.
 * @param {string} playerId
 * @param {number} amount
 * @returns {boolean}
 */
function addFactionInfluence(playerId, amount) {
  const p = one('SELECT faction FROM players WHERE id = ?', [playerId]);
  if (!p || !p.faction) return false;
  run(
    'UPDATE players SET faction_influence = faction_influence + ?, faction_week_influence = faction_week_influence + ? WHERE id = ?',
    [amount, amount, playerId]
  );
  run(
    'UPDATE factions SET week_influence = week_influence + ?, total_influence = total_influence + ? WHERE id = ?',
    [amount, amount, p.faction]
  );
  return true;
}

/**
 * Resetear influencia semanal (correr lunes 00:00 UTC).
 * Aplica influencia pasiva base a facciones sin jugadores activos.
 * @returns {{ winner: string|null, newStreak: number }}
 */
function resetWeeklyFactionInfluence() {
  const BASE_PASSIVE = 50; // puntos para facciones sin jugadores activos
  const factions = getAllFactions();
  let winner = null;
  let newStreak = 0;
  const leaderId = factions.length > 0 ? factions[0].id : null;

  for (const faction of factions) {
    const hasActivePlayers = (faction.week_influence > 0);
    const passiveBonus = hasActivePlayers ? 0 : BASE_PASSIVE;
    const finalInfluence = faction.week_influence + passiveBonus;

    // Actualizar total_influence con la influencia final de la semana
    run('UPDATE factions SET total_influence = total_influence + ? WHERE id = ?', [passiveBonus, faction.id]);

    // Actualizar control_streak
    if (faction.id === leaderId) {
      const newStreakVal = faction.control_streak + 1;
      run('UPDATE factions SET control_streak = ?, week_influence = 0, last_reset_week = ? WHERE id = ?',
        [newStreakVal, getCurrentISOWeekKey(), faction.id]);
      winner = faction.id;
      newStreak = newStreakVal;
    } else {
      run('UPDATE factions SET control_streak = 0, week_influence = 0, last_reset_week = ? WHERE id = ?',
        [getCurrentISOWeekKey(), faction.id]);
    }
  }

  // Resetear influencia semanal de jugadores
  run('UPDATE players SET faction_week_influence = 0', []);

  // IMPL-WM-1711: crear las Misiones de Guerra de la semana nueva (idempotente)
  try { ensureWarMissionsForWeek(); } catch (_) {}

  return { winner, newStreak };
}

/**
 * Obtener la ISO week key actual (ej: '2026-28').
 * @returns {string}
 */
function getCurrentISOWeekKey() {
  const now = new Date();
  const jan1 = new Date(now.getFullYear(), 0, 1);
  const week = Math.ceil(((now - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  return `${now.getFullYear()}-${String(week).padStart(2, '0')}`;
}

/**
 * Marcar que el jugador ya recibió la notificación de facción.
 * @param {string} playerId
 */
function setFactionNotified(playerId) {
  run('UPDATE players SET faction_notified = 1 WHERE id = ?', [playerId]);
}

// ─────────────────────────────────────────────────────────────────────────────
// IMPL-WM-1710/1711: Misiones de Guerra Semanal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Retorna la ISO week key actual (ej: '2026-W29').
 * Usamos el mismo formato que challengeAssigner para consistencia.
 */
function getWarWeekKey() {
  const now = new Date();
  const jan4 = new Date(now.getFullYear(), 0, 4);
  const week1Monday = new Date(jan4);
  week1Monday.setDate(jan4.getDate() - (jan4.getDay() || 7) + 1);
  const diffMs = now - week1Monday;
  const weekNum = Math.floor(diffMs / (7 * 24 * 3600 * 1000)) + 1;
  return `${now.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

/**
 * Definiciones estáticas de los objetivos de Misión de Guerra por facción.
 * Cada semana se crean filas con estos datos + target escalado.
 * @param {number} weekNumber — usado para escalar targets (semana 1 = base, +10% por semana)
 * @returns {Array<object>}
 */
function getWarMissionDefs(weekNumber = 1) {
  const scale = 1 + Math.floor((weekNumber - 1) * 0.1); // escala de a 10% por semana, mínimo 1
  return [
    {
      faction: 'orden_filo',
      objective_type: 'kill_collective',
      target_name: null,
      target_global: Math.round(50 * scale),
      reward_xp_per_member: 100,
    },
    {
      faction: 'conclave_arcano',
      objective_type: 'explore_collective',
      target_name: null,
      target_global: Math.round(20 * scale),
      reward_xp_per_member: 100,
    },
    {
      faction: 'hermandad_mercado',
      objective_type: 'buy_collective',
      target_name: null,
      target_global: Math.round(30 * scale),
      reward_xp_per_member: 100,
    },
  ];
}

/**
 * Crea las 3 Misiones de Guerra de la semana actual si no existen todavía.
 * Idempotente — usa INSERT OR IGNORE.
 */
function ensureWarMissionsForWeek() {
  const weekKey = getWarWeekKey();
  // Calcular número de semana para escalar
  const now = new Date();
  const jan1 = new Date(now.getFullYear(), 0, 1);
  const weekNumber = Math.ceil(((now - jan1) / 86400000 + jan1.getDay() + 1) / 7);

  const defs = getWarMissionDefs(weekNumber);
  for (const d of defs) {
    try {
      run(
        `INSERT OR IGNORE INTO faction_war_missions
           (faction, week, objective_type, target_name, target_global, progress_global, completed, reward_xp_per_member)
         VALUES (?, ?, ?, ?, ?, 0, 0, ?)`,
        [d.faction, weekKey, d.objective_type, d.target_name || null, d.target_global, d.reward_xp_per_member]
      );
    } catch (e) {
      console.error('[db] ensureWarMissionsForWeek error:', e.message);
    }
  }
  return weekKey;
}

/**
 * Obtener la Misión de Guerra activa de una facción para la semana actual.
 * @param {string} faction
 * @returns {object|null}
 */
function getWarMission(faction) {
  const weekKey = getWarWeekKey();
  try {
    const rows = db.exec(
      `SELECT * FROM faction_war_missions WHERE faction = ? AND week = ? LIMIT 1`,
      [faction, weekKey]
    );
    if (!rows.length || !rows[0].values.length) return null;
    const cols = rows[0].columns;
    const vals = rows[0].values[0];
    const obj = {};
    cols.forEach((c, i) => { obj[c] = vals[i]; });
    return obj;
  } catch (_) {
    return null;
  }
}

/**
 * Incrementar el progreso colectivo de la Misión de Guerra de una facción.
 * @param {string} faction
 * @param {number} amount
 * @returns {{ completed: boolean, newProgress: number, target: number }}
 */
function incrementWarMissionProgress(faction, amount = 1) {
  const weekKey = getWarWeekKey();
  try {
    run(
      `UPDATE faction_war_missions
       SET progress_global = MIN(progress_global + ?, target_global)
       WHERE faction = ? AND week = ? AND completed = 0`,
      [amount, faction, weekKey]
    );
    const mission = getWarMission(faction);
    if (!mission) return { completed: false, newProgress: 0, target: 0, rewarded: [] };
    // Auto-completar si alcanzó el target y aún no está completada
    if (mission.completed === 0 && mission.progress_global >= mission.target_global) {
      const rewarded = completeWarMissionWithRewards(faction, mission.reward_xp_per_member || 100);
      return {
        completed: true,
        newProgress: mission.progress_global,
        target: mission.target_global,
        rewarded,
      };
    }
    return {
      completed: mission.completed === 1,
      newProgress: mission.progress_global,
      target: mission.target_global,
      rewarded: [],
    };
  } catch (e) {
    console.error('[db] incrementWarMissionProgress error:', e.message);
    return { completed: false, newProgress: 0, target: 0, rewarded: [] };
  }
}

/**
 * Marcar la Misión de Guerra de una facción como completada.
 * @param {string} faction
 */
function completeWarMission(faction) {
  const weekKey = getWarWeekKey();
  try {
    run(
      `UPDATE faction_war_missions
       SET completed = 1, completed_at = datetime('now')
       WHERE faction = ? AND week = ? AND completed = 0`,
      [faction, weekKey]
    );
  } catch (e) {
    console.error('[db] completeWarMission error:', e.message);
  }
}

/**
 * Completar la Misión de Guerra y dar XP a todos los miembros activos de la semana.
 * "Activo" = jugado en los últimos 7 días y no archivado.
 * @param {string} faction
 * @param {number} rewardXp - XP por miembro
 * @returns {string[]} - IDs de jugadores que recibieron XP
 */
function completeWarMissionWithRewards(faction, rewardXp) {
  completeWarMission(faction);
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  let rewarded = [];
  try {
    const members = all(
      `SELECT id, xp, level FROM players WHERE faction = ? AND last_seen >= ? AND is_archived = 0`,
      [faction, cutoff]
    );
    for (const m of members) {
      try {
        const newXp = (m.xp || 0) + rewardXp;
        const newLevel = xpSystem.levelFromXp(newXp);
        run('UPDATE players SET xp = ?, level = ? WHERE id = ?', [newXp, newLevel, m.id]);
        rewarded.push(m.id);
      } catch (e) {
        console.error('[db] completeWarMissionWithRewards xp error:', e.message);
      }
    }
  } catch (e) {
    console.error('[db] completeWarMissionWithRewards error:', e.message);
  }
  return rewarded;
}

/**
 * Obtener todas las Misiones de Guerra de la semana actual.
 * @returns {Array<object>}
 */
function getAllWarMissions() {
  const weekKey = getWarWeekKey();
  try {
    const rows = db.exec(
      `SELECT * FROM faction_war_missions WHERE week = ?`,
      [weekKey]
    );
    if (!rows.length) return [];
    const cols = rows[0].columns;
    return rows[0].values.map(vals => {
      const obj = {};
      cols.forEach((c, i) => { obj[c] = vals[i]; });
      return obj;
    });
  } catch (_) {
    return [];
  }
}

// ─── EPIC-1817: Memoria del Dungeon ──────────────────────────────────────────

/** Devuelve el lunes de la semana actual en formato YYYY-MM-DD (UTC) */
function getWeekStart() {
  const now = new Date();
  const day = now.getUTCDay(); // 0=dom, 1=lun, ..., 6=sab
  const diff = (day === 0) ? -6 : 1 - day; // días hasta el lunes anterior
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() + diff);
  return monday.toISOString().slice(0, 10);
}

/** Garantiza que existe una fila de player_history_meta para el username dado */
function ensurePlayerHistoryExists(username) {
  if (!db || !username) return;
  try {
    const weekStart = getWeekStart();
    db.run(
      `INSERT OR IGNORE INTO player_history_meta (username, week_start, last_active_at)
       VALUES (?, ?, datetime('now'))`,
      [username, weekStart]
    );
    // Si la semana cambió, resetear kills_this_week
    db.run(
      `UPDATE player_history_meta
       SET kills_this_week = 0, week_start = ?
       WHERE username = ? AND week_start != ?`,
      [weekStart, username, weekStart]
    );
  } catch (e) {
    console.error('[db] ensurePlayerHistoryExists:', e.message);
  }
}

/** Acumula un kill en room_stats para la sala y monstruo dado */
function incrementRoomStat(roomId, monsterName, eventType) {
  if (!db) return;
  try {
    const weekStart = getWeekStart();
    const mName = monsterName || '_player_death';
    db.run(
      `INSERT INTO room_stats (room_id, monster_name, event_type, count_total, count_week, week_start)
       VALUES (?, ?, ?, 1, 1, ?)
       ON CONFLICT(room_id, monster_name, event_type, week_start)
       DO UPDATE SET
         count_total = count_total + 1,
         count_week  = count_week + 1,
         updated_at  = datetime('now')`,
      [roomId, mName, eventType, weekStart]
    );
  } catch (e) {
    console.error('[db] incrementRoomStat:', e.message);
  }
}

/** Acumula un kill en player_history_meta */
function incrementPlayerHistoryKill(username) {
  if (!db || !username) return;
  try {
    ensurePlayerHistoryExists(username);
    db.run(
      `UPDATE player_history_meta
       SET total_kills = total_kills + 1,
           kills_this_week = kills_this_week + 1,
           last_active_at = datetime('now')
       WHERE username = ?`,
      [username]
    );
  } catch (e) {
    console.error('[db] incrementPlayerHistoryKill:', e.message);
  }
}

/** Acumula una muerte en player_history_meta */
function incrementPlayerHistoryDeath(username) {
  if (!db || !username) return;
  try {
    ensurePlayerHistoryExists(username);
    db.run(
      `UPDATE player_history_meta
       SET total_deaths = total_deaths + 1,
           last_active_at = datetime('now')
       WHERE username = ?`,
      [username]
    );
  } catch (e) {
    console.error('[db] incrementPlayerHistoryDeath:', e.message);
  }
}

/** Acumula una ascensión en player_history_meta */
function incrementPlayerHistoryAscension(username, levelReached) {
  if (!db || !username) return;
  try {
    ensurePlayerHistoryExists(username);
    const lvl = levelReached || 1;
    db.run(
      `UPDATE player_history_meta
       SET total_ascensions = total_ascensions + 1,
           max_level_reached = MAX(max_level_reached, ?),
           last_active_at = datetime('now')
       WHERE username = ?`,
      [lvl, username]
    );
  } catch (e) {
    console.error('[db] incrementPlayerHistoryAscension:', e.message);
  }
}

/** Registra un nuevo run (creación o recreación de personaje) */
function incrementPlayerHistoryRun(username) {
  if (!db || !username) return;
  try {
    ensurePlayerHistoryExists(username);
    db.run(
      `UPDATE player_history_meta
       SET total_runs = total_runs + 1,
           last_active_at = datetime('now')
       WHERE username = ?`,
      [username]
    );
  } catch (e) {
    console.error('[db] incrementPlayerHistoryRun:', e.message);
  }
}

/**
 * Devuelve las stats de una sala para un período dado.
 * period: 'week' | 'total' | 'both'
 * Retorna array de { monster_name, event_type, count_week, count_total }
 */
function getRoomStats(roomId, period) {
  if (!db) return [];
  try {
    const weekStart = getWeekStart();
    if (period === 'week') {
      return all(
        `SELECT monster_name, event_type, count_week, count_total
         FROM room_stats
         WHERE room_id = ? AND week_start = ?
         ORDER BY count_week DESC`,
        [roomId, weekStart]
      );
    } else if (period === 'total') {
      return all(
        `SELECT monster_name, event_type, SUM(count_total) as count_total
         FROM room_stats
         WHERE room_id = ?
         GROUP BY monster_name, event_type
         ORDER BY count_total DESC`,
        [roomId]
      );
    } else {
      // both: semana actual + total histórico
      return all(
        `SELECT rs_week.monster_name, rs_week.event_type,
                COALESCE(rs_week.count_week, 0) as count_week,
                COALESCE(rs_all.count_total, 0) as count_total
         FROM room_stats rs_week
         LEFT JOIN (
           SELECT monster_name, event_type, SUM(count_total) as count_total
           FROM room_stats
           WHERE room_id = ?
           GROUP BY monster_name, event_type
         ) rs_all ON rs_week.monster_name = rs_all.monster_name AND rs_week.event_type = rs_all.event_type
         WHERE rs_week.room_id = ? AND rs_week.week_start = ?
         ORDER BY rs_week.count_week DESC`,
        [roomId, roomId, weekStart]
      );
    }
  } catch (e) {
    console.error('[db] getRoomStats:', e.message);
    return [];
  }
}

/** Devuelve el player_history_meta de un username */
function getPlayerHistory(username) {
  if (!db || !username) return null;
  try {
    return one(
      `SELECT * FROM player_history_meta WHERE username = ?`,
      [username]
    );
  } catch (e) {
    console.error('[db] getPlayerHistory:', e.message);
    return null;
  }
}

/** Devuelve las placas de la Cripta (cacheadas en crypt_plaques) */
function getCryptPlaques() {
  if (!db) return [];
  try {
    return all(
      `SELECT slot, username, plaque_text, category, generated_at
       FROM crypt_plaques
       ORDER BY slot`,
      []
    );
  } catch (e) {
    console.error('[db] getCryptPlaques:', e.message);
    return [];
  }
}

/** Devuelve la crónica más reciente de dungeon_chronicle */
function getLatestChronicle() {
  if (!db) return null;
  try {
    return one(
      `SELECT * FROM dungeon_chronicle ORDER BY week_start DESC LIMIT 1`,
      []
    );
  } catch (e) {
    console.error('[db] getLatestChronicle:', e.message);
    return null;
  }
}

/** Guarda o reemplaza una placa de la Cripta */
function upsertCryptPlaque(slot, username, plaqueText, category) {
  if (!db) return;
  try {
    db.run(
      `INSERT INTO crypt_plaques (slot, username, plaque_text, category, generated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(slot) DO UPDATE SET
         username = excluded.username,
         plaque_text = excluded.plaque_text,
         category = excluded.category,
         generated_at = excluded.generated_at`,
      [slot, username, plaqueText, category]
    );
  } catch (e) {
    console.error('[db] upsertCryptPlaque:', e.message);
  }
}

/** Guarda o reemplaza la crónica de una semana */
function upsertChronicle(weekStart, chronicleText, statsSnapshot) {
  if (!db) return;
  try {
    db.run(
      `INSERT INTO dungeon_chronicle (week_start, chronicle_text, stats_snapshot, generated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(week_start) DO UPDATE SET
         chronicle_text = excluded.chronicle_text,
         stats_snapshot = excluded.stats_snapshot,
         generated_at = excluded.generated_at`,
      [weekStart, chronicleText, JSON.stringify(statsSnapshot || {})]
    );
  } catch (e) {
    console.error('[db] upsertChronicle:', e.message);
  }
}

/**
 * Devuelve candidatos a placas de Cripta desde player_history_meta + legacies.
 * Excluye bots/testers.
 */
function getCryptCandidates() {
  if (!db) return { ascendidos: [], caidos: [], records: [], activos: [] };
  const botFilter = `
    AND username NOT LIKE '%Test%'
    AND username NOT LIKE '%Bot%'
    AND username NOT LIKE '%EPIC_%'
    AND username NOT LIKE 'TESTER%'
  `;
  try {
    const ascendidos = all(
      `SELECT phm.username, phm.total_ascensions, phm.total_kills, phm.max_level_reached,
              l.character_name, l.character_class, l.epitaph, l.ascended_at
       FROM player_history_meta phm
       JOIN legacies l ON l.account_username = phm.username
       WHERE phm.total_ascensions > 0 ${botFilter}
       ORDER BY phm.total_ascensions DESC, l.ascended_at DESC
       LIMIT 4`,
      []
    );
    const caidos = all(
      `SELECT phm.username, phm.total_kills, phm.total_deaths, phm.max_level_reached
       FROM player_history_meta phm
       WHERE phm.total_ascensions = 0
         AND phm.total_kills >= 5
         AND phm.total_deaths > 0
         ${botFilter}
       ORDER BY phm.total_kills DESC
       LIMIT 4`,
      []
    );
    const records = all(
      `SELECT username, max_level_reached, total_kills, max_kill_streak
       FROM player_history_meta
       WHERE 1=1 ${botFilter}
       ORDER BY max_level_reached DESC, total_kills DESC
       LIMIT 2`,
      []
    );
    const weekStart = getWeekStart();
    const activos = all(
      `SELECT username, kills_this_week, last_active_at
       FROM player_history_meta
       WHERE week_start = ? AND kills_this_week > 0 ${botFilter}
       ORDER BY kills_this_week DESC
       LIMIT 2`,
      [weekStart]
    );
    return { ascendidos, caidos, records, activos };
  } catch (e) {
    console.error('[db] getCryptCandidates:', e.message);
    return { ascendidos: [], caidos: [], records: [], activos: [] };
  }
}

// ─── EPIC-CAMP: Sistema de Campaña Narrativa ─────────────────────────────────

/**
 * getActiveCampaign() → { campaign, active, progress, goal_target, days_remaining } | null
 *
 * Retorna la campaña activa con su estado actual. Si no hay campaña activa, retorna null.
 * El campo `progress` es el valor del contador en world_state (clave goal_key de la campaña).
 */
function getActiveCampaign() {
  try {
    const active = one(`SELECT * FROM active_campaign WHERE id = 1`);
    if (!active) return null;

    const campaign = one(`SELECT * FROM campaigns WHERE id = ?`, [active.campaign_id]);
    if (!campaign) return null;

    // Leer progreso del world_state
    const wsRow = one(`SELECT value FROM world_state WHERE key = ?`, [campaign.goal_key]);
    const progress = wsRow ? wsRow.value : 0;

    // Calcular días restantes
    const now = new Date();
    const ends = new Date(active.ends_at);
    const days_remaining = Math.max(0, Math.ceil((ends - now) / (1000 * 60 * 60 * 24)));

    return {
      campaign: {
        ...campaign,
        reward_victory: campaign.reward_victory ? JSON.parse(campaign.reward_victory) : {},
        consequence_defeat: campaign.consequence_defeat ? JSON.parse(campaign.consequence_defeat) : {},
        active_effects: campaign.active_effects ? JSON.parse(campaign.active_effects) : {},
      },
      active,
      progress,
      goal_target: campaign.goal_target,
      days_remaining,
    };
  } catch (e) {
    console.error('[db] getActiveCampaign:', e.message);
    return null;
  }
}

/**
 * contributeToCurrentCampaign(playerUsername, amount) → boolean
 *
 * Registra una contribución del jugador a la campaña activa e incrementa el contador
 * colectivo en world_state. Retorna true si hubo campaña activa y se registró, false si no.
 */
function contributeToCurrentCampaign(playerUsername, amount = 1) {
  try {
    const active = one(`SELECT * FROM active_campaign WHERE id = 1`);
    if (!active || active.state !== 'active') return false;

    const campaign = one(`SELECT goal_key, goal_target FROM campaigns WHERE id = ?`, [active.campaign_id]);
    if (!campaign) return false;

    // Registrar contribución individual
    db.run(
      `INSERT INTO campaign_contributions (campaign_id, player_username, contribution)
       VALUES (?, ?, ?)`,
      [active.campaign_id, playerUsername, amount]
    );

    // Incrementar contador colectivo en world_state (upsert)
    db.run(
      `INSERT INTO world_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = value + ?, updated_at = datetime('now')`,
      [campaign.goal_key, amount, amount]
    );

    // Verificar si se alcanzó el objetivo → marcar victoria
    const wsRow = one(`SELECT value FROM world_state WHERE key = ?`, [campaign.goal_key]);
    const progress = wsRow ? wsRow.value : 0;
    if (progress >= campaign.goal_target) {
      db.run(
        `UPDATE active_campaign SET state = 'victory' WHERE id = 1 AND state = 'active'`
      );
    }

    return true;
  } catch (e) {
    console.error('[db] contributeToCurrentCampaign:', e.message);
    return false;
  }
}

/**
 * getCampaignHistory() → Array de { campaign_id, name, state, started_at, ends_at, progress, goal_target }
 *
 * Retorna el historial de campañas concluidas (victory / defeat / concluded).
 * Incluye también la activa si la hay.
 */
function getCampaignHistory() {
  try {
    // Traer todas las entradas de active_campaign (usamos un table de historial simplificado
    // — en esta fase guardamos solo la que estuvo activa; la rotación crea nuevas filas en tabla campaign_history)
    // Para MVP, devolvemos active_campaign actual + usamos world_state para el progreso histórico.
    const active = one(`SELECT * FROM active_campaign WHERE id = 1`);
    if (!active) return [];

    const campaign = one(`SELECT id, name, goal_key, goal_target FROM campaigns WHERE id = ?`, [active.campaign_id]);
    if (!campaign) return [];

    const wsRow = one(`SELECT value FROM world_state WHERE key = ?`, [campaign.goal_key]);
    const progress = wsRow ? wsRow.value : 0;

    return [{
      campaign_id: campaign.id,
      name: campaign.name,
      state: active.state,
      started_at: active.started_at,
      ends_at: active.ends_at,
      progress,
      goal_target: campaign.goal_target,
    }];
  } catch (e) {
    console.error('[db] getCampaignHistory:', e.message);
    return [];
  }
}

/**
 * getPlayerCampaignContributions(playerUsername, campaignId) → { total, actions }
 *
 * Retorna cuánto contribuyó un jugador en una campaña dada.
 * total: suma de todos sus aportes. actions: número de contribuciones individuales.
 */
function getPlayerCampaignContributions(playerUsername, campaignId) {
  try {
    const rows = all(
      `SELECT contribution, contributed_at FROM campaign_contributions
       WHERE player_username = ? AND campaign_id = ?
       ORDER BY contributed_at ASC`,
      [playerUsername, campaignId]
    );
    const total = rows.reduce((sum, r) => sum + r.contribution, 0);
    return { total, actions: rows.length, rows };
  } catch (e) {
    console.error('[db] getPlayerCampaignContributions:', e.message);
    return { total: 0, actions: 0, rows: [] };
  }
}

/**
 * awardCampaignTitles(campaignId, campaignName, outcome) → { awarded: string[], skipped: string[] }
 * EPIC-2125: Al resolver una campaña, asigna títulos de campaña a jugadores que contribuyeron 3+ veces.
 *
 * - Victoria: "🏆 Defensor de la Mazmorra — <campaignName>"
 * - Derrota con contribución: "🛡️ Resistió hasta el final — <campaignName>"
 *
 * El título se guarda en status_effects.campaign_titles como array de strings.
 * También se guarda el más reciente en status_effects.campaign_title_latest.
 */
function awardCampaignTitles(campaignId, campaignName, outcome) {
  const awarded = [];
  const skipped = [];
  try {
    // Obtener jugadores que contribuyeron 3+ veces en esta campaña
    const rows = all(
      `SELECT player_username, SUM(contribution) as total_contribution, COUNT(*) as actions
       FROM campaign_contributions
       WHERE campaign_id = ?
       GROUP BY player_username
       HAVING actions >= 3`,
      [campaignId]
    );

    if (!rows.length) {
      console.log(`[db] awardCampaignTitles: ningún jugador con 3+ contribuciones en ${campaignId}`);
      return { awarded, skipped };
    }

    const title = outcome === 'victory'
      ? `🏆 Defensor de la Mazmorra — ${campaignName}`
      : `🛡️ Resistió hasta el final — ${campaignName}`;

    for (const row of rows) {
      const username = row.player_username;
      // Buscar jugador por username
      const playerRow = one(`SELECT id, status_effects FROM players WHERE username = ? AND is_bot = 0`, [username]);
      if (!playerRow) {
        skipped.push(username);
        continue;
      }

      let se = {};
      try { se = JSON.parse(playerRow.status_effects || '{}'); } catch (_) {}

      // Agregar título al array de títulos de campaña
      if (!se.campaign_titles) se.campaign_titles = [];
      // Evitar duplicados del mismo título
      if (!se.campaign_titles.includes(title)) {
        se.campaign_titles.push(title);
      }
      se.campaign_title_latest = title;

      db.run(`UPDATE players SET status_effects = ? WHERE id = ?`, [JSON.stringify(se), playerRow.id]);
      awarded.push(username);
      console.log(`[db] awardCampaignTitles: título asignado a ${username} → "${title}"`);
    }
  } catch (e) {
    console.error('[db] awardCampaignTitles:', e.message);
  }
  return { awarded, skipped };
}

/**
 * activateCampaign(campaignId) → boolean
 *
 * Activa una campaña existente. Requiere que la campaña esté registrada en tabla `campaigns`.
 * Si ya hay una campaña activa, la reemplaza (upsert en active_campaign id=1).
 * Retorna true si tuvo éxito, false si la campaña no existe.
 */
function activateCampaign(campaignId) {
  try {
    const campaign = one(`SELECT id, duration_days, goal_key FROM campaigns WHERE id = ?`, [campaignId]);
    if (!campaign) {
      console.error(`[db] activateCampaign: campaña '${campaignId}' no encontrada en tabla campaigns`);
      return false;
    }

    const startedAt = new Date().toISOString();
    const endsAt = new Date(Date.now() + campaign.duration_days * 24 * 60 * 60 * 1000).toISOString();

    // Upsert en active_campaign (solo hay una fila con id=1)
    db.run(
      `INSERT INTO active_campaign (id, campaign_id, started_at, ends_at, state)
       VALUES (1, ?, ?, ?, 'active')
       ON CONFLICT(id) DO UPDATE SET
         campaign_id = excluded.campaign_id,
         started_at  = excluded.started_at,
         ends_at     = excluded.ends_at,
         state       = 'active'`,
      [campaignId, startedAt, endsAt]
    );

    // Resetear el contador de progreso en world_state
    const wsKey = campaign.goal_key || null;
    if (wsKey) {
      db.run(
        `INSERT INTO world_state (key, value, updated_at) VALUES (?, 0, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = 0, updated_at = datetime('now')`,
        [wsKey]
      );
    }

    console.log(`[db] activateCampaign: campaña '${campaignId}' activada. Termina: ${endsAt}`);
    return true;
  } catch (e) {
    console.error('[db] activateCampaign:', e.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EPIC-KAELTHAS (DIS-1967): Quest Principal de Kaelthas — helpers de main_quest_data
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Schema de main_quest_data (JSON almacenado en columna main_quest_data de players):
 * {
 *   fragments_found: string[],           // IDs de fragmentos ya encontrados
 *   main_quest_state: string,            // 'inactive' | 'active' | 'completed' | 'ended'
 *   kaelthas_fragments_count: number,    // cantidad de fragmentos encontrados (0-4)
 *   lich_died_with_quest: boolean,       // true si mató al Lich con quest completa
 *   started_at: string|null,             // ISO timestamp de activación de la quest
 * }
 *
 * Fragmentos de la quest (IDs):
 *   'trono'      — Sala del Trono (sala 9): leer inscripción de Hermana Vela
 *   'mausoleo'   — Galería de Hielo (sala 12): examine columnas
 *   'capilla'    — Capilla Olvidada (sala 5): examine altar
 *   'catedral'   — Catedral de la Oscuridad (sala 15): examine altar catedral
 */

const MQD_DEFAULTS = {
  fragments_found: [],
  main_quest_state: 'inactive',
  kaelthas_fragments_count: 0,
  lich_died_with_quest: false,
  started_at: null,
};

/**
 * Obtener main_quest_data de un jugador (parseado y con defaults).
 * @param {string} playerId
 * @returns {object} — main_quest_data con defaults aplicados
 */
function getMainQuestData(playerId) {
  try {
    const row = one('SELECT main_quest_data FROM players WHERE id = ?', [playerId]);
    if (!row) return { ...MQD_DEFAULTS };
    const parsed = JSON.parse(row.main_quest_data || '{}');
    return { ...MQD_DEFAULTS, ...parsed };
  } catch (_) {
    return { ...MQD_DEFAULTS };
  }
}

/**
 * Actualizar main_quest_data de un jugador (merge parcial).
 * @param {string} playerId
 * @param {object} patch — campos a sobreescribir
 */
function updateMainQuestData(playerId, patch) {
  try {
    const current = getMainQuestData(playerId);
    const updated = { ...current, ...patch };
    db.run(
      'UPDATE players SET main_quest_data = ? WHERE id = ?',
      [JSON.stringify(updated), playerId]
    );
  } catch (e) {
    console.error('[db] updateMainQuestData:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EPIC-2045: Boss Stats — kill counter global para el Boss Dialogue Engine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Devuelve el registro de stats de un boss (o null si no existe).
 * @param {string} bossId — ej: 'lich_anciano'
 */
function getBossStats(bossId) {
  try {
    return one(`SELECT * FROM boss_stats WHERE boss_id = ?`, [bossId]);
  } catch (e) {
    console.error('[db] getBossStats:', e.message);
    return null;
  }
}

/**
 * Registra un kill de boss. Actualiza total_kills, kills_this_week, last_killed_by.
 * Si es el primer kill, registra first_killed_by.
 * Resetea automáticamente kills_this_week si cambió la semana.
 * @param {string} bossId — ej: 'lich_anciano'
 * @param {string} killerUsername
 */
function recordBossKill(bossId, killerUsername) {
  try {
    const now = new Date().toISOString();
    // Calcular inicio de semana ISO (lunes)
    const d = new Date();
    const day = d.getUTCDay(); // 0 = domingo
    const diff = (day === 0 ? -6 : 1 - day);
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() + diff);
    monday.setUTCHours(0, 0, 0, 0);
    const weekStart = monday.toISOString().slice(0, 10); // 'YYYY-MM-DD'

    const existing = getBossStats(bossId);
    if (!existing) {
      // Primer kill ever
      run(`
        INSERT INTO boss_stats (boss_id, total_kills, kills_this_week, last_killed_by, last_killed_at, first_killed_by, first_killed_at, week_start)
        VALUES (?, 1, 1, ?, ?, ?, ?, ?)
      `, [bossId, killerUsername, now, killerUsername, now, weekStart]);
    } else {
      // Resetear kills_this_week si cambió la semana
      const thisWeekKills = existing.week_start === weekStart ? (existing.kills_this_week + 1) : 1;
      run(`
        UPDATE boss_stats
        SET total_kills = total_kills + 1,
            kills_this_week = ?,
            last_killed_by = ?,
            last_killed_at = ?,
            week_start = ?
        WHERE boss_id = ?
      `, [thisWeekKills, killerUsername, now, weekStart, bossId]);
    }
    return getBossStats(bossId);
  } catch (e) {
    console.error('[db] recordBossKill:', e.message);
    return null;
  }
}

/**
 * Resetea kills_this_week para todos los bosses (llamar al inicio de cada semana).
 */
function resetWeeklyBossKills() {
  try {
    const d = new Date();
    const day = d.getUTCDay();
    const diff = (day === 0 ? -6 : 1 - day);
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() + diff);
    monday.setUTCHours(0, 0, 0, 0);
    const weekStart = monday.toISOString().slice(0, 10);
    run(`UPDATE boss_stats SET kills_this_week = 0, week_start = ? WHERE week_start != ?`, [weekStart, weekStart]);
  } catch (e) {
    console.error('[db] resetWeeklyBossKills:', e.message);
  }
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
  getMonster, getMonstersInRoom, getAllMonsters, getLivingMonstersWithRoom, getMonstersForRespawn, getMonstersAwaitingRespawnWithPlayers, upsertMonster, updateMonster,
  // events
  logEvent, getRecentEvents,
  // offline messages (tell)
  saveOfflineMessage, getPendingMessages, markMessagesDelivered, countPendingMessages, getRecentMessages,
  // party (EPIC-PARTY-1626)
  createParty, getParty, updatePartyLeader, dissolveParty, touchParty, getStaleParties,
  // guilds
  getGuild, getGuildMembers, createGuild, deleteGuild, setPlayerGuild, getAllGuilds,
  // guild quests (T189)
  getGuildFull, setGuildQuest,
  // GUILD-DEF-002: API del Epic Gremios
  createGuildEpic, joinGuild, leaveGuild, getGuildInfo, depositItem, withdrawItem, transferGuildLeadership,
  getPlayerGuild, getAllGuildsEpic, incrementGuildWeeklyStat,
  // global events (T093)
  logGlobalEvent, getGlobalEvents, getGlobalEventsSince, getBossEventsSince, countKillsSince,
  // subastas (T098)
  createAuction, getActiveAuctions, getAuction, placeBid, closeExpiredAuctions, getRecentClosedAuctions,
  createPassiveAuction, getActivePassiveAuctions, // DIS-535
  // acceso raw (por si acaso)
  raw: () => db,
  // T115: logros secretos
  trackRoomVisit, addGoldSpent, addCraftsCount,
  // T140: runas coleccionables
  tryAddRune, getPlayerRunes, addRuneOfType, RUNE_TYPES, RUNE_EMOJIS, RUNE_BONUSES,
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
  // EPIC-1373: Sistema de Facciones
  getPlayerFaction, getFaction, getAllFactions, getWeeklyLeaders, getFactionTopContributors,
  setPlayerFaction, recordFactionChange, addFactionInfluence, resetWeeklyFactionInfluence,
  setFactionNotified, getCurrentISOWeekKey,
  // IMPL-WM-1710/1711: Misiones de Guerra Semanal
  ensureWarMissionsForWeek, getWarMission, getAllWarMissions,
  incrementWarMissionProgress, completeWarMission, completeWarMissionWithRewards, getWarWeekKey,
  // EPIC-1817: Memoria del Dungeon
  getWeekStart,
  ensurePlayerHistoryExists,
  incrementRoomStat, getRoomStats,
  incrementPlayerHistoryKill, incrementPlayerHistoryDeath, incrementPlayerHistoryAscension, incrementPlayerHistoryRun,
  getPlayerHistory, getCryptPlaques, getLatestChronicle,
  upsertCryptPlaque, upsertChronicle, getCryptCandidates,
  // EPIC-CAMP: Sistema de Campaña Narrativa
  getActiveCampaign, contributeToCurrentCampaign, getCampaignHistory, getPlayerCampaignContributions,
  awardCampaignTitles,
  activateCampaign,
  // EPIC-KAELTHAS (DIS-1967): Quest Principal — helpers de main_quest_data
  getMainQuestData, updateMainQuestData,
  // EPIC-2045: Boss Stats (Voces del Abismo — kill counter global)
  getBossStats, recordBossKill, resetWeeklyBossKills,
  };