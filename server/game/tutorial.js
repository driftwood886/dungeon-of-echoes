/**
 * tutorial.js — Sistema de tutorial para nuevos jugadores (T091)
 *
 * Sala 16: "Antesala del Dungeon" — sala especial accesible solo en el tutorial.
 * El tutorial tiene 3 pasos guiados:
 *   Paso 1: mirar la sala (look)
 *   Paso 2: moverse (move south hacia sala 1)
 *   Paso 3: atacar al Goblin de Práctica
 *
 * Un jugador está en tutorial si tiene tutorial_step > 0 (nunca completó).
 * Al completar el tercer paso: +10 XP, teletransporta a sala 1, tutorial_step = 0.
 */

'use strict';

const TUTORIAL_ROOM_ID = 16;

// Mensajes para cada paso del tutorial
const STEPS = {
  1: `═══════════════════════════════════════
🎓 TUTORIAL — Paso 1 de 3: MIRAR
═══════════════════════════════════════
Las puertas del dungeon se abrieron solas hace tres días.
Dicen que hay una fortuna adentro. También dicen que nadie
regresó. Un cartel en la entrada dice: SE BUSCA — quien
traiga prueba de la muerte del Lich Anciano. Recompensa:
suficiente para no volver a trabajar.

Explorás un laberinto subterráneo lleno de monstruos,
tesoros y otros aventureros.

👁️  Primero: observá tu entorno.
Escribí:  look   (o «mirar»)
═══════════════════════════════════════`,

  2: `═══════════════════════════════════════
🎓 TUTORIAL — Paso 2 de 3: MOVERSE
═══════════════════════════════════════
¡Bien! Así es como te orientás en el dungeon.

🦶 Ahora: hay un Goblin de Práctica aquí.
Atacalo antes de irte. Escribí:
  attack goblin   (o «atacar goblin»)
═══════════════════════════════════════`,

  3: `═══════════════════════════════════════
🎓 TUTORIAL — Paso 3 de 3: COMBATE
═══════════════════════════════════════
¡Perfecto! El combate funciona por turnos.
Usás «attack» para atacar, «flee» para huir,
«use poción» para curarte.

⚔️  Terminá de derrotar al Goblin de Práctica
o escribí:  sur   para salir al dungeon real.
═══════════════════════════════════════`,
};

// Mensaje al completar tutorial — para jugadores SIN clase aún
const COMPLETE_MSG = `🎉 ¡TUTORIAL COMPLETADO!
Ganás +10 XP de bonus por completar el entrenamiento.
Ahora estás en la Entrada de la Cripta. ¡Buena suerte, aventurero/a!

⚔️  PRÓXIMO PASO: Elegí tu vocación con el comando:
  clase
  (Guerrero, Pícaro o Mago — cada uno cambia tu forma de combatir)

Escribí «look» para ver dónde estás, «help» para ver todos los comandos.`;

// DIS-D278: Variante para jugadores que YA eligieron clase (al registrarse o durante el tutorial)
const COMPLETE_MSG_WITH_CLASS = `🎉 ¡TUTORIAL COMPLETADO!
Ganás +10 XP de bonus por completar el entrenamiento.
Ahora estás en la Entrada de la Cripta. ¡Buena suerte, aventurero/a!

Escribí «look» para ver dónde estás, «help» para ver todos los comandos.`;

/**
 * DIS-D278: Devuelve el mensaje de completar tutorial apropiado.
 * Si el jugador ya eligió clase, omite el recordatorio de clase.
 */
function getCompleteMsg(player) {
  const hasClass = player && player.player_class && player.player_class !== 'sin_clase';
  return hasClass ? COMPLETE_MSG_WITH_CLASS : COMPLETE_MSG;
}

/**
 * Devuelve true si el jugador debe ir al tutorial.
 * Criterio: kills === 0 Y nivel === 1 Y tutorial_step IS NULL o === 1
 */
function shouldStartTutorial(player) {
  const kills = player.kills || 0;
  const level = player.level || 1;
  const step  = player.tutorial_step;
  // step null = nunca definido (jugador nuevo), o step > 0 = en tutorial
  return level === 1 && kills === 0 && (step === null || step === undefined || step > 0);
}

/**
 * Retorna el mensaje del paso actual.
 */
function getStepMessage(step) {
  return STEPS[step] || null;
}

module.exports = {
  TUTORIAL_ROOM_ID,
  STEPS,
  COMPLETE_MSG,
  getCompleteMsg,
  shouldStartTutorial,
  getStepMessage,
};
