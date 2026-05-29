/**
 * commands.js — Parser de comandos texto → acción estructurada
 *
 * Toma una cadena de texto libre y la convierte en un objeto { command, args }
 * que el motor del juego puede ejecutar.
 *
 * Comandos soportados:
 *   look / mirar
 *   move <dir> / ir <dir> / <dir>
 *   inventory / inv / i / inventario
 *   status / stats / estado
 *   attack <monstruo> / atacar <monstruo>
 *   pick <ítem> / tomar <ítem> / recoger <ítem>
 *   use <ítem> / usar <ítem>
 *   say <mensaje> / decir <mensaje>
 *   shout <mensaje> / gritar <mensaje>
 *   help / ayuda
 */

'use strict';

const { normalizeDirection } = require('./dungeon');

// Mapa: alias → comando canónico
const COMMAND_ALIASES = {
  // look
  look: 'look', mirar: 'look', ver: 'look', l: 'look',
  // move
  move: 'move', ir: 'move', go: 'move', caminar: 'move',
  // inventory
  inventory: 'inventory', inv: 'inventory', i: 'inventory', inventario: 'inventory',
  // status
  status: 'status', stats: 'status', estado: 'status', stat: 'status',
  // attack
  attack: 'attack', atacar: 'attack', ataque: 'attack', golpear: 'attack', kill: 'attack',
  // pick
  pick: 'pick', tomar: 'pick', recoger: 'pick', agarrar: 'pick', get: 'pick',
  // use
  use: 'use', usar: 'use', utilizar: 'use',
  // heal (atajo: usar la primera poción del inventario)
  heal: 'heal', curar: 'heal', curarse: 'heal', recuperar: 'heal',
  // drop
  drop: 'drop', tirar: 'drop', soltar: 'drop', dejar: 'drop',
  // examine
  examine: 'examine', examinar: 'examine', inspeccionar: 'examine', x: 'examine',
  // equip
  equip: 'equip', equipar: 'equip', empuñar: 'equip', portar: 'equip',
  // unequip
  unequip: 'unequip', desequipar: 'unequip', guardar: 'unequip', enfundar: 'unequip',
  // map
  map: 'map', mapa: 'map',
  // who
  who: 'who', jugadores: 'who', online: 'who', quién: 'who', quien: 'who',
  // score / ranking
  score: 'score', ranking: 'score', scores: 'score', top: 'score', tabla: 'score', marcador: 'score',
  // give / dar
  give: 'give', dar: 'give', entregar: 'give', pasar: 'give', ofrecer: 'give',
  // loot / saquear
  loot: 'loot', saquear: 'loot', recoger_todo: 'loot', recogertodo: 'loot', botín: 'loot', botin: 'loot',
  // flee
  flee: 'flee', huir: 'flee', escapar: 'flee', correr: 'flee',
  // whisper / susurrar
  whisper: 'whisper', susurrar: 'whisper', murmurar: 'whisper', privado: 'whisper', msg: 'whisper', pm: 'whisper',
  // tell (como whisper pero con persistencia offline)
  tell: 'tell', mensaje: 'tell', escribir: 'tell',
  // reply (contestar el último whisper/tell recibido)
  reply: 'reply', responder: 'reply', contestar: 'reply', r: 'reply',
  // unlock / abrir puerta
  unlock: 'unlock', abrir: 'unlock', desbloquear: 'unlock', destrancar: 'unlock',
  // say
  say: 'say', decir: 'say', hablar: 'say',
  // shout
  shout: 'shout', gritar: 'shout', grito: 'shout',
  // help
  help: 'help', ayuda: 'help', '?': 'help',
};

// Dirección → comando move (shortcut: escribir "norte" ejecuta move north)
const DIRECTION_SHORTCUTS = ['north', 'south', 'east', 'west', 'up', 'down',
                             'norte', 'sur', 'este', 'oeste', 'arriba', 'abajo',
                             'n', 's', 'e', 'o', 'w'];

/**
 * Parsea una cadena de texto en una acción estructurada.
 * @param {string} input — texto crudo del jugador
 * @returns {{ command: string, args: string[], raw: string } | { command: 'unknown', input: string }}
 */
function parse(input) {
  if (!input || typeof input !== 'string') {
    return { command: 'unknown', input: '' };
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return { command: 'unknown', input: '' };
  }

  const parts = trimmed.split(/\s+/);
  const first = parts[0].toLowerCase();
  const rest  = parts.slice(1);

  // Shortcut de dirección: el jugador escribe solo "norte" → move norte
  if (DIRECTION_SHORTCUTS.includes(first) && rest.length === 0) {
    const dir = normalizeDirection(first) || first;
    return { command: 'move', args: [dir], raw: trimmed };
  }

  // Buscar alias
  const canonical = COMMAND_ALIASES[first];
  if (!canonical) {
    return { command: 'unknown', input: trimmed };
  }

  // Para 'move', normalizar la dirección
  if (canonical === 'move' && rest.length > 0) {
    const dir = normalizeDirection(rest[0]) || rest[0];
    return { command: 'move', args: [dir], raw: trimmed };
  }

  return {
    command: canonical,
    args: rest,
    raw: trimmed,
  };
}

/**
 * Texto de ayuda para el jugador.
 */
