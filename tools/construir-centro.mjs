// Convierte los datos crudos de tools/data/raw/ en los binarios compactos que lee la página (datos/centro/).
// Correr después de tools/bajar-centro.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromFile } from 'geotiff';
import { ZONA, aMundo } from './zona.mjs';
import { Flujo, empaquetar } from './binario.mjs';

const RAW = fileURLToPath(new URL('data/raw/', import.meta.url));
const SALIDA = fileURLToPath(new URL(`../datos/${ZONA.nombre}/`, import.meta.url));
fs.mkdirSync(SALIDA, { recursive: true });
const leer = (f) => JSON.parse(fs.readFileSync(path.join(RAW, f), 'utf8'));
const log = (...a) => console.log('[construir]', ...a);
const escribir = (f, buf) => {
  fs.writeFileSync(path.join(SALIDA, f), buf);
  log(f, (buf.length / 1024).toFixed(0), 'KB');
};
const Q = 0.5; // cuantización de coordenadas en metros

// ---------------------------------------------------------------------------------------------------------------
// Terreno: Copernicus GLO-30 remuestreado a una malla métrica. Es un modelo de superficie (incluye techos y
// copas), así que en la parte plana se toma el mínimo local y luego se suaviza.
// ---------------------------------------------------------------------------------------------------------------
const TERRENO = { caja: [-74.14, 4.53, -74.0008, 4.68], paso: 32, techoPlano: 2700 };

async function terreno() {
  const tif = await fromFile(path.join(RAW, 'copernicus_N04_W075.tif'));
  const img = await tif.getImage();
  const [ancho, alto] = [img.getWidth(), img.getHeight()];
  const [lonT, , , latT] = img.getBoundingBox(); // oeste, sur, este, norte de la celda
  const px = (lon) => ((lon - lonT) / 1) * ancho;
  const py = (lat) => ((latT - lat) / 1) * alto;
  const [w, s, e, n] = TERRENO.caja;
  const x0 = Math.floor(px(w)) - 2, x1 = Math.ceil(px(e)) + 2, y0 = Math.floor(py(n)) - 2, y1 = Math.ceil(py(s)) + 2;
  const [banda] = await img.readRasters({ window: [x0, y0, x1, y1] });
  const bw = x1 - x0;
  const muestra = (lon, lat) => {
    const fx = px(lon) - x0 - 0.5, fy = py(lat) - y0 - 0.5;
    const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
    const v = (i, j) => banda[(iy + j) * bw + ix + i];
    return (v(0, 0) * (1 - tx) + v(1, 0) * tx) * (1 - ty) + (v(0, 1) * (1 - tx) + v(1, 1) * tx) * ty;
  };

  const [xa, za] = aMundo(w, n), [xb, zb] = aMundo(e, s);
  const P = TERRENO.paso;
  const ox = Math.floor(xa / P) * P, oz = Math.floor(za / P) * P;
  const cols = Math.ceil((xb - ox) / P) + 1, filas = Math.ceil((zb - oz) / P) + 1;
  const { KX, KY } = await import('./zona.mjs');
  let h = new Float32Array(cols * filas);
  for (let j = 0; j < filas; j++) for (let i = 0; i < cols; i++) {
    const x = ox + i * P, z = oz + j * P;
    h[j * cols + i] = muestra(ZONA.origen.lon + x / KX, ZONA.origen.lat - z / KY);
  }
  // Mínimo 3x3 solo en la sabana (quita techos); luego promedio 3x3 en todo.
  const filtro = (src, f) => {
    const out = new Float32Array(src.length);
    for (let j = 0; j < filas; j++) for (let i = 0; i < cols; i++) {
      const vals = [];
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const a = Math.min(cols - 1, Math.max(0, i + di)), b = Math.min(filas - 1, Math.max(0, j + dj));
        vals.push(src[b * cols + a]);
      }
      out[j * cols + i] = f(vals, src[j * cols + i]);
    }
    return out;
  };
  h = filtro(h, (v, c) => (c < TERRENO.techoPlano ? Math.min(...v) : c));
  h = filtro(h, (v) => v.reduce((a, b) => a + b, 0) / v.length);

  const base = Math.round(h[Math.round(-oz / P) * cols + Math.round(-ox / P)]);
  const meta = new Flujo(), alturas = new Flujo();
  [cols, filas, P, -ox, -oz, base].forEach((v) => meta.uint(v));
  for (let j = 0; j < filas; j++) {
    let prev = 0;
    for (let i = 0; i < cols; i++) {
      const v = Math.round((h[j * cols + i] - base) / 0.25);
      alturas.int(v - prev);
      prev = v;
    }
  }
  escribir('terreno.bin.gz', empaquetar('BOT1', [meta, alturas]));
  let min = Infinity, max = -Infinity;
  for (const v of h) { min = Math.min(min, v); max = Math.max(max, v); }
  log(`terreno ${cols}x${filas} de ${P} m, base ${base} m, de ${min.toFixed(0)} a ${max.toFixed(0)} m`);
}

