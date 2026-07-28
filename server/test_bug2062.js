/**
 * Test BUG-2062: Status ATK no muestra agotamiento berserk cuando se cancela con postura agresiva.
 * Cuando berserkAtkMod === -2 y stanceAtkMod === +2, totalBonus === 0 y el display
 * omitía el breakdown — el jugador no sabía que el agotamiento estaba activo.
 * Fix: usar hasAnyMod en vez de totalBonus !== 0.
 */
'use strict';

const db = require('./db/db.js');
const engine = require('./game/engine.js');

async function runTest() {
  await db.init();

  const username = 'BugBot2062_' + Date.now();
  let player = db.createPlayer(username);
  const pid = player.id;
  console.log(`[TEST] Jugador: ${player.username} (id=${pid})`);

  // Escenario: Berserker con agotamiento (-2 ATK) y postura agresiva (+2 ATK)
  // totalBonus = 0, pero ambos efectos están presentes — el breakdown DEBE mostrarse.
  const statusEffects = JSON.stringify({
    berserk_agotamiento: {
      turns_remaining: 2,
      atk_penalty: 2
    }
  });

  db.updatePlayer(pid, {
    level: 6,
    attack: 21,
    hp: 80, max_hp: 80,
    player_class: 'berserker',
    stance: 'agresivo',
    current_room_id: 1,
    status_effects: statusEffects,
    active_scrolls: JSON.stringify({}),
  });

  console.log('\n--- Escenario 1: berserk_agotamiento (-2) + postura agresiva (+2) → totalBonus = 0 ---');
  const result1 = engine.execute(pid, 'status');
  console.log(result1.text);

  // Buscar la línea de Ataque
  const atkLine1 = result1.text.split('\n').find(l => l.includes('Ataque'));
  console.log(`\n[LINE ATK]: "${atkLine1}"`);

  const hasBreakdown1 = atkLine1 && atkLine1.includes('agotamiento');
  const hasArrow1 = atkLine1 && atkLine1.includes('→');
  if (hasBreakdown1 && hasArrow1) {
    console.log('[TEST] ✅ BUG-2062 CORREGIDO: muestra breakdown aunque totalBonus === 0');
  } else {
    console.log('[TEST] ❌ BUG PERSISTE: no muestra agotamiento en ATK display');
    console.log(`  hasBreakdown: ${hasBreakdown1}, hasArrow: ${hasArrow1}`);
  }

  // Escenario 2: solo agotamiento sin postura agresiva (caso base — no debería haber regresión)
  db.updatePlayer(pid, { stance: 'equilibrado' });
  console.log('\n--- Escenario 2: solo berserk_agotamiento (-2), postura equilibrada ---');
  const result2 = engine.execute(pid, 'status');
  const atkLine2 = result2.text.split('\n').find(l => l.includes('Ataque'));
  console.log(`[LINE ATK]: "${atkLine2}"`);

  const hasBreakdown2 = atkLine2 && atkLine2.includes('agotamiento');
  if (hasBreakdown2) {
    console.log('[TEST] ✅ Escenario base también muestra agotamiento. OK.');
  } else {
    console.log('[TEST] ❌ Regresión en escenario base — agotamiento sin postura no se muestra.');
  }

  // Escenario 3: sin efectos — debe mostrar Ataque simple (no regression)
  db.updatePlayer(pid, { status_effects: JSON.stringify({}), stance: 'equilibrado' });
  console.log('\n--- Escenario 3: sin modificadores — Ataque debe ser simple ---');
  const result3 = engine.execute(pid, 'status');
  const atkLine3 = result3.text.split('\n').find(l => l.includes('Ataque'));
  console.log(`[LINE ATK]: "${atkLine3}"`);

  const isSimple3 = atkLine3 && !atkLine3.includes('→') && !atkLine3.includes('efectivo');
  if (isSimple3) {
    console.log('[TEST] ✅ Sin modificadores → Ataque simple sin breakdown. OK.');
  } else {
    console.log('[TEST] ❌ Regresión: Ataque sin modificadores muestra breakdown innecesario.');
  }

  // Cleanup
  db.deletePlayer(pid);
  process.exit(0);
}

runTest().catch(e => {
  console.error('[TEST] Error:', e);
  process.exit(1);
});
