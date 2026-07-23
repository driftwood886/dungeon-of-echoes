/**
 * Bot de playtest — Dungeon of Echoes
 * Testea: mecánicas base, sistema de campaña, XP, combate, edge cases.
 */
const { io } = require('socket.io-client');

const URL = 'http://localhost:3000';
const BOT_NAME = 'playtest_bot_' + Math.floor(Math.random() * 9999);

const logs = [];

function log(msg) {
  console.log(msg);
  logs.push(msg);
}

const socket = io(URL, { transports: ['websocket'] });

socket.on('connect', () => {
  log(`[bot] Conectado: ${socket.id}, nombre: ${BOT_NAME}`);
  socket.emit('join', { username: BOT_NAME }, (ack) => {
    log(`[join] ${JSON.stringify(ack)}`);
    if (ack && ack.player_id) {
      startPlaytest().catch(e => { log('[error] ' + e); process.exit(1); });
    } else {
      log('[join] Error al unirse.');
      process.exit(1);
    }
  });
});

socket.on('event', (data) => {
  if (data && data.message) {
    log(`[evt] ${String(data.message).substring(0, 250)}`);
  }
});

function cmd(command) {
  return new Promise((resolve) => {
    socket.emit('command', { command }, (ack) => {
      const txt = ack ? (ack.text || ack.message || JSON.stringify(ack)) : '(sin ack)';
      log(`> ${command}\n  → ${String(txt).substring(0, 400)}`);
      resolve(ack);
    });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function startPlaytest() {
  log('\n=== INICIO PLAYTEST (CAMPAÑA) ===\n');

  // --- Estado inicial ---
  await cmd('mirar'); await sleep(200);
  await cmd('estado'); await sleep(200);
  await cmd('inventario'); await sleep(200);

  // --- Sistema de campaña ---
  await cmd('campaña'); await sleep(200);
  await cmd('campaña historia'); await sleep(200);

  // --- Exploración básica ---
  await cmd('norte'); await sleep(200);  // Entrada -> Corredor
  await cmd('mirar'); await sleep(200);
  await cmd('buscar'); await sleep(200);
  await cmd('norte'); await sleep(200);  // Hacia la Capilla?
  await cmd('mirar'); await sleep(200);
  await cmd('buscar'); await sleep(200);
  await cmd('tomar todo'); await sleep(200);
  await cmd('inventario'); await sleep(200);

  // --- Combate ---
  await cmd('atacar'); await sleep(200);
  await cmd('atacar'); await sleep(200);
  await cmd('atacar'); await sleep(200);
  await cmd('atacar'); await sleep(200);
  await cmd('saquear'); await sleep(200);
  await cmd('tomar todo'); await sleep(200);
  await cmd('inventario'); await sleep(200);

  // --- Volver al inicio, ir a la tienda ---
  await cmd('sur'); await sleep(200);
  await cmd('sur'); await sleep(200);
  await cmd('este'); await sleep(200);  // A la tienda
  await cmd('mirar'); await sleep(200);
  await cmd('tienda'); await sleep(200);

  // --- Hablar Anciano (campaña) ---
  await cmd('oeste'); await sleep(200);
  await cmd('sur'); await sleep(200);
  await cmd('mirar'); await sleep(200);
  await cmd('hablar anciano'); await sleep(200);

  // --- Campaña: más comandos ---
  await cmd('campaña'); await sleep(200);

  // --- Ir a la Capilla (sala 5) ---
  await cmd('norte'); await sleep(200);
  await cmd('norte'); await sleep(200);
  await cmd('norte'); await sleep(200);
  await cmd('norte'); await sleep(200);
  await cmd('mirar'); await sleep(200);
  await cmd('buscar'); await sleep(200);

  // Intentar usar fragmento de ritual si lo tenemos
  await cmd('usar fragmento de ritual'); await sleep(200);
  await cmd('usar fragmento'); await sleep(200);

  // --- Santuario Profano (sala 10) si se puede llegar ---
  await cmd('norte'); await sleep(200);
  await cmd('mirar'); await sleep(200);

  // --- XP y nivel ---
  await cmd('estado'); await sleep(200);
  await cmd('logros'); await sleep(200);
  await cmd('perfil'); await sleep(200);

  // --- World/mundo ---
  await cmd('mundo'); await sleep(200);
  await cmd('evento'); await sleep(200);

  // --- Quests ---
  await cmd('quest'); await sleep(200);
  await cmd('quests'); await sleep(200);

  // --- Facción ---
  await cmd('faccion'); await sleep(200);
  await cmd('facciones'); await sleep(200);

  // --- Mapa ---
  await cmd('mapa'); await sleep(200);

  // --- Ayuda ---
  await cmd('ayuda campaña'); await sleep(200);
  await cmd('ayuda'); await sleep(200);

  // --- Edge case: comandos inválidos ---
  await cmd('usar fragmento de ritual'); await sleep(200); // sin tenerlo
  await cmd('campaña contribuir'); await sleep(200);
  await cmd('xyzzy_inventado'); await sleep(200);

  // --- Ranking / who ---
  await cmd('quien'); await sleep(200);
  await cmd('leaderboard'); await sleep(200);
  await cmd('ranking'); await sleep(200);

  // --- Estado final ---
  await cmd('estado'); await sleep(200);

  log('\n=== FIN PLAYTEST ===\n');
  socket.disconnect();
  process.exit(0);
}

setTimeout(() => {
  log('[bot] Timeout de seguridad — saliendo.');
  socket.disconnect();
  process.exit(0);
}, 60000);
