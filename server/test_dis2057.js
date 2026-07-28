// test_dis2057.js — Test para DIS-2057: Auto-equip al comprar en tienda con slot vacío
'use strict';

const db = require('./db/db.js');
const engine = require('./game/engine.js');

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ ${msg}`);
    failed++;
  }
}

const MERCHANT_ROOM_ID = 4;

async function runTest() {
  await db.init();

  // ── Test 1: Comprar arma sin arma equipada → auto-equip ───────────────────
  console.log('\n[TEST 1] Comprar arma sin arma equipada → auto-equip automático');
  {
    const name1 = 'AutoEquip1_' + Date.now();
    let p = db.createPlayer(name1);
    const pid = p.id;
    db.updatePlayer(pid, {
      current_room_id: MERCHANT_ROOM_ID,
      gold: 500,
      equipped_weapon: null,
      equipped_armor: null,
      inventory: JSON.stringify([]),
    });
    p = db.getPlayer(pid);
    assert(!p.equipped_weapon || p.equipped_weapon === 'null', 'Sin arma equipada al inicio');

    const result = engine.execute(pid, 'comprar daga básica');
    assert(result.text, 'Resultado tiene texto');
    console.log('  Output:', result.text.substring(0, 200) + (result.text.length > 200 ? '...' : ''));

    const afterBuy = db.getPlayer(pid);
    assert(
      afterBuy.equipped_weapon && afterBuy.equipped_weapon !== 'null',
      `Arma equipada automáticamente → "${afterBuy.equipped_weapon}"`
    );
    assert(
      result.text.toLowerCase().includes('automáticamente') || result.text.toLowerCase().includes('equipada'),
      'Output menciona equipamiento automático'
    );
    // El ítem NO debe estar en inventario (está equipado)
    const inv1 = Array.isArray(afterBuy.inventory) ? afterBuy.inventory : JSON.parse(afterBuy.inventory || '[]');
    assert(
      !inv1.some(i => i && i.toLowerCase().includes('daga')),
      'Daga no está duplicada en inventario (está equipada, no en inv)'
    );
  }

  // ── Test 2: Comprar armadura sin armadura equipada → auto-equip ───────────
  console.log('\n[TEST 2] Comprar armadura sin armadura equipada → auto-equip automático');
  {
    const name2 = 'AutoEquip2_' + Date.now();
    let p = db.createPlayer(name2);
    const pid = p.id;
    db.updatePlayer(pid, {
      current_room_id: MERCHANT_ROOM_ID,
      gold: 500,
      equipped_weapon: 'daga básica',
      equipped_armor: null,
      inventory: JSON.stringify([]),
    });
    p = db.getPlayer(pid);
    assert(!p.equipped_armor || p.equipped_armor === 'null', 'Sin armadura equipada al inicio');

    const result = engine.execute(pid, 'comprar cuero endurecido');
    assert(result.text, 'Resultado tiene texto');

    const afterBuy = db.getPlayer(pid);
    assert(
      afterBuy.equipped_armor && afterBuy.equipped_armor !== 'null',
      `Armadura equipada automáticamente → "${afterBuy.equipped_armor}"`
    );
  }

  // ── Test 3: Comprar arma CON arma ya equipada → no reemplaza ──────────────
  console.log('\n[TEST 3] Comprar arma con arma ya equipada → solo hint, no reemplaza');
  {
    const name3 = 'AutoEquip3_' + Date.now();
    let p = db.createPlayer(name3);
    const pid = p.id;
    db.updatePlayer(pid, {
      current_room_id: MERCHANT_ROOM_ID,
      gold: 500,
      equipped_weapon: 'daga básica',
      inventory: JSON.stringify([]),
    });
    p = db.getPlayer(pid);
    assert(p.equipped_weapon && p.equipped_weapon !== 'null', 'Tiene arma equipada al inicio');

    // Comprar espada de hierro (existe en catálogo) con daga básica ya equipada
    const result = engine.execute(pid, 'comprar espada de hierro');
    assert(result.text, 'Resultado tiene texto');
    console.log('  Output (primeras 200 chars):', result.text.substring(0, 200));

    const afterBuy = db.getPlayer(pid);
    assert(
      afterBuy.equipped_weapon === 'daga básica',
      `Arma anterior conservada (no reemplazada): "${afterBuy.equipped_weapon}"`
    );
    const hasEquipHint = result.text.includes('equipar') || result.text.includes('Mejora') || result.text.includes('💡');
    assert(hasEquipHint, 'Output muestra hint para equipar manualmente');
  }

  // ── Test 4: Comprar poción → sin autoequip ──────────────────────────────
  console.log('\n[TEST 4] Comprar poción → sin auto-equip ni cambio de equipo');
  {
    const name4 = 'AutoEquip4_' + Date.now();
    let p = db.createPlayer(name4);
    const pid = p.id;
    db.updatePlayer(pid, {
      current_room_id: MERCHANT_ROOM_ID,
      gold: 500,
      equipped_weapon: null,
      inventory: JSON.stringify([]),
    });
    p = db.getPlayer(pid);

    const result = engine.execute(pid, 'comprar poción de salud');
    assert(result.text, 'Resultado tiene texto');

    const afterBuy = db.getPlayer(pid);
    assert(
      !afterBuy.equipped_weapon || afterBuy.equipped_weapon === 'null',
      'Poción no provoca cambio en equipped_weapon'
    );
  }

  // ── Resultado final ────────────────────────────────────────────────────────
  console.log(`\n════════════════════════════════════`);
  console.log(`Resultado: ${passed} pasados, ${failed} fallados`);
  if (failed === 0) {
    console.log('🎉 Todos los tests pasaron — DIS-2057 implementado correctamente.');
    process.exit(0);
  } else {
    console.log('❌ Hay fallos — revisar implementación.');
    process.exit(1);
  }
}

runTest().catch(e => { console.error(e); process.exit(1); });
