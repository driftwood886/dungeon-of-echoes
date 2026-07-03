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
function exitsText(room, player = null) {
  const dirs = Object.keys(room.exits);
  if (dirs.length === 0) return 'ninguna';
  // BUG-1001: si el jugador ya tiene la llave requerida, mostrar 🔓 en vez de 🔒
  const playerInventory = player
    ? (Array.isArray(player.inventory) ? player.inventory : (() => { try { return JSON.parse(player.inventory || '[]'); } catch(_) { return []; } })())
    : [];
  return dirs.map(d => {
    const exitVal = room.exits[d];
    const requiredKey = (typeof exitVal === 'object' && exitVal !== null) ? exitVal.key : null;
    const label = DIR_NAMES[d] || d;
    if (!requiredKey) return label;
    const hasKey = playerInventory.some(item => item.toLowerCase() === requiredKey.toLowerCase());
    return hasKey ? `${label} 🔓` : `${label} 🔒`;
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
function describeRoom(roomId, excludePlayerId = null, player = null) {
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
  // DIS-1002: Salas con boss — omitir mención del boss en la descripción si ya está muerto
  // Mapa: sala → monsterId del boss que describe la sala
  const BOSS_ROOM_BOSS = { 8: 8 }; // sala 8 → Guardia Espectral (id 8)
  if (BOSS_ROOM_BOSS[room.id] !== undefined) {
    try {
      const bossId = BOSS_ROOM_BOSS[room.id];
      const bossMonster = db.getMonster(bossId);
      const bossIsDead = !bossMonster || bossMonster.hp <= 0 || bossMonster.room_id === null;
      if (bossIsDead && room.id === 8) {
        // Descripción alternativa cuando el Guardia ya fue derrotado
        roomDesc = 'Celdas de hierro corroído bordean las paredes. Las rejas están abiertas — algo estuvo aquí encerrado por mucho tiempo, y finalmente salió. El aire huele a miedo viejo. El guardia ya no está. Las sombras están quietas por primera vez en quien sabe cuánto tiempo. (Podés usar examine celdas para más detalles.)';
      }
    } catch (_) { /* no romper describeRoom si falla */ }
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
          const timeStr = mins > 0
            ? (secs > 0 ? `${mins}m ${secs}s` : `${mins}min`)
            : `${secs}s`;
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

  lines.push(`\nSalidas: ${exitsText(room, player)}`);

  // DIS-D38: si alguna salida da a una sala con trampa activa, mostrar aviso preventivo
  // BUG-931: si el jugador ya conoce la trampa (known_traps), omitir el hint
  const knownTraps = (() => {
    if (!player) return {};
    try {
      return typeof player.known_traps === 'string'
        ? JSON.parse(player.known_traps || '{}')
        : (player.known_traps || {});
    } catch (_) { return {}; }
  })();
  const trapHints = [];
  for (const [dir, exitVal] of Object.entries(room.exits || {})) {
    const adjId = typeof exitVal === 'object' && exitVal !== null ? exitVal.room_id : exitVal;
    if (!adjId) continue;
    const adjRoom = db.getRoom(adjId);
    if (adjRoom && adjRoom.trap && adjRoom.trap.active) {
      // Si el jugador ya conoce esta trampa, no mostrar el hint (ya sabe de qué se trata)
      if (knownTraps[String(adjId)] === true) continue;
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
    // DIS-1097: hint sobre acceso a la Casa de Subastas sin pelear
    lines.push(`\n🏛️ Pista: Al norte de esta sala (Prisión) podés acceder a la Casa de Subastas (sala 17).\n   Los espectros de la Prisión dejan pasar si no los provocás — movete sin atacar.`);
  }

  // DIS-D48: Cuenco Sagrado en sala 5 (Capilla Olvidada)
  // DIS-1180: si el jugador tiene HP bajo (<60%), destacar el cuenco con más urgencia
  if (roomId === 5) {
    const playerHp = player ? player.hp : null;
    const playerMaxHp = player ? player.max_hp : null;
    const hpPct = (playerHp !== null && playerMaxHp) ? (playerHp / playerMaxHp) : 1;
    // Check cooldown del cuenco (el mapa de cooldowns está en engine.js — aquí usamos lore estático)
    if (hpPct < 0.6) {
      lines.push(`\n💧 ¡ATENCIÓN — HP bajo! El cuenco de piedra negra del altar puede curarte.\n   ("cuenco" o "beber" — recupera 40% HP, cooldown personal 5 min)`);
    } else {
      lines.push(`\n🙏 En el centro de la sala hay un cuenco de piedra negra lleno de agua fría.\n   ("cuenco" para beber — recupera 40% HP, cooldown personal 5 min)`);
    }
  }

  // DIS-D344: Pista ruta alternativa ya incluida en la descripción de la sala 7 (seed.js)
  // No agregar mensaje extra aquí para evitar duplicación.

  // Mensajes en las paredes (T147)
  const wallMsgs = db.getWallMessages(roomId);
  if (wallMsgs.length > 0) {
    lines.push(`\n✍️ Alguien ha dejado inscripciones en la pared. (Escribí "read" para leerlas.)`);
  }

  // EPIC-MR-1085: Texto ambiental de World State colectivo
  try {
    const wsText = getWorldStateRoomText(roomId);
    if (wsText) {
      lines.push(`\n${wsText}`);
    }
  } catch (_) { /* no romper look si falla */ }

  return lines.join('\n');
}

// ─── EPIC-MR-1085: Texto ambiental de World State colectivo ──────────────────

/**
 * Devuelve texto ambiental basado en el estado colectivo del dungeon (world_state).
 * Retorna string con el texto o null si no hay nada que mostrar.
 * @param {number} roomId
 * @returns {string|null}
 */
function getWorldStateRoomText(roomId) {
  // Solo salas afectadas: 2, 3, 4, 6, 7, 14, 15
  const AFFECTED_ROOMS = new Set([2, 3, 4, 6, 7, 14, 15]);
  if (!AFFECTED_ROOMS.has(roomId)) return null;

  // Leer las claves relevantes según sala
  const KEY_MAP = {
    2:  ['goblins_semana'],
    3:  ['subastas_semana'],
    4:  ['esqueletos_semana'],
    6:  ['items_crafteados_semana'],
    7:  ['aranas_semana'],
    14: ['lich_derrotado_semana'],
    15: ['lich_last_kill_ts'],
  };
  const keysToRead = KEY_MAP[roomId] || [];
  const ws = db.getWorldStateValues(keysToRead);

  switch (roomId) {
    case 2: { // Corredor de las Sombras — goblins
      const v = ws.goblins_semana || 0;
      if (v >= 10) return '🌫️ El corredor huele menos a goblin que de costumbre. La semana ha sido activa.';
      return null;
    }
    case 3: { // Sala de los Ecos — subastas (escriba)
      const v = ws.subastas_semana || 0;
      if (v === 0) return '📜 El escriba tiene los brazos cruzados. «Nadie subastó nada esta semana», dice sin que le preguntes. «El mercado duerme.»';
      if (v >= 5) return `📜 La pluma del escriba no para. «Buena semana», dice mientras escribe. «${v} transacciones. El dungeon está activo.»`;
      return null; // 1-4: actividad normal, sin texto extra
    }
    case 4: { // Cámara del Tesoro — esqueletos
      const v = ws.esqueletos_semana || 0;
      if (v >= 20) return '💀 Alguien redecoró. Los esqueletos fueron destruidos tantas veces esta semana que el suelo cruje diferente.';
      if (v >= 8)  return '💀 Los huesos del suelo están más recientes de lo normal. No son los de siempre.';
      return null;
    }
    case 6: { // Túnel de los Hongos — crafteo
      const v = ws.items_crafteados_semana || 0;
      if (v >= 15) return '⚗️ El túnel tiene un aroma denso y químico. Esta semana, los alquimistas del dungeon estuvieron muy ocupados.';
      if (v >= 5)  return '⚗️ El olor a hierbas procesadas es más fuerte de lo habitual. Alguien estuvo cocinando pociones.';
      return null;
    }
    case 7: { // Pozo Sin Fondo — arañas
      const v = ws.aranas_semana || 0;
      if (v >= 30) return '🕷️ El nido está casi en silencio. Apenas quedan rastros de tela de araña — los aventureros limpiaron bien. Los huevos, sin embargo, siguen ahí.';
      if (v >= 10) return '🕷️ El nido está más tranquilo de lo usual. Alguien ha estado cazando en este corredor.';
      return null;
    }
    case 14: { // Coliseo de Huesos — lich derrotado
      const v = ws.lich_derrotado_semana || 0;
      if (v >= 3) return `💀 Las inscripciones muestran múltiples marcas frescas. ${v} veces llegaron hasta el Lich esta semana.`;
      if (v >= 1) return '💀 Las inscripciones en las columnas cambian según el ciclo. Esta semana, alguien llegó hasta el final.';
      return null;
    }
    case 15: { // Catedral de la Oscuridad — ventana de tiempo del Lich
      const ts = ws.lich_last_kill_ts || 0;
      if (ts === 0) return null;
      const msAgo = Date.now() - ts;
      const TWO_HOURS = 2 * 60 * 60 * 1000;
      const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
      if (msAgo < TWO_HOURS) {
        return '⚡ El suelo todavía está caliente. Llegaste apenas después que otro.';
      }
      if (msAgo < TWENTY_FOUR_HOURS) {
        return '✨ Una energía residual impregna el aire — el ritual de muerte fue reciente. Podés sentir el eco del combate en las piedras.';
      }
      return null;
    }
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────


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
