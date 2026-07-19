/**
 * server/index.js — Entry point de Dungeon of Echoes
 */

'use strict';

const express = require('express');
const cors    = require('cors');
const http    = require('http');
const path    = require('path');

const db                     = require('./db/db');
const { seedIfEmpty, migrateAuctionRoom, migrateFountainRoom, migrateEchoRooms, migrateTrainingRoom, migrateArmorLoot, migrateScrollLoot, migrateCryptRoom, migrateTrainingRoomAccess, migrateCraftingLoot, migrateMerchantRoom, migrateNarrativeLore, migrateBossStats, migrateIceFragmentLoot, migratePistaSantuario, migrateD46MonsterBalance, migrateManaLoot, migrateFountainConnections, migrateBossRebalance, migrateForjaHeatWarning, migratePrisonContent, migrateRestoreGoblinTutorial, migrateExtraBats, migrateEarlyEconomy, migratePassiveAuctions, migratePrisonConnection, migrateGuardiaEspectralHP, migrateGolemPiedraHP, migrateCampeonEspectralLoot, migrateColiseoEcoConnection, migrateFixEcoConnectionDuplicates, migrateGuardiaEspectralHP2, migrateEcoColiseoReturn, migrateGolemForjaHP, migratePetoHuesosFixID, migrateBatStatsReset, migrateLichHPRebalance, migrateSombraVacioHP, migrateAbismoLootFix, migrateHongoAzulSala6, migrateBossHPFullReset, migrateLichHPDIS794, migrateCatedralBagDIS793, migrateFuenteEternaDIS801, migrateSombraVacioHPDIS807, migrateSombraLootDIS813, migratePozo820, migrateFixStuckPassiveAuctions, migrateCoronaRotaPrison985, migrateFixCorruptStatusEffects992, migrateCleanPrisonEpicLoot1007, migrateMerchantHintDIS1005, migrateGaleriaHieloCuracionDIS1035, migratePistaSantuarioTrapasDIS1038, migrateEconomyRebalanceDIS1043, migratePracticaHintDIS1041, migrateCleanPistaSantuarioBUG1047, migrateGolemPiedraDIS1105, migrateCorredorHintDIS1107, migrateSanctuarioQuoteDIS1108, migrateRemoveCoronaSala9DIS1190, migrateSecondGoblinDIS1202, migrateEspectroHPDIS1203, migrateEntradaCriptaDIS1213, migrateGoblinATKDIS1316, migrateEarlyGameATKDIS1324, migrateCapillaHongoHintDIS1430, migrateFixCryptExitBUG1447, migratePozoPistaDIS1453, migrateHachaRusticaBUG1471, migrateCleanCatedralEpicLootBUG1474, migrateTrollForjaDIS1481, migratePozoDescDIS1562, migrateEcosHubDescDIS1584, migrateQuestGoblinDIS1590, migrateQuestPurgaOrdenDIS1605, migrateQuestRitualOscuridadBUG1654, migrateOrphanedGuildsBUG1646, migrateCapillaInscripcionBUG1682, migrateHongoAzulCapillaDIS1745 } = require('./db/seed');
const { execute, getOrCreatePlayer, ROOM_EFFECTS, resolveExpiredAuctions } = require('./game/engine');
const { checkRespawns, wanderMonsters } = require('./game/combat');
const quests                 = require('./game/quests');
const worldEvents            = require('./game/worldEvents');
const weather                = require('./game/weather');
const eventScheduler         = require('./game/eventScheduler'); // T-1225: scheduler de eventos cíclicos
const auctionNPC             = require('./game/auctionNPC');      // DIS-1482: bots NPC en la Casa de Subastas
const { registerHandlers, playerSockets, previousRoomMap, monsterTrackMap } = require('./socket/handlers');

const PORT = process.env.PORT || 3000;
const SERVER_START = Date.now(); // T119: uptime del servidor

