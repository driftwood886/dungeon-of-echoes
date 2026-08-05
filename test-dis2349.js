/**
 * Test DIS-2349: carta sellada → carta leída
 * Verifica que al abrir la carta sellada, se reemplaza por 'carta leída'
 * y que la carta leída es consultable via examine y lore
 */

'use strict';

const db = require('./server/db/db.js');
const { execute } = require('./server/game/engine.js');

async function main() {
  await db.init();

  let passed = 0;
  let failed = 0;

  function assert(cond, msg) {
    if (cond) {
      console.log(`  ✅ ${msg}`);
      passed++;
    } else {
      console.log(`  ❌ FAIL: ${msg}`);
      failed++;
    }
  }

  // Setup: crear jugador de prueba
  const testName = 'TestDIS2349_' + Date.now();
  let player = db.createPlayer(testName);
  // Darle nivel suficiente para no estar en tutorial
  db.updatePlayer(player.id, {
    tutorial_step: 99,
    level: 3,
    xp: 300,
    gold: 50,
    inventory: ['carta sellada'],
    current_room_id: 1,
  });
  player = db.getPlayer(player.id);

  console.log('\n=== TEST DIS-2349: carta sellada → carta leída ===\n');

  // Test 1: Usar carta sellada → se convierte en carta leída
  console.log('Test 1: use carta sellada → carta leída');
  {
    const result = execute(player.id, 'use carta sellada', {});
    const freshP = db.getPlayer(player.id);
    const tieneSellada = (freshP.inventory || []).some(i => i.toLowerCase().includes('carta sellada'));
    const tieneLeida = (freshP.inventory || []).some(i => i.toLowerCase().includes('carta leída') || i.toLowerCase().includes('carta leida'));
    const resultText = result.text || result.result || '';

    assert(!tieneSellada, 'La carta sellada ya no está en el inventario');
    assert(tieneLeida, 'La carta leída aparece en el inventario');
    assert(
      resultText.includes('sello de cera negra') || resultText.includes('carta sellada') || resultText.includes('carta leída') || resultText.includes('rompés el sello'),
      'El resultado incluye texto de apertura de la carta'
    );
    console.log('  Texto resultado (primeros 100 chars):', resultText.slice(0, 100));
  }

  player = db.getPlayer(player.id);

  // Test 2: examine carta leída
  console.log('\nTest 2: examine carta leída → muestra contenido');
  {
    const result = execute(player.id, 'examine carta leída', {});
    const resultText = result.text || result.result || '';

    assert(
      resultText.includes('Kaelthas') || resultText.includes('dos llaves cruzadas') || resultText.includes('Trono del Vacío') || resultText.includes('sello'),
      'examine muestra contenido narrativo de la carta'
    );
    console.log('  Texto resultado (primeros 150 chars):', resultText.slice(0, 150));
  }

  // Test 3: lore carta leída → descripción del catálogo
  console.log('\nTest 3: lore carta leída → muestra descripción del catálogo');
  {
    const result = execute(player.id, 'lore carta leida', {});
    const resultText = result.text || result.result || '';

    assert(
      resultText.includes('CARTA LEÍDA') || resultText.includes('carta leída') || resultText.includes('carta leida') || resultText.includes('Prisión Subterránea'),
      'lore muestra entrada del catálogo'
    );
    assert(!resultText.toLowerCase().includes('no hay información'), 'lore no dice "no hay información"');
    console.log('  Texto resultado (primeros 200 chars):', resultText.slice(0, 200));
  }

  // Test 4: inventario — carta leída no se puede vender
  console.log('\nTest 4: NO se puede vender la carta leída');
  {
    // Mover jugador a sala 4 (tienda de Aldric) y probar vender
    db.updatePlayer(player.id, { current_room_id: 4 });
    const result = execute(player.id, 'sell carta leída', {});
    const resultText = result.text || result.result || '';
    const freshP = db.getPlayer(player.id);
    const tieneLeida = (freshP.inventory || []).some(i => i.toLowerCase().includes('carta leída') || i.toLowerCase().includes('carta leida'));

    assert(tieneLeida, 'La carta leída sigue en el inventario después de intentar venderla');
    console.log('  Texto resultado (primeros 150 chars):', resultText.slice(0, 150));
  }

  // Cleanup
  db.deletePlayer(player.id);

  console.log(`\n=== RESULTADOS: ${passed} PASS / ${failed} FAIL ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
