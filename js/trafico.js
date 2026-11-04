import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { attribute, vertexColor, positionLocal, float, vec3, color, mix, step, smoothstep, abs, fract, max, min, fwidth } from 'three/tsl';
import { noche } from './edificios.js';
import { crearVehiculo } from './vehiculos.js';
import { anchoVia } from './vias.js';

// Tráfico: taxis, carros particulares, camionetas, motos y buses del SITP por las vías de carros (clases 0-3, sin
// TransMilenio), cada uno en su carril y en el sentido en que se maneja. La red de carriles se arma una vez; cada
// vehículo sigue su carril con el modelo de conductor inteligente (IDM), pasa los cruces por curvas de unión y se
// turna con los demás para entrar a cada cruce. Solo hay tráfico en un radio alrededor del jugador: los vehículos
// aparecen y se retiran donde la cámara no los ve. Se dibuja con instancias: unas pocas llamadas por tipo.
// Adaptado de Slop New York (mrdoob, MIT): js/traffic.js (IDM, aparición alrededor del foco, visibilidad con los
// planos laterales del frustum y estado de frenos por instancia).

const RADIO = 380; // m alrededor del jugador donde hay tráfico
const VISTA_LIBRE = 320; // más lejos que esto de la cámara, aparecer o desaparecer ya no se nota
const CELDA = 24; // rejilla de vehículos para buscar al de adelante
const CELDA_RED = 64; // rejilla de aristas para aparecer cerca del jugador
const VEL_CLASE = [16, 13.5, 11, 8.5]; // m/s deseados por clase (≈ 58, 49, 40 y 31 km/h)
const PESO_CLASE = [3, 2.5, 1.4, 0.6]; // las avenidas llevan más carros que las calles locales
const llave = (i, j) => i * 100003 + j;
let ronda = 0; // marca de las aristas ya vistas al buscar las cercanas (compartida si hay varias simulaciones)

// ---------------------------------------------------------------------------------------------------------------
// Densidad por hora. No encontré en datos abiertos de la Secretaría de Movilidad una curva horaria descargable sin
// llave, así que es una curva razonable: picos de 6 a 9 y de 17 a 20, mediodía medio, noche baja, madrugada casi nada.
// Valor en cada hora en punto (0 a 1); en pico además baja la velocidad libre (`fluidez`).
// ---------------------------------------------------------------------------------------------------------------
const CURVA = [0.06, 0.04, 0.03, 0.03, 0.08, 0.35, 0.85, 1, 0.9, 0.65, 0.55, 0.58,
  0.68, 0.66, 0.58, 0.6, 0.7, 0.92, 1, 0.88, 0.6, 0.4, 0.25, 0.12];
export function densidad(hora) {
  const h = ((hora % 24) + 24) % 24, i = Math.floor(h), t = h - i;
  return CURVA[i] + (CURVA[(i + 1) % 24] - CURVA[i]) * t;
}
export const fluidez = (d) => 1 - 0.4 * Math.max(0, d - 0.55) / 0.45;

// Conductores (IDM): aceleración, frenado cómodo, separación en segundos y en metros parado, aceleración lateral que
// aceptan en las curvas, frenado de emergencia y factor de velocidad. Los taxis y las motos van más afanados.
const CARRO = { a: 1.8, b: 2.6, T: 1.3, s0: 2.0, aLat: 2.4, bMax: 8, vel: 1 };
const TAXI = { ...CARRO, a: 2.2, T: 1.0, s0: 1.6, aLat: 2.7, vel: 1.08 };
const MOTO = { a: 2.8, b: 3, T: 0.8, s0: 1.0, aLat: 3.2, bMax: 8, vel: 1.12 };
const BUS = { a: 1.0, b: 2, T: 1.7, s0: 3, aLat: 1.6, bMax: 6, vel: 0.85 };

// Mezcla bogotana: un cuarto taxis, un cuarto motos, el resto particulares y algún bus del SITP.
const FLOTA = [
  { tipo: 'taxi', cuantos: 50, conductor: TAXI, colores: [0xf2bf16] },
  { tipo: 'sedan', cuantos: 42, conductor: CARRO, colores: [0xe9e7e2, 0xb9bcc0, 0x5a5e63, 0x2b2f36, 0x8d1b1b, 0x1f3550, 0xd9d6cf, 0x6e7378] },
  { tipo: 'camioneta', cuantos: 36, conductor: CARRO, colores: [0xf0efeb, 0x9aa3ab, 0x1c1d20, 0x47505a, 0x6b1f24, 0x3d4a3f] },
  { tipo: 'pickup', cuantos: 12, conductor: CARRO, colores: [0xefeeea, 0x8b9096, 0x22262b, 0x7d1c1c] },
  { tipo: 'moto', cuantos: 50, conductor: MOTO, moto: true, largo: 2.0, ancho: 0.8, eje: 1.32, adelante: 0.34,
    colores: [0x111214, 0xb3141b, 0x1d3f8f, 0xe8e8e8, 0x5c6066, 0xd8a20c],
    chaquetas: [0x16181b, 0x2d3036, 0x1e2a44, 0x7a1d1d, 0xd9561b, 0x2f5f3a, 0xd0d0d0] },
  { tipo: 'bus', cuantos: 10, conductor: BUS, bus: true, largo: 12, ancho: 2.5, eje: 6, adelante: 2.55, colores: [0] },
];

// ---------------------------------------------------------------------------------------------------------------
// Red de carriles: las vías se parten en los vértices compartidos (cruces) y cada pedazo da una arista por sentido.
// Los carriles van a la derecha del eje; el 0 es el de la derecha (junto al andén).
// ---------------------------------------------------------------------------------------------------------------
export function armarRed(vias) {
  const k = (q) => `${q[0]},${q[1]}`;
  const carros = vias.filter((v) => v.clase <= 3 && !v.bus && v.p.length >= 2);
  // Un vértice interior cuenta 2 y una punta 1: más de 2 es que otra vía pasa o llega por ahí.
  const usos = new Map();
  for (const v of carros) v.p.forEach((q, i) => usos.set(k(q), (usos.get(k(q)) || 0) + (i === 0 || i === v.p.length - 1 ? 1 : 2)));
  const nodos = new Map(), aristas = [];
  const nodo = (q) => {
    let n = nodos.get(k(q));
    if (!n) nodos.set(k(q), n = { x: q[0], z: q[1], salidas: [], entradas: [], grado: 0, ancho: 0, corte: 3, cruce: false, ocupantes: [], turno: null, turnoT: 0 });
    return n;
  };
  for (const via of carros) {
    const w = anchoVia(via) / 2;
    let tramo = [via.p[0]];
    for (let i = 1; i < via.p.length; i++) {
      const q = via.p[i], u = tramo[tramo.length - 1];
      if (q[0] !== u[0] || q[1] !== u[1]) tramo.push(q);
      if (i < via.p.length - 1 && usos.get(k(q)) <= 2) continue;
      if (tramo.length >= 2) {
        const a = nodo(tramo[0]), b = nodo(tramo[tramo.length - 1]);
        a.grado++; b.grado++;
        a.ancho = Math.max(a.ancho, w); b.ancho = Math.max(b.ancho, w);
        const ida = arista(aristas.length, via, w, tramo, a, b);
        aristas.push(ida);
        if (!via.unSentido) {
          const vuelta = arista(aristas.length, via, w, [...tramo].reverse(), b, a);
          aristas.push(vuelta);
          ida.inversa = vuelta; vuelta.inversa = ida;
        }
      }
      tramo = [q];
    }
  }
  // En un cruce los carriles se cortan donde empieza la vía más ancha; en una simple continuación, apenas lo necesario
  // para suavizar el cambio de dirección.
  for (const n of nodos.values()) { n.cruce = n.grado >= 3; n.corte = n.cruce ? n.ancho + 1.5 : 3; }
  for (const e of aristas) {
    e.desde.salidas.push(e);
    e.hasta.entradas.push(e);
    e.ini = Math.min(e.desde.corte, e.largo * 0.4);
    e.fin = e.largo - Math.min(e.hasta.corte, e.largo * 0.4);
  }
  // Rejilla de aristas (con margen del ancho de la vía para encontrar también lo que está sobre la calzada).
  const celdas = new Map();
  for (const e of aristas) {
    const vistas = new Set(), m = e.w + 2;
    for (let i = 0; i < e.xs.length - 1; i++) {
      for (let ix = Math.floor((Math.min(e.xs[i], e.xs[i + 1]) - m) / CELDA_RED); ix <= Math.floor((Math.max(e.xs[i], e.xs[i + 1]) + m) / CELDA_RED); ix++) {
        for (let iz = Math.floor((Math.min(e.zs[i], e.zs[i + 1]) - m) / CELDA_RED); iz <= Math.floor((Math.max(e.zs[i], e.zs[i + 1]) + m) / CELDA_RED); iz++) {
          const c = llave(ix, iz);
          if (vistas.has(c)) continue;
          vistas.add(c);
          if (!celdas.has(c)) celdas.set(c, []);
          celdas.get(c).push(e);
        }
      }
    }
  }
  return { nodos: [...nodos.values()], aristas, celdas };
}

