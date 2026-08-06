// test_dis2370.js — Test para DIS-2370: reminder del cuenco de la Capilla con HP bajo
//
// Verifica la lógica del reminder contextual: solo aparece cuando:
//   - El jugador está en sala 1 (Entrada) o sala 2 (Corredor)
//   - HP < 50%
// No aparece con HP alto, en otras salas, o cuando el cuenco está en cooldown.

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

// Replicar la lógica de DIS-2370 de cmdLook
function getChapelReminder(player, fountainCooldowns) {
  const CHAPEL_HINT_ROOMS = [1, 2];
  if (!CHAPEL_HINT_ROOMS.includes(player.current_room_id)) return '';

  const pHp    = player.hp    || 0;
  const pMaxHp = player.max_hp || 30;
  const hpPct  = pMaxHp > 0 ? pHp / pMaxHp : 1;
  if (hpPct >= 0.5) return '';

  const cooldownTs = (fountainCooldowns || new Map()).get(player.id + '_chapel') || 0;
  const chapelReady = Date.now() >= cooldownTs;
  const chapelRoute = player.current_room_id === 1 ? 'este desde aquí' : 'volvé a la Entrada (norte) y luego este';
  const hint = chapelReady
    ? `\n🙏 HP bajo (${pHp}/${pMaxHp}): hay un cuenco sagrado en la Capilla (${chapelRoute}) que restaura 40% de HP. Usá "use cuenco".`
    : `\n🙏 HP bajo (${pHp}/${pMaxHp}): el cuenco sagrado de la Capilla está en cooldown — recargará pronto.`;
  return hint;
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== TEST DIS-2370: Reminder del cuenco sagrado con HP bajo ===\n');

// Test 1: Sala 1, HP 10/30 (33%) → muestra reminder con "este desde aquí"
console.log('Test 1: Sala 1 (Entrada), HP 10/30 → muestra reminder');
{
  const player = { id: 'p1', current_room_id: 1, hp: 10, max_hp: 30 };
  const result = getChapelReminder(player, new Map());
  assert(result.includes('cuenco sagrado'), 'Muestra reminder del cuenco');
  assert(result.includes('este desde aquí'), 'Muestra ruta correcta desde sala 1');
  assert(result.includes('10/30'), 'Muestra HP actual');
  assert(result.includes('use cuenco'), 'Muestra el comando correcto');
  console.log('  → Output: ' + result.trim());
}

// Test 2: Sala 2, HP 14/30 (46%) → muestra reminder con "volvé a la Entrada"
console.log('\nTest 2: Sala 2 (Corredor), HP 14/30 → muestra reminder con ruta diferente');
{
  const player = { id: 'p1', current_room_id: 2, hp: 14, max_hp: 30 };
  const result = getChapelReminder(player, new Map());
  assert(result.includes('cuenco sagrado'), 'Muestra reminder del cuenco');
  assert(result.includes('volvé a la Entrada'), 'Muestra ruta correcta desde sala 2');
}

// Test 3: Sala 1, HP 15/30 (50%) → NO muestra (exactamente 50%)
console.log('\nTest 3: HP exactamente 50% → NO muestra reminder');
{
  const player = { id: 'p1', current_room_id: 1, hp: 15, max_hp: 30 };
  const result = getChapelReminder(player, new Map());
  assert(result === '', 'HP = 50%: no muestra reminder');
}

// Test 4: Sala 1, HP 30/30 → NO muestra
console.log('\nTest 4: HP completo → NO muestra reminder');
{
  const player = { id: 'p1', current_room_id: 1, hp: 30, max_hp: 30 };
  const result = getChapelReminder(player, new Map());
  assert(result === '', 'HP lleno: no muestra reminder');
}

// Test 5: Sala 3 (Sala de los Ecos), HP bajo → NO muestra
console.log('\nTest 5: Sala 3 (no es sala 1 ni 2), HP bajo → NO muestra');
{
  const player = { id: 'p1', current_room_id: 3, hp: 5, max_hp: 30 };
  const result = getChapelReminder(player, new Map());
  assert(result === '', 'Sala 3: no muestra reminder (no es sala 1 o 2)');
}

// Test 6: Sala 5 (Capilla), HP bajo → NO muestra (ya está en la Capilla)
console.log('\nTest 6: Sala 5 (Capilla), HP bajo → NO muestra');
{
  const player = { id: 'p1', current_room_id: 5, hp: 5, max_hp: 30 };
  const result = getChapelReminder(player, new Map());
  assert(result === '', 'Sala 5 (Capilla): no muestra reminder');
}

// Test 7: Cuenco en cooldown → muestra mensaje de cooldown
console.log('\nTest 7: Cuenco en cooldown → muestra mensaje de cooldown');
{
  const player = { id: 'p1', current_room_id: 1, hp: 10, max_hp: 30 };
  const cooldowns = new Map();
  cooldowns.set('p1_chapel', Date.now() + 5 * 60 * 1000); // cooldown activo
  const result = getChapelReminder(player, cooldowns);
  assert(result.includes('cooldown'), 'Muestra mensaje de cooldown cuando cuenco no disponible');
  assert(!result.includes('use cuenco'), 'No muestra el comando cuando está en cooldown');
}

// Test 8: HP 1/30 (extremo bajo) → muestra con urgencia implícita
console.log('\nTest 8: HP extremadamente bajo (1/30)');
{
  const player = { id: 'p1', current_room_id: 1, hp: 1, max_hp: 30 };
  const result = getChapelReminder(player, new Map());
  assert(result.includes('1/30'), 'Muestra HP correcto (1/30)');
  assert(result.includes('cuenco sagrado'), 'Muestra el reminder');
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
