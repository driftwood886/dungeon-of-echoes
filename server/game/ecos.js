'use strict';

/**
 * ecos.js — Sistema Ecos de los Caídos
 *
 * Gestiona cicatrices de combate (room_scars) y loot recuperable de jugadores
 * caídos (fallen_loot). Ver disenos/epic-2323-schema-bd.md y
 * disenos/epic-2324-api-interna.md para el diseño completo.
 *
 * EPIC: Ecos de los Caídos (EPIC-2328-IMPL)
 */

const db = require('../db/db');
const { getItemRarity, isJunkItem } = require('./items');

// ── Ítems que nunca caen al suelo ─────────────────────────────────────────────

const QUEST_ITEMS_EXACT = new Set([
  'llave oxidada',
  'llave maestra',
  'carta sellada',
  'tomo sellado',
  'fragmento de sello',
  'frasco purificador',
]);

/**
 * Determina si un ítem es de quest / campaña y NO debe caer al suelo.
 * @param {string} name
 * @returns {boolean}
 */
function isQuestItem(name) {
  const n = (name || '').toLowerCase().trim();
  return QUEST_ITEMS_EXACT.has(n) || n.includes('llave');
}

// ── Lógica de caída de loot ───────────────────────────────────────────────────

/**
 * Calcula qué ítems del inventario quedan al suelo al morir el jugador.
 * Reglas: máximo 3, solo rareza 'común', no quest, no junk.
 *
 * @param {Array|string} inventory  Array de nombres de ítems (o JSON stringificado)
 * @returns {string[]}              Lista de nombres de ítems que caen (máx 3)
 */
function calcFallenLoot(inventory) {
  const inv = Array.isArray(inventory)
    ? inventory
    : JSON.parse(inventory || '[]');

  const eligible = inv.filter(item => {
    const name = typeof item === 'string' ? item : (item.name || '');
    if (!name) return false;
    return (
      getItemRarity(name) === 'común' &&
      !isJunkItem(name) &&
      !isQuestItem(name)
    );
  });

  return eligible
    .slice(0, 3)
    .map(i => (typeof i === 'string' ? i : i.name));
}

// ── Cicatrices de combate ─────────────────────────────────────────────────────

/**
 * Agrega una cicatriz de combate intenso a una sala.
 * Duración: 3 horas.
 *
 * @param {number} roomId
 * @param {{ player_name: string, damage_dealt: number, monster_name: string }} context
 */
function addCombatScar(roomId, context) {
  const expiresAt = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
  db.addRoomScar(roomId, 'combat_intense', JSON.stringify(context), expiresAt);
}

/**
 * Agrega una cicatriz de muerte de jugador a una sala.
 * Duración: 6 horas.
 *
 * @param {number} roomId
 * @param {{ player_name: string, class: string, level: number, cause: string }} context
 */
function addPlayerDeathScar(roomId, context) {
  const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  db.addRoomScar(roomId, 'player_death', JSON.stringify(context), expiresAt);
}

/**
 * Agrega una cicatriz de boss kill a una sala.
 * Duración: 8 horas.
 *
 * @param {number} roomId
 * @param {{ player_name: string, boss_name: string, player_won: boolean }} context
 */
function addBossKillScar(roomId, context) {
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
  db.addRoomScar(roomId, 'boss_kill', JSON.stringify(context), expiresAt);
}

// ── Renderizado ───────────────────────────────────────────────────────────────

/**
 * Formatea una cicatriz como línea de texto para mostrar en la sala.
 *
 * @param {{ scar_type: string, context: string, created_at: string }} scar
 * @returns {string}
 */
function formatScar(scar) {
  let ctx = {};
  try {
    ctx = JSON.parse(scar.context || '{}');
  } catch (_) { /* contexto mal formado — ignorar */ }

  const ageMs = Date.now() - new Date(scar.created_at).getTime();
  const ageHours = Math.round(ageMs / 3_600_000);
  const ageLabel = ageHours < 1 ? 'hace menos de 1h' : `hace ${ageHours}h`;

  switch (scar.scar_type) {
    case 'combat_intense':
      return `🩸 Marcas de combate reciente en las paredes. (${ageLabel})`;

    case 'player_death':
      return `🩸 Las paredes muestran marcas de impacto — alguien libró un combate intenso aquí. El olor a sangre todavía no se fue. (${ageLabel})`;

    case 'boss_kill': {
      const who = ctx.boss_name || 'el boss';
      const outcome = ctx.player_won ? 'venció' : 'cayó';
      return `⚔️ La tierra frente a vos está marcada — alguien enfrentó a ${who} aquí y ${outcome}. Los rastros son frescos. (${ageLabel})`;
    }

    default:
      return `🩸 Algo ocurrió aquí. (${ageLabel})`;
  }
}

/**
 * Genera el bloque de texto de ecos para mostrar al hacer `look` en una sala.
 * Incluye fallen_loot y cicatrices activas.
 * Realiza cleanup lazy de registros expirados.
 *
 * @param {number} roomId
 * @returns {string}  Cadena lista para concatenar a la descripción de la sala (puede ser vacía)
 */
function renderRoomEcos(roomId) {
  const lines = [];

  // ── Fallen loot ──────────────────────────────────────────────────────────
  let loot = [];
  try {
    loot = db.getFallenLootInRoom(roomId); // incluye lazy cleanup
  } catch (e) {
    console.warn('[ecos] Error al leer fallen_loot:', e.message);
  }

  if (loot.length > 0) {
    // Agrupar por fallen_player
    const byPlayer = {};
    for (const row of loot) {
      if (!byPlayer[row.fallen_player]) {
        byPlayer[row.fallen_player] = {
          class: row.fallen_class,
          level: row.fallen_level,
          items: [],
        };
      }
      byPlayer[row.fallen_player].items.push(row.item_name);
    }

    lines.push('');
    for (const [pname, data] of Object.entries(byPlayer)) {
      const classLabel = data.class
        ? `, ${data.class} Niv.${data.level}`
        : '';
      const itemList = data.items.map(i => `⬜ ${i}`).join(', ');
      lines.push(`📦 Pertenencias de ${pname}${classLabel}: [${itemList}]`);
    }
    lines.push('   (recogelas con: loot ecos)');
  }

  // ── Cicatrices ───────────────────────────────────────────────────────────
  let scars = [];
  try {
    scars = db.getActiveRoomScars(roomId); // incluye lazy cleanup
  } catch (e) {
    console.warn('[ecos] Error al leer room_scars:', e.message);
  }

  if (scars.length > 0) {
    // Solo la cicatriz más reciente de cada tipo
    const byType = {};
    for (const scar of scars) {
      if (!byType[scar.scar_type] ||
          scar.created_at > byType[scar.scar_type].created_at) {
        byType[scar.scar_type] = scar;
      }
    }

    lines.push('');
    for (const scar of Object.values(byType)) {
      lines.push(formatScar(scar));
    }
  }

  return lines.join('\n');
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  isQuestItem,
  calcFallenLoot,
  addCombatScar,
  addPlayerDeathScar,
  addBossKillScar,
  renderRoomEcos,
  formatScar,
};
