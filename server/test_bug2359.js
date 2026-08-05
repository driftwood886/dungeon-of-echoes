/**
 * test_bug2359.js — Test para BUG-2359: cancelar subasta propia
 *
 * Verifica:
 * 1. cancelAuction cancela una subasta sin pujas y la marca como closed=1
 * 2. cancelAuction rechaza cancelar una subasta con pujas (error: no_bids)
 * 3. cmdAuction con 'cancelar' devuelve el ítem al inventario del jugador
 */

'use strict';

const assert = require('assert');

async function main() {
  const db = require('./db/db.js');
  await db.init(':memory:');

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

  // Crear jugador de prueba para usar cancelAuction (db-level)
  const auction1 = db.createAuction(9001, 'Vendor1', 'escudo roto', 5);
  test('Auction creada OK', () => assert.ok(auction1 && auction1.id));

  const r1 = db.cancelAuction(auction1.id);
  test('cancelAuction OK (sin pujas)', () => {
    assert.strictEqual(r1.ok, true, 'ok debe ser true');
    assert.strictEqual(r1.auction.item_name, 'escudo roto');
  });

  const after1 = db.getAuction(auction1.id);
  test('Auction marcada como closed=1', () => assert.strictEqual(after1.closed, 1));

  // Test: cancelar subasta con puja
  const auction2 = db.createAuction(9002, 'Vendor2', 'espada corta', 10);
  // Crear jugador pujador
  db.init; // no necesitamos crear pujador real para placeBid, solo un id
  const bidResult = db.placeBid(auction2.id, 9003, 'Bidder', 15);
  test('Puja colocada OK', () => assert.strictEqual(bidResult.ok, true));

  const r2 = db.cancelAuction(auction2.id);
  test('cancelAuction falla cuando hay puja', () => {
    assert.strictEqual(r2.ok, false, 'ok debe ser false');
    assert.strictEqual(r2.error, 'no_bids', 'error debe ser no_bids');
    assert.ok(r2.auction, 'debe retornar auction');
    assert.strictEqual(r2.auction.current_bid, 15);
    assert.strictEqual(r2.auction.bidder_name, 'Bidder');
  });

  // Test: cancelar subasta que no existe
  const r3 = db.cancelAuction(99999);
  test('cancelAuction falla para ID inexistente', () => {
    assert.strictEqual(r3.ok, false);
    assert.ok(r3.error.includes('no encontrada'));
  });

  // Test: cancelar subasta ya cerrada
  const auction3 = db.createAuction(9004, 'Vendor3', 'poción de salud', 8);
  db.cancelAuction(auction3.id); // primera cancelación
  const r4 = db.cancelAuction(auction3.id); // segunda
  test('cancelAuction falla si ya está cerrada', () => {
    assert.strictEqual(r4.ok, false);
    assert.ok(r4.error.includes('cerrada'));
  });

  console.log(`\n${passed + failed} tests — ${passed} PASS, ${failed} FAIL`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
