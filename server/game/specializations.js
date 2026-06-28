/**
 * specializations.js — DIS-914: Sistema de Especializaciones de Clase (Subclases)
 *
 * Al nivel 5, el jugador elige una especialización permanente para su personaje.
 * Fase 1: 1 especialización por clase (Paladín, Evoker, Asesino, Sanador).
 * DIS-947: Fase 2 — segunda especialización para el Pícaro: Ladrón de Sombras.
 *
 * Estructura de cada especialización:
 *   id            — identificador interno (sin tildes)
 *   class         — clase requerida
 *   name          — nombre para mostrar
 *   emoji         — icono
 *   description   — descripción breve (30-50 palabras)
 *   flavor        — texto de sabor al especializarse
 *   passives      — array de strings descriptivos de bonuses pasivos
 *   new_commands  — array de strings con nuevos comandos desbloqueados
 *   combat_modifiers — objeto con modificadores para combat.js / engine.js
 */

const SPECIALIZATIONS = {

  // ─── GUERRERO ───────────────────────────────────────────────────────────────

  paladin: {
    id: 'paladin',
    class: 'guerrero',
    name: 'Paladín',
    emoji: '🛡️',
    description: 'El guerrero que combina fuerza y fe. Menos poderoso ofensivamente, pero casi imposible de matar.',
    flavor: '✨ La luz sagrada envuelve tu armadura. Sos un Paladín ahora — la fuerza de la fe es tu escudo.',
    passives: [
      '+2 DEF permanente',
      'Smash aplica Aturdido (el monstruo pierde 1 turno, 25% chance)',
      'Las pociones de salud curan +5 HP adicionales',
      'La reputación sube un 50% más rápido',
    ],
    new_commands: ['imposition'],
    combat_modifiers: {
      def_bonus: 2,
      smash_stun_chance: 0.25,
      potion_heal_bonus: 5,
      rep_multiplier: 1.5,
    },
  },

  // DIS-986: segunda especialización para el Guerrero
  berserker: {
    id: 'berserker',
    class: 'guerrero',
    name: 'Berserker',
    emoji: '🪓',
    description: 'Furia pura. El Berserker sacrifica defensa y autocuidado por daño devastador. Alto riesgo, alto rendimiento.',
    flavor: '🪓 La rabia te consume. Ya no sos un guerrero — sos una tormenta. Sos un Berserker.',
    passives: [
      '+3 ATK permanente, −1 DEF permanente',
      'Las pociones de salud curan −5 HP (el berserk descuida la autosanación)',
      'Habilidad `furia`: gasta todo el maná para multiplicar daño ×1.5 en el próximo ataque (cooldown 3 turnos)',
      'La reputación sube un 20% más lento (reputación de bruto)',
    ],
    new_commands: ['furia'],
    combat_modifiers: {
      atk_bonus: 3,
      def_penalty: 1,
      potion_heal_penalty: 5,
      rep_multiplier: 0.8,
    },
  },

  // ─── MAGO ────────────────────────────────────────────────────────────────────

  evoker: {
    id: 'evoker',
    class: 'mago',
    name: 'Evoker',
    emoji: '⚡',
    description: 'El mago que lleva el daño al límite. Frágil pero devastador. Sus hechizos de daño destruyen todo.',
    flavor: '⚡ Una descarga arcana recorre tu cuerpo. Sos un Evoker — cada hechizo es ahora una explosión.',
    passives: [
      'Hechizos de daño directo (rayo, bola de fuego) ganan +25% de daño adicional',
      'Canalización activa con ≤30% maná (era ≤20%)',
      'La resistencia mágica de bosses se reduce un 15%',
      'Al matar con hechizo: 20% chance de recuperar 2 maná (resonancia mágica)',
    ],
    new_commands: ['cast meteoro'],
    combat_modifiers: {
      spell_damage_bonus: 0.25,      // +25% daño a hechizos directos
      channeling_threshold: 0.30,    // Canalización activa con ≤30% maná
      boss_resist_reduction: 0.15,   // Resistencia mágica de bosses -15%
      mana_resonance_chance: 0.20,   // 20% chance de recuperar 2 maná al matar con hechizo
      mana_resonance_amount: 2,
    },
  },

  // ─── PÍCARO ──────────────────────────────────────────────────────────────────

  asesino: {
    id: 'asesino',
    class: 'picaro',
    name: 'Asesino',
    emoji: '🗡️',
    description: 'Un golpe definitivo. El Asesino vive y muere por el crítico. Emboscadas letales y veneno duradero.',
    flavor: '🗡️ Tu sombra se afila. Sos un Asesino — el primer golpe siempre deja marca.',
    passives: [
      'Crítico base +10% (pasivo permanente)',
      'El primer ataque de cada combate nuevo es siempre crítico (emboscada)',
      'El veneno aplicado dura 5 turnos en lugar de 3',
      'Al matar con crítico: 15% chance de loot doble',
    ],
    new_commands: ['emboscar'],
    combat_modifiers: {
      crit_bonus: 10,                // +10% a crit base
      ambush_first_crit: true,       // primer ataque en sala nueva es siempre crit
      poison_duration_bonus: 2,      // veneno dura 2 turnos extra (3→5)
      double_loot_on_crit_kill: 0.15, // 15% chance de loot doble al matar con crítico
    },
  },

  // DIS-947: segunda especialización para el Pícaro
  ladron: {
    id: 'ladron',
    class: 'picaro',
    name: 'Ladrón de Sombras',
    emoji: '🎭',
    description: 'El arte de tomar lo que no es tuyo. El Ladrón de Sombras acumula riqueza y desaparece sin dejar rastro. Sigilo mejorado, robo garantizado, ventas ventajosas.',
    flavor: '🎭 Tus dedos saben lo que hacen. Sos un Ladrón de Sombras — el oro de los otros siempre fue tuyo.',
    passives: [
      'Robar tiene 75% de chance de éxito (era 50%)',
      'Al matar un monstruo humanoide: 25% chance de obtener 3-8g adicional',
      'Vendés ítems a Aldric al 60% de su valor (era 40%)',
      'Sigilo dura 90 segundos (era 60s) y cooldown reducido a 45s (era 75s)',
    ],
    new_commands: ['desaparecer'],
    combat_modifiers: {
      rob_chance_bonus: 0.25,        // robar: 50% + 25% = 75% chance
      kill_gold_chance: 0.25,        // 25% chance de +3-8g al matar humanoides
      kill_gold_min: 3,
      kill_gold_max: 8,
      sell_bonus_ratio: 0.20,        // venta al 60% (SELL_PRICE_RATIO 0.4 + 0.2 = 0.6)
      sigilo_duration_bonus: 30,     // sigilo dura 30s extra (60→90s)
      sigilo_cooldown_reduction: 30, // cooldown 30s menos (75→45s)
    },
  },

  // ─── CLÉRIGO ─────────────────────────────────────────────────────────────────

  sanador: {
    id: 'sanador',
    class: 'clerigo',
    name: 'Sanador',
    emoji: '💚',
    description: 'La vida sobre todo. El Sanador mantiene al grupo vivo indefinidamente. Curación aumentada y fe inquebrantable.',
    flavor: '💚 Tu corazón late al ritmo de la luz divina. Sos un Sanador — la vida es tu arma más poderosa.',
    passives: [
      'sanacion_mayor ahora cura 30 HP (era 20)',
      'pray Xg da el doble de duración de bendición',
      'Al morir en PvE: 20% chance de resurrección automática con 5 HP (milagro)',
      'La penalidad de arma no-sagrada (×0.9) desaparece',
    ],
    new_commands: ['chain_heal'],
    combat_modifiers: {
      sanacion_mayor_hp: 30,         // cura 30 HP (era 20)
      pray_duration_multiplier: 2.0, // doble duración de bendición
      auto_resurrect_chance: 0.20,   // 20% chance de resurrección automática
      auto_resurrect_hp: 5,
      remove_nonsacred_penalty: true, // sin penalidad ×0.9 por arma no-sagrada
    },
  },

};

