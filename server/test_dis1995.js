/**
 * test_dis1995.js — DIS-1995: Comprar bolsa de lona con inventario lleno aplica efecto directamente.
 *
 * Verifica:
 * 1. Con inventario lleno (20/20), comprar bolsa de lona NO falla — la aplica directo.
 * 2. inventory_bonus aumenta en 4 (de 0 a 4).
 * 3. El inventario no crece (la bolsa no entra al inventario).
 * 4. El oro se descuenta correctamente.
 * 5. Con 2 bolsas ya aplicadas (inventory_bonus=8), comprar una 3ra falla con el mensaje de máximo.
 */

const db = require('./db/db');
const engine = require('./game/engine');

async function main() {
  await db.init();

  let passed = 0;
  let failed = 0;

  function assert(label, condition, extra) {
    if (condition) {
      console.log(`  ✅ ${label}`);
      passed++;
    } else {
      console.error(`  ❌ FALLA: ${label}${extra ? ' — ' + extra : ''}`);
      failed++;
    }
  }

  // --- Test 1: inventario lleno, comprar bolsa aplica directamente ---
  console.log('\n[1] Compra directa con inventario lleno');
  {
    let p = db.getPlayerByUsername('__test_dis1995a__');
    if (!p) p = db.createPlayer('__test_dis1995a__');
    db.updatePlayer(p.id, {
      gold: 100,
      inventory: Array(24).fill('poción de salud'),
      inventory_bonus: 0,
      current_room_id: 4, // sala de Aldric
      level: 3
    });

    const result = engine.execute(p.id, 'comprar bolsa de lona');
    const pAfter = db.getPlayerByUsername('__test_dis1995a__');

    assert('Mensaje no es "inventario lleno" genérico', !result.text.includes('Vendé algo, usá el vault'));
    assert('Mensaje confirma compra exitosa', result.text.includes('Compraste: bolsa de lona'));
    assert('inventory_bonus aumentó a 4', pAfter.inventory_bonus === 4, `actual: ${pAfter.inventory_bonus}`);
    assert('inventario NO creció (bolsa no entró)', pAfter.inventory.length === 24, `actual: ${pAfter.inventory.length}`);
    assert('Oro descontado en 20', pAfter.gold === 80, `actual: ${pAfter.gold}`);

    db.deletePlayer(p.id);
  }

  // --- Test 2: inventario lleno, ya tiene 2 bolsas (max) → debe rechazar ---
  console.log('\n[2] Intento con max bolsas ya aplicadas');
  {
    let p = db.getPlayerByUsername('__test_dis1995b__');
    if (!p) p = db.createPlayer('__test_dis1995b__');
    db.updatePlayer(p.id, {
      gold: 100,
      inventory: Array(32).fill('poción de salud'),
      inventory_bonus: 8, // ya tiene 2 bolsas
      current_room_id: 4,
      level: 3
    });

    const result = engine.execute(p.id, 'comprar bolsa de lona');
    assert('Rechaza con mensaje de máximo bolsas', result.text.includes('máximo de bolsas adicionales'));

    db.deletePlayer(p.id);
  }

  // --- Test 3: inventario CON espacio, compra normal (bolsa pasa por inventario) ---
  console.log('\n[3] Compra normal (hay espacio en inventario)');
  {
    let p = db.getPlayerByUsername('__test_dis1995c__');
    if (!p) p = db.createPlayer('__test_dis1995c__');
    db.updatePlayer(p.id, {
      gold: 100,
      inventory: Array(5).fill('poción de salud'), // espacio libre
      inventory_bonus: 0,
      current_room_id: 4,
      level: 3
    });

    const result = engine.execute(p.id, 'comprar bolsa de lona');
    const pAfter = db.getPlayerByUsername('__test_dis1995c__');

    // En compra normal, la bolsa entra al inventario (hay que usarla)
    assert('Compra normal exitosa', result.text.includes('Compraste: bolsa de lona'));
    assert('Bolsa en inventario (no auto-aplicada)', pAfter.inventory.includes('bolsa de lona'));

    db.deletePlayer(p.id);
  }

  console.log(`\n=== ${passed} pasaron, ${failed} fallaron ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
