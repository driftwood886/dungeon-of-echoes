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
const { articuloMonstruo } = require('./gender'); // BUG-1427: artículo correcto según género

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
    description: 'El mercader busca aventureros ricos. Ganá 50 monedas de oro en total (cuenta todo el oro acumulado durante la sesión, no importa si ya lo gastaste).',
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
let recentlyCompletedIds = []; // DIS-1409: pool rotation — últimas 2 quests completadas para evitar repetición

// ─── Persistencia ─────────────────────────────────────────────────────────────

function loadQuest() {
  try {
    if (fs.existsSync(QUEST_FILE)) {
      const raw = JSON.parse(fs.readFileSync(QUEST_FILE, 'utf8'));
      const def = QUEST_CATALOG.find(q => q.id === raw.questId);
      if (def) {
        // BUG-1495: Reconstruir completedBy desde la DB para evitar doble recompensa tras reinicio.
        // El archivo puede no reflejar todos los jugadores que ya completaron la quest si hubo un crash.
        const completedBySet = new Set(raw.completedBy || []);
        try {
          const db = require('../db/db');
          const allPlayers = db.getAllPlayers();
          for (const player of allPlayers) {
            let qp;
            try { qp = JSON.parse(player.quest_progress || '{}'); } catch (_) { qp = {}; }
            if (qp.questId === def.id && (qp.progress || 0) >= def.goal) {
              completedBySet.add(player.id);
            }
          }
        } catch (dbErr) {
          console.error('[quests] No se pudo reconstruir completedBy desde DB:', dbErr.message);
        }
        activeQuest = {
          questDef: def,
          startedAt: raw.startedAt,
          completedBy: completedBySet,
        };
        // DIS-1409: restaurar historial de quests recientes
        if (Array.isArray(raw.recentlyCompletedIds)) {
          recentlyCompletedIds = raw.recentlyCompletedIds;
        }
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
      recentlyCompletedIds, // DIS-1409: persistir historial
    }));
  } catch (err) {
    console.error('[quests] Error al guardar quest:', err.message);
  }
}

