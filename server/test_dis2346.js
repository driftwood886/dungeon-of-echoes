/**
 * Test DIS-2346 — Hint de curación contextual en inventario
 */
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
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { resolve({result: body}); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
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
    req.write(data);
    req.end();
  });
}

async function run() {
  const username = 'testDIS2346_' + Date.now();
  const loginRes = await login(username, 'guerrero');
  const pid = loginRes.player_id;
  console.log('Player ID:', pid, 'Username:', username);

  // Preparar el jugador directamente en DB
  const p = db.getPlayer(pid);
  const maxHp = p.max_hp || 35;
  p.hp = Math.floor(maxHp * 0.7); // 70% HP (perdería al usar poción de 15)
  p.tutorial_done = 1;
  p.current_room_id = 1;
  const inv = Array.isArray(p.inventory) ? [...p.inventory] : [];
  inv.push('poción de salud');   // cura 15 HP
  inv.push('poción menor');      // cura 8 HP  
  inv.push('poción de vida');    // cura 30 HP
  p.inventory = inv;
  db.updatePlayer(p);
  
  const updated = db.getPlayer(pid);
  const missing = updated.max_hp - updated.hp;
  console.log(`HP: ${updated.hp}/${updated.max_hp} (missing: ${missing})`);
  console.log('Inventario:', updated.inventory);
  console.log('');
  console.log('=== Esperando que DIS-2346 muestre:');
  console.log('  - poción de salud (15 HP): "curarías', missing < 15 ? missing : 15, 'ahora"');
  console.log('  - poción menor (8 HP): "curarías', missing < 8 ? missing : 8, 'ahora" si missing < 8');
  console.log('  - poción de vida (30 HP): "curarías', missing < 30 ? missing : 30, 'ahora" si missing < 30');
  console.log('');

  const result = await postCmd(pid, 'inventario');
  console.log('=== RESULTADO INVENTARIO ===');
  console.log(result.result);

  // Verificar que aparece el hint para las pociones
  const text = result.result || '';
  if (text.includes('curarías') && text.includes('ahora')) {
    console.log('\n✅ PASS — DIS-2346: hint de curación contextual visible en inventario');
  } else {
    console.log('\n❌ FAIL — DIS-2346: hint no encontrado en la salida del inventario');
    console.log('Buscar "curarías" en:', text.substring(0, 500));
  }
}

run().catch(e => { console.error('Error:', e); process.exit(1); }).finally(() => process.exit(0));
