/**
 * quests.js — Sistema de quests/misiones (T086)
 *
 * Hay una quest "global activa" en cada momento.
 * Cada jugador puede completar la quest una vez y obtener la recompensa.
 * Cuando todos la completan (o tras 30 minutos), una nueva quest comienza.
 *
 * Columna `quest_progress` en players: JSON con { questId, progress }
 * La quest activa se guarda en memoria + se persiste en un archivo JSON.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// Archivo de quest activa (persiste en disco junto a la BD)
const QUEST_FILE = path.join(__dirname, '../../db/quest.json');

// ─── Catálogo de quests ────────────────────────────────────────────────────────

const QUEST_CATALOG = [
  {
    id: 'slayer_goblin',
    title: '¡Exterminador de Goblins!',
    description: 'Los goblins se han multiplicado en el dungeon. Elimina 2 Goblins Merodeadores para recibir tu recompensa.', // DIS-1174: 3→2 kills — solo hay 1 goblin en sala 2 (respawn 3min), 3 era frustrante
    type: 'kill',
    target: 'Goblin',
    goal: 2,
    minLevel: 1,
    reward: { gold: 30, xp: 50 },
  },
  {
    id: 'slayer_skeleton',
    title: 'La Purga de los Esqueletos',
    description: 'El necromante ha invocado esqueletos. Derrota 3 Esqueletos Guerreros y el dungeon te recompensará.',
    type: 'kill',
    target: 'Esqueleto Guerrero',
    goal: 3,
    minLevel: 1,
    reward: { gold: 40, xp: 60 },
  },
  {
    id: 'slayer_spider',
    title: 'La Caza de Arañas',
    description: 'Las arañas tejedoras bloquean los pasillos. Elimina 2 Arañas Tejedoras.',
    type: 'kill',
    target: 'Araña Tejedora',
    goal: 2,
    minLevel: 1,
    reward: { gold: 35, xp: 55 },
  },
  {
    id: 'gold_collector',
    title: 'Acumulador de Riquezas',
    description: 'El mercader busca aventureros ricos. Acumula 50 monedas de oro (cantidad total, no neta).',
    type: 'gold',
    goal: 50,
    minLevel: 1,
    reward: { gold: 25, xp: 40 },
  },
  {
    id: 'slayer_bat',
    title: 'Plaga de Murciélagos',
    description: 'Los murciélagos vampiro han infestado las cuevas. Elimina 3 Murciélagos Vampiro.',
    type: 'kill',
    target: 'Murciélago Vampiro',
    goal: 3,
    minLevel: 1,
    reward: { gold: 30, xp: 45 },
  },
  {
    id: 'boss_slayer',
    title: '¡El Exterminador del Lich!',
    description: 'El Lich Anciano amenaza el dungeon. ¡Derrota al Lich Anciano y serás recompensado!',
    type: 'kill',
    target: 'Lich Anciano',
    goal: 1,
    minLevel: 10,
    reward: { gold: 100, xp: 150 },
  },
];

// ─── Estado en memoria ─────────────────────────────────────────────────────────

let activeQuest = null; // { questDef, startedAt, completedBy: Set<playerId> }

// ─── Persistencia ─────────────────────────────────────────────────────────────

function loadQuest() {
  try {
    if (fs.existsSync(QUEST_FILE)) {
      const raw = JSON.parse(fs.readFileSync(QUEST_FILE, 'utf8'));
      const def = QUEST_CATALOG.find(q => q.id === raw.questId);
      if (def) {
        activeQuest = {
          questDef: def,
          startedAt: raw.startedAt,
          completedBy: new Set(raw.completedBy || []),
        };
        console.log(`[quests] Quest activa cargada: ${def.title}`);
        return;
      }
    }
  } catch (_) {}
  startNewQuest();
}

function saveQuest() {
  if (!activeQuest) return;
  try {
    const dir = path.dirname(QUEST_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(QUEST_FILE, JSON.stringify({
      questId: activeQuest.questDef.id,
      startedAt: activeQuest.startedAt,
      completedBy: [...activeQuest.completedBy],
    }));
  } catch (err) {
    console.error('[quests] Error al guardar quest:', err.message);
  }
}

function startNewQuest(excludeId = null, maxPlayerLevel = 1) {
  // DIS-1128: Excluir quests con minLevel > maxPlayerLevel para no asignar quests imposibles
  const choices = QUEST_CATALOG.filter(q => q.id !== excludeId && (q.minLevel || 1) <= Math.max(maxPlayerLevel, 5));
  const pool = choices.length > 0 ? choices : QUEST_CATALOG.filter(q => q.id !== excludeId);
  const def = pool[Math.floor(Math.random() * pool.length)];
  activeQuest = {
    questDef: def,
    startedAt: new Date().toISOString(),
    completedBy: new Set(),
  };
  saveQuest();
  console.log(`[quests] Nueva quest iniciada: ${def.title}`);
  return activeQuest;
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Obtener la quest activa.
 */
