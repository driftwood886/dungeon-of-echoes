// Playtest de bugs — 2026-07-02
// Bot que explora el dungeon buscando bugs y problemas de diseño

const http = require('http');

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: 'localhost', port: 3000, path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };
    const req = http.request(opts, res => {
      let s = '';
      res.on('data', c => s += c);
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch(e) { resolve({text: s}); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:3000${path}`, res => {
      let s = '';
      res.on('data', c => s += c);
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch(e) { resolve({text: s}); } });
    }).on('error', reject);
  });
}

async function cmd(pid, command) {
  const r = await post('/api/action', { player_id: pid, command });
  return r.text || r.result || JSON.stringify(r);
}

async function getState(pid) {
  return get(`/api/state/${pid}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const bugs = [];
const observations = [];

function bug(desc) {
  console.log(`🐛 BUG: ${desc}`);
  bugs.push(desc);
}

function obs(desc) {
  console.log(`📝 OBS: ${desc}`);
  observations.push(desc);
}

async function main() {
  const username = `bot_playtest_${Date.now()}`;
  const login = await post('/api/login', { username });
  const pid = login.player_id;
  console.log(`\n=== PLAYTEST DE BUGS — 2026-07-02 ===`);
  console.log(`Username: ${username}, PID: ${pid}\n`);

  let r, state;

  // ── TUTORIAL ─────────────────────────────────────────────────
  console.log('\n--- TUTORIAL ---');
  
  // Elegir clase Guerrero
  r = await cmd(pid, 'clase guerrero');
  console.log(`clase guerrero: ${r.substring(0, 100)}`);

  // Completar tutorial: atacar goblin de práctica
  for (let i = 0; i < 10; i++) {
    r = await cmd(pid, 'attack');
    if (r.includes('Tutorial completado') || r.includes('tutorial completado')) {
      console.log('✅ Tutorial completado');
      break;
    }
    if (r.includes('No hay')) break;
  }

  // Bajar al dungeon
  r = await cmd(pid, 'south');
  state = await getState(pid);
  console.log(`Sala inicial: ${state.player?.current_room_id}`);

  // ── SALA 1: ENTRADA ──────────────────────────────────────────
  console.log('\n--- SALA 1: Entrada ---');
  r = await cmd(pid, 'look');
  console.log(`Look sala 1: ${r.substring(0, 200)}`);

  // Probar comando "ayuda" y "help basico"
  r = await cmd(pid, 'help basico');
  const hasHelpBasico = r.length > 50;
  if (!hasHelpBasico) bug('help basico no devuelve contenido útil');
  else obs(`help basico: OK (${r.length} chars)`);

  // Atacar goblins
  for (let i = 0; i < 6; i++) {
    r = await cmd(pid, 'attack');
    if (r.includes('No hay enemigos') || r.includes('muere')) {
      console.log(`Combate sala 1 terminó en turno ${i+1}`);
      break;
    }
  }

  // Forage en sala 1
  r = await cmd(pid, 'forage');
  console.log(`forage sala 1: ${r.substring(0, 100)}`);

  // Status inicial
  state = await getState(pid);
  const initHP = state.player?.hp;
  const initMaxHP = state.player?.max_hp;
  const initGold = state.player?.gold;
  console.log(`Estado: HP ${initHP}/${initMaxHP}, Gold ${initGold}`);

  // ── SALA 2: CORREDOR ─────────────────────────────────────────
  console.log('\n--- Moverse a Sala 2 ---');
  r = await cmd(pid, 'east');
  state = await getState(pid);
  console.log(`Sala: ${state.player?.current_room_id}`);

  r = await cmd(pid, 'look');
  // Verificar que el look tenga salidas
  if (!r.includes('Salidas') && !r.includes('alida')) {
    bug('look no muestra Salidas en sala 2');
  }

  for (let i = 0; i < 5; i++) {
    r = await cmd(pid, 'attack');
    if (r.includes('No hay') || r.includes('muere')) break;
  }

  // ── SALA 3: CORREDOR DE SOMBRAS ──────────────────────────────
  console.log('\n--- Sala 3 ---');
  r = await cmd(pid, 'east');
  state = await getState(pid);
  console.log(`Sala: ${state.player?.current_room_id}`);

  // Probar "examinar" en sala 3
  r = await cmd(pid, 'examine');
  console.log(`examine: ${r.substring(0, 100)}`);

  for (let i = 0; i < 5; i++) {
    r = await cmd(pid, 'attack');
    if (r.includes('No hay') || r.includes('muere')) break;
  }

  // ── SALA 4: TIENDA DE ALDRIC ─────────────────────────────────
  console.log('\n--- Sala 4: Tienda ---');
  r = await cmd(pid, 'south');
  state = await getState(pid);
  console.log(`Sala: ${state.player?.current_room_id}`);

  r = await cmd(pid, 'tienda');
  console.log(`tienda: ${r.substring(0, 200)}`);

  // Intentar comprar
  r = await cmd(pid, 'buy pocion');
  console.log(`buy pocion: ${r.substring(0, 100)}`);

  // ── SALA 5: CAPILLA ──────────────────────────────────────────
  console.log('\n--- Sala 5: Capilla ---');
  r = await cmd(pid, 'north');
  state = await getState(pid);
  console.log(`Sala: ${state.player?.current_room_id}`);

  r = await cmd(pid, 'look');
  // Verificar presencia del murciélago
  const hasBat = r.includes('Murciélago') || r.includes('murci');
  console.log(`Murciélago en Capilla: ${hasBat}`);

  // Probar forage con monstruo presente
  r = await cmd(pid, 'forage');
  console.log(`forage con monstruo: ${r.substring(0, 100)}`);

  // Atacar murciélago
  for (let i = 0; i < 8; i++) {
    r = await cmd(pid, 'attack');
    if (r.includes('No hay') || r.includes('muere')) {
      console.log(`Murciélago muerto en turno ${i+1}`);
      break;
    }
  }

  // ── SALA 6: TÚNEL DE HONGOS ──────────────────────────────────
  console.log('\n--- Sala 6: Túnel de Hongos ---');
  r = await cmd(pid, 'north');
  state = await getState(pid);
  const hpBeforeTunnel = state.player?.hp;
  console.log(`Sala: ${state.player?.current_room_id}, HP: ${hpBeforeTunnel}`);
  r = await cmd(pid, 'look');
  console.log(`look túnel hongos: ${r.substring(0, 200)}`);

  // Probar "pick" en sala 6 (hongos azules DIS-1105)
  r = await cmd(pid, 'pick hongo');
  console.log(`pick hongo: ${r.substring(0, 100)}`);

  for (let i = 0; i < 5; i++) {
    r = await cmd(pid, 'attack');
    if (r.includes('No hay') || r.includes('muere')) break;
  }

  state = await getState(pid);
  console.log(`HP después de Túnel: ${state.player?.hp}/${state.player?.max_hp}`);

  // ── SALA 9: SALA DEL TRONO ───────────────────────────────────
  console.log('\n--- Sala 9: Sala del Trono ---');
  r = await cmd(pid, 'north');
  state = await getState(pid);
  console.log(`Sala: ${state.player?.current_room_id}`);

  r = await cmd(pid, 'look');
  console.log(`look sala 9: ${r.substring(0, 200)}`);

  // Ver inventario actual
  r = await cmd(pid, 'inventory');
  console.log(`inventario: ${r.substring(0, 200)}`);

  // Probar "status" — verificar que muestra clase, stats correctamente
  r = await cmd(pid, 'status');
  if (!r.includes('HP') || !r.includes('nivel') && !r.includes('Nivel')) {
    bug('status no muestra HP o nivel correctamente');
  } else {
    obs('status: OK');
  }
  console.log(`status: ${r.substring(0, 200)}`);

  // Combate en sala 9
  for (let i = 0; i < 6; i++) {
    r = await cmd(pid, 'attack');
    if (r.includes('No hay') || r.includes('muere')) break;
  }

  // ── SALA 10: SANTUARIO ───────────────────────────────────────
  console.log('\n--- Sala 10: Santuario ---');
  r = await cmd(pid, 'east');
  state = await getState(pid);
  console.log(`Sala: ${state.player?.current_room_id}`);

  r = await cmd(pid, 'look');
  console.log(`look santuario: ${r.substring(0, 200)}`);

  // ── SISTEMA DE SUBASTAS ─────────────────────────────────────
  console.log('\n--- Test: Subastas ---');
  // Probar desde sala 10: ir a la Casa de Subastas (sala 7)
  r = await cmd(pid, 'ruta 7');
  console.log(`ruta a sala 7: ${r.substring(0, 200)}`);

  // Probar comando subastas (nuevo — DIS-1124)
  r = await cmd(pid, 'subastas');
  console.log(`subastas: ${r.substring(0, 150)}`);
  if (r.includes('desconocido') || r.includes('Desconocido')) {
    bug('Comando "subastas" devuelve "Comando desconocido" — fix DIS-1124 no implementado');
  } else {
    obs(`Comando subastas funciona: ${r.substring(0, 80)}`);
  }

  // También probar "pujas"
  r = await cmd(pid, 'pujas');
  console.log(`pujas: ${r.substring(0, 100)}`);
  if (r.includes('desconocido') || r.includes('Desconocido')) {
    bug('Comando "pujas" devuelve "Comando desconocido"');
  }

  // ── DESAFÍOS DIARIOS ────────────────────────────────────────
  console.log('\n--- Test: Desafíos ---');
  r = await cmd(pid, 'desafios');
  console.log(`desafios: ${r.substring(0, 300)}`);

  // ── SISTEMA DE MASCOTA ──────────────────────────────────────
  console.log('\n--- Test: Mascota (pet) ---');
  r = await cmd(pid, 'pet');
  console.log(`pet: ${r.substring(0, 200)}`);

  // ── SISTEMA DE RUNAS ────────────────────────────────────────
  console.log('\n--- Test: Runas ---');
  r = await cmd(pid, 'runas');
  console.log(`runas: ${r.substring(0, 200)}`);

  r = await cmd(pid, 'runes');
  console.log(`runes: ${r.substring(0, 100)}`);

  // ── HABILIDADES ─────────────────────────────────────────────
  console.log('\n--- Test: Skills ---');
  r = await cmd(pid, 'skills');
  console.log(`skills: ${r.substring(0, 200)}`);

  // ── CRAFTING ────────────────────────────────────────────────
  console.log('\n--- Test: Crafting ---');
  r = await cmd(pid, 'craft list');
  console.log(`craft list: ${r.substring(0, 200)}`);

  // ── COMANDOS DE MOVIMIENTO AVANZADOS ────────────────────────
  console.log('\n--- Test: Comandos Adicionales ---');

  // Probar "map"
  r = await cmd(pid, 'map');
  console.log(`map: ${r.substring(0, 200)}`);

  // Probar "ruta" a sala inválida
  r = await cmd(pid, 'ruta 999');
  console.log(`ruta 999 (inválida): ${r.substring(0, 100)}`);

  // ── GUILD QUESTS ────────────────────────────────────────────
  console.log('\n--- Test: Guild Quests ---');
  r = await cmd(pid, 'gremio');
  console.log(`gremio: ${r.substring(0, 200)}`);

  // ── VERIFICAR ESTADO FINAL ──────────────────────────────────
  console.log('\n--- Estado Final ---');
  state = await getState(pid);
  const finalHP = state.player?.hp;
  const finalMaxHP = state.player?.max_hp;
  const finalGold = state.player?.gold;
  const finalLevel = state.player?.level;
  const finalRoom = state.player?.current_room_id;
  console.log(`Room: ${finalRoom}, HP: ${finalHP}/${finalMaxHP}, Gold: ${finalGold}, Nivel: ${finalLevel}`);

  // Check: ¿HP ≤ 0 sin morir?
  if (finalHP <= 0) {
    bug(`HP llegó a ${finalHP} sin trigger de muerte (posible bug de estado)`);
  }

  // ── RESUMEN ──────────────────────────────────────────────────
  console.log('\n=== RESUMEN DEL PLAYTEST ===');
  console.log(`Bugs: ${bugs.length}`);
  bugs.forEach((b, i) => console.log(`  ${i+1}. ${b}`));
  console.log(`Observaciones: ${observations.length}`);
  observations.forEach((o, i) => console.log(`  ${i+1}. ${o}`));
  
  console.log('\n=== FIN DEL PLAYTEST ===');
  process.exit(0);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
