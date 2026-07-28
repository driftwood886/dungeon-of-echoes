/**
 * Test DIS-2068 v3: debug del error dentro de isKeyItem
 */
'use strict';

const db = require('./db/db.js');

async function runTest() {
  await db.init();

  const username = 'BotDIS2068v3_' + Date.now();
  let player = db.createPlayer(username);
  const pid = player.id;

  db.updatePlayer(pid, {
    level: 5,
    attack: 15,
    hp: 60,
    max_hp: 60,
    player_class: 'guerrero',
    current_room_id: 7,
    inventory: JSON.stringify(['llave oxidada']),
    gold: 50,
  });

  player = db.getPlayer(pid);
  
  // Simular el bloque isKeyItem directamente
  const engine = require('./game/engine.js');
  
  // Acceder a funciones internas via una llamada que exponga el error
  // Forzar el execute pero con un wrapper que captura errores
  try {
    const room7 = db.getRoom(7);
    const exits = room7.exits;
    console.log('[DEBUG] exits type:', typeof exits);
    console.log('[DEBUG] exits:', JSON.stringify(exits));
    
    const lockedEntries = Object.entries(exits).filter(([, v]) => v && typeof v === 'object' && (v.locked || v.key));
    console.log('[DEBUG] lockedEntries:', JSON.stringify(lockedEntries));
    
    if (lockedEntries.length > 0) {
      const [targetDir] = lockedEntries[0];
      console.log('[DEBUG] targetDir:', targetDir);
      
      // Intentar hacer lo que hace cmdMove internamente
      // El jugador tiene tutorial pendiente? Verificar si hay guard de tutorial
      const freshPlayer = db.getPlayer(pid);
      console.log('[DEBUG] player:', JSON.stringify({
        id: freshPlayer.id,
        current_room_id: freshPlayer.current_room_id,
        player_class: freshPlayer.player_class,
        level: freshPlayer.level,
        inventory: freshPlayer.inventory
      }));
      
      // Ejecutar directamente el comando norte para simular cmdMove
      console.log('\n[DEBUG] Ejecutando: norte');
      const northResult = engine.execute(pid, 'norte');
      console.log('[DEBUG] norte result:', (northResult.text || northResult.result || '').substring(0, 400));
      
      const afterNorth = db.getPlayer(pid);
      console.log('[DEBUG] sala después de norte:', afterNorth.current_room_id);
    }
  } catch (e) {
    console.error('[ERROR]', e.message);
    console.error(e.stack);
  }

  try { db.deletePlayer(pid); } catch (_) {}
}

runTest().catch(e => {
  console.error('[FATAL]', e);
}).finally(() => {
  try { db.close(); } catch (_) {}
  process.exit(0);
});
