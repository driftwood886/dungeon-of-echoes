/**
 * ambient.js — Sistema de clima y ambiente dinámico (T096)
 *
 * Agrega textos ambientales a la descripción de cada sala según:
 *  - La hora del servidor (madrugada / mañana / tarde / noche)
 *  - El tipo de sala (categoría inferida del nombre/descripción)
 *
 * No afecta el gameplay — es pura atmósfera narrativa.
 */

'use strict';

// ─── Períodos del día ────────────────────────────────────────────────────────

function getTimePeriod() {
  const hour = new Date().getHours(); // hora UTC del servidor
  if (hour >= 5  && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'afternoon';
  if (hour >= 18 && hour < 23) return 'evening';
  return 'midnight';
}

// ─── Categorías de sala ──────────────────────────────────────────────────────

const ROOM_TAGS = {
  cold:    ['glaciar', 'helad', 'hielo', 'frío', 'fría', 'frio', 'nieve', 'tundra'],
  sacred:  ['santuario', 'sagra', 'altar', 'templo', 'bless', 'divino', 'divina'],
  fire:    ['forja', 'lava', 'fuego', 'brasas', 'horno', 'volcánic'],
  water:   ['lago', 'agua', 'sumerg', 'piscina', 'corriente', 'río', 'charco'],
  dark:    ['sombra', 'oscur', 'tinieblas', 'penumbra', 'negro', 'profundidades'],
  throne:  ['trono', 'cámara', 'palacio', 'salón del', 'sala del trono'],
  cave:    ['caverna', 'gruta', 'cueva', 'túnel', 'pasaje', 'corredor'],
};

function classifyRoom(room) {
  const text = (room.name + ' ' + room.description).toLowerCase();
  for (const [tag, keywords] of Object.entries(ROOM_TAGS)) {
    if (keywords.some(kw => text.includes(kw))) return tag;
  }
  return 'generic';
}

// ─── Textos ambientales por tipo de sala y hora ──────────────────────────────

// Cada entrada es un array de posibles frases — se elige una pseudoaleatoria
// basándose en la sala y el minuto actual (sin Math.random(), para consistencia).

const AMBIENT = {
  cold: {
    morning:   ['Un frío cortante baja por el corredor y congela tu aliento en el aire.', 'El hielo de las paredes aún conserva el rigor de la noche pasada.'],
    afternoon: ['Incluso a esta hora el frío es implacable. Tu vaho forma nubes efímeras.', 'La luz filtrándose entre las grietas ilumina cristales de hielo en las piedras.'],
    evening:   ['Con la caída del sol el frío se intensifica. Tus dedos entumecen al tocar las paredes.', 'La oscuridad creciente hace más amargo el gélido ambiente.'],
    midnight:  ['Un silencio glacial envuelve la sala. Cada paso cruje sobre el suelo helado.', 'A medianoche el frío alcanza su punto más cruel. El aliento se congela al instante.'],
  },
  sacred: {
    morning:   ['Un suave resplandor dorado emana de las piedras sagradas al amanecer.', 'Los primeros rayos del día realzan las inscripciones divinas en las paredes.'],
    afternoon: ['Una paz extraña reina aquí, ajena al caos del dungeon exterior.', 'El altar irradia una calidez silenciosa que reconforta el cuerpo cansado.'],
    evening:   ['Al atardecer las velas antiguas parecen encenderse solas, una a una.', 'Una luz tenue y cálida persiste aquí cuando todo lo demás se oscurece.'],
    midnight:  ['A medianoche este lugar parece más vivo que de día. Las runas brillan suavemente.', 'La oscuridad exterior no penetra aquí — una protección invisible cuida este sitio.'],
  },
  fire: {
    morning:   ['Las brasas de la noche aún conservan su calor. El aire huele a carbón y metal.', 'Vapores del horno fundidor se mezclan con la frescura temprana del corredor.'],
    afternoon: ['El calor de la forja es sofocante a esta hora. Las paredes brillan con el reflejo del fuego.', 'Un resplandor anaranjado constante llena la sala, independiente de la luz exterior.'],
    evening:   ['Al oscurecer, las llamas de la forja cobran protagonismo. Sombras danzantes en las paredes.', 'El crepitar del fuego es el único sonido constante en el silencio del dungeon.'],
    midnight:  ['Las llamas de medianoche arden con un color rojizo más intenso que el habitual.', 'La forja no descansa nunca. A medianoche el metal fundido brilla como sangre.'],
  },
  water: {
    morning:   ['El goteo constante del agua resuena ampliado en las paredes de piedra.', 'El agua parece más clara a esta hora. Se puede ver el fondo aunque nadie sabe qué hay ahí abajo.'],
    afternoon: ['El rumor del agua crea una ilusión de calma en medio del dungeon.', 'Reflejos ondulantes del agua juegan en el techo de piedra.'],
    evening:   ['El agua oscurece con la luz menguante. Sus sonidos se vuelven más siniestros.', 'La superficie refleja la penumbra del atardecer, tranquila y perturbadora a la vez.'],
    midnight:  ['El agua está completamente negra a medianoche. No se puede saber cuánta profundidad tiene.', 'Solo el sonido del agua rompe el silencio absoluto de esta hora.'],
  },
  dark: {
    morning:   ['Incluso con la llegada del día, esta sala permanece en penumbras.', 'Rincones que el amanecer no puede alcanzar. Aquí siempre es de noche.'],
    afternoon: ['La oscuridad persiste. La luz del día no encuentra camino hasta aquí.', 'Las sombras parecen más densas que el aire mismo en este lugar.'],
    evening:   ['Con la llegada de la noche, la oscuridad aquí se vuelve casi táctil.', 'Es imposible saber dónde terminan las paredes y dónde empiezan las tinieblas.'],
    midnight:  ['Oscuridad absoluta. Solo las motas de polvo fosforescente marcan el espacio.', 'A medianoche en las tinieblas, los sonidos se agudizan. Cada rumor parece amplificado.'],
  },
  throne: {
    morning:   ['La sala del trono guarda un silencio solemne que el amanecer no perturba.', 'La luz matinal filtra por grietas antiguas, iluminando el polvo que flota sobre el trono vacío.'],
    afternoon: ['El trono vacío observa la sala con la autoridad de los que ya no están.', 'Las tapices desgarrados se mueven suavemente con una corriente que nadie puede explicar.'],
    evening:   ['Al atardecer las sombras del trono se alargan dramáticamente. Parece que alguien está sentado en él.', 'La sala adopta una gravedad particular cuando la luz escasea.'],
    midnight:  ['El trono proyecta una sombra imposible a medianoche — más larga de lo que debería.', 'El silencio aquí es diferente: no es ausencia de sonido, es presencia de algo que no habla.'],
  },
  cave: {
    morning:   ['El corredor exhala aire fresco de las profundidades, ajeno al amanecer exterior.', 'Las estalactitas gotean rítmicamente. El dungeon tiene su propio pulso.'],
    afternoon: ['El pasaje se curva hacia la oscuridad. El exterior podría ser otro mundo.', 'Hongos luminiscentes en las grietas ofrecen la única orientación en este laberinto.'],
    evening:   ['A medida que el día muere afuera, los sonidos del dungeon se intensifican aquí dentro.', 'Murciélagos invisibles se desplazan en las paredes. Algo los inquieta.'],
    midnight:  ['El corredor a medianoche amplifica todo sonido: cada paso, cada respiración.', 'La profundidad del dungeon se hace sentir — estás muy abajo. Muy adentro.'],
  },
  generic: {
    morning:   ['El dungeon despierta lentamente. Los primeros aventureros se oyen a la distancia.', 'Un nuevo día comienza. Las criaturas del dungeon aún están adormecidas.'],
    afternoon: ['La hora de mayor actividad. Pasos y gritos lejanos recorren los corredores.', 'El dungeon zumba con la energía de la tarde. Cuidado con lo que está despierto.'],
    evening:   ['El dungeon se prepara para la noche. Los monstruos se vuelven más agresivos.', 'Con la caída del sol exterior, algo cambia en el aire del dungeon. Más denso. Más cargado.'],
    midnight:  ['La hora más peligrosa. El dungeon pertenece a las criaturas de la noche.', 'Medianoche en el dungeon — el momento en que el peligro y la recompensa alcanzan su pico.'],
  },
};

// ─── Función principal ───────────────────────────────────────────────────────

/**
 * getAmbientText(room) → string
 *
 * Devuelve una frase ambiental para la sala.
 *
 * La selección usa un índice determinístico basado en room.id + minutos actuales
 * para que no cambie en cada `look` dentro del mismo minuto, pero sí entre visitas.
 */
function getAmbientText(room) {
  const period = getTimePeriod();
  const type   = classifyRoom(room);
  const pool   = AMBIENT[type]?.[period] ?? AMBIENT.generic[period];

  // Índice determinístico: varía cada 10 minutos por sala
  const seed = Math.floor(Date.now() / (10 * 60 * 1000)) + (room.id || 0);
  const idx  = seed % pool.length;

  return pool[idx];
}

module.exports = { getAmbientText, getTimePeriod, classifyRoom };
