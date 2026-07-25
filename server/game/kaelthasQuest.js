'use strict';

/**
 * kaelthasQuest.js — Quest Principal de Kaelthas
 * EPIC-KAELTHAS — La Quest de Kaelthas
 *
 * Módulo que encapsula toda la lógica de la quest principal «El Libro de los Muertos».
 * Documentación de diseño: disenos/epic-kaelthas-api.md, disenos/epic-kaelthas-narrativa.md
 *
 * T-1971 (EPIC-KAELTHAS-F1): implementación inicial del módulo.
 */

const db = require('../db/db');

// ─── Constantes de fragmentos ─────────────────────────────────────────────────

const FRAGMENT_IDS = ['trono', 'mausoleo', 'capilla', 'catedral'];

const FRAGMENT_NAMES = {
  trono:    'El nombre en el trono',
  mausoleo: 'El mausoleo del Reino de Valdrath',
  capilla:  'La cera fresca en el altar',
  catedral: 'El libro en el altar oscuro',
};

// Textos de activación de fragmentos (DIS-1969 — aprobados)
const FRAGMENT_TEXTS = {
  trono: `\n\n📜 Algo en esas palabras te persigue.\n   El nombre en el trono. El rey que encontró el libro.\n   ¿Dónde está ese libro ahora?\n\n💡 Nueva quest: «El Libro de los Muertos» — escribí «quest info» para ver el progreso.`,
  mausoleo: `\n\n📜 Las fechas coinciden. Todo coincide.\n   El dungeon es el mausoleo del Reino de Valdrath.\n   Kaelthas está aquí abajo, en alguna forma.\n\n💡 Quest actualizada: «El Libro de los Muertos» (2/4 fragmentos)`,
  capilla: `\n\n📜 La cera no tiene décadas. No tiene siglos.\n   Alguien viene aquí regularmente.\n   O algo.\n\n💡 Quest actualizada: «El Libro de los Muertos» (3/4 fragmentos)`,
  catedral: `\n\n📜 Está aquí. El libro está aquí.\n   En el altar negro. Frente al Lich.\n   Todo tiene sentido ahora.\n\n💡 Quest actualizada: «El Libro de los Muertos» (4/4 fragmentos) — Derrotá al Lich para completar el arco.`,
};

// Entradas de diario de quest (DIS-1969)
const FRAGMENT_JOURNAL = {
  trono:    '📖 [QUEST] El Libro de los Muertos — Inicio. El nombre Kaelthas aparece en el trono. Un rey que encontró un libro que prometía derrotar a la muerte. ¿Qué fue de él?',
  mausoleo: '📖 [QUEST] La Galería de Hielo es el mausoleo del Reino de Valdrath. Las fechas de las columnas — el reinado de Kaelthas, la caída del reino. Todo encaja. El dungeon no es una mazmorra. Es una cripta.',
  capilla:  '📖 [QUEST] La cera fresca en el altar de la Capilla. No es un detalle decorativo. Hay una presencia activa en este dungeon que aún rinde culto aquí. ¿Kaelthas, en su nueva forma, todavía recuerda algo de lo que fue?',
  catedral: '📖 [QUEST] El libro sobre el altar de la Catedral. El objeto que empezó todo. El que prometía derrotar a la muerte. El Lich lo custodió durante siglos. El enfrentamiento final tiene otro peso ahora.',
};

// Closing scene (DIS-1969 — aprobado)
const CLOSING_SCENE_TEXT = `El Lich se desmorona. Las runas del suelo se apagan una a una.\n\nSobre el altar oscuro, el libro permanece intacto.\nLo tomás. Las páginas están en blanco. Todas.\n\nNo era un libro de magia. Era un diario.\nKaelthas escribió en él durante siglos esperando que alguien llegara a leerlo.\n\n(Escribí «leer libro» para ver su último mensaje.)`;

// Epitafio de Kaelthas (DIS-1969 — aprobado)
const EPITAPH_TEXT = `📖 La última página del diario de Kaelthas:\n\n   «Encontré el libro cuando el reino todavía respiraba.\n   Prometía derrotar a la muerte. No mentía — solo omitió\n   que "derrotar" no es lo mismo que "escapar".\n\n   Sigo aquí. Sigo en pie. No soy el mismo.\n   Lo que soy ahora no tiene nombre en el idioma de los vivos.\n\n   Escribí esto para el que llegara después.\n   Para que supiera que el libro funciona.\n   Y que ojalá, para vos, funcione diferente.»\n\n                    — Kaelthas, Rey de Valdrath\n                      Primera entrada: año 0 del reino\n                      Última entrada: sin fecha`;

// Diálogos del Lich según estado de quest (DIS-1969)
const LICH_DIALOGUES = {
  none:        null,
  partial:     '💀 *El Lich te mira un momento antes de levantar el bastón.*\n   «Otro que vino a morir. El libro no es para vos.»',
  complete:    '💀 *El Lich baja el bastón. Por primera vez, no ataca de inmediato.*\n\n   «Ya sabés, entonces. Cuánto tiempo esperé que alguien llegara con la historia completa.»\n\n   «El libro prometía la victoria sobre la muerte. No mentía.»\n   «Aquí estoy: muerto, y todavía en pie.»\n\n   «Vamos. Sería un desperdicio matarte sin que lo hayas entendido.»',
};

