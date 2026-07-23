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

// Inicializar BD (async) y activar campaña
async function main() {
  await db.init();

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
      console.log('');
      console.log('⚠️  IMPORTANTE: Si el servidor está corriendo, reiniciarlo para que tome los cambios.');
      console.log('   sql.js es in-memory — el proceso del servidor no puede leer cambios del disco.');
    }
    process.exit(0);
  } else {
    console.error(`❌ No se pudo activar la campaña "${campaignId}".`);
    console.error('   Verificar que exista en la tabla campaigns (requiere seed).');
    process.exit(1);
  }
}

main().catch(e => {
  console.error('❌ Error inesperado:', e.message);
  process.exit(1);
});

// BUG-1906: IMPORTANTE — sql.js es in-memory. Si el servidor ya está corriendo cuando
// se ejecuta este script, los cambios en el archivo de disco NO se reflejarán en el
// proceso del servidor (que tiene su propia copia en RAM). El flujo correcto es:
//   1. Parar el servidor (Ctrl+C / kill)
//   2. Ejecutar este script
//   3. Iniciar el servidor nuevamente (node server/index.js)
// ⚠️  Si el servidor está corriendo, reiniciarlo para que tome los cambios.
