const db = require('./server/db/db');
const { execute } = require('./server/game/engine');
const { sessionDataMap } = require('./server/socket/handlers');

// Get a player in room 2 (Corredor de las Sombras)
const allPlayers = db.db.prepare('SELECT id, username, current_room_id FROM players WHERE current_room_id = 2').all();
console.log('Players in room 2:', allPlayers.map(p => p.username + ' id:' + p.id));

if (allPlayers.length === 0) {
  console.log('No players in room 2');
  process.exit(0);
}

const playerId = allPlayers[0].id;
console.log('Testing with player:', playerId);

// Simulate /api/action without sessionDataMap entry (fresh)
sessionDataMap.delete(playerId);

const freshP = db.getPlayer(playerId);
sessionDataMap.set(playerId, {
  startTime: Date.now(),
  kills: 0,
  xpStart: freshP ? (freshP.xp || 0) : 0,
  goldStart: freshP ? (freshP.gold || 0) : 0,
  commands: 0,
});

const actionContext = {
  sessionData: sessionDataMap.get(playerId) || null,
  sessionDataMap,
};

console.log('Context:', JSON.stringify(actionContext, (k, v) => k === 'sessionDataMap' ? '[Map]' : v));

try {
  const result = execute(playerId, 'attack goblin', actionContext);
  console.log('Result:', result.text.substring(0, 100));
} catch (err) {
  console.error('ERROR:', err.message);
  console.error('STACK:', err.stack);
}
