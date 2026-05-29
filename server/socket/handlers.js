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

      // Unirse al room de Socket.io de la habitación actual
      socket.join(`room_${currentRoomId}`);

      // Notificar a los demás jugadores de la sala
      socket.to(`room_${currentRoomId}`).emit('event', {
        type: 'player_join',
        message: `${player.username} entra a la sala.`,
      });

      // Auto-look al entrar
      const lookResult = engine.execute(player.id, 'look');

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
      ack && ack({ player_id: player.id, username: player.username, welcome: lookResult.text });
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

      const result = engine.execute(currentPlayerId, command);

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

module.exports = { registerHandlers };