function startNewQuest(excludeId = null, maxPlayerLevel = 1) {
  // DIS-1128: Excluir quests con minLevel > maxPlayerLevel para no asignar quests imposibles
  // DIS-1409: Excluir también las últimas 2 quests completadas para diversidad
  const excludedIds = new Set([excludeId, ...recentlyCompletedIds].filter(Boolean));
  let choices = QUEST_CATALOG.filter(q => !excludedIds.has(q.id) && (q.minLevel || 1) <= Math.max(maxPlayerLevel, 5));

  // DIS-1515: Evitar asignar quests con objetivos bloqueados por la Marea Espectral
  // Si SPECTRAL_TIDE está activo con >3 minutos restantes, excluir quests con objetivos
  // no-espectrales ni undead — no tiene sentido asignar "matar Goblins" si estarán ausentes.
  try {
    const eventScheduler = require('./eventScheduler');
    const activeEv = eventScheduler.getActiveEventInfo ? eventScheduler.getActiveEventInfo() : null;
    if (activeEv && activeEv.event && activeEv.event.id === 'SPECTRAL_TIDE' && activeEv.minutesRemaining > 3) {
      const SPECTRAL_TARGETS = new Set(['espectro', 'espectral', 'lich', 'sombra', 'fantasma',
        'esqueleto', 'zombie', 'zombi', 'vampiro', 'momia', 'muerto']);
      const isTargetBlocked = (q) => {
        if (q.type !== 'kill' || !q.target) return false;
        const tNorm = q.target.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        return !Array.from(SPECTRAL_TARGETS).some(s => tNorm.includes(s));
      };
      const notBlockedChoices = choices.filter(q => !isTargetBlocked(q));
      if (notBlockedChoices.length > 0) {
        choices = notBlockedChoices;
        console.log(`[quests] DIS-1515: Marea Espectral activa (~${activeEv.minutesRemaining} min) — se excluyeron quests con objetivos bloqueados.`);
      }
      // Si no hay alternativas, dejar el pool original (fallback silencioso)
    }
  } catch (_) {}

  if (choices.length === 0) {
    // fallback: solo excluir la quest actual
    choices = QUEST_CATALOG.filter(q => q.id !== excludeId);
    recentlyCompletedIds = []; // resetear historial si queda sin opciones
  }
  const def = choices[Math.floor(Math.random() * choices.length)];
  // DIS-1409: registrar en historial de recientes (máx 2)
  if (excludeId) {
    recentlyCompletedIds = [excludeId, ...recentlyCompletedIds].slice(0, 2);
  }
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
  let newQuest = null; // DIS-1409: nueva quest rotada automáticamente
  if (justCompleted) {
    quest.completedBy.add(player.id);
    reward = def.reward;
    // DIS-1409: rotar inmediatamente a nueva quest para todos los jugadores
    newQuest = startNewQuest(def.id, player.level || 1);
  }

  return { newProgress, justCompleted, reward, questProgress: JSON.stringify(qp), newQuest };
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
      `(Una nueva quest comenzará pronto para los demás jugadores)`,
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

  // DIS-1405 Propuesta B: indicar en el panel si el objetivo está bloqueado por Marea Espectral
  let spectralBlockHint = '';
  if (quest.type === 'kill' && quest.target && !completed) {
    try {
      const eventScheduler = require('./eventScheduler');
      const activeEv = eventScheduler.getActiveEventInfo ? eventScheduler.getActiveEventInfo() : null;
      if (activeEv && activeEv.event && activeEv.event.id === 'SPECTRAL_TIDE') {
        const normalize = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const targetNorm = normalize(quest.target);
        // Verificar si el objetivo NO es espectral/undead (si fuera espectral, no estaría bloqueado)
        const isSpectralTarget = targetNorm.includes('espectro') || targetNorm.includes('espectral') ||
          targetNorm.includes('lich') || targetNorm.includes('sombra') || targetNorm.includes('fantasma') ||
          targetNorm.includes('esqueleto') || targetNorm.includes('zombie') || targetNorm.includes('vampiro') ||
          targetNorm.includes('momia') || targetNorm.includes('muerto');
        if (!isSpectralTarget) {
          const minLeft = activeEv.minutesRemaining || '?';
          spectralBlockHint = `\n⚠️  [MAREA ESPECTRAL] ${articuloMonstruo(quest.target)} ${quest.target} huye durante el evento (~${minLeft} min restantes). Tu objetivo está temporalmente inaccesible.`;
          if (quest.id === 'slayer_goblin') {
            spectralBlockHint += '\n   💡 Aprovechá la Marea: espectros y no-muertos activos otorgan 2× XP.\n   • Corredor de las Sombras (sur): Espectros del Corredor.\n   • Capilla (este → norte) o Sala del Trono: no-muertos y esqueletos.';
          } else {
            spectralBlockHint += '\n   💡 Espectros y no-muertos activos otorgan 2× XP durante la Marea.';
          }
        }
      }
    } catch (_) {}
  }

  // DIS-1521: para quests de oro, mostrar progreso con texto explicativo en lugar de solo "N/50"
  let progressLine;
  if (quest.type === 'gold') {
    progressLine = `Progreso: ${bar} ${progress}/${goal}g ganados (te faltan ${remaining}g más — contás el total acumulado, no lo que tenés ahora)`;
  } else {
    progressLine = `Progreso: ${bar} ${progress}/${goal} (faltan ${remaining})`;
  }

  return [
    `══ 📜 QUEST ACTIVA: ${quest.title} ══`,
    quest.description,
    progressLine,
    `Recompensa: ${rewardStr}`,
  ].join('\n') + locationHint + accessHint + spectralBlockHint;
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
