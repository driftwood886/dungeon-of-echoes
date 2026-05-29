/**
 * seed.js — Dungeon inicial (10 habitaciones, 8 monstruos)
 *
 * Se ejecuta una sola vez al arrancar si las habitaciones no existen.
 *
 * Mapa:
 *
 *   [8-Prisión] ←→ [4-Tesoro]
 *       |                |
 *   [9-Trono] ←→ [10-Santuario] ←→ [7-Pozo]
 *       |
 *   [6-Hongos] ←→ [2-Corredor] ←→ [1-Entrada] ←→ [5-Capilla]
 *       |               |
 *   [nada]         [3-Ecos] ←→ [4-Tesoro]
 *
 *  Mapa simplificado (con salidas reales):
 *  1 ←N→ 2 ←N→ 3 ←E→ 4 ←N→ 8
 *  1 ←E→ 5 ←N→ 6
 *  2 ←W→ 6 ←N→ 9
 *  3 ←W→ 7 ←N→ 10
 *  9 ←E→ 10
 *  7 ←N→ 10
 */

'use strict';

const db = require('./db');

const ROOMS = [
  {
    id: 1,
    name: 'Entrada de la Cripta',
    description: 'Una puerta de piedra enorme marca la entrada al dungeon. El aire huele a moho y tiempo olvidado. La oscuridad se extiende al norte y al este.',
    exits: { north: 2, east: 5 },
    items: ['antorcha', 'mochila de cuero'],
  },
  {
    id: 2,
    name: 'Corredor de las Sombras',
    description: 'Un pasillo largo y estrecho. Las paredes de piedra sudan humedad. Inscripciones ilegibles cubren cada centímetro.',
    exits: { south: 1, north: 3, west: 6 },
    items: [],
  },
  {
    id: 3,
    name: 'Sala de los Ecos',
    description: 'Una cámara circular donde cada sonido rebota mil veces. El suelo está cubierto de huesos viejos y polvo.',
    exits: { south: 2, east: 4, west: 7 },
    items: ['poción de salud', 'vela encendida'],
  },
  {
    id: 4,
    name: 'Cámara del Tesoro',
    description: 'Estantes de madera podrida sostienen cofres semiabiertos. Algo valioso estuvo aquí alguna vez. Un olor metálico impregna el ambiente.',
    exits: { west: 3, north: 8 },
    items: ['espada oxidada', 'monedas de oro'],
  },
  {
    id: 5,
    name: 'Capilla Olvidada',
    description: 'Un altar de piedra negra domina la sala. Velas apagadas desde hace siglos. Una sensación extraña recorre tu espalda al acercarte al altar.',
    exits: { west: 1, north: 6 },
    items: ['libro viejo', 'poción de salud'],
  },
  {
    id: 6,
    name: 'Túnel de los Hongos',
    description: 'Hongos luminiscentes de color azul crecen por las paredes, dando una luz tenue y fantasmal. El suelo cruje bajo cada paso.',
    exits: { east: 2, south: 5, north: 9 },
    items: ['hongo azul'],
  },
  {
    id: 7,
    name: 'Pozo Sin Fondo',
    description: 'Un pozo en el centro de la sala emite un viento frío desde las profundidades. Una cuerda cuelga al borde. ¿Qué habrá abajo? Al norte, una puerta de hierro macizo con una cerradura oxidada bloquea el paso al Santuario.',
    exits: { east: 3, north: 10 },
    items: ['cuerda', 'gancho de hierro'],
  },
  {
    id: 8,
    name: 'Prisión Subterránea',
    description: 'Celdas de hierro corroído bordean las paredes. Las rejas están abiertas. Algo estuvo aquí encerrado por mucho tiempo.',
    exits: { south: 4 },
    items: ['llave oxidada', 'cadenas rotas'],
  },
  {
    id: 9,
    name: 'Sala del Trono',
    description: 'Un trono de huesos ocupa el centro de la sala. Las paredes están decoradas con escudos de armas de reinos extintos. El silencio es absoluto.',
    exits: { south: 6, east: 10 },
    items: ['corona rota'],
  },
  {
    id: 10,
    name: 'Santuario Profano',
    description: 'El corazón del dungeon. Una estatua monstruosa con diez brazos preside la sala. El suelo está cubierto de runas trazadas con sangre seca. Aquí termina el dungeon... o comienza.',
    exits: { west: 9, south: 7 },
    items: ['amuleto oscuro', 'poción de poder'],
  },
];

