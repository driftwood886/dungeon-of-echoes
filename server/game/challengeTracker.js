// challengeTracker.js — Tracking de progreso de desafíos diarios (T-1231)
// Integra contadores de kill/craft/loot/buy/sell con el sistema de desafíos (T-1228..T-1230).
//
// Flujo:
//   1. Al ocurrir un evento (kill, craft, loot, buy, sell), llamar la función correspondiente.
//   2. Se obtienen los desafíos del día del jugador (ya inicializados por el assigner al login).
//   3. Para cada desafío cuya condition matchea el evento, se incrementa el progreso en BD.
//   4. Si el desafío se completa (progress >= amount), se da la recompensa y se retorna mensaje.
//
// IMPORTANTE: No rompe si falla — todos los errores son silenciados para no interrumpir el juego.

'use strict';

const db = require('../db/db');
const { getDailyChallengesForPlayer, getTodayUtc } = require('./challengeAssigner');

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades internas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normaliza un string para comparación: minúsculas, sin tildes, sin espacios extra.
 */
function norm(s) {
  return (s || '').toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Verifica si un desafío ya fue completado hoy (progress >= amount).
 * @param {string} playerId
 * @param {string} challengeId
 * @param {number} amount
 * @param {string} dateUtc
 * @returns {boolean}
 */
function isAlreadyCompleted(playerId, challengeId, amount, dateUtc) {
  try {
    const rows = db.getDailyChallengeProgress(playerId, dateUtc);
    const row = rows.find(r => r.challenge_id === challengeId);
    return row ? row.count >= amount : false;
  } catch (_) {
    return false;
  }
}

/**
 * Da la recompensa de un desafío completado al jugador.
 * También activa el Impulso del Aventurero si es el primer desafío del día,
 * y da bonus de oro + aldric_rep si completa los 3.
 * Retorna un string con el mensaje de recompensa.
 * @param {string} playerId
 * @param {object} challenge — objeto challenge completo
 * @returns {string}
 */
function giveReward(playerId, challenge) {
  try {
    const fresh = db.getPlayer(playerId);
    if (!fresh) return '';
    const { xp = 0, gold = 0, rep = 0 } = challenge.reward || {};
    const updates = {};
    if (xp > 0)   updates.xp   = (fresh.xp   || 0) + xp;
    if (gold > 0) updates.gold = (fresh.gold  || 0) + gold;
    if (xp > 0 && updates.xp) {
      // Recalcular nivel con curva cuadrática
      try {
        const xpSystem = require('./xp');
        updates.level = xpSystem.levelFromXp(updates.xp);
      } catch (_) {}
    }
    if (Object.keys(updates).length > 0) db.updatePlayer(playerId, updates);
    if (rep > 0) {
      try { db.addReputation(playerId, rep); } catch (_) {}
    }

    // IMPL-GD-1709: Si es un Gran Desafío colectivo y el jugador tiene facción, dar influencia
    if (challenge.category === 'gran_desafio') {
      try {
        const freshForFaction = db.getPlayer(playerId);
        if (freshForFaction && freshForFaction.faction) {
          const bonusByType = { kill_collective: 3, craft_collective: 2, kill_any: 10 };
          const influenceBonus = bonusByType[challenge.condition.type] || 1;
          db.addFactionInfluence(playerId, influenceBonus);
        }
      } catch (_) { /* no interrumpir si falla */ }
    }

    const parts = [];
    if (xp > 0)   parts.push(`+${xp} XP`);
    if (gold > 0) parts.push(`+${gold} 🪙`);
    if (rep > 0)  parts.push(`+${rep} Reputación`);
    let msg = `\n🏆 ¡DESAFÍO COMPLETADO! «${challenge.title}» — ${parts.join(' · ')}`;

    // T-1233: Verificar si es el primer desafío del día → activar Impulso del Aventurero
    try {
      const dateUtc = getTodayUtc();
      const allChallenges = getDailyChallengesForPlayer(fresh);
      const progressRows = db.getDailyChallengeProgress(playerId, dateUtc);
      const completedCount = allChallenges.filter(ch => {
        if (!ch) return false;
        const row = progressRows.find(r => r.challenge_id === ch.id);
        return row && row.count >= ch.condition.amount;
      }).length;

      // Primer desafío completado (completedCount incluye el actual ya guardado)
      if (completedCount === 1) {
        const IMPULSO_MS = 15 * 60 * 1000;
        const expiresAt = Date.now() + IMPULSO_MS;
        const impulsoKey = `impulso_aventurero_${playerId}`;
        db.setWorldState(impulsoKey, expiresAt);
        msg += `\n✨ ¡IMPULSO DEL AVENTURERO! +20% XP en combate por 15 minutos.`;
      }

      // Los 3 desafíos completados → bonus oro + aldric_rep
      if (completedCount === 3) {
        const playerLevel = fresh.level || 1;
        const bonusGold = 50 + Math.min(50, (playerLevel - 1) * 10); // 50 en niv1, 100 en niv5+
        const freshForBonus = db.getPlayer(playerId);
        db.updatePlayer(playerId, { gold: (freshForBonus.gold || 0) + bonusGold });
        const newAldricRep = db.addAldricRep ? db.addAldricRep(playerId, 1) : null;
        msg += `\n🎉 ¡TRES DESAFÍOS COMPLETADOS! +${bonusGold} 🪙 bonus del día.`;
        if (newAldricRep !== null) {
          msg += `\n🤝 +1 Reputación con Aldric (total: ${newAldricRep} pts)`;
        }
      }
    } catch (_) { /* no interrumpir si falla */ }

    return msg;
  } catch (_) {
    return '';
  }
}

/**
 * Núcleo del tracker: dado un evento y sus parámetros, filtra desafíos relevantes,
 * incrementa progreso y retorna mensajes de recompensa/progreso.
 *
 * @param {string} playerId
 * @param {object} player — objeto player con class, level, etc.
 * @param {string} eventType — tipo de evento: 'kill', 'craft', 'loot', 'buy', 'sell', etc.
 * @param {object} params — parámetros del evento (monsterId, monsterName, itemName, etc.)
 * @returns {string} — mensajes de feedback concatenados (puede ser vacío)
 */
function trackEvent(playerId, player, eventType, params = {}) {
  try {
    const dateUtc = getTodayUtc();
    // Obtener desafíos del día (ya registrados por el assigner al login)
    const challenges = getDailyChallengesForPlayer(player);
    let messages = '';

    for (const challenge of challenges) {
      if (!challenge) continue;
      const cond = challenge.condition;
      let matches = false;

      // ── Evaluación según tipo de condición ──────────────────────────────
      switch (cond.type) {

        case 'kill': {
          if (eventType !== 'kill') break;
          // Si hay target específico, verificar nombre del monstruo
          if (cond.target) {
            matches = norm(params.monsterName) === norm(cond.target);
          } else {
            // Sin target = cualquier kill
            matches = true;
          }
          // Extra: weapon_equipped
          if (matches && cond.extra && cond.extra.weapon_equipped) {
            matches = norm(params.equippedWeapon) === norm(cond.extra.weapon_equipped);
          }
          // Extra: player_min_hp (porcentaje — params.playerHpPct 0..1)
          if (matches && cond.extra && cond.extra.player_min_hp !== undefined) {
            matches = (params.playerHp || 0) >= cond.extra.player_min_hp;
          }
          break;
        }

        case 'session_kills': {
          if (eventType !== 'kill') break;
          // session_kills: contar kills desde el inicio de la sesión (usamos el mismo conteo diario)
          matches = true; // progreso = acumular todas las kills del día
          break;
        }

        case 'kill_boss': {
          if (eventType !== 'kill') break;
          // Bosses: Lich Anciano, Campeón Espectral, Gólem de Piedra, Elemental de Hielo
          const BOSS_NAMES = ['Lich Anciano', 'Campeón Espectral', 'Gólem de Piedra', 'Elemental de Hielo', 'Golem de Forja', 'Krakeling Abismal'];
          matches = BOSS_NAMES.some(b => norm(params.monsterName) === norm(b));
          break;
        }

        case 'kill_with_magic': {
          if (eventType !== 'kill_with_magic') break;
          if (cond.target) {
            matches = norm(params.monsterName) === norm(cond.target);
          } else {
            matches = true;
          }
          break;
        }

        case 'kill_poisoned': {
          if (eventType !== 'kill') break;
          matches = params.monsterWasPoisoned === true;
          break;
        }

        case 'kill_noheal': {
          if (eventType !== 'kill') break;
          matches = params.playerDidntHeal === true;
          break;
        }

        case 'kill_nodmg': {
          if (eventType !== 'kill') break;
          matches = params.playerTookNoDamage === true;
          break;
        }

        case 'kill_event': {
          if (eventType !== 'kill') break;
          // Verificar que hay un evento activo del tipo indicado
          if (cond.extra && cond.extra.event) {
            matches = norm(params.activeEventId) === norm(cond.extra.event);
            // Si hay target adicional (ej: 'espectro'), verificar tipo
            if (matches && cond.target) {
              matches = norm(params.monsterName).includes(norm(cond.target));
            }
          }
          break;
        }

        case 'loot_pickup': {
          if (eventType !== 'loot') break;
          matches = true; // cualquier ítem recogido
          break;
        }

        case 'loot_monster': {
          if (eventType !== 'loot_from_monster') break;
          if (cond.target) {
            matches = norm(params.monsterName) === norm(cond.target);
          } else {
            matches = true;
          }
          break;
        }

        case 'loot_item': {
          if (eventType !== 'loot' && eventType !== 'loot_from_monster') break;
          if (cond.target) {
            matches = norm(params.itemName).includes(norm(cond.target));
          } else {
            matches = true;
          }
          break;
        }

        case 'craft': {
          if (eventType !== 'craft') break;
          matches = true; // cualquier crafteo
          break;
        }

        case 'craft_specific': {
          if (eventType !== 'craft') break;
          matches = norm(params.itemName) === norm(cond.target);
          break;
        }

        case 'craft_weapon': {
          if (eventType !== 'craft') break;
          matches = params.isWeapon === true;
          break;
        }

        case 'cast_spell': {
          if (eventType !== 'cast_spell') break;
          matches = true;
          break;
        }

        case 'spell_damage': {
          if (eventType !== 'spell_damage') break;
          matches = true;
          break;
        }

        case 'poison_applied': {
          if (eventType !== 'poison_applied') break;
          matches = true;
          break;
        }

        case 'skill_use': {
          if (eventType !== 'skill_use') break;
          if (cond.target) {
            matches = norm(params.skillName) === norm(cond.target);
          } else {
            matches = true;
          }
          break;
        }

        case 'visit_rooms': {
          if (eventType !== 'visit_room') break;
          matches = true;
          break;
        }

        case 'heal_other': {
          if (eventType !== 'heal_other') break;
          matches = true;
          break;
        }

        case 'cure_poison': {
          if (eventType !== 'cure_poison') break;
          matches = true;
          break;
        }

        case 'use_altar': {
          if (eventType !== 'use_altar') break;
          matches = true;
          break;
        }

        case 'examine': {
          if (eventType !== 'examine') break;
          // target nulo = cualquier objeto examinado; si hay target = objeto específico
          if (cond.target) {
            matches = norm(params.objectKey || '').includes(norm(cond.target));
          } else {
            matches = true;
          }
          break;
        }

        case 'sell': {
          if (eventType !== 'sell') break;
          // Sin target = cualquier venta
          if (cond.target) {
            matches = norm(params.itemName) === norm(cond.target);
          } else {
            matches = true;
          }
          break;
        }

        case 'buy': {
          // DIS-1526: faltaba este case — el tipo 'buy' nunca matcheaba
          if (eventType !== 'buy') break;
          // Sin target = cualquier compra
          if (cond.target) {
            matches = norm(params.itemName) === norm(cond.target);
          } else {
            matches = true;
          }
          break;
        }

        case 'buy_specific': {
          if (eventType !== 'buy') break;
          matches = norm(params.itemName) === norm(cond.target);
          break;
        }

        case 'sell_weapon': {
          if (eventType !== 'sell') break;
          // Venta de arma (y opcionalmente también compró un arma)
          // La condición extra.also_buy_weapon se evalúa con evento 'buy' en otro paso
          matches = !!(params.isWeapon);
          break;
        }

        case 'equip_crafted': {
          // BUG-1381: El jugador equipó un arma que crafteó él mismo en esta sesión.
          // Se dispara desde cmdEquip cuando detecta que el ítem está en crafted_weapons del jugador.
          if (eventType !== 'equip_crafted') break;
          matches = true;
          break;
        }

        // ── IMPL-GD-1709: Tipos colectivos del Gran Desafío del Día ─────────
        // El tracking es individual (cada jugador acumula su contribución).
        // Al completar, giveReward() dará influencia de facción si corresponde.
        case 'kill_collective': {
          if (eventType !== 'kill') break;
          if (cond.target) {
            matches = norm(params.monsterName) === norm(cond.target);
          } else {
            // Sin target específico: cualquier kill cuenta (min_contribution en extra)
            matches = true;
          }
          break;
        }

        case 'craft_collective': {
          if (eventType !== 'craft') break;
          matches = true; // cualquier crafteo cuenta para el colectivo
          break;
        }

        case 'kill_any': {
          // Gran Desafío tipo "matar al Lich (el que lo mata gana bonus mayor)"
          if (eventType !== 'kill') break;
          if (cond.target) {
            matches = norm(params.monsterName).includes(norm(cond.target));
          } else {
            matches = true;
          }
          break;
        }

        case 'auction_collective': {
          // Contar subastas del día (evento 'auction_win' o 'bid')
          if (eventType !== 'auction_win' && eventType !== 'bid') break;
          matches = true;
          break;
        }

        case 'use_potion_collective': {
          if (eventType !== 'use_potion') break;
          matches = true;
          break;
        }

        case 'kill_collective_week':
        case 'craft_collective_week':
        case 'auction_collective_week': {
          // Tipos semanales — tratados por el sistema de weekly challenge, no por trackEvent
          break;
        }

        default:
          // Tipo desconocido — ignorar silenciosamente
          break;
      }

      if (!matches) continue;

      // ── Verificar si ya estaba completado antes del incremento ──────────
      const alreadyDone = isAlreadyCompleted(playerId, challenge.id, challenge.condition.amount, dateUtc);
      if (alreadyDone) continue;

      // ── Incrementar progreso en BD ───────────────────────────────────────
      const increment = (eventType === 'spell_damage' && params.damageAmount)
        ? params.damageAmount
        : 1;
      db.updateChallengeProgress(playerId, challenge.id, dateUtc, increment);

      // ── Verificar si ahora está completado ──────────────────────────────
      const rows = db.getDailyChallengeProgress(playerId, dateUtc);
      const row = rows.find(r => r.challenge_id === challenge.id);
      const newCount = row ? row.count : 0;

      if (newCount >= challenge.condition.amount) {
        // ¡Completado! Dar recompensa
        messages += giveReward(playerId, challenge);
      } else {
        // Mostrar progreso (solo si falta poco: últimos 2 pasos)
        const remaining = challenge.condition.amount - newCount;
        if (remaining <= 2) {
          messages += `\n📋 Desafío «${challenge.title}»: ${newCount}/${challenge.condition.amount}`;
        }
      }
    }

    return messages;
  } catch (err) {
    // No romper el flujo del juego si falla el tracker
    return '';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// API pública — funciones específicas por evento
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Llamar cuando un jugador mata un monstruo.
 * @param {string} playerId
 * @param {object} player — objeto player
 * @param {object} monster — objeto monster con { id, name, hp, status_effects }
 * @param {object} [extras] — { equippedWeapon, playerHp, playerTookNoDamage, playerDidntHeal, activeEventId }
 * @returns {string} — mensajes de feedback
 */
function trackKill(playerId, player, monster, extras = {}) {
  const monsterName = (monster.name || '').replace(/^⭐ /, ''); // quitar prefijo élite
  const monsterSe = monster.status_effects
    ? (typeof monster.status_effects === 'string' ? JSON.parse(monster.status_effects) : monster.status_effects)
    : {};

  return trackEvent(playerId, player, 'kill', {
    monsterName,
    monsterId: monster.id,
    monsterWasPoisoned: !!(monsterSe.poisoned),
    equippedWeapon: extras.equippedWeapon || null,
    playerHp: extras.playerHp || 0,
    playerTookNoDamage: extras.playerTookNoDamage || false,
    playerDidntHeal: extras.playerDidntHeal || false,
    activeEventId: extras.activeEventId || null,
  });
}

/**
 * Llamar cuando un jugador craftea un ítem.
 * @param {string} playerId
 * @param {object} player
 * @param {string} itemName — nombre del ítem crafteado
 * @param {boolean} isWeapon
 * @returns {string}
 */
function trackCraft(playerId, player, itemName, isWeapon = false) {
  return trackEvent(playerId, player, 'craft', { itemName, isWeapon });
}

/**
 * Llamar cuando un jugador recoge ítems del suelo (loot/take).
 * @param {string} playerId
 * @param {object} player
 * @param {string[]} itemsPickedUp — array de nombres de ítems recogidos
 * @returns {string}
 */
function trackLoot(playerId, player, itemsPickedUp = []) {
  let messages = '';
  for (const itemName of itemsPickedUp) {
    messages += trackEvent(playerId, player, 'loot', { itemName });
    // loot_item también se dispara con tipo 'loot'
    messages += trackEvent(playerId, player, 'loot_item', { itemName });
  }
  // Para loot_pickup = contar items recogidos (progreso = cantidad)
  if (itemsPickedUp.length > 0) {
    // loot_pickup se dispara UNA vez con increment = cantidad recogida
    // Para eso lo hacemos directamente
    try {
      const dateUtc = getTodayUtc();
      const challenges = getDailyChallengesForPlayer(player);
      for (const ch of challenges) {
        if (!ch || ch.condition.type !== 'loot_pickup') continue;
        const done = isAlreadyCompleted(playerId, ch.id, ch.condition.amount, dateUtc);
        if (done) continue;
        db.updateChallengeProgress(playerId, ch.id, dateUtc, itemsPickedUp.length);
        const rows = db.getDailyChallengeProgress(playerId, dateUtc);
        const row = rows.find(r => r.challenge_id === ch.id);
        const count = row ? row.count : 0;
        if (count >= ch.condition.amount) {
          messages += giveReward(playerId, ch);
        }
      }
    } catch (_) {}
  }
  return messages;
}

/**
 * Llamar cuando un jugador compra un ítem en la tienda.
 * @param {string} playerId
 * @param {object} player
 * @param {string} itemName
 * @param {number} amount
 * @returns {string}
 */
function trackBuy(playerId, player, itemName, amount = 1) {
  return trackEvent(playerId, player, 'buy', { itemName, amount });
}

/**
 * Llamar cuando un jugador vende un ítem.
 * @param {string} playerId
 * @param {object} player
 * @param {string} itemName
 * @param {number} amount
 * @returns {string}
 */
function trackSell(playerId, player, itemName, amount = 1) {
  return trackEvent(playerId, player, 'sell', { itemName, amount });
}

/**
 * Llamar cuando un jugador lanza un hechizo.
 * @param {string} playerId
 * @param {object} player
 * @param {string} spellName
 * @param {number} [damageDealt=0]
 * @returns {string}
 */
function trackSpell(playerId, player, spellName = '', damageDealt = 0) {
  let messages = trackEvent(playerId, player, 'cast_spell', { spellName });
  if (damageDealt > 0) {
    messages += trackEvent(playerId, player, 'spell_damage', { damageAmount: damageDealt });
  }
  return messages;
}

/**
 * Llamar cuando un jugador mata con magia (para condición kill_with_magic).
 * @param {string} playerId
 * @param {object} player
 * @param {object} monster
 * @returns {string}
 */
function trackKillWithMagic(playerId, player, monster) {
  const monsterName = (monster.name || '').replace(/^⭐ /, '');
  return trackEvent(playerId, player, 'kill_with_magic', { monsterName });
}

/**
 * Llamar cuando un jugador entra a una sala (para visit_rooms).
 * @param {string} playerId
 * @param {object} player
 * @param {number} roomId
 * @returns {string}
 */
function trackVisitRoom(playerId, player, roomId) {
  return trackEvent(playerId, player, 'visit_room', { roomId });
}

/**
 * Llamar cuando se usa el altar.
 * @param {string} playerId
 * @param {object} player
 * @returns {string}
 */
function trackUseAltar(playerId, player) {
  return trackEvent(playerId, player, 'use_altar', {});
}

/**
 * Llamar cuando se cura a otro jugador.
 * @param {string} playerId
 * @param {object} player
 * @returns {string}
 */
function trackHealOther(playerId, player) {
  return trackEvent(playerId, player, 'heal_other', {});
}

/**
 * Llamar cuando se cura veneno.
 * @param {string} playerId
 * @param {object} player
 * @returns {string}
 */
function trackCurePoison(playerId, player) {
  return trackEvent(playerId, player, 'cure_poison', {});
}

/**
 * Llamar cuando se aplica veneno a un monstruo.
 * @param {string} playerId
 * @param {object} player
 * @returns {string}
 */
function trackPoisonApplied(playerId, player) {
  return trackEvent(playerId, player, 'poison_applied', {});
}

/**
 * Llamar cuando un jugador examina un objeto del dungeon con éxito.
 * @param {string} playerId
 * @param {object} player
 * @param {string} objectKey — clave del objeto examinado (ej: 'altar', 'pared', 'celdas')
 * @returns {string}
 */
function trackExamine(playerId, player, objectKey = '') {
  return trackEvent(playerId, player, 'examine', { objectKey });
}

/**
 * BUG-1381: Llamar cuando un jugador equipa un ítem que crafteó él mismo en esta sesión.
 * @param {string} playerId
 * @param {object} player
 * @param {string} itemName — nombre del ítem equipado
 * @returns {string}
 */
function trackEquipCrafted(playerId, player, itemName = '') {
  return trackEvent(playerId, player, 'equip_crafted', { itemName });
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  trackKill,
  trackCraft,
  trackLoot,
  trackBuy,
  trackSell,
  trackSpell,
  trackKillWithMagic,
  trackVisitRoom,
  trackUseAltar,
  trackHealOther,
  trackCurePoison,
  trackPoisonApplied,
  trackExamine,
  trackEquipCrafted,
  // Exponer trackEvent por si se necesita para casos edge
  trackEvent,
};
