/**
 * Bot de playtest automático para Dungeon of Echoes
 * Hace una partida completa testeando comandos principales
 */
const { io } = require('socket.io-client');

const URL = 'http://localhost:3000';
const PLAYER = { username: 'PlaytestBot', password: 'test123' };

const logs = [];
let currentState = null;

function log(msg) {
  console.log(msg);
  logs.push(msg);
}

const socket = io(URL, { transports: ['websocket'] });

socket.on('connect', () => {
  log(`[bot] Conectado: ${socket.id}`);
  // Unirse al juego
  socket.emit('join', PLAYER, (ack) => {
    log(`[join] ack: ${JSON.stringify(ack)}`);
    if (ack && ack.player_id) {
      log(`[join] player_id: ${ack.player_id}, username: ${ack.username}`);
      startPlaytest();
    } else {
      log('[join] Error al unirse. Abortando.');
      socket.disconnect();
      process.exit(1);
    }
  });
});

socket.on('event', (data) => {
  if (data && data.message) {
    log(`[evento] ${data.message.substring(0, 200)}`);
  }
});

socket.on('disconnect', () => {
  log('[bot] Desconectado.');
});

function cmd(command) {
  return new Promise((resolve) => {
    socket.emit('command', { command }, (ack) => {
      if (ack) {
        const txt = ack.text || ack.message || JSON.stringify(ack);
        log(`> ${command}\n  → ${txt.substring(0, 300)}`);
        resolve(ack);
      } else {
        log(`> ${command}\n  → (sin ack)`);
        resolve(null);
      }
    });
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function startPlaytest() {
  log('\n=== INICIO PLAYTEST ===\n');

  // 1. Ver estado inicial
  let r = await cmd('mirar');
  await sleep(300);

  // 2. Ver inventario y stats
  r = await cmd('inventario');
  await sleep(300);

  r = await cmd('stats');
  await sleep(300);

  // 3. Moverse (explorar)
  r = await cmd('norte');
  await sleep(300);

  r = await cmd('mirar');
  await sleep(300);

  // 4. Buscar ítems
  r = await cmd('buscar');
  await sleep(300);

  // 5. Explorar más salas
  r = await cmd('este');
  await sleep(300);

  r = await cmd('mirar');
  await sleep(300);

  r = await cmd('buscar');
  await sleep(300);

  // 6. Intentar tomar un ítem si hay loot
  r = await cmd('tomar todo');
  await sleep(300);

  // 7. Ver inventario de nuevo
  r = await cmd('inventario');
  await sleep(300);

  // 8. Equipar si hay algo
  r = await cmd('equipar');
  await sleep(300);

  // 9. Volver a explorar
  r = await cmd('sur');
  await sleep(300);

  r = await cmd('oeste');
  await sleep(300);

  // 10. Intentar combate (atacar si hay monstruo)
  r = await cmd('mirar');
  await sleep(300);

  r = await cmd('atacar');
  await sleep(300);

  r = await cmd('atacar');
  await sleep(300);

  r = await cmd('atacar');
  await sleep(300);

  // 11. Probar habilidades
  r = await cmd('habilidades');
  await sleep(300);

  // 12. Ver quests
  r = await cmd('quests');
  await sleep(300);

  // 13. Ver logros
  r = await cmd('logros');
  await sleep(300);

  // 14. Moverse al norte
  r = await cmd('norte');
  await sleep(300);

  r = await cmd('mirar');
  await sleep(300);

  // 15. Probar 'mapa'
  r = await cmd('mapa');
  await sleep(300);

  // 16. Ver ayuda
  r = await cmd('ayuda');
  await sleep(300);

  // 17. Probar vault (guardar/recuperar)
  r = await cmd('guardar');
  await sleep(300);

  // 18. Probar crafting
  r = await cmd('craftear');
  await sleep(300);

  // 19. Probar subastas
  r = await cmd('subastas');
  await sleep(300);

  // 20. Probar 'usar' ítem
  r = await cmd('usar poción');
  await sleep(300);

  // 21. Moverse más
  r = await cmd('sur');
  await sleep(300);

  r = await cmd('este');
  await sleep(300);

  r = await cmd('mirar');
  await sleep(300);

  // 22. Probar descanse
  r = await cmd('descansar');
  await sleep(300);

  // 23. Probar gritar
  r = await cmd('gritar ¡Playtest completado!');
  await sleep(300);

  // 24. Probar comando inválido
  r = await cmd('xyzzy');
  await sleep(300);

  // 25. Ver stats al final
  r = await cmd('stats');
  await sleep(300);

  log('\n=== FIN PLAYTEST ===\n');
  socket.disconnect();
  process.exit(0);
}

setTimeout(() => {
  log('[bot] Timeout de seguridad — saliendo.');
  socket.disconnect();
  process.exit(0);
}, 30000);
