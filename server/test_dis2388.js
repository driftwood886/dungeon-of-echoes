/**
 * test_dis2388.js — Test para DIS-2388
 * Level-up silencioso durante movimiento a sala nueva (XP de exploración)
 *
 * Escenario:
 * - Jugador nivel 1 con XP = 50 (justo por debajo de nivel 2 = 60 XP)
 * - Mueve a sala nueva (primera vez) → +10 XP de exploración → total 60 XP → debería subir a nivel 2
 * - El mensaje de movimiento debe incluir "¡SUBÍS AL NIVEL 2!"
 */

'use strict';

const assert = require('assert');

async function main() {
  const db = require('./db/db.js');
  await db.init(':memory:');

  const engine = require('./game/engine.js');
  const xp = require('./game/xp.js');

  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (e) {
      console.error(`  ✗ ${name}: ${e.message}`);
      failed++;
    }
  }

  // Umbral para nivel 2: 60 XP
  const xpForLevel2 = xp.xpForLevel(2);
  console.log(`XP necesario para nivel 2: ${xpForLevel2}`);

  // Crear jugador de prueba
  let testPlayer = db.getPlayerByUsername('TestDIS2388');
  if (!testPlayer) {
    testPlayer = db.createPlayer('TestDIS2388');
  }
  assert.ok(testPlayer, 'jugador creado');

  // Configurar: nivel 1, XP = 50 (10 XP por debajo del nivel 2),
  // en sala 1 (Entrada de la Cripta), sin salas visitadas previas
  // Configurar: nivel 1, XP = 30 (necesita 30 XP más para nivel 2 = 60),
  // en sala 1, con desafío diario de "visitar salas" (goal=1, progress=0)
  // El movimiento a sala 2 completará el desafío (+30 XP) → debería subir a nivel 2
  db.updatePlayer(testPlayer.id, {
    xp: xpForLevel2 - 30,  // 30 XP — le falta 30 para subir (exactamente el reward del desafío)
    level: 1,
    hp: 30,
    max_hp: 30,
    attack: 5,
    current_room_id: 1,
    rooms_visited: '[]',  // sin salas visitadas
    // Asegurar que el tutorial esté completado para que cmdMove procese normalmente
    tutorial_step: 0,
    player_class: 'guerrero',  // necesario para evitar bloqueo de "sin clase"
    // Configurar desafío diario de visitar 1 sala (meta que se cumplirá al primer movimiento)
    daily_challenge: JSON.stringify({
      type: 'rooms',
      goal: 1,
      progress: 0,
      done: false,
      desc: 'Visitar 1 sala nueva',
      date: new Date().toISOString().slice(0, 10),
      rooms_today: [],
    }),
  });

  const playerBefore = db.getPlayer(testPlayer.id);
  console.log(`Estado inicial: nivel=${playerBefore.level}, XP=${playerBefore.xp}, sala=${playerBefore.current_room_id}`);
  console.log(`Para subir de nivel: necesita ${xpForLevel2 - playerBefore.xp} XP más`);
  console.log(`Desafío diario: rooms(1) — se completará al mover → +30 XP`);
  console.log(`XP de exploración (primera sala, bonus): +10 XP adicionales`);
  console.log(`→ Total XP tras movimiento: ${playerBefore.xp + 30 + 10} XP = nivel 2\n`);

  // Mover norte (sala 1 → sala 2 = Corredor, primera visita)
  console.log('--- Moviendo norte a sala 2 (primera visita) ---');
  const moveResult = engine.execute(testPlayer.id, 'norte');
  console.log('Respuesta del movimiento:');
  console.log(moveResult.text || '(VACÍO)');
  console.log('--- Fin respuesta ---\n');

  const playerAfter = db.getPlayer(testPlayer.id);
  console.log(`Estado tras el movimiento: nivel=${playerAfter.level}, XP=${playerAfter.xp}, sala=${playerAfter.current_room_id}`);

  test('El jugador se movió a sala 2', () => {
    assert.strictEqual(playerAfter.current_room_id, 2,
      `El jugador está en sala ${playerAfter.current_room_id} (esperaba sala 2)`);
  });

  test('El jugador subió a nivel 2', () => {
    assert.strictEqual(playerAfter.level, 2,
      `El jugador está en nivel ${playerAfter.level} (esperaba nivel 2)`);
  });

  test('El mensaje incluye XP de exploración', () => {
    const hasExploration = (moveResult.text || '').includes('Primera vez') ||
                           (moveResult.text || '').includes('XP de explorador') ||
                           (moveResult.text || '').includes('explorador');
    assert.ok(hasExploration,
      `No se encontró mensaje de XP de exploración en: "${(moveResult.text || '').slice(0, 200)}"`);
  });

  test('El mensaje de level-up ES VISIBLE (DIS-2388)', () => {
    const hasLevelUp = (moveResult.text || '').includes('NIVEL 2') ||
                       (moveResult.text || '').includes('SUBÍS AL NIVEL') ||
                       ((moveResult.text || '').includes('✨') && (moveResult.text || '').includes('nivel'));
    assert.ok(hasLevelUp,
      `❌ LEVEL-UP SILENCIOSO: el jugador subió a nivel 2 pero el mensaje NO aparece en la respuesta del movimiento.\n` +
      `Texto recibido: "${(moveResult.text || '').slice(0, 500)}"`);
  });

  // ──────────────────────────────────────────────────────────────────────────────
  // Test 2: Revisita — jugador a nivel 1 con XP = 30, visita sala REVISITADA con desafío diario activo
  // El desafío da +30 XP → nivel 2, pero la sala es revisita (no hay explorationMsg) → level-up debe aparecer igual
  console.log('\n\n=== TEST 2: Revisita con desafío diario rooms (DIS-2388 caso B) ===');
  db.updatePlayer(testPlayer.id, {
    current_room_id: 2,
    level: 1,
    xp: 30,
    hp: 30,
    max_hp: 30,
    attack: 5,
    daily_challenge: JSON.stringify({
      type: 'rooms',
      goal: 1,
      progress: 0,
      done: false,
      desc: 'Visitar 1 sala nueva',
      date: new Date().toISOString().slice(0, 10),
      rooms_today: [],  // sala 1 no visitada hoy → completará el desafío
    }),
  });

  const moveResult2 = engine.execute(testPlayer.id, 'sur'); // sala 2 → sala 1 (revisita)
  console.log('Respuesta:');
  console.log(moveResult2.text);
  const playerAfter2 = db.getPlayer(testPlayer.id);
  console.log(`\nEstado: nivel=${playerAfter2.level}, XP=${playerAfter2.xp}`);

  test('TEST2: jugador subió a nivel 2 (revisita + desafío)', () => {
    assert.strictEqual(playerAfter2.level, 2,
      `El jugador está en nivel ${playerAfter2.level} (esperaba nivel 2)`);
  });

  test('TEST2: mensaje de level-up visible en revisita (DIS-2388 caso B)', () => {
    const hasLevelUp = (moveResult2.text || '').includes('NIVEL 2') ||
                       (moveResult2.text || '').includes('SUBÍS AL NIVEL') ||
                       ((moveResult2.text || '').includes('✨') && (moveResult2.text || '').includes('nivel'));
    assert.ok(hasLevelUp,
      `❌ LEVEL-UP SILENCIOSO en revisita: mensaje no encontrado.\nTexto: "${(moveResult2.text || '').slice(0, 500)}"`);
  });

  console.log(`\n${passed + failed} tests — ${passed} PASS, ${failed} FAIL`);

  if (failed > 0) {
    console.log('\n⚠️  DIS-2388 CONFIRMADO: level-up silencioso durante exploración');
    process.exit(1);
  } else {
    console.log('\n✅  DIS-2388 NO reproduce en este entorno (o ya fue corregido)');
    process.exit(0);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
