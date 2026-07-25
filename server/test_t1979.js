/**
 * Test T-1979: Hint del Guardián Anciano al llegar a sala 16.
 */
const db = require('./db/db');
const kaelthasQuest = require('./game/kaelthasQuest');

async function main() {
  await db.init();

  function resetPlayer(username, level, questState) {
    let player = db.getPlayerByUsername(username);
    if (!player) player = db.createPlayer(username);
    db.updatePlayer(player.id, {
      current_room_id: 1, hp: 50, max_hp: 50,
      level, is_bot: 0, status_effects: '{}',
    });
    db.updateMainQuestData(player.id, {
      main_quest_state: questState, fragments_found: [], kaelthas_fragments_count: 0,
    });
    return db.getPlayer(player.id);
  }

  console.log('=== Test T-1979: Hint del Guardián ===\n');

  // Caso A: nivel 2 → sin hint
  const pA = resetPlayer('test_t1979_a', 2, 'inactive');
  const hA = kaelthasQuest.getGuardianHint(pA);
  console.log('Caso A (nivel 2):', hA === null ? '✅ null (correcto)' : '❌ FAIL: ' + hA);

  // Caso B: nivel 3, quest inactiva → hint
  const pB = resetPlayer('test_t1979_b', 3, 'inactive');
  const hB = kaelthasQuest.getGuardianHint(pB);
  console.log('Caso B (nivel 3, inactiva):', hB && hB.includes('Trono de Huesos') ? '✅ hint presente' : '❌ FAIL: ' + hB);

  // Caso C: idempotencia — segunda llamada → null
  const pBFresh = db.getPlayer(pB.id);
  const hC = kaelthasQuest.getGuardianHint(pBFresh);
  console.log('Caso C (idempotencia):', hC === null ? '✅ null (correcto)' : '❌ FAIL: ' + hC);

  // Caso D: quest activa → sin hint
  const pD = resetPlayer('test_t1979_d', 5, 'active');
  const hD = kaelthasQuest.getGuardianHint(pD);
  console.log('Caso D (quest activa):', hD === null ? '✅ null (correcto)' : '❌ FAIL');

  for (const u of ['test_t1979_a', 'test_t1979_b', 'test_t1979_d']) {
    const p = db.getPlayerByUsername(u);
    if (p) db.deletePlayer(p.id);
  }

  console.log('\n=== Test T-1979 completado ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
