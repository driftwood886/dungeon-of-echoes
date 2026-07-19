/**
 * run-state.js — EPIC-VV-1755: Generador de estado del run (Variación Viva)
 *
 * Función central: generateRunState(seed)
 * Dado un número entero como semilla, genera de forma determinística:
 *   - El evento activo del run (uno de 6 posibles)
 *   - Las variantes de monstruo para 6 salas variables
 *   - Las posiciones de ítems raros para 5 ítems
 *
 * PRNG: Linear Congruential Generator (LCG Knuth) — sin dependencias externas.
 * Validado con 9/9 tests en scripts/test-run-seed.js (EPIC-VV-1754).
 */

'use strict';

// ─── PRNG: Linear Congruential Generator ─────────────────────────────────────
// Parámetros Knuth. Sin deps externos, determinístico, uniform en [0, 1).
function makePRNG(seed) {
  let s = seed >>> 0; // entero sin signo 32-bit
  if (s === 0) s = 1; // 0 rompe el LCG
  return function next() {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0xFFFFFFFF; // float [0, 1)
  };
}

// ─── Definición de los 6 eventos ─────────────────────────────────────────────
// Diseño completo en: disenos/epic-vv-1751-eventos.md
const EVENTS = [
  {
    id: 'marea_no_muertos',
    title: 'Marea de No-Muertos',
    emoji: '💀',
    mechanic: 'undead_hp_bonus:2,boss_hp_bonus:5,rune_drop_rate:1.2',
    guardian_line:
      'Esta noche las sombras se mueven diferente. Los esqueletos más allá de la entrada están... más activos que de costumbre. Los no-muertos sienten que algo los llama. Tienen más aguante — y quieren hacerlo valer. Si podés, enfrentalos con reserva.',
    challenge_id: 'marea_no_muertos_challenge',
    challenge_desc: 'Matar 3 monstruos no-muertos en un solo run → +25 XP',
    challenge_xp: 25,
    challenge_msg: '💀 Navegaste la Marea — 3 no-muertos caídos en el pico de su poder. La oscuridad te reconoce.',
  },
  {
    id: 'caceria_del_filo',
    title: 'Cacería de la Orden',
    emoji: '⚔️',
    mechanic: 'boss_loot_double,boss_kill_faction_pts:5',
    guardian_line:
      'La Orden del Filo está activa esta noche. Se rumorea que pagan bien por los bosses caídos — doble loot si matás alguno y se lo mostrás al escriba. Si sos de la Orden, los tuyos te reconocerán. Si no... también cobran de todos modos.',
    challenge_id: 'caceria_del_filo_challenge',
    challenge_desc: 'Matar al Espectro del Corredor Y al Lich en el mismo run → +40 XP',
    challenge_xp: 40,
    challenge_msg: '⚔️ La Orden registra tu hazaña — dos bosses en un solo run. Tu nombre circula entre los cazadores.',
  },
  {
    id: 'plaga_arcana',
    title: 'Plaga Arcana',
    emoji: '⚡',
    mechanic: 'cast_double_chance:0.2,elemental_hp_bonus:10',
    guardian_line:
      'El escriba está nervioso — dice que las runas en las paredes están vibrando de un modo que no había visto en años. Si sabés magia, esta noche tus hechizos pueden sorprenderte (para bien). Los Elementales... están absorbiendo esa misma energía. Más aguante, más peligrosos.',
    challenge_id: 'plaga_arcana_challenge',
    challenge_desc: 'Lanzar 5 hechizos en un solo run → +20 XP',
    challenge_xp: 20,
    challenge_msg: '⚡ La plaga arcana reconoce a alguien que sabe usarla. Cada hechizo resonó con la energía del dungeon.',
  },
  {
    id: 'festival_de_loot',
    title: 'Mercado Activo',
    emoji: '💰',
    mechanic: 'first_item_identified,auction_items:3',
    guardian_line:
      'Los mercaderes están contentos esta noche. El dungeon está generoso — el primer objeto que encontrés en cada sala te hablará directamente, sin adivinar qué es. La Casa de Subastas tiene tres veces más que de costumbre. Buen momento para llenar la bolsa.',
    challenge_id: 'festival_de_loot_challenge',
    challenge_desc: 'Recoger 10 ítems en un solo run → +15 XP',
    challenge_xp: 15,
    challenge_msg: '💰 Diez objetos recogidos en un run del Mercado Activo. Los mercaderes te reconocerían si te vieran.',
  },
  {
    id: 'silencio_del_abismo',
    title: 'El Dungeon Callado',
    emoji: '🌑',
    mechanic: 'monster_no_killtext,boss_epic_lines,inscription_xp:2',
    guardian_line:
      'Hoy el dungeon está... callado. Los monstruos menores no van a gritar al caer — no es que sean más fáciles, es que algo les cerró la boca. Los grandes tienen algo que decir esta noche, más que nunca. Y las inscripciones en las paredes parecen más claras, más urgentes. Vale la pena leerlas.',
    challenge_id: 'silencio_challenge',
    challenge_desc: 'Leer 3 inscripciones en un solo run → +20 XP',
    challenge_xp: 20,
    challenge_msg: '🌑 El Dungeon Callado reveló sus secretos a quien supo escuchar. Tres inscripciones leídas en la noche más silenciosa.',
  },
  {
    id: 'temporada_de_sangre',
    title: 'Temporada de Sangre',
    emoji: '🩸',
    mechanic: 'low_hp_atk_bonus:3,monster_herb_drop,chapel_charges:2',
    guardian_line:
      'El dungeon huele a sangre esta noche. Los que llegan al límite — menos de un tercio de vida — van a pelear con una furia que no conocen en condiciones normales. No es magia, es desesperación con forma. Los monstruos también lo saben: dejaron más hierbas que de costumbre. Es un ciclo.',
    challenge_id: 'temporada_sangre_challenge',
    challenge_desc: 'Ganar un combate con HP ≤ 30% → +20 XP',
    challenge_xp: 20,
    challenge_msg: '🩸 Pelear al límite y ganar. Eso es lo que la Temporada de Sangre premia.',
  },
];

