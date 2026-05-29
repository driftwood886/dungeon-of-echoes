#!/usr/bin/env node
/**
 * llm_bot.js — Bot demo para Dungeon of Echoes
 *
 * Simula cómo una LLM (o cualquier cliente) puede jugar usando
 * exclusivamente la API REST:
 *
 *   1. POST /api/login  → obtener player_id
 *   2. GET  /api/state/:player_id  → leer estado del juego
 *   3. POST /api/action → ejecutar un comando
 *   4. Repetir 2-3
 *
 * El bot implementa una heurística simple sin LLM externo:
 *  - Si hay monstruos → atacar
 *  - Si HP < 40% y hay pociones → usar poción
 *  - Si hay ítems en el suelo → recoger
 *  - Si no hay nada → moverse en dirección aleatoria
 *
 * USO:
 *   node llm_bot.js [--url http://localhost:3000] [--username BotDemo] [--steps 20] [--delay 2000]
 *
 * SALIDA: logs legibles en consola con el estado y la decisión tomada.
 */

'use strict';

const http  = require('http');
const https = require('https');

/* ── Configuración via args ──────────────────────────────── */
const args = process.argv.slice(2);
function getArg(name, def) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
}

const BASE_URL  = getArg('--url',      'http://localhost:3000');
const USERNAME  = getArg('--username', `Bot_${Math.floor(Math.random() * 9000) + 1000}`);
const MAX_STEPS = parseInt(getArg('--steps',  '20'), 10);
const DELAY_MS  = parseInt(getArg('--delay',  '2000'), 10);

/* ── HTTP helper ─────────────────────────────────────────── */
function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const url    = new URL(path, BASE_URL);
    const lib    = url.protocol === 'https:' ? https : http;
    const data   = body ? JSON.stringify(body) : null;

    const options = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };

    const req = lib.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => (raw += chunk));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });

    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/* ── Lógica de decisión ──────────────────────────────────── */

/**
 * Elige el comando más inteligente dado el estado actual.
 * @param {object} state — Respuesta de /api/state o state dentro de /api/action
 * @returns {string} comando de texto
 */
function chooseAction(state) {
  const { player, room } = state;

  // 1. Emergencia de HP + hay pociones
  const hpPct = player.hp / player.max_hp;
  if (hpPct < 0.4) {
    const potion = (player.inventory || []).find(i =>
      /poci[oó]n|potion|salud|health/i.test(i)
    );
    if (potion) {
      return `use ${potion}`;
    }
  }

  // 2. Atacar monstruo si lo hay
  const monsters = room.monsters || [];
  if (monsters.length > 0) {
    const target = monsters[0];
    return `attack ${target.name}`;
  }

  // 3. Recoger ítem del suelo
  const floorItems = Array.isArray(room.items) ? room.items : [];
  if (floorItems.length > 0) {
    return `pick ${floorItems[0]}`;
  }

  // 4. Moverse en dirección aleatoria
  const exits = Array.isArray(room.exits) ? room.exits : Object.keys(room.exits || {});
  if (exits.length > 0) {
    const dir = exits[Math.floor(Math.random() * exits.length)];
    return `move ${dir}`;
  }

  // 5. Fallback
  return 'look';
}

/* ── Formateador de log ──────────────────────────────────── */
function logState(step, state, cmd, result) {
  const { player, room } = state;
  const hpBar = '█'.repeat(Math.round((player.hp / player.max_hp) * 10))
              + '░'.repeat(10 - Math.round((player.hp / player.max_hp) * 10));

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`PASO ${step}/${MAX_STEPS} · ${USERNAME}`);
  console.log(`${'─'.repeat(60)}`);
  console.log(`Ubicación : ${room.name}`);
  console.log(`HP        : [${hpBar}] ${player.hp}/${player.max_hp}`);
  console.log(`ATK/DEF   : ${player.attack} / ${player.defense}`);
  console.log(`Inventario: ${(player.inventory || []).join(', ') || '(vacío)'}`);
  console.log(`Salidas   : ${(Array.isArray(room.exits) ? room.exits : Object.keys(room.exits)).join(', ') || '(ninguna)'}`);
  console.log(`Monstruos : ${(room.monsters || []).map(m => `${m.name} (${m.hp}/${m.max_hp})`).join(', ') || '(ninguno)'}`);
  console.log(`Suelo     : ${(room.items || []).join(', ') || '(vacío)'}`);
  console.log(`\n→ Comando  : "${cmd}"`);
  console.log(`← Resultado: ${result}`);
}

/* ── Loop principal ──────────────────────────────────────── */
async function main() {
  console.log(`\n🤖 Dungeon of Echoes — LLM Bot Demo`);
  console.log(`   Servidor : ${BASE_URL}`);
  console.log(`   Username : ${USERNAME}`);
  console.log(`   Pasos    : ${MAX_STEPS}`);
  console.log(`   Delay    : ${DELAY_MS}ms entre pasos\n`);

  // 1. Login
  console.log('Iniciando sesión...');
  const loginRes = await request('POST', '/api/login', { username: USERNAME });
  if (loginRes.status !== 200) {
    console.error('Error en login:', loginRes.body);
    process.exit(1);
  }
  const { player_id } = loginRes.body;
  console.log(`Sesión iniciada. player_id: ${player_id}`);
  console.log(`Mensaje de bienvenida:\n${loginRes.body.welcome}\n`);

  // 2. Loop de juego
  for (let step = 1; step <= MAX_STEPS; step++) {
    // Obtener estado
    const stateRes = await request('GET', `/api/state/${player_id}`);
    if (stateRes.status !== 200) {
      console.error(`Error obteniendo estado en paso ${step}:`, stateRes.body);
      break;
    }
    const currentState = stateRes.body;

    // Elegir acción
    const cmd = chooseAction(currentState);

    // Ejecutar acción
    const actionRes = await request('POST', '/api/action', { player_id, command: cmd });
    const result = actionRes.body.result || JSON.stringify(actionRes.body);

    // Loggear
    logState(step, currentState, cmd, result);

    // Parar si el jugador murió
    const updatedPlayer = actionRes.body.state?.player;
    if (updatedPlayer && updatedPlayer.hp <= 0) {
      console.log('\n💀 El bot murió. Fin del demo.');
      break;
    }

    // Esperar antes del siguiente paso
    if (step < MAX_STEPS) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🏁 Bot demo finalizado tras ${MAX_STEPS} pasos.`);
  console.log(`${'═'.repeat(60)}\n`);
}

main().catch(err => {
  console.error('Error fatal en bot:', err);
  process.exit(1);
});
