'use strict';
const db = require('./server/db/db.js');
const engine = require('./server/game/engine.js');

async function run() {
  await db.init();
  
  const USERNAME = 'bot_mago_test';
  const existing = db.getPlayerByUsername(USERNAME);
  if (existing) db.deletePlayer(existing.id);
  const player = engine.getOrCreatePlayer(USERNAME);
  const pid = player.id;
  engine.execute(pid, 'clase mago');
  
  // Nivel 3 para que tenga fireball
  db.updatePlayer(pid, { level: 3, xp: 180, hp: 25, max_hp: 25, attack: 8, gold: 150, current_room_id: 3 });
  
  function cmd(command) {
    const r = engine.execute(pid, command, {});
    return r.text || '';
  }
  
  console.log('=== PLAYTEST MAGO NIVEL 3 ===\n');
  console.log(cmd('status').substring(0, 200));
  console.log('\nSkills:');
  console.log(cmd('skills').substring(0, 400));
  
  // Combate
  cmd('look');
  cmd('attack');
  const fireResult = cmd('fireball');
  console.log('\nfireball:', fireResult.substring(0, 300));
  cmd('attack');
  cmd('attack');
  cmd('attack');
  cmd('pick todo');
  cmd('inventory');
  
  // Test postura defensiva
  const posturaResult = cmd('postura_defensiva');
  console.log('\npostura_defensiva:', posturaResult.substring(0, 200));
  
  // Examinar pared en sala 2 (Corredor de las Sombras) — lore
  db.updatePlayer(pid, { current_room_id: 2 });
  const examResult = cmd('examine pared');
  console.log('\nexamine pared:', examResult.substring(0, 300));
  
  // Verificar diario
  const loreResult = cmd('lore');
  console.log('\nlore después de examine:', loreResult.substring(0, 300));
  
  // Test lore read en sala 9 (Sala del Trono)
  db.updatePlayer(pid, { current_room_id: 9, hp: 25 });
  const readResult = cmd('read');
  console.log('\nread en Sala del Trono (sala 9):', readResult.substring(0, 400));
  
  // Verificar que se guardó en lore
  const loreAfterRead = cmd('lore');
  console.log('\nlore después de read en sala 9:', loreAfterRead.substring(0, 400));
  
  db.deletePlayer(pid);
  console.log('\n=== MAGO TEST COMPLETADO ===');
  process.exit(0);
}
run().catch(e => { console.error(e); process.exit(1); });
