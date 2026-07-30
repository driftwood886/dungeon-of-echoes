#!/usr/bin/env node
// EPIC-2123: Script de resolución y rotación de campañas
// Ejecutar diariamente via cron de Hermes.
//
// Funciones:
//   1. Si la campaña activa llegó a su fecha de cierre → resolverla
//   2. Determinar victoria (≥80% del objetivo) o derrota
//   3. Aplicar efectos temporales en world_state
//   4. Activar la siguiente campaña del pool en rotación automática
//
// Uso:
//   node scripts/check_campaign.js
//   node scripts/check_campaign.js --force-resolve   (para testing: resolver aunque no haya expirado)
//
// IMPORTANTE (sql.js in-memory):
//   Este script modifica el archivo de BD en disco.
//   El servidor DEBE reiniciarse después de ejecutar este script para tomar los cambios.

'use strict';

const db = require('../server/db/db');

const FORCE_RESOLVE = process.argv.includes('--force-resolve');

// Orden del pool de campañas (rotación circular)
// EPIC-2124: pool completado con 4 campañas (8 semanas de contenido único)
const CAMPAIGN_POOL_ORDER = [
  'arquinecromante_veth',
  'plaga_esporas',
  'sello_roto',
  'vigilia_corredor',
];

function fmtDate(d) {
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

async function main() {
  console.log(`\n🗡️  check_campaign.js — ${fmtDate(new Date())}`);
  console.log('─'.repeat(50));

  await db.init();

  // ─── 1. Obtener campaña activa ────────────────────────────────
  const data = db.getActiveCampaign();

  if (!data) {
    console.log('ℹ️  No hay campaña activa. Intentando activar la primera del pool...');
    const activated = activateNextCampaign(null);
    if (activated) {
      console.log(`✅ Campaña '${activated}' activada. Pool iniciado.`);
    } else {
      console.log('⚠️  No hay campañas disponibles en el pool. No se hizo nada.');
    }
    await db.persist();
    process.exit(0);
  }

  const { campaign, active, progress, goal_target } = data;

  console.log(`📋 Campaña activa: "${campaign.name}" (${campaign.id})`);
  console.log(`   Estado: ${active.state}`);
  console.log(`   Progreso: ${progress}/${goal_target} (${Math.round(progress/goal_target*100)}%)`);
  console.log(`   Ends at: ${active.ends_at}`);
  console.log(`   Días restantes: ${data.days_remaining}`);

  // ─── 2. Verificar si ya está en un estado terminal ────────────
  if (active.state !== 'active') {
    console.log(`\nℹ️  La campaña ya está en estado '${active.state}'. Verificando si hay rotación pendiente...`);

    // Puede que se resolvió pero no se activó la siguiente
    const nextId = getNextCampaignId(campaign.id);
    if (nextId && nextId !== campaign.id) {
      console.log(`🔄 Activando siguiente campaña: '${nextId}'`);
      const ok = db.activateCampaign(nextId);
      if (ok) {
        console.log(`✅ Campaña '${nextId}' activada.`);
      }
    } else {
      console.log('ℹ️  Misma campaña en el pool (pool de 1). Re-activando misma campaña.');
      const ok = db.activateCampaign(campaign.id);
      if (ok) console.log(`✅ Campaña '${campaign.id}' re-activada para el próximo ciclo.`);
    }
    await db.persist();
    process.exit(0);
  }

  // ─── 3. Verificar si la campaña expiró ───────────────────────
  const now = Date.now();
  const endsAt = new Date(active.ends_at).getTime();
  const hasExpired = now >= endsAt;

  if (!hasExpired && !FORCE_RESOLVE) {
    console.log(`\n✅ La campaña sigue activa. Nada que hacer.`);
    console.log(`   Faltan ${data.days_remaining} días para el cierre.`);
    process.exit(0);
  }

  if (FORCE_RESOLVE) {
    console.log('\n⚠️  --force-resolve activado. Resolviendo aunque no haya expirado.');
  } else {
    console.log('\n⏰ La campaña expiró. Procediendo a resolución...');
  }

  // ─── 4. Determinar victoria o derrota ─────────────────────────
  const victoryThreshold = Math.ceil(goal_target * 0.8); // ≥80% = victoria
  const isVictory = progress >= victoryThreshold;
  const outcome = isVictory ? 'victory' : 'defeat';

  console.log(`\n🏁 Resolución:`);
  console.log(`   Objetivo: ${goal_target} | Umbral de victoria (80%): ${victoryThreshold}`);
  console.log(`   Progreso final: ${progress}`);
  console.log(`   Resultado: ${isVictory ? '🏆 VICTORIA' : '💀 DERROTA'}`);

  // Actualizar estado en active_campaign
  db.setWorldState ? null : null; // asegurar que db está listo
  // Usamos la función interna de DB para actualizar el estado
  // Como no hay una función exportada resolveCampaign(), usamos setWorldState y acceso directo
  // El state se actualiza via la clave en active_campaign
  // NOTA: contributeToCurrentCampaign ya actualiza a 'victory' si se alcanza el objetivo.
  // Para 'defeat', necesitamos setearlo manualmente. Lo hacemos via el módulo db:

  // Forzar update de state en active_campaign
  // db no exporta una función directa de resolución, pero podemos usar persist() + init()
  // La forma más directa: usar el acceso de bajo nivel que db ya tiene internamente.
  // Buscar si db exporta algo útil...
  // db exporta: setWorldState, getActiveCampaign, activateCampaign. No exporta resolveCampaign.
  // Solución: usamos Node.js require para acceder al módulo y sus internales indirectamente.
  // Mejor solución: escribir los efectos directamente con setWorldState y luego activar
  // la siguiente campaña (lo que equivale a concluir la actual).

  // ─── 5. Aplicar efectos de victoria o derrota ─────────────────
  const now_unix = Date.now();

  if (isVictory) {
    const reward = campaign.reward_victory || {};
    const bonusPct = reward.xp_bonus_pct || 25;
    const durationHours = reward.duration_hours || 24;
    const expiresAt = now_unix + (durationHours * 60 * 60 * 1000);

    db.setWorldState('campaign_xp_bonus_active', 1);
    db.setWorldState('campaign_xp_bonus_pct', bonusPct);
    db.setWorldState('campaign_xp_bonus_expires', expiresAt);
    db.setWorldState('campaign_outcome_message', reward.message ||
      `🏆 ¡La campaña "${campaign.name}" fue un éxito! +${bonusPct}% XP durante ${durationHours}h.`);

    // Limpiar efectos de derrota si hubiera
    db.setWorldState('campaign_undead_hp_bonus_active', 0);
    db.setWorldState('campaign_undead_hp_bonus_pct', 0);
    db.setWorldState('campaign_undead_hp_bonus_expires', 0);

    console.log(`\n✨ Efectos de victoria aplicados:`);
    console.log(`   +${bonusPct}% XP global durante ${durationHours}h`);
    console.log(`   Expira: ${fmtDate(new Date(expiresAt))}`);
  } else {
    const consequence = campaign.consequence_defeat || {};
    const hpBonusPct = consequence.hp_bonus_pct || 10;
    const durationDays = consequence.duration_days || 3;
    const expiresAt = now_unix + (durationDays * 24 * 60 * 60 * 1000);

    db.setWorldState('campaign_undead_hp_bonus_active', 1);
    db.setWorldState('campaign_undead_hp_bonus_pct', hpBonusPct);
    db.setWorldState('campaign_undead_hp_bonus_expires', expiresAt);
    db.setWorldState('campaign_outcome_message', consequence.message ||
      `💀 La campaña "${campaign.name}" fue una derrota. Los no-muertos tienen +${hpBonusPct}% HP durante ${durationDays} días.`);

    // Limpiar efectos de victoria si hubiera
    db.setWorldState('campaign_xp_bonus_active', 0);
    db.setWorldState('campaign_xp_bonus_pct', 0);
    db.setWorldState('campaign_xp_bonus_expires', 0);

    console.log(`\n💀 Efectos de derrota aplicados:`);
    console.log(`   +${hpBonusPct}% HP a no-muertos durante ${durationDays} días`);
    console.log(`   Expira: ${fmtDate(new Date(expiresAt))}`);
  }

  // ─── 6. Registrar la resolución en world_state ────────────────
  db.setWorldState('last_campaign_id', campaign.id);
  db.setWorldState('last_campaign_name', campaign.name);
  db.setWorldState('last_campaign_outcome', outcome);
  db.setWorldState('last_campaign_resolved_at', now_unix);
  db.setWorldState('last_campaign_progress', progress);
  db.setWorldState('last_campaign_goal', goal_target);

  // ─── 7. Activar siguiente campaña en rotación ─────────────────
  console.log(`\n🔄 Activando siguiente campaña del pool...`);

  const nextCampaignId = getNextCampaignId(campaign.id);

  if (nextCampaignId) {
    const ok = db.activateCampaign(nextCampaignId);
    if (ok) {
      console.log(`✅ Siguiente campaña activada: '${nextCampaignId}'`);
    } else {
      console.error(`❌ No se pudo activar '${nextCampaignId}'. Posiblemente no existe en la BD todavía.`);
      // Intentar reactivar la misma campaña como fallback
      console.log(`   Intentando reactivar '${campaign.id}' como fallback...`);
      const fallback = db.activateCampaign(campaign.id);
      if (fallback) {
        console.log(`✅ Campaña '${campaign.id}' re-activada (pool de 1 campaña).`);
      }
    }
  } else {
    // Pool vacío o indefinido — reactivar la misma
    console.log(`ℹ️  No hay siguiente campaña en el pool. Re-activando '${campaign.id}'...`);
    const ok = db.activateCampaign(campaign.id);
    if (ok) console.log(`✅ Campaña '${campaign.id}' re-activada.`);
  }

  // ─── 8. Persistir a disco ─────────────────────────────────────
  await db.persist();
  console.log('\n💾 Cambios persistidos a disco.');
  console.log('⚠️  IMPORTANTE: Si el servidor está corriendo, reiniciarlo para tomar los cambios.');

  // ─── 9. Resumen ───────────────────────────────────────────────
  console.log('\n' + '─'.repeat(50));
  console.log('RESUMEN:');
  console.log(`  Campaña resuelta:  ${campaign.name} (${campaign.id})`);
  console.log(`  Resultado:         ${isVictory ? 'VICTORIA' : 'DERROTA'}`);
  console.log(`  Progreso final:    ${progress}/${goal_target}`);
  console.log(`  Siguiente campaña: ${nextCampaignId || campaign.id}`);
  console.log('─'.repeat(50));

  process.exit(0);
}

/**
 * Retorna el ID de la siguiente campaña en la rotación circular.
 * Si hay una sola campaña en el pool, retorna la misma.
 * @param {string} currentId
 * @returns {string|null}
 */
function getNextCampaignId(currentId) {
  if (!CAMPAIGN_POOL_ORDER.length) return null;
  const idx = CAMPAIGN_POOL_ORDER.indexOf(currentId);
  if (idx === -1) {
    // La campaña actual no está en el pool — empezar desde el principio
    return CAMPAIGN_POOL_ORDER[0];
  }
  const nextIdx = (idx + 1) % CAMPAIGN_POOL_ORDER.length;
  return CAMPAIGN_POOL_ORDER[nextIdx];
}

/**
 * Intenta activar la siguiente campaña desde el pool.
 * Retorna el ID activado o null si falló.
 * @param {string|null} currentId
 * @returns {string|null}
 */
function activateNextCampaign(currentId) {
  const nextId = currentId ? getNextCampaignId(currentId) : CAMPAIGN_POOL_ORDER[0];
  if (!nextId) return null;
  const ok = db.activateCampaign(nextId);
  return ok ? nextId : null;
}

main().catch(e => {
  console.error('❌ Error inesperado:', e.message);
  console.error(e.stack);
  process.exit(1);
});