const MONSTERS = [
  {
    id: 1,
    name: 'Goblin Merodeador',
    description: 'Una criatura verde y escuálida con ojos amarillos. Sostiene un cuchillo oxidado.',
    hp: 15, max_hp: 15, attack: 3,
    room_id: 2,
    loot: ['monedas de cobre', 'cuchillo oxidado'],
    respawn_room_id: 2,
  },
  {
    id: 2,
    name: 'Esqueleto Guerrero',
    description: 'Un esqueleto animado con armadura en ruinas. Sus órbitas vacías brillan con luz roja.',
    hp: 20, max_hp: 20, attack: 5,
    room_id: 4,
    loot: ['escudo roto', 'poción de salud'],
    respawn_room_id: 4,
  },
  {
    id: 3,
    name: 'Rata Gigante',
    description: 'Una rata del tamaño de un perro mediano. Sus dientes brillan en la oscuridad.',
    hp: 10, max_hp: 10, attack: 2,
    room_id: 6,
    loot: ['pelaje áspero', 'monedas de cobre'],
    respawn_room_id: 6,
  },
  {
    id: 4,
    name: 'Espectro del Corredor',
    description: 'Una figura translúcida que flota entre las sombras. Emite un gemido suave y perturbador.',
    hp: 18, max_hp: 18, attack: 6,
    room_id: 9,
    loot: ['esencia etérea', 'monedas de plata'],
    respawn_room_id: 9,
  },
  {
    id: 5,
    name: 'Gólem de Piedra',
    description: 'Una masa de piedra animada que guarda el santuario. Sus puños del tamaño de rocas pueden aplastarte.',
    hp: 35, max_hp: 35, attack: 8,
    room_id: 10,
    loot: ['cristal mágico', 'piedra de poder'],
    respawn_room_id: 10,
  },
  {
    id: 6,
    name: 'Murciélago Vampiro',
    description: 'Un murciélago enorme con colmillos afilados como agujas. Revolotea en la oscuridad de la capilla.',
    hp: 12, max_hp: 12, attack: 3,
    room_id: 5,
    loot: ['diente afilado', 'monedas de cobre'],
    respawn_room_id: 5,
  },
  {
    id: 7,
    name: 'Araña Tejedora',
    description: 'Una araña del tamaño de un gato. Su veneno paraliza las extremidades durante segundos.',
    hp: 8, max_hp: 8, attack: 4,
    room_id: 7,
    loot: ['hilo de seda', 'veneno concentrado'],
    respawn_room_id: 7,
  },
  {
    id: 8,
    name: 'Guardia Espectral',
    description: 'El espíritu de un guardia que murió encadenado en la prisión. Aún porta su alabarda de huesos.',
    hp: 25, max_hp: 25, attack: 7,
    room_id: 8,
    loot: ['alabarda de huesos', 'monedas de plata'],
    respawn_room_id: 8,
  },
];

function seedIfEmpty() {
  const existing = db.getAllRooms();
  if (existing.length > 0) {
    console.log('[seed] Dungeon ya existe, saltando seed.');
    migrateTutorial();
    migrateDoors();
    migrateExpandedDungeon();
    migrateTraps();
    migrateAntidotes();
    return;
  }

  console.log('[seed] Generando dungeon inicial...');

  for (const room of ROOMS) {
    db.upsertRoom(room);
  }

  for (const monster of MONSTERS) {
    db.upsertMonster(monster);
  }

  console.log(`[seed] ${ROOMS.length} habitaciones y ${MONSTERS.length} monstruos creados.`);
  migrateTutorial();
  migrateDoors();
  migrateExpandedDungeon();
  migrateTraps();
  migrateAntidotes();
}

/**
 * Aplica las puertas bloqueadas al dungeon.
 * Se ejecuta siempre al arrancar para asegurar que las salidas con llave estén configuradas.
 * Actualiza los exits de sala 7 para que norte→10 requiera la llave oxidada.
 */
