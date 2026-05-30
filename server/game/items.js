/**
 * items.js — Definición y lógica de ítems
 *
 * Cubre T017.
 *
 * Los ítems son representados como strings en el juego (en inventario y suelo).
 * Este módulo centraliza:
 *   - Catálogo de ítems conocidos con sus efectos
 *   - Funciones para resolver qué hace un ítem al usarse
 */

'use strict';

// ─── Catálogo de ítems ────────────────────────────────────────────────────────
//
// Tipos:
//   - potion: restaura HP
//   - weapon: aumenta ataque del jugador mientras lo usa
//   - misc:   sin efecto mecánico directo (coleccionables, lore)

const ITEM_CATALOG = {
  // ── Pociones ────────────────────────────────────────────────────────────────
  'poción de salud':     { type: 'potion', effect: 'heal', amount: 15, description: 'Una pequeña poción rojiza que restaura 15 HP.' },
  'poción de vida':      { type: 'potion', effect: 'heal', amount: 25, description: 'Una poción grande que restaura 25 HP.' },
  'poción menor':        { type: 'potion', effect: 'heal', amount: 8,  description: 'Una poción débil. Restaura 8 HP.' },
  'poción de poder':     { type: 'potion', effect: 'heal', amount: 20, description: 'Una poción oscura que restaura 20 HP y deja un zumbido en los huesos.' },
  'poción de maná':      { type: 'mana_potion', effect: 'restore_mana', amount: 10, description: 'Un frasco azul brillante. Restaura 10 puntos de maná instantáneamente.' },
  'poción de maná mayor': { type: 'mana_potion', effect: 'restore_mana', amount: 20, description: 'Un frasco azul intenso. Restaura 20 puntos de maná.' },

  // ── Antídotos ────────────────────────────────────────────────────────────────
  'antídoto':            { type: 'antidote', effect: 'cure_poison', description: 'Un frasco con líquido verde pálido. Cura inmediatamente el envenenamiento.' },
  'antidoto':            { type: 'antidote', effect: 'cure_poison', description: 'Un frasco con líquido verde pálido. Cura inmediatamente el envenenamiento.' },
  'hierba curativa':     { type: 'antidote', effect: 'cure_poison', description: 'Un manojo de hierba que los druidas usan para purificar venenos.' },

  // ── Armas (dungeon base) ──────────────────────────────────────────────────
  'espada oxidada':      { type: 'weapon', effect: 'attack_bonus', amount: 3,  description: 'Una espada vieja con filo irregular. +3 de ataque.' },
  'cuchillo oxidado':    { type: 'weapon', effect: 'attack_bonus', amount: 1,  description: 'Un cuchillo pequeño y oxidado. +1 de ataque.' },
  'espada larga':        { type: 'weapon', effect: 'attack_bonus', amount: 5,  description: 'Una espada bien balanceada. +5 de ataque.' },
  'cristal mágico':      { type: 'weapon', effect: 'attack_bonus', amount: 7,  description: 'Un cristal que amplifica la fuerza. +7 de ataque.' },
  'piedra de poder':     { type: 'weapon', effect: 'attack_bonus', amount: 4,  description: 'Vibra levemente en tu mano. +4 de ataque.' },
  'diente afilado':      { type: 'weapon', effect: 'attack_bonus', amount: 2,  description: 'Un colmillo de murciélago vampiro, afilado como una aguja. +2 de ataque.' },
  'garra de esqueleto':  { type: 'weapon', effect: 'attack_bonus', amount: 3,  description: 'La garra de un esqueleto endurecida por la magia oscura. +3 de ataque.' },
  'hacha rústica':       { type: 'weapon', effect: 'attack_bonus', amount: 4,  description: 'Un hacha de mano, tosca pero funcional. +4 de ataque.' },

  // ── Armas (dungeon expandido) ─────────────────────────────────────────────
  'espada de obsidiana': { type: 'weapon', effect: 'attack_bonus', amount: 12, description: 'Una espada forjada de obsidiana pura que absorbe la luz. +12 de ataque. El arma más poderosa del dungeon.' },
  'lanza espectral':     { type: 'weapon', effect: 'attack_bonus', amount: 9,  description: 'Una lanza hecha de luz negra condensada. Atraviesa armaduras físicas. +9 de ataque.' },
  'alabarda de huesos':  { type: 'weapon', effect: 'attack_bonus', amount: 6,  description: 'La alabarda de un guardia espectral. Ligera a pesar de estar hecha de hueso. +6 de ataque.' },
  'martillo de forja':   { type: 'weapon', effect: 'attack_bonus', amount: 7,  description: 'Un martillo colosal de las forjas. Aplastante y pesado. +7 de ataque.' },

  // ── Misc / coleccionables (dungeon base) ─────────────────────────────────
  'antorcha':            { type: 'misc', description: 'Una antorcha encendida. Ilumina los pasillos oscuros.' },
  'libro viejo':         { type: 'misc', description: 'Un grimorio con páginas incomprensibles.' },
  'cuerda':              { type: 'misc', description: 'Una cuerda resistente de unos 10 metros.' },
  'llave oxidada':       { type: 'misc', description: 'Una llave pequeña y oxidada. ¿Qué abrirá?' },
  'amuleto oscuro':      { type: 'misc', description: 'Un amuleto con una gema negra. Irradia una energía extraña.' },
  'monedas de cobre':    { type: 'misc', description: 'Unas pocas monedas de cobre gastadas.' },
  'monedas de plata':    { type: 'misc', description: 'Monedas de plata con inscripciones antiguas.' },
  'monedas de oro':      { type: 'misc', description: 'Monedas de oro resplandecientes. Son pocas, pero valen mucho.' },
  'pelaje áspero':       { type: 'misc', description: 'El pelaje de una rata gigante. Áspero al tacto.' },
  'escudo roto':         { type: 'misc', description: 'Un escudo con el centro partido. Inútil para defenderse.' },
  'esencia etérea':      { type: 'misc', description: 'Una esencia brumosa dentro de un frasco. Resuena con el más allá.' },
  'mochila de cuero':    { type: 'misc', description: 'Una mochila resistente de cuero curtido. Útil para cargar cosas.' },
  'vela encendida':      { type: 'misc', description: 'Una vela que arde con una llama temblorosa. Apenas ilumina.' },
  'libro de hechizos':   { type: 'misc', description: 'Un libro de hechizos con runas grabadas. La tinta parece moverse.' },
  'gancho de hierro':    { type: 'misc', description: 'Un gancho de hierro forjado. Podría servir para escalar.' },
  'cadenas rotas':       { type: 'misc', description: 'Cadenas de hierro partido. Aún huelen a sufrimiento.' },
  'corona rota':         { type: 'misc', description: 'Una corona de metal ennegrecido, partida en dos. Perteneció a alguien poderoso.' },
  'hongo azul':          { type: 'misc', description: 'Un hongo luminiscente de color azul profundo. Tiene propiedades alquímicas.' },
  'hilo de seda':        { type: 'misc', description: 'Hilo de seda de araña, increíblemente resistente. Se usa en armaduras mágicas.' },
  'veneno concentrado':  { type: 'misc', description: 'Un vial con el veneno de la Araña Tejedora. Peligroso si se derrama.' },

  // ── Misc / coleccionables (dungeon expandido) ─────────────────────────────
  'fragmento de hielo':  { type: 'misc', description: 'Un bloque pequeño de hielo antiguo que no se derrite. Irradia un frío sobrenatural.' },
  'lingote de hierro':   { type: 'misc', description: 'Un lingote de hierro puro, salido directo de la forja. Pesado y caliente aún.' },
  'perla negra':         { type: 'misc', description: 'Una perla de un negro absoluto del lago subterráneo. Tiene un valor incalculable.' },
  'red de pesca':        { type: 'misc', description: 'Una red de pesca resistente. Podría servir para algo más que pescar.' },
  'escudo de gladiador': { type: 'misc', description: 'El escudo de un gladiador del coliseo de huesos. Lleva el nombre "MAXIMUS" grabado.' },
  'tomo sellado':        { type: 'misc', description: 'Un tomo sellado con cera negra. Las runas del sello pulsan suavemente. No se puede abrir... aún.' },
  'cristal helado':      { type: 'misc', description: 'Un cristal extraído del cuerpo de un Elemental de Hielo. Conserva el frío de siglos.' },
  'núcleo de forja':     { type: 'misc', description: 'El núcleo energético de un Golem de Forja. Aún irradia calor y magia residual.' },
  'tinta de kraken':     { type: 'misc', description: 'Un frasco de tinta negra del Krakeling Abismal. Muy densa y de olor nauseabundo.' },
  'escama abismal':      { type: 'misc', description: 'Una escama del Krakeling. Dura como el acero, ligera como el cartón.' },
  'filacteria rota':     { type: 'misc', description: 'La filacteria del Lich Anciano, destruida. Sin ella, el Lich no puede regresar... ¿verdad?' },
  'esencia de sombra':   { type: 'misc', description: 'La esencia condensada de las sombras del dungeon. Vibra en la oscuridad.' },

  // ── Ítems del Dungeon Extendido — Cámara del Eco y Abismo Eterno (T132) ────
  'cristal resonante':   { type: 'misc', description: 'Un cristal que vibra con el eco de los muertos. Emite un suave hum que aumenta con la luna. Material artesanal valioso.' },
  'polvo de eco':        { type: 'misc', description: 'Polvo que cayó de las paredes de la Cámara del Eco. Brilla con luz tenue al agitarlo.' },
  'esencia de eco':      { type: 'misc', description: 'La esencia destilada de un Eco Viviente. Guarda la memoria de aventureros caídos.' },
  'fragmento de vacío':  { type: 'misc', description: 'Un fragmento del Abismo Eterno. Absorbe la luz a su alrededor. Los sabios lo llaman "la nada solidificada".' },
  'esencia del abismo':  { type: 'misc', description: 'La esencia pura de la Sombra del Vacío. Vibra con una energía oscura y antigua. Ingrediente de recetas de alquimia avanzada.' },

  // ── Armas artesanales avanzadas — Dungeon Extendido (T132) ──────────────────
  'lanza espectral del eco': { type: 'weapon', effect: 'attack_bonus', amount: 8, description: 'Una lanza fantasmal que resuena con voces de los caídos. +8 de ataque.' },
  'daga del vacío':      { type: 'weapon', effect: 'attack_bonus', amount: 12, description: 'Una daga que parece absorber la realidad. +12 de ataque. El arma más poderosa de las profundidades.' },
  'amuleto del eco':     { type: 'misc', description: 'Un amuleto que pulsa con ecos de memorias antiguas. Protección de la Cámara del Eco.' },

  // ── Ítems artesanales (resultado de crafteo — T092) ───────────────────────
  'espada envenenada':   { type: 'weapon', effect: 'attack_bonus', amount: 5,  on_hit: { type: 'poison', chance: 0.35, damage: 2, turns: 3 }, description: 'Una espada que supura veneno verde. +5 de ataque. 35% de chance de envenenar al objetivo por 3 turnos.' },
  'cuchillo envenenado': { type: 'weapon', effect: 'attack_bonus', amount: 3,  on_hit: { type: 'poison', chance: 0.35, damage: 1, turns: 4 }, description: 'Un cuchillo impregnado de veneno de araña. +3 de ataque. 35% de chance de envenenar al objetivo por 4 turnos.' },
  'látigo de garras':    { type: 'weapon', effect: 'attack_bonus', amount: 4,  description: 'Un látigo improvisado con garras de esqueleto. +4 de ataque.' },
  'red resistente':      { type: 'misc', description: 'Una red de araña y cuerda trenzadas. Casi imposible de romper.' },
  'collar de garras':    { type: 'misc', description: 'Un collar artesanal de dientes y seda de araña. Emana poder primitivo.' },
  'grimorio del abismo': { type: 'weapon', effect: 'attack_bonus', amount: 10, on_hit: { type: 'shadow_bolt', chance: 0.20, bonus_damage: 8 }, description: 'Un grimorio sellado con poder abismal. +10 de ataque mágico. 20% de chance de lanzar un rayo de sombra (+8 daño extra).' },
};

