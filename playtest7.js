'use strict';
const db = require('./server/db/db.js');
const engine = require('./server/game/engine.js');

async function run() {
  await db.init();
  
  // Buscar función para actualizar sala
  console.log('DB sala functions:', Object.keys(db).filter(k => k.toLowerCase().includes('room')).join(', '));
  
  const USERNAME = 'bot_play_8';
  const existing = db.getPlayerByUsername(USERNAME);
  if (existing) db.deletePlayer(existing.id);
  const player = engine.getOrCreatePlayer(USERNAME);
  const pid = player.id;
  engine.execute(pid, 'clase guerrero');
  
  function cmd(command) {
    const r = engine.execute(pid, command, {});
    return r.text || '';
  }
  
  // En lugar de poner el diente en el piso, verificamos el código directamente
  // Buscar en engine.js si hay tip al hacer pickup de diente afilado
  const engineCode = require('fs').readFileSync('./server/game/engine.js', 'utf8');
  const idx = engineCode.indexOf('DIS-1502');
  if (idx >= 0) {
    console.log('\nDIS-1502 código en engine.js:');
    console.log(engineCode.substring(idx, idx + 800));
  }
  
  db.deletePlayer(pid);
  process.exit(0);
}
run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
