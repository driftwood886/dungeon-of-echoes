'use strict';
// Test DIS-2293: jugador de bajo nivel en sala de boss → reubicado a sala 1 al hacer login

const db = require('./db/db');
const { getOrCreatePlayer } = require('./game/engine');

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

async function main() {
  await db.init();

  // 1. Crear jugador nuevo (irá al tutorial sala 16 inicialmente)
  const TEST_USERNAME = `test_dis2293_${Date.now()}`;
  let player = getOrCreatePlayer(TEST_USERNAME);
  assert('Jugador nuevo va a sala de tutorial (16)', player.current_room_id === 16);

  // 2. Simular que completó el tutorial y ahora está en sala 12 (Taller de la Forja)
  //    con nivel 1 (bajo nivel para un boss nivel 5+)
  db.updatePlayer(player.id, {
    current_room_id: 12,
    tutorial_step: 0,
    level: 1,
    kills: 1, // tiene 1 kill para que shouldStartTutorial devuelva false
  });

  // 3. Hacer login nuevamente → debe ser reubicado a sala 1
  player = getOrCreatePlayer(TEST_USERNAME);
  assert('Jugador nivel 1 en sala 12 (boss nivel 5+) reubicado a sala 1 al hacer login', player.current_room_id === 1);

  // 4. Repetir pero con nivel suficiente (nivel 5 en sala 12) → NO debe reubicarse
  db.updatePlayer(player.id, {
    current_room_id: 12,
    level: 5,
  });
  player = getOrCreatePlayer(TEST_USERNAME);
  assert('Jugador nivel 5 en sala 12 (boss nivel 5+) NO es reubicado', player.current_room_id === 12);

  // 5. Nivel 1 en sala 15 (Catedral, boss nivel 7+) → reubicado
  db.updatePlayer(player.id, {
    current_room_id: 15,
    level: 1,
  });
  player = getOrCreatePlayer(TEST_USERNAME);
  assert('Jugador nivel 1 en sala 15 (boss nivel 7+) reubicado a sala 1', player.current_room_id === 1);

  // 6. Nivel 3 en sala 5 (no es sala de boss) → no debe moverse
  db.updatePlayer(player.id, {
    current_room_id: 5,
    level: 3,
  });
  player = getOrCreatePlayer(TEST_USERNAME);
  assert('Jugador en sala 5 (no es sala de boss) no se mueve', player.current_room_id === 5);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
