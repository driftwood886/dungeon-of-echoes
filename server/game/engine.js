/**
 * engine.js — Motor principal del juego
 *
 * Recibe una acción parseada + contexto del jugador y devuelve
 * un resultado en texto plano.
 *
 * Cubre T010 (look), T011 (move), T012 (inventory/status).
 * T013 (persistencia) está integrada aquí: después de cada acción
 * que cambie el estado, se guarda en la BD.
 */

'use strict';

const db      = require('../db/db');
const dungeon = require('./dungeon');
const { parse, HELP_TEXT, COMMAND_HELP } = require('./commands');
const combat  = require('./combat');
const items   = require('./items');

// ── Registro en memoria: último remitente de whisper/tell por jugador ─────────
// lastWhisperSender.get(playerId) → { id, username } del último que les escribió
const lastWhisperSender = new Map();

/**
 * Ejecuta un comando de texto para un jugador y devuelve el resultado.
 *
 * @param {string} playerId — ID del jugador (debe existir en la BD)
 * @param {string} input    — texto crudo
 * @returns {{ text: string, event?: string }}
 *   - text: respuesta para el jugador
 *   - event: descripción del evento para broadcast (opcional)
 */
function execute(playerId, input) {
  const player = db.getPlayer(playerId);
  if (!player) {
    return { text: 'Error: jugador no encontrado.' };
  }

  db.touchPlayer(playerId);

  const action = parse(input);

  let result;
  switch (action.command) {
    case 'look':      result = cmdLook(player); break;
    case 'move':      result = cmdMove(player, action.args[0]); break;
    case 'inventory': result = cmdInventory(player); break;
    case 'status':    result = cmdStatus(player); break;
    case 'attack':    result = cmdAttack(player, action.args.join(' ')); break;
    case 'flee':      result = cmdFlee(player); break;
    case 'pick':      result = cmdPick(player, action.args.join(' ')); break;
    case 'use':       result = cmdUse(player, action.args.join(' ')); break;
    case 'heal':      result = cmdHeal(player); break;
    case 'drop':      result = cmdDrop(player, action.args.join(' ')); break;
    case 'examine':   result = cmdExamine(player, action.args.join(' ')); break;
    case 'equip':     result = cmdEquip(player, action.args.join(' ')); break;
    case 'unequip':   result = cmdUnequip(player); break;
    case 'map':       result = cmdMap(player); break;
    case 'who':       result = cmdWho(); break;
    case 'score':     result = cmdScore(); break;
    case 'give':      result = cmdGive(player, action.args); break;
    case 'loot':      result = cmdLoot(player); break;
    case 'whisper':   result = cmdWhisper(player, action.args); break;
    case 'tell':      result = cmdTell(player, action.args); break;
    case 'reply':     result = cmdReply(player, action.args); break;
    case 'unlock':    result = cmdUnlock(player, action.args[0]); break;
    case 'disarm':    result = cmdDisarm(player); break;
    case 'rest':      result = cmdRest(player); break;
    case 'emote':     result = cmdEmote(player, action.args.join(' ')); break;
    case 'say':
      result = { text: 'El chat (say/shout) solo funciona por Socket.io. Conectate desde el browser para chatear.' };
      break;
    case 'shout':
      result = { text: 'El chat (say/shout) solo funciona por Socket.io. Conectate desde el browser para chatear.' };
      break;
    case 'help':
      if (action.args && action.args.length > 0) {
        const cmdKey = action.args[0].toLowerCase();
        // Buscar el comando canónico
        const COMMAND_ALIASES_MAP = {
          look: 'look', mirar: 'look', ver: 'look', l: 'look',
          move: 'move', ir: 'move', go: 'move',
          inventory: 'inventory', inv: 'inventory', i: 'inventory', inventario: 'inventory',
          status: 'status', stats: 'status', estado: 'status',
          attack: 'attack', atacar: 'attack',
          flee: 'flee', huir: 'flee', escapar: 'flee',
          pick: 'pick', tomar: 'pick', recoger: 'pick',
          loot: 'loot', saquear: 'loot',
          drop: 'drop', tirar: 'drop',
          use: 'use', usar: 'use',
          equip: 'equip', equipar: 'equip',
          unequip: 'unequip', desequipar: 'unequip',
          examine: 'examine', examinar: 'examine', x: 'examine',
          give: 'give', dar: 'give',
          map: 'map', mapa: 'map',
          who: 'who', jugadores: 'who',
          score: 'score', ranking: 'score', top: 'score',
          say: 'say', decir: 'say',
          shout: 'shout', gritar: 'shout',
          whisper: 'whisper', susurrar: 'whisper',
          tell: 'tell', mensaje: 'tell',
          reply: 'reply', responder: 'reply',
          unlock: 'unlock', abrir: 'unlock', desbloquear: 'unlock',
          emote: 'emote', accion: 'emote', me: 'emote',
          rest: 'rest', descansar: 'rest',
          help: 'help', ayuda: 'help',
        };
        const canonical = COMMAND_ALIASES_MAP[cmdKey] || cmdKey;
        const detail = COMMAND_HELP[canonical];
        result = detail
          ? { text: detail }
          : { text: `No hay ayuda detallada para "${cmdKey}". Escribí "help" para ver todos los comandos.` };
      } else {
        result = { text: HELP_TEXT };
      }
      break;
    case 'unknown':
      result = { text: `Comando desconocido: "${action.input}". Escribí "help" para ver los comandos.` };
      break;
    default:
      result = { text: `Comando "${action.command}" aún no implementado.` };
  }

  // Loguear el evento
  db.logEvent(playerId, player.current_room_id, input, result.text.slice(0, 200));

  return result;
}

