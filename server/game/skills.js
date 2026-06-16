/**
 * skills.js — Habilidades activas por nivel (T114)
 *
 * Al alcanzar ciertos niveles, el jugador desbloquea habilidades activas
 * que puede usar en combate con comandos explícitos y cooldown.
 *
 * Habilidades (Guerrero/sin clase):
 *   - smash / golpetazo   (nivel 3): Ataque potente ×1.8 daño, cooldown 45s
 *   - shield_bash / escudo_bash (nivel 6): Daño normal + stun al monstruo 1 turno, cooldown 60s
 *   - rally / arenga      (nivel 10): En party, +2 ATK a todos en la sala por 60s
 *
 * Habilidades de Clérigo (DIS-612):
 *   - sanacion_mayor     (nivel 3): Cura 30 HP, 12 maná, cooldown 60s
 *   - bendicion          (nivel 6): Buff +2 DEF a todos en sala, 10 maná, cooldown 60s
 *   - resurreccion       (nivel 10): Revive a jugador muerto en la sala al 50% HP, una vez por sesión
 *
 * Habilidades de Pícaro (DIS-616):
 *   - golpe_sucio        (nivel 3): ×1.5 daño + veneno (3dmg×3 turnos), cooldown 50s
 *   - evasion            (nivel 6): Esquiva garantizada 1 turno, cooldown 90s
 *   - golpe_sombra       (nivel 10): ×2.5 daño si el monstruo no atacó este turno, cooldown 90s
 */

'use strict';

// Catálogo de habilidades
const SKILLS = {
  smash: {
    id: 'smash',
    name: 'Golpetazo',
    aliases: ['smash', 'golpetazo', 'golpe_potente', 'destrozo'],
    required_level: 3,
    cooldown_seconds: 45,
    type: 'attack',
    dmg_multiplier: 1.8,
    description: 'Un golpe devastador que hace ×1.8 del daño normal. Cooldown: 45s.',
    combat_only: true,
    excluded_classes: ['mago', 'clerigo', 'picaro'],  // DIS-D304: Mago usa hechizos; DIS-612: Clérigo tiene habilidades propias; DIS-616: Pícaro tiene habilidades propias
  },
  shield_bash: {
    id: 'shield_bash',
    name: 'Golpe de Escudo',
    aliases: ['shield_bash', 'escudo_bash', 'bash', 'escudazo', 'golpe_escudo'],
    required_level: 6,
    cooldown_seconds: 60,
    type: 'stun_attack',
    dmg_multiplier: 1.0,
    stun_turns: 1,
    description: 'Golpea con el escudo: daño normal + aturde al monstruo 1 turno. Cooldown: 60s.',
    combat_only: true,
    excluded_classes: ['mago', 'clerigo', 'picaro'],  // DIS-D304, DIS-612, DIS-616
  },
  rally: {
    id: 'rally',
    name: 'Arenga',
    aliases: ['rally', 'arenga', 'motivar', 'animar', 'grito_batalla'],
    required_level: 10,
    cooldown_seconds: 120,
    type: 'buff_party',
    atk_bonus: 2,
    duration_seconds: 60,
    description: 'Arenga a tu grupo: +2 ATK a todos en la sala por 60s. Requiere grupo. Cooldown: 2 min.',
    combat_only: false,
    excluded_classes: ['mago', 'clerigo', 'picaro'],  // DIS-D304, DIS-612, DIS-616
  },
  // ── Habilidades exclusivas del Pícaro (BUG-271) ──────────────────────────
  robar: {
    id: 'robar',
    name: 'Robar',
    aliases: ['robar', 'steal', 'hurtar', 'pickpocket', 'sustraer'],
    required_level: 1,
    required_class: 'picaro',
    cooldown_seconds: 60,
    type: 'steal',
    description: 'Intenta robar monedas a un monstruo vivo. 50% de éxito (+15% por cada nivel de ventaja). Si falla, el monstruo ataca. Cooldown: 60s. Solo pícaro.',
    combat_only: false,  // funciona con o sin combate activo
  },
  golpe_sucio: {
    id: 'golpe_sucio',
    name: 'Golpe Sucio',
    aliases: ['golpe_sucio', 'dirty_strike', 'golpe sucio', 'suciedad', 'golpe_envenenado', 'puñalada_trasera', 'punalada_trasera', 'backstab'],
    required_level: 3,
    required_class: 'picaro',
    cooldown_seconds: 50,
    type: 'poison_attack',
    dmg_multiplier: 1.5,
    poison_damage: 3,
    poison_turns: 3,
    description: 'Ataque traicionero: ×1.5 daño + veneno al monstruo (3 dmg × 3 turnos). Cooldown: 50s. Solo pícaro.',
    combat_only: true,
  },
  // ── Habilidades exclusivas del Pícaro nivel 6 y 10 (DIS-616) ─────────────
  evasion: {
    id: 'evasion',
    name: 'Evasión',
    aliases: ['evasion', 'evasión', 'evadir', 'esquivar', 'dodge', 'esquive'],
    required_level: 6,
    required_class: 'picaro',
    cooldown_seconds: 90,
    type: 'picaro_evasion',
    description: 'Te colocás en posición defensiva perfecta: esquiva garantizada ante el próximo ataque recibido. Cooldown: 90s. Solo Pícaro.',
    combat_only: false,
  },
  golpe_sombra: {
    id: 'golpe_sombra',
    name: 'Golpe en la Sombra',
    aliases: ['golpe_sombra', 'sombra', 'shadow_strike', 'golpe en la sombra', 'ataque_sombra', 'backstab_avanzado'],
    required_level: 10,
    required_class: 'picaro',
    cooldown_seconds: 90,
    type: 'picaro_shadow',
    dmg_multiplier: 2.5,
    description: 'Ataque desde las sombras: ×2.5 daño si el monstruo no te atacó este turno (primer golpe del combate o turno sin contraataque). Cooldown: 90s. Solo Pícaro.',
    combat_only: true,
  },
  // ── Habilidades exclusivas del Clérigo (DIS-612) ─────────────────────────
  sanacion_mayor: {
    id: 'sanacion_mayor',
    name: 'Sanación Mayor',
    aliases: ['sanacion_mayor', 'sanación_mayor', 'sanacion mayor', 'sanación mayor', 'gran_curacion', 'gran_curación', 'big_heal'],
    required_level: 3,
    required_class: 'clerigo',
    cooldown_seconds: 60,
    type: 'cleric_heal',
    heal_amount: 30,
    mana_cost: 12,
    description: 'Canaliza la gracia divina: cura 30 HP instantáneamente. Cooldown: 60s. Solo Clérigo.',
    combat_only: false,
  },
  bendicion: {
    id: 'bendicion',
    name: 'Bendición',
    aliases: ['bendicion', 'bendición', 'bless', 'blesear', 'bendecir', 'consagrar'],
    required_level: 6,
    required_class: 'clerigo',
    cooldown_seconds: 60,
    type: 'cleric_buff',
    def_bonus: 2,
    duration_seconds: 60,
    mana_cost: 10,
    description: 'Invoca una barrera sagrada: +2 DEF a todos los jugadores en la sala por 60s. Cooldown: 60s. Solo Clérigo.',
    combat_only: false,
  },
  resurreccion: {
    id: 'resurreccion',
    name: 'Resurrección',
    aliases: ['resurreccion', 'resurrección', 'resurrect', 'revivir', 'revive', 'resucitar'],
    required_level: 10,
    required_class: 'clerigo',
    cooldown_seconds: 0,  // Una vez por sesión — manejo especial
    type: 'cleric_resurrect',
    heal_percent: 50,
    description: 'Reza por el alma de un aliado caído en la misma sala y lo revive al 50% de HP. Una vez por sesión. Solo Clérigo.',
    combat_only: false,
  },
};

