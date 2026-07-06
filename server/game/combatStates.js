/**
 * combatStates.js — Sistema de estados de combate
 * 
 * API pública:
 *   applyDebuff(target, stateId, opts)         → aplica estado, maneja stacks/sinergias
 *   resolveDebuffSynergy(existing, incoming, source) → chequea si hay sinergia
 *   tickDebuffs(target, lines)                  → procesa DoT y decrementa duraciones
 *   describeDebuffs(target)                     → devuelve string legible para el jugador
 * 
 * Fase 1: SINERGIA_TABLE vacía — solo infraestructura.
 * Fase 2 (EPIC-1293-F2): activar sinergias del Mago.
 */

'use strict';

// ─── Catálogo de estados canónicos ───────────────────────────────────────────

/**
 * STATE_CATALOG define el comportamiento predeterminado de cada estado.
 * Las funciones pueden overridearlo con opts al llamar a applyDebuff().
 */
const STATE_CATALOG = {
  stunned: {
    name: 'Aturdido',
    emoji: '⚡',
    turns: 1,
    effect: 'control',      // pierde turno
    stackeable: false,
    description: 'Pierde su próxima acción.',
  },
  slowed: {
    name: 'Ralentizado',
    emoji: '❄️',
    turns: 1,
    effect: 'control',      // pierde turno (es un lento, mecánicamente igual a stun por ahora)
    stackeable: false,
    description: 'Pierde su próxima acción (movimiento forzado).',
  },
  frozen: {
    name: 'Helado',
    emoji: '🧊',
    turns: 2,
    effect: 'control',      // pierde 2 turnos
    def_penalty: 2,
    stackeable: false,
    description: 'Pierde 2 turnos y tiene -2 DEF.',
  },
  burning: {
    name: 'Quemándose',
    emoji: '🔥',
    turns: 2,
    effect: 'dot',
    dmg_per_turn: 3,
    stackeable: true,
    max_stacks: 2,
    description: 'Recibe 3 daño por turno (stackeable hasta ×2).',
  },
  steam_explosion: {
    name: 'Vapor Explosivo',
    emoji: '💨',
    turns: 1,
    effect: 'buff_player',  // se aplica al jugador que lo causó, no al monstruo
    next_spell_bonus: 1.50,
    stackeable: false,
    description: '+50% daño al próximo hechizo.',
  },
  exposed: {
    name: 'Expuesto',
    emoji: '💀',
    turns: 1,
    effect: 'debuff',
    def_penalty: 2,
    stackeable: false,
    description: '-2 DEF por 1 turno.',
  },
  condenado: {
    name: 'Condenado',
    emoji: '✝️',
    turns: 2,
    effect: 'debuff',
    incoming_dmg_bonus: 0.30,
    stackeable: false,
    description: '+30% daño recibido por 2 turnos.',
  },
};

// ─── Tabla de sinergias ───────────────────────────────────────────────────────

/**
 * SINERGIA_TABLE[existing][incoming] = { result, message, consumeExisting, extra }
 * 
 * FASE 1: Vacía — no activar sinergias todavía.
 * FASE 2 (EPIC-1293-F2): Poblar con sinergias del Mago.
 */
const SINERGIA_TABLE = {
  // FASE 2 las llenará:
  // 'slowed': {
  //   'slowed':  { result: 'frozen',           message: '❄️⚡ SINERGIA: Ralentizado + escarcha = ¡HELADO! (2 turnos sin acción, -2 DEF)', consumeExisting: true },
  //   'stunned': { result: 'frozen',            message: '❄️😵 SINERGIA: Ralentizado + aturdido = ¡HELADO! (2 turnos sin acción)', consumeExisting: true },
  // },
  // 'burning': {
  //   'slowed':   { result: 'steam_explosion',  message: '🔥❄️ SINERGIA: Quemándose + escarcha = ¡EXPLOSIÓN DE VAPOR! (+50% daño del próximo hechizo)', consumeExisting: true, extra: { applyToPlayer: true } },
  //   'burning':  { result: 'burning',           message: '🔥🔥 ¡Quemándose se intensifica! (2 stacks: 6 dmg/turno)', consumeExisting: false, stack: true },
  // },
  // 'stunned': {
  //   'golpe_sucio': { result: 'exposed',        message: '😵💀 SINERGIA: Aturdido + golpe sucio = ¡EXPUESTO! (-2 DEF por 1 turno)', consumeExisting: true },
  // },
};

// ─── API ──────────────────────────────────────────────────────────────────────

