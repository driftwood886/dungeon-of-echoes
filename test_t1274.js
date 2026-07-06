// T1274 Test: Verify warning from Sala del Trono (9) → Túnel de Hongos (6) says "sur" not "norte"
const db = require('./server/db/db.js');
const { seedIfEmpty } = require('./server/db/seed.js');

db.init('./db/dungeon.sqlite');
seedIfEmpty();

const PID = 'a648839e-9b5b-4a3f-8092-611f98c13ef9';

const p = db.getPlayer(PID);
if (!p) { console.log('Player not found'); process.exit(1); }

// Reset state: teleport to room 9, clear known_traps for room 6, clear hongo_warning_done
const kt = typeof p.known_traps === 'string' ? JSON.parse(p.known_traps || '{}') : (p.known_traps || {});
delete kt['6']; delete kt[6];
const se = typeof p.status_effects === 'string' ? JSON.parse(p.status_effects || '{}') : (p.status_effects || {});
delete se.hongo_warning_done;
db.updatePlayer(PID, { current_room_id: 9, known_traps: JSON.stringify(kt), status_effects: JSON.stringify(se) });

// Make room 6 trap active
const room6 = db.getRoom(6);
if (room6.trap) {
  db.updateRoomTrap(6, { ...room6.trap, active: true, respawn_at: null });
} else {
  console.log('ERROR: Room 6 has no trap!');
  process.exit(1);
}

console.log('Setup complete. Player in room 9. Room 6 trap active.');
console.log('Room 6 trap:', JSON.stringify(db.getRoom(6).trap));

// Process command
const engine = require('./server/game/engine.js');
const result = engine.processCommand(PID, 'sur');
console.log('\n=== RESPONSE ===');
console.log(result && result.text ? result.text : JSON.stringify(result));

if (result && result.text) {
  if (result.text.includes('desactivar trampa sur')) {
    console.log('\n✅ T1274 FIX WORKS: Warning correctly says "desactivar trampa sur"');
  } else if (result.text.includes('desactivar trampa norte')) {
    console.log('\n❌ T1274 FIX FAILED: Warning still says "desactivar trampa norte"');
  } else {
    console.log('\n⚠️  Warning not triggered (player may have been let through)');
    const p2 = db.getPlayer(PID);
    console.log('Player now in room:', p2.current_room_id);
  }
}
