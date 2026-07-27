// ─────────────────────────────────────────────────────────────────────────────
// EPIC-2045 / EPIC-2046: Boss Dialogue Engine — Voces del Abismo
//
// Sistema de templates con condiciones para los diálogos de bosses.
// Función central: getBossDialogue(boss_id, trigger, player, bossStats)
//
// Triggers: 'encounter' | 'phase2' | 'death' | 'escape'
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// ESTRUCTURA DE UN TEMPLATE DE DIÁLOGO
//
// {
//   boss_id: string,
//   trigger: 'encounter' | 'phase2' | 'death' | 'escape',
//   conditions: {
//     quest_active: string | null,    // ID de quest que debe estar 'active' en el jugador
//     kill_count_min: number | null,  // mínimo de total_kills globales del boss
//     kill_count_max: number | null,  // máximo de total_kills globales (inclusive)
//     player_level_min: number | null,
//   },
//   priority: number,   // mayor número = mayor prioridad cuando múltiple condiciones aplican
//   text: string | null,             // null = silencio (la Sombra del Vacío)
//   ambient_text: string | null,     // texto ambiental en lugar de diálogo
// }
//
// Evaluación: se eligen todos los templates que cumplen las condiciones.
//             El de mayor prioridad gana. Si hay empate, el primero en el array.
// ─────────────────────────────────────────────────────────────────────────────

// IDs de boss que mapean al monster_id de la BD
const BOSS_DIALOGUE_IDS = {
  8:  'guardia_espectral',
  4:  'espectro_corredor',
  13: 'lich_anciano',
  21: 'eco_viviente',
  22: 'sombra_del_vacio',
};

// Mapeo inverso: boss_dialogue_id → monster_id
const DIALOGUE_ID_TO_MONSTER_ID = Object.fromEntries(
  Object.entries(BOSS_DIALOGUE_IDS).map(([k, v]) => [v, Number(k)])
);

// ─────────────────────────────────────────────────────────────────────────────
// TEMPLATES DE DIÁLOGO — EPIC-2046
// ─────────────────────────────────────────────────────────────────────────────

