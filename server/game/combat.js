/**
 * combat.js — Sistema de combate por turnos
 *
 * Cubre T014 (lógica de combate) y T016 (loot al matar).
 *
 * Diseño:
 * - Combate determinístico con variación ligera (±20% de daño)
 * - Cada ronda: player ataca → si monstruo vive → monstruo contraataca
 * - El jugador puede "huir" con el comando `flee`
 * - Al morir el monstruo: soltar loot en la habitación, marcar monster.room_id = null
 * - Al morir el jugador: resetear HP a 5, teleportear a sala de entrada (id: 1)
 */

'use strict';

const db = require('../db/db');

// ─── Constantes ───────────────────────────────────────────────────────────────

const FLEE_CHANCE = 0.5; // 50% de probabilidad de huir con éxito

// Monstruos que pueden envenenar y su probabilidad
const POISONERS = {
  'Araña Tejedora': { chance: 0.4, damage: 2, turns: 4 },
  'Murciélago Vampiro': { chance: 0.2, damage: 1, turns: 3 },
};

// ─── Funciones públicas ───────────────────────────────────────────────────────

/**
 * Ejecuta un turno completo de combate:
 *   1. Jugador ataca al monstruo
 *   2. Si el monstruo sobrevive, contraataca
 *
 * @param {object} player  — objeto jugador de la BD
 * @param {object} monster — objeto monstruo de la BD
 * @returns {{
 *   lines: string[],   // log del combate línea a línea
 *   monsterDead: boolean,
 *   playerDead:  boolean,
 *   loot:        string[],  // ítems soltados (solo si monsterDead)
 * }}
 */
