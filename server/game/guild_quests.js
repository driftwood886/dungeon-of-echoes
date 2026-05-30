/**
 * guild_quests.js — Sistema de quests colectivas de guild (T189)
 *
 * Cada guild tiene una quest activa en todo momento.
 * Los miembros contribuyen al progreso con sus acciones (kills, crafteos, oro).
 * Al completar, todos los miembros activos reciben +50 XP, +30 oro, +10 reputación.
 * Luego se genera automáticamente una nueva quest.
 *
 * Almacenamiento: columna `guild_quest` JSON en tabla guilds
 */

'use strict';

// ─── Catálogo de quests de guild ──────────────────────────────────────────────

const GUILD_QUEST_CATALOG = [
  {
    id: 'gq_slayer_goblin',
    title: '¡Exterminación de Goblins!',
    description: 'Entre todos, eliminen 8 Goblins del dungeon.',
    type: 'kill',
    target: 'Goblin',
    goal: 8,
  },
  {
    id: 'gq_slayer_skeleton',
    title: 'La Purga Colectiva',
    description: 'Derroten juntos 6 Esqueletos Guerreros.',
    type: 'kill',
    target: 'Esqueleto Guerrero',
    goal: 6,
  },
  {
    id: 'gq_slayer_spider',
    title: 'Limpieza de Arañas',
    description: 'Cacen 5 Arañas Tejedoras entre los miembros del guild.',
    type: 'kill',
    target: 'Araña Tejedora',
    goal: 5,
  },
  {
    id: 'gq_slayer_bat',
    title: 'Plaga de Murciélagos',
    description: 'Entre todos los miembros, eliminen 6 Murciélagos Vampiro.',
    type: 'kill',
    target: 'Murciélago Vampiro',
    goal: 6,
  },
  {
    id: 'gq_boss_hunt',
    title: '¡Caza al Lich!',
    description: 'Un miembro del guild debe derrotar al Lich Anciano.',
    type: 'kill',
    target: 'Lich Anciano',
    goal: 1,
  },
  {
    id: 'gq_gold_hoard',
    title: 'Tesoro del Guild',
    description: 'Acumulen entre todos 150 monedas de oro (recolectadas del suelo).',
    type: 'gold',
    goal: 150,
  },
  {
    id: 'gq_crafting',
    title: 'Taller del Guild',
    description: 'Craftéen juntos 5 ítems en el dungeon.',
    type: 'craft',
    goal: 5,
  },
  {
    id: 'gq_slayer_orc',
    title: 'La Horda de Orcos',
    description: 'Derroten 7 monstruos de tipo orco o guardia entre todos.',
    type: 'kill',
    target: 'Orco',
    goal: 7,
  },
  {
    id: 'gq_slayer_undead',
    title: 'Purgar a los No-Muertos',
    description: 'Eliminen 10 criaturas no-muertas entre todos (Esqueletos o Fantasmas).',
    type: 'kill_multi',
    targets: ['Esqueleto Guerrero', 'Espectro', 'Fantasma', 'Guardia Espectral', 'Campeón Espectral'],
    goal: 10,
  },
  {
    id: 'gq_gold_medium',
    title: 'Comerciantes del Dungeon',
    description: 'Recolecten 100 monedas de oro entre todos los miembros.',
    type: 'gold',
    goal: 100,
  },
];

// ─── Helpers internos ─────────────────────────────────────────────────────────

/**
 * Parsear guild_quest JSON de la tabla guilds.
 * Si no hay quest activa (null/vacío), genera una nueva y retorna sus datos.
 */
