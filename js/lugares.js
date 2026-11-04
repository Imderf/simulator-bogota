import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  attribute, fract, step, floor, hash, mix, vec3, float, uniform, sin, abs, smoothstep, max, min, positionWorld, time,
  clamp, exp, normalWorld, mx_noise_float,
} from 'three/tsl';
import { noche } from './edificios.js';

// Lugares emblemáticos de la zona Centro, armados a mano sobre las plantas de OpenStreetMap
// (datos/centro/lugares.json). Medidas y fuentes en docs/lugares.md. Lo que no tiene fuente va marcado "aprox.".

// ---------------------------------------------------------------------------------------------------------------
// Utilidades de geometría. Todo lleva el atributo `fachada` (u = metros a lo largo del muro, v = metros de altura)
// para que los materiales dibujen piedra, ladrillo y ventanas sin texturas.
// ---------------------------------------------------------------------------------------------------------------
const area = (p) => { let a = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j][0] * p[i][1] - p[i][0] * p[j][1]; return a / 2; };

function adentro([x, z], anillo) {
  let dentro = false;
  for (let i = 0, j = anillo.length - 1; i < anillo.length; j = i++) {
    const [xi, zi] = anillo[i], [xj, zj] = anillo[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) dentro = !dentro;
  }
  return dentro;
}

// Rectángulo de área mínima alineado con alguno de los lados: da el giro y el tamaño de cada edificio.
function rectangulo(anillo) {
  let mejor = null;
  for (let i = 0; i < anillo.length; i++) {
    const [ax, az] = anillo[i], [bx, bz] = anillo[(i + 1) % anillo.length];
    const ang = Math.atan2(bz - az, bx - ax), c = Math.cos(ang), s = Math.sin(ang);
    let u0 = Infinity, u1 = -Infinity, w0 = Infinity, w1 = -Infinity;
    for (const [x, z] of anillo) {
      const u = x * c + z * s, w = -x * s + z * c;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); w0 = Math.min(w0, w); w1 = Math.max(w1, w);
    }
    const a = (u1 - u0) * (w1 - w0);
    if (!mejor || a < mejor.a) {
      const um = (u0 + u1) / 2, wm = (w0 + w1) / 2;
      mejor = { a, ang, c, s, cx: um * c - wm * s, cz: um * s + wm * c, mu: (u1 - u0) / 2, mw: (w1 - w0) / 2 };
    }
  }
  // Punto del mundo a partir de coordenadas locales (u a lo largo, w a lo ancho).
  mejor.punto = (u, w) => [mejor.cx + u * mejor.c - w * mejor.s, mejor.cz + u * mejor.s + w * mejor.c];
  // Lado (u o w, signo) que mira hacia un punto: ahí va la fachada principal.
  mejor.ladoHacia = ([x, z]) => {
    const dx = x - mejor.cx, dz = z - mejor.cz;
    const u = dx * mejor.c + dz * mejor.s, w = -dx * mejor.s + dz * mejor.c;
    return Math.abs(u) / mejor.mu > Math.abs(w) / mejor.mw ? { eje: 'u', signo: Math.sign(u) } : { eje: 'w', signo: Math.sign(w) };
  };
  return mejor;
}

class Obra {
  constructor() { this.partes = new Map(); }
  agregar(material, geo) {
    if (!this.partes.has(material)) this.partes.set(material, []);
    this.partes.get(material).push(geo);
  }

  // Prisma vertical a partir de una planta (con huecos opcionales).
  prisma(material, anillo, y0, y1, huecos = [], { techo = true, piso = false } = {}) {
    const pos = [], fac = [];
    const anillos = [anillo, ...huecos].map((r, i) => ((i === 0) === (area(r) > 0) ? r : [...r].reverse()));
    for (const r of anillos) {
      let u = 0;
      for (let i = 0; i < r.length; i++) {
        const [ax, az] = r[i], [bx, bz] = r[(i + 1) % r.length], l = Math.hypot(bx - ax, bz - az);
        const q = [[ax, y0, az, u, 0], [bx, y1, bz, u + l, y1 - y0], [bx, y0, bz, u + l, 0],
          [ax, y0, az, u, 0], [ax, y1, az, u, y1 - y0], [bx, y1, bz, u + l, y1 - y0]];
        for (const [x, y, z, fu, fv] of q) { pos.push(x, y, z); fac.push(fu, fv); }
        u += l;
      }
    }
    const tapa = (y, arriba) => {
      const c = anillos[0].map(([x, z]) => new THREE.Vector2(x, z)), h = anillos.slice(1).map((r) => r.map(([x, z]) => new THREE.Vector2(x, z)));
      const pts = [...c, ...h.flat()];
      for (const t of THREE.ShapeUtils.triangulateShape(c, h)) {
        let tri = t.map((k) => pts[k]);
        const cruz = (tri[1].x - tri[0].x) * (tri[2].y - tri[0].y) - (tri[1].y - tri[0].y) * (tri[2].x - tri[0].x);
        if ((cruz > 0) === arriba) tri = tri.reverse();
        for (const p of tri) { pos.push(p.x, y, p.y); fac.push(p.x, -1); }
      }
    };
    if (techo) tapa(y1, true);
    if (piso) tapa(y0, false);
    this.agregar(material, geometria(pos, fac));
  }

  // Caja girada con el marco de un rectángulo: centro (u, w), medio ancho (du, dw).
  caja(material, r, u, w, du, dw, y0, y1) {
    this.prisma(material, [r.punto(u - du, w - dw), r.punto(u + du, w - dw), r.punto(u + du, w + dw), r.punto(u - du, w + dw)], y0, y1);
  }

  cilindro(material, [x, z], radio, y0, y1, lados = 16) {
    const p = [];
    for (let i = 0; i < lados; i++) { const a = (i / lados) * Math.PI * 2; p.push([x + Math.cos(a) * radio, z + Math.sin(a) * radio]); }
    this.prisma(material, p, y0, y1);
  }

  // Sólido de revolución (cúpulas, linternas, agujas) con su perfil [radio, altura]. `fase` gira las esquinas
  // cuando tiene pocos lados (un torno de 4 lados es una pirámide cuadrada).
  torno(material, [x, z], perfil, lados = 16, fase = 0) {
    const g = new THREE.LatheGeometry(perfil.map(([r, y]) => new THREE.Vector2(r, y)), lados, fase).toNonIndexed();
    g.translate(x, 0, z);
    const p = g.attributes.position, fac = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) { fac[i * 2] = Math.atan2(p.getZ(i) - z, p.getX(i) - x) * 4; fac[i * 2 + 1] = p.getY(i); }
    g.deleteAttribute('uv');
    g.deleteAttribute('normal');
    g.setAttribute('fachada', new THREE.BufferAttribute(fac, 2));
    g.computeVertexNormals();
    this.agregar(material, g);
  }

  // Frontón triangular sobre una fachada: base de ancho 2·du a la altura y0, alto h, grosor 2·dw.
  fronton(material, r, u, w, du, dw, y0, h) {
    const a = r.punto(u - du, w), b = r.punto(u + du, w), pos = [], fac = [];
    const ex = -r.s * dw, ez = r.c * dw;
    const cara = (s) => {
      const cima = [(a[0] + b[0]) / 2 + ex * s, y0 + h, (a[1] + b[1]) / 2 + ez * s];
      const tri = [[a[0] + ex * s, y0, a[1] + ez * s], [b[0] + ex * s, y0, b[1] + ez * s], cima];
      for (const p of s > 0 ? tri : [tri[0], tri[2], tri[1]]) { pos.push(...p); fac.push(0, p[1] - y0); }
    };
    cara(1); cara(-1);
    for (const [p, q] of [[a, b], [b, a]]) {
      const cima = [(a[0] + b[0]) / 2, y0 + h, (a[1] + b[1]) / 2];
      const v = [[p[0] - ex, y0, p[1] - ez], [p[0] + ex, y0, p[1] + ez], [cima[0] + ex, cima[1], cima[2] + ez], [cima[0] - ex, cima[1], cima[2] - ez]];
      for (const k of [0, 2, 1, 0, 3, 2]) { pos.push(...v[k]); fac.push(0, 1); }
    }
    this.agregar(material, geometria(pos, fac));
  }

  // Disco vertical (relojes) mirando hacia `normal` ([x, z]).
  disco(material, [x, y, z], normal, radio) {
    const g = new THREE.CylinderGeometry(radio, radio, 0.25, 24).toNonIndexed();
    g.rotateX(Math.PI / 2);
    g.rotateY(Math.atan2(normal[0], normal[1]));
    g.translate(x + normal[0] * 0.15, y, z + normal[1] * 0.15);
    g.deleteAttribute('uv');
    g.setAttribute('fachada', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    this.agregar(material, g);
  }

  // Marco de una fachada: `a` corre a lo largo del frente y `b` sale hacia afuera (0 = plano del frente).
  frente(r, lado) {
    const f = (lado.eje === 'u' ? r.mu : r.mw) * lado.signo;
    const L = (a, b) => (lado.eje === 'u' ? [f + b * lado.signo, a] : [a, f + b * lado.signo]);
    const normal = lado.eje === 'u' ? [r.c * lado.signo, r.s * lado.signo] : [-r.s * lado.signo, r.c * lado.signo];
    return {
      L, normal, largo: lado.eje === 'u' ? r.mw : r.mu,
      punto: (a, b) => r.punto(...L(a, b)),
      // Lo contrario de punto(): [a, b] de un punto del mundo.
      ab: ([x, z]) => {
        const dx = x - r.cx, dz = z - r.cz, u = dx * r.c + dz * r.s, w = -dx * r.s + dz * r.c;
        return lado.eje === 'u' ? [w, (u - f) * lado.signo] : [u, (w - f) * lado.signo];
      },
      // Pieza rectangular pegada al frente: ancho a lo largo, fondo hacia afuera.
      panel: (material, a, b, ancho, fondo, y0, y1) => {
        const [u, w] = L(a, b);
        const [du, dw] = lado.eje === 'u' ? [fondo / 2, ancho / 2] : [ancho / 2, fondo / 2];
        this.caja(material, r, u, w, du, dw, y0, y1);
      },
    };
  }

  mallas(nombre) {
    const grupo = new THREE.Group();
    grupo.name = nombre;
    for (const [material, geos] of this.partes) {
      const m = new THREE.Mesh(mergeGeometries(geos), material);
      m.castShadow = m.receiveShadow = true;
      grupo.add(m);
    }
    return grupo;
  }
}

