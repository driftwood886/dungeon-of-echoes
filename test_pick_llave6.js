'use strict';

const db = require('./server/db/db');

async function runTest() {
  await db.init();
  
  const PLAYER_ID = 'e284e321-e8d6-4f1f-bd06-ffd536ee6d1e';
  
  let player = db.getPlayer(PLAYER_ID);
  if (!player) { console.log('Player not found'); process.exit(1); }
  
  // Move player to room 7 (Pozo Sin Fondo - has locked door)
  db.updatePlayer(PLAYER_ID, { 
    current_room_id: 7,
    inventory: JSON.stringify(['hierba curativa']),
    equipped_weapon: null,
    equipped_armor: null 
  });
  
  player = db.getPlayer(PLAYER_ID);
  console.log('Player in room:', player.current_room_id);
  
  // Add llave oxidada to floor of room 7
  db.updateRoomItems(7, ['llave oxidada', 'pocion de salud']);
  
  // Test pick todo
  const engine = require('./server/game/engine');
  const result = engine.execute(PLAYER_ID, 'pick todo');
  console.log('Pick todo result:', result ? result.text.substring(0, 500) : '(null)');
  
  // Check inventory
  const playerAfter = db.getPlayer(PLAYER_ID);
  console.log('Inventory after:', playerAfter.inventory);
  
  const includes_llave = playerAfter.inventory && playerAfter.inventory.includes('llave oxidada');
  console.log('\nLlave in inventory:', includes_llave ? 'YES ✅' : 'NO ❌ BUG!');
  
  process.exit(0);
}

runTest().catch(e => { console.error(e); process.exit(1); });
