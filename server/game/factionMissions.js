/**
 * factionMissions.js — Motor de Misiones de Facción
 *
 * Sistema de misiones semanales rastreables para los miembros de cada facción.
 * Ver diseño completo en: disenos/epic-facciones-schema-misiones.md
 *
 * Epic: Facciones Vivas (iniciado 2026-07-17)
 * Implementado: IMPL-FM-1706
 *
 * Exporta:
 *   generateMission(player)       — genera/recupera la misión de la semana
 *   getMissionForPlayer(player)   — obtiene la misión activa (sin generar)
 *   onEvent(player, type, data)   — hookea eventos del juego al tracker
 */

'use strict';

const db = require('../db/db.js');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Número de semana actual (compatible con el que usa el resto del sistema).
 */
function _weekNumber() {
  return Math.floor(Date.now() / 604800000);
}

/**
 * Calcular target final con scaling por nivel.
 * @param {Object} def — row de faction_mission_definitions
 * @param {number} level
 * @returns {number}
 */
function _calcTarget(def, level) {
  return def.base_target + Math.floor(def.scale_per_level * (Math.max(1, level) - 1));
}

/**
 * LCG determinista (misma que usa questEngine para consistencia).
 * @param {number} seed
 * @returns {number} siguiente seed
 */
function _lcg(seed) {
  return (seed * 1664525 + 1013904223) & 0xffffffff;
}

/**
 * Seleccionar misión del pool usando seed semanal ponderado.
 * @param {Object} player
 * @returns {Object|null} row de faction_mission_definitions o null si no hay pool
 */
function _selectMission(player) {
  const rawDb = db.raw();
  const weekNum = _weekNumber();
  const playerLevel = player.level || 1;

  // Pool elegible: misiones de la facción del jugador, nivel OK, activas
  const result = rawDb.exec(
    `SELECT id, faction, name, description_template, event_hook, target_filter,
            base_target, scale_per_level, reward_xp, reward_gold, reward_influence,
            require_level, priority
     FROM faction_mission_definitions
     WHERE faction = ? AND is_active = 1 AND require_level <= ?
     ORDER BY priority DESC`,
    [player.faction, playerLevel]
  );

  if (!result.length || !result[0].values.length) return null;

  const cols = result[0].columns;
  let pool = result[0].values.map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])));

  // Filtro especial: misión de sala secreta (fm_conclave_sala_secreta)
  // Si el jugador ya visitó esa sala, excluir esa misión (sería trivial)
  pool = pool.filter(m => {
    if (m.id === 'fm_conclave_sala_secreta') {
      try {
        const visited = JSON.parse(player.rooms_visited || '[]');
        return !visited.includes(10);
      } catch (_) {}
    }
    return true;
  });

  if (pool.length === 0) {
    // fallback: usar todas sin filtro
    const cols2 = result[0].columns;
    pool = result[0].values.map(row => Object.fromEntries(cols2.map((c, i) => [c, row[i]])));
  }

  // Construir lista ponderada por priority
  const weighted = [];
  for (const m of pool) {
    for (let i = 0; i < (m.priority || 10); i++) weighted.push(m);
  }

  // Seed determinista: semana + offset del ID del jugador
  const playerSeedOffset = player.id.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  let seed = (weekNum * 31337 + playerSeedOffset) & 0x7fffffff;
  seed = _lcg(seed);

  return weighted[Math.abs(seed) % weighted.length];
}

// ─── API Pública ──────────────────────────────────────────────────────────────

/**
 * Obtener la misión activa del jugador para la semana actual sin generar una nueva.
 *
 * @param {Object} player
 * @returns {Object|null} row de faction_missions JOIN faction_mission_definitions, o null
 */
function getMissionForPlayer(player) {
  if (!player || !player.faction) return null;

  const rawDb = db.raw();
  const weekNum = _weekNumber();

  const result = rawDb.exec(
    `SELECT fm.id, fm.player_id, fm.faction, fm.definition_id, fm.week,
            fm.week_start_iso, fm.target, fm.progress, fm.status,
            fm.reward_claimed, fm.completed_at,
            fmd.name, fmd.description_template, fmd.event_hook,
            fmd.target_filter, fmd.reward_xp, fmd.reward_gold, fmd.reward_influence
     FROM faction_missions fm
     JOIN faction_mission_definitions fmd ON fmd.id = fm.definition_id
     WHERE fm.player_id = ? AND fm.week = ?`,
    [player.id, weekNum]
  );

  if (!result.length || !result[0].values.length) return null;

  const cols = result[0].columns;
  return Object.fromEntries(cols.map((c, i) => [c, result[0].values[0][i]]));
}

/**
 * Generar (o recuperar) la misión de facción del jugador para la semana actual.
 * Si ya existe, la retorna sin tocar nada.
 * Si no tiene facción, retorna null sin crear nada.
 *
 * @param {Object} player
 * @returns {Object|null} misión generada/existente, o null
 */
