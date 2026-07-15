'use strict';
// DIS-1619 Test: Verificar que el 2do intento de "faccion elegir" (sin confirmar)
// muestra solo el CTA corto en vez de repetir la tarjeta larga
const db = require('./db/db.js');
const engine = require('./game/engine.js');

async function runTest() {
  await db.init();
  console.log('\n=== TEST DIS-1619: faccion elegir — CTA corto en 2do intento ===\n');

  const ids = db.getAllPlayerIds();
  if (!ids || ids.length === 0) { console.log('No players'); process.exit(1); }
  const playerId = ids[0].id;

  // Setup: jugador nivel 3, sin facción, sin faction_pending
  const rawSE = db.getPlayer(playerId).status_effects;
  const se = (rawSE && typeof rawSE === 'string' && rawSE.startsWith('{')) ? JSON.parse(rawSE) : {};
  delete se.faction_pending;
  db.updatePlayer(playerId, { level: 3, faction: null, status_effects: JSON.stringify(se) });

  // 1er intento: sin confirmar → debe mostrar tarjeta completa + CTA
  console.log('--- Test 1: primer intento — debe mostrar tarjeta ---');
  const r1 = engine.execute(playerId, 'faccion elegir orden_filo');
  const hasCard = r1.text.includes('╔');
  const hasCTA = r1.text.includes('faccion elegir orden_filo confirmar');
  const hasWarning = r1.text.includes('NO te uniste');
  console.log('  tarjeta:', hasCard ? 'OK' : 'FAIL');
  console.log('  CTA:', hasCTA ? 'OK' : 'FAIL');
  console.log('  warning:', hasWarning ? 'OK' : 'FAIL');
  console.assert(hasCard, 'FAIL: No muestra tarjeta en 1er intento');
  console.assert(hasCTA, 'FAIL: No muestra CTA en 1er intento');
  console.assert(hasWarning, 'FAIL: No muestra warning en 1er intento');

  // 2do intento: sin confirmar → debe mostrar SOLO CTA (sin tarjeta larga)
  console.log('\n--- Test 2: segundo intento — debe mostrar solo CTA corto ---');
  const r2 = engine.execute(playerId, 'faccion elegir orden_filo');
  const noCard = !r2.text.includes('╔');
  const hasCTA2 = r2.text.includes('faccion elegir orden_filo confirmar');
  const hasWarning2 = r2.text.includes('NO te uniste');
  console.log('  sin tarjeta:', noCard ? 'OK' : 'FAIL');
  console.log('  CTA:', hasCTA2 ? 'OK' : 'FAIL');
  console.log('  warning corto:', hasWarning2 ? 'OK' : 'FAIL');
  console.assert(noCard, 'FAIL: Repite tarjeta en 2do intento (no debería)');
  console.assert(hasCTA2, 'FAIL: No muestra CTA en 2do intento');
  console.assert(hasWarning2, 'FAIL: No muestra warning en 2do intento');

  console.log('\n--- Output del 2do intento ---');
  console.log(r2.text);

  // 3er intento: con confirmar → debe unir a la facción
  console.log('\n--- Test 3: confirmar → debe unirse a la facción ---');
  const r3 = engine.execute(playerId, 'faccion elegir orden_filo confirmar');
  const joined = r3.text.includes('Orden del Filo') && (r3.text.includes('miembro') || r3.text.includes('Bienvenido'));
  console.log('  unido:', joined ? 'OK' : 'FAIL');
  console.assert(joined, 'FAIL: No se unió a la facción con confirmar');

  // Restaurar jugador
  db.updatePlayer(playerId, { level: 1, faction: null });
  console.log('\n✅ Tests DIS-1619 completados\n');
}

runTest().catch(e => { console.error(e); process.exit(1); });
