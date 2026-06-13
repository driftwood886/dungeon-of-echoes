const db = require('./server/db/db.js');
db.init('./db/dungeon.db');

const player = db.getPlayer(process.argv[2]);
if (!player) { console.log('No player found'); process.exit(1); }
console.log('player level:', player.level, 'kills:', player.kills, 'guild:', player.guild);
console.log('achievements raw:', player.achievements ? player.achievements.substring(0,100) : 'null');

const engine = require('./server/game/engine.js');
try {
  const result = engine.execute(player.id, 'status');
  console.log('OK:', JSON.stringify(result).substring(0,200));
} catch(e) {
  console.error('ERROR:', e.message);
  console.error(e.stack.split('\n').slice(0,8).join('\n'));
}
