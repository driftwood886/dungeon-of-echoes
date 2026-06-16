#!/bin/bash
# Playtest más profundo — guerrero explorando salas avanzadas
BASE="http://localhost:3000"

echo "=== LOGIN ==="
RESP=$(curl -s -X POST $BASE/api/login -H "Content-Type: application/json" -d '{"username":"BotBug03"}')
PID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['player_id'])" 2>/dev/null)
echo "PID: $PID"

A() {
  local CMD="$1"
  RESULT=$(curl -s -X POST $BASE/api/action \
    -H "Content-Type: application/json" \
    -d "{\"player_id\":\"$PID\",\"command\":\"$CMD\"}" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('result','') or d.get('text','') or str(d)[:200]; print(r[:600])" 2>/dev/null)
  echo "$RESULT"
  sleep 0.3
}

echo "=== Elegir clase guerrero ==="
A "clase guerrero"

echo "=== Tutorial — matar goblin ==="
A "attack goblin"

echo "=== Entrar al dungeon ==="
A "south"

echo "=== look inicial ==="
A "look"

echo "=== Matar goblin merodeador (sala 1) ==="
A "attack goblin"
A "attack goblin"
A "attack goblin"

echo "=== kill rata ==="
A "attack rata"
A "attack rata"
A "attack rata"

echo "=== pick todo ==="
A "pick todo"

echo "=== status después de matar ==="
A "status"

echo "=== Ir al norte (sala 2) ==="
A "north"
A "look"
A "attack araña"
A "attack araña"
A "attack araña"
A "pick todo"

echo "=== Ir al norte nuevamente (sala 3 — Capilla?) ==="
A "north"
A "look"

echo "=== Este (sala 4 — Tesoro) ==="
A "east"
A "look"

echo "=== Hablar Aldric ==="
A "talk aldric"

echo "=== shop ==="
A "shop"

echo "=== Ir al oeste y luego norte (sala 7 — Pozo sin Fondo?) ==="
A "west"
A "north"
A "look"

echo "=== Sala del Trono (norte?) ==="
A "north"
A "look"

echo "=== Ver mapa ==="
A "mapa"

echo "=== talk maestro ==="
A "talk maestro"

echo "=== duel maestro ==="
A "duel maestro"

echo "=== status ==="
A "status"

echo "=== recetas ==="
A "recetas"

echo "=== hechizos (como guerrero) ==="
A "hechizos"

echo "=== inventory detallado ==="
A "inventory"

echo "=== examine item del suelo (si hay) ==="
A "examine"

echo "=== TEST: heal como guerrero ==="
A "heal"

echo "=== TEST: pick monedas ==="
A "pick monedas"

echo "=== TEST: pick todo cuando inventario vacío ==="
A "pick todo"

echo "=== TEST: sell (sin estar en tienda) ==="
A "sell"

echo "=== TEST: usar pocion de salud cuando HP lleno ==="
A "buy pocion de salud"
A "use pocion de salud"

echo "=== FIN ==="
