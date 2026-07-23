'use strict';
/**
 * auctionNPC.js — Bots NPC que participan en la Casa de Subastas (DIS-1482)
 *
 * 3 NPCs con personalidad y catálogos propios subastan ítems periódicamente,
 * creando actividad en el sistema de subastas incluso sin jugadores.
 * También pujan en subastas activas de jugadores para simular competencia real.
 *
 * IDs negativos: -1, -2, -3 (nunca colisionan con jugadores reales).
 * Si un NPC gana como comprador, el ítem "desaparece" (el NPC se lo lleva).
 * Si un NPC vende y nadie puja, el ítem pasa al mercado pasivo normalmente.
 *
 * DIS-1913: Catálogos por tier de rareza (común/raro/épico) con ponderación:
 *   70% común, 25% raro, 5% épico.
 *   Ítems raros/épicos tienen duración extendida (10/15 min) para dar más tiempo.
 */

let db = null;
let io = null;

// ─── Duración de subastas por rareza (DIS-1913) ──────────────────────────────

const AUCTION_DURATION = {
  común:      5  * 60 * 1000,   //  5 min (default)
  raro:       10 * 60 * 1000,   // 10 min
  épico:      15 * 60 * 1000,   // 15 min
};

/**
 * Selecciona un ítem del catálogo ponderado por rareza (DIS-1913).
 * Probabilidades: 70% común, 25% raro, 5% épico.
 * Si no hay ítems en un tier, cae al tier inferior.
 */
function weightedCatalogueEntry(bot) {
  const commons = bot.catalogue.filter(e => e.rarity === 'común' || !e.rarity);
  const rares   = bot.catalogue.filter(e => e.rarity === 'raro');
  const epics   = bot.catalogue.filter(e => e.rarity === 'épico');

  const roll = Math.random() * 100;
  let pool;
  if (roll < 5 && epics.length > 0) {
    pool = epics;
  } else if (roll < 30 && rares.length > 0) {
    pool = rares;
  } else {
    pool = commons.length > 0 ? commons : bot.catalogue;
  }

  return pool[Math.floor(Math.random() * pool.length)];
}

// ─── Definición de bots NPC ───────────────────────────────────────────────────

