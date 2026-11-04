import * as THREE from 'three/webgpu';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  Fn, attribute, texture, uv, uniform, time, float, vec2, vec3, vec4, color, mix, step, smoothstep, floor, fract,
  sin, abs, dot, normalize, pow, clamp, distance, positionLocal, positionGeometry, normalLocal, normalView,
  normalViewGeometry, positionViewDirection, frontFacing,
} from 'three/tsl';
import { cargarBinario } from './binario.js';

// Árboles del censo del Jardín Botánico en dos versiones:
// - Cerca: tronco y ramas como tubos, copa de tarjetas de hojas dibujadas en un canvas, luz que atraviesa las hojas
//   a contraluz y viento. Es un campo que se rehace cuando la cámara se mueve (dos niveles de detalle).
// - Lejos: tronco y copa lisos con normales redondeadas, por celdas fijas. Su shader esconde los que están cerca.
// Adaptado de Slop New York (mrdoob, MIT): js/trees.js (esqueleto, tarjetas, atlas, mipmaps con cobertura)
// y js/tsl-materials.js (translucidez y viento).

const Q = 0.5;
export const FORMAS = ['copa', 'conifera', 'palma', 'eucalipto', 'arbusto'];

// Distancias en 3D desde la cámara hasta la base del árbol (m).
const DETALLE = 90; // todas las ramas y ramitas
const CERCA = 300; // hasta aquí tarjetas de hojas; más allá, copas lisas
const MARGEN = 40; // el campo cercano se arma con este colchón...
const PASO = 20; // ...y se rehace cuando la cámara se mueve esto (menos que MARGEN, para que no falte ninguno)
const CELDA = 800; // celdas de las copas lejanas: pocas llamadas a la GPU
const CUBO = 50; // rejilla para encontrar rápido los árboles cercanos
const ARBUSTOS_HASTA = 1500; // de más lejos un arbusto mide menos de un píxel

export async function cargarArboles(url) {
  const [meta, xs, zs] = await cargarBinario(url, 'BOA1');
  const n = meta.uint(), lista = new Array(n);
  let x = 0, z = 0;
  for (let k = 0; k < n; k++) {
    const alt = meta.uint() / 2, forma = meta.uint();
    x += xs.int(); z += zs.int();
    lista[k] = { x: x * Q, z: z * Q, alt, forma };
  }
  return lista;
}

const V3 = THREE.Vector3;
const lerp = (a, b, t) => a + (b - a) * t;
const suave = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const azar = (x, z, k) => { const s = Math.sin(x * 127.1 + z * 311.7 + k * 74.7) * 43758.5453; return s - Math.floor(s); };

