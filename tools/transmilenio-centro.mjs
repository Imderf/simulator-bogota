// Estaciones de TransMilenio de la zona: baja de OpenStreetMap (Overpass) las estaciones y escribe
// datos/centro/transmilenio.json como [{ nombre, x, z, rumbo, largo, ancho }], un registro por vagón (módulo).
// Cada vagón viene como polígono (la estación como vía cerrada, o una relación multipolígono con un "outer" por
// vagón): se vuelve una caja alineada con su lado más largo y con el sentido del carril de bus más cercano.
// El crudo queda en tools/data/raw/osm_transmilenio.json (fuera de git); bórralo para refrescarlo.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { ZONA, aMundo } from './zona.mjs';

const RAW = fileURLToPath(new URL('data/raw/', import.meta.url));
const SALIDA = fileURLToPath(new URL(`../datos/${ZONA.nombre}/`, import.meta.url));
const UA = 'simulador-bogota/0.1 (https://github.com/Imderf/simulator-bogota)';
const [W, S, E, N] = ZONA.caja;
const log = (...a) => console.log('[transmilenio]', ...a);
fs.mkdirSync(RAW, { recursive: true });

// La red a veces viene mal escrita en OpenStreetMap ("TransMielnio"): basta con "Trans" + "M".
const ES_TM = /trans\s*-?\s*m/i;
const esTM = (t) => ES_TM.test([t.network, t.operator, t.brand, t.name].join(' '));

