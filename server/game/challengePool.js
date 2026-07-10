// challengePool.js — Pool completo de desafíos diarios y semanales
// Fuente de datos: disenos/epic-gaceta-desafios-pool.md
// No contiene lógica de asignación — solo el pool de datos.
// Usar con challengeAssigner.js (T-1230)

/**
 * Estructura de cada desafío:
 * {
 *   id: string,
 *   category: 'combate' | 'exploracion' | 'economia' | 'gran_desafio' | 'semanal',
 *   title: string,
 *   description: string,
 *   condition: {
 *     type: string,     // tipo de tracking (ver tabla en epic-gaceta-desafios-pool.md)
 *     target: string|null,  // qué matar/craftear/etc.
 *     amount: number,   // cuántos
 *     extra: {}         // parámetros adicionales
 *   },
 *   reward: { xp: number, gold: number, rep: number },
 *   min_level: number,  // 0 = sin mínimo
 *   max_level: number,  // 99 = sin límite
 *   classes: string[]|null,  // null = todas las clases
 *   events: string[]|null,   // null = siempre disponible; lista = solo durante ese evento
 *   shared: boolean          // true = Gran Desafío del Día (compartido para todos)
 * }
 */

const challengePool = [

  // ─────────────────────────────────────────────────────────────────────────
  // CATEGORÍA 1: COMBATE — Todos las clases (pool general)
  // ─────────────────────────────────────────────────────────────────────────

  {
    id: 'CHAL-C01',
    category: 'combate',
    title: 'Purga de Goblins',
    description: 'Derrota a 5 Goblins Merodeadores. Los encontrás en el Corredor de las Sombras (sala 2).',
    condition: { type: 'kill', target: 'Goblin Merodeador', amount: 5, extra: {} },
    reward: { xp: 60, gold: 10, rep: 1 },
    min_level: 1, max_level: 4,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-C02',
    category: 'combate',
    title: 'Cazador de Ratas',
    description: 'Elimina a 3 Ratas Gigantes. Están cerca de la entrada.',
    condition: { type: 'kill', target: 'Rata Gigante', amount: 3, extra: {} },
    reward: { xp: 35, gold: 5, rep: 0 },
    min_level: 1, max_level: 3,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-C03',
    category: 'combate',
    title: 'Rompedor de Huesos',
    description: 'Destruye 5 Esqueletos Guerreros. La Cámara del Tesoro (sala 4) está infestada.',
    condition: { type: 'kill', target: 'Esqueleto Guerrero', amount: 5, extra: {} },
    reward: { xp: 80, gold: 15, rep: 1 },
    min_level: 2, max_level: 5,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-C04',
    category: 'combate',
    title: 'Exterminador Espectral',
    description: 'Derrota 3 Espectros del Corredor. Son peligrosos — preparate.',
    condition: { type: 'kill', target: 'Espectro del Corredor', amount: 3, extra: {} },
    reward: { xp: 120, gold: 20, rep: 1 },
    min_level: 3, max_level: 6,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-C05',
    category: 'combate',
    title: 'Caza de Arañas',
    description: 'Aplasta 4 Arañas Tejedoras en el Pozo Sin Fondo (sala 7).',
    condition: { type: 'kill', target: 'Araña Tejedora', amount: 4, extra: {} },
    reward: { xp: 50, gold: 8, rep: 0 },
    min_level: 1, max_level: 4,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-C06',
    category: 'combate',
    title: 'Murciélago de Práctica',
    description: 'Elimina al Murciélago Vampiro (sala 5).',
    condition: { type: 'kill', target: 'Murciélago Vampiro', amount: 1, extra: {} },
    reward: { xp: 40, gold: 6, rep: 0 },
    min_level: 1, max_level: 3,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-C07',
    category: 'combate',
    title: 'Desafiante del Gólem',
    description: 'Derrota al Gólem de Piedra (sala 5). Es resistente — usá tus mejores ataques.',
    condition: { type: 'kill', target: 'Gólem de Piedra', amount: 1, extra: {} },
    reward: { xp: 150, gold: 25, rep: 2 },
    min_level: 3, max_level: 7,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-C08',
    category: 'combate',
    title: 'Sangre de Krakeling',
    description: 'Elimina 2 Krakelings Abisales (sala 11 — Pozo Sin Fondo profundo).',
    condition: { type: 'kill', target: 'Krakeling Abismal', amount: 2, extra: {} },
    reward: { xp: 130, gold: 22, rep: 1 },
    min_level: 4, max_level: 7,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-C09',
    category: 'combate',
    title: 'Rivalidad Eterna',
    description: 'Derrota al Guardia Espectral (sala 8). Es un boss — no subestimes la alabarda.',
    condition: { type: 'kill', target: 'Guardia Espectral', amount: 1, extra: {} },
    reward: { xp: 200, gold: 35, rep: 3 },
    min_level: 5, max_level: 8,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-C10',
    category: 'combate',
    title: 'El Frío de las Profundidades',
    description: 'Derrota al Elemental de Hielo (sala 9).',
    condition: { type: 'kill', target: 'Elemental de Hielo', amount: 1, extra: {} },
    reward: { xp: 180, gold: 30, rep: 2 },
    min_level: 4, max_level: 8,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-C11',
    category: 'combate',
    title: 'Forja Destruida',
    description: 'Derrota al Golem de Forja (sala 12).',
    condition: { type: 'kill', target: 'Golem de Forja', amount: 1, extra: {} },
    reward: { xp: 200, gold: 35, rep: 2 },
    min_level: 5, max_level: 8,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-C12',
    category: 'combate',
    title: 'Campeonato Espectral',
    description: 'Derrota al Campeón Espectral (sala 13).',
    condition: { type: 'kill', target: 'Campeón Espectral', amount: 1, extra: {} },
    reward: { xp: 220, gold: 40, rep: 3 },
    min_level: 6, max_level: 9,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-C13',
    category: 'combate',
    title: 'La Prueba Final',
    description: 'Derrota al Lich Anciano (sala 14). Solo los más valientes sobreviven.',
    condition: { type: 'kill', target: 'Lich Anciano', amount: 1, extra: {} },
    reward: { xp: 400, gold: 80, rep: 5 },
    min_level: 7, max_level: 99,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-C14',
    category: 'combate',
    title: 'Sin Misericordia',
    description: 'Derrota 10 monstruos en una sesión. Cualquier tipo cuenta.',
    condition: { type: 'session_kills', target: null, amount: 10, extra: {} },
    reward: { xp: 100, gold: 15, rep: 1 },
    min_level: 2, max_level: 99,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-C15',
    category: 'combate',
    title: 'Maratón de Combate',
    description: 'Derrota 20 monstruos en una sesión. Para los más dedicados.',
    condition: { type: 'session_kills', target: null, amount: 20, extra: {} },
    reward: { xp: 200, gold: 30, rep: 2 },
    min_level: 3, max_level: 99,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-C16',
    category: 'combate',
    title: 'Eco Silenciado',
    description: 'Derrota al Eco Viviente (sala especial — activado por expedición o evento).',
    condition: { type: 'kill', target: 'Eco Viviente', amount: 1, extra: {} },
    reward: { xp: 250, gold: 45, rep: 3 },
    min_level: 5, max_level: 99,
    classes: null, events: null, shared: false
  },

  // ─────────────────────────────────────────────────────────────────────────
  // CATEGORÍA 1: COMBATE — Guerrero (clase específica)
  // ─────────────────────────────────────────────────────────────────────────

  {
    id: 'CHAL-CG01',
    category: 'combate',
    title: 'Golpe Definitivo',
    description: 'Como Guerrero, mata al Espectro del Corredor con un solo golpe que le deje en menos de 5 HP. (El daño excedente cuenta.)',
    condition: { type: 'kill', target: 'Espectro del Corredor', amount: 1, extra: { final_enemy_hp_le: 5 } },
    reward: { xp: 130, gold: 22, rep: 2 },
    min_level: 3, max_level: 7,
    classes: ['guerrero'], events: null, shared: false
  },
  {
    id: 'CHAL-CG02',
    category: 'combate',
    title: 'Hoja Afilada',
    description: 'Derrota 5 monstruos sin usar pociones. Una prueba de resistencia física.',
    condition: { type: 'kill_noheal', target: null, amount: 5, extra: {} },
    reward: { xp: 100, gold: 18, rep: 1 },
    min_level: 2, max_level: 6,
    classes: ['guerrero'], events: null, shared: false
  },
  {
    id: 'CHAL-CG03',
    category: 'combate',
    title: 'Especialista en Bosses',
    description: 'Como Guerrero, derrota cualquier boss (Gólem, Guardia Espectral, Elemental, Golem de Forja o Lich).',
    condition: { type: 'kill_boss', target: null, amount: 1, extra: {} },
    reward: { xp: 220, gold: 40, rep: 3 },
    min_level: 4, max_level: 99,
    classes: ['guerrero'], events: null, shared: false
  },
  {
    id: 'CHAL-CG04',
    category: 'combate',
    title: 'El Hacha y la Sala',
    description: 'Con hacha rústica equipada, derrota 3 monstruos. No todo boss requiere la mejor espada.',
    condition: { type: 'kill', target: null, amount: 3, extra: { weapon_equipped: 'hacha rústica' } },
    reward: { xp: 80, gold: 12, rep: 1 },
    min_level: 1, max_level: 5,
    classes: ['guerrero'], events: null, shared: false
  },
  {
    id: 'CHAL-CG05',
    category: 'combate',
    title: 'Resistencia de Acero',
    description: 'Derrota al Gólem de Piedra con 30 HP o más restantes.',
    condition: { type: 'kill', target: 'Gólem de Piedra', amount: 1, extra: { player_min_hp: 30 } },
    reward: { xp: 180, gold: 30, rep: 2 },
    min_level: 3, max_level: 7,
    classes: ['guerrero'], events: null, shared: false
  },

  // ─────────────────────────────────────────────────────────────────────────
  // CATEGORÍA 1: COMBATE — Mago (clase específica)
  // ─────────────────────────────────────────────────────────────────────────

  {
    id: 'CHAL-CM01',
    category: 'combate',
    title: 'Arco Arcano',
    description: 'Usa 5 hechizos en una sesión. El maná se recupera — usalo.',
    condition: { type: 'cast_spell', target: null, amount: 5, extra: {} },
    reward: { xp: 80, gold: 15, rep: 1 },
    min_level: 1, max_level: 5,
    classes: ['mago'], events: null, shared: false
  },
  {
    id: 'CHAL-CM02',
    category: 'combate',
    title: 'Especialista en Hielo',
    description: 'Como Mago, derrota al Elemental de Hielo usando solo hechizos (sin ataques físicos).',
    condition: { type: 'kill_with_magic', target: 'Elemental de Hielo', amount: 1, extra: {} },
    reward: { xp: 200, gold: 38, rep: 3 },
    min_level: 4, max_level: 8,
    classes: ['mago'], events: null, shared: false
  },
  {
    id: 'CHAL-CM03',
    category: 'combate',
    title: 'Destrucción Arcana',
    description: 'Inflige 100 puntos de daño mágico total en una sesión.',
    condition: { type: 'spell_damage', target: null, amount: 100, extra: {} },
    reward: { xp: 110, gold: 20, rep: 1 },
    min_level: 2, max_level: 6,
    classes: ['mago'], events: null, shared: false
  },
  {
    id: 'CHAL-CM04',
    category: 'combate',
    title: 'Carga Completa',
    description: 'Usa todos tus hechizos conocidos al menos una vez en la misma sesión.',
    condition: { type: 'cast_spell', target: null, amount: 1, extra: { all_known_spells: true } },
    reward: { xp: 120, gold: 22, rep: 2 },
    min_level: 2, max_level: 99,
    classes: ['mago'], events: null, shared: false
  },
  {
    id: 'CHAL-CM05',
    category: 'combate',
    title: 'Dominio del Maná',
    description: 'Termina una batalla con el 80% o más de tu maná máximo.',
    condition: { type: 'kill', target: null, amount: 1, extra: { min_mana_pct: 0.8 } },
    reward: { xp: 100, gold: 18, rep: 1 },
    min_level: 3, max_level: 99,
    classes: ['mago'], events: null, shared: false
  },

  // ─────────────────────────────────────────────────────────────────────────
  // CATEGORÍA 1: COMBATE — Pícaro (clase específica)
  // ─────────────────────────────────────────────────────────────────────────

  {
    id: 'CHAL-CP01',
    category: 'combate',
    title: 'Veneno en la Hoja',
    description: 'Con daga envenenada, aplica veneno a 3 monstruos distintos.',
    condition: { type: 'poison_applied', target: null, amount: 3, extra: {} },
    reward: { xp: 100, gold: 18, rep: 1 },
    min_level: 2, max_level: 6,
    classes: ['picaro'], events: null, shared: false
  },
  {
    id: 'CHAL-CP02',
    category: 'combate',
    title: 'Golpe Preciso',
    description: 'Como Pícaro, usa el golpe especial de clase 3 veces en una sesión.',
    condition: { type: 'skill_use', target: 'picaro_special', amount: 3, extra: {} },
    reward: { xp: 90, gold: 16, rep: 1 },
    min_level: 2, max_level: 6,
    classes: ['picaro'], events: null, shared: false
  },
  {
    id: 'CHAL-CP03',
    category: 'combate',
    title: 'Sombras del Dungeon',
    description: 'Derrota 3 monstruos sin recibir daño en ninguno de los combates. (Abandonar el combate invalida ese kill.)',
    condition: { type: 'kill_nodmg', target: null, amount: 3, extra: {} },
    reward: { xp: 150, gold: 28, rep: 2 },
    min_level: 3, max_level: 7,
    classes: ['picaro'], events: null, shared: false
  },
  {
    id: 'CHAL-CP04',
    category: 'combate',
    title: 'Coleccionista de Loot',
    description: 'Recoge 5 ítems del suelo (loot) en una sesión. Calidad no importa.',
    condition: { type: 'loot_pickup', target: null, amount: 5, extra: {} },
    reward: { xp: 60, gold: 10, rep: 0 },
    min_level: 1, max_level: 5,
    classes: ['picaro'], events: null, shared: false
  },
  {
    id: 'CHAL-CP05',
    category: 'combate',
    title: 'El Oportunista',
    description: 'Mata un monstruo envenenado antes de que el veneno lo mate. (El kill con arma cuenta.)',
    condition: { type: 'kill_poisoned', target: null, amount: 1, extra: {} },
    reward: { xp: 80, gold: 14, rep: 1 },
    min_level: 2, max_level: 99,
    classes: ['picaro'], events: null, shared: false
  },

  // ─────────────────────────────────────────────────────────────────────────
  // CATEGORÍA 1: COMBATE — Clérigo (clase específica)
  // ─────────────────────────────────────────────────────────────────────────

  {
    id: 'CHAL-CC01',
    category: 'combate',
    title: 'Guardián de la Luz',
    description: 'Como Clérigo, cura a otro jugador en sala durante una batalla.',
    condition: { type: 'heal_other', target: null, amount: 1, extra: {} },
    reward: { xp: 100, gold: 18, rep: 2 },
    min_level: 2, max_level: 99,
    classes: ['clerigo'], events: null, shared: false
  },
  {
    id: 'CHAL-CC02',
    category: 'combate',
    title: 'Purificador',
    description: 'Cura veneno con antídoto o hierba curativa 2 veces en una sesión.',
    condition: { type: 'cure_poison', target: null, amount: 2, extra: {} },
    reward: { xp: 70, gold: 12, rep: 1 },
    min_level: 1, max_level: 5,
    classes: ['clerigo'], events: null, shared: false
  },
  {
    id: 'CHAL-CC03',
    category: 'combate',
    title: 'Fuerza Sagrada',
    description: 'Derrota al Espectro del Corredor usando habilidades de clase Clérigo.',
    condition: { type: 'kill_with_magic', target: 'Espectro del Corredor', amount: 1, extra: { class: 'clerigo' } },
    reward: { xp: 130, gold: 24, rep: 2 },
    min_level: 3, max_level: 7,
    classes: ['clerigo'], events: null, shared: false
  },
  {
    id: 'CHAL-CC04',
    category: 'combate',
    title: 'Sustentación',
    description: 'Termina una sesión de 10+ kills con más HP que al inicio (gracias a curaciones).',
    condition: { type: 'session_kills', target: null, amount: 10, extra: { hp_gain_vs_start: true } },
    reward: { xp: 140, gold: 25, rep: 2 },
    min_level: 3, max_level: 99,
    classes: ['clerigo'], events: null, shared: false
  },
  {
    id: 'CHAL-CC05',
    category: 'combate',
    title: 'Ofrenda al Altar',
    description: 'Usa el altar del dungeon (pray) durante la sesión.',
    condition: { type: 'use_altar', target: null, amount: 1, extra: {} },
    reward: { xp: 50, gold: 8, rep: 1 },
    min_level: 1, max_level: 99,
    classes: ['clerigo'], events: null, shared: false
  },

  // ─────────────────────────────────────────────────────────────────────────
  // CATEGORÍA 1: COMBATE — Desafíos de Evento
  // ─────────────────────────────────────────────────────────────────────────

  {
    id: 'CHAL-CE01',
    category: 'combate',
    title: 'Sangre de la Luna',
    description: 'Durante Luna de Sangre, derrota a 3 monstruos de nivel 3+. El XP es el mayor.',
    condition: { type: 'kill_event', target: null, amount: 3, extra: { event: 'BLOOD_MOON', monsters_min_level: 3 } },
    reward: { xp: 180, gold: 30, rep: 3 },
    min_level: 0, max_level: 99,
    classes: null, events: ['BLOOD_MOON'], shared: false
  },
  {
    id: 'CHAL-CE02',
    category: 'combate',
    title: 'Marea de Espectros',
    description: 'Durante Marea Espectral, derrota a 5 espectros. Los de la Prisión cuentan.',
    condition: { type: 'kill_event', target: 'espectro', amount: 5, extra: { event: 'SPECTRAL_TIDE' } },
    reward: { xp: 200, gold: 35, rep: 3 },
    min_level: 0, max_level: 99,
    classes: null, events: ['SPECTRAL_TIDE'], shared: false
  },
  {
    id: 'CHAL-CE03',
    category: 'combate',
    title: 'Recarga Arcana',
    description: 'Durante Carga Arcana, causa 150 puntos de daño con hechizos.',
    condition: { type: 'spell_damage', target: null, amount: 150, extra: { event: 'ARCANE_SURGE' } },
    reward: { xp: 180, gold: 30, rep: 3 },
    min_level: 0, max_level: 99,
    classes: null, events: ['ARCANE_SURGE'], shared: false
  },

  // ─────────────────────────────────────────────────────────────────────────
  // CATEGORÍA 2: EXPLORACIÓN / CRAFTEO
  // ─────────────────────────────────────────────────────────────────────────

  {
    id: 'CHAL-E01',
    category: 'exploracion',
    title: 'Explorador Básico',
    description: 'Visita 5 salas distintas en una sesión. El dungeon no se recorre solo.',
    condition: { type: 'visit_rooms', target: null, amount: 5, extra: {} },
    reward: { xp: 40, gold: 6, rep: 0 },
    min_level: 1, max_level: 99,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-E02',
    category: 'exploracion',
    title: 'Cartógrafo del Dungeon',
    description: 'Visita 10 salas distintas en una sesión. Cubrí la mitad del mapa.',
    condition: { type: 'visit_rooms', target: null, amount: 10, extra: {} },
    reward: { xp: 80, gold: 12, rep: 1 },
    min_level: 2, max_level: 99,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-E03',
    category: 'exploracion',
    title: 'El Dungeon Completo',
    description: 'Visita 15 salas distintas en una sesión. Solo los más metódicos logran esto.',
    condition: { type: 'visit_rooms', target: null, amount: 15, extra: {} },
    reward: { xp: 150, gold: 25, rep: 2 },
    min_level: 3, max_level: 99,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-E04',
    category: 'exploracion',
    title: 'Herrero Improvisado',
    description: 'Craftea cualquier ítem en el dungeon.',
    condition: { type: 'craft', target: null, amount: 1, extra: {} },
    reward: { xp: 60, gold: 10, rep: 1 },
    min_level: 2, max_level: 99,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-E05',
    category: 'exploracion',
    title: 'Artesano Dedicado',
    description: 'Craftea 3 ítems en una sesión. Busca recetas en el dungeon.',
    condition: { type: 'craft', target: null, amount: 3, extra: {} },
    reward: { xp: 120, gold: 20, rep: 2 },
    min_level: 2, max_level: 99,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-E06',
    category: 'exploracion',
    title: 'El Maestro Artesano',
    description: 'Craftea 5 ítems en una sesión. Un día productivo en la Forja.',
    condition: { type: 'craft', target: null, amount: 5, extra: {} },
    reward: { xp: 200, gold: 35, rep: 3 },
    min_level: 3, max_level: 99,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-E07',
    category: 'exploracion',
    title: 'Pocero de Pociones',
    description: 'Craftea una poción de vida (hierba curativa → poción de vida).',
    condition: { type: 'craft_specific', target: 'poción de vida', amount: 1, extra: {} },
    reward: { xp: 70, gold: 12, rep: 1 },
    min_level: 2, max_level: 99,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-E08',
    category: 'exploracion',
    title: 'Arma Mejorada',
    description: 'Craftea cualquier arma (lanza espectral reforzada, alabarda espectral u otras).',
    condition: { type: 'craft_weapon', target: null, amount: 1, extra: {} },
    reward: { xp: 100, gold: 18, rep: 2 },
    min_level: 3, max_level: 99,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-E09',
    category: 'exploracion',
    title: 'Maestro Alquimista',
    description: 'Craftea el brebaje del hongo (hongo azul + veneno concentrado).',
    condition: { type: 'craft_specific', target: 'brebaje del hongo', amount: 1, extra: {} },
    reward: { xp: 90, gold: 16, rep: 2 },
    min_level: 3, max_level: 99,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-E10',
    category: 'exploracion',
    title: 'El Tesoro del Pozo',
    description: 'Recoge el loot completo del Krakeling Abismal — lo que sea que deje.',
    condition: { type: 'loot_monster', target: 'Krakeling Abismal', amount: 1, extra: {} },
    reward: { xp: 80, gold: 15, rep: 1 },
    min_level: 4, max_level: 99,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-E11',
    category: 'exploracion',
    title: 'Hongo Recolector',
    description: 'Recoge un hongo (azul, rojo o verde) del dungeon.',
    condition: { type: 'loot_item', target: 'hongo', amount: 1, extra: {} },
    reward: { xp: 30, gold: 5, rep: 0 },
    min_level: 1, max_level: 99,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-E12',
    category: 'exploracion',
    title: 'La Llave del Pozo',
    description: 'Encuentra y usá la llave oxidada para acceder a la reja del Pozo Sin Fondo.',
    condition: { type: 'use_item', target: 'llave oxidada', amount: 1, extra: {} },
    reward: { xp: 70, gold: 12, rep: 1 },
    min_level: 2, max_level: 99,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-E13',
    category: 'exploracion',
    title: 'Sala Sellada',
    description: 'Descubrí (visita) la sala más profunda del dungeon (sala 14, Coliseo de Huesos).',
    condition: { type: 'visit_room', target: '14', amount: 1, extra: {} },
    reward: { xp: 150, gold: 30, rep: 2 },
    min_level: 5, max_level: 99,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-E14',
    category: 'exploracion',
    title: 'Herencia de Batalla',
    description: 'Equipá un arma crafteada por vos mismo.',
    condition: { type: 'equip_crafted', target: null, amount: 1, extra: {} },
    reward: { xp: 80, gold: 15, rep: 1 },
    min_level: 2, max_level: 99,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-E15',
    category: 'exploracion',
    title: 'Curioso y Precavido',
    description: 'Usá examine en 3 objetos distintos del dungeon en una sesión.',
    condition: { type: 'examine', target: null, amount: 3, extra: {} },
    reward: { xp: 40, gold: 6, rep: 0 },
    min_level: 1, max_level: 99,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-E16',
    category: 'exploracion',
    title: 'El Grimorio Perdido',
    description: 'Encuentra y recoge el libro de hechizos de alguna sala del dungeon.',
    condition: { type: 'loot_item', target: 'libro de hechizos', amount: 1, extra: {} },
    reward: { xp: 80, gold: 14, rep: 1 },
    min_level: 2, max_level: 99,
    classes: ['mago'], events: null, shared: false
  },
  {
    id: 'CHAL-E17',
    category: 'exploracion',
    title: 'Cofre del Lich',
    description: 'Si alguien derrota al Lich, recogé el cofre de oro antes de que desaparezca.',
    condition: { type: 'loot_item', target: 'cofre de oro', amount: 1, extra: {} },
    reward: { xp: 120, gold: 20, rep: 2 },
    min_level: 6, max_level: 99,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-E18',
    category: 'exploracion',
    title: 'El Peso del Inventario',
    description: 'Llevá 8 o más ítems en el inventario al mismo tiempo.',
    condition: { type: 'inventory_count', target: null, amount: 8, extra: {} },
    reward: { xp: 50, gold: 8, rep: 0 },
    min_level: 2, max_level: 99,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-E19',
    category: 'exploracion',
    title: 'Expedicionario',
    description: 'Iniciá una expedición (si el sistema está disponible).',
    condition: { type: 'start_expedition', target: null, amount: 1, extra: {} },
    reward: { xp: 100, gold: 18, rep: 2 },
    min_level: 4, max_level: 99,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-E20',
    category: 'exploracion',
    title: 'Sin Olvidar el Loot',
    description: 'Recogé ítems del suelo 8 veces en una sesión. Dejar cosas es un desperdicio.',
    condition: { type: 'loot_pickup', target: null, amount: 8, extra: {} },
    reward: { xp: 60, gold: 10, rep: 0 },
    min_level: 1, max_level: 99,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-E21',
    category: 'exploracion',
    title: 'Forja Activa',
    description: 'Usá la Forja (sala 12) para craftear. La interfaz del dungeon es parte del juego.',
    condition: { type: 'use_forja', target: null, amount: 1, extra: {} },
    reward: { xp: 70, gold: 12, rep: 1 },
    min_level: 3, max_level: 99,
    classes: null, events: null, shared: false
  },

  // ─────────────────────────────────────────────────────────────────────────
  // CATEGORÍA 3: ECONOMÍA
  // ─────────────────────────────────────────────────────────────────────────

  {
    id: 'CHAL-EC01',
    category: 'economia',
    title: 'Primera Compra',
    description: 'Comprá cualquier ítem a Aldric. Todo aventurero necesita equiparse.',
    condition: { type: 'buy', target: null, amount: 1, extra: {} },
    reward: { xp: 30, gold: 5, rep: 1 },
    min_level: 1, max_level: 99,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-EC02',
    category: 'economia',
    title: 'Shopper Dedicado',
    description: 'Comprá 3 ítems a Aldric en una sesión.',
    condition: { type: 'buy', target: null, amount: 3, extra: {} },
    reward: { xp: 70, gold: 10, rep: 2 },
    min_level: 2, max_level: 99,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-EC03',
    category: 'economia',
    title: 'Inversión Mayor',
    description: 'Gastá 50 monedas o más en la tienda de Aldric en una sesión.',
    condition: { type: 'gold_spent', target: null, amount: 50, extra: {} },
    reward: { xp: 100, gold: 15, rep: 2 },
    min_level: 3, max_level: 99,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-EC04',
    category: 'economia',
    title: 'Vendedor de Huesos',
    description: 'Vendé 3 ítems a Aldric. Todo tiene valor para el mercader.',
    condition: { type: 'sell', target: null, amount: 3, extra: {} },
    reward: { xp: 50, gold: 8, rep: 1 },
    min_level: 1, max_level: 99,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-EC05',
    category: 'economia',
    title: 'Liquidación Total',
    description: 'Vendé 5 ítems a Aldric en una sesión. Hacé lugar en el inventario.',
    condition: { type: 'sell', target: null, amount: 5, extra: {} },
    reward: { xp: 80, gold: 14, rep: 1 },
    min_level: 2, max_level: 99,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-EC06',
    category: 'economia',
    title: 'El Cofre del Tesoro',
    description: 'Acumulá 100 monedas de oro en tu bolsa en algún momento de la sesión.',
    condition: { type: 'gold_balance', target: null, amount: 100, extra: {} },
    reward: { xp: 80, gold: 12, rep: 1 },
    min_level: 3, max_level: 99,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-EC07',
    category: 'economia',
    title: 'Gran Fortuna',
    description: 'Acumulá 200 monedas de oro en tu bolsa. Para los que saben farmear.',
    condition: { type: 'gold_balance', target: null, amount: 200, extra: {} },
    reward: { xp: 150, gold: 20, rep: 2 },
    min_level: 5, max_level: 99,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-EC08',
    category: 'economia',
    title: 'Subastero',
    description: 'Participá en la Casa de Subastas (sala 17) — ofrecé o comprá en subasta.',
    condition: { type: 'auction_action', target: null, amount: 1, extra: {} },
    reward: { xp: 60, gold: 10, rep: 1 },
    min_level: 2, max_level: 99,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-EC09',
    category: 'economia',
    title: 'Ganancia del Día',
    description: 'Ganás 80 monedas de oro durante la sesión (por kills + loot + ventas).',
    condition: { type: 'gold_earned', target: null, amount: 80, extra: {} },
    reward: { xp: 90, gold: 15, rep: 1 },
    min_level: 2, max_level: 99,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-EC10',
    category: 'economia',
    title: 'El Precio del Acero',
    description: 'Comprá la espada de acero a Aldric (el arma más cara de la tienda base).',
    condition: { type: 'buy_specific', target: 'espada de acero', amount: 1, extra: {} },
    reward: { xp: 120, gold: 0, rep: 3 },
    min_level: 5, max_level: 99,
    classes: ['guerrero', 'picaro'], events: null, shared: false
  },
  {
    id: 'CHAL-EC11',
    category: 'economia',
    title: 'Fiebre del Oro',
    description: 'Durante el evento Fiebre del Oro, farmear 150 monedas. El momento es ahora.',
    condition: { type: 'gold_earned', target: null, amount: 150, extra: { event: 'GOLD_RUSH' } },
    reward: { xp: 180, gold: 0, rep: 3 },
    min_level: 2, max_level: 99,
    classes: null, events: ['GOLD_RUSH'], shared: false
  },
  {
    id: 'CHAL-EC12',
    category: 'economia',
    title: 'Poción de Mago',
    description: 'Comprá una poción de maná o poción de maná mayor a Aldric.',
    condition: { type: 'buy_specific', target: 'poción de maná', amount: 1, extra: {} },
    reward: { xp: 40, gold: 5, rep: 1 },
    min_level: 1, max_level: 99,
    classes: ['mago'], events: null, shared: false
  },
  {
    id: 'CHAL-EC13',
    category: 'economia',
    title: 'Equipo Completo',
    description: 'Vendé tu equipo viejo al actualizar a arma mejor. (Vendé una arma y comprá otra mejor en la misma sesión.)',
    condition: { type: 'sell_weapon', target: null, amount: 1, extra: { also_buy_weapon: true } },
    reward: { xp: 90, gold: 12, rep: 1 },
    min_level: 2, max_level: 99,
    classes: null, events: null, shared: false
  },
  {
    id: 'CHAL-EC14',
    category: 'economia',
    title: 'El Reputado',
    description: 'Alcanzá 10 puntos de Reputación con Aldric en total. (Acumulativo entre sesiones.)',
    condition: { type: 'rep_total', target: null, amount: 10, extra: {} },
    reward: { xp: 100, gold: 20, rep: 0 },
    min_level: 2, max_level: 99,
    classes: null, events: null, shared: false
  },

  // ─────────────────────────────────────────────────────────────────────────
  // GRAN DESAFÍO DEL DÍA (shared: true — mismo para todos los jugadores)
  // Pool de 15 desafíos. Se elige uno por día con seed por fecha UTC.
  // ─────────────────────────────────────────────────────────────────────────

  {
    id: 'CHAL-GD01',
    category: 'gran_desafio',
    title: 'Purga Colectiva',
    description: 'Entre todos, derrota a 15 Esqueletos Guerreros hoy. El dungeon lo sabe.',
    condition: { type: 'kill_collective', target: 'Esqueleto Guerrero', amount: 15, extra: {} },
    reward: { xp: 80, gold: 15, rep: 2 },
    min_level: 0, max_level: 99,
    classes: null, events: null, shared: true
  },
  {
    id: 'CHAL-GD02',
    category: 'gran_desafio',
    title: 'La Caza del Lich',
    description: 'Alguien tiene que derrotar al Lich hoy. ¿Será vos?',
    condition: { type: 'kill_any', target: 'Lich Anciano', amount: 1, extra: { killer_bonus: 200, all_online_bonus: 50 } },
    reward: { xp: 200, gold: 0, rep: 5 },
    min_level: 0, max_level: 99,
    classes: null, events: null, shared: true
  },
  {
    id: 'CHAL-GD03',
    category: 'gran_desafio',
    title: 'Día de la Forja',
    description: 'Entre todos, craftear 10 ítems hoy.',
    condition: { type: 'craft_collective', target: null, amount: 10, extra: { min_contribution: 1 } },
    reward: { xp: 60, gold: 10, rep: 1 },
    min_level: 0, max_level: 99,
    classes: null, events: null, shared: true
  },
  {
    id: 'CHAL-GD04',
    category: 'gran_desafio',
    title: 'La Gran Purga',
    description: 'Derrota colectivamente 30 monstruos de cualquier tipo hoy.',
    condition: { type: 'kill_collective', target: null, amount: 30, extra: { min_contribution: 3 } },
    reward: { xp: 70, gold: 12, rep: 1 },
    min_level: 0, max_level: 99,
    classes: null, events: null, shared: true
  },
  {
    id: 'CHAL-GD05',
    category: 'gran_desafio',
    title: 'Mercado Activo',
    description: 'Entre todos, realizar 5 transacciones en la Casa de Subastas.',
    condition: { type: 'auction_collective', target: null, amount: 5, extra: {} },
    reward: { xp: 50, gold: 8, rep: 1 },
    min_level: 0, max_level: 99,
    classes: null, events: null, shared: true
  },
  {
    id: 'CHAL-GD06',
    category: 'gran_desafio',
    title: 'Asedio Espectral',
    description: 'Entre todos, derrota a 10 Espectros del Corredor.',
    condition: { type: 'kill_collective', target: 'Espectro del Corredor', amount: 10, extra: {} },
    reward: { xp: 100, gold: 20, rep: 2 },
    min_level: 0, max_level: 99,
    classes: null, events: null, shared: true
  },
  {
    id: 'CHAL-GD07',
    category: 'gran_desafio',
    title: 'Día del Artesano',
    description: '3 o más jugadores craftean al menos 1 ítem hoy.',
    condition: { type: 'craft_players', target: null, amount: 3, extra: { min_craft_per_player: 1 } },
    reward: { xp: 80, gold: 15, rep: 2 },
    min_level: 0, max_level: 99,
    classes: null, events: null, shared: true
  },
  {
    id: 'CHAL-GD08',
    category: 'gran_desafio',
    title: 'Expedición Colectiva',
    description: 'Al menos 2 jugadores inician una expedición hoy.',
    condition: { type: 'expedition_players', target: null, amount: 2, extra: {} },
    reward: { xp: 100, gold: 18, rep: 2 },
    min_level: 0, max_level: 99,
    classes: null, events: null, shared: true
  },
  {
    id: 'CHAL-GD09',
    category: 'gran_desafio',
    title: 'El Gran Tesoro',
    description: 'Entre todos, acumular 500 monedas de oro en el servidor hoy.',
    condition: { type: 'gold_server_day', target: null, amount: 500, extra: {} },
    reward: { xp: 80, gold: 12, rep: 1 },
    min_level: 0, max_level: 99,
    classes: null, events: null, shared: true
  },
  {
    id: 'CHAL-GD10',
    category: 'gran_desafio',
    title: 'Limpieza de Arañas',
    description: 'Entre todos, matar 20 Arañas Tejedoras en el Pozo.',
    condition: { type: 'kill_collective', target: 'Araña Tejedora', amount: 20, extra: {} },
    reward: { xp: 70, gold: 10, rep: 1 },
    min_level: 0, max_level: 99,
    classes: null, events: null, shared: true
  },
  {
    id: 'CHAL-GD11',
    category: 'gran_desafio',
    title: 'Invasión de Goblins',
    description: 'Entre todos, matar 25 Goblins Merodeadores hoy.',
    condition: { type: 'kill_collective', target: 'Goblin Merodeador', amount: 25, extra: {} },
    reward: { xp: 75, gold: 12, rep: 1 },
    min_level: 0, max_level: 99,
    classes: null, events: null, shared: true
  },
  {
    id: 'CHAL-GD12',
    category: 'gran_desafio',
    title: 'El Gólem Caído',
    description: 'Alguien derrota al Gólem de Piedra o al Golem de Forja hoy.',
    condition: { type: 'kill_any', target: 'golem', amount: 1, extra: { killer_bonus: 150, all_online_bonus: 40 } },
    reward: { xp: 150, gold: 0, rep: 3 },
    min_level: 0, max_level: 99,
    classes: null, events: null, shared: true
  },
  {
    id: 'CHAL-GD13',
    category: 'gran_desafio',
    title: 'Día de las Pociones',
    description: 'Entre todos, usar 10 pociones en combate hoy.',
    condition: { type: 'use_potion_collective', target: null, amount: 10, extra: {} },
    reward: { xp: 60, gold: 10, rep: 1 },
    min_level: 0, max_level: 99,
    classes: null, events: null, shared: true
  },
  {
    id: 'CHAL-GD14',
    category: 'gran_desafio',
    title: 'Exploradores Unidos',
    description: '3+ jugadores visitan 10+ salas distintas hoy.',
    condition: { type: 'visit_rooms_players', target: null, amount: 3, extra: { min_rooms_per_player: 10 } },
    reward: { xp: 80, gold: 12, rep: 2 },
    min_level: 0, max_level: 99,
    classes: null, events: null, shared: true
  },
  {
    id: 'CHAL-GD15',
    category: 'gran_desafio',
    title: 'Campeón del Día',
    description: 'El jugador con más kills al final del día (UTC) gana.',
    condition: { type: 'top_kills_day', target: null, amount: 1, extra: { second_place_xp: 80, second_place_gold: 15 } },
    reward: { xp: 150, gold: 30, rep: 3 },
    min_level: 0, max_level: 99,
    classes: null, events: null, shared: true
  },

  // ─────────────────────────────────────────────────────────────────────────
  // DESAFÍO SEMANAL COLECTIVO
  // Pool de 8 objetivos. Se elige uno por semana (seed por ISO week number UTC).
  // ─────────────────────────────────────────────────────────────────────────

  {
    id: 'CHAL-S01',
    category: 'semanal',
    title: 'La Gran Purga Semanal',
    description: 'Entre todos, matar 200 monstruos esta semana.',
    condition: { type: 'kill_collective_week', target: null, amount: 200, extra: {} },
    reward: { xp: 0, gold: 0, rep: 0 },  // Recompensa especial: evento 2h XP ×1.5
    min_level: 0, max_level: 99,
    classes: null, events: null, shared: true
  },
  {
    id: 'CHAL-S02',
    category: 'semanal',
    title: 'Forja de Campeones',
    description: 'Entre todos, craftear 50 ítems esta semana.',
    condition: { type: 'craft_collective_week', target: null, amount: 50, extra: {} },
    reward: { xp: 0, gold: 0, rep: 0 },  // Recompensa especial: ítem exclusivo cuerno de campeón 48h
    min_level: 0, max_level: 99,
    classes: null, events: null, shared: true
  },
  {
    id: 'CHAL-S03',
    category: 'semanal',
    title: 'El Lich Debe Caer',
    description: 'Derrotar al Lich Anciano 5 veces esta semana.',
    condition: { type: 'kill_collective_week', target: 'Lich Anciano', amount: 5, extra: {} },
    reward: { xp: 0, gold: 0, rep: 0 },  // Recompensa especial: +25% XP por 24h semana siguiente
    min_level: 0, max_level: 99,
    classes: null, events: null, shared: true
  },
  {
    id: 'CHAL-S04',
    category: 'semanal',
    title: 'Mercado Activo',
    description: 'Completar 20 subastas en la Casa de Subastas.',
    condition: { type: 'auction_collective_week', target: null, amount: 20, extra: {} },
    reward: { xp: 0, gold: 0, rep: 0 },  // Recompensa especial: Aldric baja precios 15% por 48h
    min_level: 0, max_level: 99,
    classes: null, events: null, shared: true
  },
  {
    id: 'CHAL-S05',
    category: 'semanal',
    title: 'Liga de Expediciones',
    description: '10 expediciones iniciadas y completadas esta semana.',
    condition: { type: 'expedition_complete_week', target: null, amount: 10, extra: {} },
    reward: { xp: 0, gold: 0, rep: 0 },  // Recompensa especial: evento Viento de Fortuna 2h
    min_level: 0, max_level: 99,
    classes: null, events: null, shared: true
  },
  {
    id: 'CHAL-S06',
    category: 'semanal',
    title: 'Los Espectros Deben Caer',
    description: 'Matar 80 espectros esta semana (Espectros del Corredor + Guardia Espectral + Campeón).',
    condition: { type: 'kill_spectral_week', target: 'espectro', amount: 80, extra: {} },
    reward: { xp: 0, gold: 0, rep: 0 },  // Recompensa especial: espectros dropean 2x oro por 24h
    min_level: 0, max_level: 99,
    classes: null, events: null, shared: true
  },
  {
    id: 'CHAL-S07',
    category: 'semanal',
    title: 'Economía del Dungeon',
    description: 'Gastar 1000 monedas de oro en la tienda de Aldric entre todos esta semana.',
    condition: { type: 'gold_spent_week', target: null, amount: 1000, extra: {} },
    reward: { xp: 0, gold: 0, rep: 0 },  // Recompensa especial: amuleto del mercader (sell +10%) 72h
    min_level: 0, max_level: 99,
    classes: null, events: null, shared: true
  },
  {
    id: 'CHAL-S08',
    category: 'semanal',
    title: 'Cartógrafos Colectivos',
    description: '5 jugadores distintos visitan las 15 salas del dungeon esta semana.',
    condition: { type: 'visit_all_rooms_players', target: null, amount: 5, extra: { required_rooms: 15 } },
    reward: { xp: 0, gold: 0, rep: 0 },  // Recompensa especial: +10% XP en todas las salas 48h
    min_level: 0, max_level: 99,
    classes: null, events: null, shared: true
  }

];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de consulta del pool
// ─────────────────────────────────────────────────────────────────────────────

