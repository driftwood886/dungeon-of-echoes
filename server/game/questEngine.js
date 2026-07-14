/**
 * questEngine.js — Motor de Quests Dinámicas
 *
 * Sistema de quests generadas/narrativas para Dungeon of Echoes.
 * Ver diseño completo en: disenos/epic-quests-dinamicas.md
 * Ver schema en: disenos/epic-quests-dinamicas-schema.md
 *
 * Epic: EPIC-QD (iniciado 2026-07-14)
 * Implementado: IMPL-QD-1574 (assignQuests), IMPL-QD-1573 (stubs), IMPL-QD-1575 (onKill), IMPL-QD-1576 (onExplore), IMPL-QD-1577 (getQuestsDisplay+UI)
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
// DIS-1595: helper para re-asignar y retornar mensaje de nueva quest al jugador
function _tryAssignAndGetMsg(playerId) {
  try {
    const fp = db.getPlayer(playerId);
    if (!fp) return null;
    const res = assignQuests(fp);
    if (res && res.messages && res.messages.length > 0) return res.messages[0];
  } catch (_) {}
  return null;
}

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
        // DIS-1595: capturar mensajes de la nueva quest asignada para mostrarlos al jugador
        try {
          const freshPlayer = db.getPlayer(player.id);
          if (freshPlayer) {
            const assignResult = assignQuests(freshPlayer);
            if (assignResult && assignResult.messages && assignResult.messages.length > 0) {
              // Agregar separador + notificación de nueva quest
              completionMsg += `\n\n🔄 **Nueva misión disponible:**\n${assignResult.messages[0]}`;
            }
          }
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
 * @param {Object} player
 * @param {number} roomId
 * @param {boolean} isNew — true si es la primera vez que el jugador visita esta sala
 * @returns {null | { text: string }}
 */
