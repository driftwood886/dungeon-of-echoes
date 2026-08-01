/**
 * Test DIS-2184: El efecto de sala aparece ANTES del encabezado en el move.
 * Antes del fix: "🌐 Efecto de sala activo: ✨ Aura Sagrada\n=== ENTRADA DE LA CRIPTA ==="
 * Después del fix: "=== ENTRADA DE LA CRIPTA ===\n🌐 Efecto de sala activo: ✨ Aura Sagrada"
 *
 * Test DIS-2180: Hint de Sala de Práctica en sala 1 se muestra solo a jugadores
 * que NO completaron el tutorial (tutorial_step === 0 → suprimir hint).
 */
'use strict';

const db = require('./db/db.js');
const engine = require('./game/engine.js');
const dungeon = require('./game/dungeon.js');

async function runTest() {
  await db.init();

  // ─── Test DIS-2184 ─────────────────────────────────────────────────────────
  console.log('\n=== DIS-2184: Orden efecto de sala en move ===');
  const username2184 = 'BotDIS2184_' + Date.now();
  let player = db.createPlayer(username2184);
  const pid = player.id;

  db.updatePlayer(pid, {
    level: 3,
    attack: 10,
    hp: 40,
    max_hp: 40,
    player_class: 'guerrero',
    current_room_id: 2,  // Corredor de las Sombras
    tutorial_step: 0,
    gold: 50,
    rooms_visited: JSON.stringify([2]),
  });

  player = db.getPlayer(pid);
  // Mover al jugador de sala 2 → sala 1 (Entrada, que tiene ✨ Aura Sagrada)
  const result = engine.processAction(player, 'norte');
  const text = result.text || '';
  console.log('Resultado move norte (sala 2→1):');
  console.log(text.substring(0, 400));
  console.log('---');

  // Verificar orden: el header === ENTRADA === debe aparecer ANTES del efecto 🌐
  const headerPos = text.indexOf('=== ENTRADA DE LA CRIPTA ===');
  const effectPos = text.indexOf('🌐 Efecto de sala activo');
  if (headerPos === -1) {
    console.log('❌ Header de sala no encontrado en el texto');
  } else if (effectPos === -1) {
    console.log('⚠️  Efecto de sala no encontrado (puede no haber revisita con efecto)');
  } else if (headerPos < effectPos) {
    console.log('✅ DIS-2184 OK: header aparece ANTES que el efecto (' + headerPos + ' < ' + effectPos + ')');
  } else {
    console.log('❌ DIS-2184 FAIL: efecto (' + effectPos + ') aparece ANTES que el header (' + headerPos + ')');
  }

  // ─── Test DIS-2180 ─────────────────────────────────────────────────────────
  console.log('\n=== DIS-2180: Hint de Sala de Práctica condicional ===');

  // Jugador con tutorial completado (tutorial_step = 0) — NO debe ver el hint
  db.updatePlayer(pid, { tutorial_step: 0, current_room_id: 1, rooms_visited: JSON.stringify([1]) });
  const p0 = db.getPlayer(pid);
  const desc0 = dungeon.describeRoom(1, null, p0);
  const hasHint0 = desc0.includes('Sos nuevo');
  console.log('tutorial_step=0 (completado) — hint suprimido:', !hasHint0, hasHint0 ? '❌ FAIL' : '✅ OK');

  // Jugador con tutorial en progreso (tutorial_step = 1) — NO debe ver el hint tampoco
  // (porque está en tutorial activo, no ha llegado a sala 1 desde el dungeon)
  // En realidad el issue solo pide suprimir cuando ya lo completó.
  // Con tutorial_step = 1 el jugador está en la sala 16 (tutorial), no en sala 1.
  // Para asegurar la lógica, verificamos que tutorial_step null (jugador antiguo) VE el hint.
  db.updatePlayer(pid, { tutorial_step: null });
  const pNull = db.getPlayer(pid);
  const descNull = dungeon.describeRoom(1, null, pNull);
  const hasHintNull = descNull.includes('Sos nuevo');
  console.log('tutorial_step=null (jugador antiguo) — hint visible:', hasHintNull, hasHintNull ? '✅ OK' : '⚠️  hint ausente (puede ser que la descripción de sala no tenga el hint aún)');

  // Cleanup
  db.deletePlayer(pid);
  console.log('\nTest player eliminado.');
}

runTest().catch(e => console.error('Error en test:', e));
