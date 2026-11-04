// Minimapa tipo GPS abajo a la izquierda, con el norte arriba, y encima los letreros de la esquina más cercana.
// Con clic o la tecla M se abre el Atlas de Bogotá a pantalla completa: buscador, arrastrar, zoom y clic para ir.
// Adaptado de Slop New York (mrdoob, MIT): js/nyc-map.js (renderMinimap, renderFullMap, TiledLayer, drawWorld,
// drawRoadLabels, drawScaleBar), js/main.js (letreros de esquina y eventos del mapa) y css/style.css (radar y letreros).
import { ZONA, aMundo } from './marco.js';
import { anchoVia } from './vias.js';

const ESCALA = 0.32; // píxeles por metro a ras de suelo; se aleja al subir la cámara
const TESELA = 400; // m: las capas se parten en teselas para pintar solo las que se ven
const CELDA = 64; // m: rejilla para buscar las vías con nombre más cercanas
const RADIO_ESQUINA = 120; // m

// Grafito con las calles un tono más claro que las manzanas; parques y agua apagados; TransMilenio en rojo y las
// avenidas (troncales y principales, como casi todas las "Avenida ..." de OpenStreetMap) en ámbar.
const C = {
  fuera: '#0b1016',
  manzana: '#1b2027',
  // parque, bosque, agua, cancha, parqueadero, plaza
  suelo: ['#1a3021', '#172a1d', '#10263a', '#1f3a27', '#252a31', '#2f2d29'],
  edificios: ['#262c34', '#2f3641', '#3b4451'], // hasta 3 pisos, hasta 10, más altos
  // troncal, principal, secundaria, local, servicio, peatonal, ciclorruta, escalera, sendero, TransMilenio
  vias: ['#a8773a', '#86683f', '#4d5663', '#3f4854', '#373f4a', '#4b453b', '#5e3632', '#3b403b', '#343a31', '#a3382e'],
  ruta: '#f5c518',
  busqueda: '#5fd0ff',
  halo: 'rgba(8, 11, 15, 0.9)',
};
const ATLAS_MIN = 0.04, ATLAS_MAX = 4; // píxeles por metro: toda la zona en un celular … un solo predio
const ORDEN_SUELO = [0, 1, 3, 4, 5, 2]; // el mismo de texturaSuelo: el agua encima
const ORDEN_VIAS = [8, 7, 6, 4, 3, 5, 2, 1, 0, 9]; // lo menor abajo, TransMilenio encima
const MIN_PX = [2.4, 2, 1.5, 1.1, 0.9, 1.1, 1, 1, 1, 1.8]; // grosor mínimo para que no desaparezcan al alejarse
const FUENTE = 9.5;
const LETRA = 'system-ui, -apple-system, "Segoe UI", sans-serif';

// Calles y diagonales van de oriente a occidente; carreras y transversales, de sur a norte.
const tipo = (n) => (/^(Avenida )?(Calle|Diagonal)\b/.test(n) ? 'calle' : /^(Avenida )?(Carrera|Transversal)\b/.test(n) ? 'carrera' : 'otra');
const RANGO = { calle: 0, carrera: 1, otra: 2 };
// En el mapa, abreviaturas de la nomenclatura de Bogotá (Ac, Ak, Cl, Cra, Dg, Tv); en los letreros, el nombre entero.
const abreviar = (n) => n.replace(/^Avenida Calle\b/, 'Ac.').replace(/^Avenida Carrera\b/, 'Ak.').replace(/^Avenida\b/, 'Av.')
  .replace(/^Calle\b/, 'Cl.').replace(/^Carrera\b/, 'Cra.').replace(/^Diagonal\b/, 'Dg.').replace(/^Transversal\b/, 'Tv.');
// Para buscar: sin tildes ni signos, y las abreviaturas de las direcciones se escriben enteras ("cra 7" = "carrera 7").
const SINONIMOS = [[/\bak\b/g, 'avenida carrera'], [/\bac\b/g, 'avenida calle'], [/\b(cl|cll|cal)\b/g, 'calle'],
  [/\b(cra|cr|kr|kra|carr)\b/g, 'carrera'], [/\b(av|avda)\b/g, 'avenida'], [/\b(dg|diag)\b/g, 'diagonal'], [/\b(tv|transv)\b/g, 'transversal']];
const normalizar = (t) => SINONIMOS.reduce((s, [re, por]) => s.replace(re, por),
  t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[.,#-]/g, ' ').replace(/\s+/g, ' ').trim());
const escaparRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function cajaDe(p) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of p) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minZ, maxZ };
}
const toca = (a, v) => a.maxX >= v.minX && a.minX <= v.maxX && a.maxZ >= v.minZ && a.minZ <= v.maxZ;
const solapan = (cajas, b) => cajas.some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]);

// Capa vectorial partida en teselas de Path2D: cada figura va a la tesela de su centro y la caja de la tesela crece
// para cubrirla, así una vista solo pinta las teselas que toca. Los huecos van con su figura (patios).
class Teselas {
  constructor() { this.teselas = new Map(); }
  figura(anillos, cerrada) {
    const b = cajaDe(anillos[0]);
    const k = `${Math.floor((b.minX + b.maxX) / 2 / TESELA)},${Math.floor((b.minZ + b.maxZ) / 2 / TESELA)}`;
    let t = this.teselas.get(k);
    if (!t) this.teselas.set(k, (t = { camino: new Path2D(), ...b }));
    else {
      t.minX = Math.min(t.minX, b.minX); t.maxX = Math.max(t.maxX, b.maxX);
      t.minZ = Math.min(t.minZ, b.minZ); t.maxZ = Math.max(t.maxZ, b.maxZ);
    }
    for (const p of anillos) {
      t.camino.moveTo(p[0][0], p[0][1]);
      for (let i = 1; i < p.length; i++) t.camino.lineTo(p[i][0], p[i][1]);
      if (cerrada) t.camino.closePath();
    }
  }
  cada(v, f) { for (const t of this.teselas.values()) if (toca(t, v)) f(t.camino); }
}

