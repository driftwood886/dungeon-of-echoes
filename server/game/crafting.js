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
    // DIS-509: mejora de la lanza espectral — requiere esencia etérea (drop del Espectro del Corredor)
    // Hace que el +9 ATK esté disponible en zona media en lugar de zona 3
    ingredients: ['lanza espectral', 'esencia etérea'],
    result: 'lanza espectral reforzada',
    message: 'La esencia etérea del espectro impregna la lanza. La luz negra se intensifica, el frío se vuelve absoluto. La lanza espectral emerge reforzada y más mortífera.',
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
  // ── DIS-492: Recetas para ítems de loot basura ───────────────────────────
  {
    ingredients: ['pelaje áspero', 'escama abismal'],
    result: 'cuero de criatura',
    message: 'Curtís el pelaje áspero usando la escama abismal como raspador. El resultado es un cuero irregular pero sorprendentemente resistente.',
  },
  {
    // DIS-692: receta para capa de araña (acumulada frecuentemente) + hongo azul (misc sin uso de crafteo)
    ingredients: ['capa de araña', 'hongo azul'],
    result: 'ungüento de araña',
    message: 'Mezclás los filamentos de la capa con el polvo luminiscente del hongo azul. La pasta resultante tiene propiedades que endurecen la piel temporalmente.',
  },
  {
    // DIS-492: permite reciclar escamas sobrantes en algo útil
    ingredients: ['escama abismal', 'cuerda'],
    result: 'manopla abismal',
    message: 'Cosés las escamas del Krakeling a una cuerda trenzada. Las escamas forman un guante improvisado de aspecto ominoso.',
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
  // ── DIS-560: Recetas exclusivas de Mago ──────────────────────────────────
  {
    // Cristal fragmentado + hierba curativa = catalizador mágico
    ingredients: ['cristal fragmentado', 'hierba curativa'],
    result: 'catalizador mágico',
    message: 'Triturar el cristal fragmentado en la hierba curativa genera una reacción inesperada: en lugar de sanar, la energía curativa de la planta se convierte en poder arcano. El catalizador resultante amplifica hechizos.',
  },
  {
    // Esencia etérea + poción de maná = poción de maná mayor (craft alternativo)
    ingredients: ['esencia etérea', 'poción de maná'],
    result: 'poción de maná mayor',
    message: 'La esencia etérea del espectro se funde con la poción de maná, amplificando sus propiedades restaurativas. Obtenés una poción de maná mayor.',
  },
  {
    // Cristal mágico + esencia de eco = catalizador mágico (ruta alternativa)
    ingredients: ['cristal mágico', 'esencia de eco'],
    result: 'catalizador mágico',
    message: 'El cristal mágico absorbe la esencia de eco. La energía espectral cristaliza en un catalizador que concentra poder arcano.',
  },
];