// ─── Comandos ──────────────────────────────────────────────────────────────

/**
 * look — Describe la habitación actual.
 */
function cmdLook(player) {
  const text = dungeon.describeRoom(player.current_room_id, player.id);
  return { text };
}

/**
 * move <dir> — Mover al jugador a otra habitación.
 */
function cmdMove(player, direction) {
  if (!direction) {
    return { text: 'Indicá una dirección. Ej: "move norte" o simplemente "norte".' };
  }

  const room = db.getRoom(player.current_room_id);
  if (!room) {
    return { text: 'Error: tu habitación actual no existe en la BD.' };
  }

  const exit = dungeon.resolveExit(room, direction);
  if (exit === null) {
    const dirName = dungeon.DIR_NAMES[dungeon.normalizeDirection(direction)] || direction;
    return { text: `No hay salida hacia el ${dirName}. Salidas disponibles: ${dungeon.exitsText(room)}.` };
  }

  const { targetId, key } = exit;

  // Verificar si la salida requiere una llave
  if (key) {
    const inventory = player.inventory || [];
    const hasKey = inventory.some(item => item.toLowerCase() === key.toLowerCase());
    if (!hasKey) {
      const dirName = dungeon.DIR_NAMES[dungeon.normalizeDirection(direction)] || direction;
      return {
        text: `La salida hacia el ${dirName} está bloqueada. 🔒\nNecesitás: "${key}" para abrirla.`,
      };
    }
  }

  const targetRoom = db.getRoom(targetId);
  if (!targetRoom) {
    return { text: 'Error: la habitación destino no existe.' };
  }

  // Actualizar posición del jugador
  db.updatePlayer(player.id, { current_room_id: targetId });

  // Construir respuesta
  const moveText = `Vas hacia el ${dungeon.DIR_NAMES[dungeon.normalizeDirection(direction)] || direction}.`;
  const roomDesc = dungeon.describeRoom(targetId, player.id);

  // ── Verificar trampa en la sala destino ─────────────────────────────────
  let trapText = '';
  const targetRoomFull = db.getRoom(targetId);
  if (targetRoomFull && targetRoomFull.trap && targetRoomFull.trap.active) {
    const trap = targetRoomFull.trap;
    // Refrescar jugador para HP actualizado
    player = db.getPlayer(player.id);
    const newHp = Math.max(0, player.hp - trap.damage);
    db.updatePlayer(player.id, { hp: newHp });
    trapText = `\n\n${trap.description}\n💥 Perdés ${trap.damage} HP. (${newHp}/${player.max_hp} HP)`;
    if (newHp === 0) {
      trapText += '\n☠️  Has muerto a causa de la trampa. Renacés en la Entrada.';
      db.updatePlayer(player.id, { hp: player.max_hp, current_room_id: 1 });
    }
    trapText += '\n💡 Tip: escribí "desactivar trampa" con el ítem correcto en tu inventario para desactivarla.';
  }

  return {
    text: `${moveText}\n${roomDesc}${trapText}`,
    event: `${player.username} entra a la sala.`,
    eventRoomId: targetId,
    fromRoomId: player.current_room_id,
    fromRoomEvent: `${player.username} se marcha hacia el ${dungeon.DIR_NAMES[dungeon.normalizeDirection(direction)] || direction}.`,
  };
}

/**
 * inventory — Mostrar inventario del jugador.
 */
function cmdInventory(player) {
  if (!player.inventory || player.inventory.length === 0) {
    return { text: 'Tu inventario está vacío.' };
  }
  const items = player.inventory.map((item, i) => `  ${i + 1}. ${item}`).join('\n');
  return { text: `Inventario:\n${items}` };
}

/**
 * status — Mostrar estado del jugador.
 */
function cmdStatus(player) {
  const room = db.getRoom(player.current_room_id);
  const roomName = room ? room.name : 'desconocida';

  // Refrescar para tener xp/kills/level/equipped_weapon actualizados
  player = db.getPlayer(player.id);

  const hpBar = buildBar(player.hp, player.max_hp, 20);
  const level  = player.level || 1;
  const xp     = player.xp    || 0;
  const kills  = player.kills || 0;
  const deaths = player.deaths || 0;
  const xpBar  = buildBar(xp % 50, 50, 10);
  const weaponLine = player.equipped_weapon
    ? `Arma:     ${player.equipped_weapon}`
    : `Arma:     (desarmado — ataque base)`;

  const text = [
    `\n=== ${player.username.toUpperCase()} ===`,
    `Nivel:    ${level}  (${xp} XP total | kills: ${kills} | muertes: ${deaths})`,
    `XP sig.:  ${xpBar} ${xp % 50}/50`,
    `HP:       ${hpBar} ${player.hp}/${player.max_hp}`,
    `Ataque:   ${player.attack}`,
    `Defensa:  ${player.defense}`,
    weaponLine,
    `Ubicación: ${roomName}`,
  ].join('\n');

  return { text };
}

/**
 * attack <nombre> — Atacar a un monstruo de la habitación.
 */
