'use strict';
const db = require('./server/db/db.js');
const engine = require('./server/game/engine.js');

async function run() {
  await db.init();

  // Las salas están en la DB, no en el objeto ROOMS estático
  // Buscar salas que conecten con sala 8
  const allRooms = db.getAllRoomsWithExits ? db.getAllRoomsWithExits() : null;
  
  // Buscar qué salas llevan a boss rooms desde la DB
  console.log('=== BUSCANDO CONEXIONES DE SALAS DESDE DB ===');
  try {
    // Intentar consultar directamente
    const testRoom = db.getRoom(2);
    console.log('Sala 2 (corredor) exits:', JSON.stringify(testRoom ? testRoom.exits : 'N/A'));
    const testRoom5 = db.getRoom(5);
    console.log('Sala 5 (capilla) exits:', JSON.stringify(testRoom5 ? testRoom5.exits : 'N/A'));
    const testRoom7 = db.getRoom(7);
    console.log('Sala 7 (pozo) exits:', JSON.stringify(testRoom7 ? testRoom7.exits : 'N/A'));
    const testRoom8 = db.getRoom(8);
    console.log('Sala 8 (prisión) exits:', JSON.stringify(testRoom8 ? testRoom8.exits : 'N/A'));
    const testRoom10 = db.getRoom(10);
    console.log('Sala 10 exits:', JSON.stringify(testRoom10 ? testRoom10.exits : 'N/A'));
  } catch(e) {
    console.log('ERROR:', e.message);
  }
  
  // Buscar desde el dungeon module qué dice de cada sala
  const dungeon = require('./server/game/dungeon.js');
  console.log('\n=== DUNGEON.ROOMS KEYS:', Object.keys(dungeon.ROOMS || {}).join(', '));
  const r8d = dungeon.ROOMS && dungeon.ROOMS[8];
  console.log('dungeon.ROOMS[8]:', JSON.stringify(r8d ? r8d.exits : 'undefined'));
  
  process.exit(0);
}
run().catch(e => { console.error(e); process.exit(1); });