function onExplore(player, roomId, isNew = false) {
  if (player.is_bot) return null;

  const rawDb = db.raw();
  const messages = [];

  // Buscar quests explore activas
  const questsResult = rawDb.exec(
    `SELECT pq.id, pq.quest_id, pq.progress, qd.condition, qd.reward, qd.name
     FROM player_quests pq
     JOIN quest_definitions qd ON qd.id = pq.quest_id
     WHERE pq.player_id = ? AND pq.status = 'active' AND qd.type = 'explore'`,
    [player.id]
  );
  if (!questsResult.length || !questsResult[0].values.length) return null;

  const cols = questsResult[0].columns;
  const rows = questsResult[0].values.map(r => Object.fromEntries(cols.map((c, i) => [c, r[i]])));

  for (const row of rows) {
    try {
      const cond = JSON.parse(row.condition || '{}');
      const progress = JSON.parse(row.progress || '{}');

      // Caso 1: sala específica a visitar
      if (cond.target_room_id !== undefined && cond.target_room_id !== null) {
        if (roomId !== cond.target_room_id) continue;
        // require_not_visited: solo si es primera vez
        if (cond.require_not_visited && !isNew) continue;

        const already = progress.explored === true;
        if (already) continue;

        // Completar quest
        const reward = JSON.parse(row.reward || '{}');
        const now = new Date().toISOString();
        rawDb.run(
          `UPDATE player_quests SET status = 'completed', progress = ?, completed_at = ? WHERE id = ?`,
          [JSON.stringify({ explored: true }), now, row.id]
        );
        const updates = {};
        if (reward.gold) updates.gold = (player.gold || 0) + reward.gold;
        if (reward.xp)   updates.xp   = (player.xp   || 0) + reward.xp;
        if (Object.keys(updates).length) db.updatePlayer(player.id, updates);
        if (reward.aldric_rep) { try { db.addAldricRep(player.id, reward.aldric_rep); } catch (_) {} }
        if (reward.faction_influence && player.faction) { try { db.addFactionInfluence(player.id, reward.faction_influence); } catch (_) {} }

        let completionMsg = `✅ **¡Quest completada!** "${row.name}"\n`;
        const rewardParts = [];
        if (reward.gold) rewardParts.push(`+${reward.gold} 💰 gold`);
        if (reward.xp)   rewardParts.push(`+${reward.xp} ⭐ XP`);
        if (reward.aldric_rep) rewardParts.push(`+${reward.aldric_rep} 📖 Rep.Aldric`);
        if (reward.faction_influence) rewardParts.push(`+${reward.faction_influence} 🏴 influencia`);
        if (rewardParts.length) completionMsg += `Recompensa: ${rewardParts.join(', ')}`;
        messages.push(completionMsg);

        // DIS-1595: notificar al jugador si se asigna nueva quest al liberarse el slot
        const _newQuestMsg = _tryAssignAndGetMsg(player.id);
        if (_newQuestMsg) {
          messages[messages.length - 1] += `\n\n🔄 **Nueva misión disponible:**\n${_newQuestMsg}`;
        }

      // Caso 2: descubrir N salas nuevas
      } else if (cond.new_rooms_count !== undefined) {
        if (!isNew) continue; // solo cuenta salas nuevas

        const current = progress.rooms_discovered || 0;
        const needed  = cond.new_rooms_count || 1;
        const newCount = current + 1;

        if (newCount >= needed) {
          const reward = JSON.parse(row.reward || '{}');
          const now = new Date().toISOString();
          rawDb.run(
            `UPDATE player_quests SET status = 'completed', progress = ?, completed_at = ? WHERE id = ?`,
            [JSON.stringify({ rooms_discovered: newCount }), now, row.id]
          );
          const updates = {};
          if (reward.gold) updates.gold = (player.gold || 0) + reward.gold;
          if (reward.xp)   updates.xp   = (player.xp   || 0) + reward.xp;
          if (Object.keys(updates).length) db.updatePlayer(player.id, updates);
          if (reward.aldric_rep) { try { db.addAldricRep(player.id, reward.aldric_rep); } catch (_) {} }
          if (reward.faction_influence && player.faction) { try { db.addFactionInfluence(player.id, reward.faction_influence); } catch (_) {} }

          let completionMsg = `✅ **¡Quest completada!** "${row.name}"\n`;
          const rewardParts = [];
          if (reward.gold) rewardParts.push(`+${reward.gold} 💰 gold`);
          if (reward.xp)   rewardParts.push(`+${reward.xp} ⭐ XP`);
          if (reward.aldric_rep) rewardParts.push(`+${reward.aldric_rep} 📖 Rep.Aldric`);
          if (reward.faction_influence) rewardParts.push(`+${reward.faction_influence} 🏴 influencia`);
          if (rewardParts.length) completionMsg += `Recompensa: ${rewardParts.join(', ')}`;
          messages.push(completionMsg);

          // DIS-1595: notificar al jugador si se asigna nueva quest al liberarse el slot
        const _newQuestMsg = _tryAssignAndGetMsg(player.id);
        if (_newQuestMsg) {
          messages[messages.length - 1] += `\n\n🔄 **Nueva misión disponible:**\n${_newQuestMsg}`;
        }
        } else {
          rawDb.run(
            `UPDATE player_quests SET progress = ? WHERE id = ?`,
            [JSON.stringify({ rooms_discovered: newCount }), row.id]
          );
          messages.push(`📋 Quest "${row.name}": ${newCount}/${needed} salas nuevas`);
        }
      }
    } catch (e) {
      console.error('[questEngine] Error en onExplore:', e.message);
    }
  }

  if (!messages.length) return null;
  return { text: messages.join('\n') };
}

/**
 * Notificar crafteo al QuestEngine.
 * Actualiza progreso de quests de tipo 'craft' activas del jugador.
 *
 * @param {Object} player
 * @param {string} itemName — nombre del ítem crafteado (resultado de la receta)
 * @returns {null | { text: string }}
 */
