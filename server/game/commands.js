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
  // drop
  drop: 'drop', tirar: 'drop', soltar: 'drop', dejar: 'drop',
  // examine
  examine: 'examine', examinar: 'examine', inspeccionar: 'examine', x: 'examine',
  // equip
  equip: 'equip', equipar: 'equip', empuñar: 'equip', portar: 'equip',
  // map
  map: 'map', mapa: 'map',
  // who
  who: 'who', jugadores: 'who', online: 'who', quién: 'who', quien: 'who',
  // flee
  flee: 'flee', huir: 'flee', escapar: 'flee', correr: 'flee',
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
  examine <objetivo>    — Examinar un monstruo, ítem o la sala
  say <mensaje>         — Hablar con jugadores en la misma habitación
  shout <mensaje>       — Gritar a todo el dungeon
  help / ayuda          — Esta ayuda

Atajos de dirección: n, s, e, o (oeste), w (west)
`.trim();

module.exports = { parse, HELP_TEXT };
