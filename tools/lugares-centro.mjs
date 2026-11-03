// Extrae de OpenStreetMap las plantas de los lugares emblemáticos de la zona Centro a datos/centro/lugares.json.
// Las medidas que no trae OSM están en js/lugares.js con su fuente (ver docs/lugares.md).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aMundo } from './zona.mjs';

const RAW = fileURLToPath(new URL('data/raw/', import.meta.url));
const SALIDA = fileURLToPath(new URL('../datos/centro/lugares.json', import.meta.url));
const UA = 'simulador-bogota/0.1 (https://github.com/Imderf/simulator-bogota)';

// id de OSM -> nombre interno
const VIAS = {
  24251969: 'catedral', 955123534: 'colpatria', 1175167439: 'bacataSur', 706225264: 'bacataBase',
  680409184: 'torreA', 24368650: 'torreB', 24368652: 'torreC', 24251993: 'planetario', 24518462: 'museoNacional',
  99625014: 'basilicaMonserrate', 99625009: 'estacionTelefericoArriba', 86499977: 'estacionFunicularArriba',
  58868758: 'estacionAbajo', 661594011: 'guadalupe', 537979334: 'avianca', 24457189: 'teatroColon',
  360392328: 'teleferico', 28555379: 'funicular1', 99625025: 'funicular2', 99625017: 'funicular3',
};
const RELACIONES = { 7445709: 'capitolio', 7445708: 'lievano', 9452213: 'justicia', 19012716: 'santamaria' };

const relaciones = path.join(RAW, 'osm_relaciones_lugares.json');
if (!fs.existsSync(relaciones)) {
  const q = `[out:json][timeout:60];rel(id:${Object.keys(RELACIONES).join(',')});out geom;`;
  const r = await fetch(process.env.OVERPASS || 'https://lz4.overpass-api.de/api/interpreter', { method: 'POST', headers: { 'User-Agent': UA }, body: new URLSearchParams({ data: q }) });
  if (!r.ok) throw new Error(`Overpass ${r.status}`);
  fs.writeFileSync(relaciones, await r.text());
}

const puntos = (geom) => {
  const p = geom.map(({ lon, lat }) => aMundo(lon, lat).map((v) => Math.round(v * 2) / 2));
  if (p.length > 2 && p[0][0] === p.at(-1)[0] && p[0][1] === p.at(-1)[1]) p.pop();
  return p;
};

// Une los tramos exteriores (o los interiores) de una relación en anillos cerrados.
function anillos(miembros, interior) {
  const tramos = miembros.filter((m) => m.type === 'way' && (m.role === 'inner') === interior && m.geometry).map((m) => m.geometry);
  const salida = [];
  while (tramos.length) {
    let anillo = tramos.shift().slice();
    let cambio = true;
    while (cambio) {
      cambio = false;
      for (let i = 0; i < tramos.length; i++) {
        const t = tramos[i], fin = anillo.at(-1);
        const igual = (a, b) => a.lat === b.lat && a.lon === b.lon;
        if (igual(t[0], fin)) anillo = anillo.concat(t.slice(1));
        else if (igual(t.at(-1), fin)) anillo = anillo.concat(t.slice(0, -1).reverse());
        else continue;
        tramos.splice(i, 1); cambio = true; break;
      }
    }
    salida.push(puntos(anillo));
  }
  return salida.sort((a, b) => b.length - a.length);
}

const lugares = {};
for (const e of JSON.parse(fs.readFileSync(path.join(RAW, 'osm_lugares.json'), 'utf8')).elements) {
  if (e.type === 'way' && VIAS[e.id]) lugares[VIAS[e.id]] = { osm: `way/${e.id}`, anillos: [puntos(e.geometry)] };
}
for (const e of JSON.parse(fs.readFileSync(relaciones, 'utf8')).elements) {
  if (RELACIONES[e.id]) lugares[RELACIONES[e.id]] = { osm: `relation/${e.id}`, anillos: anillos(e.members, false), huecos: anillos(e.members, true) };
}
const faltan = [...Object.values(VIAS), ...Object.values(RELACIONES)].filter((n) => !lugares[n]);
if (faltan.length) console.warn('[lugares] faltan:', faltan.join(', '));
fs.writeFileSync(SALIDA, JSON.stringify(lugares));
console.log('[lugares]', Object.keys(lugares).length, 'lugares,', (fs.statSync(SALIDA).size / 1024).toFixed(1), 'KB');
