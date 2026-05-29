#!/usr/bin/env node
/**
 * scripts/reset-db.js
 * Borra la base de datos SQLite y la regenera desde cero con el seed inicial.
 * 
 * CUIDADO: Borra todos los jugadores, progreso e historial.
 * 
 * Uso: npm run reset
 *      node scripts/reset-db.js [--yes]  # --yes para saltar confirmación
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../db/dungeon.sqlite');

const skipConfirm = process.argv.includes('--yes');

async function main() {
  console.log('⚠  RESET DE BASE DE DATOS — Dungeon of Echoes');
  console.log(`   Archivo: ${DB_PATH}`);

  if (!skipConfirm) {
    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    await new Promise((resolve) => {
      readline.question('\n¿Estás seguro? Esto borrará TODOS los datos. (sí/no): ', (ans) => {
        readline.close();
        if (!['si', 'sí', 'yes', 'y', 's'].includes(ans.toLowerCase().trim())) {
          console.log('Operación cancelada.');
          process.exit(0);
        }
        resolve();
      });
    });
  }

  // Borrar archivo SQLite
  if (fs.existsSync(DB_PATH)) {
    fs.unlinkSync(DB_PATH);
    console.log('✓ Base de datos eliminada.');
  } else {
    console.log('  (No existía base de datos, creando desde cero)');
  }

  // Re-inicializar y seed
  console.log('  Inicializando BD...');
  const db = require('../server/db/db');
  await db.init();

  console.log('  Insertando seed...');
  // Forzar seed limpio
  const { ROOMS, MONSTERS } = require('../server/db/seed');
  for (const room of ROOMS) db.upsertRoom(room);
  for (const monster of MONSTERS) db.upsertMonster(monster);

  await db.persist();

  console.log(`\n✅ Reset completo: ${ROOMS.length} habitaciones y ${MONSTERS.length} monstruos.`);
  console.log('   Corré "npm start" para iniciar el servidor.\n');
  process.exit(0);
}

main().catch(err => {
  console.error('Error en reset:', err);
  process.exit(1);
});
