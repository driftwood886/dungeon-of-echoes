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
const ach     = require('./achievements');
const quests  = require('./quests');
const worldEvents = require('./worldEvents');
const tutorial = require('./tutorial');
const crafting = require('./crafting');
const classes  = require('./classes'); // T107: sistema de clases
const skills   = require('./skills');  // T114: habilidades activas por nivel

// ── Efectos pasivos de sala (T087) ────────────────────────────────────────────
// Cada sala puede tener un efecto que se aplica al entrar.
// type: 'damage' | 'heal' | 'buff' | 'debuff'
const ROOM_EFFECTS = {
  // Sala 9 — Sala del Trono: frío sobrenatural (ya tiene trampa, además debuffa ATK)
  9:  { type: 'debuff', stat: 'attack', amount: -1, label: '🥶 Frío sobrenatural', msg: 'El frío sobrenatural te entumece los músculos. (-1 ATK mientras estés aquí)' },
  // Sala 12 — Forja del Glaciar: hielo extremo daña al entrar
  12: { type: 'damage', amount: 2, label: '❄️ Congelación', msg: '❄️ El frío glacial de la forja te quema la piel. (-2 HP)' },
  // Sala 1 — Entrada del Santuario: aura sagrada regenera HP
  1:  { type: 'heal', amount: 3, label: '✨ Aura Sagrada', msg: '✨ El aura sagrada de la entrada te reconforta. (+3 HP)' },
  // Sala 15 — Catedral Maldita: maldición drena HP
  15: { type: 'damage', amount: 3, label: '💀 Maldición del Lich', msg: '💀 Una maldición oscura te drena la vitalidad al entrar. (-3 HP)' },
};

// ── Registro en memoria: último remitente de whisper/tell por jugador ─────────
// lastWhisperSender.get(playerId) → { id, username } del último que les escribió
const lastWhisperSender = new Map();

// ── Sistema de duelos PvP (T089) ──────────────────────────────────────────────
// pendingDuels.get(targetPlayerId) → { challengerId, challengerUsername, roomId, expiresAt }
const pendingDuels = new Map();

// ── Sistema de grupos/party (T102) ────────────────────────────────────────────
// pendingPartyInvites.get(targetPlayerId) → { inviterId, inviterUsername, partyId, expiresAt }
const pendingPartyInvites = new Map();

// ── Fuente de Rejuvenecimiento (T103) ─────────────────────────────────────────
// Sala 18 — Cámara de la Fuente Eterna.
// Cooldown global: 10 minutos por sala (no por jugador).
const FOUNTAIN_ROOM_ID = 18;
const FOUNTAIN_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutos
let fountainCooldownUntil = 0; // timestamp en ms (0 = disponible)

// ── Sistema de títulos/rangos (T099) ─────────────────────────────────────────
// Título calculado on-the-fly a partir de los kills del jugador.
const TITLES = [
  { min: 0,   label: 'Novato',     icon: '🌱' },
  { min: 5,   label: 'Explorador', icon: '🗺️' },
  { min: 15,  label: 'Guerrero',   icon: '⚔️' },
  { min: 40,  label: 'Veterano',   icon: '🛡️' },
  { min: 80,  label: 'Campeón',    icon: '🏆' },
  { min: 150, label: 'Leyenda',    icon: '🌟' },
];

/**
 * Devuelve el título del jugador basado en sus kills.
 * @param {number} kills
 * @returns {{ label: string, icon: string, full: string }}
 */
function getTitle(kills) {
  let title = TITLES[0];
  for (const t of TITLES) {
    if (kills >= t.min) title = t;
  }
  return { label: title.label, icon: title.icon, full: `${title.icon} ${title.label}` };
}

/**
 * Ejecuta un comando de texto para un jugador y devuelve el resultado.
 *
 * @param {string} playerId — ID del jugador (debe existir en la BD)
 * @param {string} input    — texto crudo
 * @returns {{ text: string, event?: string }}
 *   - text: respuesta para el jugador
 *   - event: descripción del evento para broadcast (opcional)
 */
function execute(playerId, input, context) {
  const player = db.getPlayer(playerId);
  if (!player) {
    return { text: 'Error: jugador no encontrado.' };
  }

  db.touchPlayer(playerId);

  const action = parse(input);

  // ── Lógica de tutorial (T091) ──────────────────────────────────────────────
  const tutorialStep = player.tutorial_step;
  if (tutorialStep && tutorialStep > 0 && player.current_room_id === tutorial.TUTORIAL_ROOM_ID) {
    const tutResult = handleTutorialCommand(player, action, tutorialStep);
    if (tutResult) {
      db.logEvent(playerId, player.current_room_id, input, tutResult.text.slice(0, 200));
      return tutResult;
    }
  }

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
    case 'score':     result = cmdScore(player, action.args); break;
    case 'give':      result = cmdGive(player, action.args); break;
    case 'pay':       result = cmdPay(player, action.args); break;
    case 'loot':      result = cmdLoot(player); break;
    case 'whisper':   result = cmdWhisper(player, action.args); break;
    case 'tell':      result = cmdTell(player, action.args); break;
    case 'reply':     result = cmdReply(player, action.args); break;
    case 'unlock':    result = cmdUnlock(player, action.args[0]); break;
    case 'disarm':    result = cmdDisarm(player); break;
    case 'rest':      result = cmdRest(player); break;
    case 'meditate':  result = cmdMeditate(player); break;
    case 'emote':     result = cmdEmote(player, action.args.join(' ')); break;
    case 'dice':      result = cmdDice(player, action.args.join(' ')); break;
    case 'party':     result = cmdParty(player, action.args); break;
    case 'shop':      result = cmdShop(player); break;
    case 'buy':       result = cmdBuy(player, action.args.join(' ')); break;
    case 'sell':      result = cmdSell(player, action.args.join(' ')); break;
    case 'achievements': result = cmdAchievements(player); break;
    case 'inspect':      result = cmdInspect(player, action.args.join(' ')); break;
    case 'quest':        result = cmdQuest(player); break;
    case 'guild':        result = cmdGuild(player, action.args); break;
    case 'gc':           result = cmdGuildChat(player, action.args); break;
    case 'duel':         result = cmdDuel(player, action.args.join(' ')); break;
    case 'accept':       result = cmdAcceptDuel(player); break;
    case 'decline':      result = cmdDeclineDuel(player); break;
    case 'world':        result = cmdWorld(); break;
    case 'craft':        result = cmdCraft(player, action.args); break;
    case 'recipes':      result = cmdRecipes(); break;
    case 'news':         result = cmdNews(); break;
    case 'forage':       result = cmdForage(player); break;
    case 'pet':          result = cmdPet(player, action.args); break;
    case 'auction':      result = cmdAuction(player, action.args); break;
    case 'bid':          result = cmdBid(player, action.args); break;
    case 'auctions':     result = cmdAuctions(); break;
    case 'drink':        result = cmdDrink(player); break;
    case 'cast':         result = cmdCast(player, action.args); break;
    case 'spells':       result = cmdSpells(player); break;
    case 'clase':        result = cmdClase(player, action.args); break;
    case 'bestiary':     result = cmdBestiary(player); break;
    case 'profile':      result = cmdProfile(player); break;
    case 'journal':      result = cmdJournal(player); break;
    case 'skills':       result = cmdSkills(player); break;
    case 'useSkill':     result = cmdUseSkill(player, action.args, context); break;
    case 'note':         result = cmdNote(player, action.args); break;
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
          inspect: 'inspect', inspeccionar: 'inspect', observar: 'inspect',
          news: 'news', cronica: 'news', crónica: 'news', noticias: 'news', historial: 'news',
          forage: 'forage', buscar: 'forage', explorar: 'forage', hurgar: 'forage', rebuscar: 'forage',
          auction: 'auction', subasta: 'auction', subastar: 'auction',
          bid: 'bid', pujar: 'bid',
          auctions: 'auctions', subastas: 'auctions',
          dice: 'dice', dado: 'dice', dados: 'dice', roll: 'dice',
          party: 'party', grupo: 'party', equipo: 'party',
          drink: 'drink', beber: 'drink', tomar: 'drink',
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

// ── Manejo de pasos del tutorial (T091) ───────────────────────────────────────
/**
 * Procesa un comando cuando el jugador está en el tutorial.
 * Devuelve un resultado si el tutorial lo intercepta, o null si debe seguir el flujo normal.
 */
function handleTutorialCommand(player, action, step) {
  const cmd = action.command;

  // Siempre se pueden ejecutar look y status en el tutorial (paso 1 requiere look)
  if (cmd === 'look') {
    // Ejecutar look normalmente, pero si estamos en paso 1 avanzar al paso 2
    const lookResult = cmdLook(player);
    if (step === 1) {
      db.updatePlayer(player.id, { tutorial_step: 2 });
      const hint = tutorial.getStepMessage(2);
      return { text: lookResult.text + '\n\n' + hint };
    }
    // En pasos siguientes, look funciona normalmente (no interceptar)
    return null;
  }

  if (cmd === 'attack') {
    // Avanzar a paso 3 al iniciar el primer ataque (si estamos en paso 2)
    if (step === 2) {
      db.updatePlayer(player.id, { tutorial_step: 3 });
    }
    // Dejar que el combate normal se ejecute — retornar null para no interceptar
    return null;
  }

  if (cmd === 'move') {
    // Si el jugador quiere salir al dungeon, completar el tutorial
    const dir = (action.args[0] || '').toLowerCase();
    const isSouth = ['south', 'sur', 's'].includes(dir);
    if (isSouth) {
      // Completar tutorial: +10 XP, mover a sala 1, tutorial_step = 0
      return completeTutorial(player);
    }
    // Intentar moverse en dirección inválida dentro de la antesala
    return { text: 'La única salida de la Antesala es hacia el sur (al dungeon real). Primero completá el entrenamiento o escribí «sur» para saltar el tutorial.' };
  }

  // Si el jugador hace help, status, inventory — dejar fluir normalmente
  if (['help', 'status', 'inventory', 'clear'].includes(cmd)) {
    return null;
  }

  // Para cualquier otro comando, recordar el estado del tutorial
  const hint = tutorial.getStepMessage(step);
  if (hint) {
    return {
      text: `Comando recibido, pero primero completá el tutorial:\n${hint}`,
    };
  }

  return null; // dejar fluir
}

/**
 * Completa el tutorial: otorga +10 XP, mueve al jugador a sala 1, marca tutorial_step = 0.
 */
function completeTutorial(player) {
  const xp = (player.xp || 0) + 10;
  const level = Math.floor(xp / 50) + 1;
  db.updatePlayer(player.id, {
    tutorial_step: 0,
    current_room_id: 1,
    xp,
    level,
  });
  return {
    text: tutorial.COMPLETE_MSG,
    event: `${player.username} emerge de la Antesala. ¡Un aventurero nuevo llega al dungeon!`,
    eventRoomId: 1,
  };
}

// ─── Comandos ──────────────────────────────────────────────────────────────

/**
 * look — Describe la habitación actual.
 */
function cmdLook(player) {
  const text = dungeon.describeRoom(player.current_room_id, player.id);
  // Mostrar efecto de sala si existe
  const roomEffect = ROOM_EFFECTS[player.current_room_id];
  const effectLine = roomEffect ? `\n🌐 Efecto de sala: ${roomEffect.label}` : '';
  return { text: text + effectLine };
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

  // T115: Registrar sala visitada para logro secreto Cartógrafo
  db.trackRoomVisit(player.id, targetId);
  const freshForCartog = db.getPlayer(player.id);
  if (freshForCartog) {
    const cartogAchs = ach.checkAchievements(freshForCartog, {});
    // Los nuevos logros se notificarán en la respuesta si los hay
  }

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

  // ── Efecto pasivo de sala (T087) ─────────────────────────────────────────
  let effectText = '';
  const roomEffect = ROOM_EFFECTS[targetId];
  if (roomEffect) {
    player = db.getPlayer(player.id);
    if (roomEffect.type === 'damage') {
      const newHp = Math.max(1, player.hp - roomEffect.amount); // mínimo 1 HP (no mata)
      db.updatePlayer(player.id, { hp: newHp });
      effectText = `\n\n${roomEffect.msg} (${newHp}/${player.max_hp} HP)`;
    } else if (roomEffect.type === 'heal') {
      const newHp = Math.min(player.max_hp, player.hp + roomEffect.amount);
      db.updatePlayer(player.id, { hp: newHp });
      effectText = `\n\n${roomEffect.msg} (${newHp}/${player.max_hp} HP)`;
    } else if (roomEffect.type === 'debuff') {
      // Debuff temporal narrativo — en futuro se integraría con status_effects
      effectText = `\n\n${roomEffect.msg}`;
    }
  }

  return {
    text: `${moveText}\n${roomDesc}${trapText}${effectText}`,
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
  const gold   = player.gold   || 0;
  const duelWins   = player.duel_wins   || 0;
  const duelLosses = player.duel_losses || 0;
  const xpBar  = buildBar(xp % 50, 50, 10);
  const weaponLine = player.equipped_weapon
    ? `Arma:     ${player.equipped_weapon}`
    : `Arma:     (desarmado — ataque base)`;

  // Efectos de estado activos
  const statusFx = player.status_effects || {};
  const statusLines = [];
  if (statusFx.poisoned) {
    statusLines.push(`☠ ENVENENADO — ${statusFx.poisoned.turns} turno(s) restante(s) (${statusFx.poisoned.damage} dmg/turno). Usá "use antídoto" para curarte.`);
  }

  const text = [
    `\n=== ${player.username.toUpperCase()} ===`,
    `Título:   ${getTitle(kills).full}`,
    player.player_class && player.player_class !== 'sin_clase'
      ? `Clase:    ${(classes.getPlayerClass(player) || {}).emoji || ''} ${(classes.getPlayerClass(player) || {}).name || player.player_class}`
      : `Clase:    (sin clase — usá "clase" para elegir)`,
    `Nivel:    ${level}  (${xp} XP total | kills: ${kills} | muertes: ${deaths})`,
    `XP sig.:  ${xpBar} ${xp % 50}/50`,
    `HP:       ${hpBar} ${player.hp}/${player.max_hp}`,
    `Ataque:   ${player.attack}`,
    `Defensa:  ${player.defense}`,
    `Oro:      💰 ${gold}g`,
    weaponLine,
    `Duelos:   ⚔️ ${duelWins} ganados / ${duelLosses} perdidos`,
    `Ubicación: ${roomName}`,
    player.guild ? `Hermandad: [${player.guild}]` : `Hermandad: (sin guild)`,
    player.pet   ? `Mascota:   ${player.pet}` : `Mascota:   (sin compañero)`,
    ...(statusLines.length ? ['', ...statusLines] : []),
  ].join('\n');

  // Agregar íconos de logros al final
  const achIcons = ach.formatAchievementIcons(player);
  const achLine = `Logros:   ${achIcons}`;

  return { text: text + '\n' + achLine };
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

  const combatResult = combat.attackRound(player, monster);
  const { lines, monsterDead, playerDead, globalEvent } = combatResult;

  let eventText = null;
  if (monsterDead) {
    eventText = `${player.username} derrota al ${monster.name}.`;
  } else if (playerDead) {
    eventText = `${player.username} fue derrotado por el ${monster.name}.`;
  } else {
    eventText = `${player.username} combate contra el ${monster.name}.`;
  }

  // ── Actualizar bestiario personal (T108) ─────────────────────────────────
  if (monsterDead) {
    db.addBestiaryKill(player.id, monster.name);
  }

  // ── Evaluar logros tras el combate ──────────────────────────────────────
  let achLines = '';
  const freshForAch = db.getPlayer(player.id);
  if (freshForAch) {
    const bossKill = monsterDead && !!(combat.BOSS_MONSTERS && combat.BOSS_MONSTERS[monster.id]);
    const poisonSurvived = !!(combatResult && combatResult.poisonSurvived);
    const newAchs = ach.checkAchievements(freshForAch, { bossKill, poisonSurvived });
    achLines = ach.formatNewAchievements(newAchs);

    // ── Registrar eventos globales (T093) ───────────────────────────────────
    if (bossKill) {
      db.logGlobalEvent('boss', `⚔️ ${player.username} derrotó al ${monster.name} y lo mandó al abismo.`);
      // T113: Diario del aventurero
      db.addJournalEntry(player.id, 'boss', `☠️ Derrotaste al ${monster.name}.`);
    }
    // Logros nuevos → registrar el primero en la crónica
    if (newAchs && newAchs.length > 0) {
      db.logGlobalEvent('achievement', `🏅 ${player.username} desbloqueó el logro "${newAchs[0].name}".`);
      // T113: Diario — registrar cada logro nuevo
      for (const a of newAchs) {
        db.addJournalEntry(player.id, 'achievement', `🏅 Logro desbloqueado: "${a.name}".`);
      }
    }
    // Subida de nivel a múltiplos de 5
    const newLevel = freshForAch.level || 1;
    if (monsterDead && newLevel >= 5 && newLevel % 5 === 0) {
      const prevLevel = newLevel - 1;
      if (prevLevel < newLevel && prevLevel % 5 !== 0 || (freshForAch.xp || 0) % 50 < 10) {
        db.logGlobalEvent('level', `⬆️ ${player.username} alcanzó el nivel ${newLevel}. ¡Un aventurero formidable!`);
      }
    }
    // T113: Registrar en diario toda subida de nivel
    if (monsterDead) {
      const prevLevelForJournal = player.level || 1;
      if (newLevel > prevLevelForJournal) {
        db.addJournalEntry(player.id, 'level', `⬆️ Subiste al nivel ${newLevel}.`);
      }
    }
  }

  // ── Progreso de quest ────────────────────────────────────────────────────
  let questLines = '';
  if (monsterDead) {
    const freshForQuest = db.getPlayer(player.id);
    const qResult = quests.recordProgress(freshForQuest, 'kill', { monsterName: monster.name });
    if (qResult) {
      db.updatePlayer(player.id, { quest_progress: qResult.questProgress });
      if (qResult.justCompleted && qResult.reward) {
      const r = qResult.reward;
      const freshQ2 = db.getPlayer(player.id);
      db.updatePlayer(player.id, {
        gold: (freshQ2.gold || 0) + r.gold,
        xp: (freshQ2.xp || 0) + r.xp,
      });
      questLines = `\n\n🎉 ¡Quest completada! Recibís ${r.gold}g y ${r.xp} XP de recompensa.`;
      // Registrar en crónica global (T093)
      db.logGlobalEvent('quest', `📜 ${player.username} completó la misión y ganó ${r.gold}g + ${r.xp} XP.`);
      // T113: Diario
      db.addJournalEntry(player.id, 'quest', `📜 Quest completada: +${r.gold}g, +${r.xp} XP.`);
      } else {
        const info = quests.getPlayerProgress(db.getPlayer(player.id));
        if (info && !info.completed) {
          questLines = `\n📜 Quest: ${qResult.newProgress}/${info.goal} — ¡Seguí así!`;
        }
      }
    }
  }

  // ── XP compartido con el grupo (T102) ────────────────────────────────────
  let partyXpLines = '';
  if (monsterDead) {
    const freshP = db.getPlayer(player.id);
    if (freshP.party_id) {
      const allMembers = db.getPartyMembers(freshP.party_id);
      // Solo los que están en la misma sala (excluir al jugador que ya recibió XP)
      const companions = allMembers.filter(m => m.id !== player.id && m.current_room_id === player.current_room_id);
      if (companions.length > 0) {
        // XP compartido: 75% de lo que recibió el atacante (bonus por cooperar)
        const xpBase = Math.max(5, Math.floor(monster.max_hp * 2));
        const sharedXp = Math.max(1, Math.floor(xpBase * 0.75));
        const bonusLines = [];
        for (const comp of companions) {
          const freshComp = db.getPlayer(comp.id);
          if (!freshComp) continue;
          const newXp    = (freshComp.xp    || 0) + sharedXp;
          const newLevel = Math.floor(newXp / 50) + 1;
          const levelUp  = newLevel > (freshComp.level || 1);
          const upd = { xp: newXp, level: newLevel };
          if (levelUp) {
            upd.max_hp = (freshComp.max_hp || 30) + 5;
            upd.hp     = Math.min(freshComp.hp, upd.max_hp);
            upd.attack = (freshComp.attack || 5) + 1;
          }
          db.updatePlayer(comp.id, upd);
          bonusLines.push(`  ${comp.username}: +${sharedXp} XP${levelUp ? ` ✨ ¡SUBE AL NIVEL ${newLevel}!` : ''}`);
        }
        if (bonusLines.length > 0) {
          partyXpLines = `\n⚔ XP de grupo compartida:\n${bonusLines.join('\n')}`;
        }
      }
    }
  }

  return {
    text: lines.join('\n') + achLines + questLines + partyXpLines,
    event: eventText,
    eventRoomId: player.current_room_id,
    globalEvent: globalEvent || null,
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

  // Refrescar jugador
  player = db.getPlayer(player.id);

  // Ítems de oro: se convierten en monedas reales en lugar de ir al inventario
  const GOLD_ITEMS = {
    'monedas de oro': 10,
    'monedas': 5,
    'oro': 15,
    'bolsa de monedas': 25,
    'cofre de oro': 50,
  };
  const goldKey = Object.keys(GOLD_ITEMS).find(k => found.toLowerCase().includes(k) || k.includes(found.toLowerCase()));
  if (goldKey) {
    const amount = GOLD_ITEMS[goldKey];
    const newGold = (player.gold || 0) + amount;
    db.updatePlayer(player.id, { gold: newGold });
    // Evaluar logros (podría ser 'rico')
    const freshAfterGold = db.getPlayer(player.id);
    const goldAchs = ach.checkAchievements(freshAfterGold, {});
    const goldAchLines = ach.formatNewAchievements(goldAchs);
    // Progreso de quest de oro
    let goldQuestLine = '';
    const qrGold = quests.recordProgress(freshAfterGold, 'gold', { amount });
    if (qrGold) {
      db.updatePlayer(player.id, { quest_progress: qrGold.questProgress });
      if (qrGold.justCompleted && qrGold.reward) {
        const r = qrGold.reward;
        const fq2 = db.getPlayer(player.id);
        db.updatePlayer(player.id, { gold: (fq2.gold || 0) + r.gold, xp: (fq2.xp || 0) + r.xp });
        goldQuestLine = `\n🎉 ¡Quest completada! Recibís ${r.gold}g y ${r.xp} XP de recompensa.`;
      }
    }
    return {
      text: `💰 Recogés ${found}. +${amount} monedas de oro. Tenés ${newGold}g en total.${goldAchLines}${goldQuestLine}`,
      event: `${player.username} recoge algo del suelo.`,
      eventRoomId: room.id,
    };
  }

  // Ítem normal: agregar al inventario del jugador
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
    if (player.hp >= player.max_hp) {
      return { text: `Ya estás al máximo de HP (${player.hp}/${player.max_hp}). Guardás la ${found}.` };
    }
    const newHp = Math.min(player.max_hp, player.hp + def.amount);
    db.updatePlayer(player.id, { hp: newHp });

    // Consumir el ítem
    const newInv = removeFirst(player.inventory, found);
    db.updatePlayer(player.id, { inventory: newInv });

    resultText = `Bebés la ${found}. Recuperás ${newHp - oldHp} HP. (${newHp}/${player.max_hp} HP)`;

  } else if (def.type === 'mana_potion' && def.effect === 'restore_mana') {
    // T104: Pociones de maná
    const currentMana = player.mana != null ? player.mana : 20;
    const maxMana = player.max_mana || 20;
    const newMana = Math.min(maxMana, currentMana + def.amount);
    const restored = newMana - currentMana;

    // Consumir el ítem
    const newInvM = removeFirst(player.inventory, found);
    db.updatePlayer(player.id, { inventory: newInvM, mana: newMana, last_mana_regen: new Date().toISOString() });

    resultText = restored > 0
      ? `💧 Bebés la ${found}. Recuperás ${restored} maná. (${newMana}/${maxMana} maná)`
      : `💧 Bebés la ${found} pero tu maná ya está al máximo.`;

  } else if (def.type === 'antidote' && def.effect === 'cure_poison') {
    const statusFx = player.status_effects || {};
    if (!statusFx.poisoned) {
      return { text: `Usás ${found} pero no estás envenenado. Guardás el antídoto... espera, ya lo consumiste.` };
    }
    delete statusFx.poisoned;
    // Consumir el ítem
    const newInv2 = removeFirst(player.inventory, found);
    db.updatePlayer(player.id, { inventory: newInv2, status_effects: JSON.stringify(statusFx) });
    resultText = `✅ Bebés el ${found}. El veneno se neutraliza de inmediato. Te sentís mejor.`;

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
      const guildTag = p.guild ? ` [${p.guild}]` : '';
      const titleIcon = getTitle(p.kills || 0).icon;
      return `  ${(p.username + guildTag).padEnd(22)} ${titleIcon} Lv${String(level).padStart(2,' ')} ${hpBar} ${hpText.padStart(7)}  ☠${deaths}  │  ${p.room_name || 'Desconocido'}`;
    }),
    ``,
    `(jugadores activos en los últimos 5 minutos)`,
  ];

  return { text: lines.join('\n') };
}

