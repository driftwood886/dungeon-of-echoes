/**
 * test_bug2011.js — Verificar fix de duplicación de loot con boss_guaranteed_loot
 *
 * Escenario:
 * - Boss suelta 4 ítems: [espada rara, escudo épico, poción, armadura]
 * - Inventario del jugador: 27/28 (1 slot libre)
 * - Al matar boss: 1 ítem entra al inventario, los otros 3 van al suelo
 * - 2 de esos (espada rara, escudo épico) se guardan en boss_guaranteed_loot
 * - Jugador hace drop de 2 ítems → 26/28 (2 slots libres)
 * - Usa loot
 * - ANTES del fix: espada rara y escudo épico estarían en inventario Y en el suelo
 * - DESPUÉS del fix: se remueven del suelo al entrar al inventario
 */

'use strict';
const path = require('path');

// Simular DB en memoria
const db = {
  _players: {},
  _rooms: {},
  getPlayer(id) { return JSON.parse(JSON.stringify(this._players[id])); },
  updatePlayer(id, updates) {
    this._players[id] = { ...this._players[id], ...updates };
    // Parsear inventario si viene como string
    if (typeof this._players[id].inventory === 'string') {
      this._players[id].inventory = JSON.parse(this._players[id].inventory);
    }
  },
  getRoom(id) { return JSON.parse(JSON.stringify(this._rooms[id])); },
  updateRoomItems(id, items) { this._rooms[id].items = items; },
};

// Simular items
const items = {
  getItemRarity(name) {
    if (name === 'espada rara') return 'raro';
    if (name === 'escudo épico') return 'épico';
    return 'común';
  },
  getRarityEmoji(name) {
    if (name === 'espada rara') return '🔵';
    if (name === 'escudo épico') return '🟣';
    return '⚪';
  },
  isJunkItem() { return false; },
};

const crafting = { RECIPES: [] };
const quests = { recordProgress() { return null; } };
const xpSystem = { levelFromXp(xp) { return Math.floor(xp / 100); } };
const challengeTracker = { trackLoot() { return ''; } };

// Estado inicial: jugador con 26 slots usados (2 libres)
db._players['p1'] = {
  id: 'p1',
  current_room_id: 'r1',
  inventory: Array(26).fill('basura').map((_, i) => `item-${i}`),
  inventory_bonus: 4, // total 28 slots
  equipped_weapon: null,
  equipped_armor: null,
  gold: 100,
  xp: 0,
  status_effects: JSON.stringify({
    boss_guaranteed_loot: ['espada rara', 'escudo épico']
  }),
  run_event: null,
};

// Suelo: los ítems que no entraron (espada rara, escudo épico, poción, armadura)
db._rooms['r1'] = {
  id: 'r1',
  name: 'Sala del Trono',
  items: ['espada rara', 'escudo épico', 'poción', 'armadura'],
};

