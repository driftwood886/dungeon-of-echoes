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
  pick: 'pick', tomar: 'pick', recoger: 'pick', agarrar: 'pick', get: 'pick', take: 'pick',  // BUG-458: take es alias natural de pick
  // use
  use: 'use', usar: 'use', utilizar: 'use', open: 'use',
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
  // wear (T152: equipar armadura)
  wear: 'wear', ponerse: 'wear', vestir: 'wear', armarse: 'wear', poner: 'wear',
  // unwear (T152: quitarse armadura)
  unwear: 'unwear', quitarse: 'unwear', desvestir: 'unwear', quitar: 'unwear',
  // map
  map: 'map', mapa: 'map',
  // who
  who: 'who', jugadores: 'who', online: 'who', quién: 'who', quien: 'who',
  // score / ranking
  score: 'score', ranking: 'score', scores: 'score', tabla: 'score', marcador: 'score', leaderboard: 'score', 'top-jugadores': 'score',
  // T176: rank / mi posición en el ranking
  rank: 'rank', posicion: 'rank', posición: 'rank', miposicion: 'rank', 'mi-posicion': 'rank',
  // T175: hardcore mode
  hardcore: 'hardcore', 'modo-hardcore': 'hardcore', permadeath: 'hardcore',
  memorial: 'memorial', muro: 'memorial', homenaje: 'memorial', fallen: 'memorial', caidos: 'memorial',
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
  // inbox (bandeja de entrada de mensajes)
  inbox: 'inbox', bandeja: 'inbox', mensajes: 'inbox', buzon: 'inbox', buzón: 'inbox',
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
  // pronunciar — DIS-487: easter egg de Kaelthas Vorn (nombre completo en lugar especial)
  pronunciar: 'pronunciar', pronounce: 'pronunciar', invocar_nombre: 'pronunciar', nombrar: 'pronunciar',
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
  // talk / hablar con NPC (T242)
  talk: 'talk', hablar: 'talk', habla: 'talk', conversar: 'talk', charlar: 'talk',
  // achievements / logros
  achievements: 'achievements', logros: 'achievements', logro: 'achievements', medallas: 'achievements',
  // inspect / inspeccionar jugador
  inspect: 'inspect', inspeccionar: 'inspect', observar: 'inspect', ver_jugador: 'inspect',
  // quest / misión
  quest: 'quest', misión: 'quest', mision: 'quest', tarea: 'quest', objetivo: 'quest', quests: 'quest', misiones: 'quest',
  // guild / hermandad
  guild: 'guild', hermandad: 'guild', gremio: 'guild', clan: 'guild', faccion: 'guild', facción: 'guild',
  // guild quest — atajo directo
  'guild quest': 'guild', 'misión guild': 'guild', 'mision guild': 'guild',
  // gc / guild chat
  gc: 'gc', gchat: 'gc', guildchat: 'gc',
  // duel / duelo PvP
  duel: 'duel', duelo: 'duel', retar: 'duel', desafiar: 'duel', pvp: 'duel',
  bounty: 'bounty', recompensa: 'bounty', cabeza: 'bounty',
  bounties: 'bounties', recompensas: 'bounties', tablero: 'bounties',
  // T174: wanted / se busca
  wanted: 'wanted', 'se-busca': 'wanted', sebusca: 'wanted', buscado: 'wanted', carteles: 'wanted',
  // accept / aceptar duelo
  accept: 'accept', aceptar: 'accept', acepto: 'accept',
  // decline / rechazar duelo
  decline: 'decline', rechazar: 'decline', rechazo: 'decline', negar: 'decline',
  // world / evento global
  world: 'world', evento: 'world', mundo: 'world', dungeon_event: 'world', 'evento-dungeon': 'world',
  recent: 'recent', recientes: 'recent', 'chat-log': 'recent', ultimos: 'recent', últimos: 'recent', 'chat-reciente': 'recent',
  // T166: clima
  weather: 'weather', clima: 'weather', tiempo: 'weather', atmosfera: 'weather', atmósfera: 'weather',
  // craft / craftear
  craft: 'craft', craftear: 'craft', fabricar: 'craft', combinar: 'craft', alquimia: 'craft', crear: 'craft', forjar: 'craft',
  crafting: 'recipes', // BUG-273: alias natural
  // recipes / recetas
  recipes: 'recipes', recetas: 'recipes', libro_recetas: 'recipes',
  // news / crónica / historial de eventos globales (T093)
  news: 'news', cronica: 'news', crónica: 'news', noticias: 'news', historial: 'news', diario: 'news',
  // forage / buscar ítems ocultos (T094)
  forage: 'forage', buscar: 'forage', explorar: 'forage', hurgar: 'forage', rebuscar: 'forage', rastrear: 'forage',
  // survey / sondear (T205)
  survey: 'survey', sondear: 'survey', escanear: 'survey', inspeccionar_sala: 'survey', prospeccionar: 'survey', prospectar: 'survey',
  // pet / mascota (T095)
  pet: 'pet', mascota: 'pet', mascotas: 'pet', compañero: 'pet', familiar: 'pet',
  // auction / subasta (T098)
  auction: 'auction', subasta: 'auction', subastar: 'auction', rematar: 'auction', vender_subasta: 'auction',
  // bid / pujar (T098)
  bid: 'bid', pujar: 'bid', puja: 'bid', apostar: 'bid', ofrecer_oro: 'bid',
  // auctions / listar subastas (T098)
  auctions: 'auctions', subastas: 'auctions', remates: 'auctions', sala_subasta: 'auctions',
  // market / mercado de jugadores (T181)
  market: 'market', mercado: 'market', tianguis: 'market', tablero: 'market', tablón: 'market',
  // gestos sociales (T182)
  bow: 'gesture', reverencia: 'gesture', inclinarse: 'gesture',
  wave: 'gesture', ola: 'gesture', saludar_mano: 'gesture', adios: 'gesture',
  laugh: 'gesture', reir: 'gesture', reír: 'gesture', carcajada: 'gesture',
  cry: 'gesture', llorar: 'gesture', sollozar: 'gesture',
  dance: 'gesture', bailar: 'gesture', danzar: 'gesture',
  shrug: 'gesture', encoger: 'gesture', encogerse: 'gesture',
  facepalm: 'gesture', palma: 'gesture', vergüenza: 'gesture',
  flex: 'gesture', musculos: 'gesture', músculos: 'gesture', posar: 'gesture',
  // dice / dados (T100)
  dice: 'dice', dado: 'dice', dados: 'dice', tirar_dados: 'dice', roll: 'dice', rodar: 'dice',
  // drink / beber (T103)
  drink: 'drink', beber: 'drink', hidratarse: 'drink', fuente: 'drink',
  // DIS-D48: Cuenco Sagrado en la Capilla (sala 5)
  bowl: 'bowl', cuenco: 'bowl', 'cuenco sagrado': 'bowl', ofrenda: 'bowl', 'beber cuenco': 'bowl',
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
  // Habilidades de Pícaro (BUG-271)
  robar: 'useSkill', steal: 'useSkill', hurtar: 'useSkill', pickpocket: 'useSkill', sustraer: 'useSkill',
  golpe_sucio: 'useSkill', dirty_strike: 'useSkill', backstab: 'useSkill', punalada_trasera: 'useSkill',
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
  // compare (T123)
  compare: 'compare', comparar: 'compare', versus: 'compare', vs: 'compare', duelo_stats: 'compare',
  // reputation (T125)
  reputation: 'reputation', reputacion: 'reputation', reputación: 'reputation', fama: 'reputation', renombre: 'reputation',
  // recall / volver (T131)
  recall: 'recall', retornar: 'recall', teletransportar: 'recall', tp: 'recall',
  // back / atrás (T154)
  back: 'back', atrás: 'back', atras: 'back', anterior: 'back', regresar: 'back',
  // perseguir / chase — DIS-D355: perseguir monstruo que huyó
  perseguir: 'chase', chase: 'chase', seguir: 'chase', pursue: 'chase',
  // trade / intercambio (T129)
  trade: 'trade', intercambiar: 'trade', intercambio: 'trade', trueque: 'trade', cambiar: 'trade',
  // lore / enciclopedia de ítems (T137)
  lore: 'lore', enciclopedia: 'lore', info: 'lore', descripcion: 'lore', descripción: 'lore',
  // peek / espiar (T139)
  peek: 'peek', espiar: 'peek', asomarse: 'peek', mirar_dir: 'peek', atisbar: 'peek',
  // project / proyectar — Habilidad exclusiva de Mago: inspección mágica de sala adyacente (DIS-450)
  project: 'project', proyectar: 'project', proyección: 'project', proyeccion: 'project', visión_astral: 'project', vision_astral: 'project',
  // runas / runes (T140)
  runas: 'runas', runes: 'runas', runacoleccion: 'runas', 'colección-runas': 'runas',
  // challenge / desafío diario (T141)
  challenge: 'challenge', desafio: 'challenge', desafío: 'challenge', 'desafio-diario': 'challenge', daily: 'challenge', mision_diaria: 'challenge', reto: 'challenge',
  // contract / contrato semanal (T222)
  contract: 'contract', contrato: 'contract', contratos: 'contract', 'contrato-caza': 'contract', 'caza-semanal': 'contract', weekly: 'contract', semanal: 'contract',
  // macro (T142)
  macro: 'macro', macros: 'macro', '!': 'macro',
  afk: 'afk', ausente: 'afk', ocupado: 'afk', away: 'afk',
  // write / grabar mensaje en la pared
  write: 'write', escribir: 'write', grabar: 'write', inscribir: 'write',
  // read / leer mensajes de la pared
  read: 'read', leer: 'read', pared: 'read',
  // greet / saludar a otro jugador
  greet: 'greet', saludar: 'greet', hola: 'greet', saludo: 'greet', hi: 'greet',
  // search / registrar cadáver de monstruo recién muerto (T149)
  search: 'search', registrar: 'search', rebuscar: 'search', revisar: 'search', cadaver: 'search', cadáver: 'search',
  // study / estudiar monstruo (T150)
  study: 'study', estudiar: 'study', analizar: 'study', investigar: 'study', examinar_monstruo: 'study',
  // dungeon / estado del dungeon (T151)
  dungeon: 'dungeon', 'dungeon-status': 'dungeon', 'estado-dungeon': 'dungeon', mapa_global: 'dungeon', overview: 'dungeon',
  // session / estadísticas de sesión (T155)
  session: 'session', sesion: 'session', sesión: 'session', 'mi-sesion': 'session', stats_sesion: 'session',
  // sessions / historial de sesiones (T156)
  sessions: 'sessions', historial_sesiones: 'sessions', 'mis-sesiones': 'sessions', historial_juego: 'sessions',
  weekly: 'weekly', semana: 'weekly', semanal: 'weekly', resumen_semanal: 'weekly', estadisticas_semana: 'weekly',  // T208
  // score_time / ranking por tiempo (T158)
  score_time: 'score_time',
  // stance / postura de combate (T161)
  stance: 'stance', postura: 'stance', combate_postura: 'stance',
  // path / ruta (T162)
  path: 'path', ruta: 'path', navegacion: 'path', navegar: 'path', 'como-llegar': 'path',
  // nick / apodo (T163)
  nick: 'nick', apodo: 'nick', alias: 'nick', sobrenombre: 'nick',
  // history / historial (T164)
  history: 'history', historial: 'history', cmds: 'history', comandos: 'history',
  // find / buscar (T167)
  find: 'find', encontrar: 'find', localizar: 'find', donde: 'find', 'dónde': 'find',
  // guide / guía (T170)
  guide: 'guide', guia: 'guide', guía: 'guide', manual: 'guide', inicio: 'guide', empezar: 'guide',
  tips: 'tips', tip: 'tips', consejo: 'tips', consejos: 'tips', trucos: 'tips', ayudame: 'tips',  // T209
  goals: 'goals', objetivos: 'goals', metas: 'goals', misiones_personales: 'goals', proximos: 'goals', 'qué-hacer': 'goals',  // T210
  // legado / historial épico del héroe (DIS-D291)
  legado: 'legado', leyenda: 'legado', historia: 'legado', ciclos: 'legado', 'mis-ciclos': 'legado', endgame: 'legado',
  // battlecry / grito de batalla (T211)
  battlecry: 'battlecry', 'grito-de-batalla': 'battlecry', grito: 'battlecry', 'grito-guerra': 'battlecry', gritoguerra: 'battlecry',
  // champion / campeón de la hora (T212)
  champion: 'champion', campeon: 'champion', campeón: 'champion', 'campeon-de-la-hora': 'champion', 'rey-de-la-hora': 'champion',
  // gamble / apostar en casa de subastas (T217)
  gamble: 'gamble', casino: 'gamble', tirar_dados: 'gamble', jugar_oro: 'gamble', apostar_casino: 'gamble',
  // roomnote / notas de exploración por sala (T218)
  roomnote: 'roomnote', mnota: 'roomnote', 'nota-sala': 'roomnote', 'notas-sala': 'roomnote', roomnotes: 'roomnote',
  // friend / amigos (T173)
  friend: 'friend', amigo: 'friend', amigos: 'friend', friends: 'friend',
  // vault / bóveda personal (T200)
  vault: 'vault', boveda: 'vault', bóveda: 'vault', cofre: 'vault', deposito: 'vault', depósito: 'vault',
  // epitaph / epitafio personal (T201)
  epitaph: 'epitaph', epitafio: 'epitaph', lapida: 'epitaph', lápida: 'epitaph', tumba: 'epitaph',
  // follow / seguir (T204)
  follow: 'follow', seguir: 'follow', acompañar: 'follow', escolta: 'follow',
  // unfollow / dejar de seguir (T204)
  unfollow: 'unfollow', 'dejar-seguir': 'unfollow', 'stop-follow': 'unfollow', soltar: 'unfollow',
  // pray / rezar — altares mágicos (T184)
  pray: 'pray', rezar: 'pray', orar: 'pray', ofrenda: 'pray', altar: 'pray',
  // preview / previsualizar ítem (T185)
  preview: 'preview', probar: 'preview', comparar_item: 'preview', previsualizar: 'preview', 'equip?': 'preview',
  // calendar / temporizadores (T187)
  calendar: 'calendar', eventos: 'calendar', timers: 'calendar', temporizadores: 'calendar', agenda: 'calendar',
  // bulletin / tablón global de anuncios (T188)
  bulletin: 'bulletin', tablón: 'bulletin', tablon: 'bulletin', anuncios: 'bulletin', boletin: 'bulletin', boletín: 'bulletin',
  // enchant / encantamiento de armas con runas (T190)
  enchant: 'enchant', encantar: 'enchant', encantamiento: 'enchant', rune_enchant: 'enchant',
  // trivia / acertijo del dungeon (T193)
  trivia: 'trivia', acertijo: 'trivia', riddle: 'trivia', enigma: 'trivia', adivinanza: 'trivia',
  // worldgoals / metas globales del servidor (T194)
  worldgoals: 'worldgoals', metas: 'worldgoals', metasglobales: 'worldgoals', 'world-goals': 'worldgoals', globalmetas: 'worldgoals', comunidad: 'worldgoals',
  // records / récords del servidor (T195)
  records: 'records', récords: 'records', recores: 'records', trofeos: 'records', 'hall-of-fame': 'records', halloffame: 'records', mejores: 'records',
  // score sesión / ranking activo (T198)
  'score_session': 'score_session', 'session-rank': 'score_session',
  // tarjeta de aventurero (T197)
  card: 'card', tarjeta: 'card', 'mi-tarjeta': 'card', 'ficha-publica': 'card', badge: 'card',
  // trivia pública / grupal (T196)
  'trivia-publica': 'trivia_pub', 'acertijo-publico': 'trivia_pub', 'trivia-grupal': 'trivia_pub', 'riddle-pub': 'trivia_pub', 'enigma-publico': 'trivia_pub',
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

  // T142: atajos !<nombre> → macro <nombre>
  if (first.startsWith('!') && first.length > 1) {
    return { command: 'macro', args: [first.slice(1), ...rest], raw: trimmed };
  }

  // Shortcut de dirección: el jugador escribe solo "norte" → move norte
  if (DIRECTION_SHORTCUTS.includes(first) && rest.length === 0) {
    const dir = normalizeDirection(first) || first;
    return { command: 'move', args: [dir], raw: trimmed };
  }

  // Buscar alias multi-palabra (ej: "recoger todo" → loot)
  if (parts.length >= 2) {
    const twoWord = `${first} ${parts[1].toLowerCase()}`;
    const MULTI_WORD_ALIASES = {
      'recoger todo':   { cmd: 'loot',     skillId: null },
      'tomar todo':     { cmd: 'loot',     skillId: null },
      'agarrar todo':   { cmd: 'loot',     skillId: null },
      'get all':        { cmd: 'loot',     skillId: null },
      'pick up':        { cmd: 'pick',     skillId: null },  // BUG-457: "pick up X" → "pick X"
      'take up':        { cmd: 'pick',     skillId: null },  // BUG-458: variante
      'golpe sucio':    { cmd: 'useSkill', skillId: 'golpe_sucio' },  // BUG-271: pícaro
      'dirty strike':   { cmd: 'useSkill', skillId: 'golpe_sucio' },
      // BUG-286: "tienda vender X" / "tienda comprar X" → sell/buy
      'tienda vender':  { cmd: 'sell',    skillId: null },
      'tienda comprar': { cmd: 'buy',     skillId: null },
      'shop sell':      { cmd: 'sell',    skillId: null },
      'shop buy':       { cmd: 'buy',     skillId: null },
    };
    const mwMatch = MULTI_WORD_ALIASES[twoWord];
    if (mwMatch) {
      // Para useSkill, args[0] debe ser el skillId canónico (como con alias de una palabra)
      if (mwMatch.cmd === 'useSkill' && mwMatch.skillId) {
        return { command: 'useSkill', args: [mwMatch.skillId, ...parts.slice(2)], raw: trimmed };
      }
      return { command: mwMatch.cmd, args: parts.slice(2), raw: trimmed };
    }
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

  // Para 'gesture', pasar el alias como primer arg (para saber qué gesto es)
  if (canonical === 'gesture') {
    const GESTURE_MAP = {
      bow: 'bow', reverencia: 'bow', inclinarse: 'bow',
      wave: 'wave', ola: 'wave', saludar_mano: 'wave', adios: 'wave',
      laugh: 'laugh', reir: 'laugh', reír: 'laugh', carcajada: 'laugh',
      cry: 'cry', llorar: 'cry', sollozar: 'cry',
      dance: 'dance', bailar: 'dance', danzar: 'dance',
      shrug: 'shrug', encoger: 'shrug', encogerse: 'shrug',
      facepalm: 'facepalm', palma: 'facepalm', vergüenza: 'facepalm',
      flex: 'flex', musculos: 'flex', músculos: 'flex', posar: 'flex',
    };
    return { command: 'gesture', args: [GESTURE_MAP[first] || first, ...rest], raw: trimmed };
  }

  // Para 'useSkill', siempre incluir el comando original (alias del skill) como primer arg
  if (canonical === 'useSkill') {
    // DIS-009 fix: args[0] debe ser el nombre de la habilidad (el comando escrito), no el objetivo.
    // Ej: 'smash guardia' → args: ['smash', 'guardia'] para que resolveSkillAlias('smash') funcione.
    return { command: 'useSkill', args: [first, ...rest], raw: trimmed };
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
  unequip / desequipar  — Guardar el arma y volver a puños (ataque 5)
  wear <armadura>       — Ponerse una armadura del inventario (+defensa)
  unwear / quitarse     — Quitarse la armadura (volver a defensa base)
  map / mapa            — Ver el mapa ASCII del dungeon
  who / jugadores       — Ver los aventureros activos en el dungeon
  score / ranking       — Ver la tabla de líderes global
  give <ítem> <jugador> — Dar un ítem a otro jugador en la misma sala
  loot / saquear        — Recoger todos los ítems del suelo de la sala
  heal / curar          — Usar la primera poción del inventario (atajo rápido)
  examine <objetivo>    — Examinar un monstruo, ítem o la sala
  say <mensaje>         — Hablar con jugadores en la misma habitación
  shout <mensaje>       — Gritar a todo el dungeon
  help / ayuda          — Esta ayuda
  whisper <jug> <msg>   — Mensaje privado a otro jugador (en cualquier sala)
  tell <jug> <msg>      — Mensaje privado con aviso offline (llega aunque no esté conectado)
  reply <msg>           — Contestar el último whisper/tell recibido (sin escribir el nombre)
  inbox                 — Ver los últimos 5 mensajes de whisper/tell recibidos (bandeja)
  unlock <dir>          — Abrir una puerta bloqueada usando la llave del inventario (permanente)
  emote <acción>        — Expresar una acción visible para todos en la sala (ej: emote sonríe)
  rest / descansar      — Recuperar HP si no hay monstruos (cooldown 60s)
  inspect <jugador>     — Examinar a otro aventurero en la misma sala
  quest / misión        — Ver la quest activa y tu progreso
  guild <acción>        — Gestionar tu hermandad (create/join/leave/info/list/quest)
  gc <mensaje>          — Chat de hermandad (solo ven los miembros del mismo guild)
  duel <jugador>        — Retar a un duelo PvP a otro aventurero en la misma sala
  accept                — Aceptar el reto de duelo pendiente
  decline               — Rechazar el reto de duelo pendiente
  world / evento        — Ver el evento global activo del dungeon (si hay alguno)
  craft <ítem1> con <ítem2> — Combinar dos ítems del inventario para crear algo nuevo
  recipes / recetas     — Ver el libro de recetas de crafteo conocidas
  news / crónica        — Ver el historial de eventos globales del dungeon
  forage / buscar       — Explorar la sala en busca de ítems ocultos (cooldown 3 min, sin monstruos)
  talk <NPC>            — Hablar con un NPC (ej: hablar aldric, hablar anciano). Algunos NPCs tienen quests o pistas de navegación.
  pet [adopt <tipo>]    — Adoptar una mascota (rata, murciélago, araña, etc.) o ver tu compañero
  dados <NdM>           — Tirar dados (ej: dados 2d6, dice 1d20). Resultado visible para toda la sala
  party [<jugador>]     — Gestionar tu grupo: invitar/unirse, ver miembros, party leave para salir
  beber / drink         — Beber de la Fuente Eterna (sala 18): restaura HP completo. Cooldown global 10 min
  cuenco / bowl         — Beber del Cuenco Sagrado (sala 5 — Capilla): restaura 40% HP. Cooldown personal 5 min
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
  compare <jugador>     — Comparar tus stats con otro aventurero en la misma sala (clase, nivel, HP, ATK, kills, etc.)
  reputation / fama     — Ver tu reputación detallada con barra de progreso (gana pts por kills, quests y logros)
  recall / volver       — Teletransportarse a la entrada del dungeon (sala 1). Costo: 5 HP. Cooldown: 10 min.
  back / atrás          — Volver a la sala anterior (sin costo ni cooldown, solo adyacente).
  trade <jug> <ítem>   — Proponer intercambio seguro de ítems (el otro acepta/rechaza con trade accept/decline).
  peek <dir> / espiar  — Espiar en una dirección sin moverse: ver nombre de sala, monstruos e ítems del suelo.
  runas / runes        — Ver tu colección de runas (5 tipos: fuego/hielo/sombra/luz/caos; 15% drop de cualquier monstruo; 3 iguales = +1 ATK permanente).
  session / sesión     — Ver estadísticas de tu sesión actual (kills, XP, oro ganados y tiempo conectado).
  sessions / historial — Ver el historial de tus últimas 5 sesiones y el tiempo de juego total acumulado.
  score tiempo         — Ranking por tiempo de juego total (los aventureros más veteranos).
  challenge / desafío  — Ver tu desafío diario personal y el progreso hacia él.
  contract / contrato  — Ver tu contrato de caza semanal (objetivo, progreso, recompensa).
  macro list           — Ver tus macros guardadas (hasta 5).
  macro set <n> <cmd> — Guardar macro (puede incluir secuencia con ;).
  macro del <nombre>  — Eliminar una macro. !<nombre> ejecuta la macro.
  write <mensaje>     — Grabar un mensaje en la pared de la sala actual.
  read / leer         — Leer las inscripciones que dejaron otros en esta sala.
  greet <jugador>     — Saludar a otro jugador en la sala. Saludo mutuo en 30s = +1 rep para ambos.
  search [monstruo]  — Registrar el cadáver de un monstruo recién muerto (últimos 2 min). 30% chance de loot extra.
  find <ítem/monstruo> — Buscar dónde encontrar algo: salas donde aparece, qué monstruos lo dropean, si hay en el suelo.
  guide [sección]     — Guía de inicio rápido: primeros/combate/economia/clases/crafteo/tips. Ej: guide 2
  wanted [jugador]    — Carteles de SE BUSCA: bounties activas en el dungeon, agrupadas por objetivo.
  rank <stat>         — Tu posición global en una estadística (kills, gold, xp, level, rep, deaths, time).
  hardcore [on/off/new] — Modo Hardcore: si morís, tu personaje cae para siempre (ghost mode). Solo antes del primer kill. "hardcore new" crea un sucesor tras caer.
  pray [ítem]          — Rezar ante un altar (sala 5 o 10): ofrecer un ítem para obtener una bendición temporal.\n  preview <arma/arm>   — Previsualizar cómo cambiarían tus stats si equiparas un arma o armadura del inventario.\n  gamble <monto>       — Mini-juego de apuestas con dados en la Casa de Subastas (sala 17). Apostás oro vs la casa. Cooldown 2 min.\n\nAtajos de dirección: n, s, e, o (oeste), w (west)
`.trim();

/**
 * Ayuda detallada por comando.
 */
const COMMAND_HELP = {
  look:      'look / mirar / l\n  Describir la habitación actual: salidas, monstruos, ítems en el suelo y otros jugadores presentes.',
  move:      'move <dir> / ir <dir> / <dir>\n  Moverse en una dirección: norte, sur, este, oeste, arriba, abajo.\n  También podés escribir solo la dirección: "norte", "n", "s", "e", "o".',
  inventory: 'inventory / inv / i / inventario\n  Mostrar los ítems que llevás encima.',
  status:    'status / estado / stats\n  Mostrar tus stats completos: HP, ataque, defensa, nivel, XP, kills y arma equipada.',
  attack:    'attack <monstruo> / atacar <monstruo>\n  Atacar a un monstruo de la sala. Un turno: vos atacás, el monstruo responde.\n  Repetí el comando para continuar hasta que uno de los dos muera.\n  En la Sala de Práctica (sala 21), atacar a un Maniquí resuelve el combate completo\n  y muestra estadísticas detalladas (DPS, crits, esquivas). Sin XP ni loot.',
  flee:      'flee [monstruo] / huir [monstruo]\n  Intentar huir del combate (50% de chance de éxito).\n  Si hay múltiples monstruos, usá "flee <monstruo>" para huir de uno específico. Sin argumento, huye del primero.\n  Si huís con éxito: se muestra el estado de salud del monstruo (% HP) y la sala a la que te escapaste.\n  Si fallás: el monstruo te golpea igualmente (daño normal menos defensa).',
  pick:      'pick <ítem> / tomar <ítem> / recoger <ítem>\n  Recoger un ítem del suelo y guardarlo en tu inventario.',
  loot:      'loot / saquear / recoger todo\n  Recoger TODOS los ítems del suelo de la sala de un solo golpe.',
  drop:      'drop <ítem> / tirar <ítem>\n  Tirar un ítem de tu inventario al suelo de la sala actual.',
  use:       'use <ítem> / usar <ítem>\\n  Usar un ítem del inventario. Pociones: consumen y restauran HP. Armas: se equipan.\\n  Pergaminos mágicos: se usan de un solo uso y otorgan buffs temporales en combate.\\n  Tipos: \"pergamino de furia\" (+3 ATK/60s), \"pergamino de escudo\" (+3 DEF/60s), \"pergamino de velocidad\" (+2 ATK +1 DEF/45s).',
  equip:     'equip <arma> / equipar <arma>\\n  Equipar un arma del inventario explícitamente. Aumenta tu stat de ataque.',
  unequip:   'unequip / desequipar / enfundar\\n  Guardar el arma equipada y volver a pelear con los puños (ataque base: 5).',
  wear:      'wear <armadura> / ponerse <armadura> / vestir <armadura>\\n  Equipar una armadura del inventario. Aumenta tu stat de defensa (base 2).\\n  Las armaduras se obtienen del loot de monstruos, en la tienda del mercader (sala 4), o como recompensa de quests.\\n  Ejemplos: cuero endurecido (+2 DEF), cota de malla (+3 DEF), armadura de placas (+5 DEF).',
  unwear:    'unwear / quitarse / desvestir\\n  Quitarse la armadura equipada y volver a la defensa base (2).',
  examine:   'examine <objetivo> / examinar <objetivo> / x <objetivo>\n  Examinar un monstruo, ítem (del inventario o del suelo) o la sala.\n  Sin argumento: vista detallada de la habitación actual.',
  give:      'give <ítem> <jugador> / dar <ítem> <jugador>\n  Pasar un ítem de tu inventario a otro jugador que esté en la misma sala.',
  map:       'map / mapa\n  Ver el mapa ASCII del dungeon con tu posición marcada con ★.',
  who:       'who / jugadores / online\n  Listar todos los aventureros activos en el dungeon (vistos en los últimos 5 minutos).',
  score:     'score / ranking\n  Ver la tabla de líderes global: los 10 mejores por kills, XP y nivel.\n  Subcategorías: \"score oro\" (riqueza) | \"score duelos\" (PvP) | \"score rep\" (reputación)',
  say:       'say <mensaje> / decir <mensaje>\n  Hablar con los jugadores que están en la misma sala.',
  shout:     'shout <mensaje> / gritar <mensaje>\n  Gritar un mensaje que todos los jugadores del dungeon escuchan.',
  whisper:   'whisper <jugador> <mensaje> / susurrar <jugador> <mensaje>\n  Enviar un mensaje privado a otro jugador (en cualquier sala). Solo el destinatario lo ve.',
  tell:      'tell <jugador> <mensaje>\n  Igual que whisper pero con persistencia offline: si el jugador no está conectado, el mensaje\n  se guarda en la BD y se le entrega la próxima vez que haga login.',
  reply:     'reply <mensaje> / responder <mensaje>\\n  Contestar automáticamente al último jugador que te envió un whisper o tell,\\n  sin necesidad de escribir su nombre. Atajo: "r <mensaje>".',
  inbox:     'inbox / bandeja / mensajes\\n  Ver los últimos 5 mensajes de whisper/tell recibidos.\\n  Incluye mensajes offline entregados y pendientes.\\n  inbox <n>: ver los últimos N mensajes (máx 20).',
  unlock:    'unlock / abrir <dir> / desbloquear <dir>\n  Abrir permanentemente una puerta bloqueada usando la llave del inventario.\n  La puerta queda abierta para todos los jugadores. La llave se consume.',
  emote:     'emote <acción> / accion <acción> / me <acción>\n  Expresar una acción en tercera persona visible para todos en la sala.\n  Ej: "emote suspira profundo" → todos ven: "✨ NombreJugador suspira profundo"',
  help:      'help / ayuda\n  Mostrar la lista de comandos.\n  help <comando>: ayuda detallada sobre un comando específico.',
  inspect:   'inspect <jugador> / inspeccionar <jugador>\n  Examinar a otro aventurero que esté en la misma sala.\n  Muestra su nivel, HP, arma equipada, kills, muertes y logros desbloqueados.',
  guild:     'guild create <nombre>  — Crear una nueva hermandad (cuestan 50 oro)\\nguild join <nombre>    — Unirse a una hermandad existente\\nguild leave            — Abandonar tu hermandad actual\\nguild info             — Ver info de tu hermandad (miembros, líder)\\nguild list             — Listar todas las hermandades activas\\nguild quest            — Ver la misión colectiva activa de tu hermandad',
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
    bowl:      'bowl / cuenco / ofrenda\\n  Beber del Cuenco Sagrado en la Capilla Olvidada (sala 5, al este de la Entrada).\\n  Restaura el 40% de tu HP máximo.\\n  Cooldown PERSONAL de 5 minutos: el cooldown es tuyo, no afecta a otros jugadores.\\n  Ideal para recuperar entre combates sin ir hasta la tienda. No funciona si ya estás al máximo.',
    journal:   'journal / diario\\n  Ver tu diario personal de aventurero.\\n  Se registra automáticamente cuando: derrotes un boss, completes una quest, desbloquees un logro, subas de nivel o mueras.\\n  Muestra las últimas 10 entradas con tipo, fecha y descripción.',
    enemies:   'enemies [N] / enemigos [N] / top [N]\\n  Ver los N monstruos más poderosos del dungeon (ordenados por HP máximo).\\n  Muestra: nombre, estado (vivo/respawn), sala donde habitan y estadísticas.\\n  N es opcional, por defecto 10. Máximo 20.',
    compare:   'compare <jugador> / comparar <jugador> / vs <jugador>\\\\n  Comparar tus stats con los de otro aventurero que esté en la misma sala.\\\\n  Tabla visual con: clase, título, nivel, XP, HP con barra, maná, ATK, DEF, kills, muertes, oro y arma equipada.',
    reputation: 'reputation / reputacion / fama / renombre\\\\n  Ver tu nivel de reputación actual con barra de progreso.\\\\n  Niveles: Desconocido (0) → Conocido (10) → Respetado (25) → Famoso (50) → Legendario (100).\\\\n  Ganás puntos por: matar monstruos (+1), completar quests (+5), desbloquear logros (+3).\\\\n  Tu reputación se muestra en \\\"status\\\" y en \\\"who\\\".',
    recall:    'recall / volver / retornar\\\\\\\\n  Teletransportarse a la entrada del dungeon (sala 1).\\\\\\\\n  Costo: 5 HP. Cooldown: 10 minutos.\\\\\\\\n  Útil para escapar de zonas peligrosas o volver rápido al mercader.',
    back:      'back / atrás / anterior / regresar\\\\n  Volver a la sala anterior sin costo ni cooldown.\\\\n  Solo funciona si la sala anterior es adyacente a tu posición actual.\\\\n  Útil para exploración de ida y vuelta.',
    trade:     'trade <jugador> <ítem> / intercambiar <jugador> <ítem>\\\\n  Proponer un intercambio seguro de ítems con otro jugador en la misma sala.\\\\n  El jugador destino puede responder con:\\\\n    trade accept — aceptar el trueque (se intercambian los ítems)\\\\n    trade cancel/decline — rechazar la propuesta\\\\n  La propuesta expira en 30 segundos.\\\\n  Diferencia con give: trade requiere que ambos estén de acuerdo.',
  lore:      'lore <item> / enciclopedia <item>',
  peek:      'peek <dirección> / espiar <dirección> / asomarse <dirección>\\\\\\\\n  Espiar en una dirección sin moverse.\\\\\\\\n  Muestra el nombre de la sala adyacente, si hay monstruos (sin detalles de HP) y si hay ítems en el suelo.\\\\\\\\n  No funciona si la salida está bloqueada con llave.\\\\\\\\n  Útil para scouting antes de entrar a una sala peligrosa.',
  afk:       'afk / ausente / ocupado / away\\\\\\\\\\\\\\\\n  Activar o desactivar el modo ausente (AFK).\\\\\\\\\\\\\\\\n  Mientras estés AFK, todos tus comandos quedarán bloqueados (excepto afk).\\\\\\\\\\\\\\\\n  En la lista de jugadores (who) aparecerás con 💤 junto a tu nombre.\\\\\\\\\\\\\\\\n  Si intentás atacar a un monstruo, el modo AFK se cancela automáticamente.\\\\\\\\\\\\\\\\n  Cooldown de 10 segundos entre toggles.',
  write:     'write <mensaje> / escribir <mensaje> / grabar <mensaje>\\\\\\\\n  Grabar un mensaje en la pared de la sala actual (máx 80 caracteres).\\\\\\\\n  Máximo 10 mensajes por sala. Los más viejos se borran cuando se supera el límite.\\\\\\\\n  Todos los jugadores que entren a la sala verán el indicador y pueden leerlo con "read".',
  read:      'read / leer / pared\\\\\\\\n  Leer las inscripciones en la pared de la sala actual.\\\\\\\\n  Muestra quién lo escribió y cuándo.',
  study:     'study <monstruo> / estudiar <monstruo> / analizar <monstruo>\\\\n  Analizar un monstruo en la sala actual.\\\\n  Muestra tipo, HP/ATK actuales, habilidades especiales con probabilidad,\\\\n  debilidades, resistencias y consejo estratégico.',
  session:   'session / sesion / sesión\\\\\\\\n  Ver las estadísticas de tu sesión actual.\\\\\\\\n  Muestra: tiempo conectado, kills, XP ganada, oro ganado y comandos ejecutados.\\\\\\\\n  También se muestra automáticamente al desconectarse.',
  sessions:  'sessions / historial_sesiones / mis-sesiones\\\\\\\\n  Ver el historial de tus últimas 5 sesiones guardadas.\\\\\\\\n  Las sesiones se guardan al desconectar.\\\\\\\\n  También muestra tu tiempo de juego total acumulado.\\\\\\\\n  Nota: Las sesiones muy cortas (0 min) igual se registran.',
  stance:    'stance [postura] / postura [postura]\\\\n  Ver o cambiar tu postura de combate.\\\\n  Posturas: agresivo (+2ATK/-1DEF/5% miss extra), defensivo (-1ATK/+2DEF), equilibrado.\\\\n  La postura persiste entre sesiones.',
  path:      'path <destino> / ruta <destino>\\\\n  Calcular la ruta más corta hasta una sala.\\\\n  Destino puede ser un ID numérico (ej: path 15) o parte del nombre (ej: path catedral).\\\\n  Muestra los pasos como comandos move con nombre de sala de destino.\\\\n  Sin cooldown. Útil para navegar el dungeon eficientemente.',
  find:      'find <ítem o monstruo> / encontrar <ítem o monstruo>\\\\n  Buscar información sobre dónde conseguir algo en el dungeon.\\\\n  Si es un monstruo: muestra en qué sala se encuentra (o en respawn).\\\\n  Si es un ítem: muestra qué monstruos lo dropean y si hay alguno en el suelo.\\\\n  Soporta búsqueda parcial y sin tildes. Útil para nuevos jugadores buscando equipo.',
  pray:      'pray [ítem] / rezar [ítem] / orar [ítem]\\\\n  Rezar ante un altar mágico para obtener bendiciones temporales.\\\\n  Altares: Capilla Olvidada (sala 5) y Santuario Profano (sala 10).\\\\n  Ofrecés un ítem del inventario y el altar te devuelve un buff temporal.\\\\n  Cooldown: 5 minutos entre ofrendas. Sin argumento muestra los ítems aceptados.',
  preview:   'preview <arma o armadura> / probar <ítem>\\\\n  Previsualizar cómo cambiarían tus stats si equiparas un ítem.\\\\n  Funciona con armas y armaduras del inventario.\\\\n  No modifica tu equipo — es solo informativo.\\\\n  Útil para decidir si vale la pena cambiar de equipo antes de una pelea.',
  calendar:  'calendar / eventos / timers / temporizadores\\\\n  Panel de temporizadores del dungeon.\\\\n  Muestra: estado del boss (vivo/respawn con cuenta regresiva), clima actual con tiempo restante,\\\\n  fuente eterna (disponible o en cooldown), tus buffs activos con tiempo restante,\\\\n  y estado de las trampas del dungeon (armadas/desactivadas).',
  // BUG-028: ayuda detallada para comandos de habilidades, magia y bóveda
  skills:    'skills / habilidades / poderes\\\\n  Ver tus habilidades activas desbloqueadas y sus cooldowns.\\\\n  Las habilidades se desbloquean al subir de nivel:\\\\n    Nivel 3: smash/golpetazo (×1.8 daño, cooldown 45s)\\\\n    Nivel 6: shield_bash/escudo_bash (stun 1 turno + daño, cooldown 60s)\\\\n    Nivel 10: rally/arenga (party: +2 ATK a todos en la sala por 60s)',
  smash:     'smash [monstruo] / golpetazo [monstruo]\\\\n  Habilidad activa desbloqueada en Nivel 3.\\\\n  Ataque potente: inflige ×1.8 del daño normal.\\\\n  Cooldown: 45 segundos. Si hay múltiples monstruos, especificá el nombre.',
  shield_bash: 'shield_bash [monstruo] / escudo_bash [monstruo]\\\\n  Habilidad activa desbloqueada en Nivel 6.\\\\n  Golpe con escudo: daño normal + aturdimiento al monstruo por 1 turno (no ataca).\\\\n  Cooldown: 60 segundos.',
  cast:      'cast <hechizo> [objetivo] / lanzar <hechizo>\\\\\\\\n  Lanzar un hechizo gastando maná.\\\\\\\\n  Hechizos disponibles:\\\\\\\\n    bola de fuego / fuego — 10 daño (15 Mago), costo 8 maná\\\\\\\\n    escudo / shield      — +5 DEF por 1 turno en combate, costo 6 maná\\\\\\\\n    curación / heal      — +15 HP, costo 10 maná\\\\\\\\n    rayo / lightning     — 15 daño (18 Mago), 25% stun, costo 12 maná\\\\\\\\n  El maná se recarga 1/min (6/min para Magos). Usá pociones de maná para recargar rápido.\\\\\\\\n  Ej: \\\"cast fuego goblin\\\", \\\"cast curación\\\", \\\"cast rayo guardia espectral\\\"',
  vault:     'vault / bóveda / cofre\\\\n  Bóveda personal — solo disponible en la Entrada del Dungeon (sala 1).\\\\n  vault store <ítem>  — Guardar un ítem del inventario en la bóveda (máx 10 ítems)\\\\n  vault take <ítem>   — Sacar un ítem de la bóveda al inventario\\\\n  vault (sin args)    — Listar el contenido de tu bóveda\\\\n  Los ítems en la bóveda son seguros: no se pierden al morir en Hardcore.',
  enchant:   'enchant <tipo_runa> / encantar <tipo_runa>\\\\n  Encantar el arma equipada consumiendo 1 runa del tipo indicado.\\\\n  Efectos por tipo (duración 3 minutos):\\\\n    fuego  — +2 ATK\\\\n    hielo  — 20% chance de ralentizar al monstruo (skip su turno)\\\\n    sombra — +15% probabilidad de crítico adicional\\\\n    luz    — +3 HP al matar cada monstruo\\\\n    caos   — efecto aleatorio entre los anteriores\\\\n  Conseguís runas al matar monstruos (15% de chance). Ver colección con "runas".',
  runas:     'runas / runes\\\\n  Ver tu colección de runas y guía completa del sistema.\\\\n  Tipos de runas (5 en total): fuego 🔥, hielo ❄️, sombra 🌑, luz ✨, caos 🌀\\\\n  Cómo obtenerlas:\\\\n    • Cualquier monstruo puede soltar 1 runa al morir (15% de chance).\\\\n    • El tipo de runa es aleatorio — no hay monstruo específico.\\\\n  Fusión:\\\\n    • Al juntar 3 del mismo tipo se fusionan automáticamente.\\\\n    • La fusión otorga +1 ATK permanente al arma equipada.\\\\n  Encantamiento:\\\\n    • Usá "enchant <tipo>" para consumir 1 runa y encantar tu arma.\\\\n    • El encantamiento dura 3 minutos con el efecto del tipo elegido.',
  };

  module.exports = { parse, HELP_TEXT, COMMAND_HELP };