function onCraft(player, itemName) {
  if (player.is_bot) return null;

  const rawDb = db.raw();
  const messages = [];

  const questsResult = rawDb.exec(
    `SELECT pq.id, pq.quest_id, pq.progress, qd.condition, qd.reward, qd.name
     FROM player_quests pq
     JOIN quest_definitions qd ON qd.id = pq.quest_id
     WHERE pq.player_id = ? AND pq.status = 'active' AND qd.type = 'craft'`,
    [player.id]
  );
  if (!questsResult.length || !questsResult[0].values.length) return null;

  const cols = questsResult[0].columns;
  const rows = questsResult[0].values.map(r => Object.fromEntries(cols.map((c, i) => [c, r[i]])));

  const itemNorm = (itemName || '').toLowerCase().trim();

  for (const row of rows) {
    try {
      const cond     = JSON.parse(row.condition || '{}');
      const progress = JSON.parse(row.progress || '{}');

      // Verificar target_item: nombre parcial del resultado (case-insensitive) o 'any'
      const targetItem = (cond.target_item || 'any').toLowerCase();
      if (targetItem !== 'any' && !itemNorm.includes(targetItem)) continue;

      // Verificar target_category si está presente (ej: 'weapon', 'armor', 'pocion')
      if (cond.target_category) {
        const cat = cond.target_category.toLowerCase();
        if (!itemNorm.includes(cat)) continue;
      }

      const current = progress.crafted || 0;
      const needed  = cond.count || 1;
      const newCount = current + 1;

      if (newCount >= needed) {
        const reward = JSON.parse(row.reward || '{}');
        const now = new Date().toISOString();
        rawDb.run(
          `UPDATE player_quests SET status = 'completed', progress = ?, completed_at = ? WHERE id = ?`,
          [JSON.stringify({ crafted: newCount }), now, row.id]
        );
        const updates = {};
        if (reward.gold) updates.gold = (player.gold || 0) + reward.gold;
        if (reward.xp)   updates.xp   = (player.xp   || 0) + reward.xp;
        if (Object.keys(updates).length) db.updatePlayer(player.id, updates);
        if (reward.aldric_rep) { try { db.addAldricRep(player.id, reward.aldric_rep); } catch (_) {} }
        if (reward.faction_influence && player.faction) { try { db.addFactionInfluence(player.id, reward.faction_influence); } catch (_) {} }

        let completionMsg = `✅ **¡Quest completada!** "${row.name}"\n`;
        const rewardParts = [];
        if (reward.gold) rewardParts.push(`+${reward.gold} 💰 gold`);
        if (reward.xp)   rewardParts.push(`+${reward.xp} ⭐ XP`);
        if (reward.aldric_rep) rewardParts.push(`+${reward.aldric_rep} 📖 Rep.Aldric`);
        if (reward.faction_influence) rewardParts.push(`+${reward.faction_influence} 🏴 influencia`);
        if (rewardParts.length) completionMsg += `Recompensa: ${rewardParts.join(', ')}`;
        messages.push(completionMsg);

        // DIS-1595: notificar al jugador si se asigna nueva quest al liberarse el slot
        const _newQuestMsg = _tryAssignAndGetMsg(player.id);
        if (_newQuestMsg) {
          messages[messages.length - 1] += `\n\n🔄 **Nueva misión disponible:**\n${_newQuestMsg}`;
        }
      } else {
        rawDb.run(
          `UPDATE player_quests SET progress = ? WHERE id = ?`,
          [JSON.stringify({ crafted: newCount }), row.id]
        );
        messages.push(`📋 Quest "${row.name}": ${newCount}/${needed} crafteos`);
      }
    } catch (e) {
      console.error('[questEngine] Error en onCraft:', e.message);
    }
  }

  if (!messages.length) return null;
  return { text: messages.join('\n') };
}