// Generador con semilla: cada forma crece igual en cada carga.
function mulberry32(semilla) {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------------------------
// 1. Atlas de hojas. Texel: r = brillo de la hoja, g = variación de tono, b = ramita, a = cobertura.
// ---------------------------------------------------------------------------------------------------------------
const ATLAS = 1024, BORDE = 8; // el borde evita que los mipmaps mezclen baldosas
// Baldosas [x, y, ancho, alto] en píxeles. Fronda y eucalipto son largas: comparten un cuadro a lo alto.
const BALDOSAS = [[0, 0, 512, 512], [512, 0, 512, 512], [0, 512, 512, 512], [512, 512, 256, 512], [768, 512, 256, 512]];
const HOJA = 0, AGUJA = 1, MASA = 2, FRONDA = 3, EUCALIPTO = 4;

// Ramilletes en metros (x a la derecha, y hacia arriba desde donde se pegan a la rama), en el orden de BALDOSAS.
function ramilletes(rng) {
  const R = (a, b) => a + (b - a) * rng();
  const ramita = (x, y, a, largo, curva, segs = 12) => {
    const pts = [[x, y]];
    let ang = a;
    for (let i = 1; i <= segs; i++) {
      ang += curva / segs + R(-0.035, 0.035);
      const p = pts[i - 1];
      pts.push([p[0] + Math.sin(ang) * largo / segs, p[1] + Math.cos(ang) * largo / segs]);
    }
    return pts;
  };
  const en = (pts, t) => {
    const f = Math.min(pts.length - 1.001, t * (pts.length - 1)), i = Math.floor(f), k = f - i, a = pts[i], b = pts[i + 1];
    return { p: [lerp(a[0], b[0], k), lerp(a[1], b[1], k)], a: Math.atan2(b[0] - a[0], b[1] - a[1]) };
  };
  const todos = [];

  // Hoja ancha (urapán, caucho, nogal; también los arbustos): ramitas en abanico con hojas ovaladas alternas.
  {
    const p = [];
    for (let i = 0; i < 5; i++) {
      const f = (i + 0.5) / 5 - 0.5, pts = ramita(f * 0.06, 0, f * 1.6 + R(-0.1, 0.1), R(0.5, 0.66) * (1 - Math.abs(f) * 0.25), f * 0.9, 14);
      p.push({ tipo: 'ramita', pts, w0: 0.012, w1: 0.004 });
      let lado = rng() < 0.5 ? 1 : -1;
      for (let t = R(0.1, 0.16); t < 0.97; t += R(0.085, 0.11)) {
        const { p: q, a } = en(pts, t);
        lado = -lado;
        p.push({ tipo: 'hoja', p: q, a: a + lado * R(0.6, 1.0), largo: R(0.1, 0.13) * (1 - t * 0.2), ancho: 0.5, torcido: lado * 0.12, t });
      }
      const punta = en(pts, 1);
      p.push({ tipo: 'hoja', p: punta.p, a: punta.a, largo: 0.09, ancho: 0.48, t: 1 });
    }
    todos.push(p);
  }
  // Agujas (pino pátula, ciprés): un eje con ramitas laterales, todo cubierto de agujas cortas.
  {
    const p = [], eje = ramita(0, 0, R(-0.1, 0.1), 0.9, R(-0.2, 0.2), 14), ejes = [eje];
    p.push({ tipo: 'ramita', pts: eje, w0: 0.014, w1: 0.005 });
    let lado = 1;
    for (let t = 0.12; t < 0.92; t += R(0.09, 0.13)) {
      const { p: q, a } = en(eje, t);
      lado = -lado;
      const sub = ramita(q[0], q[1], a + lado * R(0.6, 0.95), R(0.22, 0.36) * (1 - t * 0.45), lado * 0.3, 8);
      p.push({ tipo: 'ramita', pts: sub, w0: 0.008, w1: 0.003 });
      ejes.push(sub);
    }
    for (const e of ejes) {
      for (let t = 0.04; t < 1; t += 0.035) {
        const { p: q, a } = en(e, t);
        for (const s of [-1, 1]) p.push({ tipo: 'aguja', p: q, a: a + s * R(0.45, 0.85), largo: R(0.06, 0.09), t });
      }
    }
    todos.push(p);
  }
  // Masa de follaje: un montón redondeado de hojas; una tarjeta hace las veces de un trozo de copa.
  {
    const p = [], lobulos = Array.from({ length: 7 }, () => ({ a: R(0, Math.PI * 2), r: R(0.75, 1.0), w: R(0.5, 0.9) }));
    const orilla = (ang) => 1.25 * lobulos.reduce((m, l) => Math.max(m, l.r * Math.cos(Math.min(Math.PI / 2, Math.abs(((ang - l.a + Math.PI * 3) % (Math.PI * 2)) - Math.PI) / l.w))), 0.6);
    for (let k = 0; k < 520; k++) {
      const ang = R(0, Math.PI * 2), rr = Math.sqrt(rng()) * orilla(ang), q = [Math.cos(ang) * rr, 1.3 + Math.sin(ang) * rr];
      p.push({ tipo: 'hoja', p: q, a: R(-Math.PI, Math.PI), largo: R(0.16, 0.22), ancho: 0.55, t: Math.min(1, Math.max(0, (q[1] - 0.2) / 2.2)) });
    }
    todos.push(p);
  }
  // Fronda de palma: raquis largo con folíolos angostos a lado y lado, más largos en el medio.
  {
    const p = [], eje = ramita(0, 0, 0, 3.2, R(-0.04, 0.04), 16);
    p.push({ tipo: 'ramita', pts: eje, w0: 0.045, w1: 0.01 });
    for (let t = 0.08; t < 0.99; t += 0.016) {
      const { p: q, a } = en(eje, t), largo = 0.12 + 0.7 * Math.sin(Math.PI * Math.min(1, t * 1.05));
      for (const s of [-1, 1]) p.push({ tipo: 'hoja', p: q, a: a + s * R(0.5, 0.7), largo, ancho: 0.1, t });
    }
    todos.push(p);
  }
  // Eucalipto: dos ramitas con hojas largas en forma de hoz, alternas y separadas (follaje ralo).
  {
    const p = [];
    for (let i = 0; i < 2; i++) {
      const f = i - 0.5, pts = ramita(f * 0.04, 0, f * 0.45 + R(-0.1, 0.1), R(0.6, 0.75), f * 0.35, 12);
      p.push({ tipo: 'ramita', pts, w0: 0.008, w1: 0.003 });
      let lado = rng() < 0.5 ? 1 : -1;
      for (let t = R(0.08, 0.14); t < 0.97; t += R(0.1, 0.14)) {
        const { p: q, a } = en(pts, t);
        lado = -lado;
        p.push({ tipo: 'hoja', p: q, a: a + lado * R(0.3, 0.5), largo: R(0.17, 0.24), ancho: 0.2, torcido: lado * 0.2, t });
      }
    }
    todos.push(p);
  }
  return todos;
}

// Caja de un ramillete (m); las hojas cuentan como un disco alrededor de su centro.
function limites(prims) {
  const b = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
  const sumar = (x, y, r = 0) => { b.x0 = Math.min(b.x0, x - r); b.x1 = Math.max(b.x1, x + r); b.y0 = Math.min(b.y0, y - r); b.y1 = Math.max(b.y1, y + r); };
  for (const q of prims) {
    if (q.tipo === 'ramita') for (const p of q.pts) sumar(p[0], p[1]);
    else if (q.tipo === 'aguja') { sumar(q.p[0], q.p[1]); sumar(q.p[0] + Math.sin(q.a) * q.largo, q.p[1] + Math.cos(q.a) * q.largo); }
    else sumar(q.p[0] + Math.sin(q.a) * q.largo * 0.5, q.p[1] + Math.cos(q.a) * q.largo * 0.5, q.largo * 0.62);
  }
  return b;
}

// Devuelve la textura y el tamaño en metros [ancho, alto] de la tarjeta de cada baldosa.
function crearAtlas() {
  const lienzo = () => {
    const c = document.createElement('canvas');
    c.width = c.height = ATLAS;
    return c.getContext('2d', { willReadFrequently: true });
  };
  const col = lienzo(), cob = lienzo();
  // Fondo con el valor medio de una hoja: al filtrar no entra negro (ni café de ramita) en los bordes.
  col.fillStyle = 'rgb(170, 128, 0)';
  col.fillRect(0, 0, ATLAS, ATLAS);
  for (const c of [col, cob]) { c.lineCap = 'round'; c.lineJoin = 'round'; }
  const rng = mulberry32(20261103), R = (a, b) => a + (b - a) * rng();
  const medidas = [];
  const rgb = (r, g, b = 0) => `rgb(${r}, ${g}, ${b})`;

  ramilletes(rng).forEach((prims, k) => {
    // Ajuste: el punto de pegue va abajo al centro (la masa, centrada) y lo más ancho llega al borde.
    const b = limites(prims), [ox, oy, w, h] = BALDOSAS[k], util = [w - 2 * BORDE, h - 2 * BORDE];
    let s, cx, by;
    if (k === MASA) {
      s = Math.min(util[0] / (b.x1 - b.x0), util[1] / (b.y1 - b.y0));
      cx = ox + w / 2 - ((b.x0 + b.x1) / 2) * s;
      by = oy + h / 2 + ((b.y0 + b.y1) / 2) * s;
    } else {
      s = Math.min(util[0] / 2 / Math.max(-b.x0, b.x1), util[1] / Math.max(b.y1, 0.01));
      cx = ox + w / 2;
      by = oy + h - BORDE;
    }
    medidas[k] = [util[0] / s, util[1] / s];
    const X = (p) => cx + p[0] * s, Y = (p) => by - p[1] * s;
    // Punto (u a lo largo, v a lo ancho) de una hoja que sale de P con ángulo a, L de largo y W de ancho.
    const marco = (P, a, L, W) => {
      const d = [Math.sin(a), -Math.cos(a)], x0 = X(P), y0 = Y(P);
      return (u, v) => [x0 + d[0] * u * L * s - d[1] * v * W * s, y0 + d[1] * u * L * s + d[0] * v * W * s];
    };
    const ovalo = (c, f, sesgo = 0, mitad = false) => {
      c.moveTo(...f(0, 0));
      c.bezierCurveTo(...f(0.05, 0.6 + sesgo), ...f(0.6, 0.62), ...f(1, 0));
      if (mitad) c.closePath();
      else c.bezierCurveTo(...f(0.6, -0.62), ...f(0.05, -0.6 + sesgo), ...f(0, 0));
    };
    // El mismo trazo en los dos lienzos: el dato en uno y la cobertura en blanco en el otro.
    const rellenar = (camino, estilo) => {
      for (const [c, e] of [[col, estilo], [cob, '#fff']]) { c.beginPath(); camino(c); c.fillStyle = e; c.fill(); }
    };
    const trazar = (pts, w0, w1, estilo) => {
      for (let i = 0; i < pts.length - 1; i++) {
        const ancho = Math.max(0.8, lerp(w0, w1, i / (pts.length - 1)) * s);
        for (const [c, e] of [[col, estilo], [cob, '#fff']]) {
          c.beginPath(); c.moveTo(X(pts[i]), Y(pts[i])); c.lineTo(X(pts[i + 1]), Y(pts[i + 1]));
          c.lineWidth = ancho; c.strokeStyle = e; c.stroke();
        }
      }
    };
    // Más claras hacia la punta soleada del ramillete, unas cuantas más oscuras.
    const tono = (t) => [Math.min(255, Math.round(255 * R(0.6, 0.9) * (0.8 + 0.2 * t))), Math.round(255 * rng())];

    for (const q of prims) {
      if (q.tipo === 'ramita') trazar(q.pts, q.w0, q.w1, rgb(110, 128, 255));
      else if (q.tipo === 'aguja') {
        const [r, g] = tono(q.t);
        trazar([q.p, [q.p[0] + Math.sin(q.a) * q.largo, q.p[1] + Math.cos(q.a) * q.largo]], 0.007, 0.004, rgb(r, g));
      } else {
        const [r, g] = tono(q.t), f = marco(q.p, q.a, q.largo, q.largo * q.ancho);
        rellenar((c) => ovalo(c, f, q.torcido || 0), rgb(r, g));
        if (q.largo * q.ancho * s > 6) {
          // media hoja un poco más oscura, como doblada por la nervadura
          col.beginPath(); ovalo(col, f, q.torcido || 0, true); col.fillStyle = rgb(Math.round(r * 0.84), g); col.fill();
        }
      }
    }
  });

  const datos = col.getImageData(0, 0, ATLAS, ATLAS).data, mascara = cob.getImageData(0, 0, ATLAS, ATLAS).data;
  const nivel0 = new Uint8Array(ATLAS * ATLAS * 4);
  for (let i = 0; i < nivel0.length; i += 4) {
    nivel0[i] = datos[i]; nivel0[i + 1] = datos[i + 1]; nivel0[i + 2] = datos[i + 2]; nivel0[i + 3] = mascara[i + 3];
  }
  const tex = new THREE.DataTexture(nivel0, ATLAS, ATLAS, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.mipmaps = mipsConCobertura(nivel0);
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  tex.name = 'AtlasHojas';
  return { textura: tex, medidas };
}

// Mipmaps cuya cobertura se reescala por baldosa para que la parte por encima del corte del alpha test siga igual
// que en el nivel 0: si no, el follaje se adelgaza y desaparece de lejos.
function mipsConCobertura(nivel0, corte = 128) {
  const meta = BALDOSAS.map(([x0, y0, w, h]) => {
    let n = 0;
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (nivel0[(y * ATLAS + x) * 4 + 3] >= corte) n++;
    return n / (w * h);
  });
  const niveles = [{ data: nivel0, width: ATLAS, height: ATLAS }], hist = new Uint32Array(256);
  let src = nivel0, w = ATLAS;
  while (w > 1) {
    const h = w >> 1, dst = new Uint8Array(h * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < h; x++) {
        const i0 = (2 * y * w + 2 * x) * 4, i1 = i0 + w * 4, o = (y * h + x) * 4;
        for (let c = 0; c < 4; c++) dst[o + c] = (src[i0 + c] + src[i0 + 4 + c] + src[i1 + c] + src[i1 + 4 + c] + 2) >> 2;
      }
    }
    const f = h / ATLAS;
    BALDOSAS.forEach(([bx, by, bw, bh], k) => {
      if (bw * f < 1 || bh * f < 1) return; // la baldosa ya no ocupa ni un píxel: queda el promedio
      const x0 = bx * f, y0 = by * f, x1 = x0 + bw * f, y1 = y0 + bh * f, quiere = meta[k] * bw * f * bh * f;
      hist.fill(0);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) hist[dst[(y * h + x) * 4 + 3]]++;
      let acum = 0, aCorte = 255;
      for (let a = 255; a >= 1; a--) { acum += hist[a]; if (acum >= quiere) { aCorte = a; break; } }
      const escala = corte / Math.max(aCorte, 1);
      if (Math.abs(escala - 1) < 0.01) return;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * h + x) * 4 + 3; dst[i] = Math.min(255, Math.round(dst[i] * escala)); }
    });
    niveles.push({ data: dst, width: h, height: h });
    src = dst;
    w = h;
  }
  return niveles;
}

