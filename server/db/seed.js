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
    items: ['poción de salud', 'vela encendida', 'poción de maná'],
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
    description: 'Un pozo en el centro de la sala emite un viento frío desde las profundidades. Una cuerda cuelga al borde —la inscripción en la pared dice que nadie que intentó bajar volvió para contarlo. Al norte, una puerta de hierro macizo con una cerradura oxidada bloquea el paso al Santuario. (💡 Si no tenés la llave, hay otra ruta al Santuario: volvé a la Entrada, tomá el este hacia la Capilla, sigue norte por los Hongos y el Trono.)',
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
    hp: 15, max_hp: 15, attack: 4,
    room_id: 2,
    loot: ['monedas de cobre', 'cuchillo oxidado'],
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
    description: 'Un murciélago enorme con colmillos afilados como agujas. Sus mordidas drenan la vitalidad de la víctima. Revolotea en la oscuridad de la capilla.',
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
    loot: ['hilo de seda', 'veneno concentrado', 'llave oxidada'],
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
    migrateSanctuaryEastHint();
    migrateEspectroCoronaLoot();
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
  migrateSanctuaryEastHint();
  migrateEspectroCoronaLoot();
}

/**
 * Aplica las puertas bloqueadas al dungeon.
 * Se ejecuta siempre al arrancar para asegurar que las salidas con llave estén configuradas.
 * Actualiza los exits de sala 7 para que norte→10 requiera la llave oxidada,
 * y los exits de sala 10 para que sur→7 también requiera la llave oxidada. (BUG-1188)
 */
function migrateDoors() {
  const room7 = db.getRoom(7);
  if (!room7) return;

  const exits7 = room7.exits || {};
  // Solo actualizar si la salida norte no tiene estructura de objeto (formato viejo)
  if (typeof exits7.north === 'number') {
    const newExits = {
      ...exits7,
      north: { room_id: exits7.north, key: 'llave oxidada' },
    };
    const newDesc = 'Un pozo en el centro de la sala emite un viento frío desde las profundidades. Una cuerda cuelga al borde —la inscripción en la pared dice que nadie que intentó bajar volvió para contarlo. Al norte, una puerta de hierro macizo con una cerradura oxidada bloquea el paso al Santuario. (💡 Si no tenés la llave, hay otra ruta al Santuario: volvé a la Entrada, tomá el este hacia la Capilla, sigue norte por los Hongos y el Trono.)';
    db.upsertRoom({ ...room7, exits: newExits, description: newDesc });
    console.log('[seed] migrateDoors: Sala 7 actualizada — norte hacia sala 10 requiere llave oxidada 🔒');
  }

  // BUG-1188: también bloquear la dirección inversa (Santuario→Pozo, sala 10 south→7)
  const room10 = db.getRoom(10);
  if (room10) {
    const exits10 = room10.exits || {};
    if (typeof exits10.south === 'number') {
      const newExits10 = {
        ...exits10,
        south: { room_id: exits10.south, key: 'llave oxidada' },
      };
      db.upsertRoom({ ...room10, exits: newExits10 });
      console.log('[seed] migrateDoors: Sala 10 actualizada — sur hacia sala 7 requiere llave oxidada 🔒 (BUG-1188)');
    }
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
      loot: ['fragmento de hielo', 'cristal helado', 'poción de salud'],
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
        damage: 6,  // DIS-D02: reducido de 10 a 6 HP (la ruta natural de exploración pasa por aquí frecuentemente)
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
  // Sala 5 (Capilla): hierba curativa near murciélago vampiro
  // BUG FIX: el check original buscaba 'antídoto' pero insertaba 'hierba curativa',
  // causando que se acumulara una nueva hierba en cada reinicio del servidor.
  const room5 = db.getRoom(5);
  if (room5) {
    const items5 = room5.items || [];
    // Limpiar exceso: mantener máximo 1 hierba curativa en la sala
    const nonHierbas = items5.filter(i => i !== 'hierba curativa');
    const hierbas = items5.filter(i => i === 'hierba curativa');
    if (hierbas.length === 0) {
      db.updateRoomItems(5, [...nonHierbas, 'hierba curativa']);
      console.log('[seed] migrateAntidotes: hierba curativa agregada en Sala 5 (Capilla Olvidada)');
    } else if (hierbas.length > 1) {
      // Fix acumulación: dejar solo 1
      db.updateRoomItems(5, [...nonHierbas, 'hierba curativa']);
      console.log(`[seed] migrateAntidotes: limpiados ${hierbas.length - 1} duplicados de hierba curativa en Sala 5`);
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
      loot: ['monedas de cobre', 'cuchillo oxidado'],
      respawn_room_id: 16,
    });
    console.log('[seed] migrateTutorial: Goblin de Práctica (id 20) creado en sala 16.');
  } else {
    // DIS-1090: migración del loot — asegurar que el Goblin dropee un cuchillo oxidado (arma de novato)
    const goblinLoot = Array.isArray(existingGoblin.loot) ? existingGoblin.loot : [];
    if (!goblinLoot.includes('cuchillo oxidado')) {
      db.upsertMonster({ ...existingGoblin, loot: [...goblinLoot, 'cuchillo oxidado'] });
      console.log('[seed] migrateTutorial: Goblin de Práctica loot actualizado con cuchillo oxidado (DIS-1090).');
    }
  }
}

/**
 * Sala de Subastas (T098): sala 17 conectada al este de la sala 4 (Cámara del Tesoro).
 * Agrega la sala si no existe y actualiza la salida east de sala 4.
 */
function migrateAuctionRoom() {
  const auctionRoom = db.getRoom(17);
  if (!auctionRoom) {
    db.upsertRoom({
      id: 17,
      name: 'Casa de Subastas',
      description: 'Un salón iluminado con candelabros de bronce. Filas de gradas rodean un estrado central donde los aventureros subastan sus tesoros. Un escriba elfo anota cada puja con pluma y pergamino. Un letrero reza: "TODO REMATE ES FINAL. NO SE ACEPTAN QUEJAS."',
      exits: { west: 4 },
      items: [],
    });
    console.log('[seed] migrateAuctionRoom: Sala 17 (Casa de Subastas) creada.');

    // Actualizar sala 4 para que tenga salida al este hacia sala 17
    const room4 = db.getRoom(4);
    if (room4) {
      const exits4 = room4.exits || {};
      exits4.east = 17;
      db.upsertRoom({ ...room4, exits: exits4 });
      console.log('[seed] migrateAuctionRoom: Sala 4 actualizada con salida east → 17.');
    }
  }
}

/**
 * DIS-P11: Conectar sala 21 (Sala de Práctica) desde sala 1 (Entrada de la Cripta)
 * via dirección 'down'/'bajar' para que sea accesible sin pasar por el tutorial.
 * También actualizar sala 21 para tener salida de regreso a sala 1 (up/subir).
 * Idempotente: solo modifica si la salida no existe aún.
 */
function migrateTrainingRoomAccess() {
  // Conectar sala 1 → sala 21 via 'down'
  const room1 = db.getRoom(1);
  if (room1 && !room1.exits.down) {
    const exits1 = { ...room1.exits, down: 21 };
    db.upsertRoom({ ...room1, exits: exits1 });
    console.log('[seed] migrateTrainingRoomAccess: Sala 1 actualizada con salida down → 21.');
  }

  // Conectar sala 21 → sala 1 via 'up' (además del north → 16 existente)
  const room21 = db.getRoom(21);
  if (room21 && !room21.exits.up) {
    const exits21 = { ...room21.exits, up: 1 };
    db.upsertRoom({ ...room21, exits: exits21 });
    console.log('[seed] migrateTrainingRoomAccess: Sala 21 actualizada con salida up → 1.');
  }
}

/**
 * DIS-648: El Campeón Espectral dropea lanza espectral duplicada si el jugador ya la crafteo.
 * Cambiar 'lanza espectral' en el loot base por 'cristal resonante' (ingrediente de lanza espectral del eco).
 * Así el crafteo y el drop dan recompensas complementarias.
 */
function migrateCampeonEspectralLoot() {
  const all = db.getAllMonsters ? db.getAllMonsters() : [];
  const campeon = all.find(m => m.id === 12 || (m.name && m.name.toLowerCase().includes('campeón espectral')));
  if (!campeon) {
    console.warn('[seed] migrateCampeonEspectralLoot: Campeón Espectral no encontrado');
    return;
  }
  const loot = Array.isArray(campeon.loot) ? campeon.loot : (typeof campeon.loot === 'string' ? JSON.parse(campeon.loot) : []);
  if (!loot.includes('lanza espectral')) {
    // Ya migrado o no tiene lanza espectral en loot
    return;
  }
  const newLoot = loot.map(i => i === 'lanza espectral' ? 'cristal resonante' : i);
  db.updateMonster(campeon.id, { loot: JSON.stringify(newLoot) });
  console.log('[seed] migrateCampeonEspectralLoot: Campeón Espectral loot lanza espectral→cristal resonante. DIS-648 ✓');
}


/**
 * DIS-1105: El Gólem de Piedra (Santuario Profano, nivel 5+) se derrota fácilmente con Guerrero nivel 4 + smash.
 * Subir HP de 55 a 70 para que sea genuinamente peligroso sin equipo de calidad.
 * La resistencia física ×0.75 y regeneración de 8 HP/2 turnos se mantienen en combat.js.
 */
function migrateGolemPiedraDIS1105() {
  const all = db.getAllMonsters ? db.getAllMonsters() : [];
  const g = all.find(m => m.id === 5 || (m.name && m.name.toLowerCase().includes('gólem de piedra')));
  if (!g) {
    console.warn('[seed] migrateGolemPiedraDIS1105: Gólem de Piedra no encontrado');
    return;
  }
  if (g.max_hp >= 70) {
    // Ya actualizado
    return;
  }
  db.updateMonster(g.id, { hp: 70, max_hp: 70 });
  console.log('[seed] migrateGolemPiedraDIS1105: Gólem de Piedra HP 55→70. DIS-1105 ✓');
}

/**
 * DIS-1107: El hint del mercader en el Corredor de las Sombras (sala 2) solo aparece
 * en el evento cinemático de primer descubrimiento. Si el jugador muere o vuelve a la sala,
 * no hay ninguna pista de que al norte (y luego al este) hay un mercader.
 * Solución: actualizar la descripción de sala 2 para incluir la mención al mercader.
 */
function migrateCorredorHintDIS1107() {
  try {
    const room2 = db.getRoom(2);
    if (!room2) return;
    // Agregar hint solo si la descripción no lo incluye ya
    const HINT_MARKER = 'cuero curtido y cera';
    if (room2.description && room2.description.includes(HINT_MARKER)) {
      console.log('[seed] migrateCorredorHintDIS1107: sala 2 ya tiene hint — sin cambios.');
      return;
    }
    const newDesc = (room2.description || '').trimEnd() + ' Un leve olor a cuero curtido y cera llega desde el norte — alguien hace negocios en estas catacumbas.';
    db.upsertRoom({ ...room2, description: newDesc });
    console.log('[seed] migrateCorredorHintDIS1107: sala 2 descripción actualizada con hint de mercader. DIS-1107 ✓');
  } catch (e) {
    console.warn('[seed] migrateCorredorHintDIS1107:', e.message);
  }
}

module.exports = { seedIfEmpty, ROOMS, MONSTERS, migrateAuctionRoom, migrateFountainRoom, migrateEchoRooms, migrateTrainingRoom, migrateArmorLoot, migrateScrollLoot, migrateCryptRoom, migrateTrainingRoomAccess, migrateCraftingLoot, migrateMerchantRoom, migrateNarrativeLore, migrateBossStats, migrateIceFragmentLoot, migratePistaSantuario, migrateD46MonsterBalance, migrateManaLoot, migrateSanctuaryEastHint, migrateFountainConnections, migrateBossRebalance, migrateForjaHeatWarning, migratePrisonContent, migrateRestoreGoblinTutorial, migrateExtraBats, migrateEarlyEconomy, migratePassiveAuctions, migratePrisonConnection, migrateGuardiaEspectralHP, migrateGolemPiedraHP, migrateCampeonEspectralLoot, migrateColiseoEcoConnection, migrateFixEcoConnectionDuplicates, migrateGuardiaEspectralHP2, migrateEcoColiseoReturn, migrateGolemForjaHP, migratePetoHuesosFixID, migrateBatStatsReset, migrateLichHPRebalance, migrateSombraVacioHP, migrateAbismoLootFix, migrateHongoAzulSala6, migrateBossHPFullReset, migrateLichHPDIS794, migrateCatedralBagDIS793, migrateFuenteEternaDIS801, migrateSombraVacioHPDIS807, migrateSombraLootDIS813, migratePozo820, migrateFixStuckPassiveAuctions, migrateCoronaRotaPrison985, migrateFixCorruptStatusEffects992, migrateCleanPrisonEpicLoot1007, migrateMerchantHintDIS1005, migrateGaleriaHieloCuracionDIS1035, migratePistaSantuarioTrapasDIS1038, migrateEconomyRebalanceDIS1043, migratePracticaHintDIS1041, migrateCleanPistaSantuarioBUG1047, migrateGolemPiedraDIS1105, migrateCorredorHintDIS1107, migrateSanctuarioQuoteDIS1108, migrateRemoveCoronaSala9DIS1190, migrateSecondGoblinDIS1202, migrateEspectroHPDIS1203, migrateEntradaCriptaDIS1213, migrateGoblinATKDIS1316, migrateEarlyGameATKDIS1324, migrateCapillaHongoHintDIS1430, migrateFixCryptExitBUG1447, migratePozoPistaDIS1453, migrateHachaRusticaBUG1471, migrateCleanCatedralEpicLootBUG1474, migrateTrollForjaDIS1481, migratePozoDescDIS1562, migrateEcosHubDescDIS1584, migrateQuestGoblinDIS1590, migrateQuestPurgaOrdenDIS1605, migrateQuestRitualOscuridadBUG1654, migrateOrphanedGuildsBUG1646, migrateCapillaInscripcionBUG1682, migrateHongoAzulCapillaDIS1745, migrateGnollMerodeadorIMPL1761, migrateZombieCaminanteIMPL1761, migrateElementalFuegoIMPL1761, migrateBatVampireDescDIS1775, migrateFuenteEternaDescDIS1778, migrateSubastaNorthHintDIS1789, migrateConclaveExamineDIS1796 };

/**
 * DIS-1108: El texto atmosférico del primer descubrimiento del Santuario Profano
 * ("la estatua no te mira — te cataloga") solo aparece una vez. Si el jugador muere
 * y vuelve, ese momento se pierde para siempre.
 * Solución: agregar una versión acortada como quote permanente al final de la descripción de sala 10.
 */
function migrateSanctuarioQuoteDIS1108() {
  try {
    const room10 = db.getRoom(10);
    if (!room10) return;
    const HINT_MARKER = 'no te mira — te cataloga';
    if (room10.description && room10.description.includes(HINT_MARKER)) {
      console.log('[seed] migrateSanctuarioQuoteDIS1108: sala 10 ya tiene quote — sin cambios.');
      return;
    }
    const newDesc = (room10.description || '').trimEnd() + '\n\n«La estatua no te mira — te cataloga.»';
    db.upsertRoom({ ...room10, description: newDesc });
    console.log('[seed] migrateSanctuarioQuoteDIS1108: sala 10 descripción actualizada con quote permanente. DIS-1108 ✓');
  } catch (e) {
    console.warn('[seed] migrateSanctuarioQuoteDIS1108:', e.message);
  }
}

/**
 * DIS-534 + DIS-541: Arregla la economía temprana rota.
 * - Goblin Merodeador (id 1): cobre (1g) → plata (5g) + agrega monedas de cobre extra
 *   para que la Rata Gigante (id 3) tenga hierba curativa en su loot.
 * - Rata Gigante (id 3): agrega 'hierba curativa' al loot (drops a 40% via LOOT_CHANCES en combat.js)
 * - Araña Tejedora (id 7): agrega 'monedas de plata' al loot
 * Resultado esperado: a nivel 3, el jugador acumula ~20-25g en 5-6 peleas.
 * Además, la Rata Gigante da acceso a curación básica sin depender del ciclo roto hierba+poción.
 */
function migrateEarlyEconomy() {
  // Goblin Merodeador (id 1): reemplazar 'monedas de cobre' por 'monedas de plata'
  const goblin = db.getMonster(1);
  if (goblin && goblin.loot.includes('monedas de cobre') && !goblin.loot.includes('monedas de plata')) {
    const newLoot = goblin.loot.map(item => item === 'monedas de cobre' ? 'monedas de plata' : item);
    db.upsertMonster({ ...goblin, loot: newLoot });
    console.log('[seed] migrateEarlyEconomy: Goblin Merodeador ahora suelta monedas de plata (5g). DIS-534 ✓');
  }

  // Rata Gigante (id 3): agregar 'hierba curativa' al loot si no la tiene ya
  const rat = db.getMonster(3);
  if (rat && !rat.loot.includes('hierba curativa')) {
    db.upsertMonster({ ...rat, loot: [...rat.loot, 'hierba curativa'] });
    console.log('[seed] migrateEarlyEconomy: Rata Gigante ahora puede soltar hierba curativa. DIS-541 ✓');
  }

  // Araña Tejedora (id 7): agregar 'monedas de plata' al loot si no las tiene ya
  const spider = db.getMonster(7);
  if (spider && !spider.loot.includes('monedas de plata')) {
    db.upsertMonster({ ...spider, loot: [...spider.loot, 'monedas de plata'] });
    console.log('[seed] migrateEarlyEconomy: Araña Tejedora ahora suelta monedas de plata. DIS-534 ✓');
  }
}

/**
 * STORY-003/004/005/007/012/017 — Migración de lore narrativo:
 * Actualiza descripciones de salas para incluir pistas sutiles del trasfondo.
 * También agrega ítems examinables (carta sellada en sala 8, páginas congeladas en sala 11).
 * Agrega mensajes "de fábrica" en las paredes de salas clave (STORY-017).
 */
