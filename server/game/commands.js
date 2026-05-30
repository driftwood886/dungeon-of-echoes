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
  score: 'score', ranking: 'score', scores: 'score', tabla: 'score', marcador: 'score',
  // give / dar
  give: 'give', dar: 'give', entregar: 'give', pasar: 'give', ofrecer: 'give',
  // pay / pagar / transferir oro
  pay: 'pay', pagar: 'pay', transferir: 'pay', enviar: 'pay', mandar: 'pay',
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
  // disarm / desactivar trampa
  disarm: 'disarm', desactivar: 'disarm', desarmar: 'disarm', trampa: 'disarm',
  // rest / descansar
  rest: 'rest', descansar: 'rest', dormir: 'rest', recuperar: 'rest', campear: 'rest',
  // meditate / meditar (T097)
  meditate: 'meditate', meditar: 'meditate', contemplar: 'meditate', concentrarse: 'meditate', zen: 'meditate',
  // emote / acción
  emote: 'emote', acción: 'emote', accion: 'emote', me: 'emote', hacer: 'emote',
  // say
  say: 'say', decir: 'say', hablar: 'say',
  // shout
  shout: 'shout', gritar: 'shout', grito: 'shout',
  // help
  help: 'help', ayuda: 'help', '?': 'help',
  // buy / comprar (mercader)
  buy: 'buy', comprar: 'buy', adquirir: 'buy', obtener: 'buy',
  // sell / vender (mercader)
  sell: 'sell', vender: 'sell', intercambiar: 'sell',
  // shop / tienda (listar tienda)
  shop: 'shop', tienda: 'shop', mercader: 'shop', comerciante: 'shop', wares: 'shop', lista: 'shop',
  // achievements / logros
  achievements: 'achievements', logros: 'achievements', logro: 'achievements', medallas: 'achievements',
  // inspect / inspeccionar jugador
  inspect: 'inspect', inspeccionar: 'inspect', observar: 'inspect', ver_jugador: 'inspect',
  // quest / misión
  quest: 'quest', misión: 'quest', mision: 'quest', tarea: 'quest', objetivo: 'quest',
  // guild / hermandad
  guild: 'guild', hermandad: 'guild', gremio: 'guild', clan: 'guild', faccion: 'guild', facción: 'guild',
  // gc / guild chat
  gc: 'gc', gchat: 'gc', guildchat: 'gc',
  // duel / duelo PvP
  duel: 'duel', duelo: 'duel', retar: 'duel', desafiar: 'duel', pvp: 'duel',
  // accept / aceptar duelo
  accept: 'accept', aceptar: 'accept', acepto: 'accept',
  // decline / rechazar duelo
  decline: 'decline', rechazar: 'decline', rechazo: 'decline', negar: 'decline',
  // world / evento global
  world: 'world', evento: 'world', mundo: 'world', dungeon_event: 'world', 'evento-dungeon': 'world',
  // craft / craftear
  craft: 'craft', craftear: 'craft', fabricar: 'craft', combinar: 'craft', alquimia: 'craft', crear: 'craft', forjar: 'craft',
  // recipes / recetas
  recipes: 'recipes', recetas: 'recipes', libro_recetas: 'recipes',
  // news / crónica / historial de eventos globales (T093)
  news: 'news', cronica: 'news', crónica: 'news', noticias: 'news', historial: 'news', diario: 'news',
  // forage / buscar ítems ocultos (T094)
  forage: 'forage', buscar: 'forage', explorar: 'forage', hurgar: 'forage', rebuscar: 'forage', rastrear: 'forage',
  // pet / mascota (T095)
  pet: 'pet', mascota: 'pet', compañero: 'pet', familiar: 'pet',
  // auction / subasta (T098)
  auction: 'auction', subasta: 'auction', subastar: 'auction', rematar: 'auction', vender_subasta: 'auction',
  // bid / pujar (T098)
  bid: 'bid', pujar: 'bid', puja: 'bid', apostar: 'bid', ofrecer_oro: 'bid',
  // auctions / listar subastas (T098)
  auctions: 'auctions', subastas: 'auctions', remates: 'auctions', mercado: 'auctions', sala_subasta: 'auctions',
  // dice / dados (T100)
  dice: 'dice', dado: 'dice', dados: 'dice', tirar: 'dice', roll: 'dice', rodar: 'dice',
  // drink / beber (T103)
  drink: 'drink', beber: 'drink', tomar: 'drink', hidratarse: 'drink', fuente: 'drink',
  // party / grupo (T102)
  party: 'party', grupo: 'party', equipo: 'party', alianza: 'party',
  // cast / lanzar hechizo (T104)
  cast: 'cast', lanzar: 'cast', hechizar: 'cast', invocar: 'cast', magic: 'cast',
  // spells / hechizos (T104)
  spells: 'spells', hechizos: 'spells', magia: 'spells', conjuros: 'spells', grimorios: 'spells',
  // clase / class (T107)
  clase: 'clase', class: 'clase', profesion: 'clase', profesión: 'clase', vocacion: 'clase', vocación: 'clase', oficio: 'clase',
  // bestiary (T108)
  bestiary: 'bestiary', bestiario: 'bestiary', monstruos: 'bestiary', cazados: 'bestiary', bitacora: 'bestiary', bitácora: 'bestiary',
  // profile (T109)
  profile: 'profile', perfil: 'profile', tarjeta: 'profile', ficha: 'profile', carnet: 'profile',
  // journal / diario (T113)
  journal: 'journal', diario: 'journal', bitacora2: 'journal', memorias: 'journal', cronica_personal: 'journal', historial_personal: 'journal',
  // skills / habilidades (T114)
  skills: 'skills', habilidades: 'skills', habilidad: 'skills', poderes: 'skills', capacidades: 'skills',
  // useSkill — habilidades activas de combate (T114)
  smash: 'useSkill', golpetazo: 'useSkill', golpe_potente: 'useSkill', destrozo: 'useSkill',
  // eslint-disable-next-line camelcase
  shield_bash: 'useSkill', escudo_bash: 'useSkill', bash: 'useSkill', escudazo: 'useSkill', golpe_escudo: 'useSkill',
  rally: 'useSkill', arenga: 'useSkill', motivar: 'useSkill', grito_batalla: 'useSkill',
  // note / apunte (T116)
  note: 'note', apunte: 'note', apuntes: 'note', notas: 'note', nota: 'note', memo: 'note', memos: 'note',
  // changelog / novedades (T117)
  changelog: 'changelog', novedades: 'changelog', actualizaciones: 'changelog', updates: 'changelog', parche: 'changelog', patch: 'changelog',
  // server stats (T119)
  server: 'server', estadísticas: 'server', estadisticas: 'server', serverstats: 'server', uptime: 'server', info: 'server',
  // time (T121)
  time: 'time', hora: 'time', reloj: 'time', horario: 'time', 'qué-hora': 'time', periodo: 'time',
  // enemies (T122)
  enemies: 'enemies', enemigos: 'enemies', mobs: 'enemies', bestias: 'enemies', criaturas: 'enemies', 'top-enemies': 'enemies', top: 'enemies',
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
  emote <acción>        — Expresar una acción visible para todos en la sala (ej: emote sonríe)
  rest / descansar      — Recuperar HP si no hay monstruos (cooldown 60s)
  inspect <jugador>     — Examinar a otro aventurero en la misma sala
  quest / misión        — Ver la quest activa y tu progreso
  guild <acción>        — Gestionar tu hermandad (create/join/leave/info/list)
  gc <mensaje>          — Chat de hermandad (solo ven los miembros del mismo guild)
  duel <jugador>        — Retar a un duelo PvP a otro aventurero en la misma sala
  accept                — Aceptar el reto de duelo pendiente
  decline               — Rechazar el reto de duelo pendiente
  world / evento        — Ver el evento global activo del dungeon (si hay alguno)
  craft <ítem1> con <ítem2> — Combinar dos ítems del inventario para crear algo nuevo
  recipes / recetas     — Ver el libro de recetas de crafteo conocidas
  news / crónica        — Ver el historial de eventos globales del dungeon
  forage / buscar       — Explorar la sala en busca de ítems ocultos (cooldown 3 min, sin monstruos)
  pet [adopt <tipo>]    — Adoptar una mascota (rata, murciélago, araña, etc.) o ver tu compañero
  dados <NdM>           — Tirar dados (ej: dados 2d6, dice 1d20). Resultado visible para toda la sala
  party [<jugador>]     — Gestionar tu grupo: invitar/unirse, ver miembros, party leave para salir
  beber / drink         — Beber de la Fuente Eterna (sala 18): restaura HP completo. Cooldown global 10 min
  cast <hechizo>        — Lanzar un hechizo (bola de fuego, escudo, curación). Requiere maná
  hechizos / spells     — Ver tus hechizos disponibles y el maná actual
  clase                 — Ver o elegir tu clase de personaje (guerrero/mago/pícaro)
  bestiario             — Ver tu registro de monstruos cazados con estadísticas
  perfil / profile      — Tarjeta de aventurero completa con todos los stats en formato visual
  diario / journal      — Ver tu diario personal: logros, subidas de nivel, muertes y boss derrotados
  skills / habilidades  — Ver tus habilidades activas desbloqueadas y sus cooldowns (Lv3/6/10)
  smash / golpetazo     — Habilidad: golpe potente ×1.8 daño (requiere Nivel 3, cooldown 45s)
  bash / escudo_bash    — Habilidad: golpe de escudo + stun al monstruo 1 turno (Nivel 6, 60s)
  rally / arenga        — Habilidad: +2 ATK al grupo en la sala por 60s (Nivel 10, 2min)
  note / apunte         — Notas personales: "note add <texto>" para agregar, "note list" para ver, "note del <n>" para borrar
  changelog / novedades — Ver las últimas actualizaciones y mejoras del juego
  server / estadísticas — Ver estadísticas globales del servidor (jugadores, kills, oro, uptime)
  time / hora           — Ver la hora actual del servidor y el período del día (amanecer/mediodía/atardecer/noche)
  enemies [N] / top [N] — Ver los N monstruos más poderosos del dungeon (vivos y en respawn con tiempo restante)

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
  score:     'score / ranking\n  Ver la tabla de líderes global: los 10 mejores por kills, XP y nivel.',
  say:       'say <mensaje> / decir <mensaje>\n  Hablar con los jugadores que están en la misma sala.',
  shout:     'shout <mensaje> / gritar <mensaje>\n  Gritar un mensaje que todos los jugadores del dungeon escuchan.',
  whisper:   'whisper <jugador> <mensaje> / susurrar <jugador> <mensaje>\n  Enviar un mensaje privado a otro jugador (en cualquier sala). Solo el destinatario lo ve.',
  tell:      'tell <jugador> <mensaje>\n  Igual que whisper pero con persistencia offline: si el jugador no está conectado, el mensaje\n  se guarda en la BD y se le entrega la próxima vez que haga login.',
  reply:     'reply <mensaje> / responder <mensaje>\n  Contestar automáticamente al último jugador que te envió un whisper o tell,\n  sin necesidad de escribir su nombre. Atajo: "r <mensaje>".',
  unlock:    'unlock / abrir <dir> / desbloquear <dir>\n  Abrir permanentemente una puerta bloqueada usando la llave del inventario.\n  La puerta queda abierta para todos los jugadores. La llave se consume.',
  emote:     'emote <acción> / accion <acción> / me <acción>\n  Expresar una acción en tercera persona visible para todos en la sala.\n  Ej: "emote suspira profundo" → todos ven: "✨ NombreJugador suspira profundo"',
  help:      'help / ayuda\n  Mostrar la lista de comandos.\n  help <comando>: ayuda detallada sobre un comando específico.',
  inspect:   'inspect <jugador> / inspeccionar <jugador>\n  Examinar a otro aventurero que esté en la misma sala.\n  Muestra su nivel, HP, arma equipada, kills, muertes y logros desbloqueados.',
  guild:     'guild create <nombre>  — Crear una nueva hermandad (cuestan 50 oro)\\nguild join <nombre>    — Unirse a una hermandad existente\\nguild leave            — Abandonar tu hermandad actual\\nguild info             — Ver info de tu hermandad (miembros, líder)\\nguild list             — Listar todas las hermandades activas',
    gc:        'gc <mensaje> / gchat <mensaje>\\n  Enviar un mensaje al chat de hermandad. Solo los miembros de tu guild lo verán.\\n  Aparece en formato: [GUILD NombreGuild] TuNombre: mensaje',
    party:     'party / grupo\\n  Ver los miembros de tu grupo actual.\\nparty <nombre>\\n  Invitar a un jugador de tu sala a unirse al grupo.\\nparty accept / aceptar\\n  Aceptar una invitación de grupo pendiente.\\nparty decline / rechazar\\n  Rechazar una invitación de grupo.\\nparty leave / salir\\n  Abandonar el grupo actual.\\nGrupos: máximo 4 miembros. Al matar un monstruo, los compañeros en la misma sala reciben 75% de la XP.',
    craft:     'craft <ítem1> con <ítem2> / craftear <ítem1> + <ítem2>\\n  Combinar dos ítems de tu inventario para crear un nuevo objeto.\\n  Los ítems originales se consumen. Usá "recetas" para ver las combinaciones disponibles.',
    recipes:   'recipes / recetas\\n  Ver el libro de recetas de crafteo conocidas.\\n  Mostrá todas las combinaciones posibles de dos ingredientes y su resultado.',
    news:      'news / crónica / noticias\\n  Ver la crónica de eventos globales del dungeon.\\n  Registra automáticamente: boss derrotado, quests completadas, logros desbloqueados, duelos ganados y subidas de nivel importantes.',
    forage:    'forage / buscar / explorar\\n  Buscar ítems ocultos en la sala actual.\\n  Cooldown de 3 minutos por sala. No funciona si hay monstruos vivos.\\n  Podés encontrar: hierbas curativas, pociones, monedas de oro, materiales de crafteo.',
    auction:   'subasta <ítem> <precio_min> / auction <item> <min_price>\\n  Poner un ítem tuyo a subasta en la Casa de Subastas (sala 17, al este de la Cámara del Tesoro).\\n  La subasta dura 5 minutos. El ítem se retira de tu inventario inmediatamente.\\n  Si hay ganador: el vendedor recibe el oro, el ganador recibe el ítem.\\n  Si nadie puja: el ítem vuelve al vendedor.',
    bid:       'pujar <id_subasta> <monto> / bid <auction_id> <amount>\\\\n  Realizar una puja en una subasta activa.\\\\n  La puja debe ser mayor a la puja actual. Si alguien supera tu puja, recibís tu oro de vuelta.\\\\n  El oro se descuenta al pujar y se devuelve si te superan.',
    auctions:  'subastas / auctions / remates\\\\\\\\n  Ver todas las subastas activas en la Casa de Subastas.\\\\\\\\n  Muestra: ID, ítem, precio mínimo, puja actual, tiempo restante y vendedor.',
    dice:      'dados <NdM> / dice <NdM> / roll <NdM>\\\\\\\\n  Tirar dados en la sala. Ej: \\\"dados 2d6\\\" tira dos dados de 6 caras.\\\\\\\\n  El resultado es visible para todos los jugadores presentes en la sala.\\\\\\\\n  Formatos soportados: 1d4, 1d6, 1d8, 1d10, 1d12, 1d20, 1d100, hasta 10d100.',
    drink:     'drink / beber / tomar\\n  Beber de la Fuente Eterna en la Cámara de la Fuente Eterna (sala 18, al norte del Santuario Profano).\\n  Restaura tu HP completamente.\\n  Cooldown GLOBAL de 10 minutos: una vez que alguien bebe, la fuente tarda 10 min en recargarse.\\n  Nadie puede usarla durante ese tiempo. No funciona si ya estás al máximo de HP.',
    journal:   'journal / diario\\n  Ver tu diario personal de aventurero.\\n  Se registra automáticamente cuando: derrotes un boss, completes una quest, desbloquees un logro, subas de nivel o mueras.\\n  Muestra las últimas 10 entradas con tipo, fecha y descripción.',
    enemies:   'enemies [N] / enemigos [N] / top [N]\\n  Ver los N monstruos más poderosos del dungeon (ordenados por HP máximo).\\n  Muestra: nombre, estado (vivo/respawn), sala donde habitan y estadísticas.\\n  N es opcional, por defecto 10. Máximo 20.',
  };

  module.exports = { parse, HELP_TEXT, COMMAND_HELP };
