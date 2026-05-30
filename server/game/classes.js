/**
 * classes.js — T107: Sistema de clases de personaje
 *
 * Tres clases disponibles, cada una con stats iniciales y bonificaciones:
 *   Guerrero: tanque, alto HP y ATK
 *   Mago:     frágil pero maná alto y hechizos potentes
 *   Pícaro:   equilibrado con bonificación de golpe crítico y esquiva
 */

const CLASSES = {
  guerrero: {
    name: 'Guerrero',
    emoji: '⚔️',
    description: 'Resistente y brutal. Más HP y ataque, pero poco maná.',
    hp: 35,
    max_hp: 35,
    attack: 6,
    defense: 4,
    mana: 10,
    max_mana: 10,
    crit_bonus: 0,     // % adicional de crítico (sobre la base del 10%)
    dodge_bonus: 0,    // % adicional de esquiva (sobre la base del 8%)
    spell_power: 1.0,  // multiplicador de daño de hechizos
    perks: ['HP máximo aumentado (+5)', 'Ataque inicial mayor (+1)', 'Defensa mejorada (+1)'],
  },
  mago: {
    name: 'Mago',
    emoji: '🔮',
    description: 'Frágil pero letales sus hechizos. Maná abundante y hechizos más potentes.',
    hp: 22,
    max_hp: 22,
    attack: 4,
    defense: 2,
    mana: 35,
    max_mana: 35,
    crit_bonus: 0,
    dodge_bonus: 0,
    spell_power: 1.5,  // hechizos hacen 50% más daño
    perks: ['Maná máximo aumentado (+15)', 'Hechizos 50% más potentes', 'Recarga de maná 2x más rápida'],
  },
  picaro: {
    name: 'Pícaro',
    emoji: '🗡️',
    description: 'Ágil y escurridizo. Más chances de crítico y de esquivar golpes.',
    hp: 28,
    max_hp: 28,
    attack: 5,
    defense: 3,
    mana: 15,
    max_mana: 15,
    crit_bonus: 15,    // 10% base + 15% = 25% de crítico total
    dodge_bonus: 12,   // 8% base + 12% = 20% de esquiva total
    spell_power: 1.0,
    perks: ['Crítico aumentado al 25%', 'Esquiva aumentada al 20%', 'Siempre actúa primero'],
  },
};

const CLASS_ALIASES = {
  guerrero: 'guerrero', warrior: 'guerrero', 'war': 'guerrero',
  mago: 'mago', mage: 'mago', wizard: 'mago', maga: 'mago',
  picaro: 'picaro', pícaro: 'picaro', rogue: 'picaro', ladron: 'picaro', ladrón: 'picaro',
};

/**
 * Normaliza el nombre de clase (sin tilde, minúsculas).
 */
function resolveClass(input) {
  if (!input) return null;
  const normalized = input.toLowerCase()
    .replace(/á/g, 'a').replace(/é/g, 'e').replace(/í/g, 'i')
    .replace(/ó/g, 'o').replace(/ú/g, 'u').replace(/ñ/g, 'n');
  return CLASS_ALIASES[normalized] || null;
}

/**
 * Retorna el objeto de clase para un jugador.
 */
function getPlayerClass(player) {
  const cls = player.player_class || 'sin_clase';
  return CLASSES[cls] || null;
}

/**
 * Retorna stats iniciales para una clase.
 */
function getClassStats(className) {
  return CLASSES[className] || null;
}

/**
 * Lista de clases formateada para mostrar al jugador.
 */
function formatClassList() {
  return Object.entries(CLASSES).map(([key, cls]) => {
    return [
      `  ${cls.emoji} ${cls.name.toUpperCase()} (clase ${key})`,
      `     ${cls.description}`,
      `     Stats: HP ${cls.hp} | ATK ${cls.attack} | DEF ${cls.defense} | Maná ${cls.mana}`,
      `     Ventajas: ${cls.perks.join(', ')}`,
    ].join('\n');
  }).join('\n\n');
}

module.exports = { CLASSES, resolveClass, getPlayerClass, getClassStats, formatClassList };