// ---------------------------------------------------------------------------------------------------------------
// 2. Especies por forma, en metros de un árbol maduro (la instancia lo escala a la altura del censo).
//    tronco; ramas madre (alturas, inclinación y largo de la más baja a la más alta); ramas y ramitas (cuántas,
//    dónde, ángulo, largo); curvatura por metro (sube, abre, cae) y temblor; tarjetas por ramita y su caída.
// ---------------------------------------------------------------------------------------------------------------
const ESPECIES = [
  { // copa: urapán, caucho sabanero, nogal, chicalá: tronco corto y copa ancha y redonda
    hoja: HOJA, corteza: 0x5a4636, estilo: 0, follaje: [0x4f6d2c, 0x5c7a31, 0x41602a], tubos: [2, 1],
    tronco: { r: 0.28, alto: 6, inclina: 0.05, segs: 8 },
    madres: { n: 6, y: [2.6, 5.6], inclinacion: [1.05, 0.4], largo: [4.4, 2.8], r: 0.62, sube: 0.07, abre: 0, cae: 0, temblor: 0.08, segs: 6 },
    ramas: { n: 4, t: [0.3, 0.98], angulo: [0.55, 0.95], largo: [0.62, 0.42], sube: 0.05, abre: 0.02, cae: 0, temblor: 0.1, segs: 4 },
    ramitas: { n: 3, t: [0.3, 1], angulo: [0.6, 1.05], largo: [1.1, 0.7], sube: 0.02, abre: 0, cae: 0.05, temblor: 0.12, segs: 2 },
    tarjetas: { porRamita: 2, escala: [0.85, 1.1], cae: 0.08, cascara: 18 },
  },
  { // conífera: pino pátula, ciprés: eje recto hasta la punta y pisos de ramas cada vez más cortas
    hoja: AGUJA, corteza: 0x4b3a2e, estilo: 0, follaje: [0x2f4b2d, 0x37522f, 0x2a4429], tubos: [2, 1],
    tronco: { r: 0.24, alto: 12.5, inclina: 0.02, segs: 10 },
    madres: { n: 16, y: [1.6, 11.6], inclinacion: [1.75, 0.8], largo: [3, 0.7], r: 0.4, sube: 0, abre: 0, cae: 0.04, temblor: 0.05, segs: 4 },
    ramas: { n: 3, t: [0.25, 0.95], angulo: [0.6, 1], largo: [0.45, 0.35], sube: 0.02, abre: 0.02, cae: 0.03, temblor: 0.1, segs: 3 },
    ramitas: { n: 2, t: [0.3, 1], angulo: [0.5, 0.9], largo: [0.8, 0.5], sube: 0, abre: 0, cae: 0.08, temblor: 0.1, segs: 2 },
    tarjetas: { porRamita: 2, escala: [0.8, 1.05], cae: 0.15, cascara: 14 },
  },
  { // palma: fénix, washingtonia, palma de cera: estípite sin ramas y corona de frondas arqueadas
    hoja: FRONDA, corteza: 0x9d9486, estilo: 1, follaje: [0x5f7b3a, 0x6b8441, 0x55713a],
    tronco: { r: 0.2, alto: 6.2, inclina: 0.06, segs: 8, punta: 0.8 },
    frondas: { n: 16, largo: 3.2 },
    // Variante alta (más de 12 m), como la palma de cera: fuste largo y corona chica en proporción.
    variantes: [{}, { tronco: { r: 0.3, alto: 24, inclina: 0.03, segs: 12, punta: 0.8 }, frondas: { n: 14, largo: 4.2 } }],
  },
  { // eucalipto: fuste alto y limpio, pocas ramas que suben y follaje ralo que cuelga
    hoja: EUCALIPTO, corteza: 0xa59a86, estilo: 2, follaje: [0x6b8060, 0x768a69, 0x5f7557], tubos: [2, 1],
    tronco: { r: 0.42, alto: 19, inclina: 0.07, segs: 10 },
    madres: { n: 5, y: [9, 17.5], inclinacion: [0.8, 0.3], largo: [8, 6], r: 0.55, sube: 0.02, abre: 0.01, cae: 0, temblor: 0.14, segs: 6 },
    ramas: { n: 4, t: [0.35, 1], angulo: [0.5, 0.9], largo: [0.5, 0.35], sube: 0, abre: 0.03, cae: 0.05, temblor: 0.14, segs: 4 },
    ramitas: { n: 3, t: [0.3, 1], angulo: [0.5, 0.95], largo: [1.2, 0.8], sube: 0, abre: 0, cae: 0.2, temblor: 0.12, segs: 2 },
    tarjetas: { porRamita: 1, escala: [0.9, 1.2], cae: 0.9, cascara: 6 },
  },
  { // arbusto: varios tallos desde el suelo y follaje tupido; de lejos, solo la cáscara de tarjetas
    hoja: HOJA, corteza: 0x5a4a3a, estilo: 0, follaje: [0x46663a, 0x52713d, 0x3d5a33], tubos: [1, -1], cascaraSola: true,
    tronco: { r: 0.05, alto: 0.4, inclina: 0.1, segs: 3 },
    madres: { n: 6, y: [0.05, 0.35], inclinacion: [1.0, 0.35], largo: [1.3, 1.0], r: 0.8, sube: 0.15, abre: 0, cae: 0, temblor: 0.12, segs: 4 },
    ramas: { n: 3, t: [0.3, 1], angulo: [0.5, 0.9], largo: [0.5, 0.4], sube: 0.1, abre: 0.05, cae: 0, temblor: 0.12, segs: 2 },
    ramitas: { n: 2, t: [0.3, 1], angulo: [0.5, 0.9], largo: [0.35, 0.25], sube: 0.05, abre: 0, cae: 0.05, temblor: 0.12, segs: 2 },
    tarjetas: { porRamita: 2, escala: [0.4, 0.55], cae: 0.05, cascara: 10 },
  },
];

// ---------------------------------------------------------------------------------------------------------------
// 3. Esqueleto
// ---------------------------------------------------------------------------------------------------------------