function cmdAttack(player, targetName) {
  if (!targetName || !targetName.trim()) {
    return { text: 'Indicá a quién querés atacar. Ej: "attack goblin".' };
  }

  // Refrescar player desde BD para tener HP actualizado
  player = db.getPlayer(player.id);

  const monster = combat.findMonsterInRoom(player.current_room_id, targetName.trim());
  if (!monster) {
    return { text: `No hay ningún "${targetName}" aquí.` };
  }

  const { lines, monsterDead, playerDead } = combat.attackRound(player, monster);

  let eventText = null;
  if (monsterDead) {
    eventText = `${player.username} derrota al ${monster.name}.`;
  } else if (playerDead) {
    eventText = `${player.username} fue derrotado por el ${monster.name}.`;
  } else {
    eventText = `${player.username} combate contra el ${monster.name}.`;
  }

  return {
    text: lines.join('\n'),
    event: eventText,
    eventRoomId: player.current_room_id,
  };
}

/**
 * flee / huir — Intentar huir del combate.
 * Solo tiene sentido si hay monstruos en la sala.
 */
function cmdFlee(player) {
  player = db.getPlayer(player.id);
  const monsters = db.getMonstersInRoom(player.current_room_id);

  if (monsters.length === 0) {
    return { text: 'No hay nada de lo que huir aquí.' };
  }

  // Huir del primer monstruo (el más relevante)
  const monster = monsters[0];
  const { fled, line } = combat.tryFlee(player, monster);

  return {
    text: line,
    event: fled ? `${player.username} huye de la sala.` : `${player.username} intenta huir pero falla.`,
    eventRoomId: player.current_room_id,
  };
}

/**
 * pick <ítem> — Recoger un ítem del suelo.
 */
function cmdPick(player, itemQuery) {
  if (!itemQuery || !itemQuery.trim()) {
    return { text: 'Indicá qué querés recoger. Ej: "pick espada".' };
  }

  const room = db.getRoom(player.current_room_id);
  if (!room) {
    return { text: 'Error: tu habitación actual no existe.' };
  }

  const found = items.findItem(room.items, itemQuery.trim());
  if (!found) {
    return { text: `No hay ningún "${itemQuery}" en el suelo.` };
  }

  // Quitar el ítem del suelo
  const newRoomItems = room.items.filter(i => i !== found);
  db.updateRoomItems(room.id, newRoomItems);

  // Agregarlo al inventario del jugador
  player = db.getPlayer(player.id);
  const newInventory = [...player.inventory, found];
  db.updatePlayer(player.id, { inventory: newInventory });

  return {
    text: `Recogés ${found} y lo guardás en tu mochila.`,
    event: `${player.username} recoge algo del suelo.`,
    eventRoomId: room.id,
  };
}

/**
 * use <ítem> — Usar un ítem del inventario.
 */
function cmdUse(player, itemQuery) {
  if (!itemQuery || !itemQuery.trim()) {
    return { text: 'Indicá qué querés usar. Ej: "use poción".' };
  }

  player = db.getPlayer(player.id);

  const found = items.findItem(player.inventory, itemQuery.trim());
  if (!found) {
    return { text: `No tenés ningún "${itemQuery}" en el inventario.` };
  }

  const def = items.getItemDef(found);
  if (!def) {
    return { text: `Usás ${found} pero no pasa nada en particular.` };
  }

  let resultText;

  if (def.type === 'potion' && def.effect === 'heal') {
    const oldHp = player.hp;
    const newHp = Math.min(player.max_hp, player.hp + def.amount);
    db.updatePlayer(player.id, { hp: newHp });

    // Consumir el ítem
    const newInv = removeFirst(player.inventory, found);
    db.updatePlayer(player.id, { inventory: newInv });

    resultText = `Bebés la ${found}. Recuperás ${newHp - oldHp} HP. (${newHp}/${player.max_hp} HP)`;

  } else if (def.type === 'weapon') {
    // Equipar el arma: aumenta el ataque base del jugador
    // Primero, si ya tenía un arma equipada la "desequipa" (stat reset es simplístico en MVP)
    const newAttack = 5 + def.amount; // base 5 + bonus del arma
    db.updatePlayer(player.id, { attack: newAttack, equipped_weapon: found });

    resultText = `Equipás ${found}. Tu ataque sube a ${newAttack}.`;

  } else {
    resultText = `Examinás ${found}: ${def.description}`;
  }

  return {
    text: resultText,
    event: `${player.username} usa un ítem.`,
    eventRoomId: player.current_room_id,
  };
}

/**
 * drop <ítem> — Tirar un ítem del inventario al suelo de la habitación.
 */
function cmdDrop(player, itemQuery) {
  if (!itemQuery || !itemQuery.trim()) {
    return { text: 'Indicá qué querés tirar. Ej: "drop espada".' };
  }

  player = db.getPlayer(player.id);

  const found = items.findItem(player.inventory, itemQuery.trim());
  if (!found) {
    return { text: `No tenés ningún "${itemQuery}" en el inventario.` };
  }

  // Quitar del inventario
  const newInv = removeFirst(player.inventory, found);
  const updates = { inventory: newInv };

  // Si era el arma equipada, desequipar (volver a ataque base)
  if (player.equipped_weapon && player.equipped_weapon === found) {
    updates.equipped_weapon = null;
    updates.attack = 5;
  }

  db.updatePlayer(player.id, updates);

  // Agregar al suelo de la habitación
  const room = db.getRoom(player.current_room_id);
  if (room) {
    db.updateRoomItems(room.id, [...room.items, found]);
  }

  const extraMsg = updates.equipped_weapon === null ? ' Ya no tenés ningún arma equipada (ataque: 5).' : '';

  return {
    text: `Dejás ${found} en el suelo.${extraMsg}`,
    event: `${player.username} tira algo al suelo.`,
    eventRoomId: player.current_room_id,
  };
}