/**
 * score — Tabla de líderes. Sin args: kills+XP. Con args: "oro" o "duelos".
 * T112: Rankings extendidos
 */
function cmdScore(player, args) {
  const mode = (args && args[0]) ? args[0].toLowerCase() : '';

  if (mode === 'oro' || mode === 'gold' || mode === 'riqueza') {
    return cmdScoreGold();
  }
  if (mode === 'duelos' || mode === 'duel' || mode === 'duelo' || mode === 'pvp') {
    return cmdScoreDuels();
  }

  // Modo default: kills + XP
  const leaders = db.getLeaderboard(10);

  if (leaders.length === 0) {
    return { text: 'Aún no hay aventureros en la tabla de líderes.' };
  }

  const lines = [
    `╔═════════════════════════════════════════════════════╗`,
    `║          🏆  TABLA DE LÍDERES — TOP 10  🏆          ║`,
    `╠═════════════════════════════════════════════════════╣`,
    `║  #   Aventurero        Lv    XP  Kills  ☠Muertes   ║`,
    `╠═════════════════════════════════════════════════════╣`,
  ];

  leaders.forEach((p, idx) => {
    const rank   = String(idx + 1).padStart(2, ' ');
    const name   = (p.username || '???').substring(0, 14).padEnd(14, ' ');
    const level  = String(p.level || 1).padStart(3, ' ');
    const xp     = String(p.xp || 0).padStart(5, ' ');
    const kills  = String(p.kills || 0).padStart(5, ' ');
    const deaths = String(p.deaths || 0).padStart(8, ' ');
    const medal  = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '  ';
    lines.push(`║ ${medal}${rank}  ${name}  ${level}  ${xp}  ${kills}  ${deaths}  ║`);
  });

  lines.push(`╚═════════════════════════════════════════════════════╝`);
  lines.push(`  Subcategorías: "score oro" (riqueza) | "score duelos" (PvP)`);

  return { text: lines.join('\n') };
}

/**
 * T112: Ranking por riqueza (oro)
 */
function cmdScoreGold() {
  const leaders = db.getLeaderboardByGold(10);
  if (leaders.length === 0) {
    return { text: 'Aún no hay aventureros en la tabla de riqueza.' };
  }
  const lines = [
    `╔═════════════════════════════════════════╗`,
    `║    💰  RANKING DE RIQUEZA — TOP 10  💰  ║`,
    `╠═════════════════════════════════════════╣`,
    `║  #   Aventurero        Lv    Oro   Kills ║`,
    `╠═════════════════════════════════════════╣`,
  ];
  leaders.forEach((p, idx) => {
    const rank  = String(idx + 1).padStart(2, ' ');
    const name  = (p.username || '???').substring(0, 14).padEnd(14, ' ');
    const level = String(p.level || 1).padStart(3, ' ');
    const gold  = String(p.gold || 0).padStart(5, ' ');
    const kills = String(p.kills || 0).padStart(5, ' ');
    const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '  ';
    lines.push(`║ ${medal}${rank}  ${name}  ${level}  ${gold}g  ${kills} ║`);
  });
  lines.push(`╚═════════════════════════════════════════╝`);
  return { text: lines.join('\n') };
}

/**
 * T112: Ranking por duelos PvP
 */
