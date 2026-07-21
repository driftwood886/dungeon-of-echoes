/**
 * memory.js — Epic Memoria del Dungeon
 *
 * Módulo central del sistema de memoria histórica del dungeon.
 * Expone funciones de alto nivel que combinan queries de BD con lógica de
 * presentación (templates de texto, generación de narrativa).
 *
 * Las funciones de BD cruda (incrementRoomStat, etc.) viven en db.js.
 * Las funciones de este módulo usan db.js para leer datos y devuelven
 * texto formateado listo para mostrar al jugador, o datos estructurados
 * para que engine.js los use.
 *
 * EPIC-1818-DEF — 2026-07-21
 */

'use strict';

const db = require('../db/db.js');

// ─── Helpers internos ──────────────────────────────────────────────────────────

/** Filtra username de bot para display */
function isBot(username) {
  return (
    /Test/i.test(username) ||
    /Bot/i.test(username) ||
    /^EPIC_/.test(username) ||
    /^TESTER/.test(username)
  );
}

/**
 * Formatea texto de placa de la Cripta para un aventurero ascendido.
 * @param {object} candidate - fila de getCryptCandidates().ascendidos
 * @returns {string} texto de la placa
 */
function formatAscendidoPlaque(candidate) {
  const { username, total_ascensions, character_name, character_class, epitaph, ascended_at } = candidate;
  const fecha = ascended_at ? ascended_at.slice(0, 10) : '???';
  const veces = total_ascensions === 1 ? 'una vez' : `${total_ascensions} veces`;
  const nombre = character_name || username;
  const clase = character_class ? ` (${character_class})` : '';
  const epitafio = epitaph ? `\n  "${epitaph}"` : '';
  return `${nombre}${clase} — Ascendió ${veces}. Última ascensión: ${fecha}.${epitafio}`;
}

/**
 * Formatea texto de placa para un Caído Honroso.
 * @param {object} candidate - fila de getCryptCandidates().caidos
 * @returns {string} texto de la placa
 */
function formatCaidoPlaque(candidate) {
  const { username, total_kills, total_deaths, max_level_reached } = candidate;
  return `${username} — Cayó con ${total_kills} kills a sus espaldas. Nivel máximo: ${max_level_reached}. El dungeon lo recuerda.`;
}

/**
 * Formatea texto de placa para el Récord.
 * @param {object} candidate - fila de getCryptCandidates().records
 * @returns {string} texto de la placa
 */
function formatRecordPlaque(candidate) {
  const { username, max_level_reached, total_kills } = candidate;
  return `${username} — Récord: nivel ${max_level_reached} alcanzado. ${total_kills} kills en total.`;
}

/**
 * Formatea texto de placa para el Activo Reciente.
 * @param {object} candidate - fila de getCryptCandidates().activos
 * @returns {string} texto de la placa
 */
function formatActivoPlaque(candidate) {
  const { username, kills_this_week } = candidate;
  return `${username} — Esta semana: ${kills_this_week} kills. El dungeon siente su presencia.`;
}

// ─── API pública ───────────────────────────────────────────────────────────────

/**
 * Devuelve el historial completo de un jugador (username-based, persiste entre ascensiones).
 *
 * @param {string} username
 * @returns {object|null} — campos: total_runs, total_kills, total_deaths, total_ascensions,
 *                          max_level_reached, max_kill_streak, first_lich_kill_at,
 *                          kills_this_week, last_active_at, week_start
 *                          O null si el jugador no tiene historial todavía.
 *
 * Llamado desde: engine.js al hablar con el anciano / Aldric / la escriba
 */
function getPlayerHistory(username) {
  if (!username) return null;
  return db.getPlayerHistory(username);
}

/**
 * Devuelve las estadísticas de una sala para un período dado.
 *
 * @param {number} roomId — ID de sala
 * @param {'week'|'total'|'both'} period — qué período mostrar
 * @returns {object[]} — array de { monster_name, event_type, count_week, count_total }
 *
 * Llamado desde: engine.js cuando el jugador usa `examine sala` en salas con bosses
 * o en cualquier sala si hay datos acumulados.
 */
function getRoomStats(roomId, period) {
  if (!roomId) return [];
  return db.getRoomStats(roomId, period || 'both');
}

