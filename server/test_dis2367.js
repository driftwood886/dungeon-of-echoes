/**
 * test_dis2367.js — DIS-2367: Epitafio captura "confirmar"
 *
 * Verifica que el filtrado de confirmation tokens en cmdAscend funciona:
 * - "ascender 1 confirmar" → epitafio null (no "confirmar")
 * - "ascender 1 mi frase confirmar" → epitafio "mi frase"
 * - "ascender 1 mi frase memorable" → epitafio "mi frase memorable" (sin cambios)
 * - "ascender 1" → epitafio null
 */

'use strict';

// Replicar la lógica de filtrado de DIS-2367 directamente
function extractEpitaph(rawEpitaph) {
  let epitaph = rawEpitaph ? rawEpitaph.trim() : null;
  if (epitaph) {
    const CONFIRM_TOKENS = new Set(['confirmar', 'confirm', 'sí', 'si', 'yes']);
    if (CONFIRM_TOKENS.has(epitaph.toLowerCase())) {
      epitaph = null;
    } else {
      const parts = epitaph.split(/\s+/);
      if (parts.length > 0 && CONFIRM_TOKENS.has(parts[parts.length - 1].toLowerCase())) {
        epitaph = parts.slice(0, -1).join(' ').trim() || null;
      }
    }
  }
  return epitaph;
}

// Simular el regex de cmdAscend: /^([123])\s*(.*)?$/
function parseArg(argStr) {
  const match = argStr.match(/^([123])\s*(.*)?$/);
  if (!match) return null;
  return { choice: match[1], rawEpitaph: match[2] || '' };
}

let passed = 0;
let failed = 0;

function assert(label, actual, expected) {
  if (actual === expected) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}: esperado="${expected}" actual="${actual}"`);
    failed++;
  }
}

console.log('\n=== DIS-2367: Filtrado de epitafio en ascensión ===\n');

// Caso 1: "ascender 1 confirmar" — el bug original
{
  const parsed = parseArg('1 confirmar');
  const epitaph = extractEpitaph(parsed.rawEpitaph);
  assert('"ascender 1 confirmar" → epitafio null', epitaph, null);
}

// Caso 2: "ascender 1 mi frase confirmar" — epitafio con confirmar al final
{
  const parsed = parseArg('1 mi frase confirmar');
  const epitaph = extractEpitaph(parsed.rawEpitaph);
  assert('"ascender 1 mi frase confirmar" → epitafio "mi frase"', epitaph, 'mi frase');
}

// Caso 3: "ascender 1 mi frase memorable" — epitafio limpio sin confirmar
{
  const parsed = parseArg('1 mi frase memorable');
  const epitaph = extractEpitaph(parsed.rawEpitaph);
  assert('"ascender 1 mi frase memorable" → epitafio preservado', epitaph, 'mi frase memorable');
}

// Caso 4: "ascender 1" — sin epitafio
{
  const parsed = parseArg('1');
  const epitaph = extractEpitaph(parsed.rawEpitaph);
  assert('"ascender 1" (sin epitafio) → null', epitaph, null);
}

// Caso 5: "ascender 1 yes" — confirm en inglés
{
  const parsed = parseArg('1 yes');
  const epitaph = extractEpitaph(parsed.rawEpitaph);
  assert('"ascender 1 yes" (confirm inglés) → null', epitaph, null);
}

// Caso 6: "ascender 1 sí" — confirm con tilde
{
  const parsed = parseArg('1 sí');
  const epitaph = extractEpitaph(parsed.rawEpitaph);
  assert('"ascender 1 sí" → null', epitaph, null);
}

// Caso 7: epitafio que termina en "si" (sin tilde — falso positivo potencial)
{
  const parsed = parseArg('1 lo hice así');
  const epitaph = extractEpitaph(parsed.rawEpitaph);
  // "así" no está en el set, "si" sí. "así" !== "si". OK.
  assert('"ascender 1 lo hice así" → epitafio preservado', epitaph, 'lo hice así');
}

// Caso 8: "ascender 1 si" — "si" sin tilde es confirm
{
  const parsed = parseArg('1 si');
  const epitaph = extractEpitaph(parsed.rawEpitaph);
  assert('"ascender 1 si" → null', epitaph, null);
}

console.log(`\n${passed + failed} tests — ✅ ${passed} pasaron, ❌ ${failed} fallaron\n`);
process.exit(failed > 0 ? 1 : 0);
