/**
 * Test BUG-2055: `examine carta sellada` muestra hint narrativo antes de abrir carta.
 * También verifica `examine trono` en sala 9 con carta sellada en inventario.
 */
'use strict';

const db = require('./db/db.js');
const engine = require('./game/engine.js');

async function runTest() {
  await db.init();

  const username = 'BugBot2055_' + Date.now();
  let player = db.createPlayer(username);
  const pid = player.id;
  console.log(`[TEST] Jugador: ${player.username} (id=${pid})`);

  // Jugador con carta sellada sin abrir
  db.updatePlayer(pid, {
    level: 5,
    attack: 12,
    hp: 80, max_hp: 80,
    player_class: 'guerrero',
    current_room_id: 8, // sala 8 (Prisión) donde se encuentra la carta
    inventory: JSON.stringify(['carta sellada']),
    aldric_quest: 'none',
    // sin carta_sellada_leida en status_effects
  });

  player = db.getPlayer(pid);
  console.log(`\n--- Escenario 1: examine carta sellada (sala 8, carta NO abierta) ---`);
  const result1 = engine.execute(pid, 'examine carta sellada');
  console.log(result1.text);
  
  const hasMirarAbajo1 = result1.text.includes('mirar abajo');
  const hasMencionaba1 = result1.text.includes('mencionaba');
  if (hasMirarAbajo1 || hasMencionaba1) {
    console.log('\n[TEST] ❌ BUG CONFIRMADO: examine carta sellada muestra hint de contenido ANTES de abrir carta');
    console.log(`  "mirar abajo": ${hasMirarAbajo1}, "mencionaba": ${hasMencionaba1}`);
  } else {
    console.log('\n[TEST] ✅ examine carta sellada — no muestra hint de contenido. OK.');
  }

  // Ahora mover a sala 9 (Sala del Trono) y hacer examine trono con carta sellada
  db.updatePlayer(pid, { current_room_id: 9 });
  player = db.getPlayer(pid);
  console.log(`\n--- Escenario 2: examine trono (sala 9, carta SELLADA sin abrir) ---`);
  const result2 = engine.execute(pid, 'examine trono');
  console.log(result2.text);

  const hasMirarAbajo2 = result2.text.includes('mirar abajo');
  const hasMencionaba2 = result2.text.includes('mencionaba');
  if (hasMirarAbajo2 || hasMencionaba2) {
    console.log('\n[TEST] ❌ BUG EN examine trono: muestra "mencionaba/mirar abajo" aunque carta está sellada');
  } else {
    console.log('\n[TEST] ✅ examine trono con carta sellada — no revela contenido de la carta. OK.');
  }

  // Cleanup
  db.deletePlayer(pid);
  process.exit(0);
}

runTest().catch(e => {
  console.error('[TEST] Error:', e);
  process.exit(1);
});