/**
 * Genera el texto narrativo de las estadísticas de una sala, listo para mostrar.
 *
 * @param {number} roomId
 * @param {string} roomName — nombre de la sala (para el encabezado)
 * @returns {string|null} — texto formateado, o null si no hay estadísticas
 *
 * Llamado desde: engine.js handler del comando `examine`
 */
function getRoomStatsText(roomId, roomName) {
  const stats = db.getRoomStats(roomId, 'both');
  if (!stats.length) return null;

  const kills = stats.filter(s => s.event_type === 'monster_kill');
  const deaths = stats.filter(s => s.event_type === 'player_death');

  let lines = [`📜 Anales de ${roomName || 'esta sala'}:`];

  for (const k of kills) {
    if (k.monster_name === '_player_death') continue;
    lines.push(`  • ${k.monster_name}: ${k.count_week} caídos esta semana / ${k.count_total} histórico`);
  }

  if (deaths.length > 0) {
    const d = deaths[0];
    lines.push(`  • Aventureros caídos aquí: ${d.count_week} esta semana / ${d.count_total} histórico`);
  }

  return lines.join('\n');
}

/**
 * Regenera las placas de la Cripta desde la BD y las cachea en `crypt_plaques`.
 * Se llama al iniciar el servidor (si el caché tiene >24h) o manualmente.
 *
 * @returns {number} — cantidad de placas generadas (0-6)
 *
 * Llamado desde: init del servidor (en index.js) y potencialmente un cron periódico.
 */
function regenerateCryptPlaques() {
  const candidates = db.getCryptCandidates();
  let count = 0;

  // Slots: ascendido_1, ascendido_2
  const shuffledAscendidos = [...candidates.ascendidos].sort(() => Math.random() - 0.5);
  for (let i = 0; i < 2; i++) {
    const c = shuffledAscendidos[i];
    if (!c) continue;
    const text = formatAscendidoPlaque(c);
    db.upsertCryptPlaque(`ascendido_${i + 1}`, c.username, text, 'ascendido');
    count++;
  }

  // Slots: caido_1, caido_2
  const shuffledCaidos = [...candidates.caidos].sort(() => Math.random() - 0.5);
  for (let i = 0; i < 2; i++) {
    const c = shuffledCaidos[i];
    if (!c) continue;
    const text = formatCaidoPlaque(c);
    db.upsertCryptPlaque(`caido_${i + 1}`, c.username, text, 'caido_honroso');
    count++;
  }

  // Slot: record
  if (candidates.records[0]) {
    const c = candidates.records[0];
    const text = formatRecordPlaque(c);
    db.upsertCryptPlaque('record', c.username, text, 'record');
    count++;
  }

  // Slot: activo
  if (candidates.activos[0]) {
    const c = candidates.activos[0];
    const text = formatActivoPlaque(c);
    db.upsertCryptPlaque('activo', c.username, text, 'activo_reciente');
    count++;
  }

  return count;
}

/**
 * Devuelve el texto completo de las placas de la Cripta para mostrar al jugador.
 * Si el caché tiene más de 24h, lo regenera automáticamente.
 *
 * @param {number} [limit=6] — máximo de placas a mostrar
 * @returns {string} — texto formateado con las placas
 *
 * Llamado desde: engine.js cuando el jugador usa `read` o `look` en Cripta de los Valientes (sala 15)
 */
function getCryptPlaquesText(limit) {
  const maxPlaques = limit || 6;

  // Verificar si el caché tiene más de 24h
  const plaques = db.getCryptPlaques();
  const needsRegen = plaques.length === 0 || (() => {
    const oldest = plaques.reduce((o, p) =>
      p.generated_at < o ? p.generated_at : o,
      plaques[0].generated_at
    );
    const hoursOld = (Date.now() - new Date(oldest).getTime()) / 3600000;
    return hoursOld > 24;
  })();

  if (needsRegen) {
    regenerateCryptPlaques();
  }

  const fresh = db.getCryptPlaques().slice(0, maxPlaques);

  if (!fresh.length) {
    return '📜 Las placas de la Cripta están vacías. Los aventureros aún no han dejado huella suficiente en este dungeon.';
  }

  const lines = [
    '📜 *Las paredes de la Cripta de los Valientes están cubiertas de inscripciones:*\n',
    ...fresh.map(p => `  ⚔️  ${p.plaque_text}`),
    '\n*El dungeon recuerda a quienes pasaron por aquí.*'
  ];

  return lines.join('\n');
}

