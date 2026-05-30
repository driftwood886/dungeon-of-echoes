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
const worldEvents = require('./worldEvents');
const classes = require('./classes'); // T107: bonus de clase
const items = require('./items');    // T110: efectos on_hit de armas crafteadas

// ─── Constantes ───────────────────────────────────────────────────────────────

const FLEE_CHANCE = 0.5; // 50% de probabilidad de huir con éxito

// Monstruos que pueden envenenar y su probabilidad
const POISONERS = {
  'Araña Tejedora': { chance: 0.4, damage: 2, turns: 4 },
  'Murciélago Vampiro': { chance: 0.2, damage: 1, turns: 3 },
};

// Monstruos de tipo BOSS — respawn largo y eventos globales al morir
const BOSS_MONSTERS = {
  13: { // Lich Anciano
    respawnMinutes: 30,
    deathAnnouncement: '💀 ¡El LICH ANCIANO ha caído! Un aventurero ha triunfado en la Catedral de la Oscuridad. El dungeon tiembla...',
    lootBonus: ['monedas de oro', 'monedas de oro', 'monedas de oro', 'monedas de oro', 'monedas de oro'], // 5x = 50g
  },
};

// T145: Habilidades especiales de monstruos
// tipo: 'mana_drain' | 'web' | 'amplify' | 'blind'
const MONSTER_SPECIALS = {
  'Lich Anciano': {
    chance: 0.20,
    type: 'mana_drain',
    amount: 8,
    msg: '🌀 ¡El Lich Anciano te drena la energía arcana! (-{amount} maná)',
  },
  'Araña Tejedora': {
    chance: 0.15,
    type: 'web',
    turns: 1,
    msg: '🕸 ¡La Araña Tejedora te envuelve en telarañas! No podrás atacar el próximo turno.',
  },
  'Eco Viviente': {
    chance: 0.25,
    type: 'amplify',
    multiplier: 1.8,
    msg: '🔊 ¡El Eco Viviente amplifica su golpe con ondas de sonido resonante! (×1.8 daño)',
  },
  'Sombra del Vacío': {
    chance: 0.20,
    type: 'blind',
    amount: 2,
    turns: 2,
    msg: '🌑 ¡La Sombra del Vacío oscurece tu visión! (-{amount} DEF por {turns} turnos)',
  },
};



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
  let poisonSurvived = false;

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
      poisonSurvived = true;
    }

    // Persistir estado
    db.updatePlayer(player.id, { hp: player.hp, status_effects: JSON.stringify(statusFx) });

    if (player.hp <= 0) {
      playerDead = true;
      lines.push(`💀 ¡El veneno acabó contigo! Respawneás en la entrada del dungeon...`);
      const fp = db.getPlayer(player.id);
      db.updatePlayer(player.id, { hp: 5, current_room_id: 1, deaths: (fp.deaths || 0) + 1, status_effects: '{}' });
      db.addJournalEntry(player.id, 'death', `💀 Muerto por veneno luchando contra ${monster.name}.`);
      return { lines, monsterDead, playerDead, loot, poisonSurvived };
    }
  }

  // ── Player ataca ─────────────────────────────────────────────────────────
  // T145: Verificar si el jugador está enredado en telarañas (webbed)
  const freshForWeb = db.getPlayer(player.id);
  const webFx = freshForWeb.status_effects ? (typeof freshForWeb.status_effects === 'string' ? JSON.parse(freshForWeb.status_effects) : freshForWeb.status_effects) : {};
  if (webFx.webbed && webFx.webbed.turns > 0) {
    webFx.webbed.turns -= 1;
    if (webFx.webbed.turns <= 0) {
      delete webFx.webbed;
      lines.push(`🕸 Las telarañas que te retenían se deshacen. ¡Podés atacar de nuevo!`);
    } else {
      lines.push(`🕸 Estás atrapado en telarañas y no podés atacar este turno.`);
    }
    db.updatePlayer(player.id, { status_effects: JSON.stringify(webFx) });
    // Saltar el ataque del jugador, pero el monstruo sí contraataca (seguir flujo)
    // Copiamos webFx a player.status_effects para que la actualización final sea coherente
    player.status_effects = webFx;
    // Ir directo a la fase de ataque del monstruo (sin retornar)
    const monsterDmgW = calcDamage(monster.attack);
    const activeEvW = worldEvents.getCurrentEvent();
    const bloodmoonBonusW = (activeEvW && activeEvW.id === 'bloodmoon') ? 2 : 0;
    const dodgeChanceW = 0.08 + (classes.getPlayerClass(player) ? (classes.getPlayerClass(player).dodge_bonus || 0) / 100 : 0);
    if (Math.random() < dodgeChanceW) {
      lines.push(`💨 ¡Incluso atrapado, esquivás el ataque del ${monster.name}!`);
    } else {
      const freshForShieldW = db.getPlayer(player.id);
      const shieldActiveW = freshForShieldW.shield_active || 0;
      let dmgToPlayerW = Math.max(1, monsterDmgW + bloodmoonBonusW - Math.floor(player.defense || 0));
      if (shieldActiveW) {
        const absorb = 5;
        dmgToPlayerW = Math.max(0, dmgToPlayerW - absorb);
        db.updatePlayer(player.id, { shield_active: 0 });
        lines.push(`🛡️ ¡Tu escudo mágico absorbe algo de daño! (→ ${dmgToPlayerW})`);
      }
      player.hp = Math.max(0, player.hp - dmgToPlayerW);
      lines.push(`🩸 El ${monster.name} aprovecha que estás enredado y te golpea por ${dmgToPlayerW} de daño. (${player.hp}/${player.max_hp} HP)`);
    }
    db.updatePlayer(player.id, { hp: player.hp });
    if (player.hp <= 0) {
      playerDead = true;
      lines.push(`💀 ¡Moriste! Respawneás en la entrada del dungeon...`);
      const fpW = db.getPlayer(player.id);
      db.updatePlayer(player.id, { hp: 5, current_room_id: 1, deaths: (fpW.deaths || 0) + 1, status_effects: '{}' });
      db.addJournalEntry(player.id, 'death', `💀 Caíste en combate contra ${monster.name} (atrapado en telarañas).`);
    }
    return { lines, monsterDead, playerDead, loot, poisonSurvived };
  }

  // T120: bonus de +1 ATK si el jugador tiene mascota
  const petBonus = player.pet ? 1 : 0;
  // T153: bonus de pergaminos mágicos activos
  const scrolls = JSON.parse(player.active_scrolls || '{}');
  const now153 = Date.now();
  let scrollAtkBonus = 0;
  let scrollDefBonus = 0;
  const expiredScrollKeys = [];
  for (const [effect, data] of Object.entries(scrolls)) {
    if (data.expires_at > now153) {
      scrollAtkBonus += data.atk_bonus || 0;
      scrollDefBonus += data.def_bonus || 0;
    } else {
      expiredScrollKeys.push(effect);
    }
  }
  if (expiredScrollKeys.length > 0) {
    for (const k of expiredScrollKeys) delete scrolls[k];
    db.updatePlayer(player.id, { active_scrolls: JSON.stringify(scrolls) });
  }
  const effectiveAtk = player.attack + petBonus + scrollAtkBonus;
  const playerDmg = calcDamage(effectiveAtk);
  // T107: bonus crítico de clase (Pícaro tiene +15% sobre base del 10%)
  const clsData = classes.getPlayerClass(player);
  const critChance = 0.10 + (clsData ? (clsData.crit_bonus || 0) / 100 : 0);
  const isCrit = Math.random() < critChance;
  const rawPlayerDmg = isCrit ? playerDmg * 2 : playerDmg;
  const dmgToMonster = Math.max(1, rawPlayerDmg - Math.floor(monster.defense || 0));
  monster.hp = Math.max(0, monster.hp - dmgToMonster);

  if (isCrit) {
    lines.push(`💥 ¡GOLPE CRÍTICO! Atacás al ${monster.name} con fuerza devastadora: ${dmgToMonster} de daño. (${monster.hp}/${monster.max_hp} HP)`);
  } else {
    lines.push(`⚔  Atacás al ${monster.name} y le causás ${dmgToMonster} de daño. (${monster.hp}/${monster.max_hp} HP)`);
  }

  // Actualizar monstruo en BD
  db.updateMonster(monster.id, { hp: monster.hp });

  // ── T110: Efecto on_hit del arma equipada ────────────────────────────────
  // Si el jugador tiene un arma crafteada con efecto especial, aplicarlo al monstruo (si sigue vivo)
  if (monster.hp > 0) {
    const equippedWeapon = player.equipped_weapon;
    if (equippedWeapon) {
      const weaponDef = items.getItemDef(equippedWeapon);
      if (weaponDef && weaponDef.on_hit) {
        const onHit = weaponDef.on_hit;
        if (Math.random() < onHit.chance) {
          if (onHit.type === 'poison') {
            // Envenenar al monstruo: se guarda en monster status_effects JSON
            const monsterFx = monster.status_effects ? (typeof monster.status_effects === 'string' ? JSON.parse(monster.status_effects) : monster.status_effects) : {};
            if (!monsterFx.poisoned) {
              monsterFx.poisoned = { damage: onHit.damage, turns: onHit.turns };
              monster.status_effects = monsterFx;
              db.updateMonster(monster.id, { status_effects: JSON.stringify(monsterFx) });
              lines.push(`🕷 ¡Tu ${equippedWeapon} envenena al ${monster.name}! (${onHit.damage} dmg/turno por ${onHit.turns} turnos)`);
            }
          } else if (onHit.type === 'shadow_bolt') {
            // Rayo de sombra: daño extra inmediato
            const shadowDmg = onHit.bonus_damage || 8;
            monster.hp = Math.max(0, monster.hp - shadowDmg);
            db.updateMonster(monster.id, { hp: monster.hp });
            lines.push(`🌑 ¡El grimorio libera un RAYO DE SOMBRA! ${shadowDmg} daño extra al ${monster.name}. (${monster.hp}/${monster.max_hp} HP)`);
            if (monster.hp <= 0) {
              monsterDead = true;
              lines.push(`💀 ¡El ${monster.name} cae derrotado por las sombras!`);
              const { droppedLoot, globalEvent } = dropLoot(monster, player.current_room_id);
              loot = droppedLoot;
              if (loot.length > 0) lines.push(`💰 El ${monster.name} suelta: ${loot.join(', ')}.`);
              else lines.push(`El ${monster.name} no deja nada.`);
              const xpBase2 = Math.max(5, Math.floor(monster.max_hp * 2));
              const activeEv2 = worldEvents.getCurrentEvent();
              const xpGain2 = activeEv2 && activeEv2.id === 'invasion' ? Math.floor(xpBase2 * 1.5) : xpBase2;
              const freshPl2 = db.getPlayer(player.id);
              const newKills2 = (freshPl2.kills || 0) + 1;
              const newXp2    = (freshPl2.xp    || 0) + xpGain2;
              const oldLevel2 = freshPl2.level || 1;
              const newLevel2 = Math.floor(newXp2 / 50) + 1;
              const updates2  = { kills: newKills2, xp: newXp2, level: newLevel2 };
              if (newLevel2 > oldLevel2) {
                updates2.max_hp = (freshPl2.max_hp || 30) + 5;
                updates2.hp = Math.min(freshPl2.hp, updates2.max_hp);
                updates2.attack = (freshPl2.attack || 5) + 1;
                lines.push(`✨ ¡Subiste al nivel ${newLevel2}! +5 HP máx, +1 ataque.`);
              }
              lines.push(`⭐ +${xpGain2} XP (total: ${newXp2} | kills: ${newKills2} | nivel: ${newLevel2})`);
              db.updatePlayer(player.id, updates2);
              return { lines, monsterDead, playerDead, loot, globalEvent: globalEvent || null };
            }
          }
        }
      }
    }
  }

  // ── Efecto de veneno del monstruo (si está envenenado por on_hit) ─────────
  if (monster.hp > 0 && monster.status_effects) {
    const mFx = typeof monster.status_effects === 'string' ? JSON.parse(monster.status_effects) : monster.status_effects;
    if (mFx.poisoned) {
      const mpd = mFx.poisoned;
      const mpDmg = mpd.damage || 1;
      monster.hp = Math.max(0, monster.hp - mpDmg);
      mpd.turns = (mpd.turns || 1) - 1;
      lines.push(`☠ El veneno drena al ${monster.name} (${mpDmg} dmg). (${monster.hp}/${monster.max_hp} HP)`);
      if (mpd.turns <= 0) {
        delete mFx.poisoned;
        lines.push(`El veneno en ${monster.name} se disipa.`);
      }
      monster.status_effects = mFx;
      db.updateMonster(monster.id, { hp: monster.hp, status_effects: JSON.stringify(mFx) });
      if (monster.hp <= 0) {
        monsterDead = true;
        lines.push(`💀 ¡El ${monster.name} cae derrotado por el veneno!`);
        const { droppedLoot, globalEvent } = dropLoot(monster, player.current_room_id);
        loot = droppedLoot;
        if (loot.length > 0) lines.push(`💰 El ${monster.name} suelta: ${loot.join(', ')}.`);
        else lines.push(`El ${monster.name} no deja nada.`);
        const xpBase3 = Math.max(5, Math.floor(monster.max_hp * 2));
        const activeEv3 = worldEvents.getCurrentEvent();
        const xpGain3 = activeEv3 && activeEv3.id === 'invasion' ? Math.floor(xpBase3 * 1.5) : xpBase3;
        const freshPl3 = db.getPlayer(player.id);
        const newKills3 = (freshPl3.kills || 0) + 1;
        const newXp3    = (freshPl3.xp    || 0) + xpGain3;
        const oldLevel3 = freshPl3.level || 1;
        const newLevel3 = Math.floor(newXp3 / 50) + 1;
        const updates3  = { kills: newKills3, xp: newXp3, level: newLevel3 };
        if (newLevel3 > oldLevel3) {
          updates3.max_hp = (freshPl3.max_hp || 30) + 5;
          updates3.hp = Math.min(freshPl3.hp, updates3.max_hp);
          updates3.attack = (freshPl3.attack || 5) + 1;
          lines.push(`✨ ¡Subiste al nivel ${newLevel3}! +5 HP máx, +1 ataque.`);
        }
        lines.push(`⭐ +${xpGain3} XP (total: ${newXp3} | kills: ${newKills3} | nivel: ${newLevel3})`);
        db.updatePlayer(player.id, updates3);
        return { lines, monsterDead, playerDead, loot, globalEvent: globalEvent || null };
      }
    }
  }


  if (monster.hp <= 0) {
    monsterDead = true;
    lines.push(`💀 ¡El ${monster.name} cae derrotado!`);

    // Soltar loot en la habitación
    const { droppedLoot, globalEvent } = dropLoot(monster, player.current_room_id);
    loot = droppedLoot;
    if (loot.length > 0) {
      lines.push(`💰 El ${monster.name} suelta: ${loot.join(', ')}.`);
    } else {
      lines.push(`El ${monster.name} no deja nada.`);
    }

    // Actualizar kills y XP del jugador
    const xpBase = Math.max(5, Math.floor(monster.max_hp * 2));
    // Bonus de XP si hay evento invasión
    const activeEv = worldEvents.getCurrentEvent();
    const xpGain = activeEv && activeEv.id === 'invasion'
      ? Math.floor(xpBase * 1.5)
      : xpBase;
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

    return { lines, monsterDead, playerDead, loot, globalEvent: globalEvent || null };
  }

  // ── T114: Verificar si el monstruo está aturdido (shield_bash stun) ────────
  const monsterFxForStun = monster.status_effects ? (typeof monster.status_effects === 'string' ? JSON.parse(monster.status_effects) : monster.status_effects) : {};
  if (monsterFxForStun.stunned && monsterFxForStun.stunned.turns > 0) {
    monsterFxForStun.stunned.turns -= 1;
    if (monsterFxForStun.stunned.turns <= 0) {
      delete monsterFxForStun.stunned;
      lines.push(`😵 El ${monster.name} se recupera del aturdimiento.`);
    } else {
      lines.push(`😵 El ${monster.name} está aturdido y no puede atacar este turno.`);
    }
    monster.status_effects = monsterFxForStun;
    db.updateMonster(monster.id, { status_effects: JSON.stringify(monsterFxForStun) });
    db.updatePlayer(player.id, { hp: player.hp, status_effects: JSON.stringify(player.status_effects || {}) });
    return { lines, monsterDead, playerDead, loot };
  }

  // ── Monstruo contraataca ──────────────────────────────────────────────────
  const monsterDmg = calcDamage(monster.attack);
  // Bonus daño si hay evento luna de sangre
  const activeEvMon = worldEvents.getCurrentEvent();
  const bloodmoonBonus = (activeEvMon && activeEvMon.id === 'bloodmoon') ? 2 : 0;

  // T101: 8% de esquiva — el jugador evita el daño por completo
  // T107: Pícaro tiene +12% de esquiva extra
  const dodgeChance = 0.08 + (clsData ? (clsData.dodge_bonus || 0) / 100 : 0);
  const isEvasion = Math.random() < dodgeChance;
  if (isEvasion) {
    lines.push(`💨 ¡Esquivás el ataque del ${monster.name}! Ningún daño recibido.`);
  } else {
    // T145: Si el jugador está cegado, su DEF efectiva se reduce
    const freshForBlindCheck = db.getPlayer(player.id);
    const blindFx = freshForBlindCheck.status_effects ? (typeof freshForBlindCheck.status_effects === 'string' ? JSON.parse(freshForBlindCheck.status_effects) : freshForBlindCheck.status_effects) : {};
    const blindDef = blindFx.blinded ? (blindFx.blinded.amount || 0) : 0;
    const rawDmgToPlayer = Math.max(1, monsterDmg + bloodmoonBonus - Math.floor((player.defense || 0) - blindDef + scrollDefBonus));
    // T104: Escudo mágico activo absorbe 5 de daño
    const freshForShield = freshForBlindCheck; // reusar la lectura
    const shieldActive = freshForShield.shield_active || 0;
    let dmgToPlayer = rawDmgToPlayer;
    if (shieldActive) {
      const shieldAbsorb = 5;
      dmgToPlayer = Math.max(0, rawDmgToPlayer - shieldAbsorb);
      db.updatePlayer(player.id, { shield_active: 0 });
      lines.push(`🛡️ ¡Tu escudo mágico absorbe ${Math.min(shieldAbsorb, rawDmgToPlayer)} puntos de daño! (${rawDmgToPlayer} → ${dmgToPlayer})`);
    }

    player.hp = Math.max(0, player.hp - dmgToPlayer);

    const bloodmoonSuffix = bloodmoonBonus > 0 ? ` 🩸(+${bloodmoonBonus} Luna de Sangre)` : '';
    lines.push(`🩸 El ${monster.name} te golpea y causa ${dmgToPlayer} de daño.${bloodmoonSuffix} (${player.hp}/${player.max_hp} HP)`);

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

    // ── T145: Habilidad especial del monstruo ────────────────────────────────
    const specialDef = MONSTER_SPECIALS[monster.name];
    if (specialDef && Math.random() < specialDef.chance) {
      const spFx = player.status_effects ? (typeof player.status_effects === 'string' ? JSON.parse(player.status_effects) : player.status_effects) : {};
      const rawMsg = specialDef.msg
        .replace('{amount}', specialDef.amount || '')
        .replace('{turns}', specialDef.turns || '');

      if (specialDef.type === 'mana_drain') {
        // Drenar maná del jugador
        const freshForMana = db.getPlayer(player.id);
        const curMana = freshForMana.mana || 0;
        const drained = Math.min(curMana, specialDef.amount);
        db.updatePlayer(player.id, { mana: Math.max(0, curMana - drained) });
        lines.push(rawMsg + (drained < specialDef.amount ? ` (solo tenías ${curMana} maná)` : ''));

      } else if (specialDef.type === 'web') {
        // Enredar al jugador por N turnos
        if (!spFx.webbed) {
          spFx.webbed = { turns: specialDef.turns };
          player.status_effects = spFx;
          lines.push(rawMsg);
        }

      } else if (specialDef.type === 'amplify') {
        // El daño del ataque actual se amplifica (ya fue aplicado, aplicar daño extra)
        const extraDmg = Math.max(1, Math.floor(monsterDmg * (specialDef.multiplier - 1)));
        player.hp = Math.max(0, player.hp - extraDmg);
        lines.push(`${rawMsg} (+${extraDmg} daño extra!) (${player.hp}/${player.max_hp} HP)`);

      } else if (specialDef.type === 'blind') {
        // Reducir DEF por N turnos
        if (!spFx.blinded) {
          spFx.blinded = { amount: specialDef.amount, turns: specialDef.turns };
          player.status_effects = spFx;
          lines.push(rawMsg);
        }
      }
    }
  } // fin else (no esquivó)

  // Actualizar jugador en BD
  db.updatePlayer(player.id, { hp: player.hp, status_effects: JSON.stringify(player.status_effects || {}) });

  // ── T145: Aplicar efecto ceguera (blinded) al contador de DEF ──────────────
  // El efecto blinded ya se aplica como debuff en los siguientes turnos al calcular daño.
  // Aquí descontamos un turno al efecto blinded si está activo.
  const freshForBlind = db.getPlayer(player.id);
  const bFx = freshForBlind.status_effects ? (typeof freshForBlind.status_effects === 'string' ? JSON.parse(freshForBlind.status_effects) : freshForBlind.status_effects) : {};
  if (bFx.blinded && bFx.blinded.turns > 0) {
    bFx.blinded.turns -= 1;
    if (bFx.blinded.turns <= 0) {
      delete bFx.blinded;
      lines.push(`👁 Tu visión se recupera. La oscuridad se disipa.`);
      db.updatePlayer(player.id, { status_effects: JSON.stringify(bFx), defense: player.defense }); // defense ya estaba OK
    }
  }

  if (player.hp <= 0) {
    playerDead = true;
    lines.push(`💀 ¡Moriste! Respawneás en la entrada del dungeon...`);
    // Reset: HP mínimo, volver a sala 1, incrementar deaths, limpiar efectos
    const freshPlayer2 = db.getPlayer(player.id);
    db.updatePlayer(player.id, { hp: 5, current_room_id: 1, deaths: (freshPlayer2.deaths || 0) + 1, status_effects: '{}' });
    db.addJournalEntry(player.id, 'death', `💀 Caíste en combate contra ${monster.name}.`);
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

  return { lines, monsterDead, playerDead, loot, poisonSurvived };
}

