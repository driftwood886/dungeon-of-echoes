// test_dis1987.js — DIS-1987: faccion elegir une directamente, faccion info solo muestra ficha
'use strict';
const db = require('./db/db');
const engine = require('./game/engine');

async function main() {
  await db.init();

  console.log('=== Test DIS-1987: Flujo de facción simplificado ===\n');

  // Crear jugador de prueba nivel 3+ sin facción
  const pname = 'bot_test_dis1987';
  let player = db.getPlayerByUsername(pname);
  if (player) {
    db.updatePlayer(player.id, { faction: null, level: 3, xp: 300, player_class: 'guerrero', status_effects: '{}' });
  } else {
    player = db.createPlayer(pname);
    db.updatePlayer(player.id, { level: 3, xp: 300, player_class: 'guerrero', is_bot: 1 });
  }
  player = db.getPlayer(player.id);

  console.log(`Jugador: ${player.name} | nivel ${player.level} | faccion: ${player.faction || 'ninguna'}`);

  // Test 1: faccion (sin args) — debe mostrar facciones disponibles
  console.log('\n--- TEST 1: faccion (sin args) ---');
  let r = engine.execute(player.id, 'faccion', {});
  console.log(r.text.substring(0, 300));

  // Test 2: faccion info orden_filo — debe mostrar ficha SIN unirse
  console.log('\n--- TEST 2: faccion info orden_filo (solo ver) ---');
  player = db.getPlayer(player.id);
  r = engine.execute(player.id, 'faccion info orden_filo', {});
  console.log(r.text.substring(0, 300));

  // Verificar que NO se unió
  player = db.getPlayer(player.id);
  console.log(`\nFacción tras faccion info: "${player.faction || 'ninguna'}" — debe ser "ninguna"`);
  if (player.faction) { console.log('❌ FAIL: se unió sin querer'); process.exit(1); }

  // Test 3: faccion elegir orden_filo — debe unirse DIRECTAMENTE mostrando ficha + bienvenida
  console.log('\n--- TEST 3: faccion elegir orden_filo (debe unirse al instante) ---');
  r = engine.execute(player.id, 'faccion elegir orden_filo', {});
  console.log(r.text.substring(0, 500));

  // Verificar que SÍ se unió
  player = db.getPlayer(player.id);
  console.log(`\nFacción tras faccion elegir: "${player.faction}" — debe ser "orden_filo"`);

  if (player.faction === 'orden_filo') {
    console.log('\n✅ DIS-1987 PASS: faccion elegir une directamente sin paso de confirmación');
  } else {
    console.log('\n❌ DIS-1987 FAIL: faccion elegir no unió al jugador');
    process.exit(1);
  }

  // Test 4: faccion elegir misma facción — debe mostrar "ya sos miembro"
  console.log('\n--- TEST 4: faccion elegir orden_filo (ya miembro) ---');
  r = engine.execute(player.id, 'faccion elegir orden_filo', {});
  console.log(r.text.substring(0, 200));
  if (!r.text.includes('Ya sos miembro')) { console.log('❌ FAIL: no detectó que ya es miembro'); }
  else { console.log('✅ Detecta "ya miembro" correctamente'); }

  // Reset para próximos tests
  db.updatePlayer(player.id, { faction: null, status_effects: '{}' });

  console.log('\n✅ Test DIS-1987 completado OK');
}

main().catch(e => { console.error(e); process.exit(1); });
