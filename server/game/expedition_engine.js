/**
 * expedition_engine.js — Motor de Expediciones del Dungeon
 *
 * Sistema de misiones narrativas de sesión (medium loop).
 * Cada expedición tiene 2-3 pasos, al menos una decisión, y deja una huella
 * visible en el mundo al completarse.
 *
 * EPIC: Expediciones del Dungeon — EPIC-1157
 * Diseño: disenos/epic-expediciones.md, epic-expediciones-api.md
 * BD: disenos/epic-expediciones-schema.sql
 */

'use strict';

const db = require('../db/db.js');
const dungeon = require('./dungeon.js'); // IMPL-VV-1758: para getPaginasCongeladasLocation

// ─── Pool de expediciones ─────────────────────────────────────────────────────

/**
 * Catálogo completo de expediciones disponibles.
 *
 * Campos:
 *   id              slug único (snake_case)
 *   title           nombre para mostrar al jugador
 *   intro           2-3 líneas de contexto narrativo (se muestra al asignar)
 *   steps[]         array de pasos
 *     steps[].n         número de paso (1-indexado)
 *     steps[].objective texto del objetivo para el jugador
 *     steps[].trigger   tipo de trigger que avanza este paso
 *     steps[].condition función (player, context) => boolean — ¿se cumple el paso?
 *     steps[].message   texto a mostrar al completar el paso
 *   decision        (opcional) objeto de decisión en el último paso
 *     decision.prompt   pregunta que se le hace al jugador
 *     decision.choices  { a: { label, message, effect }, b: { label, message, effect } }
 *   reward          { xp, gold, item: null | nombre-item }
 *   world_effect    string clave del efecto mundial al completar (o null)
 *   unlock_condition { min_level: N }
 *   eligible_classes 'all' | array de clases (ej: ['picaro', 'asesino'])
 */
