'use strict';

const db = require('./server/db/db');

async function runTest() {
  await db.init();
  
  const PLAYER_ID = 'e284e321-e8d6-4f1f-bd06-ffd536ee6d1e';
  
  // Set inventory completely full (10 items, no equipped weapon/armor)
  const player = db.getPlayer(PLAYER_ID);
  const fullInv = ['item1','item2','item3','item4','item5','item6','item7','item8','item9','item10'];
  db.updatePlayer(PLAYER_ID, { 
    inventory: JSON.stringify(fullInv),
    equipped_weapon: null,
    equipped_armor: null 
  });
  
  console.log('Set inventory to 10/10 items (full)');
  
  // Add llave oxidada to floor (should NOT be silently dropped)
  db.updateRoomItems(player.current_room_id, ['llave oxidada', 'pocion de salud']);
  
  // Test pick todo — inventory is full, so nothing should be picked
  const engine = require('./server/game/engine');
  const result = engine.execute(PLAYER_ID, 'pick todo');
  console.log('Pick todo result:', result ? result.text : '(null)');
  
  // Check floor — items should still be there
  const roomAfter = db.getRoom(player.current_room_id);
  console.log('Floor after pick todo:', roomAfter.items);
  
  process.exit(0);
}

runTest().catch(e => { console.error(e); process.exit(1); });
