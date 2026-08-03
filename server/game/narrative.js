/**
 * narrative.js — EPIC-NE-IMPL-2270
 * Módulo de narrativa emergente del personaje.
 * Implementa buildPlayerNarrative(player, moments, quests) → string
 */

'use strict';

// ── Mappings de display ──────────────────────────────────────────────────────

const CLASS_DISPLAY = {
  guerrero:  'Guerrero',
  mago:      'Mago',
  clerigo:   'Clérigo',
  sin_clase: 'Aventurero',
  picaro:    'Pícaro',
};

const SPEC_DISPLAY = {
  paladin:    'Paladín',
  evoker:     'Evoker',
  asesino:    'Asesino',
  sanador:    'Sanador',
  berserker:  'Berserker',
  invocador:  'Invocador',
};

const MOMENT_EMOJI = {
  primer_kill:       '⚔️',
  near_death:        '💔',
  boss_kill:         '☠️',
  primer_crafteo:    '🔨',
  subasta_ganada:    '🪙',
  kill_vs_nivel:     '💪',
  maraton_kills:     '🔥',
  kill_bajo_evento:  '⚡',
  primer_skill_kill: '✨',
};

// Orden de prioridad de momentos para mostrar
const MOMENT_PRIORITY = [
  'boss_kill', 'near_death', 'primer_kill',
  'kill_vs_nivel', 'maraton_kills', 'primer_skill_kill',
  'primer_crafteo', 'subasta_ganada', 'kill_bajo_evento',
];

// ── Helper de línea con bordes ────────────────────────────────────────────────

const W = 54; // ancho interior (entre bordes ║  y  ║)

/**
 * Produce una línea ║  texto  ║ con padding a la derecha.
 * Si el texto es más largo que W-2 caracteres, lo corta.
 */
function line(text) {
  // Contamos largo real ignorando secuencias de escape ANSI (no hay aquí)
  const content = '  ' + text;
  return '║' + content.padEnd(W) + '║';
}

function separator() {
  return '╠' + '═'.repeat(W) + '╣';
}

function top() {
  return '╔' + '═'.repeat(W) + '╗';
}

function bottom() {
  return '╚' + '═'.repeat(W) + '╝';
}

// ── Sección 1 — ENCABEZADO ────────────────────────────────────────────────────

function buildHeader(player) {
  const lines = [];
  const now = Date.now();
  const createdAt = player.created_at ? new Date(player.created_at).getTime() : now;
  const diasJugados = Math.floor((now - createdAt) / 86400000);
  const hrsJugadas = Math.floor((player.playtime_minutes || 0) / 60);
  const kills = player.kills || 0;
  const deaths = player.deaths || 0;

  // Días
  if (diasJugados === 0) {
    lines.push(line('Llegó hace menos de un día.'));
  } else {
    lines.push(line(`Llegó hace ${diasJugados} día(s).`));
  }

  // Kills
  if (kills === 0) {
    lines.push(line('Aún no derramó sangre.'));
  } else if (kills === 1) {
    lines.push(line('Un kill. El primero no se olvida.'));
  } else if (kills >= 100) {
    lines.push(line(`${kills} kills. El dungeon ya no lo sorprende.`));
  } else {
    lines.push(line(`${kills} kills. ${deaths} muerte(s).`));
  }

  // Horas
  if (hrsJugadas > 0) {
    lines.push(line(`${hrsJugadas} hora(s) en el dungeon.`));
  }

  // Ascensión
  const ascCount = player.ascension_count || 0;
  if (ascCount > 0) {
    lines.push(line(`Esta es su vida ${ascCount + 1} en el dungeon.`));
  }

  // Especialización
  if (player.specialization && SPEC_DISPLAY[player.specialization]) {
    lines.push(line(`Especialización: ${SPEC_DISPLAY[player.specialization]}`));
  }

  return lines;
}

// ── Sección 2 — FIRMA DE JUEGO ────────────────────────────────────────────────

