/**
 * questEngine.js — Motor de Quests Dinámicas
 *
 * Sistema de quests generadas/narrativas para Dungeon of Echoes.
 * Ver diseño completo en: disenos/epic-quests-dinamicas.md
 * Ver schema en: disenos/epic-quests-dinamicas-schema.md
 *
 * Epic: EPIC-QD (iniciado 2026-07-14)
 * Tarea actual: IMPL-QD-1573 (stubs), siguiente: IMPL-QD-1574 (assignQuests)
 */

'use strict';

const db = require('../db/db.js');

// ─── Helpers internos ─────────────────────────────────────────────────────────

/**
 * Obtener quests activas de un jugador desde la BD.
 * @param {string} playerId
 * @returns {Array} array de rows de player_quests JOIN quest_definitions
 */
function _getActiveQuests(playerId) {
  // TODO (IMPL-QD-1574): implementar consulta real
  return [];
}

/**
 * Obtener el número de semana actual (para seed determinista de rotación).
 * @returns {number}
 */
function _weekNumber() {
  return Math.floor(Date.now() / 604800000);
}

/**
 * Fisher-Yates shuffle determinista dado un seed numérico.
 * @param {Array} arr
 * @param {number} seed
 * @returns {Array} copia mezclada
 */
function _seededShuffle(arr, seed) {
  const a = [...arr];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    const j = Math.abs(s) % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── API Pública ──────────────────────────────────────────────────────────────

/**
 * Asignar quests al jugador (en login o cuando un slot queda vacío).
 * Los bots (is_bot=1) no reciben quests.
 *
 * TODO (IMPL-QD-1574): implementar lógica completa.
 * @param {Object} player
 * @returns {{ assigned: string[], messages: string[] }}
 */
function assignQuests(player) {
  if (player.is_bot) return { assigned: [], messages: [] };
  // TODO: implementar asignación por slot (principal/secundaria/narrativa)
  return { assigned: [], messages: [] };
}

/**
 * Notificar kill al QuestEngine.
 * Actualiza progreso de quests de tipo 'kill' activas del jugador.
 *
 * TODO (IMPL-QD-1575): implementar.
 * @param {Object} player
 * @param {Object} monster
 * @returns {null | { text: string }}
 */
function onKill(player, monster) {
  if (player.is_bot) return null;
  // TODO: buscar quests kill activas, verificar condición, actualizar progreso
  return null;
}

/**
 * Notificar exploración de sala al QuestEngine.
 * Actualiza progreso de quests de tipo 'explore' activas del jugador.
 *
 * TODO (IMPL-QD-1576): implementar.
 * @param {Object} player
 * @param {number} roomId
 * @returns {null | { text: string }}
 */
function onExplore(player, roomId) {
  if (player.is_bot) return null;
  // TODO: buscar quests explore activas, verificar condición, actualizar progreso
  return null;
}

/**
 * Notificar crafteo al QuestEngine.
 * Actualiza progreso de quests de tipo 'craft' activas del jugador.
 *
 * TODO (IMPL-QD-1578): implementar.
 * @param {Object} player
 * @param {string} itemName
 * @returns {null | { text: string }}
 */
function onCraft(player, itemName) {
  if (player.is_bot) return null;
  // TODO: implementar
  return null;
}

/**
 * Notificar transacción al QuestEngine.
 * Actualiza progreso de quests de tipo 'trade' activas del jugador.
 *
 * TODO (IMPL-QD-1578): implementar.
 * @param {Object} player
 * @param {string} action  - 'buy' | 'sell' | 'auction'
 * @param {number} value   - valor en gold de la transacción
 * @returns {null | { text: string }}
 */
function onTrade(player, action, value) {
  if (player.is_bot) return null;
  // TODO: implementar
  return null;
}

/**
 * Notificar ritual al QuestEngine.
 * Actualiza progreso de quests de tipo 'ritual' activas del jugador.
 *
 * TODO (IMPL-QD-1578): implementar.
 * @param {Object} player
 * @param {string} action  - 'pray' | 'use_bowl' | 'use_altar'
 * @returns {null | { text: string }}
 */
function onRitual(player, action) {
  if (player.is_bot) return null;
  // TODO: implementar
  return null;
}

/**
 * Obtener el display de quests activas del jugador (comando `quests`).
 *
 * TODO (IMPL-QD-1577): implementar display completo.
 * @param {Object} player
 * @returns {{ text: string }}
 */
function getQuestsDisplay(player) {
  if (player.is_bot) return { text: 'Los bots no reciben quests.' };

  // Placeholder hasta implementación real
  const hasFaction = !!player.faction;
  const noFactionHint = hasFaction ? '' :
    '\n💡 Sin facción activa — uniéndote a una, recibirías quests especiales de tu gremio.';

  return {
    text: `📋 **QUESTS ACTIVAS**\n\n(Sistema en construcción — próximamente disponible)${noFactionHint}\n\nPara unirte a una facción: \`facciones\``
  };
}

/**
 * Obtener detalle de una quest por nombre (comando `quest info <nombre>`).
 *
 * TODO (IMPL-QD-1577): implementar.
 * @param {Object} player
 * @param {string} questName
 * @returns {{ text: string }}
 */
function getQuestDetail(player, questName) {
  return { text: `Quest "${questName}": información no disponible aún.` };
}

/**
 * Abandonar una quest activa del jugador.
 *
 * TODO (IMPL-QD-1577): implementar con cooldown.
 * @param {Object} player
 * @param {string} questName
 * @returns {{ text: string }}
 */
function abandonQuest(player, questName) {
  return { text: `No podés abandonar quests aún — el sistema está en construcción.` };
}

/**
 * Obtener historial de quests completadas del jugador.
 *
 * TODO (IMPL-QD-1577): implementar.
 * @param {Object} player
 * @returns {{ text: string }}
 */
function getHistory(player) {
  return { text: `📜 Historial de quests: (sin registros aún)` };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  assignQuests,
  onKill,
  onExplore,
  onCraft,
  onTrade,
  onRitual,
  getQuestsDisplay,
  getQuestDetail,
  abandonQuest,
  getHistory,
  // Internals exportados para testing
  _weekNumber,
  _seededShuffle,
};
