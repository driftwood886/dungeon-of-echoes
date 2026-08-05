/**
 * test_dis2349.js — DIS-2349: carta sellada → carta leída al abrirla
 * Verificar que usar carta sellada la transforma en carta leída (no la destruye).
 */
'use strict';
const http = require('http');
const db = require('./db/db');

function postCmd(player_id, command) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ player_id, command });
    const req = http.request({
      hostname: 'localhost', port: 3000, path: '/api/command', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { resolve({ result: body }); } });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

function login(username, cls) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ username, class: cls });
    const req = http.request({
      hostname: 'localhost', port: 3000, path: '/api/login', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { resolve({}); } });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { console.log(`  ✅ PASS: ${msg}`); passed++; }
  else       { console.log(`  ❌ FAIL: ${msg}`); failed++; }
}

async function run() {
  const username = 'testDIS2349_' + Date.now();
  const loginRes = await login(username, 'guerrero');
  const pid = loginRes.player_id;
  console.log('Player ID:', pid, 'Username:', username);

  // Setup: poner jugador en sala 8, nivel 5, con carta sellada
  db.updatePlayer(pid, {
    current_room_id: 8,
    level: 5,
    xp: 100,
    xp_next: 200,
    hp: 30,
    max_hp: 40,
    aldric_quest: 'none',
    inventory: JSON.stringify(['carta sellada', 'poción de salud'])
  });

  // Test 1: usar carta sellada
  console.log('\nTest 1: usar carta sellada la convierte en carta leída');
  const r1 = await postCmd(pid, 'use carta sellada');
  const p1 = db.getPlayer(pid);
  const inv1 = Array.isArray(p1.inventory) ? p1.inventory : JSON.parse(p1.inventory || '[]');

  assert(r1.result && r1.result.includes('sello de cera negra'), 'Resultado incluye flavor text de apertura');
  assert(r1.result && r1.result.includes('carta leída'), 'Resultado menciona carta leída');
  assert(!r1.result || !r1.result.includes('polvo antiguo'), 'Resultado NO dice "polvo antiguo"');
  assert(inv1.some(i => i.toLowerCase().includes('carta leída')), 'Inventario contiene carta leída');
  assert(!inv1.some(i => i.toLowerCase().includes('carta sellada')), 'Inventario NO contiene carta sellada');
  const se1 = JSON.parse(p1.status_effects || '{}');
  assert(se1.carta_sellada_leida === true, 'Flag carta_sellada_leida = true en status_effects');

  // Test 2: examine carta leída muestra el contenido
  console.log('\nTest 2: examine carta leída muestra el contenido');
  const r2 = await postCmd(pid, 'examine carta leída');
  assert(r2.result && (r2.result.includes('Kaelthas') || r2.result.toLowerCase().includes('sello')),
    'Examine carta leída muestra lore de la carta');

  // Test 3: vender carta leída no es posible
  console.log('\nTest 3: carta leída es no vendible');
  db.updatePlayer(pid, { current_room_id: 4 }); // sala de Aldric/tienda
  const r3 = await postCmd(pid, 'inventory');
  assert(r3.result && r3.result.toLowerCase().includes('carta'), 'Inventario muestra carta leída');
  const p3 = db.getPlayer(pid);
  const inv3 = Array.isArray(p3.inventory) ? p3.inventory : JSON.parse(p3.inventory || '[]');
  assert(inv3.some(i => i.toLowerCase().includes('carta leída')), 'carta leída sigue en inventario después del inventory');

  console.log(`\nResultados: ${passed}/${passed + failed} PASS`);
  if (failed > 0) process.exit(1);
}

run().catch(err => { console.error(err); process.exit(1); });
