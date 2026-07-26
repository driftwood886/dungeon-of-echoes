const db = require('./db/db');
const items = require('./game/items');

async function main() {
  await db.init();
  
  let p = db.getPlayerByUsername('__test1995debug__');
  if (!p) p = db.createPlayer('__test1995debug__');
  db.updatePlayer(p.id, {
    gold: 100,
    inventory: Array(20).fill('poción de salud'),
    inventory_bonus: 0,
    current_room_id: 4,
    level: 3
  });

  const pFresh = db.getPlayer(p.id);
  const INV_BASE_SLOTS = 20;
  const buyInvMax = INV_BASE_SLOTS + (pFresh.inventory_bonus || 0);
  const buyEqCount = (pFresh.equipped_weapon ? 1 : 0) + (pFresh.equipped_armor ? 1 : 0);
  const buyUsedSlots = (pFresh.inventory || []).length + buyEqCount;
  
  console.log('inventory type:', typeof pFresh.inventory, Array.isArray(pFresh.inventory));
  console.log('inventory.length:', pFresh.inventory.length);
  console.log('inventory_bonus:', pFresh.inventory_bonus);
  console.log('buyInvMax:', buyInvMax);
  console.log('buyUsedSlots:', buyUsedSlots);
  console.log('buyUsedSlots >= buyInvMax:', buyUsedSlots >= buyInvMax);
  
  const buyItemDef = items.getItemDef('bolsa de lona');
  console.log('buyItemDef:', JSON.stringify(buyItemDef));
  
  db.deletePlayer(p.id);
}
main().catch(console.error);