function cmdScoreDuels() {
  const leaders = db.getLeaderboardByDuels(10);
  if (leaders.length === 0) {
    return { text: 'Aún no hay aventureros en la tabla de duelos.' };
  }
  const lines = [
    `╔═══════════════════════════════════════════╗`,
    `║  ⚔️  RANKING DE DUELOS PvP — TOP 10  ⚔️   ║`,
    `╠═══════════════════════════════════════════╣`,
    `║  #   Aventurero         Lv  Wins  Losses  ║`,
    `╠═══════════════════════════════════════════╣`,
  ];
  leaders.forEach((p, idx) => {
    const rank   = String(idx + 1).padStart(2, ' ');
    const name   = (p.username || '???').substring(0, 15).padEnd(15, ' ');
    const level  = String(p.level || 1).padStart(3, ' ');
    const wins   = String(p.duel_wins || 0).padStart(4, ' ');
    const losses = String(p.duel_losses || 0).padStart(6, ' ');
    const medal  = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '  ';
    lines.push(`║ ${medal}${rank}  ${name}  ${level}  ${wins}  ${losses}  ║`);
  });
  lines.push(`╚═══════════════════════════════════════════╝`);
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
    return { text: 'Uso: give <ítem> <jugador>. Ej: "give espada Ana". Para oro: "give 50 oro Ana" o "pay Ana 50".' };
  }

  // ── T111: Detectar transferencia de oro: "give <cantidad> oro <jugador>" ────
  // Formatos: "give 50 oro Ana", "give oro 50 Ana" (flexible)
  const lowerArgs = args.map(a => a.toLowerCase());
  const oroIdx = lowerArgs.indexOf('oro');
  if (oroIdx >= 0) {
    // Buscar el número y el nombre del destino
    const remaining = args.filter((_, i) => i !== oroIdx);
    const amountIdx = remaining.findIndex(a => /^\d+$/.test(a));
    if (amountIdx >= 0) {
      const amount = parseInt(remaining[amountIdx], 10);
      const nameArgs = remaining.filter((_, i) => i !== amountIdx);
      const targetName = nameArgs.join(' ').trim();
      if (targetName && amount > 0) {
        return cmdPayGold(player, amount, targetName);
      }
    }
    return { text: 'Uso para transferir oro: "give 50 oro Ana".' };
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

// ── T111: Transferencia de oro entre jugadores ──────────────────────────────
/**
 * cmdPayGold — Transferir oro a otro jugador (sin restricción de sala).
 * Llamado internamente por cmdGive y por el comando 'pay'.
 */
function cmdPayGold(player, amount, targetName) {
  player = db.getPlayer(player.id);
  if (!Number.isInteger(amount) || amount <= 0) {
    return { text: 'La cantidad de oro debe ser un número positivo.' };
  }

  const gold = player.gold || 0;
  if (gold < amount) {
    return { text: `No tenés suficiente oro. Tenés ${gold}g y querés enviar ${amount}g.` };
  }

  const target = db.getPlayerByUsername(targetName);
  if (!target) {
    return { text: `No existe ningún jugador llamado "${targetName}".` };
  }
  if (target.id === player.id) {
    return { text: 'No podés enviarte oro a vos mismo.' };
  }

  const targetGold = target.gold || 0;
  db.updatePlayer(player.id, { gold: gold - amount });
  db.updatePlayer(target.id, { gold: targetGold + amount });

  // Registrar en global_events
  db.logGlobalEvent('gold_transfer', `💰 ${player.username} transfirió ${amount}g a ${target.username}.`);

  return {
    text: `💰 Le enviás ${amount} monedas de oro a ${target.username}. Tu oro: ${gold - amount}g.`,
    targetPlayerId: target.id,
    targetPlayerMsg: `💰 ${player.username} te envió ${amount} monedas de oro. Tu oro: ${targetGold + amount}g.`,
  };
}

/**
 * pay <jugador> <cantidad> — Alias directo de transferencia de oro.
 * También soporta: pay <cantidad> <jugador>
 */
function cmdPay(player, args) {
  if (!args || args.length < 2) {
    return { text: 'Uso: pay <jugador> <cantidad>. Ej: "pay Ana 50".' };
  }
  // Detectar cuál es el número y cuál el nombre
  const numIdx = args.findIndex(a => /^\d+$/.test(a));
  if (numIdx < 0) {
    return { text: 'Indicá la cantidad de oro. Ej: "pay Ana 50".' };
  }
  const amount = parseInt(args[numIdx], 10);
  const nameArgs = args.filter((_, i) => i !== numIdx);
  const targetName = nameArgs.join(' ').trim();
  if (!targetName) {
    return { text: 'Indicá el jugador destinatario. Ej: "pay Ana 50".' };
  }
  return cmdPayGold(player, amount, targetName);
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

  // T105: Decoración según hora del servidor
  const hour = new Date().getUTCHours();
  let timeDecor;
  if (hour >= 6 && hour < 10) {
    timeDecor = '🌅 Amanecer  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ✦ ✦';
  } else if (hour >= 10 && hour < 17) {
    timeDecor = '☀️  Mediodía  ─────────────────────────────────';
  } else if (hour >= 17 && hour < 21) {
    timeDecor = '🌇 Atardecer ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ';
  } else {
    timeDecor = '🌙 Noche     ✦  ·  ✦  ·  ✦  ·  ✦  ·  ✦  ·  ✦';
  }

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
    timeDecor,
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
 * dice <NdM> — Tirar dados (T100).
 * Broadcast del resultado a toda la sala.
 *
 * @param {object} player
 * @param {string} notation — e.g. "2d6", "1d20", "d12"
 */
function cmdDice(player, notation) {
  if (!notation || !notation.trim()) {
    return { text: 'Uso: dados <NdM>  — ej: dados 2d6  /  dados 1d20' };
  }

  const raw = notation.trim().toLowerCase();

  // Parsear: opcional N, "d", M  (el prefijo "d" sin número es 1 dado)
  const match = raw.match(/^(\d+)?d(\d+)$/);
  if (!match) {
    return { text: `❌ Formato inválido. Usá NdM — ej: "2d6", "1d20", "d10"` };
  }

  const numDice = parseInt(match[1] || '1', 10);
  const sides   = parseInt(match[2], 10);

  // Límites razonables
  if (numDice < 1 || numDice > 10) {
    return { text: '❌ Podés tirar entre 1 y 10 dados.' };
  }
  if (sides < 2 || sides > 100) {
    return { text: '❌ Los dados deben tener entre 2 y 100 caras.' };
  }

  const rolls = [];
  for (let i = 0; i < numDice; i++) {
    rolls.push(Math.floor(Math.random() * sides) + 1);
  }
  const total = rolls.reduce((a, b) => a + b, 0);

  const rollStr = rolls.length > 1 ? `[${rolls.join(' + ')}] = ${total}` : `${total}`;
  const diceText = `🎲 ${player.username} tira ${numDice}d${sides}: ${rollStr}`;

  return {
    text: diceText,
    event: diceText,          // broadcast a la sala
    eventRoomId: player.current_room_id,
  };
}

/**
 * party [<subcomando>] — Gestionar grupo de aventureros (T102).
 *
 * Subcomandos:
 *   party <nombre>   — Invitar a alguien de la misma sala (o unirse a invitación pendiente)
 *   party leave      — Abandonar el grupo actual
 *   party           — Ver miembros del grupo
 *   party accept     — Aceptar la invitación pendiente de party
 *   party decline    — Rechazar la invitación
 *
 * Mecánica de XP compartido: al matar un monstruo, si el player está en un grupo,
 * la XP se divide entre los miembros presentes en la misma sala.
 */
function cmdParty(player, args) {
  const sub = (args[0] || '').toLowerCase();

  // ── Sin argumento: mostrar miembros del grupo ─────────────────────────────
  if (!sub || sub === 'info') {
    player = db.getPlayer(player.id);
    if (!player.party_id) {
      return { text: 'No estás en ningún grupo.\nUsá "party <nombre_jugador>" para invitar a alguien de tu sala.' };
    }
    const members = db.getPartyMembers(player.party_id);
    if (members.length === 0) {
      db.updatePlayer(player.id, { party_id: null });
      return { text: 'Tu grupo se disolvió (nadie más está en él).' };
    }
    const lines = ['⚔ Grupo de aventureros:'];
    for (const m of members) {
      const hpBar = buildBar(m.hp, m.max_hp, 8);
      const room = db.getRoom(m.current_room_id);
      const roomName = room ? room.name : '???';
      lines.push(`  ${m.username.padEnd(16)} Lv${m.level || 1} ${hpBar} ${m.hp}/${m.max_hp}  📍${roomName}`);
    }
    return { text: lines.join('\n') };
  }

  // ── leave / salir ─────────────────────────────────────────────────────────
  if (sub === 'leave' || sub === 'salir' || sub === 'abandonar') {
    player = db.getPlayer(player.id);
    if (!player.party_id) {
      return { text: 'No estás en ningún grupo.' };
    }
    db.updatePlayer(player.id, { party_id: null });
    return {
      text: 'Abandonaste el grupo.',
      event: `${player.username} abandona el grupo.`,
      eventRoomId: player.current_room_id,
    };
  }

  // ── accept / aceptar ──────────────────────────────────────────────────────
  if (sub === 'accept' || sub === 'aceptar' || sub === 'acepto') {
    const invite = pendingPartyInvites.get(player.id);
    if (!invite || Date.now() > invite.expiresAt) {
      pendingPartyInvites.delete(player.id);
      return { text: 'No hay ninguna invitación de grupo pendiente.' };
    }
    pendingPartyInvites.delete(player.id);

    // Unirse al grupo del invitador
    db.updatePlayer(player.id,      { party_id: invite.partyId });
    db.updatePlayer(invite.inviterId, { party_id: invite.partyId }); // por si acaso
    const members = db.getPartyMembers(invite.partyId);
    const names = members.map(m => m.username).join(', ');
    return {
      text: `✅ Te uniste al grupo de ${invite.inviterUsername}.\nMiembros: ${names}`,
      targetPlayerId: invite.inviterId,
      targetPlayerMsg: `✅ ${player.username} aceptó unirse a tu grupo.`,
    };
  }

  // ── decline / rechazar ────────────────────────────────────────────────────
  if (sub === 'decline' || sub === 'rechazar' || sub === 'rechazo') {
    const invite = pendingPartyInvites.get(player.id);
    if (!invite) return { text: 'No hay ninguna invitación de grupo pendiente.' };
    pendingPartyInvites.delete(player.id);
    return {
      text: `Rechazaste la invitación de ${invite.inviterUsername}.`,
      targetPlayerId: invite.inviterId,
      targetPlayerMsg: `${player.username} rechazó unirse a tu grupo.`,
    };
  }

  // ── Invitar a un jugador ──────────────────────────────────────────────────
  const targetName = args.join(' ').toLowerCase();
  const roomPlayers = db.getPlayersInRoom(player.current_room_id);
  const target = roomPlayers.find(
    p => p.username.toLowerCase().includes(targetName) && p.id !== player.id
  );
  if (!target) {
    return { text: `No hay ningún jugador llamado "${args.join(' ')}" en esta sala.` };
  }
  if (target.party_id) {
    return { text: `${target.username} ya está en un grupo.` };
  }

  // Verificar límite de 4 miembros
  player = db.getPlayer(player.id);
  const partyId = player.party_id || `party-${player.id}-${Date.now()}`;
  const currentMembers = db.getPartyMembers(partyId);
  if (currentMembers.length >= 4) {
    return { text: '❌ El grupo está lleno (máximo 4 miembros).' };
  }

  // Asegurar que el invitador tenga el party_id
  if (!player.party_id) {
    db.updatePlayer(player.id, { party_id: partyId });
  }

  // Guardar invitación (válida por 60s)
  pendingPartyInvites.set(target.id, {
    inviterId: player.id,
    inviterUsername: player.username,
    partyId,
    expiresAt: Date.now() + 60_000,
  });

  return {
    text: `📨 Invitaste a ${target.username} a unirse a tu grupo. (Esperando respuesta...)`,
    targetPlayerId: target.id,
    targetPlayerMsg: `📨 ${player.username} te invita a unirse a su grupo. Escribí "party accept" para aceptar o "party decline" para rechazar. (60s)`,
  };
}

/**
 * La Sala 4 (Cámara del Tesoro) tiene un mercader NPC.
 * Catálogo de la tienda con precios en oro.
 */
const MERCHANT_ROOM_ID = 4;

const SHOP_CATALOG = [
  { name: 'poción de salud',         price: 15, description: 'Recupera 20 HP. Esencial para aventureros.' },
  { name: 'poción mayor de salud',   price: 35, description: 'Recupera 50 HP. Para las situaciones desesperadas.' },
  { name: 'antídoto',                price: 20, description: 'Cura el veneno al instante.' },
  { name: 'espada de hierro',        price: 30, description: 'Arma sólida. Daño base +6.' },
  { name: 'daga envenenada',         price: 45, description: 'Daño +4, aplica veneno al enemigo.' },
  { name: 'escudo de madera',        price: 25, description: 'Defensa +2. No es glamoroso, pero funciona.' },
  { name: 'antorcha',                price: 5,  description: 'Ilumina pasillos oscuros. Dura varias horas.' },
  { name: 'cuerda',                  price: 10, description: 'Desactiva trampas de pinchos. 15m de largo.' },
  { name: 'llave oxidada',           price: 50, description: 'Abre cierta puerta al norte del Pozo. El mercader no explica más.' },
];

// Precios de venta al mercader (jugador → mercader) — 40% del valor
const SELL_PRICE_RATIO = 0.4;

function cmdShop(player) {
  player = db.getPlayer(player.id);

  if (player.current_room_id !== MERCHANT_ROOM_ID) {
    return { text: '🏪 No hay ningún mercader aquí. El mercader vive en la Cámara del Tesoro (sala 4).' };
  }

  const gold = player.gold || 0;
  const lines = [
    '\n🏪 === TIENDA DE ALDRIC EL MERCADER ===',
    `"Bienvenido, aventurero. Tenés ${gold}g. ¿Qué necesitás?"`,
    '',
    'ARTÍCULO                    PRECIO   DESCRIPCIÓN',
    '─'.repeat(60),
  ];

  SHOP_CATALOG.forEach((item, i) => {
    const num = String(i + 1).padStart(2, ' ');
    const namePad = item.name.padEnd(26, ' ');
    const pricePad = `${item.price}g`.padEnd(9, ' ');
    lines.push(`${num}. ${namePad}${pricePad}${item.description}`);
  });

  lines.push('─'.repeat(60));
  lines.push('Comandos: "buy <ítem>" para comprar, "sell <ítem>" para vender.');
  lines.push(`Podés vender tus ítems al ${Math.round(SELL_PRICE_RATIO * 100)}% de su valor de compra.`);

  return { text: lines.join('\n') };
}

function cmdBuy(player, itemQuery) {
  if (!itemQuery || !itemQuery.trim()) {
    return { text: 'Indicá qué querés comprar. Ej: "buy poción de salud" o "tienda" para ver el catálogo.' };
  }

  player = db.getPlayer(player.id);

  if (player.current_room_id !== MERCHANT_ROOM_ID) {
    return { text: '🏪 No hay ningún mercader aquí. El mercader vive en la Cámara del Tesoro (sala 4).' };
  }

  const query = itemQuery.trim().toLowerCase();
  const item = SHOP_CATALOG.find(i =>
    i.name.toLowerCase().includes(query) || query.includes(i.name.toLowerCase())
  );

  if (!item) {
    return { text: `El mercader sacude la cabeza. "No vendo eso." Escribí "tienda" para ver el catálogo.` };
  }

  const gold = player.gold || 0;
  if (gold < item.price) {
    return { text: `💰 No tenés suficiente oro. Necesitás ${item.price}g, tenés ${gold}g.` };
  }

  // Realizar la compra
  const newGold = gold - item.price;
  const newInventory = [...player.inventory, item.name];
  db.updatePlayer(player.id, { gold: newGold, inventory: newInventory });

  // T115: Trackear oro gastado para logro secreto Mecenas
  db.addGoldSpent(player.id, item.price);

  // Evaluar logros de compra
  const freshBuyer = db.getPlayer(player.id);
  const buyAchs = ach.checkAchievements(freshBuyer, { boughtSomething: true });
  const buyAchLines = ach.formatNewAchievements(buyAchs);

  return {
    text: `🏪 Aldric sonríe. "Excelente elección."\n✅ Compraste: ${item.name} por ${item.price}g.\n💰 Oro restante: ${newGold}g.${buyAchLines}`,
    event: `${player.username} compra algo al mercader.`,
    eventRoomId: player.current_room_id,
  };
}

function cmdSell(player, itemQuery) {
  if (!itemQuery || !itemQuery.trim()) {
    return { text: 'Indicá qué querés vender. Ej: "sell espada oxidada".' };
  }

  player = db.getPlayer(player.id);

  if (player.current_room_id !== MERCHANT_ROOM_ID) {
    return { text: '🏪 No hay ningún mercader aquí. El mercader vive en la Cámara del Tesoro (sala 4).' };
  }

  const found = items.findItem(player.inventory, itemQuery.trim());
  if (!found) {
    return { text: `No tenés ningún "${itemQuery}" en el inventario.` };
  }

  // Determinar precio de venta — buscar en catálogo, si no usar precio genérico
  const catalogItem = SHOP_CATALOG.find(i => i.name.toLowerCase() === found.toLowerCase());
  const basePrice = catalogItem ? catalogItem.price : 10;
  const sellPrice = Math.max(1, Math.floor(basePrice * SELL_PRICE_RATIO));

  // Realizar la venta
  const newInventory = removeFirst(player.inventory, found);
  const newGold = (player.gold || 0) + sellPrice;
  db.updatePlayer(player.id, { gold: newGold, inventory: newInventory });

  // Si era el arma equipada, desequipar
  if (player.equipped_weapon === found) {
    db.updatePlayer(player.id, { attack: 5, equipped_weapon: null });
  }

  return {
    text: `🏪 Aldric examina el objeto.\n"Te doy ${sellPrice}g por eso."\n💰 Vendiste: ${found} por ${sellPrice}g. Total: ${newGold}g.`,
    event: `${player.username} vende algo al mercader.`,
    eventRoomId: player.current_room_id,
  };
}

/**
 * achievements / logros — Mostrar todos los logros del jugador.
 */
function cmdAchievements(player) {
  player = db.getPlayer(player.id);
  // Evaluar logros que podrían haberse ganado pasivamente (gold, deaths, level)
  const newOnes = ach.checkAchievements(player, {});
  const achText = ach.formatAchievements(player);
  const newLines = ach.formatNewAchievements(newOnes);
  return { text: achText + newLines };
}

/**
 * T086 — Quest activa: mostrar quest y progreso del jugador.
 */
function cmdQuest(player) {
  player = db.getPlayer(player.id);
  const text = quests.formatQuest(player);
  return { text };
}

/**
 * T085 — Examinar a otro jugador en la misma sala.
 * Muestra nivel, HP, arma equipada, kills y logros.
 */
function cmdInspect(player, targetName) {
  if (!targetName || !targetName.trim()) {
    return { text: 'Usá: inspect <nombre_del_jugador>' };
  }

  const name = targetName.trim().toLowerCase();

  // Buscar el jugador objetivo en la sala actual
  const roomPlayers = db.getPlayersInRoom(player.current_room_id);
  const target = roomPlayers.find(
    p => p.username.toLowerCase().includes(name) && p.id !== player.id
  );

  if (!target) {
    return { text: `No hay ningún aventurero llamado "${targetName}" en esta sala.` };
  }

  // Formatear HP
  const hpPct = Math.round((target.hp / target.max_hp) * 100);
  const hpBar = buildHpBar(target.hp, target.max_hp);
  const hpLabel = hpPct >= 70 ? '(saludable)' : hpPct >= 40 ? '(herido)' : hpPct >= 10 ? '(gravemente herido)' : '(al borde de la muerte)';

  // Formatear arma equipada
  const weapon = target.equipped_weapon || 'puños';

  // Formatear logros
  let achDisplay = '—';
  try {
    const achArr = JSON.parse(target.achievements || '[]');
    if (achArr.length > 0) {
      // Mostrar íconos de logros desbloqueados
      const { ACHIEVEMENTS } = require('./achievements');
      const icons = achArr.map(id => {
        const def = ACHIEVEMENTS.find(a => a.id === id);
        return def ? def.icon : '🏅';
      });
      achDisplay = icons.join(' ') || '—';
    }
  } catch (_) {}

  const lines = [
    `══ 🔍 Inspeccionás a ${target.username} ══`,
    `Título ${getTitle(target.kills || 0).full} · Nivel ${target.level || 1} · ${target.xp || 0} XP total`,
    `HP: ${target.hp}/${target.max_hp} ${hpBar} ${hpLabel}`,
    `ATK ${target.attack} · DEF ${target.defense}`,
    `Arma: ${weapon}`,
    `Kills: ${target.kills || 0} · Muertes: ${target.deaths || 0}`,
    `Logros: ${achDisplay}`,
    target.gold !== undefined ? `Oro: 💰 ${target.gold}g` : null,
  ].filter(Boolean).join('\n');

  return {
    text: lines,
    event: `🔍 ${player.username} te observa detenidamente.`, // enviado al target si está conectado
    eventTarget: target.id,
    // También notificar al target directamente por socket usando el sistema existente
    targetPlayerId: target.id,
    targetPlayerMsg: `🔍 ${player.username} te está examinando.`,
    targetEventType: 'action',
  };
}

/**
 * guild <subcomando> [args] — Gestionar hermandades/guilds.
 *
 * Subcomandos:
 *   create <nombre>  — Crear una nueva hermandad (cuesta 50 oro)
 *   join <nombre>    — Unirse a una hermandad existente
 *   leave            — Abandonar la hermandad actual
 *   info             — Ver info de tu hermandad (miembros, líder)
 *   list             — Listar todas las hermandades activas
 */
function cmdGuild(player, args) {
  if (!args || args.length === 0) {
    return { text: 'Usá: guild create <nombre> | guild join <nombre> | guild leave | guild info | guild list' };
  }

  // Refrescar desde BD
  player = db.getPlayer(player.id);
  const sub = args[0].toLowerCase();
  const guildArg = args.slice(1).join(' ').trim();

  // ── guild list ──────────────────────────────────────────────────────────────
  if (sub === 'list' || sub === 'lista') {
    const guilds = db.getAllGuilds();
    if (guilds.length === 0) {
      return { text: 'No hay ninguna hermandad activa todavía. ¡Creá la primera con "guild create <nombre>"!' };
    }
    const lines = [
      '=== HERMANDADES ACTIVAS ===',
      ...guilds.map(g => `  [${g.name}]  Líder: ${g.leader_name || '?'}  Miembros: ${g.member_count}`),
    ];
    return { text: lines.join('\n') };
  }

  // ── guild info ──────────────────────────────────────────────────────────────
  if (sub === 'info' || sub === 'información' || sub === 'información') {
    if (!player.guild) {
      return { text: 'No pertenecés a ninguna hermandad. Usá "guild join <nombre>" o "guild create <nombre>".' };
    }
    const guild = db.getGuild(player.guild);
    if (!guild) {
      // Datos inconsistentes — limpiar
      db.setPlayerGuild(player.id, null);
      return { text: 'Tu hermandad ya no existe. Tu afiliación fue removida.' };
    }
    const members = db.getGuildMembers(player.guild);
    const leaderName = members.find(m => m.id === guild.leader_id)?.username || '(desconocido)';
    const memberLines = members.map(m => {
      const tag = m.id === guild.leader_id ? ' 👑' : '';
      return `  ${m.username}${tag}  Lv${m.level || 1}  ❤${m.hp}/${m.max_hp}`;
    });
    const lines = [
      `══ 🛡 Hermandad: [${guild.name}] ══`,
      `Líder: ${leaderName}`,
      `Miembros (${members.length}):`,
      ...memberLines,
    ];
    return { text: lines.join('\n') };
  }

  // ── guild leave ─────────────────────────────────────────────────────────────
  if (sub === 'leave' || sub === 'abandonar' || sub === 'salir') {
    if (!player.guild) {
      return { text: 'No pertenecés a ninguna hermandad.' };
    }
    const guildName = player.guild;
    const guild = db.getGuild(guildName);

    // Si el líder se va y hay más miembros, pasarle el liderazgo al primero encontrado
    if (guild && guild.leader_id === player.id) {
      const members = db.getGuildMembers(guildName).filter(m => m.id !== player.id);
      if (members.length > 0) {
        // Promover al primer miembro como nuevo líder
        const { randomUUID } = require('crypto');
        db.deleteGuild(guildName);
        db.createGuild(randomUUID(), guildName, members[0].id);
        db.setPlayerGuild(player.id, null);
        return {
          text: `Abandonaste la hermandad [${guildName}]. ${members[0].username} es el nuevo líder.`,
          event: `⚔ ${player.username} abandonó la hermandad [${guildName}]. ¡${members[0].username} es el nuevo líder!`,
          eventRoomId: player.current_room_id,
          guildBroadcast: guildName,
          guildBroadcastMsg: `⚔ ${player.username} abandonó la hermandad. ${members[0].username} es el nuevo líder.`,
        };
      } else {
        // Solo queda el líder — disolver la hermandad
        db.deleteGuild(guildName);
        db.setPlayerGuild(player.id, null);
        return {
          text: `Eras el último miembro. La hermandad [${guildName}] fue disuelta.`,
          event: `⚔ La hermandad [${guildName}] fue disuelta por ${player.username}.`,
          eventRoomId: player.current_room_id,
        };
      }
    }

    db.setPlayerGuild(player.id, null);
    return {
      text: `Abandonaste la hermandad [${guildName}].`,
      guildBroadcast: guildName,
      guildBroadcastMsg: `⚔ ${player.username} abandonó la hermandad.`,
    };
  }

  // ── guild join ──────────────────────────────────────────────────────────────
  if (sub === 'join' || sub === 'unirse' || sub === 'entrar') {
    if (!guildArg) {
      return { text: 'Usá: guild join <nombre_de_hermandad>' };
    }
    if (player.guild) {
      return { text: `Ya pertenecés a la hermandad [${player.guild}]. Salí primero con "guild leave".` };
    }
    const guild = db.getGuild(guildArg);
    if (!guild) {
      return { text: `No existe ninguna hermandad llamada "${guildArg}". Verificá el nombre con "guild list".` };
    }
    db.setPlayerGuild(player.id, guild.name);
    return {
      text: `¡Te uniste a la hermandad [${guild.name}]! Podés chatear con tus compañeros usando "gc <mensaje>".`,
      guildBroadcast: guild.name,
      guildBroadcastMsg: `⚔ ¡${player.username} se unió a la hermandad!`,
    };
  }

  // ── guild create ────────────────────────────────────────────────────────────
  if (sub === 'create' || sub === 'crear' || sub === 'fundar') {
    if (!guildArg) {
      return { text: 'Usá: guild create <nombre_de_hermandad>' };
    }
    if (guildArg.length > 20) {
      return { text: 'El nombre de la hermandad no puede superar los 20 caracteres.' };
    }
    if (!/^[a-zA-Z0-9áéíóúÁÉÍÓÚüÜñÑ _-]+$/.test(guildArg)) {
      return { text: 'El nombre solo puede tener letras, números, espacios, guiones y guiones bajos.' };
    }
    if (player.guild) {
      return { text: `Ya pertenecés a la hermandad [${player.guild}]. Salí primero con "guild leave".` };
    }

    // Costo de fundación: 50 oro
    const gold = player.gold || 0;
    if (gold < 50) {
      return { text: `Fundar una hermandad cuesta 50 de oro. Tenés ${gold}g. ¡Conseguí más monedas y volvé!` };
    }

    // Verificar si ya existe
    const existing = db.getGuild(guildArg);
    if (existing) {
      return { text: `Ya existe una hermandad llamada "${guildArg}". Elegí otro nombre.` };
    }

    // Crear guild
    const { randomUUID } = require('crypto');
    const guildId = randomUUID();
    db.createGuild(guildId, guildArg, player.id);
    db.setPlayerGuild(player.id, guildArg);
    db.updatePlayer(player.id, { gold: gold - 50 });

    return {
      text: `⚔ ¡Hermandad [${guildArg}] fundada! Te costo 50 de oro. Sos el líder 👑.\nInvitá jugadores diciéndoles que usen "guild join ${guildArg}". Chateá con "gc <mensaje>".`,
      event: `⚔ ¡${player.username} fundó la hermandad [${guildArg}]!`,
      eventRoomId: player.current_room_id,
    };
  }

  return { text: `Subcomando desconocido: "${sub}". Usá guild create | join | leave | info | list` };
}

/**
 * gc <mensaje> — Chat de hermandad (broadcast solo a los miembros del mismo guild).
 */
function cmdGuildChat(player, args) {
  // Refrescar player
  player = db.getPlayer(player.id);

  if (!player.guild) {
    return { text: 'No pertenecés a ninguna hermandad. Usá "guild join <nombre>" primero.' };
  }

  const msg = args.join(' ').trim();
  if (!msg) {
    return { text: 'Escribí el mensaje. Ej: gc Hola compañeros' };
  }
  if (msg.length > 200) {
    return { text: 'Mensaje demasiado largo (máx 200 caracteres).' };
  }

  return {
    text: `[GUILD ${player.guild}] ${player.username}: ${msg}`,
    guildBroadcast: player.guild,
    guildBroadcastMsg: `[GUILD ${player.guild}] ${player.username}: ${msg}`,
    guildBroadcastExcludeSelf: player.id,
  };
}


/**
 * world — Ver el evento global actual del dungeon
 */
function cmdWorld() {
  const ev = worldEvents.getCurrentEvent();
  if (!ev) {
    const nextText = worldEvents.getNextEventText();
    return { text: `🌍 El dungeon está en calma.\n${nextText}\n\nEventos posibles: Invasión de los Abismos, Niebla Espesa, Luna de Sangre, Bendición del Santuario, Maldición del Lich.` };
  }
  const minLeft = Math.floor(ev.remainingMs / 60_000);
  const secLeft = Math.floor((ev.remainingMs % 60_000) / 1000);
  return {
    text: `🌍 EVENTO ACTIVO: ${ev.name}\n${ev.description}\n⏱ Tiempo restante: ${minLeft}m ${secLeft}s`,
  };
}


/**
 * duel <jugador> — Retar a otro jugador en la misma sala a un duelo PvP
 */
function cmdDuel(player, targetName) {
  if (!targetName) {
    return { text: 'Indicá a quién querés retar. Ej: "duel Ana"' };
  }

  const target = db.getPlayerByUsername(targetName.trim());
  if (!target) {
    return { text: `No existe el jugador "${targetName}".` };
  }
  if (target.id === player.id) {
    return { text: 'No podés retarte a vos mismo, héroe solitario.' };
  }
  if (target.current_room_id !== player.current_room_id) {
    return { text: `${target.username} no está en esta sala. Los duelos solo se pueden iniciar cara a cara.` };
  }
  if (target.hp <= 0) {
    return { text: `${target.username} está en muy mal estado para pelear.` };
  }

  // Guardar reto (expira en 60 segundos)
  pendingDuels.set(target.id, {
    challengerId: player.id,
    challengerUsername: player.username,
    roomId: player.current_room_id,
    expiresAt: Date.now() + 60_000,
  });

  return {
    text: `⚔️ Retaste a ${target.username} a un duelo. Esperando respuesta (60s para aceptar o rechazar).`,
    event: `⚔️ ${player.username} reta a ${target.username} a un duelo a muerte! ¡Que el más valiente triunfe!`,
    targetPlayerId: target.id,
    targetPlayerMsg: `⚔️ ${player.username} te está retando a un duelo! Escribí "accept" para aceptar o "decline" para rechazar (60s).`,
    targetEventType: 'duel_challenge',
  };
}

/**
 * accept — Aceptar un reto de duelo pendiente
 */
function cmdAcceptDuel(player) {
  const challenge = pendingDuels.get(player.id);
  if (!challenge) {
    return { text: 'No tenés ningún reto de duelo pendiente.' };
  }
  if (Date.now() > challenge.expiresAt) {
    pendingDuels.delete(player.id);
    return { text: 'El reto de duelo expiró (más de 60 segundos).' };
  }

  const challenger = db.getPlayer(challenge.challengerId);
  if (!challenger) {
    pendingDuels.delete(player.id);
    return { text: 'El jugador que te retó ya no existe.' };
  }
  if (challenger.current_room_id !== player.current_room_id) {
    pendingDuels.delete(player.id);
    return { text: `${challenger.username} ya no está en esta sala. Duelo cancelado.` };
  }

  pendingDuels.delete(player.id);

  // ── Resolver el duelo por turnos ──────────────────────────────────────────
  // Clonar stats para no modificar la BD durante la simulación
  let hp1 = challenger.hp;  // challenger
  let hp2 = player.hp;       // retado (acceptor)
  const atk1 = Math.max(1, (challenger.attack || 5) + (challenger.level || 1) - 1);
  const atk2 = Math.max(1, (player.attack || 5) + (player.level || 1) - 1);
  const def1 = challenger.defense || 2;
  const def2 = player.defense || 2;

  const log = [];
  let turns = 0;
  const MAX_TURNS = 30;

  while (hp1 > 0 && hp2 > 0 && turns < MAX_TURNS) {
    turns++;
    // Challenger ataca al retado
    const dmg1 = Math.max(1, Math.floor(atk1 * (0.8 + Math.random() * 0.4)) - def2);
    hp2 -= dmg1;
    log.push(`  Ronda ${turns}a: ${challenger.username} golpea a ${player.username} (-${dmg1} HP, ${player.username}: ${Math.max(0, hp2)}/${player.max_hp} HP)`);
    if (hp2 <= 0) break;

    // Retado ataca al challenger
    const dmg2 = Math.max(1, Math.floor(atk2 * (0.8 + Math.random() * 0.4)) - def1);
    hp1 -= dmg2;
    log.push(`  Ronda ${turns}b: ${player.username} golpea a ${challenger.username} (-${dmg2} HP, ${challenger.username}: ${Math.max(0, hp1)}/${challenger.max_hp} HP)`);
  }

  let winner, loser;
  if (hp1 <= 0 && hp2 <= 0) {
    // Empate (raro): ambos caen en el mismo turno
    winner = null;
  } else if (hp1 > 0) {
    winner = challenger;
    loser  = player;
  } else {
    winner = player;
    loser  = challenger;
  }

  // ── Aplicar penalización y recompensa de oro ──────────────────────────────
  let resultMsg = '';
  if (!winner) {
    resultMsg = `¡Empate! ${challenger.username} y ${player.username} caen exhaustos. Nadie pierde oro.`;
    // Dejar HP de ambos en 1 (no mueren, solo quedan casi KO)
    db.updatePlayer(challenger.id, { hp: Math.max(1, Math.floor(challenger.max_hp * 0.1)) });
    db.updatePlayer(player.id,     { hp: Math.max(1, Math.floor(player.max_hp * 0.1)) });
  } else {
    const goldTransfer = Math.max(1, Math.floor(loser.gold * 0.10));
    const loserNewGold = Math.max(0, loser.gold - goldTransfer);
    const winnerNewGold = winner.gold + goldTransfer;

    // Actualizar HP (ambos salen heridos, ganador con HP proporcional)
    const winnerHp = winner.id === challenger.id ? Math.max(1, hp1) : Math.max(1, hp2);
    const loserHp  = Math.max(1, Math.floor(loser.max_hp * 0.05)); // loser queda casi KO

    db.updatePlayer(winner.id, {
      hp: winnerHp,
      gold: winnerNewGold,
      duel_wins: (winner.duel_wins || 0) + 1,
    });
    db.updatePlayer(loser.id, {
      hp: loserHp,
      gold: loserNewGold,
      duel_losses: (loser.duel_losses || 0) + 1,
    });

    // T115: Logro secreto Último Aliento — ganar un duelo con 1 HP
    let secretAchNotif = '';
    if (winnerHp === 1) {
      const freshWinner = db.getPlayer(winner.id);
      if (freshWinner) {
        const duelAchs = ach.checkAchievements(freshWinner, { duelSurvivedAt1Hp: true });
        if (duelAchs.length > 0) {
          secretAchNotif = ach.formatNewAchievements(duelAchs);
        }
      }
    }

    resultMsg = `🏆 ¡${winner.username} gana el duelo! ${loser.username} pierde ${goldTransfer} monedas de oro.\n` +
                `   ${winner.username}: ${winnerHp}/${winner.max_hp} HP | ${loser.username}: ${loserHp}/${loser.max_hp} HP` +
                secretAchNotif;

    // Registrar en crónica global (T093)
    db.logGlobalEvent('duel', `⚔️ ${winner.username} venció a ${loser.username} en duelo y ganó ${goldTransfer}g.`);
  }

  const combatLog = log.slice(0, 10).join('\n'); // solo primeras 10 líneas para no spamear
  const finalText = `⚔️ ¡DUELO! ${challenger.username} vs ${player.username}\n${combatLog}\n\n${resultMsg}`;

  return {
    text: finalText,
    event: finalText,
    targetPlayerId: winner ? loser.id : challenger.id,
    targetPlayerMsg: finalText,
    targetEventType: 'duel_result',
  };
}

/**
 * decline — Rechazar un reto de duelo pendiente
 */
function cmdDeclineDuel(player) {
  const challenge = pendingDuels.get(player.id);
  if (!challenge) {
    return { text: 'No tenés ningún reto de duelo pendiente.' };
  }
  pendingDuels.delete(player.id);

  return {
    text: `Rechazaste el reto de ${challenge.challengerUsername}. A veces la discreción es sabiduría.`,
    event: `🚫 ${player.username} rechazó el reto de duelo de ${challenge.challengerUsername}.`,
    targetPlayerId: challenge.challengerId,
    targetPlayerMsg: `🚫 ${player.username} rechazó tu reto de duelo.`,
    targetEventType: 'duel_declined',
  };
}


function buildHpBar(hp, maxHp, len = 8) {
  const filled = Math.round((hp / maxHp) * len);
  return '[' + '█'.repeat(filled) + '░'.repeat(len - filled) + ']';
}

/**
 * Obtener o crear un jugador por username.
 * Devuelve el objeto jugador.
 * Si el jugador es nuevo (0 kills, nivel 1, sin tutorial_step), inicia el tutorial.
 */
function getOrCreatePlayer(username) {
  let player = db.getPlayerByUsername(username);
  if (!player) {
    player = db.createPlayer(username);
    // Jugador nuevo: iniciar tutorial
    db.updatePlayer(player.id, {
      tutorial_step: 1,
      current_room_id: tutorial.TUTORIAL_ROOM_ID,
    });
    player = db.getPlayer(player.id);
    console.log(`[engine] Nuevo jugador creado: ${username} (${player.id}) — iniciando tutorial en sala 16`);
  } else if (tutorial.shouldStartTutorial(player) && player.current_room_id !== tutorial.TUTORIAL_ROOM_ID) {
    // Jugador que aún no completó el tutorial y no está en la sala de tutorial:
    // lo ponemos en tutorial_step 1 y lo llevamos a la antesala.
    db.updatePlayer(player.id, {
      tutorial_step: 1,
      current_room_id: tutorial.TUTORIAL_ROOM_ID,
    });
    player = db.getPlayer(player.id);
  }
  return player;
}

// T107: Recordatorio de clase al terminar el tutorial (usado en handlers.js)
function getClassReminder(player) {
  if (!player.player_class || player.player_class === 'sin_clase') {
    return `\n🎭 ¡No olvides elegir tu CLASE! Escribí "clase" para ver las opciones (guerrero, mago, pícaro).`;
  }
  return null;
}

module.exports = { execute, getOrCreatePlayer, ROOM_EFFECTS };

// ─── T092: Crafteo/Alquimia ───────────────────────────────────────────────────

/**
 * Parsea los argumentos del comando craft.
 * Soporta: craft <item1> con <item2>
 *          craft <item1> + <item2>
 *          craft <item1> y <item2>
 *          craft <item1> and <item2>
 */
function parseCraftArgs(args) {
  const raw = args.join(' ').toLowerCase();
  // Separadores: "con", "y", "+", "and", ","
  const separators = [' con ', ' + ', ' y ', ' and ', ','];
  for (const sep of separators) {
    const idx = raw.indexOf(sep);
    if (idx !== -1) {
      const a = raw.slice(0, idx).trim();
      const b = raw.slice(idx + sep.length).trim();
      if (a && b) return [a, b];
    }
  }
  return null;
}

function cmdCraft(player, args) {
  if (!args || args.length === 0) {
    return { text: '¿Qué querés craftear? Usá: craft <ítem1> con <ítem2>\nEjemplo: craft veneno concentrado con cuchillo oxidado\nPara ver recetas: recetas' };
  }

  const parsed = parseCraftArgs(args);
  if (!parsed) {
    return { text: 'No entendí la sintaxis. Usá:\n  craft <ítem1> con <ítem2>\n  craft <ítem1> + <ítem2>\nEjemplo: craft hierba curativa con poción menor' };
  }

  const [itemA, itemB] = parsed;
  const craftResult = crafting.craft(player, itemA, itemB);

  if (!craftResult.ok) {
    return { text: craftResult.text };
  }

  // Consumir los ítems del inventario
  const inv = [...player.inventory];
  const normalA = itemA.toLowerCase().trim();
  const normalB = itemB.toLowerCase().trim();

  // Remover primer ocurrencia de A
  const idxA = inv.findIndex(i => i.toLowerCase().trim() === normalA);
  if (idxA !== -1) inv.splice(idxA, 1);

  // Remover primer ocurrencia de B (excluyendo el hueco de A)
  const idxB = inv.findIndex(i => i.toLowerCase().trim() === normalB);
  if (idxB !== -1) inv.splice(idxB, 1);

  // Agregar el resultado
  inv.push(craftResult.result);

  db.updatePlayer(player.id, { inventory: JSON.stringify(inv) });

  // T115: Trackear crafteos para logro secreto Artesano
  db.addCraftsCount(player.id);
  const freshCrafter = db.getPlayer(player.id);
  if (freshCrafter) {
    const craftAchs = ach.checkAchievements(freshCrafter, {});
    const craftAchLines = ach.formatNewAchievements(craftAchs);
    if (craftAchLines) {
      return { text: craftResult.text + craftAchLines };
    }
  }

  return { text: craftResult.text };
}

function cmdRecipes() {
  return { text: crafting.listRecipes() };
}

// Rexportar con las nuevas funciones
module.exports = { execute, getOrCreatePlayer, ROOM_EFFECTS };

// ─── T093: Crónica / Historial de Eventos Globales ───────────────────────────

/**
 * news — Mostrar los últimos 10 eventos de la crónica del dungeon.
 * Registra automáticamente: boss muerto, quest completada, logro desbloqueado,
 * duel ganado, nivel 5/10/15... alcanzado.
 */
function cmdNews() {
  const events = db.getGlobalEvents(10);

  if (!events || events.length === 0) {
    return { text: '📰 La crónica del dungeon está vacía. ¡Sé el primero en dejar tu marca!' };
  }

  const TYPE_ICONS = {
    boss:        '⚔️',
    quest:       '📜',
    achievement: '🏅',
    duel:        '⚔️',
    level:       '⬆️',
    misc:        '📣',
  };

  const lines = [
    `╔═══════════════════════════════════════════════════╗`,
    `║        📰  CRÓNICA DEL DUNGEON  (últimos 10)      ║`,
    `╠═══════════════════════════════════════════════════╣`,
  ];

  for (const ev of events) {
    // Formatear timestamp: "2026-05-29 23:45:00" → "23:45"
    const ts = ev.created_at ? ev.created_at.slice(11, 16) : '??:??';
    const icon = TYPE_ICONS[ev.type] || '📣';
    const msg = ev.message.length > 60 ? ev.message.slice(0, 57) + '...' : ev.message;
    lines.push(`║ [${ts}] ${msg.padEnd(45)} ║`);
  }

  lines.push(`╚═══════════════════════════════════════════════════╝`);
  lines.push(`(Registra: boss, quests, logros, duelos, niveles)`);

  return { text: lines.join('\n') };
}

// Re-export final con T093
module.exports = { execute, getOrCreatePlayer, ROOM_EFFECTS };

// ─── T094: Forage / Buscar ───────────────────────────────────────────────────

/**
 * Tabla de ítems que se pueden encontrar al explorar una sala.
 * Cada entrada tiene: item (nombre), prob (probabilidad 0-1), gold (alternativa en oro)
 */
const FORAGE_TABLE = [
  // Hierbas y consumibles (comunes)
  { item: 'hierba curativa',  prob: 0.18, type: 'item' },
  { item: 'poción menor',     prob: 0.12, type: 'item' },
  { item: 'antídoto',         prob: 0.08, type: 'item' },
  // Monedas (comunes)
  { gold: 3,  prob: 0.20, type: 'gold', label: '3 monedas de cobre' },
  { gold: 7,  prob: 0.12, type: 'gold', label: '7 monedas de plata' },
  { gold: 15, prob: 0.05, type: 'gold', label: '¡15 monedas de oro!' },
  // Materiales de crafteo (poco comunes)
  { item: 'hueso pulido',         prob: 0.07, type: 'item' },
  { item: 'cristal fragmentado',  prob: 0.05, type: 'item' },
  { item: 'veneno concentrado',   prob: 0.04, type: 'item' },
  // Nada (probabilidad de fracaso)
  // El resto de probabilidad (~0.09) = no encontrás nada
];

const FORAGE_COOLDOWN_MS = 3 * 60 * 1000; // 3 minutos por sala

/**
 * forage / buscar — Explorar la sala en busca de ítems ocultos.
 * Cooldown de 3 min por sala. No funciona si hay monstruos vivos.
 */
function cmdForage(player) {
  player = db.getPlayer(player.id);
  const room = db.getRoom(player.current_room_id);

  // Verificar que no hay monstruos en la sala
  const monsters = db.getMonstersInRoom(player.current_room_id);
  if (monsters.length > 0) {
    const names = monsters.map(m => m.name).join(', ');
    return { text: `No podés buscar con calma mientras hay monstruos aquí: ${names}.` };
  }

  // Verificar cooldown por sala
  let forageData = {};
  try {
    forageData = JSON.parse(player.forage_data || '{}');
  } catch (_) { forageData = {}; }

  const roomKey = String(player.current_room_id);
  const lastForage = forageData[roomKey] ? Number(forageData[roomKey]) : 0;
  const now = Date.now();
  const elapsed = now - lastForage;

  if (elapsed < FORAGE_COOLDOWN_MS) {
    const remaining = Math.ceil((FORAGE_COOLDOWN_MS - elapsed) / 1000);
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    return { text: `Ya rebuscaste en esta sala recientemente. Podés intentar de nuevo en ${mins}m ${secs}s.` };
  }

  // Determinar qué se encuentra (tirar probabilidades)
  let roll = Math.random();
  let found = null;

  for (const entry of FORAGE_TABLE) {
    if (roll < entry.prob) {
      found = entry;
      break;
    }
    roll -= entry.prob;
  }

  // Actualizar cooldown
  forageData[roomKey] = now;
  // Limpiar entradas viejas (solo guardar últimas 20 salas)
  const keys = Object.keys(forageData);
  if (keys.length > 20) {
    const oldest = keys.sort((a, b) => forageData[a] - forageData[b])[0];
    delete forageData[oldest];
  }
  db.updatePlayer(player.id, { forage_data: JSON.stringify(forageData) });

  // Construir respuesta
  const intro = [
    `Buscás con cuidado entre las grietas, los rincones y el suelo de ${room.name}...`,
    `Revisás meticulosamente cada rincón oscuro de ${room.name}...`,
    `Tus ojos expertos rastrean el suelo y las paredes de ${room.name}...`,
    `Con paciencia, inspeccionás cada piedra y grieta de ${room.name}...`,
  ];
  const introLine = intro[Math.floor(Math.random() * intro.length)];

  if (!found) {
    const failMsgs = [
      'No encontrás nada de valor. Solo polvo y sombras.',
      'Después de revisar bien, te vas con las manos vacías.',
      'Nada. Esta sala parece haber sido saqueada antes.',
      'Buscás largo y tendido. No hay nada oculto aquí.',
    ];
    return { text: `${introLine}\n${failMsgs[Math.floor(Math.random() * failMsgs.length)]}` };
  }

  if (found.type === 'gold') {
    const currentGold = player.gold || 0;
    db.updatePlayer(player.id, { gold: currentGold + found.gold });
    return { text: `${introLine}\n💰 ¡Encontrás ${found.label}! (Oro total: ${currentGold + found.gold}g)` };
  }

  // Ítem
  const inv = [...player.inventory, found.item];
  db.updatePlayer(player.id, { inventory: JSON.stringify(inv) });

  // Evaluar si hay quest de recoger ítems
  const freshForQuest = db.getPlayer(player.id);
  let questLine = '';
  const qResult = quests.recordProgress(freshForQuest, 'pick', { itemName: found.item });
  if (qResult) {
    db.updatePlayer(player.id, { quest_progress: qResult.questProgress });
    if (qResult.justCompleted && qResult.reward) {
      const r = qResult.reward;
      const freshQ2 = db.getPlayer(player.id);
      db.updatePlayer(player.id, { gold: (freshQ2.gold || 0) + r.gold, xp: (freshQ2.xp || 0) + r.xp });
      questLine = `\n\n🎉 ¡Quest completada! Recibís ${r.gold}g y ${r.xp} XP.`;
      db.logGlobalEvent('quest', `📜 ${player.username} completó la misión y ganó ${r.gold}g + ${r.xp} XP.`);
    }
  }

  return {
    text: `${introLine}\n🌿 ¡Encontrás: ${found.item}! Se agrega a tu inventario.${questLine}`,
    event: null, // Acción silenciosa, sin broadcast a la sala
  };
}

// Re-export final con T094
module.exports = { execute, getOrCreatePlayer, ROOM_EFFECTS };

// ─── T097: Comando meditate / meditar ─────────────────────────────────────────

/**
 * meditate / meditar — Recuperar HP meditando en calma.
 * Requiere: sin monstruos en la sala. Cooldown propio: 90 segundos.
 * Recupera entre 4 y 7 HP (más que rest).
 * Bonus si el jugador tiene mascota: +2 HP extra (la compañía ayuda a concentrarse).
 */
function cmdMeditate(player) {
  player = db.getPlayer(player.id);

  if (player.hp >= player.max_hp) {
    return { text: '🧘 Ya estás al máximo de HP. No necesitás meditar.' };
  }

  // Sin monstruos en la sala
  const monsters = db.getMonstersInRoom(player.current_room_id);
  if (monsters.length > 0) {
    const names = monsters.map(m => m.name).join(', ');
    return { text: `⚔️  No podés meditar con enemigos presentes: ${names}.` };
  }

  // Cooldown propio (90 segundos, independiente de rest)
  const COOLDOWN_MS = 90_000;
  if (player.last_meditate) {
    const elapsed = Date.now() - new Date(player.last_meditate).getTime();
    if (elapsed < COOLDOWN_MS) {
      const remaining = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
      return { text: `🧘 Tu mente aún no está lista. Esperá ${remaining} segundo${remaining !== 1 ? 's' : ''} antes de meditar de nuevo.` };
    }
  }

  // Recuperar HP: 4-7 base, +2 con mascota
  let heal = Math.floor(Math.random() * 4) + 4; // 4, 5, 6 o 7
  const hasPet = !!player.pet;
  if (hasPet) heal += 2;

  const newHp    = Math.min(player.max_hp, player.hp + heal);
  const restored = newHp - player.hp;

  db.updatePlayer(player.id, {
    hp:            newHp,
    last_meditate: new Date().toISOString(),
  });

  const hpBar   = buildBar(newHp, player.max_hp, 20);
  const petLine = hasPet
    ? `\nTu ${player.pet} se acurruca a tu lado, amplificando la calma.`
    : '';

  return {
    text: `🧘 Cerrás los ojos y vaciás la mente. El dungeon desaparece por un momento.${petLine}\nRecuperás ${restored} HP. ${hpBar} ${newHp}/${player.max_hp} HP`,
  };
}

// ─── T103: Fuente de Rejuvenecimiento ────────────────────────────────────────

/**
 * drink/beber — Beber de la Fuente Eterna (sala 18).
 *
 * Recupera HP completo. Cooldown global de 10 minutos (no por jugador, por sala).
 * Si la fuente está en cooldown, nadie puede usarla hasta que se recargue.
 */
function cmdDrink(player) {
  player = db.getPlayer(player.id);

  if (player.current_room_id !== FOUNTAIN_ROOM_ID) {
    return { text: '💧 No hay ninguna fuente aquí.\n   La Fuente Eterna se encuentra en la Cámara de la Fuente Eterna (al norte del Santuario Profano).' };
  }

  if (player.hp >= player.max_hp) {
    return { text: '💧 Ya estás al máximo de HP. El agua brilla tentadoramente pero no la necesitás ahora.' };
  }

  // Verificar cooldown global
  const now = Date.now();
  if (fountainCooldownUntil > now) {
    const remaining = Math.ceil((fountainCooldownUntil - now) / 1000);
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    const timeStr = mins > 0
      ? `${mins} minuto${mins !== 1 ? 's' : ''} y ${secs}s`
      : `${secs} segundo${secs !== 1 ? 's' : ''}`;
    return { text: `💧 La fuente brilla tenuemente. Sus aguas se están recargando...\n   Disponible en: ${timeStr}.\n   Las runas en la pared pulsan lentamente.` };
  }

  // Usar la fuente
  const restored = player.max_hp - player.hp;
  db.updatePlayer(player.id, { hp: player.max_hp });

  // Activar cooldown global
  fountainCooldownUntil = now + FOUNTAIN_COOLDOWN_MS;

  const hpBar = buildBar(player.max_hp, player.max_hp, 20);

  return {
    text: `💧 Te arrodillás ante la fuente y bebés del agua plateada.\nUna energía cálida recorre tu cuerpo de pies a cabeza.\n¡HP completamente restaurado! +${restored} HP.\n${hpBar} ${player.max_hp}/${player.max_hp} HP\n\n⏳ La fuente empieza a atenuarse... necesitará 10 minutos para recargarse.`,
    event: `${player.username} bebe de la Fuente Eterna. Un resplandor plateado llena la sala.`,
    eventRoomId: FOUNTAIN_ROOM_ID,
  };
}

// ─── T095: Sistema de Mascotas ───────────────────────────────────────────────

/**
 * Mascotas disponibles en el dungeon.
 * Cada mascota tiene un nombre descriptivo, emoji, tipo y costo en oro.
 */
const PET_CATALOG = {
  'rata':          { name: '🐀 Rata Mazmorrera', cost: 20,  desc: 'Una rata gris con ojos brillantes. Te sigue a todas partes olfateando el suelo.' },
  'murciélago':    { name: '🦇 Murciélago Nocturno', cost: 25, desc: 'Un murciélago que se posa en tu hombro y chilla suavemente al detectar peligros cercanos.' },
  'araña':         { name: '🕷️ Araña Doméstica', cost: 20,  desc: 'Una araña pequeña que teje su tela en tu mochila. Curiosamente, trae buena suerte.' },
  'serpiente':     { name: '🐍 Serpiente de Mazmorra', cost: 30, desc: 'Una serpiente verde no venenosa. Se enrolla en tu brazo y sisea suavemente.' },
  'escarabajo':    { name: '🪲 Escarabajo de Cristal', cost: 15, desc: 'Un escarabajo cuya caparazón refleja la luz como un prisma. Coleccionistas lo buscan.' },
};

/**
 * pet [adopt <tipo>] [liberar] — Sistema de mascotas.
 * Sin argumentos: muestra tu mascota actual.
 * adopt <tipo>: adoptar una mascota (cuesta oro).
 * liberar: liberar tu mascota actual.
 */
function cmdPet(player, args) {
  player = db.getPlayer(player.id);
  const sub = args && args[0] ? args[0].toLowerCase() : '';

  // Sin argumentos o "pet ver": mostrar mascota actual
  if (!sub || sub === 'ver' || sub === 'show') {
    if (!player.pet) {
      const available = Object.keys(PET_CATALOG).map(k => {
        const p = PET_CATALOG[k];
        return `  • ${k.padEnd(12)} ${p.name} (${p.cost}g)`;
      }).join('\n');
      return { text: `No tenés ninguna mascota.\n\n🐾 Mascotas disponibles:\n${available}\n\nUsá: pet adopt <tipo>  (p.ej.: pet adopt rata)` };
    }
    return { text: `🐾 Tu mascota: ${player.pet}\n\nUsá "pet liberar" si querés dejarla ir.` };
  }

  // Liberar mascota
  if (sub === 'liberar' || sub === 'release' || sub === 'soltar' || sub === 'dejar') {
    if (!player.pet) {
      return { text: 'No tenés ninguna mascota para liberar.' };
    }
    const old = player.pet;
    db.updatePlayer(player.id, { pet: null });
    return {
      text: `Dejás ir a tu ${old}. Se pierde en las sombras del dungeon... Que le vaya bien.`,
      event: `${player.username} libera a su mascota.`,
      eventRoomId: player.current_room_id,
    };
  }

  // Adoptar mascota
  if (sub === 'adopt' || sub === 'adoptar' || sub === 'comprar' || sub === 'tomar') {
    const typeName = args.slice(1).join(' ').toLowerCase().trim();
    if (!typeName) {
      const available = Object.keys(PET_CATALOG).map(k => {
        const p = PET_CATALOG[k];
        return `  • ${k.padEnd(12)} ${p.name} (${p.cost}g)`;
      }).join('\n');
      return { text: `¿Qué mascota querés adoptar?\n\n🐾 Disponibles:\n${available}\n\nEjemplo: pet adopt rata` };
    }

    if (player.pet) {
      return { text: `Ya tenés una mascota: ${player.pet}. Liberala primero con "pet liberar".` };
    }

    const petData = PET_CATALOG[typeName];
    if (!petData) {
      const available = Object.keys(PET_CATALOG).join(', ');
      return { text: `No existe esa mascota. Tipos disponibles: ${available}` };
    }

    const gold = player.gold || 0;
    if (gold < petData.cost) {
      return { text: `No tenés suficiente oro. ${petData.name} cuesta ${petData.cost}g y tenés ${gold}g.` };
    }

    db.updatePlayer(player.id, {
      gold: gold - petData.cost,
      pet: petData.name,
    });

    return {
      text: `🐾 ¡Adoptaste a ${petData.name}! (-${petData.cost}g)\n${petData.desc}\nTu mascota aparece en tu "status" y junto a tu nombre en la sala.`,
      event: `${player.username} adoptó una mascota: ${petData.name}!`,
      eventRoomId: player.current_room_id,
    };
  }

  return { text: 'Uso: pet           — ver tu mascota\n     pet adopt <tipo> — adoptar una mascota\n     pet liberar      — liberar tu mascota\nEjemplo: pet adopt murciélago' };
}

// ─── T098: Sala de Subastas ───────────────────────────────────────────────────

const AUCTION_ROOM_ID = 17;

/**
 * Utilidad: formatear tiempo restante de una subasta.
 * @param {string} endsAt — ISO string
 * @returns {string} p.ej. "4m 32s"
 */
function formatTimeLeft(endsAt) {
  const ms = new Date(endsAt).getTime() - Date.now();
  if (ms <= 0) return 'expirada';
  const totalSec = Math.ceil(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`;
}

/**
 * subasta <ítem> <precio_min>
 * Pone un ítem del inventario a subasta desde la Casa de Subastas.
 */
function cmdAuction(player, args) {
  player = db.getPlayer(player.id);

  if (player.current_room_id !== AUCTION_ROOM_ID) {
    return { text: '🔨 Solo podés subastar desde la Casa de Subastas (sala 17).\n  Movete al este desde la Cámara del Tesoro (sala 4).' };
  }

  if (!args || args.length < 2) {
    return { text: 'Uso: subasta <ítem> <precio_mínimo>\nEjemplo: subasta espada 10\n\nPodés poner cualquier ítem de tu inventario a subasta.\nLa duración del remate es de 5 minutos.' };
  }

  // El último argumento es el precio, el resto es el nombre del ítem
  const priceArg = args[args.length - 1];
  const minPrice = parseInt(priceArg, 10);
  if (isNaN(minPrice) || minPrice < 1) {
    return { text: `Precio inválido: "${priceArg}". Debe ser un número mayor a 0.\nEjemplo: subasta "poción de salud" 15` };
  }

  const itemName = args.slice(0, -1).join(' ').toLowerCase().trim();
  const inventory = player.inventory || [];
  const itemIndex = inventory.findIndex(i => i.toLowerCase() === itemName);
  if (itemIndex === -1) {
    return { text: `No tenés "${itemName}" en el inventario.\nUsá "inventario" para ver tus ítems.` };
  }

  // Verificar que no tenga otra subasta activa con el mismo ítem
  const activeAuctions = db.getActiveAuctions();
  const alreadyAuctioning = activeAuctions.find(a => a.seller_id === player.id && a.item_name.toLowerCase() === itemName);
  if (alreadyAuctioning) {
    return { text: `Ya tenés "${itemName}" en subasta (ID #${alreadyAuctioning.id}). Esperá a que cierre primero.` };
  }

  // Retirar el ítem del inventario
  inventory.splice(itemIndex, 1);
  db.updatePlayer(player.id, { inventory: JSON.stringify(inventory) });

  // Crear subasta
  const auction = db.createAuction(player.id, player.username, itemName, minPrice);

  return {
    text: `🔨 ¡Subasta iniciada!\n  Ítem: ${itemName}\n  Precio mínimo: ${minPrice}g\n  ID de subasta: #${auction.id}\n  Cierra en: 5 minutos\n\nOtros jugadores pueden pujar con: pujar ${auction.id} <monto>`,
    globalEvent: `📣 ¡SUBASTA! ${player.username} pone "${itemName}" a la venta. Precio mínimo: ${minPrice}g. (ID #${auction.id}) — Usá: pujar ${auction.id} <monto>`,
  };
}

/**
 * subastas — listar subastas activas.
 */
function cmdAuctions() {
  const auctions = db.getActiveAuctions();

  if (auctions.length === 0) {
    return { text: '🔨 No hay subastas activas en este momento.\n\nPodés crear una con: subasta <ítem> <precio_mínimo>\n(Debés estar en la Casa de Subastas, sala 17, al este de la sala 4)' };
  }

  const lines = auctions.map(a => {
    const timeLeft = formatTimeLeft(a.ends_at);
    const bidInfo = a.current_bid > 0
      ? `Puja actual: ${a.current_bid}g (${a.bidder_name})`
      : `Sin pujas (mín: ${a.min_price}g)`;
    return `  #${a.id} | ${a.item_name} | ${bidInfo} | ⏳ ${timeLeft} | Vendedor: ${a.seller_name}`;
  });

  return {
    text: `🔨 Subastas activas (${auctions.length}):\n\n${lines.join('\n')}\n\nPara pujar: pujar <id> <monto>  |  Para detalle: help subasta`,
  };
}

/**
 * pujar <id> <monto>
 * Realizar una puja en una subasta activa.
 */
function cmdBid(player, args) {
  player = db.getPlayer(player.id);

  if (!args || args.length < 2) {
    return { text: 'Uso: pujar <id_subasta> <monto>\nEjemplo: pujar 3 50\n\nUsá "subastas" para ver los remates activos y sus IDs.' };
  }

  const auctionId = parseInt(args[0], 10);
  const amount = parseInt(args[1], 10);

  if (isNaN(auctionId) || isNaN(amount) || amount < 1) {
    return { text: 'Argumentos inválidos. Ejemplo: pujar 3 50' };
  }

  const auction = db.getAuction(auctionId);
  if (!auction) {
    return { text: `No existe la subasta #${auctionId}. Usá "subastas" para ver las activas.` };
  }
  if (auction.closed) {
    return { text: `La subasta #${auctionId} ya está cerrada.` };
  }

  const gold = player.gold || 0;
  if (gold < amount) {
    return { text: `No tenés suficiente oro. Tu oro: ${gold}g. Tu puja: ${amount}g.` };
  }

  const prevBidder = auction.bidder_id;
  const prevBidAmount = auction.current_bid;
  const prevBidderName = auction.bidder_name;

  const result = db.placeBid(auctionId, player.id, player.username, amount);
  if (!result.ok) {
    return { text: `❌ ${result.error}` };
  }

  // Descontar oro al nuevo postor
  db.updatePlayer(player.id, { gold: gold - amount });

  // Devolver oro al postor anterior (si había uno distinto)
  let refundMsg = '';
  if (prevBidder && prevBidder !== player.id && prevBidAmount > 0) {
    const prevPlayer = db.getPlayer(prevBidder);
    if (prevPlayer) {
      db.updatePlayer(prevBidder, { gold: (prevPlayer.gold || 0) + prevBidAmount });
      refundMsg = `\n💰 Se devolvieron ${prevBidAmount}g a ${prevBidderName}.`;
    }
  }

  const timeLeft = formatTimeLeft(auction.ends_at);

  return {
    text: `✅ ¡Puja registrada!\n  Subasta #${auctionId}: ${auction.item_name}\n  Tu puja: ${amount}g\n  Tiempo restante: ${timeLeft}${refundMsg}`,
    event: `💰 ${player.username} puja ${amount}g por "${auction.item_name}" (subasta #${auctionId})`,
    eventRoomId: AUCTION_ROOM_ID,
  };
}

/**
 * Resolver subastas expiradas — llamado periódicamente desde index.js.
 * Devuelve lista de mensajes de broadcast para emitir vía Socket.io.
 * @param {Function} broadcastFn — función(mensaje) para broadcast global
 */
function resolveExpiredAuctions(broadcastFn) {
  const expired = db.closeExpiredAuctions();
  const messages = [];

  for (const auction of expired) {
    if (auction.current_bid > 0 && auction.bidder_id) {
      // Hay ganador: dar ítem al ganador, dar oro al vendedor
      const winner = db.getPlayer(auction.bidder_id);
      const seller = db.getPlayer(auction.seller_id);

      if (winner) {
        const winnerInv = JSON.parse(winner.inventory || '[]');
        winnerInv.push(auction.item_name);
        db.updatePlayer(winner.id, { inventory: JSON.stringify(winnerInv) });
      }
      if (seller) {
        db.updatePlayer(seller.id, { gold: (seller.gold || 0) + auction.current_bid });
      }

      const msg = `🔨 ¡REMATE CERRADO! "${auction.item_name}" vendida por ${auction.current_bid}g. Ganador: ${auction.bidder_name}. Vendedor: ${auction.seller_name} recibe ${auction.current_bid}g.`;
      messages.push(msg);
      if (broadcastFn) broadcastFn(msg);

    } else {
      // Sin pujas: devolver ítem al vendedor
      const seller = db.getPlayer(auction.seller_id);
      if (seller) {
        const sellerInv = JSON.parse(seller.inventory || '[]');
        sellerInv.push(auction.item_name);
        db.updatePlayer(seller.id, { inventory: JSON.stringify(sellerInv) });
      }

      const msg = `🔨 Subasta cerrada sin pujas: "${auction.item_name}" vuelve a ${auction.seller_name}.`;
      messages.push(msg);
      if (broadcastFn) broadcastFn(msg);
    }
  }

  return messages;
}

// Re-export final con T095 + T098
module.exports = { execute, getOrCreatePlayer, ROOM_EFFECTS, resolveExpiredAuctions, getTitle };

// ── Sistema de Magia (T104) ────────────────────────────────────────────────────

/**
 * Catálogo de hechizos. Cada hechizo tiene:
 *   cost: costo en maná
 *   type: 'damage' | 'heal' | 'shield'
 *   amount: HP a infligir/curar (o def bonus)
 *   description: texto descriptivo
 *   aliases: otros nombres que se aceptan
 */
const SPELL_CATALOG = {
  'bola de fuego': {
    cost: 8,
    type: 'damage',
    amount: 10,
    description: 'Lanza una esfera de fuego al objetivo. Inflige 10 de daño directo.',
    aliases: ['fuego', 'fireball', 'fire', 'flamazo', 'llama'],
    icon: '🔥',
  },
  'escudo': {
    cost: 5,
    type: 'shield',
    amount: 5,
    description: 'Crea un escudo mágico que absorbe 5 puntos de daño en el próximo ataque recibido.',
    aliases: ['shield', 'barrera', 'protección', 'proteccion'],
    icon: '🛡️',
  },
  'curación': {
    cost: 6,
    type: 'heal',
    amount: 15,
    description: 'Canaliza energía curativa para restaurar 15 HP.',
    aliases: ['curar', 'heal', 'sanación', 'sanacion', 'regenerar', 'vida'],
    icon: '✨',
  },
};

/**
 * Regenerar maná basado en tiempo transcurrido (1 maná por minuto).
 * Actualiza al jugador en BD si hubo ganancia.
 * @returns {object} jugador fresco con maná actualizado
 */
function regenMana(player) {
  const maxMana = player.max_mana || 20;
  const currentMana = player.mana != null ? player.mana : 20;

  if (currentMana >= maxMana) {
    return player; // ya lleno, nada que hacer
  }

  const now = Date.now();
  const lastRegen = player.last_mana_regen ? new Date(player.last_mana_regen).getTime() : 0;
  const minutesPassed = (now - lastRegen) / 60000;
  // T107: Mago regenera 2x más rápido (2 maná/minuto en vez de 1)
  const clsData = classes.getPlayerClass(player);
  const regenRate = (clsData && clsData.name === 'Mago') ? 2 : 1;
  const manaGained = Math.floor(minutesPassed * regenRate);

  if (manaGained <= 0) return player;

  const newMana = Math.min(maxMana, currentMana + manaGained);
  db.updatePlayer(player.id, {
    mana: newMana,
    last_mana_regen: new Date().toISOString(),
  });

  return { ...player, mana: newMana, last_mana_regen: new Date().toISOString() };
}

/**
 * Encuentra un hechizo por nombre o alias.
 * @param {string} query
 * @returns {{ key: string, spell: object }|null}
 */
function findSpell(query) {
  const q = query.toLowerCase().trim();
  for (const [key, spell] of Object.entries(SPELL_CATALOG)) {
    if (key === q || spell.aliases.includes(q) || key.startsWith(q)) {
      return { key, spell };
    }
  }
  return null;
}

/**
 * cast <hechizo> [objetivo] — Lanzar un hechizo.
 * Bola de fuego requiere un monstruo en la sala como objetivo.
 * Escudo y curación son autodirigidos.
 */
function cmdCast(player, args) {
  if (!args || args.length === 0) {
    return {
      text: `🪄 ¿Qué hechizo querés lanzar?\nHechizos disponibles: ${Object.keys(SPELL_CATALOG).join(', ')}.\nUsá "hechizos" para ver el catálogo completo.`,
    };
  }

  // Regenerar maná antes de calcular
  player = regenMana(db.getPlayer(player.id));

  const currentMana = player.mana != null ? player.mana : 20;
  const maxMana = player.max_mana || 20;

  // Resolver nombre del hechizo (puede ser varias palabras, ej: "bola de fuego")
  const spellQuery = args.join(' ').toLowerCase().trim();
  const found = findSpell(spellQuery);

  if (!found) {
    return {
      text: `🪄 No conocés ese hechizo. Usá "hechizos" para ver los disponibles.`,
    };
  }

  const { key: spellName, spell } = found;

  // Verificar maná suficiente
  if (currentMana < spell.cost) {
    return {
      text: `🪄 No tenés maná suficiente para ${spell.icon} ${spellName}.\n   Necesitás ${spell.cost} maná, tenés ${currentMana}/${maxMana}.\n   Esperá que se recargue (1 maná/minuto) o usá una poción de maná.`,
    };
  }

  const monsters = db.getMonstersInRoom(player.current_room_id);
  let lines = [];
  let newMana = currentMana - spell.cost;
  let broadcastEvent = null;

  if (spell.type === 'damage') {
    // Hechizo de daño — necesita un monstruo
    if (monsters.length === 0) {
      return {
        text: `🪄 No hay ningún monstruo en la sala para atacar con ${spell.icon} ${spellName}.`,
      };
    }

    // Si hay argumento de objetivo, buscar monstruo específico
    let target = monsters[0]; // por defecto el primero
    if (args.length > 1) {
      const targetQuery = args.slice(1).join(' ').toLowerCase();
      const matched = monsters.find(m => m.name.toLowerCase().includes(targetQuery));
      if (matched) target = matched;
    }

    const dmg = spell.amount;
    // T107: Mago tiene spell_power 1.5 (hechizos hacen 50% más daño)
    const playerCls = classes.getPlayerClass(player);
    const spellPower = playerCls ? (playerCls.spell_power || 1.0) : 1.0;
    const finalDmg = Math.round(dmg * spellPower);
    const newHp = Math.max(0, target.hp - finalDmg);
    db.updatePlayer(player.id, { mana: newMana, last_mana_regen: player.last_mana_regen || new Date().toISOString() });

    lines.push(`🪄 Lanzás ${spell.icon} **${spellName}** sobre ${target.name}!`);
    const dmgNote = spellPower > 1.0 ? ` (${dmg}×${spellPower} daño mágico de Mago)` : '';
    lines.push(`   ${target.name} recibe ${finalDmg} puntos de daño mágico.${dmgNote} (HP: ${target.hp} → ${newHp})`);

    if (newHp <= 0) {
      // Monstruo muerto
      db.killMonster(target.id);
      const loot = JSON.parse(target.loot || '[]');
      if (loot.length > 0) {
        const room = db.getRoom(player.current_room_id);
        const roomItems = room.items || [];
        db.updateRoom(player.current_room_id, { items: [...roomItems, ...loot] });
        lines.push(`   💀 ${target.name} cae fulminado! Soltó: ${loot.join(', ')}.`);
      } else {
        lines.push(`   💀 ${target.name} cae fulminado!`);
      }
      // XP y kills
      const xpGain = Math.floor(5 + (target.max_hp || 10) / 2);
      const newKills = (player.kills || 0) + 1;
      const newXp = (player.xp || 0) + xpGain;
      const newLevel = 1 + Math.floor(newXp / 50);
      db.updatePlayer(player.id, {
        kills: newKills,
        xp: newXp,
        level: newLevel,
      });
      lines.push(`   +${xpGain} XP (Total: ${newXp} XP, Nivel ${newLevel}).`);
      broadcastEvent = `🔥 ¡${player.username} incineró a ${target.name} con ${spellName}!`;
    } else {
      db.updateMonster(target.id, { hp: newHp });
    }

    lines.push(`   💧 Maná restante: ${newMana}/${maxMana}`);

  } else if (spell.type === 'heal') {
    // Hechizo de curación
    const maxHp = player.max_hp;
    const newHp = Math.min(maxHp, player.hp + spell.amount);
    const healed = newHp - player.hp;

    db.updatePlayer(player.id, { hp: newHp, mana: newMana, last_mana_regen: player.last_mana_regen || new Date().toISOString() });

    lines.push(`🪄 Canalizás ${spell.icon} energía curativa...`);
    lines.push(`   Recuperás ${healed} HP. (${player.hp} → ${newHp}/${maxHp})`);
    lines.push(`   💧 Maná restante: ${newMana}/${maxMana}`);

    if (healed === 0) {
      lines[0] = `🪄 Canalizás ${spell.icon} energía curativa... pero ya tenés el HP al máximo.`;
    }

  } else if (spell.type === 'shield') {
    // Escudo mágico
    db.updatePlayer(player.id, { mana: newMana, shield_active: 1, last_mana_regen: player.last_mana_regen || new Date().toISOString() });

    lines.push(`🪄 Invocás ${spell.icon} un escudo mágico.`);
    lines.push(`   El próximo ataque que recibas absorberá ${spell.amount} puntos de daño.`);
    lines.push(`   💧 Maná restante: ${newMana}/${maxMana}`);
  }

  db.logEvent(player.id, player.current_room_id, `cast ${spellName}`, lines.join('\n'));

  return {
    text: lines.join('\n'),
    event: broadcastEvent,
  };
}

/**
 * spells / hechizos — Listar los hechizos conocidos y el maná actual.
 */
function cmdSpells(player) {
  // Regenerar maná antes de mostrar
  player = regenMana(db.getPlayer(player.id));

  const currentMana = player.mana != null ? player.mana : 20;
  const maxMana = player.max_mana || 20;
  const shieldActive = player.shield_active ? ' 🛡️ (escudo activo)' : '';

  const manaBar = (() => {
    const pct = maxMana > 0 ? currentMana / maxMana : 0;
    const filled = Math.round(pct * 8);
    return '['  + '█'.repeat(filled) + '░'.repeat(8 - filled) + ']';
  })();

  const lines = [
    `🪄 SISTEMA DE MAGIA`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `Maná: ${manaBar} ${currentMana}/${maxMana}${shieldActive}`,
    `(Recarga: 1 maná/minuto. Pociones de maná restauran instantáneamente.)`,
    ``,
    `Hechizos disponibles:`,
  ];

  for (const [name, spell] of Object.entries(SPELL_CATALOG)) {
    const canCast = currentMana >= spell.cost ? '✓' : '✗';
    lines.push(`  ${canCast} ${spell.icon} ${name.padEnd(16)} — Coste: ${spell.cost} maná — ${spell.description}`);
  }

  lines.push(``);
  lines.push(`Uso: cast <hechizo>  (ej: "cast bola de fuego", "cast escudo", "cast curación")`);

  return { text: lines.join('\n') };
}

/**
 * clase [guerrero|mago|picaro] — T107: Ver o elegir clase de personaje.
 * - Sin args: muestra la clase actual del jugador y la lista de opciones.
 * - Con args: elige la clase indicada (solo si el jugador aún no tiene clase asignada,
 *   o si lleva menos de 5 kills — período de prueba).
 */
function cmdClase(player, args) {
  player = db.getPlayer(player.id);
  const currentClass = player.player_class || 'sin_clase';

  if (!args || args.length === 0) {
    // Solo mostrar estado actual
    const clsData = classes.getPlayerClass(player);
    const header = clsData
      ? `🎭 Tu clase actual: ${clsData.emoji} ${clsData.name.toUpperCase()}\n   ${clsData.description}`
      : `🎭 Tu clase actual: (sin clase) — todavía no elegiste tu vocación.`;

    const lines = [
      header,
      ``,
      `Clases disponibles:`,
      classes.formatClassList(),
      ``,
      `Para elegir una clase: clase <nombre>`,
      `Ej: clase guerrero  |  clase mago  |  clase picaro`,
      ``,
      currentClass === 'sin_clase'
        ? `⚠️  Podés elegir tu clase en cualquier momento.`
        : `⚠️  Solo podés cambiar de clase si tenés menos de 5 kills (período de prueba).`,
    ];
    return { text: lines.join('\n') };
  }

  // Elegir/cambiar clase
  const rawInput = args.join(' ').toLowerCase().trim();
  const className = classes.resolveClass(rawInput);

  if (!className) {
    return { text: `❌ Clase desconocida: "${rawInput}".\nClases disponibles: guerrero, mago, picaro\nEjemplo: clase guerrero` };
  }

  // Verificar período de prueba (menos de 5 kills = puede cambiar)
  const kills = player.kills || 0;
  const canChange = currentClass === 'sin_clase' || kills < 5;

  if (!canChange) {
    const clsData = classes.getPlayerClass(player);
    return { text: `⚠️ Ya tenés ${kills} kills — tu clase ${clsData.emoji} ${clsData.name} quedó confirmada.\nNo se puede cambiar de clase después del período de prueba (5 kills).` };
  }

  // Aplicar la clase
  const clsStats = classes.getClassStats(className);
  db.updatePlayer(player.id, {
    player_class: className,
    hp: clsStats.hp,
    max_hp: clsStats.max_hp,
    attack: clsStats.attack,
    defense: clsStats.defense,
    mana: clsStats.mana,
    max_mana: clsStats.max_mana,
  });

  const lines = [
    `✅ ¡Elegiste la clase ${clsStats.emoji} ${clsStats.name.toUpperCase()}!`,
    `   ${clsStats.description}`,
    ``,
    `📊 Tus nuevos stats:`,
    `   HP:     ${clsStats.hp}/${clsStats.max_hp}`,
    `   ATK:    ${clsStats.attack}   DEF: ${clsStats.defense}`,
    `   Maná:   ${clsStats.mana}/${clsStats.max_mana}`,
    ``,
    `🌟 Ventajas de clase:`,
    ...clsStats.perks.map(p => `   ▸ ${p}`),
  ];

  if (className === 'picaro') {
    lines.push(``, `💡 Como Pícaro tus golpes críticos son del 25% y esquivas el 20% de ataques.`);
  } else if (className === 'mago') {
    lines.push(``, `💡 Como Mago tus hechizos hacen 1.5× de daño y la recarga de maná es 2× más rápida.`);
  } else if (className === 'guerrero') {
    lines.push(``, `💡 Como Guerrero absorbés más daño y tenés mayor HP máximo.`);
  }

  return { text: lines.join('\n') };
}

// Sobreescribir module.exports para incluir T104
module.exports = { execute, getOrCreatePlayer, ROOM_EFFECTS, resolveExpiredAuctions, getTitle, regenMana, SPELL_CATALOG, getClassReminder };

/**
 * T108: cmdBestiary — Muestra el bestiario personal del jugador.
 */
function cmdBestiary(player) {
  const fresh = db.getPlayer(player.id);
  if (!fresh) return { text: 'Error al leer tu bestiario.' };
  const bestiary = fresh.bestiary ? JSON.parse(fresh.bestiary) : {};
  const entries = Object.values(bestiary);
  if (entries.length === 0) {
    return { text: '📖 Tu bestiario está vacío. ¡Salí a explorar y mata algunos monstruos!' };
  }
  // Ordenar por kills descendente
  entries.sort((a, b) => b.kills - a.kills);
  const lines = [
    ``,
    `╔════════════════════════════════════════╗`,
    `║         📖 BESTIARIO PERSONAL          ║`,
    `╠════════════════════════════════════════╣`,
  ];
  for (const entry of entries) {
    const bar = buildBar(Math.min(entry.kills, 50), 50, 10);
    const firstDate = entry.first_kill ? entry.first_kill.slice(0, 10) : '?';
    const skull = entry.kills >= 20 ? '💀' : entry.kills >= 10 ? '☠' : entry.kills >= 5 ? '⚔' : '·';
    lines.push(`║ ${skull} ${entry.name.padEnd(20).slice(0, 20)} × ${String(entry.kills).padStart(3)} kills ║`);
    lines.push(`║   ${bar}  (desde ${firstDate}) ║`);
    lines.push(`╟────────────────────────────────────────╢`);
  }
  // Reemplazar la última separación por el cierre
  lines[lines.length - 1] = `╚════════════════════════════════════════╝`;
  lines.push(`  Total: ${entries.length} tipo(s) de monstruo cazado(s).`);
  return { text: lines.join('\n') };
}

module.exports = { execute, getOrCreatePlayer, ROOM_EFFECTS, resolveExpiredAuctions, getTitle, regenMana, SPELL_CATALOG, getClassReminder, cmdBestiary };

/**
 * T109: cmdProfile — Tarjeta de aventurero completa en formato ASCII enmarcado.
 */
function cmdProfile(player) {
  const fresh = db.getPlayer(player.id);
  if (!fresh) return { text: 'Error al leer tu perfil.' };

  const cls = classes.getPlayerClass(fresh);
  const clsEmoji = cls ? cls.emoji : '❓';
  const clsName  = cls ? cls.name  : 'Sin clase';
  const title = getTitle(fresh.kills || 0);
  const level = fresh.level || 1;
  const xp    = fresh.xp    || 0;
  const kills = fresh.kills || 0;
  const deaths = fresh.deaths || 0;
  const gold  = fresh.gold  || 0;
  const duelWins   = fresh.duel_wins   || 0;
  const duelLosses = fresh.duel_losses || 0;
  const kd = deaths > 0 ? (kills / deaths).toFixed(2) : kills > 0 ? '∞' : '-';

  // Barra de HP
  const hpBar = buildBar(fresh.hp, fresh.max_hp, 16);
  const manaBar = buildBar(fresh.mana || 0, fresh.max_mana || 20, 16);

  // Logros
  const bestiary = fresh.bestiary ? JSON.parse(fresh.bestiary) : {};
  const bestiaryCount = Object.keys(bestiary).length;
  const totalBestiaryKills = Object.values(bestiary).reduce((s, e) => s + e.kills, 0);

  const achIcons = ach.formatAchievementIcons(fresh);
  const achCount = (() => {
    try {
      const arr = JSON.parse(fresh.achievements || '[]');
      return arr.length;
    } catch(_) { return 0; }
  })();

  // Función para centrar texto en ancho 44
  const W = 44;
  const center = (s) => {
    const pad = Math.max(0, Math.floor((W - s.length) / 2));
    return ' '.repeat(pad) + s;
  };

  const line = (label, value) => {
    const full = `  ${label}: ${value}`;
    return full.slice(0, W);
  };

  const lines = [
    ``,
    `╔${'═'.repeat(W)}╗`,
    `║${center('⚔  TARJETA DE AVENTURERO  ⚔')}║`,
    `╠${'═'.repeat(W)}╣`,
    `║${center(`✦ ${fresh.username.toUpperCase()} ✦`)}║`,
    `║${center(`${clsEmoji} ${clsName}  ·  ${title.full}`)}║`,
    `╟${'─'.repeat(W)}╢`,
    `║${line('Nivel', `${level}  ·  ${xp} XP total`)}║`,
    `║${line('HP   ', `${hpBar} ${fresh.hp}/${fresh.max_hp}`)}║`,
    `║${line('Maná ', `${manaBar} ${fresh.mana || 0}/${fresh.max_mana || 20}`)}║`,
    `║${line('ATK  ', `${fresh.attack}  ·  DEF: ${fresh.defense}`)}║`,
    `╟${'─'.repeat(W)}╢`,
    `║${line('Kills ', `${kills}  ·  Muertes: ${deaths}  ·  K/D: ${kd}`)}║`,
    `║${line('Duelos', `⚔️ ${duelWins} ganados / ${duelLosses} perdidos`)}║`,
    `║${line('Oro   ', `💰 ${gold}g`)}║`,
    `╟${'─'.repeat(W)}╢`,
    `║${line('Hermandad', fresh.guild ? `[${fresh.guild}]` : '(independiente)')}║`,
    `║${line('Mascota  ', fresh.pet || '(sin compañero)')}║`,
    `║${line('Arma     ', fresh.equipped_weapon || '(desarmado)')}║`,
    `╟${'─'.repeat(W)}╢`,
    `║${line('Logros   ', `${achCount} desbloqueados`)}║`,
    `║  ${achIcons.slice(0, W - 2)}║`,
    `║${line('Bestiario', `${bestiaryCount} tipos cazados · ${totalBestiaryKills} kills totales`)}║`,
    `╚${'═'.repeat(W)}╝`,
  ];

  return { text: lines.join('\n') };
}

/**
 * T114: skills/habilidades — Ver habilidades desbloqueadas y cooldowns.
 */
function cmdSkills(player) {
  const fresh = db.getPlayer(player.id);
  if (!fresh) return { text: 'Error al leer tus habilidades.' };

  const level = fresh.level || 1;
  const unlocked = skills.getUnlockedSkills(level);
  const cooldowns = skills.getCooldowns(fresh);
  const now = Date.now();

  const lines = ['⚡ HABILIDADES ACTIVAS', '─'.repeat(40)];

  // Habilidades desbloqueadas
  if (unlocked.length === 0) {
    lines.push('  Aún no desbloqueaste ninguna habilidad.');
    lines.push('  (Nivel 3: Golpetazo · Nivel 6: Golpe de Escudo · Nivel 10: Arenga)');
  } else {
    for (const sk of unlocked) {
      const exp = cooldowns[sk.id];
      const remaining = exp ? Math.max(0, Math.ceil((new Date(exp) - now) / 1000)) : 0;
      const status = remaining > 0 ? `⏳ ${remaining}s cooldown` : '✅ Lista';
      lines.push(`  ⚡ ${sk.name} [${sk.aliases[0]}]`);
      lines.push(`     ${sk.description}`);
      lines.push(`     Estado: ${status}`);
    }
  }

  // Habilidades aún bloqueadas
  const locked = skills.ALL_SKILLS.filter(sk => level < sk.required_level);
  if (locked.length > 0) {
    lines.push('─'.repeat(40));
    lines.push('🔒 Bloqueadas:');
    for (const sk of locked) {
      lines.push(`  🔒 ${sk.name} (Nivel ${sk.required_level}) — ${sk.description}`);
    }
  }

  return { text: lines.join('\n') };
}

/**
 * T114: useSkill — Usar una habilidad activa.
 * context: { broadcast, getPlayerSocket, ... } — contexto de socket handlers
 */
function cmdUseSkill(player, args, context) {
  if (!args || args.length === 0) {
    return { text: 'Uso: smash | escudo_bash | arenga. Ver habilidades disponibles con "skills".' };
  }

  const freshPlayer = db.getPlayer(player.id);
  if (!freshPlayer) return { text: 'Error al leer tu perfil.' };

  const skillAlias = args[0].toLowerCase();
  const skillId = skills.resolveSkillAlias(skillAlias);
  if (!skillId) {
    return { text: `Habilidad "${skillAlias}" no reconocida. Usá "skills" para ver las disponibles.` };
  }

  const { ok, error, skill } = skills.canUseSkill(freshPlayer, skillId);
  if (!ok) return { text: error };

  const room = db.getRoom(freshPlayer.current_room_id);

  // ── Golpetazo (smash) ─────────────────────────────────────────────────────
  if (skillId === 'smash') {
    const monsters = db.getMonstersInRoom(freshPlayer.current_room_id);
    const alive = monsters.filter(m => m.hp > 0);
    if (alive.length === 0) {
      return { text: '⚡ No hay monstruos aquí para golpear.' };
    }
    // Atacar el primer monstruo de la sala
    const target = alive[0];
    const baseDmg = freshPlayer.attack || 5;
    const rawDmg = Math.max(1, Math.floor(baseDmg * skill.dmg_multiplier));
    const variation = Math.floor(rawDmg * 0.2);
    const dmg = rawDmg + Math.floor(Math.random() * (variation * 2 + 1)) - variation;
    const finalDmg = Math.max(1, dmg - Math.floor(target.defense || 0));
    const newHp = Math.max(0, target.hp - finalDmg);
    db.updateMonster(target.id, { hp: newHp });
    // Aplicar cooldown
    const newCooldowns = skills.applyCooldown(freshPlayer, 'smash');
    db.updatePlayer(freshPlayer.id, { skill_cooldowns: newCooldowns });

    const dead = newHp <= 0;
    let text = `⚡ ¡GOLPETAZO! Golpeás al ${target.name} con toda tu fuerza causando ${finalDmg} de daño (×1.8)!`;
    if (dead) {
      text += `\n💀 El ${target.name} sucumbe ante tu brutal ataque.`;
      // Respawn y loot como en ataque normal
      if (target.respawn_room_id) {
        const respawnAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
        db.updateMonster(target.id, { hp: 0, room_id: null, respawn_at: respawnAt });
      }
      // XP básico
      const xpGain = Math.max(5, Math.floor(target.max_hp * 2));
      const newXp = (freshPlayer.xp || 0) + xpGain;
      const newLevel = 1 + Math.floor(newXp / 50);
      const levelUp = newLevel > (freshPlayer.level || 1);
      db.updatePlayer(freshPlayer.id, { xp: newXp, level: newLevel, kills: (freshPlayer.kills || 0) + 1 });
      text += `\n  +${xpGain} XP${levelUp ? ` ✨ ¡SUBE AL NIVEL ${newLevel}!` : ''}`;
      db.addBestiaryKill(freshPlayer.id, target.name);
      if (levelUp) db.addJournalEntry(freshPlayer.id, 'level', `⬆️ Subiste al nivel ${newLevel} tras el Golpetazo.`);
    } else {
      text += `\n  El ${target.name} tiene ${newHp}/${target.max_hp} HP.`;
      text += `\n  (Cooldown: ${skill.cooldown_seconds}s)`;
    }

    // Broadcast a la sala
    if (context && context.broadcastToRoom) {
      context.broadcastToRoom(freshPlayer.current_room_id, freshPlayer.id,
        `⚡ ${freshPlayer.username} usa Golpetazo sobre el ${target.name}! (-${finalDmg} HP)`);
    }
    return { text };
  }

  // ── Golpe de Escudo (shield_bash) ─────────────────────────────────────────
  if (skillId === 'shield_bash') {
    const monsters = db.getMonstersInRoom(freshPlayer.current_room_id);
    const alive = monsters.filter(m => m.hp > 0);
    if (alive.length === 0) {
      return { text: '⚡ No hay monstruos aquí para golpear con el escudo.' };
    }
    const target = alive[0];
    const baseDmg = freshPlayer.attack || 5;
    const variation = Math.floor(baseDmg * 0.2);
    const rawDmg = baseDmg + Math.floor(Math.random() * (variation * 2 + 1)) - variation;
    const finalDmg = Math.max(1, rawDmg - Math.floor(target.defense || 0));
    const newHp = Math.max(0, target.hp - finalDmg);
    // Stun: guardar en status_effects del monstruo
    const monsterEffects = target.status_effects ? JSON.parse(target.status_effects || '{}') : {};
    monsterEffects.stunned = { turns: 1 };
    db.updateMonster(target.id, { hp: newHp, status_effects: JSON.stringify(monsterEffects) });
    // Cooldown
    const newCooldowns = skills.applyCooldown(freshPlayer, 'shield_bash');
    db.updatePlayer(freshPlayer.id, { skill_cooldowns: newCooldowns });

    const dead = newHp <= 0;
    let text = `🛡️ ¡GOLPE DE ESCUDO! Golpeás al ${target.name} con tu escudo (${finalDmg} dmg) aturdiéndolo!`;
    if (dead) {
      text += `\n💀 El impacto fue tan brutal que el ${target.name} cae fulminado.`;
      if (target.respawn_room_id) {
        const respawnAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
        db.updateMonster(target.id, { hp: 0, room_id: null, respawn_at: respawnAt });
      }
      const xpGain = Math.max(5, Math.floor(target.max_hp * 2));
      const newXp = (freshPlayer.xp || 0) + xpGain;
      const newLevel = 1 + Math.floor(newXp / 50);
      const levelUp = newLevel > (freshPlayer.level || 1);
      db.updatePlayer(freshPlayer.id, { xp: newXp, level: newLevel, kills: (freshPlayer.kills || 0) + 1 });
      text += `\n  +${xpGain} XP${levelUp ? ` ✨ ¡SUBE AL NIVEL ${newLevel}!` : ''}`;
      db.addBestiaryKill(freshPlayer.id, target.name);
    } else {
      text += `\n  El ${target.name} está aturdido (no ataca el próximo turno). HP: ${newHp}/${target.max_hp}.`;
      text += `\n  (Cooldown: ${skill.cooldown_seconds}s)`;
    }
    if (context && context.broadcastToRoom) {
      context.broadcastToRoom(freshPlayer.current_room_id, freshPlayer.id,
        `🛡️ ${freshPlayer.username} usa Golpe de Escudo sobre el ${target.name}! (-${finalDmg} HP, aturdido)`);
    }
    return { text };
  }

  // ── Arenga (rally) ────────────────────────────────────────────────────────
  if (skillId === 'rally') {
    const party = freshPlayer.party_id ? db.getPartyMembers(freshPlayer.party_id) : [];
    const sameRoom = party.filter(m => m.id !== freshPlayer.id && m.current_room_id === freshPlayer.current_room_id);

    if (sameRoom.length === 0) {
      return { text: '⚡ No hay compañeros de grupo en tu sala para arenga. Formá un grupo primero (party).' };
    }

    // Aplicar buff ATK temporal a todos en la sala (incluido el jugador)
    const allInRoom = [freshPlayer, ...sameRoom];
    const buffDuration = skill.duration_seconds * 1000;
    const buffExpiresAt = new Date(Date.now() + buffDuration).toISOString();

    for (const member of allInRoom) {
      const mFresh = db.getPlayer(member.id);
      if (!mFresh) continue;
      const effects = mFresh.status_effects ? JSON.parse(mFresh.status_effects || '{}') : {};
      effects.rally = { atk_bonus: skill.atk_bonus, expires_at: buffExpiresAt };
      // Actualizar el ATK temporalmente
      const newAtk = (mFresh.attack || 5) + skill.atk_bonus;
      db.updatePlayer(mFresh.id, { attack: newAtk, status_effects: JSON.stringify(effects) });
    }

    // Cooldown
    const newCooldowns = skills.applyCooldown(freshPlayer, 'rally');
    db.updatePlayer(freshPlayer.id, { skill_cooldowns: newCooldowns });

    const members_list = sameRoom.map(m => m.username).join(', ');
    const text = `⚡ ¡ARENGA! Tu grito de batalla infunde fuerza a ${members_list} y a vos mismo.\n  +${skill.atk_bonus} ATK para todos por ${skill.duration_seconds}s.\n  (Cooldown: ${skill.cooldown_seconds}s)`;

    if (context && context.broadcastToRoom) {
      context.broadcastToRoom(freshPlayer.current_room_id, freshPlayer.id,
        `⚡ ${freshPlayer.username} arenga a su grupo: +${skill.atk_bonus} ATK por ${skill.duration_seconds}s!`);
    }

    // Programar reverción del buff
    setTimeout(() => {
      for (const member of allInRoom) {
        try {
          const mFresh2 = db.getPlayer(member.id);
          if (!mFresh2) continue;
          const eff = mFresh2.status_effects ? JSON.parse(mFresh2.status_effects || '{}') : {};
          if (eff.rally) {
            delete eff.rally;
            const revertAtk = Math.max(1, (mFresh2.attack || 5) - skill.atk_bonus);
            db.updatePlayer(mFresh2.id, { attack: revertAtk, status_effects: JSON.stringify(eff) });
          }
        } catch (_) {}
      }
    }, buffDuration);

    return { text };
  }

  return { text: `Habilidad "${skillId}" no implementada aún.` };
}

/**
 * T113: journal/diario — Diario personal del aventurero.
 * Muestra las últimas 10 entradas registradas automáticamente.
 */
function cmdJournal(player) {
  const fresh = db.getPlayer(player.id);
  if (!fresh) return { text: 'Error al leer tu diario.' };

  const journal = fresh.journal ? JSON.parse(fresh.journal) : [];
  if (journal.length === 0) {
    return { text: '📖 Tu diario está vacío. ¡Empieza a aventurarte para escribir tu historia!' };
  }

  // Mostrar los últimos 10 entries (más recientes al final)
  const entries = journal.slice(-10).reverse();
  const TYPE_LABELS = {
    boss:        '⚔️  Boss',
    quest:       '📜 Quest',
    achievement: '🏅 Logro',
    level:       '⬆️  Nivel',
    death:       '💀 Muerte',
  };

  const W = 50;
  const lines = [
    `╔${'═'.repeat(W)}╗`,
    `║${'  📖 DIARIO DE ' + (fresh.username).toUpperCase() + '  '.padEnd(W - 16 - fresh.username.length)}║`,
    `╟${'─'.repeat(W)}╢`,
  ];

  for (const e of entries) {
    const typeLabel = TYPE_LABELS[e.type] || '📝 Evento';
    const dateStr  = e.at ? new Date(e.at).toISOString().replace('T', ' ').slice(0, 16) : '??';
    const header   = `${typeLabel}  ${dateStr}`;
    const msg      = e.message || '';
    // Truncar si es necesario
    const msgTrunc = msg.length > W - 2 ? msg.slice(0, W - 5) + '...' : msg;
    lines.push(`║  ${header.slice(0, W - 4).padEnd(W - 3)}║`);
    lines.push(`║    ${msgTrunc.padEnd(W - 5)}║`);
    lines.push(`╟${'─'.repeat(W)}╢`);
  }

  // Reemplazar el último separador por el cierre
  lines[lines.length - 1] = `╚${'═'.repeat(W)}╝`;
  lines.push(`(${journal.length} entradas en total · mostrando las últimas ${entries.length})`);

  return { text: lines.join('\n') };
}

/**
 * T116: note / apunte — notas personales del jugador.
 * Subcomandos: add <texto>, list (default), del <n>
 */
function cmdNote(player, args) {
  player = db.getPlayer(player.id);
  const MAX_NOTES = 10;
  const raw = player.notes;
  const notes = Array.isArray(raw) ? raw : (raw ? JSON.parse(raw) : []);

  const sub = args && args[0] ? args[0].toLowerCase() : 'list';

  // ── note add <texto> ───────────────────────────────────────────────────────
  if (sub === 'add' || sub === 'agregar' || sub === 'nueva' || sub === 'nuevo') {
    const text = args.slice(1).join(' ').trim();
    if (!text) {
      return { text: '📝 Escribí el apunte después del comando.\n  Ej: note add Llave oxidada está en sala 8' };
    }
    if (text.length > 200) {
      return { text: `📝 El apunte es demasiado largo (${text.length}/200 caracteres). Sé más conciso.` };
    }
    if (notes.length >= MAX_NOTES) {
      return { text: `📝 Ya tenés ${MAX_NOTES} apuntes (el máximo). Borrá alguno con "note del <número>" para hacer espacio.` };
    }
    const entry = { text, at: new Date().toISOString().slice(0, 16).replace('T', ' ') };
    notes.push(entry);
    db.updatePlayer(player.id, { notes: JSON.stringify(notes) });
    return { text: `📝 Apunte guardado (#${notes.length}): "${text}"` };
  }

  // ── note del <n> ──────────────────────────────────────────────────────────
  if (sub === 'del' || sub === 'borrar' || sub === 'eliminar' || sub === 'delete' || sub === 'rm') {
    const idx = parseInt(args[1], 10);
    if (isNaN(idx) || idx < 1 || idx > notes.length) {
      return { text: `📝 Número inválido. Tenés ${notes.length} apunte(s). Usá un número entre 1 y ${notes.length}.` };
    }
    const removed = notes.splice(idx - 1, 1)[0];
    db.updatePlayer(player.id, { notes: JSON.stringify(notes) });
    return { text: `🗑️ Apunte #${idx} eliminado: "${removed.text}"` };
  }

  // ── note list (default) ────────────────────────────────────────────────────
  if (notes.length === 0) {
    return { text: '📝 No tenés apuntes todavía.\n  Agregá uno con: note add <texto>\n  Ejemplo: note add La llave oxidada está en sala 8' };
  }

  const W = 44;
  const lines = [
    `╔${'═'.repeat(W)}╗`,
    `║${'  📝 TUS APUNTES'.padEnd(W)}║`,
    `╟${'─'.repeat(W)}╢`,
  ];
  notes.forEach((n, i) => {
    const header = `#${i + 1}  ${n.at || ''}`;
    const body = n.text.length > W - 4 ? n.text.slice(0, W - 7) + '...' : n.text;
    lines.push(`║  ${header.slice(0, W - 4).padEnd(W - 2)}║`);
    lines.push(`║    ${body.padEnd(W - 4)}║`);
    if (i < notes.length - 1) lines.push(`╟${'─'.repeat(W)}╢`);
  });
  lines.push(`╚${'═'.repeat(W)}╝`);
  lines.push(`(${notes.length}/${MAX_NOTES} apuntes · "note del <n>" para borrar)`);

  return { text: lines.join('\n') };
}

module.exports = { execute, getOrCreatePlayer, ROOM_EFFECTS, resolveExpiredAuctions, getTitle, regenMana, SPELL_CATALOG, getClassReminder, cmdBestiary, cmdProfile, cmdJournal };
