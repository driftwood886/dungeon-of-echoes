/**
 * Test DIS-1911: modo_berserk debe atacar en el mismo turno de activación.
 *
 * Antes del fix: modo_berserk activaba el estado pero no atacaba → turno perdido.
 * Después del fix: modo_berserk activa el estado Y ejecuta un ataque con +5 ATK en el mismo turno.
 */

const db = require('./db/db');
const engine = require('./game/engine');

async function main() {
  await db.init();

  // Crear jugador bot de test
  let player = db.getPlayerByUsername('bot_dis1911_test');
  if (!player) {
    player = db.createPlayer('bot_dis1911_test');
    db.updatePlayer(player.id, { is_bot: 1 });
  }

  // Configurar: Guerrero nivel 5, berserker, en sala 3 (Sala de los Ecos, donde hay Gnoll)
  db.updatePlayer(player.id, {
    current_room_id: 3, // Sala de los Ecos
    hp: 80,
    max_hp: 80,
    attack: 8,
    defense: 4,
    level: 5,
    xp: 200,
    player_class: 'guerrero',
    specialization: 'berserker',
    status_effects: '{"berserk_warned":true}', // ya pasó el primer warning
    skill_cooldowns: '{}',
  });
  player = db.getPlayer(player.id);

  console.log('=== Test DIS-1911: modo_berserk + ataque simultáneo ===');
  console.log('Player level:', player.level, '| Spec:', player.specialization);

  // Ver monstruos en sala
  const monsters = db.getMonstersInRoom(3).filter(m => m.hp > 0);
  console.log('Monstruos en sala 3:', monsters.map(m => `${m.name} (${m.hp}HP)`));

  if (monsters.length === 0) {
    console.log('❌ No hay monstruos en sala 3 — test no puede ejecutarse');
    process.exit(1);
  }

  const firstMonster = monsters[0];
  const hpBefore = firstMonster.hp;
  console.log(`HP del ${firstMonster.name} antes: ${hpBefore}`);

  // Ejecutar modo_berserk
  const result = engine.execute(player.id, 'modo_berserk', {});
  console.log('\n--- Resultado de modo_berserk ---');
  console.log(result.text);

  // Verificar que el texto incluye activación Y ataque
  const includesActivation = result.text.includes('MODO BERSERK ACTIVADO');
  const includesAttack = result.text.includes('de daño') || result.text.includes('HP)') 
    || result.text.includes('ataca') || result.text.includes('⚔') || result.text.includes('golpe');

  console.log('\n=== VERIFICACIONES ===');
  console.log(`✅ Texto incluye "MODO BERSERK ACTIVADO": ${includesActivation}`);
  console.log(`✅ Texto incluye resultado de ataque: ${includesAttack}`);

  // Verificar HP del monstruo
  const monstersAfter = db.getMonstersInRoom(3).filter(m => m.id === firstMonster.id);
  const hpAfter = monstersAfter.length > 0 ? monstersAfter[0].hp : 0;
  const damageDealt = hpBefore - hpAfter;
  console.log(`✅ Daño infligido: ${damageDealt} (HP: ${hpBefore} → ${monstersAfter.length === 0 ? 'muerto' : hpAfter})`);

  // Verificar estado berserk en DB
  const playerAfter = db.getPlayer(player.id);
  let seFinal = {};
  try {
    const seRaw = playerAfter.status_effects;
    seFinal = typeof seRaw === 'string' ? JSON.parse(seRaw) : (seRaw || {});
  } catch(_) { seFinal = {}; }
  const berserkActive = seFinal.modo_berserk_activo;
  console.log(`✅ Berserk activo post-uso: ${JSON.stringify(berserkActive)}`);

  if (berserkActive && berserkActive.turns_remaining === 2) {
    console.log('✅ turns_remaining = 2 (correcto — 1 turno ya usado en activación)');
  } else if (berserkActive && berserkActive.turns_remaining === 3) {
    console.log('❌ turns_remaining = 3 (incorrecto — no se consumió el turno de activación)');
  } else if (!berserkActive) {
    console.log('⚠️  Berserk terminó (posible si el monstruo murió rápido — ok si damageDealt > 0)');
  }

  if (includesActivation && includesAttack && damageDealt > 0) {
    console.log('\n✅✅ TEST PASADO: modo_berserk activa Y ataca en el mismo turno.');
  } else {
    console.log('\n❌ TEST FALLIDO');
    process.exit(1);
  }

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