const HELP_TEXT = `
Comandos disponibles:
  look / mirar          — Describir la habitación actual
  move <dir> / ir <dir> — Moverse (norte, sur, este, oeste)
  inventory / inv       — Ver tu inventario
  status / estado       — Ver tus stats (HP, ataque, defensa)
  attack <monstruo>     — Atacar a un monstruo
  flee / huir           — Intentar huir del combate
  pick <ítem>           — Recoger un ítem del suelo
  drop <ítem>           — Tirar un ítem al suelo
  use <ítem>            — Usar un ítem (poción → consume, arma → equipar)
  equip <arma>          — Equipar un arma del inventario explícitamente
  map / mapa            — Ver el mapa ASCII del dungeon
  who / jugadores       — Ver los aventureros activos en el dungeon
  score / ranking       — Ver la tabla de líderes global
  give <ítem> <jugador> — Dar un ítem a otro jugador en la misma sala
  loot / saquear        — Recoger todos los ítems del suelo de la sala
  heal / curar          — Usar la primera poción del inventario (atajo rápido)
  unequip / desequipar  — Guardar el arma y volver a puños (ataque 5)
  examine <objetivo>    — Examinar un monstruo, ítem o la sala
  say <mensaje>         — Hablar con jugadores en la misma habitación
  shout <mensaje>       — Gritar a todo el dungeon
  help / ayuda          — Esta ayuda
  whisper <jug> <msg>   — Mensaje privado a otro jugador (en cualquier sala)
  tell <jug> <msg>      — Mensaje privado con aviso offline (llega aunque no esté conectado)
  reply <msg>           — Contestar el último whisper/tell recibido (sin escribir el nombre)
  unlock <dir>          — Abrir una puerta bloqueada usando la llave del inventario (permanente)

Atajos de dirección: n, s, e, o (oeste), w (west)
`.trim();

/**
 * Ayuda detallada por comando.
 */
const COMMAND_HELP = {
  look:      'look / mirar / l\n  Describir la habitación actual: salidas, monstruos, ítems en el suelo y otros jugadores presentes.',
  move:      'move <dir> / ir <dir> / <dir>\n  Moverse en una dirección: norte, sur, este, oeste, arriba, abajo.\n  También podés escribir solo la dirección: "norte", "n", "s", "e", "o".',
  inventory: 'inventory / inv / i / inventario\n  Mostrar los ítems que llevás encima.',
  status:    'status / estado / stats\n  Mostrar tus stats completos: HP, ataque, defensa, nivel, XP, kills y arma equipada.',
  attack:    'attack <monstruo> / atacar <monstruo>\n  Atacar a un monstruo de la sala. Un turno: vos atacás, el monstruo responde.\n  Repetí el comando para continuar hasta que uno de los dos muera.',
  flee:      'flee / huir / escapar\n  Intentar huir del combate. Hay un 60% de chance de éxito. Si falla, el monstruo ataca igual.',
  pick:      'pick <ítem> / tomar <ítem> / recoger <ítem>\n  Recoger un ítem del suelo y guardarlo en tu inventario.',
  loot:      'loot / saquear\n  Recoger TODOS los ítems del suelo de la sala de un solo golpe.',
  drop:      'drop <ítem> / tirar <ítem>\n  Tirar un ítem de tu inventario al suelo de la sala actual.',
  use:       'use <ítem> / usar <ítem>\n  Usar un ítem del inventario. Pociones: consumen y restauran HP. Armas: se equipan.',
  equip:     'equip <arma> / equipar <arma>\n  Equipar un arma del inventario explícitamente. Aumenta tu stat de ataque.',
  unequip:   'unequip / desequipar / enfundar\n  Guardar el arma equipada y volver a pelear con los puños (ataque base: 5).',
  examine:   'examine <objetivo> / examinar <objetivo> / x <objetivo>\n  Examinar un monstruo, ítem (del inventario o del suelo) o la sala.\n  Sin argumento: vista detallada de la habitación actual.',
  give:      'give <ítem> <jugador> / dar <ítem> <jugador>\n  Pasar un ítem de tu inventario a otro jugador que esté en la misma sala.',
  map:       'map / mapa\n  Ver el mapa ASCII del dungeon con tu posición marcada con ★.',
  who:       'who / jugadores / online\n  Listar todos los aventureros activos en el dungeon (vistos en los últimos 5 minutos).',
  score:     'score / ranking / top\n  Ver la tabla de líderes global: los 10 mejores por kills, XP y nivel.',
  say:       'say <mensaje> / decir <mensaje>\n  Hablar con los jugadores que están en la misma sala.',
  shout:     'shout <mensaje> / gritar <mensaje>\n  Gritar un mensaje que todos los jugadores del dungeon escuchan.',
  whisper:   'whisper <jugador> <mensaje> / susurrar <jugador> <mensaje>\n  Enviar un mensaje privado a otro jugador (en cualquier sala). Solo el destinatario lo ve.',
  tell:      'tell <jugador> <mensaje>\n  Igual que whisper pero con persistencia offline: si el jugador no está conectado, el mensaje\n  se guarda en la BD y se le entrega la próxima vez que haga login.',
  reply:     'reply <mensaje> / responder <mensaje>\n  Contestar automáticamente al último jugador que te envió un whisper o tell,\n  sin necesidad de escribir su nombre. Atajo: "r <mensaje>".',
  unlock:    'unlock / abrir <dir> / desbloquear <dir>\n  Abrir permanentemente una puerta bloqueada usando la llave del inventario.\n  La puerta queda abierta para todos los jugadores. La llave se consume.',
  help:      'help / ayuda\n  Mostrar la lista de comandos.\n  help <comando>: ayuda detallada sobre un comando específico.',
};

module.exports = { parse, HELP_TEXT, COMMAND_HELP };