/**
 * IDs de todos los Gran Desafíos del Día (para el assigner).
 */
const GRAND_CHALLENGE_IDS = challengePool
  .filter(c => c.category === 'gran_desafio')
  .map(c => c.id);

/**
 * IDs de todos los Desafíos Semanales.
 */
const WEEKLY_CHALLENGE_IDS = challengePool
  .filter(c => c.category === 'semanal')
  .map(c => c.id);

/**
 * Pool personal de combate (por clase, filtrando shared y semanales).
 * @param {string} playerClass - 'mago', 'guerrero', 'picaro', 'clerigo'
 * @param {number} playerLevel
 * @param {string[]} activeEvents - IDs de eventos activos (ej: ['BLOOD_MOON'])
 * @returns {object[]}
 */
function getCombatPool(playerClass, playerLevel, activeEvents = []) {
  return challengePool.filter(c => {
    if (c.category !== 'combate') return false;
    if (c.shared) return false;
    if (playerLevel < c.min_level) return false;
    if (playerLevel > c.max_level) return false;
    if (c.classes !== null && !c.classes.includes(playerClass)) return false;
    if (c.events !== null) {
      // Solo disponible si el evento está activo
      const hasEvent = c.events.some(e => activeEvents.includes(e));
      if (!hasEvent) return false;
    }
    return true;
  });
}

/**
 * Pool personal de exploración + economía.
 * @param {string} playerClass
 * @param {number} playerLevel
 * @param {string[]} activeEvents
 * @returns {object[]}
 */
function getExploEconPool(playerClass, playerLevel, activeEvents = []) {
  return challengePool.filter(c => {
    if (c.category !== 'exploracion' && c.category !== 'economia') return false;
    if (c.shared) return false;
    if (playerLevel < c.min_level) return false;
    if (playerLevel > c.max_level) return false;
    if (c.classes !== null && !c.classes.includes(playerClass)) return false;
    if (c.events !== null) {
      const hasEvent = c.events.some(e => activeEvents.includes(e));
      if (!hasEvent) return false;
    }
    return true;
  });
}

/**
 * Obtener un desafío por ID.
 * @param {string} id
 * @returns {object|undefined}
 */
function getChallengeById(id) {
  return challengePool.find(c => c.id === id);
}

module.exports = {
  challengePool,
  GRAND_CHALLENGE_IDS,
  WEEKLY_CHALLENGE_IDS,
  getCombatPool,
  getExploEconPool,
  getChallengeById
};
