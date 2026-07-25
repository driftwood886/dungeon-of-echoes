// Test BUG-1934: verificar que onPickup asigna la quest correctamente
const db = require('./server/db/db');

db.init().then(() => {
const questEngine = require('./server/game/questEngine');

const rawDb = db.raw();
const TEST_PLAYER_ID = 'test_bug1934_' + Date.now();

rawDb.run(`
  INSERT OR REPLACE INTO players (id, username, hp, max_hp, attack, defense, 
    gold, xp, level, kills, current_room_id, inventory, player_class)
  VALUES (?, ?, 30, 30, 5, 3, 50, 0, 1, 0, 1, '[]', 'guerrero')
`, [TEST_PLAYER_ID, 'TestBug1934']);

const player = db.getPlayer(TEST_PLAYER_ID);
console.log('Player creado:', player ? 'OK' : 'FAIL');

// Test 1: ítem irrelevante → null
const r1 = questEngine.onPickup(player, 'poción de salud');
console.log('Test1 (ítem irrelevante → null):', r1 === null ? 'PASS ✓' : 'FAIL ✗', r1);

// Test 2: escudo roto → asigna quest
const r2 = questEngine.onPickup(player, 'escudo roto');
console.log('Test2 (escudo roto → asigna quest):', r2 !== null ? 'PASS ✓' : 'FAIL ✗', r2);

// Verificar en DB
const check = rawDb.exec(
  `SELECT quest_id, status, slot FROM player_quests WHERE player_id = ?`,
  [TEST_PLAYER_ID]
);
const quests = check.length ? check[0].values : [];
console.log('Quests en DB:', quests);

// Test 3: duplicado → null
const freshPlayer = db.getPlayer(TEST_PLAYER_ID);
const r3 = questEngine.onPickup(freshPlayer, 'garra de esqueleto');
console.log('Test3 (duplicado → null):', r3 === null ? 'PASS ✓' : 'FAIL ✗', r3);

// Test 4: bot → null
const r4 = questEngine.onPickup({ ...player, is_bot: true }, 'escudo roto');
console.log('Test4 (bot → null):', r4 === null ? 'PASS ✓' : 'FAIL ✗', r4);

// Cleanup
rawDb.run('DELETE FROM players WHERE id = ?', [TEST_PLAYER_ID]);
rawDb.run('DELETE FROM player_quests WHERE player_id = ?', [TEST_PLAYER_ID]);
console.log('Cleanup OK — DONE');
process.exit(0);
}).catch(e => { console.error('ERROR init:', e); process.exit(1); });