function migrateNarrativeLore() {
  // STORY-003: Sala 2 — inscripción legible en el corredor
  const room2 = db.getRoom(2);
  if (room2 && !room2.description.includes('cera endurecida')) {
    db.upsertRoom({ ...room2, description: 'Un pasillo largo y estrecho. Las paredes de piedra sudan humedad. Inscripciones ilegibles cubren cada centímetro —excepto una línea en el centro del corredor, protegida por cera endurecida. (Podés usar examine pared para leerla.)' });
    console.log('[seed] migrateNarrativeLore: Sala 2 actualizada con pista narrativa.');
  }
  // STORY-004: Sala 5 — cera fresca en el altar + pista de inscripción (DIS-1680)
  const room5 = db.getRoom(5);
  if (room5 && (!room5.description.includes('cera derretida') || !room5.description.includes('inscripción'))) {
    db.upsertRoom({ ...room5, description: 'Un altar de piedra negra domina la sala. Velas apagadas desde hace siglos —pero en la base del altar hay cera derretida fresca. Alguien estuvo aquí recientemente. (Usá examine altar para más detalles.)\n📜 Una inscripción en la pared norte llama tu atención. (examine inscripcion)' });
    console.log('[seed] migrateNarrativeLore: Sala 5 actualizada con cera fresca en altar + pista inscripción.');
  }
  // STORY-005: Sala 9 — trono sin polvo
  const room9 = db.getRoom(9);
  if (room9 && !room9.description.includes('sin polvo')) {
    db.upsertRoom({ ...room9, description: 'Un trono de huesos ocupa el centro de la sala. Las paredes están decoradas con escudos de armas de reinos extintos —todos cubiertos de polvo, excepto uno que brilla como si fuera nuevo. El trono tampoco tiene polvo. Alguien lo usa. (Podés usar examine trono o examine escudos.)' });
    console.log('[seed] migrateNarrativeLore: Sala 9 actualizada con trono sin polvo.');
  }
  // STORY-012: Sala 8 — carta sellada (añadir ítem si no existe)
  const room8 = db.getRoom(8);
  if (room8 && !(room8.items || []).includes('carta sellada')) {
    const newItems = [...(room8.items || []), 'carta sellada'];
    db.upsertRoom({ ...room8, items: newItems });
    console.log('[seed] migrateNarrativeLore: carta sellada agregada a sala 8 (Prisión Subterránea).');
  }
  // STORY-007: Sala 11 — páginas congeladas (añadir ítem si no existe)
  const room11 = db.getRoom(11);
  if (room11 && !(room11.items || []).includes('páginas congeladas')) {
    const newItems11 = [...(room11.items || []), 'páginas congeladas'];
    db.upsertRoom({ ...room11, items: newItems11 });
    console.log('[seed] migrateNarrativeLore: páginas congeladas agregadas a sala 11 (Galería de Hielo).');
  }
  // STORY-017: Mensajes de fábrica en las paredes de salas clave
  // (solo agregar si no existen ya — verificar por contenido)
  const wallMessages = db.getWallMessages ? db.getWallMessages(7) : null;
  if (wallMessages !== null && wallMessages.length === 0) {
    db.addWallMessage && db.addWallMessage(7,  'Anónimo', 'No tires de la cuerda. — Alguien que no quiso firmar');
    db.addWallMessage && db.addWallMessage(11, 'Anónimo', 'Vi su sombra en la Catedral antes de llegar a la Catedral. Eso no es posible.');
    db.addWallMessage && db.addWallMessage(14, 'Anónimo', 'Los esqueletos en las gradas aplauden cuando morís. No lo ves, pero lo sentís.');
    console.log('[seed] migrateNarrativeLore: mensajes de fábrica agregados a salas 7/11/14.');
  }
  // T239: Inscripciones del lore en salas 5 y 9 (idempotente — verificar por contenido)
  if (db.getWallMessages && db.addWallMessage) {
    const msgs5 = db.getWallMessages(5);
    const hasSala5Lore = msgs5.some(m => m.message && m.message.includes('merece lo que viene'));
    if (!hasSala5Lore) {
      db.addWallMessage(5, 'Grabado en la piedra', 'Quienquiera que encienda estas velas merece lo que viene.');
      console.log('[seed] T239: inscripción de lore agregada en sala 5 (Capilla Olvidada).');
    }
    const msgs9 = db.getWallMessages(9);
    const hasSala9Lore = msgs9.some(m => m.message && m.message.includes('El trono espera'));
    if (!hasSala9Lore) {
      db.addWallMessage(9, 'Grabado en la piedra', 'El trono espera. El trono siempre esperó.');
      console.log('[seed] T239: inscripción de lore agregada en sala 9 (Sala del Trono).');
    }
    const msgs14 = db.getWallMessages(14);
    const hasSala14Lore = msgs14.some(m => m.message && m.message.includes('hay algo peor'));
    if (!hasSala14Lore) {
      db.addWallMessage(14, 'Grabado en la piedra', 'Si llegaste hasta aquí, ya sabés que hay algo peor abajo.');
      console.log('[seed] T239: inscripción de lore agregada en sala 14 (Coliseo de Huesos).');
    }
  }
  // T241: Coherencia narrativa de la cadena religiosa (salas 5 → 10 → 15)
  // Sala 10: agregar vocabulario que conecte con la piedra negra del altar y las marcas
  const room10 = db.getRoom(10);
  if (room10 && !room10.description.includes('misma piedra')) {
    db.upsertRoom({ ...room10, description: 'El corazón del dungeon. Una estatua monstruosa con diez brazos preside la sala, tallada en la misma piedra negra del altar de la Capilla. El suelo está cubierto de runas trazadas con sangre seca —las mismas marcas que viste grabadas arriba, pero aquí son más grandes y más frescas. Aquí termina el dungeon... o comienza.' });
    console.log('[seed] T241: Sala 10 actualizada con coherencia narrativa (misma piedra negra).');
  }
}

/**
 * T152: Agregar armaduras al loot de algunos monstruos.
 * Idempotente: solo actualiza si el loot actual no contiene ya la armadura.
 */
function migrateArmorLoot() {
  // Guardia Espectral (id 6) → alabarda de huesos + peto de huesos
  const ghost = db.getMonster(6);
  if (ghost && !ghost.loot.includes('peto de huesos')) {
    db.upsertMonster({ ...ghost, loot: [...ghost.loot, 'peto de huesos'] });
    console.log('[seed] migrateArmorLoot: peto de huesos agregado a Guardia Espectral (id 6).');
  }

  // Campeón Espectral (id 12) → armadura de placas
  // BUG-046 fix: el id correcto del Campeón Espectral es 12, no 13 (13 es el Lich Anciano)
  const champ = db.getMonster(12);
  if (champ && !champ.loot.includes('armadura de placas')) {
    db.upsertMonster({ ...champ, loot: [...champ.loot, 'armadura de placas'] });
    console.log('[seed] migrateArmorLoot: armadura de placas agregada a Campeón Espectral (id 12).');
  }

  // Sombra del Vacío (id 22) → veste de sombra
  const shadow = db.getMonster(22);
  if (shadow && !shadow.loot.includes('veste de sombra')) {
    db.upsertMonster({ ...shadow, loot: [...shadow.loot, 'veste de sombra'] });
    console.log('[seed] migrateArmorLoot: veste de sombra agregada a Sombra del Vacío (id 22).');
  }

  // Araña Tejedora (id 7) → capa de araña
  const spider = db.getMonster(7);
  if (spider && !spider.loot.includes('capa de araña')) {
    db.upsertMonster({ ...spider, loot: [...spider.loot, 'capa de araña'] });
    console.log('[seed] migrateArmorLoot: capa de araña agregada a Araña Tejedora (id 7).');
  }

  // DIS-455: Araña Tejedora (id 7) → llave oxidada (15% de drop vía LOOT_CHANCES)
  const spiderFresh = db.getMonster(7);
  if (spiderFresh && !spiderFresh.loot.includes('llave oxidada')) {
    db.upsertMonster({ ...spiderFresh, loot: [...spiderFresh.loot, 'llave oxidada'] });
    console.log('[seed] migrateArmorLoot: llave oxidada (15% drop) agregada a Araña Tejedora (id 7) — DIS-455.');
  }
}

/**
 * Sala de la Fuente de Rejuvenecimiento (T103): sala 18 conectada al norte de la sala 10 (Santuario Profano).
 * La fuente recupera HP completo pero tiene cooldown global de 10 min por sala.
 */
function migrateFountainRoom() {
  const fountainRoom = db.getRoom(18);
  if (!fountainRoom) {
    db.upsertRoom({
      id: 18,
      name: 'Cámara de la Fuente Eterna',
      description: 'Una cámara circular tallada en mármol blanco, luminosa pese a la oscuridad del dungeon. En el centro burbujea una fuente de agua plateada que nunca se agota. El agua tiene propiedades curativas legendarias. En las paredes, runas antiguas advierten: "El poder de la fuente requiere descanso. Quien abuse de ella hallará el agua demorada."',
      exits: { south: 10 },
      items: [],
    });
    console.log('[seed] migrateFountainRoom: Sala 18 (Cámara de la Fuente Eterna) creada.');

    // Actualizar sala 10 para que tenga salida al norte hacia sala 18
    const room10 = db.getRoom(10);
    if (room10) {
      const exits10 = room10.exits || {};
      exits10.north = 18;
      db.upsertRoom({ ...room10, exits: exits10 });
      console.log('[seed] migrateFountainRoom: Sala 10 actualizada con salida north → 18.');
    }
  }
}

/**
 * T132 — Dungeon Extendido: Cámara del Eco (sala 19) y Abismo Eterno (sala 20).
 * Sala 19 conectada al sur de la sala 15 (Catedral de la Oscuridad).
 * Sala 20 conectada al sur de la sala 19 (Cámara del Eco).
 * Monstruos: Eco Viviente (id 21) en sala 19, Sombra del Vacío (id 22) en sala 20.
 */
function migrateEchoRooms() {
  // Sala 19 — Cámara del Eco
  const echoRoom = db.getRoom(19);
  if (!echoRoom) {
    db.upsertRoom({
      id: 19,
      name: 'Cámara del Eco',
      description: 'Una sala circular de paredes perfectamente lisas. Todo sonido aquí regresa multiplicado, distorsionado, como voces de los muertos. El suelo está cubierto de cristales resonantes que vibran al pisarlos. El eco de tus propios pasos te sigue como una sombra.',
      exits: { north: 15, south: 20 },
      items: ['cristal resonante', 'polvo de eco'],
    });
    console.log('[seed] migrateEchoRooms: Sala 19 (Cámara del Eco) creada.');

    // Conectar sala 15 hacia el sur con sala 19
    const room15 = db.getRoom(15);
    if (room15) {
      const exits15 = room15.exits || {};
      exits15.south = 19;
      db.upsertRoom({ ...room15, exits: exits15 });
      console.log('[seed] migrateEchoRooms: Sala 15 actualizada con salida south → 19.');
    }
  }

  // Sala 20 — Abismo Eterno
  const abyssRoom = db.getRoom(20);
  if (!abyssRoom) {
    db.upsertRoom({
      id: 20,
      name: 'Abismo Eterno',
      description: 'El fondo del dungeon. Una grieta infinita en el suelo emite un resplandor violeta que hipnotiza a quien lo mira demasiado tiempo. El aire es denso, casi líquido. Las sombras aquí tienen vida propia y parecen curiosas por los intrusos. Una sensación de vacío absoluto te envuelve.',
      exits: { north: 19 },
      items: ['fragmento de vacío', 'cristal resonante'],
    });
    console.log('[seed] migrateEchoRooms: Sala 20 (Abismo Eterno) creada.');
  }

  // Monstruo: Eco Viviente (id 21) en sala 19
  const ecoViviente = db.getMonster(21);
  if (!ecoViviente) {
    db.upsertMonster({
      id: 21,
      name: 'Eco Viviente',
      description: 'Una entidad translúcida que imita las formas de aventureros caídos. Sus ataques son ecos de los golpes que recibió quien murió aquí. Vibra y se distorsiona en el aire.',
      hp: 35,
      max_hp: 35,
      attack: 7,
      room_id: 19,
      loot: ['cristal resonante', 'polvo de eco', 'esencia de eco'],
      respawn_room_id: 19,
    });
    console.log('[seed] migrateEchoRooms: Eco Viviente (id 21) creado en sala 19.');
  }

  // Monstruo: Sombra del Vacío (id 22) en sala 20
  const sombraVacio = db.getMonster(22);
  if (!sombraVacio) {
    db.upsertMonster({
      id: 22,
      name: 'Sombra del Vacío',
      description: 'Una forma oscura que parece un agujero en la realidad. Sus bordes se disuelven en la oscuridad. Ataca con tentáculos de oscuridad pura que drenan la energía vital. Es el guardián final del dungeon.',
      hp: 60,
      max_hp: 60,
      attack: 10,
      room_id: 20,
      loot: ['fragmento de vacío', 'cristal resonante', 'esencia del abismo', 'monedas de oro'],
      respawn_room_id: 20,
    });
    console.log('[seed] migrateEchoRooms: Sombra del Vacío (id 22) creado en sala 20.');
  }
}

/**
 * T143 — Sala de Entrenamiento (sala 21) conectada al sur de sala 16 (Antesala del Dungeon).
 * Contiene 3 maniquíes de paja (ids 23, 24, 25) que se regeneran solos.
 * El combate aquí NO da XP, kills ni loot real — solo estadísticas.
 */
function migrateTrainingRoom() {
  // Sala 21 — Sala de Práctica
  const trainingRoom = db.getRoom(21);
  if (!trainingRoom) {
    db.upsertRoom({
      id: 21,
      name: 'Sala de Práctica',
      description: 'Una sala acolchada con muros de madera reforzada. Tres maniquíes de paja cuelgan de postes de hierro, listos para ser golpeados sin misericordia. En la pared hay una pizarra con inscripciones: "Aquí no hay gloria, solo entrenamiento. Nada de lo que pase aquí cuenta en el registro."',
      exits: { north: 16 },
      items: [],
    });
    console.log('[seed] migrateTrainingRoom: Sala 21 (Sala de Práctica) creada.');

    // Conectar sala 16 para que tenga salida al sur hacia sala 21
    const room16 = db.getRoom(16);
    if (room16) {
      const exits16 = room16.exits || {};
      exits16.south = 21;
      db.upsertRoom({ ...room16, exits: exits16 });
      console.log('[seed] migrateTrainingRoom: Sala 16 actualizada con salida south → 21.');
    }
  }

  // Maniquí 1 (id 23)
  if (!db.getMonster(23)) {
    db.upsertMonster({
      id: 23,
      name: 'Maniquí de Paja',
      description: 'Un muñeco de entrenamiento relleno de paja y arena. Sus ojos de carbón parecen burlarse de vos. Aguanta golpes sin quejarse.',
      hp: 20,
      max_hp: 20,
      attack: 2,
      room_id: 21,
      loot: [],
      respawn_room_id: 21,
    });
    console.log('[seed] migrateTrainingRoom: Maniquí de Paja #1 (id 23) creado.');
  }

  // Maniquí 2 (id 24)
  if (!db.getMonster(24)) {
    db.upsertMonster({
      id: 24,
      name: 'Maniquí Blindado',
      description: 'Un maniquí recubierto con placas de madera y cuero endurecido. Más resistente que el básico. Ideal para practicar ataques potentes.',
      hp: 35,
      max_hp: 35,
      attack: 3,
      defense: 2,
      room_id: 21,
      loot: [],
      respawn_room_id: 21,
    });
    console.log('[seed] migrateTrainingRoom: Maniquí Blindado #2 (id 24) creado.');
  }

  // Maniquí 3 (id 25)
  if (!db.getMonster(25)) {
    db.upsertMonster({
      id: 25,
      name: 'Maniquí Veloz',
      description: 'Un maniquí montado en un pivote giratorio que contraataca con rapidez. Golpea más fuerte que los otros pero cae rápido. Perfecto para practicar esquivas.',
      hp: 15,
      max_hp: 15,
      attack: 5,
      room_id: 21,
      loot: [],
      respawn_room_id: 21,
    });
    console.log('[seed] migrateTrainingRoom: Maniquí Veloz #3 (id 25) creado.');
  }
}

/**
 * T153: Agregar pergaminos mágicos al loot de monstruos de élite.
 * Idempotente: solo actualiza si el loot actual no contiene ya el pergamino.
 */
function migrateScrollLoot() {
  // Lich Anciano (id 13) → pergamino de furia
  const lich = db.getMonster(13);
  if (lich && !lich.loot.includes('pergamino de furia')) {
    db.updateMonster(13, { loot: [...lich.loot, 'pergamino de furia'] });
    console.log('[seed] migrateScrollLoot: pergamino de furia agregado a Lich Anciano (id 13).');
  }

  // Campeón Espectral (id 12) → pergamino de velocidad
  const champion = db.getMonster(12);
  if (champion && !champion.loot.includes('pergamino de velocidad')) {
    db.updateMonster(12, { loot: [...champion.loot, 'pergamino de velocidad'] });
    console.log('[seed] migrateScrollLoot: pergamino de velocidad agregado a Campeón Espectral (id 12).');
  }

  // Sombra del Vacío (id 22) → pergamino de escudo
  const shadow = db.getMonster(22);
  if (shadow && !shadow.loot.includes('pergamino de escudo')) {
    db.updateMonster(22, { loot: [...shadow.loot, 'pergamino de escudo'] });
    console.log('[seed] migrateScrollLoot: pergamino de escudo agregado a Sombra del Vacío (id 22).');
  }
}

/**
 * T179 — Cripta de los Valientes (sala 22).
 * Sala especial conectada al sur de la sala 15 (Catedral de la Oscuridad).
 * Las placas en la pared son wall_messages generados automáticamente al caer un jugador Hardcore.
 */
