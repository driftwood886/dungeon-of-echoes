// test_dis2369.js — Test para DIS-2369: advertencia de desafío activo en tienda
//
// Verifica la lógica de filtrado de desafíos con arma equipada que se muestra
// en cmdShop. El test replica la lógica internamente (sin BD) para ser portable.

'use strict';

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${msg}`);
    failed++;
  }
}

// Replicar la lógica de filtrado de DIS-2369 de cmdShop
function normW(s) {
  return (s || '').toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function getWeaponChallengeWarning(shopWeapon, dailyChallenges, progressRows) {
  if (!shopWeapon) return '';
  const weaponChallenges = dailyChallenges.filter(ch => {
    if (!ch || !ch.condition || !ch.condition.extra || !ch.condition.extra.weapon_equipped) return false;
    if (normW(ch.condition.extra.weapon_equipped) !== normW(shopWeapon)) return false;
    const row = progressRows.find(r => r.challenge_id === ch.id);
    const isDone = row && row.count >= ch.condition.amount;
    return !isDone;
  });
  if (weaponChallenges.length === 0) return '';

  const lines = [];
  lines.push('⚠️  ── DESAFÍOS ACTIVOS CON TU ARMA ACTUAL ──────────────────────────');
  for (const ch of weaponChallenges) {
    const row = progressRows.find(r => r.challenge_id === ch.id);
    const done = row ? row.count : 0;
    const total = ch.condition.amount;
    lines.push(`  📋 «${ch.title}» — progreso: ${done}/${total} (requiere: ${shopWeapon})`);
  }
  lines.push('  Si comprás un arma nueva, estos desafíos se pausarán. ¿Querés completarlos antes de cambiar?');
  lines.push('─────────────────────────────────────────────────────────────────────');
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== TEST DIS-2369: Advertencia de desafío activo en tienda ===\n');

// Test 1: Sin desafíos → sin advertencia
console.log('Test 1: Sin desafíos activos con arma');
{
  const result = getWeaponChallengeWarning('hacha rústica', [], []);
  assert(result === '', 'Sin desafíos: sin advertencia');
}

// Test 2: Desafío con arma diferente → sin advertencia
console.log('\nTest 2: Desafío activo con arma diferente');
{
  const challenges = [{
    id: 'ch_1',
    title: 'El Hacha y la Sala',
    condition: { type: 'kill', amount: 3, extra: { weapon_equipped: 'espada de hierro' } },
  }];
  const result = getWeaponChallengeWarning('hacha rústica', challenges, []);
  assert(result === '', 'Desafío con arma diferente: sin advertencia');
}

// Test 3: Desafío con arma correcta y no completado → muestra advertencia
console.log('\nTest 3: Desafío activo con arma equipada actual, no completado');
{
  const challenges = [{
    id: 'ch_hacha',
    title: 'El Hacha y la Sala',
    condition: { type: 'kill', amount: 3, extra: { weapon_equipped: 'hacha rústica' } },
  }];
  const progress = [{ challenge_id: 'ch_hacha', count: 1 }];
  const result = getWeaponChallengeWarning('hacha rústica', challenges, progress);
  assert(result.includes('DESAFÍOS ACTIVOS CON TU ARMA ACTUAL'), 'Muestra bloque de advertencia');
  assert(result.includes('El Hacha y la Sala'), 'Muestra el título del desafío');
  assert(result.includes('1/3'), 'Muestra el progreso correcto (1/3)');
  assert(result.includes('pausarán'), 'Incluye el mensaje de pausa');
  console.log('  → Output generado:\n' + result.split('\n').map(l => '     ' + l).join('\n'));
}

// Test 4: Desafío ya completado → sin advertencia
console.log('\nTest 4: Desafío ya completado (no debe advertir)');
{
  const challenges = [{
    id: 'ch_hacha',
    title: 'El Hacha y la Sala',
    condition: { type: 'kill', amount: 3, extra: { weapon_equipped: 'hacha rústica' } },
  }];
  const progress = [{ challenge_id: 'ch_hacha', count: 3 }]; // completado
  const result = getWeaponChallengeWarning('hacha rústica', challenges, progress);
  assert(result === '', 'Desafío completado: sin advertencia');
}

// Test 5: Sin arma equipada → sin advertencia (no crashea)
console.log('\nTest 5: Sin arma equipada');
{
  const challenges = [{
    id: 'ch_hacha',
    title: 'El Hacha y la Sala',
    condition: { type: 'kill', amount: 3, extra: { weapon_equipped: 'hacha rústica' } },
  }];
  const result = getWeaponChallengeWarning(null, challenges, []);
  assert(result === '', 'Sin arma: sin advertencia');
}

// Test 6: Normalización de nombres con tildes
console.log('\nTest 6: Normalización de nombres (tildes y mayúsculas)');
{
  const challenges = [{
    id: 'ch_hacha',
    title: 'El Hacha y la Sala',
    condition: { type: 'kill', amount: 3, extra: { weapon_equipped: 'Hacha Rústica' } },
  }];
  const result = getWeaponChallengeWarning('hacha rústica', challenges, []);
  assert(result.includes('DESAFÍOS ACTIVOS'), 'Normalización funciona (Hacha Rústica === hacha rústica)');
}

// Test 7: Múltiples desafíos, uno coincide
console.log('\nTest 7: Múltiples desafíos, solo uno coincide');
{
  const challenges = [
    {
      id: 'ch_1',
      title: 'Maestro del Arco',
      condition: { type: 'kill', amount: 5, extra: { weapon_equipped: 'arco élfico' } },
    },
    {
      id: 'ch_hacha',
      title: 'El Hacha y la Sala',
      condition: { type: 'kill', amount: 3, extra: { weapon_equipped: 'hacha rústica' } },
    },
  ];
  const result = getWeaponChallengeWarning('hacha rústica', challenges, []);
  assert(result.includes('El Hacha y la Sala'), 'Muestra el desafío coincidente');
  assert(!result.includes('Maestro del Arco'), 'No muestra el desafío no coincidente');
}

// ── Resultado ─────────────────────────────────────────────────────────────────
console.log(`\n────────────────────────────────────`);
console.log(`Resultado: ${passed} pasaron, ${failed} fallaron`);
if (failed === 0) {
  console.log('✅ TODOS LOS TESTS PASARON');
} else {
  console.log('❌ HAY FALLOS');
  process.exit(1);
}
