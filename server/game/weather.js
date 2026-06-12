/**
 * weather.js — Sistema de clima del dungeon (T166 + T206)
 *
 * El clima cambia cada 60 minutos y afecta levemente el gameplay.
 * A diferencia de los eventos globales (T090, duran 5 min), el clima es
 * persistente y duradero — el "trasfondo" del dungeon.
 *
 * Climas disponibles (normales):
 *  - 'calm'       → Sin efectos especiales. El dungeon está tranquilo.
 *  - 'spore_rain' → Lluvia de esporas: los monstruos hacen +1 de daño.
 *  - 'arcane_calm'→ Calma arcana: la XP ganada se multiplica por 1.1.
 *  - 'cold_wind'  → Viento helado: rest y meditar recuperan -1 HP menos (mín 1).
 *  - 'dense_fog'  → Niebla densa: el look no muestra los HP de los monstruos.
 *
 * Climas extremos (T206, 10% de probabilidad, duran 15 minutos):
 *  - 'spore_storm'  → Tormenta de esporas: veneno pasivo en salas de dungeon.
 *  - 'blizzard'     → Blizzard: movimiento con mensaje de ralentización.
 *  - 'scorching'    → Calor abrasador: maná regenera doble pero HP máx -5.
 */

'use strict';

const WEATHER_INTERVAL_MS = 60 * 60 * 1000; // 60 minutos
const EXTREME_DURATION_MS = 15 * 60 * 1000;  // 15 minutos para climas extremos (T206)

const WEATHER_CATALOG = [
  {
    id: 'calm',
    name: '🌤️ Calma del Dungeon',
    emoji: '🌤️',
    description: 'El dungeon descansa en calma. No hay efectos especiales activos.',
    announceMsg: '🌤️ El dungeon recupera su calma habitual. No hay efectos climáticos activos.',
    effect: null,
    extreme: false,
  },
  {
    id: 'spore_rain',
    name: '🍄 Lluvia de Esporas',
    emoji: '🍄',
    description: 'Una nube de esporas tóxicas llena los corredores. Los monstruos están más agresivos (+1 daño).',
    announceMsg: '🍄 Una lluvia de esporas tóxicas se filtra por las grietas del dungeon. Los monstruos parecen energizados — atacan con más fuerza (+1 daño) durante la próxima hora.',
    effect: 'monster_damage_plus_1',
    extreme: false,
  },
  {
    id: 'arcane_calm',
    name: '✨ Calma Arcana',
    emoji: '✨',
    description: 'Una energía mística inunda el dungeon. Los aventureros aprenden más rápido (XP ×1.1).',
    announceMsg: '✨ Una energía arcana suave impregna el dungeon. Las enseñanzas del combate se absorben más profundamente — la XP ganada se multiplica por 1.1 durante la próxima hora.',
    effect: 'xp_multiplier_11',
    extreme: false,
  },
  {
    id: 'cold_wind',
    name: '❄️ Viento Helado',
    emoji: '❄️',
    description: 'Un viento gélido recorre los corredores. El descanso es menos efectivo (-1 HP de recuperación).',
    announceMsg: '❄️ Un viento helado sopla desde las profundidades. El frío entumece los músculos — descansar o meditar recupera 1 HP menos de lo normal durante la próxima hora.',
    effect: 'rest_minus_1',
    extreme: false,
  },
  {
    id: 'dense_fog',
    name: '🌁 Niebla Densa',
    emoji: '🌁',
    description: 'Una niebla espesa cubre el dungeon. Los detalles de los monstruos son difíciles de ver.',
    announceMsg: '🌁 Una niebla espesa surge del suelo del dungeon. Es difícil distinguir el estado de las criaturas — los detalles de HP de los monstruos quedan ocultos durante la próxima hora.',
    effect: 'hide_monster_hp',
    extreme: false,
  },
  // ---- CLIMAS EXTREMOS (T206) ----
  {
    id: 'spore_storm',
    name: '☠️ TORMENTA DE ESPORAS',
    emoji: '☠️',
    description: '⚠️ CLIMA EXTREMO — Una tormenta de esporas venenosas invade el dungeon. Los jugadores en salas de mazmorra reciben veneno pasivo al moverse.',
    announceMsg: '☠️ ¡ALERTA EXTREMA! Una TORMENTA DE ESPORAS desciende sobre el dungeon! Las esporas venenosas saturan el aire — moverse en los corredores oscuros causa envenenamiento pasivo. ¡Busca refugio o sufre las consecuencias! (Dura 15 minutos)',
    effect: 'spore_storm',
    extreme: true,
  },
  {
    id: 'blizzard',
    name: '🌨️ BLIZZARD INFERNAL',
    emoji: '🌨️',
    description: '⚠️ CLIMA EXTREMO — Un blizzard sobrenatural congela los corredores. El movimiento se vuelve lento y agotador.',
    announceMsg: '🌨️ ¡ALERTA EXTREMA! Un BLIZZARD INFERNAL azota el dungeon! El frío sobrenatural paraliza los músculos — cada movimiento cuesta el doble de esfuerzo. Los aventureros se mueven con dificultad. (Dura 15 minutos)',
    effect: 'blizzard',
    extreme: true,
  },
  {
    id: 'scorching',
    name: '🔥 CALOR ABRASADOR',
    emoji: '🔥',
    description: '⚠️ CLIMA EXTREMO — Un calor volcánico abrasa el dungeon. El maná fluye libremente (×2) pero el cuerpo se debilita (HP máx -5).',
    announceMsg: '🔥 ¡ALERTA EXTREMA! Un CALOR ABRASADOR surge de las profundidades! Las energías arcanas se aceleran (maná regenera al doble) pero el calor extremo debilita el cuerpo (HP máximo -5 temporalmente). (Dura 15 minutos)',
    effect: 'scorching',
    extreme: true,
  },
];

