/**
 * questEngine.js — Motor de Quests Dinámicas
 *
 * Sistema de quests generadas/narrativas para Dungeon of Echoes.
 * Ver diseño completo en: disenos/epic-quests-dinamicas.md
 * Ver schema en: disenos/epic-quests-dinamicas-schema.md
 *
 * Epic: EPIC-QD (iniciado 2026-07-14)
 * Implementado: IMPL-QD-1574 (assignQuests), IMPL-QD-1573 (stubs)
 */

'use strict';

const db = require('../db/db.js');

// ─── Helpers internos ─────────────────────────────────────────────────────────

/**
 * Obtener quests activas de un jugador desde la BD.
 * Retorna rows completas (player_quests JOIN quest_definitions).
 * @param {string} playerId
 * @returns {Array}
 */
function _getActiveQuests(playerId) {
  const rawDb = db.raw();
  const result = rawDb.exec(
    `SELECT pq.id, pq.quest_id, pq.slot, pq.progress, pq.status,
            qd.type, qd.condition, qd.reward, qd.name, qd.description
     FROM player_quests pq
     JOIN quest_definitions qd ON qd.id = pq.quest_id
     WHERE pq.player_id = ? AND pq.status = 'active'`,
    [playerId]
  );
  if (!result.length || !result[0].values.length) return [];
  const cols = result[0].columns;
  return result[0].values.map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

/**
 * Obtener el número de semana actual (para seed determinista de rotación).
 * @returns {number}
 */
function _weekNumber() {
  return Math.floor(Date.now() / 604800000);
}

/**
 * Fisher-Yates shuffle determinista dado un seed numérico.
 * @param {Array} arr
 * @param {number} seed
 * @returns {Array} copia mezclada
 */
function _seededShuffle(arr, seed) {
  const a = [...arr];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    const j = Math.abs(s) % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Nombre legible de una facción.
 * @param {string} factionId
 * @returns {string}
 */
function _factionName(factionId) {
  const NAMES = {
    orden_filo:           'la Orden del Filo',
    conclave_arcano:      'el Cónclave Arcano',
    hermandad_mercado:    'la Hermandad del Mercado',
  };
  return NAMES[factionId] || factionId;
}

// ─── API Pública ──────────────────────────────────────────────────────────────

/**
 * Asignar quests al jugador (en login o cuando un slot queda vacío).
 * Los bots (is_bot=1) no reciben quests.
 *
 * Lógica de slots (ver schema §4.4):
 *  - Slot principal: quest de facción si tiene facción; hint si no.
 *  - Slot secundaria: quest genérica del pool con seed semanal determinista.
 *  - Slot narrativa: primer paso de la Cadena A si ya visitó sala 10.
 *
 * @param {Object} player
 * @returns {{ assigned: string[], messages: string[] }}
 */
function assignQuests(player) {
  if (player.is_bot) return { assigned: [], messages: [] };

  const rawDb = db.raw();
  const assigned = [];
  const messages = [];

  // ─── Paso 0: slots ya activos ─────────────────────────────────────────────
  const activeResult = rawDb.exec(
    `SELECT slot, quest_id FROM player_quests WHERE player_id = ? AND status = 'active'`,
    [player.id]
  );
  const activeBySlot = {};
  if (activeResult.length && activeResult[0].values.length) {
    for (const [slot, questId] of activeResult[0].values) {
      activeBySlot[slot] = questId;
    }
  }

  const weekNum  = _weekNumber();
  const weekStart = new Date(weekNum * 604800000).toISOString();
  const playerLevel = player.level || 1;

  // ─── Slot principal ───────────────────────────────────────────────────────
  if (!activeBySlot['principal']) {
    if (player.faction) {
      // Quest de facción asignada a este jugador
      const fQResult = rawDb.exec(
        `SELECT id, name, description FROM quest_definitions
         WHERE require_faction = ? AND slot = 'principal' AND is_active = 1
           AND require_level <= ?
           AND id NOT IN (
             SELECT quest_id FROM player_quests
             WHERE player_id = ? AND status = 'active'
           )
           AND id NOT IN (
             SELECT quest_id FROM player_quests
             WHERE player_id = ? AND status = 'completed' AND completed_at >= ?
           )
         ORDER BY id
         LIMIT 10`,
        [player.faction, playerLevel, player.id, player.id, weekStart]
      );
      if (fQResult.length && fQResult[0].values.length > 0) {
        const [questId, name, desc] = fQResult[0].values[0];
        try {
          rawDb.run(
            `INSERT OR IGNORE INTO player_quests (player_id, quest_id, status, progress, slot)
             VALUES (?, ?, 'active', '{}', 'principal')`,
            [player.id, questId]
          );
          assigned.push(questId);
          messages.push(
            `📋 **Quest de ${_factionName(player.faction)}:** ${name}\n${desc}`
          );
        } catch (e) {
          console.error('[questEngine] Error asignando slot principal:', e.message);
        }
      }
    } else {
      // Sin facción: hint, no hay quest de facción disponible
      messages.push(
        `💡 Sin facción activa — el slot de quest principal está vacío. ` +
        `Uniéndote a una facción recibirías misiones especiales de tu gremio. (comando: \`facciones\`)`
      );
    }
  }

  // ─── Slot secundaria ─────────────────────────────────────────────────────
  if (!activeBySlot['secundaria']) {
    const poolResult = rawDb.exec(
      `SELECT id FROM quest_definitions
       WHERE require_faction IS NULL AND slot = 'secundaria' AND is_active = 1
         AND require_level <= ?
         AND id NOT IN (
           SELECT quest_id FROM player_quests
           WHERE player_id = ? AND status = 'active'
         )
         AND id NOT IN (
           SELECT quest_id FROM player_quests
           WHERE player_id = ? AND status = 'completed' AND completed_at >= ?
         )
       ORDER BY id`,
      [playerLevel, player.id, player.id, weekStart]
    );
    if (poolResult.length && poolResult[0].values.length > 0) {
      const pool = poolResult[0].values.map(r => r[0]);
      // Seed: número de semana + suma de chars del ID del jugador para variación por jugador
      const playerSeedOffset = player.id.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
      const seed = (weekNum * 10000 + playerSeedOffset) & 0x7fffffff;
      const shuffled = _seededShuffle(pool, seed);
      const questId = shuffled[0];
      try {
        rawDb.run(
          `INSERT OR IGNORE INTO player_quests (player_id, quest_id, status, progress, slot)
           VALUES (?, ?, 'active', '{}', 'secundaria')`,
          [player.id, questId]
        );
        assigned.push(questId);
        const qInfo = rawDb.exec(
          `SELECT name, description FROM quest_definitions WHERE id = ?`, [questId]
        );
        if (qInfo.length && qInfo[0].values.length) {
          const [name, desc] = qInfo[0].values[0];
          messages.push(`📋 **Quest:** ${name}\n${desc}`);
        }
      } catch (e) {
        console.error('[questEngine] Error asignando slot secundaria:', e.message);
      }
    }
  }

  // ─── Slot narrativa ───────────────────────────────────────────────────────
  if (!activeBySlot['narrativa']) {
    // Requisito Cadena A: haber visitado sala 10 (Santuario)
    const visitedRooms = (() => {
      try { return JSON.parse(player.rooms_visited || '[]'); } catch (_) { return []; }
    })();
    const hasVisitedRoom10 = visitedRooms.includes(10);

    // ¿Ya completó o abandonó algún paso de la cadena?
    const chainDoneResult = rawDb.exec(
      `SELECT id FROM player_quests
       WHERE player_id = ? AND slot = 'narrativa'
         AND quest_id LIKE 'chain_velas_%' AND status IN ('completed', 'abandoned')
       LIMIT 1`,
      [player.id]
    );
    const alreadyDone = chainDoneResult.length && chainDoneResult[0].values.length > 0;

    // ¿Existe chain_velas_1 en el pool?
    const chainExistsResult = rawDb.exec(
      `SELECT id FROM quest_definitions WHERE id = 'chain_velas_1' AND is_active = 1 LIMIT 1`
    );
    const chainExists = chainExistsResult.length && chainExistsResult[0].values.length > 0;

    if (hasVisitedRoom10 && !alreadyDone && chainExists) {
      try {
        rawDb.run(
          `INSERT OR IGNORE INTO player_quests (player_id, quest_id, status, progress, slot)
           VALUES (?, 'chain_velas_1', 'active', '{}', 'narrativa')`,
          [player.id]
        );
        assigned.push('chain_velas_1');
        const qInfo = rawDb.exec(
          `SELECT name, description FROM quest_definitions WHERE id = 'chain_velas_1'`
        );
        if (qInfo.length && qInfo[0].values.length) {
          const [name, desc] = qInfo[0].values[0];
          messages.push(`📜 **Misterio:** ${name}\n${desc}`);
        }
      } catch (e) {
        console.error('[questEngine] Error asignando slot narrativa:', e.message);
      }
    }
  }

  return { assigned, messages };
}

/**
 * Notificar kill al QuestEngine.
 * Actualiza progreso de quests de tipo 'kill' activas del jugador.
 *
 * @param {Object} player
 * @param {Object} monster
 * @returns {null | { text: string }}
 */
function onKill(player, monster) {
  if (player.is_bot) return null;

  const rawDb = db.raw();
  const messages = [];

  // Buscar quests kill activas
  const questsResult = rawDb.exec(
    `SELECT pq.id, pq.quest_id, pq.progress, qd.condition, qd.reward, qd.name
     FROM player_quests pq
     JOIN quest_definitions qd ON qd.id = pq.quest_id
     WHERE pq.player_id = ? AND pq.status = 'active' AND qd.type = 'kill'`,
    [player.id]
  );
  if (!questsResult.length || !questsResult[0].values.length) return null;

  const cols = questsResult[0].columns;
  const rows = questsResult[0].values.map(r => Object.fromEntries(cols.map((c, i) => [c, r[i]])));

  for (const row of rows) {
    try {
      const cond = JSON.parse(row.condition || '{}');
      const progress = JSON.parse(row.progress || '{}');

      // Verificar target_type: nombre parcial del monstruo (case-insensitive) o "any"
      const targetType = (cond.target_type || 'any').toLowerCase();
      const monsterName = (monster.name || '').toLowerCase();
      if (targetType !== 'any' && !monsterName.includes(targetType)) continue;

      // Verificar require_stance (solo quests de guerrero)
      if (cond.require_stance) {
        const playerStance = (player.stance || '').toLowerCase();
        if (playerStance !== cond.require_stance.toLowerCase()) continue;
      }

      // Incrementar progreso
      const current = progress.kills || 0;
      const needed  = cond.count || 1;
      const newKills = current + 1;

      if (newKills >= needed) {
        // ─── Quest completada ──────────────────────────────────────────────
        const reward = JSON.parse(row.reward || '{}');
        const now = new Date().toISOString();

        // Actualizar estado a completada
        rawDb.run(
          `UPDATE player_quests SET status = 'completed', progress = ?, completed_at = ?
           WHERE id = ?`,
          [JSON.stringify({ kills: newKills }), now, row.id]
        );

        // Otorgar recompensas
        const updates = {};
        if (reward.gold)  updates.gold  = (player.gold  || 0) + reward.gold;
        if (reward.xp)    updates.xp    = (player.xp    || 0) + reward.xp;
        if (Object.keys(updates).length) db.updatePlayer(player.id, updates);

        if (reward.aldric_rep) {
          try { db.addAldricRep(player.id, reward.aldric_rep); } catch (_) {}
        }
        if (reward.faction_influence && player.faction) {
          try { db.addFactionInfluence(player.id, reward.faction_influence); } catch (_) {}
        }

        let completionMsg = `✅ **¡Quest completada!** "${row.name}"\n`;
        const rewardParts = [];
        if (reward.gold)  rewardParts.push(`+${reward.gold} 💰 gold`);
        if (reward.xp)    rewardParts.push(`+${reward.xp} ⭐ XP`);
        if (reward.aldric_rep) rewardParts.push(`+${reward.aldric_rep} 📖 Rep.Aldric`);
        if (reward.faction_influence) rewardParts.push(`+${reward.faction_influence} 🏴 influencia`);
        if (rewardParts.length) completionMsg += `Recompensa: ${rewardParts.join(', ')}`;

        messages.push(completionMsg);

        // Intentar asignar nueva quest al slot liberado (no crashear si falla)
        try {
          const freshPlayer = db.getPlayer(player.id);
          if (freshPlayer) assignQuests(freshPlayer);
        } catch (_) {}

      } else {
        // ─── Progreso parcial ─────────────────────────────────────────────
        rawDb.run(
          `UPDATE player_quests SET progress = ? WHERE id = ?`,
          [JSON.stringify({ kills: newKills }), row.id]
        );
        messages.push(`📋 Quest "${row.name}": ${newKills}/${needed} kills`);
      }
    } catch (e) {
      console.error('[questEngine] Error en onKill:', e.message);
    }
  }

  if (!messages.length) return null;
  return { text: messages.join('\n') };
}

/**
 * Notificar exploración de sala al QuestEngine.
 * Actualiza progreso de quests de tipo 'explore' activas del jugador.
 *
 * TODO (IMPL-QD-1576): implementar.
 * @param {Object} player
 * @param {number} roomId
 * @returns {null | { text: string }}
 */
function onExplore(player, roomId) {
  if (player.is_bot) return null;
  // TODO: buscar quests explore activas, verificar condición, actualizar progreso
  return null;
}

/**
 * Notificar crafteo al QuestEngine.
 * Actualiza progreso de quests de tipo 'craft' activas del jugador.
 *
 * TODO (IMPL-QD-1578): implementar.
 * @param {Object} player
 * @param {string} itemName
 * @returns {null | { text: string }}
 */
function onCraft(player, itemName) {
  if (player.is_bot) return null;
  // TODO: implementar
  return null;
}

/**
 * Notificar transacción al QuestEngine.
 * Actualiza progreso de quests de tipo 'trade' activas del jugador.
 *
 * TODO (IMPL-QD-1578): implementar.
 * @param {Object} player
 * @param {string} action  - 'buy' | 'sell' | 'auction'
 * @param {number} value   - valor en gold de la transacción
 * @returns {null | { text: string }}
 */
function onTrade(player, action, value) {
  if (player.is_bot) return null;
  // TODO: implementar
  return null;
}

/**
 * Notificar ritual al QuestEngine.
 * Actualiza progreso de quests de tipo 'ritual' activas del jugador.
 *
 * TODO (IMPL-QD-1578): implementar.
 * @param {Object} player
 * @param {string} action  - 'pray' | 'use_bowl' | 'use_altar'
 * @returns {null | { text: string }}
 */
function onRitual(player, action) {
  if (player.is_bot) return null;
  // TODO: implementar
  return null;
}

/**
 * Obtener el display de quests activas del jugador (comando `quests`).
 *
 * TODO (IMPL-QD-1577): implementar display completo.
 * @param {Object} player
 * @returns {{ text: string }}
 */
function getQuestsDisplay(player) {
  if (player.is_bot) return { text: 'Los bots no reciben quests.' };

  // Placeholder hasta implementación real
  const hasFaction = !!player.faction;
  const noFactionHint = hasFaction ? '' :
    '\n💡 Sin facción activa — uniéndote a una, recibirías quests especiales de tu gremio.';

  return {
    text: `📋 **QUESTS ACTIVAS**\n\n(Sistema en construcción — próximamente disponible)${noFactionHint}\n\nPara unirte a una facción: \`facciones\``
  };
}

/**
 * Obtener detalle de una quest por nombre (comando `quest info <nombre>`).
 *
 * TODO (IMPL-QD-1577): implementar.
 * @param {Object} player
 * @param {string} questName
 * @returns {{ text: string }}
 */
function getQuestDetail(player, questName) {
  return { text: `Quest "${questName}": información no disponible aún.` };
}

/**
 * Abandonar una quest activa del jugador.
 *
 * TODO (IMPL-QD-1577): implementar con cooldown.
 * @param {Object} player
 * @param {string} questName
 * @returns {{ text: string }}
 */
function abandonQuest(player, questName) {
  return { text: `No podés abandonar quests aún — el sistema está en construcción.` };
}

/**
 * Obtener historial de quests completadas del jugador.
 *
 * TODO (IMPL-QD-1577): implementar.
 * @param {Object} player
 * @returns {{ text: string }}
 */
function getHistory(player) {
  return { text: `📜 Historial de quests: (sin registros aún)` };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  assignQuests,
  onKill,
  onExplore,
  onCraft,
  onTrade,
  onRitual,
  getQuestsDisplay,
  getQuestDetail,
  abandonQuest,
  getHistory,
  // Internals exportados para testing
  _weekNumber,
  _seededShuffle,
  _factionName,
};