// ---------------------------------------------------------------------------------------------------------------
// Edificios del catastro: planta y número de pisos.
// ---------------------------------------------------------------------------------------------------------------
function areaAnillo(p) {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j][0] - p[i][0]) * (p[j][1] + p[i][1]);
  return a / 2;
}

// Quita puntos repetidos tras cuantizar y los que caen casi en línea recta con sus vecinos.
function limpiarAnillo(anillo) {
  let p = [];
  for (const [lon, lat] of anillo) {
    const [x, z] = aMundo(lon, lat);
    const q = [Math.round(x / Q), Math.round(z / Q)];
    const u = p[p.length - 1];
    if (!u || u[0] !== q[0] || u[1] !== q[1]) p.push(q);
  }
  if (p.length > 1 && p[0][0] === p[p.length - 1][0] && p[0][1] === p[p.length - 1][1]) p.pop();
  let cambio = true;
  while (cambio && p.length > 3) {
    cambio = false;
    for (let i = 0; i < p.length && p.length > 3; i++) {
      const a = p[(i - 1 + p.length) % p.length], b = p[i], c = p[(i + 1) % p.length];
      const cruz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      const largo = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
      if (Math.abs(cruz) / largo < 0.6) { p.splice(i, 1); i--; cambio = true; } // 0,3 m
    }
  }
  return p.length >= 3 ? p : null;
}

function edificios() {
  const crudos = leer('construccion.json');
  const meta = new Flujo(), xs = new Flujo(), zs = new Flujo();
  const lista = [];
  for (const f of crudos) {
    const anillos = (f.geometry?.rings || []).map(limpiarAnillo).filter(Boolean);
    if (!anillos.length) continue;
    // ArcGIS: exteriores en sentido horario. Se toma el de mayor área como exterior y los demás como huecos.
    anillos.sort((a, b) => Math.abs(areaAnillo(b)) - Math.abs(areaAnillo(a)));
    if (Math.abs(areaAnillo(anillos[0])) * Q * Q < 6) continue; // casetas y errores de menos de 6 m²
    lista.push({ pisos: Math.max(1, Math.min(90, f.attributes.CONNPISOS || 1)), anillos });
  }
  // Ordenar por posición hace que las diferencias entre edificios seguidos sean pequeñas.
  lista.sort((a, b) => (a.anillos[0][0][1] >> 6) - (b.anillos[0][0][1] >> 6) || a.anillos[0][0][0] - b.anillos[0][0][0]);
  meta.uint(lista.length);
  let px = 0, pz = 0;
  for (const e of lista) {
    meta.uint(e.pisos);
    meta.uint(e.anillos.length);
    for (const r of e.anillos) {
      meta.uint(r.length);
      for (const [x, z] of r) { xs.int(x - px); zs.int(z - pz); px = x; pz = z; }
    }
  }
  escribir('edificios.bin.gz', empaquetar('BOE1', [meta, xs, zs]));
  log(lista.length, 'edificios de', crudos.length);
}

// ---------------------------------------------------------------------------------------------------------------
// Árboles del Jardín Botánico: posición, altura y forma (según la especie).
// ---------------------------------------------------------------------------------------------------------------
export const FORMAS = ['copa', 'conifera', 'palma', 'eucalipto', 'arbusto'];
function forma(especie, altura) {
  const e = (especie || '').toLowerCase();
  if (/palm/.test(e)) return 2;
  if (/cipr|pino|araucaria|cedro de|ciprés/.test(e)) return 1;
  if (/eucalipt/.test(e)) return 3;
  if (altura < 3) return 4;
  return 0;
}

function arboles() {
  const crudos = leer('arbolado.json');
  const vistos = new Set(), lista = [];
  for (const f of crudos) {
    const { x: lon, y: lat } = f.geometry || {};
    if (lon == null) continue;
    const [x, z] = aMundo(lon, lat);
    const q = [Math.round(x / Q), Math.round(z / Q)];
    if (vistos.has(q.join())) continue;
    vistos.add(q.join());
    const alt = Math.max(0.5, Math.min(45, f.attributes.Altura_Total || 2));
    lista.push({ q, alt: Math.round(alt * 2), forma: forma(f.attributes.Nombre_Esp, alt) });
  }
  lista.sort((a, b) => (a.q[1] >> 6) - (b.q[1] >> 6) || a.q[0] - b.q[0]);
  const meta = new Flujo(), xs = new Flujo(), zs = new Flujo();
  meta.uint(lista.length);
  let px = 0, pz = 0;
  for (const a of lista) {
    meta.uint(a.alt);
    meta.uint(a.forma);
    xs.int(a.q[0] - px); zs.int(a.q[1] - pz); px = a.q[0]; pz = a.q[1];
  }
  escribir('arboles.bin.gz', empaquetar('BOA1', [meta, xs, zs]));
  log(lista.length, 'árboles');
}

