'use strict';
const db = require('./server/db/db.js');
const engine = require('./server/game/engine.js');
const dungeon = require('./server/game/dungeon.js');

async function run() {
  await db.init();

  // Buscar qué sala lleva a sala 8
  const allRooms = dungeon.ROOMS || {};
  console.log('=== MAPA DE RUTAS A SALAS DE BOSS ===');
  const bossRooms = [8, 10, 12, 19, 20];
  for (const bossId of bossRooms) {
    const sourceSalas = [];
    for (const [roomId, roomData] of Object.entries(allRooms)) {
      if (!roomData || !roomData.exits) continue;
      for (const [dir, destId] of Object.entries(roomData.exits)) {
        if (destId === bossId) sourceSalas.push({ fromRoom: roomId, dir, toRoom: bossId });
      }
    }
    console.log(`Boss sala ${bossId}: accesible desde ${JSON.stringify(sourceSalas)}`);
  }
  
  const USERNAME = 'bot_play_5';
  const existing = db.getPlayerByUsername(USERNAME);
  if (existing) db.deletePlayer(existing.id);
  const player = engine.getOrCreatePlayer(USERNAME);
  const pid = player.id;
  engine.execute(pid, 'clase guerrero');
  
  function cmd(command) {
    const r = engine.execute(pid, command, {});
    return r.text || '';
  }
  
  // Encontrar sala que lleva a boss 8
  const roomLeadsToBoss8 = Object.entries(allRooms).find(([rId, rData]) => {
    if (!rData || !rData.exits) return false;
    return Object.values(rData.exits).includes(8);
  });
  
  if (roomLeadsToBoss8) {
    const [srcRoomId, srcData] = roomLeadsToBoss8;
    const dirToBoss = Object.entries(srcData.exits).find(([d, t]) => t === 8)[0];
    console.log(`\n=== TEST DIS-1504: desde sala ${srcRoomId} → ${dirToBoss} → sala 8 ===`);
    
    db.updatePlayer(pid, { current_room_id: parseInt(srcRoomId), hp: 40, max_hp: 40, level: 1 });
    const lookSrc = cmd('look');
    console.log('SALA ORIGEN:', lookSrc.substring(0, 200));
    
    const warn1 = cmd(dirToBoss);
    console.log(`\nINTENTO 1 (${dirToBoss}):`, warn1.substring(0, 400));
    
    // Si hubo warning, intentar de nuevo
    if (warn1.includes('⚠') || warn1.includes('peligroso') || warn1.includes('recomendado')) {
      console.log('✅ DIS-1504 OK: advertencia preventiva mostrada');
      db.updatePlayer(pid, { current_room_id: parseInt(srcRoomId) });
      const warn2 = cmd(dirToBoss);
      console.log(`\nINTENTO 2 (debería dejar pasar):`, warn2.substring(0, 200));
      if (!warn2.includes('⚠') || warn2.includes('Vas hacia')) {
        console.log('✅ DIS-1504 OK: segunda vez deja pasar');
      }
    } else {
      console.log('⚠️  No se disparó advertencia. Respuesta:', warn1.substring(0, 300));
    }
  }
  
  db.deletePlayer(pid);
  process.exit(0);
}

run().catch(e => { console.error('ERROR:', e); process.exit(1); });