/**
 * Aplica un estado a un target (monstruo o jugador).
 * Maneja stacks, sinergias (via SINERGIA_TABLE), y formato canónico.
 * 
 * @param {object} target  — Objeto con .status_effects (monstruo o player)
 * @param {string} stateId — ID canónico del estado ("slowed", "burning", etc.)
 * @param {object} opts    — Overrides: { turns, source, amount, dmg_per_turn, stacks }
 * @returns {{ applied: string, lines: string[] }}
 *   applied = estado que quedó realmente aplicado (puede diferir por sinergia)
 *   lines   = mensajes de log del combate
 */
function applyDebuff(target, stateId, opts = {}) {
  if (!target.status_effects) target.status_effects = {};

  const lines = [];
  const catalog = STATE_CATALOG[stateId] || {};
  
  const turns    = opts.turns         ?? catalog.turns         ?? 1;
  const source   = opts.source        ?? 'desconocido';
  const amount   = opts.amount        ?? catalog.amount        ?? 0;
  const dmgPT    = opts.dmg_per_turn  ?? catalog.dmg_per_turn  ?? 0;
  const defPen   = opts.def_penalty   ?? catalog.def_penalty   ?? 0;
  const stacks   = opts.stacks        ?? 1;

  // ─── Chequear sinergia ───────────────────────────────────────────────────
  const existingIds = Object.keys(target.status_effects);
  let synergyTriggered = false;

  for (const existId of existingIds) {
    const syn = resolveDebuffSynergy(existId, stateId, source);
    if (syn && syn.triggered) {
      lines.push(syn.message);
      
      if (syn.consumeExisting) {
        delete target.status_effects[existId];
      }

      // Si la sinergia aplica al jugador (steam_explosion), necesita manejo especial
      // Por ahora se registra en el target con un flag para que el caller lo maneje
      if (syn.applyToPlayer) {
        // steam_explosion: guardar en el target como marcador para el engine
        target.status_effects['__steam_explosion_pending'] = {
          turns: 1,
          source: source,
          next_spell_bonus: syn.next_spell_bonus || 1.50,
        };
      } else {
        // Aplicar el estado resultante de la sinergia
        const resultCatalog = STATE_CATALOG[syn.result] || {};
        target.status_effects[syn.result] = {
          turns:       syn.resultTurns  ?? resultCatalog.turns ?? turns,
          source:      source,
          amount:      amount,
          stacks:      1,
          def_penalty: resultCatalog.def_penalty ?? 0,
          dmg_per_turn: resultCatalog.dmg_per_turn ?? 0,
        };
      }

      synergyTriggered = true;
      return { applied: syn.result, lines };
    }
  }

  // ─── Sin sinergia: aplicar normalmente ───────────────────────────────────
  const existing = target.status_effects[stateId];

  if (existing && catalog.stackeable) {
    // Acumular stacks (hasta max_stacks)
    const maxStacks = catalog.max_stacks || 2;
    const newStacks = Math.min((existing.stacks || 1) + stacks, maxStacks);
    existing.stacks = newStacks;
    existing.turns = Math.max(existing.turns, turns); // refrescar duración
    const emoji = catalog.emoji || '';
    const name  = catalog.name  || stateId;
    lines.push(`${emoji} ${name} se intensifica. (${newStacks} stacks)`);
  } else if (existing && !catalog.stackeable) {
    // No stackeable: refrescar duración si el nuevo es mayor
    if (turns > existing.turns) {
      existing.turns = turns;
    }
    const emoji = catalog.emoji || '';
    const name  = catalog.name  || stateId;
    lines.push(`${emoji} ${name} ya activo (duración refrescada).`);
  } else {
    // Estado nuevo
    target.status_effects[stateId] = {
      turns,
      source,
      amount,
      stacks,
      def_penalty:  defPen,
      dmg_per_turn: dmgPT,
    };
    const emoji = catalog.emoji || '';
    const name  = catalog.name  || stateId;
    const desc  = catalog.description || '';
    lines.push(`${emoji} ${name} aplicado. ${desc}`);
  }

  return { applied: stateId, lines };
}

/**
 * Resuelve si la combinación existing+incoming activa una sinergia.
 * 
 * @param {string} existing  — ID del estado ya presente en el target
 * @param {string} incoming  — ID del estado que se está aplicando
 * @param {string} source    — Hechizo/habilidad que activa la sinergia
 * @returns {{ triggered: boolean, result: string, message: string, consumeExisting: boolean } | null}
 */
