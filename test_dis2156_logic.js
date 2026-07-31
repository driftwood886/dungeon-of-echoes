/**
 * test_dis2156_logic.js — DIS-2156: verificar lógica sin DB
 * Verifica que los ítems problemáticos (cuchillo oxidado, pelaje áspero) sean clasificados como basura
 */
'use strict';

const items = require('./server/game/items');
const { RECIPES } = require('./server/game/crafting');

// Construir recipe ingredients set (misma lógica que engine)
const recipeIngredients = new Set();
for (const r of RECIPES) {
  for (const ing of r.ingredients) recipeIngredients.add(ing.toLowerCase());
}

// Función que replica la lógica ANTES del fix
function isJunkOld(item) {
  const def = items.getItemDef(item);
  if (def && (def.type === 'weapon' || def.type === 'armor')) return false;
  const rarity = items.getItemRarity(item);
  if (rarity === 'raro' || rarity === 'épico' || rarity === 'legendario') return false;
  if (recipeIngredients.has(item.toLowerCase())) return false;
  if (def && (def.type === 'consumable' || def.type === 'potion' || def.type === 'mana_potion' ||
              def.type === 'atk_potion' || def.type === 'scroll' || def.type === 'key' ||
              def.type === 'blessing_potion')) return false;
  return true; // es basura
}

// Función con el FIX (DIS-2156)
function isJunkNew(item) {
  if (items.isJunkItem(item)) return true;  // ← NEW: JUNK_ITEMS tiene prioridad
  const def = items.getItemDef(item);
  if (def && (def.type === 'weapon' || def.type === 'armor')) return false;
  const rarity = items.getItemRarity(item);
  if (rarity === 'raro' || rarity === 'épico' || rarity === 'legendario') return false;
  if (recipeIngredients.has(item.toLowerCase())) return false;
  if (def && (def.type === 'consumable' || def.type === 'potion' || def.type === 'mana_potion' ||
              def.type === 'atk_potion' || def.type === 'scroll' || def.type === 'key' ||
              def.type === 'blessing_potion')) return false;
  return true;
}

const testItems = [
  // ítems con inconsistencia reportada
  { name: 'cuchillo oxidado', expectInventario: true,  expectVender: true  },
  { name: 'pelaje áspero',    expectInventario: true,  expectVender: true  },
  // ítems que NO deben venderse
  { name: 'espada de hierro', expectInventario: false, expectVender: false },
  { name: 'poción de salud',  expectInventario: false, expectVender: false },
  { name: 'hongo azul',       expectInventario: false, expectVender: false },  // tiene receta
  // otros junk normales
  { name: 'hueso de rata',    expectInventario: true,  expectVender: true  },
  { name: 'cadenas rotas',    expectInventario: true,  expectVender: true  },
];

let pass = 0, fail = 0;
console.log('=== DIS-2156: comparación ANTES vs DESPUÉS del fix ===\n');
console.log(('Ítem').padEnd(25), ('inv-marca').padEnd(12), ('OLD vender').padEnd(12), ('NEW vender').padEnd(12), 'Estado');
console.log('-'.repeat(80));

for (const { name, expectInventario, expectVender } of testItems) {
  const markedInv = items.isJunkItem(name);
  const oldJunk = isJunkOld(name);
  const newJunk = isJunkNew(name);
  const consistent = (markedInv === newJunk) && (newJunk === expectVender);
  const fixedBug = markedInv !== oldJunk && markedInv === newJunk;
  const status = consistent ? '✅' : '❌';
  if (consistent) pass++; else fail++;
  const note = fixedBug ? ' ← FIX' : '';
  console.log(name.padEnd(25), String(markedInv).padEnd(12), String(oldJunk).padEnd(12), String(newJunk).padEnd(12), status + note);
}

console.log('-'.repeat(80));
console.log(`\nResultado: ${pass} ok, ${fail} fallos`);
process.exit(fail > 0 ? 1 : 0);