function getActiveQuest() {
  if (!activeQuest) loadQuest();
  return activeQuest;
}

/**
 * Obtener progreso de un jugador en la quest activa.
 * questProgress: columna JSON { questId, progress, goldEarned }
 */
function getPlayerProgress(player) {
  const quest = getActiveQuest();
  if (!quest) return null;

  let qp;
  try {
    qp = JSON.parse(player.quest_progress || '{}');
  } catch (_) {
    qp = {};
  }

  const def = quest.questDef;
  const progress = (qp.questId === def.id) ? (qp.progress || 0) : 0;
  const completed = quest.completedBy.has(player.id);

  return {
    quest: def,
    progress,
    goal: def.goal,
    completed,
    remaining: Math.max(0, def.goal - progress),
  };
}

/**
 * Registrar progreso de un jugador.
 * type: 'kill' con monsterName, o 'gold' con amount
 * Devuelve { newProgress, justCompleted, reward } o null si no aplica.
 */
function recordProgress(player, type, data = {}) {
  const quest = getActiveQuest();
  if (!quest) return null;

  const def = quest.questDef;

  // ¿Aplica este evento a la quest?
  if (def.type === 'kill' && type === 'kill') {
    if (!def.target || !data.monsterName || !data.monsterName.includes(def.target)) {
      return null;
    }
  } else if (def.type === 'gold' && type === 'gold') {
    // OK
  } else {
    return null;
  }

  // ¿Ya completó el jugador esta quest?
  if (quest.completedBy.has(player.id)) return null;

  // Obtener progreso actual
  let qp;
  try {
    qp = JSON.parse(player.quest_progress || '{}');
  } catch (_) {
    qp = {};
  }

  if (qp.questId !== def.id) {
    qp = { questId: def.id, progress: 0, goldEarned: 0 };
  }

  // Incrementar
  if (def.type === 'kill') {
    qp.progress = (qp.progress || 0) + 1;
  } else if (def.type === 'gold') {
    qp.goldEarned = (qp.goldEarned || 0) + (data.amount || 0);
    qp.progress = qp.goldEarned;
  }

  const newProgress = qp.progress;
  const justCompleted = newProgress >= def.goal;

  let reward = null;
  if (justCompleted) {
    quest.completedBy.add(player.id);
    reward = def.reward;
    saveQuest();
  }

  return { newProgress, justCompleted, reward, questProgress: JSON.stringify(qp) };
}

/**
 * Rotar quest si pasaron 30 minutos o si se pide explícitamente.
 * Retorna la nueva quest si rotó, null si no.
 */
function maybeRotateQuest() {
  if (!activeQuest) return null;
  const ageMs = Date.now() - new Date(activeQuest.startedAt).getTime();
  const thirtyMin = 30 * 60 * 1000;
  if (ageMs >= thirtyMin) {
    return startNewQuest(activeQuest.questDef.id);
  }
  return null;
}

/**
 * Formato de texto para mostrar la quest activa.
 */
