/**
 * Test BUG-2301: Level up por exploración debe mostrar detalles de stats.
 * Verifica que al subir de nivel via XP de exploración, el mensaje incluye
 * "+5 HP" y "+1 ATK" igual que en combate.
 */
'use strict';

const db = require('./db/db.js');
const engine = require('./game/engine.js');

async function main() {
  await db.init();

  const username = 'BugBot2301_' + Date.now();
  let player = db.createPlayer(username);
  const pid = player.id;
  console.log(`[TEST] Jugador: ${player.username} (id=${pid})`);

  // XP para nivel 2 — basándonos en xpForLevel, probemos valor 90 (ajustar si es necesario)
  db.updatePlayer(pid, {
    level: 1,
    xp: 90,
    hp: 25,
    max_hp: 30,
    attack: 5,
    gold: 50,
    player_class: 'guerrero',
    current_room_id: 1,
    status_effects: JSON.stringify({}),
    rooms_visited: JSON.stringify([1]),  // solo sala 1 visitada
  });

  player = db.getPlayer(pid);
  console.log(`[TEST] XP antes: ${player.xp}, nivel: ${player.level}, HP: ${player.hp}/${player.max_hp}, ATK: ${player.attack}, clase: ${player.player_class}`);

  // Ver cuánto XP necesita para nivel 2
  const xp = require('./game/xp.js');
  const lvl2Xp = xp.xpForLevel ? xp.xpForLevel(2) : xp.xpThresholds ? xp.xpThresholds[2] : '?';
  console.log('[TEST] XP para nivel 2:', lvl2Xp);
  // Verificar nivel actual
  const lvlCheck = xp.levelFromXp(90);
  const lvlCheck2 = xp.levelFromXp(100);
  console.log(`[TEST] level(90 XP)=${lvlCheck}, level(100 XP)=${lvlCheck2}`);

  // Explorar sala 2 (sala norte — primera visita → +10 XP)
  console.log('\n--- move north ---');
  const result = engine.execute(pid, 'move north');
  const text = result.text || result.error || '';
  console.log(text.slice(0, 800));

  const freshAfter = db.getPlayer(pid);
  console.log(`\n[TEST] Estado después: nivel=${freshAfter.level}, xp=${freshAfter.xp}, hp=${freshAfter.hp}/${freshAfter.max_hp}, atk=${freshAfter.attack}`);

  // Verificar
  const hasLevelUp = text.includes('SUBÍS AL NIVEL') || text.includes('Subiste al nivel');
  const hasStats = text.includes('+5 HP') || text.includes('+1 ATK') || text.includes('HP máx');
  const hasHpBar = /\d+\/\d+ HP/.test(text);
  const isOldBugMsg = hasLevelUp && !hasStats;

  console.log('\n--- Resultado ---');
  console.log('¿Hubo level up?', hasLevelUp ? '✅ SÍ' : '❌ NO');
  console.log('¿Tiene stats (+5 HP, +1 ATK)?', hasStats ? '✅ SÍ' : '❌ NO');
  console.log('¿Tiene barra HP (X/Y HP)?', hasHpBar ? '✅ SÍ' : '❌ NO');

  let passed = true;
  if (hasLevelUp && isOldBugMsg) {
    console.log('\n❌ TEST FALLÓ: bug sigue presente — level up sin detalles de stats');
    passed = false;
  } else if (hasLevelUp && hasStats) {
    console.log('\n✅ TEST PASÓ: level up muestra stats correctamente');
  } else if (!hasLevelUp) {
    const newXp = 90 + 10;
    console.log(`\nℹ️  No hubo level up con ${newXp} XP. Ajustar XP inicial en el test.`);
    passed = false;
  }

  console.log('[TEST] Fin.');
  process.exit(passed ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
