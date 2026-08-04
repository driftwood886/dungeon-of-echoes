/**
 * test_dis2307.js — DIS-2307: Onboarding de facciones mejorado
 *
 * Verifica a nivel de código fuente que:
 * 1. calcLevelUp al subir al nivel 3 muestra hint enriquecido
 * 2. cmdFacciones tiene bloque informativo para jugador nivel 3+ sin facción
 * 3. cmdFacciones tiene mensaje "nivel 3" para jugador sub-nivel
 * 4. Mensaje del mensajero (EPIC-1377) incluye hint de cuándo elegir
 * 5. Recordatorio de nivel 5 menciona influencia perdida
 */

'use strict';

const path = require('path');
const fs   = require('fs');

let PASS = 0;
let FAIL = 0;
function ok(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); PASS++; }
  else       { console.log(`  ❌ ${label}`); FAIL++; }
}

const engineSrc = fs.readFileSync(path.join(__dirname, 'game/engine.js'), 'utf8');

// ── 1. calcLevelUp: hint nivel 3 enriquecido ─────────────────────────────────

console.log('\n--- 1. calcLevelUp: hint de facciones al subir al nivel 3 ---');
ok('hint menciona cuánto antes elegir (influencia acumulás)',
  engineSrc.includes('influencia acumulás'));
ok('hint menciona qué se pierde sin facción (pierde puntos)',
  engineSrc.includes('pierde puntos') || engineSrc.includes('pierde puntos'));
ok('hint incluye "facciones" y nivel 3',
  engineSrc.includes('lvl === 3') && engineSrc.includes('⚔️ ¡Ahora podés unirte a una facción!'));

// ── 2. cmdFacciones: jugador nivel 3+ sin facción ───────────────────────────

console.log('\n--- 2. cmdFacciones: guía de cuándo elegir para nivel 3+ ---');
ok('muestra "¿Cuándo conviene elegir?"',
  engineSrc.includes('¿Cuándo conviene elegir?'));
ok('muestra "influencia se pierde" o "influencia" cerca de "pierde"',
  engineSrc.includes('influencia se pierde'));
ok('muestra "faccion elegir <nombre>"',
  engineSrc.includes('faccion elegir <nombre>'));
ok('muestra "No hay penalización"',
  engineSrc.includes('No hay penalización'));

// ── 3. cmdFacciones: jugador nivel < 3 ──────────────────────────────────────

console.log('\n--- 3. cmdFacciones: mensaje para jugador sub-nivel ---');
ok('muestra "disponible en nivel 3" para sub-nivel',
  engineSrc.includes('disponible en nivel 3') || engineSrc.includes('nivel 3'));
ok('menciona "Seguí explorando"',
  engineSrc.includes('Seguí explorando'));

// ── 4. Mensaje del mensajero (EPIC-1377) ─────────────────────────────────────

console.log('\n--- 4. Mensaje mensajero EPIC-1377 ---');
ok('incluye "¿Cuándo conviene elegir?"',
  engineSrc.includes('¿Cuándo conviene elegir?'));
ok('menciona "influencia para tu facción"',
  engineSrc.includes('influencia para tu facción'));

// ── 5. Recordatorio nivel 5 ──────────────────────────────────────────────────

console.log('\n--- 5. Recordatorio nivel 5 sin facción ---');
ok('menciona "influencia" perdida en recordatorio',
  engineSrc.includes('no acumuló influencia para nadie'));
ok('dice "últim" aviso',
  engineSrc.includes('último aviso automático') || engineSrc.includes('último aviso'));

console.log(`\n=== Resultado: ${PASS} PASS / ${FAIL} FAIL ===`);
process.exit(FAIL > 0 ? 1 : 0);
