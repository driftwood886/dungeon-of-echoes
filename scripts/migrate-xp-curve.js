/**
 * migrate-xp-curve.js — DIS-D282
 *
 * Recalcula el campo `level` de todos los jugadores según la nueva curva cuadrática.
 * Uso: node scripts/migrate-xp-curve.js
 */

'use strict';

const dbModule = require('../server/db/db');
const { levelFromXp, xpForLevel } = require('../server/game/xp');

async function main() {
  // Inicializar la DB (carga el archivo sqlite desde disco)
  await dbModule.init();

  console.log('=== Migración DIS-D282: recalcular niveles con nueva curva de XP ===\n');

  const sqlDb = dbModule.raw();

  const stmt = sqlDb.prepare('SELECT id, username, xp, level FROM players ORDER BY xp DESC');
  const players = [];
  while (stmt.step()) {
    players.push(stmt.getAsObject());
  }
  stmt.free();

  console.log(`Jugadores encontrados: ${players.length}\n`);

  let migrated = 0;
  let unchanged = 0;

  for (const p of players) {
    const oldLevel = p.level || 1;
    const xp = p.xp || 0;
    const newLevel = levelFromXp(xp);

    if (newLevel !== oldLevel) {
      dbModule.updatePlayer(p.id, { level: newLevel });
      console.log(`  ✏️  ${String(p.username).padEnd(20)} XP: ${String(xp).padStart(5)} | nivel: ${oldLevel} → ${newLevel}`);
      migrated++;
    } else {
      unchanged++;
    }
  }

  // Persistir los cambios a disco
  await dbModule.persist();

  console.log(`\n✅ Migración completa: ${migrated} jugadores actualizados, ${unchanged} sin cambio.`);
  console.log('\nTabla de referencia (nueva curva):');
  for (let L = 1; L <= 20; L++) {
    const xpTotal = xpForLevel(L);
    const xpNext = L < 20 ? xpForLevel(L+1) - xpTotal : '(MAX)';
    console.log(`  Nivel ${String(L).padStart(2)}: ${String(xpTotal).padStart(5)} XP total, +${xpNext} para siguiente`);
  }
}

main().catch(err => {
  console.error('Error en migración:', err);
  process.exit(1);
});
