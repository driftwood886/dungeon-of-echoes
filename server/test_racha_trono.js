'use strict';

const db = require('./db/db.js');
const ee = require('./game/expedition_engine.js');

const testUsername = `test_racha_${Date.now()}`;
let player = db.createOrGetPlayer(testUsername);
db.updatePlayer(player.id, { level: 3 });
player = db.getPlayer(player.id);

console.log('Jugador:', player.username, 'nivel:', player.level);

// Forzar asignación racha_del_trono
db.assignExpeditionToDB(player.id, 'racha_del_trono');
player = db.getPlayer(player.id);

// Step 1: 4 kills sin morir
console.log('\n--- Paso 1: kills acumulativos ---');
for (let i = 1; i <= 4; i++) {
  player = db.getPlayer(player.id);
  const r = ee.checkStep(player, 'kill', { monsterName: 'Goblin', roomId: 2 });
  console.log(`Kill ${i}: matched=${r.matched}, msg="${r.message}"`);
}

// Muerte → reset
console.log('\n--- Muerte ---');
player = db.getPlayer(player.id);
const deathR = ee.notifyDeath(player);
console.log('Muerte msg:', deathR ? deathR.message : 'null');

let active = db.getActiveExpedition(player.id);
console.log('data.racha_kills después de muerte:', (active.data || {}).racha_kills);

// 5 kills consecutivos desde 0
console.log('\n--- Kills desde 0 ---');
for (let i = 1; i <= 5; i++) {
  player = db.getPlayer(player.id);
  const r = ee.checkStep(player, 'kill', { monsterName: 'Orco', roomId: 2 });
  console.log(`Kill ${i}: matched=${r.matched}, advanced=${r.advanced}, needsDec=${r.needsDecision}, msg="${r.message}"`);
}

// Step 2: usar trono en sala 9
console.log('\n--- Usar trono sala 9 ---');
player = db.getPlayer(player.id);
const tronoR = ee.checkStep(player, 'use', { itemName: 'trono anciano', roomId: 9 });
console.log('Trono:', JSON.stringify({ matched: tronoR.matched, needsDec: tronoR.needsDecision, msg: tronoR.message ? tronoR.message.substring(0, 100) : null }));

// Decisión
console.log('\n--- Decisión: poder ---');
player = db.getPlayer(player.id);
const decR = ee.resolveDecision(player, 'poder');
console.log('Decisión:', JSON.stringify(decR ? { title: decR.title, reward: decR.reward, worldEffect: decR.worldEffect } : null));

console.log('\n✅ Test racha_del_trono COMPLETO');