function migrateDoors() {
  const room7 = db.getRoom(7);
  if (!room7) return;

  const exits = room7.exits || {};
  // Solo actualizar si la salida norte no tiene estructura de objeto (formato viejo)
  if (typeof exits.north === 'number') {
    const newExits = {
      ...exits,
      north: { room_id: exits.north, key: 'llave oxidada' },
    };
    const newDesc = 'Un pozo en el centro de la sala emite un viento frío desde las profundidades. Una cuerda cuelga al borde. ¿Qué habrá abajo? Al norte, una puerta de hierro macizo con una cerradura oxidada bloquea el paso al Santuario.';
    db.upsertRoom({ ...room7, exits: newExits, description: newDesc });
    console.log('[seed] migrateDoors: Sala 7 actualizada — norte hacia sala 10 requiere llave oxidada 🔒');
  }
}

/**
 * Agrega 5 habitaciones nuevas (zona helada, forja, etc.) si aún no existen (IDs 11-15).
 * También conecta estas habitaciones al dungeon existente y agrega nuevos monstruos (IDs 9-13).
 *
 * Mapa de expansión:
 *   Santuario (10) ←east→ [11-Galería de Hielo]
 *   [11-Galería] ←north→ [12-Taller de la Forja]
 *   [11-Galería] ←east→ [13-Caverna Sumergida]
 *   [12-Forja] ←east→ [14-Coliseo de Huesos]
 *   [13-Caverna] ←north→ [14-Coliseo]
 *   [14-Coliseo] ←east→ [15-Catedral de la Oscuridad]
 */
