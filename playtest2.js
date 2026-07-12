'use strict';

const db = require('./server/db/db.js');
const engine = require('./server/game/engine.js');

async function run() {
  await db.init();
  
  const USERNAME = 'bot_play_3';
  const existing = db.getPlayerByUsername(USERNAME);
  if (existing) db.deletePlayer(existing.id);

  const player = engine.getOrCreatePlayer(USERNAME);
  const pid = player.id;
  engine.execute(pid, 'clase guerrero');
  console.log('Jugador:', pid);

  function cmd(command) {
    const result = engine.execute(pid, command, {});
    const text = result.text || '';
    return text;
  }

  // Tutorial básico
  cmd('attack goblin');
  cmd('north'); // sala 1 entrada
  
  // TEST: verificar comando correcto para recoger items
  console.log('\n=== TEST: comandos de recoger ===');
  // Ir al corredor y matar algo
  cmd('north'); // sala 2 corredor
  cmd('attack rata gigante');
  cmd('attack rata gigante');
  cmd('attack rata gigante');
  cmd('attack');
  cmd('attack');
  cmd('attack');
  cmd('attack');
  
  // Ver qué hay en el suelo
  const lookResp = cmd('look');
  console.log('LOOK:', lookResp.substring(0, 400));
  
  // Intentar diferentes comandos de pickup
  console.log('\n--- recoger ---');
  console.log(cmd('recoger').substring(0, 200));
  
  console.log('\n--- tomar ---');
  console.log(cmd('tomar').substring(0, 200));
  
  // TEST DIS-1498: probar el comando correcto de facciones
  console.log('\n=== TEST DIS-1498: Facciones info ===');
  const facList = cmd('faccion');
  console.log('LISTA FACCIONES:\n', facList);
  
  // Probar info de una facción específica
  const facInfo = cmd('faccion info orden_filo');
  console.log('\nINFO orden_filo:\n', facInfo);
  
  const facInfo2 = cmd('faccion info hermandad_mercado');
  console.log('\nINFO hermandad_mercado:\n', facInfo2);
  
  // Elegir y ver card
  cmd('faccion elegir orden_filo');
  const facView = cmd('faccion');
  console.log('\nFACCION después de elegir:\n', facView);
  
  // TEST DIS-1504: Buscar sala con boss de nivel alto y ser nivel bajo
  console.log('\n=== TEST DIS-1504: advertencia de boss ===');
  console.log('NIVEL ACTUAL:', cmd('status').substring(0, 100));
  
  // Intentar ir a la Prisión (sala 8) directamente
  // Ruta posible: sala 2 → west → Capilla → down → Pozo → ? 
  cmd('look');  // ver salidas sala 2
  
  // Intentar sur desde sala 2
  const s1 = cmd('south');
  console.log('Sur desde corredor:', s1.substring(0, 150));
  cmd('look');
  
  // Intentar west desde sala 1 (Capilla)
  cmd('north'); // volver sala 2  
  cmd('west'); // ? 
  cmd('look');
  const southCapilla = cmd('south');
  console.log('Sur desde capilla:', southCapilla.substring(0, 300));
  cmd('look');
  
  // Intentar north desde Pozo?
  const northPozo = cmd('north');
  console.log('Norte:', northPozo.substring(0, 300));
  cmd('look');
  
  // Ahora desde sala donde estemos, intentar entrar a sala de boss de nivel alto
  // Primero saber dónde estamos
  const whereAmI = cmd('look');
  console.log('Donde estoy:', whereAmI.substring(0, 200));
  
  // TEST DIS-1501: ir a sala 4 (Cámara del Tesoro) y atacar al esqueleto guardia
  console.log('\n=== TEST DIS-1501: Aldric nota guardia muerto ===');
  // Mover a sala 4
  db.updatePlayer(pid, { current_room_id: 4, hp: 35 });
  cmd('look');
  
  // Ver si hay esqueleto guerrero en sala 4
  const sala4Look = cmd('look');
  console.log('SALA 4 LOOK:', sala4Look.substring(0, 500));
  
  // Atacar al esqueleto
  for (let i = 0; i < 6; i++) {
    const atk = cmd('attack esqueleto guerrero');
    console.log('ATK ' + i + ':', atk.substring(0, 250));
    if (atk.includes('cae derrotado') || atk.includes('no hay') || atk.includes('No hay')) break;
  }
  
  // Ver si Aldric comentó algo
  const lookPost = cmd('look');
  console.log('POST-KILL LOOK:', lookPost.substring(0, 400));
  
  // Hablar con Aldric
  const aldricTalk = cmd('hablar aldric');
  console.log('ALDRIC HABLA:', aldricTalk.substring(0, 300));
  
  // TEST DIS-1502: Recoger diente afilado con tip
  console.log('\n=== TEST DIS-1502: Diente afilado + tip crafteo ===');
  // Ir al Pozo Sin Fondo o donde haya rata/monstruo que dropee diente
  // El Corredor tiene Rata Gigante que puede dropear garra de rata (no diente)
  // El diente lo droppean esqueletos u otros
  // Buscar en sala donde droppeen diente
  db.updatePlayer(pid, { current_room_id: 7 }); // Pozo Sin Fondo (arañas)
  const sala7Look = cmd('look');
  console.log('SALA 7 LOOK:', sala7Look.substring(0, 400));
  
  for (let i = 0; i < 5; i++) {
    const atk = cmd('attack');
    if (atk.includes('no hay') || atk.includes('No hay')) break;
  }
  
  const recResp = cmd('recoger');
  console.log('RECOGER EN SALA 7:', recResp.substring(0, 400));
  
  // Verificar si hay diente en alguna sala
  // El diente lo droppean los Crocolisks o bestias específicas
  db.updatePlayer(pid, { current_room_id: 2 }); // Corredor
  for (let i = 0; i < 4; i++) {
    const atk = cmd('attack');
    if (atk.includes('no hay') || atk.includes('No hay')) break;
  }
  const recCorredor = cmd('recoger');
  console.log('RECOGER EN CORREDOR:', recCorredor.substring(0, 400));
  
  // Verificar DIRECTAMENTE poniendo un diente en el suelo
  // Usando db directamente para simular que el diente está en el inventario
  // y luego tirarlo para recogerlo de nuevo
  console.log('\n--- Simulando primer pickup de diente ---');
  const freshPlayer = db.getPlayer(pid);
  const currentInv = freshPlayer.inventory ? JSON.parse(freshPlayer.inventory) : [];
  db.updatePlayer(pid, { 
    inventory: JSON.stringify([...currentInv, 'diente afilado']),
    current_room_id: 2
  });
  // Tirar el diente
  const tirar = cmd('tirar diente afilado');
  console.log('TIRAR:', tirar.substring(0, 200));
  // Ahora recogerlo de nuevo - el tip SOLO aparece la primera vez
  // Pero ya lo "tenía", así que el flag puede estar puesto
  // Intentar con un jugador limpio
  
  db.deletePlayer(pid);
  console.log('\n=== TEST COMPLETADO ===');
  process.exit(0);
}

run().catch(e => {
  console.error('ERROR:', e);
  process.exit(1);
});
