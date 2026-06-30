'use strict';

/**
 * ioRef.js — Singleton para compartir la instancia de Socket.io
 * entre módulos sin dependencias circulares.
 *
 * Uso:
 *   // Al inicializar (index.js):
 *   require('./ioRef').set(io);
 *
 *   // En cualquier módulo que necesite io:
 *   const ioRef = require('./ioRef');
 *   const io = ioRef.get();
 *   if (io) { io.emit(...); }
 *
 * DIS-1039: Permite que say/shout funcionen vía REST (/api/action)
 * emitiendo el mensaje por Socket.io aunque el comando llegue por HTTP.
 */

let _io = null;

module.exports = {
  set: (io) => { _io = io; },
  get: () => _io,
};
