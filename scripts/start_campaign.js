#!/usr/bin/env node
// EPIC-2121: Script de activación de campaña
// Uso: node scripts/start_campaign.js <campaign_id>
// Ejemplo: node scripts/start_campaign.js arquinecromante_veth
//
// Output esperado:
//   Campaña 'arquinecromante_veth' activada.
//   Inicio: [fecha]. Cierre: [fecha+14días]. Objetivo: 120 rituales.
//
// IMPORTANTE (sql.js in-memory):
//   1. Parar el servidor antes de ejecutar este script
//   2. Ejecutar: node scripts/start_campaign.js <id>
//   3. Reiniciar el servidor para que tome los cambios del disco

'use strict';

const campaignId = process.argv[2];

if (!campaignId) {
  console.error('❌ Uso: node scripts/start_campaign.js <campaign_id>');
  console.error('   Ejemplo: node scripts/start_campaign.js arquinecromante_veth');
  process.exit(1);
}

const db = require('../server/db/db');

async function main() {
  await db.init();

  console.log(`🗡️  Activando campaña: "${campaignId}"...`);

  const success = db.activateCampaign(campaignId);

  if (!success) {
    console.error(`❌ No se pudo activar la campaña "${campaignId}".`);
    console.error('   Verificar que exista en la tabla campaigns (requiere seed).');
    process.exit(1);
  }

  const data = db.getActiveCampaign();
  if (!data) {
    console.error('❌ Error inesperado: campaña activada pero no recuperable.');
    process.exit(1);
  }

  const { campaign, active, goal_target } = data;

  const inicioDate = new Date(active.started_at);
  const cierreDate = new Date(active.ends_at);

  const fmtDate = (d) => d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  console.log(`✅ Campaña '${campaign.id}' activada.`);
  console.log(`   Inicio: ${fmtDate(inicioDate)}. Cierre: ${fmtDate(cierreDate)}. Objetivo: ${goal_target} ${campaign.goal_key.replace(/_/g, ' ')}.`);
  console.log('');
  console.log('⚠️  IMPORTANTE: Si el servidor está corriendo, reiniciarlo para que tome los cambios.');
  console.log('   sql.js es in-memory — los cambios en disco no se reflejan en el proceso activo.');

  process.exit(0);
}

main().catch(e => {
  console.error('❌ Error inesperado:', e.message);
  process.exit(1);
});
