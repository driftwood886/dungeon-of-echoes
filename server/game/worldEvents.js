/**
 * worldEvents.js — Eventos globales periódicos del dungeon (T090)
 *
 * Cada 12 minutos ocurre un evento aleatorio que afecta a todos los jugadores.
 * El evento dura 8 minutos y luego el dungeon vuelve a la calma.
 * (DIS-480: antes era 20min/5min — demasiado raro para una sesión de 30-40 min)
 *
 * Eventos disponibles:
 *  - 'invasion'     → Los monstruos sueltan +50% XP
 *  - 'mist'         → Niebla espesa (el minimapa no muestra nombres de salas)
 *  - 'bloodmoon'    → Luna de Sangre: monstruos nivel 3+ ganan +30% ATK y +75% XP
 *                     (DIS-852: rediseñado — antes era +2 daño flat, ahora % proporcional solo nivel 3+)
 *  - 'arcane_surge' → Carga Arcana: hechizos +50% daño, cooldown -1 turno (DIS-852)
 *  - 'blessing'     → Bendición del santuario (+2 HP de regeneración al entrar en salas sagradas)
 *  - 'curse'        → Maldición del Lich (todos reciben -1 HP por sala que cambian)
 */

'use strict';

const EVENT_INTERVAL_MS  = 12 * 60 * 1000; // 12 minutos entre eventos (DIS-480: era 20min, demasiado raro en sesión casual)
const EVENT_DURATION_MS  =  8 * 60 * 1000; // 8 minutos de duración (DIS-480: era 5min)

// DIS-852: IDs de monstruos considerados "nivel 3+" para el evento BLOOD_MOON
// Solo monstruos de mid/late game se ven afectados — los básicos del early game quedan normales
// Incluye: Espectro, Elemental, Krakeling, Gólem de Piedra, Guardia Espectral, Golem de Forja,
//          Campeón Espectral, Eco Viviente, Sombra del Vacío, Esqueleto Guerrero
const BLOOD_MOON_MONSTER_IDS = new Set([2, 4, 5, 8, 9, 10, 11, 12, 13, 21, 22]);

const EVENT_CATALOG = [
  {
    id: 'invasion',
    name: '⚡ Invasión de los Abismos',
    description: 'Una horda de monstruos enardecidos llena el dungeon. Sus almas valen el doble de XP.',
    announceStart: '⚡ ¡ALERTA! Una invasión surge desde las profundidades del Abismo. Los monstruos están enardecidos — ¡cada kill otorga +50% XP por los próximos 5 minutos!',
    announceEnd: '✨ La invasión ha sido contenida. Los monstruos vuelven a su estado normal.',
  },
  {
    id: 'mist',
    name: '🌫️ Niebla Espesa',
    description: 'Una densa niebla cubre el dungeon. El minimapa pierde sus leyendas — solo se ven los símbolos de las salas.',
    announceStart: '🌫️ Una niebla sobrenatural cubre el dungeon. Es difícil orientarse — el minimapa ha perdido sus etiquetas por 5 minutos.',
    announceEnd: '☀️ La niebla se disipa. El dungeon vuelve a ser navegable.',
  },
  {
    id: 'bloodmoon',
    name: '🌑 Luna de Sangre',
    // DIS-852: rediseñado — monstruos nivel 3+ ganan +30% ATK y +75% XP, básicos no se afectan
    description: 'La Luna de Sangre tiñe el dungeon de rojo. Las criaturas del abismo despiertan con furia renovada — los monstruos de mid/late game son más peligrosos, pero sus almas brillan con recompensas.',
    announceStart: '🌑 ¡La Luna de Sangre tiñe el dungeon! Los monstruos del abismo se despiertan — los enemigos de nivel 3+ ganan +30% ATK pero otorgan +75% XP. Los básicos (Goblin, Murciélago, Rata, Araña) no se afectan. ¡Las recompensas valen la sangre!',
    announceEnd: '🌙 La Luna de Sangre se oculta. Los monstruos vuelven a su ferocidad habitual.',
    // Flags para que combat.js sepa cómo aplicar el efecto
    atkBonus: 0.30,   // +30% ATK proporcional (se aplica en combat.js)
    xpBonus: 0.75,    // +75% XP adicional (se acumula con invasion si ambos activos)
    affectedIds: BLOOD_MOON_MONSTER_IDS,
  },
  {
    id: 'arcane_surge',
    name: '⚡ Carga Arcana',
    // DIS-852: nuevo evento — hechizos +50% daño
    description: 'Una onda arcana recorre el dungeon. Los hechizos vibran con energía extra — Magos y Clérigos activos verán sus poderes amplificados.',
    announceStart: '⚡ ¡Una onda arcana recorre el dungeon! Los hechizos de Magos y Clérigos hacen +50% de daño por los próximos 8 minutos. ¡El momento de la magia ha llegado!',
    announceEnd: '✨ La onda arcana se disipa. Los hechizos vuelven a su potencia normal.',
    spellBonus: 0.50, // +50% daño de hechizos
  },
  {
    id: 'blessing',
    name: '✨ Bendición del Santuario',
    description: 'Un aura sagrada emana desde el Santuario. Moverse entre salas recupera 1 HP extra.',
    announceStart: '✨ ¡Una bendición sagrada recorre el dungeon! Cada sala que visitéis restaurará 1 HP adicional durante los próximos 5 minutos.',
    announceEnd: '🕯️ La bendición sagrada se desvanece. El dungeon recupera su frialdad habitual.',
  },
  {
    id: 'curse',
    name: '💀 Maldición del Lich',
    description: 'El Lich Anciano maldice el dungeon. Cada cambio de sala drena 1 HP del aventurero.',
    announceStart: '💀 ¡El Lich Anciano ha maldecido el dungeon! Cada sala que pisáis os costará 1 HP durante los próximos 5 minutos. ¡Moved con cuidado!',
    announceEnd: '⚰️ La maldición del Lich se debilita. El dungeon deja de drenar vuestra vitalidad.',
  },
];

