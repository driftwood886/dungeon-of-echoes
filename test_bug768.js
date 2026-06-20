#!/usr/bin/env node
'use strict';

const db = require('./server/db/db');
const { execute } = require('./server/game/engine');

const PLAYER_ID = 'c1d7e0ba-abc6-441a-b700-6d4f8e95c9d6';
const p = db.getPlayer(PLAYER_ID);
if (!p) { console.log('no player'); process.exit(1); }

// Test con jugador en sala 15
db.updatePlayer(p.id, { current_room_id: 15, level: 8, xp: 5000, known_traps: JSON.stringify({}) });
const p2 = db.getPlayer(p.id);
console.log('Moved to room:', p2.current_room_id, 'level:', p2.level);

const room15 = db.getRoom(15);
console.log('Sala 15 items:', JSON.stringify(room15.items));

// Test examine espada de obsidiana
const r = execute(p2.id, 'examine espada de obsidiana');
console.log('RESULT:', r.text ? r.text.substring(0, 400) : JSON.stringify(r));
