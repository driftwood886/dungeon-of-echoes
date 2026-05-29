/**
 * achievements.js — Sistema de logros (T084)
 *
 * Logros se guardan como array JSON en la columna `achievements` de players.
 * Se evalúan después de cada acción relevante.
 *
 * Contexto (ctx) que se puede pasar para logros de evento puntual:
 *   - ctx.bossKill      (boolean) → acaba de matar al Lich
 *   - ctx.poisonSurvived (boolean) → el veneno se disipó (sobrevivió)
 *   - ctx.boughtSomething (boolean) → acaba de comprar en la tienda
 */

'use strict';

const db = require('../db/db');

// ─── Catálogo de logros ────────────────────────────────────────────────────────

const ACHIEVEMENTS = [
  {
    id: 'primer_kill',
    icon: '🗡️',
    name: 'Primer Kill',
    desc: 'Derrotar al primer enemigo del dungeon',
    check: (p, _ctx) => (p.kills || 0) >= 1,
  },
  {
    id: 'diez_kills',
    icon: '⚔️',
    name: 'Asesino en Serie',
    desc: 'Derrotar 10 enemigos',
    check: (p, _ctx) => (p.kills || 0) >= 10,
  },
  {
    id: 'cien_kills',
    icon: '💀',
    name: 'Masacre Total',
    desc: 'Derrotar 100 enemigos',
    check: (p, _ctx) => (p.kills || 0) >= 100,
  },
  {
    id: 'nivel_5',
    icon: '🌟',
    name: 'Aventurero Veterano',
    desc: 'Alcanzar el nivel 5',
    check: (p, _ctx) => (p.level || 1) >= 5,
  },
  {
    id: 'nivel_10',
    icon: '🏆',
    name: 'Héroe Legendario',
    desc: 'Alcanzar el nivel 10',
    check: (p, _ctx) => (p.level || 1) >= 10,
  },
  {
    id: 'boss_killer',
    icon: '👑',
    name: 'Cazador de Lich',
    desc: 'Derrotar al Lich Anciano en la Catedral de la Oscuridad',
    check: (_p, ctx) => !!(ctx && ctx.bossKill),
  },
  {
    id: 'rico',
    icon: '💰',
    name: 'Cofre Lleno',
    desc: 'Acumular 100 monedas de oro',
    check: (p, _ctx) => (p.gold || 0) >= 100,
  },
  {
    id: 'sobrevivir_veneno',
    icon: '🧪',
    name: 'Sangre Contaminada',
    desc: 'Sobrevivir al veneno en combate (esperar a que se disipe)',
    check: (_p, ctx) => !!(ctx && ctx.poisonSurvived),
  },
  {
    id: 'muerto_3veces',
    icon: '🪦',
    name: 'Tres Vidas',
    desc: 'Morir 3 veces (¡y seguir luchando!)',
    check: (p, _ctx) => (p.deaths || 0) >= 3,
  },
  {
    id: 'comerciante',
    icon: '🛒',
    name: 'Comprador Habitual',
    desc: 'Comprar algo en la tienda del Mercader Aldric',
    check: (_p, ctx) => !!(ctx && ctx.boughtSomething),
  },
];

// ─── checkAchievements ─────────────────────────────────────────────────────────

/**
 * Evalúa todos los logros para el jugador dado y persiste los nuevos.
 *
 * @param {object} player — objeto jugador (con `achievements` como string JSON o null)
 * @param {object} [ctx]  — contexto de evento (bossKill, poisonSurvived, boughtSomething)
 * @returns {Array<{id, icon, name, desc}>} — lista de logros NUEVAMENTE desbloqueados
 */
function checkAchievements(player, ctx = {}) {
  const current = JSON.parse(player.achievements || '[]');
  const newOnes = [];

  for (const ach of ACHIEVEMENTS) {
    if (!current.includes(ach.id) && ach.check(player, ctx)) {
      current.push(ach.id);
      newOnes.push(ach);
    }
  }

  if (newOnes.length > 0) {
    db.updatePlayer(player.id, { achievements: JSON.stringify(current) });
  }

  return newOnes;
}

/**
 * Devuelve los logros ya desbloqueados del jugador (objetos completos).
 *
 * @param {object} player
 * @returns {Array<{id, icon, name, desc}>}
 */
function getPlayerAchievements(player) {
  const current = JSON.parse(player.achievements || '[]');
  return ACHIEVEMENTS.filter(a => current.includes(a.id));
}

/**
 * Formatea los logros de un jugador como texto para mostrar en status/logros.
 *
 * @param {object} player
 * @returns {string}
 */
function formatAchievements(player) {
  const earned = getPlayerAchievements(player);
  if (earned.length === 0) {
    return 'Aún no tenés ningún logro. ¡Seguí explorando!';
  }
  const lines = earned.map(a => `  ${a.icon} ${a.name} — ${a.desc}`);
  return `Logros (${earned.length}/${ACHIEVEMENTS.length}):\n${lines.join('\n')}`;
}

/**
 * Formatea los logros como íconos compactos para el sidebar/status.
 *
 * @param {object} player
 * @returns {string}  e.g. "🗡️ ⚔️ 🌟"
 */
function formatAchievementIcons(player) {
  const earned = getPlayerAchievements(player);
  if (earned.length === 0) return '—';
  return earned.map(a => a.icon).join(' ');
}

/**
 * Formatea las líneas de notificación de logros nuevos para insertar en la respuesta.
 *
 * @param {Array<{icon, name, desc}>} newOnes
 * @returns {string}
 */
function formatNewAchievements(newOnes) {
  if (!newOnes || newOnes.length === 0) return '';
  return newOnes
    .map(a => `\n🏅 ¡LOGRO DESBLOQUEADO! ${a.icon} "${a.name}" — ${a.desc}`)
    .join('');
}

module.exports = {
  ACHIEVEMENTS,
  checkAchievements,
  getPlayerAchievements,
  formatAchievements,
  formatAchievementIcons,
  formatNewAchievements,
};