function migrateExpandedDungeon() {
  const existing11 = db.getRoom(11);
  if (existing11) {
    // Ya fue aplicada la expansión
    return;
  }

  console.log('[seed] migrateExpandedDungeon: agregando 5 habitaciones nuevas (IDs 11-15)...');

  // Nuevas habitaciones
  const newRooms = [
    {
      id: 11,
      name: 'Galería de Hielo',
      description: 'Columnas de hielo translúcido atrapan figuras deformadas en su interior. El aliento se congela al instante. Las paredes brillan con una luz azul espectral. ¿Son los cadáveres de aventureros anteriores?',
      exits: { west: 10, north: 12, east: 13 },
      items: ['fragmento de hielo', 'poción de salud'],
    },
    {
      id: 12,
      name: 'Taller de la Forja',
      description: 'Una forja gigantesca que nunca se apagó. El calor contrasta brutalmente con la galería helada al sur. Herramientas de dimensiones colosales cuelgan de las paredes. Algo sigue trabajando aquí.',
      exits: { south: 11, east: 14 },
      items: ['martillo de forja', 'lingote de hierro'],
    },
    {
      id: 13,
      name: 'Caverna Sumergida',
      description: 'Un lago subterráneo de agua negra ocupa la mitad de la caverna. Plataformas de piedra permiten avanzar con cuidado. Burbujas suben a la superficie de manera inquietante. Algo respira bajo el agua.',
      exits: { west: 11, north: 14 },
      items: ['perla negra', 'red de pesca'],
    },
    {
      id: 14,
      name: 'Coliseo de Huesos',
      description: 'Una arena circular rodeada de gradas repletas de esqueletos sentados como espectadores eternos. El suelo está empapado de sangre seca de siglos. La acústica amplifica cada sonido de manera grotesca.',
      exits: { west: 12, south: 13, east: 15 },
      items: ['escudo de gladiador', 'monedas de oro'],
    },
    {
      id: 15,
      name: 'Catedral de la Oscuridad',
      description: 'La sala más profunda del dungeon. Vitrales negros filtran una luz inexistente. En el altar central yace una espada de obsidiana que parece absorber la luz circundante. El aire vibra con una energía antigua y hambrienta. Pocos llegan aquí. Ninguno sale igual.',
      exits: { west: 14 },
      items: ['espada de obsidiana', 'poción de poder', 'tomo sellado'],
    },
  ];

  for (const room of newRooms) {
    db.upsertRoom(room);
  }

  // Conectar sala 10 (Santuario) hacia el este con sala 11
  const room10 = db.getRoom(10);
  if (room10) {
    const updatedExits10 = { ...room10.exits, east: 11 };
    db.upsertRoom({ ...room10, exits: updatedExits10 });
  }

  // Nuevos monstruos en las habitaciones de la expansión
  const newMonsters = [
    {
      id: 9,
      name: 'Elemental de Hielo',
      description: 'Una masa de hielo vivo que se desplaza lentamente pero golpea con una fuerza que congela los huesos.',
      hp: 22, max_hp: 22, attack: 6,
      room_id: 11,
      loot: ['cristal helado', 'poción de salud'],
      respawn_room_id: 11,
    },
    {
      id: 10,
      name: 'Golem de Forja',
      description: 'Construido de metal fundido y magia. Sus puños al rojo vivo causan quemaduras además de contusiones.',
      hp: 30, max_hp: 30, attack: 9,
      room_id: 12,
      loot: ['núcleo de forja', 'monedas de oro'],
      respawn_room_id: 12,
    },
    {
      id: 11,
      name: 'Krakeling Abismal',
      description: 'Una criatura tentacular que emerge del lago negro. Sus ventosas paralizan momentáneamente al contacto.',
      hp: 25, max_hp: 25, attack: 7,
      room_id: 13,
      loot: ['tinta de kraken', 'escama abismal'],
      respawn_room_id: 13,
    },
    {
      id: 12,
      name: 'Campeón Espectral',
      description: 'El fantasma del último campeón del coliseo. Porta armadura de sombras y una lanza de luz negra.',
      hp: 40, max_hp: 40, attack: 10,
      room_id: 14,
      loot: ['lanza espectral', 'monedas de plata', 'poción de poder'],
      respawn_room_id: 14,
    },
    {
      id: 13,
      name: 'Lich Anciano',
      description: 'El señor del dungeon. Un hechicero que alcanzó la inmortalidad a través de la oscuridad. Sus ojos son estrellas negras. Su voz es el silencio antes de la muerte.',
      hp: 60, max_hp: 60, attack: 12,
      room_id: 15,
      loot: ['filacteria rota', 'espada de obsidiana', 'tomo sellado'],
      respawn_room_id: 15,
    },
  ];

  for (const monster of newMonsters) {
    db.upsertMonster(monster);
  }

  console.log(`[seed] migrateExpandedDungeon: ${newRooms.length} habitaciones y ${newMonsters.length} monstruos agregados. Sala 10 conectada al este con sala 11.`);
}

/**
 * Agrega trampas a habitaciones específicas del dungeon.
 * Las trampas se definen como JSON: { type, damage, item_needed, active, description, disarm_msg }
 * - type: 'spike' | 'poison' | 'cold' | 'flood'
 * - damage: HP que quita al entrar si activa
 * - item_needed: nombre del ítem que desactiva la trampa (o null)
 * - active: true si la trampa está armada
 * - description: texto que aparece al activarse
 * - disarm_msg: texto al desactivarla
 *
 * Trampas asignadas:
 *   Sala 3 (Sala de los Ecos) — trampa de pinchos, se desactiva con cuerda
 *   Sala 6 (Túnel de los Hongos) — esporas venenosas, se desactiva con hongo azul
 *   Sala 9 (Sala del Trono) — frío mortal, se desactiva con corona rota
 *   Sala 13 (Caverna Sumergida) — inundación, se desactiva con red de pesca
 */
