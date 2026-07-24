'use strict';

const db = require('./server/db/db');

async function runTest() {
  await db.init();
  
  const PLAYER_ID = 'e284e321-e8d6-4f1f-bd06-ffd536ee6d1e';
  
  // Get player
  const player = db.getPlayer(PLAYER_ID);
  console.log('Player:', player.username, 'Room:', player.current_room_id);
  console.log('Inventory before:', player.inventory);
  
  // Add llave oxidada to floor
  const room = db.getRoom(player.current_room_id);
  db.updateRoomItems(room.id, ['llave oxidada', 'pocion de salud']);
  const roomAfter = db.getRoom(room.id);
  console.log('Floor after adding:', roomAfter.items);
  
  // Now test pick todo via the engine using 'execute'
  const engine = require('./server/game/engine');
  const result = engine.execute(PLAYER_ID, 'pick todo');
  console.log('Pick todo result:', result ? result.text : '(null)');
  
  // Check inventory
  const playerAfter = db.getPlayer(PLAYER_ID);
  console.log('Inventory after pick todo:', playerAfter.inventory);
  
  const includes_llave = playerAfter.inventory && playerAfter.inventory.includes('llave oxidada');
  console.log('Has llave oxidada:', includes_llave ? 'YES ✅' : 'NO ❌ BUG!');
  
  process.exit(0);
}

runTest().catch(e => { console.error(e); process.exit(1); });
