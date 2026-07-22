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
const eventScheduler = require('./eventScheduler'); // DIS-1451: Marea Espectral en lista de criaturas

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
  // BUG-1496: también verificar el flag used_key_* para puertas que ya cruzó con llave consumida
  const playerSE = player
    ? (() => { try { const s = player.status_effects; if (!s) return {}; if (typeof s === 'object' && !Array.isArray(s)) return s; return JSON.parse(s); } catch(_) { return {}; } })()
    : {};
  return dirs.map(d => {
    const exitVal = room.exits[d];
    const requiredKey = (typeof exitVal === 'object' && exitVal !== null) ? exitVal.key : null;
    const label = DIR_NAMES[d] || d;
    if (!requiredKey) return label;
    const hasKey = playerInventory.some(item => item.toLowerCase() === requiredKey.toLowerCase());
    if (hasKey) return `${label} 🔓`;
    // BUG-1496: si ya usó la llave (cruzó con consumo), la puerta está abierta para este jugador
    const usedKeyFlag = `used_key_${requiredKey.toLowerCase().replace(/\s+/g, '_')}`;
    if (playerSE[usedKeyFlag] === true) return `${label} 🔓`;
    return `${label} 🔒`;
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
 * @param {object|null} player — objeto jugador completo (para contexto personalizado)
 * @param {object} opts — opciones extra
 * @param {boolean} opts.suppressNarrativeEvents — si true, suprimir mini-eventos narrativos (DIS-1518: al moverse en revisitas)
 */
function describeRoom(roomId, excludePlayerId = null, player = null, opts = {}) {
  const data = getRoomFull(roomId);
  if (!data) return 'Esa habitación no existe.';

  const { room, monsters } = data;
  const lines = [];

  lines.push(`\n=== ${room.name.toUpperCase()} ===`);
  // BUG-602: La descripción de sala 7 (Pozo Sin Fondo) verifica si la puerta norte ya fue desbloqueada
  let roomDesc = room.description;
  if (room.id === 7) {
    const northExit = room.exits ? room.exits['north'] : undefined;
    const puertaAbiertaGlobal = northExit !== undefined && northExit !== null && typeof northExit !== 'object';
    // BUG-1496: también verificar si el jugador específico ya usó la llave (consumida al cruzar)
    const puertaAbiertaParaJugador = (() => {
      if (!player) return false;
      try {
        const se = player.status_effects;
        if (!se) return false;
        const seObj = (typeof se === 'object' && !Array.isArray(se)) ? se : JSON.parse(se);
        return seObj['used_key_llave_oxidada'] === true;
      } catch(_) { return false; }
    })();
    if (puertaAbiertaGlobal || puertaAbiertaParaJugador) {
      roomDesc = 'Un pozo en el centro de la sala emite un viento frío desde las profundidades. Una cuerda cuelga al borde —la inscripción en la pared dice que nadie que intentó bajar volvió para contarlo. Al norte, la puerta de hierro macizo está abierta 🔓 —la llave oxidada hizo su trabajo. El Santuario Profano te espera al otro lado.';
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

  // DIS-1518: calcular si el jugador ya visitó esta sala (para suprimir mensajes narrativos repetitivos)
  const alreadyVisited = player && (() => {
    try {
      const vis = JSON.parse(player.rooms_visited || '[]');
      return vis.includes(room.id) || vis.includes(String(room.id));
    } catch (_) { return false; }
  })();

  // DIS-1208: pistas visuales directas en salas clave de la narrativa de Kaelthas
  // DIS-1346: suprimir para jugadores veteranos (nivel 3+) que ya visitaron la sala
  const isVeteranPlayer = alreadyVisited && (player.level || 1) >= 3;
  const KAELTHAS_ROOM_HINTS = {
    2:  '🔍 Una inscripción en la pared del corredor llama tu atención — el barniz de cera la protege del tiempo. (Escribí "examine pared" o "examine inscripciones" para leerla.)',
    5:  '🕯️ Sobre el altar hay un escudo sin emblema y velas que arden pese al polvo centenario — alguien estuvo aquí recientemente.',
    9:  '👑 El trono tiene marcas en los apoyabrazos — dedos que se aferraron muchas veces. Algo grabado en la piedra del respaldo parece diferente al resto de la decoración. (Escribí "examine trono" para investigar.)',
  };
  if (KAELTHAS_ROOM_HINTS[room.id] && !isVeteranPlayer) {
    lines.push(`\n${KAELTHAS_ROOM_HINTS[room.id]}`);
  }

  // DIS-1747: En sala 1 (Entrada de la Cripta), mostrar hint ambiental de facciones para jugadores
  // de nivel bajo (< 3). Suprimido al llegar a nivel 3 (cuando las facciones se desbloquean).
  if (room.id === 1 && player && (player.level || 1) < 3) {
    lines.push('\n🏴 Las paredes de la entrada muestran marcas de tres grupos distintos — estandartes rivales grabados a cuchillo sobre la piedra. Grupos de aventureros compiten por el control del dungeon. Cuando llegues al nivel 3, podrás unirte a uno (escribí «facciones» entonces).');
  }

  // DIS-1444: En sala 18 (Fuente Eterna), mostrar cuánto HP restauraría para que el jugador
  // sepa si vale la pena usarla antes de intentarlo.
  if (room.id === 18 && player) {
    try {
      if (player.hp < player.max_hp) {
        const toRestore = player.max_hp - player.hp;
        lines.push(`\n💧 La fuente restaura HP al máximo al beber. Tenés ${player.hp}/${player.max_hp} HP (+${toRestore} si bebés ahora). Escribí "beber".`);
      } else {
        lines.push(`\n💧 La fuente restaura HP al máximo al beber. Tu HP ya está lleno.`);
      }
    } catch (_) { /* no romper describeRoom */ }
  }


  const ambientLine = ambient.getAmbientText(room);
  if (ambientLine) {
    lines.push(`\n🌫️ ${ambientLine}`);
  }

  // T168: Mini-evento narrativo (15% de chance, inocuo, pura atmósfera)
  // DIS-1518: suprimir en revisitas cuando se mueve (suppressNarrativeEvents=true) — el jugador
  // ya conoce la sala. Al hacer `look` explícitamente sí se muestra.
  const narrativeEvent = !opts.suppressNarrativeEvents && !alreadyVisited && ambient.getNarrativeEvent(room);
  if (narrativeEvent) {
    lines.push(`\n💭 ${narrativeEvent}`);
  }

  if (monsters.length > 0) {
    // T166: Niebla densa — ocultar HP de los monstruos
    const foggy = weather.isFoggy();
    // DIS-1451: Marea Espectral — marcar criaturas inactivas
    const SPECTRAL_TIDE_IDS = new Set([4, 8, 12, 13, 21, 22]);
    const spectralEvCheck = (() => { try { return eventScheduler.getActiveEventInfo(); } catch(_) { return null; } })();
    const isSpectralTide = spectralEvCheck && spectralEvCheck.event && spectralEvCheck.event.id === 'SPECTRAL_TIDE';
    const monsterList = monsters.map(m => {
      if (foggy) {
        return `  • ${m.name} [🌁 oculto por la niebla]`;
      }
      // DIS-1451: si Marea Espectral activa y el monstruo no es espectral/undead, mostrarlo como inactivo
      // DIS-1534: excepción — salas early (1-5) quedan fuera del epicentro espectral
      const isEarlyZone = room.id <= 5;
      if (isSpectralTide && !isEarlyZone) {
        const mNameLower = (m.name || '').toLowerCase();
        const isSpectral = SPECTRAL_TIDE_IDS.has(m.id) ||
          mNameLower.includes('espectro') || mNameLower.includes('fantasma') ||
          mNameLower.includes('espectral') || mNameLower.includes('lich') || mNameLower.includes('sombra');
        const isUndead = mNameLower.includes('esqueleto') || mNameLower.includes('zombie') ||
          mNameLower.includes('zombi') || mNameLower.includes('vampiro') || mNameLower.includes('momia') ||
          mNameLower.includes('óseo') || mNameLower.includes('muerto');
        if (!isSpectral && !isUndead) {
          return `  • ${m.name} 👻 (huye / inactiva durante la Marea Espectral)`;
        }
      } else if (isSpectralTide && isEarlyZone) {
        // DIS-1534: zona early — las criaturas siguen activas, pero con nota narrativa
        // (sin mensaje extra para no saturar, el jugador ve su HP normal)
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
    // DIS-1534: si hay Marea Espectral pero estamos en zona early, agregar contexto narrativo (una línea compacta)
    // DIS-1744: mensaje acortado para reducir acumulación de bloques informativos en sala 2
    if (isSpectralTide && room.id <= 5) {
      const minLeftEarly = spectralEvCheck && spectralEvCheck.minutesRemaining ? spectralEvCheck.minutesRemaining : '?';
      lines.push(`\n👻 Marea Espectral activa en las profundidades (~${minLeftEarly} min). Las criaturas exteriores siguen activas.`);
    }
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
    // DIS-1205: contexto narrativo para ítems de valor en Coliseo de Huesos (sala 14)
    let floorNarrativeNote = '';
    if (room.id === 14) {
      const hasValueItem = room.items.some(item => {
        const r = items.getItemRarity(item);
        return r === 'épico' || r === 'raro' || r === 'legendario';
      });
      if (hasValueItem) {
        floorNarrativeNote = '\n🦴 Entre la arena manchada de sangre seca yacen los restos de un aventurero anterior — alguien que llegó hasta aquí pero no lo logró. Su equipo quedó esparcido entre los huesos.\n';
      }
    }
    lines.push(`${floorNarrativeNote}\nObjetos en el suelo: ${itemList}`);
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
      // DIS-1182: mostrar el ítem requerido para desactivar la trampa antes de entrar
      // DIS-1198: agregar hint de dónde conseguir el ítem para ítems con fuente no obvia
      const TRAP_ITEM_WHERE = {
        'hongo azul': ' (crece en la Capilla Olvidada — para llegar sin riesgo: retrocedé a la Entrada y andá al este. También crece dentro del Túnel, sala 6)',
        'corona rota': ' (loot del Espectro del Corredor, o buscá en la Prisión Subterránea)',
        'cuerda': ' (disponible en la tienda del Mercader Aldric)',
        'red de pesca': ' (buscá en la Caverna Sumergida con \"buscar\" tras entrar, o comprá en la tienda de Aldric por 15g)',
      };
      const itemNeeded = adjRoom.trap.item_needed
        ? ` — necesitás "${adjRoom.trap.item_needed}"${TRAP_ITEM_WHERE[adjRoom.trap.item_needed] || ''} para desactivarla`
        : '';
      trapHints.push(`${DIR_NAMES[dir] || dir}: marcas de mecanismo sospechosas en el umbral${itemNeeded} (podés escribir "desactivar trampa ${DIR_NAMES[dir] || dir}" para neutralizarla sin entrar)`);
    }
  }
  if (trapHints.length > 0) {
    lines.push(`\n🔍 Observás: ${trapHints.join('; ')}.`);
  }

  // Indicador de trampa activa — DIS-1182: mostrar el ítem requerido
  // DIS-1344: no mostrar el aviso si el jugador ya conoce la trampa (ya la activó o desactivó)
  if (room.trap && room.trap.active && !knownTraps[String(roomId)] && !knownTraps[roomId]) {
    const trapItemHint = room.trap.item_needed
      ? `Necesitás "${room.trap.item_needed}" para desactivarla.`
      : 'Escribí "desactivar trampa" con el ítem correcto.';
    lines.push(`\n⚠️  Esta sala tiene una trampa activa. ${trapItemHint}`);
  } else if (room.trap && room.trap.active && (knownTraps[String(roomId)] || knownTraps[roomId])) {
    // DIS-1394: si el jugador ya conoce la trampa pero sigue activa, indicar que no le afecta
    // DIS-1834: mensaje compacto para no duplicar el "Recordás la trampa" que ya muestra cmdMove al entrar
    lines.push(`\n🧠 Trampa activa (conocida — ya no tomás daño al entrar).`);
  }

  // DIS-1178: Sala 1 (Entrada) — hint temprano sobre el mercader
  // DIS-1346: suprimir para jugadores veteranos (nivel 3+) que ya visitaron la sala
  if (roomId === 1 && !isVeteranPlayer) {
    lines.push(`\n💡 Consejo: Hay un mercader dentro del dungeon. Su tienda está al norte (Corredor) y luego al este. Seguí el olor a cuero.`);
  }

  // DIS-1178: Sala 2 (Corredor de las Sombras) — hint olfativo hacia la tienda
  // DIS-1329: suprimir si es primera visita (el evento cinemático ya menciona el olor a cuero curtido)
  // DIS-1346: suprimir para jugadores veteranos
  // DIS-1744: suprimir si el jugador ya visitó sala 4 (ya conoce a Aldric — hint redundante)
  if (roomId === 2 && !isVeteranPlayer) {
    let sala2PrimeraVisita = false;
    let yaConoceAldric = false;
    if (player && player.rooms_visited) {
      try {
        const visitados = JSON.parse(player.rooms_visited || '[]');
        sala2PrimeraVisita = !visitados.includes(2);
        yaConoceAldric = visitados.includes(4) || visitados.includes('4');
      } catch (_) {}
    }
    if (!sala2PrimeraVisita && !yaConoceAldric) {
      lines.push(`\n👃 Un tenue olor a cuero curtido y especias de ultramar llega desde el norte. Quizás hay algo interesante en esa dirección.`);
    }
  }

  // DIS-1178: Sala 3 (Sala de los Ecos) — hint explícito hacia Aldric + nota sobre el Esqueleto
  // DIS-1346: suprimir para jugadores veteranos
  // DIS-1744: suprimir si el jugador ya visitó sala 4 (ya conoce a Aldric)
  if (roomId === 3 && !isVeteranPlayer) {
    const yaEnSala4 = (() => {
      try {
        const vis = JSON.parse(player && player.rooms_visited ? player.rooms_visited : '[]');
        return vis.includes(4) || vis.includes('4');
      } catch (_) { return false; }
    })();
    if (!yaEnSala4) {
      lines.push(`\n🏪 Al este, el olor a cuero se vuelve inconfundible — la tienda del mercader Aldric está ahí.\n   ⚔️  El Esqueleto Guerrero custodia la entrada, pero Aldric lo instruyó para no atacar a compradores que lleguen sin arma desenvainada. Podés entrar sin pelear.`);
    }
  }

  // NPC Mercader en sala 4
  // DIS-1346: para veteranos, solo mostrar que Aldric está presente (útil), suprimir hints instructivos
  if (roomId === 4) {
    lines.push(`\n🏪 Aldric el Mercader está aquí, sentado detrás de un improvisado mostrador de cajas.\n   "Bienvenido. Escribí 'tienda' (o 'shop') para ver mis artículos."`);
    if (!isVeteranPlayer) {
      // DIS-1178: nota que el Esqueleto es guardia de Aldric y no ataca primero
      lines.push(`\n⚔️  El Esqueleto Guerrero en la sala es el guardia personal de Aldric. No te atacará si no lo provocás — llegaste como comprador, no como invasor. (Si lo atacás, Aldric lo notará.)`);
      // DIS-1097: hint sobre acceso a la Casa de Subastas sin pelear
      lines.push(`\n🏛️ Pista: Al este de esta sala podés acceder a la Casa de Subastas (sala 17).\n   Usá el comando «este» para llegar directamente.`);
    }
  }

  // DIS-D48: Cuenco Sagrado en sala 5 (Capilla Olvidada)
  // DIS-1180: si el jugador tiene HP bajo (<60%), destacar el cuenco con más urgencia
  // DIS-1346: para veteranos con HP alto, suprimir hint (ya conocen el cuenco)
  if (roomId === 5) {
    const playerHp = player ? player.hp : null;
    const playerMaxHp = player ? player.max_hp : null;
    const hpPct = (playerHp !== null && playerMaxHp) ? (playerHp / playerMaxHp) : 1;
    // Check cooldown del cuenco (el mapa de cooldowns está en engine.js — aquí usamos lore estático)
    // DIS-1748: usar HP calculado ("hasta X HP — 40% de tu máximo") para consistencia con mensaje de uso real
    const cuencoHeal = playerMaxHp ? Math.floor(playerMaxHp * 0.4) : null;
    const cuencoHealStr = cuencoHeal !== null ? `hasta ${cuencoHeal} HP — 40% de tu máximo` : '40% de tu HP máximo';
    if (hpPct < 0.6) {
      // HP bajo: siempre mostrar (urgente, incluso para veteranos)
      lines.push(`\n💧 ¡ATENCIÓN — HP bajo! El cuenco de piedra negra del altar puede curarte.\n   ("cuenco" o "beber" — recupera ${cuencoHealStr}, cooldown personal 5 min)`);
    } else if (!isVeteranPlayer) {
      // HP normal + no veterano: hint informativo
      lines.push(`\n🙏 En el centro de la sala hay un cuenco de piedra negra lleno de agua fría.\n   ("cuenco" para beber — recupera ${cuencoHealStr}, cooldown personal 5 min)`);
    }
    // DIS-1649: hint de inscripción en pared norte (sutil — solo para no-veteranos)
    if (!isVeteranPlayer) {
      lines.push(`\n🪨 Hay algo grabado en la pared norte. ("examine inscripcion" para leerlo)`);
    }
  }

  // DIS-D344: Pista ruta alternativa ya incluida en la descripción de la sala 7 (seed.js)
  // No agregar mensaje extra aquí para evitar duplicación.

  // DIS-1650: Santuario Profano (sala 10) — advertencia sobre regeneración del Gólem de Piedra
  // La mecánica de regen era invisible antes del combate: el jugador descubría que el Gólem sanaba
  // a mitad de pelea con el HP subiendo de sorpresa. Mostrar pista narrativa al entrar.
  if (roomId === 10 && !isVeteranPlayer) {
    const golemAlive = (() => {
      try {
        const monsters = db.getMonstersInRoom(10);
        return monsters.some(m => m.hp > 0 && (m.name || '').toLowerCase().includes('gólem de piedra'));
      } catch (_) { return true; } // si falla, asumir que está vivo
    })();
    if (golemAlive) {
      lines.push(`\n🪨 Las marcas en el suelo del Santuario muestran el patrón de un constructo antiguo que se repara a sí mismo. Los fragmentos dispersos de piedra no están en el suelo por accidente — se reensamblan. Atacarlo sin daño sostenido es inútil.`);
    }
  }

  // DIS-1839: Taller de la Forja (sala 12) — advertencia sobre regeneración del Troll de las Cavernas
  // El hint de regen aparecía solo durante el combate (DIS-1791), cuando el jugador ya estaba
  // comprometido. Ahora se avisa al ENTRAR a la sala, para que pueda prepararse antes de atacar.
  if (roomId === 12 && !isVeteranPlayer) {
    const trollAlive = (() => {
      try {
        const monsters = db.getMonstersInRoom(12);
        return monsters.some(m => m.hp > 0 && (m.name || '').toLowerCase().includes('troll'));
      } catch (_) { return true; } // si falla, asumir que está vivo
    })();
    if (trollAlive) {
      lines.push(`\n🟤 El suelo de la forja está cubierto de cicatrices. Las marcas no las dejó el calor — las dejó el Troll de las Cavernas que lo habita. Su piel grisácea es famosa por cerrarse sola: si no terminás la pelea rápido, se recuperará ante tus ojos.\n   💡 Consejo: usá tus habilidades de mayor daño o una poción de poder antes de atacar.`);
    }
  }

  // DIS-1177: Sala 18 (Fuente Eterna) — gancho narrativo para salidas hacia zonas profundas
  // La sala tiene salida 'down' → sala 20 (Abismo Eterno, nivel 8+)
  // Jugadores de nivel bajo deben entender que hay algo ahí abajo y por qué volver.
  // DIS-1346: para veteranos que ya visitaron la sala, suprimir el texto guía (ya lo saben)
  if (roomId === 18 && !isVeteranPlayer) {
    const playerLevel = player ? (player.level || 1) : 1;
    if (playerLevel < 8) { // DIS-1390: nivel recomendado 7→8
      lines.push(`\n🌀 Por la fisura en el suelo, junto a la base de la fuente, llega un rumor de combate y ecos metálicos desde las profundidades. El agua plateada cae hacia el Abismo Eterno — una zona donde habita la Sombra del Vacío, una entidad de oscuridad pura.\n   📌 Objetivo futuro: cuando llegues al nivel 8, podrás explorar el Abismo Eterno (abajo).`);
    } else {
      lines.push(`\n🌀 La fisura en el suelo (abajo) comunica con el Abismo Eterno — territorio de la Sombra del Vacío. La fuente sigue enviando agua curativa hacia las profundidades.\n   ⚠️ La Sombra usa Oscuridad Paralizante: el primer turno siempre te impide atacar. Entrá con HP alto y pociones de salud.`);
    }
  }

  // Mensajes en las paredes (T147 / DIS-1325)
  // El hint aparece si hay mensajes de jugadores O si hay lore hardcodeado para esta sala
  // DIS-1346: para veteranos que ya visitaron la sala, suprimir el hint de inscripciones (ya lo saben)
  // DIS-1440: sala 22 (Pozo Sin Fondo) agregada — tiene notas de jugadores anteriores; hint siempre visible
  const LORE_ROOMS = new Set([2, 4, 8, 9, 15, 22]); // salas con inscripciones de lore (DIS-1094/DIS-1325)
  const wallMsgs = db.getWallMessages(roomId);
  if (wallMsgs.length > 0 || LORE_ROOMS.has(roomId)) {
    lines.push(`\n✍️ Hay marcas en la pared. (Escribí "read" para leerlas.)`);
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
  // Solo salas afectadas: 2, 4, 6, 7, 14, 15, 17
  // BUG-1801: sala 3 (Sala de los Ecos) removida — el escriba vive en sala 17 (Casa de Subastas)
  const AFFECTED_ROOMS = new Set([2, 4, 6, 7, 14, 15, 17]);
  if (!AFFECTED_ROOMS.has(roomId)) return null;

  // Leer las claves relevantes según sala
  const KEY_MAP = {
    2:  ['goblins_semana'],
    4:  ['esqueletos_semana'],
    6:  ['items_crafteados_semana'],
    7:  ['aranas_semana'],
    14: ['lich_derrotado_semana'],
    15: ['lich_last_kill_ts'],
    17: ['subastas_semana'],
  };
  const keysToRead = KEY_MAP[roomId] || [];
  const ws = db.getWorldStateValues(keysToRead);

  switch (roomId) {
    case 2: { // Corredor de las Sombras — goblins
      const v = ws.goblins_semana || 0;
      if (v >= 10) return '🌫️ El corredor huele menos a goblin que de costumbre. La semana ha sido activa.';
      return null;
    }
    case 17: { // Casa de Subastas — escriba (BUG-1801: movido de sala 3 a sala 17)
      // DIS-1185: el mensaje debe reflejar subastas activas, no solo el historial semanal
      let activeCount = 0;
      try { activeCount = (db.getActiveAuctions() || []).length; } catch (_) { /* continuar */ }
      const v = ws.subastas_semana || 0;
      if (activeCount > 0) return `📜 El escriba levanta la vista de sus papeles. «Hay ${activeCount} ${activeCount === 1 ? 'ítem en subasta ahora mismo' : 'ítems en subasta ahora mismo'}», dice señalando su mesa de registros. «Podés ver las ofertas activas con "subasta" o "subastas".»`;
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

// ─── IMPL-VV-1757: Resolver variantes de monstruo por sala ───────────────────
//
// Mapa de salas variables y sus monstruos BASE en BD.
// Salas que tienen un monstruo "base" que puede ser reemplazado según run_monster_variants.
const VARIABLE_ROOMS = new Set([2, 3, 6, 7, 8, 20]);

// Mapa: slug de variante → lista de IDs de monstruos en BD que deben estar en la sala.
// Si un slug NO está en este mapa, se usa la sala con sus monstruos de BD actuales (comportamiento normal).
// Cada entrada define { add: [...ids], remove: [...ids_base] }:
//   - add: monstruos que deben tener room_id = roomId
//   - remove: monstruos base (IDs actuales de la sala) que deben ser movidos fuera (room_id = null) temporalmente
//
// IDs de monstruos base por sala:
//   Sala 2: Goblin Merodeador (1), Goblin Explorador (28)
//   Sala 3: Esqueleto Guerrero (2), Murciélago Vampiro (26)
//   Sala 6: Rata Gigante (3), Murciélago Vampiro (27)
//   Sala 7: Araña Tejedora (7)
//   Sala 8: Guardia Espectral (8) — el boss no varía, solo puede añadirse Elemental de Maná
//   Sala 20: Sombra del Vacío (22) — nota: sala 20 es endgame, variante afecta a monstruo adicional
//
// IDs de monstruos de variante nuevos:
//   30: Gnoll Merodeador
//   31: Zombie Caminante
//   32: Elemental de Fuego
//
const VARIANT_MONSTER_PLANS = {
  // ─── Sala 2 ───────────────────────────────────────────────────────────────
  // base: Goblin Merodeador (1) + Goblin Explorador (28)
  'gnoll_explorador_murcielago': {
    roomId: 2,
    add: [30],           // Gnoll Merodeador reemplaza a los goblins. El "murciélago" del slug es aspiracional — requeriría un ID dedicado. MVP: solo Gnoll.
    remove: [1, 28],
    note: 'Sala 2 variante dura: Gnoll Merodeador (30) en lugar de los goblins base. El Murciélago del slug requiere ID dedicado (futura mejora).',
  },
  'rata_gigante_x3': {
    roomId: 2,
    add: [],             // MVP: sin override. 3 Ratas requieren IDs dedicados (33+). Por ahora sala 2 conserva sus goblins base.
    remove: [],
    note: 'MVP: sin override para rata_gigante_x3 en sala 2 — necesita 2 IDs adicionales de Rata Gigante. Sala queda con monstruos base.',
  },

  // ─── Sala 3 ───────────────────────────────────────────────────────────────
  // base: Esqueleto Guerrero (2) + Murciélago Vampiro (26)
  'zombie_caminante_x2': {
    roomId: 3,
    add: [31, 31],      // Zombie Caminante × 2 — nota: hay solo 1 id 31 en BD; ver nota abajo
    remove: [2, 26],    // quitar base
    note: 'Solo hay 1 instancia del id 31; en la práctica se coloca 1 Zombie Caminante en sala 3 y el sistema de respawn crea sensación de masa.'
  },
  'gnoll_merodeador_arana': {
    roomId: 3,
    add: [30],           // Gnoll Merodeador (araña ya existe en sala 7, no se mueve)
    remove: [2, 26],
    note: 'Gnoll Merodeador (30) + Araña Tejedora (7) sería lo ideal, pero mover id 7 de sala 7 puede causar conflictos. MVP: solo Gnoll Merodeador en sala 3.'
  },

  // ─── Sala 6 ───────────────────────────────────────────────────────────────
  // base: Rata Gigante (3) + Murciélago Vampiro (27)
  'gnoll_merodeador_rata': {
    roomId: 6,
    add: [30],           // Gnoll Merodeador se une a la Rata Gigante (base). El Murciélago (27) se hiberna.
    remove: [27],        // Solo quita el Murciélago; la Rata queda. Sala 6 = Rata Gigante + Gnoll Merodeador.
    note: 'Sala 6 variante: Gnoll Merodeador (30) reemplaza al Murciélago Vampiro. La Rata Gigante permanece como base. Combinación más peligrosa que el estándar.',
  },
  'arana_tejedora_x2': {
    roomId: 6,
    add: [],             // MVP: sin override. 2 Arañas requieren 2 IDs (solo existe id 7 en sala 7). Sala queda con monstruos base.
    remove: [],
    note: 'MVP: sin override para arana_tejedora_x2 en sala 6 — necesita un ID adicional de Araña Tejedora. Sala queda con Rata Gigante + Murciélago base.',
  },

  // ─── Sala 7 ───────────────────────────────────────────────────────────────
  // base: Araña Tejedora (7)
  'gnoll_merodeador': {
    roomId: 7,
    add: [30],           // Gnoll Merodeador solo
    remove: [7],
  },
  'rata_gigante_x2': {
    roomId: 7,
    add: [],             // Rata gigante (id 3) está en sala 6 — no se puede mover fácil. MVP: sala 7 queda con base (araña).
    remove: [],
    note: 'MVP: sin override para rata_gigante_x2 en sala 7 — usa comportamiento base. Futura mejora: crear segunda Rata Gigante con id propio.'
  },

  // ─── Sala 20 ──────────────────────────────────────────────────────────────
  // base: Sombra del Vacío (22) — boss narrativo de sala 20
  'golem_elemental_fuego': {
    roomId: 20,
    add: [32],           // Añadir Elemental de Fuego (no quitar la Sombra del Vacío)
    remove: [],
    note: 'Elemental de Fuego se AÑADE a sala 20 (no reemplaza la Sombra del Vacío). Es un acompañante extra.'
  },
  'troll_x2_guardia': {
    roomId: 20,
    add: [],             // MVP: sin trolls adicionales (solo hay Troll de Cavernas id 29 en sala 12). Futura mejora: crear IDs propios.
    remove: [],
    note: 'MVP: sin override para troll_x2_guardia. Futura mejora: crear monstruos troll de guardia con IDs propios.'
  },

  // ─── Sala 8 — Prisión Subterránea ─────────────────────────────────────────
  // Solo afectada por plaga_arcana: Elemental de Maná adicional
  // El Elemental de Maná es conceptualmente similar al id 32 (Elemental de Fuego) pero con stats distintos.
  // MVP: en sala 8 + plaga_arcana se usa run_state para saber; esto se maneja en el hook plaga_arcana
  // (ya implementado en IMPL-VV-1759 para stats, aquí solo manejamos la presencia física en sala).
  // La variante 'elemental_mana_adicional' en sala 8 agrega Elemental de Fuego (32) como proxy.
  'elemental_mana_adicional': {
    roomId: 8,
    add: [32],           // Elemental de Fuego como proxy del Elemental de Maná
    remove: [],
    note: 'Elemental de Fuego (id 32) actúa como Elemental de Maná en sala 8 durante plaga_arcana. Stats reducidos son responsabilidad del hook ya implementado.'
  },
};

// ─── Posiciones base de ítems raros (sala por defecto en seed.js) ──────────────
// Mapa: item_slug → sala base donde seed.js los coloca
const RARE_LOOT_BASE_ROOMS = {
  paginas_congeladas: 11,
  // Los demás ítems del pool de run_loot_positions no tienen sala base fija en seed.js
  // (aparecen como loot de monstruos o se generan por otros medios — no necesitan reubicación)
};

// Nombre de sala para cada sala del pool de paginas_congeladas
const RARE_LOOT_ROOM_NAMES = {
  11: 'la Galería de Hielo (sala 11)',
  14: 'el Coliseo de Huesos (sala 14)',
  19: 'la Cámara del Eco (sala 19)',
  6:  'el Pasillo de las Ratas (sala 6)',
  7:  'la Caverna de las Arañas (sala 7)',
  8:  'la Prisión Subterránea (sala 8)',
  2:  'el Corredor Inicial (sala 2)',
  5:  'la Capilla Olvidada (sala 5)',
  13: 'el Pozo de los Susurros (sala 13)',
  20: 'la Sala del Vacío (sala 20)',
};

/**
 * IMPL-VV-1758: Aplica las posiciones variables de ítems raros para un player.
 *
 * Lee player.run_loot_positions y, para cada ítem cuya sala dinámica difiere de la base,
 * remueve el ítem de la sala base y lo agrega a la sala dinámica.
 *
 * Solo tiene efecto si player.run_seed no es NULL y el flag 'loot_positions_applied'
 * no está ya en status_effects del player (para no repetirse en el mismo run).
 *
 * @param {object} player — objeto player completo de la BD
 * @returns {boolean} true si se aplicó algún cambio
 */
function applyRareLootPositions(player) {
  // Solo aplica si el player tiene run_seed (Variación Viva activada)
  if (!player || !player.run_seed) return false;

  // Parsear status_effects para verificar flag
  let se = {};
  try {
    se = typeof player.status_effects === 'object' && player.status_effects !== null
      ? player.status_effects
      : JSON.parse(player.status_effects || '{}');
  } catch (_) { se = {}; }

  // Si ya se aplicó en este run, no repetir
  if (se.loot_positions_applied) return false;

  // Parsear run_loot_positions
  let lootPositions = {};
  try {
    lootPositions = typeof player.run_loot_positions === 'object' && player.run_loot_positions !== null
      ? player.run_loot_positions
      : JSON.parse(player.run_loot_positions || '{}');
  } catch (_) { return false; }

  let changed = false;

  for (const [slug, baseRoom] of Object.entries(RARE_LOOT_BASE_ROOMS)) {
    const targetRoom = lootPositions[slug];
    if (!targetRoom || targetRoom === baseRoom) continue; // sin cambio necesario

    const itemName = slug === 'paginas_congeladas' ? 'páginas congeladas' : slug;

    // Quitar de la sala base (si está ahí)
    const roomBase = db.getRoom(baseRoom);
    if (roomBase && (roomBase.items || []).some(i => i.toLowerCase() === itemName)) {
      const updatedItems = (roomBase.items || []).filter(i => i.toLowerCase() !== itemName);
      db.upsertRoom({ ...roomBase, items: updatedItems });
      changed = true;
    }

    // Agregar a la sala dinámica (si no está ya ahí)
    const roomTarget = db.getRoom(targetRoom);
    if (roomTarget && !(roomTarget.items || []).some(i => i.toLowerCase() === itemName)) {
      const updatedItems = [...(roomTarget.items || []), itemName];
      db.upsertRoom({ ...roomTarget, items: updatedItems });
      changed = true;
    }
  }

  // Marcar flag para no repetir en este run
  const newSe = { ...se, loot_positions_applied: true };
  db.updatePlayer(player.id, { status_effects: JSON.stringify(newSe) });

  if (changed) {
    console.log(`[dungeon] applyRareLootPositions: posiciones aplicadas para player ${player.id} (seed ${player.run_seed})`);
  }

  return changed;
}

/**
 * Devuelve el nombre legible de la sala donde están las páginas congeladas
 * según run_loot_positions del player.
 *
 * @param {object} player
 * @returns {{ roomId: number, roomName: string }}
 */
function getPaginasCongeladasLocation(player) {
  const defaultRoom = 11;
  if (!player || !player.run_loot_positions) return { roomId: defaultRoom, roomName: RARE_LOOT_ROOM_NAMES[defaultRoom] };

  let lootPositions = {};
  try {
    lootPositions = typeof player.run_loot_positions === 'object' && player.run_loot_positions !== null
      ? player.run_loot_positions
      : JSON.parse(player.run_loot_positions || '{}');
  } catch (_) { return { roomId: defaultRoom, roomName: RARE_LOOT_ROOM_NAMES[defaultRoom] }; }

  const roomId = lootPositions.paginas_congeladas || defaultRoom;
  const roomName = RARE_LOOT_ROOM_NAMES[roomId] || `sala ${roomId}`;
  return { roomId, roomName };
}

/**
 * IMPL-VV-1757: Obtiene el plan de variante de monstruos para una sala y un player.
 *
 * @param {number} roomId
 * @param {object} player — objeto player con run_monster_variants (JSON string o objeto)
 * @returns {{ slug: string, add: number[], remove: number[] } | null}
 *   null si la sala no es variable o la variante es 'base'/'normal'.
 */
function getVariantPlanForPlayer(roomId, player) {
  if (!VARIABLE_ROOMS.has(roomId)) return null;
  if (!player) return null;

  let variants;
  try {
    variants = typeof player.run_monster_variants === 'object' && player.run_monster_variants !== null
      ? player.run_monster_variants
      : JSON.parse(player.run_monster_variants || '{}');
  } catch (_) {
    return null;
  }

  const slug = variants[roomId] || variants[String(roomId)];
  if (!slug || slug === 'base' || slug === 'normal') return null;

  const plan = VARIANT_MONSTER_PLANS[slug];
  if (!plan) return null;

  return { slug, ...plan };
}

/**
 * IMPL-VV-1757: Aplica la variante de monstruo a una sala para un player específico.
 *
 * Efecto: mueve monstruos de variante a la sala (room_id = roomId)
 * y mueve los monstruos base fuera (room_id = null) si están muertos (hp <= 0) o los pone
 * en "hibernación" (room_id = null) cuando aplica la variante.
 *
 * IMPORTANTE: Solo aplica si los monstruos de variante no están ya en la sala
 * y si los monstruos de variante tienen hp > 0 (no están derrotados).
 *
 * @param {number} roomId
 * @param {object} player
 * @returns {boolean} true si se aplicó algún cambio
 */
function applyVariantToRoom(roomId, player) {
  const plan = getVariantPlanForPlayer(roomId, player);
  if (!plan) return false;
  if (!plan.add || plan.add.length === 0) return false;

  let changed = false;

  // Verificar si los monstruos de variante ya están en la sala
  const currentMonsters = db.getMonstersInRoom(roomId);
  const addIds = [...new Set(plan.add)]; // deduplicate

  for (const monsterId of addIds) {
    const monster = db.getMonster(monsterId);
    if (!monster) continue;

    // Si ya está en la sala y con vida, no hacer nada
    if (monster.room_id === roomId && monster.hp > 0) continue;

    // Si está muerto (hp <= 0), no lo coloquemos — el respawn lo manejará
    if (monster.hp <= 0) continue;

    // Mover el monstruo de variante a esta sala y configurar respawn
    db.updateMonster(monsterId, { room_id: roomId, respawn_room_id: roomId });
    changed = true;
  }

  if (changed && plan.remove && plan.remove.length > 0) {
    // "Hibernar" los monstruos base: moverlos a room_id = null
    // Solo si el monstruo base está vivo (si está muerto ya tiene room_id = null por el sistema de combate)
    for (const baseId of plan.remove) {
      const baseMonster = db.getMonster(baseId);
      if (!baseMonster) continue;
      if (baseMonster.room_id !== roomId) continue; // ya no está en esta sala

      // Guardar la sala original como respawn_room_id si no tiene uno asignado
      // Nota: los monstruos base YA tienen respawn_room_id configurado — no lo tocamos
      db.updateMonster(baseId, { room_id: null });
    }
  }

  return changed;
}

module.exports = {
  getRoomFull,
  resolveExit,
  normalizeDirection,
  exitsText,
  describeRoom,
  VARIABLE_ROOMS,
  getVariantPlanForPlayer,
  applyVariantToRoom,
  applyRareLootPositions,
  getPaginasCongeladasLocation,
  DIR_NAMES,
  DIR_OPPOSITE,
  DIR_ALIASES,
};
