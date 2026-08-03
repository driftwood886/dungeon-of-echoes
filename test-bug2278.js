// Test script for BUG-2278: hablar anciano vs hablar vartan
const db = require('./server/db/db.js');

async function main() {
  await db.init();
  
  const player = db.getPlayerByUsername('testbot');
  if (!player) {
    console.log('ERROR: testbot not found');
    return;
  }
  
  // Give player some kills and deaths to trigger the memory suffix
  db.updatePlayer(player.id, {
    level: 5,
    kills: 10,
    deaths: 2,
    xp: 400,
    current_room_id: 1  // Room 1 = Entrada de la Cripta
  });
  
  const updatedPlayer = db.getPlayer(player.id);
  console.log('Player state:', JSON.stringify({
    level: updatedPlayer.level,
    kills: updatedPlayer.kills,
    deaths: updatedPlayer.deaths,
    current_room_id: updatedPlayer.current_room_id,
    npc_memory: updatedPlayer.npc_memory
  }));
  
  console.log('\nDone — now test via API with hablar anciano and hablar vartan');
}

main().catch(console.error);
