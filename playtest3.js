'use strict';
const db = require('./server/db/db.js');
const engine = require('./server/game/engine.js');

async function run() {
  await db.init();
  
  const USERNAME = 'bot_play_4';
  const existing = db.getPlayerByUsername(USERNAME);
  if (existing) db.deletePlayer(existing.id);
  
  const player = engine.getOrCreatePlayer(USERNAME);
  const pid = player.id;
  engine.execute(pid, 'clase guerrero');
  
  function cmd(command) {
    const r = engine.execute(pid, command, {});
    return r.text || '';
  }
  
  // Preparar jugador nivel 1 en sala 2 (corredor), cerca de sala 8 (Prisión)
  db.updatePlayer(pid, { current_room_id: 2, hp: 40, max_hp: 40, level: 1 });
  
  console.log('\n=== TEST DIS-1504: Advertencia preventiva de boss ===');
  console.log('NIVEL 1 - Intento de entrar a Prisión (sala 8, boss nivel 4)');
  
  // Ver salidas del corredor
  const look = cmd('look');
  console.log('CORREDOR SALIDAS:', look.substring(0, 300));
  
  // Ir abajo (down) que va al Sótano / otra sala
  const downResult = cmd('down');
  console.log('DOWN desde sala 2:', downResult.substring(0, 300));
  cmd('look');
  
  // Necesitamos llegar a una sala adyacente a sala 8
  // Sala 8 = Prisión Subterránea
  // Revisemos el mapa: desde sala 2 (corredor) al west → sala 5 (Capilla Olvidada)
  // Capilla tiene down → Pozo Sin Fondo (sala 7)
  // Desde Pozo hay puerta al norte (sala 10/Santuario)
  // La Prisión (sala 8) podría estar accesible desde sala 2 por south
  // O necesitamos buscar qué sala lleva a sala 8
  
  // Forzar estado para probar directamente
  // Poner jugador en sala 5 (Capilla) y tratar ir a sala 8
  db.updatePlayer(pid, { current_room_id: 5, hp: 40, level: 1 });
  const look5 = cmd('look');
  console.log('\nSALA 5 (Capilla) SALIDAS:', look5.substring(0, 400));
  
  // Probar todas las direcciones
  const dirs = ['north', 'south', 'east', 'west', 'up', 'down'];
  for (const dir of dirs) {
    db.updatePlayer(pid, { current_room_id: 5 });
    const r = cmd(dir);
    if (!r.includes('No hay salida')) {
      console.log(`  ${dir}:`, r.substring(0, 200));
    }
  }
  
  // Buscar qué salas son adyacentes a la sala 8
  const dungeon = require('./server/game/dungeon.js');
  const rooms = dungeon.ROOMS || {};
  const sala8Exits = rooms[8] ? (rooms[8].exits || {}) : {};
  console.log('\nSALA 8 EXITS:', JSON.stringify(sala8Exits));
  
  // Buscar qué sala lleva a sala 8 (buscar en todas las salas cuáles apuntan a 8)
  const keys = Object.keys(rooms);
  for (const k of keys) {
    const exits = rooms[k] ? (rooms[k].exits || {}) : {};
    for (const [dir, destId] of Object.entries(exits)) {
      if (destId === 8) {
        console.log(`  Sala ${k} → ${dir} → sala 8`);
      }
    }
  }
  
  // Ahora probar desde la sala correcta
  const sala8 = rooms[8];
  if (sala8) {
    const firstExit = Object.entries(sala8.exits || {})[0];
    if (firstExit) {
      const [dir, adjSala] = firstExit;
      console.log(`\nSala 8 tiene salida '${dir}' hacia sala ${adjSala}`);
      console.log(`Para llegar a sala 8, necesitamos estar en una sala que tenga salida hacia 8`);
    }
  }
  
  db.deletePlayer(pid);
  process.exit(0);
}

run().catch(e => { console.error('ERROR:', e); process.exit(1); });
