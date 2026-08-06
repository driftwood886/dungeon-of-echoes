/**
 * test_bug2366.js — Test para BUG-2366:
 * Mensaje de level-up invisible al matar el monstruo que completa el XP necesario.
 *
 * Reproduce:
 * 1. Jugador nivel 1 con XP justo debajo del umbral (ej: xpForLevel(2) - xpDelGoblin)
 * 2. Ataca y mata al goblin
 * 3. Verifica que el mensaje "✨ ¡Subiste al nivel 2!" aparezca en la respuesta
 */

'use strict';

const assert = require('assert');

async function main() {
  const db = require('./db/db.js');
  await db.init(':memory:');

  const engine = require('./game/engine.js');
  const xpSystem = require('./game/xp.js');

  let passed = 0;
  let failed = 0;
  let failDetails = [];

  function test(name, fn) {
    try {
      fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (e) {
      console.error(`  ✗ ${name}: ${e.message}`);
      failDetails.push({ name, error: e.message });
      failed++;
    }
  }

  // Umbral para nivel 2: xpForNextLevel(1) = 60 XP según el log anterior
  const xpForLevel2 = xpSystem.xpForNextLevel(1);
  console.log(`XP necesario para nivel 2: ${xpForLevel2}`);

  // Crear jugador de prueba en nivel 1 con XP justo por debajo del umbral
  // El Goblin Merodeador (id=1) tiene max_hp=15, da 15*2=30 XP base
  // Ponemos al jugador en xpForLevel2 - 30 para que el próximo goblin lo haga subir
  const goblinXp = Math.max(5, Math.floor(15 * 2)); // xpBase para goblin (max_hp=15)
  const startXp = Math.max(0, xpForLevel2 - goblinXp);
  console.log(`XP inicial del jugador de prueba: ${startXp} (Goblin da ~${goblinXp} XP)`);

  // Crear jugador de prueba
  let testPlayer = db.getPlayerByUsername('TestBug2366');
  if (!testPlayer) {
    testPlayer = db.createPlayer('TestBug2366');
  }
  assert.ok(testPlayer, 'jugador creado');

  // Ajustar XP para que el próximo kill suba de nivel
  db.updatePlayer(testPlayer.id, {
    xp: startXp,
    level: 1,
    hp: 30,
    max_hp: 30,
    attack: 10, // suficiente para matar de un golpe
    current_room_id: 1, // sala con goblin
  });

  // Obtener un goblin en la sala (o crearlo si no existe)
  let goblins = db.getMonstersInRoom(1).filter(m => m.name.toLowerCase().includes('goblin') && m.hp > 0);
  if (goblins.length === 0) {
    console.log('No hay goblin en sala 1, buscando en otras salas...');
    const allMonsters = db.getAllMonsters();
    console.log('Monstruos disponibles:', allMonsters.map(m => `${m.name} (sala ${m.room_id}, HP ${m.hp})`).join(', '));
  }

  if (goblins.length > 0) {
    const goblin = goblins[0];
    // Reducir HP del goblin a 1 para garantizar que muera en el próximo ataque
    db.updateMonster(goblin.id, { hp: 1 });
    console.log(`Goblin preparado: ${goblin.name} (id=${goblin.id}, HP=1)`);

    // Ejecutar ataque
    const resultAtk = engine.execute(testPlayer.id, 'atacar', {});
    console.log('\n--- Resultado del ataque (turno del kill) ---');
    console.log(resultAtk.text || '(VACÍO)');
    console.log('--- Fin resultado ---\n');

    test('El resultado no está vacío', () => {
      assert.ok(resultAtk.text && resultAtk.text.trim().length > 0, 
        `El resultado del ataque está vacío. Texto: "${resultAtk.text}"`);
    });

    test('Contiene mensaje de level-up', () => {
      const hasLevelUp = (resultAtk.text || '').toLowerCase().includes('nivel 2') ||
                         (resultAtk.text || '').toLowerCase().includes('nivel') &&
                         (resultAtk.text || '').includes('✨');
      assert.ok(hasLevelUp, 
        `No se encontró mensaje de level-up en: "${resultAtk.text}"`);
    });

    // Verificar estado del jugador
    const playerAfter = db.getPlayer(testPlayer.id);
    test('El jugador subió a nivel 2', () => {
      assert.strictEqual(playerAfter.level, 2, 
        `El jugador sigue en nivel ${playerAfter.level} (esperaba 2)`);
    });

    test('El mensaje de kill está presente (monstruo muerto)', () => {
      const hasKillMsg = (resultAtk.text || '').includes('💀') ||
                         (resultAtk.text || '').toLowerCase().includes('cae');
      assert.ok(hasKillMsg, 
        `No hay mensaje de kill en la respuesta: "${resultAtk.text}"`);
    });

    test('El XP ganado aparece en el mensaje', () => {
      const hasXpMsg = (resultAtk.text || '').includes('XP') ||
                       (resultAtk.text || '').includes('⭐');
      assert.ok(hasXpMsg,
        `No hay mensaje de XP en la respuesta: "${resultAtk.text}"`);
    });

  } else {
    console.log('SKIP: No se encontró goblin para el test');
    // Intentar con cualquier monstruo
    const allMonsters = db.getAllMonsters().filter(m => m.hp > 0 && m.room_id !== null);
    if (allMonsters.length > 0) {
      const mon = allMonsters[0];
      console.log(`Usando ${mon.name} (sala ${mon.room_id}) para el test`);
      db.updatePlayer(testPlayer.id, { current_room_id: mon.room_id });
      db.updateMonster(mon.id, { hp: 1 });

      const resultAtk = engine.execute(testPlayer.id, 'atacar', {});
      console.log('\n--- Resultado del ataque (turno del kill) ---');
      console.log(resultAtk.text || '(VACÍO)');
      console.log('--- Fin resultado ---\n');

      test('El resultado no está vacío (monstruo alternativo)', () => {
        assert.ok(resultAtk.text && resultAtk.text.trim().length > 0, 
          `El resultado del ataque está vacío: "${resultAtk.text}"`);
      });

      test('El jugador subió de nivel (monstruo alternativo)', () => {
        const playerAfter = db.getPlayer(testPlayer.id);
        assert.strictEqual(playerAfter.level, 2,
          `El jugador sigue en nivel ${playerAfter.level} (esperaba 2)`);
      });

      test('El mensaje de level-up está en el texto (monstruo alternativo)', () => {
        const hasLvlUp = (resultAtk.text || '').includes('✨') ||
                         (resultAtk.text || '').toLowerCase().includes('nivel 2') ||
                         (resultAtk.text || '').toLowerCase().includes('subiste');
        assert.ok(hasLvlUp,
          `No se encontró mensaje de level-up en: "${resultAtk.text}"`);
      });
    } else {
      console.log('ERROR: No hay monstruos disponibles para hacer el test');
    }
  }

  console.log(`\n${passed + failed} tests — ${passed} PASS, ${failed} FAIL`);
  if (failDetails.length > 0) {
    console.log('\nFallas:');
    for (const f of failDetails) {
      console.log(`  - ${f.name}: ${f.error}`);
    }
  }
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