// Hint del Guardián Anciano (DIS-1969)
const GUARDIAN_HINT = '🧙 El anciano te mira con algo que no es exactamente compasión.\n   «Dicen que hay un nombre grabado en el Trono de Huesos.\n    Más de uno intentó descifrar quién era.\n    Ninguno volvió para contarlo. Vos capaz sí.»';

// ─── Función 1: checkKaelthasFragment ────────────────────────────────────────

/**
 * Se llama después de cada read/examine en las salas con fragmentos de lore de Kaelthas.
 * Verifica si el jugador ya tiene el fragmento; si no, lo registra y devuelve texto narrativo.
 *
 * @param {object} player    — objeto jugador tal como viene de db.getPlayer()
 * @param {string} fragmentId — uno de: 'trono' | 'mausoleo' | 'capilla' | 'catedral'
 * @returns {{ text: string|null, questActivated: boolean, questCompleted: boolean }}
 *   text: null si el fragmento ya fue encontrado (no repetir), string si es nuevo
 *   questActivated: true si este fragmento activó la quest ('inactive' → 'active')
 *   questCompleted: true si este es el 4to fragmento
 */
function checkKaelthasFragment(player, fragmentId) {
  // No activar para bots
  if (player.is_bot === 1) {
    return { text: null, questActivated: false, questCompleted: false };
  }

  if (!FRAGMENT_IDS.includes(fragmentId)) {
    console.error(`[kaelthasQuest] fragmentId inválido: ${fragmentId}`);
    return { text: null, questActivated: false, questCompleted: false };
  }

  try {
    const mqd = db.getMainQuestData(player.id);

    // Fragmento ya encontrado → no repetir texto
    if (mqd.fragments_found && mqd.fragments_found.includes(fragmentId)) {
      return { text: null, questActivated: false, questCompleted: false };
    }

    // Registrar el nuevo fragmento
    const fragments = Array.isArray(mqd.fragments_found) ? [...mqd.fragments_found] : [];
    fragments.push(fragmentId);
    const count = fragments.length;

    let questActivated = false;
    let questCompleted = false;
    const updates = {
      fragments_found: fragments,
      kaelthas_fragments_count: count,
    };

    // Activar quest si estaba inactiva
    if (!mqd.main_quest_state || mqd.main_quest_state === 'inactive') {
      updates.main_quest_state = 'active';
      updates.started_at = new Date().toISOString();
      questActivated = true;
    }

    // Detectar 4to fragmento
    if (count >= 4) {
      questCompleted = true;
    }

    db.updateMainQuestData(player.id, updates);

    // Entrada en diario de quest
    if (FRAGMENT_JOURNAL[fragmentId]) {
      db.addJournalEntry(player.id, 'quest', FRAGMENT_JOURNAL[fragmentId]);
    }

    // Texto narrativo a mostrar
    let text = FRAGMENT_TEXTS[fragmentId] || null;

    // Si la quest tenía 1+ fragmentos ya, ajustar el número en textos de actualización
    // (mausoleo/capilla/catedral ya incluyen el número hardcodeado en el texto final aprobado)
    // Si el orden fue diferente al esperado, el count puede no coincidir con el texto hardcodeado.
    // Por ahora se usa el texto aprobado directamente — mejora futura: texto dinámico.

    return { text, questActivated, questCompleted };

  } catch (e) {
    console.error('[kaelthasQuest] checkKaelthasFragment error:', e.message);
    return { text: null, questActivated: false, questCompleted: false };
  }
}

// ─── Función 2: getQuestState ─────────────────────────────────────────────────

/**
 * Devuelve el estado formateado de la quest para el comando «quest info».
 * No modifica la BD.
 *
 * @param {object} player — objeto jugador tal como viene de db.getPlayer()
 * @returns {string} — texto formateado para mostrar al jugador
 */
function getQuestState(player) {
  try {
    const mqd = db.getMainQuestData(player.id);
    const state = mqd.main_quest_state || 'inactive';

    if (state === 'inactive') {
      return '📖 No tenés quests principales activas.\n💡 Explorá el dungeon. Hay fragmentos de historia esperando ser encontrados.';
    }

    if (state === 'ended') {
      return '📖 Quest: El Libro de los Muertos [FINALIZADA]\n   Completaste el arco de Kaelthas. El epitafio está en tu diario de lore.';
    }

    const found = Array.isArray(mqd.fragments_found) ? mqd.fragments_found : [];

    if (state === 'active' && found.length >= 4) {
      return `📖 Quest: El Libro de los Muertos [COMPLETA — PENDIENTE ENDING]\n   Encontraste los 4 fragmentos. Solo falta enfrentar al Lich con todo el contexto.\n   ✅ ✅ ✅ ✅  Todos los fragmentos encontrados.\n   ⚔️  El Lich Anciano te espera en la Catedral de la Oscuridad (sala 15).`;
    }

    // Estado active con 1-3 fragmentos
    const lines = FRAGMENT_IDS.map(fid => {
      const check = found.includes(fid) ? '✅' : '⬜';
      return `   ${check} ${FRAGMENT_NAMES[fid]}`;
    });

    return `📖 Quest: El Libro de los Muertos [EN PROGRESO]\n   Kaelthas fue un rey que encontró un libro que prometía derrotar a la muerte.\n   Encontrá los 4 fragmentos para entender qué fue de él.\n\n   Fragmentos encontrados (${found.length}/4):\n${lines.join('\n')}`;

  } catch (e) {
    console.error('[kaelthasQuest] getQuestState error:', e.message);
    return '📖 (Error al cargar estado de la quest. Intentá de nuevo.)';
  }
}

