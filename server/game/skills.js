/**
 * skills.js — Habilidades activas por nivel (T114)
 *
 * Al alcanzar ciertos niveles, el jugador desbloquea habilidades activas
 * que puede usar en combate con comandos explícitos y cooldown.
 *
 * Habilidades:
 *   - smash / golpetazo   (nivel 3): Ataque potente ×1.8 daño, cooldown 45s
 *   - shield_bash / escudo_bash (nivel 6): Daño normal + stun al monstruo 1 turno, cooldown 60s
 *   - rally / arenga      (nivel 10): En party, +2 ATK a todos en la sala por 60s
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