/**
 * Alias de entrada para el comando `especializar`.
 * Acepta con o sin tildes, variantes comunes.
 */
const SPEC_ALIASES = {
  paladin:    'paladin',
  paladín:    'paladin',
  berserker:  'berserker',
  berserk:    'berserker',
  furia:      'berserker',
  evoker:     'evoker',
  evocador:   'evoker',
  asesino:    'asesino',
  assassin:   'asesino',
  sanador:    'sanador',
  healer:     'sanador',
  ladron:     'ladron',
  ladrón:     'ladron',
  'ladron de sombras': 'ladron',
  'ladrón de sombras': 'ladron',
  shadowthief: 'ladron',
  shadow:     'ladron',
};

/**
 * Retorna la especialización para una clase dada (solo Fase 1).
 * Retorna array de objetos SPECIALIZATIONS que corresponden a esa clase.
 */
function getSpecsForClass(playerClass) {
  return Object.values(SPECIALIZATIONS).filter(s => s.class === playerClass);
}

/**
 * Normaliza el input del jugador y retorna el id de la especialización.
 */
function resolveSpec(input) {
  if (!input) return null;
  const normalized = input.toLowerCase().trim()
    .replace(/á/g, 'a').replace(/é/g, 'e').replace(/í/g, 'i')
    .replace(/ó/g, 'o').replace(/ú/g, 'u').replace(/ñ/g, 'n');
  return SPEC_ALIASES[normalized] || null;
}

/**
 * Retorna el objeto de especialización dado un id.
 */
function getSpec(specId) {
  return SPECIALIZATIONS[specId] || null;
}

module.exports = { SPECIALIZATIONS, getSpecsForClass, resolveSpec, getSpec };