// ─── Pools de variantes de monstruo por sala ──────────────────────────────────
// Sala 8 es especial: solo varía si el evento es plaga_arcana.
// Diseño completo en: disenos/epic-variacion-viva.md §Monstruos Variables
const MONSTER_VARIANT_POOLS = {
  2:  ['base', 'gnoll_explorador_murcielago', 'rata_gigante_x3'],
  3:  ['base', 'gnoll_merodeador_arana', 'zombie_caminante_x2'],
  6:  ['base', 'arana_tejedora_x2', 'gnoll_merodeador_rata'],
  7:  ['base', 'rata_gigante_x2', 'gnoll_merodeador'],
  8:  ['normal', 'elemental_mana_adicional'],  // condicionado a plaga_arcana
  20: ['base', 'troll_x2_guardia', 'golem_elemental_fuego'],
};

// ─── Pools de posición de ítems raros ─────────────────────────────────────────
// Diseño completo en: disenos/epic-vv-1750-bd-schema.md §run_loot_positions
const RARE_LOOT_POOLS = {
  paginas_congeladas: [14, 6, 19],
  cristal_resonante:  [13, 7, 8],
  pocion_de_poder:    [19, 20, 14],
  pergamino_arcano:   [2, 5, 6],
  totem_astillado:    [10, 15, 7],
};

// ─── Función principal ─────────────────────────────────────────────────────────

/**
 * Genera el estado completo de un run dado una semilla entera.
 * El mismo seed siempre produce el mismo resultado (determinístico).
 *
 * @param {number} seed — entero sin signo 32-bit
 * @returns {{ event: object, monster_variants: object, rare_loot_positions: object }}
 */
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

/**
 * Genera una semilla nueva usando timestamp + Math.random().
 * No determinístico (para crear nuevos runs únicos).
 *
 * @returns {number} — entero sin signo 32-bit
 */
function generateNewSeed() {
  // Combinar timestamp (baja resolución pero variable) con Math.random() para más entropía
  const ts = Date.now() & 0xFFFFFFFF;
  const r = Math.floor(Math.random() * 0xFFFF);
  return ((ts ^ (r << 16)) >>> 0) || 1; // >>> 0 asegura uint32, fallback a 1 si 0
}

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  generateRunState,
  generateNewSeed,
  EVENTS,
  MONSTER_VARIANT_POOLS,
  RARE_LOOT_POOLS,
};