/**
 * examine <objetivo> — Examinar un monstruo, ítem o la sala con más detalle.
 */
function cmdExamine(player, query) {
  player = db.getPlayer(player.id);

  // Sin argumento → examinar la sala (alias de look pero más detallado)
  if (!query || !query.trim()) {
    const room = db.getRoom(player.current_room_id);
    if (!room) return { text: 'Error: no podés examinar esta habitación.' };
    const monsters = db.getMonstersInRoom(room.id);
    const monsterLines = monsters.map(m => {
      const bar = buildBar(m.hp, m.max_hp, 10);
      return `  • ${m.name} ${bar} ${m.hp}/${m.max_hp} HP — ${m.description}`;
    });
    const itemLines = (room.items || []).map(i => `  • ${i}`);
    const parts = [
      `=== ${room.name.toUpperCase()} (detalle) ===`,
      room.description,
    ];
    if (monsterLines.length) parts.push('\nCriaturas:', ...monsterLines);
    if (itemLines.length)    parts.push('\nObjetos:', ...itemLines);
    return { text: parts.join('\n') };
  }

  const qLow = query.trim().toLowerCase();

  // ¿Es un monstruo en la habitación?
  const monsters = db.getMonstersInRoom(player.current_room_id);
  const monster = monsters.find(m => m.name.toLowerCase().includes(qLow));
  if (monster) {
    const bar = buildBar(monster.hp, monster.max_hp, 20);
    return {
      text: [
        `=== ${monster.name.toUpperCase()} ===`,
        monster.description,
        `HP: ${bar} ${monster.hp}/${monster.max_hp}`,
        `Ataque: ${monster.attack}`,
        monster.loot && monster.loot.length
          ? `Posible loot: ${monster.loot.join(', ')}`
          : 'No parece llevar nada de valor.',
      ].join('\n'),
    };
  }

  // ¿Es un ítem en el inventario o en el suelo?
  const room = db.getRoom(player.current_room_id);
  const allItems = [...(player.inventory || []), ...(room ? room.items : [])];
  const itemName = items.findItem(allItems, query.trim());
  if (itemName) {
    const def = items.getItemDef(itemName);
    if (def) {
      const typeLabel = def.type === 'weapon' ? 'Arma' : def.type === 'potion' ? 'Poción' : 'Objeto';
      return {
        text: [
          `=== ${itemName.toUpperCase()} ===`,
          def.description,
          `Tipo: ${typeLabel}`,
          def.amount !== undefined ? `Efecto: ${def.effect || 'daño'} ${def.amount > 0 ? '+' : ''}${def.amount}` : '',
        ].filter(Boolean).join('\n'),
      };
    }
    return { text: `Examinás ${itemName}: es un objeto corriente.` };
  }

  return { text: `No ves ningún "${query}" aquí para examinar.` };
}

/**
 * equip <arma> — Equipar un arma del inventario explícitamente.
 * Separado de `use` para mayor claridad. Solo funciona con ítems tipo 'weapon'.
 */
function cmdEquip(player, itemQuery) {
  if (!itemQuery || !itemQuery.trim()) {
    return { text: 'Indicá qué arma querés equipar. Ej: "equip espada".' };
  }

  player = db.getPlayer(player.id);

  const found = items.findItem(player.inventory, itemQuery.trim());
  if (!found) {
    return { text: `No tenés ningún "${itemQuery}" en el inventario.` };
  }

  const def = items.getItemDef(found);
  if (!def || def.type !== 'weapon') {
    return { text: `${found} no es un arma que puedas equipar.` };
  }

  const oldAttack = player.attack;
  const newAttack = 5 + def.amount; // base 5 + bonus del arma
  db.updatePlayer(player.id, { attack: newAttack, equipped_weapon: found });

  const change = newAttack - oldAttack;
  const changeStr = change >= 0 ? `+${change}` : `${change}`;

  return {
    text: `Empuñás ${found}. Ataque: ${oldAttack} → ${newAttack} (${changeStr}).\n${def.description}`,
    event: `${player.username} empuña ${found}.`,
    eventRoomId: player.current_room_id,
  };
}

/**
 * who — Listar jugadores activos en el dungeon (vistos en los últimos 5 min).
 */
function cmdWho() {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const active = db.getActivePlayers(cutoff);

  if (active.length === 0) {
    return { text: 'No hay ningún aventurero activo en el dungeon ahora mismo.' };
  }

  const lines = [
    `=== AVENTUREROS EN EL DUNGEON (${active.length}) ===`,
    ...active.map(p => {
      const hpBar = buildBar(p.hp, p.max_hp, 8);
      const hpText = `${p.hp}/${p.max_hp}`;
      const level = p.level || 1;
      const deaths = p.deaths || 0;
      return `  ${p.username.padEnd(16)} Lv${String(level).padStart(2,' ')} ${hpBar} ${hpText.padStart(7)}  ☠${deaths}  │  ${p.room_name || 'Desconocido'}`;
    }),
    ``,
    `(jugadores activos en los últimos 5 minutos)`,
  ];

  return { text: lines.join('\n') };
}

