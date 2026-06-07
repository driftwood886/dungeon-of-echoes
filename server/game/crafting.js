/**
 * crafting.js — Sistema de crafteo/alquimia
 *
 * Cubre T092.
 *
 * Recetas de crafteo: cada receta define dos ingredientes (sin importar el orden)
 * y el resultado. Los ingredientes se consumen y el resultado se agrega al inventario.
 */

'use strict';

// ─── Catálogo de recetas ──────────────────────────────────────────────────────
//
// Cada receta: { ingredients: [itemA, itemB], result: itemName, message: string }
// Los ingredientes son case-insensitive y el orden no importa.

const RECIPES = [
  // Alquimia básica
  {
    ingredients: ['hierba curativa', 'poción menor'],
    result: 'poción de vida',
    message: 'Mezclas la hierba curativa con la poción menor. El líquido burbujea y se transforma en una poción de vida potente.',
  },
  {
    ingredients: ['hierba curativa', 'poción de salud'],
    result: 'poción de vida',
    message: 'Triturar la hierba curativa en la poción de salud la amplifica. Obtenés una poción de vida.',
  },
  {
    ingredients: ['antídoto', 'poción de salud'],
    result: 'poción de vida',
    message: 'Combinar el antídoto con la poción de salud genera una mezcla curativa más poderosa.',
  },
  // Armas
  {
    ingredients: ['veneno concentrado', 'espada oxidada'],
    result: 'espada envenenada',
    message: 'Untás el veneno de araña en la hoja oxidada. La espada ahora supura una toxina verde.',
  },
  {
    ingredients: ['veneno concentrado', 'cuchillo oxidado'],
    result: 'cuchillo envenenado',
    message: 'El veneno concentrado impregna el filo del cuchillo. Ahora cada corte puede envenenar.',
  },
  {
    ingredients: ['núcleo de forja', 'espada oxidada'],
    result: 'espada de obsidiana',
    message: '¡El núcleo de forja funde y reforja la espada oxidada! La hoja emerge como pura obsidiana negra brillante.',
  },
  {
    ingredients: ['fragmento de hielo', 'cristal mágico'],
    result: 'lanza espectral',
    message: 'El hielo antiguo y el cristal mágico se fusionan en una reacción de luz fría. Aparece una lanza de luz negra helada.',
  },
  {
    // Fix DIS-008: alternativa con ítems que dropean los monstruos de la Galería de Hielo
    ingredients: ['fragmento de hielo', 'cristal helado'],
    result: 'lanza espectral',
    message: 'El fragmento de hielo y el cristal helado se fusionan en un fulgurante estallido de frío eterno. Una lanza de hielo puro y magia emerge de la reacción.',
  },
  {
    ingredients: ['garra de esqueleto', 'cuerda'],
    result: 'látigo de garras',
    message: 'Atás las garras de esqueleto con la cuerda para crear un látigo improvisado pero mortal.',
  },
  {
    // DIS-D292: escudo roto ahora tiene uso — los huesos del mismo esqueleto refuerzan el escudo
    ingredients: ['escudo roto', 'garra de esqueleto'],
    result: 'escudo de gladiador',
    message: 'Usás la garra del esqueleto para reforzar los bordes del escudo roto. Los huesos se funden con el metal de forma extraña. El escudo queda más sólido que antes — alguien grabó "MAXIMUS" en él hace mucho tiempo.',
  },
  // Misc / Coleccionables
  {
    ingredients: ['hilo de seda', 'cuerda'],
    result: 'red resistente',
    message: 'Tejés el hilo de araña con la cuerda común. La mezcla resulta en una red increíblemente resistente.',
  },
  {
    ingredients: ['monedas de cobre', 'monedas de plata'],
    result: 'monedas de oro',
    message: 'Combinás las monedas de cobre y plata usando una técnica alquímica básica. ¡Se transforman en monedas de oro!',
  },
  {
    ingredients: ['diente afilado', 'hilo de seda'],
    result: 'collar de garras',
    message: 'Ensartás el diente en el hilo de seda. El amuleto resultante emana un poder primitivo.',
  },
  {
    ingredients: ['perla negra', 'tomo sellado'],
    result: 'grimorio del abismo',
    message: 'La perla negra reacciona con las runas del tomo sellado. El sello se rompe y el libro absorbe el poder de la perla.',
  },
  {
    ingredients: ['cristal helado', 'tinta de kraken'],
    result: 'poción de poder',
    message: 'Disolvés el cristal helado en la tinta de kraken. La mezcla forma una poción densa y humeante.',
  },
  // ── Recetas del Dungeon Extendido (T132) ─────────────────────────────────
  {
    ingredients: ['cristal resonante', 'esencia de eco'],
    result: 'lanza espectral del eco',
    message: 'El cristal resonante absorbe la esencia del Eco Viviente. La energía solidifica en una lanza fantasmal que vibra con las voces de los caídos.',
  },
  {
    ingredients: ['fragmento de vacío', 'esencia del abismo'],
    result: 'daga del vacío',
    message: 'El fragmento del Abismo Eterno y la esencia de la Sombra del Vacío se fusionan. La daga resultante parece absorber la realidad misma.',
  },
  {
    ingredients: ['cristal resonante', 'polvo de eco'],
    result: 'amuleto del eco',
    message: 'Combinás el cristal con el polvo. El amuleto resultante pulsa con ecos de memorias antiguas.',
  },
];

