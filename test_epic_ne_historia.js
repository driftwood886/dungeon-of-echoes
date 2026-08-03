/**
 * test_epic_ne_historia.js — EPIC-NE-IMPL-2270
 * Tests básicos para buildPlayerNarrative() y el comando `historia`.
 */

'use strict';

const { buildPlayerNarrative } = require('./server/game/narrative');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failed++;
  }
}

// ── Test 1: Jugador nuevo (versión mínima) ────────────────────────────────────
console.log('\n[Test 1] Jugador nuevo — versión mínima');
{
  const player = {
    id: 1, username: 'gandalf', player_class: 'mago',
    level: 1, kills: 0, deaths: 0, playtime_minutes: 0,
    ascension_count: 0, specialization: null, gold: 10, gold_spent: 0,
    crafts_count: 0, rooms_visited: '[]',
    created_at: new Date().toISOString(),
    main_quest_data: '{}', weekly_contract: null,
  };
  const text = buildPlayerNarrative(player, [], []);
  assert(text.includes('GANDALF'), 'username en mayúsculas');
  assert(text.includes('Mago'), 'clase en display');
  assert(text.includes('La historia se escribe con kills'), 'texto de jugador nuevo');
  assert(text.includes('╔') && text.includes('╚'), 'bordes Unicode presentes');
}

// ── Test 2: Jugador con kills y momentos ──────────────────────────────────────
console.log('\n[Test 2] Jugador con historial');
{
  const created = new Date(Date.now() - 3 * 86400000).toISOString(); // hace 3 días
  const player = {
    id: 2, username: 'drax', player_class: 'guerrero',
    level: 5, kills: 42, deaths: 2, playtime_minutes: 120,
    ascension_count: 0, specialization: null, gold: 150, gold_spent: 80,
    crafts_count: 1, rooms_visited: JSON.stringify([1,2,3,4,5,6,7,8]),
    created_at: created,
    main_quest_data: '{}', weekly_contract: null,
  };
  const moments = [
    { id: 1, player_id: 2, moment_type: 'primer_kill', description_text: 'Primer kill: Goblin Merodeador.', context_json: '{}', created_at: created },
    { id: 2, player_id: 2, moment_type: 'boss_kill', description_text: 'Derrotaste al Guardia Espectral a nivel 3.', context_json: '{}', created_at: created },
  ];
  const text = buildPlayerNarrative(player, moments, []);
  assert(text.includes('DRAX'), 'username correcto');
  assert(text.includes('42 kills'), 'kills mostrados');
  assert(text.includes('MOMENTOS CUMBRE'), 'sección de momentos presente');
  assert(text.includes('☠️'), 'emoji de boss_kill presente');
  assert(text.includes('⚔️'), 'emoji de primer_kill presente');
  assert(text.includes('Guardia Espectral'), 'texto de boss_kill');
  assert(text.includes('Combate primero') || text.includes('firma'), 'firma de juego o texto agresivo');
}

// ── Test 3: Jugador con quest activa ──────────────────────────────────────────
console.log('\n[Test 3] Jugador con quest activa');
{
  const player = {
    id: 3, username: 'aria', player_class: 'clerigo',
    level: 3, kills: 10, deaths: 1, playtime_minutes: 60,
    ascension_count: 0, specialization: 'sanador', gold: 50, gold_spent: 30,
    crafts_count: 0, rooms_visited: JSON.stringify([1,2,3,4,5,6,7,8,9,10,11,12]),
    created_at: new Date(Date.now() - 2 * 86400000).toISOString(),
    main_quest_data: JSON.stringify({ main_quest_state: 'active', fragments_found: ['f1', 'f2'] }),
    weekly_contract: null,
  };
  const quests = [
    { id: 1, quest_id: 'q1', slot: 1, status: 'active',
      name: 'El Cazador de Sombras', type: 'kill',
      progress: JSON.stringify({ kills: 1 }),
      condition: JSON.stringify({ count: 3 }),
    }
  ];
  const text = buildPlayerNarrative(player, [], quests);
  assert(text.includes('Sanador'), 'especialización mostrada');
  assert(text.includes('DEUDA PENDIENTE') || text.includes('Quest principal'), 'sección de deuda presente');
  assert(text.includes('2/4 fragmentos'), 'progreso de quest principal');
  assert(text.includes('El Cazador de Sombras'), 'quest activa mostrada');
}

// ── Test 4: Manejo defensivo — campos faltantes ───────────────────────────────
console.log('\n[Test 4] Manejo defensivo — player con campos mínimos');
{
  const player = { id: 4, username: 'minimal' };
  let errorThrown = false;
  let text = '';
  try {
    text = buildPlayerNarrative(player, null, null);
  } catch (e) {
    errorThrown = true;
    console.error('  Error:', e.message);
  }
  assert(!errorThrown, 'no lanza error con player mínimo');
  assert(typeof text === 'string' && text.length > 0, 'devuelve string no vacío');
}

// ── Resumen ───────────────────────────────────────────────────────────────────
console.log(`\n── Resultados: ${passed} passed, ${failed} failed ──`);
if (failed > 0) process.exit(1);
