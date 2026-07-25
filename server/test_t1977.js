/**
 * Test T-1977: Diálogo del Lich según estado de quest de Kaelthas.
 *
 * Verifica los 3 caminos:
 *   (a) sin quest activa → sin texto adicional
 *   (b) quest activa incompleta → "Otro que vino a morir..."
 *   (c) 4 fragmentos completos → monólogo de 3 líneas
 */

const db = require('./db/db');
const engine = require('./game/engine');
const kaelthasQuest = require('./game/kaelthasQuest');

async function main() {
  await db.init();

  // Helper: crear/resetear jugador de prueba
  function resetPlayer(username, questState, fragmentCount) {
    let player = db.getPlayerByUsername(username);
    if (!player) {
      player = db.createPlayer(username);
    }
    db.updatePlayer(player.id, {
      current_room_id: 15, // Catedral de la Oscuridad
      hp: 999,
      max_hp: 999,
      attack: 50,
      defense: 10,
      level: 8,
      xp: 9999,
      player_class: 'guerrero',
      is_bot: 0,
      status_effects: '{}',
      skill_cooldowns: '{}',
    });
    // Actualizar main_quest_data
    const mqd = db.getMainQuestData(player.id);
    const fragments = [];
    const ALL_FRAGS = ['trono', 'mausoleo', 'capilla', 'catedral'];
    for (let i = 0; i < fragmentCount; i++) fragments.push(ALL_FRAGS[i]);
    db.updateMainQuestData(player.id, {
      main_quest_state: questState,
      fragments_found: fragments,
      kaelthas_fragments_count: fragmentCount,
    });
    return db.getPlayer(player.id);
  }

  // Asegurar que el Lich esté vivo en sala 15
  function ensureLich() {
    const monsters = db.getMonstersInRoom(15);
    const lich = monsters.find(m => m.id === 13 || (m.name && m.name.toLowerCase().includes('lich')));
    if (lich && lich.hp <= 0) {
      db.updateMonster(lich.id, { hp: lich.max_hp });
      console.log('  [setup] Lich restaurado a HP completo');
    } else if (!lich) {
      console.log('  [setup] ⚠️ Lich no encontrado en sala 15 — este test requiere que el Lich exista en BD');
      return false;
    }
    return true;
  }

  console.log('=== Test T-1977: Diálogo del Lich ===\n');

  // ── Caso A: quest inactiva (sin diálogo) ──
  console.log('--- Caso A: quest inactiva ---');
  const pA = resetPlayer('test_t1977_a', 'inactive', 0);
  const diagA = kaelthasQuest.getLichDialogue(pA);
  console.log('getLichDialogue result:', diagA);
  if (diagA === null) {
    console.log('✅ Caso A OK: null (sin diálogo)');
  } else {
    console.log('❌ Caso A FAIL: esperaba null, got:', diagA);
  }

  // ── Caso B: quest activa, 2/4 fragmentos ──
  console.log('\n--- Caso B: quest activa, 2 fragmentos ---');
  const pB = resetPlayer('test_t1977_b', 'active', 2);
  const diagB = kaelthasQuest.getLichDialogue(pB);
  console.log('getLichDialogue result:', diagB);
  if (diagB && diagB.includes('Otro que vino a morir')) {
    console.log('✅ Caso B OK: diálogo parcial');
  } else {
    console.log('❌ Caso B FAIL: no contiene texto esperado. Got:', diagB);
  }

  // ── Caso C: quest con 4 fragmentos ──
  console.log('\n--- Caso C: 4 fragmentos completos ---');
  const pC = resetPlayer('test_t1977_c', 'active', 4);
  const diagC = kaelthasQuest.getLichDialogue(pC);
  console.log('getLichDialogue result:', diagC);
  if (diagC && diagC.includes('Ya sabés, entonces')) {
    console.log('✅ Caso C OK: monólogo completo del Lich');
  } else {
    console.log('❌ Caso C FAIL: no contiene texto esperado. Got:', diagC);
  }

  // ── Test de integración: atacar al Lich y verificar prefijo en output ──
  console.log('\n--- Test integración: output de combate incluye diálogo ---');
  if (ensureLich()) {
    const pInt = resetPlayer('test_t1977_int', 'active', 2);
    const result = engine.execute(pInt, { type: 'attack', args: ['lich'] });
    if (result && result.text) {
      if (result.text.includes('Otro que vino a morir')) {
        console.log('✅ Integración OK: diálogo del Lich presente en el output del combate');
      } else {
        console.log('❌ Integración FAIL: diálogo no encontrado en output');
        console.log('Output (primeros 300 chars):', result.text.substring(0, 300));
      }
    } else {
      console.log('❌ Integración FAIL: no hay result.text');
    }
  }

  // Cleanup
  for (const u of ['test_t1977_a', 'test_t1977_b', 'test_t1977_c', 'test_t1977_int']) {
    const p = db.getPlayerByUsername(u);
    if (p) db.deletePlayer(p.id);
  }

  console.log('\n=== Test T-1977 completado ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
