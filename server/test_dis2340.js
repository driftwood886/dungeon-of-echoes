/**
 * test_dis2340.js — DIS-2340: Verificar que cicatrices boss_kill se suprimen
 * cuando ya hay un eco boss_kill mostrado en la misma sala.
 */
'use strict';

// Mock db para aislar sin base de datos real
const db = {
  getLatestRoomEcho: null,
  getFallenLootInRoom: () => [],
  getActiveRoomScars: null,
};

// Inyectar mock en lugar del módulo real
const Module = require('module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request.endsWith('/db') || request === '../db') {
    return db;
  }
  return originalLoad.apply(this, arguments);
};

const ecos = require('./game/ecos.js');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✅ PASS: ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${msg}`);
    failed++;
  }
}

const now = new Date().toISOString();

// ── Test 1: boss_kill echo + boss_kill scar → scar debe suprimirse ──────────
console.log('\nTest 1: boss_kill eco + boss_kill scar → scar suprimida');
db.getLatestRoomEcho = () => ({
  echo_type: 'boss_kill',
  echo_text: '⚔️ La sombra de Gandalf todavía resuena aquí — derrotó a Lich Anciano',
  created_at: now,
});
db.getActiveRoomScars = () => ([{
  scar_type: 'boss_kill',
  context: JSON.stringify({ boss_name: 'Lich Anciano', player_won: true }),
  created_at: now,
}]);

const result1 = ecos.renderRoomEcos(1);
assert(result1.includes('La sombra de Gandalf'), 'Eco boss_kill mostrado');
assert(!result1.includes('La tierra frente'), 'Scar boss_kill suprimida cuando eco boss_kill presente');

// ── Test 2: solo boss_kill scar (sin eco) → scar debe mostrarse ─────────────
console.log('\nTest 2: solo boss_kill scar (sin eco) → scar se muestra normal');
db.getLatestRoomEcho = () => null;
db.getActiveRoomScars = () => ([{
  scar_type: 'boss_kill',
  context: JSON.stringify({ boss_name: 'Lich Anciano', player_won: true }),
  created_at: now,
}]);

const result2 = ecos.renderRoomEcos(2);
assert(result2.includes('La tierra frente'), 'Scar boss_kill visible sin eco');

// ── Test 3: player_death echo + boss_kill scar → scar sigue visible ─────────
console.log('\nTest 3: player_death eco + boss_kill scar → scar sigue visible');
db.getLatestRoomEcho = () => ({
  echo_type: 'player_death',
  echo_text: '💀 Las sombras guardan la memoria de Frodo',
  created_at: now,
});
db.getActiveRoomScars = () => ([{
  scar_type: 'boss_kill',
  context: JSON.stringify({ boss_name: 'Lich Anciano', player_won: true }),
  created_at: now,
}]);

const result3 = ecos.renderRoomEcos(3);
assert(result3.includes('Las sombras guardan'), 'Eco player_death visible');
assert(result3.includes('La tierra frente'), 'Scar boss_kill visible cuando eco es de distinto tipo');

// ── Test 4: combat_intense scar no se suprime por ningún tipo de eco ─────────
console.log('\nTest 4: boss_kill eco + combat_intense scar → combat scar visible');
db.getLatestRoomEcho = () => ({
  echo_type: 'boss_kill',
  echo_text: '⚔️ La sombra de X todavía resuena aquí',
  created_at: now,
});
db.getActiveRoomScars = () => ([{
  scar_type: 'combat_intense',
  context: '{}',
  created_at: now,
}]);

const result4 = ecos.renderRoomEcos(4);
assert(result4.includes('Marcas de combate'), 'combat_intense scar sigue visible junto a boss_kill eco');

// ── Resumen ──────────────────────────────────────────────────────────────────
console.log(`\nResultados: ${passed}/${passed + failed} PASS\n`);
process.exit(failed > 0 ? 1 : 0);