function migrateCryptRoom() {
  const cryptRoom = db.getRoom(22);
  if (!cryptRoom) {
    db.upsertRoom({
      id: 22,
      name: 'Cripta de los Valientes',
      description: 'Una cámara fría tallada en piedra oscura. Las paredes están cubiertas de placas grabadas, cada una con el nombre de un aventurero que cayó en el Dungeon sin rendirse. El aire huele a cera de velas apagadas. Una inscripción en el arco de entrada dice: \"Aquí descansan los que eligieron la gloria por encima de la seguridad.\" El silencio aquí es absoluto, reverente.',
      exits: { north: 15 },
      items: [],
    });
    console.log('[seed] migrateCryptRoom: Sala 22 (Cripta de los Valientes) creada.');

    // Conectar sala 15 para que tenga salida al sur hacia sala 22
    const room15 = db.getRoom(15);
    if (room15) {
      const exits15 = room15.exits || {};
      // sala 15 ya tiene south → sala 19 (Cámara del Eco), usamos west si no hay otro
      // En realidad podemos agregar una segunda salida; pero según el mapa original
      // sala 15 tiene west: 14 y south: 19. Usar southwest o una dirección libre.
      // Solución: conectar via 'down' (abajo/bajar — la cripta está enterrada bajo la catedral)
      exits15.down = 22;
      db.upsertRoom({ ...room15, exits: exits15 });
      console.log('[seed] migrateCryptRoom: Sala 15 actualizada con salida down → 22.');
    }
  }
}

/**
 * DIS-P10: Agregar materiales de crafteo a los loot de monstruos apropiados.
 * - Esqueleto Guerrero (id 2) → garra de esqueleto (para receta: garra + cuerda = látigo de garras)
 * - Murciélago Vampiro (id 6) → diente afilado (para receta: diente + hilo de seda = collar de garras)
 * - Eco Viviente (id 21) → polvo de eco como alias alternativo junto a esencia de eco
 */
function migrateCraftingLoot() {
  // Esqueleto Guerrero (id 2) → garra de esqueleto
  const skeleton = db.getMonster(2);
  if (skeleton && !skeleton.loot.includes('garra de esqueleto')) {
    db.upsertMonster({ ...skeleton, loot: [...skeleton.loot, 'garra de esqueleto'] });
    console.log('[seed] migrateCraftingLoot: garra de esqueleto agregada a Esqueleto Guerrero (id 2).');
  }
  // Murciélago Vampiro (id 6, NO id 4 — el id 4 es el Espectro del Corredor) → diente afilado
  // BUG-337: el id estaba equivocado, causando que el Espectro droppee diente afilado por error.
  const bat = db.getMonster(6);
  if (bat && !bat.loot.includes('diente afilado')) {
    db.upsertMonster({ ...bat, loot: [...bat.loot, 'diente afilado'] });
    console.log('[seed] migrateCraftingLoot: diente afilado agregado a Murciélago Vampiro (id 6).');
  }
  // BUG-337: Reparar el Espectro del Corredor (id 4) quitando el diente afilado que recibió por error
  const spectre = db.getMonster(4);
  if (spectre && spectre.loot.includes('diente afilado')) {
    db.upsertMonster({ ...spectre, loot: spectre.loot.filter(i => i !== 'diente afilado') });
    console.log('[seed] migrateCraftingLoot (BUG-337): diente afilado removido del Espectro del Corredor (id 4).');
  }
}

/**
 * DIS-D08: Mover al Esqueleto Guerrero fuera de la Cámara del Tesoro (sala 4, la del mercader Aldric).
 * El respawn_room_id se cambia a sala 3 (Sala de los Ecos), que es adyacente.
 * Si el monstruo está actualmente en sala 4, se mueve inmediatamente a sala 3.
 * DIS-D02: Reducir daño de trampa de la Sala del Trono (sala 9) de 10 a 6 HP.
 */
function migrateMerchantRoom() {
  const skeleton = db.getMonster(2);
  if (skeleton) {
    let changed = false;
    const updates = {};
    if (skeleton.respawn_room_id === 4) {
      updates.respawn_room_id = 3;
      changed = true;
    }
    if (skeleton.room_id === 4) {
      updates.room_id = 3;
      changed = true;
    }
    if (changed) {
      db.upsertMonster({ ...skeleton, ...updates });
      console.log('[seed] migrateMerchantRoom: Esqueleto Guerrero movido de sala 4 → sala 3 (mercader ahora tiene sala para él solo).');
    }
  }
  // DIS-D02: Reducir daño de la trampa del Trono a 6 HP si aún es 10
  const throneRoom = db.getRoom(9);
  if (throneRoom && throneRoom.trap && throneRoom.trap.damage === 10) {
    const updatedTrap = { ...throneRoom.trap, damage: 6 };
    const exits = throneRoom.exits || {};
    const items = throneRoom.items || [];
    db.upsertRoom({ ...throneRoom, exits, items, trap: JSON.stringify(updatedTrap) });
    console.log('[seed] migrateMerchantRoom: Trampa Sala del Trono reducida de 10 → 6 HP (DIS-D02).');
  }
}

/**
 * BUG-046: El Lich Anciano (id 13) tiene max_hp=1 en la BD debido a que migrateArmorLoot
 * usaba id=13 creyendo ser el Campeón Espectral (id real=12). Esto causaba que upsertMonster
 * sobreescribiera al Lich con los campos del Campeón (incluido max_hp=40), y luego la lógica
 * de respawn/élite podía degradar max_hp. Corrección: restaurar al Lich a sus stats correctas
 * (hp=60, max_hp=60, attack=12) si max_hp < 30 (indicador inequívoco del bug).
 */
function migrateBossStats() {
  const lich = db.getMonster(13);
  if (lich && lich.max_hp < 30) {
    db.updateMonster(13, {
      name: 'Lich Anciano',
      hp: 60,
      max_hp: 60,
      attack: 12,
      room_id: 15,
      respawn_at: null,
    });
    console.log('[seed] migrateBossStats: Lich Anciano (id 13) restaurado a stats correctos (HP:60, ATK:12). Bug BUG-046 corregido.');
  }
}

/**
 * DIS-D34: Agregar fragmento de hielo al loot del Elemental de Hielo (id 9).
 * El fragmento de hielo es ingrediente de la receta de la lanza espectral (endgame)
 * pero no tenía fuente obtenible. Ahora dropea del Elemental de Hielo y también
 * puede encontrarse con forage en la Galería de Hielo (sala 11).
 */
function migrateIceFragmentLoot() {
  const elemental = db.getMonster(9);
  if (elemental && !elemental.loot.includes('fragmento de hielo')) {
    db.upsertMonster({ ...elemental, loot: ['fragmento de hielo', ...elemental.loot] });
    console.log('[seed] migrateIceFragmentLoot: fragmento de hielo agregado al loot del Elemental de Hielo (id 9).');
  }
}

/**
 * DIS-D42: Agregar pista de ruta alternativa en la descripción de la sala 7 (Pozo Sin Fondo).
 * Los jugadores que llegan al Pozo y ven la puerta bloqueada ahora tienen una pista
 * sobre la ruta alternativa Capilla → Hongos → Trono → Santuario.
 */
function migratePistaSantuario() {
  const room7 = db.getRoom(7);
  if (!room7) return;
  const pistaVieja = '(💡 Si no tenés la llave, hay otra ruta al Santuario: volvé a la Entrada, tomá el este hacia la Capilla, sigue norte por los Hongos y el Trono.)';
  // BUG-1047: también considerar la pista actualizada por DIS-1038 como "ya presente"
  const pistaNueva = '(💡 Si no tenés la llave, hay otra ruta al Santuario: Entrada → Capilla (este) → Túnel de Hongos (norte) → Sala del Trono (este) → Santuario.';
  if (room7.description.includes(pistaVieja) || room7.description.includes(pistaNueva)) {
    // Pista ya presente (en alguna versión) — no agregar otra copia
    return;
  }
  const newDesc = room7.description.replace(
    /\s*\(💡[^)]+\)\s*$/, ''  // eliminar pista vieja si existiera
  ).trimEnd() + ' ' + pistaVieja;
  db.upsertRoom({ ...room7, description: newDesc });
  console.log('[seed] migratePistaSantuario: pista de ruta alternativa agregada en Sala 7 (Pozo Sin Fondo). DIS-D42 ✓');
}

/**
 * DIS-D46: Rebalancear curva de dificultad en zonas avanzadas.
 * Los monstruos de las salas 10-12 quedaron inflados por spawns élite acumulados.
 * La curva correcta es: Guardia Espectral (25HP/7ATK) → Gólem de Piedra (35HP/8ATK) →
 * Elemental de Hielo (~42HP/9ATK) → Golem de Forja (~48HP/10ATK).
 * Esta migración fuerza los stats a los valores balanceados si están demasiado inflados.
 */
function migrateD46MonsterBalance() {
  // ID 5: Gólem de Piedra (sala 10) — stat base: 35HP/8ATK. Élite legítimo: hasta ~53HP.
  // Si está demasiado inflado (>60HP), restablecer a 35/8
  const golem = db.getMonster(5);
  if (golem && golem.max_hp > 60) {
    const name = golem.name.startsWith('⭐ ') ? golem.name : 'Gólem de Piedra';
    const baseHp = golem.name.startsWith('⭐ ') ? 53 : 35;
    const baseAtk = golem.name.startsWith('⭐ ') ? 10 : 8;
    db.updateMonster(5, { name, hp: baseHp, max_hp: baseHp, attack: baseAtk });
    console.log(`[seed] migrateD46: Gólem de Piedra (id 5) rebalanceado → HP:${baseHp}, ATK:${baseAtk}. DIS-D46 ✓`);
  }

  // ID 9: Elemental de Hielo (sala 11) — stat base: 22HP/6ATK. Élite: ~33HP/8ATK.
  // Si está inflado (>50HP), restablecer a nivel razonable
  const elemental = db.getMonster(9);
  if (elemental && elemental.max_hp > 50) {
    const isElite = elemental.name.startsWith('⭐ ');
    const name = isElite ? '⭐ Elemental de Hielo' : 'Elemental de Hielo';
    const baseHp = isElite ? 33 : 40;  // Si era élite, reducir; si no, poner valor intermedio balanceado
    const baseAtk = isElite ? 8 : 9;
    db.updateMonster(9, { name, hp: baseHp, max_hp: baseHp, attack: baseAtk });
    console.log(`[seed] migrateD46: Elemental de Hielo (id 9) rebalanceado → HP:${baseHp}, ATK:${baseAtk}. DIS-D46 ✓`);
  }

  // ID 10: Golem de Forja (sala 12) — stat base: 30HP/9ATK. Élite: ~45HP/11ATK.
  // Si está inflado (>55HP), restablecer a nivel razonable
  const forja = db.getMonster(10);
  if (forja && forja.max_hp > 55) {
    const isElite = forja.name.startsWith('⭐ ');
    const name = isElite ? '⭐ Golem de Forja' : 'Golem de Forja';
    const baseHp = isElite ? 45 : 42;
    const baseAtk = isElite ? 11 : 10;
    db.updateMonster(10, { name, hp: baseHp, max_hp: baseHp, attack: baseAtk });
    console.log(`[seed] migrateD46: Golem de Forja (id 10) rebalanceado → HP:${baseHp}, ATK:${baseAtk}. DIS-D46 ✓`);
  }
}

/**
 * DIS-D296: Agregar pociones de maná al loot de monstruos tempranos.
 * El mago se queda sin maná en salas 1-3 y no puede comprar pociones (0g al inicio).
 * Solución: Goblin Merodeador (id 1) y Murciélago Vampiro (id 6) dropean poción de maná.
 * Idempotente: solo agrega si no está ya en el loot.
 */
function migrateManaLoot() {
  // Goblin Merodeador (id 1) → poción de maná (loot temprano para magos)
  const goblin = db.getMonster(1);
  if (goblin && !goblin.loot.includes('poción de maná')) {
    db.updateMonster(1, { loot: [...goblin.loot, 'poción de maná'] });
    console.log('[seed] migrateManaLoot: poción de maná agregada al loot del Goblin Merodeador (id 1). DIS-D296 ✓');
  }

  // Murciélago Vampiro (id 6) → poción de maná (segunda sala disponible para el mago)
  const bat = db.getMonster(6);
  if (bat && !bat.loot.includes('poción de maná')) {
    db.updateMonster(6, { loot: [...bat.loot, 'poción de maná'] });
    console.log('[seed] migrateManaLoot: poción de maná agregada al loot del Murciélago Vampiro (id 6). DIS-D296 ✓');
  }
}

/**
 * DIS-D368: La Fuente Eterna (sala 18) queda muy desconectada de las zonas profundas.
 * Los jugadores heridos en el Abismo Eterno (sala 20) y la Catedral (sala 15) tienen que
 * recorrer todo el dungeon para curar — lo cual es frustrante y narrativamente incoherente.
 * Solución:
 *   - Sala 20 (Abismo Eterno) → up → sala 18 (Fuente Eterna): pasadizo místico oculto.
 *   - Sala 18 (Fuente Eterna) → down → sala 20: conexión recíproca.
 * Narrativa: el Abismo contiene una fisura en la roca por la que gotea el agua plateada de la Fuente.
 * Los más heridos siempre encontraron ese brillo como guía. La Fuente "llama" a quien más la necesita.
 * Idempotente: no modifica si la conexión ya existe.
 */
function migrateFountainConnections() {
  // Sala 20 (Abismo Eterno): agregar up → 18
  const room20 = db.getRoom(20);
  if (room20 && !room20.exits.up) {
    const exits20 = { ...room20.exits, up: 18 };
    // Actualizar descripción para mencionar la fisura curativa
    const upHint = ' En lo alto de la pared norte, una fisura en la roca deja pasar un tenue brillo plateado — el agua de la Fuente Eterna gotea desde las alturas, marcando un camino para quienes más lo necesitan.';
    const newDesc20 = room20.description + upHint;
    db.upsertRoom({ ...room20, exits: exits20, description: newDesc20 });
    console.log('[seed] migrateFountainConnections: Sala 20 (Abismo Eterno) → up → sala 18 (Fuente Eterna). DIS-D368 ✓');
  }

  // Sala 18 (Fuente Eterna): agregar down → 20
  const room18 = db.getRoom(18);
  if (room18 && !room18.exits.down) {
    const exits18 = { ...room18.exits, down: 20 };
    // Actualizar descripción para mencionar la fisura
    const downHint = ' En el suelo, junto a la base de la fuente, una fisura brilla levemente: por allí se filtra el agua hacia las profundidades del dungeon.';
    const newDesc18 = room18.description + downHint;
    db.upsertRoom({ ...room18, exits: exits18, description: newDesc18 });
    console.log('[seed] migrateFountainConnections: Sala 18 (Fuente Eterna) → down → sala 20 (Abismo Eterno). DIS-D368 ✓');
  }
}

/**
 * DIS-D352: Zona avanzada invisible.
 * La Galería de Hielo y zonas siguientes (Forja, Caverna, Coliseo, Catedral) son invisibles
 * porque el Santuario (sala 10) no menciona la salida al este en su descripción.
 * Esta migración agrega la frase "Al este, el dungeon continúa hacia zonas más antiguas y peligrosas."
 * al final de la descripción del Santuario Profano, para que el jugador sepa que hay más.
 * Idempotente: solo actualiza si la frase no está ya presente.
 */
function migrateSanctuaryEastHint() {
  const room10 = db.getRoom(10);
  if (!room10) return;
  const eastHint = 'Al este, el dungeon continúa hacia zonas más antiguas y peligrosas.';
  if (!room10.description.includes(eastHint)) {
    const newDesc = room10.description.replace(
      /\s*Aquí termina el dungeon\.\.\. o comienza\./,
      ' Aquí termina el dungeon... o comienza. ' + eastHint
    );
    db.upsertRoom({ ...room10, description: newDesc });
    console.log('[seed] migrateSanctuaryEastHint: Santuario Profano (sala 10) actualizado — pista de zona avanzada al este. DIS-D352 ✓');
  }
}

/**
 * DIS-D423: Rebalancear bosses finales para que el combate tardío no sea trivial.
 * Con ATK ~21 del jugador en nivel 7, los bosses caían en 3 hits. Subida de stats:
 *   - Lich Anciano (id 13):        60HP/12ATK  →  100HP/16ATK
 *   - Campeón Espectral (id 12):   40HP/10ATK  →   70HP/14ATK
 *   - Sombra del Vacío (id 22):    60HP/10ATK  →   90HP/14ATK
 *   - Eco Viviente (id 21):        35HP/ 7ATK  →   55HP/10ATK
 * Idempotente: solo actualiza si max_hp no coincide con el nuevo valor (evita resets de HP actual).
 */
function migrateBossRebalance() {
  const bosses = [
    { id: 13, name: 'Lich Anciano',       new_max_hp: 100, new_attack: 16 },
    { id: 12, name: 'Campeón Espectral',  new_max_hp: 70,  new_attack: 14 },
    { id: 22, name: 'Sombra del Vacío',   new_max_hp: 90,  new_attack: 14 },
    { id: 21, name: 'Eco Viviente',       new_max_hp: 55,  new_attack: 10 },
  ];
  for (const { id, name, new_max_hp, new_attack } of bosses) {
    const m = db.getMonster(id);
    if (!m) continue;
    if (m.max_hp !== new_max_hp || m.attack !== new_attack) {
      // Si el monstruo tiene HP actual por encima del nuevo máximo, escalarlo
      const ratio = m.max_hp > 0 ? m.hp / m.max_hp : 1;
      const new_hp = m.hp > 0 ? Math.min(new_max_hp, Math.max(1, Math.round(ratio * new_max_hp))) : new_max_hp;
      db.updateMonster(id, { max_hp: new_max_hp, hp: new_hp, attack: new_attack });
      console.log(`[seed] migrateBossRebalance: ${name} (id ${id}) → ${new_hp}/${new_max_hp} HP, ATK ${new_attack}. DIS-D423 ✓`);
    }
  }
}

/**
 * DIS-D424: Agregar advertencia de daño en la descripción del Taller de la Forja (sala 12).
 * El jugador pierde 2 HP al entrar por primera vez sin ninguna advertencia previa.
 * Fix: agregar al final de la descripción una línea que indique el peligro del calor.
 * Idempotente: solo actualiza si la frase de advertencia no está ya presente.
 */