/**
 * Notificar transacción al QuestEngine.
 * Actualiza progreso de quests de tipo 'trade' activas del jugador.
 *
 * @param {Object} player
 * @param {string} action  - 'buy' | 'sell' | 'auction'
 * @param {number} value   - valor en gold de la transacción
 * @returns {null | { text: string }}
 */
function onTrade(player, action, value) {
  if (player.is_bot) return null;

  const rawDb = db.raw();
  const messages = [];

  const questsResult = rawDb.exec(
    `SELECT pq.id, pq.quest_id, pq.progress, qd.condition, qd.reward, qd.name
     FROM player_quests pq
     JOIN quest_definitions qd ON qd.id = pq.quest_id
     WHERE pq.player_id = ? AND pq.status = 'active' AND qd.type = 'trade'`,
    [player.id]
  );
  if (!questsResult.length || !questsResult[0].values.length) return null;

  const cols = questsResult[0].columns;
  const rows = questsResult[0].values.map(r => Object.fromEntries(cols.map((c, i) => [c, r[i]])));

  for (const row of rows) {
    try {
      const cond     = JSON.parse(row.condition || '{}');
      const progress = JSON.parse(row.progress || '{}');

      // Verificar action: 'buy', 'sell', 'auction', o 'any'
      const requiredAction = (cond.action || 'any').toLowerCase();
      if (requiredAction !== 'any' && requiredAction !== action) continue;

      // Modo 1: contar transacciones
      if (cond.count !== undefined) {
        const current  = progress.trades || 0;
        const needed   = cond.count;
        const newCount = current + 1;

        if (newCount >= needed) {
          const reward = JSON.parse(row.reward || '{}');
          const now = new Date().toISOString();
          rawDb.run(
            `UPDATE player_quests SET status = 'completed', progress = ?, completed_at = ? WHERE id = ?`,
            [JSON.stringify({ trades: newCount }), now, row.id]
          );
          const updates = {};
          if (reward.gold) updates.gold = (player.gold || 0) + reward.gold;
          if (reward.xp)   updates.xp   = (player.xp   || 0) + reward.xp;
          if (Object.keys(updates).length) db.updatePlayer(player.id, updates);
          if (reward.aldric_rep) { try { db.addAldricRep(player.id, reward.aldric_rep); } catch (_) {} }
          if (reward.faction_influence && player.faction) { try { db.addFactionInfluence(player.id, reward.faction_influence); } catch (_) {} }

          let completionMsg = `✅ **¡Quest completada!** "${row.name}"\n`;
          const rewardParts = [];
          if (reward.gold) rewardParts.push(`+${reward.gold} 💰 gold`);
          if (reward.xp)   rewardParts.push(`+${reward.xp} ⭐ XP`);
          if (reward.aldric_rep) rewardParts.push(`+${reward.aldric_rep} 📖 Rep.Aldric`);
          if (reward.faction_influence) rewardParts.push(`+${reward.faction_influence} 🏴 influencia`);
          if (rewardParts.length) completionMsg += `Recompensa: ${rewardParts.join(', ')}`;
          messages.push(completionMsg);

          // DIS-1595: notificar al jugador si se asigna nueva quest al liberarse el slot
        const _newQuestMsg = _tryAssignAndGetMsg(player.id);
        if (_newQuestMsg) {
          messages[messages.length - 1] += `\n\n🔄 **Nueva misión disponible:**\n${_newQuestMsg}`;
        }
        } else {
          rawDb.run(
            `UPDATE player_quests SET progress = ? WHERE id = ?`,
            [JSON.stringify({ trades: newCount }), row.id]
          );
          messages.push(`📋 Quest "${row.name}": ${newCount}/${needed} transacciones`);
        }

      // Modo 2: acumular gold gastado/recibido
      } else if (cond.gold_amount !== undefined) {
        const current    = progress.gold_spent || 0;
        const needed     = cond.gold_amount;
        const newTotal   = current + (value || 0);

        if (newTotal >= needed) {
          const reward = JSON.parse(row.reward || '{}');
          const now = new Date().toISOString();
          rawDb.run(
            `UPDATE player_quests SET status = 'completed', progress = ?, completed_at = ? WHERE id = ?`,
            [JSON.stringify({ gold_spent: newTotal }), now, row.id]
          );
          const updates = {};
          if (reward.gold) updates.gold = (player.gold || 0) + reward.gold;
          if (reward.xp)   updates.xp   = (player.xp   || 0) + reward.xp;
          if (Object.keys(updates).length) db.updatePlayer(player.id, updates);
          if (reward.aldric_rep) { try { db.addAldricRep(player.id, reward.aldric_rep); } catch (_) {} }
          if (reward.faction_influence && player.faction) { try { db.addFactionInfluence(player.id, reward.faction_influence); } catch (_) {} }

          let completionMsg = `✅ **¡Quest completada!** "${row.name}"\n`;
          const rewardParts = [];
          if (reward.gold) rewardParts.push(`+${reward.gold} 💰 gold`);
          if (reward.xp)   rewardParts.push(`+${reward.xp} ⭐ XP`);
          if (reward.aldric_rep) rewardParts.push(`+${reward.aldric_rep} 📖 Rep.Aldric`);
          if (reward.faction_influence) rewardParts.push(`+${reward.faction_influence} 🏴 influencia`);
          if (rewardParts.length) completionMsg += `Recompensa: ${rewardParts.join(', ')}`;
          messages.push(completionMsg);

          // DIS-1595: notificar al jugador si se asigna nueva quest al liberarse el slot
        const _newQuestMsg = _tryAssignAndGetMsg(player.id);
        if (_newQuestMsg) {
          messages[messages.length - 1] += `\n\n🔄 **Nueva misión disponible:**\n${_newQuestMsg}`;
        }
        } else {
          rawDb.run(
            `UPDATE player_quests SET progress = ? WHERE id = ?`,
            [JSON.stringify({ gold_spent: newTotal }), row.id]
          );
          messages.push(`📋 Quest "${row.name}": ${newTotal}/${needed}g`);
        }
      }
    } catch (e) {
      console.error('[questEngine] Error en onTrade:', e.message);
    }
  }

  if (!messages.length) return null;
  return { text: messages.join('\n') };
}

