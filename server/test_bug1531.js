/**
 * Test BUG-1531: lógica de filtrado de monstruos durante Marea Espectral para `buscar`
 * 
 * Verifica que durante SPECTRAL_TIDE, los monstruos no espectrales/no-muertos
 * no bloquean el comando buscar (forage).
 * 
 * No requiere DB activa — testea la lógica pura del filtro.
 */

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${msg}`);
    failed++;
  }
}

console.log('=== Test BUG-1531: lógica de filtrado Marea Espectral en forage ===\n');

// Replicar exactamente la lógica del fix en engine.js (BUG-1531)
const FORAGE_SPECTRAL_IDS = new Set([4, 8, 12, 13, 21, 22]);

function isActiveInSpectralTide(m) {
  const mNameLower = (m.name || '').toLowerCase();
  const isSpectral = FORAGE_SPECTRAL_IDS.has(m.id) ||
    mNameLower.includes('espectro') || mNameLower.includes('fantasma') ||
    mNameLower.includes('espectral') || mNameLower.includes('lich') || mNameLower.includes('sombra');
  const isUndead = mNameLower.includes('esqueleto') || mNameLower.includes('zombie') ||
    mNameLower.includes('zombi') || mNameLower.includes('vampiro') || mNameLower.includes('momia') ||
    mNameLower.includes('óseo') || mNameLower.includes('muerto');
  return isSpectral || isUndead;
}

// Test 1: Monstruos normales → inactivos durante Marea Espectral (no bloquean forage)
console.log('Test 1: Monstruos normales → no bloquean forage durante Marea Espectral');
const normalMonsters = [
  { id: 100, name: 'Goblin' },
  { id: 101, name: 'Orco' },
  { id: 102, name: 'Troll de Hielo' },
  { id: 103, name: 'Araña Gigante' },
];
const activeNormal = normalMonsters.filter(isActiveInSpectralTide);
assert(activeNormal.length === 0, `Goblin, Orco, Troll, Araña → todos inactivos (${activeNormal.map(m=>m.name).join(', ') || 'ninguno'})`);

// Test 2: Monstruos espectrales → siguen activos (bloquean forage)
console.log('\nTest 2: Monstruos espectrales → siguen bloqueando forage');
const spectralMonsters = [
  { id: 8,   name: 'el Guardia Espectral' },  // por ID
  { id: 200, name: 'Espectro Oscuro' },         // por nombre
  { id: 201, name: 'Fantasma del Pasado' },     // por nombre
  { id: 202, name: 'Lich de las Sombras' },     // por nombre (lich)
  { id: 203, name: 'Sombra Viviente' },          // por nombre
];
const activeSpectral = spectralMonsters.filter(isActiveInSpectralTide);
assert(activeSpectral.length === 5, `Todos los espectrales siguen activos (${activeSpectral.length}/5)`);

// Test 3: No-muertos → siguen activos
console.log('\nTest 3: No-muertos → siguen bloqueando forage');
const undeadMonsters = [
  { id: 300, name: 'Esqueleto Guerrero' },
  { id: 301, name: 'Zombie Carcelero' },
  { id: 302, name: 'Vampiro Antiguo' },
  { id: 303, name: 'Ente Óseo' },
];
const activeUndead = undeadMonsters.filter(isActiveInSpectralTide);
assert(activeUndead.length === 4, `Todos los no-muertos siguen activos (${activeUndead.length}/4)`);

// Test 4: IDs especiales
console.log('\nTest 4: IDs especiales (set hardcodeado)');
const specialIds = [4, 12, 13, 21, 22].map(id => ({ id, name: 'Monstruo Normal' }));
const activeSpecialIds = specialIds.filter(isActiveInSpectralTide);
assert(activeSpecialIds.length === 5, `IDs especiales [4,12,13,21,22] activos aunque el nombre no sea espectral`);

// Test 5: Monstruos mixtos — solo espectrales bloquean
console.log('\nTest 5: Sala con mezcla de monstruos');
const mixedRoom = [
  { id: 100, name: 'Goblin' },        // inactivo
  { id: 8,   name: 'Guardia Espectral' }, // activo
  { id: 101, name: 'Orco' },          // inactivo  
  { id: 300, name: 'Esqueleto' },     // activo (no-muerto)
];
const activeMixed = mixedRoom.filter(isActiveInSpectralTide);
assert(activeMixed.length === 2, `Sala mixta: 2 activos (Espectral + Esqueleto), 2 inactivos (Goblin + Orco)`);
assert(activeMixed.some(m => m.name.includes('Espectral')), 'Guardia Espectral está en activos');
assert(activeMixed.some(m => m.name.includes('Esqueleto')), 'Esqueleto está en activos');

// Test 6: Caso exacto del bug — sala 11 Galería de Hielo (monstruos de hielo normales)
console.log('\nTest 6: Caso específico sala 11 (Galería de Hielo)');
const sala11Monsters = [
  { id: 50, name: 'Elemental de Hielo' },
  { id: 51, name: 'Guardián de Hielo' },
];
const activeSala11 = sala11Monsters.filter(isActiveInSpectralTide);
assert(activeSala11.length === 0, `Sala 11: Elemental de Hielo y Guardián de Hielo → inactivos → forage desbloqueado`);

console.log(`\n=== Resultado: ${passed} pasados, ${failed} fallados ===`);
process.exit(failed > 0 ? 1 : 0);