// ─── Catálogo de ítems artesanales nuevos ─────────────────────────────────────
// (ítems que solo existen como resultado de crafteo)
const CRAFTED_ITEMS = {
  'espada envenenada':  { type: 'weapon', effect: 'attack_bonus', amount: 5, description: 'Una espada que supura veneno verde. +5 de ataque. Los golpes tienen 30% de envenenar al objetivo.' },
  'cuchillo envenenado': { type: 'weapon', effect: 'attack_bonus', amount: 3, description: 'Un cuchillo impregnado de veneno. +3 de ataque. Los golpes tienen 25% de envenenar al objetivo.' },
  'látigo de garras':   { type: 'weapon', effect: 'attack_bonus', amount: 4, description: 'Un látigo improvisado con garras de esqueleto. Largo alcance. +4 de ataque.' },
  'red resistente':     { type: 'misc', description: 'Una red de araña y cuerda trenzadas. Casi imposible de romper. Podría usarse para atrapar cosas.' },
  'collar de garras':   { type: 'armor', effect: 'defense_bonus', amount: 2, description: 'Un collar artesanal de dientes de goblin y seda de araña. Emana poder primitivo. +2 de defensa.' },
  'grimorio del abismo':{ type: 'weapon', effect: 'attack_bonus', amount: 10, description: 'Un grimorio sellado con el poder de la perla negra abismal. +10 de ataque mágico.' },
  // Ítems del Dungeon Extendido (T132)
  'lanza espectral del eco': { type: 'weapon', effect: 'attack_bonus', amount: 8, description: 'Una lanza fantasmal que resuena con voces de los caídos. +8 de ataque. Vibra al contacto con criaturas espectrales.' },
  'daga del vacío':     { type: 'weapon', effect: 'attack_bonus', amount: 12, description: 'Una daga que parece absorber la realidad. +12 de ataque. El arma más poderosa forjada en las profundidades del Abismo.' },
  'amuleto del eco':    { type: 'misc', description: 'Un amuleto que pulsa con ecos de memorias antiguas. Los sabios dicen que protege su portador de los efectos de la Cámara del Eco.' },
};

// ─── Función de crafteo ────────────────────────────────────────────────────────

/**
 * Normaliza un nombre de ítem (minúsculas, trim, sin tildes NFD).
 */
function normalize(name) {
  return name.toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Busca la receta que coincide con los dos ingredientes (sin importar el orden).
 * @param {string} a - primer ingrediente
 * @param {string} b - segundo ingrediente
 * @returns {Object|null} la receta o null si no existe
 */
function findRecipe(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  return RECIPES.find(r => {
    const [r0, r1] = r.ingredients.map(normalize);
    return (r0 === na && r1 === nb) || (r0 === nb && r1 === na);
  }) || null;
}

/**
 * Ejecuta un crafteo: valida inventario, consume ítems y devuelve resultado.
 * @param {Object} player - objeto jugador con inventory como array parsed
 * @param {string} itemA - nombre primer ítem
 * @param {string} itemB - nombre segundo ítem
 * @returns {{ ok: boolean, text: string, result?: string }}
 */
function craft(player, itemA, itemB) {
  const recipe = findRecipe(itemA, itemB);
  if (!recipe) {
    return {
      ok: false,
      text: `No conocés ninguna receta que combine "${itemA}" con "${itemB}". Intentá otros materiales.`,
    };
  }

  // Verificar que el jugador tiene ambos ítems
  const inv = [...player.inventory]; // copia
  const na = normalize(itemA);
  const nb = normalize(itemB);

  const idxA = inv.findIndex(i => normalize(i) === na);
  if (idxA === -1) {
    return { ok: false, text: `No tenés "${itemA}" en el inventario. Si lo usaste antes, ya no está disponible.` };
  }
  // Remover A para no contar el mismo ítem dos veces si A === B
  inv.splice(idxA, 1);
  const idxB = inv.findIndex(i => normalize(i) === nb);
  if (idxB === -1) {
    return { ok: false, text: `No tenés "${itemB}" en el inventario. Si lo usaste antes, ya no está disponible.` };
  }

  return {
    ok: true,
    text: recipe.message + `\n✨ Creaste: **${recipe.result}**`,
    consumeA: itemA,
    consumeB: itemB,
    result: recipe.result,
  };
}

/**
 * Lista todas las recetas conocidas como texto.
 */
function listRecipes() {
  const lines = RECIPES.map(r => `  ${r.ingredients[0]} + ${r.ingredients[1]} → ${r.result}`);
  return '📖 **Recetas conocidas:**\n' + lines.join('\n');
}

module.exports = { craft, findRecipe, listRecipes, CRAFTED_ITEMS, RECIPES };
