// Escritor del formato binario de datos (ver js/binario.js para el lector).
// Archivo = firma de 4 bytes + número de flujos + largo de cada flujo + flujos, todo en gzip.
// Cada flujo es una lista de varints sin signo; los valores con signo van en zigzag.
// Separar X, Z y atributos en flujos distintos hace que gzip comprima mucho mejor.

import zlib from 'node:zlib';

export class Flujo {
  constructor() {
    this.bytes = [];
  }
  uint(v) {
    if (!Number.isInteger(v) || v < 0 || v > 0x7fffffff) throw new Error(`valor fuera de rango: ${v}`);
    do {
      let b = v & 127;
      v >>>= 7;
      if (v) b |= 128;
      this.bytes.push(b);
    } while (v);
  }
  int(v) {
    this.uint(v >= 0 ? v * 2 : -v * 2 - 1);
  }
}

export function empaquetar(firma, flujos) {
  if (firma.length !== 4) throw new Error('la firma tiene 4 letras');
  const cab = Buffer.alloc(8 + flujos.length * 4);
  cab.write(firma, 0, 'ascii');
  cab.writeUInt32LE(flujos.length, 4);
  flujos.forEach((f, i) => cab.writeUInt32LE(f.bytes.length, 8 + i * 4));
  const crudo = Buffer.concat([cab, ...flujos.map((f) => Buffer.from(f.bytes))]);
  return zlib.gzipSync(crudo, { level: 9 });
}
