/**
 * client/game.js — Cliente Dungeon of Echoes
 *
 * Cubre T029 (Socket.io, enviar comandos, renderizar respuestas)
 *       T030 (pantalla de login)
 *       T031 (historial scrolleable)
 *       T032 (panel lateral con HP, inventario, salidas)
 */

'use strict';

/* ── Sistema de rareza de ítems (T134) ───────────────────── */
const ITEM_RARITY_MAP = {
  'grimorio del abismo': 'legendario', 'daga del vacío': 'legendario',
  'espada de obsidiana': 'épico', 'lanza espectral': 'épico',
  'lanza espectral del eco': 'épico', 'filacteria rota': 'épico',
  'espada envenenada': 'épico', 'alabarda de huesos': 'épico',
  'hacha de guerra': 'épico',
  'cuchillo envenenado': 'raro', 'látigo de garras': 'raro',
  'poción de poder': 'raro', 'poción de maná mayor': 'raro', 'poción de vida': 'raro',
  'cristal resonante': 'raro', 'fragmento de vacío': 'raro', 'esencia del abismo': 'raro',
  'esencia de eco': 'raro', 'esencia de sombra': 'raro', 'perla negra': 'raro',
  'tomo sellado': 'raro', 'collar de garras': 'raro', 'amuleto del eco': 'raro',
  'llave maestra': 'raro', 'llave oxidada': 'raro', 'corona rota': 'raro',
  'escudo de gladiador': 'raro', 'grimorio élfico': 'raro',
};
const RARITY_COLORS = { 'común': '#c0c0c0', 'raro': '#4a9eff', 'épico': '#b044e0', 'legendario': '#ffd700' };
const RARITY_EMOJIS = { 'común': '⬜', 'raro': '🔵', 'épico': '🟣', 'legendario': '🟡' };
function getItemRarity(name) {
  return ITEM_RARITY_MAP[(name || '').toLowerCase().trim()] || 'común';
}

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
  pendingMsgRow:   $('pending-msg-row'),
  statPendingMsgs: $('stat-pending-msgs'),
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
 *        'error' | 'combat' | 'loot' | 'separator' | 'whisper' | 'tell'
 */
function addMsg(text, type = 'response') {
  if (!text) return;

  const lines = String(text).split('\n');
  let firstDiv = null;
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
    if (i === 0) firstDiv = div;
  });

  // Para mensajes privados: animación de parpadeo en el elemento
  if ((type === 'whisper' || type === 'tell') && firstDiv) {
    firstDiv.classList.add('msg-flash');
    // Flash en el title del documento si la ventana no tiene foco
    flashTitle(type === 'tell' ? '📨 Mensaje' : '🔇 Susurro');
  }

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

/* ── Flash de título ──────────────────────────────────────── */
const _origTitle = document.title;
let _flashInterval = null;

