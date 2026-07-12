'use strict';
const db = require('./server/db/db.js');
const engine = require('./server/game/engine.js');

async function run() {
  await db.init();
  
  const USERNAME = 'bot_play_9';
  const existing = db.getPlayerByUsername(USERNAME);
  if (existing) db.deletePlayer(existing.id);
  const player = engine.getOrCreatePlayer(USERNAME);
  const pid = player.id;
  engine.execute(pid, 'clase guerrero');
  
  function cmd(command) {
    const r = engine.execute(pid, command, {});
    return r.text || '';
  }
  
  // Poner diente afilado en el piso de sala 2 usando updateRoomItems
  const sala2 = db.getRoom(2);
  const sala2Items = sala2 ? (sala2.items || []) : [];
  console.log('Sala 2 items actuales:', sala2Items);
  
  db.updateRoomItems(2, [...sala2Items, 'diente afilado']);
  
  // Poner bot en sala 2
  db.updatePlayer(pid, { current_room_id: 2, hp: 40, max_hp: 40 });
  
  // Recoger el diente
  console.log('\n=== TEST DIS-1502: Tip de crafteo al recoger diente afilado ===');
  const pickupResult = cmd('pick diente afilado');
  console.log('PICKUP diente afilado:');
  console.log(pickupResult.substring(0, 600));
  
  if (pickupResult.includes('diente')) {
    if (pickupResult.includes('receta') || pickupResult.includes('Tip') || pickupResult.includes('tip') ||
        pickupResult.includes('crafteo') || pickupResult.includes('collar') || 
        pickupResult.includes('veneno') || pickupResult.includes('hilo') ||
        pickupResult.includes('artesanía') || pickupResult.includes('artesan')) {
      console.log('\n✅ DIS-1502 OK: tip de crafteo mostrado al recoger diente afilado');
    } else {
      console.log('\n⚠️  DIS-1502: se recogió el diente sin tip de crafteo');
      console.log('FULL:', pickupResult);
    }
  } else {
    console.log('❓ No se recogió el diente. Respuesta:', pickupResult.substring(0, 300));
    // Intentar con 'recoger'
    const r2 = cmd('recoger diente afilado');
    console.log('recoger:', r2.substring(0, 300));
  }
  
  // Restaurar sala
  db.updateRoomItems(2, sala2Items);
  db.deletePlayer(pid);
  
  process.exit(0);
}
run().catch(e => { console.error('ERROR:', e.message, '\n', e.stack); process.exit(1); });
