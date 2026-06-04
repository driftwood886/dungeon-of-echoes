// Test script para BUG-045
const db = require('./server/db/db.js');
db.init();

async function main() {
  const players = db.getAllPlayers();
  const testPlayer = players.find(p => p.username === 'BUGTest044');
  
  if (!testPlayer) {
    console.log('Player not found. Available:', players.slice(0, 5).map(p => p.username));
    return;
  }
  
  console.log('Player:', testPlayer.username, 'Room:', testPlayer.current_room_id);
  
  // Darle items de crafteo
  const newInv = ['diente afilado', 'hilo de seda'];
  db.updatePlayer(testPlayer.id, { inventory: JSON.stringify(newInv) });
  
  const updated = db.getPlayer(testPlayer.id);
  console.log('New inventory:', updated.inventory);
  
  // Persistir
  db.persist();
  console.log('Persistido OK');
}

main().catch(console.error);
