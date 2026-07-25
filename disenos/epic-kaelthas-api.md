# API Interna — Quest Principal de Kaelthas (DIS-1968)

**Fecha:** 2026-07-25  
**Epic:** EPIC-KAELTHAS — La Quest de Kaelthas  
**Estado:** Diseñado — pendiente implementación en T-1971

---

## Módulo: `server/game/kaelthasQuest.js`

Este módulo encapsula toda la lógica de la quest principal. Es importado por `engine.js`.

---

## Función 1: `checkKaelthasFragment(player, fragmentId)`

### Descripción
Se llama después de cada `read`/`examine` en las salas con fragmentos de lore de Kaelthas. Verifica si el jugador ya tiene el fragmento; si no, lo registra y devuelve texto narrativo de activación.

### Firma
```javascript
/**
 * @param {object} player — objeto jugador tal como viene de db.getPlayer()
 * @param {string} fragmentId — uno de: 'trono' | 'mausoleo' | 'capilla' | 'catedral'
 * @returns {{ text: string|null, questActivated: boolean, questCompleted: boolean }}
 *   text: null si el fragmento ya fue encontrado (no repetir), string si es nuevo
 *   questActivated: true si este fragmento activó la quest (pasó de 'inactive' → 'active')
 *   questCompleted: true si este es el 4to fragmento (quest 'active' → 'completed' ready)
 *     Nota: 'completed' aquí significa "los 4 fragmentos encontrados". El estado 'ended'
 *     solo ocurre tras el closing scene (activateKaelthasEnding).
 */
function checkKaelthasFragment(player, fragmentId) { ... }
```

### Lógica interna
```
1. mqd = db.getMainQuestData(player.id)
2. Si fragmentId ya está en mqd.fragments_found → return { text: null, questActivated: false, questCompleted: false }
3. Agregar fragmentId a mqd.fragments_found
4. Incrementar mqd.kaelthas_fragments_count
5. Si mqd.main_quest_state === 'inactive':
   - mqd.main_quest_state = 'active'
   - mqd.started_at = new Date().toISOString()
   - questActivated = true
6. Si mqd.kaelthas_fragments_count === 4:
   - questCompleted = true
   (no cambiar main_quest_state aquí — se cambia solo si mata al Lich)
7. db.updateMainQuestData(player.id, mqd)
8. db.addJournalEntry(player.id, 'quest', textoJournal[fragmentId])
9. return { text: textoActivacion[fragmentId], questActivated, questCompleted }
```

### Textos de activación (placeholders — contenido final en DIS-1969)
```javascript
const FRAGMENT_TEXTS = {
  trono: `\n\n📜 *Algo en esas palabras te persigue. El nombre en el trono. El rey que encontró el libro. ¿Dónde está ese libro ahora?*\n💡 Quest iniciada: «El Libro de los Muertos» — escribí \`quest info\` para seguir el progreso.`,
  mausoleo: `\n\n📜 *Las fechas coinciden. El dungeon es el mausoleo del Reino de Valdrath. Kaelthas está aquí abajo, en alguna forma.*\n💡 Quest actualizada: «El Libro de los Muertos»`,
  capilla: `\n\n📜 *La cera fresca no es de hace siglos. Alguien viene aquí regularmente. O algo.*\n💡 Quest actualizada: «El Libro de los Muertos»`,
  catedral: `\n\n📜 *El libro está aquí. En el altar negro. Frente al Lich. Todo tiene sentido ahora.*\n💡 Quest actualizada: «El Libro de los Muertos» — ¿Estás listo para enfrentar al Lich?`,
};
```

### Donde se llama en engine.js
| fragmentId | Función/caso | Sala | Condición |
|---|---|---|---|
| `'trono'` | `cmdReadWall(player)` | 9 | Siempre que se lee la pared de sala 9 |
| `'mausoleo'` | `cmdExamine()` | 12 | `examine columnas` en sala 12 |
| `'capilla'` | `cmdExamine()` | 5 | `examine altar` en sala 5 |
| `'catedral'` | `cmdExamine()` | 15 | `examine altar catedral` en sala 15 (nuevo examine) |

---

## Función 2: `getQuestState(player)`

### Descripción
Devuelve el estado formateado de la quest para el comando `quest info`. No modifica la BD.

### Firma
```javascript
/**
 * @param {object} player — objeto jugador tal como viene de db.getPlayer()
 * @returns {string} — texto formateado para mostrar al jugador
 */
function getQuestState(player) { ... }
```

### Output según estado

**`main_quest_state === 'inactive'`:**
```
📖 No tenés quests principales activas.
💡 Explorá el dungeon. Hay fragmentos de historia esperando ser encontrados.
```

**`main_quest_state === 'active'`** (0-3 fragmentos):
```
📖 Quest: El Libro de los Muertos [EN PROGRESO]
   Kaelthas fue un rey que encontró un libro que prometía derrotar a la muerte.
   Encontrá los 4 fragmentos para entender qué fue de él.

   Fragmentos encontrados (N/4):
   ✅ El nombre en el trono                 (Sala del Trono, sala 9)
   ⬜ El mausoleo del Reino de Valdrath     (Galería de Hielo, sala 12)
   ⬜ La cera fresca en el altar            (Capilla Olvidada, sala 5)
   ⬜ El libro en el altar oscuro           (Catedral de la Oscuridad, sala 15)