async function main() {
  // 1. Inicializar base de datos
  await db.init();
  seedIfEmpty();
  migrateAuctionRoom();
  migrateFountainRoom();
  migrateEchoRooms();
  migrateTrainingRoom();
  migrateArmorLoot(); // T152
  migrateScrollLoot(); // T153
  migrateCryptRoom(); // T179
  migrateTrainingRoomAccess(); // DIS-P11: sala 21 accesible desde sala 1 via down/bajar
  migrateCraftingLoot(); // DIS-P10: garra de esqueleto en Esqueleto Guerrero + diente en Murciélago
  migrateMerchantRoom(); // DIS-D08: mover Esqueleto Guerrero fuera de sala del mercader (sala 4 → sala 3)
  migrateNarrativeLore(); // STORY-003/004/005/007/012/017: lore narrativo y pistas del Lich
  migrateBossStats(); // BUG-046: restaurar stats del Lich Anciano si max_hp < 30
  migrateIceFragmentLoot(); // DIS-D34: fragmento de hielo en loot del Elemental de Hielo
  migratePistaSantuario(); // DIS-D42: pista de ruta alternativa en Pozo Sin Fondo
  migrateD46MonsterBalance(); // DIS-D46: rebalancear curva de dificultad en zonas avanzadas
  migrateManaLoot(); // DIS-D296: pociones de maná en loot de Goblin Merodeador y Murciélago Vampiro
  migrateFountainConnections(); // DIS-D368: conectar Fuente Eterna (18) con Abismo Eterno (20) vía arriba/abajo
  migrateBossRebalance(); // DIS-D423: subir HP/ATK de bosses finales para combate menos trivial
  migrateForjaHeatWarning(); // DIS-D424: agregar advertencia de daño por calor en descripción de la Forja
  migratePrisonContent(); // DIS-D425: Prisión Subterránea — descripción + sello del carcelero + loot del Guardia Espectral
  migrateRestoreGoblinTutorial(); // BUG-447: restaurar Goblin de Práctica a sala 16 si huyó antes del fix de BUG-430
  migrateExtraBats(); // DIS-510: distribuir Murciélagos Vampiro en 3 salas (Capilla, Ecos, Hongos)
  migrateEarlyEconomy(); // DIS-534 + DIS-541: mejorar drops de oro temprano y acceso a hierba curativa
  migratePassiveAuctions(); // DIS-535: mercado pasivo — columna is_passive en auctions
  migratePrisonConnection(); // DIS-538: conectar Prisión (8) ↔ Casa de Subastas (17)
  migrateGuardiaEspectralHP(); // DIS-598: subir HP del Guardia Espectral 25→40
  migrateGuardiaEspectralHP2(); // DIS-679: subir HP del Guardia Espectral 40→55 + entumecimiento espectral
  migrateGolemPiedraHP(); // DIS-630: subir HP del Gólem de Piedra 35→55 + resistencia física ×0.75
  migrateCampeonEspectralLoot(); // DIS-648: Campeón Espectral dropea cristal resonante en vez de lanza espectral
  migrateColiseoEcoConnection(); // DIS-652: Coliseo(14)→Eco(19)→Catedral(15), no bypass directo
  migrateFixEcoConnectionDuplicates(); // BUG-659/660: quitar salidas duplicadas north/south→Catedral en salas 19 y 15
  migrateEcoColiseoReturn(); // BUG-682: Eco(19) west→14(Coliseo) — conexión faltante
  migrateGolemForjaHP(); // DIS-688: Golem de Forja HP 42→55 + resistencia de fuego ×0.80
  migratePetoHuesosFixID(); // DIS-689: peto de huesos removido de Murciélago Vampiro (id bug), asignado a Guardia Espectral (id 8)
  migrateBatStatsReset(); // BUG-697: resetear stats inflados de Murciélagos Vampiro id 26/27 por bug de élite acumulativo
  migrateLichHPRebalance(); // DIS-701: Lich Anciano HP 100 → 90 para aliviar curva del Mago
  migrateSombraVacioHP(); // DIS-729: Sombra del Vacío HP 90 → 120, boss secreto más desafiante
  migrateAbismoLootFix(); // DIS-730: Remover ítems pre-placed del Abismo Eterno (loot solo del boss)
  migrateHongoAzulSala6(); // DIS-748: Restaurar hongo azul en Túnel de los Hongos si no está en el suelo
  migrateBossHPFullReset(); // BUG-731: Restaurar HP completo de bosses vivos post-migración (evita sesiones con HP herido persistente)
  migrateLichHPDIS794(); // DIS-794: Lich Anciano HP 90 → 110 para que Guerrero nivel 8 no lo trivialice en 3 turnos
  migrateCatedralBagDIS793(); // DIS-793: bolsa de lona pre-placed en Catedral para que el jugador pueda expandir inventario antes del Lich
  migrateFuenteEternaDIS801(); // DIS-801: conectar Fuente Eterna (18) con Sala del Trono (9) — evitar dead-end
  migrateSombraVacioHPDIS807(); // DIS-807: Sombra del Vacío HP 120→140 + Oscuridad Paralizante garantizada en turno 1
  migrateSombraLootDIS813(); // DIS-813: cristal resonante removido del loot de la Sombra (evita duplicado con Campeón)
  migratePozo820(); // DIS-820: limpiar ítems pre-placed de sala 7 que duplican loot de la Araña Tejedora
  migrateFixStuckPassiveAuctions(); // BUG-946: cerrar subastas pasivas stuck por regex de fecha incorrecta y pagar al vendedor
  migrateCoronaRotaPrison985(); // DIS-985: agregar corona rota en Prisión (sala 8) para evitar trampa inevitable en Sala del Trono
  migrateFixCorruptStatusEffects992(); // BUG-992: limpiar status_effects corruptos (contenían objeto jugador completo)
  migrateCleanPrisonEpicLoot1007(); // DIS-1007: limpiar ítems épicos pre-placed en Prisión (sala 8) — ahora se dropean directo al matar boss
  migrateMerchantHintDIS1005(); // DIS-1005: mejorar descripción de sala 3 y 4 para que quede claro que Aldric está en la Cámara del Tesoro
  migrateGaleriaHieloCuracionDIS1035(); // DIS-1035: agregar hierba curativa en Galería de Hielo (sala 11) como curación intermedia antes del Golem de Forja
  migratePistaSantuarioTrapasDIS1038(); // DIS-1038: actualizar pista de ruta alternativa al Santuario con advertencia de trampas
  migrateEconomyRebalanceDIS1043(); // DIS-1043: rebalanceo económico early game (Rata/Murciélago plata, Guardia+oro, guild 20g)
  migratePracticaHintDIS1041(); // DIS-1041: hint de Sala de Práctica en descripción de sala 1 (Entrada)
  migrateCleanPistaSantuarioBUG1047(); // BUG-1047: limpiar duplicados de pista en sala 7 (Pozo Sin Fondo)
  migrateGolemPiedraDIS1105(); // DIS-1105: Gólem de Piedra HP 55→70 para que sea genuinamente peligroso nivel 5+
  migrateCorredorHintDIS1107(); // DIS-1107: descripción sala 2 incluye hint permanente al mercader al norte
  migrateSanctuarioQuoteDIS1108(); // DIS-1108: descripción sala 10 incluye quote permanente "la estatua no te mira — te cataloga"
  migrateRemoveCoronaSala9DIS1190(); // DIS-1190: eliminar corona rota del suelo estático de sala 9 (Sala del Trono) — ya disponible en sala 8 y como drop del Espectro
  migrateSecondGoblinDIS1202(); // DIS-1202: agregar Goblin Explorador (id 28) en sala 2 para desbloquear quest "Exterminador de Goblins" (2/2)
  migrateEspectroHPDIS1203(); // DIS-1203: subir HP del Espectro del Corredor 18→45 para que aguante 2-3 hits con equipo épico temprano
  migrateEntradaCriptaDIS1213(); // DIS-1213: reemplazar descripción vaga "oscuridad al norte y al este" por descripción orientativa con destinos nombrados
  migrateGoblinATKDIS1316(); // DIS-1316: subir ATK del Goblin Merodeador 3→4 para añadir tensión early game para Guerrero
  migrateEarlyGameATKDIS1324(); // DIS-1324: early game sin tensión — Goblin 4→5, Rata 2→3, Murciélagos 3→4
  migrateCapillaHongoHintDIS1430(); // DIS-1430: hint en descripción de Capilla Olvidada sobre hongo azul al norte
  migrateFixCryptExitBUG1447(); // BUG-1447: corregir salida asimétrica de Cripta de los Valientes (norte→arriba)
  migratePozoPistaDIS1453(); // DIS-1453: simplificar pista de ruta alternativa en Pozo Sin Fondo — sin spoilear trampas
  migrateHachaRusticaBUG1471(); // BUG-1471: agregar hacha rústica al loot del Goblin Merodeador — desafío diario "El Hacha y la Sala" era imposible
  migrateCleanCatedralEpicLootBUG1474(); // BUG-1474: remover ítems épicos pre-placed en Catedral (sala 15) — duplicaban loot del Lich
  migrateTrollForjaDIS1481(); // DIS-1481: agregar Troll de las Cavernas (id 29) en sala 12 — nuevo monstruo con regeneración
  migratePozoDescDIS1562();   // DIS-1562: cerrar dead end de la cuerda en Pozo Sin Fondo — reemplazar "¿Qué habrá abajo?" con inscripción de closure
  migrateEcosHubDescDIS1584(); // DIS-1584: Sala de los Ecos (sala 3) — descripción con señales sensoriales de hub (frío oeste, calor este, humedad sur)
  migrateQuestGoblinDIS1590(); // DIS-1590: Quest "La Caza del Merodeador" → "La Caza en el Corredor" — nombre y desc actualizados para reflejar que acepta cualquier goblin del Corredor
  migrateQuestPurgaOrdenDIS1605(); // DIS-1605: Quest faccion_orden_filo_purga → caza de espectros (target_type=espectro, count=3)
  migrateQuestRitualOscuridadBUG1654(); // BUG-1654: Quest "Ritual en la Oscuridad" era type=explore — cambiado a type=ritual, trigger=pray
  migrateOrphanedGuildsBUG1646(); // BUG-1646/1647: limpiar guilds con leader_id inválido — disolver vacías, promover miembro en las que tienen integrantes
  migrateCapillaInscripcionBUG1682(); // BUG-1682: restaurar hint "examine inscripcion" en Capilla Olvidada (DIS-1430 lo sobreescribía)
  migrateHongoAzulCapillaDIS1745(); // DIS-1745: garantizar hongo azul en suelo de Capilla Olvidada para resolver catch-22 trampa de esporas
  // IMPL-WM-1711: asegurar que las Misiones de Guerra de la semana actual existan al arrancar
  try { db.ensureWarMissionsForWeek(); console.log('[index] IMPL-WM-1711: Misiones de Guerra de la semana aseguradas. ✓'); } catch (e) { console.error('[index] Error en ensureWarMissionsForWeek:', e.message); }

  // 2. Crear app Express
  const app = express();
  app.use(cors());
  app.use(express.json());

  // 3. Servir archivos estáticos del cliente
  app.use(express.static(path.join(__dirname, '../client')));

  // 4. Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'OK', game: 'Dungeon of Echoes', version: '0.6.0' });
  });

  // ─── Rutas del juego (API simple, sin Socket.io aún) ───────────────────────

  /**
   * POST /api/login
   * Body: { username: string }
   * Crea o recupera un jugador y devuelve su estado.
   */
  app.post('/api/login', (req, res) => {
    const { username, class: requestedClass } = req.body;
    if (!username || typeof username !== 'string' || !username.trim()) {
      return res.status(400).json({ error: 'Se requiere un username.' });
    }
    const player = getOrCreatePlayer(username.trim().slice(0, 20));
    // BUG-481: Si se pasa class y el jugador aún no tiene clase, aplicarla automáticamente
    if (requestedClass && typeof requestedClass === 'string') {
      const freshP = db.getPlayer(player.id);
      if (!freshP.player_class || freshP.player_class === 'sin_clase') {
        execute(player.id, `clase ${requestedClass.trim()}`);
      }
    }
    // Auto-look al entrar
    const lookResult = execute(player.id, 'look');
    res.json({ player_id: player.id, username: player.username, welcome: lookResult.text });
  });

  /**
   * POST /api/command
   * Body: { player_id: string, command: string }
   * Ejecuta un comando y devuelve el resultado.
   */
  app.post('/api/command', (req, res) => {
    const { player_id, command } = req.body;
    if (!player_id || !command) {
      return res.status(400).json({ error: 'Se requiere player_id y command.' });
    }
    // BUG-346: Inicializar sessionDataMap on-the-fly para que 'session' funcione via HTTP
    const { sessionDataMap } = require('./socket/handlers');
    if (!sessionDataMap.has(player_id)) {
      const freshP = db.getPlayer(player_id);
      sessionDataMap.set(player_id, {
        startTime: Date.now(),
        kills: 0,
        xpStart: freshP ? (freshP.xp || 0) : 0,
        goldStart: freshP ? (freshP.gold || 0) : 0,
        commands: 0,
      });
    }
    const context = {
      sessionData: sessionDataMap.get(player_id) || null,
      sessionDataMap,
    };
    const sessData = sessionDataMap.get(player_id);
    const result = execute(player_id, command, context);
    if (sessData) {
      sessData.commands++;
      if (result.sessionKill) sessData.kills++;
    }
    // BUG-1022: Si el resultado es una ascensión, buscar el nuevo personaje
    // y devolver su player_id al cliente para que pueda re-autenticarse.
    if (result.ascension === true && result.newUsername) {
      const newPlayer = db.getPlayerByUsername(result.newUsername);
      return res.json({
        result: result.text,
        ascension: true,
        new_player_id: newPlayer ? newPlayer.id : null,
      });
    }
    res.json({ result: result.text });
  });

  /**
   * GET /api/state/:player_id
   * Devuelve el estado completo del jugador como JSON estructurado (para LLMs).
   */
  app.get('/api/state/:player_id', (req, res) => {
    const player = db.getPlayer(req.params.player_id);
    if (!player) return res.status(404).json({ error: 'Jugador no encontrado.' });

    const room     = db.getRoom(player.current_room_id);
    const monsters = db.getMonstersInRoom(player.current_room_id);
    const others   = db.getPlayersInRoom(player.current_room_id)
                       .filter(p => p.id !== player.id)
                       .map(p => `${p.username} (HP: ${p.hp}/${p.max_hp})`);
    const events   = db.getRecentEvents(player.current_room_id, 5)
                       .map(e => e.result);

    // DIS-D329: map_summary — salas adyacentes con info de peligro para sidebar persistente
    const mapSummary = [];
    const exits = room.exits || {};
    for (const [dir, target] of Object.entries(exits)) {
      const adjRoomId = typeof target === 'object' ? target.room_id : target;
      if (!adjRoomId) continue;
      const adjRoom = db.getRoom(adjRoomId);
      if (!adjRoom) continue;
      const adjMonsters = db.getMonstersInRoom(adjRoomId).filter(m => m.hp > 0);
      mapSummary.push({
        direction: dir,
        room_id: adjRoomId,
        name: adjRoom.name,
        monsters: adjMonsters.map(m => ({ name: m.name, hp: m.hp, max_hp: m.max_hp })),
        danger: adjMonsters.length > 0 ? (adjMonsters.some(m => m.max_hp >= 50) ? 'alta' : 'media') : 'ninguno',
        locked: typeof target === 'object' && target.key ? true : false,
      });
    }

    // BUG-1048b: alias 'creatures' para compatibilidad con clientes que usen ese nombre
    const monsterList = monsters.map(m => ({ name: m.name, hp: m.hp, max_hp: m.max_hp }));
    res.json({
      room: {
        id: room.id,
        name: room.name,
        description: room.description,
        exits: Object.keys(room.exits),
        monsters: monsterList,
        creatures: monsterList, // alias de monsters — ambos son equivalentes
        items: room.items,
        trap: room.trap ? { active: room.trap.active, type: room.trap.type } : null,
        room_effect: ROOM_EFFECTS[room.id] ? { label: ROOM_EFFECTS[room.id].label, type: ROOM_EFFECTS[room.id].type } : null,
      },
      player: {
        id: player.id,
        username: player.username,
        hp: player.hp,
        max_hp: player.max_hp,
        attack: player.attack,
        defense: player.defense,
        inventory: player.inventory,
        level: player.level || 1,
        xp: player.xp || 0,
        kills: player.kills || 0,
        equipped_weapon: player.equipped_weapon || null,
        equipped_armor: player.equipped_armor || null,
        pending_messages: db.countPendingMessages(player.id),
        status_effects: player.status_effects || {},
        gold: player.gold || 0,
        achievements: JSON.parse(player.achievements || '[]'),
        mana: player.mana != null ? player.mana : 20,
        max_mana: player.max_mana || 20,
        shield_active: player.shield_active || 0,
        player_class: player.player_class || 'sin_clase',
        class_name: player.player_class || 'sin_clase',  // DIS-D305: alias para compatibilidad
        specialization: player.specialization || null,
        playtime_minutes: player.playtime_minutes || 0,
        reputation: player.reputation || 0,  // DIS-1319: exponer reputación en /api/state
        run_event: player.run_event || null,  // IMPL-VV-1760: exponer evento del run en /api/state
        run_seed: player.run_seed || null,    // IMPL-VV-1760: exponer semilla del run
      },
      other_players: others,
      recent_events: events,
      map_summary: mapSummary,
      party: player.party_id
        ? db.getPartyMembers(player.party_id)
            .filter(m => m.id !== player.id)
            .map(m => ({ username: m.username, hp: m.hp, max_hp: m.max_hp, level: m.level || 1 }))
        : null,
    });
  });

  /**
   * GET /api/players/online
   * Lista jugadores que estuvieron activos en los últimos 5 minutos.
   * Útil para que LLMs y clientes puedan mostrar quién está conectado.
   */
  app.get('/api/players/online', (req, res) => {
    // SQLite datetime('now') usa formato 'YYYY-MM-DD HH:MM:SS' (sin T ni Z)
    const cutoffDate = new Date(Date.now() - 5 * 60 * 1000);
    const cutoff = cutoffDate.toISOString().replace('T', ' ').split('.')[0];
    const activePlayers = db.getActivePlayers(cutoff);
    res.json({
      count: activePlayers.length,
      players: activePlayers.map(p => ({
        username: p.username,
        hp: p.hp,
        max_hp: p.max_hp,
        room: p.room_name || `sala #${p.current_room_id}`,
        last_seen: p.last_seen,
      })),
    });
  });

  /**
   * GET /api/leaderboard
   * Devuelve la tabla de líderes global (top 10 por kills, luego XP).
   * Útil para que clientes externos y LLMs consulten el ranking.
   * BUG-1052: ahora filtra bots de playtest igual que el comando in-game 'score'.
   *   Pasar ?bots=true para incluirlos.
   */
  app.get('/api/leaderboard', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
    const includeBots = req.query.bots === 'true';
    // BUG-1247: el filtro de bots ahora se hace en la query (is_bot = 0 en db.getLeaderboard).
    // Para includeBots=true, usamos db.getLeaderboardAll que no filtra is_bot.
    const rawLeaders = includeBots ? db.getLeaderboardAll(limit) : db.getLeaderboard(limit);
    res.json({
      count: rawLeaders.length,
      leaderboard: rawLeaders.map((p, idx) => ({
        rank: idx + 1,
        username: p.username,
        level: p.level || 1,
        xp: p.xp || 0,
        kills: p.kills || 0,
        // DIS-1536: HP omitido — no aporta contexto útil en el ranking histórico.
        // Un jugador con HP baja puede ser una cuenta inactiva, no alguien "casi muerto".
      })),
    });
  });

  /**
   * GET /api/room/:id
   * Devuelve el estado completo de una habitación (para LLMs y clientes).
   * Incluye monstruos, ítems, salidas y jugadores presentes.
   */
  app.get('/api/room/:id', (req, res) => {
    const roomId = parseInt(req.params.id, 10);
    if (isNaN(roomId)) {
      return res.status(400).json({ error: 'ID de habitación inválido.' });
    }
    const room = db.getRoom(roomId);
    if (!room) {
      return res.status(404).json({ error: `Habitación ${roomId} no encontrada.` });
    }
    const monsters = db.getMonstersInRoom(roomId);
    const players  = db.getPlayersInRoom(roomId);

    res.json({
      id: room.id,
      name: room.name,
      description: room.description,
      exits: room.exits,
      items: room.items,
      monsters: monsters.map(m => ({
        id: m.id,
        name: m.name,
        hp: m.hp,
        max_hp: m.max_hp,
        attack: m.attack,
      })),
      players: players.map(p => ({
        username: p.username,
        hp: p.hp,
        max_hp: p.max_hp,
        level: p.level || 1,
      })),
    });
  });

  // ─── Admin endpoints (T072 — persistencia de BD) ──────────────────────────

  /**
   * GET /api/admin/db-export
   * Descarga la BD SQLite actual como archivo binario.
   * Protegido por ADMIN_TOKEN env var. Útil para backup manual antes de reinicios.
   * curl -H "Authorization: Bearer <token>" https://tu-server/api/admin/db-export > dungeon.sqlite
   */
  app.get('/api/admin/db-export', (req, res) => {
    const adminToken = process.env.ADMIN_TOKEN;
    if (adminToken) {
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (token !== adminToken) {
        return res.status(401).json({ error: 'Unauthorized. Provide: Authorization: Bearer <ADMIN_TOKEN>' });
      }
    }
    try {
      const data = db.raw().export();
      const buf = Buffer.from(data);
      res.set('Content-Type', 'application/octet-stream');
      res.set('Content-Disposition', `attachment; filename="dungeon-${Date.now()}.sqlite"`);
      res.set('Content-Length', buf.length);
      res.send(buf);
      console.log('[admin] DB exportada via /api/admin/db-export');
    } catch (err) {
      res.status(500).json({ error: 'Error al exportar BD: ' + err.message });
    }
  });

  /**
   * GET /api/stats — Estadísticas públicas del servidor (T119)
   */
  app.get('/api/stats', (req, res) => {
    try {
      // BUG-1642-follow: usar formato SQLite (YYYY-MM-DD HH:MM:SS) para comparar contra last_seen
      const cutoff5min = new Date(Date.now() - 5 * 60 * 1000).toISOString().replace('T', ' ').split('.')[0];
      const totalPlayers = db.raw().exec('SELECT COUNT(*) as cnt FROM players')[0];
      const activePlayers = db.raw().exec(
        `SELECT COUNT(*) as cnt FROM players WHERE last_seen >= '${cutoff5min}'`
      )[0];
      const totalKills = db.raw().exec('SELECT SUM(kills) as s FROM players')[0];
      const totalGold = db.raw().exec('SELECT SUM(gold) as s FROM players')[0];
      const activeMonsters = db.raw().exec('SELECT COUNT(*) as cnt FROM monsters WHERE room_id IS NOT NULL')[0];
      const uptimeSec = Math.floor((Date.now() - SERVER_START) / 1000);
      const uptimeMin = Math.floor(uptimeSec / 60);
      const uptimeHrs = Math.floor(uptimeMin / 60);

      res.json({
        players_total:   totalPlayers   ? totalPlayers.values[0][0]   : 0,
        players_online:  activePlayers  ? activePlayers.values[0][0]  : 0,
        kills_total:     totalKills     ? (totalKills.values[0][0] || 0)     : 0,
        gold_in_economy: totalGold      ? (totalGold.values[0][0] || 0)      : 0,
        monsters_active: activeMonsters ? activeMonsters.values[0][0] : 0,
        uptime_seconds:  uptimeSec,
        uptime_human:    uptimeHrs > 0
          ? `${uptimeHrs}h ${uptimeMin % 60}m`
          : `${uptimeMin}m ${uptimeSec % 60}s`,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/admin/stats
   * Estadísticas del servidor: jugadores totales, monstruos, salas, etc.
   * Protegido por ADMIN_TOKEN env var.
   */
  app.get('/api/admin/stats', (req, res) => {
    const adminToken = process.env.ADMIN_TOKEN;
    if (adminToken) {
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (token !== adminToken) {
        return res.status(401).json({ error: 'Unauthorized.' });
      }
    }
    const players = db.raw().exec('SELECT COUNT(*) as cnt FROM players')[0];
    const rooms   = db.raw().exec('SELECT COUNT(*) as cnt FROM rooms')[0];
    const monsters = db.raw().exec('SELECT COUNT(*) as cnt FROM monsters')[0];
    const events  = db.raw().exec('SELECT COUNT(*) as cnt FROM events')[0];
    res.json({
      players:  players  ? players.values[0][0]  : 0,
      rooms:    rooms    ? rooms.values[0][0]    : 0,
      monsters: monsters ? monsters.values[0][0] : 0,
      events:   events   ? events.values[0][0]   : 0,
      db_path:  process.env.DB_PATH || 'db/dungeon.sqlite',
      uptime_s: process.uptime(),
    });
  });

  /**
   * GET /api/world — Evento global activo del dungeon (T090) + resumen de salas (BUG-1051)
   */
  app.get('/api/world', (req, res) => {
    const ev = worldEvents.getCurrentEvent();
    const nextText = worldEvents.getNextEventText();
    // BUG-1051: agregar resumen de salas para que /api/world sea útil como mapa del mundo
    const allRooms = [];
    for (let i = 1; i <= 25; i++) {
      const r = db.getRoom(i);
      if (!r) continue;
      const monsters = db.getMonstersInRoom(i).filter(m => m.hp > 0);
      allRooms.push({
        id: r.id,
        name: r.name,
        exits: Object.keys(r.exits || {}),
        monsters_count: monsters.length,
        items_count: (r.items || []).length,
      });
    }
    res.json({
      active_event: ev || null,
      next_event_info: ev ? null : nextText,
      rooms: allRooms,
    });
  });

  /**
   * GET  /api/admin/cleanup?dry=true  — Listar jugadores candidatos a borrado (DIS-007)
   * POST /api/admin/cleanup           — Eliminar jugadores de test / inactivos
   *
   * Body JSON opcional para POST:
   *   { "olderThanDays": 7, "includeTestNames": true, "ids": ["id1","id2"] }
   *   - ids: lista explícita (borra solo esos); si se omite, borra todos los candidatos
   *
   * Protegido por ADMIN_TOKEN env var.
   */
  function _adminAuth(req, res) {
    const adminToken = process.env.ADMIN_TOKEN;
    if (!adminToken) return true;
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (token !== adminToken) {
      res.status(401).json({ error: 'Unauthorized. Provide: Authorization: Bearer <ADMIN_TOKEN>' });
      return false;
    }
    return true;
  }

  app.get('/api/admin/cleanup', (req, res) => {
    if (!_adminAuth(req, res)) return;
    const olderThanDays = parseInt(req.query.olderThanDays || '7', 10);
    const includeTestNames = req.query.includeTestNames !== 'false';
    const candidates = db.getTestPlayers({ olderThanDays, includeTestNames });
    res.json({
      count: candidates.length,
      note: 'GET lista candidatos. POST /api/admin/cleanup para eliminarlos.',
      players: candidates,
    });
  });

  app.post('/api/admin/cleanup', (req, res) => {
    if (!_adminAuth(req, res)) return;
    const { olderThanDays = 7, includeTestNames = true, ids } = req.body || {};
    let toDelete;
    if (Array.isArray(ids) && ids.length > 0) {
      toDelete = ids.map(id => ({ id }));
    } else {
      toDelete = db.getTestPlayers({ olderThanDays, includeTestNames });
    }
    const deleted = [];
    for (const p of toDelete) {
      db.deletePlayer(p.id);
      deleted.push(p.id || p);
    }
    db.persist();
    console.log(`[admin] cleanup: ${deleted.length} jugadores eliminados.`);
    res.json({ deleted: deleted.length, ids: deleted });
  });

  // 5. Crear servidor HTTP
  /**
   * POST /api/action  — Endpoint LLM-friendly (T034)
   * Devuelve: resultado de texto + estado completo post-acción
   */
  app.post('/api/action', (req, res) => {
    const { player_id, command } = req.body;
    if (!player_id || !command) {
      return res.status(400).json({ error: 'Se requiere player_id y command.' });
    }

    // BUG-467: Inicializar sessionDataMap on-the-fly para que 'session' funcione via /api/action
    const { sessionDataMap } = require('./socket/handlers');
    if (!sessionDataMap.has(player_id)) {
      const freshP = db.getPlayer(player_id);
      sessionDataMap.set(player_id, {
        startTime: Date.now(),
        kills: 0,
        xpStart: freshP ? (freshP.xp || 0) : 0,
        goldStart: freshP ? (freshP.gold || 0) : 0,
        commands: 0,
      });
    }
    const actionContext = {
      sessionData: sessionDataMap.get(player_id) || null,
      sessionDataMap,
    };
    const actionSessData = sessionDataMap.get(player_id);

    let result;
    try {
      result = execute(player_id, command, actionContext);
      if (actionSessData) {
        actionSessData.commands++;
        if (result && result.sessionKill) actionSessData.kills++;
      }
    } catch (err) {
      console.error('[/api/action] Error ejecutando comando:', err.message);
      result = { text: '(error interno al ejecutar el comando — intentá de nuevo)' };
    }

    // DIS-001: Guard — si result es undefined (race condition o error silencioso), usar texto genérico
    const resultText = (result && result.text) ? result.text : '(acción ejecutada)';

    // Construir estado post-acción igual que /api/state
    const player  = db.getPlayer(player_id);
    if (!player) return res.status(404).json({ error: 'Jugador no encontrado.' });

    const room     = db.getRoom(player.current_room_id);
    const monsters = db.getMonstersInRoom(player.current_room_id);
    const others   = db.getPlayersInRoom(player.current_room_id)
                       .filter(p => p.id !== player.id)
                       .map(p => `${p.username} (HP: ${p.hp}/${p.max_hp})`);
    const events   = db.getRecentEvents(player.current_room_id, 5)
                       .map(e => e.result);

    // BUG-1048b: alias 'creatures' igual que en /api/state
    const actionMonsterList = monsters.map(m => ({ name: m.name, hp: m.hp, max_hp: m.max_hp }));
    res.json({
      result: resultText,
      state: {
        room: {
          id: room.id,
          name: room.name,
          description: room.description,
          exits: Object.keys(room.exits),
          monsters: actionMonsterList,
          creatures: actionMonsterList, // alias de monsters
          items: room.items,
          trap: room.trap ? { active: room.trap.active, type: room.trap.type } : null,
          room_effect: ROOM_EFFECTS[room.id] ? { label: ROOM_EFFECTS[room.id].label, type: ROOM_EFFECTS[room.id].type } : null,
        },
        player: {
          id: player.id,
          username: player.username,
          hp: player.hp,
          max_hp: player.max_hp,
          attack: player.attack,
          defense: player.defense,
          inventory: player.inventory,
          level: player.level || 1,
          xp: player.xp || 0,
          kills: player.kills || 0,
          equipped_weapon: player.equipped_weapon || null,
          equipped_armor: player.equipped_armor || null,
          pending_messages: db.countPendingMessages(player.id),
          status_effects: player.status_effects || {},
          gold: player.gold || 0,
          achievements: JSON.parse(player.achievements || '[]'),
          mana: player.mana != null ? player.mana : 20,
          max_mana: player.max_mana || 20,
          shield_active: player.shield_active || 0,
          player_class: player.player_class || 'sin_clase',
          class_name: player.player_class || 'sin_clase',  // DIS-D305: alias para compatibilidad
          specialization: player.specialization || null,
          playtime_minutes: player.playtime_minutes || 0,
          reputation: player.reputation || 0,  // DIS-1319: exponer reputación en /api/action state
        },
        other_players: others,
        recent_events: events,
        party: player.party_id
          ? db.getPartyMembers(player.party_id)
              .filter(m => m.id !== player.id)
              .map(m => ({ username: m.username, hp: m.hp, max_hp: m.max_hp, level: m.level || 1 }))
          : null,
      },
    });
  });

  // 5. Crear servidor HTTP
  const server = http.createServer(app);

  // 6. Socket.io — Multijugador en tiempo real (Fase 4)
  const { Server } = require('socket.io');
  const io = new Server(server, {
    cors: { origin: '*' },
  });
  // DIS-1039: Registrar io en el singleton para que say/shout funcionen vía REST
  require('./ioRef').set(io);
  registerHandlers(io);

  // 7. Arrancar servidor
  // DIS-498: limpiar inscripciones de bots de playtests anteriores
  try {
    const botMsgsDeleted = db.cleanBotWallMessages ? db.cleanBotWallMessages() : 0;
    if (botMsgsDeleted > 0) {
      console.log(`🧹 DIS-498: ${botMsgsDeleted} inscripciones de bots eliminadas de las paredes.`);
    }
  } catch (e) { /* ignorar si la función no existe */ }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🏰 Dungeon of Echoes corriendo en http://0.0.0.0:${PORT}`);
    console.log(`   Versión 0.6.0 — Fases 1-6 completas (Frontend + API LLM)`);
    console.log(`   Presioná Ctrl+C para apagar\n`);
  });

  // 8. Respawn loop: checar cada 60 segundos
  // T220: callback al respawnear el boss para broadcast global
  setInterval(() => {
    checkRespawns(
      // onBossRespawn
      (bossId, bossName, roomId) => {
        const roomData = db.getRoom(roomId);
        const roomName = roomData ? roomData.name : `sala ${roomId}`;
        io.emit('shout', {
          username: '💀 DUNGEON',
          message: `⚡ ¡${bossName} HA RESUCITADO en ${roomName}! Los aventureros más valientes ya pueden enfrentarse a él nuevamente.`,
        });
        db.logGlobalEvent('boss', `⚡ ${bossName} resucitó en ${roomName}.`);
        console.log(`[respawn] Boss ${bossName} resucitó en sala ${roomId}`);
      },
      // T223: onAnyRespawn — notificar a jugadores que trackean este monstruo
      (monsterId, baseName, roomId, isElite) => {
        const trackers = monsterTrackMap.get(baseName);
        if (!trackers || trackers.size === 0) return;
        const roomData = db.getRoom(roomId);
        const roomName = roomData ? roomData.name : `sala ${roomId}`;
        const eliteNote = isElite ? ' ⭐ (¡versión ÉLITE!)' : '';
        const msg = `🎯 [TRACK] ${baseName}${eliteNote} ha reaparecido en ${roomName}.`;
        for (const playerId of trackers) {
          const sock = playerSockets.get(playerId);
          if (sock) sock.emit('event', { text: msg });
        }
      }
    );
  }, 60000);

  // 9. Trap respawn loop: reactivar trampas desactivadas cada 60 segundos
  setInterval(() => db.checkTrapRespawns(), 60000);

  // T143: Training dummy regen loop — regenerar maniquíes en sala 21 cada 10 segundos
  const TRAINING_DUMMY_IDS_SERVER = [23, 24, 25];
  setInterval(() => {
    for (const dummyId of TRAINING_DUMMY_IDS_SERVER) {
      const dummy = db.getMonster(dummyId);
      if (dummy && dummy.hp < dummy.max_hp) {
        db.updateMonster(dummyId, { hp: dummy.max_hp, room_id: 21 });
      }
    }
  }, 10000);

  // T144: Bounty expiration loop — expirar recompensas vencidas y devolver oro cada minuto
  setInterval(() => {
    db.expireOldBounties();
  }, 60000);

  // T181: Expirar anuncios del mercado cada 5 minutos (devolver ítems a vendedores)
  setInterval(() => {
    const expired = db.expireOldMarketListings();
    for (const listing of expired) {
      // Devolver el ítem al vendedor si existe
      const seller = db.getPlayer(listing.seller_id);
      if (seller) {
        const inv = seller.inventory || [];
        inv.push(listing.item_name);
        db.updatePlayer(listing.seller_id, { inventory: JSON.stringify(inv) });
        // Notificar al vendedor si está online
        const { playerSockets } = require('./socket/handlers');
        const sellerSocket = playerSockets.get(listing.seller_id);
        if (sellerSocket) {
          sellerSocket.emit('event', {
            type: 'info',
            text: `⏰ Tu anuncio de "${listing.item_name}" expiró sin venderse. El ítem fue devuelto a tu inventario.`,
          });
        }
      }
    }
  }, 5 * 60000);

  // 10. Quest loop: iniciar quest activa + rotar cada 5 minutos si pasaron 30 min
  quests.loadQuest();
  setInterval(() => {
    const newQuest = quests.maybeRotateQuest();
    if (newQuest) {
      // Anunciar nueva quest a todos los jugadores conectados
      io.emit('shout', {
        username: '📜 SISTEMA',
        message: `¡Nueva quest disponible! "${newQuest.questDef.title}" — Escribí "quest" para ver los detalles.`,
      });
      console.log(`[quests] Quest rotada: ${newQuest.questDef.title}`);
    }
  }, 5 * 60000);

  // 11. World Events loop: verificar cada 60 segundos si hay que activar/desactivar evento
  setInterval(() => {
    const result = worldEvents.tick();
    if (result) {
      io.emit('shout', {
        username: '🌍 DUNGEON',
        message: result.message,
      });
      console.log(`[worldEvents] ${result.type}: ${result.event.name}`);
    }

    // T166: Weather tick — cambiar clima cada 60 minutos
    const weatherResult = weather.tick();
    if (weatherResult) {
      io.emit('shout', {
        username: '🌦️ CLIMA',
        message: weatherResult.message,
      });
      console.log(`[weather] Nuevo clima: ${weatherResult.weather.name}`);
    }
  }, 60000);

  // T-1225: Scheduler de eventos cíclicos globales (La Gaceta del Corredor)
  eventScheduler.init(db, io);

  // DIS-1482: Bots NPC en la Casa de Subastas (Bertholdt, Melisandra, Drago)
  auctionNPC.init(db, io);
  // Tick cada 5 minutos: los bots subastan y pujan
  setInterval(() => { auctionNPC.tick(); }, 5 * 60 * 1000);

  // 12. Auction resolution loop: resolver subastas expiradas cada 30 segundos
  setInterval(() => {
    resolveExpiredAuctions((msg) => {
      io.emit('shout', { username: '🔨 REMATE', message: msg });
      console.log(`[auctions] ${msg}`);
    });
  }, 30000);

  // IMPL-PARTY-1634: Auto-disolución de parties inactivas (cada 5 minutos)
  // Disuelve parties con más de 30 minutos de inactividad y notifica a miembros conectados.
  setInterval(() => {
    try {
      const staleParties = db.getStaleParties(30);
      for (const party of staleParties) {
        // Obtener miembros antes de disolver (para notificarles)
        const members = db.getPartyMembers(party.id);
        db.dissolveParty(party.id);
        console.log(`[party] Party ${party.id} disuelta por inactividad (30 min).`);
        // Notificar a los miembros que estén conectados
        for (const member of members) {
          const sock = playerSockets.get(member.id);
          if (sock) {
            sock.emit('event', {
              type: 'warning',
              text: '⚠️ Tu party se disolvió por inactividad (30 min sin actividad del grupo).',
            });
          }
        }
      }
    } catch (err) {
      console.error('[party] Error en auto-disolución:', err.message);
    }
  }, 5 * 60 * 1000);

  // 13. T130: Regeneración periódica de sala sagrada (sala 1 — Entrada del Dungeon)
  // Cada 10s, los jugadores con HP < max que estén en la sala sagrada recuperan 1 HP.
  const SACRED_ROOM_ID = 1;
  setInterval(() => {
    try {
      const players = db.getPlayersInRoom(SACRED_ROOM_ID);
      for (const p of players) {
        if (p.hp > 0 && p.hp < p.max_hp) {
          const newHp = Math.min(p.max_hp, p.hp + 1);
          db.updatePlayer(p.id, { hp: newHp });
          // Notificar solo al jugador afectado (si está conectado)
          const targetSocket = playerSockets.get(p.id);
          if (targetSocket) {
            targetSocket.emit('event', {
              type: 'sacred_regen',
              message: `✨ El aura sagrada te restaura 1 HP. (${newHp}/${p.max_hp} HP)`,
            });
          }
        }
      }
    } catch (e) {
      console.error('[sacredRegen] Error:', e.message);
    }
  }, 10000);

  // 14. T188: Expiración de posts del tablón cada hora
  setInterval(() => {
    try {
      db.expireOldBulletinPosts();
    } catch (e) {
      console.error('[bulletin] Error expirando posts:', e.message);
    }
  }, 60 * 60 * 1000);

  // 16. BUG-804/BUG-805: Respawn de ítems persistentes de sala — bolsa de lona (sala 15) y hongo azul (sala 6)
  // Estos ítems se pierden si el jugador los recoge y el servidor no se reinicia.
  // El loop verifica cada 3 minutos y los restaura si faltan (idempotente).
  setInterval(() => {
    try {
      // Restaurar bolsa de lona en Catedral (sala 15) — BUG-804
      const room15 = db.getRoom(15);
      if (room15) {
        const items15 = Array.isArray(room15.items) ? room15.items : [];
        if (!items15.includes('bolsa de lona')) {
          db.updateRoomItems(15, [...items15, 'bolsa de lona']);
          console.log('[itemRespawn] BUG-804 — bolsa de lona restaurada en Catedral (sala 15). ✓');
        }
      }
      // Restaurar hongo azul en Túnel de los Hongos (sala 6) — BUG-805
      const room6 = db.getRoom(6);
      if (room6) {
        const items6 = Array.isArray(room6.items) ? room6.items : [];
        const hasHongo = items6.some(i => i.toLowerCase().includes('hongo azul'));
        if (!hasHongo) {
          db.updateRoomItems(6, [...items6, 'hongo azul']);
          console.log('[itemRespawn] BUG-805 — hongo azul restaurado en Túnel de los Hongos (sala 6). ✓');
        }
      }
      // Restaurar hierba curativa en Galería de Hielo (sala 11) — DIS-1035
      const room11 = db.getRoom(11);
      if (room11) {
        const items11 = Array.isArray(room11.items) ? room11.items : [];
        if (!items11.includes('hierba curativa')) {
          db.updateRoomItems(11, [...items11, 'hierba curativa']);
          console.log('[itemRespawn] DIS-1035 — hierba curativa restaurada en Galería de Hielo (sala 11). ✓');
        }
      }
    } catch (e) {
      console.error('[itemRespawn] Error restaurando ítems persistentes:', e.message);
    }
  }, 3 * 60 * 1000);

  // 15. T203: Monstruos errantes — el Goblin Merodeador y la Rata Gigante se mueven cada 90 segundos
  setInterval(() => {
    try {
      wanderMonsters((monsterId, monsterName, fromRoomId, toRoomId) => {
        const { playerSockets } = require('./socket/handlers');
        // Notificar a jugadores en la sala de origen
        const fromPlayers = db.getPlayersInRoom(fromRoomId);
        for (const p of fromPlayers) {
          const sock = playerSockets.get(p.id);
          if (sock) {
            sock.emit('event', {
              type: 'info',
              text: `👣 El ${monsterName} abandona la sala y desaparece entre las sombras...`,
            });
          }
        }
        // Notificar a jugadores en la sala destino
        const toPlayers = db.getPlayersInRoom(toRoomId);
        for (const p of toPlayers) {
          const sock = playerSockets.get(p.id);
          if (sock) {
            sock.emit('event', {
              type: 'warning',
              text: `⚠️  ¡Un ${monsterName} aparece en la sala desde la oscuridad!`,
            });
          }
        }
      });
    } catch (e) {
      console.error('[wander] Error en loop de monstruos errantes:', e.message);
    }
  }, 90000);
}

main().catch(err => {
  console.error('Error fatal al arrancar:', err);
  process.exit(1);
});