/**
 * score — Tabla de líderes global ordenada por kills (luego XP, luego nivel).
 */
function cmdScore() {
  const leaders = db.getLeaderboard(10);

  if (leaders.length === 0) {
    return { text: 'Aún no hay aventureros en la tabla de líderes.' };
  }

  const lines = [
    `╔═══════════════════════════════════════════════════╗`,
    `║         🏆  TABLA DE LÍDERES — TOP 10  🏆         ║`,
    `╠═══════════════════════════════════════════════════╣`,
    `║  #   Aventurero        Lv    XP   Kills   HP      ║`,
    `╠═══════════════════════════════════════════════════╣`,
  ];

  leaders.forEach((p, idx) => {
    const rank   = String(idx + 1).padStart(2, ' ');
    const name   = (p.username || '???').substring(0, 14).padEnd(14, ' ');
    const level  = String(p.level || 1).padStart(3, ' ');
    const xp     = String(p.xp || 0).padStart(5, ' ');
    const kills  = String(p.kills || 0).padStart(5, ' ');
    const hp     = `${p.hp}/${p.max_hp}`.padStart(7, ' ');
    const medal  = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '  ';
    lines.push(`║ ${medal}${rank}  ${name}  ${level}  ${xp}  ${kills}  ${hp}  ║`);
  });

  lines.push(`╚═══════════════════════════════════════════════════╝`);

  return { text: lines.join('\n') };
}

/**
 * heal — Usar la primera poción del inventario (atajo rápido de combate).
 */
function cmdHeal(player) {
  player = db.getPlayer(player.id);

  // Buscar la primera poción en el inventario
  const potion = player.inventory.find(itemName => {
    const def = items.getItemDef(itemName);
    return def && def.type === 'potion' && def.effect === 'heal';
  });

  if (!potion) {
    return { text: 'No tenés ninguna poción en el inventario. (Buscá pociones de salud o de vida).' };
  }

  // Delegar a cmdUse
  return cmdUse(player, potion);
}

/**
 * loot — Recoger todos los ítems del suelo de la sala de una vez.
 */
function cmdLoot(player) {
  player = db.getPlayer(player.id);
  const room = db.getRoom(player.current_room_id);

  if (!room) {
    return { text: 'Error: habitación no encontrada.' };
  }

  const floorItems = room.items || [];
  if (floorItems.length === 0) {
    return { text: 'No hay nada en el suelo para recoger.' };
  }

  // Transferir todos los ítems del suelo al inventario
  const newInventory = [...player.inventory, ...floorItems];
  db.updatePlayer(player.id, { inventory: newInventory });
  db.updateRoomItems(room.id, []);

  const lista = floorItems.map(i => `  • ${i}`).join('\n');

  return {
    text: `Recogés todo del suelo (${floorItems.length} ítem${floorItems.length !== 1 ? 's' : ''}):\n${lista}`,
    event: `${player.username} saquea el suelo de la sala.`,
    eventRoomId: room.id,
  };
}

/**
 * unequip — Guardar el arma equipada y volver a pelear con los puños.
 */
function cmdUnequip(player) {
  player = db.getPlayer(player.id);

  if (!player.equipped_weapon) {
    return { text: 'No tenés ningún arma equipada.' };
  }

  const weaponName = player.equipped_weapon;
  db.updatePlayer(player.id, { attack: 5, equipped_weapon: null });

  return {
    text: `Enfundás ${weaponName}. Volvés a pelear con los puños (ataque: 5).`,
    event: `${player.username} enfunda ${weaponName}.`,
    eventRoomId: player.current_room_id,
  };
}

/**
 * give <ítem> <jugador> — Pasar un ítem a otro jugador en la misma sala.
 *
 * Sintaxis: give espada larga Ana
 *   → args = ['espada', 'larga', 'Ana']
 *   → El último token es el nombre del jugador; el resto es el nombre del ítem.
 */
function cmdGive(player, args) {
  if (!args || args.length < 2) {
    return { text: 'Uso: give <ítem> <jugador>. Ej: "give espada Ana".' };
  }

  // Último argumento = nombre del jugador destinatario
  const targetName  = args[args.length - 1];
  const itemQuery   = args.slice(0, args.length - 1).join(' ');

  if (!itemQuery.trim()) {
    return { text: 'Indicá qué ítem querés dar.' };
  }

  player = db.getPlayer(player.id);

  // Buscar el ítem en el inventario del jugador
  const found = items.findItem(player.inventory, itemQuery.trim());
  if (!found) {
    return { text: `No tenés ningún "${itemQuery}" en el inventario.` };
  }

  // Buscar al jugador destinatario
  const target = db.getPlayerByUsername(targetName);
  if (!target) {
    return { text: `No existe ningún jugador llamado "${targetName}".` };
  }
  if (target.id === player.id) {
    return { text: 'No podés darte un ítem a vos mismo.' };
  }

  // Verificar que estén en la misma sala
  if (target.current_room_id !== player.current_room_id) {
    return { text: `${target.username} no está en esta sala.` };
  }

  // Transferir ítem
  const newGiverInv  = removeFirst(player.inventory, found);
  const newTargetInv = [...target.inventory, found];

  const giverUpdates = { inventory: newGiverInv };

  // Si el donante estaba usando el ítem como arma equipada, desequiparla
  if (player.equipped_weapon && player.equipped_weapon === found) {
    giverUpdates.equipped_weapon = null;
    giverUpdates.attack = 5;
  }

  db.updatePlayer(player.id,  giverUpdates);
  db.updatePlayer(target.id,  { inventory: newTargetInv });

  const extraMsg = giverUpdates.equipped_weapon === null ? ' (perdiste tu arma equipada, ataque vuelve a 5)' : '';

  return {
    text: `Le das ${found} a ${target.username}.${extraMsg}`,
    event: `${player.username} le da ${found} a ${target.username}.`,
    eventRoomId: player.current_room_id,
    targetPlayerId: target.id,
    targetPlayerMsg: `${player.username} te da ${found}.`,
  };
}