```
(✅ para encontrados, ⬜ para pendientes — mostrar nombres genéricos para no spoilear)

**`main_quest_state === 'completed'`** (los 4 fragmentos + Lich no muerto):
```
📖 Quest: El Libro de los Muertos [COMPLETA — PENDIENTE ENDING]
   Encontraste los 4 fragmentos. Solo falta enfrentar al Lich con todo el contexto.
   ✅ ✅ ✅ ✅  Todos los fragmentos encontrados.
   ⚔️ El Lich Anciano te espera en la Catedral de la Oscuridad (sala 15).
```

**`main_quest_state === 'ended'`:**
```
📖 Quest: El Libro de los Muertos [FINALIZADA]
   Completaste el arco de Kaelthas. El epitafio está en tu diario de lore.
```

### Donde se llama en engine.js
```
case 'quest': {
  if args === 'info' || args === 'info el libro de los muertos':
    return getQuestState(player)
  // (las quests menores del sistema existente no se ven afectadas)
}
```

---

## Función 3: `activateKaelthasEnding(player)`

### Descripción
Se llama cuando el jugador derrota al Lich con la quest activa y los 4 fragmentos encontrados. Gatilla el closing scene. Modifica la BD.

### Firma
```javascript
/**
 * @param {object} player — objeto jugador tal como viene de db.getPlayer() (ya recargado post-combate)
 * @returns {{ closingText: string, lichDialogue: string|null }}
 *   closingText: texto del closing scene (5 líneas) a insertar antes del loot
 *   lichDialogue: texto del diálogo del Lich pre-combate (null si ya empezó el combate)
 *     Nota: lichDialogue se usa en el pre-combat hook, no aquí. Incluido como referencia.
 */
function activateKaelthasEnding(player) { ... }
```

### Lógica interna
```
1. mqd = db.getMainQuestData(player.id)
2. Si mqd.lich_died_with_quest === true → ya fue procesado, return null (idempotente)
3. mqd.lich_died_with_quest = true
4. mqd.main_quest_state = 'ended'
5. db.updateMainQuestData(player.id, mqd)
6. db.addJournalEntry(player.id, 'quest', textoJournalFinal)
7. return { closingText: CLOSING_SCENE_TEXT }
```

### Closing scene (placeholder — contenido final en DIS-1969)
```
El Lich se desmorona. Las runas del suelo se apagan una a una.
Sobre el altar oscuro, el libro permanece intacto. Lo tomás.
Las páginas están en blanco. Todas.
No era un libro de magia. Era un diario.
Kaelthas escribió en él durante siglos esperando que alguien llegara a leerlo.
(Escribí «leer libro» para ver su último mensaje.)
```

### Donde se llama en engine.js
En la sección de muerte del Lich (monstruo ID del Lich — buscar en engine.js con `lich` o `Lich Anciano`), después de procesar el loot, si:
```javascript
const mqd = db.getMainQuestData(player.id);
if (mqd.main_quest_state === 'active' && mqd.kaelthas_fragments_count === 4) {
  const ending = kaelthasQuest.activateKaelthasEnding(freshPlayer);
  if (ending) result.text += '\n\n--- Epílogo ---\n' + ending.closingText;
}
```

---

## Función 4: `getLichDialogue(player)` (auxiliar)

### Descripción
Devuelve el diálogo del Lich según el estado de la quest. Se llama en el hook pre-combate cuando el jugador entra a combate con el Lich.

### Firma
```javascript
/**
 * @param {object} player — objeto jugador
 * @returns {string|null} — texto del diálogo, o null (sin diálogo — mismo comportamiento actual)
 */
function getLichDialogue(player) { ... }
```

### Lógica
```
mqd = db.getMainQuestData(player.id)

Si mqd.main_quest_state === 'inactive':
  → null (mismo que hoy — el Lich no habla)

Si mqd.main_quest_state === 'active' y kaelthas_fragments_count < 4:
  → "💀 *«Otro que vino a morir. El libro no es para vos.»*"

Si mqd.main_quest_state === 'active' o 'completed' y kaelthas_fragments_count === 4:
  → texto largo de 3 líneas (diálogo final — contenido en DIS-1969)
```

### Donde se llama
En el inicio del combate con el Lich (en `handleAttack` o la sección que inicia el combate contra el monstruo `Lich Anciano`), como un hook previo al primer turno.

---

## Notas de implementación para T-1971 / T-1972

1. **No romper el flujo existente:** Los hooks post-`read`/`examine` deben ser `try/catch` — si el módulo falla, el lore existente se muestra igual.

2. **Concurrencia:** `getMainQuestData` y `updateMainQuestData` usan `db.raw().run()` — son síncronos en sql.js. No hay race conditions.

3. **Idempotencia:** `checkKaelthasFragment` verifica si el fragmento ya existe antes de modificar. `activateKaelthasEnding` verifica `lich_died_with_quest` antes de modificar.

4. **`leer libro`:** El ítem "libro de Kaelthas" se agrega al inventario durante `activateKaelthasEnding` (ítem especial, intransmisible, flavor text puro). El comando `leer libro` o `read libro` se maneja como alias del comando `use libro de kaelthas` — muestra el epitafio y guarda en diario.

5. **Bots:** El módulo no debe activarse para jugadores con `player.is_bot === 1`.
