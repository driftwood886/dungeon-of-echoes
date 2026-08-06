// test_dis2368.js — Test para DIS-2368: upsell de armadura proactivo en tienda
//
// Verifica la lógica del upsell de "producto relacionado" en cmdShop:
// - Si el jugador tiene arma pero NO armadura (y nivel < 5) → muestra upsell
// - No muestra si ya tiene armadura
// - No muestra si no tiene arma
// - No muestra si nivel >= 5 (cubierto por DIS-1410)

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

// Replicar la lógica de DIS-2368 de cmdShop
function getArmorUpsell(player) {
  const shopWeapon = (player.equipped_weapon && player.equipped_weapon !== 'null') ? player.equipped_weapon : null;
  const shopArmor  = (player.equipped_armor  && player.equipped_armor  !== 'null') ? player.equipped_armor  : null;
  if (!shopWeapon || shopArmor || (player.level || 1) >= 5) return '';

  const armorSuggest = player.player_class === 'mago' || player.player_class === 'clerigo'
    ? 'ropa de viajero (22g)'
    : 'cuero endurecido (40g)';
  const armorCmd = player.player_class === 'mago' || player.player_class === 'clerigo'
    ? 'comprar ropa de viajero'
    : 'comprar cuero endurecido';
  return [
    `🔗 Aldric mira tu equipo. «${shopWeapon} es buena elección. Pero arma sin armadura es invitación al funeral.»`,
    `  «Te recomiendo el ${armorSuggest} — escribí \`${armorCmd}\`.»`,
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== TEST DIS-2368: Upsell de armadura proactivo en tienda ===\n');

// Test 1: Guerrero nivel 2 con espada de hierro sin armadura → muestra upsell
console.log('Test 1: Guerrero nivel 2, arma sin armadura → muestra upsell');
{
  const player = { level: 2, player_class: 'guerrero', equipped_weapon: 'espada de hierro', equipped_armor: null };
  const result = getArmorUpsell(player);
  assert(result.includes('invitación al funeral'), 'Muestra el upsell de armadura');
  assert(result.includes('cuero endurecido'), 'Recomienda cuero endurecido para guerrero');
  assert(result.includes('comprar cuero endurecido'), 'Incluye el comando correcto');
  console.log('  → Output: ' + result);
}

// Test 2: Mago nivel 1 con vara de energía sin armadura → recomienda ropa de viajero
console.log('\nTest 2: Mago con arma sin armadura → recomienda ropa de viajero');
{
  const player = { level: 1, player_class: 'mago', equipped_weapon: 'vara de energía', equipped_armor: null };
  const result = getArmorUpsell(player);
  assert(result.includes('ropa de viajero'), 'Recomienda ropa de viajero para mago');
  assert(result.includes('comprar ropa de viajero'), 'Incluye el comando correcto para mago');
}

// Test 3: Guerrero nivel 3 con arma Y armadura → NO muestra upsell
console.log('\nTest 3: Guerrero con arma Y armadura → NO muestra upsell');
{
  const player = { level: 3, player_class: 'guerrero', equipped_weapon: 'espada de hierro', equipped_armor: 'cuero endurecido' };
  const result = getArmorUpsell(player);
  assert(result === '', 'Con armadura equipada: no muestra upsell');
}

// Test 4: Guerrero nivel 2 sin arma, sin armadura → NO muestra upsell (no tiene arma)
console.log('\nTest 4: Sin arma → NO muestra upsell');
{
  const player = { level: 2, player_class: 'guerrero', equipped_weapon: null, equipped_armor: null };
  const result = getArmorUpsell(player);
  assert(result === '', 'Sin arma: no muestra upsell');
}

// Test 5: Guerrero nivel 5, arma sin armadura → NO muestra (cubierto por DIS-1410)
console.log('\nTest 5: Nivel 5+, arma sin armadura → NO muestra upsell DIS-2368');
{
  const player = { level: 5, player_class: 'guerrero', equipped_weapon: 'espada de acero', equipped_armor: null };
  const result = getArmorUpsell(player);
  assert(result === '', 'Nivel 5+: DIS-1410 se encarga, DIS-2368 no aplica');
}

// Test 6: Arma equipada que es 'null' string (edge case)
console.log('\nTest 6: equipped_weapon="null" (string null) → NO muestra upsell');
{
  const player = { level: 2, player_class: 'guerrero', equipped_weapon: 'null', equipped_armor: 'null' };
  const result = getArmorUpsell(player);
  assert(result === '', 'String "null": no muestra upsell');
}

// Test 7: Clérigo nivel 1 con símbolo sagrado, sin armadura → recomienda ropa de viajero
console.log('\nTest 7: Clérigo con arma sin armadura → recomienda ropa de viajero');
{
  const player = { level: 1, player_class: 'clerigo', equipped_weapon: 'símbolo sagrado', equipped_armor: null };
  const result = getArmorUpsell(player);
  assert(result.includes('ropa de viajero'), 'Recomienda ropa de viajero para clérigo');
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
