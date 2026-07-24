'use strict';

const db = require('./server/db/db');

async function runTest() {
  await db.init();
  
  const PLAYER_ID = 'e284e321-e8d6-4f1f-bd06-ffd536ee6d1e';
  
  // Set inventory almost full (base is 10 slots, fill up 9 with items, no equipped)
  const player = db.getPlayer(PLAYER_ID);
  const fullInv = ['item1','item2','item3','item4','item5','item6','item7','item8','item9'];
  db.updatePlayer(PLAYER_ID, { inventory: JSON.stringify(fullInv) });
  
  console.log('Set inventory to 9/10 items');
  
  // Add llave oxidada + 2 other items to floor (so one item won't fit)
  db.updateRoomItems(player.current_room_id, ['llave oxidada', 'espada oxidada', 'pocion de salud']);
  
  // Test pick todo — should pick one item, then be full, llave oxidada should not be silently dropped
  const engine = require('./server/game/engine');
  const result = engine.execute(PLAYER_ID, 'pick todo');
  console.log('Pick todo result:', result ? result.text : '(null)');
  
  // Check inventory
  const playerAfter = db.getPlayer(PLAYER_ID);
  console.log('Inventory after pick todo:', playerAfter.inventory);
  
  const includes_llave = playerAfter.inventory && playerAfter.inventory.includes('llave oxidada');
  console.log('Has llave oxidada:', includes_llave ? 'YES ✅' : 'NO ❌');
  
  process.exit(0);
}

runTest().catch(e => { console.error(e); process.exit(1); });
