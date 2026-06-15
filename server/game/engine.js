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
const xpSystem = require('./xp');      // DIS-D282: curva de XP cuadrática

// ── Efectos pasivos de sala (T087) ────────────────────────────────────────────
// Cada sala puede tener un efecto que se aplica al entrar.
// type: 'damage' | 'heal' | 'buff' | 'debuff'
const ROOM_EFFECTS = {
  // Sala 9 — Sala del Trono: frío sobrenatural (ya tiene trampa, además debuffa ATK)
  9:  { type: 'debuff', stat: 'attack', amount: -1, label: '🥶 Frío sobrenatural', msg: 'El frío sobrenatural te entumece los músculos. (-1 ATK mientras estés aquí)' },
  // Sala 12 — Taller de la Forja: calor brutal al entrar
  12: { type: 'damage', amount: 2, label: '🔥 Calor Abrasador', msg: '🔥 El calor extremo de la forja te abrasa la piel al entrar. (-2 HP)' },
  // Sala 1 — Entrada del Santuario: aura sagrada regenera HP
  1:  { type: 'heal', amount: 3, label: '✨ Aura Sagrada', msg: '✨ El aura sagrada de la entrada te reconforta. (+3 HP)' },
  // Sala 15 — Catedral Maldita: maldición drena HP (solo primera visita — DIS-512)
  15: { type: 'damage', amount: 1, label: '💀 Maldición del Lich (1ª visita)', msg: '💀 Una maldición oscura te roza al cruzar el umbral. (-1 HP) [Solo ocurre la primera vez que entrás]' },
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
// DIS-521: el bonus de daño está CAPADO según el nivel del jugador para evitar
// que jugadores experimentados se vuelvan invencibles. A nivel bajo el combo
// tiene más impacto relativo (tensión real), a nivel alto es cosmético.
// Fórmula: bonusDmg = min(comboCount-1, ceil(level/4))  → máx +1 a nivel 1-4, +2 a 5-8, +3 a 9-12, +4 a 13+
// Se resetea al cambiar de objetivo, al morir, o al morir el monstruo.
const comboMap = new Map();
const COMBO_MAX = 5;

// T212: estado del campeón de la hora en memoria
const hourlyChampionMap = new Map(); // key 'champion' → {id, username}
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

// ── Cuenco Sagrado de la Capilla (DIS-D48) ────────────────────────────────────
// Sala 5 — Capilla Olvidada. Cooldown personal: 5 minutos por jugador.
// Recupera 40% del HP máximo. Accesible desde las primeras zonas.
const CHAPEL_ROOM_ID = 5;
const CHAPEL_BOWL_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutos
const chapelBowlCooldowns = new Map(); // playerId → timestamp

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
 * Parsea status_effects de forma segura — acepta tanto string JSON como objeto ya parseado.
 * Necesario porque db.getPlayer() devuelve status_effects como objeto, pero algunos paths
 * antiguos podrían guardar strings. (Fix DIS-456 bug)
 * @param {string|object} se
 * @returns {object}
 */
function parseSE(se) {
  if (!se) return {};
  if (typeof se === 'object') return se;
  try { return JSON.parse(se); } catch (_) { return {}; }
}

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

  // DIS-D326: Regeneración pasiva de HP (1 HP/minuto fuera de combate)
  // Se aplica silenciosamente en cada comando — sin mensaje al jugador.
  regenHp(db.getPlayer(playerId));

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
  const GHOST_ALLOWED = new Set(['look', 'status', 'who', 'score', 'profile', 'bestiary', 'journal', 'news', 'dungeon', 'history', 'help', 'changelog', 'server', 'time', 'enemies', 'compare', 'reputation', 'path', 'guide', 'find', 'runas', 'map', 'hardcore', 'read', 'lore', 'weather', 'world', 'challenge', 'rank', 'inventory', 'memorial', 'recent']);
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
    case 'unequip':   result = cmdUnequip(player, action.args.join(' ')); break;
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
    case 'disarm':    result = cmdDisarm(player, action.args); break;
    case 'rest':      result = cmdRest(player, context); break;
    case 'meditate':  result = cmdMeditate(player); break;
    case 'emote':     result = cmdEmote(player, action.args.join(' ')); break;
    case 'dice':      result = cmdDice(player, action.args.join(' ')); break;
    case 'party':     result = cmdParty(player, action.args); break;
    case 'shop':      result = cmdShop(player); break;
    case 'buy':       result = cmdBuy(player, action.args.join(' ')); break;
    case 'sell':      result = cmdSell(player, action.args.join(' ')); break;
    case 'talk':      result = cmdTalk(player, action.args.join(' ')); break;
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
    case 'recent':       result = cmdRecent(action.args); break;
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
    case 'drink': {
      // BUG-332: si hay args (ej: "beber pocion de mana"), intentar como 'use' primero
      if (action.args && action.args.length > 0) {
        const freshP = db.getPlayer(player.id);
        const query = action.args.join(' ');
        const invItem = freshP && freshP.inventory ? items.findItem(freshP.inventory, query) : null;
        if (invItem) {
          result = cmdUse(player, query);  // BUG-338: pasar string, no array
        } else {
          // No hay ítem con ese nombre — mostrar mensaje útil
          result = { text: `🍶 No tenés ningún "${query}" en el inventario.\n💡 Para beber de la Fuente Eterna usá solo "beber" (sin argumentos). Para consumir una poción: "usar <pocion>".` };
        }
      } else {
        result = cmdDrink(player);
      }
      break;
    }
    case 'bowl':         result = cmdChapelBowl(player); break;
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
    case 'chase':        result = cmdChase(player, context); break;
    case 'trade':        result = cmdTrade(player, action.args); break;
    case 'lore':         result = cmdLore(action.args.join(' ')); break;
    case 'peek':         result = cmdPeek(player, action.args); break;
    case 'project':      result = cmdProject(player, action.args); break;
    case 'runas':        result = cmdRunas(player); break;
    case 'challenge':    result = cmdChallenge(player); break;
    case 'contract':     result = cmdContract(player); break;
    case 'macro':        result = cmdMacro(player, action.args, context); break;
    case 'afk':          result = cmdAfk(player, action.args); break;
    case 'write':        result = cmdWrite(player, action.args); break;
    case 'read': {
      // BUG-267: si hay args, intentar examinar el ítem del inventario primero
      if (action.args && action.args.length > 0) {
        const query = action.args.join(' ');
        const fresh = db.getPlayer(player.id);
        // ¿El ítem está en el inventario?
        const invItem = fresh && fresh.inventory ? items.findItem(fresh.inventory, query) : null;
        if (invItem) {
          result = cmdExamine(player, query);
        } else {
          // No está en el inventario — intentar cmdExamine normal (puede ser lore de sala)
          const examResult = cmdExamine(player, query);
          // Si cmdExamine no encontró nada específico, devolver mensaje útil
          if (examResult && examResult.text && (examResult.text.includes('No ves ningún') || examResult.text.includes('vacías'))) {
            result = { text: `📜 No encontrás "${query}" para leer aquí.\n💡 Si es un ítem del inventario, usá "examine ${query}". Si querés leer las paredes: "read" (sin argumentos).` };
          } else {
            result = examResult;
          }
        }
      } else {
        result = cmdReadWall(player);
      }
      break;
    }
    case 'greet':        result = cmdGreet(player, action.args, context); break;
    case 'search':       result = cmdSearch(player, action.args); break;
    case 'study':        result = cmdStudy(player, action.args); break;
    case 'dungeon':      result = cmdDungeonStatus(player); break;
    case 'session':      result = cmdSession(player, context); break;
    case 'sessions':     result = cmdSessions(player); break;
    case 'weekly':       result = cmdWeekly(player); break;         // T208
    case 'tips':         result = cmdTips(action.args); break;       // T209
    case 'goals':        result = cmdGoals(player); break;           // T210
    case 'legado':       result = cmdLegado(player, context); break;          // DIS-D291: legado post-boss
    case 'battlecry':    result = cmdBattlecry(player, action.args); break; // T211
    case 'champion':     result = cmdChampion(); break;                      // T212
    case 'gamble':       result = cmdGamble(player, action.args); break;     // T217
    case 'roomnote':     result = cmdRoomNote(player, action.args); break;   // T218
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
          // BUG-028: aliases para habilidades, magia y bóveda
          skills: 'skills', habilidades: 'skills', habilidad: 'skills', poderes: 'skills',
          smash: 'smash', golpetazo: 'smash',
          shield_bash: 'shield_bash', escudo_bash: 'shield_bash',
          cast: 'cast', lanzar: 'cast', hechizar: 'cast',
          vault: 'vault', boveda: 'vault', bóveda: 'vault', cofre: 'vault',
          enchant: 'enchant', encantar: 'enchant', encantamiento: 'enchant',
        };
        const canonical = COMMAND_ALIASES_MAP[cmdKey] || cmdKey;
        const detail = COMMAND_HELP[canonical];
        // DIS-D03: Normalizar saltos de línea literales (\n escapeados) a reales
        const detailText = detail ? detail.replace(/\\n/g, '\n') : null;
        result = detailText
          ? { text: detailText }
          : { text: `No hay ayuda detallada para "${cmdKey}". Escribí "help" para ver todos los comandos.` };
      } else {
        result = { text: HELP_TEXT };
      }
      break;
    case 'pronunciar':   result = cmdPronunciar(player, action.args.join(' ')); break; // DIS-487
    case 'heal':          result = cmdHeal(player, action.args); break; // DIS-496
    case 'unknown':
      // BUG-445: Pozo Sin Fondo — interceptar comandos temáticos en sala 7
      if (player.current_room_id === 7 && action.input) {
        const inp = action.input.toLowerCase();
        if (['bajar', 'saltar', 'usar cuerda', 'bajar al pozo', 'saltar al pozo', 'entrar al pozo', 'descender'].some(k => inp.includes(k))) {
          const dmg = 1;
          const freshP2 = db.getPlayer(player.id);
          const newHp2 = Math.max(1, freshP2.hp - dmg);
          db.updatePlayer(player.id, { hp: newHp2 });
          result = { text: `Intentás bajar por el borde del pozo. Tus dedos encuentran las mismas marcas de uñas del brocal —viejas, profundas.\n\nEn cuanto tus piernas cuelgan sobre el vacío, el frío te golpea desde abajo: no temperatura, sino un rechazo físico, una presión hacia arriba que empuja con la fuerza de algo que no quiere compañía.\n\nPerdés el agarre. Caés hacia atrás sobre el suelo de piedra.\n\n💥 -${dmg} HP por el impacto. (${newHp2}/${freshP2.max_hp || 30} HP)\n\nEl pozo sigue quieto. El frío permanece.` };
          break;
        }
      }
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
      // Fix DIS-P03: solo permitir salir si el jugador ya atacó al goblin (step >= 3)
      // o si el jugador elige explícitamente saltarse el tutorial (se puede saltar con 'skip tutorial')
      if (step < 3) {
        // BUG-447: Safety net — si el goblin no está en sala 16 (huyó antes del fix),
        // auto-completar el tutorial para no dejar al jugador bloqueado indefinidamente.
        const goblin = db.getMonster(20);
        if (!goblin || goblin.room_id !== 16) {
          return completeTutorial(player);
        }
        const hint = tutorial.getStepMessage(step);
        return { text: `¡Todavía no terminaste el entrenamiento!\nAntes de salir, atacá al Goblin de Práctica escribiendo: attack goblin\n\n${hint}` };
      }
      // Completar tutorial: +10 XP, mover a sala 1, tutorial_step = 0
      return completeTutorial(player);
    }
    // Intentar moverse en dirección inválida dentro de la antesala
    return { text: 'La única salida de la Antesala es hacia el sur (al dungeon real). Primero completá el entrenamiento o escribí «sur» para saltar el tutorial.' };
  }

  // Si el jugador hace help, status, inventory — dejar fluir normalmente
  // DIS-D278: también permitir 'clase' durante el tutorial para que no se repita el prompt al final
  if (['help', 'status', 'inventory', 'clear', 'clase'].includes(cmd)) {
    return null;
  }

  // Comando 'skip' para saltarse el tutorial explícitamente
  if (cmd === 'skip' || (cmd === 'tutorial' && action.args[0] === 'skip') || action.raw === 'skip tutorial' || action.raw === 'saltar tutorial') {
    return completeTutorial(player);
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
 * DIS-D278: El mensaje de completar varía según si el jugador ya eligió clase o no.
 */
function completeTutorial(player) {
  const xp = (player.xp || 0) + 10;
  const level = xpSystem.levelFromXp(xp);
  db.updatePlayer(player.id, {
    tutorial_step: 0,
    current_room_id: 1,
    xp,
    level,
  });
  // BUG-019: limpiar el suelo de la sala 16 para no acumular loot entre sesiones
  try { db.updateRoomItems(16, []); } catch (e) { /* silencioso */ }
  // DIS-D278: Leer estado fresco del jugador para saber si ya tiene clase asignada
  const freshPlayer = db.getPlayer(player.id);
  return {
    text: tutorial.getCompleteMsg(freshPlayer),
    event: `${player.username} emerge de la Antesala. ¡Un aventurero nuevo llega al dungeon!`,
    eventRoomId: 1,
  };
}

// ─── Comandos ──────────────────────────────────────────────────────────────

/**
 * look — Describe la habitación actual.
 */
function cmdLook(player) {
  // BUG-503: correr checkRespawns antes de describir la sala para que monstruos
  // recién respawneados sean visibles sin que el jugador tenga que salir y volver a entrar.
  try {
    combat.checkRespawns(() => {}, () => {});
  } catch (_) { /* no romper look si checkRespawns falla */ }

  const text = dungeon.describeRoom(player.current_room_id, player.id);
  // Mostrar efecto de sala si existe
  const roomEffect = ROOM_EFFECTS[player.current_room_id];
  const effectLine = roomEffect ? `\n🌐 Efecto de sala: ${roomEffect.label}` : '';
  // DIS-D366: la postura solo se muestra al cambiar de sala (en move), no en cada look.
  // Esto evita que contamine visualmente cada descripción de sala cuando el jugador mira repetidamente.

  // DIS-D367: indicador de quest objetivo — si hay monstruo objetivo de la quest activa en esta sala
  let questHintLine = '';
  try {
    const activeQ = quests.getActiveQuest();
    if (activeQ && activeQ.questDef && activeQ.questDef.type === 'kill' && activeQ.questDef.target) {
      const playerQ = db.getPlayer(player.id);
      const alreadyCompleted = activeQ.completedBy && activeQ.completedBy.has(player.id);
      if (!alreadyCompleted) {
        const monsters = db.getMonstersInRoom(player.current_room_id);
        const norm = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const questTarget = norm(activeQ.questDef.target);
        const hasTarget = monsters.some(m => norm(m.name).includes(questTarget));
        if (hasTarget) {
          const progress = (() => { try { const p = JSON.parse(playerQ.quest_progress || '{}'); return p.progress || 0; } catch(_) { return 0; } })();
          const goal = activeQ.questDef.goal;
          questHintLine = `\n📜 Objetivo de quest aquí: ${activeQ.questDef.target} (${progress}/${goal} eliminados)`;
        }
      }
    }
  } catch (_) { /* no romper look si quests falla */ }

  // DIS-D383: recordatorio de clase si nivel >= 3 y sin clase elegida
  let classReminderLine = '';
  if ((player.level || 1) >= 3 && (!player.player_class || player.player_class === 'sin_clase')) {
    classReminderLine = `\n💡 Aún no elegiste clase (nivel ${player.level}). Escribí 'clase' para ver las opciones.`;
  }

  // DIS-573: hint de peligro extremo en salas adyacentes a bosses que bloquean huida
  // Sirve para que el jugador pueda PREPARARSE antes de comprometerse a entrar
  // BUG-584: monsterId agregado para verificar si el boss está vivo antes de mostrar la advertencia
  const BOSS_ROOM_DANGER = {
    15: { name: 'el Lich Anciano',     level: 7, icon: '💀', roomName: 'Catedral de la Oscuridad', monsterId: 13 },
    10: { name: 'el Gólem de Piedra',  level: 5, icon: '🪨', roomName: 'Santuario Profano',        monsterId: 5  },
    8:  { name: 'el Guardia Espectral',level: 4, icon: '👻', roomName: 'Prisión Subterránea',       monsterId: 8  },
  };
  let adjacentDangerLine = '';
  try {
    const curRoom = db.getRoom(player.current_room_id);
    if (curRoom) {
      const curExits = typeof curRoom.exits === 'string' ? JSON.parse(curRoom.exits) : curRoom.exits;
      const DIR_ES = { north: 'al norte', south: 'al sur', east: 'al este', west: 'al oeste', up: 'arriba', down: 'abajo' };
      const dangerLines = [];
      for (const [dir, destId] of Object.entries(curExits)) {
        const danger = BOSS_ROOM_DANGER[destId];
        if (danger) {
          // BUG-584: verificar si el boss está efectivamente vivo antes de advertir
          // Si está muerto (en respawn), no tiene sentido alertar al jugador
          const bossMonster = db.getMonster(danger.monsterId);
          const bossIsAlive = bossMonster && bossMonster.room_id !== null && bossMonster.room_id !== undefined && (bossMonster.hp || 0) > 0;
          if (!bossIsAlive) continue; // boss muerto → sin advertencia
          const playerLevel = player.level || 1;
          if (playerLevel < danger.level) {
            dangerLines.push(`${danger.icon} PELIGRO ${DIR_ES[dir] || dir}: ${danger.roomName} — ${danger.name} (nivel recomendado: ${danger.level}+, tu nivel: ${playerLevel}). ¡Preparate antes de entrar!`);
          } else {
            dangerLines.push(`${danger.icon} ${DIR_ES[dir] || dir}: ${danger.roomName} — ${danger.name} (jefe). El combate no admite escape fácil.`);
          }
        }
      }
      if (dangerLines.length > 0) {
        adjacentDangerLine = '\n⚠️ ' + dangerLines.join('\n⚠️ ');
      }
    }
  } catch (_) { /* no romper look si falla */ }

  // DIS-D384: estado del Lich Anciano en la Catedral de la Oscuridad (sala 15)
  let lichStatusLine = '';
  if (player.current_room_id === 15) {
    try {
      // BUG-501 fix: si respawnReady es true (timer ya pasó pero checkRespawns aún no corrió),
      // forzar el respawn inmediato para que el boss ya esté en la sala cuando se muestra el look.
      let bossStatus = getBossStatus();
      if (!bossStatus.alive && bossStatus.respawnReady) {
        combat.checkRespawns(() => {}, () => {});
        bossStatus = getBossStatus(); // re-leer estado tras respawn forzado
      }
      if (bossStatus.alive) {
        // DIS-526: indicador de dificultad para el Lich (boss sin señal previa de nivel)
        const playerLevel = player.level || 1;
        const diffHint = playerLevel < 7
          ? `\n⚠️ Lich Anciano — Jefe Final. Nivel recomendado: 7+. (Tu nivel: ${playerLevel}) Preparate bien antes de atacar.`
          : `\n💀 Lich Anciano — Jefe Final. Nivel recomendado: 7+. Tiene dos fases (segunda se activa al 50% HP: +ATK +DEF). Buena suerte.`;
        lichStatusLine = diffHint;
      } else if (!bossStatus.alive && bossStatus.inRespawn) {
        const secsLeft = Math.max(0, Math.ceil((bossStatus.respawnAt - Date.now()) / 1000));
        const mins = Math.floor(secsLeft / 60);
        const secs = secsLeft % 60;
        const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
        lichStatusLine = `\n💀 La oscuridad de la catedral palpita... El Lich Anciano fue derrotado. Regresará en ${timeStr}.`;
      } else if (!bossStatus.alive && bossStatus.respawnReady) {
        // Caso extremo: el respawn forzado falló (p. ej. respawn_room_id nulo) — mostrar mensaje genérico
        lichStatusLine = `\n⚡ La oscuridad hierve — el Lich Anciano está a punto de reaparecer.`;
      }
    } catch (_) {}
  }

  return { text: text + effectLine + questHintLine + classReminderLine + adjacentDangerLine + lichStatusLine };
}

/**
 * move <dir> — Mover al jugador a otra habitación.
 */
function cmdMove(player, direction) {
  if (!direction) {
    return { text: 'Indicá una dirección. Ej: "move norte" o simplemente "norte".' };
  }

  // Fix DIS-P05 + BUG-012: decrementar/limpiar debuffs por turno al moverse fuera de combate
  try {
    const fx = player.status_effects || {};
    const newFx = { ...fx };
    let fxChanged = false;

    // Ceguera: limpiar al salir de combate
    if (newFx.blinded) {
      delete newFx.blinded;
      fxChanged = true;
    }

    // Veneno: decrementar turno por movimiento (fuera de combate)
    if (newFx.poisoned) {
      newFx.poisoned = { ...newFx.poisoned };
      newFx.poisoned.turns = (newFx.poisoned.turns || 1) - 1;
      if (newFx.poisoned.turns <= 0) {
        delete newFx.poisoned;
      }
      fxChanged = true;
    }

    // Enredado: decrementar también
    if (newFx.webbed) {
      newFx.webbed = { ...newFx.webbed };
      newFx.webbed.turns = (newFx.webbed.turns || 1) - 1;
      if (newFx.webbed.turns <= 0) {
        delete newFx.webbed;
      }
      fxChanged = true;
    }

    if (fxChanged) {
      db.updatePlayer(player.id, { status_effects: JSON.stringify(newFx) });
      player.status_effects = newFx;
    }
  } catch (_) {}

  const room = db.getRoom(player.current_room_id);
  if (!room) {
    return { text: 'Error: tu habitación actual no existe en la BD.' };
  }

  // BUG-287: Validar que la dirección existe ANTES de chequear monstruos.
  // Si la dirección es inválida, mostrar error sin intentar huir.
  const exitCheck = dungeon.resolveExit(room, direction);
  if (exitCheck === null) {
    const dirName = dungeon.DIR_NAMES[dungeon.normalizeDirection(direction)] || direction;
    return { text: `No hay salida hacia el ${dirName}. Salidas disponibles: ${dungeon.exitsText(room)}.` };
  }

  // BUG-285: Si hay monstruos vivos en la sala actual, mover es huida — aplicar tryFlee
  const monstersHere = db.getMonstersInRoom(player.current_room_id);
  // BUG-302: Los maniquíes de entrenamiento (sala 21) no deben bloquear el movimiento
  // BUG-309: El Goblin de Práctica de la Antesala (id=20) tampoco debe bloquear
  const aliveHere = monstersHere.filter(m => m.hp > 0 && !NON_BLOCKING_MONSTER_IDS.has(m.id));
  if (aliveHere.length > 0) {
    // Elegir el monstruo más amenazante (mayor HP) para la narrativa de huida
    const monster = aliveHere.sort((a, b) => b.hp - a.hp)[0];
    const fleeResult = combat.tryFlee(player, monster, room, direction); // BUG-345: pasar dirección elegida
    // BUG-518: resetear killStreak si el jugador murió huyendo al moverse
    if (fleeResult.playerDied) {
      killStreakMap.set(player.id, 0);
    }
    const nameList = aliveHere.map(m => m.name).join(', ');
    // BUG-459 / BUG-550: aclarar que el movimiento inicia una huida, mostrar resultado después
    // BUG-565: solo mostrar "¡Huís!" si la huida realmente funcionó — si no, solo el mensaje de fallo
    const fleeNote = fleeResult.fled
      ? (aliveHere.length > 1
          ? `⚔️ ¡Huís de ${aliveHere.length} monstruos activos (${nameList})!\n`
          : `⚔️ ¡Huís del combate! (💡 También podés usar "flee" directamente.)\n`)
      : '';
    return {
      text: `${fleeNote}${fleeResult.line}`,
      event: fleeResult.fled
        ? `${player.username} huye de la sala.`
        : `${player.username} intenta escapar pero falla.`,
      eventRoomId: player.current_room_id,
      ...(fleeResult.globalEvent ? { globalEvent: fleeResult.globalEvent } : {}),
    };
  }

  const exit = exitCheck; // ya validado arriba (BUG-287)

  const { targetId, key } = exit;

  // DIS-527: Si el jugador está en sala 15 (Catedral) y quiere ir "abajo" con el Lich vivo,
  // dar mensaje explicativo antes de procesar la huida normal.
  if (player.current_room_id === 15 && dungeon.normalizeDirection(direction) === 'down') {
    const lichInRoom = db.getMonstersInRoom(15).find(m => m.hp > 0 && m.name && m.name.toLowerCase().includes('lich'));
    if (lichInRoom) {
      return {
        text: `💀 El Lich Anciano bloquea el paso hacia la Cripta de los Valientes.\n\nSu presencia llena el corredor con un frío que va más allá de la temperatura. La escalera de piedra está justo ahí —pero moverse hacia ella con el Lich vivo sería... imprudente.\n\n⚔️ Deberás derrotarlo primero.`,
      };
    }
  }


  if (key) {
    const inventory = player.inventory || [];
    const hasKey = inventory.some(item => item.toLowerCase() === key.toLowerCase());
    if (!hasKey) {
      const dirName = dungeon.DIR_NAMES[dungeon.normalizeDirection(direction)] || direction;
      // DIS-D42: Si es la puerta del Pozo (sala 7 → norte), agregar pista de ruta alternativa
      const isPozo = player.current_room_id === 7 && dungeon.normalizeDirection(direction) === 'north';
      const altRouteHint = isPozo
        ? `\n\n💡 Podés conseguir la llave:\n  • Comprándola a Aldric (sala 4) por 20g\n  • Buscando en la Prisión (sala 8)\n  • Matando la Araña Tejedora de esta sala (15% de chance)\n\n🗺 Ruta alternativa (sin llave): Entrada → este → Capilla → norte → Túnel de Hongos → norte → Sala del Trono → este → Santuario.\n\n(Tip: "examine puerta" para más detalles.)`
        : '';
      return {
        text: `La salida hacia el ${dirName} está bloqueada. 🔒\nNecesitás: "${key}" para abrirla.${altRouteHint}`,
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
  let cartogAchLines = '';
  if (freshForCartog) {
    const cartogAchs = ach.checkAchievements(freshForCartog, {});
    // DIS-D30 fix: incluir logros nuevos (Cartógrafo, etc.) en la respuesta del move
    if (cartogAchs && cartogAchs.length > 0) {
      cartogAchLines = ach.formatNewAchievements(cartogAchs);
      // Registrar en crónica y diario
      for (const a of cartogAchs) {
        db.logGlobalEvent('achievement', `🏅 ${player.username} desbloqueó el logro \"${a.name}\".`);
        db.addJournalEntry(player.id, 'achievement', `🏅 Logro desbloqueado: \"${a.name}\".`);
      }
    }
  }

  // T165: Mensaje de primera visita permanente
  const firstVisitEver = visitResult.isNew;

  // T141: Desafío diario de salas visitadas
  // Fix BUG-039: usar visitResult.isNew en lugar de roomsVisited.includes(targetId)
  // porque trackRoomVisit ya agregó la sala antes de este check → includes() siempre era true → amount siempre 0
  const roomsCr = db.updateDailyChallengeProgress(player.id, 'rooms', null, visitResult.isNew ? 1 : 0);
  // (Solo suma si es una sala nueva en esta sesión; el progreso se acumula naturalmente)

  // ── T160/DIS-D372: XP por exploración permanente ──────────────────────────
  // +2 XP la primera vez que se visita una sala (permanente, no por sesión)
  // visitResult.isNew indica si es la primera vez en total (usa rooms_visited en BD)
  let explorationMsg = '';
  if (firstVisitEver) {
    const freshExp = db.getPlayer(player.id);
    const newXp = (freshExp.xp || 0) + 2;
    const newLevel = xpSystem.levelFromXp(newXp);
    const levelUp = newLevel > (freshExp.level || 1);
    const upd = { xp: newXp, level: newLevel };
    if (levelUp) {
      upd.max_hp = (freshExp.max_hp || 30) + 5;
      const healExp = Math.ceil(upd.max_hp * 0.20);
      upd.hp = Math.min(upd.max_hp, (freshExp.hp || 1) + healExp);
      upd.attack = (freshExp.attack || 5) + 1;
    }
    db.updatePlayer(player.id, upd);
    explorationMsg = `\n🗺️ ¡Primera vez que explorás esta sala! +2 XP de explorador. 🌟 (${visitResult.visited.length} salas descubiertas en total)${levelUp ? ` ✨ ¡SUBÍS AL NIVEL ${newLevel}!` : ''}`;
  }

  // Construir respuesta
  const moveText = `Vas hacia el ${dungeon.DIR_NAMES[dungeon.normalizeDirection(direction)] || direction}.`;
  const roomDesc = dungeon.describeRoom(targetId, player.id);

  // ── Verificar trampa en la sala destino ─────────────────────────────────
  let trapText = '';
  let trapWasAvoided = false; // BUG-339: trackear si la trampa fue esquivada para suprimir debuff de sala
  const targetRoomFull = db.getRoom(targetId);
  // T120: si el jugador tiene mascota, 15% de chance de avisar la trampa antes de activarse
  if (targetRoomFull && targetRoomFull.trap && targetRoomFull.trap.active) {
    const trap = targetRoomFull.trap;
    // DIS-D370: conocimiento de trampas persistente entre sesiones.
    // Primero verificar en known_traps (permanente), luego en status_effects (cooldown temporal legacy).
    // DIS-D43/DIS-D279: cooldown personal de trampa — el jugador recuerda la trampa
    // DIS-D307: aumentado a 30 minutos (antes 90s).
    const knownTraps = player.known_traps || {};
    const statusEff = player.status_effects || {};
    const trapCdKey = `trap_cd_${targetId}`;
    const trapCdExpiry = statusEff[trapCdKey] ? new Date(statusEff[trapCdKey]).getTime() : 0;
    // Trampa conocida: persistente (known_traps) O cooldown activo (legacy)
    const trapKnown = knownTraps[targetId] === true || trapCdExpiry > Date.now();
    if (trapKnown) {
      // DIS-D307: si ya conoce la trampa, la esquiva siempre (era 80% antes).
      // El jugador aprendió el mecanismo — no tiene sentido que siga haciéndole daño.
      trapText = `\n\n🧠 Recordás la trampa de esta sala. Con cuidado, la esquivás sin problema.`;
      trapWasAvoided = true; // BUG-339: trampa esquivada por memoria → no aplicar debuff de sala
    // Aviso de mascota (T120): 15% de chance de prevenir el daño
    } else if (player.pet && Math.random() < 0.15) {
      trapText = `\n\n🐾 ¡Tu ${player.pet} te advierte a tiempo! Evitás la trampa: ${trap.description.split('–')[0].trim()}.`;
      trapWasAvoided = true; // BUG-339: trampa evitada por mascota → no aplicar debuff de sala
    } else {
      // DIS-451: línea atmosférica de advertencia antes de activar la trampa (pista implícita)
      const TRAP_ATMOSPHERE = {
        6:  '👃 Algo en el aire te hace cosquillear la nariz — un olor acre y punzante, como esporas que no deberían estar aquí en esta concentración.',
        9:  '🥶 Un frío antinatural te golpea antes de que tus ojos puedan adaptarse a la oscuridad de la sala.',
        3:  '🦶 El suelo cede levemente bajo tu primer paso — como si algo aguardara la presión exacta.',
        13: '💧 Un sonido de agua en movimiento llega desde las paredes. Demasiado rápido para ser natural.',
      };
      const atmosphereHint = TRAP_ATMOSPHERE[targetId] || null;

      // Refrescar jugador para HP actualizado
      player = db.getPlayer(player.id);
      // DIS-D279: daño con leve varianza para que nunca sea exactamente predecible
      const variantDmg = Math.max(1, trap.damage + (Math.random() < 0.33 ? 1 : Math.random() < 0.5 ? -1 : 0));
      const newHp = Math.max(0, player.hp - variantDmg);
      // DIS-D370: guardar en known_traps (permanente) para que persista entre sesiones
      const updatedKnownTraps = { ...(player.known_traps || {}), [targetId]: true };
      // También mantener cooldown legacy por compatibilidad (30 min)
      const updatedSE = { ...(player.status_effects || {}), [trapCdKey]: new Date(Date.now() + 1800 * 1000).toISOString() };
      db.updatePlayer(player.id, { hp: newHp, status_effects: JSON.stringify(updatedSE), known_traps: JSON.stringify(updatedKnownTraps) });

      // DIS-451/452: tip personalizado según la trampa — indica dónde obtener el ítem de desactivación
      const TRAP_DISARM_HINT = {
        6:  '💡 Para desactivarla: un "hongo azul" neutraliza las esporas. Podés buscar uno en esta misma sala (intentá "buscar"), o descansando en la Galería de Hielo más adelante.\n🧠 Próxima vez que veas el hint de trampa al norte, podés escribir "desactivar trampa norte" antes de entrar.',
        9:  '💡 Para desactivarla: una "corona rota" como ofrenda al trono disipa el frío. Buscá en esta sala (intentá "buscar").\n🧠 Próxima vez que veas el hint de trampa en la Sala del Trono, podés escribir "desactivar trampa <dir>" antes de entrar.',
        3:  '💡 Para desactivarla: una "cuerda" bloquea el mecanismo. Revisá el Pozo Sin Fondo (sala oeste del Corredor).\n🧠 Próxima vez que veas el hint de trampa al oeste, podés escribir "desactivar trampa oeste" antes de entrar.',
        13: '💡 Para desactivarla: una "red de pesca" bloquea los conductos. Buscá en esta sala o en los alrededores del Lago.\n🧠 Próxima vez que veas el hint de trampa en el Lago, podés escribir "desactivar trampa <dir>" antes de entrar.',
      };
      const disarmHint = TRAP_DISARM_HINT[targetId] || '💡 Tip: escribí "desactivar trampa" con el ítem correcto en tu inventario para desactivarla permanentemente.';

      const atmoPrefix = atmosphereHint ? `\n\n${atmosphereHint}` : '';
      trapText = `${atmoPrefix}\n\n⚠️  ¡TRAMPA! ${trap.description}\n💥 Perdés ${variantDmg} HP. (${newHp}/${player.max_hp} HP)\n🧠 Ahora recordás el mecanismo — no volverá a sorprenderte (incluso entre sesiones).\n${disarmHint}`;
      if (newHp === 0) {
        // BUG-006 fix: usar handlePlayerDeath para registrar deaths correctamente
        const trapDeathLines = [];
        combat.handlePlayerDeath(player.id, trapDeathLines, `trampa en sala ${targetId}`);
        // Restaurar HP completo si no está en hardcore (handlePlayerDeath ya maneja el respawn)
        const afterDeath = db.getPlayer(player.id);
        if (afterDeath && afterDeath.fallen !== 1 && afterDeath.current_room_id !== 1) {
          db.updatePlayer(player.id, { hp: afterDeath.max_hp || 30, current_room_id: 1 });
        }
        trapText += '\n☠️  Has muerto a causa de la trampa. Renacés en la Entrada.';
        if (trapDeathLines.length > 0) trapText += '\n' + trapDeathLines.join('\n');
      }
      // (el hint específico ya se agregó en trapText arriba — no agregar el genérico)
    }
  }

  // ── Efecto pasivo de sala (T087) ─────────────────────────────────────────
  let effectText = '';
  const roomEffect = ROOM_EFFECTS[targetId];
  if (roomEffect) {
    player = db.getPlayer(player.id);
    if (roomEffect.type === 'damage') {
      // DIS-D403: Para sala 12 (Calor Abrasador), el daño solo se aplica la primera vez.
      // En visitas posteriores, el jugador ya "sabe" protegerse y solo recibe un recordatorio.
      // DIS-509: Para sala 15 (Catedral Maldita), el daño solo se aplica 1 vez por sesión.
      // El jugador que vuelve para loot del Lich no debería ser penalizado en bucle.
      const FIRST_TIME_DAMAGE_ROOMS = new Set([12, 15]); // rooms donde el daño es solo primera vez
      // BUG-486/BUG-502: known_traps puede ser array (sistema de calor) u objeto (sistema de trampas).
      // NOTA: db.getPlayer() ya parsea known_traps a objeto JS, por lo que player.known_traps NO es string.
      // Normalizar siempre a array de strings para hacer el check con includes().
      const knownRoomsData = (() => {
        try {
          const raw = player.known_traps;
          if (!raw) return [];
          // Si ya es objeto JS (getPlayer lo parsea automáticamente)
          if (typeof raw === 'object' && !Array.isArray(raw)) return Object.keys(raw);
          if (Array.isArray(raw)) return raw; // formato array legacy ["heat_room_12"]
          // Si por alguna razón llegó como string (ej: primer acceso antes del parse)
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) return parsed;
          if (typeof parsed === 'object' && parsed !== null) return Object.keys(parsed);
          return [];
        } catch (_) { return []; }
      })();
      const heatKey = `heat_room_${targetId}`;
      const alreadyKnowsHeat = FIRST_TIME_DAMAGE_ROOMS.has(targetId) && Array.isArray(knownRoomsData) && knownRoomsData.includes(heatKey);
      if (alreadyKnowsHeat) {
        // BUG-486: Segunda y posteriores visitas — daño reducido o nulo con mensaje inmersivo
        // DIS-512: Sala 15 (Catedral) — sin daño en revisitas (la maldición pierde fuerza)
        const REVISIT_NO_DAMAGE = new Set([15]);
        const reducedDamage = REVISIT_NO_DAMAGE.has(targetId) ? 0 : 1; // Sala 15: 0, Sala 12: 1
        const newHpKnown = Math.max(1, player.hp - reducedDamage);
        if (reducedDamage > 0) db.updatePlayer(player.id, { hp: newHpKnown });
        const revisitMsgs = {
          12: `🔥 Ya conocés el calor de la forja y te cubrís la cara al entrar. Aun así, el ambiente abrasador te afecta. (-${reducedDamage} HP · ${newHpKnown}/${player.max_hp} HP)`,
          15: `💀 La maldición de la Catedral te roza... pero ya sabés cómo resistirla. El frío oscuro no penetra esta vez.`,
        };
        effectText = `\n\n${revisitMsgs[targetId] || `Ya conocés este lugar. El efecto es menor. (-${reducedDamage} HP · ${newHpKnown}/${player.max_hp} HP)`}`;
      } else {
        const newHp = Math.max(1, player.hp - roomEffect.amount); // mínimo 1 HP (no mata)
        db.updatePlayer(player.id, { hp: newHp });
        effectText = `\n\n${roomEffect.msg} (${newHp}/${player.max_hp} HP)`;
        // Si es una sala de daño primera-vez, registrar que ya la conoce
        // BUG-502: guardar en formato objeto (mismo que el sistema de trampas) para evitar incompatibilidad
        if (FIRST_TIME_DAMAGE_ROOMS.has(targetId)) {
          const existingKnown = (() => {
            try {
              const parsed = JSON.parse(player.known_traps || '{}');
              if (typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
              if (Array.isArray(parsed)) {
                // migrar array a objeto
                const obj = {};
                parsed.forEach(k => { obj[k] = true; });
                return obj;
              }
              return {};
            } catch (_) { return {}; }
          })();
          const updatedKnown = { ...existingKnown, [heatKey]: true };
          db.updatePlayer(player.id, { known_traps: JSON.stringify(updatedKnown) });
          // DIS-528: mensaje de aprendizaje específico por sala (no usar mensaje de forja en Catedral)
          const learnMsgs = {
            12: `\n🧠 Ahora conocés el calor de la forja — la próxima vez podrás cubrirte mejor.`,
            15: `\n🧠 Ahora conocés la maldición de la Catedral — la próxima vez la oscuridad no te alcanza igual.`,
          };
          effectText += learnMsgs[targetId] || `\n🧠 Recordás este lugar. La próxima vez estarás mejor preparado.`;
        }
      }
    } else if (roomEffect.type === 'heal') {
      const newHp = Math.min(player.max_hp, player.hp + roomEffect.amount);
      db.updatePlayer(player.id, { hp: newHp });
      effectText = `\n\n${roomEffect.msg} (${newHp}/${player.max_hp} HP)`;
    } else if (roomEffect.type === 'debuff') {
      // BUG-339: Si la trampa de esta sala fue esquivada por memoria o mascota,
      // no mostrar el debuff narrativo (el jugador evitó el peligro conscientemente).
      if (!trapWasAvoided) {
        // Debuff temporal narrativo — en futuro se integraría con status_effects
        effectText = `\n\n${roomEffect.msg}`;
      }
    }
  }

  // T207/STORY-018: Eventos cinemáticos de primera visita para salas especiales
  const CINEMATIC_EVENTS = {
    3:  '🗿 Al entrar a la Sala de los Ecos, escuchás tu propio nombre. Claramente. Nadie más está aquí. La sala te devuelve exactamente lo que dijiste —excepto eso. Nunca dijiste tu nombre en voz alta.',
    9:  '👑 Al cruzar el umbral de la Sala del Trono, la temperatura cae varios grados. El trono de huesos al fondo te mira sin ojos. Tenés la certeza, irracional pero absoluta, de que ese trono no siempre estuvo vacío. Y de que quien lo usaba sabe que estás aquí.\n\n💡 Notás una puerta al este, más pesada que las anteriores. Parece llevar a zonas más profundas del dungeon. Aquí empieza lo desconocido. Y si caés — recordá que la muerte en este dungeon no es el final. Tu espíritu regresará a la Entrada de la Cripta para intentarlo de nuevo.',
    10: '🩸 El Santuario Profano te recibe en un silencio que no es ausencia de sonido sino presencia de algo más. La estatua con diez brazos no te mira — te cataloga. Las runas en el suelo forman un nombre que creés poder leer aunque nunca hayas visto ese idioma. El aire sabe a cera quemada y tiempo.',
    11: '❄️ La Galería de Hielo detiene tu respiración. Las paredes de cristal azul reflejan tu imagen distorsionada en docenas de ángulos. En uno de los reflejos, tu imagen te devuelve la mirada... medio segundo antes que vos.',
    12: '🔥 Antes de ver la forja, la sentís. No es solo calor — es algo más persistente, más profundo. Como la respiración de algo que no debería seguir vivo. El fuego en el centro no proyecta sombras normales. Las sombras se mueven solas.',
    14: '🦴 El Coliseo de Huesos te recibe con el silencio de mil batallas perdidas. Gradas de huesos apilados se elevan hacia la oscuridad. Podés sentir el peso de todos los gladiadores que murieron aquí — sus espíritus aún esperan un digno rival que los vengue.',
    15: '⛪ A medida que cruzás el umbral de la Catedral de la Oscuridad, el eco de tus pasos revela la inmensidad del lugar. Las vidrieras rotas dejan entrar rayos de luz violácea. Sentís el peso de siglos de oscuridad posarse sobre tus hombros.',
    20: '🕳️ Al asomarte al Abismo Eterno, el vacío te mira de vuelta. No hay fondo visible. Solo oscuridad infinita, y el certero presentimiento de que algo muy antiguo — y muy hambriento — acaba de notar tu presencia.',
    22: '🪦 La Cripta de los Valientes te recibe en silencio. Las placas en las paredes murmuran nombres olvidados. Una voz que no existe te susurra: "¿Serás digno de ser recordado aquí, o morirás en el anonimato?"',
  };

  const cinematicEvent = (firstVisitEver && CINEMATIC_EVENTS[targetId])
    ? `\n\n✨ ${CINEMATIC_EVENTS[targetId]}`
    : '';

  // T165: Badge de primera visita permanente — fusionado en explorationMsg para evitar duplicar texto
  const firstVisitMsg = '';

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

  // DIS-D396: la postura NO se muestra al moverse entre salas (DIS-D366 implementado, fix final)
  // La postura solo se muestra al cambiarla explícitamente con el comando stance.

  // DIS-D353: Aviso de zona avanzada cuando el jugador es nivel < 5 y entra a salas 11-15
  const ADVANCED_ZONE_IDS = [11, 12, 13, 14, 15];
  const levelWarnMsg = (ADVANCED_ZONE_IDS.includes(targetId) && (player.level || 1) < 5)
    ? `\n\n⚠️ **Zona peligrosa** — Esta área es para aventureros nivel 5+. Sos nivel ${player.level || 1}. Los enemigos aquí pueden matarte en pocos turnos.`
    : '';

  // DIS-449: Recuperación pasiva de maná para Mago al entrar a sala sin monstruos.
  // Si la sala destino no tiene monstruos activos, el Mago recupera 10% del max_mana.
  // Representa el breve momento de calma para concentrarse entre encuentros.
  let passiveManaMsg = '';
  {
    const freshForMana = db.getPlayer(player.id);
    const clsForMana = classes.getPlayerClass(freshForMana);
    if (clsForMana && clsForMana.name === 'Mago') {
      const monstersInTarget = db.getMonstersInRoom(targetId);
      const aliveInTarget = monstersInTarget.filter(m => m.hp > 0);
      if (aliveInTarget.length === 0) {
        const curMana = freshForMana.mana != null ? freshForMana.mana : 0;
        const maxMana = freshForMana.max_mana || 20;
        if (curMana < maxMana) {
          const manaRestore = Math.max(1, Math.floor(maxMana * 0.15)); // DIS-493: subido de 0.10 a 0.15
          const newMana = Math.min(maxMana, curMana + manaRestore);
          const restored = newMana - curMana;
          db.updatePlayer(player.id, { mana: newMana });
          passiveManaMsg = `\n💧 En la calma de la sala, tu concentración se recupera. +${restored} maná. (${newMana}/${maxMana} 🔮)\n`;
        }
      }
    }
  }

  return {
    text: `${moveText}\n${passiveManaMsg}${roomDesc}${trapText}${effectText}${explorationMsg}${firstVisitMsg}${cinematicEvent}${levelWarnMsg}${extremeWeatherMsg}${cartogAchLines}`,
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
  // BUG-349: refrescar para tener equipped_armor/equipped_weapon actualizados
  player = db.getPlayer(player.id) || player;

  // Los ítems equipados no están en player.inventory (se remueven al equipar).
  // Para que el jugador no piense que los perdió, los mostramos en la lista marcados.
  const equippedWeapon = (player.equipped_weapon && player.equipped_weapon !== 'null') ? player.equipped_weapon : null;
  const equippedArmor  = (player.equipped_armor  && player.equipped_armor  !== 'null') ? player.equipped_armor  : null;

  const allItems = [...(player.inventory || [])];
  // Añadir equipados al principio de la lista (con marcador)
  const equippedItems = [];
  if (equippedWeapon) equippedItems.push({ name: equippedWeapon, slot: 'arma' });
  if (equippedArmor)  equippedItems.push({ name: equippedArmor,  slot: 'armadura' });

  const hasAnything = allItems.length > 0 || equippedItems.length > 0;
  if (!hasAnything) {
    return { text: 'Tu inventario está vacío.' };
  }

  const lines = [];
  let idx = 1;
  // Primero los equipados (con marcador visual)
  for (const eq of equippedItems) {
    const emoji = items.getRarityEmoji(eq.name);
    const rarity = items.getItemRarity(eq.name);
    const rarityLabel = rarity !== 'común' ? ` (${rarity})` : '';
    lines.push(`  ${idx}. ${emoji} ${eq.name}${rarityLabel} [equipado — ${eq.slot}]`);
    idx++;
  }
  // Luego el resto del inventario
  for (const item of allItems) {
    const emoji = items.getRarityEmoji(item);
    const rarity = items.getItemRarity(item);
    const rarityLabel = rarity !== 'común' ? ` (${rarity})` : '';
    // DIS-D428: marcar ítems de crafteo con ⚗️ para que el jugador sepa su propósito
    const def = items.getItemDef(item);
    const craftTag = (def && def.description && (def.description.includes('crafteo') || def.description.includes('🔧'))) ? ' ⚗️' : '';
    lines.push(`  ${idx}. ${emoji} ${item}${rarityLabel}${craftTag}`);
    idx++;
  }

  // Resumen al final
  const totalVisible = lines.length;
  const rareCount = allItems.filter(i => items.getItemRarity(i) !== 'común').length
    + equippedItems.filter(e => items.getItemRarity(e.name) !== 'común').length;
  const summary = rareCount > 0
    ? `─ ${totalVisible} ítem${totalVisible !== 1 ? 's' : ''} (${rareCount} no común${rareCount !== 1 ? 'es' : ''})`
    : `─ ${totalVisible} ítem${totalVisible !== 1 ? 's' : ''}`;

  return { text: `Inventario:\n${lines.join('\n')}\n${summary}` };
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
  const xpBar  = buildBar(xpSystem.xpIntoLevel(xp, level), xpSystem.xpForNextLevel(level), 10);
  const repLevel = db.getReputationLevel(player.reputation || 0);
  const repNextText = repLevel.nextThreshold
    ? ` (+${repLevel.nextThreshold - repLevel.points} pts para siguiente)`
    : ' (máx)';
  const weaponLine = player.equipped_weapon && player.equipped_weapon !== 'null'
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
    // BUG-505: last_flee es metadata de rastreo interna, no un buff visible para el jugador
    if (effect === 'last_flee') continue;
    if (data.expires_at > now) {
      const secsLeft = Math.ceil((data.expires_at - now) / 1000);
      const parts = [];
      if (data.atk_bonus > 0) parts.push(`+${data.atk_bonus} ATK`);
      if (data.def_bonus > 0) parts.push(`+${data.def_bonus} DEF`);
      // BUG-027: agregar propiedades especiales de encantamientos de runa
      if (data.crit_bonus > 0) parts.push(`+${Math.round(data.crit_bonus * 100)}% crit`);
      if (data.slow_chance > 0) parts.push(`${Math.round(data.slow_chance * 100)}% ralentizar`);
      if (data.hp_on_kill > 0) parts.push(`+${data.hp_on_kill} HP por kill`);
      // BUG-027: nombres descriptivos para encantamientos de runa según tipo
      const enchantTypeNames = {
        fuego: '🔥 Encantamiento de Fuego', hielo: '❄️ Encantamiento de Hielo',
        sombra: '🌑 Encantamiento de Sombra', luz: '✨ Encantamiento de Luz',
        caos: '🌀 Encantamiento del Caos'
      };
      let effectLabel;
      if (effect === 'weapon_enchant') {
        effectLabel = enchantTypeNames[data.type] || '✨ Encantamiento';
      } else {
        const effectNames = {
          fury: '📜 FURIA',
          shield: '📜 ESCUDO MÁGICO',
          speed: '📜 VELOCIDAD',
          power: '⚡ POCIÓN DE PODER',
          altar_blessing: '🙏 BENDICIÓN DE ALTAR',
        };
        // BUG-490: si el dato tiene label propio (ej: altar_blessing), usarlo primero
        effectLabel = effectNames[effect] || (data.label ? `✨ ${data.label}` : '📜 BUFF');
      }
      const partsStr = parts.length > 0 ? ` — ${parts.join(', ')}` : '';
      statusLines.push(`${effectLabel}${partsStr} por ${secsLeft}s más.`);
    }
  }

  // DIS-D383: recordatorio de clase si nivel >= 3 y sin clase elegida
  if ((player.level || 1) >= 3 && (!player.player_class || player.player_class === 'sin_clase')) {
    statusLines.unshift(`💡 Aún no elegiste clase (nivel ${player.level}). Escribí 'clase' para ver las opciones.`);
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
    `XP sig.:  ${xpBar} ${xpSystem.xpIntoLevel(xp, level)}/${xpSystem.xpForNextLevel(level)}`,
    `HP:       ${hpBar} ${player.hp}/${player.max_hp}`,
    (() => {
      // BUG-049: mostrar maná en status para Mago u otros jugadores con max_mana > 20
      const maxMana = player.max_mana || 0;
      if (maxMana > 20 || (player.player_class === 'mago')) {
        const mana = player.mana || 0;
        const manaBar = buildBar(mana, maxMana || 1, 20);
        return `Maná:     ${manaBar} ${mana}/${maxMana}`;
      }
      return null;
    })(),
    (() => {
      // BUG-011: mostrar ATK efectivo con todos los buffs activos
      const scrollsStatus = JSON.parse(player.active_scrolls || '{}');
      const nowStatus = Date.now();
      const STANCE_ATK = { agresivo: +2, defensivo: -1, equilibrado: 0 };
      let atkBuffTotal = 0;
      for (const data of Object.values(scrollsStatus)) {
        if (data.expires_at > nowStatus) atkBuffTotal += (data.atk_bonus || 0);
      }
      const stanceAtkMod = STANCE_ATK[player.stance || 'equilibrado'] || 0;
      const petAtk = player.pet ? 1 : 0;
      const totalBonus = atkBuffTotal + stanceAtkMod + petAtk;
      const effectiveAtk = player.attack + totalBonus;
      if (totalBonus !== 0) {
        const bonusParts = [];
        if (petAtk) bonusParts.push(`+1 🐾`);
        if (atkBuffTotal > 0) bonusParts.push(`+${atkBuffTotal} 📜buff`);
        if (stanceAtkMod > 0) bonusParts.push(`+${stanceAtkMod} postura`);
        else if (stanceAtkMod < 0) bonusParts.push(`${stanceAtkMod} postura`);
        return `Ataque:   ${player.attack} (${bonusParts.join(', ')} = ${effectiveAtk} efectivo)`;
      }
      return `Ataque:   ${player.attack}`;
    })(),
    (() => {
      // BUG-016: mostrar DEF efectiva con buffs activos (igual que BUG-011 para ATK)
      const scrollsDef = JSON.parse(player.active_scrolls || '{}');
      const nowDef = Date.now();
      const STANCE_DEF = { agresivo: -1, defensivo: +2, equilibrado: 0 };
      let defBuffTotal = 0;
      for (const data of Object.values(scrollsDef)) {
        if (data.expires_at > nowDef) defBuffTotal += (data.def_bonus || 0);
      }
      const stanceDefMod = STANCE_DEF[player.stance || 'equilibrado'] || 0;
      const totalDefBonus = defBuffTotal + stanceDefMod;
      const effectiveDef = (player.defense || 0) + totalDefBonus;
      if (totalDefBonus !== 0) {
        const defParts = [];
        if (defBuffTotal > 0) defParts.push(`+${defBuffTotal} 📜buff`);
        if (stanceDefMod > 0) defParts.push(`+${stanceDefMod} postura`);
        else if (stanceDefMod < 0) defParts.push(`${stanceDefMod} postura`);
        return `Defensa:  ${player.defense} (${defParts.join(', ')} = ${effectiveDef} efectiva)`;
      }
      return `Defensa:  ${player.defense}`;
    })(),
    `Oro:      💰 ${gold}g`,
    weaponLine,
    player.equipped_armor && player.equipped_armor !== 'null'
      ? `Armadura: 🛡 ${player.equipped_armor}`
      : `Armadura: (sin armadura — defensa base)`,
    (() => {
      const stanceName = player.stance || 'equilibrado';
      const st = (typeof STANCES !== 'undefined' ? STANCES : {})[stanceName];
      return st ? `Postura:  ${st.icon} ${stanceName}` : null;
    })(),
    duelWins === 0 && duelLosses === 0
      ? `Duelos:   ⚔️ 0 ganados / 0 perdidos  (💡 usá "duel <nombre>" para retar a alguien en tu sala)`
      : `Duelos:   ⚔️ ${duelWins} ganados / ${duelLosses} perdidos`,
    `Reputación: ${repLevel.icon} ${repLevel.name} (${repLevel.points} pts)${repNextText}`,
    `Ubicación: ${roomName}`,
    player.guild ? `Hermandad: [${player.guild}]` : `Hermandad: (sin guild)`,
    player.pet   ? `Mascota:   ${player.pet}` : `Mascota:   (sin compañero)`,
    (() => {
      const streak = killStreakMap.get(player.id) || 0;
      return streak >= 3 ? `Racha:    🔥 ${streak} kills consecutivos` : null;
    })(),
    (() => {
      // DIS-542: mostrar combo actual en status
      const combo = comboMap.get(player.id);
      if (!combo || combo.count < 2) return null;
      const levelCap = Math.ceil((player.level || 1) / 4);
      const bonusDmg = Math.min(combo.count - 1, levelCap);
      return `Combo:    ⚡ x${combo.count} (${bonusDmg > 0 ? `+${bonusDmg} dmg` : 'sin bonus aún'} — se resetea al cambiar de objetivo)`;
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

// BUG-309: IDs de monstruos de tutorial que no deben bloquear el movimiento
// ID 20 = Goblin de Práctica en la Antesala (sala tutorial)
const TUTORIAL_MONSTER_IDS = new Set([20]);

// Todos los monstruos de entrenamiento/tutorial que no bloquean movimiento
const NON_BLOCKING_MONSTER_IDS = new Set([...TRAINING_DUMMY_IDS, ...TUTORIAL_MONSTER_IDS]);

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
    // DIS-D303: Si hay exactamente 1 monstruo en la sala, auto-apuntar a él
    const monstersInRoom = db.getMonstersInRoom(player.current_room_id);
    if (monstersInRoom && monstersInRoom.length === 1) {
      targetName = monstersInRoom[0].name;
    } else if (monstersInRoom && monstersInRoom.length > 1) {
      // DIS-D325: Mostrar lista numerada de enemigos cuando hay múltiples targets
      const alive = monstersInRoom.filter(m => m.hp > 0);
      if (alive.length === 1) {
        targetName = alive[0].name;
      } else if (alive.length === 0) {
        return { text: '⚔️ No hay monstruos vivos aquí para atacar.' };
      } else {
        const list = alive.map((m, i) => `(${i + 1}) ${m.name} [${m.hp}/${m.max_hp} HP]`).join('  ');
        const exampleName = alive[0].name.replace(/^[\s\p{Emoji_Presentation}\u2B50\u2764\u26A1\u2728\u{1F300}-\u{1FFFF}]+/u, '').trim().split(' ')[0].toLowerCase() || 'elemental';
        return { text: `⚔️ Hay ${alive.length} enemigos en la sala:\n  ${list}\nIndicá a quién atacar: attack 1 / attack ${exampleName}` };
      }
    } else {
      return { text: '⚔️ No hay monstruos aquí para atacar.' };
    }
  }

  // Refrescar player desde BD para tener HP actualizado
  player = db.getPlayer(player.id);

  // T146: Cancelar AFK automáticamente al entrar en combate
  if (clearAfk(player.id)) {
    // El mensaje de cancelación AFK se incluirá junto con el resultado del ataque
    // (pero como no podemos devolver dos results, simplemente lo cancelamos silenciosamente)
  }

  // BUG-348: Aplicar debuff de sala en combate (ROOM_EFFECTS de tipo 'debuff').
  // El debuff es real (-1 ATK durante combate en esa sala), EXCEPTO si el jugador
  // esquivó la trampa por memoria (trap_cd_<roomId> en status_effects).
  const roomEffectForCombat = ROOM_EFFECTS[player.current_room_id];
  if (roomEffectForCombat && roomEffectForCombat.type === 'debuff' && roomEffectForCombat.stat === 'attack') {
    const seForCombat = parseSE(player.status_effects);
    const trapCdKeyForCombat = `trap_cd_${player.current_room_id}`;
    const trapMemoryActive = seForCombat[trapCdKeyForCombat]
      ? new Date(seForCombat[trapCdKeyForCombat]).getTime() > Date.now()
      : false;
    if (!trapMemoryActive) {
      // Aplicar debuff: reducir attack temporalmente para este combate
      player = { ...player, attack: Math.max(1, (player.attack || 5) + roomEffectForCombat.amount) };
    }
  }

  const monster = combat.findMonsterInRoom(player.current_room_id, targetName.trim());
  if (!monster) {
    // DIS-D325: Si el argumento es un número, intentar matching por posición
    const numArg = parseInt(targetName.trim(), 10);
    if (!isNaN(numArg)) {
      const alive = db.getMonstersInRoom(player.current_room_id).filter(m => m.hp > 0);
      if (alive.length === 0) {
        return { text: '⚔️ No hay monstruos vivos aquí para atacar.' };
      }
      // BUG-335: Si el índice quedó fuera de rango (ej: mataste al #1 y quedó solo el #2),
      // pero hay exactamente 1 monstruo vivo, auto-apuntar a él.
      if (alive.length === 1) {
        return cmdAttack(player, alive[0].name);
      }
      if (numArg >= 1 && numArg <= alive.length) {
        // Se encontró un monstruo por número, redirectear el flujo usando su nombre
        return cmdAttack(player, alive[numArg - 1].name);
      }
      // Índice inválido con múltiples enemigos: mostrar lista
      const list = alive.map((m, i) => `(${i + 1}) ${m.name} [${m.hp}/${m.max_hp} HP]`).join('  ');
      return { text: `⚔️ No hay ningún enemigo ${numArg} aquí. Enemigos en sala:\n  ${list}` };
    }
    // BUG-350: Detectar si el monstruo huyó a otra sala (está en BD pero en sala diferente)
    // Esto ocurre en combates batch donde el monstruo huye en el primer comando y el segundo
    // comando del mismo "batch" intenta atacarlo por nombre.
    // BUG-358 FIX: Solo buscar en salas ADYACENTES a la sala del jugador, no en todas las salas.
    // El matching anterior era demasiado permisivo e incluía monstruos de salas lejanas
    // con nombres parcialmente similares (ej: "Golem de Forja" al atacar "goblin", o
    // "Goblin de Práctica" al atacar "goblin merodeador").
    const currentRoomForFlee = db.getRoom(player.current_room_id);
    const adjacentRoomIds = new Set();
    if (currentRoomForFlee && currentRoomForFlee.exits) {
      for (const v of Object.values(currentRoomForFlee.exits)) {
        const rid = typeof v === 'object' ? v.room_id : v;
        if (rid) adjacentRoomIds.add(rid);
      }
    }
    const allM = db.getAllMonsters();
    const normalTarget = targetName.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const fled = allM.find(m => {
      if (!m.room_id || m.hp <= 0) return false;
      // Solo considerar salas adyacentes (el monstruo huyó a una sala contigua)
      if (!adjacentRoomIds.has(m.room_id)) return false;
      // BUG-412 FIX: verificar que el monstruo realmente huyó DESDE la sala actual del jugador.
      // Sin esta verificación, un monstruo en sala adyacente con nombre similar generaba falsos positivos
      // (ej: "Golem de Forja" en sala 9 aparecía como fugado cuando el jugador atacaba "golem" en sala 8).
      const mStatusFx = m.status_effects ? (typeof m.status_effects === 'string' ? JSON.parse(m.status_effects) : m.status_effects) : {};
      if (!mStatusFx.fled_from || mStatusFx.fled_from !== player.current_room_id) return false;
      const normalName = m.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      return normalName.includes(normalTarget) || normalTarget.includes(normalName);
    });
    if (fled) {
      return { text: `💨 El ${fled.name} huyó de la sala. ¡Ya no está aquí!\n   Usá "perseguir" o movete en su dirección para seguirlo.` };
    }
    return { text: `No hay ningún "${targetName}" aquí.` };
  }

  // ── T143: Modo entrenamiento ───────────────────────────────────────────────
  // Si el jugador está en la Sala de Práctica atacando un maniquí, corre el combate
  // completo en un solo comando con estadísticas detalladas. Sin XP, kills ni loot.
  if (player.current_room_id === TRAINING_ROOM_ID && TRAINING_DUMMY_IDS.has(monster.id)) {
    return _cmdTrainingFight(player, monster);
  }

  // ── T211: Grito de batalla ─────────────────────────────────────────────────
  const freshForCry = db.getPlayer(player.id);
  const battlecryText = freshForCry && freshForCry.battlecry ? freshForCry.battlecry : null;

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
  // DIS-521: capear el bonus según nivel para no romper el balance en late game
  const comboLevelCap = Math.ceil((player.level || 1) / 4); // max +1 en L1-4, +2 en L5-8, etc.
  const comboBonusDmg = Math.min(Math.max(0, comboCount - 1), comboLevelCap);
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

  // ── DIS-529: swap poción de maná → poción de salud para Guerreros ─────────
  // El Goblin Merodeador (id=1) dropea una poción de maná que es inútil para Guerreros.
  // Si el jugador es Guerrero, reemplazar el drop en la sala por una poción de salud.
  if (monsterDead && monster.id === 1) {
    const freshPlayerClass = db.getPlayer(player.id);
    const pClass = freshPlayerClass && freshPlayerClass.player_class;
    if (pClass === 'guerrero') {
      const room = db.getRoom(player.current_room_id);
      if (room && room.items.includes('poción de maná')) {
        const newItems = [...room.items];
        const idx = newItems.indexOf('poción de maná');
        if (idx !== -1) {
          newItems[idx] = 'poción de salud';
          db.updateRoomItems(player.current_room_id, newItems);
          // Actualizar la última línea del loot en el mensaje para reflejo correcto
          const lootIdx = lines.findLastIndex(l => l.includes('poción de maná'));
          if (lootIdx !== -1) {
            lines[lootIdx] = lines[lootIdx].replace('poción de maná', 'poción de salud');
          }
        }
      }
    }
  }
  // ── Metas globales (T194) — contabilizar kill ─────────────────────────────
  let worldGoalMsg = '';
  if (monsterDead) {
    const hitMilestone = db.incrementWorldGoal('kills', 1);
    if (hitMilestone) {
      worldGoalMsg = `\n🌍 ¡HITO GLOBAL! El dungeon acumula ${hitMilestone.toLocaleString()} monstruos abatidos entre todos los aventureros.`;
    }
  }

  // ── T212: Campeón de la hora ─────────────────────────────────────────────
  let championMsg = '';
  if (monsterDead) {
    const newHourlyKills = db.incrementHourlyKills(player.id);
    // Revisar si este jugador es el nuevo campeón (top de la hora)
    const currentChamp = db.getHourlyChampion();
    if (currentChamp && currentChamp.id === player.id && newHourlyKills >= 3) {
      // Es campeón si tiene más que cualquier otro (con al menos 3 kills)
      const prevChamp = hourlyChampionMap.get('champion');
      const justCrowned = !prevChamp || prevChamp.id !== player.id;
      if (justCrowned) {
        hourlyChampionMap.set('champion', { id: player.id, username: player.username });
        championMsg = `\n👑 ¡${player.username} es proclamado CAMPEÓN DE LA HORA con ${newHourlyKills} kills!`;
        Object.assign(combatResult, {
          globalEvent: `👑 ${player.username} es el nuevo CAMPEÓN DE LA HORA (${newHourlyKills} kills).`,
        });
      }
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

  // ── Contrato de Caza Semanal (T222) ──────────────────────────────────────
  let contractMsg = '';
  if (monsterDead) {
    const wcr = db.updateWeeklyContractProgress(player.id, monster.name);
    if (wcr && wcr.reward) {
      contractMsg = `\n📜 ¡CONTRATO DE CAZA COMPLETADO! +${wcr.reward.xp} XP · +${wcr.reward.gold}g · Recibís: ${wcr.reward.item}`;
    } else if (wcr && wcr.contract && !wcr.contract.done) {
      contractMsg = `\n📜 Contrato semanal: ${wcr.contract.target} (${wcr.contract.progress}/${wcr.contract.goal})`;
    }
  }

  // ── Evaluar logros tras el combate ──────────────────────────────────────
  let achLines = '';
  const LICH_MONSTER_ID = 13; // Lich Anciano — boss principal (Catedral)
  const bossKill = monsterDead && !!(combat.BOSS_MONSTERS && combat.BOSS_MONSTERS[monster.id]);
  const lichKill = monsterDead && monster.id === LICH_MONSTER_ID; // solo el Lich Anciano real
  const freshForAch = db.getPlayer(player.id);
  if (freshForAch) {
    const poisonSurvived = !!(combatResult && combatResult.poisonSurvived);
    const newAchs = ach.checkAchievements(freshForAch, { bossKill: lichKill, poisonSurvived });
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
    if (lichKill) {
      // STORY-016: texto de crónica evocador para el boss
      db.logGlobalEvent('boss', `Las antorchas de la Catedral se apagaron cuando ${player.username} emergió con sangre de lich en la espada. Por un momento, el dungeon estuvo en silencio.`);
      // T113: Diario del aventurero — STORY-019: entrada con color emocional
      db.addJournalEntry(player.id, 'boss', `☠️ Cuando el Lich cayó, el silencio fue casi insoportable. Luego recordaste que tenés que salir de aquí.`);
      // DIS-D291: Incrementar contador de ciclos del jugador
      const freshForCycle = db.getPlayer(player.id);
      if (freshForCycle) {
        const prevLichKills = freshForCycle.lich_kills || 0;
        const newLichKills = prevLichKills + 1;
        const currentPlaytime = freshForCycle.playtime_minutes || 0;
        const prevBest = freshForCycle.cycle_best_time;
        const updateData = { lich_kills: newLichKills };
        if (!prevBest || currentPlaytime < prevBest) {
          updateData.cycle_best_time = currentPlaytime;
        }
        db.updatePlayer(player.id, updateData);
      }
    }
    // Logros nuevos → registrar el primero en la crónica
    if (newAchs && newAchs.length > 0) {
      db.logGlobalEvent('achievement', `🏅 ${player.username} desbloqueó el logro "${newAchs[0].name}".`);
      // T113: Diario — registrar cada logro nuevo
      for (const a of newAchs) {
        db.addJournalEntry(player.id, 'achievement', `🏅 Logro desbloqueado: "${a.name}".`);
      }
    }
    // Subida de nivel a múltiplos de 5 — loggear solo si REALMENTE subió de nivel en este kill
    const newLevel = freshForAch.level || 1;
    const prevLevelForGlobal = player.level || 1;
    if (monsterDead && newLevel >= 5 && newLevel % 5 === 0 && newLevel > prevLevelForGlobal) {
      // T236: texto evocador para nivel importante
      const levelMsg = newLevel >= 10
        ? `${player.username} ya no es un aventurero. Es algo más. (nivel ${newLevel})`
        : `⬆️ ${player.username} alcanzó el nivel ${newLevel}. ¡Un aventurero formidable!`;
      db.logGlobalEvent('level', levelMsg);
    }
    // T113: Registrar en diario toda subida de nivel
    if (monsterDead) {
      const prevLevelForJournal = player.level || 1;
      if (newLevel > prevLevelForJournal) {
        // STORY-019: primer nivel con mensaje evocador
        const levelMsg = newLevel === 2
          ? `⬆️ Subiste al nivel ${newLevel}. Sentís que el dungeon te está cambiando. No estás seguro de que sea para bien.`
          : `⬆️ Subiste al nivel ${newLevel}.`;
        db.addJournalEntry(player.id, 'level', levelMsg);
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
      const questNewXp = (freshQ2.xp || 0) + r.xp;
      const questNewLevel = xpSystem.levelFromXp(questNewXp);
      const questLevelUp = questNewLevel > (freshQ2.level || 1);
      const questUpd = {
        gold: (freshQ2.gold || 0) + r.gold,
        xp: questNewXp,
        level: questNewLevel,
      };
      if (questLevelUp) {
        questUpd.max_hp = (freshQ2.max_hp || 30) + 5;
        const healQuest = Math.ceil(questUpd.max_hp * 0.20);
        questUpd.hp = Math.min(questUpd.max_hp, (freshQ2.hp || 1) + healQuest);
        questUpd.attack = (freshQ2.attack || 5) + 1;
      }
      db.updatePlayer(player.id, questUpd);
      questLines = `\n\n🎉 ¡Quest completada! Recibís ${r.gold}g y ${r.xp} XP de recompensa.${questLevelUp ? ` ✨ ¡SUBÍS AL NIVEL ${questNewLevel}!` : ''}`;
      // T125: reputación por quest completada (+5)
      const repQuest = db.addReputation(player.id, 5);
      if (repQuest.leveledUp) {
        questLines += `\n${repQuest.level.icon} ¡Tu reputación aumenta a **${repQuest.level.name}**! (${repQuest.newPoints} pts)`;
      }
      // Registrar en crónica global (T093)
      // T236: texto evocador para quest completada
      db.logGlobalEvent('quest', `📜 ${player.username} completó el contrato de caza. El dungeon lo recuerda.`);
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
          const newLevel = xpSystem.levelFromXp(newXp);
          const levelUp  = newLevel > (freshComp.level || 1);
          const upd = { xp: newXp, level: newLevel };
          if (levelUp) {
            upd.max_hp = (freshComp.max_hp || 30) + 5;
            const healComp = Math.ceil(upd.max_hp * 0.20);
            upd.hp     = Math.min(upd.max_hp, (freshComp.hp || 1) + healComp);
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
      const newLevel = xpSystem.levelFromXp(newXp);
      const levelUp = newLevel > (freshStreak.level || 1);
      const upd = { xp: newXp, level: newLevel };
      if (levelUp) {
        upd.max_hp = (freshStreak.max_hp || 30) + 5;
        const healStreak = Math.ceil(upd.max_hp * 0.20);
        upd.hp = Math.min(upd.max_hp, (freshStreak.hp || 1) + healStreak);
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

  // ── DIS-P08: Hint de habilidades disponibles en combate activo ──────────────
  let skillHint = '';
  if (!monsterDead && !playerDead) {
    const freshForSkills = db.getPlayer(player.id);
    if (freshForSkills) {
      const unlockedSkills = skills.getUnlockedSkills(freshForSkills.level || 1, freshForSkills.player_class);
      if (unlockedSkills.length > 0) {
        const cooldowns = freshForSkills.skill_cooldowns
          ? (typeof freshForSkills.skill_cooldowns === 'string' ? JSON.parse(freshForSkills.skill_cooldowns) : freshForSkills.skill_cooldowns)
          : {};
        const now = Date.now();
        const available = unlockedSkills.filter(sk => {
          const cd = cooldowns[sk.id];
          return !cd || now > new Date(cd).getTime();
        });
        if (available.length > 0) {
          const skillNames = available.map(sk => `\`${sk.aliases[0]}\` (${sk.name})`).join(', ');
          skillHint = `\n💡 Habilidades disponibles: ${skillNames} (o seguí con \`attack\`)`;
        }
      }
    }
  }

  // ── T211: Prefijar el grito de batalla (solo en primer turno del combate) ──
  const battlecryPrefix = battlecryText && !prevCombo
    ? `⚔️ "${battlecryText}" — grita ${player.username}.\n`
    : '';
  // El grito también se emite como evento de sala para que otros jugadores lo escuchen
  const battlecryEvent = battlecryText && !prevCombo
    ? `⚔️ ${player.username} grita: "${battlecryText}"`
    : null;

  // ── DIS-D01: Tutorial paso 3 — si el goblin murió en el tutorial, completarlo ──
  let tutorialCompletionResult = null;
  if (monsterDead) {
    const freshForTutorial = db.getPlayer(player.id);
    if (freshForTutorial && freshForTutorial.tutorial_step >= 3 && freshForTutorial.current_room_id === tutorial.TUTORIAL_ROOM_ID) {
      // El jugador mató al goblin en el tutorial — completar el tutorial automáticamente
      tutorialCompletionResult = completeTutorial(freshForTutorial);
    }
  }

  const bossVictoryBlock = lichKill
    ? (() => {
      const freshVictory = db.getPlayer(player.id);
      const lichKills = (freshVictory && freshVictory.lich_kills) || 1;
      const cycleTime = (freshVictory && freshVictory.playtime_minutes) || 0;
      const bestTime = freshVictory && freshVictory.cycle_best_time;
      const isBestTime = bestTime === cycleTime;
      const isFirstKill = lichKills === 1;

      // Medalla de ciclo
      let cycleMedal = '⚔️';
      if (lichKills >= 10) cycleMedal = '🏆';
      else if (lichKills >= 5) cycleMedal = '💎';
      else if (lichKills >= 3) cycleMedal = '🥇';
      else if (lichKills >= 2) cycleMedal = '🥈';

      const lines = [
        '╔══════════════════════════════════════════════════════╗',
        `║  ☠️  ¡¡EL LICH ANCIANO HA CAÍDO!!                    ║`,
        `║  ${monster.name.substring(0, 36).padEnd(36)}  ║`,
        '╠══════════════════════════════════════════════════════╣',
      ];

      if (isFirstKill) {
        lines.push('║  🌟 ¡Primera victoria épica!                         ║');
        lines.push('║  El dungeon ha sido conquistado... por ahora.        ║');
        lines.push('╠══════════════════════════════════════════════════════╣');
        lines.push('║  🔄 El Lich regresará en 30 minutos. Mientras tanto: ║');
        lines.push('║  → Explorar salas que no visitaste                   ║');
        lines.push('║  → Completar el bestiario (comando \"bestiary\")       ║');
        lines.push('║  → Crafting avanzado (\"recetas\")                    ║');
        lines.push('║  → Desafío: matar al Lich con menos tiempo           ║');
        lines.push('║  → Escribí \"legado\" para ver tus estadísticas       ║');
      } else {
        lines.push(`║  ${(cycleMedal + ' Ciclo #' + lichKills + ' completado!').padEnd(52)}║`);
        if (bestTime !== undefined && bestTime !== null) {
          const bestHrs = Math.floor(bestTime / 60);
          const bestMins = bestTime % 60;
          const bestStr = bestHrs > 0 ? `${bestHrs}h${bestMins}m` : `${bestMins}m`;
          const timeLabel = isBestTime ? `⭐ ¡Nuevo record personal: ${bestStr}!` : `Mejor tiempo: ${bestStr}`;
          lines.push(`║  ${timeLabel.substring(0, 52).padEnd(52)}║`);
        }
        lines.push('╠══════════════════════════════════════════════════════╣');
        lines.push('║  🎯 Desafíos disponibles:                            ║');
        if (lichKills < 3) {
          lines.push('║  → Speed-run: intentá un ciclo más rápido           ║');
          lines.push('║  → Sin pociones: completá un ciclo sin curarte      ║');
        } else if (lichKills < 5) {
          lines.push('║  → Modo Hardcore: activalo con \"hardcore\"           ║');
          lines.push('║  → Cartógrafo: visitá TODAS las salas               ║');
        } else {
          lines.push('║  → Sos una leyenda. El dungeon te teme.             ║');
          lines.push('║  → Buscá el logro secreto que aún no tenés.         ║');
        }
        lines.push('║  → Escribí \"legado\" para ver tu historia completa   ║');
      }

      lines.push('╠══════════════════════════════════════════════════════╣');
      lines.push('║  🏆 El loot especial quedó en el suelo.              ║');
      lines.push('║  Usá "loot" para recogerlo todo de una vez.         ║');
      // DIS-D401: advertir si el inventario está casi lleno antes de que el jugador
      // intente recoger el loot del boss y se frustre por no poder hacerlo.
      const freshForInv = db.getPlayer(player.id);
      const invCount = Array.isArray(freshForInv.inventory) ? freshForInv.inventory.length : 0;
      const invMaxDisplay = 25 + (freshForInv.inventory_bonus || 0);
      if (invCount >= invMaxDisplay - 2) {
        lines.push(`║  ⚠️  Tu mochila tiene ${invCount}/${invMaxDisplay} ítems — hacé espacio      ║`);
        lines.push('║  con "drop <ítem>", "vault store <ítem>" o "subastar". ║');
      }
      lines.push('╚══════════════════════════════════════════════════════╝');
      return '\n\n' + lines.join('\n');
    })()
    : '';

  const baseText = battlecryPrefix + lines.join('\n') + comboMsg + achLines + questLines + guildQuestLines + partyXpLines + runeMsg + challengeMsg + contractMsg + streakMsg + worldGoalMsg + championMsg + skillHint + (recordMsgs.length ? '\n' + recordMsgs.map(m => `🌟 ${m}`).join('\n') : '') + bossVictoryBlock;

  if (tutorialCompletionResult) {
    return {
      text: baseText + '\n\n' + tutorialCompletionResult.text,
      event: tutorialCompletionResult.event,
      eventRoomId: tutorialCompletionResult.eventRoomId,
      globalEvent: null,
      sessionKill: true,
    };
  }

  return {
    text: baseText,
    event: battlecryEvent || eventText,
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
  // BUG-302: Excluir maniquíes de entrenamiento del comando huir
  // BUG-309: Excluir también el Goblin de Práctica de la Antesala (id=20)
  const monsters = db.getMonstersInRoom(player.current_room_id).filter(m => !NON_BLOCKING_MONSTER_IDS.has(m.id));

  if (monsters.length === 0) {
    return { text: 'No hay nada de lo que huir aquí.' };
  }

  let monster;
  // Si se indica un monstruo específico, buscarlo
  // BUG-594: si el argumento es una dirección cardinal, ignorarlo (flee south → flee sin dirección)
  const DIRECTIONS = new Set(['north', 'south', 'east', 'west', 'up', 'down', 'norte', 'sur', 'este', 'oeste', 'arriba', 'abajo', 'n', 's', 'e', 'o', 'w']);
  const isDirectionArg = targetQuery && DIRECTIONS.has(targetQuery.trim().toLowerCase());
  if (targetQuery && targetQuery.trim() && !isDirectionArg) {
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
      const { fled, line, destRoomId, playerDied: multiDied } = combat.tryFlee(player, monster, room);
      // BUG-518: resetear killStreak si el jugador murió huyendo (múltiples monstruos)
      if (multiDied) {
        killStreakMap.set(player.id, 0);
      }
      const multiMsg = `⚡ Hay ${monsters.length} monstruos (${nameList}). Usá "huir <monstruo>" para huir de uno específico.\n${line}`;
      return {
        text: multiMsg,
        event: fled ? `${player.username} huye de la sala.` : `${player.username} intenta huir pero falla.`,
        eventRoomId: room.id,
      };
    }
    monster = monsters[0];
  }

  const { fled, line, destRoomId, playerDied: fleeDied, globalEvent: fleeGlobalEvent } = combat.tryFlee(player, monster, room);

  // BUG-518: resetear killStreak si el jugador murió huyendo
  if (fleeDied) {
    const oldStreakFlee = killStreakMap.get(player.id) || 0;
    if (oldStreakFlee >= 3) {
      // La notificación de pérdida de racha ya se muestra en cmdAttack; aquí solo reseteamos
    }
    killStreakMap.set(player.id, 0);
  }

  // DIS-453: hint sobre probabilidad de huida para el próximo intento
  // (basado en HP actual del monstruo después del intento)
  let fleeHint = '';
  if (!fled) {
    const freshMonster = db.getMonstersInRoom(player.current_room_id).find(m => m.id === monster.id);
    if (freshMonster) {
      const hpPct = Math.round((freshMonster.hp / freshMonster.max_hp) * 100);
      if (hpPct <= 25) fleeHint = '\n💭 Está muy herido — si volvés a intentarlo, tus chances son altas (≈80%).';
      else if (hpPct <= 50) fleeHint = '\n💭 Está maltrecho — con suerte podés escapar en el próximo intento (≈65%).';
      else if (hpPct <= 75) fleeHint = '\n💭 Está dañado — las chances de huida son parejas (≈50%). Debilitarlo más te ayudaría.';
      else fleeHint = '\n💭 Está casi intacto — es difícil escapar ahora (≈35%). Causale daño primero para mejorar tus chances.';
    }
  }

  // DIS-479: logro "Supervivencia Táctica" — huir exitosamente 1 vez
  let fleeAchLines = '';
  if (fled) {
    const freshForFleeAch = db.getPlayer(player.id);
    const fleeAchs = ach.checkAchievements(freshForFleeAch, { fled: true });
    if (fleeAchs.length > 0) {
      fleeAchLines = '\n' + fleeAchs.map(a => `🏆 ¡Logro desbloqueado: ${a.icon} ${a.name}! — ${a.desc}`).join('\n');
    }
  }

  return {
    text: line + fleeHint + fleeAchLines,
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

  // DIS-D308: pick todo / pick all / pick everything — recoger todos los ítems del suelo
  const queryNorm = itemQuery.trim().toLowerCase();
  if (['todo', 'all', 'everything', 'todos', 'todas', 'recoger todo'].includes(queryNorm)) {
    const floorItems = Array.isArray(room.items) ? [...room.items] : [];
    if (floorItems.length === 0) {
      return { text: 'No hay ítems en el suelo.' };
    }
    // DIS-016: tabla de conversión de monedas a oro
    const GOLD_ITEMS_ALL = {
      'monedas de oro': 10,
      'monedas de plata': 5,
      'monedas de cobre': 1,
      'monedas': 5,
      'oro': 15,
      'bolsa de monedas': 25,
      'cofre de oro': 50,
    };
    // Recoger todos — acumular resultados
    const pickedLines = [];
    const notPicked = [];
    let current = db.getPlayer(player.id);
    let totalGoldConverted = 0;
    for (const item of floorItems) {
      // DIS-589: monedas se auto-convierten a oro sin ocupar inventario
      const itemLower = item.toLowerCase();
      const goldKey = Object.keys(GOLD_ITEMS_ALL).find(k => itemLower.includes(k) || k.includes(itemLower));
      if (goldKey) {
        const amount = GOLD_ITEMS_ALL[goldKey];
        current = db.getPlayer(current.id);
        db.updatePlayer(current.id, { gold: (current.gold || 0) + amount });
        totalGoldConverted += amount;
        pickedLines.push(`  💰 ${item} → +${amount}g`);
        current = db.getPlayer(current.id);
        continue;
      }
      const inv = Array.isArray(current.inventory) ? current.inventory : [];
      // BUG-489: contar equipados también para el límite real
      const eqCount = (current.equipped_weapon ? 1 : 0) + (current.equipped_armor ? 1 : 0);
      if (inv.length + eqCount >= 20) {
        notPicked.push(item);
        pickedLines.push(`⚠️ Inventario lleno (${inv.length + eqCount}/20) — quedó en el suelo: ${item}\n   💡 Hacé espacio con \`drop <ítem>\` o \`subastar <ítem> <precio>\`.`);
        continue;
      }
      const newInv = [...inv, item];
      db.updatePlayer(current.id, { inventory: newInv });
      pickedLines.push(`  ✅ ${item}`);
      current = db.getPlayer(current.id);
    }
    // Dejar en el suelo solo los ítems no recogidos
    db.updateRoomItems(room.id, notPicked);
    const total = floorItems.length - notPicked.length;
    const goldSuffix = totalGoldConverted > 0 ? ` (monedas convertidas: +${totalGoldConverted}g → ${current.gold}g total)` : '';
    return { text: `📦 Recogiste ${total} ítem(s) del suelo${goldSuffix}:\n${pickedLines.join('\n')}` };
  }

  const found = items.findItem(room.items, itemQuery.trim());
  if (!found) {
    return { text: `No hay ningún "${itemQuery}" en el suelo.` };
  }

  // BUG-415: Chequear capacidad ANTES de quitar el ítem del suelo (evitar destrucción)
  // Refrescar jugador para tener el inventario actualizado
  player = db.getPlayer(player.id);

  // Ítems de oro: se convierten en monedas reales en lugar de ir al inventario
  // DIS-016: Conversión inmediata de monedas a gold real (cobre=1g, plata=5g, oro=10g por unidad)
  const GOLD_ITEMS = {
    'monedas de oro': 10,
    'monedas de plata': 5,
    'monedas de cobre': 1,
    'monedas': 5,
    'oro': 15,
    'bolsa de monedas': 25,
    'cofre de oro': 50,
  };
  const foundLower = found.toLowerCase();
  const goldKey = Object.keys(GOLD_ITEMS).find(k => foundLower.includes(k) || k.includes(foundLower));

  // DIS-D385: Chequear capacidad de inventario antes de recoger (solo para ítems no-moneda)
  // BUG-489: contar también ítems equipados (no están en player.inventory pero ocupan slot visual)
  const equippedCount = (player.equipped_weapon ? 1 : 0) + (player.equipped_armor ? 1 : 0);
  const currentInvCount = (player.inventory || []).length + equippedCount;
  const maxInvSingle = 25 + (player.inventory_bonus || 0); // DIS-595: bolsas de lona
  if (!goldKey && currentInvCount >= maxInvSingle) {
    return {
      text: `🎒 Tu mochila está llena (${currentInvCount}/${maxInvSingle} ítems).\n💡 Podés hacer espacio: tirá algo con \`drop <ítem>\` o vendelo con \`subastar <ítem> <precio>\`.\n💡 También podés usar la bóveda (vault) en la Entrada o en la Casa de Subastas.\n💡 Aldric vende bolsas de lona (30g) que amplían tu mochila +4 slots.`,
    };
  }

  // Quitar el ítem del suelo — BUG-288: usar removeFirst para no eliminar duplicados
  const newRoomItems = removeFirst(room.items, found);
  db.updateRoomItems(room.id, newRoomItems);

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
      } else if (!qrGold.justCompleted) {
        // DIS-D328: mostrar progreso actualizado de quest de oro activa
        const activeQ = quests.getActiveQuest();
        if (activeQ && activeQ.questDef && activeQ.questDef.type === 'gold') {
          goldQuestLine = `\n📜 Quest: ${activeQ.questDef.title} — ${qrGold.newProgress}/${activeQ.questDef.goal}g`;
        }
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

  // DIS-D280: hint de crafteo — si el nuevo inventario completa una receta, sugerir (1 vez por receta)
  const freshP2 = db.getPlayer(player.id);
  const shownH2 = freshP2.status_effects || {};
  const invNorm2 = newInventory.map(i => i.toLowerCase().trim());
  let pickCraftHint = '';
  for (const recipe of crafting.RECIPES) {
    const [ingA, ingB] = recipe.ingredients;
    if (invNorm2.includes(ingA.toLowerCase().trim()) && invNorm2.includes(ingB.toLowerCase().trim())) {
      const hKey = `craft_hint_${recipe.result.toLowerCase().replace(/\s+/g, '_')}`;
      if (!shownH2[hKey]) {
        pickCraftHint = `\n💡 ¡Tip de crafteo! Tenés "${ingA}" y "${ingB}" — combiná con:\n   craftear ${ingA} con ${ingB}`;
        db.updatePlayer(freshP2.id, { status_effects: JSON.stringify({ ...shownH2, [hKey]: true }) });
        break;
      }
    }
  }

  // DIS-D327/DIS-D351: hint de quest de Aldric cuando se recoge la carta sellada
  // DIS-D351: variar hint según nivel del jugador (Aldric no activa la quest hasta nivel 5)
  let cartaHint = '';
  if (found.toLowerCase().includes('carta sellada') && player.current_room_id === 8) {
    const questState = player.aldric_quest || 'none';
    const playerLevel = player.level || 1;
    if (questState === 'none') {
      if (playerLevel < 5) {
        cartaHint = `\n\n📜 El sello de las dos llaves cruzadas... recordás haberlo visto en otro lugar. Quizás valga la pena llevársela al mercader de sala 4 cuando seas más experimentado (nivel 5+).`;
      } else {
        cartaHint = '\n\n📜 El sello de las dos llaves cruzadas... recordás haberlo visto en algún otro lugar del dungeon. (Pista: "hablar aldric" en sala 4)';
      }
    } else if (questState === 'active') {
      cartaHint = '\n\n📜 ¡La carta de la quest de Aldric! Llevásela al mercader en sala 4 ("hablar aldric").';
    }
  }

  return {
    text: `${rarityEmoji} Recogés ${found} y lo guardás en tu mochila.${rarityLabel}${pickCraftHint}${cartaHint}`,
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
    // BUG-484: elementos de sala — "use fuente" en sala 18 debería beber de la fuente
    const queryLower2 = itemQuery.trim().toLowerCase();
    if (player.current_room_id === FOUNTAIN_ROOM_ID && ['fuente', 'fountain', 'agua', 'agua plateada', 'beber fuente'].includes(queryLower2)) {
      return cmdDrink(player);
    }
    // BUG-481: "use cuenco" en sala 5 (Capilla) debería usar el cuenco sagrado
    if (player.current_room_id === 5 && ['cuenco', 'bowl', 'cuenco sagrado', 'ofrenda'].includes(queryLower2)) {
      return cmdChapelBowl(player);
    }
    // BUG-445: Pozo Sin Fondo (sala 7) — feedback narrativo al intentar interactuar con el pozo
    const queryLower = itemQuery.trim().toLowerCase();
    const pozoKeywords = ['pozo', 'cuerda', 'brocal', 'bajar', 'bajar al pozo', 'saltar', 'saltar al pozo'];
    if (player.current_room_id === 7 && pozoKeywords.some(k => queryLower.includes(k))) {
      const dmg = 1;
      const newHp = Math.max(1, player.hp - dmg);
      db.updatePlayer(player.id, { hp: newHp });
      return { text: `Intentás bajar por el borde del pozo. Tus dedos encuentran las mismas marcas de uñas del brocal —viejas, profundas.\n\nEn cuanto tus piernas cuelgan sobre el vacío, el frío te golpea desde abajo: no temperatura, sino un rechazo físico, una presión hacia arriba que empuja con la fuerza de algo que no quiere compañía.\n\nPerdés el agarre. Caés hacia atrás sobre el suelo de piedra.\n\n💥 -${dmg} HP por el impacto. (${newHp}/${player.max_hp || 30} HP)\n\nEl pozo sigue quieto. El frío permanece.` };
    }
    return { text: `No tenés ningún "${itemQuery}" en el inventario.` };
  }

  const def = items.getItemDef(found);
  if (!def) {
    return { text: `Usás ${found} pero no pasa nada en particular.` };
  }

  let resultText;

  if (def.type === 'potion' && def.effect === 'heal') {
    const oldHp = player.hp;
    // BUG-005 fix: asegurar que max_hp sea válido (post-levelup puede llegar como null/0)
    const maxHp = player.max_hp || 30;
    if (player.hp >= maxHp) {
      return { text: `Ya estás al máximo de HP (${player.hp}/${maxHp}). Guardás la ${found}.` };
    }
    const newHp = Math.min(maxHp, player.hp + def.amount);
    db.updatePlayer(player.id, { hp: newHp });

    // Consumir el ítem
    const newInv = removeFirst(player.inventory, found);
    db.updatePlayer(player.id, { inventory: newInv });

    resultText = `Bebés la ${found}. Recuperás ${newHp - oldHp} HP. (${newHp}/${maxHp} HP)`;

  } else if (def.type === 'mana_potion' && def.effect === 'restore_mana') {
    // T104: Pociones de maná
    // BUG-313: verificar maná lleno ANTES de consumir
    const currentMana = player.mana != null ? player.mana : 20;
    const maxMana = player.max_mana || 20;
    if (currentMana >= maxMana) {
      return { text: `💧 Tu maná ya está al máximo (${currentMana}/${maxMana}). Guardás la ${found}.` };
    }
    const newMana = Math.min(maxMana, currentMana + def.amount);
    const restored = newMana - currentMana;

    // Consumir el ítem
    const newInvM = removeFirst(player.inventory, found);
    db.updatePlayer(player.id, { inventory: newInvM, mana: newMana, last_mana_regen: new Date().toISOString() });

    resultText = `💧 Bebés la ${found}. Recuperás ${restored} maná. (${newMana}/${maxMana} maná)`;

  } else if (def.type === 'antidote' && def.effect === 'cure_poison') {
    const statusFx = player.status_effects || {};
    if (statusFx.poisoned) {
      // Curar veneno (uso principal) — consumir la hierba
      const newInv2 = removeFirst(player.inventory, found);
      delete statusFx.poisoned;
      db.updatePlayer(player.id, { inventory: newInv2, status_effects: JSON.stringify(statusFx) });
      resultText = `✅ Bebés la ${found}. El veneno se neutraliza de inmediato. Te sentís mejor.`;
    } else {
      // BUG-289: sin veneno, cura 12 HP en su lugar
      // BUG-310: no consumir si HP ya está al máximo
      const HERB_HEAL = 12;
      const maxHp = player.max_hp || 100;
      if (player.hp >= maxHp) {
        return { text: `🌿 Ya estás al máximo de HP (${player.hp}/${maxHp}). Guardás la ${found}.` };
      }
      const newInv2 = removeFirst(player.inventory, found);
      const newHp = Math.min(player.hp + HERB_HEAL, maxHp);
      const healed = newHp - player.hp;
      db.updatePlayer(player.id, { inventory: newInv2, hp: newHp });
      resultText = `🌿 Masticás la ${found}. Sus propiedades medicinales te curan ${healed} HP. (${newHp}/${maxHp} HP)`;
    }

  } else if (def.type === 'weapon') {
    // BUG-274: remover el arma nueva del inventario, devolver la anterior si había una
    const prevWeaponBonus = player.equipped_weapon ? (items.getItemDef(player.equipped_weapon)?.amount || 0) : 0;
    const baseAttack = player.attack - prevWeaponBonus;
    const newAttack = baseAttack + def.amount;

    const invUse = [...player.inventory];
    const foundIdxUse = invUse.indexOf(found);
    if (foundIdxUse !== -1) invUse.splice(foundIdxUse, 1);
    if (player.equipped_weapon) invUse.push(player.equipped_weapon); // devolver arma anterior

    db.updatePlayer(player.id, { attack: newAttack, equipped_weapon: found, inventory: invUse });

    const swapMsgUse = player.equipped_weapon ? ` (reemplaza ${player.equipped_weapon} → vuelve a tu mochila)` : '';
    resultText = `Equipás ${found}${swapMsgUse}. Tu ataque sube a ${newAttack}.`;

  } else if (def.type === 'atk_potion' && def.effect === 'power') {
    // DIS-D382: poción de poder — buff temporal de ATK (similar a pergaminos)
    const scrolls = JSON.parse(player.active_scrolls || '{}');
    const nowPow = Date.now();
    const expiresAtPow = nowPow + def.duration * 1000;

    // Registrar el buff activo bajo la clave 'power' (sobrescribe si ya hay uno)
    scrolls['power'] = { atk_bonus: def.atk_bonus, def_bonus: 0, expires_at: expiresAtPow };

    // Consumir el ítem
    const newInvPow = removeFirst(player.inventory, found);
    db.updatePlayer(player.id, { inventory: newInvPow, active_scrolls: JSON.stringify(scrolls) });

    resultText = `⚡ Bebés la ${found}. Una energía oscura recorre tus músculos. (+${def.atk_bonus} ATK por ${def.duration}s)`;

  } else if (def.type === 'spell_scroll') {
    // DIS-558: Pergamino de hechizo — próximo hechizo gratis (sin coste de maná)
    const freshP558 = db.getPlayer(player.id);
    if (!freshP558.player_class || freshP558.player_class !== 'mago') {
      return { text: `📜 Intentás leer el pergamino de hechizo, pero los símbolos arcanos no tienen sentido para vos. Este pergamino está calibrado para Magos.` };
    }
    const se558 = parseSE(freshP558.status_effects);
    se558['free_spell'] = true;
    const newInvSS = removeFirst(freshP558.inventory, found);
    db.updatePlayer(player.id, { inventory: newInvSS, status_effects: JSON.stringify(se558) });
    resultText = `📜 Leés el pergamino de hechizo. Las runas se disuelven y la energía arcana fluye hacia tus manos.\n✨ Tu próximo lanzamiento de hechizo no costará maná.`;

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

  } else if (def.type === 'armor') {
    // BUG-429: 'use <armadura>' debe equipar la armadura, no solo describir
    return cmdWear(player, found);

  } else if (def.type === 'bag') {
    // DIS-595: bolsa de lona — expande inventario en +slots (máx 2 bolsas = +8 slots)
    const freshBag = db.getPlayer(player.id);
    const currentBonus = freshBag.inventory_bonus || 0;
    const MAX_BAG_BONUS = 8; // máximo 2 bolsas de 4 slots
    if (currentBonus >= MAX_BAG_BONUS) {
      return { text: `🎒 Ya tenés el máximo de bolsas adicionales (2). Tu mochila no puede expandirse más.` };
    }
    const newBonus = Math.min(MAX_BAG_BONUS, currentBonus + def.slots);
    const newInvBag = removeFirst(freshBag.inventory, found);
    db.updatePlayer(player.id, { inventory: newInvBag, inventory_bonus: newBonus });
    resultText = `🎒 Atás la bolsa de lona a tu mochila. Tu capacidad de carga aumenta +${def.slots} slots.\n📦 Inventario: ${freshBag.inventory.length - 1}/${25 + newBonus} slots disponibles.`;

  } else {
    // DIS-D362: manejo especial de ítems sellados/abribles
    const foundLow = found.toLowerCase();
    if (foundLow.includes('carta sellada') || foundLow === 'carta') {
      // Abrir la carta sellada — narrativa de lore, consumir el ítem
      const newInvC = removeFirst(player.inventory, found);
      db.updatePlayer(player.id, { inventory: newInvC });
      resultText = `Con cuidado, rompés el sello de cera negra. El papel cruje levemente al desplegarse.\n\nLa letra es precisa, casi formal:\n\n  \"Si leés esto, llegaste más lejos de lo que esperaba cualquiera.\n  Kaelthas no puede morir — no de la manera que conocemos.\n  Encontró una forma de atar su esencia al dungeon mismo.\n  El único modo de terminar con esto es llegar al Trono del Vacío\n  y pronunciar su nombre completo en voz alta: no el que conocés.\n  El verdadero.\n\n  Lo grabé en la base del trono. Mirá abajo, no arriba.\n\n  Perdoname por no haberlo hecho yo mismo.\"\n\n  Sin firma. Solo el símbolo de dos llaves cruzadas.\n\n🔍 La carta sellada se deshace en polvo antiguo una vez que la leés.`;
    } else if (foundLow.includes('tomo sellado') || foundLow.includes('tomo')) {
      // DIS-D363: el tomo sellado tiene una condición real: necesitás el amuleto oscuro
      const freshP = db.getPlayer(player.id);
      const hasAmuleto = (freshP.inventory || []).some(i => i.toLowerCase().includes('amuleto oscuro'));
      if (hasAmuleto) {
        // Consumir el tomo y el amuleto — revelar el lore
        const invT = removeFirst(removeFirst(freshP.inventory, found), 'amuleto oscuro');
        db.updatePlayer(player.id, { inventory: invT });
        resultText = `Acercás el amuleto oscuro al tomo. Las cadenas de cuero vibran, se tensionan... y se parten.\n\nAbrís el tomo. Las páginas están escritas en un idioma que no reconocés, pero las ilustraciones son inconfundibles: diagramas del dungeon, trazados de energía, y al final, una sola página en el idioma del reino.\n\n  \"El Trono del Vacío no es un lugar. Es un acuerdo.\n  Kaelthas no lo construyó — lo negoció.\n  A cambio de inmortalidad, ata su nombre al dungeon.\n  Mientras el dungeon exista, él existe.\n  Para destruirlo, tenés que destruir el nombre.\n  Su nombre verdadero está grabado en la base del trono,\n  con sangre de dragón. Pronunciarlo rompe el acuerdo.\n  Y lo libera.\"\n\n  La última página tiene una sola palabra subrayada dos veces: CUIDADO.\n\n🔍 El tomo se cierra por última vez y su magia se disipa.`;
      } else {
        resultText = `Intentás abrir el tomo sellado, pero las cadenas de cuero resisten. El sello pulsa con energía oscura cuando lo tocás.\n\n¿Habrá algo en el dungeon que pueda neutralizar esta energía? El amuleto que a veces dropean los Magos Liches podría resonar con esto...`;
      }
    } else if (foundLow.includes('páginas congeladas') || foundLow.includes('paginas congeladas')) {
      // BUG-461: páginas congeladas — disparar tracking de Kaelthas igual que en cmdExamine
      // DIS-476: agregar entrada específica de las páginas siempre que sea la primera vez
      const seFreshPag = parseSE(player.status_effects);
      let diarioExtraPag = '';
      if (!seFreshPag.leyo_diario_galeria) {
        const kaeCount = (seFreshPag.kaelthas_menciones || 0) + 1;
        const newSePag = { ...seFreshPag, leyo_diario_galeria: true, kaelthas_menciones: kaeCount, 'kaelthas_menc_paginas_11': true };
        // Entrada genérica solo si es la 2ª mención
        if (kaeCount === 2 && !seFreshPag.kaelthas_nota_diario) {
          newSePag.kaelthas_nota_diario = true;
          db.addJournalEntry(player.id, 'lore', '🔍 Ese nombre — Kaelthas — aparece en varios lugares del dungeon. No es coincidencia. Alguien quiere que se recuerde, o que se olvide.');
        }
        // DIS-476: entrada específica de las páginas — siempre al leerlas por primera vez
        if (!seFreshPag.kaelthas_nota_paginas) {
          newSePag.kaelthas_nota_paginas = true;
          db.addJournalEntry(player.id, 'lore', '📖 Las páginas hablan de alguien que sabía demasiado. "Kaelthas no murió. Eligió esto." Las fechas del diario coinciden con cuando Valdrath desapareció de los mapas oficiales.');
          diarioExtraPag = '\n\n📖 *Nuevo apunte en tu diario: las páginas revelan algo sobre Kaelthas y Valdrath.*';
        }
        db.updatePlayer(player.id, { status_effects: JSON.stringify(newSePag) });
      }
      resultText = `Las páginas del diario están medio fusionadas por el hielo, pero alcanzás a leer tres fragmentos:\n\n  "...llegamos cuatro. Somos dos. El frío no mata — algo lo usa."\n\n  "...vi su sombra en la Catedral. Desde aquí. Eso no es posible."\n\n  "...Kaelthas no murió. Eligió esto. Lo entendí cuando me miró. Me conocía."${diarioExtraPag}`;
    } else {
      resultText = `Examinás ${found}: ${def.description}`;
    }
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
    return { text: 'Indicá qué querés tirar. Ej: "drop espada". Podés usar "drop junk" para tirar toda la basura de una vez.' };
  }

  player = db.getPlayer(player.id);

  // DIS-D44: drop junk / basura / todo basura — tirar todos los ítems sin valor mecánico
  const queryNorm = itemQuery.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (['junk', 'basura', 'todo basura', 'all junk', 'loot basura', 'tirar todo'].includes(queryNorm)) {
    const junkInInv = player.inventory.filter(i => items.isJunkItem(i));
    if (junkInInv.length === 0) {
      return { text: '✅ No tenés ítems basura en el inventario. ¡Limpio!' };
    }
    const newInv = player.inventory.filter(i => !items.isJunkItem(i));
    db.updatePlayer(player.id, { inventory: newInv });
    // Agregar al suelo
    const room = db.getRoom(player.current_room_id);
    if (room) {
      db.updateRoomItems(room.id, [...room.items, ...junkInInv]);
    }
    const lista = junkInInv.join(', ');
    return {
      text: `🗑️ Tirás toda la basura al suelo:\n  ${lista}\n\n(${junkInInv.length} ítem${junkInInv.length > 1 ? 's' : ''} eliminado${junkInInv.length > 1 ? 's' : ''} del inventario.)`,
      event: `${player.username} tira un montón de basura al suelo.`,
      eventRoomId: player.current_room_id,
    };
  }

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
    const droppedWeaponDef = items.getItemDef(found);
    const droppedWeaponBonus = droppedWeaponDef?.amount || 0;
    updates.attack = player.attack - droppedWeaponBonus;
  }
  // T152: Si era la armadura equipada, desequipar (volver a defensa sin armadura)
  if (player.equipped_armor && player.equipped_armor === found) {
    updates.equipped_armor = null;
    const armorDef = items.getItemDef(found);
    const armorAmt = armorDef ? (armorDef.amount || 0) : 0;
    updates.defense = (player.defense || 2) - armorAmt;
  }

  db.updatePlayer(player.id, updates);

  // Agregar al suelo de la habitación
  const room = db.getRoom(player.current_room_id);
  if (room) {
    db.updateRoomItems(room.id, [...room.items, found]);
  }

  let extraMsg = '';
  if (updates.equipped_weapon === null) extraMsg += ` Ya no tenés ningún arma equipada (ataque: ${updates.attack || player.attack}).`;
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

  const normalize = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const qLow = normalize(query.trim());

  // ¿Es un monstruo en la habitación?
  const monsters = db.getMonstersInRoom(player.current_room_id);
  // DIS-D402: Palabras que son lore de sala y no deben matchear monstruos por substring.
  // Ej: "forja" → no debe matchear "Golem de Forja", sino el lore de la sala 12.
  const LORE_PRIORITY_WORDS = new Set(['forja', 'altar', 'trono', 'cuerda', 'carta',
    'runa', 'runas', 'estatua', 'brazos', 'placa', 'suelo', 'sangre', 'celda',
    'celdas', 'reja', 'rejas', 'vitrales', 'vitral', 'grieta', 'abismo',
    'hongos', 'hongo', 'oscuridad', 'esporas', 'luz', 'obsidiana', 'espada',
    'herramientas', 'sombras', 'lago', 'agua', 'burbujas', 'plataformas',
    'gradas', 'esqueletos', 'arena', 'pozo', 'fuente', 'fisura', 'marmol', 'mármol', 'agua plateada',
    'cristales', 'cristal', 'ecos', 'eco', 'paredes eco',
    // BUG-418: palabras de lore en sala 11 (Galería de Hielo) que no deben matchear "Elemental de Hielo"
    'hielo', 'columnas', 'figuras',
    // BUG-419: "huesos" es lore de sala 5 (Sala de los Ecos), no debe matchear "peto de huesos"
    'huesos',
    // DIS-D417/D420: nuevas palabras de lore que no deben matchear ítems del inventario
    'cofres', 'estantes', 'velas', 'cera', 'trono',
    // DIS-D446: Casa de Subastas (sala 17)
    'estrado', 'candelabros', 'escriba']);
  const monster = monsters.find(m => {
    const mName = normalize(m.name);
    // Si el query es exactamente el nombre del monstruo o el nombre empieza por el query, matchear
    if (mName === qLow || mName.startsWith(qLow)) return true;
    // Si el monstruo contiene el query (match parcial del nombre compuesto),
    // verificar si la query coincide con una palabra de lore prioritaria.
    if (mName.includes(qLow) && LORE_PRIORITY_WORDS.has(qLow)) return false;
    return mName.includes(qLow);
  });
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

  // BUG-052: En sala 22 (Cripta de los Valientes), dar prioridad a objetos narrativos de sala
  // sobre ítems del inventario que puedan matchear (ej: "placas" → "armadura de placas")
  const CRIPTA_LORE = {
    'placas':        'Las placas de piedra cubren casi toda la pared norte de la Cripta. Cada una lleva un nombre grabado con precisión diferente — algunas tienen fechas, otras solo el nombre y un título. La más reciente todavía tiene polvo fresco en los bordes del cincel. Las más antiguas son ilegibles, borradas por la humedad de siglos.\n\nLos nombres no te dicen nada. Pero el hecho de que estén aquí —de que alguien se tomó el tiempo de grabarlos— es más perturbador que el silencio.',
    'pared':         'Las paredes de la Cripta están cubiertas de placas conmemorativas. Nombres, fechas, epitafios cortos. La pared te devuelve el eco de tu propia respiración. Más de uno de estos aventureros debe haber pensado que era inmortal.',
    'inscripciones': 'Las inscripciones de las placas son en su mayoría epitafios breves — \"murió como vivió\", \"no supo cuando parar\", \"fue al fondo aunque le dijeron que no\". Hay una que simplemente dice: \"Volvería a hacerlo.\"',
    'arco':          'El arco de entrada de la Cripta está decorado con calaveras de piedra que sujetan antorchas apagadas. La inscripción tallada en el dintel dice: \"Los que caen aquí no mueren dos veces.\"',
  };
  if (player.current_room_id === 22) {
    for (const [key, txt] of Object.entries(CRIPTA_LORE)) {
      if (qLow.includes(key) || key.includes(qLow)) {
        return { text: txt };
      }
    }
  }

  // DIS-511: Primero chequear si el ítem está específicamente en el inventario del jugador.
  // Esto evita que lore objects de sala roben la búsqueda cuando el jugador quiere examinar
  // algo que ya tiene en la mochila (ej: "examine carta sellada" con la carta en inventario).
  const invForExamine = player.inventory || [];
  const equippedForExamine = [player.equipped_weapon, player.equipped_armor].filter(Boolean);
  const invItemName = items.findItem([...invForExamine, ...equippedForExamine], query.trim());
  if (invItemName) {
    const def = items.getItemDef(invItemName);
    const isEquipped = equippedForExamine.includes(invItemName);
    const locationTag = isEquipped ? ' [equipado]' : ' [en mochila]';
    if (def) {
      const typeLabel = def.type === 'weapon' ? 'Arma' : def.type === 'potion' ? 'Poción' : def.type === 'armor' ? 'Armadura' : 'Objeto';
      // DIS-581: precio de venta estimado de Aldric
      const catalogEntry = SHOP_CATALOG.find(i => i.name.toLowerCase() === invItemName.toLowerCase());
      let sellLine = '';
      if (catalogEntry) {
        const sellAmt = Math.max(1, Math.floor(catalogEntry.price * SELL_PRICE_RATIO));
        sellLine = `💰 Precio de venta (Aldric): ~${sellAmt}g`;
      } else {
        // Ítem no vendible en tienda
        const NO_SELL_ITEMS = new Set(['páginas congeladas', 'paginas congeladas', 'carta sellada', 'carta abierta', 'diario helado', 'corona de hueso', 'piedra negra del lich', 'esencia de kaelthas']);
        if (NO_SELL_ITEMS.has(invItemName.toLowerCase())) {
          sellLine = `🚫 No vendible (objeto único o de misión)`;
        }
      }
      return {
        text: [
          `=== ${invItemName.toUpperCase()}${locationTag} ===`,
          def.description,
          `Tipo: ${typeLabel}`,
          def.amount !== undefined ? `Efecto: ${def.effect || 'daño'} ${def.amount > 0 ? '+' : ''}${def.amount}` : '',
          sellLine,
        ].filter(Boolean).join('\n'),
      };
    }
    return { text: `Examinás ${invItemName}${locationTag}: es un objeto corriente. No hay información adicional sobre él.` };
  }

  // ¿Es un ítem en el inventario, en el suelo, o equipado?
  const room = db.getRoom(player.current_room_id);
  const equippedItems = [player.equipped_weapon, player.equipped_armor].filter(Boolean);
  // BUG-410: Si la query es una lore-priority word, excluir ítems del suelo para que el lore
  // object de la sala tenga prioridad. Ej: "forja" con "núcleo de forja" en el suelo → lore wins.
  const roomItemsForSearch = LORE_PRIORITY_WORDS.has(qLow) ? [] : (room ? room.items : []);
  const allItems = [...roomItemsForSearch, ...equippedItems];
  const itemName = items.findItem(allItems, query.trim());
  if (itemName) {
    const def = items.getItemDef(itemName);
    if (def) {
      const typeLabel = def.type === 'weapon' ? 'Arma' : def.type === 'potion' ? 'Poción' : def.type === 'armor' ? 'Armadura' : 'Objeto';
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

  // STORY-008: examine aldric
  if (qLow.includes('aldric') || qLow === 'mercader' || qLow === 'tendero') {
    const room = db.getRoom(player.current_room_id);
    if (player.current_room_id === 4) {
      return { text: 'Aldric es un hombre de mediana edad con manos de comerciante y ojos de alguien que ha visto demasiado. Lleva un delantal con el símbolo de dos llaves cruzadas —el mismo que está en las paredes de la prisión del nivel inferior.\n\nNunca explica por qué está aquí. Cuando le preguntás, cambia el tema con una eficiencia que sugiere mucha práctica.\n\n"Si vas a comprar, comprá. Si no, las ruinas del fondo son más acogedoras de lo que parecen."' };
    } else {
      return { text: 'El mercader Aldric está en la Cámara del Tesoro (sala 4).\n  💡 Ruta desde la Entrada: norte → norte → este' };
    }
  }

  // STORY-003/004/005/010/011/012: objetos examinables de lore en salas específicas
  const room2 = db.getRoom(player.current_room_id);
  const loreObjects = {
    'pared':           { rooms: [2],  text: 'Las inscripciones son en su mayoría ilegibles, dañadas por siglos de humedad. Pero en la mitad del corredor, casi a la altura de los ojos, una sola línea ha sido protegida por una capa de cera endurecida. Con esfuerzo, podés descifrarla:\n\n  "KAELTHAS — EL QUE NO QUISO MORIR GOBERNÓ DESDE LAS SOMBRAS"\n\nEl nombre está grabado dos veces: una en las runas antiguas del reino, otra —más reciente— en letra cursiva perfecta.' },
    'inscripciones':   { rooms: [2],  text: 'Las inscripciones son en su mayoría ilegibles, dañadas por siglos de humedad. Pero en la mitad del corredor, casi a la altura de los ojos, una sola línea ha sido protegida por una capa de cera endurecida. Con esfuerzo, podés descifrarla:\n\n  "KAELTHAS — EL QUE NO QUISO MORIR GOBERNÓ DESDE LAS SOMBRAS"\n\nEl nombre está grabado dos veces: una en las runas antiguas del reino, otra —más reciente— en letra cursiva perfecta.' },
    // STORY-013: Goblin contextualizado en sala 2
    'goblin':          { rooms: [2],  text: 'El goblin no tiene interés en las inscripciones —de hecho, ha rayado algunas con un cuchillo sin entender lo que borra. Ha estado viviendo aquí el tiempo suficiente para acumular basura en un rincón: huesos de rata, piedras brillantes, un trozo de tela. Vino de fuera, siguiendo el olor al tesoro. Se quedó por las mismas razones que todos.' },
    'altar':           { rooms: [5],  text: 'El altar de piedra negra tiene marcas de uso continuo a lo largo de siglos, pero lo que llama tu atención está en la base: hay cera derretida fresca. Reciente. Las llamas de las velas se apagaron hace siglos —¿quién estuvo aquí, y cuándo? El resto del dungeon no tiene respuestas. Pero alguien las tiene.' },
    'trono':           { rooms: [9],  text: 'El trono está hecho de huesos ensamblados con precisión quirúrgica —no como un acto de brutalidad, sino como una declaración. Entre los brazos del trono, grabado en el hueso, hay un nombre en cursiva perfecta: KAELTHAS. Notás que el trono no tiene polvo. Lo demás en la sala lleva siglos sin ser tocado. Alguien se sienta aquí regularmente.' },
    'escudos':         { rooms: [9],  text: 'Los escudos de los reinos extintos están todos ligeramente opacos de polvo... excepto uno. El más oscuro, sin emblema, brilla como si acabara de ser pulido. No tiene insignia. Solo una fecha grabada en el borde inferior: el año en que cayó el Reino de Valdrath.' },
    'cuerda':          { rooms: [7],  text: 'La cuerda está atada en lo alto a un gancho de hierro de manufactura antigua. Intentás tirar de ella para saber qué hay abajo. El frío que sube desde las profundidades te hace soltar de inmediato —no es temperatura, es algo más. Un rechazo activo, deliberado. Mirás más de cerca los nudos: la cuerda tiene marcas de haber sido cortada desde abajo. Alguien —o algo— no quería que nadie bajara.' },
    'forja':           { rooms: [12], text: 'El fuego de la forja lleva ardiendo más tiempo del que nadie recuerda, sin carbón ni madera visible. Sobre el yunque hay un molde para una espada que nunca se terminó —los bordes muestran marcas de garras, no de herramientas. Algo o alguien intentó completar la obra sin los conocimientos necesarios.\n\nLo más inquietante: el fuego es perfecto, uniforme, constante. Como una respiración.' },
    'runas':           { rooms: [10], text: 'Las runas con sangre seca forman un patrón que tardás un momento en ver completo: es un círculo, y en su centro hay un nombre escrito en un idioma que nadie habla hace doscientos años. No sabés cómo, pero lo podés leer: K-A-E-L-T-H-A-S. El patrón de las runas forma un nombre. No querés saber cómo lo sabés.' },
    'runa':            { rooms: [10], text: 'Las runas con sangre seca forman un patrón que tardás un momento en ver completo: es un círculo, y en su centro hay un nombre escrito en un idioma que nadie habla hace doscientos años. No sabés cómo, pero lo podés leer: K-A-E-L-T-H-A-S. El patrón de las runas forma un nombre. No querés saber cómo lo sabés.' },
    'estatua':         { rooms: [10], text: 'La estatua con diez brazos no corresponde a ningún dios que conozcas. Cada brazo sostiene algo distinto: un escudo, una espada, un libro, una llave, una copa, una antorcha... Los últimos tres brazos están vacíos. La placa en la base está en blanco, raspada hasta la piedra. Alguien borró el nombre deliberadamente.' },
    'brazos':          { rooms: [10], text: 'Siete de los diez brazos de la estatua sostienen objetos: un escudo, una espada, un libro, una llave, una copa, una antorcha y algo que no reconocés —una esfera de obsidiana perfecta. Los otros tres brazos están extendidos y vacíos, con las palmas hacia arriba, como esperando ofrendas. El polvo de siglos ha respetado los huecos.' },
    'placa':           { rooms: [10], text: 'La placa de piedra en la base de la estatua fue raspada con deliberación, no por el tiempo. Podés ver las marcas de una herramienta afilada —alguien borró el nombre con cuidado. Aun así, quedan trazos. Con luz y paciencia, podés adivinar tres letras: K, A, E. El resto desapareció para siempre.' },
    'suelo':           { rooms: [10], text: 'El suelo del Santuario es la parte más perturbadora de la sala. Las runas forman círculos concéntricos que convergen en el centro exacto —donde estás parado. El diámetro del círculo externo coincide perfectamente con las dimensiones de la sala. Alguien diseñó esto. No fue accidental.' },
    'sangre':          { rooms: [10], text: 'La sangre seca de las runas lleva décadas aquí, pero no se ha oscurecido como debería. Tiene un color rojo profundo, casi fresco. Al acercarte, notás que emana un calor tenue —el mismo que reconocerías si alguna vez pusiste la mano sobre una brasa casi apagada. Algo mantiene esto activo.' },
    'carta':           { rooms: [8],  text: 'Un sobre sellado con cera negra, marcado con el símbolo de dos llaves cruzadas. La cera está intacta. Podés abrirla, pero algo en vos duda: hay cosas que no se pueden ignorar una vez que se saben.\n\n💡 Tip: usá "use carta sellada" o "open carta sellada" para leer su contenido.' },
    'carta sellada':   { rooms: [8],  text: 'Un sobre sellado con cera negra, marcado con el símbolo de dos llaves cruzadas. La cera está intacta. El papel es viejo pero el sellado es perfecto —alguien tomó cuidado de que esto durara. En el reverso, en letra pequeña: "Para quien llegue después. Perdoname." Sin firma.\n\n🔍 El símbolo de las dos llaves cruzadas... lo viste antes. En el delantal de alguien. De un mercader que eligió este dungeon por razones que nunca explicó.' },
    'celda':           { rooms: [8],  text: 'Las celdas de la Prisión Subterránea tienen rejas de hierro negro, tan antiguas que la herrumbre formó costras decorativas. La mayoría están abiertas, los candados forzados desde adentro —lo que sea que estuvo encerrado aquí no esperó que nadie lo liberara.\n\nUna celda en el fondo tiene las barras dobladas hacia afuera con una fuerza que ningún humano podría ejercer. El colchón de paja adentro todavía guarda la forma de algo grande.' },
    'celdas':          { rooms: [8],  text: 'Las celdas de la Prisión Subterránea tienen rejas de hierro negro, tan antiguas que la herrumbre formó costras decorativas. La mayoría están abiertas, los candados forzados desde adentro —lo que sea que estuvo encerrado aquí no esperó que nadie lo liberara.\n\nUna celda en el fondo tiene las barras dobladas hacia afuera con una fuerza que ningún humano podría ejercer. El colchón de paja adentro todavía guarda la forma de algo grande.' },
    'reja':            { rooms: [8],  text: 'Las rejas de la Prisión son de hierro macizo, forjado con las técnicas del Reino de Valdrath —el mismo símbolo de las dos llaves está grabado en cada cerradura. Todas están abiertas. Forzadas, no desbloqueadas. Desde adentro.\n\nNo hay marcas de herramientas en las cerraduras. Lo que estuvo encerrado aquí no usó herramientas.' },
    'rejas':           { rooms: [8],  text: 'Las rejas de la Prisión son de hierro macizo, forjado con las técnicas del Reino de Valdrath —el mismo símbolo de las dos llaves está grabado en cada cerradura. Todas están abiertas. Forzadas, no desbloqueadas. Desde adentro.\n\nNo hay marcas de herramientas en las cerraduras. Lo que estuvo encerrado aquí no usó herramientas.' },
    'pared carcel':    { rooms: [8],  text: 'Las paredes de la Prisión están cubiertas de marcas de rayaduras —intentos de contar días, tal vez, o de comunicarse entre celdas. Pero hay algo diferente cerca del techo: líneas de texto grabadas en un idioma que no reconocés, pero que forman un patrón circular. Igual al que viste en el Santuario. Quien estuvo encerrado aquí conocía las mismas runas.' },
    // STORY-007: Diario de aventurero anterior en sala 11 (Galería de Hielo)
    'cadaver':         { rooms: [11], text: 'Uno de los cadáveres congelados lleva encima lo que queda de un diario. Las páginas están tan heladas que al tocarlas crean ruido de cristal roto.' },
    'cadáver':         { rooms: [11], text: 'Uno de los cadáveres congelados lleva encima lo que queda de un diario. Las páginas están tan heladas que al tocarlas crean ruido de cristal roto.' },
    'cadaveres':       { rooms: [11], text: 'Los cadáveres están perfectamente conservados por el frío. Todos miran hacia el norte —hacia la Catedral. Como si hubieran decidido no seguir y aun así no pudieran dejar de mirar.' },
    'cadáveres':       { rooms: [11], text: 'Los cadáveres están perfectamente conservados por el frío. Todos miran hacia el norte —hacia la Catedral. Como si hubieran decidido no seguir y aun así no pudieran dejar de mirar.' },
    'paginas':         { rooms: [11], text: 'Las páginas del diario están medio fusionadas por el hielo, pero alcanzás a leer tres fragmentos:\n\n  "...llegamos cuatro. Somos dos. El frío no mata — algo lo usa."\n\n  "...vi su sombra en la Catedral. Desde aquí. Eso no es posible."\n\n  "...Kaelthas no murió. Eligió esto. Lo entendí cuando me miró. Me conocía."' },
    'páginas':         { rooms: [11], text: 'Las páginas del diario están medio fusionadas por el hielo, pero alcanzás a leer tres fragmentos:\n\n  "...llegamos cuatro. Somos dos. El frío no mata — algo lo usa."\n\n  "...vi su sombra en la Catedral. Desde aquí. Eso no es posible."\n\n  "...Kaelthas no murió. Eligió esto. Lo entendí cuando me miró. Me conocía."' },
    'diario':          { rooms: [11], text: 'Las páginas del diario están medio fusionadas por el hielo, pero alcanzás a leer tres fragmentos:\n\n  "...llegamos cuatro. Somos dos. El frío no mata — algo lo usa."\n\n  "...vi su sombra en la Catedral. Desde aquí. Eso no es posible."\n\n  "...Kaelthas no murió. Eligió esto. Lo entendí cuando me miró. Me conocía."' },
    'diario helado':   { rooms: [11], text: 'Las páginas del diario están medio fusionadas por el hielo, pero alcanzás a leer tres fragmentos:\n\n  "...llegamos cuatro. Somos dos. El frío no mata — algo lo usa."\n\n  "...vi su sombra en la Catedral. Desde aquí. Eso no es posible."\n\n  "...Kaelthas no murió. Eligió esto. Lo entendí cuando me miró. Me conocía."' },
    // DIS-D40: objetos ambientales examinables (hongos sala 6, vitrales sala 15, grieta sala 20)
    'hongos':          { rooms: [6],  text: 'Los hongos luminiscentes emiten una luz azul-verdosa que no proyecta sombras. Tocás uno con el dedo: es suave, casi caliente, y deja una tintura que no desaparece. El tallo es hueco. Si aplastás uno, libera esporas que brillan en el aire unos segundos antes de apagarse.\n\nNo son hongos normales. Responden a la presencia —cuando te acercás demasiado rápido, los más cercanos se apagan un instante, como un destello de alarma.' },
    'hongo':           { rooms: [6],  text: 'Los hongos luminiscentes emiten una luz azul-verdosa que no proyecta sombras. Tocás uno con el dedo: es suave, casi caliente, y deja una tintura que no desaparece. El tallo es hueco. Si aplastás uno, libera esporas que brillan en el aire unos segundos antes de apagarse.\n\nNo son hongos normales. Responden a la presencia —cuando te acercás demasiado rápido, los más cercanos se apagan un instante, como un destello de alarma.' },
    'luz':             { rooms: [6],  text: 'La luz de los hongos no viene de ningún punto fijo — emana de las paredes, el techo, incluso del suelo en algunos parches. No hay sombras. Eso resulta más perturbador que la oscuridad: cada objeto tiene cuatro fuentes de luz distintas y ninguna sombra. El cerebro intenta compensar y fracasa.' },
    'esporas':         { rooms: [6],  text: 'Las esporas flotan en el aire en cantidades apenas visibles, como polvo dorado. No las estás respirando conscientemente, pero ya te picaron un poco los ojos. Las paredes más viejas del túnel tienen una costra de esporas endurecidas de décadas. Si se activaran todas a la vez, el túnel entero sería tóxico en segundos.' },
    'vitrales':        { rooms: [15], text: 'Los vitrales son de un negro tan profundo que parecen absorber la luz antes de que pueda atravesarlos. Y sin embargo, hay algo al otro lado —no luz, sino una oscuridad de textura diferente, más densa, que se mueve.\n\nUno de los paneles tiene una grieta fina que recorre su diagonal. Al acercarte, notás que la grieta no está en el vidrio sino en el espacio detrás de él. No tiene explicación arquitectónica posible.' },
    'vitral':          { rooms: [15], text: 'Los vitrales son de un negro tan profundo que parecen absorber la luz antes de que pueda atravesarlos. Y sin embargo, hay algo al otro lado —no luz, sino una oscuridad de textura diferente, más densa, que se mueve.\n\nUno de los paneles tiene una grieta fina que recorre su diagonal. Al acercarte, notás que la grieta no está en el vidrio sino en el espacio detrás de él. No tiene explicación arquitectónica posible.' },
    'altar catedral':           { rooms: [15], text: 'El altar de la Catedral está tallado en una sola pieza de piedra oscura que no tiene costuras ni marcas de cincel. Sobre él, la espada de obsidiana parece flotar un milímetro por encima de la superficie. Cuando extendés la mano, sentís una presión suave que te empuja hacia atrás —no violenta, casi cortés. El altar no quiere que la toques antes de estar listo.\n\nEn la base, en letras tan pequeñas que requieren cuclillas para leer: "El que toma sin merecer, devuelve más de lo que tomó."' },
    // BUG-411: 'espada' y 'obsidiana' tienen descripción propia de la espada
    // DIS-579: incluir nivel requerido para tomar la espada
    'espada':              { rooms: [15], text: 'La espada de obsidiana es negra de una manera que no es color sino ausencia. Donde debería haber un filo, hay una línea donde la luz simplemente deja de existir —no se refleja, no se dispersa, desaparece.\n\nCuando extendés la mano hacia ella, sentís una resistencia que no es física: es una presión en la mente, un umbral. La hoja no te rechaza. Te evalúa.\n\nLos bordes no tienen marcas de uso, pero tampoco parecen nuevos. Es como si el tiempo no pasara por ella.\n\n⚔️ Nivel requerido para equiparla: 6 (o tomarla del altar: sin restricción de nivel, pero enfrentarás al Lich Anciano —nivel recomendado 7).' },
    'obsidiana':           { rooms: [15], text: 'La espada de obsidiana es negra de una manera que no es color sino ausencia. Donde debería haber un filo, hay una línea donde la luz simplemente deja de existir —no se refleja, no se dispersa, desaparece.\n\nCuando extendés la mano hacia ella, sentís una resistencia que no es física: es una presión en la mente, un umbral. La hoja no te rechaza. Te evalúa.\n\nLos bordes no tienen marcas de uso, pero tampoco parecen nuevos. Es como si el tiempo no pasara por ella.\n\n⚔️ Nivel requerido para equiparla: 6 (o tomarla del altar: sin restricción de nivel, pero enfrentarás al Lich Anciano —nivel recomendado 7).' },
    'espada de obsidiana': { rooms: [15], text: 'La espada de obsidiana es negra de una manera que no es color sino ausencia. Donde debería haber un filo, hay una línea donde la luz simplemente deja de existir —no se refleja, no se dispersa, desaparece.\n\nCuando extendés la mano hacia ella, sentís una resistencia que no es física: es una presión en la mente, un umbral. La hoja no te rechaza. Te evalúa.\n\n⚔️ Nivel requerido para equiparla: 6 (o tomarla del altar: sin restricción de nivel, pero enfrentarás al Lich Anciano —nivel recomendado 7).' },
    'abismo':          { rooms: [20], text: 'La grieta en el suelo del Abismo no tiene fondo visible. Tirás una piedra: escuchás el impacto... pero tarda tres segundos, y el sonido sube distorsionado, como si el aire allá abajo tuviera una densidad diferente. Los bordes de la grieta están lisos, pulidos —no por erosión, sino por algo que frotó contra ellos repetidamente desde abajo.\n\nNo querés saber qué.' },
    'oscuridad':       { rooms: [20], text: 'La oscuridad del Abismo Eterno no es ausencia de luz — es una presencia. Tiene peso. Cuando apuntás tu antorcha hacia abajo, la llama se inclina hacia la grieta como si algo la atrajera. Te apartás instintivamente.' },
    // DIS-D397: Taller de la Forja (sala 12) — elementos interactivos
    'herramientas':    { rooms: [12], text: 'Las herramientas de la Forja son de dimensiones colosales —el martillo principal pesa lo que pesan dos hombres, el yunque podría usarse como lápida para un gigante. Pero lo perturbador no es el tamaño: es el estado. Las herramientas no tienen polvo. Están perfectamente mantenidas, con la pátina característica de uso reciente.\n\nAlguien las usa. Regularmente. Sin dejar rastro de presencia humana.' },
    'sombras':         { rooms: [12], text: 'Las sombras del Taller se mueven con una lentitud que no corresponde a la luz. Cuando te quedás quieto y mirás un rincón fijo, las sombras avanzan levemente —no hacia vos, sino hacia las herramientas. Como si algo invisible estuviera trabajando en ellas.\n\nCuando te movés, las sombras vuelven a su posición normal. Podría ser ilusión óptica. Probablemente no lo es.' },
    // DIS-D398: Caverna Sumergida (sala 13) — elementos interactivos
    'lago':            { rooms: [13], text: 'El lago negro refleja la luz de tu antorcha, pero el reflejo está levemente desfasado —como si hubiera un retraso entre el movimiento y su imagen en el agua. Mirás hacia el fondo: no tiene. La oscuridad debajo de la superficie es absoluta y uniforme.\n\nCuando aguantás la respiración y te quedás inmóvil, escuchás algo. Una respiración. Del lago.' },
    'agua':            { rooms: [13], text: 'El agua está perfectamente quieta a pesar de la ausencia de luz y el aire en movimiento. No hay corriente visible. Tocás la superficie con un dedo: es fría de un modo que no es temperatura sino ausencia de algo. La mano la retirás antes de pensarlo conscientemente.' },
    'burbujas':        { rooms: [13], text: 'Las burbujas ascienden desde el fondo del lago a intervalos regulares —exactamente cada doce segundos, contás mentalmente. Demasiado regular para ser gas. Demasiado pausado para ser urgente. Es más parecido a una exhalación.\n\nAlgo abajo respira. Regularmente. Con mucha calma.' },
    'plataformas':     { rooms: [13], text: 'Las plataformas de roca atraviesan el lago con una disposición que parece natural pero es demasiado conveniente. La separación entre ellas es exactamente la longitud de un paso humano. Alguien las diseñó —o las puso ahí— para que una persona pudiera cruzar.\n\nNo sabés si eso es tranquilizador o lo opuesto.' },
    // DIS-D399: Coliseo de Huesos (sala 14) — elementos interactivos
    'gradas':          { rooms: [14], text: 'Las gradas del Coliseo están llenas de esqueletos sentados en posición de espectadores: algunos se inclinan hacia adelante como si siguieran la acción, otros tienen la mandíbula abierta en un grito que nunca llegó. Todos miran al centro de la arena.\n\nLo más perturbador: los esqueletos de las primeras filas tienen sus manos huesudas apoyadas en las rodillas del esqueleto delantero, como harías vos en un estadio lleno.' },
    'espectadores':    { rooms: [14], text: 'Las gradas del Coliseo están llenas de esqueletos sentados en posición de espectadores: algunos se inclinan hacia adelante como si siguieran la acción, otros tienen la mandíbula abierta en un grito que nunca llegó. Todos miran al centro de la arena.\n\nLo más perturbador: los esqueletos de las primeras filas tienen sus manos huesudas apoyadas en las rodillas del esqueleto delantero, como harías vos en un estadio lleno. Vinieron a ver. Y se quedaron para siempre.' },
    'esqueletos':      { rooms: [14], text: 'Los esqueletos del Coliseo no son víctimas del dungeon —sus ropas, aunque podridas, corresponden a distintas épocas y regiones. Vinieron a ver. Vinieron voluntariamente, en algún momento de la historia de este lugar.\n\nUno de ellos, en la fila central, sostiene todavía un pergamino en la mano. Las letras son ilegibles, pero el formato es inconfundible: una apuesta.' },
    'arena':           { rooms: [14], text: 'La arena del Coliseo está cubierta de una capa de arena fina y oscura. En el centro exacto hay una mancha circular, más oscura que el resto, de unos dos metros de diámetro. Sangre antigua, absorbida a lo largo de décadas o siglos.\n\nLos surcos en la arena muestran patrones de movimiento —círculos, esquivas, avances. Alguien entrenó aquí, solo, durante mucho tiempo. Los surcos son frescos.' },
    // DIS-495: Inscripción del Coliseo con pista sobre la Fase 2 del Lich
    'inscripcion':     { rooms: [14], text: 'En el extremo norte del Coliseo, grabada en la piedra más oscura, hay una advertencia en idioma antiguo. La traducís lentamente:\n\n  "AL QUE MATE AL PORTADOR DE LA CORONA DE HUESO: NO CREAS QUE HA TERMINADO.\n  UN LICHE NO MUERE EN SU CUERPO. SU ESENCIA DUERME EN LA PIEDRA NEGRA QUE LLEVA AL PECHO.\n  DESTRUÍ LA PIEDRA. O VOLVERA."\n\nLas últimas letras están grabadas con más fuerza que las anteriores, como si quien las escribió lo hubiera hecho en un estado de urgencia, o de miedo.' },
    'piedra':          { rooms: [14], text: 'En el extremo norte del Coliseo, grabada en la piedra más oscura, hay una advertencia en idioma antiguo. La traducís lentamente:\n\n  "AL QUE MATE AL PORTADOR DE LA CORONA DE HUESO: NO CREAS QUE HA TERMINADO.\n  UN LICHE NO MUERE EN SU CUERPO. SU ESENCIA DUERME EN LA PIEDRA NEGRA QUE LLEVA AL PECHO.\n  DESTRUÍ LA PIEDRA. O VOLVERA."\n\nLas últimas letras están grabadas con más fuerza que las anteriores, como si quien las escribió lo hubiera hecho en un estado de urgencia, o de miedo.' },
    // DIS-D400: Pozo Sin Fondo (sala 7) — elemento principal
    'pozo':            { rooms: [7],  text: 'El pozo está en el centro exacto de la sala, con un brocal de piedra que tiene marcas de dedos —uñas, por la profundidad de los surcos. La cuerda que alguna vez colgó de la polea de arriba fue cortada. Desde abajo.\n\nEl frío que sube del pozo no es temperatura del aire: es un rechazo activo, una presión hacia afuera. Algo en el fondo no quiere compañía. O algo en el fondo prefiere que no sepás lo que hay.' },
    // DIS-575: Puerta norte del Pozo — hint sobre llave oxidada y Araña Tejedora
    'puerta':          { rooms: [7],  text: 'La puerta al norte del Pozo Sin Fondo es de hierro macizo, con una cerradura de manufactura antigua. La cerradura tiene marcas de uso —alguien la abría regularmente antes de que vos llegaras.\n\n🔑 Para abrirla necesitás una **llave oxidada**.\n\n💡 Podés conseguirla de tres formas:\n  • Comprarla en la tienda de Aldric (sala 4, Cámara del Tesoro) por 20 monedas de oro\n  • Buscarla en la Prisión Subterránea (sala 8, al norte del Tesoro)\n  • La **Araña Tejedora** de este mismo Pozo la lleva consigo a veces (15% de chance)\n\n🗺 Si no tenés la llave, hay una ruta alternativa sin cerradura:\n  Entrada → este → Capilla Olvidada → norte → Túnel de Hongos → norte → Sala del Trono → este → Santuario Profano.' },
    // DIS-D413: Cámara de la Fuente Eterna (sala 18) — elementos interactivos
    'fuente':          { rooms: [18], text: 'La fuente de mármol blanco ocupa el centro exacto de la sala. El agua que mana de ella es plateada —no por el reflejo de la luz, sino en sí misma. Nunca se agota: el nivel permanece constante independientemente de cuánto bebas.\n\nLas runas del borde cambian de forma si las mirás de reojo. Mirás directo: no se mueven. Mirás de costado: diferentes. Tocás el agua: la mano no se moja. El agua la cruza y sigue cayendo.\n\n💧 Para beber de la fuente y restaurar tu salud, usá el comando "beber".' },
    'fisura':          { rooms: [18], text: 'La fisura en el suelo es fina pero perfectamente recta —demasiado recta para ser natural. El agua de la fuente se filtra por ella hacia abajo, formando una cortina microscópica que no hace ruido.\n\nTe agachás a mirar: más abajo hay luz. No reflejo de la fuente, sino una luminosidad propia, azulada. Alguien, en algún momento, construyó esta sala encima de algo que ya estaba brillando.' },
    'runas eterna':    { rooms: [18], text: 'Las runas en las paredes de la Cámara de la Fuente son diferentes a las del Santuario —mientras aquellas forman patrones de invocación, estas son concéntricas, como capas de una cebolla, cada círculo más pequeño hacia el centro.\n\nEl círculo interior es tan pequeño que casi no se ve. Pero está grabado en el mármol encima de la fuente: una sola runa, diferente a todas las demás. No la reconocés, pero entendés su función intuitivamente: significa "permanecer".' },
    'runas fuente':    { rooms: [18], text: 'Las runas en las paredes de la Cámara de la Fuente son diferentes a las del Santuario —mientras aquellas forman patrones de invocación, estas son concéntricas, como capas de una cebolla, cada círculo más pequeño hacia el centro.\n\nEl círculo interior es tan pequeño que casi no se ve. Pero está grabado en el mármol encima de la fuente: una sola runa, diferente a todas las demás. No la reconocés, pero entendés su función intuitivamente: significa "permanecer".' },
    'agua plateada':   { rooms: [18], text: 'El agua plateada de la fuente no tiene temperatura perceptible. Cuando la tocás, la mano la cruza como si el agua no estuviera ahí, pero sí sentís algo: una presión suave, como si el agua te estuviera evaluando.\n\nLa luminosidad plateada no viene de ninguna fuente de luz. El agua en sí misma emite. No mucho —lo suficiente para que la sala se vea con claridad incluso sin antorcha. Lleva ardiendo así desde antes de que el dungeon existiera.' },
    'marmol':          { rooms: [18], text: 'El mármol blanco de la Cámara está perfectamente intacto —sin grietas, sin manchas de humedad, sin el desgaste que el tiempo deja en cualquier piedra. Es como si el tiempo no pasara en esta sala.\n\nLas venas naturales del mármol forman patrones en las paredes. Si las seguís con los ojos, los patrones convergen hacia la fuente. No podés determinar si eso es diseño intencional o ilusión óptica.' },
    // DIS-D414: Cámara del Eco (sala 19) — elementos interactivos
    'cristales':       { rooms: [19], text: 'Los cristales resonantes cubren las paredes hasta el techo, cada uno del tamaño de un puño. Al pisarlos, vibran con una frecuencia que sentís en los dientes antes que en los oídos.\n\nSi prestás atención, los cristales de distintas paredes vibran en secuencia —como si estuvieran pasando algo entre sí. Una cadena de vibraciones que viaja por toda la sala y vuelve al punto de inicio. Repetidamente. Desde antes de que entraras.' },
    'cristal':         { rooms: [19], text: 'Cada cristal de la Cámara es único en forma, pero todos tienen el mismo tinte grisáceo con venas azules. Cuando la luz los atraviesa, proyectan sombras en colores que no tendrían que existir —el morado de algo que no es luz.\n\nTomás uno en la mano: no pesa nada. Y en el momento en que lo soltás, escuchás, clarísimo, tu propio nombre pronunciado en voz baja detrás de vos. Al darte vuelta: nadie.' },
    'ecos':            { rooms: [19], text: 'Los ecos de la Cámara no son simples rebotes del sonido. Escuchás tu voz cuando hablás, pero también escuchás palabras que no dijiste —frases a medio terminar, nombres, números contados en voz baja.\n\nAlguien —o varios— han estado en esta sala antes. Los ecos guardan algo de cada voz que habló aquí. Los muertos siguen hablando en esta sala, un segundo después de que dejaron de poder hacerlo.' },
    'eco':             { rooms: [19], text: 'Los ecos de la Cámara no son simples rebotes del sonido. Escuchás tu voz cuando hablás, pero también escuchás palabras que no dijiste —frases a medio terminar, nombres, números contados en voz baja.\n\nAlguien —o varios— han estado en esta sala antes. Los ecos guardan algo de cada voz que habló aquí. Los muertos siguen hablando en esta sala, un segundo después de que dejaron de poder hacerlo.' },
    'paredes eco':     { rooms: [19], text: 'Las paredes de la Cámara del Eco son de piedra oscura cubierta completamente por los cristales resonantes. Donde la piedra asoma entre los cristales, hay marcas de uñas —muchas, en distintas alturas, como si varias personas hubieran arañado la pared intentando encontrar algo.\n\nEn un tramo de la pared sur, más alto de lo que cualquier persona podría alcanzar sin ayuda, hay cinco palabras grabadas en piedra. El idioma es antiguo, pero las podés leer: "AÚN ESCUCHO LAS VOCES AQUÍ".' },
    // BUG-418: Galería de Hielo (sala 11) — lore objects para hielo, columnas, figuras
    'hielo':           { rooms: [11], text: 'El frío de la Galería de Hielo no es temperatura del aire —es una presencia. Se asienta sobre la piel de una manera que el frío normal no hace: no te enfría desde afuera, sino desde adentro, como si extrajera calor de la sangre.\n\nLas paredes están cubiertas por una capa de hielo perfectamente uniforme, sin burbujas ni grietas. Demasiado uniforme. Natural o creado así deliberadamente —no podés decirlo. En algunos tramos el hielo tiene transparencia suficiente para ver formas detrás: sombras que no se mueven cuando te movés.' },
    'columnas':        { rooms: [11], text: 'Las columnas de la Galería son de piedra recubierta por el hielo, pero al mirar la base de cada una notás algo: no son columnas de carga. Son decorativas. Alguien construyó este corredor para que pareciera una galería de exhibición.\n\nCada columna tiene, en su base, una placa de metal ennegrecida. Los textos son ilegibles por la escarcha, pero el formato es el mismo en todas: título, fecha, y algo más corto —un epitafio, quizás. La Galería de Hielo no es un corredor. Es un mausoleo.' },
    'figuras':         { rooms: [11], text: 'Las figuras congeladas dentro del hielo no son estatuas: son personas reales, preservadas en el mismo momento en que quedaron atrapadas. Los gestos lo delatan —brazos extendidos en equilibrio, cabezas giradas hacia atrás, bocas abiertas.\n\nLo que más te perturba: algunas figuras miran hacia vos. Sus ojos congelados siguen la posición donde estás parado, no hacia la entrada. Alguien las orientó así después de que el hielo las capturó. Alguien las reacomodó para que miraran a los visitantes.' },
    // BUG-419: Sala de los Ecos (sala 3) — lore object para huesos
    'huesos':          { rooms: [3],  text: 'El suelo de la Sala de los Ecos está cubierto de huesos —no amontonados, sino esparcidos con cierta uniformidad, como si el tiempo los hubiera redistribuido. La mayoría son demasiado fragmentados para identificar su origen.\n\nPero en el centro de la sala hay un conjunto diferente: tres cráneos colocados formando un triángulo perfecto, con las cuencas orientadas hacia el centro. No fue el tiempo. Alguien los puso así, deliberadamente, en algún momento entre el principio y ahora.\n\nLos ecos de la sala devuelven el sonido de tus pasos, pero también algo más: el eco de pasos que no son los tuyos, de cuando alguien caminó por aquí y acomodó los cráneos.' },
    // DIS-D417: Sala de los Ecos (sala 3) — trono vacío
    'trono ecos':      { rooms: [3],  text: 'Un trono de piedra descansa contra la pared norte de la Sala. No es el trono del Coliseo ni el de la sala del Rey —es anterior a ambos, más simple, con los brazos desgastados por el uso. Las marcas de las manos están talladas en la piedra: alguien se sentó aquí durante años, suficientes años para pulir la roca con el calor y el roce de sus palmas.\n\nNo hay polvo en el asiento. Lo notás inmediatamente. Todo lo demás en la sala tiene décadas de polvo acumulado. El trono no.\n\nLos ecos de la sala en este rincón son distintos. Más silenciosos, como si el sonido huyera del trono.' },
    // DIS-D417: Cámara del Tesoro (sala 4) — cofres y estantes
    'cofres':          { rooms: [4],  text: 'Los cofres de la Cámara del Tesoro están todos abiertos, algunos de par en par. No fueron forzados —las cerraduras están intactas, las tapas simplemente levantadas. El interior de cada uno está limpio: no vaciados a las apuradas, sino ordenadamente. Quien los vació conocía el contenido de antemano.\n\nUno de los cofres en el fondo tiene el fondo doble. Lo notás porque el sonido que produce al golpearlo no coincide con la profundidad visual. Está vacío también —el compartimento secreto encontrado y expoliado antes de que llegaras.' },
    'estantes':        { rooms: [4],  text: 'Los estantes de madera oscura de la Cámara están parcialmente llenos con objetos que nadie ha reclamado: cerámica de distintas épocas, rollos de cuero cuya escritura se ha borrado, instrumentos de metal de función incierta. Todo está catalogado con etiquetas atadas —los precios de un mercader sistemático.\n\nEl estante del fondo tiene un espacio vacío con dos ganchos de metal, como si algo importante estuvo colgado ahí hasta hace poco. Aldric nunca menciona lo que desapareció de esos ganchos. Si le preguntás directamente, cambia el tema.' },
    // DIS-D420: Capilla Olvidada (sala 5) — velas y cera
    'velas':           { rooms: [5],  text: 'Las velas de la Capilla están apagadas desde hace siglos —el pabilo negro y quebradizo, la cera endurecida y opaca. Pero hay algo que no encaja: algunas de las velas tienen marcas de haber ardido recientemente. La cera en esas tiene una textura distinta, más suave, con el brillo mate característico de la cera enfriada en las últimas horas.\n\nAlguien encendió velas aquí. Las dejó arder. Volvió antes de que se consumieran o las apagó. Y se fue sin dejar otra huella.\n\nLa inscripción en la pared dice: "Quienquiera que encienda estas velas merece lo que viene." No sabés si es advertencia o promesa.' },
    'cera':            { rooms: [5],  text: 'La cera derretida fresca en la base del altar no tiene explicación inocente. El altar lleva siglos sin ser usado —la piedra negra tiene depósitos minerales que solo se forman con décadas de inactividad. Y sin embargo, la cera es reciente.\n\nMirás más de cerca: hay dos charcos. Uno antiguo, opaco, de hace siglos. Uno encima, translúcido, de hace días. La misma persona que conoce este lugar lo suficiente para saber dónde están las velas lo conoce también lo suficiente para saber qué se invoca aquí.\n\n🔍 El altar tiene más que mostrar — probá también examine altar.' },
    // DIS-D446: Casa de Subastas (sala 17) — lore objects examinables
    'estrado':         { rooms: [17], text: 'El estrado de roble barnizado ocupa el centro de la sala, elevado tres escalones sobre el suelo. La madera tiene la pátina oscura que solo dan décadas de barniz aplicado encima del anterior, nunca retirado.\n\nEn la superficie del estrado hay marcas de gaveta —ranuras paralelas donde la madera cedió bajo golpes repetidos. Cientos de subastas. Cada marca es el remate de algo: una armadura, un grimorio, una vida de aventuras reducida a precio de salida.\n\nEn el borde frontal hay grabadas dos palabras en idioma élfico. El escriba podría traducirlas si le preguntaras, pero no va a mirar.' },
    'candelabros':     { rooms: [17], text: 'Los dos candelabros de bronce que flanquean el estrado tienen el verde característico del verdín de bronce viejo —no suciedad, sino la oxidación natural de siglos. El metal debajo es anaranjado y brillante donde alguien lo limpió en algún punto, pero solo hasta la altura de los brazos extendidos.\n\nLas velas son blancas y nuevas. No encajan con el resto: el candelabro más antiguo que el dungeon, la vela reemplazada esta semana. Alguien viene regularmente a cambiarlas. Quien sea que mantiene esto encendido lo hace por razones que no tienen que ver con la iluminación.' },
    'escriba':         { rooms: [17], text: 'El escriba élfico sentado en el rincón izquierdo nunca mira hacia arriba. No desde que entraste. No mientras te movés por la sala. No mientras hablás.\n\nSu pluma se mueve sin pausa: números en columnas, nombres en listas, fechas en márgenes. Cada transacción del día registrada en pergamino. El tintero en su mesa es el más grande que viste fuera de una biblioteca.\n\nNo tiene nombre visible. No hay placa, ni insignia, ni marca de gremio. Solo el trabajo. Si le hablás, asiente sin dejar de escribir. Si le preguntás algo, responde en dos palabras sin levantar la vista. Lleva aquí más tiempo del que nadie recuerda, y nadie recuerda quién lo contrató.' },
    // DIS-500: tablero de historial de subastas (da vida a la sala cuando no hay subastas activas)
    'tablero':         { rooms: [17], text: '__AUCTION_HISTORY__' },
  };

  // Normalizar query para buscar en lore objects
  const qNorm = normalize(query.trim());

  // DIS-D356: Páginas congeladas con propósito mecánico — si la quest de Aldric está activa
  // y el jugador lee las páginas del diario en sala 11, mostrar hint de conexión con Kaelthas
  // y registrar que el jugador leyó el diario para desbloquear diálogo en el Guardián Anciano.
  const PAGINAS_KEYS = ['paginas', 'páginas', 'diario', 'diario helado', 'paginas congeladas', 'páginas congeladas'];
  const isPageQuery = PAGINAS_KEYS.some(k => normalize(k).includes(qNorm) || qNorm.includes(normalize(k)));
  // BUG-461: el trigger funciona en sala 11 (páginas en el suelo) O si el jugador tiene las páginas en el inventario
  const hasPaginasInv = (player.inventory || []).some(i => i.toLowerCase().includes('páginas congeladas') || i.toLowerCase().includes('paginas congeladas'));
  if (isPageQuery && (player.current_room_id === 11 || hasPaginasInv)) {
    const questState = player.aldric_quest || 'none';
    // Marcar que leyó el diario de la Galería (para desbloquear diálogo del Guardián Anciano)
    const seFresh = parseSE(player.status_effects);
    let diarioExtra = '';
    if (!seFresh.leyo_diario_galeria) {
      // DIS-456: contar como mención de Kaelthas
      const kaeCountDiario = (seFresh.kaelthas_menciones || 0) + 1;
      const newSeDiario = { ...seFresh, leyo_diario_galeria: true, kaelthas_menciones: kaeCountDiario, 'kaelthas_menc_paginas_11': true };
      // Entrada genérica solo si es la 2ª mención
      if (kaeCountDiario === 2 && !seFresh.kaelthas_nota_diario) {
        newSeDiario.kaelthas_nota_diario = true;
        db.addJournalEntry(player.id, 'lore', '🔍 Ese nombre — Kaelthas — aparece en varios lugares del dungeon. No es coincidencia. Alguien quiere que se recuerde, o que se olvide.');
      }
      // DIS-476: entrada específica de las páginas — siempre al leerlas por primera vez
      if (!seFresh.kaelthas_nota_paginas) {
        newSeDiario.kaelthas_nota_paginas = true;
        db.addJournalEntry(player.id, 'lore', '📖 Las páginas hablan de alguien que sabía demasiado. "Kaelthas no murió. Eligió esto." Las fechas del diario coinciden con cuando Valdrath desapareció de los mapas oficiales.');
        diarioExtra = '\n\n📖 *Nuevo apunte en tu diario: las páginas revelan algo sobre Kaelthas y Valdrath.*';
      }
      db.updatePlayer(player.id, { status_effects: JSON.stringify(newSeDiario) });
    }
    let baseText = 'Las páginas del diario están medio fusionadas por el hielo, pero alcanzás a leer tres fragmentos:\n\n  "...llegamos cuatro. Somos dos. El frío no mata — algo lo usa."\n\n  "...vi su sombra en la Catedral. Desde aquí. Eso no es posible."\n\n  "...Kaelthas no murió. Eligió esto. Lo entendí cuando me miró. Me conocía."';
    if (questState === 'active') {
      baseText += '\n\n📜 ¡Kaelthas! El mismo nombre de la quest de Aldric. El diario confirma que Kaelthas no murió, sino que "eligió" el dungeon. Aldric quería esa carta por algo más que nostalgia — esto es evidencia del pasado del reino. Llevá la carta sellada de sala 8 a Aldric en sala 4.';
    } else if (questState === 'none') {
      baseText += '\n\n🔍 El nombre Kaelthas aparece grabado también en las runas del Santuario y en el trono de la sala 9. Hay alguien en el dungeon que sabe más — quizás el anciano de la entrada puede orientarte.';
    }
    return { text: baseText + diarioExtra };
  }

  // DIS-D360: "mecanismo", "umbral", "oeste", "norte", "sur", "este" → si hay trampa en sala adyacente, describir
  const DIR_NAMES_ES = { north: 'norte', south: 'sur', east: 'este', west: 'oeste', up: 'arriba', down: 'abajo' };
  const DIR_FROM_ES = { norte: 'north', sur: 'south', este: 'east', oeste: 'west', arriba: 'up', abajo: 'down' };
  const mecWords = ['mecanismo', 'umbral', 'trampa'];
  const dirWords = Object.keys(DIR_FROM_ES);
  const isMecQuery = mecWords.some(w => qLow.includes(w));
  const isDirQuery = dirWords.includes(qLow);
  if (isMecQuery || isDirQuery) {
    const room = db.getRoom(player.current_room_id);
    const exits = room ? (room.exits || {}) : {};
    const trappedDirs = [];
    for (const [dir, exitVal] of Object.entries(exits)) {
      const adjId = typeof exitVal === 'object' && exitVal !== null ? exitVal.room_id : exitVal;
      if (!adjId) continue;
      const adjRoom = db.getRoom(adjId);
      if (adjRoom && adjRoom.trap && adjRoom.trap.active) {
        trappedDirs.push({ dir, dirEs: DIR_NAMES_ES[dir] || dir, adjRoom });
      }
    }
    if (trappedDirs.length > 0) {
      // Si la query es una dirección específica, filtrar por esa dirección
      if (isDirQuery) {
        const engDir = DIR_FROM_ES[qLow];
        const match = trappedDirs.find(t => t.dir === engDir);
        if (match) {
          const trap = match.adjRoom.trap;
          return { text: `🔍 Examinás el umbral ${qLow}.\nHay marcas de mecanismo en el borde del umbral: ranuras para un gatillo de presión, cuerdas tensadas a la altura de las rodillas, y un pequeño pivote de metal que parece lista para activarse.\nLa trampa está cargada.\n\n💡 Podés desactivarla ANTES DE ENTRAR: escribí "desactivar trampa ${qLow}" con el ítem correcto en el inventario.` };
        }
      }
      // Mecanismo genérico → mostrar todas las direcciones con trampa
      const desc = trappedDirs.map(t => `  • Hacia el ${t.dirEs} (${t.adjRoom.name}): mecanismo de trampa visible en el umbral → "desactivar trampa ${t.dirEs}"`).join('\n');
      return { text: `🔍 Examinás los mecanismos sospechosos que viste mencionados.\n${desc}\n\nSon trampas de presión. Podés desactivarlas con el ítem correcto ANTES DE ENTRAR.\n💡 "desactivar trampa <dirección>" funciona desde esta sala.` };
    } else if (isMecQuery) {
      return { text: 'Mirás con atención el umbral mencionado, pero la trampa ya no está activa — o quizás te equivocaste de sala.' };
    }
  }

  // DIS-456: set de lore objects que mencionan a Kaelthas (sala 2 inscripciones, sala 9 trono, sala 10 runas)
  const KAELTHAS_LORE_KEYS = new Set(['pared', 'inscripciones', 'trono', 'runas', 'runa']);

  for (const [key, val] of Object.entries(loreObjects)) {
    if (normalize(key).includes(qNorm) || qNorm.includes(normalize(key))) {
      if (!val.rooms || val.rooms.includes(player.current_room_id)) {
        // DIS-456: rastrear menciones de Kaelthas vistas por el jugador
        if (KAELTHAS_LORE_KEYS.has(key)) {
          const seKae = parseSE(player.status_effects);
          const kaeKey = `kaelthas_menc_${key}_${player.current_room_id}`;
          if (!seKae[kaeKey]) {
            // Primera vez que ve ESTA mención
            seKae[kaeKey] = true;
            const kaeCount = (seKae.kaelthas_menciones || 0) + 1;
            seKae.kaelthas_menciones = kaeCount;
            db.updatePlayer(player.id, { status_effects: JSON.stringify(seKae) });
            if (kaeCount === 2 && !seKae.kaelthas_nota_diario) {
              // Segunda mención → agregar nota al diario
              seKae.kaelthas_nota_diario = true;
              db.updatePlayer(player.id, { status_effects: JSON.stringify(seKae) });
              db.addJournalEntry(player.id, 'lore', '🔍 Ese nombre — Kaelthas — aparece en varios lugares del dungeon. No es coincidencia. Alguien quiere que se recuerde, o que se olvide.');
              return { text: val.text + '\n\n📖 *Nuevo apunte en tu diario: el nombre Kaelthas aparece en varios lugares del dungeon.*' };
            }
          }
        }
        // DIS-500: resolver placeholder dinámico del tablero de historial de subastas
        if (val.text === '__AUCTION_HISTORY__') {
          const recent = db.getRecentClosedAuctions(5);
          if (!recent || recent.length === 0) {
            return { text: '📋 **Tablero de historial de subastas**\n\nEl tablero está vacío. Todavía no se ha rematado ningún ítem.\n\n  *(El primero en subastar algo pasará a la historia.)*\n\nPara crear una subasta: subasta <ítem> <precio_mínimo>' };
          }
          const rows = recent.map((a, i) => {
            const soldFor = a.current_bid > 0 ? a.current_bid + 'g' : 'sin pujas';
            const soldTo = a.bidder_name ? '→ ' + a.bidder_name : '(sin comprador)';
            return '  ' + (i + 1) + '. ' + a.item_name + ' — ' + soldFor + ' ' + soldTo + '  [vendedor: ' + a.seller_name + ']';
          });
          return { text: '📋 **Tablero de historial de subastas**\n\nÚltimos remates cerrados:\n\n' + rows.join('\n') + '\n\n  *(El escriba actualiza el tablero después de cada remate.)*\n\nPara ver subastas activas: subastas   |   Para crear una: subastar <ítem> <precio>' };
        }
        // BUG-555: carta sellada — si el jugador ya la abrió (no está en inventario), mostrar descripción post-apertura
        if ((key === 'carta' || key === 'carta sellada') && player.current_room_id === 8) {
          const hasCartaInInv = (player.inventory || []).some(i => i.toLowerCase().includes('carta sellada') || i.toLowerCase() === 'carta');
          if (!hasCartaInInv) {
            // La carta ya fue abierta (consumida del inventario)
            return { text: 'Buscás el sobre con cera negra, pero ya no está. Lo abriste: los restos del sobre rasgado quedaron en el suelo, la cera negra partida en dos. El papel que contenía ya lo leíste.\n\nLo que decía no se puede desaprender.' };
          }
        }
        return { text: val.text };
      }
      // Si el key matchea pero la sala no aplica, seguir buscando
      // (puede haber otro key más específico para esta sala)
    }
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

  const normalize = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const query_clean = normalize(query.trim());

  // Buscar en el catálogo completo
  const CATALOG = items.ITEM_CATALOG;
  // Coincidencia exacta primero, luego parcial (normalizando claves también)
  let itemKey = Object.keys(CATALOG).find(k => normalize(k) === query_clean);
  if (!itemKey) {
    itemKey = Object.keys(CATALOG).find(k => normalize(k).includes(query_clean) || query_clean.includes(normalize(k)));
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

  // Fix DIS-008: mostrar pistas de crafteo si el ítem es ingrediente de alguna receta
  const { RECIPES } = require('./crafting');
  const craftHints = RECIPES
    .filter(r => r.ingredients.some(ing => ing.toLowerCase() === itemKey.toLowerCase()))
    .map(r => {
      const otherIng = r.ingredients.find(ing => ing.toLowerCase() !== itemKey.toLowerCase());
      return `  + ${otherIng} → ${r.result}`;
    });
  if (craftHints.length > 0) {
    lines.push('─'.repeat(40));
    lines.push('🧪 Recetas de crafteo:');
    craftHints.forEach(h => lines.push(h));
  }

  // DIS-P10: mostrar de dónde se puede obtener el ítem (loot de monstruos, tienda, forage)
  // DIS-D23: fuentes de ítems de desactivación de trampas
  const TRAP_ITEM_SOURCES = {
    'hongo azul':  '🍄 Se encuentra en el suelo del Túnel de los Hongos (sala 6) — forage con alta prob.',
    'corona rota': '👑 Se encuentra en el suelo de la Sala del Trono (sala 9), también como forage en esa sala.',
    'cuerda':      '🛒 Disponible en la tienda del Mercader Aldric (Sala 4). También aparece como forage.',
    'red de pesca':'🐟 Se puede encontrar con forage en la Caverna Sumergida (sala 13).',
  };
  try {
    const allMonsters = db.getAllMonsters();
    const droppers = allMonsters.filter(m => {
      const loot = Array.isArray(m.loot) ? m.loot : (m.loot ? JSON.parse(m.loot) : []);
      return loot.some(l => l.toLowerCase() === itemKey.toLowerCase());
    });
    // También revisar resultado de recetas
    const craftResult = RECIPES.find(r => r.result.toLowerCase() === itemKey.toLowerCase());
    // Tienda: catálogo del mercader Aldric
    const SHOP_CATALOG = [
      'poción de salud', 'poción mayor', 'antídoto', 'cuchillo oxidado', 'espada oxidada',
      'hierba curativa', 'poción de maná', 'cuero endurecido', 'cota de malla', 'veste de sombra',
      'espada de hierro', 'daga envenenada', 'escudo de madera', 'antorcha', 'cuerda', 'llave oxidada',
      'túnica encantada', 'poción de maná mayor', 'cristal helado',
    ];
    const inShop = SHOP_CATALOG.some(s => s === itemKey);

    const sources = [];
    // DIS-D23: si el ítem es de desactivación de trampa, mostrar fuente específica
    const trapSource = TRAP_ITEM_SOURCES[itemKey];
    if (trapSource) {
      sources.push(`  ⚠️ Ítem desactivador de trampa: ${trapSource}`);
    }
    if (droppers.length > 0) {
      const roomsById = {};
      const rooms = db.getAllRooms ? db.getAllRooms() : [];
      rooms.forEach(r => { roomsById[r.id] = r.name; });
      const dropperNames = droppers.map(m => {
        const roomName = m.respawn_room_id ? (roomsById[m.respawn_room_id] || `Sala ${m.respawn_room_id}`) : '?';
        return `${m.name} (${roomName})`;
      }).slice(0, 4);
      sources.push(`  ⚔ Loot de: ${dropperNames.join(', ')}`);
    }
    if (craftResult) {
      sources.push(`  ⚗️ Crafteable: ${craftResult.ingredients.join(' + ')}`);
    }
    if (inShop) {
      sources.push(`  🛒 Disponible en la tienda del Mercader Aldric (Sala 4)`);
    }
    if (sources.length > 0) {
      lines.push('─'.repeat(40));
      lines.push('📍 Cómo obtenerlo:');
      sources.forEach(s => lines.push(s));
    }
  } catch (_) {}

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
    // BUG-266: si el ítem es una armadura, redirigir automáticamente a cmdWear
    if (def && def.type === 'armor') {
      return cmdWear(player, itemQuery);
    }
    // DIS-D380: si el jugador intenta equipar un "escudo roto" (misc), explicar que no es equipable así
    // pero verificar si hay un escudo tipo armor en el inventario para sugerir ese
    const queryNormalized = itemQuery.trim().toLowerCase();
    if (queryNormalized.includes('escudo') || queryNormalized.includes('shield')) {
      const shieldArmor = player.inventory.find(i => {
        const d = items.getItemDef(i);
        return d && d.type === 'armor' && i.toLowerCase().includes('escudo');
      });
      if (shieldArmor) {
        return cmdWear(player, shieldArmor);
      }
      // Tienen solo escudo roto u otro escudo misc
      return { text: `"${found}" no se puede equipar directamente.\n💡 Los escudos van en el slot de armadura con el comando \`wear\` o \`ponerse\`.\n   Si tenés un escudo crafteado (ej: escudo de madera), usá: wear escudo de madera` };
    }
    return { text: `${found} no es un arma que puedas equipar.${def && def.type === 'armor' ? ' Usá "wear" para ponerte armaduras.' : ''}` };
  }

  const oldAttack = player.attack;
  // Calcular ataque base real (sin el bonus del arma previa si había una)
  const prevWeaponDef = player.equipped_weapon ? items.getItemDef(player.equipped_weapon) : null;
  const prevWeaponBonusEquip = prevWeaponDef ? (prevWeaponDef.amount || 0) : 0;
  // DIS-558: Si el arma anterior tenía mage_only_bonus y el jugador es Mago, restar también ese bonus
  const clsCheckPrev = classes.getPlayerClass(player);
  const isMagoPrev = clsCheckPrev && clsCheckPrev.name === 'Mago';
  const prevMageBonus = (isMagoPrev && prevWeaponDef && prevWeaponDef.mage_only_bonus) ? prevWeaponDef.mage_only_bonus : 0;
  const baseAttackEquip = player.attack - prevWeaponBonusEquip - prevMageBonus;
  // DIS-558: aplicar mage_only_bonus si el jugador es Mago y el arma nueva lo tiene
  const mageOnlyBonus = (isMagoPrev && def.mage_only_bonus) ? def.mage_only_bonus : 0;
  const newAttack = baseAttackEquip + def.amount + mageOnlyBonus;

  // BUG-269: remover el arma nueva del inventario, devolver la anterior si había una
  const invEquip = [...player.inventory];
  const foundIdxEquip = invEquip.indexOf(found);
  if (foundIdxEquip !== -1) invEquip.splice(foundIdxEquip, 1);
  if (player.equipped_weapon) invEquip.push(player.equipped_weapon); // devolver arma anterior

  db.updatePlayer(player.id, { attack: newAttack, equipped_weapon: found, inventory: invEquip });

  const change = newAttack - oldAttack;
  const changeStr = change >= 0 ? `+${change}` : `${change}`;
  const swapMsg = player.equipped_weapon ? ` (reemplaza ${player.equipped_weapon} → vuelve a tu mochila)` : '';

  // DIS-478: flavor narrativo cuando un mago equipa arma de guerrero (sin penalidad — libertad de builds)
  // DIS-494: armas mágicas (espectral, del eco, arcana) tienen su propio flavor para el Mago
  // DIS-558: vara de energía y catalizador mágico también tienen flavor específico
  // DIS-561: extender mensajes de clase a más ítems mágicos; mensajes negativos para Guerrero en ítems de Mago
  const clsDataEquip = classes.getPlayerClass(player);
  const heavyWeapons = ['martillo', 'hacha', 'alabarda', 'mandoble', 'ballesta'];
  const magicWeaponKeywords = ['espectral', 'del eco', 'arcano', 'arcana', 'mística', 'místico', 'rúnico', 'rúnica', 'encantado', 'encantada', 'de luz', 'de sombra', 'vara de energía', 'catalizador'];
  const isMagoEquip = clsDataEquip && clsDataEquip.name === 'Mago';
  const isGuerreroEquip = clsDataEquip && clsDataEquip.name === 'Guerrero';
  const foundLower = found.toLowerCase();
  const isHeavyWeapon = heavyWeapons.some(w => foundLower.includes(w));
  const isMagicWeapon = magicWeaponKeywords.some(w => foundLower.includes(w));
  let magoHeavyFlavor = '';
  if (isMagoEquip) {
    if (foundLower.includes('vara de energía')) {
      magoHeavyFlavor = `\n✨ (Las runas de la vara resuenan con tu maná. +${def.mage_only_bonus || 0} de ataque adicional por ser Mago.)`;
    } else if (foundLower.includes('catalizador')) {
      magoHeavyFlavor = `\n✨ (El catalizador amplifica tu conexión arcana. +${def.mage_only_bonus || 0} de ataque adicional por ser Mago.)`;
    } else if (foundLower.includes('lanza espectral del eco')) {
      magoHeavyFlavor = `\n✨ (Los ecos de los caídos susurran en sintonía con tu maná. Esta arma fue hecha para alguien como vos.)`;
    } else if (foundLower.includes('grimorio del abismo')) {
      magoHeavyFlavor = `\n✨ (El grimorio te reconoce. Las páginas se abren solas ante tu presencia. Esto es lo que debería ser la magia.)`;
    } else if (foundLower.includes('cristal mágico')) {
      magoHeavyFlavor = `\n✨ (El cristal vibra en sintonía con tu campo arcano. Podés sentir el maná fluyendo hacia él.)`;
    } else if (isMagicWeapon) {
      magoHeavyFlavor = `\n✨ (Tu maná resuena con el arma. Esto sí es lo que estudiaste.)`;
    } else if (isHeavyWeapon) {
      magoHeavyFlavor = `\n💬 (Empuñás esto con ambas manos. No es lo que un mago estudia, pero nadie dijo que no podés.)`;
    }
  } else if (isGuerreroEquip && isMagicWeapon) {
    // DIS-561: mensajes negativos para Guerrero intentando equipar ítems mágicos
    if (foundLower.includes('grimorio')) {
      magoHeavyFlavor = `\n💬 (Abrís el grimorio. Las páginas están cubiertas de símbolos que no reconocés. Lo empuñás de todas formas — pesa bien, eso sí.)`;
    } else if (foundLower.includes('espectral') || foundLower.includes('del eco')) {
      magoHeavyFlavor = `\n💬 (El arma se siente extraña en tu mano — demasiado liviana, demasiado fría. Los guerreros prefieren metal que suene al golpear.)`;
    } else if (foundLower.includes('catalizador') || foundLower.includes('vara')) {
      magoHeavyFlavor = `\n💬 (Esto claramente fue hecho para alguien que lee libros. Pero si pega, pega.)`;
    }
  }

  // DIS-520: mostrar tanto el bono absoluto del arma como el delta neto para evitar confusión
  const mageOnlyBonusStr = (isMagoPrev && mageOnlyBonus > 0) ? ` +${mageOnlyBonus} Mago` : '';
  const baseStr = player.equipped_weapon
    ? ` (bono base del arma: +${def.amount} ATK${mageOnlyBonusStr}; ${changeStr} neto vs ${player.equipped_weapon})`
    : ` (bono del arma: +${def.amount} ATK${mageOnlyBonusStr})`;

  return {
    text: `Empuñás ${found}${swapMsg}. Ataque: ${oldAttack} → ${newAttack}${baseStr}.\n${def.description}${magoHeavyFlavor}`,
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
    active.length > 1 ? `💡 Si están en la misma sala, podés desafiar a alguien con "duel <nombre>". ¡El ganador se lleva el 10% del oro del perdedor!` : ``,
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
  // DIS-522: filtrar bots de playtest del ranking visible (patrones de username)
  const BOT_PATTERNS = [/^BotTester/i, /^playtest_bot/i, /^PTBot/i, /^DisTester/i, /^PTBotD/i, /^DisDesign/i, /^PlayBot/i, /^bot_/i, /^BotPlaytest/i];
  const isBot = name => BOT_PATTERNS.some(p => p.test(name));

  const mode2 = mode === 'bots' || mode === 'todo';
  const leaders = db.getLeaderboard(mode2 ? 10 : 20).filter(p => mode2 || !isBot(p.username || '')).slice(0, 10);

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
  lines.push(`  (Bots de playtest ocultos. "score todo" para ver todos.)`);

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

  // DIS-016: Convertir monedas automáticamente al saquear (no agregar al inventario)
  const GOLD_ITEMS_LOOT = {
    'monedas de oro': 10,
    'monedas': 5,
    'oro': 15,
    'bolsa de monedas': 25,
    'cofre de oro': 50,
    'monedas de cobre': 1,
    'monedas de plata': 5,
  };

  let goldCollected = 0;
  const nonGoldItems = [];
  const openedContainers = []; // DIS-D361: rastrear cofres abiertos para mensaje narrativo
  for (const item of floorItems) {
    const gKey = Object.keys(GOLD_ITEMS_LOOT).find(k =>
      item.toLowerCase().includes(k) || k.includes(item.toLowerCase())
    );
    if (gKey) {
      const amount = GOLD_ITEMS_LOOT[gKey];
      goldCollected += amount;
      // DIS-D361: si es un cofre (no simples monedas), guardarlo para mostrar mensaje narrativo
      if (item.toLowerCase().includes('cofre')) {
        openedContainers.push({ name: item, gold: amount });
      }
    } else {
      nonGoldItems.push(item);
    }
  }

  // Agregar solo ítems no-oro al inventario (BUG-469: respetar límite de 20)
  // BUG-504: contar también ítems equipados (no están en player.inventory pero ocupan slot)
  const MAX_INVENTORY = 25 + (player.inventory_bonus || 0);  // DIS-507: ampliado de 20→25; DIS-595: +inventory_bonus por bolsas de lona
  const equippedCountLoot = (player.equipped_weapon ? 1 : 0) + (player.equipped_armor ? 1 : 0);
  const spaceAvailable = MAX_INVENTORY - player.inventory.length - equippedCountLoot;
  const itemsToPickup = nonGoldItems.slice(0, spaceAvailable);
  const itemsLeft = nonGoldItems.slice(spaceAvailable);

  const newInventory = [...player.inventory, ...itemsToPickup];
  db.updatePlayer(player.id, { inventory: newInventory });
  if (goldCollected > 0) {
    const freshP = db.getPlayer(player.id);
    db.updatePlayer(player.id, { gold: (freshP.gold || 0) + goldCollected });
  }
  // Dejar en el suelo los ítems que no entraron (las monedas ya se procesaron aparte)
  db.updateRoomItems(room.id, itemsLeft);

  const lista = itemsToPickup.map(i => {
    const emoji = items.getRarityEmoji(i);
    const rarity = items.getItemRarity(i);
    const rarityTag = rarity !== 'común' ? ` [${rarity}]` : '';
    return `  ${emoji} ${i}${rarityTag}`;
  }).join('\n');

  const totalItems = itemsToPickup.length + (goldCollected > 0 ? 1 : 0);
  // DIS-D361: mostrar línea descriptiva para cofres abiertos, genérica para monedas simples
  let goldLine = '';
  if (goldCollected > 0) {
    const containerLines = openedContainers.map(c =>
      `  📦 Abrís el ${c.name} y encontrás ${c.gold} monedas de oro`
    ).join('\n');
    const plainGold = goldCollected - openedContainers.reduce((s, c) => s + c.gold, 0);
    const coinLine = plainGold > 0 ? `\n  💰 +${plainGold} monedas de oro` : '';
    const containerSection = containerLines ? `\n${containerLines}` : '';
    goldLine = containerSection + coinLine;
    if (!coinLine && containerLines) {
      goldLine += `\n  💰 Total: +${goldCollected} monedas de oro`;
    }
  }

  // DIS-D280: hint de crafteo — si el nuevo inventario completa una receta, sugerir crafting (1 vez por receta)
  const { RECIPES } = crafting;
  const invNormalized = newInventory.map(i => i.toLowerCase().trim());
  const freshPlayer = db.getPlayer(player.id);
  const shownHints = freshPlayer.status_effects || {};
  let craftHintLine = '';
  for (const recipe of RECIPES) {
    const [ingA, ingB] = recipe.ingredients;
    const hasA = invNormalized.includes(ingA.toLowerCase().trim());
    const hasB = invNormalized.includes(ingB.toLowerCase().trim());
    if (hasA && hasB) {
      const hintKey = `craft_hint_${recipe.result.toLowerCase().replace(/\s+/g, '_')}`;
      if (!shownHints[hintKey]) {
        craftHintLine = `\n\n💡 ¡Tip de crafteo! Tenés "${ingA}" y "${ingB}" — podés combinarlos:\n   → escribí: craftear ${ingA} con ${ingB}`;
        // Marcar hint como mostrado
        db.updatePlayer(freshPlayer.id, { status_effects: JSON.stringify({ ...shownHints, [hintKey]: true }) });
        break; // solo un hint por loot
      }
    }
  }

  // BUG-469: advertencia si la mochila estaba llena y quedaron ítems en el suelo
  // BUG-551: mostrar cuáles ítems quedaron en el suelo
  const itemsLeftList = itemsLeft.length > 0
    ? `\n  ${itemsLeft.map(i => `❌ ${i}`).join('\n  ')}`
    : '';
  const fullBagLine = itemsLeft.length > 0
    ? `\n\n🎒 Mochila llena — ${itemsLeft.length} ítem${itemsLeft.length !== 1 ? 's' : ''} quedaron en el suelo:${itemsLeftList}`
    : '';

  // BUG-532: si no se recogió nada (mochila llena, sin oro), mostrar mensaje directo sin "0 ítems"
  if (totalItems === 0 && itemsLeft.length > 0) {
    const usedSlots = player.inventory.length + equippedCountLoot;
    return {
      text: `🎒 Mochila llena (${usedSlots}/${MAX_INVENTORY}) — no pudiste recoger nada.\nQuedaron en el suelo:\n  ${itemsLeft.map(i => `❌ ${i}`).join('\n  ')}`,
      event: null,
      eventRoomId: room.id,
    };
  }

  return {
    text: `Recogés todo del suelo (${totalItems} ítem${totalItems !== 1 ? 's' : ''}):\n${lista}${goldLine}${craftHintLine}${fullBagLine}`,
    event: `${player.username} saquea el suelo de la sala.`,
    eventRoomId: room.id,
  };
}

/**
 * unequip — Guardar el arma equipada y volver a pelear con los puños.
 * BUG-277: Si se pasa un argumento que coincide con la armadura equipada, redirigir a cmdUnwear.
 */
function cmdUnequip(player, itemQuery) {
  player = db.getPlayer(player.id);

  // BUG-277: si el argumento coincide con la armadura equipada, redirigir a cmdUnwear
  if (itemQuery && itemQuery.trim() && player.equipped_armor) {
    const armorNameLower = player.equipped_armor.toLowerCase();
    const queryLower = itemQuery.trim().toLowerCase();
    // coincidencia parcial: si el query está contenido en el nombre de la armadura o viceversa
    if (armorNameLower.includes(queryLower) || queryLower.includes(armorNameLower)) {
      return cmdUnwear(player);
    }
  }

  if (!player.equipped_weapon) {
    return { text: 'No tenés ningún arma equipada.' };
  }

  const weaponName = player.equipped_weapon;
  const weaponDef = items.getItemDef(weaponName);
  const weaponBonus = weaponDef?.amount || 0;
  const baseAttack = player.attack - weaponBonus;

  // BUG-269: devolver el arma al inventario al desequipar
  const invUnequip = [...player.inventory];
  invUnequip.push(weaponName);
  db.updatePlayer(player.id, { attack: baseAttack, equipped_weapon: null, inventory: invUnequip });

  return {
    text: `Enfundás ${weaponName} y lo guardás en tu mochila. Volvés a pelear con los puños (ataque: ${baseAttack}).`,
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
  const oldArmor = player.equipped_armor;

  // DIS-D18: verificar si ya está puesta esa misma armadura
  if (oldArmor && oldArmor === found) {
    return { text: `Ya tenés ${found} puest${found.endsWith('a') ? 'a' : 'o'}. No hay nada que cambiar.` };
  }

  // Calcular defensa desnuda (sin ninguna armadura), para preservar bonuses de clase y level-ups
  const oldArmorAmount = oldArmor ? (items.getItemDef(oldArmor)?.amount || 0) : 0;
  const nakedDefense = oldDefense - oldArmorAmount;
  const newDefense = nakedDefense + def.amount; // defensa desnuda + bonus nueva armadura

  // BUG-269: remover el ítem nuevo del inventario, y devolver el anterior si había uno
  const inv = [...player.inventory];
  const foundIdx = inv.indexOf(found);
  if (foundIdx !== -1) inv.splice(foundIdx, 1);
  if (oldArmor) inv.push(oldArmor); // devolver la armadura anterior al inventario

  db.updatePlayer(player.id, { defense: newDefense, equipped_armor: found, inventory: inv });

  const change = newDefense - oldDefense;
  const changeStr = change >= 0 ? `+${change}` : `${change}`;
  const swapMsg = oldArmor ? ` (reemplaza ${oldArmor} → vuelve a tu mochila)` : '';

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
  const armorDef = items.getItemDef(armorName);
  const armorAmount = armorDef ? (armorDef.amount || 0) : 0;
  const nakedDefense = (player.defense || 2) - armorAmount;

  // BUG-269: devolver la armadura al inventario al quitarse
  const invUnwear = [...player.inventory];
  invUnwear.push(armorName);
  db.updatePlayer(player.id, { defense: nakedDefense, equipped_armor: null, inventory: invUnwear });

  return {
    text: `Te quitás ${armorName} y lo guardás en tu mochila. Defensa vuelve a ${nakedDefense}.`,
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
    // BUG-347 / DIS-513: Si el nombre coincide con un NPC conocido, sugerir "hablar <npc>"
    const npcNames = ['aldric', 'mercader', 'tendero', 'guardián', 'guardian', 'anciano'];
    const targetLower = targetName.toLowerCase();
    const isNPC = npcNames.some(n => targetLower.includes(n));
    if (isNPC) {
      // DIS-513: si el ítem es relevante para una quest activa, activar la quest completion automáticamente
      if (targetLower.includes('aldric') || targetLower.includes('mercader')) {
        const freshP = db.getPlayer(player.id);
        const inv = Array.isArray(freshP.inventory) ? freshP.inventory : JSON.parse(freshP.inventory || '[]');
        const hasCarta = inv.some(i => i.toLowerCase().includes('carta sellada'));
        if (hasCarta && found.toLowerCase().includes('carta sellada') && freshP.aldric_quest === 'active') {
          // Completar la quest directamente como si el jugador hubiera dicho "hablar aldric"
          db.updatePlayer(player.id, {
            xp: (freshP.xp || 0) + 50,
            gold: (freshP.gold || 0) + 25,
            aldric_quest: 'done',
            inventory: JSON.stringify(inv.filter(i => !i.toLowerCase().includes('carta sellada')))
          });
          db.addJournalEntry(player.id, 'quest', '📜 Aldric me reveló el nombre completo: Kaelthas Vorn. Guardián del reino. El dungeon fue su archivo. Su alma quedó atada aquí cuando lo mataron. Sigue en las piedras. En los corredores. En la Sala del Trono.');
          db.logGlobalEvent('quest', `📜 ${player.username} descubrió el secreto de Aldric el Mercader.`);
          return { text: 'Extendés la carta hacia Aldric. Él la toma despacio, con manos que no tiemblan, pero que deberían.\n\nEl sello de las dos llaves cruzadas. Lo mira durante un momento demasiado largo.\n\n\"Fue el guardián del sello del reino,\" dice al fin, en voz tan baja que casi no lo escuchás. \"No el rey. El guardián. Los que guardaban las llaves eran los que realmente mantenían el reino unido.\"\n\nPausa. \"Kaelthas Vorn. Ese era su nombre completo. El que todos olvidaron —o fingieron olvidar— cuando el reino cayó.\"\n\nDobla la carta sin abrirla y la guarda debajo del mostrador.\n\n\"Tomá esto. Y si algún día pronunciás su nombre completo en el lugar correcto, vas a entender por qué todavía importa.\"\n\n🎉 Quest completada: El Sello de las Dos Llaves. (+50 XP · +25g)\n📜 El lore de Kaelthas Vorn está ahora completo.\n📖 Diario actualizado.' };
        }
        // DIS-513: mensajes de guía cuando el give no completa la quest
        if (freshP.aldric_quest === 'active' && !found.toLowerCase().includes('carta sellada')) {
          return { text: `Aldric te mira el ítem y niega con la cabeza. "Eso no es lo que busco." 💡 Tip: la quest de Aldric requiere la carta sellada del corredor de sombras (sala 3).` };
        }
        if (freshP.aldric_quest === 'done') {
          return { text: `Aldric ya recibió lo que necesitaba. No hay nada más que entregarle.` };
        }
        if (freshP.aldric_quest !== 'active') {
          return { text: `Aldric no parece interesado en ese ítem. Hablale primero para descubrir qué busca: "hablar aldric".` };
        }
      }
      return { text: `«${targetName}» es un NPC — no podés darle ítems directamente. Interactuá con comandos como "hablar ${targetName}".` };
    }
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
    const givenWeaponDef = items.getItemDef(found);
    const givenWeaponBonus = givenWeaponDef?.amount || 0;
    giverUpdates.attack = player.attack - givenWeaponBonus;
  }
  // T152: Si era la armadura equipada, desequipar
  if (player.equipped_armor && player.equipped_armor === found) {
    giverUpdates.equipped_armor = null;
    const armorDef = items.getItemDef(found);
    const armorAmt = armorDef ? (armorDef.amount || 0) : 0;
    giverUpdates.defense = (player.defense || 2) - armorAmt;
  }

  db.updatePlayer(player.id,  giverUpdates);
  db.updatePlayer(target.id,  { inventory: newTargetInv });

  let extraMsg = '';
  if (giverUpdates.equipped_weapon === null) extraMsg += ` (perdiste tu arma equipada, ataque vuelve a ${giverUpdates.attack})`;
  if (giverUpdates.equipped_armor === null)  extraMsg += ` (perdiste tu armadura, defensa vuelve a ${giverUpdates.defense})`;

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

  // T216: Si el destinatario está AFK, notificar al emisor
  let afkNote = '';
  if (isAfk(target.id)) {
    const afkMsg = getAfkMessage(target.id);
    afkNote = afkMsg
      ? `\n💤 [AFK] ${target.username}: "${afkMsg}"`
      : `\n💤 ${target.username} está en modo ausente (AFK).`;
  }

  // Registrar que player es el último que le escribió a target
  lastWhisperSender.set(target.id, { id: player.id, username: player.username });

  return {
    text: senderMsg + afkNote,
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
 * DIS-580: Las salas no visitadas aparecen como [??? ------] para añadir exploración.
 */
function cmdMap(player) {
  const here = player.current_room_id;

  // DIS-580: Salas visitadas (set para O(1) lookup)
  let visitedRooms;
  try {
    const rawVisited = db.getPlayer(player.id).rooms_visited;
    visitedRooms = new Set(Array.isArray(rawVisited) ? rawVisited : JSON.parse(rawVisited || '[]'));
  } catch (_) {
    visitedRooms = new Set();
  }
  // La sala actual siempre está "visitada" visualmente
  visitedRooms.add(here);

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

  // DIS-D357: Calcular salas con monstruos vivos — usar query SQL directa para evitar
  // edge cases de null-checking en JS con sql.js/WASM (room_id=0, 'null' string, etc.)
  const liveMonstersInRooms = db.getLivingMonstersWithRoom();
  const roomsWithMonsters = new Set(liveMonstersInRooms.map(m => m.room_id));

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
    16: 'Antesala',
    17: 'Subastas',
    18: 'Fuente',
    19: 'Cám.Eco',
    20: 'Abismo',
    21: 'Práctica',
    22: 'Cripta',
  };

  function _oldCell(id) {
    // Replaced by DIS-D05 rewrite below — keeping this as dead code guard
    const label = NAMES[id] || `Sala ${id}`;
    const marker = id === here ? '★' : ' ';
    const swordFlag = roomsWithMonsters.has(id) ? '⚔' : ' ';
    return `[${marker}${String(id).padStart(2,' ')} ${label.substring(0,9).padEnd(9,' ')}${swordFlag}]`;
  }
  void _oldCell; // suppress unused warning

  // DIS-D05: Mapa rediseñado con mejor alineación y leyenda numérica más clara
  // Cada celda es [NN:Nombre] de ancho fijo, sin emojis que rompan alineación
  function cell(id) {
    // DIS-580: salas no visitadas aparecen como neblina
    if (!visitedRooms.has(id)) {
      return `[ ??:?????????]`;
    }
    const label = (NAMES[id] || `Sala${id}`).substring(0, 9).padEnd(9, ' ');
    const marker = id === here ? '★' : ' ';
    const sword  = roomsWithMonsters.has(id) ? '⚔' : ' ';
    return `[${marker}${String(id).padStart(2, ' ')}:${label}${sword}]`;
  }

  const c = (id) => cell(id);
  const gap = '       '; // 7 spaces para espaciar columnas

  //
  // DIS-D422: Layout corregido — Corredor(2) NO está conectado a Forja(12).
  //
  // Conexiones reales:
  //   Corredor(2): sur→Entrada(1), norte→Ecos(3), oeste→Túnel(6)
  //   Forja(12):   sur→Galería(11), este→Coliseo(14)
  //   Ruta Corredor↔Forja: Corredor→oeste→Túnel→norte→Trono→este→Santuario→este→Galería→norte→Forja
  //
  // Layout rediseñado:
  //
  // [18:Fuente]
  //   |        [8:Prisión]
  //   |        |
  // [7:Pozo]─[3:Ecos]─[4:Tesoro]─[17:Sub]
  //   |🔑
  // [10:Santuario]─[9:Trono]─[6:Túnel]─[2:Corredor]
  //   |                         |           |
  // [11:Galería]          [5:Capilla]─[1:Entrada]
  //   |   \                              ↓(bajar)
  // [12:Forja] [13:Caverna]         [21:Práctica]─[16:Antesala]
  //          ↘  ↙
  //       [14:Coliseo]
  //            |
  //       [15:Catedral]─[22:Cripta]
  //            |
  //       [19:Cám.Eco]
  //            |
  //       [20:Abismo]
  //

  const lines = [
    'MAPA DEL DUNGEON',
    timeDecor,
    '',
    `${c(18)}`,
    `  |         ${c(8)}`,
    `  |         |`,
    `${c(7)}---${c(3)}---${c(4)}---${c(17)}`,
    // DIS-588: hint de llave solo si el jugador ya visitó sala 7 (Pozo) o sala 4 (Tesoro)
    visitedRooms.has(7) || visitedRooms.has(4)
      ? `  |🔑(bloqueado — ruta libre: Capilla→Túnel→Trono→Santuario)`
      : `  |🔑(bloqueado)`,
    `${c(10)}---${c(9)}---${c(6)}---${c(2)}`,
    `  |              |         |`,
    `${c(11)}    ${c(5)}---${c(1)}`,
    `  |   \\               ↓ (bajar)`,
    `${c(12)} ${c(13)}       ${c(21)}---${c(16)}`,
    `      \\  /`,
    `  ${c(14)}`,
    `      |`,
    `  ${c(15)}---${c(22)}`,
    `      |`,
    `  ${c(19)}`,
    `      |`,
    `  ${c(20)}`,
    ``,
    `★ = tu posición (sala ${here}: ${NAMES[here] || '?'})`,
    `⚔ = monstruo activo   🔑 = requiere llave oxidada (comprar en tienda sala 4, o buscar en Prisión sala 8)`,
    `[??:?????????] = sala aún no explorada`,
    // DIS-588: la ruta completa al Santuario solo aparece si ya se visitó sala 7 o sala 4
    ...(visitedRooms.has(7) || visitedRooms.has(4)
      ? [`💡 Ruta al Santuario sin llave: Entrada → este → Capilla → norte → Túnel → norte → Trono → este → Santuario`]
      : []),
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
 * Uso extendido (DIS-525): "disarm <dirección>" — desactiva la trampa en sala adyacente en esa dirección.
 * El ítem se consume del inventario. La trampa queda inactiva en la BD (para todos).
 */
function cmdDisarm(player, args) {
  player = db.getPlayer(player.id);

  // DIS-525: soporte para desactivar trampa de sala adyacente antes de entrar
  if (args && args.length > 0) {
    const dirArg = args[0];
    const room = db.getRoom(player.current_room_id);
    if (!room) return { text: 'Error: tu habitación actual no existe en la BD.' };

    const exit = dungeon.resolveExit(room, dirArg);
    const DIR_NAMES_ES2 = { north: 'norte', south: 'sur', east: 'este', west: 'oeste', up: 'arriba', down: 'abajo' };
    const normalized2 = dungeon.normalizeDirection(dirArg);
    const dirLabel2 = (normalized2 && DIR_NAMES_ES2[normalized2]) || dirArg;

    if (!exit) {
      return { text: `No hay salida hacia el ${dirLabel2}.` };
    }

    const adjRoom = db.getRoom(exit.targetId);
    if (!adjRoom) return { text: 'No podés acceder a esa sala.' };

    if (!adjRoom.trap || !adjRoom.trap.active) {
      return { text: `No hay trampa activa hacia el ${dirLabel2} (${adjRoom.name}).` };
    }

    const trapAdj = adjRoom.trap;

    if (!trapAdj.item_needed) {
      // Sin ítem requerido — desactivación manual a distancia
      const newTrap = { ...trapAdj, active: false };
      db.updateRoomTrap(adjRoom.id, newTrap);
      return {
        text: `🔧 Con cuidado, lográs desactivar el mecanismo desde el umbral sin entrar.\n✅ La trampa en ${adjRoom.name} quedó inerte.`,
        event: `${player.username} desactiva una trampa desde el umbral.`,
        eventRoomId: player.current_room_id,
      };
    }

    // Verificar ítem requerido en inventario
    const inventory = player.inventory || [];
    const keyIdx = inventory.findIndex(i => i.toLowerCase() === trapAdj.item_needed.toLowerCase());

    if (keyIdx === -1) {
      // BUG-552 / BUG-563: mensaje claro indicando qué sala y qué ítem; mencionar trampa propia si existe
      const currentRoomForHint = db.getRoom(player.current_room_id);
      let ownTrapHint = '';
      if (currentRoomForHint && currentRoomForHint.trap && currentRoomForHint.trap.active && currentRoomForHint.trap.item_needed) {
        const ownItem = currentRoomForHint.trap.item_needed;
        const playerHasOwnItem = (player.inventory || []).some(i => i.toLowerCase() === ownItem.toLowerCase());
        if (playerHasOwnItem) {
          // BUG-563: jugador tiene el ítem para SU sala actual — probablemente se confundió con la dirección
          ownTrapHint = `\n\n⚠️  ¿Querías desactivar la trampa de TU sala actual (${currentRoomForHint.name})?\n   Tenés "${ownItem}" en tu inventario — escribí "desactivar trampa" sin dirección para eso.`;
        } else {
          ownTrapHint = `\n💡 Nota: esta sala (${currentRoomForHint.name}) también tiene trampa — necesitás "${ownItem}" y escribí "desactivar trampa" (sin dirección) para desactivarla aquí.`;
        }
      }
      return {
        text: `Intentás desactivar la trampa de ${adjRoom.name} (al ${dirLabel2}) desde aquí, pero no tenés lo necesario.\n🔧 Ítem requerido para ${adjRoom.name}: "${trapAdj.item_needed}"${ownTrapHint}`,
      };
    }

    // Consumir ítem y desactivar trampa
    const newInventory = [...inventory.slice(0, keyIdx), ...inventory.slice(keyIdx + 1)];
    db.updatePlayer(player.id, { inventory: newInventory });

    const respawnAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const newTrap = { ...trapAdj, active: false, respawn_at: respawnAt };
    db.updateRoomTrap(adjRoom.id, newTrap);

    return {
      text: `🔧 Desde el umbral, usás la ${trapAdj.item_needed} para neutralizar el mecanismo antes de entrar.\n✅ La trampa en ${adjRoom.name} está desactivada. Podés pasar sin peligro.`,
      event: `${player.username} desactiva una trampa desde el umbral.`,
      eventRoomId: player.current_room_id,
    };
  }

  // Comportamiento original: desactivar trampa en sala actual
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
  const COOLDOWN_MS = 60000;
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

  // DIS-D48: Recuperar HP basado en % del max_hp (10-15%), mínimo 5
  // Antes era un fijo 3-5 HP que se volvía irrelevante a niveles altos.
  const baseHealPct = 0.10 + Math.random() * 0.05; // 10% a 15%
  const baseHeal = Math.max(5, Math.floor(player.max_hp * baseHealPct));
  // T166: Viento helado penaliza el descanso (-2 HP, mín 3)
  const weatherPenalty = weather.getRestPenalty();
  let heal = Math.max(3, baseHeal - weatherPenalty * 2);

  // T183: Verificar party rest
  let partyBonusText = '';
  const partyMembers = player.party_id ? db.getPartyMembers(player.party_id) : [];
  if (partyMembers && partyMembers.length > 0) {
    const PARTY_REST_WINDOW = 15000; // 15 segundos
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

  // DIS-449: Descansar también recupera maná para Mago (10% del max_mana, además del HP)
  let restManaText = '';
  {
    const freshForRestMana = db.getPlayer(player.id);
    const clsForRest = classes.getPlayerClass(freshForRestMana);
    if (clsForRest && clsForRest.name === 'Mago') {
      const curMana = freshForRestMana.mana != null ? freshForRestMana.mana : 0;
      const maxMana = freshForRestMana.max_mana || 20;
      if (curMana < maxMana) {
        const manaRestore = Math.max(1, Math.floor(maxMana * 0.15)); // DIS-493: subido de 0.10 a 0.15
        const newMana2 = Math.min(maxMana, curMana + manaRestore);
        const restoredMana = newMana2 - curMana;
        db.updatePlayer(player.id, { mana: newMana2 });
        restManaText = `\n✨ La calma restaura tu concentración: +${restoredMana} maná. (${newMana2}/${maxMana} 🔮)`;
      }
    }
  }

  return {
    text: `💤 Te recostás contra la pared y descansás un momento.\nRecuperás ${restored} HP.${coldSuffix}${partyBonusText} ${hpBar} ${newHp}/${player.max_hp} HP${forageRestText}${restManaText}`,
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
 * DIS-D355: cmdChase — Perseguir un monstruo que acaba de huir.
 * Lee el `last_flee` del active_scrolls (guardado por combat.js al huir un monstruo).
 * Si aún es válido (< 3 min), mueve al jugador a la sala donde huyó el monstruo.
 */
function cmdChase(player, context) {
  player = db.getPlayer(player.id);
  if (!player) return { text: 'Error al leer tu perfil.' };

  let scrolls;
  try { scrolls = JSON.parse(player.active_scrolls || '{}'); } catch (_) { scrolls = {}; }

  const fleeData = scrolls['last_flee'];
  if (!fleeData || !fleeData.expires_at || fleeData.expires_at < Date.now()) {
    return { text: '🏃 No hay ningún monstruo que haya huido recientemente para perseguir.\n   (Esta ventana de persecución dura 3 minutos después de que el monstruo escape.)' };
  }

  const targetRoomId = fleeData.room_id;
  const targetRoom = db.getRoom(targetRoomId);
  if (!targetRoom) {
    return { text: '🏃 No podés encontrar al monstruo — la ruta de escape ya no existe.' };
  }

  // Verificar que la sala destino sea adyacente
  const currentRoom = db.getRoom(player.current_room_id);
  const exits = currentRoom ? (typeof currentRoom.exits === 'string' ? JSON.parse(currentRoom.exits) : currentRoom.exits) : {};
  const isAdjacent = Object.values(exits).some(exit => {
    const tId = typeof exit === 'object' ? exit.room_id : exit;
    return tId === targetRoomId;
  });

  if (!isAdjacent) {
    return { text: `🏃 El ${fleeData.monster_name} escapó demasiado lejos — ya no podés seguirlo desde aquí.` };
  }

  const fromRoomId = player.current_room_id;
  db.updatePlayer(player.id, { current_room_id: targetRoomId });

  // Limpiar el dato de huida
  delete scrolls['last_flee'];
  db.updatePlayer(player.id, { active_scrolls: JSON.stringify(scrolls) });

  const updatedPlayer = db.getPlayer(player.id);
  const lookResult = cmdLook(updatedPlayer);

  // Ver si el monstruo sigue ahí
  const monsters = db.getMonstersInRoom(targetRoomId);
  const escapee = monsters.find(m => m.name === fleeData.monster_name && m.hp > 0);
  const monsterMsg = escapee
    ? `\n⚔️ ¡Encontrás al ${fleeData.monster_name} herido (${escapee.hp}/${escapee.max_hp} HP)! Atacá antes de que vuelva a escapar.`
    : `\n💨 El ${fleeData.monster_name} ya no está aquí — logró escapar del todo.`;

  return {
    text: `🏃 Salís corriendo tras el ${fleeData.monster_name}...\n\n${lookResult.text}${monsterMsg}`,
    event: `${player.username} sale corriendo en persecución.`,
    eventRoomId: fromRoomId,
    fromRoomId,
    fromRoomEvent: `${player.username} sale corriendo en persecución.`,
  };
}

/**
 * T129: cmdTrade — Sistema de intercambio seguro de ítems entre dos jugadores.
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
      const tradeInitWeaponDef = items.getItemDef(trade.item);
      const tradeInitWeaponBonus = tradeInitWeaponDef?.amount || 0;
      initiatorUpdates.equipped_weapon = null;
      initiatorUpdates.attack = freshInitiator.attack - tradeInitWeaponBonus;
    }
    if (freshInitiator.equipped_armor === trade.item) {
      const armorDef = items.getItemDef(trade.item);
      const armorAmt = armorDef ? (armorDef.amount || 0) : 0;
      initiatorUpdates.equipped_armor = null;
      initiatorUpdates.defense = (freshInitiator.defense || 2) - armorAmt;
    }
    db.updatePlayer(freshInitiator.id, initiatorUpdates);

    const playerUpdates = { inventory: newPlayerInv };
    if (freshPlayer.equipped_weapon === playerItemActual) {
      const tradePlayerWeaponDef = items.getItemDef(playerItemActual);
      const tradePlayerWeaponBonus = tradePlayerWeaponDef?.amount || 0;
      playerUpdates.equipped_weapon = null;
      playerUpdates.attack = freshPlayer.attack - tradePlayerWeaponBonus;
    }
    if (freshPlayer.equipped_armor === playerItemActual) {
      const armorDef = items.getItemDef(playerItemActual);
      const armorAmt = armorDef ? (armorDef.amount || 0) : 0;
      playerUpdates.equipped_armor = null;
      playerUpdates.defense = (freshPlayer.defense || 2) - armorAmt;
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
    expiresAt: Date.now() + 30000,
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

  // T215: Registrar en chat reciente
  if (global.pushRecentChat) global.pushRecentChat('emote', player.username, trimmed);

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
    expiresAt: Date.now() + 60000,
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
  { name: 'poción de salud',         price: 15, description: 'Recupera 15 HP. Esencial para aventureros.' },
  { name: 'poción mayor de salud',   price: 35, description: 'Recupera 50 HP. Para las situaciones desesperadas.' },
  { name: 'antídoto',                price: 20, description: 'Cura el veneno al instante.' },
  { name: 'espada de hierro',        price: 30, description: 'Arma sólida. Daño base +8.' },
  { name: 'daga envenenada',         price: 45, description: 'Daño +4, aplica veneno al enemigo.' },
  { name: 'escudo de madera',        price: 25, description: 'Defensa +2. No es glamoroso, pero funciona.' },
  { name: 'antorcha',                price: 5,  description: 'Ilumina pasillos oscuros. Dura varias horas.' },
  { name: 'cuerda',                  price: 10, description: 'Desactiva trampas de pinchos. 15m de largo.' },
  { name: 'espada oxidada',          price: 15, description: 'Una espada vieja pero funcional. +3 ataque. Ingrediente para craftear espada de obsidiana.' },
  { name: 'llave oxidada',           price: 20, description: 'Abre cierta puerta al norte del Pozo. El mercader no explica más. (O buscá la Araña Tejedora del Pozo — a veces la lleva consigo.)' },
  // T152: Armaduras
  { name: 'cuero endurecido',        price: 30, description: 'Armadura ligera. +2 defensa.' },
  { name: 'cota de malla',           price: 60, description: 'Armadura de hierro. +3 defensa.' },
  { name: 'túnica encantada',        price: 80, description: 'Armadura mágica. +4 defensa. Ideal para magos.' },
  // DIS-D27: poción de maná para Magos
  // DIS-559: precio bajado de 20g → 12g para compensar economía doble del Mago
  { name: 'poción de maná',          price: 12, description: 'Restaura 15 maná al instante. Indispensable para Magos.' },
  // DIS-D421: Consumibles que presionan al jugador a gastar oro
  { name: 'poción de maná mayor',    price: 30, description: 'Restaura 20 maná al instante. La versión potenciada, para situaciones críticas. Solo aquí.' },
  { name: 'cristal helado',          price: 30, description: 'Un cristal del norte glacial. Ingrediente para craftear la lanza espectral. \'Fragmento de hielo + cristal helado = lanza espectral.\'' },
  // DIS-536: sello del carcelero como pieza de colección — Aldric lo compra a 20g (40% de 50g)
  { name: 'sello del carcelero',     price: 50, description: 'El sello oficial de los carceleros de la Prisión Subterránea. Aldric lo compra como pieza histórica. (+3 DEF si lo equipás, o vendelo por 20g)' },
  // DIS-558: ítems específicos de clase Mago
  { name: 'vara de energía',         price: 40, description: '🔮 (Mago) Una vara canalizada con energía arcana. Amplifica los hechizos del portador. +5 ataque mágico. Bonus especial para Magos.' },
  { name: 'pergamino de hechizo',    price: 25, description: '🔮 (Mago) Un pergamino consumible que otorga un lanzamiento de hechizo gratuito — no consume maná. Útil cuando estás al límite.' },
  // DIS-595: bolsa de lona — expande inventario +4 slots, máx 2 bolsas
  { name: 'bolsa de lona',           price: 30, description: 'Una bolsa de lona resistente con correas de cuero. Al usarla, amplía tu capacidad de inventario en 4 slots (+4 más si comprás una segunda). Máximo 2.' },
  // DIS-585: materiales de loot con precios diferenciados (sellOnly — no aparecen en la tienda)
  { name: 'pelaje áspero',           price: 13,  sellOnly: true, description: 'Pelaje de rata gigante. Aldric lo compra para curtiembre.' },
  { name: 'garra de esqueleto',      price: 15,  sellOnly: true, description: 'Garra de esqueleto. Aldric la compra como material de armamento.' },
  { name: 'diente afilado',          price: 13,  sellOnly: true, description: 'Colmillo de murciélago. Aldric lo compra para herramientas.' },
  { name: 'hilo de seda',            price: 20,  sellOnly: true, description: 'Hilo de seda de araña. Alta demanda en artesanía mágica.' },
  { name: 'veneno concentrado',      price: 25,  sellOnly: true, description: 'Veneno de Araña Tejedora. Aldric lo usa para preparar dagas.' },
  { name: 'esencia etérea',          price: 30,  sellOnly: true, description: 'Esencia brumosa de espectro. Ingrediente alquímico valioso.' },
  { name: 'piedra de poder',         price: 20,  sellOnly: true, description: 'Piedra que vibra con magia. Aldric la compra para encantamientos.' },
  { name: 'fragmento de hielo',      price: 20,  sellOnly: true, description: 'Hielo antiguo que no se derrite. Material raro y codiciado.' },
  { name: 'núcleo de forja',         price: 38,  sellOnly: true, description: 'Núcleo de gólem. Irradia calor arcano — muy valioso.' },
  { name: 'tinta de kraken',         price: 25,  sellOnly: true, description: 'Tinta abismal. Se usa en pergaminos de hechizos avanzados.' },
  { name: 'escama abismal',          price: 30,  sellOnly: true, description: 'Escama del Krakeling. Dura como el acero, ideal para armaduras.' },
  { name: 'cristal resonante',       price: 20,  sellOnly: true, description: 'Cristal que vibra con el eco. Ingrediente para armas espectrales.' },
  { name: 'polvo de eco',            price: 15,  sellOnly: true, description: 'Polvo de la Cámara del Eco. Artesanal, Aldric lo colecciona.' },
  { name: 'esencia de eco',          price: 30,  sellOnly: true, description: 'Esencia de Eco Viviente. Ingrediente raro para crafteo espectral.' },
  { name: 'esencia de sombra',       price: 38,  sellOnly: true, description: 'Esencia de las sombras del dungeon. Material de altísimo nivel.' },
  { name: 'esencia del abismo',      price: 38,  sellOnly: true, description: 'Esencia pura de la Sombra del Vacío. Extremadamente valiosa.' },
  { name: 'fragmento de vacío',      price: 38,  sellOnly: true, description: 'Fragmento del Abismo Eterno. Aldric lo quiere para investigación.' },
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

// ─── T242: Quest narrativa con Aldric ────────────────────────────────────────
//
// Estados de aldric_quest en el jugador:
//   'none'    — no ha interactuado todavía
//   'active'  — quest en progreso (buscar carta sellada en sala 8)
//   'done'    — quest completada
//
function cmdTalk(player, target) {
  player = db.getPlayer(player.id);
  const tLow = (target || '').trim().toLowerCase();

  // Guardián anciano en sala 1 (Entrada de la Cripta) — DIS-D42: pista de ruta alternativa
  // DIS-D378: variantes contextuales según estado del jugador
  const inRoom1 = player.current_room_id === 1 || player.current_room_id === 16;
  const isGuardian = tLow.includes('anciano') || tLow.includes('guardián') || tLow.includes('guardian') ||
                     tLow.includes('guardia') || tLow === 'viejo' || tLow === 'npc' ||
                     (tLow === '' && inRoom1);

  if (isGuardian) {
    if (!inRoom1) {
      return { text: '🧓 El guardián anciano solo está en la Entrada de la Cripta o la Antesala.' };
    }
    const level = player.level || 1;
    const roomsVisited = (() => { try { return JSON.parse(player.rooms_visited || '[]'); } catch (_) { return []; } })();
    const hasVisitedPozo = roomsVisited.includes(7);
    const playerAchs = (() => { try { return JSON.parse(player.achievements || '[]'); } catch (_) { return []; } })();
    const hasCartografo = playerAchs.includes('cartografo');
    const seFreshG = parseSE(player.status_effects);
    const leyoDiario = seFreshG.leyo_diario_galeria;
    const qStateG = player.aldric_quest || 'none';

    // DIS-454: Pregunta específica sobre santuario o llave → ruta alternativa directa
    const askingSanctuaryOrKey = tLow.includes('santuario') || tLow.includes('llave') || tLow.includes('pozo') || tLow.includes('cómo llegar') || tLow.includes('ruta');
    if (askingSanctuaryOrKey) {
      return { text: 'El anciano te mira cuando nombrás el Santuario —algo en su postura cambia, como si hubiera estado esperando esa pregunta.\n\n\"Hay dos rutas,\" dice. \"La directa: desde la Sala de los Ecos al oeste, llegás al Pozo Sin Fondo. La puerta al norte tiene cerradura —necesitás una llave oxidada. La vendemos en la tienda de sala 4 por 20 monedas de oro, o podés buscarla en la Prisión al norte del Tesoro. También, la Araña Tejedora del Pozo a veces la lleva consigo.\"\n\nHace una pausa, como calibrando si vale la pena continuar.\n\n\"La otra ruta no necesita llave. Desde aquí: al este, la Capilla Olvidada. Al norte desde ahí, el Túnel de los Hongos. Norte otra vez, la Sala del Trono. Y desde el Trono, al este: el Santuario Profano.\"\n\nSeñala con la mano el camino este mientras habla. \"Es más largo, pero está siempre abierto. No sé por qué ese camino quedó sin cerradura. Tengo mis sospechas.\"' };
    }

    // VARIANTE 1: Logro Cartógrafo — exploró todo el dungeon
    if (hasCartografo) {
      let cartText = 'El anciano te mira de pies a cabeza. Algo en su expresión cambia —no es sorpresa, es reconocimiento.\n\n\"Cartógrafo,\" dice en voz baja. \"Llegaste a todas las salas. No muchos lo hacen.\" Pausa. \"La mayoría solo busca el tesoro o la salida. Vos buscabas entender.\"\n\nSe gira hacia la entrada del dungeon con gesto nostálgico. \"Hay cosas en esas paredes que yo ya no me atrevo a ver. Si llegaste hasta la Catedral de la Oscuridad y volviste... entonces sabés más del dungeon de lo que yo jamás supe.\"';
      if (qStateG === 'done') {
        cartText += '\n\n\"Y sabés quién fue Kaelthas.\" No es una pregunta. \"El dungeon fue su decisión. Su nombre sigue en cada piedra.\" Cierra los ojos brevemente. \"No hay nada más que yo pueda decirte que vos no hayas visto ya.\"';
      } else if (leyoDiario) {
        cartText += '\n\n\"Leíste el diario de la Galería de Hielo, ¿verdad?\" Asiente lentamente. \"Kaelthas. Ese nombre aparece en demasiados lugares para ser casualidad. Si todavía no hablaste con Aldric —el mercader en sala 4— creo que deberías. Él sabe cosas que yo solo intuyo.\"';
      }
      return { text: cartText };
    }

    // VARIANTE 2: Quest de Aldric completada — conoce la historia de Kaelthas
    if (qStateG === 'done') {
      return { text: 'El anciano levanta la vista. Algo en tu cara le dice que ya no sos el mismo que entró al dungeon por primera vez.\n\n\"Hablaste con Aldric,\" dice. No es una pregunta.\n\nAsiente despacio. \"Kaelthas Vorn. El guardián del sello. Sabía que tarde o temprano alguien lo iba a descubrir.\" Pausa. \"Yo lo sospechaba hace años, cuando noté que los monstruos nunca desaparecen del todo. No es magia al azar —hay una voluntad detrás.\"\n\n\"Cuidate en la Catedral,\" agrega en voz baja. \"Su presencia ahí es más... directa. El Lich Anciano no es el peligro final. Es solo la puerta.\"' };
    }

    // VARIANTE 3: Leyó el diario — hint directo sobre Kaelthas y Aldric
    if (leyoDiario && qStateG === 'none') {
      return { text: 'El anciano pausa al verte. Hay algo diferente en su mirada —te estudia con más atención de lo habitual.\n\n\"Leíste el diario helado,\" dice. No es una pregunta. \"En la Galería de Hielo. Las páginas medio fusionadas.\"\n\nBaja la voz. \"Kaelthas no murió como los libros dicen. Eligió quedarse aquí —y el dungeon lo aceptó.\" Se inclina levemente hacia vos. \"Hay un mercader en sala 4. Aldric. Cuando tengas nivel 5, hablá con él. Llevá cualquier objeto que hayas encontrado en el dungeon —especialmente si tiene un sello grabado. Creo que sabe más. Mucho más.\"\n\nVuelve a mirar la entrada en silencio. Como si temiera que el dungeon lo escuche.' };
    }

    // VARIANTE 4: Leyó el diario y tiene la quest en progreso — hint de avance
    if (leyoDiario && qStateG === 'active') {
      return { text: 'El anciano asiente al verte acercarte.\n\n\"Buscás a Kaelthas.\" Más afirmación que pregunta. \"Aldric te mandó.\"\n\nSeñala la entrada del dungeon. \"La Prisión está en el norte del dungeon —sala 8, al norte de la Cámara del Tesoro. Ahí guardaban las llaves y también los secretos que nadie quería que salieran.\" Pausa. \"Si encontrás una carta con el sello de las dos llaves cruzadas, llevásela a Aldric. Él sabe qué hacer.\"\n\nBaja la vista. \"Kaelthas fue el guardián del sello del reino. No un mago cualquiera. El dungeon no es una mazmorra abandonada —es su archivo.\"' };
    }

    // VARIANTE 5: Nivel alto (≥7) — veterano del dungeon
    if (level >= 7) {
      return { text: 'El anciano te mira con algo parecido al respeto.\n\n\"Nivel ' + level + '.\" Asiente con lentitud. \"Ya no necesitás mis advertencias sobre el Pozo o la llave.\"\n\nSe recuesta en la pared con expresión seria. \"Si llegaste hasta acá con ese nivel, ya pasaste por la Catedral de la Oscuridad o el Abismo Eterno.\" Pausa. \"¿Encontraste las páginas del diario helado en la Galería? Hay un nombre que aparece en demasiados lugares aquí adentro. Si no lo conectaste todavía, hablá con Aldric en sala 4.\"\n\nTe mira fijo. \"El dungeon tiene memoria. Y vos ya sos parte de ella.\"' };
    }

    // VARIANTE 6: Visitó el Pozo — navegación avanzada
    if (hasVisitedPozo) {
      return { text: 'El anciano te mira con ojos que han visto demasiado.\n\n\"Ya encontraste el Pozo, ¿verdad? La puerta al norte del Pozo tiene cerradura —necesitás una llave oxidada. La guardaban en la Prisión, sala 8, al norte de la Cámara del Tesoro.\"\n\nTose y continúa: \"Pero si no querés buscarla, hay otro camino. Hacia el este está la Capilla Olvidada. Desde ahí, al norte, el Túnel de los Hongos. Luego al norte otra vez, la Sala del Trono. Y desde el Trono, al este: el Santuario. Sin llave.\"\n\nSonríe brevemente. \"Nadie sabe por qué ese camino quedó abierto. Yo tengo mis sospechas.\"' };
    }

    // VARIANTE 7: Nivel medio (≥3)
    if (level >= 3) {
      return { text: 'El anciano asiente al verte.\n\n\"Buscás llegar al Santuario Profano, ¿no?\" No espera respuesta. \"Hay dos rutas. La directa pasa por el Pozo Sin Fondo —al oeste desde la Sala de los Ecos— pero la puerta al norte tiene cerradura. Necesitás una llave oxidada.\"\n\nSeñala hacia el este. \"La otra ruta es más larga pero abierta: Capilla → Hongos → Trono → Santuario. Sin llave. Muchos lo ignoran y se quedan dando vueltas buscando oro para la tienda.\"\n\nVuelve a apoyarse en la pared, como si esa conversación lo hubiera cansado.' };
    }

    // VARIANTE 8: Principiante
    return { text: 'El guardián anciano levanta la vista hacia vos.\n\n\"Nuevo en el dungeon. Bien.\" Pausa. \"Escuchá: el dungeon tiene dos zonas principales. Al norte y al este desde aquí. Al norte hay más combate directo; al este hay cosas más... sutiles.\"\n\nSe rasca la barba. \"Cuando llegués al Pozo Sin Fondo —lo vas a saber cuando lo veas— hay una puerta bloqueada al norte. Si no tenés la llave, no la fuerces. Hay otro camino por el este, pasando por la Capilla. Acordate de eso.\"\n\nSeñala hacia abajo con el pulgar. \"Ah, y si querés practicar sin riesgo —sin que nadie te lastime y sin perder nada— hay una Sala de Práctica debajo de acá. Escribí \'abajo\' para bajar. Los maniquíes no muerden.\"\n\nVuelve a mirar la pared, como si la conversación hubiera terminado.' };
  }

  // Solo Aldric por ahora. Acepta: 'aldric', 'mercader', 'tendero', o vacío si está en sala 4
  const inRoom4 = player.current_room_id === MERCHANT_ROOM_ID;
  const isAldric = tLow.includes('aldric') || tLow === 'mercader' || tLow === 'tendero' || (tLow === '' && inRoom4);

  // DIS-537: Escriba élfico de la Casa de Subastas (sala 17) — responde a "hablar escriba"
  const isEscribaAuction = tLow.includes('escriba') || tLow.includes('elfo') || tLow.includes('élfico') || tLow.includes('subastador');

  // DIS-543: Maestro de Combate en Sala del Trono (sala 9) — responde a "hablar maestro"
  const isMaestroCombate = tLow === 'maestro' || tLow.includes('maestro de combate') || tLow.includes('maestro combate') || tLow.includes('instructor');
  if (isMaestroCombate) {
    if (player.current_room_id !== 9) {
      return { text: '⚔️ El Maestro de Combate reside en la Sala del Trono (sala 9). Llegá desde la Sala de los Hongos al norte, o desde el Santuario Profano al oeste.' };
    }
    const duelWins = player.duel_wins || 0;
    const duelLosses = player.duel_losses || 0;
    if (duelWins > 0 || duelLosses > 0) {
      return { text: `⚔️ El Maestro de Combate te estudia con sus ojos quietos —ojos que han visto mil peleas.\n\n"${duelWins > duelLosses ? 'Veo que ganás más de lo que perdés. Eso no es suficiente.' : 'Perdiste más de lo que ganaste. Eso tampoco es suficiente.'} Lo que importa es si aprendiste algo en cada pelea."\n\nSeñala el centro de la sala con la espada envainada.\n\n"Volvé cuando quieras entrenar. El comando es: duel maestro. Yo no sangro, así que no tenés que preocuparte por matarme."\n\nEl trono detrás de él no parece tan vacío como antes.` };
    }
    return { text: '⚔️ Un guerrero de armadura oscura ocupa un rincón de la Sala del Trono, inmóvil como parte del mobiliario. Cuando te acercás, se gira sin hacer ruido.\n\n"Maestro de Combate," dice, como si fuera su nombre. "Los duelos son la única pelea justa que vas a encontrar en este dungeon. Sin ventajas de terreno, sin envenenamiento, sin emboscada. Solo vos y otro —o yo."\n\nDesenvaina la espada despacio, la examina, y la vuelve a envainar.\n\n"El sistema funciona así: retás a otro jugador con \'duel <nombre>\'. Ellos aceptan con \'accept\'. Pelean en rounds hasta que uno cae a 0 HP —sin morir, es simulado. El perdedor conserva su HP real. Solo el orgullo queda en juego."\n\nHace una pausa.\n\n"Si querés probarlo sin necesitar a otro jugador: escribe \'duel maestro\'. Yo soy un oponente a tu nivel. No te voy a dar XP ni loot —pero vas a aprender cómo funciona un duelo real."' };
  }

  if (isEscribaAuction) {
    const inAuctionRoom = player.current_room_id === 17;
    if (!inAuctionRoom) {
      return { text: '📜 El escriba élfico no está aquí. Está en la Casa de Subastas (sala 17, al este de la Cámara del Tesoro).\n  💡 Ruta desde la Cámara del Tesoro: este' };
    }
    return { text: '📜 El escriba levanta la pluma un instante —lo único que se detiene— y te mira de costado sin girar la cabeza.\n\n"¿Subasta? Simple." Vuelve a escribir sin dejar de hablar.\n\n"Tenés un ítem. Querés oro. Escribís: subastar <ítem> <precio_mínimo>. Ejemplo: subastar espada oxidada 10."\n\nTic. Tac. La pluma sigue.\n\n"Para ver subastas activas: subastas. Para pujar: pujar <id> <monto>. La sala acepta vendedores y compradores simultáneamente."\n\nPausa. Un segundo. "Si nadie compra, el ítem vuelve. Si alguien supera tu puja, el oro te vuelve. Sin pérdidas involuntarias."\n\nReanuda el registro como si la conversación hubiera terminado antes de que empezara.' };
  }

  if (!isAldric) {
    return { text: '🗣️ No hay nadie con ese nombre con quien hablar. (Pista: "hablar aldric" en la Cámara del Tesoro, "hablar anciano" en la Entrada, "hablar escriba" en la Casa de Subastas, o "hablar maestro" en la Sala del Trono.)' };
  }

  if (!inRoom4) {
    return { text: '🏪 Aldric no está aquí. Está en la Cámara del Tesoro (sala 4).\n  💡 Ruta desde la Entrada: norte → norte → este' };
  }

  const questState = player.aldric_quest || 'none';
  const level = player.level || 1;

  // Contar visitas a sala 4
  let visited = [];
  try { visited = JSON.parse(player.rooms_visited || '[]'); } catch (_) {}
  const room4VisitCount = visited.filter(id => id === 4).length;
  // rooms_visited es un set (sin duplicados), así que si sala 4 está en el array
  // simplemente ha visitado la sala al menos una vez. Para contar múltiples visitas
  // necesitamos una heurística: si está en sala 4 AHORA, ya la visitó.
  // El trigger es nivel 5+ O haber ido a la tienda antes (heurística: gold_spent > 0)
  const triggerable = level >= 5 || (player.gold_spent || 0) > 0;

  if (questState === 'done') {
    return { text: 'Aldric te mira con algo que podría ser respeto, o reconocimiento, o las dos cosas.\n\n"Ya no te veo igual que antes," dice, y vuelve a sus cuentas.\n\nEl símbolo de las dos llaves cruzadas sigue en su delantal. Ahora sabés qué significa. Kaelthas Vorn. El guardián. El dungeon fue su archivo.\n\nSu alma sigue aquí, atada a las piedras. A los corredores. A la Sala del Trono donde algo observa sin ojos.' };
  }

  if (questState === 'active') {
    // Verificar si tiene la carta sellada
    const inv = Array.isArray(player.inventory) ? player.inventory : JSON.parse(player.inventory || '[]');
    const hasCarta = inv.some(i => i.toLowerCase().includes('carta sellada'));

    if (hasCarta) {
      // Completar la quest
      // Recompensa: 50 XP + 25g + texto de Aldric cambia para siempre
      const freshP = db.getPlayer(player.id);
      db.updatePlayer(player.id, {
        xp: (freshP.xp || 0) + 50,
        gold: (freshP.gold || 0) + 25,
        aldric_quest: 'done',
        inventory: JSON.stringify(inv.filter(i => !i.toLowerCase().includes('carta sellada')))
      });
      db.addJournalEntry(player.id, 'quest', '📜 Aldric me reveló el nombre completo: Kaelthas Vorn. Guardián del reino. El dungeon fue su archivo. Su alma quedó atada aquí cuando lo mataron. Sigue en las piedras. En los corredores. En la Sala del Trono.');
      db.logGlobalEvent('quest', `📜 ${player.username} descubrió el secreto de Aldric el Mercader.`);
      return { text: 'Aldric toma la carta con manos que no tiemblan, pero que deberían.\n\nEl sello de las dos llaves cruzadas. Lo mira durante un momento demasiado largo.\n\n"Fue el guardián del sello del reino," dice al fin, en voz tan baja que casi no lo escuchás. "No el rey. El guardián. Los que guardaban las llaves eran los que realmente mantenían el reino unido."\n\nPausa. "Kaelthas Vorn. Ese era su nombre completo. El que todos olvidaron —o fingieron olvidar— cuando el reino cayó."\n\n"El dungeon no fue siempre esto. Era su biblioteca. Su archivo. Cuando murió —cuando lo mataron— su alma no pudo irse porque tenía demasiadas deudas con el mundo. Quedó atada aquí. A las piedras. A los nombres grabados en los corredores."\n\nSe inclina hacia vos. "Si alguna vez llegás a la Sala del Trono y sentís que algo te observa desde el vacío... es él. Sigue aquí. Esperando que alguien entienda qué pasó."\n\nDobla la carta sin abrirla y la guarda debajo del mostrador.\n\n"Tomá esto. Y si algún día pronunciás su nombre completo en el lugar correcto, vas a entender por qué todavía importa."\n\n"Ah, y si explorás el dungeon con otros aventureros — las hermandades tienen misiones propias. guild create sombra_de_hierro, por ejemplo. Las podés completar incluso en solitario."\n\n🎉 Quest completada: El Sello de las Dos Llaves. (+50 XP · +25g)\n📜 El lore de Kaelthas Vorn está ahora completo — su presencia en el dungeon tiene sentido.\n📖 Diario actualizado: "Kaelthas Vorn fue el guardián. El dungeon fue su archivo. Su alma quedó atada aquí."' };
    } else {
      return { text: 'Aldric asiente levemente cuando te ve.\n\n"¿La encontraste ya?"\n\nSu expresión no cambia, pero algo en sus ojos dice que sí le importa.\n\n"Sala 8. La prisión del nivel inferior. Buscá la carta con el sello de las dos llaves cruzadas. Traémela."\n\nVuelve a sus cuentas. La conversación terminó.' };
    }
  }

  // questState === 'none'
  if (!triggerable) {
    // Todavía no se desbloqueó — Aldric habla normalmente
    // DIS-D351: si el jugador tiene la carta sellada pero aún no es nivel 5,
    // dar un hint contextual en lugar del diálogo neutro.
    const invForHint = Array.isArray(player.inventory) ? player.inventory : JSON.parse(player.inventory || '[]');
    const hasCartaForHint = invForHint.some(i => i.toLowerCase().includes('carta sellada'));
    if (hasCartaForHint) {
      return { text: 'Aldric levanta la vista de su libro de cuentas. Algo en su mirada cambia cuando te ve —un reconocimiento fugaz que apaga enseguida.\n\n"¿Querés comprar algo?" dice. No es una pregunta. Pero sus ojos van a tu mochila por un instante.\n\nNecesitás más experiencia para que confíe en vos. (Nivel 5 requerido para desbloquear la quest)' };
    }
    return { text: 'Aldric levanta la vista de su libro de cuentas.\n\n"¿Querés comprar algo?" dice. No es una pregunta.\n\nSu mirada vuelve a los números. El delantal con el símbolo de las dos llaves cruzadas se mueve cuando se inclina sobre el mostrador.' };
  }

  // Trigger: desbloquear la quest
  db.updatePlayer(player.id, { aldric_quest: 'active' });
  db.addJournalEntry(player.id, 'quest', '📜 Aldric me habló del sello. Quiere que le traiga una carta de sala 8.');
  return { text: 'Aldric te mira durante más tiempo del necesario cuando te acercás.\n\n"Pasaste ya por los niveles inferiores," dice. No lo pregunta.\n\nGuarda el libro de cuentas debajo del mostrador. Cuando vuelve a mirarte, tiene una expresión diferente: menos mercader, más algo que no sabés nombrar.\n\n"Hay algo en la prisión del nivel inferior. Sala 8." Baja la voz. "Una carta con el sello de las dos llaves cruzadas. Si la encontrás, traémela. Sin abrirla."\n\n"¿Por qué?" preguntás.\n\n"Porque era del reino. Y yo era del reino."\n\nVuelve a sacar el libro de cuentas. La conversación terminó, aunque él todavía no se fue.\n\n📜 Nueva quest: El Sello de las Dos Llaves — Encontrá la carta sellada en sala 8 y traésela a Aldric.' };
}

function cmdShop(player) {
  player = db.getPlayer(player.id);

  if (player.current_room_id !== MERCHANT_ROOM_ID) {
    return { text: '🏪 No hay ningún mercader aquí. El mercader vive en la Cámara del Tesoro (sala 4).\n  💡 Ruta desde la Entrada: norte → norte → este' };
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

  SHOP_CATALOG.filter(item => !item.sellOnly).forEach((item, i) => {
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
    return { text: '🏪 No hay ningún mercader aquí. El mercader vive en la Cámara del Tesoro (sala 4).\n  💡 Ruta desde la Entrada: norte → norte → este' };
  }

  const query = itemQuery.trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // DIS-005: normalizar tildes

  // BUG-248: aceptar número de índice (ej: "comprar 1" → primer ítem del catálogo)
  let item;
  const buyableCatalog = SHOP_CATALOG.filter(i => !i.sellOnly);
  const numQuery = parseInt(query, 10);
  if (!isNaN(numQuery) && numQuery >= 1 && numQuery <= buyableCatalog.length) {
    item = buyableCatalog[numQuery - 1];
  } else {
    item = buyableCatalog.find(i => {
      const itemNorm = i.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      return itemNorm.includes(query) || query.includes(itemNorm);
    });
  }

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

  // STORY-008: Personalidad de Aldric — líneas de flavor al comprar
  const buyFlavors = [
    'Aldric no levanta la vista de sus cuentas mientras envuelve el ítem.',
    'Aldric asiente sin decir nada. Ha visto demasiados aventureros para sorprenderse.',
    '"Buena elección," dice Aldric. El tono sugiere que lo dice siempre.',
    'Aldric guarda el oro con la misma velocidad con que desaparece en su interior.',
    'Aldric examina el ítem antes de entregarlo. Breve. Profesional. Impenetrable.',
  ];
  const flavor = buyFlavors[Math.floor(Math.random() * buyFlavors.length)];

  // Línea especial con reputación Legendario
  const repLevel = db.getReputationLevel(freshBuyer.reputation || 0);
  const legendaryLine = repLevel === 'Legendario'
    ? '\n"He oído tu nombre antes," dice Aldric en voz baja. "Hasta Kaelthas supo que vendría alguien así. No sé si eso es bueno."'
    : '';

  return {
    text: `🏪 ${flavor}${legendaryLine}\n✅ Compraste: ${item.name} por ${finalPrice}g${discountMsg}.\n💰 Oro restante: ${newGold}g.${buyAchLines}`,
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
    return { text: '🏪 No hay ningún mercader aquí. El mercader vive en la Cámara del Tesoro (sala 4).\n  💡 Ruta desde la Entrada: norte → norte → este' };
  }

  // BUG-313: si el query es un número, interpretar como índice del inventario (1-based)
  let resolvedQuery = itemQuery.trim();
  const indexNum = parseInt(resolvedQuery, 10);
  if (!isNaN(indexNum) && String(indexNum) === resolvedQuery && indexNum >= 1 && indexNum <= player.inventory.length) {
    resolvedQuery = player.inventory[indexNum - 1];
  }

  const found = items.findItem(player.inventory, resolvedQuery);
  if (!found) {
    // BUG-517: también buscar en ítems equipados (no están en player.inventory)
    const nq = resolvedQuery.toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const eqWeapon = player.equipped_weapon && player.equipped_weapon !== 'null' ? player.equipped_weapon : null;
    const eqArmor  = player.equipped_armor  && player.equipped_armor  !== 'null' ? player.equipped_armor  : null;
    const matchEquipped = (eqWeapon && eqWeapon.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(nq) ? eqWeapon : null)
                       || (eqArmor  && eqArmor.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(nq)  ? eqArmor  : null);
    if (!matchEquipped) {
      return { text: `No tenés ningún "${itemQuery}" en el inventario.` };
    }
    // Vender ítem equipado directamente
    const sellQuery = matchEquipped;
    const catalogItemEq = SHOP_CATALOG.find(i => i.name.toLowerCase() === sellQuery.toLowerCase());
    const basePriceEq = catalogItemEq ? catalogItemEq.price : 10;
    const sellPriceEq = Math.max(1, Math.floor(basePriceEq * SELL_PRICE_RATIO));
    const newGoldEq = (player.gold || 0) + sellPriceEq;
    // Desequipar y actualizar stats
    if (sellQuery === eqWeapon) {
      const wDef = items.getItemDef(sellQuery);
      const wBonus = wDef?.amount || 0;
      db.updatePlayer(player.id, { attack: player.attack - wBonus, equipped_weapon: null, gold: newGoldEq });
    } else {
      const aDef = items.getItemDef(sellQuery);
      const aBonus = aDef?.amount || 0;
      db.updatePlayer(player.id, { defense: player.defense - aBonus, equipped_armor: null, gold: newGoldEq });
    }
    return {
      text: `🏪 Aldric examina el objeto.\n(Primero lo desequipás.)\n\"Te doy ${sellPriceEq}g por eso.\"\n💰 Vendiste: ${sellQuery} por ${sellPriceEq}g. Total: ${newGoldEq}g.`,
      event: `${player.username} vende algo al mercader.`,
      eventRoomId: player.current_room_id,
    };
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
    const soldWeaponDef = items.getItemDef(found);
    const soldWeaponBonus = soldWeaponDef?.amount || 0;
    const baseAttackAfterSell = player.attack - soldWeaponBonus;
    db.updatePlayer(player.id, { attack: baseAttackAfterSell, equipped_weapon: null });
  }

  // Si era la armadura equipada, desequipar
  if (player.equipped_armor === found) {
    const soldArmorDef = items.getItemDef(found);
    const soldArmorBonus = soldArmorDef?.amount || 0;
    const baseDefenseAfterSell = player.defense - soldArmorBonus;
    db.updatePlayer(player.id, { defense: baseDefenseAfterSell, equipped_armor: null });
  }

  // STORY-008: línea especial al vender ítems épicos/legendarios
  const soldRarity = items.ITEM_RARITY ? items.ITEM_RARITY[found] : null;
  const rareFlavorMap = {
    'épico':      'Aldric examina el ítem con ojos que han visto demasiado. "No pregunto cómo lo conseguiste." Pausa. "Mejor para los dos."',
    'legendario': 'Aldric sostiene el ítem un momento más de lo necesario. Cuando levanta la vista, algo en su expresión cambió. "Este... este tiene historia. ¿Estás seguro de que querés venderlo?"',
  };
  const rareFlavorLine = (soldRarity && rareFlavorMap[soldRarity]) ? `\n${rareFlavorMap[soldRarity]}` : '';
  // DIS-585: línea especial para materiales de loot (sellOnly)
  const isSellOnlyMaterial = catalogItem?.sellOnly;
  const materialFlavorLine = isSellOnlyMaterial ? `\n"${catalogItem.description}"` : '';

  return {
    text: `🏪 Aldric examina el objeto.${rareFlavorLine}${materialFlavorLine}\n"Te doy ${sellPrice}g por eso."\n💰 Vendiste: ${found} por ${sellPrice}g. Total: ${newGold}g.`,
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
 * T086 — Quest activa: mostrar quest global y progreso del jugador.
 * BUG-485: También muestra la quest narrativa de Aldric si está activa o completada.
 */
function cmdQuest(player) {
  player = db.getPlayer(player.id);
  const lines = [];

  // Quest global del sistema
  lines.push(quests.formatQuest(player));

  // Quest narrativa de Aldric (BUG-485)
  const aldricState = player.aldric_quest || 'none';
  if (aldricState === 'active') {
    const inv = Array.isArray(player.inventory) ? player.inventory : (() => { try { return JSON.parse(player.inventory || '[]'); } catch (_) { return []; } })();
    const hasCarta = inv.some(i => i.toLowerCase().includes('carta sellada'));
    lines.push('');
    lines.push('══ 📜 QUEST NARRATIVA: El Sello de las Dos Llaves ══');
    lines.push('Aldric el Mercader te pidió encontrar una carta con el sello de dos llaves cruzadas.');
    lines.push('📍 La carta sellada está en Sala 8 — Prisión Subterránea.');
    if (hasCarta) {
      lines.push('✅ ¡Tenés la carta sellada! Llevásela a Aldric (sala 4) con "hablar aldric".');
    } else {
      lines.push('⏳ Estado: buscando la carta en sala 8. (Ruta: norte → norte → este → norte desde Sala 4)');
    }
  } else if (aldricState === 'done') {
    lines.push('');
    lines.push('══ 📜 QUEST NARRATIVA: El Sello de las Dos Llaves ══');
    lines.push('✅ ¡Completada! Entregaste la carta sellada a Aldric y descubriste el secreto de Kaelthas Vorn.');
    lines.push('   (+50 XP · +25g)');
  }

  return { text: lines.join('\n') };
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
    text: lines + (isAfk(target.id) ? `\n💤 ${target.username} está en modo ausente${getAfkMessage(target.id) ? `: "${getAfkMessage(target.id)}"` : ''}` : ''),
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

    // Costo de fundación: 30 oro (DIS-523: reducido de 50 para bajar la barrera de entrada)
    const gold = player.gold || 0;
    if (gold < 30) {
      return { text: `Fundar una hermandad cuesta 30 de oro. Tenés ${gold}g. ¡Conseguí más monedas y volvé!` };
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
    db.updatePlayer(player.id, { gold: gold - 30 });

    return {
      text: `⚔ ¡Hermandad [${guildArg}] fundada! Te costó 30 de oro. Sos el líder 👑.\nInvitá jugadores diciéndoles que usen "guild join ${guildArg}". Chateá con "gc <mensaje>".\n\n💡 Las hermandades tienen misiones colectivas activas siempre — "guild quest" para ver la actual. ¡Las podés completar vos solo también!`,
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
 * T215: recent [N] — Historial de chat reciente (say/shout/emote/gc)
 */
function cmdRecent(args) {
  const log = global.recentChatLog || [];
  const n = Math.min(Math.max(parseInt(args[0], 10) || 10, 1), 20);
  const entries = log.slice(-n);

  if (entries.length === 0) {
    return { text: '💬 No hay mensajes de chat recientes todavía.' };
  }

  const W = 54;
  const border = '─'.repeat(W - 2);
  const lines = [`┌${border}┐`, `│${'  💬 CHAT RECIENTE'.padEnd(W - 2)}│`, `├${border}┤`];

  for (const e of entries) {
    const typeIcon = { say: '💬', shout: '📢', emote: '✨', gc: '🏰' }[e.type] || '💬';
    const prefix = `[${e.ts}] ${typeIcon} ${e.username}`;
    const content = `${prefix}: ${e.message}`;
    // Wrap a W-4 chars
    const maxLen = W - 4;
    let rem = content;
    while (rem.length > maxLen) {
      lines.push(`│  ${rem.slice(0, maxLen).padEnd(maxLen)}  │`);
      rem = rem.slice(maxLen);
    }
    lines.push(`│  ${rem.padEnd(maxLen)}  │`);
  }

  lines.push(`└${border}┘`);
  return { text: lines.join('\n') };
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
  const minLeft = Math.floor(ev.remainingMs / 60000);
  const secLeft = Math.floor((ev.remainingMs % 60000) / 1000);
  return {
    text: `🌍 EVENTO ACTIVO: ${ev.name}\n${ev.description}\n⏱ Tiempo restante: ${minLeft}m ${secLeft}s`,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// T212: cmdChampion — Ver el campeón de la hora actual
// ══════════════════════════════════════════════════════════════════════════════
function cmdChampion() {
  const W = 48;
  const champ = db.getHourlyChampion();
  const lines = [];
  lines.push(`╔${'═'.repeat(W)}╗`);
  lines.push(`║${'  👑  CAMPEÓN DE LA HORA'.padEnd(W)}║`);
  lines.push(`╠${'═'.repeat(W)}╣`);
  if (!champ || champ.hourly_kills < 3) {
    lines.push(`║  (Nadie ha reclamado el título aún)`.padEnd(W + 2) + `║`);
    lines.push(`║  Necesitás al menos 3 kills esta hora.`.padEnd(W + 2) + `║`);
  } else {
    const now = new Date();
    const minLeft = 59 - now.getUTCMinutes();
    lines.push(`║  ⚔️  ${champ.username}`.padEnd(W + 2) + `║`);
    lines.push(`║  Kills esta hora: ${champ.hourly_kills}`.padEnd(W + 2) + `║`);
    lines.push(`║  Nivel: ${champ.level || 1}`.padEnd(W + 2) + `║`);
    lines.push(`╠${'═'.repeat(W)}╣`);
    lines.push(`║  El título se renueva en ${minLeft} min.`.padEnd(W + 2) + `║`);
  }
  lines.push(`╚${'═'.repeat(W)}╝`);
  return { text: lines.join('\n') };
}


/**
 * duel <jugador> — Retar a otro jugador en la misma sala a un duelo PvP
 */
function cmdDuel(player, targetName) {
  if (!targetName) {
    return { text: 'Indicá a quién querés retar. Ej: "duel Ana" o "duel maestro" en la Sala del Trono.' };
  }

  // DIS-543: Maestro de Combate en Sala del Trono — duelo simulado
  const tLowDuel = targetName.trim().toLowerCase();
  if (tLowDuel === 'maestro' || tLowDuel === 'maestro de combate' || tLowDuel === 'maestro combate') {
    if (player.current_room_id !== 9) {
      return { text: '⚔️ El Maestro de Combate solo acepta duelos en la Sala del Trono (sala 9). Hablar con él primero: "hablar maestro".' };
    }
    return _cmdDuelMaestro(player);
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
    expiresAt: Date.now() + 60000,
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
 * DIS-543: _cmdDuelMaestro — Duelo simulado contra el Maestro de Combate en sala 9.
 */
function _cmdDuelMaestro(player) {
  player = db.getPlayer(player.id);
  if (player.hp < player.max_hp * 0.3) {
    return { text: '⚔️ El Maestro de Combate te mira y frunce el ceño.\n\n"No. No en ese estado." Señala tu HP. "Curate antes de venir a pelear. Un duelo no es suicidio."\n\nTiene razón.' };
  }

  // BUG-564: escalar al nivel del jugador pero ligeramente por DEBAJO en ATK/DEF
  // para que la pelea sea 70-30 a favor del jugador, no 14 rounds imposibles
  const playerAtk = player.attack || 5;
  const playerDef = player.defense || 2;
  const maestroMaxHp = player.max_hp;                            // igual HP que el jugador
  const maestroAtk = Math.max(3, Math.round(playerAtk * 0.85)); // 85% del ataque del jugador
  const maestroDef = Math.max(1, Math.round(playerDef * 0.75)); // 75% defensa — jugador puede hacer daño real

  const lines = [];
  lines.push('⚔️ El Maestro de Combate asiente lentamente y desenfunda.');
  lines.push('\n"Bien. Sin trucos, sin venenos. Solo acero y voluntad. Empecemos."\n');
  lines.push(`📊 Maestro: ${maestroMaxHp}/${maestroMaxHp} HP | ATK ${maestroAtk} | DEF ${maestroDef}`);
  lines.push(`📊 Vos:     ${player.hp}/${player.max_hp} HP | ATK ${player.attack} | DEF ${player.defense}\n`);

  let playerHp = player.hp;
  let maestroHp = maestroMaxHp;
  let round = 0;
  const MAX_ROUNDS = 20;
  let playerWon = false;

  while (playerHp > 0 && maestroHp > 0 && round < MAX_ROUNDS) {
    round++;
    const playerDmg = Math.max(1, playerAtk - maestroDef + Math.floor(Math.random() * 4));
    maestroHp -= playerDmg;
    lines.push(`Round ${round}: Atacás → ${playerDmg} dmg al Maestro (${Math.max(0, maestroHp)}/${maestroMaxHp} HP)`);
    if (maestroHp <= 0) { playerWon = true; break; }
    const maestroDmg = Math.max(1, maestroAtk - playerDef + Math.floor(Math.random() * 3));
    playerHp -= maestroDmg;
    lines.push(`       ↩ Maestro contraataca → ${maestroDmg} dmg (${Math.max(0, playerHp)}/${player.max_hp} HP)`);
    if (playerHp <= 0) break;
  }

  lines.push('');
  if (playerWon) {
    lines.push(`🏆 ¡Derrotaste al Maestro de Combate en ${round} rounds!`);
    lines.push('\n"Bien." Recoge la espada con calma. "Buscá un rival humano para el verdadero desafío."');
  } else if (playerHp <= 0) {
    lines.push(`💀 El Maestro te dejó fuera de combate en ${round} rounds.`);
    lines.push('\n"La derrota en el entrenamiento vale más que la victoria en la ignorancia. Volvé cuando estés listo."');
  } else {
    lines.push(`⏱ Duelo detenido tras ${round} rounds (empate técnico).`);
    lines.push('\n"Estás listo para un duelo real. Buscá otro jugador con \'duel <nombre>\'."');
  }

  lines.push('\n📖 Tutorial: "duel <nombre>" para retar a otro jugador | "accept" para aceptar un reto | "decline" para rechazar');
  // El HP real del jugador NO cambia — es solo simulación
  return { text: lines.join('\n') };
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
    // T236: texto evocador para duelo
    db.logGlobalEvent('duel', `⚔️ ${winner.username} y ${loser.username} midieron fuerzas en el dungeon. Solo uno caminó después.`);

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
    // BUG-516: si el argumento coincide con el nombre de un resultado de receta,
    // mostrar sugerencia con los ingredientes en lugar del error genérico
    const rawInput = args.join(' ').toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const matchingRecipe = crafting.RECIPES.find(r => {
      const norm = r.result.toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      return norm === rawInput;
    });
    if (matchingRecipe) {
      const [ing1, ing2] = matchingRecipe.ingredients;
      return { text: `Para craftear "${matchingRecipe.result}" necesitás dos ingredientes.\n💡 Receta: ${ing1} + ${ing2} → ${matchingRecipe.result}\nUsá: craft ${ing1} con ${ing2}` };
    }
    return { text: 'No entendí la sintaxis. Usá:\n  craft <ítem1> con <ítem2>\n  craft <ítem1> + <ítem2>\nEjemplo: craft hierba curativa con poción menor' };
  }

  const [itemA, itemB] = parsed;
  const craftResult = crafting.craft(player, itemA, itemB);

  if (!craftResult.ok) {
    return { text: craftResult.text };
  }

  // Consumir los ítems del inventario
  // BUG-463: normalizar con NFD para que tildes no impidan encontrar el ítem
  const nfn = s => s.toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const inv = [...player.inventory];
  const normalA = nfn(itemA);
  const normalB = nfn(itemB);

  // Remover primer ocurrencia de A
  const idxA = inv.findIndex(i => nfn(i) === normalA);
  if (idxA !== -1) inv.splice(idxA, 1);

  // Remover primer ocurrencia de B (excluyendo el hueco de A)
  const idxB = inv.findIndex(i => nfn(i) === normalB);
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

// DIS-D23: ítems especiales con alta probabilidad en salas con trampa
// (facilita obtener el ítem de desactivación)
const ROOM_FORAGE_BONUS = {
  6:  { item: 'hongo azul',       prob: 0.45 },  // Túnel de los Hongos — desactiva trampa esporas
  9:  { item: 'corona rota',      prob: 0.45 },  // Sala del Trono — desactiva trampa fría
  11: { item: 'fragmento de hielo', prob: 0.15 }, // DIS-D34 → DIS-D421: bajado de 0.35 a 0.15 para que el crafteo de lanza espectral no sea trivial
  13: { item: 'red de pesca',     prob: 0.45 },  // Caverna Sumergida — desactiva trampa inundación
};

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

  // T242: Quest narrativa con Aldric — carta sellada en sala 8 si quest activa
  if (player.current_room_id === 8 && (player.aldric_quest || 'none') === 'active') {
    const invCheck = Array.isArray(player.inventory) ? player.inventory : JSON.parse(player.inventory || '[]');
    if (!invCheck.some(i => i.toLowerCase().includes('carta sellada'))) {
      // Dar la carta, con cooldown normal
      let fData = {};
      try { fData = JSON.parse(player.forage_data || '{}'); } catch (_) {}
      fData[String(player.current_room_id)] = Date.now();
      const newInv = [...invCheck, 'carta sellada'];
      db.updatePlayer(player.id, { inventory: JSON.stringify(newInv), forage_data: JSON.stringify(fData) });
      return { text: 'Buscás entre las grietas de la celda más antigua de la Prisión...\n\n📜 Encontrás, debajo de una piedra suelta: un sobre sellado con cera negra. El símbolo de las dos llaves cruzadas. La cera está intacta.\n\n"Para quien llegue después. Perdoname."\n\nLa carta sellada se agrega a tu inventario. Aldric te la pidió. Sin abrirla.' };
    }
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

  // DIS-D23: salas con trampa tienen bonus de forage del ítem desactivador
  const roomBonus = ROOM_FORAGE_BONUS[player.current_room_id];
  if (roomBonus && roll < roomBonus.prob) {
    // Alta prob de encontrar el ítem de trampa en la sala correspondiente
    const bonusItem = roomBonus.item;
    // BUG-340: parsear inventory correctamente (puede ser string JSON o array)
    const invForBonus = Array.isArray(player.inventory)
      ? player.inventory
      : JSON.parse(player.inventory || '[]');
    const inv2 = [...invForBonus, bonusItem];
    db.updatePlayer(player.id, { inventory: JSON.stringify(inv2) });
    const bonusCr = db.updateDailyChallengeProgress(player.id, 'forage', null);
    let bonusChalMsg = '';
    if (bonusCr && bonusCr.reward) bonusChalMsg = `\n🏆 ¡DESAFÍO DIARIO COMPLETADO! +30 XP · +20 🪙 · +5 Reputación`;
    const freshBonus = db.getPlayer(player.id);
    const qBonusResult = quests.recordProgress(freshBonus, 'pick', { itemName: bonusItem });
    if (qBonusResult) db.updatePlayer(player.id, { quest_progress: qBonusResult.questProgress });
    const intro2 = [`Buscás con cuidado entre las grietas de ${room.name}...`, `Revisás los rincones de ${room.name}...`];
    // DIS-452: mensaje específico por sala para conectar el ítem con la trampa
    const FORAGE_TRAP_MSG = {
      6:  `Buscás entre los hongos del suelo y encontrás uno que no brilla como los demás: azul oscuro, sin luz, con olor neutralizante.`,
      9:  `Entre los escombros del trono encontrás un fragmento de corona decorativa. Parece que tiene algún significado para este lugar.`,
    };
    const forageIntroMsg = FORAGE_TRAP_MSG[player.current_room_id] || intro2[Math.floor(Math.random() * intro2.length)];
    return {
      text: `${forageIntroMsg}\n🌿 ¡Encontrás: ${bonusItem}! (Ítem para desactivar la trampa de esta sala.) Se agrega a tu inventario.${bonusChalMsg}`,
      event: null,
    };
  }

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
      const questNewXp = (freshQ2.xp || 0) + r.xp;
      const questNewLevel = xpSystem.levelFromXp(questNewXp);
      const questLevelUp = questNewLevel > (freshQ2.level || 1);
      db.updatePlayer(player.id, { gold: (freshQ2.gold || 0) + r.gold, xp: questNewXp, level: questNewLevel });
      questLine = `\n\n🎉 ¡Quest completada! Recibís ${r.gold}g y ${r.xp} XP.${questLevelUp ? ` ✨ ¡SUBÍS AL NIVEL ${questNewLevel}!` : ''}`;
      // T236: texto evocador para quest completada (segunda ocurrencia)
      db.logGlobalEvent('quest', `📜 ${player.username} completó el contrato de caza. El dungeon lo recuerda.`);
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
 *
 * DIS-450: Para el Mago, meditar tiene un comportamiento diferente:
 * recupera 25% del max_mana (foco en maná) con cooldown de 45 segundos.
 * Es la habilidad de clase icónica del Mago — concentrarse para restaurar energía mágica.
 */
function cmdMeditate(player) {
  player = db.getPlayer(player.id);

  // Sin monstruos en la sala
  const monsters = db.getMonstersInRoom(player.current_room_id);
  if (monsters.length > 0) {
    const names = monsters.map(m => m.name).join(', ');
    return { text: `⚔️  No podés meditar con enemigos presentes: ${names}.` };
  }

  // DIS-450: Comportamiento especial para Mago — meditar recupera maná, no HP
  const clsData = classes.getPlayerClass(player);
  if (clsData && clsData.name === 'Mago') {
    const curMana = player.mana != null ? player.mana : 0;
    const maxMana = player.max_mana || 20;

    if (curMana >= maxMana) {
      return { text: '🔮 Tu mente ya está completamente en foco. El maná fluye libre.' };
    }

    // Cooldown: 45 segundos (más corto que el de HP — el Mago necesita maná para funcionar)
    const MAGO_MEDITATE_CD = 30000; // DIS-493: bajado de 45s a 30s
    if (player.last_meditate) {
      const elapsed = Date.now() - new Date(player.last_meditate).getTime();
      if (elapsed < MAGO_MEDITATE_CD) {
        const remaining = Math.ceil((MAGO_MEDITATE_CD - elapsed) / 1000);
        return { text: `🔮 Tu mente aún está agitada por la concentración anterior. Esperá ${remaining} segundo${remaining !== 1 ? 's' : ''}.` };
      }
    }

    // Recuperar 25% del max_mana (mínimo 3)
    const manaRestore = Math.max(3, Math.floor(maxMana * 0.25));
    const newMana = Math.min(maxMana, curMana + manaRestore);
    const restored = newMana - curMana;

    db.updatePlayer(player.id, {
      mana: newMana,
      last_meditate: new Date().toISOString(),
    });

    const manaBar = buildBar(newMana, maxMana, 20);
    const petLine = player.pet
      ? `\nTu ${player.pet} se sienta en silencio a tu lado, amplificando la calma.`
      : '';
    return {
      text: `🔮 Cerrás los ojos y concentrás tu energía interior. La magia fluye desde el núcleo de tu ser hacia tus manos.${petLine}\n+${restored} maná restaurado. ${manaBar} ${newMana}/${maxMana} 🔮\n💡 (Cooldown: 30s. Mientras meditás no podés moverte — aprovechá para planificar tu próximo hechizo.)`,
    };
  }

  // Comportamiento original para no-Magos: recuperar HP
  if (player.hp >= player.max_hp) {
    return { text: '🧘 Ya estás al máximo de HP. No necesitás meditar.' };
  }

  // Cooldown propio (90 segundos, independiente de rest)
  const COOLDOWN_MS = 90000;
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

// ─── DIS-D48: Cuenco Sagrado de la Capilla ───────────────────────────────────

/**
 * ofrenda / cuenco / bowl — Beber del Cuenco Sagrado en la Capilla Olvidada (sala 5).
 *
 * Recupera 40% del HP máximo. Cooldown PERSONAL de 5 minutos.
 * Es la alternativa de mid-dungeon a la Fuente Eterna (sala 18).
 */
function cmdChapelBowl(player) {
  player = db.getPlayer(player.id);

  if (player.current_room_id !== CHAPEL_ROOM_ID) {
    return { text: '🙏 No hay ningún cuenco aquí.\n   El Cuenco Sagrado se encuentra en la Capilla Olvidada (sala 5).' };
  }

  if (player.hp >= player.max_hp) {
    return { text: '🙏 Ya estás al máximo de HP. El cuenco brilla en silencio, pero no lo necesitás ahora.' };
  }

  // Verificar cooldown personal
  const now = Date.now();
  const lastUsed = chapelBowlCooldowns.get(player.id) || 0;
  if (now - lastUsed < CHAPEL_BOWL_COOLDOWN_MS) {
    const remaining = Math.ceil((CHAPEL_BOWL_COOLDOWN_MS - (now - lastUsed)) / 1000);
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    const timeStr = mins > 0
      ? `${mins} minuto${mins !== 1 ? 's' : ''} y ${secs}s`
      : `${secs} segundo${secs !== 1 ? 's' : ''}`;
    return { text: `🙏 El cuenco está vacío. El agua sagrada necesita tiempo para purificarse.\n   Disponible en: ${timeStr}.` };
  }

  // Usar el cuenco — recupera 40% del max_hp
  const healAmount = Math.floor(player.max_hp * 0.40);
  const newHp = Math.min(player.max_hp, player.hp + healAmount);
  const restored = newHp - player.hp;

  // BUG-264: si el jugador recibiría menos del 50% del potencial del cuenco,
  // no consumir el cooldown — el cuenco no "se vacía" por una herida mínima.
  if (restored < Math.ceil(healAmount * 0.5)) {
    return {
      text: `🙏 Te inclinás sobre el cuenco, pero el agua apenas pulsa.\nEl cuenco te daría solo +${restored} HP (de los ${healAmount} que puede dar). No lo desperdicies con tan poca herida.\n💡 Volvé cuando estés más herido. El cooldown no se consumió.`,
    };
  }

  db.updatePlayer(player.id, { hp: newHp });
  chapelBowlCooldowns.set(player.id, now);

  const hpBar = buildBar(newHp, player.max_hp, 20);

  // DIS-479: logro "Gracia de la Capilla" — usar el cuenco sagrado
  const freshForBowlAch = db.getPlayer(player.id);
  const bowlAchs = ach.checkAchievements(freshForBowlAch, { bowlUsed: true });
  const bowlAchLines = bowlAchs.length > 0
    ? '\n' + bowlAchs.map(a => `🏆 ¡Logro desbloqueado: ${a.icon} ${a.name}! — ${a.desc}`).join('\n')
    : '';

  return {
    text: `🙏 Te acercás al cuenco de piedra negra y tomás el agua fría con ambas manos.\nEl líquido sabe a tierra y a algo más antiguo. Una calidez lenta sube por tu pecho.\n+${restored} HP restaurado (${healAmount} de potencial, ${player.max_hp - newHp > 0 ? `cap en ${player.max_hp} HP máx` : 'curación completa'}).\n${hpBar} ${newHp}/${player.max_hp} HP\n\n⏳ El cuenco tardará 5 minutos en llenarse de nuevo.${bowlAchLines}`,
    event: `${player.username} bebe del Cuenco Sagrado. El agua brilla un instante y desaparece.`,
    eventRoomId: CHAPEL_ROOM_ID,
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

  // BUG-311: si no hay args o el primer arg es "listar/list/ver/subastas/remates", mostrar las subastas activas
  // (funciona desde cualquier sala, igual que el comando 'remates')
  if (!args || args.length === 0 ||
      ['listar', 'list', 'ver', 'subastas', 'remates', 'ver subastas', 'listado', 'all', 'todas'].includes(args[0].toLowerCase())) {
    return cmdAuctions();
  }

  if (player.current_room_id !== AUCTION_ROOM_ID) {
    return { text: '🔨 Solo podés subastar desde la Casa de Subastas (sala 17).\n  Movete al este desde la Cámara del Tesoro (sala 4).\n\n🔍 Para ver subastas activas usá: remates' };
  }

  if (args.length < 2) {
    return { text: 'Uso: subasta <ítem> <precio_mínimo>\nEjemplo: subasta espada 10\n\nPodés poner cualquier ítem de tu inventario a subasta.\nLa duración del remate es de 5 minutos.' };
  }

  // El último argumento es el precio, el resto es el nombre del ítem
  const priceArg = args[args.length - 1];
  const minPrice = parseInt(priceArg, 10);
  if (isNaN(minPrice) || minPrice < 1) {
    // DIS-D379: si el último argumento no es un número, el jugador probablemente
    // escribió el nombre del ítem sin precio — mostrar ayuda en lugar de error confuso
    if (isNaN(minPrice)) {
      return { text: `🔨 Falta el precio mínimo.\nUso: subastar <ítem> <precio_mínimo>\nEjemplo: subastar "${args.join(' ')}" 15\n\nEl precio debe ser un número mayor a 0.` };
    }
    return { text: `Precio inválido: "${priceArg}". Debe ser un número mayor a 0.\nEjemplo: subasta "poción de salud" 15` };
  }

  const itemName = args.slice(0, -1).join(' ').toLowerCase().trim();
  const inventory = player.inventory || [];
  let itemIndex = inventory.findIndex(i => i.toLowerCase() === itemName);

  // DIS-D359: si no está en inventario, verificar si está equipado
  let unequipMsg = '';
  if (itemIndex === -1) {
    const isWeapon = player.equipped_weapon && player.equipped_weapon.toLowerCase() === itemName;
    const isArmor  = player.equipped_armor  && player.equipped_armor.toLowerCase()  === itemName;
    if (isWeapon) {
      // Des-equipar arma
      const updates = { equipped_weapon: null };
      const defWeapon = items.getItemDef(player.equipped_weapon);
      if (defWeapon) {
        player.attack = Math.max(1, (player.attack || 5) - (defWeapon.amount || 0));
        updates.attack = player.attack;
      }
      player.equipped_weapon = null;
      db.updatePlayer(player.id, updates);
      inventory.push(itemName);
      itemIndex = inventory.length - 1;
      unequipMsg = `\n⚠️ Se desequipó \"${itemName}\" automáticamente para subastarla.`;
    } else if (isArmor) {
      // Des-equipar armadura
      const updates = { equipped_armor: null };
      const defArmor = items.getItemDef(player.equipped_armor);
      if (defArmor) {
        player.defense = Math.max(2, (player.defense || 2) - (defArmor.amount || 0));
        updates.defense = player.defense;
      }
      player.equipped_armor = null;
      db.updatePlayer(player.id, updates);
      inventory.push(itemName);
      itemIndex = inventory.length - 1;
      unequipMsg = `\n⚠️ Se quitó \"${itemName}\" automáticamente para subastarla.`;
    } else {
      return { text: `No tenés "${itemName}" en el inventario.\nUsá "inventario" para ver tus ítems.` };
    }
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
    text: `🔨 ¡Subasta iniciada!${unequipMsg}\n  Ítem: ${itemName}\n  Precio mínimo: ${minPrice}g\n  ID de subasta: #${auction.id}\n  Cierra en: 5 minutos\n\nOtros jugadores pueden pujar con: pujar ${auction.id} <monto>`,
    globalEvent: `📣 ¡SUBASTA! ${player.username} pone "${itemName}" a la venta. Precio mínimo: ${minPrice}g. (ID #${auction.id}) — Usá: pujar ${auction.id} <monto>`,
  };
}

/**
 * subastas — listar subastas activas.
 */
function cmdAuctions() {
  const auctions = db.getActiveAuctions();
  // DIS-535: mostrar también ítems en mercado pasivo
  const passiveAuctions = db.getActivePassiveAuctions ? db.getActivePassiveAuctions() : [];

  if (auctions.length === 0 && passiveAuctions.length === 0) {
    // DIS-500: mostrar último ítem subastado para dar vida a la sala vacía
    const recent = db.getRecentClosedAuctions(1);
    let historyLine = '';
    if (recent && recent.length > 0) {
      const last = recent[0];
      const soldFor = last.current_bid > 0 ? `${last.current_bid}g` : 'sin pujas';
      const soldTo = last.bidder_name ? `a ${last.bidder_name}` : '(sin comprador)';
      historyLine = `\n\n📋 Último ítem subastado: **${last.item_name}** — ${soldFor} ${soldTo}`;
    }
    return { text: `🔨 No hay subastas activas en este momento.${historyLine}\n\nPodés crear una con: subasta <ítem> <precio_mínimo>\n(Debés estar en la Casa de Subastas, sala 17, al este de la sala 4)` };
  }

  const lines = auctions.map(a => {
    const timeLeft = formatTimeLeft(a.ends_at);
    const bidInfo = a.current_bid > 0
      ? `Puja actual: ${a.current_bid}g (${a.bidder_name})`
      : `Sin pujas (mín: ${a.min_price}g)`;
    return `  #${a.id} | ${a.item_name} | ${bidInfo} | ⏳ ${timeLeft} | Vendedor: ${a.seller_name}`;
  });

  // DIS-535: líneas de mercado pasivo
  const passiveLines = passiveAuctions.map(a => {
    const timeLeft = formatTimeLeft(a.ends_at);
    const merchantPrice = Math.max(1, Math.floor(a.min_price * 0.5));
    return `  🛒 ${a.item_name} | En mercado pasivo — Mercader comprará por ${merchantPrice}g en ⏳ ${timeLeft} | De: ${a.seller_name}`;
  });

  const allLines = [...lines, ...passiveLines];
  const totalCount = auctions.length + passiveAuctions.length;

  return {
    text: `🔨 Subastas activas (${auctions.length}) + mercado pasivo (${passiveAuctions.length}):\n\n${allLines.join('\n')}\n\nPara pujar: pujar <id> <monto>  |  Para detalle: help subasta`,
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
        const winnerInv = Array.isArray(winner.inventory) ? winner.inventory : JSON.parse(winner.inventory || '[]');
        winnerInv.push(auction.item_name);
        db.updatePlayer(winner.id, { inventory: JSON.stringify(winnerInv) });
      }
      if (seller) {
        db.updatePlayer(seller.id, { gold: (seller.gold || 0) + auction.current_bid });
      }

      const msg = `🔨 ¡REMATE CERRADO! "${auction.item_name}" vendida por ${auction.current_bid}g. Ganador: ${auction.bidder_name}. Vendedor: ${auction.seller_name} recibe ${auction.current_bid}g.`;
      messages.push(msg);
      if (broadcastFn) broadcastFn(msg);

    } else if (auction.is_passive) {
      // DIS-535: Subasta PASIVA expirada sin postor → El Mercader la compra garantizado al 50%
      const seller = db.getPlayer(auction.seller_id);
      const merchantPrice = Math.max(1, Math.floor(auction.min_price * 0.5));
      if (seller) {
        db.updatePlayer(seller.id, { gold: (seller.gold || 0) + merchantPrice });
        db.addJournalEntry(seller.id, 'system', `🛒 El Mercader compró "${auction.item_name}" del mercado pasivo por ${merchantPrice}g. El dinero está en tu bolsa.`);
      }
      const msg = `🛒 Mercado pasivo: El Mercader compró "${auction.item_name}" de ${auction.seller_name} por ${merchantPrice}g (50% precio base).`;
      messages.push(msg);
      if (broadcastFn) broadcastFn(msg);

    } else {
      // Sin pujas en subasta normal: crear subasta pasiva de 30 min (DIS-535)
      // El Escriba Elfo registra el ítem para venta al Mercader
      const seller = db.getPlayer(auction.seller_id);
      db.createPassiveAuction(auction.seller_id, auction.seller_name, auction.item_name, auction.min_price);
      if (seller) {
        db.addJournalEntry(seller.id, 'system', `🔨 La subasta de "${auction.item_name}" cerró sin postores. El Escriba Elfo lo puso en el mercado pasivo — el Mercader lo comprará en 30 min por ${Math.max(1, Math.floor(auction.min_price * 0.5))}g si nadie puja.`);
      }
      const msg = `🔨 Subasta sin pujas: "${auction.item_name}" de ${auction.seller_name} pasa al mercado pasivo (venta al Mercader en 30 min a 50%).`;
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
  'rayo': {
    cost: 12,
    type: 'damage',
    amount: 15,
    description: 'Invoca un rayo de tormenta. 15 de daño y 25% de probabilidad de aturdir al objetivo.',
    aliases: ['lightning', 'thunder', 'trueno', 'relámpago', 'relampago', 'rayo_de_tormenta'],
    icon: '⚡',
    stun_chance: 0.25,  // T214: 25% de chance de aturdir
  },
  // DIS-D29: hechizo de escarcha para que las debilidades al frío sean explotables
  'escarcha': {
    cost: 7,
    type: 'damage',
    amount: 10,
    description: 'Lanza una ráfaga de hielo. 10 de daño y 20% de probabilidad de ralentizar al objetivo (pierde su turno).',
    aliases: ['frost', 'hielo', 'ice', 'frío', 'frio', 'ráfaga de hielo', 'rafaga de hielo'],
    icon: '❄️',
    slow_chance: 0.20,  // 20% de chance de ralentizar (skip turno del monstruo)
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
  // T107 + DIS-D293 + DIS-D306: Mago regenera 6 maná/minuto (vs 1/min base)
  // Historial: 1/min base → 2/min → 4/min → 6/min
  // Con 35 de maná máx y hechizos de 8-12, a 4/min el mago se quedaba sin maná en mid-game.
  // A 6/min recarga completo en ~6 min, viable en sesión de 10-15 min.
  const clsData = classes.getPlayerClass(player);
  let regenRate = (clsData && clsData.name === 'Mago') ? 6 : 1;
  // DIS-576: la vara de energía equipada da +2 maná/min de regen extra al Mago
  if (clsData && clsData.name === 'Mago' && player.equipped_weapon === 'vara de energía') {
    regenRate += 2; // 6 → 8 maná/min con vara equipada
  }
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
 * DIS-D326: Regeneración pasiva de HP — 1 HP/minuto fuera de combate.
 * Se llama junto con regenMana en los puntos de entrada de comandos.
 * No actúa si el jugador ya está al máximo.
 * @param {object} player — objeto jugador fresco de la DB
 * @returns {object} jugador actualizado
 */
function regenHp(player) {
  const currentHp = player.hp != null ? player.hp : 30;
  const maxHp = player.max_hp || 30;

  if (currentHp >= maxHp) return player;

  const now = Date.now();
  const lastRegen = player.last_hp_regen ? new Date(player.last_hp_regen).getTime() : 0;
  const minutesPassed = (now - lastRegen) / 60000;

  // 1 HP/minuto base (pasivo lento, para no trivializar la curación)
  const hpGained = Math.floor(minutesPassed * 1);
  if (hpGained <= 0) return player;

  const newHp = Math.min(maxHp, currentHp + hpGained);
  db.updatePlayer(player.id, {
    hp: newHp,
    last_hp_regen: new Date().toISOString(),
  });

  return { ...player, hp: newHp, last_hp_regen: new Date().toISOString() };
}

/**
 * Encuentra un hechizo por nombre o alias.
 * @param {string} query
 * @returns {{ key: string, spell: object }|null}
 */
function findSpell(query) {
  // BUG-007 fix: normalizar tildes/acentos con NFD (misma familia que DIS-P15)
  // BUG-048 fix: normalizar guiones a espacios ("bola-de-fuego" → "bola de fuego")
  const normalize = s => s.toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/-/g, ' ');
  const q = normalize(query);
  for (const [key, spell] of Object.entries(SPELL_CATALOG)) {
    if (normalize(key) === q || spell.aliases.some(a => normalize(a) === q) || normalize(key).startsWith(q)) {
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
  // Intentar encontrar el hechizo probando prefijos de args (de más largo a más corto)
  let found = null;
  let targetArgIndex = args.length; // índice desde donde empieza el objetivo
  for (let i = args.length; i >= 1; i--) {
    const attempt = args.slice(0, i).join(' ').toLowerCase().trim();
    const f = findSpell(attempt);
    if (f) {
      found = f;
      targetArgIndex = i;
      break;
    }
  }
  if (!found) {
    // Fallback: intentar con todos los args
    const spellQuery = args.join(' ').toLowerCase().trim();
    found = findSpell(spellQuery);
  }

  if (!found) {
    return {
      text: `🪄 No conocés ese hechizo. Usá "hechizos" para ver los disponibles.`,
    };
  }

  const { key: spellName, spell } = found;

  // Verificar maná suficiente
  // DIS-558: Si tiene free_spell activo, no verificar ni cobrar maná
  const freshForFreeSp = db.getPlayer(player.id);
  const seForFreeSp = parseSE(freshForFreeSp.status_effects);
  const hasFreeSpell = seForFreeSp['free_spell'] === true;

  if (!hasFreeSpell && currentMana < spell.cost) {
    return {
      text: `🪄 No tenés maná suficiente para ${spell.icon} ${spellName}.\n   Necesitás ${spell.cost} maná, tenés ${currentMana}/${maxMana}.\n   Esperá que se recargue (${(() => { const c = classes.getPlayerClass(player); return (c && c.name === 'Mago') ? 6 : 1; })()}\u00a0maná/minuto) o usá una poción de maná.`,
    };
  }

  const monsters = db.getMonstersInRoom(player.current_room_id);
  let lines = [];
  // DIS-558: Si free_spell está activo, no deducir maná; consumir el flag
  let newMana = hasFreeSpell ? currentMana : currentMana - spell.cost;
  if (hasFreeSpell) {
    const seFS = parseSE(freshForFreeSp.status_effects);
    delete seFS['free_spell'];
    db.updatePlayer(player.id, { status_effects: JSON.stringify(seFS) });
    lines.push('✨ (Hechizo gratuito activado — sin coste de maná)');
  }
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
    if (args.length > targetArgIndex) {
      const targetQuery = args.slice(targetArgIndex).join(' ').toLowerCase();
      const matched = monsters.find(m => m.name.toLowerCase().includes(targetQuery));
      if (matched) target = matched;
    } else if (args.length > 1) {
      // Fallback para compatibilidad
      const targetQuery = args.slice(1).join(' ').toLowerCase();
      const matched = monsters.find(m => m.name.toLowerCase().includes(targetQuery));
      if (matched) target = matched;
    }

    const dmg = spell.amount;
    // T107: Mago tiene spell_power 1.5 (hechizos hacen 50% más daño)
    const playerCls = classes.getPlayerClass(player);
    const spellPower = playerCls ? (playerCls.spell_power || 1.0) : 1.0;
    // DIS-562: Resistencia mágica para bosses/élites — reducen el daño mágico al 65%
    // Afecta a criaturas físicas/pétricas que resistirían la magia
    const MAGIC_RESISTANT_MONSTERS = ['gólem', 'golem', 'guardia espectral', 'elemental', 'lich'];
    const targetNameLow = target.name.toLowerCase().replace('⭐ ', '');
    const hasMagicResist = MAGIC_RESISTANT_MONSTERS.some(n => targetNameLow.includes(n));
    const magicResist = hasMagicResist ? 0.65 : 1.0;
    const finalDmg = Math.max(1, Math.round(dmg * spellPower * magicResist));
    const newHp = Math.max(0, target.hp - finalDmg);
    db.updatePlayer(player.id, { mana: newMana, last_mana_regen: player.last_mana_regen || new Date().toISOString() });

    lines.push(`🪄 Lanzás ${spell.icon} **${spellName}** sobre ${target.name}!`);
    const magicResistNote = hasMagicResist ? ` 🛡️ (resistencia mágica: ×${magicResist})` : '';
    const dmgNote = spellPower > 1.0 ? ` (${dmg}×${spellPower} daño mágico de Mago${magicResistNote})` : magicResistNote;
    lines.push(`   ${target.name} recibe ${finalDmg} puntos de daño mágico.${dmgNote} (HP: ${target.hp} → ${newHp})`);

    // T214: stun_chance — hechizos que pueden aturdir al monstruo (ej: rayo)
    if (spell.stun_chance && newHp > 0 && Math.random() < spell.stun_chance) {
      // Aplicar aturdimiento guardando en status_effects del monstruo
      try {
        const mStatus = JSON.parse(target.status_effects || '{}');
        mStatus.stunned = 1;  // dura 1 turno
        db.updateMonster(target.id, { status_effects: JSON.stringify(mStatus) });
        lines.push(`   ⚡ ¡${target.name} quedó aturdido por el rayo! (pierde su próximo turno de ataque)`);
      } catch (e) { /* silenciar errores de parseo */ }
    }

    // DIS-D29: slow_chance — escarcha puede ralentizar al monstruo
    if (spell.slow_chance && newHp > 0 && Math.random() < spell.slow_chance) {
      try {
        const mStatus2 = JSON.parse(target.status_effects || '{}');
        mStatus2.stunned = 1;  // ralentizar = skip 1 turno (mismo mecanismo que stun)
        db.updateMonster(target.id, { status_effects: JSON.stringify(mStatus2) });
        lines.push(`   ❄️ ¡${target.name} quedó ralentizado por el hielo! (pierde su próximo turno de ataque)`);
      } catch (e) { /* silenciar errores de parseo */ }
    }

    if (newHp <= 0) {
      // Monstruo muerto — BUG-041: db.killMonster no existe, usar updateMonster con respawn
      const PRACTICE_GOBLIN_ID = 20;
      const isBossSpell = combat.BOSS_MONSTERS && combat.BOSS_MONSTERS[target.id];
      const respawnMinutesSpell = isBossSpell ? (combat.BOSS_MONSTERS[target.id].respawnMinutes || 30) : 5;
      const respawnAtSpell = target.id === PRACTICE_GOBLIN_ID
        ? new Date(Date.now() + 30 * 1000).toISOString()
        : new Date(Date.now() + respawnMinutesSpell * 60 * 1000).toISOString();
      db.updateMonster(target.id, {
        hp: 0,
        room_id: null,
        respawn_at: respawnAtSpell,
        status_effects: '{}',
      });
      // BUG-336: Usar combat.dropLoot() igual que cmdAttack para evitar duplicación de ítems.
      // dropLoot ya tiene el fix de BUG-334 (limpia copias previas antes de agregar el nuevo loot).
      // BUG-553: Fix — la línea de código estaba pegada al comentario con \n literal, haciendo que castLoot fuera undefined.
      const { droppedLoot: castLoot } = combat.dropLoot(target, player.current_room_id);
      // BUG-533: alinear formato de muerte/drop/XP con el del ataque físico
      lines.push(`💀 ¡El ${target.name} cae derrotado!`);
      if (castLoot.length > 0) {
        lines.push(`💰 El ${target.name} suelta: ${castLoot.join(', ')}.`);
      } else {
        lines.push(`El ${target.name} no deja nada.`);
      }
      const loot = castLoot;
      // XP y kills
      const xpGain = Math.floor(5 + (target.max_hp || 10) / 2);
      const newKills = (player.kills || 0) + 1;
      const newXp = (player.xp || 0) + xpGain;
      const newLevel = xpSystem.levelFromXp(newXp);
      const castUpd = {
        kills: newKills,
        xp: newXp,
        level: newLevel,
      };
      if (newLevel > (player.level || 1)) {
        castUpd.max_hp = (player.max_hp || 30) + 5;
        const healCast = Math.ceil(castUpd.max_hp * 0.20);
        castUpd.hp = Math.min(castUpd.max_hp, (player.hp || 1) + healCast);
        castUpd.attack = (player.attack || 5) + 1;
        lines.push(`✨ ¡Subiste al nivel ${newLevel}! +5 HP máx, +1 ataque, +${healCast} HP restaurado.`);
      }
      db.updatePlayer(player.id, castUpd);
      lines.push(`⭐ +${xpGain} XP (kills: ${newKills} | nivel: ${newLevel})`);
      broadcastEvent = `🔥 ¡${player.username} incineró a ${target.name} con ${spellName}!`;
      // Bestiario
      db.addBestiaryKill(player.id, target.name);
      if (newLevel > (player.level || 1)) {
        db.addJournalEntry(player.id, 'level', `⬆️ Subiste al nivel ${newLevel} usando ${spellName}.`);
      }
      // BUG-044: evaluar logros al matar con hechizo (incluyendo boss_killer)
      const castBossKill = !!(combat.BOSS_MONSTERS && combat.BOSS_MONSTERS[target.id]);
      const castLichKill = target.id === 13; // solo el Lich Anciano real
      const freshForCastAch = db.getPlayer(player.id);
      if (freshForCastAch) {
        const newCastAchs = ach.checkAchievements(freshForCastAch, { bossKill: castLichKill });
        const castAchLines = ach.formatNewAchievements(newCastAchs);
        if (castAchLines) lines.push(castAchLines);
        if (castBossKill) {
          const bossGlobalEvent = `☠️ ¡${player.username} destruyó al ${target.name} con ${spellName}!`;
          db.logGlobalEvent('boss', bossGlobalEvent);
          db.addJournalEntry(player.id, 'boss', `☠️ Derrotaste al ${target.name} con ${spellName}.`);
          if (typeof io !== 'undefined' && io) io.emit('shout', { username: 'El Dungeon', message: bossGlobalEvent });
          lines.push(`\n╔════════════════════════════════════╗\n║  ☠️  ¡${target.name.toUpperCase()} DERROTADO!  ☠️  ║\n╚════════════════════════════════════╝\n¡Usá 'loot' para recoger los tesoros!`);
        }
        if (newCastAchs && newCastAchs.length > 0) {
          db.logGlobalEvent('achievement', `🏅 ${player.username} desbloqueó el logro "${newCastAchs[0].name}".`);
        }
      }
      // BUG-017: registrar progreso de desafío diario al matar con hechizo
      const crCast = db.updateDailyChallengeProgress(player.id, 'kill', target.name);
      if (crCast && crCast.reward) {
        lines.push(`   🏆 ¡DESAFÍO DIARIO COMPLETADO! +30 XP · +20 🪙 · +5 Reputación`);
      } else if (crCast && crCast.challenge && !crCast.challenge.done) {
        lines.push(`   📅 Desafío diario: ${crCast.challenge.desc} (${crCast.challenge.progress}/${crCast.challenge.goal})`);
      }
      // BUG-010: registrar progreso de quest al matar con hechizo
      const freshForCastQuest = db.getPlayer(player.id);
      const qCastResult = quests.recordProgress(freshForCastQuest, 'kill', { monsterName: target.name });
      // BUG-043: registrar progreso de contrato semanal al matar con hechizo
      const wcrCast = db.updateWeeklyContractProgress(player.id, target.name);
      if (wcrCast && wcrCast.reward) {
        lines.push(`   📜 ¡CONTRATO DE CAZA COMPLETADO! +${wcrCast.reward.xp} XP · +${wcrCast.reward.gold}g · Recibís: ${wcrCast.reward.item}`);
      } else if (wcrCast && wcrCast.contract && !wcrCast.contract.done) {
        lines.push(`   📜 Contrato semanal: ${wcrCast.contract.target} (${wcrCast.contract.progress}/${wcrCast.contract.goal})`);
      }
      if (qCastResult) {
        db.updatePlayer(player.id, { quest_progress: qCastResult.questProgress });
        if (qCastResult.justCompleted && qCastResult.reward) {
          const r = qCastResult.reward;
          const freshQ2 = db.getPlayer(player.id);
          const questNewXp = (freshQ2.xp || 0) + r.xp;
          const questNewLevel = xpSystem.levelFromXp(questNewXp);
          const questLevelUp = questNewLevel > (freshQ2.level || 1);
          db.updatePlayer(player.id, { gold: (freshQ2.gold || 0) + r.gold, xp: questNewXp, level: questNewLevel });
          lines.push(`   🎉 ¡Quest completada! Recibís ${r.gold}g y ${r.xp} XP de recompensa.${questLevelUp ? ` ✨ ¡SUBÍS AL NIVEL ${questNewLevel}!` : ''}`);
          db.addReputation(player.id, 5);
          db.logGlobalEvent('quest', `📜 ${player.username} completó la misión con ${spellName}.`);
          db.addJournalEntry(player.id, 'quest', `📜 Quest completada con ${spellName}: +${r.gold}g, +${r.xp} XP.`);
        } else if (qCastResult.newProgress) {
          const info = quests.getPlayerProgress(db.getPlayer(player.id));
          if (info && !info.completed) {
            lines.push(`   📜 Quest: ${qCastResult.newProgress}/${info.goal} — ¡Seguí así!`);
          }
        }
      }
    } else {
      db.updateMonster(target.id, { hp: newHp });
    }

    // BUG-462: el monstruo contraataca si sigue vivo tras el hechizo
    if (newHp > 0) {
      const freshPlayerCast = db.getPlayer(player.id);
      const monsterDmgCast = Math.max(1, (target.attack || 2) - Math.floor(freshPlayerCast.defense || 0));
      const shieldActiveCast = freshPlayerCast.shield_active || 0;
      let dmgToCast = monsterDmgCast;
      if (shieldActiveCast) {
        const absorbCast = 5;
        dmgToCast = Math.max(0, monsterDmgCast - absorbCast);
        db.updatePlayer(player.id, { shield_active: 0 });
        lines.push(`   🛡️ ¡Tu escudo mágico absorbe ${Math.min(absorbCast, monsterDmgCast)} puntos de daño! (${monsterDmgCast} → ${dmgToCast})`);
      }
      const freshHpAfterHit = db.getPlayer(player.id).hp;
      const newHpAfterHit = Math.max(0, freshHpAfterHit - dmgToCast);
      db.updatePlayer(player.id, { hp: newHpAfterHit });
      const freshMaxHpCast = freshPlayerCast.max_hp || 30;
      lines.push(`   🩸 ${target.name} contraataca: ${dmgToCast} de daño. (${newHpAfterHit}/${freshMaxHpCast} HP)`);
      if (newHpAfterHit <= 0) {
        combat.handlePlayerDeath(player.id, lines, target.name);
      }
    }

    lines.push(`   💧 Maná restante: ${newMana}/${maxMana}`);

  } else if (spell.type === 'heal') {
    // Hechizo de curación
    const maxHp = player.max_hp;
    // BUG-021: guard antes de consumir maná
    if (player.hp >= maxHp) {
      return { text: `🪄 Ya tenés el HP al máximo. Maná no consumido.` };
    }
    const newHp = Math.min(maxHp, player.hp + spell.amount);
    const healed = newHp - player.hp;

    db.updatePlayer(player.id, { hp: newHp, mana: newMana, last_mana_regen: player.last_mana_regen || new Date().toISOString() });

    lines.push(`🪄 Canalizás ${spell.icon} energía curativa...`);
    lines.push(`   Recuperás ${healed} HP. (${player.hp} → ${newHp}/${maxHp})`);
    lines.push(`   💧 Maná restante: ${newMana}/${maxMana}`);

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
    `(Recarga: ${(() => { const c = classes.getPlayerClass(player); return (c && c.name === 'Mago') ? 6 : 1; })()} maná/minuto. Pociones de maná restauran instantáneamente.)`,
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

  // Aplicar la clase — BUG-009 fix: preservar stats acumulados por level-ups.
  // Se toma Math.max(stat_clase, stat_actual) para que elegir clase nunca
  // reduzca HP/ATK/DEF/maná que el jugador ya ganó subiendo de nivel.
  const clsStats = classes.getClassStats(className);
  const freshForClass = db.getPlayer(player.id);
  const newMaxHp   = Math.max(clsStats.max_hp,   freshForClass.max_hp   || 30);
  const newAttack  = Math.max(clsStats.attack,    freshForClass.attack   || 5);
  const newDefense = Math.max(clsStats.defense,   freshForClass.defense  || 3);
  const newMaxMana = Math.max(clsStats.max_mana,  freshForClass.max_mana || 20);
  const newHp      = Math.min(freshForClass.hp || newMaxHp, newMaxHp);
  const newMana    = Math.min(freshForClass.mana || newMaxMana, newMaxMana);
  // DIS-491: Dar 10g de inicio al elegir clase por primera vez
  const isFirstClass = currentClass === 'sin_clase';
  const startingGold = isFirstClass ? (freshForClass.gold || 0) + 10 : (freshForClass.gold || 0);

  db.updatePlayer(player.id, {
    player_class: className,
    hp:       newHp,
    max_hp:   newMaxHp,
    attack:   newAttack,
    defense:  newDefense,
    mana:     newMana,
    max_mana: newMaxMana,
    gold:     startingGold,
  });

  const lines = [
    `✅ ¡Elegiste la clase ${clsStats.emoji} ${clsStats.name.toUpperCase()}!`,
    `   ${clsStats.description}`,
    ``,
    `📊 Tus nuevos stats:`,
    `   HP:     ${newHp}/${newMaxHp}`,
    `   ATK:    ${newAttack}   DEF: ${newDefense}`,
    `   Maná:   ${newMana}/${newMaxMana}`,
    ``,
    `🌟 Ventajas de clase:`,
    ...clsStats.perks.map(p => `   ▸ ${p}`),
  ];

  if (className === 'picaro') {
    lines.push(``, `💡 Como Pícaro tus golpes críticos son del 25% y esquivas el 20% de ataques.`);
  } else if (className === 'mago') {
    lines.push(``, `💡 Como Mago tus hechizos hacen 1.5× de daño y la recarga de maná es 6× más rápida.`);
  } else if (className === 'guerrero') {
    lines.push(``, `💡 Como Guerrero absorbés más daño y tenés mayor HP máximo.`);
  } else if (className === 'clerigo') {
    lines.push(``, `💡 Como Clérigo tu curación es 50% más potente y podés usar 'heal <jugador>' para sanar aliados en la sala.`);
  }

  // DIS-491: Mostrar oro inicial si es la primera clase
  if (isFirstClass) {
    lines.push(``, `🪙 Monedero inicial: +10 🪙 (suficiente para la primera poción de salud).`);
  }

  return { text: lines.join('\n') };
}

/**
 * DIS-496: cmdHeal — Comando exclusivo del Clérigo para sanar a aliados en la sala.
 * heal             → se auto-cura (15 HP base × heal_power)
 * heal <jugador>   → cura a ese jugador si está en la misma sala (10 HP base × heal_power)
 * Coste: 8 de maná
 */
function cmdHeal(player, args) {
  const fresh = db.getPlayer(player.id);
  if (!fresh) return { text: 'Error al leer tu personaje.' };

  const cls = fresh.player_class || 'sin_clase';
  if (cls !== 'clerigo') {
    return { text: `✨ El comando heal es exclusivo del Clérigo. Escribí "clase clerigo" para cambiar de clase (solo antes de 5 kills).` };
  }

  const mana = fresh.mana != null ? fresh.mana : 0;
  const manaCost = 8;
  if (mana < manaCost) {
    return { text: `✨ No tenés suficiente maná para curar. Necesitás ${manaCost} maná (tenés ${mana}).` };
  }

  const healPower = 1.5; // DIS-496: Clérigo cura 50% más
  const isSelf = !args || args.length === 0;

  if (isSelf) {
    // Auto-curación: 15 HP base × 1.5 = 22 HP
    const healBase = 15;
    const healAmt = Math.round(healBase * healPower);
    const newHp = Math.min(fresh.max_hp, (fresh.hp || 0) + healAmt);
    const newMana = mana - manaCost;
    db.updatePlayer(fresh.id, { hp: newHp, mana: newMana });
    return { text: `✨ Canalizás energía sagrada sobre tus heridas. +${newHp - (fresh.hp||0)} HP (${newHp}/${fresh.max_hp}) · -${manaCost} maná (${newMana}/${fresh.max_mana||30})` };
  }

  // Curar a aliado
  const targetName = args[0].toLowerCase();
  const playersInRoom = db.getPlayersInRoom(fresh.current_room_id).filter(p => p.id !== fresh.id);
  const target = playersInRoom.find(p => p.username.toLowerCase().startsWith(targetName));
  if (!target) {
    return { text: `✨ No encontrás a ${args[0]} en esta sala. Usá heal sin argumentos para curarte a vos mismo.` };
  }

  const tFresh = db.getPlayer(target.id);
  if (!tFresh) return { text: 'Error al leer al aliado.' };
  if (tFresh.hp >= tFresh.max_hp) {
    return { text: `✨ ${tFresh.username} ya está al máximo de HP (${tFresh.max_hp}/${tFresh.max_hp}). Heal cancelado.` };
  }

  const healBase = 10;
  const healAmt = Math.round(healBase * healPower);
  const newTargetHp = Math.min(tFresh.max_hp, (tFresh.hp || 0) + healAmt);
  const healed = newTargetHp - (tFresh.hp || 0);
  const newMana = mana - manaCost;
  db.updatePlayer(fresh.id, { mana: newMana });
  db.updatePlayer(tFresh.id, { hp: newTargetHp });

  return { text: `✨ Extendés las manos hacia ${tFresh.username} y channelás luz sanadora. +${healed} HP a ${tFresh.username} (${newTargetHp}/${tFresh.max_hp}) · -${manaCost} maná (${newMana}/${fresh.max_mana||30})` };
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
  const maxKills = Math.max(...entries.map(e => e.kills), 1);
  // Escalar la barra relativa al máximo de kills del jugador (mínimo 5 para mostrar al menos algo con 1 kill)
  const barMax = Math.max(maxKills, 5);
  for (const entry of entries) {
    const bar = buildBar(Math.min(entry.kills, barMax), barMax, 10);
    const firstDate = entry.first_kill ? entry.first_kill.slice(0, 10) : '?';
    const skull = entry.kills >= 20 ? '💀' : entry.kills >= 10 ? '☠' : entry.kills >= 5 ? '⚔' : '·';
    lines.push(`║ ${skull} ${entry.name.padEnd(20).slice(0, 20)} × ${String(entry.kills).padStart(3)} kills ║`);
    lines.push(`║   ${bar}  (desde ${firstDate}) ║`);
    // STORY-002: nombre canónico del Lich revelado al haberlo matado
    if (entry.name === 'Lich Anciano') {
      lines.push(`║   🔮 Nombre verdadero: Kaelthas Valdrath    ║`);
      if (entry.kills >= 2) {
        lines.push(`║   "La segunda vez fue diferente. Casi       ║`);
        lines.push(`║    parecía estar esperándote."              ║`);
      }
    }
    // STORY-009: Textos de familiaridad al llegar a 5+ kills del mismo monstruo
    const BESTIARY_FAMILIARITY = {
      'Araña Tejedora':     'Ya perdiste la cuenta. Empezaste a notar que siempre tejen en espiral, nunca en ángulo recto.',
      'Guardia Espectral':  'La tercera vez que la mataste, la alabarda cayó al suelo y no desapareció. Te preguntás si alguna vez fue un hombre.',
      'Goblin Merodeador':  'Hay uno que escapó tres veces. No estás seguro de que sea el mismo, pero sospechás que sí.',
      'Esqueleto Guerrero': 'Ya no te molesta el ruido de los huesos al romperse. Eso te parece más perturbador que cualquier cosa que hayas encontrado aquí.',
      'Murciélago Vampiro': 'Aprendiste a reconocer el silbido particular de sus alas antes de que lleguen. Eso te salvó la vida al menos una vez.',
      'Rata Gigante':       'Son predecibles. Eso las hace aburridas. El dungeon te está cambiando.',
      'Espectro del Corredor': 'Los espectros no gritan al morir. Eso es lo que más te inquieta de ellos.',
      'Gólem de Piedra':    'El golem tarda en morir pero nunca huye. Hay algo casi admirable en eso.',
      'Elemental de Hielo': 'Las primeras veces el frío te quemaba. Ahora apenas lo notás. No estás seguro de si eso es adaptación o pérdida.',
    };
    if (entry.kills >= 5 && BESTIARY_FAMILIARITY[entry.name]) {
      const famText = BESTIARY_FAMILIARITY[entry.name];
      // Dividir en líneas de 36 chars para el marco
      const wrapped = [];
      let rem = '💭 ' + famText;
      while (rem.length > 36) {
        let cut = 36;
        while (cut > 0 && rem[cut] !== ' ') cut--;
        if (cut === 0) cut = 36;
        wrapped.push(rem.slice(0, cut));
        rem = rem.slice(cut).trimStart();
      }
      if (rem.length > 0) wrapped.push(rem);
      for (const line of wrapped) {
        lines.push(`║   ${line.padEnd(37).slice(0, 37)}║`);
      }
    }
    lines.push(`╟────────────────────────────────────────╢`);
  }
  // Reemplazar la última separación por el cierre
  lines[lines.length - 1] = `╚════════════════════════════════════════╝`;
  const TOTAL_TYPES = 14;
  const entryCount = entries.filter(e => e.name !== 'Goblin de Práctica').length;
  // DIS-D294: verificar también si el logro ya fue desbloqueado (override si hay desincronización)
  const achList = JSON.parse(fresh.achievements || '[]');
  const hasConquistador = achList.includes('conquistador_dungeon');
  if (entryCount >= TOTAL_TYPES || hasConquistador) {
    const displayCount = Math.max(entryCount, TOTAL_TYPES);
    lines.push(`  📖👑 ¡BESTIARIO COMPLETO! ${displayCount}/${TOTAL_TYPES} tipos cazados — Sos un Conquistador del Dungeon.`);
  } else {
    lines.push(`  Total: ${entries.length} tipo(s) de monstruo cazado(s). (${entryCount}/${TOTAL_TYPES} para logro Conquistador)`);
  }
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
    duelWins === 0 && duelLosses === 0
      ? `║${line('Duelos', `⚔️ 0/0  · usá "duel <nombre>" para retar a alguien en tu sala`)}║`
      : `║${line('Duelos', `⚔️ ${duelWins} ganados / ${duelLosses} perdidos`)}║`,
    `║${line('Oro   ', `💰 ${gold}g`)}║`,
    `║${line('Reputa', `${repLevel.icon} ${repLevel.name} (${repLevel.points} pts)`)}║`,
    `╟${'─'.repeat(W)}╢`,
    `║${line('Hermandad', fresh.guild ? `[${fresh.guild}]` : '(independiente)')}║`,
    `║${line('Mascota  ', fresh.pet || '(sin compañero)')}║`,
    `║${line('Arma     ', fresh.equipped_weapon || '(desarmado)')}║`,
    `║${line('Armadura ', (fresh.equipped_armor && fresh.equipped_armor !== 'null') ? fresh.equipped_armor : '(sin armadura)')}║`,
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
  const unlocked = skills.getUnlockedSkills(level, fresh.player_class);
  const cooldowns = skills.getCooldowns(fresh);
  const now = Date.now();

  const lines = ['⚡ HABILIDADES ACTIVAS', '─'.repeat(40)];

  // Habilidades desbloqueadas
  if (unlocked.length === 0) {
    const cls = fresh.player_class;
    if (cls === 'picaro') {
      lines.push('  Aún no desbloqueaste ninguna habilidad.');
      lines.push('  (Nivel 1: Robar · Nivel 3: Golpe Sucio)');
    } else if (cls === 'mago') {
      lines.push('  Los Magos no usan habilidades físicas.');
      lines.push('  Tu poder está en los hechizos: usá "hechizos" para verlos.');
      lines.push('  (cast bola de fuego / cast rayo / cast curación / cast escudo)');
    } else {
      lines.push('  Aún no desbloqueaste ninguna habilidad.');
      lines.push('  (Nivel 3: Golpetazo · Nivel 6: Golpe de Escudo · Nivel 10: Arenga)');
    }
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

  // Habilidades aún bloqueadas (filtrar por clase)
  const locked = skills.ALL_SKILLS.filter(sk => {
    if (level >= sk.required_level) return false;
    if (sk.required_class && sk.required_class !== fresh.player_class) return false;
    // DIS-D304: no mostrar skills físicas bloqueadas a Magos
    if (sk.excluded_classes && sk.excluded_classes.includes(fresh.player_class)) return false;
    return true;
  });
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
    const targetName = args.slice(1).join(' ').trim();
    if (alive.length === 0) {
      if (targetName) return { text: `⚡ No hay ningún "${targetName}" aquí para golpear.` };
      return { text: '⚡ No hay monstruos aquí para golpear.' };
    }
    // Buscar monstruo por nombre si se especificó, si no usar el primero
    let target = targetName ? combat.findMonsterInRoom(freshPlayer.current_room_id, targetName) : null;
    if (!target) target = alive[0];
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
      // Loot via dropLoot (igual que cmdAttack) — incluye loot bonus de boss
      const { droppedLoot: smashLoot, globalEvent: smashGlobalEvent } = combat.dropLoot(target, freshPlayer.current_room_id);
      if (smashLoot && smashLoot.length > 0) text += `\n💰 El ${target.name} suelta: ${smashLoot.join(', ')}.`;
      if (smashGlobalEvent) {
        db.logGlobalEvent('boss', smashGlobalEvent);
        if (typeof io !== 'undefined' && io) io.emit('shout', { username: 'El Dungeon', message: smashGlobalEvent });
      }
      // XP básico
      const xpGain = Math.max(5, Math.floor(target.max_hp * 2));
      const newXp = (freshPlayer.xp || 0) + xpGain;
      const newLevel = xpSystem.levelFromXp(newXp);
      const levelUp = newLevel > (freshPlayer.level || 1);
      const smashUpd = { xp: newXp, level: newLevel, kills: (freshPlayer.kills || 0) + 1 };
      if (levelUp) {
        smashUpd.max_hp = (freshPlayer.max_hp || 30) + 5;
        const healSmash = Math.ceil(smashUpd.max_hp * 0.20);
        smashUpd.hp = Math.min(smashUpd.max_hp, (freshPlayer.hp || 1) + healSmash);
        smashUpd.attack = (freshPlayer.attack || 5) + 1;
      }
      db.updatePlayer(freshPlayer.id, smashUpd);
      text += `\n  +${xpGain} XP${levelUp ? ` ✨ ¡SUBE AL NIVEL ${newLevel}!` : ''}`;
      db.addBestiaryKill(freshPlayer.id, target.name);
      if (levelUp) db.addJournalEntry(freshPlayer.id, 'level', `⬆️ Subiste al nivel ${newLevel} tras el Golpetazo.`);
      // Logros — incluyendo boss_killer
      const smashBossKill = !!(combat.BOSS_MONSTERS && combat.BOSS_MONSTERS[target.id]);
      const smashLichKill = target.id === 13; // solo el Lich Anciano real
      const freshForSmashAch = db.getPlayer(freshPlayer.id);
      if (freshForSmashAch) {
        const newSmashAchs = ach.checkAchievements(freshForSmashAch, { bossKill: smashLichKill });
        const smashAchLines = ach.formatNewAchievements(newSmashAchs);
        if (smashAchLines) text += '\n' + smashAchLines;
        if (smashBossKill) {
          db.logGlobalEvent('boss', `⚔️ ${freshPlayer.username} derrotó al ${target.name} con Golpetazo.`);
          db.addJournalEntry(freshPlayer.id, 'boss', `☠️ Derrotaste al ${target.name} con Golpetazo.`);
          text += `\n\n╔════════════════════════════════════╗\n║  ☠  ¡${target.name.toUpperCase()} DERROTADO!  ☠  ║\n╚════════════════════════════════════╝\n¡Usá 'loot' para recoger los tesoros!`;
        }
        if (newSmashAchs && newSmashAchs.length > 0) {
          db.logGlobalEvent('achievement', `🏅 ${freshPlayer.username} desbloqueó el logro "${newSmashAchs[0].name}".`);
        }
      }
      // BUG-010: registrar progreso de quest al matar con skill
      const freshForSmashQuest = db.getPlayer(freshPlayer.id);
      const qSmashResult = quests.recordProgress(freshForSmashQuest, 'kill', { monsterName: target.name });
      // BUG-017: registrar progreso de desafío diario al matar con smash
      const crSmash = db.updateDailyChallengeProgress(freshPlayer.id, 'kill', target.name);
      // BUG-043: registrar progreso de contrato semanal al matar con smash
      const wcrSmash = db.updateWeeklyContractProgress(freshPlayer.id, target.name);
      if (wcrSmash && wcrSmash.reward) {
        text += `\n📜 ¡CONTRATO DE CAZA COMPLETADO! +${wcrSmash.reward.xp} XP · +${wcrSmash.reward.gold}g · Recibís: ${wcrSmash.reward.item}`;
      } else if (wcrSmash && wcrSmash.contract && !wcrSmash.contract.done) {
        text += `\n📜 Contrato semanal: ${wcrSmash.contract.target} (${wcrSmash.contract.progress}/${wcrSmash.contract.goal})`;
      }
      if (crSmash && crSmash.reward) {
        text += `\n🏆 ¡DESAFÍO DIARIO COMPLETADO! +30 XP · +20 🪙 · +5 Reputación`;
      } else if (crSmash && crSmash.challenge && !crSmash.challenge.done) {
        text += `\n📅 Desafío: ${crSmash.challenge.progress}/${crSmash.challenge.goal}`;
      }
      if (qSmashResult) {
        db.updatePlayer(freshPlayer.id, { quest_progress: qSmashResult.questProgress });
        if (qSmashResult.justCompleted && qSmashResult.reward) {
          const r = qSmashResult.reward;
          const freshQ2 = db.getPlayer(freshPlayer.id);
          const questNewXp = (freshQ2.xp || 0) + r.xp;
          const questNewLevel = xpSystem.levelFromXp(questNewXp);
          const questLevelUp = questNewLevel > (freshQ2.level || 1);
          db.updatePlayer(freshPlayer.id, { gold: (freshQ2.gold || 0) + r.gold, xp: questNewXp, level: questNewLevel });
          text += `\n🎉 ¡Quest completada! Recibís ${r.gold}g y ${r.xp} XP de recompensa.${questLevelUp ? ` ✨ ¡SUBÍS AL NIVEL ${questNewLevel}!` : ''}`;
          db.addReputation(freshPlayer.id, 5);
          db.logGlobalEvent('quest', `📜 ${freshPlayer.username} completó la misión con Golpetazo.`);
          db.addJournalEntry(freshPlayer.id, 'quest', `📜 Quest completada con Golpetazo: +${r.gold}g, +${r.xp} XP.`);
        } else if (qSmashResult.newProgress) {
          const info = quests.getPlayerProgress(db.getPlayer(freshPlayer.id));
          if (info && !info.completed) {
            text += `\n📜 Quest: ${qSmashResult.newProgress}/${info.goal} — ¡Seguí así!`;
          }
        }
      }
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
    const targetName = args.slice(1).join(' ').trim();
    if (alive.length === 0) {
      if (targetName) return { text: `⚡ No hay ningún "${targetName}" aquí para golpear con el escudo.` };
      return { text: '⚡ No hay monstruos aquí para golpear con el escudo.' };
    }
    // Buscar monstruo por nombre si se especificó, si no usar el primero
    let target = targetName ? combat.findMonsterInRoom(freshPlayer.current_room_id, targetName) : null;
    if (!target) target = alive[0];
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
      // Loot via dropLoot (igual que cmdAttack) — incluye loot bonus de boss
      const { droppedLoot: bashLoot, globalEvent: bashGlobalEvent } = combat.dropLoot(target, freshPlayer.current_room_id);
      if (bashLoot && bashLoot.length > 0) text += `\n💰 El ${target.name} suelta: ${bashLoot.join(', ')}.`;
      if (bashGlobalEvent) {
        db.logGlobalEvent('boss', bashGlobalEvent);
        if (typeof io !== 'undefined' && io) io.emit('shout', { username: 'El Dungeon', message: bashGlobalEvent });
      }
      const xpGain = Math.max(5, Math.floor(target.max_hp * 2));
      const newXp = (freshPlayer.xp || 0) + xpGain;
      const newLevel = xpSystem.levelFromXp(newXp);
      const levelUp = newLevel > (freshPlayer.level || 1);
      const skillUpd = { xp: newXp, level: newLevel, kills: (freshPlayer.kills || 0) + 1 };
      if (levelUp) {
        skillUpd.max_hp = (freshPlayer.max_hp || 30) + 5;
        const healSkill = Math.ceil(skillUpd.max_hp * 0.20);
        skillUpd.hp = Math.min(skillUpd.max_hp, (freshPlayer.hp || 1) + healSkill);
        skillUpd.attack = (freshPlayer.attack || 5) + 1;
      }
      db.updatePlayer(freshPlayer.id, skillUpd);
      text += `\n  +${xpGain} XP${levelUp ? ` ✨ ¡SUBE AL NIVEL ${newLevel}!` : ''}`;
      db.addBestiaryKill(freshPlayer.id, target.name);
      // Logros — incluyendo boss_killer
      const bashBossKill = !!(combat.BOSS_MONSTERS && combat.BOSS_MONSTERS[target.id]);
      const bashLichKill = target.id === 13; // solo el Lich Anciano real
      const freshForBashAch = db.getPlayer(freshPlayer.id);
      if (freshForBashAch) {
        const newBashAchs = ach.checkAchievements(freshForBashAch, { bossKill: bashLichKill });
        const bashAchLines = ach.formatNewAchievements(newBashAchs);
        if (bashAchLines) text += '\n' + bashAchLines;
        if (bashBossKill) {
          db.logGlobalEvent('boss', `⚔️ ${freshPlayer.username} derrotó al ${target.name} con Golpe de Escudo.`);
          db.addJournalEntry(freshPlayer.id, 'boss', `☠️ Derrotaste al ${target.name} con Golpe de Escudo.`);
          text += `\n\n╔════════════════════════════════════╗\n║  ☠  ¡${target.name.toUpperCase()} DERROTADO!  ☠  ║\n╚════════════════════════════════════╝\n¡Usá 'loot' para recoger los tesoros!`;
        }
        if (newBashAchs && newBashAchs.length > 0) {
          db.logGlobalEvent('achievement', `🏅 ${freshPlayer.username} desbloqueó el logro "${newBashAchs[0].name}".`);
        }
      }
      // BUG-010: registrar progreso de quest al matar con shield_bash
      const freshForBashQuest = db.getPlayer(freshPlayer.id);
      const qBashResult = quests.recordProgress(freshForBashQuest, 'kill', { monsterName: target.name });
      // BUG-017: registrar progreso de desafío diario al matar con shield_bash
      const crBash = db.updateDailyChallengeProgress(freshPlayer.id, 'kill', target.name);
      // BUG-043: registrar progreso de contrato semanal al matar con shield_bash
      const wcrBash = db.updateWeeklyContractProgress(freshPlayer.id, target.name);
      if (wcrBash && wcrBash.reward) {
        text += `\n📜 ¡CONTRATO DE CAZA COMPLETADO! +${wcrBash.reward.xp} XP · +${wcrBash.reward.gold}g · Recibís: ${wcrBash.reward.item}`;
      } else if (wcrBash && wcrBash.contract && !wcrBash.contract.done) {
        text += `\n📜 Contrato semanal: ${wcrBash.contract.target} (${wcrBash.contract.progress}/${wcrBash.contract.goal})`;
      }
      if (crBash && crBash.reward) {
        text += `\n🏆 ¡DESAFÍO DIARIO COMPLETADO! +30 XP · +20 🪙 · +5 Reputación`;
      } else if (crBash && crBash.challenge && !crBash.challenge.done) {
        text += `\n📅 Desafío: ${crBash.challenge.progress}/${crBash.challenge.goal}`;
      }
      if (qBashResult) {
        db.updatePlayer(freshPlayer.id, { quest_progress: qBashResult.questProgress });
        if (qBashResult.justCompleted && qBashResult.reward) {
          const r = qBashResult.reward;
          const freshQ2 = db.getPlayer(freshPlayer.id);
          const questNewXp = (freshQ2.xp || 0) + r.xp;
          const questNewLevel = xpSystem.levelFromXp(questNewXp);
          const questLevelUp = questNewLevel > (freshQ2.level || 1);
          db.updatePlayer(freshPlayer.id, { gold: (freshQ2.gold || 0) + r.gold, xp: questNewXp, level: questNewLevel });
          text += `\n🎉 ¡Quest completada! Recibís ${r.gold}g y ${r.xp} XP de recompensa.${questLevelUp ? ` ✨ ¡SUBÍS AL NIVEL ${questNewLevel}!` : ''}`;
          db.addReputation(freshPlayer.id, 5);
          db.logGlobalEvent('quest', `📜 ${freshPlayer.username} completó la misión con Golpe de Escudo.`);
          db.addJournalEntry(freshPlayer.id, 'quest', `📜 Quest completada con Golpe de Escudo: +${r.gold}g, +${r.xp} XP.`);
        } else if (qBashResult.newProgress) {
          const info = quests.getPlayerProgress(db.getPlayer(freshPlayer.id));
          if (info && !info.completed) {
            text += `\n📜 Quest: ${qBashResult.newProgress}/${info.goal} — ¡Seguí así!`;
          }
        }
      }
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

  // ── Golpe Sucio (golpe_sucio) — Pícaro Lv3 ───────────────────────────────
  if (skillId === 'golpe_sucio') {
    const monsters = db.getMonstersInRoom(freshPlayer.current_room_id);
    const alive = monsters.filter(m => m.hp > 0);
    const targetName = args.slice(1).join(' ').trim();
    if (alive.length === 0) {
      if (targetName) return { text: `🗡️ No hay ningún "${targetName}" aquí.` };
      return { text: '🗡️ No hay monstruos aquí para atacar con Golpe Sucio.' };
    }
    let target = targetName ? combat.findMonsterInRoom(freshPlayer.current_room_id, targetName) : null;
    if (!target) target = alive[0];

    const baseDmg = freshPlayer.attack || 5;
    const rawDmg = Math.max(1, Math.floor(baseDmg * skill.dmg_multiplier));
    const variation = Math.floor(rawDmg * 0.15);
    const dmg = rawDmg + Math.floor(Math.random() * (variation * 2 + 1)) - variation;
    const finalDmg = Math.max(1, dmg - Math.floor(target.defense || 0));
    const newHp = Math.max(0, target.hp - finalDmg);

    // Aplicar veneno al monstruo
    const monsterFx = target.status_effects ? JSON.parse(target.status_effects || '{}') : {};
    monsterFx.poisoned = { damage: skill.poison_damage, turns: skill.poison_turns };
    db.updateMonster(target.id, { hp: newHp, status_effects: JSON.stringify(monsterFx) });

    const newCooldowns = skills.applyCooldown(freshPlayer, 'golpe_sucio');
    db.updatePlayer(freshPlayer.id, { skill_cooldowns: newCooldowns });

    const dead = newHp <= 0;
    let text = `🗡️ ¡GOLPE SUCIO! Atacás al ${target.name} por ${finalDmg} dmg y lo envenenás (${skill.poison_damage} dmg × ${skill.poison_turns} turnos)!`;
    if (dead) {
      text += `\n💀 El veneno ya no importa — el ${target.name} cae al instante.`;
      const { droppedLoot: gsLoot, globalEvent: gsGlobalEvent } = combat.dropLoot(target, freshPlayer.current_room_id);
      if (gsLoot && gsLoot.length > 0) text += `\n💰 El ${target.name} suelta: ${gsLoot.join(', ')}.`;
      if (gsGlobalEvent) {
        db.logGlobalEvent('boss', gsGlobalEvent);
        if (typeof io !== 'undefined' && io) io.emit('shout', { username: 'El Dungeon', message: gsGlobalEvent });
      }
      const xpGain = Math.max(5, Math.floor(target.max_hp * 2));
      const newXp = (freshPlayer.xp || 0) + xpGain;
      const newLevel = xpSystem.levelFromXp(newXp);
      const levelUp = newLevel > (freshPlayer.level || 1);
      const skillUpd = { xp: newXp, level: newLevel, kills: (freshPlayer.kills || 0) + 1 };
      if (levelUp) {
        skillUpd.max_hp = (freshPlayer.max_hp || 30) + 5;
        const healSkill = Math.ceil(skillUpd.max_hp * 0.20);
        skillUpd.hp = Math.min(skillUpd.max_hp, (freshPlayer.hp || 1) + healSkill);
        skillUpd.attack = (freshPlayer.attack || 5) + 1;
      }
      db.updatePlayer(freshPlayer.id, skillUpd);
      text += `\n  +${xpGain} XP${levelUp ? ` ✨ ¡SUBE AL NIVEL ${newLevel}!` : ''}`;
      db.addBestiaryKill(freshPlayer.id, target.name);
      const gsBossKill = !!(combat.BOSS_MONSTERS && combat.BOSS_MONSTERS[target.id]);
      const gsLichKill = target.id === 13; // solo el Lich Anciano real
      const freshForGsAch = db.getPlayer(freshPlayer.id);
      if (freshForGsAch) {
        const newGsAchs = ach.checkAchievements(freshForGsAch, { bossKill: gsLichKill });
        const gsAchLines = ach.formatNewAchievements(newGsAchs);
        if (gsAchLines) text += '\n' + gsAchLines;
        if (gsBossKill) {
          db.logGlobalEvent('boss', `⚔️ ${freshPlayer.username} derrotó al ${target.name} con Golpe Sucio.`);
          db.addJournalEntry(freshPlayer.id, 'boss', `☠️ Derrotaste al ${target.name} con Golpe Sucio.`);
          text += `\n\n╔════════════════════════════════════╗\n║  ☠  ¡${target.name.toUpperCase()} DERROTADO!  ☠  ║\n╚════════════════════════════════════╝\n¡Usá 'loot' para recoger los tesoros!`;
        }
      }
      // Registrar quest/challenge/contract al matar con golpe_sucio
      const freshForGsQuest = db.getPlayer(freshPlayer.id);
      const qGsResult = quests.recordProgress(freshForGsQuest, 'kill', { monsterName: target.name });
      const crGs = db.updateDailyChallengeProgress(freshPlayer.id, 'kill', target.name);
      const wcrGs = db.updateWeeklyContractProgress(freshPlayer.id, target.name);
      if (wcrGs && wcrGs.reward) text += `\n📜 ¡CONTRATO COMPLETADO! +${wcrGs.reward.xp} XP · +${wcrGs.reward.gold}g`;
      if (crGs && crGs.reward) text += `\n🏆 ¡DESAFÍO DIARIO COMPLETADO! +30 XP · +20 🪙`;
      if (qGsResult) {
        db.updatePlayer(freshPlayer.id, { quest_progress: qGsResult.questProgress });
        if (qGsResult.justCompleted && qGsResult.reward) {
          const r = qGsResult.reward;
          const freshQ2 = db.getPlayer(freshPlayer.id);
          const questNewXp = (freshQ2.xp || 0) + r.xp;
          const questNewLevel = xpSystem.levelFromXp(questNewXp);
          const questLevelUp = questNewLevel > (freshQ2.level || 1);
          db.updatePlayer(freshPlayer.id, { gold: (freshQ2.gold || 0) + r.gold, xp: questNewXp, level: questNewLevel });
          text += `\n🎉 ¡Quest completada! Recibís ${r.gold}g y ${r.xp} XP.${questLevelUp ? ` ✨ ¡SUBÍS AL NIVEL ${questNewLevel}!` : ''}`;
        }
      }
    } else {
      text += `\n  El ${target.name} tiene ${newHp}/${target.max_hp} HP y está envenenado.`;
      text += `\n  (Cooldown: ${skill.cooldown_seconds}s)`;
    }
    if (context && context.broadcastToRoom) {
      context.broadcastToRoom(freshPlayer.current_room_id, freshPlayer.id,
        `🗡️ ${freshPlayer.username} usa Golpe Sucio sobre el ${target.name}! (-${finalDmg} HP + veneno)`);
    }
    return { text };
  }

  // ── Robar (robar) — Pícaro Lv1 ───────────────────────────────────────────
  if (skillId === 'robar') {
    const monsters = db.getMonstersInRoom(freshPlayer.current_room_id);
    const alive = monsters.filter(m => m.hp > 0);
    const targetName = args.slice(1).join(' ').trim();
    if (alive.length === 0) {
      return { text: '🃏 No hay monstruos aquí a quienes robar.' };
    }
    let target = targetName ? combat.findMonsterInRoom(freshPlayer.current_room_id, targetName) : null;
    if (!target) target = alive[0];

    // Probabilidad: 50% base + 15% por cada nivel de ventaja (nivel jugador - nivel monstruo estimado)
    // Nivel de monstruo estimado = max_hp / 8 aproximado
    const monsterEstLevel = Math.max(1, Math.round((target.max_hp || 8) / 8));
    const levelAdvantage = Math.max(0, (freshPlayer.level || 1) - monsterEstLevel);
    const chance = Math.min(0.90, 0.50 + levelAdvantage * 0.15);
    const success = Math.random() < chance;

    const newCooldowns = skills.applyCooldown(freshPlayer, 'robar');
    db.updatePlayer(freshPlayer.id, { skill_cooldowns: newCooldowns });

    if (success) {
      const stolen = Math.floor(Math.random() * 11) + 5; // 5-15 monedas
      const freshForGold = db.getPlayer(freshPlayer.id);
      db.updatePlayer(freshPlayer.id, { gold: (freshForGold.gold || 0) + stolen });
      const text = `🃏 ¡ROBO EXITOSO! Mientras el ${target.name} está distraído, le sacás ${stolen} monedas de los bolsillos.\n  Tu cartera: ${(freshForGold.gold || 0) + stolen}g\n  (Cooldown: ${skill.cooldown_seconds}s)`;
      if (context && context.broadcastToRoom) {
        context.broadcastToRoom(freshPlayer.current_room_id, freshPlayer.id,
          `🃏 ${freshPlayer.username} le roba monedas al ${target.name}!`);
      }
      return { text };
    } else {
      // Fallo: el monstruo ataca
      const monsterAtk = target.attack || 3;
      const playerDef = freshPlayer.defense || 0;
      const dmgReceived = Math.max(1, monsterAtk - playerDef);
      const newHp = Math.max(0, freshPlayer.hp - dmgReceived);
      db.updatePlayer(freshPlayer.id, { hp: newHp });
      const died = newHp <= 0;
      let text = `🃏 ¡TE DESCUBRIERON! El ${target.name} nota tu mano en sus bolsillos y te golpea por ${dmgReceived} de daño.`;
      if (died) {
        text += `\n💀 ¡Has muerto! El intento de robo te costó la vida.`;
        // Respawn con 25% HP
        const respawnHp = Math.max(5, Math.floor((freshPlayer.max_hp || 30) * 0.25));
        db.updatePlayer(freshPlayer.id, { hp: respawnHp, current_room_id: 1, deaths: (freshPlayer.deaths || 0) + 1 });
        db.addJournalEntry(freshPlayer.id, 'death', `💀 Muerto por ${target.name} al intentar robar.`);
        text += `\n  ¡Amanecés en la entrada con ${respawnHp} HP!`;
      } else {
        text += `\n  Tu HP: ${newHp}/${freshPlayer.max_hp}.`;
      }
      text += `\n  (Cooldown: ${skill.cooldown_seconds}s)`;
      return { text };
    }
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
    { version: '0.30', date: '2026-05-31', changes: [
      '✨ NUEVO: comando weekly/semana — resumen de actividad de los últimos 7 días',
      '📅 Muestra sesiones jugadas, tiempo total, kills, XP y oro acumulados esta semana',
      '🏆 Incluye mejor sesión por kills y sesión más larga de la semana',
      '✨ NUEVO: comando tips [tema] — consejos estratégicos organizados por tema',
      '💡 6 categorías: combate, crafteo, clases, economía, exploración, social',
      '📖 Cada tip es accionable y cubre mecánicas avanzadas que el help normal no menciona',
      '✨ NUEVO: comando goals/objetivos — tus próximos objetivos personalizados',
      '🎯 Analiza tu progreso actual y sugiere metas concretas: logros próximos, niveles, reputación',
    ]},
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
    SELECT m.id, m.name, m.hp, m.max_hp, m.attack, m.room_id, m.respawn_at, m.respawn_room_id,
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
    const [id, name, hp, maxHp, attack, room_id, respawnAt, respawn_room_id, roomName] = row;
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
    const location = roomName ? roomName : (respawn_room_id ? `Sala ${respawn_room_id}` : 'Ubicación desconocida');
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
      const diff = Math.round((mine - avgVal) * 10) / 10;
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
  lines.push('║  (+1 ATK permanente al arma equipada)           ║');
  for (const type of RUNE_TYPES) {
    const b = RUNE_BONUSES[type];
    const emoji = RUNE_EMOJIS[type];
    lines.push(`║  ${emoji} ${(type + ':').padEnd(8)} ${b.label.padEnd(33)}║`);
  }
  lines.push('╟' + '─'.repeat(44) + '╢');
  lines.push('║  📖 FUENTES DE RUNAS:                           ║');
  lines.push('║  • Cualquier monstruo puede soltar 1 runa al   ║');
  lines.push('║    morir (15% de chance por kill).              ║');
  lines.push('║  • El tipo es ALEATORIO — no hay monstruo       ║');
  lines.push('║    específico para cada runa.                   ║');
  lines.push('║  • Hay 5 tipos en total: fuego, hielo, sombra,  ║');
  lines.push('║    luz y caos.                                  ║');
  lines.push('║  • La runa de caos tiene efecto aleatorio al    ║');
  lines.push('║    encantarse (equivale a uno de los otros 4).  ║');
  lines.push('╟' + '─'.repeat(44) + '╢');
  lines.push('║  💡 USO: enchant <tipo>  — Encanta tu arma      ║');
  lines.push('║  equipada con 1 runa del tipo indicado.         ║');
  lines.push('║  Duración: 3 minutos. Ver efectos arriba.       ║');
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
 * DIS-450: project / proyectar — Habilidad exclusiva de Mago.
 * Proyección astral para inspeccionar una sala adyacente sin entrar.
 * Más detallada que peek: incluye descripción completa de sala, lore hints,
 * HP de monstruos y descripción de trampas.
 * Cooldown: 60 segundos. Solo disponible para Mago.
 */
function cmdProject(player, args) {
  player = db.getPlayer(player.id);

  // Solo Mago puede usar proyectar
  const clsData = classes.getPlayerClass(player);
  if (!clsData || clsData.name !== 'Mago') {
    return { text: '🔮 «Proyectar» es una habilidad exclusiva del Mago. Requiere dominio de la magia arcana para proyectar la conciencia fuera del cuerpo.' };
  }

  if (!args || args.length === 0) {
    return {
      text: [
        '🔮 Proyectás tu conciencia hacia una sala adyacente sin moverte.',
        'Uso: proyectar <dirección>',
        'Ej: proyectar norte  |  proyectar este',
        '(Cooldown: 60s. Requiere maná para activarse.)',
      ].join('\n'),
    };
  }

  // Coste de maná: 3 (pequeño pero presente — tiene sabor de hechizo)
  const MANA_COST = 3;
  const curMana = player.mana != null ? player.mana : 0;
  if (curMana < MANA_COST) {
    return { text: `🔮 No tenés suficiente maná para proyectar. Necesitás ${MANA_COST} maná, tenés ${curMana}.` };
  }

  // Cooldown: 60 segundos
  const COOLDOWN_MS = 60000;
  if (player.last_project) {
    const elapsed = Date.now() - new Date(player.last_project).getTime();
    if (elapsed < COOLDOWN_MS) {
      const remaining = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
      return { text: `🔮 Tu proyección arcana todavía se está reintegrando. Esperá ${remaining} segundo${remaining !== 1 ? 's' : ''}.` };
    }
  }

  const roomFull = dungeon.getRoomFull(player.current_room_id);
  if (!roomFull) return { text: 'No podés proyectarte desde aquí.' };
  const { room } = roomFull;

  const dirArg = args[0];
  const exit = dungeon.resolveExit(room, dirArg);

  if (!exit) {
    return { text: `No hay salida hacia esa dirección. No hay nada que proyectar.` };
  }

  if (exit.key) {
    return { text: `🔮 La barrera mágica de la puerta bloqueada resiste tu proyección. Tu conciencia rebota de vuelta.` };
  }

  // Cargar sala destino
  const targetFull = dungeon.getRoomFull(exit.targetId);
  if (!targetFull) return { text: 'No podés ver nada en esa dirección.' };

  const { room: target, monsters } = targetFull;
  const targetRoomDB = db.getRoom(exit.targetId);

  // Cobrar maná
  const newMana = curMana - MANA_COST;
  db.updatePlayer(player.id, {
    mana: newMana,
    last_project: new Date().toISOString(),
  });

  const DIR_NAMES_ES = { north: 'norte', south: 'sur', east: 'este', west: 'oeste', up: 'arriba', down: 'abajo' };
  const normalized = dungeon.normalizeDirection(dirArg) || dirArg;
  const dirLabel = DIR_NAMES_ES[normalized] || dirArg;

  const lines = [
    `🔮 Tu conciencia se desplaza hacia el ${dirLabel}... Una visión nítida se forma en tu mente.`,
    ``,
    `╔══ ${target.name.toUpperCase()} ══╗`,
    ``,
  ];

  // Descripción completa de la sala (el Mago percibe más detalles)
  if (target.description) {
    lines.push(target.description);
    lines.push('');
  }

  // Monstruos con HP completo (ventaja del Mago sobre peek básico)
  const aliveMonsters = monsters.filter(m => m.hp > 0);
  if (aliveMonsters.length > 0) {
    lines.push('⚔️  Criaturas percibidas:');
    for (const m of aliveMonsters) {
      const hpBar = buildBar(m.hp, m.max_hp || m.hp, 10);
      lines.push(`  • ${m.name} ${hpBar} ${m.hp}/${m.max_hp || m.hp} HP`);
    }
    lines.push('');
  } else {
    lines.push('🕊️  La sala está vacía de amenazas.');
    lines.push('');
  }

  // Ítems en suelo
  const floorItems = target.items || [];
  if (floorItems.length > 0) {
    const itemList = floorItems.map(i => `${items.getRarityEmoji(i)} ${i}`).join(', ');
    lines.push(`🎒 Suelo: ${itemList}`);
  }

  // Trampa (el Mago la percibe con detalle)
  if (targetRoomDB && targetRoomDB.trap && targetRoomDB.trap.active) {
    const trap = targetRoomDB.trap;
    lines.push(`⚠️  TRAMPA DETECTADA: ${trap.description}`);
    if (trap.disarm_item) {
      lines.push(`   Para desactivarla necesitás: «${trap.disarm_item}»`);
    }
  }

  lines.push('');
  lines.push(`🔮 Maná consumido: ${MANA_COST}. (${newMana}/${player.max_mana || 20} 🔮)`);

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
 * T222: contract/contrato — Ver el contrato de caza semanal del jugador.
 */
function cmdContract(player) {
  const fresh = db.getPlayer(player.id);
  if (!fresh) return { text: 'Error al leer tu perfil.' };
  const ct = db.getWeeklyContract(fresh);
  const progress = ct.progress || 0;
  const barLen = 24;
  const pct = Math.floor((progress / ct.goal) * barLen);
  const bar = '█'.repeat(pct) + '░'.repeat(barLen - pct);
  const status = ct.done ? '✅ ¡COMPLETADO!' : `${progress}/${ct.goal}`;
  // Días restantes de la semana
  const msInWeek = 7 * 24 * 60 * 60 * 1000;
  const weekStart = Math.floor(Date.now() / msInWeek) * msInWeek;
  const daysLeft = Math.ceil((weekStart + msInWeek - Date.now()) / (24 * 60 * 60 * 1000));
  const lines = [
    '',
    '╔' + '═'.repeat(50) + '╗',
    '║         📜 CONTRATO DE CAZA SEMANAL              ║',
    '╟' + '─'.repeat(50) + '╢',
    `  Objetivo: ${ct.target}`,
    `  ${ct.desc}`,
    `  Dificultad: ${ct.difficulty}`,
    '╟' + '─'.repeat(50) + '╢',
    `  Progreso: [${bar}] ${status}`,
    '╟' + '─'.repeat(50) + '╢',
    `  Recompensa: +${ct.reward_xp} XP · +${ct.reward_gold}g · ${ct.reward_item}`,
    ct.done
      ? '  🌟 ¡Recompensa ya cobrada! Nuevo contrato la próxima semana.'
      : `  ⏳ ${daysLeft} día${daysLeft !== 1 ? 's' : ''} restante${daysLeft !== 1 ? 's' : ''} esta semana.`,
    '╚' + '═'.repeat(50) + '╝',
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

// T216: Map playerId → mensaje AFK personalizado
const afkMessages = new Map();
function cmdAfk(player, args) {
  const now = Date.now();
  const lastToggle = afkCooldowns.get(player.id) || 0;
  if (now - lastToggle < 10000) {
    const wait = Math.ceil((10000 - (now - lastToggle)) / 1000);
    return { text: `⚠️ Esperá ${wait}s antes de cambiar el estado AFK de nuevo.` };
  }

  // T216: afk clear — borrar mensaje pero mantener AFK activo
  const sub = (args && args[0] || '').toLowerCase();
  if (sub === 'clear' || sub === 'borrar' || sub === 'limpiar') {
    afkMessages.delete(player.id);
    return { text: `🗑️ Mensaje de ausencia eliminado. Seguís en modo AFK.` };
  }

  // T216: afk <mensaje> — guardar mensaje personalizado y activar AFK
  const customMsg = args && args.length > 0 ? args.join(' ').trim().slice(0, 60) : null;

  afkCooldowns.set(player.id, now);

  if (afkPlayers.has(player.id) && !customMsg) {
    // Toggle OFF
    afkPlayers.delete(player.id);
    afkMessages.delete(player.id);
    return { text: `✅ Ya no estás en modo ausente (AFK). ¡Bienvenido de vuelta, ${player.username}!` };
  } else {
    // Toggle ON (o actualizar mensaje)
    afkPlayers.add(player.id);
    if (customMsg) {
      afkMessages.set(player.id, customMsg);
      return { text: `💤 Modo ausente activado con mensaje: "${customMsg}"` };
    } else {
      afkMessages.delete(player.id);
      return { text: `💤 Modo ausente activado (AFK). Todos tus comandos quedarán bloqueados hasta que escribás "afk" de nuevo.` };
    }
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

/**
 * T216: Obtener el mensaje AFK de un jugador (o null si no tiene).
 */
function getAfkMessage(playerId) {
  return afkMessages.get(playerId) || null;
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
  const BOT_PATTERNS = /^(PTBot_|Critico_Diseno_|PlaytestBot_|TestBot_|Bot_)/i;
  const lines = ['📜 Inscripciones en la pared:'];
  for (const m of msgs) {
    const date = m.created_at ? m.created_at.slice(5, 16).replace('T', ' ') : '';
    const isBot = BOT_PATTERNS.test(m.player_name);
    // DIS-498: marcar visualmente inscripciones de bots con tono más tenue
    const prefix = isBot ? '  🤖' : '  ✍️';
    lines.push(`${prefix} ${m.player_name} [${date}]: ${m.message}`);
  }
  return { text: lines.join('\n') };
}

// ── T148: Comando greet/saludar ───────────────────────────────────────────────

// Mapa de saludos recientes: playerId → { targetName, timestamp }
const recentGreetings = new Map();
const GREET_WINDOW_MS = 30000; // 30 segundos para saludo mutuo

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
    // BUG-333: mensaje más útil — diferenciar "no existe ese jugador" de "comando confundido"
    const onlinePlayers = db.getPlayersInRoom(player.current_room_id)
      .filter(p => p.id !== player.id)
      .map(p => p.username.toLowerCase());
    const hint = onlinePlayers.length > 0
      ? `\n💡 Jugadores en esta sala: ${onlinePlayers.join(', ')}. Usá "decir <mensaje>" para hablar libre.`
      : '\n💡 No hay otros jugadores aquí. Usá "decir <mensaje>" para hablar libre.';
    return { text: `👋 No encontré a "${args[0]}" en esta sala.${hint}` };
  }

  // T216: Si el objetivo está AFK, notificar al saludador
  let afkNote = '';
  if (isAfk(target.id)) {
    const afkMsg = getAfkMessage(target.id);
    afkNote = afkMsg
      ? `\n💤 [AFK] ${target.username}: "${afkMsg}"`
      : `\n💤 ${target.username} está en modo ausente (AFK).`;
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
      text: `👋 Saludaste a ${target.username}.${afkNote}`,
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
  // DIS-D22: lore para monstruos del dungeon expandido
  'Elemental de Hielo':   { tipo: 'elemental', debil: ['fuego', 'físico'], resiste: ['frío', 'agua', 'veneno'], nota: 'Muy resistente al frío. Bola de fuego es aquí tu mejor aliado. Puede huir cuando está debilitado.' },
  'Golem de Forja':       { tipo: 'constructo', debil: ['agua', 'frío'], resiste: ['fuego', 'físico', 'veneno'], nota: 'Creado en las llamas eternas de la forja. Resiste el fuego y los golpes físicos. Usa magia de agua o frío.' },
  'Campeón Espectral':    { tipo: 'no-muerto', debil: ['luz', 'sagrado'], resiste: ['físico', 'veneno', 'frío'], nota: 'El guerrero más poderoso del coliseo. Alto HP y defensa. Shield_bash para aturdirlo antes de atacar.' },
  'Krakeling Abismal':    { tipo: 'bestia', debil: ['fuego', 'electricidad'], resiste: ['agua', 'frío', 'físico'], nota: 'Criatura de las profundidades. Resistente a ataques físicos. El rayo (cast rayo) es especialmente efectivo.' },
  'Maniquí de Paja':      { tipo: 'objeto', debil: ['fuego'], resiste: [], nota: 'Objetivo de práctica. No da XP real ni loot. Ideal para testear habilidades y medir DPS.' },
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

  // BUG-031: limpiar prefijo ⭐ de monstruos élite antes de buscar en el lore
  const baseName = monster.name.startsWith('⭐ ') ? monster.name.slice(2) : monster.name;
  const lore = MONSTER_LORE[baseName] || MONSTER_LORE[monster.name];
  const { MONSTER_SPECIALS } = combat;
  const special = MONSTER_SPECIALS[baseName] || MONSTER_SPECIALS[monster.name];

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

// ─── DIS-D31: Helper compartido para evaluar estado del boss ─────────────────
// Usado por cmdCalendar y cmdDungeonStatus para mantener consistencia.
function getBossStatus() {
  const bossMonster = db.getMonster(13); // Lich Anciano
  if (!bossMonster) return { alive: false, inRespawn: false, respawnAt: null, hp: 0, maxHp: 0 };
  const now = Date.now();
  // El boss está "en respawn" si room_id es null
  // Está "disponible pero no respawneado aún" si respawn_at < now pero room_id sigue null
  // (checkRespawns corre cada 60s, puede haber una ventana de inconsistencia)
  const isAlive = bossMonster.room_id !== null && bossMonster.room_id !== undefined && (bossMonster.hp || 0) > 0;
  const respawnAt = bossMonster.respawn_at ? new Date(bossMonster.respawn_at).getTime() : null;
  const respawnReady = !isAlive && respawnAt && respawnAt <= now;
  const inRespawn = !isAlive && respawnAt && respawnAt > now;
  return {
    alive: isAlive,
    inRespawn,
    respawnReady, // respawn_at ya pasó pero checkRespawns aún no lo reposicionó
    respawnAt,
    hp: bossMonster.hp || 0,
    maxHp: bossMonster.max_hp || 0,
  };
}

// ─── T151: Comando dungeon/estado del dungeon ─────────────────────────────────
// Muestra un resumen narrativo del estado actual del dungeon: zonas peligrosas,
// boss vivo/muerto, quest activa, trampas armadas, loot disponible.
function cmdDungeonStatus(player) {
  try {
    // Obtener todas las salas
    const rooms = db.getAllRooms();

    // Monstruos vivos (room_id != null) usando db.getAllMonsters() en lugar de rawDb.exec()
    const allMonsters = db.getAllMonsters();
    const monstersAliveList = allMonsters.filter(m => m.room_id !== null && m.room_id !== undefined);
    const monsterRows = monstersAliveList.map(m => [m.id, m.name, m.room_id, m.hp, m.max_hp]);

    // Cuántos ítems en total en el suelo
    let totalItemsOnFloor = 0;
    let roomsWithItems = 0;
    let trapsArmed = 0;
    for (const room of rooms) {
      // room.items y room.trap ya están parseados por getAllRooms()
      try {
        const items = Array.isArray(room.items) ? room.items : JSON.parse(room.items || '[]');
        if (items.length > 0) { totalItemsOnFloor += items.length; roomsWithItems++; }
      } catch (_) {}
      try {
        // Fix DIS-P06: room.trap ya es objeto (parseado por getAllRooms), no string
        const trap = room.trap;
        if (trap && trap.active) trapsArmed++;
      } catch (_) {}
    }

    // Boss vivo? (Lich Anciano = monster id 13)
    // DIS-D31 fix: usar getBossStatus() compartido con cmdCalendar para consistencia
    const bossStatus = getBossStatus();
    const bossAlive = bossStatus.alive;
    const bossHp = bossStatus.hp;
    const bossMaxHp = bossStatus.maxHp;

    // Quest activa (módulo quests) — BUG-008 fix: usar getActiveQuest (no getCurrentQuest) y mostrar progreso del jugador
    let questInfo = 'Ninguna activa';
    try {
      const { getActiveQuest, getPlayerProgress } = require('./quests.js');
      const q = getActiveQuest();
      if (q) {
        const def = q.questDef || q;
        questInfo = `${def.title || def.name || def.id} — ${def.description || ''}`;
        // Mostrar progreso del jugador si hay player disponible
        if (player) {
          const freshP = db.getPlayer(player.id);
          const pp = freshP ? getPlayerProgress(freshP) : null;
          if (pp && !pp.completed) {
            questInfo += ` (${pp.progress}/${pp.goal})`;
          } else if (pp && pp.completed) {
            questInfo += ` ✅ completada`;
          }
        }
      }
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
      : bossStatus.respawnReady
        ? `  ☠ Boss: ¡Reapareciendo pronto! (checkRespawns en proceso...)`
        : `  ☠ Boss: En respawn (el dungeon respira...)`
    ;
    lines.push(`║${bossLine.padEnd(W)}║`);

    // Quest
    lines.push(`║${'  📜 Quest: '.padEnd(4)}${questInfo.slice(0, W - 9).padEnd(W - 4)}║`.slice(0, W + 2));
    lines.push(`║${'  🌍 Evento: ' + eventInfo.slice(0, 38).padEnd(40)}║`);
    const totalTraps = rooms.filter(r => r.trap).length;
    lines.push(`║${'  ⚠️  Trampas armadas: ' + trapsArmed + ' de ' + totalTraps + ' posibles'}${' '.repeat(Math.max(0, W - 22))}║`.slice(0, W + 2));
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
  // DIS-P13: Excluir salidas bloqueadas si el jugador no tiene la llave
  const playerInventory = player.inventory || [];
  const graph = {};
  for (const room of allRooms) {
    graph[room.id] = [];
    const exits = room.exits || {};
    for (const [dir, dest] of Object.entries(exits)) {
      if (typeof dest === 'object' && dest.key) {
        // Salida bloqueada por llave — solo incluir si el jugador la tiene
        const hasKey = playerInventory.some(
          item => item.toLowerCase() === dest.key.toLowerCase()
        );
        if (!hasKey) continue; // Sin llave: excluir esta arista del grafo
        if (dest.room_id) graph[room.id].push({ dir, toId: dest.room_id });
      } else {
        const destId = typeof dest === 'object' ? dest.room_id : dest;
        if (destId) graph[room.id].push({ dir, toId: destId });
      }
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

  // DIS-D14: Advertir sobre trampas activas en el camino
  const trappedRooms = [];
  found.forEach((step) => {
    const room = allRooms.find(r => r.id === step.toId);
    if (room && room.trap) {
      try {
        const trapData = typeof room.trap === 'string' ? JSON.parse(room.trap) : room.trap;
        if (trapData && trapData.active) {
          trappedRooms.push(room.name.substring(0, 22));
        }
      } catch (_) {}
    }
  });

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

  // DIS-D14: Agregar advertencia de trampas al final si las hay
  if (trappedRooms.length > 0) {
    lines.push(`⚠️  ADVERTENCIA: la ruta pasa por ${trappedRooms.length} sala${trappedRooms.length > 1 ? 's' : ''} con trampa activa:`);
    trappedRooms.forEach(name => lines.push(`   • ${name} — usá "disarm" para desactivarla (o "disarm <dirección>" desde la sala anterior)`));

    // DIS-D24: buscar ruta alternativa con menos trampas (Dijkstra con peso 5 por trampa)
    const trapRoomIds = new Set(found
      .filter(step => {
        const r = allRooms.find(x => x.id === step.toId);
        if (!r || !r.trap) return false;
        try {
          const t = typeof r.trap === 'string' ? JSON.parse(r.trap) : r.trap;
          return t && t.active;
        } catch (_) { return false; }
      })
      .map(s => s.toId));

    // Dijkstra ponderado: trampa activa = costo 5, sala normal = costo 1
    const dist = {}; const prev = {}; const prevDir = {};
    for (const r of allRooms) { dist[r.id] = Infinity; }
    dist[startId] = 0;
    const pq = [{ id: startId, cost: 0 }];
    while (pq.length > 0) {
      pq.sort((a, b) => a.cost - b.cost);
      const { id, cost } = pq.shift();
      if (cost > dist[id]) continue;
      for (const edge of (graph[id] || [])) {
        const r = allRooms.find(x => x.id === edge.toId);
        let trapCost = 1;
        if (r && r.trap) {
          try {
            const t = typeof r.trap === 'string' ? JSON.parse(r.trap) : r.trap;
            if (t && t.active) trapCost = 5;
          } catch (_) {}
        }
        const newCost = cost + trapCost;
        if (newCost < dist[edge.toId]) {
          dist[edge.toId] = newCost;
          prev[edge.toId] = id;
          prevDir[edge.toId] = edge.dir;
          pq.push({ id: edge.toId, cost: newCost });
        }
      }
    }
    // Reconstruir ruta ponderada
    if (dist[targetRoom.id] < Infinity) {
      const altPath = [];
      let cur = targetRoom.id;
      while (cur !== startId) {
        altPath.unshift({ dir: prevDir[cur], toId: cur });
        cur = prev[cur];
        if (!cur) break;
      }
      const altTraps = altPath.filter(step => trapRoomIds.has(step.toId)).length;
      if (altTraps < trappedRooms.length && altPath.length > 0) {
        lines.push(`💡 Ruta alternativa con menos trampas (${altTraps} trampa${altTraps !== 1 ? 's' : ''}):   ${altPath.map(s => `move ${DIR_NAMES[s.dir] || s.dir}`).join('; ')}`);
      }
    }
  }

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
  const min = Math.floor(remainingMs / 60000);
  const sec = Math.floor((remainingMs % 60000) / 1000);
  const remainingStr = min > 0 ? `${min}m ${sec}s` : `${sec}s`;

  const EFFECT_DESC = {
    'monster_damage_plus_1': '⚠️  Los monstruos hacen +1 de daño.',
    'xp_multiplier_11':     '🌟 La XP ganada se multiplica ×1.1.',
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

  // ── Buscar en la tienda de Aldric (SHOP_CATALOG) ───────────────────────────
  const shopMatches = SHOP_CATALOG.filter(i => norm(i.name).includes(query));

  // ── Buscar en tabla de forage y forage bonus de salas ─────────────────────
  const forageMatches = FORAGE_TABLE.filter(e => e.type === 'item' && norm(e.item).includes(query));
  const forageRoomMatches = Object.entries(ROOM_FORAGE_BONUS)
    .filter(([, v]) => norm(v.item).includes(query))
    .map(([roomId, v]) => ({ roomId: Number(roomId), item: v.item }));

  const foundAnything = matchMonsters.length > 0 || roomsWithItem.length > 0 || monstersWithLoot.length > 0
    || shopMatches.length > 0 || forageMatches.length > 0 || forageRoomMatches.length > 0;

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

  // ── Tienda de Aldric ───────────────────────────────────────────────────────
  if (shopMatches.length > 0) {
    lines.push(`║  🏪 EN LA TIENDA DE ALDRIC (Sala 4)              ║`);
    lines.push(`╠${border}╣`);
    for (const si of shopMatches) {
      const priceLine = `${si.name} — ${si.price}g`;
      lines.push(`║  💰 ${priceLine.substring(0, W - 5).padEnd(W - 5)}  ║`);
      lines.push(`║    ${si.description.substring(0, W - 4).padEnd(W - 4)}  ║`);
    }
    lines.push(`╠${border}╣`);
  }

  // ── Forage ─────────────────────────────────────────────────────────────────
  if (forageMatches.length > 0 || forageRoomMatches.length > 0) {
    lines.push(`║  🌿 OBTENIBLE POR FORAGE/BUSCAR                  ║`);
    lines.push(`╠${border}╣`);
    if (forageMatches.length > 0) {
      const forageNames = forageMatches.map(e => e.item).join(', ');
      lines.push(`║    Explorando salas (cmd forage): ${forageNames.substring(0, W - 37).padEnd(W - 37)}  ║`);
    }
    for (const fr of forageRoomMatches) {
      const frRoom = allRooms.find(r => r.id === fr.roomId);
      const frLine = `Sala ${fr.roomId}: ${frRoom ? frRoom.name : '?'} (alta prob)`;
      lines.push(`║    📍 ${frLine.substring(0, W - 7).padEnd(W - 7)}  ║`);
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
      '  Hechizos ×1.5 de poder. Regen de maná 6× más rápido.',
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
    // Calcular el ATK nuevo correctamente: base (sin arma actual) + bonus nueva arma
    const prevWeaponBonusPreview = player.equipped_weapon ? (items.getItemDef(player.equipped_weapon)?.amount || 0) : 0;
    const baseAtkPreview = currentAtk - prevWeaponBonusPreview;
    const newAtk = baseAtkPreview + def.amount;
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
    // DIS-D281: calcular correctamente — defensa desnuda (sin armadura actual) + bonus nueva armadura
    const currentArmorAmount = player.equipped_armor ? (items.getItemDef(player.equipped_armor)?.amount || 0) : 0;
    const nakedDef = (currentDef || 2) - currentArmorAmount;
    const newDef = nakedDef + def.amount;
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
  // DIS-D31 fix: usar getBossStatus() para consistencia con cmdDungeonStatus
  lines.push(`║ ${'👑 BOSS'.padEnd(W - 2)} ║`);
  const bossCalendarStatus = getBossStatus();
  if (bossCalendarStatus.alive) {
    const lichHpPct = Math.round((bossCalendarStatus.hp / bossCalendarStatus.maxHp) * 100);
    lines.push(`║  ${'Lich Anciano'.padEnd(20)} ${'⚔ VIVO'.padEnd(14)} HP: ${lichHpPct}%`.padEnd(W + 1) + '║');
  } else if (bossCalendarStatus.respawnReady) {
    lines.push(`║  ${'Lich Anciano'.padEnd(20)} ${'⚡ ¡ya disponible!'.padEnd(30)}`.padEnd(W + 1) + '║');
  } else if (bossCalendarStatus.inRespawn) {
    const respawnMs = bossCalendarStatus.respawnAt - now;
    lines.push(`║  ${'Lich Anciano'.padEnd(20)} ${'💤 en respawn'.padEnd(14)} en: ${fmt(respawnMs)}`.padEnd(W + 1) + '║');
  } else {
    lines.push(`║  ${'Lich Anciano'.padEnd(20)} ${'❓ estado desconocido'.padEnd(30)}`.padEnd(W + 1) + '║');
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

  // ── Cuenco Sagrado de la Capilla (DIS-D48) ───────────────────────────────
  lines.push(`╠${'═'.repeat(W)}╣`);
  lines.push(`║ ${'🙏 CUENCO SAGRADO (sala 5 — Capilla)'.padEnd(W - 2)} ║`);
  const bowlLastUsed = chapelBowlCooldowns.get(player.id) || 0;
  const bowlRemMs = CHAPEL_BOWL_COOLDOWN_MS - (now - bowlLastUsed);
  if (bowlRemMs > 0) {
    lines.push(`║  ${'Estado: En recarga (solo tuyo)'.padEnd(28)} disponible en: ${fmt(bowlRemMs)}`.padEnd(W + 1) + '║');
  } else {
    lines.push(`║  ${'Estado: ✅ Disponible — recupera 40% HP (cooldown personal)'}`.padEnd(W + 1) + '║');
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
    const newLevel = xpSystem.levelFromXp(newXp);
    const levelUp = newLevel > (freshP.level || 1);
    const updates = { xp: newXp, gold: newGold };
    if (levelUp) {
      updates.level = newLevel;
      updates.max_hp = (freshP.max_hp || 30) + 5;
      const healTrivia = Math.ceil(updates.max_hp * 0.20);
      updates.hp = Math.min(updates.max_hp, (freshP.hp || 1) + healTrivia);
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
      expiresAt: now + 90000, // 90s (más tiempo para que varios lo intenten)
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
    ROOM_TRIVIA_COOLDOWNS.set(roomId, now + 5 * 60000);

    // Recompensa al ganador — mismo patrón que cmdTrivia
    const freshWinner = db.getPlayer(player.id);
    const newXp   = (freshWinner.xp || 0) + 15;
    const newGold = (freshWinner.gold || 0) + 8;
    const newLevel = xpSystem.levelFromXp(newXp);
    const levelUp  = newLevel > (freshWinner.level || 1);
    const updates = { xp: newXp, gold: newGold };
    if (levelUp) {
      updates.level = newLevel;
      updates.max_hp = (freshWinner.max_hp || 30) + 5;
      const healPub = Math.ceil(updates.max_hp * 0.20);
      updates.hp = Math.min(updates.max_hp, (freshWinner.hp || 1) + healPub);
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
// T211: cmdBattlecry — Grito de batalla personal al atacar
// ══════════════════════════════════════════════════════════════════════════════
function cmdBattlecry(player, args) {
  if (!args || args.length === 0) {
    const fresh = db.getPlayer(player.id);
    const current = fresh.battlecry;
    const lines = [];
    lines.push(`══ ⚔️ Tu Grito de Batalla ══`);
    if (current) {
      lines.push(`Actual: "${current}"`);
      lines.push(`Usá: battlecry clear  — para borrarlo.`);
    } else {
      lines.push(`(Sin grito configurado)`);
    }
    lines.push(`Usá: battlecry <texto> — para establecer tu grito (máx 60 chars).`);
    lines.push(`Se muestra a todos en la sala al inicio de cada combate.`);
    return { text: lines.join('\n') };
  }

  const subCmd = args[0].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (subCmd === 'clear' || subCmd === 'borrar' || subCmd === 'quitar') {
    db.updatePlayer(player.id, { battlecry: null });
    return { text: `⚔️ Grito de batalla eliminado. Ahora atacarás en silencio.` };
  }

  const text = args.join(' ').trim().slice(0, 60);
  if (text.length < 2) return { text: 'El grito debe tener al menos 2 caracteres.' };

  db.updatePlayer(player.id, { battlecry: text });
  return { text: `⚔️ Grito de batalla configurado: "${text}"\n¡La sala entera lo escuchará cuando ataques!` };
}

// ══════════════════════════════════════════════════════════════════════════════
// T200: cmdVault — Bóveda personal (hasta 20 ítems, sala 1 o sala 17)
// DIS-506: ampliada de 10→20 slots, accesible también en Casa de Subastas (sala 17)
// ══════════════════════════════════════════════════════════════════════════════
const VAULT_MAX = 20;
const VAULT_ROOMS = new Set([1, 17]); // Entrada + Casa de Subastas
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
    lines.push(`║  ${`${vaultItems.length}/${VAULT_MAX} ítems guardados`.padEnd(W - 2)}║`);
    lines.push(`╠${'═'.repeat(W)}╣`);
    lines.push(`║  vault store <ítem>  — guardar un ítem`.padEnd(W + 2) + `║`);
    lines.push(`║  vault take <ítem>   — sacar un ítem`.padEnd(W + 2) + `║`);
    lines.push(`╠${'═'.repeat(W)}╣`);
    lines.push(`║  Accesible en sala 1 (Entrada) y sala 17 (Subastas)`.padEnd(W + 2) + `║`);
    lines.push(`╚${'═'.repeat(W)}╝`);
    return { text: lines.join('\n') };
  }

  const subcmd = args[0].toLowerCase();
  const itemArg = args.slice(1).join(' ').trim();

  // Accesible en sala 1 (Entrada) o sala 17 (Casa de Subastas)
  if (!VAULT_ROOMS.has(player.current_room_id)) {
    return { text: '🏛️  La bóveda es accesible en la Entrada (sala 1) o en la Casa de Subastas (sala 17).\n  Usá `recall` para volver a la Entrada.' };
  }

  if (subcmd === 'store' || subcmd === 'guardar' || subcmd === 'depositar') {
    if (!itemArg) return { text: '¿Qué ítem querés guardar? Ej: vault store espada oxidada' };
    if (vaultItems.length >= VAULT_MAX) return { text: `🏛️  La bóveda está llena (${VAULT_MAX}/${VAULT_MAX}). Sacá algo primero.` };

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
    return { text: `🏛️  "${item}" guardado en la bóveda. (${vaultItems.length}/${VAULT_MAX})` };
  }

  if (subcmd === 'take' || subcmd === 'sacar' || subcmd === 'retirar') {
    if (!itemArg) return { text: '¿Qué ítem querés sacar? Ej: vault take espada oxidada' };

    const norm = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    const idx = vaultItems.findIndex(i => norm(i) === norm(itemArg) || norm(i).includes(norm(itemArg)));
    if (idx === -1) return { text: `No tenés "${itemArg}" en la bóveda.` };

    const item = vaultItems[idx];
    const inv = JSON.parse(typeof player.inventory === 'string' ? player.inventory : JSON.stringify(player.inventory));
    const maxInvVault = 25 + (player.inventory_bonus || 0); // DIS-595
    if (inv.length >= maxInvVault) return { text: `🎒 El inventario está lleno (${inv.length}/${maxInvVault}). Tirá algo primero.` };

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

// ══════════════════════════════════════════════════════════════════════════════
// T208: cmdWeekly — Resumen de actividad de los últimos 7 días
// ══════════════════════════════════════════════════════════════════════════════
function cmdWeekly(player) {
  const stats = db.getWeeklyStats(player.id);
  const W = 44;
  const lines = [];
  lines.push(`╔${'═'.repeat(W)}╗`);
  lines.push(`║${'  📅 RESUMEN SEMANAL (últimos 7 días)'.padEnd(W)}║`);
  lines.push(`╠${'═'.repeat(W)}╣`);

  if (!stats) {
    lines.push(`║${'  Sin sesiones registradas esta semana.'.padEnd(W)}║`);
    lines.push(`║${'  Volvé a conectarte para que se guarden'.padEnd(W)}║`);
    lines.push(`║${'  tus próximas sesiones.'.padEnd(W)}║`);
    lines.push(`╚${'═'.repeat(W)}╝`);
    return { text: lines.join('\n') };
  }

  const toHM = (min) => {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };

  const row = (label, value) => {
    const l = `  ${label}`;
    const v = String(value);
    return `║${l.padEnd(W - v.length - 1)}${v} ║`;
  };

  lines.push(row('⚡ Sesiones jugadas:', stats.sessions));
  lines.push(row('⏱  Tiempo total:', toHM(stats.totalMin)));
  lines.push(row('⚔️  Kills totales:', stats.totalKills));
  lines.push(row('✨ XP ganada:', '+' + stats.totalXP));
  lines.push(row('🪙 Oro acumulado:', '+' + stats.totalGold));
  lines.push(row('🎮 Comandos ejecutados:', stats.totalCmds));
  lines.push(`╠${'═'.repeat(W)}╣`);
  lines.push(row('🏆 Mejor sesión (kills):', stats.bestKills));
  lines.push(row('⌛ Sesión más larga:', toHM(stats.bestMin)));
  lines.push(`╚${'═'.repeat(W)}╝`);

  // Pequeño dato motivacional
  const avg = stats.sessions > 0 ? Math.round(stats.totalKills / stats.sessions) : 0;
  if (avg > 0) {
    lines.push(`  Promedio: ${avg} kill${avg !== 1 ? 's' : ''} por sesión esta semana.`);
  }

  return { text: lines.join('\n') };
}


// ══════════════════════════════════════════════════════════════════════════════
// T209: cmdTips — Consejos estratégicos por tema
// ══════════════════════════════════════════════════════════════════════════════
function cmdTips(args) {
  const TIPS = {
    combate: [
      '⚔️  Elegí tu postura (stance) según la situación: agresivo para matar rápido, defensivo para survivir.',
      '💥 Los combos de ataque dan hasta +4 dmg extra al 5x — no cambies de objetivo si tenés un combo alto.',
      '🔮 Usá hechizos: bola-de-fuego hace 10 dmg fijos, útil contra monstruos con mucha defensa.',
      '⚡ Con nivel 3+ tenés smash (×1.8 daño). Con nivel 6+ tenés shield_bash (stun). ¡Úsalos!',
      '🐾 Tu mascota puede atacar automáticamente — la araña y serpiente también envenenan monstruos.',
      '🛡️  Si tu arma tiene runa de hielo (enchant hielo), el monstruo puede perder un turno.',
      '💉 Llevar siempre 2+ pociones de vida. El boss hace hasta 12 dmg por turno.',
      '🏃 Huir (flee) te mueve a otra sala automáticamente — úsalo para curar y volver.',
    ],
    crafteo: [
      '⚗️  Usá "lore <ítem>" para ver qué recetas de crafteo usan ese ítem como ingrediente.',
      '🗡️  Receta estrella: núcleo de forja + espada oxidada = espada de obsidiana (mejor arma básica).',
      '💉 Receta útil: hierba curativa + poción de salud = poción de vida (cura más HP).',
      '❄️  Receta rara: fragmento de hielo + cristal helado = lanza espectral (arma de élite).',
      '🔪 Veneno concentrado + cuchillo = cuchillo envenenado (35% de envenenar en cada golpe).',
      '🍄 El Túnel de los Hongos (sala 6) es buen lugar para "forage" y conseguir hierbas.',
      '⛏️  Usá "survey" antes de "forage" en una sala — aumenta 20% las chances de encontrar materiales.',
      '🏆 Craftear 5 ítems desbloquea el logro secreto "Artesano".',
    ],
    clases: [
      '⚔️  Guerrero: el más resistente (35 HP, 6 ATK). Ideal para matar al boss y tankear.',
      '🔮 Mago: maná alto y hechizos ×1.5. Regen de maná doble. Mejor daño mágico del juego.',
      '🗡️  Pícaro: 25% de crítico y 20% de esquiva. Excelente para grinding rápido y duelos PvP.',
      '🔄 Podés cambiar de clase libremente hasta 5 kills totales. Después es permanente.',
      '📊 El Pícaro + postura agresiva + combo máximo puede hacer hasta 18+ daño en un golpe.',
      '🧙 El Mago + hechizo escudo (+5 DEF) + postura defensiva = tanque mágico sorprendente.',
      '💀 El boss Lich Anciano drena maná — el Guerrero no se ve afectado tanto como el Mago.',
    ],
    economia: [
      '🪙 Oro = kills + loot + quests. El boss Lich Anciano da 50 monedas extra al morir.',
      '💰 Reputación Respetado+ da descuento en la tienda: -5%/-10%/-15% según nivel.',
      '🛒 Sell en la tienda (mercader Aldric, sala 4) da solo 40% del precio. Mejor guardar ítems buenos.',
      '⚖️  "market post <ítem> <precio>" para vender al precio que vos querés en el mercado de jugadores.',
      '🏦 Guardá ítems en la bóveda (vault) en sala 1 o sala 17 — hasta 20 slots. No los perdés si morís.',
      '💸 "pay <jugador> <monto>" para transferir oro. Útil para coordinación de guild.',
      '🎁 Los monstruos de élite (Lich, Campeón Espectral) sueltan ítems épicos — mejor que comprarlos.',
    ],
    exploracion: [
      '🗺️  Usá "path <sala>" para calcular la ruta más corta a cualquier sala del dungeon.',
      '👁️  "peek <dirección>" mira una sala sin entrar — ideal para evitar trampas y monstruos.',
      '🌟 Cada sala nueva que visitás en una sesión da +2 XP de bonus.',
      '⚠️  Cuatro salas tienen trampas activas: desactivarlas con el ítem correcto las desactiva para todos.',
      '🏔️  El dungeon tiene 22 salas (más sala de práctica). El minimapa muestra ⚔ donde hay monstruos vivos.',
      '🔐 La sala 7 (Mazmorra) requiere la llave oxidada que está en sala 8.',
      '⛪ La sala 1 tiene regen sagrada de +1 HP cada 10s si tu HP no está al máximo.',
      '🌊 La sala 18 (Fuente Eterna) restaura HP completo con "beber" — cooldown global de 10 min.',
    ],
    social: [
      '👥 Formá un grupo (party) para compartir XP cuando matan en la misma sala (75% del atacante).',
      '🏰 Los guilds tienen misiones colectivas — completarlas da +50 XP y +30 oro a todos los miembros.',
      '💬 "say" para hablar en la sala, "shout" para hablar globalmente, "whisper" para mensajes privados.',
      '🏆 Los duelos PvP ganan/pierden 10% del oro del perdedor. Las bounties se cobran automáticamente.',
      '👋 Saludar mutuamente con "greet" en 30 segundos da +1 reputación a ambos jugadores.',
      '📋 "bulletin post <mensaje>" para anunciar cosas al servidor entero (expires 6h).',
    ],
  };

  const TOPICS = Object.keys(TIPS);
  const W = 52;

  if (!args || args.length === 0) {
    // Menú de temas
    const lines = [];
    lines.push(`╔${'═'.repeat(W)}╗`);
    lines.push(`║${'  💡 TIPS ESTRATÉGICOS — Elegí un tema'.padEnd(W)}║`);
    lines.push(`╠${'═'.repeat(W)}╣`);
    TOPICS.forEach((t, i) => {
      const labels = {
        combate: '⚔️  Combate y habilidades',
        crafteo: '⚗️  Crafteo y alquimia',
        clases: '🎭  Clases de personaje',
        economia: '🪙  Economía y comercio',
        exploracion: '🗺️  Exploración del dungeon',
        social: '👥  Multijugador y social',
      };
      const label = labels[t] || t;
      lines.push(`║  ${String(i + 1).padStart(1)}. ${label.padEnd(W - 5)}║`);
    });
    lines.push(`╠${'═'.repeat(W)}╣`);
    lines.push(`║${'  Usá: tips <tema>  (ej: tips combate)'.padEnd(W)}║`);
    lines.push(`╚${'═'.repeat(W)}╝`);
    return { text: lines.join('\n') };
  }

  const query = args.join(' ').toLowerCase()
    .replace(/á/g, 'a').replace(/é/g, 'e').replace(/í/g, 'i')
    .replace(/ó/g, 'o').replace(/ú/g, 'u').replace(/ó/g, 'o');

  // Buscar tema por nombre o número
  let topic = null;
  const idx = parseInt(query, 10);
  if (!isNaN(idx) && idx >= 1 && idx <= TOPICS.length) {
    topic = TOPICS[idx - 1];
  } else {
    topic = TOPICS.find(t => t.startsWith(query) || query.startsWith(t.slice(0, 4)));
  }

  if (!topic) {
    return { text: `❓ Tema no encontrado. Usá: tips [${TOPICS.join('|')}]` };
  }

  const tipList = TIPS[topic];
  const lines = [];
  lines.push(`╔${'═'.repeat(W)}╗`);
  lines.push(`║${'  💡 TIPS: ' + topic.toUpperCase() + '  '.padEnd(W - ('  💡 TIPS: '.length + topic.length))}║`);
  lines.push(`╠${'═'.repeat(W)}╣`);
  tipList.forEach(tip => {
    // Partir líneas largas
    const words = tip.split(' ');
    let line = '';
    words.forEach(w => {
      if ((line + ' ' + w).trim().length > W - 4) {
        if (line) lines.push(`║  ${line.padEnd(W - 3)}║`);
        line = w;
      } else {
        line = (line + ' ' + w).trim();
      }
    });
    if (line) lines.push(`║  ${line.padEnd(W - 3)}║`);
    lines.push(`║${''.padEnd(W)}║`);
  });
  // Quitar última línea vacía si sobra
  if (lines[lines.length - 1] === `║${''.padEnd(W)}║`) lines.pop();
  lines.push(`╚${'═'.repeat(W)}╝`);
  lines.push(`  Otros temas: ${TOPICS.filter(t => t !== topic).join(', ')}`);

  return { text: lines.join('\n') };
}

// ══════════════════════════════════════════════════════════════════════════════
// T210: cmdGoals — Objetivos personales calculados on-the-fly
// Muestra qué cosas el jugador está cerca de lograr.
// ══════════════════════════════════════════════════════════════════════════════
function cmdGoals(player) {
  const fresh = db.getPlayer(player.id);
  if (!fresh) return { text: '❌ Error al cargar tu personaje.' };

  const level  = fresh.level || 1;
  const xp     = fresh.xp   || 0;
  const kills  = fresh.kills || 0;
  const gold   = fresh.gold  || 0;
  const rep    = fresh.reputation || 0;
  const mana   = fresh.mana  || 0;
  const maxMana = fresh.max_mana || 20;
  const hp     = fresh.hp;
  const maxHp  = fresh.max_hp;
  const achievements = JSON.parse(fresh.achievements || '[]');
  const bestiary = JSON.parse(fresh.bestiary || '{}');
  const craftsCount = fresh.crafts_count || 0;
  const deaths  = fresh.deaths || 0;
  const goldSpent = fresh.gold_spent || 0;
  const duelWins = fresh.duel_wins || 0;
  const dbPlaytime = fresh.playtime_minutes || 0;
  const sessData = context && context.sessionData;
  const sessMinutes = sessData && sessData.startTime ? Math.floor((Date.now() - sessData.startTime) / 60000) : 0;
  const playtime = dbPlaytime + sessMinutes;
  const roomsVisited = fresh.rooms_visited || 0;

  const goals = [];
  const done  = [];

  // ─── DIS-D16/DIS-D17: Metas de end-game (tienen prioridad — van al inicio) ──
  // Para jugadores que ya mataron al boss: mostrar primero las metas de end-game
  if (achievements.includes('boss_killer')) {
    // Bestiario completo — "Conquistador del Dungeon"
    const bestiaryKeys = Object.keys(bestiary).filter(k => k !== 'Goblin de Práctica');
    const TOTAL_MONSTER_TYPES = 14; // tipos únicos en el dungeon (sin el goblin práctica)
    if (bestiaryKeys.length < TOTAL_MONSTER_TYPES) {
      goals.push(`📖 Conquistador del Dungeon: enfrentá ${TOTAL_MONSTER_TYPES - bestiaryKeys.length} tipos de monstruo más (bestiario: ${bestiaryKeys.length}/${TOTAL_MONSTER_TYPES})`);
    } else {
      done.push(`📖👑 ¡Bestiario completo! Sos un verdadero Conquistador del Dungeon. (${bestiaryKeys.length}/${TOTAL_MONSTER_TYPES} tipos)`);
    }
    // Nivel 20 como techo real
    if (level < 20) {
      const xpToMax = xpSystem.xpForLevel(20) - xp;
      goals.push(`👑 Alcanzar el nivel 20 (nivel máximo legendario): ${level}/20 — faltan ${xpToMax} XP`);
    } else {
      done.push(`👑 ¡Nivel 20 alcanzado! Sos una leyenda viviente del dungeon.`);
    }
    // (Logro Masacre Total se maneja abajo en el bloque general, sin duplicar)
  }

  // ─── Progresión de nivel ───────────────────────────────────────────────────
  const xpForNext = xpSystem.xpForNextLevel(level) - xpSystem.xpIntoLevel(xp, level);
  if (level < xpSystem.MAX_LEVEL) {
    goals.push(`⬆️  Subir al nivel ${level + 1}: faltan ${xpForNext} XP (tenés ${xpSystem.xpIntoLevel(xp, level)}/${xpSystem.xpForNextLevel(level)})`);
  }

  // ─── Habilidades por nivel ─────────────────────────────────────────────────
  if (level < 3) {
    goals.push(`⚡ Desbloquear habilidad SMASH: llegá al nivel 3 (nivel actual: ${level})`);
  } else if (level < 6) {
    goals.push(`🛡️  Desbloquear SHIELD_BASH: llegá al nivel 6 (nivel actual: ${level})`);
  } else if (level < 10) {
    goals.push(`📣 Desbloquear RALLY (buff de grupo): llegá al nivel 10 (nivel actual: ${level})`);
  }

  // ─── Reputación ───────────────────────────────────────────────────────────
  const REP_TIERS = [
    { threshold: 10,  label: 'Conocido',    discount: 'sin descuento todavía' },
    { threshold: 25,  label: 'Respetado',   discount: '-5% en tienda' },
    { threshold: 75,  label: 'Famoso',      discount: '-10% en tienda' },
    { threshold: 150, label: 'Legendario',  discount: '-15% en tienda' },
  ];
  const nextRep = REP_TIERS.find(t => rep < t.threshold);
  if (nextRep) {
    goals.push(`⭐ Ser ${nextRep.label} (${nextRep.discount}): faltan ${nextRep.threshold - rep} puntos de reputación (tenés ${rep})`);
  }

  // ─── Logros secretos ─────────────────────────────────────────────────────
  // Solo mostrar logros secretos YA desbloqueados (como recordatorio de completados),
  // NUNCA revelar requisitos de logros secretos aún no obtenidos.
  // (Los logros secretos sin desbloquear deben sorprender al jugador al conseguirlos.)

  // ─── Kills para logros ────────────────────────────────────────────────────
  if (kills < 10 && !achievements.includes('diez_kills')) {
    goals.push(`⚔️  Logro "Asesino en Serie": necesitás ${10 - kills} kills más`);
  } else if (kills < 50 && !achievements.includes('cien_kills')) {
    goals.push(`⚔️  Logro "Masacre Total": necesitás ${50 - kills} kills más (tenés ${kills})`);
  }

  // ─── Veterano ─────────────────────────────────────────────────────────────
  if (playtime < 60 && !achievements.includes('veterano_dungeon')) {
    goals.push(`🏰 Logro secreto "Veterano del Dungeon": jugá ${60 - playtime} minutos más (acumulaste ${playtime}min)`);
  }

  // ─── Boss ─────────────────────────────────────────────────────────────────
  if (!achievements.includes('boss_killer')) {
    goals.push(`💀 Logro "Cazador de Lich": matá al Lich Anciano en sala 15 (Catedral Maldita)`);
  } else {
    // DIS-D291: Post-boss goals
    goals.push(`📖 Escribe "legado" para ver tus desafíos de endgame disponibles`);
  }

  // ─── Duelos ───────────────────────────────────────────────────────────────
  if (duelWins === 0) {
    goals.push(`🥊 Ganar tu primer duelo PvP: retá a alguien con "duel <jugador>"`);
  }

  // ─── Crafteo ──────────────────────────────────────────────────────────────
  if (craftsCount === 0) {
    goals.push(`🔧 Probar el crafteo por primera vez: usá "recetas" y luego "craft"`);
  }

  const W = 54;
  const lines = [];
  lines.push(`╔${'═'.repeat(W)}╗`);
  lines.push(`║${'  🎯 TUS PRÓXIMOS OBJETIVOS'.padEnd(W)}║`);
  lines.push(`╠${'═'.repeat(W)}╣`);

  if (goals.length === 0) {
    lines.push(`║${'  ¡Sos una leyenda del dungeon! No hay metas'.padEnd(W)}║`);
    lines.push(`║${'  pendientes obvias — crea las tuyas propias.'.padEnd(W)}║`);
  } else {
    // Mostrar máximo 6 objetivos para no abrumar
    const toShow = goals.slice(0, 6);
    toShow.forEach(g => {
      // Partir líneas largas en dos si superan W-4
      if (g.length > W - 4) {
        // Cortar en el espacio más cercano al W/2
        const half = Math.floor((W - 4) * 0.6);
        const cut = g.lastIndexOf(' ', half);
        const a = cut > 0 ? g.slice(0, cut) : g.slice(0, W - 4);
        const b = cut > 0 ? g.slice(cut + 1) : g.slice(W - 4);
        lines.push(`║  ${a.padEnd(W - 3)}║`);
        if (b) lines.push(`║     ${b.padEnd(W - 5)}║`);
      } else {
        lines.push(`║  ${g.padEnd(W - 3)}║`);
      }
    });
    if (goals.length > 6) {
      lines.push(`╠${'═'.repeat(W)}╣`);
      lines.push(`║${'  ... y ' + (goals.length - 6) + ' objetivos más por descubrir.'.padEnd(W)}║`);
    }
  }
  lines.push(`╚${'═'.repeat(W)}╝`);

  return { text: lines.join('\n') };
}

// ══════════════════════════════════════════════════════════════════════════════
// DIS-D291: cmdLegado — Historial épico del héroe post-boss
// Muestra ciclos completados, mejores tiempos, desafíos disponibles
// ══════════════════════════════════════════════════════════════════════════════
function cmdLegado(player, context) {
  const fresh = db.getPlayer(player.id);
  if (!fresh) return { text: '❌ Error al cargar tu personaje.' };

  const lichKills = fresh.lich_kills || 0;
  const bestTime = fresh.cycle_best_time;
  const dbPlaytime = fresh.playtime_minutes || 0;
  const sessData = context && context.sessionData;
  const sessMinutes = sessData && sessData.startTime ? Math.floor((Date.now() - sessData.startTime) / 60000) : 0;
  const playtime = dbPlaytime + sessMinutes;
  const kills = fresh.kills || 0;
  const deaths = fresh.deaths || 0;
  const level = fresh.level || 1;
  let achievements = [];
  try { achievements = JSON.parse(fresh.achievements || '[]'); } catch (_) {}

  const W = 56;
  const lines = [];
  lines.push(`╔${'═'.repeat(W)}╗`);

  if (lichKills === 0) {
    lines.push(`║${'  📖 LEGADO DE ' + (fresh.username || 'AVENTURERO').toUpperCase().substring(0, 30).padEnd(42)}║`);
    lines.push(`╠${'═'.repeat(W)}╣`);
    lines.push(`║${'  Aún no has derrotado al Lich Anciano.'.padEnd(W)}║`);
    lines.push(`║${'  Tu legado comienza cuando la primera filacteria'.padEnd(W)}║`);
    lines.push(`║${'  caiga hecha polvo en la Catedral Maldita.'.padEnd(W)}║`);
    lines.push(`╠${'═'.repeat(W)}╣`);
    lines.push(`║${'  🎯 Objetivo: ve al norte hasta sala 15'.padEnd(W)}║`);
    lines.push(`║${'  y enfrenta al Lich Anciano.'.padEnd(W)}║`);
  } else {
    // Medalla de ciclo
    let cycleMedal = '⚔️';
    let cycleTitle = 'Cazador de Liches';
    if (lichKills >= 10) { cycleMedal = '🏆'; cycleTitle = 'Exterminador Legendario'; }
    else if (lichKills >= 5) { cycleMedal = '💎'; cycleTitle = 'Maestro del Dungeon'; }
    else if (lichKills >= 3) { cycleMedal = '🥇'; cycleTitle = 'Conquistador Veterano'; }
    else if (lichKills >= 2) { cycleMedal = '🥈'; cycleTitle = 'Cazador Experimentado'; }

    lines.push(`║  ${(cycleMedal + ' LEGADO DE ' + (fresh.username || '').toUpperCase()).substring(0, W - 2).padEnd(W - 1)}║`);
    lines.push(`║  ${cycleTitle.padEnd(W - 1)}║`);
    lines.push(`╠${'═'.repeat(W)}╣`);
    lines.push(`║${'  ☠️  Ciclos completados: ' + lichKills + (lichKills === 1 ? ' (¡tu primera victoria!)' : '')}`.padEnd(W + 1) + '║');

    if (bestTime !== null && bestTime !== undefined) {
      const bHrs = Math.floor(bestTime / 60);
      const bMins = bestTime % 60;
      const bestStr = bHrs > 0 ? `${bHrs}h ${bMins}min` : `${bMins} minutos`;
      lines.push(`║  ⏱️  Mejor ciclo: ${bestStr.padEnd(W - 19)}║`);
    }

    lines.push(`║  📊 Stats: Nv.${level} | ${kills} kills | ${deaths} muertes | ${playtime}min jugados`.padEnd(W + 1) + '║');
    lines.push(`╠${'═'.repeat(W)}╣`);

    // Desafíos desbloqueados según ciclos
    lines.push(`║${'  🎯 DESAFÍOS DEL ENDGAME:'.padEnd(W)}║`);

    const hasCartographer = achievements.includes('cartografo');
    const hasHardcore = fresh.is_hardcore === 1;
    const hasFallen = fresh.fallen === 1;

    // Ciclo 1+: speed-run
    const speedStatus = lichKills >= 2 && bestTime !== null && bestTime <= 30 ? '✅' : '⬜';
    lines.push(`║  ${speedStatus} Speed-run: matar al Lich en menos de 30min`.padEnd(W + 1) + '║');

    // Ciclo 1+: cartógrafo
    const cartStatus = hasCartographer ? '✅' : '⬜';
    lines.push(`║  ${cartStatus} Cartógrafo: visitar TODAS las salas del dungeon`.padEnd(W + 1) + '║');

    // Ciclo 2+: sin pociones
    if (lichKills >= 2) {
      lines.push(`║  ⬜ Sin pociones: derrotá al Lich sin usar pociones`.padEnd(W + 1) + '║');
    }

    // Ciclo 3+: hardcore
    if (lichKills >= 3 && !hasHardcore) {
      lines.push(`║  ⬜ Modo Hardcore: activalo con "hardcore" y volvé`.padEnd(W + 1) + '║');
    } else if (hasHardcore && hasFallen) {
      lines.push(`║  ⭐ Hardcore completado (caíste pero fue legendario)`.padEnd(W + 1) + '║');
    } else if (hasHardcore) {
      lines.push(`║  💀 Actualmente en Modo Hardcore — ¡sin muertes!`.padEnd(W + 1) + '║');
    }

    // Ciclo 5+: bestiario completo
    if (lichKills >= 5) {
      const hasConquistador = achievements.includes('conquistador_dungeon');
      const conquStatus = hasConquistador ? '✅' : '⬜';
      lines.push(`║  ${conquStatus} Conquistador: registrar los 14 tipos de monstruo`.padEnd(W + 1) + '║');
    }

    // Logros secretos sin desbloquear (sin revelar cuáles)
    const allAchIds = require('./achievements').ACHIEVEMENTS.map(a => a.id);
    const missing = allAchIds.filter(id => !achievements.includes(id)).length;
    if (missing > 0) {
      lines.push(`╠${'═'.repeat(W)}╣`);
      lines.push(`║  🔒 ${missing} logro(s) sin desbloquear — seguí explorando`.padEnd(W + 1) + '║');
    }
  }

  lines.push(`╚${'═'.repeat(W)}╝`);
  return { text: lines.join('\n') };
}


// Solo disponible en sala 17 (Casa de Subastas)
// ─────────────────────────────────────────────────────────────────────────────
// T217: Mini-juego de apuestas — gamble/apostar <cantidad>
const gamblingCooldowns = new Map(); // playerId → timestamp del último juego

function cmdGamble(player, args) {
  const GAMBLING_ROOM   = 17;
  const COOLDOWN_MS     = 2 * 60 * 1000; // 2 minutos
  const MIN_BET         = 5;
  const MAX_BET         = 100;
  const WIN_MULTIPLIER  = 1.8;
  const BIG_WIN_NOTIFY  = 80; // si gana más de esto → crónica

  if (player.current_room_id !== GAMBLING_ROOM) {
    return { text: '🎲 Las apuestas solo se hacen en la Casa de Subastas (sala 17).\n   Movete al este desde la Cámara del Tesoro (sala 4).' };
  }

  // Verificar cooldown
  const now      = Date.now();
  const lastPlay = gamblingCooldowns.get(player.id) || 0;
  const remaining = Math.ceil((lastPlay + COOLDOWN_MS - now) / 1000);
  if (remaining > 0) {
    return { text: `⏳ Todavía necesitás esperar ${remaining}s antes de volver a apostar.` };
  }

  // Parsear monto
  const raw    = (args || []).join(' ').trim();
  const amount = parseInt(raw, 10);
  if (!amount || isNaN(amount) || amount < MIN_BET) {
    return { text: `🎲 Uso: apostar <cantidad>  (mínimo ${MIN_BET}g, máximo ${MAX_BET}g)` };
  }
  if (amount > MAX_BET) {
    return { text: `🎲 La Casa no acepta apuestas mayores a ${MAX_BET}g por ronda.` };
  }

  const fresh = db.getPlayer(player.id);
  if (!fresh || fresh.gold < amount) {
    return { text: `❌ No tenés suficiente oro. Tenés ${fresh ? fresh.gold : 0}g.` };
  }

  // Tirar los dados: 2d6 cada uno
  function roll2d6() {
    return Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6) + 1;
  }

  const playerRoll = roll2d6();
  const houseRoll  = roll2d6();

  // Actualizar cooldown
  gamblingCooldowns.set(player.id, now);

  let outcome, goldDelta, resultText;

  if (playerRoll > houseRoll) {
    // Victoria
    goldDelta  = Math.floor(amount * WIN_MULTIPLIER) - amount; // ganancia neta
    const totalGain = Math.floor(amount * WIN_MULTIPLIER);
    db.updatePlayer(player.id, { gold: fresh.gold - amount + totalGain });
    outcome    = 'victoria';
    resultText = `🎉 ¡GANÁS! Recibís ${totalGain}g (apostaste ${amount}g, ganás ${goldDelta}g de beneficio).`;
  } else if (playerRoll < houseRoll) {
    // Derrota
    goldDelta = -amount;
    db.updatePlayer(player.id, { gold: fresh.gold - amount });
    outcome   = 'derrota';
    resultText = `😞 PERDÉS. La Casa se lleva tus ${amount}g.`;
  } else {
    // Empate — devuelve la apuesta
    goldDelta = 0;
    outcome   = 'empate';
    resultText = `🤝 EMPATE. La apuesta de ${amount}g es devuelta.`;
  }

  const newGold    = fresh.gold + goldDelta;
  const diceReport = `  Vos: 🎲${playerRoll}  |  Casa: 🎲${houseRoll}`;

  const W    = 50;
  const lines = [
    `╔${'═'.repeat(W)}╗`,
    `║${'  🎰 CASA DE APUESTAS — DUNGEON OF ECHOES'.padEnd(W)}║`,
    `╠${'═'.repeat(W)}╣`,
    `║${('  Jugador: ' + player.username + ' · Apuesta: ' + amount + 'g').padEnd(W)}║`,
    `║${diceReport.padEnd(W)}║`,
    `╠${'═'.repeat(W)}╣`,
    `║${('  ' + resultText).padEnd(W)}║`,
    `║${('  Oro actual: 💰 ' + newGold + 'g').padEnd(W)}║`,
    `╚${'═'.repeat(W)}╝`,
  ];

  const boxText     = lines.join('\n');
  const broadcastMsg = outcome === 'victoria'
    ? `🎰 ${player.username} apuesta ${amount}g y ¡GANA ${Math.floor(amount * WIN_MULTIPLIER)}g! 🎉 (🎲${playerRoll} vs 🎲${houseRoll})`
    : outcome === 'derrota'
    ? `🎰 ${player.username} apuesta ${amount}g y pierde. (🎲${playerRoll} vs 🎲${houseRoll})`
    : `🎰 ${player.username} apuesta ${amount}g — empate. (🎲${playerRoll} vs 🎲${houseRoll})`;

  // Registrar gran ganancia en crónica global
  if (outcome === 'victoria' && goldDelta >= BIG_WIN_NOTIFY) {
    db.logGlobalEvent('gambling_win', `🎰 ${player.username} ganó ${goldDelta}g apostando en la Casa de Subastas. ¡Fortuna bendita!`);
  }

  return {
    text: boxText,
    event: broadcastMsg,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// T218: Notas de exploración por sala — roomnote/mnota [add <texto>|list|del <n>]
// ─────────────────────────────────────────────────────────────────────────────
function cmdRoomNote(player, args) {
  const MAX_NOTES_PER_ROOM = 3;
  const MAX_ROOMS_WITH_NOTES = 10;
  const MAX_TEXT_LEN = 120;

  const fresh = db.getPlayer(player.id);
  const roomId = String(fresh.current_room_id);

  // Parsear room_notes desde BD
  let roomNotes = {};
  try {
    roomNotes = JSON.parse(fresh.room_notes || '{}');
  } catch (_) { roomNotes = {}; }

  const sub = (args && args[0] || 'list').toLowerCase();

  // ── LIST (sin args o "list") ──────────────────────────────────────────────
  if (sub === 'list' || sub === 'listar' || sub === 'ver') {
    const notes = roomNotes[roomId] || [];
    if (notes.length === 0) {
      const room = db.getRoom(fresh.current_room_id);
      return { text: `📋 No tenés notas en ${room ? room.name : 'esta sala'}.\n  Usá: mnota add <texto>  para agregar una.` };
    }
    const room = db.getRoom(fresh.current_room_id);
    const W = 54;
    const lines = [
      `╔${'═'.repeat(W)}╗`,
      `║${'  📋 NOTAS — ' + (room ? room.name : 'Sala ' + roomId).slice(0, W - 12) + ''.padEnd(2)}`.padEnd(W + 1) + '║',
      `╠${'═'.repeat(W)}╣`,
    ];
    notes.forEach((n, i) => {
      const ts = n.created_at ? n.created_at.slice(11, 16) : '';
      const prefix = `  ${i + 1}. `;
      const maxLen = W - prefix.length;
      const text = n.text.length > maxLen ? n.text.slice(0, maxLen - 1) + '…' : n.text;
      lines.push(`║${(prefix + text).padEnd(W)}║`);
      if (ts) lines.push(`║${'     [' + ts + ']'.padEnd(W - 5)}║`);
    });
    lines.push(`╠${'═'.repeat(W)}╣`);
    lines.push(`║${'  mnota add <texto>  ·  mnota del <n>'.padEnd(W)}║`);
    lines.push(`╚${'═'.repeat(W)}╝`);
    return { text: lines.join('\n') };
  }

  // ── ADD ───────────────────────────────────────────────────────────────────
  if (sub === 'add' || sub === 'agregar' || sub === 'nueva' || sub === 'anotar') {
    const text = args.slice(1).join(' ').trim();
    if (!text) {
      return { text: '❌ Usá: mnota add <texto de la nota>' };
    }
    if (text.length > MAX_TEXT_LEN) {
      return { text: `❌ La nota no puede superar ${MAX_TEXT_LEN} caracteres.` };
    }

    // Verificar límite de salas con notas
    const roomsWithNotes = Object.keys(roomNotes).filter(k => roomNotes[k] && roomNotes[k].length > 0);
    if (!roomNotes[roomId] && roomsWithNotes.length >= MAX_ROOMS_WITH_NOTES) {
      return { text: `❌ Ya tenés notas en ${MAX_ROOMS_WITH_NOTES} salas distintas. Borrá notas viejas primero.` };
    }

    if (!roomNotes[roomId]) roomNotes[roomId] = [];

    if (roomNotes[roomId].length >= MAX_NOTES_PER_ROOM) {
      return { text: `❌ Ya tenés ${MAX_NOTES_PER_ROOM} notas en esta sala. Borrá una primero con: mnota del <n>` };
    }

    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    roomNotes[roomId].push({ text, created_at: now });
    db.updatePlayer(player.id, { room_notes: JSON.stringify(roomNotes) });

    const room = db.getRoom(fresh.current_room_id);
    return { text: `📋 Nota agregada en ${room ? room.name : 'esta sala'} (${roomNotes[roomId].length}/${MAX_NOTES_PER_ROOM}):\n  "${text}"` };
  }

  // ── DEL ───────────────────────────────────────────────────────────────────
  if (sub === 'del' || sub === 'borrar' || sub === 'eliminar' || sub === 'delete') {
    const idx = parseInt(args[1], 10);
    const notes = roomNotes[roomId] || [];
    if (!idx || isNaN(idx) || idx < 1 || idx > notes.length) {
      return { text: `❌ Usá: mnota del <número>  (del 1 al ${notes.length || 1})` };
    }
    const removed = notes.splice(idx - 1, 1)[0];
    if (notes.length === 0) delete roomNotes[roomId];
    db.updatePlayer(player.id, { room_notes: JSON.stringify(roomNotes) });
    return { text: `📋 Nota #${idx} eliminada:\n  "${removed.text}"` };
  }

  // ── ROOMS (listar todas las salas con notas) ─────────────────────────────
  if (sub === 'all' || sub === 'todas' || sub === 'mapa' || sub === 'salas') {
    const entries = Object.entries(roomNotes).filter(([, notes]) => notes && notes.length > 0);
    if (entries.length === 0) {
      return { text: '📋 No tenés notas en ninguna sala todavía.' };
    }
    const W = 54;
    const lines = [
      `╔${'═'.repeat(W)}╗`,
      `║${'  📋 SALAS CON NOTAS'.padEnd(W)}║`,
      `╠${'═'.repeat(W)}╣`,
    ];
    entries.forEach(([rid, notes]) => {
      const room = db.getRoom(parseInt(rid, 10));
      const name = room ? room.name : `Sala ${rid}`;
      lines.push(`║${('  Sala ' + rid + ' — ' + name + ' (' + notes.length + ' nota' + (notes.length > 1 ? 's' : '') + ')').padEnd(W)}║`);
    });
    lines.push(`╚${'═'.repeat(W)}╝`);
    return { text: lines.join('\n') };
  }

  return { text: '📋 Uso:\n  mnota [list]           — Ver notas de la sala actual\n  mnota add <texto>      — Agregar nota\n  mnota del <número>     — Borrar nota\n  mnota salas            — Ver todas las salas con notas' };
}


// ── DIS-487: cmdPronunciar — Easter egg de Kaelthas Vorn ─────────────────────
/**
 * El jugador pronuncia un nombre en voz alta. Si pronuncia el nombre verdadero
 * de Kaelthas en ciertos lugares sagrados (Sala del Trono, Catedral, Cripta),
 * ocurre un efecto especial de lore + XP.
 *
 * Nombre conocido: "Kaelthas Vorn" (revelado por Aldric)
 * Nombre verdadero: "Kaelthas Valdrath" (revelado al matar al Lich Anciano)
 * Lugar correcto: Sala 9 (Trono), 15 (Catedral), 22 (Cripta)
 */
function cmdPronunciar(player, nameInput) {
  if (!nameInput || !nameInput.trim()) {
    return { text: '¿Qué nombre querés pronunciar? Ej: pronunciar Kaelthas Vorn' };
  }

  const name = nameInput.trim().toLowerCase();
  const roomId = player.current_room_id;

  // Salas donde el efecto tiene peso: Trono (9), Catedral (15), Cripta (22)
  const SACRED_ROOMS = new Set([9, 15, 22]);

  // Nombre verdadero: Kaelthas Valdrath (revelado por el bestiario al matar al Lich)
  const isValdrath = ['kaelthas valdrath', 'valdrath', 'kaelthas vorn valdrath'].some(n => name.includes(n));
  // Nombre conocido: Kaelthas Vorn (revelado por Aldric)
  const isVorn = name.includes('kaelthas vorn') || name === 'vorn';
  // Solo "Kaelthas" sin apellido
  const isKaelthas = name.includes('kaelthas') && !isVorn && !isValdrath;

  // Leer estado fresco del jugador
  const fresh = db.getPlayer(player.id);

  if (isValdrath && SACRED_ROOMS.has(roomId)) {
    // ── EL EASTER EGG REAL ────────────────────────────────────────────────────
    const xpGained = 150;
    const newXp = (fresh.xp || 0) + xpGained;
    db.updatePlayer(player.id, { xp: newXp });
    db.addJournalEntry(player.id, 'lore', '✨ Pronuncié el nombre verdadero de Kaelthas en el lugar correcto. El dungeon lo escuchó. Algo se desplazó, levemente, como si un peso muy antiguo cambiara de posición.');

    let roomText = '';
    if (roomId === 9) {
      roomText = 'El trono de huesos vibra. Un polvo muy fino cae de las junturas, como si el armazón respondiera al sonido de ese nombre. La sala entera permanece en silencio un segundo demasiado largo.\n\nEntonces, en los brazos del trono, la inscripción KAELTHAS cambia. Por un instante —solo un instante— podés leer el nombre completo: KAELTHAS VALDRATH. Y luego vuelve a ser solo KAELTHAS, como siempre.';
    } else if (roomId === 15) {
      roomText = 'La Catedral retumba. No como un terremoto —como una campana. Un golpe único, profundo, que sentís en el pecho antes que en los oídos.\n\nLas velas que nunca nadie encendió arden por un momento con una llama azul. Luego se apagan.';
    } else if (roomId === 22) {
      roomText = 'La Cripta de los Valientes responde. Las placas en las paredes vibran con un tintineo metálico suave, como monedas.\n\nDe algún lugar detrás de las paredes, escuchás pasos. Uno. Dos. Tres. Y luego nada.\n\nUna de las placas —nueva, sin nombre— brilla por un segundo antes de volver a ser piedra oscura.';
    }

    return { text: `Tomás aire y pronunciás las dos palabras:\n\n"${nameInput.trim()}"\n\n${roomText}\n\n✨ El dungeon lo escuchó. +${xpGained} XP.` };

  } else if (isValdrath) {
    // Nombre correcto, lugar incorrecto
    return { text: 'Pronunciás el nombre en voz alta. La piedra absorbe el sonido como siempre.\n\nNada pasa. Quizás no es el lugar correcto.' };

  } else if (isVorn && SACRED_ROOMS.has(roomId)) {
    // Nombre conocido (pero no el verdadero) en lugar sagrado — pista de que falta algo
    return { text: '"Kaelthas Vorn" resuena en las paredes de la sala.\n\nAlgo cambia en el aire — una tensión, casi una expectativa. Pero no pasa nada más.\n\nComo si el dungeon supiera que ese nombre está incompleto.' };

  } else if (isVorn) {
    return { text: 'El nombre de Kaelthas Vorn sale de tu boca con más peso de lo esperado. Como si el dungeon lo reconociera.\n\nPero nada más ocurre.' };

  } else if (isKaelthas) {
    if (SACRED_ROOMS.has(roomId)) {
      return { text: '"Kaelthas..."\n\nEl nombre incompleto rebota en las paredes. Como un eco que no termina de repetirse.\n\nTenés la sensación de que falta algo. Que pronunciar solo la mitad del nombre es... insuficiente.' };
    }
    return { text: 'El nombre de Kaelthas resuena suavemente. Pero sin el apellido, sin el nombre completo, no es más que un sonido.' };

  } else {
    const safeName = nameInput.trim().slice(0, 40);
    return { text: `Pronunciás "${safeName}" en voz alta. El dungeon no reacciona.\n\n💡 Si tenés lore sobre un nombre especial, pronunciarlo en el lugar correcto podría tener efecto.` };
  }
}

module.exports = { execute, getOrCreatePlayer, ROOM_EFFECTS, resolveExpiredAuctions, getTitle, regenMana, SPELL_CATALOG, getClassReminder, cmdBestiary, cmdProfile, cmdJournal, cmdServerStats, cmdTime, cmdEnemies, cmdCompare, cmdReputation, cmdChallenge, cmdContract, clearAfk, isAfk, killStreakMap, sessionExploredRooms, STANCES, sessionCommandHistory, cmdWeather, cmdHardcore, toRoman, cmdMemorial, cmdCalendar, FORAGE_REST_ROOMS, cmdEnchant, comboMap, cmdWorldGoals, checkAndSetRecords };

