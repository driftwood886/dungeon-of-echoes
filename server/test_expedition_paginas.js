/**
 * Test end-to-end: expedición paginas_congeladas
 * EPIC-1164 — Verificación antes del commit
 */

'use strict';

const db = require('./db/db.js');
const exp = require('./game/expedition_engine.js');

// Usar el jugador de prueba del run anterior de tests de expediciones
const PLAYER_ID = '31003e85-5e72-44e6-8565-53a954ee21aa';

async function runTests() {
  await db.init();
  console.log('\n=== TEST E2E: Expedición paginas_congeladas ===\n');

  // 1. Limpiar expediciones previas
  const rawDb = db.raw();
  rawDb.run(`DELETE FROM expeditions WHERE player_id = '${PLAYER_ID}'`);
  console.log('✅ 1. Expediciones anteriores limpiadas.');

  // 2. Obtener jugador
  let player = db.getPlayer(PLAYER_ID);
  if (!player) {
    console.error('❌ Jugador no encontrado:', PLAYER_ID);
    process.exit(1);
  }

  // Asegurar nivel mínimo 2 y clase mago
  if ((player.level || 1) < 2) {
    db.updatePlayer(PLAYER_ID, { level: 2, xp: 50, player_class: 'mago' });
    player = db.getPlayer(PLAYER_ID);
  }
  console.log(`✅ 2. Jugador: ${player.username} (nivel ${player.level}, clase: ${player.player_class})`);

  // 3. Asignar expedición paginas_congeladas directamente
  db.assignExpeditionToDB(PLAYER_ID, 'paginas_congeladas');
  const active = db.getActiveExpedition(PLAYER_ID);
  if (!active || active.expedition_id !== 'paginas_congeladas') {
    console.error('❌ No se asignó la expedición:', active);
    process.exit(1);
  }
  console.log(`✅ 3. Expedición asignada: ${active.expedition_id}, paso: ${active.step}`);

  // 4. Simular PASO 1: pickup de páginas congeladas en sala 11
  const result1 = exp.checkStep(player, 'pickup', {
    itemName: 'páginas congeladas',
    roomId: 11
  });
  if (result1 && result1.advanced) {
    console.log(`✅ 4. Paso 1 avanzado (pickup páginas en sala 11). Mensaje: "${result1.message.substring(0, 80)}..."`);
  } else {
    console.error('❌ Paso 1 no avanzó:', JSON.stringify(result1));
    process.exit(1);
  }

  // 5. Verificar paso 2
  const active2 = db.getActiveExpedition(PLAYER_ID);
  console.log(`✅ 5. Paso actual: ${active2.step} (esperado: 2)`);
  if (active2.step !== 2) {
    console.error('❌ Se esperaba paso 2, tenemos:', active2.step);
    process.exit(1);
  }

  // 6. Simular PASO 2: entrar a sala 17 (Casa de Subastas)
  const result2 = exp.checkStep(player, 'enter', {
    roomId: 17
  });
  if (result2 && result2.needsDecision) {
    console.log(`✅ 6. Paso 2 avanzado (enter sala 17). Decisión pendiente.`);
    console.log(`   Prompt: "${result2.message.substring(0, 100)}..."`);
  } else {
    console.error('❌ Paso 2 no avanzó o no pidió decisión:', JSON.stringify(result2));
    process.exit(1);
  }

  // 7a. Test decisión A: aprender
  const decisionA = exp.resolveDecision(player, 'aprender');
  if (decisionA && decisionA.worldEffect === 'conjuro_hielo_aprendido') {
    console.log(`✅ 7a. Decisión 'aprender' → worldEffect: ${decisionA.worldEffect}`);
    console.log(`   Mensaje: "${decisionA.message.substring(0, 80)}..."`);
  } else {
    console.error('❌ Decisión aprender falló:', JSON.stringify(decisionA));
    process.exit(1);
  }

  // Limpiar y reasignar para test de decisión B
  rawDb.run(`DELETE FROM expeditions WHERE player_id = '${PLAYER_ID}'`);
  db.assignExpeditionToDB(PLAYER_ID, 'paginas_congeladas');
  exp.checkStep(player, 'pickup', { itemName: 'páginas congeladas', roomId: 11 });
  exp.checkStep(player, 'enter', { roomId: 17 });

  // 7b. Test decisión B: vender
  const decisionB = exp.resolveDecision(player, 'vender');
  if (decisionB && decisionB.worldEffect === 'libro_vendido') {
    console.log(`✅ 7b. Decisión 'vender' → worldEffect: ${decisionB.worldEffect}`);
    console.log(`   Mensaje: "${decisionB.message.substring(0, 80)}..."`);
  } else {
    console.error('❌ Decisión vender falló:', JSON.stringify(decisionB));
    process.exit(1);
  }

  // 8. Verificar reward y world_effect
  console.log(`\n✅ 8. Reward de la expedición: XP=${decisionB.reward.xp}, gold=${decisionB.reward.gold}`);
  console.log(`✅ 9. world_effect: ${decisionB.worldEffect} (esperado: 'libro_vendido')`);

  console.log('\n=== TODOS LOS TESTS PASARON ✅ ===\n');

  // Limpiar al terminar
  rawDb.run(`DELETE FROM expeditions WHERE player_id = '${PLAYER_ID}'`);
}

runTests().catch(err => {
  console.error('Error en tests:', err);
  process.exit(1);
});
