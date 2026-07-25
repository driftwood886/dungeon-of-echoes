# Narrativa Completa — Quest de Kaelthas (DIS-1969)

**Fecha:** 2026-07-25  
**Epic:** EPIC-KAELTHAS — La Quest de Kaelthas  
**Estado:** Aprobado — listo para implementar en T-1971 / T-1972

---

## A. Textos de activación de fragmentos

Estos textos se añaden al final del output de `read`/`examine` existente cuando el jugador encuentra un fragmento por primera vez. Se muestran en cursiva narrativa.

### Fragmento 1 — Trono (sala 9, primer `read`)

```
📜 Algo en esas palabras te persigue.
   El nombre en el trono. El rey que encontró el libro.
   ¿Dónde está ese libro ahora?

💡 Nueva quest: «El Libro de los Muertos» — escribí «quest info» para ver el progreso.
```

*Entrada en diario de quest:* `📖 [QUEST] El Libro de los Muertos — Inicio. El nombre Kaelthas aparece en el trono. Un rey que encontró un libro que prometía derrotar a la muerte. ¿Qué fue de él?`

---

### Fragmento 2 — Mausoleo (sala 12, `examine columnas`)

```
📜 Las fechas coinciden. Todo coincide.
   El dungeon es el mausoleo del Reino de Valdrath.
   Kaelthas está aquí abajo, en alguna forma.

💡 Quest actualizada: «El Libro de los Muertos» (2/4 fragmentos)
```

*Entrada en diario de quest:* `📖 [QUEST] La Galería de Hielo es el mausoleo del Reino de Valdrath. Las fechas de las columnas — el reinado de Kaelthas, la caída del reino. Todo encaja. El dungeon no es una mazmorra. Es una cripta.`

---

### Fragmento 3 — Capilla (sala 5, `examine altar`)

```
📜 La cera no tiene décadas. No tiene siglos.
   Alguien viene aquí regularmente.
   O algo.

💡 Quest actualizada: «El Libro de los Muertos» (3/4 fragmentos)
```

*Entrada en diario de quest:* `📖 [QUEST] La cera fresca en el altar de la Capilla. No es un detalle decorativo. Hay una presencia activa en este dungeon que aún rinde culto aquí. ¿Kaelthas, en su nueva forma, todavía recuerda algo de lo que fue?`

---

### Fragmento 4 — Catedral (sala 15, `examine altar catedral`)

```
📜 Está aquí. El libro está aquí.
   En el altar negro. Frente al Lich.
   Todo tiene sentido ahora.

💡 Quest actualizada: «El Libro de los Muertos» (4/4 fragmentos) — Derrotá al Lich para completar el arco.
```

*Entrada en diario de quest:* `📖 [QUEST] El libro sobre el altar de la Catedral. El objeto que empezó todo. El que prometía derrotar a la muerte. El Lich lo custodió durante siglos. El enfrentamiento final tiene otro peso ahora.`

---

## B. Diálogo del Lich Anciano

Se muestra antes del primer turno de combate, según el estado de la quest.

### Variante 1 — Sin quest activa (igual que hoy)
*Sin diálogo. El Lich ataca sin palabras.*

---

### Variante 2 — Quest activa, menos de 4 fragmentos
```
💀 *El Lich te mira un momento antes de levantar el bastón.*
   «Otro que vino a morir. El libro no es para vos.»
```

---

### Variante 3 — Los 4 fragmentos encontrados
```
💀 *El Lich baja el bastón. Por primera vez, no ataca de inmediato.*

   «Ya sabés, entonces. Cuánto tiempo esperé que alguien llegara con la historia completa.»

   «El libro prometía la victoria sobre la muerte. No mentía.»
   «Aquí estoy: muerto, y todavía en pie.»

   «Vamos. Sería un desperdicio matarte sin que lo hayas entendido.»
```

---

## C. Closing Scene (post-combate, con quest completa)

Se muestra después del loot habitual, como sección separada `--- Epílogo ---`.

```
--- Epílogo ---

El Lich se desmorona. Las runas del suelo se apagan una a una.

Sobre el altar oscuro, el libro permanece intacto.
Lo tomás. Las páginas están en blanco. Todas.

No era un libro de magia. Era un diario.
Kaelthas escribió en él durante siglos esperando que alguien llegara a leerlo.

(Escribí «leer libro» para ver su último mensaje.)
```

*El ítem `libro de kaelthas` se agrega al inventario. Intransmisible. Flavor text: "Un diario encuadernado en cuero negro. Las páginas están en blanco salvo la última."*

---

## D. Epitafio de Kaelthas

Se muestra al ejecutar `leer libro` (con el libro en inventario). Se guarda en el diario de lore.

```
📖 La última página del diario de Kaelthas:

   «Encontré el libro cuando el reino todavía respiraba.
   Prometía derrotar a la muerte. No mentía — solo omitió
   que "derrotar" no es lo mismo que "escapar".

   Sigo aquí. Sigo en pie. No soy el mismo.
   Lo que soy ahora no tiene nombre en el idioma de los vivos.

   Escribí esto para el que llegara después.
   Para que supiera que el libro funciona.
   Y que ojalá, para vos, funcione diferente.»

                    — Kaelthas, Rey de Valdrath
                      Primera entrada: año 0 del reino
                      Última entrada: sin fecha
```

*Entrada en diario de lore:* `📖 El epitafio de Kaelthas — El libro prometía derrotar a la muerte. No mentía. "Derrotar no es lo mismo que escapar." El Lich era el rey. El rey sabía. Y esperó durante siglos que alguien llegara a leerlo.`

---

## E. Hint del Guardián Anciano (nivel 3, si quest inactiva)

Se muestra en el diálogo con el Guardián Anciano (NPC en sala de entrada o donde esté configurado) si el jugador está en nivel 3 y `main_quest_state === 'inactive'`:

```
🧙 El anciano te mira con algo que no es exactamente compasión.
   «Dicen que hay un nombre grabado en el Trono de Huesos.
    Más de uno intentó descifrar quién era.
    Ninguno volvió para contarlo. Vos capaz sí.»
```

---

## Notas editoriales

- **Tono:** Primera persona de Kaelthas en el epitafio. Narrador neutro en los fragmentos de activación. El Lich habla en vos directa, sin florituras.
- **Consistencia:** "El libro prometía derrotar a la muerte" aparece en la inscripción de Hermana Vela (ya en el juego) y en el epitafio — el eco es intencional.
- **Longitud:** Los textos de activación son breves (3-4 líneas). El diálogo del Lich es medio (4-5 líneas). El closing scene y epitafio son más largos pero se leen una sola vez.
- **Saltar:** El closing scene puede saltarse con `saltar` o `skip`. El epitafio no.
