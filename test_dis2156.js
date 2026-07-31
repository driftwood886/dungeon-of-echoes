/**
 * test_dis2156.js — DIS-2156: vender basura debe reconocer ítems que inventario marca como descartables
 * Prueba que cuchillo oxidado (weapon en JUNK_ITEMS) y pelaje áspero (recipe ingredient en JUNK_ITEMS)
 * aparezcan en 'basura' y puedan venderse con 'vender basura'.
 */
'use strict';

const db = require('./server/db/db');
const { handleAction } = require('./server/game/engine');
const items = require('./server/game/items');

// Verificar que isJunkItem reconoce los problemáticos
console.log('=== DIS-2156: verificar JUNK_ITEMS ===');
const testItems = ['cuchillo oxidado', 'pelaje áspero', 'hueso de rata', 'espada de hierro'];
for (const item of testItems) {
  console.log(`isJunkItem('${item}'): ${items.isJunkItem(item)}`);
}

// Inicializar DB de prueba
db.init(':memory:');
const playerId = db.createPlayer('test_dis2156', 'password_test');
db.updatePlayer(playerId, {
  current_room_id: 4,  // sala del mercader
  inventory: ['cuchillo oxidado', 'pelaje áspero', 'hueso de rata', 'espada de hierro', 'poción de curación'],
  gold: 0,
});
let player = db.getPlayer(playerId);

console.log('\n=== Test basura (cmdJunk) ===');
const junkResult = handleAction(player, { command: 'junk', args: [] });
console.log(junkResult.text);

console.log('\n=== Test vender basura (cmdSellJunk) ===');
player = db.getPlayer(playerId);
const sellResult = handleAction(player, { command: 'sell_junk', args: [] });
console.log(sellResult.text);

// Verificar que espada de hierro y poción NO fueron vendidos
player = db.getPlayer(playerId);
console.log('\n=== Inventario restante ===');
console.log(player.inventory);
const hasEspada = player.inventory.includes('espada de hierro');
const hasPocion = player.inventory.includes('poción de curación');
const hasCuchillo = player.inventory.includes('cuchillo oxidado');
const hasPelaje = player.inventory.includes('pelaje áspero');

console.log(`\n✓ espada de hierro conservada: ${hasEspada}`);
console.log(`✓ poción de curación conservada: ${hasPocion}`);
console.log(`✓ cuchillo oxidado vendido: ${!hasCuchillo}`);
console.log(`✓ pelaje áspero vendido: ${!hasPelaje}`);

if (hasEspada && hasPocion && !hasCuchillo && !hasPelaje) {
  console.log('\n✅ DIS-2156 PASS: vender basura reconoce JUNK_ITEMS correctamente');
  process.exit(0);
} else {
  console.log('\n❌ DIS-2156 FAIL');
  process.exit(1);
}
