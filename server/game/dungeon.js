/**
 * dungeon.js — Capa de acceso al dungeon (habitaciones y sus relaciones)
 *
 * Abstrae el acceso a la BD para las operaciones propias del mapa:
 * - Obtener una habitación con todos sus datos (salidas, ítems, monstruos)
 * - Resolver hacia dónde lleva una salida
 * - Listar qué habitaciones son accesibles desde una dada
 */

'use strict';

const db = require('../db/db');

// Nombres de dirección en español
const DIR_NAMES = {
  north: 'norte',
  south: 'sur',
  east:  'este',
  west:  'oeste',
  up:    'arriba',
  down:  'abajo',
};

// Inversos (para futuras validaciones)
const DIR_OPPOSITE = {
  north: 'south', south: 'north',
  east:  'west',  west:  'east',
  up:    'down',  down:  'up',
};

// Alias en español → inglés (para el parser de comandos)
const DIR_ALIASES = {
  norte: 'north', sur: 'south',
  este:  'east',  oeste: 'west',
  arriba: 'up',   abajo: 'down',
  n: 'north', s: 'south', e: 'east', o: 'west',
  w: 'west',
};

/**
 * Devuelve la habitación completa, incluyendo los monstruos presentes.
 * @param {number} roomId
 * @returns {{ room, monsters } | null}
 */
function getRoomFull(roomId) {
  const room = db.getRoom(roomId);
  if (!room) return null;

  const monsters = db.getMonstersInRoom(roomId);
  return { room, monsters };
}

/**
 * Resuelve la dirección de salida para una habitación.
 * Acepta tanto inglés como español.
 * @param {object} room — objeto Room con exits ya parseado
 * @param {string} direction — puede ser 'north', 'norte', 'n', etc.
 * @returns {number|null} — id de la habitación destino, o null si no existe esa salida
 */
function resolveExit(room, direction) {
  const normalized = normalizeDirection(direction);
  if (!normalized) return null;
  const targetId = room.exits[normalized];
  return targetId !== undefined ? targetId : null;
}

/**
 * Normaliza una dirección a su forma canónica en inglés.
 * @param {string} direction
 * @returns {string|null}
 */
function normalizeDirection(direction) {
  if (!direction) return null;
  const d = direction.toLowerCase().trim();
  // Ya es inglés canónico
  if (DIR_NAMES[d]) return d;
  // Es un alias (español, abreviatura)
  return DIR_ALIASES[d] || null;
}

/**
 * Devuelve un texto con las salidas disponibles de una habitación.
 * Ej: "norte, este"
 * @param {object} room
 * @returns {string}
 */
function exitsText(room) {
  const dirs = Object.keys(room.exits);
  if (dirs.length === 0) return 'ninguna';
  return dirs.map(d => DIR_NAMES[d] || d).join(', ');
}

/**
 * Construye la descripción completa de una habitación para mostrar al jugador.
 * @param {number} roomId
 * @returns {string}
 */
/**
 * describeRoom — Devuelve una descripción textual de la habitación.
 * @param {number} roomId
 * @param {string|null} excludePlayerId — no listar este jugador (el observador)
 */
function describeRoom(roomId, excludePlayerId = null) {
  const data = getRoomFull(roomId);
  if (!data) return 'Esa habitación no existe.';

  const { room, monsters } = data;
  const lines = [];

  lines.push(`\n=== ${room.name.toUpperCase()} ===`);
  lines.push(room.description);

  if (monsters.length > 0) {
    const monsterList = monsters.map(m => {
      const pct = m.max_hp > 0 ? m.hp / m.max_hp : 0;
      const barLen = 10;
      const filled = Math.round(pct * barLen);
      const bar = '[' + '█'.repeat(filled) + '░'.repeat(barLen - filled) + ']';
      // Color indicator: green >=70%, yellow >=30%, red <30%
      const cond = pct >= 0.7 ? '★' : pct >= 0.3 ? '◆' : '☠';
      return `  • ${m.name} ${bar} ${m.hp}/${m.max_hp} HP ${cond}`;
    }).join('\n');
    lines.push(`\nCriaturas:\n${monsterList}`);
  }

  if (room.items.length > 0) {
    lines.push(`\nObjetos en el suelo: ${room.items.join(', ')}`);
  }

  // Otros jugadores presentes (T024)
  const others = db.getPlayersInRoom(roomId)
    .filter(p => p.id !== excludePlayerId);
  if (others.length > 0) {
    const playerList = others.map(p => `  • ${p.username} (HP: ${p.hp}/${p.max_hp})`).join('\n');
    lines.push(`\nJugadores aquí:\n${playerList}`);
  }

  lines.push(`\nSalidas: ${exitsText(room)}`);

  return lines.join('\n');
}

module.exports = {
  getRoomFull,
  resolveExit,
  normalizeDirection,
  exitsText,
  describeRoom,
  DIR_NAMES,
  DIR_OPPOSITE,
  DIR_ALIASES,
};