function flashTitle(label) {
  // Si el documento tiene foco, no flashear
  if (document.hasFocus()) return;

  // Limpiar flash previo
  if (_flashInterval) clearInterval(_flashInterval);

  let toggle = true;
  _flashInterval = setInterval(() => {
    document.title = toggle ? `[ ${label} ] ${_origTitle}` : _origTitle;
    toggle = !toggle;
  }, 700);

  // Volver al título original cuando se recupera el foco
  function onFocus() {
    clearInterval(_flashInterval);
    _flashInterval = null;
    document.title = _origTitle;
    window.removeEventListener('focus', onFocus);
  }
  window.addEventListener('focus', onFocus);
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

    // T152: Mostrar armadura en sidebar
    const armorEl = document.getElementById('stat-armor');
    if (armorEl) {
      armorEl.textContent = player.equipped_armor ? `🛡 ${player.equipped_armor}` : '(sin armadura)';
    }

    // Mostrar oro en sidebar
    const goldEl = document.getElementById('stat-gold');
    if (goldEl) goldEl.textContent = `💰 ${player.gold || 0}g`;

    // T107: Mostrar clase en sidebar
    const classEl = document.getElementById('stat-class');
    if (classEl) {
      const cls = player.player_class || 'sin_clase';
      const clsNames = { guerrero: '⚔️ Guerrero', mago: '🔮 Mago', picaro: '🗡️ Pícaro' };
      classEl.textContent = clsNames[cls] || 'sin clase';
    }

    // T104: Mostrar maná en sidebar
    const mana = player.mana != null ? player.mana : 20;
    const maxMana = player.max_mana || 20;
    const manaBarFill = document.getElementById('mana-bar-fill');
    const manaText = document.getElementById('mana-text');
    const shieldRow = document.getElementById('shield-active-row');
    if (manaBarFill && manaText) {
      const manaPct = maxMana > 0 ? (mana / maxMana) * 100 : 0;
      manaBarFill.style.width = `${manaPct}%`;
      manaText.textContent = `${mana}/${maxMana}`;
    }
    if (shieldRow) {
      shieldRow.style.display = player.shield_active ? '' : 'none';
    }

    // Mensajes offline pendientes
    const pendingCount = player.pending_messages || 0;
    if (pendingCount > 0) {
      el.statPendingMsgs.textContent = `${pendingCount} mensaje(s) sin leer`;
      el.pendingMsgRow.style.display = '';
    } else {
      el.pendingMsgRow.style.display = 'none';
    }

    // Logros desbloqueados
    const achEl = document.getElementById('stat-achievements');
    if (achEl) {
      const achieved = player.achievements || [];
      achEl.textContent = achieved.length > 0 ? achieved.map(id => {
        // Mapa id → icono (hardcoded en cliente para no necesitar otro request)
        const icons = {
          primer_kill: '🗡️', diez_kills: '⚔️', cien_kills: '💀',
          nivel_5: '🌟', nivel_10: '🏆', boss_killer: '👑',
          rico: '💰', sobrevivir_veneno: '🧪', muerto_3veces: '🪦',
          comerciante: '🛒',
        };
        return icons[id] || '🏅';
      }).join(' ') : '—';
    }

    // Efectos de estado (veneno, etc.)
    const statusSection = document.getElementById('status-effects-section');
    const statusContent = document.getElementById('sidebar-status-effects');
    if (statusSection && statusContent) {
      const fx = player.status_effects || {};
      const effectLines = [];
      if (fx.poisoned) {
        effectLines.push(`☠ ENVENENADO — ${fx.poisoned.turns} turno(s), ${fx.poisoned.damage} dmg/turno`);
      }
      if (fx.webbed) {
        effectLines.push(`🕸 ENREDADO — ${fx.webbed.turns} turno(s) sin atacar`);
      }
      if (fx.blinded) {
        effectLines.push(`🌑 CEGADO — ${fx.blinded.turns} turno(s), -${fx.blinded.amount} DEF`);
      }
      if (effectLines.length > 0) {
        statusContent.textContent = effectLines.join(' | ');
        statusSection.style.display = '';
      } else {
        statusSection.style.display = 'none';
      }
    }

    // Inventario
    const inv = player.inventory;
    if (Array.isArray(inv) && inv.length > 0) {
      el.sidebarInventory.innerHTML = inv.map(item => {
        const rarity = getItemRarity(item);
        const color = RARITY_COLORS[rarity] || '#c0c0c0';
        const emoji = RARITY_EMOJIS[rarity] || '⬜';
        return `<span style="color:${color}">${emoji} ${item}</span>`;
      }).join('\n');
    } else {
      el.sidebarInventory.textContent = '(vacío)';
    }
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

    // Trampa activa
    const trapSection = document.getElementById('trap-section');
    const sidebarTrap = document.getElementById('sidebar-trap');
    if (trapSection && sidebarTrap) {
      if (room.trap && room.trap.active) {
        const trapTypeNames = { spike: 'pinchos 🗡️', poison: 'esporas venenosas ☣️', cold: 'frío sobrenatural ❄️', flood: 'inundación 💧' };
        const typeName = trapTypeNames[room.trap.type] || room.trap.type;
        sidebarTrap.textContent = `Tipo: ${typeName}`;
        trapSection.style.display = '';
      } else {
        trapSection.style.display = 'none';
      }
    }
  }

  // Panel de grupo (T102)
  const partySection = document.getElementById('party-section');
  const partyContent = document.getElementById('sidebar-party');
  if (partySection && partyContent) {
    const partyMembers = data.party;
    if (partyMembers && partyMembers.length > 0) {
      partyContent.textContent = partyMembers
        .map(m => `  ${m.username} Lv${m.level} ❤${m.hp}/${m.max_hp}`)
        .join('\n');
      partySection.style.display = '';
    } else {
      partySection.style.display = 'none';
    }
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
    } else if (data.type === 'guild_chat') {
      addMsg(`🛡 ${data.message}`, 'guild_chat');
    } else if (data.type === 'duel_challenge') {
      addMsg(`⚔️ ${data.message}`, 'duel_challenge');
    } else if (data.type === 'duel_result') {
      addSeparator();
      addMsg(data.message, 'duel_result');
      addSeparator();
    } else if (data.type === 'duel_declined') {
      addMsg(`🚫 ${data.message}`, 'system');
    } else if (data.type === 'trade_offer') {
      addSeparator();
      addMsg(`⚖️ ${data.message}`, 'duel_challenge');
      addSeparator();
    } else if (data.type === 'trade_accepted') {
      addMsg(`✅ ${data.message}`, 'system');
    } else if (data.type === 'trade_declined') {
      addMsg(`🚫 ${data.message}`, 'system');
    } else if (data.type === 'sacred_regen') {
      addMsg(data.message, 'system');
    } else if (data.type === 'session_summary') {
      addSeparator();
      addMsg(data.message, 'system');
      addSeparator();
    } else if (data.type === 'offline_messages') {
      addSeparator();
      addMsg(data.message, 'tell');
      addSeparator();
      // Los mensajes se marcaron como entregados — ocultar el badge del sidebar
      if (el.pendingMsgRow) el.pendingMsgRow.style.display = 'none';
    } else {
      const type = data.type === 'player_join' || data.type === 'player_leave'
        ? 'system'
        : 'event';
      addMsg(`⟨ ${data.message} ⟩`, type);
    }
  });

  // Chat local
  socket.on('say', (data) => {
    const nameColor = data.name_color ? ` style="color:${data.name_color}"` : '';
    const nameHtml = `<span${nameColor}>${data.username}</span>`;
    const div = document.createElement('div');
    div.className = 'msg-line msg-say';
    const tsSpan = document.createElement('span');
    tsSpan.className = 'msg-ts';
    tsSpan.textContent = `[${ts()}]`;
    div.appendChild(tsSpan);
    div.innerHTML += `${nameHtml} dice: "${data.message}"`;
    el.messagesList.appendChild(div);
    el.messagesScroll.scrollTop = el.messagesScroll.scrollHeight;
  });

  // Grito global
  socket.on('shout', (data) => {
    const nameColor = data.name_color ? ` style="color:${data.name_color}"` : '';
    const nameHtml = `<span${nameColor}>${data.username}</span>`;
    const div = document.createElement('div');
    div.className = 'msg-line msg-shout';
    const tsSpan = document.createElement('span');
    tsSpan.className = 'msg-ts';
    tsSpan.textContent = `[${ts()}]`;
    div.appendChild(tsSpan);
    div.innerHTML += `[GRITO] ${nameHtml}: "${data.message}"`;
    el.messagesList.appendChild(div);
    el.messagesScroll.scrollTop = el.messagesScroll.scrollHeight;
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

  // Comando especial: clear — limpiar el historial
  if (cmd === 'clear' || cmd === 'cls' || cmd === 'limpiar') {
    el.messagesList.innerHTML = '';
    addMsg('— Historial borrado —', 'system');
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