function generateMission(player) {
  if (!player || !player.faction) return null;
  if (player.is_bot) return null;

  // Si ya hay misión esta semana, devolverla
  const existing = getMissionForPlayer(player);
  if (existing) return existing;

  const rawDb = db.raw();
  const weekNum = _weekNumber();
  const weekStart = new Date(weekNum * 604800000).toISOString();

  const def = _selectMission(player);
  if (!def) return null;

  const target = _calcTarget(def, player.level || 1);

  try {
    rawDb.run(
      `INSERT OR IGNORE INTO faction_missions
         (player_id, faction, definition_id, week, week_start_iso, target, progress, status)
       VALUES (?, ?, ?, ?, ?, ?, 0, 'active')`,
      [player.id, player.faction, def.id, weekNum, weekStart, target]
    );
  } catch (e) {
    console.error('[factionMissions] Error al generar misión:', e.message);
    return null;
  }

  return getMissionForPlayer(player);
}

/**
 * Entregar recompensa de una misión completada.
 * Solo si reward_claimed = 0. Actualiza BD y jugador.
 *
 * @param {Object} player
 * @param {Object} mission — row de faction_missions con campos de definition
 * @returns {string} mensaje de recompensa para mostrar
 */
function _claimReward(player, mission) {
  const rawDb = db.raw();

  // Marcar como reclamada
  rawDb.run(
    `UPDATE faction_missions SET reward_claimed = 1 WHERE id = ?`,
    [mission.id]
  );

  // Otorgar XP y gold
  const updates = {};
  if (mission.reward_xp)   updates.xp   = (player.xp   || 0) + mission.reward_xp;
  if (mission.reward_gold) updates.gold  = (player.gold || 0) + mission.reward_gold;
  if (Object.keys(updates).length) db.updatePlayer(player.id, updates);

  // Otorgar influencia de facción
  if (mission.reward_influence) {
    try { db.addFactionInfluence(player.id, mission.reward_influence); } catch (_) {}
  }

  const parts = [];
  if (mission.reward_xp)       parts.push(`+${mission.reward_xp} ⭐ XP`);
  if (mission.reward_gold)     parts.push(`+${mission.reward_gold} 💰 gold`);
  if (mission.reward_influence) parts.push(`+${mission.reward_influence} 🏴 influencia`);

  return `✅ **¡Misión de facción completada!** "${mission.name}"\nRecompensa: ${parts.join(', ')}`;
}

/**
 * Incrementar progreso de misión de facción en respuesta a un evento del juego.
 *
 * @param {Object} player — objeto jugador completo
 * @param {string} eventType — 'kill' | 'explore_new' | 'examine' | 'explore_room' | 'buy' | 'bid' | 'auction_win'
 * @param {Object} data — datos del evento (monstruo, sala, ítem, etc.)
 * @returns {null | { text: string }}
 */
function onEvent(player, eventType, data = {}) {
  if (!player || player.is_bot) return null;
  if (!player.faction) return null;

  const mission = getMissionForPlayer(player);
  if (!mission) {
    // Generar en background si no existe — lazy generation
    generateMission(player);
    return null;
  }

  // Solo procesar si está activa y no completada
  if (mission.status !== 'active') return null;

  // ¿Este evento es relevante para la misión?
  if (mission.event_hook !== eventType) return null;

  // Verificar filtro de target si existe
  if (mission.target_filter) {
    let filter;
    try { filter = JSON.parse(mission.target_filter); } catch (_) { filter = {}; }

    // Filtro por stance (solo para kills)
    if (filter.stance && eventType === 'kill') {
      const playerStance = (player.stance || '').toLowerCase();
      if (playerStance !== filter.stance.toLowerCase()) return null;
    }

    // Filtro por min_max_hp del monstruo (bosses)
    if (filter.min_max_hp && eventType === 'kill') {
      const monsterMaxHp = data.monster ? (data.monster.max_hp || 0) : 0;
      if (monsterMaxHp < filter.min_max_hp) return null;
    }

    // Filtro por room_id específica
    if (filter.room_id !== undefined && eventType === 'explore_room') {
      if (data.room_id !== filter.room_id) return null;
    }
  }

  // Incrementar progreso
  const rawDb = db.raw();
  const newProgress = (mission.progress || 0) + 1;

  if (newProgress >= mission.target) {
    // ─── Completada ────────────────────────────────────────────────────────
    const now = new Date().toISOString();
    rawDb.run(
      `UPDATE faction_missions SET progress = ?, status = 'completed', completed_at = ? WHERE id = ?`,
      [newProgress, now, mission.id]
    );

    // Actualizar el objeto mission con los nuevos valores antes de reclamar
    mission.progress = newProgress;
    mission.status = 'completed';

    // Recargar jugador para tener gold/xp actualizados antes de sumar
    const freshPlayer = db.getPlayer(player.id) || player;
    const rewardMsg = _claimReward(freshPlayer, mission);
    return { text: rewardMsg };

  } else {
    // ─── Progreso parcial ──────────────────────────────────────────────────
    rawDb.run(
      `UPDATE faction_missions SET progress = ? WHERE id = ?`,
      [newProgress, mission.id]
    );

    // Solo mostrar progreso en kills: cada kill, no cada acción menor
    if (eventType === 'kill' || eventType === 'explore_new' || eventType === 'explore_room') {
      return {
        text: `🏴 Misión "${mission.name}": ${newProgress}/${mission.target} (${eventType === 'kill' ? 'kills' : 'salas'})`
      };
    }
    return null;
  }
}

module.exports = { generateMission, getMissionForPlayer, onEvent };
