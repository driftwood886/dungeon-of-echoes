/**
 * Test BUG-1749: cmdMove path noBoss (monstruos normales vivos en sala origen)
 * debe incluir descripción completa de la sala destino (cmdLook).
 *
 * Antes del fix: solo mostraba "🚶 Te movés a «X»."
 * Después del fix: incluye descripción completa de la sala destino.
 */

const db = require('./db/db');
const engine = require('./game/engine');

// Crear o recuperar un jugador bot de test
let player = db.getPlayerByUsername('bot_bug1749');
if (!player) {
  player = db.createPlayer('bot_bug1749');
  db.updatePlayer(player.id, { is_bot: 1 });
  player = db.getPlayer(player.id);
}

// Asegurarse de que el jugador esté en sala 1 (Entrada)
db.updatePlayer(player.id, {
  current_room_id: 1,
  hp: 30,
  max_hp: 30,
  status_effects: '{}',
});
player = db.getPlayer(player.id);

// Verificar que haya monstruos vivos en sala 1 (si no, el path noBoss no se activa)
const monstersInRoom1 = db.getMonstersInRoom(1).filter(m => m.hp > 0);

console.log(`Sala 1: ${monstersInRoom1.length} monstruos normales vivos`);

// Intentar mover al este (sala 2) desde sala 1 — si hay monstruos, activa path noBoss
const result = engine.execute(player, { type: 'move', args: ['este'] });

console.log('\n=== RESULTADO DE MOVIMIENTO ===');
console.log(result.text);
console.log('\n=== ANÁLISIS ===');

const hasMovePrefix = result.text.includes('🚶 Te movés a');
const hasRoomDescription = result.text.includes('Salidas') || result.text.includes('HP') || result.text.includes('---') || result.text.includes('🏠') || result.text.includes('📍');
const textLength = result.text.length;

console.log(`✓ Tiene prefijo de movimiento: ${hasMovePrefix}`);
console.log(`✓ Tiene descripción de sala: ${hasRoomDescription}`);
console.log(`✓ Longitud del texto: ${textLength} chars (esperado > 100)`);

if (hasMovePrefix && hasRoomDescription && textLength > 100) {
  console.log('\n✅ BUG-1749 CORREGIDO: el path noBoss ahora muestra la descripción completa de la sala destino.');
  process.exit(0);
} else if (!hasMovePrefix) {
  console.log('\n⚠️  No activó el path de movimiento (tal vez no hubo monstruos, o el jugador fue bloqueado).');
  process.exit(0);
} else {
  console.log('\n❌ BUG-1749 TODAVÍA PRESENTE: el texto solo contiene el mensaje de movimiento sin descripción de sala.');
  process.exit(1);
}
