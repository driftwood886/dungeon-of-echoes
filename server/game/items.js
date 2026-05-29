/**
 * items.js — Definición y lógica de ítems
 *
 * Cubre T017.
 *
 * Los ítems son representados como strings en el juego (en inventario y suelo).
 * Este módulo centraliza:
 *   - Catálogo de ítems conocidos con sus efectos
 *   - Funciones para resolver qué hace un ítem al usarse
 */

'use strict';

// ─── Catálogo de ítems ────────────────────────────────────────────────────────
//
// Tipos:
//   - potion: restaura HP
//   - weapon: aumenta ataque del jugador mientras lo usa
//   - misc:   sin efecto mecánico directo (coleccionables, lore)

const ITEM_CATALOG = {
  // Pociones
  'poción de salud':     { type: 'potion', effect: 'heal', amount: 15, description: 'Una pequeña poción rojiza que restaura 15 HP.' },
  'poción de vida':      { type: 'potion', effect: 'heal', amount: 25, description: 'Una poción grande que restaura 25 HP.' },
  'poción menor':        { type: 'potion', effect: 'heal', amount: 8,  description: 'Una poción débil. Restaura 8 HP.' },

  // Armas
  'espada oxidada':      { type: 'weapon', effect: 'attack_bonus', amount: 3,  description: 'Una espada vieja con filo irregular. +3 de ataque.' },
  'cuchillo oxidado':    { type: 'weapon', effect: 'attack_bonus', amount: 1,  description: 'Un cuchillo pequeño y oxidado. +1 de ataque.' },
  'espada larga':        { type: 'weapon', effect: 'attack_bonus', amount: 5,  description: 'Una espada bien balanceada. +5 de ataque.' },
  'cristal mágico':      { type: 'weapon', effect: 'attack_bonus', amount: 7,  description: 'Un cristal que amplifica la fuerza. +7 de ataque.' },
  'piedra de poder':     { type: 'weapon', effect: 'attack_bonus', amount: 4,  description: 'Vibra levemente en tu mano. +4 de ataque.' },

  // Misc / coleccionables
  'antorcha':            { type: 'misc', description: 'Una antorcha encendida. Ilumina los pasillos oscuros.' },
  'libro viejo':         { type: 'misc', description: 'Un grimorio con páginas incomprensibles.' },
  'cuerda':              { type: 'misc', description: 'Una cuerda resistente de unos 10 metros.' },
  'llave oxidada':       { type: 'misc', description: 'Una llave pequeña y oxidada. ¿Qué abrirá?' },
  'amuleto oscuro':      { type: 'misc', description: 'Un amuleto con una gema negra. Irradia una energía extraña.' },
  'monedas de cobre':    { type: 'misc', description: 'Unas pocas monedas de cobre gastadas.' },
  'monedas de plata':    { type: 'misc', description: 'Monedas de plata con inscripciones antiguas.' },
  'pelaje áspero':       { type: 'misc', description: 'El pelaje de una rata gigante. Áspero al tacto.' },
  'escudo roto':         { type: 'misc', description: 'Un escudo con el centro partido. Inútil para defenderse.' },
  'esencia etérea':      { type: 'misc', description: 'Una esencia brumosa dentro de un frasco. Resuena con el más allá.' },
};

// ─── Funciones públicas ───────────────────────────────────────────────────────

/**
 * Obtiene la definición de un ítem del catálogo.
 * Acepta coincidencia parcial case-insensitive.
 * @param {string} name
 * @returns {object|null} { type, effect, amount, description } o null
 */
function getItemDef(name) {
  const key = name.toLowerCase().trim();
  // Coincidencia exacta
  if (ITEM_CATALOG[key]) return { name: key, ...ITEM_CATALOG[key] };
  // Coincidencia parcial
  const found = Object.keys(ITEM_CATALOG).find(k => k.includes(key) || key.includes(k));
  if (found) return { name: found, ...ITEM_CATALOG[found] };
  return null;
}

/**
 * Busca un ítem en la lista dada (inventario o suelo) por nombre parcial.
 * @param {string[]} itemList
 * @param {string} query
 * @returns {string|null} el nombre exacto del ítem si se encuentra
 */
function findItem(itemList, query) {
  const q = query.toLowerCase().trim();
  return itemList.find(item => item.toLowerCase().includes(q)) || null;
}

/**
 * Devuelve una descripción del ítem.
 * @param {string} name
 * @returns {string}
 */
function describeItem(name) {
  const def = getItemDef(name);
  if (def) return def.description;
  return `Un objeto misterioso llamado "${name}".`;
}

module.exports = {
  ITEM_CATALOG,
  getItemDef,
  findItem,
  describeItem,
};
