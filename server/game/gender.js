'use strict';
/**
 * gender.js — Helpers de género gramatical para monstruos.
 * BUG-1016, BUG-1427: Módulo separado para evitar dependencias circulares
 * entre combat.js y quests.js.
 */

// Por defecto todos los monstruos usan "El"; los listados aquí usan "La".
const MONSTER_GENERO_FEMENINO = new Set([
  'Araña Tejedora',
  'Rata Gigante',
  'Sombra del Vacío',
  'Guardia Espectral', // "La Guardia" es femenino
]);

/**
 * Devuelve el artículo correcto (El/La) para un monstruo.
 * Maneja el prefijo ⭐ de monstruos élite (ej: "⭐ Araña Tejedora").
 * @param {string} name — nombre del monstruo (puede tener prefijo ⭐)
 * @returns {string} — "El" o "La"
 */
function articuloMonstruo(name) {
  const baseName = name.startsWith('⭐') ? name.slice(2).trim() : name;
  return MONSTER_GENERO_FEMENINO.has(baseName) ? 'La' : 'El';
}

/**
 * Devuelve "derrotada" o "derrotado" según el género del monstruo.
 * @param {string} name — nombre del monstruo (puede tener prefijo ⭐)
 * @returns {string} — "derrotado" o "derrotada"
 */
function derrotadoMonstruo(name) {
  const baseName = name.startsWith('⭐') ? name.slice(2).trim() : name;
  return MONSTER_GENERO_FEMENINO.has(baseName) ? 'derrotada' : 'derrotado';
}

module.exports = {
  MONSTER_GENERO_FEMENINO,
  articuloMonstruo,
  derrotadoMonstruo,
};