/**
 * Notificar ritual al QuestEngine.
 * Actualiza progreso de quests de tipo 'ritual' activas del jugador.
 *
 * @param {Object} player
 * @param {string} action  - 'pray' | 'use_bowl' | 'use_altar'
 * @returns {null | { text: string }}
 */
function onRitual(player, action) {
  if (player.is_bot) return null;

  const rawDb = db.raw();
  const messages = [];

  const questsResult = rawDb.exec(
    `SELECT pq.id, pq.quest_id, pq.progress, qd.condition, qd.reward, qd.name
     FROM player_quests pq
     JOIN quest_definitions qd ON qd.id = pq.quest_id
     WHERE pq.player_id = ? AND pq.status = 'active' AND qd.type = 'ritual'`,
    [player.id]
  );
  if (!questsResult.length || !questsResult[0].values.length) return null;

  const cols = questsResult[0].columns;
  const rows = questsResult[0].values.map(r => Object.fromEntries(cols.map((c, i) => [c, r[i]])));

  for (const row of rows) {
    try {
      const cond     = JSON.parse(row.condition || '{}');
      const progress = JSON.parse(row.progress || '{}');

      // Verificar action: 'pray', 'use_bowl', 'use_altar', o 'any'
      const requiredAction = (cond.action || 'any').toLowerCase();
      if (requiredAction !== 'any' && requiredAction !== action) continue;

      const current  = progress.count || 0;
      const needed   = cond.count || 1;
      const newCount = current + 1;

      if (newCount >= needed) {
        const reward = JSON.parse(row.reward || '{}');
        const now = new Date().toISOString();
        rawDb.run(
          `UPDATE player_quests SET status = 'completed', progress = ?, completed_at = ? WHERE id = ?`,
          [JSON.stringify({ count: newCount }), now, row.id]
        );
        const updates = {};
        if (reward.gold) updates.gold = (player.gold || 0) + reward.gold;
        if (reward.xp)   updates.xp   = (player.xp   || 0) + reward.xp;
        if (Object.keys(updates).length) db.updatePlayer(player.id, updates);
        if (reward.aldric_rep) { try { db.addAldricRep(player.id, reward.aldric_rep); } catch (_) {} }
        if (reward.faction_influence && player.faction) { try { db.addFactionInfluence(player.id, reward.faction_influence); } catch (_) {} }

        let completionMsg = `✅ **¡Quest completada!** "${row.name}"\n`;
        const rewardParts = [];
        if (reward.gold) rewardParts.push(`+${reward.gold} 💰 gold`);
        if (reward.xp)   rewardParts.push(`+${reward.xp} ⭐ XP`);
        if (reward.aldric_rep) rewardParts.push(`+${reward.aldric_rep} 📖 Rep.Aldric`);
        if (reward.faction_influence) rewardParts.push(`+${reward.faction_influence} 🏴 influencia`);
        if (rewardParts.length) completionMsg += `Recompensa: ${rewardParts.join(', ')}`;
        messages.push(completionMsg);

        // DIS-1595: notificar al jugador si se asigna nueva quest al liberarse el slot
        const _newQuestMsg = _tryAssignAndGetMsg(player.id);
        if (_newQuestMsg) {
          messages[messages.length - 1] += `\n\n🔄 **Nueva misión disponible:**\n${_newQuestMsg}`;
        }
      } else {
        rawDb.run(
          `UPDATE player_quests SET progress = ? WHERE id = ?`,
          [JSON.stringify({ count: newCount }), row.id]
        );
        messages.push(`📋 Quest "${row.name}": ${newCount}/${needed} rituales`);
      }
    } catch (e) {
      console.error('[questEngine] Error en onRitual:', e.message);
    }
  }

  if (!messages.length) return null;
  return { text: messages.join('\n') };
}

