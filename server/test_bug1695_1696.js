'use strict';
/**
 * test_bug1695_1696.js — Test BUG-1695 (buy inv full) + BUG-1696 (sello expedition pickup on buy)
 */

const db = require('./db/db.js');
const engine = require('./game/engine.js');
const expeditionEngine = require('./game/expedition_engine.js');

async function run() {
  await db.init();
  console.log('\n=== TEST BUG-1695 + BUG-1696 ===\n');

  let allPass = true;
  function assert(cond, msg) {
    if (!cond) { console.log('❌ FAIL:', msg); allPass = false; }
    else        { console.log('✅', msg); }
  }

  // Crear jugador de test
  let p = db.createPlayer('bug1695_1696_tester');
  db.updatePlayer(p.id, {
    current_room_id: 4,  // sala del mercader
    gold: 500,
    level: 3,
    hp: 30, max_hp: 30
  });

  // ── BUG-1695: inventario lleno → buy debe rechazar ──────────────────────────
  const fakeInv = Array.from({ length: 20 }, (_, i) => `objeto_${i}`); // 20 = INV_BASE_SLOTS
  db.updatePlayer(p.id, { inventory: fakeInv });
  p = db.getPlayer(p.id);

  const buyFullResult = engine.execute(p.id, 'comprar poción de salud');
  const buyFullText = buyFullResult.text || '';
  assert(
    buyFullText.includes('lleno') || buyFullText.includes('Inventario'),
    'BUG-1695: buy rechaza compra con inventario lleno'
  );
  // Verificar que el inventario NO creció
  p = db.getPlayer(p.id);
  assert(p.inventory.length === 20, `BUG-1695: inventario se mantiene en 20 (actual: ${p.inventory.length})`);

  // ── BUG-1696: expedición sello_carcelero avanza al comprar sello ─────────────
  db.updatePlayer(p.id, { inventory: [], gold: 500 });
  db.raw().run('DELETE FROM expeditions WHERE player_id = ?', [p.id]);

  const assigned = db.assignExpeditionToDB(p.id, 'sello_carcelero');
  const activeExp = db.getActiveExpedition(p.id);
  assert(activeExp && activeExp.expedition_id === 'sello_carcelero', 'BUG-1696: expedición sello_carcelero asignada');

  // Refrescar player
  p = db.getPlayer(p.id);
  const buySelResult = engine.execute(p.id, 'comprar sello del carcelero');
  const buySelText = buySelResult.text || '';
  assert(
    buySelText.toLowerCase().includes('sello') && buySelText.includes('Conseguiste'),
    'BUG-1696: comprar sello del carcelero avanza expedición (mensaje "Conseguiste")'
  );

  // Verificar que el paso de la expedición avanzó a 2
  const expRow = db.getActiveExpedition(p.id);
  console.log('  expRow:', expRow);
  assert(expRow && expRow.step === 2, `BUG-1696: expedición avanzó al paso 2 (actual: ${expRow ? expRow.step : 'none'})`);

  // Limpiar
  db.deletePlayer(p.id);
  db.raw().run('DELETE FROM expeditions WHERE player_id = ?', [p.id]);

  console.log('\n' + (allPass ? '=== TODOS LOS TESTS PASARON ✅ ===' : '=== ALGUNOS TESTS FALLARON ❌ ===') + '\n');
  db.persist();
  process.exit(allPass ? 0 : 1);
}

run().catch(err => { console.error('Error:', err); process.exit(1); });
