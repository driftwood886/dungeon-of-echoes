#!/usr/bin/env node
// EPIC-1897: Script de admin para activar una campaña narrativa
// Uso: node scripts/activate-campaign.js <campaignId>
// Ejemplo: node scripts/activate-campaign.js arquinecromante_veth

'use strict';

const campaignId = process.argv[2];

if (!campaignId) {
  console.error('❌ Uso: node scripts/activate-campaign.js <campaignId>');
  console.error('   Ejemplo: node scripts/activate-campaign.js arquinecromante_veth');
  process.exit(1);
}

const db = require('../server/db/db');

// Inicializar BD
db.init();

// Verificar que la campaña existe
const { getActiveCampaign, activateCampaign } = db;

console.log(`🗡️  Activando campaña: "${campaignId}"...`);
const success = activateCampaign(campaignId);

if (success) {
  const data = getActiveCampaign();
  if (data) {
    console.log(`✅ Campaña activada correctamente:`);
    console.log(`   Nombre:    ${data.campaign.name}`);
    console.log(`   ID:        ${data.campaign.id}`);
    console.log(`   Objetivo:  ${data.goal_target} (${data.campaign.goal_key})`);
    console.log(`   Duración:  ${data.days_remaining} días restantes`);
    console.log(`   Estado:    ${data.active.state}`);
    console.log(`   Termina:   ${data.active.ends_at}`);
  }
  process.exit(0);
} else {
  console.error(`❌ No se pudo activar la campaña "${campaignId}".`);
  console.error('   Verificar que exista en la tabla campaigns (requiere seed).');
  process.exit(1);
}