// Vector unitario a `angulo` de `dir`, girado `azimut` alrededor de él.
function desviar(dir, angulo, azimut) {
  const ref = Math.abs(dir.y) < 0.95 ? new V3(0, 1, 0) : new V3(1, 0, 0);
  const u = new V3().crossVectors(dir, ref).normalize(), w = new V3().crossVectors(dir, u);
  return dir.clone().multiplyScalar(Math.cos(angulo))
    .addScaledVector(u, Math.sin(angulo) * Math.cos(azimut))
    .addScaledVector(w, Math.sin(angulo) * Math.sin(azimut))
    .normalize();
}

// Rama como polilínea desde p0, que por metro se curva hacia el cielo (sube), lejos del eje (abre) y hacia abajo
// cerca de la punta (cae), con algo de temblor.
function crecerRama(p0, dir, largo, r0, r1, segs, curva, rng, nivel, plan = null) {
  const ts = plan || Array.from({ length: segs + 1 }, (_, i) => i / segs);
  const pts = [p0.clone()], rad = [r0], d = dir.clone(), p = p0.clone(), fuera = new V3();
  for (let i = 1; i < ts.length; i++) {
    const t = ts[i], paso = (t - ts[i - 1]) * largo;
    fuera.set(p.x, 0, p.z);
    if (fuera.lengthSq() > 1e-6) fuera.normalize();
    d.x += fuera.x * curva.abre * paso + (rng() - 0.5) * curva.temblor;
    d.y += (curva.sube - curva.cae * t * 2) * paso + (rng() - 0.5) * curva.temblor * 0.6;
    d.z += fuera.z * curva.abre * paso + (rng() - 0.5) * curva.temblor;
    d.normalize();
    p.addScaledVector(d, paso);
    pts.push(p.clone());
    rad.push(r0 + (r1 - r0) * Math.pow(t, 0.8));
  }
  return { pts, rad, largo, nivel, ts };
}

// Punto, dirección y radio a la fracción t del largo de una rama.
function sobre(b, t) {
  const ts = b.ts;
  let i = 0;
  while (i < ts.length - 2 && ts[i + 1] < t) i++;
  const k = Math.min(1, Math.max(0, (t - ts[i]) / (ts[i + 1] - ts[i])));
  return { p: b.pts[i].clone().lerp(b.pts[i + 1], k), d: b.pts[i + 1].clone().sub(b.pts[i]).normalize(), r: lerp(b.rad[i], b.rad[i + 1], k) };
}

function crecerArbol(e, semilla) {
  const rng = mulberry32(semilla), R = (a, b) => a + (b - a) * rng(), todas = [];
  // Tronco: algo inclinado, ensanchado en la raíz (anillos densos abajo) y afinado hacia arriba.
  const T = e.tronco, giro = R(0, Math.PI * 2);
  const dirT = new V3(Math.cos(giro) * T.inclina, 1, Math.sin(giro) * T.inclina).normalize();
  const plan = [0, 0.03, 0.08];
  for (let i = 1; i <= T.segs; i++) plan.push(0.08 + (0.92 * i) / T.segs);
  const tronco = crecerRama(new V3(), dirT, T.alto, T.r, T.r * (T.punta ?? 0.3), T.segs, { sube: 0, abre: 0, cae: 0, temblor: 0.025 }, rng, 0, plan);
  tronco.rad = tronco.rad.map((r, i) => r * (1 + 0.75 * Math.exp(-(tronco.ts[i] * T.alto) / 0.28)));
  todas.push(tronco);
  if (!e.madres) return todas;

  // Ramas madre en espiral por el ángulo de oro; ramas sobre cada madre; ramitas sobre cada rama.
  const M = e.madres, B = e.ramas, W = e.ramitas;
  let az = R(0, Math.PI * 2);
  for (let i = 0; i < M.n; i++) {
    const f = M.n > 1 ? i / (M.n - 1) : 0, y = lerp(M.y[0], M.y[1], f) + R(-1, 1) * 0.03 * T.alto;
    const base = sobre(tronco, Math.min(0.98, Math.max(0.02, y / T.alto)));
    az += 2.39996 + R(-0.35, 0.35);
    const inc = lerp(M.inclinacion[0], M.inclinacion[1], f) + R(-0.08, 0.08);
    const dir = new V3(Math.sin(inc) * Math.cos(az), Math.cos(inc), Math.sin(inc) * Math.sin(az));
    const largo = lerp(M.largo[0], M.largo[1], f) * R(0.88, 1.1), r0 = base.r * M.r;
    const madre = crecerRama(base.p, dir, largo, r0, Math.min(0.035, r0 * 0.4), M.segs, M, rng, 1);
    todas.push(madre);

    const nb = B.n + (rng() < 0.5 ? 1 : 0);
    let baz = R(0, Math.PI * 2);
    for (let j = 0; j < nb; j++) {
      const bt = lerp(B.t[0], B.t[1], (j + R(0.15, 0.85)) / nb), a = sobre(madre, bt);
      baz += 2.39996 + R(-0.4, 0.4);
      const bdir = desviar(a.d, R(B.angulo[0], B.angulo[1]), baz), fuera = new V3(a.p.x, 0, a.p.z);
      // que no se meta al centro de la copa
      if (fuera.lengthSq() > 1e-6 && bdir.dot(fuera.normalize()) < -0.15) bdir.addScaledVector(fuera, 0.7).normalize();
      const rama = crecerRama(a.p, bdir, largo * lerp(B.largo[0], B.largo[1], bt) * R(0.85, 1.12), Math.max(0.012, a.r * 0.62), 0.01, B.segs, B, rng, 2);
      todas.push(rama);

      const nw = W.n + (rng() < 0.4 ? 1 : 0);
      let taz = R(0, Math.PI * 2);
      for (let q = 0; q < nw; q++) {
        const tt = lerp(W.t[0], W.t[1], (q + R(0.2, 0.8)) / nw), ta = sobre(rama, tt);
        taz += 2.39996 + R(-0.5, 0.5);
        const tdir = desviar(ta.d, R(W.angulo[0], W.angulo[1]), taz);
        todas.push(crecerRama(ta.p, tdir, lerp(W.largo[0], W.largo[1], tt) * R(0.8, 1.2), Math.max(0.006, ta.r * 0.7), 0.004, W.segs, W, rng, 3));
      }
    }
  }
  return todas;
}

// ---------------------------------------------------------------------------------------------------------------
// 4. Geometría: tubos de corteza y tarjetas de hojas. aHoja = (es hoja, oclusión, peso del viento, azar o estilo
//    de corteza). Las normales de las tarjetas son las de la cáscara de la copa: la copa se ilumina como un volumen.
// ---------------------------------------------------------------------------------------------------------------
class Constructor {
  constructor() { this.pos = []; this.nor = []; this.uv = []; this.col = []; this.dat = []; this.idx = []; }

  vertice(p, n, u, v, tono, hoja, ao, viento, w) {
    this.pos.push(p.x, p.y, p.z); this.nor.push(n.x, n.y, n.z); this.uv.push(u, v);
    this.col.push(tono.r, tono.g, tono.b); this.dat.push(hoja, ao, viento, w);
  }

  get alto() { let m = 0; for (let i = 1; i < this.pos.length; i += 3) m = Math.max(m, this.pos[i]); return m; }

  // Altura 1: la instancia la escala a la altura real, y el viento usa la altura relativa.
  geometria(escala) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos.map((v) => v * escala), 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aHoja', new THREE.Float32BufferAttribute(this.dat, 4));
    const n = this.pos.length / 3;
    g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}

// Peso del viento por jerarquía: 0 en el tronco (se dobla entero según la altura), 1 en las puntas.
const pesoViento = (b, t) => [0, 0.18 * t, 0.18 + 0.4 * t, 0.58 + 0.4 * t][Math.min(b.nivel, 3)];