/**
 * Ícono por tipo de quest.
 * @param {string} type
 * @param {string} slot
 * @returns {string}
 */
function _questIcon(type, slot) {
  if (slot === 'narrativa') return '📜';
  const ICONS = { kill: '🗡️', explore: '🗺️', craft: '🔧', trade: '💰', ritual: '🙏', boss: '💀' };
  return ICONS[type] || '📋';
}

/**
 * Generar texto de progreso legible para una quest activa.
 * @param {Object} qd - quest_definition row
 * @param {string} progressJson
 * @returns {string}
 */
function _progressText(qd, progressJson) {
  try {
    const cond     = JSON.parse(qd.condition || '{}');
    const progress = JSON.parse(progressJson || '{}');

    if (qd.type === 'kill') {
      const current = progress.kills || 0;
      const needed  = cond.count || 1;
      return `${current}/${needed}`;
    } else if (qd.type === 'explore') {
      if (cond.target_room_id !== undefined) {
        return progress.explored ? 'completada' : 'pendiente';
      }
      const current = progress.rooms_discovered || 0;
      const needed  = cond.new_rooms_count || 1;
      return `${current}/${needed} salas`;
    } else if (qd.type === 'craft') {
      const current = progress.crafted || 0;
      const needed  = cond.count || 1;
      return needed === 1 ? 'pendiente' : `${current}/${needed}`;
    } else if (qd.type === 'trade') {
      const current = progress.trades || progress.gold_spent || 0;
      const needed  = cond.count || cond.gold_amount || 1;
      return `${current}/${needed}`;
    } else if (qd.type === 'ritual') {
      const current = progress.count || 0;
      const needed  = cond.count || 1;
      return needed === 1 ? 'pendiente' : `${current}/${needed}`;
    }
    return 'pendiente';
  } catch (_) {
    return 'pendiente';
  }
}

