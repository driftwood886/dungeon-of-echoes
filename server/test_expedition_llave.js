/**
 * Test end-to-end: expedición llave_del_vacio
 * EPIC-1165 — Verificación antes del commit
 */

'use strict';

const db = require('./db/db.js');
const exp = require('./game/expedition_engine.js');

const PLAYER_ID = '31003e85-5e72-44e6-8565-53a954ee21aa';

async function runTests() {
  await db.init();
  console.log('\n=== TEST E2E: Expedición llave_del_vacio ===\n');

  // 1. Limpiar expediciones previas
  const rawDb = db.raw();
  rawDb.run(`DELETE FROM expeditions WHERE player_id = '${PLAYER_ID}'`);
  console.log('✅ 1. Expediciones anteriores limpiadas.');

  // 2. Obtener jugador — asegurar nivel 3 y clase guerrero
  let player = db.getPlayer(PLAYER_ID);
  if (!player) {
    console.error('❌ Jugador no encontrado:', PLAYER_ID);
    process.exit(1);
  }

  if ((player.level || 1) < 3) {
    db.updatePlayer(PLAYER_ID, { level: 3, xp: 150, player_class: 'guerrero' });
  } else {
    db.updatePlayer(PLAYER_ID, { player_class: 'guerrero' });
  }
  player = db.getPlayer(PLAYER_ID);
  console.log(`✅ 2. Jugador: ${player.username} (nivel ${player.level}, clase: ${player.player_class})`);

  // 3. Asignar expedición llave_del_vacio directamente
  db.assignExpeditionToDB(PLAYER_ID, 'llave_del_vacio');
  const active = db.getActiveExpedition(PLAYER_ID);
  if (!active || active.expedition_id !== 'llave_del_vacio') {
    console.error('❌ No se asignó la expedición:', active);
    process.exit(1);
  }
  console.log(`✅ 3. Expedición asignada: ${active.expedition_id}, paso: ${active.step}`);

  // 4. Simular PASO 1: usar llave oxidada en sala 3 (Sala de los Ecos)
  const result1 = exp.checkStep(player, 'use', {
    itemName: 'llave oxidada',
    roomId: 3
  });
  if (result1 && result1.advanced) {
    console.log(`✅ 4. Paso 1 avanzado (use llave oxidada en sala 3). Mensaje: "${result1.message.substring(0, 80)}..."`);
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

  // 6. Simular PASO 2: usar llave en sala 16 (Santuario Profano)
  const result2 = exp.checkStep(player, 'use', {
    itemName: 'llave oxidada',
    roomId: 16
  });
  if (result2 && result2.needsDecision) {
    console.log(`✅ 6. Paso 2 avanzado (use llave en sala 16). Decisión pendiente.`);
    console.log(`   Prompt: "${result2.message.substring(0, 100)}..."`);
  } else {
    console.error('❌ Paso 2 no avanzó o no pidió decisión:', JSON.stringify(result2));
    process.exit(1);
  }

  // 7a. Test decisión A: cofre
  const decisionA = exp.resolveDecision(player, 'cofre');
  if (decisionA && decisionA.worldEffect === 'cofre_del_vacio_abierto') {
    console.log(`✅ 7a. Decisión 'cofre' → worldEffect: ${decisionA.worldEffect}`);
    console.log(`   Mensaje: "${decisionA.message.substring(0, 80)}..."`);
  } else {
    console.error('❌ Decisión cofre falló:', JSON.stringify(decisionA));
    process.exit(1);
  }

  // Limpiar y reasignar para test de decisión B
  rawDb.run(`DELETE FROM expeditions WHERE player_id = '${PLAYER_ID}'`);
  db.assignExpeditionToDB(PLAYER_ID, 'llave_del_vacio');
  exp.checkStep(player, 'use', { itemName: 'llave oxidada', roomId: 3 });
  exp.checkStep(player, 'use', { itemName: 'llave oxidada', roomId: 16 });

  // 7b. Test decisión B: liberar
  const decisionB = exp.resolveDecision(player, 'liberar');
  if (decisionB && decisionB.worldEffect === 'figura_liberada_bendicion') {
    console.log(`✅ 7b. Decisión 'liberar' → worldEffect: ${decisionB.worldEffect}`);
    console.log(`   Mensaje: "${decisionB.message.substring(0, 80)}..."`);
  } else {
    console.error('❌ Decisión liberar falló:', JSON.stringify(decisionB));
    process.exit(1);
  }

  console.log(`\n✅ 8. Reward: XP=${decisionB.reward.xp}, gold=${decisionB.reward.gold}`);
  console.log(`✅ 9. world_effect: ${decisionB.worldEffect}`);

  console.log('\n=== TODOS LOS TESTS PASARON ✅ ===\n');

  // Limpiar
  rawDb.run(`DELETE FROM expeditions WHERE player_id = '${PLAYER_ID}'`);
}

runTests().catch(err => {
  console.error('Error en tests:', err);
  process.exit(1);
});