/**
 * Genera la Crónica Semanal como texto narrativo épico.
 * Usa datos reales de BD: facciones, kills, ascensiones, jugador más letal.
 *
 * @returns {string} — texto de la crónica
 *
 * Llamado desde: generateChronicle() (que también la guarda en BD)
 */
function buildChronicleText() {
  const weekStart = db.getWeekStart();

  // Datos de facciones
  let factionLine = '';
  try {
    const leaders = db.getWeeklyLeaders ? db.getWeeklyLeaders() : [];
    if (leaders.length > 0) {
      const top = leaders[0];
      factionLine = `La ${top.faction_id || top.faction || 'Orden del Filo'} controla el dungeon esta semana.`;
    }
  } catch (_) {}

  // Jugador más letal de la semana (desde player_history_meta)
  let letalLine = '';
  try {
    const activos = db.getCryptCandidates().activos;
    if (activos.length > 0) {
      const top = activos[0];
      if (!isBot(top.username)) {
        letalLine = `${top.username} fue el aventurero más letal esta semana (${top.kills_this_week} kills).`;
      }
    }
  } catch (_) {}

  // Kills al Lich esta semana (desde global_events tipo 'boss')
  let lichKillersLine = '';
  let ascLine = '';
  try {
    // Buscar eventos de kill al Lich desde el inicio de la semana usando query SQL directa
    // (más eficiente que cargar miles de eventos y filtrar en JS)
    const lichEvents = db.getBossEventsSince(weekStart, 'antorchas de la Catedral');

    if (lichEvents.length > 0) {
      // Extraer usernames únicos (el formato es "...cuando USERNAME emergió...")
      const killerNames = [];
      const seen = new Set();
      for (const ev of lichEvents) {
        const match = ev.message.match(/cuando (.+?) emergió/);
        if (match && match[1] && !seen.has(match[1])) {
          seen.add(match[1]);
          killerNames.push(match[1]);
        }
      }
      if (killerNames.length === 1) {
        lichKillersLine = `${killerNames[0]} derrotó al Lich Anciano esta semana — las antorchas de la Catedral se apagaron.`;
      } else if (killerNames.length > 1) {
        const last = killerNames.pop();
        lichKillersLine = `${killerNames.join(', ')} y ${last} derrotaron al Lich esta semana — el dungeon tembló ${lichEvents.length} ${lichEvents.length === 1 ? 'vez' : 'veces'}.`;
      }
    } else {
      lichKillersLine = 'El Lich Anciano permanece invicto esta semana — ningún aventurero logró alcanzarlo.';
    }
  } catch (_) {
    lichKillersLine = 'El Lich Anciano permanece invicto esta semana — ningún aventurero logró alcanzarlo.';
  }

  // Ascensiones recientes
  try {
    const ascendidos = db.getCryptCandidates().ascendidos;
    const recent = ascendidos.filter(a => {
      if (!a.ascended_at) return false;
      const hoursOld = (Date.now() - new Date(a.ascended_at).getTime()) / 3600000;
      return hoursOld < 168; // última semana
    });
    if (recent.length > 0) {
      ascLine = `${recent.length} ${recent.length === 1 ? 'aventurero ascendió' : 'aventureros ascendieron'} desde las profundidades esta semana.`;
    }
  } catch (_) {}

  const parts = [
    `📜 *Crónica del Dungeon — Semana del ${weekStart}*\n`,
    'Los anales del dungeon registran que esta semana:',
    factionLine ? `  • ${factionLine}` : null,
    letalLine ? `  • ${letalLine}` : null,
    lichKillersLine ? `  • ${lichKillersLine}` : null,
    ascLine ? `  • ${ascLine}` : null,
    '\n*El dungeon ha guardado memoria de estos hechos. Las sombras los testifican.*'
  ].filter(Boolean);

  return parts.join('\n');
}

/**
 * Genera la Crónica Semanal, la guarda en BD, y devuelve el texto.
 * Idempotente: si ya existe para esta semana, la sobreescribe.
 *
 * @returns {string} — texto completo de la crónica
 *
 * Llamado desde: engine.js cuando el jugador usa `cronica` en cualquier sala
 */
function generateChronicle() {
  const weekStart = db.getWeekStart();
  const text = buildChronicleText();
  db.upsertChronicle(weekStart, text, {});
  return text;
}

