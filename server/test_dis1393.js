/**
 * test_dis1393.js — Prueba de consecuencias de muerte (pérdida de oro recuperable)
 * DIS-1393: al morir, el jugador pierde 15% del oro (mín 5g, máx 50g) en la sala donde murió.
 */
'use strict';

const db = require('./db/db.js');
const engine = require('./game/engine.js');
const combat = require('./game/combat.js');

async function runTest() {
  await db.init();

  const TEST_USERNAME = `test_dis1393`;
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

  console.log('\n=== TEST DIS-1393: Consecuencias de muerte — pérdida de oro recuperable ===\n');

  // Obtener o crear jugador de prueba
  let player = db.getPlayerByUsername(TEST_USERNAME);
  if (!player) {
    player = db.createPlayer(TEST_USERNAME);
  }
  playerId = player.id;
  console.log('Jugador de prueba:', playerId);

  // --- TEST 1: jugador con < 20g no pierde oro al morir ---
  console.log('\n--- Test 1: jugador con 15g (< 20) — no debe perder oro ---');
  db.updatePlayer(playerId, { gold: 15, current_room_id: 3, hp: 1 });
  const room3Clean1 = db.getRoom(3);
  db.updateRoomItems(3, (room3Clean1?.items || []).filter(i => !i.includes('bolsa de monedas caídas')));
  const lines1 = [];
  combat.handlePlayerDeath(playerId, lines1, 'test');
  const p1 = db.getPlayer(playerId);
  assert(p1.gold === 15, `Gold debe seguir en 15 (actual: ${p1.gold})`);
  assert(!lines1.some(l => l.includes('bolsa de monedas caídas')), `No debe haber mensaje de bolsa. Messages: ${JSON.stringify(lines1)}`);
  console.log('  Gold:', p1.gold, '| Sala respawn:', p1.current_room_id);

  // --- TEST 2: jugador con 100g pierde 15g al morir (15% de 100) ---
  console.log('\n--- Test 2: jugador con 100g — debe perder 15g ---');
  db.updatePlayer(playerId, { gold: 100, current_room_id: 3, hp: 1 });
  const room3Before = db.getRoom(3);
  db.updateRoomItems(3, (room3Before?.items || []).filter(i => !i.includes('bolsa de monedas caídas')));

  const lines2 = [];
  combat.handlePlayerDeath(playerId, lines2, 'test');
  const p2 = db.getPlayer(playerId);
  assert(p2.gold === 85, `Gold debe ser 85 (actual: ${p2.gold})`);
  assert(lines2.some(l => l.includes('15g')), `Debe mencionar 15g. Mensajes: ${JSON.stringify(lines2)}`);
  const room3After = db.getRoom(3);
  const droppedItems = (room3After?.items || []).filter(i => i.includes('bolsa de monedas caídas'));
  assert(droppedItems.length > 0, `Debe haber bolsa de monedas caídas en sala 3: ${JSON.stringify(room3After?.items)}`);
  assert(droppedItems[0].includes('15g'), `La bolsa debe indicar 15g: ${droppedItems[0]}`);
  console.log('  Gold después de muerte:', p2.gold);
  console.log('  Bolsa en sala 3:', droppedItems);
  console.log('  Mensajes:', lines2.filter(l => l.includes('g')));

  // --- TEST 3: recoger la bolsa devuelve el oro ---
  console.log('\n--- Test 3: recoger bolsa caída devuelve oro ---');
  db.updatePlayer(playerId, { current_room_id: 3, hp: 30 });
  const r3 = engine.execute(playerId, 'recoger bolsa de monedas caídas');
  const resultText3 = r3.text || r3.result || '';
  console.log('  Resultado recoger:', resultText3.substring(0, 200));
  const p3 = db.getPlayer(playerId);
  console.log('  Gold después de recoger:', p3.gold);
  assert(p3.gold === 100, `Gold debe ser 100 tras recuperar (actual: ${p3.gold})`);
  const room3Cleaned = db.getRoom(3);
  assert(!(room3Cleaned?.items || []).some(i => i.includes('bolsa de monedas caídas')), 'La bolsa debe haberse quitado de la sala');

  // --- TEST 4: muerte con 500g — cap 50g ---
  console.log('\n--- Test 4: jugador con 500g — cap de 50g ---');
  db.updatePlayer(playerId, { gold: 500, current_room_id: 5, hp: 1 });
  const room5Before = db.getRoom(5);
  db.updateRoomItems(5, (room5Before?.items || []).filter(i => !i.includes('bolsa de monedas caídas')));
  const lines4 = [];
  combat.handlePlayerDeath(playerId, lines4, 'test');
  const p4 = db.getPlayer(playerId);
  assert(p4.gold === 450, `Gold debe ser 450 tras perder 50g cap (actual: ${p4.gold})`);
  const room5After = db.getRoom(5);
  const droppedItems4 = (room5After?.items || []).filter(i => i.includes('bolsa de monedas caídas'));
  assert(droppedItems4.some(i => i.includes('50g')), `Bolsa debe tener 50g: ${JSON.stringify(droppedItems4)}`);
  console.log('  Gold con cap:', p4.gold, '| Bolsa:', droppedItems4);
  db.updateRoomItems(5, (room5After?.items || []).filter(i => !i.includes('bolsa de monedas caídas')));

  cleanup();
  console.log('\n=== TODOS LOS TESTS DIS-1393 PASARON ✅ ===');
  db.persist();
}

runTest().catch(err => {
  console.error('Error en test:', err);
  process.exit(1);
});
