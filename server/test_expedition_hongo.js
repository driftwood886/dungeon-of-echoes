/**
 * Test end-to-end: expedición hongo_maestro
 * EPIC-1159 — Verificación antes del commit
 */

'use strict';

const db = require('./db/db.js');
const exp = require('./game/expedition_engine.js');

const PLAYER_ID = '31003e85-5e72-44e6-8565-53a954ee21aa';

async function runTests() {
  await db.init();
  console.log('\n=== TEST E2E: Expedición hongo_maestro ===\n');

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

  // Asegurar nivel mínimo 2 para unlock
  if (player.level < 2) {
    rawDb.run(`UPDATE players SET level = 2 WHERE id = '${PLAYER_ID}'`);
    player = db.getPlayer(PLAYER_ID);
  }
  console.log(`✅ 2. Jugador: ${player.username} (nivel ${player.level})`);

  // 3. Asignar expedición hongo_maestro directamente
  db.assignExpeditionToDB(PLAYER_ID, 'hongo_maestro');
  const active = db.getActiveExpedition(PLAYER_ID);
  if (!active || active.expedition_id !== 'hongo_maestro') {
    console.error('❌ No se asignó la expedición:', active);
    process.exit(1);
  }
  console.log(`✅ 3. Expedición asignada: ${active.expedition_id}, paso: ${active.step}`);

  // 4. PASO 1: pickup acumulativo de hongos en sala 6
  // Primera pickup — no avanza el paso aún
  const p = db.getPlayer(PLAYER_ID);
  const res1a = exp.checkStep(p, 'pickup', { itemName: 'hongo azul', roomId: 6 });
  if (!res1a.matched || res1a.advanced) {
    console.error('❌ Primer hongo debería matchear pero NO avanzar paso:', JSON.stringify(res1a));
    process.exit(1);
  }
  console.log(`✅ 4a. Primer hongo: matched=${res1a.matched}, advanced=${res1a.advanced}. Msg: "${res1a.message}"`);

  // Segunda pickup
  const p2 = db.getPlayer(PLAYER_ID);
  const res1b = exp.checkStep(p2, 'pickup', { itemName: 'hongo azul', roomId: 6 });
  if (!res1b.matched || res1b.advanced) {
    console.error('❌ Segundo hongo debería matchear pero NO avanzar paso:', JSON.stringify(res1b));
    process.exit(1);
  }
  console.log(`✅ 4b. Segundo hongo: matched=${res1b.matched}, advanced=${res1b.advanced}. Msg: "${res1b.message}"`);

  // Tercera pickup — debe avanzar al paso 2
  const p3 = db.getPlayer(PLAYER_ID);
  const res1c = exp.checkStep(p3, 'pickup', { itemName: 'hongo azul', roomId: 6 });
  if (!res1c.matched || !res1c.advanced) {
    console.error('❌ Tercer hongo debería avanzar el paso:', JSON.stringify(res1c));
    process.exit(1);
  }
  const activeAfterStep1 = db.getActiveExpedition(PLAYER_ID);
  if (activeAfterStep1.step !== 2) {
    console.error('❌ Debería estar en paso 2, está en:', activeAfterStep1.step);
    process.exit(1);
  }
  console.log(`✅ 4c. Tercer hongo: paso avanzado a ${activeAfterStep1.step}. Msg: "${res1c.message}"`);

  // 4d. Verificar que hongo en otra sala NO cuenta
  rawDb.run(`DELETE FROM expeditions WHERE player_id = '${PLAYER_ID}'`);
  db.assignExpeditionToDB(PLAYER_ID, 'hongo_maestro');
  const pWrong = db.getPlayer(PLAYER_ID);
  const resWrong = exp.checkStep(pWrong, 'pickup', { itemName: 'hongo azul', roomId: 5 });
  if (resWrong.matched) {
    console.error('❌ Hongo en sala 5 NO debería avanzar la expedición en paso 1:', JSON.stringify(resWrong));
    process.exit(1);
  }
  console.log(`✅ 4d. Hongo en sala 5 correctamente ignorado (roomId check OK).`);

  // Restaurar a paso 2 completando los 3 hongos en sala 6
  rawDb.run(`DELETE FROM expeditions WHERE player_id = '${PLAYER_ID}'`);
  db.assignExpeditionToDB(PLAYER_ID, 'hongo_maestro');
  for (let i = 0; i < 3; i++) {
    const px = db.getPlayer(PLAYER_ID);
    exp.checkStep(px, 'pickup', { itemName: 'hongo azul', roomId: 6 });
  }
  const afterReset = db.getActiveExpedition(PLAYER_ID);
  if (afterReset.step !== 2) {
    console.error('❌ No pudo llegar a paso 2 en reset:', afterReset);
    process.exit(1);
  }

  // 5. PASO 2: craft del brebaje (hongo + veneno)
  const p4 = db.getPlayer(PLAYER_ID);
  const res2 = exp.checkStep(p4, 'craft', {
    recipe: 'hongo azul con veneno concentrado',
    result: 'brebaje del hongo',
    roomId: 1
  });
  if (!res2.matched || !res2.advanced) {
    console.error('❌ Paso 2 (craft) no avanzó:', JSON.stringify(res2));
    process.exit(1);
  }
  const activeAfterStep2 = db.getActiveExpedition(PLAYER_ID);
  if (activeAfterStep2.step !== 3) {
    console.error('❌ Debería estar en paso 3, está en:', activeAfterStep2.step);
    process.exit(1);
  }
  console.log(`✅ 5. Craft brebaje: paso avanzado a ${activeAfterStep2.step}. Msg: "${res2.message}"`);

  // 6. PASO 3: usar brebaje en sala 5 (altar) — debe completar la expedición
  const p5 = db.getPlayer(PLAYER_ID);
  const res3 = exp.checkStep(p5, 'use', {
    itemName: 'brebaje del hongo',
    roomId: 5
  });
  if (!res3.matched || !res3.completed) {
    console.error('❌ Paso 3 (use en altar) no completó la expedición:', JSON.stringify(res3));
    process.exit(1);
  }
  const activeAfterComplete = db.getActiveExpedition(PLAYER_ID);
  if (activeAfterComplete) {
    console.error('❌ La expedición sigue activa después de completarse:', activeAfterComplete);
    process.exit(1);
  }
  console.log(`✅ 6. Expedición completada. worldEffect: ${res3.worldEffect}. Msg: "${res3.message}"`);

  // 7. Verificar que el world_effect es correcto
  if (res3.worldEffect !== 'altar_capilla_activado') {
    console.error('❌ worldEffect incorrecto:', res3.worldEffect);
    process.exit(1);
  }
  console.log(`✅ 7. World effect correcto: ${res3.worldEffect}`);

  // 8. Verificar que usar brebaje en sala incorrecta no activa
  rawDb.run(`DELETE FROM expeditions WHERE player_id = '${PLAYER_ID}'`);
  db.assignExpeditionToDB(PLAYER_ID, 'hongo_maestro');
  for (let i = 0; i < 3; i++) {
    const px = db.getPlayer(PLAYER_ID);
    exp.checkStep(px, 'pickup', { itemName: 'hongo azul', roomId: 6 });
  }
  const px4 = db.getPlayer(PLAYER_ID);
  exp.checkStep(px4, 'craft', { recipe: 'hongo azul con veneno concentrado', result: 'brebaje del hongo', roomId: 1 });
  const px5 = db.getPlayer(PLAYER_ID);
  const resWrongRoom = exp.checkStep(px5, 'use', { itemName: 'brebaje del hongo', roomId: 9 }); // sala incorrecta
  if (resWrongRoom.completed) {
    console.error('❌ No debería completarse con brebaje en sala incorrecta:', JSON.stringify(resWrongRoom));
    process.exit(1);
  }
  console.log(`✅ 8. Brebaje en sala incorrecta (9) no completa la expedición.`);

  console.log('\n=== TODOS LOS TESTS PASARON ✅ ===\n');
}

runTests().catch(err => {
  console.error('❌ Error inesperado:', err);
  process.exit(1);
});
