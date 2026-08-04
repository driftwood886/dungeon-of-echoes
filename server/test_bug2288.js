/**
 * Test BUG-2288: Segunda carta sellada no desaparece al completar quest.
 * Verifica que al tener 2 copias de carta sellada y completar la quest de Aldric,
 * solo se consume 1 copia — la segunda permanece en el inventario.
 */
'use strict';

const db = require('./db/db.js');
const engine = require('./game/engine.js');

async function main() {
  await db.init();

  const username = 'BugBot2288_' + Date.now();
  let player = db.createPlayer(username);
  const pid = player.id;
  console.log(`[TEST] Jugador: ${player.username} (id=${pid})`);

  // Setup: jugador nivel 5+ con aldric_quest: active y DOS cartas selladas
  db.updatePlayer(pid, {
    level: 5,
    xp: 300,
    hp: 80, max_hp: 80,
    attack: 12,
    gold: 10,
    player_class: 'guerrero',
    current_room_id: 4, // sala 4 donde está Aldric
    aldric_quest: 'active',
    inventory: JSON.stringify(['carta sellada', 'carta sellada', 'poción de salud']),
    status_effects: JSON.stringify({}),
  });

  player = db.getPlayer(pid);
  const invBefore = Array.isArray(player.inventory) ? player.inventory : JSON.parse(player.inventory || '[]');
  console.log(`[TEST] Inventario inicial: ${JSON.stringify(invBefore)}`);
  console.log(`[TEST] aldric_quest inicial: ${player.aldric_quest}`);
  console.log('');

  // Completar quest hablando con Aldric
  console.log('--- Ejecutando: hablar aldric ---');
  const result = engine.execute(pid, 'hablar aldric');
  console.log(result.text.slice(0, 200) + '...\n');

  // Verificar resultado
  const afterPlayer = db.getPlayer(pid);
  const invAfter = Array.isArray(afterPlayer.inventory)
    ? afterPlayer.inventory
    : JSON.parse(afterPlayer.inventory || '[]');

  console.log(`[TEST] aldric_quest después: ${afterPlayer.aldric_quest}`);
  console.log(`[TEST] Inventario después: ${JSON.stringify(invAfter)}`);
  console.log('');

  const questDone = afterPlayer.aldric_quest === 'done';
  const cartasRestantes = invAfter.filter(i => i.toLowerCase().includes('carta sellada'));
  const potionOk = invAfter.some(i => i.toLowerCase().includes('poción'));

  let passed = true;

  if (!questDone) {
    console.error('❌ FAIL: aldric_quest no es "done"');
    passed = false;
  } else {
    console.log('✅ Quest completada correctamente');
  }

  if (cartasRestantes.length !== 1) {
    console.error(`❌ FAIL: Se esperaba 1 carta sellada en inventario, hay ${cartasRestantes.length}`);
    passed = false;
  } else {
    console.log('✅ Solo se consumió una copia de carta sellada — la segunda permanece');
  }

  if (!potionOk) {
    console.error('❌ FAIL: La poción de salud desapareció (daño colateral)');
    passed = false;
  } else {
    console.log('✅ Poción de salud intacta');
  }

  console.log('');
  console.log(passed ? '✅ TEST PASÓ' : '❌ TEST FALLÓ');

  process.exit(passed ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