function buildFirma(player) {
  const kills = player.kills || 0;
  const craftsCount = player.crafts_count || 0;
  const goldSpent = player.gold_spent || 0;
  const gold = player.gold || 0;
  const playtimeMin = player.playtime_minutes || 0;
  const deaths = player.deaths || 0;

  // Parsear rooms_visited
  let roomsVisited = [];
  try {
    const rv = player.rooms_visited;
    if (rv) {
      const parsed = typeof rv === 'string' ? JSON.parse(rv) : rv;
      if (Array.isArray(parsed)) roomsVisited = parsed;
    }
  } catch (_) {}

  // Si jugador nuevo y sin kills, omitir
  const createdAt = player.created_at ? new Date(player.created_at).getTime() : Date.now();
  const diasJugados = Math.floor((Date.now() - createdAt) / 86400000);
  if (kills === 0 && diasJugados < 1) return [];

  const hrs = Math.max(1, playtimeMin / 60);
  const killsPerHour = kills / hrs;

  // Determinar perfil dominante
  const esAgresivo    = killsPerHour > 5;
  const esExplorador  = roomsVisited.length >= 10;
  const esCraftero    = craftsCount >= 3;
  const esComerciante = goldSpent >= 100;

  const nDominantes = [esAgresivo, esExplorador, esCraftero, esComerciante].filter(Boolean).length;

  const lines = [];

  if (nDominantes === 0) {
    // Sin firma clara
    lines.push(line('Sin firma clara aún. Exploró, peleó, algo crafteó.'));
    lines.push(line(`${kills} kills · ${roomsVisited.length} salas · ${craftsCount} crafteos.`));
    lines.push(line('El dungeon aún no lo define.'));
    return lines;
  }

  // Perfil dominante (primer match en orden de prioridad)
  if (esAgresivo) {
    lines.push(line('Combate primero, pregunta después.'));
    lines.push(line(`${kills} kills en ${Math.floor(hrs)} hora(s) — ${killsPerHour.toFixed(1)} por hora.`));
    if (deaths === 0) {
      lines.push(line('Sin muertes. Eso es raro.'));
    } else {
      lines.push(line(`${deaths} caída(s). Las contó.`));
    }
  } else if (esExplorador) {
    lines.push(line('Exploró antes de atacar.'));
    lines.push(line(`${roomsVisited.length} salas visitadas.`));
    if (roomsVisited.length >= 15) {
      lines.push(line('Ya conoce el dungeon mejor que algunos guardias.'));
    }
  } else if (esCraftero) {
    lines.push(line('Las manos antes que la espada.'));
    const matStr = goldSpent >= 50 ? 'Invirtió en materiales.' : '';
    lines.push(line(`${craftsCount} crafteo(s).${matStr ? ' ' + matStr : ''}`));
    if (craftsCount >= 5) {
      lines.push(line('Sabe qué se puede hacer con qué.'));
    }
  } else if (esComerciante) {
    lines.push(line('El dungeon como economía.'));
    lines.push(line(`${goldSpent} gold gastado. ${gold} en mano.`));
    if (gold > 300) {
      lines.push(line('Acumula sin gastar. Estratega o ansioso.'));
    } else if (goldSpent > 200 && gold < 50) {
      lines.push(line('Gasta todo. Confía en que habrá más.'));
    }
  }

  return lines;
}

// ── Sección 3 — MOMENTOS CUMBRE ───────────────────────────────────────────────

function buildMomentos(moments) {
  if (!moments || moments.length === 0) return [];

  // Ordenar por prioridad
  const byType = {};
  for (const m of moments) {
    if (!byType[m.moment_type]) byType[m.moment_type] = m;
  }

  const selected = [];
  for (const type of MOMENT_PRIORITY) {
    if (byType[type] && selected.length < 3) {
      selected.push(byType[type]);
    }
  }

  if (selected.length === 0) return [];

  const lines = [];
  lines.push(line('MOMENTOS CUMBRE'));
  for (const m of selected) {
    const emoji = MOMENT_EMOJI[m.moment_type] || '📍';
    lines.push(line(`${emoji} ${m.description_text}`));
  }
  return lines;
}

// ── Sección 4 — DEUDA PENDIENTE ───────────────────────────────────────────────