function arista(id, via, w, pts, desde, hasta) {
  const n = pts.length, xs = new Float64Array(n), zs = new Float64Array(n), acum = new Float64Array(n);
  const ux = new Float64Array(n - 1), uz = new Float64Array(n - 1), mx = new Float64Array(n), mz = new Float64Array(n);
  const vcurva = new Float64Array(n).fill(Infinity);
  for (let i = 0; i < n; i++) { xs[i] = pts[i][0]; zs[i] = pts[i][1]; }
  for (let i = 0; i < n - 1; i++) {
    const dx = xs[i + 1] - xs[i], dz = zs[i + 1] - zs[i], l = Math.hypot(dx, dz) || 1e-6;
    ux[i] = dx / l; uz[i] = dz / l; acum[i + 1] = acum[i] + l;
  }
  // Inglete en cada vértice: el carril desplazado sigue continuo en los quiebres de la vía.
  // Derecha de un tramo que avanza hacia (ux, uz): (-uz, ux).
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 2, i);
    let sx = -uz[a] - uz[b], sz = ux[a] + ux[b];
    const l = Math.hypot(sx, sz);
    if (l < 1e-6) { sx = -uz[b]; sz = ux[b]; } else { sx /= l; sz /= l; }
    const f = 1 / Math.max(0.5, sx * -uz[b] + sz * ux[b]);
    mx[i] = sx * f; mz[i] = sz * f;
    // Radio aproximado del quiebre: arco tangente a la mitad de los dos tramos. Velocidad para 2,4 m/s² laterales.
    if (i > 0 && i < n - 1) {
      const ang = Math.acos(Math.max(-1, Math.min(1, ux[a] * ux[b] + uz[a] * uz[b])));
      if (ang > 0.05) vcurva[i] = Math.max(2, Math.sqrt(2.4 * Math.min(acum[i] - acum[i - 1], acum[i + 1] - acum[i]) / 2 / Math.tan(Math.min(ang, 3) / 2)));
    }
  }
  // Carriles: los de OpenStreetMap (total de la vía) o, si no los dice, según el ancho.
  const total = via.carriles || (via.unSentido ? (via.clase === 3 ? 1 : Math.max(1, Math.round(2 * w / 3.3))) : 2 * Math.max(1, Math.round(w / 3.3)));
  const porSentido = via.unSentido ? total : Math.max(1, Math.floor(total / 2));
  const anchoCarril = (via.unSentido ? 2 * w : w) / porSentido;
  const carriles = Array.from({ length: porSentido }, (_, i) => w - (i + 0.5) * anchoCarril);
  return {
    id, via, clase: via.clase, desde, hasta, xs, zs, acum, largo: acum[n - 1], ux, uz, mx, mz, vcurva,
    carriles, anchoCarril, w, vmax: VEL_CLASE[via.clase], obst: [], inversa: null, ini: 0, fin: 0, con: new Map(), marca: 0,
  };
}

// Punto del carril a `s` metros del comienzo de la arista, `off` metros a la derecha del eje. `j` es una pista del tramo.
export function puntoCarril(e, s, off, out, j = 0) {
  const n = e.xs.length;
  if (j > n - 2) j = n - 2;
  while (j < n - 2 && e.acum[j + 1] < s) j++;
  while (j > 0 && e.acum[j] > s) j--;
  const l = e.acum[j + 1] - e.acum[j], t = l > 0 ? Math.min(1, Math.max(0, (s - e.acum[j]) / l)) : 0;
  out.x = e.xs[j] + (e.xs[j + 1] - e.xs[j]) * t + (e.mx[j] + (e.mx[j + 1] - e.mx[j]) * t) * off;
  out.z = e.zs[j] + (e.zs[j + 1] - e.zs[j]) * t + (e.mz[j] + (e.mz[j + 1] - e.mz[j]) * t) * off;
  out.j = j;
  return out;
}

export function bezier(c, t, out) {
  const u = 1 - t;
  out.x = u * u * c.p0x + 2 * u * t * c.p1x + t * t * c.p2x;
  out.z = u * u * c.p0z + 2 * u * t * c.p1z + t * t * c.p2z;
  return out;
}

// Las motos que se cuelan van entre dos carriles (o hacia el centro si hay uno solo), también dentro de los cruces.
export const carrilMoto = (e, c) => e.carriles[c] + (e.carriles.length >= 2 ? (c < e.carriles.length - 1 ? -1 : 1) * e.anchoCarril / 2 : -0.7);

// Curva de unión (Bézier cuadrática) del carril ca de A al carril cb de B a través del nodo. Se guarda en A.
export function conexion(A, ca, B, cb, moto = false) {
  const k = ca * 1048576 + B.id * 8 + cb + (moto ? 0.5 : 0);
  let c = A.con.get(k);
  if (c) return c;
  const p0 = puntoCarril(A, A.fin, moto ? carrilMoto(A, ca) : A.carriles[ca], {}, A.xs.length);
  const p2 = puntoCarril(B, B.ini, moto ? carrilMoto(B, cb) : B.carriles[cb], {});
  const t0x = A.ux[p0.j], t0z = A.uz[p0.j], t2x = B.ux[p2.j], t2z = B.uz[p2.j];
  const dx = p2.x - p0.x, dz = p2.z - p0.z, dist = Math.hypot(dx, dz), dot = t0x * t2x + t0z * t2z;
  // Control: donde se cruzan las dos rectas de los carriles. Si son paralelas, en el medio; en una vuelta en U, adelante.
  let p1x = (p0.x + p2.x) / 2, p1z = (p0.z + p2.z) / 2;
  const den = t0x * t2z - t0z * t2x;
  if (Math.abs(den) > 0.08) {
    const a = (dx * t2z - dz * t2x) / den, b = (t0x * dz - t0z * dx) / den;
    if (a > 0 && b > 0 && a < 40 && b < 40) { p1x = p0.x + t0x * a; p1z = p0.z + t0z * a; }
  } else if (dot < -0.5) { p1x += t0x * (dist * 0.6 + 2); p1z += t0z * (dist * 0.6 + 2); }
  c = { p0x: p0.x, p0z: p0.z, p1x, p1z, p2x: p2.x, p2z: p2.z, t0x, t0z, nodo: A.hasta, recto: dot > 0.85, largo: 0, R: Infinity };
  const q = { x: p0.x, z: p0.z }, r = {};
  for (let i = 1; i <= 10; i++) { bezier(c, i / 10, r); c.largo += Math.hypot(r.x - q.x, r.z - q.z); q.x = r.x; q.z = r.z; }
  c.largo = Math.max(c.largo, 0.01);
  const ang = Math.acos(Math.max(-1, Math.min(1, dot)));
  if (ang > 0.05) c.R = Math.max(1, c.largo / ang);
  A.con.set(k, c);
  return c;
}

