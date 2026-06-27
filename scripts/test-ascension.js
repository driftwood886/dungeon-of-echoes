/**
 * EPIC-961: Script de prueba del flujo de ascensión
 * Valida end-to-end: matar al Lich → elegir legado → archivar personaje → crear nuevo → aplicar bonus
 *
 * Uso: node scripts/test-ascension.js
 */

const path = require('path');
const db = require(path.join(__dirname, '../server/db/db.js'));
const engine = require(path.join(__dirname, '../server/game/engine.js'));

async function runTest() {
  await db.init();
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  EPIC-961: Test de Flujo de Ascensión');
  console.log('═══════════════════════════════════════════════════════\n');

  const testUsername = `test_ascension_${Date.now()}`;
  let passed = 0;
  let failed = 0;

  function assert(condition, label) {
    if (condition) {
      console.log(`  ✅ PASS: ${label}`);
      passed++;
    } else {
      console.log(`  ❌ FAIL: ${label}`);
      failed++;
    }
  }

  // ─── PASO 1: Crear jugador de prueba ─────────────────────────────────────
  console.log('PASO 1: Crear jugador de prueba...');
  let player = engine.getOrCreatePlayer(testUsername);
  assert(player && player.id, 'Jugador creado correctamente');
  assert(player.username === testUsername, `Username correcto: ${player.username}`);

  // Configurar el jugador como si hubiera matado al Lich
  db.updatePlayer(player.id, {
    level: 10,
    lich_kills: 1,
    player_class: 'guerrero',
    tutorial_step: 0,        // tutorial completado
    current_room_id: 1,      // sala de entrada (fuera del tutorial)
    status_effects: JSON.stringify({ ascension_pending: true }),
  });
  player = db.getPlayer(player.id);
  assert(player.lich_kills === 1, 'lich_kills = 1 (simulando victoria sobre el Lich)');

  const se = JSON.parse(typeof player.status_effects === 'string' ? player.status_effects : JSON.stringify(player.status_effects) || '{}');
  assert(se.ascension_pending === true, 'ascension_pending = true en status_effects');

  console.log(`  → Jugador listo: ${player.username} (nivel ${player.level}, lich_kills=${player.lich_kills})`);

  // ─── PASO 2: Verificar pantalla de opciones ───────────────────────────────
  console.log('\nPASO 2: Verificar pantalla de opciones de legado...');
  const screenResult = engine.execute(player.id, 'ascender', {});
  assert(screenResult && screenResult.text, 'ascender sin args devuelve respuesta');
  assert(screenResult.text.includes('CICLO HA TERMINADO'), 'Texto de ascensión incluye header épico');
  assert(screenResult.text.includes('1.'), 'Muestra opción 1');
  assert(screenResult.text.includes('2.'), 'Muestra opción 2');
  assert(screenResult.text.includes('3.'), 'Muestra opción 3');
  console.log(`  → Pantalla OK. Primeras líneas: "${screenResult.text.slice(0, 100).replace(/\n/g, '↵')}..."`);

  // Verificar que se guardaron ascension_choices en se
  player = db.getPlayer(player.id);
  const se2Raw = player.status_effects;
  const se2 = typeof se2Raw === 'string' ? JSON.parse(se2Raw) : (se2Raw || {});
  assert(Array.isArray(se2.ascension_choices) && se2.ascension_choices.length === 3,
    `ascension_choices guardadas: [${(se2.ascension_choices || []).join(', ')}]`);

  // ─── PASO 3: Ejecutar ascensión (elegir opción 1) ─────────────────────────
  console.log('\nPASO 3: Ejecutar ascensión con opción 1...');
  const originalId = player.id;
  const ascendResult = engine.execute(player.id, 'ascender 1 Que el eco perdure', {});
  assert(ascendResult && ascendResult.text, 'ascender 1 devuelve respuesta');
  assert(ascendResult.text.includes('ASCENSIÓN HA COMENZADO') || ascendResult.text.includes('ascendió') || ascendResult.text.includes('nuevo ciclo'),
    'Mensaje de confirmación de ascensión');
  console.log(`  → Resultado: "${ascendResult.text.slice(0, 150).replace(/\n/g, '↵')}..."`);

  // ─── PASO 4: Verificar que el personaje viejo está archivado ──────────────
  console.log('\nPASO 4: Verificar personaje archivado...');
  const archivedPlayer = db.getPlayer(originalId);
  assert(archivedPlayer, 'Personaje antiguo sigue existiendo en BD');
  assert(archivedPlayer.is_archived === 1, `is_archived = 1 (era ${archivedPlayer.is_archived})`);
  assert(archivedPlayer.username === `${testUsername}#1`, `Username archivado = "${archivedPlayer.username}" (esperado: "${testUsername}#1")`);
  assert(archivedPlayer.account_username === testUsername, `account_username = "${archivedPlayer.account_username}"`);
  console.log(`  → Personaje archivado: ${archivedPlayer.username}`);

  // ─── PASO 5: Verificar que el nuevo personaje fue creado ──────────────────
  console.log('\nPASO 5: Verificar nuevo personaje...');
  const newPlayer = db.getPlayerByUsername(testUsername);
  assert(newPlayer, 'Nuevo personaje existe en BD');
  assert(newPlayer.id !== originalId, 'Nuevo personaje tiene ID diferente');
  assert(newPlayer.is_archived === 0, `is_archived = 0 (era ${newPlayer.is_archived})`);
  assert(newPlayer.ascension_count === 1, `ascension_count = 1 (era ${newPlayer.ascension_count})`);
  assert(newPlayer.account_username === testUsername, `account_username = "${newPlayer.account_username}"`);
  const legacyBonusRaw = newPlayer.legacy_bonus;
  assert(legacyBonusRaw && legacyBonusRaw !== '{}', `legacy_bonus no está vacío: "${String(legacyBonusRaw).slice(0, 60)}"`);
  console.log(`  → Nuevo personaje: ${newPlayer.username} (ID: ${newPlayer.id.slice(0, 8)}...)`);
  console.log(`  → legacy_bonus: ${String(legacyBonusRaw).slice(0, 80)}`);

  // ─── PASO 6: Verificar que se creó la entrada en legacies ─────────────────
  console.log('\nPASO 6: Verificar tabla legacies...');
  const legacies = db.getLegaciesByAccount(testUsername);
  assert(legacies && legacies.length >= 1, `Al menos 1 entrada en legacies: ${legacies ? legacies.length : 0}`);
  if (legacies && legacies.length > 0) {
    const leg = legacies[0];
    assert(leg.account_username === testUsername, `account_username = "${leg.account_username}"`);
    assert(leg.character_name === `${testUsername}#1`, `character_name = "${leg.character_name}"`);
    assert(leg.ascension_number === 1, `ascension_number = ${leg.ascension_number}`);
    assert(leg.legacy_type, `legacy_type = "${leg.legacy_type}"`);
    assert(leg.epitaph === 'Que el eco perdure', `epitaph = "${leg.epitaph}"`);
    console.log(`  → Legado registrado: ${leg.legacy_type}, epitafio: "${leg.epitaph}"`);
  }

  // ─── PASO 7: Verificar aplicación del bonus de legado ─────────────────────
  console.log('\nPASO 7: Verificar aplicación de bonus de legado (via getOrCreatePlayer)...');
  const playerWithBonus = engine.getOrCreatePlayer(testUsername);
  const bonusApplied = (() => {
    try {
      const b = playerWithBonus.legacy_bonus;
      if (!b || b === '{}') return null;
      return typeof b === 'string' ? JSON.parse(b) : b;
    } catch { return null; }
  })();
  assert(bonusApplied, 'legacy_bonus parseado correctamente');
  if (bonusApplied) {
    assert(bonusApplied.applied === true, `legacy_bonus.applied = ${bonusApplied.applied} (esperado: true)`);
    console.log(`  → Bonus aplicado: tipo=${bonusApplied.type}, applied=${bonusApplied.applied}`);
  }

  // ─── PASO 8: Verificar comando salon ──────────────────────────────────────
  console.log('\nPASO 8: Verificar comando salon...');
  // Sacar al nuevo jugador del tutorial para poder usar el comando salon
  db.updatePlayer(playerWithBonus.id, { tutorial_step: 0, current_room_id: 1 });
  const salonResult = engine.execute(playerWithBonus.id, 'salon', {});
  assert(salonResult && salonResult.text, 'salon devuelve respuesta');
  assert(salonResult.text.includes('SALÓN DE LOS CAÍDOS'), 'Header del salón presente');
  assert(salonResult.text.includes(`${testUsername}#1`), `Personaje archivado visible en salon: "${testUsername}#1"`);
  console.log(`  → Salon OK. Primeras líneas: "${salonResult.text.slice(0, 100).replace(/\n/g, '↵')}..."`);

  // ─── CLEANUP: Eliminar jugadores de prueba ────────────────────────────────
  console.log('\nCLEANUP: Eliminando jugadores de prueba...');
  db.deletePlayer(originalId);
  db.deletePlayer(playerWithBonus.id);
  console.log(`  → Jugadores de prueba eliminados.`);

  // ─── RESUMEN ──────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`  RESULTADO: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════════\n');

  if (failed > 0) process.exit(1);
}

runTest().catch(err => {
  console.error('\n❌ Error inesperado en el test:', err);
  process.exit(1);
});
