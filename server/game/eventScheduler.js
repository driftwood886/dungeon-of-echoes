'use strict';
/**
 * eventScheduler.js — Scheduler de eventos cíclicos globales
 * T-1225 / EPIC Gaceta del Corredor — Fase 1: Eventos Cíclicos
 *
 * Lógica:
 * - Cada 60 segundos: revisar si hay evento activo no expirado.
 * - Si no hay → verificar si pasaron los 5 minutos de calma post-evento.
 * - Si pasaron → elegir evento aleatorio del pool y activarlo.
 * - Basado en decisiones de EPIC-1219-DEF §4:
 *   Los efectos son aditivos, nunca interrumpen combate en curso.
 *   Los combates iniciados ANTES del evento conservan sus stats originales.
 */

let db = null;
let io = null; // socket.io para broadcasts (opcional)

// ─── Pool de eventos globales ────────────────────────────────────────────────
// Basado en DIS-EPIC-001-eventos-dinamicos.md

const GLOBAL_EVENTS = [
  {
    id: 'BLOOD_MOON',
    name: '🌑 Luna de Sangre',
    description: 'Los monstruos de nivel 3+ tienen +30% HP y ATK, pero el XP y drop rate son mayores.',
    durationMs: 10 * 60 * 1000, // 10 minutos
    announcement: '🌑 La Luna de Sangre tiñe el dungeon. Los monstruos se despiertan — pero las recompensas valen la sangre.',
    data: {
      monster_hp_mult: 1.3,
      monster_atk_mult: 1.3,
      xp_mult: 1.75,
      drop_mult: 1.5,
      affects_level_min: 3  // Solo monstruos de nivel 3+ (no goblin/murciélago)
    }
  },
  {
    id: 'ARCANE_SURGE',
    name: '⚡ Carga Arcana',
    description: 'Los hechizos hacen +50% de daño y los cooldowns de habilidades se reducen en 1 turno.',
    durationMs: 8 * 60 * 1000, // 8 minutos
    announcement: '⚡ Una onda arcana recorre el dungeon. Los hechizos vibran con energía extra.',
    data: {
      spell_damage_mult: 1.5,
      cooldown_reduction: 1
    }
  },
  {
    id: 'DUNGEON_BREATH',
    name: '🌿 Respiro del Dungeon',
    description: 'Los monstruos respawnean el doble de rápido. Más loot básico cae en combate.',
    durationMs: 12 * 60 * 1000, // 12 minutos
    announcement: '🌿 El dungeon respira. Los pasillos se llenan más rápido que de costumbre.',
    data: {
      respawn_speed_mult: 2.0,
      base_loot_bonus: 1
    }
  },
  {
    id: 'SPECTRAL_TIDE',
    name: '👻 Marea Espectral',
    description: 'Solo los monstruos espectrales están activos. El XP de espectros es el doble.',
    durationMs: 8 * 60 * 1000, // 8 minutos
    announcement: '👻 Una marea espectral recorre el dungeon. Solo los no-muertos están activos.',
    data: {
      spectral_only: true,
      spectral_xp_mult: 2.0
    }
  },
  {
    id: 'GOLD_RUSH',
    name: '💰 Fiebre del Oro',
    description: 'El loot de monedas es el triple y los precios de Aldric están al 80%.',
    durationMs: 10 * 60 * 1000, // 10 minutos
    announcement: '💰 ¡El Mercader tiene una oferta especial! Algo cambió en la economía del dungeon.',
    data: {
      gold_loot_mult: 3.0,
      shop_price_mult: 0.8
    }
  }
];

// Key en world_state para rastrear el último fin de ciclo de evento
const LAST_EVENT_END_KEY = 'last_event_end_at';
const CALM_PERIOD_MS = 5 * 60 * 1000; // 5 minutos de calma entre eventos

// Índice rotatorio para no repetir el mismo evento dos veces seguidas
let lastEventIndex = -1;

/**
 * Inicializa el scheduler. Llamar una vez al iniciar el servidor (después de db.init()).
 * @param {object} dbInstance - instancia del módulo db.js
 * @param {object} [ioInstance] - instancia de socket.io (para broadcasts, opcional)
 */
function init(dbInstance, ioInstance = null) {
  db = dbInstance;
  io = ioInstance;
  console.log('[eventScheduler] Iniciado. Tick cada 60s.');
  // Primer tick inmediato para no esperar 60s al arrancar
  tick();
  setInterval(tick, 60 * 1000);
}

/**
 * Tick principal: evalúa si hay que cambiar el evento activo.
 */
