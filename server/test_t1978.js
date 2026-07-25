/**
 * Test T-1978: Closing scene al derrotar al Lich con quest completa.
 * Verifica que activateKaelthasEnding devuelve closingText y marca lich_died_with_quest: true.
 * Verifica también idempotencia (llamar dos veces no repite la escena).
 */

const db = require('./db/db');
const kaelthasQuest = require('./game/kaelthasQuest');

async function main() {
  await db.init();

  function resetPlayer(username, questState, fragmentCount) {
    let player = db.getPlayerByUsername(username);
    if (!player) player = db.createPlayer(username);
    db.updatePlayer(player.id, {
      current_room_id: 15, hp: 999, max_hp: 999,
      attack: 50, defense: 10, level: 8, xp: 9999,
      player_class: 'guerrero', is_bot: 0,
      status_effects: '{}', skill_cooldowns: '{}',
      inventory: '[]',
    });
    const ALL_FRAGS = ['trono', 'mausoleo', 'capilla', 'catedral'];
    const fragments = ALL_FRAGS.slice(0, fragmentCount);
    db.updateMainQuestData(player.id, {
      main_quest_state: questState,
      fragments_found: fragments,
      kaelthas_fragments_count: fragmentCount,
      lich_died_with_quest: false,
    });
    return db.getPlayer(player.id);
  }

  console.log('=== Test T-1978: Closing scene del Lich ===\n');

  // ── Caso A: quest incompleta (1 fragmento) → sin ending ──
  console.log('--- Caso A: quest activa, 1 fragmento (sin ending) ---');
  const pA = resetPlayer('test_t1978_a', 'active', 1);
  const endA = kaelthasQuest.activateKaelthasEnding(pA);
  if (endA === null) {
    console.log('✅ Caso A OK: sin ending (quest incompleta)');
  } else {
    console.log('❌ Caso A FAIL: esperaba null, got:', endA);
  }

  // ── Caso B: quest inactiva → sin ending ──
  console.log('\n--- Caso B: quest inactiva ---');
  const pB = resetPlayer('test_t1978_b', 'inactive', 0);
  const endB = kaelthasQuest.activateKaelthasEnding(pB);
  if (endB === null) {
    console.log('✅ Caso B OK: sin ending (quest inactiva)');
  } else {
    console.log('❌ Caso B FAIL: esperaba null, got:', endB);
  }

  // ── Caso C: 4 fragmentos → ending con closingText ──
  console.log('\n--- Caso C: 4 fragmentos → closing scene ---');
  const pC = resetPlayer('test_t1978_c', 'active', 4);
  const endC = kaelthasQuest.activateKaelthasEnding(pC);
  if (endC && endC.closingText && endC.closingText.includes('El Lich se desmorona')) {
    console.log('✅ Caso C OK: closingText presente');
    // Verificar que lich_died_with_quest se guardó
    const mqdC = db.getMainQuestData(pC.id);
    if (mqdC.lich_died_with_quest === true) {
      console.log('✅ Caso C OK: lich_died_with_quest = true en BD');
    } else {
      console.log('❌ Caso C FAIL: lich_died_with_quest no se guardó. mqd:', mqdC);
    }
  } else {
    console.log('❌ Caso C FAIL:', endC);
  }

  // ── Caso D: idempotencia — llamar dos veces → segunda vez devuelve null ──
  console.log('\n--- Caso D: idempotencia ---');
  const pD = resetPlayer('test_t1978_d', 'active', 4);
  const endD1 = kaelthasQuest.activateKaelthasEnding(pD);
  const endD2 = kaelthasQuest.activateKaelthasEnding(db.getPlayer(pD.id));
  if (endD1 && endD1.closingText && endD2 === null) {
    console.log('✅ Caso D OK: idempotente (segunda llamada → null)');
  } else {
    console.log('❌ Caso D FAIL: endD1:', !!endD1, '| endD2:', endD2);
  }

  // ── Caso E: leer libro tras ending → epitafio ──
  console.log('\n--- Caso E: getEpitaph tras ending ---');
  const pE = resetPlayer('test_t1978_e', 'active', 4);
  kaelthasQuest.activateKaelthasEnding(pE);
  const pEFresh = db.getPlayer(pE.id);
  const epit = kaelthasQuest.getEpitaph(pEFresh);
  if (epit && epit.includes('derrotar')) {
    console.log('✅ Caso E OK: epitafio devuelto correctamente');
  } else {
    console.log('❌ Caso E FAIL:', epit);
  }

  // Cleanup
  for (const u of ['test_t1978_a', 'test_t1978_b', 'test_t1978_c', 'test_t1978_d', 'test_t1978_e']) {
    const p = db.getPlayerByUsername(u);
    if (p) db.deletePlayer(p.id);
  }

  console.log('\n=== Test T-1978 completado ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
