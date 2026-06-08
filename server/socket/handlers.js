/**
 * socket/handlers.js — Manejadores de eventos Socket.io
 *
 * Cubre T022 (join, disconnect, command), T023 (broadcast a habitación),
 * T024 (ver otros jugadores en look), T025 (say) y T026 (shout).
 *
 * Arquitectura:
 * - Cada socket se une a un "room" de Socket.io correspondiente a la
 *   habitación del dungeon (room_${roomId})
 * - Al ejecutar cualquier comando que produce un `event`, se hace broadcast
 *   a todos los sockets en esa habitación
 * - El comando `look` ya incluye otros jugadores presentes (via dungeon.js)
 */

'use strict';

const db     = require('../db/db');
const engine = require('../game/engine');

// Mapa global: playerId → socket (para enviar mensajes directos)
const playerSockets = new Map();
// T173: Exponer playerSockets globalmente para que engine.js pueda verificar online status
global.playerSocketsMap = playerSockets;

// T154: Mapa global: playerId → sala previa (para comando back)
const previousRoomMap = new Map();

// T155: Mapa global: playerId → datos de sesión
// { startTime, kills, xpStart, goldStart, commands }
const sessionDataMap = new Map();

// T204: Mapa global: followerId → targetPlayerId (seguir a otro jugador)
const followMap = new Map();

// T223: Map de tracking de monstruos — baseName → Set<playerId>
// Cuando un monstruo respawnea, se notifica a los jugadores que lo tienen trackeado.
const monsterTrackMap = new Map();

// T215: Buffer circular de mensajes de chat recientes (máx 50 entradas)
// Cada entrada: { ts, type, username, message }
const recentChatLog = [];
const RECENT_CHAT_MAX = 50;
function pushRecentChat(type, username, message) {
  const now = new Date();
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  recentChatLog.push({ ts: `${hh}:${mm}`, type, username, message });
  if (recentChatLog.length > RECENT_CHAT_MAX) recentChatLog.shift();
}
global.recentChatLog = recentChatLog;
global.pushRecentChat = pushRecentChat;

/**
 * @param {import('socket.io').Server} io
 */
