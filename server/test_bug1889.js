/**
 * Test BUG-1889: pray Xg (oro directo) debe disparar onRitual en questEngine.
 *
 * Antes del fix: el path goldMatch en cmdPray retornaba sin llamar a onRitual().
 * Después del fix: questEngine.onRitual() se llama también para oro directo.
 */

const db = require('./db/db');
const engine = require('./game/engine');
const questEngine = require('./game/questEngine');

// Crear o recuperar un jugador bot de test
let player = db.getPlayerByUsername('bot_bug1889');
if (!player) {
  player = db.createPlayer('bot_bug1889');
  db.updatePlayer(player.id, { is_bot: 1 });
  player = db.getPlayer(player.id);
}

// Configurar jugador en Santuario Profano (sala 10), con oro suficiente
db.updatePlayer(player.id, {
  current_room_id: 10,
  hp: 50,
  max_hp: 50,
  gold: 50,
  xp: 0,
  level: 1,
  status_effects: '{}',
});
player = db.getPlayer(player.id);

// Monkey-patch onRitual para verificar que se llama
let onRitualCalled = false;
const originalOnRitual = questEngine.onRitual.bind(questEngine);
questEngine.onRitual = (p, type) => {
  if (type === 'pray') {
    onRitualCalled = true;
    console.log(`✓ questEngine.onRitual() invocado con type="${type}", player=${p.username}`);
  }
  return originalOnRitual(p, type);
};

console.log(`\nJugador: ${player.username}, sala: ${player.current_room_id}, oro: ${player.gold}g`);
console.log('Ejecutando: pray 10g\n');

const result = engine.execute(player.id, 'pray 10g', {});

console.log('=== RESULTADO ===');
console.log(result.text);
console.log('\n=== ANÁLISIS ===');
console.log(`onRitual() invocado: ${onRitualCalled}`);

if (onRitualCalled) {
  console.log('\n✅ BUG-1889 CORREGIDO: pray Xg ahora dispara onRitual() en questEngine.');
} else {
  console.log('\n❌ BUG-1889 NO corregido: onRitual() no fue invocado.');
  process.exit(1);
}
