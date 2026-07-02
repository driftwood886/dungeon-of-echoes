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
const weather     = require('./weather');
const classes = require('./classes'); // T107: bonus de clase
const items = require('./items');    // T110: efectos on_hit de armas crafteadas
const xpSystem = require('./xp');   // DIS-D282: curva de XP cuadrática

// ─── Constantes ───────────────────────────────────────────────────────────────

const FLEE_CHANCE = 0.5; // 50% de probabilidad de huir con éxito

/**
 * T175: handlePlayerDeath — Centraliza la lógica de muerte del jugador.
 * Si el jugador está en modo hardcore, lo marca como fallen en lugar de respawnear normalmente.
 * @returns {{ globalEvent?: string }} — objeto con globalEvent si fue muerte hardcore
 */
function handlePlayerDeath(playerId, lines, causeDescription) {
  const freshP = db.getPlayer(playerId);
  if (!freshP) return {};
  const deaths = (freshP.deaths || 0) + 1;

  // DIS-914: Sanador — resurrección automática con 20% chance al morir en PvE (nivel 5+)
  if (!freshP.is_hardcore && freshP.specialization === 'sanador') {
    const prevSeSanador = freshP.status_effects ? (typeof freshP.status_effects === 'string' ? JSON.parse(freshP.status_effects) : freshP.status_effects) : {};
    if (!prevSeSanador.sanador_milagro_used && Math.random() < 0.20) {
      prevSeSanador.sanador_milagro_used = true;
      db.updatePlayer(playerId, { hp: 5, status_effects: JSON.stringify(prevSeSanador) });
      lines.push(`💚 ¡MILAGRO DEL SANADOR! Un destello de luz divina te arranca de la muerte.`);
      lines.push(`   Resuicás con 5 HP. (Solo ocurre una vez por sesión.)`);
      db.addJournalEntry(playerId, 'special', `💚 El milagro del Sanador te salvó de la muerte en ${causeDescription}.`);
      return { autoResurrected: true };
    }
  }

  // DIS-726: Autoresurrección del Clérigo nivel 10 (singleplayer fallback)
  // Si el Clérigo tiene resurreccion desbloqueada y no la usó esta sesión, se salva de la muerte
  if (!freshP.is_hardcore && freshP.player_class === 'clerigo' && (freshP.level || 1) >= 10) {
    const prevSeAuto = freshP.status_effects ? (typeof freshP.status_effects === 'string' ? JSON.parse(freshP.status_effects) : freshP.status_effects) : {};
    if (!prevSeAuto.resurreccion_used && !prevSeAuto.autoresurreccion_used) {
      // Activar autoresurrección — revivir con 50% HP, marcar como usada
      const reviveHp = Math.max(10, Math.floor((freshP.max_hp || 32) * 0.5));
      prevSeAuto.autoresurreccion_used = true;
      db.updatePlayer(playerId, {
        hp: reviveHp,
        status_effects: JSON.stringify(prevSeAuto),
      });
      lines.push(`✨ ¡AUTORESURRECCIÓN! En el momento más oscuro, tu fe te sostiene.`);
      lines.push(`  Canalizás todo tu poder divino para resistir la muerte.`);
      lines.push(`  Resuicás con ${reviveHp}/${freshP.max_hp} HP. (Solo ocurre una vez por sesión.)`);
      db.addJournalEntry(playerId, 'special', `✨ La fe del Clérigo venció a la muerte en ${causeDescription}. Autoresurrección activada.`);
      return { autoResurrected: true };
    }
  }

  if (freshP.is_hardcore === 1 && freshP.fallen !== 1) {
    // MUERTE HARDCORE — marcar como fallen
    const gen = freshP.hardcore_generation || 1;
    // DIS-D324: preservar trap_cd_* incluso en muerte hardcore
    // DIS-913: preservar carta_sellada_leida — lore leído no se olvida al morir
    const prevSeHc = freshP.status_effects ? (typeof freshP.status_effects === 'string' ? JSON.parse(freshP.status_effects) : freshP.status_effects) : {};
    const PRESERVE_KEYS_HC = (k) => k.startsWith('trap_cd_') || k === 'carta_sellada_leida';
    const trapMemoriesHc = Object.fromEntries(Object.entries(prevSeHc).filter(([k]) => PRESERVE_KEYS_HC(k)));
    const newSeHc = Object.keys(trapMemoriesHc).length > 0 ? JSON.stringify(trapMemoriesHc) : '{}';
    db.updatePlayer(playerId, {
      hp: 1, // HP fantasma
      fallen: 1,
      fallen_at: new Date().toISOString(),
      deaths,
      status_effects: newSeHc,
    });
    const genRoman = toRomanLocal(gen);
    const broadcastMsg = `☠ ✝ EL AVENTURERO CAÍDO ✝ ☠\n  ${freshP.username} ${genRoman} ha caído para siempre en modo HARDCORE.\n  Descansa en paz, valiente. El dungeon recuerda tu sacrificio.`;
    lines.push(`💀 MUERTE HARDCORE — Tu personaje ${freshP.username} ${genRoman} ha CAÍDO.`);
    lines.push(`  Quedás como ✝ fantasma. Solo podés usar comandos pasivos.`);
    lines.push(`  Escribí "hardcore" para ver tu estado.`);
    // T179: Grabar placa en la Cripta de los Valientes (sala 22)
    try {
      const dt = new Date().toISOString().replace('T', ' ').slice(0, 16);
      const plaque = `✝ ${freshP.username} ${genRoman} — Niv. ${freshP.level} — ${freshP.kills} kills — ${dt}`;
      db.addWallMessage(22, plaque, 'El Dungeon');
    } catch (_) { /* si la sala 22 no existe aún, no falla el servidor */ }
    return { globalEvent: broadcastMsg };
  } else {
    // Muerte normal — DIS-D41: respawn con 25% del max_hp (mín 5)
    const respawnHp = Math.max(5, Math.floor((freshP.max_hp || 20) * 0.25));
    // DIS-D324: preservar trap_cd_* al morir — el jugador recuerda trampas entre muertes
    // DIS-913: preservar carta_sellada_leida — lore leído no se olvida al morir
    const prevSe = freshP.status_effects ? (typeof freshP.status_effects === 'string' ? JSON.parse(freshP.status_effects) : freshP.status_effects) : {};
    const PRESERVE_KEYS = (k) => k.startsWith('trap_cd_') || k === 'carta_sellada_leida';
    const trapMemories = Object.fromEntries(Object.entries(prevSe).filter(([k]) => PRESERVE_KEYS(k)));
    const newSe = Object.keys(trapMemories).length > 0 ? JSON.stringify(trapMemories) : '{}';
    db.updatePlayer(playerId, { hp: respawnHp, current_room_id: 1, deaths, status_effects: newSe });
    // BUG-697: Si el jugador murió con un boss vivo pero dañado en su sala,
    // restaurar el HP del boss a su máximo. El boss "regenera" mientras el
    // jugador estaba fuera — evita que reaparezca con 4/100 HP en la próxima visita.
    try {
      const bossInRoom = db.getMonstersInRoom(freshP.current_room_id)
        .find(m => BOSS_MONSTERS[m.id] && m.room_id !== null && (m.hp || 0) < m.max_hp);
      if (bossInRoom) {
        db.updateMonster(bossInRoom.id, {
          hp: bossInRoom.max_hp,
          // DIS-D423: limpiar status_effects del boss (phase2_triggered, etc.)
          status_effects: '{}',
          // Restaurar DEF base si el boss tenía bonus de fase 2
          ...(BOSS_BASE_DEFENSE[bossInRoom.id] !== undefined ? { defense: BOSS_BASE_DEFENSE[bossInRoom.id] } : {}),
        });
        console.log(`[combat] BUG-697: Boss ${bossInRoom.name} (id ${bossInRoom.id}) restaurado a HP máximo (${bossInRoom.max_hp}) tras muerte del jugador.`);
      }
    } catch (e) {
      console.warn('[combat] BUG-697: Error restaurando HP de boss tras muerte del jugador:', e.message);
    }
    // STORY-019: entrada de diario con color emocional para primera muerte
    if (deaths === 1) {
      db.addJournalEntry(playerId, 'death', `💀 Moriste. No fue heroico. Fue un pasillo oscuro y algo que no viste.`);
    } else {
      db.addJournalEntry(playerId, 'death', `💀 Caíste de nuevo. ${deaths} veces y el dungeon sigue en pie.`);
    }
    return {};
  }
}

function toRomanLocal(n) {
  const vals = [1000,900,500,400,100,90,50,40,10,9,5,4,1];
  const syms = ['M','CM','D','CD','C','XC','L','XL','X','IX','V','IV','I'];
  let result = '';
  for (let i = 0; i < vals.length; i++) {
    while (n >= vals[i]) { result += syms[i]; n -= vals[i]; }
  }
  return result;
}

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
    lootBonus: ['cofre de oro'], // 1x = 50g (antes: 5x monedas de oro — BUG-283)
    // DIS-D423: Fase 2 al 50% HP — el Lich se potencia con magia oscura
    phase2: {
      atkBonus: 5,
      defBonus: 3,
      message: '💜 ¡El LICH ANCIANO invoca su filacteria! Un aura oscura lo envuelve — su poder aumenta drásticamente. (FASE 2)',
    },
  },
  22: { // Sombra del Vacío — BUG-404: faltaba aquí, por eso podía huir (DIS-D364 no lo cubría)
    respawnMinutes: 30,
    deathAnnouncement: '💀 ¡La SOMBRA DEL VACÍO ha sido disipada! La oscuridad del Abismo Eterno retrocede por un momento...',
    lootBonus: [],
    // DIS-D423: Fase 2 al 50% HP — la Sombra se divide temporalmente
    // DIS-1070: mensaje más claro sobre la escalada de daño para dar agencia al jugador
    phase2: {
      atkBonus: 4,
      defBonus: 2,
      message: '🌑 ¡La SOMBRA DEL VACÍO se fragmenta y se reagrupa!\nSus bordes oscilan más rápido, volviéndose más densa y letal — sus ataques aumentan en intensidad. (FASE 2)\n⚠️ Sus golpes ahora infligen más daño. Curá antes de que sea tarde.',
    },
  },
  21: { // Eco Viviente — BUG-404: faltaba aquí, por eso podía huir (DIS-D364 no lo cubría)
    respawnMinutes: 20,
    deathAnnouncement: '💀 ¡El ECO VIVIENTE ha sido silenciado! La Cámara del Eco queda en silencio absoluto por primera vez en años...',
    lootBonus: [],
  },
  10: { // Golem de Forja — BUG-409: faltaba aquí, podía huir con < 30% HP
    respawnMinutes: 15,
    deathAnnouncement: '💀 ¡El GOLEM DE FORJA ha sido destruido! La forja del Taller se apaga por primera vez en siglos. El calor retrocede...',
    lootBonus: [],
  },
  12: { // Campeón Espectral — BUG-409: faltaba aquí, podía huir con < 30% HP
    respawnMinutes: 15,
    deathAnnouncement: '💀 ¡El CAMPEÓN ESPECTRAL ha caído! El Coliseo de Huesos guarda silencio por un momento. Luego el público esquelético reanuda sus murmullos...',
    lootBonus: [],
  },
  20: { // Goblin de Práctica — BUG-430: mob tutorial no debe poder huir (rompe el flujo del tutorial)
    respawnMinutes: 5,
    deathAnnouncement: null, // sin anuncio global — es un mob tutorial
    lootBonus: [],
  },
  8: { // Guardia Espectral — BUG-443: miniboss de la Prisión Subterránea, faltaba aquí, podía huir con <25% HP
    respawnMinutes: 10,
    deathAnnouncement: null, // sin anuncio global — es un miniboss local
    lootBonus: [],
  },
  5: { // Gólem de Piedra — BUG-444: el lore dice "nunca huye", faltaba en BOSS_MONSTERS → podía escapar con <25% HP
    respawnMinutes: 15,
    deathAnnouncement: null, // sin anuncio global — boss del Santuario Profano pero no merece anuncio global
    lootBonus: [],
  },
};

// T145: Habilidades especiales de monstruos
// tipo: 'mana_drain' | 'web' | 'amplify' | 'blind'

// T221: Stats base de monstruos para restaurar después de ser élite
// (id → { name, max_hp, attack })
const MONSTER_BASE_STATS = {
  1:  { name: 'Goblin Merodeador',     max_hp: 15, attack: 3  },
  2:  { name: 'Esqueleto Guerrero',    max_hp: 20, attack: 5  },
  3:  { name: 'Rata Gigante',          max_hp: 10, attack: 2  },
  4:  { name: 'Espectro del Corredor', max_hp: 18, attack: 6  },
  5:  { name: 'Gólem de Piedra',       max_hp: 70, attack: 8  },  // DIS-630: HP 35→55. DIS-1105: HP 55→70
  6:  { name: 'Murciélago Vampiro',    max_hp: 12, attack: 3  },
  7:  { name: 'Araña Tejedora',        max_hp: 8,  attack: 4  },
  8:  { name: 'Guardia Espectral',     max_hp: 55, attack: 7  },  // DIS-679: HP 40→55
  // DIS-D46: Monstruos expandidos — stats balanceados para curva de dificultad progresiva
  9:  { name: 'Elemental de Hielo',    max_hp: 40, attack: 9  },
  10: { name: 'Golem de Forja',        max_hp: 55, attack: 10 }, // DIS-688: HP 42→55 + resistencia fuego ×0.80
  11: { name: 'Krakeling Abismal',     max_hp: 25, attack: 7  },
  12: { name: 'Campeón Espectral',     max_hp: 70, attack: 14 }, // DIS-D423: rebalanceado
  21: { name: 'Eco Viviente',          max_hp: 55, attack: 10 }, // DIS-D423: rebalanceado
  22: { name: 'Sombra del Vacío',      max_hp: 120, attack: 14 }, // DIS-729: HP 90→120, boss secreto más desafiante
  // BUG-697: Murciélagos extra de DIS-510 — sin entrada = élite acumula HP en cada ciclo
  26: { name: 'Murciélago Vampiro',    max_hp: 12, attack: 3  }, // sala 3 (Sala de los Ecos)
  27: { name: 'Murciélago Vampiro',    max_hp: 12, attack: 3  }, // sala 6 (Túnel de Hongos)
};

// BUG-1016: Mapa de géneros femeninos para artículos correctos.
// Por defecto todos los monstruos usan "El"; los listados aquí usan "La".
const MONSTER_GENERO_FEMENINO = new Set([
  'Araña Tejedora',
  'Rata Gigante',
  'Sombra del Vacío',
  'Guardia Espectral', // "La Guardia" es femenino
]);

/**
 * BUG-1016: Devuelve el artículo correcto (El/La) para un monstruo.
 * Maneja el prefijo ⭐ de monstruos élite (ej: "⭐ Araña Tejedora").
 * @param {string} name — nombre del monstruo (puede tener prefijo ⭐)
 * @returns {string} — "El" o "La"
 */
function articuloMonstruo(name) {
  const baseName = name.startsWith('⭐') ? name.slice(2).trim() : name;
  return MONSTER_GENERO_FEMENINO.has(baseName) ? 'La' : 'El';
}

/**
 * BUG-1016: Devuelve "derrotada" o "derrotado" según el género del monstruo.
 */
