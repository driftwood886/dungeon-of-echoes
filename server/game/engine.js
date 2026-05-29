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
const { parse, HELP_TEXT } = require('./commands');
const combat  = require('./combat');
const items   = require('./items');

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
    case 'drop':      result = cmdDrop(player, action.args.join(' ')); break;
    case 'examine':   result = cmdExamine(player, action.args.join(' ')); break;
    case 'equip':     result = cmdEquip(player, action.args.join(' ')); break;
    case 'unequip':   result = cmdUnequip(player); break;
    case 'map':       result = cmdMap(player); break;
    case 'who':       result = cmdWho(); break;
    case 'score':     result = cmdScore(); break;
    case 'give':      result = cmdGive(player, action.args); break;
    case 'say':
      result = { text: 'El chat (say/shout) solo funciona por Socket.io. Conectate desde el browser para chatear.' };
      break;
    case 'shout':
      result = { text: 'El chat (say/shout) solo funciona por Socket.io. Conectate desde el browser para chatear.' };
      break;
    case 'help':      result = { text: HELP_TEXT }; break;
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

  const targetId = dungeon.resolveExit(room, direction);
  if (targetId === null) {
    const dirName = dungeon.DIR_NAMES[dungeon.normalizeDirection(direction)] || direction;
    return { text: `No hay salida hacia el ${dirName}. Salidas disponibles: ${dungeon.exitsText(room)}.` };
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

  return {
    text: `${moveText}\n${roomDesc}`,
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
  const xpBar  = buildBar(xp % 50, 50, 10);
  const weaponLine = player.equipped_weapon
    ? `Arma:     ${player.equipped_weapon}`
    : `Arma:     (desarmado — ataque base)`;

  const text = [
    `\n=== ${player.username.toUpperCase()} ===`,
    `Nivel:    ${level}  (${xp} XP total | kills: ${kills})`,
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
      return `  ${p.username.padEnd(16)} Lv${String(level).padStart(2,' ')} ${hpBar} ${hpText.padStart(7)}  │  ${p.room_name || 'Desconocido'}`;
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
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────
/**
 * map — Mostrar mapa ASCII del dungeon con la sala actual marcada.
 * El layout es fijo para el dungeon de 10 salas actual.
 * La sala del jugador se muestra como [★NN] en lugar de [ NN].
 */
function cmdMap(player) {
  const here = player.current_room_id;

  // Abreviaciones para los nombres de sala (max 12 chars para el grid)
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
  };

  function cell(id) {
    const label = NAMES[id] || `Sala ${id}`;
    const marker = id === here ? '★' : ' ';
    return `[${marker}${String(id).padStart(2,' ')} ${label.substring(0,9).padEnd(9,' ')}]`;
  }

  // Layout visual del dungeon (3 columnas × filas):
  //
  //  [7 Pozo]---[3 Ecos]---[4 Tesoro]
  //      |          |           |
  // [9 Trono]--[6 Túnel]--[2 Corredor]-- (8 Prisión arriba de 4)
  //      |          |           |
  //             [5 Capilla]-[1 Entrada]
  //
  // Representación simplificada en texto:

  const c = (id) => cell(id);
  const H = '───';
  const V = '│';

  // Calcular posición horizontal de cada celda (15 chars + 3 de ─── separador = 18 por bloque)
  // Fila principal: 10─9─6─2─3─4 (izq a derecha)
  // Centro celda N en esa fila: N*18+7 donde N=0,1,2,3,4,5
  // c10@0, c9@18, c6@36, c2@54, c3@72, c4@90
  const pad = (n) => ' '.repeat(n);
  const CELL_W = 15; // ancho de cada celda
  const SEP_W  = 3;  // ancho de ─── 
  const BLOCK  = CELL_W + SEP_W; // 18

  // Centro de cada celda en la fila principal
  const center = (col) => col * BLOCK + Math.floor(CELL_W / 2); // col 0..5

  // Sala 8 está arriba de sala 4 (col 5, centro = 97)
  // Sala 7 está debajo de sala 10 (col 0, centro = 7)
  // Sala 5-1 están debajo de sala 6-2 (col 2 y 3, centros = 43 y 61)

  const c8_start = center(5) - Math.floor(CELL_W / 2); // 97 - 7 = 90
  const c7_start = 0;        // debajo de c10 (col 0)
  const c5_start = center(2) - Math.floor(CELL_W / 2); // 43 - 7 = 36
  const c1_start = center(3) - Math.floor(CELL_W / 2); // 61 - 7 = 54

  const row_8    = pad(c8_start) + c(8);
  const pipe_8   = pad(center(5)) + '│';
  const row_main = `${c(10)}───${c(9)}───${c(6)}───${c(2)}───${c(3)}───${c(4)}`;
  const pipes_76 = pad(center(0)) + '│' + pad(center(2) - center(0) - 1) + '│';
  const row_71   = pad(c7_start) + c(7) + pad(c5_start - c7_start - CELL_W) + c(5) + '───' + c(1);

  const lines = [
    `MAPA DEL DUNGEON`,
    ``,
    row_8,
    pipe_8,
    row_main,
    pipes_76,
    row_71,
    ``,
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