// ─── Catálogo de ítems artesanales nuevos ─────────────────────────────────────
// (ítems que solo existen como resultado de crafteo)
const CRAFTED_ITEMS = {
  'espada envenenada':  { type: 'weapon', effect: 'attack_bonus', amount: 5, description: 'Una espada que supura veneno verde. +5 de ataque. Los golpes tienen 30% de envenenar al objetivo.' },
  'cuchillo envenenado': { type: 'weapon', effect: 'attack_bonus', amount: 3, description: 'Un cuchillo impregnado de veneno. +3 de ataque. Los golpes tienen 25% de envenenar al objetivo.' },
  'látigo de garras':   { type: 'weapon', effect: 'attack_bonus', amount: 4, description: 'Un látigo improvisado con garras de esqueleto. Largo alcance. +4 de ataque.' },
  'red resistente':     { type: 'misc', description: 'Una red de araña y cuerda trenzadas. Casi imposible de romper. Podría usarse para atrapar cosas.' },
  'collar de garras':   { type: 'armor', effect: 'defense_bonus', amount: 2, description: 'Un collar artesanal de colmillos de murciélago vampiro y seda de araña. Emana poder primitivo. +2 de defensa. Se equipa como armadura: `wear collar de garras`.' },
  'grimorio del abismo':{ type: 'weapon', effect: 'attack_bonus', amount: 10, description: 'Un grimorio sellado con el poder de la perla negra abismal. +10 de ataque mágico.' },
  // DIS-492: ítems de reciclaje de loot basura
  'cuero de criatura':  { type: 'armor', effect: 'defense_bonus', amount: 2, description: 'Cuero curtido con escamas abismales. Áspero pero funcional. +2 de defensa.' },
  'manopla abismal':    { type: 'weapon', effect: 'attack_bonus', amount: 4, description: 'Una manopla de escamas del Krakeling. Los picos rasgan en cada golpe. +4 de ataque.' },
  // DIS-692: reciclaje de capa de araña + hongo azul
  'ungüento de araña':  { type: 'potion', effect: 'defense_bonus', amount: 2, duration: 120, description: 'Una pasta que endurece la piel por 2 minutos. +2 DEF temporal. Consumible.' },
  // Ítems del Dungeon Extendido (T132)
  'lanza espectral del eco': { type: 'weapon', effect: 'attack_bonus', amount: 10, description: 'Una lanza fantasmal que resuena con voces de los caídos. +10 de ataque. Vibra al contacto con criaturas espectrales.' },
  'lanza espectral reforzada': { type: 'weapon', effect: 'attack_bonus', amount: 9, description: 'La lanza espectral básica reforzada con esencia etérea. La luz negra es más densa, el frío más absoluto. +9 de ataque.' },
  'daga del vacío':     { type: 'weapon', effect: 'attack_bonus', amount: 12, description: 'Una daga que parece absorber la realidad. +12 de ataque. El arma más poderosa forjada en las profundidades del Abismo.' },
  'amuleto del eco':    { type: 'misc', description: 'Un amuleto que pulsa con ecos de memorias antiguas. Los sabios dicen que protege su portador de los efectos de la Cámara del Eco.' },
  // DIS-560: ítems artesanales de Mago
  'catalizador mágico': { type: 'weapon', effect: 'attack_bonus', amount: 7, mage_only_bonus: 3, description: 'Un concentrado de energía arcana. Amplifica la potencia de los hechizos del Mago. +7 de ataque. Los Magos reciben +3 de ataque adicional al empuñarlo.' },
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
    // DIS-577: Sugerir recetas cercanas cuando hay ingredientes similares
    const na = normalize(itemA);
    const nb = normalize(itemB);

    // Buscar ingredientes parecidos en las recetas (comparten palabras de ≥4 letras)
    const wordsOf = s => s.split(/\s+/).filter(w => w.length >= 4);
    const wordsA = wordsOf(na);
    const wordsB = wordsOf(nb);

    const similar = [];
    for (const r of RECIPES) {
      const ri0 = normalize(r.ingredients[0]);
      const ri1 = normalize(r.ingredients[1]);
      const riResult = normalize(r.result);
      const ri0Words = wordsOf(ri0);
      const ri1Words = wordsOf(ri1);
      const riResultWords = wordsOf(riResult);

      // ¿Alguno de los ingredientes provistos comparte palabras con algún ingrediente de la receta?
      const shareWords = (inputWords, recipeIngWords) =>
        inputWords.some(w => recipeIngWords.some(rw => rw.includes(w) || w.includes(rw)));

      const matchA0 = shareWords(wordsA, ri0Words) || shareWords(wordsA, ri1Words);
      const matchB0 = shareWords(wordsB, ri0Words) || shareWords(wordsB, ri1Words);
      // DIS-709: también buscar coincidencias con el RESULTADO de la receta
      // (ej: "lanza espectral + esencia de eco" → sugiere "cristal resonante + esencia de eco → lanza espectral del eco")
      const matchAResult = shareWords(wordsA, riResultWords);
      const matchBResult = shareWords(wordsB, riResultWords);

      // Solo sugerir si al menos un ingrediente provisto es parecido a un ingrediente O AL RESULTADO de la receta
      // BUG-601: excluir solo si es match EXACTO (findRecipe lo habría encontrado ya)
      const exactMatch = (na === ri0 && nb === ri1) || (na === ri1 && nb === ri0);
      const hasMatch = matchA0 || matchB0 || matchAResult || matchBResult;
      if (hasMatch && !exactMatch) {
        // Score más alto si AMBOS ingredientes tienen coincidencia (receta más relevante)
        // Coincidencia con ingredientes vale más que con resultado (ingredientes son más específicos)
        const ingScore = (matchA0 ? 1 : 0) + (matchB0 ? 1 : 0);
        const resultScore = (matchAResult || matchBResult) ? 0.5 : 0;
        similar.push({ r, score: ingScore + resultScore });
      }
    }
    // Ordenar por score descendente (2 = ambos coinciden, 1 = uno coincide)
    similar.sort((a, b) => b.score - a.score);

    let hint = '';
    if (similar.length > 0) {
      const suggestions = similar.slice(0, 3).map(({r}) => `  ${r.ingredients[0]} + ${r.ingredients[1]} → ${r.result}`).join('\n');
      hint = `\n\n💡 ¿Quisiste decir alguna de estas recetas?\n${suggestions}`;
    }
    // DIS-709: Hint especial si el input parece buscar por el NOMBRE del resultado (ej: "lanza espectral + esencia de eco")
    const resultHints = similar.filter(({r}) => {
      const riResult = normalize(r.result);
      const rWords = wordsOf(riResult);
      return wordsOf(na).some(w => rWords.some(rw => rw.includes(w) || w.includes(rw))) ||
             wordsOf(nb).some(w => rWords.some(rw => rw.includes(w) || w.includes(rw)));
    });
    if (resultHints.length > 0 && resultHints[0].score < 1) {
      // El match principal es por resultado, no por ingrediente — añadir aclaración
      const rh = resultHints[0].r;
      hint = `\n\n💡 Para obtener **${rh.result}**, la receta es:\n  ${rh.ingredients[0]} + ${rh.ingredients[1]} → ${rh.result}` + hint;
    }

    return {
      ok: false,
      text: `No conocés ninguna receta que combine "${itemA}" con "${itemB}". Intentá otros materiales.${hint}`,
    };
  }

  // Verificar que el jugador tiene ambos ítems
  const inv = [...player.inventory]; // copia
  const na = normalize(itemA);
  const nb = normalize(itemB);

  // BUG-617: verificar si el ítem está equipado (weapon/armor) en vez de en inventario
  const equippedWeapon = (player.equipped_weapon && player.equipped_weapon !== 'null') ? normalize(player.equipped_weapon) : null;
  const equippedArmor  = (player.equipped_armor  && player.equipped_armor  !== 'null') ? normalize(player.equipped_armor)  : null;

  const idxA = inv.findIndex(i => normalize(i) === na);
  if (idxA === -1) {
    if (na === equippedWeapon || na === equippedArmor) {
      // DIS-889: mostrar flujo completo unequip → craft → equip
      return { ok: false, text: `«${itemA}» está equipado — no podés usarlo como ingrediente mientras lo tenés puesto.\n💡 Flujo: \`unequip\` → \`craft ${itemA} con ${itemB}\` → \`equip ${recipe ? recipe.result : 'resultado'}\`` };
    }
    return { ok: false, text: `No tenés "${itemA}" en el inventario. Si lo usaste antes, ya no está disponible.` };
  }
  // Remover A para no contar el mismo ítem dos veces si A === B
  inv.splice(idxA, 1);
  const idxB = inv.findIndex(i => normalize(i) === nb);
  if (idxB === -1) {
    if (nb === equippedWeapon || nb === equippedArmor) {
      // DIS-889: mostrar flujo completo unequip → craft → equip
      return { ok: false, text: `«${itemB}» está equipado — no podés usarlo como ingrediente mientras lo tenés puesto.\n💡 Flujo: \`unequip\` → \`craft ${itemA} con ${itemB}\` → \`equip ${recipe ? recipe.result : 'resultado'}\`` };
    }
    return { ok: false, text: `No tenés "${itemB}" en el inventario. Si lo usaste antes, ya no está disponible.` };
  }

  const resultDef = CRAFTED_ITEMS[recipe.result] || {};
  let equipHint = resultDef.type === 'armor'
    ? `\n💡 Es una armadura — equipala con: \`wear ${recipe.result}\``
    : resultDef.type === 'weapon'
    ? `\n💡 Es un arma — equipala con: \`equip ${recipe.result}\``
    : '';
  // DIS-979: si el ítem crafteado es un arma y es mejor que la equipada, agregar nota de comparación
  if (resultDef.type === 'weapon' && player.equipped_weapon && player.equipped_weapon !== 'null') {
    const equippedAtk = (() => {
      const eqDef = CRAFTED_ITEMS[player.equipped_weapon];
      return eqDef && eqDef.attack ? eqDef.attack : null;
    })();
    const newAtk = resultDef.attack || null;
    if (equippedAtk !== null && newAtk !== null && newAtk > equippedAtk) {
      equipHint += ` ⬆️ (${newAtk} ATK vs ${equippedAtk} ATK del ${player.equipped_weapon} — ¡es mejor!)`;
    }
  }

  return {
    ok: true,
    text: recipe.message + `\n✨ Creaste: **${recipe.result}**` + equipHint,
    consumeA: itemA,
    consumeB: itemB,
    result: recipe.result,
  };
}

/**
 * Lista todas las recetas conocidas como texto.
 */
function listRecipes() {
  const lines = RECIPES.map(r => {
    // DIS-709: Para lanza espectral del eco, mostrar origen de ingredientes
    if (r.result === 'lanza espectral del eco') {
      return `  ${r.ingredients[0]} (Campeón Espectral) + ${r.ingredients[1]} (Eco Viviente) → ${r.result}`;
    }
    return `  ${r.ingredients[0]} + ${r.ingredients[1]} → ${r.result}`;
  });
  return '📖 **Recetas conocidas:**\n' + lines.join('\n');
}

module.exports = { craft, findRecipe, listRecipes, CRAFTED_ITEMS, RECIPES };
