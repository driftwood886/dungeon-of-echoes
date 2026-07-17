// challengeAssigner.js — Sistema de asignación diaria de desafíos
// T-1230: Dungeon of Echoes / La Gaceta del Corredor
//
// Asigna determinísticamente 2 desafíos personales + 1 Gran Desafío del Día a cada jugador.
// La asignación es estable durante todo el día (seed SHA256 por player_id + fecha UTC).
// No repite desafíos que ya se asignaron en los últimos 7 días.

'use strict';

const crypto = require('crypto');
const db = require('../db/db');
const { getCombatPool, getExploEconPool, GRAND_CHALLENGE_IDS, getChallengeById } = require('./challengePool');

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades de seed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Genera un número entero en [0, n) a partir de un hash hex (determinístico).
 * Usa los primeros 8 caracteres del hash como base.
 * @param {string} hashHex
 * @param {number} n
 * @returns {number}
 */
function hashToIndex(hashHex, n) {
  const slice = parseInt(hashHex.slice(0, 8), 16);
  return slice % n;
}

/**
 * Genera múltiples índices únicos en [0, n) a partir de un hash, para selección sin repetición.
 * Rota el hash avanzando 8 chars para cada índice adicional.
 * @param {string} hashHex
 * @param {number} n — tamaño del pool
 * @param {number} count — cuántos índices únicos necesitamos
 * @returns {number[]}
 */
function hashToUniqueIndices(hashHex, n, count) {
  const indices = [];
  const used = new Set();
  // Usamos ventanas de 8 chars del hash para cada selección
  for (let i = 0; i < 64 && indices.length < count; i += 8) {
    const slice = hashHex.slice(i, i + 8).padEnd(8, '0');
    const idx = parseInt(slice, 16) % n;
    if (!used.has(idx)) {
      used.add(idx);
      indices.push(idx);
    }
  }
  // Si el hash se agotó y no tenemos suficientes, rellenar secuencialmente
  for (let i = 0; indices.length < count && i < n; i++) {
    if (!used.has(i)) {
      used.add(i);
      indices.push(i);
    }
  }
  return indices;
}

/**
 * Retorna la fecha UTC actual en formato 'YYYY-MM-DD'.
 */
function getTodayUtc() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Genera el week_key para la semana ISO actual, ej: '2026-W27'.
 */
