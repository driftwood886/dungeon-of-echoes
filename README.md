# Dungeon of Echoes

> MUD-lite multijugador basado en texto. Explorá un dungeon, luchá contra monstruos, recolectá ítems y cruzate con otros jugadores en tiempo real.

[![Node.js](https://img.shields.io/badge/Node.js-18+-green)](https://nodejs.org)
[![Socket.io](https://img.shields.io/badge/Socket.io-4.x-blue)](https://socket.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

---

## Stack

| Capa | Tecnología |
|------|-----------|
| Backend | Node.js + Express |
| Tiempo real | Socket.io |
| Base de datos | sql.js (SQLite via WebAssembly) |
| Frontend | HTML/CSS vanilla (estética terminal BBS) |
| Deploy | Fly.io (backend) + GitHub Pages (frontend) |

---

## Instalación

```bash
git clone https://github.com/driftwood886/dungeon-of-echoes.git
cd dungeon-of-echoes
npm install
npm start
```

El servidor corre en `http://localhost:3000`.
Abrí esa URL en el browser para jugar desde la interfaz terminal.

---

## Comandos del juego

| Comando | Descripción |
|---------|-------------|
| `look` | Ver la habitación actual |
| `move <dir>` | Moverse (north/south/east/west o n/s/e/w) |
| `inventory` / `inv` | Ver inventario |
| `status` | Ver estado del jugador (HP, stats) |
| `attack <monstruo>` | Atacar un monstruo |
| `flee` / `huir` | Huir del combate |
| `pick <ítem>` | Recoger un ítem del suelo |
| `use <ítem>` | Usar un ítem (poción = recuperar HP, arma = equipar) |
| `say <mensaje>` | Chat local a la habitación |
| `shout <mensaje>` | Broadcast global a todos los jugadores |

---

## API para LLMs

El servidor expone una API REST diseñada para que cualquier LLM pueda jugar de forma autónoma sin interfaz gráfica.

### Flujo típico

```
POST /api/login       ← registrar o recuperar jugador
GET  /api/state/:id   ← leer estado actual
POST /api/action      ← ejecutar comando y leer estado post-acción
(repetir GET/POST)
```

---

### `POST /api/login`

Registra o recupera un jugador por username (sin password).

**Body:**
```json
{ "username": "NombreAventurero" }
```

**Respuesta:**
```json
{
  "player_id": "uuid-del-jugador",
  "username": "NombreAventurero",
  "welcome": "Estás en la Sala de Entrada. Un pasillo oscuro se extiende..."
}
```

---

### `GET /api/state/:player_id`

Devuelve el estado completo del juego como JSON estructurado.

**Ejemplo de respuesta:**
```json
{
  "room": {
    "id": 1,
    "name": "Corredor de las Sombras",
    "description": "Un pasillo largo y estrecho. Las paredes de piedra sudan humedad.",
    "exits": ["north", "south", "west"],
    "monsters": [
      { "name": "Goblin Merodeador", "hp": 15, "max_hp": 15 }
    ],
    "creatures": [
      { "name": "Goblin Merodeador", "hp": 15, "max_hp": 15 }
    ],
    "items": ["espada oxidada"]
  },
  "player": {
    "id": "uuid-del-jugador",
    "username": "NombreAventurero",
    "hp": 28,
    "max_hp": 30,
    "attack": 5,
    "defense": 2,
    "inventory": ["antorcha", "poción de salud"]
  },
  "other_players": ["Ana (HP: 20/30)"],
  "recent_events": [
    "Entraste al corredor.",
    "Goblin Merodeador aparece de entre las sombras."
  ]
}
```

---

### `POST /api/action`

Ejecuta un comando y devuelve el resultado de texto **más el estado completo post-acción** en una sola llamada.

**Body:**
```json
{ "player_id": "uuid-del-jugador", "command": "attack goblin" }
```

**Respuesta:**
```json
{
  "result": "Atacás al Goblin Merodeador por 5 de daño. El goblin te golpea por 3. HP: 25/30.",
  "state": {
    "room": { "...": "estado actualizado post-acción" },
    "player": { "hp": 25, "max_hp": 30, "...": "..." },
    "other_players": [],
    "recent_events": ["Atacaste al Goblin Merodeador."]
  }
}
```

**Comandos válidos para `/api/action`:**

```
look                    → describir habitación
move <dir>              → moverse (north/south/east/west/n/s/e/w)
attack <nombre>         → atacar monstruo
flee                    → huir del combate
pick <ítem>             → recoger ítem del suelo
use <ítem>              → usar ítem del inventario
inventory               → listar inventario
status                  → ver estadísticas del jugador
```

---

### `POST /api/command` (legacy)

Igual que `/api/action` pero solo devuelve el resultado de texto (sin estado):

```json
{ "player_id": "uuid", "command": "look" }
→ { "result": "Estás en el Corredor de las Sombras..." }
```

---

## Bot Demo

El repo incluye `llm_bot.js`, un bot de ejemplo que juega automáticamente usando solo la API REST.

```bash
# Iniciar el servidor en una terminal
npm start

# En otra terminal, correr el bot
node llm_bot.js

# Opciones disponibles
node llm_bot.js --url http://localhost:3000 --username MiBot --steps 30 --delay 1500
```

**Estrategia del bot demo (sin LLM externo):**
1. Si HP < 40% y tiene pociones → usar poción
2. Si hay monstruos en la sala → atacar
3. Si hay ítems en el suelo → recoger
4. Si no hay nada → moverse en dirección aleatoria

Para integrar una LLM real, reemplazá la función `chooseAction(state)` en `llm_bot.js` con una llamada a tu API preferida (OpenAI, Anthropic, etc.) pasándole el JSON del estado como contexto.

---

## Estructura del proyecto

```
dungeon-of-echoes/
├── server/
│   ├── index.js          # Entry point (Express + Socket.io)
│   ├── game/
│   │   ├── engine.js     # Motor principal (execute commands)
│   │   ├── dungeon.js    # Carga de habitaciones, exits
│   │   ├── combat.js     # Combate por turnos, respawn
│   │   ├── items.js      # Catálogo de ítems
│   │   └── commands.js   # Parser texto → acción
│   ├── db/
│   │   ├── db.js         # Acceso a SQLite (sql.js)
│   │   ├── schema.sql    # Esquema de tablas
│   │   └── seed.js       # Datos iniciales (10 rooms, 5 monsters)
│   └── socket/
│       └── handlers.js   # Eventos Socket.io (join/command/say/shout)
├── client/
│   ├── index.html        # UI terminal BBS
│   ├── style.css         # Estética verde/negro, HP bar, sidebar
│   └── game.js           # Cliente Socket.io + lógica de UI
├── llm_bot.js            # Bot demo para integración LLM
└── package.json
```

---

## Desarrollo

El proyecto sigue un roadmap en fases. Estado actual: **Fase 6 completada**.

| Fase | Descripción | Estado |
|------|-------------|--------|
| 1 | Setup: repo, Node.js, estructura base | ✅ |
| 2 | Motor del juego: habitaciones, movimiento | ✅ |
| 3 | Combate por turnos + ítems | ✅ |
| 4 | Multijugador con Socket.io | ✅ |
| 5 | Frontend estilo terminal | ✅ |
| 6 | Endpoint LLM-friendly + bot demo | ✅ |
| 7 | Deploy público en Fly.io | ⏳ |
| 8+ | Iteración: playtests, mejoras | ⏳ |
