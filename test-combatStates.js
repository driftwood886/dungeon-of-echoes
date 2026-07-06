/**
 * test-combatStates.js — Tests unitarios para combatStates.js
 * 
 * Correr con: node test-combatStates.js
 * No requiere servidor activo.
 */

'use strict';

const {
  applyDebuff,
  resolveDebuffSynergy,
  tickDebuffs,
  describeDebuffs,
  hasDebuff,
  clearDebuff,
  SINERGIA_TABLE,
} = require('./server/game/combatStates');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${msg}`);
    failed++;
  }
}

function makeMob(name = 'Goblin', hp = 30) {
  return { name, hp, status_effects: {} };
}

// ─── applyDebuff básico ───────────────────────────────────────────────────────

console.log('\n[1] applyDebuff — estado nuevo');
{
  const mob = makeMob();
  const { applied, lines } = applyDebuff(mob, 'stunned', { source: 'rayo', turns: 1 });
  assert(applied === 'stunned', 'applied = stunned');
  assert(mob.status_effects.stunned !== undefined, 'status_effects.stunned existe');
  assert(mob.status_effects.stunned.turns === 1, 'turns = 1');
  assert(mob.status_effects.stunned.source === 'rayo', 'source = rayo');
  assert(lines.length > 0, 'tiene líneas de log');
}

console.log('\n[2] applyDebuff — slowed');
{
  const mob = makeMob();
  const { applied, lines } = applyDebuff(mob, 'slowed', { source: 'escarcha', turns: 1 });
  assert(applied === 'slowed', 'applied = slowed');
  assert(mob.status_effects.slowed !== undefined, 'status_effects.slowed existe');
}

console.log('\n[3] applyDebuff — burning (stackeable)');
{
  const mob = makeMob();
  applyDebuff(mob, 'burning', { source: 'bola_de_fuego', turns: 2 });
  assert(mob.status_effects.burning.stacks === 1, 'primer burning: 1 stack');
  // Segundo burning — sin sinergia (tabla vacía en Fase 1) → stackea
  // Nota: en Fase 1 la SINERGIA_TABLE está vacía, burning+burning no hace sinergia.
  // Se aplica stackeo directo.
  applyDebuff(mob, 'burning', { source: 'bola_de_fuego', turns: 2 });
  assert(mob.status_effects.burning.stacks === 2, 'segundo burning: 2 stacks');
}

console.log('\n[4] applyDebuff — non-stackeable refresh');
{
  const mob = makeMob();
  applyDebuff(mob, 'stunned', { source: 'rayo', turns: 1 });
  applyDebuff(mob, 'stunned', { source: 'rayo', turns: 1 }); // ya existe
  assert(mob.status_effects.stunned.turns === 1, 'stunned: duración no se pierde');
}

// ─── tickDebuffs ─────────────────────────────────────────────────────────────

console.log('\n[5] tickDebuffs — DoT burning');
{
  const mob = makeMob('Troll', 30);
  applyDebuff(mob, 'burning', { source: 'bola_de_fuego', turns: 2, dmg_per_turn: 3 });
  const lines = [];
  const { dead } = tickDebuffs(mob, lines);
  assert(!dead, 'no muere en el 1er tick');
  assert(mob.hp === 27, 'hp bajó 3 (de 30 a 27)');
  assert(mob.status_effects.burning !== undefined, 'burning sigue activo (1t restante)');
}

console.log('\n[6] tickDebuffs — expira estado');
{
  const mob = makeMob();
  applyDebuff(mob, 'slowed', { source: 'escarcha', turns: 1 });
  const lines = [];
  tickDebuffs(mob, lines);
  assert(mob.status_effects.slowed === undefined, 'slowed expiró después de 1 tick');
}

console.log('\n[7] tickDebuffs — muerte por DoT');
{
  const mob = makeMob('Zombie', 5);
  applyDebuff(mob, 'burning', { source: 'bola', turns: 2, dmg_per_turn: 10 });
  const lines = [];
  const { dead } = tickDebuffs(mob, lines);
  assert(dead, 'muere por burning DoT');
}

// ─── describeDebuffs ─────────────────────────────────────────────────────────

console.log('\n[8] describeDebuffs');
{
  const mob = makeMob();
  assert(describeDebuffs(mob) === '', 'sin estados: string vacío');

  applyDebuff(mob, 'stunned', { source: 'rayo', turns: 1 });
  const desc = describeDebuffs(mob);
  assert(desc.includes('Aturdido'), 'describe incluye Aturdido');
  assert(desc.includes('1t'), 'describe incluye duración 1t');
}

// ─── hasDebuff / clearDebuff ─────────────────────────────────────────────────

console.log('\n[9] hasDebuff — nuevo formato');
{
  const mob = makeMob();
  applyDebuff(mob, 'slowed', { source: 'escarcha', turns: 1 });
  assert(hasDebuff(mob, 'slowed'), 'hasDebuff devuelve true');
  clearDebuff(mob, 'slowed');
  assert(!hasDebuff(mob, 'slowed'), 'después de clearDebuff devuelve false');
}

console.log('\n[10] hasDebuff — formato legacy (número)');
{
  const mob = { hp: 20, status_effects: { stunned: 1 } };
  assert(hasDebuff(mob, 'stunned'), 'legacy number: hasDebuff true');
  mob.status_effects.stunned = 0;
  assert(!hasDebuff(mob, 'stunned'), 'legacy number 0: hasDebuff false');
}

console.log('\n[11] hasDebuff — formato legacy (objeto con turns)');
{
  const mob = { hp: 20, status_effects: { stunned: { turns: 1 } } };
  assert(hasDebuff(mob, 'stunned'), 'legacy obj turns=1: hasDebuff true');
  mob.status_effects.stunned.turns = 0;
  assert(!hasDebuff(mob, 'stunned'), 'legacy obj turns=0: hasDebuff false');
}

// ─── resolveDebuffSynergy (Fase 1 — tabla vacía) ─────────────────────────────

console.log('\n[12] resolveDebuffSynergy — sin sinergias en Fase 1');
{
  const syn = resolveDebuffSynergy('slowed', 'slowed', 'escarcha');
  assert(syn === null, 'sin sinergia en Fase 1 (tabla vacía)');
}

// ─── target sin status_effects (inicialización defensiva) ────────────────────

console.log('\n[13] applyDebuff — target sin status_effects');
{
  const mob = { hp: 20, name: 'Esqueleto' }; // sin status_effects
  const { applied } = applyDebuff(mob, 'stunned', { source: 'shield_bash', turns: 1 });
  assert(applied === 'stunned', 'crea status_effects automáticamente');
  assert(mob.status_effects !== undefined, 'status_effects existe ahora');
}

// ─── Resumen ─────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Resultados: ${passed} ✅ pasaron, ${failed} ❌ fallaron`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('Todos los tests pasaron. 🎉');
}