// ─── Whisper ─────────────────────────────────────────────────────────────────
/**
 * whisper <jugador> <mensaje> — Mensaje privado a otro jugador.
 * El destinatario recibe el mensaje vía Socket.io (campo targetPlayerId/targetPlayerMsg).
 * Si el jugador no está conectado, el mensaje igual se registra (el emisor lo ve).
 */
function cmdWhisper(player, args) {
  if (!args || args.length < 2) {
    return { text: 'Uso: whisper <jugador> <mensaje>. Ej: \"whisper Ana hola!\".' };
  }

  const targetName = args[0];
  const message    = args.slice(1).join(' ').trim();

  if (!message) {
    return { text: 'El mensaje no puede estar vacío.' };
  }

  const target = db.getPlayerByUsername(targetName);
  if (!target) {
    return { text: `No existe ningún jugador llamado "${targetName}".` };
  }
  if (target.id === player.id) {
    return { text: 'No podés enviarte un susurro a vos mismo.' };
  }

  const senderMsg = `[susurro → ${target.username}]: "${message}"`;
  const targetMsg = `[susurro de ${player.username}]: "${message}"`;

  // Registrar que player es el último que le escribió a target
  lastWhisperSender.set(target.id, { id: player.id, username: player.username });

  return {
    text: senderMsg,
    // Sin event de broadcast: es privado, no va a la sala
    targetPlayerId:   target.id,
    targetPlayerMsg:  targetMsg,
    targetEventType:  'whisper',
  };
}

// ─── Tell (whisper + persistencia offline) ───────────────────────────────────
/**
 * tell <jugador> <mensaje> — Mensaje privado con persistencia offline.
 * Si el destinatario está conectado, se entrega por Socket.io en tiempo real.
 * Si está desconectado, el mensaje se guarda en BD y se entrega al próximo login.
 */
function cmdTell(player, args) {
  if (!args || args.length < 2) {
    return { text: 'Uso: tell <jugador> <mensaje>. Ej: "tell Ana ¿dónde estás?".' };
  }

  const targetName = args[0];
  const message    = args.slice(1).join(' ').trim();

  if (!message) {
    return { text: 'El mensaje no puede estar vacío.' };
  }

  const target = db.getPlayerByUsername(targetName);
  if (!target) {
    return { text: `No existe ningún jugador llamado "${targetName}".` };
  }
  if (target.id === player.id) {
    return { text: 'No podés enviarte un tell a vos mismo.' };
  }

  const senderMsg = `[tell → ${target.username}]: "${message}"`;
  const targetMsg = `[tell de ${player.username}]: "${message}"`;

  // Guardar en BD por si el jugador no está online (notificación offline)
  db.saveOfflineMessage(player.username, target.id, message);

  // Registrar que player es el último que le escribió a target
  lastWhisperSender.set(target.id, { id: player.id, username: player.username });

  return {
    text: senderMsg,
    targetPlayerId:  target.id,
    targetPlayerMsg: targetMsg,
    targetEventType: 'tell',
  };
}

// ─── Reply (contestar el último susurro/tell recibido) ───────────────────────
/**
 * reply <mensaje> / responder <mensaje>
 * Contesta automáticamente al último jugador que envió un whisper o tell al
 * jugador actual, sin necesidad de escribir el nombre.
 */
function cmdReply(player, args) {
  const sender = lastWhisperSender.get(player.id);
  if (!sender) {
    return { text: 'No tenés ningún mensaje al que responder. Usá "whisper <jugador> <mensaje>".' };
  }

  const message = (args || []).join(' ').trim();
  if (!message) {
    return { text: `Uso: reply <mensaje>. Responderá a: ${sender.username}.` };
  }

  // Verificar que el destinatario aún exista en la BD
  const target = db.getPlayer(sender.id);
  if (!target) {
    lastWhisperSender.delete(player.id);
    return { text: `El jugador "${sender.username}" ya no existe.` };
  }

  const senderMsg = `[susurro → ${target.username}]: "${message}"`;
  const targetMsg = `[susurro de ${player.username}]: "${message}"`;

  // Al responder, el receptor pasa a ser ahora el "último que escribió" al emisor
  lastWhisperSender.set(target.id, { id: player.id, username: player.username });

  return {
    text: senderMsg,
    targetPlayerId:  target.id,
    targetPlayerMsg: targetMsg,
    targetEventType: 'whisper',
  };
}