function attackRound(player, monster) {
  const lines = [];
  let monsterDead = false;
  let playerDead  = false;
  let loot        = [];

  // ── Efecto de veneno (al inicio del turno) ───────────────────────────────
  const statusFx = player.status_effects || {};
  if (statusFx.poisoned) {
    const p = statusFx.poisoned;
    const poisonDmg = p.damage || 2;
    player.hp = Math.max(0, player.hp - poisonDmg);
    p.turns = (p.turns || 1) - 1;
    lines.push(`☠ El veneno te quema por dentro (${poisonDmg} dmg). (${player.hp}/${player.max_hp} HP)`);

    if (p.turns <= 0) {
      delete statusFx.poisoned;
      lines.push(`✅ El veneno en tu sangre se disipa.`);
    }

    // Persistir estado
    db.updatePlayer(player.id, { hp: player.hp, status_effects: JSON.stringify(statusFx) });

    if (player.hp <= 0) {
      playerDead = true;
      lines.push(`💀 ¡El veneno acabó contigo! Respawneás en la entrada del dungeon...`);
      const fp = db.getPlayer(player.id);
      db.updatePlayer(player.id, { hp: 5, current_room_id: 1, deaths: (fp.deaths || 0) + 1, status_effects: '{}' });
      return { lines, monsterDead, playerDead, loot };
    }
  }

  // ── Player ataca ─────────────────────────────────────────────────────────
  const playerDmg = calcDamage(player.attack);
  const dmgToMonster = Math.max(1, playerDmg - Math.floor(monster.defense || 0));
  monster.hp = Math.max(0, monster.hp - dmgToMonster);

  lines.push(`⚔  Atacás al ${monster.name} y le causás ${dmgToMonster} de daño. (${monster.hp}/${monster.max_hp} HP)`);

  // Actualizar monstruo en BD
  db.updateMonster(monster.id, { hp: monster.hp });

  if (monster.hp <= 0) {
    monsterDead = true;
    lines.push(`💀 ¡El ${monster.name} cae derrotado!`);

    // Soltar loot en la habitación
    loot = dropLoot(monster, player.current_room_id);
    if (loot.length > 0) {
      lines.push(`💰 El ${monster.name} suelta: ${loot.join(', ')}.`);
    } else {
      lines.push(`El ${monster.name} no deja nada.`);
    }

    // Actualizar kills y XP del jugador
    const xpGain = Math.max(5, Math.floor(monster.max_hp * 2));
    const freshPlayer = db.getPlayer(player.id);
    const newKills = (freshPlayer.kills || 0) + 1;
    const newXp    = (freshPlayer.xp    || 0) + xpGain;
    const oldLevel = freshPlayer.level || 1;
    // Nivel sube cada 50 XP acumulados: nivel = floor(xp/50) + 1
    const newLevel = Math.floor(newXp / 50) + 1;
    const updates  = { kills: newKills, xp: newXp, level: newLevel };
    if (newLevel > oldLevel) {
      // Subida de nivel: +5 max_hp, +1 ataque
      updates.max_hp = (freshPlayer.max_hp || 30) + 5;
      updates.hp     = Math.min(freshPlayer.hp, updates.max_hp);
      updates.attack = (freshPlayer.attack || 5) + 1;
      lines.push(`✨ ¡Subiste al nivel ${newLevel}! +5 HP máx, +1 ataque.`);
    }
    lines.push(`⭐ +${xpGain} XP (total: ${newXp} | kills: ${newKills} | nivel: ${newLevel})`);
    db.updatePlayer(player.id, updates);

    return { lines, monsterDead, playerDead, loot };
  }

  // ── Monstruo contraataca ──────────────────────────────────────────────────
  const monsterDmg = calcDamage(monster.attack);
  const dmgToPlayer = Math.max(1, monsterDmg - Math.floor(player.defense || 0));
  player.hp = Math.max(0, player.hp - dmgToPlayer);

  lines.push(`🩸 El ${monster.name} te golpea y causa ${dmgToPlayer} de daño. (${player.hp}/${player.max_hp} HP)`);

  // ── Posible envenenamiento del monstruo ──────────────────────────────────
  const poisonerDef = POISONERS[monster.name];
  if (poisonerDef && Math.random() < poisonerDef.chance) {
    const currentFx = player.status_effects || {};
    if (!currentFx.poisoned) {
      currentFx.poisoned = { damage: poisonerDef.damage, turns: poisonerDef.turns };
      player.status_effects = currentFx;
      lines.push(`🕷 ¡El ${monster.name} te envenenó! Perderás ${poisonerDef.damage} HP por turno durante ${poisonerDef.turns} turnos. (Usá \"use antídoto\" para curarte)`);
    }
  }

  // Actualizar jugador en BD
  db.updatePlayer(player.id, { hp: player.hp, status_effects: JSON.stringify(player.status_effects || {}) });

  if (player.hp <= 0) {
    playerDead = true;
    lines.push(`💀 ¡Moriste! Respawneás en la entrada del dungeon...`);
    // Reset: HP mínimo, volver a sala 1, incrementar deaths, limpiar efectos
    const freshPlayer2 = db.getPlayer(player.id);
    db.updatePlayer(player.id, { hp: 5, current_room_id: 1, deaths: (freshPlayer2.deaths || 0) + 1, status_effects: '{}' });
  }

  // ── Huida del monstruo (< 25% HP) ────────────────────────────────────────
  if (!monsterDead && !playerDead && monster.hp > 0) {
    const hpPct = monster.hp / monster.max_hp;
    if (hpPct < 0.25 && Math.random() < 0.30) {
      // El monstruo intenta escapar a una sala adyacente
      const room = db.getRoom(player.current_room_id);
      if (room) {
        const exits = room.exits || {};
        // Obtener IDs de salas destino (manejo de exits como objeto o {room_id, key})
        const destinations = Object.values(exits)
          .map(v => (typeof v === 'object' ? v.room_id : v))
          .filter(id => id && id !== player.current_room_id);
        if (destinations.length > 0) {
          const escapeRoom = destinations[Math.floor(Math.random() * destinations.length)];
          db.updateMonster(monster.id, { room_id: escapeRoom });
          lines.push(`🏃 ¡El ${monster.name} huye despavorido hacia otra sala! (HP: ${monster.hp}/${monster.max_hp})`);
        }
      }
    }
  }

  return { lines, monsterDead, playerDead, loot };
}

