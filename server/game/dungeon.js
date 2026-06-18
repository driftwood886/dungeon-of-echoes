/**
 * dungeon.js — Capa de acceso al dungeon (habitaciones y sus relaciones)
 *
 * Abstrae el acceso a la BD para las operaciones propias del mapa:
 * - Obtener una habitación con todos sus datos (salidas, ítems, monstruos)
 * - Resolver hacia dónde lleva una salida
 * - Listar qué habitaciones son accesibles desde una dada
 */

'use strict';

const db      = require('../db/db');
const ambient = require('./ambient');
const weather = require('./weather'); // T166: clima del dungeon
const items   = require('./items');

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
 * @returns {{ targetId: number, key: string|null } | null}
 *   - targetId: id de la habitación destino
 *   - key: nombre del ítem requerido para pasar (null si está libre)
 */
function resolveExit(room, direction) {
  const normalized = normalizeDirection(direction);
  if (!normalized) return null;
  const exitVal = room.exits[normalized];
  if (exitVal === undefined || exitVal === null) return null;

  // Soporte backward-compatible:
  // Formato viejo: exits.north = 3  (número)
  // Formato nuevo: exits.north = { room_id: 3, key: "llave oxidada" }
  if (typeof exitVal === 'number') {
    return { targetId: exitVal, key: null };
  }
  if (typeof exitVal === 'object') {
    return { targetId: exitVal.room_id, key: exitVal.key || null };
  }
  return null;
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
 * Las salidas con llave se muestran con 🔒.
 * Ej: "norte, este 🔒"
 * @param {object} room
 * @returns {string}
 */
function exitsText(room) {
  const dirs = Object.keys(room.exits);
  if (dirs.length === 0) return 'ninguna';
  return dirs.map(d => {
    const exitVal = room.exits[d];
    const isLocked = typeof exitVal === 'object' && exitVal !== null && exitVal.key;
    const label = DIR_NAMES[d] || d;
    return isLocked ? `${label} 🔒` : label;
  }).join(', ');
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
  // BUG-602: La descripción de sala 7 (Pozo Sin Fondo) verifica si la puerta norte ya fue desbloqueada
  let roomDesc = room.description;
  if (room.id === 7) {
    const northExit = room.exits ? room.exits['north'] : undefined;
    const puertaAbierta = northExit !== undefined && northExit !== null && typeof northExit !== 'object';
    if (puertaAbierta) {
      roomDesc = 'Un pozo en el centro de la sala emite un viento frío desde las profundidades. Una cuerda cuelga al borde. ¿Qué habrá abajo? Al norte, la puerta de hierro macizo está abierta 🔓 —la llave oxidada hizo su trabajo. El Santuario Profano te espera al otro lado.';
    }
  }
  lines.push(roomDesc);

  // Texto ambiental dinámico (T096)
  const ambientLine = ambient.getAmbientText(room);
  if (ambientLine) {
    lines.push(`\n🌫️ ${ambientLine}`);
  }

  // T168: Mini-evento narrativo (15% de chance, inocuo, pura atmósfera)
  const narrativeEvent = ambient.getNarrativeEvent(room);
  if (narrativeEvent) {
    lines.push(`\n💭 ${narrativeEvent}`);
  }

  if (monsters.length > 0) {
    // T166: Niebla densa — ocultar HP de los monstruos
    const foggy = weather.isFoggy();
    const monsterList = monsters.map(m => {
      if (foggy) {
        return `  • ${m.name} [🌁 oculto por la niebla]`;
      }
      const pct = m.max_hp > 0 ? m.hp / m.max_hp : 0;
      const barLen = 10;
      const filled = Math.round(pct * barLen);
      const bar = '[' + '█'.repeat(filled) + '░'.repeat(barLen - filled) + ']';
      // Color indicator: green >=70%, yellow >=30%, red <30%
      const cond = pct >= 0.7 ? '★' : pct >= 0.3 ? '◆' : '☠';
      // BUG-696: indicador explícito de versión élite para que el jugador entienda por qué tiene más HP
      const eliteNote = m.name.startsWith('⭐ ') ? ' ⚡ÉLITE' : '';
      return `  • ${m.name} ${bar} ${m.hp}/${m.max_hp} HP ${cond}${eliteNote}`;
    }).join('\n');
    lines.push(`\nCriaturas:\n${monsterList}`);
  } else {
    // DIS-508: mostrar criaturas en respawn para dar contexto al jugador
    try {
      const deadHere = db.getDeadMonstersForRoom(roomId);
      if (deadHere.length > 0) {
        const respawnList = deadHere.map(m => {
          const secsLeft = m.respawn_at
            ? Math.max(0, Math.ceil((new Date(m.respawn_at) - Date.now()) / 1000))
            : 0;
          const mins = Math.floor(secsLeft / 60);
          const secs = secsLeft % 60;
          const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
          return `  • ${m.name} (vuelve en ~${timeStr})`;
        }).join('\n');
        lines.push(`\n💀 La sala está vacía — los monstruos volverán:\n${respawnList}`);
      }
    } catch (_) { /* no romper look si falla */ }
  }

  if (room.items.length > 0) {
    const itemList = room.items.map(item => {
      const emoji = items.getRarityEmoji(item);
      const rarity = items.getItemRarity(item);
      const rarityTag = rarity !== 'común' ? ` [${rarity}]` : '';
      return `${emoji} ${item}${rarityTag}`;
    }).join(', ');
    lines.push(`\nObjetos en el suelo: ${itemList}`);
  }

  // Otros jugadores presentes (T024)
  const others = db.getPlayersInRoom(roomId)
    .filter(p => p.id !== excludePlayerId);
  if (others.length > 0) {
    const playerList = others.map(p => {
      const petTag = p.pet ? ` 🐾(${p.pet})` : '';
      return `  • ${p.username}${petTag} (HP: ${p.hp}/${p.max_hp})`;
    }).join('\n');
    lines.push(`\nJugadores aquí:\n${playerList}`);
  }

  lines.push(`\nSalidas: ${exitsText(room)}`);

  // DIS-D38: si alguna salida da a una sala con trampa activa, mostrar aviso preventivo
  const trapHints = [];
  for (const [dir, exitVal] of Object.entries(room.exits || {})) {
    const adjId = typeof exitVal === 'object' && exitVal !== null ? exitVal.room_id : exitVal;
    if (!adjId) continue;
    const adjRoom = db.getRoom(adjId);
    if (adjRoom && adjRoom.trap && adjRoom.trap.active) {
      trapHints.push(`${DIR_NAMES[dir] || dir}: marcas de mecanismo sospechosas en el umbral (podés escribir "desactivar trampa ${DIR_NAMES[dir] || dir}" para neutralizarla sin entrar)`);
    }
  }
  if (trapHints.length > 0) {
    lines.push(`\n🔍 Observás: ${trapHints.join('; ')}.`);
  }

  // Indicador de trampa activa
  if (room.trap && room.trap.active) {
    lines.push(`\n⚠️  Esta sala tiene una trampa activa. Escribí "desactivar trampa" con el ítem correcto.`);
  }

  // NPC Mercader en sala 4
  if (roomId === 4) {
    lines.push(`\n🏪 Aldric el Mercader está aquí, sentado detrás de un improvisado mostrador de cajas.\n   "Bienvenido. Escribí 'tienda' para ver mis artículos."`);
  }

  // DIS-D48: Cuenco Sagrado en sala 5 (Capilla Olvidada)
  if (roomId === 5) {
    lines.push(`\n🙏 En el centro de la sala hay un cuenco de piedra negra lleno de agua fría.\n   ("cuenco" para beber — recupera 40% HP, cooldown personal 5 min)`);
  }

  // DIS-D344: Pista ruta alternativa ya incluida en la descripción de la sala 7 (seed.js)
  // No agregar mensaje extra aquí para evitar duplicación.

  // Mensajes en las paredes (T147)
  const wallMsgs = db.getWallMessages(roomId);
  if (wallMsgs.length > 0) {
    lines.push(`\n✍️ Alguien ha dejado inscripciones en la pared. (Escribí "read" para leerlas.)`);
  }

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