// Estado global del clima (en memoria)
let currentWeather = WEATHER_CATALOG[0]; // empieza con calma
let lastWeatherChange = Date.now();
let nextWeatherChange = Date.now() + WEATHER_INTERVAL_MS;

/**
 * getCurrentWeather() → { id, name, emoji, description, effect, changesAt }
 */
function getCurrentWeather() {
  return {
    ...currentWeather,
    changesAt: nextWeatherChange,
    changesInMs: Math.max(0, nextWeatherChange - Date.now()),
  };
}

/**
 * Verificar si hay que cambiar el clima.
 * Llamar cada 60 segundos desde index.js.
 * @returns {{ weather, message } | null}
 */
function tick() {
  const now = Date.now();
  if (now < nextWeatherChange) return null;

  // T206: 10% de chance de clima extremo, 90% de clima normal
  const isExtreme = Math.random() < 0.10;
  const extremes = WEATHER_CATALOG.filter(w => w.extreme);
  const normals = WEATHER_CATALOG.filter(w => !w.extreme && w.id !== currentWeather.id);

  let newWeather;
  if (isExtreme && extremes.length > 0) {
    newWeather = extremes[Math.floor(Math.random() * extremes.length)];
  } else {
    newWeather = normals[Math.floor(Math.random() * normals.length)];
  }

  currentWeather = newWeather;
  lastWeatherChange = now;
  // Clima extremo dura 15 minutos, clima normal dura 60 minutos
  nextWeatherChange = now + (newWeather.extreme ? EXTREME_DURATION_MS : WEATHER_INTERVAL_MS);

  return {
    weather: newWeather,
    message: newWeather.announceMsg,
  };
}

/**
 * Helpers de acceso rápido para los efectos del clima.
 */
function hasEffect(effectId) {
  return currentWeather.effect === effectId;
}

function getMonsterDamageBonus() {
  return currentWeather.effect === 'monster_damage_plus_1' ? 1 : 0;
}

function getXpMultiplier() {
  return currentWeather.effect === 'xp_multiplier_11' ? 1.1 : 1.0;
}

function getRestPenalty() {
  return currentWeather.effect === 'rest_minus_1' ? 1 : 0;
}

function isFoggy() {
  return currentWeather.effect === 'hide_monster_hp';
}

// T206: Helpers para climas extremos
function isSporeStorm() { return currentWeather.effect === 'spore_storm'; }
function isBlizzard()    { return currentWeather.effect === 'blizzard'; }
function isScorching()   { return currentWeather.effect === 'scorching'; }

/**
 * getManaRegenMultiplier() — Multiplicador de maná (1.0 normal, 2.0 en calor abrasador).
 */
function getManaRegenMultiplier() {
  return currentWeather.effect === 'scorching' ? 2.0 : 1.0;
}

/**
 * getMaxHpPenalty() — Penalización a HP máximo (0 normal, 5 en calor abrasador).
 */
function getMaxHpPenalty() {
  return currentWeather.effect === 'scorching' ? 5 : 0;
}

/**
 * Formato de tiempo restante.
 */
function formatRemaining(ms) {
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  if (min > 0) return `${min}m ${sec}s`;
  return `${sec}s`;
}

module.exports = {
  getCurrentWeather,
  tick,
  hasEffect,
  getMonsterDamageBonus,
  getXpMultiplier,
  getRestPenalty,
  isFoggy,
  isSporeStorm,
  isBlizzard,
  isScorching,
  getManaRegenMultiplier,
  getMaxHpPenalty,
  formatRemaining,
  WEATHER_CATALOG,
};

