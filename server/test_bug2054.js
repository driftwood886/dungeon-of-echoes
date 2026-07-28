/**
 * Test BUG-2054: `desactivar trampa oeste` desde sala 2 devuelve
 * "No hay trampa activa hacia el oeste (Sala de los Ecos)" en lugar de
 * reconocer la trampa de esporas del Túnel de los Hongos (sala 6).
 *
 * La sala 2 tiene exits: { south: 1, north: 3, west: 6 }
 * Sala 6 = Túnel de los Hongos.
 * Cuando hay trampa activa en sala 6, `desactivar trampa oeste` debería
 * encontrar sala 6 al ir hacia el oeste, NO sala 3 (Sala de los Ecos).
 */

'use strict';

const db = require('./db/db.js');
const engine = require('./game/engine.js');

async function runTest() {
  await db.init();

  const username = 'BugBot2054_' + Date.now();
  let player = db.createPlayer(username);
  const pid = player.id;
  console.log(`[TEST] Jugador: ${player.username} (id=${pid})`);

  // Llevar al jugador a sala 2
  db.updatePlayer(pid, {
    level: 3,
    attack: 10,
    hp: 80,
    max_hp: 80,
    player_class: 'guerrero',
    current_room_id: 2,
    inventory: JSON.stringify(['hongo azul']),
  });

  // Verificar sala 2 exits
  const room2 = db.getRoom(2);
  console.log(`[TEST] Sala 2: ${room2.name}`);
  console.log(`[TEST] Sala 2 exits: ${JSON.stringify(room2.exits)}`);
  const westExitId = typeof room2.exits.west === 'number' ? room2.exits.west : room2.exits.west?.room_id;
  console.log(`[TEST] Exit west desde sala 2 → id=${westExitId}`);

  const room6 = db.getRoom(6);
  console.log(`[TEST] Sala 6: ${room6.name}`);
  console.log(`[TEST] Sala 6 trap antes: ${JSON.stringify(room6.trap)}`);

  // Activar trampa en sala 6 si no está activa
  if (!room6.trap || !room6.trap.active) {
    const trap6 = {
      type: 'poison',
      damage: 10,
      active: true,
      item_needed: 'hongo azul',
    };
    db.updateRoomTrap(room6.id, trap6);
    console.log(`[TEST] Trampa activada en sala 6.`);
  }

  const room6After = db.getRoom(6);
  console.log(`[TEST] Sala 6 trap después: ${JSON.stringify(room6After.trap)}`);

  // Ejecutar el comando problemático
  player = db.getPlayer(pid);
  console.log(`[TEST] Jugador en sala: ${player.current_room_id}`);

  const result = engine.execute(pid, 'desactivar trampa oeste');
  console.log(`\n[TEST] Resultado de "desactivar trampa oeste":`);
  console.log(result.text);

  // Verificar
  if (result.text.includes('Sala de los Ecos')) {
    console.log('\n[TEST] ❌ BUG CONFIRMADO: muestra "Sala de los Ecos" en lugar de "Túnel de los Hongos"');
  } else if (result.text.includes('Túnel de los Hongos') || result.text.includes('Tunel de los Hongos') || result.text.includes('desactivás') || result.text.includes('inerte') || result.text.includes('hongo azul')) {
    console.log('\n[TEST] ✅ Funcionó correctamente — no hay bug (o ya fue corregido)');
  } else {
    console.log('\n[TEST] ⚠️  Resultado inesperado — revisar manualmente');
  }

  // Cleanup
  db.deletePlayer(pid);
  process.exit(0);
}

runTest().catch(e => {
  console.error('[TEST] Error:', e);
  process.exit(1);
});