// Tubo afinado a lo largo de una rama, con anillos transportados en paralelo (cada `salto` puntos); uv en metros.
function tubo(cb, b, radial, salto, aoEn, tono, estilo) {
  const n = b.pts.length, quedan = [];
  for (let i = 0; i < n; i += salto) quedan.push(i);
  if (quedan[quedan.length - 1] !== n - 1) quedan.push(n - 1);
  const tangente = (i) => b.pts[Math.min(n - 1, i + 1)].clone().sub(b.pts[Math.max(0, i - 1)]).normalize();
  let T = tangente(quedan[0]);
  const N = (Math.abs(T.y) < 0.9 ? new V3(0, 1, 0) : new V3(1, 0, 0)).cross(T).normalize();
  const q = new THREE.Quaternion(), vuelta = 2 * Math.PI * Math.max(b.rad[0], 0.02), base = cb.pos.length / 3;
  const dir = new V3(), p = new V3();
  let largo = 0;
  quedan.forEach((i, k) => {
    if (k > 0) {
      const T2 = tangente(i);
      q.setFromUnitVectors(T, T2);
      N.applyQuaternion(q).normalize();
      T = T2;
      largo += b.pts[i].distanceTo(b.pts[quedan[k - 1]]);
    }
    const Bn = new V3().crossVectors(T, N), ao = aoEn(b.pts[i]), viento = pesoViento(b, b.ts[i]);
    for (let j = 0; j <= radial; j++) {
      const ang = (j / radial) * Math.PI * 2;
      dir.copy(N).multiplyScalar(Math.cos(ang)).addScaledVector(Bn, Math.sin(ang));
      p.copy(b.pts[i]).addScaledVector(dir, b.rad[i]);
      cb.vertice(p, dir, (j / radial) * vuelta, largo, tono, 0, ao, viento, estilo);
    }
  });
  for (let k = 0; k < quedan.length - 1; k++) {
    for (let j = 0; j < radial; j++) {
      const a = base + k * (radial + 1) + j, c = a + radial + 1;
      cb.idx.push(a, a + 1, c, a + 1, c + 1, c);
    }
  }
}

// uv de una baldosa: [izquierda, derecha, arriba, abajo] (espejada o no).
function uvBaldosa(k, espejo) {
  const [ox, oy, w, h] = BALDOSAS[k];
  const u0 = (ox + BORDE) / ATLAS, u1 = (ox + w - BORDE) / ATLAS;
  return [espejo ? u1 : u0, espejo ? u0 : u1, (oy + BORDE) / ATLAS, (oy + h - BORDE) / ATLAS];
}

