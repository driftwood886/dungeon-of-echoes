/**
 * xp.js — Sistema de curva de XP/nivel (DIS-D282, ajustado DIS-1433)
 *
 * Fórmula ajustada (DIS-1433): curva más lenta en niveles bajos para que
 * el jugador llegue a nivel 5 (especialización) con más exploración (~15
 * combates en vez de ~10), dando tiempo a entender su clase.
 *
 * DIS-1583: XP de exploración escalonada para reducir grind inicial.
 * Las primeras 5 salas exploradas dan 10 XP c/u (50 XP total de exploración
 * en las salas iniciales), el resto dan 3 XP. Con kills de ~16-30 XP, el
 * jugador alcanza nivel 2 (60 XP) en 2-3 kills + exploración, y nivel 3
 * (150 XP) en ~5-6 kills + exploración de las primeras salas.
 * Nivel 3 → acceso a facciones y quests.
 *
 * Fórmula:
 *   xpForLevel(L) = 15*(L-1)^2 + 45*(L-1)
 *
 * Costo incremental por nivel (de L a L+1):
 *   30*L + 30
 *
 * Ejemplos:
 *   Nivel 1 → 0 XP total
 *   Nivel 2 → 60 XP total     (+60)
 *   Nivel 3 → 150 XP total    (+90)
 *   Nivel 5 → 420 XP total    (+150)
 *   Nivel 9 → 1200 XP total   (+270)
 *   Nivel 10 → 1470 XP total  (+330) [era: 1170]
 *   Nivel 15 → 4200 XP total  (+480)
 *   Nivel 20 → 9690 XP total  (+630)
 *
 * Monstruo temprano típico (15 HP → 30 XP): llegar a nivel 5 requiere
 * ~14-15 monstruos en vez de 10-11.
 */

'use strict';

const MAX_LEVEL = 20;

/**
 * XP total acumulada necesaria para llegar al nivel L.
 * @param {number} L — nivel objetivo (≥ 1)
 * @returns {number}
 */
function xpForLevel(L) {
  if (L <= 1) return 0;
  const t = L - 1;
  return 15 * t * t + 45 * t;
}

/**
 * Nivel del jugador dado su XP total acumulada.
 * Inverso de xpForLevel.
 * @param {number} xp — XP total (≥ 0)
 * @returns {number} — nivel (mínimo 1, máximo MAX_LEVEL)
 */
function levelFromXp(xp) {
  if (xp <= 0) return 1;
  // Despejando: 15t² + 45t = xp → t = (-45 + sqrt(45² + 4*15*xp)) / (2*15)
  const t = (-45 + Math.sqrt(45 * 45 + 4 * 15 * xp)) / (2 * 15);
  const level = Math.floor(t) + 1;
  return Math.min(level, MAX_LEVEL);
}

/**
 * XP gastada dentro del nivel actual (cuánto llevas de progreso hacia el siguiente).
 * @param {number} xp — XP total
 * @param {number} level — nivel actual (calculado con levelFromXp)
 * @returns {number}
 */
function xpIntoLevel(xp, level) {
  return xp - xpForLevel(level);
}

/**
 * XP necesaria para pasar del nivel L al L+1.
 * = 20*L + 30
 * @param {number} level — nivel actual
 * @returns {number}
 */
function xpForNextLevel(level) {
  if (level >= MAX_LEVEL) return Infinity;
  return 30 * level + 30;
}

module.exports = { levelFromXp, xpForLevel, xpIntoLevel, xpForNextLevel, MAX_LEVEL };