// ---------------------------------------------------------------------------------------------------------------
// Vías y suelo de OpenStreetMap.
// ---------------------------------------------------------------------------------------------------------------
export const CLASES_VIA = ['troncal', 'principal', 'secundaria', 'local', 'servicio', 'peatonal', 'ciclorruta', 'escalera', 'sendero'];
function claseVia(t) {
  const h = t.highway;
  if (/^(motorway|trunk)(_link)?$/.test(h)) return 0;
  if (/^primary(_link)?$/.test(h)) return 1;
  if (/^(secondary|tertiary)(_link)?$/.test(h)) return 2;
  if (/^(residential|unclassified|living_street)$/.test(h)) return 3;
  if (h === 'service') return 4;
  if (h === 'pedestrian') return 5; // calles peatonales, como la Séptima
  if (h === 'cycleway') return 6;
  if (h === 'steps') return 7;
  if (/^(footway|path|track)$/.test(h)) return 8;
  return -1;
}
// Bit 0: un solo sentido. Bit 1: el sentido va al revés del dibujo. Bit 2: solo buses (carriles de TransMilenio).
function banderasVia(t) {
  const uno = t.oneway === 'yes' || t.oneway === '1' || t.oneway === '-1' || /^(motorway|trunk)(_link)?$/.test(t.highway) && t.oneway !== 'no';
  const bus = t.highway === 'busway' || (t.access === 'no' && /^(designated|yes)$/.test(t.bus || t.psv || ''));
  return (uno ? 1 : 0) | (t.oneway === '-1' ? 2 : 0) | (bus ? 4 : 0);
}
const extraVia = (t) => { const n = parseInt(t.lanes, 10); return [banderasVia(t), n > 0 && n < 10 ? n : 0]; };

function lineas(firma, archivo, elementos, clase, cerradas, extra = null) {
  const meta = new Flujo(), xs = new Flujo(), zs = new Flujo();
  const lista = [];
  for (const el of elementos) {
    if (el.type !== 'way' || !el.geometry) continue;
    const c = clase(el.tags || {});
    if (c < 0) continue;
    const p = [];
    for (const { lon, lat } of el.geometry) {
      const [x, z] = aMundo(lon, lat);
      const q = [Math.round(x / Q), Math.round(z / Q)];
      const u = p[p.length - 1];
      if (!u || u[0] !== q[0] || u[1] !== q[1]) p.push(q);
    }
    if (cerradas && p.length > 2 && p[0][0] === p[p.length - 1][0] && p[0][1] === p[p.length - 1][1]) p.pop();
    if (p.length >= (cerradas ? 3 : 2)) lista.push({ c, p, e: extra ? extra(el.tags || {}) : [] });
  }
  meta.uint(lista.length);
  let px = 0, pz = 0;
  for (const { c, p, e } of lista) {
    meta.uint(c);
    for (const v of e) meta.uint(v);
    meta.uint(p.length);
    for (const [x, z] of p) { xs.int(x - px); zs.int(z - pz); px = x; pz = z; }
  }
  escribir(archivo, empaquetar(firma, [meta, xs, zs]));
  log(lista.length, archivo);
}

export const CLASES_SUELO = ['parque', 'bosque', 'agua', 'cancha', 'parqueadero', 'plaza'];
function claseSuelo(t) {
  if (t.natural === 'water' || t.waterway === 'riverbank') return 2;
  if (t.natural === 'wood' || t.landuse === 'forest' || t.natural === 'scrub') return 1;
  if (t.leisure === 'pitch' || t.leisure === 'stadium') return 3;
  if (t.amenity === 'parking') return 4;
  if (t.place === 'square' || (t.highway === 'pedestrian' && t.area === 'yes')) return 5;
  if (t.leisure || t.landuse || t.natural) return 0;
  return -1;
}

// `node tools/construir-centro.mjs vias` rehace solo las vías (necesita solo osm_vias.json).
const solo = process.argv[2];
if (!solo) {
  await terreno();
  edificios();
  arboles();
}
if (!solo || solo === 'vias') lineas('BOV2', 'vias.bin.gz', leer('osm_vias.json').elements, claseVia, false, extraVia);
if (!solo) lineas('BOS1', 'suelo.bin.gz', [...leer('osm_suelo.json').elements, ...leer('osm_lugares.json').elements], claseSuelo, true);
const total = fs.readdirSync(SALIDA).reduce((s, f) => s + fs.statSync(path.join(SALIDA, f)).size, 0);
log('total', (total / 1024).toFixed(0), 'KB');