function getCurrentWeekKey() {
  const now = new Date();
  // Obtener el número de semana ISO
  const jan4 = new Date(now.getFullYear(), 0, 4); // 4 Jan siempre está en semana 1
  const week1Monday = new Date(jan4);
  week1Monday.setDate(jan4.getDate() - (jan4.getDay() || 7) + 1);
  const diffMs = now - week1Monday;
  const weekNum = Math.floor(diffMs / (7 * 24 * 3600 * 1000)) + 1;
  return `${now.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

/**
 * Calcula el timestamp del próximo lunes 00:00 UTC (fin de semana ISO).
 */
function getNextMondayUtc() {
  const now = new Date();
  const dayOfWeek = now.getUTCDay(); // 0=Dom, 1=Lun, ..., 6=Sáb
  const daysUntilMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
  const nextMonday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilMonday));
  return nextMonday.toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
// Verificación de anti-repetición (últimos N días)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verifica si un desafío ya fue asignado a un jugador en los últimos N días.
 * Consulta daily_challenge_progress para ver si tiene registros en ese rango.
 * @param {string} playerId
 * @param {string} challengeId
 * @param {number} [lastNDays=7]
 * @returns {boolean}
 */
function hasChallengeBeenAssignedRecently(playerId, challengeId, lastNDays = 7) {
  const today = new Date();
  const dates = [];
  for (let i = 1; i <= lastNDays; i++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  try {
    const placeholders = dates.map(() => '?').join(',');
    const rows = db.raw().exec(
      `SELECT COUNT(*) as cnt FROM daily_challenge_progress WHERE player_id = ? AND challenge_id = ? AND date_utc IN (${placeholders})`,
      [playerId, challengeId, ...dates]
    );
    if (!rows.length || !rows[0].values.length) return false;
    return rows[0].values[0][0] > 0;
  } catch (_) {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Gran Desafío del Día
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determina el Gran Desafío del Día para una fecha UTC dada.
 * Es el mismo para todos los jugadores en ese día.
 * @param {string} dateUtc — formato 'YYYY-MM-DD'
 * @returns {object} — objeto challenge del pool
 */
function getGrandChallengeOfDay(dateUtc) {
  const seed = crypto
    .createHash('sha256')
    .update(dateUtc + 'grand_challenge')
    .digest('hex');
  const idx = hashToIndex(seed, GRAND_CHALLENGE_IDS.length);
  return getChallengeById(GRAND_CHALLENGE_IDS[idx]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Desafío Semanal Colectivo
// ─────────────────────────────────────────────────────────────────────────────

const { WEEKLY_CHALLENGE_IDS } = require('./challengePool');

/**
 * Inicializa el desafío semanal colectivo si no existe para la semana actual.
 * Llama a esto al iniciar el servidor o al hacer login del primer jugador del día.
 */
function ensureWeeklyChallengeInitialized() {
  const weekKey = getCurrentWeekKey();
  const existing = db.getWeeklyChallengeState();
  if (existing && existing.week_key === weekKey) {
    return; // Ya inicializado para esta semana
  }
  // Elegir desafío semanal por seed
  const seed = crypto
    .createHash('sha256')
    .update(weekKey + 'weekly')
    .digest('hex');
  const idx = hashToIndex(seed, WEEKLY_CHALLENGE_IDS.length);
  const challengeId = WEEKLY_CHALLENGE_IDS[idx];
  const challenge = getChallengeById(challengeId);

  // El target viene de la condición del desafío
  const target = challenge.condition.amount;
  const reward = { description: challenge.title, challengeId };
  const expiresAt = getNextMondayUtc();

  db.setWeeklyChallenge(weekKey, challengeId, target, reward, expiresAt);
  console.log(`[challengeAssigner] Desafío semanal ${weekKey}: ${challenge.title} (target: ${target})`);

  // IMPL-WM-1710: también inicializar las 3 Misiones de Guerra si no existen para esta semana
  try {
    db.ensureWarMissionsForWeek();
    console.log(`[challengeAssigner] Misiones de Guerra inicializadas para semana ${weekKey}`);
  } catch (e) {
    console.error('[challengeAssigner] Error al inicializar Misiones de Guerra:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Asignación diaria personal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Obtiene (y si es necesario asigna) los 3 desafíos del día para un jugador:
 *   [0] — Desafío personal de combate
 *   [1] — Desafío personal de exploración o economía
 *   [2] — Gran Desafío del Día (compartido)
 *
 * Cada objeto devuelto incluye el challenge completo + progreso actual:
 * { ...challenge, progress: number, completed: boolean }
 *
 * @param {object} player — objeto player con { id, class, level }
 * @param {string[]} [activeEvents=[]] — IDs de eventos activos en el servidor
 * @returns {object[]} — array de 3 challenges con progreso
 */
function getDailyChallengesForPlayer(player, activeEvents = []) {
  const dateUtc = getTodayUtc();
  const playerId = player.id;

  // ── BUG-1258: Estabilidad de desafíos ante cambios de nivel/clase ──────────
  // Si el jugador sube de nivel o elige clase durante el día, el pool filtrado
  // cambia y los índices hash apuntarían a desafíos distintos — el progreso de
  // desafíos anteriores se perdería silenciosamente.
  // Fix: si ya hay asignaciones persistidas en la BD para hoy, recuperarlas por
  // ID (estables) en lugar de recalcular con el nivel/clase actual.
  const existingRows = db.getDailyChallengeProgress(playerId, dateUtc);
  const existingPersonalIds = existingRows
    .map(r => r.challenge_id)
    .filter(id => !GRAND_CHALLENGE_IDS.includes(id));

  let personalCombat = null;
  let personalExploEcon = null;

  // Intentar recuperar desafíos ya asignados desde la BD
  for (const id of existingPersonalIds) {
    const ch = getChallengeById(id);
    if (!ch) continue;
    if (ch.category === 'combate' && !personalCombat) personalCombat = ch;
    else if ((ch.category === 'exploracion' || ch.category === 'economia') && !personalExploEcon) personalExploEcon = ch;
  }

  // ── Si faltan desafíos personales, calcularlos frescos ────────────────────
  const playerClass = (player.class || player.clase || 'guerrero').toLowerCase();
  const playerLevel = player.level || player.nivel || 1;

  if (!personalCombat) {
    // Seed del jugador para hoy
    const playerSeed = crypto
      .createHash('sha256')
      .update(playerId + dateUtc)
      .digest('hex');

    const combatPool = getCombatPool(playerClass, playerLevel, activeEvents);
    if (combatPool.length > 0) {
      // Intentar 10 índices distintos buscando un desafío no repetido recientemente
      const indices = hashToUniqueIndices(playerSeed, combatPool.length, Math.min(10, combatPool.length));
      for (const idx of indices) {
        const candidate = combatPool[idx];
        if (!hasChallengeBeenAssignedRecently(playerId, candidate.id)) {
          personalCombat = candidate;
          break;
        }
      }
      // Si todos fueron recientes, usar el primero del seed igualmente (7-day cooldown relaxado)
      if (!personalCombat) {
        personalCombat = combatPool[hashToIndex(playerSeed, combatPool.length)];
      }
    }
  }

  if (!personalExploEcon) {
    // Seed alternativo para el segundo desafío
    const seed2 = crypto
      .createHash('sha256')
      .update(playerId + dateUtc + 'explo')
      .digest('hex');

    const exploEconPool = getExploEconPool(playerClass, playerLevel, activeEvents);
    if (exploEconPool.length > 0) {
      const indices2 = hashToUniqueIndices(seed2, exploEconPool.length, Math.min(10, exploEconPool.length));
      for (const idx of indices2) {
        const candidate = exploEconPool[idx];
        if (!hasChallengeBeenAssignedRecently(playerId, candidate.id)) {
          personalExploEcon = candidate;
          break;
        }
      }
      if (!personalExploEcon) {
        personalExploEcon = exploEconPool[hashToIndex(seed2, exploEconPool.length)];
      }
    }
  }

  // ── Desafío 3: Gran Desafío del Día ─────────────────────────────────────
  const grandChallenge = getGrandChallengeOfDay(dateUtc);

  // ── Obtener progreso actual desde BD ────────────────────────────────────
  // (reutilizamos existingRows, ya consultado al inicio)
  const progressMap = {};
  for (const row of existingRows) {
    progressMap[row.challenge_id] = row.count;
  }

  // ── Registrar asignación de hoy si no existe (count=0 indica asignado) ──
  // Esto permite que getDailyChallengeProgress devuelva el challenge aunque count sea 0
  const toRegister = [personalCombat, personalExploEcon, grandChallenge].filter(Boolean);
  for (const ch of toRegister) {
    if (!(ch.id in progressMap)) {
      // Insertar con count=0 si no existe
      try {
        db.raw().run(
          `INSERT OR IGNORE INTO daily_challenge_progress (player_id, challenge_id, count, date_utc) VALUES (?, ?, 0, ?)`,
          [playerId, ch.id, dateUtc]
        );
        progressMap[ch.id] = 0;
      } catch (_) {}
    }
  }

  // ── Armar resultado ──────────────────────────────────────────────────────
  const withProgress = (ch) => {
    if (!ch) return null;
    const count = progressMap[ch.id] || 0;
    return {
      ...ch,
      progress: count,
      completed: count >= ch.condition.amount
    };
  };

  return [
    withProgress(personalCombat),
    withProgress(personalExploEcon),
    withProgress(grandChallenge)
  ].filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  getDailyChallengesForPlayer,
  getGrandChallengeOfDay,
  hasChallengeBeenAssignedRecently,
  ensureWeeklyChallengeInitialized,
  getTodayUtc,
  getCurrentWeekKey
};