const EXPEDITION_POOL = [
  // ─────────────────────────────────────────────────────────────────────────
  // UNIVERSAL — accesible a cualquier clase, nivel 1+
  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'sello_carcelero',
    title: 'El Sello del Carcelero',
    intro: [
      'Aldric le compró a un aventurero muerto un sello oficial de carcelero.',
      'El escriba de la Casa de Subastas sospecha que podría usarse para liberar a alguien de la Prisión.',
      '¿Qué encontrarás allí?'
    ].join(' '),
    steps: [
      {
        n: 1,
        objective: 'Conseguir el Sello del Carcelero (cómpralo a Aldric o búscalo en la Prisión)',
        trigger: 'pickup',
        condition: (player, ctx) => {
          const name = (ctx.itemName || '').toLowerCase();
          return name.includes('sello') && name.includes('carcelero');
        },
        message: '🗝️ Conseguiste el Sello del Carcelero. Sentís el peso frío del metal en tu mano.'
      },
      {
        n: 2,
        objective: 'Usar el sello en la Prisión Subterránea (sala 8)',
        trigger: 'use',
        condition: (player, ctx) => {
          const name = (ctx.itemName || '').toLowerCase();
          const roomOk = ctx.roomId === 8;
          return name.includes('sello') && name.includes('carcelero') && roomOk;
        },
        message: '👻 El sello vibra y una figura espectral emerge de entre las sombras. "¿Quién te envía?", pregunta con voz de piedra.'
      }
    ],
    decision: {
      prompt: '⚡ Decisión: ¿Liberás al prisionero espectral o lo dejás en la celda? Escribí **decidir liberar** o **decidir dejar**.',
      choices: {
        a: {
          label: 'liberar',
          message: '🕊️ Rompés el sello. El espectro se disuelve en luz tenue y te susurra: "La segunda cámara tiene un pasaje oculto." Te acompaña en los próximos 2 combates.',
          effect: 'prisionero_liberado'
        },
        b: {
          label: 'dejar',
          message: '🔒 Guardás el sello. El espectro te mira fijamente. "Sabia elección. La información tiene precio." Te revela la ubicación de un tesoro en la Sala de los Ecos.',
          effect: 'prisionero_informacion'
        }
      }
    },
    reward: { xp: 150, gold: 30, item: null },
    world_effect: 'aldric_menciona_sello',
    unlock_condition: { min_level: 1 },
    eligible_classes: 'all'
  },

  {
    id: 'hongo_maestro',
    title: 'El Alquimista del Hongo',
    intro: [
      'El escriba murmuró algo sobre un ritual de los chamanes del Túnel de los Hongos.',
      'Se dice que tres hongos del Túnel, combinados con veneno concentrado y ofrendados en el altar,',
      'producen un efecto que nadie que lo haya visto puede describir coherentemente.'
    ].join(' '),
    steps: [
      {
        n: 1,
        objective: 'Recoger 3 hongos en el Túnel de los Hongos (sala 6) — probá "buscar" allí',
        trigger: 'pickup',
        condition: (player, ctx) => {
          const name = (ctx.itemName || '').toLowerCase();
          const isHongo = name.includes('hongo');
          const inTunel = ctx.roomId === 6;
          return isHongo && inTunel;
        },
        // Acumulativo — 3 hongos en sala 6 (cualquier tipo)
        cumulative: { field: 'hongos_recogidos', goal: 3 },
        message: '🍄 {count}/3 hongos recogidos. El olor es... perturbador.'
      },
      {
        n: 2,
        objective: 'Craftear el brebaje: "craftear hongo azul con veneno concentrado"',
        trigger: 'craft',
        condition: (player, ctx) => {
          // Cualquier crafteo que involucre un hongo y veneno
          const recipe = (ctx.recipe || '').toLowerCase();
          return recipe.includes('hongo') && (recipe.includes('veneno') || recipe.includes('concentrado'));
        },
        message: '⚗️ La mezcla burbujea y emite un vapor violeta. El escriba tenía razón: esto es raro.'
      },
      {
        n: 3,
        objective: 'Usar el brebaje en el altar de la Capilla Olvidada (sala 5) — "usar brebaje del hongo"',
        trigger: 'use',
        condition: (player, ctx) => {
          const name = (ctx.itemName || '').toLowerCase();
          const roomOk = ctx.roomId === 5;
          return (name.includes('brebaje') || name.includes('concocion') || name.includes('mezcla')) && roomOk;
        },
        message: '✨ El altar pulsa con luz violácea. Algo en las paredes cambia — sentís que el dungeon te recuerda.'
      }
    ],
    decision: null,
    reward: { xp: 120, gold: 20, item: 'esencia del hongo' },
    world_effect: 'altar_capilla_activado',
    unlock_condition: { min_level: 2 },
    eligible_classes: 'all'
  },

  {
    id: 'racha_del_trono',
    title: 'El Desafío del Trono',
    intro: [
      'El Trono de la Sala del Trono está grabado con runas antiguas: "Que el guerrero que derrote cinco sin caer se siente aquí."',
      'Nadie sabe qué pasa cuando alguien lo logra. Los que lo intentaron no volvieron para contarlo,',
      'o si volvieron, simplemente sonrieron y no dijeron nada.'
    ].join(' '),
    steps: [
      {
        n: 1,
        objective: 'Derrotar 5 monstruos en racha sin morir (reinicia si morís)',
        trigger: 'kill',
        condition: (player, ctx) => {
          return true; // acumulativo — se valida con data
        },
        cumulative: { field: 'racha_kills', goal: 5, reset_on_death: true },
        message: '⚔️ {count}/5 derrotados en racha.'
      },
      {
        n: 2,
        objective: 'Sentarte en el Trono de la Sala del Trono (sala 9) — usá `usar trono`',
        trigger: 'use',
        condition: (player, ctx) => {
          const name = (ctx.itemName || '').toLowerCase();
          const roomOk = ctx.roomId === 9;
          return name.includes('trono') && roomOk;
        },
        message: '👑 Las runas del Trono brillan al tocarte. Un poder antiguo fluye por tus venas.'
      }
    ],
    decision: {
      prompt: '⚡ El Trono te ofrece una elección: ¿Tomás el poder de inmediato o esperás para potenciarlo? Escribí **decidir poder** o **decidir esperar**.',
      choices: {
        a: {
          label: 'poder',
          message: '⚡ Absorbés el poder inmediatamente. +5 ATK por el resto de la sesión. El trono queda frío.',
          effect: 'trono_poder_activo'
        },
        b: {
          label: 'esperar',
          message: '🌟 Rechazás el poder inmediato. Las runas se intensifican. El próximo monstruo de jefe que mates da el doble de XP.',
          effect: 'trono_bonus_jefe'
        }
      }
    },
    reward: { xp: 200, gold: 50, item: null },
    world_effect: 'trono_activado',
    unlock_condition: { min_level: 3 },
    eligible_classes: 'all' // pero las expediciones Guerrero-exclusivas son otras
  },

  // ─────────────────────────────────────────────────────────────────────────
  // EXCLUSIVAS — Pícaro / Asesino
  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'mensajero_caido',
    title: 'El Mensajero Caído',
    intro: [
      'En el cadáver de un aventurero encontraste una carta sellada con cera roja.',
      'El destinatario es "A.", sin apellido. El sello es de la Casa de Subastas.',
      'Podés llevársela a Aldric... o abrirla primero.'
    ].join(' '),
    steps: [
      {
        n: 1,
        objective: 'Encontrar la carta sellada (buscar en cadáveres — usá `search` en combates)',
        trigger: 'pickup',
        condition: (player, ctx) => {
          const name = (ctx.itemName || '').toLowerCase();
          return name.includes('carta') && name.includes('sellada');
        },
        message: '📜 La carta está húmeda pero el sello está intacto. El olor a sangre es nuevo.'
      },
      {
        n: 2,
        objective: 'Llevar la carta a Aldric en la Sala 4 (Casa de Subastas)',
        trigger: 'enter',
        condition: (player, ctx) => {
          return ctx.roomId === 4; // Casa de Subastas
        },
        message: '🏪 Entrás a la Casa de Subastas con la carta. Aldric te mira fijamente cuando la ve.'
      }
    ],
    decision: {
      prompt: '⚡ Aldric extiende la mano. ¿Entregás la carta intacta o la abriste antes? Escribí **decidir entregar** o **decidir abrir**.',
      choices: {
        a: {
          label: 'entregar',
          message: '🤝 Aldric toma la carta y la abre rápidamente. Su expresión no cambia, pero guarda la carta sin mostrarte el contenido. "Discreción tiene su precio," murmura y te da oro extra.',
          effect: 'aldric_carta_entregada'
        },
        b: {
          label: 'abrir',
          message: '🔓 La carta revela coordenadas de una sala secreta del dungeon. Aldric nota que el sello está roto pero solo asiente. "El conocimiento es valioso también," dice. Obtenés la info pero Aldric es más frío contigo en el futuro.',
          effect: 'carta_abierta_info_secreta'
        }
      }
    },
    reward: { xp: 130, gold: 40, item: null },
    world_effect: 'aldric_conoce_mensajero',
    unlock_condition: { min_level: 1 },
    eligible_classes: ['picaro', 'asesino']
  },

  {
    id: 'mercader_deuda',
    title: 'La Deuda de Aldric',
    intro: [
      'Aldric te llama aparte. "Necesito un favor. No el tipo de favor que se hace a la luz del día."',
      'Comprale tres ítems específicos y Aldric te pedirá algo a cambio.',
      'En el negocio de las sombras, las deudas siempre se pagan.'
    ].join(' '),
    steps: [
      {
        n: 1,
        objective: 'Comprar 3 ítems en la tienda de Aldric',
        trigger: 'command',
        condition: (player, ctx) => {
          return ctx.command === 'buy' || ctx.command === 'comprar';
        },
        cumulative: { field: 'compras_aldric', goal: 3 },
        message: '🛒 {count}/3 compras realizadas. Aldric asiente imperceptiblemente.'
      },
      {
        n: 2,
        objective: 'Hablar con Aldric sobre el favor — usá `hablar aldric`',
        trigger: 'command',
        condition: (player, ctx) => {
          return (ctx.command === 'talk' || ctx.command === 'hablar') && 
                 (ctx.args || '').toLowerCase().includes('aldric');
        },
        message: '💬 Aldric se inclina y te susurra algo sobre una entrega pendiente en el Pozo Sin Fondo.'
      }
    ],
    decision: {
      prompt: '⚡ Aldric quiere que entregues un paquete sin abrir a alguien en la sala 6 (Pozo Sin Fondo). ¿Aceptás o te negás? Escribí **decidir aceptar** o **decidir negar**.',
      choices: {
        a: {
          label: 'aceptar',
          message: '📦 Aceptás el encargo. El paquete es pequeño y pesado. Al entregarlo en la sala 6, el destinatario asiente sin decir nada. Aldric te recompensa generosamente y ahora te trata como a un igual.',
          effect: 'aldric_deuda_pagada'
        },
        b: {
          label: 'negar',
          message: '🚫 Rechazás el encargo. Aldric encoge los hombros. "Como quieras." Pero sus precios suben un 10% para vos a partir de ahora.',
          effect: 'aldric_precio_sube'
        }
      }
    },
    reward: { xp: 100, gold: 60, item: null },
    world_effect: 'aldric_relacion_cambia',
    unlock_condition: { min_level: 2 },
    eligible_classes: ['picaro', 'asesino']
  },

  // ─────────────────────────────────────────────────────────────────────────
  // EXCLUSIVAS — Mago / Evoker
  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'runa_perdida',
    title: 'La Runa Perdida',
    intro: [
      'El escriba de la Casa de Subastas te mostró un fragmento de pergamino antiguo:',
      '"Tres runas del mismo signo, reunidas en la Fuente Eterna, revelan el Camino."',
      'Solo alguien con conocimiento arcano puede descifrar qué significa eso.'
    ].join(' '),
    steps: [
      {
        n: 1,
        objective: 'Reunir 3 runas del mismo tipo (revisá tu inventario con `inv runas`)',
        trigger: 'pickup',
        condition: (player, ctx) => {
          const name = (ctx.itemName || '').toLowerCase();
          return name.includes('runa');
        },
        cumulative: { field: 'runas_mismo_tipo', goal: 3, check_type: true },
        message: '🔮 {count}/3 runas del mismo tipo. El poder arcano aumenta.'
      },
      {
        n: 2,
        objective: 'Llevar las runas a la Fuente Eterna (sala 18) — usá `usar runas`',
        trigger: 'use',
        condition: (player, ctx) => {
          const name = (ctx.itemName || '').toLowerCase();
          const roomOk = ctx.roomId === 18; // Fuente Eterna (sala 18)
          return name.includes('runa') && roomOk;
        },
        message: '✨ Las tres runas resuenan en la Fuente. Algo en la sala cambia — el agua tiene un nuevo color.'
      }
    ],
    decision: {
      prompt: '⚡ La fusión de runas produce una esencia arcana. ¿La absorbés tú o la ofreces a la Fuente? Escribí **decidir absorber** o **decidir ofrecer**.',
      choices: {
        a: {
          label: 'absorber',
          message: '⚡ La esencia fluye hacia vos. Tu maná máximo aumenta en 10 permanentemente esta sesión. El agua de la Fuente vuelve a ser transparente.',
          effect: 'runa_fusion_absorbida'
        },
        b: {
          label: 'ofrecer',
          message: '🌊 La esencia desciende a la Fuente. El agua brilló intensamente por un segundo. El escriba, si le contás, te revela un hechizo secreto que ningún otro jugador conoce.',
          effect: 'runa_fusion_ofrecida'
        }
      }
    },
    reward: { xp: 160, gold: 25, item: null },
    world_effect: 'fuente_eterna_activada',
    unlock_condition: { min_level: 2 },
    eligible_classes: ['mago', 'evoker']
  },

  {
    id: 'paginas_congeladas',
    title: 'El Libro del Elemental',
    // IMPL-VV-1758: intro genérico — la sala exacta se informa en el objective dinámico
    intro: 'Una ráfaga de frío salió del dungeon. En algún rincón, páginas cubiertas de escarcha con texto arcano ilegible esperan ser encontradas.',
    steps: [
      {
        n: 1,
        // IMPL-VV-1758: objective como función que recibe expData con target_sala_paginas inyectado por assignExpedition()
        objective: (expData) => {
          const roomNames = {
            11: 'la Galería de Hielo (sala 11)',
            14: 'el Coliseo de Huesos (sala 14)',
            19: 'la Cámara del Eco (sala 19)',
            6:  'el Pasillo de las Ratas (sala 6)',
            7:  'la Caverna de las Arañas (sala 7)',
            8:  'la Prisión Subterránea (sala 8)',
            2:  'el Corredor Inicial (sala 2)',
            5:  'la Capilla Olvidada (sala 5)',
            13: 'el Pozo de los Susurros (sala 13)',
            20: 'la Sala del Vacío (sala 20)',
          };
          const targetSala = (expData && expData.target_sala_paginas) || 11;
          return `Encontrar las páginas congeladas (buscar en ${roomNames[targetSala] || 'sala ' + targetSala})`;
        },
        trigger: 'pickup',
        condition: (player, ctx) => {
          const name = (ctx.itemName || '').toLowerCase();
          return name.includes('paginas') || name.includes('páginas') || name.includes('hoja') && name.includes('congelada');
        },
        message: '📄 Las páginas se calientan al contacto. Podés leer fragmentos de un conjuro antiguo.'
      },
      {
        n: 2,
        objective: 'Llevar las páginas al escriba de la Casa de Subastas (sala 17)',
        trigger: 'enter',
        condition: (player, ctx) => ctx.roomId === 17,
        message: '📚 El escriba examina las páginas con ojos brillantes.'
      }
    ],
    decision: {
      prompt: '⚡ El escriba puede enseñarte el conjuro o quedarse con el libro a cambio de oro. ¿Qué elegís? Escribí **decidir aprender** o **decidir vender**.',
      choices: {
        a: {
          label: 'aprender',
          message: '📖 El escriba te enseña el conjuro "Fragmento de Hielo" — un ataque que ralentiza al enemigo. Disponible como habilidad especial hasta terminar la sesión.',
          effect: 'conjuro_hielo_aprendido'
        },
        b: {
          label: 'vender',
          message: '💰 El escriba te paga generosamente por el libro. El conjuro se pierde, pero el oro es real y pesa bien.',
          effect: 'libro_vendido'
        }
      }
    },
    reward: { xp: 140, gold: 35, item: null },
    world_effect: 'escriba_conoce_elemental',
    unlock_condition: { min_level: 2 },
    eligible_classes: ['mago', 'evoker']
  },

  // ─────────────────────────────────────────────────────────────────────────
  // EXCLUSIVAS — Guerrero / Paladín
  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'llave_del_vacio',
    title: 'La Llave del Vacío',
    intro: [
      'En la Sala de los Ecos encontraste una llave oxidada pegada a la pared por raíces.',
      'Ningún mago ni pícaro pudo arrancarla — la piedra cede solo ante fuerza bruta.',
      'Una puerta en el Santuario Profano espera esa llave desde hace generaciones.'
    ].join(' '),
    steps: [
      {
        n: 1,
        objective: 'Arrancar la llave oxidada de la pared en la Sala de los Ecos (sala 3) — usá `usar llave`',
        trigger: 'use',
        condition: (player, ctx) => {
          const name = (ctx.itemName || '').toLowerCase();
          const roomOk = ctx.roomId === 3;
          return name.includes('llave') && name.includes('oxidada') && roomOk;
        },
        message: '🗝️ La piedra cede con un crack. La llave está en tu mano, fría y pesada como la historia.'
      },
      {
        n: 2,
        objective: 'Usar la llave en la puerta del Santuario Profano (sala 16)',
        trigger: 'use',
        condition: (player, ctx) => {
          const name = (ctx.itemName || '').toLowerCase();
          const roomOk = ctx.roomId === 16;
          return name.includes('llave') && roomOk;
        },
        message: '🚪 La puerta gira lentamente. El aire que sale es antiguo. Lo que hay adentro... espera.'
      }
    ],
    decision: {
      prompt: '⚡ En el cuarto sellado hay un cofre y una figura encadenada. ¿Abrís el cofre primero o liberás a la figura? Escribí **decidir cofre** o **decidir liberar**.',
      choices: {
        a: {
          label: 'cofre',
          message: '📦 El cofre contiene armas antiguas de gran calidad. Mientras las examinás, la figura encadenada desaparece sin que te des cuenta.',
          effect: 'cofre_del_vacio_abierto'
        },
        b: {
          label: 'liberar',
          message: '⛓️ Rompés las cadenas. La figura — un paladín caído — te mira y dice: "El cofre es tuyo. Yo ya tomé lo que necesitaba." Desaparece, pero sentís que te dejó algo invisible.',
          effect: 'figura_liberada_bendicion'
        }
      }
    },
    reward: { xp: 180, gold: 45, item: null },
    world_effect: 'santuario_profano_abierto',
    unlock_condition: { min_level: 3 },
    eligible_classes: ['guerrero', 'paladin']
  },

  // ─── DIS-1532: Expedición post-endgame — se desbloquea al matar al Lich por primera vez ─
  {
    id: 'filacteria_del_lich',
    title: 'La Filacteria del Lich',
    intro: [
      'El Lich cayó. Pero el dungeon no festeja.',
      'En algún lugar existe su filacteria — el recipiente de su alma inmortal.',
      'Mientras exista, volverá. Aldric sabe algo. Y la Cámara del Eco guarda el último secreto.'
    ].join(' '),
    steps: [
      {
        n: 1,
        objective: 'Hablar con Aldric (sala 4) — preguntale sobre la filacteria: escribí `hablar aldric filacteria`',
        trigger: 'command',
        condition: (player, ctx) => {
          const cmd = (ctx.command || '').toLowerCase();
          // args puede llegar como string (cmdTalk) o array (otros hooks)
          const argsRaw = ctx.args || '';
          const args = Array.isArray(argsRaw) ? argsRaw.join(' ').toLowerCase() : String(argsRaw).toLowerCase();
          return (cmd === 'hablar' || cmd === 'talk' || cmd === 'npc') &&
            (args.includes('aldric') || ctx.roomId === 4) &&
            args.includes('filacteria');
        },
        message: '🧙 Aldric baja la voz: "Eso que estás buscando... existe. La filacteria del Lich está vinculada a los cristales resonantes de la Cámara del Eco. Hace siglos, el Lich escondió su alma ahí, sabiendo que nadie llegaría tan lejos. Pero vos llegaste. Ve a la Cámara y buscá los cristales que vibren diferente."'
      },
      {
        n: 2,
        objective: 'Ir a la Cámara del Eco (sala 19) y examinar los cristales: escribí `examinar cristales` allí',
        trigger: 'command',
        condition: (player, ctx) => {
          const cmd = (ctx.command || '').toLowerCase();
          const args = (ctx.args || []).join(' ').toLowerCase();
          const inEcho = ctx.roomId === 19;
          return inEcho && (cmd === 'examinar' || cmd === 'examine' || cmd === 'look') &&
            (args.includes('cristal') || args === '');
        },
        message: '🔮 Uno de los cristales del suelo vibra a un ritmo diferente. No resuena tu voz — resuena algo más antiguo. Al tocarlo, sentís un frío que no viene de la temperatura. Dentro del cristal, atrapada como un insecto en ámbar, palpita una luz oscura. La filacteria del Lich.'
      },
      {
        n: 3,
        objective: 'Recoger la filacteria del Lich del suelo de la Cámara del Eco',
        trigger: 'pickup',
        condition: (player, ctx) => {
          const name = (ctx.itemName || '').toLowerCase();
          return name.includes('filacteria');
        },
        message: '💀 La tomás con ambas manos. El frío sube por tus brazos. Algo dentro del cristal se mueve — te reconoce. Sentís el peso de una vida inmortal en tus palmas. Ahora podés destruirla... o conservarla.'
      }
    ],
    decision: {
      prompt: '⚡ Decisión final: ¿Destruís la filacteria del Lich para que nunca regrese, o la conservás como trofeo — sabiendo que algún día podría despertar? Escribí **decidir destruir** o **decidir conservar**.',
      choices: {
        a: {
          label: 'destruir',
          message: '💥 La aplastás contra el suelo de cristal. Un grito silencioso llena la sala — y luego, nada. Por primera vez en siglos, el dungeon respira. Aldric, al escuchar lo que hiciste, te ofrece su gratitud más antigua: \"Bien hecho, aventurero. Bien hecho.\" Pero sus ojos dicen otra cosa: \"¿Y ahora quién lo guardará?\"',
          effect: 'filacteria_destruida'
        },
        b: {
          label: 'conservar',
          message: '🔮 La envolvés con cuidado y la guardás. Sentís que algo dentro de ella te observa. Días después, notás que tus sueños son más oscuros. Aldric te mira raro cuando volvés: \"Trajiste eso aquí.\" No es una pregunta. \"No te olvides que la decisión fue tuya.\"',
          effect: 'filacteria_conservada'
        }
      }
    },
    reward: { xp: 400, gold: 150, item: 'filacteria rota' },
    world_effect: 'lich_filacteria_resuelta',
    unlock_condition: { min_level: 8, requires_lich_kill: true },
    eligible_classes: 'all'
  }
];