function migratePrisonContent() {
  // DIS-D425 / BUG-514: Prisión Subterránea no era un destino valioso. Esta migración:
  // 1. Actualiza descripción de sala 8 (sin mencionar ítem de suelo falso — BUG-514)
  // 2. Remueve 'sello del carcelero' del piso si estaba (versión anterior lo duplicaba — BUG-514)
  // 3. Agrega 'sello del carcelero' (+3 DEF) al loot del Guardia Espectral (único origen correcto)

  let room8 = db.getRoom(8);
  if (!room8) return;

  const newDesc = 'Celdas de hierro corroído bordean las paredes. Las rejas están abiertas — algo estuvo aquí encerrado por mucho tiempo, y finalmente salió. El aire huele a miedo viejo. Un guardia espectral patrulla las sombras: el espíritu del último carcelero, incapaz de abandonar su puesto aun en la muerte. (Podés usar examine celdas para más detalles.)';

  // BUG-514: La descripción anterior mencionaba "medallón oscuro olvidado" (que no era un ítem real
  // del suelo) y el sello del carcelero estaba TANTO en el piso como en el loot del guardia →
  // duplicación. Fix: descripción sin mención de ítem físico en el suelo; sello solo como drop.
  if (!room8.description.includes('medallón oscuro') && !room8.description.includes('miedo viejo')) {
    room8 = { ...room8, description: newDesc };
    db.upsertRoom(room8);
    console.log('[seed] migratePrisonContent: descripción de sala 8 actualizada. DIS-D425 ✓');
  } else if (room8.description.includes('medallón oscuro')) {
    // Actualizar descripción vieja (con medallón) a la nueva (sin él) — BUG-514
    room8 = { ...room8, description: newDesc };
    db.upsertRoom(room8);
    console.log('[seed] migratePrisonContent: descripción de sala 8 — removido medallón oscuro. BUG-514 ✓');
  }

  // BUG-514: Quitar 'sello del carcelero' del piso si fue agregado por una versión anterior.
  // El sello solo debe obtenerse como drop del Guardia Espectral.
  if ((room8.items || []).includes('sello del carcelero')) {
    const cleanItems = room8.items.filter(i => i !== 'sello del carcelero');
    room8 = { ...room8, items: cleanItems };
    db.upsertRoom(room8);
    console.log('[seed] migratePrisonContent: sello del carcelero removido del piso de sala 8. BUG-514 ✓');
  }

  // Agregar sello del carcelero al loot del Guardia Espectral (id=8)
  const monsters = db.getAllMonsters ? db.getAllMonsters() : [];
  const guardian = monsters.find(m => m.id === 8 || m.name === 'Guardia Espectral');
  if (guardian && !(guardian.loot || []).includes('sello del carcelero')) {
    const newLoot = [...(guardian.loot || []), 'sello del carcelero'];
    db.upsertMonster({ ...guardian, loot: newLoot });
    console.log('[seed] migratePrisonContent: sello del carcelero agregado al loot del Guardia Espectral. DIS-D425 ✓');
  }
}

function migrateForjaHeatWarning() {
  const forjaRoom = db.getRoom(12);
  if (!forjaRoom) return;
  const heatWarning = 'El calor es tan intenso que quema la piel nada más cruzar el umbral.';
  if (!forjaRoom.description.includes(heatWarning)) {
    const newDesc = forjaRoom.description + ' ' + heatWarning;
    db.upsertRoom({ ...forjaRoom, description: newDesc });
    console.log('[seed] migrateForjaHeatWarning: Taller de la Forja (sala 12) — advertencia de daño por calor agregada. DIS-D424 ✓');
  }
}

/**
 * BUG-447: Restaurar el Goblin de Práctica (id 20) a su sala de origen (sala 16) si huyó.
 * El goblin fue agregado a BOSS_MONSTERS en BUG-430 para evitar que huya en el futuro,
 * pero los servidores que arrancaron antes del fix tienen el goblin en sala 21.
 * Esto causa deadlock de tutorial: los nuevos jugadores no pueden salir de sala 16.
 */
function migrateRestoreGoblinTutorial() {
  const goblin = db.getMonster(20);
  if (!goblin) return;
  if (goblin.room_id !== 16) {
    const fx = goblin.status_effects ? (typeof goblin.status_effects === 'string' ? JSON.parse(goblin.status_effects) : goblin.status_effects) : {};
    delete fx.fled_from;
    db.upsertMonster({
      ...goblin,
      room_id: 16,
      hp: goblin.max_hp, // restaurar HP completo
      status_effects: JSON.stringify(fx),
    });
    console.log(`[seed] migrateRestoreGoblinTutorial: Goblin de Práctica restaurado a sala 16 (estaba en sala ${goblin.room_id}). BUG-447 ✓`);
  }
}

/**
 * DIS-510: Distribuir Murciélagos Vampiro en 2-3 salas para que la quest "Plaga de Murciélagos"
 * (que pide matar 3) sea solucionable explorando en lugar de esperar respawn del único mob.
 * Agrega: Murciélago Vampiro id 26 en sala 3 (Sala de los Ecos) y id 27 en sala 6 (Túnel de Hongos).
 * Sala 3 es oscura y acuosa (narrativamente plausible). Sala 6 es húmeda (ideal para murciélagos).
 */
function migrateExtraBats() {
  const bat26 = db.getMonster(26);
  if (!bat26) {
    db.upsertMonster({
      id: 26,
      name: 'Murciélago Vampiro',
      description: 'Un murciélago enorme con colmillos afilados como agujas. Revolotea entre los ecos de la sala.',
      hp: 12, max_hp: 12, attack: 3,
      room_id: 3,
      loot: ['diente afilado', 'monedas de cobre'],
      respawn_room_id: 3,
      respawn_at: null,
    });
    console.log('[seed] migrateExtraBats: Murciélago Vampiro id 26 agregado en sala 3 (Sala de los Ecos). DIS-510 ✓');
  }
  const bat27 = db.getMonster(27);
  if (!bat27) {
    db.upsertMonster({
      id: 27,
      name: 'Murciélago Vampiro',
      description: 'Un murciélago enorme que anida entre los hongos. Sus colmillos brillan en la penumbra.',
      hp: 12, max_hp: 12, attack: 3,
      room_id: 6,
      loot: ['diente afilado', 'monedas de cobre'],
      respawn_room_id: 6,
      respawn_at: null,
    });
    console.log('[seed] migrateExtraBats: Murciélago Vampiro id 27 agregado en sala 6 (Túnel de Hongos). DIS-510 ✓');
  }
}

/**
 * DIS-535: Mercado pasivo — agregar columna is_passive a la tabla auctions.
 * Las subastas pasivas son segundas rondas de 30 minutos que el Mercader
 * comprará garantizado al 50% del precio mínimo si nadie puja.
 */
function migratePassiveAuctions() {
  try {
    db.raw().run(`ALTER TABLE auctions ADD COLUMN is_passive INTEGER NOT NULL DEFAULT 0`);
    console.log('[seed] migratePassiveAuctions: columna is_passive agregada a auctions. DIS-535 ✓');
  } catch (e) {
    if (!e.message.includes('duplicate column')) {
      console.warn('[seed] migratePassiveAuctions:', e.message);
    }
  }
}

function migratePrisonConnection() {
  // DIS-538: Conectar Prisión Subterránea (8) con Casa de Subastas (17) vía pasillo este/norte.
  // Antes: sala 8 solo tenía salida al sur (→ sala 4). Dead-end total.
  // Después: sala 8 tiene también salida al este (→ sala 17), y sala 17 tiene salida al norte (→ sala 8).
  // Esto crea un pequeño loop: sala 4 ↔ sala 8 ↔ sala 17 ↔ sala 4, mejorando la conectividad
  // del ala noreste del dungeon y dando razón para explorar la Prisión.

  const room8 = db.getRoom(8);
  const room17 = db.getRoom(17);
  if (!room8 || !room17) return;

  if (room8.exits.east) {
    // Ya tiene salida al este — migración ya aplicada
    return;
  }

  // Actualizar sala 8: agregar salida este hacia sala 17
  const newExits8 = Object.assign({}, room8.exits, { east: 17 });
  // Actualizar descripción para mencionar el pasillo recién descubierto
  const newDesc8 = room8.description.replace(
    'Podés usar examine celdas para más detalles.',
    'Un pasillo angosto al este lleva hacia el ruido distante de una subasta. Podés usar examine celdas para más detalles.'
  );
  db.upsertRoom(Object.assign({}, room8, { exits: newExits8, description: newDesc8 }));

  // Actualizar sala 17: agregar salida norte hacia sala 8
  const newExits17 = Object.assign({}, room17.exits, { north: 8 });
  db.upsertRoom(Object.assign({}, room17, { exits: newExits17 }));

  console.log('[seed] migratePrisonConnection: Prisión (8) ↔ Casa de Subastas (17) conectadas. DIS-538 ✓');
}

/**
 * DIS-598: El Guardia Espectral (sala 8, nivel recomendado 4) es demasiado fácil para Magos de nivel 3.
 * Subir HP de 25 a 40 para que requiera más de 2 hechizos para matarlo.
 * La resistencia mágica extra ya fue aplicada en engine.js (×0.4 para rayo/bola de fuego).
 */
function migrateGuardiaEspectralHP() {
  const guardian = db.getMonsterById ? db.getMonsterById(8) : null;
  // Intentar por ID o por nombre si getMonsterById no existe
  const all = db.getAllMonsters ? db.getAllMonsters() : [];
  const g = all.find(m => m.id === 8 || (m.name && m.name.toLowerCase().includes('guardia espectral')));
  if (!g) {
    console.warn('[seed] migrateGuardiaEspectralHP: Guardia Espectral no encontrado');
    return;
  }
  if (g.max_hp >= 40) {
    // Ya actualizado
    return;
  }
  db.updateMonster(g.id, { hp: 40, max_hp: 40 });
  console.log('[seed] migrateGuardiaEspectralHP: Guardia Espectral HP 25→40. DIS-598 ✓');
}

/**
 * DIS-630: El Gólem de Piedra (Santuario Profano, nivel 4+) muere demasiado rápido.
 * Subir HP de 35 a 55 para que aguante 4-5 turnos vs Guerrero nivel 5 con smash.
 * La resistencia física ×0.75 ya fue aplicada en combat.js.
 */
function migrateGolemPiedraHP() {
  const all = db.getAllMonsters ? db.getAllMonsters() : [];
  const g = all.find(m => m.id === 5 || (m.name && m.name.toLowerCase().includes('gólem de piedra')));
  if (!g) {
    console.warn('[seed] migrateGolemPiedraHP: Gólem de Piedra no encontrado');
    return;
  }
  if (g.max_hp >= 55) {
    // Ya actualizado
    return;
  }
  db.updateMonster(g.id, { hp: 55, max_hp: 55 });
  console.log('[seed] migrateGolemPiedraHP: Gólem de Piedra HP 35→55. DIS-630 ✓');
}

/**
 * DIS-679: El Guardia Espectral (sala 8, nivel 4+) cae demasiado rápido.
 * Subir HP de 40 a 55 para que aguante 4+ turnos vs Guerrero nivel 4 con smash.
 * El entumecimiento espectral ya fue implementado en combat.js.
 */
function migrateGuardiaEspectralHP2() {
  const all = db.getAllMonsters ? db.getAllMonsters() : [];
  const g = all.find(m => m.id === 8 || (m.name && m.name.toLowerCase().includes('guardia espectral')));
  if (!g) {
    console.warn('[seed] migrateGuardiaEspectralHP2: Guardia Espectral no encontrado');
    return;
  }
  if (g.max_hp >= 55) {
    return; // Ya actualizado
  }
  db.updateMonster(g.id, { hp: 55, max_hp: 55 });
  console.log('[seed] migrateGuardiaEspectralHP2: Guardia Espectral HP 40→55. DIS-679 ✓');
}

/**
 * DIS-652: La ruta Coliseo(14) →east→ Catedral(15) bypasea la Cámara del Eco(19).
 * El orden narrativo correcto es Coliseo → Eco → Catedral.
 * Cambiar: sala 14 east→19 (Cámara del Eco), sala 19 agrega east→15 (Catedral), sala 15 west→19 (de 14 a 19).
 */
function migrateColiseoEcoConnection() {
  const r14 = db.getRoom(14);
  const r15 = db.getRoom(15);
  const r19 = db.getRoom(19);
  if (!r14 || !r15 || !r19) {
    console.warn('[seed] migrateColiseoEcoConnection: no se encontraron las salas 14, 15 o 19.');
    return;
  }
  // Verificar si ya está migrado (sala 14 east ya apunta a 19)
  if (r14.exits && r14.exits.east === 19) {
    return; // ya migrado
  }
  // Sala 14: east → 19 (antes: 15)
  const exits14 = r14.exits || {};
  exits14.east = 19;
  db.upsertRoom({ ...r14, exits: exits14 });

  // Sala 19: agregar east → 15 (nueva conexión)
  const exits19 = r19.exits || {};
  exits19.east = 15;
  db.upsertRoom({ ...r19, exits: exits19 });

  // Sala 15: west → 19 (antes: 14)
  const exits15 = r15.exits || {};
  exits15.west = 19;
  db.upsertRoom({ ...r15, exits: exits15 });

  console.log('[seed] migrateColiseoEcoConnection: DIS-652 — Coliseo(14) east→19(Eco), Eco east→15(Catedral), Catedral west→19 ✓');
}

// BUG-659 / BUG-660: sala 19 tenía north:15 Y east:15 (duplicado), sala 15 tenía west:19 Y south:19 (duplicado)
// La migración DIS-652 añadió east/west sin quitar north/south — este fix los limpia
function migrateFixEcoConnectionDuplicates() {
  const r15 = db.getRoom(15);
  const r19 = db.getRoom(19);
  if (!r15 || !r19) return;
  let changed = false;
  // Sala 19: quitar north:15 si existe (dejar solo east:15)
  const exits19 = r19.exits || {};
  if (exits19.north === 15) {
    delete exits19.north;
    db.upsertRoom({ ...r19, exits: exits19 });
    changed = true;
  }
  // Sala 15: quitar south:19 si existe (dejar solo west:19)
  const exits15 = r15.exits || {};
  if (exits15.south === 19) {
    delete exits15.south;
    db.upsertRoom({ ...r15, exits: exits15 });
    changed = true;
  }
  if (changed) console.log('[seed] migrateFixEcoConnectionDuplicates: BUG-659/660 — salidas duplicadas Eco↔Catedral eliminadas ✓');
}

// BUG-682: Eco(19) no tenía west:14 (Coliseo) — la migración DIS-652 agregó east:14→19 pero olvidó la dirección contraria
function migrateEcoColiseoReturn() {
  const r19 = db.getRoom(19);
  if (!r19) return;
  if (r19.exits && r19.exits.west === 14) return; // ya migrado
  const exits19 = r19.exits || {};
  exits19.west = 14;
  db.upsertRoom({ ...r19, exits: exits19 });
  console.log('[seed] migrateEcoColiseoReturn: BUG-682 — Eco(19) west→14(Coliseo) ✓');
}

// DIS-689: Corregir error de ID en migrateArmorLoot — peto de huesos se agregó al
// Murciélago Vampiro (id 6) por error, debía ir al Guardia Espectral (id 8).
// Remover del Murciélago Vampiro y asegurar que esté en el Guardia Espectral.
function migratePetoHuesosFixID() {
  const bat = db.getMonster(6); // Murciélago Vampiro
  if (bat && bat.loot.includes('peto de huesos')) {
    db.upsertMonster({ ...bat, loot: bat.loot.filter(i => i !== 'peto de huesos') });
    console.log('[seed] migratePetoHuesosFixID: DIS-689 — peto de huesos removido del Murciélago Vampiro (id 6) ✓');
  }
  const guardia = db.getMonster(8); // Guardia Espectral
  if (guardia && !guardia.loot.includes('peto de huesos')) {
    db.upsertMonster({ ...guardia, loot: [...guardia.loot, 'peto de huesos'] });
    console.log('[seed] migratePetoHuesosFixID: DIS-689 — peto de huesos agregado al Guardia Espectral (id 8) ✓');
  }
}

// DIS-688: Golem de Forja — HP 42→55
function migrateGolemForjaHP() {
  const m = db.getMonster(10);
  if (!m) return;
  if (m.max_hp >= 55) return; // ya migrado
  db.updateMonster(10, { hp: Math.min(m.hp, 55), max_hp: 55 });
  console.log('[seed] migrateGolemForjaHP: DIS-688 — Golem de Forja HP 42→55 ✓');
}

/**
 * BUG-697: Murciélagos Vampiro extra (id 26, sala 3; id 27, sala 6) no estaban en
 * MONSTER_BASE_STATS, por lo que al morir como élite sus stats de élite se guardaban
 * permanentemente — el siguiente respawn aplicaba HP×1.5 sobre el HP ya elevado,
 * acumulando HP en cada ciclo (reportado: id 26 con 41 HP cuando debería tener 12).
 * Fix: agregar 26 y 27 a MONSTER_BASE_STATS (en combat.js) + resetear BD a stats base.
 */
/**
 * DIS-701: Reducir HP del Lich Anciano de 100 → 90 para aliviar la curva
 * del Mago en late-game. Con BUG-698 fix (stun cancela contraataque),
 * el Mago tiene más respiración. 90 HP mantiene el desafío sin requerir
 * obligatoriamente la poción de maná para ganar.
 * Idempotente: solo actualiza si max_hp === 100.
 */
function migrateLichHPRebalance() {
  const lich = db.getMonster(13);
  if (lich && lich.max_hp === 100) {
    const newHp = Math.min(lich.hp, 90); // no curar si ya tenía menos
    db.updateMonster(13, { max_hp: 90, hp: newHp });
    console.log(`[seed] migrateLichHPRebalance: DIS-701 — Lich Anciano HP 100 → 90. HP actual: ${newHp}/90.`);
  }
}

function migrateBatStatsReset() {
  const BASE = { max_hp: 12, attack: 3, name: 'Murciélago Vampiro' };
  for (const id of [26, 27]) {
    const m = db.getMonster(id);
    if (!m) continue;
    // Si los stats están inflados (max_hp > base o attack > base), resetear
    if (m.max_hp > BASE.max_hp || m.attack > BASE.attack || m.name.startsWith('⭐ ')) {
      const newHp = Math.min(m.hp, BASE.max_hp); // no curar más allá del base
      db.updateMonster(id, { name: BASE.name, max_hp: BASE.max_hp, hp: newHp > 0 ? newHp : BASE.max_hp, attack: BASE.attack });
      console.log(`[seed] migrateBatStatsReset: BUG-697 — Murciélago Vampiro id ${id} reseteado (era max_hp=${m.max_hp} atk=${m.attack}) ✓`);
    }
  }
}

