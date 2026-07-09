/**
 * skills.js — Habilidades activas por nivel (T114)
 *
 * Al alcanzar ciertos niveles, el jugador desbloquea habilidades activas
 * que puede usar en combate con comandos explícitos y cooldown.
 *
 * Habilidades (Guerrero/sin clase):
 *   - smash / golpetazo   (nivel 3): Ataque potente ×1.8 daño, cooldown 30s
 *   - shield_bash / escudo_bash (nivel 6): Daño normal + stun al monstruo 1 turno, cooldown 60s
 *   - rally / arenga      (nivel 10): En party, +2 ATK a todos en la sala por 60s
 *
 * Habilidades de Clérigo (DIS-612):
 *   - sanacion_mayor     (nivel 3): Cura 30 HP, 12 maná, cooldown 60s
 *   - bendicion          (nivel 6): Buff +2 DEF a todos en sala, 10 maná, cooldown 60s
 *   - resurreccion       (nivel 10): Revive a jugador muerto en la sala al 50% HP, una vez por sesión
 *
 * Habilidades de Pícaro (DIS-616):
 *   - golpe_sucio        (nivel 3): ×1.3 daño + veneno (3dmg×3 turnos), cooldown 50s
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
    cooldown_seconds: 30,  // DIS-1106: reducido de 45s a 30s para permitir usarlo 2 veces en peleas largas con jefes que regeneran
    type: 'attack',
    dmg_multiplier: 1.8,
    description: 'Un golpe devastador que hace ×1.8 del daño normal. Cooldown: 30s. No disponible contra enemigos con muy poco HP.',
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
  // BUG-1144: habilidad veneno Lv1 del Pícaro — aplica veneno al arma actual por 3 ataques
  veneno: {
    id: 'veneno',
    name: 'Veneno',
    aliases: ['veneno', 'envenenar', 'poison', 'impregnar', 'aplicar_veneno'],
    required_level: 1,
    required_class: 'picaro',
    cooldown_seconds: 90,
    type: 'picaro_poison_weapon',
    poison_charges: 3,
    poison_chance: 0.50,  // 50% de chance de envenenar por ataque (mejor que ítem de tienda 40%)
    poison_damage: 3,
    poison_turns: 3,
    description: 'Arte del Pícaro: impregnás tu arma con veneno extraído de tus suministros. Los próximos 3 ataques tienen 50% de envenenar al objetivo (3 dmg × 3 turnos). Cooldown: 90s. Solo Pícaro Lv1.',
    combat_only: false,  // se puede aplicar fuera de combate también
  },
  golpe_sucio: {
    id: 'golpe_sucio',
    name: 'Golpe Sucio',
    aliases: ['golpe_sucio', 'dirty_strike', 'golpe sucio', 'suciedad', 'golpe_envenenado', 'puñalada_trasera', 'punalada_trasera', 'backstab'],
    required_level: 3,
    required_class: 'picaro',
    cooldown_seconds: 50,
    type: 'poison_attack',
    dmg_multiplier: 1.3,
    poison_damage: 3,
    poison_turns: 3,
    description: 'Ataque traicionero: ×1.3 daño + veneno al monstruo (3 dmg × 3 turnos). Cooldown: 50s. Solo pícaro.',
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
    description: 'Canaliza la gracia divina: cura 30 HP base × 1.5 (heal_power Clérigo) = 45 HP efectivos. Cooldown: 60s. Solo Clérigo.',
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
    mana_cost: 4, // DIS-694: reducido de 10→6, DIS-765/DIS-767: reducido a 4 — Bendición no debe vaciar el maná del Clérigo, que lo necesita para heal
    description: 'Invoca una barrera sagrada: +2 DEF a todos los jugadores en la sala por 60s. Cooldown: 60s. Costo: 4 maná. Solo Clérigo.',
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
  // ── Habilidades exclusivas de Especializaciones (DIS-914) ─────────────────
  imposition: {
    id: 'imposition',
    name: 'Imposición de Fe',
    aliases: ['imposition', 'imposicion', 'imposición', 'fe_sagrada', 'luz_sagrada'],
    required_level: 5,
    required_class: 'guerrero',
    required_specialization: 'paladin',
    cooldown_seconds: 60,
    type: 'paladin_debuff',
    dmg_multiplier: 1.4,
    debuff_atk: 2,
    debuff_turns: 3,
    description: 'Golpe sagrado: ×1.4 daño + debilita al monstruo (-2 ATK por 3 turnos). Solo Paladín (nivel 5+). Cooldown: 60s.',
    combat_only: true,
  },
  // DIS-986: Furia del Berserker
  // DIS-1238: rediseñada — costo cambiado a HP (20% del max HP) para trade-off real
  furia: {
    id: 'furia',
    name: 'Furia',
    aliases: ['furia', 'rage', 'arrebato', 'berserkear'],
    required_level: 5,
    required_class: 'guerrero',
    required_specialization: 'berserker',
    cooldown_seconds: 60,
    type: 'berserker_rage',
    dmg_multiplier: 2.0,
    hp_cost_pct: 0.20, // DIS-1238: cuesta 20% del HP máximo
    description: 'Sacrificás 20% de tu HP máximo para hacer ×2.0 daño en el próximo ataque. ¡La sangre alimenta la rabia! Solo Berserker (nivel 5+). Cooldown: 60s.',
    combat_only: true,
  },
  // EPIC-1307-F5: Modo Berserk — estado de combate de 3 turnos
  modo_berserk: {
    id: 'modo_berserk',
    name: 'Modo Berserk',
    aliases: ['modo_berserk', 'modo berserk', 'desatar_ira', 'desatar ira', 'berserk_mode'],
    required_level: 5,
    required_class: 'guerrero',
    required_specialization: 'berserker',
    cooldown_seconds: 90,
    type: 'berserker_mode',
    atk_bonus: 5,
    duration_turns: 3,
    exhaustion_penalty: 2,     // −2 ATK durante agotamiento post-berserk
    exhaustion_turns: 2,       // duración del agotamiento
    description: 'Entrás en estado de combate alterado por 3 turnos: +5 ATK, sin postura defensiva, sin huida, inmune a slowed/frozen. Al terminar: −2 ATK por 2 turnos de agotamiento. Sin costo. Solo Berserker (nivel 5+). Cooldown: 90s.',
    combat_only: true,
  },
  // EPIC-1307-F5: Calmar Furia — cancela modo berserk
  calmar_furia: {
    id: 'calmar_furia',
    name: 'Calmar Furia',
    aliases: ['calmar_furia', 'calmar furia', 'calm_rage', 'calmar'],
    required_level: 5,
    required_class: 'guerrero',
    required_specialization: 'berserker',
    cooldown_seconds: 0,   // sin cooldown propio — se maneja por modo_berserk
    type: 'berserker_calm',
    description: 'Cancela el Modo Berserk activo: 1 turno sin acción (perdés el turno) pero habilitás la huida. Solo funciona mientras el Modo Berserk esté activo. Solo Berserker (nivel 5+).',
    combat_only: true,
  },
  // EPIC-1308-F5: Emboscada Oscura — activa shadow_points=3 instantáneamente
  emboscada_oscura: {
    id: 'emboscada_oscura',
    name: 'Emboscada Oscura',
    aliases: ['emboscada_oscura', 'emboscada oscura', 'shadow_ambush', 'oscura', 'dark_ambush'],
    required_level: 5,
    required_class: 'picaro',
    required_specialization: 'asesino',
    cooldown_seconds: 20,
    type: 'asesino_shadow_ambush',
    description: 'Activás instantáneamente 3 puntos de sombra — podés usar "sombras" de inmediato. Solo funciona si shadow_points < 3. Cooldown: 20s. Solo Asesino (nivel 5+).',
    combat_only: true,
  },
  // EPIC-1309-F5: Consagrar Sala — Paladín aplica aura +2 DEF por 60s
  consagrar_sala: {
    id: 'consagrar_sala',
    name: 'Consagrar Sala',
    aliases: ['consagrar_sala', 'consagrar sala', 'consagrar', 'bless_room', 'sanctify', 'sagrar', 'consagración'],
    required_level: 5,
    required_class: 'guerrero',
    required_specialization: 'paladin',
    cooldown_seconds: 120,
    type: 'paladin_sanctify',
    def_bonus: 2,
    duration_seconds: 60,
    mana_cost: 12,
    description: 'Consagrás la sala: +2 DEF a todos en ella durante 60s. Se pierde al moverte. En single: +4 DEF total (acumulado con tu +2 DEF permanente). Costo: 12 maná. Cooldown: 120s. Solo Paladín (nivel 5+).',
    combat_only: false,
  },
  emboscar: {
    id: 'emboscar',
    name: 'Emboscada',
    aliases: ['emboscar', 'emboscada', 'emboscar', 'ataque_sorpresa', 'surprise_attack'],
    required_level: 5,
    required_class: 'picaro',
    required_specialization: 'asesino',
    cooldown_seconds: 45,
    type: 'asesino_ambush',
    dmg_multiplier: 1.6,
    poison_damage: 4,
    poison_turns: 3,
    description: 'Crítico garantizado + veneno intensificado (4 dmg × 3 turnos; 5 si sos Asesino). El mejor momento para usarla es cuando tu crítico pasivo (primer ataque en sala nueva) ya fue gastado. Cooldown: 45s. Solo Asesino (nivel 5+).',
    combat_only: true,
  },
  chain_heal: {
    id: 'chain_heal',
    name: 'Cadena de Curación',
    aliases: ['chain_heal', 'cadena_curacion', 'cadena_curación', 'curación_grupal', 'curacion_grupal', 'aura_sanadora'],
    required_level: 5,
    required_class: 'clerigo',
    required_specialization: 'sanador',
    cooldown_seconds: 90,
    type: 'sanador_chain',
    heal_amount: 12,
    mana_cost: 15,
    description: 'Cura 12 HP a todos los jugadores en la sala (incluido vos). Solo Sanador (nivel 5+). Cooldown: 90s. Costo: 15 maná.',
    combat_only: false,
  },
  // DIS-1069: Escudo Sagrado — disponible para todos los Clérigos (nivel 3+); Sanador obtiene versión mejorada
  // EPIC-1304-F4: abierto a todos los Clérigos; el Sanador obtiene upgrade (25 HP vs 10 HP del Clérigo base)
  escudo_sagrado: {
    id: 'escudo_sagrado',
    name: 'Escudo Sagrado',
    aliases: ['escudo_sagrado', 'escudo sagrado', 'sacred_shield', 'barrera_sagrada', 'barrera sagrada', 'holy_shield', 'burbuja', 'bubble'],
    required_level: 3,
    required_class: 'clerigo',
    cooldown_seconds: 45,
    type: 'sanador_shield',
    shield_amount: 10,           // Clérigo base: 10 HP. Sanador: 25 HP (resuelto en engine.js)
    shield_amount_sanador: 25,   // EPIC-1304-F4: upgrade para especialización Sanador
    duration_seconds: 30,
    mana_cost: 10,
    description: 'Proyectás un escudo de luz divina: absorbe hasta 10 HP del próximo golpe recibido (dura 30s). El Sanador obtiene una versión mejorada (25 HP). Disponible para todos los Clérigos nivel 3+. Cooldown: 45s. Costo: 10 maná.',
    combat_only: false,
  },
  // DIS-1113: Drenar Arcano — Mago sin maná recupera esencia mágica al golpear
  drenar_arcano: {
    id: 'drenar_arcano',
    name: 'Drenar Arcano',
    aliases: ['drenar arcano', 'drenar_arcano', 'drain_mana', 'drenar', 'absorber_mana', 'absorber_arcano', 'robar_mana', 'siphon', 'drenar_energia', 'drenar energía'],
    required_level: 1,
    required_class: 'mago',
    cooldown_seconds: 45,
    type: 'mago_drain',
    mana_recover_min: 2,
    mana_recover_max: 4,
    description: 'Golpeás al monstruo con tu báculo y absorbés su esencia mágica (recuperás 2-4 maná). Útil cuando el maná llega a 0 para volver al combate arcano. Cooldown: 45s. Solo Mago.',
    combat_only: true,
  },
  // DIS-1072: Rayo Divino — skill del Clérigo especialización Juicio
  rayo_divino: {
    id: 'rayo_divino',
    name: 'Rayo Divino',
    aliases: ['rayo_divino', 'rayo divino', 'divine_ray', 'divine_smite', 'rayo sagrado', 'rayo_sagrado', 'condemn', 'condena'],
    required_level: 5,
    required_class: 'clerigo',
    required_specialization: 'juicio',
    cooldown_seconds: 60,
    type: 'juicio_smite',
    dmg_multiplier: 1.5,
    undead_dmg_bonus: 0.50,   // +50% extra contra no-muertos (acumulado con el pasivo)
    mana_cost: 12,
    description: 'Invocás el poder del Juicio: ×1.5 daño sagrado que IGNORA la defensa del monstruo. +50% daño adicional contra no-muertos. Solo Juicio (nivel 5+). Cooldown: 60s. Costo: 12 maná.',
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
function getUnlockedSkills(level, playerClass, playerSpecialization) {
  return ALL_SKILLS.filter(sk => {
    if (level < sk.required_level) return false;
    if (sk.required_class && playerClass !== sk.required_class) return false;
    // DIS-D304: excluir skills que no aplican a la clase
    if (sk.excluded_classes && sk.excluded_classes.includes(playerClass)) return false;
    // BUG-998: excluir skills de especialización que no coincidan con la del jugador
    if (sk.required_specialization && playerSpecialization !== sk.required_specialization) return false;
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
      const classNames = { picaro: 'Pícaro', mago: 'Mago', guerrero: 'Guerrero', clerigo: 'Clérigo' };
      const requiredName = classNames[skill.required_class] || skill.required_class;
      return { ok: false, error: `${skill.name} es una habilidad exclusiva del ${requiredName}.` };
    }
  }

  // Verificar especialización requerida (DIS-914)
  if (skill.required_specialization) {
    const playerSpec = player.specialization || null;
    if (playerSpec !== skill.required_specialization) {
      const specNames = { paladin: 'Paladín', evoker: 'Evoker', asesino: 'Asesino', sanador: 'Sanador', berserker: 'Berserker', ladron: 'Ladrón de Sombras' };
      const requiredName = specNames[skill.required_specialization] || skill.required_specialization;
      if (!playerSpec) {
        return { ok: false, error: `${skill.name} requiere la especialización ${requiredName}. Elegí tu especialización con "especializar" al nivel 5.` };
      }
      return { ok: false, error: `${skill.name} es exclusivo del ${requiredName}. Tu especialización es ${specNames[playerSpec] || playerSpec}.` };
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
