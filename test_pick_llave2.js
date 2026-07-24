'use strict';

const db = require('./server/db/db');

async function runTest() {
  await db.init();
  
  const PLAYER_ID = 'e284e321-e8d6-4f1f-bd06-ffd536ee6d1e';
  
  // Set used_key_llave_oxidada flag in status_effects
  const player = db.getPlayer(PLAYER_ID);
  const seWithFlag = { ...(player.status_effects || {}), used_key_llave_oxidada: true };
  db.updatePlayer(PLAYER_ID, { status_effects: JSON.stringify(seWithFlag) });
  
  console.log('Set used_key_llave_oxidada = true');
  console.log('Inventory before:', player.inventory);
  
  // Add llave oxidada to floor
  db.updateRoomItems(player.current_room_id, ['llave oxidada', 'pocion de salud']);
  
  // Test pick todo
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