// Carros estacionados (js/vehiculos.js → estacionar) que invaden un carril: el que pasa se corre para esquivarlos.
export function marcarEstacionados(red, lista) {
  for (const p of lista) {
    for (const e of red.celdas.get(llave(Math.floor(p.x / CELDA_RED), Math.floor(p.z / CELDA_RED))) || []) {
      let mejor = Infinity, s = 0, lat = 0;
      for (let k = 0; k < e.xs.length - 1; k++) {
        const l = e.acum[k + 1] - e.acum[k], t = Math.max(0, Math.min(l, (p.x - e.xs[k]) * e.ux[k] + (p.z - e.zs[k]) * e.uz[k]));
        const qx = e.xs[k] + e.ux[k] * t, qz = e.zs[k] + e.uz[k] * t, d = Math.hypot(p.x - qx, p.z - qz);
        if (d < mejor) { mejor = d; s = e.acum[k] + t; lat = (p.x - qx) * -e.uz[k] + (p.z - qz) * e.ux[k]; }
      }
      if (mejor <= e.w + 0.5 && s > e.ini && s < e.fin) e.obst.push({ s, lat, ref: p });
    }
  }
  for (const e of red.aristas) e.obst.sort((a, b) => a.s - b.s);
}

// ---------------------------------------------------------------------------------------------------------------
// Simulación (sin three.js, se puede probar en node).
// ---------------------------------------------------------------------------------------------------------------
const angulo = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const elegir = (lista) => lista[Math.floor(Math.random() * lista.length)];