// Anclas para el nombre: cada ~260 m de cada tramo recto, con el ángulo de la calle ahí y nunca de cabeza
// (los nombres verticales se leen hacia arriba). Fijas en el mundo, así no se deslizan al moverse.
function anclasDe(p) {
  const anclas = [];
  for (let i = 0; i + 1 < p.length;) {
    const a = p[i], dir = Math.atan2(p[i + 1][1] - a[1], p[i + 1][0] - a[0]);
    let j = i + 1;
    while (j + 1 < p.length) {
      let giro = Math.abs(Math.atan2(p[j + 1][1] - p[j][1], p[j + 1][0] - p[j][0]) - dir);
      if (giro > Math.PI) giro = 2 * Math.PI - giro;
      if (giro > 0.09) break;
      j++;
    }
    const b = p[j];
    i = j;
    const largo = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (largo < 20) continue;
    let ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    if (ang >= Math.PI / 2 - 0.01) ang -= Math.PI;
    else if (ang < -Math.PI / 2 - 0.01) ang += Math.PI;
    const n = Math.max(1, Math.round(largo / 260));
    for (let m = 0; m < n; m++) {
      const t = (m + 0.5) / n;
      anclas.push({ x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, ang, largo: largo / n });
    }
  }
  return anclas;
}

const ESTILO = `
.minimapa {
  position: fixed; left: 16px; bottom: max(16px, env(safe-area-inset-bottom));
  display: flex; flex-direction: column; align-items: flex-start; gap: 8px; pointer-events: none;
}
.minimapa-letreros { display: flex; flex-wrap: wrap; gap: 6px; max-width: 320px; }
.minimapa-letreros:empty { display: none; }
/* Placa de nomenclatura: blanca, letra negra y filete negro por dentro */
.minimapa-letrero {
  max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  padding: 7px 11px 6px; font: 700 14px/1.05 "Arial Narrow", "Helvetica Neue", Arial, sans-serif; letter-spacing: 0.01em;
  color: #111; background: #f7f6f2; border-radius: 4px; outline: 1.5px solid #111; outline-offset: -4px;
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.35), 0 10px 22px -10px rgba(0, 0, 0, 0.75);
}
.minimapa-mapa {
  position: relative; padding: 4px; border-radius: 14px;
  background: var(--fondo, rgba(14, 17, 22, 0.72)); border: 1px solid var(--borde, rgba(255, 255, 255, 0.12));
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  box-shadow: 0 12px 30px -14px rgba(0, 0, 0, 0.8);
  pointer-events: auto; cursor: pointer; transition: transform 0.3s ease, border-color 0.2s;
}
.minimapa-mapa:hover { transform: translateY(-2px); border-color: #f5c518; }
.minimapa-mapa::after {
  content: ''; position: absolute; inset: 4px; border-radius: 10px; pointer-events: none;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.05), inset 0 0 22px rgba(0, 0, 0, 0.55);
}
.minimapa-lienzo { display: block; width: 200px; height: 150px; border-radius: 10px; background: ${C.fuera}; }
.minimapa-norte {
  position: absolute; top: 9px; left: 50%; transform: translateX(-50%); width: 17px; height: 17px; border-radius: 50%;
  display: grid; place-items: center; font: 800 9px/1 ${LETRA}; color: #fff;
  background: rgba(10, 12, 15, 0.72); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.14);
}
/* Entre 620 y 980 px el reloj, los modos y la ayuda llegan a la esquina: el mapa sube por encima de ellos. */
@media (max-width: 980px) { .minimapa { bottom: calc(max(16px, env(safe-area-inset-bottom)) + 136px); } }
@media (max-width: 619.98px) { .minimapa { display: none; } }

/* Atlas de Bogotá: el mapa grande */
.minimapa-atlas {
  position: fixed; inset: 16px; z-index: 30; overflow: hidden; border-radius: 18px; color: #f2f0ea;
  font: 13px/1.3 ${LETRA}; background: ${C.fuera}; border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: 0 30px 80px -20px rgba(0, 0, 0, 0.85);
}
.minimapa-atlas[hidden] { display: none; }
.minimapa-atlas:focus { outline: none; }
.minimapa-atlas-lienzo { position: absolute; inset: 0; width: 100%; height: 100%; display: block; cursor: crosshair; touch-action: none; }
.minimapa-atlas-lienzo.arrastrando { cursor: grabbing; }
.minimapa-vidrio {
  background: rgba(14, 17, 22, 0.78); border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 12px;
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); box-shadow: 0 10px 26px -14px rgba(0, 0, 0, 0.8);
}
.minimapa-atlas-arriba { position: absolute; top: 14px; left: 14px; display: flex; flex-direction: column; gap: 8px; width: min(400px, calc(100% - 96px)); }
.minimapa-atlas-titulo { margin: 0; padding: 10px 14px; color: rgba(242, 240, 234, 0.75); }
.minimapa-atlas-titulo strong { font-size: 15px; color: #f2f0ea; }
.minimapa-atlas-buscar:focus-within { border-color: #f5c518; }
.minimapa-atlas-buscar input {
  width: 100%; padding: 10px 14px; font: inherit; font-size: 14px; color: inherit; background: none; border: 0; outline: none;
}
.minimapa-atlas-buscar input::placeholder { color: rgba(242, 240, 234, 0.5); }
.minimapa-atlas-resultados {
  list-style: none; margin: 0; padding: 4px; max-height: min(50vh, 360px); overflow-y: auto; border-top: 1px solid rgba(255, 255, 255, 0.08);
}
.minimapa-atlas-resultados:empty { display: none; }
.minimapa-atlas-resultados button {
  display: flex; justify-content: space-between; align-items: baseline; gap: 12px; width: 100%; padding: 8px 10px;
  font: inherit; text-align: left; color: inherit; background: none; border: 0; border-radius: 8px; cursor: pointer;
}
.minimapa-atlas-resultados button:hover, .minimapa-atlas-resultados button:focus-visible { background: rgba(245, 197, 24, 0.16); outline: none; }
.minimapa-atlas-resultados small { flex: none; color: rgba(242, 240, 234, 0.55); }
.minimapa-atlas-controles { position: absolute; top: 14px; right: 14px; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
.minimapa-atlas-boton {
  min-width: 40px; height: 40px; display: grid; place-items: center; padding: 0 12px; font: 600 18px/1 ${LETRA};
  color: inherit; cursor: pointer; transition: border-color 0.2s, color 0.2s;
}
.minimapa-atlas-boton:hover, .minimapa-atlas-boton:focus-visible { border-color: #f5c518; color: #f5c518; outline: none; }
.minimapa-atlas-cerrar { font-size: 13px; display: flex; gap: 8px; align-items: center; }
.minimapa-atlas-cerrar kbd { font: 600 10px/1 ${LETRA}; padding: 3px 5px; border-radius: 4px; background: rgba(255, 255, 255, 0.1); }
.minimapa-atlas-brujula { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; }
.minimapa-atlas-leyenda {
  position: absolute; right: 14px; bottom: 14px; margin: 0; padding: 9px 12px; list-style: none;
  display: flex; flex-direction: column; gap: 5px; font-size: 12px; pointer-events: none;
}
.minimapa-atlas-leyenda li { display: flex; align-items: center; gap: 8px; }
.minimapa-atlas-leyenda i { width: 18px; display: grid; place-items: center; }
.minimapa-atlas-leyenda .linea { height: 4px; border-radius: 2px; }
.minimapa-atlas-leyenda .punto { width: 9px; height: 9px; border-radius: 50%; background: #fff; box-shadow: 0 0 0 2px ${C.halo}; }
.minimapa-atlas-pista {
  position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%); padding: 8px 14px; white-space: nowrap;
  max-width: min(460px, calc(100% - 360px)); overflow: hidden; text-overflow: ellipsis; pointer-events: none;
}
.minimapa-atlas-pista b { color: #f5c518; font-weight: 600; }
@media (max-width: 719.98px) {
  .minimapa-atlas { inset: 0; border-radius: 0; border: 0; }
  .minimapa-atlas-leyenda { display: none; }
  .minimapa-atlas-pista { bottom: 52px; max-width: calc(100% - 28px); }
}
@media (prefers-reduced-motion: reduce) { .minimapa-mapa, .minimapa-atlas-boton { transition: none; } }
`;

