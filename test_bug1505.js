'use strict';
const db = require('./server/db/db.js');
const engine = require('./server/game/engine.js');

async function run() {
  await db.init();
  
  const USERNAME = 'bot_bug1505';
  const existing = db.getPlayerByUsername(USERNAME);
  if (existing) db.deletePlayer(existing.id);
  const player = engine.getOrCreatePlayer(USERNAME);
  const pid = player.id;
  engine.execute(pid, 'clase guerrero');
  
  // Nivel alto para poder matar el esqueleto rápido
  db.updatePlayer(pid, { level: 5, xp: 450, hp: 50, max_hp: 50, attack: 15, current_room_id: 3 });
  
  function cmd(command) {
    const r = engine.execute(pid, command, {});
    return r.text || '';
  }
  
  console.log('=== TEST BUG-1505: Aldric comenta la muerte del Esqueleto ===\n');
  
  // Asegurar que el esqueleto esté vivo
  const esqueleto = db.getMonster(2);
  if (esqueleto && esqueleto.hp <= 0) {
    db.updateMonster(2, { hp: 20 });
  }
  
  cmd('look');
  
  let aldricReacted = false;
  for (let i = 0; i < 6; i++) {
    const atk = cmd('attack esqueleto guerrero');
    console.log(`ATK ${i+1}:`, atk.substring(0, 300));
    if (atk.includes('Aldric')) {
      aldricReacted = true;
      console.log('\n✅ BUG-1505 FIX OK: Aldric reaccionó a la muerte del Esqueleto (sala 3)');
      break;
    }
    if (atk.includes('no hay') || atk.includes('No hay')) break;
  }
  
  if (!aldricReacted) {
    console.log('\n❌ BUG-1505: Aldric no reaccionó (fix falló)');
  }
  
  db.deletePlayer(pid);
  process.exit(0);
}
run().catch(e => { console.error(e); process.exit(1); });
