#!/bin/bash
# Playtest bot para Dungeon of Echoes
PID_FILE="/tmp/playtest_pid.txt"
BASE="http://localhost:3000"

# Login
echo "=== LOGIN ==="
RESP=$(curl -s -X POST $BASE/api/login -H "Content-Type: application/json" -d '{"username":"BotBug02"}')
PID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['player_id'])" 2>/dev/null)
echo "Player ID: $PID"

A() {
  local CMD="$1"
  curl -s -X POST $BASE/api/action \
    -H "Content-Type: application/json" \
    -d "{\"player_id\":\"$PID\",\"command\":\"$CMD\"}" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('result','') or d.get('text','') or str(d)[:200]; print(r[:500])" 2>/dev/null
  sleep 0.3
}

echo ""
echo "=== clase guerrero ==="
A "clase guerrero"

echo ""
echo "=== status inicial ==="
A "status"

echo ""
echo "=== look (antesala) ==="
A "look"

echo ""
echo "=== attack goblin (tutorial) ==="
A "attack goblin"

echo ""
echo "=== south (entrar al dungeon) ==="
A "south"

echo ""
echo "=== look (corredor) ==="
A "look"

echo ""
echo "=== pick todo ==="
A "pick todo"

echo ""
echo "=== south (sala 2) ==="
A "south"

echo ""
echo "=== look ==="
A "look"

echo ""
echo "=== attack goblin ==="
A "attack goblin"

echo ""
echo "=== pick todo ==="
A "pick todo"

echo ""
echo "=== status ==="
A "status"

echo ""
echo "=== south (sala 3) ==="
A "south"

echo ""
echo "=== look ==="
A "look"

echo ""
echo "=== east (sala 4 - mercader) ==="
A "east"

echo ""
echo "=== look ==="
A "look"

echo ""
echo "=== talk mercader ==="
A "talk mercader"

echo ""
echo "=== buy pocion de salud ==="
A "buy pocion de salud"

echo ""
echo "=== inventory ==="
A "inventory"

echo ""
echo "=== status ==="
A "status"

echo ""
echo "=== mapa ==="
A "mapa"

echo ""
echo "=== west (volver sala 3) ==="
A "west"

echo ""
echo "=== east (sala 5 - capilla) ==="
A "east"

echo ""
echo "=== look ==="
A "look"

echo ""
echo "=== examine estatua ==="
A "examine estatua"

echo ""
echo "=== north (sala 6) ==="
A "north"

echo ""
echo "=== look ==="
A "look"

echo ""
echo "=== attack rata ==="
A "attack rata"

echo ""
echo "=== pick todo ==="
A "pick todo"

echo ""
echo "=== south (sala 5) ==="
A "south"

echo ""
echo "=== east (sala 6b?) ==="
A "east"

echo ""
echo "=== look ==="
A "look"

echo ""
echo "=== status ==="
A "status"

echo ""
echo "=== north (sala 9 - sala del trono?) ==="
A "north"

echo ""
echo "=== look ==="
A "look"

echo ""
echo "=== examine ==="
A "examine"

echo ""
echo "=== talk maestro ==="
A "talk maestro"

echo ""
echo "=== duel maestro ==="
A "duel maestro"

echo ""
echo "=== status final ==="
A "status"

echo ""
echo "=== hechizos ==="
A "hechizos"

echo ""
echo "=== skills ==="
A "skills"

echo ""
echo "=== heal (como guerrero) ==="
A "heal"

echo ""
echo "=== use pocion de salud ==="
A "use pocion de salud"

echo ""
echo "=== craft recetas ==="
A "craft recetas"

echo ""
echo "=== achievements ==="
A "achievements"

echo "=== FIN DEL PLAYTEST ==="
