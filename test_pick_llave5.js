'use strict';

const db = require('./server/db/db');

async function runTest() {
  await db.init();
  
  const PLAYER_ID = 'e284e321-e8d6-4f1f-bd06-ffd536ee6d1e';
  
  // Set inventory completely full (10 items, no equipped weapon/armor)
  let player = db.getPlayer(PLAYER_ID);
  if (!player) { console.log('Player not found'); process.exit(1); }
  
  const fullInv = ['item1','item2','item3','item4','item5','item6','item7','item8','item9','item10'];
  db.updatePlayer(PLAYER_ID, { 
    inventory: JSON.stringify(fullInv),
    equipped_weapon: null,
    equipped_armor: null 
  });
  
  player = db.getPlayer(PLAYER_ID);
  console.log('Inventory set to:', player.inventory.length, 'items');
  
  // Add llave oxidada to floor
  db.updateRoomItems(player.current_room_id, ['llave oxidada', 'pocion de salud']);
  
  // Test pick todo — inventory is full, so nothing should fit
  const engine = require('./server/game/engine');
  const result = engine.execute(PLAYER_ID, 'pick todo');
  console.log('Pick todo result:', result ? result.text : '(null)');
  
  // Check inventory
  const playerAfter = db.getPlayer(PLAYER_ID);
  console.log('Inventory after:', playerAfter.inventory);
  console.log('Inventory length:', playerAfter.inventory ? playerAfter.inventory.length : 'null');
  
  // Check floor
  const roomAfter = db.getRoom(player.current_room_id);
  console.log('Floor after:', roomAfter.items);
  
  const includes_llave = playerAfter.inventory && playerAfter.inventory.includes('llave oxidada');
  const floorHasLlave = roomAfter.items && roomAfter.items.includes('llave oxidada');
  console.log('\n--- RESULT ---');
  console.log('Llave in inventory:', includes_llave ? 'YES ✅' : 'NO ❌');
  console.log('Llave on floor:', floorHasLlave ? 'YES ✅' : 'NO ❌ (GONE!)');
  
  process.exit(0);
}

runTest().catch(e => { console.error(e); process.exit(1); });