// ─── Funciones públicas ───────────────────────────────────────────────────────

/**
 * Obtiene la definición de un ítem del catálogo.
 * Acepta coincidencia parcial case-insensitive.
 * @param {string} name
 * @returns {object|null} { type, effect, amount, description } o null
 */
function getItemDef(name) {
  const key = name.toLowerCase().trim();
  // Coincidencia exacta
  if (ITEM_CATALOG[key]) return { name: key, ...ITEM_CATALOG[key] };
  // Coincidencia parcial
  const found = Object.keys(ITEM_CATALOG).find(k => k.includes(key) || key.includes(k));
  if (found) return { name: found, ...ITEM_CATALOG[found] };
  return null;
}

/**
 * Busca un ítem en la lista dada (inventario o suelo) por nombre parcial.
 * @param {string[]} itemList
 * @param {string} query
 * @returns {string|null} el nombre exacto del ítem si se encuentra
 */
function findItem(itemList, query) {
  const q = query.toLowerCase().trim();
  return itemList.find(item => item.toLowerCase().includes(q)) || null;
}

/**
 * Devuelve una descripción del ítem.
 * @param {string} name
 * @returns {string}
 */
function describeItem(name) {
  const def = getItemDef(name);
  if (def) return def.description;
  return `Un objeto misterioso llamado "${name}".`;
}

module.exports = {
  ITEM_CATALOG,
  getItemDef,
  findItem,
  describeItem,
};