// DIS-729: Sombra del Vacío HP 90→120 — el boss secreto debe ser más desafiante que el Lich
function migrateSombraVacioHP() {
  const sombra = db.getMonster(22);
  if (sombra && sombra.max_hp < 120) {
    const newHp = Math.min(sombra.hp, 120);
    db.updateMonster(22, { max_hp: 120, hp: newHp });
    console.log(`[seed] migrateSombraVacioHP: DIS-729 — Sombra del Vacío HP ${sombra.max_hp}→120 ✓`);
  }
}

// DIS-813: Remover 'cristal resonante' del loot de la Sombra del Vacío (id 22)
// El cristal resonante es un drop del Campeón Espectral (id 12) — tener dos hace el crafteo de
// lanza espectral del eco redundante. La Sombra dropea suficiente loot épico sin necesitar duplicar.
function migrateSombraLootDIS813() {
  const sombra = db.getMonster(22);
  if (sombra && sombra.loot && sombra.loot.includes('cristal resonante')) {
    const newLoot = sombra.loot.filter(l => l !== 'cristal resonante');
    db.updateMonster(22, { loot: newLoot });
    console.log('[seed] migrateSombraLootDIS813: DIS-813 — cristal resonante removido del loot de la Sombra del Vacío ✓');
  }
}

// DIS-807: Sombra del Vacío HP 120→140 — el boss secreto debe superar claramente al Lich (110 HP)
// La Oscuridad Paralizante ahora es garantizada en el primer turno, 35% en los siguientes
function migrateSombraVacioHPDIS807() {
  const sombra = db.getMonster(22);
  if (sombra && sombra.max_hp < 140) {
    // Migración idempotente: si max_hp < 140, subimos a 140
    db.updateMonster(22, { max_hp: 140, hp: 140 });
    console.log(`[seed] migrateSombraVacioHPDIS807: DIS-807 — Sombra del Vacío HP ${sombra.max_hp}→140 ✓`);
  }
}

// DIS-730: Remover ítems pre-placed del suelo del Abismo Eterno (sala 20)
// El loot 'fragmento de vacío' y 'cristal resonante' solo deben aparecer como drop de la Sombra del Vacío
// No como ítems del suelo que spoilean la sala antes del combate
function migrateAbismoLootFix() {
  const room20 = db.getRoom(20);
  if (!room20) return;
  const floorItems = Array.isArray(room20.items) ? room20.items : [];
  const spoilerItems = new Set(['fragmento de vacío', 'cristal resonante', 'esencia del abismo', 'veste de sombra', 'pergamino de escudo']);
  const cleaned = floorItems.filter(i => !spoilerItems.has(i.toLowerCase()));
  if (cleaned.length < floorItems.length) {
    db.updateRoomItems(20, cleaned);
    console.log(`[seed] migrateAbismoLootFix: DIS-730 — Removidos ${floorItems.length - cleaned.length} ítems pre-placed del Abismo Eterno. Solo quedan en el suelo: [${cleaned.join(', ')}] ✓`);
  }
}

/**
 * BUG-731: Restaurar HP completo de todos los bosses vivos al arrancar el servidor.
 * El BUG-030 en db.init() restaura HP ANTES de las migraciones. Si una migración
 * cambia max_hp pero preserva hp < max_hp (ej: Math.min), el boss queda con HP reducido.
 * Esta migración corre DESPUÉS de todas las demás y garantiza que los bosses vivos
 * inicien con HP completo.
 */
/**
 * DIS-748: Restaurar hongo azul en sala 6 (Túnel de los Hongos) si no está en el suelo.
 * El ítem es necesario para desactivar la trampa de esporas. Si un jugador lo recogió
 * y nunca lo dejó volver, la trampa queda sin solución. Esta migración garantiza
 * que al arrancar el servidor siempre haya al menos uno disponible.
 * Complementa el sistema de buscar (ROOM_FORAGE_BONUS[6]) que ya da 45% de chance al buscar.
 */
function migrateHongoAzulSala6() {
  try {
    const room6 = db.getRoom(6);
    if (!room6) return;
    const items = Array.isArray(room6.items) ? room6.items : [];
    const hasHongo = items.some(i => i.toLowerCase().includes('hongo azul'));
    if (!hasHongo) {
      db.updateRoomItems(6, [...items, 'hongo azul']);
      console.log('[seed] migrateHongoAzulSala6: DIS-748 — Hongo azul restaurado en Túnel de los Hongos (sala 6). El ítem de desactivación de trampa ya está disponible ✓');
    }
  } catch (e) {
    console.warn('[seed] migrateHongoAzulSala6:', e.message);
  }
}

function migrateBossHPFullReset() {
  try {
    // DIS-779: db.run() no existe en las exports de db.js (sql.js API).
    // Usar db.raw().run() para acceder a la instancia interna de sql.js.
    db.raw().run(`UPDATE monsters SET hp = max_hp WHERE room_id IS NOT NULL AND hp < max_hp AND hp > 0`);
    console.log('[seed] migrateBossHPFullReset: BUG-731 — HP de bosses/monstruos vivos restaurados al máximo post-migración ✓');
  } catch (e) {
    console.warn('[seed] migrateBossHPFullReset: error —', e.message);
  }
}

function migrateLichHPDIS794() {
  // DIS-794: Lich Anciano demasiado fácil para Guerrero nivel 8 — muerto en 3 turnos con smash.
  // Subir HP de 90 → 110 para garantizar que la Fase 2 (al 50% HP) se active y el combate dure 4-5 turnos.
  // DIS-797 fix: siempre setear hp=110 (no Math.min(lich.hp, 110)) porque migrateBossHPFullReset
  // corre antes y deja lich.hp=90 — si no se setea a 110 aquí el Lich queda con 90/110 HP al inicio.
  const lich = db.getMonster(13);
  if (lich && lich.max_hp < 110) {
    db.updateMonster(13, { max_hp: 110, hp: 110 });
    console.log(`[seed] migrateLichHPDIS794: DIS-794/DIS-797 — Lich Anciano HP → 110/110 (max_hp anterior: ${lich.max_hp}).`);
  }
}

/**
 * DIS-793: El inventario llega al límite exacto (25/25) con loot completo del Lich.
 * Solución: colocar una "bolsa de lona" pre-placed en la Catedral (sala 15), accesible antes
 * de la batalla final. El jugador puede recogerla y usarla para ganar +4 slots, permitiendo
 * recoger todo el loot del Lich sin sacrificar ítems acumulados durante el recorrido.
 * Tiene sentido narrativo: un aventurero anterior dejó equipo en la sala más profunda del dungeon.
 */
function migrateCatedralBagDIS793() {
  const room15 = db.getRoom(15);
  if (!room15) return;
  const items = Array.isArray(room15.items) ? room15.items : [];
  if (!items.includes('bolsa de lona')) {
    db.upsertRoom({ ...room15, items: [...items, 'bolsa de lona'] });
    console.log('[seed] migrateCatedralBagDIS793: DIS-793 — bolsa de lona agregada a la Catedral (sala 15). El jugador puede recogerla antes de enfrentar al Lich para ampliar su mochila. ✓');
  }
}

/**
 * DIS-801: La Cámara de la Fuente Eterna (sala 18) es un dead-end — solo tiene salida sur (Santuario)
 * y abajo (Abismo Eterno, boss nivel 7+). Un jugador que la visita en medio del recorrido debe
 * salir por donde entró. Fix: agregar salida este→Trono (sala 9) y oeste en Trono→Fuente.
 * Esto crea un bucle suave: Santuario↔Fuente↔Trono que integra mejor la zona en el flujo.
 */
function migrateFuenteEternaDIS801() {
  const room18 = db.getRoom(18);
  const room9 = db.getRoom(9);
  if (!room18 || !room9) return;
  let changed = false;
  if (!room18.exits || room18.exits['east'] === undefined) {
    db.upsertRoom({ ...room18, exits: { ...room18.exits, east: 9 } });
    console.log('[seed] migrateFuenteEternaDIS801: DIS-801 — Fuente Eterna (18) → east → Sala del Trono (9). ✓');
    changed = true;
  }
  // Recargar sala 9 por si cambió (evitar sobreescribir la sala 18 que ya actualizamos)
  const room9Fresh = db.getRoom(9);
  if (!room9Fresh.exits || room9Fresh.exits['west'] === undefined) {
    db.upsertRoom({ ...room9Fresh, exits: { ...room9Fresh.exits, west: 18 } });
    console.log('[seed] migrateFuenteEternaDIS801: DIS-801 — Sala del Trono (9) → west → Fuente Eterna (18). ✓');
    changed = true;
  }
  if (!changed) {
    // console.log('[seed] migrateFuenteEternaDIS801: DIS-801 — ya migrado, sin cambios.');
  }
}

/**
 * DIS-820: El Pozo Sin Fondo (sala 7) tiene ítems pre-placed que duplican el loot de la Araña Tejedora
 * (hilo de seda, veneno concentrado, capa de araña, monedas de plata). Después de matar a la araña,
 * el jugador con `pick todo` recibe doble de cada material. Fix: limpiar esos ítems del suelo de sala 7,
 * conservando solo los ítems legítimos (cuerda, gancho de hierro, antídoto).
 */
function migratePozo820() {
  try {
    const room7 = db.getRoom(7);
    if (!room7) return;
    const items = Array.isArray(room7.items) ? room7.items : [];
    const DROP_DUPLICATES = ['hilo de seda', 'veneno concentrado', 'capa de araña', 'monedas de plata', 'monedas de oro', 'monedas de cobre'];
    const cleaned = items.filter(i => !DROP_DUPLICATES.some(d => i.toLowerCase() === d.toLowerCase()));
    if (cleaned.length < items.length) {
      db.updateRoomItems(7, cleaned);
      const removed = items.filter(i => DROP_DUPLICATES.some(d => i.toLowerCase() === d.toLowerCase()));
      console.log(`[seed] migratePozo820: DIS-820 — Ítems que duplican loot de la Araña removidos de sala 7: [${removed.join(', ')}]. Ítems conservados: [${cleaned.join(', ')}]. ✓`);
    }
  } catch (e) {
    console.warn('[seed] migratePozo820:', e.message);
  }
}

/**
 * DIS-872: El Espectro del Corredor (sala 9) no dropeaba corona rota, pero el hint de la trampa
 * decía "buscá en esta sala". Ahora también droppea corona rota con 50% de probabilidad,
 * dando al jugador una alternativa clara al forage cuando el Espectro muere.
 */
function migrateEspectroCoronaLoot() {
  try {
    const espectro = db.getMonster(4); // Espectro del Corredor
    if (!espectro) return;
    const loot = Array.isArray(espectro.loot) ? espectro.loot : JSON.parse(espectro.loot || '[]');
    if (loot.includes('corona rota')) {
      console.log('[seed] migrateEspectroCoronaLoot: DIS-872 — corona rota ya en loot del Espectro. ✓');
      return;
    }
    const newLoot = [...loot, 'corona rota'];
    db.updateMonster(4, { loot: JSON.stringify(newLoot) });
    console.log('[seed] migrateEspectroCoronaLoot: DIS-872 — corona rota agregada al loot del Espectro del Corredor (id 4). Loot: ' + newLoot.join(', ') + '. ✓');
  } catch (e) {
    console.warn('[seed] migrateEspectroCoronaLoot:', e.message);
  }
}

/**
 * DIS-985: Trampa inevitable en Sala del Trono (sala 9).
 * La corona rota (ítem de desactivación) solo se obtenía DENTRO de la sala trampeada:
 * dropeada por el Espectro del Corredor (sala 9) o por forage en sala 9.
 * Esto obliga al jugador a recibir daño en la primera visita sin posibilidad de evitarlo.
 *
 * Solución: agregar 'corona rota' como ítem pre-placed en la Prisión Subterránea (sala 8).
 * Justificación lore: un aventurero anterior fue encerrado allí camino al Trono;
 * dejó la corona en su celda, una reliquia del palacio del norte que nunca llegó a usar.
 * Así el jugador que explore la Prisión puede desactivar la trampa del Trono desde el umbral.
 */
function migrateCoronaRotaPrison985() {
  try {
    const room8 = db.getRoom(8);
    if (!room8) return;
    const items = Array.isArray(room8.items) ? room8.items : (room8.items ? JSON.parse(room8.items) : []);
    if (items.some(i => typeof i === 'string' && i.toLowerCase().includes('corona rota'))) {
      console.log('[seed] migrateCoronaRotaPrison985: corona rota ya en sala 8. DIS-985 ✓');
      return;
    }
    const newItems = [...items, 'corona rota'];
    db.upsertRoom({ ...room8, items: newItems });
    console.log('[seed] migrateCoronaRotaPrison985: corona rota agregada a Prisión Subterránea (sala 8). DIS-985 ✓');
  } catch (e) {
    console.warn('[seed] migrateCoronaRotaPrison985:', e.message);
  }
}

/**
 * BUG-946: Fix de subastas pasivas stuck por regex de fecha incorrecta (DIS-535).
 * Antes del fix, createPassiveAuction() usaba /\\\\.\\\\d{3}Z$/ en lugar de /\\.\\d{3}Z$/,
 * dejando el sufijo ".000Z" en el campo ends_at. Eso hacía que nunca expiraran
 * (string ".000Z" > cualquier fecha normal → siempre parecía "en el futuro" en SQLite).
 * Esta migración cierra las subastas pasivas stuck y paga al vendedor el precio del Mercader (50%).
 */
function migrateFixStuckPassiveAuctions() {
  try {
    const rawDb = db.raw(); // instancia sql.js
    // Buscar subastas pasivas abiertas con fecha que contenga ".000Z" (síntoma del bug)
    const results = rawDb.exec(
      `SELECT id, seller_id, seller_name, item_name, min_price FROM auctions WHERE closed = 0 AND is_passive = 1 AND ends_at LIKE '%.000Z'`
    );
    if (!results.length || !results[0].values.length) {
      console.log('[seed] migrateFixStuckPassiveAuctions: sin subastas stuck. BUG-946 ✓');
      return;
    }
    const cols = results[0].columns;
    const stuck = results[0].values.map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
    for (const auction of stuck) {
      // Cerrar la subasta
      rawDb.run(`UPDATE auctions SET closed = 1 WHERE id = ?`, [auction.id]);
      // Dar oro al vendedor (precio del Mercader: 50% del precio mínimo)
      const merchantPrice = Math.max(1, Math.floor((auction.min_price || 1) * 0.5));
      rawDb.run(`UPDATE players SET gold = gold + ? WHERE id = ?`, [merchantPrice, auction.seller_id]);
      // Agregar entrada al journal del vendedor
      try {
        const sellerRow = (() => {
          const s = rawDb.prepare(`SELECT journal FROM players WHERE id = ?`);
          s.bind([auction.seller_id]);
          const r = s.step() ? s.getAsObject() : null;
          s.free();
          return r;
        })();
        if (sellerRow) {
          const journal = sellerRow.journal ? JSON.parse(sellerRow.journal) : [];
          journal.push({
            type: 'system',
            timestamp: new Date().toISOString(),
            message: `🔧 [BUG-946 fix] La subasta pasiva de "${auction.item_name}" estaba atascada. El Mercader te pagó ${merchantPrice}g (50% de ${auction.min_price}g).`,
          });
          rawDb.run(`UPDATE players SET journal = ? WHERE id = ?`, [JSON.stringify(journal), auction.seller_id]);
        }
      } catch (_) { /* journal no crítico */ }
      console.log(`[seed] migrateFixStuckPassiveAuctions: cerrada subasta #${auction.id} ("${auction.item_name}" de ${auction.seller_name}) → ${merchantPrice}g al vendedor. BUG-946 ✓`);
    }
    console.log(`[seed] migrateFixStuckPassiveAuctions: ${stuck.length} subastas pasivas stuck corregidas. BUG-946 ✓`);
  } catch (e) {
    console.warn('[seed] migrateFixStuckPassiveAuctions:', e.message);
  }
}

/**
 * BUG-992: Limpiar status_effects corruptos (contienen el objeto jugador completo).
 * Causa: parseSE(freshForEpic) en engine.js recibía el jugador completo en vez de freshForEpic.status_effects.
 * Este bug ocurría al mover a una sala dejando ítems épicos/raros atrás.
 * Solución: detectar status_effects que tengan clave 'id' (propia de jugadores) y limpiarlos,
 * preservando los campos legítimos de status_effects que puedan estar anidados dentro.
 */
function migrateFixCorruptStatusEffects992() {
  try {
    const rawDb = db.raw();
    const stmt = rawDb.prepare('SELECT id, username, status_effects FROM players');
    const rows = [];
    while (stmt.step()) { rows.push(stmt.getAsObject()); }
    stmt.free();
    let fixed = 0;
    for (const row of rows) {
      if (!row.status_effects) continue;
      let se;
      try { se = JSON.parse(row.status_effects); } catch (_) { continue; }
      if (typeof se !== 'object' || se === null) continue;
      // Si tiene 'id' y 'username', es el jugador completo guardado por error
      if (se.id && se.username && se.status_effects !== undefined) {
        // Rescatar los status_effects anidados si existen
        const innerSe = se.status_effects;
        const cleanSe = (innerSe && typeof innerSe === 'object') ? innerSe : {};
        rawDb.run('UPDATE players SET status_effects = ? WHERE id = ?', [JSON.stringify(cleanSe), row.id]);
        console.log(`[seed] BUG-992: status_effects corruptos limpiados para jugador ${row.username} (${row.id})`);
        fixed++;
      }
    }
    if (fixed > 0) {
      console.log(`[seed] migrateFixCorruptStatusEffects992: ${fixed} jugadores corregidos. BUG-992 ✓`);
    }
  } catch (e) {
    console.warn('[seed] migrateFixCorruptStatusEffects992:', e.message);
  }
}

