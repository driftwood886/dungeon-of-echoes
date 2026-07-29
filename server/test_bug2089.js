/**
 * test_bug2089.js
 * 
 * Bug: Al elegir clase por primera vez en nivel >=2, los stats se resetean
 * al base de clase (nivel 1), ignorando bonos de level-ups previos.
 * 
 * Fix: cmdClase() ahora aplica bonos de nivel a los stats base de clase
 * usando levelBonus = (level - 1) * per_level_amount.
 */

'use strict';

const db = require('./db/db.js');
const engine = require('./game/engine');

const TEST_USER = '__test_bug2089__';

function cleanup() {
  try {
    const p = db.getPlayerByUsername(TEST_USER);
    if (p) db.deletePlayer(p.id);
  } catch (_) {}
}

async function run() {
  await db.init();

  let passed = true;

  // --- CASO 1: Guerrero nivel 4, primera clase ---
  cleanup();
  let player = db.createPlayer(TEST_USER);
  if (!player) player = db.getPlayerByUsername(TEST_USER);

  // Simular 3 level-ups: +5 HP * 3 = +15, +1 ATK * 3 = +3
  db.updatePlayer(player.id, {
    level: 4,
    xp: 600,
    max_hp: 45, // 30 + 15
    hp: 45,
    attack: 8,  // 5 + 3
    defense: 3,
    player_class: 'sin_clase',
  });

  console.log('--- BUG-2089 Test: Guerrero Lv4, primera clase ---');
  engine.execute(player.id, 'clase guerrero');
  const gLv4 = db.getPlayer(player.id);

  // Guerrero base: max_hp=35, attack=6, defense=4 → con 3 bonos: max_hp=50, attack=9, defense=4
  console.log(`  max_hp:  ${gLv4.max_hp}  (esperado: 50)`);
  console.log(`  attack:  ${gLv4.attack}  (esperado: 9)`);
  console.log(`  defense: ${gLv4.defense} (esperado: 4)`);

  if (gLv4.max_hp !== 50) { console.error('  FALLO: max_hp'); passed = false; }
  else console.log('  OK max_hp');
  if (gLv4.attack !== 9) { console.error('  FALLO: attack'); passed = false; }
  else console.log('  OK attack');
  if (gLv4.defense !== 4) { console.error('  FALLO: defense'); passed = false; }
  else console.log('  OK defense (4, no sube con level-up genérico)');

  // --- CASO 2: Guerrero nivel 1 (sin bonus previo) ---
  cleanup();
  player = db.createPlayer(TEST_USER);
  if (!player) player = db.getPlayerByUsername(TEST_USER);
  db.updatePlayer(player.id, { level: 1, player_class: 'sin_clase' });

  console.log('\n--- Caso: Guerrero Lv1, primera clase ---');
  engine.execute(player.id, 'clase guerrero');
  const gLv1 = db.getPlayer(player.id);

  console.log(`  max_hp:  ${gLv1.max_hp}  (esperado: 35)`);
  console.log(`  attack:  ${gLv1.attack}  (esperado: 6)`);

  if (gLv1.max_hp !== 35) { console.error('  FALLO: max_hp lv1'); passed = false; }
  else console.log('  OK max_hp lv1');
  if (gLv1.attack !== 6) { console.error('  FALLO: attack lv1'); passed = false; }
  else console.log('  OK attack lv1');

  // --- CASO 3: Mago nivel 3 (clase con mana bonus) ---
  cleanup();
  player = db.createPlayer(TEST_USER);
  if (!player) player = db.getPlayerByUsername(TEST_USER);
  db.updatePlayer(player.id, {
    level: 3,
    xp: 300,
    max_hp: 40,
    hp: 40,
    attack: 7,
    defense: 3,
    max_mana: 26, // 20 + 3*2
    mana: 26,
    player_class: 'sin_clase',
  });

  console.log('\n--- Caso: Mago Lv3, primera clase ---');
  engine.execute(player.id, 'clase mago');
  const magoLv3 = db.getPlayer(player.id);

  // Mago base: max_hp=22, attack=4, max_mana=42 → con 2 bonos: max_hp=32, attack=6, max_mana=48
  console.log(`  max_hp:   ${magoLv3.max_hp}   (esperado: 32)`);
  console.log(`  attack:   ${magoLv3.attack}   (esperado: 6)`);
  console.log(`  max_mana: ${magoLv3.max_mana} (esperado: 48)`);

  if (magoLv3.max_hp !== 32) { console.error('  FALLO: mago max_hp'); passed = false; }
  else console.log('  OK mago max_hp');
  if (magoLv3.attack !== 6) { console.error('  FALLO: mago attack'); passed = false; }
  else console.log('  OK mago attack');
  if (magoLv3.max_mana !== 48) { console.error('  FALLO: mago max_mana'); passed = false; }
  else console.log('  OK mago max_mana');

  cleanup();
  console.log(`\n${passed ? '✅ TODOS LOS TESTS PASARON' : '❌ ALGUNOS TESTS FALLARON'}`);
  process.exit(passed ? 0 : 1);
}

run().catch(err => { console.error(err); process.exit(1); });
