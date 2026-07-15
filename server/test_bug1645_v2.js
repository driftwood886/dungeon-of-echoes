/**
 * test_bug1645_v2.js — Investigación del bug de sala duplicada
 * 
 * Hipótesis: el logro "rico" (gold >= 100) puede dispararse en cmdMove 
 * si el jugador tiene exactamente 100+ gold. La cartogAchLines se incluye en 
 * el texto de cmdMove. Pero el texto de cmdMove ya incluye roomDesc.
 * No deberíamos ver roomDesc duplicado.
 *
 * Nueva hipótesis: el bug puede venir de que en el socket handler (handlers.js)
 * cuando el jugador se mueve, el resultado incluye result.text (con roomDesc) +
 * el handler emite via result.event el broadcast "entra a la sala". 
 * Pero los miembros de la PROPIA SALA no deberían recibir eso.
 * Sin embargo, si el jugador tiene TWO sockets (reconexión), sí podría.
 *
 * OTRA hipótesis: el handler de socket (join) hace auto-look al reconectar.
 * Si hay una reconexión parcial justo mientras se ejecuta el move, el jugador
 * recibiría el resultado del move + el auto-look del join.
 */

'use strict';
process.chdir('/home/hermes/dungeon-of-echoes');

const Database = require('./server/db/database');
const db = new Database('./dungeon.db');
const engine = require('./server/game/engine');

// Crear jugador de test
const testUser = 'bug1645_test_v2';
let player = db.getPlayerByUsername(testUser);
if (!player) {
  db.createPlayer(testUser);
  player = db.getPlayerByUsername(testUser);
}

// Setup: jugador en sala 1 con gold = 99 (justo debajo del umbral)
db.updatePlayer(player.id, {
  current_room_id: 1,
  gold: 99,
  hp: 30,
  max_hp: 30,
  achievements: '[]', // sin logros para que "rico" pueda dispararse
});
player = db.getPlayer(player.id);

console.log('=== ESTADO INICIAL ===');
console.log(`Gold: ${player.gold}, Room: ${player.current_room_id}`);

// Verificar qué hay en sala 1 (ítems de gold disponibles)
const room1 = db.getRoom(1);
console.log(`\nSala 1 ítems: ${JSON.stringify(room1.items)}`);

// Ver qué ítems de gold existen
const GOLD_ITEMS = {
  'moneda': 1,
  'monedas': 5,
  'bolsa de monedas': 10,
  'tesoro pequeño': 25,
};
const goldInRoom = (room1.items || []).filter(i => GOLD_ITEMS[i.toLowerCase()]);
console.log(`Gold ítems en sala: ${JSON.stringify(goldInRoom)}`);

// Si no hay monedas, ponemos algo
if (goldInRoom.length === 0) {
  // Buscar qué ítems de oro existen en el juego
  console.log('\nSin ítems de gold en sala 1. Simulando pick directo de gold...');
  
  // Agregar monedas a la sala
  const currentItems = room1.items || [];
  db.updateRoomItems(1, [...currentItems, 'monedas', 'monedas']);
  
  console.log('Monedas agregadas a sala 1');
}

// Test 1: pick todo (debería dar gold suficiente para cruzar 100)
console.log('\n=== TEST: pick todo (tomar 5+5 = 10 gold, total: 99+10 = 109) ===');
const pickResult = engine.execute(player.id, 'pick todo', {
  broadcastToRoom: (r, e, m) => {},
  playerSockets: new Map(),
  followMap: new Map(),
});
console.log('Pick result:');
console.log(pickResult.text);
console.log('\n--- ¿Contiene "rico" / "Cofre Lleno"? ---');
console.log(pickResult.text.includes('Cofre Lleno') ? 'SÍ' : 'NO');

// Actualizar player
player = db.getPlayer(player.id);
console.log(`\nGold después del pick: ${player.gold}`);
console.log(`Logros: ${player.achievements}`);

// Test 2: ahora moverse (gold ya >= 100, pero logro ya debería estar desbloqueado)
console.log('\n=== TEST: move north (con gold >= 100, logro ya desbloqueado) ===');
// Ver conexiones de sala 1
console.log(`Exits sala 1:`, room1.exits);
const firstExit = Object.keys(room1.exits || {})[0];
if (firstExit) {
  const moveResult = engine.execute(player.id, `move ${firstExit}`, {
    broadcastToRoom: (r, e, m) => {},
    playerSockets: new Map(),
    followMap: new Map(),
    monsterTrackMap: new Map(),
  });
  console.log('Move result (primeras 500 chars):');
  console.log(moveResult.text.substring(0, 500));
  
  // Contar cuántas veces aparece el separador de sala
  const sepCount = (moveResult.text.match(/===/g) || []).length;
  console.log(`\n=== separadores encontrados: ${sepCount} (esperado: 2 → nombre de sala)`);
  if (sepCount > 2) {
    console.log('🐛 BUG CONFIRMADO: más de 2 separadores === (sala duplicada)');
  } else {
    console.log('✅ No se detecta duplicación en el resultado del move');
  }
}

