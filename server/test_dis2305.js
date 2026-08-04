/**
 * test_dis2305.js — Test para skills de mid-game del Guerrero (DIS-2305)
 * Verifica:
 *   - resistencia (nivel 8): puede activarse, reduce daño, decrementa turnos
 *   - golpe_cargado (nivel 9): puede activarse, aplica ×2.0 al próximo ataque
 *   - Las skills aparecen en getUnlockedSkills para Guerrero nivel 8/9
 */

'use strict';

const skills = require('./game/skills.js');

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

console.log('\n=== DIS-2305: Skills de mid-game Guerrero ===\n');

// 1. Skills existen en catálogo
console.log('--- 1. Catálogo de skills ---');
const resSk = skills.SKILLS['resistencia'];
const gcSk = skills.SKILLS['golpe_cargado'];
assert('resistencia existe en SKILLS', !!resSk);
assert('golpe_cargado existe en SKILLS', !!gcSk);
assert('resistencia level requerido = 8', resSk && resSk.required_level === 8);
assert('golpe_cargado level requerido = 9', gcSk && gcSk.required_level === 9);
assert('resistencia cooldown = 60s', resSk && resSk.cooldown_seconds === 60);
assert('golpe_cargado cooldown = 60s', gcSk && gcSk.cooldown_seconds === 60);
assert('resistencia duration_turns = 3', resSk && resSk.duration_turns === 3);
assert('resistencia def_reduction = 2', resSk && resSk.def_reduction === 2);
assert('golpe_cargado dmg_multiplier = 2.0', gcSk && gcSk.dmg_multiplier === 2.0);

// 2. Aliases
console.log('\n--- 2. Aliases (resolveSkillAlias) ---');
assert('resolveSkillAlias("resistencia") → resistencia', skills.resolveSkillAlias('resistencia') === 'resistencia');
assert('resolveSkillAlias("aguantar") → resistencia', skills.resolveSkillAlias('aguantar') === 'resistencia');
assert('resolveSkillAlias("golpe_cargado") → golpe_cargado', skills.resolveSkillAlias('golpe_cargado') === 'golpe_cargado');
assert('resolveSkillAlias("carga") → golpe_cargado', skills.resolveSkillAlias('carga') === 'golpe_cargado');

// 3. getUnlockedSkills — aparecen para Guerrero en Nivel 8 y 9
console.log('\n--- 3. getUnlockedSkills ---');
const unlockedLv7 = skills.getUnlockedSkills(7, 'guerrero', null);
const unlockedLv8 = skills.getUnlockedSkills(8, 'guerrero', null);
const unlockedLv9 = skills.getUnlockedSkills(9, 'guerrero', null);
const unlockedLv10 = skills.getUnlockedSkills(10, 'guerrero', null);

const hasResLv7 = unlockedLv7.some(s => s.id === 'resistencia');
const hasResLv8 = unlockedLv8.some(s => s.id === 'resistencia');
const hasGCLv8  = unlockedLv8.some(s => s.id === 'golpe_cargado');
const hasGCLv9  = unlockedLv9.some(s => s.id === 'golpe_cargado');
const hasSmashLv8 = unlockedLv8.some(s => s.id === 'smash');
const hasRallyLv9 = unlockedLv9.some(s => s.id === 'rally');
const hasRallyLv10 = unlockedLv10.some(s => s.id === 'rally');

assert('resistencia NO aparece en Guerrero nivel 7', !hasResLv7);
assert('resistencia SÍ aparece en Guerrero nivel 8', hasResLv8);
assert('golpe_cargado NO aparece en Guerrero nivel 8', !hasGCLv8);
assert('golpe_cargado SÍ aparece en Guerrero nivel 9', hasGCLv9);
assert('smash sigue disponible en nivel 8', hasSmashLv8);
assert('rally NO disponible en nivel 9', !hasRallyLv9);
assert('rally SÍ disponible en nivel 10', hasRallyLv10);

// 4. No disponible para Mago ni Pícaro
console.log('\n--- 4. Exclusión de clases ---');
const unlockedMago = skills.getUnlockedSkills(10, 'mago', null);
const unlockedPicaro = skills.getUnlockedSkills(10, 'picaro', null);
assert('resistencia NO disponible para Mago', !unlockedMago.some(s => s.id === 'resistencia'));
assert('golpe_cargado NO disponible para Mago', !unlockedMago.some(s => s.id === 'golpe_cargado'));
assert('resistencia NO disponible para Pícaro', !unlockedPicaro.some(s => s.id === 'resistencia'));
assert('golpe_cargado NO disponible para Pícaro', !unlockedPicaro.some(s => s.id === 'golpe_cargado'));

// 5. Verificar tipos
console.log('\n--- 5. Tipos de skills ---');
assert('resistencia type = guerrero_resistance', resSk && resSk.type === 'guerrero_resistance');
assert('golpe_cargado type = guerrero_charge', gcSk && gcSk.type === 'guerrero_charge');

// Resultado
console.log(`\n=== Resultado: ${passed} PASS / ${failed} FAIL ===\n`);
if (failed > 0) process.exit(1);
