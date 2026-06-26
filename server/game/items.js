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
  'poción de salud':          { type: 'potion', effect: 'heal', amount: 15, description: 'Una pequeña poción rojiza que restaura 15 HP.' },
  'poción mayor de salud':    { type: 'potion', effect: 'heal', amount: 50, description: 'Una gran poción carmesí que restaura 50 HP. Para las situaciones desesperadas.' },
  'poción de vida':           { type: 'potion', effect: 'heal', amount: 25, description: 'Una poción grande que restaura 25 HP.' },
  'poción menor':             { type: 'potion', effect: 'heal', amount: 8,  description: 'Una poción débil. Restaura 8 HP.' },
  'poción de poder':     { type: 'atk_potion', effect: 'power', atk_bonus: 3, duration: 60, description: 'Una poción oscura que amplifica tu fuerza durante 60 segundos. El zumbido en los huesos es real. (+3 ATK por 60s)' },
  'poción de maná':      { type: 'mana_potion', effect: 'restore_mana', amount: 15, description: 'Un frasco azul brillante. Restaura 15 puntos de maná instantáneamente.' },
  'poción de maná mayor': { type: 'mana_potion', effect: 'restore_mana', amount: 20, description: 'Un frasco azul intenso. Restaura 20 puntos de maná.' },

  // ── Antídotos ────────────────────────────────────────────────────────────────
  'antídoto':            { type: 'antidote', effect: 'cure_poison', description: 'Un frasco con líquido verde pálido. Cura el veneno al instante. Si no estás envenenado, restaura 12 HP.' },
  'antidoto':            { type: 'antidote', effect: 'cure_poison', description: 'Un frasco con líquido verde pálido. Cura el veneno al instante. Si no estás envenenado, restaura 12 HP.' },
  'hierba curativa':     { type: 'antidote', effect: 'cure_poison', description: 'Un manojo de hierba medicinal. Cura el veneno si estás envenenado, o restaura 12 HP si no lo estás. También sirve como ingrediente de crafteo.' },

  // ── Armas (dungeon base) ──────────────────────────────────────────────────
  'espada oxidada':      { type: 'weapon', effect: 'attack_bonus', amount: 3,  description: 'Una espada vieja con filo irregular. +3 de ataque.' },
  'cuchillo oxidado':    { type: 'weapon', effect: 'attack_bonus', amount: 1,  description: 'Un cuchillo pequeño y oxidado. +1 de ataque.' },
  'espada de hierro':    { type: 'weapon', effect: 'attack_bonus', amount: 8,  description: 'Una espada de hierro forjado, sólida y confiable. +8 de ataque.' },
  'espada de acero':     { type: 'weapon', effect: 'attack_bonus', amount: 10, description: 'Una espada de acero templado, más pesada y letal que la de hierro. La mejor que Aldric consigue para aventureros de élite. +10 de ataque.' },  // DIS-855: gap de equipamiento nivel 6-8
  'daga envenenada':     { type: 'weapon', effect: 'attack_bonus', amount: 4,  on_hit: { type: 'poison', chance: 0.35 }, description: 'Una daga con el filo impregnado de veneno. +4 de ataque. 35% de envenenar al golpear.' },
  'espada larga':        { type: 'weapon', effect: 'attack_bonus', amount: 5,  description: 'Una espada bien balanceada. +5 de ataque.' },
  'cristal mágico':      { type: 'weapon', effect: 'attack_bonus', amount: 7,  description: 'Un cristal que amplifica la fuerza. +7 de ataque.' },
  'piedra de poder':     { type: 'weapon', effect: 'attack_bonus', amount: 4,  description: 'El núcleo de energía que alimentaba los brazos del Gólem de Piedra. Al arrancarlo, el constructo se desplomó. Pulsa con magia telúrica contenida. +4 de ataque.' },
  'diente afilado':      { type: 'weapon', effect: 'attack_bonus', amount: 2,  description: 'Un colmillo de murciélago vampiro, afilado como una aguja. +2 de ataque.' },
  'garra de esqueleto':  { type: 'weapon', effect: 'attack_bonus', amount: 3,  description: 'La garra de un esqueleto endurecida por la magia oscura. +3 de ataque.' },
  'hacha rústica':       { type: 'weapon', effect: 'attack_bonus', amount: 4,  description: 'Un hacha de mano, tosca pero funcional. +4 de ataque.' },

  // ── Armas (dungeon expandido) ─────────────────────────────────────────────
  // STORY-014: Lore narrativo agregado a ítems clave del dungeon
  'espada de obsidiana': { type: 'weapon', effect: 'attack_bonus', amount: 12, description: 'Una espada de obsidiana pura que absorbe la luz —la luz literalmente desaparece al acercarse a la hoja. El molde para esta espada existe en la Forja de la sala 12, pero nunca fue terminado por manos humanas. Alguien —o algo— la completó a su manera. +12 de ataque. El arma más poderosa del dungeon.' },
  'lanza espectral':     { type: 'weapon', effect: 'attack_bonus', amount: 10, spectral_bonus: 2, description: 'Una lanza hecha de luz negra condensada, fría al tacto como el mármol pero sin peso. Artesanía del Elemental de Hielo condensada en forma de arma. +10 de ataque; +2 ATK adicional contra espectrales y criaturas mágicas.' },
  'lanza espectral reforzada': { type: 'weapon', effect: 'attack_bonus', amount: 11, spectral_bonus: 2, description: 'La lanza espectral básica ha sido reforzada con esencia de espectro de las profundidades. La luz negra es más densa, el frío más absoluto. Un arma formidable para los valientes que llegan al corazón del dungeon. +11 de ataque; +2 ATK adicional contra espectrales y criaturas mágicas.' },
  'alabarda de huesos':  { type: 'weapon', effect: 'attack_bonus', amount: 10, description: 'La alabarda de un guardia espectral, forjada mientras el portador aún estaba vivo. Ligera a pesar de estar hecha de hueso comprimido. Los bordes están marcados con el símbolo del Reino de Valdrath —el mismo de los escudos de la Sala del Trono. Un arma de boss que supera ampliamente lo que se consigue en tienda. +10 de ataque.' },
  'martillo de forja':   { type: 'weapon', effect: 'attack_bonus', amount: 7,  description: 'Un martillo colosal de las forjas. Aplastante y pesado. +7 de ataque.' },

  // ── Misc / coleccionables (dungeon base) ─────────────────────────────────
  'antorcha':            { type: 'misc', description: 'Una antorcha encendida. Ilumina los pasillos oscuros.' },
  'libro viejo':         { type: 'misc', description: 'Un grimorio con páginas incomprensibles.' },
  'cuerda':              { type: 'misc', description: 'Una cuerda resistente de unos 10 metros.' },
  'llave oxidada':       { type: 'misc', description: 'Una llave de hierro con el símbolo de dos llaves cruzadas grabado en el mango —el mismo símbolo que viste en otros lugares del dungeon. Abre la reja norte del Pozo Sin Fondo (sala 7), aunque nadie que haya cruzado ha vuelto a mencionar qué encontró al otro lado.' },
  'amuleto oscuro':      { type: 'misc', description: 'Un amuleto con una gema negra. Irradia una energía extraña.' },
  'monedas de cobre':    { type: 'misc', description: 'Unas pocas monedas de cobre gastadas.' },
  'monedas de plata':    { type: 'misc', description: 'Monedas de plata con inscripciones antiguas.' },
  'monedas de oro':      { type: 'misc', description: 'Monedas de oro resplandecientes. Son pocas, pero valen mucho.' },
  'cofre de oro':        { type: 'misc', description: 'Un cofre repleto de monedas de oro del Lich. Un tesoro maldito que vale una fortuna.' },
  'pelaje áspero':       { type: 'misc', description: 'El pelaje de una rata gigante. Áspero al tacto. 🔧 Combinalo con una escama abismal para curtirlo en cuero de criatura.' },
  'escudo roto':         { type: 'misc', description: 'Un escudo con el centro partido. Inútil para defenderse así. Las garras del esqueleto que lo portó podrían servir para reforzarlo... (crafteo: escudo roto + garra de esqueleto)' },
  'escudo de madera':    { type: 'armor', effect: 'defense_bonus', amount: 2, description: 'Un escudo de madera reforzada. No es glamoroso, pero te protege. +2 de defensa.' },
  'esencia etérea':      { type: 'misc', description: 'Una esencia brumosa dentro de un frasco. Resuena con el más allá. 🔧 Pista: combinala con una lanza espectral para reforzarla (+9 ATK).' },
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
  'perla negra':         { type: 'misc', description: 'Una perla de un negro absoluto del lago subterráneo. Tiene un valor incalculable. 🔧 Pista: combinala con el tomo sellado para craftear el grimorio del abismo (🟡 legendario).' },
  'red de pesca':        { type: 'misc', description: 'Una red de pesca resistente. Podría servir para algo más que pescar.' },
  'escudo de gladiador': { type: 'armor', effect: 'defense_bonus', amount: 3, description: 'El escudo de un gladiador del coliseo de huesos. Lleva el nombre "MAXIMUS" grabado. Otorga +3 DEF.' },
  'tomo sellado':        { type: 'misc', description: 'Un tomo sellado con cera negra. Las runas del sello pulsan suavemente. No se puede abrir... aún.' },
  'carta sellada':       { type: 'misc', description: 'Un sobre sellado con cera negra marcado con dos llaves cruzadas — el sello del reino de Valdrath. En el reverso, en letra pequeña: "Para quien llegue después. Perdoname." Sin firma. Puede que sea mejor no abrirla.' },
  'páginas congeladas':  { type: 'misc', description: 'Fragmentos de un diario conservados por el hielo. La escritura es difusa pero legible: "Sé quién es. Eso lo hace peor." La última entrada es del mismo año en que el Reino de Valdrath dejó de aparecer en los mapas.' },
  'cristal helado':      { type: 'misc', description: 'Un cristal extraído del cuerpo de un Elemental de Hielo. Conserva el frío de siglos.' },
  'núcleo de forja':     { type: 'misc', description: 'El núcleo energético de un Golem de Forja. Aún irradia calor y magia residual.' },
  'tinta de kraken':     { type: 'misc', description: 'Un frasco de tinta negra del Krakeling Abismal. Muy densa y de olor nauseabundo.' },
  'escama abismal':      { type: 'misc', description: 'Una escama del Krakeling. Dura como el acero, ligera como el cartón. 🔧 Combinala con pelaje áspero o cuerda para craftear armamento.' },
  'filacteria rota':     { type: 'misc', description: 'La filacteria del Lich Anciano, destruida. Sin ella, el Lich no puede regresar... ¿verdad?' },
  'esencia de sombra':   { type: 'misc', description: 'La esencia condensada de las sombras del dungeon. Vibra en la oscuridad.' },

  // ── Ítems exclusivos de monstruos ÉLITE (BUG-907) ───────────────────────
  'gema de goblin':      { type: 'misc', description: 'Una gema tosca y verde que solo los goblins élite portan. Brilla con una luz extraña. Material de lujo para los coleccionistas del dungeon.' },
  'pelaje lustroso':     { type: 'misc', description: 'El pelaje de una Rata Gigante élite — suave, sin marcas de combate. Mucho más valioso que el pelaje áspero común.' },
  'seda de élite':       { type: 'misc', description: 'Seda producida por una Araña Tejedora élite. Más resistente y fina que la seda normal. Un material de crafting excepcional.' },
  'fragmento espectral': { type: 'misc', description: 'Un fragmento de energía espectral condensada de un Espectro del Corredor élite. Pulsa con luz azul pálida. Material artesanal raro.' },
  'colmillo vampírico':  { type: 'misc', description: 'El colmillo de un Murciélago Vampiro élite — más largo y afilado que el normal. Retiene energía vital absorbida.' },
  'hueso reforzado':     { type: 'misc', description: 'Hueso de un Esqueleto Guerrero élite, endurecido por años de combate y magia oscura. Material de artesanía resistente.' },
  'cristal de élite':    { type: 'misc', description: 'Un cristal mágico de mayor pureza, extraído de un Gólem de Piedra élite. Concentra más poder que el cristal mágico común.' },
  'núcleo gélido':       { type: 'misc', description: 'El núcleo de un Elemental de Hielo élite — frío absoluto concentrado. Mucho más potente que el cristal helado común.' },
  'tinta de abismo':     { type: 'misc', description: 'Tinta negra de un Krakeling élite. Más densa y cargada de energía abismal que la tinta de kraken ordinaria.' },

  // ── Ítems del Dungeon Extendido — Cámara del Eco y Abismo Eterno (T132) ────
  'cristal resonante':   { type: 'misc', description: 'Un cristal que vibra con el eco de los muertos. Emite un suave hum que aumenta con la luna. 🔧 Pista: combinalo con esencia de eco o polvo de eco para craftear armas espectrales.' },
  'polvo de eco':        { type: 'misc', description: 'Polvo que cayó de las paredes de la Cámara del Eco. Brilla con luz tenue al agitarlo. 🔧 Pista: ingrediente artesanal — combinalo con cristal resonante.' },
  'esencia de eco':      { type: 'misc', description: 'La esencia destilada de un Eco Viviente. Guarda la memoria de aventureros caídos. 🔧 Pista: ingrediente artesanal — combinalo con cristal resonante para forjar una lanza espectral del eco.' },
  'fragmento de vacío':  { type: 'misc', description: 'Un fragmento del Abismo Eterno. Absorbe la luz a su alrededor. Los sabios lo llaman "la nada solidificada". 🔧 Pista: combinalo con esencia del abismo para craftear la daga del vacío (🟡 legendaria).' },
  'esencia del abismo':  { type: 'misc', description: 'La esencia pura de la Sombra del Vacío. Vibra con una energía oscura y antigua. 🔧 Pista: combinalo con fragmento de vacío para craftear la daga del vacío (🟡 legendaria).' },
  // T186: Ítems de recolección pasiva al descansar
  'fragmento de roca volcánica': { type: 'misc', description: 'Un fragmento de roca volcánica cristalizada por el calor extremo de la forja. Material artesanal de alta densidad térmica.' },

  // ── Armas artesanales avanzadas — Dungeon Extendido (T132) ──────────────────
  'lanza espectral del eco': { type: 'weapon', effect: 'attack_bonus', amount: 12, spectral_bonus: 3, description: 'Versión potenciada de la lanza espectral, forjada con los ecos de los caídos en las profundidades. El arma más poderosa del mid-game. Requiere: cristal resonante (drop del Campeón Espectral) + esencia de eco (drop del Eco Viviente). +12 de ataque; +3 ATK adicional contra espectrales y criaturas mágicas.' },
  'daga del vacío':      { type: 'weapon', effect: 'attack_bonus', amount: 12, description: 'Una daga que parece absorber la realidad. +12 de ataque. El arma más poderosa de las profundidades.' },
  'amuleto del eco':     { type: 'misc', description: 'Un amuleto que pulsa con ecos de memorias antiguas. Protección de la Cámara del Eco. 🔊✨ Efecto pasivo: mientras lo llevés en el inventario en la Cámara del Eco (sala 19), cancela los Ecos Enloquecedores (-1 ATK). No necesitás equiparlo — solo tenerlo.' },

  // ── Ítems artesanales (resultado de crafteo — T092) ───────────────────────
  'espada envenenada':   { type: 'weapon', effect: 'attack_bonus', amount: 5,  on_hit: { type: 'poison', chance: 0.35, damage: 2, turns: 3 }, description: 'Una espada que supura veneno verde. +5 de ataque. 35% de chance de envenenar al objetivo por 3 turnos.' },
  'cuchillo envenenado': { type: 'weapon', effect: 'attack_bonus', amount: 3,  on_hit: { type: 'poison', chance: 0.35, damage: 1, turns: 4 }, description: 'Un cuchillo impregnado de veneno de araña. +3 de ataque. 35% de chance de envenenar al objetivo por 4 turnos.' },
  'látigo de garras':    { type: 'weapon', effect: 'attack_bonus', amount: 4,  description: 'Un látigo improvisado con garras de esqueleto. +4 de ataque.' },
  'red resistente':      { type: 'misc', description: 'Una red de araña y cuerda trenzadas. Casi imposible de romper.' },
  'collar de garras':    { type: 'armor', effect: 'defense_bonus', amount: 2, description: 'Un collar artesanal de dientes de goblin y seda de araña. Emana poder primitivo. +2 de defensa. Se equipa como armadura: `wear collar de garras`.' },
  'grimorio del abismo': { type: 'weapon', effect: 'attack_bonus', amount: 10, on_hit: { type: 'shadow_bolt', chance: 0.20, bonus_damage: 8 }, description: 'Un grimorio sellado con poder abismal. +10 de ataque mágico. 20% de chance de lanzar un rayo de sombra (+8 daño extra).' },

  // ── DIS-D425: Ítem único de la Prisión Subterránea ───────────────────────
  'sello del carcelero': { type: 'armor', effect: 'defense_bonus', amount: 3, description: 'Un medallón de hierro negro con una calavera grabada. Los carceleros de la Prisión Subterránea lo usaban como símbolo de autoridad. Aún irradia una energía disuasoria. ⚔️ Equípalo para +3 de defensa, o vendelo al Mercader como pieza histórica (20g).' },

  // ── Armaduras (T152) ─────────────────────────────────────────────────────
  'cota de malla':       { type: 'armor', effect: 'defense_bonus', amount: 3,  description: 'Una cota de malla de hierro. Pesada pero fiable. +3 de defensa.' },
  'cota de cuero':       { type: 'armor', effect: 'defense_bonus', amount: 3,  description: 'Cuero grueso endurecido con placas de metal remachadas. Equilibrio entre movilidad y protección. +3 de defensa.' },
  'cuero endurecido':    { type: 'armor', effect: 'defense_bonus', amount: 2,  description: 'Armadura de cuero tratado con resina. Flexible y ligera. +2 de defensa.' },
  'túnica encantada':    { type: 'armor', effect: 'defense_bonus', amount: 4,  description: 'Una túnica de tela mágica que repele golpes. +4 de defensa. Ideal para magos.' },
  'armadura de placas':  { type: 'armor', effect: 'defense_bonus', amount: 5,  description: 'Placas de acero que cubren el cuerpo. La protección más alta del dungeon. +5 de defensa.' },

  // ── DIS-558: Ítems específicos de clase Mago ─────────────────────────────
  'vara de energía':       { type: 'weapon', effect: 'attack_bonus', amount: 5, mage_only_bonus: 2, description: 'Una vara de madera oscura grabada con runas arcanas. Canaliza la energía mágica del portador. +5 de ataque. Los Magos reciben +2 de ataque adicional y +2 maná/min de regeneración extra al empuñarla.' },
  'pergamino de hechizo':  { type: 'spell_scroll', effect: 'free_spell', description: 'Un pergamino cubierto de ecuaciones mágicas y símbolos arcanos. Al usarlo, podés lanzar tu próximo hechizo sin coste de maná. El pergamino se consume en el proceso.' },

  // ── DIS-610: Ítems específicos de clase Clérigo ──────────────────────────
  'símbolo sagrado':       { type: 'weapon', effect: 'attack_bonus', amount: 2, cleric_only_bonus: 2, cleric_pray_cooldown: 3, description: 'Un símbolo sagrado de madera bendecida con relieves de deidades antiguas. +2 de ataque. Los Clérigos reciben +2 de ataque adicional y reducen el cooldown de pray a 3 minutos.' },
  'poción de bendición':   { type: 'blessing_potion', mana_restore: 20, atk_bonus: 1, duration: 120, description: 'Una poción color dorado con aroma a incienso. Al beberla, el maná fluye renovado y el cuerpo se fortalece temporalmente. Restaura 20 maná + +1 ATK por 2 minutos.' },

  // ── DIS-615: Ítems específicos de clase Pícaro ───────────────────────────
  'guantes de cuero fino':  { type: 'weapon', effect: 'attack_bonus', amount: 1, rogue_only_crit_bonus: 10, description: 'Guantes de cuero curtido con dedos reforzados. Permiten un agarre más preciso y aumentan la probabilidad de golpes críticos. +1 de ataque. Los Pícaros reciben +10% de probabilidad de crítico adicional.' },
  'veneno de contacto':     { type: 'contact_poison', charges: 3, description: 'Un vial de veneno denso y aceitoso. Al frotarlo en tu arma, impregna los próximos 3 ataques con toxina — cada golpe tiene 40% de envenenar al objetivo. Se consume al agotar las cargas.' },
  // DIS-560: crafteo de Mago
  'catalizador mágico':    { type: 'weapon', effect: 'attack_bonus', amount: 7, mage_only_bonus: 3, description: 'Un concentrado de energía arcana, resultado de combinar cristales y esencias espectrales. +7 de ataque. Los Magos reciben +3 de ataque adicional — ideal para potenciar hechizos.' },

  // ── Bolsas / expansión de inventario (DIS-595) ───────────────────────────
  'bolsa de lona':         { type: 'bag', slots: 4, description: 'Una bolsa de lona resistente con correas de cuero. Al usarla se conecta a tu mochila y amplía tu capacidad de carga en 4 slots adicionales. Hasta 2 bolsas simultáneas.' },

  // ── Pergaminos mágicos (T153) ──────────────────────────────────────────────
  'pergamino de furia':    { type: 'scroll', effect: 'fury',    atk_bonus: 3, def_bonus: 0, duration: 60,  description: 'Un pergamino que irradia energía roja. Al leerlo, sentís una furia ardiente. (+3 ATK por 60s)' },
  'pergamino de escudo':   { type: 'scroll', effect: 'shield',  atk_bonus: 0, def_bonus: 3, duration: 60,  description: 'Runas protectoras grabadas en papel dorado. Una barrera mágica te envuelve. (+3 DEF por 60s)' },
  'pergamino de velocidad': { type: 'scroll', effect: 'speed',  atk_bonus: 2, def_bonus: 1, duration: 45,  description: 'El texto vibra con energía cinética. Tus movimientos se vuelven más ágiles. (+2 ATK +1 DEF por 45s)' },
  'veste de sombra':     { type: 'armor', effect: 'defense_bonus', amount: 3,  description: 'Una veste tejida con esencia de sombra. Casi invisible en la oscuridad. +3 de defensa.' },
  'capa de araña':       { type: 'armor', effect: 'defense_bonus', amount: 2,  description: 'Una capa tejida con hilo de seda de araña. Ligera y sorprendentemente resistente. +2 de defensa.' },
  'peto de huesos':      { type: 'armor', effect: 'defense_bonus', amount: 4,  description: 'Un peto forjado con huesos del dungeon. Macabro pero efectivo. +4 de defensa.' },
};

