/**
 * client/game.js — Cliente Dungeon of Echoes
 *
 * Cubre T029 (Socket.io, enviar comandos, renderizar respuestas)
 *       T030 (pantalla de login)
 *       T031 (historial scrolleable)
 *       T032 (panel lateral con HP, inventario, salidas)
 */

'use strict';

/* ── Estado local ─────────────────────────────────────────── */
const state = {
  playerId: null,
  username: null,
  socket: null,
  cmdHistory: [],       // historial de comandos del usuario
  historyIdx: -1,       // índice para navegación con ↑↓
  connected: false,
};

/* ── DOM helpers ──────────────────────────────────────────── */
const $  = (id) => document.getElementById(id);
const el = {
  loginScreen:    $('login-screen'),
  gameScreen:     $('game-screen'),
  usernameInput:  $('username-input'),
  loginBtn:       $('login-btn'),
  loginError:     $('login-error'),

  // Topbar
  headerUser:     $('header-user'),
  headerRoom:     $('header-room'),
  connStatus:     $('connection-status'),

  // Mensajes
  messagesList:   $('messages-list'),
  messagesScroll: $('messages-scroll'),

  // Input
  cmdInput:       $('cmd-input'),
  cmdBtn:         $('cmd-btn'),

  // Sidebar
  sidebarUsername: $('sidebar-username'),
  hpBarFill:      $('hp-bar-fill'),
  hpText:         $('hp-text'),
  statAtk:        $('stat-atk'),
  statDef:        $('stat-def'),
  statLevel:      $('stat-level'),
  statXp:         $('stat-xp'),
  statKills:      $('stat-kills'),
  statWeapon:     $('stat-weapon'),
  sidebarExits:   $('sidebar-exits'),
  sidebarMonsters:$('sidebar-monsters'),
  sidebarRoomItems:$('sidebar-room-items'),
  sidebarInventory:$('sidebar-inventory'),
};

