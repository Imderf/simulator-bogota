// Minimapa tipo GPS abajo a la izquierda, con el norte arriba, y encima los letreros de la esquina más cercana.
// Adaptado de Slop New York (mrdoob, MIT): js/nyc-map.js (renderMinimap, TiledLayer, drawWorld, drawRoadLabels),
// js/main.js (letreros de esquina) y css/style.css (radar y letreros).
import { ZONA, aMundo } from './marco.js';
import { anchoVia } from './vias.js';

const ESCALA = 0.32; // píxeles por metro a ras de suelo; se aleja al subir la cámara
const TESELA = 400; // m: las capas se parten en teselas para pintar solo las que se ven
const CELDA = 64; // m: rejilla para buscar las vías con nombre más cercanas
const RADIO_ESQUINA = 120; // m

// Grafito con las calles un tono más claro que las manzanas; parques y agua apagados; TransMilenio en rojo.
const C = {
  fuera: '#0b1016',
  manzana: '#1b2027',
  // parque, bosque, agua, cancha, parqueadero, plaza
  suelo: ['#1a3021', '#172a1d', '#10263a', '#1f3a27', '#252a31', '#2f2d29'],
  edificios: ['#262c34', '#2f3641', '#3b4451'], // hasta 3 pisos, hasta 10, más altos
  // troncal, principal, secundaria, local, servicio, peatonal, ciclorruta, escalera, sendero, TransMilenio
  vias: ['#a8773a', '#5d6775', '#4d5663', '#3f4854', '#373f4a', '#4b453b', '#5e3632', '#3b403b', '#343a31', '#a3382e'],
  ruta: '#f5c518',
  halo: 'rgba(8, 11, 15, 0.9)',
};
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
}
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
`;

const nuevo = (etiqueta, clase, padre) => {
  const e = document.createElement(etiqueta);
  e.className = clase;
  padre.appendChild(e);
  return e;
};

export async function crearMinimapa({ contenedor, vias, edificios, suelo, datos = './datos/centro/' }) {
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
  lienzo.setAttribute('aria-label', 'Minimapa con el norte arriba');
  nuevo('span', 'minimapa-norte', marco).textContent = 'N';
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
  const etiquetas = [], celdas = new Map();
  vias.forEach((v, k) => {
    const n = nombreDe[k];
    if (!n || v.clase > 5) return;
    const anclas = anclasDe(v.p);
    if (anclas.length) etiquetas.push({ texto: abreviar(n), troncal: v.clase === 0, mayor: v.clase <= 1, anclas, ...cajaDe(v.p) });
    if (v.bus) return; // en OpenStreetMap los carriles se llaman "TransMilenio": no es nombre de esquina
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
    if (!anchos.has(texto)) anchos.set(texto, c.measureText(texto).width);
    return anchos.get(texto);
  };

  // Nombres a lo largo de las calles (en píxeles desde el centro de la vista v): la mejor ancla de cada calle donde
  // quepa su nombre, uno por calle cada 180 px, sin pisarse.
  function pintarNombres(c, v) {
    c.font = `600 ${FUENTE}px ${LETRA}`;
    const m = (FUENTE * 2.5) / v.s;
    const dentro = { minX: v.minX + m, maxX: v.maxX - m, minZ: v.minZ + m, maxZ: v.maxZ - m };
    const candidatas = [];
    for (const e of etiquetas) {
      if (!toca(e, dentro)) continue;
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
    const puestas = [], porNombre = new Map();
    for (const { e, a, ancho } of candidatas) {
      if (puestas.length >= 28) break;
      const X = (a.x - v.cx) * v.s, Y = (a.z - v.cz) * v.s;
      const mismas = porNombre.get(e.texto);
      if (mismas && mismas.some(([x, y]) => Math.hypot(x - X, y - Y) < 180)) continue;
      const hw = ancho / 2 + 3, hh = FUENTE / 2 + 2, ca = Math.abs(Math.cos(a.ang)), sa = Math.abs(Math.sin(a.ang));
      const bx = hw * ca + hh * sa, by = hw * sa + hh * ca, caja = [X - bx, Y - by, X + bx, Y + by];
      if (puestas.some((o) => caja[0] < o[2] && caja[2] > o[0] && caja[1] < o[3] && caja[3] > o[1])) continue;
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
    }
  }

  // El fondo (capas y nombres) se pinta en un lienzo aparte del doble del mapa y solo se rehace cuando el jugador
  // se acerca a su borde o el zoom cambia; cada cuadro es un drawImage más la flecha.
  const fondo = { lienzo: document.createElement('canvas'), s: 0, cx: 0, cz: 0 };
  const cf = fondo.lienzo.getContext('2d');
  function redibujar(cx, cz, s, w, h, dpr) {
    const W = w * 2, H = h * 2;
    fondo.lienzo.width = Math.round(W * dpr);
    fondo.lienzo.height = Math.round(H * dpr);
    Object.assign(fondo, { cx, cz, s });
    const v = { cx, cz, s, minX: cx - W / 2 / s, maxX: cx + W / 2 / s, minZ: cz - H / 2 / s, maxZ: cz + H / 2 / s };
    const px = (n) => n / s; // píxeles de pantalla a metros
    cf.setTransform(1, 0, 0, 1, 0, 0);
    cf.fillStyle = C.fuera;
    cf.fillRect(0, 0, fondo.lienzo.width, fondo.lienzo.height);
    cf.setTransform(s * dpr, 0, 0, s * dpr, dpr * (W / 2 - cx * s), dpr * (H / 2 - cz * s));
    cf.lineJoin = cf.lineCap = 'round';
    // Manzanas implícitas: la zona con datos va en tono de manzana y las vías, más claras, se pintan encima.
    cf.fillStyle = C.manzana;
    cf.fillRect(zx0, zz0, zx1 - zx0, zz1 - zz0);
    for (const i of ORDEN_SUELO) {
      cf.fillStyle = C.suelo[i];
      capasSuelo[i].cada(v, (p) => cf.fill(p));
    }
    // De lejos los edificios serían polvo y costarían decenas de miles de polígonos por redibujo.
    if (s >= 0.14) {
      capasEdificios.forEach((capa, i) => {
        cf.fillStyle = C.edificios[i];
        capa.cada(v, (p) => cf.fill(p, 'evenodd'));
      });
    }
    for (const g of capasVias) {
      if (!g.ancho && s < 0.2) continue; // los hilos solo de cerca
      cf.strokeStyle = C.vias[g.tono];
      cf.lineWidth = Math.max(g.ancho, px(MIN_PX[g.tono]));
      g.capa.cada(v, (p) => cf.stroke(p));
    }
    cf.setTransform(dpr, 0, 0, dpr, (dpr * W) / 2, (dpr * H) / 2);
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
  let ultimo = null, textoLetreros = '';
  function letreros(x, z) {
    if (ultimo && Math.hypot(x - ultimo[0], z - ultimo[1]) < 4) return;
    ultimo = [x, z];
    const nombres = esquina(x, z), texto = nombres.join('|');
    if (texto === textoLetreros) return;
    textoLetreros = texto;
    elLetreros.replaceChildren();
    for (const n of nombres) nuevo('span', 'minimapa-letrero', elLetreros).textContent = n;
  }

  const cono = ctx.createRadialGradient(0, 0, 2, 0, 0, 52);
  cono.addColorStop(0, 'rgba(255, 255, 255, 0.3)');
  cono.addColorStop(1, 'rgba(255, 255, 255, 0)');
  let escala = 0, meta = null, visible = true;

  // rumbo y rumboCamara con la convención de jugador.js: se avanza hacia (-sin r, -cos r); 0 = norte.
  // alto: altura de la cámara sobre el suelo, en metros (aleja el mapa en el helicóptero).
  function actualizar(x, z, rumbo = 0, rumboCamara = rumbo, alto = 0) {
    if (!visible) return;
    const w = lienzo.clientWidth, h = lienzo.clientHeight;
    if (!w || !h) return; // oculto por CSS en pantallas angostas
    letreros(x, z);
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
    ctx.lineJoin = ctx.lineCap = 'round';

    // Ruta en línea recta al destino; si queda fuera del mapa, la marca se queda en el borde, en su dirección.
    if (meta) {
      const dx = (meta.x - x) * escala, dy = (meta.z - z) * escala;
      const t = Math.min(1, (w / 2 - 9) / (Math.abs(dx) || 1e-9), (h / 2 - 9) / (Math.abs(dy) || 1e-9));
      const ex = dx * t, ey = dy * t;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(ex, ey);
      ctx.strokeStyle = C.halo;
      ctx.lineWidth = 6;
      ctx.stroke();
      ctx.strokeStyle = C.ruta;
      ctx.lineWidth = 3;
      ctx.stroke();
      for (const [r, color] of [[6.5, C.halo], [4.5, C.ruta], [1.7, C.halo]]) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(ex, ey, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Cono de lo que mira la cámara y flecha del jugador (dibujados hacia arriba = norte, luego girados).
    ctx.save();
    ctx.rotate(-rumboCamara);
    ctx.fillStyle = cono;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, 52, -Math.PI * 0.72, -Math.PI * 0.28);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.rotate(-rumbo);
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(6.5, 7);
    ctx.lineTo(0, 3.2);
    ctx.lineTo(-6.5, 7);
    ctx.closePath();
    ctx.strokeStyle = C.halo;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();
  }

  return {
    actualizar,
    destino(x, z) { meta = x == null ? null : { x, z }; },
    mostrar(si) {
      visible = !!si;
      raiz.style.display = visible ? '' : 'none';
    },
  };
}
