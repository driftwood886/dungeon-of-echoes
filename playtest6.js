'use strict';
const db = require('./server/db/db.js');
const engine = require('./server/game/engine.js');

async function run() {
  await db.init();
  
  // Sala 4 tiene salida norte → sala 8 (Prisión Subterránea, boss nivel 4)
  // Bot de nivel 1 debería ver advertencia de DIS-1504
  
  const USERNAME = 'bot_play_6';
  const existing = db.getPlayerByUsername(USERNAME);
  if (existing) db.deletePlayer(existing.id);
  const player = engine.getOrCreatePlayer(USERNAME);
  const pid = player.id;
  engine.execute(pid, 'clase guerrero');
  
  function cmd(command) {
    const r = engine.execute(pid, command, {});
    return r.text || '';
  }

  // Poner bot en sala 4 (Cámara del Tesoro), nivel 1
  db.updatePlayer(pid, { current_room_id: 4, hp: 40, max_hp: 40, level: 1 });
  
  console.log('\n=== TEST DIS-1504: Nivel 1 intentando entrar a Prisión (sala 8) ===');
  const look4 = cmd('look');
  console.log('SALA 4 LOOK:', look4.substring(0, 300));
  
  // Intentar ir al norte (sala 8)
  const warn1 = cmd('north');
  console.log('\nINTENTO 1 (north):');
  console.log(warn1.substring(0, 500));
  
  if (warn1.includes('⚠') || warn1.includes('peligroso') || warn1.includes('recomendado') || warn1.includes('Prisión') || warn1.includes('nivel')) {
    console.log('\n✅ DIS-1504 OK: advertencia preventiva mostrada para sala 8 (Prisión)');
    
    // Segunda vez debería dejar pasar
    db.updatePlayer(pid, { current_room_id: 4 });
    const warn2 = cmd('north');
    console.log('\nINTENTO 2 (debería dejar pasar):');
    console.log(warn2.substring(0, 300));
    if (warn2.includes('Vas hacia') || warn2.includes('Prisión Subterránea') || !warn2.includes('⚠')) {
      console.log('✅ DIS-1504 OK: segundo intento permite entrar');
    } else {
      console.log('⚠️  DIS-1504: segundo intento también bloqueó');
    }
  } else {
    console.log('\n❓ Respuesta sin warning esperado. Revisar.');
  }
  
  // Verificar sala 4 exits
  const sala4 = db.getRoom(4);
  console.log('\nSala 4 exits:', JSON.stringify(sala4 ? sala4.exits : 'N/A'));
  
  // Test adicional: DIS-1502 con jugador fresco recogiendo diente
  console.log('\n=== TEST DIS-1502: Diente afilado tip de crafteo ===');
  const pid2Username = 'bot_play_7';
  const existing2 = db.getPlayerByUsername(pid2Username);
  if (existing2) db.deletePlayer(existing2.id);
  const player2 = engine.getOrCreatePlayer(pid2Username);
  const pid2 = player2.id;
  engine.execute(pid2, 'clase guerrero');
  
  function cmd2(command) {
    const r = engine.execute(pid2, command, {});
    return r.text || '';
  }
  
  // Poner diente afilado en el piso de sala 2 para que el bot lo recoja
  const sala2 = db.getRoom(2);
  const sala2Items = sala2 ? (sala2.items || []) : [];
  // Agregar diente afilado al piso
  db.updateRoom(2, { items: [...sala2Items, 'diente afilado'] });
  
  // Poner bot2 en sala 2
  db.updatePlayer(pid2, { current_room_id: 2, hp: 40, max_hp: 40 });
  
  // Recoger el diente
  const pickupResult = cmd2('pick diente afilado');
  console.log('PICKUP diente afilado:');
  console.log(pickupResult.substring(0, 500));
  
  if (pickupResult.includes('diente')) {
    if (pickupResult.includes('receta') || pickupResult.includes('Tip') || 
        pickupResult.includes('crafteo') || pickupResult.includes('collar') || 
        pickupResult.includes('veneno') || pickupResult.includes('hilo') ||
        pickupResult.includes('ingrediente')) {
      console.log('\n✅ DIS-1502 OK: tip de crafteo mostrado al recoger diente afilado por primera vez');
    } else {
      console.log('\n⚠️  DIS-1502: se recogió el diente pero no hubo tip de crafteo');
      console.log('FULL OUTPUT:', pickupResult);
    }
  }
  
  // Restaurar sala 2
  db.updateRoom(2, { items: sala2Items });
  
  db.deletePlayer(pid);
  db.deletePlayer(pid2);
  
  console.log('\n=== TESTS COMPLETADOS ===');
  process.exit(0);
}
run().catch(e => { console.error('ERROR:', e.message, e.stack); process.exit(1); });