export function crearSimulacion(red, flota, { radio = RADIO } = {}) {
  const vehiculos = [];
  for (const f of flota) {
    // Para los choques, cada vehículo es una cápsula: un tramo a lo largo de su eje (metros desde el centro entre
    // ejes, hacia adelante) con un radio. Así un círculo que entra por el medio no queda atrapado entre dos.
    const radioChoque = f.moto ? 0.45 : f.ancho * 0.52, delante = f.eje / 2 + f.adelante;
    const T = {
      ...f, medio: f.largo / 2, mancho: f.ancho / 2, raizLat: Math.sqrt(f.conductor.aLat / 2.4),
      radioChoque, capsula: [-(f.largo - delante - radioChoque), delante - radioChoque],
    };
    for (let i = 0; i < f.cuantos; i++) {
      vehiculos.push({
        id: vehiculos.length, T, activo: false, e: null, c: 0, s: 0, j: 0, con: null, sig: null, sc: 0,
        vel: 0, acc: 0, tope: Infinity, x: 0, z: 0, rx: 0, rz: 0, cx: 0, cz: 0, hx: 0, hz: -1, rumbo: 0, guinada: 0, giro: 0,
        alabeo: 0, cabeceo: 0, y: null, visto: -1, rueda: 0, conductor: 0.88 + Math.random() * 0.24, filtra: Math.random() < 0.6,
        reservado: null, tReserva: 0, entrada: null, conRes: null, soltar: 0, espera: 0, esperaCruce: 0, sinSalida: false,
        color: elegir(f.colores), color2: f.chaquetas ? elegir(f.chaquetas) : 0, caja: !!f.moto && Math.random() < 0.35,
      });
    }
  }
  // Las reservas de los cruces son de esta simulación.
  for (const n of red.nodos) { n.ocupantes = []; n.turno = null; }
  // Los libres se sacan al azar para que la mezcla se mantenga con cualquier densidad.
  const libres = [...vehiculos], activos = [];
  let tiempo = 0, foco = null, objetivo = 0, flu = 1;

  // Rejilla de vehículos activos, rehecha cada cuadro.
  const rejilla = new Map();
  const meter = (v) => {
    const c = llave(Math.floor(v.cx / CELDA), Math.floor(v.cz / CELDA));
    let l = rejilla.get(c);
    if (!l) rejilla.set(c, l = []);
    l.push(v);
  };
  function cerca(x, z, r, fn) {
    for (let i = Math.floor((x - r) / CELDA); i <= Math.floor((x + r) / CELDA); i++)
      for (let j = Math.floor((z - r) / CELDA); j <= Math.floor((z + r) / CELDA); j++) {
        const l = rejilla.get(llave(i, j));
        if (l) for (const v of l) fn(v);
      }
  }

  // Aristas alrededor del foco con su peso para aparecer; se rehace cuando el foco se mueve 40 m.
  const vecinas = [], pesos = [];
  let fx = Infinity, fz = Infinity, pesoTotal = 0;
  function refrescar() {
    if (Math.hypot(foco.x - fx, foco.z - fz) < 40) return;
    fx = foco.x; fz = foco.z;
    const marca = ++ronda;
    vecinas.length = pesos.length = 0; pesoTotal = 0;
    for (let i = Math.floor((fx - radio) / CELDA_RED); i <= Math.floor((fx + radio) / CELDA_RED); i++)
      for (let j = Math.floor((fz - radio) / CELDA_RED); j <= Math.floor((fz + radio) / CELDA_RED); j++)
        for (const e of red.celdas.get(llave(i, j)) || []) {
          if (e.marca === marca) continue;
          e.marca = marca;
          const w = (e.fin - e.ini) * e.carriles.length * PESO_CLASE[e.clase];
          if (w <= 0) continue;
          pesoTotal += w; vecinas.push(e); pesos.push(pesoTotal);
        }
  }
  function sortear() {
    if (!vecinas.length) return null;
    const r = Math.random() * pesoTotal;
    let a = 0, b = pesos.length - 1;
    while (a < b) { const m = (a + b) >> 1; if (pesos[m] < r) a = m + 1; else b = m; }
    return vecinas[a];
  }

  // Siguiente arista al llegar al nodo: casi siempre derecho, a veces un giro, nunca devolverse si hay otra salida.
  // Los buses se quedan en las vías principales mientras puedan.
  const opciones = [], pesosOp = [];
  function elegirSiguiente(v) {
    const e = v.e, n = e.hasta, T = v.T, ax = e.ux[e.ux.length - 1], az = e.uz[e.uz.length - 1];
    opciones.length = pesosOp.length = 0;
    let total = 0;
    const ultimo = e.carriles.length - 1;
    for (const b of n.salidas) {
      if (b === e.inversa) continue;
      const d = ax * b.ux[0] + az * b.uz[0], cruz = ax * b.uz[0] - az * b.ux[0];
      let p = d > 0.7 ? 3 : d > -0.3 ? 1 : 0.15;
      // A la derecha se gira desde el carril de la derecha y a la izquierda desde el de la izquierda.
      if (d <= 0.7 && (cruz > 0 ? v.c !== 0 : v.c !== ultimo)) p *= 0.02;
      p *= T.bus ? (b.clase <= 2 ? 1 : 0.03) : b.clase <= 1 ? 1.4 : 1;
      if (b.fin - b.ini < 0.5 && !b.hasta.salidas.length) p *= 0.05;
      total += p; opciones.push(b); pesosOp.push(total);
    }
    let b = null;
    if (opciones.length) {
      const r = Math.random() * total;
      b = opciones[pesosOp.findIndex((p) => p >= r)] || opciones[opciones.length - 1];
    } else b = e.inversa; // calle ciega de doble sentido: vuelta en U
    v.sig = b;
    if (!b) return;
    const n2 = b.carriles.length, d = ax * b.ux[0] + az * b.uz[0], cruz = ax * b.uz[0] - az * b.ux[0];
    // Derecho conserva el carril; a la derecha (cruz > 0) entra al de la derecha; a la izquierda, al de la izquierda.
    v.sc = T.moto ? Math.floor(Math.random() * n2) : d > 0.7 ? Math.min(v.c, n2 - 1) : cruz > 0 ? 0 : n2 - 1;
  }

  // Carril del vehículo (las motos que se cuelan, entre carriles) y su curva de unión.
  const carrilDe = (v, e, c) => (v.filtra && v.T.moto ? carrilMoto(e, c) : e.carriles[c]);
  const unir = (v, A, ca, B, cb) => conexion(A, ca, B, cb, v.filtra && v.T.moto);

  // Corrimiento lateral del vehículo: su carril y el esquive de estacionados, que se desvanece cerca de las puntas
  // de la arista para empatar con las curvas de unión.
  function desplazamiento(v, e, c, s) {
    const T = v.T, o = carrilDe(v, e, c);
    let extra = 0;
    if (e.obst.length) {
      const sc = s - T.eje / 2, base = o, lleno = 2.4 + T.medio + 0.5, libre = 1.05 + T.mancho, borde = e.w - T.mancho + 0.3;
      let mejor = 0;
      for (const ob of e.obst) {
        const ds = Math.abs(ob.s - sc);
        if (ds > lleno + 7 || ob.ref.oculto || Math.abs(ob.lat - base) >= libre) continue;
        // El estacionado ocupa ±1,05 m alrededor de su centro: se pasa por el lado donde quepa sin salirse de la
        // calzada (aunque sea invadiendo el carril contrario); si caben los dos, por el más cercano.
        const izq = ob.lat - libre, der = ob.lat + libre, fi = Math.max(0, -borde - izq), fd = Math.max(0, der - borde);
        const meta = fi === fd ? (base - izq < der - base ? izq : der) : fi < fd ? izq : der;
        const falta = Math.max(-2.6, Math.min(2.6, meta - base));
        const k = ds <= lleno ? 1 : 1 - (ds - lleno) / 7, f = falta * k * k * (3 - 2 * k);
        if (Math.abs(f) > Math.abs(mejor)) mejor = f;
      }
      extra += mejor;
    }
    if (!extra) return o;
    let k = Math.min(s - e.ini, e.fin - s) / 6;
    k = k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k);
    return o + extra * k;
  }

  // Punto del eje delantero `d` metros más adelante por su ruta (arista, curva de unión y la arista que sigue).
  function puntoAdelante(v, d, out) {
    if (!v.con) {
      const e = v.e, s = v.s + Math.max(0, d);
      if (s <= e.fin || !v.sig) { const t = Math.min(s, e.fin); return puntoCarril(e, t, desplazamiento(v, e, v.c, t), out, v.j); }
      const con = unir(v, e, v.c, v.sig, v.sc), r = s - e.fin;
      if (r <= con.largo) return bezier(con, r / con.largo, out);
      return puntoCarril(v.sig, Math.min(v.sig.ini + r - con.largo, v.sig.fin), carrilDe(v, v.sig, v.sc), out);
    }
    const r = v.s + Math.max(0, d);
    if (r <= v.con.largo) return bezier(v.con, r / v.con.largo, out);
    return puntoCarril(v.e, Math.min(v.e.ini + r - v.con.largo, v.e.fin), carrilDe(v, v.e, v.c), out);
  }

  // Cruces: entra quien tenga el cruce libre, o lo comparta con los de su misma fila o con el que va derecho de frente.
  // Si alguien lleva rato esperando, toma el turno y nadie más entra hasta que pase.
  function puedeEntrar(n, v, con) {
    const t = n.turno;
    if (t && t.e !== v.e && t.activo && !t.reservado && tiempo - n.turnoT < 10) return false; // su misma fila sí pasa
    for (const o of n.ocupantes) {
      if (o === v || tiempo - o.tReserva > 12) continue; // una reserva vieja (alguien trabado) no bloquea para siempre
      if (o.entrada === v.e) continue;
      if (con.recto && o.conRes.recto && con.t0x * o.conRes.t0x + con.t0z * o.conRes.t0z < -0.8) continue;
      return false;
    }
    return true;
  }
  function reservar(n, v, con) {
    soltarReserva(v);
    n.ocupantes.push(v);
    Object.assign(v, { reservado: n, tReserva: tiempo, entrada: v.e, conRes: con });
    if (n.turno === v) n.turno = null;
  }
  function soltarReserva(v) {
    const n = v.reservado;
    if (n) { const i = n.ocupantes.indexOf(v); if (i >= 0) n.ocupantes.splice(i, 1); v.reservado = null; }
  }
  function liberar(v) {
    soltarReserva(v);
    if (v.e && v.e.hasta.turno === v) v.e.hasta.turno = null;
  }

  // Aceleración del cuadro: IDM con los vehículos de adelante (y el jugador), pare en el cruce si está ocupado y
  // velocidad máxima en curvas y cruces.
  const q = { x: 0, z: 0, j: 0 };
  function calcular(v, dt, jug) {
    const T = v.T, C = T.conductor, e = v.e, vel = v.vel;
    const v0 = Math.max(2, e.vmax * v.conductor * C.vel * flu);
    const libre = C.a * (1 - (vel / v0) ** 4);
    const frenar = (hueco, vl, s0 = C.s0, Th = C.T) => {
      const deseado = s0 + Math.max(0, vel * Th + (vel * (vel - vl)) / (2 * Math.sqrt(C.a * C.b)));
      return -C.a * (deseado / Math.max(hueco, 0.1)) ** 2;
    };
    let inter = 0, tope = Infinity, lim = Infinity;
    const limite = (d, vl) => { if (vel > vl) lim = Math.min(lim, (vl * vl - vel * vel) / (2 * Math.max(d, 1))); };
    if (!v.con) {
      for (let j = v.j + 1; j < e.xs.length - 1 && e.acum[j] - v.s < 50; j++) limite(e.acum[j] - v.s, e.vcurva[j] * T.raizLat);
      const d = e.fin - v.s, parada = d - T.adelante - 0.5;
      if (!v.sig) {
        v.sinSalida = true;
        inter = Math.min(inter, frenar(parada, 0, 0.3, 0));
        tope = Math.max(0, parada);
      } else if (d < 60) {
        const con = unir(v, e, v.c, v.sig, v.sc);
        limite(d, Math.min(Math.sqrt(C.aLat * con.R), e.hasta.cruce ? 7.5 : Infinity));
        if (e.hasta.cruce && v.reservado !== e.hasta) {
          if (puedeEntrar(e.hasta, v, con)) {
            if (parada < Math.max(5, (vel * vel) / (2 * C.b) + 3)) reservar(e.hasta, v, con);
            v.esperaCruce = 0;
          } else {
            inter = Math.min(inter, frenar(parada, 0, 0.3, 0));
            tope = Math.max(0, parada);
            v.esperaCruce += dt;
            const n = e.hasta;
            if (v.esperaCruce > 3 && (!n.turno || !n.turno.activo || n.turno.reservado || tiempo - n.turnoT > 10)) { n.turno = v; n.turnoT = tiempo; }
          }
        }
      }
    } else if (vel > Math.sqrt(C.aLat * v.con.R)) lim = Math.min(lim, (Math.sqrt(C.aLat * v.con.R) - vel) * 2);

    // El de adelante: cualquiera cuyo centro quede sobre la ruta que el vehículo va a recorrer.
    const mira = Math.min(55, 15 + vel * 3);
    let hueco = Infinity;
    const considerar = (o) => {
      if (o === v) return;
      // Dos que entran por curvas al mismo carril (p. ej. donde se acaba un carril): va primero el que tiene menos
      // curva por delante y, si van parejos, uno cualquiera; el otro cede aunque ya estén lado a lado.
      if (v.con && o.con && o.e === v.e && o.c === v.c && o.con !== v.con) {
        const rv = v.con.largo - v.s, ro = o.con.largo - o.s;
        if (rv < ro || (rv === ro && v.id < o.id)) return;
        const h = rv - ro - T.medio - o.T.medio;
        inter = Math.min(inter, frenar(Math.max(h, 0.1), o.vel));
        hueco = Math.min(hueco, h);
        return;
      }
      const dx = o.cx - v.cx, dz = o.cz - v.cz, ad = dx * v.hx + dz * v.hz;
      if (ad <= 0.3 || ad > mira + o.T.medio || Math.abs(dz * v.hx - dx * v.hz) > 9) return;
      const dot = o.hx * v.hx + o.hz * v.hz;
      if (!o.jugador && dot < -0.3) return; // de frente: va por el otro carril
      puntoAdelante(v, ad - T.eje / 2, q);
      if (Math.hypot(o.cx - q.x, o.cz - q.z) > T.mancho + o.T.mancho + 0.25) return;
      const h = ad - T.medio - o.T.medio;
      inter = Math.min(inter, frenar(h, Math.max(0, o.jugador ? o.vx * v.hx + o.vz * v.hz : o.vel * dot)));
      hueco = Math.min(hueco, h);
    };
    cerca(v.cx + v.hx * mira * 0.5, v.cz + v.hz * mira * 0.5, mira * 0.5 + 8, considerar);
    if (jug) considerar(jug);
    tope = Math.min(tope, Math.max(0, hueco - 0.2));
    v.acc = Math.max(-C.bMax, Math.min(libre + inter, lim));
    v.tope = tope;
  }

  // Avanza ds metros por la ruta: arista → curva de unión → arista siguiente.
  function avanzar(v, ds) {
    v.s += ds;
    for (let k = 0; k < 4; k++) {
      if (!v.con) {
        if (v.s < v.e.fin || !v.sig) { if (!v.sig) v.s = Math.min(v.s, v.e.fin); break; }
        const con = unir(v, v.e, v.c, v.sig, v.sc);
        if (v.e.hasta.cruce && v.reservado !== v.e.hasta) reservar(v.e.hasta, v, con); // entró sin alcanzar a reservar
        v.s -= v.e.fin;
        v.con = con; v.e = v.sig; v.c = v.sc; v.sig = null; v.j = 0;
      } else {
        if (v.s < v.con.largo) break;
        v.s = v.s - v.con.largo + v.e.ini;
        v.con = null;
        // El cruce se suelta cuando sale la cola, no la trompa (un bus de 12 m lo ocupa un buen rato más).
        v.soltar = v.e.ini + v.T.largo - v.T.adelante;
        elegirSiguiente(v);
      }
    }
    if (v.reservado && !v.con && v.reservado !== v.e.hasta && v.s >= v.soltar) soltarReserva(v);
  }

  // Pose: el eje delantero va sobre la ruta y el trasero lo sigue a la distancia entre ejes (como un remolque),
  // así el vehículo corta un poco las curvas y gira con naturalidad.
  function posar(v, dt, ds) {
    puntoAdelante(v, 0, q);
    if (!v.con) v.j = q.j;
    const mx = q.x - v.x, mz = q.z - v.z, m = Math.hypot(mx, mz);
    v.x = q.x; v.z = q.z;
    let dx = v.x - v.rx, dz = v.z - v.rz;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    v.rx = v.x - dx * v.T.eje; v.rz = v.z - dz * v.T.eje;
    v.hx = dx; v.hz = dz;
    v.cx = (v.x + v.rx) / 2; v.cz = (v.z + v.rz) / 2;
    const r = Math.atan2(-dx, -dz);
    v.guinada = dt > 0 ? angulo(r - v.rumbo) / dt : 0;
    v.rumbo = r;
    if (m > 1e-3) v.giro = Math.max(-0.6, Math.min(0.6, angulo(Math.atan2(-mx, -mz) - r)));
    v.rueda += ds;
    // Las motos se inclinan hacia adentro de la curva.
    if (v.T.moto) v.alabeo += (Math.max(-0.6, Math.min(0.6, Math.atan((v.vel * v.guinada) / 9.8))) - v.alabeo) * Math.min(1, dt * 6);
  }

  function aparecer(v, protegido, vista, jug) {
    const T = v.T;
    for (let intento = 0; intento < 8; intento++) {
      const e = sortear();
      if (!e) return false;
      if (T.bus && e.clase > 2) continue;
      const hay = e.fin - e.ini - T.largo - 2;
      if (hay <= 0) continue;
      const s = e.ini + T.eje + 1 + Math.random() * hay, c = Math.floor(Math.random() * e.carriles.length);
      v.e = e; v.c = c; v.con = null;
      puntoCarril(e, s, desplazamiento(v, e, c, s), q);
      if (Math.hypot(q.x - foco.x, q.z - foco.z) > radio) continue;
      if (jug && Math.hypot(q.x - jug.cx, q.z - jug.cz) < 30) continue;
      if (protegido && vista && vista.distancia(q.x, q.z) < VISTA_LIBRE && vista.visible(q.x, q.z, T.medio + 3)) continue;
      let ocupado = false;
      cerca(q.x, q.z, T.largo + 8, (o) => { if (Math.hypot(o.cx - q.x, o.cz - q.z) < T.medio + o.T.medio + 5) ocupado = true; });
      if (ocupado) continue;
      Object.assign(v, { s, j: q.j, x: q.x, z: q.z, vel: Math.min(e.vmax * flu, 9) * (0.4 + Math.random() * 0.5), acc: 0,
        reservado: null, espera: 0, esperaCruce: 0, sinSalida: false, y: null, visto: -1, giro: 0, alabeo: 0, cabeceo: 0, activo: true });
      elegirSiguiente(v);
      const atras = puntoCarril(e, s - T.eje, desplazamiento(v, e, c, s - T.eje), {}, q.j);
      v.rx = atras.x; v.rz = atras.z;
      posar(v, 0, 0);
      activos.push(v);
      meter(v);
      return true;
    }
    return false;
  }

  function retirar(i) {
    const v = activos[i];
    liberar(v);
    v.activo = false;
    activos[i] = activos[activos.length - 1];
    activos.pop();
    libres.push(v);
  }

  // foco: { x, z }; jugador: { x, z, modo } o null; vista: { visible(x, z, r), distancia(x, z) } o null (sin cámara).
  let jx = null, jz = null, jvx = 0, jvz = 0;
  function actualizar(dt, hora, nuevoFoco, jugador, vista) {
    tiempo += dt;
    const d = densidad(hora);
    flu = fluidez(d);
    objetivo = Math.round(vehiculos.length * d);
    // Un salto del foco (teletransporte, primer cuadro) llena de una vez, sin cuidar la vista.
    const salto = !foco || Math.hypot(nuevoFoco.x - foco.x, nuevoFoco.z - foco.z) > 150;
    foco = { x: nuevoFoco.x, z: nuevoFoco.z };
    if (salto) for (let i = activos.length - 1; i >= 0; i--) if (Math.hypot(activos[i].cx - foco.x, activos[i].cz - foco.z) > radio) retirar(i);
    refrescar();
    for (const l of rejilla.values()) l.length = 0;
    for (const v of activos) meter(v);

    // El jugador (a pie, en bici o en carro) es un obstáculo más; su velocidad se estima entre cuadros.
    let jug = null;
    if (jugador && /caminar|manejar|bici/.test(jugador.modo)) {
      if (jx !== null && dt > 0) {
        const k = Math.min(1, dt * 8);
        jvx += ((jugador.x - jx) / dt - jvx) * k; jvz += ((jugador.z - jz) / dt - jvz) * k;
      }
      const carro = jugador.modo === 'manejar';
      jug = { jugador: true, cx: jugador.x, cz: jugador.z, vx: jvx, vz: jvz, hx: 0, hz: 0, vel: 0, T: { medio: carro ? 2.2 : 0.5, mancho: carro ? 0.95 : 0.6 } };
      jx = jugador.x; jz = jugador.z;
    } else jx = jz = null;

    for (const v of activos) calcular(v, dt, jug);
    for (const v of activos) {
      v.vel = Math.max(0, v.vel + v.acc * dt);
      const ds = Math.min(v.vel * dt, v.tope);
      if (v.tope < 0.05) v.vel = 0; // pegado al de adelante o a la raya: quieto
      v.espera = v.vel < 0.3 ? v.espera + dt : 0;
      avanzar(v, ds);
      posar(v, dt, ds);
    }

    // Se retiran los que quedan lejos (o trabados, o sobrando si bajó la densidad) donde no se note.
    const oculto = (v) => !vista || vista.distancia(v.cx, v.cz) > VISTA_LIBRE || !vista.visible(v.cx, v.cz, v.T.medio + 3);
    let sobran = Math.min(3, activos.length - objetivo);
    for (let i = activos.length - 1; i >= 0; i--) {
      const v = activos[i], dist = Math.hypot(v.cx - foco.x, v.cz - foco.z);
      let quitar = dist > radio + 200;
      if (!quitar && (dist > radio + 30 || v.espera > 45 || (v.sinSalida && v.espera > 2))) quitar = oculto(v);
      if (!quitar && sobran > 0 && dist > 100 && oculto(v)) { quitar = true; sobran--; }
      if (quitar) retirar(i);
    }
    // Y aparecen hasta llegar a la densidad de la hora.
    let intentos = salto ? 600 : 4;
    while (activos.length < objetivo && libres.length && intentos-- > 0) {
      const i = Math.floor(Math.random() * libres.length), v = libres[i];
      libres[i] = libres[libres.length - 1];
      libres.pop();
      if (!aparecer(v, !salto, vista, jug)) libres.push(v);
    }
  }

  return { vehiculos, activos, actualizar, cerca, puntoAdelante, get objetivo() { return objetivo; } };
}

