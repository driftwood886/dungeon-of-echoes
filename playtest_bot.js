'use strict';

const db = require('./server/db/db.js');
const engine = require('./server/game/engine.js');

async function runPlaytest() {
  await db.init();
  
  const USERNAME = 'bot_play_2';
  
  // Limpieza previa
  const existing = db.getPlayerByUsername(USERNAME);
  if (existing) db.deletePlayer(existing.id);

  // Crear jugador
  const player = engine.getOrCreatePlayer(USERNAME);
  const pid = player.id;
  
  // Aplicar clase guerrero
  engine.execute(pid, 'clase guerrero');
  
  console.log(`Jugador creado: ${pid}`);

  function cmd(command, label) {
    const result = engine.execute(pid, command, {});
    const text = result.text || '';
    const lines = text.split('\n').filter(l => l.trim());
    const preview = lines.slice(0, 4).join(' | ');
    if (label) {
      console.log(`\n[${label}]`);
    }
    console.log(`> ${command}`);
    console.log(`  ${preview.substring(0, 250)}`);
    return text;
  }

  // ── SALA INICIAL ──
  cmd('look', 'SALA INICIAL');
  cmd('status');

  // Tutorial — completar rápido
  // Atacar goblin (sala tutorial)
  cmd('attack goblin');
  cmd('attack goblin');
  cmd('attack goblin');
  cmd('attack goblin');
  
  // Mover al norte (Entrada de la Cripta)
  const moveResult = cmd('north');
  cmd('look');

  // ── TEST DIS-1498: Facciones con perks ──
  console.log('\n━━━ TEST DIS-1498: Facciones muestran perks de membresía ━━━');
  const faccionList = cmd('faccion');
  if (faccionList.includes('Tuyo') || faccionList.includes('perk') || 
      faccionList.includes('bonus') || faccionList.includes('Bonus') ||
      faccionList.includes('🗡') || faccionList.includes('🛡') || 
      faccionList.includes('economía') || faccionList.includes('combate')) {
    console.log('  ✅ DIS-1498 OK: lista de facciones muestra información de membresía');
  } else {
    console.log('  ❓ DIS-1498: revisar contenido de la lista');
    console.log('  FULL OUTPUT:');
    console.log(faccionList.substring(0, 600));
  }
  
  const faccionCard = cmd('faccion hermandad acero');
  if (faccionCard.includes('Tuyo') || faccionCard.includes('miembro') || faccionCard.includes('bonus') || faccionCard.includes('perk')) {
    console.log('  ✅ DIS-1498 OK: card individual muestra perk de membresía');
  } else {
    console.log('  ℹ️  Card hermandad:');
    console.log(faccionCard.substring(0, 500));
  }

  cmd('faccion unirse hermandad acero');
  
  // ── EXPLORACIÓN: CORREDOR DE LAS SOMBRAS ──
  cmd('north', 'CORREDOR DE LAS SOMBRAS'); // sala 2
  cmd('look');
  
  // Combatir
  for (let i = 0; i < 6; i++) {
    const atkText = cmd('attack');
    if (atkText.includes('no hay') || atkText.includes('No hay') || atkText.includes('no encontrás')) break;
  }
  cmd('pickup');
  
  // ── TEST DIS-1502: Diente afilado → tip de crafteo ──
  console.log('\n━━━ TEST DIS-1502: Tip de crafteo al recoger diente afilado ━━━');
  const pickupDiente = cmd('pickup diente afilado');
  if (pickupDiente.includes('diente')) {
    if (pickupDiente.includes('receta') || pickupDiente.includes('Tip') || 
        pickupDiente.includes('crafteo') || pickupDiente.includes('collar') || 
        pickupDiente.includes('veneno') || pickupDiente.includes('hilo')) {
      console.log('  ✅ DIS-1502 OK: tip de crafteo mostrado al recoger diente');
    } else {
      console.log('  ℹ️  Recogió diente pero no se vio tip (¿ya lo había recogido antes?)');
    }
  } else {
    console.log('  ℹ️  No hay diente afilado en este piso (aún no droppó)');
  }
  
  // ── SALA DE LOS ECOS ──
  cmd('east', 'SALA DE LOS ECOS'); // sala 3
  cmd('look');
  for (let i = 0; i < 4; i++) {
    const atkText = cmd('attack');
    if (atkText.includes('no hay') || atkText.includes('No hay')) break;
  }
  cmd('pickup');
  cmd('status');
  
  // ── CÁMARA DEL TESORO ──
  cmd('east', 'CÁMARA DEL TESORO'); // sala 4
  cmd('look');
  
  // ── TEST DIS-1501: Aldric nota al guardia muerto ──
  console.log('\n━━━ TEST DIS-1501: Aldric reacciona cuando matás al esqueleto guardia ━━━');
  let aldricReacted = false;
  for (let i = 0; i < 6; i++) {
    const atkText = cmd('attack esqueleto guerrero');
    if (atkText.toLowerCase().includes('aldric') && (atkText.includes('nota') || atkText.includes('veo') || atkText.includes('mira') || atkText.includes('Veo') || atkText.includes('Eficiente') || atkText.includes('ocupaste') || atkText.includes('guardia'))) {
      console.log('  ✅ DIS-1501 OK: Aldric comentó sobre el guardia muerto');
      console.log('  MSG:', atkText.substring(0, 300));
      aldricReacted = true;
      break;
    }
    if (atkText.includes('no hay') || atkText.includes('No ves') || atkText.includes('no encontrás')) {
      console.log('  ℹ️  Esqueleto Guerrero no disponible (ya muerto o no presente)');
      break;
    }
    if (atkText.includes('Muerto') || atkText.includes('derrotado') || atkText.includes('caído')) {
      // Monstruo acabado de morir
      if (atkText.toLowerCase().includes('aldric')) {
        console.log('  ✅ DIS-1501 OK: Aldric comentó en la muerte del guardia');
        console.log('  MSG:', atkText.substring(0, 300));
        aldricReacted = true;
      }
      break;
    }
  }
  if (!aldricReacted) {
    const lookAfter = cmd('look');
    if (lookAfter.toLowerCase().includes('aldric')) {
      console.log('  ℹ️  Aldric está en la sala, revisar si el esqueleto existía');
    }
    observations.push('DIS-1501: verificar manualmente que Aldric reacciona al esqueleto muerto');
  }
  
  // Comprar en Aldric
  cmd('hablar aldric');
  cmd('comprar pocion de vida');
  
  // ── TEST DIS-1504: Advertencia preventiva de boss ──
  console.log('\n━━━ TEST DIS-1504: Advertencia preventiva al entrar sala de boss ━━━');
  const statusText = cmd('status');
  // La Prisión Subterránea (sala 8) tiene Guardia Espectral L4
  // Ruta: sala 4 → west (sala 3) → north ?? Necesitamos ver el mapa
  // O desde sala 2: ir a salas de boss
  cmd('west'); // sala 3
  cmd('look'); // ver salidas
  cmd('west'); // sala 2 de vuelta
  cmd('look');
  // Desde el Corredor intentar north o sur a sala 8
  const northFromCorredor = cmd('north'); // ¿sala 8?
  if (northFromCorredor.includes('⚠') || northFromCorredor.includes('peligroso') || 
      northFromCorredor.includes('recomendado') || northFromCorredor.includes('nivel') && northFromCorredor.includes('bajo')) {
    console.log('  ✅ DIS-1504 OK: advertencia mostrada al intentar entrar a sala de boss');
    console.log('  MSG:', northFromCorredor.substring(0, 300));
  } else {
    // Probar second attempt (la segunda vez debe pasar)
    const north2 = cmd('north');
    if (north2.includes('⚠') || north2.includes('peligroso') || north2.includes('recomendado')) {
      console.log('  ✅ DIS-1504 OK: advertencia en segundo intento');
    } else {
      // Intentar desde sala 1 en dirección diferente
      cmd('south'); // sala 1
      cmd('south'); // sala tutorial?
      cmd('look');
      const testWarn = cmd('east'); // otro camino
      if (testWarn.includes('⚠') || testWarn.includes('recomendado') || testWarn.includes('peligroso')) {
        console.log('  ✅ DIS-1504 OK: advertencia encontrada');
      } else {
        console.log('  ℹ️  No se disparó advertencia de boss (nivel puede ser demasiado alto o ruta diferente)');
      }
    }
  }

  // ── EXPLORACIÓN ADICIONAL ──
  console.log('\n━━━ EXPLORACIÓN ADICIONAL - DETECCIÓN DE BUGS ━━━');
  
  // Probar lore/diario
  cmd('lore', 'DIARIO DE LORE');
  
  // Probar skills
  cmd('skills');
  
  // Probar inventario
  const inv = cmd('inventory');
  console.log('  INVENTARIO COMPLETO:', inv.substring(0, 500));
  
  // Probar craftear
  const craft = cmd('craftear');
  console.log('  CRAFTEO:', craft.substring(0, 300));
  
  // Probar Modo Berserk (DIS-1487 — sin doble confirmación)
  cmd('berserk');
  
  // Test event global
  cmd('eventos');
  
  // Probar comprar con/sin gold
  cmd('tienda');
  
  // Ir al Pozo (arañas - para hilo de seda)
  cmd('west'); // hacia sala 2
  cmd('west'); // hacia sala 1
  cmd('west'); // hacia sala de hongos?  
  cmd('look');
  cmd('south'); // intento Pozo Sin Fondo
  cmd('look');
  for (let i = 0; i < 5; i++) {
    const atkText = cmd('attack');
    if (atkText.includes('no hay') || atkText.includes('No hay')) break;
  }
  const pickupPozo = cmd('pickup');
  if (pickupPozo.includes('hilo') || pickupPozo.includes('seda')) {
    console.log('  ✅ Hilo de seda encontrado en Pozo');
    console.log('  PICKUP:', pickupPozo.substring(0, 300));
  }
  
  // Intentar craftear collar de garras si tenemos items
  cmd('craftear collar de garras');
  cmd('craftear veneno de colmillo');

  // ── ESTADO FINAL ──
  console.log('\n━━━ ESTADO FINAL ━━━');
  cmd('status');
  const finalInv = cmd('inventory');
  console.log('  INVENTARIO FINAL:', finalInv.substring(0, 500));

  // ── LIMPIEZA ──
  db.deletePlayer(pid);
  
  console.log('\n=== PLAYTEST COMPLETADO ===');
  process.exit(0);
}

const observations = [];

runPlaytest().catch(e => {
  console.error('ERROR en playtest:', e);
  process.exit(1);
});