/**
 * map — Mostrar mapa ASCII del dungeon con la sala actual marcada.
 * El layout es fijo para el dungeon de 15 salas actual.
 * La sala del jugador se muestra como [★NN] en lugar de [ NN].
 */
function cmdMap(player) {
  const here = player.current_room_id;

  // Abreviaciones para los nombres de sala (max 9 chars para el grid)
  const NAMES = {
    1:  'Entrada',
    2:  'Corredor',
    3:  'Sala Ecos',
    4:  'Tesoro',
    5:  'Capilla',
    6:  'Túnel',
    7:  'Pozo',
    8:  'Prisión',
    9:  'Trono',
    10: 'Santuario',
    11: 'Galería',
    12: 'Forja',
    13: 'Caverna',
    14: 'Coliseo',
    15: 'Catedral',
  };

  function cell(id) {
    const label = NAMES[id] || `Sala ${id}`;
    const marker = id === here ? '★' : ' ';
    return `[${marker}${String(id).padStart(2,' ')} ${label.substring(0,9).padEnd(9,' ')}]`;
  }

  const c = (id) => cell(id);

  // Layout visual del dungeon expandido:
  //
  //                                              [8-Prisión]
  //                                                   │
  // [7-Pozo]───[3-Ecos]───[4-Tesoro]     [12-Forja]───[14-Coliseo]───[15-Catedral]
  //    │                      │               │              │
  // [10-Santuario]──[9-Trono]──[6-Túnel]──[2-Corredor]  [13-Caverna]
  //    │                          │              │
  // [11-Galería]              [5-Capilla]─[1-Entrada]

  // Fila superior (3 salas): 8, luego 12-14-15 a la derecha
  // Fila media: 7-3-4 | | 10-9-6-2 | 12(conector)
  // Fila baja: 11 | 5-1

  const lines = [
    'MAPA DEL DUNGEON (15 salas)',
    '',
    // Fila top: Prisión (arriba de 4) y Forja/Coliseo/Catedral (zona nueva)
    `         ${c(8)}                   ${c(12)}───${c(14)}───${c(15)}`,
    `              │                        │         │`,
    // Fila principal izquierda + santuario/conexión + zonas nuevas
    `${c(7)}───${c(3)}───${c(4)}   ${c(10)}───${c(9)}───${c(6)}───${c(2)}   ${c(13)}`,
    `  │              │                    │         │`,
    `${c(11)}          ${c(5)}───${c(1)}               │`,
    `                                       └───zona expandida`,
    '',
    `★ = tu ubicación actual (sala ${here}: ${NAMES[here] || '?'})`,
  ];

  return { text: lines.join('\n') };
}

function buildBar(current, max, width) {
  const filled = Math.round((current / max) * width);
  const empty  = width - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
}

function removeFirst(arr, value) {
  const idx = arr.indexOf(value);
  if (idx === -1) return arr;
  return [...arr.slice(0, idx), ...arr.slice(idx + 1)];
}

/**
 * unlock <dirección> — Abrir una puerta bloqueada con llave del inventario.
 * La puerta queda abierta permanentemente en la BD para todos los jugadores.
 * La llave se consume del inventario.
 */
function cmdUnlock(player, direction) {
  if (!direction) {
    return { text: 'Indicá una dirección para abrir. Ej: "unlock norte".' };
  }

  const room = db.getRoom(player.current_room_id);
  if (!room) {
    return { text: 'Error: tu habitación actual no existe en la BD.' };
  }

  const normalized = dungeon.normalizeDirection(direction);
  if (!normalized) {
    return { text: `Dirección desconocida: "${direction}". Usá norte, sur, este u oeste.` };
  }

  const exitVal = room.exits[normalized];
  if (exitVal === undefined || exitVal === null) {
    const dirName = dungeon.DIR_NAMES[normalized] || normalized;
    return { text: `No hay salida hacia el ${dirName} desde aquí.` };
  }

  // ¿Está bloqueada?
  if (typeof exitVal !== 'object' || !exitVal.key) {
    const dirName = dungeon.DIR_NAMES[normalized] || normalized;
    return { text: `La salida hacia el ${dirName} ya está abierta. No necesitás ninguna llave.` };
  }

  const requiredKey = exitVal.key;
  const inventory = player.inventory || [];
  const keyIdx = inventory.findIndex(item => item.toLowerCase() === requiredKey.toLowerCase());

  if (keyIdx === -1) {
    const dirName = dungeon.DIR_NAMES[normalized] || normalized;
    return {
      text: `La puerta hacia el ${dirName} está cerrada. 🔒\nNecesitás: "${requiredKey}" para abrirla.`,
    };
  }

  // Consumir la llave del inventario
  const newInventory = [...inventory.slice(0, keyIdx), ...inventory.slice(keyIdx + 1)];
  db.updatePlayer(player.id, { inventory: newInventory });

  // Modificar la salida en la BD: reemplazar el objeto {room_id, key} por solo el número
  const newExits = { ...room.exits };
  newExits[normalized] = exitVal.room_id;
  db.upsertRoom({ ...room, exits: newExits });

  const dirName = dungeon.DIR_NAMES[normalized] || normalized;
  return {
    text: `Usás la "${requiredKey}" y la puerta cruje al abrirse. 🔓\nLa salida hacia el ${dirName} ahora está abierta para todos.`,
    event: `${player.username} abre la puerta hacia el ${dirName} con una llave.`,
    eventRoomId: player.current_room_id,
  };
}