// ---------------------------------------------------------------------------------------------------------------
// Modelos: los carros salen de vehiculos.js; la moto con su motociclista y el bus del SITP se arman aquí.
// ---------------------------------------------------------------------------------------------------------------
function pintar(lista, g, hex, pieza = 0) {
  g = g.index ? g.toNonIndexed() : g;
  g.deleteAttribute('uv');
  const n = g.attributes.position.count, c = new THREE.Color(hex), col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('pieza', new THREE.BufferAttribute(new Float32Array(n).fill(pieza), 1));
  lista.push(g);
}
// Una pieza que nace a lo largo de y, apuntada de a hasta b.
function entre(g, a, b) {
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()));
  return g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
}

// Moto de calle con motociclista de casco, mirando a -z, centro entre los ejes. Piezas: 0 color propio, 1 color de
// la moto (también el casco), 2 chaqueta, 3 maleta de domicilios (color de la chaqueta, no todas la llevan),
// 4 farola, 5 piloto.
function geometriaMoto() {
  const P = [], V = (x, y, z) => new THREE.Vector3(x, y, z);
  const tubo = (a, b, r, hex, k = 0) => pintar(P, entre(new THREE.CylinderGeometry(r, r, a.distanceTo(b), 8), a, b), hex, k);
  const bola = (x, y, z, sx, sy, sz, hex, k = 0) => pintar(P, new THREE.SphereGeometry(1, 12, 8).scale(sx, sy, sz).translate(x, y, z), hex, k);
  const NEGRO = 0x141414, METAL = 0x8d9196, MOTOR = 0x3a3d42, JEAN = 0x2b3550;
  for (const z of [-0.66, 0.66]) {
    pintar(P, new THREE.TorusGeometry(0.245, 0.07, 8, 20).rotateY(Math.PI / 2).translate(0, 0.315, z), NEGRO);
    pintar(P, new THREE.CylinderGeometry(0.15, 0.15, 0.07, 12).rotateZ(Math.PI / 2).translate(0, 0.315, z), METAL);
  }
  for (const s of [-1, 1]) {
    tubo(V(s * 0.08, 0.315, -0.66), V(s * 0.08, 1.0, -0.5), 0.022, METAL); // barras de la suspensión
    tubo(V(s * 0.07, 0.315, 0.66), V(s * 0.07, 0.56, 0.05), 0.025, MOTOR); // tijera de atrás
  }
  tubo(V(-0.34, 1.06, -0.47), V(0.34, 1.06, -0.47), 0.018, NEGRO); // manubrio
  tubo(V(0, 0.5, -0.28), V(0, 0.95, -0.5), 0.03, MOTOR); // chasis
  tubo(V(0.13, 0.36, -0.05), V(0.16, 0.5, 0.6), 0.045, METAL); // exhosto
  bola(0, 0.96, -0.6, 0.13, 0.13, 0.11, 0, 1); // carenaje de la farola
  bola(0, 0.95, -0.7, 0.075, 0.06, 0.03, 0xfff4d8, 4);
  bola(0, 0.86, -0.22, 0.16, 0.11, 0.26, 0, 1); // tanque
  bola(0, 0.88, 0.22, 0.13, 0.06, 0.3, NEGRO); // sillín
  bola(0, 0.5, -0.08, 0.15, 0.16, 0.24, MOTOR); // motor
  bola(0, 0.84, 0.58, 0.1, 0.06, 0.2, 0, 1); // colín
  bola(0, 0.84, 0.79, 0.06, 0.03, 0.02, 0xd01818, 5);
  // Motociclista sentado, un poco echado hacia adelante, con las manos en el manubrio.
  pintar(P, entre(new THREE.CapsuleGeometry(0.17, 0.28, 4, 10), V(0, 0.98, 0.18), V(0, 1.43, -0.02)), 0, 2);
  bola(0, 1.66, -0.08, 0.145, 0.145, 0.15, 0, 1); // casco
  bola(0, 1.66, -0.2, 0.1, 0.055, 0.045, NEGRO); // visor
  for (const s of [-1, 1]) {
    tubo(V(s * 0.2, 1.4, -0.03), V(s * 0.27, 1.2, -0.27), 0.05, 0, 2);
    tubo(V(s * 0.27, 1.2, -0.27), V(s * 0.31, 1.07, -0.45), 0.045, 0, 2);
    bola(s * 0.31, 1.07, -0.46, 0.045, 0.045, 0.045, NEGRO); // guantes
    tubo(V(s * 0.12, 0.96, 0.16), V(s * 0.19, 0.88, -0.22), 0.075, JEAN);
    tubo(V(s * 0.19, 0.88, -0.22), V(s * 0.17, 0.42, -0.05), 0.06, JEAN);
    bola(s * 0.17, 0.4, -0.09, 0.05, 0.05, 0.1, NEGRO); // zapatos
  }
  pintar(P, new RoundedBoxGeometry(0.44, 0.4, 0.42, 2, 0.05).translate(0, 1.2, 0.58), 0, 3);
  return mergeGeometries(P);
}