function geometria(pos, fac) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('fachada', new THREE.Float32BufferAttribute(fac, 2));
  g.computeVertexNormals();
  return g;
}

// Talla un entrante rectangular en el frente de una planta (pórticos): de a0 a a1 a lo largo del frente y `fondo`
// metros hacia adentro. Si no encuentra el muro del frente, devuelve la planta igual.
function entallar(anillo, F, a0, a1, fondo) {
  for (let i = 0; i < anillo.length; i++) {
    const p = anillo[i], q = anillo[(i + 1) % anillo.length], [ap, bp] = F.ab(p), [aq, bq] = F.ab(q);
    if (Math.abs(bp) > 2 || Math.abs(bq) > 2 || Math.min(ap, aq) > a0 || Math.max(ap, aq) < a1) continue;
    const b = (a) => bp + ((bq - bp) * (a - ap)) / (aq - ap);
    const [c, d] = ap < aq ? [a0, a1] : [a1, a0];
    return [...anillo.slice(0, i + 1), F.punto(c, b(c)), F.punto(c, -fondo), F.punto(d, -fondo), F.punto(d, b(d)), ...anillo.slice(i + 1)];
  }
  return anillo;
}

// ---------------------------------------------------------------------------------------------------------------
// Superficies suaves para la estatua: filas de puntos unidas con normales promediadas (como el personaje).
// ---------------------------------------------------------------------------------------------------------------
const P = (x, y, z) => new THREE.Vector3(x, y, z);
const suave = (x) => { const k = Math.min(1, Math.max(0, x)); return k * k * (3 - 2 * k); };
const lobulo = (a, a0, ancho) => { let d = a - a0; d -= Math.round(d / (Math.PI * 2)) * Math.PI * 2; return Math.exp(-(d * d) / (ancho * ancho)); };
const azar = (k) => { const s = Math.sin(k * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

function geometriaSuave(pos, idx) {
  const g = new THREE.BufferGeometry();
  g.setIndex(idx);
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

// Une filas de puntos: cerradas (anillos) o abiertas. Las caras miran hacia afuera cuando cada fila gira a
// izquierdas alrededor del sentido en que avanzan las filas.
function unir(filas, cerrada) {
  const n = filas[0].length, pos = [], idx = [];
  for (const f of filas) for (const p of f) pos.push(p.x, p.y, p.z);
  for (let i = 0; i < filas.length - 1; i++) for (let j = 0; j < (cerrada ? n : n - 1); j++) {
    const a = i * n + j, b = i * n + ((j + 1) % n);
    idx.push(a, a + n, b, b, a + n, b + n);
  }
  return { pos, idx };
}

// Tubo por los puntos de `eje`: en cada uno, un anillo superelíptico perpendicular al eje con radios [de lado,
// adelante, atrás] (o un número). En un eje vertical a = π/2 es el frente (+z). `bulto(a, i)` empuja el anillo i.
// Las tapas llevan vértices propios para no redondear el borde del tubo.
function tubo(eje, radios, n = 12, { ex = 2, bulto = null, tapas = true } = {}) {
  const t = P(0, 0, 0), lado = P(0, 0, 0), frente = P(0, 0, 0), arriba = P(0, 1, 0), adelante = P(0, 0, 1);
  const filas = eje.map((c, i) => {
    t.subVectors(eje[Math.min(i + 1, eje.length - 1)], eje[Math.max(i - 1, 0)]).normalize();
    lado.crossVectors(t, Math.abs(t.z) > 0.8 ? arriba : adelante).normalize();
    frente.crossVectors(lado, t);
    const r = radios[i], [rx, rd, ra] = typeof r === 'number' ? [r, r, r] : r;
    return Array.from({ length: n }, (_, j) => {
      const a = (j / n) * Math.PI * 2, co = Math.cos(a), si = Math.sin(a), b = bulto ? bulto(a, i) : 0;
      return c.clone()
        .addScaledVector(lado, Math.sign(co) * Math.abs(co) ** (2 / ex) * (rx + b))
        .addScaledVector(frente, Math.sign(si) * Math.abs(si) ** (2 / ex) * ((si >= 0 ? rd : ra) + b));
    });
  });
  const { pos, idx } = unir(filas, true);
  if (tapas) for (const k of [0, filas.length - 1]) {
    const ini = pos.length / 3, centro = P(0, 0, 0);
    for (const p of filas[k]) { pos.push(p.x, p.y, p.z); centro.add(p); }
    centro.divideScalar(n);
    pos.push(centro.x, centro.y, centro.z);
    for (let j = 0; j < n; j++) {
      const a = ini + j, b = ini + ((j + 1) % n), c = ini + n;
      idx.push(...(k === 0 ? [c, a, b] : [c, b, a]));
    }
  }
  return geometriaSuave(pos, idx);
}

// Lámina abierta (el manto): f(t, s) con t de arriba (0) a abajo (1) y s girando a izquierdas. Se recorre de abajo
// hacia arriba para que las caras miren hacia afuera.
function lamina(f, filas, columnas) {
  const grilla = [];
  for (let i = filas; i >= 0; i--) grilla.push(Array.from({ length: columnas + 1 }, (_, j) => f(i / filas, j / columnas)));
  const { pos, idx } = unir(grilla, false);
  return geometriaSuave(pos, idx);
}

// ---------------------------------------------------------------------------------------------------------------
// Estatua de Bolívar (Pietro Tenerani, 1846), en el cuerpo de una persona de 1,75 m que mira a +z con los pies en
// y = 0 y su izquierda en +x. Pose según las fotos de Commons: casaca larga con charretera y botas altas, el manto
// sobre el hombro izquierdo que baja por la espalda y cruza adelante a la cintura, el rollo de la Constitución en
// la mano izquierda y la espada hacia el piso en la derecha.
// ---------------------------------------------------------------------------------------------------------------
// Casaca: [y, de lado, adelante, atrás, centro z (positivo = adelante)].
const CASACA = [
  [1.575, 0.05, 0.048, 0.052, -0.006], // cuello alto
  [1.545, 0.066, 0.064, 0.068, -0.006],
  [1.51, 0.085, 0.074, 0.08, -0.01],
  [1.48, 0.165, 0.09, 0.09, -0.015],
  [1.445, 0.205, 0.105, 0.095, -0.015], // hombros
  [1.39, 0.2, 0.12, 0.1, -0.01],
  [1.3, 0.183, 0.126, 0.1, 0],
  [1.2, 0.166, 0.118, 0.095, 0.005],
  [1.1, 0.158, 0.112, 0.094, 0.005], // cintura
  [1.0, 0.172, 0.116, 0.11, 0],
  [0.9, 0.19, 0.125, 0.13, -0.005],
  [0.78, 0.205, 0.135, 0.15, -0.01],
  [0.66, 0.215, 0.14, 0.165, -0.015], // faldón hasta la rodilla
  [0.635, 0.19, 0.12, 0.14, -0.015],
];
// Cabeza del personaje (js/personaje.js) vuelta hacia +z, con el mismo formato.
const CABEZA = [
  [1.752, 0.018, 0.018, 0.02, -0.012],
  [1.738, 0.056, 0.058, 0.064, -0.013],
  [1.712, 0.078, 0.082, 0.092, -0.013],
  [1.682, 0.087, 0.09, 0.102, -0.011],
  [1.652, 0.088, 0.093, 0.103, -0.009],
  [1.622, 0.084, 0.094, 0.098, -0.007],
  [1.592, 0.078, 0.095, 0.09, -0.005],
  [1.562, 0.071, 0.091, 0.078, -0.002],
  [1.537, 0.063, 0.085, 0.066, 0.002],
  [1.514, 0.052, 0.074, 0.054, 0.008],
  [1.497, 0.03, 0.048, 0.032, 0.016],
];
// Nariz, cejas, mentón y orejas, y el pelo crespo con patillas: más volumen arriba, a los lados y atrás.
function relieve(y, a) {
  const frente = Math.PI / 2;
  let b = 0;
  if (Math.abs(y - 1.592) < 0.02) b += 0.018 * lobulo(a, frente, 0.16);
  if (Math.abs(y - 1.622) < 0.02) b += 0.008 * lobulo(a, frente, 0.14);
  if (Math.abs(y - 1.652) < 0.02) b += 0.005 * lobulo(a, frente, 0.6);
  if (Math.abs(y - 1.514) < 0.012) b += 0.007 * lobulo(a, frente, 0.35);
  if (y < 1.64 && y > 1.575) b += 0.011 * (lobulo(a, 0, 0.22) + lobulo(a, Math.PI, 0.22));
  const pelo = y > 1.66 ? 1 : suave((y - 1.56) / 0.1) * (1 - lobulo(a, frente, 1.0));
  return b + pelo * (0.01 + 0.004 * Math.sin(9 * a + y * 120));
}

function casacaEn(y) {
  if (y >= CASACA[0][0]) return CASACA[0].slice(1);
  for (let i = 0; i < CASACA.length - 1; i++) if (y >= CASACA[i + 1][0]) {
    const [a, b] = [CASACA[i], CASACA[i + 1]], t = (a[0] - y) / (a[0] - b[0]);
    return a.slice(1).map((v, k) => v + (b[k + 1] - v) * t);
  }
  return CASACA.at(-1).slice(1);
}

// Punto del manto en el ángulo a (0 = costado izquierdo, π/2 = frente) a la altura y: holgura que crece hacia
// abajo, el brazo izquierdo debajo y pliegues verticales cada vez más hondos.
function vueloManto(a, y, t, capa) {
  const si = Math.sin(a), co = Math.cos(a), [rx, rd, ra, cz] = casacaEn(Math.max(y, 0.66));
  const brazo = 0.09 * lobulo(a, 0.15, 0.9) * suave((1.47 - y) / 0.1) * suave((y - 1.0) / 0.08);
  const pliegue = (0.003 + 0.03 * t * t) * (0.6 * Math.sin(7 * a + 0.5) + 0.4 * Math.sin(13 * a + 2));
  const h = 0.018 + 0.1 * t * t + brazo + pliegue + capa;
  return P(co * (rx + h), y, cz + si * ((si >= 0 ? rd : ra) + h));
}

function estatuaBolivar() {
  const partes = [];
  const eje = (filas) => filas.map(([y, , , , cz]) => P(0, y, cz)), radios = (filas) => filas.map(([, rx, rd, ra]) => [rx, rd, ra]);
  partes.push(tubo(eje(CASACA), radios(CASACA), 24, { ex: 2.2 }));
  // La cabeza mira un poco hacia abajo y a su derecha.
  const cabeza = tubo(eje(CABEZA), radios(CABEZA), 22, { bulto: (a, i) => relieve(CABEZA[i][0], a) });
  const pivote = P(0, 1.53, 0);
  cabeza.applyMatrix4(new THREE.Matrix4().makeTranslation(pivote).multiply(new THREE.Matrix4().makeRotationY(-0.15))
    .multiply(new THREE.Matrix4().makeRotationX(0.1)).multiply(new THREE.Matrix4().makeTranslation(pivote.clone().negate())));
  partes.push(cabeza);

  // Piernas con botas altas: la derecha recta (carga el peso) y la izquierda un poco adelante, con la rodilla suelta.
  const PIERNA = [[0.75, 0.07], [0.6, 0.062], [0.5, 0.057], [0.475, 0.066], [0.445, 0.06], [0.32, 0.056], [0.18, 0.046], [0.09, 0.044]];
  // Pie: [z desde el tobillo, y, medio ancho, arriba, abajo].
  const PIE = [[-0.075, 0.05, 0.03, 0.025, 0.04], [-0.035, 0.055, 0.043, 0.045, 0.05], [0.04, 0.052, 0.045, 0.04, 0.047],
    [0.12, 0.045, 0.044, 0.028, 0.04], [0.18, 0.036, 0.038, 0.018, 0.031], [0.215, 0.03, 0.018, 0.01, 0.022]];
  for (const [cadera, rodilla, tobillo, giro] of [[[-0.095, -0.005], [-0.095, 0.005], [-0.095, -0.005], -0.12], [[0.1, 0], [0.11, 0.06], [0.125, 0.11], 0.3]]) {
    const en = (y) => {
      const [a, b, f] = y > 0.5 ? [rodilla, cadera, (y - 0.5) / 0.25] : [tobillo, rodilla, (y - 0.09) / 0.41];
      return P(a[0] + (b[0] - a[0]) * f, y, a[1] + (b[1] - a[1]) * f);
    };
    partes.push(tubo(PIERNA.map(([y]) => en(y)), PIERNA.map(([, r]) => r), 12));
    const c = Math.cos(giro), s = Math.sin(giro);
    partes.push(tubo(PIE.map(([z, y]) => P(tobillo[0] + z * s, y, tobillo[1] + z * c)), PIE.map(([, , an, ar, ab]) => [an, ar, ab]), 10, { ex: 2.4 }));
  }

  // Brazos: el derecho cuelga con el puño en la empuñadura; el izquierdo baja bajo el manto y cruza el vientre.
  const MANGA = [0.056, 0.064, 0.06, 0.056, 0.053, 0.05, 0.048, 0.052, 0.034];
  partes.push(tubo([P(-0.19, 1.47, -0.01), P(-0.215, 1.42, -0.01), P(-0.232, 1.33, -0.015), P(-0.246, 1.24, -0.02), P(-0.256, 1.16, -0.015),
    P(-0.263, 1.07, 0), P(-0.269, 0.98, 0.025), P(-0.272, 0.935, 0.04), P(-0.274, 0.918, 0.045)], MANGA, 12));
  partes.push(tubo([P(0.19, 1.47, -0.01), P(0.215, 1.42, -0.01), P(0.235, 1.3, 0), P(0.242, 1.16, 0.02), P(0.215, 1.115, 0.075),
    P(0.15, 1.105, 0.135), P(0.09, 1.105, 0.18), P(0.055, 1.108, 0.2), P(0.04, 1.11, 0.205)], MANGA, 12));
  partes.push(tubo([P(-0.275, 0.925, 0.05), P(-0.279, 0.89, 0.06), P(-0.281, 0.85, 0.067), P(-0.282, 0.82, 0.07)],
    [[0.028, 0.03, 0.03], [0.04, 0.042, 0.04], [0.042, 0.044, 0.042], [0.03, 0.03, 0.03]], 10));
  partes.push(tubo([P(0.045, 1.125, 0.21), P(-0.01, 1.132, 0.235), P(-0.07, 1.13, 0.243), P(-0.105, 1.12, 0.24)],
    [[0.03, 0.022, 0.022], [0.042, 0.024, 0.02], [0.04, 0.02, 0.018], [0.022, 0.012, 0.012]], 10));
  // Rollo de la Constitución, horizontal bajo la mano izquierda.
  partes.push(tubo([P(-0.2, 1.088, 0.212), P(-0.19, 1.088, 0.212), P(0.15, 1.095, 0.19), P(0.16, 1.095, 0.19)], [0.04, 0.047, 0.047, 0.04], 14));

  // Espada: hoja recta de sección rombo hacia el piso, por delante y afuera del pie derecho; gavilán y pomo.
  const mano = P(-0.281, 0.86, 0.066), d = P(-0.2, -1, 0.3).normalize(), en = (k) => mano.clone().addScaledVector(d, k);
  partes.push(tubo([0.06, 0.1, 0.4, 0.75, 0.86].map(en), [[0.016, 0.004, 0.004], [0.016, 0.004, 0.004], [0.013, 0.0035, 0.0035], [0.007, 0.003, 0.003], [0.0015, 0.001, 0.001]], 4, { ex: 1 }));
  const travesano = P(0, 0, 0).crossVectors(d, P(0, 1, 0)).normalize();
  partes.push(tubo([-0.07, -0.03, 0.03, 0.07].map((k) => en(0.055).addScaledVector(travesano, k)), [0.006, 0.009, 0.009, 0.006], 6));
  partes.push(tubo([-0.04, -0.06, -0.085].map(en), [0.012, 0.02, 0.008], 8));

  // Charretera en el hombro derecho, con flecos (el manto tapa la izquierda).
  partes.push(tubo([P(-0.13, 1.478, -0.01), P(-0.17, 1.476, -0.01), P(-0.215, 1.466, -0.01), P(-0.245, 1.45, -0.01)],
    [[0.008, 0.045, 0.045], [0.016, 0.062, 0.062], [0.018, 0.072, 0.072], [0.012, 0.064, 0.064]], 12));
  partes.push(tubo([P(-0.228, 1.46, -0.01), P(-0.231, 1.425, -0.01), P(-0.233, 1.39, -0.01)], [0.07, 0.074, 0.076], 20, { bulto: (a) => 0.005 * Math.cos(a * 10), tapas: false }));

  // Manto: del hombro izquierdo baja por la espalda hasta el piso y cruza adelante a la cintura, recogido bajo el
  // antebrazo; el borde de adelante cae hasta las canillas. Encima, la vuelta que cuelga del hombro.
  partes.push(lamina((t, s) => {
    const k = suave(t / 0.35), a = -2.0 - 0.5 * k + (2.9 + 1.7 * k) * s, si = Math.sin(a);
    const y0 = 1.49 - 0.04 * Math.abs(si), y1 = 0.04 + 0.26 * Math.max(0, si) ** 0.8;
    return vueloManto(a, y0 + (y1 - y0) * t, t, 0);
  }, 22, 34));
  partes.push(lamina((t, s) => {
    const a = -1.9 + 2.3 * s;
    return vueloManto(a, 1.505 - (0.17 * (0.45 + 0.55 * lobulo(a, -0.7, 1.1)) + 0.012 * Math.sin(6 * a)) * t, 0.25 * t, 0.022);
  }, 5, 18));
  return partes;
}

// Faroles de la plaza en el marco de la plaza: [eje fijo, valor, desde, paso, cuántos]. Posiciones aprox.
const FAROLES = [['u', -49, -36, 12.67, 7], ['u', 58.5, -36, 12.67, 7], ['w', -41.5, -40, 12.86, 8], ['w', 45, -40, 12.86, 8]];

// ---------------------------------------------------------------------------------------------------------------
// Materiales: piedra arenisca, estuco, ladrillo, teja, vidrio y la fachada de LED de Colpatria. Todo con TSL.
// ---------------------------------------------------------------------------------------------------------------
const fac = () => attribute('fachada', 'vec2');

function piedra(color, { bloque = [1.4, 0.55], ventanas = null } = {}) {
  const f = fac();
  const fila = floor(f.y.div(bloque[1]));
  const ju = fract(f.x.div(bloque[0]).add(fila.mul(0.5))), jv = fract(f.y.div(bloque[1]));
  const junta = max(step(ju, 0.03), step(jv, 0.05)).mul(step(0.0, f.y));
  const ruido = hash(floor(f.x.div(bloque[0]).add(fila.mul(0.5))).add(fila.mul(57.0))).mul(0.08);
  let c = vec3(...new THREE.Color(color).toArray()).mul(float(0.96).add(ruido)).mul(float(1).sub(junta.mul(0.22)));
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 });
  if (ventanas) {
    const [ancho, alto, desde] = ventanas;
    const vx = fract(f.x.div(ancho)), vy = fract(f.y.sub(desde).div(alto));
    const v = step(0.3, vx).mul(step(vx, 0.7)).mul(step(0.25, vy)).mul(step(vy, 0.8)).mul(step(desde, f.y));
    c = mix(c, vec3(0.13, 0.15, 0.17), v);
    m.emissiveNode = vec3(1.0, 0.8, 0.5).mul(v).mul(noche).mul(0.9);
  }
  m.colorNode = c;
  return m;
}

function ladrillo(color, { ventanas = null } = {}) {
  const f = fac();
  const fila = floor(f.y.div(0.075));
  const ju = fract(f.x.div(0.25).add(fila.mul(0.5))), jv = fract(f.y.div(0.075));
  const junta = max(step(ju, 0.06), step(jv, 0.12));
  // De lejos las juntas se funden en un tono medio para no hacer moiré.
  const lejos = smoothstep(40.0, 160.0, positionWorld.sub(cameraPos).length());
  const tinte = hash(floor(f.x.div(0.25).add(fila.mul(0.5))).add(fila.mul(31.0))).mul(0.12);
  const base = vec3(...new THREE.Color(color).toArray());
  let c = mix(base.mul(float(0.94).add(tinte)).mul(float(1).sub(junta.mul(0.25))), base.mul(0.93), lejos);
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.92 });
  if (ventanas) {
    const [ancho, alto] = ventanas;
    const vx = fract(f.x.div(ancho)), vy = fract(f.y.div(alto));
    const v = step(0.15, vx).mul(step(vx, 0.85)).mul(step(0.35, vy)).mul(step(vy, 0.82)).mul(step(3.0, f.y));
    c = mix(c, vec3(0.12, 0.14, 0.16), v.mul(0.9));
    m.emissiveNode = vec3(1.0, 0.78, 0.5).mul(v).mul(step(0.55, hash(floor(f.x.div(ancho)).add(floor(f.y.div(alto)).mul(91.0))))).mul(noche).mul(1.4);
  }
  m.colorNode = c;
  return m;
}

