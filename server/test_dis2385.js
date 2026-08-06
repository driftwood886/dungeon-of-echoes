/**
 * test_dis2385.js — Advertencia hongo azul + trampa sala 6
 *
 * Scenarios:
 * 1. Jugador recoge hongo azul con trampa sala 6 activa → debe ver advertencia ⚠️
 * 2. Jugador ya tiene 2 hongos azules → no aparece advertencia (sobra uno)
 * 3. Trampa sala 6 INACTIVA → no aparece advertencia aunque tenga 1 hongo
 */

'use strict';

const assert = require('assert');

async function main() {
  const db = require('./db/db.js');
  await db.init(':memory:');

  const { execute } = require('./game/engine.js');

  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (e) {
      console.error(`  ✗ ${name}: ${e.message}`);
      failed++;
    }
  }

  // Helper: crear jugador en sala 5 sin hongo azul
  function mkPlayer(extra = {}) {
    let p = db.getPlayerByUsername('TestDIS2385');
    if (!p) p = db.createPlayer('TestDIS2385');
    db.updatePlayer(p.id, {
      current_room_id: 5,
      inventory: JSON.stringify([]),
      status_effects: JSON.stringify({}),
      hp: 30, max_hp: 30, level: 3,
      equipped_weapon: 'espada de hierro',
      equipped_armor: 'cuero endurecido',
      player_class: 'guerrero',
      ...extra,
    });
    return db.getPlayer(p.id);
  }

  // Helper: asegurar hongo azul en sala 5
  function addHongoToRoom5() {
    const r5 = db.getRoom(5);
    const f = r5.floor_items || [];
    if (!f.some(i => i.toLowerCase().includes('hongo azul'))) {
      db.updateRoomItems(5, [...f, 'hongo azul']);
    }
  }

  // Helper: setear trampa sala 6 activa/inactiva
  function setTrap6(active) {
    const r6 = db.getRoom(6);
    const trap = { ...(r6.trap || { name: 'Trampa de Esporas', item_needed: 'hongo azul', dmg: 5, dmgRange: '3-7' }), active };
    db.updateRoomTrap(6, trap);
  }

  // ───────────────────────────────────────────────────────────────
  // Scenario 1: Trampa activa + jugador sin hongo → advertencia
  // ───────────────────────────────────────────────────────────────
  setTrap6(true);
  addHongoToRoom5();
  const p1 = mkPlayer();

  test('Trampa activa + 1er hongo: advertencia ⚠️ aparece en mensaje de pickup', () => {
    const result = execute(p1.id, 'pick hongo azul');
    const text = result.text || '';
    assert.ok(
      text.includes('⚠️') && text.toLowerCase().includes('trampa'),
      `Se esperaba advertencia de trampa, got: "${text.substring(0, 400)}"`
    );
  });

  // ───────────────────────────────────────────────────────────────
  // Scenario 2: Trampa activa + jugador ya tiene 1 hongo → al recoger 2do, no advierte
  // ───────────────────────────────────────────────────────────────
  setTrap6(true);
  addHongoToRoom5();
  const p2 = mkPlayer({ inventory: JSON.stringify(['hongo azul']) });

  test('Trampa activa + ya tiene 1 hongo: al recoger 2do no aparece advertencia de trampa', () => {
    const result = execute(p2.id, 'pick hongo azul');
    const text = result.text || '';
    // El mensaje puede tener craft hint, pero no la advertencia de trampa
    assert.ok(
      !text.includes('Si lo crafteás, perderás el ítem necesario para desactivarla'),
      `No debería advertir con 2 hongos, got: "${text.substring(0, 400)}"`
    );
  });

  // ───────────────────────────────────────────────────────────────
  // Scenario 3: Trampa INACTIVA → no aparece advertencia
  // ───────────────────────────────────────────────────────────────
  setTrap6(false);
  addHongoToRoom5();
  const p3 = mkPlayer();

  test('Trampa sala 6 INACTIVA: no aparece advertencia al recoger hongo azul', () => {
    const result = execute(p3.id, 'pick hongo azul');
    const text = result.text || '';
    assert.ok(
      !text.includes('trampa de esporas del Túnel'),
      `No debería advertir con trampa inactiva, got: "${text.substring(0, 400)}"`
    );
  });

  // ─── Resultado ──────────────────────────────────────────────────
  console.log(`\nResultados: ${passed} pasaron, ${failed} fallaron\n`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
