/**
 * EPIC-VV-1754: Prototipo — validar semilla determinística
 *
 * Valida que generateRunState(seed) produce output determinístico y
 * que la distribución de eventos es balanceada.
 *
 * Uso: node scripts/test-run-seed.js
 */

'use strict';

// ─── PRNG: Linear Congruential Generator (no necesita deps externos) ──────────
// Parámetros de MINSTD (Park-Miller)
function makePRNG(seed) {
  let s = seed >>> 0; // asegurar entero sin signo 32-bit
  if (s === 0) s = 1; // 0 rompe el LCG
  return function next() {
    s = Math.imul(s, 1664525) + 1013904223 >>> 0; // LCG Knuth
    return s / 0xFFFFFFFF; // float [0, 1)
  };
}

// ─── Definición de eventos ─────────────────────────────────────────────────────
const EVENTS = [
  {
    id: 'marea_no_muertos',
    title: 'Marea de No-Muertos',
    mechanic: 'undead_hp_bonus:2,rune_drop_rate:1.2',
    guardian_line: 'Esta noche las sombras se mueven diferente. Los esqueletos más allá de la entrada están... más activos que de costumbre. Si podés, evitá los corredores al norte después de medianoche.'
  },
  {
    id: 'caceria_del_filo',
    title: 'Cacería de la Orden',
    mechanic: 'boss_loot_double,boss_kill_faction_pts:5',
    guardian_line: 'La Orden del Filo está activa esta noche. Se rumorea que pagan bien por los bosses caídos. Si matás a algún jefe, guárdate la prueba — los soldados de la Orden pagan bien.'
  },
  {
    id: 'plaga_arcana',
    title: 'Plaga Arcana',
    mechanic: 'cast_double_chance:0.2,elemental_hp_bonus:10',
    guardian_line: 'El escriba está nervioso. Dice que las runas en las paredes están vibrando de un modo que no había visto en años. Ten cuidado con los Elementales — hoy son impredecibles.'
  },
  {
    id: 'festival_de_loot',
    title: 'Mercado Activo',
    mechanic: 'first_item_identified,auction_items:3',
    guardian_line: 'Los mercaderes están de fiesta. El primer objeto que encontrés en cada sala, lo entendés de inmediato sin necesidad de examinarlo. La Casa de Subastas también tiene más opciones que de costumbre.'
  },
  {
    id: 'silencio_del_abismo',
    title: 'El Dungeon Callado',
    mechanic: 'monster_no_killtext,boss_epic_lines,inscription_xp:2',
    guardian_line: 'Hoy el dungeon está... callado. Los monstruos menores no van a gritar al caer. Pero los grandes... los grandes tienen algo que decir esta noche. Las inscripciones en las paredes parecen más claras también.'
  },
  {
    id: 'temporada_de_sangre',
    title: 'Temporada de Sangre',
    mechanic: 'low_hp_atk_bonus:3,monster_herb_drop',
    guardian_line: 'El dungeon huele a sangre esta noche. Los que lleguen al límite — menos del tercio de vida — van a pelear con una furia que no conocen en condiciones normales. Los monstruos caídos dejan más hierbas también.'
  }
];

// ─── Pools de variantes de monstruo por sala ──────────────────────────────────
const MONSTER_VARIANT_POOLS = {
  2:  ['base', 'gnoll_explorador_murcielago', 'rata_gigante_x3'],         // Corredor de las Sombras
  3:  ['base', 'gnoll_merodeador_arana', 'zombie_caminante_x2'],          // Sala de los Ecos
  6:  ['base', 'arana_tejedora_x2', 'gnoll_merodeador_rata'],             // Túnel de los Hongos
  7:  ['base', 'rata_gigante_x2', 'gnoll_merodeador'],                    // Pozo Sin Fondo
  8:  ['normal', 'elemental_mana_adicional'],                             // Prisión Subterránea (condicionado a plaga_arcana)
  20: ['base', 'troll_x2_guardia', 'golem_elemental_fuego']               // Taller de la Forja
};

// ─── Pools de posición de ítems raros ─────────────────────────────────────────
const RARE_LOOT_POOLS = {
  paginas_congeladas:  [14, 6, 19],   // Galería de Hielo | Túnel de Hongos | Coliseo
  cristal_resonante:   [13, 7, 8],    // Cámara del Eco | Pozo Sin Fondo | Prisión
  pocion_de_poder:     [19, 20, 14],  // Coliseo | Taller de Forja | Galería
  pergamino_arcano:    [2, 5, 6],     // Corredor de Sombras | Capilla | Túnel Hongos
  totem_astillado:     [10, 15, 7]    // Sala del Trono | Santuario Profano | Pozo
};

