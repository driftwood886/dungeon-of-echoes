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

// T154: Mapa global: playerId → sala previa (para comando back)
const previousRoomMap = new Map();

// T155: Mapa global: playerId → datos de sesión
// { startTime, kills, xpStart, goldStart, commands }
const sessionDataMap = new Map();

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
      ack && ack({ player_id: player.id, username: player.username, welcome: finalWelcomeText });
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

      const context = {
        broadcastToRoom: (roomId, excludePlayerId, message) => {
          io.to(`room_${roomId}`).emit('event', { type: 'action', message });
        },
        previousRoomId: previousRoomMap.get(currentPlayerId) || null,
        sessionData: sessionDataMap.get(currentPlayerId) || null,
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

        socket.leave(`room_${currentRoomId}`);
        currentRoomId = player.current_room_id;
        socket.join(`room_${currentRoomId}`);

        // Anunciar llegada
        socket.to(`room_${currentRoomId}`).emit('event', {
          type: 'player_join',
          message: `${player.username} entra a la sala.`,
        });
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
        message: msg,
      });
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
        message: msg,
      });
      ack && ack({ ok: true });
    });

    // ── disconnect ────────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      if (!currentPlayerId) return;

      // Limpiar del mapa de sockets directos
      playerSockets.delete(currentPlayerId);

      // T146: Limpiar flag AFK al desconectar
      engine.clearAfk(currentPlayerId);

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

module.exports = { registerHandlers, playerSockets, previousRoomMap, sessionDataMap };