/**
 * DIS-1007: Limpiar ítems épicos del Guardia Espectral del suelo de la Prisión (sala 8).
 * La alabarda de huesos y peto de huesos ahora se entregan directamente al inventario
 * del jugador al matar al boss (via BOSS_DIRECT_LOOT en combat.js). Si quedaron en el suelo
 * de una sesión anterior, esta migración los elimina.
 */
function migrateCleanPrisonEpicLoot1007() {
  try {
    const room8 = db.getRoom(8);
    if (!room8) return;
    const items = Array.isArray(room8.items) ? room8.items : (room8.items ? JSON.parse(room8.items) : []);
    const EPIC_ITEMS = new Set(['alabarda de huesos', 'peto de huesos']);
    const cleanItems = items.filter(i => !EPIC_ITEMS.has(i));
    if (cleanItems.length !== items.length) {
      db.upsertRoom({ ...room8, items: cleanItems });
      const removed = items.filter(i => EPIC_ITEMS.has(i));
      console.log(`[seed] migrateCleanPrisonEpicLoot1007: removidos del suelo de sala 8: ${removed.join(', ')}. DIS-1007 ✓`);
    } else {
      console.log('[seed] migrateCleanPrisonEpicLoot1007: sala 8 limpia. DIS-1007 ✓');
    }
  } catch (e) {
    console.warn('[seed] migrateCleanPrisonEpicLoot1007:', e.message);
  }
}

/**
 * DIS-1005: Mejorar pistas de navegación hacia Aldric el Mercader.
 * - Sala 3 (Sala de los Ecos): agregar mención de que al este está la Cámara del Tesoro con el mercader.
 * - Sala 4 (Cámara del Tesoro): actualizar descripción para que quede claro que Aldric está ahí.
 */
function migrateMerchantHintDIS1005() {
  try {
    // Sala 3: Sala de los Ecos — agregar hint de Aldric al este
    const room3 = db.getRoom(3);
    if (room3) {
      const OLD_DESC3 = 'Una cámara circular donde cada sonido rebota mil veces. El suelo está cubierto de huesos viejos y polvo.';
      const NEW_DESC3 = 'Una cámara circular donde cada sonido rebota mil veces. El suelo está cubierto de huesos viejos y polvo. Al este, una luz tenue escapa por el umbral: la Cámara del Tesoro, donde Aldric el Mercader tiene su puesto de comercio.';
      if (room3.description === OLD_DESC3 || room3.description === NEW_DESC3.replace(' Al este, una luz tenue escapa por el umbral: la Cámara del Tesoro, donde Aldric el Mercader tiene su puesto de comercio.', '')) {
        db.upsertRoom({ ...room3, description: NEW_DESC3 });
        console.log('[seed] migrateMerchantHintDIS1005: sala 3 descripción actualizada con hint de Aldric. DIS-1005 ✓');
      } else {
        console.log('[seed] migrateMerchantHintDIS1005: sala 3 tiene descripción custom — sin cambios.');
      }
    }

    // Sala 4: Cámara del Tesoro — hacer más obvio que hay un mercader
    const room4 = db.getRoom(4);
    if (room4) {
      const OLD_DESC4 = 'Estantes de madera podrida sostienen cofres semiabiertos. Algo valioso estuvo aquí alguna vez. Un olor metálico impregna el ambiente.';
      const NEW_DESC4 = 'Estantes de madera podrida sostienen cofres semiabiertos. Un mostrador desgastado ocupa el centro de la sala — Aldric el Mercader acomoda sus mercancías con cuidado meticuloso. Un olor metálico impregna el ambiente.';
      if (room4.description === OLD_DESC4) {
        db.upsertRoom({ ...room4, description: NEW_DESC4 });
        console.log('[seed] migrateMerchantHintDIS1005: sala 4 descripción actualizada con Aldric visible. DIS-1005 ✓');
      } else {
        console.log('[seed] migrateMerchantHintDIS1005: sala 4 tiene descripción custom — sin cambios.');
      }
    }
  } catch (e) {
    console.warn('[seed] migrateMerchantHintDIS1005:', e.message);
  }
}

/**
 * DIS-1035: Agregar hierba curativa en la Galería de Hielo (sala 11).
 * La ruta natural desde el Santuario Profano hasta el Taller de la Forja no ofrece
 * curación intermedia. El jugador llega al Golem de Forja (nivel 5+) con HP bajo
 * si no pasa por la Fuente Eterna primero. Solución: colocar una hierba curativa
 * persistente en la Galería de Hielo — narrativamente plausible (plantas resistentes al frío).
 */
function migrateGaleriaHieloCuracionDIS1035() {
  try {
    const room11 = db.getRoom(11);
    if (!room11) return;
    const items11 = Array.isArray(room11.items) ? room11.items : [];
    if (!items11.includes('hierba curativa')) {
      db.upsertRoom({ ...room11, items: [...items11, 'hierba curativa'] });
      console.log('[seed] migrateGaleriaHieloCuracionDIS1035: hierba curativa agregada a Galería de Hielo (sala 11). DIS-1035 ✓');
    }
  } catch (e) {
    console.warn('[seed] migrateGaleriaHieloCuracionDIS1035:', e.message);
  }
}

/**
 * DIS-1038: Actualizar la pista de ruta alternativa al Santuario (sala 7, Pozo Sin Fondo).
 * La descripción original decía que la ruta "Capilla → Hongos → Trono → Santuario"
 * era una alternativa sin mencionar que incluye trampas. Actualizar para advertir
 * sobre las trampas de esporas (Hongos) y frío (Trono) en esa ruta.
 */
function migratePistaSantuarioTrapasDIS1038() {
  try {
    const room7 = db.getRoom(7);
    if (!room7) return;
    // Buscar la pista antigua (con o sin la advertencia de trampas)
    const pistaAntigua = '(💡 Si no tenés la llave, hay otra ruta al Santuario: volvé a la Entrada, tomá el este hacia la Capilla, sigue norte por los Hongos y el Trono.)';
    const pistaNueva = '(💡 Si no tenés la llave, hay otra ruta al Santuario: Entrada → Capilla (este) → Túnel de Hongos (norte) → Sala del Trono (este) → Santuario. ⚠️ Ojo: esa ruta tiene una trampa de esporas en los Hongos y una trampa de frío en el Trono — ambas activas en la primera visita.)';
    if (room7.description.includes(pistaAntigua)) {
      const newDesc = room7.description.replace(pistaAntigua, pistaNueva);
      db.upsertRoom({ ...room7, description: newDesc });
      console.log('[seed] migratePistaSantuarioTrapasDIS1038: pista de ruta alternativa actualizada con advertencia de trampas. DIS-1038 ✓');
    } else if (!room7.description.includes(pistaNueva)) {
      console.log('[seed] migratePistaSantuarioTrapasDIS1038: descripción de sala 7 no contiene la pista esperada — sin cambios.');
    }
  } catch (e) {
    console.warn('[seed] migratePistaSantuarioTrapasDIS1038:', e.message);
  }
}

/**
 * DIS-1043: Rebalanceo económico de early game.
 * - Rata Gigante (id=3): monedas de cobre (1g) → monedas de plata (5g)
 * - Murciélago Vampiro (id=6): monedas de cobre (1g) → monedas de plata (5g)
 * - Guardia Espectral (id=8): agregar monedas de oro (10g) al loot
 * El costo de hermandad se redujo de 30 a 20g en engine.js.
 */
function migrateEconomyRebalanceDIS1043() {
  try {
    // Rata Gigante: monedas de cobre → monedas de plata
    const rat = db.getMonster(3);
    if (rat && rat.loot.includes('monedas de cobre') && !rat.loot.includes('monedas de plata')) {
      const newLoot = rat.loot.map(i => i === 'monedas de cobre' ? 'monedas de plata' : i);
      db.upsertMonster({ ...rat, loot: newLoot });
      console.log('[seed] migrateEconomyRebalanceDIS1043: Rata Gigante → monedas de plata (5g). ✓');
    }

    // Murciélago Vampiro (sala 5, id=6): monedas de cobre → monedas de plata
    const bat = db.getMonster(6);
    if (bat && bat.loot.includes('monedas de cobre') && !bat.loot.includes('monedas de plata')) {
      const newLoot = bat.loot.map(i => i === 'monedas de cobre' ? 'monedas de plata' : i);
      db.upsertMonster({ ...bat, loot: newLoot });
      console.log('[seed] migrateEconomyRebalanceDIS1043: Murciélago Vampiro → monedas de plata (5g). ✓');
    }

    // Guardia Espectral (id=8): agregar monedas de oro si no las tiene
    const guardia = db.getMonster(8);
    if (guardia && !guardia.loot.includes('monedas de oro')) {
      db.upsertMonster({ ...guardia, loot: [...guardia.loot, 'monedas de oro'] });
      console.log('[seed] migrateEconomyRebalanceDIS1043: Guardia Espectral → +monedas de oro (10g). ✓');
    }
  } catch (e) {
    console.warn('[seed] migrateEconomyRebalanceDIS1043:', e.message);
  }
}

/**
 * DIS-1041: Agregar hint sobre la Sala de Práctica en la descripción de la sala 1 (Entrada).
 * Un jugador nuevo nunca encuentra la Sala de Práctica porque está oculta debajo de la Entrada.
 * Se agrega un tip visible al hacer 'look' en la sala de entrada.
 */
function migratePracticaHintDIS1041() {
  try {
    const room1 = db.getRoom(1);
    if (!room1) return;
    const hint = '💡 ¿Sos nuevo? Escribí "abajo" para acceder a la Sala de Práctica y entrenarte sin riesgo antes de adentrarte.';
    if (!room1.description.includes(hint)) {
      const newDesc = room1.description + '\n\n' + hint;
      db.upsertRoom({ ...room1, description: newDesc });
      console.log('[seed] migratePracticaHintDIS1041: Hint de Sala de Práctica agregado a sala 1 (Entrada). DIS-1041 ✓');
    }
  } catch (e) {
    console.warn('[seed] migratePracticaHintDIS1041:', e.message);
  }
}

/**
 * BUG-1047: Limpiar duplicados de pista de ruta alternativa en sala 7 (Pozo Sin Fondo).
 * El bug en migratePistaSantuario() causó que la pista se appendeara 5+ veces.
 * Esta migración deja exactamente una copia de la pista correcta (DIS-1038).
 *
 * NOTA BUG-1048: El fix original de BUG-1047 usaba regex [^)]+ que falla cuando la pista
 * contiene paréntesis internos como "(norte)" o "(este)". Por eso la corrupción persistía.
 * Esta versión reescritura usa la descripción base hardcodeada para garantizar idempotencia.
 */
