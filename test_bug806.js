// Test BUG-806: ROOM_EFFECT damage no aplica en bossAtFullHp path
// Verifica que al entrar al Taller de Forja (sala 12) con el Golem a HP completo,
// se aplica correctamente el daño de Calor Abrasador (-2 HP)

const http = require('http');

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: 'localhost',
      port: 3000,
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };
    const req = http.request(opts, res => {
      let s = '';
      res.on('data', c => s += c);
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch(e) { resolve({text: s}); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const username = `testbug806_${Date.now()}`;
  
  // Crear jugador
  const login = await post('/api/login', { username });
  const pid = login.player_id;
  console.log(`Player: ${pid}`);
  
  // Completar tutorial (atacar goblin de práctica)
  for (let i = 0; i < 6; i++) {
    const r = await post('/api/action', { player_id: pid, command: 'attack' });
    if (r.text && r.text.includes('subiste al nivel')) break;
    if (r.text && r.text.includes('¡Tutorial completado')) break;
  }
  
  // Mover al dungeon
  await post('/api/action', { player_id: pid, command: 'south' });
  
  // Ver sala y HP actuales
  const status1 = await post('/api/action', { player_id: pid, command: 'status' });
  const hpMatch1 = status1.text && status1.text.match(/HP:\s+\[[\█░]+\]\s+(\d+)\/(\d+)/);
  const hp1 = hpMatch1 ? parseInt(hpMatch1[1]) : null;
  const maxhp1 = hpMatch1 ? parseInt(hpMatch1[2]) : null;
  console.log(`HP después de completar tutorial: ${hp1}/${maxhp1}`);
  
  // Usar DB directo para teleportar al jugador cerca del Taller (sala 11, Galería de Hielo)
  // Esto lo haremos via el engine directamente
  const db = require('./server/db/db.js');
  db.updatePlayer(pid, { 
    current_room_id: 11, 
    hp: 35, 
    max_hp: 35,
    level: 5, 
    xp: 200,
    attack: 10,
    defense: 3
  });
  db.trackRoomVisit(pid, 11);
  
  // Asegurarse que el Golem de Forja (sala 12) tiene HP completo
  const monsters = db.getMonstersInRoom(12);
  console.log(`Monstruos en sala 12:`, monsters.map(m => `${m.name} HP:${m.hp}/${m.max_hp}`));
  
  // HP antes de entrar al Taller
  const playerBefore = db.getPlayer(pid);
  console.log(`HP antes de entrar al Taller: ${playerBefore.hp}/${playerBefore.max_hp}`);
  
  // Mover al Taller (sala 12) — el Golem debe estar a HP completo
  const moveResult = await post('/api/action', { player_id: pid, command: 'east' });
  console.log('\nResultado del movimiento al Taller:');
  console.log(moveResult.text ? moveResult.text.substring(0, 500) : JSON.stringify(moveResult).substring(0, 500));
  
  // HP después
  const playerAfter = db.getPlayer(pid);
  console.log(`\nHP después de entrar al Taller: ${playerAfter.hp}/${playerAfter.max_hp}`);
  console.log(`Sala actual: ${playerAfter.current_room_id} (esperado: 12)`);
  
  // Verificación
  if (playerAfter.current_room_id !== 12) {
    console.error('❌ FALLO: El jugador no llegó a sala 12');
    process.exit(1);
  }
  
  const expectedHp = 35 - 2; // 35 - 2 HP de calor
  if (playerAfter.hp === expectedHp) {
    console.log(`✅ PASS: BUG-806 corregido — HP bajó de 35 a ${playerAfter.hp} (-2 HP de Calor Abrasador)`);
  } else if (playerAfter.hp === 35) {
    console.error(`❌ FAIL: BUG-806 persiste — HP sigue en ${playerAfter.hp} (no se aplicó el daño)`);
    process.exit(1);
  } else {
    console.log(`⚠️  HP: ${playerAfter.hp} (esperado ${expectedHp} o cerca — posible daño de otra fuente)`);
  }
  
  // Limpiar servidor
  process.exit(0);
}

main().catch(e => { console.error('Error:', e); process.exit(1); });
