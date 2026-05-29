/**
 * seed.js — Dungeon inicial (10 habitaciones, 5 monstruos)
 *
 * Se ejecuta una sola vez al arrancar si las habitaciones no existen.
 */

'use strict';

const db = require('./db');

const ROOMS = [
  {
    id: 1,
    name: 'Entrada de la Cripta',
    description: 'Una puerta de piedra enorme marca la entrada. El aire huele a moho y tiempo olvidado. La oscuridad se extiende al norte.',
    exits: { north: 2, east: 5 },
    items: ['antorcha'],
  },
  {
    id: 2,
    name: 'Corredor de las Sombras',
    description: 'Un pasillo largo y estrecho. Las paredes de piedra sudan humedad. Inscripciones ilegibles cubren las paredes.',
    exits: { south: 1, north: 3, west: 6 },
    items: [],
  },
  {
    id: 3,
    name: 'Sala de los Ecos',
    description: 'Una cámara circular donde cada sonido rebota mil veces. El suelo está cubierto de huesos viejos.',
    exits: { south: 2, east: 4, west: 7 },
    items: ['poción de salud'],
  },
  {
    id: 4,
    name: 'Cámara del Tesoro',
    description: 'Estantes de madera podrida sostienen cofres vacíos. Algo valioso estuvo aquí alguna vez.',
    exits: { west: 3, north: 8 },
    items: ['espada oxidada'],
  },
  {
    id: 5,
    name: 'Capilla Olvidada',
    description: 'Un altar de piedra negra domina la sala. Velas apagadas desde hace siglos. Una sensación extraña recorre tu espalda.',
    exits: { west: 1, north: 6 },
    items: ['libro viejo'],
  },
  {
    id: 6,
    name: 'Túnel de los Hongos',
    description: 'Hongos luminiscentes de color azul crecen por las paredes, dando una luz tenue y fantasmal al pasaje.',
    exits: { east: 2, south: 5, north: 9 },
    items: [],
  },
  {
    id: 7,
    name: 'Pozo Sin Fondo',
    description: 'Un pozo en el centro de la sala emite un viento frío desde las profundidades. ¿Qué habrá abajo?',
    exits: { east: 3, north: 10 },
    items: ['cuerda'],
  },
  {
    id: 8,
    name: 'Prisión Subterránea',
    description: 'Celdas de hierro corroído bordean las paredes. Las rejas están abiertas. Algo estuvo aquí encerrado.',
    exits: { south: 4 },
    items: ['llave oxidada'],
  },
  {
    id: 9,
    name: 'Sala del Trono',
    description: 'Un trono de huesos ocupa el centro de la sala. Las paredes están decoradas con escudos de armas irreconocibles.',
    exits: { south: 6, east: 10 },
    items: [],
  },
  {
    id: 10,
    name: 'Santuario Profano',
    description: 'El corazón del dungeon. Una estatua monstruosa preside la sala. El suelo está cubierto de runas de sangre seca.',
    exits: { west: 9, south: 7 },
    items: ['amuleto oscuro'],
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
    loot: ['pelaje áspero'],
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
];

function seedIfEmpty() {
  const existing = db.getAllRooms();
  if (existing.length > 0) {
    console.log('[seed] Dungeon ya existe, saltando seed.');
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
}

module.exports = { seedIfEmpty, ROOMS, MONSTERS };