const NPC_BOTS = [
  {
    id: -1,
    name: 'Bertholdt el Trapero',
    emoji: '🧹',
    // DIS-1913: catálogo dividido en tiers de rareza
    catalogue: [
      // — Comunes —
      { item: 'hierba curativa',         minPrice: 3,  rarity: 'común' },
      { item: 'poción de salud',         minPrice: 8,  rarity: 'común' },
      { item: 'cuchillo oxidado',        minPrice: 5,  rarity: 'común' },
      { item: 'escudo de madera',        minPrice: 7,  rarity: 'común' },
      { item: 'antorcha',                minPrice: 2,  rarity: 'común' },
      { item: 'fragmento de hueso',      minPrice: 2,  rarity: 'común' },
      { item: 'moneda de cobre',         minPrice: 1,  rarity: 'común' },
      { item: 'vendas',                  minPrice: 4,  rarity: 'común' },
      // — Raros —
      { item: 'collar de garras',        minPrice: 28, rarity: 'raro'  },
      { item: 'poción mayor de salud',   minPrice: 22, rarity: 'raro'  },
      { item: 'corona rota',             minPrice: 35, rarity: 'raro'  },
      { item: 'llave oxidada',           minPrice: 18, rarity: 'raro'  },
      // — Épicos —
      { item: 'filacteria rota',         minPrice: 75, rarity: 'épico' },
      { item: 'espada envenenada',       minPrice: 80, rarity: 'épico' },
    ],
    // Categorías que este bot compra (keywords en el nombre del ítem)
    buysKeywords: ['poción', 'hierba', 'fragmento', 'moneda', 'vendas', 'antorcha'],
    // Porcentaje de probabilidad de pujar en un turno dado (0–100)
    bidChance: 40,
    // Cuánto sube sobre el precio actual al pujar (porcentaje + base fija)
    bidOverpay: { pct: 0.05, flat: 1 },
    // Cada cuántos minutos puede subastar un ítem nuevo (aleatorio entre min y max)
    cooldownMin: 10,
    cooldownMax: 30,
    // Tiempo de la última subasta (en ms), gestionado en memoria
    lastAuctionAt: 0,
  },
  {
    id: -2,
    name: 'Melisandra la Hechicera',
    emoji: '🔮',
    catalogue: [
      // — Comunes —
      { item: 'pergamino arcano',        minPrice: 12, rarity: 'común' },
      { item: 'pergamino de fuego',      minPrice: 15, rarity: 'común' },
      { item: 'poción de invisibilidad', minPrice: 20, rarity: 'común' },
      { item: 'cristal de mana',         minPrice: 10, rarity: 'común' },
      { item: 'ojo de murciélago',       minPrice: 6,  rarity: 'común' },
      { item: 'poción de fuerza',        minPrice: 14, rarity: 'común' },
      { item: 'poción de velocidad',     minPrice: 14, rarity: 'común' },
      { item: 'esencia arcana',          minPrice: 18, rarity: 'común' },
      // — Raros —
      { item: 'grimorio élfico',         minPrice: 40, rarity: 'raro'  },
      { item: 'cristal resonante',       minPrice: 32, rarity: 'raro'  },
      { item: 'esencia de sombra',       minPrice: 30, rarity: 'raro'  },
      { item: 'pergamino de furia',      minPrice: 25, rarity: 'raro'  },
      { item: 'poción de maná mayor',    minPrice: 28, rarity: 'raro'  },
      // — Épicos —
      { item: 'pergamino de velocidad',  minPrice: 90, rarity: 'épico' },
      { item: 'túnica encantada',        minPrice: 120, rarity: 'épico'},
    ],
    buysKeywords: ['pergamino', 'cristal', 'esencia', 'poción', 'ojo', 'mana'],
    bidChance: 55,
    bidOverpay: { pct: 0.12, flat: 2 },
    cooldownMin: 12,
    cooldownMax: 35,
    lastAuctionAt: 0,
  },
  {
    id: -3,
    name: 'Drago el Herrero',
    emoji: '⚒️',
    catalogue: [
      // — Comunes —
      { item: 'espada de hierro',              minPrice: 8,  rarity: 'común' },  // DIS-1554
      { item: 'escudo de hierro',              minPrice: 16, rarity: 'común' },
      { item: 'armadura de cuero endurecido',  minPrice: 15, rarity: 'común' },
      { item: 'espada corta',                  minPrice: 12, rarity: 'común' },
      { item: 'martillo de combate',           minPrice: 19, rarity: 'común' },
      { item: 'daga de acero',                 minPrice: 14, rarity: 'común' },
      // — Raros —
      { item: 'cota de malla',                 minPrice: 35, rarity: 'raro'  },
      { item: 'escudo de gladiador',           minPrice: 45, rarity: 'raro'  },
      { item: 'peto de huesos',                minPrice: 30, rarity: 'raro'  },
      { item: 'cuchillo envenenado',           minPrice: 28, rarity: 'raro'  },
      // — Épicos —
      { item: 'hacha de guerra',               minPrice: 85, rarity: 'épico' },
      { item: 'armadura de placas',            minPrice: 130, rarity: 'épico'},
      { item: 'alabarda de huesos',            minPrice: 95, rarity: 'épico' },
    ],
    buysKeywords: ['espada', 'hacha', 'escudo', 'armadura', 'cota', 'martillo', 'daga', 'lanza', 'arco'],
    bidChance: 35,
    bidOverpay: { pct: 0.08, flat: 2 },
    cooldownMin: 15,
    cooldownMax: 40,
    lastAuctionAt: 0,
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normaliza una cadena para comparación (minúsculas, sin tildes).
 */
function norm(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Devuelve un entero aleatorio entre min y max (inclusive).
 */
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Broadcast global de un mensaje del sistema de subastas.
 */
function broadcast(msg) {
  if (io) {
    io.emit('shout', { username: '🔨 REMATE', message: msg });
  }
  console.log(`[auctionNPC] ${msg}`);
}

// ─── Lógica principal ─────────────────────────────────────────────────────────

/**
 * Verifica si el bot tiene una subasta activa.
 */
function botHasActiveAuction(botId) {
  try {
    const active = db.getActiveAuctions();
    return active.some(a => a.seller_id === botId);
  } catch (_) {
    return false;
  }
}

/**
 * Intenta que el bot cree una nueva subasta si ya pasó su cooldown.
 */
function maybeAuction(bot) {
  const now = Date.now();
  const cooldownMs = randInt(bot.cooldownMin, bot.cooldownMax) * 60 * 1000;

  if (now - bot.lastAuctionAt < cooldownMs) return;
  if (botHasActiveAuction(bot.id)) return;

  // DIS-1913: Seleccionar ítem ponderado por rareza (70% común, 25% raro, 5% épico)
  const entry = weightedCatalogueEntry(bot);

  // Precio con una variación aleatoria del ±20% para que no sea siempre igual
  const variation = 1 + (Math.random() * 0.4 - 0.2); // 0.8 → 1.2
  const price = Math.max(1, Math.round(entry.minPrice * variation));

  // DIS-1913: duración extendida para ítems raros/épicos
  const rarity = entry.rarity || 'común';
  const durationMs = AUCTION_DURATION[rarity] || AUCTION_DURATION['común'];

  // Etiqueta de rareza para el broadcast
  const rarityLabel = rarity !== 'común' ? ` ✨ [${rarity.toUpperCase()}]` : '';

  try {
    const auction = db.createAuction(bot.id, bot.name, entry.item, price, durationMs);
    bot.lastAuctionAt = now;

    const durationMin = Math.round(durationMs / 60000);
    const msg = `${bot.emoji} ${bot.name} pone a la venta:${rarityLabel} "${entry.item}" — precio mínimo ${price}g. (ID #${auction.id}, ${durationMin} min) Usá: pujar ${auction.id} <monto>`;
    broadcast(msg);
  } catch (err) {
    console.error(`[auctionNPC] Error al crear subasta para ${bot.name}:`, err.message);
  }
}

/**
 * Intenta que el bot puje en una subasta activa de otro vendedor.
 */
function maybeBid(bot) {
  if (Math.random() * 100 > bot.bidChance) return;

  try {
    const active = db.getActiveAuctions();
    // Filtrar: no pujar en subastas propias ni en las de otros bots NPC
    const eligible = active.filter(a =>
      a.seller_id !== bot.id &&               // No es suya
      a.bidder_id !== bot.id &&               // No es la última pujadora
      a.seller_id > 0 &&                      // El vendedor es un jugador real
      norm(a.item_name) !== norm('carta sellada') // Nunca pujar en carta sellada
    );

    if (eligible.length === 0) return;

    // Preferir ítems del catálogo de keywords del bot
    const preferred = eligible.filter(a =>
      bot.buysKeywords.some(kw => norm(a.item_name).includes(norm(kw)))
    );

    const target = preferred.length > 0
      ? preferred[Math.floor(Math.random() * preferred.length)]
      : eligible[Math.floor(Math.random() * eligible.length)];

    const currentBid = target.current_bid > 0 ? target.current_bid : target.min_price;
    const myBid = Math.ceil(currentBid * (1 + bot.bidOverpay.pct) + bot.bidOverpay.flat);

    // Límite razonable: no pagar más del 3× el precio mínimo original
    const cap = target.min_price * 3;
    if (myBid > cap) return;

    const result = db.placeBid(target.id, bot.id, bot.name, myBid);
    if (result.ok) {
      const msg = `${bot.emoji} ${bot.name} puja ${myBid}g por "${target.item_name}". (ID #${target.id})`;
      broadcast(msg);
    }
  } catch (err) {
    console.error(`[auctionNPC] Error al pujar para ${bot.name}:`, err.message);
  }
}

// ─── Tick principal ───────────────────────────────────────────────────────────

/**
 * Tick del sistema NPC. Llamar periódicamente (cada 5 minutos aprox).
 * Cada bot puede subastar y/o pujar en este ciclo.
 */
function tick() {
  if (!db) return;
  try {
    for (const bot of NPC_BOTS) {
      maybeAuction(bot);
      maybeBid(bot);
    }
  } catch (err) {
    console.error('[auctionNPC] Error en tick:', err.message);
  }
}

/**
 * Inicializa el módulo. Llamar una vez al arrancar el servidor.
 * @param {object} dbInstance — instancia de db.js
 * @param {object} [ioInstance] — instancia de socket.io
 */
function init(dbInstance, ioInstance = null) {
  db = dbInstance;
  io = ioInstance;

  // Arrancar con cooldowns escalonados para que los bots no subasten todos a la vez
  // al reiniciar el servidor. Le damos a cada bot un "lastAuctionAt" en el pasado
  // pero no demasiado en el pasado — primer subasta entre 1 y 5 min tras arranque.
  const now = Date.now();
  NPC_BOTS.forEach((bot, i) => {
    const delayMin = 1 + i * 2; // 1, 3, 5 min de delay inicial (era 5, 10, 15)
    const delayMs = delayMin * 60 * 1000;
    // Simular que la "última subasta" fue hace (cooldownMax - delayMin) minutos
    // para que el primer tick que ocurra después del delay la dispare
    bot.lastAuctionAt = now - (bot.cooldownMax * 60 * 1000) + delayMs;
  });

  // DIS-1537: Si no hay ninguna subasta activa de NPC al arrancar,
  // crear una inmediatamente para que el mercado nunca se vea vacío.
  // Esto resuelve el problema de Render.com reiniciando el servidor frecuentemente:
  // cada reinicio garantiza al menos 1 subasta NPC visible.
  setTimeout(() => {
    try {
      const active = db.getActiveAuctions();
      const hasNpcAuction = active.some(a => a.seller_id < 0);
      if (!hasNpcAuction) {
        // Forzar primera subasta del primer bot disponible
        const bot = NPC_BOTS[0];
        bot.lastAuctionAt = 0; // resetear para que pase el check de cooldown
        maybeAuction(bot);
        console.log('[auctionNPC] Sin subastas NPC activas al arrancar — subasta inicial creada.');
      } else {
        console.log('[auctionNPC] Subastas NPC activas encontradas al arrancar, no es necesario crear una inicial.');
      }
    } catch (err) {
      console.error('[auctionNPC] Error en subasta inicial de arranque:', err.message);
    }
  }, 30 * 1000); // 30 segundos después del arranque (esperar que la DB esté lista)

  console.log('[auctionNPC] Iniciado. 3 NPCs activos en la Casa de Subastas.');
  console.log('[auctionNPC] Bots:', NPC_BOTS.map(b => b.name).join(', '));
}

module.exports = { init, tick, NPC_BOTS };