/**
 * disarm / desactivar trampa — Desactivar la trampa de la habitación actual con el ítem correcto.
 * El ítem se consume del inventario. La trampa queda inactiva en la BD (para todos).
 */
function cmdDisarm(player) {
  player = db.getPlayer(player.id);
  const room = db.getRoom(player.current_room_id);
  if (!room) {
    return { text: 'Error: tu habitación actual no existe en la BD.' };
  }

  if (!room.trap) {
    return { text: 'No hay ninguna trampa activa en esta sala.' };
  }

  if (!room.trap.active) {
    return { text: 'La trampa de esta sala ya está desactivada.' };
  }

  const trap = room.trap;

  if (!trap.item_needed) {
    // Trampa sin ítem requerido — se puede desactivar directamente
    const newTrap = { ...trap, active: false };
    db.updateRoomTrap(room.id, newTrap);
    return {
      text: 'Inspeccionás el mecanismo y lo desactivás manualmente. La trampa queda inerte.',
      event: `${player.username} desactiva una trampa en la sala.`,
      eventRoomId: room.id,
    };
  }

  // Buscar el ítem requerido en el inventario
  const inventory = player.inventory || [];
  const keyIdx = inventory.findIndex(i => i.toLowerCase() === trap.item_needed.toLowerCase());

  if (keyIdx === -1) {
    return {
      text: `Intentás desactivar la trampa pero no tenés lo necesario.\n🔧 Ítem requerido: "${trap.item_needed}"`,
    };
  }

  // Consumir el ítem y desactivar la trampa
  const newInventory = [...inventory.slice(0, keyIdx), ...inventory.slice(keyIdx + 1)];
  db.updatePlayer(player.id, { inventory: newInventory });

  // Desactivar trampa y programar reactivación en 10 minutos
  const respawnAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const newTrap = { ...trap, active: false, respawn_at: respawnAt };
  db.updateRoomTrap(room.id, newTrap);

  return {
    text: `${trap.disarm_msg}\n✅ La trampa está desactivada. Usaste: "${trap.item_needed}".`,
    event: `${player.username} desactiva una trampa en la sala.`,
    eventRoomId: room.id,
  };
}

/**
 * rest / descansar — Recuperar HP si no hay monstruos en la sala.
 * Cooldown: 60 segundos entre usos.
 * Recupera entre 3 y 5 HP (aleatorio), sin superar max_hp.
 */
function cmdRest(player) {
  player = db.getPlayer(player.id);

  if (player.hp >= player.max_hp) {
    return { text: '💤 Ya estás al máximo de HP. No necesitás descansar.' };
  }

  // Verificar que no haya monstruos en la sala
  const monsters = db.getMonstersInRoom(player.current_room_id);
  if (monsters.length > 0) {
    const names = monsters.map(m => m.name).join(', ');
    return { text: `⚔️  No podés descansar con enemigos presentes: ${names}.` };
  }

  // Verificar cooldown (60 segundos)
  const COOLDOWN_MS = 60_000;
  if (player.last_rest) {
    const elapsed = Date.now() - new Date(player.last_rest).getTime();
    if (elapsed < COOLDOWN_MS) {
      const remaining = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
      return { text: `💤 Necesitás esperar ${remaining} segundo${remaining !== 1 ? 's' : ''} antes de descansar de nuevo.` };
    }
  }

  // Recuperar HP (3 a 5 HP)
  const heal = Math.floor(Math.random() * 3) + 3; // 3, 4 o 5
  const newHp = Math.min(player.max_hp, player.hp + heal);
  const restored = newHp - player.hp;

  db.updatePlayer(player.id, {
    hp: newHp,
    last_rest: new Date().toISOString(),
  });

  const hpBar = buildBar(newHp, player.max_hp, 20);

  return {
    text: `💤 Te recostás contra la pared y descansás un momento.\nRecuperás ${restored} HP. ${hpBar} ${newHp}/${player.max_hp} HP`,
  };
}

/**
 * emote / acción — Expresar una acción en tercera persona visible para todos en la sala.
 * Ej: `emote suspira profundo` → broadcast: "⭐ Ana suspira profundo"
 *     `emote mira las paredes con curiosidad` → broadcast: "⭐ Ana mira las paredes con curiosidad"
 */
function cmdEmote(player, action) {
  if (!action || action.trim().length === 0) {
    return { text: 'Uso: emote <acción>  — ej: emote inspecciona las paredes' };
  }

  const trimmed = action.trim();
  // Limitar longitud a 150 chars
  if (trimmed.length > 150) {
    return { text: '❌ El emote es demasiado largo (máx 150 caracteres).' };
  }

  const emoteText = `✨ ${player.username} ${trimmed}`;

  return {
    text: emoteText,                          // el jugador también lo ve
    event: emoteText,                         // broadcast a la sala
    eventRoomId: player.current_room_id,
  };
}

/**
 * Obtener o crear un jugador por username.
 * Devuelve el objeto jugador.
 */
function getOrCreatePlayer(username) {
  let player = db.getPlayerByUsername(username);
  if (!player) {
    player = db.createPlayer(username);
    console.log(`[engine] Nuevo jugador creado: ${username} (${player.id})`);
  }
  return player;
}

module.exports = { execute, getOrCreatePlayer };