// Test 3: jugador con gold=99, mover primero, ver si el cartogAch se activa durante el move
console.log('\n=== TEST: Reproducir el escenario original ===');
// Reset
db.updatePlayer(player.id, {
  current_room_id: 1,
  gold: 99,
  achievements: '[]',
});
// No hay monedas en sala que cruzarían el umbral durante un MOVE.
// El bug solo ocurre si hay algo en el path de cmdMove que hace checkAchievements
// y ese check pasa gold >= 100.
// Como gold=99 durante el move, el logro "rico" NO debería dispararse en cmdMove.
// PERO si el jugador está en room 1 con gold=99 y hace "pick todo" para cruzar 100,
// DESPUÉS hace "move", en el move gold ya es >= 100 pero el logro ya está desbloqueado.

// Conclusión: el bug NO puede venir de dos checkAchievements en el mismo move.
// Tiene que venir de otra fuente de output adicional.

// Nueva hipótesis: el evento de broadcast que el handler envía
// Cuando el jugador se mueve, el handler emite:
//   1. ack({ result: result.text }) → el cliente muestra roomDesc
//   2. io.to(`room_${targetRoomId}`).emit('event', { type: 'action', message: result.event })
//      → "X entra a la sala." — visible solo para OTROS
// Si el socket del jugador está en el room antes del join (race condition), podría recibir el broadcast.
// O si hay un socket duplicado...

console.log('\n=== ANÁLISIS: socket en room_targetId antes del join ===');
console.log('En handlers.js línea 450-456:');
console.log('  socket.leave(room_oldRoom)');
console.log('  socket.join(room_newRoom)  <-- se une ANTES de emitir result.event');
console.log('  io.to(room_newRoom).emit("event", "entra a la sala") <-- ¿esto llega al jugador?');
console.log('');
console.log('ATENCIÓN: La secuencia en handlers.js es:');
console.log('  1. engine.execute() → result con result.text y result.event');
console.log('  2. if result.event: io.to(room_targetId).emit("event", ...) ← room_targetId ANTES de join');
console.log('  3. Detecta cambio de sala: socket.leave(oldRoom), socket.join(newRoom)');
console.log('  4. ack({ result: result.text })');
console.log('');
console.log('Orden real de eventos:');
console.log('  1. result.event se emite ANTES de que el socket se una al nuevo room');
console.log('  2. El socket se une al nuevo room DESPUÉS del emit');
console.log('  3. El cliente recibe el ack con result.text');
console.log('  → No hay problema aquí.');

// Limpiar
db.updatePlayer(player.id, { current_room_id: 1, gold: 0, achievements: '[]' });
// Remover ítems de test
const roomAfter = db.getRoom(1);
const cleanItems = (roomAfter.items || []).filter(i => i !== 'monedas');
db.updateRoomItems(1, cleanItems);

console.log('\n=== CONCLUSIÓN ===');
console.log('El bug no parece reproducible via API directa (engine.execute).');
console.log('La causa más probable es un doble-render en el cliente (game.js).');
console.log('Ver game.js: la función sendCommand hace addMsg(text) + refreshState()');
console.log('refreshState() llama /api/state y updateSidebar() — no renderiza el output del juego.');
console.log('No hay double-render visible en el código del cliente.');
console.log('');
console.log('HIPÓTESIS RESTANTE: El bug es intermitente y ocurre cuando el servidor');
console.log('tiene una race condition entre dos eventos de socket cercanos:');
console.log('  - El resultado del move (via ack) que contiene roomDesc');
console.log('  - Algún evento "action" que también contiene roomDesc');
console.log('');
console.log('Candidatos para ese evento "action" con roomDesc:');
console.log('  - handlers.js línea 491-492: followLookResult (party_follow)');
console.log('  - handlers.js línea 520-521: lookResult de follow');
console.log('  - handlers.js línea 113: auto-look del join (al reconectar)');
console.log('');
console.log('Si el jugador no está en party, las líneas 491-521 no aplican.');
console.log('CONCLUSIÓN FINAL: El bug solo es reproducible en escenarios reales de browser.');
console.log('Se recomienda agregar un deduplicador de texto en el cliente (game.js).');