function migrateTraps() {
  const traps = [
    {
      room_id: 3,
      trap: {
        type: 'spike',
        damage: 8,
        item_needed: 'cuerda',
        active: true,
        description: '⚠️  ¡CLIC! El suelo cede bajo tus pies. Pinchos ocultos emergen y te lastiman.',
        disarm_msg: 'Usás la cuerda para trabar el mecanismo de pinchos. La trampa queda desactivada.',
      },
    },
    {
      room_id: 6,
      trap: {
        type: 'poison',
        damage: 6,
        item_needed: 'hongo azul',
        active: true,
        description: '⚠️  ¡Las esporas de los hongos explotan al pisarlos! Inhalás una nube tóxica.',
        disarm_msg: 'Usás el hongo azul para neutralizar las esporas. La trampa queda desactivada.',
      },
    },
    {
      room_id: 9,
      trap: {
        type: 'cold',
        damage: 10,
        item_needed: 'corona rota',
        active: true,
        description: '⚠️  El trono irradia un frío sobrenatural. Un aliento helado te congela parcialmente.',
        disarm_msg: 'Colocás la corona rota en el trono como ofrenda. El frío se disipa. La trampa queda desactivada.',
      },
    },
    {
      room_id: 13,
      trap: {
        type: 'flood',
        damage: 7,
        item_needed: 'red de pesca',
        active: true,
        description: '⚠️  El suelo se inunda repentinamente. El agua fría y oscura te arrastra.',
        disarm_msg: 'Usás la red de pesca para bloquear los conductos. La trampa queda desactivada.',
      },
    },
  ];

  let applied = 0;
  for (const { room_id, trap } of traps) {
    const room = db.getRoom(room_id);
    if (!room) continue;
    if (room.trap && room.trap.type) continue; // ya tiene trampa
    db.updateRoomTrap(room_id, trap);
    applied++;
  }

  if (applied > 0) {
    console.log(`[seed] migrateTraps: ${applied} trampas agregadas al dungeon. 🪤`);
  }
}

/**
 * Agrega antídotos al dungeon si aún no están presentes.
 * - Sala 7 (Pozo Sin Fondo): un antídoto en el suelo
 * - Araña Tejedora (id 7): actualiza loot para incluir antídoto
 */
function migrateAntidotes() {
  // Sala 7: agregar antídoto si no hay ninguno
  const room7 = db.getRoom(7);
  if (room7) {
    const items7 = room7.items || [];
    if (!items7.includes('antídoto') && !items7.includes('antidoto')) {
      db.updateRoomItems(7, [...items7, 'antídoto']);
      console.log('[seed] migrateAntidotes: antídoto agregado en Sala 7 (Pozo Sin Fondo)');
    }
  }
  // Sala 5 (Capilla): también un antídoto (near murciélago vampiro)
  const room5 = db.getRoom(5);
  if (room5) {
    const items5 = room5.items || [];
    if (!items5.includes('antídoto') && !items5.includes('antidoto')) {
      db.updateRoomItems(5, [...items5, 'hierba curativa']);
      console.log('[seed] migrateAntidotes: hierba curativa agregada en Sala 5 (Capilla Olvidada)');
    }
  }
}

/**
 * Agrega la sala 16 (Antesala del Dungeon) y el Goblin de Práctica (id 20) si no existen.
 * Esta es la sala de tutorial — solo accesible para jugadores nuevos.
 */
function migrateTutorial() {
  const tutorialRoom = db.getRoom(16);
  if (!tutorialRoom) {
    db.upsertRoom({
      id: 16,
      name: 'Antesala del Dungeon',
      description: 'Una pequeña cámara iluminada con antorchas cálidas. El aire huele a paja fresca y cera de vela. Un guardián anciano te observa desde la esquina. Al sur, una puerta de madera da al dungeon real. En el centro, un Goblin de Práctica espera mansamente para el entrenamiento.',
      exits: { south: 1 },
      items: ['poción de salud'],
    });
    console.log('[seed] migrateTutorial: Sala 16 (Antesala del Dungeon) creada.');
  }

  // Goblin de Práctica — id 20, HP bajo, ATK mínimo, solo para tutorial
  const existingGoblin = db.getMonster(20);
  if (!existingGoblin) {
    db.upsertMonster({
      id: 20,
      name: 'Goblin de Práctica',
      description: 'Un goblin con chaleco acolchado y una espada de madera. Parece resignado a su destino como blanco de entrenamiento.',
      hp: 8,
      max_hp: 8,
      attack: 2,
      room_id: 16,
      loot: ['monedas de cobre'],
      respawn_room_id: 16,
    });
    console.log('[seed] migrateTutorial: Goblin de Práctica (id 20) creado en sala 16.');
  }
}

module.exports = { seedIfEmpty, ROOMS, MONSTERS };
