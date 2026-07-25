# Schema BD — Quest Principal de Kaelthas (DIS-1967)

**Fecha:** 2026-07-25  
**Epic:** EPIC-KAELTHAS — La Quest de Kaelthas  
**Estado:** Implementado en migración — columna `main_quest_data` en tabla `players`

---

## Columna en BD

```sql
ALTER TABLE players ADD COLUMN main_quest_data TEXT NOT NULL DEFAULT '{}';
```

Tipo: `TEXT` con JSON serializado. Default vacío `'{}'` — los helpers aplican defaults al parsear.

**Migración:** incluida en el array `migrations[]` de `server/db/db.js` (DIS-1967).

---

## Schema del objeto JSON

```typescript
interface MainQuestData {
  // Array de IDs de fragmentos ya encontrados por el jugador.
  // Posibles valores: 'trono' | 'mausoleo' | 'capilla' | 'catedral'
  fragments_found: string[];

  // Estado general de la quest principal.
  // 'inactive'  — el jugador no encontró ningún fragmento aún
  // 'active'    — encontró al menos 1 fragmento, la quest está en progreso
  // 'completed' — encontró los 4 fragmentos y derrotó al Lich con ellos
  // 'ended'     — cerró el closing scene / leyó el epitafio
  main_quest_state: 'inactive' | 'active' | 'completed' | 'ended';

  // Contador de fragmentos encontrados (0-4). Redundante con fragments_found.length
  // pero útil para queries SQL sin parsear JSON.
  kaelthas_fragments_count: number;

  // true si el jugador mató al Lich teniendo la quest activa con 4 fragmentos.
  // Gatilla el closing scene y el legado especial "La Memoria de Kaelthas".
  lich_died_with_quest: boolean;

  // ISO timestamp de cuando el jugador activó la quest (primer fragmento).
  // null si la quest todavía está 'inactive'.
  started_at: string | null;
}
```

---

## Fragmentos de la quest — Mapa de triggers

| ID fragmento | Sala | Nro | Trigger (comando) | Nota |
|---|---|---|---|---|
| `'trono'` | Sala del Trono | 9 | `read` (inscripción de Hermana Vela) | Activa la quest si está `inactive` |
| `'mausoleo'` | Galería de Hielo | 12 | `examine columnas` | |
| `'capilla'` | Capilla Olvidada | 5 | `examine altar` | |
| `'catedral'` | Catedral de la Oscuridad | 15 | `examine altar catedral` | Nuevo examine — no existe todavía |

**El orden no importa.** Los 4 fragmentos se pueden encontrar en cualquier secuencia. La quest se activa con el primero que encuentre.

---

## Defaults

```javascript
const MQD_DEFAULTS = {
  fragments_found: [],
  main_quest_state: 'inactive',
  kaelthas_fragments_count: 0,
  lich_died_with_quest: false,
  started_at: null,
};
```

---

## API de acceso (helpers en db.js)

```javascript
// Importar desde server/db/db.js:
const { getMainQuestData, updateMainQuestData } = require('./db/db');

// Leer estado de la quest de un jugador (devuelve objeto con defaults si falta):
const mqd = getMainQuestData(player.id);
// → { fragments_found: [], main_quest_state: 'inactive', ... }

// Actualizar parcialmente (merge):
updateMainQuestData(player.id, {
  fragments_found: [...mqd.fragments_found, 'trono'],
  main_quest_state: 'active',
  kaelthas_fragments_count: 1,
  started_at: new Date().toISOString(),
});
```

---

## Decisiones de diseño

1. **JSON en columna, no tabla separada** — La quest es un sistema de un solo jugador, sin queries cross-player. Una columna JSON es suficiente y mantiene la paridad con cómo se manejan otros sistemas similares (quest_progress, forage_data, npc_memory, etc.).

2. **El progreso no se resetea con la muerte** — El jugador puede morir y volver a continuar desde donde estaba. Incentiva reintento sin penalizar la exploración de lore.

3. **`lich_died_with_quest` separado de `main_quest_state`** — Distingue "completé los 4 fragmentos" de "maté al Lich en ese estado". Permite el closing scene condicional y el legado especial "La Memoria de Kaelthas" en el Epic de Ascensión.

4. **`kaelthas_fragments_count` redundante** — Incluido para legibilidad y para futuras queries SQL que quieran filtrar jugadores por progreso sin parsear JSON.

---

## Próximos pasos (generados al completar DIS-1967)

Ver TAREAS.md — DIS-1968 (API interna), DIS-1969 (narrativa), DIS-1970 (prototipo Fase 1).

La implementación real de los hooks post-`read`/`examine` y el módulo `kaelthasQuest.js` corresponden a tareas de Fase 1 que se generarán al completar DIS-1968.