function resolveDebuffSynergy(existing, incoming, source) {
  const row = SINERGIA_TABLE[existing];
  if (!row) return null;
  const syn = row[incoming];
  if (!syn) return null;
  return {
    triggered:       true,
    result:          syn.result,
    message:         syn.message || `SINERGIA: ${existing} + ${incoming} → ${syn.result}`,
    consumeExisting: syn.consumeExisting ?? true,
    applyToPlayer:   syn.extra?.applyToPlayer ?? false,
    next_spell_bonus: syn.extra?.next_spell_bonus ?? null,
    resultTurns:     syn.resultTurns ?? null,
  };
}

/**
 * Procesa todos los estados activos en un target al inicio de su turno.
 * Aplica DoT (burning), decrementa duraciones, elimina expirados.
 * 
 * @param {object}   target — Monstruo o jugador con .status_effects y .hp
 * @param {string[]} lines  — Array de log (mutable — se agregan mensajes)
 * @returns {{ dead: boolean }}
 */
function tickDebuffs(target, lines) {
  if (!target.status_effects) return { dead: false };

  const toDelete = [];

  for (const [stateId, state] of Object.entries(target.status_effects)) {
    if (!state || typeof state !== 'object') continue;

    const catalog = STATE_CATALOG[stateId] || {};
    const emoji   = catalog.emoji || '';
    const name    = catalog.name  || stateId;

    // ─── Efectos por turno ───────────────────────────────────────────────
    if (state.dmg_per_turn > 0) {
      const dmg = state.dmg_per_turn * (state.stacks || 1);
      target.hp = (target.hp || 0) - dmg;
      lines.push(`${emoji} ${name}: ${dmg} daño por turno. HP restante: ${Math.max(target.hp, 0)}`);
      if (target.hp <= 0) {
        lines.push(`💀 ${name} terminó con ${target.name || 'el objetivo'}!`);
        return { dead: true };
      }
    }

    // ─── Decrementar turnos ──────────────────────────────────────────────
    state.turns = (state.turns || 1) - 1;
    if (state.turns <= 0) {
      toDelete.push(stateId);
      lines.push(`${emoji} ${name} expiró.`);
    }
  }

  for (const id of toDelete) {
    delete target.status_effects[id];
  }

  return { dead: false };
}

/**
 * Devuelve un string legible con los estados activos del target.
 * Para mostrar en el comando `status` o en el log de combate.
 * 
 * @param {object} target — Monstruo o jugador con .status_effects
 * @returns {string} — ej: "⚡ Aturdido (1t) | 🔥 Quemándose ×2 (2t)"
 *                     o "" si no tiene estados activos
 */
function describeDebuffs(target) {
  if (!target.status_effects || Object.keys(target.status_effects).length === 0) {
    return '';
  }

  const parts = [];

  for (const [stateId, state] of Object.entries(target.status_effects)) {
    if (!state || typeof state !== 'object') continue;
    // Saltar campos internos del sistema
    if (stateId.startsWith('__')) continue;

    const catalog = STATE_CATALOG[stateId] || {};
    const emoji   = catalog.emoji || '?';
    const name    = catalog.name  || stateId;
    const turns   = state.turns   || 0;
    const stacks  = state.stacks  || 1;

    let part = `${emoji} ${name} (${turns}t)`;
    if (stacks > 1) part = `${emoji} ${name} ×${stacks} (${turns}t)`;

    parts.push(part);
  }

  return parts.join(' | ');
}

// ─── Helpers de compatibilidad legacy ────────────────────────────────────────

/**
 * Chequea si un target tiene el estado activo (nuevo formato O legacy).
 * Legacy: target.status_effects.stunned = 1 o { turns: N }
 * Nuevo:  target.status_effects.stunned = { turns: N, source: '...', ... }
 * 
 * @param {object} target   — Monstruo o jugador
 * @param {string} stateId  — ID del estado a chequear
 * @returns {boolean}
 */
function hasDebuff(target, stateId) {
  if (!target.status_effects) return false;
  const state = target.status_effects[stateId];
  if (!state) return false;
  
  // Formato legacy: número entero
  if (typeof state === 'number') return state > 0;
  // Formato legacy: objeto sin turns
  if (typeof state === 'object' && state !== null) {
    if ('turns' in state) return state.turns > 0;
    return true; // objeto sin turns = activo
  }
  return false;
}

/**
 * Limpia un estado del target (compatibilidad con ambos formatos).
 */
function clearDebuff(target, stateId) {
  if (target.status_effects) {
    delete target.status_effects[stateId];
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  STATE_CATALOG,
  SINERGIA_TABLE,
  applyDebuff,
  resolveDebuffSynergy,
  tickDebuffs,
  describeDebuffs,
  hasDebuff,
  clearDebuff,
};
