/**
 * test_bug983.js
 * Prueba de integración para BUG-983: carta_sellada_leida no persiste tras cmdMove/cmdUse
 *
 * Escenario 1: jugador usa "carta sellada" ANTES de tener la quest activa
 *   → status_effects.carta_sellada_leida debe persistir tras un cmdMove
 *   → al hacer "talk aldric" al llegar al nivel 5, la quest debe completarse
 */
const db = require('./server/db/db');
const { execute } = require('./server/game/engine');

function parseSE(se) {
  if (!se) return {};
  if (typeof se === 'string') try { return JSON.parse(se); } catch(e) { return {}; }
  return se;
}

// Helpers
function getPlayer(id) { return db.getPlayer(id); }

async function main() {
  console.log('=== TEST BUG-983 ===\n');

  // --- Setup ---
  // Crear jugador fresco o reutilizar
  let p = db.getPlayerByUsername('TestBug983b');
  if (!p) {
    p = db.createPlayer('TestBug983b');
    console.log('[setup] Jugador creado:', p.id);
  } else {
    console.log('[setup] Jugador existente reutilizado:', p.id);
  }

  // Configurar: nivel 4 (quest requiere nivel 5 para triggear),
  // en sala 8 (donde existe la carta), con la carta en inventario
  db.updatePlayer(p.id, {
    level: 4,
    xp: 500,
    hp: 80, max_hp: 80,
    current_room_id: 8,
    inventory: JSON.stringify(['carta sellada', 'poción de salud']),
    status_effects: JSON.stringify({}),
    aldric_quest: 'none',
  });

  console.log('[setup] Nivel 4, sala 8, inventario con carta sellada\n');

  // --- Paso 1: usar carta sellada ---
  console.log('[Paso 1] use carta sellada');
  const r1 = execute(p.id, 'use carta sellada');
  console.log('Resultado:', r1.text.slice(0, 120), '...\n');

  let pAfterUse = getPlayer(p.id);
  const seAfterUse = parseSE(pAfterUse.status_effects);
  console.log('[Paso 1] status_effects después de use:', JSON.stringify(seAfterUse));
  const flagAfterUse = seAfterUse.carta_sellada_leida;
  console.log('[Paso 1] carta_sellada_leida =', flagAfterUse, flagAfterUse ? '✅ OK' : '❌ FALLO');
  console.log('[Paso 1] inventario:', pAfterUse.inventory);
  console.log();

  // --- Paso 2: moverse (disparar cmdMove para ver si persiste) ---
  console.log('[Paso 2] move norte (o cualquier dirección válida desde sala 8)');
  const r2 = execute(p.id, 'move norte');
  console.log('Resultado:', r2.text.slice(0, 120), '...\n');

  let pAfterMove = getPlayer(p.id);
  const seAfterMove = parseSE(pAfterMove.status_effects);
  console.log('[Paso 2] status_effects después de move:', JSON.stringify(seAfterMove));
  const flagAfterMove = seAfterMove.carta_sellada_leida;
  console.log('[Paso 2] carta_sellada_leida =', flagAfterMove, flagAfterMove ? '✅ OK (PERSISTIÓ)' : '❌ FALLO (se perdió)');
  console.log('[Paso 2] sala actual:', pAfterMove.current_room_id);
  console.log();

  // --- Paso 3: level up a nivel 5 para habilitar quest ---
  console.log('[Paso 3] Subir a nivel 5 via updatePlayer directo');
  db.updatePlayer(p.id, { level: 5, xp: 1500, current_room_id: 2 }); // sala 2 = where Aldric is
  let pLv5 = getPlayer(p.id);
  console.log('[Paso 3] Nivel actual:', pLv5.level);
  const seLv5 = parseSE(pLv5.status_effects);
  console.log('[Paso 3] carta_sellada_leida antes de talk aldric:', seLv5.carta_sellada_leida, seLv5.carta_sellada_leida ? '✅' : '❌ PERDIDO');
  console.log();

  // --- Paso 4: talk aldric ---
  console.log('[Paso 4] talk aldric');
  const r4 = execute(p.id, 'talk aldric');
  const questDone = r4.text.includes('Quest completada') || r4.text.includes('quest completada');
  console.log('Resultado:', r4.text.slice(0, 200), '...');
  console.log('[Paso 4] Quest completada:', questDone, questDone ? '✅ BUG-983 RESUELTO' : '❌ BUG-983 PERSISTE');
  console.log();

  // --- Resumen ---
  console.log('=== RESUMEN ===');
  console.log('Paso 1 (flag tras use):', flagAfterUse ? '✅' : '❌');
  console.log('Paso 2 (flag tras move):', flagAfterMove ? '✅' : '❌');
  console.log('Paso 3 (flag tras updatePlayer):', seLv5.carta_sellada_leida ? '✅' : '❌');
  console.log('Paso 4 (quest completada):', questDone ? '✅' : '❌');
  const allOk = flagAfterUse && flagAfterMove && seLv5.carta_sellada_leida && questDone;
  console.log('\n', allOk ? '🎉 TODOS LOS PASOS PASARON — BUG-983 CERRADO' : '⚠️  ALGUNOS PASOS FALLARON — bug persiste');

  // --- Cleanup ---
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
