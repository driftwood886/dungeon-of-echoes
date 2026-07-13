'use strict';
/**
 * test_bug1547.js — Verificar que la Maldición del Lich drena HP al moverse.
 * Uso: node test_bug1547.js
 */
const worldEvents = require('./server/game/worldEvents');
const db = require('./server/db/db');
const engine = require('./server/game/engine');
const commands = require('./server/game/commands');

// Monkey-patch getCurrentEvent para simular evento 'curse' activo
const origGetCurrentEvent = worldEvents.getCurrentEvent;
worldEvents.getCurrentEvent = function () {
  return {
    id: 'curse',
    name: '💀 Maldición del Lich',
    description: 'El Lich Anciano maldice el dungeon. Cada cambio de sala drena 1 HP.',
    startedAt: Date.now(),
    endsAt: Date.now() + 300000,
    remainingMs: 300000,
  };
};

// Usar el jugador de test existente
const PID = '56498917-d3c2-4700-84bd-a09427412579';
let player = db.getPlayer(PID);
if (!player) {
  console.error('❌ Jugador de test no encontrado. Logearte primero.');
  process.exit(1);
}

// Asegurarse de que está en sala 1 (Entrada de la Cripta) — tiene salida al norte
if (player.current_room_id !== 1) {
  db.updatePlayer(PID, { current_room_id: 1, hp: 30 });
  player = db.getPlayer(PID);
}
// Setear HP fijo para el test
db.updatePlayer(PID, { hp: 20 });
player = db.getPlayer(PID);

console.log('=== TEST BUG-1547: Maldición del Lich ===');
console.log('Sala actual:', player.current_room_id, '| HP antes del move:', player.hp, '/', player.max_hp);
console.log('(Evento forzado: curse activo)');

// Parsear y ejecutar move norte
const parsed = commands.parseCommand('norte');
const result = engine.processAction(player, parsed);

console.log('\n--- Respuesta del move ---');
console.log(result.text ? result.text.substring(0, 600) : JSON.stringify(result));

// Ver HP después
const after = db.getPlayer(PID);
console.log('\n--- Resultado ---');
console.log('HP después del move:', after.hp, '/', after.max_hp);
const drained = player.hp - after.hp;
console.log('HP drenado:', drained, '(esperado: 1)');

if (drained === 1) {
  console.log('\n✅ BUG-1547 RESUELTO — La maldición drena 1 HP al moverse correctamente.');
} else if (drained > 1) {
  console.log('\n⚠️  HP drenado más de 1 — puede haber doble aplicación. Revisar.');
} else {
  console.log('\n❌ BUG-1547 NO resuelto — el drain no se aplicó.');
}

// Restaurar función original
worldEvents.getCurrentEvent = origGetCurrentEvent;
process.exit(0);