function derrotadoMonstruo(name) {
  const baseName = name.startsWith('⭐') ? name.slice(2).trim() : name;
  return MONSTER_GENERO_FEMENINO.has(baseName) ? 'derrotada' : 'derrotado';
}

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
  // DIS-679: El Guardia Espectral aplica "entumecimiento espectral" — reduce ATK del jugador
  // Fuerza al Guerrero a aguantar más turnos (era 2 turnos con smash+attack)
  'Guardia Espectral': {
    chance: 0.40,
    type: 'atk_debuff',
    amount: 3,
    turns: 2,
    msg: '👻 ¡El Guardia Espectral te infunde entumecimiento espectral! (-{amount} ATK por {turns} turnos)',
  },
  // DIS-988: habilidades especiales para ÉLITE de sala 3
  '⭐ Goblin Merodeador': {
    chance: 0.20,
    type: 'item_steal',
    msg: '🖐 ¡El ⭐ Goblin Merodeador te roba un ítem con sus dedos ágiles!',
  },
  '⭐ Esqueleto Guerrero': {
    chance: 0.30,
    type: 'armor_pierce',
    amount: 2,
    msg: '💀 ¡El ⭐ Esqueleto Guerrero ejecuta un golpe perforante que ignora {amount} DEF!',
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
  let globalEventHardcore = null; // T175: para muerte hardcore en combate principal

  // DIS-616: limpiar flag "attacked_player_this_turn" del monstruo al inicio del turno
  try {
    const monsterSeClean = monster.status_effects ? (typeof monster.status_effects === 'string' ? JSON.parse(monster.status_effects) : monster.status_effects) : {};
    if (monsterSeClean.attacked_player_this_turn) {
      delete monsterSeClean.attacked_player_this_turn;
      db.updateMonster(monster.id, { status_effects: JSON.stringify(monsterSeClean) });
      monster.status_effects = monsterSeClean; // actualizar referencia local
    }
  } catch (_) {}

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
      lines.push(`💀 ¡El veneno acabó contigo! Respawneás en la entrada del dungeon con 25% HP...`);
      db.addJournalEntry(player.id, 'death', `💀 Muerto por veneno luchando contra ${monster.name}.`);
      const hcResult = handlePlayerDeath(player.id, lines, 'veneno');
      return { lines, monsterDead, playerDead, loot, poisonSurvived, ...(hcResult.globalEvent ? { globalEvent: hcResult.globalEvent } : {}) };
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
    // DIS-852: bloodmoon rediseñado — +30% ATK proporcional para monstruos nivel 3+ (no flat +2)
    const bloodmoonAffectsW = (activeEvW && activeEvW.id === 'bloodmoon' && activeEvW.affectedIds && activeEvW.affectedIds.has(monster.id));
    const bloodmoonBonusW = bloodmoonAffectsW ? Math.floor(monster.attack * (activeEvW.atkBonus || 0.30)) : 0;
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
      lines.push(`🩸 ${articuloMonstruo(monster.name)} ${monster.name} aprovecha que estás enredado y te golpea por ${dmgToPlayerW} de daño. (${player.hp}/${player.max_hp} HP)`);
    }
    db.updatePlayer(player.id, { hp: player.hp });
    if (player.hp <= 0) {
      playerDead = true;
      lines.push(`💀 ¡Moriste! Respawneás en la entrada del dungeon con 25% HP...`);
      db.addJournalEntry(player.id, 'death', `💀 Caíste en combate contra ${monster.name} (atrapado en telarañas).`);
      const hcResultW = handlePlayerDeath(player.id, lines, 'telarañas');
      return { lines, monsterDead, playerDead, loot, poisonSurvived, ...(hcResultW.globalEvent ? { globalEvent: hcResultW.globalEvent } : {}) };
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
  // T161: modificadores de postura de combate
  const STANCE_DATA = {
    agresivo:    { atkMod: +2, defMod: -1, extraMiss: 0.05 },
    defensivo:   { atkMod: -1, defMod: +2, extraMiss: 0 },
    equilibrado: { atkMod:  0, defMod:  0, extraMiss: 0 },
  };
  const stanceName = player.stance || 'equilibrado';
  const stanceMods = STANCE_DATA[stanceName] || STANCE_DATA.equilibrado;

  // DIS-679: entumecimiento espectral reduce ATK del jugador por N turnos
  const freshForAtkDebuff = db.getPlayer(player.id);
  const atkDebuffFx = freshForAtkDebuff.status_effects
    ? (typeof freshForAtkDebuff.status_effects === 'string' ? JSON.parse(freshForAtkDebuff.status_effects) : freshForAtkDebuff.status_effects)
    : {};
  const atkDebuffAmt = atkDebuffFx.atk_debuffed ? (atkDebuffFx.atk_debuffed.amount || 0) : 0;
  const effectiveAtk = Math.max(1, player.attack + petBonus + scrollAtkBonus + stanceMods.atkMod - atkDebuffAmt);
  const effectiveDef = (player.defense || 0) + scrollDefBonus + stanceMods.defMod;

  // DIS-1028: Escalado dinámico de dificultad para jugadores nivel 15+
  // Los monstruos no-boss ganan defensa virtual y ATK extra para mantener la tensión.
  // El escalado es suave y empieza en nivel 10 para no romper la curva de progresión.
  // Fórmula: por cada nivel sobre 10, el monstruo gana +8% de defensa virtual y +0.5 ATK extra.
  // A nivel 20 → monster.defense += 8, monster.attack += 5 (diferencia notable pero no absurda).
  let monsterVirtualDefBonus = 0;
  let monsterAtkScaleBonus = 0;
  const isBossMonster = !!(BOSS_MONSTERS && BOSS_MONSTERS[monster.id]);
  if (!isBossMonster && (player.level || 1) >= 10) {
    const levelsAbove10 = (player.level || 1) - 10;
    const monBaseHp = monster.max_hp || 10;
    monsterVirtualDefBonus = Math.floor(monBaseHp * levelsAbove10 * 0.015); // defensa extra (absorbe daño del jugador)
    monsterAtkScaleBonus = Math.floor(levelsAbove10 * 0.5); // ATK extra del monstruo
    // Aplicar localmente (no persiste en DB — solo válido para esta ronda)
    monster = { ...monster, attack: (monster.attack || 3) + monsterAtkScaleBonus };
  }

  // Miss extra por postura agresiva
  if (stanceMods.extraMiss > 0 && Math.random() < stanceMods.extraMiss) {
    lines.push(`⚔️ [Postura ofensiva] El ataque salvaje falla el blanco!`);
    // turno del monstruo igualmente
    const rawMissReturn = Math.max(1, calcDamage(monster.attack) - Math.floor(effectiveDef));
    player.hp = Math.max(0, player.hp - rawMissReturn);
    db.updatePlayer(player.id, { hp: player.hp });
    if (player.hp <= 0) {
      lines.push(`💀 ¡Moriste! Respawneás en la entrada del dungeon con 25% HP...`);
      db.addJournalEntry(player.id, 'death', `💀 Caíste en combate contra ${monster.name} (golpe tras postura ofensiva fallida).`);
      const hcResultM = handlePlayerDeath(player.id, lines, 'postura ofensiva');
      return { lines, monsterDead: false, playerDead: true, loot: [], poisonSurvived: false, ...(hcResultM.globalEvent ? { globalEvent: hcResultM.globalEvent } : {}) };
    }
    lines.push(`⚡ ${articuloMonstruo(monster.name)} ${monster.name} contraataca: ${rawMissReturn} de daño. (Tus HP: ${player.hp}/${player.max_hp})`);
    return { lines, monsterDead: false, playerDead: false, loot: [], poisonSurvived: false };
  }

  // DIS-729/DIS-807: Oscuridad Paralizante — la Sombra del Vacío anula el turno del jugador
  // DIS-807: El primer turno es GARANTIZADO (no random) para que sea imposible trivializar en 2-3 turnos
  // Los siguientes turnos tienen 35% de chance (aumentado de 25%)
  if (monster.name && monster.name.includes('Sombra del Vacío') && !monsterDead) {
    const freshForParalyze = db.getPlayer(player.id);
    const seParalyze = freshForParalyze.status_effects ? (typeof freshForParalyze.status_effects === 'string' ? JSON.parse(freshForParalyze.status_effects) : freshForParalyze.status_effects) : {};
    // DIS-807: Primer turno GARANTIZADO (shadow_attacked no seteado = primer ataque del jugador)
    // Turnos siguientes: 35% de chance (era 25%)
    const shadowHasActed = seParalyze.shadow_attacked || false;
    if (!shadowHasActed || Math.random() < 0.35) {
      lines.push(`🌑 ¡La OSCURIDAD PARALIZANTE te envuelve! No podés atacar este turno.`);
      // BUG-1013: setear shadow_attacked AQUÍ para que el flag quede guardado incluso cuando
      // la función retorna temprano (antes de llegar al bloque de línea ~1211).
      // Sin este fix, el flag nunca se seteaba y la paralización ocurría el 100% de los turnos.
      if (!shadowHasActed) {
        seParalyze.shadow_attacked = true;
        db.updatePlayer(player.id, { status_effects: JSON.stringify(seParalyze) });
      }
      // El monstruo sí contraataca
      const shadowDmg = calcDamage(monster.attack);
      const evParalyze = worldEvents.getCurrentEvent();
      // DIS-852: bloodmoon rediseñado — +30% ATK proporcional para monstruos nivel 3+
      const bmAffectsP = (evParalyze && evParalyze.id === 'bloodmoon' && evParalyze.affectedIds && evParalyze.affectedIds.has(monster.id));
      const bmBonusP = bmAffectsP ? Math.floor(monster.attack * (evParalyze.atkBonus || 0.30)) : 0;
      const freshBlindParalyze = freshForParalyze;
      const blindFxP = freshBlindParalyze.status_effects ? (typeof freshBlindParalyze.status_effects === 'string' ? JSON.parse(freshBlindParalyze.status_effects) : freshBlindParalyze.status_effects) : {};
      const blindDefP = blindFxP.blinded ? (blindFxP.blinded.amount || 0) : 0;
      const netDmgShadow = Math.max(1, shadowDmg + bmBonusP - Math.floor((freshForParalyze.defense || 0) - blindDefP));
      player.hp = Math.max(0, freshForParalyze.hp - netDmgShadow);
      db.updatePlayer(player.id, { hp: player.hp });
      lines.push(`   🌑 La Sombra del Vacío aprovecha para atacar: ${netDmgShadow} de daño. (${player.hp}/${player.max_hp} HP)`);
      if (player.hp <= 0) {
        const paralDeathResult = handlePlayerDeath(player.id, lines, 'Sombra del Vacío');
        if (!paralDeathResult.autoResurrected) {
          return { lines, monsterDead: false, playerDead: true, loot: [], poisonSurvived: false };
        }
      }
      // BUG-1026: retornar paralyzed:true para que engine.js NO avance el combo
      return { lines, monsterDead: false, playerDead: false, loot: [], poisonSurvived: false, paralyzed: true };
    }
  }

  const playerDmg = calcDamage(effectiveAtk);
  // T107: bonus crítico de clase (Pícaro tiene +15% sobre base del 10%)
  const clsData = classes.getPlayerClass(player);
  // T190: bonus crit de encantamiento de runa sombra
  const enchantData = scrolls['weapon_enchant'];
  const enchantActive = enchantData && enchantData.expires_at > Date.now();
  const enchantCritBonus = (enchantActive && enchantData.type === 'sombra') ? (enchantData.crit_bonus || 0) : 0;
  // DIS-615: bonus crit de guantes de cuero fino (Pícaro)
  const equippedWeaponDef = player.equipped_weapon ? items.getItemDef(player.equipped_weapon) : null;
  const rogueCritBonusGloves = (equippedWeaponDef && equippedWeaponDef.rogue_only_crit_bonus && clsData && clsData.name === 'Pícaro')
    ? equippedWeaponDef.rogue_only_crit_bonus / 100 : 0;
  // DIS-619: en postura agresiva, el Pícaro pierde 2% de crit (golpes más salvajes, menos precisos para puntos vitales)
  // DIS-715: reducido de -5% a -2% para que el tradeoff sea menos drástico y más fácil de entender
  // Equilibrado: 25% crit | Agresivo: 23% crit (+2 ATK compensa) | Defensivo: 25% crit
  const stanceCritPenalty = (stanceName === 'agresivo' && clsData && clsData.name === 'Pícaro') ? -0.02 : 0;

  // DIS-620: Sigilo — crítico garantizado en el golpe de sorpresa
  const freshForStealth = db.getPlayer(player.id);
  const seStealth = freshForStealth.status_effects ? (typeof freshForStealth.status_effects === 'string' ? JSON.parse(freshForStealth.status_effects) : freshForStealth.status_effects) : {};
  const stealthReady = seStealth.stealth_active && new Date(seStealth.stealth_active).getTime() > Date.now();
  let stealthSurprise = false;
  if (stealthReady && clsData && clsData.name === 'Pícaro') {
    stealthSurprise = true;
    // Limpiar sigilo al atacar — BUG-773: limpiar tanto en seStealth (fresh read) como en player.status_effects
    // (en memoria), para evitar que la escritura final del combate sobreescriba el delete (mismo patrón BUG-671)
    delete seStealth.stealth_active;
    // BUG-774: agregar cooldown de 75 segundos tras consumir el sigilo — previene activación inmediata post-combate
    // DIS-947: Ladrón de Sombras tiene cooldown reducido a 45s
    const stealthCdMs = player.specialization === 'ladron' ? 45000 : 75000;
    seStealth.stealth_cooldown = new Date(Date.now() + stealthCdMs).toISOString();
    db.updatePlayer(player.id, { status_effects: JSON.stringify(seStealth) });
    // También limpiar en memoria para no sobreescribir en la escritura final (línea ~1178)
    if (player.status_effects && typeof player.status_effects === 'object') {
      delete player.status_effects.stealth_active;
      player.status_effects.stealth_cooldown = seStealth.stealth_cooldown;
    }
    lines.push(`🥷 [GOLPE DE SORPRESA] Salís de las sombras con un ataque letal...`);
  }

  const critChance = 0.10 + (clsData ? (clsData.crit_bonus || 0) / 100 : 0) + enchantCritBonus + rogueCritBonusGloves + stanceCritPenalty
    // DIS-914: bonus crit del Asesino (+10%)
    + (player.specialization === 'asesino' ? 0.10 : 0);
  // DIS-914: Asesino — primer ataque en sala nueva es siempre crítico (ambush)
  const seForAmbush = typeof player.status_effects === 'object' ? player.status_effects : {};
  const ambushReady = player.specialization === 'asesino' && seForAmbush.asesino_ambush_room !== player.current_room_id;
  const isCrit = stealthSurprise || ambushReady ? true : Math.random() < critChance;
  // Marcar sala de ambush para no repetir en esta sala
  if (ambushReady && !stealthSurprise) {
    const seForAmbushWrite = typeof player.status_effects === 'object' ? { ...player.status_effects } : {};
    seForAmbushWrite.asesino_ambush_room = player.current_room_id;
    db.updatePlayer(player.id, { status_effects: JSON.stringify(seForAmbushWrite) });
    if (typeof player.status_effects === 'object') player.status_effects.asesino_ambush_room = player.current_room_id;
    lines.push(`🗡️ [EMBOSCADA] Tu primer golpe en esta sala es siempre un crítico.`);
  }
  // DIS-683: Los bosses son resistentes a emboscadas del Pícaro — multiplicador 1.5x en vez de 2x
  // Los monstruos normales siguen recibiendo el 2x completo (fantasía de clase intacta)
  // DIS-758: Elemental de Hielo y Krakeling Abismal (mobs de mid-game de zona deep) también tienen
  // resistencia a emboscada ×1.7 (no tan alta como bosses, pero aguantan más que monstruos normales)
  const isBossForStealth = !!(BOSS_MONSTERS && BOSS_MONSTERS[monster.id]);
  const isMidBossForStealth = monster.id === 9 || monster.id === 11; // Elemental de Hielo, Krakeling
  let critMultiplier = 2;
  if (stealthSurprise && isBossForStealth) {
    critMultiplier = 1.5;
    lines.push(`🛡️ El boss percibe el sigilo — el multiplicador de emboscada se reduce a ×1.5.`);
  } else if (stealthSurprise && isMidBossForStealth) {
    critMultiplier = 1.7;
    lines.push(`🛡️ ${articuloMonstruo(monster.name)} ${monster.name} intuye tu presencia — el multiplicador de emboscada se reduce a ×1.7.`);
  }
  const rawPlayerDmg = isCrit ? playerDmg * critMultiplier : playerDmg;

  // DIS-986: Furia del Berserker — multiplicar daño si berserker_rage activo
  let rageMultiplier = 1.0;
  let rageLabel = '';
  if (scrolls['berserker_rage'] && scrolls['berserker_rage'].expires_at > Date.now()) {
    rageMultiplier = scrolls['berserker_rage'].dmg_multiplier || 1.5;
    rageLabel = ` 🪓 [FURIA ×${rageMultiplier}]`;
    // Consumir el buff (one-shot)
    delete scrolls['berserker_rage'];
    db.updatePlayer(player.id, { active_scrolls: JSON.stringify(scrolls) });
  }
  // DIS-630: El Gólem de Piedra tiene resistencia física ×0.75 — análoga a resistencia mágica del Guardia Espectral
  // Es un constructo pétrico: los golpes físicos se amortiguan en su cuerpo de piedra
  // DIS-688: El Golem de Forja tiene resistencia de fuego ×0.80 — constructo de metal candente
  // DIS-1015: El Elemental de Hielo tiene resistencia física ×0.80 — criatura inmaterial
  const PHYS_RESISTANT_MONSTERS = ['gólem de piedra', 'elemental de hielo'];
  const FIRE_RESISTANT_MONSTERS  = ['golem de forja'];
  const monNameLow = monster.name.toLowerCase().replace('⭐ ', '');
  const physResist = monNameLow.includes('gólem de piedra') ? 0.75
    : monNameLow.includes('elemental de hielo') ? 0.80
    : FIRE_RESISTANT_MONSTERS.some(n => monNameLow.includes(n)) ? 0.80
    : 1.0;
  const physResistLabel = monNameLow.includes('gólem de piedra') ? '🪨 (resistencia física: ×0.75)'
    : monNameLow.includes('elemental de hielo') ? '🧊 (resistencia física: ×0.80)'
    : FIRE_RESISTANT_MONSTERS.some(n => monNameLow.includes(n)) ? '🔥 (resistencia de fuego: ×0.80)'
    : '';
  // DIS-936: La lanza espectral y sus variantes tienen bono real contra espectrales y criaturas mágicas
  // spectral_bonus en items.js define el ATK extra (+2 para base/reforzada, +3 para del eco)
  const SPECTRAL_MONSTER_NAMES = ['espectro', 'guardia espectral', 'campeón espectral', 'lich', 'eco viviente', 'sombra del vacío', 'fantasma', 'elemental'];
  const isSpectralMonster = SPECTRAL_MONSTER_NAMES.some(n => monNameLow.includes(n));
  const spectralBonusDmg = (equippedWeaponDef && equippedWeaponDef.spectral_bonus && isSpectralMonster)
    ? equippedWeaponDef.spectral_bonus : 0;

  // DIS-657: La Sombra del Vacío tiene resistencia a emboscada — reduce el daño de golpe de sorpresa al 70%
  // Narrativa: la criatura de oscuridad "espera" el ataque del Pícaro — no puede ser sorprendida en su propio dominio
  let ambushResist = 1.0;
  if (stealthSurprise && monNameLow.includes('sombra del vacío')) {
    ambushResist = 0.70;
    lines.push(`🌑 La Sombra del Vacío percibe tu presencia en la oscuridad — tu golpe de sorpresa se atenúa. (emboscada: ×0.70)`);
  }
  // DIS-722: Clérigo con arma no-sagrada (sin cleric_only_bonus) recibe -10% de daño físico
  // Narrativa: el Clérigo canaliza su poder a través de la fe, no de la fuerza bruta
  // Usar el símbolo sagrado (+cleric_only_bonus) evita la penalidad y refleja la fantasía de clase
  // DIS-899: el hint completo solo se muestra una vez por sesión (flag shown_nonsacred_hint)
  // DIS-914: Sanador (especialización) anula la penalidad de arma no-sagrada permanentemente
  let clericWeaponPenalty = 1.0;
  const clericWeaponPenaltyNote = [];
  if (clsData && clsData.name === 'Clérigo') {
    const equippedWpnDef = player.equipped_weapon ? items.getItemDef(player.equipped_weapon) : null;
    const hasSacredBonus = equippedWpnDef && equippedWpnDef.cleric_only_bonus;
    const isSanadorSpec = player.specialization === 'sanador'; // DIS-914: Sanador no tiene penalidad
    if (!hasSacredBonus && !isSanadorSpec) {
      clericWeaponPenalty = 0.90;
      // DIS-899: leer flag para decidir si mostrar hint completo o solo el multiplicador
      const seForNonsacred = player.status_effects
        ? (typeof player.status_effects === 'string' ? JSON.parse(player.status_effects) : player.status_effects)
        : {};
      if (!seForNonsacred.shown_nonsacred_hint) {
        // Primera vez en esta sesión: hint completo con sugerencia de compra
        clericWeaponPenaltyNote.push(`⚕️ (×0.9 — arma no-sagrada: el Clérigo prefiere el símbolo sagrado. Aldric lo vende a 20g)`);
        const newSeNonsacred = { ...seForNonsacred, shown_nonsacred_hint: true };
        db.updatePlayer(player.id, { status_effects: JSON.stringify(newSeNonsacred) });
        player.status_effects = newSeNonsacred;
      } else {
        // Ya se mostró antes: solo el multiplicador, sin ruido
        clericWeaponPenaltyNote.push(`⚕️ (×0.9)`);
      }
    }
  }
  // DIS-835: Bosses resistentes a críticos — reducen daño de crits para que el build crit del Pícaro
  // no sea solución trivial contra todos los jefes. El Campeón y el Lich tienen armadura espectral endurecida.
  const CRIT_RESISTANT_BOSSES = {
    12: { mult: 0.80, label: '🦴 (escudo espectral: crits ×0.80)' }, // Campeón Espectral
    13: { mult: 0.75, label: '💀 (resistencia de lich: crits ×0.75)' }, // Lich Anciano
  };
  const critResistDef = CRIT_RESISTANT_BOSSES[monster.id];

  const dmgAfterPhysResist = Math.round(rawPlayerDmg * rageMultiplier * physResist * ambushResist * clericWeaponPenalty);
  // DIS-835: Si es crit y el boss tiene resistencia a crits, aplicar el multiplicador
  const critResistMult = (isCrit && critResistDef) ? critResistDef.mult : 1.0;
  // DIS-936: bono espectral se agrega DESPUÉS de resistencias (daño plano, no multiplicativo)
  // DIS-1028: monsterVirtualDefBonus reduce el daño efectivo para jugadores nivel 10+ vs no-boss
  // DIS-1116: Debilidad Espectral reduce la defensa efectiva del monstruo
  const monsterWeakenedFx = monster.status_effects ? (typeof monster.status_effects === 'string' ? JSON.parse(monster.status_effects) : monster.status_effects) : {};
  const weakenedDefReduction = monsterWeakenedFx.weakened ? (monsterWeakenedFx.weakened.amount || 0) : 0;
  const dmgToMonster = Math.max(1, Math.round(dmgAfterPhysResist * critResistMult) - Math.max(0, Math.floor(monster.defense || 0) - weakenedDefReduction) - monsterVirtualDefBonus + spectralBonusDmg);
  monster.hp = Math.max(0, monster.hp - dmgToMonster);

  // T190: mensaje de encantamiento activo en el primer golpe del turno
  if (enchantActive) {
    const enchantNames = { fuego: '🔥 Fuego', hielo: '❄️ Hielo', sombra: '🌑 Sombra', luz: '✨ Luz' };
    lines.push(`🪄 [Encantamiento de ${enchantNames[enchantData.type] || enchantData.type} activo]`);
  }

  if (isCrit) {
    const physResistNote = physResist < 1.0 ? ` ${physResistLabel}` : '';
    const clericNote = clericWeaponPenaltyNote.length > 0 ? ' ' + clericWeaponPenaltyNote[0] : '';
    const critResistNote = critResistDef ? ` ${critResistDef.label}` : '';
    const spectralNote = spectralBonusDmg > 0 ? ` 👻 (+${spectralBonusDmg} espectral)` : '';
    lines.push(`💥 ¡GOLPE CRÍTICO! Atacás al ${monster.name} con fuerza devastadora: ${dmgToMonster} de daño.${physResistNote}${critResistNote}${clericNote}${spectralNote}${rageLabel} (${monster.hp}/${monster.max_hp} HP)`);
  } else {
    // DIS-D426: mostrar indicador de postura activa en el mensaje de ataque
    // DIS-472: cada postura tiene mensajes de ataque diferenciados que refuerzan la fantasía
    const stanceAttackMsgs = {
      agresivo: [
        `arremetés sin guardia al ${monster.name}`,
        `atacás con abandono al ${monster.name}`,
        `lanzás un golpe salvaje al ${monster.name}`,
        `atacás ofensivamente al ${monster.name} dejando flancos expuestos`,
      ],
      defensivo: [
        `atacás al ${monster.name} desde detrás de tu guardia`,
        `esperás la apertura correcta y golpeás al ${monster.name}`,
        `respondés con cautela al ${monster.name}`,
        `atacás al ${monster.name} sin sobreextenderte`,
      ],
      equilibrado: null, // usa mensaje genérico
    };
    const stanceIcons = {
      agresivo:    '⚡[ofensivo] ',
      defensivo:   '🛡[defensivo] ',
      equilibrado: '',
    };
    const stanceTag = stanceIcons[stanceName] || '';
    const stanceMsgsForStance = stanceAttackMsgs[stanceName];
    const attackVerb = stanceMsgsForStance
      ? stanceMsgsForStance[Math.floor(Math.random() * stanceMsgsForStance.length)]
      : `Atacás al ${monster.name}`;
    // DIS-471: mensaje de sabor especial para el Mago sin maná (ataque físico con báculo)
    // DIS-1113: hint para usar drenar_arcano si el jugador tiene 0 maná
    const curMana = player.mana != null ? player.mana : 0;
    const isMagoSinMana = clsData && clsData.name === 'Mago' && curMana <= 0;
    const magoMsgs = [
      'golpeás con el báculo',
      'lanzás una chispa estática sin maná',
      'dás un golpe torpe con el báculo',
      'improvisás un ataque físico',
    ];
    const magoFlavor = isMagoSinMana
      ? `[sin maná — ${magoMsgs[Math.floor(Math.random() * magoMsgs.length)]}] `
      : '';
    lines.push(`⚔  ${stanceTag}${magoFlavor}${attackVerb} y le causás ${dmgToMonster} de daño.${physResist < 1.0 ? ` ${physResistLabel}` : ''}${spectralBonusDmg > 0 ? ` 👻 (+${spectralBonusDmg} espectral)` : ''}${clericWeaponPenaltyNote.length > 0 ? ' ' + clericWeaponPenaltyNote[0] : ''}${rageLabel} (${monster.hp}/${monster.max_hp} HP)${isMagoSinMana ? '\n   💡 [Mago sin maná] Usá "drenar arcano" para absorber esencia mágica y recuperar 2-4 maná.' : ''}`);
  }

  // Actualizar monstruo en BD
  db.updateMonster(monster.id, { hp: monster.hp });

  // DIS-834: guardar el ATK del monstruo ANTES de activar la Fase 2.
  // El contraataque del mismo turno debe usar el ATK anterior — no el boost de Fase 2.
  // Esto evita que el jugador reciba el daño de Fase 2 en el mismo turno que activa la transición.
  const _atkBeforePhase2 = monster.attack;
  let _phase2ActivatedThisTurn = false;

  // DIS-D423: Fase 2 — activar si el boss llega al 50% HP por primera vez
  if (monster.hp > 0) {
    const bossDefPhase2 = BOSS_MONSTERS[monster.id];
    if (bossDefPhase2 && bossDefPhase2.phase2) {
      const monsterFxP2 = monster.status_effects
        ? (typeof monster.status_effects === 'string' ? JSON.parse(monster.status_effects) : monster.status_effects)
        : {};
      const halfHp = Math.floor(monster.max_hp / 2);
      if (!monsterFxP2.phase2_triggered && monster.hp <= halfHp) {
        monsterFxP2.phase2_triggered = true;
        const p2 = bossDefPhase2.phase2;
        const newAtkP2 = monster.attack + p2.atkBonus;
        const newDefP2 = (monster.defense || 0) + p2.defBonus;
        monster.attack = newAtkP2;
        _phase2ActivatedThisTurn = true;
        // BUG-687: actualizar status_effects en memoria para que escrituras posteriores
        // (attacked_player_this_turn en contraataque) no sobreescriban phase2_triggered en BD
        monster.status_effects = monsterFxP2;
        db.updateMonster(monster.id, {
          attack: newAtkP2,
          defense: newDefP2,
          status_effects: JSON.stringify(monsterFxP2),
        });
        lines.push(p2.message);
      }
    }
  }

  // ── T191: Ataque de mascota ────────────────────────────────────────────────
  // Si el jugador tiene mascota, hay chance de que ataque al monstruo (si sigue vivo)

  // DIS-778/DIS-810: Regeneración del Gólem de Piedra — cada 2 turnos regenera HP
  // DIS-810: Para jugadores nivel 7+, la regen es 12 HP (antes era 8 HP para todos)
  // Crea presión de tiempo e incentiva el uso de recursos para terminar el combate rápido
  if (monster.hp > 0 && monNameLow.includes('gólem de piedra')) {
    const golemFx = monster.status_effects
      ? (typeof monster.status_effects === 'string' ? JSON.parse(monster.status_effects) : monster.status_effects)
      : {};
    const golemTurns = (golemFx.golem_turns || 0) + 1;
    golemFx.golem_turns = golemTurns;
    if (golemTurns % 2 === 0) {
      // Cada 2 turnos: regeneración — 12 HP para nivel 7+ (late game), 8 HP para nivel <7
      const regenAmount = (player.level >= 7) ? 12 : 8;
      const newGolemHp = Math.min(monster.max_hp, monster.hp + regenAmount);
      const actualRegen = newGolemHp - monster.hp;
      if (actualRegen > 0) {
        monster.hp = newGolemHp;
        lines.push(`🪨 Los fragmentos del Gólem de Piedra se reensamblan — regenera ${actualRegen} HP. (${monster.hp}/${monster.max_hp} HP)`);
      }
    }
    monster.status_effects = golemFx;
    db.updateMonster(monster.id, { hp: monster.hp, status_effects: JSON.stringify(golemFx) });
  }

  if (monster.hp > 0 && player.pet) {
    const PET_COMBAT = {
      'rata de las mazmorras': { name: 'Rata', emoji: '🐀', chance: 0.15, minDmg: 1, maxDmg: 2, poisonChance: 0 },
      'murciélago':            { name: 'Murciélago', emoji: '🦇', chance: 0.20, minDmg: 2, maxDmg: 3, poisonChance: 0.10 },
      'araña doméstica':       { name: 'Araña', emoji: '🕷', chance: 0.25, minDmg: 2, maxDmg: 3, poisonChance: 0.20 },
      'serpiente':             { name: 'Serpiente', emoji: '🐍', chance: 0.20, minDmg: 3, maxDmg: 4, poisonChance: 0.30 },
      'escarabajo de mazmorra': { name: 'Escarabajo', emoji: '🪲', chance: 0.15, minDmg: 1, maxDmg: 2, poisonChance: 0, hpAbsorb: 1 },
    };
    const petKey = player.pet.toLowerCase();
    // Buscar pet en catálogo (búsqueda parcial)
    const petDef = Object.entries(PET_COMBAT).find(([k]) => k.includes(petKey) || petKey.includes(k));
    if (petDef) {
      const [, petStats] = petDef;
      if (Math.random() < petStats.chance) {
        // T199: bonus de daño según nivel de mascota (Lv3=+1, Lv4=+2, Lv5=+3)
        const petLevel = Math.min(5, Math.floor((player.kills || 0) / 20) + 1);
        const petLvBonus = petLevel >= 3 ? petLevel - 2 : 0;
        const petDmg = petStats.minDmg + Math.floor(Math.random() * (petStats.maxDmg - petStats.minDmg + 1)) + petLvBonus;
        monster.hp = Math.max(0, monster.hp - petDmg);
        db.updateMonster(monster.id, { hp: monster.hp });
        lines.push(`${petStats.emoji} ¡Tu ${petStats.name} ataca al ${monster.name} y causa ${petDmg} de daño! (${monster.hp}/${monster.max_hp} HP)`);
        // Veneno de mascota
        if (petStats.poisonChance > 0 && Math.random() < petStats.poisonChance && monster.hp > 0) {
          const mFxPet = monster.status_effects ? (typeof monster.status_effects === 'string' ? JSON.parse(monster.status_effects) : monster.status_effects) : {};
          if (!mFxPet.poisoned) {
            mFxPet.poisoned = { damage: 1, turns: 3 };
            monster.status_effects = mFxPet;
            db.updateMonster(monster.id, { status_effects: JSON.stringify(mFxPet) });
            lines.push(`☠ ¡Tu ${petStats.name} envenena al ${monster.name}! (1 dmg/turno por 3 turnos)`);
          }
        }
        // Absorción de HP (escarabajo)
        if (petStats.hpAbsorb && monster.hp >= 0) {
          const freshForPet = db.getPlayer(player.id);
          const newPetHp = Math.min(freshForPet.max_hp, freshForPet.hp + petStats.hpAbsorb);
          if (newPetHp > freshForPet.hp) {
            db.updatePlayer(player.id, { hp: newPetHp });
            player.hp = newPetHp;
            lines.push(`🪲 ¡Tu Escarabajo absorbe energía vital! Recuperás ${petStats.hpAbsorb} HP.`);
          }
        }
        // Verificar si el monstruo muere por el ataque de la mascota
        if (monster.hp <= 0 && !monsterDead) {
          monsterDead = true;
          lines.push(`💀 ¡${articuloMonstruo(monster.name)} ${monster.name} cae ${derrotadoMonstruo(monster.name)} por tu mascota!`);
          const { droppedLoot: petLoot, globalEvent: petGlobalEvent, lootNote: petLootNote } = dropLoot(monster, player.current_room_id, player);
          loot = petLoot;
          if (loot.length > 0) lines.push(`💰 ${articuloMonstruo(monster.name)} ${monster.name} suelta: ${loot.join(', ')}.`);
          else lines.push(`${articuloMonstruo(monster.name)} ${monster.name} no deja nada.`);
          if (petLootNote) lines.push(petLootNote);
          const xpBasePet = Math.max(5, Math.floor(monster.max_hp * 2));
          const activeEvPet = worldEvents.getCurrentEvent();
          const invasionMultPet = (activeEvPet && activeEvPet.id === 'invasion') ? 1.5 : 1.0;
          // DIS-852: bloodmoon +75% XP para monstruos nivel 3+ afectados
          const bloodmoonXpPet = (activeEvPet && activeEvPet.id === 'bloodmoon' && activeEvPet.affectedIds && activeEvPet.affectedIds.has(monster.id))
            ? (1 + (activeEvPet.xpBonus || 0.75)) : 1.0;
          const xpGainPet = Math.floor(xpBasePet * invasionMultPet * bloodmoonXpPet);
          const freshPPet = db.getPlayer(player.id);
          const newKillsPet = (freshPPet.kills || 0) + 1;
          const newXpPet = (freshPPet.xp || 0) + xpGainPet;
          const oldLevelPet = freshPPet.level || 1;
          const newLevelPet = xpSystem.levelFromXp(newXpPet);
          const updatesPet = { kills: newKillsPet, xp: newXpPet, level: newLevelPet };
          if (newLevelPet > oldLevelPet) {
            updatesPet.max_hp = (freshPPet.max_hp || 30) + 5;
            const healPet = Math.ceil(updatesPet.max_hp * 0.20);
            updatesPet.hp = Math.min(updatesPet.max_hp, (freshPPet.hp || 1) + healPet);
            updatesPet.attack = (freshPPet.attack || 5) + 1;
            lines.push(`✨ ¡Subiste al nivel ${newLevelPet}! +5 HP máx, +1 ataque, +${healPet} HP restaurado.`);
          }
          lines.push(`⭐ +${xpGainPet} XP (kills: ${newKillsPet} | nivel: ${newLevelPet})`);
          db.updatePlayer(player.id, updatesPet);
          return { lines, monsterDead, playerDead, loot, globalEvent: petGlobalEvent || null };
        }
      }
    }
  }

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
          } else if (onHit.type === 'weakened') {
            // DIS-1116: Debilidad Espectral — reduce la defensa del monstruo por N rondas
            const monsterFxW = monster.status_effects ? (typeof monster.status_effects === 'string' ? JSON.parse(monster.status_effects) : monster.status_effects) : {};
            if (!monsterFxW.weakened) {
              monsterFxW.weakened = { amount: onHit.amount, turns: onHit.turns };
              monster.status_effects = monsterFxW;
              db.updateMonster(monster.id, { status_effects: JSON.stringify(monsterFxW) });
              lines.push(`👻 ¡La Alabarda Espectral aplica DEBILIDAD ESPECTRAL al ${monster.name}! (-${onHit.amount} DEF por ${onHit.turns} rondas)`);
            }
          } else if (onHit.type === 'shadow_bolt') {
            // Rayo de sombra: daño extra inmediato
            const shadowDmg = onHit.bonus_damage || 8;
            monster.hp = Math.max(0, monster.hp - shadowDmg);
            db.updateMonster(monster.id, { hp: monster.hp });
            lines.push(`🌑 ¡El grimorio libera un RAYO DE SOMBRA! ${shadowDmg} daño extra al ${monster.name}. (${monster.hp}/${monster.max_hp} HP)`);
            if (monster.hp <= 0) {
              monsterDead = true;
              lines.push(`💀 ¡${articuloMonstruo(monster.name)} ${monster.name} cae ${derrotadoMonstruo(monster.name)} por las sombras!`);
              const { droppedLoot, globalEvent, lootNote: ln821 } = dropLoot(monster, player.current_room_id, player);
              loot = droppedLoot;
              if (loot.length > 0) lines.push(`💰 ${articuloMonstruo(monster.name)} ${monster.name} suelta: ${loot.join(', ')}.`);
              if (ln821) lines.push(ln821);
              else lines.push(`${articuloMonstruo(monster.name)} ${monster.name} no deja nada.`);
              const xpBase2 = Math.max(5, Math.floor(monster.max_hp * 2));
              const activeEv2 = worldEvents.getCurrentEvent();
              const xpGain2 = activeEv2 && activeEv2.id === 'invasion' ? Math.floor(xpBase2 * 1.5) : xpBase2;
              const freshPl2 = db.getPlayer(player.id);
              const newKills2 = (freshPl2.kills || 0) + 1;
              const newXp2    = (freshPl2.xp    || 0) + xpGain2;
              const oldLevel2 = freshPl2.level || 1;
              const newLevel2 = xpSystem.levelFromXp(newXp2);
              const updates2  = { kills: newKills2, xp: newXp2, level: newLevel2 };
              if (newLevel2 > oldLevel2) {
                updates2.max_hp = (freshPl2.max_hp || 30) + 5;
                const heal2 = Math.ceil(updates2.max_hp * 0.20);
                updates2.hp = Math.min(updates2.max_hp, (freshPl2.hp || 1) + heal2);
                updates2.attack = (freshPl2.attack || 5) + 1;
                lines.push(`✨ ¡Subiste al nivel ${newLevel2}! +5 HP máx, +1 ataque, +${heal2} HP restaurado.`);
              }
              lines.push(`⭐ +${xpGain2} XP (kills: ${newKills2} | nivel: ${newLevel2})`);
              db.updatePlayer(player.id, updates2);
              return { lines, monsterDead, playerDead, loot, globalEvent: globalEvent || null };
            }
          }
        }
      }
    }
  }

  // ── DIS-615: Veneno de contacto del Pícaro (cargas en status_effects) ────
  if (monster.hp > 0) {
    const sePlayer = player.status_effects
      ? (typeof player.status_effects === 'string' ? JSON.parse(player.status_effects) : player.status_effects)
      : {};
    const cpData = sePlayer['contact_poison'];
    if (cpData && cpData.charges > 0) {
      if (Math.random() < (cpData.poison_chance || 0.40)) {
        const monsterFxCP = monster.status_effects
          ? (typeof monster.status_effects === 'string' ? JSON.parse(monster.status_effects) : monster.status_effects)
          : {};
        if (!monsterFxCP.poisoned) {
          monsterFxCP.poisoned = { damage: 3, turns: 3 };
          monster.status_effects = monsterFxCP;
          db.updateMonster(monster.id, { status_effects: JSON.stringify(monsterFxCP) });
          lines.push(`🧪 ¡El veneno de contacto envenena al ${monster.name}! (3 dmg/turno por 3 turnos)`);
        }
      }
      cpData.charges -= 1;
      if (cpData.charges <= 0) {
        delete sePlayer['contact_poison'];
        lines.push(`🧪 Las cargas de veneno de contacto se agotaron.`);
      }
      db.updatePlayer(player.id, { status_effects: JSON.stringify(sePlayer) });
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
        lines.push(`💀 ¡${articuloMonstruo(monster.name)} ${monster.name} cae ${derrotadoMonstruo(monster.name)} por el veneno!`);
        const { droppedLoot, globalEvent, lootNote: ln898 } = dropLoot(monster, player.current_room_id, player);
        loot = droppedLoot;
        if (loot.length > 0) lines.push(`💰 ${articuloMonstruo(monster.name)} ${monster.name} suelta: ${loot.join(', ')}.`);
        else lines.push(`${articuloMonstruo(monster.name)} ${monster.name} no deja nada.`);
        if (ln898) lines.push(ln898);
        const xpBase3 = Math.max(5, Math.floor(monster.max_hp * 2));
        const activeEv3 = worldEvents.getCurrentEvent();
        const invasionMult3 = (activeEv3 && activeEv3.id === 'invasion') ? 1.5 : 1.0;
        // DIS-852: bloodmoon +75% XP para monstruos nivel 3+ afectados
        const bloodmoonXp3 = (activeEv3 && activeEv3.id === 'bloodmoon' && activeEv3.affectedIds && activeEv3.affectedIds.has(monster.id))
          ? (1 + (activeEv3.xpBonus || 0.75)) : 1.0;
        const xpGain3 = Math.floor(xpBase3 * invasionMult3 * bloodmoonXp3);
        const freshPl3 = db.getPlayer(player.id);
        const newKills3 = (freshPl3.kills || 0) + 1;
        const newXp3    = (freshPl3.xp    || 0) + xpGain3;
        const oldLevel3 = freshPl3.level || 1;
        const newLevel3 = xpSystem.levelFromXp(newXp3);
        const updates3  = { kills: newKills3, xp: newXp3, level: newLevel3 };
        if (newLevel3 > oldLevel3) {
          updates3.max_hp = (freshPl3.max_hp || 30) + 5;
          const heal3 = Math.ceil(updates3.max_hp * 0.20);
          updates3.hp = Math.min(updates3.max_hp, (freshPl3.hp || 1) + heal3);
          updates3.attack = (freshPl3.attack || 5) + 1;
          lines.push(`✨ ¡Subiste al nivel ${newLevel3}! +5 HP máx, +1 ataque, +${heal3} HP restaurado.`);
        }
        lines.push(`⭐ +${xpGain3} XP (kills: ${newKills3} | nivel: ${newLevel3})`);
        db.updatePlayer(player.id, updates3);
        return { lines, monsterDead, playerDead, loot, globalEvent: globalEvent || null };
      }
    }
  }

  // ── DIS-1116: Tick de Debilidad Espectral del monstruo ────────────────────
  if (monster.hp > 0 && monster.status_effects) {
    const mFxW = typeof monster.status_effects === 'string' ? JSON.parse(monster.status_effects) : monster.status_effects;
    if (mFxW.weakened) {
      mFxW.weakened.turns = (mFxW.weakened.turns || 1) - 1;
      if (mFxW.weakened.turns <= 0) {
        delete mFxW.weakened;
        lines.push(`✨ La Debilidad Espectral en ${monster.name} se disipa.`);
      }
      monster.status_effects = mFxW;
      db.updateMonster(monster.id, { status_effects: JSON.stringify(mFxW) });
    }
  }


  if (monster.hp <= 0) {
    monsterDead = true;
    lines.push(`💀 ¡${articuloMonstruo(monster.name)} ${monster.name} cae ${derrotadoMonstruo(monster.name)}!`);

    // Soltar loot en la habitación
    const { droppedLoot, directLoot: directLootItems, globalEvent, lootNote: ln936 } = dropLoot(monster, player.current_room_id, player);
    loot = droppedLoot;

    // DIS-1007: ítems directos van al inventario del jugador sin pasar por el suelo
    if (directLootItems && directLootItems.length > 0) {
      const freshPlayer2 = db.getPlayer(player.id);
      const inv2 = Array.isArray(freshPlayer2.inventory) ? freshPlayer2.inventory : JSON.parse(freshPlayer2.inventory || '[]');
      const newInv2 = [...inv2, ...directLootItems];
      db.updatePlayer(player.id, { inventory: JSON.stringify(newInv2) });
      lines.push(`⚔️ ${articuloMonstruo(monster.name)} ${monster.name} suelta directamente: **${directLootItems.join(', ')}** (ya en tu inventario).`);
    }

    if (loot.length > 0) {
      lines.push(`💰 ${articuloMonstruo(monster.name)} ${monster.name} suelta: ${loot.join(', ')}.`);
    } else if (!directLootItems || directLootItems.length === 0) {
      lines.push(`${articuloMonstruo(monster.name)} ${monster.name} no deja nada.`);
    }
    if (ln936) lines.push(ln936);

    // Actualizar kills y XP del jugador
    // T221: Bonus élite — +75% XP y loot extra si el monstruo es élite
    const isEliteMonster = monster.name.startsWith('⭐ ');
    if (isEliteMonster) {
      lines.push(`🌟 ¡Era un monstruo ÉLITE! Recompensa mejorada.`);
      // BUG-907: Loot diferenciado por tipo de élite — cada mob tiene su ítem exclusivo
      const ELITE_EXCLUSIVE_LOOT = {
        'Goblin Merodeador':    { item: 'gema de goblin',       chance: 0.60 },
        'Rata Gigante':         { item: 'pelaje lustroso',       chance: 0.70 },
        'Araña Tejedora':       { item: 'seda de élite',         chance: 0.65 },
        'Espectro del Corredor':{ item: 'fragmento espectral',   chance: 0.60 },
        'Murciélago Vampiro':   { item: 'colmillo vampírico',    chance: 0.55 },
        'Esqueleto Guerrero':   { item: 'hueso reforzado',       chance: 0.60 },
        'Gólem de Piedra':      { item: 'cristal de élite',      chance: 0.50 },
        'Elemental de Hielo':   { item: 'núcleo gélido',         chance: 0.50 },
        'Krakeling':            { item: 'tinta de abismo',       chance: 0.55 },
      };
      // Extraer nombre base (sin el ⭐ y el espacio)
      const eliteBaseName = monster.name.slice(2);
      const exclusiveLootEntry = ELITE_EXCLUSIVE_LOOT[eliteBaseName];

      // Agregar loot extra: siempre monedas de oro extra + posible ítem exclusivo
      const eliteGoldLoot = ['monedas de oro'];
      if (Math.random() < 0.5) eliteGoldLoot.push('monedas de oro');
      // Ítem exclusivo con chance según la tabla
      if (exclusiveLootEntry && Math.random() < exclusiveLootEntry.chance) {
        eliteGoldLoot.push(exclusiveLootEntry.item);
      }
      loot.push(...eliteGoldLoot);
      // BUG-887: Depositar las monedas de oro del élite en el suelo de la sala
      // Antes solo se agregaban al array local 'loot' (para el mensaje) pero no al suelo
      const eliteRoom = db.getRoom(player.current_room_id);
      if (eliteRoom) {
        db.updateRoomItems(player.current_room_id, [...eliteRoom.items, ...eliteGoldLoot]);
      }
      if (loot.length > 0) {
        // Actualizar el mensaje de loot si ya lo pusimos
        // BUG-624: deduplicar el display del loot para evitar "monedas de oro, monedas de oro"
        // (el loot real en la sala ya está deduplicado por dropLoot, pero el array local acumula duplicados)
        const lootDisplay = [...new Set(loot)];
        const lootIdx = lines.findLastIndex(l => l.includes('suelta:') || l.includes('no deja nada'));
        if (lootIdx >= 0) lines[lootIdx] = `💰 ${articuloMonstruo(monster.name)} ${monster.name} suelta: ${lootDisplay.join(', ')}.`;
      }
    }
    const eliteXpMult = isEliteMonster ? 1.75 : 1.0;
    const xpBase = Math.max(5, Math.floor(monster.max_hp * 2));
    // Bonus de XP si hay evento invasión o luna de sangre (DIS-852) o clima de calma arcana (T166)
    const activeEv = worldEvents.getCurrentEvent();
    const invasionMult = (activeEv && activeEv.id === 'invasion') ? 1.5 : 1.0;
    // DIS-852: bloodmoon da +75% XP solo para monstruos nivel 3+ afectados
    const bloodmoonXpMult = (activeEv && activeEv.id === 'bloodmoon' && activeEv.affectedIds && activeEv.affectedIds.has(monster.id))
      ? (1 + (activeEv.xpBonus || 0.75)) : 1.0;
    const weatherXpMult = weather.getXpMultiplier(); // 1.1 si calma arcana, 1.0 si no
    const xpGain = Math.floor(xpBase * invasionMult * bloodmoonXpMult * weatherXpMult * eliteXpMult);
    const freshPlayer = db.getPlayer(player.id);

    // DIS-1019 / BUG-927: El Goblin de Práctica (id=20) no da XP ni kills en ningún caso.
    // - Durante el tutorial (tutorial_step > 0): es una pelea pedagógica. La recompensa de salir
    //   del tutorial ya está en completeTutorial() (+10 XP). Si el goblin también diera XP, el
    //   jugador podría subir al nivel 2 durante la Antesala (dos fights = 32 XP + 10 = 42, muy
    //   cerca del umbral de nivel 2 en 50 XP, y con más hits queda arriba).
    // - Post-tutorial (tutorial_step === 0): si el jugador vuelve antes del respawn, tampoco da recompensa.
    // - Sin tutorial (tutorial_step null/undefined): jugador antiguo ya en dungeon real → sin XP.
    // En todos los casos: saltar el bloque de XP/kills.
    const PRACTICE_GOBLIN_ID_MAIN = 20;
    if (monster.id === PRACTICE_GOBLIN_ID_MAIN) {
      const inActiveTutorial = freshPlayer.tutorial_step != null && freshPlayer.tutorial_step > 0;
      const reason = inActiveTutorial
        ? '(el Goblin de Práctica no da XP durante el tutorial — la recompensa es completarlo)'
        : '(el Goblin de Práctica no da XP ni kills — es un mob de entrenamiento)';
      lines.push(`   ${reason}`);
      return { lines, monsterDead, playerDead, loot, globalEvent: globalEvent || null };
    }

    const newKills = (freshPlayer.kills || 0) + 1;
    const newXp    = (freshPlayer.xp    || 0) + xpGain;
    const oldLevel = freshPlayer.level || 1;
    // Nivel sube con curva cuadrática (DIS-D282): xpForLevel(L) = 10*(L-1)² + 40*(L-1)
    const newLevel = xpSystem.levelFromXp(newXp);
    const updates  = { kills: newKills, xp: newXp, level: newLevel };
    if (newLevel > oldLevel) {
      // Subida de nivel: +5 max_hp, +1 ataque, +20% del nuevo max_hp en HP restaurado (DIS-D342)
      updates.max_hp = (freshPlayer.max_hp || 30) + 5;
      const healOnLevelUp = Math.ceil(updates.max_hp * 0.20);
      updates.hp     = Math.min(updates.max_hp, (freshPlayer.hp || 1) + healOnLevelUp);
      updates.attack = (freshPlayer.attack || 5) + 1;
      lines.push(`✨ ¡Subiste al nivel ${newLevel}! +5 HP máx, +1 ataque, +${healOnLevelUp} HP restaurado.`);
      // DIS-914: Prompt de especialización al llegar al nivel 5
      if (newLevel === 5 && freshPlayer.player_class && freshPlayer.player_class !== 'sin_clase' && !freshPlayer.specialization) {
        lines.push(`\n🌟 ¡Nivel 5 alcanzado! Es hora de elegir tu ESPECIALIZACIÓN.`);
        lines.push(`   Escribí "especializar" para ver las opciones y escoger tu camino.`);
        lines.push(`   Esta decisión es permanente — define quién sos en el dungeon.`);
      }
    }
    lines.push(`⭐ +${xpGain} XP (kills: ${newKills} | nivel: ${newLevel})`);
    // T190: Encantamiento de luz — +3 HP al matar
    if (enchantActive && enchantData.type === 'luz') {
      const hpOnKill = enchantData.hp_on_kill || 3;
      const freshForLuz = db.getPlayer(player.id);
      const newHpLuz = Math.min(freshForLuz.max_hp, freshForLuz.hp + hpOnKill);
      db.updatePlayer(player.id, { hp: newHpLuz });
      lines.push(`✨ [Runa de Luz] ¡La victoria te cura ${hpOnKill} HP! (${newHpLuz}/${freshForLuz.max_hp})`);
      updates.hp = newHpLuz;
    }
    db.updatePlayer(player.id, updates);

    // DIS-914: Asesino — al matar con crítico, 15% chance de loot doble
    if (player.specialization === 'asesino' && isCrit && loot.length > 0 && Math.random() < 0.15) {
      const bonusLoot = [...loot];
      const roomForDouble = db.getRoom(player.current_room_id);
      if (roomForDouble) {
        db.updateRoomItems(player.current_room_id, [...roomForDouble.items, ...bonusLoot]);
      }
      loot.push(...bonusLoot);
      lines.push(`🗡️ [Asesino] ¡Kill crítico! El loot se duplica (×2): ${[...new Set(loot)].join(', ')}.`);
    }

    // DIS-947: Ladrón de Sombras — al matar humanoides, 25% chance de +3-8g bonus
    if (player.specialization === 'ladron' && Math.random() < 0.25) {
      const HUMANOID_NAMES = ['goblin', 'esqueleto', 'bandido', 'espectro', 'lich', 'mago liche', 'campeón espectral', 'eco viviente'];
      const monNameNorm = (monster.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const isHumanoid = HUMANOID_NAMES.some(h => monNameNorm.includes(h.normalize('NFD').replace(/[\u0300-\u036f]/g, '')));
      if (isHumanoid) {
        const bonusGold = Math.floor(Math.random() * 6) + 3; // 3-8g
        const freshForLadron = db.getPlayer(player.id);
        db.updatePlayer(player.id, { gold: (freshForLadron.gold || 0) + bonusGold });
        lines.push(`🎭 [Ladrón de Sombras] Tus dedos ágiles encuentran ${bonusGold}g escondidos mientras el ${monster.name} cae.`);
      }
    }

    // DIS-497: Bonus de asistencia — otros jugadores activos en la misma sala reciben +25% XP
    // Esto hace que cooperar tenga valor concreto: estar en la misma sala que otro jugador
    // que mata un monstruo otorga XP de asistencia pasiva.
    try {
      const roommates = db.getPlayersInRoom(player.current_room_id).filter(p => p.id !== player.id);
      if (roommates.length > 0) {
        const assistXp = Math.max(1, Math.floor(xpGain * 0.25));
        const assistNames = [];
        for (const ally of roommates) {
          const freshAlly = db.getPlayer(ally.id);
          if (!freshAlly) continue;
          const allyNewXp = (freshAlly.xp || 0) + assistXp;
          const allyOldLevel = freshAlly.level || 1;
          const allyNewLevel = xpSystem.levelFromXp(allyNewXp);
          const allyUpdates = { xp: allyNewXp, level: allyNewLevel };
          if (allyNewLevel > allyOldLevel) {
            allyUpdates.max_hp = (freshAlly.max_hp || 30) + 5;
            const allyHeal = Math.ceil(allyUpdates.max_hp * 0.20);
            allyUpdates.hp = Math.min(allyUpdates.max_hp, (freshAlly.hp || 1) + allyHeal);
            allyUpdates.attack = (freshAlly.attack || 5) + 1;
          }
          db.updatePlayer(freshAlly.id, allyUpdates);
          assistNames.push(freshAlly.username);
        }
        if (assistNames.length > 0) {
          lines.push(`🤝 ¡Asistencia! ${assistNames.join(', ')} recibe${assistNames.length > 1 ? 'n' : ''} +${assistXp} XP por estar en la misma sala.`);
        }
      }
    } catch (_) { /* no interrumpir el flujo si falla la asistencia */ }

    return { lines, monsterDead, playerDead, loot, globalEvent: globalEvent || null };
  }

  // ── T114: Verificar si el monstruo está aturdido (shield_bash stun) ────────
  const monsterFxForStun = monster.status_effects ? (typeof monster.status_effects === 'string' ? JSON.parse(monster.status_effects) : monster.status_effects) : {};
  // T214: el stun puede ser {turns: N} (T114/shield_bash) o N numérico (T214/rayo)
  const stunnedVal = monsterFxForStun.stunned;
  if (stunnedVal) {
    if (typeof stunnedVal === 'object' && stunnedVal.turns > 0) {
      // Formato T114 — objeto con turnos
      monsterFxForStun.stunned.turns -= 1;
      if (monsterFxForStun.stunned.turns <= 0) {
        delete monsterFxForStun.stunned;
        lines.push(`😵 ${articuloMonstruo(monster.name)} ${monster.name} se recupera del aturdimiento.`);
      } else {
        lines.push(`😵 ${articuloMonstruo(monster.name)} ${monster.name} está aturdido y no puede atacar este turno.`);
      }
    } else if (typeof stunnedVal === 'number' && stunnedVal > 0) {
      // Formato T214 — número de turnos restantes
      const remaining = stunnedVal - 1;
      if (remaining <= 0) {
        delete monsterFxForStun.stunned;
        lines.push(`😵 ${articuloMonstruo(monster.name)} ${monster.name} se recupera del aturdimiento eléctrico.`);
      } else {
        monsterFxForStun.stunned = remaining;
        lines.push(`⚡ ${articuloMonstruo(monster.name)} ${monster.name} sigue aturdido por el rayo y no puede atacar.`);
      }
    } else {
      delete monsterFxForStun.stunned;
    }
    monster.status_effects = monsterFxForStun;
    db.updateMonster(monster.id, { status_effects: JSON.stringify(monsterFxForStun) });
    db.updatePlayer(player.id, { hp: player.hp, status_effects: JSON.stringify(player.status_effects || {}) });
    return { lines, monsterDead, playerDead, loot };
  }

  // ── T190: Encantamiento de hielo — 20% chance de ralentizar (skip turno) ───
  if (enchantActive && enchantData.type === 'hielo' && Math.random() < (enchantData.slow_chance || 0.20)) {
    lines.push(`❄️ ¡Tu arma encantada ralentiza al ${monster.name}! No puede atacar este turno.`);
    db.updatePlayer(player.id, { hp: player.hp, status_effects: JSON.stringify(player.status_effects || {}) });
    return { lines, monsterDead: false, playerDead: false, loot: [] };
  }

  // ── Monstruo contraataca ──────────────────────────────────────────────────
  // DIS-620: Si fue golpe de sorpresa (sigilo), el monstruo no responde este turno
  // DIS-757: EXCEPCIÓN — bosses avanzados (Campeón, Eco Viviente, Sombra) rompen el sigilo
  // y contraatacan en el mismo turno. El multiplicador ya fue reducido a ×1.5 (DIS-683) pero el
  // stun completo los trivializaba. Ahora esos bosses perciben el ataque y responden igualmente.
  // DIS-840: El Lich Anciano NO rompe el sigilo — el turno libre es el principal valor del sigilo
  // vs el Lich. Sus crits ya tienen resistencia ×0.75 (DIS-835), así que el crit no es trivial.
  // El jugador debe usar el sigilo tácticamente: recuperar HP en un turno crítico.
  const STEALTH_RESISTANT_BOSSES = new Set([12, 21, 22]); // Campeón, Eco Viviente, Sombra (no el Lich)
  const bossBreaksStealth = stealthSurprise && STEALTH_RESISTANT_BOSSES.has(monster.id);
  if (stealthSurprise && !monsterDead && !bossBreaksStealth) {
    lines.push(`🥷 ${articuloMonstruo(monster.name)} ${monster.name} está aturdido por la sorpresa — no puede responder este turno.`);
    db.updatePlayer(player.id, { hp: player.hp });
    return { lines, monsterDead, playerDead, loot, poisonSurvived };
  }
  if (bossBreaksStealth && !monsterDead) {
    lines.push(`⚠️ ¡${articuloMonstruo(monster.name)} ${monster.name} ROMPE EL SIGILO! Un boss de esta magnitud no puede ser sorprendido — contraataca de inmediato.`);
  }

  // DIS-729: marcar que la Sombra del Vacío ya actuó (para habilitar Oscuridad Paralizante desde el 2do turno)
  if (!monsterDead && monster.name && monster.name.includes('Sombra del Vacío')) {
    const freshShadowP = db.getPlayer(player.id);
    const seShadow = freshShadowP.status_effects ? (typeof freshShadowP.status_effects === 'string' ? JSON.parse(freshShadowP.status_effects) : freshShadowP.status_effects) : {};
    if (!seShadow.shadow_attacked) {
      seShadow.shadow_attacked = true;
      db.updatePlayer(player.id, { status_effects: JSON.stringify(seShadow) });
    }
  }

  // DIS-720: Ataque de apertura inevitable del Guardia Espectral
  // En el primer contraataque (flag guardian_opening_done aún no seteado), el Guardia
  // aplica un golpe espectral fijo de 8 HP que no puede esquivarse — establece amenaza
  // independientemente del RNG del entumecimiento.
  if (!monsterDead && monster.name === 'Guardia Espectral') {
    const guardFx = monster.status_effects
      ? (typeof monster.status_effects === 'string' ? JSON.parse(monster.status_effects) : monster.status_effects)
      : {};
    if (!guardFx.guardian_opening_done) {
      // Primer contraataque — golpe espectral inevitable
      const openingDmg = Math.max(0, 8 - Math.floor((player.defense || 0) * 0.5));
      player.hp = Math.max(0, player.hp - openingDmg);
      lines.push(`👻 ¡El Guardia Espectral lanza un GOLPE ESPECTRAL de apertura! ${openingDmg} de daño (inevitable). (${player.hp}/${player.max_hp} HP)`);
      guardFx.guardian_opening_done = true;
      monster.status_effects = guardFx;
      db.updateMonster(monster.id, { status_effects: JSON.stringify(guardFx) });
      db.updatePlayer(player.id, { hp: player.hp });
      if (player.hp <= 0) {
        playerDead = true;
        lines.push(`💀 ¡El golpe espectral te derribó! Respawneás en la entrada con 25% HP...`);
        db.addJournalEntry(player.id, 'death', `💀 Muerto por el golpe espectral de apertura del Guardia Espectral.`);
        const hcR = handlePlayerDeath(player.id, lines, 'Guardia Espectral');
        return { lines, monsterDead, playerDead, loot, poisonSurvived, ...(hcR.globalEvent ? { globalEvent: hcR.globalEvent } : {}) };
      }
    }
  }


  // DIS-834: Si la Fase 2 se activó este turno, usar el ATK anterior para el contraataque.
  // De lo contrario, el jugador recibe el boost de Fase 2 sin poder prepararse.
  const monsterAtkForCounterattack = _phase2ActivatedThisTurn ? _atkBeforePhase2 : monster.attack;
  const monsterDmg = calcDamage(monsterAtkForCounterattack);
  // DIS-852: bloodmoon rediseñado — +30% ATK proporcional para monstruos nivel 3+ (no flat +2)
  const activeEvMon = worldEvents.getCurrentEvent();
  const bloodmoonAffects = (activeEvMon && activeEvMon.id === 'bloodmoon' && activeEvMon.affectedIds && activeEvMon.affectedIds.has(monster.id));
  const bloodmoonBonus = bloodmoonAffects ? Math.floor(monsterAtkForCounterattack * (activeEvMon.atkBonus || 0.30)) : 0;
  const weatherDmgBonus = weather.getMonsterDamageBonus(); // +1 si spore_rain

  // T101: 8% de esquiva — el jugador evita el daño por completo
  // T107: Pícaro tiene +12% de esquiva extra
  // DIS-616: Si evasion_ready está activo → esquiva garantizada
  // DIS-712: Bosses avanzados (Campeón Espectral, Eco Viviente, Lich, Sombra) tienen ataques inevitables
  //          que reducen la esquiva del Pícaro al 50% (20%→10%) para crear incentivo de armadura
  const INEVITABLE_ATTACK_BOSSES = new Set([12, 13, 21, 22]); // Campeón, Lich, Eco Viviente, Sombra
  const baseRogueDodge = 0.08 + (clsData ? (clsData.dodge_bonus || 0) / 100 : 0);
  let dodgeChance;
  if (clsData && clsData.name === 'Pícaro' && INEVITABLE_ATTACK_BOSSES.has(monster.id)) {
    // Boss avanzado: reducir esquiva del Pícaro al 50%
    dodgeChance = baseRogueDodge * 0.5;
  } else {
    dodgeChance = baseRogueDodge;
  }
  const freshForEvasionCheck = db.getPlayer(player.id);
  const seForEvasion = freshForEvasionCheck.status_effects ? (typeof freshForEvasionCheck.status_effects === 'string' ? JSON.parse(freshForEvasionCheck.status_effects) : freshForEvasionCheck.status_effects) : {};
  let isEvasion = Math.random() < dodgeChance;
  let evasionWasActive = false;
  if (!isEvasion && seForEvasion.evasion_ready) {
    const evExp = seForEvasion.evasion_ready.expires_at ? new Date(seForEvasion.evasion_ready.expires_at) : null;
    if (!evExp || evExp > new Date()) {
      isEvasion = true;
      evasionWasActive = true;
    }
  }
  if (evasionWasActive) {
    // BUG-671: Consumir el buff de evasión — actualizar también player.status_effects en memoria
    // para que la escritura final (línea ~969) no sobreescriba el delete con la copia vieja del objeto player.
    delete seForEvasion.evasion_ready;
    if (player.status_effects && typeof player.status_effects === 'object') {
      delete player.status_effects.evasion_ready;
    }
    db.updatePlayer(player.id, { status_effects: JSON.stringify(seForEvasion) });
  }
  if (isEvasion) {
    const evasionMsg = evasionWasActive
      ? `💨 ¡EVASIÓN PERFECTA! Tu postura defensiva funciona — el ataque del ${monster.name} no te alcanza.`
      : `💨 ¡Esquivás el ataque del ${monster.name}! Ningún daño recibido.`;
    lines.push(evasionMsg);
  } else {
    // T145: Si el jugador está cegado, su DEF efectiva se reduce
    const freshForBlindCheck = db.getPlayer(player.id);
    const blindFx = freshForBlindCheck.status_effects ? (typeof freshForBlindCheck.status_effects === 'string' ? JSON.parse(freshForBlindCheck.status_effects) : freshForBlindCheck.status_effects) : {};
    const blindDef = blindFx.blinded ? (blindFx.blinded.amount || 0) : 0;
    // DIS-1095: piso mínimo de daño — al menos el 30% del ATK base del monstruo (mínimo 2)
    // para que el combate inicial no sea trivial incluso con defensa alta
    const minDmg = Math.max(2, Math.ceil(monsterAtkForCounterattack * 0.30));
    const rawDmgToPlayer = Math.max(minDmg, monsterDmg + bloodmoonBonus + weatherDmgBonus - Math.floor((effectiveDef || player.defense || 0) - blindDef));
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

    // DIS-724: Escudo sagrado de Bendición — absorbe hasta 10 HP de daño adicional
    const freshForBlessShield = db.getPlayer(player.id);
    const seBlessShield = freshForBlessShield.status_effects ? (typeof freshForBlessShield.status_effects === 'string' ? JSON.parse(freshForBlessShield.status_effects) : freshForBlessShield.status_effects) : {};
    const blessShield = seBlessShield.blessing_shield;
    if (blessShield && new Date(blessShield.expires_at).getTime() > Date.now() && blessShield.amount > 0) {
      const blessAbsorb = Math.min(blessShield.amount, dmgToPlayer);
      if (blessAbsorb > 0) {
        dmgToPlayer = Math.max(0, dmgToPlayer - blessAbsorb);
        blessShield.amount -= blessAbsorb;
        if (blessShield.amount <= 0) delete seBlessShield.blessing_shield;
        db.updatePlayer(player.id, { status_effects: JSON.stringify(seBlessShield) });
        // BUG-783: también actualizar player.status_effects en memoria para evitar que el save
        // final de la función sobreescriba la BD con el estado antiguo (mismo patrón BUG-671/773)
        if (player.status_effects && typeof player.status_effects === 'object') {
          if (blessShield.amount <= 0) {
            delete player.status_effects.blessing_shield;
          } else {
            player.status_effects.blessing_shield = { ...blessShield };
          }
        }
        lines.push(`🛡️ El escudo sagrado de Bendición absorbe ${blessAbsorb} de daño${blessShield.amount > 0 ? ` (${blessShield.amount} HP restantes)` : ' (agotado)'}!`);
      }
    }

    // DIS-1069: Escudo Sagrado del Sanador — absorbe hasta 25 HP del próximo golpe
    const freshForSacredShield = db.getPlayer(player.id);
    const seSacredShield = freshForSacredShield.status_effects ? (typeof freshForSacredShield.status_effects === 'string' ? JSON.parse(freshForSacredShield.status_effects) : freshForSacredShield.status_effects) : {};
    const sacredShield = seSacredShield.sacred_shield;
    if (sacredShield && new Date(sacredShield.expires_at).getTime() > Date.now() && sacredShield.amount > 0) {
      const sacredAbsorb = Math.min(sacredShield.amount, dmgToPlayer);
      if (sacredAbsorb > 0) {
        dmgToPlayer = Math.max(0, dmgToPlayer - sacredAbsorb);
        // El escudo se consume en un solo golpe — se elimina
        delete seSacredShield.sacred_shield;
        db.updatePlayer(player.id, { status_effects: JSON.stringify(seSacredShield) });
        if (player.status_effects && typeof player.status_effects === 'object') {
          delete player.status_effects.sacred_shield;
        }
        lines.push(`🛡️ ¡Tu Escudo Sagrado absorbe ${sacredAbsorb} de daño! (escudo consumido)`);
      }
    }

    player.hp = Math.max(0, player.hp - dmgToPlayer);

    const bloodmoonSuffix = bloodmoonBonus > 0 ? ` 🌑(+${bloodmoonBonus} Luna de Sangre)` : '';
    const weatherDmgSuffix = weatherDmgBonus > 0 ? ` 🍄(+${weatherDmgBonus} Esporas)` : '';
    // DIS-976: feedback visual de postura defensiva — mostrar que la postura absorbió daño
    const defensiveSuffix = (stanceName === 'defensivo' && stanceMods.defMod > 0)
      ? ` 🛡️ [defensivo +${stanceMods.defMod} DEF]` : '';
    lines.push(`🩸 ${articuloMonstruo(monster.name)} ${monster.name} te golpea y causa ${dmgToPlayer} de daño.${bloodmoonSuffix}${weatherDmgSuffix}${defensiveSuffix} (${player.hp}/${player.max_hp} HP)`);

    // DIS-616: marcar que el monstruo atacó este turno (para golpe_sombra)
    try {
      const monsterSeForGS = monster.status_effects ? (typeof monster.status_effects === 'string' ? JSON.parse(monster.status_effects) : monster.status_effects) : {};
      monsterSeForGS.attacked_player_this_turn = true;
      db.updateMonster(monster.id, { status_effects: JSON.stringify(monsterSeForGS) });
    } catch (_) {}

    // ── Posible envenenamiento del monstruo ──────────────────────────────────
    const poisonerDef = POISONERS[monster.name];
    if (poisonerDef && Math.random() < poisonerDef.chance) {
      const currentFx = player.status_effects || {};
      if (!currentFx.poisoned) {
        currentFx.poisoned = { damage: poisonerDef.damage, turns: poisonerDef.turns };
        player.status_effects = currentFx;
        lines.push(`🕷 ¡${articuloMonstruo(monster.name)} ${monster.name} te envenenó! Perderás ${poisonerDef.damage} HP por turno durante ${poisonerDef.turns} turnos. (Usá \"use antídoto\" para curarte)`);
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
        // DIS-666: verificar protección de maná sagrado (del cuenco del Eco para Clérigo)
        const seForDrain = typeof freshForMana.status_effects === 'object'
          ? freshForMana.status_effects
          : (() => { try { return JSON.parse(freshForMana.status_effects || '{}'); } catch(_) { return {}; } })();
        const manaShieldUntil = seForDrain.mana_shield_lich;
        if (manaShieldUntil && new Date(manaShieldUntil).getTime() > Date.now()) {
          const turnsLeft = seForDrain.mana_shield_turns || 0;
          lines.push(`🛡️ ¡El Lich intenta drenar tu maná, pero la bendición del cuenco lo protege! (${turnsLeft} turno${turnsLeft !== 1 ? 's' : ''} restante${turnsLeft !== 1 ? 's' : ''})`);
          // Decrementar contador de turnos
          const newTurns = turnsLeft - 1;
          if (newTurns <= 0) {
            delete seForDrain.mana_shield_lich;
            delete seForDrain.mana_shield_turns;
          } else {
            seForDrain.mana_shield_turns = newTurns;
          }
          db.updatePlayer(player.id, { status_effects: seForDrain });
        } else {
          const curMana = freshForMana.mana || 0;
          const drained = Math.min(curMana, specialDef.amount);
          db.updatePlayer(player.id, { mana: Math.max(0, curMana - drained) });
          lines.push(rawMsg + (drained < specialDef.amount ? ` (solo tenías ${curMana} maná)` : ''));
        }

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
      } else if (specialDef.type === 'atk_debuff') {
        // DIS-679: Reducir ATK del jugador por N turnos (entumecimiento espectral del Guardia Espectral)
        if (!spFx.atk_debuffed) {
          spFx.atk_debuffed = { amount: specialDef.amount, turns: specialDef.turns };
          player.status_effects = spFx;
          lines.push(rawMsg);
        }
      } else if (specialDef.type === 'item_steal') {
        // DIS-988: Goblin ÉLITE roba un ítem del inventario del jugador
        const freshForSteal = db.getPlayer(player.id);
        const stealInv = Array.isArray(freshForSteal.inventory) ? freshForSteal.inventory : [];
        // Solo robar ítems no-monedas, no-equipados
        const stealable = stealInv.filter(i =>
          i !== (freshForSteal.equipped_weapon || '') &&
          !i.toLowerCase().includes('monedas') &&
          !i.toLowerCase().includes('llave') // no robar llaves de quest
        );
        if (stealable.length > 0) {
          const stolen = stealable[Math.floor(Math.random() * stealable.length)];
          // Filtrar solo la primera ocurrencia del ítem robado
          let removed = false;
          const newInvClean = stealInv.filter(i => {
            if (!removed && i === stolen) { removed = true; return false; }
            return true;
          });
          db.updatePlayer(player.id, { inventory: newInvClean });
          // Tirar el ítem al suelo de la sala actual
          try {
            const stealRoom = db.getRoom(player.current_room_id);
            if (stealRoom) {
              db.updateRoomItems(player.current_room_id, [...stealRoom.items, stolen]);
            }
          } catch (_) {}
          lines.push(`${rawMsg} ¡Te robó: ${stolen}! (cayó al suelo de la sala)`);
        } else {
          lines.push(`🖐 El ⭐ Goblin Merodeador hurga en tu bolsa… pero no encuentra nada de valor.`);
        }
      } else if (specialDef.type === 'armor_pierce') {
        // DIS-988: Esqueleto ÉLITE ignora N DEF del jugador — daño extra por encima del ya aplicado
        const pierceAmount = specialDef.amount || 2;
        const extraPierceDmg = Math.min(pierceAmount, (effectiveDef || player.defense || 0)); // daño recuperado de la DEF ignorada
        if (extraPierceDmg > 0) {
          player.hp = Math.max(0, player.hp - extraPierceDmg);
          db.updatePlayer(player.id, { hp: player.hp });
          lines.push(`${rawMsg} (+${extraPierceDmg} daño perforante) (${player.hp}/${player.max_hp} HP)`);
        } else {
          lines.push(`💀 ¡Golpe perforante del ⭐ Esqueleto Guerrero! (sin DEF extra que ignorar)`);
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
  // DIS-679: decrementar contador de entumecimiento espectral (atk_debuffed)
  const freshForAtkTick = db.getPlayer(player.id);
  const atkFx = freshForAtkTick.status_effects
    ? (typeof freshForAtkTick.status_effects === 'string' ? JSON.parse(freshForAtkTick.status_effects) : freshForAtkTick.status_effects)
    : {};
  if (atkFx.atk_debuffed && atkFx.atk_debuffed.turns > 0) {
    atkFx.atk_debuffed.turns -= 1;
    if (atkFx.atk_debuffed.turns <= 0) {
      delete atkFx.atk_debuffed;
      lines.push(`🌡️ El entumecimiento espectral se disipa. Tu fuerza regresa.`);
    }
    db.updatePlayer(player.id, { status_effects: JSON.stringify(atkFx) });
  }

  if (player.hp <= 0) {
    // DIS-726: antes de decretar muerte, verificar autoresurrección del Clérigo nivel 10
    const hcResult2 = handlePlayerDeath(player.id, lines, `combate con ${monster.name}`);
    if (hcResult2.autoResurrected) {
      // El Clérigo sobrevivió — no marcar playerDead, no pushear mensaje de muerte normal
      // handlePlayerDeath ya pusheó los mensajes de autoresurrección en lines
    } else {
      playerDead = true;
      lines.push(`💀 ¡Moriste! Respawneás en la entrada del dungeon con 25% HP...`);
      db.addJournalEntry(player.id, 'death', `💀 Caíste en combate contra ${monster.name}.`);
      if (hcResult2.globalEvent) globalEventHardcore = hcResult2.globalEvent;
    }
  }

  // ── Huida del monstruo (< 10% HP) ────────────────────────────────────────
  // DIS-D20: los bosses con < 10% HP no pueden huir (demasiado débiles para correr)
  // DIS-D364: los bosses NO pueden huir — deben luchar hasta el final para preservar el drama del combate
  // DIS-540: reducido de 25% a 10% y de 30% a 15% — monstruos normales ya no huyen en el mid-combat
  const isBoss = !!(BOSS_MONSTERS && BOSS_MONSTERS[monster.id]);
  if (!monsterDead && !playerDead && monster.hp > 0) {
    const hpPct = monster.hp / monster.max_hp;
    if (hpPct < 0.10 && !isBoss && Math.random() < 0.15) {
      // El monstruo intenta escapar a una sala adyacente
      const room = db.getRoom(player.current_room_id);
      if (room) {
        const exits = room.exits || {};
        // Obtener IDs de salas destino (manejo de exits como objeto o {room_id, key})
        const exitEntries = Object.entries(exits)
          .map(([dir, v]) => ({ dir, room_id: typeof v === 'object' ? v.room_id : v }))
          .filter(e => e.room_id && e.room_id !== player.current_room_id);
        const destinations = exitEntries.map(e => e.room_id);
        if (destinations.length > 0) {
          const escapeIdx = Math.floor(Math.random() * exitEntries.length);
          const escapeEntry = exitEntries[escapeIdx];
          const escapeRoom = escapeEntry.room_id;
          // DIS-D295: indicar la dirección de huida para que el jugador pueda seguir al boss
          const DIR_NAMES = { norte: 'al norte', sur: 'al sur', este: 'al este', oeste: 'al oeste', arriba: 'hacia arriba', abajo: 'hacia abajo', north: 'al norte', south: 'al sur', east: 'al este', west: 'al oeste', up: 'hacia arriba', down: 'hacia abajo' };
          const dirHint = DIR_NAMES[escapeEntry.dir] || `hacia ${escapeEntry.dir}`;
          // BUG-412 FIX: guardar la sala desde donde huyó para evitar falsos positivos en el mensaje
          // "fled to adjacent room" cuando el jugador ataca un nombre que coincide con un monstruo
          // que nunca estuvo en esa sala.
          const mFxFlee = monster.status_effects
            ? (typeof monster.status_effects === 'string' ? JSON.parse(monster.status_effects) : monster.status_effects)
            : {};
          mFxFlee.fled_from = player.current_room_id;
          db.updateMonster(monster.id, { room_id: escapeRoom, status_effects: JSON.stringify(mFxFlee) });
          lines.push(`🏃 ¡${articuloMonstruo(monster.name)} ${monster.name} huye despavorido ${dirHint}! (HP: ${monster.hp}/${monster.max_hp})`);
          lines.push(`   💨 Escapó sin dejar botín. Usá "perseguir" o movete ${dirHint} para seguirlo.`);
          lines.push(`   🔄 (Los monstruos que huyen pueden volver a su sala original al regenerarse)`);
          // DIS-D355: guardar dirección de huida del monstruo para comando "perseguir"
          try {
            const scrollsRaw = db.getPlayer(player.id);
            if (scrollsRaw) {
              const scrolls = JSON.parse(scrollsRaw.active_scrolls || '{}');
              scrolls['last_flee'] = {
                dir: escapeEntry.dir,
                monster_name: monster.name,
                room_id: escapeRoom,
                expires_at: Date.now() + 3 * 60 * 1000, // 3 minutos
              };
              db.updatePlayer(player.id, { active_scrolls: JSON.stringify(scrolls) });
            }
          } catch (_) {}
        }
      }
    }
  }

  return { lines, monsterDead, playerDead, loot, poisonSurvived, ...(globalEventHardcore ? { globalEvent: globalEventHardcore } : {}) };
}

/**
 * Intento de huida del combate.
 * @param {object} player
 * @param {object} monster
 * @param {object|null} room — sala actual (para elegir sala de escape)
 * @param {string|null} preferredDirection — dirección que el jugador intentó tomar (BUG-345)
 * @returns {{ fled: boolean, line: string, destRoomId: number|null }}
 */
function tryFlee(player, monster, room, preferredDirection = null) {
  // Porcentaje de HP del monstruo
  const monsterHpPct = Math.round((monster.hp / monster.max_hp) * 100);
  const monsterHpDesc = monsterHpPct <= 25
    ? `herido de gravedad (${monsterHpPct}% HP)`
    : monsterHpPct <= 50
      ? `maltrecho (${monsterHpPct}% HP)`
      : monsterHpPct <= 75
        ? `dañado (${monsterHpPct}% HP)`
        : `casi intacto (${monsterHpPct}% HP)`;

  // DIS-453: probabilidad de huida varía según el HP del monstruo
  // Un enemigo herido está distraído con su dolor → más fácil escapar
  // DIS-470: los bosses son más difíciles de huir (−10% en todos los rangos)
  const isBossFlee = !!(BOSS_MONSTERS && BOSS_MONSTERS[monster.id]);
  let fleeChance;
  if (monsterHpPct <= 25) {
    fleeChance = isBossFlee ? 0.70 : 0.80; // muy herido → fácil huir (boss: algo menos)
  } else if (monsterHpPct <= 50) {
    fleeChance = isBossFlee ? 0.55 : 0.65; // maltrecho → bastante probable
  } else if (monsterHpPct <= 75) {
    fleeChance = isBossFlee ? 0.40 : 0.50; // dañado → base
  } else {
    fleeChance = isBossFlee ? 0.25 : 0.35; // casi intacto → difícil (boss al 100% HP: 25%)
  }

  const roll = Math.random();
  const margin = Math.abs(roll - fleeChance); // qué tan cerca estuvo

  if (roll < fleeChance) {
    // BUG-345: Usar la dirección elegida por el jugador si existe; si no, sala aleatoria
    let destRoomId = null;
    let destRoomName = null;
    let usedPreferredDir = false;
    let actualDirName = null;
    if (room) {
      const exits = room.exits || {};
      // Intentar usar la dirección preferida del jugador primero
      if (preferredDirection) {
        const normalizedDir = preferredDirection.toLowerCase().trim();
        const preferredExit = exits[normalizedDir];
        if (preferredExit !== undefined && preferredExit !== null) {
          // BUG-593: no huir por salidas con llave si el jugador no la tiene
          const exitKey = typeof preferredExit === 'object' ? preferredExit.key : null;
          const hasExitKey = exitKey
            ? (player.inventory || []).some(item => item.toLowerCase() === exitKey.toLowerCase())
            : true;
          if (hasExitKey) {
            destRoomId = typeof preferredExit === 'object' ? preferredExit.room_id : preferredExit;
            usedPreferredDir = true;
            actualDirName = normalizedDir;
          }
        }
      }
      // Si no hay dirección preferida o no existe en exits (o estaba bloqueada), elegir aleatoriamente entre salidas sin llave
      if (!destRoomId) {
        const exitEntries = Object.entries(exits)
          .map(([dir, v]) => ({ dir, id: typeof v === 'object' ? v.room_id : v, key: typeof v === 'object' ? v.key : null }))
          .filter(e => typeof e.id === 'number' && (!e.key || (player.inventory || []).some(item => item.toLowerCase() === (e.key || '').toLowerCase())));
        if (exitEntries.length > 0) {
          const chosen = exitEntries[Math.floor(Math.random() * exitEntries.length)];
          destRoomId = chosen.id;
          actualDirName = chosen.dir;
        }
      }
      if (destRoomId) {
        const destRoom = db.getRoom(destRoomId);
        destRoomName = destRoom ? destRoom.name : null;
        db.updatePlayer(player.id, { current_room_id: destRoomId });
      }
    }
    let toText = destRoomName ? ` Te refugiás en «${destRoomName}».` : '';
    // DIS-591: si la dirección real fue diferente a la solicitada, aclararlo
    if (!usedPreferredDir && preferredDirection && actualDirName && destRoomName) {
      toText += ` (huiste hacia el ${actualDirName}, no hacia el ${preferredDirection} que intentaste)`;
    }
    return {
      fled: true,
      destRoomId,
      line: `🏃 ¡Conseguís huir del ${monster.name} (${monsterHpDesc})!${toText}`,
    };
  }
  // El monstruo golpea al intentar huir
  // BUG-483: Para bosses, el daño de penalización de huida se reduce al 60%
  // del ataque base — el boss golpea pero el jugador está en movimiento, no en postura.
  // Esto previene que 3 intentos de huida = muerte garantizada contra bosses.
  const fleeAttack = isBossFlee ? Math.ceil(monster.attack * 0.6) : monster.attack;
  const monsterDmg = calcDamage(fleeAttack);
  const dmgToPlayer = Math.max(1, monsterDmg - Math.floor(player.defense || 0));
  player.hp = Math.max(0, player.hp - dmgToPlayer);
  db.updatePlayer(player.id, { hp: player.hp });

  // DIS-453: feedback narrativo sobre qué tan cerca estuvo la huida
  // DIS-470: los bosses tienen mensajes diferenciados que refuerzan su peligro
  // DIS-574: mostrar % de éxito de huida para bosses, para que el jugador pueda planificar
  const wasClose = margin < 0.15; // menos de 15% de diferencia → estuvo cerca
  let fleeNarrative;
  if (isBossFlee) {
    fleeNarrative = wasClose
      ? `${monster.name} te deja escapar... y luego te atrapa antes de que llegues a la salida.`
      : `${monster.name} te corta el paso. Un boss no deja que te vayas tan fácil.`;
  } else {
    fleeNarrative = wasClose
      ? `${articuloMonstruo(monster.name)} ${monster.name} casi te deja ir — por poco.`
      : `${articuloMonstruo(monster.name)} ${monster.name} te bloqueó sin esfuerzo.`;
  }

  let line = `🏃 Intentás huir pero ${fleeNarrative} Te golpea (${dmgToPlayer} dmg). Tu HP: ${player.hp}/${player.max_hp}.`;

  // DIS-574: para bosses, indicar el % de éxito de huida y cómo mejorarlo
  if (isBossFlee) {
    const pctActual = Math.round(fleeChance * 100);
    let nextPct = pctActual;
    if (monsterHpPct > 50) nextPct = isBossFlee ? 55 : 65;
    else if (monsterHpPct > 25) nextPct = isBossFlee ? 70 : 80;
    line += `\n💡 Chance de huida actual: ${pctActual}% (${monsterHpDesc}). Si bajás al boss a <${monsterHpPct > 50 ? '50' : '25'}% HP → ${nextPct}% de chance.`;
  }

  if (player.hp <= 0) {
    db.addJournalEntry(player.id, 'death', `💀 Muerto intentando huir del ${monster.name}.`);
    line += `\n💀 ¡Moriste! Respawneás en la entrada del dungeon con 25% HP...`;
    const hcResultFlee = handlePlayerDeath(player.id, [], 'huida');
    return { fled: false, destRoomId: null, line, playerDied: true, ...(hcResultFlee.globalEvent ? { globalEvent: hcResultFlee.globalEvent } : {}) };
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
// DIS-D421: Probabilidades por ítem para drops específicos.
// Ítems no listados aquí tienen chance 1.0 (100%).
// Reduce la trivialidad de conseguir ítems épicos del suelo.
const LOOT_CHANCES = {
  12: { // Campeón Espectral
    'lanza espectral':    0.55, // antes: 100% — ahora 55%
    'armadura de placas': 0.45, // antes: 100% — ahora 45%
  },
  9: { // Elemental de Hielo
    'cristal helado':     0.50, // antes: 100% — ahora 50%
  },
  7: { // Araña Tejedora (Pozo Sin Fondo) — DIS-455: ruta alternativa a la llave de tienda
    'llave oxidada':      0.15, // 15% — alternativa de bajo nivel a la compra (25g → 20g en tienda)
  },
  3: { // Rata Gigante — DIS-541: drop de hierba curativa para curación temprana (40%)
    'hierba curativa':    0.40, // 40% — rompe el ciclo "necesitás poción para craftear poción"
  },
  // DIS-692: reducir drop de diente afilado — Murciélagos Vampiro en 3 salas × drop frecuente = acumulación excesiva
  6:  { 'diente afilado': 0.25 }, // Murciélago Vampiro (Capilla, sala 5) — antes: 100%
  26: { 'diente afilado': 0.25 }, // Murciélago Vampiro (Sala de los Ecos, sala 3) — antes: 100%
  27: { 'diente afilado': 0.25 }, // Murciélago Vampiro (Túnel de Hongos, sala 6) — antes: 100%
};

// DIS-1007: Ítems que se entregan directamente al inventario del jugador al matar el boss,
// en lugar de quedar en el suelo de la sala. Evita que otro jugador los recoja sin combatir.
const BOSS_DIRECT_LOOT = {
  8: ['alabarda de huesos', 'peto de huesos'], // Guardia Espectral — ítems épicos de progresión
};

function dropLoot(monster, roomId, player) {
  const loot = monster.loot || [];
  const bossDef = BOSS_MONSTERS[monster.id];

  // Loot especial del boss
  const baseAllLoot = bossDef ? [...loot, ...(bossDef.lootBonus || [])] : loot;

  // DIS-D421: Aplicar probabilidades por ítem (si existen para este monstruo)
  const chances = LOOT_CHANCES[monster.id];
  let allLoot = chances
    ? baseAllLoot.filter(item => {
        const chance = chances[item];
        return chance === undefined ? true : Math.random() < chance;
      })
    : baseAllLoot;

  // BUG-908: El Espectro del Corredor (id=4) no debería dropear 'corona rota' si la trampa
  // de sala 9 ya fue desactivada (trap.active === false). El ítem pierde utilidad y acumula basura.
  if (monster.id === 4 && allLoot.includes('corona rota')) {
    const throne = db.getRoom(9);
    const trapDesactivada = throne && throne.trap && throne.trap.active === false;
    if (trapDesactivada) {
      allLoot = allLoot.filter(i => i !== 'corona rota');
    }
  }

  // DIS-1018: El Espectro del Corredor (id=4) no debería dropear 'corona rota' si el jugador
  // ya tiene una en el inventario (evita acumulación — la corona es ítem único por run).
  if (monster.id === 4 && allLoot.includes('corona rota') && player) {
    const playerInv = Array.isArray(player.inventory)
      ? player.inventory
      : JSON.parse(player.inventory || '[]');
    if (playerInv.includes('corona rota')) {
      allLoot = allLoot.filter(i => i !== 'corona rota');
    }
  }

  if (allLoot.length > 0) {
    // DIS-1007: Separar ítems directos (van al inventario del jugador) del loot de suelo.
    const directItemsForMonster = BOSS_DIRECT_LOOT[monster.id] || [];
    const directLootSet = new Set(directItemsForMonster);
    const floorLoot = allLoot.filter(i => !directLootSet.has(i));
    const directLoot = allLoot.filter(i => directLootSet.has(i));

    // Agregar al suelo solo el loot no-directo
    if (floorLoot.length > 0) {
      const room = db.getRoom(roomId);
      if (room) {
        // BUG-334: Antes de agregar nuevo loot, eliminar TODAS las copias previas de esos
        // mismos ítems del suelo. Evita acumulación cuando el jugador no recoge el loot
        // entre cycles de kill/respawn del mismo monstruo.
        const lootSet = new Set(baseAllLoot); // limpiar basado en la lista completa (no filtrada)
        const floorWithoutOldLoot = room.items.filter(i => !lootSet.has(i));
        // BUG-566: No dropear ítems que YA están en el suelo (ítems pre-placed de la sala)
        // para evitar duplicados cuando el loot_table del boss coincide con objetos del mapa
        const floorItemsSet = new Set(floorWithoutOldLoot);
        const dedupedLoot = floorLoot.filter(item => !floorItemsSet.has(item));
        const newItems = [...floorWithoutOldLoot, ...dedupedLoot];
        db.updateRoomItems(roomId, newItems);
      }
    }

    // DIS-1007: Guardar directLoot para que attackRound lo entregue al jugador
    if (directLoot.length > 0) {
      allLoot._directLoot = directLoot; // se procesa en attackRound
    }
  } else {
    var directLoot = []; // eslint-disable-line
  }

  // floorLoot = los ítems que realmente cayeron al suelo (sin los directos)
  const finalFloorLoot = allLoot.filter ? allLoot.filter(i => !(BOSS_DIRECT_LOOT[monster.id] || []).includes(i)) : allLoot;
  const finalDirectLoot = allLoot.filter ? allLoot.filter(i => (BOSS_DIRECT_LOOT[monster.id] || []).includes(i)) : [];

  // Tiempo de respawn: boss = 30 min, goblin de práctica = 30s, normal = 5 min
  // Fix DIS-004: el goblin de práctica (id=20) respawnea rápido para no bloquear el tutorial
  // DIS-742: monstruos de early game (nivel 1-2) respawnean en 3 min para evitar esperas frustrantes
  const PRACTICE_GOBLIN_ID = 20;
  const EARLY_GAME_MONSTER_IDS = new Set([1, 3, 4, 6, 7, 26, 27]); // Goblin, Rata, Espectro Corredor, Murciélagos, Araña
  let respawnAt;
  if (monster.id === PRACTICE_GOBLIN_ID) {
    respawnAt = new Date(Date.now() + 30 * 1000).toISOString(); // 30 segundos
  } else if (!bossDef && EARLY_GAME_MONSTER_IDS.has(monster.id)) {
    respawnAt = new Date(Date.now() + 3 * 60 * 1000).toISOString(); // DIS-742: 3 minutos para early game
  } else {
    const respawnMinutes = bossDef ? bossDef.respawnMinutes : 5;
    respawnAt = new Date(Date.now() + respawnMinutes * 60 * 1000).toISOString();
  }
  db.updateMonster(monster.id, {
    hp: 0,
    room_id: null,        // ya no está en ninguna sala
    respawn_at: respawnAt,
    // T221: Si era élite, restaurar stats base al morir (para que respawnee con stats normales)
    ...(monster.name.startsWith('⭐ ') && MONSTER_BASE_STATS[monster.id] ? {
      name: MONSTER_BASE_STATS[monster.id].name,
      max_hp: MONSTER_BASE_STATS[monster.id].max_hp,
      attack: MONSTER_BASE_STATS[monster.id].attack,
    } : monster.name.startsWith('⭐ ') ? {
      name: monster.name.slice(2), // quitar el prefijo ⭐ si no hay stats en el mapa
    } : {}),
  });

  const globalEvent = bossDef ? bossDef.deathAnnouncement : null;

  // DIS-922: flavor text si la Araña Tejedora (id=7) dropea la llave oxidada
  let lootNote = null;
  if (monster.id === 7 && allLoot.includes('llave oxidada')) {
    lootNote = '🕷 La llave estaba envuelta en seda, como si la araña la hubiera tomado de un aventurero anterior atrapado en su red.';
  }
  // DIS-932: flavor text para la piedra de poder del Gólem de Piedra (id=5)
  if (monster.id === 5 && allLoot.includes('piedra de poder')) {
    lootNote = '🪨 Al arrancarlo del pecho del Gólem, el constructo se desplomó en una lluvia de cascotes. El núcleo de energía pulsa en tu mano con calor telúrico.';
  }

  return { droppedLoot: finalFloorLoot, directLoot: finalDirectLoot, globalEvent, lootNote };
}

/**
 * Revisa si hay monstruos que deben respawnear y los resucita.
 * Se llama periódicamente desde el servidor.
 */
// T221: IDs de monstruos que NO pueden ser élite (maniquís y boss)
const NO_ELITE_IDS = new Set([13, 20, 21, 22]); // Lich, goblin práctica, maniquís

// DIS-D423: ATK base de bosses con fase 2 — para resetear al respawnear
const BOSS_BASE_ATTACK = {
  13: 16, // Lich Anciano (nuevo ATK base post-rebalance DIS-D423)
  22: 14, // Sombra del Vacío (nuevo ATK base post-rebalance DIS-D423)
  12: 14, // Campeón Espectral (nuevo ATK base post-rebalance DIS-D423)
  21: 10, // Eco Viviente (nuevo ATK base post-rebalance DIS-D423)
};

// DIS-D423: DEF base de bosses con fase 2 — para resetear al respawnear (fase 2 suma defBonus)
const BOSS_BASE_DEFENSE = {
  13: 0, // Lich Anciano (base DEF 0, fase 2 agrega +3)
  22: 0, // Sombra del Vacío (base DEF 0, fase 2 agrega +2)
  12: 0, // Campeón Espectral (base DEF 0)
  21: 0, // Eco Viviente (base DEF 0)
};

function checkRespawns(onBossRespawn, onAnyRespawn) {
  const now = new Date().toISOString();
  // Fix DIS-P02: usar db.getMonstersForRespawn() en lugar de raw().exec()
  let monsters;
  try {
    monsters = db.getMonstersForRespawn(now);
  } catch (e) {
    console.error('[combat] checkRespawns error al consultar:', e.message);
    return;
  }
  if (!monsters || !monsters.length) return;

  for (const m of monsters) {
    if (!m.respawn_room_id) continue;

    // T221: 15% de chance de spawnar como versión élite
    let newName = m.name;
    let newMaxHp = m.max_hp;
    let newAttack = m.attack;
    let isElite = false;
    // Limpiar nombre si ya era élite antes
    const baseNameForElite = m.name.startsWith('⭐ ') ? m.name.slice(2) : m.name;
    if (!NO_ELITE_IDS.has(m.id) && !BOSS_MONSTERS[m.id] && Math.random() < 0.15) {
      isElite = true;
      newName = `⭐ ${baseNameForElite}`;
      newMaxHp = Math.ceil(m.max_hp * 1.5);
      newAttack = m.attack + 2;
    } else {
      newName = baseNameForElite; // Asegurarse de resetear si era élite antes
    }

    db.updateMonster(m.id, {
      hp: newMaxHp,
      max_hp: newMaxHp,
      attack: BOSS_BASE_ATTACK[m.id] !== undefined ? (isElite ? BOSS_BASE_ATTACK[m.id] + 2 : BOSS_BASE_ATTACK[m.id]) : newAttack,
      // DIS-D423: restaurar DEF base al respawnear (fase 2 la modifica)
      ...(BOSS_BASE_DEFENSE[m.id] !== undefined ? { defense: BOSS_BASE_DEFENSE[m.id] } : {}),
      name: newName,
      room_id: m.respawn_room_id,
      respawn_at: null,
      status_effects: '{}', // T110: limpiar efectos de veneno al respawnear (incl. phase2_triggered — DIS-D423)
    });
    if (isElite) {
      console.log(`[combat] Respawn ÉLITE: ${newName} en sala ${m.respawn_room_id} (HP:${newMaxHp} ATK:${newAttack})`);
    } else {
      console.log(`[combat] Respawn: ${newName} en sala ${m.respawn_room_id}`);
    }
    // T220: Notificar respawn del boss
    if (BOSS_MONSTERS[m.id] && typeof onBossRespawn === 'function') {
      try { onBossRespawn(m.id, m.name, m.respawn_room_id); } catch (_) {}
    }
    // DIS-691: Al respawnear el Lich (id 13), resetear cycle_start_at para todos los jugadores
    // que tienen un lich_kills > 0 (están en ciclo post-endgame). Los nuevos ya lo tienen del onboarding.
    if (m.id === 13) {
      try {
        const allPlayerIds = db.getAllPlayerIds ? db.getAllPlayerIds() : [];
        const nowIso = new Date().toISOString();
        for (const p of allPlayerIds) {
          db.updatePlayer(p.id, { cycle_start_at: nowIso });
        }
        console.log(`[combat] DIS-691: cycle_start_at reseteado para ${allPlayerIds.length} jugadores (Lich respawneó).`);
      } catch (e) {
        console.warn('[combat] DIS-691: no se pudo resetear cycle_start_at:', e.message);
      }
    }
    // DIS-D37: Al respawnear el boss, limpiar el loot acumulado en el suelo de su sala.
    // La Catedral de la Oscuridad (sala 15) acumula ítems de kills anteriores si nadie los recoge.
    // Narrativamente: "La oscuridad engulle los restos antes de que el Lich regrese."
    // BUG-321: Extender a todos los monstruos: al respawnear, quitar sus propios ítems del suelo
    // para evitar acumulación duplicada si el jugador no recogió el loot anterior.
    try {
      if (BOSS_MONSTERS[m.id]) {
        // Boss: limpiar TODO el suelo (puede haber drops de combate previo también)
        db.updateRoomItems(m.respawn_room_id, []);
      } else if (m.loot && m.loot.length > 0) {
        // Monstruo normal: remover TODAS las copias de sus ítems de loot del suelo
        // BUG-334: usar filter (remover todas) en lugar de indexOf (remover solo una)
        const mLoot = Array.isArray(m.loot) ? m.loot : JSON.parse(m.loot || '[]');
        const room = db.getRoom(m.respawn_room_id);
        if (room && room.items && room.items.length > 0) {
          const mLootSet = new Set(mLoot);
          const floorItems = room.items.filter(i => !mLootSet.has(i));
          if (floorItems.length !== room.items.length) {
            db.updateRoomItems(m.respawn_room_id, floorItems);
          }
        }
      }
    } catch (_) {}
    // T223: Notificar respawn de cualquier monstruo (para tracking)
    if (typeof onAnyRespawn === 'function') {
      try { onAnyRespawn(m.id, baseNameForElite, m.respawn_room_id, isElite); } catch (_) {}
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// T203: Monstruos errantes — algunos monstruos se mueven periódicamente
// ══════════════════════════════════════════════════════════════════════════════

/**
 * IDs de monstruos que deambulan por el dungeon.
 * Goblin Merodeador (1) y Rata Gigante (3) son criaturas inquietas.
 * Se mueven a una sala adyacente aleatoria cuando están vivos y no hay jugadores
 * en su sala actual (para no interrumpir combates activos).
 */
const WANDERING_MONSTER_IDS = new Set([1, 3]);

/**
 * Mueve los monstruos errantes a una sala adyacente aleatoria.
 * Callback opcional recibe (monsterId, monsterName, fromRoomId, toRoomId)
 * para que el servidor pueda notificar a los jugadores en ambas salas.
 * @param {Function} [onMove] — callback(monsterId, monsterName, fromRoomId, toRoomId)
 */
function wanderMonsters(onMove) {
  for (const mId of WANDERING_MONSTER_IDS) {
    try {
      const monster = db.getMonster(mId);
      // Solo si está vivo (room_id no nulo)
      if (!monster || monster.room_id === null || monster.room_id === undefined) continue;

      const currentRoom = db.getRoom(monster.room_id);
      if (!currentRoom) continue;

      // No mover si hay jugadores en la sala (podría interrumpir combate)
      const playersInRoom = db.getPlayersInRoom(monster.room_id);
      if (playersInRoom && playersInRoom.length > 0) continue;

      // Obtener salas adyacentes válidas (no sala tutorial, no sala de práctica, no casa de subastas)
      // DIS-1135: excluir salas de bajo nivel (1 y 2) para monstruos vagabundos — evitar que
      // la Rata Gigante wanderee al Corredor de las Sombras junto al Goblin
      const EXCLUDED_ROOMS = new Set([1, 2, 15, 16, 17, 18, 21, 22]); // entrada, corredor, catedral boss, tutorial, subastas, fuente, práctica, cripta

      // BUG-502: excluir salas que son respawn_room_id de monstruos no vagabundos
      // (p. ej. sala 5 = Capilla Olvidada es el respawn del murciélago vampiro de la quest)
      try {
        const allMonsters = db.getAllMonsters();
        for (const m of allMonsters) {
          if (!WANDERING_MONSTER_IDS.has(m.id) && m.respawn_room_id != null) {
            EXCLUDED_ROOMS.add(Number(m.respawn_room_id));
          }
        }
      } catch (e) {
        console.error('[wander] Error obteniendo monstruos para excluir salas de quest:', e.message);
      }

      const exits = currentRoom.exits || {};
      const adjacentRoomIds = Object.values(exits)
        .map(v => typeof v === 'object' ? v.room_id : v)
        .filter(id => id && !EXCLUDED_ROOMS.has(id));

      if (adjacentRoomIds.length === 0) continue;

      // Elegir sala aleatoria
      const targetRoomId = adjacentRoomIds[Math.floor(Math.random() * adjacentRoomIds.length)];
      if (targetRoomId === monster.room_id) continue;

      const fromRoomId = monster.room_id;
      db.updateMonster(mId, { room_id: targetRoomId });
      console.log(`[wander] ${monster.name} se mueve de sala ${fromRoomId} → sala ${targetRoomId}`);

      if (onMove) {
        onMove(mId, monster.name, fromRoomId, targetRoomId);
      }
    } catch (e) {
      console.error(`[wander] Error moviendo monstruo ${mId}:`, e.message);
    }
  }
}

module.exports = {
  attackRound,
  tryFlee,
  findMonsterInRoom,
  checkRespawns,
  wanderMonsters,
  handlePlayerDeath,
  dropLoot,
  WANDERING_MONSTER_IDS,
  BOSS_MONSTERS,
  MONSTER_SPECIALS,
};
