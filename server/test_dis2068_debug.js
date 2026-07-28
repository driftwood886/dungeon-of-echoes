/**
 * Test DIS-2068 v2: debug detallado del flujo usar llave
 */
'use strict';

const db = require('./db/db.js');

async function runTest() {
  await db.init();

  // Verificar el estado de sala 7
  const room7 = db.getRoom(7);
  console.log(`[TEST] Sala 7: ${room7.name}`);
  const exits7 = room7.exits; // ya parseado
  console.log(`[TEST] Tipo de exits: ${typeof exits7}`);
  console.log(`[TEST] Sala 7 exits: ${JSON.stringify(exits7)}`);
  console.log(`[TEST] Exit norte: ${JSON.stringify(exits7.north)}`);
  
  // Simular exactamente lo que hace el código
  let keyExits = {};
  try {
    const rawExitsForKey = exits7;
    keyExits = (rawExitsForKey && typeof rawExitsForKey === 'object')
      ? rawExitsForKey
      : JSON.parse(rawExitsForKey || '{}');
  } catch (e) { 
    console.log(`[ERROR] En parse: ${e.message}`);
    keyExits = {}; 
  }
  
  console.log(`\n[TEST] keyExits: ${JSON.stringify(keyExits)}`);
  
  const lockedExitEntries = Object.entries(keyExits).filter(([, v]) => v && typeof v === 'object' && (v.locked || v.key));
  console.log(`[TEST] lockedExitEntries: ${JSON.stringify(lockedExitEntries)}`);
  
  if (lockedExitEntries.length > 0) {
    const [targetDir] = lockedExitEntries[0];
    console.log(`[TEST] Target dir: ${targetDir}`);
    
    // Ahora testear cmdMove
    const engine = require('./game/engine.js');
    const username = 'BotDIS2068debug_' + Date.now();
    let player = db.createPlayer(username);
    const pid = player.id;
    
    db.updatePlayer(pid, {
      level: 5, attack: 15, hp: 60, max_hp: 60,
      player_class: 'guerrero',
      current_room_id: 7,
      inventory: JSON.stringify(['llave oxidada']),
      gold: 50,
      tutorial_done: 1,
    });
    
    player = db.getPlayer(pid);
    console.log(`\n[TEST] Ejecutando usar llave oxidada...`);
    
    try {
      const result = engine.execute(pid, 'usar llave oxidada');
      console.log(`[TEST] Resultado: ${(result.text || result.result || '').substring(0, 300)}`);
      const playerAfter = db.getPlayer(pid);
      console.log(`[TEST] Sala después: ${playerAfter.current_room_id}`);
    } catch (e) {
      console.log(`[ERROR] En execute: ${e.message}`);
      console.log(e.stack);
    }
    
    try { db.deletePlayer(pid); } catch (_) {}
  } else {
    console.log('[TEST] ERROR: No se detectaron salidas con llave');
  }
}

runTest().catch(e => {
  console.error('[TEST ERROR]', e);
}).finally(() => {
  try { db.close(); } catch (_) {}
  process.exit(0);
});
