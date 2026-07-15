'use strict';
// Test BUG-1645: duplicated room description when achievement unlocked on move
const db = require('./db/db.js');
const engine = require('./game/engine.js');

async function runTest() {
  await db.init();

  const ids = db.getAllPlayerIds();
  if (!ids || ids.length === 0) { console.log('No players in DB'); process.exit(1); }
  const PID = ids[0].id;
  console.log('Using player:', PID);

  // Setup: set gold = 100 (threshold for "rico"), clear achievements, put in sala 1
  const player = db.getPlayer(PID);
  const se = (player.status_effects && typeof player.status_effects === 'string') 
    ? player.status_effects : '{}';
  
  db.updatePlayer(PID, {
    gold: 100,
    achievements: '[]',
    current_room_id: 1
  });

  const p2 = db.getPlayer(PID);
  console.log('Setup: gold=' + p2.gold + ', room=' + p2.room_id + ', achievements=' + p2.achievements);
  console.log('\n--- Executing: norte ---');

  const result = engine.execute(PID, 'norte');
  const text = result.text || '';
  
  console.log('\nRESULT TEXT:');
  console.log(text);
  console.log('\n--- ANALYSIS ---');

  // Count room headers (=== NOMBRE ===)
  const roomHeaders = text.match(/===\s+[^\n]+\s+===/g) || [];
  console.log('Room headers found:', roomHeaders.length, roomHeaders);

  if (roomHeaders.length > 1) {
    console.log('\n!!! BUG-1645 REPRODUCED: ' + roomHeaders.length + ' room headers !!!');
  } else if (roomHeaders.length === 1) {
    console.log('\nNo duplication — single room header. Bug not reproduced with this setup.');
    console.log('(Might need gold exactly going from <100 to >=100 during move, not starting at 100)');
  } else {
    console.log('\nNo room header at all — move may have failed or player not in sala 1.');
    console.log('Result:', result);
  }
  
  process.exit(0);
}

runTest().catch(err => { console.error(err); process.exit(1); });