function buildDeuda(player, quests) {
  const lines = [];
  let count = 0;

  // Quest principal
  try {
    const mqd = typeof player.main_quest_data === 'string'
      ? JSON.parse(player.main_quest_data || '{}')
      : (player.main_quest_data || {});
    const mqState = mqd.main_quest_state || 'inactive';
    if (mqState === 'active') {
      const frags = (mqd.fragments_found || []).length;
      lines.push(line(`📜 Quest principal: ${frags}/4 fragmentos.`));
      count++;
    }
  } catch (_) {}

  // Quests activas (hasta 2)
  if (quests && quests.length > 0 && count < 3) {
    const recentQuests = quests.slice(-2); // las más recientes
    for (const q of recentQuests) {
      if (count >= 3) break;
      let progressStr = 'en progreso';
      try {
        const prog = typeof q.progress === 'string' ? JSON.parse(q.progress || '{}') : (q.progress || {});
        const cond = typeof q.condition === 'string' ? JSON.parse(q.condition || '{}') : (q.condition || {});
        if (q.type === 'kill' && prog.kills !== undefined && cond.count !== undefined) {
          progressStr = `${prog.kills}/${cond.count} kills`;
        } else if (q.type === 'explore' && prog.rooms_visited !== undefined && cond.count !== undefined) {
          progressStr = `${prog.rooms_visited}/${cond.count} salas`;
        } else if (q.type === 'craft' && prog.crafts !== undefined && cond.count !== undefined) {
          progressStr = `${prog.crafts}/${cond.count} crafteos`;
        }
      } catch (_) {}
      const questName = q.name || q.quest_id || 'Quest';
      lines.push(line(`📋 ${questName} — ${progressStr}`));
      count++;
    }
  }

  // Contrato semanal
  if (count < 3) {
    try {
      const wc = typeof player.weekly_contract === 'string'
        ? JSON.parse(player.weekly_contract || 'null')
        : player.weekly_contract;
      if (wc && wc.target && wc.status === 'active') {
        lines.push(line(`📜 Contrato: ${wc.target} (${wc.progress || 0}/${wc.goal || '?'})`));
        count++;
      }
    } catch (_) {}
  }

  return lines;
}

// ── Función principal ─────────────────────────────────────────────────────────

/**
 * Construye el texto narrativo del comando `historia`.
 * @param {Object} player  - row de la tabla players
 * @param {Array}  moments - array de player_moments
 * @param {Array}  quests  - array de quests activas (player_quests JOIN quest_definitions)
 * @returns {string}
 */
function buildPlayerNarrative(player, moments, quests) {
  const kills      = player.kills || 0;
  const level      = player.level || 1;
  const username   = (player.username || player.name || 'AVENTURERO').toUpperCase();
  const playerClass = player.player_class || player.class || 'sin_clase';
  const classDisplay = CLASS_DISPLAY[playerClass] || 'Aventurero';
  const specDisplay  = player.specialization ? (SPEC_DISPLAY[player.specialization] || player.specialization) : null;

  const classLine = specDisplay
    ? `${classDisplay} · ${specDisplay} · Nivel ${level}`
    : `${classDisplay} · Nivel ${level}`;

  // Versión mínima para jugador nuevo
  const isNewPlayer = kills === 0 && level === 1 && (!moments || moments.length === 0);
  if (isNewPlayer) {
    return [
      top(),
      line(`📖 LA CRÓNICA DE ${username}`),
      line(classLine),
      separator(),
      line('Llegó hace menos de un día.'),
      line('El dungeon aún no lo conoce.'),
      line('La historia se escribe con kills.'),
      bottom(),
    ].join('\n');
  }

  // Construcción normal
  const allSections = [];

  // Header fijo
  allSections.push([
    top(),
    line(`📖 LA CRÓNICA DE ${username}`),
    line(classLine),
  ]);

  // Sección 1 — ENCABEZADO
  const headerLines = buildHeader(player);
  if (headerLines.length > 0) {
    allSections.push([separator(), ...headerLines]);
  }

  // Sección 2 — FIRMA DE JUEGO
  const firmaLines = buildFirma(player);
  if (firmaLines.length > 0) {
    allSections.push([separator(), ...firmaLines]);
  }

  // Sección 3 — MOMENTOS CUMBRE
  const momentosLines = buildMomentos(moments);
  if (momentosLines.length > 0) {
    allSections.push([separator(), ...momentosLines]);
  }

  // Sección 4 — DEUDA PENDIENTE
  const deudaLines = buildDeuda(player, quests);
  if (deudaLines.length > 0) {
    allSections.push([separator(), ...deudaLines]);
  }

  // Cierre
  const allLines = [];
  for (const section of allSections) {
    allLines.push(...section);
  }
  allLines.push(bottom());

  return allLines.join('\n');
}

module.exports = { buildPlayerNarrative };
