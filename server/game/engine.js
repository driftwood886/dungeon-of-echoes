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
const guildQuests = require('./guild_quests'); // T189: quests de guild
const worldEvents = require('./worldEvents');
const weather     = require('./weather'); // T166: clima del dungeon
const tutorial = require('./tutorial');
const crafting = require('./crafting');
const classes  = require('./classes'); // T107: sistema de clases
const skills   = require('./skills');  // T114: habilidades activas por nivel
const ambient  = require('./ambient'); // T121: período del día

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
  // Sala 19 — Cámara del Eco: confusión mental (-1 ATK)
  19: { type: 'debuff', stat: 'attack', amount: -1, label: '🔊 Ecos Enloquecedores', msg: '🔊 Los ecos multiplicados te confunden y desorientan. (-1 ATK mientras estés aquí)' },
  // Sala 20 — Abismo Eterno: el vacío drena energía (-2 HP al entrar)
  20: { type: 'damage', amount: 2, label: '🌑 Vacío Eterno', msg: '🌑 La presencia del Abismo Eterno drena tu energía vital. (-2 HP)' },
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

// ── Sistema de intercambio seguro (T129) ──────────────────────────────────────
// pendingTrades.get(targetPlayerId) → { initiatorId, initiatorUsername, item, roomId, expiresAt }
const pendingTrades = new Map();

// ── Sistema AFK (T146) ────────────────────────────────────────────────────────
// afkPlayers: Set de player IDs que están AFK
// afkCooldowns: Map playerId → timestamp (ms) del último toggle, para cooldown 10s
const afkPlayers = new Set();
const afkCooldowns = new Map();

// ── Killing Spree (T159) ──────────────────────────────────────────────────────
// killStreakMap: playerId → número de kills consecutivos sin morir
// Se resetea al morir. Bonus XP en hitos: 5, 10, 15, 20...
const killStreakMap = new Map();
const STREAK_HITO_BONUS = 10; // XP extra al alcanzar cada hito de racha

// ── XP por exploración de sesión (T160) ───────────────────────────────────────
// sessionExploredRooms: playerId → Set de room IDs visitados en esta sesión
// XP bonus de +2 por sala descubierta por primera vez en la sesión
const sessionExploredRooms = new Map();

// ── Sistema de combos (T192) ───────────────────────────────────────────────────
// comboMap: playerId → { monsterId, count }
// Atacar al mismo monstruo consecutivamente incrementa el combo (máx 5).
// Cada nivel de combo da +1 daño al siguiente ataque.
// Se resetea al cambiar de objetivo, al morir, o al morir el monstruo.
const comboMap = new Map();
const COMBO_MAX = 5;
const COMBO_MSGS = {
  2: '⚡ ¡COMBO x2!',
  3: '🔥 ¡COMBO x3!',
  4: '💥 ¡COMBO x4! ¡Estás en llamas!',
  5: '🌟 ¡COMBO MÁXIMO x5! ¡Golpe devastador!',
};

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

