/**
 * Test end-to-end: expedición racha_del_trono
 * EPIC-1160 — Verificación antes del commit
 * 
 * Verifica:
 *   1. Asignación y progreso acumulativo (racha_kills)
 *   2. reset_on_death al morir
 *   3. Reanudar racha desde 0 hasta completar 5
 *   4. Paso 2: usar trono en sala 9 → decisión
 *   5. resolveDecision → expedición completa
 */

'use strict';

const db = require('./db/db.js');
const exp = require('./game/expedition_engine.js');

const PLAYER_ID = '31003e85-5e72-44e6-8565-53a954ee21aa';

async function runTests() {
  await db.init();
  console.log('\n=== TEST E2E: Expedición racha_del_trono ===\n');

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

  // Asegurar nivel mínimo 3 para unlock_condition
  if (player.level < 3) {
    db.updatePlayer(PLAYER_ID, { level: 3 });
    player = db.getPlayer(PLAYER_ID);
  }
  console.log(`✅ 2. Jugador: ${player.username} (nivel ${player.level})`);

  // 3. Asignar racha_del_trono directamente
  db.assignExpeditionToDB(PLAYER_ID, 'racha_del_trono');
  const active = db.getActiveExpedition(PLAYER_ID);
  if (!active || active.expedition_id !== 'racha_del_trono') {
    console.error('❌ No se asignó la expedición:', active);
    process.exit(1);
  }
  console.log(`✅ 3. Expedición asignada: ${active.expedition_id}, paso: ${active.step}`);

  // 4. Simular 4 kills (sin llegar al goal de 5)
  console.log('\n-- Paso 4: 4 kills acumulativos --');
  let ok4 = true;
  for (let i = 1; i <= 4; i++) {
    player = db.getPlayer(PLAYER_ID);
    const r = exp.checkStep(player, 'kill', { monsterName: 'Goblin', roomId: 2 });
    if (!r.matched) { ok4 = false; console.error(`❌ Kill ${i} no matcheó`); break; }
    const countInMsg = r.message && r.message.includes(`${i}/5`);
    console.log(`   Kill ${i}/5: matched=${r.matched}, mensaje correcto=${countInMsg}, msg="${r.message}"`);
    if (!countInMsg) ok4 = false;
  }
  if (ok4) console.log('✅ 4. 4 kills acumulativos OK.');
  else { console.error('❌ 4. Fallo en kills acumulativos'); process.exit(1); }

  // 5. Simular muerte → reset
  console.log('\n-- Paso 5: muerte del jugador --');
  player = db.getPlayer(PLAYER_ID);
  const deathR = exp.notifyDeath(player);
  if (!deathR || !deathR.message) {
    console.error('❌ 5. notifyDeath devolvió null/vacío:', deathR);
    process.exit(1);
  }
  const activeAfterDeath = db.getActiveExpedition(PLAYER_ID);
  const countAfterDeath = (activeAfterDeath.data || {}).racha_kills;
  if (countAfterDeath !== 0) {
    console.error(`❌ 5. racha_kills debería ser 0 tras muerte, es: ${countAfterDeath}`);
    process.exit(1);
  }
  console.log(`✅ 5. Muerte reseteó racha_kills a 0. Msg: "${deathR.message}"`);

  // 6. Reanudar racha desde 0 — 5 kills consecutivos
  console.log('\n-- Paso 6: 5 kills desde 0 --');
  let ok6 = true;
  let lastKillResult = null;
  for (let i = 1; i <= 5; i++) {
    player = db.getPlayer(PLAYER_ID);
    const r = exp.checkStep(player, 'kill', { monsterName: 'Orco', roomId: 3 });
    console.log(`   Kill ${i}/5: matched=${r.matched}, advanced=${r.advanced}, needsDec=${r.needsDecision}`);
    if (!r.matched) { ok6 = false; break; }
    if (i === 5) lastKillResult = r;
  }
  if (!ok6) { console.error('❌ 6. Fallo en segunda racha'); process.exit(1); }

  // Verificar que en el kill 5 avanzó al siguiente paso
  if (!lastKillResult.advanced) {
    console.error('❌ 6. Kill 5 debería avanzar al paso 2, no lo hizo');
    process.exit(1);
  }
  const active2 = db.getActiveExpedition(PLAYER_ID);
  if (active2.step !== 2) {
    console.error(`❌ 6. Se esperaba paso 2, tenemos: ${active2.step}`);
    process.exit(1);
  }
  console.log(`✅ 6. 5 kills consecutivos OK — ahora en paso 2.`);

  // 7. Usar trono en sala 9
  console.log('\n-- Paso 7: usar trono sala 9 --');
  player = db.getPlayer(PLAYER_ID);
  const tronoR = exp.checkStep(player, 'use', { itemName: 'el trono de piedra', roomId: 9 });
  if (!tronoR.matched || !tronoR.needsDecision) {
    console.error('❌ 7. Trono no avanzó o no pidió decisión:', JSON.stringify(tronoR));
    process.exit(1);
  }
  console.log(`✅ 7. Trono activado. needsDecision=true. Msg: "${(tronoR.message || '').substring(0, 80)}..."`);

  // 8. Decisión: elegir "poder"
  console.log('\n-- Paso 8: decidir "poder" --');
  player = db.getPlayer(PLAYER_ID);
  const decR = exp.resolveDecision(player, 'poder');
  if (!decR) {
    console.error('❌ 8. resolveDecision devolvió null');
    process.exit(1);
  }
  if (decR.worldEffect !== 'trono_poder_activo') {
    console.error(`❌ 8. worldEffect incorrecto: ${decR.worldEffect}`);
    process.exit(1);
  }
  console.log(`✅ 8. Expedición completada. Reward: ${JSON.stringify(decR.reward)}, worldEffect: ${decR.worldEffect}`);

  // 9. Verificar que la expedición quedó completada
  const activeAfterComplete = db.getActiveExpedition(PLAYER_ID);
  if (activeAfterComplete) {
    console.error('❌ 9. Expedición sigue activa tras completar:', JSON.stringify(activeAfterComplete));
    process.exit(1);
  }
  console.log('✅ 9. No hay expedición activa — correctamente completada.');

  console.log('\n🏆 TODOS LOS TESTS PASARON — EPIC-1160 verificada\n');
  process.exit(0);
}

runTests().catch(err => {
  console.error('Error inesperado:', err);
  process.exit(1);
});