function registerHandlers(io) {

  io.on('connection', (socket) => {
    console.log(`[socket] Conexión nueva: ${socket.id}`);

    let currentPlayerId = null;
    let currentRoomId   = null;

    // ── join ──────────────────────────────────────────────────────────────────
    // Evento inicial: el cliente envía su username para identificarse.
    // Respuesta: { player_id, username, welcome } o { error }
    socket.on('join', (data, ack) => {
      const { username } = data || {};
      if (!username || typeof username !== 'string' || !username.trim()) {
        return ack && ack({ error: 'Se requiere un username.' });
      }

      const player = engine.getOrCreatePlayer(username.trim().slice(0, 20));
      currentPlayerId = player.id;
      currentRoomId   = player.current_room_id;

      // Registrar socket del jugador para mensajes directos
      playerSockets.set(currentPlayerId, socket);

      // T155: Inicializar datos de sesión
      const freshPlayer = db.getPlayer(currentPlayerId);
      sessionDataMap.set(currentPlayerId, {
        startTime: Date.now(),
        kills: 0,
        xpStart: freshPlayer ? (freshPlayer.xp || 0) : 0,
        goldStart: freshPlayer ? (freshPlayer.gold || 0) : 0,
        commands: 0,
      });

      // Unirse al room de Socket.io de la habitación actual
      socket.join(`room_${currentRoomId}`);

      // Notificar a los demás jugadores de la sala
      socket.to(`room_${currentRoomId}`).emit('event', {
        type: 'player_join',
        message: `${player.username} entra a la sala.`,
      });

      // Auto-look al entrar
      const lookResult = engine.execute(player.id, 'look');

      // Si el jugador está en el tutorial, agregar mensaje introductorio
      let welcomeText = lookResult.text;
      if (player.tutorial_step && player.tutorial_step > 0) {
        const tutModule = require('../game/tutorial');
        welcomeText = tutModule.getStepMessage(1) + '\n\n' + lookResult.text;
      }

      // T106: Mensaje "bienvenida de regreso" si estuvo ausente más de 1 hora
      const lastSeen = player.last_seen ? new Date(player.last_seen).getTime() : 0;
      const absenceMs = Date.now() - lastSeen;
      const ONE_HOUR_MS = 60 * 60 * 1000;
      if (lastSeen > 0 && absenceMs > ONE_HOUR_MS) {
        const hoursAway = Math.floor(absenceMs / ONE_HOUR_MS);
        const minutesAway = Math.floor((absenceMs % ONE_HOUR_MS) / 60000);
        const absenceStr = hoursAway > 0
          ? `${hoursAway}h ${minutesAway}m`
          : `${minutesAway} minutos`;

        // Consultar eventos desde la última vez
        const lastSeenIso = new Date(lastSeen).toISOString().replace('T', ' ').split('.')[0];
        const killsSince = db.countKillsSince(lastSeenIso);
        const recentEvents = db.getGlobalEventsSince(lastSeenIso, 5);

        // Buscar si el boss fue derrotado
        const bossEvents = recentEvents.filter(e => e.type === 'boss');

        const returnLines = [
          `🏰 ¡Bienvenido de regreso, ${player.username}!`,
          `   Estuviste ausente ${absenceStr}.`,
        ];

        if (killsSince > 0) {
          returnLines.push(`   ⚔️  Durante tu ausencia hubo ${killsSince} enfrentamiento(s) en el dungeon.`);
        }

        if (bossEvents.length > 0) {
          returnLines.push(`   💀 ¡EL BOSS FUE DERROTADO mientras estabas fuera!`);
          returnLines.push(`      ${bossEvents[0].message}`);
        }

        if (recentEvents.length > 0) {
          returnLines.push(`   📜 Noticias recientes (crónica):`);
          recentEvents.slice(0, 3).forEach(ev => {
            returnLines.push(`      · ${ev.message}`);
          });
        } else {
          returnLines.push(`   📜 El dungeon estuvo tranquilo durante tu ausencia.`);
        }

        returnLines.push('');
        welcomeText = returnLines.join('\n') + '\n' + welcomeText;
      }

      // T118: Tip aleatorio al conectarse
      const TIPS = [
        '💡 Tip: escribí "changelog" o "novedades" para ver las últimas actualizaciones del juego.',
        '💡 Tip: usá "note add <texto>" para guardar apuntes personales mientras explorás.',
        '💡 Tip: atacá sin tilde — "attack golem" funciona igual que "attack gólem".',
        '💡 Tip: elegí una clase con "clase guerrero/mago/pícaro" para desbloquear bonuses únicos.',
        '💡 Tip: "forage" o "buscar" en una sala sin monstruos puede revelar ítems ocultos.',
        '💡 Tip: las habilidades activas se desbloquean al subir de nivel: smash (Lv3), bash (Lv6), rally (Lv10).',
        '💡 Tip: "craft <ítem1> con <ítem2>" combina ítems. Escribí "recetas" para ver las combinaciones.',
        '💡 Tip: el mercader Aldric (sala 4) compra y vende ítems. Usá "tienda" para ver su catálogo.',
        '💡 Tip: algunos NPCs tienen quests especiales. Intentá "hablar aldric" cuando tengas nivel 5+.',
        '💡 Tip: en "status" podés ver tu clase, título, oro y estado de veneno.',
        '💡 Tip: "world" muestra si hay un evento global activo (invasión, luna de sangre, niebla).',
        '💡 Tip: "rest" recupera HP si no hay monstruos en la sala. "meditar" da más HP si tenés mascota.',
        '💡 Tip: el Boss aparece en la sala 15. Su muerte da loot especial y broadcast global.',
      ];
      const tip = TIPS[Math.floor(Math.random() * TIPS.length)];
      welcomeText = welcomeText + '\n\n' + tip;

      // Entregar mensajes offline pendientes (tell)
      const pending = db.getPendingMessages(player.id);
      if (pending.length > 0) {
        db.markMessagesDelivered(player.id);
        // Se entregan vía ack para que el cliente los muestre al conectar
        const offlineLines = pending.map(
          m => `[tell offline de ${m.sender_username} (${m.created_at})]: "${m.message}"`
        );
        const offlineText = `📬 Tenés ${pending.length} mensaje(s) guardado(s):\n` + offlineLines.join('\n');
        // Se emite después del ack al mismo socket
        setImmediate(() => {
          socket.emit('event', { type: 'offline_messages', message: offlineText });
        });
      }

      console.log(`[socket] ${player.username} (${socket.id}) unido a sala ${currentRoomId}`);
      // T107: Si el jugador no tiene clase, agregar recordatorio al welcome
      const classReminder = engine.getClassReminder(player);
      // T141: Si hay desafío diario no completado, avisar
      const freshForChallenge = db.getPlayer(player.id);
      const dailyCh = freshForChallenge ? db.getDailyChallenge(freshForChallenge) : null;
      let challengeReminder = '';
      if (dailyCh && !dailyCh.done) {
        challengeReminder = `\n\n📅 Desafío del día: ${dailyCh.desc} (${dailyCh.progress || 0}/${dailyCh.goal}). Completalo para +30 XP, +20🪙 y +5 Rep.`;
      }
      const finalWelcomeText = (classReminder ? welcomeText + classReminder : welcomeText) + challengeReminder;

       // T219: Racha de login diario
       let streakText = '';
       try {
         const streakResult = db.processLoginStreak(player.id);
         if (streakResult && streakResult.isNew) {
           const STREAK_EMOJIS = ['', '🌟', '🌟🌟', '🔥🌟', '🔥🌟🌟', '🔥🔥', '🏆🔥', '👑🏆'];
           const emoji = STREAK_EMOJIS[Math.min(streakResult.streak, 7)] || '🌟';
           if (streakResult.streak === 1) {
             streakText = `\n\n${emoji} ¡Bienvenido/a! Recibís +${streakResult.reward.gold}g y +${streakResult.reward.xp} XP por conectarte hoy.`;
           } else {
             streakText = `\n\n${emoji} ¡Racha de ${streakResult.streak} días consecutivos! Bonus de hoy: +${streakResult.reward.gold}g y +${streakResult.reward.xp} XP. ¡Seguí así!`;
           }
         }
       } catch (_) {}

       ack && ack({ player_id: player.id, username: player.username, welcome: finalWelcomeText + streakText });

      // T173: Notificar a amigos de este jugador que se conectó
      setImmediate(() => {
        try {
          const freshP = db.getPlayer(player.id);
          let allPlayers = null;
          // Recorrer todos los jugadores online y ver si tienen a este jugador en su lista de amigos
          for (const [onlineId, onlineSocket] of playerSockets.entries()) {
            if (onlineId === player.id) continue;
            const onlinePlayer = db.getPlayer(onlineId);
            if (!onlinePlayer) continue;
            let theirFriends;
            try { theirFriends = JSON.parse(onlinePlayer.friends || '[]'); } catch (_) { theirFriends = []; }
            if (theirFriends.some(f => f.toLowerCase() === player.username.toLowerCase())) {
              onlineSocket.emit('event', {
                type: 'friend_online',
                message: `👥 Tu amigo ${player.username} se conectó al dungeon.`,
              });
            }
          }
        } catch (_) {}
      });
    });

    // ── command ───────────────────────────────────────────────────────────────
    // El cliente envía un comando de texto.
    // Respuesta: { result: string } o { error }
    let lastCommandTime = 0;
    let lastCommand     = '';

    socket.on('command', (data, ack) => {
      if (!currentPlayerId) {
        return ack && ack({ error: 'Tenés que hacer "join" primero.' });
      }

      const { command } = data || {};
      if (!command || typeof command !== 'string') {
        return ack && ack({ error: 'Se requiere un command.' });
      }

      // Protección anti-spam: ignorar el mismo comando dentro de 500ms
      const now = Date.now();
      if (command === lastCommand && now - lastCommandTime < 500) {
        return ack && ack({ result: '(ignorado — demasiado rápido, esperá un momento)' });
      }
      lastCommand     = command;
      lastCommandTime = now;

      // BUG-341: Si por algún motivo (reinicio del servidor, reconexión sin join, etc.)
      // el jugador no tiene sessionData en el mapa, inicializarla on-the-fly para que
      // el comando 'session' funcione correctamente.
      if (!sessionDataMap.has(currentPlayerId)) {
        const freshP = db.getPlayer(currentPlayerId);
        sessionDataMap.set(currentPlayerId, {
          startTime: Date.now(),
          kills: 0,
          xpStart: freshP ? (freshP.xp || 0) : 0,
          goldStart: freshP ? (freshP.gold || 0) : 0,
          commands: 0,
        });
      }

      const context = {
        broadcastToRoom: (roomId, excludePlayerId, message) => {
          io.to(`room_${roomId}`).emit('event', { type: 'action', message });
        },
        previousRoomId: previousRoomMap.get(currentPlayerId) || null,
        sessionData: sessionDataMap.get(currentPlayerId) || null,
        sessionDataMap,   // T198: score sesión necesita ver todos los jugadores activos
        playerSockets,
        followMap,        // T204: sistema de follow
        monsterTrackMap,  // T223: tracking de monstruos
      };
      const result = engine.execute(currentPlayerId, command, context);

      // T155: Incrementar contador de comandos y kills de sesión
      const sessData = sessionDataMap.get(currentPlayerId);
      if (sessData) {
        sessData.commands++;
        if (result.sessionKill) sessData.kills++;
      }

      // Si el resultado incluye un evento para broadcast
      if (result.event) {
        const targetRoomId = result.eventRoomId || currentRoomId;
        io.to(`room_${targetRoomId}`).emit('event', {
          type: 'action',
          message: result.event,
        });

        // Si hay un evento en la sala de origen (ej: al moverse)
        if (result.fromRoomId && result.fromRoomEvent) {
          io.to(`room_${result.fromRoomId}`).emit('event', {
            type: 'action',
            message: result.fromRoomEvent,
          });
        }
      }

      // Broadcast global (para eventos importantes como matar al boss)
      if (result.globalEvent) {
        io.emit('shout', {
          username: '⚡ SISTEMA',
          message: result.globalEvent,
        });
      }

      // Guild chat broadcast — enviar solo a jugadores del mismo guild
      if (result.guildBroadcast && result.guildBroadcastMsg) {
        const guildName = result.guildBroadcast;
        const members = db.getGuildMembers(guildName);
        pushRecentChat('gc', `[${guildName}]`, result.guildBroadcastMsg);
        for (const member of members) {
          // Excluir al propio emisor si corresponde (para gc)
          if (result.guildBroadcastExcludeSelf && member.id === result.guildBroadcastExcludeSelf) continue;
          const memberSocket = playerSockets.get(member.id);
          if (memberSocket) {
            memberSocket.emit('event', {
              type: 'guild_chat',
              message: result.guildBroadcastMsg,
            });
          }
        }
      }

      // Si el resultado incluye un mensaje directo para otro jugador (ej: give, whisper)
      if (result.targetPlayerId && result.targetPlayerMsg) {
        const targetSocket = playerSockets.get(result.targetPlayerId);
        if (targetSocket) {
          targetSocket.emit('event', {
            type: result.targetEventType || 'received_item',
            message: result.targetPlayerMsg,
          });
        }
      }

      // Si el jugador cambió de habitación, actualizar rooms de Socket.io
      const player = db.getPlayer(currentPlayerId);
      if (player && player.current_room_id !== currentRoomId) {
        // T154: guardar sala previa para comando back
        previousRoomMap.set(currentPlayerId, currentRoomId);

        const oldRoomId = currentRoomId;
        socket.leave(`room_${currentRoomId}`);
        currentRoomId = player.current_room_id;
        socket.join(`room_${currentRoomId}`);

        // Anunciar llegada
        socket.to(`room_${currentRoomId}`).emit('event', {
          type: 'player_join',
          message: `${player.username} entra a la sala.`,
        });

        // T204: Mover seguidores — buscar jugadores que siguen a este jugador
        for (const [followerId, targetId] of followMap.entries()) {
          if (targetId !== currentPlayerId) continue;
          const followerPlayer = db.getPlayer(followerId);
          if (!followerPlayer || followerPlayer.current_room_id !== oldRoomId) continue;
          // Mover al seguidor a la nueva sala
          db.updatePlayer(followerId, { current_room_id: currentRoomId });
          previousRoomMap.set(followerId, oldRoomId);
          const followerSocket = playerSockets.get(followerId);
          if (followerSocket) {
            followerSocket.leave(`room_${oldRoomId}`);
            followerSocket.join(`room_${currentRoomId}`);
            // Notificar al seguidor
            followerSocket.emit('event', {
              type: 'info',
              text: `👣 Seguís a ${player.username} hacia la siguiente sala...`,
            });
            // Enviarle el look automáticamente
            const lookResult = engine.execute(followerId, 'look', { broadcastToRoom: () => {}, playerSockets, followMap });
            followerSocket.emit('event', { type: 'action', message: lookResult.text });
            // Anunciar llegada del seguidor
            followerSocket.to(`room_${currentRoomId}`).emit('event', {
              type: 'player_join',
              message: `${followerPlayer.username} entra a la sala siguiendo a ${player.username}.`,
            });
          }
        }
      }

      ack && ack({ result: result.text });
    });

    // ── say ───────────────────────────────────────────────────────────────────
    // Chat local a la habitación.
    socket.on('say', (data, ack) => {
      if (!currentPlayerId) return ack && ack({ error: 'No estás identificado.' });

      const player = db.getPlayer(currentPlayerId);
      const { message } = data || {};
      if (!message || !message.trim()) return ack && ack({ error: 'Mensaje vacío.' });

      const msg = message.trim().slice(0, 200);
      io.to(`room_${currentRoomId}`).emit('say', {
        username: player.username,
        name_color: player.name_color || null,
        message: msg,
      });
      pushRecentChat('say', player.username, msg);
      ack && ack({ ok: true });
    });

    // ── shout ─────────────────────────────────────────────────────────────────
    // Broadcast global a todos los jugadores conectados.
    socket.on('shout', (data, ack) => {
      if (!currentPlayerId) return ack && ack({ error: 'No estás identificado.' });

      const player = db.getPlayer(currentPlayerId);
      const { message } = data || {};
      if (!message || !message.trim()) return ack && ack({ error: 'Mensaje vacío.' });

      const msg = message.trim().slice(0, 200);
      io.emit('shout', {
        username: player.username,
        name_color: player.name_color || null,
        message: msg,
      });
      pushRecentChat('shout', player.username, msg);
      ack && ack({ ok: true });
    });

    // ── disconnect ────────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      if (!currentPlayerId) return;

      // Limpiar del mapa de sockets directos
      playerSockets.delete(currentPlayerId);

      // T204: Limpiar follow al desconectar (tanto si era seguidor como seguido)
      followMap.delete(currentPlayerId);

      // T223: Limpiar tracking de monstruos al desconectar
      for (const [monName, trackers] of monsterTrackMap.entries()) {
        trackers.delete(currentPlayerId);
        if (trackers.size === 0) monsterTrackMap.delete(monName);
      }

      // T146: Limpiar flag AFK al desconectar
      engine.clearAfk(currentPlayerId);

      // T159/T160: Limpiar racha de kills y salas exploradas de la sesión
      engine.killStreakMap.delete(currentPlayerId);
      engine.sessionExploredRooms.delete(currentPlayerId);

      // T192: Limpiar combo al desconectar
      if (engine.comboMap) engine.comboMap.delete(currentPlayerId);

      // T164: Limpiar historial de comandos de sesión
      engine.sessionCommandHistory.delete(currentPlayerId);

      // T155: Mostrar resumen de sesión al desconectar
      const sessData = sessionDataMap.get(currentPlayerId);
      if (sessData) {
        const player = db.getPlayer(currentPlayerId);
        const elapsedMs = Date.now() - sessData.startTime;
        const elapsedMin = Math.floor(elapsedMs / 60000);
        const elapsedSec = Math.floor((elapsedMs % 60000) / 1000);
        const xpGained = player ? Math.max(0, (player.xp || 0) - sessData.xpStart) : 0;
        const goldGained = player ? (player.gold || 0) - sessData.goldStart : 0;
        const sessionSummary = [
          `📊 Resumen de sesión:`,
          `  ⏱ Tiempo conectado: ${elapsedMin}m ${elapsedSec}s`,
          `  ⚔️  Kills en sesión: ${sessData.kills}`,
          `  ✨ XP ganada: +${xpGained}`,
          `  🪙 Oro ganado: ${goldGained >= 0 ? '+' : ''}${goldGained}`,
          `  🎮 Comandos ejecutados: ${sessData.commands}`,
        ].join('\n');
        socket.emit('event', { type: 'session_summary', message: sessionSummary });

        // T156: Guardar sesión en BD
        try {
          db.saveSession(currentPlayerId, {
            startTime: sessData.startTime,
            kills: sessData.kills,
            xpGained,
            goldGained,
            commands: sessData.commands,
          });
        } catch (err) {
          console.error('[session] Error guardando sesión:', err.message);
        }

        sessionDataMap.delete(currentPlayerId);
      }

      const player = db.getPlayer(currentPlayerId);
      if (player) {
        socket.to(`room_${currentRoomId}`).emit('event', {
          type: 'player_leave',
          message: `${player.username} abandona la sala.`,
        });
        console.log(`[socket] ${player.username} desconectado.`);
      }
    });

  });

}

module.exports = { registerHandlers, playerSockets, previousRoomMap, sessionDataMap, followMap, monsterTrackMap };
