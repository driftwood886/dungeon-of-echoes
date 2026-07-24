'use strict';

const db = require('./server/db/db');

async function runTest() {
  await db.init();
  
  const testUsername = 'bot_test_llave_8';
  let player = db.getPlayerByUsername(testUsername);
  if (!player) {
    player = db.createPlayer(testUsername);
    console.log('Created test player');
  }
  
  const PLAYER_ID = player.id;
  const engine = require('./server/game/engine');
  
  // --- Test: 'loot' command (alias) in room 7 ---
  console.log('\n=== TEST: loot command in room 7 ===');
  db.updatePlayer(PLAYER_ID, { 
    current_room_id: 7,
    inventory: JSON.stringify([]),
    equipped_weapon: null,
    equipped_armor: null,
    status_effects: JSON.stringify({})
  });
  db.updateRoomItems(7, ['llave oxidada', 'monedas de oro']);
  
  let result = engine.execute(PLAYER_ID, 'loot');
  let p = db.getPlayer(PLAYER_ID);
  let room = db.getRoom(7);
  console.log('Result:', result ? result.text.substring(0, 400) : '(null)');
  console.log('Inventory:', p.inventory);
  console.log('Floor:', room.items);
  console.log('Llave in inv:', p.inventory && p.inventory.includes('llave oxidada') ? 'YES ✅' : 'NO ❌ BUG!');
  
  // --- Test: pick todo after monster death (loot from combat context?) ---
  console.log('\n=== TEST: pick todo right after killing a monster ===');
  // Reset player in room 7 with no inventory  
  db.updatePlayer(PLAYER_ID, { 
    current_room_id: 7,
    inventory: JSON.stringify([]),
    equipped_weapon: null,
    equipped_armor: null,
    status_effects: JSON.stringify({})
  });
  
  // Kill a monster to set loot state
  // Put llave oxidada + other items on floor
  db.updateRoomItems(7, ['llave oxidada', 'daga básica', 'monedas de plata']);
  
  result = engine.execute(PLAYER_ID, 'pick todo');
  p = db.getPlayer(PLAYER_ID);
  room = db.getRoom(7);
  console.log('Result:', result ? result.text.substring(0, 400) : '(null)');
  console.log('Inventory:', p.inventory);
  console.log('Llave in inv:', p.inventory && p.inventory.includes('llave oxidada') ? 'YES ✅' : 'NO ❌ BUG!');
  
  process.exit(0);
}

runTest().catch(e => { console.error(e); process.exit(1); });
