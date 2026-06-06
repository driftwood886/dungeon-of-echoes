/**
 * xp.js — Sistema de curva de XP/nivel (DIS-D282)
 *
 * Reemplaza la fórmula lineal "nivel = floor(xp/50) + 1" por una curva
 * cuadrática que hace que los niveles altos sean progresivamente más costosos.
 *
 * Fórmula:
 *   xpForLevel(L) = 10*(L-1)^2 + 40*(L-1)
 *
 * Costo incremental por nivel (de L a L+1):
 *   20*L + 30
 *
 * Ejemplos:
 *   Nivel 1 → 0 XP total
 *   Nivel 2 → 50 XP total     (+50)
 *   Nivel 3 → 120 XP total    (+70)
 *   Nivel 5 → 320 XP total    (+110)
 *   Nivel 9 → 960 XP total    (+170)
 *   Nivel 10 → 1170 XP total  (+210)
 *   Nivel 15 → 3220 XP total  (+310)
 *   Nivel 20 → 7220 XP total  (+410)
 *
 * Un boss que da 315 XP en nivel 9 → sube a nivel 10 (no 7 niveles de una).
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
  return 10 * t * t + 40 * t;
}

/**
 * Nivel del jugador dado su XP total acumulada.
 * Inverso de xpForLevel.
 * @param {number} xp — XP total (≥ 0)
 * @returns {number} — nivel (mínimo 1, máximo MAX_LEVEL)
 */
function levelFromXp(xp) {
  if (xp <= 0) return 1;
  // Despejando: 10t² + 40t = xp → (t+2)² = xp/10 + 4 → t = sqrt(xp/10+4) - 2
  const level = Math.floor(Math.sqrt(xp / 10 + 4) - 2) + 1;
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
  return 20 * level + 30;
}

module.exports = { levelFromXp, xpForLevel, xpIntoLevel, xpForNextLevel, MAX_LEVEL };