// ── Posturas de combate (T161) ────────────────────────────────────────────────
const STANCES = {
  agresivo:    { icon: '⚔️',  atkMod: +2, defMod: -1, extraMiss: 0.05, desc: 'Atacás más fuerte pero quedás más expuesto. +2 ATK / -1 DEF / 5% más chance de fallar.' },
  defensivo:   { icon: '🛡️',  atkMod: -1, defMod: +2, extraMiss: 0,    desc: 'Priorizás la defensa. -1 ATK / +2 DEF.' },
  equilibrado: { icon: '⚖️',  atkMod:  0, defMod:  0, extraMiss: 0,    desc: 'Postura estándar, sin modificadores.' },
};

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

  // ── T164: Guardar en historial de sesión ────────────────────────────────────
  if (action.command !== 'history') {
    const hist = sessionCommandHistory.get(playerId) || [];
    hist.unshift(input.slice(0, 32)); // guardar al frente, máx 32 chars
    if (hist.length > 20) hist.pop();
    sessionCommandHistory.set(playerId, hist);
  }

  // ── Lógica de tutorial (T091) ──────────────────────────────────────────────
  const tutorialStep = player.tutorial_step;
  if (tutorialStep && tutorialStep > 0 && player.current_room_id === tutorial.TUTORIAL_ROOM_ID) {
    // T175: Permitir el comando hardcore durante el tutorial (se puede activar antes del primer kill)
    if (action.command !== 'hardcore') {
      const tutResult = handleTutorialCommand(player, action, tutorialStep);
      if (tutResult) {
        db.logEvent(playerId, player.current_room_id, input, tutResult.text.slice(0, 200));
        return tutResult;
      }
    }
  }

  let result;

  // ── T146: Verificación AFK ─────────────────────────────────────────────────
  // Si el jugador está AFK, bloquear todos los comandos excepto 'afk' (y comandos de chat pasivos)
  if (afkPlayers.has(player.id) && action.command !== 'afk') {
    return { text: `💤 Estás en modo ausente (AFK). Escribí "afk" para volver al juego.` };
  }

  // ── T175: Ghost mode (Hardcore fallen) ────────────────────────────────────
  // Si el jugador cayó en modo Hardcore, solo puede usar comandos pasivos
  const GHOST_ALLOWED = new Set(['look', 'status', 'who', 'score', 'profile', 'bestiary', 'journal', 'news', 'dungeon', 'history', 'help', 'changelog', 'server', 'time', 'enemies', 'compare', 'reputation', 'path', 'guide', 'find', 'runas', 'map', 'hardcore', 'read', 'lore', 'weather', 'world', 'challenge', 'rank', 'inventory', 'memorial']);
  if (player.fallen === 1 && !GHOST_ALLOWED.has(action.command)) {
    return { text: `✝ Tu personaje cayó en modo Hardcore. Solo podés usar comandos pasivos.\n  (look, status, who, score, map, etc.)\n  Escribí "hardcore" para ver tu estado.` };
  }

  switch (action.command) {
    case 'look':      result = cmdLook(player); break;
    case 'move':      result = cmdMove(player, action.args[0]); break;
    case 'inventory': result = cmdInventory(player); break;
    case 'status':    result = cmdStatus(player); break;
    case 'attack':    result = cmdAttack(player, action.args.join(' ')); break;
    case 'flee':      result = cmdFlee(player, action.args ? action.args.join(' ') : ''); break;
    case 'pick':      result = cmdPick(player, action.args.join(' ')); break;
    case 'use':       result = cmdUse(player, action.args.join(' ')); break;
    case 'heal':      result = cmdHeal(player); break;
    case 'drop':      result = cmdDrop(player, action.args.join(' ')); break;
    case 'examine':   result = cmdExamine(player, action.args.join(' ')); break;
    case 'equip':     result = cmdEquip(player, action.args.join(' ')); break;
    case 'unequip':   result = cmdUnequip(player); break;
    case 'wear':      result = cmdWear(player, action.args.join(' ')); break;
    case 'unwear':    result = cmdUnwear(player); break;
    case 'map':       result = cmdMap(player); break;
    case 'who':       result = cmdWho(); break;
    case 'score':     result = cmdScore(player, action.args); break;
    case 'give':      result = cmdGive(player, action.args); break;
    case 'pay':       result = cmdPay(player, action.args); break;
    case 'loot':      result = cmdLoot(player); break;
    case 'whisper':   result = cmdWhisper(player, action.args); break;
    case 'tell':      result = cmdTell(player, action.args); break;
    case 'reply':     result = cmdReply(player, action.args); break;
    case 'inbox':     result = cmdInbox(player, action.args); break;
    case 'unlock':    result = cmdUnlock(player, action.args[0]); break;
    case 'disarm':    result = cmdDisarm(player); break;
    case 'rest':      result = cmdRest(player, context); break;
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
    case 'bounty':       result = cmdBounty(player, action.args.join(' ')); break;
    case 'bounties':     result = cmdBounties(player); break;
    case 'wanted':       result = cmdWanted(player, action.args.join(' ')); break;  // T174
    case 'rank':         result = cmdRank(player, action.args.join(' ')); break;    // T176
    case 'hardcore':     result = cmdHardcore(player, action.args); break;          // T175
    case 'memorial':     result = cmdMemorial(); break;                              // T178
    case 'world':        result = cmdWorld(); break;
    case 'weather':      result = cmdWeather(); break;
    case 'craft':        result = cmdCraft(player, action.args); break;
    case 'recipes':      result = cmdRecipes(); break;
    case 'news':         result = cmdNews(); break;
    case 'forage':       result = cmdForage(player); break;
    case 'survey':       result = cmdSurvey(player); break;
    case 'pet':          result = cmdPet(player, action.args); break;
    case 'auction':      result = cmdAuction(player, action.args); break;
    case 'bid':          result = cmdBid(player, action.args); break;
    case 'auctions':     result = cmdAuctions(); break;
    case 'market':       result = cmdMarket(player, action.args, context); break;
    case 'gesture':      result = cmdGesture(player, action.args[0]); break;
    case 'pray':         result = cmdPray(player, action.args); break;
    case 'preview':      result = cmdPreview(player, action.args); break;
    case 'calendar':     result = cmdCalendar(player); break;
    case 'bulletin':     result = cmdBulletin(player, action.args, context); break;
    case 'enchant':      result = cmdEnchant(player, action.args); break;
    case 'trivia':       result = cmdTrivia(player, action.args); break;
    case 'worldgoals':   result = cmdWorldGoals(); break;
    case 'records':      result = cmdRecords(); break;
    case 'score_session': result = cmdScoreSession(player, context); break;  // T198
    case 'card':         result = cmdCard(player); break;                     // T197
    case 'trivia_pub':   result = cmdTriviaPub(player, action.args, context); break; // T196
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
    case 'changelog':    result = cmdChangelog(); break;
    case 'server':       result = cmdServerStats(); break;
    case 'time':         result = cmdTime(); break;
    case 'enemies':      result = cmdEnemies(action.args); break;
    case 'compare':      result = cmdCompare(player, action.args); break;
    case 'reputation':   result = cmdReputation(player); break;
    case 'recall':       result = cmdRecall(player); break;
    case 'back':         result = cmdBack(player, context); break;
    case 'trade':        result = cmdTrade(player, action.args); break;
    case 'lore':         result = cmdLore(action.args.join(' ')); break;
    case 'peek':         result = cmdPeek(player, action.args); break;
    case 'runas':        result = cmdRunas(player); break;
    case 'challenge':    result = cmdChallenge(player); break;
    case 'macro':        result = cmdMacro(player, action.args, context); break;
    case 'afk':          result = cmdAfk(player); break;
    case 'write':        result = cmdWrite(player, action.args); break;
    case 'read':         result = cmdReadWall(player); break;
    case 'greet':        result = cmdGreet(player, action.args, context); break;
    case 'search':       result = cmdSearch(player, action.args); break;
    case 'study':        result = cmdStudy(player, action.args); break;
    case 'dungeon':      result = cmdDungeonStatus(); break;
    case 'session':      result = cmdSession(player, context); break;
    case 'sessions':     result = cmdSessions(player); break;
    case 'score_time':   result = cmdScoreTime(); break;
    case 'stance':       result = cmdStance(player, action.args); break;
    case 'path':         result = cmdPath(player, action.args); break;
    case 'nick':         result = cmdNick(player, action.args); break;
    case 'history':      result = cmdHistory(player); break;
    case 'find':         result = cmdFind(player, action.args); break;
    case 'guide':        result = cmdGuide(action.args); break;
    case 'friend':       result = cmdFriend(player, action.args); break;
    case 'vault':        result = cmdVault(player, action.args); break;         // T200
    case 'epitaph':      result = cmdEpitaph(player, action.args); break;       // T201
    case 'follow':       result = cmdFollow(player, action.args, context); break; // T204
    case 'unfollow':     result = cmdUnfollow(player, context); break;           // T204
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
          inbox: 'inbox', bandeja: 'inbox', mensajes: 'inbox', buzon: 'inbox',
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
          study: 'study', estudiar: 'study', analizar: 'study', investigar: 'study',
          wear: 'wear', ponerse: 'wear', vestir: 'wear',
          unwear: 'unwear', quitarse: 'unwear', desvestir: 'unwear',
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
  const visitResult = db.trackRoomVisit(player.id, targetId);
  const freshForCartog = db.getPlayer(player.id);
  if (freshForCartog) {
    const cartogAchs = ach.checkAchievements(freshForCartog, {});
    // Los nuevos logros se notificarán en la respuesta si los hay
  }

  // T165: Mensaje de primera visita permanente
  const firstVisitEver = visitResult.isNew;

  // T141: Desafío diario de salas visitadas
  const roomsVisited = (() => { try { return JSON.parse(freshForCartog && freshForCartog.rooms_visited || '[]'); } catch (_) { return []; } })();
  const roomsCr = db.updateDailyChallengeProgress(player.id, 'rooms', null, roomsVisited.includes(targetId) ? 0 : 1);
  // (Solo suma si es una sala nueva en esta sesión; el progreso se acumula naturalmente)

  // ── T160: XP por exploración de sesión ───────────────────────────────────
  // +2 XP la primera vez que se visita una sala en esta sesión
  let explorationMsg = '';
  if (!sessionExploredRooms.has(player.id)) {
    sessionExploredRooms.set(player.id, new Set());
  }
  const exploredSet = sessionExploredRooms.get(player.id);
  if (!exploredSet.has(targetId)) {
    exploredSet.add(targetId);
    const freshExp = db.getPlayer(player.id);
    const newXp = (freshExp.xp || 0) + 2;
    const newLevel = Math.floor(newXp / 50) + 1;
    const levelUp = newLevel > (freshExp.level || 1);
    const upd = { xp: newXp, level: newLevel };
    if (levelUp) {
      upd.max_hp = (freshExp.max_hp || 30) + 5;
      upd.hp = Math.min(freshExp.hp, upd.max_hp);
      upd.attack = (freshExp.attack || 5) + 1;
    }
    db.updatePlayer(player.id, upd);
    explorationMsg = `\n🗺️ ¡Sala descubierta esta sesión! +2 XP de explorador.${levelUp ? ` ✨ ¡SUBÍS AL NIVEL ${newLevel}!` : ''}`;
  }

  // Construir respuesta
  const moveText = `Vas hacia el ${dungeon.DIR_NAMES[dungeon.normalizeDirection(direction)] || direction}.`;
  const roomDesc = dungeon.describeRoom(targetId, player.id);

  // ── Verificar trampa en la sala destino ─────────────────────────────────
  let trapText = '';
  const targetRoomFull = db.getRoom(targetId);
  // T120: si el jugador tiene mascota, 15% de chance de avisar la trampa antes de activarse
  if (targetRoomFull && targetRoomFull.trap && targetRoomFull.trap.active) {
    const trap = targetRoomFull.trap;
    // Aviso de mascota (T120): 15% de chance de prevenir el daño
    if (player.pet && Math.random() < 0.15) {
      trapText = `\n\n🐾 ¡Tu ${player.pet} te advierte a tiempo! Evitás la trampa: ${trap.description.split('–')[0].trim()}.`;
    } else {
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

  // T207: Eventos cinemáticos de primera visita para salas especiales
  const CINEMATIC_EVENTS = {
    15: '⛪ A medida que cruzás el umbral de la Catedral de la Oscuridad, el eco de tus pasos revela la inmensidad del lugar. Las vidrieras rotas dejan entrar rayos de luz violácea. Sentís el peso de siglos de oscuridad posarse sobre tus hombros.',
    22: '🪦 La Cripta de los Valientes te recibe en silencio. Las placas en las paredes murmuran nombres olvidados. Una voz que no existe te susurra: "¿Serás digno de ser recordado aquí, o morirás en el anonimato?"',
    14: '⚒️ El calor del Taller de la Forja te golpea al entrar. Las yunques abandonadas todavía tienen forma de espadas a medio crear. El fuego del hogar nunca se apagó — lleva ardiendo siglos, alimentado por algo que no es madera.',
    11: '❄️ La Galería de Hielo detiene tu respiración. Las paredes de cristal azul reflejan tu imagen distorsionada en docenas de ángulos. En uno de los reflejos, tu imagen te devuelve la mirada... medio segundo antes que vos.',
    20: '🕳️ Al asomarte al Abismo Eterno, el vacío te mira de vuelta. No hay fondo visible. Solo oscuridad infinita, y el certero presentimiento de que algo muy antiguo — y muy hambriento — acaba de notar tu presencia.',
  };

  const cinematicEvent = (firstVisitEver && CINEMATIC_EVENTS[targetId])
    ? `\n\n✨ ${CINEMATIC_EVENTS[targetId]}`
    : '';

  // T165: Badge de primera visita permanente
  const firstVisitMsg = firstVisitEver ? `\n\n🌟 ¡Primera vez que explorás esta sala! (${visitResult.visited.length} salas descubiertas en total)` : '';

  // T206: Efectos de climas extremos al moverse
  let extremeWeatherMsg = '';
  if (weather.isBlizzard()) {
    // El blizzard causa mensaje de ralentización
    extremeWeatherMsg = '\n\n🌨️ ¡El BLIZZARD ralentiza tus movimientos! Te abrís paso con dificultad entre la nieve sobrenatural.';
  } else if (weather.isSporeStorm()) {
    // La tormenta de esporas envenena al moverse en salas "dungeon" (no sagradas/especiales)
    const SAFE_ROOMS = new Set([1, 4, 16, 17, 18, 21, 22]); // salas relativamente seguras
    if (!SAFE_ROOMS.has(targetId)) {
      const freshPForStorm = db.getPlayer(player.id);
      // 40% de chance de envenenarse al entrar a una sala peligrosa
      if (Math.random() < 0.40 && freshPForStorm && !freshPForStorm.is_poisoned) {
        db.updatePlayer(player.id, { is_poisoned: 1 });
        extremeWeatherMsg = '\n\n☠️ Las esporas tóxicas te envuelven al moverte. ¡Estás ENVENENADO! Buscá un antídoto.';
      } else if (freshPForStorm && freshPForStorm.is_poisoned) {
        extremeWeatherMsg = '\n\n☠️ Las esporas agravan tu veneno. Los corredores están saturados de toxinas.';
      } else {
        extremeWeatherMsg = '\n\n☠️ Las esporas tóxicas flotan en el aire — tenés suerte de no haberte envenenado esta vez.';
      }
    }
  } else if (weather.isScorching()) {
    // El calor abrasador reduce HP máx temporalmente (se aplica como mensaje informativo)
    const freshPForHeat = db.getPlayer(player.id);
    if (freshPForHeat && freshPForHeat.hp > freshPForHeat.max_hp - 5) {
      const cappedHp = Math.max(1, freshPForHeat.max_hp - 5);
      if (freshPForHeat.hp > cappedHp) {
        db.updatePlayer(player.id, { hp: cappedHp });
        extremeWeatherMsg = `\n\n🔥 El CALOR ABRASADOR debilita tu cuerpo. Tu HP máximo efectivo es ${freshPForHeat.max_hp - 5} temporalmente (${cappedHp}/${freshPForHeat.max_hp} HP).`;
      }
    }
  }

  return {
    text: `${moveText}\n${roomDesc}${trapText}${effectText}${explorationMsg}${firstVisitMsg}${cinematicEvent}${extremeWeatherMsg}`,
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
  const itemLines = player.inventory.map((item, i) => {
    const emoji = items.getRarityEmoji(item);
    const rarity = items.getItemRarity(item);
    const rarityLabel = rarity !== 'común' ? ` (${rarity})` : '';
    return `  ${i + 1}. ${emoji} ${item}${rarityLabel}`;
  });

  // Resumen al final
  const total = player.inventory.length;
  const rareCount = player.inventory.filter(i => {
    const r = items.getItemRarity(i);
    return r !== 'común';
  }).length;
  const summary = rareCount > 0
    ? `─ ${total} ítem${total !== 1 ? 's' : ''} (${rareCount} no común${rareCount !== 1 ? 'es' : ''})`
    : `─ ${total} ítem${total !== 1 ? 's' : ''}`;
  const equippedLine = player.equipped_weapon
    ? `⚔️  Equipada: ${player.equipped_weapon}`
    : '';

  const parts = [`Inventario:\n${itemLines.join('\n')}`, summary];
  if (equippedLine) parts.push(equippedLine);
  return { text: parts.join('\n') };
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
  const repLevel = db.getReputationLevel(player.reputation || 0);
  const repNextText = repLevel.nextThreshold
    ? ` (+${repLevel.nextThreshold - repLevel.points} pts para siguiente)`
    : ' (máx)';
  const weaponLine = player.equipped_weapon
    ? `Arma:     ${player.equipped_weapon}`
    : `Arma:     (desarmado — ataque base)`;

  // Efectos de estado activos
  const statusFx = player.status_effects || {};
  const statusLines = [];
  if (statusFx.poisoned) {
    statusLines.push(`☠ ENVENENADO — ${statusFx.poisoned.turns} turno(s) restante(s) (${statusFx.poisoned.damage} dmg/turno). Usá "use antídoto" para curarte.`);
  }
  if (statusFx.webbed) {
    statusLines.push(`🕸 ENREDADO — ${statusFx.webbed.turns} turno(s) sin poder atacar.`);
  }
  if (statusFx.blinded) {
    statusLines.push(`🌑 CEGADO — ${statusFx.blinded.turns} turno(s) restante(s) (-${statusFx.blinded.amount} DEF efectiva).`);
  }

  // T153: Buffs de pergaminos activos
  const scrollsFx = JSON.parse(player.active_scrolls || '{}');
  const now = Date.now();
  for (const [effect, data] of Object.entries(scrollsFx)) {
    if (data.expires_at > now) {
      const secsLeft = Math.ceil((data.expires_at - now) / 1000);
      const parts = [];
      if (data.atk_bonus > 0) parts.push(`+${data.atk_bonus} ATK`);
      if (data.def_bonus > 0) parts.push(`+${data.def_bonus} DEF`);
      const effectNames = { fury: '📜 FURIA', shield: '📜 ESCUDO MÁGICO', speed: '📜 VELOCIDAD' };
      statusLines.push(`${effectNames[effect] || '📜 BUFF'} — ${parts.join(', ')} por ${secsLeft}s más.`);
    }
  }

  const text = [
    `\n=== ${player.username.toUpperCase()} ===`,
    player.fallen === 1 ? `☠ CAÍDO en HARDCORE — modo fantasma ✝` : (player.is_hardcore === 1 ? `🔴 MODO HARDCORE ACTIVO` : null),
    player.nickname ? `Apodo:    "${player.nickname}"` : null,
    `Título:   ${getTitle(kills).full}`,
    player.player_class && player.player_class !== 'sin_clase'
      ? `Clase:    ${(classes.getPlayerClass(player) || {}).emoji || ''} ${(classes.getPlayerClass(player) || {}).name || player.player_class}`
      : `Clase:    (sin clase — usá "clase" para elegir)`,
    `Nivel:    ${level}  (${xp} XP total | kills: ${kills} | muertes: ${deaths})`,
    `XP sig.:  ${xpBar} ${xp % 50}/50`,
    `HP:       ${hpBar} ${player.hp}/${player.max_hp}`,
    `Ataque:   ${player.attack}${player.pet ? ` (+1 🐾 mascota = ${player.attack + 1} efectivo)` : ''}`,
    `Defensa:  ${player.defense}`,
    `Oro:      💰 ${gold}g`,
    weaponLine,
    player.equipped_armor
      ? `Armadura: 🛡 ${player.equipped_armor}`
      : `Armadura: (sin armadura — defensa base)`,
    (() => {
      const stanceName = player.stance || 'equilibrado';
      const st = (typeof STANCES !== 'undefined' ? STANCES : {})[stanceName];
      return st ? `Postura:  ${st.icon} ${stanceName}` : null;
    })(),
    `Duelos:   ⚔️ ${duelWins} ganados / ${duelLosses} perdidos`,
    `Reputación: ${repLevel.icon} ${repLevel.name} (${repLevel.points} pts)${repNextText}`,
    `Ubicación: ${roomName}`,
    player.guild ? `Hermandad: [${player.guild}]` : `Hermandad: (sin guild)`,
    player.pet   ? `Mascota:   ${player.pet}` : `Mascota:   (sin compañero)`,
    (() => {
      const streak = killStreakMap.get(player.id) || 0;
      return streak >= 3 ? `Racha:    🔥 ${streak} kills consecutivos` : null;
    })(),
    ...(statusLines.length ? ['', ...statusLines] : []),
  ].filter(l => l !== null).join('\n');

  // Agregar íconos de logros al final
  const achIcons = ach.formatAchievementIcons(player);
  const achLine = `Logros:   ${achIcons}`;

  return { text: text + '\n' + achLine };
}

// T143: IDs de maniquíes de entrenamiento (sala 21)
const TRAINING_ROOM_ID = 21;
const TRAINING_DUMMY_IDS = new Set([23, 24, 25]);

/**
 * T143: _cmdTrainingFight — Combate completo contra un maniquí en la Sala de Práctica.
 * Resuelve el combate turno a turno hasta que el maniquí muere o el jugador queda en < 5 HP.
 * No otorga XP, kills ni loot. Al terminar muestra estadísticas detalladas y regenera el maniquí.
 */
function _cmdTrainingFight(player, monster) {
  const lines = [];
  const monsterNameArticle = monster.name;

  lines.push(`🎯 ¡Iniciás sesión de entrenamiento contra el ${monsterNameArticle}!`);
  lines.push(`   (Nada de lo que pase aquí afecta tu registro real.)`);
  lines.push(`${'─'.repeat(44)}`);

  // Estadísticas del combate
  const stats = {
    turns: 0,
    dmg_dealt: 0,
    dmg_received: 0,
    crits: 0,
    dodges: 0,
    player_hp_start: player.hp,
  };

  // Clonar HP del monstruo para la simulación (no persistimos daño)
  let monsterHp = monster.hp;
  const monsterMaxHp = monster.max_hp;

  // Estado local del jugador (sin persistir cambios de HP salvo al final)
  let playerHp = player.hp;

  const classes = require('./classes');
  const clsData = classes.getPlayerClass(player);
  const critChance = 0.10 + (clsData ? (clsData.crit_bonus || 0) / 100 : 0);
  const dodgeChance = 0.08 + (clsData ? (clsData.dodge_bonus || 0) / 100 : 0);

  let MAX_TURNS = 50; // seguridad
  while (monsterHp > 0 && playerHp > 4 && MAX_TURNS-- > 0) {
    stats.turns++;

    // Jugador ataca
    const petBonus = player.pet ? 1 : 0;
    const atkBase = (player.attack || 5) + petBonus;
    const variance = Math.floor(atkBase * 0.2);
    const rawDmg = atkBase + (variance > 0 ? Math.floor(Math.random() * (variance * 2 + 1)) - variance : 0);
    const isCrit = Math.random() < critChance;
    const playerDmg = Math.max(1, (isCrit ? rawDmg * 2 : rawDmg) - (monster.defense || 0));
    monsterHp = Math.max(0, monsterHp - playerDmg);

    if (isCrit) {
      stats.crits++;
      lines.push(`  T${stats.turns} 💥 CRÍTICO: ${playerDmg} dmg al maniquí (${monsterHp}/${monsterMaxHp} HP)`);
    } else {
      lines.push(`  T${stats.turns} ⚔  Atacás: ${playerDmg} dmg al maniquí (${monsterHp}/${monsterMaxHp} HP)`);
    }
    stats.dmg_dealt += playerDmg;

    if (monsterHp <= 0) break;

    // Maniquí contraataca
    const monAtk = monster.attack || 2;
    const monVariance = Math.floor(monAtk * 0.2);
    const monRaw = monAtk + (monVariance > 0 ? Math.floor(Math.random() * (monVariance * 2 + 1)) - monVariance : 0);
    const isDodge = Math.random() < dodgeChance;
    if (isDodge) {
      stats.dodges++;
      lines.push(`  T${stats.turns} 💨 Esquivás el golpe del maniquí!`);
    } else {
      const dmgToPlayer = Math.max(1, monRaw - (player.defense || 0));
      playerHp = Math.max(0, playerHp - dmgToPlayer);
      stats.dmg_received += dmgToPlayer;
      lines.push(`  T${stats.turns} 🩸 Maniquí te golpea: ${dmgToPlayer} dmg (${playerHp}/${player.max_hp} HP)`);
    }
  }

  lines.push(`${'─'.repeat(44)}`);

  if (monsterHp <= 0) {
    lines.push(`💥 ¡Destrozaste al ${monsterNameArticle} en ${stats.turns} turnos!`);
  } else {
    lines.push(`⚠️  Retirás del entrenamiento con HP bajo (${playerHp}/${player.max_hp} HP).`);
  }

  // Actualizar HP del jugador (los golpes recibidos son reales en entrenamiento)
  if (playerHp !== player.hp) {
    db.updatePlayer(player.id, { hp: playerHp });
  }

  // Regenerar el maniquí inmediatamente
  db.updateMonster(monster.id, { hp: monsterMaxHp, room_id: monster.room_id || 21 });

  // Calcular DPS estimado
  const dps = stats.turns > 0 ? (stats.dmg_dealt / stats.turns).toFixed(1) : '0';

  // Mostrar estadísticas
  lines.push(`${'─'.repeat(44)}`);
  lines.push(`📊 ESTADÍSTICAS DE ENTRENAMIENTO`);
  lines.push(`  Turnos:         ${stats.turns}`);
  lines.push(`  Daño infligido: ${stats.dmg_dealt} total  (DPS: ${dps})`);
  lines.push(`  Golpes críticos:${stats.crits} (${stats.turns > 0 ? Math.round(stats.crits / stats.turns * 100) : 0}% de crits)`);
  lines.push(`  Daño recibido:  ${stats.dmg_received} total`);
  lines.push(`  Esquivas:       ${stats.dodges} / ${stats.turns} turnos`);
  lines.push(`  HP final:       ${playerHp}/${player.max_hp}`);
  lines.push(`${'─'.repeat(44)}`);
  lines.push(`🔄 El ${monsterNameArticle} se regenera para el próximo round.`);
  if (clsData) {
    lines.push(`💡 Clase activa: ${clsData.name} · Crit: ${Math.round(critChance * 100)}% · Esquiva: ${Math.round(dodgeChance * 100)}%`);
  }

  return {
    text: lines.join('\n'),
    event: `${player.username} practica combate contra el ${monsterNameArticle}.`,
    eventRoomId: TRAINING_ROOM_ID,
  };
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

  // T146: Cancelar AFK automáticamente al entrar en combate
  if (clearAfk(player.id)) {
    // El mensaje de cancelación AFK se incluirá junto con el resultado del ataque
    // (pero como no podemos devolver dos results, simplemente lo cancelamos silenciosamente)
  }

  const monster = combat.findMonsterInRoom(player.current_room_id, targetName.trim());
  if (!monster) {
    return { text: `No hay ningún "${targetName}" aquí.` };
  }

  // ── T143: Modo entrenamiento ───────────────────────────────────────────────
  // Si el jugador está en la Sala de Práctica atacando un maniquí, corre el combate
  // completo en un solo comando con estadísticas detalladas. Sin XP, kills ni loot.
  if (player.current_room_id === TRAINING_ROOM_ID && TRAINING_DUMMY_IDS.has(monster.id)) {
    return _cmdTrainingFight(player, monster);
  }

  // ── T192: Sistema de combos ────────────────────────────────────────────────
  // Calcular nivel de combo ANTES del ataque, para aplicar bonus al daño
  const prevCombo = comboMap.get(player.id);
  let comboCount = 0;
  if (prevCombo && prevCombo.monsterId === monster.id) {
    comboCount = Math.min(COMBO_MAX, prevCombo.count + 1);
  } else {
    comboCount = 1;
  }
  // Aplicar bonus de combo como modificador temporal al ataque del jugador
  const comboBonusDmg = Math.max(0, comboCount - 1); // 0 en x1, +1 en x2, +2 en x3...
  if (comboBonusDmg > 0) {
    player = { ...player, attack: (player.attack || 5) + comboBonusDmg };
  }

  const combatResult = combat.attackRound(player, monster);
  const { lines, monsterDead, playerDead, globalEvent } = combatResult;

  // ── T192: Actualizar comboMap post-ronda ────────────────────────────────────
  if (playerDead) {
    comboMap.delete(player.id); // reset al morir
  } else if (monsterDead) {
    comboMap.delete(player.id); // reset al matar
  } else {
    comboMap.set(player.id, { monsterId: monster.id, count: comboCount });
  }
  // Agregar mensaje de combo si aplica
  let comboMsg = '';
  if (!playerDead && comboCount >= 2) {
    comboMsg = '\n' + (COMBO_MSGS[comboCount] || `⚡ ¡COMBO x${comboCount}!`) + ` (+${comboBonusDmg} dmg)`;
  }

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

  // ── Metas globales (T194) — contabilizar kill ─────────────────────────────
  let worldGoalMsg = '';
  if (monsterDead) {
    const hitMilestone = db.incrementWorldGoal('kills', 1);
    if (hitMilestone) {
      worldGoalMsg = `\n🌍 ¡HITO GLOBAL! El dungeon acumula ${hitMilestone.toLocaleString()} monstruos abatidos entre todos los aventureros.`;
    }
  }

  // ── Récords del servidor (T195) ───────────────────────────────────────────
  let recordMsgs = [];
  if (monsterDead) {
    const currentCombo = comboMap.get(player.id) || 0;
    recordMsgs = checkAndSetRecords(db.getPlayer(player.id) || player, currentCombo);
  }

  // ── Runas coleccionables (T140) ──────────────────────────────────────────
  let runeMsg = '';
  if (monsterDead) {
    const rm = db.tryAddRune(player.id);
    if (rm) runeMsg = '\n' + rm;
  }

  // ── Desafío diario (T141) ────────────────────────────────────────────────
  let challengeMsg = '';
  if (monsterDead) {
    const cr = db.updateDailyChallengeProgress(player.id, 'kill', monster.name);
    if (cr && cr.reward) {
      challengeMsg = `\n🏆 ¡DESAFÍO DIARIO COMPLETADO! +30 XP · +20 🪙 · +5 Reputación`;
    } else if (cr && !cr.challenge.done) {
      challengeMsg = `\n📅 Desafío diario: ${cr.challenge.desc} (${cr.challenge.progress}/${cr.challenge.goal})`;
    }
  }

  // ── Evaluar logros tras el combate ──────────────────────────────────────
  let achLines = '';
  const freshForAch = db.getPlayer(player.id);
  if (freshForAch) {
    const bossKill = monsterDead && !!(combat.BOSS_MONSTERS && combat.BOSS_MONSTERS[monster.id]);
    const poisonSurvived = !!(combatResult && combatResult.poisonSurvived);
    const newAchs = ach.checkAchievements(freshForAch, { bossKill, poisonSurvived });
    achLines = ach.formatNewAchievements(newAchs);

    // T125: reputación por kill (+1) y por logros nuevos (+3 c/u)
    if (monsterDead) {
      const repKill = db.addReputation(player.id, 1);
      if (repKill.leveledUp) {
        achLines += `\n${repKill.level.icon} ¡Tu reputación aumenta a **${repKill.level.name}**! (${repKill.newPoints} pts)`;
      }
    }
    if (newAchs && newAchs.length > 0) {
      for (const _a of newAchs) {
        const repAch = db.addReputation(player.id, 3);
        if (repAch.leveledUp) {
          achLines += `\n${repAch.level.icon} ¡Tu reputación aumenta a **${repAch.level.name}**! (${repAch.newPoints} pts)`;
        }
      }
    }

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
      // T125: reputación por quest completada (+5)
      const repQuest = db.addReputation(player.id, 5);
      if (repQuest.leveledUp) {
        questLines += `\n${repQuest.level.icon} ¡Tu reputación aumenta a **${repQuest.level.name}**! (${repQuest.newPoints} pts)`;
      }
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

  // ── Progreso de quest de guild (T189) ────────────────────────────────────
  let guildQuestLines = '';
  if (monsterDead) {
    const freshGQ = db.getPlayer(player.id);
    if (freshGQ && freshGQ.guild) {
      const guildRow = db.getGuildFull(freshGQ.guild);
      if (guildRow) {
        const gqResult = guildQuests.recordGuildQuestContribution(
          guildRow, player.id, 'kill', { monsterName: monster.name }
        );
        if (gqResult) {
          const updatedQuest = gqResult.justCompleted && gqResult.newQuest ? gqResult.newQuest : gqResult.quest;
          // Si completó, guardar la nueva quest en BD
          if (gqResult.justCompleted && gqResult.newQuest) {
            db.setGuildQuest(freshGQ.guild, JSON.stringify(gqResult.newQuest));
            // Recompensar a todos los miembros del guild
            const members = db.getGuildMembers(freshGQ.guild);
            for (const m of members) {
              const mFresh = db.getPlayer(m.id);
              if (mFresh) {
                db.updatePlayer(m.id, {
                  xp:  (mFresh.xp  || 0) + 50,
                  gold: (mFresh.gold || 0) + 30,
                });
                db.addReputation(m.id, 10);
              }
            }
            guildQuestLines = `\n\n⚔ ¡MISIÓN DE HERMANDAD COMPLETADA! Todos los miembros de [${freshGQ.guild}] reciben +50 XP · +30 🪙 · +10 Reputación.`;
            db.logGlobalEvent('guild_quest', `⚔ La hermandad [${freshGQ.guild}] completó su misión colectiva. ¡${player.username} dio el último golpe!`);
            // Guardar el broadcast de guild para handlers.js
            Object.assign(combatResult, {
              guildBroadcast: freshGQ.guild,
              guildBroadcastMsg: `⚔ ¡MISIÓN DE HERMANDAD COMPLETADA! +50 XP · +30 🪙 · +10 Rep para todos.`,
            });
          } else {
            // Actualizar progreso en BD (sin completar aún)
            db.setGuildQuest(freshGQ.guild, JSON.stringify(gqResult.quest));
            guildQuestLines = `\n⚔ [${freshGQ.guild}] Misión: ${gqResult.quest.total}/${gqResult.quest.goal} — ¡Seguí luchando!`;
          }
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

  // ── T159: Killing Spree ──────────────────────────────────────────────────
  let streakMsg = '';
  if (monsterDead) {
    const prevStreak = killStreakMap.get(player.id) || 0;
    const newStreak = prevStreak + 1;
    killStreakMap.set(player.id, newStreak);
    // Hitos: 5, 10, 15, 20...
    if (newStreak >= 5 && newStreak % 5 === 0) {
      const bonusXp = STREAK_HITO_BONUS;
      const freshStreak = db.getPlayer(player.id);
      const newXp = (freshStreak.xp || 0) + bonusXp;
      const newLevel = Math.floor(newXp / 50) + 1;
      const levelUp = newLevel > (freshStreak.level || 1);
      const upd = { xp: newXp, level: newLevel };
      if (levelUp) {
        upd.max_hp = (freshStreak.max_hp || 30) + 5;
        upd.hp = Math.min(freshStreak.hp, upd.max_hp);
        upd.attack = (freshStreak.attack || 5) + 1;
      }
      db.updatePlayer(player.id, upd);
      const streakLabel = newStreak >= 20 ? '💥 ¡IMPARABLE!' : newStreak >= 15 ? '🔥 ¡Dominando el Dungeon!' : newStreak >= 10 ? '⚡ ¡Racha Brutal!' : '🔥 ¡Racha de Kills!';
      streakMsg = `\n${streakLabel} ${newStreak} kills seguidos. +${bonusXp} XP de bonificación.${levelUp ? ` ✨ ¡SUBÍS AL NIVEL ${newLevel}!` : ''}`;
    } else if (newStreak >= 3) {
      streakMsg = `\n🔥 Racha: ${newStreak} kills consecutivos sin morir.`;
    }
  } else if (playerDead) {
    const oldStreak = killStreakMap.get(player.id) || 0;
    if (oldStreak >= 3) {
      streakMsg = `\n💔 Se acabó tu racha de ${oldStreak} kills.`;
    }
    killStreakMap.set(player.id, 0);
  }

  return {
    text: lines.join('\n') + comboMsg + achLines + questLines + guildQuestLines + partyXpLines + runeMsg + challengeMsg + streakMsg + worldGoalMsg + (recordMsgs.length ? '\n' + recordMsgs.map(m => `🌟 ${m}`).join('\n') : ''),
    event: eventText,
    eventRoomId: player.current_room_id,
    globalEvent: globalEvent || (worldGoalMsg ? worldGoalMsg.replace(/\n/, '') : null) || (recordMsgs.length ? recordMsgs[0] : null) || null,
    sessionKill: !!monsterDead,  // T155: tracking de kills de sesión
    // T189: guild quest broadcast (si aplica)
    ...(combatResult.guildBroadcast ? {
      guildBroadcast: combatResult.guildBroadcast,
      guildBroadcastMsg: combatResult.guildBroadcastMsg,
    } : {}),
  };
}

/**
 * flee / huir — Intentar huir del combate.
 * Solo tiene sentido si hay monstruos en la sala.
 */
function cmdFlee(player, targetQuery) {
  player = db.getPlayer(player.id);
  const room = db.getRoom(player.current_room_id);
  const monsters = db.getMonstersInRoom(player.current_room_id);

  if (monsters.length === 0) {
    return { text: 'No hay nada de lo que huir aquí.' };
  }

  let monster;
  // Si se indica un monstruo específico, buscarlo
  if (targetQuery && targetQuery.trim()) {
    const query = targetQuery.trim().toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    monster = monsters.find(m => {
      const mName = m.name.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      return mName.includes(query) || query.includes(mName);
    });
    if (!monster) {
      const nameList = monsters.map(m => m.name).join(', ');
      return { text: `No hay ningún "${targetQuery}" aquí del que huir.\nMonstruos presentes: ${nameList}` };
    }
  } else {
    // Sin argumento: si hay múltiples, mostrar lista como sugerencia
    if (monsters.length > 1) {
      const nameList = monsters.map(m => m.name).join(', ');
      // Huir del primero pero informar que hay varios
      monster = monsters[0];
      const { fled, line, destRoomId } = combat.tryFlee(player, monster, room);
      const multiMsg = `⚡ Hay ${monsters.length} monstruos (${nameList}). Usá "flee <monstruo>" para huir de uno específico.\n${line}`;
      return {
        text: multiMsg,
        event: fled ? `${player.username} huye de la sala.` : `${player.username} intenta huir pero falla.`,
        eventRoomId: room.id,
      };
    }
    monster = monsters[0];
  }

  const { fled, line, destRoomId, globalEvent: fleeGlobalEvent } = combat.tryFlee(player, monster, room);

  return {
    text: line,
    event: fled ? `${player.username} huye de la sala.` : `${player.username} intenta huir pero falla.`,
    eventRoomId: room.id,
    ...(fleeGlobalEvent ? { globalEvent: fleeGlobalEvent } : {}),
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
    // Desafío diario: oro (T141)
    const goldCr = db.updateDailyChallengeProgress(player.id, 'gold', null, amount);
    let goldChallengeMsg = '';
    if (goldCr && goldCr.reward) {
      goldChallengeMsg = `\n🏆 ¡DESAFÍO DIARIO COMPLETADO! +30 XP · +20 🪙 · +5 Reputación`;
    } else if (goldCr && !goldCr.challenge.done) {
      goldChallengeMsg = `\n📅 Desafío diario: ${goldCr.challenge.desc} (${goldCr.challenge.progress}/${goldCr.challenge.goal})`;
    }
    // T189: Progreso de quest de guild (oro)
    let guildGoldMsg = '';
    const freshForGG = db.getPlayer(player.id);
    if (freshForGG && freshForGG.guild) {
      const guildRowGG = db.getGuildFull(freshForGG.guild);
      if (guildRowGG) {
        const gqGoldResult = guildQuests.recordGuildQuestContribution(
          guildRowGG, player.id, 'gold', { amount }
        );
        if (gqGoldResult) {
          if (gqGoldResult.justCompleted && gqGoldResult.newQuest) {
            db.setGuildQuest(freshForGG.guild, JSON.stringify(gqGoldResult.newQuest));
            const members = db.getGuildMembers(freshForGG.guild);
            for (const m of members) {
              const mFresh = db.getPlayer(m.id);
              if (mFresh) {
                db.updatePlayer(m.id, { xp: (mFresh.xp || 0) + 50, gold: (mFresh.gold || 0) + 30 });
                db.addReputation(m.id, 10);
              }
            }
            guildGoldMsg = `\n⚔ ¡MISIÓN DE HERMANDAD COMPLETADA! [${freshForGG.guild}] reciben +50 XP · +30 🪙 · +10 Reputación.`;
            db.logGlobalEvent('guild_quest', `⚔ La hermandad [${freshForGG.guild}] completó su misión de oro.`);
          } else {
            db.setGuildQuest(freshForGG.guild, JSON.stringify(gqGoldResult.quest));
            guildGoldMsg = `\n⚔ [${freshForGG.guild}] Misión de oro: ${gqGoldResult.quest.total}/${gqGoldResult.quest.goal}`;
          }
        }
      }
    }
    // T194: Metas globales — incrementar oro recolectado
    const goldGoalHit = db.incrementWorldGoal('gold', amount);
    let goldGoalMsg = '';
    if (goldGoalHit) {
      goldGoalMsg = `\n🌍 ¡HITO GLOBAL! El dungeon acumula ${goldGoalHit.toLocaleString()} monedas de oro recolectadas entre todos.`;
    }
    return {
      text: `💰 Recogés ${found}. +${amount} monedas de oro. Tenés ${newGold}g en total.${goldAchLines}${goldQuestLine}${goldChallengeMsg}${guildGoldMsg}${goldGoalMsg}`,
      event: `${player.username} recoge algo del suelo.`,
      eventRoomId: room.id,
    };
  }
  const newInventory = [...player.inventory, found];
  db.updatePlayer(player.id, { inventory: newInventory });

  // Mostrar rareza en el mensaje de pick (T136)
  const rarity = items.getItemRarity(found);
  const rarityEmoji = items.getRarityEmoji(found);
  const rarityLabel = rarity !== 'común' ? ` ✨ [${rarity.toUpperCase()}]` : '';

  return {
    text: `${rarityEmoji} Recogés ${found} y lo guardás en tu mochila.${rarityLabel}`,
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
    const newAttack = 5 + def.amount; // base 5 + bonus del arma
    db.updatePlayer(player.id, { attack: newAttack, equipped_weapon: found });

    resultText = `Equipás ${found}. Tu ataque sube a ${newAttack}.`;

  } else if (def.type === 'scroll') {
    // T153: Pergaminos mágicos de un solo uso
    const scrolls = JSON.parse(player.active_scrolls || '{}');
    const now = Date.now();
    const expiresAt = now + def.duration * 1000;

    // Registrar el buff activo (sobrescribe si ya hay uno del mismo tipo)
    scrolls[def.effect] = { atk_bonus: def.atk_bonus, def_bonus: def.def_bonus, expires_at: expiresAt };

    // Consumir el pergamino
    const newInvS = removeFirst(player.inventory, found);
    db.updatePlayer(player.id, { inventory: newInvS, active_scrolls: JSON.stringify(scrolls) });

    const parts = [];
    if (def.atk_bonus > 0) parts.push(`+${def.atk_bonus} ATK`);
    if (def.def_bonus > 0) parts.push(`+${def.def_bonus} DEF`);
    resultText = `📜 Leés el ${found}. ${def.description.split('(')[0].trim()} (${parts.join(', ')} por ${def.duration}s)`;

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
  // T152: Si era la armadura equipada, desequipar (volver a defensa base)
  if (player.equipped_armor && player.equipped_armor === found) {
    updates.equipped_armor = null;
    updates.defense = 2;
  }

  db.updatePlayer(player.id, updates);

  // Agregar al suelo de la habitación
  const room = db.getRoom(player.current_room_id);
  if (room) {
    db.updateRoomItems(room.id, [...room.items, found]);
  }

  let extraMsg = '';
  if (updates.equipped_weapon === null) extraMsg += ' Ya no tenés ningún arma equipada (ataque: 5).';
  if (updates.equipped_armor === null)  extraMsg += ' Ya no tenés armadura (defensa: 2).';

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
    const specialDef = combat.MONSTER_SPECIALS[monster.name];
    const specialLine = specialDef
      ? `⚡ Habilidad especial: ${specialDef.msg.replace('{amount}', specialDef.amount || '').replace('{turns}', specialDef.turns || '')} (${Math.round(specialDef.chance * 100)}% de chance)`
      : null;
    return {
      text: [
        `=== ${monster.name.toUpperCase()} ===`,
        monster.description,
        `HP: ${bar} ${monster.hp}/${monster.max_hp}`,
        `Ataque: ${monster.attack}`,
        monster.loot && monster.loot.length
          ? `Posible loot: ${monster.loot.join(', ')}`
          : 'No parece llevar nada de valor.',
        ...(specialLine ? [specialLine] : []),
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
 * lore <ítem> — Consultar la enciclopedia del dungeon sobre un ítem (T137).
 * Funciona con cualquier ítem del catálogo, no necesitás tenerlo.
 */
function cmdLore(query) {
  if (!query || !query.trim()) {
    return {
      text: [
        'Enciclopedia del Dungeon — consultá el lore de cualquier ítem.',
        'Uso: lore <nombre del ítem>',
        'Ejemplo: lore espada de obsidiana',
        '',
        'Rarezas: ⬜ común  🔵 raro  🟣 épico  🟡 legendario',
      ].join('\n'),
    };
  }

  const query_clean = query.trim().toLowerCase();

  // Buscar en el catálogo completo
  const CATALOG = items.ITEM_CATALOG;
  // Coincidencia exacta primero, luego parcial
  let itemKey = Object.keys(CATALOG).find(k => k === query_clean);
  if (!itemKey) {
    itemKey = Object.keys(CATALOG).find(k => k.includes(query_clean) || query_clean.includes(k));
  }

  if (!itemKey) {
    return { text: `No hay información sobre "${query}" en la enciclopedia del dungeon.\nProbá con el nombre completo del ítem.` };
  }

  const def = CATALOG[itemKey];
  const rarity = items.getItemRarity(itemKey);
  const rarityEmoji = items.getRarityEmoji(itemKey);
  const rarityColor = { 'común': 'gris', 'raro': 'azul', 'épico': 'morado', 'legendario': 'dorado' }[rarity] || 'gris';

  const typeNames = {
    'weapon': 'Arma',
    'potion': 'Poción de salud',
    'mana_potion': 'Poción de maná',
    'antidote': 'Antídoto',
    'misc': 'Objeto',
    'craft_only': 'Material de crafteo',
  };
  const typeName = typeNames[def.type] || def.type;

  const sep = '─'.repeat(40);
  const lines = [
    `╔${'═'.repeat(40)}╗`,
    `║  ${rarityEmoji} ${itemKey.toUpperCase().padEnd(37)}║`,
    `╚${'═'.repeat(40)}╝`,
    def.description,
    sep,
    `Tipo:   ${typeName}`,
    `Rareza: ${rarityEmoji} ${rarity.charAt(0).toUpperCase() + rarity.slice(1)} (${rarityColor})`,
  ];

  if (def.effect === 'attack_bonus' && def.amount !== undefined) {
    lines.push(`Ataque: +${def.amount}`);
  }
  if (def.effect === 'heal' && def.amount !== undefined) {
    lines.push(`Cura:   +${def.amount} HP`);
  }
  if (def.effect === 'restore_mana' && def.amount !== undefined) {
    lines.push(`Maná:   +${def.amount}`);
  }
  if (def.on_hit) {
    const oh = def.on_hit;
    if (oh.type === 'poison') {
      lines.push(`On-hit: ${Math.round(oh.chance * 100)}% de envenenar (${oh.damage} dmg × ${oh.turns} turnos)`);
    } else if (oh.type === 'shadow_bolt') {
      lines.push(`On-hit: ${Math.round(oh.chance * 100)}% rayo de sombra (+${oh.bonus_damage} daño extra)`);
    }
  }

  return { text: lines.join('\n') };
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
      const repIcon = db.getReputationLevel(p.reputation || 0).icon;
      const afkTag = afkPlayers.has(p.id) ? ' 💤' : '';
      const streak = killStreakMap.get(p.id) || 0;
      const streakTag = streak >= 5 ? ` 🔥${streak}` : '';
      const stanceIcon = STANCES[p.stance || 'equilibrado'] ? STANCES[p.stance || 'equilibrado'].icon : '';
      const displayName = p.nickname ? `${p.username} "${p.nickname}"` : p.username;
      return `  ${(displayName + guildTag).padEnd(22)} ${titleIcon}${repIcon} Lv${String(level).padStart(2,' ')} ${hpBar} ${hpText.padStart(7)}  ☠${deaths}${afkTag}${streakTag} ${stanceIcon} │  ${p.room_name || 'Desconocido'}`;
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
  if (mode === 'rep' || mode === 'reputacion' || mode === 'reputación' || mode === 'fama') {
    return cmdScoreReputation();
  }
  if (mode === 'craft' || mode === 'crafteos' || mode === 'artesanos' || mode === 'alquimia') {
    return cmdScoreCrafts();
  }
  if (mode === 'tiempo' || mode === 'time' || mode === 'playtime' || mode === 'horas') {
    return cmdScoreTime();
  }
  if (mode === 'amigos' || mode === 'friends' || mode === 'social') {  // T177
    return cmdScoreFriends(player);
  }
  if (mode === 'sesión' || mode === 'sesion' || mode === 'session' || mode === 'ahora' || mode === 'activos') {  // T198
    return cmdScoreSession(player, context);
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
    const rawName = (p.username || '???').substring(0, 12);
    const hcTag  = p.is_hardcore ? (p.fallen ? '✝' : '🔴') : '  ';
    const name   = rawName.padEnd(14, ' ');
    const level  = String(p.level || 1).padStart(3, ' ');
    const xp     = String(p.xp || 0).padStart(5, ' ');
    const kills  = String(p.kills || 0).padStart(5, ' ');
    const deaths = String(p.deaths || 0).padStart(8, ' ');
    const medal  = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '  ';
    lines.push(`║ ${medal}${rank}  ${hcTag}${name}  ${level}  ${xp}  ${kills}  ${deaths}  ║`);
  });

  lines.push(`╚═════════════════════════════════════════════════════╝`);
  lines.push(`  Subcategorías: "score oro" | "score duelos" | "score rep" | "score crafteos" | "score tiempo" | "score amigos" | "score sesión"`);

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

function cmdScoreReputation() {
  const leaders = db.getLeaderboardByReputation(10);
  if (leaders.length === 0) {
    return { text: 'Aún no hay aventureros con reputación en el dungeon.' };
  }
  const lines = [
    `╔═══════════════════════════════════════════════╗`,
    `║   🌟  RANKING DE REPUTACIÓN — TOP 10  🌟       ║`,
    `╠═══════════════════════════════════════════════╣`,
    `║  #   Aventurero         Lv    Rep  Nivel       ║`,
    `╠═══════════════════════════════════════════════╣`,
  ];
  leaders.forEach((p, idx) => {
    const rank   = String(idx + 1).padStart(2, ' ');
    const name   = (p.username || '???').substring(0, 15).padEnd(15, ' ');
    const level  = String(p.level || 1).padStart(3, ' ');
    const rep    = String(p.reputation || 0).padStart(5, ' ');
    const repInfo = db.getReputationLevel(p.reputation || 0);
    const repName = `${repInfo.icon} ${repInfo.name}`.padEnd(12, ' ');
    const medal  = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '  ';
    lines.push(`║ ${medal}${rank}  ${name}  ${level}  ${rep}  ${repName}║`);
  });
  lines.push(`╚═══════════════════════════════════════════════╝`);
  lines.push(`  Usá "score" para kills/XP, "score oro" para riqueza, "score duelos" para PvP.`);
  return { text: lines.join('\n') };
}

// T135: Ranking por crafteos
function cmdScoreCrafts() {
  const leaders = db.getLeaderboardByCrafts(10);
  if (leaders.length === 0) {
    return { text: 'Aún no hay artesanos registrados en el dungeon.' };
  }
  const lines = [
    `╔══════════════════════════════════════════╗`,
    `║  ⚗️  RANKING DE ARTESANOS — TOP 10  ⚗️   ║`,
    `╠══════════════════════════════════════════╣`,
    `║  #   Aventurero         Lv   Crafteos    ║`,
    `╠══════════════════════════════════════════╣`,
  ];
  leaders.forEach((p, idx) => {
    const rank   = String(idx + 1).padStart(2, ' ');
    const name   = (p.username || '???').substring(0, 15).padEnd(15, ' ');
    const level  = String(p.level || 1).padStart(3, ' ');
    const crafts = String(p.crafts_count || 0).padStart(8, ' ');
    const medal  = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '  ';
    lines.push(`║ ${medal}${rank}  ${name}  ${level}  ${crafts}    ║`);
  });
  lines.push(`╚══════════════════════════════════════════╝`);
  lines.push(`  Usá "score" para kills/XP, "score oro" para riqueza, "score duelos" para PvP.`);
  return { text: lines.join('\n') };
}

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

  const lista = floorItems.map(i => {
    const emoji = items.getRarityEmoji(i);
    const rarity = items.getItemRarity(i);
    const rarityTag = rarity !== 'común' ? ` [${rarity}]` : '';
    return `  ${emoji} ${i}${rarityTag}`;
  }).join('\n');

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
 * wear <armadura> — Equipar una armadura del inventario (T152).
 */
function cmdWear(player, itemQuery) {
  if (!itemQuery || !itemQuery.trim()) {
    return { text: 'Indicá qué armadura querés ponerte. Ej: "wear cota de malla".' };
  }

  player = db.getPlayer(player.id);

  const found = items.findItem(player.inventory, itemQuery.trim());
  if (!found) {
    return { text: `No tenés ninguna "${itemQuery}" en el inventario.` };
  }

  const def = items.getItemDef(found);
  if (!def || def.type !== 'armor') {
    return { text: `${found} no es una armadura que puedas ponerte. Para armas usá "equip".` };
  }

  const oldDefense = player.defense || 2;
  const newDefense = 2 + def.amount; // base 2 + bonus de la armadura
  const oldArmor = player.equipped_armor;
  db.updatePlayer(player.id, { defense: newDefense, equipped_armor: found });

  const change = newDefense - oldDefense;
  const changeStr = change >= 0 ? `+${change}` : `${change}`;
  const swapMsg = oldArmor ? ` (reemplaza ${oldArmor})` : '';

  return {
    text: `Te ponés ${found}${swapMsg}. Defensa: ${oldDefense} → ${newDefense} (${changeStr}).\n${def.description}`,
    event: `${player.username} se pone ${found}.`,
    eventRoomId: player.current_room_id,
  };
}

/**
 * unwear — Quitarse la armadura actual y volver a defensa base (T152).
 */
function cmdUnwear(player) {
  player = db.getPlayer(player.id);

  if (!player.equipped_armor) {
    return { text: 'No tenés ninguna armadura puesta.' };
  }

  const armorName = player.equipped_armor;
  db.updatePlayer(player.id, { defense: 2, equipped_armor: null });

  return {
    text: `Te quitás ${armorName}. Volvés a la defensa base (defensa: 2).`,
    event: `${player.username} se quita ${armorName}.`,
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
  // T152: Si era la armadura equipada, desequipar
  if (player.equipped_armor && player.equipped_armor === found) {
    giverUpdates.equipped_armor = null;
    giverUpdates.defense = 2;
  }

  db.updatePlayer(player.id,  giverUpdates);
  db.updatePlayer(target.id,  { inventory: newTargetInv });

  let extraMsg = '';
  if (giverUpdates.equipped_weapon === null) extraMsg += ' (perdiste tu arma equipada, ataque vuelve a 5)';
  if (giverUpdates.equipped_armor === null)  extraMsg += ' (perdiste tu armadura, defensa vuelve a 2)';

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
 * inbox — Bandeja de entrada: últimos 5 mensajes de whisper/tell recibidos.
 * Incluye mensajes offline entregados y pendientes.
 */
function cmdInbox(player, args) {
  const limit = args && args[0] && !isNaN(args[0]) ? Math.min(parseInt(args[0]), 20) : 5;
  const messages = db.getRecentMessages(player.id, limit);

  if (!messages || messages.length === 0) {
    return { text: '📭 Bandeja vacía. No tenés mensajes recibidos.' };
  }

  const lines = ['📬 **Bandeja de entrada** (últimos mensajes recibidos):'];
  lines.push('┌' + '─'.repeat(50) + '┐');

  for (const msg of messages) {
    const ts = new Date(msg.created_at || Date.now());
    const time = ts.toISOString().replace('T', ' ').slice(0, 16);
    const status = msg.delivered ? '✓' : '🆕';
    lines.push(`│ ${status} [${time}] De: ${msg.sender_username}`);
    // Truncar mensaje si es muy largo
    const text = msg.message.length > 45 ? msg.message.slice(0, 42) + '...' : msg.message;
    lines.push(`│   \"${text}\"`);
  }

  lines.push('└' + '─'.repeat(50) + '┘');
  lines.push(`  Mostrando ${messages.length} de los últimos mensajes.`);

  return { text: lines.join('\n') };
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
    22: 'Cripta',
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
    'MAPA DEL DUNGEON (16 salas + zonas especiales)',
    timeDecor,
    '',
    // Fila top: Prisión (arriba de 4) y Forja/Coliseo/Catedral (zona nueva)
    `         ${c(8)}                   ${c(12)}───${c(14)}───${c(15)}`,
    `              │                        │         │       │↓`,
    // Fila principal izquierda + santuario/conexión + zonas nuevas
    `${c(7)}───${c(3)}───${c(4)}   ${c(10)}───${c(9)}───${c(6)}───${c(2)}   ${c(13)}  ${c(22)}`,
    `  │              │                    │         │`,
    `${c(11)}          ${c(5)}───${c(1)}               │`,
    `                                       └───zona expandida`,
    '',
    `★ = tu ubicación actual (sala ${here}: ${NAMES[here] || '?'})`,
    `(Cripta: sala 15 → bajar)`,
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
// T183: Map para party rest (roomId → Map<playerId, timestamp>)
const partyRestMap = new Map();

function cmdRest(player, context) {
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

  // T183: Registrar descanso del jugador en el Map de party rest
  const roomId = player.current_room_id;
  if (!partyRestMap.has(roomId)) partyRestMap.set(roomId, new Map());
  partyRestMap.get(roomId).set(player.id, Date.now());

  // Recuperar HP (3 a 5 HP)
  const baseHeal = Math.floor(Math.random() * 3) + 3; // 3, 4 o 5
  // T166: Viento helado penaliza el descanso (-1 HP, mín 1)
  const weatherPenalty = weather.getRestPenalty();
  let heal = Math.max(1, baseHeal - weatherPenalty);

  // T183: Verificar party rest
  let partyBonusText = '';
  const partyMembers = player.party_id ? db.getPartyMembers(player.party_id) : [];
  if (partyMembers && partyMembers.length > 0) {
    const PARTY_REST_WINDOW = 15_000; // 15 segundos
    const now = Date.now();
    const roomRests = partyRestMap.get(roomId) || new Map();

    // Obtener miembros del party en la misma sala
    const partyInRoom = partyMembers.filter(m =>
      m.current_room_id === roomId && m.id !== player.id
    );

    if (partyInRoom.length > 0) {
      const allRested = partyInRoom.every(m => {
        const t = roomRests.get(m.id);
        return t && (now - t) < PARTY_REST_WINDOW;
      });

      if (allRested) {
        // ¡Descanso grupal! Bonus +50% HP (mínimo +1 extra)
        const bonus = Math.max(1, Math.floor(heal * 0.5));
        heal += bonus;
        partyBonusText = `\n  🤝 ¡Descanso grupal! +${bonus} HP extra (tu party descansó junto)`;

        // Broadcast a la sala
        if (context && context.broadcastToRoom) {
          const memberNames = partyInRoom.map(m => m.username).join(', ');
          context.broadcastToRoom(
            roomId, player.id,
            `🤝 ${player.nickname || player.username} y su party (${memberNames}) descansan juntos y recuperan fuerzas.`
          );
        }

        // Limpiar el Map de la sala para no repetir el bonus
        partyRestMap.set(roomId, new Map());
      }
    }
  }

  const newHp = Math.min(player.max_hp, player.hp + heal);
  const restored = newHp - player.hp;

  db.updatePlayer(player.id, {
    hp: newHp,
    last_rest: new Date().toISOString(),
  });

  const hpBar = buildBar(newHp, player.max_hp, 20);
  const coldSuffix = weatherPenalty > 0 ? ` ❄️ (El viento helado reduce la recuperación)` : '';

  // T186: Recolección pasiva al descansar en ciertas salas
  let forageRestText = '';
  const forageRoomData = FORAGE_REST_ROOMS[player.current_room_id];
  if (forageRoomData && Math.random() < forageRoomData.chance) {
    const refreshedPlayer = db.getPlayer(player.id);
    const updatedInv = [...(refreshedPlayer.inventory || []), forageRoomData.item];
    db.updatePlayer(player.id, { inventory: updatedInv });
    forageRestText = `\n${forageRoomData.msg}`;
  }

  return {
    text: `💤 Te recostás contra la pared y descansás un momento.\nRecuperás ${restored} HP.${coldSuffix}${partyBonusText} ${hpBar} ${newHp}/${player.max_hp} HP${forageRestText}`,
  };
}

/**
 * T131: recall / volver — Teletransportarse a la sala de inicio (sala 1).
 * Cooldown: 10 minutos. Cuesta 5 HP.
 */
function cmdRecall(player) {
  player = db.getPlayer(player.id);

  const START_ROOM = 1;
  const COOLDOWN_MS = 10 * 60 * 1000; // 10 minutos
  const HP_COST = 5;

  // Ya estás en la sala de inicio
  if (player.current_room_id === START_ROOM) {
    return { text: '🏠 Ya estás en la entrada del dungeon. No hay a dónde volver.' };
  }

  // Verificar cooldown
  if (player.last_recall) {
    const elapsed = Date.now() - new Date(player.last_recall).getTime();
    if (elapsed < COOLDOWN_MS) {
      const remaining = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
      const mins = Math.floor(remaining / 60);
      const secs = remaining % 60;
      const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
      return { text: `🔮 El hechizo de retorno aún se está recargando. Espera ${timeStr}.` };
    }
  }

  // Verificar HP suficiente
  if (player.hp <= HP_COST) {
    return { text: `🔮 No tenés suficiente energía para el retorno. Necesitás más de ${HP_COST} HP.` };
  }

  // Realizar el teletransporte
  const newHp = player.hp - HP_COST;
  const room = db.getRoom(START_ROOM);
  const roomName = room ? room.name : 'Entrada del Dungeon';

  db.updatePlayer(player.id, {
    current_room_id: START_ROOM,
    hp: newHp,
    last_recall: new Date().toISOString(),
  });

  return {
    text: `🔮 Invocás el antiguo hechizo de retorno...\nUn destello de luz te envuelve. Aparecés en ${roomName}.\n⚡ Costo: ${HP_COST} HP. HP actual: ${newHp}/${player.max_hp}.`,
    event: `${player.username} desaparece en un destello de luz.`,
    eventRoomId: player.current_room_id,
  };
}

/**
 * T154: cmdBack — Volver a la sala anterior.
 * Usa previousRoomId del contexto (seteado en handlers.js al detectar movimiento).
 */
function cmdBack(player, context) {
  player = db.getPlayer(player.id);
  const prevRoomId = context && context.previousRoomId;

  if (!prevRoomId) {
    return { text: '🔙 No hay sala anterior registrada. Mové a alguna habitación primero.' };
  }

  const targetRoom = db.getRoom(prevRoomId);
  if (!targetRoom) {
    return { text: '🔙 La sala anterior ya no existe (¿el dungeon cambió?).' };
  }

  // Verificar que la sala anterior sea adyacente a la actual
  const currentRoom = db.getRoom(player.current_room_id);
  const exits = currentRoom ? (typeof currentRoom.exits === 'string' ? JSON.parse(currentRoom.exits) : currentRoom.exits) : {};
  const isAdjacent = Object.values(exits).some(exit => {
    const targetId = typeof exit === 'object' ? exit.room_id : exit;
    return targetId === prevRoomId;
  });

  if (!isAdjacent) {
    return { text: `🔙 La sala anterior (${targetRoom.name}) no es adyacente a tu posición actual. No podés retroceder directamente.` };
  }

  const fromRoomId = player.current_room_id;
  db.updatePlayer(player.id, { current_room_id: prevRoomId });

  const lookResult = cmdLook(db.getPlayer(player.id));
  return {
    text: `🔙 Retrocedés hacia ${targetRoom.name}.\n\n${lookResult.text}`,
    event: `${player.username} da marcha atrás.`,
    eventRoomId: fromRoomId,
    fromRoomId,
    fromRoomEvent: `${player.username} vuelve sobre sus pasos.`,
  };
}

/**
 * T129: cmdTrade — Sistema de intercambio seguro de ítems entre dos jugadores.
 *
 * Flujo:
 *  - trade <jugador> <ítem>  → propone el intercambio (el otro debe tener algo para dar)
 *  - trade accept            → el destinatario acepta (debe también ofrecer un ítem)
 *  - trade cancel / decline  → cancelar propuesta recibida o propia
 *
 * Implementación simplificada: el iniciador propone su ítem; el destinatario,
 * al aceptar, elige el primer ítem de su inventario que no sea el que ya tiene
 * equipado — o puede rechazar. Esto cubre el caso principal sin requerir una
 * UI compleja de 2 pasos con sesiones paralelas.
 *
 * Para un trade bidireccional total, el flujo es:
 *  A: trade B espada  → pendingTrades[B] = { A ofrece espada }
 *  B: trade accept pocion  → acepta y ofrece pocion; intercambian
 */
function cmdTrade(player, args) {
  if (!args || args.length === 0) {
    return { text: '⚖️ Uso:\n  trade <jugador> <ítem>  — proponer intercambio\n  trade accept <ítem>    — aceptar (ofreciendo un ítem de tu inventario)\n  trade cancel/decline   — cancelar el intercambio' };
  }

  const subCmd = args[0].toLowerCase();

  // ── trade cancel / decline ──────────────────────────────────────────────────
  if (subCmd === 'cancel' || subCmd === 'decline' || subCmd === 'cancelar' || subCmd === 'rechazar') {
    // Cancelar propuesta recibida
    if (pendingTrades.has(player.id)) {
      const t = pendingTrades.get(player.id);
      pendingTrades.delete(player.id);
      return {
        text: '⚖️ Rechazaste la propuesta de intercambio.',
        targetPlayerId: t.initiatorId,
        targetPlayerMsg: `⚖️ ${player.username} rechazó tu propuesta de intercambio de "${t.item}".`,
        targetEventType: 'trade_declined',
      };
    }
    // Cancelar propuesta enviada (buscar si el jugador es initiator de algún trade)
    for (const [targetId, trade] of pendingTrades.entries()) {
      if (trade.initiatorId === player.id) {
        pendingTrades.delete(targetId);
        return { text: `⚖️ Cancelaste la propuesta de intercambio de "${trade.item}".` };
      }
    }
    return { text: '⚖️ No tenés ninguna propuesta de intercambio activa.' };
  }

  // ── trade accept ────────────────────────────────────────────────────────────
  if (subCmd === 'accept' || subCmd === 'aceptar') {
    const trade = pendingTrades.get(player.id);
    if (!trade) {
      return { text: '⚖️ No tenés ninguna propuesta de intercambio pendiente. Recibís una cuando alguien te escribe "trade <tu nombre> <ítem>".' };
    }
    if (Date.now() > trade.expiresAt) {
      pendingTrades.delete(player.id);
      return { text: '⚖️ La propuesta de intercambio expiró (más de 30 segundos).' };
    }

    // El jugador aceptante debe indicar qué ítem ofrece a cambio
    if (args.length < 2) {
      return { text: '⚖️ Tenés que indicar qué ítem ofrecés a cambio.\nUso: trade accept <ítem que ofrecés>' };
    }
    const offeredItemName = args.slice(1).join(' ').toLowerCase().trim();

    // Verificar que el iniciador todavía está en la sala y tiene el ítem ofrecido
    const initiator = db.getPlayer(trade.initiatorId);
    if (!initiator) {
      pendingTrades.delete(player.id);
      return { text: '⚖️ El jugador que propuso el intercambio ya no existe.' };
    }
    if (initiator.current_room_id !== player.current_room_id) {
      pendingTrades.delete(player.id);
      return { text: `⚖️ ${initiator.username} ya no está en esta sala. Intercambio cancelado.` };
    }

    // Verificar que el iniciador todavía tiene su ítem
    const freshInitiator = db.getPlayer(trade.initiatorId);
    const initiatorInv = Array.isArray(freshInitiator.inventory) ? freshInitiator.inventory : JSON.parse(freshInitiator.inventory || '[]');
    const initiatorItemIdx = initiatorInv.findIndex(i => i.toLowerCase() === trade.item.toLowerCase());
    if (initiatorItemIdx < 0) {
      pendingTrades.delete(player.id);
      return {
        text: `⚖️ ${initiator.username} ya no tiene "${trade.item}" en su inventario. Intercambio cancelado.`,
      };
    }

    // Verificar que el aceptante tiene el ítem que ofrece
    const freshPlayer = db.getPlayer(player.id);
    const playerInv = Array.isArray(freshPlayer.inventory) ? freshPlayer.inventory : JSON.parse(freshPlayer.inventory || '[]');
    const playerItemIdx = playerInv.findIndex(i => i.toLowerCase().includes(offeredItemName));
    if (playerItemIdx < 0) {
      return { text: `⚖️ No tenés "${offeredItemName}" en tu inventario.` };
    }
    const playerItemActual = playerInv[playerItemIdx];

    // ── Ejecutar el intercambio ──────────────────────────────────────────────
    pendingTrades.delete(player.id);

    // Quitar ítem del iniciador, darle el del aceptante
    const newInitiatorInv = [...initiatorInv];
    newInitiatorInv.splice(initiatorItemIdx, 1);
    newInitiatorInv.push(playerItemActual);

    // Quitar ítem del aceptante, darle el del iniciador
    const newPlayerInv = [...playerInv];
    newPlayerInv.splice(playerItemIdx, 1);
    newPlayerInv.push(trade.item);

    // Actualizar BD
    const initiatorUpdates = { inventory: newInitiatorInv };
    if (freshInitiator.equipped_weapon === trade.item) {
      initiatorUpdates.equipped_weapon = null;
      initiatorUpdates.attack = 5;
    }
    db.updatePlayer(freshInitiator.id, initiatorUpdates);

    const playerUpdates = { inventory: newPlayerInv };
    if (freshPlayer.equipped_weapon === playerItemActual) {
      playerUpdates.equipped_weapon = null;
      playerUpdates.attack = 5;
    }
    db.updatePlayer(freshPlayer.id, playerUpdates);

    return {
      text: `⚖️ ¡Intercambio completado! Diste "${playerItemActual}" y recibiste "${trade.item}".`,
      event: `⚖️ ${player.username} e ${initiator.username} realizaron un intercambio.`,
      eventRoomId: player.current_room_id,
      targetPlayerId: initiator.id,
      targetPlayerMsg: `⚖️ ¡Intercambio completado! Diste "${trade.item}" y recibiste "${playerItemActual}".`,
      targetEventType: 'trade_accepted',
    };
  }

  // ── trade <jugador> <ítem> — Proponer intercambio ──────────────────────────
  if (args.length < 2) {
    return { text: '⚖️ Uso: trade <jugador> <ítem>  — Ej: "trade Ana espada oxidada"' };
  }

  // Parsear: primer arg es el jugador, resto es el ítem
  const targetUsername = args[0];
  const itemName = args.slice(1).join(' ').toLowerCase().trim();

  const target = db.getPlayerByUsername(targetUsername.trim());
  if (!target) {
    return { text: `⚖️ No existe el jugador "${targetUsername}".` };
  }
  if (target.id === player.id) {
    return { text: '⚖️ No podés intercambiar ítems contigo mismo.' };
  }
  if (target.current_room_id !== player.current_room_id) {
    return { text: `⚖️ ${target.username} no está en esta sala.` };
  }

  // Verificar que el proponente tiene el ítem
  const freshPlayer = db.getPlayer(player.id);
  const playerInv = Array.isArray(freshPlayer.inventory) ? freshPlayer.inventory : JSON.parse(freshPlayer.inventory || '[]');
  const itemIdx = playerInv.findIndex(i => i.toLowerCase().includes(itemName));
  if (itemIdx < 0) {
    return { text: `⚖️ No tenés "${itemName}" en tu inventario.` };
  }
  const actualItem = playerInv[itemIdx];

  // Verificar que no haya ya un trade pendiente para este target
  if (pendingTrades.has(target.id)) {
    const existing = pendingTrades.get(target.id);
    if (existing.initiatorId === player.id) {
      return { text: `⚖️ Ya tenés una propuesta de intercambio pendiente con ${target.username} ("${existing.item}"). Esperá que acepte o cancelá con "trade cancel".` };
    }
    return { text: `⚖️ ${target.username} ya tiene una propuesta de intercambio pendiente. Esperá a que la resuelva.` };
  }

  // Registrar el trade pendiente
  pendingTrades.set(target.id, {
    initiatorId: player.id,
    initiatorUsername: player.username,
    item: actualItem,
    roomId: player.current_room_id,
    expiresAt: Date.now() + 30_000,
  });

  return {
    text: `⚖️ Propuesta de intercambio enviada a ${target.username}: ofrecés "${actualItem}".\n  ${target.username} debe responder con "trade accept <ítem que te ofrece>" en los próximos 30 segundos.`,
    targetPlayerId: target.id,
    targetPlayerMsg: `⚖️ ${player.username} te propone un intercambio: te da "${actualItem}".\n  Respondé con "trade accept <ítem de tu inventario que ofrecés>" o "trade decline" para rechazar (30s).`,
    targetEventType: 'trade_offer',
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
  // T152: Armaduras
  { name: 'cuero endurecido',        price: 30, description: 'Armadura ligera. +2 defensa.' },
  { name: 'cota de malla',           price: 60, description: 'Armadura de hierro. +3 defensa.' },
  { name: 'túnica encantada',        price: 80, description: 'Armadura mágica. +4 defensa. Ideal para magos.' },
];

// Precios de venta al mercader (jugador → mercader) — 40% del valor
const SELL_PRICE_RATIO = 0.4;

// T127: Descuentos por reputación en la tienda
function getRepDiscount(reputation) {
  if (reputation >= 100) return 0.15; // Legendario -15%
  if (reputation >= 50)  return 0.10; // Famoso -10%
  if (reputation >= 25)  return 0.05; // Respetado -5%
  return 0;
}

function getDiscountedPrice(basePrice, reputation) {
  const discount = getRepDiscount(reputation);
  return Math.max(1, Math.floor(basePrice * (1 - discount)));
}

function cmdShop(player) {
  player = db.getPlayer(player.id);

  if (player.current_room_id !== MERCHANT_ROOM_ID) {
    return { text: '🏪 No hay ningún mercader aquí. El mercader vive en la Cámara del Tesoro (sala 4).' };
  }

  const gold = player.gold || 0;
  const reputation = player.reputation || 0;
  const discount = getRepDiscount(reputation);
  const repInfo = db.getReputationLevel(reputation);

  const lines = [
    '\n🏪 === TIENDA DE ALDRIC EL MERCADER ===',
    `"Bienvenido, aventurero. Tenés ${gold}g. ¿Qué necesitás?"`,
    '',
  ];

  if (discount > 0) {
    lines.push(`${repInfo.icon} Tu reputación (${repInfo.name}) te da un descuento de ${Math.round(discount * 100)}%.`);
    lines.push('');
    lines.push('ARTÍCULO                    PRECIO   ORIGINAL   DESCRIPCIÓN');
  } else {
    lines.push('ARTÍCULO                    PRECIO   DESCRIPCIÓN');
  }
  lines.push('─'.repeat(60));

  SHOP_CATALOG.forEach((item, i) => {
    const num = String(i + 1).padStart(2, ' ');
    const namePad = item.name.padEnd(26, ' ');
    const finalPrice = getDiscountedPrice(item.price, reputation);
    if (discount > 0) {
      const pricePad = `${finalPrice}g`.padEnd(9, ' ');
      const origPad  = `(${item.price}g)`.padEnd(11, ' ');
      lines.push(`${num}. ${namePad}${pricePad}${origPad}${item.description}`);
    } else {
      const pricePad = `${finalPrice}g`.padEnd(9, ' ');
      lines.push(`${num}. ${namePad}${pricePad}${item.description}`);
    }
  });

  lines.push('─'.repeat(60));
  if (discount === 0) {
    lines.push('💡 Subí tu reputación (kills/quests/logros) para obtener descuentos.');
  }
  lines.push('Comandos: "buy <ítem>" para comprar, "sell <ítem>" para vender.');
  lines.push(`Podés vender tus ítems al ${Math.round(SELL_PRICE_RATIO * 100)}% de su valor original.`);

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
  const reputation = player.reputation || 0;
  const finalPrice = getDiscountedPrice(item.price, reputation);
  const discount = getRepDiscount(reputation);

  if (gold < finalPrice) {
    return { text: `💰 No tenés suficiente oro. Necesitás ${finalPrice}g, tenés ${gold}g.` };
  }

  // Realizar la compra con precio con descuento
  const newGold = gold - finalPrice;
  const newInventory = [...player.inventory, item.name];
  db.updatePlayer(player.id, { gold: newGold, inventory: newInventory });

  // T115: Trackear oro gastado para logro secreto Mecenas
  db.addGoldSpent(player.id, finalPrice);

  // Evaluar logros de compra
  const freshBuyer = db.getPlayer(player.id);
  const buyAchs = ach.checkAchievements(freshBuyer, { boughtSomething: true });
  const buyAchLines = ach.formatNewAchievements(buyAchs);

  const discountMsg = discount > 0 ? ` (descuento ${Math.round(discount * 100)}% por reputación)` : '';
  return {
    text: `🏪 Aldric sonríe. "Excelente elección."\n✅ Compraste: ${item.name} por ${finalPrice}g${discountMsg}.\n💰 Oro restante: ${newGold}g.${buyAchLines}`,
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
    // T201: Mostrar epitafio si el jugador está caído (modo hardcore fallen)
    target.fallen ? `✝ Caído en Hardcore — Epitafio: "${target.epitaph || autoEpitaph(target)}"` : null,
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
    return { text: 'Usá: guild create <nombre> | guild join <nombre> | guild leave | guild info | guild list | guild quest' };
  }

  // Refrescar desde BD
  player = db.getPlayer(player.id);
  const sub = args[0].toLowerCase();
  const guildArg = args.slice(1).join(' ').trim();

  // ── guild quest (T189) ───────────────────────────────────────────────────────
  if (sub === 'quest' || sub === 'misión' || sub === 'mision') {
    return _cmdGuildQuest(player);
  }

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

  return { text: `Subcomando desconocido: "${sub}". Usá guild create | join | leave | info | list | quest` };
}

/**
 * guild quest — Ver la misión colectiva activa del guild (T189).
 */
function _cmdGuildQuest(player) {
  if (!player.guild) {
    return { text: 'No pertenecés a ninguna hermandad. Usá "guild join <nombre>" primero.' };
  }
  const guildRow = db.getGuildFull(player.guild);
  if (!guildRow) {
    return { text: 'Tu hermandad ya no existe. Salí con "guild leave".' };
  }
  const text = guildQuests.formatGuildQuest(guildRow, player.id);
  return { text };
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

    // T144: Cobrar bounties activas sobre el perdedor
    const bountyClaimed = db.claimBounty(loser.id, winner.id, winner.username);
    if (bountyClaimed > 0) {
      resultMsg += `\n💰 ¡${winner.username} cobra ${bountyClaimed}g en recompensas pendientes sobre ${loser.username}!`;
    }

    // Registrar en crónica global (T093)
    db.logGlobalEvent('duel', `⚔️ ${winner.username} venció a ${loser.username} en duelo y ganó ${goldTransfer}g.`);

    // T194: Metas globales — incrementar duelos
    const duelGoalHit = db.incrementWorldGoal('duels', 1);
    if (duelGoalHit) {
      resultMsg += `\n🌍 ¡HITO GLOBAL! El servidor registra ${duelGoalHit.toLocaleString()} duelos en total.`;
    }
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

// ─── T144: Bounties ────────────────────────────────────────────────────────────

/**
 * bounty <jugador> <cantidad> — Poner una recompensa sobre un jugador.
 * La recompensa se activa con victorias en duelos. Expira en 30 minutos.
 */
function cmdBounty(player, args) {
  const parts = args.trim().split(/\s+/);
  if (parts.length < 2) {
    return { text: 'Uso: bounty <jugador> <cantidad>\nEj: bounty Ana 50\nMínimo: 10 monedas de oro.' };
  }

  const amountStr = parts[parts.length - 1];
  const targetName = parts.slice(0, parts.length - 1).join(' ');
  const amount = parseInt(amountStr, 10);

  if (isNaN(amount) || amount < 10) {
    return { text: '⚠️ El monto mínimo de una recompensa es 10 monedas de oro.' };
  }

  const freshPlayer = db.getPlayer(player.id);
  if ((freshPlayer.gold || 0) < amount) {
    return { text: `No tenés suficiente oro. Tenés ${freshPlayer.gold || 0}g, necesitás ${amount}g.` };
  }

  // No se puede poner bounty sobre uno mismo
  if (targetName.toLowerCase() === freshPlayer.username.toLowerCase()) {
    return { text: '⚠️ No podés poner una recompensa sobre vos mismo.' };
  }

  const target = db.getPlayerByUsername(targetName);
  if (!target) {
    return { text: `No existe ningún aventurero con el nombre \"${targetName}\".` };
  }

  // Agregar bounty (descuenta el oro)
  db.addBounty(freshPlayer.id, freshPlayer.username, target.id, target.username, amount);

  return {
    text: `💰 ¡Recompensa de ${amount}g publicada sobre ${target.username}! Expira en 30 minutos.\n   Quien gane un duelo contra ${target.username} cobrará automáticamente.`,
    event: `💰 ¡${freshPlayer.username} ofrece ${amount}g de recompensa por la cabeza de ${target.username}!`,
  };
}

/**
 * bounties — Listar todas las recompensas activas en el dungeon.
 */
function cmdBounties(player) {
  const all = db.getAllActiveBounties();
  if (all.length === 0) {
    return { text: '🔍 No hay recompensas activas en el dungeon.' };
  }

  const lines = [];
  lines.push('╔══════════════════════════════════════════╗');
  lines.push('║       💰 TABLERO DE RECOMPENSAS          ║');
  lines.push('╠══════════════════════════════════════════╣');

  for (const b of all) {
    const expiresIn = Math.max(0, Math.round((new Date(b.expires_at) - Date.now()) / 60000));
    const row = `║  ${b.target_name.padEnd(12)} ${String(b.amount + 'g').padStart(5)} — por ${b.poster_name.padEnd(10)} (${expiresIn}min)`;
    lines.push(row.substring(0, 44).padEnd(44) + ' ║');
  }

  lines.push('╚══════════════════════════════════════════╝');
  lines.push(`  Total: ${all.length} recompensa(s) activa(s).`);
  lines.push(`  Las recompensas se cobran al ganar un duelo contra el objetivo.`);

  return { text: lines.join('\n') };
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

  // T194: Metas globales — incrementar crafteos
  const craftGoalHit = db.incrementWorldGoal('crafts', 1);
  let craftGoalMsg = '';
  if (craftGoalHit) {
    craftGoalMsg = `\n🌍 ¡HITO GLOBAL! El servidor alcanza ${craftGoalHit.toLocaleString()} ítems crafteados entre todos los aventureros.`;
  }

  // T141: Desafío diario de crafteo
  const craftCr = db.updateDailyChallengeProgress(player.id, 'craft', null);
  let craftChallengeMsg = '';
  if (craftCr && craftCr.reward) {
    craftChallengeMsg = `\n🏆 ¡DESAFÍO DIARIO COMPLETADO! +30 XP · +20 🪙 · +5 Reputación`;
  } else if (craftCr && !craftCr.challenge.done) {
    craftChallengeMsg = `\n📅 Desafío diario: ${craftCr.challenge.desc} (${craftCr.challenge.progress}/${craftCr.challenge.goal})`;
  }

  const freshCrafter = db.getPlayer(player.id);

  // T189: Progreso de quest de guild (crafteo)
  let guildCraftMsg = '';
  if (freshCrafter && freshCrafter.guild) {
    const guildRowCraft = db.getGuildFull(freshCrafter.guild);
    if (guildRowCraft) {
      const gqCraftResult = guildQuests.recordGuildQuestContribution(
        guildRowCraft, player.id, 'craft', {}
      );
      if (gqCraftResult) {
        if (gqCraftResult.justCompleted && gqCraftResult.newQuest) {
          db.setGuildQuest(freshCrafter.guild, JSON.stringify(gqCraftResult.newQuest));
          const members = db.getGuildMembers(freshCrafter.guild);
          for (const m of members) {
            const mFresh = db.getPlayer(m.id);
            if (mFresh) {
              db.updatePlayer(m.id, { xp: (mFresh.xp || 0) + 50, gold: (mFresh.gold || 0) + 30 });
              db.addReputation(m.id, 10);
            }
          }
          guildCraftMsg = `\n⚔ ¡MISIÓN DE HERMANDAD COMPLETADA! Todos los miembros de [${freshCrafter.guild}] reciben +50 XP · +30 🪙 · +10 Reputación.`;
          db.logGlobalEvent('guild_quest', `⚔ La hermandad [${freshCrafter.guild}] completó su misión de crafteo.`);
        } else {
          db.setGuildQuest(freshCrafter.guild, JSON.stringify(gqCraftResult.quest));
          guildCraftMsg = `\n⚔ [${freshCrafter.guild}] Misión: ${gqCraftResult.quest.total}/${gqCraftResult.quest.goal}`;
        }
      }
    }
  }

  if (freshCrafter) {
    const craftAchs = ach.checkAchievements(freshCrafter, {});
    const craftAchLines = ach.formatNewAchievements(craftAchs);
    if (craftAchLines) {
      return { text: craftResult.text + craftAchLines + craftChallengeMsg + guildCraftMsg + craftGoalMsg };
    }
  }

  return { text: craftResult.text + craftChallengeMsg + guildCraftMsg + craftGoalMsg };
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
  // T153: Pergaminos mágicos (raros)
  { item: 'pergamino de furia',     prob: 0.02, type: 'item' },
  { item: 'pergamino de escudo',    prob: 0.02, type: 'item' },
  { item: 'pergamino de velocidad', prob: 0.01, type: 'item' },
  // Nada (probabilidad de fracaso)
  // El resto de probabilidad (~0.04) = no encontrás nada
];

const FORAGE_COOLDOWN_MS = 3 * 60 * 1000; // 3 minutos por sala
const SURVEY_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutos por sala (T205)

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
  // T205: Si la sala fue sondeada recientemente, +20% bonus (reduce la prob de "nada")
  const surveyKey = `survey_${player.current_room_id}`;
  const surveyTs = forageData[surveyKey] ? Number(forageData[surveyKey]) : 0;
  const surveyed = (Date.now() - surveyTs) < SURVEY_COOLDOWN_MS;
  let roll = Math.random();
  // Si está sondeada y el roll cae en zona baja (probable "nada"), subir 20%
  if (surveyed) roll = Math.min(roll + 0.20, 0.99);
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
    // T141: desafío diario de forage
    const fgCr = db.updateDailyChallengeProgress(player.id, 'forage', null);
    let fgChalMsg = '';
    if (fgCr && fgCr.reward) fgChalMsg = `\n🏆 ¡DESAFÍO DIARIO COMPLETADO! +30 XP · +20 🪙 · +5 Reputación`;
    else if (fgCr && !fgCr.challenge.done) fgChalMsg = `\n📅 Desafío diario: ${fgCr.challenge.desc} (${fgCr.challenge.progress}/${fgCr.challenge.goal})`;
    return { text: `${introLine}\n💰 ¡Encontrás ${found.label}! (Oro total: ${currentGold + found.gold}g)${fgChalMsg}` };
  }

  // Ítem
  const inv = [...player.inventory, found.item];
  db.updatePlayer(player.id, { inventory: JSON.stringify(inv) });

  // T141: desafío diario de forage
  const forageCr = db.updateDailyChallengeProgress(player.id, 'forage', null);
  let forageChalMsg = '';
  if (forageCr && forageCr.reward) forageChalMsg = `\n🏆 ¡DESAFÍO DIARIO COMPLETADO! +30 XP · +20 🪙 · +5 Reputación`;
  else if (forageCr && !forageCr.challenge.done) forageChalMsg = `\n📅 Desafío diario: ${forageCr.challenge.desc} (${forageCr.challenge.progress}/${forageCr.challenge.goal})`;

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
    text: `${introLine}\n🌿 ¡Encontrás: ${found.item}! Se agrega a tu inventario.${questLine}${forageChalMsg}`,
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
 * survey / sondear — Sondear la sala en busca de recursos ocultos.
 * T205: Da información sobre dónde buscar con forage, y marca la sala como "sondeada"
 * para obtener +20% de bonus en la siguiente operación de forage.
 */
const SURVEY_RESOURCES = [
  { name: 'vetas de mineral', emoji: '⛏️', tip: 'El forage en esta sala podría revelar fragmentos de mineral valioso.' },
  { name: 'raíces medicinales', emoji: '🌿', tip: 'Hay hierbas ocultas bajo el musgo. El forage tiene alta chance de hierbas curativas.' },
  { name: 'ruinas antiguas', emoji: '🏛️', tip: 'Fragmentos de civilizaciones pasadas. El forage podría revelar monedas antiguas.' },
  { name: 'hongos luminosos', emoji: '🍄', tip: 'Los hongos son abundantes aquí. El forage tiene buenas chances de materiales de alquimia.' },
  { name: 'cristales ocultos', emoji: '💎', tip: 'Destellos en las grietas de las rocas. El forage podría revelar un cristal de cuarzo.' },
  { name: 'polvo de huesos', emoji: '🦴', tip: 'Restos de seres olvidados. El forage podría revelar reliquias o monedas.' },
];

// Mapa en memoria: roomId -> { playerId -> timestamp }
const surveyCooldowns = new Map();

function cmdSurvey(player) {
  player = db.getPlayer(player.id);
  const roomId = player.current_room_id;
  const now = Date.now();

  // Verificar cooldown
  if (!surveyCooldowns.has(roomId)) surveyCooldowns.set(roomId, new Map());
  const roomSurveys = surveyCooldowns.get(roomId);
  const lastSurvey = roomSurveys.get(player.id) || 0;
  const elapsed = now - lastSurvey;

  if (elapsed < SURVEY_COOLDOWN_MS) {
    const remaining = Math.ceil((SURVEY_COOLDOWN_MS - elapsed) / 1000);
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    return { text: `🔍 Ya sondeaste esta sala recientemente.\nPodrás volver a sondear en ${mins}m ${secs}s.` };
  }

  // Probabilidad de encontrar recursos (20% nada, 80% algo)
  const found = Math.random() < 0.80;
  if (!found) {
    roomSurveys.set(player.id, now);
    return {
      text: `🔍 Examinás la sala en detalle, buscando recursos...\n\nNo encontrás nada de particular interés. La sala parece haber sido ya saqueada.\n💡 Tip: Si querés buscar ítems ocultos igual, usá \`forage\`.`
    };
  }

  // Elegir recurso aleatorio
  const resource = SURVEY_RESOURCES[Math.floor(Math.random() * SURVEY_RESOURCES.length)];

  // Marcar la sala como "sondeada" en BD (usamos forage_data con prefijo "survey_")
  let forageData = {};
  try { forageData = JSON.parse(player.forage_data || '{}'); } catch (_) {}
  const surveyKey = `survey_${roomId}`;
  forageData[surveyKey] = now;
  // Limpiar entradas viejas si pasan de 30
  const keys = Object.keys(forageData);
  if (keys.length > 30) {
    const oldest = keys.sort((a, b) => forageData[a] - forageData[b])[0];
    delete forageData[oldest];
  }
  db.updatePlayer(player.id, { forage_data: JSON.stringify(forageData) });
  roomSurveys.set(player.id, now);

  const w = 50;
  const line = '─'.repeat(w);
  const title = '  🔭 SONDEO DE LA SALA  ';
  const lines = [
    `┌${line}┐`,
    `│${title.padEnd(w)}│`,
    `├${line}┤`,
    `│  ${resource.emoji} Recurso detectado: ${resource.name.padEnd(w - 23)}│`,
    `│                                                  │`,
    `│  ${resource.tip.substring(0, w-4).padEnd(w-4)}│`,
    `│                                                  │`,
    `│  ✨ Esta sala está marcada. El próximo \`forage\`  │`,
    `│     tendrá un 20% de bonus de éxito adicional.  │`,
    `└${line}┘`,
  ];

  return { text: lines.join('\n') };
}

/**
 * pet [adopt <tipo>] [liberar] — Sistema de mascotas.
 * Sin argumentos: muestra tu mascota actual.
 * adopt <tipo>: adoptar una mascota (cuesta oro).
 * liberar: liberar tu mascota actual.
 */
// T199: Calcular nivel de mascota según kills del dueño (cada 20 kills sube un nivel, máx 5)
function getPetLevel(playerKills) {
  return Math.min(5, Math.floor((playerKills || 0) / 20) + 1);
}

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
    // T199: mostrar nivel de mascota
    const petLv = getPetLevel(player.kills);
    const petBar = '⭐'.repeat(petLv) + '☆'.repeat(5 - petLv);
    const petBonus = petLv >= 3 ? ` (+${petLv - 2} dmg bonus en combate)` : '';
    return { text: `🐾 Tu mascota: ${player.pet}\n   Nivel: ${petLv}/5 ${petBar}${petBonus}\n   (Sube de nivel cada 20 kills — tenés ${player.kills || 0} kills)\n\nUsá "pet liberar" si querés dejarla ir.` };
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

  // T206: En calor abrasador, maná regenera al doble
  const weatherManaBonus = weather.getManaRegenMultiplier();
  const effectiveManaGained = Math.floor(manaGained * weatherManaBonus);

  const newMana = Math.min(maxMana, currentMana + effectiveManaGained);
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
  const repLevel = db.getReputationLevel(fresh.reputation || 0);

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
    `║${line('ATK  ', `${fresh.attack}${fresh.pet ? ` +1🐾=${fresh.attack+1}` : ''}  ·  DEF: ${fresh.defense}`)}║`,
    `╟${'─'.repeat(W)}╢`,
    `║${line('Kills ', `${kills}  ·  Muertes: ${deaths}  ·  K/D: ${kd}`)}║`,
    `║${line('Duelos', `⚔️ ${duelWins} ganados / ${duelLosses} perdidos`)}║`,
    `║${line('Oro   ', `💰 ${gold}g`)}║`,
    `║${line('Reputa', `${repLevel.icon} ${repLevel.name} (${repLevel.points} pts)`)}║`,
    `╟${'─'.repeat(W)}╢`,
    `║${line('Hermandad', fresh.guild ? `[${fresh.guild}]` : '(independiente)')}║`,
    `║${line('Mascota  ', fresh.pet || '(sin compañero)')}║`,
    `║${line('Arma     ', fresh.equipped_weapon || '(desarmado)')}║`,
    `║${line('Armadura ', fresh.equipped_armor || '(sin armadura)')}║`,
    `╟${'─'.repeat(W)}╢`,
    `║${line('Logros   ', `${achCount} desbloqueados`)}║`,
    `║  ${achIcons.slice(0, W - 2)}║`,
    `║${line('Bestiario', `${bestiaryCount} tipos cazados · ${totalBestiaryKills} kills totales`)}║`,
    `║${line('Tiempo   ', (() => { const t = fresh.playtime_minutes || 0; const h = Math.floor(t/60); const m = t%60; return h > 0 ? `${h}h ${m}m` : `${m}m`; })())}║`,
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

/**
 * T117: changelog — novedades del juego in-game.
 */
function cmdChangelog() {
  const CHANGELOG = [
    { version: '0.29', date: '2026-05-30', changes: [
      '✨ NUEVO: metas globales del servidor (comando worldgoals/metas)',
      '🌍 Contadores acumulativos de kills, crafteos, oro y duelos de todos los aventureros',
      '🏆 Al alcanzar un hito (100/500/1000/5000 kills, etc.) broadcast global al servidor',
      '📊 Barras de progreso ASCII para ver el estado actual de cada meta',
      '✨ NUEVO: récords del servidor (comando records/trofeos)',
      '🥇 Registra automáticamente: nivel más alto, más kills, combo máximo, más oro, más duelos',
      '🌟 Si batés un récord, broadcast global al servidor con tu nombre',
    ]},
    { version: '0.28', date: '2026-05-30', changes: [
      '✨ NUEVO: misiones colectivas de guild (guild quest)',
      '⚔ Cada hermandad tiene una misión activa: matar monstruos, craftear, recoger oro',
      '🏆 Al completar: todos los miembros reciben +50 XP · +30 🪙 · +10 Reputación',
      '🔄 La misión rota automáticamente al completarse (10 tipos distintos)',
    ]},
    { version: '0.27', date: '2026-05-30', changes: [
      '✨ NUEVO: hardcore new/sucesor — tras caer en Hardcore, creá tu personaje sucesor (I, II, III...)',
      '⚔️ El sucesor hereda el nombre con sufijo romano y comienza con Hardcore activo',
      '✝ Los personajes caídos aparecen en score con ✝ y pueden usar comandos pasivos',
    ]},
    { version: '0.26', date: '2026-05-30', changes: [
      '✨ NUEVO: modo Hardcore (comando hardcore on/off)',
      '☠ Si morís en modo Hardcore, tu personaje queda como ✝ fantasma (solo comandos pasivos)',
      '🔴 Visible en score con emoji: 🔴 vivo, ✝ caído',
      '⚡ Broadcast global dramático al caer un aventurero hardcore',
    ]},
    { version: '0.25', date: '2026-05-30', changes: [
      '✨ NUEVO: sistema de armaduras — wear/unwear, 7 tipos, loot de monstruos y tienda',
      '✨ NUEVO: pergaminos mágicos — 3 tipos de buff temporal de combate (furia/escudo/velocidad)',
      '✨ NUEVO: pergaminos en forage, loot de Lich/Campeón/Sombra del Vacío',
    ]},
    { version: '0.24', date: '2026-05-30', changes: [
      '✨ NUEVO: comando enemies/top [N] — monstruos más poderosos del dungeon con estado y tiempo de respawn',
      '⚡ MEJORA: enemies muestra 📍 si el monstruo está vivo y 🔮 con tiempo restante si está en respawn',
      '✨ NUEVO: comando compare/vs <jugador> — tabla comparativa de stats lado a lado con otro aventurero',
    ]},
    { version: '0.23', date: '2026-05-30', changes: [
      '✨ NUEVO: comando server/estadísticas — estado global del servidor en caja ASCII',
      '✨ NUEVO: endpoint REST /api/stats — estadísticas públicas para integración LLM',
      '✨ NUEVO: bonus de mascota en combate (+1 ATK efectivo si tenés compañero)',
      '✨ NUEVO: mascota avisa trampas (15% de chance de evitar el daño al entrar)',
      '✨ NUEVO: comando time/hora — hora del servidor y período del día con descripción',
    ]},
    { version: '0.22', date: '2026-05-30', changes: [
      '🐛 BUG: subasta con ítems de nombre compuesto (crash resuelto)',
      '🐛 BUG: habilidades activas (smash/bash/rally) crash por REST (resuelto)',
      '🐛 BUG: pociones se consumían con HP al máximo (resuelto)',
      '🐛 BUG: "attack golem" no funcionaba para "Gólem de Piedra" (tildes, resuelto)',
      '✨ NUEVO: comando note/apunte — notas personales del aventurero',
      '✨ NUEVO: comando changelog/novedades — esto que estás leyendo',
    ]},
    { version: '0.21', date: '2026-05-30', changes: [
      '✨ NUEVO: habilidades activas por nivel (smash Lv3, shield_bash Lv6, rally Lv10)',
      '✨ NUEVO: logros secretos (5 logros ocultos: Temerario, Mecenas, Artesano, Último Aliento, Cartógrafo)',
    ]},
    { version: '0.20', date: '2026-05-30', changes: [
      '✨ NUEVO: bestiario personal (comando bestiario/bestiary)',
      '✨ NUEVO: perfil de aventurero en caja ASCII (comando perfil/profile)',
    ]},
    { version: '0.19', date: '2026-05-30', changes: [
      '✨ NUEVO: 3 clases de personaje — Guerrero, Mago, Pícaro (comando clase)',
      '✨ NUEVO: sistema de magia con maná (cast bola-de-fuego/escudo/curación)',
      '✨ NUEVO: decoración horaria en el minimapa (sol/luna/amanecer/atardecer)',
      '✨ NUEVO: mensaje de bienvenida de regreso tras 1+ hora de ausencia',
    ]},
    { version: '0.18', date: '2026-05-30', changes: [
      '✨ NUEVO: efectos on_hit en armas crafteadas (veneno, rayo de sombra)',
      '✨ NUEVO: comando pay/pagar — transferir oro entre jugadores',
      '✨ NUEVO: rankings extendidos (score oro, score duelos)',
    ]},
  ];

  const W = 48;
  const lines = [
    `╔${'═'.repeat(W)}╗`,
    `║${'  📋 NOVEDADES DEL DUNGEON OF ECHOES'.padEnd(W)}║`,
    `╚${'═'.repeat(W)}╝`,
    '',
  ];

  for (const entry of CHANGELOG) {
    lines.push(`  ▸ v${entry.version} (${entry.date})`);
    for (const c of entry.changes) {
      lines.push(`    ${c}`);
    }
    lines.push('');
  }

  lines.push('Para más historia del proyecto: github.com/driftwood886/dungeon-of-echoes');

  return { text: lines.join('\n') };
}


// ─── T119: Estadísticas globales del servidor ────────────────────────────────

/**
 * server/stats/estadísticas — Muestra estadísticas globales del dungeon en caja ASCII
 */
function cmdServerStats() {
  try {
    const cutoff5min = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const rawDb = db.raw();

    const totalPlayersR = rawDb.exec('SELECT COUNT(*) FROM players')[0];
    const totalPlayers = totalPlayersR ? totalPlayersR.values[0][0] : 0;

    const activePR = rawDb.exec(`SELECT COUNT(*) FROM players WHERE last_seen >= '${cutoff5min}'`)[0];
    const activePlayers = activePR ? activePR.values[0][0] : 0;

    const killsR = rawDb.exec('SELECT SUM(kills) FROM players')[0];
    const totalKills = killsR ? (killsR.values[0][0] || 0) : 0;

    const goldR = rawDb.exec('SELECT SUM(gold) FROM players')[0];
    const totalGold = goldR ? (goldR.values[0][0] || 0) : 0;

    const monstersR = rawDb.exec('SELECT COUNT(*) FROM monsters WHERE room_id IS NOT NULL')[0];
    const activeMonsters = monstersR ? monstersR.values[0][0] : 0;

    const uptimeSec = Math.floor(process.uptime());
    const uptimeMin = Math.floor(uptimeSec / 60);
    const uptimeHrs = Math.floor(uptimeMin / 60);
    const uptimeStr = uptimeHrs > 0
      ? `${uptimeHrs}h ${uptimeMin % 60}m ${uptimeSec % 60}s`
      : `${uptimeMin}m ${uptimeSec % 60}s`;

    const W = 44;
    const row = (label, value) => {
      const line = `  ${label}: ${value}`;
      return `║${line.padEnd(W)}║`;
    };

    const lines = [
      `╔${'═'.repeat(W)}╗`,
      `║${'  🏰 DUNGEON OF ECHOES — ESTADO DEL SERVIDOR'.slice(0, W).padEnd(W)}║`,
      `╠${'═'.repeat(W)}╣`,
      row('👤 Jugadores registrados', totalPlayers),
      row('🟢 Activos (últimos 5min)', activePlayers),
      row('⚔️  Muertes totales',       totalKills),
      row('💰 Oro en circulación',     totalGold + 'g'),
      row('👾 Monstruos activos',      activeMonsters),
      row('⏱  Uptime del servidor',    uptimeStr),
      `╚${'═'.repeat(W)}╝`,
    ];

    return { text: lines.join('\n') };
  } catch (err) {
    return { text: `Error obteniendo estadísticas: ${err.message}` };
  }
}

module.exports = { execute, getOrCreatePlayer, ROOM_EFFECTS, resolveExpiredAuctions, getTitle, regenMana, SPELL_CATALOG, getClassReminder, cmdBestiary, cmdProfile, cmdJournal, cmdServerStats };

// ─── T121: Comando time/hora ──────────────────────────────────────────────────

/**
 * time / hora — Muestra la hora del servidor y el período del día actual.
 */
function cmdTime() {
  const now = new Date();
  const hour = now.getUTCHours();
  const min  = now.getUTCMinutes();
  const timeStr = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')} UTC`;

  const period = ambient.getTimePeriod();
  const PERIOD_INFO = {
    morning:   { emoji: '🌅', name: 'Amanecer',   desc: 'Los primeros rayos de luz se filtran. Los monstruos aún adormecidos.',       range: '05:00–11:59' },
    afternoon: { emoji: '☀️',  name: 'Mediodía',   desc: 'El dungeon vibra de actividad. Los monstruos están en su punto más activo.', range: '12:00–17:59' },
    evening:   { emoji: '🌇', name: 'Atardecer',  desc: 'La luz mengua. Las criaturas nocturnas despiertan.',                         range: '18:00–22:59' },
    midnight:  { emoji: '🌙', name: 'Medianoche', desc: 'Oscuridad total. El dungeon pertenece a las sombras.',                       range: '23:00–04:59' },
  };

  const p = PERIOD_INFO[period] || PERIOD_INFO.midnight;

  // Calcular próximo período
  const nextPeriods = { morning: 'afternoon', afternoon: 'evening', evening: 'midnight', midnight: 'morning' };
  const nextPeriodName = PERIOD_INFO[nextPeriods[period]].name;
  const nextHours = { morning: 12, afternoon: 18, evening: 23, midnight: 5 };
  const nextH = nextHours[period];
  const minsLeft = ((nextH * 60) - (hour * 60 + min) + 24 * 60) % (24 * 60);
  const timeLeftStr = `${Math.floor(minsLeft / 60)}h ${minsLeft % 60}m`;

  const lines = [
    ``,
    `${p.emoji} HORA DEL SERVIDOR: ${timeStr}`,
    `   Período: ${p.name} (${p.range})`,
    `   ${p.desc}`,
    ``,
    `⏱ Próximo período: ${nextPeriodName} en ~${timeLeftStr}`,
    ``,
    `💡 La hora afecta los textos ambientales, la decoración del mapa y los eventos globales.`,
  ];

  return { text: lines.join('\n') };
}

module.exports = { execute, getOrCreatePlayer, ROOM_EFFECTS, resolveExpiredAuctions, getTitle, regenMana, SPELL_CATALOG, getClassReminder, cmdBestiary, cmdProfile, cmdJournal, cmdServerStats, cmdTime };

// ─── T122: Comando enemies/enemigos — monstruos del dungeon ordenados por HP ──

/**
 * enemies [n] — Muestra los monstruos más poderosos del dungeon con estado actual.
 * Útil para planificar rutas de grindeo.
 */
function cmdEnemies(args) {
  const limit = Math.min(20, Math.max(1, parseInt((args && args[0]) || '10') || 10));
  const rawDb = db.raw();

  // Obtener todos los monstruos junto con el nombre de su sala.
  // Si room_id es NULL (monstruo en respawn), usar respawn_room_id para mostrar dónde reaparecerá.
  const rows = rawDb.exec(`
    SELECT m.id, m.name, m.hp, m.max_hp, m.attack, m.room_id, m.respawn_at,
      CASE WHEN m.room_id IS NOT NULL THEN r.name ELSE rr.name END as room_name
    FROM monsters m
    LEFT JOIN rooms r ON m.room_id = r.id
    LEFT JOIN rooms rr ON m.respawn_room_id = rr.id
    ORDER BY m.max_hp DESC
    LIMIT ${limit}
  `);

  if (!rows.length || !rows[0].values.length) {
    return { text: 'No hay monstruos registrados en el dungeon.' };
  }

  const W = 52;
  const lines = [
    ``,
    `╔${'═'.repeat(W)}╗`,
    `║${'  👾 MONSTRUOS DEL DUNGEON (por poder)'.padEnd(W)}║`,
    `╠${'═'.repeat(W)}╣`,
  ];

  for (const row of rows[0].values) {
    const [id, name, hp, maxHp, attack, room_id, respawnAt, roomName] = row;
    let status;
    if (room_id) {
      status = `⚔ VIVO (${hp}/${maxHp} HP)`;
    } else if (respawnAt) {
      const secsLeft = Math.max(0, Math.ceil((new Date(respawnAt) - Date.now()) / 1000));
      const minsLeft = Math.ceil(secsLeft / 60);
      status = secsLeft > 60 ? `💤 ${minsLeft}min` : `💤 ${secsLeft}s`;
    } else {
      status = `💤 Respawn`;
    }
    const location = roomName ? roomName : `Sala ${room_id || '?'}`;
    const prefix = room_id ? '📍' : '🔮';
    const attackStr = `ATK ${attack}`;

    const line1 = `  ${name}`.padEnd(22) + status.padEnd(22);
    const line2 = `  ${prefix} ${location}`.padEnd(30) + attackStr;
    lines.push(`║${line1.slice(0,W)}║`);
    lines.push(`║${line2.slice(0,W)}║`);
    lines.push(`║${'─'.repeat(W)}║`);
  }

  // Quitar última línea divisoria y poner cierre
  lines.pop();
  lines.push(`╚${'═'.repeat(W)}╝`);
  lines.push(`\n💡 Usá "map" para ver el minimapa del dungeon.`);

  return { text: lines.join('\n') };
}

module.exports = { execute, getOrCreatePlayer, ROOM_EFFECTS, resolveExpiredAuctions, getTitle, regenMana, SPELL_CATALOG, getClassReminder, cmdBestiary, cmdProfile, cmdJournal, cmdServerStats, cmdTime, cmdEnemies, cmdCompare };

// ─── T123: Comando compare/comparar — comparar stats con otro jugador ────────

/**
 * compare <jugador> — Tabla comparativa de stats entre el jugador actual y otro en la misma sala.
 */
function cmdCompare(player, args) {
  if (!args || !args.length) {
    return { text: 'Uso: compare <nombre_jugador>  — comparar tus stats con otro aventurero en la sala.\n     compare server/global  — comparar con el promedio global del servidor.' };
  }

  const targetName = args.join(' ').trim().toLowerCase();

  // T202: compare server / compare global — comparar con el promedio del servidor
  if (targetName === 'server' || targetName === 'global' || targetName === 'servidor' || targetName === 'promedio') {
    const allPlayers = db.getAllPlayers();
    if (!allPlayers || allPlayers.length < 1) {
      return { text: 'No hay suficientes aventureros registrados para calcular promedios.' };
    }

    const avg = (field) => {
      const vals = allPlayers.map(p => Number(p[field] || 0)).filter(v => !isNaN(v));
      return vals.length ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length * 10) / 10 : 0;
    };

    const avgHp     = avg('hp');
    const avgMaxHp  = avg('max_hp');
    const avgAtk    = avg('attack');
    const avgDef    = avg('defense');
    const avgLevel  = avg('level');
    const avgKills  = avg('kills');
    const avgGold   = avg('gold');
    const avgRep    = avg('reputation');

    function delta(mine, avgVal) {
      const diff = mine - avgVal;
      const pct  = avgVal > 0 ? Math.round(Math.abs(diff / avgVal) * 100) : 0;
      if (diff > 0) return `▲ +${diff} (${pct}% sobre promedio)`;
      if (diff < 0) return `▼ ${diff} (${pct}% bajo promedio)`;
      return `= igual al promedio`;
    }

    const W = 54;
    const fresh = db.getPlayer(player.id);

    const lines = [];
    lines.push(`╔${'═'.repeat(W)}╗`);
    lines.push(`║${'  📊 VOS VS. EL PROMEDIO DEL SERVIDOR'.padEnd(W)}║`);
    lines.push(`║${'  (' + allPlayers.length + ' aventureros registrados)'.padEnd(W - 2)}║`);
    lines.push(`╠${'═'.repeat(W)}╣`);

    function row(label, mine, avgVal) {
      const l   = label.padEnd(12);
      const m   = String(mine).padEnd(8);
      const a   = String(avgVal).padEnd(8);
      const d   = delta(Number(mine), Number(avgVal));
      return `║  ${l} ${m} vs ${a}  ${d}`.slice(0, W + 2).padEnd(W + 2) + `║`;
    }

    lines.push(`║  ${'STAT'.padEnd(12)} ${'TUY0'.padEnd(8)} ${'PROM'.padEnd(8)}  DIFERENCIA`.padEnd(W + 2) + `║`);
    lines.push(`╠${'─'.repeat(W)}╣`);
    lines.push(row('HP',      fresh.hp || 0,     avgHp));
    lines.push(row('HP máx',  fresh.max_hp || 30, avgMaxHp));
    lines.push(row('ATK',     fresh.attack || 5,  avgAtk));
    lines.push(row('DEF',     fresh.defense || 3, avgDef));
    lines.push(`╠${'─'.repeat(W)}╣`);
    lines.push(row('Nivel',   fresh.level || 1,   avgLevel));
    lines.push(row('Kills',   fresh.kills || 0,   avgKills));
    lines.push(row('Oro',     fresh.gold || 0,    avgGold));
    lines.push(row('Rep',     fresh.reputation || 0, avgRep));
    lines.push(`╚${'═'.repeat(W)}╝`);

    return { text: lines.join('\n') };
  }
  const playersInRoom = db.getPlayersInRoom(player.current_room_id);
  const target = playersInRoom.find(p =>
    p.id !== player.id && p.username.toLowerCase().includes(targetName)
  );

  if (!target) {
    return { text: `No hay ningún aventurero llamado "${args.join(' ')}" en esta sala.` };
  }

  const { CLASSES } = require('./classes');

  function getClassInfo(p) {
    const cls = p.player_class ? CLASSES[p.player_class] : null;
    return cls ? `${cls.emoji} ${cls.name}` : '❓ Sin clase';
  }

  function getWeapon(p) {
    return p.equipped_weapon || 'Puños';
  }

  function hpBar(hp, maxHp, len = 8) {
    const filled = Math.round((hp / maxHp) * len);
    return '█'.repeat(Math.max(0, filled)) + '░'.repeat(Math.max(0, len - filled));
  }

  const title1 = getTitle(player.kills || 0);
  const title2 = getTitle(target.kills || 0);

  const W = 54;
  const COL = 18;

  function row(label, v1, v2) {
    const l = label.padEnd(12);
    const c1 = String(v1).padEnd(COL);
    const c2 = String(v2).padEnd(COL);
    const full = `  ${l}  ${c1}  ${c2}`;
    return `║${full.slice(0, W)}║`;
  }

  function divider() {
    return `║${'─'.repeat(W)}║`;
  }

  function header(text) {
    return `║${text.padEnd(W)}║`;
  }

  const p1Name = player.username.slice(0, 16);
  const p2Name = target.username.slice(0, 16);
  const nameRow = `  ${''.padEnd(12)}  ${p1Name.padEnd(COL)}  ${p2Name.padEnd(COL)}`;

  const lines = [
    '',
    `╔${'═'.repeat(W)}╗`,
    header(`  ⚔ COMPARACIÓN DE AVENTUREROS`),
    `╠${'═'.repeat(W)}╣`,
    `║${nameRow.slice(0, W)}║`,
    divider(),
    row('Clase',   getClassInfo(player), getClassInfo(target)),
    row('Título',  title1.full, title2.full),
    row('Nivel',   player.level || 1, target.level || 1),
    row('XP',      player.xp || 0, target.xp || 0),
    divider(),
    row('HP',
      `${player.hp}/${player.max_hp} [${hpBar(player.hp, player.max_hp)}]`,
      `${target.hp}/${target.max_hp} [${hpBar(target.hp, target.max_hp)}]`
    ),
    row('Maná',
      `${player.mana || 0}/${player.max_mana || 20}`,
      `${target.mana || 0}/${target.max_mana || 20}`
    ),
    row('ATK',     player.attack || 5, target.attack || 5),
    row('DEF',     player.defense || 3, target.defense || 3),
    divider(),
    row('Kills',   player.kills || 0, target.kills || 0),
    row('Muertes', player.deaths || 0, target.deaths || 0),
    row('Oro',     `${player.gold || 0}g`, `${target.gold || 0}g`),
    divider(),
    row('Arma',    getWeapon(player).slice(0, COL - 1), getWeapon(target).slice(0, COL - 1)),
    `╚${'═'.repeat(W)}╝`,
  ];

  return { text: lines.join('\n') };
}

/**
 * T125: reputation — Ver tu reputación detallada.
 */
function cmdReputation(player) {
  const fresh = db.getPlayer(player.id);
  if (!fresh) return { text: 'Error al leer tu perfil.' };
  const rep = db.getReputationLevel(fresh.reputation || 0);

  const LEVELS = [
    { min: 0,   name: 'Desconocido', icon: '👤' },
    { min: 10,  name: 'Conocido',    icon: '🗣️' },
    { min: 25,  name: 'Respetado',   icon: '🏅' },
    { min: 50,  name: 'Famoso',      icon: '⭐' },
    { min: 100, name: 'Legendario',  icon: '🌟' },
  ];

  const barLen = 20;
  const nextT = rep.nextThreshold || rep.points || 1;
  const prevIdx = LEVELS.findLastIndex(l => l.name !== rep.name && l.min < (rep.nextThreshold || 999));
  const prevT = prevIdx >= 0 ? LEVELS[prevIdx].min : 0;
  const curIdx = LEVELS.findIndex(l => l.name === rep.name);
  const actualPrevT = curIdx > 0 ? LEVELS[curIdx - 1].min : 0;
  const range = (rep.nextThreshold || rep.points) - actualPrevT;
  const progress = range > 0 ? Math.min(rep.points - actualPrevT, range) : 0;
  const filled = range > 0 ? Math.round((progress / range) * barLen) : barLen;
  const repBar = '█'.repeat(Math.max(0, filled)) + '░'.repeat(Math.max(0, barLen - filled));

  const nextLevelName = rep.nextThreshold ? (LEVELS[curIdx + 1]?.name || '???') : null;
  const nextText = nextLevelName
    ? '  ' + rep.points + '/' + rep.nextThreshold + ' pts (+' + (rep.nextThreshold - rep.points) + ' para ' + nextLevelName + ')'
    : '  ¡Reputación máxima alcanzada!';

  const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);

  const lines = [
    '',
    '╔' + '═'.repeat(40) + '╗',
    '║' + pad('       ' + rep.icon + ' REPUTACIÓN: ' + rep.name.toUpperCase(), 40) + '║',
    '╟' + '─'.repeat(40) + '╢',
    '║' + pad('  ' + fresh.username + ' — ' + rep.points + ' puntos de reputación', 40) + '║',
    '║' + pad('  [' + repBar + ']' + nextText, 40) + '║',
    '╟' + '─'.repeat(40) + '╢',
    '║  Cómo ganar reputación:             ║',
    '║    ⚔ Kill monstruo:    +1 pt        ║',
    '║    📜 Quest completada: +5 pts       ║',
    '║    🏅 Logro desbloqueado: +3 pts     ║',
    '╚' + '═'.repeat(40) + '╝',
  ];

  return { text: lines.join('\n') };
}

/**
 * T140: runas / runes — Ver la colección de runas del jugador.
 */
function cmdRunas(player) {
  const fresh = db.getPlayer(player.id);
  if (!fresh) return { text: 'Error al leer tu perfil.' };

  let runes;
  try { runes = JSON.parse(fresh.runes || '{}'); } catch (_) { runes = {}; }

  const { RUNE_TYPES, RUNE_EMOJIS, RUNE_BONUSES } = db;

  const lines = [
    '',
    '╔' + '═'.repeat(44) + '╗',
    '║       🔮 COLECCIÓN DE RUNAS                 ║',
    '╟' + '─'.repeat(44) + '╢',
  ];

  let hasAny = false;
  for (const type of RUNE_TYPES) {
    const count = runes[type] || 0;
    const emoji = RUNE_EMOJIS[type];
    const bonus = RUNE_BONUSES[type];
    const filled = '◆'.repeat(count);
    const empty  = '◇'.repeat(3 - count);
    const bar = filled + empty;
    const label = type.charAt(0).toUpperCase() + type.slice(1);
    const line = `  ${emoji} ${label.padEnd(7)} [${bar}] ${count}/3`;
    const bonusNote = count >= 2 ? `  ← ¡1 más fusiona!` : '';
    lines.push('║' + (line + bonusNote).padEnd(44) + '║');
    if (count > 0) hasAny = true;
  }

  if (!hasAny) {
    lines.splice(3, 0, '║  (Aún no tenés runas. Matá monstruos!)         ║');
  }

  lines.push('╟' + '─'.repeat(44) + '╢');
  lines.push('║  Al juntar 3 del mismo tipo se FUSIONAN:        ║');
  for (const type of RUNE_TYPES) {
    const b = RUNE_BONUSES[type];
    const emoji = RUNE_EMOJIS[type];
    lines.push(`║  ${emoji} ${(type + ':').padEnd(8)} ${b.label.padEnd(33)}║`);
  }
  lines.push('║  (15% de chance de obtener una runa al matar)  ║');
  lines.push('╚' + '═'.repeat(44) + '╝');

  return { text: lines.join('\n') };
}

/**
 * T139: peek <dirección> / espiar <dirección>
 * Mirar en una dirección sin moverse.
 * Muestra: nombre de la sala, si hay monstruos (sin detalles de HP), si hay ítems.
 * No funciona si la salida está bloqueada con llave.
 */
function cmdPeek(player, args) {
  if (!args || args.length === 0) {
    return {
      text: [
        'Espiar en una dirección sin moverte.',
        'Uso: peek <dirección>  /  espiar <dirección>',
        'Ej: peek norte  |  espiar este',
      ].join('\n'),
    };
  }

  const roomFull = dungeon.getRoomFull(player.current_room_id);
  if (!roomFull) return { text: 'No podés leer el entorno.' };
  const { room } = roomFull;

  const dirArg = args[0];
  const exit = dungeon.resolveExit(room, dirArg);

  if (!exit) {
    const dirName = dirArg;
    return { text: `No hay salida hacia el ${dirName}.` };
  }

  // Si la salida requiere llave → no se puede espiar (está bloqueada)
  if (exit.key) {
    return { text: `La salida está bloqueada con 🔒. No podés ver nada a través de ella.` };
  }

  // Cargar la sala destino
  const targetFull = dungeon.getRoomFull(exit.targetId);
  if (!targetFull) return { text: 'No podés ver nada en esa dirección.' };

  const { room: target, monsters } = targetFull;

  // Construir el reporte de lo que se ve
  const DIR_NAMES_ES = { north: 'norte', south: 'sur', east: 'este', west: 'oeste', up: 'arriba', down: 'abajo' };
  const normalized = dungeon.normalizeDirection(dirArg) || dirArg;
  const dirLabel = DIR_NAMES_ES[normalized] || dirArg;

  const lines = [
    `👁️  Espiás hacia el ${dirLabel}...`,
    ``,
    `📍 ${target.name}`,
  ];

  // Monstruos (solo nombres, sin HP)
  const aliveMonsters = monsters.filter(m => m.room_id !== null);
  if (aliveMonsters.length > 0) {
    const names = aliveMonsters.map(m => `⚔️ ${m.name}`).join(', ');
    lines.push(`🐉 Criaturas: ${names}`);
  } else {
    lines.push(`🕊️ Sin criaturas a la vista.`);
  }

  // Ítems en el suelo
  const floorItems = target.items || [];
  if (floorItems.length > 0) {
    const itemList = floorItems.slice(0, 5).map(i => {
      const emoji = items.getRarityEmoji(i);
      return `${emoji} ${i}`;
    }).join(', ');
    const extra = floorItems.length > 5 ? ` (+${floorItems.length - 5} más)` : '';
    lines.push(`🎒 Suelo: ${itemList}${extra}`);
  } else {
    lines.push(`🌑 Sin ítems en el suelo.`);
  }

  // Trampa activa
  if (target.trap && target.trap.active) {
    lines.push(`⚠️  ¡Trampa activa detectada!`);
  }

  return { text: lines.join('\n') };
}

/**
 * T141: challenge / desafío — Ver el desafío diario personal del jugador.
 */
function cmdChallenge(player) {
  const fresh = db.getPlayer(player.id);
  if (!fresh) return { text: 'Error al leer tu perfil.' };
  const ch = db.getDailyChallenge(fresh);
  const progress = ch.progress || 0;
  const pct = Math.floor((progress / ch.goal) * 20);
  const bar = '█'.repeat(pct) + '░'.repeat(20 - pct);
  const status = ch.done ? '✅ ¡COMPLETADO!' : `${progress}/${ch.goal}`;
  const lines = [
    '',
    '╔' + '═'.repeat(44) + '╗',
    '║       📅 DESAFÍO DEL DÍA                    ║',
    '╟' + '─'.repeat(44) + '╢',
    `  ${ch.desc}`,
    `  Progreso: [${bar}] ${status}`,
    '╟' + '─'.repeat(44) + '╢',
    '  Recompensa: +30 XP · +20 🪙 · +5 Reputación',
    ch.done
      ? '  🌟 ¡Recompensa ya cobrada! Volvé mañana.'
      : '  ⏳ Completalo antes de medianoche (UTC).',
    '╚' + '═'.repeat(44) + '╝',
    '',
  ];
  return { text: lines.join('\n') };
}

/**
 * T142: macro — Guardar y ejecutar macros personales (hasta 5, secuencias con ;)
 */
function cmdMacro(player, args, context) {
  const fresh = db.getPlayer(player.id);
  if (!fresh) return { text: 'Error al leer tu perfil.' };

  let macros = {};
  try { macros = JSON.parse(fresh.macros || '{}'); } catch (_) { macros = {}; }

  const sub = (args[0] || '').toLowerCase();

  // macro list
  if (!sub || sub === 'list' || sub === 'lista' || sub === 'listar') {
    const keys = Object.keys(macros);
    if (keys.length === 0) return { text: '📋 No tenés macros guardadas. Usá: macro set <nombre> <comando>' };
    const lines = ['', '╔' + '═'.repeat(44) + '╗', '║       📋 TUS MACROS                         ║', '╟' + '─'.repeat(44) + '╢'];
    for (const k of keys) {
      const v = macros[k];
      lines.push(`  !${k.padEnd(12)} → ${v.length > 28 ? v.slice(0, 28) + '…' : v}`);
    }
    lines.push('╚' + '═'.repeat(44) + '╝', '');
    return { text: lines.join('\n') };
  }

  // macro set <nombre> <comando(s)>
  if (sub === 'set' || sub === 'guardar' || sub === 'add' || sub === 'nuevo') {
    const name = (args[1] || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (!name) return { text: '⚠️ Usá: macro set <nombre> <comando>' };
    const cmd = args.slice(2).join(' ').trim();
    if (!cmd) return { text: '⚠️ Usá: macro set <nombre> <comando>' };
    if (Object.keys(macros).length >= 5 && !macros[name]) {
      return { text: '⚠️ Límite de 5 macros alcanzado. Borrá una con: macro del <nombre>' };
    }
    macros[name] = cmd;
    db.updatePlayer(player.id, { macros: JSON.stringify(macros) });
    return { text: `✅ Macro "!${name}" guardada → ${cmd}` };
  }

  // macro del <nombre>
  if (sub === 'del' || sub === 'delete' || sub === 'borrar' || sub === 'eliminar') {
    const name = (args[1] || '').toLowerCase();
    if (!macros[name]) return { text: `⚠️ No encontré la macro "!${name}".` };
    delete macros[name];
    db.updatePlayer(player.id, { macros: JSON.stringify(macros) });
    return { text: `🗑️ Macro "!${name}" eliminada.` };
  }

  // macro <nombre> — ejecutar
  const macroName = sub.replace(/^!/, '');
  if (macros[macroName]) {
    const commands = macros[macroName].split(';').map(c => c.trim()).filter(Boolean);
    const texts = [];
    let latestPlayer = fresh;
    for (const cmd of commands) {
      try {
        const subAction = parse(cmd);
        const subResult = execute(latestPlayer, subAction, context);
        texts.push(`» ${cmd}\n${subResult.text}`);
        // Refrescar jugador para el próximo comando
        latestPlayer = db.getPlayer(fresh.id) || latestPlayer;
      } catch (e) {
        texts.push(`» ${cmd}\n⚠️ Error al ejecutar: ${e.message}`);
      }
    }
    return { text: texts.join('\n\n') };
  }

  return { text: `⚠️ No encontré la macro "!${sub}". Usá: macro list para ver tus macros.` };
}

// ── T146: Sistema AFK ─────────────────────────────────────────────────────────
/**
 * Comando afk — togglea el modo ausente.
 * Cooldown de 10s entre toggles para evitar spam.
 */
function cmdAfk(player) {
  const now = Date.now();
  const lastToggle = afkCooldowns.get(player.id) || 0;
  if (now - lastToggle < 10_000) {
    const wait = Math.ceil((10_000 - (now - lastToggle)) / 1000);
    return { text: `⚠️ Esperá ${wait}s antes de cambiar el estado AFK de nuevo.` };
  }
  afkCooldowns.set(player.id, now);

  if (afkPlayers.has(player.id)) {
    afkPlayers.delete(player.id);
    return { text: `✅ Ya no estás en modo ausente (AFK). ¡Bienvenido de vuelta, ${player.username}!` };
  } else {
    afkPlayers.add(player.id);
    return { text: `💤 Modo ausente activado (AFK). Todos tus comandos quedarán bloqueados hasta que escribás "afk" de nuevo.` };
  }
}

/**
 * Verificar si un jugador está AFK y cancelarlo automáticamente al entrar en combate.
 * Llamar desde cmdAttack.
 */
function clearAfk(playerId) {
  if (afkPlayers.has(playerId)) {
    afkPlayers.delete(playerId);
    return true; // fue cancelado
  }
  return false;
}

/**
 * Exponer el set AFK para que cmdWho y otros módulos puedan consultarlo.
 */
function isAfk(playerId) {
  return afkPlayers.has(playerId);
}

// ── T147: Mensajes en las paredes / Graffiti ──────────────────────────────────

const WALL_MAX_LEN = 80;

/**
 * Escribe un mensaje en la pared de la sala actual.
 * Uso: write <texto>
 */
function cmdWrite(player, args) {
  if (!args || args.length === 0) {
    return { text: '📝 ¿Qué querés escribir? Usá: write <mensaje>' };
  }
  const msg = args.join(' ').trim();
  if (msg.length < 2) {
    return { text: '✏️ El mensaje es muy corto.' };
  }
  if (msg.length > WALL_MAX_LEN) {
    return { text: `✏️ El mensaje es muy largo (máximo ${WALL_MAX_LEN} caracteres).` };
  }
  db.addWallMessage(player.current_room_id, player.username, msg);
  return {
    text: `✍️ Grabaste en la pared: "${msg}"`,
    event: `✍️ ${player.username} graba algo en la pared.`,
    eventRoomId: player.current_room_id,
  };
}

/**
 * Lee los mensajes escritos en la pared de la sala actual.
 * Uso: read (wall)
 */
function cmdReadWall(player) {
  const msgs = db.getWallMessages(player.current_room_id);
  if (msgs.length === 0) {
    return { text: '📜 Las paredes están vacías. Nadie ha dejado ningún mensaje aquí.' };
  }
  const lines = ['📜 Inscripciones en la pared:'];
  for (const m of msgs) {
    const date = m.created_at ? m.created_at.slice(5, 16).replace('T', ' ') : '';
    lines.push(`  ✍️ ${m.player_name} [${date}]: ${m.message}`);
  }
  return { text: lines.join('\n') };
}

// ── T148: Comando greet/saludar ───────────────────────────────────────────────

// Mapa de saludos recientes: playerId → { targetName, timestamp }
const recentGreetings = new Map();
const GREET_WINDOW_MS = 30_000; // 30 segundos para saludo mutuo

/**
 * Saluda a otro jugador en la sala.
 * Si ambos se saludan mutuamente dentro de 30s, reciben +1 reputación cada uno.
 */
function cmdGreet(player, args, context) {
  if (!args || args.length === 0) {
    return { text: '👋 ¿A quién querés saludar? Usá: saludar <nombre>' };
  }
  const targetName = args[0].toLowerCase();
  const others = db.getPlayersInRoom(player.current_room_id)
    .filter(p => p.id !== player.id);
  const target = others.find(p => p.username.toLowerCase() === targetName);

  if (!target) {
    return { text: `👋 No encontré a "${args[0]}" en esta sala.` };
  }

  const now = Date.now();
  // Verificar si el target saludó al jugador recientemente
  const targetGreeted = recentGreetings.get(target.id);
  const mutualGreet = targetGreeted &&
    targetGreeted.targetName === player.username.toLowerCase() &&
    (now - targetGreeted.timestamp) < GREET_WINDOW_MS;

  // Registrar el saludo del jugador actual
  recentGreetings.set(player.id, { targetName: target.username.toLowerCase(), timestamp: now });

  if (mutualGreet) {
    // Saludo mutuo — bonus de reputación para ambos
    db.addReputation(player.id, 1);
    db.addReputation(target.id, 1);
    recentGreetings.delete(target.id); // Evitar duplicados
    return {
      text: `🤝 ¡Te saludaste con ${target.username}! La interacción cálida les da +1 reputación a ambos.`,
      event: `🤝 ${player.username} y ${target.username} se dan un saludo cordial. ¡+1 reputación para cada uno!`,
      eventRoomId: player.current_room_id,
      targetPlayerId: target.id,
      targetPlayerMsg: `👋 ${player.username} te saluda. ¡Saludo mutuo! +1 reputación para cada uno.`,
      targetEventType: 'greet',
    };
  } else {
    return {
      text: `👋 Saludaste a ${target.username}.`,
      event: `👋 ${player.username} le da la bienvenida a ${target.username}.`,
      eventRoomId: player.current_room_id,
      targetPlayerId: target.id,
      targetPlayerMsg: `👋 ${player.username} te saluda. ¡Respondé con "saludar ${player.username}" en los próximos 30s para un saludo mutuo y +1 reputación!`,
      targetEventType: 'greet',
    };
  }
}

// ── T149: Comando search/registrar — registrar cadáver de monstruo ───────────

// Tabla de loot especial al registrar cadáveres
const SEARCH_LOOT_TABLE = [
  { item: 'monedas de oro',    gold: 5,  prob: 0.25, label: '5 monedas de oro' },
  { item: 'hueso pulido',      prob: 0.20, type: 'item' },
  { item: 'hierba curativa',   prob: 0.15, type: 'item' },
  { item: 'cristal fragmentado', prob: 0.10, type: 'item' },
  { item: 'poción menor',      prob: 0.08, type: 'item' },
  { item: 'veneno concentrado', prob: 0.05, type: 'item' },
  { gold: 12, prob: 0.07, type: 'gold', label: '12 monedas de oro' },
  // resto = nada (~0.10)
];

// Cooldown por cadáver registrado: guardar en memoria (monsterId → lastSearched)
const searchedCorpses = new Map(); // monsterId → playerId que lo registró

/**
 * search/registrar <monstruo> — Registrar el cadáver de un monstruo recién matado.
 * Solo funciona si el monstruo murió en los últimos 2 minutos en esta sala.
 * 30% chance de encontrar loot adicional.
 * Cada cadáver solo puede ser registrado una vez (por cualquier jugador).
 */
function cmdSearch(player, args) {
  player = db.getPlayer(player.id);
  const monsters = db.getMonstersInRoom(player.current_room_id);

  if (monsters.length > 0) {
    return { text: '⚔ Hay criaturas vivas en la sala. Terminá el combate antes de rebuscar cadáveres.' };
  }

  // Buscar cadáveres recientes en la sala
  const corpses = db.getRecentlyDeadMonsters(player.current_room_id, 2);

  if (corpses.length === 0) {
    return { text: '🦴 No hay cadáveres recientes para registrar aquí. (Los monstruos deben haber muerto hace menos de 2 minutos.)' };
  }

  // Si se especifica un monstruo, filtrarlo
  let target = null;
  if (args && args.length > 0) {
    const query = args.join(' ').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    target = corpses.find(m => {
      const mName = m.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      return mName.includes(query) || query.includes(mName);
    });
    if (!target) {
      const list = corpses.map(m => m.name).join(', ');
      return { text: `🦴 No encontré el cadáver de "${args.join(' ')}". Cadáveres disponibles: ${list}` };
    }
  } else if (corpses.length === 1) {
    target = corpses[0];
  } else {
    const list = corpses.map(m => m.name).join(', ');
    return { text: `🦴 Hay varios cadáveres. Especificá cuál registrar: ${list}\nEj: search ${corpses[0].name}` };
  }

  // Verificar si ya fue registrado
  if (searchedCorpses.has(target.id)) {
    const who = searchedCorpses.get(target.id);
    return { text: `🦴 El cadáver del ${target.name} ya fue registrado por ${who}.` };
  }

  // Marcar como registrado
  searchedCorpses.set(target.id, player.username);

  // Tirar la suerte (30% de encontrar algo)
  const roll = Math.random();
  let cumProb = 0;
  let found = null;
  for (const entry of SEARCH_LOOT_TABLE) {
    cumProb += entry.prob;
    if (roll < cumProb) { found = entry; break; }
  }

  if (!found) {
    return {
      text: `🔍 Revisás el cadáver del ${target.name}... No encontrás nada de valor.`,
      event: `🔍 ${player.username} rebusca el cadáver del ${target.name}.`,
      eventRoomId: player.current_room_id,
    };
  }

  // Entregar el hallazgo
  if (found.type === 'gold' || found.gold) {
    const amount = found.gold || 5;
    db.updatePlayer(player.id, { gold: (player.gold || 0) + amount });
    return {
      text: `🔍 Revisás el cadáver del ${target.name}... ¡Encontrás ${found.label || `${amount} monedas`}! (+${amount} oro)`,
      event: `🔍 ${player.username} rebusca el cadáver del ${target.name} y encuentra algo valioso.`,
      eventRoomId: player.current_room_id,
    };
  } else {
    // Ítem: poner en el suelo de la sala
    const room = db.getRoom(player.current_room_id);
    let roomItems = [];
    try { roomItems = JSON.parse(room.items || '[]'); } catch (_) { roomItems = []; }
    roomItems.push(found.item);
    db.updateRoomItems(player.current_room_id, roomItems);
    return {
      text: `🔍 Revisás el cadáver del ${target.name}... ¡Encontrás ${found.item}! Quedó en el suelo.`,
      event: `🔍 ${player.username} rebusca el cadáver del ${target.name} y encuentra algo.`,
      eventRoomId: player.current_room_id,
    };
  }
}

// ─── T150: Comando study/estudiar ────────────────────────────────────────────
// Analiza un monstruo en la sala: debilidades, resistencias, habilidades especiales y estrategia recomendada.
const MONSTER_LORE = {
  'Goblin Merodeador':    { tipo: 'humanoide', debil: ['fuego', 'luz'], resiste: [], nota: 'Objetivo fácil. Usa cualquier hechizo para eliminarlo rápido.' },
  'Esqueleto Guerrero':  { tipo: 'no-muerto', debil: ['luz', 'contundente'], resiste: ['veneno', 'frío'], nota: 'Inmune a veneno. El hechizo de curación puede dañarlo (son no-muertos).' },
  'Rata Gigante':         { tipo: 'bestia', debil: ['fuego', 'veneno'], resiste: [], nota: 'Débil, pero en grupos puede ser peligrosa. Objetivo rápido.' },
  'Espectro del Corredor':{ tipo: 'espectro', debil: ['luz', 'magia'], resiste: ['físico', 'veneno'], nota: 'Casi inmune a ataques físicos. Usa magia o la bola de fuego.' },
  'Gólem de Piedra':      { tipo: 'constructo', debil: ['magia', 'frío'], resiste: ['físico', 'veneno', 'fuego'], nota: 'Muy resistente. El frío puede fracturar su cuerpo de piedra.' },
  'Murciélago Vampiro':   { tipo: 'bestia', debil: ['luz', 'fuego'], resiste: ['frío', 'veneno'], nota: 'Te puede envenenar. Considera llevar antídoto.' },
  'Araña Tejedora':       { tipo: 'bestia', debil: ['fuego', 'luz'], resiste: ['veneno'], nota: '¡Puede enredarte! Tienes 85% de chance de atacar normalmente cada turno.' },
  'Guardia Espectral':    { tipo: 'no-muerto', debil: ['luz', 'sagrado'], resiste: ['veneno', 'frío'], nota: 'Alto ataque. Usa escudo antes de empezar el combate.' },
  'Lich Anciano':         { tipo: 'no-muerto', debil: ['luz', 'sagrado'], resiste: ['veneno', 'frío', 'fuego'], nota: 'PELIGROSO: drena maná. Si eres Mago, ten pociones de maná listas.' },
  'Gólem de Hielo':       { tipo: 'constructo', debil: ['fuego', 'magia'], resiste: ['frío', 'agua'], nota: 'Vulnerable al fuego. La bola de fuego hace el doble de sentido aquí.' },
  'Cazador de Sombras':   { tipo: 'demonio', debil: ['luz', 'sagrado'], resiste: ['oscuridad', 'veneno'], nota: 'Alto daño. Mantén tu defensa alta con el hechizo de escudo.' },
  'Elemental de Fuego':   { tipo: 'elemental', debil: ['agua', 'frío'], resiste: ['fuego', 'veneno'], nota: 'Inmune a fuego. Usa bola de fuego? Mala idea. Usa golpetazo o habilidades físicas.' },
  'Eco Viviente':         { tipo: 'aberración', debil: ['silencio', 'magia'], resiste: ['físico'], nota: 'Puede amplificar sus golpes ×1.8. Liquídalo rápido para evitar que use su habilidad.' },
  'Sombra del Vacío':     { tipo: 'sombra', debil: ['luz', 'magia'], resiste: ['físico', 'frío', 'veneno'], nota: 'Puede cegarme (-DEF). El Pícaro con su esquiva natural (20%) aguanta mejor.' },
  'Goblin de Práctica':   { tipo: 'humanoide', debil: ['todo'], resiste: [], nota: 'Goblin de entrenamiento. No sueltan loot real ni cuentan como kills.' },
};

function cmdStudy(player, args) {
  const targetName = args.join(' ');
  if (!targetName) {
    return { text: '📖 Uso: study <monstruo> / estudiar <monstruo>\nEjemplo: study goblin\nDeberías estar en la misma sala que el monstruo para estudiarlo.' };
  }

  // Buscar monstruo en la sala
  const monster = combat.findMonsterInRoom(player.current_room_id, targetName);
  if (!monster) {
    return { text: `📖 No hay ningún "${targetName}" en esta sala para estudiar.\nUsá look para ver qué hay aquí.` };
  }

  const lore = MONSTER_LORE[monster.name];
  const { MONSTER_SPECIALS } = combat;
  const special = MONSTER_SPECIALS[monster.name];

  const lines = [];
  const W = 48;
  const pad = s => s + ' '.repeat(Math.max(0, W - s.length));
  lines.push(`┌${'─'.repeat(W)}┐`);
  lines.push(`│ 📖 ANÁLISIS: ${monster.name.toUpperCase()}`);
  lines.push(`├${'─'.repeat(W)}┤`);

  // Tipo y stats
  const tipo = lore ? lore.tipo : 'desconocido';
  lines.push(`│  Tipo:     ${tipo}`);
  lines.push(`│  HP:       ${monster.hp}/${monster.max_hp}    ATK: ${monster.attack}`);

  // Habilidades especiales
  if (special) {
    const tipos = { mana_drain: '🌀 Drenaje de maná', web: '🕸 Inmovilización', amplify: '🔊 Amplificación de golpe', blind: '🌑 Ceguera' };
    const tipoNombre = tipos[special.type] || special.type;
    const chances = Math.round(special.chance * 100);
    lines.push(`│  ⚡ Habilidad especial (${chances}%): ${tipoNombre}`);
  }

  // Debilidades y resistencias
  if (lore) {
    if (lore.debil.length > 0) {
      lines.push(`│  💥 Débil vs: ${lore.debil.join(', ')}`);
    }
    if (lore.resiste.length > 0) {
      lines.push(`│  🛡 Resiste: ${lore.resiste.join(', ')}`);
    }
  }

  // Estado actual
  const statusEffects = (() => { try { return JSON.parse(monster.status_effects || 'null'); } catch (_) { return null; } })();
  if (statusEffects && Object.keys(statusEffects).length > 0) {
    const efectos = Object.keys(statusEffects).map(k => k).join(', ');
    lines.push(`│  ☠ Estado actual: ${efectos}`);
  }

  // Nota estratégica
  if (lore && lore.nota) {
    lines.push(`├${'─'.repeat(W)}┤`);
    // Partir la nota en líneas de ~44 chars
    const words = lore.nota.split(' ');
    let line = '│  💡 ';
    for (const word of words) {
      if ((line + word).length > W + 4) {
        lines.push(line);
        line = '│     ' + word + ' ';
      } else {
        line += word + ' ';
      }
    }
    if (line.trim() !== '│') lines.push(line.trimEnd());
  } else {
    lines.push(`│  💡 No hay lore registrado sobre este ser.`);
  }

  lines.push(`└${'─'.repeat(W)}┘`);

  return { text: lines.join('\n') };
}

// ─── T151: Comando dungeon/estado del dungeon ─────────────────────────────────
// Muestra un resumen narrativo del estado actual del dungeon: zonas peligrosas,
// boss vivo/muerto, quest activa, trampas armadas, loot disponible.
function cmdDungeonStatus() {
  try {
    const rawDb = db.raw();

    // Obtener todas las salas
    const rooms = db.getAllRooms();

    // Monstruos vivos (room_id != null)
    const monstersAlive = rawDb.exec('SELECT id, name, room_id, hp, max_hp FROM monsters WHERE room_id IS NOT NULL')[0];
    const monsterRows = monstersAlive ? monstersAlive.values : [];

    // Cuántos ítems en total en el suelo
    let totalItemsOnFloor = 0;
    let roomsWithItems = 0;
    let trapsArmed = 0;
    for (const room of rooms) {
      try {
        const items = JSON.parse(room.items || '[]');
        if (items.length > 0) { totalItemsOnFloor += items.length; roomsWithItems++; }
      } catch (_) {}
      try {
        const trap = JSON.parse(room.trap || 'null');
        if (trap && trap.active) trapsArmed++;
      } catch (_) {}
    }

    // Boss vivo?
    const bossR = rawDb.exec("SELECT id, hp, max_hp, room_id FROM monsters WHERE id = 10")[0];
    const bossRow = bossR ? bossR.values[0] : null;
    const bossAlive = bossRow && bossRow[3] !== null;
    const bossHp = bossRow ? bossRow[1] : 0;
    const bossMaxHp = bossRow ? bossRow[2] : 0;

    // Quest activa (módulo quests)
    let questInfo = 'Ninguna activa';
    try {
      const { getCurrentQuest } = require('./quests.js');
      const q = getCurrentQuest();
      if (q) questInfo = `${q.name} — ${q.description}`;
    } catch (_) {}

    // Evento global activo
    let eventInfo = 'Calma total';
    try {
      const ev = worldEvents.getCurrentEvent();
      if (ev) eventInfo = ev.name;
    } catch (_) {}

    // Construir tabla de zonas peligrosas
    const dangerZones = [];
    for (const row of monsterRows) {
      const [mid, mname, mroomId, mhp, mmaxhp] = row;
      const room = rooms.find(r => r.id === mroomId);
      if (room) dangerZones.push({ roomName: room.name, monsterName: mname, hp: mhp, maxHp: mmaxhp });
    }

    const W = 52;
    const lines = [];
    lines.push(`╔${'═'.repeat(W)}╗`);
    lines.push(`║${'  🗺 ESTADO DEL DUNGEON OF ECHOES'.padEnd(W)}║`);
    lines.push(`╠${'═'.repeat(W)}╣`);

    // Boss
    const bossLine = bossAlive
      ? `  ☠ Boss: VIVO — ${bossHp}/${bossMaxHp} HP (¡PELIGRO!)`
      : `  ☠ Boss: En respawn (el dungeon respira...)`
    ;
    lines.push(`║${bossLine.padEnd(W)}║`);

    // Quest
    lines.push(`║${'  📜 Quest: '.padEnd(4)}${questInfo.slice(0, W - 9).padEnd(W - 4)}║`.slice(0, W + 2));
    lines.push(`║${'  🌍 Evento: ' + eventInfo.slice(0, 38).padEnd(40)}║`);
    lines.push(`║${'  ⚠️  Trampas armadas: ' + trapsArmed + ' de ' + (trapsArmed + (trapsArmed === 0 ? 4 : 0)) + ' posibles'}${' '.repeat(Math.max(0, W - 22))}║`.slice(0, W + 2));
    lines.push(`║${'  💎 Ítems en el suelo: ' + totalItemsOnFloor + ' (en ' + roomsWithItems + ' salas)'}${' '.repeat(Math.max(0, W - 25))}║`.slice(0, W + 2));
    lines.push(`╠${'═'.repeat(W)}╣`);

    if (dangerZones.length === 0) {
      lines.push(`║${'  El dungeon está inusualmente silencioso...'.padEnd(W)}║`);
    } else {
      lines.push(`║${'  ZONAS PELIGROSAS:'.padEnd(W)}║`);
      for (const z of dangerZones.slice(0, 8)) {
        const hpBar = Math.round((z.hp / z.maxHp) * 5);
        const bar = '█'.repeat(hpBar) + '░'.repeat(5 - hpBar);
        const line = `  • ${z.roomName.slice(0, 20)}: ${z.monsterName.slice(0, 15)} [${bar}]`;
        lines.push(`║${line.padEnd(W)}║`);
      }
      if (dangerZones.length > 8) {
        lines.push(`║${'  ... y ' + (dangerZones.length - 8) + ' monstruo(s) más.'.padEnd(W - 8)}║`.slice(0, W + 2));
      }
    }

    lines.push(`╚${'═'.repeat(W)}╝`);
    lines.push(`Tip: usa "look" al entrar a una sala, "study <monstruo>" para analizar enemigos.`);

    return { text: lines.join('\n') };
  } catch (err) {
    return { text: `Error al obtener estado del dungeon: ${err.message}` };
  }
}

/**
 * T155: cmdSession — Mostrar resumen de la sesión actual.
 *
 * Usa los datos de sesión del contexto (sessionDataMap en handlers.js).
 */
function cmdSession(player, context) {
  const sessData = context && context.sessionData;
  if (!sessData) {
    return { text: '📊 No hay datos de sesión disponibles (reconectate para iniciar una nueva sesión).' };
  }

  const elapsedMs = Date.now() - sessData.startTime;
  const elapsedMin = Math.floor(elapsedMs / 60000);
  const elapsedSec = Math.floor((elapsedMs % 60000) / 1000);

  const freshPlayer = db.getPlayer(player.id);
  const xpGained = freshPlayer ? Math.max(0, (freshPlayer.xp || 0) - sessData.xpStart) : 0;
  const goldGained = freshPlayer ? (freshPlayer.gold || 0) - sessData.goldStart : 0;

  const W = 40;
  const lines = [];
  lines.push(`╔${'═'.repeat(W)}╗`);
  lines.push(`║${'  📊 ESTADÍSTICAS DE SESIÓN'.padEnd(W)}║`);
  lines.push(`╠${'═'.repeat(W)}╣`);
  lines.push(`║${'  ⏱ Tiempo conectado:'.padEnd(22)}${`${elapsedMin}m ${elapsedSec}s`.padEnd(W - 22)}║`);
  lines.push(`║${'  ⚔️  Kills en sesión:'.padEnd(22)}${String(sessData.kills).padEnd(W - 22)}║`);
  lines.push(`║${'  ✨ XP ganada:'.padEnd(22)}${('+' + xpGained).padEnd(W - 22)}║`);
  lines.push(`║${'  🪙 Oro ganado:'.padEnd(22)}${((goldGained >= 0 ? '+' : '') + goldGained).padEnd(W - 22)}║`);
  lines.push(`║${'  🎮 Comandos usados:'.padEnd(22)}${String(sessData.commands).padEnd(W - 22)}║`);
  lines.push(`╚${'═'.repeat(W)}╝`);

  return { text: lines.join('\n') };
}

/**
 * T156: cmdSessions — Historial de sesiones del jugador.
 */
function cmdSessions(player) {
  const sessions = db.getPlayerSessions(player.id, 5);
  const fresh = db.getPlayer(player.id);
  const totalMin = (fresh && fresh.playtime_minutes) ? fresh.playtime_minutes : 0;

  if (sessions.length === 0) {
    return { text: '📋 Aún no hay sesiones registradas. ¡Volvé a conectarte para que se guarden!' };
  }

  const toHM = (min) => {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };

  const W = 52;
  const lines = [
    `╔${'═'.repeat(W)}╗`,
    `║${'  📋 HISTORIAL DE SESIONES (últimas 5)'.padEnd(W)}║`,
    `╠${'═'.repeat(W)}╣`,
    `║${'  Fecha            Duración  Kills  XP   Oro  Cmd'.padEnd(W)}║`,
    `╠${'═'.repeat(W)}╣`,
  ];

  sessions.forEach(s => {
    const fecha = (s.start_time || '').substring(0, 16);
    const dur   = toHM(s.duration_min || 0).padEnd(8);
    const kills = String(s.kills || 0).padStart(5);
    const xp    = String(s.xp_gained || 0).padStart(5);
    const gold  = String(s.gold_gained || 0).padStart(5);
    const cmd   = String(s.commands || 0).padStart(4);
    const row   = `  ${fecha}  ${dur} ${kills}  ${xp}  ${gold}  ${cmd}`;
    lines.push(`║${row.padEnd(W)}║`);
  });

  lines.push(`╠${'═'.repeat(W)}╣`);
  lines.push(`║${'  ⏱ Tiempo de juego total: '.padEnd(30)}${toHM(totalMin).padEnd(W - 30)}║`);
  lines.push(`╚${'═'.repeat(W)}╝`);

  return { text: lines.join('\n') };
}

/**
 * T158: cmdScoreTime — Ranking por tiempo de juego total.
 */
function cmdScoreTime() {
  const leaders = db.getLeaderboardByPlaytime(10);
  if (leaders.length === 0) {
    return { text: 'Aún no hay datos de tiempo de juego registrados.' };
  }

  const toHM = (min) => {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };

  const lines = [
    `╔══════════════════════════════════════════════╗`,
    `║   ⏱  RANKING POR TIEMPO DE JUEGO — TOP 10   ║`,
    `╠══════════════════════════════════════════════╣`,
    `║  #   Aventurero        Lv  Tiempo     Kills  ║`,
    `╠══════════════════════════════════════════════╣`,
  ];

  leaders.forEach((p, idx) => {
    const rank  = String(idx + 1).padStart(2, ' ');
    const name  = (p.username || '???').substring(0, 14).padEnd(14, ' ');
    const level = String(p.level || 1).padStart(3, ' ');
    const time  = toHM(p.playtime_minutes || 0).padEnd(9);
    const kills = String(p.kills || 0).padStart(5);
    const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '  ';
    lines.push(`║ ${medal}${rank}  ${name}  ${level}  ${time}  ${kills}  ║`);
  });

  lines.push(`╚══════════════════════════════════════════════╝`);
  return { text: lines.join('\n') };
}

// ─────────────────────────────────────────────────────────────────────────────
// T161: cmdStance — Posturas de combate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * stance [postura] — Ver o cambiar postura de combate.
 */
function cmdStance(player, args) {
  player = db.getPlayer(player.id);
  const input = args && args[0] ? args[0].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '') : null;

  const currentStance = player.stance || 'equilibrado';

  // Sin argumento: mostrar postura actual
  if (!input) {
    const s = STANCES[currentStance] || STANCES.equilibrado;
    const lines = [
      `╔════════════════════════════════════════╗`,
      `║         ⚔  POSTURA DE COMBATE  ⚔       ║`,
      `╠════════════════════════════════════════╣`,
      `║  Postura actual: ${(s.icon + ' ' + currentStance.padEnd(14)).substring(0, 16).padEnd(21)}║`,
      `╠════════════════════════════════════════╣`,
    ];
    for (const [name, data] of Object.entries(STANCES)) {
      const active = name === currentStance ? ' ◄' : '  ';
      lines.push(`║ ${data.icon} ${name.padEnd(12)}  ATK${data.atkMod >= 0 ? '+' : ''}${data.atkMod} DEF${data.defMod >= 0 ? '+' : ''}${data.defMod}${active.padEnd(2)} ║`);
    }
    lines.push(`╠════════════════════════════════════════╣`);
    lines.push(`║ Cambiá con: stance agresivo/defensivo  ║`);
    lines.push(`║            stance equilibrado          ║`);
    lines.push(`╚════════════════════════════════════════╝`);
    return { text: lines.join('\n') };
  }

  // Alias / normalización
  let target = input;
  if (target === 'ofensivo' || target === 'ofensiva' || target === 'agresiva') target = 'agresivo';
  if (target === 'defensiva') target = 'defensivo';
  if (target === 'balanceado' || target === 'normal' || target === 'neutro' || target === 'neutral') target = 'equilibrado';

  if (!STANCES[target]) {
    return { text: `Postura desconocida: "${args[0]}". Las posturas válidas son: agresivo, defensivo, equilibrado.` };
  }

  if (target === currentStance) {
    return { text: `Ya estás en postura ${STANCES[target].icon} ${target}.` };
  }

  db.updatePlayer(player.id, { stance: target });

  const s = STANCES[target];
  return {
    text: `${s.icon} Adoptás la postura **${target}**.\n${s.desc}`,
    event: 'stance_change',
  };
}

module.exports = { execute, getOrCreatePlayer, ROOM_EFFECTS, resolveExpiredAuctions, getTitle, regenMana, SPELL_CATALOG, getClassReminder, cmdBestiary, cmdProfile, cmdJournal, cmdServerStats, cmdTime, cmdEnemies, cmdCompare, cmdReputation, cmdChallenge, clearAfk, isAfk, killStreakMap, sessionExploredRooms, STANCES };

// ─────────────────────────────────────────────────────────────────────────────
// T162: cmdPath — Ruta más corta a una sala (BFS)
// ─────────────────────────────────────────────────────────────────────────────

// Mapeo de dirección interna a texto en español
const DIR_NAMES = {
  north: 'norte', south: 'sur', east: 'este', west: 'oeste',
  up: 'arriba', down: 'abajo',
  norte: 'norte', sur: 'sur', este: 'este', oeste: 'oeste',
  arriba: 'arriba', abajo: 'abajo',
};

/**
 * path/ruta <sala_id | nombre_sala> — Calcular ruta más corta con BFS.
 */
function cmdPath(player, args) {
  player = db.getPlayer(player.id);
  if (!args || args.length === 0) {
    return { text: 'Uso: path <id_sala o nombre>  Ej: path 15  /  path "Catedral Maldita"' };
  }

  const query = args.join(' ').trim().toLowerCase();
  const allRooms = db.getAllRooms();

  // Intentar por ID numérico primero
  let targetRoom = null;
  const asNum = parseInt(query, 10);
  if (!isNaN(asNum)) {
    targetRoom = allRooms.find(r => r.id === asNum);
  }
  // Si no, buscar por nombre (parcial, case-insensitive, sin tildes)
  if (!targetRoom) {
    const norm = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const normQuery = norm(query);
    // Búsqueda exacta primero
    targetRoom = allRooms.find(r => norm(r.name) === normQuery);
    // Luego parcial
    if (!targetRoom) {
      targetRoom = allRooms.find(r => norm(r.name).includes(normQuery));
    }
  }

  if (!targetRoom) {
    return { text: `No encontré ninguna sala llamada "${args.join(' ')}". Usá el ID numérico (1-${allRooms.length}) o parte del nombre.` };
  }

  const startId = player.current_room_id;

  if (targetRoom.id === startId) {
    return { text: `Ya estás en "${targetRoom.name}". No necesitás moverte.` };
  }

  // Construir grafo: roomId → lista de { dir, toId }
  const graph = {};
  for (const room of allRooms) {
    graph[room.id] = [];
    const exits = room.exits || {};
    for (const [dir, dest] of Object.entries(exits)) {
      const destId = typeof dest === 'object' ? dest.room_id : dest;
      if (destId) graph[room.id].push({ dir, toId: destId });
    }
  }

  // BFS
  const queue = [{ id: startId, path: [] }];
  const visited = new Set([startId]);

  let found = null;
  while (queue.length > 0) {
    const { id, path } = queue.shift();
    if (id === targetRoom.id) {
      found = path;
      break;
    }
    for (const edge of (graph[id] || [])) {
      if (!visited.has(edge.toId)) {
        visited.add(edge.toId);
        queue.push({ id: edge.toId, path: [...path, { dir: edge.dir, toId: edge.toId }] });
      }
    }
  }

  if (!found) {
    return { text: `No hay ruta accesible desde tu sala actual hasta "${targetRoom.name}". Puede haber puertas bloqueadas en el camino.` };
  }

  // Construir respuesta
  const lines = [
    `╔═══════════════════════════════════════════════╗`,
    `║  🗺  RUTA HASTA: ${targetRoom.name.substring(0, 26).padEnd(26)} ║`,
    `╠═══════════════════════════════════════════════╣`,
    `║  Distancia: ${String(found.length).padStart(2)} paso${found.length !== 1 ? 's' : ' '}                          ║`,
    `╠═══════════════════════════════════════════════╣`,
  ];

  found.forEach((step, i) => {
    const room = allRooms.find(r => r.id === step.toId);
    const roomName = room ? room.name.substring(0, 22) : `Sala ${step.toId}`;
    const dirText = (DIR_NAMES[step.dir] || step.dir).padEnd(6);
    lines.push(`║  ${String(i + 1).padStart(2)}. move ${dirText}  →  ${roomName.padEnd(22)} ║`);
  });

  lines.push(`╠═══════════════════════════════════════════════╣`);
  const cmdList = found.map(s => `move ${DIR_NAMES[s.dir] || s.dir}`).join('; ');
  // Wrap long command sequence
  if (cmdList.length <= 43) {
    lines.push(`║  Secuencia: ${cmdList.padEnd(34)} ║`);
  } else {
    lines.push(`║  Secuencia rápida (copiá y pegá):             ║`);
    lines.push(`╠═══════════════════════════════════════════════╣`);
    // Split into chunks of ~43 chars
    let rem = cmdList;
    while (rem.length > 0) {
      const chunk = rem.substring(0, 43);
      rem = rem.substring(43);
      lines.push(`║  ${chunk.padEnd(45)} ║`);
    }
  }
  lines.push(`╚═══════════════════════════════════════════════╝`);

  return { text: lines.join('\n') };
}

// ── T163: Apodos ──────────────────────────────────────────────────────────────
// Historial de comandos de sesión en memoria
// cmdHistory necesita acceso a esto; se rellena en execute()
const sessionCommandHistory = new Map(); // playerId → Array<string> (últimos 20)

/**
 * T163 — nick/apodo: setear o ver el apodo del personaje.
 * Sin args muestra el apodo actual; con args lo actualiza.
 */
function cmdNick(player, args) {
  player = db.getPlayer(player.id);

  if (!args || args.length === 0) {
    if (!player.nickname) {
      return { text: `No tenés apodo asignado. Usá "nick <apodo>" para elegir uno (máx 20 chars, sin espacios).\nTu nombre sigue siendo: ${player.username}` };
    }
    const colorInfo = player.name_color ? ` [color: ${player.name_color}]` : '';
    return { text: `Tu apodo actual es: "${player.nickname}"${colorInfo}\nUsá "nick quitar" para eliminarlo, "nick <nuevo>" para cambiarlo, o "nick color <color>" para elegir un color.` };
  }

  const input = args.join(' ').trim();

  if (input === 'quitar' || input === 'borrar' || input === 'clear') {
    db.updatePlayer(player.id, { nickname: null });
    return { text: `Apodo eliminado. Tu nombre de aventurero vuelve a ser "${player.username}".` };
  }

  // T171: subcomando nick color <color>
  if (args[0] && (args[0].toLowerCase() === 'color' || args[0].toLowerCase() === 'colour')) {
    const VALID_COLORS = {
      verde: 'green', green: 'green',
      cian: 'cyan', cyan: 'cyan', celeste: 'cyan',
      amarillo: 'yellow', yellow: 'yellow',
      magenta: 'magenta', violeta: 'magenta', rosa: 'magenta',
      rojo: 'red', red: 'red',
      blanco: 'white', white: 'white',
      quitar: null, ninguno: null, none: null, borrar: null,
    };
    const colorInput = (args[1] || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (colorInput === '' || colorInput === 'quitar' || colorInput === 'ninguno' || colorInput === 'none' || colorInput === 'borrar') {
      db.updatePlayer(player.id, { name_color: null });
      return { text: '🎨 Color de nombre eliminado. Tu nombre aparecerá en el color por defecto.' };
    }
    const color = VALID_COLORS[colorInput];
    if (!color && color !== null) {
      return { text: `Color no reconocido. Opciones: verde, cian, amarillo, magenta, rojo, blanco.\nEj: nick color cian` };
    }
    db.updatePlayer(player.id, { name_color: color });
    const colorNames = { green: 'verde 🟢', cyan: 'cian 🔵', yellow: 'amarillo 🟡', magenta: 'magenta 🟣', red: 'rojo 🔴', white: 'blanco ⬜' };
    return { text: `🎨 Color de nombre actualizado a ${colorNames[color]}. Aparecerá en el chat cuando uses say/shout/emote.` };
  }

  // Validar: máx 20 chars, sin espacios, alfanumérico + guiones/underscores
  const singleWord = args.join('').trim();
  if (singleWord.length > 20) {
    return { text: 'El apodo no puede superar los 20 caracteres.' };
  }
  if (!/^[a-zA-ZáéíóúüñÁÉÍÓÚÜÑ0-9_\-]+$/.test(singleWord)) {
    return { text: 'El apodo solo puede tener letras, números, guiones y underscores (sin espacios).' };
  }

  db.updatePlayer(player.id, { nickname: singleWord });
  return {
    text: `✅ Apodo actualizado a "${singleWord}". Aparecerá en "who", "status" y cuando otros jugadores te vean.\nTu username sigue siendo "${player.username}" para whisper/tell/give/etc.\nTip: usá "nick color <color>" para elegir el color de tu nombre en el chat.`,
  };
}

/**
 * T164 — history/historial: ver los últimos comandos ejecutados en la sesión.
 */
function cmdHistory(player) {
  const hist = sessionCommandHistory.get(player.id) || [];
  if (hist.length === 0) {
    return { text: 'No hay comandos en el historial de esta sesión todavía.' };
  }
  const lines = [
    `╔══════════════════════════════════╗`,
    `║  📜  HISTORIAL DE COMANDOS       ║`,
    `╠══════════════════════════════════╣`,
    ...hist.map((cmd, i) => `║  ${String(hist.length - i).padStart(2)}. ${cmd.padEnd(28)} ║`),
    `╚══════════════════════════════════╝`,
  ];
  return { text: lines.join('\n') };
}

/**
 * T166 — clima/weather: ver el clima actual del dungeon.
 */
function cmdWeather() {
  const w = weather.getCurrentWeather();
  const remainingMs = w.changesInMs;
  const min = Math.floor(remainingMs / 60_000);
  const sec = Math.floor((remainingMs % 60_000) / 1000);
  const remainingStr = min > 0 ? `${min}m ${sec}s` : `${sec}s`;

  const EFFECT_DESC = {
    'monster_damage_plus_1': '⚠️  Los monstruos hacen +1 de daño.',
    'xp_multiplier_1_1':     '🌟 La XP ganada se multiplica ×1.1.',
    'rest_minus_1':          '❄️  Descansar recupera 1 HP menos.',
    'hide_monster_hp':       '👁  HP de monstruos oculto en look.',
    'spore_storm':           '☠️  EXTREMO: Envenenamiento pasivo al moverse.',
    'blizzard':              '🌨️  EXTREMO: Movimiento ralentizado con mensaje.',
    'scorching':             '🔥 EXTREMO: Maná ×2, HP máx efectivo -5.',
    null:                    '✅ Sin efectos especiales.',
  };
  const effectLine = EFFECT_DESC[w.effect] || '✅ Sin efectos especiales.';

  // Descripción cortada a 40 chars por línea
  const desc = w.description;
  const desc1 = desc.substring(0, 40).padEnd(40);
  const desc2 = desc.length > 40 ? desc.substring(40, 80).padEnd(40) : null;

  const lines = [
    `╔══════════════════════════════════════════╗`,
    `║   ${w.emoji} CLIMA DEL DUNGEON                    ║`,
    `╠══════════════════════════════════════════╣`,
    `║  ${w.name.padEnd(40)} ║`,
    `╠══════════════════════════════════════════╣`,
    `║  ${desc1} ║`,
    ...(desc2 ? [`║  ${desc2} ║`] : []),
    `╠══════════════════════════════════════════╣`,
    `║  ${effectLine.padEnd(40)} ║`,
    `╠══════════════════════════════════════════╣`,
    `║  Cambia en: ${remainingStr.padEnd(29)} ║`,
    `╚══════════════════════════════════════════╝`,
  ];

  return { text: lines.join('\n') };
}

// ─── T167: cmdFind ────────────────────────────────────────────────────────────
// Busca dónde encontrar un ítem o monstruo en el dungeon.
function cmdFind(player, args) {
  if (!args || args.length === 0) {
    return { text: 'Uso: find <ítem o monstruo>\nEj: find espada de obsidiana  |  find goblin' };
  }

  const rawQuery = args.join(' ').trim();
  const query = rawQuery.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const W = 50;
  const border = '═'.repeat(W);
  const lines = [];

  const header = `🔍 BUSCANDO: "${rawQuery}"`;
  const headerLine = `║  ${header.substring(0, W - 4).padEnd(W - 4)}  ║`;
  lines.push(`╔${border}╗`, headerLine, `╠${border}╣`);

  const allMonsters = db.getAllMonsters();
  const allRooms = db.getAllRooms();

  // Normalize helper
  const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // ── Buscar como monstruo ───────────────────────────────────────────────────
  const matchMonsters = allMonsters.filter(m => norm(m.name).includes(query));
  if (matchMonsters.length > 0) {
    lines.push(`║  🐉 MONSTRUOS                                    ║`);
    lines.push(`╠${border}╣`);
    for (const m of matchMonsters) {
      // room_id puede estar almacenado como string 'null' (bug histórico) — normalizar
      const roomId = (m.room_id === null || m.room_id === 'null' || m.room_id === undefined) ? null : Number(m.room_id);
      const respId = (m.respawn_room_id === null || m.respawn_room_id === 'null' || m.respawn_room_id === undefined) ? null : Number(m.respawn_room_id);
      const alive = roomId !== null;
      const statusIcon = alive ? '⚔' : '💀';
      let locationInfo;
      if (alive) {
        const room = allRooms.find(r => r.id === roomId);
        locationInfo = room ? `Sala ${roomId}: ${room.name.substring(0, 22)}` : `Sala ${roomId}`;
      } else {
        if (respId !== null) {
          const respRoom = allRooms.find(r => r.id === respId);
          locationInfo = respRoom ? `Reaparece sala ${respId}: ${respRoom.name.substring(0, 14)}` : `Reaparece sala ${respId}`;
        } else {
          locationInfo = 'Zona de entrenamiento';
        }
      }
      const nameLine = `${statusIcon} ${m.name}`;
      lines.push(`║  ${nameLine.substring(0, W - 4).padEnd(W - 4)}  ║`);
      lines.push(`║    📍 ${locationInfo.substring(0, W - 7).padEnd(W - 7)}  ║`);
      lines.push(`║    HP: ${m.max_hp} | ATK: ${m.attack}`.padEnd(W + 1) + '║');
    }
    lines.push(`╠${border}╣`);
  }

  // ── Buscar como ítem en el suelo de las salas ──────────────────────────────
  const roomsWithItem = allRooms.filter(r =>
    Array.isArray(r.items) && r.items.some(i => norm(i).includes(query))
  );

  // ── Buscar como loot de monstruos ──────────────────────────────────────────
  const monstersWithLoot = allMonsters.filter(m =>
    Array.isArray(m.loot) && m.loot.some(i => norm(i).includes(query))
  );

  const foundAnything = matchMonsters.length > 0 || roomsWithItem.length > 0 || monstersWithLoot.length > 0;

  if (roomsWithItem.length > 0) {
    lines.push(`║  💎 EN EL SUELO ACTUALMENTE                      ║`);
    lines.push(`╠${border}╣`);
    for (const room of roomsWithItem) {
      const roomLine = `Sala ${room.id}: ${room.name}`;
      lines.push(`║  📦 ${roomLine.substring(0, W - 6).padEnd(W - 6)}  ║`);
    }
    lines.push(`╠${border}╣`);
  }

  if (monstersWithLoot.length > 0) {
    lines.push(`║  ☠ LOOT DE MONSTRUOS                             ║`);
    lines.push(`╠${border}╣`);
    for (const m of monstersWithLoot) {
      const lootItems = m.loot.filter(i => norm(i).includes(query));
      const roomId = (m.room_id === null || m.room_id === 'null' || m.room_id === undefined) ? null : Number(m.room_id);
      const respId = (m.respawn_room_id === null || m.respawn_room_id === 'null' || m.respawn_room_id === undefined) ? null : Number(m.respawn_room_id);
      const locationId = roomId !== null ? roomId : respId;
      const room = locationId !== null ? allRooms.find(r => r.id === locationId) : null;
      const roomName = room ? room.name.substring(0, 16) : '?';
      const locStr = locationId !== null && locationId !== undefined ? `Sala ${locationId}: ${roomName}` : 'sin sala';
      const mLine = `${m.name} (${locStr})`;
      lines.push(`║  ⚔ ${mLine.substring(0, W - 5).padEnd(W - 5)}  ║`);
      for (const item of lootItems) {
        lines.push(`║    → ${item.substring(0, W - 7).padEnd(W - 7)}  ║`);
      }
    }
    lines.push(`╠${border}╣`);
  }

  if (!foundAnything) {
    lines.push(`║  ❌ No se encontró "${rawQuery.substring(0, W - 23)}".`.padEnd(W + 1) + '║');
    lines.push(`║  (Probá con nombre parcial, sin tildes).`.padEnd(W + 1) + '║');
    lines.push(`╠${border}╣`);
  }

  // Reemplazar último ╠═╣ con ╚═╝
  const last = lines.lastIndexOf(`╠${border}╣`);
  if (last !== -1) lines[last] = `╚${border}╝`;
  else lines.push(`╚${border}╝`);

  return { text: lines.join('\n') };
}

// ─── T170: cmdGuide ───────────────────────────────────────────────────────────
// Guía de inicio rápido dividida en secciones navegables.
function cmdGuide(args) {
  const W = 56;
  const border = '═'.repeat(W);
  const div    = '─'.repeat(W);

  // Secciones disponibles
  const SECTIONS = {
    '1': 'primeros',
    '2': 'combate',
    '3': 'economia',
    '4': 'clases',
    '5': 'crafteo',
    '6': 'tips',
    primeros: 'primeros',
    combate: 'combate',
    economía: 'economia', economia: 'economia',
    clases: 'clases',
    crafteo: 'crafteo',
    tips: 'tips', avanzados: 'tips',
  };

  const section = args && args.length > 0
    ? SECTIONS[(args[0] || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')] || null
    : null;

  function box(title, lines) {
    const header = ` ${title} `;
    const pad = Math.max(0, W - header.length);
    const padL = Math.floor(pad / 2);
    const padR = pad - padL;
    const rows = [];
    rows.push(`╔${border}╗`);
    rows.push(`║${'═'.repeat(padL)}${header}${'═'.repeat(padR)}║`);
    rows.push(`╠${border}╣`);
    for (const line of lines) {
      const text = String(line);
      // Soporte de líneas largas: truncar a W-4 y centrar
      const display = text.length <= W - 2 ? text : text.substring(0, W - 5) + '...';
      rows.push(`║ ${display.padEnd(W - 2)} ║`);
    }
    rows.push(`╚${border}╝`);
    return rows.join('\n');
  }

  if (!section) {
    // Índice
    const indexLines = [
      '📖 GUÍA DEL AVENTURERO — Dungeon of Echoes',
      '',
      'Escribí: guide <número o nombre>',
      '',
      '  1. primeros  — Cómo empezar: look, move, status',
      '  2. combate   — Pelear, huir, habilidades, clases',
      '  3. economia  — Oro, tienda, subastas, duelos',
      '  4. clases    — Guerrero, Mago y Pícaro explicados',
      '  5. crafteo   — Recetas de alquimia disponibles',
      '  6. tips      — Trucos y mecánicas avanzadas',
      '',
      '  Ej: guide 2   |   guide combate',
    ];
    return { text: box('ÍNDICE DE LA GUÍA', indexLines) };
  }

  if (section === 'primeros') {
    const lines = [
      '🧭 PRIMEROS PASOS',
      div,
      'Al conectarte llegarás a la Antesala del Dungeon.',
      'Si es tu primera vez, el tutorial te guiará.',
      '',
      'COMANDOS BÁSICOS:',
      '  look / mirar      — Ver la habitación actual',
      '  move norte        — Moverte (n/s/e/o también sirven)',
      '  status / estado   — Ver HP, XP, nivel, oro',
      '  inventory / inv   — Ver lo que llevás encima',
      '  map / mapa        — Minimapa ASCII del dungeon',
      '',
      'SOBREVIVIR:',
      '  pick <ítem>       — Recoger algo del suelo',
      '  use <poción>      — Usar una poción de salud',
      '  heal              — Atajo rápido para curar',
      '  rest / descansar  — Recuperar HP si no hay monstruos',
      '',
      'COMUNICACIÓN:',
      '  say hola          — Hablar con quienes están en tu sala',
      '  shout hola!       — Gritar para todo el dungeon',
      '  who               — Ver quién está conectado',
    ];
    return { text: box('PRIMEROS PASOS', lines) };
  }

  if (section === 'combate') {
    const lines = [
      '⚔️  SISTEMA DE COMBATE',
      div,
      'attack <monstruo>  — Iniciar combate por turnos',
      'flee / huir        — Escapar (mueve a sala adyacente)',
      '',
      'MECÁNICAS ESPECIALES:',
      '  🎯 Golpe crítico — 10% de chance (×2 daño)',
      '  💨 Esquiva       — 8% de chance (evita daño)',
      '  ☠  Veneno        — Araña/Vampiro pueden envenenarate',
      '  🐾 Huida enemigo — Monstruo con <25% HP puede escapar',
      '',
      'HABILIDADES (al subir niveles):',
      '  smash / golpetazo (Lv3) — ×1.8 daño, CD 45s',
      '  shield_bash (Lv6)       — Stun + daño',
      '  rally / arenga (Lv10)   — +2 ATK a todo el grupo',
      '',
      'POSTURAS (comando stance):',
      '  agresivo  — +2 ATK, -1 DEF, 5% extra de fallo',
      '  defensivo — -1 ATK, +2 DEF',
      '  equilibrado — stats normales (por defecto)',
      '',
      'CLASES AFECTAN el combate — guide 4 para más info.',
    ];
    return { text: box('COMBATE', lines) };
  }

  if (section === 'economia') {
    const lines = [
      '💰 ECONOMÍA Y COMERCIO',
      div,
      'El oro se consigue matando monstruos, recogiendo',
      'monedas del suelo, completando quests y duelos.',
      '',
      'TIENDA (sala 4 — Cámara del Tesoro):',
      '  shop / tienda     — Ver lo que vende Aldric',
      '  buy <ítem>        — Comprar (reputación = descuento)',
      '  sell <ítem>       — Vender ítems (40% del precio)',
      '',
      'SUBASTAS (sala 17 — Casa de Subastas):',
      '  subasta <ítem> <precio>  — Poner algo a remate',
      '  pujar <monto>            — Hacer una oferta',
      '  subastas                 — Ver subastas activas',
      '',
      'TRANSFERENCIAS:',
      '  pay <jugador> <oro>  — Enviar oro directamente',
      '  give <ítem> <jugador>— Regalar un ítem',
      '',
      'REPUTACIÓN da descuentos: Respetado -5%, Famoso -10%,',
      'Legendario -15%. Ver fama para tu nivel actual.',
    ];
    return { text: box('ECONOMÍA', lines) };
  }

  if (section === 'clases') {
    const lines = [
      '🏛  CLASES DE PERSONAJE',
      div,
      'Elegí con: clase guerrero/mago/picaro',
      'Podés cambiar antes de 5 kills. Después es permanente.',
      '',
      '⚔  GUERRERO',
      '  HP: 35 | ATK: 6 | Maná: 10',
      '  Ventaja: más HP y daño base. Ideal para principiantes.',
      '  Consejo: usá stance agresivo para maximizar daño.',
      '',
      '🔮 MAGO',
      '  HP: 22 | ATK: 4 | Maná: 35',
      '  Hechizos ×1.5 de poder. Regen de maná 2× más rápido.',
      '  Hechizos: cast bola-de-fuego / escudo / curación',
      '  Consejo: conservá maná para hechizos de alto impacto.',
      '',
      '🗡  PÍCARO',
      '  HP: 28 | ATK: 5 | Maná: 15',
      '  Golpe crítico 25% (vs. 10% base). Esquiva 20% (vs. 8%).',
      '  Consejo: ideal para grinding solo con alta supervivencia.',
    ];
    return { text: box('CLASES DE PERSONAJE', lines) };
  }

  if (section === 'crafteo') {
    const lines = [
      '⚗️  SISTEMA DE CRAFTEO / ALQUIMIA',
      div,
      'Uso: craft <ítem1> con <ítem2>',
      '     craft <ítem1> + <ítem2>',
      '     recetas  — Ver todas las recetas conocidas',
      '',
      'RECETAS PRINCIPALES:',
      '  veneno + cuchillo       → cuchillo envenenado',
      '  hierba curativa + poción→ poción de vida',
      '  núcleo de forja +',
      '    espada oxidada        → espada de obsidiana',
      '  fragmento de hielo +',
      '    cristal resonante     → lanza espectral',
      '  pergamino + tinta mágica→ pergamino de furia',
      '',
      'NOTA: Los ítems originales se consumen.',
      'NOTA: Craftear avanza el logro secreto "Artesano".',
      '',
      'TIP: Usá forage en salas sin monstruos para conseguir',
      '     materiales de crafteo (hierbas, fragmentos, etc.)',
    ];
    return { text: box('CRAFTEO Y ALQUIMIA', lines) };
  }

  if (section === 'tips') {
    const lines = [
      '💡 TIPS Y MECÁNICAS AVANZADAS',
      div,
      'EXPLORACIÓN:',
      '  path <sala>    — Ruta más corta con BFS automático',
      '  peek <dir>     — Espiar sala sin entrar',
      '  find <cosa>    — Dónde encontrar ítems o monstruos',
      '  recall / volver— Teletransporte a sala 1 (CD 10min)',
      '',
      'COMBATE AVANZADO:',
      '  study <monstruo>— Analizar debilidades y habilidades',
      '  dungeon/overview — Estado general del dungeon',
      '  search          — Registrar cadáveres (30% loot extra)',
      '',
      'SOCIAL:',
      '  guild create/join — Crear o unirse a hermandad',
      '  duel <jugador>    — Retar a duelo (apuestas de oro)',
      '  party <jugador>   — Grupo para compartir XP',
      '  inspect <jugador> — Ver estadísticas de otro jugador',
      '',
      'MISC:',
      '  macro set atk attack goblin — Guardar shortcuts',
      '  !atk — Ejecutar macro "atk" rápidamente',
      '  challenge / desafío — Ver tu misión diaria personal',
      '  news / crónica      — Últimos eventos del dungeon',
    ];
    return { text: box('TIPS AVANZADOS', lines) };
  }

  return { text: 'Sección no encontrada. Escribí "guide" para ver el índice.' };
}

// ─── T173: cmdFriend ──────────────────────────────────────────────────────────
// Sistema de amigos: friend add/remove/list/online
function cmdFriend(player, args) {
  player = db.getPlayer(player.id);
  let friends;
  try { friends = JSON.parse(player.friends || '[]'); } catch (_) { friends = []; }

  const sub = (args && args[0] || '').toLowerCase();

  if (!sub || sub === 'list' || sub === 'lista' || sub === 'ver') {
    if (friends.length === 0) {
      return { text: 'No tenés amigos agregados aún.\nUsá "friend add <jugador>" para agregar alguien.\nUsá "friend list" para ver tu lista.' };
    }
    // Verificar cuáles están online (playerSockets es un Map en handlers)
    const lines = [`╔${'═'.repeat(42)}╗`, `║  👥 TUS AMIGOS${''.padEnd(28)}║`, `╠${'═'.repeat(42)}╣`];
    for (const name of friends) {
      const friendPlayer = db.getPlayerByUsername(name);
      if (!friendPlayer) { lines.push(`║  ✖ ${name} (cuenta eliminada)`.padEnd(43) + '║'); continue; }
      const online = global.playerSocketsMap && global.playerSocketsMap.has(friendPlayer.id);
      const status = online ? '🟢 online' : '⚫ offline';
      lines.push(`║  ${name.padEnd(20)} ${status.padEnd(12)}║`);
    }
    lines.push(`╚${'═'.repeat(42)}╝`);
    return { text: lines.join('\n') };
  }

  if (sub === 'add' || sub === 'agregar' || sub === 'añadir') {
    const targetName = (args[1] || '').trim().toLowerCase();
    if (!targetName) return { text: 'Uso: friend add <nombre del jugador>' };
    if (targetName === player.username.toLowerCase()) return { text: 'No podés agregarte a vos mismo.' };
    const target = db.getPlayerByUsername(targetName);
    if (!target) return { text: `No existe ningún jugador llamado "${targetName}".` };
    if (friends.some(f => f.toLowerCase() === targetName)) {
      return { text: `${target.username} ya está en tu lista de amigos.` };
    }
    friends.push(target.username);
    db.updatePlayer(player.id, { friends: JSON.stringify(friends) });
    return { text: `✅ ${target.username} agregado a tu lista de amigos. Recibirás notificación cuando se conecte.` };
  }

  if (sub === 'remove' || sub === 'remover' || sub === 'eliminar' || sub === 'quitar' || sub === 'borrar') {
    const targetName = (args[1] || '').trim().toLowerCase();
    if (!targetName) return { text: 'Uso: friend remove <nombre del jugador>' };
    const idx = friends.findIndex(f => f.toLowerCase() === targetName);
    if (idx === -1) return { text: `${targetName} no está en tu lista de amigos.` };
    const removed = friends.splice(idx, 1)[0];
    db.updatePlayer(player.id, { friends: JSON.stringify(friends) });
    return { text: `${removed} eliminado de tu lista de amigos.` };
  }

  return { text: 'Subcomandos disponibles: friend list, friend add <jugador>, friend remove <jugador>' };
}

// ─── T177: cmdScoreFriends ────────────────────────────────────────────────────
/**
 * score amigos / score friends — Ranking de kills entre tus amigos.
 * Incluye al propio jugador. Se muestra con indicador "← vos".
 */
function cmdScoreFriends(player) {
  let friends;
  try { friends = JSON.parse(player.friends || '[]'); } catch (_) { friends = []; }

  if (friends.length === 0) {
    return {
      text: '👥 No tenés amigos agregados aún.\n' +
            '   Usá "friend add <jugador>" para agregar alguien.\n' +
            '   Luego "score amigos" mostrará el ranking entre vos y ellos.',
    };
  }

  // Incluir al propio jugador + sus amigos
  const usernames = [player.username, ...friends];
  const players = [];
  for (const uname of usernames) {
    const p = db.getPlayerByUsername(uname);
    if (p) players.push(p);
  }

  if (players.length < 2) {
    return { text: '👥 Ninguno de tus amigos tiene cuenta activa en el dungeon.' };
  }

  // Ordenar por kills desc, luego XP
  players.sort((a, b) => (b.kills || 0) - (a.kills || 0) || (b.xp || 0) - (a.xp || 0));

  const lines = [
    '╔═══════════════════════════════════════════╗',
    '║      👥 RANKING ENTRE TUS AMIGOS 👥       ║',
    '╠═══════════════════════════════════════════╣',
    '║  #  Aventurero         Lv   Kills    XP   ║',
    '╠═══════════════════════════════════════════╣',
  ];

  players.slice(0, 10).forEach((p, idx) => {
    const pos    = String(idx + 1).padStart(2);
    const name   = (p.username || '???').substring(0, 14).padEnd(14);
    const level  = String(p.level || 1).padStart(3);
    const kills  = String(p.kills || 0).padStart(5);
    const xp     = String(p.xp || 0).padStart(6);
    const isMe   = p.id === player.id ? ' ←' : '  ';
    const medal  = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '  ';
    lines.push(`║ ${medal}${pos} ${name}  ${level}  ${kills}  ${xp}${isMe}║`);
  });

  lines.push('╚═══════════════════════════════════════════╝');
  lines.push(`  ${players.length} aventureros (vos + ${friends.length} amigo(s)).`);

  return { text: lines.join('\n') };
}

// ─── T174: cmdWanted ─────────────────────────────────────────────────────────
/**
 * wanted [jugador] — Mostrar bounties activas en formato "SE BUSCA" ASCII art.
 * Sin args: todos. Con arg: solo ese jugador.
 */
function cmdWanted(player, arg) {
  const all = db.getAllActiveBounties();

  // Filtrar si se dio un nombre
  let filtered = all;
  const query = (arg || '').trim().toLowerCase();
  if (query) {
    filtered = all.filter(b => b.target_name.toLowerCase().includes(query));
    if (filtered.length === 0) {
      return { text: `🔍 No hay recompensas activas sobre "${arg}".` };
    }
  } else if (all.length === 0) {
    return { text: '🔍 El dungeon está en paz: no hay aventureros con precio sobre su cabeza.' };
  }

  // Agrupar por objetivo
  const grouped = {};
  for (const b of filtered) {
    const k = b.target_name;
    if (!grouped[k]) grouped[k] = { target: k, total: 0, posters: [] };
    grouped[k].total += b.amount;
    const minLeft = Math.max(0, Math.round((new Date(b.expires_at) - Date.now()) / 60000));
    grouped[k].posters.push({ poster: b.poster_name, amount: b.amount, minLeft });
  }

  const W = 38; // ancho interior
  const sep = '╠' + '═'.repeat(W) + '╣';
  const sepLight = '╟' + '─'.repeat(W) + '╢';
  const lines = [];

  const targetsArr = Object.values(grouped).sort((a, b) => b.total - a.total);

  for (let i = 0; i < targetsArr.length; i++) {
    const g = targetsArr[i];
    if (i === 0) {
      lines.push('╔' + '═'.repeat(W) + '╗');
    } else {
      lines.push(sep);
    }

    const title = ' ⚠ SE BUSCA ⚠ ';
    lines.push('║' + title.padStart(Math.floor((W + title.length) / 2)).padEnd(W) + '║');

    const nameLabel = g.target.length > W - 4 ? g.target.slice(0, W - 4) + '…' : g.target;
    const namePadded = nameLabel.padStart(Math.floor((W + nameLabel.length) / 2)).padEnd(W);
    lines.push('║' + namePadded + '║');

    const rewardLine = `💰 RECOMPENSA TOTAL: ${g.total}g`;
    lines.push('║' + rewardLine.padStart(Math.floor((W + rewardLine.length) / 2)).padEnd(W) + '║');

    lines.push(sepLight);

    for (const p of g.posters) {
      const entry = `  + ${p.poster.padEnd(12)} ${String(p.amount + 'g').padStart(4)}  (${p.minLeft}min)`;
      lines.push(('║' + entry).substring(0, W + 1).padEnd(W + 1) + '║');
    }

    lines.push(sepLight);
    const note = '  Se cobra ganando un duelo.';
    lines.push('║' + note.padEnd(W) + '║');
  }

  lines.push('╚' + '═'.repeat(W) + '╝');
  lines.push(`  ${targetsArr.length} buscado(s). Usá: bounty <jugador> <monto> para poner una.`);

  return { text: lines.join('\n') };
}

// ─── T176: cmdRank ────────────────────────────────────────────────────────────
/**
 * rank <estadística> — Ver tu posición global en una estadística específica.
 * Soporta: kills, gold/oro, xp, level/nivel, rep/reputacion
 */
function cmdRank(player, arg) {
  const stat = (arg || '').trim().toLowerCase();

  const STATS = {
    kills:      { col: 'kills',      label: 'matanzas',          unit: 'kills',  icon: '⚔️' },
    gold:       { col: 'gold',       label: 'riqueza',           unit: 'monedas', icon: '💰' },
    oro:        { col: 'gold',       label: 'riqueza',           unit: 'monedas', icon: '💰' },
    xp:         { col: 'xp',         label: 'experiencia',       unit: 'XP',     icon: '✨' },
    level:      { col: 'level',      label: 'nivel',             unit: 'nivel',  icon: '🎖️' },
    nivel:      { col: 'level',      label: 'nivel',             unit: 'nivel',  icon: '🎖️' },
    rep:        { col: 'reputation', label: 'reputación',        unit: 'pts rep', icon: '🌟' },
    reputacion: { col: 'reputation', label: 'reputación',        unit: 'pts rep', icon: '🌟' },
    reputación: { col: 'reputation', label: 'reputación',        unit: 'pts rep', icon: '🌟' },
    deaths:     { col: 'deaths',     label: 'muertes',           unit: 'muertes', icon: '☠️' },
    muertes:    { col: 'deaths',     label: 'muertes',           unit: 'muertes', icon: '☠️' },
    time:       { col: 'playtime_minutes', label: 'tiempo de juego', unit: 'min', icon: '⏱️' },
    tiempo:     { col: 'playtime_minutes', label: 'tiempo de juego', unit: 'min', icon: '⏱️' },
  };

  const chosen = STATS[stat];
  if (!stat || !chosen) {
    const opts = ['kills', 'gold/oro', 'xp', 'level/nivel', 'rep', 'deaths/muertes', 'time/tiempo'];
    return { text: `Uso: rank <estadística>\nOpciones: ${opts.join(', ')}\nEj: rank kills` };
  }

  const rawDb = db.raw();
  if (!rawDb) return { text: 'Error de base de datos.' };

  // Obtener todos los jugadores ordenados desc por la columna
  const results = rawDb.exec(
    `SELECT id, username, ${chosen.col} FROM players ORDER BY ${chosen.col} DESC, username ASC`
  );
  if (!results.length) return { text: 'No hay datos de jugadores todavía.' };

  const { columns, values } = results[0];
  const rows = values.map(r => Object.fromEntries(columns.map((c, i) => [c, r[i]])));

  const myIdx = rows.findIndex(r => r.id === player.id);
  if (myIdx === -1) return { text: 'No encontré tus datos.' };

  const myVal = rows[myIdx][chosen.col] || 0;
  const myPos = myIdx + 1;
  const total = rows.length;

  const percentile = total > 1 ? Math.round(((total - myPos) / (total - 1)) * 100) : 100;

  const lines = [''];
  lines.push(`${chosen.icon} TU POSICIÓN — ${chosen.label.toUpperCase()}`);
  lines.push('─'.repeat(36));
  lines.push(`  Jugador: ${player.username}`);
  lines.push(`  Posición: #${myPos} de ${total} aventureros`);
  lines.push(`  Valor: ${myVal} ${chosen.unit}`);
  lines.push(`  Percentil: top ${100 - percentile}% del dungeon`);
  lines.push('');

  if (myPos === 1) {
    lines.push('  🏆 ¡Sos el #1 en el dungeon!');
  } else {
    // Jugador que está justo antes en el ranking
    const above = rows[myIdx - 1];
    const aboveVal = above[chosen.col] || 0;
    const diff = aboveVal - myVal;
    lines.push(`  Para superar a ${above.username} (${aboveVal} ${chosen.unit})`);
    lines.push(`  necesitás ${diff} ${chosen.unit} más.`);
  }

  if (myPos < total) {
    const below = rows[myIdx + 1];
    const belowVal = below[chosen.col] || 0;
    const lead = myVal - belowVal;
    lines.push(`  Llevás ${lead} ${chosen.unit} de ventaja sobre ${below.username}.`);
  }

  // Top 3 breve
  lines.push('');
  lines.push('  TOP 3:');
  for (let i = 0; i < Math.min(3, rows.length); i++) {
    const r = rows[i];
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉';
    const marker = r.id === player.id ? ' ← vos' : '';
    lines.push(`  ${medal} ${r.username.padEnd(14)} ${r[chosen.col] || 0} ${chosen.unit}${marker}`);
  }
  if (myPos > 3) {
    lines.push(`  ...`);
    const marker = ' ← vos';
    lines.push(`  #${String(myPos).padEnd(2)} ${player.username.padEnd(14)} ${myVal} ${chosen.unit}${marker}`);
  }
  lines.push('');

  return { text: lines.join('\n') };
}

/**
 * T175: cmdHardcore — Activar/desactivar modo Hardcore.
 * Si el jugador muere en modo hardcore, queda marcado como "caído" (ghost mode).
 * Solo se puede activar antes del primer kill (período de prueba).
 * Los caídos aparecen en el score con ✝.
 */
function cmdHardcore(player, args) {
  player = db.getPlayer(player.id);
  const mode = (args && args[0]) ? args[0].toLowerCase() : '';
  const isHardcore = player.is_hardcore === 1;
  const isFallen   = player.fallen === 1;

  // Ver estado actual (sin args)
  if (!mode || mode === 'estado' || mode === 'status') {
    const lines = [''];
    lines.push(`☠ MODO HARDCORE ☠`);
    lines.push('─'.repeat(34));
    if (isFallen) {
      lines.push(`  Estado: ✝ CAÍDO — modo fantasma activo`);
      lines.push(`  Caíste el ${player.fallen_at ? player.fallen_at.replace('T', ' ').slice(0, 16) : 'fecha desconocida'}`);
      lines.push(`  Solo podés usar comandos pasivos (look, status, who, etc.)`);
      lines.push(`  Tu personaje es la generación ${toRoman(player.hardcore_generation || 1)}`);
    } else if (isHardcore) {
      lines.push(`  Estado: 🔴 HARDCORE ACTIVO`);
      lines.push(`  Si morís, tu personaje queda como ✝ fantasma.`);
      lines.push(`  "hardcore off" para desactivar (solo si tenés 0 kills)`);
    } else {
      lines.push(`  Estado: ⚫ MODO NORMAL`);
      lines.push(`  "hardcore on" para activar (solo si tenés 0 kills)`);
      lines.push(`  Advertencia: una vez activado, no se puede desactivar con kills.`);
    }
    lines.push('');
    return { text: lines.join('\n') };
  }

  // Activar hardcore
  if (mode === 'on' || mode === 'activar' || mode === 'habilitar') {
    if (isFallen) {
      return { text: '✝ Tu personaje ya cayó. No podés reactivar el modo hardcore en un fantasma.' };
    }
    if (isHardcore) {
      return { text: '🔴 El modo Hardcore ya está activo. Cada decisión cuenta.' };
    }
    const kills = player.kills || 0;
    if (kills > 0) {
      return { text: `No podés activar el modo Hardcore después de tu primer kill.\nTenés ${kills} kills — el período de prueba terminó.` };
    }
    db.updatePlayer(player.id, { is_hardcore: 1 });
    return { text: '🔴 MODO HARDCORE ACTIVADO.\n\n  Si morís, tu personaje queda como ✝ fantasma permanente.\n  Solo comandos pasivos estarán disponibles.\n  No hay vuelta atrás... buena suerte, aventurero.' };
  }

  // Desactivar hardcore
  if (mode === 'off' || mode === 'desactivar' || mode === 'deshabilitar') {
    if (isFallen) {
      return { text: '✝ Tu personaje ya cayó. No podés desactivar nada.' };
    }
    if (!isHardcore) {
      return { text: 'El modo Hardcore no está activo.' };
    }
    const kills = player.kills || 0;
    if (kills > 0) {
      return { text: `No podés desactivar el modo Hardcore una vez que empezaste a matar.\nTenés ${kills} kills — comprometiste tu destino.` };
    }
    db.updatePlayer(player.id, { is_hardcore: 0 });
    return { text: '⚫ Modo Hardcore desactivado. Jugás en modo normal.' };
  }

  // T175: Crear nuevo personaje sucesor (tras caída hardcore)
  // Uso: hardcore new  — crea <username> II, III, etc. con is_hardcore=1
  if (mode === 'new' || mode === 'nuevo' || mode === 'sucesor' || mode === 'continuar') {
    if (!isFallen) {
      return { text: '✝ Solo podés crear un sucesor si tu personaje actual cayó en modo Hardcore.' };
    }
    // Calcular siguiente generación
    const nextGen = (player.hardcore_generation || 1) + 1;
    const suffix  = toRoman(nextGen);
    const newUsername = `${player.username.replace(/ [IVXLCDM]+$/, '')} ${suffix}`.trim();

    // Verificar que no exista ya
    const existing = db.getPlayerByUsername(newUsername);
    if (existing) {
      return { text: `Ya existe un personaje llamado "${newUsername}". Si querés continuar, conectate con ese nombre.` };
    }

    // Crear el nuevo personaje sucesor con hardcore activo y generación correcta
    const newPlayer = db.createPlayer(newUsername);
    db.updatePlayer(newPlayer.id, {
      is_hardcore: 1,
      hardcore_generation: nextGen,
      tutorial_step: 1,
      current_room_id: tutorial.TUTORIAL_ROOM_ID,
    });

    const lines = [
      ``,
      `✝ El legado continúa...`,
      `─`.repeat(34),
      `  ${player.username} cayó, pero su linaje persiste.`,
      ``,
      `  ⚔️  Nuevo aventurero creado: ${newUsername}`,
      `  Generación: ${suffix}`,
      `  Modo: 🔴 HARDCORE (activado por herencia)`,
      ``,
      `  Conectate con el nombre "${newUsername}" para comenzar`,
      `  la aventura de tu sucesor.`,
      ``,
    ];
    return { text: lines.join('\n') };
  }

  return { text: 'Uso: hardcore [on/off/new]\nVer estado: hardcore\nCrear sucesor (tras caída): hardcore new' };
}

/**
 * T178: cmdMemorial — Lista de todos los aventureros caídos en modo Hardcore.
 */
function cmdMemorial() {
  const fallen = db.getFallenHardcorePlayers();
  const W = 54;
  const line = '═'.repeat(W);
  const lines = [];
  lines.push(`╔${line}╗`);
  lines.push(`║${'  ✝  MEMORIAL DE LOS CAÍDOS  ✝'.padStart(Math.floor((W + 30) / 2)).padEnd(W)}║`);
  lines.push(`║${'Aventureros perdidos en Modo Hardcore'.padStart(Math.floor((W + 38) / 2)).padEnd(W)}║`);
  lines.push(`╠${line}╣`);

  if (fallen.length === 0) {
    lines.push(`║${''.padEnd(W)}║`);
    lines.push(`║${'  Ningún valiente ha caído todavía.'.padEnd(W)}║`);
    lines.push(`║${'  El Dungeon aguarda su primera víctima...'.padEnd(W)}║`);
    lines.push(`║${''.padEnd(W)}║`);
  } else {
    const header = `  ${'NOMBRE'.padEnd(24)} ${'NIV'.padEnd(5)} ${'KILLS'.padEnd(6)} FECHA`;
    lines.push(`║${header.padEnd(W)}║`);
    lines.push(`╠${'─'.repeat(W)}╣`);
    for (const p of fallen) {
      const gen  = `(${toRoman(p.hardcore_generation || 1)})`;
      const name = `✝ ${p.username} ${gen}`.slice(0, 24).padEnd(24);
      const lv   = String(p.level).padEnd(5);
      const ki   = String(p.kills).padEnd(6);
      const dt   = p.fallen_at ? p.fallen_at.replace('T', ' ').slice(0, 10) : '???';
      const row  = `  ${name} ${lv} ${ki} ${dt}`;
      lines.push(`║${row.padEnd(W)}║`);
      // T201: Mostrar epitafio si existe
      if (p.epitaph) {
        const eRow = `  ↳ "${p.epitaph}"`;
        lines.push(`║${eRow.padEnd(W)}║`);
      }
    }
  }

  lines.push(`╚${line}╝`);
  lines.push(`  (${fallen.length} aventurero${fallen.length !== 1 ? 's' : ''} caído${fallen.length !== 1 ? 's' : ''} en total)`);
  return { text: lines.join('\n') };
}

/** Convertir número a romano (para generaciones I, II, III...) */
function toRoman(n) {
  const vals = [1000,900,500,400,100,90,50,40,10,9,5,4,1];
  const syms = ['M','CM','D','CD','C','XC','L','XL','X','IX','V','IV','I'];
  let result = '';
  for (let i = 0; i < vals.length; i++) {
    while (n >= vals[i]) { result += syms[i]; n -= vals[i]; }
  }
  return result;
}

module.exports = { execute, getOrCreatePlayer, ROOM_EFFECTS, resolveExpiredAuctions, getTitle, regenMana, SPELL_CATALOG, getClassReminder, cmdBestiary, cmdProfile, cmdJournal, cmdServerStats, cmdTime, cmdEnemies, cmdCompare, cmdReputation, cmdChallenge, clearAfk, isAfk, killStreakMap, sessionExploredRooms, STANCES, sessionCommandHistory, cmdWeather, cmdHardcore, toRoman, cmdMemorial };

// ─── T181: Mercado de jugadores ───────────────────────────────────────────────

/**
 * market <subcomando> [args...]
 * Subcomandos: post, list, buy, mine, cancel
 */
function cmdMarket(player, args, context) {
  player = db.getPlayer(player.id);

  if (!args || args.length === 0) {
    return {
      text: [
        '🛒 Mercado de Jugadores',
        '  Comprá y vendé ítems a precio fijo desde cualquier sala.',
        '',
        '  market list              — ver todos los anuncios activos',
        '  market post <ítem> <precio> — publicar un ítem',
        '  market buy <id>          — comprar un anuncio',
        '  market mine              — ver tus anuncios activos',
        '  market cancel <id>       — retirar tu anuncio',
      ].join('\n'),
    };
  }

  const sub = args[0].toLowerCase();

  // ─── list ───────────────────────────────────────────────────────────────────
  if (sub === 'list' || sub === 'listar' || sub === 'ver') {
    const listings = db.getActiveMarketListings();
    if (listings.length === 0) {
      return { text: '🛒 El mercado está vacío.\n\nPublicá algo con: market post <ítem> <precio>' };
    }
    const W = 58;
    const line = '─'.repeat(W);
    const rows = listings.map(l => {
      const timeLeft = formatTimeLeft(l.expires_at);
      const seller = l.seller_name.slice(0, 14).padEnd(14);
      const item   = l.item_name.slice(0, 24).padEnd(24);
      const price  = `${l.price}g`.padStart(6);
      return `  #${String(l.id).padEnd(3)} ${item} ${price}  ${seller}  ⏳${timeLeft}`;
    });
    const hdr = `  #ID  Ítem${''.padEnd(20)} Precio  Vendedor`;
    return {
      text: [
        `╔${line}╗`,
        `║${'  🛒 MERCADO DE JUGADORES'.padEnd(W)}║`,
        `╠${line}╣`,
        `║${hdr.padEnd(W)}║`,
        `╠${line}╣`,
        ...rows.map(r => `║${r.padEnd(W)}║`),
        `╚${line}╝`,
        `  (${listings.length} anuncio${listings.length !== 1 ? 's' : ''} activo${listings.length !== 1 ? 's' : ''})`,
        `  Comprá con: market buy <id>`,
      ].join('\n'),
    };
  }

  // ─── mine ───────────────────────────────────────────────────────────────────
  if (sub === 'mine' || sub === 'mis' || sub === 'mios') {
    const listings = db.getPlayerMarketListings(player.id);
    if (listings.length === 0) {
      return { text: '🛒 No tenés anuncios activos en el mercado.\n\nPublicá algo con: market post <ítem> <precio>' };
    }
    const rows = listings.map(l => `  #${l.id} | ${l.item_name} | ${l.price}g | ⏳${formatTimeLeft(l.expires_at)}`);
    return {
      text: `🛒 Tus anuncios activos:\n\n${rows.join('\n')}\n\nRetirá con: market cancel <id>`,
    };
  }

  // ─── post ────────────────────────────────────────────────────────────────────
  if (sub === 'post' || sub === 'publicar' || sub === 'vender') {
    const rest = args.slice(1);
    if (rest.length < 2) {
      return { text: 'Uso: market post <ítem> <precio>\nEjemplo: market post "espada oxidada" 25' };
    }
    const priceArg = rest[rest.length - 1];
    const price = parseInt(priceArg, 10);
    if (isNaN(price) || price < 1) {
      return { text: `Precio inválido: "${priceArg}". Debe ser un número mayor a 0.` };
    }
    const itemName = rest.slice(0, -1).join(' ').toLowerCase().trim();
    const inventory = player.inventory || [];
    const itemIndex = inventory.findIndex(i => i.toLowerCase() === itemName);
    if (itemIndex === -1) {
      return { text: `No tenés "${itemName}" en el inventario.\nUsá "inventario" para ver tus ítems.` };
    }

    // Verificar que no tenga demasiados anuncios activos
    const myListings = db.getPlayerMarketListings(player.id);
    if (myListings.length >= 5) {
      return { text: `Tenés ${myListings.length} anuncios activos (máx 5). Cancelá uno antes de publicar más.` };
    }

    // Retirar ítem del inventario
    inventory.splice(itemIndex, 1);
    db.updatePlayer(player.id, { inventory: JSON.stringify(inventory) });

    const listing = db.createMarketListing(player.id, player.username, itemName, price);
    return {
      text: `🛒 Anuncio publicado!\n  Ítem: ${itemName}\n  Precio: ${price}g\n  ID: #${listing.id}\n  Expira en: 1 hora\n\nOtros jugadores pueden comprarlo con: market buy ${listing.id}`,
    };
  }

  // ─── buy ─────────────────────────────────────────────────────────────────────
  if (sub === 'buy' || sub === 'comprar') {
    const idArg = args[1];
    const listingId = parseInt(idArg, 10);
    if (!idArg || isNaN(listingId)) {
      return { text: 'Uso: market buy <id>\nEjemplo: market buy 3\n\nUsá "market list" para ver los IDs.' };
    }
    const listing = db.getMarketListing(listingId);
    if (!listing || listing.sold) {
      return { text: `El anuncio #${listingId} no existe o ya fue vendido.\nUsá "market list" para ver los activos.` };
    }
    const now = new Date().toISOString();
    if (listing.expires_at <= now) {
      return { text: `El anuncio #${listingId} ya expiró.` };
    }
    if (listing.seller_id === player.id) {
      return { text: 'No podés comprar tu propio anuncio. Usá "market cancel <id>" para retirarlo.' };
    }
    if ((player.gold || 0) < listing.price) {
      return { text: `No tenés suficiente oro. Necesitás ${listing.price}g y tenés ${player.gold || 0}g.` };
    }

    // Transacción: descontar oro, dar ítem, marcar como vendido
    db.updatePlayer(player.id, { gold: (player.gold || 0) - listing.price });

    // Acreditar al vendedor si existe
    const seller = db.getPlayer(listing.seller_id);
    if (seller) {
      db.updatePlayer(listing.seller_id, { gold: (seller.gold || 0) + listing.price });
    }

    // Dar ítem al comprador
    const inventory = player.inventory || [];
    inventory.push(listing.item_name);
    db.updatePlayer(player.id, { inventory: JSON.stringify(inventory) });

    db.buyMarketItem(listingId, player.username);

    const result = {
      text: `🛒 ¡Compra exitosa!\n  Ítem: ${listing.item_name}\n  Precio pagado: ${listing.price}g\n  Vendedor: ${listing.seller_name}\n\nEl ítem fue agregado a tu inventario.`,
      roomEvent: `🛒 ${player.username} compró "${listing.item_name}" en el mercado.`,
    };

    // Notificar al vendedor si está online
    if (context && context.playerSockets) {
      const sellerSocket = context.playerSockets.get(listing.seller_id);
      if (sellerSocket) {
        sellerSocket.emit('event', {
          type: 'info',
          text: `🛒 ¡${player.username} compró tu "${listing.item_name}" por ${listing.price}g! El oro fue acreditado.`,
        });
      }
    }

    return result;
  }

  // ─── cancel ──────────────────────────────────────────────────────────────────
  if (sub === 'cancel' || sub === 'cancelar' || sub === 'retirar') {
    const idArg = args[1];
    const listingId = parseInt(idArg, 10);
    if (!idArg || isNaN(listingId)) {
      return { text: 'Uso: market cancel <id>\nEjemplo: market cancel 3\n\nUsá "market mine" para ver tus anuncios.' };
    }
    const listing = db.getMarketListing(listingId);
    if (!listing) {
      return { text: `El anuncio #${listingId} no existe.` };
    }
    if (listing.seller_id !== player.id) {
      return { text: `El anuncio #${listingId} no es tuyo.` };
    }
    if (listing.sold) {
      return { text: `El anuncio #${listingId} ya fue vendido o cancelado.` };
    }

    // Devolver el ítem al inventario
    const inventory = player.inventory || [];
    inventory.push(listing.item_name);
    db.updatePlayer(player.id, { inventory: JSON.stringify(inventory) });
    db.cancelMarketListing(listingId);

    return {
      text: `🛒 Anuncio #${listingId} cancelado. "${listing.item_name}" devuelto a tu inventario.`,
    };
  }

  return {
    text: `Subcomando desconocido: "${sub}"\nUsá "market" sin argumentos para ver la ayuda.`,
  };
}

// ─── T182: Gestos sociales rápidos ───────────────────────────────────────────

const GESTURE_TEXTS = {
  bow: [
    'hace una reverencia solemne.',
    'inclina la cabeza respetuosamente.',
    'se inclina en una reverencia profunda.',
  ],
  wave: [
    'saluda con la mano efusivamente.',
    'agita la mano en señal de saludo.',
    'hace señas de saludo desde lejos.',
  ],
  laugh: [
    'ríe a carcajadas.',
    'suelta una risotada estrepitosa.',
    'se carcajea sin poder contenerse.',
  ],
  cry: [
    'llora desconsoladamente.',
    'limpia una lágrima furtiva.',
    'solloza en silencio.',
  ],
  dance: [
    'baila con total descaro en medio del dungeon.',
    'se mueve al ritmo de música imaginaria.',
    'ejecuta unos pasos de baile peculiares.',
  ],
  shrug: [
    'se encoge de hombros con indiferencia.',
    'levanta los hombros como diciendo "qué sé yo".',
    'hace un gesto de "ni idea".',
  ],
  facepalm: [
    'se lleva la mano a la cara con resignación.',
    'cubre su cara con ambas manos.',
    'suspira y sacude la cabeza.',
  ],
  flex: [
    'flexiona los músculos con orgullo.',
    'hace una pose heroica y exagerada.',
    'muestra sus bíceps al mundo.',
  ],
};

function cmdGesture(player, gestureType) {
  player = db.getPlayer(player.id);
  const texts = GESTURE_TEXTS[gestureType];
  if (!texts) return { text: 'Gesto desconocido.' };
  const text = texts[Math.floor(Math.random() * texts.length)];
  const name = player.nickname || player.username;
  return {
    text: `✨ ${name} ${text}`,
    roomEvent: `✨ ${name} ${text}`,
  };
}

// ─── T184: Sistema de altares mágicos ────────────────────────────────────────
// pray/rezar — ofrecer ítems a los altares para obtener buffs temporales.
// Altar 1: Capilla Olvidada (sala 5) — altar de piedra negra
// Altar 2: Santuario Profano (sala 10) — estatua con diez brazos

const ALTAR_ROOMS = new Set([5, 10]);

// Cooldown por jugador para evitar spam: 5 minutos
const altarCooldowns = new Map();

// Buffs del altar (en memoria, como los pergaminos)
// Se guardan en active_scrolls para reutilizar la misma infraestructura
const ALTAR_OFFERINGS = {
  // Ofrenda: ítems comunes → bendición menor (+2 ATK por 3 min)
  'monedas de cobre':  { type: 'minor', atk: 2, def: 0, duration: 180, label: 'Bendición Menor', msg: 'Las monedas de cobre tintinean en el altar. Una luz tenue te bendice brevemente.' },
  'monedas de plata':  { type: 'minor', atk: 2, def: 1, duration: 180, label: 'Bendición Menor de Plata', msg: 'Las monedas de plata brillan y el altar pulsa con energía tenue.' },
  'monedas de oro':    { type: 'major', atk: 3, def: 2, duration: 300, label: 'Bendición Mayor de Oro', msg: '¡El altar resplandece con luz dorada! Tu cuerpo se llena de un calor poderoso.' },
  'poción de salud':   { type: 'minor', atk: 0, def: 0, duration: 0, hp: 20, label: 'Gracia Curativa', msg: 'La poción se evapora en el altar. El espíritu del dungeon te devuelve la energía.' },
  'poción menor':      { type: 'minor', atk: 0, def: 0, duration: 0, hp: 12, label: 'Gracia Curativa Leve', msg: 'La poción desaparece. Sentís un suave calor en el pecho. (+12 HP)' },
  'libro viejo':       { type: 'arcane', atk: 1, def: 0, mana: 10, duration: 240, label: 'Toque Arcano', msg: 'Las páginas del libro se queman con llamas azules. El altar absorbe su conocimiento.' },
  'amuleto oscuro':    { type: 'dark', atk: 4, def: -1, duration: 300, label: 'Maldición Invertida', msg: '¡El amuleto explota en polvo negro! El altar absorbe la maldición y te la refleja como poder oscuro.' },
  'cristal mágico':    { type: 'arcane', atk: 3, def: 1, mana: 15, duration: 360, label: 'Resonancia Cristalina', msg: '¡El cristal resuena con el altar! Una onda mágica te recorre de pies a cabeza.' },
  'corona rota':       { type: 'royal', atk: 2, def: 3, duration: 300, label: 'Majestad Caída', msg: 'La corona rota se funde en la piedra del altar. Su antiguo poder de mando te rodea como una armadura invisible.' },
  'antídoto':          { type: 'purify', atk: 0, def: 2, duration: 180, label: 'Purificación', msg: 'El antídoto purifica el altar. Una brisa limpia te envuelve, fortaleciendo tus defensas.' },
  'hierba curativa':   { type: 'purify', atk: 0, def: 1, hp: 8, duration: 180, label: 'Bendición Herbal', msg: 'Las hierbas se reducen a ceniza fragante. El altar te bendice con salud y resistencia.' },
};

function cmdPray(player, args) {
  player = db.getPlayer(player.id);

  const roomId = player.current_room_id;
  if (!ALTAR_ROOMS.has(roomId)) {
    const altarHint = roomId === 5 ? '' : '';
    return { text: '🙏 No hay ningún altar aquí para rezar.\n  Los altares se encuentran en la Capilla Olvidada (sala 5) y el Santuario Profano (sala 10).' };
  }

  // Verificar cooldown
  const lastPray = altarCooldowns.get(player.id) || 0;
  const COOLDOWN_MS = 5 * 60 * 1000;
  const elapsed = Date.now() - lastPray;
  if (elapsed < COOLDOWN_MS) {
    const remainingSec = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
    const remMin = Math.floor(remainingSec / 60);
    const remSec = remainingSec % 60;
    return { text: `🙏 El altar aún necesita recuperarse de tu última ofrenda. Espera ${remMin}m ${remSec}s.` };
  }

  // Identificar el ítem ofrecido
  const offering = args.join(' ').trim().toLowerCase();

  if (!offering) {
    const altarName = roomId === 5 ? 'Altar de la Capilla' : 'Estatua del Santuario';
    const lines = [
      `┌────────────────────────────────────────────┐`,
      `│ 🙏 ${altarName.padEnd(42)} │`,
      `├────────────────────────────────────────────┤`,
      `│ Podés ofrecer ítems al altar para obtener  │`,
      `│ bendiciones temporales.                    │`,
      `│                                            │`,
      `│ Uso: pray <ítem>  /  rezar <ítem>          │`,
      `│ Ejemplo: pray monedas de oro               │`,
      `│                                            │`,
      `│ Ítems aceptados:                           │`,
      `│  • monedas (cobre/plata/oro) → ATK buff    │`,
      `│  • pociones → HP extra                     │`,
      `│  • cristal mágico / libro viejo → mana     │`,
      `│  • amuleto oscuro → poder oscuro           │`,
      `│  • corona rota, hierba curativa, antídoto  │`,
      `│                                            │`,
      `│ Cooldown: 5 minutos entre ofrendas.        │`,
      `└────────────────────────────────────────────┘`,
    ];
    return { text: lines.join('\n') };
  }

  // Buscar el ítem en el inventario
  const found = items.findItem(player.inventory, offering);
  if (!found) {
    return { text: `🙏 No tenés ningún "${offering}" en el inventario para ofrecer.` };
  }

  // Verificar si el ítem tiene efecto en el altar
  const foundLower = found.toLowerCase();
  const effect = ALTAR_OFFERINGS[foundLower];
  if (!effect) {
    return { text: `🙏 Ponés ${found} en el altar... pero nada ocurre. Parece que el altar no acepta este tipo de ofrenda.\n  (El ítem no se consume.)` };
  }

  // Consumir el ítem del inventario
  const newInv = [...player.inventory];
  const idx = newInv.findIndex(i => i.toLowerCase() === foundLower);
  if (idx !== -1) newInv.splice(idx, 1);

  const updates = { inventory: newInv };
  const resultLines = [effect.msg];

  // Aplicar efecto HP inmediato
  if (effect.hp && effect.hp > 0) {
    const newHp = Math.min(player.max_hp, player.hp + effect.hp);
    updates.hp = newHp;
    resultLines.push(`❤️  HP: ${player.hp} → ${newHp}/${player.max_hp}`);
  }

  // Aplicar buff de mana inmediato
  if (effect.mana && effect.mana > 0) {
    const maxMana = player.max_mana || 20;
    const newMana = Math.min(maxMana, (player.mana || 0) + effect.mana);
    updates.mana = newMana;
    resultLines.push(`💧 Maná: +${effect.mana} → ${newMana}/${maxMana}`);
  }

  // Aplicar buff temporal de ATK/DEF (guardado en active_scrolls)
  if (effect.duration > 0 && (effect.atk || effect.def)) {
    const scrolls = JSON.parse(player.active_scrolls || '{}');
    const now = Date.now();
    scrolls['altar_blessing'] = {
      atk_bonus: effect.atk || 0,
      def_bonus: effect.def || 0,
      expires_at: now + effect.duration * 1000,
      label: effect.label,
    };
    updates.active_scrolls = JSON.stringify(scrolls);
    const parts = [];
    if (effect.atk > 0) parts.push(`+${effect.atk} ATK`);
    if (effect.atk < 0) parts.push(`${effect.atk} ATK`);
    if (effect.def > 0) parts.push(`+${effect.def} DEF`);
    if (effect.def < 0) parts.push(`${effect.def} DEF`);
    resultLines.push(`⚡ ${effect.label}: ${parts.join(', ')} por ${effect.duration}s`);
  }

  db.updatePlayer(player.id, updates);
  altarCooldowns.set(player.id, Date.now());

  const altarName = roomId === 5 ? 'Capilla Olvidada' : 'Santuario Profano';
  return {
    text: `🙏 Ofrecés ${found} al altar de la ${altarName}.\n\n${resultLines.join('\n')}`,
    event: `${player.username} reza ante el altar.`,
    eventRoomId: roomId,
  };
}

// ─── T185: preview/probar <arma/armadura> — previsualizar stats sin equipar ──
function cmdPreview(player, args) {
  player = db.getPlayer(player.id);
  const query = args.join(' ').trim();

  if (!query) {
    return { text: '🔍 Uso: preview <arma o armadura>\n  Ejemplo: preview espada de obsidiana\n  Muestra cómo cambiarían tus stats si equiparas ese ítem.' };
  }

  const found = items.findItem(player.inventory, query);
  if (!found) {
    return { text: `🔍 No tenés ningún "${query}" en el inventario.` };
  }

  const def = items.getItemDef(found);
  if (!def || (def.type !== 'weapon' && def.type !== 'armor')) {
    return { text: `🔍 ${found} no es un arma ni armadura que puedas equipar.\n  Tipo: ${def ? def.type : 'desconocido'}` };
  }

  const W = 46;
  const pad = (s, w) => { const str = String(s); return str + ' '.repeat(Math.max(0, w - str.length)); };
  const center = (s) => { const sp = Math.max(0, W - s.length); const l = Math.floor(sp/2); const r = sp - l; return ' '.repeat(l) + s + ' '.repeat(r); };

  const lines = [];
  lines.push(`┌${'─'.repeat(W)}┐`);
  lines.push(`│ ${center('🔍 PREVISUALIZACIÓN: ' + found.toUpperCase())} │`);
  lines.push(`├${'─'.repeat(W)}┤`);

  if (def.type === 'weapon') {
    const currentAtk = player.attack;
    const newAtk = 5 + def.amount;
    const change = newAtk - currentAtk;
    const changeStr = change >= 0 ? `+${change}` : `${change}`;
    const currentWeapon = player.equipped_weapon || '(puños)';
    lines.push(`│ ${pad('Arma actual:', 20)} ${pad(currentWeapon, W - 22)} │`);
    lines.push(`│ ${pad('Nueva arma:', 20)} ${pad(found, W - 22)} │`);
    lines.push(`├${'─'.repeat(W)}┤`);
    lines.push(`│ ${pad('ATK actual:', 20)} ${pad(String(currentAtk), W - 22)} │`);
    lines.push(`│ ${pad('ATK nuevo:', 20)} ${pad(`${newAtk} (${changeStr})`, W - 22)} │`);
    lines.push(`├${'─'.repeat(W)}┤`);
    lines.push(`│ ${def.description.length > W - 2 ? def.description.slice(0, W - 5) + '...' : pad(def.description, W - 2)} │`);
    lines.push(`├${'─'.repeat(W)}┤`);
    if (change > 0) {
      lines.push(`│ ${pad('✅ Mejora de ' + change + ' puntos de ataque.', W)} │`);
    } else if (change < 0) {
      lines.push(`│ ${pad('⚠️  Bajaría ' + Math.abs(change) + ' puntos de ataque.', W)} │`);
    } else {
      lines.push(`│ ${pad('➖ Sin cambio en el ataque.', W)} │`);
    }
    lines.push(`│ ${pad('Para equipar: equip ' + found, W)} │`);
  } else if (def.type === 'armor') {
    const currentDef = player.defense;
    const newDef = 2 + def.amount;
    const change = newDef - currentDef;
    const changeStr = change >= 0 ? `+${change}` : `${change}`;
    const currentArmor = player.equipped_armor || '(sin armadura)';
    lines.push(`│ ${pad('Armadura actual:', 20)} ${pad(currentArmor, W - 22)} │`);
    lines.push(`│ ${pad('Nueva armadura:', 20)} ${pad(found, W - 22)} │`);
    lines.push(`├${'─'.repeat(W)}┤`);
    lines.push(`│ ${pad('DEF actual:', 20)} ${pad(String(currentDef), W - 22)} │`);
    lines.push(`│ ${pad('DEF nueva:', 20)} ${pad(`${newDef} (${changeStr})`, W - 22)} │`);
    lines.push(`├${'─'.repeat(W)}┤`);
    lines.push(`│ ${def.description.length > W - 2 ? def.description.slice(0, W - 5) + '...' : pad(def.description, W - 2)} │`);
    lines.push(`├${'─'.repeat(W)}┤`);
    if (change > 0) {
      lines.push(`│ ${pad('✅ Mejora de ' + change + ' puntos de defensa.', W)} │`);
    } else if (change < 0) {
      lines.push(`│ ${pad('⚠️  Bajaría ' + Math.abs(change) + ' puntos de defensa.', W)} │`);
    } else {
      lines.push(`│ ${pad('➖ Sin cambio en la defensa.', W)} │`);
    }
    lines.push(`│ ${pad('Para ponerte: wear ' + found, W)} │`);
  }

  lines.push(`└${'─'.repeat(W)}┘`);

  return { text: lines.join('\n') };
}

// ─── T186: Recolección pasiva de hierbas al descansar ────────────────────────
// En el Túnel de los Hongos (sala 6), al descansar exitosamente,
// 40% de chance de encontrar una hierba curativa adicional.
// (bonus por contexto ambiental, sin cooldown extra)

const FORAGE_REST_ROOMS = {
  6:  { item: 'hierba curativa', chance: 0.40, msg: '🌿 Mientras descansás, notás unas hierbas curativas creciendo entre los hongos. Las recogés.' },
  11: { item: 'hongo azul', chance: 0.30, msg: '🔵 El aire frío de la galería conserva unos hongos azules en perfectas condiciones. Los guardás.' },
  14: { item: 'fragmento de roca volcánica', chance: 0.25, msg: '🪨 El calor de la forja ha cristalizado unos fragmentos minerales. Te los llevás.' },
};

// ─── T187: calendar/eventos — panel de temporizadores del dungeon ──────────────
function cmdCalendar(player) {
  player = db.getPlayer(player.id);
  const now = Date.now();
  const W = 52;
  const pad = (s, w) => { const str = String(s); return str + ' '.repeat(Math.max(0, w - str.length)); };
  const fmt = (ms) => {
    const secs = Math.ceil(ms / 1000);
    if (secs <= 0) return '¡ya disponible!';
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    if (m > 0) return `${m}min ${s}s`;
    return `${s}s`;
  };

  const lines = [];
  lines.push(`╔${'═'.repeat(W)}╗`);
  lines.push(`║${('⏳ PANEL DE TEMPORIZADORES DEL DUNGEON').padStart(Math.floor((W + 38) / 2)).padEnd(W)}║`);
  lines.push(`╠${'═'.repeat(W)}╣`);

  // ── Boss: Lich Anciano (monstruo ID 13) ──────────────────────────────────
  lines.push(`║ ${'👑 BOSS'.padEnd(W - 2)} ║`);
  const allMonsters = db.getAllMonsters();
  const lich = allMonsters.find(m => m.id === 13);
  if (lich) {
    if (lich.room_id !== null) {
      const lichHpPct = Math.round((lich.hp / lich.max_hp) * 100);
      lines.push(`║  ${'Lich Anciano'.padEnd(20)} ${'⚔ VIVO'.padEnd(14)} HP: ${lichHpPct}%`.padEnd(W + 1) + '║');
    } else if (lich.respawn_at) {
      const respawnMs = new Date(lich.respawn_at).getTime() - now;
      lines.push(`║  ${'Lich Anciano'.padEnd(20)} ${'💤 en respawn'.padEnd(14)} en: ${fmt(respawnMs)}`.padEnd(W + 1) + '║');
    } else {
      lines.push(`║  ${'Lich Anciano'.padEnd(20)} ${'❓ estado desconocido'.padEnd(30)}`.padEnd(W + 1) + '║');
    }
  }

  // ── Clima ────────────────────────────────────────────────────────────────
  lines.push(`╠${'═'.repeat(W)}╣`);
  lines.push(`║ ${'🌦 CLIMA ACTUAL'.padEnd(W - 2)} ║`);
  const wState = weather.getCurrentWeather();
  const weatherRemMs = Math.max(0, wState.changesAt - now);
  lines.push(`║  ${pad(wState.name, 28)} cambia en: ${fmt(weatherRemMs)}`.padEnd(W + 1) + '║');
  if (wState.effect && wState.effect !== 'none') {
    lines.push(`║  ${('Efecto: ' + (wState.description || wState.effect)).slice(0, W - 3)}`.padEnd(W + 1) + '║');
  }

  // ── Fuente de rejuvenecimiento ───────────────────────────────────────────
  lines.push(`╠${'═'.repeat(W)}╣`);
  lines.push(`║ ${'💧 FUENTE ETERNA (sala 18)'.padEnd(W - 2)} ║`);
  if (fountainCooldownUntil > now) {
    const remMs = fountainCooldownUntil - now;
    lines.push(`║  ${'Estado: En recarga'.padEnd(28)} disponible en: ${fmt(remMs)}`.padEnd(W + 1) + '║');
  } else {
    lines.push(`║  ${'Estado: ✅ Disponible — HP completo para quien beba'}`.padEnd(W + 1) + '║');
  }

  // ── Buffs activos del jugador ────────────────────────────────────────────
  lines.push(`╠${'═'.repeat(W)}╣`);
  lines.push(`║ ${'✨ TUS BUFFS ACTIVOS'.padEnd(W - 2)} ║`);
  const scrolls = JSON.parse(player.active_scrolls || '{}');
  const scrollEntries = Object.entries(scrolls).filter(([, v]) => {
    const exp = new Date(v.expires_at).getTime();
    return exp > now;
  });
  if (scrollEntries.length === 0) {
    lines.push(`║  ${'(sin buffs activos)'.padEnd(W - 3)} ║`);
  } else {
    for (const [key, val] of scrollEntries) {
      const remMs = new Date(val.expires_at).getTime() - now;
      const atkStr = val.atk_bonus ? `+${val.atk_bonus}ATK` : '';
      const defStr = val.def_bonus ? `+${val.def_bonus}DEF` : '';
      const statStr = [atkStr, defStr].filter(Boolean).join(' ') || '?';
      const name = key.replace('_', ' ');
      lines.push(`║  ${pad(name, 22)} ${pad(statStr, 10)} expira en: ${fmt(remMs)}`.padEnd(W + 1) + '║');
    }
  }

  // ── Trampas del dungeon ──────────────────────────────────────────────────
  lines.push(`╠${'═'.repeat(W)}╣`);
  lines.push(`║ ${'⚠️  TRAMPAS DEL DUNGEON'.padEnd(W - 2)} ║`);
  const allRooms = db.getAllRooms();
  const trappedRooms = allRooms.filter(r => r.trap);
  let trapCount = 0;
  for (const room of trappedRooms) {
    const trap = room.trap;
    if (!trap || typeof trap !== 'object') continue;
    trapCount++;
    if (trap.active) {
      lines.push(`║  ${pad('⚠ ' + (room.name || 'Sala ' + room.id), 30)} ${'[ARMADA]'.padEnd(W - 33)}║`);
    } else if (trap.respawn_at) {
      const remMs = new Date(trap.respawn_at).getTime() - now;
      lines.push(`║  ${pad('○ ' + (room.name || 'Sala ' + room.id), 30)} ${pad('se rearma en ' + fmt(remMs), W - 33)}║`);
    }
    if (trapCount >= 6) { lines.push(`║  ${'(y más...)'.padEnd(W - 3)} ║`); break; }
  }
  if (trapCount === 0) {
    lines.push(`║  ${'Todas las trampas están desactivadas'.padEnd(W - 3)} ║`);
  }

  lines.push(`╚${'═'.repeat(W)}╝`);
  return { text: lines.join('\n') };
}

// ─── T188: bulletin/tablón — tablón global de anuncios ───────────────────────
function cmdBulletin(player, args, context) {
  player = db.getPlayer(player.id);
  const sub = (args[0] || '').toLowerCase();
  const W = 52;
  const pad = (s, w) => { const str = String(s); return str + ' '.repeat(Math.max(0, w - str.length)); };

  // ── bulletin post <mensaje> ──────────────────────────────────────────────
  if (sub === 'post' || sub === 'publicar' || sub === 'nuevo' || sub === 'add') {
    const msg = args.slice(1).join(' ').trim();
    if (!msg) return { text: '📋 Uso: bulletin post <mensaje> (máx 100 chars)' };
    if (msg.length > 100) return { text: `📋 El mensaje es muy largo (${msg.length}/100 chars).` };
    // Verificar límite: máx 3 posts activos por jugador
    const myPosts = db.getPlayerBulletinPosts(player.id);
    if (myPosts.length >= 3) {
      return { text: '📋 Ya tenés 3 anuncios activos. Eliminá uno con `bulletin del <id>` antes de publicar otro.' };
    }
    db.addBulletinPost(player.id, player.username, msg);
    // Broadcast global
    return {
      text: `📋 Anuncio publicado! Expira en 6 horas.\n   "${msg}"`,
      globalEvent: `📋 [TABLÓN] ${player.username}: ${msg}`,
    };
  }

  // ── bulletin del/borrar <id> ─────────────────────────────────────────────
  if (sub === 'del' || sub === 'borrar' || sub === 'cancel' || sub === 'cancelar') {
    const id = parseInt(args[1]);
    if (isNaN(id)) return { text: '📋 Uso: bulletin del <id>' };
    const result = db.deleteBulletinPost(id, player.id);
    if (result === false) return { text: `📋 No existe ningún anuncio con id ${id}.` };
    if (result === 'unauthorized') return { text: '📋 Solo podés borrar tus propios anuncios.' };
    return { text: `📋 Anuncio #${id} eliminado.` };
  }

  // ── bulletin list / sin args — listar posts ──────────────────────────────
  const posts = db.getBulletinPosts(10);
  const lines = [];
  lines.push(`╔${'═'.repeat(W)}╗`);
  lines.push(`║${'📋 TABLÓN GLOBAL DE ANUNCIOS'.padStart(Math.floor((W + 28) / 2)).padEnd(W)}║`);
  lines.push(`╠${'═'.repeat(W)}╣`);
  if (posts.length === 0) {
    lines.push(`║  ${'(sin anuncios activos)'.padEnd(W - 3)} ║`);
  } else {
    for (const post of posts) {
      const ts = post.created_at ? post.created_at.slice(5, 16).replace('T', ' ') : '??';
      const header = `#${post.id} ${post.author_name} [${ts}]`;
      lines.push(`║ ${pad(header, W - 2)} ║`);
      // Partir mensaje largo en líneas de W-4 chars
      const msgChunks = [];
      for (let i = 0; i < post.message.length; i += W - 5) {
        msgChunks.push(post.message.slice(i, i + W - 5));
      }
      for (const chunk of msgChunks) {
        lines.push(`║   ${pad(chunk, W - 4)} ║`);
      }
      lines.push(`╟${'─'.repeat(W)}╢`);
    }
    lines.pop(); // quitar el último separador
  }
  lines.push(`╠${'═'.repeat(W)}╣`);
  lines.push(`║  ${'bulletin post <msg>  — publicar (máx 100 chars, 6h)'.padEnd(W - 3)} ║`);
  lines.push(`║  ${'bulletin del <id>    — borrar tu anuncio'.padEnd(W - 3)} ║`);
  lines.push(`╚${'═'.repeat(W)}╝`);
  return { text: lines.join('\n') };
}

module.exports = { execute, getOrCreatePlayer, ROOM_EFFECTS, resolveExpiredAuctions, getTitle, regenMana, SPELL_CATALOG, getClassReminder, cmdBestiary, cmdProfile, cmdJournal, cmdServerStats, cmdTime, cmdEnemies, cmdCompare, cmdReputation, cmdChallenge, clearAfk, isAfk, killStreakMap, sessionExploredRooms, STANCES, sessionCommandHistory, cmdWeather, cmdHardcore, toRoman, cmdMemorial, cmdCalendar, FORAGE_REST_ROOMS };

// ─── T190: Encantamiento de armas con runas ─────────────────────────────────
/**
 * T190: enchant <tipo_runa> — Consumir 1 runa para encantar el arma equipada.
 * Efectos por tipo:
 *   fuego  → +2 ATK por 3 minutos
 *   hielo  → 20% chance de ralentizar monstruo (skip turno) por 3 minutos
 *   sombra → +15% crit adicional por 3 minutos
 *   luz    → +3 HP al matar por 3 minutos
 *   caos   → efecto aleatorio entre los anteriores
 */
function cmdEnchant(player, args) {
  const RUNE_TYPES = ['fuego', 'hielo', 'sombra', 'luz', 'caos'];
  const RUNE_EMOJIS = { fuego: '🔥', hielo: '❄️', sombra: '🌑', luz: '✨', caos: '🌀' };

  if (!args || args.length === 0) {
    const lines = [
      '',
      '╔══════════════════════════════════════════════╗',
      '║  🪄 ENCANTAMIENTO DE ARMAS CON RUNAS         ║',
      '╟──────────────────────────────────────────────╢',
      '║  Consumí 1 runa para encantar tu arma (3min) ║',
      '║                                              ║',
      '║  🔥 fuego  → +2 ATK durante el encantamiento ║',
      '║  ❄️ hielo  → 20% skip turno del monstruo     ║',
      '║  🌑 sombra → +15% chance de crítico extra    ║',
      '║  ✨ luz    → +3 HP al matar monstruo          ║',
      '║  🌀 caos   → efecto aleatorio de los 4 arriba║',
      '╟──────────────────────────────────────────────╢',
      '║  Uso: enchant <tipo>  /  encantar <tipo>     ║',
      '║  Ej:  enchant fuego  |  encantar sombra      ║',
      '╚══════════════════════════════════════════════╝',
    ];
    return { text: lines.join('\n') };
  }

  const freshP = db.getPlayer(player.id);
  if (!freshP) return { text: 'Error al leer tu perfil.' };

  if (!freshP.equipped_weapon) {
    return { text: '🪄 No tenés un arma equipada. Equipá un arma primero con `equip <arma>`.' };
  }

  let runeType = args[0].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // Soportar aliases
  if (runeType === 'fire') runeType = 'fuego';
  if (runeType === 'ice' || runeType === 'hielo') runeType = 'hielo';
  if (runeType === 'shadow') runeType = 'sombra';
  if (runeType === 'light') runeType = 'luz';
  if (runeType === 'chaos') runeType = 'caos';

  if (!RUNE_TYPES.includes(runeType)) {
    return { text: `❌ Tipo de runa inválido. Tipos válidos: ${RUNE_TYPES.join(', ')}.\nUsá "enchant" sin argumentos para ver los efectos.` };
  }

  // Verificar que tiene al menos 1 runa del tipo
  let runes;
  try { runes = JSON.parse(freshP.runes || '{}'); } catch (_) { runes = {}; }

  let effectiveType = runeType;

  // Si es caos, elegir un tipo aleatorio de los otros 4
  if (runeType === 'caos') {
    const otherTypes = RUNE_TYPES.filter(t => t !== 'caos');
    effectiveType = otherTypes[Math.floor(Math.random() * otherTypes.length)];
  }

  // Verificar runa disponible
  const runeCount = runes[runeType] || 0;
  if (runeCount <= 0) {
    return { text: `❌ No tenés runas de ${RUNE_EMOJIS[runeType]} ${runeType}. Obtenés runas al matar monstruos (15% de chance).` };
  }

  // Consumir la runa
  runes[runeType] = runeCount - 1;
  if (runes[runeType] <= 0) delete runes[runeType];

  // Aplicar el encantamiento en active_scrolls (reutilizamos infraestructura T153)
  const scrolls = JSON.parse(freshP.active_scrolls || '{}');
  const expiresAt = Date.now() + 3 * 60 * 1000; // 3 minutos

  // Efecto según tipo efectivo
  const enchantEffects = {
    fuego:  { type: 'fuego',  atk_bonus: 2, def_bonus: 0, expires_at: expiresAt },
    hielo:  { type: 'hielo',  atk_bonus: 0, def_bonus: 0, slow_chance: 0.20, expires_at: expiresAt },
    sombra: { type: 'sombra', atk_bonus: 0, def_bonus: 0, crit_bonus: 0.15, expires_at: expiresAt },
    luz:    { type: 'luz',    atk_bonus: 0, def_bonus: 0, hp_on_kill: 3, expires_at: expiresAt },
  };

  const enchant = enchantEffects[effectiveType];
  scrolls['weapon_enchant'] = enchant;

  db.updatePlayer(freshP.id, {
    runes: JSON.stringify(runes),
    active_scrolls: JSON.stringify(scrolls),
  });

  const emoji = RUNE_EMOJIS[runeType];
  const effectEmoji = RUNE_EMOJIS[effectiveType];
  const effectNames = {
    fuego:  '+2 ATK durante 3 minutos',
    hielo:  '20% de chance de ralentizar al monstruo (pierde su turno) por 3 minutos',
    sombra: '+15% de chance de crítico adicional durante 3 minutos',
    luz:    '+3 HP recuperado al matar un monstruo durante 3 minutos',
  };

  let msg = `🪄 ¡Tu ${freshP.equipped_weapon} brilla con poder runico!`;
  if (runeType === 'caos') {
    msg += `\n${emoji} Runa de Caos consumida → ${effectEmoji} ¡El caos elige: ${effectiveType}!`;
  } else {
    msg += `\n${emoji} Runa de ${runeType.charAt(0).toUpperCase() + runeType.slice(1)} consumida.`;
  }
  msg += `\n✨ Efecto: ${effectNames[effectiveType]}`;
  msg += `\n   (Runas ${emoji} restantes: ${runes[runeType] || 0})`;

  return { text: msg };
}

// ─────────────────────────────────────────────────────────────────────────────
// T193: Sistema de acertijos del dungeon
// Comando: trivia / acertijo / riddle / enigma
// El jugador obtiene un acertijo aleatorio temático.
// Responde con: trivia <respuesta> (o acertijo <respuesta>)
// Si acierta: +10 XP y +5g. Cooldown 5 minutos entre acertijos.
// Si falla: mensaje de error. 60s para responder antes de que expire.
// ─────────────────────────────────────────────────────────────────────────────
const TRIVIA_QUESTIONS = [
  { q: 'Tiene dientes pero no muerde; tiene hojas pero no es árbol. ¿Qué soy?', a: ['libro', 'libros'], hint: 'guarda palabras' },
  { q: 'Soy más fuerte que el hierro pero el agua me vence. ¿Qué soy?', a: ['fuego', 'el fuego'], hint: 'calienta y destruye' },
  { q: 'Cuanto más me secas, más mojado te quedas. ¿Qué soy?', a: ['toalla', 'una toalla'], hint: 'se usa tras el baño' },
  { q: 'Tengo ciudades sin casas, montañas sin árboles, agua sin peces. ¿Qué soy?', a: ['mapa', 'un mapa'], hint: 'guía al viajero' },
  { q: 'Caminan de noche y de día pero nunca se van a ningún lado. ¿Qué son?', a: ['pies', 'los pies', 'zapatos'], hint: 'los tenés en las extremidades' },
  { q: 'Soy invisible pero puedo tumbarte un árbol. ¿Qué soy?', a: ['viento', 'el viento', 'aire'], hint: 'mueve las hojas' },
  { q: 'Entre más tomo, más dejo atrás. ¿Qué soy?', a: ['camino', 'un camino', 'pasos'], hint: 'se crea al avanzar' },
  { q: 'Tiene boca pero no habla, tiene orillas pero no hay playa. ¿Qué soy?', a: ['río', 'un río'], hint: 'fluye hacia el mar' },
  { q: 'Soy lo que tienes cuando naces y pierdes al crecer. ¿Qué soy?', a: ['inocencia', 'la inocencia', 'dientes de leche', 'juventud'], hint: 'nadie la puede comprar' },
  { q: 'Vuelo sin alas, lloro sin ojos. Oscurezco el cielo y el sol. ¿Qué soy?', a: ['nube', 'una nube', 'nubes'], hint: 'trae lluvia al dungeon' },
  { q: 'En el dungeon, cuantos más monstruos matas, más crece esto. ¿Qué es?', a: ['experiencia', 'xp', 'nivel', 'el nivel'], hint: 'aparece en status' },
  { q: 'El mercader la vende pero no la usa; el aventurero la compra pero no la muestra. ¿Qué es?', a: ['tumba', 'una tumba', 'lápida', 'sepultura', 'muerte'], hint: 'nadie quiere necesitarla' },
  { q: 'Soy eterno mientras se habla de mí. Muero en el silencio. ¿Qué soy?', a: ['memoria', 'la memoria', 'recuerdo', 'historia', 'leyenda'], hint: 'los bardos me preservan' },
  { q: 'Tiene llama pero no quema, tiene luz pero no calienta. ¿Qué soy?', a: ['luna', 'la luna'], hint: 'brilla de noche sobre el dungeon' },
  { q: 'Cuanto más grande, menos peso. ¿Qué soy?', a: ['agujero', 'un agujero', 'vacío', 'el vacío'], hint: 'las paredes del dungeon lo tienen' },
  { q: 'Soy veloz pero no corro; soy fuerte pero no golpeo; vengo antes del trueno. ¿Qué soy?', a: ['relámpago', 'rayo', 'el rayo', 'el relámpago', 'luz'], hint: 'ilumina el cielo en tormenta' },
  { q: 'No tengo cuerpo pero dejo huella; no tengo voz pero cuento historias. ¿Qué soy?', a: ['escritura', 'las letras', 'texto', 'palabra', 'palabras', 'libro'], hint: 'el README del dungeon' },
  { q: 'Muero si me mojan pero el agua es mi hogar. ¿Qué soy?', a: ['fuego', 'el fuego', 'llama'], hint: 'los dragones lo escupen' },
  { q: 'Me tienen todos los ricos, los pobres la necesitan para vivir, y si la comes morís. ¿Qué es?', a: ['nada', 'la nada', 'el vacío'], hint: 'está en el Abismo Eterno' },
  { q: 'Tiene cabeza y cola pero no tiene cuerpo. ¿Qué soy?', a: ['moneda', 'una moneda', 'monedas'], hint: 'el mercader las ama' },
];

// triviaMap: playerId → { questionIdx, expiresAt }
const triviaMap = new Map();
const TRIVIA_COOLDOWNS = new Map(); // playerId → timestamp del último éxito
const TRIVIA_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutos
const TRIVIA_TIMEOUT_MS = 60 * 1000; // 60 segundos para responder

/**
 * T193: Comando trivia / acertijo
 * Sin args: propone un acertijo nuevo (si no hay uno activo).
 * Con args: intenta responder el acertijo activo.
 */
function cmdTrivia(player, args) {
  const now = Date.now();

  // Verificar cooldown de éxito
  const lastSuccess = TRIVIA_COOLDOWNS.get(player.id) || 0;
  const cooldownLeft = Math.ceil((TRIVIA_COOLDOWN_MS - (now - lastSuccess)) / 1000);

  // ¿Hay un acertijo activo?
  const active = triviaMap.get(player.id);

  // Sin args: proponer nuevo acertijo o mostrar el activo
  if (!args || args.length === 0) {
    // Si hay uno activo y no expiró, mostrarlo de nuevo
    if (active && active.expiresAt > now) {
      const q = TRIVIA_QUESTIONS[active.questionIdx];
      const secsLeft = Math.ceil((active.expiresAt - now) / 1000);
      const W = 52;
      const lines = [
        '┌' + '─'.repeat(W - 2) + '┐',
        `│${'  🧩 ACERTIJO ACTIVO'.padEnd(W - 2)}│`,
        '├' + '─'.repeat(W - 2) + '┤',
        `│ ${('Tiempo restante: ' + secsLeft + 's').padEnd(W - 3)}│`,
        '├' + '─'.repeat(W - 2) + '┤',
      ];
      // Wrap del enunciado
      const words = q.q.split(' ');
      let line = '';
      for (const w of words) {
        if ((line + w).length > W - 4) {
          lines.push(`│ ${line.trimEnd().padEnd(W - 3)}│`);
          line = '';
        }
        line += w + ' ';
      }
      if (line.trim()) lines.push(`│ ${line.trimEnd().padEnd(W - 3)}│`);
      lines.push('├' + '─'.repeat(W - 2) + '┤');
      lines.push(`│ ${'Respondé con: acertijo <tu respuesta>'.padEnd(W - 3)}│`);
      lines.push('└' + '─'.repeat(W - 2) + '┘');
      return { text: lines.join('\n') };
    }

    // Cooldown post-éxito
    if (lastSuccess > 0 && cooldownLeft > 0) {
      return { text: `🧩 Descansá un poco, aventurero. Podés pedir otro acertijo en ${cooldownLeft}s.` };
    }

    // Proponer nuevo acertijo (evitar repetir el mismo)
    let idx;
    do {
      idx = Math.floor(Math.random() * TRIVIA_QUESTIONS.length);
    } while (active && active.questionIdx === idx && TRIVIA_QUESTIONS.length > 1);

    triviaMap.set(player.id, { questionIdx: idx, expiresAt: now + TRIVIA_TIMEOUT_MS });

    const q = TRIVIA_QUESTIONS[idx];
    const W = 52;
    const lines = [
      '┌' + '─'.repeat(W - 2) + '┐',
      `│${'  🧩 ACERTIJO DEL DUNGEON'.padEnd(W - 2)}│`,
      '├' + '─'.repeat(W - 2) + '┤',
      `│ ${'Premio: +10 XP · +5 🪙 de oro'.padEnd(W - 3)}│`,
      `│ ${'Tiempo: 60 segundos'.padEnd(W - 3)}│`,
      '├' + '─'.repeat(W - 2) + '┤',
    ];
    const words = q.q.split(' ');
    let line = '';
    for (const w of words) {
      if ((line + w).length > W - 4) {
        lines.push(`│ ${line.trimEnd().padEnd(W - 3)}│`);
        line = '';
      }
      line += w + ' ';
    }
    if (line.trim()) lines.push(`│ ${line.trimEnd().padEnd(W - 3)}│`);
    lines.push('├' + '─'.repeat(W - 2) + '┤');
    lines.push(`│ ${'Respondé: acertijo <respuesta>'.padEnd(W - 3)}│`);
    lines.push('└' + '─'.repeat(W - 2) + '┘');
    return { text: lines.join('\n') };
  }

  // Con args: intentar responder
  if (!active || active.expiresAt <= now) {
    // Expiró o no hay activo
    if (active && active.expiresAt <= now) {
      triviaMap.delete(player.id);
      const oldQ = TRIVIA_QUESTIONS[active.questionIdx];
      return { text: `⏰ ¡Tiempo agotado! La respuesta era: "${oldQ.a[0]}".\nEscribí "acertijo" para intentar uno nuevo.` };
    }
    return { text: `🧩 No tenés ningún acertijo activo. Escribí "acertijo" para recibir uno.` };
  }

  // Verificar respuesta
  const q = TRIVIA_QUESTIONS[active.questionIdx];
  const answer = args.join(' ').toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // normalizar tildes

  const correctAnswers = q.a.map(ans =>
    ans.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  );

  if (correctAnswers.includes(answer)) {
    // ¡Correcto!
    triviaMap.delete(player.id);
    TRIVIA_COOLDOWNS.set(player.id, now);
    const freshP = db.getPlayer(player.id);
    const newXp = (freshP.xp || 0) + 10;
    const newGold = (freshP.gold || 0) + 5;
    const newLevel = Math.floor(newXp / 50) + 1;
    const levelUp = newLevel > (freshP.level || 1);
    const updates = { xp: newXp, gold: newGold };
    if (levelUp) {
      updates.level = newLevel;
      updates.max_hp = (freshP.max_hp || 30) + 5;
      updates.hp = Math.min(freshP.hp, updates.max_hp);
      updates.attack = (freshP.attack || 5) + 1;
    }
    db.updatePlayer(player.id, updates);
    // Registrar en diario
    db.addJournalEntry(player.id, 'trivia', `🧩 Acertijo resuelto: +10 XP · +5g.`);
    let msg = `✅ ¡CORRECTO, ${player.username}! La respuesta era "${q.a[0]}".\n`;
    msg += `   +10 XP · +5 🪙 de oro ganados.\n`;
    msg += `   Próximo acertijo disponible en 5 minutos.`;
    if (levelUp) msg += `\n✨ ¡SUBISTE AL NIVEL ${newLevel}!`;
    return { text: msg };
  } else {
    // Incorrecto
    const secsLeft = Math.ceil((active.expiresAt - now) / 1000);
    return { text: `❌ Eso no es correcto. Pista: ${q.hint}.\n   Te quedan ${secsLeft}s para responder. ¡Intentalo de nuevo!` };
  }
}

// Sobreescribir module.exports para incluir T190+T192+T193
module.exports = { execute, getOrCreatePlayer, ROOM_EFFECTS, resolveExpiredAuctions, getTitle, regenMana, SPELL_CATALOG, getClassReminder, cmdBestiary, cmdProfile, cmdJournal, cmdServerStats, cmdTime, cmdEnemies, cmdCompare, cmdReputation, cmdChallenge, clearAfk, isAfk, killStreakMap, sessionExploredRooms, STANCES, sessionCommandHistory, cmdWeather, cmdHardcore, toRoman, cmdMemorial, cmdCalendar, FORAGE_REST_ROOMS, cmdEnchant, comboMap };

// ─── T194: worldgoals/metas — metas globales del servidor ────────────────────
function cmdWorldGoals() {
  const goals = db.getWorldGoalsDisplay();
  const W = 52;
  const pad = (s, w) => { const str = String(s); return str + ' '.repeat(Math.max(0, w - str.length)); };
  const bar = (current, next, width) => {
    const filled = Math.min(width, Math.floor((current / next) * width));
    return '█'.repeat(filled) + '░'.repeat(width - filled);
  };

  const lines = [];
  lines.push(`╔${'═'.repeat(W)}╗`);
  lines.push(`║${'🌍 METAS GLOBALES DEL SERVIDOR'.padStart(Math.floor((W + 30) / 2)).padEnd(W)}║`);
  lines.push(`╠${'═'.repeat(W)}╣`);

  for (const [cat, data] of Object.entries(goals)) {
    const pct = data.next > 0 ? Math.min(100, Math.floor((data.current / data.next) * 100)) : 100;
    lines.push(`║  ${pad(data.label, W - 3)} ║`);
    lines.push(`║  ${pad(`${data.current.toLocaleString()} / ${data.next.toLocaleString()} (${pct}%)`, W - 3)} ║`);
    lines.push(`║  [${bar(data.current, data.next, W - 7)}] ║`);
    // Hitos superados
    const reached = data.milestones.filter(m => m <= data.current);
    if (reached.length > 0) {
      const reachedStr = `   ✅ Superado: ${reached.map(m => m.toLocaleString()).join(', ')}`;
      lines.push(`║  ${pad(reachedStr.slice(0, W - 3), W - 3)} ║`);
    }
    lines.push(`╟${'─'.repeat(W)}╢`);
  }
  lines.pop(); // quitar último separador
  lines.push(`╠${'═'.repeat(W)}╣`);
  lines.push(`║  ${'Cada kill, crafteo, oro y duelo cuenta para toda'.padEnd(W - 3)} ║`);
  lines.push(`║  ${'la comunidad. ¡Al alcanzar un hito, broadcast!'.padEnd(W - 3)} ║`);
  lines.push(`╚${'═'.repeat(W)}╝`);
  return { text: lines.join('\n') };
}

// Actualizar module.exports con T194
module.exports = { execute, getOrCreatePlayer, ROOM_EFFECTS, resolveExpiredAuctions, getTitle, regenMana, SPELL_CATALOG, getClassReminder, cmdBestiary, cmdProfile, cmdJournal, cmdServerStats, cmdTime, cmdEnemies, cmdCompare, cmdReputation, cmdChallenge, clearAfk, isAfk, killStreakMap, sessionExploredRooms, STANCES, sessionCommandHistory, cmdWeather, cmdHardcore, toRoman, cmdMemorial, cmdCalendar, FORAGE_REST_ROOMS, cmdEnchant, comboMap, cmdWorldGoals };

// ─── T195: records/récords — tabla de récords del servidor ───────────────────
function cmdRecords() {
  const W = 52;
  const pad = (s, w) => { const str = String(s); return str + ' '.repeat(Math.max(0, w - str.length)); };
  const records = db.getAllServerRecords();
  const defs = db.SERVER_RECORDS_DEFS;

  const lines = [];
  lines.push(`╔${'═'.repeat(W)}╗`);
  lines.push(`║${'🏆 RÉCORDS DEL SERVIDOR'.padStart(Math.floor((W + 22) / 2)).padEnd(W)}║`);
  lines.push(`╠${'═'.repeat(W)}╣`);

  const keys = Object.keys(defs);
  for (const key of keys) {
    const def = defs[key];
    const rec = records.find(r => r.record_key === key);
    if (rec) {
      lines.push(`║  ${pad(def.label, W - 3)} ║`);
      const holderStr = `   ${def.icon} ${rec.holder_name} — ${rec.value.toLocaleString()} ${def.unit}`;
      lines.push(`║  ${pad(holderStr.slice(0, W - 3), W - 3)} ║`);
      const dateStr = `   📅 ${rec.achieved_at ? rec.achieved_at.slice(0, 16).replace('T', ' ') : '???'}`;
      lines.push(`║  ${pad(dateStr.slice(0, W - 3), W - 3)} ║`);
    } else {
      lines.push(`║  ${pad(def.label, W - 3)} ║`);
      lines.push(`║  ${pad('   (sin récord aún — ¡sé el primero!)', W - 3)} ║`);
    }
    lines.push(`╟${'─'.repeat(W)}╢`);
  }
  lines.pop();
  lines.push(`╠${'═'.repeat(W)}╣`);
  lines.push(`║  ${'Los récords se actualizan automáticamente.'.padEnd(W - 3)} ║`);
  lines.push(`╚${'═'.repeat(W)}╝`);
  return { text: lines.join('\n') };
}

/**
 * T195: Verificar y actualizar récords tras un kill de monstruo.
 * Comprueba nivel, kills totales y combo.
 * @returns {string} mensaje de récord batido (puede ser '')
 */
function checkAndSetRecords(player, comboValue) {
  const msgs = [];
  const fresh = db.getPlayer(player.id) || player;
  const username = fresh.username;

  // Nivel más alto
  if (db.trySetServerRecord('max_level', fresh.level || 1, username)) {
    msgs.push(`🏆 ¡RÉCORD! ${username} alcanzó el nivel más alto del servidor: ${fresh.level}`);
  }
  // Kills totales
  if (db.trySetServerRecord('max_kills', fresh.kills || 0, username)) {
    msgs.push(`⚔️ ¡RÉCORD! ${username} tiene el mayor número de kills del servidor: ${fresh.kills}`);
  }
  // Combo de ataque
  if (comboValue && comboValue > 1) {
    if (db.trySetServerRecord('max_combo', comboValue, username)) {
      msgs.push(`⚡ ¡RÉCORD COMBO! ${username} encadenó ${comboValue}x ataques consecutivos`);
    }
  }
  // Oro
  if (db.trySetServerRecord('max_gold', fresh.gold || 0, username)) {
    msgs.push(`💰 ¡RÉCORD! ${username} acumula más oro que nadie: ${fresh.gold}g`);
  }
  // Duelos ganados
  if (db.trySetServerRecord('max_duel_kills', fresh.duel_wins || 0, username)) {
    msgs.push(`🥊 ¡RÉCORD! ${username} lidera duelos ganados: ${fresh.duel_wins}`);
  }
  return msgs;
}

// ─────────────────────────────────────────────────────────────────────────────
// T198: Score de sesión actual — ranking de kills entre jugadores conectados ahora
// ─────────────────────────────────────────────────────────────────────────────
function cmdScoreSession(player, context) {
  const sessionMap = context && context.sessionDataMap;
  if (!sessionMap || sessionMap.size === 0) {
    return { text: 'No hay aventureros conectados en este momento.' };
  }

  // Recopilar datos de todos los jugadores con sesión activa
  const entries = [];
  for (const [playerId, sess] of sessionMap.entries()) {
    const p = db.getPlayer(playerId);
    if (!p) continue;
    const elapsed = Math.floor((Date.now() - (sess.startTime || Date.now())) / 60000);
    entries.push({
      username: p.username,
      kills: sess.kills || 0,
      commands: sess.commands || 0,
      minutes: elapsed,
      isSelf: playerId === player.id,
    });
  }

  // Ordenar por kills DESC, luego por comandos
  entries.sort((a, b) => b.kills - a.kills || b.commands - a.commands);

  if (entries.length === 0) {
    return { text: 'No hay datos de sesión disponibles.' };
  }

  const W = 50;
  const lines = [
    `╔${'═'.repeat(W)}╗`,
    `║${'   ⚡ RANKING DE SESIÓN — JUGADORES ACTIVOS ⚡   '.padEnd(W)}║`,
    `╠${'═'.repeat(W)}╣`,
    `║  ${'#   Aventurero        Kills  Cmds  Tiempo'.padEnd(W - 3)}║`,
    `╠${'═'.repeat(W)}╣`,
  ];

  entries.forEach((e, idx) => {
    const rank  = String(idx + 1).padStart(2);
    const you   = e.isSelf ? '◄' : ' ';
    const name  = e.username.substring(0, 14).padEnd(14);
    const kills = String(e.kills).padStart(5);
    const cmds  = String(e.commands).padStart(4);
    const mins  = e.minutes < 60 ? `${e.minutes}m` : `${Math.floor(e.minutes / 60)}h${e.minutes % 60}m`;
    const timeStr = mins.padStart(5);
    const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '  ';
    lines.push(`║ ${medal}${rank} ${you} ${name}  ${kills}  ${cmds}  ${timeStr}  ║`);
  });

  lines.push(`╚${'═'.repeat(W)}╝`);
  lines.push(`  Solo jugadores conectados ahora. Se reinicia al desconectarse.`);
  return { text: lines.join('\n') };
}

// ─────────────────────────────────────────────────────────────────────────────
// T197: Comando card — tarjeta de aventurero compacta para compartir
// ─────────────────────────────────────────────────────────────────────────────
function cmdCard(player) {
  const fresh = db.getPlayer(player.id) || player;
  const title = getTitle(fresh.kills || 0);
  const cls   = fresh.player_class || 'Sin clase';
  const clsEmoji = cls === 'Guerrero' ? '⚔️' : cls === 'Mago' ? '🧙' : cls === 'Pícaro' ? '🗡️' : '❓';
  const hpBar = buildBar(fresh.hp, fresh.max_hp, 12);
  const guild = fresh.guild ? `[${fresh.guild}]` : '';
  const hcTag = fresh.is_hardcore ? (fresh.fallen ? '✝ CAÍDO' : '🔴 HARDCORE') : '';
  const pet   = fresh.pet ? `🐾 ${fresh.pet}` : '';
  const achievements = (() => {
    try {
      const arr = JSON.parse(fresh.achievements || '[]');
      return arr.length ? arr.slice(0, 6).join(' ') : '—';
    } catch { return '—'; }
  })();
  const kd = fresh.deaths > 0 ? (((fresh.kills || 0) / fresh.deaths).toFixed(1)) : (fresh.kills || 0);

  const W = 44;
  const pad = (s, n) => String(s).substring(0, n).padEnd(n);
  const lines = [
    `╔${'═'.repeat(W)}╗`,
    `║${''.padEnd(W)}║`,
    `║  ${clsEmoji} ${pad((fresh.username || '???').toUpperCase(), W - 6)}║`,
    `║  ${pad(`${title}  ${guild}  ${hcTag}`, W - 3)}║`,
    `║${''.padEnd(W)}║`,
    `╠${'═'.repeat(W)}╣`,
    `║  HP: ${hpBar} ${fresh.hp}/${fresh.max_hp}`.padEnd(W + 2) + `║`,
    `║  Nivel: ${fresh.level || 1}  XP: ${fresh.xp || 0}  Kills: ${fresh.kills || 0}  K/D: ${kd}`.padEnd(W + 2) + `║`,
    `║  ATK: ${fresh.attack || 5}  DEF: ${fresh.defense || 3}  Oro: ${fresh.gold || 0}g`.padEnd(W + 2) + `║`,
    `╠${'═'.repeat(W)}╣`,
    `║  Logros: ${pad(achievements, W - 11)}║`,
    pet ? `║  ${pad(pet, W - 3)}║` : null,
    `╚${'═'.repeat(W)}╝`,
    `  📋 Dungeon of Echoes — dungeon-of-echoes.onrender.com`,
  ].filter(Boolean);

  return { text: lines.join('\n') };
}

// ─────────────────────────────────────────────────────────────────────────────
// T196: Trivia pública — todos en la sala pueden responder
// roomTriviaMap: roomId → { questionIdx, expiresAt, proposerId }
// ─────────────────────────────────────────────────────────────────────────────
const roomTriviaMap = new Map();
const ROOM_TRIVIA_COOLDOWNS = new Map(); // roomId → nextAllowedAt

function cmdTriviaPub(player, args, context) {
  const roomId = player.current_room_id;
  const now    = Date.now();

  // Cooldown global de la sala (5 min tras resolver)
  const nextAllowed = ROOM_TRIVIA_COOLDOWNS.get(roomId) || 0;
  if (now < nextAllowed) {
    const secs = Math.ceil((nextAllowed - now) / 1000);
    return { text: `⏳ La sala necesita ${secs}s más de descanso antes del próximo acertijo grupal.` };
  }

  const active = roomTriviaMap.get(roomId);

  // Sin args: proponer un acertijo nuevo a la sala
  if (!args || !args.trim()) {
    if (active && now < active.expiresAt) {
      const remaining = Math.ceil((active.expiresAt - now) / 1000);
      const q = TRIVIA_QUESTIONS[active.questionIdx];
      return { text: `🧩 Ya hay un acertijo grupal activo (${remaining}s restantes):\n\n"${q.q}"\n\nResponde con: acertijo-publico <respuesta>` };
    }
    // Elegir pregunta (diferente a la última si es posible)
    let idx;
    do { idx = Math.floor(Math.random() * TRIVIA_QUESTIONS.length); }
    while (active && active.questionIdx === idx && TRIVIA_QUESTIONS.length > 1);

    roomTriviaMap.set(roomId, {
      questionIdx: idx,
      expiresAt: now + 90_000, // 90s (más tiempo para que varios lo intenten)
      proposerId: player.id,
    });

    const q = TRIVIA_QUESTIONS[idx];
    const W = 54;
    const lines = [
      `╔${'═'.repeat(W)}╗`,
      `║${'  🧩 ACERTIJO GRUPAL — ¡TODOS PUEDEN RESPONDER! 🧩  '.padEnd(W)}║`,
      `╠${'═'.repeat(W)}╣`,
    ];
    // Wrappear la pregunta en líneas de max W-4 chars
    const words = q.q.split(' ');
    let line = '';
    for (const w of words) {
      if ((line + ' ' + w).trim().length > W - 4) {
        lines.push(`║  ${line.padEnd(W - 3)}║`);
        line = w;
      } else {
        line = (line + ' ' + w).trim();
      }
    }
    if (line) lines.push(`║  ${line.padEnd(W - 3)}║`);
    lines.push(`╠${'═'.repeat(W)}╣`);
    lines.push(`║  ${'Propuesto por: ' + player.username}`.padEnd(W + 2) + `║`);
    lines.push(`║  ${'Recompensa: +15 XP · +8g · +3 reputación al ganador'.padEnd(W - 3)}║`);
    lines.push(`║  ${'Tiempo: 90 segundos'.padEnd(W - 3)}║`);
    lines.push(`╚${'═'.repeat(W)}╝`);
    lines.push(`  Responde con: acertijo-publico <respuesta>`);

    // Broadcast a toda la sala
    if (context && context.broadcastToRoom) {
      context.broadcastToRoom(roomId, null, lines.join('\n'));
    }

    return { text: lines.join('\n') };
  }

  // Con args: intentar responder
  if (!active || now >= active.expiresAt) {
    roomTriviaMap.delete(roomId);
    return { text: '⌛ No hay ningún acertijo grupal activo en esta sala. Usá "acertijo-publico" sin argumentos para proponer uno.' };
  }

  const q = TRIVIA_QUESTIONS[active.questionIdx];
  const normalize = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const answer    = normalize(args);
  const correct   = q.a.some(a => normalize(a) === answer);

  if (correct) {
    roomTriviaMap.delete(roomId);
    ROOM_TRIVIA_COOLDOWNS.set(roomId, now + 5 * 60_000);

    // Recompensa al ganador — mismo patrón que cmdTrivia
    const freshWinner = db.getPlayer(player.id);
    const newXp   = (freshWinner.xp || 0) + 15;
    const newGold = (freshWinner.gold || 0) + 8;
    const newLevel = Math.floor(newXp / 50) + 1;
    const levelUp  = newLevel > (freshWinner.level || 1);
    const updates = { xp: newXp, gold: newGold };
    if (levelUp) {
      updates.level = newLevel;
      updates.max_hp = (freshWinner.max_hp || 30) + 5;
      updates.hp = Math.min(freshWinner.hp, updates.max_hp);
      updates.attack = (freshWinner.attack || 5) + 1;
    }
    db.updatePlayer(player.id, updates);
    db.addReputation(player.id, 3);
    db.addJournalEntry(player.id, 'trivia_pub', `🧩 Acertijo grupal resuelto: +15 XP · +8g.`);

    const msg = `🎉 ¡${player.username} resolvió el acertijo grupal! La respuesta era: "${q.a[0]}".\n${player.username} gana +15 XP · +8g · +3 reputación.`;
    if (context && context.broadcastToRoom) {
      context.broadcastToRoom(roomId, null, msg);
    }
    return { text: msg };
  } else {
    const remaining = Math.ceil((active.expiresAt - now) / 1000);
    return { text: `❌ Incorrecto. Pista: ${q.hint}. Tiempo restante: ${remaining}s.` };
  }
}

// Actualizar module.exports con T196+T197+T198
module.exports = { execute, getOrCreatePlayer, ROOM_EFFECTS, resolveExpiredAuctions, getTitle, regenMana, SPELL_CATALOG, getClassReminder, cmdBestiary, cmdProfile, cmdJournal, cmdServerStats, cmdTime, cmdEnemies, cmdCompare, cmdReputation, cmdChallenge, clearAfk, isAfk, killStreakMap, sessionExploredRooms, STANCES, sessionCommandHistory, cmdWeather, cmdHardcore, toRoman, cmdMemorial, cmdCalendar, FORAGE_REST_ROOMS, cmdEnchant, comboMap, cmdWorldGoals, checkAndSetRecords };

// ══════════════════════════════════════════════════════════════════════════════
// T201: autoEpitaph + cmdEpitaph — Epitafios personales
// ══════════════════════════════════════════════════════════════════════════════

/** Genera un epitafio automático si el jugador no tiene uno personalizado. */
function autoEpitaph(player) {
  const classNames = {
    guerrero: 'guerrero', mago: 'mago', picaro: 'pícaro', sin_clase: 'aventurero',
  };
  const cls = classNames[player.player_class] || 'aventurero';
  const kills = player.kills || 0;
  const level = player.level || 1;
  if (kills === 0) return `Un ${cls} de nivel ${level} que nunca mató a nadie.`;
  if (kills < 5)  return `${cls.charAt(0).toUpperCase() + cls.slice(1)} de nivel ${level}. Mató ${kills} veces. Prometía.`;
  if (kills < 20) return `Vino, vio, mató ${kills} veces. Nivel ${level}.`;
  if (kills < 50) return `${kills} kills, nivel ${level}. El dungeon lo recuerda.`;
  return `Leyenda del dungeon. ${kills} kills. Nivel ${level}. Descansa, ${cls}.`;
}

/** T201: Escribir o ver el epitafio personal. */
function cmdEpitaph(player, args) {
  if (!args || args.length === 0) {
    // Ver el propio epitafio
    const fresh = db.getPlayer(player.id);
    const current = fresh.epitaph;
    const auto    = autoEpitaph(fresh);
    const lines = [];
    lines.push(`══ 🪦 Tu Epitafio ══`);
    if (current) {
      lines.push(`Personalizado: "${current}"`);
    } else {
      lines.push(`(Sin epitafio. Epitafio automático: "${auto}")`);
    }
    lines.push(`Usá: epitafio <texto> para establecer tu epitafio (máx 80 chars).`);
    lines.push(`Aparece en el memorial si morís en modo Hardcore.`);
    return { text: lines.join('\n') };
  }

  const text = args.join(' ').trim().slice(0, 80);
  if (text.length < 3) return { text: 'El epitafio debe tener al menos 3 caracteres.' };

  db.updatePlayer(player.id, { epitaph: text });
  return { text: `🪦 Epitafio guardado: "${text}"\nAparecerá en el memorial si morís en modo Hardcore.` };
}

// ══════════════════════════════════════════════════════════════════════════════
// T200: cmdVault — Bóveda personal (hasta 10 ítems, solo en sala 1)
// ══════════════════════════════════════════════════════════════════════════════
function cmdVault(player, args) {
  const W = 48;
  const vaultItems = JSON.parse(player.vault || '[]');

  // Sin args: listar el contenido
  if (!args || args.length === 0) {
    const lines = [];
    lines.push(`╔${'═'.repeat(W)}╗`);
    lines.push(`║${'  🏛️  BÓVEDA PERSONAL'.padEnd(W)}║`);
    lines.push(`╠${'═'.repeat(W)}╣`);
    if (vaultItems.length === 0) {
      lines.push(`║  (vacía)`.padEnd(W + 2) + `║`);
    } else {
      vaultItems.forEach((item, i) => {
        const entry = `  ${i + 1}. ${item}`;
        lines.push(`║${entry.padEnd(W)}║`);
      });
    }
    lines.push(`╠${'═'.repeat(W)}╣`);
    lines.push(`║  ${`${vaultItems.length}/10 ítems guardados`.padEnd(W - 2)}║`);
    lines.push(`╠${'═'.repeat(W)}╣`);
    lines.push(`║  vault store <ítem>  — guardar un ítem`.padEnd(W + 2) + `║`);
    lines.push(`║  vault take <ítem>   — sacar un ítem`.padEnd(W + 2) + `║`);
    lines.push(`╚${'═'.repeat(W)}╝`);
    return { text: lines.join('\n') };
  }

  const subcmd = args[0].toLowerCase();
  const itemArg = args.slice(1).join(' ').trim();

  // Solo accesible en sala 1
  if (player.current_room_id !== 1) {
    return { text: '🏛️  La bóveda solo es accesible en la Entrada del Dungeon (sala 1). Usá `recall` para volver.' };
  }

  if (subcmd === 'store' || subcmd === 'guardar' || subcmd === 'depositar') {
    if (!itemArg) return { text: '¿Qué ítem querés guardar? Ej: vault store espada oxidada' };
    if (vaultItems.length >= 10) return { text: '🏛️  La bóveda está llena (10/10). Sacá algo primero.' };

    const inv = JSON.parse(typeof player.inventory === 'string' ? player.inventory : JSON.stringify(player.inventory));
    const norm = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    const idx = inv.findIndex(i => norm(i) === norm(itemArg) || norm(i).includes(norm(itemArg)));
    if (idx === -1) return { text: `No tenés "${itemArg}" en el inventario.` };

    const item = inv[idx];
    // No se puede guardar el arma o armadura equipada
    const fresh = db.getPlayer(player.id);
    if (fresh.equipped_weapon && norm(fresh.equipped_weapon) === norm(item)) {
      return { text: `Desequipá "${item}" antes de guardarlo en la bóveda.` };
    }
    if (fresh.equipped_armor && norm(fresh.equipped_armor) === norm(item)) {
      return { text: `Quitáte "${item}" antes de guardarlo en la bóveda.` };
    }

    inv.splice(idx, 1);
    vaultItems.push(item);
    db.updatePlayer(player.id, {
      inventory: JSON.stringify(inv),
      vault: JSON.stringify(vaultItems),
    });
    return { text: `🏛️  "${item}" guardado en la bóveda. (${vaultItems.length}/10)` };
  }

  if (subcmd === 'take' || subcmd === 'sacar' || subcmd === 'retirar') {
    if (!itemArg) return { text: '¿Qué ítem querés sacar? Ej: vault take espada oxidada' };

    const norm = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    const idx = vaultItems.findIndex(i => norm(i) === norm(itemArg) || norm(i).includes(norm(itemArg)));
    if (idx === -1) return { text: `No tenés "${itemArg}" en la bóveda.` };

    const item = vaultItems[idx];
    const inv = JSON.parse(typeof player.inventory === 'string' ? player.inventory : JSON.stringify(player.inventory));
    if (inv.length >= 20) return { text: '🎒 El inventario está lleno. Tirá algo primero.' };

    vaultItems.splice(idx, 1);
    inv.push(item);
    db.updatePlayer(player.id, {
      inventory: JSON.stringify(inv),
      vault: JSON.stringify(vaultItems),
    });
    return { text: `🏛️  "${item}" sacado de la bóveda y añadido al inventario.` };
  }

  return { text: 'Subcomandos: vault (listar) · vault store <ítem> · vault take <ítem>' };
}

// ══════════════════════════════════════════════════════════════════════════════
// T204: Sistema de follow — seguir a otro jugador
// ══════════════════════════════════════════════════════════════════════════════

/**
 * follow <jugador> — seguir a otro jugador en la misma sala.
 * Cuando el jugador objetivo se mueva, el seguidor se mueve automáticamente.
 * `unfollow` para dejar de seguir.
 */
function cmdFollow(player, args, context) {
  const followMap = context && context.followMap;
  if (!followMap) return { text: '❌ Sistema de follow no disponible (solo por Socket.io).' };

  if (!args || args.length === 0) {
    // Sin args: mostrar a quién seguís
    const targetId = followMap.get(player.id);
    if (!targetId) return { text: '🚶 No estás siguiendo a nadie. Usá: follow <jugador>' };
    const target = db.getPlayer(targetId);
    return { text: `🚶 Estás siguiendo a ${target ? target.username : '(desconectado)'}.` };
  }

  const targetName = args.join(' ').trim();
  const norm = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  // Buscar jugador en la misma sala
  const playersInRoom = db.getPlayersInRoom(player.current_room_id);
  const target = playersInRoom.find(p =>
    norm(p.username) === norm(targetName) || norm(p.username).includes(norm(targetName))
  );

  if (!target) return { text: `❌ No hay ningún aventurero llamado "${targetName}" en esta sala.` };
  if (target.id === player.id) return { text: '🤔 No podés seguirte a vos mismo.' };

  // No seguir si el objetivo ya te está siguiendo (ciclo)
  if (followMap.get(target.id) === player.id) {
    return { text: `❌ ${target.username} ya te está siguiendo a vos. No se pueden crear ciclos de seguimiento.` };
  }

  followMap.set(player.id, target.id);

  // Notificar al objetivo
  const targetSocket = context.playerSockets && context.playerSockets.get(target.id);
  if (targetSocket) {
    targetSocket.emit('event', {
      type: 'info',
      text: `👣 ${player.username} empieza a seguirte. Cuando te muevas, te seguirá automáticamente.`,
    });
  }

  return { text: `🚶 Ahora seguís a ${target.username}. Usá "unfollow" para dejar de seguirle.` };
}

function cmdUnfollow(player, context) {
  const followMap = context && context.followMap;
  if (!followMap) return { text: '❌ Sistema de follow no disponible.' };

  const targetId = followMap.get(player.id);
  if (!targetId) return { text: '🚶 No estás siguiendo a nadie.' };

  const target = db.getPlayer(targetId);
  followMap.delete(player.id);

  if (target && context.playerSockets) {
    const targetSocket = context.playerSockets.get(target.id);
    if (targetSocket) {
      targetSocket.emit('event', {
        type: 'info',
        text: `👣 ${player.username} dejó de seguirte.`,
      });
    }
  }

  return { text: `🛑 Dejaste de seguir a ${target ? target.username : 'ese jugador'}.` };
}