/**
 * Todas las habilidades como array.
 */
const ALL_SKILLS = Object.values(SKILLS);

/**
 * Dado un alias, devuelve el skill ID canónico o null.
 * @param {string} alias
 * @returns {string|null}
 */
function resolveSkillAlias(alias) {
  const a = alias.toLowerCase().replace(/[-\s]/g, '_');
  for (const sk of ALL_SKILLS) {
    if (sk.aliases.includes(a)) return sk.id;
  }
  return null;
}

/**
 * Devuelve las habilidades disponibles para el nivel y clase dados.
 * @param {number} level
 * @param {string} [playerClass] — 'picaro', 'mago', 'guerrero', etc.
 * @returns {object[]}
 */
function getUnlockedSkills(level, playerClass) {
  return ALL_SKILLS.filter(sk => {
    if (level < sk.required_level) return false;
    if (sk.required_class && playerClass !== sk.required_class) return false;
    // DIS-D304: excluir skills que no aplican a la clase
    if (sk.excluded_classes && sk.excluded_classes.includes(playerClass)) return false;
    return true;
  });
}

/**
 * Devuelve los cooldowns del jugador como objeto { skill_id: expiresAt_iso }.
 * @param {object} player — fila del jugador desde la BD
 * @returns {object}
 */
function getCooldowns(player) {
  if (!player.skill_cooldowns) return {};
  try { return JSON.parse(player.skill_cooldowns); } catch (_) { return {}; }
}

/**
 * Verifica si el jugador puede usar una habilidad (nivel suficiente + sin cooldown).
 * @param {object} player
 * @param {string} skillId
 * @returns {{ ok: boolean, error?: string, skill?: object }}
 */
function canUseSkill(player, skillId) {
  const skill = SKILLS[skillId];
  if (!skill) return { ok: false, error: `Habilidad "${skillId}" no existe.` };

  const level = player.level || 1;
  if (level < skill.required_level) {
    return { ok: false, error: `Necesitás nivel ${skill.required_level} para usar ${skill.name}. (Sos nivel ${level})` };
  }

  // Verificar clase requerida (BUG-271)
  if (skill.required_class) {
    const playerClass = player.player_class || player.class || null;
    if (playerClass !== skill.required_class) {
      const classNames = { picaro: 'Pícaro', mago: 'Mago', guerrero: 'Guerrero' };
      const requiredName = classNames[skill.required_class] || skill.required_class;
      return { ok: false, error: `${skill.name} es una habilidad exclusiva del ${requiredName}.` };
    }
  }

  const cooldowns = getCooldowns(player);
  const expiresAt = cooldowns[skillId];
  if (expiresAt) {
    const remaining = Math.ceil((new Date(expiresAt) - Date.now()) / 1000);
    if (remaining > 0) {
      return { ok: false, error: `${skill.name} está en cooldown: ${remaining}s restantes.` };
    }
  }

  return { ok: true, skill };
}

/**
 * Genera el nuevo valor de skill_cooldowns tras usar una habilidad.
 * @param {object} player
 * @param {string} skillId
 * @returns {string} JSON string con los cooldowns actualizados
 */
function applyCooldown(player, skillId) {
  const skill = SKILLS[skillId];
  if (!skill) return player.skill_cooldowns || '{}';
  const cooldowns = getCooldowns(player);
  const expiresAt = new Date(Date.now() + skill.cooldown_seconds * 1000).toISOString();
  cooldowns[skillId] = expiresAt;
  return JSON.stringify(cooldowns);
}

module.exports = { SKILLS, ALL_SKILLS, resolveSkillAlias, getUnlockedSkills, getCooldowns, canUseSkill, applyCooldown };