function parseGuildQuest(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

/**
 * Elegir una quest nueva para el guild.
 * Opcionalmente excluir la última quest (para evitar repetir seguido).
 */
function pickNewQuest(excludeId = null) {
  const choices = GUILD_QUEST_CATALOG.filter(q => q.id !== excludeId);
  const def = choices[Math.floor(Math.random() * choices.length)];
  return {
    id: def.id,
    title: def.title,
    description: def.description,
    type: def.type,
    target: def.target || null,
    targets: def.targets || null,
    goal: def.goal,
    total: 0,
    contributions: {},     // { playerId: count }
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
}

/**
 * Verificar si un evento de kill aplica a la quest activa.
 */
function killMatchesQuest(quest, monsterName) {
  if (quest.type === 'kill') {
    return monsterName && monsterName.includes(quest.target);
  }
  if (quest.type === 'kill_multi') {
    return quest.targets && quest.targets.some(t => monsterName && monsterName.includes(t));
  }
  return false;
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Obtener o crear la quest activa de un guild.
 * @param {object} guild   — fila de la tabla guilds (con columna guild_quest)
 * @returns {object}       — quest activa (parsed)
 */
function getOrCreateGuildQuest(guild) {
  let quest = parseGuildQuest(guild.guild_quest);
  if (!quest) {
    quest = pickNewQuest();
  }
  return quest;
}

/**
 * Registrar contribución de un miembro.
 * @param {object} guild          — fila de la tabla guilds
 * @param {string} playerId       — ID del jugador
 * @param {string} type           — 'kill' | 'gold' | 'craft'
 * @param {object} data           — { monsterName?, amount? }
 * @returns {{ quest, contributed, justCompleted, newQuest }} | null
 */
function recordGuildQuestContribution(guild, playerId, type, data = {}) {
  const quest = getOrCreateGuildQuest(guild);

  // Si ya está completada, retornar null (pending nueva quest)
  if (quest.completedAt) return null;

  // ¿Aplica este evento?
  let applies = false;
  let amount = 1;

  if (type === 'kill') {
    applies = (quest.type === 'kill' || quest.type === 'kill_multi')
      && killMatchesQuest(quest, data.monsterName);
  } else if (type === 'gold') {
    applies = quest.type === 'gold';
    amount = data.amount || 0;
    if (amount <= 0) applies = false;
  } else if (type === 'craft') {
    applies = quest.type === 'craft';
  }

  if (!applies) return null;

  // Actualizar progreso
  quest.contributions = quest.contributions || {};
  quest.contributions[playerId] = (quest.contributions[playerId] || 0) + amount;
  quest.total = Object.values(quest.contributions).reduce((s, v) => s + v, 0);

  const justCompleted = quest.total >= quest.goal;
  let newQuest = null;

  if (justCompleted && !quest.completedAt) {
    quest.completedAt = new Date().toISOString();
    // Generar la siguiente quest (excluyendo la actual)
    newQuest = pickNewQuest(quest.id);
  }

  return { quest, contributed: amount, justCompleted, newQuest };
}

/**
 * Formatear el estado de la quest de guild para mostrar al jugador.
 * @param {object} guild
 * @param {string} [playerId]   — Para destacar contribución personal
 */
function formatGuildQuest(guild, playerId = null) {
  const quest = getOrCreateGuildQuest(guild);

  const barLen = 8;
  const filled = Math.min(barLen, Math.round(((quest.total || 0) / quest.goal) * barLen));
  const bar = '[' + '█'.repeat(filled) + '░'.repeat(barLen - filled) + ']';

  const rewardStr = '+50 XP · +30 🪙 · +10 Reputación a todos';

  const lines = [
    `╔══ ⚔ MISIÓN DE HERMANDAD: [${guild.name}] ══╗`,
    `  ${quest.title}`,
    `  ${quest.description}`,
    `  Progreso: ${bar} ${quest.total || 0}/${quest.goal}`,
  ];

  if (playerId && quest.contributions) {
    const myContrib = quest.contributions[playerId] || 0;
    if (myContrib > 0) {
      lines.push(`  Tu aporte: ${myContrib} (${Math.round((myContrib / quest.goal) * 100)}%)`);
    }
  }

  if (quest.completedAt) {
    lines.push(`  ✅ ¡Misión completada! (${new Date(quest.completedAt).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })})`);
  } else {
    lines.push(`  Recompensa: ${rewardStr}`);
  }

  lines.push(`╚${'═'.repeat(lines[0].length - 2)}╝`);
  return lines.join('\n');
}

module.exports = {
  getOrCreateGuildQuest,
  recordGuildQuestContribution,
  formatGuildQuest,
  pickNewQuest,
  GUILD_QUEST_CATALOG,
};