// Balaustrada: barrotes claros con huecos oscuros entre ellos, sin geometría extra.
function balaustrada(color) {
  const f = fac();
  const hueco = step(0.55, fract(f.x.div(0.38))).mul(step(0.18, f.y)).mul(step(f.y, 0.95));
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 });
  m.colorNode = mix(vec3(...new THREE.Color(color).toArray()), vec3(0.18, 0.17, 0.16), hueco);
  return m;
}

function plano(color, opciones = {}) {
  return new THREE.MeshStandardNodeMaterial({ color, roughness: 0.85, ...opciones });
}

// Colpatria: pilastras verticales de concreto blanco y franjas de vidrio (fotos de Commons).
// De noche las franjas son la pantalla de LED: unos 120 m de fachada con color animado.
export const cameraPos = uniform(new THREE.Vector3());
function colpatria(alto) {
  const f = fac();
  const franja = step(0.58, fract(f.x.div(1.55)));
  const conLed = step(alto - 120, f.y).mul(franja);
  const ola = fract(f.y.div(60).sub(time.mul(0.08)).add(sin(f.x.mul(0.05).add(time.mul(0.6))).mul(0.15)));
  const led = mix(mix(vec3(0.95, 0.1, 0.35), vec3(0.15, 0.4, 1.0), smoothstep(0.2, 0.5, ola)), vec3(1.0, 0.85, 0.2), smoothstep(0.6, 0.9, ola));
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.6 });
  m.colorNode = mix(vec3(0.86, 0.85, 0.82), vec3(0.12, 0.15, 0.18), franja);
  m.roughnessNode = mix(float(0.7), float(0.2), franja);
  m.emissiveNode = led.mul(conLed).mul(noche).mul(2.2);
  return m;
}

