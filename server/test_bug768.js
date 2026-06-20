// test_bug768.js — Reproduce BUG-768: examine espada de obsidiana en sala 15 primera visita
const db = require('./db/db');
const engine = require('./game/engine');

// Obtener un player cualquiera y simularlo en sala 15 sin haberla visitado
const player = db.getPlayer('c5fb7491-2e39-49ef-9ced-8cd1d5e6fe37');
if (!player) {
  console.log('Player not found');
  process.exit(1);
}

console.log('Player current_room_id:', player.current_room_id);
console.log('Player rooms_visited:', JSON.stringify(player.rooms_visited).slice(0, 100));

// Simular sala 15 — primera visita (rooms_visited no tiene sala 15)
const fakePlayer = { ...player, current_room_id: 15 };

// Asegurarse que sala 15 no está en rooms_visited
if (Array.isArray(fakePlayer.rooms_visited) && !fakePlayer.rooms_visited.includes(15)) {
  console.log('Sala 15 no ha sido visitada — simulando primera visita');
} else {
  console.log('AVISO: sala 15 ya en rooms_visited, el test puede no reproducir el bug');
}

// Probar cmdExamine con query 'espada de obsidiana'
const result = engine.execute(fakePlayer, { command: 'examine', args: ['espada', 'de', 'obsidiana'] }, {});
console.log('\nResult text:', result && result.text ? result.text.slice(0, 500) : 'null/undefined');
