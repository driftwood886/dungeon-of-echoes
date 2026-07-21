// test_dis1808.js — Test manual para DIS-1808: regen del Troll se suprime con debuffs
// Ejecutar: node test_dis1808.js

// Simular la lógica de detección de debuffs

function trollHasDebuffCheck(trollFxCheck) {
  return !!(
    (trollFxCheck.burning && (typeof trollFxCheck.burning === 'number' ? trollFxCheck.burning > 0 : (trollFxCheck.burning.turns ?? 0) > 0)) ||
    (trollFxCheck.slowed  && (typeof trollFxCheck.slowed  === 'number' ? trollFxCheck.slowed  > 0 : (trollFxCheck.slowed.turns  ?? 0) > 0))
  );
}

const casos = [
  { fx: {},                                           expected: false,  desc: 'Sin debuffs — regen activa' },
  { fx: { burning: { turns: 2, source: 'bola_de_fuego' } }, expected: true, desc: 'Burning canónico' },
  { fx: { burning: 3 },                               expected: true,   desc: 'Burning legacy numérico' },
  { fx: { burning: 0 },                               expected: false,  desc: 'Burning=0 (expirado)' },
  { fx: { slowed: { turns: 1 } },                     expected: true,   desc: 'Slowed canónico' },
  { fx: { slowed: 2 },                                expected: true,   desc: 'Slowed legacy numérico' },
  { fx: { slowed: 0 },                                expected: false,  desc: 'Slowed=0 (expirado)' },
  { fx: { burning: { turns: 0 } },                    expected: false,  desc: 'Burning turns=0 (expirado)' },
  { fx: { stunned: { turns: 2 } },                    expected: false,  desc: 'Stunned no suprime regen' },
];

let pass = 0, fail = 0;
for (const c of casos) {
  const result = trollHasDebuffCheck(c.fx);
  const ok = result === c.expected;
  console.log(`${ok ? '✅' : '❌'} ${c.desc} → trollHasDebuff=${result} (esperado=${c.expected})`);
  if (ok) pass++; else fail++;
}

console.log(`\n${pass}/${pass+fail} tests pasados`);
if (fail > 0) process.exit(1);
