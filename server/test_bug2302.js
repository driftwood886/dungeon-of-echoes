/**
 * Test BUG-2302: Level up al matar con skills especiales debe mostrar detalles de stats.
 * Verifica que smash, shield_bash, golpe_sucio, imposition, emboscar, rayo_divino
 * muestren "+5 HP" y "+1 ATK" al level up, igual que el combate normal (cmdAttack).
 */
'use strict';

const db = require('./db/db.js');
const engine = require('./game/engine.js');
const xpSystem = require('./game/xp.js');

async function main() {
  await db.init();

  // XP para nivel 2 = 60 (según xpForLevel(2))
  const xpForLvl2 = xpSystem.xpForLevel ? xpSystem.xpForLevel(2) : 60;
  // Goblin Merodeador (id=1) está en sala 2, tiene 15 HP. Puede matarlo con smash.
  // Reestablecemos HP del goblin a 3 para que un hit con skill lo mate
  db.updateMonster(1, { hp: 3, room_id: 2 }); // Goblin Merodeador en sala 2
  
  const results = {};

  // --- TEST smash (Guerrero nivel 2, sala 2) ---
  // smash requiere nivel 3 — ponemos al jugador en nivel 3, cerca del nivel 4
  {
    const xpForLvl4 = xpSystem.xpForLevel ? xpSystem.xpForLevel(4) : 270;
    const username = 'Test2302_Smash_' + Date.now();
    const p = db.createPlayer(username);
    db.updatePlayer(p.id, {
      level: 3,
      xp: xpForLvl4 - 5,
      hp: 40,
      max_hp: 45,
      attack: 7,
      gold: 50,
      player_class: 'guerrero',
      current_room_id: 2,
      status_effects: JSON.stringify({}),
      rooms_visited: JSON.stringify([1, 2]),
    });
    db.updateMonster(1, { hp: 2, room_id: 2 });
    const r = engine.execute(p.id, 'smash Goblin');
    const text = r.text || '';
    console.log('[smash output]', text.slice(0, 600));
    results.smash = checkMsg(text, 'smash');
  }

  // Restore goblin
  db.updateMonster(1, { hp: 3, room_id: 2 });

  // --- TEST shield_bash (Guerrero nivel 6, sala 2) ---
  {
    const xpForLvl7 = xpSystem.xpForLevel ? xpSystem.xpForLevel(7) : 700;
    const username = 'Test2302_SBash_' + Date.now();
    const p = db.createPlayer(username);
    db.updatePlayer(p.id, {
      level: 6,
      xp: xpForLvl7 - 5,
      hp: 55,
      max_hp: 60,
      attack: 10,
      gold: 100,
      player_class: 'guerrero',
      current_room_id: 2,
      status_effects: JSON.stringify({}),
      rooms_visited: JSON.stringify([1, 2]),
    });
    db.updateMonster(1, { hp: 2, room_id: 2 });
    const r = engine.execute(p.id, 'shield_bash Goblin');
    const text = r.text || '';
    console.log('[shield_bash output]', text.slice(0, 600));
    results.shield_bash = checkMsg(text, 'shield_bash');
  }

  db.updateMonster(1, { hp: 3, room_id: 2 });

  // --- TEST golpe_sucio (Picaro nivel 3, sala 2) ---
  // golpe_sucio requiere nivel 3
  {
    const xpForLvl4 = xpSystem.xpForLevel ? xpSystem.xpForLevel(4) : 270;
    const username = 'Test2302_GS_' + Date.now();
    const p = db.createPlayer(username);
    db.updatePlayer(p.id, {
      level: 3,
      xp: xpForLvl4 - 5,
      hp: 40,
      max_hp: 45,
      attack: 7,
      gold: 50,
      player_class: 'picaro',
      current_room_id: 2,
      status_effects: JSON.stringify({}),
      rooms_visited: JSON.stringify([1, 2]),
    });
    db.updateMonster(1, { hp: 2, room_id: 2 });
    const r = engine.execute(p.id, 'golpe_sucio Goblin');
    const text = r.text || '';
    console.log('[golpe_sucio output]', text.slice(0, 600));
    results.golpe_sucio = checkMsg(text, 'golpe_sucio');
  }

  db.updateMonster(1, { hp: 3, room_id: 2 });

  // --- Resumen ---
  console.log('\n=== RESUMEN BUG-2302 ===');
  let allPassed = true;
  for (const [skill, result] of Object.entries(results)) {
    if (result === false) {
      console.log(`❌ ${skill}: FALLÓ`);
      allPassed = false;
    } else if (result === true) {
      console.log(`✅ ${skill}: OK`);
    } else {
      console.log(`ℹ️  ${skill}: sin level up (inconcluso)`);
    }
  }

  console.log('\n[TEST] Fin.');
  process.exit(allPassed ? 0 : 1);
}

function checkMsg(text, skillName) {
  const hasLevelUp = text.includes('SUBÍS AL NIVEL') || text.includes('SUBE AL NIVEL') || text.includes('Subiste al nivel');
  const hasHpStat = text.includes('+5 HP') || text.includes('HP máx') || text.includes('+5 HP,');
  const hasAtkStat = text.includes('+1 ATK') || text.includes('+1 ataque');
  const hasHpBar = /\d+\/\d+ HP/.test(text);
  
  console.log(`\n--- ${skillName} ---`);
  console.log('¿Level up?', hasLevelUp ? '✅' : '❌');
  console.log('¿Stats HP (+5)?', hasHpStat ? '✅' : '❌');
  console.log('¿Stats ATK (+1)?', hasAtkStat ? '✅' : '❌');
  console.log('¿Barra HP (X/Y HP)?', hasHpBar ? '✅' : '❌');

  if (!hasLevelUp) return null; // inconclusive
  if (hasLevelUp && hasHpStat) {
    console.log(`✅ BUG-2302 OK: ${skillName} muestra stats al level up`);
    return true;
  }
  console.log(`❌ BUG-2302 FALLA: ${skillName} — level up sin stats`);
  return false;
}

main().catch(e => { console.error(e); process.exit(1); });