async function bajar() {
  const archivo = path.join(RAW, 'osm_transmilenio.json');
  if (fs.existsSync(archivo) && fs.statSync(archivo).size > 100) { log('crudo ya existe'); return JSON.parse(fs.readFileSync(archivo, 'utf8')); }
  const q = `[out:json][timeout:120];(nwr["public_transport"~"^(station|platform)$"](${S},${W},${N},${E});` +
    `nwr["amenity"="bus_station"](${S},${W},${N},${E}););out geom;`;
  const servidores = ['https://overpass-api.de/api/interpreter', 'https://lz4.overpass-api.de/api/interpreter',
    'https://z.overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  // Overpass se cae seguido: se rota de servidor y se espera un poco más en cada vuelta.
  for (let i = 0; i < 8; i++) {
    const ep = servidores[i % servidores.length];
    try {
      const r = await fetch(ep, { method: 'POST', body: new URLSearchParams({ data: q }), headers: { 'User-Agent': UA } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      if (!Array.isArray(d.elements)) throw new Error('respuesta sin elementos');
      fs.writeFileSync(archivo, JSON.stringify(d));
      log(d.elements.length, 'elementos de', ep);
      return d;
    } catch (e) {
      log(ep, e.message);
      await new Promise((ok) => setTimeout(ok, (i + 1) * 3000));
    }
  }
  throw new Error('Overpass no respondió');
}

// Carriles del binario de vías (mismo formato que lee js/binario.js + js/vias.js, firma BOV2).
function carriles() {
  const datos = zlib.gunzipSync(fs.readFileSync(path.join(SALIDA, 'vias.bin.gz')));
  if (datos.toString('ascii', 0, 4) !== 'BOV2') throw new Error('vias.bin.gz no es BOV2');
  const n = datos.readUInt32LE(4), flujos = [];
  let cursor = 8 + n * 4;
  for (let i = 0; i < n; i++) {
    const fin = cursor + datos.readUInt32LE(8 + i * 4);
    let c = cursor;
    const uint = () => { let v = 0, s = 0, b; do { b = datos[c++]; v |= (b & 127) << s; s += 7; } while (b & 128); return v >>> 0; };
    flujos.push({ uint, int: () => { const v = uint(); return (v >>> 1) ^ -(v & 1); } });
    cursor = fin;
  }
  const [meta, xs, zs] = flujos, tramos = [];
  let x = 0, z = 0;
  for (let k = meta.uint(); k > 0; k--) {
    const clase = meta.uint(), b = meta.uint();
    meta.uint(); // carriles
    const p = [];
    for (let i = meta.uint(); i > 0; i--) { x += xs.int(); z += zs.int(); p.push([x * 0.5, z * 0.5]); }
    if (b & 2) p.reverse();
    // Además de los de bus, las de servicio de un sentido: algunos carriles de TransMilenio (Eje Ambiental) vienen
    // solo con psv=bus y no quedan marcados como de bus en las vías.
    const bus = !!(b & 4);
    if (!bus && !(clase === 4 && b & 1)) continue;
    for (let i = 0; i < p.length - 1; i++) {
      const [ax, az] = p[i], [bx, bz] = p[i + 1], l = Math.hypot(bx - ax, bz - az);
      if (l > 0.1) tramos.push({ ax, az, ux: (bx - ax) / l, uz: (bz - az) / l, l, bus });
    }
  }
  return tramos;
}

// Punto más cercano sobre los tramos (opcional: solo los que van en un sentido dado).
function cercano(tramos, x, z, filtro = () => true) {
  let mejor = null;
  for (const t of tramos) {
    if (!filtro(t)) continue;
    const s = Math.max(0, Math.min(t.l, (x - t.ax) * t.ux + (z - t.az) * t.uz));
    const px = t.ax + t.ux * s, pz = t.az + t.uz * s, d = Math.hypot(x - px, z - pz);
    if (!mejor || d < mejor.d) mejor = { d, x: px, z: pz, t };
  }
  return mejor;
}

// Caja alineada con el lado más largo del polígono.
function cajaDe(p) {
  let mejor = 0, ux = 1, uz = 0;
  for (let i = 0; i < p.length - 1; i++) {
    const dx = p[i + 1][0] - p[i][0], dz = p[i + 1][1] - p[i][1], l = Math.hypot(dx, dz);
    if (l > mejor) { mejor = l; ux = dx / l; uz = dz / l; }
  }
  return extension(p, ux, uz);
}
function extension(p, ux, uz) {
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (const [x, z] of p) {
    const a = x * ux + z * uz, b = -x * uz + z * ux;
    a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b);
  }
  const am = (a0 + a1) / 2, bm = (b0 + b1) / 2;
  return { x: am * ux - bm * uz, z: am * uz + bm * ux, ux, uz, largo: a1 - a0, ancho: b1 - b0 };
}
const esquinas = (c) => [-1, 1].flatMap((i) => [-1, 1].map((j) => [
  c.x + c.ux * c.largo / 2 * i - c.uz * c.ancho / 2 * j, c.z + c.uz * c.largo / 2 * i + c.ux * c.ancho / 2 * j]));
const nombreDe = (t) => (t.name || '').replace(/^Estaci[oó]n\s+/i, '').trim();

const d = await bajar();
const tramos = carriles();
const [x0, z0] = aMundo(W, N), [x1, z1] = aMundo(E, S);
const vagones = [];
for (const el of d.elements) {
  const t = el.tags || {};
  if (!esTM(t) || !(t.public_transport === 'station' || t.amenity === 'bus_station')) continue;
  const anillos = el.type === 'way' ? [el.geometry] : el.type === 'relation' ? el.members.filter((m) => m.geometry).map((m) => m.geometry) : [];
  for (const g of anillos) {
    const c = cajaDe(g.map(({ lon, lat }) => aMundo(lon, lat)));
    // Fuera quedan los accesos, las plazoletas y las áreas que cubren toda la estación.
    if (c.largo < 20 || c.ancho < 2 || c.ancho > 10 || c.largo < 3 * c.ancho) continue;
    if (c.x < x0 || c.x > x1 || c.z < z0 || c.z > z1) continue;
    // Un mismo vagón llega como vía y como miembro de la relación, o partido en dos mitades: se unen si se tocan
    // y la unión no queda más ancha que un vagón.
    const otro = vagones.find((v) => Math.abs(v.ux * c.ux + v.uz * c.uz) > 0.95 &&
      Math.abs(-(c.x - v.x) * v.uz + (c.z - v.z) * v.ux) < (v.ancho + c.ancho) / 2 + 0.5 &&
      Math.abs((c.x - v.x) * v.ux + (c.z - v.z) * v.uz) < (v.largo + c.largo) / 2);
    const union = otro && extension([...esquinas(otro), ...esquinas(c)], otro.ux, otro.uz);
    if (union && union.ancho <= 10) Object.assign(otro, union);
    else vagones.push({ nombre: nombreDe(t), ...c });
  }
}

// Sentido: el del carril de bus paralelo más cercano (si no hay, el de una vía de servicio de un sentido).
const salida = vagones.map((v) => {
  const paralelo = (bus) => (t) => t.bus === bus && Math.abs(t.ux * v.ux + t.uz * v.uz) > 0.9;
  const c = [cercano(tramos, v.x, v.z, paralelo(true)), cercano(tramos, v.x, v.z, paralelo(false))].find((c) => c && c.d < 25);
  const signo = c && c.t.ux * v.ux + c.t.uz * v.uz < 0 ? -1 : 1;
  log(v.nombre.padEnd(28), `${v.x.toFixed(0)}, ${v.z.toFixed(0)}`, `${v.largo.toFixed(0)} x ${v.ancho.toFixed(1)} m`,
    c ? `carril ${c.t.bus ? 'de bus' : 'de servicio'} a ${c.d.toFixed(1)} m` : 'sin carril');
  const r = (n, k = 10) => Math.round(n * k) / k;
  return { nombre: v.nombre, x: r(v.x), z: r(v.z), rumbo: r(Math.atan2(-v.ux * signo, -v.uz * signo), 1000), largo: r(v.largo), ancho: r(v.ancho) };
});
fs.writeFileSync(path.join(SALIDA, 'transmilenio.json'), JSON.stringify(salida));
log(salida.length, 'vagones en', path.join(SALIDA, 'transmilenio.json'));