// Estado global del evento activo (en memoria; se reinicia con el servidor)
let activeEvent = null;       // null | { ...EventCatalog, startedAt: number }
let lastEventAt = Date.now(); // timestamp del último evento iniciado
let nextEventAt = Date.now() + EVENT_INTERVAL_MS;

/**
 * Devuelve el evento activo actual (o null si no hay).
 * @returns {{ id, name, description, startedAt, endsAt } | null}
 */
function getCurrentEvent() {
  if (!activeEvent) return null;
  const endsAt = activeEvent.startedAt + EVENT_DURATION_MS;
  if (Date.now() > endsAt) {
    // El evento expiró pero tick no lo limpió aún
    return null;
  }
  return {
    id: activeEvent.id,
    name: activeEvent.name,
    description: activeEvent.description,
    startedAt: activeEvent.startedAt,
    endsAt,
    remainingMs: endsAt - Date.now(),
  };
}

/**
 * Verificar si hay que activar o desactivar un evento.
 * Llamar cada 60 segundos desde index.js.
 *
 * @returns {{ type: 'start'|'end', event: object, message: string } | null}
 *   Si devuelve algo, el llamador debe hacer broadcast global.
 */
function tick() {
  const now = Date.now();

  // Si hay un evento activo y expiró → desactivar
  if (activeEvent) {
    const endsAt = activeEvent.startedAt + EVENT_DURATION_MS;
    if (now >= endsAt) {
      const endedEvent = activeEvent;
      activeEvent = null;
      nextEventAt = now + EVENT_INTERVAL_MS;
      return {
        type: 'end',
        event: endedEvent,
        message: endedEvent.announceEnd,
      };
    }
    // Todavía activo, nada que hacer
    return null;
  }

  // Si no hay evento activo y ya pasó el intervalo → activar uno nuevo
  if (now >= nextEventAt) {
    const candidates = EVENT_CATALOG;
    const chosen = candidates[Math.floor(Math.random() * candidates.length)];
    activeEvent = { ...chosen, startedAt: now };
    lastEventAt = now;
    // El próximo evento se calcula al terminar este
    return {
      type: 'start',
      event: activeEvent,
      message: chosen.announceStart,
    };
  }

  return null;
}

/**
 * Texto de tiempo restante amigable.
 */
function formatRemaining(ms) {
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  if (min > 0) return `${min}m ${sec}s`;
  return `${sec}s`;
}

/**
 * Texto de próximo evento.
 */
function getNextEventText() {
  const remaining = Math.max(0, nextEventAt - Date.now());
  return `Próximo evento en: ${formatRemaining(remaining)}`;
}

module.exports = { getCurrentEvent, tick, getNextEventText, EVENT_CATALOG, BLOOD_MOON_MONSTER_IDS };
