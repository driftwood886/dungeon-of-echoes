/**
 * test_bug2351.js — BUG-2351: la tienda no debe mostrar el pitch de bolsa de lona
 * si el jugador ya tiene una sin usar en el inventario.
 *
 * Casos:
 *   1. Jugador sin bolsa en inv y sin inventory_bonus → DEBE mostrar pitch
 *   2. Jugador con bolsa en inv y sin inventory_bonus → NO debe mostrar pitch
 *   3. Jugador sin bolsa en inv pero con inventory_bonus > 0 → NO debe mostrar pitch (ya la usó)
 */
'use strict';
const db = require('./db/db.js');
const engine = require('./game/engine.js');

async function main() {
  await db.init();

  let passed = 0;
  let failed = 0;
  const pids = [];

  function mkPlayer(inv, inventoryBonus) {
    const username = `BugBot2351_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const p = db.createPlayer(username);
    db.updatePlayer(p.id, {
      current_room_id: 4, // sala de Aldric
      hp: 30, max_hp: 30,
      attack: 5, defense: 2,
      gold: 50,
      inventory: JSON.stringify(inv),
      equipped_weapon: null, equipped_armor: null,
      level: 1, xp: 0,
      aldric_rep: 0,
      inventory_bonus: inventoryBonus,
      player_class: 'guerrero',
      reputation: 0,
      status_effects: JSON.stringify({}),
    });
    pids.push(p.id);
    return p.id;
  }

  // Caso 1: sin bolsa → pitch debe aparecer
  {
    const pid = mkPlayer([], 0);
    const result = engine.execute(pid, 'tienda');
    const hasPitch = result.text.includes('Primera vez por aquí') && result.text.includes('bolsa de lona (20g');
    if (hasPitch) {
      console.log('✅ Caso 1 PASS: sin bolsa en inv → pitch aparece');
      passed++;
    } else {
      console.error(`❌ Caso 1 FAIL: pitch debería aparecer. Fragmento: ${result.text.slice(0, 400)}`);
      failed++;
    }
  }

  // Caso 2: bolsa de lona sin usar en inventario → pitch suprimido
  {
    const pid = mkPlayer(['bolsa de lona'], 0);
    const result = engine.execute(pid, 'tienda');
    const hasPitch = result.text.includes('Primera vez por aquí') && result.text.includes('bolsa de lona (20g');
    if (!hasPitch) {
      console.log('✅ Caso 2 PASS: bolsa ya en inventario → pitch suprimido');
      passed++;
    } else {
      console.error(`❌ Caso 2 FAIL: pitch NO debería aparecer. Fragmento: ${result.text.slice(0, 400)}`);
      failed++;
    }
  }

  // Caso 3: inventory_bonus > 0 (ya la usó) → pitch suprimido
  {
    const pid = mkPlayer([], 4);
    const result = engine.execute(pid, 'tienda');
    const hasPitch = result.text.includes('Primera vez por aquí') && result.text.includes('bolsa de lona (20g');
    if (!hasPitch) {
      console.log('✅ Caso 3 PASS: inventory_bonus > 0 → pitch suprimido');
      passed++;
    } else {
      console.error(`❌ Caso 3 FAIL: pitch NO debería aparecer. Fragmento: ${result.text.slice(0, 400)}`);
      failed++;
    }
  }

  // Cleanup
  for (const pid of pids) {
    try { db.deletePlayer(pid); } catch (_) {}
  }

  console.log(`\n${passed}/${passed + failed} tests PASS.`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