const BOSS_DIALOGUE_TEMPLATES = [

  // ═══════════════════════════════════════════════════════════════════════════
  // GUARDIA ESPECTRAL (monster_id: 8)
  // El último carcelero — atrapado en el puesto que juró no abandonar
  // ═══════════════════════════════════════════════════════════════════════════

  {
    boss_id: 'guardia_espectral',
    trigger: 'encounter',
    conditions: { quest_active: null, kill_count_min: null, kill_count_max: 10, player_level_min: null },
    priority: 5,
    text: '«¿Visitante? No.» *Una pausa.* «Intruso.»\n*El Guardia Espectral ocupa el umbral. Su armadura lleva marcas de tres generaciones de carceleros — el último que la usó murió aquí.*',
    ambient_text: null,
  },
  {
    boss_id: 'guardia_espectral',
    trigger: 'encounter',
    conditions: { quest_active: null, kill_count_min: 11, kill_count_max: null, player_level_min: null },
    priority: 5,
    text: '«Otro aventurero.» *Su voz suena desgastada, sin miedo.* «Los cuento desde hace siglos.»',
    ambient_text: null,
  },
  {
    boss_id: 'guardia_espectral',
    trigger: 'phase2',
    conditions: { quest_active: null, kill_count_min: null, kill_count_max: null, player_level_min: null },
    priority: 5,
    text: '«Todavía... en mi puesto.» *La armadura parpadea. Un frío más profundo llena la celda.* «El carcelero... nunca abandona.»',
    ambient_text: null,
  },
  {
    boss_id: 'guardia_espectral',
    trigger: 'death',
    conditions: { quest_active: null, kill_count_min: null, kill_count_max: null, player_level_min: null },
    priority: 5,
    text: '«Por fin... libre.»',
    ambient_text: null,
  },
  {
    boss_id: 'guardia_espectral',
    trigger: 'escape',
    conditions: { quest_active: null, kill_count_min: null, kill_count_max: null, player_level_min: null },
    priority: 5,
    text: '«Volvés. Como todos.»',
    ambient_text: null,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // ESPECTRO DEL CORREDOR (monster_id: 4)
  // Guardián del Trono de Kaelthas por inercia espectral
  // ═══════════════════════════════════════════════════════════════════════════

  {
    boss_id: 'espectro_corredor',
    trigger: 'encounter',
    conditions: { quest_active: null, kill_count_min: null, kill_count_max: null, player_level_min: null },
    priority: 5,
    text: '«Este trono no es tuyo.»',
    ambient_text: null,
  },
  {
    boss_id: 'espectro_corredor',
    trigger: 'phase2',
    conditions: { quest_active: null, kill_count_min: null, kill_count_max: null, player_level_min: null },
    priority: 5,
    text: '«El rey... lo habría querido así.» *Confusión en su voz: ¿protege al rey o al usurpador que tomó el trono?*',
    ambient_text: null,
  },
  {
    boss_id: 'espectro_corredor',
    trigger: 'death',
    conditions: { quest_active: null, kill_count_min: null, kill_count_max: null, player_level_min: null },
    priority: 5,
    text: '«¿El trono... sigue ahí?»',
    ambient_text: null,
  },
  {
    boss_id: 'espectro_corredor',
    trigger: 'escape',
    conditions: { quest_active: null, kill_count_min: null, kill_count_max: null, player_level_min: null },
    priority: 5,
    text: '«Huís del umbral. El trono espera.»',
    ambient_text: null,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // LICH ANCIANO / KAELTHAS (monster_id: 13)
  // El boss final. Su diálogo cambia radicalmente con la quest activa.
  // ═══════════════════════════════════════════════════════════════════════════

  // Sin quest, primera vez (kill_count 0-5)
  {
    boss_id: 'lich_anciano',
    trigger: 'encounter',
    conditions: { quest_active: null, kill_count_min: null, kill_count_max: 5, player_level_min: null },
    priority: 3,
    text: null,
    ambient_text: '*El Lich te mira. No dice nada. No le parece necesario.*',
  },
  // Sin quest, veterano (kill_count > 5)
  {
    boss_id: 'lich_anciano',
    trigger: 'encounter',
    conditions: { quest_active: null, kill_count_min: 6, kill_count_max: null, player_level_min: null },
    priority: 3,
    text: '«Otra vez.» *Una pausa.* «El libro sigue aquí. Vos también.»',
    ambient_text: null,
  },
  // Con quest activa de Kaelthas — máxima prioridad
  {
    boss_id: 'lich_anciano',
    trigger: 'encounter',
    conditions: { quest_active: 'kaelthas_libro', kill_count_min: null, kill_count_max: null, player_level_min: null },
    priority: 10,
    text: '*El Lich te mira. O lo que queda de sus ojos te mira.*\n«Leíste las paredes,» dice. Una afirmación, no una pregunta. «Entonces sabés cómo termina esto.»',
    ambient_text: null,
  },

  // Phase 2 — sin quest
  {
    boss_id: 'lich_anciano',
    trigger: 'phase2',
    conditions: { quest_active: null, kill_count_min: null, kill_count_max: null, player_level_min: null },
    priority: 3,
    text: '💜 ¡El LICH ANCIANO invoca su filacteria! Un aura oscura lo envuelve — su poder aumenta drásticamente. (FASE 2)\n☠️ Su magia ancestral comienza a drenar tu fuerza vital — perderás 5 HP al inicio de cada turno hasta que caiga.',
    ambient_text: null,
  },
  // Phase 2 — con quest
  {
    boss_id: 'lich_anciano',
    trigger: 'phase2',
    conditions: { quest_active: 'kaelthas_libro', kill_count_min: null, kill_count_max: null, player_level_min: null },
    priority: 10,
    text: '«¡KAELTHAS MURIÓ CUANDO ABRÍ EL LIBRO!» *La filacteria brilla con luz violeta antigua.*\n«Soy lo que queda. Lo que promete el libro.»\n\n💜 (FASE 2) Su magia ancestral comienza a drenar tu fuerza vital — perderás 5 HP al inicio de cada turno hasta que caiga.',
    ambient_text: null,
  },

  // Death — sin quest
  {
    boss_id: 'lich_anciano',
    trigger: 'death',
    conditions: { quest_active: null, kill_count_min: null, kill_count_max: null, player_level_min: null },
    priority: 3,
    text: null,
    ambient_text: null, // usa el texto de victoria estándar de engine.js
  },
  // Death — con quest activa (ending especial)
  {
    boss_id: 'lich_anciano',
    trigger: 'death',
    conditions: { quest_active: 'kaelthas_libro', kill_count_min: null, kill_count_max: null, player_level_min: null },
    priority: 10,
    text: `╔══════════════════════════════════════════════════════╗
║  ☠️  EL LICH ANCIANO HA CAÍDO — La Historia Termina  ║
╚══════════════════════════════════════════════════════╝

El Lich se derrumba. La filacteria se oscurece.

En los segundos de silencio que siguen, sentís algo
que no esperabas: el peso del dungeon cambia. Como si
algo que llevaba siglos conteniendo el aliento por fin
pudiera soltar.

Y escuchás — muy suave, casi imaginado —

«...gracias.»

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
El libro que Kaelthas encontró no prometía derrotar la
muerte — prometía recordar a los muertos. Lo que el rey
olvidó es que recordar no es lo mismo que retener.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⚡ LEGADO ESPECIAL DISPONIBLE: "La Memoria de Kaelthas"
   Al ascender, podés elegir este legado único:
   → El próximo personaje comienza conociendo la historia
     completa del dungeon (todos los fragmentos de lore
     ya descubiertos, salt disponible desde nivel 1).`,
    ambient_text: null,
  },

  // Escape
  {
    boss_id: 'lich_anciano',
    trigger: 'escape',
    conditions: { quest_active: null, kill_count_min: null, kill_count_max: null, player_level_min: null },
    priority: 3,
    text: null,
    ambient_text: '*El Lich no te persigue. Sabe que volvés.*',
  },
  {
    boss_id: 'lich_anciano',
    trigger: 'escape',
    conditions: { quest_active: 'kaelthas_libro', kill_count_min: null, kill_count_max: null, player_level_min: null },
    priority: 10,
    text: '«Leíste las paredes.» *Una pausa.* «Y aun así huís.»',
    ambient_text: null,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // ECO VIVIENTE (monster_id: 21)
  // La Cámara del Eco — voces de aventureros anteriores que nunca salieron
  // ═══════════════════════════════════════════════════════════════════════════

  {
    boss_id: 'eco_viviente',
    trigger: 'encounter',
    conditions: { quest_active: null, kill_count_min: null, kill_count_max: null, player_level_min: null },
    priority: 5,
    text: '«—¡Cuidado con el—!»\n*El eco se interrumpe. Alguien, hace tiempo, no terminó esa frase.*',
    ambient_text: null,
  },
  {
    boss_id: 'eco_viviente',
    trigger: 'phase2',
    conditions: { quest_active: null, kill_count_min: null, kill_count_max: null, player_level_min: null },
    priority: 5,
    text: '«—¡No, por favor—!»\n*El eco te reconoce. Ahora sos parte del registro.*',
    ambient_text: null,
  },
  {
    boss_id: 'eco_viviente',
    trigger: 'death',
    conditions: { quest_active: null, kill_count_min: null, kill_count_max: null, player_level_min: null },
    priority: 5,
    text: null,
    ambient_text: '*El silencio que queda no es silencio normal. Es el eco que finalmente descansa.*',
  },
  {
    boss_id: 'eco_viviente',
    trigger: 'escape',
    conditions: { quest_active: null, kill_count_min: null, kill_count_max: null, player_level_min: null },
    priority: 5,
    text: '«—volvé—»\n*Un susurro. No amenaza. Casi una súplica.*',
    ambient_text: null,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // SOMBRA DEL VACÍO (monster_id: 22)
  // No habla. Su comunicación es el silencio y el ambiente.
  // ═══════════════════════════════════════════════════════════════════════════

  {
    boss_id: 'sombra_del_vacio',
    trigger: 'encounter',
    conditions: { quest_active: null, kill_count_min: null, kill_count_max: null, player_level_min: null },
    priority: 5,
    text: null,
    ambient_text: '*El silencio aquí tiene forma.*',
  },
  {
    boss_id: 'sombra_del_vacio',
    trigger: 'phase2',
    conditions: { quest_active: null, kill_count_min: null, kill_count_max: null, player_level_min: null },
    priority: 5,
    text: '«Quedate.»',
    ambient_text: null,
  },
  {
    boss_id: 'sombra_del_vacio',
    trigger: 'death',
    conditions: { quest_active: null, kill_count_min: null, kill_count_max: null, player_level_min: null },
    priority: 5,
    text: null,
    ambient_text: '*El vacío se cierra sobre sí mismo. Como si nunca hubiera estado.*',
  },
  {
    boss_id: 'sombra_del_vacio',
    trigger: 'escape',
    conditions: { quest_active: null, kill_count_min: null, kill_count_max: null, player_level_min: null },
    priority: 5,
    text: null,
    ambient_text: '*Seguís sintiendo que la oscuridad te mira. Incluso cuando salís.*',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// FUNCIÓN PRINCIPAL: getBossDialogue
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evalúa las condiciones y devuelve el diálogo más prioritario para el trigger dado.
 *
 * @param {string} bossId — ID de boss ('lich_anciano', 'guardia_espectral', etc.)
 *                          O monster_id numérico (se convierte automáticamente)
 * @param {'encounter'|'phase2'|'death'|'escape'} trigger
 * @param {object} player — estado del jugador (de la BD)
 * @param {object|null} bossStats — resultado de db.getBossStats(bossId) o null
 * @returns {{ text: string|null, ambient_text: string|null, matched: boolean }}
 *
 * Si matched=false, no hay template para este trigger → usar comportamiento por defecto.
 * Si text=null y ambient_text=null, el boss permanece en silencio (comportamiento esperado).
 */
function getBossDialogue(bossId, trigger, player, bossStats) {
  // Normalizar bossId numérico a string
  if (typeof bossId === 'number') {
    bossId = BOSS_DIALOGUE_IDS[bossId] || null;
  }
  if (!bossId) return { text: null, ambient_text: null, matched: false };

  const totalKills = bossStats ? (bossStats.total_kills || 0) : 0;
  const playerLevel = player ? (player.level || 1) : 1;

  // Parsear quests activas del jugador
  let activeQuestIds = new Set();
  try {
    if (player && player.quests) {
      const quests = typeof player.quests === 'string' ? JSON.parse(player.quests) : player.quests;
      if (Array.isArray(quests)) {
        for (const q of quests) {
          if (q.status === 'active') activeQuestIds.add(q.quest_id || q.id);
        }
      }
    }
  } catch (_) {}
  // También verificar flag directo kaelthas_quest_active
  if (player && player.kaelthas_quest_active) activeQuestIds.add('kaelthas_libro');

  // Filtrar templates candidatos
  const candidates = BOSS_DIALOGUE_TEMPLATES.filter(t => {
    if (t.boss_id !== bossId) return false;
    if (t.trigger !== trigger) return false;

    const c = t.conditions;
    // Verificar quest_active
    if (c.quest_active && !activeQuestIds.has(c.quest_active)) return false;
    // Si el template no requiere quest, pero el jugador tiene la quest activa,
    // el template sin quest solo aplica si no hay ninguno con quest que matchee —
    // esto se resuelve automáticamente por prioridad.

    // Verificar kill_count
    if (c.kill_count_min !== null && totalKills < c.kill_count_min) return false;
    if (c.kill_count_max !== null && totalKills > c.kill_count_max) return false;

    // Verificar nivel del jugador
    if (c.player_level_min !== null && playerLevel < c.player_level_min) return false;

    return true;
  });

  if (candidates.length === 0) return { text: null, ambient_text: null, matched: false };

  // Elegir el de mayor prioridad
  candidates.sort((a, b) => b.priority - a.priority);
  const chosen = candidates[0];

  return {
    text: chosen.text,
    ambient_text: chosen.ambient_text,
    matched: true,
  };
}

/**
 * Formatea el resultado de getBossDialogue como string para mostrar en el juego.
 * Devuelve string vacío si no hay nada que mostrar.
 *
 * @param {object} dialogueResult — resultado de getBossDialogue(...)
 * @param {string} prefix — prefijo opcional (ej: '\n')
 */
function formatBossDialogue(dialogueResult, prefix = '\n') {
  if (!dialogueResult.matched) return '';
  const parts = [];
  if (dialogueResult.ambient_text) parts.push(dialogueResult.ambient_text);
  if (dialogueResult.text) parts.push(dialogueResult.text);
  if (parts.length === 0) return '';
  return prefix + parts.join('\n');
}

module.exports = {
  getBossDialogue,
  formatBossDialogue,
  BOSS_DIALOGUE_IDS,
  DIALOGUE_ID_TO_MONSTER_ID,
  BOSS_DIALOGUE_TEMPLATES,
};
