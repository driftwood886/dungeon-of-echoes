/**
 * Test DIS-2091: desde sala 6 (Túnel de Hongos, trampa local activa de esporas),
 * jugador con «hongo azul» escribe "desactivar trampa norte" (sala 9 = Sala del Trono,
 * trampa de frío que necesita «corona rota»).
 * 
 * Antes del fix (DIS-1731): auto-desactivaba la trampa local de sala 6 (MAL).
 * Después del fix (DIS-2091): informa que no tiene corona rota, menciona trampa local (BIEN).
 */

'use strict';

const db = require('./server/db/db.js');
const engine = require('./server/game/engine.js');

async function runTest() {
  await db.init();

  const username = 'TestDIS2091b_' + Date.now();
  let player = db.createPlayer(username);
  const pid = player.id;
  console.log(`[TEST] Jugador: ${player.username} (id=${pid})`);

  // Jugador en sala 6 (Túnel de Hongos) con hongo azul en inventario
  db.updatePlayer(pid, {
    level: 4, attack: 10, hp: 60, max_hp: 60,
    current_room_id: 6,
    inventory: JSON.stringify(['hongo azul']),
  });

  // Verificar sala 6 y sala 9
  const room6 = db.getRoom(6);
  const room9 = db.getRoom(9);
  console.log(`[TEST] Sala 6: ${room6 ? room6.name : 'NOT FOUND'}, trap: active=${room6 && room6.trap && room6.trap.active}, item=${room6 && room6.trap && room6.trap.item_needed}`);
  console.log(`[TEST] Sala 9: ${room9 ? room9.name : 'NOT FOUND'}, trap: active=${room9 && room9.trap && room9.trap.active}, item=${room9 && room9.trap && room9.trap.item_needed}`);

  // Asegurar que sala 6 tiene trampa activa con hongo azul
  if (!room6 || !room6.trap || !room6.trap.active) {
    db.updateRoomTrap(6, { type: 'poison', active: true, item_needed: 'hongo azul', disarm_msg: '🍄 Las esporas se disipan.' });
    console.log('[TEST] Trampa sala 6 activada.');
  }

  // Asegurar que sala 9 tiene trampa activa con corona rota
  if (!room9 || !room9.trap || !room9.trap.active) {
    db.updateRoomTrap(9, { type: 'cold', active: true, item_needed: 'corona rota', disarm_msg: '👑 El frío cede.' });
    console.log('[TEST] Trampa sala 9 activada.');
  }

  // Verificar sala 6 exits (debería tener norte → sala 9)
  console.log(`[TEST] Sala 6 exits: ${JSON.stringify(room6 && room6.exits)}`);

  // Ejecutar el comando problemático: desactivar trampa norte
  // El jugador tiene hongo azul (para sala 6) pero NO corona rota (para sala 9)
  const result = engine.execute(pid, 'desactivar trampa norte');
  console.log('\n[RESULTADO de "desactivar trampa norte" desde sala 6 con hongo azul]:');
  console.log(result.text);

  // Verificaciones post-comando
  const playerAfter = db.getPlayer(pid);
  const invRaw = playerAfter.inventory;
  const invAfter = Array.isArray(invRaw) ? invRaw : (typeof invRaw === 'string' ? JSON.parse(invRaw || '[]') : []);
  const room6After = db.getRoom(6);
  const room9After = db.getRoom(9);

  console.log('\n[VERIFICACIONES]:');
  const hongoPersiste = invAfter.some(i => i.toLowerCase() === 'hongo azul');
  console.log('Hongo azul en inventario:', hongoPersiste ? '✅ SÍ (correcto — no fue consumido para trampa que no era target)' : '❌ NO (BUG: fue consumido sin estar en la trampa del norte)');

  const trap6Still = room6After && room6After.trap && room6After.trap.active;
  console.log('Trampa sala 6 sigue activa:', trap6Still ? '✅ SÍ (correcto — no fue desactivada)' : '❌ NO (BUG: fue desactivada — esto es el DIS-2091)');

  const trap9Still = room9After && room9After.trap && room9After.trap.active;
  console.log('Trampa sala 9 sigue activa:', trap9Still ? '✅ SÍ (correcto — tampoco se pudo desactivar sin corona rota)' : 'Se desactivó (solo si el jugador tenía corona rota)');

  // El texto debería mencionar que no tiene corona rota, no desactivar trampa local
  const mentionaCoronaRota = result.text && result.text.toLowerCase().includes('corona rota');
  console.log('Respuesta menciona "corona rota":', mentionaCoronaRota ? '✅ SÍ (correcto)' : '❌ NO (debería mencionar el ítem faltante)');

  try { db.deletePlayer(pid); } catch(e) {}

  const passed = hongoPersiste && trap6Still && mentionaCoronaRota;
  console.log('\n[RESULTADO FINAL]:', passed ? '✅ TEST PASÓ — DIS-2091 fix funciona!' : '❌ TEST FALLÓ — bug persiste');
  process.exit(passed ? 0 : 1);
}

runTest().catch(err => { console.error(err); process.exit(1); });
