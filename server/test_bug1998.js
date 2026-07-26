/**
 * Test BUG-1998: cuchillo oxidado no aparece en inventario tras matar al Goblin Merodeador.
 *
 * El Goblin Merodeador dropa cuchillo oxidado. Este ítem está en JUNK_ITEMS.
 * La excepción de BUG-1837 dice que si el junk es ingrediente de crafteo, sí se recoge con loot.
 * cuchillo oxidado sí es ingrediente (veneno concentrado + cuchillo oxidado = cuchillo envenenado).
 *
 * Este test verifica si el comando `loot` recoge el cuchillo oxidado del suelo.
 */

'use strict';

const db = require('./db/db');
const engine = require('./game/engine');

// Crear o recuperar jugador bot
let player = db.getPlayerByUsername('bot_bug1998');
if (!player) {
  player = db.createPlayer('bot_bug1998');
  db.updatePlayer(player.id, { is_bot: 1 });
  player = db.getPlayer(player.id);
}

// Reset jugador: sala 1 (Entrada al Dungeon), inventario vacío, nivel 1
db.updatePlayer(player.id, {
  current_room_id: 1,
  hp: 50,
  max_hp: 50,
  gold: 0,
  xp: 0,
  level: 1,
  inventory: '[]',
  equipped_weapon: null,
  equipped_armor: null,
  status_effects: '{}',
  tutorial_step: null,
});

// Limpiar sala 1
const room1 = db.getRoom(1);
console.log('[setup] Items en sala 1 antes:', room1.items);

// Poner cuchillo oxidado en el suelo de la sala 1 (simulando loot del goblin)
db.updateRoomItems(1, ['cuchillo oxidado']);
console.log('[setup] Items en sala 1 después de simular loot:', db.getRoom(1).items);

// Refrescar jugador
player = db.getPlayer(player.id);
console.log('[setup] Inventario del jugador:', player.inventory);

// Ejecutar comando loot
console.log('\n--- Ejecutando: loot ---');
const result = engine.processCommand(player.id, 'loot');
console.log('Respuesta:', result.text);

// Verificar resultado
player = db.getPlayer(player.id);
console.log('\n[resultado] Inventario del jugador después de loot:', player.inventory);

const inv = Array.isArray(player.inventory) ? player.inventory : JSON.parse(player.inventory || '[]');
const tieneCuchillo = inv.includes('cuchillo oxidado') || inv.some(i => i.toLowerCase() === 'cuchillo oxidado');
console.log('[resultado] ¿Tiene cuchillo oxidado en inventario?', tieneCuchillo ? '✅ SÍ' : '❌ NO (BUG)');

const roomAfter = db.getRoom(1);
const quedoEnSuelo = (roomAfter.items || []).some(i => i.toLowerCase() === 'cuchillo oxidado');
console.log('[resultado] ¿Quedó en el suelo?', quedoEnSuelo ? '❌ SÍ (BUG)' : '✅ NO');

// Cleanup
db.updateRoomItems(1, []);
db.updatePlayer(player.id, { inventory: '[]' });
console.log('\n[cleanup] Reset completado.');
