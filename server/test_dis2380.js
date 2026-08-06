/**
 * test_dis2380.js — Verificar fix de DIS-2380
 * Bug: al equipar arma espectral, el mensaje 💬 comparaba con "espada de hierro"
 * en lugar del arma previamente equipada (espada de obsidiana).
 *
 * Fix: la comparación ahora usa el arma previamente equipada como referencia.
 */

'use strict';

const db = require('./db/db.js');
const engine = require('./game/engine.js');

async function main() {
  await db.init(':memory:');

  // Crear jugador de prueba
  const username = 'TestDIS2380_' + Date.now();
  let player = db.createPlayer(username);
  if (!player) {
    player = db.getPlayerByUsername(username);
  }
  if (!player) {
    console.error('ERROR: No se pudo crear jugador de prueba');
    process.exit(1);
  }

  // Configurar como Guerrero con espada de obsidiana equipada
  db.updatePlayer(player.id, {
    player_class: 'guerrero',
    attack: 17,        // base 5 + 12 (obsidiana)
    level: 10,
    equipped_weapon: 'espada de obsidiana',
    inventory: JSON.stringify(['alabarda espectral']),
  });

  const p = db.getPlayer(player.id);
  console.log('Setup OK:', {
    class: p.player_class,
    weapon: p.equipped_weapon,
    attack: p.attack,
    inv: p.inventory,
  });

  // Ejecutar el comando equip
  const result = engine.execute(player.id, 'equip alabarda espectral');
  console.log('\n--- Resultado equip ---');
  console.log(result.text);

  // Verificar que el mensaje menciona la espada de obsidiana, no la espada de hierro
  const text = result.text || '';
  const mentionsObsidiana = text.includes('obsidiana');
  const mentionsHierro = text.includes('espada de hierro');

  console.log('\n--- Verificación ---');
  console.log('¿Menciona espada de obsidiana?', mentionsObsidiana ? '✅ SÍ' : '❌ NO');
  console.log('¿Menciona espada de hierro (falso positivo)?', mentionsHierro ? '❌ SÍ (BUG)' : '✅ NO');

  if (mentionsObsidiana && !mentionsHierro) {
    console.log('\n✅ DIS-2380 FIXED — la comparación usa el arma anterior correctamente');
    process.exit(0);
  } else if (!mentionsObsidiana && !mentionsHierro) {
    console.log('\n⚠️  No hay nota de comparación en el mensaje — revisar si la clase es Guerrero');
    process.exit(1);
  } else {
    console.log('\n❌ DIS-2380 AÚN PRESENTE — revisar lógica');
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