/* ── Helpers de UI ────────────────────────────────────────── */
function ts() {
  const d = new Date();
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

/**
 * addMsg(text, type)
 * Agrega una línea al panel de mensajes y hace scroll al final.
 * Tipos: 'system' | 'response' | 'cmd' | 'event' | 'say' | 'shout' |
 *        'error' | 'combat' | 'loot' | 'separator'
 */
function addMsg(text, type = 'response') {
  if (!text) return;

  const lines = String(text).split('\n');
  lines.forEach((line, i) => {
    const div = document.createElement('div');
    div.className = `msg-line msg-${type}`;

    if (i === 0 && type !== 'separator') {
      const span = document.createElement('span');
      span.className = 'msg-ts';
      span.textContent = `[${ts()}]`;
      div.appendChild(span);
    }

    div.appendChild(document.createTextNode(line));
    el.messagesList.appendChild(div);
  });

  // Scroll al final
  el.messagesScroll.scrollTop = el.messagesScroll.scrollHeight;

  // Mantener max 500 líneas para no saturar el DOM
  while (el.messagesList.children.length > 500) {
    el.messagesList.removeChild(el.messagesList.firstChild);
  }
}

function addSeparator() {
  addMsg('─'.repeat(60), 'separator');
}

function setConnectionStatus(status) {
  const labels = {
    ok:   ['● CONECTADO',     'status-ok'],
    err:  ['● DESCONECTADO',  'status-err'],
    wait: ['● CONECTANDO...', 'status-wait'],
  };
  const [text, cls] = labels[status] || labels.wait;
  el.connStatus.textContent = text;
  el.connStatus.className = cls;
  state.connected = (status === 'ok');
}

/** Actualiza el panel lateral con datos de /api/state */
function updateSidebar(data) {
  if (!data) return;

  const { player, room } = data;

  // HP
  if (player) {
    el.sidebarUsername.textContent = player.username || state.username;
    const pct = player.max_hp > 0 ? (player.hp / player.max_hp) * 100 : 0;
    el.hpBarFill.style.width = `${pct}%`;
    el.hpBarFill.className = 'hp-bar-fill' + (pct <= 25 ? ' hp-low' : pct <= 50 ? ' hp-mid' : '');
    el.hpText.textContent = `${player.hp}/${player.max_hp}`;
    el.hpText.style.color = pct <= 25 ? 'var(--red)' : pct <= 50 ? 'var(--amber)' : 'var(--green)';
    el.statAtk.textContent = player.attack ?? '--';
    el.statDef.textContent = player.defense ?? '--';
    el.statLevel.textContent = player.level ?? '--';
    el.statXp.textContent   = player.xp ?? '--';
    el.statKills.textContent = player.kills ?? '--';
    el.statWeapon.textContent = player.equipped_weapon || 'puños';

    // Inventario
    const inv = player.inventory;
    el.sidebarInventory.textContent =
      Array.isArray(inv) && inv.length > 0
        ? inv.map(i => `· ${i}`).join('\n')
        : '(vacío)';
  }

  // Room
  if (room) {
    el.headerRoom.textContent = `📍 ${room.name}`;

    // Salidas
    const exits = Array.isArray(room.exits) ? room.exits : Object.keys(room.exits || {});
    el.sidebarExits.textContent = exits.length > 0
      ? exits.map(e => `→ ${e}`).join('\n')
      : '(ninguna)';

    // Monstruos
    const monsters = room.monsters || [];
    el.sidebarMonsters.textContent = monsters.length > 0
      ? monsters.map(m => `☠ ${m.name} (${m.hp}/${m.max_hp})`).join('\n')
      : '(ninguno)';

    // Ítems en suelo
    const items = Array.isArray(room.items) ? room.items : [];
    el.sidebarRoomItems.textContent = items.length > 0
      ? items.map(i => `◆ ${i}`).join('\n')
      : '(nada)';
  }
}

/** Obtiene el estado del servidor y actualiza el sidebar */
async function refreshState() {
  if (!state.playerId) return;
  try {
    const baseUrl = window.SERVER_URL || '';
    const resp = await fetch(`${baseUrl}/api/state/${state.playerId}`);
    if (!resp.ok) return;
    const data = await resp.json();
    updateSidebar(data);
  } catch (_) {
    // Silencioso: la conexión puede estar caída
  }
}

/* ── Inicializar Socket.io ────────────────────────────────── */
function initSocket() {
  setConnectionStatus('wait');
  addMsg('Conectando al servidor...', 'system');

  // Permite apuntar a un servidor externo (ej: Fly.io) via variable global
  // Para GitHub Pages: agregar <script>window.SERVER_URL='https://dungeon-of-echoes.fly.dev'</script>
  const serverUrl = window.SERVER_URL || window.location.origin;
  const socket = io(serverUrl, { transports: ['websocket', 'polling'] });
  state.socket = socket;

  socket.on('connect', () => {
    setConnectionStatus('ok');
    addMsg('Conexión establecida. Identificándose...', 'system');

    socket.emit('join', { username: state.username }, (res) => {
      if (res.error) {
        addMsg(`Error al unirse: ${res.error}`, 'error');
        return;
      }
      state.playerId = res.player_id;
      el.headerUser.textContent = `👤 ${res.username}`;
      addSeparator();
      addMsg(res.welcome, 'response');
      addSeparator();
      refreshState();
    });
  });

  socket.on('disconnect', () => {
    setConnectionStatus('err');
    addMsg('⚠ Desconectado del servidor. Intentando reconectar...', 'error');
  });

  socket.on('connect_error', () => {
    setConnectionStatus('err');
  });

  // Evento de broadcast de la sala (alguien entró, salió, hizo algo)
  socket.on('event', (data) => {
    if (data.type === 'whisper') {
      addMsg(`🔇 ${data.message}`, 'whisper');
    } else if (data.type === 'tell') {
      addMsg(`📨 ${data.message}`, 'tell');
    } else if (data.type === 'offline_messages') {
      addSeparator();
      addMsg(data.message, 'tell');
      addSeparator();
    } else {
      const type = data.type === 'player_join' || data.type === 'player_leave'
        ? 'system'
        : 'event';
      addMsg(`⟨ ${data.message} ⟩`, type);
    }
  });

  // Chat local
  socket.on('say', (data) => {
    addMsg(`${data.username} dice: "${data.message}"`, 'say');
  });

  // Grito global
  socket.on('shout', (data) => {
    addMsg(`[GRITO] ${data.username}: "${data.message}"`, 'shout');
  });
}

/* ── Enviar comando ───────────────────────────────────────── */
function sendCommand(rawCmd) {
  const cmd = rawCmd.trim();
  if (!cmd) return;

  // Guardar en historial
  if (state.cmdHistory[0] !== cmd) {
    state.cmdHistory.unshift(cmd);
    if (state.cmdHistory.length > 50) state.cmdHistory.pop();
  }
  state.historyIdx = -1;

  addMsg(`> ${cmd}`, 'cmd');

  if (!state.connected || !state.socket) {
    addMsg('Sin conexión al servidor.', 'error');
    return;
  }

  // Comando especial: help
  if (cmd === 'help' || cmd === 'ayuda') {
    addMsg(
      'COMANDOS DISPONIBLES:\n' +
      '  look / mirar          — Ver la habitación actual\n' +
      '  move <dir>            — Moverse (north/south/east/west o n/s/e/w)\n' +
      '  attack <monstruo>     — Atacar un monstruo\n' +
      '  flee / huir           — Huir del combate\n' +
      '  pick <ítem>           — Recoger un ítem del suelo\n' +
      '  use <ítem>            — Usar un ítem del inventario\n' +
      '  inventory / inv       — Ver inventario\n' +
      '  status / estado       — Ver tus estadísticas\n' +
      '  say <mensaje>         — Hablar a los jugadores de tu sala\n' +
      '  shout <mensaje>       — Gritar a todos los jugadores',
      'system'
    );
    return;
  }

  // Comandos especiales de chat: van por su propio evento Socket.io
  const sayMatch   = cmd.match(/^(?:say|decir|hablar)\s+(.+)/i);
  const shoutMatch = cmd.match(/^(?:shout|gritar|grito)\s+(.+)/i);

  if (sayMatch) {
    state.socket.emit('say', { message: sayMatch[1] }, (res) => {
      if (res && res.error) addMsg(res.error, 'error');
    });
    return;
  }

  if (shoutMatch) {
    state.socket.emit('shout', { message: shoutMatch[1] }, (res) => {
      if (res && res.error) addMsg(res.error, 'error');
    });
    return;
  }

  state.socket.emit('command', { command: cmd }, (res) => {
    if (res.error) {
      addMsg(res.error, 'error');
    } else {
      // Detectar tipo de mensaje por contenido para colorear
      const text = res.result;
      let type = 'response';
      if (/atac|golpe|daño|muere|muri|huye|combat/i.test(text)) type = 'combat';
      else if (/obtuviste|recoges|loot|encontraste/i.test(text)) type = 'loot';
      addMsg(text, type);
    }
    // Refrescar sidebar luego de cada comando
    refreshState();
  });
}

/* ── Event listeners ──────────────────────────────────────── */

// Login
el.loginBtn.addEventListener('click', doLogin);
el.usernameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doLogin();
});

