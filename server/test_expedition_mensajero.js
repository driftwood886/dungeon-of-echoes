/**
 * Test end-to-end: expedición mensajero_caido
 * EPIC-1161 — Verificación antes del commit
 *
 * Pasos:
 *   1. Pickup de "carta sellada" → avanza al paso 2
 *   2. Entrar a sala 4 (Casa de Subastas) → needsDecision
 *   3. Decisión: "entregar" → completado, worldEffect aldric_carta_entregada
 */

'use strict';

const db = require('./db/db.js');
const exp = require('./game/expedition_engine.js');

const PLAYER_ID = '31003e85-5e72-44e6-8565-53a954ee21aa';

async function runTests() {
  await db.init();
  console.log('\n=== TEST E2E: Expedición mensajero_caido ===\n');

  // 1. Limpiar expediciones previas
  const rawDb = db.raw();
  rawDb.run(`DELETE FROM expeditions WHERE player_id = '${PLAYER_ID}'`);
  console.log('✅ 1. Expediciones anteriores limpiadas.');

  // 2. Obtener jugador, asegurar que es pícaro (clase requerida)
  let player = db.getPlayer(PLAYER_ID);
  if (!player) {
    console.error('❌ Jugador no encontrado:', PLAYER_ID);
    process.exit(1);
  }

  // Asegurar clase pícaro y nivel 1+
  if (player.player_class !== 'picaro' && player.player_class !== 'asesino') {
    db.updatePlayer(PLAYER_ID, { player_class: 'picaro' });
    player = db.getPlayer(PLAYER_ID);
  }
  console.log(`✅ 2. Jugador: ${player.username} (nivel ${player.level}, clase ${player.player_class})`);

  // 3. Asignar mensajero_caido directamente
  db.assignExpeditionToDB(PLAYER_ID, 'mensajero_caido');
  const active = db.getActiveExpedition(PLAYER_ID);
  if (!active || active.expedition_id !== 'mensajero_caido') {
    console.error('❌ No se asignó la expedición:', active);
    process.exit(1);
  }
  console.log(`✅ 3. Expedición asignada: ${active.expedition_id}, paso: ${active.step}`);

  // 4. Paso 1: pickup de "carta sellada"
  const result1 = exp.checkStep(player, 'pickup', {
    itemName: 'carta sellada',
    roomId: 2
  });
  if (!result1 || !result1.advanced) {
    console.error('❌ 4. Paso 1 no avanzó:', JSON.stringify(result1));
    process.exit(1);
  }
  console.log(`✅ 4. Paso 1 avanzado. Msg: "${result1.message}"`);

  // 5. Verificar paso 2
  const active2 = db.getActiveExpedition(PLAYER_ID);
  if (active2.step !== 2) {
    console.error(`❌ 5. Se esperaba paso 2, tenemos: ${active2.step}`);
    process.exit(1);
  }
  console.log(`✅ 5. Ahora en paso 2.`);

  // 6. Paso 2: entrar a sala 4 (Casa de Subastas)
  player = db.getPlayer(PLAYER_ID);
  const result2 = exp.checkStep(player, 'enter', {
    roomId: 4
  });
  if (!result2 || !result2.matched || !result2.needsDecision) {
    console.error('❌ 6. Paso 2 no generó needsDecision:', JSON.stringify(result2));
    process.exit(1);
  }
  console.log(`✅ 6. Paso 2 activó decisión. Msg: "${(result2.message || '').substring(0, 80)}..."`);

  // 7. Decisión: "entregar"
  player = db.getPlayer(PLAYER_ID);
  const decR = exp.resolveDecision(player, 'entregar');
  if (!decR) {
    console.error('❌ 7. resolveDecision devolvió null');
    process.exit(1);
  }
  if (decR.worldEffect !== 'aldric_carta_entregada') {
    console.error(`❌ 7. worldEffect incorrecto: ${decR.worldEffect}`);
    process.exit(1);
  }
  console.log(`✅ 7. Expedición completada. Reward: ${JSON.stringify(decR.reward)}, worldEffect: ${decR.worldEffect}`);

  // 8. Verificar que la expedición está completa (no hay activa)
  const activeAfter = db.getActiveExpedition(PLAYER_ID);
  if (activeAfter) {
    console.error('❌ 8. Expedición sigue activa:', JSON.stringify(activeAfter));
    process.exit(1);
  }
  console.log('✅ 8. No hay expedición activa — correctamente completada.');

  // 9. Probar también la decisión "abrir" (segunda rama)
  rawDb.run(`DELETE FROM expeditions WHERE player_id = '${PLAYER_ID}'`);
  db.assignExpeditionToDB(PLAYER_ID, 'mensajero_caido');
  player = db.getPlayer(PLAYER_ID);
  exp.checkStep(player, 'pickup', { itemName: 'carta sellada', roomId: 2 });
  player = db.getPlayer(PLAYER_ID);
  exp.checkStep(player, 'enter', { roomId: 4 });
  player = db.getPlayer(PLAYER_ID);
  const decR2 = exp.resolveDecision(player, 'abrir');
  if (!decR2 || decR2.worldEffect !== 'carta_abierta_info_secreta') {
    console.error('❌ 9. Decisión "abrir" falló:', JSON.stringify(decR2));
    process.exit(1);
  }
  console.log(`✅ 9. Decisión "abrir" OK: worldEffect=${decR2.worldEffect}`);

  console.log('\n🏆 TODOS LOS TESTS PASARON — EPIC-1161 verificada\n');
  process.exit(0);
}

runTests().catch(err => {
  console.error('Error inesperado:', err);
  process.exit(1);
});
