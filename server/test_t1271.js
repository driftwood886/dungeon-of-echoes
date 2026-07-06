'use strict';
const db = require('./db/db.js');
const engine = require('./game/engine.js');

async function runTest() {
  await db.init();
  console.log('\n=== TEST T1271: Key Consumed Feedback ===\n');

  const ids = db.getAllPlayerIds();
  if (!ids || ids.length === 0) { console.log('No players'); process.exit(1); }
  const playerId = ids[0].id;
  console.log('Player id:', playerId);

  // NOTE: updatePlayer serializes objects, so pass inventory as array (it'll be JSON.stringified)
  db.updatePlayer(playerId, {
    current_room_id: 7,
    inventory: JSON.stringify(['llave oxidada']),
    status_effects: JSON.stringify({})
  });
  let player = db.getPlayer(playerId);
  console.log('Setup: Room', player.current_room_id, '| Inv:', JSON.stringify(player.inventory));

  // Move north (execute uses playerId)
  const result1 = engine.execute(playerId, 'norte');
  const keyFeedback = result1.text.includes('Usás la "llave oxidada"');
  console.log('1. Key feedback shown:', keyFeedback ? '✅ YES' : '❌ NO');
  if (keyFeedback) {
    const idx = result1.text.indexOf('Usás la "llave oxidada"');
    console.log('   Message:', result1.text.substring(idx - 3, idx + 150));
  } else {
    console.log('   (Text ends):', result1.text.substring(Math.max(0, result1.text.length - 350)));
  }

  player = db.getPlayer(playerId);
  console.log('2. Key removed:', !player.inventory.includes('llave oxidada') ? '✅ YES' : '❌ NO', '| Room:', player.current_room_id);

  const result2 = engine.execute(playerId, 'sur');
  const correctMsg = result2.text.includes('se rompió al girar');
  console.log('3. South door "key broken" msg:', correctMsg ? '✅ YES' : '❌ NO');
  console.log('   (first 250):', result2.text.substring(0, 250));

  console.log('\n=== DONE ===');
  process.exit(0);
}

runTest().catch(e => { console.error(e); process.exit(1); });
