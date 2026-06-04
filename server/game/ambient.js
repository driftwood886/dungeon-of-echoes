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
  // DIS-D36: fire evaluado antes que cold — el Taller de la Forja contiene "helada" en su
  // descripción (referencia a la sala adyacente), lo que causaba falso positivo de cold.
  fire:    ['forja', 'lava', 'fuego', 'brasas', 'horno', 'volcánic'],
  cold:    ['glaciar', 'helad', 'hielo', 'frío', 'fría', 'frio', 'nieve', 'tundra'],
  dark:    ['maldita', 'maldito', 'catedral', 'sombra', 'oscur', 'tinieblas', 'penumbra', 'negro', 'profundidades'],
  sacred:  ['santuario', 'sagra', 'altar', 'templo', 'bless', 'divino', 'divina'],
  water:   ['lago', 'agua', 'sumerg', 'piscina', 'corriente', 'río', 'charco'],
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

// ─── T168: Mini-eventos narrativos ───────────────────────────────────────────
// Al hacer `look`, 15% de chance de que aparezca un evento narrativo corto.
// Completamente inocuo — solo atmósfera.

const NARRATIVE_EVENTS = {
  cold: [
    'Un crujido seco resuena en algún lugar entre el hielo. Algo se está moviendo.',
    'Ves tu aliento congelarse en el aire y luego desaparecer silenciosamente.',
    'Por un momento crees ver una figura humana en el hielo de la pared. Solo es una ilusión... ¿verdad?',
    'El viento gélido cesa de repente. El silencio resultante es más inquietante que el frío.',
  ],
  sacred: [
    'Una voz muy lejana recita algo ininteligible. Luego el silencio regresa.',
    'Las llamas de las velas titilan sin viento. Como si algo las respirara.',
    'Sientes que alguien te observa desde las sombras del altar. Nadie está ahí.',
    'Un olor a incienso antiguo llega de ninguna parte y desaparece igual de rápido.',
  ],
  fire: [
    'Las llamas parpadean y por un segundo muestran formas que no deberían estar ahí.',
    'Un gemido metálico recorre las paredes. La presión del calor expande el hierro.',
    'El humo forma una espiral perfecta antes de disiparse. Demasiado perfecta para ser accidental.',
    'Una chispa solitaria flota en el aire más tiempo del que debería ser posible.',
  ],
  water: [
    'Algo se mueve bajo la superficie del agua. Demasiado grande para ser un pez.',
    'Las ondas del agua van en dirección contraria a como deberían. Nadie las perturbó.',
    'Un eco apagado llega desde las profundidades. Como alguien hablando bajo el agua.',
    'La superficie del lago refleja un techo distinto al que ves arriba. Por un segundo.',
  ],
  dark: [
    'Una sombra se mueve contra la pared. Ningún objeto la proyecta.',
    'Escuchás pasos detrás tuyo. Cuando girás, no hay nadie.',
    'Por un instante ves dos puntos brillantes en la oscuridad. Parpadeás y desaparecen.',
    'El silencio aquí tiene textura. Algo lo llena que no es sonido.',
  ],
  throne: [
    'El polvo en el trono parece perturbado, como si alguien lo hubiera ocupado recientemente.',
    'Un tapiz desgarrado se balancea solo. No hay corriente de aire.',
    'Creés escuchar el roce de una corona sobre piedra. Una vez. Solo una.',
    'Las antorchas apagadas huelen a azufre fresco. Alguien o algo estuvo aquí.',
  ],
  cave: [
    'El corredor vibra levemente bajo tus pies. Algo grande se mueve más abajo.',
    'Un murciélago te roza el hombro y desaparece en la oscuridad. No hace ningún sonido.',
    'Las estalactitas gotean en un ritmo que suena demasiado regular para ser natural.',
    'Ves marcas de garras nuevas en la piedra. No estaban antes... ¿o sí?',
  ],
  generic: [
    'Un escalofrio recorre tu espalda sin razón aparente.',
    'Por un momento el dungeon entero enmudece. Luego todo vuelve a la normalidad.',
    'Una rata corre por el borde de la sala y desaparece por una grieta invisible.',
    'Creés oír una campana muy lejana. Una sola vez.',
    'El polvo del suelo se arremolina brevemente, como perturbado por pies invisibles.',
    'Algo gotea en la oscuridad con un ritmo casi musical.',
  ],
};

/**
 * getNarrativeEvent(room) → string|null
 *
 * 15% de chance de devolver un mini-evento narrativo.
 * Usa Math.random() para verdadera aleatoriedad — estos eventos son sorpresivos.
 */
function getNarrativeEvent(room) {
  if (Math.random() > 0.15) return null;
  const type = classifyRoom(room);
  const pool = NARRATIVE_EVENTS[type] ?? NARRATIVE_EVENTS.generic;
  return pool[Math.floor(Math.random() * pool.length)];
}

module.exports = { getAmbientText, getTimePeriod, classifyRoom, getNarrativeEvent };