// ─── Funciones públicas ───────────────────────────────────────────────────────

/**
 * Obtiene la definición de un ítem del catálogo.
 * Acepta coincidencia parcial case-insensitive.
 * @param {string} name
 * @returns {object|null} { type, effect, amount, description } o null
 */
function getItemDef(name) {
  const nfd = s => s.toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const key = nfd(name);
  // Coincidencia exacta
  const exactKey = Object.keys(ITEM_CATALOG).find(k => nfd(k) === key);
  if (exactKey) return { name: exactKey, ...ITEM_CATALOG[exactKey] };
  // Coincidencia parcial
  const found = Object.keys(ITEM_CATALOG).find(k => nfd(k).includes(key) || key.includes(nfd(k)));
  if (found) return { name: found, ...ITEM_CATALOG[found] };
  // BUG-796: también buscar en CRAFTED_ITEMS de crafting.js (ítems solo crafteables)
  // Evitar require circular: solo cargar crafting si no encontramos en items
  try {
    const { CRAFTED_ITEMS } = require('./crafting');
    if (CRAFTED_ITEMS) {
      const exactCraft = Object.keys(CRAFTED_ITEMS).find(k => nfd(k) === key);
      if (exactCraft) return { name: exactCraft, ...CRAFTED_ITEMS[exactCraft] };
      const partialCraft = Object.keys(CRAFTED_ITEMS).find(k => nfd(k).includes(key) || key.includes(nfd(k)));
      if (partialCraft) return { name: partialCraft, ...CRAFTED_ITEMS[partialCraft] };
    }
  } catch (e) { /* evitar crash si hay problema de carga */ }
  return null;
}