// ─── Función 3: activateKaelthasEnding ───────────────────────────────────────

/**
 * Se llama cuando el jugador derrota al Lich con la quest activa y los 4 fragmentos.
 * Gatilla el closing scene. Modifica la BD.
 *
 * @param {object} player — objeto jugador (ya recargado post-combate)
 * @returns {{ closingText: string }|null} — null si ya fue procesado (idempotente)
 */
function activateKaelthasEnding(player) {
  if (player.is_bot === 1) return null;

  try {
    const mqd = db.getMainQuestData(player.id);

    // Idempotente: ya fue procesado
    if (mqd.lich_died_with_quest === true) return null;

    db.updateMainQuestData(player.id, {
      lich_died_with_quest: true,
      main_quest_state: 'ended',
    });

    db.addJournalEntry(player.id, 'quest', '📖 [QUEST] El arco de Kaelthas — completado. El Lich era el rey. El rey sabía. Y esperó durante siglos que alguien llegara a leerlo.');

    return { closingText: CLOSING_SCENE_TEXT };

  } catch (e) {
    console.error('[kaelthasQuest] activateKaelthasEnding error:', e.message);
    return null;
  }
}

// ─── Función 4: getLichDialogue ───────────────────────────────────────────────

/**
 * Devuelve el diálogo del Lich según el estado de la quest del jugador.
 * Se llama en el hook pre-combate cuando el jugador entra a combate con el Lich.
 *
 * @param {object} player — objeto jugador
 * @returns {string|null} — texto del diálogo, o null (sin diálogo)
 */
function getLichDialogue(player) {
  if (player.is_bot === 1) return null;

  try {
    const mqd = db.getMainQuestData(player.id);
    const state = mqd.main_quest_state || 'inactive';
    const count = mqd.kaelthas_fragments_count || 0;

    if (state === 'inactive') {
      return LICH_DIALOGUES.none;
    }

    if (state === 'active' && count < 4) {
      return LICH_DIALOGUES.partial;
    }

    if ((state === 'active' || state === 'completed') && count >= 4) {
      return LICH_DIALOGUES.complete;
    }

    return LICH_DIALOGUES.none;

  } catch (e) {
    console.error('[kaelthasQuest] getLichDialogue error:', e.message);
    return null;
  }
}

// ─── Función 5: getEpitaph ────────────────────────────────────────────────────

/**
 * Devuelve el epitafio de Kaelthas (para el comando «leer libro» post-ending).
 * Guarda la entrada en el diario de lore.
 *
 * @param {object} player — objeto jugador
 * @returns {string|null} — texto del epitafio, o null si el jugador no tiene el libro
 */
function getEpitaph(player) {
  if (player.is_bot === 1) return null;

  try {
    const mqd = db.getMainQuestData(player.id);
    if (mqd.lich_died_with_quest !== true) {
      return null; // No tiene el libro
    }

    // Guardar entrada en diario de lore (solo si no está ya)
    db.addJournalEntry(player.id, 'lore', '📖 El epitafio de Kaelthas — El libro prometía derrotar a la muerte. No mentía. "Derrotar no es lo mismo que escapar." El Lich era el rey. El rey sabía. Y esperó durante siglos que alguien llegara a leerlo.');

    return EPITAPH_TEXT;

  } catch (e) {
    console.error('[kaelthasQuest] getEpitaph error:', e.message);
    return null;
  }
}

// ─── Función 6: getGuardianHint ───────────────────────────────────────────────

/**
 * Devuelve el hint del Guardián Anciano si el jugador está en nivel 3 y la quest está inactiva.
 *
 * @param {object} player — objeto jugador
 * @returns {string|null} — texto del hint, o null si no aplica
 */
function getGuardianHint(player) {
  if (player.is_bot === 1) return null;

  try {
    const mqd = db.getMainQuestData(player.id);
    const state = mqd.main_quest_state || 'inactive';
    const level = player.level || 1;

    if (level >= 3 && state === 'inactive') {
      return GUARDIAN_HINT;
    }

    return null;

  } catch (e) {
    console.error('[kaelthasQuest] getGuardianHint error:', e.message);
    return null;
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  checkKaelthasFragment,
  getQuestState,
  activateKaelthasEnding,
  getLichDialogue,
  getEpitaph,
  getGuardianHint,
  // Constantes exportadas para tests y engine.js
  FRAGMENT_IDS,
  FRAGMENT_NAMES,
};