/**
 * Intento de huida del combate.
 * @param {object} player
 * @param {object} monster
 * @returns {{ fled: boolean, line: string }}
 */
function tryFlee(player, monster) {
  if (Math.random() < FLEE_CHANCE) {
    return {
      fled: true,
      line: `🏃 ¡Conseguís huir del ${monster.name}! Te alejás tambaleante.`,
    };
  }
  // El monstruo golpea al intentar huir
  const monsterDmg = calcDamage(monster.attack);
  const dmgToPlayer = Math.max(1, monsterDmg - Math.floor(player.defense || 0));
  player.hp = Math.max(0, player.hp - dmgToPlayer);
  db.updatePlayer(player.id, { hp: player.hp });

  let line = `🏃 Intentás huir pero el ${monster.name} te bloquea y te golpea (${dmgToPlayer} dmg). (${player.hp}/${player.max_hp} HP)`;

  if (player.hp <= 0) {
    const freshPlayer3 = db.getPlayer(player.id);
    db.updatePlayer(player.id, { hp: 5, current_room_id: 1, deaths: (freshPlayer3.deaths || 0) + 1 });
    line += `\n💀 ¡Moriste! Respawneás en la entrada del dungeon...`;
  }

  return { fled: false, line };
}

/**
 * Busca un monstruo en la habitación que coincida con el nombre dado.
 * Acepta coincidencia parcial case-insensitive.
 * @param {number} roomId
 * @param {string} targetName
 * @returns {object|null}
 */
function findMonsterInRoom(roomId, targetName) {
  const monsters = db.getMonstersInRoom(roomId);
  const name = targetName.toLowerCase().trim();
  return monsters.find(m => m.name.toLowerCase().includes(name)) || null;
}

// ─── Helpers privados ─────────────────────────────────────────────────────────

/**
 * Calcula daño con ±20% de variación.
 * @param {number} base
 * @returns {number}
 */
function calcDamage(base) {
  const variation = 0.8 + Math.random() * 0.4; // 0.8 a 1.2
  return Math.round(base * variation);
}

/**
 * Suelta el loot del monstruo en la habitación y marca al monstruo como muerto.
 * @param {object} monster
 * @param {number} roomId
 * @returns {string[]} ítems soltados
 */
function dropLoot(monster, roomId) {
  const loot = monster.loot || [];

  if (loot.length > 0) {
    // Agregar ítems a la habitación
    const room = db.getRoom(roomId);
    if (room) {
      const newItems = [...room.items, ...loot];
      db.updateRoomItems(roomId, newItems);
    }
  }

  // Programar respawn del monstruo (5 minutos)
  const respawnAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  db.updateMonster(monster.id, {
    hp: 0,
    room_id: null,        // ya no está en ninguna sala
    respawn_at: respawnAt,
  });

  return loot;
}

/**
 * Revisa si hay monstruos que deben respawnear y los resucita.
 * Se llama periódicamente desde el servidor.
 */
function checkRespawns() {
  const now = new Date().toISOString();
  // Buscar todos los monstruos muertos con respawn pendiente
  const rawDb = db.raw();
  if (!rawDb) return;

  const results = rawDb.exec(
    `SELECT * FROM monsters WHERE room_id IS NULL AND respawn_at IS NOT NULL AND respawn_at <= ?`,
    [now]
  );
  if (!results.length) return;

  const { columns, values } = results[0];
  const monsters = values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));

  for (const m of monsters) {
    if (!m.respawn_room_id) continue;
    db.updateMonster(m.id, {
      hp: m.max_hp,
      room_id: m.respawn_room_id,
      respawn_at: null,
    });
    console.log(`[combat] Respawn: ${m.name} en sala ${m.respawn_room_id}`);
  }
}

module.exports = {
  attackRound,
  tryFlee,
  findMonsterInRoom,
  checkRespawns,
};