/**
 * Busca un ítem en la lista dada (inventario o suelo) por nombre parcial.
 * @param {string[]} itemList
 * @param {string} query
 * @returns {string|null} el nombre exacto del ítem si se encuentra
 */
function findItem(itemList, query) {
  const normalize = s => s.toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const q = normalize(query);
  return itemList.find(item => normalize(item).includes(q)) || null;
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

// ─── Sistema de rareza de ítems (T134) ───────────────────────────────────────
//
// Rarezas: común (blanco), raro (azul), épico (morado), legendario (dorado)
// Los ítems no listados aquí son 'común' por defecto.

const ITEM_RARITY = {
  // ── Legendario ────────────────────────────────────────────────────────────
  'grimorio del abismo':      'legendario',
  'daga del vacío':           'legendario',
  // ── Épico ─────────────────────────────────────────────────────────────────
  'espada de obsidiana':      'épico',
  'lanza espectral':          'épico',
  'lanza espectral reforzada':'épico',
  'lanza espectral del eco':  'épico',
  'filacteria rota':          'épico',
  'espada envenenada':        'épico',
  'alabarda de huesos':       'épico',   // BUG-906: subida a +10 ATK (antes raro/+6, inferior a espada de hierro +8)
  'hacha de guerra':          'épico',
  // ── Raro ──────────────────────────────────────────────────────────────────
  'cuchillo envenenado':      'raro',
  'látigo de garras':         'raro',
  'poción de poder':          'raro',
  'poción de maná mayor':     'raro',
  'poción mayor de salud':    'raro',
  'poción de vida':           'raro',
  'cristal resonante':        'raro',
  'fragmento de vacío':       'raro',
  'esencia del abismo':       'raro',
  'esencia de eco':           'raro',
  'esencia de sombra':        'raro',
  'perla negra':              'raro',
  'tomo sellado':             'raro',
  'carta sellada':            'raro',
  'páginas congeladas':       'raro',
  'collar de garras':         'raro',
  'amuleto del eco':          'raro',
  'llave maestra':            'raro',
  'llave oxidada':            'raro',
  'corona rota':              'raro',
  'escudo de gladiador':      'raro',
  'grimorio élfico':          'raro',

  // ── Armaduras (T152) ─────────────────────────────────────────────────────
  'armadura de placas':   'épico',
  'túnica encantada':     'épico',

  // ── Pergaminos mágicos (T153) ──────────────────────────────────────────────
  'pergamino de furia':     'raro',
  'pergamino de escudo':    'raro',
  'pergamino de velocidad': 'épico',
  'peto de huesos':       'raro',
  'veste de sombra':      'raro',
  'cota de malla':        'raro',
};

// Emojis de rareza para la UI
const RARITY_EMOJI = {
  'común':      '⬜',
  'raro':       '🔵',
  'épico':      '🟣',
  'legendario': '🟡',
};

// Colores CSS para el cliente
const RARITY_COLOR = {
  'común':      '#c0c0c0',
  'raro':       '#4a9eff',
  'épico':      '#b044e0',
  'legendario': '#ffd700',
};

/**
 * Obtiene la rareza de un ítem.
 * @param {string} name
 * @returns {'común'|'raro'|'épico'|'legendario'}
 */
function getItemRarity(name) {
  const key = (name || '').toLowerCase().trim();
  return ITEM_RARITY[key] || 'común';
}

// DIS-D44: Lista de ítems considerados "basura" (sin uso mecánico, vendibles o descartables)
// No incluye ítems de desactivar trampas (hongo azul, corona rota, cuerda, red de pesca),
// ni ítems de quest/lore, ni monedas, ni pociones/pergaminos.
const JUNK_ITEMS = new Set([
  'pelaje áspero',
  'cuchillo oxidado',
  'escudo roto',
  'hueso de rata',
  'antorcha',
  'vela encendida',
  'libro viejo',
  'gancho de hierro',
  'cadenas rotas',
  'monedas de cobre',
  'monedas de plata',
]);

/**
 * Determina si un ítem es basura descartable con `drop junk`.
 * @param {string} name
 * @returns {boolean}
 */
function isJunkItem(name) {
  return JUNK_ITEMS.has((name || '').toLowerCase().trim());
}

/**
 * Devuelve el emoji de rareza de un ítem.
 * @param {string} name
 * @returns {string}
 */
function getRarityEmoji(name) {
  return RARITY_EMOJI[getItemRarity(name)] || '⬜';
}

module.exports = {
  ITEM_CATALOG,
  ITEM_RARITY,
  JUNK_ITEMS,
  RARITY_EMOJI,
  RARITY_COLOR,
  getItemDef,
  getItemRarity,
  getRarityEmoji,
  isJunkItem,
  findItem,
  describeItem,
};

