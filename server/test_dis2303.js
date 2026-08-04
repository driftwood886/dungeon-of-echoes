/**
 * test_dis2303.js — Verificar DIS-2303: limpieza de berserk al matar
 *
 * DIS-2303: El estado modo_berserk_activo y berserk_agotamiento deben
 * limpiarse cuando el jugador mata un monstruo (no persisten entre combates).
 */
'use strict';

const db = require('./db/db.js');
const engine = require('./game/engine.js');

async function main() {
  await db.init();

  // Crear jugador berserker nivel 6 usando createPlayer
  const username = 'test_dis2303_' + Date.now();
  let player = db.createPlayer(username);
  
  // Configurar como berserker nivel 6 con berserk activo
  const seInit = JSON.stringify({ modo_berserk_activo: { turns_remaining: 2, activated_at: Date.now() } });
  db.updatePlayer(player.id, {
    level: 6,
    hp: 40,
    max_hp: 40,
    attack: 8,
    defense: 3,
    current_room_id: 2,
    player_class: 'guerrero',
    specialization: 'berserker',
    xp: 500,
    gold: 50,
    status_effects: seInit,
  });

  player = db.getPlayer(player.id);
  console.log('== Test DIS-2303: Limpieza de berserk al matar monstruo ==\n');
  console.log(`Jugador creado: ${username} (id=${player.id})`);
  
  // Estado inicial
  const preSE = player.status_effects || {}; // getPlayer ya parsea status_effects
  console.log('Estado berserk ANTES del ataque:');
  console.log(' modo_berserk_activo:', preSE.modo_berserk_activo);
  console.log(' berserk_agotamiento:', preSE.berserk_agotamiento);

  // Poner un monstruo en sala 2 con 1 HP
  let monsters = db.getMonstersInRoom(2).filter(m => m.hp > 0);
  if (monsters.length === 0) {
    monsters = db.getMonstersInRoom(1).filter(m => m.hp > 0);
    if (monsters.length === 0) {
      console.log('SKIP: No hay monstruos disponibles.');
      db.deletePlayer(player.id);
      return;
    }
    db.updatePlayer(player.id, { current_room_id: 1 });
    player = db.getPlayer(player.id);
  }
  
  const monster = monsters[0];
  const origHp = monster.hp;
  db.updateMonster(monster.id, { hp: 1 });
  console.log(`\nMonstruo: ${monster.name} (id=${monster.id}) → HP reducido a 1`);
  
  // Simular ataque usando execute
  const context = {
    io: { to: () => ({ emit: () => {} }), emit: () => {} },
    broadcastToRoom: () => {},
    broadcastToAll: () => {},
    broadcastGlobal: () => {},
  };
  
  player = db.getPlayer(player.id);
  const attackResult = engine.execute(player.id, 'atacar', context);
  
  if (attackResult) {
    const preview = (attackResult.text || '').substring(0, 400);
    console.log('\nResultado del ataque:');
    console.log(preview);
  }
  
  // Verificar estado post-kill
  const postPlayer = db.getPlayer(player.id);
  const postSE = postPlayer.status_effects || {}; // getPlayer ya parsea status_effects
  console.log('\nEstado berserk DESPUÉS del ataque:');
  console.log(' modo_berserk_activo:', postSE.modo_berserk_activo);
  console.log(' berserk_agotamiento:', postSE.berserk_agotamiento);
  
  // Verificar si el monstruo murió
  const freshMonsters = db.getMonstersInRoom(player.current_room_id).filter(m => m.id === monster.id);
  const monsterHp = freshMonsters.length > 0 ? freshMonsters[0].hp : 0;
  console.log('\nHP del monstruo después:', monsterHp, monsterHp <= 0 ? '(murió ✅)' : '(sigue vivo)');
  
  if (monsterHp <= 0) {
    const berserkCleared = !postSE.modo_berserk_activo;
    const agotamientoCleared = !postSE.berserk_agotamiento;
    
    if (berserkCleared && agotamientoCleared) {
      console.log('\n✅ DIS-2303 PASA: Estado berserk limpiado correctamente al matar.');
    } else {
      console.log('\n❌ DIS-2303 FALLA:');
      if (!berserkCleared) console.log('  modo_berserk_activo aún presente después del kill');
      if (!agotamientoCleared) console.log('  berserk_agotamiento aún presente después del kill');
      try { db.updateMonster(monster.id, { hp: origHp }); } catch (_) {}
      db.deletePlayer(player.id);
      process.exit(1);
    }
  } else {
    console.log('\n⚠️ Monstruo sobrevivió al ataque (daño insuficiente para HP=1).');
    console.log('Verificar manualmente en juego.');
  }
  
  // Restore
  try { db.updateMonster(monster.id, { hp: origHp }); } catch (_) {}
  db.deletePlayer(player.id);
  console.log('\nTest completado. Jugador de prueba eliminado.');
}

main().catch(e => { console.error(e); process.exit(1); });