// ─── Helpers internos ─────────────────────────────────────────────────────────

/**
 * Normaliza el nombre de clase del jugador para comparación.
 * Engine usa 'guerrero', 'picaro', 'mago' etc.
 */
function normalizeClass(playerClass) {
  return (playerClass || 'sin_clase').toLowerCase().trim();
}

/**
 * Determina si un jugador puede acceder a una expedición dada.
 */
function isEligible(player, expedition) {
  if (player.level < expedition.unlock_condition.min_level) return false;
  // DIS-1532: requires_lich_kill — solo disponible si el jugador ya mató al Lich
  if (expedition.unlock_condition.requires_lich_kill) {
    const lichKills = player.lich_kills || 0;
    if (lichKills < 1) return false;
  }
  if (expedition.eligible_classes === 'all') return true;
  const pc = normalizeClass(player.player_class);
  return expedition.eligible_classes.includes(pc);
}

/**
 * Devuelve la definición de una expedición por ID.
 */
function getExpeditionDef(expeditionId) {
  return EXPEDITION_POOL.find(e => e.id === expeditionId) || null;
}

/**
 * Obtiene el paso actual de una expedición desde la definición.
 */
function getCurrentStep(expeditionDef, stepNum) {
  return expeditionDef.steps.find(s => s.n === stepNum) || null;
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Asigna una expedición al jugador si no tiene una activa.
 * @param {object} player - objeto player de la BD
 * @returns {{ expeditionId, title, introText } | null}
 */
function assignExpedition(player) {
  // Verificar que no tiene una activa
  const active = db.getActiveExpedition(player.id);
  if (active) return null;

  // Obtener completadas para excluirlas
  const completed = new Set(db.getCompletedExpeditions(player.id));

  // Filtrar pool por elegibilidad y no completadas
  const candidates = EXPEDITION_POOL.filter(exp => {
    return isEligible(player, exp) && !completed.has(exp.id);
  });

  if (candidates.length === 0) return null;

  // Elegir la primera disponible (determinístico)
  const chosen = candidates[0];

  // IMPL-VV-1758: caso especial para paginas_congeladas — inyectar sala dinámica en data
  if (chosen.id === 'paginas_congeladas') {
    const paginasLoc = dungeon.getPaginasCongeladasLocation(player);
    const initialData = { target_sala_paginas: paginasLoc.roomId };
    db.assignExpeditionToDB(player.id, chosen.id, initialData);
  } else {
    db.assignExpeditionToDB(player.id, chosen.id);
  }

  return {
    expeditionId: chosen.id,
    title: chosen.title,
    introText: chosen.intro
  };
}

/**
 * Verifica si el paso actual de la expedición activa del jugador se cumple dado un trigger.
 * Si se cumple, avanza el paso (o completa la expedición si era el último).
 *
 * @param {object} player - objeto player completo
 * @param {string} trigger - tipo de trigger ('kill', 'pickup', 'use', 'enter', 'craft', 'command')
 * @param {object} context - datos del trigger (monsterName, itemName, roomId, recipe, command, args)
 * @returns {{ matched, advanced, completed, needsDecision, message, worldEffect }}
 */
function checkStep(player, trigger, context = {}) {
  const result = { matched: false, advanced: false, completed: false, needsDecision: false, message: null, worldEffect: null };

  const activeRow = db.getActiveExpedition(player.id);
  if (!activeRow) return result;

  const expDef = getExpeditionDef(activeRow.expedition_id);
  if (!expDef) return result;

  const currentStepDef = getCurrentStep(expDef, activeRow.step);
  if (!currentStepDef) return result;

  // ¿El trigger coincide?
  if (currentStepDef.trigger !== trigger) return result;

  // ¿La condición se cumple?
  let conditionMet = false;

  if (currentStepDef.cumulative) {
    // Condición acumulativa: contar eventos hasta llegar al goal
    const { field, goal } = currentStepDef.cumulative;
    const data = activeRow.data || {};
    const prevCount = data[field] || 0;
    const newCount = prevCount + 1;

    // Verificar condición base del trigger (si la hay)
    const baseMet = currentStepDef.condition(player, context);
    if (baseMet) {
      data[field] = newCount;
      if (newCount >= goal) {
        conditionMet = true;
        // Guardar el count en el contexto para usarlo en el mensaje
        context._cumulativeCount = newCount;
      } else {
        // Actualizar contador sin avanzar paso
        db.advanceExpeditionStep(player.id, data);
        // Revert el step — advanceExpeditionStep suma 1, no queremos eso
        // Workaround: usar raw update
        db.raw().run(
          `UPDATE expeditions SET step = ?, data = ?, last_updated = datetime('now') WHERE player_id = ? AND state = 'active'`,
          [activeRow.step, JSON.stringify(data), player.id]
        );
        result.matched = true;
        const msg = currentStepDef.message.replace('{count}', newCount);
        result.message = msg;
        return result;
      }
    }
  } else {
    conditionMet = currentStepDef.condition(player, context);
  }

  if (!conditionMet) return result;

  result.matched = true;
  result.advanced = true;

  // ¿Era el último paso?
  const isLastStep = activeRow.step >= expDef.steps.length;

  if (isLastStep) {
    // Hay decisión pendiente o completado directo
    if (expDef.decision) {
      // Avanzar paso pero NO completar — esperamos la decisión del jugador
      const newData = { ...(activeRow.data || {}), awaiting_decision: true };
      db.advanceExpeditionStep(player.id, newData);
      result.needsDecision = true;
      result.message = (currentStepDef.message || '') + '\n\n' + expDef.decision.prompt;
    } else {
      // No hay decisión — completar directamente
      const finalData = { ...(activeRow.data || {}), completed_without_decision: true };
      db.completeExpeditionInDB(player.id, finalData);
      result.completed = true;
      result.worldEffect = expDef.world_effect;
      result.message = (currentStepDef.message || '') + '\n\n✨ **Expedición completada: ' + expDef.title + '**';
    }
  } else {
    // Avanzar al siguiente paso
    const newData = { ...(activeRow.data || {}), [`step_${activeRow.step}_completed`]: true };
    db.advanceExpeditionStep(player.id, newData);
    const rawMsg = currentStepDef.message || `Paso ${activeRow.step} completado.`;
    result.message = context._cumulativeCount
      ? rawMsg.replace('{count}', context._cumulativeCount)
      : rawMsg;
  }

  return result;
}

/**
 * Resuelve la decisión de una expedición que está esperando bifurcación.
 * @param {object} player
 * @param {string} choice - 'a' o el label de la opción (ej: 'liberar', 'dejar')
 * @returns {{ title, reward, worldEffect, message } | null}
 */
function resolveDecision(player, choice) {
  const activeRow = db.getActiveExpedition(player.id);
  if (!activeRow) return null;

  const data = activeRow.data || {};
  if (!data.awaiting_decision) return null;

  const expDef = getExpeditionDef(activeRow.expedition_id);
  if (!expDef || !expDef.decision) return null;

  const { choices } = expDef.decision;

  // Normalizar choice
  const normalizedChoice = (choice || '').toLowerCase().trim();
  let chosenOption = null;

  if (normalizedChoice === 'a' || normalizedChoice === choices.a.label.toLowerCase()) {
    chosenOption = choices.a;
  } else if (normalizedChoice === 'b' || normalizedChoice === choices.b.label.toLowerCase()) {
    chosenOption = choices.b;
  } else {
    return null; // choice inválida
  }

  // Completar la expedición
  const finalData = { ...data, awaiting_decision: false, decision: chosenOption.label, world_effects: [chosenOption.effect] };
  db.completeExpeditionInDB(player.id, finalData);

  return {
    title: expDef.title,
    reward: expDef.reward,
    worldEffect: chosenOption.effect,
    message: chosenOption.message
  };
}

/**
 * Completa una expedición sin decisión (o fuerza completado).
 * Generalmente llamado desde resolveDecision.
 */
function completeExpedition(player, choice) {
  return resolveDecision(player, choice);
}

/**
 * Devuelve el estado actual de la expedición activa para el comando `expedicion`.
 * @param {object} player
 * @returns {StatusResult | null}
 */
function getActiveExpeditionStatus(player) {
  const activeRow = db.getActiveExpedition(player.id);
  if (!activeRow) return null;

  const expDef = getExpeditionDef(activeRow.expedition_id);
  if (!expDef) return null;

  const data = activeRow.data || {};
  const totalSteps = expDef.steps.length;
  const currentStepNum = Math.min(activeRow.step, totalSteps);
  const currentStepDef = getCurrentStep(expDef, currentStepNum);

  const needsDecision = !!(data.awaiting_decision);

  let currentObjective = currentStepDef
    ? (typeof currentStepDef.objective === 'function'
        ? currentStepDef.objective(data)  // IMPL-VV-1758: objective dinámico
        : currentStepDef.objective)
    : '(completado — esperando decisión)';
  if (needsDecision) {
    currentObjective = expDef.decision ? expDef.decision.prompt : currentObjective;
  }

  return {
    title: expDef.title,
    intro: expDef.intro,
    currentStep: currentStepNum,
    totalSteps,
    currentObjective,
    progress: `Paso ${currentStepNum}/${totalSteps}`,
    needsDecision,
    decisionPrompt: needsDecision ? expDef.decision.prompt : null
  };
}

/**
 * Notifica al motor de expediciones que el jugador murió.
 * Si el paso actual tiene cumulative.reset_on_death === true,
 * reinicia el contador de progreso acumulativo a 0.
 *
 * @param {object} player - objeto player de la BD
 * @returns {{ message: string } | null} — mensaje de reinicio o null si no aplica
 */
function notifyDeath(player) {
  const activeRow = db.getActiveExpedition(player.id);
  if (!activeRow) return null;

  const expDef = getExpeditionDef(activeRow.expedition_id);
  if (!expDef) return null;

  const currentStepDef = getCurrentStep(expDef, activeRow.step);
  if (!currentStepDef) return null;

  // Solo actuar si el paso actual tiene reset_on_death
  const cumul = currentStepDef.cumulative;
  if (!cumul || !cumul.reset_on_death) return null;

  const field = cumul.field;
  const data = activeRow.data ? { ...activeRow.data } : {};
  const prevCount = data[field] || 0;

  // Si ya estaba en 0, no hacer nada
  if (prevCount === 0) return null;

  // Reiniciar contador
  data[field] = 0;
  db.raw().run(
    `UPDATE expeditions SET data = ?, last_updated = datetime('now') WHERE player_id = ? AND state = 'active'`,
    [JSON.stringify(data), player.id]
  );

  return {
    message: `💀 Tu racha se corta. [${expDef.title}] Progreso reiniciado: 0/${cumul.goal} — tenés que volver a empezar.`
  };
}

/**
 * Genera el mensaje de "sin expedición disponible".
 */
function noExpeditionMessage(player) {
  const nextLevel = (player.level || 1) + 1;
  return [
    `📜 No tenés ninguna expedición disponible.`,
    `   Alcanzá el nivel ${nextLevel} para desbloquear nuevas expediciones.`,
    `   Mientras tanto, el dungeon te espera — o podés probar la subasta.`
  ].join('\n');
}

/**
 * EPIC-1166 — Devuelve un resumen de todas las expediciones para el comando `expediciones`.
 * Clasifica cada una en: activa / disponible / bloqueada (nivel) / no elegible (clase) / completada.
 * @param {object} player
 * @returns {string} texto formateado para mostrar al jugador
 */
function getAllExpeditionsStatus(player) {
  const activeRow  = db.getActiveExpedition(player.id);
  const completedSet = new Set(db.getCompletedExpeditions(player.id));

  const lines = [
    `📜 **Tus Expediciones** (nivel ${player.level || 1})`,
    ''
  ];

  let countAvailable = 0;

  for (const exp of EXPEDITION_POOL) {
    const isActive    = activeRow && activeRow.expedition_id === exp.id;
    const isCompleted = completedSet.has(exp.id);
    const meetsLevel  = (player.level || 1) >= (exp.unlock_condition?.min_level || 1);
    const meetsClass  = exp.eligible_classes === 'all' ||
      (Array.isArray(exp.eligible_classes) && exp.eligible_classes.includes(normalizeClass(player.player_class)));

    let statusIcon, statusLabel;
    if (isActive) {
      // Obtener progreso de la expedición activa
      const totalSteps = exp.steps.length;
      const currentStep = Math.min(activeRow.step, totalSteps);
      statusIcon = '▶️';
      statusLabel = `ACTIVA (paso ${currentStep}/${totalSteps})`;
      countAvailable++;
    } else if (isCompleted) {
      statusIcon = '✅';
      statusLabel = 'Completada';
    } else if (!meetsLevel) {
      statusIcon = '🔒';
      statusLabel = `Bloqueada (requiere nivel ${exp.unlock_condition.min_level})`;
    } else if (!meetsClass) {
      const classReq = Array.isArray(exp.eligible_classes) ? exp.eligible_classes.join('/') : exp.eligible_classes;
      statusIcon = '🚫';
      statusLabel = `Solo para: ${classReq}`;
    } else {
      statusIcon = '📌';
      statusLabel = 'Disponible';
      countAvailable++;
    }

    lines.push(`${statusIcon} **${exp.title}** — ${statusLabel}`);
  }

  lines.push('');
  if (countAvailable > 0) {
    lines.push(`💡 Usá \`expedicion\` para ver la activa o que te asignen una nueva.`);
  } else {
    lines.push(`💡 ¡Completaste todo lo disponible para tu nivel y clase!`);
  }

  return lines.join('\n');
}

// ─── Exportar ─────────────────────────────────────────────────────────────────

module.exports = {
  assignExpedition,
  checkStep,
  notifyDeath,
  completeExpedition,
  resolveDecision,
  getActiveExpeditionStatus,
  getAllExpeditionsStatus,
  noExpeditionMessage,
  getExpeditionDef,
  EXPEDITION_POOL
};