function materialMoto() {
  const vc = vertexColor().rgb, pieza = attribute('pieza', 'float'), tinte = attribute('tinte', 'vec3');
  const tinte2 = attribute('tinte2', 'vec4'), freno = attribute('freno', 'float');
  const es = (k) => step(k - 0.5, pieza).mul(step(pieza, k + 0.5));
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.5, metalness: 0.15 });
  m.colorNode = mix(mix(vc, tinte, es(1)), tinte2.rgb, max(es(2), es(3)));
  // Sin maleta, sus vértices se juntan en un punto y no se dibuja.
  m.positionNode = positionLocal.mul(float(1).sub(es(3).mul(float(1).sub(tinte2.w))));
  m.emissiveNode = vec3(1, 0.95, 0.85).mul(es(4).mul(float(0.3).add(noche.mul(3))))
    .add(vec3(1, 0.05, 0.03).mul(es(5).mul(float(0.15).add(noche.mul(1.5)).add(freno.mul(2.4)))));
  return m;
}

// Bus zonal del SITP: 12 m, azul con techo blanco, puertas a la derecha (+x; el bus mira a -z). Centro entre ejes.
const BUS_ZF = -(6 / 2 + 2.55), BUS_ZR = BUS_ZF + 12, BUS_EJES = [-3, 3];
function geometriaBus() {
  const P = [], W = 1.25, b = 0.06;
  const forma = new THREE.Shape();
  forma.moveTo(-W + b, 0.36);
  forma.lineTo(W - b, 0.36);
  forma.lineTo(W - b, 2.74);
  forma.quadraticCurveTo(W - b, 2.98, W - 0.3, 2.98);
  forma.lineTo(-W + 0.3, 2.98);
  forma.quadraticCurveTo(-W + b, 2.98, -W + b, 2.74);
  forma.lineTo(-W + b, 0.36);
  const cuerpo = new THREE.ExtrudeGeometry(forma, { depth: 12 - 0.2, bevelEnabled: true, bevelThickness: 0.1, bevelSize: b, bevelSegments: 2, curveSegments: 4 });
  pintar(P, cuerpo.translate(0, 0, BUS_ZF + 0.1), 0xffffff, 0);
  for (const z of BUS_EJES) for (const s of [-1, 1]) {
    pintar(P, new THREE.CylinderGeometry(0.5, 0.5, 0.3, 16).rotateZ(Math.PI / 2).translate(s * 1.13, 0.5, z), 0xffffff, 1);
    pintar(P, new THREE.CylinderGeometry(0.3, 0.3, 0.31, 12).rotateZ(Math.PI / 2).translate(s * 1.13, 0.5, z), 0xffffff, 2);
  }
  const g = mergeGeometries(P);
  g.deleteAttribute('color');
  return g;
}

