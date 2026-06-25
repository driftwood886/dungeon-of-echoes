/**
 * specializations.js — DIS-914: Sistema de Especializaciones de Clase (Subclases)
 *
 * Al nivel 5, el jugador elige una especialización permanente para su personaje.
 * Fase 1: 1 especialización por clase (Paladín, Evoker, Asesino, Sanador).
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
  evoker:     'evoker',
  evocador:   'evoker',
  asesino:    'asesino',
  assassin:   'asesino',
  sanador:    'sanador',
  healer:     'sanador',
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
