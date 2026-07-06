'use strict';
// T1274 Test: Verify DIS-1244 warning from Sala del Trono (9) → Túnel de Hongos (6) says "sur" not "norte"
const db = require('./db/db.js');
const engine = require('./game/engine.js');

async function runTest() {
  await db.init();
  console.log('\n=== TEST T1274: Pre-move warning direction fix (Trono → Túnel) ===\n');

  const ids = db.getAllPlayerIds();
  if (!ids || ids.length === 0) { console.log('No players'); process.exit(1); }
  const playerId = ids[0].id;
  console.log('Using player id:', playerId);

  // Reset room 6 trap to active
  const room6 = db.getRoom(6);
  if (!room6 || !room6.trap) {
    console.log('ERROR: Room 6 has no trap!');
    process.exit(1);
  }
  db.updateRoomTrap(6, { ...room6.trap, active: true, respawn_at: null });
  console.log('Room 6 trap active:', db.getRoom(6).trap && db.getRoom(6).trap.active);

  // Teleport player to room 9 (Sala del Trono), clear room 6 from known_traps, clear hongo_warning_done
  const p = db.getPlayer(playerId);
  const kt = {};  // empty known_traps
  const se = {};  // empty status_effects
  db.updatePlayer(playerId, {
    current_room_id: 9,
    known_traps: JSON.stringify(kt),
    status_effects: JSON.stringify(se),
    inventory: JSON.stringify([])  // no hongo azul
  });

  const p2 = db.getPlayer(playerId);
  console.log('Player setup: room', p2.current_room_id, '| known_traps:', p2.known_traps, '| inventory:', p2.inventory);
  console.log('');

  // Execute "sur" — should trigger DIS-1244 warning with "sur" direction
  const result = engine.execute(playerId, 'sur');
  console.log('--- Response ---');
  console.log(result.text);

  console.log('\n--- Verdict ---');
  if (result.text && result.text.includes('desactivar trampa sur')) {
    console.log('✅ T1274 FIX WORKS: Warning correctly says "desactivar trampa sur" (coming from Sala del Trono)');
  } else if (result.text && result.text.includes('desactivar trampa norte')) {
    console.log('❌ T1274 FIX FAILED: Warning still says "desactivar trampa norte" (wrong direction)');
  } else {
    console.log('⚠️  Warning not triggered. Check reason:');
    const p3 = db.getPlayer(playerId);
    console.log('  Player now in room:', p3.current_room_id);
    console.log('  Room 6 trap:', db.getRoom(6).trap && db.getRoom(6).trap.active);
  }
}

runTest().catch(e => { console.error(e); process.exit(1); });
