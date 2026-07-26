// Test para reproducir BUG-2004: loot duplicado en bosses
'use strict';

const db = require('./server/db/db');
const { dropLoot } = require('./server/game/combat');

// Simular un kill de Guardia Espectral (id=8)
const monster = db.getMonster(8);
console.log('Monster loot from DB:', JSON.stringify(monster.loot));

// Estado de sala antes del kill
const room8before = db.getRoom(8);
console.log('Sala 8 items antes:', JSON.stringify(room8before.items));

// Player de prueba con inventario vacío
const player = {
  id: 'test-player-bug2004',
  current_room_id: 8,
  inventory: JSON.stringify([]),
  equipped_weapon: null,
  equipped_armor: null,
  run_event: null,
  inventory_bonus: 0,
  specialization: null,
};

// Llamar dropLoot una sola vez
const result1 = dropLoot(monster, 8, player);
const room8after1 = db.getRoom(8);
console.log('\n--- Llamada 1 ---');
console.log('droppedLoot:', JSON.stringify(result1.droppedLoot));
console.log('directLoot:', JSON.stringify(result1.directLoot));
console.log('Sala 8 items after 1st dropLoot:', JSON.stringify(room8after1.items));

// Verificar si hay duplicados
const drops1 = result1.droppedLoot;
const hasDups = drops1.length !== new Set(drops1).size;
console.log('Hay duplicados en droppedLoot:', hasDups);

// Restaurar sala
db.updateRoomItems(8, room8before.items);

// Ahora simular Espectro del Corredor (id=4)
console.log('\n--- Espectro del Corredor (id=4) ---');
const m4 = db.getMonster(4);
console.log('Loot from DB:', JSON.stringify(m4.loot));
const r4 = db.getRoom(4);
console.log('Sala 4 antes:', JSON.stringify(r4.items));
const result4 = dropLoot(m4, m4.room_id || 2, player);
console.log('droppedLoot:', JSON.stringify(result4.droppedLoot));
const hasDups4 = result4.droppedLoot.length !== new Set(result4.droppedLoot).size;
console.log('Hay duplicados en droppedLoot:', hasDups4);

// Gólem de Piedra (id=5)
console.log('\n--- Gólem de Piedra (id=5) ---');
const m5 = db.getMonster(5);
console.log('Loot from DB:', JSON.stringify(m5.loot));
const result5 = dropLoot(m5, m5.room_id || 10, player);
console.log('droppedLoot:', JSON.stringify(result5.droppedLoot));
const hasDups5 = result5.droppedLoot.length !== new Set(result5.droppedLoot).size;
console.log('Hay duplicados en droppedLoot:', hasDups5);

process.exit(0);