// Pintura por shader, como materialBus de js/transmilenio.js (adaptado de Slop New York, mrdoob, MIT: js/bus.js).
function materialBus() {
  const p = attribute('position', 'vec3'), n = attribute('normal', 'vec3'), pieza = attribute('pieza', 'float');
  const freno = attribute('freno', 'float');
  const banda = (t, a, b) => {
    const f = max(fwidth(t), float(0.002));
    return smoothstep(float(a).sub(f), float(a).add(f), t).sub(smoothstep(float(b).sub(f), float(b).add(f), t));
  };
  const piel = float(1).sub(step(0.5, pieza));
  const lado = smoothstep(0.55, 0.8, abs(n.x)).mul(piel);
  const dz = min(abs(p.z.sub(BUS_ZF + 1.05)), abs(p.z.sub(BUS_ZF + 6.6)));
  const puerta = banda(dz, -1, 0.58).mul(banda(p.y, 0.42, 2.55)).mul(lado).mul(step(0, p.x));
  const pilar = banda(abs(fract(p.z.div(1.5)).sub(0.5)), 0.46, 1);
  const ventana = banda(p.y, 1.25, 2.5).mul(banda(p.z, BUS_ZF + 0.4, BUS_ZR - 0.4)).mul(lado).mul(float(1).sub(puerta));
  const fr = smoothstep(0.45, 0.75, n.z.negate()).mul(step(p.z, BUS_ZF + 0.3)).mul(piel);
  const co = smoothstep(0.45, 0.75, n.z).mul(step(BUS_ZR - 0.3, p.z)).mul(piel);
  const parabrisas = banda(p.y, 1.05, 2.6).mul(banda(abs(p.x), -1, 1.05)).mul(fr);
  const letrero = banda(p.y, 2.64, 2.9).mul(banda(abs(p.x), -1, 0.85)).mul(fr);
  const faro = banda(p.y, 0.55, 0.78).mul(banda(abs(p.x), 0.7, 1.05)).mul(fr);
  const piloto = banda(p.y, 0.6, 1.2).mul(banda(abs(p.x), 0.88, 1.08)).mul(co);
  const trasero = banda(p.y, 1.6, 2.55).mul(banda(abs(p.x), -1, 0.8)).mul(co);
  const vidrio = max(max(ventana.mul(float(1).sub(pilar.mul(0.7))), parabrisas), max(trasero, puerta.mul(0.85)));
  // Pasos de rueda: el costado no tiene huecos, se pintan oscuros alrededor de cada llanta.
  const arco = (z) => float(1).sub(step(0.4, p.z.sub(z).mul(p.z.sub(z)).add(p.y.sub(0.5).mul(p.y.sub(0.5)))));
  const pasos = max(arco(BUS_EJES[0]), arco(BUS_EJES[1])).mul(lado);
  const franja = banda(p.y, 1.0, 1.1).mul(lado);
  const falda = float(1).sub(smoothstep(0.62, 0.66, p.y)).mul(piel);
  const techo = smoothstep(0.55, 0.8, n.y).mul(piel);
  let c = mix(color(0x1d5fae), color(0xeef0f2), franja);
  c = mix(c, color(0x2a2b2e), max(falda, pasos));
  c = mix(c, color(0xe9ecef), techo);
  c = mix(c, color(0x0f151b), vidrio);
  c = mix(c, color(0x111111), letrero);
  c = mix(c, color(0xf4f2ea), faro);
  c = mix(c, color(0x8a0d0d), piloto);
  c = mix(c, color(0x141517), step(0.5, pieza).mul(step(pieza, 1.5)));
  c = mix(c, color(0xb9bcbf), step(1.5, pieza));
  const m = new THREE.MeshStandardNodeMaterial();
  m.colorNode = c;
  m.roughnessNode = mix(float(0.4), float(0.1), vidrio);
  m.metalnessNode = mix(float(0.1), float(0.4), vidrio);
  // De noche: cabina iluminada, letrero de ruta ámbar, faros y pilotos (más fuertes al frenar) sobre el umbral del bloom.
  m.emissiveNode = vec3(0.8, 0.88, 1.0).mul(vidrio.mul(noche).mul(0.9))
    .add(vec3(1.0, 0.55, 0.08).mul(letrero.mul(noche.mul(2.2).add(0.5))))
    .add(vec3(1.0, 0.96, 0.86).mul(faro.mul(noche.mul(3.2).add(0.8))))
    .add(vec3(1.0, 0.05, 0.03).mul(piloto.mul(noche.mul(1.6).add(freno.mul(2.4)).add(0.2))));
  return m;
}

// Pintura de los carros de vehiculos.js para instancias: el color va en instanceColor y los faros se prenden con
// material.faros (lo lee su shader). Los pilotos se reconocen por su rojo en el color del shader y brillan más al
// frenar, por instancia.
function materialPintura(original) {
  const m = original.clone();
  m.color.set(0xffffff);
  m.faros = 0;
  if (m.colorNode && m.emissiveNode) {
    const c = m.colorNode, rojo = step(c.g.mul(6), c.r).mul(step(0.2, c.r));
    m.emissiveNode = m.emissiveNode.add(vec3(1, 0.05, 0.04).mul(rojo.mul(attribute('freno', 'float')).mul(noche.mul(1.4).add(1.6))));
  }
  return m;
}

const instancias = (g, m, n, sombra = false) => {
  const im = new THREE.InstancedMesh(g, m, n);
  im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  im.frustumCulled = false; // se reparten cada cuadro entre los vehículos visibles
  im.castShadow = sombra;
  im.receiveShadow = true;
  im.count = 0;
  return im;
};
const atributoInstancia = (g, nombre, n, tam) => {
  const a = new THREE.InstancedBufferAttribute(new Float32Array(n * tam), tam);
  a.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute(nombre, a);
  return a;
};

// Un tipo de carro de vehiculos.js: se arma una vez y de su raíz salen geometrías y materiales para las instancias.
function modeloCarro(tipo, n) {
  const MARCA = 0x010203; // para reconocer la malla de la pintura
  const v = crearVehiculo(tipo, MARCA);
  v.raiz.updateMatrixWorld(true);
  const ruedas = new Set(v.ruedas.map((r) => r.rueda));
  const M = { mallas: [], todas: [], pintura: null, freno: null, ruedas: null, ejes: [], faros: [], n: 0 };
  let geoRueda = null, matRueda = null, caja = null;
  v.raiz.traverse((o) => {
    if (!o.isMesh) return;
    if (ruedas.has(o)) { geoRueda ??= o.geometry; matRueda ??= o.material; return; }
    let g = o.geometry, m = o.material;
    if (!o.matrixWorld.equals(new THREE.Matrix4())) g = g.clone().applyMatrix4(o.matrixWorld);
    let im;
    if (m.color?.getHex?.() === MARCA) {
      g = g === o.geometry ? g.clone() : g; // la geometría es compartida con los estacionados: el freno va en una copia
      M.freno = atributoInstancia(g, 'freno', n, 1);
      m = materialPintura(m);
      M.faros.push(m);
      im = instancias(g, m, n, true);
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
      im.instanceColor.setUsage(THREE.DynamicDrawUsage);
      M.pintura = im;
      g.computeBoundingBox();
      caja = g.boundingBox;
    } else if (m.transparent) {
      im = instancias(g, m, n); // sombra de contacto
      im.receiveShadow = false;
    } else im = instancias(g, m, n, !m.emissiveNode || !m.vertexColors);
    M.mallas.push(im);
  });
  if (geoRueda) {
    M.ejes = v.ruedas.map((r) => ({ pos: r.eje.position.clone(), delantera: r.delantera }));
    M.ruedas = instancias(geoRueda, matRueda, n * M.ejes.length);
  }
  M.todas = M.ruedas ? [...M.mallas, M.ruedas] : [...M.mallas];
  const zs = v.ruedas.map((r) => r.eje.position.z), delantero = Math.min(...zs);
  M.dims = { largo: v.largo, ancho: v.ancho, eje: Math.max(...zs) - delantero, adelante: caja ? delantero - caja.min.z : v.largo * 0.2, radioRueda: v.radio };
  return M;
}

