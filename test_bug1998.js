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

const db = require('./server/db/db');

db.init().then(() => {
  const engine = require('./server/game/engine');
  const items = require('./server/game/items');
  const crafting = require('./server/game/crafting');

  // Verificar lógica de ingrediente (debería ser true)
  const junkKey = 'cuchillo oxidado';
  const isJunk = items.isJunkItem(junkKey);
  const isIngredient = crafting.RECIPES.some(r => r.ingredients.some(ing => ing.toLowerCase().trim() === junkKey.toLowerCase().trim()));
  console.log(`[lógica] isJunkItem('cuchillo oxidado'): ${isJunk}`);
  console.log(`[lógica] isIngredient('cuchillo oxidado'): ${isIngredient}`);
  if (!isJunk || !isIngredient) {
    console.log('⚠️  Advertencia: la lógica base no cumple lo esperado — revisar items.js o crafting.js');
  }

  const rawDb = db.raw();
  const TEST_PLAYER_ID = 'test_bug1998_' + Date.now();

  // Crear jugador de prueba en sala 1
  rawDb.run(`
    INSERT OR REPLACE INTO players (id, username, hp, max_hp, attack, defense, 
      gold, xp, level, kills, current_room_id, inventory, player_class, is_bot)
    VALUES (?, ?, 50, 50, 5, 3, 0, 0, 1, 0, 1, '[]', 'guerrero', 1)
  `, [TEST_PLAYER_ID, 'TestBug1998']);

  const player = db.getPlayer(TEST_PLAYER_ID);
  console.log('\n[setup] Jugador creado:', player ? 'OK' : 'FAIL');

  // Limpiar sala 1 y poner cuchillo oxidado en el suelo
  db.updateRoomItems(1, ['cuchillo oxidado']);
  const room1 = db.getRoom(1);
  console.log('[setup] Items en sala 1:', room1.items);

  // Ejecutar comando loot
  console.log('\n--- Ejecutando: loot ---');
  const result = engine.execute(TEST_PLAYER_ID, 'loot');
  console.log('Respuesta:', result.text);

  // Verificar resultado
  const playerAfter = db.getPlayer(TEST_PLAYER_ID);
  const inv = Array.isArray(playerAfter.inventory) ? playerAfter.inventory : JSON.parse(playerAfter.inventory || '[]');
  const tieneCuchillo = inv.some(i => i.toLowerCase() === 'cuchillo oxidado');
  const roomAfter = db.getRoom(1);
  const quedoEnSuelo = (roomAfter.items || []).some(i => i.toLowerCase() === 'cuchillo oxidado');

  console.log('\n[resultado] Inventario:', inv);
  console.log('[resultado] Items en suelo:', roomAfter.items);
  console.log(`[resultado] ¿Tiene cuchillo oxidado en inventario? ${tieneCuchillo ? '✅ SÍ (CORRECTO)' : '❌ NO (BUG CONFIRMADO)'}`);
  console.log(`[resultado] ¿Quedó en el suelo? ${quedoEnSuelo ? '❌ SÍ (BUG CONFIRMADO)' : '✅ NO (CORRECTO)'}`);

  // Cleanup
  rawDb.run(`DELETE FROM players WHERE id = ?`, [TEST_PLAYER_ID]);
  db.updateRoomItems(1, []);
  console.log('\n[cleanup] Test completado.');
});
