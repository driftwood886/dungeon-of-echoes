'use strict';
// DIS-1277 Test: Verify confirmation header when using "desactivar trampa <dir>"
// Player in room 6 (Túnel), uses "desactivar trampa norte" → room 9 (Sala del Trono)
// Expected: header "🎯 Trampa objetivo: frío sobrenatural ❄️ en Sala del Trono (al norte) — ítem requerido: "corona rota"."
const db = require('./db/db.js');
const engine = require('./game/engine.js');

async function runTest() {
  await db.init();
  console.log('\n=== TEST DIS-1277: Confirmation header for directional disarm ===\n');

  const ids = db.getAllPlayerIds();
  if (!ids || ids.length === 0) { console.log('No players'); process.exit(1); }
  const playerId = ids[0].id;
  console.log('Using player id:', playerId);

  // Ensure room 9 trap is active
  const room9 = db.getRoom(9);
  if (!room9 || !room9.trap) { console.log('ERROR: Room 9 has no trap!'); process.exit(1); }
  db.updateRoomTrap(9, { ...room9.trap, active: true, respawn_at: null });
  console.log('Room 9 trap active:', db.getRoom(9).trap && db.getRoom(9).trap.active);

  // Place player in room 6 with empty inventory
  db.updatePlayer(playerId, { current_room_id: 6, inventory: JSON.stringify([]) });
  const player = db.getPlayer(playerId);
  console.log('Player in room:', player.current_room_id, '| inventory:', player.inventory);

  // Test: desactivar trampa norte (6 → 9)
  const result = engine.execute(playerId, 'desactivar trampa norte');
  console.log('\n--- Response ---');
  console.log(result.text);
  console.log('---');

  const hasHeader = result.text && result.text.includes('🎯 Trampa objetivo');
  const mentionsTrono = result.text && result.text.includes('Sala del Trono');
  const mentionsItem = result.text && result.text.includes('corona rota');
  const mentionsDir = result.text && result.text.includes('norte');

  if (hasHeader && mentionsTrono && mentionsItem && mentionsDir) {
    console.log('✅ DIS-1277 FIX WORKS: Header presente con nombre de sala, ítem y dirección correctos.');
  } else {
    console.log('❌ DIS-1277 FIX FAILED:');
    if (!hasHeader) console.log('   - Falta header 🎯');
    if (!mentionsTrono) console.log('   - Falta nombre de sala');
    if (!mentionsItem) console.log('   - Falta ítem requerido');
    if (!mentionsDir) console.log('   - Falta dirección');
  }
}

runTest().catch(e => { console.error(e); process.exit(1); });