/**
 * Obtener el display de quests activas del jugador (comando `quests`).
 * Implementado según diseño §Decisiones D1 y D6.
 *
 * Formato:
 *   [PRINCIPAL]  🗡️ "Derrota 5 esqueletos en postura agresiva" — 3/5
 *   [SECUNDARIA] 🗺️ "Explora la Sala del Oráculo" — pendiente
 *   [NARRATIVA]  📜 "Las Velas del Altar — Paso 1" (si está activa)
 *
 * @param {Object} player
 * @returns {{ text: string }}
 */
function getQuestsDisplay(player) {
  if (player.is_bot) return { text: 'Los bots no reciben quests.' };

  const rawDb = db.raw();
  const activeQuests = _getActiveQuests(player.id);

  const lines = ['📋 **QUESTS ACTIVAS**\n'];

  if (!activeQuests.length) {
    // Sin quests activas — mensaje orientativo
    lines.push('  No tenés quests activas en este momento.');
    lines.push('  (Al hacer login se te asignan quests según tu clase y facción.)\n');
    if (!player.faction) {
      lines.push('💡 Sin facción activa — uniéndote a una, recibirías misiones especiales de tu gremio.');
      lines.push('   Comando: `facciones`');
    }
    return { text: lines.join('\n') };
  }

  // Ordenar por slot: principal → secundaria → narrativa
  const SLOT_ORDER = { principal: 0, secundaria: 1, narrativa: 2 };
  activeQuests.sort((a, b) => (SLOT_ORDER[a.slot] ?? 9) - (SLOT_ORDER[b.slot] ?? 9));

  const SLOT_LABELS = {
    principal:  '[PRINCIPAL] ',
    secundaria: '[SECUNDARIA]',
    narrativa:  '[NARRATIVA] ',
  };

  for (const q of activeQuests) {
    const icon      = _questIcon(q.type, q.slot);
    const label     = SLOT_LABELS[q.slot] || '[QUEST]     ';
    const progress  = _progressText(q, q.progress);
    lines.push(`  ${label} ${icon} "${q.name}" — ${progress}`);
  }

  lines.push('');
  lines.push('Comandos: `quest info <nombre>` · `quest historial` · `quest abandonar <nombre>`');

  if (!player.faction) {
    lines.push('\n💡 Sin facción activa — uniéndote a una, recibirías quests especiales de tu gremio.');
  }

  return { text: lines.join('\n') };
}

/**
 * Obtener detalle de una quest por nombre (comando `quest info <nombre>`).
 * Busca por coincidencia parcial case-insensitive en el nombre de la quest activa.
 *
 * @param {Object} player
 * @param {string} questName
 * @returns {{ text: string }}
 */
