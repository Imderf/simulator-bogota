// Baja los datos crudos de la zona piloto a tools/data/raw/ (fuera de git).
// Fuentes: Catastro Bogotá (Construcción), Jardín Botánico (Arbolado Urbano), OpenStreetMap (Overpass)
// y Copernicus DEM GLO-30. Si un archivo ya existe no se vuelve a bajar; bórralo para refrescarlo.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZONA } from './zona.mjs';

const RAW = fileURLToPath(new URL('data/raw/', import.meta.url));
fs.mkdirSync(RAW, { recursive: true });
const UA = 'simulador-bogota/0.1 (https://github.com/Imderf/simulator-bogota)';
const [W, S, E, N] = ZONA.caja;
const log = (...a) => console.log('[bajar]', ...a);

const existe = (f) => fs.existsSync(path.join(RAW, f)) && fs.statSync(path.join(RAW, f)).size > 100;
const guardar = (f, datos) => fs.writeFileSync(path.join(RAW, f), datos);

async function pedir(url, opciones = {}, intentos = 5) {
  for (let i = 1; i <= intentos; i++) {
    try {
      const r = await fetch(url, { ...opciones, headers: { 'User-Agent': UA, ...(opciones.headers || {}) } });
      if (r.ok) return r;
      log(`HTTP ${r.status} en intento ${i}`);
    } catch (e) {
      log(`error en intento ${i}: ${e.message}`);
    }
    await new Promise((ok) => setTimeout(ok, i * 3000));
  }
  throw new Error(`no se pudo bajar ${url}`);
}

// ArcGIS REST pagina de a 2.000 registros: se piden en paralelo por desplazamiento.
async function arcgis(archivo, servicio, campos) {
  if (existe(archivo)) return log(archivo, 'ya existe');
  const base = `${servicio}/query?where=1%3D1&geometry=${W},${S},${E},${N}&geometryType=esriGeometryEnvelope` +
    `&inSR=4326&spatialRel=esriSpatialRelIntersects&f=json`;
  const { count } = await (await pedir(`${base}&returnCountOnly=true`)).json();
  log(archivo, count, 'registros');
  const paginas = [];
  for (let o = 0; o < count; o += 2000) paginas.push(o);
  const resultado = [];
  for (let i = 0; i < paginas.length; i += 4) {
    const lote = await Promise.all(paginas.slice(i, i + 4).map(async (o) => {
      const url = `${base}&outFields=${campos}&outSR=4326&geometryPrecision=7&orderByFields=OBJECTID` +
        `&resultOffset=${o}&resultRecordCount=2000`;
      return (await (await pedir(url)).json()).features || [];
    }));
    for (const f of lote) resultado.push(...f);
    log(archivo, resultado.length, '/', count);
  }
  guardar(archivo, JSON.stringify(resultado));
}

async function overpass(archivo, consulta) {
  if (existe(archivo)) return log(archivo, 'ya existe');
  const q = `[out:json][timeout:180];${consulta.replaceAll('BBOX', `${S},${W},${N},${E}`)};out geom tags;`;
  for (const ep of ['https://overpass-api.de/api/interpreter', 'https://lz4.overpass-api.de/api/interpreter']) {
    try {
      const r = await pedir(ep, { method: 'POST', body: new URLSearchParams({ data: q }) }, 3);
      const d = await r.json();
      if (!Array.isArray(d.elements)) throw new Error('respuesta sin elementos');
      guardar(archivo, JSON.stringify(d));
      return log(archivo, d.elements.length, 'elementos');
    } catch (e) {
      log(ep, e.message);
    }
  }
  throw new Error(`Overpass falló para ${archivo}`);
}

async function copernicus() {
  // La zona cae entera en la celda N04 W075 (latitud 4 a 5, longitud -75 a -74).
  const archivo = 'copernicus_N04_W075.tif';
  if (existe(archivo)) return log(archivo, 'ya existe');
  const id = 'Copernicus_DSM_COG_10_N04_00_W075_00_DEM';
  const r = await pedir(`https://copernicus-dem-30m.s3.amazonaws.com/${id}/${id}.tif`);
  guardar(archivo, Buffer.from(await r.arrayBuffer()));
  log(archivo, 'listo');
}

await arcgis('construccion.json',
  'https://serviciosgis.catastrobogota.gov.co/arcgis/rest/services/catastro/construccion/MapServer/0',
  'OBJECTID,CONNPISOS,CONNSOTANO,LOTECODIGO');
await arcgis('arbolado.json',
  'https://geoportal.jbb.gov.co/agc/rest/services/IDECA/CensoArbol/FeatureServer/0',
  'OBJECTID,Nombre_Esp,Altura_Total,Tipo_Emplazamiento');
await overpass('osm_vias.json', 'way["highway"](BBOX)');
await overpass('osm_suelo.json',
  '(way["leisure"~"park|pitch|garden|stadium"](BBOX);way["landuse"~"grass|forest|meadow"](BBOX);way["natural"~"wood|scrub|grassland|water"](BBOX);way["waterway"](BBOX);way["amenity"="parking"](BBOX);)');
await overpass('osm_lugares.json',
  '(way["building"]["name"](BBOX);relation["building"]["name"](BBOX);way["place"="square"](BBOX);way["highway"="pedestrian"]["area"="yes"](BBOX);way["aerialway"](BBOX);way["railway"="funicular"](BBOX);)');
await copernicus();
log('todo listo en', RAW);