function migrateCleanPistaSantuarioBUG1047() {
  try {
    const room7 = db.getRoom(7);
    if (!room7) return;
    // Descripción base canónica (sin ninguna pista de ruta al Santuario)
    const descBase = 'Un pozo en el centro de la sala emite un viento frío desde las profundidades. Una cuerda cuelga al borde. ¿Qué habrá abajo? Al norte, una puerta de hierro macizo con una cerradura oxidada bloquea el paso al Santuario.';
    // Pista correcta final (DIS-1038)
    const pistaNueva = ' (💡 Si no tenés la llave, hay otra ruta al Santuario: Entrada → Capilla (este) → Túnel de Hongos (norte) → Sala del Trono (este) → Santuario. ⚠️ Ojo: esa ruta tiene una trampa de esporas en los Hongos y una trampa de frío en el Trono — ambas activas en la primera visita.)';
    const descCorrecta = descBase + pistaNueva;
    // Si la descripción ya es exactamente la correcta, nada que hacer
    if (room7.description === descCorrecta) return;
    // Detectar si la descripción está corrupta (contiene duplicados)
    const pistaAntiguaMarker = '→ Túnel de Hongos (norte) → Sala del Trono (este) → Santuario';
    const hasCorruption = (room7.description.match(new RegExp(pistaAntiguaMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length > 1;
    if (hasCorruption || room7.description !== descCorrecta) {
      db.upsertRoom({ ...room7, description: descCorrecta });
      db.persist();
      console.log('[seed] migrateCleanPistaSantuarioBUG1047: descripción de sala 7 restaurada a versión canónica (BUG-1047+BUG-1048). ✓');
    }
  } catch (e) {
    console.warn('[seed] migrateCleanPistaSantuarioBUG1047:', e.message);
  }
}

/**
 * DIS-1190: La corona rota siempre aparece en el suelo de la Sala del Trono (sala 9),
 * haciendo trivial la trampa de frío — el jugador puede recoger la corona y desactivar
 * la trampa en la misma visita. La corona ya está disponible en sala 8 (Prisión) y como
 * drop del Espectro del Corredor. Eliminar el ítem estático del suelo de sala 9.
 */
function migrateRemoveCoronaSala9DIS1190() {
  try {
    const room9 = db.getRoom(9);
    if (!room9) return;
    const items = Array.isArray(room9.items) ? room9.items : (room9.items ? JSON.parse(room9.items) : []);
    if (!items.some(i => typeof i === 'string' && i.toLowerCase() === 'corona rota')) {
      console.log('[seed] migrateRemoveCoronaSala9DIS1190: corona rota no en suelo de sala 9. ✓');
      return;
    }
    const newItems = items.filter(i => !(typeof i === 'string' && i.toLowerCase() === 'corona rota'));
    db.upsertRoom({ ...room9, items: newItems });
    db.persist();
    console.log('[seed] migrateRemoveCoronaSala9DIS1190: corona rota eliminada del suelo de Sala del Trono (sala 9). DIS-1190 ✓');
  } catch (e) {
    console.warn('[seed] migrateRemoveCoronaSala9DIS1190:', e.message);
  }
}

/**
 * DIS-1202: Agregar un segundo Goblin Merodeador en el Corredor de las Sombras (sala 2).
 * El primero (id 1) tiene respawn de 3 min — el segundo (id 28) usa el mismo timer.
 * Así el jugador no queda bloqueado esperando para completar la quest "Exterminador de Goblins" (2/2).
 */
function migrateSecondGoblinDIS1202() {
  try {
    const existing = db.getMonster(28);
    if (existing) {
      console.log('[seed] migrateSecondGoblinDIS1202: Goblin Explorador (id 28) ya existe. ✓');
      return;
    }
    db.upsertMonster({
      id: 28,
      name: 'Goblin Explorador',
      description: 'Un goblin algo más ágil que sus congéneres. Lleva un cuchillo en cada mano y mira nerviosamente a todos lados.',
      hp: 15, max_hp: 15, attack: 3,
      room_id: 2,
      loot: ['monedas de cobre', 'monedas de plata'],
      respawn_room_id: 2,
    });
    db.persist();
    console.log('[seed] migrateSecondGoblinDIS1202: Goblin Explorador (id 28) creado en Corredor de las Sombras (sala 2). DIS-1202 ✓');
  } catch (e) {
    console.warn('[seed] migrateSecondGoblinDIS1202:', e.message);
  }
}

/**
 * DIS-1213: La descripción de sala 1 (Entrada de la Cripta) dice "La oscuridad se extiende al norte y al este"
 * pero esa frase es genérica y no describe bien los destinos. Al norte está el Corredor de las Sombras
 * y al este la Capilla Olvidada — ambas son salidas directas y reales. Se reemplaza la frase vaga
 * por una descripción más evocadora que orienta al jugador sin confundirlo.
 */
function migrateEntradaCriptaDIS1213() {
  try {
    const room1 = db.getRoom(1);
    if (!room1) return;
    const OLD_PHRASE = 'La oscuridad se extiende al norte y al este.';
    const NEW_PHRASE = 'Dos túneles se abren ante vos: uno al norte lleva al Corredor de las Sombras, oscuro y estrecho; otro al este conduce a una capilla olvidada donde la piedra negra y el silencio pesan igual.';
    if (!room1.description.includes(OLD_PHRASE)) {
      console.log('[seed] migrateEntradaCriptaDIS1213: descripción ya actualizada. ✓');
      return;
    }
    const newDesc = room1.description.replace(OLD_PHRASE, NEW_PHRASE);
    db.upsertRoom({ ...room1, description: newDesc });
    db.persist();
    console.log('[seed] migrateEntradaCriptaDIS1213: Descripción de sala 1 actualizada. DIS-1213 ✓');
  } catch (e) {
    console.warn('[seed] migrateEntradaCriptaDIS1213:', e.message);
  }
}

/**
 * DIS-1203: El Espectro del Corredor (id 4) tiene 18 HP — demasiado bajo para el meta de daño actual.
 * Un Pícaro nivel 2-3 con lanza espectral del eco (+12 ATK) puede matarlo en 1 hit (~18 dmg).
 * Subir HP a 45 para que requiera al menos 2-3 hits incluso con equipo épico temprano.
 */
function migrateGoblinATKDIS1316() {
  try {
    const goblin = db.getMonster(1);
    if (!goblin) return;
    if ((goblin.attack || 0) >= 4) {
      console.log('[seed] migrateGoblinATKDIS1316: Goblin Merodeador ATK ya es ≥ 4. ✓');
      return;
    }
    db.updateMonster(1, { attack: 4 });
    db.persist();
    console.log(`[seed] migrateGoblinATKDIS1316: Goblin Merodeador ATK ${goblin.attack}→4. DIS-1316 ✓`);
  } catch (e) {
    console.warn('[seed] migrateGoblinATKDIS1316:', e.message);
  }
}

function migrateEspectroHPDIS1203() {
  try {
    const espectro = db.getMonster(4);
    if (!espectro) return;
    if ((espectro.max_hp || 0) >= 45) {
      console.log('[seed] migrateEspectroHPDIS1203: Espectro del Corredor ya tiene HP ≥ 45. ✓');
      return;
    }
    db.updateMonster(4, { max_hp: 45, hp: 45 });
    db.persist();
    console.log(`[seed] migrateEspectroHPDIS1203: Espectro del Corredor HP ${espectro.max_hp}→45. DIS-1203 ✓`);
  } catch (e) {
    console.warn('[seed] migrateEspectroHPDIS1203:', e.message);
  }
}

/**
 * DIS-1324: Early game del Guerrero carece de tensión (nivel 1-3).
 * Monstruos iniciales hacen 2 HP de daño por turno vs 35 HP del Guerrero — riesgo inexistente.
 * Subir ATK de monstruos early game:
 *   Goblin Merodeador (id 1): 4 → 5
 *   Rata Gigante (id 3): 2 → 3
 *   Murciélago Vampiro (ids 6, 26, 27): 3 → 4
 * Con estos valores, 2-3 errores del jugador pueden ser peligrosos — sin dejar de ser manejable.
 */
function migrateCapillaHongoHintDIS1430() {
  // DIS-1430: la descripción de la Capilla Olvidada (sala 5) no menciona el hongo azul
  // antes de que el jugador intente ir al norte. Agregar una línea que prepare al jugador.
  try {
    const room = db.getRoom(5);
    if (!room) return console.warn('[seed] migrateCapillaHongoHintDIS1430: sala 5 no encontrada.');
    const HINT = ' Al norte, un umbral con marcas de esporas. Si pensás explorar por allí, los hongos azules del Túnel crecen justo detrás.';
    if (room.description && room.description.includes('hongos azules del Túnel')) {
      return console.log('[seed] migrateCapillaHongoHintDIS1430: hint ya presente. ✓');
    }
    const updatedRoom = Object.assign({}, room, {
      description: (room.description || '').trimEnd() + HINT,
      exits: typeof room.exits === 'string' ? JSON.parse(room.exits) : room.exits,
      items: typeof room.items === 'string' ? JSON.parse(room.items || '[]') : (room.items || []),
      trap: room.trap ? (typeof room.trap === 'string' ? JSON.parse(room.trap) : room.trap) : null,
    });
    db.upsertRoom(updatedRoom);
    db.persist();
    console.log('[seed] migrateCapillaHongoHintDIS1430: hint de hongo azul agregado a Capilla Olvidada. DIS-1430 ✓');
  } catch (e) {
    console.warn('[seed] migrateCapillaHongoHintDIS1430:', e.message);
  }
}

/**
 * BUG-1447: Asimetría de dirección entre Catedral (sala 15) y Cripta de los Valientes (sala 22).
 * La sala 15 tiene salida 'down' → 22, pero la sala 22 tiene salida 'north' → 15.
 * Corrección: sala 22 debe tener 'up' → 15 para que las direcciones sean simétricas (bajar/subir).
 */
function migrateFixCryptExitBUG1447() {
  try {
    const room22 = db.getRoom(22);
    if (!room22) return console.warn('[seed] migrateFixCryptExitBUG1447: sala 22 no encontrada.');
    const exits22 = room22.exits || {};
    // Si ya tiene 'up' → 15, está corregido
    if (exits22.up === 15 && !exits22.north) {
      return console.log('[seed] migrateFixCryptExitBUG1447: salida ya corregida. ✓');
    }
    // Reemplazar 'north' por 'up'
    const newExits = { ...exits22 };
    delete newExits.north;
    newExits.up = 15;
    db.upsertRoom({ ...room22, exits: newExits });
    db.persist();
    console.log('[seed] migrateFixCryptExitBUG1447: salida norte → arriba en sala 22 (Cripta). BUG-1447 ✓');
  } catch (e) {
    console.warn('[seed] migrateFixCryptExitBUG1447:', e.message);
  }
}

function migrateEarlyGameATKDIS1324() {
  try {
    const all = db.getAllMonsters ? db.getAllMonsters() : [];
    let changed = 0;

    // Goblin Merodeador: 4 → 5
    const goblin = all.find(m => m.id === 1);
    if (goblin && (goblin.attack || 0) < 5) {
      db.updateMonster(1, { attack: 5 });
      console.log(`[seed] migrateEarlyGameATKDIS1324: Goblin Merodeador ATK ${goblin.attack}→5. ✓`);
      changed++;
    }

    // Rata Gigante: 2 → 3
    const rata = all.find(m => m.id === 3);
    if (rata && (rata.attack || 0) < 3) {
      db.updateMonster(3, { attack: 3 });
      console.log(`[seed] migrateEarlyGameATKDIS1324: Rata Gigante ATK ${rata.attack}→3. ✓`);
      changed++;
    }

    // Murciélagos Vampiro (ids 6, 26, 27): 3 → 4
    for (const batId of [6, 26, 27]) {
      const bat = all.find(m => m.id === batId);
      if (bat && (bat.attack || 0) < 4) {
        db.updateMonster(batId, { attack: 4 });
        console.log(`[seed] migrateEarlyGameATKDIS1324: Murciélago Vampiro (id ${batId}) ATK ${bat.attack}→4. ✓`);
        changed++;
      }
    }

    if (changed === 0) {
      console.log('[seed] migrateEarlyGameATKDIS1324: todos los monstruos ya tienen ATK actualizado. ✓');
    } else {
      db.persist();
      console.log(`[seed] migrateEarlyGameATKDIS1324: ${changed} monstruos actualizados. DIS-1324 ✓`);
    }
  } catch (e) {
    console.warn('[seed] migrateEarlyGameATKDIS1324:', e.message);
  }
}

/**
 * DIS-1453: La descripción del Pozo Sin Fondo revela ruta alternativa completa con trampas.
 * Reemplazar la pista detallada por un hint vago que invite a explorar sin spoilear.
 * La descripción actual termina con: "...Sala del Trono (este) → Santuario. ⚠️ Ojo: esa ruta
 * tiene una trampa de esporas en los Hongos y una trampa de frío en el Trono — ambas activas
 * en la primera visita.)"
 * Nueva pista: invita a explorar sin revelar ruta ni trampas.
 */
function migratePozoPistaDIS1453() {
  try {
    const room7 = db.getRoom(7);
    if (!room7) return;
    // Descripción base (sin pista de ruta)
    const descBase = 'Un pozo en el centro de la sala emite un viento frío desde las profundidades. Una cuerda cuelga al borde. ¿Qué habrá abajo? Al norte, una puerta de hierro macizo con una cerradura oxidada bloquea el paso al Santuario.';
    // Pista vaga — sin spoilear ruta ni trampas, sin marcador HTML visible (BUG-1461)
    const pistaNueva = ' (💡 Se dice que hay otra manera de llegar al Santuario sin llave. El dungeon siempre tiene rutas alternativas para quienes exploran con cuidado.)';
    const descNueva = descBase + pistaNueva;
    if (room7.description === descNueva) {
      console.log('[seed] migratePozoPistaDIS1453: ya correcto. ✓');
      return;
    }
    db.upsertRoom({ ...room7, description: descNueva });
    db.persist();
    console.log('[seed] migratePozoPistaDIS1453: descripción de sala 7 corregida — comentario HTML eliminado (BUG-1461 ✓)');
  } catch (e) {
    console.warn('[seed] migratePozoPistaDIS1453:', e.message);
  }
}

function migrateHachaRusticaBUG1471() {
  // BUG-1471: "hacha rústica" no tenía ninguna fuente de obtención en el juego.
  // El desafío diario "El Hacha y la Sala" era imposible de completar.
  // Fix: agregar "hacha rústica" al loot del Goblin Merodeador (id=1).
  // El ítem ya tiene 15% de drop chance en LOOT_CHANCES de combat.js.
  // También se agregó a la tienda de Aldric (8g) en engine.js.
  try {
    const goblin = db.getMonster(1);
    if (!goblin) return;
    const loot = Array.isArray(goblin.loot) ? goblin.loot : JSON.parse(goblin.loot || '[]');
    if (loot.includes('hacha rústica')) {
      console.log('[seed] migrateHachaRusticaBUG1471: hacha rústica ya está en el loot. ✓');
      return;
    }
    db.updateMonster(1, { loot: [...loot, 'hacha rústica'] });
    console.log('[seed] migrateHachaRusticaBUG1471: hacha rústica agregada al loot del Goblin Merodeador (id=1) — BUG-1471 ✓');
  } catch (e) {
    console.warn('[seed] migrateHachaRusticaBUG1471:', e.message);
  }
}

/**
 * BUG-1474: Ítems épicos pre-placed en la Catedral de la Oscuridad (sala 15)
 * accesibles sin matar al Lich, duplicando el loot del boss.
 * Ítems afectados: espada de obsidiana, filacteria rota, armadura de placas,
 * tomo sellado, pergamino de furia (y poción de poder — neutral, se deja).
 * Fix: remover del suelo de sala 15 todos los ítems que el Lich dropea directamente.
 * La "bolsa de lona" (DIS-793) y la "poción de poder" se dejan intactas.
 */
function migrateCleanCatedralEpicLootBUG1474() {
  try {
    const room15 = db.getRoom(15);
    if (!room15) return;
    const items = Array.isArray(room15.items) ? room15.items : (room15.items ? JSON.parse(room15.items) : []);
    // Ítems que solo deben obtenerse del Lich (boss drop)
    const EPIC_ITEMS = new Set([
      'espada de obsidiana',
      'filacteria rota',
      'armadura de placas',
      'tomo sellado',
      'pergamino de furia',
    ]);
    const cleanItems = items.filter(i => !EPIC_ITEMS.has(i));
    if (cleanItems.length !== items.length) {
      db.upsertRoom({ ...room15, items: cleanItems });
      const removed = items.filter(i => EPIC_ITEMS.has(i));
      console.log(`[seed] migrateCleanCatedralEpicLootBUG1474: removidos del suelo de sala 15: ${removed.join(', ')}. BUG-1474 ✓`);
    } else {
      console.log('[seed] migrateCleanCatedralEpicLootBUG1474: sala 15 limpia (sin duplicados). BUG-1474 ✓');
    }
  } catch (e) {
    console.warn('[seed] migrateCleanCatedralEpicLootBUG1474:', e.message);
  }
}

/**
 * DIS-1481: Agregar Troll de las Cavernas (id 29) en la Forja (sala 12).
 * Mecánica especial: se regenera 5 HP cada turno si no es eliminado rápido.
 * Esto fuerza al jugador a adaptar estrategia (no solo DPS bruto) incluso con
 * equipamiento avanzado. El Troll también tiene resistencia física (×0.70) —
 * piel gruesa que absorbe los golpes directos.
 * Junto con el escalado dinámico de DIS-1481 en combat.js, esto restaura la
 * sensación de peligro en zonas avanzadas para jugadores nivel 4-5.
 */
function migrateTrollForjaDIS1481() {
  try {
    const existing = db.getMonster(29);
    if (existing) {
      console.log('[seed] migrateTrollForjaDIS1481: Troll de las Cavernas (id 29) ya existe. ✓');
      return;
    }
    db.upsertMonster({
      id: 29,
      name: 'Troll de las Cavernas',
      description: 'Una mole de carne grisácea y huesos expuestos. Su piel gruesa repele los golpes directos. La leyenda dice que si lo dejás vivo demasiado tiempo, sus heridas se cierran solas ante tus ojos.',
      hp: 50,
      max_hp: 50,
      attack: 11,
      room_id: 12,
      loot: ['piel de troll', 'núcleo de forja', 'monedas de oro'],
      respawn_room_id: 12,
    });
    console.log('[seed] migrateTrollForjaDIS1481: Troll de las Cavernas (id 29) creado en Taller de la Forja (sala 12). DIS-1481 ✓');
  } catch (e) {
    console.warn('[seed] migrateTrollForjaDIS1481:', e.message);
  }
}

function migratePozoDescDIS1562() {
  // DIS-1562: actualizar descripción de sala 7 (Pozo Sin Fondo) para cerrar expectativas
  // de la cuerda como dead end — "¿Qué habrá abajo?" reemplazado por referencia a inscripción
  try {
    const room7 = db.getRoom(7);
    if (!room7) return;
    const newDesc = 'Un pozo en el centro de la sala emite un viento frío desde las profundidades. Una cuerda cuelga al borde —la inscripción en la pared dice que nadie que intentó bajar volvió para contarlo. Al norte, una puerta de hierro macizo con una cerradura oxidada bloquea el paso al Santuario. (💡 Si no tenés la llave, hay otra ruta al Santuario: volvé a la Entrada, tomá el este hacia la Capilla, sigue norte por los Hongos y el Trono.)';
    if (room7.description && room7.description.includes('¿Qué habrá abajo?')) {
      db.upsertRoom({ ...room7, description: newDesc });
      console.log('[seed] migratePozoDescDIS1562: Sala 7 descripción actualizada — dead end cerrado con closure. DIS-1562 ✓');
    } else {
      console.log('[seed] migratePozoDescDIS1562: Ya estaba actualizada. ✓');
    }
  } catch (e) {
    console.warn('[seed] migratePozoDescDIS1562:', e.message);
  }
}

function migrateEcosHubDescDIS1584() {
  // DIS-1584: La Sala de los Ecos es el hub central del dungeon (conecta sur/este/oeste)
  // pero su descripción no lo comunicaba. El jugador se perdía fácilmente.
  // Nueva descripción: agrega señales sensoriales hacia los 3 destinos (Corredor sur,
  // Pozo oeste, Mercader este) para orientar al jugador de forma inmersiva.
  try {
    const room3 = db.getRoom(3);
    if (!room3) return;
    const HUB_MARKER = 'frío seco del oeste';
    if (room3.description && room3.description.includes(HUB_MARKER)) {
      console.log('[seed] migrateEcosHubDescDIS1584: Sala 3 ya tiene descripción de hub — sin cambios. ✓');
      return;
    }
    const newDesc = 'Una cámara circular donde cada sonido rebota mil veces. El suelo está cubierto de huesos viejos y polvo. Tres corrientes de aire se cruzan aquí: el frío seco del oeste lleva el olor del Pozo Sin Fondo; el calor metálico del este —la Cámara del Tesoro, donde Aldric el Mercader tiene su puesto de comercio— se mezcla con el aire húmedo que sube desde el Corredor de las Sombras, al sur.';
    db.upsertRoom({ ...room3, description: newDesc });
    console.log('[seed] migrateEcosHubDescDIS1584: Sala 3 descripción actualizada con señales de hub. DIS-1584 ✓');
  } catch (e) {
    console.warn('[seed] migrateEcosHubDescDIS1584:', e.message);
  }
}

/**
 * DIS-1605: Quest "La Purga de la Orden" diferenciada de "El Contrato de Élite".
 * Ambas eran kill de cualquier monstruo en postura agresiva (4 vs 5). Ahora "La Purga"
 * es una caza de espectros (target_type: 'espectro', any stance, count: 3) — tipo específico
 * de enemigo, diferente al Contrato de Élite que requiere postura agresiva en cualquier monstruo.
 */
function migrateQuestPurgaOrdenDIS1605() {
  try {
    const rawDb = db.raw();
    const exists = rawDb.exec(`SELECT id, condition FROM quest_definitions WHERE id = 'faccion_orden_filo_purga'`);
    if (!exists || !exists[0] || !exists[0].values || exists[0].values.length === 0) {
      console.log('[seed] migrateQuestPurgaOrdenDIS1605: quest faccion_orden_filo_purga no encontrada — sin cambios. ✓');
      return;
    }
    const currentCond = exists[0].values[0][1];
    const parsed = JSON.parse(currentCond || '{}');
    if (parsed.target_type === 'espectro') {
      console.log('[seed] migrateQuestPurgaOrdenDIS1605: quest ya tiene target_type=espectro — sin cambios. ✓');
      return;
    }
    const newCondition = JSON.stringify({ event: 'kill', target_type: 'espectro', require_stance: null, count: 3 });
    const newDescription = 'Las presencias espectrales del dungeon no son monstruos ordinarios — son una contaminación que la Orden del Filo tiene el deber de erradicar. Tu misión: eliminá 3 espectros. Espectros del Corredor, Guardia Espectral — todos cuentan. La postura es tuya, el resultado es lo que importa.';
    rawDb.run(
      `UPDATE quest_definitions SET description = ?, condition = ?, reward = ? WHERE id = 'faccion_orden_filo_purga'`,
      [
        newDescription,
        newCondition,
        JSON.stringify({ gold: 50, xp: 40, faction_influence: 6 }),
      ]
    );
    console.log('[seed] migrateQuestPurgaOrdenDIS1605: "La Purga de la Orden" → caza de espectros (target_type=espectro, count=3). DIS-1605 ✓');
  } catch (e) {
    console.warn('[seed] migrateQuestPurgaOrdenDIS1605:', e.message);
  }
}


/**
 * La condición target_type='goblin' ya aceptaba correctamente tanto al Goblin Merodeador
 * como al Goblin Explorador (sala 2). El nombre y la descripción originales implicaban
 * que solo contaban los Merodeadores, lo cual era confuso. Fix: actualizar nombre y
 * descripción en quest_definitions para comunicar correctamente que cualquier goblin
 * del Corredor de las Sombras cuenta.
 * INSERT OR IGNORE en db.js solo aplica al primer seed — esta migración actualiza
 * registros ya existentes en la BD.
 */
function migrateQuestGoblinDIS1590() {
  try {
    const rawDb = db.raw();
    const exists = rawDb.exec(`SELECT id FROM quest_definitions WHERE id = 'kill_goblin_generic'`);
    if (!exists || !exists[0] || !exists[0].values || exists[0].values.length === 0) {
      console.log('[seed] migrateQuestGoblinDIS1590: quest kill_goblin_generic no encontrada — sin cambios. ✓');
      return;
    }
    const current = rawDb.exec(`SELECT name FROM quest_definitions WHERE id = 'kill_goblin_generic'`);
    const currentName = current[0].values[0][0];
    if (currentName === 'La Caza en el Corredor') {
      console.log('[seed] migrateQuestGoblinDIS1590: quest ya tiene nombre actualizado — sin cambios. ✓');
      return;
    }
    rawDb.run(
      `UPDATE quest_definitions SET name = ?, description = ? WHERE id = 'kill_goblin_generic'`,
      [
        'La Caza en el Corredor',
        'Los goblins del Corredor de las Sombras han estado robando provisiones. Aldric necesita garras de goblin para un encantamiento de protección. Merodeadores, Exploradores — cualquiera sirve. Los encontrarás hacia el este desde la entrada.',
      ]
    );
    console.log('[seed] migrateQuestGoblinDIS1590: quest "La Caza del Merodeador" → "La Caza en el Corredor". DIS-1590 ✓');
  } catch (e) {
    console.warn('[seed] migrateQuestGoblinDIS1590:', e.message);
  }
}

/**
 * BUG-1654: Quest "Ritual en la Oscuridad" (Cónclave Arcano) era type='explore'.
 * Se completaba al entrar a sala 10, no al rezar como prometía la descripción.
 * Fix: type='ritual', condition action='pray', count=1.
 * Actualizar también cualquier instancia activa de la quest para reasignar condition+type.
 */
function migrateQuestRitualOscuridadBUG1654() {
  try {
    const rawDb = db.raw();
    const exists = rawDb.exec(`SELECT id, type FROM quest_definitions WHERE id = 'faccion_conclave_ritual_profundo'`);
    if (!exists || !exists[0] || !exists[0].values || exists[0].values.length === 0) {
      console.log('[seed] migrateQuestRitualOscuridadBUG1654: quest no encontrada — sin cambios. ✓');
      return;
    }
    const currentType = exists[0].values[0][1];
    if (currentType === 'ritual') {
      console.log('[seed] migrateQuestRitualOscuridadBUG1654: quest ya tiene type=ritual — sin cambios. ✓');
      return;
    }
    const newCondition = JSON.stringify({ action: 'pray', count: 1, target_room_id: 10 });
    const newDescription = 'El Cónclave estudia los patrones mágicos del dungeon. Para esta semana: andá al Santuario Profano (sala 10) y rezá ante el altar de la estatua de diez brazos. Ofrendá cualquier ítem con `pray <ítem>`. Los datos rituales que recopiles serán invaluables para la investigación arcana.';
    rawDb.run(
      `UPDATE quest_definitions SET type = 'ritual', condition = ?, description = ? WHERE id = 'faccion_conclave_ritual_profundo'`,
      [newCondition, newDescription]
    );
    // Resetear progreso de instancias activas de esta quest para que puedan completarse con el nuevo trigger
    rawDb.run(
      `UPDATE player_quests SET progress = '{}' WHERE quest_id = 'faccion_conclave_ritual_profundo' AND status = 'active'`
    );
    db.persist();
    console.log('[seed] migrateQuestRitualOscuridadBUG1654: "Ritual en la Oscuridad" → type=ritual, action=pray. BUG-1654 ✓');
  } catch (e) {
    console.warn('[seed] migrateQuestRitualOscuridadBUG1654:', e.message);
  }
}


/**
 * BUG-1646/1647: Limpiar guilds huérfanas (leader_id sin match en players).
 * - Guilds sin miembros ni líder válido: eliminarlas.
 * - Guilds con miembros pero sin líder válido: promover al primer miembro como líder.
 */
function migrateOrphanedGuildsBUG1646() {
  try {
    const rawDb = db.raw();
    const guildsResult = rawDb.exec(`SELECT g.id, g.name, g.leader_id FROM guilds g LEFT JOIN players p ON p.id = g.leader_id WHERE p.id IS NULL`);
    if (!guildsResult || !guildsResult[0] || !guildsResult[0].values || guildsResult[0].values.length === 0) {
      console.log('[seed] migrateOrphanedGuildsBUG1646: sin guilds huérfanas. BUG-1646/1647 ✓');
      return;
    }
    const orphans = guildsResult[0].values;
    let dissolved = 0;
    let promoted = 0;
    for (const [guildId, guildName, leaderId] of orphans) {
      // Ver si tiene miembros activos
      const membersResult = rawDb.exec(`SELECT id, username FROM players WHERE guild = ? LIMIT 1`, [guildName]);
      if (!membersResult || !membersResult[0] || !membersResult[0].values || membersResult[0].values.length === 0) {
        // Sin miembros y sin líder válido → disolver
        rawDb.run(`DELETE FROM guilds WHERE name = ?`, [guildName]);
        dissolved++;
        console.log(`[seed] migrateOrphanedGuildsBUG1646: hermandad [${guildName}] disuelta (sin miembros, líder eliminado). BUG-1646 ✓`);
      } else {
        // Tiene miembros → promover al primero como líder
        const [newLeaderId, newLeaderName] = membersResult[0].values[0];
        rawDb.run(`UPDATE guilds SET leader_id = ? WHERE name = ?`, [newLeaderId, guildName]);
        promoted++;
        console.log(`[seed] migrateOrphanedGuildsBUG1646: hermandad [${guildName}] — líder inexistente reemplazado por ${newLeaderName}. BUG-1647 ✓`);
      }
    }
    db.persist();
    console.log(`[seed] migrateOrphanedGuildsBUG1646: ${dissolved} guilds disueltas, ${promoted} líderes actualizados. BUG-1646/1647 ✓`);
  } catch (e) {
    console.warn('[seed] migrateOrphanedGuildsBUG1646:', e.message);
  }
}

/**
 * DIS-1745: Resolver catch-22 de la trampa de esporas del Túnel de Hongos.
 * El hongo azul necesario para desactivar la trampa de sala 6 solo crecía dentro
 * del Túnel (protegido por la trampa) — un catch-22 para el jugador.
 * Solución: garantizar un hongo azul en el suelo de la Capilla Olvidada (sala 5)
 * la primera vez. La sala 5 es adyacente al Túnel (norte→6) y es accesible sin trampa.
 * Si el jugador ya recogió el hongo (floor_items vacío de hongo azul), no repetir.
 */
function migrateHongoAzulCapillaDIS1745() {
  try {
    const room = db.getRoom(5);
    if (!room) return console.warn('[seed] migrateHongoAzulCapillaDIS1745: sala 5 no encontrada.');
    // Verificar si la trampa de sala 6 ya está desactivada (si es así, no hace falta el hongo)
    const room6 = db.getRoom(6);
    const trap6Active = room6 && room6.trap ? room6.trap.active : false;
    if (!trap6Active) {
      return console.log('[seed] migrateHongoAzulCapillaDIS1745: trampa de sala 6 inactiva — no se necesita hongo. ✓');
    }
    // Verificar si ya tiene hongo azul en room.items (static) — no agregar dos veces
    const currentItems = Array.isArray(room.items) ? room.items : [];
    if (currentItems.some(i => (typeof i === 'string' ? i : '').toLowerCase().includes('hongo azul'))) {
      return console.log('[seed] migrateHongoAzulCapillaDIS1745: hongo azul ya presente en sala 5. ✓');
    }
    // Agregar hongo azul a los items de la Capilla Olvidada
    const newItems = [...currentItems, 'hongo azul'];
    const updatedRoom = Object.assign({}, room, {
      items: newItems,
      exits: typeof room.exits === 'string' ? JSON.parse(room.exits) : room.exits,
      trap: room.trap ? (typeof room.trap === 'string' ? JSON.parse(room.trap) : room.trap) : null,
    });
    db.upsertRoom(updatedRoom);
    db.persist();
    console.log('[seed] migrateHongoAzulCapillaDIS1745: hongo azul colocado en Capilla Olvidada. DIS-1745 ✓');
  } catch (e) {
    console.warn('[seed] migrateHongoAzulCapillaDIS1745:', e.message);
  }
}

/**
 * BUG-1682: La migration migrateCapillaHongoHintDIS1430 sobrescribe la descripción
 * de sala 5 (Capilla Olvidada) y borra la pista de 'examine inscripcion' que puso
 * migrateNarrativeLore (DIS-1680). Esta migration corre después de DIS-1430 y
 * restaura el hint de inscripción si falta.
 */
function migrateCapillaInscripcionBUG1682() {
  try {
    const room = db.getRoom(5);
    if (!room) return console.warn('[seed] migrateCapillaInscripcionBUG1682: sala 5 no encontrada.');
    // Si ya tiene el hint de inscripción, no hacer nada
    if (room.description && room.description.includes('examine inscripcion')) {
      return console.log('[seed] migrateCapillaInscripcionBUG1682: hint de inscripción ya presente. ✓');
    }
    // Agregar la pista de inscripción al final de la descripción
    const HINT = '\n📜 Una inscripción en la pared norte llama tu atención. (examine inscripcion)';
    const updatedRoom = Object.assign({}, room, {
      description: (room.description || '').trimEnd() + HINT,
      exits: typeof room.exits === 'string' ? JSON.parse(room.exits) : room.exits,
      items: typeof room.items === 'string' ? JSON.parse(room.items || '[]') : (room.items || []),
      trap: room.trap ? (typeof room.trap === 'string' ? JSON.parse(room.trap) : room.trap) : null,
    });
    db.upsertRoom(updatedRoom);
    db.persist();
    console.log('[seed] migrateCapillaInscripcionBUG1682: hint de inscripción restaurado en Capilla Olvidada. BUG-1682 ✓');
  } catch (e) {
    console.warn('[seed] migrateCapillaInscripcionBUG1682:', e.message);
  }
}

// ─── IMPL-VV-1761: Monstruos nuevos para Variación Viva ──────────────────────

/**
 * IMPL-VV-1761a: Gnoll Merodeador (id 30)
 * Monstruo variable para salas 3, 6, 7 según run_monster_variants.
 * HP 18, ATK 5. No undead, no elemental.
 * Loot: hacha rústica, monedas de cobre.
 */
function migrateGnollMerodeadorIMPL1761() {
  try {
    const existing = db.getMonster(30);
    if (existing) {
      console.log('[seed] migrateGnollMerodeadorIMPL1761: Gnoll Merodeador (id 30) ya existe. ✓');
      return;
    }
    db.upsertMonster({
      id: 30,
      name: 'Gnoll Merodeador',
      description: 'Una hiena erguida de casi dos metros. Porta un hacha astillada y una bolsa de trofeos robados. Sus ojos amarillos calculan siempre cuánto vale lo que ves.',
      hp: 18,
      max_hp: 18,
      attack: 5,
      room_id: null,
      loot: ['hacha rústica', 'monedas de cobre'],
      respawn_room_id: null,
    });
    db.persist();
    console.log('[seed] migrateGnollMerodeadorIMPL1761: Gnoll Merodeador (id 30) creado. IMPL-VV-1761a ✓');
  } catch (e) {
    console.warn('[seed] migrateGnollMerodeadorIMPL1761:', e.message);
  }
}

/**
 * IMPL-VV-1761b: Zombie Caminante (id 31)
 * Monstruo variable para sala 3 según run_monster_variants.
 * HP 22, ATK 4. Tipo undead (detectado por nombre — contiene 'zombie').
 * En evento marea_no_muertos: +2 HP (24 HP).
 * Loot: tela podrida, monedas de cobre.
 */
function migrateZombieCaminanteIMPL1761() {
  try {
    const existing = db.getMonster(31);
    if (existing) {
      console.log('[seed] migrateZombieCaminanteIMPL1761: Zombie Caminante (id 31) ya existe. ✓');
      return;
    }
    db.upsertMonster({
      id: 31,
      name: 'Zombie Caminante',
      description: 'Un cadáver parcialmente animado que arrastra los pies. Sus movimientos son lentos pero inevitables — no huye, no razona, no para.',
      hp: 22,
      max_hp: 22,
      attack: 4,
      room_id: null,
      loot: ['tela podrida', 'monedas de cobre'],
      respawn_room_id: null,
    });
    db.persist();
    console.log('[seed] migrateZombieCaminanteIMPL1761: Zombie Caminante (id 31) creado. IMPL-VV-1761b ✓');
  } catch (e) {
    console.warn('[seed] migrateZombieCaminanteIMPL1761:', e.message);
  }
}

/**
 * IMPL-VV-1761c: Elemental de Fuego (id 32)
 * Monstruo variable para sala 20 según run_monster_variants (variante golem_elemental_fuego).
 * HP 30, ATK 8. Tipo elemental (detectado por nombre — no undead).
 * En evento plaga_arcana: +10 HP (40 HP).
 * Loot: esencia de fuego, núcleo ígneo.
 */
function migrateElementalFuegoIMPL1761() {
  try {
    const existing = db.getMonster(32);
    if (existing) {
      console.log('[seed] migrateElementalFuegoIMPL1761: Elemental de Fuego (id 32) ya existe. ✓');
      return;
    }
    db.upsertMonster({
      id: 32,
      name: 'Elemental de Fuego',
      description: 'Una columna de fuego que adquirió voluntad. No tiene cuerpo fijo — su forma cambia con cada latigazo de llama. Los metales cercanos se derriten si te acercás demasiado.',
      hp: 30,
      max_hp: 30,
      attack: 8,
      room_id: null,
      loot: ['esencia de fuego', 'núcleo ígneo'],
      respawn_room_id: null,
    });
    db.persist();
    console.log('[seed] migrateElementalFuegoIMPL1761: Elemental de Fuego (id 32) creado. IMPL-VV-1761c ✓');
  } catch (e) {
    console.warn('[seed] migrateElementalFuegoIMPL1761:', e.message);
  }
}

/**
 * DIS-1775: Murciélago Vampiro — mecánica de drain life
 * Actualiza la descripción de los murciélagos vampiro (ids 6, 26, 27) para
 * reflejar su habilidad de drenaje de vida. La mecánica en combat.js está activa;
 * la descripción debe dar pista narrativa al jugador.
 */
function migrateBatVampireDescDIS1775() {
  try {
    const newDesc = {
      6:  'Un murciélago enorme con colmillos afilados como agujas. Sus mordidas drenan la vitalidad de la víctima. Revolotea en la oscuridad de la capilla.',
      26: 'Un murciélago enorme con colmillos afilados como agujas. Sus mordidas drenan la vitalidad de la víctima. Revolotea entre los ecos de la sala.',
      27: 'Un murciélago enorme que anida entre los hongos. Sus colmillos brillan en la penumbra — quien los siente pierde más que sangre.',
    };
    for (const [idStr, desc] of Object.entries(newDesc)) {
      const id = Number(idStr);
      const m = db.getMonster(id);
      if (m && !m.description.includes('drenan la vitalidad') && !m.description.includes('pierde más que sangre')) {
        db.updateMonster(id, { description: desc });
        console.log(`[seed] migrateBatVampireDescDIS1775: Murciélago Vampiro id ${id} — descripción actualizada. DIS-1775 ✓`);
      }
    }
    db.persist();
  } catch (e) {
    console.warn('[seed] migrateBatVampireDescDIS1775:', e.message);
  }
}

function migrateFuenteEternaDescDIS1778() {
  // DIS-1778: La descripción de la Cámara de la Fuente Eterna (sala 18) decía
  // "hallará agua vacía" (implica agotamiento permanente) pero el sistema solo
  // tiene un cooldown temporal. Se actualiza a "hallará el agua demorada" para
  // que la ficción sea consistente con la mecánica real.
  try {
    const room = db.getRoom(18);
    if (!room) {
      console.warn('[seed] migrateFuenteEternaDescDIS1778: sala 18 no existe — omitiendo.');
      return;
    }
    if (room.description && room.description.includes('hallará el agua demorada')) {
      // console.log('[seed] migrateFuenteEternaDescDIS1778: ya migrado, sin cambios.');
      return;
    }
    const newDesc = 'Una cámara circular tallada en mármol blanco, luminosa pese a la oscuridad del dungeon. En el centro burbujea una fuente de agua plateada que nunca se agota. El agua tiene propiedades curativas legendarias. En las paredes, runas antiguas advierten: "El poder de la fuente requiere descanso. Quien abuse de ella hallará el agua demorada."';
    db.upsertRoom({ ...room, description: newDesc });
    db.persist();
    console.log('[seed] migrateFuenteEternaDescDIS1778: Sala 18 — descripción actualizada. DIS-1778 ✓');
  } catch (e) {
    console.warn('[seed] migrateFuenteEternaDescDIS1778:', e.message);
  }
}

function migrateSubastaNorthHintDIS1789() {
  // DIS-1789: La Casa de Subastas (sala 17) ya tiene salida al norte (→ sala 8, Prisión Subterránea)
  // gracias a migratePrisonConnection, pero la descripción no lo menciona.
  // Los jugadores que llegan desde la Cámara del Tesoro (sala 4) no saben que pueden
  // ir al norte para acceder a las salas del ala norte sin pasar por la Prisión.
  // Se agrega una línea de pista de navegación al final de la descripción.
  try {
    const room = db.getRoom(17);
    if (!room) {
      console.warn('[seed] migrateSubastaNorthHintDIS1789: sala 17 no existe — omitiendo.');
      return;
    }
    if (room.description && room.description.includes('pasillo al norte')) {
      // console.log('[seed] migrateSubastaNorthHintDIS1789: ya migrado, sin cambios.');
      return;
    }
    const newDesc = room.description + ' Un pasillo al norte conduce a la Prisión Subterránea — una ruta alternativa para quienes quieran evitar la entrada principal del ala este.';
    db.upsertRoom({ ...room, description: newDesc });
    db.persist();
    console.log('[seed] migrateSubastaNorthHintDIS1789: Sala 17 — pista de ruta norte agregada. DIS-1789 ✓');
  } catch (e) {
    console.warn('[seed] migrateSubastaNorthHintDIS1789:', e.message);
  }
}


/**
 * DIS-1796: El Ojo del Cónclave difícil de completar — reducir scale_per_level de 1.0 a 0.5.
 * A nivel 2: antes 7 examines → ahora 6. Más accesible sin trivializar.
 */
function migrateConclaveExamineDIS1796() {
  try {
    const rawDb = db.raw();
    if (!rawDb) {
      console.warn('[seed] migrateConclaveExamineDIS1796: db no inicializada — omitiendo.');
      return;
    }
    const row = rawDb.prepare("SELECT scale_per_level FROM faction_mission_definitions WHERE id = 'fm_conclave_examine_salas'").get();
    if (!row) {
      console.log('[seed] migrateConclaveExamineDIS1796: definición no encontrada — sin cambios. ✓');
      return;
    }
    if (row.scale_per_level <= 0.5) {
      console.log('[seed] migrateConclaveExamineDIS1796: ya migrado (scale_per_level=' + row.scale_per_level + '). ✓');
      return;
    }
    rawDb.prepare("UPDATE faction_mission_definitions SET scale_per_level = 0.5 WHERE id = 'fm_conclave_examine_salas'").run();
    console.log('[seed] migrateConclaveExamineDIS1796: fm_conclave_examine_salas scale_per_level 1.0→0.5. DIS-1796 ✓');
  } catch (e) {
    console.warn('[seed] migrateConclaveExamineDIS1796:', e.message);
  }
}