function getQuestDetail(player, questName) {
  if (!questName) return { text: 'Uso: `quest info <nombre>`' };

  const activeQuests = _getActiveQuests(player.id);
  if (!activeQuests.length) return { text: 'No tenés quests activas.' };

  const query = questName.toLowerCase();
  const q = activeQuests.find(aq => aq.name.toLowerCase().includes(query));

  if (!q) {
    return {
      text: `No encontré una quest activa llamada "${questName}".\nTus quests activas: ${activeQuests.map(aq => `"${aq.name}"`).join(', ')}`
    };
  }

  const lines = [];
  const icon = _questIcon(q.type, q.slot);
  lines.push(`${icon} **${q.name}**`);
  lines.push('');
  lines.push(q.description || '(sin descripción)');
  lines.push('');

  // Progreso
  const progressText = _progressText(q, q.progress);
  lines.push(`**Progreso:** ${progressText}`);

  // Recompensa
  try {
    const reward = JSON.parse(q.reward || '{}');
    const rewardParts = [];
    if (reward.gold)             rewardParts.push(`${reward.gold} 💰 gold`);
    if (reward.xp)               rewardParts.push(`${reward.xp} ⭐ XP`);
    if (reward.aldric_rep)       rewardParts.push(`+${reward.aldric_rep} 📖 Rep.Aldric`);
    if (reward.faction_influence) rewardParts.push(`+${reward.faction_influence} 🏴 influencia`);
    if (rewardParts.length) lines.push(`**Recompensa:** ${rewardParts.join(', ')}`);
  } catch (_) {}

  // Hint según condición (D5: hint para quests de crafteo si falta ingrediente)
  try {
    const cond = JSON.parse(q.condition || '{}');
    if (q.type === 'craft' && cond.item_hint) {
      lines.push(`\n🔧 *${cond.item_hint}*`);
    }
    if (q.type === 'explore' && cond.location_hint) {
      lines.push(`\n🗺️ *${cond.location_hint}*`);
    }
  } catch (_) {}

  lines.push(`\nSlot: ${q.slot}`);

  return { text: lines.join('\n') };
}

/**
 * Abandonar una quest activa del jugador.
 * Implementa cooldown: no puede volver a recibir la misma quest en 7 días.
 *
 * @param {Object} player
 * @param {string} questName
 * @returns {{ text: string }}
 */
function abandonQuest(player, questName) {
  if (!questName) return { text: 'Uso: `quest abandonar <nombre>`' };

  const activeQuests = _getActiveQuests(player.id);
  if (!activeQuests.length) return { text: 'No tenés quests activas para abandonar.' };

  const query = questName.toLowerCase();
  const q = activeQuests.find(aq => aq.name.toLowerCase().includes(query));

  if (!q) {
    return {
      text: `No encontré una quest activa llamada "${questName}".\nTus quests activas: ${activeQuests.map(aq => `"${aq.name}"`).join(', ')}`
    };
  }

  try {
    const rawDb = db.raw();
    const now = new Date().toISOString();
    rawDb.run(
      `UPDATE player_quests SET status = 'abandoned', completed_at = ? WHERE id = ?`,
      [now, q.id]
    );
    return { text: `Quest "${q.name}" abandonada.\n⚠️ No podrás recibir esta quest nuevamente por 7 días.` };
  } catch (e) {
    console.error('[questEngine] Error en abandonQuest:', e.message);
    return { text: 'Error al abandonar la quest. Intentá de nuevo.' };
  }
}

/**
 * Obtener historial de quests completadas del jugador.
 *
 * @param {Object} player
 * @returns {{ text: string }}
 */
function getHistory(player) {
  if (player.is_bot) return { text: 'Los bots no tienen historial.' };

  try {
    const rawDb = db.raw();
    const result = rawDb.exec(
      `SELECT pq.completed_at, qd.name, qd.type
       FROM player_quests pq
       JOIN quest_definitions qd ON qd.id = pq.quest_id
       WHERE pq.player_id = ? AND pq.status = 'completed'
       ORDER BY pq.completed_at DESC
       LIMIT 20`,
      [player.id]
    );

    if (!result.length || !result[0].values.length) {
      return { text: '📜 **Historial de quests**\n\nAún no completaste ninguna quest.' };
    }

    const cols = result[0].columns;
    const rows = result[0].values.map(r => Object.fromEntries(cols.map((c, i) => [c, r[i]])));

    const lines = [`📜 **Historial de quests** (últimas ${rows.length})\n`];
    for (const row of rows) {
      const icon = _questIcon(row.type, null);
      const date = row.completed_at ? row.completed_at.slice(0, 10) : '?';
      lines.push(`  ${icon} ${row.name}  _(${date})_`);
    }

    return { text: lines.join('\n') };
  } catch (e) {
    console.error('[questEngine] Error en getHistory:', e.message);
    return { text: '📜 Historial de quests: error al consultar.' };
  }
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