function doLogin() {
  const username = el.usernameInput.value.trim();
  if (!username) {
    el.loginError.textContent = 'Por favor ingresá un nombre.';
    el.loginError.classList.remove('hidden');
    return;
  }
  if (!/^[a-zA-Z0-9_áéíóúÁÉÍÓÚñÑ\- ]{1,20}$/.test(username)) {
    el.loginError.textContent = 'Solo letras, números, guiones y espacios (max 20 caracteres).';
    el.loginError.classList.remove('hidden');
    return;
  }

  el.loginError.classList.add('hidden');
  state.username = username;

  // Mostrar pantalla de juego
  el.loginScreen.classList.add('hidden');
  el.gameScreen.classList.remove('hidden');

  // Foco en el input de comandos
  el.cmdInput.focus();

  // Inicializar socket
  initSocket();
}

// Enviar comando con botón o Enter
el.cmdBtn.addEventListener('click', () => {
  sendCommand(el.cmdInput.value);
  el.cmdInput.value = '';
});

el.cmdInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    sendCommand(el.cmdInput.value);
    el.cmdInput.value = '';
  } else if (e.key === 'ArrowUp') {
    // Navegar historial hacia atrás
    if (state.historyIdx < state.cmdHistory.length - 1) {
      state.historyIdx++;
      el.cmdInput.value = state.cmdHistory[state.historyIdx];
      // Mover cursor al final
      setTimeout(() => el.cmdInput.setSelectionRange(9999, 9999), 0);
    }
    e.preventDefault();
  } else if (e.key === 'ArrowDown') {
    // Navegar historial hacia adelante
    if (state.historyIdx > 0) {
      state.historyIdx--;
      el.cmdInput.value = state.cmdHistory[state.historyIdx];
    } else {
      state.historyIdx = -1;
      el.cmdInput.value = '';
    }
    e.preventDefault();
  }
});

// Botones de comandos rápidos
document.querySelectorAll('.qcmd').forEach(btn => {
  btn.addEventListener('click', () => {
    sendCommand(btn.dataset.cmd);
    el.cmdInput.focus();
  });
});

// Refrescar estado cada 10 segundos (para actualizar HP de monstruos que regeneran, etc.)
setInterval(refreshState, 10_000);