function vidrioTorre(color) {
  const f = fac();
  const losa = step(fract(f.y.div(3.2)), 0.12);
  const parteluz = step(fract(f.x.div(1.6)), 0.05);
  // Sin mapa de entorno un vidrio metálico se ve negro: se simula con poco metal y algo de brillo.
  const m = new THREE.MeshStandardNodeMaterial({ metalness: 0.08, roughness: 0.32 });
  const base = vec3(...new THREE.Color(color).toArray());
  m.colorNode = mix(base, base.mul(0.55), max(losa, parteluz));
  m.emissiveNode = vec3(0.9, 0.85, 0.7).mul(step(0.7, hash(floor(f.x.div(1.6)).add(floor(f.y.div(3.2)).mul(77.0))))).mul(noche).mul(0.8).mul(float(1).sub(losa));
  return m;
}

// Bronce de la estatua: pátina verde oscura donde escurre la lluvia (caras hacia arriba) y en manchas; el metal
// asoma en lo vertical y refleja el cielo. El manto es una lámina: se ve por los dos lados.
function bronce() {
  const ruido = mx_noise_float(positionWorld.mul(2.5)).mul(0.5).add(0.5);
  const patina = smoothstep(0.3, 0.75, normalWorld.y.mul(0.35).add(ruido.mul(0.6)).add(0.1));
  const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide });
  m.colorNode = mix(vec3(0.3, 0.2, 0.1), vec3(0.07, 0.12, 0.09), patina);
  m.metalnessNode = mix(float(0.85), float(0.25), patina);
  m.roughnessNode = mix(float(0.38), float(0.7), patina);
  return m;
}

// Piso de la Plaza de Bolívar en su marco (u, w): losas grises en hiladas con franjas rojizas en cuadrícula (fotos de
// Commons; medidas aprox.). De noche, el charco de luz de cada farol va pintado en el piso.
function pisoPlaza(r, lineas) {
  const dx = positionWorld.x.sub(r.cx), dz = positionWorld.z.sub(r.cz);
  const u = dx.mul(r.c).add(dz.mul(r.s)), w = dz.mul(r.c).sub(dx.mul(r.s));
  const fila = floor(u.div(0.6)), ju = fract(w.div(1.2).add(fila.mul(0.5))), jv = fract(u.div(0.6));
  // De lejos las juntas se funden para no hacer moiré.
  const lejos = smoothstep(30.0, 120.0, positionWorld.sub(cameraPos).length());
  const junta = max(step(ju, 0.03), step(jv, 0.05)).mul(float(1).sub(lejos));
  const tono = hash(floor(w.div(1.2).add(fila.mul(0.5))).add(fila.mul(57.0))).mul(0.1);
  const franja = (x) => step(abs(fract(x.div(7.5).add(0.5)).sub(0.5)).mul(7.5), 0.22);
  const gris = vec3(...new THREE.Color(0x8d8a83).toArray()), rojizo = vec3(...new THREE.Color(0x8e5c48).toArray());
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.85 });
  m.colorNode = mix(gris.mul(float(0.95).add(tono)), rojizo, max(franja(u), franja(w))).mul(float(1).sub(junta.mul(0.25)));
  let charco = float(0);
  for (const [eje, valor, desde, paso, n] of lineas) {
    const [a, b] = eje === 'u' ? [w, u] : [u, w];
    const da = a.sub(clamp(floor(a.sub(desde).div(paso).add(0.5)), 0, n - 1).mul(paso).add(desde)), db = b.sub(valor);
    charco = max(charco, exp(da.mul(da).add(db.mul(db)).mul(-1 / 16)));
  }
  m.emissiveNode = vec3(1.0, 0.78, 0.5).mul(charco).mul(noche).mul(0.55);
  return m;
}