function formatQuest(player) {
  const info = getPlayerProgress(player);
  if (!info) return 'No hay quest activa en este momento.';

  const { quest, progress, goal, completed, remaining } = info;
  const rewardStr = `${quest.reward.gold}g + ${quest.reward.xp} XP`;

  const barLen = 8;
  const filled = Math.min(barLen, Math.round((progress / goal) * barLen));
  const bar = '[' + '█'.repeat(filled) + '░'.repeat(barLen - filled) + ']';

  if (completed) {
    return [
      `══ 📜 QUEST ACTIVA: ${quest.title} ══`,
      quest.description,
      `✅ ¡Ya completaste esta quest! Recompensa recibida: ${rewardStr}`,
      `(Una nueva quest llegará cuando esta expire o en la próxima sesión)`,
    ].join('\n');
  }

  // Fix DIS-011: indicar dónde encontrar el objetivo (para quests tipo kill)
  let locationHint = '';
  if (quest.type === 'kill' && quest.target) {
    try {
      const db = require('../db/db');
      const allMonsters = db.getAllMonsters();
      const allRooms = db.getAllRooms ? db.getAllRooms() : [];
      // Buscar monstruo con ese nombre (puede estar vivo o en respawn_room)
      // DIS-1071: excluir Goblin de Práctica (id=20) — no cuenta para quests y confunde al señalar sala 16
      const matchMonsters = allMonsters.filter(m => {
        if (m.id === 20) return false; // Goblin de Práctica: excluido de quests (DIS-1032/DIS-1071)
        const normalize = s => s.toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '');
        return normalize(m.name).includes(normalize(quest.target));
      });
      if (matchMonsters.length > 0) {
        const roomIds = [...new Set(matchMonsters.map(m => m.respawn_room_id || m.room_id).filter(Boolean))];
        const roomNames = roomIds.map(rid => {
          const r = allRooms.find(rm => rm.id === rid);
          return r ? `sala ${rid} (${r.name})` : `sala ${rid}`;
        });
        if (roomNames.length > 0) {
          locationHint = `\n📍 Dónde encontrarlos: ${roomNames.join(', ')}`;
        }
      }
    } catch (_) {
      // Si falla no romper el quest display
    }
  }

  // DIS-1235: hint de ubicación de arañas — aclarar que hay una en sala 7 sin llave, segunda vía Santuario
  let accessHint = '';
  if (quest.id === 'slayer_spider') {
    // DIS-1191: verificar si el jugador ya tiene la llave
    const playerInventory = Array.isArray(player.inventory)
      ? player.inventory
      : (() => { try { return JSON.parse(player.inventory || '[]'); } catch (_) { return []; } })();
    const playerHasKey = playerInventory.some(i => typeof i === 'string' && i.toLowerCase() === 'llave oxidada');
    if (playerHasKey) {
      accessHint = [
        '',
        '🕷️ Las Arañas Tejedoras están en el Pozo Sin Fondo (sala 7) — podés llegar directamente.',
        '🔑 Con tu llave oxidada podés cruzar al Santuario Profano (puerta norte de sala 7) para más arañas.',
      ].join('\n');
    } else {
      accessHint = [
        '',
        '🕷️ Las Arañas Tejedoras están en el Pozo Sin Fondo (sala 7). Hay una araña ahí sin necesidad de llave.',
        '   Para la segunda araña, hay dos rutas:',
        '   • Ruta directa: la puerta norte de sala 7 lleva al Santuario (requiere llave oxidada).',
        '     – Comprarla a Aldric en sala 4 por 20g, o buscarla en la Prisión (sala 8).',
        '     – La araña del Pozo la lleva a veces (15% de drop).',
        '   • Ruta alternativa: este → Capilla → norte → Hongos → norte → Trono → este → Santuario.',
      ].join('\n');
    }
  }

  return [
    `══ 📜 QUEST ACTIVA: ${quest.title} ══`,
    quest.description,
    `Progreso: ${bar} ${progress}/${goal} (faltan ${remaining})`,
    `Recompensa: ${rewardStr}`,
  ].join('\n') + locationHint + accessHint;
}

module.exports = {
  loadQuest,
  saveQuest,
  getActiveQuest,
  getPlayerProgress,
  recordProgress,
  maybeRotateQuest,
  formatQuest,
  startNewQuest,
};