function modeloMoto(n) {
  const g = geometriaMoto();
  const M = { mallas: [], todas: [], n: 0, freno: atributoInstancia(g, 'freno', n, 1), tinte: atributoInstancia(g, 'tinte', n, 3), tinte2: atributoInstancia(g, 'tinte2', n, 4) };
  M.mallas.push(instancias(g, materialMoto(), n, true));
  M.todas = M.mallas;
  return M;
}

function modeloBus(n) {
  const g = geometriaBus();
  const M = { mallas: [], todas: [], n: 0, freno: atributoInstancia(g, 'freno', n, 1) };
  M.mallas.push(instancias(g, materialBus(), n, true));
  M.todas = M.mallas;
  return M;
}

// ---------------------------------------------------------------------------------------------------------------
// El tráfico completo.
// jugador: () => { x, z, modo }. estacionados (opcional): lo que devuelve estacionar(), para esquivarlos.
// Encadena choques.empujar: el jugador (en carro, a pie o en bici) choca con el tráfico sin cambiar jugador.js.
// ---------------------------------------------------------------------------------------------------------------
export function crearTrafico({ vias, calles, choques, jugador, estacionados = null }) {
  const red = armarRed(vias);
  if (estacionados) marcarEstacionados(red, estacionados.lista);
  const grupo = new THREE.Group();
  grupo.name = 'Trafico';

  const modelos = {}, flota = [];
  for (const f of FLOTA) {
    let M;
    if (f.moto) M = modeloMoto(f.cuantos);
    else if (f.bus) M = modeloBus(f.cuantos);
    else M = modeloCarro(f.tipo, f.cuantos);
    modelos[f.tipo] = M;
    grupo.add(...M.todas);
    flota.push({ ...f, ...(M.dims || {}), radioRueda: M.dims?.radioRueda ?? 0.3 });
  }
  const sim = crearSimulacion(red, flota);

  // Visibilidad con los cuatro planos laterales del frustum (los de cerca y lejos dependen de la convención de
  // profundidad, y los laterales ya descartan lo que queda detrás de la cámara).
  const frustum = new THREE.Frustum(), pv = new THREE.Matrix4();
  let hayVista = false, camX = 0, camY = 0, camZ = 0;
  const visibleY = (x, y, z, r) => {
    if (!hayVista) return true;
    for (let k = 0; k < 4; k++) {
      const { normal, constant } = frustum.planes[k];
      if (normal.x * x + normal.y * y + normal.z * z + constant < -r) return false;
    }
    return true;
  };
  const vista = {
    visible: (x, z, r) => visibleY(x, calles.piso(x, z) + 1, z, r),
    distancia: (x, z) => Math.hypot(x - camX, calles.piso(x, z) - camY, z - camZ),
  };

  const m4 = new THREE.Matrix4(), mr = new THREE.Matrix4(), qc = new THREE.Quaternion(), qr = new THREE.Quaternion();
  const eu = new THREE.Euler(), p3 = new THREE.Vector3(), uno = new THREE.Vector3(1, 1, 1), col = new THREE.Color();
  let cuadro = 0;
  function dibujar(dt) {
    cuadro++;
    for (const M of Object.values(modelos)) M.n = 0;
    for (const v of sim.activos) {
      const T = v.T, M = modelos[T.tipo], yA = v.y ?? calles.piso(v.cx, v.cz);
      if (hayVista && (Math.hypot(v.cx - camX, yA - camY, v.cz - camZ) > 900 || !visibleY(v.cx, yA + 1, v.cz, T.medio + 4))) continue;
      // Altura y cabeceo con el piso de las calles bajo los dos ejes; se suavizan para no saltar en los bordes.
      const yF = calles.piso(v.x, v.z), yR = calles.piso(v.rx, v.rz), y = (yF + yR) / 2, cab = Math.atan2(yF - yR, T.eje);
      if (v.y === null || v.visto !== cuadro - 1) { v.y = y; v.cabeceo = cab; } else {
        const k = Math.min(1, dt * 10);
        v.y += (y - v.y) * k; v.cabeceo += (cab - v.cabeceo) * k;
      }
      v.visto = cuadro;
      const i = M.n++;
      qc.setFromEuler(eu.set(v.cabeceo, v.rumbo, v.alabeo, 'YXZ'));
      m4.compose(p3.set(v.cx, v.y, v.cz), qc, uno);
      for (const im of M.mallas) im.setMatrixAt(i, m4);
      if (M.freno) M.freno.array[i] = v.acc < -0.6 || v.vel < 0.5 ? 1 : 0;
      if (M.pintura) M.pintura.setColorAt(i, col.setHex(v.color));
      if (M.tinte) {
        col.setHex(v.color); M.tinte.setXYZ(i, col.r, col.g, col.b);
        col.setHex(v.color2); M.tinte2.setXYZW(i, col.r, col.g, col.b, v.caja ? 1 : 0);
      }
      if (M.ruedas) {
        const giro = -v.rueda / T.radioRueda;
        M.ejes.forEach((e, k) => {
          qr.setFromEuler(eu.set(giro, e.delantera ? v.giro : 0, 0, 'YXZ'));
          M.ruedas.setMatrixAt(i * M.ejes.length + k, mr.compose(e.pos, qr, uno).premultiply(m4));
        });
      }
    }
    for (const M of Object.values(modelos)) {
      for (const im of M.todas) { im.count = im === M.ruedas ? M.n * M.ejes.length : M.n; im.instanceMatrix.needsUpdate = true; }
      if (M.pintura) M.pintura.instanceColor.needsUpdate = true;
      for (const a of [M.freno, M.tinte, M.tinte2]) if (a) a.needsUpdate = true;
    }
  }

  function actualizar(dt, hora, camara) {
    const j = jugador?.() ?? null;
    hayVista = !!camara;
    if (camara) {
      camara.updateMatrixWorld();
      pv.multiplyMatrices(camara.projectionMatrix, camara.matrixWorldInverse);
      frustum.setFromProjectionMatrix(pv);
      ({ x: camX, y: camY, z: camZ } = camara.position);
    }
    const foco = j || { x: camX, z: camZ };
    // Desde muy arriba o muy lejos los carros no se distinguen: no se simulan ni se dibujan.
    const lejos = camara && Math.hypot(camX - foco.x, camY - calles.piso(foco.x, foco.z), camZ - foco.z) > 1800;
    grupo.visible = !lejos;
    if (lejos) return;
    sim.actualizar(dt, hora, foco, j, camara ? vista : null);
    // De noche todos andan con las luces prendidas.
    const faros = Math.min(1, Math.max(0, (noche.value - 0.2) * 1.6));
    for (const M of Object.values(modelos)) for (const m of M.faros || []) m.faros = faros;
    dibujar(dt);
  }

  // Empuja un círculo (p.x, p.z, radio) fuera de los vehículos del tráfico. Devuelve la normal del choque o null.
  function empujar(p, radio) {
    let normal = null;
    sim.cerca(p.x, p.z, radio + 8, (v) => {
      const [a, b] = v.T.capsula, ax = v.cx + v.hx * a, az = v.cz + v.hz * a;
      const t = Math.max(0, Math.min(b - a, (p.x - ax) * v.hx + (p.z - az) * v.hz));
      let ex = p.x - ax - v.hx * t, ez = p.z - az - v.hz * t, d = Math.hypot(ex, ez);
      const r = v.T.radioChoque + radio;
      if (d >= r) return;
      if (d < 1e-6) { ex = -v.hz; ez = v.hx; d = 1e-6; } // justo en el eje: sale de lado
      else { ex /= d; ez /= d; }
      p.x += ex * (r - d); p.z += ez * (r - d);
      normal = [ex, ez];
    });
    return normal;
  }
  if (choques) {
    const base = choques.empujar;
    choques.empujar = (p, r) => { const n1 = base(p, r), n2 = empujar(p, r); return n2 || n1; };
  }

  return { grupo, actualizar, empujar, red, sim, get cantidad() { return sim.activos.length; } };
}
