'use strict';

const db = require('./server/db/db');

async function runTest() {
  await db.init();
  
  // Create a test player
  const testUsername = 'bot_test_llave_7';
  let player = db.getPlayerByUsername(testUsername);
  if (!player) {
    player = db.createPlayer(testUsername);
    console.log('Created test player:', testUsername);
  }
  
  const PLAYER_ID = player.id;
  
  // --- Test 1: Normal case (room 7, llave oxidada on floor) ---
  console.log('\n=== TEST 1: Room 7, normal inventory ===');
  db.updatePlayer(PLAYER_ID, { 
    current_room_id: 7,
    inventory: JSON.stringify(['hierba curativa']),
    equipped_weapon: null,
    equipped_armor: null,
    status_effects: JSON.stringify({})
  });
  
  db.updateRoomItems(7, ['llave oxidada', 'pocion de salud']);
  
  const engine = require('./server/game/engine');
  let result = engine.execute(PLAYER_ID, 'pick todo');
  let p = db.getPlayer(PLAYER_ID);
  let room = db.getRoom(7);
  console.log('Result:', result ? result.text.substring(0, 300) : '(null)');
  console.log('Inventory:', p.inventory);
  console.log('Floor:', room.items);
  console.log('Llave in inv:', p.inventory && p.inventory.includes('llave oxidada') ? 'YES ✅' : 'NO ❌ BUG!');
  
  // --- Test 2: With used_key flag set ---
  console.log('\n=== TEST 2: With used_key_llave_oxidada flag ===');
  db.updatePlayer(PLAYER_ID, { 
    current_room_id: 7,
    inventory: JSON.stringify([]),
    status_effects: JSON.stringify({ used_key_llave_oxidada: true })
  });
  db.updateRoomItems(7, ['llave oxidada', 'pocion de salud']);
  
  result = engine.execute(PLAYER_ID, 'pick todo');
  p = db.getPlayer(PLAYER_ID);
  room = db.getRoom(7);
  console.log('Result:', result ? result.text.substring(0, 300) : '(null)');
  console.log('Inventory:', p.inventory);
  console.log('Llave in inv:', p.inventory && p.inventory.includes('llave oxidada') ? 'YES ✅' : 'NO ❌ BUG!');
  
  // --- Test 3: Pick single llave oxidada (not pick todo) ---
  console.log('\n=== TEST 3: pick llave oxidada (single pick) ===');
  db.updatePlayer(PLAYER_ID, { 
    current_room_id: 7,
    inventory: JSON.stringify([]),
    status_effects: JSON.stringify({})
  });
  db.updateRoomItems(7, ['llave oxidada']);
  
  result = engine.execute(PLAYER_ID, 'pick llave oxidada');
  p = db.getPlayer(PLAYER_ID);
  room = db.getRoom(7);
  console.log('Result:', result ? result.text.substring(0, 500) : '(null)');
  console.log('Inventory:', p.inventory);
  console.log('Floor:', room.items);
  console.log('Llave in inv:', p.inventory && p.inventory.includes('llave oxidada') ? 'YES ✅' : 'NO ❌ BUG!');
  
  process.exit(0);
}

runTest().catch(e => { console.error(e); process.exit(1); });