/**
 * Intento de huida del combate.
 * @param {object} player
 * @param {object} monster
 * @param {object|null} room — sala actual (para elegir sala de escape)
 * @returns {{ fled: boolean, line: string, destRoomId: number|null }}
 */
function tryFlee(player, monster, room) {
  // Porcentaje de HP del monstruo
  const monsterHpPct = Math.round((monster.hp / monster.max_hp) * 100);
  const monsterHpDesc = monsterHpPct <= 25
    ? `herido de gravedad (${monsterHpPct}% HP)`
    : monsterHpPct <= 50
      ? `maltrecho (${monsterHpPct}% HP)`
      : monsterHpPct <= 75
        ? `dañado (${monsterHpPct}% HP)`
        : `casi intacto (${monsterHpPct}% HP)`;

  if (Math.random() < FLEE_CHANCE) {
    // Mover al jugador a una sala adyacente aleatoria
    let destRoomId = null;
    let destRoomName = null;
    if (room) {
      const exits = room.exits || {};
      const exitRooms = Object.values(exits)
        .map(v => (typeof v === 'object' ? v.room_id : v))
        .filter(id => typeof id === 'number');
      if (exitRooms.length > 0) {
        destRoomId = exitRooms[Math.floor(Math.random() * exitRooms.length)];
        const destRoom = db.getRoom(destRoomId);
        destRoomName = destRoom ? destRoom.name : null;
        db.updatePlayer(player.id, { current_room_id: destRoomId });
      }
    }
    const toText = destRoomName ? ` Te refugiás en «${destRoomName}».` : '';
    return {
      fled: true,
      destRoomId,
      line: `🏃 ¡Conseguís huir del ${monster.name} (${monsterHpDesc})!${toText}`,
    };
  }
  // El monstruo golpea al intentar huir
  const monsterDmg = calcDamage(monster.attack);
  const dmgToPlayer = Math.max(1, monsterDmg - Math.floor(player.defense || 0));
  player.hp = Math.max(0, player.hp - dmgToPlayer);
  db.updatePlayer(player.id, { hp: player.hp });

  let line = `🏃 Intentás huir pero el ${monster.name} (${monsterHpDesc}) te bloquea y te golpea (${dmgToPlayer} dmg). Tu HP: ${player.hp}/${player.max_hp}.`;

  if (player.hp <= 0) {
    const freshPlayer3 = db.getPlayer(player.id);
    db.updatePlayer(player.id, { hp: 5, current_room_id: 1, deaths: (freshPlayer3.deaths || 0) + 1 });
    db.addJournalEntry(player.id, 'death', `💀 Muerto intentando huir del ${monster.name}.`);
    line += `\n💀 ¡Moriste! Respawneás en la entrada del dungeon...`;
  }

  return { fled: false, destRoomId: null, line };
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
  const normalize = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const name = normalize(targetName.trim());
  return monsters.find(m => normalize(m.name).includes(name)) || null;
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
  const bossDef = BOSS_MONSTERS[monster.id];

  // Loot especial del boss
  const allLoot = bossDef ? [...loot, ...(bossDef.lootBonus || [])] : loot;

  if (allLoot.length > 0) {
    // Agregar ítems a la habitación
    const room = db.getRoom(roomId);
    if (room) {
      const newItems = [...room.items, ...allLoot];
      db.updateRoomItems(roomId, newItems);
    }
  }

  // Tiempo de respawn: boss = 30 min, normal = 5 min
  const respawnMinutes = bossDef ? bossDef.respawnMinutes : 5;
  const respawnAt = new Date(Date.now() + respawnMinutes * 60 * 1000).toISOString();
  db.updateMonster(monster.id, {
    hp: 0,
    room_id: null,        // ya no está en ninguna sala
    respawn_at: respawnAt,
  });

  const globalEvent = bossDef ? bossDef.deathAnnouncement : null;

  return { droppedLoot: allLoot, globalEvent };
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
      status_effects: '{}', // T110: limpiar efectos de veneno al respawnear
    });
    console.log(`[combat] Respawn: ${m.name} en sala ${m.respawn_room_id}`);
  }
}

module.exports = {
  attackRound,
  tryFlee,
  findMonsterInRoom,
  checkRespawns,
  BOSS_MONSTERS,
  MONSTER_SPECIALS,
};
