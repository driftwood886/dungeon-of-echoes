/**
 * test_dis1485.js — Prueba del tracker narrativo de Kaelthas
 * DIS-1485: lore sin args muestra fragmentos; examinar pared en sala 2 agrega al diario
 */
'use strict';

const db = require('./db/db.js');
const engine = require('./game/engine.js');

async function runTest() {
  await db.init();

  const TEST_USERNAME = 'test_dis1485_lore';
  let playerId;

  function cleanup() {
    if (playerId) {
      try { db.deletePlayer(playerId); } catch (_) {}
    }
  }

  function assert(cond, msg) {
    if (!cond) {
      console.error(`FAIL: ${msg}`);
      cleanup();
      process.exit(1);
    }
    console.log(`  ✅ PASS: ${msg}`);
  }

  console.log('\n=== TEST DIS-1485: Tracker narrativo Kaelthas / lore sin args ===\n');

  // Crear jugador de prueba
  let player = db.getPlayerByUsername(TEST_USERNAME);
  if (player) db.deletePlayer(player.id);
  player = db.createPlayer(TEST_USERNAME);
  playerId = player.id;
  console.log('Jugador de prueba:', playerId);

  // 1. lore sin args → mensaje de "sin fragmentos"
  db.updatePlayer(playerId, { current_room_id: 1 });
  const r1 = engine.execute(playerId, 'lore');
  assert(r1.text.includes('Todavía no descubriste'), 'lore sin args sin entradas → mensaje de vacío');
  assert(r1.text.includes('Diario de Lore'), 'lore sin args sin entradas → título correcto');
  console.log('  Respuesta:', r1.text.slice(0, 150));

  // 2. examine pared en sala 2 → agrega fragmento al diario
  db.updatePlayer(playerId, { current_room_id: 2 });
  const r2 = engine.execute(playerId, 'examine pared');
  assert(r2.text.includes('KAELTHAS'), 'examine pared sala 2 → muestra inscripción');
  console.log('  Respuesta examine:', r2.text.slice(0, 250));
  const hasLoreHint = r2.text.includes('fragmento') || r2.text.includes('lore') || r2.text.includes('diario');
  assert(hasLoreHint, 'examine pared sala 2 primera vez → hint de diario de lore');

  // 3. Verificar que se agregó al journal
  const fresh3 = db.getPlayer(playerId);
  const journal3 = fresh3.journal ? JSON.parse(fresh3.journal) : [];
  const loreEntries3 = journal3.filter(e => e.type === 'lore');
  assert(loreEntries3.length >= 1, 'journal tiene al menos 1 entrada de tipo lore después de examinar pared');
  assert(loreEntries3.some(e => e.message.includes('Kaelthas') || e.message.includes('KAELTHAS')), 
         'la entrada lore menciona a Kaelthas');
  console.log('  Entradas lore en journal:', loreEntries3.length);

  // 4. lore sin args → ahora muestra los fragmentos
  const r4 = engine.execute(playerId, 'lore');
  assert(r4.text.includes('FRAGMENTOS NARRATIVOS') || r4.text.includes('Kaelthas'), 
         'lore sin args con entradas → muestra fragmentos');
  assert(!r4.text.includes('Todavía no descubriste'), 'lore sin args con entradas → no mensaje de vacío');
  console.log('  Respuesta lore con entradas:', r4.text.slice(0, 250));

  // 5. lore con args → enciclopedia de ítems
  const r5 = engine.execute(playerId, 'lore espada oxidada');
  assert(!r5.text.includes('FRAGMENTOS NARRATIVOS'), 'lore con args → enciclopedia de ítems, no tracker');
  console.log('  Respuesta lore con ítem:', r5.text.slice(0, 100));

  // 6. TYPE_LABELS en journal muestra lore correctamente
  const r6 = engine.execute(playerId, 'journal');
  assert(r6.text.includes('Lore'), 'journal muestra tipo lore con etiqueta Lore');
  console.log('  Respuesta journal:', r6.text.slice(0, 350));

  console.log('\n✅ Todos los tests pasaron.\n');
  cleanup();
  process.exit(0);
}

runTest().catch(e => {
  console.error('Error inesperado:', e);
  process.exit(1);
});
