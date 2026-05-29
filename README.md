# Dungeon of Echoes

> MUD-lite multijugador basado en texto. Explorá un dungeon, luchá contra monstruos, recolectá ítems y cruzate con otros jugadores en tiempo real.

## Stack

- **Backend:** Node.js + Express
- **Tiempo real:** Socket.io
- **Base de datos:** sql.js (SQLite via WebAssembly)
- **Frontend:** HTML/CSS vanilla (estética terminal BBS)
- **Deploy:** Fly.io (backend) + GitHub Pages (frontend)

## Instalación

```bash
npm install
npm start
```

El servidor corre en `http://localhost:3000`.

## Comandos del juego

| Comando | Descripción |
|---------|-------------|
| `look` | Ver la habitación actual |
| `move <dir>` | Moverse (north, south, east, west) |
| `inventory` | Ver inventario |
| `status` | Ver estado del jugador (HP, stats) |
| `attack <monstruo>` | Atacar un monstruo |
| `pick <ítem>` | Recoger un ítem del suelo |
| `use <ítem>` | Usar un ítem (poción = recuperar HP) |
| `say <mensaje>` | Chat local a la habitación |
| `shout <mensaje>` | Broadcast global |

## API para LLMs

### GET `/api/state/:player_id`

Devuelve el estado completo del juego como JSON:

```json
{
  "room": {
    "name": "Corredor de las Sombras",
    "description": "Un pasillo largo y estrecho...",
    "exits": ["north", "south", "west"],
    "monsters": [{"name": "Goblin Merodeador", "hp": 15, "max_hp": 15}],
    "items": []
  },
  "player": {
    "hp": 28, "max_hp": 30,
    "inventory": ["antorcha"],
    "attack": 5, "defense": 2
  },
  "other_players": [],
  "recent_events": ["Entraste al corredor."]
}
```

### POST `/api/action`

```json
{ "player_id": "uuid", "command": "move north" }
```

Responde con:

```json
{ "ok": true, "message": "Te movés al norte.", "state": { ... } }
```

## Desarrollo

El proyecto está organizado en fases. Ver `DISEÑO.md` para la arquitectura completa.

```
dungeon-of-echoes/
├── server/
│   ├── index.js          # Entry point
│   ├── game/             # Motor del juego
│   ├── db/               # SQLite (db.js, schema.sql, seed.js)
│   ├── api/              # Rutas REST
│   └── socket/           # Handlers Socket.io
├── client/               # Frontend HTML/CSS/JS
└── package.json
```