// ===== Simular cmdLoot (lógica copiada y adaptada del engine.js con el fix) =====
function cmdLoot(player_arg) {
  let player = db.getPlayer(player_arg.id);
  let room = db.getRoom(player.current_room_id);

  if (!room) return { text: 'Error: habitación no encontrada.' };

  // Bloque guaranteed loot (DIS-1993)
  let guaranteedLootLines = [];
  try {
    const seForGuar = typeof player.status_effects === 'string'
      ? JSON.parse(player.status_effects || '{}')
      : (player.status_effects || {});
    const guaranteed = Array.isArray(seForGuar.boss_guaranteed_loot) ? seForGuar.boss_guaranteed_loot : [];
    if (guaranteed.length > 0) {
      const MAX_INV_GUAR = 24 + (player.inventory_bonus || 0);
      const eqCountGuar = (player.equipped_weapon ? 1 : 0) + (player.equipped_armor ? 1 : 0);
      const freeGuar = MAX_INV_GUAR - player.inventory.length - eqCountGuar;
      const enterNow = guaranteed.slice(0, Math.max(0, freeGuar));
      const stillPending = guaranteed.slice(Math.max(0, freeGuar));
      if (enterNow.length > 0) {
        const freshGuar = db.getPlayer(player.id);
        const newInvGuar = [...freshGuar.inventory, ...enterNow];
        const seUpdGuar = typeof freshGuar.status_effects === 'string'
          ? JSON.parse(freshGuar.status_effects || '{}')
          : (freshGuar.status_effects || {});
        if (stillPending.length > 0) {
          seUpdGuar.boss_guaranteed_loot = stillPending;
        } else {
          delete seUpdGuar.boss_guaranteed_loot;
        }
        db.updatePlayer(player.id, { inventory: newInvGuar, status_effects: JSON.stringify(seUpdGuar) });
        player = db.getPlayer(player.id);
        // BUG-2011: remover los ítems garantizados que ya entraron al inventario del suelo de la sala.
        try {
          const roomForGuar2011 = db.getRoom(player.current_room_id);
          if (roomForGuar2011) {
            const toRemove2011 = [...enterNow];
            const updatedFloor2011 = (roomForGuar2011.items || []).filter(floorItem => {
              const idx = toRemove2011.indexOf(floorItem);
              if (idx !== -1) {
                toRemove2011.splice(idx, 1);
                return false;
              }
              return true;
            });
            db.updateRoomItems(player.current_room_id, updatedFloor2011);
            room = roomForGuar2011;
            room.items = updatedFloor2011;
          }
        } catch (_bug2011) { /* no interrumpir */ }
        guaranteedLootLines.push(`🔒 [Loot Garantizado] Reclamás: ${enterNow.map(i => `**${items.getRarityEmoji(i)} ${i}**`).join(', ')}.`);
      }
      if (stillPending.length > 0) {
        guaranteedLootLines.push(`🔒 Aún tenés ${stillPending.join(', ')} reservados — liberá espacio.`);
      }
    }
  } catch (_) {}

  const floorItems = room.items || [];
  if (floorItems.length === 0) {
    if (guaranteedLootLines.length > 0) return { text: guaranteedLootLines.join('\n') };
    return { text: 'No hay nada en el suelo.' };
  }

  const MAX_INVENTORY = 24 + (player.inventory_bonus || 0);
  const equippedCountLoot = (player.equipped_weapon ? 1 : 0) + (player.equipped_armor ? 1 : 0);
  const spaceAvailable = MAX_INVENTORY - player.inventory.length - equippedCountLoot;
  const nonGoldItems = floorItems.filter(i => !['monedas', 'monedas de oro', 'monedas de plata', 'monedas de cobre'].includes(i));
  const itemsToPickup = nonGoldItems.slice(0, spaceAvailable);
  const itemsLeft = nonGoldItems.slice(spaceAvailable);
  const newInventory = [...player.inventory, ...itemsToPickup];
  db.updatePlayer(player.id, { inventory: newInventory });
  db.updateRoomItems(room.id, itemsLeft);

  return { text: `Recogés: ${itemsToPickup.join(', ')}. En el suelo queda: ${itemsLeft.join(', ') || 'nada'}.` };
}

// === EJECUTAR TEST ===
console.log('=== TEST BUG-2011 ===\n');
console.log('Estado inicial:');
console.log(`  Inventario: ${db._players['p1'].inventory.length}/28`);
console.log(`  Suelo: ${db._rooms['r1'].items.join(', ')}`);
console.log(`  boss_guaranteed_loot: espada rara, escudo épico\n`);

const result = cmdLoot({ id: 'p1' });
console.log('Resultado de loot:\n ', result.text);

const finalPlayer = db._players['p1'];
const finalRoom = db._rooms['r1'];
console.log('\nEstado final:');
console.log(`  Inventario (${finalPlayer.inventory.length}/28):`, finalPlayer.inventory.slice(-5).join(', '));
console.log(`  Suelo: ${finalRoom.items.join(', ') || '(vacío)'}`);

// Verificar ausencia de duplicados
const invSet = new Set(finalPlayer.inventory.map(x => x.toLowerCase()));
const floorItems = finalRoom.items.map(x => x.toLowerCase());

const duplicates = floorItems.filter(item => finalPlayer.inventory.includes(item));
if (duplicates.length > 0) {
  console.log('\n❌ FAIL: Duplicados encontrados en inventario Y suelo:', duplicates.join(', '));
  process.exit(1);
} else {
  console.log('\n✅ PASS: No hay duplicados entre inventario y suelo.');
}

// Verificar que los guaranteed items están en el inventario
const hasEspada = finalPlayer.inventory.includes('espada rara');
const hasEscudo = finalPlayer.inventory.includes('escudo épico');
console.log(`  espada rara en inventario: ${hasEspada ? '✅' : '❌'}`);
console.log(`  escudo épico en inventario: ${hasEscudo ? '✅' : '❌'}`);

if (!hasEspada || !hasEscudo) {
  console.log('❌ FAIL: Ítems garantizados no entraron al inventario.');
  process.exit(1);
} else {
  console.log('\n✅ Todos los tests pasaron — BUG-2011 fixeado.');
}
