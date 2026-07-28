/**
 * Test DIS-2068: `usar llave oxidada` en sala 7 (Pozo Sin Fondo)
 * Antes del fix: respondía "No hay ninguna cerradura que abrir aquí"
 * Después del fix: debe usar la llave y mover al jugador al norte (sala 10 Santuario)
 */
'use strict';

const db = require('./db/db.js');
const engine = require('./game/engine.js');

async function runTest() {
  await db.init();

  const username = 'BotDIS2068_' + Date.now();
  let player = db.createPlayer(username);
  const pid = player.id;
  console.log(`[TEST] Jugador: ${player.username} (id=${pid})`);

  // Llevar al jugador a sala 7 con llave oxidada y stats suficientes
  db.updatePlayer(pid, {
    level: 5,
    attack: 15,
    hp: 60,
    max_hp: 60,
    player_class: 'guerrero',
    current_room_id: 7,
    inventory: JSON.stringify(['llave oxidada', 'daga básica']),
    gold: 50,
  });

  // Verificar sala 7 exits
  const room7 = db.getRoom(7);
  console.log(`[TEST] Sala 7: ${room7.name}`);
  const exits7 = room7.exits;
  console.log(`[TEST] Sala 7 exits: ${JSON.stringify(exits7)}`);
  console.log(`[TEST] Exit norte tipo: ${JSON.stringify(exits7.north)}`);
  console.log('');

  // Ejecutar "usar llave oxidada"
  console.log('[TEST] Ejecutando: usar llave oxidada');
  const result = engine.execute(pid, 'usar llave oxidada');
  const resultText = result.text || result.result || '';
  console.log(`[TEST] Resultado:\n${resultText.substring(0, 400)}`);
  console.log('');

  // Verificar sala post-comando
  const playerAfter = db.getPlayer(pid);
  console.log(`[TEST] Sala después del comando: ${playerAfter.current_room_id}`);
  const invAfter = playerAfter.inventory || [];
  console.log(`[TEST] Inventario después: ${JSON.stringify(invAfter)}`);
  
  const moved = playerAfter.current_room_id !== 7;
  const keyConsumed = !invAfter.includes('llave oxidada');
  
  console.log('');
  console.log('=== RESULTADO DEL TEST ===');
  if (moved && keyConsumed) {
    console.log(`✅ PASS: El jugador se movió a sala ${playerAfter.current_room_id} y la llave fue consumida.`);
  } else if (!moved) {
    console.log(`❌ FAIL: El jugador no se movió (sigue en sala ${playerAfter.current_room_id}).`);
  } else if (!keyConsumed) {
    console.log(`⚠️  WARN: El jugador se movió pero la llave no fue consumida (sigue en inventario).`);
  }

  // Limpieza
  try { db.deletePlayer(pid); } catch (_) {}
  console.log('[TEST] Jugador limpiado.');
}

runTest().catch(e => {
  console.error('[TEST ERROR]', e);
  process.exit(1);
}).finally(() => {
  try { db.close(); } catch (_) {}
  process.exit(0);
});
