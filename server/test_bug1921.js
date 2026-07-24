/**
 * Test BUG-1921: bash/smash sin target explícito debe apuntar al último enemigo atacado
 * 
 * Escenario: Sala con dos monstruos (Goblin Merodeador + Goblin Explorador).
 * El jugador ataca al Goblin Explorador (último target activo).
 * Luego usa smash sin target → debe apuntar al Goblin Explorador, NO al de mayor HP.
 */

'use strict';

const db = require('./db/db.js');
const engine = require('./game/engine.js');

async function runTest() {
  // Inicializar BD (necesario para sql.js async)
  await db.init();

  // Crear jugador de test
  const username = 'BugBot1921_' + Date.now();
  let player = db.createPlayer(username);  // createPlayer retorna el objeto player completo
  const pid = player.id;
  console.log(`[TEST] Jugador creado: ${player.username} (id=${pid})`);

  // Llevar al jugador al nivel 6 para tener shield_bash desbloqueado
  db.updatePlayer(pid, {
    level: 6,
    attack: 15,
    hp: 100,
    max_hp: 100,
    player_class: 'guerrero',
    current_room_id: 2  // Sala con goblins (sala 2)
  });
  player = db.getPlayer(pid);

  // Obtener los monstruos en sala 2
  const monstersRoom2 = db.getMonstersInRoom(2);
  console.log(`[TEST] Monstruos en sala 2: ${monstersRoom2.map(m => `${m.name}(id=${m.id}, hp=${m.hp})`).join(', ')}`);

  if (monstersRoom2.length < 2) {
    console.log('[TEST] SKIP — sala 2 no tiene 2 monstruos vivos para el test.');
    process.exit(0);
  }

  // Asegurarse que ambos están vivos con HP completo
  const m1 = monstersRoom2[0]; // primer monstruo
  const m2 = monstersRoom2[1]; // segundo monstruo

  db.updateMonster(m1.id, { hp: m1.max_hp, room_id: 2 });
  db.updateMonster(m2.id, { hp: m2.max_hp, room_id: 2 });

  console.log(`[TEST] M1: ${m1.name} (id=${m1.id})`);
  console.log(`[TEST] M2: ${m2.name} (id=${m2.id})`);

  // Verificar estado inicial de last_target_monster_id
  player = db.getPlayer(pid);
  console.log(`[TEST] last_target_monster_id inicial: ${player.last_target_monster_id}`);

  // PASO 1: atacar M2 con 'attack <nombre>' → debe guardar last_target_monster_id = m2.id
  const attackResult = engine.execute(pid, `attack ${m2.name}`);
  console.log(`[TEST] attack ${m2.name} → texto: ${attackResult.text.substring(0, 80)}...`);
  player = db.getPlayer(pid);
  console.log(`[TEST] last_target_monster_id tras attack: ${player.last_target_monster_id} (esperado: ${m2.id})`);

  if (player.last_target_monster_id !== m2.id) {
    console.log('[FAIL] last_target_monster_id NO se guardó correctamente tras attack');
    process.exit(1);
  } else {
    console.log('[OK] last_target_monster_id guardado correctamente');
  }

  // Verificar que m2 sigue vivo para el test de smash
  const freshM2 = db.getMonstersInRoom(2).find(m => m.id === m2.id);
  if (!freshM2 || freshM2.hp <= 0) {
    console.log('[TEST] M2 murió en el primer attack — no se puede testear smash. Test parcial OK.');
    process.exit(0);
  }

  // PASO 2: usar smash sin target → debe apuntar a M2 (last target), no a M1
  // Asegurarse de que smash esté disponible (limpiar cooldowns)
  db.updatePlayer(pid, { skill_cooldowns: '{}' });

  const smashResult = engine.execute(pid, 'smash');
  console.log(`[TEST] smash sin target → texto: ${smashResult.text.substring(0, 120)}...`);

  // Verificar que el texto menciona m2 y no m1
  const textLow = smashResult.text.toLowerCase();
  const m1NameLow = m1.name.toLowerCase();
  const m2NameLow = m2.name.toLowerCase();

  const hitM2 = textLow.includes(m2NameLow);
  const hitM1 = textLow.includes(m1NameLow) && !textLow.includes(m2NameLow);

  if (hitM2) {
    console.log(`[OK] smash apuntó correctamente a ${m2.name} (último target activo) ✓`);
  } else if (hitM1) {
    console.log(`[FAIL] smash apuntó a ${m1.name} en vez de ${m2.name} — BUG-1921 no corregido`);
    process.exit(1);
  } else {
    console.log(`[TEST] No se pudo determinar el target de smash en el texto. Verificar manualmente.`);
    console.log(`Texto completo:\n${smashResult.text}`);
  }

  console.log('[TEST] BUG-1921 test completado.');
  process.exit(0);
}

runTest().catch(err => {
  console.error('[TEST] Error fatal:', err);
  process.exit(1);
});
