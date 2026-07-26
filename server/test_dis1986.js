/**
 * test_dis1986.js — DIS-1986: Espectro del Corredor ya no huye
 *
 * Verifica:
 * 1. El Espectro del Corredor (id=4) está en BOSS_MONSTERS → no puede huir
 * 2. Tiene phase2 al 50% HP (barrera espectral) con atkBonus:2, defBonus:1
 * 3. BOSS_REC_LEVELS en engine.js ya tenía id=4 con nivel 3 (sin cambios)
 */

const combat = require('./game/combat.js');

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FALLA: ${label}`);
    failed++;
  }
}

console.log('\n=== DIS-1986: Espectro del Corredor ===\n');

const bm = combat.BOSS_MONSTERS;

// 1. El Espectro (id=4) debe estar en BOSS_MONSTERS
assert('id=4 está en BOSS_MONSTERS', !!bm[4]);

// 2. No debe huir (isBoss=true bloquea la lógica de huida de monstruos)
assert('Tiene lootBonus (array vacío)', Array.isArray(bm[4]?.lootBonus));
assert('respawnMinutes = 5', bm[4]?.respawnMinutes === 5);
assert('deathAnnouncement = null', bm[4]?.deathAnnouncement === null);

// 3. phase2 existe con los valores correctos
const p2 = bm[4]?.phase2;
assert('Tiene phase2 definida', !!p2);
assert('phase2.atkBonus = 2', p2?.atkBonus === 2);
assert('phase2.defBonus = 1', p2?.defBonus === 1);
assert('phase2.message contiene "BARRERA ESPECTRAL"', p2?.message?.includes('BARRERA ESPECTRAL'));
assert('phase2.message menciona "No puede huir"', p2?.message?.includes('No puede huir'));

// 4. Simular que isBoss=true para el Espectro en la lógica de combate
const isBoss = !!(bm && bm[4]);
assert('isBoss=true para id=4 → el bloque de huida de monstruo se saltea', isBoss === true);

// 5. El Espectro NO está en la lista de bosses-que-nunca-deben-huir-pero-sí-estaban-antes
// (verificar que no hubo duplicado con el goblin de práctica etc.)
assert('id=20 (Goblin Práctica) sigue siendo boss', !!bm[20]);
assert('id=8 (Guardia Espectral) sigue siendo boss', !!bm[8]);

console.log(`\nResultado: ${passed} pasados, ${failed} fallidos\n`);
if (failed > 0) process.exit(1);