/**
 * Devuelve la Crónica Semanal actual — siempre regenerada en tiempo real.
 * La crónica ahora es reactiva (incluye kill al Lich, facción dominante, etc.),
 * por lo que el caché sería incorrecto. Se regenera en cada consulta y se guarda
 * en BD para historial.
 *
 * @returns {string}
 *
 * Llamado desde: engine.js cuando el jugador usa `cronica`
 */
function getChronicleText() {
  return generateChronicle();
}

/**
 * Devuelve texto de respuesta del anciano según el historial del jugador.
 * 3 variantes: primera vez, veterano (1-2 runs), anciano conocido (3+).
 *
 * @param {string} username
 * @returns {string} — diálogo contextual del anciano
 *
 * Llamado desde: engine.js en el handler del comando `hablar anciano` (sala 1)
 */
function getAncianoDialogo(username) {
  const hist = db.getPlayerHistory(username);
  if (!hist || hist.total_runs <= 1) {
    return '👴 *El anciano te mira con ojos sabios:* "Bienvenido al Dungeon de los Ecos, joven aventurero. Las sombras te han estado esperando. Avanzá con cuidado — cada sala tiene sus secretos."';
  }
  if (hist.total_runs <= 3) {
    return `👴 *El anciano frunce el ceño — algo en tu cara le resulta familiar:* "Vos... estuviste aquí antes. El dungeon lo recuerda aunque vos no. ${hist.total_kills} criaturas caíeron ante vos en total. Qué regresa a buscar esta vez?"`;
  }
  if (hist.total_ascensions > 0) {
    return `👴 *El anciano se pone de pie al verte entrar. Hace una reverencia leve:* "Ascendiste ${hist.total_ascensions} ${hist.total_ascensions === 1 ? 'vez' : 'veces'} ya. El dungeon te conoce como pocos. ${hist.total_kills} kills, ${hist.total_deaths} muertes. Volviste de todas ellas. Las sombras te saludan, veterano."`;
  }
  return `👴 *El anciano asiente sin sorpresa:* "Otra vez. El dungeon te tiene bien fichado — ${hist.total_runs} visitas, ${hist.total_kills} kills. Ya sabés cómo es esto. No necesitás mis consejos. Pero si querés saber qué pasó esta semana, usá 'cronica'."`;
}

/**
 * Hook de muerte de monstruo — acumula stats en BD.
 * Debe llamarse desde combat.js cuando un monstruo muere.
 *
 * @param {number} roomId
 * @param {string} monsterName
 * @param {string} killerUsername — username del jugador (puede ser null si no hay jugador)
 */
function onMonsterKill(roomId, monsterName, killerUsername) {
  db.incrementRoomStat(roomId, monsterName, 'monster_kill');
  if (killerUsername) {
    db.incrementPlayerHistoryKill(killerUsername);
  }
}

/**
 * Hook de muerte de jugador — acumula stats en BD.
 * Debe llamarse desde engine.js cuando hp del jugador llega a 0.
 *
 * @param {number} roomId
 * @param {string} username
 */
function onPlayerDeath(roomId, username) {
  db.incrementRoomStat(roomId, null, 'player_death');
  if (username) {
    db.incrementPlayerHistoryDeath(username);
  }
}

/**
 * Hook de ascensión — acumula stats en BD.
 * Debe llamarse desde engine.js en el flujo de ascensión (junto con createLegacyEntry).
 *
 * @param {string} username
 * @param {number} levelReached
 */
function onAscension(username, levelReached) {
  if (username) {
    db.incrementPlayerHistoryAscension(username, levelReached);
  }
}

/**
 * Hook de creación/recreación de personaje.
 * Debe llamarse desde engine.js cuando se crea un personaje nuevo (incluye post-ascensión).
 *
 * @param {string} username
 */
function onNewRun(username) {
  if (username) {
    db.ensurePlayerHistoryExists(username);
    db.incrementPlayerHistoryRun(username);
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Datos de jugador
  getPlayerHistory,
  getAncianoDialogo,

  // Estadísticas de sala
  getRoomStats,
  getRoomStatsText,

  // Cripta de los Valientes
  getCryptPlaquesText,
  regenerateCryptPlaques,

  // Crónica Semanal
  getChronicleText,
  generateChronicle,

  // Hooks para engine.js / combat.js
  onMonsterKill,
  onPlayerDeath,
  onAscension,
  onNewRun,
};