// Vidrio de los faroles: claro de día y encendido de noche, por encima del umbral del bloom.
function vidrioFarol() {
  const m = new THREE.MeshStandardNodeMaterial({ color: 0xe9dcc0, roughness: 0.35 });
  m.emissiveNode = vec3(1.0, 0.82, 0.55).mul(noche.mul(3.4));
  return m;
}

// ---------------------------------------------------------------------------------------------------------------
// Los lugares.
// ---------------------------------------------------------------------------------------------------------------
export function construirLugares(datos, terreno, edificios) {
  const obra = new Obra();
  const suelo = (x, z) => terreno.altura(x, z);
  const minSuelo = (anillo) => Math.min(...anillo.map(([x, z]) => suelo(x, z)));
  // En los cerros la malla de 32 m redondea las cimas: se hace una explanada a la altura media de la planta.
  const explanada = (anillo, nivel) => {
    const y = nivel ?? anillo.reduce((s, [x, z]) => s + suelo(x, z), 0) / anillo.length;
    terreno.aplanar(anillo, y);
    return y;
  };
  const M = {
    arenisca: piedra(0xcdb88e),
    areniscaVentanas: piedra(0xcbb68c, { ventanas: [4.2, 6.5, 3] }),
    areniscaOscura: piedra(0xb8a47c),
    estucoAmarillo: piedra(0xe2cf8f, { bloque: [3, 3], ventanas: [3.6, 6, 0] }),
    estucoBlanco: piedra(0xf1eee6, { bloque: [3, 3] }),
    blancoVentanas: piedra(0xeeebe2, { bloque: [3, 3], ventanas: [3, 3.2, 1] }),
    ladrilloSalmona: ladrillo(0xb4643c, { ventanas: [3.2, 2.9] }),
    ladrilloPlaza: ladrillo(0x9a4a30),
    teja: plano(0xa4532f, { roughness: 0.8 }),
    pizarra: plano(0x55585c, { roughness: 0.6, metalness: 0.2 }),
    cupulaGris: plano(0x8f8a7e, { roughness: 0.7 }),
    bronce: plano(0x4a3c2a, { roughness: 0.4, metalness: 0.7 }),
    arena: plano(0xc9a874),
    colpatria: colpatria(192),
    vidrioAzul: vidrioTorre(0x7f98b0),
    vidrioGris: vidrioTorre(0x8e98a3),
    cable: new THREE.LineBasicNodeMaterial({ color: 0x222222 }),
    cabina: plano(0xc0392b),
    madera: plano(0x5b3b22, { roughness: 0.7 }),
    sombra: plano(0x2a2622, { roughness: 1 }),
    reloj: plano(0xf2efe6, { roughness: 0.5 }),
    balaustrada: balaustrada(0xcdb88e),
    bronceEstatua: bronce(),
    pedestal: piedra(0xcabf9f, { bloque: [2.2, 1.0] }),
    piedraClara: piedra(0xd8ceb4, { bloque: [1.6, 0.8] }),
    hierro: plano(0x1d1f22, { roughness: 0.5, metalness: 0.5 }),
    farol: vidrioFarol(),
  };

  const excluir = [];
  const plantas = {};
  for (const [k, v] of Object.entries(datos)) plantas[k] = v;

  // --- Plaza de Bolívar. Centro y giro a partir de los cuatro edificios que la rodean. ----------------------
  const capitolio = rectangulo(plantas.capitolio.anillos[0]);
  const centroPlaza = [0, 0];
  for (const k of ['capitolio', 'justicia', 'catedral', 'lievano']) {
    const r = rectangulo(plantas[k].anillos[0]);
    centroPlaza[0] += r.cx / 4; centroPlaza[1] += r.cz / 4;
  }
  const yPlaza = suelo(...centroPlaza);
  // Marco de la plaza alineado con el Capitolio: u hacia el sur (Capitolio), w hacia el occidente (Liévano).
  const plaza = { ...capitolio, cx: centroPlaza[0], cz: centroPlaza[1] };
  plaza.punto = (u, w) => [plaza.cx + u * plaza.c - w * plaza.s, plaza.cz + u * plaza.s + w * plaza.c];
  // pisos: superficies caminables elevadas ({ anillo, y }); despejar: zonas sin farolas, árboles ni edificios del
  // catastro, pero sin choques; extras y reflectores se agregan al grupo al final.
  const pisos = [], despejar = [], extras = [], reflectores = [];
  let pedestal = null;
  {
    const yp = yPlaza, r = plaza;
    const cuadro = (u0, u1, w0, w1) => [r.punto(u0, w0), r.punto(u1, w0), r.punto(u1, w1), r.punto(u0, w1)];
    // La plaza es plana: se aplana el terreno del cuadrado y sus andenes.
    terreno.aplanar(cuadro(-64, 64, -64, 64), yp, 40);
    // Piso: una losa de fachada a fachada que tapa las calles peatonales (Calles 10 y 11, Carrera 7; la Carrera 8
    // queda afuera, con su calzada), un escalón y la plaza. La plaza de OSM (relation/13663349) mide ~100 × 80 m;
    // aquí sin el chaflán de su esquina. Unos 13.900 m² con las calles (es.wiki). Alturas de escalones aprox.
    M.pisoPlaza = pisoPlaza(r, FAROLES);
    const losa = (anillo, y0, y1, mat = M.pisoPlaza) => { obra.prisma(mat, anillo, y0, y1); pisos.push({ anillo, y: y1 }); };
    const zona = cuadro(-63, 71, -58, 46.5), ySq = yp + 0.85;
    losa(zona, yp - 2, yp + 0.55);
    losa([[-45.7, -37.2], [54.7, -38.7], [55.7, 41.7], [-44.7, 42.7]].map(([u, w]) => r.punto(u, w)), yp + 0.55, yp + 0.7);
    losa([[-45, -36.5], [54, -38], [55, 41], [-44, 42]].map(([u, w]) => r.punto(u, w)), yp + 0.7, ySq);
    despejar.push(zona);

    // Monumento a Bolívar sobre una plataforma de 14 × 14 m con escalón: el hueco del polígono de la plaza en OSM,
    // 20 m al sur del centro (ahí está también el nodo de la estatua, node/14135823651).
    const [U, W] = [19, -4], yPla = ySq + 0.7;
    losa(cuadro(U - 7.6, U + 7.6, W - 7.6, W + 7.6), ySq, ySq + 0.35, M.pedestal);
    losa(cuadro(U - 7, U + 7, W - 7, W + 7), ySq + 0.35, yPla, M.pedestal);
    // Pedestal de piedra clara (el de 1927, más alto que el de 1880): zócalo, fuste con placas de bronce en tres caras
    // y BOLIVAR en la del frente, cornisa y remate en gola. Proporciones tomadas de las fotos de Commons, aprox.
    obra.caja(M.pedestal, r, U, W, 1.35, 1.35, yPla, yPla + 0.5);
    obra.caja(M.pedestal, r, U, W, 1.05, 1.05, yPla + 0.5, yPla + 3.5);
    obra.caja(M.pedestal, r, U, W, 1.18, 1.18, yPla + 3.5, yPla + 3.65);
    // La gola es un torno de 4 lados con las esquinas en las diagonales de la plaza.
    const fase = Math.atan2(r.c - r.s, r.s + r.c);
    obra.torno(M.pedestal, r.punto(U, W), [[1.12, 0], [0.98, 0.06], [0.84, 0.17], [0.74, 0.3], [0.7, 0.42], [0, 0.42]].map(([m, y]) => [m * Math.SQRT2, yPla + 3.65 + y]), 4, fase);
    obra.caja(M.bronce, r, U, W, 0.62, 0.62, yPla + 4.07, yPla + 4.17);
    for (const [du, dw] of [[0, -1.08], [0, 1.08], [1.08, 0]]) obra.caja(M.bronce, r, U + du, W + dw, du ? 0.03 : 0.6, du ? 0.6 : 0.03, yPla + 1.3, yPla + 2.7);
    for (let i = 0; i < 7; i++) obra.caja(M.sombra, r, U - 1.06, W + (i - 3) * 0.2, 0.012, 0.065, yPla + 1.75, yPla + 2.02);
    pedestal = cuadro(U - 1.35, U + 1.35, W - 1.35, W + 1.35);
    // La figura: 2,45 m (aprox.), mirando al norte, hacia el Palacio de Justicia, como quedó en 1880 (es.wiki).
    const k = 2.45 / 1.75, [x, z] = r.punto(U, W);
    const matriz = new THREE.Matrix4().compose(new THREE.Vector3(x, yPla + 4.17, z),
      new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, Math.atan2(-r.c, -r.s)), new THREE.Vector3(k, k, k));
    for (const g of estatuaBolivar()) obra.agregar(M.bronceEstatua, g.applyMatrix4(matriz));

    // Faroles negros con farol de seis caras alrededor de la plaza y bolardos contra la Carrera 8 (fotos de Commons;
    // posiciones aprox.).
    for (const [eje, valor, desde, paso, n] of FAROLES) for (let i = 0; i < n; i++) {
      const p = eje === 'u' ? r.punto(valor, desde + i * paso) : r.punto(desde + i * paso, valor), y = yp + 0.55;
      obra.torno(M.hierro, p, [[0.17, 0], [0.17, 0.35], [0.1, 0.48], [0.06, 0.65], [0.05, 3.55], [0.09, 3.65], [0.08, 3.78]].map(([a, b]) => [a, y + b]), 6);
      obra.torno(M.farol, p, [[0.09, 3.78], [0.2, 3.92], [0.22, 4.28], [0, 4.28]].map(([a, b]) => [a, y + b]), 6);
      obra.torno(M.hierro, p, [[0.27, 4.28], [0.13, 4.46], [0.03, 4.6], [0, 4.75]].map(([a, b]) => [a, y + b]), 6);
    }
    for (let u = -60; u <= 68; u += 2.6) obra.torno(M.hierro, r.punto(u, 46.2), [[0.1, 0], [0.1, 0.62], [0.07, 0.78], [0, 0.84]].map(([a, b]) => [a, yp + 0.55 + b]), 6);

    // De noche: reflectores al pie de las fachadas y dos sobre la estatua (posiciones aprox.). La intensidad sale de
    // la distancia (caída 1,5) para que todo reciba más o menos la misma luz.
    const reflector = ([u, w, y], [tu, tw, ty], luz, angulo) => {
      const l = new THREE.SpotLight(0xffe2b8, 0, 0, angulo, 0.55, 1.5), [x0, z0] = r.punto(u, w), [x1, z1] = r.punto(tu, tw);
      l.position.set(x0, y + 0.45, z0);
      l.target.position.set(x1, ty, z1);
      const d = l.position.distanceTo(l.target.position);
      l.distance = d * 2.2;
      extras.push(l, l.target);
      reflectores.push([l, luz * d ** 1.5]);
      obra.caja(M.hierro, r, u, w, 0.25, 0.25, y, y + 0.35);
    };
    reflector([-10.8, -30, ySq], [-10.8, -58, yp + 20], 5.5, 0.8); // Catedral
    reflector([34, -1.9, ySq], [71, -1.9, yp + 10], 5.5, 0.9); // Capitolio
    reflector([1.7, 24, ySq], [1.7, 57, yp + 9], 5.5, 1.0); // Liévano
    reflector([-30, 0.5, ySq], [-63, 0.5, yp + 9], 5.5, 0.95); // Palacio de Justicia
    for (const t of [-1, 1]) reflector([U - 6.6, W + t * 6.6, yPla], [U, W, yPla + 5.3], 16, 0.3);

    // Palomas: instancias sencillas, más juntas cerca del monumento.
    const pisoEn = (x, z) => pisos.reduce((y, p) => (adentro([x, z], p.anillo) ? Math.max(y, p.y) : y), yp);
    const paloma = mergeGeometries([
      new THREE.OctahedronGeometry(1, 0).scale(0.085, 0.07, 0.16).translate(0, 0.08, 0),
      new THREE.OctahedronGeometry(1, 0).scale(0.04, 0.045, 0.05).translate(0, 0.16, 0.12),
    ]);
    const palomas = new THREE.InstancedMesh(paloma, new THREE.MeshStandardNodeMaterial({ roughness: 0.9 }), 150);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), escala = new THREE.Vector3(), color = new THREE.Color();
    for (let i = 0; i < palomas.count; i++) {
      let u = -42 + 94 * azar(i * 5 + 3), w = -34 + 72 * azar(i * 5 + 4);
      if (i % 3) { const rad = 9 + 10 * Math.sqrt(azar(i * 3 + 1)), ang = azar(i * 3 + 2) * Math.PI * 2; u = U + Math.cos(ang) * rad; w = W + Math.sin(ang) * rad; }
      const [x, z] = r.punto(u, w);
      palomas.setMatrixAt(i, m4.compose(pos.set(x, pisoEn(x, z), z), q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, azar(i * 7) * 6.3), escala.setScalar(0.85 + 0.3 * azar(i * 11))));
      palomas.setColorAt(i, azar(i * 13) < 0.08 ? color.set(0xd8d6d0) : color.setHSL(0.62, 0.08, 0.3 + 0.25 * azar(i * 17)));
    }
    palomas.computeBoundingSphere();
    palomas.name = 'Palomas';
    extras.push(palomas);
  }

  // --- Capitolio Nacional: piedra de cantería, dos pisos sobre un basamento y balaustrada. Al centro, "un cuerpo
  // central transparente a manera de pórtico" con "seis filas de tres columnas" jónicas (es.wiki): la columnata va
  // metida en el frente, no saliente (foto de Commons de 2009), y detrás queda el patio Mosquera. Alturas aprox.
  {
    const { anillos: [planta], huecos } = plantas.capitolio;
    const y0 = explanada(planta, yPlaza) // al nivel de la plaza;
    const r = capitolio, F = obra.frente(r, r.ladoHacia(centroPlaza));
    // El pórtico se talla en la planta: 29 m de ancho y 6,5 m de fondo, hasta antes del patio (aprox.).
    obra.prisma(M.arenisca, planta, y0 - 2, y0 + 3, huecos);
    obra.prisma(M.areniscaVentanas, entallar(planta, F, -14.5, 14.5, 6.5), y0 + 3, y0 + 15.5, huecos);
    obra.prisma(M.areniscaVentanas, planta, y0 + 15.5, y0 + 17, huecos, { piso: true });
    obra.prisma(M.areniscaOscura, planta, y0 + 17, y0 + 18.6, huecos);
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) obra.cilindro(M.arenisca, F.punto((i - 2.5) * 5.2, -1.2 - j * 2.2), 0.65, y0 + 3, y0 + 15.5, 12);
    // Balaustrada y urnas sobre la cornisa (foto de Commons de la fachada sur).
    obra.prisma(M.balaustrada, planta, y0 + 18.6, y0 + 19.8, huecos, { techo: false });
    for (let a = -F.largo + 4; a <= F.largo - 4; a += 9) {
      const p = F.punto(a, -0.4);
      obra.torno(M.areniscaOscura, p, [[0.45, y0 + 19.8], [0.55, y0 + 20.4], [0.3, y0 + 20.9], [0.42, y0 + 21.5], [0, y0 + 21.7]], 8);
    }
  }

  // --- Catedral Primada: dos torres de 52 m (es.wiki) en la fachada hacia la plaza, frontón al centro,
  // piedra arenisca clara. Puertas: la central de 7,20 × 3,60 m y las laterales de 5,60 × 2,80 m (es.wiki).
  // Proporciones de cornisas, campanarios y reloj medidas sobre la foto de Commons de 2021. Ancho ~48 m aprox.
  {
    const [planta] = plantas.catedral.anillos;
    const y0 = explanada(planta, yPlaza) // al nivel de la plaza;
    obra.prisma(M.arenisca, planta, y0 - 2, y0 + 24);
    const r = rectangulo(planta), F = obra.frente(r, r.ladoHacia(centroPlaza));
    const c = Math.max(-F.largo + 26, Math.min(F.largo - 26, 0));
    // Cuerpo central y frontón.
    F.panel(M.arenisca, c, -2.5, 30, 5, y0, y0 + 30);
    F.panel(M.areniscaOscura, c, -2.5, 31, 5.6, y0 + 30, y0 + 31);
    const [fu, fw] = F.L(c, -2.5);
    // fronton() corre a lo largo de u: si la fachada mira por u, se le pasa el marco girado.
    if (F.L(1, 0)[1] === 1) obra.fronton(M.areniscaOscura, { ...r, punto: (a, b) => r.punto(b, a), s: -r.c, c: r.s }, fw, fu, 12, 2.5, y0 + 31, 6.5);
    else obra.fronton(M.areniscaOscura, r, fu, fw, 12, 2.5, y0 + 31, 6.5);
    const cima = F.punto(c, -2.5);
    obra.cilindro(M.arenisca, cima, 0.5, y0 + 37.3, y0 + 39, 8);
    obra.caja(M.bronce, { ...r, punto: (u, w) => [cima[0] + u * r.c - w * r.s, cima[1] + u * r.s + w * r.c] }, 0, 0, 0.12, 0.6, y0 + 39, y0 + 40.6);
    // Cornisa principal a ~16,4 m y basamento a lo ancho de toda la fachada.
    F.panel(M.areniscaOscura, c, 0.3, 49, 1.2, y0 + 15.8, y0 + 17);
    F.panel(M.areniscaOscura, c, 0.2, 49, 1, y0, y0 + 1.1);
    // Pilastras del primer cuerpo.
    for (const a of [-14.5, -8, 8, 14.5]) F.panel(M.arenisca, c + a, 0.25, 1.4, 0.6, y0 + 1.1, y0 + 15.8);
    // Puertas de madera.
    F.panel(M.madera, c, 0.12, 3.6, 0.4, y0, y0 + 7.2);
    for (const t of [-1, 1]) F.panel(M.madera, c + t * 11.2, 0.12, 2.8, 0.4, y0, y0 + 5.6);
    // Hornacina sobre la puerta central.
    F.panel(M.sombra, c, 0.1, 2.2, 0.3, y0 + 20, y0 + 24.5);
    for (const t of [-1, 1]) {
      const a = c + t * 19.5;
      F.panel(M.arenisca, a, -4.5, 9.2, 9.2, y0, y0 + 30);
      F.panel(M.areniscaOscura, a, -4.5, 10, 10, y0 + 30, y0 + 31);
      F.panel(M.arenisca, a, -4.5, 8, 8, y0 + 31, y0 + 40);
      F.panel(M.areniscaOscura, a, -4.5, 8.6, 8.6, y0 + 40, y0 + 41);
      // Vanos de campanas (frente y costados) y ventana del cuerpo bajo de la torre.
      F.panel(M.sombra, a, -0.45, 2.2, 0.3, y0 + 33.4, y0 + 37.8);
      F.panel(M.sombra, a, 0.1, 1.8, 0.3, y0 + 19, y0 + 23.5);
      const p = F.punto(a, -4.5);
      obra.torno(M.cupulaGris, p, [[3.6, y0 + 41], [3.5, y0 + 43], [2.8, y0 + 45.5], [1.4, y0 + 47], [0.8, y0 + 47.2], [0, y0 + 47.3]]);
      obra.cilindro(M.arenisca, p, 0.75, y0 + 47, y0 + 49.5, 8);
      obra.torno(M.cupulaGris, p, [[0.85, y0 + 49.5], [0.5, y0 + 50.3], [0.1, y0 + 51.2], [0, y0 + 52]], 8);
      // Pináculos en las esquinas del campanario.
      for (const [da, db] of [[-3.6, -0.9], [3.6, -0.9]]) {
        const q = F.punto(a + da, db);
        obra.torno(M.arenisca, q, [[0.35, y0 + 41], [0.3, y0 + 42.2], [0, y0 + 43.4]], 6);
      }
    }
    // Reloj en la torre norte, la de San Emigdio (es.wiki).
    const norte = [-1, 1].map((t) => c + t * 19.5).sort((a, b) => F.punto(a, 0)[1] - F.punto(b, 0)[1])[0];
    const pr = F.punto(norte, -0.5);
    obra.disco(M.reloj, [pr[0], y0 + 32.2, pr[1]], F.normal, 0.95);
    excluir.push(planta);
  }

  // --- Palacio Liévano (Alcaldía): fachada amarilla con arcada en el primer piso, cubierta gris
  // y mansardas en las esquinas (foto de Commons de 2020). 3 niveles (es.wiki). Alturas aprox.
  {
    const { anillos: [planta], huecos } = plantas.lievano;
    const y0 = explanada(planta, yPlaza) // al nivel de la plaza;
    obra.prisma(M.estucoAmarillo, planta, y0 - 2, y0 + 17, huecos);
    obra.prisma(M.pizarra, planta, y0 + 17, y0 + 18.5, huecos);
    const r = rectangulo(planta), lado = r.ladoHacia(centroPlaza);
    const largo = lado.eje === 'u' ? r.mw : r.mu, f = (lado.eje === 'u' ? r.mu : r.mw) * lado.signo;
    for (const t of [-1, 1]) {
      const a = t * (largo - 9), b = f - lado.signo * 9;
      const [u, w] = lado.eje === 'u' ? [b, a] : [a, b];
      obra.caja(M.pizarra, r, u, w, 9, 9, y0 + 18.5, y0 + 24);
    }
    // Arcada del primer piso: vanos oscuros entre pilares, un poco hundidos.
    const F = obra.frente(r, lado);
    for (let a = -F.largo + 6; a <= F.largo - 6; a += 5.6) F.panel(M.sombra, a, 0.05, 3.4, 0.2, y0, y0 + 4.6);
    F.panel(M.estucoBlanco, 0, 0.25, F.largo * 2, 0.5, y0 + 5, y0 + 5.6);
    excluir.push(planta);
  }

  // --- Palacio de Justicia (Roberto Londoño): hacia la plaza, un bloque de piedra clara casi sin ventanas con una
  // entrada honda al centro y pórticos con columnas a los lados; detrás del patio, un bloque más alto con ventanas
  // (fotos de Commons). Alturas sin fuente: ~17 m el frente y ~28 m el de atrás, aprox.
  {
    const { anillos: [planta], huecos } = plantas.justicia;
    const y0 = explanada(planta, yPlaza) // al nivel de la plaza;
    const r = rectangulo(planta), F = obra.frente(r, r.ladoHacia(centroPlaza));
    obra.prisma(M.piedraClara, planta, y0 - 2, y0 + 17, huecos);
    F.panel(M.areniscaVentanas, 0, -76, 50, 34, y0, y0 + 28);
    F.panel(M.sombra, 0, 0.05, 14, 0.2, y0 + 0.5, y0 + 11);
    for (const t of [-1, 1]) {
      F.panel(M.sombra, t * 26, 0.05, 20, 0.2, y0 + 3, y0 + 12);
      for (const k of [-1, 1]) obra.cilindro(M.piedraClara, F.punto(t * 26 + k * 4, 1), 0.7, y0, y0 + 12.5, 10);
    }
    excluir.push(planta);
  }
  excluir.push(plantas.capitolio.anillos[0]);
  // El pedestal también choca. Va después de la Catedral: main.js toma solidos[0] como la Catedral.
  if (pedestal) excluir.push(pedestal);

  // --- Teatro Colón y Museo Nacional (antiguo Panóptico): prioridad 3 y 2, volumen simple.
  for (const [k, mat, alto] of [['teatroColon', M.estucoBlanco, 20], ['museoNacional', M.arenisca, 12]]) {
    const [planta] = plantas[k].anillos;
    const y0 = minSuelo(planta);
    obra.prisma(mat, planta, y0 - 2, y0 + alto);
    excluir.push(planta);
  }

  // --- Torre Colpatria: 196 m con helipuerto, mirador a 192 m (es.wiki, Structurae). Planta de OSM.
  {
    const [planta] = plantas.colpatria.anillos;
    const y0 = minSuelo(planta);
    const r = rectangulo(planta);
    const escala = (f) => planta.map(([x, z]) => [r.cx + (x - r.cx) * f, r.cz + (z - r.cz) * f]);
    // La punta se retrae en dos escalones (foto de Commons de 2021).
    obra.prisma(M.colpatria, planta, y0 - 2, y0 + 180);
    obra.prisma(M.colpatria, escala(0.93), y0 + 180, y0 + 187);
    obra.prisma(M.colpatria, escala(0.85), y0 + 187, y0 + 192);
    obra.caja(M.estucoBlanco, r, 0, 0, r.mu - 3, r.mw - 3, y0 + 192, y0 + 195);
    obra.cilindro(M.pizarra, [r.cx, r.cz], 7, y0 + 195, y0 + 196, 20);
    excluir.push(planta);
  }

  // --- BD Bacatá: Torre Sur 216 m y Torre Norte 167 m (es.wiki, Skyscraper Center). La planta de OSM
  // de la Torre Sur está incompleta, así que se toman las del catastro (las dos construcciones con más pisos).
  {
    const cerca = edificios.filter((e) => Math.hypot(e.cx - 640, e.cz + 760) < 120).sort((a, b) => b.pisos - a.pisos);
    const [sur, norte] = cerca;
    for (const [e, alto, mat] of [[sur, 216, M.vidrioAzul], [norte, 167, M.vidrioGris]]) {
      if (!e) continue;
      const planta = e.anillos[0], y0 = minSuelo(planta);
      obra.prisma(mat, planta, y0 - 2, y0 + alto);
      excluir.push(planta);
    }
  }

  // --- Edificio Avianca: 161 m y 41 pisos (es.wiki). Planta de OSM.
  {
    const [planta] = plantas.avianca.anillos, y0 = minSuelo(planta);
    obra.prisma(M.vidrioGris, planta, y0 - 2, y0 + 161);
    excluir.push(planta);
  }

  // --- Torres del Parque (Salmona): ladrillo a la vista. Torre A 117 m y 37 pisos (OSM, Pulzo);
  // B y C 20 pisos (OSM). Se escalonan hacia arriba como las terrazas reales (forma aprox.).
  for (const [k, pisos] of [['torreA', 37], ['torreB', 20], ['torreC', 20]]) {
    const [planta] = plantas[k].anillos, y0 = minSuelo(planta);
    const alto = k === 'torreA' ? 117 : pisos * 2.9;
    const r = rectangulo(planta);
    const escala = (f) => planta.map(([x, z]) => [r.cx + (x - r.cx) * f, r.cz + (z - r.cz) * f]);
    obra.prisma(M.ladrilloSalmona, planta, y0 - 2, y0 + alto * 0.62);
    obra.prisma(M.ladrilloSalmona, escala(0.86), y0 + alto * 0.62, y0 + alto * 0.84);
    obra.prisma(M.ladrilloSalmona, escala(0.7), y0 + alto * 0.84, y0 + alto);
    excluir.push(planta);
  }

  // --- Plaza de Toros La Santamaría: anillo de ladrillo neomudéjar (es.wiki) con ruedo de arena.
  // Alto sin fuente: ~15 m aprox.
  {
    const { anillos: [planta], huecos } = plantas.santamaria;
    const y0 = minSuelo(planta);
    obra.prisma(M.ladrilloPlaza, planta, y0 - 2, y0 + 15, huecos);
    if (huecos[0]) obra.prisma(M.arena, huecos[0], y0 - 1, y0 + 0.3);
    excluir.push(planta);
  }

  // --- Planetario: cilindro con cúpula. OSM da 10 m de alto; la cúpula es aprox.
  {
    const [planta] = plantas.planetario.anillos, y0 = minSuelo(planta);
    const r = rectangulo(planta), radio = Math.min(r.mu, r.mw);
    obra.prisma(M.estucoBlanco, planta, y0 - 2, y0 + 6);
    obra.torno(M.cupulaGris, [r.cx, r.cz], Array.from({ length: 9 }, (_, i) => {
      const a = (i / 8) * Math.PI / 2;
      return [Math.cos(a) * radio * 0.8, y0 + 6 + Math.sin(a) * 8];
    }), 28);
    excluir.push(planta);
  }

  // --- Monserrate: basílica blanca con UNA torre central y techos de teja (foto de Commons de 2017;
  // corrige la idea de dos torres). Cima a 3.152 m (es.wiki). Alturas de la torre aprox.
  {
    const [planta] = plantas.basilicaMonserrate.anillos, y0 = explanada(planta);
    obra.prisma(M.areniscaOscura, planta, y0 - 4, y0 + 0.6); // zócalo
    obra.prisma(M.blancoVentanas, planta, y0 + 0.6, y0 + 10);
    obra.prisma(M.teja, planta, y0 + 10, y0 + 10.6, [], { techo: true });
    const r = rectangulo(planta), lado = r.ladoHacia([0, 0]); // la fachada mira a la ciudad
    const f = ((lado.eje === 'u' ? r.mu : r.mw) - 6) * lado.signo;
    const [u, w] = lado.eje === 'u' ? [f, 0] : [0, f];
    obra.caja(M.estucoBlanco, r, u, w, 3.2, 3.2, y0, y0 + 26);
    obra.caja(M.estucoBlanco, r, u, w, 2.4, 2.4, y0 + 26, y0 + 31);
    obra.caja(M.estucoBlanco, r, u, w, 1.7, 1.7, y0 + 31, y0 + 34);
    const p = r.punto(u, w);
    obra.torno(M.estucoBlanco, p, [[1.5, y0 + 34], [0.2, y0 + 38], [0, y0 + 38.2]], 8);
    obra.cilindro(M.bronce, p, 0.08, y0 + 38, y0 + 40, 4);
    for (const k of ['estacionTelefericoArriba', 'estacionFunicularArriba', 'estacionAbajo']) {
      const [pl] = plantas[k].anillos, ys = k === 'estacionAbajo' ? minSuelo(pl) : explanada(pl);
      obra.prisma(M.areniscaOscura, pl, ys - 3, ys + 0.5);
      obra.prisma(M.blancoVentanas, pl, ys + 0.5, ys + 7);
      obra.prisma(M.teja, pl, ys + 7, ys + 7.5);
    }
    excluir.push(planta);
  }

  // --- Guadalupe: ermita y la Virgen de 15 m (es.wiki). La figura es una silueta aprox.
  {
    const [planta] = plantas.guadalupe.anillos, y0 = explanada(planta);
    obra.prisma(M.areniscaOscura, planta, y0 - 3, y0 + 0.5);
    obra.prisma(M.estucoBlanco, planta, y0 + 0.5, y0 + 8);
    const r = rectangulo(planta), p = r.punto(-r.mu - 12, 0), ys = suelo(...p);
    obra.cilindro(M.arenisca, p, 2.5, ys - 2, ys + 4, 8);
    obra.torno(M.estucoBlanco, p, [[0, ys + 4], [1.6, ys + 4], [1.3, ys + 9], [0.9, ys + 14], [0.75, ys + 15.2], [0.9, ys + 16.5], [0.6, ys + 18.4], [0, ys + 19]], 12);
  }

  const grupo = obra.mallas('Lugares');
  grupo.add(...extras);

  // --- Funicular (vía sobre el cerro) y teleférico (cable entre estaciones, con su cabina roja).
  const tramos = ['funicular3', 'funicular2', 'funicular1'].map((k) => plantas[k].anillos[0]).flat();
  const via = [];
  for (let i = 0; i < tramos.length - 1; i++) {
    const [ax, az] = tramos[i], [bx, bz] = tramos[i + 1], n = Math.ceil(Math.hypot(bx - ax, bz - az) / 6);
    for (let s = 0; s < n; s++) { const t = s / n, x = ax + (bx - ax) * t, z = az + (bz - az) * t; via.push(new THREE.Vector3(x, suelo(x, z) + 0.6, z)); }
  }
  if (via.length) grupo.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(via), M.cable));

  const ruta = plantas.teleferico.anillos[0];
  const a = ruta[0], b = ruta.at(-1);
  const pa = new THREE.Vector3(a[0], suelo(...a) + 9, a[1]), pb = new THREE.Vector3(b[0], suelo(...b) + 9, b[1]);
  const cable = [];
  for (let i = 0; i <= 40; i++) { const t = i / 40, p = pa.clone().lerp(pb, t); p.y -= Math.sin(t * Math.PI) * 18; cable.push(p); }
  grupo.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(cable), M.cable));
  const cabina = new THREE.Mesh(new THREE.BoxGeometry(3, 2.6, 2.2), M.cabina);
  cabina.castShadow = true;
  grupo.add(cabina);
  const curva = new THREE.CatmullRomCurve3(cable);
  const animar = (t) => {
    const k = (Math.sin(t * 0.12) + 1) / 2; // va y vuelve
    curva.getPointAt(k, cabina.position);
    cabina.position.y -= 2;
    cabina.lookAt(pb.x, cabina.position.y, pb.z);
    // Los reflectores de la plaza se encienden con la noche, como las farolas.
    const fuerza = Math.min(1.25, Math.max(0, (noche.value - 0.2) * 1.5));
    for (const [l, intensidad] of reflectores) l.intensity = intensidad * fuerza;
  };

  const dentro = (e) => (p) => adentro([e.cx, e.cz], p);
  return { grupo, animar, excluir: (e) => excluir.some(dentro(e)) || despejar.some(dentro(e)), solidos: excluir, centroPlaza, pisos };
}