function tick() {
  try {
    const currentEvent = db.getActiveGlobalEvent();

    if (currentEvent) {
      // Hay un evento activo → no hacer nada todavía
      const remaining = Math.round((new Date(currentEvent.expires_at) - Date.now()) / 1000 / 60);
      if (remaining <= 2 && remaining > 0) {
        // Anuncio de 2 minutos antes de que termine (pero no hay forma de anunciar el próximo
        // sin conocer cuál será — esto se resuelve en T-1226 cmd evento)
        console.log(`[eventScheduler] Evento '${currentEvent.event_id}' termina en ~${remaining} min.`);
      }
      return;
    }

    // No hay evento activo → evaluar período de calma
    // Usar world_state para guardar el timestamp del último fin de evento
    const worldSnapshot = db.getWorldStateSnapshot ? db.getWorldStateSnapshot() : {};
    const lastEndAt = worldSnapshot[LAST_EVENT_END_KEY];

    if (lastEndAt) {
      const lastEndMs = parseInt(lastEndAt, 10);
      const elapsed = Date.now() - lastEndMs;
      if (elapsed < CALM_PERIOD_MS) {
        const remainingCalm = Math.round((CALM_PERIOD_MS - elapsed) / 1000 / 60);
        console.log(`[eventScheduler] Período de calma — próximo evento en ~${remainingCalm} min.`);
        return;
      }
    }

    // Pasar el período de calma o primer arranque → activar nuevo evento
    activateNextEvent();

  } catch (err) {
    console.error('[eventScheduler] Error en tick:', err.message);
  }
}

/**
 * Elige y activa el siguiente evento (evitando repetir el mismo dos veces).
 */
function activateNextEvent() {
  let nextIndex;
  if (GLOBAL_EVENTS.length === 1) {
    nextIndex = 0;
  } else {
    do {
      nextIndex = Math.floor(Math.random() * GLOBAL_EVENTS.length);
    } while (nextIndex === lastEventIndex);
  }
  lastEventIndex = nextIndex;
  const event = GLOBAL_EVENTS[nextIndex];

  db.setActiveGlobalEvent(event.id, event.durationMs, event.data);

  console.log(`[eventScheduler] 🎉 Nuevo evento global: ${event.name} (duración: ${event.durationMs / 60000} min)`);
  console.log(`[eventScheduler] Anuncio: ${event.announcement}`);

  // Broadcast a todos los jugadores online (si io está disponible)
  if (io) {
    try {
      io.emit('globalEvent', {
        eventId: event.id,
        name: event.name,
        description: event.description,
        announcement: event.announcement,
        durationMs: event.durationMs
      });
    } catch (broadcastErr) {
      console.error('[eventScheduler] Error en broadcast:', broadcastErr.message);
    }
  }

  // Registrar el tiempo de inicio en world_state para poder calcular el período de calma
  // cuando el evento expire. Lo actualizamos también al expirar via el próximo tick.
  scheduleEventEndNotification(event);
}

/**
 * Programa una actualización al final del evento para registrar el tiempo de fin
 * en world_state (necesario para respetar el período de calma).
 */
function scheduleEventEndNotification(event) {
  setTimeout(() => {
    try {
      const endTime = Date.now().toString();
      if (db.setWorldState) {
        db.setWorldState(LAST_EVENT_END_KEY, endTime);
      }
      console.log(`[eventScheduler] Evento '${event.id}' terminó. Período de calma de ${CALM_PERIOD_MS / 60000} min iniciado.`);
      if (io) {
        io.emit('globalEventEnd', { eventId: event.id, name: event.name });
      }
    } catch (err) {
      console.error('[eventScheduler] Error al registrar fin de evento:', err.message);
    }
  }, event.durationMs);
}

/**
 * Devuelve información del evento activo con tiempo restante calculado.
 * Útil para el comando `evento` (T-1226) y para `look`/`status`.
 * @returns {{ event, minutesRemaining, secondsRemaining }|null}
 */
function getActiveEventInfo() {
  if (!db) return null;
  const row = db.getActiveGlobalEvent();
  if (!row) return null;

  const eventDef = GLOBAL_EVENTS.find(e => e.id === row.event_id);
  if (!eventDef) return null;

  const expiresAt = new Date(row.expires_at);
  const now = new Date();
  const msRemaining = Math.max(0, expiresAt - now);
  const minutesRemaining = Math.floor(msRemaining / 60000);
  const secondsRemaining = Math.floor((msRemaining % 60000) / 1000);

  return {
    event: { ...eventDef, started_at: row.started_at, expires_at: row.expires_at },
    minutesRemaining,
    secondsRemaining,
    msRemaining
  };
}

/**
 * Devuelve el pool de eventos para uso externo (ej: comando `evento` mostrando lista).
 */
function getEventPool() {
  return GLOBAL_EVENTS;
}

module.exports = { init, tick, getActiveEventInfo, getEventPool, GLOBAL_EVENTS };
