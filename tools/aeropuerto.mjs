// Saca de OpenStreetMap el aeropuerto El Dorado (pistas, calles de rodaje, plataformas, terminales y torre) a
// datos/centro/aeropuerto.json, en metros del marco del simulador. Queda fuera de la caja de la zona Centro, por eso
// tiene su propia consulta. El crudo se guarda en tools/data/raw/ (fuera de git); bórralo para refrescarlo.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aMundo } from './zona.mjs';

const RAW = fileURLToPath(new URL('data/raw/', import.meta.url));
const CRUDO = path.join(RAW, 'osm_aeropuerto.json');
const SALIDA = fileURLToPath(new URL('../datos/centro/aeropuerto.json', import.meta.url));
const UA = 'simulador-bogota/0.1 (https://github.com/Imderf/simulator-bogota)';
const CAJA = '4.66,-74.20,4.74,-74.10'; // sur, oeste, norte, este
// Elevación oficial de El Dorado (AIP Colombia): 8.361 ft = 2.548 m.
const ELEVACION = 2548, BASE = 2606;
const log = (...a) => console.log('[aeropuerto]', ...a);
fs.mkdirSync(RAW, { recursive: true });

async function overpass(consulta) {
  const q = `[out:json][timeout:120];(${consulta.replaceAll('BBOX', CAJA)});out geom tags;`;
  for (const ep of ['https://overpass-api.de/api/interpreter', 'https://lz4.overpass-api.de/api/interpreter']) {
    for (let i = 1; i <= 3; i++) {
      try {
        const r = await fetch(ep, { method: 'POST', headers: { 'User-Agent': UA }, body: new URLSearchParams({ data: q }) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        if (!Array.isArray(d.elements)) throw new Error('respuesta sin elementos');
        return d;
      } catch (e) {
        log(ep, `intento ${i}:`, e.message);
        await new Promise((ok) => setTimeout(ok, i * 3000));
      }
    }
  }
  throw new Error('Overpass falló');
}

if (!fs.existsSync(CRUDO)) {
  const d = await overpass('way["aeroway"~"^(runway|taxiway|taxilane|apron|terminal|hangar|parking_position)$"](BBOX);' +
    'way["man_made"="tower"]["tower:type"~"airport|control"](BBOX);');
  fs.writeFileSync(CRUDO, JSON.stringify(d));
  log(d.elements.length, 'elementos bajados');
}

// Metros enteros: a 14 km de la cámara un metro no se nota y el archivo queda en pocos KB.
const punto = ({ lon, lat }) => aMundo(lon, lat).map(Math.round);
const linea = (geom) => {
  const p = geom.map(punto);
  return p.filter((q, i) => i === 0 || q[0] !== p[i - 1][0] || q[1] !== p[i - 1][1]);
};
const anillo = (geom) => {
  const p = linea(geom);
  if (p.length > 2 && p[0][0] === p.at(-1)[0] && p[0][1] === p.at(-1)[1]) p.pop();
  return p;
};
const altura = (t, defecto) => Math.round(parseFloat(t.height) || defecto);

// Puestos: la línea de entrada de OSM va de la calle de rodaje a la posición de parqueo.
const salida = { fuente: '© OpenStreetMap contributors, ODbL', y: ELEVACION - BASE, anchoRodaje: 23, pistas: [], rodaje: [], plataformas: [], terminales: [], hangares: [], puestos: [], torre: null };
for (const e of JSON.parse(fs.readFileSync(CRUDO, 'utf8')).elements) {
  const t = e.tags || {};
  if (!e.geometry) continue;
  if (t.man_made === 'tower') {
    const a = anillo(e.geometry);
    salida.torre = { p: [0, 1].map((k) => Math.round(a.reduce((s, q) => s + q[k], 0) / a.length)), alto: altura(t, 84) };
  } else if (t.aeroway === 'runway') salida.pistas.push({ ref: t.ref || '', ancho: Math.round(parseFloat(t.width) || 45), p: linea(e.geometry) });
  else if (t.aeroway === 'taxiway' || t.aeroway === 'taxilane') salida.rodaje.push(linea(e.geometry));
  else if (t.aeroway === 'apron') salida.plataformas.push(anillo(e.geometry));
  else if (t.aeroway === 'terminal') salida.terminales.push({ nombre: t.name || '', p: anillo(e.geometry) });
  else if (t.aeroway === 'hangar') salida.hangares.push(anillo(e.geometry));
  else if (t.aeroway === 'parking_position' && e.geometry.length > 1) salida.puestos.push({ ref: t.ref || '', p: linea(e.geometry) });
}
// Las pistas se guardan como un solo tramo de umbral a umbral (algunas vienen partidas en OSM).
salida.pistas = Object.values(Object.groupBy(salida.pistas, (p) => p.ref)).map((tramos) => {
  const todos = tramos.flatMap((p) => p.p);
  let [a, b, d] = [todos[0], todos[0], 0];
  for (const p of todos) for (const q of todos) { const dd = Math.hypot(p[0] - q[0], p[1] - q[1]); if (dd > d) [a, b, d] = [p, q, dd]; }
  return { ref: tramos[0].ref, ancho: tramos[0].ancho, p: [a, b] };
});
fs.writeFileSync(SALIDA, JSON.stringify(salida));
log(`${salida.pistas.map((p) => p.ref).join(', ')} · ${salida.rodaje.length} rodajes · ${salida.plataformas.length} plataformas · ` +
  `${salida.terminales.length} terminales · ${salida.hangares.length} hangares · ${salida.puestos.length} puestos · torre ${salida.torre ? 'sí' : 'no'} · ` +
  `${(fs.statSync(SALIDA).size / 1024).toFixed(1)} KB`);