// Puntos para el menú de lugares. La cámara se para del lado de `desde` (por defecto, la Plaza de Bolívar),
// a `dist` metros del objetivo y `alto` metros por encima del suelo.
// Paradas del tour, en orden de recorrido a pie desde la Plaza de Bolívar hasta el norte. Coordenadas de los
// lugares nuevos: centro de su polígono o nodo en OpenStreetMap. Guadalupe, Bacatá y Avianca siguen en la ciudad
// pero salen del menú: no son paradas de un recorrido turístico.
export function puntosDeVista(datos, centroPlaza) {
  const centro = (k) => rectangulo(datos[k].anillos[0]);
  const v = (k, nombre, nota, dist, alto, extra = {}) => { const r = centro(k); return { nombre, nota, x: r.cx, z: r.cz, dist, alto, desde: centroPlaza, ...extra }; };
  const p = (x, z, nombre, nota, dist, alto, extra = {}) => ({ nombre, nota, x, z, dist, alto, ...extra });
  return [
    p(centroPlaza[0], centroPlaza[1], 'Plaza de Bolívar', 'Catedral, Capitolio, Liévano y Palacio de Justicia', 260, 120),
    p(-164, 293, 'Casa de Nariño', 'Palacio presidencial y cambio de guardia', 220, 90, { desde: centroPlaza }),
    p(184, 156, 'Teatro Colón', 'Teatro nacional de 1892', 170, 70),
    p(334, 132, 'Museo Botero y Luis Ángel Arango', 'Manzana cultural del Banco de la República', 210, 95),
    p(703, 103, 'Chorro de Quevedo', 'Donde se fundó Bogotá en 1538', 160, 70),
    p(450, 80, 'La Candelaria', 'Casas coloniales, teja y grafiti', 420, 260),
    p(352, -380, 'Museo del Oro', 'Parque Santander e Iglesia de San Francisco', 230, 95),
    p(620, -440, 'Eje Ambiental', 'Avenida Jiménez y su canal de agua', 260, 90),
    p(1472, -501, 'Quinta de Bolívar', 'Casa museo al pie de Monserrate', 210, 90),
    // A pie o en carro se llega a la estación de abajo del funicular y el teleférico, no a la cima.
    v('basilicaMonserrate', 'Monserrate', 'Teleférico, funicular y vista de la ciudad', 300, 90, { llegada: [centro('estacionAbajo').cx, centro('estacionAbajo').cz] }),
    v('colpatria', 'Torre Colpatria', 'Mirador y fachada de LED', 480, 200),
    v('museoNacional', 'Museo Nacional', 'Antiguo Panóptico', 230, 95),
    v('planetario', 'Planetario', 'Parque de la Independencia', 260, 120),
    v('torreA', 'Torres del Parque', 'Salmona y La Santamaría', 380, 160),
  ];
}
