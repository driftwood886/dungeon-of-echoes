'use strict';
const db = require('./server/db/db.js');
const engine = require('./server/game/engine.js');

async function run() {
  await db.init();
  
  const USERNAME = 'bot_bugtest';
  const existing = db.getPlayerByUsername(USERNAME);
  if (existing) db.deletePlayer(existing.id);
  const player = engine.getOrCreatePlayer(USERNAME);
  const pid = player.id;
  engine.execute(pid, 'clase guerrero');
  
  function cmd(command) {
    const r = engine.execute(pid, command, {});
    return r.text || '';
  }
  
  // Subir de nivel rápido mediante DB
  db.updatePlayer(pid, { 
    level: 4, xp: 450, hp: 50, max_hp: 50, attack: 12, defense: 4,
    gold: 200, current_room_id: 4 
  });
  
  console.log('=== PLAYTEST AMPLIO — NIVEL 4 ===\n');
  
  // ── ZONA 1: Cámara del Tesoro (sala 4) ──
  cmd('look');
  
  // TEST DIS-1501: Atacar al esqueleto ANTES de comprar
  console.log('\n=== TEST DIS-1501: Atacar esqueleto guardia de Aldric ===');
  // Primero, asegurarse que el esqueleto esté vivo (respawn)
  const monstersInRoom4 = db.getMonstersInRoom(4);
  console.log('Monstruos en sala 4:', monstersInRoom4.map(m => `${m.name}(hp:${m.hp})`).join(', '));
  
  // Si hay esqueleto, atacarlo directamente
  const esqueletoGuardia = monstersInRoom4.find(m => m.name.toLowerCase().includes('esqueleto'));
  if (esqueletoGuardia) {
    if (esqueletoGuardia.hp <= 0) {
      // Resuscitar para el test
      db.updateMonster(esqueletoGuardia.id, { hp: 20 });
    }
    // Necesitamos forzar que el jugador pueda atacar (fuera del modo "comprador" normal)
    // Tenemos que probar con nivel alto para que el mensaje cambie
    console.log('Esqueleto encontrado, ID:', esqueletoGuardia.id, 'HP:', esqueletoGuardia.hp);
    
    // El código de DIS-1406 bloquea el ataque en sala 4 cuando el jugador es "comprador"
    // El test real de DIS-1501 requiere que el monstruo sea atacable — verifiquemos el mecanismo
    // La reacción de Aldric está en el post-kill de combat, PERO el pre-attack bloquea en sala 4...
    // Eso parece un bug: DIS-1501 (reacción de Aldric) puede ser inalcanzable si DIS-1406 bloquea
    const atkResult = cmd('attack esqueleto');
    console.log('ATK al esqueleto:', atkResult.substring(0, 400));
    if (atkResult.includes('guardia personal') || atkResult.includes('Aldric')) {
      console.log('  → DIS-1406 bloquea el ataque en sala 4 (mensaje de protección)');
      console.log('  → DIS-1501 puede ser inalcanzable si siempre bloquea');
      console.log('  POSIBLE BUG: DIS-1501 nunca se ejecuta porque DIS-1406 siempre intercepta');
    }
  } else {
    console.log('Sin esqueleto guerrero en sala 4');
  }
  
  // ── ZONA 2: Exploración Norte de sala 4 (Prisión) ──
  console.log('\n=== EXPLORAR PRISIÓN SUBTERRÁNEA ===');
  db.updatePlayer(pid, { current_room_id: 8, hp: 50 });
  cmd('look');
  
  for (let i = 0; i < 6; i++) {
    const atk = cmd('attack');
    if (atk.includes('No hay monstruos') || atk.includes('no hay')) break;
  }
  cmd('pick todo');
  cmd('status');
  
  // ── ZONA 3: Túnel de Hongos (sala 6) — sin hongo azul ──
  console.log('\n=== TÚNEL DE HONGOS SIN PROTECCIÓN ===');
  db.updatePlayer(pid, { current_room_id: 5, hp: 50 });
  const hongosResult = cmd('north'); // intentar entrar al Túnel
  console.log('Intentar entrar al Túnel sin hongo:', hongosResult.substring(0, 300));
  
  // Ahora con hongo azul
  const invWithHongo = JSON.stringify(['hongo azul']);
  db.updatePlayer(pid, { inventory: invWithHongo });
  const hongosResult2 = cmd('north');
  console.log('Con hongo azul:', hongosResult2.substring(0, 200));
  
  // ── ZONA 4: Test edge cases de comandos ──
  console.log('\n=== EDGE CASES DE COMANDOS ===');
  db.updatePlayer(pid, { current_room_id: 3, hp: 50 });
  
  // Test: skip tutorial fuera del tutorial (DIS-1493 fix)
  const skipResult = cmd('skip tutorial');
  console.log('skip tutorial fuera del tutorial:', skipResult.substring(0, 200));
  if (skipResult.includes('desconocido')) {
    console.log('  ⚠️  BUG: skip tutorial sigue siendo "desconocido"');
  } else {
    console.log('  ✅ OK: skip tutorial tiene respuesta coherente');
  }
  
  // Test: smash sin monstruos en sala
  const smashEmpty = cmd('smash');
  console.log('\nsmash en sala sin monstruos:', smashEmpty.substring(0, 200));
  
  // Test: flee sin combate activo
  const fleeResult = cmd('flee');
  console.log('\nflee sin combate:', fleeResult.substring(0, 200));
  
  // Test: examine en sala sin objeto especial
  const examineResult = cmd('examine muro');
  console.log('\nexamine muro:', examineResult.substring(0, 200));
  
  // ── ZONA 5: Combate en Sala de los Ecos ──
  console.log('\n=== COMBATE EN SALA DE LOS ECOS (sala 3) ===');
  db.updatePlayer(pid, { current_room_id: 3, hp: 50 });
  const sala3 = db.getRoom(3);
  const monsters3 = db.getMonstersInRoom(3);
  console.log('Monstruos sala 3:', monsters3.map(m => `${m.name}(hp:${m.hp})`).join(', '));
  
  let kills = 0;
  for (let i = 0; i < 10; i++) {
    const atk = cmd('attack');
    if (atk.includes('cae derrotado')) kills++;
    if (atk.includes('No hay monstruos') || atk.includes('no hay monstruos')) break;
    if (atk.includes('morís') || atk.includes('caés al suelo')) {
      console.log('  ⚠️  JUGADOR MUERTO en sala 3!');
      db.updatePlayer(pid, { hp: 50 });
      break;
    }
  }
  console.log('Kills en sala 3:', kills);
  cmd('pick todo');
  cmd('inventory');
  
  // ── ZONA 6: Test de subasta ──
  console.log('\n=== HOUSE OF AUCTIONS (sala 17) ===');
  db.updatePlayer(pid, { current_room_id: 17, hp: 50, gold: 200 });
  const auctionLook = cmd('look');
  console.log('Subasta look:', auctionLook.substring(0, 400));
  
  const subastaCmd = cmd('subasta');
  console.log('subasta:', subastaCmd.substring(0, 300));
  
  // ── ZONA 7: Test de skills a nivel 4 ──
  console.log('\n=== SKILLS A NIVEL 4 ===');
  db.updatePlayer(pid, { current_room_id: 3, hp: 50 });
  const skillsResult = cmd('skills');
  console.log('Skills nivel 4:', skillsResult.substring(0, 400));
  
  // Intentar smash en combate
  cmd('attack'); // iniciar combate
  const smashResult = cmd('smash');
  console.log('\nsmash en combate:', smashResult.substring(0, 300));
  
  // Limpiar
  db.deletePlayer(pid);
  console.log('\n=== PLAYTEST DE BUGS COMPLETADO ===');
  process.exit(0);
}
run().catch(e => { console.error('ERROR:', e.message, '\n', e.stack); process.exit(1); });