// ─── Función principal ─────────────────────────────────────────────────────────
function generateRunState(seed) {
  const rand = makePRNG(seed);

  // Elegir evento
  const eventIndex = Math.floor(rand() * EVENTS.length);
  const event = EVENTS[eventIndex];

  // Elegir variantes de monstruo por sala
  const monster_variants = {};
  for (const [roomId, pool] of Object.entries(MONSTER_VARIANT_POOLS)) {
    const idx = Math.floor(rand() * pool.length);
    monster_variants[roomId] = pool[idx];
  }

  // Caso especial: sala 8 solo varía si el evento es plaga_arcana
  if (event.id !== 'plaga_arcana') {
    monster_variants[8] = 'normal';
  }

  // Elegir posiciones de loot raro
  const rare_loot_positions = {};
  for (const [itemId, rooms] of Object.entries(RARE_LOOT_POOLS)) {
    const idx = Math.floor(rand() * rooms.length);
    rare_loot_positions[itemId] = rooms[idx];
  }

  return { event, monster_variants, rare_loot_positions };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ FALLO: ${msg}`);
    failed++;
  }
}

console.log('\n=== TEST: generateRunState — semilla determinística ===\n');

// Test 1: seed=42 produce el mismo resultado dos veces
{
  console.log('Test 1: Determinismo (seed=42)');
  const a = generateRunState(42);
  const b = generateRunState(42);
  assert(a.event.id === b.event.id, `mismo evento: ${a.event.id}`);
  assert(JSON.stringify(a.monster_variants) === JSON.stringify(b.monster_variants), 'mismas variantes de monstruo');
  assert(JSON.stringify(a.rare_loot_positions) === JSON.stringify(b.rare_loot_positions), 'mismas posiciones de loot');
}

// Test 2: seed=42 y seed=43 producen resultados distintos
{
  console.log('\nTest 2: Variación entre seeds (42 vs 43)');
  const a = generateRunState(42);
  const b = generateRunState(43);
  const eventsAreDiff = a.event.id !== b.event.id;
  const variantsAreDiff = JSON.stringify(a.monster_variants) !== JSON.stringify(b.monster_variants);
  const lootAreDiff = JSON.stringify(a.rare_loot_positions) !== JSON.stringify(b.rare_loot_positions);
  assert(eventsAreDiff || variantsAreDiff || lootAreDiff, 'al menos algo es diferente entre seed 42 y 43');
  if (!eventsAreDiff) {
    console.log(`    (mismo evento ${a.event.id} para ambas — OK si variantes son distintas)`);
  }
}

// Test 3: seed=0 no crashea (edge case)
{
  console.log('\nTest 3: Edge case seed=0');
  let ok = true;
  try {
    const s = generateRunState(0);
    assert(EVENTS.some(e => e.id === s.event.id), `evento válido para seed=0: ${s.event.id}`);
  } catch (e) {
    assert(false, `seed=0 no crashea (error: ${e.message})`);
    ok = false;
  }
}

// Test 4: Distribución de 100 seeds — ningún evento supera 30%
{
  console.log('\nTest 4: Distribución de 100 seeds aleatorias');
  const counts = {};
  for (const ev of EVENTS) counts[ev.id] = 0;

  // 100 seeds determinísticas (0..99) para reproducibilidad
  for (let i = 0; i < 100; i++) {
    const state = generateRunState(i * 7919 + 42); // seeds pseudo-aleatorias pero fijas
    counts[state.event.id]++;
  }

  console.log('  Distribución de eventos:');
  let maxPct = 0;
  for (const [id, count] of Object.entries(counts)) {
    const pct = (count / 100 * 100).toFixed(1);
    console.log(`    ${id.padEnd(25)} ${count.toString().padStart(3)} (${pct}%)`);
    if (count > maxPct) maxPct = count;
  }
  assert(maxPct <= 30, `ningún evento supera 30% (máximo fue ${maxPct}%)`);
}

// Test 5: run_seed=1 — seed del primer personaje (anti-metrica: run 1 es siempre seed=1 para todos)
{
  console.log('\nTest 5: Seed=1 (run del primer personaje)');
  const s = generateRunState(1);
  console.log(`  Evento del primer run: ${s.event.title}`);
  console.log(`  Texto del guardián: "${s.event.guardian_line.slice(0, 80)}..."`);
  assert(typeof s.event.id === 'string', 'evento tiene id');
  assert(Object.keys(s.monster_variants).length === 6, 'variantes para las 6 salas');
  assert(Object.keys(s.rare_loot_positions).length === 5, 'posiciones para los 5 ítems raros');
}

// Resumen
console.log('\n─────────────────────────────────────────');
console.log(`Resultado: ${passed} pasados, ${failed} fallidos\n`);

if (failed === 0) {
  console.log('✅ Prototipo VALIDADO. La semilla es determinística y la distribución es balanceada.');
  console.log('   generateRunState(seed) está lista para integrarse en run-state.js.');
} else {
  console.log('❌ Hay fallos — revisar antes de continuar con IMPL-VV-1755.');
  process.exit(1);
}

// Mostrar ejemplo de run completo para seed=42
console.log('\n=== Ejemplo: seed=42 ===');
const example = generateRunState(42);
console.log(`Evento: [${example.event.id}] ${example.event.title}`);
console.log(`Mecánica: ${example.event.mechanic}`);
console.log(`Guardián: "${example.event.guardian_line.slice(0, 100)}..."`);
console.log('Variantes de monstruo:');
for (const [sala, variante] of Object.entries(example.monster_variants)) {
  console.log(`  Sala ${sala}: ${variante}`);
}
console.log('Posición de ítems raros:');
for (const [item, sala] of Object.entries(example.rare_loot_positions)) {
  console.log(`  ${item.padEnd(22)}: sala ${sala}`);
}