const nuevo = (etiqueta, clase, padre) => {
  const e = document.createElement(etiqueta);
  e.className = clase;
  padre.appendChild(e);
  return e;
};

// lugares: [{ nombre, nota, x, z }] del tour; alIr(x, z): lo que pasa al hacer clic en un punto del atlas.
export async function crearMinimapa({ contenedor, vias, edificios, suelo, datos = './datos/centro/', lugares = [], alIr = null }) {
  // Los nombres vienen aparte (ver tools/construir-centro.mjs); sin ellos el mapa sale igual, sin nombres ni letreros.
  let nombreDe = [];
  try {
    const r = await fetch(datos + 'nombres-vias.json');
    if (!r.ok) throw new Error(r.status);
    const j = await r.json();
    if (j.via.length === vias.length) nombreDe = j.via.map((i) => j.nombres[i]);
    else console.warn('minimapa: nombres-vias.json no corresponde a vias.bin.gz; rehacer con tools/construir-centro.mjs vias');
  } catch (e) {
    console.warn('minimapa: sin nombres de calles', e);
  }

  if (!document.getElementById('minimapa-estilo')) {
    const estilo = nuevo('style', '', document.head);
    estilo.id = 'minimapa-estilo';
    estilo.textContent = ESTILO;
  }
  const raiz = nuevo('div', 'minimapa', contenedor);
  const elLetreros = nuevo('div', 'minimapa-letreros', raiz);
  const marco = nuevo('div', 'minimapa-mapa', raiz);
  const lienzo = nuevo('canvas', 'minimapa-lienzo', marco);
  lienzo.setAttribute('role', 'img');
  lienzo.setAttribute('aria-label', 'Minimapa con el norte arriba. Clic o tecla M para abrir el Atlas de Bogotá');
  marco.title = 'Abrir el Atlas de Bogotá (M)';
  nuevo('span', 'minimapa-norte', marco).textContent = 'N';
  // Con la vista limpia el minimapa queda transparente pero en su sitio: ahí no debe abrir el atlas.
  marco.addEventListener('click', () => { if (getComputedStyle(contenedor).opacity !== '0') abrir(); });
  const ctx = lienzo.getContext('2d');

  // Capas del fondo. Todo se arma una vez; al redibujar solo se pintan las teselas que se ven.
  const [zx0, zz0] = aMundo(ZONA.caja[0], ZONA.caja[3]), [zx1, zz1] = aMundo(ZONA.caja[2], ZONA.caja[1]);
  const capasSuelo = C.suelo.map(() => new Teselas());
  for (const { clase, p } of suelo) capasSuelo[clase]?.figura([p], true);
  const capasEdificios = C.edificios.map(() => new Teselas());
  for (const e of edificios) capasEdificios[e.pisos <= 3 ? 0 : e.pisos <= 10 ? 1 : 2].figura(e.anillos, true);
  // Vías por tono y ancho real: un trazo por grupo y tesela. Ciclorrutas, escaleras y senderos van como hilos.
  const grupos = new Map();
  for (const v of vias) {
    const tono = v.bus ? 9 : v.clase, ancho = tono >= 6 && tono <= 8 ? 0 : Math.round(anchoVia(v));
    const k = tono * 1000 + ancho;
    if (!grupos.has(k)) grupos.set(k, { tono, ancho, capa: new Teselas() });
    grupos.get(k).capa.figura([v.p], false);
  }
  const capasVias = [...grupos.values()].sort((a, b) => ORDEN_VIAS.indexOf(a.tono) - ORDEN_VIAS.indexOf(b.tono) || a.ancho - b.ancho);

  // Nombres en el mapa y rejilla de tramos con nombre para los letreros (solo vías de la calzada para arriba).
  const etiquetas = [], celdas = new Map(), viasPorNombre = new Map();
  vias.forEach((v, k) => {
    const n = nombreDe[k];
    if (!n || v.clase > 5) return;
    const anclas = anclasDe(v.p);
    if (anclas.length) etiquetas.push({ texto: abreviar(n), troncal: v.clase === 0, mayor: v.clase <= 1, anclas, ...cajaDe(v.p) });
    if (v.bus) return; // en OpenStreetMap los carriles se llaman "TransMilenio": no es nombre de esquina ni de búsqueda
    if (!viasPorNombre.has(n)) viasPorNombre.set(n, []);
    viasPorNombre.get(n).push(v);
    for (let i = 0; i < v.p.length - 1; i++) {
      const [ax, az] = v.p[i], [bx, bz] = v.p[i + 1], s = { ax, az, bx, bz, n };
      for (let ix = Math.floor(Math.min(ax, bx) / CELDA); ix <= Math.floor(Math.max(ax, bx) / CELDA); ix++) {
        for (let iz = Math.floor(Math.min(az, bz) / CELDA); iz <= Math.floor(Math.max(az, bz) / CELDA); iz++) {
          const c = `${ix},${iz}`;
          if (!celdas.has(c)) celdas.set(c, []);
          celdas.get(c).push(s);
        }
      }
    }
  });
  const anchos = new Map();
  const medir = (c, texto) => {
    const k = c.font + texto; // el ancho depende de la fuente
    if (!anchos.has(k)) anchos.set(k, c.measureText(texto).width);
    return anchos.get(k);
  };

  // Nombres a lo largo de las calles (en píxeles desde el centro de la vista v): la mejor ancla de cada calle donde
  // quepa su nombre, uno por calle cada `separacion` px, sin pisarse entre sí ni con las cajas ya `puestas`.
  function pintarNombres(c, v, { fuente = FUENTE, maximo = 28, separacion = 180, soloMayores = false, puestas = [] } = {}) {
    c.font = `600 ${fuente}px ${LETRA}`;
    const m = (fuente * 2.5) / v.s;
    const dentro = { minX: v.minX + m, maxX: v.maxX - m, minZ: v.minZ + m, maxZ: v.maxZ - m };
    const candidatas = [];
    for (const e of etiquetas) {
      if (!toca(e, dentro) || (soloMayores && !e.mayor)) continue;
      const ancho = medir(c, e.texto), necesita = (ancho + 14) / v.s;
      for (const a of e.anclas) {
        if (a.largo < necesita || a.x < dentro.minX || a.x > dentro.maxX || a.z < dentro.minZ || a.z > dentro.maxZ) continue;
        const d = Math.hypot(a.x - v.cx, a.z - v.cz) * v.s;
        candidatas.push({ e, a, ancho, puntaje: (e.troncal ? 3000 : 0) + (e.mayor ? 2000 : 0) + Math.min(a.largo * v.s, 400) - d * 0.5 });
      }
    }
    candidatas.sort((a, b) => b.puntaje - a.puntaje);
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.lineJoin = 'round';
    c.lineWidth = 3;
    c.strokeStyle = C.halo;
    const porNombre = new Map();
    let n = 0;
    for (const { e, a, ancho } of candidatas) {
      if (n >= maximo) break;
      const X = (a.x - v.cx) * v.s, Y = (a.z - v.cz) * v.s;
      const mismas = porNombre.get(e.texto);
      if (mismas && mismas.some(([x, y]) => Math.hypot(x - X, y - Y) < separacion)) continue;
      const hw = ancho / 2 + 3, hh = fuente / 2 + 2, ca = Math.abs(Math.cos(a.ang)), sa = Math.abs(Math.sin(a.ang));
      const bx = hw * ca + hh * sa, by = hw * sa + hh * ca, caja = [X - bx, Y - by, X + bx, Y + by];
      if (solapan(puestas, caja)) continue;
      puestas.push(caja);
      if (mismas) mismas.push([X, Y]);
      else porNombre.set(e.texto, [[X, Y]]);
      c.save();
      c.translate(X, Y);
      c.rotate(a.ang);
      c.fillStyle = e.troncal ? '#e3a857' : e.mayor ? '#e8ebf0' : '#9ba5b3';
      c.strokeText(e.texto, 0, 0);
      c.fillText(e.texto, 0, 0);
      c.restore();
      n++;
    }
  }

  // El fondo (capas y nombres) se pinta en un lienzo aparte del doble del mapa y solo se rehace cuando el jugador
  // se acerca a su borde o el zoom cambia; cada cuadro es un drawImage más la flecha.
  const fondo = { lienzo: document.createElement('canvas'), s: 0, cx: 0, cz: 0 };
  const cf = fondo.lienzo.getContext('2d');
  // Vista de w × h píxeles CSS centrada en (cx, cz) a s píxeles por metro.
  const vista = (cx, cz, s, w, h) => ({ cx, cz, s, w, h, minX: cx - w / 2 / s, maxX: cx + w / 2 / s, minZ: cz - h / 2 / s, maxZ: cz + h / 2 / s });

  // El suelo de la ciudad en el lienzo c (sin nombres). Al terminar deja el lienzo en píxeles desde el centro.
  function pintarMundo(c, v, dpr, resaltado = null) {
    const { cx, cz, s } = v, px = (n) => n / s; // píxeles de pantalla a metros
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = C.fuera;
    c.fillRect(0, 0, c.canvas.width, c.canvas.height);
    c.setTransform(s * dpr, 0, 0, s * dpr, dpr * (v.w / 2 - cx * s), dpr * (v.h / 2 - cz * s));
    c.lineJoin = c.lineCap = 'round';
    // Manzanas implícitas: la zona con datos va en tono de manzana y las vías, más claras, se pintan encima.
    c.fillStyle = C.manzana;
    c.fillRect(zx0, zz0, zx1 - zx0, zz1 - zz0);
    for (const i of ORDEN_SUELO) {
      c.fillStyle = C.suelo[i];
      capasSuelo[i].cada(v, (p) => c.fill(p));
    }
    // De lejos los edificios serían polvo y costarían decenas de miles de polígonos por redibujo.
    if (s >= 0.14) {
      capasEdificios.forEach((capa, i) => {
        c.fillStyle = C.edificios[i];
        capa.cada(v, (p) => c.fill(p, 'evenodd'));
      });
    }
    for (const g of capasVias) {
      if (!g.ancho && s < 0.2) continue; // los hilos solo de cerca
      c.strokeStyle = C.vias[g.tono];
      c.lineWidth = Math.max(g.ancho, px(MIN_PX[g.tono]));
      g.capa.cada(v, (p) => c.stroke(p));
    }
    if (resaltado) {
      c.strokeStyle = C.busqueda;
      c.lineWidth = Math.max(px(3), 9);
      c.stroke(resaltado);
    }
    c.setTransform(dpr, 0, 0, dpr, (dpr * v.w) / 2, (dpr * v.h) / 2);
  }

  // Fondo del minimapa: el doble de su tamaño, para poder moverse un rato sin redibujar.
  function redibujar(cx, cz, s, w, h, dpr) {
    fondo.lienzo.width = Math.round(w * 2 * dpr);
    fondo.lienzo.height = Math.round(h * 2 * dpr);
    Object.assign(fondo, { cx, cz, s });
    const v = vista(cx, cz, s, w * 2, h * 2);
    pintarMundo(cf, v, dpr);
    pintarNombres(cf, v);
  }

  // Letreros: las dos vías con nombre más cercanas; si la primera es calle, la otra carrera (y al revés).
  function esquina(x, z) {
    const cerca = new Map();
    for (let ix = Math.floor((x - RADIO_ESQUINA) / CELDA); ix <= Math.floor((x + RADIO_ESQUINA) / CELDA); ix++) {
      for (let iz = Math.floor((z - RADIO_ESQUINA) / CELDA); iz <= Math.floor((z + RADIO_ESQUINA) / CELDA); iz++) {
        for (const s of celdas.get(`${ix},${iz}`) || []) {
          const dx = s.bx - s.ax, dz = s.bz - s.az, l2 = dx * dx + dz * dz || 1;
          const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / l2));
          const d = Math.hypot(s.ax + dx * t - x, s.az + dz * t - z);
          if (d <= RADIO_ESQUINA && !(cerca.get(s.n) <= d)) cerca.set(s.n, d);
        }
      }
    }
    const orden = [...cerca].sort((a, b) => a[1] - b[1]).map(([n]) => n);
    if (!orden.length) return [];
    const primera = orden[0], t = tipo(primera), otro = t === 'calle' ? 'carrera' : t === 'carrera' ? 'calle' : null;
    const segunda = orden.find((n) => n !== primera && (otro ? tipo(n) === otro : tipo(n) !== 'otra')) ?? orden[1];
    return [primera, segunda].filter(Boolean).sort((a, b) => RANGO[tipo(a)] - RANGO[tipo(b)]);
  }
  let ultimo = null, textoLetreros = '', aqui = [];
  function letreros(x, z) {
    if (ultimo && Math.hypot(x - ultimo[0], z - ultimo[1]) < 4) return;
    ultimo = [x, z];
    aqui = esquina(x, z);
    const texto = aqui.join('|');
    if (texto === textoLetreros) return;
    textoLetreros = texto;
    elLetreros.replaceChildren();
    for (const n of aqui) nuevo('span', 'minimapa-letrero', elLetreros).textContent = n;
  }

  // Ruta en línea recta, en píxeles: amarillo sobre halo oscuro, con la marca del destino al final.
  function pintarRuta(c, x0, y0, x1, y1, ancho, radio) {
    c.lineJoin = c.lineCap = 'round';
    c.beginPath();
    c.moveTo(x0, y0);
    c.lineTo(x1, y1);
    c.strokeStyle = C.halo;
    c.lineWidth = ancho + 3;
    c.stroke();
    c.strokeStyle = C.ruta;
    c.lineWidth = ancho;
    c.stroke();
    for (const [r, color] of [[radio + 2, C.halo], [radio, C.ruta], [radio * 0.38, C.halo]]) {
      c.fillStyle = color;
      c.beginPath();
      c.arc(x1, y1, r, 0, Math.PI * 2);
      c.fill();
    }
  }
  // Flecha del jugador en el origen actual, dibujada hacia el norte y girada a su rumbo.
  function pintarFlecha(c, rumbo, k = 1) {
    c.save();
    c.rotate(-rumbo);
    c.scale(k, k);
    c.beginPath();
    c.moveTo(0, -9);
    c.lineTo(6.5, 7);
    c.lineTo(0, 3.2);
    c.lineTo(-6.5, 7);
    c.closePath();
    c.lineJoin = 'round';
    c.strokeStyle = C.halo;
    c.lineWidth = 3;
    c.stroke();
    c.fillStyle = '#ffffff';
    c.fill();
    c.restore();
  }
  function pintarLugar(c, x, y, r) {
    c.fillStyle = C.halo;
    c.beginPath();
    c.arc(x, y, r + 2.3, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#ffffff';
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
  }

  const cono = ctx.createRadialGradient(0, 0, 2, 0, 0, 52);
  cono.addColorStop(0, 'rgba(255, 255, 255, 0.3)');
  cono.addColorStop(1, 'rgba(255, 255, 255, 0)');
  let escala = 0, meta = null, visible = true;
  const jugador = { x: 0, z: 0, rumbo: 0 };

  // rumbo y rumboCamara con la convención de jugador.js: se avanza hacia (-sin r, -cos r); 0 = norte.
  // alto: altura de la cámara sobre el suelo, en metros (aleja el mapa en el helicóptero).
  function actualizar(x, z, rumbo = 0, rumboCamara = rumbo, alto = 0) {
    Object.assign(jugador, { x, z, rumbo });
    letreros(x, z);
    if (!visible || abierto) return; // con el atlas abierto el minimapa no se ve
    const w = lienzo.clientWidth, h = lienzo.clientHeight;
    if (!w || !h) return; // oculto por CSS en pantallas angostas
    const dpr = Math.min(window.devicePixelRatio || 1, 2), bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    if (lienzo.width !== bw || lienzo.height !== bh) {
      lienzo.width = bw;
      lienzo.height = bh;
      fondo.s = 0;
    }
    const objetivo = Math.max(0.03, ESCALA / (1 + Math.max(0, alto - 25) / 180));
    escala = escala ? escala + (objetivo - escala) * 0.08 : objetivo;
    if (!fondo.s || Math.abs(escala / fondo.s - 1) > 0.12 ||
      Math.abs(x - fondo.cx) > w / fondo.s - w / (2 * escala) - 8 / escala ||
      Math.abs(z - fondo.cz) > h / fondo.s - h / (2 * escala) - 8 / escala) redibujar(x, z, escala, w, h, dpr);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = C.fuera;
    ctx.fillRect(0, 0, bw, bh);
    const k = escala / fondo.s;
    ctx.drawImage(fondo.lienzo, dpr * ((fondo.cx - w / fondo.s - x) * escala + w / 2), dpr * ((fondo.cz - h / fondo.s - z) * escala + h / 2),
      dpr * w * 2 * k, dpr * h * 2 * k);
    ctx.setTransform(dpr, 0, 0, dpr, (dpr * w) / 2, (dpr * h) / 2);

    // Ruta en línea recta al destino; si queda fuera del mapa, la marca se queda en el borde, en su dirección.
    if (meta) {
      const dx = (meta.x - x) * escala, dy = (meta.z - z) * escala;
      const t = Math.min(1, (w / 2 - 9) / (Math.abs(dx) || 1e-9), (h / 2 - 9) / (Math.abs(dy) || 1e-9));
      pintarRuta(ctx, 0, 0, dx * t, dy * t, 3, 4.5);
    }
    for (const l of lugares) {
      const lx = (l.x - x) * escala, ly = (l.z - z) * escala;
      if (Math.abs(lx) < w * 0.48 && Math.abs(ly) < h * 0.48) pintarLugar(ctx, lx, ly, 2.8);
    }
    // Cono de lo que mira la cámara (dibujado hacia el norte y girado) y flecha del jugador.
    ctx.save();
    ctx.rotate(-rumboCamara);
    ctx.fillStyle = cono;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, 52, -Math.PI * 0.72, -Math.PI * 0.28);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    pintarFlecha(ctx, rumbo);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Atlas de Bogotá: el mapa grande. Se pinta con su propio requestAnimationFrame mientras está abierto; el suelo,
  // los nombres y los lugares van a un lienzo aparte que solo se rehace cuando cambia la vista o la búsqueda.
  // ---------------------------------------------------------------------------------------------------------------
  const atlas = nuevo('div', 'minimapa-atlas', document.body);
  atlas.hidden = true;
  atlas.tabIndex = -1;
  atlas.setAttribute('role', 'dialog');
  atlas.setAttribute('aria-modal', 'true');
  atlas.setAttribute('aria-label', 'Atlas de Bogotá');
  const lienzoA = nuevo('canvas', 'minimapa-atlas-lienzo', atlas), ctxA = lienzoA.getContext('2d');
  const estatico = document.createElement('canvas'), ctxE = estatico.getContext('2d');
  const arriba = nuevo('div', 'minimapa-atlas-arriba', atlas);
  const titulo = nuevo('p', 'minimapa-atlas-titulo minimapa-vidrio', arriba);
  nuevo('strong', '', titulo).textContent = 'Atlas de Bogotá';
  const dondeEstas = nuevo('span', '', titulo);
  const cajaBuscar = nuevo('div', 'minimapa-atlas-buscar minimapa-vidrio', arriba);
  const buscador = nuevo('input', '', cajaBuscar);
  Object.assign(buscador, { type: 'search', placeholder: 'Buscar calle o lugar: Cra 7, Cl 26, Museo del Oro', autocomplete: 'off', spellcheck: false });
  buscador.setAttribute('aria-label', 'Buscar calle o lugar');
  const resultados = nuevo('ul', 'minimapa-atlas-resultados', cajaBuscar);
  const controlesA = nuevo('div', 'minimapa-atlas-controles', atlas);
  const boton = (clase, html, etiqueta, accion) => {
    const b = nuevo('button', `minimapa-atlas-boton minimapa-vidrio ${clase}`, controlesA);
    b.type = 'button';
    b.innerHTML = html;
    b.title = etiqueta;
    b.setAttribute('aria-label', etiqueta);
    b.addEventListener('click', accion);
    return b;
  };
  boton('minimapa-atlas-cerrar', 'Cerrar <kbd>Esc</kbd>', 'Cerrar el atlas (Esc)', () => cerrar());
  boton('', '+', 'Acercar (+)', () => acercar(1.6));
  boton('', '−', 'Alejar (−)', () => acercar(1 / 1.6));
  boton('', '<svg width="18" height="18" viewBox="-9 -9 18 18" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">' +
    '<circle r="5.5"/><circle r="1.6" fill="currentColor"/><path d="M0-9v3M0 6v3M-9 0h3M6 0h3"/></svg>', 'Centrar en ti', () => centrarEn(jugador.x, jugador.z));
  // El atlas siempre va con el norte arriba: la brújula solo lo recuerda.
  const brujula = nuevo('div', 'minimapa-atlas-brujula minimapa-vidrio', controlesA);
  brujula.setAttribute('role', 'img');
  brujula.setAttribute('aria-label', 'Brújula: el norte está arriba');
  brujula.innerHTML = '<svg width="30" height="30" viewBox="-15 -15 30 30" aria-hidden="true">' +
    '<text y="-7" text-anchor="middle" font-size="8" font-weight="800" fill="#fff" font-family="system-ui, sans-serif">N</text>' +
    `<path d="M0-5 3.5 4.5H-3.5Z" fill="${C.ruta}"/><path d="M0 13 3.5 4.5H-3.5Z" fill="rgba(242, 240, 234, 0.4)"/></svg>`;
  const leyenda = nuevo('ul', 'minimapa-atlas-leyenda minimapa-vidrio', atlas);
  const linea = (color) => `<span class="linea" style="width: 18px; background: ${color}"></span>`;
  leyenda.innerHTML = [
    [`<svg width="13" height="15" viewBox="-8 -11 16 19"><path d="M0-9 6.5 7 0 3.2-6.5 7Z" fill="#fff" stroke="${C.halo}" stroke-width="2"/></svg>`, 'Tú'],
    ['<span class="punto"></span>', 'Lugar'],
    [linea(C.ruta), 'Ruta GPS'],
    [linea(C.vias[9]), 'TransMilenio'],
    [linea(C.vias[0]), 'Avenida'],
  ].map(([icono, texto]) => `<li><i aria-hidden="true">${icono}</i>${texto}</li>`).join('');
  const elPista = nuevo('div', 'minimapa-atlas-pista minimapa-vidrio', atlas);

  let abierto = false, cuadro = 0, claveEstatico = '', arrastre = null, resaltado = null, nombreResaltado = '';
  const vistaA = { cx: 0, cz: 0, s: 0.6 };
  const limitar = (s) => Math.min(ATLAS_MAX, Math.max(ATLAS_MIN, s));
  // La vista no se sale de la zona con datos.
  function encuadrar() {
    vistaA.cx = Math.min(zx1, Math.max(zx0, vistaA.cx));
    vistaA.cz = Math.min(zz1, Math.max(zz0, vistaA.cz));
  }
  // Acerca o aleja dejando quieto el punto bajo (mx, my), en píxeles desde el centro.
  function acercar(f, mx = 0, my = 0) {
    const s1 = limitar(vistaA.s * f);
    vistaA.cx += mx / vistaA.s - mx / s1;
    vistaA.cz += my / vistaA.s - my / s1;
    vistaA.s = s1;
    encuadrar();
  }
  function centrarEn(x, z, s = vistaA.s) {
    Object.assign(vistaA, { cx: x, cz: z, s: limitar(s) });
    encuadrar();
  }

  function abrir() {
    if (abierto) return;
    abierto = true;
    centrarEn(jugador.x, jugador.z);
    atlas.hidden = false;
    pista();
    atlas.focus();
    cuadro = requestAnimationFrame(bucle);
  }
  function cerrar() {
    if (!abierto) return;
    abierto = false;
    arrastre = null;
    cancelAnimationFrame(cuadro);
    atlas.hidden = true;
    resultados.replaceChildren();
    // Libera la memoria de los dos lienzos a pantalla completa.
    lienzoA.width = lienzoA.height = estatico.width = estatico.height = 0;
    claveEstatico = '';
    if (atlas.contains(document.activeElement)) document.activeElement.blur();
  }
  function bucle() {
    if (!abierto) return;
    pintarAtlas();
    cuadro = requestAnimationFrame(bucle);
  }

  // Barra de escala en metros redondos (1, 2, 5 × 10ⁿ) de unos 120 px.
  function pintarEscala(c, v) {
    const objetivo = 120 / v.s, pot = 10 ** Math.floor(Math.log10(objetivo));
    const paso = [1, 2, 5, 10].map((m) => m * pot).filter((m) => m <= objetivo).pop() || pot;
    const largo = paso * v.s, x0 = -v.w / 2 + 24, y0 = v.h / 2 - 26, texto = paso >= 1000 ? `${paso / 1000} km` : `${paso} m`;
    c.lineJoin = c.lineCap = 'round';
    c.beginPath();
    c.moveTo(x0, y0 - 6);
    c.lineTo(x0, y0);
    c.lineTo(x0 + largo, y0);
    c.lineTo(x0 + largo, y0 - 6);
    c.strokeStyle = C.halo;
    c.lineWidth = 5;
    c.stroke();
    c.strokeStyle = 'rgba(236, 239, 244, 0.92)';
    c.lineWidth = 2;
    c.stroke();
    c.font = `650 11px ${LETRA}`;
    c.textAlign = 'left';
    c.textBaseline = 'alphabetic';
    c.lineWidth = 3;
    c.strokeStyle = C.halo;
    c.strokeText(texto, x0 + largo + 8, y0 + 3);
    c.fillStyle = 'rgba(236, 239, 244, 0.95)';
    c.fillText(texto, x0 + largo + 8, y0 + 3);
  }

  function pintarEstatico(v, dpr) {
    pintarMundo(ctxE, v, dpr, resaltado);
    // Los lugares van primero: sus cajas apartan los nombres de las calles.
    ctxE.font = `700 11px ${LETRA}`;
    const puestas = [], pines = [];
    for (const l of lugares) {
      const lx = (l.x - v.cx) * v.s, ly = (l.z - v.cz) * v.s;
      if (Math.abs(lx) > v.w * 0.48 || Math.abs(ly) > v.h * 0.48) continue;
      const caja = [lx + 6, ly - 8, lx + 14 + medir(ctxE, l.nombre), ly + 7], conNombre = !solapan(puestas, caja);
      puestas.push([lx - 6, ly - 6, lx + 6, ly + 6]);
      if (conNombre) puestas.push(caja);
      pines.push({ l, lx, ly, conNombre });
    }
    const fuente = Math.max(9, Math.min(12, Math.round(9.5 * Math.sqrt(Math.max(v.s, 0.4)))));
    pintarNombres(ctxE, v, { fuente, maximo: 420, separacion: 300, soloMayores: v.s < 0.3, puestas });
    ctxE.font = `700 11px ${LETRA}`;
    ctxE.textAlign = 'left';
    ctxE.textBaseline = 'alphabetic';
    for (const { l, lx, ly, conNombre } of pines) {
      pintarLugar(ctxE, lx, ly, 4.2);
      if (!conNombre) continue;
      ctxE.lineWidth = 3;
      ctxE.strokeStyle = C.halo;
      ctxE.strokeText(l.nombre, lx + 9, ly + 4);
      ctxE.fillStyle = '#ffffff';
      ctxE.fillText(l.nombre, lx + 9, ly + 4);
    }
    pintarEscala(ctxE, v);
  }

  function pintarAtlas() {
    const w = lienzoA.clientWidth, h = lienzoA.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2), bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    if (lienzoA.width !== bw || lienzoA.height !== bh) {
      lienzoA.width = estatico.width = bw;
      lienzoA.height = estatico.height = bh;
      claveEstatico = '';
    }
    const v = vista(vistaA.cx, vistaA.cz, vistaA.s, w, h);
    const clave = `${v.cx}|${v.cz}|${v.s}|${bw}|${bh}|${nombreResaltado}`;
    if (clave !== claveEstatico) {
      claveEstatico = clave;
      pintarEstatico(v, dpr);
    }
    const donde = ` · ${aqui.length ? `Estás en ${aqui.join(' con ')}` : 'Zona Centro'}`;
    if (dondeEstas.textContent !== donde) dondeEstas.textContent = donde;

    ctxA.setTransform(1, 0, 0, 1, 0, 0);
    ctxA.drawImage(estatico, 0, 0);
    ctxA.setTransform(dpr, 0, 0, dpr, (dpr * w) / 2, (dpr * h) / 2);
    const jx = (jugador.x - v.cx) * v.s, jy = (jugador.z - v.cz) * v.s;
    if (meta) pintarRuta(ctxA, jx, jy, (meta.x - v.cx) * v.s, (meta.z - v.cz) * v.s, 4, 7);
    // Tú: con un pulso lento para encontrarte de un vistazo.
    const pulso = (performance.now() % 1800) / 1800;
    ctxA.save();
    ctxA.translate(jx, jy);
    ctxA.fillStyle = `rgba(245, 197, 24, ${0.3 * (1 - pulso)})`;
    ctxA.beginPath();
    ctxA.arc(0, 0, 10 + pulso * 20, 0, Math.PI * 2);
    ctxA.fill();
    ctxA.fillStyle = 'rgba(255, 255, 255, 0.12)';
    ctxA.beginPath();
    ctxA.arc(0, 0, 13, 0, Math.PI * 2);
    ctxA.fill();
    pintarFlecha(ctxA, jugador.rumbo, 1.2);
    ctxA.restore();
  }

  // Qué hay bajo el cursor (en píxeles desde el centro): un lugar del tour a menos de 12 px, o el punto con sus
  // dos calles; null fuera de la zona con datos.
  function bajo(mx, my) {
    for (const l of lugares) {
      if (Math.hypot((l.x - vistaA.cx) * vistaA.s - mx, (l.z - vistaA.cz) * vistaA.s - my) < 12) return { x: l.x, z: l.z, texto: l.nombre };
    }
    const x = vistaA.cx + mx / vistaA.s, z = vistaA.cz + my / vistaA.s;
    if (x < zx0 || x > zx1 || z < zz0 || z > zz1) return null;
    return { x, z, texto: esquina(x, z).join(' con ') };
  }
  function pista(punto) {
    elPista.replaceChildren();
    if (punto === undefined) elPista.textContent = 'Arrastra para mover · Rueda para acercar · Clic para ir';
    else if (!punto) elPista.textContent = 'Fuera de la zona Centro';
    else {
      if (punto.texto) elPista.append(`${punto.texto} · `);
      nuevo('b', '', elPista).textContent = 'Clic para ir aquí';
    }
  }
  const enLienzo = (e) => {
    const r = lienzoA.getBoundingClientRect();
    return [e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2];
  };
  lienzoA.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    arrastre = { x: e.clientX, y: e.clientY, cx: vistaA.cx, cz: vistaA.cz, movio: false };
    lienzoA.setPointerCapture(e.pointerId);
  });
  lienzoA.addEventListener('pointermove', (e) => {
    if (!arrastre) return pista(bajo(...enLienzo(e)));
    const dx = e.clientX - arrastre.x, dy = e.clientY - arrastre.y;
    if (!arrastre.movio && Math.hypot(dx, dy) < 5) return; // un clic con pulso tembloroso sigue siendo clic
    arrastre.movio = true;
    lienzoA.classList.add('arrastrando');
    vistaA.cx = arrastre.cx - dx / vistaA.s;
    vistaA.cz = arrastre.cz - dy / vistaA.s;
    encuadrar();
  });
  lienzoA.addEventListener('pointerup', (e) => {
    const a = arrastre;
    arrastre = null;
    lienzoA.classList.remove('arrastrando');
    if (!a || a.movio) return;
    const punto = bajo(...enLienzo(e));
    if (!punto) return;
    alIr?.(punto.x, punto.z);
    cerrar();
  });
  lienzoA.addEventListener('pointercancel', () => { arrastre = null; lienzoA.classList.remove('arrastrando'); });
  lienzoA.addEventListener('pointerleave', () => { if (!arrastre) pista(); });
  lienzoA.addEventListener('wheel', (e) => {
    e.preventDefault();
    acercar(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 16 : 1) * 0.0015), ...enLienzo(e));
  }, { passive: false });

  // Buscador: calles (sin los carriles de TransMilenio) y lugares del tour.
  const indice = [
    ...[...viasPorNombre.keys()].map((n) => ({ texto: n, sub: 'Vía', clave: normalizar(n), calle: n })),
    ...lugares.map((l) => ({ texto: l.nombre, sub: 'Lugar', clave: normalizar(`${l.nombre} ${l.nota || ''}`), lugar: l })),
  ];
  function buscar(texto) {
    const q = normalizar(texto);
    resultados.replaceChildren();
    if (!q) {
      resaltar(null);
      return [];
    }
    // Primero el nombre exacto, luego los que empiezan igual, luego la palabra suelta; a igualdad, el más corto.
    // "Avenida" no cuenta al comparar: "cl 26" encuentra primero la Avenida Calle 26.
    const palabra = new RegExp(`(^| )${escaparRe(q)}( |$)`);
    const rango = (r) => {
      const c = r.clave.replace(/^avenida (?=calle|carrera)/, '');
      return r.clave === q || c === q ? 0 : r.clave.startsWith(q) || c.startsWith(q) ? 1 : palabra.test(r.clave) ? 2 : 3;
    };
    const hallados = indice.filter((r) => r.clave.includes(q)).map((r) => [rango(r), r])
      .sort((a, b) => a[0] - b[0] || a[1].texto.length - b[1].texto.length).slice(0, 8).map(([, r]) => r);
    for (const r of hallados) {
      const b = nuevo('button', '', nuevo('li', '', resultados));
      b.type = 'button';
      nuevo('span', '', b).textContent = r.texto;
      nuevo('small', '', b).textContent = r.sub;
      if (r.lugar?.nota) b.title = r.lugar.nota;
      b.addEventListener('click', () => elegir(r));
    }
    return hallados;
  }
  function resaltar(nombre) {
    nombreResaltado = nombre || '';
    resaltado = null;
    if (!nombre) return;
    resaltado = new Path2D();
    for (const { p } of viasPorNombre.get(nombre)) {
      resaltado.moveTo(p[0][0], p[0][1]);
      for (let i = 1; i < p.length; i++) resaltado.lineTo(p[i][0], p[i][1]);
    }
  }
  function elegir(r) {
    resultados.replaceChildren();
    if (r.lugar) {
      resaltar(null);
      centrarEn(r.lugar.x, r.lugar.z, Math.max(vistaA.s, 1.2));
      return;
    }
    resaltar(r.calle);
    // Las avenidas cruzan toda la zona: se centra en su punto más cercano a ti.
    let mejor = null, dmin = Infinity;
    for (const { p } of viasPorNombre.get(r.calle)) {
      for (const q of p) {
        const d = Math.hypot(q[0] - jugador.x, q[1] - jugador.z);
        if (d < dmin) [dmin, mejor] = [d, q];
      }
    }
    centrarEn(mejor[0], mejor[1], Math.max(vistaA.s, 0.8));
  }
  buscador.addEventListener('input', () => buscar(buscador.value));
  buscador.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const [r] = buscar(buscador.value);
      if (r) elegir(r);
    }
    if (e.key === 'ArrowDown') {
      resultados.querySelector('button')?.focus();
      e.preventDefault();
    }
  });

  // Teclado: M abre y cierra, Esc cierra, + y − acercan. Con el atlas abierto ninguna tecla llega al juego: las que
  // nacen fuera del atlas se cortan aquí (captura) y las de adentro, en su raíz.
  const enCampo = (e) => /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.target.isContentEditable;
  addEventListener('keydown', (e) => {
    const solo = !e.metaKey && !e.ctrlKey && !e.altKey;
    if (!abierto) {
      if (e.code === 'KeyM' && !e.repeat && solo && !enCampo(e)) abrir();
      return;
    }
    if (e.code === 'Escape') {
      cerrar();
      e.preventDefault();
    } else if (solo && !enCampo(e)) {
      if (e.code === 'KeyM' && !e.repeat) cerrar();
      else if (e.key === '+' || e.code === 'Equal' || e.code === 'NumpadAdd') acercar(1.6);
      else if (e.key === '-' || e.code === 'Minus' || e.code === 'NumpadSubtract') acercar(1 / 1.6);
    }
    if (!(e.target instanceof Node && atlas.contains(e.target))) e.stopImmediatePropagation();
  }, true);
  atlas.addEventListener('keydown', (e) => e.stopPropagation());

  return {
    actualizar,
    abrir,
    cerrar,
    get abierto() { return abierto; },
    destino(x, z) { meta = x == null ? null : { x, z }; },
    mostrar(si) {
      visible = !!si;
      raiz.style.display = visible ? '' : 'none';
    },
  };
}
