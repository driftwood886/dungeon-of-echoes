/**
 * weather.js — Sistema de clima del dungeon (T166)
 *
 * El clima cambia cada 60 minutos y afecta levemente el gameplay.
 * A diferencia de los eventos globales (T090, duran 5 min), el clima es
 * persistente y duradero — el "trasfondo" del dungeon.
 *
 * Climas disponibles:
 *  - 'calm'       → Sin efectos especiales. El dungeon está tranquilo.
 *  - 'spore_rain' → Lluvia de esporas: los monstruos hacen +1 de daño.
 *  - 'arcane_calm'→ Calma arcana: la XP ganada se multiplica por 1.1.
 *  - 'cold_wind'  → Viento helado: rest y meditar recuperan -1 HP menos (mín 1).
 *  - 'dense_fog'  → Niebla densa: el look no muestra los HP de los monstruos.
 */

'use strict';

const WEATHER_INTERVAL_MS = 60 * 60 * 1000; // 60 minutos

const WEATHER_CATALOG = [
  {
    id: 'calm',
    name: '🌤️ Calma del Dungeon',
    emoji: '🌤️',
    description: 'El dungeon descansa en calma. No hay efectos especiales activos.',
    announceMsg: '🌤️ El dungeon recupera su calma habitual. No hay efectos climáticos activos.',
    effect: null,
  },
  {
    id: 'spore_rain',
    name: '🍄 Lluvia de Esporas',
    emoji: '🍄',
    description: 'Una nube de esporas tóxicas llena los corredores. Los monstruos están más agresivos (+1 daño).',
    announceMsg: '🍄 Una lluvia de esporas tóxicas se filtra por las grietas del dungeon. Los monstruos parecen energizados — atacan con más fuerza (+1 daño) durante la próxima hora.',
    effect: 'monster_damage_plus_1',
  },
  {
    id: 'arcane_calm',
    name: '✨ Calma Arcana',
    emoji: '✨',
    description: 'Una energía mística inunda el dungeon. Los aventureros aprenden más rápido (XP ×1.1).',
    announceMsg: '✨ Una energía arcana suave impregna el dungeon. Las enseñanzas del combate se absorben más profundamente — la XP ganada se multiplica por 1.1 durante la próxima hora.',
    effect: 'xp_multiplier_1_1',
  },
  {
    id: 'cold_wind',
    name: '❄️ Viento Helado',
    emoji: '❄️',
    description: 'Un viento gélido recorre los corredores. El descanso es menos efectivo (-1 HP de recuperación).',
    announceMsg: '❄️ Un viento helado sopla desde las profundidades. El frío entumece los músculos — descansar o meditar recupera 1 HP menos de lo normal durante la próxima hora.',
    effect: 'rest_minus_1',
  },
  {
    id: 'dense_fog',
    name: '🌁 Niebla Densa',
    emoji: '🌁',
    description: 'Una niebla espesa cubre el dungeon. Los detalles de los monstruos son difíciles de ver.',
    announceMsg: '🌁 Una niebla espesa surge del suelo del dungeon. Es difícil distinguir el estado de las criaturas — los detalles de HP de los monstruos quedan ocultos durante la próxima hora.',
    effect: 'hide_monster_hp',
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

  // Cambiar clima — eligiendo uno distinto al actual
  const candidates = WEATHER_CATALOG.filter(w => w.id !== currentWeather.id);
  const newWeather = candidates[Math.floor(Math.random() * candidates.length)];
  currentWeather = newWeather;
  lastWeatherChange = now;
  nextWeatherChange = now + WEATHER_INTERVAL_MS;

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
  return currentWeather.effect === 'xp_multiplier_1_1' ? 1.1 : 1.0;
}

function getRestPenalty() {
  return currentWeather.effect === 'rest_minus_1' ? 1 : 0;
}

function isFoggy() {
  return currentWeather.effect === 'hide_monster_hp';
}

/**
 * Formato de tiempo restante.
 */
function formatRemaining(ms) {
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
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
  formatRemaining,
  WEATHER_CATALOG,
};