// Tarjeta de hojas: borde de abajo centrado en `en`, sube por `arriba` y mira hacia `cara`.
function tarjeta(cb, c, copa, tono) {
  const lado = new V3().crossVectors(c.arriba, c.cara).normalize(), nor = new V3().crossVectors(lado, c.arriba).normalize();
  const [u0, u1, vA, vB] = uvBaldosa(c.baldosa, c.espejo), base = cb.pos.length / 3, p = new V3();
  for (const [sx, sy, u, v] of [[-0.5, 0, u0, vB], [0.5, 0, u1, vB], [0.5, 1, u1, vA], [-0.5, 1, u0, vA]]) {
    p.copy(c.en).addScaledVector(lado, sx * c.ancho).addScaledVector(c.arriba, sy * c.alto);
    const { n, ao } = copa.sombra(p, nor);
    cb.vertice(p, n, u, v, tono, 1, ao, lerp(0.8, 1, sy), c.rnd);
  }
  cb.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

// Fronda de palma: cinta curva en V (dos mitades, cada una con medio dibujo) que se arquea hacia abajo.
function fronda(cb, filas, f, copa, tono) {
  const [uL, uR, vA, vB] = uvBaldosa(FRONDA, f.espejo), uC = (uL + uR) / 2;
  const lado = new V3(-f.sal.z, 0, f.sal.x), borde = new V3(), q = new V3(), V = 0.5; // abertura de la V
  for (const s of [-1, 1]) {
    const base = cb.pos.length / 3;
    filas.forEach(({ p, n }, i) => {
      const t = i / (filas.length - 1), v = lerp(vB, vA, t), viento = 0.55 + 0.45 * t;
      borde.copy(lado).multiplyScalar(s * Math.cos(V)).addScaledVector(n, Math.sin(V));
      q.copy(p).addScaledVector(borde, f.media);
      const a = copa.sombra(p, n), b = copa.sombra(q, n);
      cb.vertice(p, a.n, uC, v, tono, 1, a.ao, viento, f.rnd);
      cb.vertice(q, b.n, s > 0 ? uR : uL, v, tono, 1, b.ao, viento, f.rnd);
    });
    for (let i = 0; i < filas.length - 1; i++) { const a = base + 2 * i; cb.idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
  }
}

// Elipsoide de la copa (según el follaje) para las normales de cáscara y la oclusión de adentro.
function hacerCopa(puntos) {
  const caja = new THREE.Box3().setFromPoints(puntos), C = caja.getCenter(new V3());
  const R = caja.getSize(new V3()).multiplyScalar(0.5).max(new V3(0.25, 0.25, 0.25)), tmp = new V3(), sn = new V3();
  return {
    C, R, abajo: caja.min.y,
    // Normal de cáscara (desde el centro, un poco hacia el cielo) mezclada con la de la tarjeta, vuelta a su lado.
    sombra(p, cara) {
      tmp.copy(p).sub(C).divide(R);
      const e = tmp.length();
      sn.copy(tmp).normalize();
      sn.y += 0.22;
      sn.normalize();
      const f = cara.dot(sn) < 0 ? cara.clone().negate() : cara.clone();
      const n = sn.clone().multiplyScalar(0.72).addScaledVector(f, 0.28).normalize();
      const arriba = Math.min(1, Math.max(-1, (p.y - C.y) / R.y));
      return { n, ao: (0.22 + 0.78 * suave(0.15, 1, e)) * (0.86 + 0.14 * arriba) };
    },
    // Corteza: al aire bajo la copa, más oscura entre más adentro.
    corteza(p) {
      if (p.y < caja.min.y) return 0.9;
      tmp.copy(p).sub(C).divide(R);
      return lerp(0.32, 0.8, suave(0.2, 1, tmp.length()));
    },
  };
}

// Tarjetas finas en las ramitas (lod 0), más grandes en las ramas (lod 1) y la cáscara de la copa (lod 2).
function ponerTarjetas(e, todas, lod, medidas, rng, copa) {
  const R = (a, b) => a + (b - a) * rng(), tj = e.tarjetas, [w, h] = medidas[e.hoja];
  const media = (tj.escala[0] + tj.escala[1]) / 2, tarjetas = [];
  const afuera = (p) => new V3(p.x - copa.C.x, (p.y - copa.C.y) * 0.6, p.z - copa.C.z).normalize();
  const poner = (en, d, k) => {
    const o = afuera(en);
    const arriba = d.clone().multiplyScalar(0.55).addScaledVector(o, 0.45).add(new V3(R(-0.3, 0.3), R(-0.2, 0.3), R(-0.3, 0.3)));
    arriba.y -= tj.cae;
    arriba.normalize();
    let cara = o.clone().add(new V3(R(-0.9, 0.9), R(-0.6, 0.9), R(-0.9, 0.9))).normalize();
    cara.addScaledVector(arriba, -cara.dot(arriba));
    if (cara.lengthSq() < 1e-4) cara = new V3(0, 1, 0).cross(arriba);
    tarjetas.push({ en, arriba, cara: cara.normalize(), ancho: w * k, alto: h * k, baldosa: e.hoja });
  };
  if (lod === 0) {
    for (const b of todas) {
      if (b.nivel !== 3) continue;
      for (let k = 0; k < tj.porRamita; k++) {
        const a = sobre(b, lerp(0.4, 1, (k + R(0.3, 0.9)) / tj.porRamita));
        poner(a.p, a.d, R(tj.escala[0], tj.escala[1]));
      }
    }
    // una tarjeta en la punta de cada rama tapa el hueco entre sus ramitas
    for (const b of todas) if (b.nivel === 2) { const a = sobre(b, 1); poner(a.p, a.d, media * R(0.9, 1.1)); }
  } else if (lod === 1) {
    for (const b of todas) {
      if (b.nivel !== 2) continue;
      for (const t of [0.42, 0.72, 1]) {
        const a = sobre(b, Math.min(1, t + R(-0.06, 0.04)));
        poner(a.p.clone().addScaledVector(afuera(a.p), 0.35 * media), a.d, media * R(1.35, 1.6));
      }
    }
  } else {
    // Direcciones de Fibonacci sobre la copa (menos por debajo), tarjetas de masa justo adentro, mirando afuera.
    const n = tj.cascara, s = ((copa.R.x + copa.R.y + copa.R.z) / 3) * 1.25;
    for (let i = 0; i < n; i++) {
      const y = 1 - ((i + 0.5) / n) * 1.55, r = Math.sqrt(Math.max(0, 1 - y * y)), fi = i * 2.39996 + R(-0.2, 0.2);
      const dir = new V3(Math.cos(fi) * r, y, Math.sin(fi) * r);
      const centro = copa.C.clone().add(dir.clone().multiply(copa.R).multiplyScalar(0.58));
      const cara = dir.clone().add(new V3(R(-0.25, 0.25), R(-0.25, 0.25), R(-0.25, 0.25))).normalize();
      let arriba = new V3(0, 1, 0).addScaledVector(cara, -cara.y);
      if (arriba.lengthSq() < 1e-3) arriba = new V3(1, 0, 0);
      arriba.normalize().applyAxisAngle(cara, R(-0.5, 0.5));
      tarjetas.push({ en: centro.addScaledVector(arriba, -s * 0.5), arriba, cara, ancho: s, alto: s, baldosa: MASA });
    }
  }
  return tarjetas;
}

// Versión lejana: tronco y copa lisos (vértices soldados, normales redondeadas), con bultos y más oscura abajo,
// ajustada a la copa de cerca para que el cambio no salte.
function geometriaLejos(e, copa, H) {
  const conica = e.hoja === AGUJA, chico = e.tronco.alto < 1;
  const lisa = (g) => { g.deleteAttribute('uv'); g.deleteAttribute('normal'); return mergeVertices(g); };
  const c = lisa(conica ? new THREE.ConeGeometry(1, 2, 9, 3) : chico ? new THREE.SphereGeometry(1, 6, 4) : new THREE.SphereGeometry(1, 8, 5));
  const p = c.attributes.position, v = new V3(), tonos = new Float32Array(p.count * 3), hoja = new THREE.Color(e.follaje[0]);
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const bulto = 1 + 0.13 * Math.sin(5.1 * v.x + 1.3) * Math.sin(4.3 * v.y + 0.7) * Math.sin(3.7 * v.z + 2.1);
    const arriba = v.y * 0.5 + 0.5;
    v.multiplyScalar(bulto).multiply(copa.R).multiplyScalar(0.85).add(copa.C);
    p.setXYZ(i, v.x, v.y, v.z);
    const f = (0.6 + 0.32 * arriba) * (0.92 + 0.16 * azar(v.x, v.z, v.y));
    tonos.set([hoja.r * f, hoja.g * f, hoja.b * f], i * 3);
  }
  c.computeVertexNormals();
  c.setAttribute('color', new THREE.BufferAttribute(tonos, 3));
  let g = c;
  if (!chico) {
    const alto = copa.abajo + (copa.C.y - copa.abajo) * 0.5, r = e.tronco.r * 1.4; // más grueso: de lejos se pierde
    const t = new THREE.CylinderGeometry(r * 0.6, r, alto, 6, 1, true);
    t.deleteAttribute('uv');
    t.translate(0, alto / 2, 0);
    const cor = new THREE.Color(e.corteza), ct = new Float32Array(t.attributes.position.count * 3);
    for (let i = 0; i < ct.length; i += 3) ct.set([cor.r, cor.g, cor.b], i);
    t.setAttribute('color', new THREE.BufferAttribute(ct, 3));
    g = mergeGeometries([t, c]);
  }
  g.scale(1 / H, 1 / H, 1 / H);
  return g;
}

// Cerca normalizado a altura 1 por la altura del nivel 0; la lejana con la misma escala.
function armar(cbs, copa, e) {
  const H = cbs[0].alto;
  return { cerca: cbs.map((cb) => cb.geometria(1 / H)), lejos: geometriaLejos(e, copa, H) };
}

function geometriasPalma(e, semilla, medidas) {
  const rng = mulberry32(semilla ^ 0x5bd1e995), R = (a, b) => a + (b - a) * rng();
  const [tronco] = crecerArbol(e, semilla), cima = tronco.pts[tronco.pts.length - 1];
  const [anchoT, altoT] = medidas[FRONDA], F = e.frondas, colores = e.follaje.map((c) => new THREE.Color(c));
  // Frondas en espiral: las de arriba suben, las de abajo cuelgan.
  const frondas = Array.from({ length: F.n }, (_, i) => {
    const az = i * 2.39996 + R(-0.2, 0.2), largo = F.largo * R(0.85, 1.1);
    return {
      sal: new V3(Math.cos(az), 0, Math.sin(az)), elev: lerp(1.1, -0.4, i / (F.n - 1)) + R(-0.1, 0.1), curva: R(0.9, 1.4),
      largo, media: (anchoT * largo) / altoT / 2, rnd: rng(), espejo: rng() < 0.5,
    };
  });
  // Filas a lo largo del raquis: punto y normal de la cinta en el plano vertical.
  const camino = (f, segs) => {
    const filas = [], p = cima.clone(), d = new V3();
    for (let i = 0; i <= segs; i++) {
      if (i > 0) {
        const am = f.elev - f.curva * ((i - 0.5) / segs) ** 2;
        p.addScaledVector(d.copy(f.sal).multiplyScalar(Math.cos(am)).setY(Math.sin(am)), f.largo / segs);
      }
      const a = f.elev - f.curva * (i / segs) ** 2;
      filas.push({ p: p.clone(), n: new V3(-f.sal.x * Math.sin(a), Math.cos(a), -f.sal.z * Math.sin(a)) });
    }
    return filas;
  };
  const copa = hacerCopa(frondas.flatMap((f) => camino(f, 6).map((fila) => fila.p)));
  const corteza = new THREE.Color(e.corteza);
  const cbs = [[7, 1, 6], [4, 3, 3]].map(([radial, salto, segs]) => {
    const cb = new Constructor();
    tubo(cb, tronco, radial, salto, () => 0.9, corteza, e.estilo);
    for (const f of frondas) fronda(cb, camino(f, segs), f, copa, colores[Math.floor(f.rnd * 2.999)]);
    return cb;
  });
  return armar(cbs, copa, e);
}

// [nivel 0, nivel 1] de cerca y la versión lejana de una forma y variante.
function geometriasArbol(forma, variante, medidas) {
  const e = { ...ESPECIES[forma], ...(ESPECIES[forma].variantes?.[variante] ?? {}) };
  const semilla = 7919 * (forma + 1) + 104729 * (variante + 1);
  if (e.frondas) return geometriasPalma(e, semilla, medidas);
  const todas = crecerArbol(e, semilla);

  // Copa según el follaje de máximo detalle: las tarjetas empujan medio tamaño hacia afuera.
  const rngC = mulberry32(semilla ^ 0x5bd1e995);
  const aprox = hacerCopa(todas.filter((b) => b.nivel === 3).map((b) => b.pts[b.pts.length - 1]));
  const tarjetas0 = ponerTarjetas(e, todas, 0, medidas, rngC, aprox);
  const copa = hacerCopa(tarjetas0.flatMap((c) => [c.en.clone().addScaledVector(c.arriba, c.alto * 0.5), c.en.clone().addScaledVector(c.arriba, c.alto)]));
  const marcar = (r) => (c) => ({ ...c, espejo: r() < 0.5, rnd: r() });
  // La cáscara es igual en los dos niveles: misma forma, textura y fase del viento.
  const rngK = mulberry32(semilla + 62674), cascara = ponerTarjetas(e, todas, 2, medidas, rngK, copa).map(marcar(rngK));
  const colores = e.follaje.map((c) => new THREE.Color(c)), corteza = new THREE.Color(e.corteza);
  const aoCorteza = (p) => copa.corteza(p);

  const cbs = [0, 1].map((lod) => {
    const cb = new Constructor(), rng = mulberry32(semilla + lod * 31337), hasta = e.tubos[lod];
    // Las ramitas van dibujadas en las tarjetas; la corteza se simplifica con la distancia.
    for (const b of todas) {
      if (b.nivel > hasta) continue;
      if (lod === 0) tubo(cb, b, [5, 3, 3][b.nivel], [2, 3, 4][b.nivel], aoCorteza, corteza, e.estilo);
      else tubo(cb, b, 3, b.nivel === 0 ? 4 : 8, aoCorteza, corteza, e.estilo);
    }
    const propias = lod === 0 ? tarjetas0 : e.cascaraSola ? [] : ponerTarjetas(e, todas, 1, medidas, rng, copa);
    for (const c of propias.map(marcar(rng)).filter((_, i) => i % 2 === 0)) tarjeta(cb, c, copa, colores[Math.floor(c.rnd * 2.999)]);
    for (const c of cascara) tarjeta(cb, c, copa, colores[Math.floor(c.rnd * 2.999)]);
    return cb;
  });
  return armar(cbs, copa, e);
}

// ---------------------------------------------------------------------------------------------------------------
// 5. Materiales
// ---------------------------------------------------------------------------------------------------------------

// Luz del sol que atraviesa las hojas (aproximación rápida de Barré-Brisebois y Bouchard): mirando a contraluz la
// hoja brilla con la luz que deja pasar. Toma el color de la luz directa, así que las sombras también la apagan.
class LuzFollaje extends THREE.PhysicalLightingModel {
  direct(datos, builder) {
    const { lightDirection, lightColor, reflectedLight } = datos;
    const traslucido = builder.material.traslucidoNode;
    if (traslucido) {
      const dispersa = normalize(lightDirection.add(normalView.mul(0.3)));
      const atraviesa = pow(clamp(dot(positionViewDirection, dispersa.negate()), 0.0, 1.0), 3.0);
      reflectedLight.directDiffuse.addAssign(lightColor.mul(traslucido).mul(atraviesa));
    }
    super.direct(datos, builder);
  }
}

class MaterialArbol extends THREE.MeshStandardNodeMaterial {
  static get type() { return 'MaterialArbol'; }

  constructor(parametros) {
    super(parametros);
    this.traslucidoNode = null;
  }

  setupLightingModel() { return new LuzFollaje(); }
}

// Viento alisio del este-sureste: sopla hacia el oeste-noroeste (x = este, z = sur).
const VIENTO = vec2(-0.92, -0.38);
// Tono por árbol: unos más amarillos, otros más azulados, más claros u oscuros.
const tinte = (rnd) => mix(vec3(1.1, 1.05, 0.8), vec3(0.88, 0.97, 1.08), rnd).mul(fract(rnd.mul(7.31)).mul(0.32).add(0.84));

// aSitio (por instancia) = (x, y de la base, z, 2·altura + azar). positionLocal ya viene instanciado y el grupo no
// se mueve, así que está en coordenadas del mundo.
function materialCerca(atlas, uCamara) {
  const m = new MaterialArbol({ side: THREE.DoubleSide, alphaToCoverage: true, metalness: 0, roughness: 0.8 });
  m.alphaTest = 0.5;
  const hoja = texture(atlas, uv()), dat = attribute('aHoja', 'vec4'), sitio = attribute('aSitio', 'vec4');
  const base = attribute('color', 'vec3'), esHoja = dat.x, ao = dat.y, rnd = fract(sitio.w);

  m.positionNode = Fn(() => {
    const p = positionLocal, g = positionGeometry, alto = floor(sitio.w).mul(0.5), fase = rnd.mul(6.2832);
    // rachas que cruzan la ciudad a favor del viento
    const racha = sin(time.mul(0.5).sub(dot(p.xz, VIENTO).mul(0.045))).mul(0.5).add(0.5);
    const fuerza = racha.mul(racha).mul(0.7).add(0.3);
    // el árbol entero se dobla según la altura: se inclina a favor del viento y se mece de lado
    const curva = g.y.mul(g.y);
    const inclina = sin(time.mul(0.85).add(fase)).mul(0.45).add(0.55).mul(fuerza).mul(alto).mul(0.018);
    const mece = sin(time.mul(0.67).add(fase.mul(1.7))).mul(fuerza).mul(alto).mul(0.005);
    const vaiven = vec3(VIENTO.x.mul(inclina).sub(VIENTO.y.mul(mece)), 0, VIENTO.y.mul(inclina).add(VIENTO.x.mul(mece))).mul(curva);
    // las ramas suben y bajan con una fase continua por la copa (no se despegan) y cada hoja tiembla
    const sube = sin(time.mul(2.1).add(g.x.mul(7)).add(g.z.mul(5)).add(fase)).mul(alto).mul(0.004).mul(dat.z).mul(fuerza);
    const tiembla = sin(time.mul(8).add(dat.w.mul(37)).add(g.y.mul(16))).mul(0.03).mul(esHoja).mul(dat.z).mul(fuerza.add(0.25));
    const movido = p.add(vaiven).add(vec3(0, sube, 0)).add(normalLocal.mul(tiembla));
    // más allá de CERCA lo dibuja la versión lejana: se colapsa a un punto
    return mix(movido, sitio.xyz, step(CERCA, distance(sitio.xyz, uCamara)));
  })();

  const tono = base.mul(tinte(rnd));
  m.colorNode = Fn(() => {
    // Hojas: tono del árbol por el brillo del atlas, algunas amarillas de sol y otras más frías, ramitas cafés,
    // más oscuras adentro de la copa.
    const claro = tono.mul(hoja.r.mul(1.4));
    const tibia = smoothstep(0.62, 1.0, hoja.g).mul(0.55), fria = float(1).sub(smoothstep(0.0, 0.38, hoja.g)).mul(0.45);
    const hojas = mix(mix(claro, claro.mul(vec3(1.25, 1.08, 0.5)), tibia), claro.mul(vec3(0.8, 0.92, 1.05)), fria);
    const follaje = mix(hojas, color(0x4a3b2c), hoja.b).mul(ao.mul(0.45).add(0.55));
    // Corteza (uv en metros): estilo 0 surcos, 1 anillos de palma, 2 parches que se pelan del eucalipto.
    const bu = uv(), estilo = dat.w;
    const surcos = abs(sin(bu.x.mul(18).add(sin(bu.y.mul(2.3).add(rnd.mul(6))).mul(1.5)))).mul(0.45).add(0.6);
    const anillos = sin(bu.y.mul(40)).mul(0.08).add(0.95);
    const parches = mix(float(1.3), float(0.85), smoothstep(0.1, 0.4, sin(bu.x.mul(4.5).add(sin(bu.y.mul(1.7)).mul(2))).mul(sin(bu.y.mul(2.1).add(bu.x.mul(1.3))))));
    const marca = mix(mix(surcos, anillos, step(0.5, estilo)), parches, step(1.5, estilo));
    const corteza = base.mul(marca).mul(ao.mul(0.4).add(0.6));
    // Cobertura: hojas según el atlas; la corteza solo por fuera (sus caras de atrás se descartan).
    return vec4(mix(corteza, follaje, esHoja), mix(float(frontFacing), hoja.a, esHoja));
  })();
  // Sombras moteadas: el mapa de sombras recorta las hojas con el mismo atlas.
  m.maskShadowNode = mix(float(1), hoja.a, esHoja).greaterThan(0.5);
  m.roughnessNode = mix(float(0.93), float(0.72).sub(hoja.r.mul(0.1)), esHoja);
  // Las tarjetas usan la normal de la cáscara por las dos caras: sin voltearla atrás.
  m.normalNode = normalViewGeometry;
  m.aoNode = ao.mul(0.75).add(0.25);
  // Luz a través de las hojas: verde amarillenta, más fuerte en la cáscara delgada.
  m.traslucidoNode = tono.mul(vec3(1.0, 1.2, 0.45)).mul(hoja.r.mul(1.5)).mul(ao.mul(0.8).add(0.2)).mul(esHoja);
  return m;
}

function materialLejos(uCamara) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
  const sitio = attribute('aSitio', 'vec4');
  // los que están a menos de CERCA los dibuja el campo cercano: se colapsan a un punto
  m.positionNode = mix(positionLocal, sitio.xyz, step(distance(sitio.xyz, uCamara), CERCA));
  m.colorNode = attribute('color', 'vec3').mul(tinte(fract(sitio.w)));
  return m;
}

