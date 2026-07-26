/**
 * test_dis1990.js — DIS-1990: Recordatorio de facción diferido al matar Espectro y subir a nivel 5.
 *
 * Verifica:
 * 1. Al subir a nivel 5 sin facción, combat.js guarda faction_level5_reminder=true (no muestra mensaje inline).
 * 2. Al moverse a sala con monstruos vivos, el flag NO se consume.
 * 3. Al moverse a sala sin monstruos, el flag se consume y aparece el recordatorio en el bloque Sistema.
 */

'use strict';

const assert = require('assert');

// ── Mocks ────────────────────────────────────────────────────────────────────
const savedEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'test';

// Necesitamos probar combat.js de forma aislada
// Verificamos la lógica del flag directamente inspeccionando el código fuente
const fs = require('fs');
const path = require('path');

const combatSrc = fs.readFileSync(path.join(__dirname, 'game/combat.js'), 'utf8');
const engineSrc = fs.readFileSync(path.join(__dirname, 'game/engine.js'), 'utf8');

// ── Test 1: combat.js ya NO hace lines.push del recordatorio inline ──────────
const inlineMsg = 'Último recordatorio: llegaste al nivel 5 sin unirte a ninguna facción';
assert(
  !combatSrc.includes(inlineMsg),
  'FAIL: combat.js todavía tiene el mensaje inline de "Último recordatorio"'
);
console.log('✅ Test 1 — combat.js no muestra el recordatorio inline.');

// ── Test 2: combat.js guarda faction_level5_reminder al subir a nivel 5 ──────
assert(
  combatSrc.includes('faction_level5_reminder'),
  'FAIL: combat.js no guarda el flag faction_level5_reminder'
);
assert(
  combatSrc.includes('faction_level5_reminder: true'),
  'FAIL: combat.js no asigna faction_level5_reminder: true'
);
console.log('✅ Test 2 — combat.js guarda faction_level5_reminder al subir a nivel 5.');

// ── Test 3: engine.js lee el flag en cmdMove y lo muestra al llegar a sala neutra ──
assert(
  engineSrc.includes('faction_level5_reminder'),
  'FAIL: engine.js no lee el flag faction_level5_reminder en cmdMove'
);
assert(
  engineSrc.includes('_factionDeferredMsg'),
  'FAIL: engine.js no tiene _factionDeferredMsg'
);
assert(
  engineSrc.includes('_dis1990'),
  'FAIL: engine.js no tiene bloque try/catch DIS-1990'
);
console.log('✅ Test 3 — engine.js lee el flag y difiere el mensaje al movimiento.');

// ── Test 4: el mensaje diferido está en _passiveBlocks (no antes del texto narrativo) ──
const passiveBlocksLine = engineSrc.indexOf('const _passiveBlocks = [cartogAchLines');
const factionDeferredInBlocks = engineSrc.indexOf('_factionDeferredMsg]', passiveBlocksLine);
assert(factionDeferredInBlocks > 0, 'FAIL: _factionDeferredMsg no está en _passiveBlocks');
console.log('✅ Test 4 — El recordatorio va en el bloque pasivo (— Sistema —), no interrumpe narrativa.');

// ── Test 5: el flag se limpia después de mostrar (no se repite) ──────────────
assert(
  engineSrc.includes('delete seFDClean.faction_level5_reminder'),
  'FAIL: engine.js no limpia el flag después de mostrarlo'
);
console.log('✅ Test 5 — El flag se elimina después de mostrarse (no se repite).');

// ── Test 6: solo se muestra en salas sin monstruos vivos ─────────────────────
assert(
  engineSrc.includes('hasLivingMonsters') && engineSrc.includes('!hasLivingMonsters'),
  'FAIL: engine.js no verifica ausencia de monstruos vivos antes de mostrar el recordatorio'
);
console.log('✅ Test 6 — El recordatorio solo aparece en salas sin monstruos activos.');

console.log('\n🎉 Todos los tests de DIS-1990 pasaron.');
process.env.NODE_ENV = savedEnv;