// ---------------------------------------------------------------------------------------------------------------
// 6. Bosque: copas lejanas por celdas fijas y campo cercano que se rehace al moverse la cámara.
// ---------------------------------------------------------------------------------------------------------------
export function mallasArboles(lista, terreno, excluir = () => false) {
  const grupo = new THREE.Group();
  grupo.name = 'Arboles';
  const { textura, medidas } = crearAtlas();
  // Posición de la cámara para los shaders: la de la pasada de sombras sería la del sol.
  const uCamara = uniform(new V3(0, 30, 0));
  const matCerca = materialCerca(textura, uCamara), matLejos = materialLejos(uCamara);
  const geos = FORMAS.map((_, f) => [0, 1].map((v) => geometriasArbol(f, v, medidas))); // [forma][variante]

  // Datos por árbol. Tipo = forma·2 + variante (en la palma la variante 1 es la alta).
  const n = lista.length, X = new Float32Array(n), Y = new Float32Array(n), Z = new Float32Array(n);
  const A = new Float32Array(n), B = new Float32Array(n), ALTO = new Float32Array(n), W = new Float32Array(n), TIPO = new Uint8Array(n);
  let N = 0;
  for (const a of lista) {
    if (excluir(a)) continue;
    const k = N++, f = a.forma, h = Math.max(f === 4 ? 0.6 : 1, a.alt);
    const ancho = h * (0.85 + azar(a.x, a.z, 1) * 0.3), giro = azar(a.x, a.z, 2) * Math.PI * 2;
    const variante = f === 2 ? (h > 12 ? 1 : 0) : (azar(a.x, a.z, 3) < 0.5 ? 0 : 1);
    X[k] = a.x; Y[k] = terreno.altura(a.x, a.z) - 0.2; Z[k] = a.z;
    A[k] = Math.cos(giro) * ancho; B[k] = Math.sin(giro) * ancho; ALTO[k] = h;
    W[k] = Math.round(h * 2) + azar(a.x, a.z, 4) * 0.99;
    TIPO[k] = f * 2 + variante;
  }
  // Matriz = traslación · giro en y · escala (ancho, alto, ancho), por columnas como la guarda three.js.
  const escribir = (m, o, k) => {
    m[o] = A[k]; m[o + 1] = 0; m[o + 2] = -B[k]; m[o + 3] = 0;
    m[o + 4] = 0; m[o + 5] = ALTO[k]; m[o + 6] = 0; m[o + 7] = 0;
    m[o + 8] = B[k]; m[o + 9] = 0; m[o + 10] = A[k]; m[o + 11] = 0;
    m[o + 12] = X[k]; m[o + 13] = Y[k]; m[o + 14] = Z[k]; m[o + 15] = 1;
  };
  const sitio = (s, o, k) => { s[o] = X[k]; s[o + 1] = Y[k]; s[o + 2] = Z[k]; s[o + 3] = W[k]; };

  // Lejos: una malla por celda y tipo lejano (la forma; la palma alta aparte).
  const celdas = new Map();
  for (let k = 0; k < N; k++) {
    const lejos = TIPO[k] === 5 ? 5 : TIPO[k] >> 1, llave = `${Math.floor(X[k] / CELDA)},${Math.floor(Z[k] / CELDA)},${lejos}`;
    if (!celdas.has(llave)) celdas.set(llave, []);
    celdas.get(llave).push(k);
  }
  const arbustosLejos = [];
  for (const [llave, ks] of celdas) {
    const lejos = Number(llave.split(',')[2]), base = lejos === 5 ? geos[2][1].lejos : geos[lejos][0].lejos;
    const g = new THREE.BufferGeometry();
    for (const nombre of Object.keys(base.attributes)) g.setAttribute(nombre, base.attributes[nombre]);
    g.setIndex(base.index);
    g.setAttribute('aSitio', new THREE.InstancedBufferAttribute(new Float32Array(ks.length * 4), 4));
    const malla = new THREE.InstancedMesh(g, matLejos, ks.length);
    ks.forEach((k, i) => { escribir(malla.instanceMatrix.array, i * 16, k); sitio(g.attributes.aSitio.array, i * 4, k); });
    malla.computeBoundingSphere();
    malla.receiveShadow = true;
    malla.matrixAutoUpdate = false;
    if (lejos === 4) arbustosLejos.push(malla);
    grupo.add(malla);
  }

  // Cerca: una malla por tipo y nivel, con cupo para todos los árboles del tipo (solo se suben los que se usan).
  const cupo = new Uint32Array(10);
  for (let k = 0; k < N; k++) cupo[TIPO[k]]++;
  const cerca = [];
  for (let t = 0; t < 10; t++) {
    for (let lod = 0; lod < 2; lod++) {
      if (!cupo[t]) { cerca.push(null); continue; }
      const g = geos[t >> 1][t & 1].cerca[lod];
      g.setAttribute('aSitio', new THREE.InstancedBufferAttribute(new Float32Array(cupo[t] * 4), 4));
      const malla = new THREE.InstancedMesh(g, matCerca, cupo[t]);
      Object.assign(malla, { count: 0, visible: false, frustumCulled: false, castShadow: t >> 1 !== 4, receiveShadow: true, matrixAutoUpdate: false });
      grupo.add(malla);
      cerca.push(malla);
    }
  }
  const cuenta = new Uint32Array(cerca.length);

  // Rejilla para encontrar los cercanos sin recorrer los 70.000.
  const cubos = new Map(), llaveCubo = (i, j) => (i + 32768) * 65536 + (j + 32768);
  for (let k = 0; k < N; k++) {
    const c = llaveCubo(Math.floor(X[k] / CUBO), Math.floor(Z[k] / CUBO));
    if (!cubos.has(c)) cubos.set(c, []);
    cubos.get(c).push(k);
  }

  function armarCampo(c) {
    cuenta.fill(0);
    const r = CERCA + MARGEN, r2 = r * r, d2Detalle = DETALLE * DETALLE;
    for (let i = Math.floor((c.x - r) / CUBO); i <= Math.floor((c.x + r) / CUBO); i++) {
      for (let j = Math.floor((c.z - r) / CUBO); j <= Math.floor((c.z + r) / CUBO); j++) {
        const ks = cubos.get(llaveCubo(i, j));
        if (!ks) continue;
        for (const k of ks) {
          const dx = X[k] - c.x, dy = Y[k] - c.y, dz = Z[k] - c.z, d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > r2) continue;
          const q = TIPO[k] * 2 + (d2 < d2Detalle ? 0 : 1), malla = cerca[q], o = cuenta[q]++;
          escribir(malla.instanceMatrix.array, o * 16, k);
          sitio(malla.geometry.attributes.aSitio.array, o * 4, k);
        }
      }
    }
    cerca.forEach((malla, q) => {
      if (!malla) return;
      const usados = cuenta[q];
      malla.count = usados;
      malla.visible = usados > 0;
      if (!usados) return;
      for (const atr of [malla.instanceMatrix, malla.geometry.attributes.aSitio]) {
        atr.clearUpdateRanges();
        atr.addUpdateRange(0, usados * atr.itemSize);
        atr.needsUpdate = true;
      }
    });
  }

  // Arranca alrededor de la Plaza de Bolívar para que el primer compilado vea las mallas cercanas.
  const ultimo = uCamara.value.clone();
  armarCampo(ultimo);

  // Llamar en cada cuadro. El viento usa el tiempo de TSL: no hace falta pasarlo.
  grupo.userData.actualizar = (camara) => {
    const c = camara.position;
    uCamara.value.copy(c);
    if (c.distanceToSquared(ultimo) > PASO * PASO) { ultimo.copy(c); armarCampo(c); }
    for (const malla of arbustosLejos) malla.visible = c.distanceTo(malla.boundingSphere.center) - malla.boundingSphere.radius < ARBUSTOS_HASTA;
  };
  return grupo;
}
