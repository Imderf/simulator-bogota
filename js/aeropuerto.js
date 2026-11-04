import * as THREE from 'three/webgpu';
import {
  attribute, vertexColor, positionGeometry, normalGeometry, positionWorld, cameraPosition, uniform, texture,
  vec2, vec3, float, abs, max, min, fract, step, smoothstep, fwidth, mix, length, clamp, mx_noise_float,
} from 'three/tsl';
import { noche } from './edificios.js';

// Aeropuerto El Dorado (fuera de la zona con datos, ~14 km al noroccidente) y su tráfico: llegadas por la final de
// la 14R desde la sabana, salidas por la 14L que viran alejándose. Pistas, rodajes, plataformas, terminales y torre
// salen de OpenStreetMap (tools/aeropuerto.mjs). Los aviones son instancias de un A320 genérico armado en loft.
// Las pistas de El Dorado hoy se llaman 14/32 (antes 13/31): se usan los nombres que trae OSM.

const GRADO = Math.PI / 180, G = 9.81, TAN3 = Math.tan(3 * GRADO);
const LLEGADAS = '14R', SALIDAS = '14L'; // configuración habitual: se aterriza desde el noroccidente, sobre la sabana
const MAX_AVIONES = 64;
const D_FINAL = 900 / TAN3; // la final empieza a 900 m sobre la pista: ~17,2 km antes del punto de toque
const V_SALIDA = 14; // m/s al dejar la pista
const LEJOS = 30000; // las salidas desaparecen a esta distancia del aeropuerto
// Lejos de la cámara un avión de 38 m ocupa 2 o 3 píxeles: en el aire se agranda hasta REALCE veces para que se
// vea desde el centro. En 1 queda a escala real.
const REALCE = 2.5;
const K_LUZ = 0.0011; // radio mínimo de una luz en radianes (~2 px): de lejos sigue siendo un punto

// ---------------------------------------------------------------------------------------------------------------
// Utilidades.
// ---------------------------------------------------------------------------------------------------------------
const suave = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const giro = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a)); // ángulo con signo de a hasta b
const rumboDe = (dx, dz) => Math.atan2(-dx, -dz); // el modelo mira a −z: rumbo 0 = norte, crece hacia el oeste
const centroide = (p) => [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length];
const rgb = (hex) => new THREE.Color(hex).toArray();

function azar(semilla) {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Operaciones por minuto según la hora: de día una cada 1 a 1,5 minutos, de noche menos, de madrugada pocas.
export function tasaPorHora(h) {
  h = ((h % 24) + 24) % 24;
  if (h < 4.5) return 0.12;
  if (h < 5.5) return 0.12 + (h - 4.5) * 0.6;
  if (h < 21) return (h >= 6 && h < 9) || (h >= 17 && h < 20) ? 0.9 : 0.7;
  if (h < 23) return 0.4;
  return 0.22;
}

// Cada designador ("14R", "32L") con su umbral, dirección de vuelo y lado derecho del piloto.
export function prepararPistas(datos) {
  const pistas = {};
  datos.pistas.forEach(({ ref, ancho, p: [a, b] }, i) => {
    const largo = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const rumboAB = Math.atan2(b[0] - a[0], a[1] - b[1]); // brújula, con el norte en −z
    ref.split('/').forEach((nombre, k) => {
      const deA = Math.abs(giro(rumboAB, parseInt(nombre, 10) * 10 * GRADO)) < Math.PI / 2;
      const [u0, u1] = deA ? [a, b] : [b, a];
      const ux = (u1[0] - u0[0]) / largo, uz = (u1[1] - u0[1]) / largo;
      pistas[nombre] = { nombre, celda: 2 * i + k, ancho, largo, umbral: u0, fin: u1, u: [ux, uz], der: [-uz, ux], rumbo: rumboDe(ux, uz) };
    });
  });
  return pistas;
}
export const aPista = (p, x, z) => {
  const dx = x - p.umbral[0], dz = z - p.umbral[1];
  return [dx * p.u[0] + dz * p.u[1], dx * p.der[0] + dz * p.der[1]];
};
const dePista = (p, s, t) => [p.umbral[0] + p.u[0] * s + p.der[0] * t, p.umbral[1] + p.u[1] * s + p.der[1] * t];

// ---------------------------------------------------------------------------------------------------------------
// Calles de rodaje como grafo (OSM comparte los nodos en los cruces) y recorridos sobre él.
// ---------------------------------------------------------------------------------------------------------------
function grafoRodaje(datos) {
  const nodos = new Map();
  const nodo = ([x, z]) => {
    const k = `${x},${z}`;
    if (!nodos.has(k)) nodos.set(k, { x, z, vecinos: [] });
    return nodos.get(k);
  };
  for (const linea of [...datos.rodaje, ...datos.puestos.map((p) => p.p)]) {
    for (let i = 1; i < linea.length; i++) {
      const a = nodo(linea[i - 1]), b = nodo(linea[i]), d = Math.hypot(a.x - b.x, a.z - b.z);
      if (a !== b) { a.vecinos.push([b, d]); b.vecinos.push([a, d]); }
    }
  }
  return { lista: [...nodos.values()], nodo: (p) => nodos.get(`${p[0]},${p[1]}`) };
}

// ponytail: Dijkstra O(n²) sobre ~2.900 nodos, dos veces al cargar (~30 ms). Montículo si el grafo crece.
function dijkstra(nodos, origen, vetados) {
  for (const n of nodos) { n.d = Infinity; n.antes = null; n.listo = vetados.has(n); }
  origen.d = 0;
  origen.listo = false;
  for (;;) {
    let m = null;
    for (const n of nodos) if (!n.listo && n.d < Infinity && (!m || n.d < m.d)) m = n;
    if (!m) return;
    m.listo = true;
    for (const [v, d] of m.vecinos) if (!v.listo && m.d + d < v.d) { v.d = m.d + d; v.antes = m; }
  }
}
const camino = (n) => { const p = []; for (; n; n = n.antes) p.unshift([n.x, n.z]); return p; };

// Esquinas redondeadas con una Bézier cuadrática de radio r, para que el avión no gire en seco en cada vértice.
function redondear(p, r = 30) {
  const out = [p[0]];
  for (let i = 1; i < p.length - 1; i++) {
    const [a, b, c] = [p[i - 1], p[i], p[i + 1]];
    const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]), l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
    if (l1 < 0.01 || l2 < 0.01) continue;
    const r1 = Math.min(r, l1 / 2), r2 = Math.min(r, l2 / 2);
    const p0 = [b[0] - ((b[0] - a[0]) / l1) * r1, b[1] - ((b[1] - a[1]) / l1) * r1];
    const p2 = [b[0] + ((c[0] - b[0]) / l2) * r2, b[1] + ((c[1] - b[1]) / l2) * r2];
    for (let k = 0; k <= 4; k++) {
      const t = k / 4, u = 1 - t;
      out.push([u * u * p0[0] + 2 * u * t * b[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * b[1] + t * t * p2[1]]);
    }
  }
  out.push(p.at(-1));
  return out;
}

// Recorrido medido: posición y rumbo a s metros del comienzo.
function trazado(puntos) {
  const p = [puntos[0]];
  for (const q of puntos) if (Math.hypot(q[0] - p.at(-1)[0], q[1] - p.at(-1)[1]) > 0.05) p.push(q);
  const acum = [0];
  for (let i = 1; i < p.length; i++) acum.push(acum[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]));
  return { p, acum, largo: acum.at(-1) };
}
function sobre(tr, s) {
  const { p, acum } = tr;
  s = Math.min(Math.max(s, 0), tr.largo);
  let lo = 0, hi = p.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (acum[m] <= s) lo = m; else hi = m; }
  const [a, b] = [p[lo], p[hi]], t = (s - acum[lo]) / (acum[hi] - acum[lo] || 1);
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, rumboDe(b[0] - a[0], b[1] - a[1])];
}

// ---------------------------------------------------------------------------------------------------------------
// Tráfico: lógica pura, sin three, para poder probarla en node. Tiempo real (dt en segundos).
// ---------------------------------------------------------------------------------------------------------------
export function crearTrafico(datos, { semilla = 7 } = {}) {
  const rnd = azar(semilla);
  const pistas = prepararPistas(datos), lleg = pistas[LLEGADAS], sal = pistas[SALIDAS];
  const grafo = grafoRodaje(datos);
  const t1 = datos.terminales.find((t) => /T1/.test(t.nombre)) || datos.terminales[0];
  const ct1 = centroide(t1.p);
  const todos = [...datos.pistas.flatMap((p) => p.p), ...datos.plataformas.flat()];
  const centro = centroide(todos);

  // Salida rápida de la pista de llegadas: un cruce sobre el eje a 1,5-2,9 km del umbral cuya calle sale hacia
  // adelante y hacia el lado del terminal. Los nodos del eje quedan vetados para que nadie vuelva a cruzarla.
  const enEje = (p) => grafo.lista.filter((n) => { const [s, t] = aPista(p, n.x, n.z); n.s = s; return Math.abs(t) < 4 && s > -100 && s < p.largo + 100; });
  const ejeLleg = enEje(lleg), vetados = new Set(ejeLleg);
  const lado = Math.sign(aPista(lleg, ...ct1)[1]);
  const opciones = [];
  for (const c of ejeLleg) {
    if (c.s < 1500 || c.s > 2900) continue;
    for (const [n] of c.vecinos) {
      const [s, t] = aPista(lleg, n.x, n.z), adelante = s - c.s;
      if (Math.abs(t) >= 4 && Math.sign(t) === lado && adelante > -0.2 * Math.abs(t) && adelante < 3 * Math.abs(t)) opciones.push([c, n]);
    }
  }
  if (!opciones.length) throw new Error('aeropuerto.json: no hay salida de la pista de llegadas');
  // Puestos de pasajeros alrededor del T1 (los de carga y aviación general tienen letra).
  const puestos = datos.puestos
    .filter((p) => /^\d+$/.test(p.ref) && Math.hypot(p.p.at(-1)[0] - ct1[0], p.p.at(-1)[1] - ct1[1]) < 750)
    .map((p) => {
      const [a, b] = [p.p.at(-2), p.p.at(-1)];
      return { ref: p.ref, x: b[0], z: b[1], rumbo: rumboDe(b[0] - a[0], b[1] - a[1]), nodo: grafo.nodo(b), ocupado: null };
    });
  // Se elige la salida que deja más cerca del puesto del medio; luego un Dijkstra desde ella da todas las rutas.
  const medio = puestos.reduce((m, p) => (Math.hypot(p.x - ct1[0], p.z - ct1[1]) < Math.hypot(m.x - ct1[0], m.z - ct1[1]) ? p : m));
  dijkstra(grafo.lista, medio.nodo, vetados);
  const [salida, primero] = opciones.reduce((m, o) => (o[1].d + Math.abs(o[0].s - 2200) * 0.3 < m[1].d + Math.abs(m[0].s - 2200) * 0.3 ? o : m));
  const sSalida = salida.s - 60;
  dijkstra(grafo.lista, primero, vetados); // la ruta arranca 60 m antes sobre el eje para redondear el giro de salida
  for (const p of puestos) {
    if (p.nodo?.d < 8000) p.ruta = trazado(redondear([dePista(lleg, sSalida, 0), [salida.x, salida.z], ...camino(p.nodo)]));
  }
  const libres = puestos.filter((p) => p.ruta);
  for (const p of libres) p.cerca = libres.filter((q) => q !== p && Math.hypot(q.x - p.x, q.z - p.z) < 40);
  const puestoLibre = (p) => !p.ocupado && p.cerca.every((q) => !q.ocupado);

  // Alineación en la 14L: se llega por la calle del lado del terminal hasta el primer cruce del eje.
  const ejeSal = enEje(sal).filter((n) => n.s < 600).sort((a, b) => a.s - b.s);
  const ladoSal = Math.sign(aPista(sal, ...ct1)[1]);
  const j = ejeSal[0], previa = [[j.x, j.z]], vistos = new Set([j]);
  for (let n = j, largo = 0, paso = 0; largo < 180; paso++) {
    const sig = n.vecinos.filter(([v]) => !vistos.has(v))
      .sort(([a], [b]) => (paso ? Math.abs(aPista(sal, b.x, b.z)[1]) - Math.abs(aPista(sal, a.x, a.z)[1]) : aPista(sal, b.x, b.z)[1] * ladoSal - aPista(sal, a.x, a.z)[1] * ladoSal))[0];
    if (!sig) break;
    vistos.add(sig[0]); largo += sig[1]; previa.unshift([sig[0].x, sig[0].z]); n = sig[0];
  }
  const sDespegue = Math.max(j.s, 0) + 70;
  const alineacion = trazado(redondear([...previa, dePista(sal, sDespegue, 0)]));

  const aviones = Array.from({ length: MAX_AVIONES }, (_, i) => ({ i, activo: false }));
  let reloj = 0, proxima = 0, ultimaLlegada = -1e9, ultimoDespegue = -1e9, vuelos = 0;
  const nuevo = (tipo, fase) => {
    const a = aviones.find((v) => !v.activo);
    if (!a) return null;
    Object.assign(a, { activo: true, vuelo: ++vuelos, tipo, fase, h: 0, v: 0, s: 0, cabeceo: 0, alabeo: 0, aparicion: 1, librea: Math.floor(rnd() * 7), desde: reloj });
    return a;
  };
  const quitar = (a) => { a.activo = false; if (a.puesto) a.puesto.ocupado = null; a.puesto = null; };
  const masViejo = () => aviones.filter((a) => a.activo && a.fase === 'parqueado').sort((a, b) => a.desde - b.desde)[0];
  const parquear = (a, p) => Object.assign(a, { tipo: 'parqueado', fase: 'parqueado', puesto: p, x: p.x, z: p.z, rumbo: p.rumbo, h: 0, v: 0, cabeceo: 0, desde: reloj });

  function iniciarLlegada() {
    if (reloj - ultimaLlegada < 85) return false; // separación en la final: ~6 km
    let p = libres.filter(puestoLibre);
    if (!p.length) { const v = masViejo(); if (v) quitar(v); p = libres.filter(puestoLibre); }
    const a = p.length && nuevo('llegada', 'final');
    if (!a) return false;
    const puesto = p[Math.floor(rnd() * p.length)];
    puesto.ocupado = a;
    Object.assign(a, { puesto, d: D_FINAL, rumbo: lleg.rumbo, aparicion: 0 });
    moverFinal(a, 0);
    ultimaLlegada = reloj;
    return true;
  }
  function iniciarSalida() {
    if (aviones.some((a) => a.activo && (a.fase === 'alineando' || a.fase === 'esperando'))) return false;
    // El avión que sale viene de un puesto: se libera el que lleva más tiempo parqueado.
    const v = masViejo();
    if (v) quitar(v);
    const a = nuevo('salida', 'alineando');
    if (!a) return false;
    const [x, z, r] = sobre(alineacion, 0);
    // Rumbo final: la mitad vira a la izquierda hacia el norte, la otra a la derecha hacia el suroccidente.
    const izquierda = rnd() < 0.5;
    Object.assign(a, { ruta: alineacion, x, z, rumbo: r, rumboObj: -(izquierda ? 15 + rnd() * 25 : 200 + rnd() * 30) * GRADO, distGiro: 3000 + rnd() * 3000, recorrido: 0, gamma: 0 });
    return true;
  }

  function moverFinal(a, dt) {
    a.v = 69 + 16 * suave(2500, 14000, a.d);
    a.d -= a.v * dt;
    // Senda de 3° hacia el punto de mira (300 m después del umbral); en los últimos 8 m, enderezada en parábola
    // hasta tocar 150 m más allá con velocidad vertical casi nula.
    const x = a.d + 150;
    if (a.d > 150) { a.h = a.d * TAN3; a.cabeceo = 2.5 * GRADO; } else { a.h = (TAN3 / 600) * x * x; a.cabeceo = (2.5 + 3.5 * (1 - x / 300)) * GRADO; }
    [a.x, a.z] = dePista(lleg, 300 - a.d, 0);
    a.aparicion = suave(D_FINAL, D_FINAL - 3000, a.d);
    if (a.d <= -150) Object.assign(a, { fase: 'rodando', s: 450, h: 0 });
  }

  function moverRodaje(a, dt) {
    const restante = a.ruta.largo - a.s, r1 = sobre(a.ruta, a.s)[2], r2 = sobre(a.ruta, a.s + 25)[2];
    let objetivo = 11 - 7 * Math.min(1, Math.abs(giro(r1, r2)) / 1.2); // despacio en las curvas
    objetivo = Math.min(objetivo, Math.sqrt(restante) * 0.7 + 0.2); // y frenando al llegar
    a.v += Math.max(-1.2 * dt, Math.min(0.8 * dt, objetivo - a.v));
    a.s += a.v * dt;
    const [x, z, r] = sobre(a.ruta, a.s);
    a.x = x; a.z = z;
    a.rumbo += giro(a.rumbo, r) * Math.min(1, dt * 4);
    a.cabeceo = Math.max(0, a.cabeceo - 1.5 * GRADO * dt);
    return restante < 0.5;
  }

  function mover(a, dt) {
    switch (a.fase) {
      case 'final': moverFinal(a, dt); break;
      case 'rodando': {
        // Frena lo justo para llegar a la salida a V_SALIDA.
        const resta = Math.max(1, sSalida - a.s);
        const freno = Math.min(3, Math.max(0.6, (a.v * a.v - V_SALIDA * V_SALIDA) / (2 * resta)));
        a.v = Math.max(V_SALIDA, a.v - freno * dt);
        a.s += a.v * dt;
        a.cabeceo = Math.max(0, a.cabeceo - 1.5 * GRADO * dt);
        [a.x, a.z] = dePista(lleg, a.s, 0);
        if (a.s >= sSalida) Object.assign(a, { fase: 'rodaje', ruta: a.puesto.ruta, s: a.s - sSalida });
        break;
      }
      case 'rodaje': if (moverRodaje(a, dt)) parquear(a, a.puesto); break;
      case 'alineando': if (moverRodaje(a, dt)) Object.assign(a, { fase: 'esperando', t: 5 + rnd() * 10, v: 0 }); break;
      case 'esperando':
        a.t -= dt;
        a.rumbo += giro(a.rumbo, sal.rumbo) * Math.min(1, dt * 2);
        if (a.t <= 0 && reloj - ultimoDespegue > 50 && !aviones.some((b) => b.activo && b.fase === 'despegando')) Object.assign(a, { fase: 'despegando', s: sDespegue, v: 0 });
        break;
      case 'despegando':
        // En la altura de Bogotá la carrera es larga: ~1,7 km hasta despegar.
        a.v += 1.7 * dt;
        a.s += a.v * dt;
        if (a.v > 72) a.cabeceo = Math.min(10 * GRADO, a.cabeceo + 3 * GRADO * dt);
        [a.x, a.z] = dePista(sal, a.s, 0);
        a.rumbo = sal.rumbo;
        if (a.cabeceo >= 7.5 * GRADO) { a.fase = 'ascenso'; ultimoDespegue = reloj; }
        break;
      case 'ascenso': {
        a.v = Math.min(128, a.v + 0.6 * dt);
        const gObj = (a.h < 1500 ? 7.5 : a.h < 3000 ? 5 : 3) * GRADO;
        a.gamma += Math.max(-1.5 * GRADO * dt, Math.min(1.5 * GRADO * dt, gObj - a.gamma));
        a.cabeceo = a.gamma + (3 + 4 * (1 - suave(75, 110, a.v))) * GRADO;
        // Viraje coordinado: alabeo de hasta 25°, y el giro sale de él (ω = g·tan φ / v). Alabeo positivo = izquierda.
        a.recorrido += a.v * Math.cos(a.gamma) * dt;
        const falta = a.recorrido > a.distGiro && a.h > 300 ? giro(a.rumbo, a.rumboObj) : 0;
        const aObj = Math.max(-25 * GRADO, Math.min(25 * GRADO, falta * 1.5));
        a.alabeo += Math.max(-6 * GRADO * dt, Math.min(6 * GRADO * dt, aObj - a.alabeo));
        a.rumbo += ((G * Math.tan(a.alabeo)) / a.v) * dt;
        a.h += a.v * Math.sin(a.gamma) * dt;
        a.x -= Math.sin(a.rumbo) * a.v * Math.cos(a.gamma) * dt;
        a.z -= Math.cos(a.rumbo) * a.v * Math.cos(a.gamma) * dt;
        const lejos = Math.hypot(a.x - centro[0], a.z - centro[1]);
        a.aparicion = suave(LEJOS, LEJOS - 4000, lejos);
        if (lejos > LEJOS) quitar(a);
        break;
      }
    }
  }

  function paso(dt, hora) {
    reloj += dt;
    proxima -= dt;
    if (proxima <= 0) {
      proxima = (60 / tasaPorHora(hora)) * (0.5 + rnd());
      if (rnd() < 0.5) { if (!iniciarLlegada()) iniciarSalida(); } else if (!iniciarSalida()) iniciarLlegada();
    }
    for (const a of aviones) if (a.activo) mover(a, dt);
  }

  // Al comenzar: dos tercios de los puestos ocupados y 15 minutos de operación simulados, para no arrancar vacío.
  function calentar(hora, segundos = 900) {
    for (const p of [...libres].sort(() => rnd() - 0.5)) {
      if (rnd() < 0.66 && puestoLibre(p) && aviones.filter((a) => a.activo).length < MAX_AVIONES - 14) p.ocupado = parquear(nuevo('parqueado', 'parqueado'), p);
    }
    for (let t = 0; t < segundos; t += 0.5) paso(0.5, hora);
  }

  return { aviones, pistas, puestos: libres, centro, salida: { s: sSalida + 60, x: salida.x, z: salida.z }, sDespegue, alineacion, paso, calentar, get reloj() { return reloj; } };
}

// ---------------------------------------------------------------------------------------------------------------
// Geometría del avión: A320 genérico (37,6 m de largo, 35,8 m de envergadura) mirando a −z, con el tren principal
// en el origen y las ruedas en y = 0. Todo en arreglos simples: { pos, idx, color, pieza }.
// Adaptado de Slop New York (mrdoob, MIT): js/cars.js (interpolación monótona y secciones de superelipse en loft).
// ---------------------------------------------------------------------------------------------------------------
// Fritsch-Carlson: curva suave que pasa por los puntos sin pasarse de largo.
function curvaMonotona(puntos) {
  const xs = puntos.map((p) => p[0]), ys = puntos.map((p) => p[1]), n = puntos.length;
  const h = [], d = [];
  for (let i = 0; i < n - 1; i++) { h.push(xs[i + 1] - xs[i]); d.push((ys[i + 1] - ys[i]) / h[i]); }
  const m = [d[0]];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m.push(0);
    else { const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1]; m.push((w1 + w2) / (w1 / d[i - 1] + w2 / d[i])); }
  }
  m.push(d[n - 2]);
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const t = (x - xs[i]) / h[i], t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1];
  };
}

// Une anillos con el mismo número de puntos y cierra los extremos en abanico. La orientación se corrige al final
// con el volumen con signo: así no importa hacia dónde vaya cada anillo.
function loft(anillos, color, pieza = 0) {
  const M = anillos[0].length, pos = anillos.flat(2), idx = [];
  for (let s = 0; s < anillos.length - 1; s++) for (let k = 0; k < M; k++) {
    const a = s * M + k, b = s * M + ((k + 1) % M), c = a + M, d = b + M;
    idx.push(a, b, c, b, d, c);
  }
  for (const [s, primero] of [[0, true], [anillos.length - 1, false]]) {
    const ic = pos.length / 3;
    pos.push(...[0, 1, 2].map((e) => anillos[s].reduce((t, p) => t + p[e], 0) / M));
    for (let k = 0; k < M; k++) { const a = s * M + k, b = s * M + ((k + 1) % M); idx.push(...(primero ? [ic, b, a] : [ic, a, b])); }
  }
  return orientar({ pos, idx, color, pieza });
}
export function volumen({ pos, idx }) {
  let v = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const [a, b, c] = [idx[i], idx[i + 1], idx[i + 2]].map((k) => [pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]]);
    v += a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  return v / 6;
}
function orientar(parte) {
  if (volumen(parte) < 0) for (let i = 0; i < parte.idx.length; i += 3) [parte.idx[i + 1], parte.idx[i + 2]] = [parte.idx[i + 2], parte.idx[i + 1]];
  return parte;
}
const espejo = (p) => orientar({ ...p, pos: p.pos.map((v, i) => (i % 3 === 0 ? -v : v)), idx: [...p.idx] });

// Tubo a lo largo de un eje: [[posición, radio], ...] alrededor del centro (c1, c2) en el plano perpendicular.
function tubo(eje, [c1, c2], perfil, color, pieza = 0, M = 12) {
  const anillo = (a, r) => Array.from({ length: M }, (_, k) => {
    const t = (k / M) * Math.PI * 2, u = c1 + r * Math.cos(t), v = c2 + r * Math.sin(t);
    return eje === 'x' ? [a, u, v] : eje === 'y' ? [u, a, v] : [u, v, a];
  });
  return loft(perfil.map(([a, r]) => anillo(a, r)), color, pieza);
}

// Perfil alar de 10 puntos: [fracción de cuerda, grosor relativo] por arriba y luego por abajo.
const PERFIL = [[0, 0], [0.03, 0.5], [0.12, 0.85], [0.3, 1], [0.6, 0.72], [1, 0.06], [0.6, -0.3], [0.3, -0.5], [0.12, -0.5], [0.03, -0.35]];
const seccionH = ([x, y, z, cuerda, grosor]) => PERFIL.map(([u, g]) => [x, y + (g * grosor) / 2, z + u * cuerda]); // ala: corte a lo ancho
const seccionV = ([y, x, z, cuerda, grosor]) => PERFIL.map(([u, g]) => [x + (g * grosor) / 2, y, z + u * cuerda]); // deriva: corte a lo alto

const BLANCO = 0xeef1f4, GRIS_ALA = 0xb7bcc3, OSCURO = 0x26292d, TREN = 0x55595f, LLANTA = 0x17191c;
export function partesAvion() {
  // Fuselaje: medio ancho, medio alto y altura del eje según la distancia a la nariz (s). La cola sube por debajo.
  const ancho = curvaMonotona([[0, 0.06], [0.35, 0.62], [1, 1.1], [2, 1.5], [3.5, 1.8], [5.5, 1.96], [7, 1.98], [26, 1.98], [28.5, 1.84], [31, 1.48], [33.5, 1.04], [35.8, 0.6], [37.6, 0.2]]);
  const alto = curvaMonotona([[0, 0.06], [0.35, 0.6], [1, 1.04], [2, 1.46], [3.5, 1.84], [5.5, 2.03], [7, 2.06], [26, 2.06], [28.5, 1.84], [31, 1.44], [33.5, 1.0], [35.8, 0.58], [37.6, 0.22]]);
  const eje = curvaMonotona([[0, 2.95], [1, 3.03], [3, 3.18], [6, 3.3], [26, 3.3], [28.5, 3.5], [31, 3.86], [33.5, 4.16], [35.8, 4.44], [37.6, 4.6]]);
  const M = 20, n = 2.2; // superelipse casi circular
  const fuselaje = loft([0, 0.12, 0.35, 0.7, 1.1, 1.6, 2.2, 3, 4, 5.5, 7.5, 10, 13, 16, 19, 22, 25, 26.5, 28, 29.5, 31, 32.5, 34, 35.2, 36.3, 37.1, 37.6].map((s) =>
    Array.from({ length: M }, (_, k) => {
      const t = (k / M) * Math.PI * 2, c = Math.cos(t), sn = Math.sin(t);
      return [ancho(s) * Math.sign(c) * Math.abs(c) ** (2 / n), eje(s) + alto(s) * Math.sign(sn) * Math.abs(sn) ** (2 / n), s - 18];
    })), BLANCO, 2);

  // Ala derecha [x, y, z del borde de ataque, cuerda, grosor]: flecha de 27°, diedro de 5°, quiebre del borde de
  // salida a 6,3 m. Sharklet de la punta hacia arriba [y, x, z, cuerda, grosor].
  const ala = loft([[1.6, 1.95, -4.7, 7.0, 1.0], [3.2, 2.09, -3.88, 6.29, 0.85], [6.3, 2.37, -2.31, 4.9, 0.6], [12, 2.88, 0.6, 3.13, 0.36],
    [16.9, 3.31, 3.1, 1.6, 0.18]].map(seccionH), GRIS_ALA);
  const sharklet = loft([[3.25, 16.88, 3.12, 1.55, 0.16], [3.7, 17.12, 3.45, 1.15, 0.13], [4.6, 17.32, 3.95, 0.75, 0.1], [5.6, 17.42, 4.45, 0.45, 0.07]].map(seccionV), 0, 1);
  const estabilizador = loft([[0.3, 4.02, 13.6, 3.9, 0.42], [2.5, 4.25, 14.9, 2.95, 0.3], [6.2, 4.63, 17.25, 1.45, 0.15]].map(seccionH), GRIS_ALA);
  const deriva = loft([[4.4, 0, 10.4, 7.2, 0.75], [5.3, 0, 11.0, 6.4, 0.68], [8.0, 0, 12.9, 4.85, 0.45], [11.7, 0, 15.5, 2.65, 0.26]].map(seccionV), 0, 1);
  // Motor bajo el ala, adelante del borde de ataque: góndola con labio, tobera y cono de escape; entrada oscura.
  const gondola = tubo('z', [5.75, 1.62], [[-7.35, 0.82], [-7.3, 0.95], [-7.1, 1.02], [-6.6, 1.06], [-5.4, 1.05], [-4.2, 0.98], [-3.2, 0.86], [-2.9, 0.8], [-2.9, 0.56], [-2.4, 0.42], [-1.9, 0.08]], 0, 1, 16);
  const entrada = tubo('z', [5.75, 1.62], [[-7.36, 0.8], [-7.3, 0.3]], OSCURO, 0, 16); // tapa oscura justo delante de la góndola
  const pilon = loft([[2.45, 5.75, -6.0, 3.8, 0.3], [2.75, 5.75, -5.4, 3.3, 0.28]].map(seccionV), GRIS_ALA);
  // Tren: de nariz con dos ruedas y principal con dos patas de dos ruedas. Siempre abajo: no se ve a 10 km.
  const tren = [
    tubo('y', [0, -12.9], [[0.3, 0.1], [1.5, 0.1]], TREN, 0, 8),
    tubo('x', [0.37, -12.9], [[0.08, 0.37], [0.33, 0.37]], LLANTA, 0, 10),
    tubo('y', [3.8, 0], [[0.5, 0.16], [2.0, 0.16]], TREN, 0, 8),
    tubo('x', [0.57, 0], [[3.2, 0.57], [3.58, 0.57]], LLANTA, 0, 12),
    tubo('x', [0.57, 0], [[4.02, 0.57], [4.4, 0.57]], LLANTA, 0, 12),
  ];
  const derecha = [ala, sharklet, estabilizador, gondola, entrada, pilon, tren[2], tren[3], tren[4]];
  return [fuselaje, deriva, tren[0], tren[1], espejo(tren[1]), ...derecha, ...derecha.map(espejo)];
}

// Luces del avión en coordenadas del modelo.
const LUCES_AVION = [
  { p: [-2.6, 1.75, -4.4], tipo: 'aterrizaje' }, { p: [2.6, 1.75, -4.4], tipo: 'aterrizaje' },
  { p: [-16.9, 3.35, 3.6], tipo: 'roja' }, { p: [16.9, 3.35, 3.6], tipo: 'verde' }, { p: [0, 4.65, 19.7], tipo: 'cola' },
  { p: [0, 5.4, 1.0], tipo: 'baliza' }, { p: [0, 1.15, -1.5], tipo: 'baliza' },
  { p: [-16.9, 3.4, 4.4], tipo: 'estrobo' }, { p: [16.9, 3.4, 4.4], tipo: 'estrobo' },
];
// Colores genéricos de aerolínea para cola, motores, sharklets y franja (ninguna marca real).
const LIBREAS = [0xc8102e, 0x1b2f6b, 0x0096d6, 0xf2a900, 0x5b2a86, 0x2e8b57, 0x6b7079].map(rgb);

// Partes en arreglos → una geometría con color por vértice y un atributo propio (pieza o luz).
function juntar(partes, nombre) {
  const pos = [], idx = [], col = [], ext = [];
  for (const p of partes) {
    const base = pos.length / 3, c = Array.isArray(p.color) ? p.color : rgb(p.color);
    for (const v of p.pos) pos.push(v);
    for (const i of p.idx) idx.push(base + i);
    for (let k = 0; k < p.pos.length / 3; k++) { col.push(c[0], c[1], c[2]); ext.push(p[nombre] ?? 0); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute(nombre, new THREE.Float32BufferAttribute(ext, 1));
  g.setIndex(idx);
  return g;
}

// Pintura: blanco con cola, motores y franja del color de la aerolínea (atributo por instancia), ventanillas y
// cabina por shader. Bruma propia más suave que la de la escena, para que se vean a 10-15 km.
function materialAvion(colorNiebla) {
  const pieza = attribute('pieza', 'float'), librea = attribute('librea', 'vec3');
  const p = positionGeometry, n = normalGeometry, fus = step(1.5, pieza);
  const banda = (v, centro, medio, e) => float(1).sub(smoothstep(float(medio).sub(e), e.add(medio), abs(v.sub(centro))));
  const ey = max(fwidth(p.y), 0.002);
  const franja = banda(p.y, 2.72, 0.17, ey).mul(fus).mul(step(-15.5, p.z));
  const costado = smoothstep(0.25, 0.45, abs(n.x));
  const ventana = banda(fract(p.z.div(0.53)), 0.5, 0.2, max(fwidth(p.z.div(0.53)), 0.01)).mul(banda(p.y, 3.72, 0.16, ey))
    .mul(costado).mul(fus).mul(step(-11.2, p.z)).mul(step(p.z, 12));
  const cabina = banda(p.y, 4.02, 0.24, ey).mul(step(-16.6, p.z)).mul(step(p.z, -15.0)).mul(fus);
  const conLibrea = max(step(0.5, pieza).mul(step(pieza, 1.5)), franja);
  const bruma = smoothstep(4000, 45000, length(positionWorld.sub(cameraPosition))).mul(0.8);
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.4, metalness: 0.1, fog: false });
  m.colorNode = mix(mix(vertexColor(), librea, conLibrea), vec3(0.04, 0.05, 0.07), max(ventana, cabina)).mul(float(1).sub(bruma));
  m.emissiveNode = colorNiebla.mul(bruma).add(vec3(1, 0.8, 0.55).mul(ventana).mul(noche).mul(0.7));
  return m;
}

// ---------------------------------------------------------------------------------------------------------------
// Luces: octaedros pequeños que de lejos no bajan de ~2 px (K_LUZ), para que la pista y los aviones se vean de
// noche desde el centro. Sin niebla y por encima del umbral del bloom.
// ---------------------------------------------------------------------------------------------------------------
function mallaLuces(n, material, atributos) {
  const g = new THREE.OctahedronGeometry(1, 0);
  for (const [nombre, tam] of atributos) {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(n * tam), tam);
    g.setAttribute(nombre, a);
  }
  const m = new THREE.InstancedMesh(g, material, n);
  m.frustumCulled = false; // la posición sale del atributo `centro`, no de la matriz
  return m;
}

// Fijas: el tamaño se calcula en la GPU con la distancia a la cámara; solo se encienden de noche.
function lucesFijas(d, pistas) {
  const L = [], Y = d.y;
  const poner = (x, z, y, color, r0, kf) => L.push([x, z, y, color, r0, kf]);
  const BLANCA = [4, 3.6, 3], EJE = [2.6, 2.5, 2.2], VERDE = [0.3, 4, 1], ROJA = [4, 0.3, 0.15], TAXI = [0.15, 1.6, 0.5], REFLECTOR = [5, 4, 2.8];
  for (const { ref } of d.pistas) {
    const p = pistas[ref.split('/')[0]], w = p.ancho / 2;
    for (let s = 0; s <= p.largo; s += 60) for (const t of [-w - 1, w + 1]) poner(...dePista(p, s, t), Y + 0.4, BLANCA, 0.3, 1);
    for (let s = 15; s < p.largo; s += 30) poner(...dePista(p, s, 0), Y + 0.1, EJE, 0.22, 0.7);
  }
  for (const p of [pistas[LLEGADAS], pistas[SALIDAS]]) {
    const w = p.ancho / 2;
    for (let t = -w; t <= w; t += 3) { poner(...dePista(p, 0, t), Y + 0.4, VERDE, 0.3, 0.9); poner(...dePista(p, p.largo, t), Y + 0.4, ROJA, 0.3, 0.9); }
    // Luces de aproximación: barras cada 30 m durante 900 m y una barra transversal a 300 m.
    for (let s = -30; s >= -900; s -= 30) for (let t = -2; t <= 2; t += 1) poner(...dePista(p, s, t), Y + 1.2, BLANCA, 0.3, 1.1);
    for (let t = -15; t <= 15; t += 1.5) poner(...dePista(p, -300, t), Y + 1.2, BLANCA, 0.3, 1.1);
  }
  // Eje verde de las calles de rodaje cada 30 m.
  for (const linea of d.rodaje) {
    let falta = 0;
    for (let i = 1; i < linea.length; i++) {
      const [a, b] = [linea[i - 1], linea[i]], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      for (; falta <= l; falta += 30) poner(a[0] + ((b[0] - a[0]) * falta) / l, a[1] + ((b[1] - a[1]) * falta) / l, Y + 0.1, TAXI, 0.18, 0.55);
      falta -= l;
    }
  }
  // Reflectores de las plataformas en postes de 24 m: el resplandor del aeropuerto de noche.
  for (const anillo of d.plataformas) {
    let falta = 0;
    for (let i = 0; i < anillo.length; i++) {
      const [a, b] = [anillo[i], anillo[(i + 1) % anillo.length]], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      for (; falta <= l; falta += 110) poner(a[0] + ((b[0] - a[0]) * falta) / l, a[1] + ((b[1] - a[1]) * falta) / l, Y + 24, REFLECTOR, 0.9, 1.5);
      falta -= l;
    }
  }
  if (d.torre) poner(...d.torre.p, Y + d.torre.alto * 1.1, ROJA, 0.5, 1.2);
  return L;
}

function mallaLucesFijas(d, pistas) {
  const L = lucesFijas(d, pistas);
  const centro = attribute('centro', 'vec3'), tinte = attribute('tinte', 'vec3'), forma = attribute('forma', 'vec2');
  const enciende = smoothstep(0.05, 0.35, noche);
  const tam = max(forma.x, length(centro.sub(cameraPosition)).mul(forma.y).mul(K_LUZ)).mul(enciende);
  const m = new THREE.MeshBasicNodeMaterial({ fog: false });
  m.positionNode = centro.add(positionGeometry.mul(tam));
  m.colorNode = tinte.mul(enciende);
  const malla = mallaLuces(L.length, m, [['centro', 3], ['tinte', 3], ['forma', 2]]);
  const a = malla.geometry.attributes;
  L.forEach(([x, z, y, c, r0, kf], i) => { a.centro.setXYZ(i, x, y, z); a.tinte.setXYZ(i, ...c); a.forma.setXY(i, r0, kf); });
  malla.name = 'Luces del aeropuerto';
  return malla;
}

// ---------------------------------------------------------------------------------------------------------------
// Suelo, pavimentos y edificios.
// ---------------------------------------------------------------------------------------------------------------
// Sabana plana a la altura del aeropuerto alrededor de la caja del terreno, que no llega hasta allá. Cerca del borde
// la malla usa el mismo paso que el terreno y su altura, para empalmar sin grietas; lejos es plana y gruesa.
function mallaSabana(d, t) {
  const P = t.paso, x0 = t.ox, z0 = t.oz, x1 = t.ox + t.ancho, z1 = t.oz + t.largo, BANDA = 600;
  const ejes = (borde, hasta) => {
    const v = [], ini = borde - 40 * P;
    for (let a = -30000; a < ini - 400; a += 1000) v.push(a);
    for (let a = ini; a <= hasta; a += P) v.push(a);
    return v;
  };
  const xs = ejes(x0, -2400), zs = ejes(z0, -5000), nx = xs.length;
  const pts = [...d.pistas.flatMap((p) => p.p), ...d.plataformas.flat()];
  const caja = [Math.min(...pts.map((p) => p[0])) - 300, Math.min(...pts.map((p) => p[1])) - 300, Math.max(...pts.map((p) => p[0])) + 300, Math.max(...pts.map((p) => p[1])) + 300];
  const CIUDAD = rgb(0x8d877b), SABANA = rgb(0x7d8a52), GRAMA = rgb(0x87965a);
  const pos = [], col = [], idx = [];
  for (const z of zs) for (const x of xs) {
    const fuera = Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(z0 - z, 0, z - z1)), h = t.altura(x, z);
    pos.push(x, h + (d.y - h) * suave(0, BANDA, fuera), z);
    const k = suave(300, 2500, fuera), dentro = x > caja[0] && x < caja[2] && z > caja[1] && z < caja[3];
    col.push(...(dentro ? GRAMA : CIUDAD.map((c, i) => c + (SABANA[i] - c) * k)));
  }
  for (let j = 0; j < zs.length - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const xc = (xs[i] + xs[i + 1]) / 2, zc = (zs[j] + zs[j + 1]) / 2;
    if (xc > x0 && xc < x1 && zc > z0 && zc < z1) continue; // ahí ya está el terreno
    const a = j * nx + i, b = a + 1, c = a + nx, e = c + 1;
    idx.push(a, c, b, b, c, e);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 1 });
  m.colorNode = vertexColor().mul(mx_noise_float(positionWorld.xz.mul(0.004)).mul(0.08).add(0.97));
  const malla = new THREE.Mesh(g, m);
  malla.name = 'Sabana del aeropuerto';
  return malla;
}

// Capa plana de triángulos mirando hacia arriba, con un atributo propio por vértice.
function capa(y) { return { y, pos: [], extra: [] }; }
function tri(c, a, b, e) {
  const ny = (b[1] - a[1]) * (e[0] - a[0]) - (b[0] - a[0]) * (e[1] - a[1]);
  for (const v of ny >= 0 ? [a, b, e] : [a, e, b]) { c.pos.push(v[0], c.y, v[1]); for (let i = 2; i < v.length; i++) c.extra.push(v[i]); }
}
function mallaCapa(c, nombre, tam, material) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(c.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(c.pos.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  if (nombre) g.setAttribute(nombre, new THREE.Float32BufferAttribute(c.extra, tam));
  return new THREE.Mesh(g, material);
}
const matPavimento = (capaN) => new THREE.MeshStandardNodeMaterial({ roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -capaN, polygonOffsetUnits: -capaN });
const ruido = (escala, k) => mx_noise_float(positionWorld.xz.mul(escala)).mul(k).add(1);

// Cinta con uniones a inglete; las puntas se alargan medio ancho para tapar los cruces. Extra: distancia al eje.
function cinta(c, p, w) {
  const izq = [], der = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[Math.max(0, i - 1)], b = p[Math.min(p.length - 1, i + 1)];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, dx = (b[0] - a[0]) / l, dz = (b[1] - a[1]) / l;
    let k = 1, [x, z] = p[i];
    if (i > 0 && i < p.length - 1) {
      const l1 = Math.hypot(p[i][0] - a[0], p[i][1] - a[1]) || 1;
      k = 1 / Math.max(0.4, ((p[i][0] - a[0]) * dx + (p[i][1] - a[1]) * dz) / l1);
    }
    if (i === 0) { x -= dx * w; z -= dz * w; }
    if (i === p.length - 1) { x += dx * w; z += dz * w; }
    izq.push([x - dz * w * k, z + dx * w * k, -w]);
    der.push([x + dz * w * k, z - dx * w * k, w]);
  }
  for (let i = 0; i < p.length - 1; i++) { tri(c, izq[i], der[i], izq[i + 1]); tri(c, der[i], der[i + 1], izq[i + 1]); }
}

// Números de pista en un atlas de 4 celdas (30 × 30 m cada una): el número lejos del umbral y la letra cerca.
function atlasDesignadores(pistas) {
  const lienzo = document.createElement('canvas');
  lienzo.width = 1024; lienzo.height = 256;
  const ctx = lienzo.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = 'bold 100px Arial, Helvetica, sans-serif';
  for (const p of Object.values(pistas)) {
    const [, numero, letra] = /^(\d+)([LRC]?)$/.exec(p.nombre) || [0, p.nombre, ''];
    ctx.save();
    ctx.translate(p.celda * 256 + 128, 0);
    ctx.scale(0.6, 1); // cifras angostas y largas, como las pintadas en pista
    ctx.fillText(numero, 0, 72);
    if (letra) ctx.fillText(letra, 0, 190);
    ctx.restore();
  }
  const t = new THREE.CanvasTexture(lienzo);
  t.flipY = false;
  t.anisotropy = 8;
  return t;
}

// Pista de 45 m: bordes, umbral en teclas de piano, designador, punto de mira, zona de toque y eje discontinuo.
// Atributo `pista` = (s desde el primer umbral, t lateral, largo, celda del atlas del primer designador).
function materialPista(atlas) {
  const a = attribute('pista', 'vec4'), s = a.x, t = a.y, L = a.z, at = abs(t), sm = min(s, L.sub(s));
  const fs = max(fwidth(s), 0.02), ft = max(fwidth(t), 0.02);
  const entre = (v, lo, hi, e) => smoothstep(float(lo).sub(e), e.add(lo), v).mul(float(1).sub(smoothstep(float(hi).sub(e), e.add(hi), v)));
  const rayas = (v, periodo, lleno) => { const e = max(fwidth(v.div(periodo)), 0.001), q = fract(v.div(periodo)); return smoothstep(0, e, q).mul(float(1).sub(smoothstep(e.negate().add(lleno), e.add(lleno), q))); };
  const bordes = entre(at, 21.1, 22.0, ft);
  const piano = entre(sm, 6, 36, fs).mul(entre(at, 1.6, 22.0, ft)).mul(rayas(at.sub(1.6), 3.4, 0.5));
  const eje = float(1).sub(smoothstep(ft.negate().add(0.45), ft.add(0.45), at)).mul(rayas(s, 50, 0.6)).mul(entre(sm, 95, 1e5, fs));
  const mira = entre(sm, 300, 360, fs).mul(entre(at, 6, 16, ft));
  const toque = rayas(sm, 150, 0.15).mul(entre(sm, 140, 180, fs).add(entre(sm, 440, 930, fs))).mul(entre(at, 7.5, 10.5, ft));
  // Designador: cerca de cada extremo se lee en el sentido del que aterriza por ahí.
  const cercaA = step(s, L.mul(0.5)), sl = mix(L.sub(s), s, cercaA).sub(48), tl = mix(t.negate(), t, cercaA);
  const celda = a.w.add(float(1).sub(cercaA));
  const uvAtlas = vec2(celda.add(clamp(tl.add(15).div(30), 0.01, 0.99)).div(4), clamp(float(1).sub(sl.div(30)), 0, 1));
  const numero = texture(atlas, uvAtlas).a.mul(entre(sl, 0, 30, fs)).mul(step(at, 15));
  const marcas = max(max(max(bordes, piano), max(eje, mira)), max(toque, numero));
  // Concreto con huellas de llantas oscuras en las zonas de toque.
  const huellas = entre(sm, 250, 1100, float(60)).mul(float(1).sub(smoothstep(4, 10, at))).mul(mx_noise_float(vec2(s.mul(0.02), t.mul(0.4))).mul(0.3).add(0.55));
  const base = vec3(0.3, 0.3, 0.29).mul(ruido(0.08, 0.06)).mul(float(1).sub(huellas.mul(0.55)));
  const m = matPavimento(4);
  m.colorNode = mix(base, vec3(0.82, 0.82, 0.8), marcas.mul(0.92));
  return m;
}

function mallasPavimento(d, pistas) {
  const plataformas = capa(d.y + 0.02);
  for (const anillo of d.plataformas) {
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(anillo.map(([x, z]) => new THREE.Vector2(x, z)), [])) tri(plataformas, anillo[a], anillo[b], anillo[c]);
  }
  const matPlat = matPavimento(2);
  matPlat.colorNode = vec3(0.46, 0.46, 0.44).mul(ruido(0.05, 0.07)).mul(ruido(0.6, 0.03));

  const rodaje = capa(d.y + 0.03);
  for (const linea of d.rodaje) if (linea.length > 1) cinta(rodaje, linea, d.anchoRodaje / 2);
  const lat = attribute('lateral', 'float'), e = max(fwidth(lat), 0.01);
  const ejeAmarillo = float(1).sub(smoothstep(e.negate().add(0.15), e.add(0.15), abs(lat)));
  const matRod = matPavimento(3);
  matRod.colorNode = mix(vec3(0.2, 0.2, 0.21).mul(ruido(0.07, 0.08)), vec3(0.78, 0.56, 0.08), ejeAmarillo.mul(0.9));

  const pista = capa(d.y + 0.05);
  for (const { ref } of d.pistas) {
    const p = pistas[ref.split('/')[0]], w = p.ancho / 2, L = p.largo;
    const v = (s, t) => [...dePista(p, s, t), s, t, L, p.celda];
    tri(pista, v(0, -w), v(0, w), v(L, -w));
    tri(pista, v(0, w), v(L, w), v(L, -w));
  }
  return [mallaCapa(plataformas, null, 0, matPlat), mallaCapa(rodaje, 'lateral', 1, matRod), mallaCapa(pista, 'pista', 4, materialPista(atlasDesignadores(pistas)))];
}

// Recorta un polígono con el semiplano signo·(p·eje − k) ≥ 0 (Sutherland-Hodgman).
function recortar(poli, eje, k, signo) {
  const out = [], f = (p) => signo * (p[0] * eje[0] + p[1] * eje[1] - k);
  for (let i = 0; i < poli.length; i++) {
    const a = poli[i], b = poli[(i + 1) % poli.length], fa = f(a), fb = f(b);
    if (fa >= 0) out.push(a);
    if ((fa >= 0) !== (fb >= 0)) { const t = fa / (fa - fb); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
  }
  return out;
}

// Volumen extruido. Con `arco`, el techo se curva a lo ancho (el T1 nuevo, los hangares): se arma en franjas de
// 12 m para que la curva tenga vértices por dentro de la planta.
function bloque(anillo, Y, { alto, arco = 0, muro, techo, luz = 0 }) {
  const [cx, cz] = centroide(anillo);
  let sxx = 0, szz = 0, sxz = 0;
  for (const [x, z] of anillo) { sxx += (x - cx) ** 2; szz += (z - cz) ** 2; sxz += (x - cx) * (z - cz); }
  const th = 0.5 * Math.atan2(2 * sxz, sxx - szz), ancho = [-Math.sin(th), Math.cos(th)]; // perpendicular al eje largo
  const b = (p) => p[0] * ancho[0] + p[1] * ancho[1], bs = anillo.map(b), b0 = Math.min(...bs), b1 = Math.max(...bs);
  const h = (p) => { const v = (b(p) - (b0 + b1) / 2) / ((b1 - b0) / 2 || 1); return Y + alto + arco * (1 - v * v); };
  const muros = { pos: [], idx: [], color: muro, luz }, techos = { pos: [], idx: [], color: techo };
  const cara = (parte, vs) => { const k = parte.pos.length / 3; for (const v of vs) parte.pos.push(...v); parte.idx.push(k, k + 1, k + 2); };
  for (let i = 0; i < anillo.length; i++) {
    const p = anillo[i], q = anillo[(i + 1) % anillo.length];
    cara(muros, [[p[0], Y, p[1]], [q[0], Y, q[1]], [q[0], h(q), q[1]]]);
    cara(muros, [[p[0], Y, p[1]], [q[0], h(q), q[1]], [p[0], h(p), p[1]]]);
  }
  const paso = arco ? 12 : b1 - b0 + 1;
  for (let k = b0; k < b1; k += paso) {
    const franja = recortar(recortar(anillo, ancho, k, 1), ancho, k + paso, -1);
    if (franja.length < 3) continue;
    for (const t of THREE.ShapeUtils.triangulateShape(franja.map(([x, z]) => new THREE.Vector2(x, z)), [])) cara(techos, t.map((i) => [franja[i][0], h(franja[i]), franja[i][1]]));
  }
  return [muros, techos];
}

function mallaEdificios(d) {
  const Y = d.y, partes = [];
  for (const t of d.terminales) {
    const t1 = /T1/.test(t.nombre);
    partes.push(...bloque(t.p, Y, t1 ? { alto: 16, arco: 9, muro: 0x45545f, techo: 0xd3d6da, luz: 1 } : { alto: 13, muro: 0x9aa0a6, techo: 0x8b9096, luz: 0.25 }));
  }
  for (const h of d.hangares) partes.push(...bloque(h, Y, { alto: 16, arco: 5, muro: 0xb8bdc3, techo: 0x9ca2a8 }));
  if (d.torre) {
    // Torre de control: fuste que se angosta, cabina de vidrio más ancha arriba, techo y antena.
    const { p, alto } = d.torre, c = [p[0], p[1]];
    partes.push(tubo('y', c, [[Y, 16], [Y + 7, 16]], 0xb9b6ae, 0, 10), tubo('y', c, [[Y, 4.4], [Y + alto * 0.82, 3.4]], 0xc8c5be, 0, 12),
      { ...tubo('y', c, [[Y + alto * 0.82, 6.5], [Y + alto * 0.93, 8.5]], 0x2f3f4c, 0, 10), luz: 1 }, tubo('y', c, [[Y + alto * 0.93, 9.2], [Y + alto * 0.955, 9.2]], 0xd0d2d4, 0, 10),
      tubo('y', c, [[Y + alto * 0.955, 0.35], [Y + alto * 1.1, 0.12]], 0x6c7076, 0, 6));
  }
  const g = juntar(partes, 'luz').toNonIndexed();
  g.computeVertexNormals();
  const m = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.25, side: THREE.DoubleSide });
  m.emissiveNode = vec3(1, 0.82, 0.58).mul(attribute('luz', 'float')).mul(noche).mul(0.9); // vidrios encendidos de noche
  const malla = new THREE.Mesh(g, m);
  malla.name = 'Terminales, hangares y torre';
  return malla;
}

// ---------------------------------------------------------------------------------------------------------------
// Flota: una instancia por avión y un grupo de luces que se mueve con ellos.
// ---------------------------------------------------------------------------------------------------------------
function crearFlota(trafico, Y) {
  const geo = juntar(partesAvion(), 'pieza');
  geo.computeVertexNormals();
  const librea = new THREE.InstancedBufferAttribute(new Float32Array(MAX_AVIONES * 3), 3);
  geo.setAttribute('librea', librea);
  const colorNiebla = uniform(new THREE.Color(0xb8c6d4));
  const aviones = new THREE.InstancedMesh(geo, materialAvion(colorNiebla), MAX_AVIONES);
  aviones.frustumCulled = false; // están repartidos en 40 km
  aviones.name = 'Aviones';

  const N = MAX_AVIONES * LUCES_AVION.length;
  const mat = new THREE.MeshBasicNodeMaterial({ fog: false });
  mat.positionNode = attribute('centro', 'vec3').add(positionGeometry.mul(attribute('tam', 'float')));
  mat.colorNode = attribute('tinte', 'vec3');
  const luces = mallaLuces(N, mat, [['centro', 3], ['tinte', 3], ['tam', 1]]);
  luces.name = 'Luces de los aviones';
  const { centro, tinte, tam } = luces.geometry.attributes;
  for (const a of [centro, tinte, tam]) a.setUsage(THREE.DynamicDrawUsage);

  const m4 = new THREE.Matrix4(), cero = new THREE.Matrix4().makeScale(0, 0, 0), q = new THREE.Quaternion(), e = new THREE.Euler();
  const pos = new THREE.Vector3(), esc = new THREE.Vector3(), v = new THREE.Vector3(), alCam = new THREE.Vector3(), frente = new THREE.Vector3();
  const COLORES = { aterrizaje: [1, 0.97, 0.9], roja: [1, 0.05, 0.03], verde: [0.05, 1, 0.25], cola: [1, 1, 1], baliza: [1, 0.06, 0.03], estrobo: [1, 1, 1] };
  const pintadas = new Array(MAX_AVIONES).fill(-1);

  function actualizar(camara, niebla) {
    if (niebla) colorNiebla.value.copy(niebla.color);
    const n = noche.value, reloj = trafico.reloj, cam = camara.position;
    for (const a of trafico.aviones) {
      const base = a.i * LUCES_AVION.length;
      if (!a.activo) {
        aviones.setMatrixAt(a.i, cero);
        for (let k = 0; k < LUCES_AVION.length; k++) tam.setX(base + k, 0);
        continue;
      }
      if (pintadas[a.i] !== a.librea) { librea.setXYZ(a.i, ...LIBREAS[a.librea]); librea.needsUpdate = true; pintadas[a.i] = a.librea; }
      pos.set(a.x, Y + a.h, a.z);
      const dist = pos.distanceTo(cam);
      const s = a.aparicion * (1 + (REALCE - 1) * suave(15, 150, a.h) * suave(3000, 12000, dist));
      q.setFromEuler(e.set(a.cabeceo, a.rumbo, a.alabeo, 'YXZ'));
      m4.compose(pos, q, esc.setScalar(Math.max(s, 1e-4)));
      aviones.setMatrixAt(a.i, m4);

      // Qué luces van encendidas según la fase; las de aterrizaje alumbran sobre todo hacia adelante.
      const enPista = a.fase === 'final' || a.fase === 'rodando' || a.fase === 'despegando' || (a.fase === 'ascenso' && a.h < 3000);
      const moviendo = a.fase !== 'parqueado', vuelo = enPista || a.fase === 'ascenso';
      frente.set(0, 0, -1).applyQuaternion(q);
      const haciaCam = Math.max(0, frente.dot(alCam.subVectors(cam, pos).normalize()));
      const nav = 0.15 + 0.85 * n, fase = reloj + a.i * 0.37, estrobo = (reloj + a.i * 0.23) % 1.3;
      LUCES_AVION.forEach(({ p, tipo }, k) => {
        let brillo = 0, kf = 0.9, r0 = 0.3;
        if (tipo === 'aterrizaje' && enPista) { brillo = 16 * (0.12 + 0.88 * haciaCam * haciaCam); kf = 1.6; r0 = 0.5; }
        else if ((tipo === 'roja' || tipo === 'verde' || tipo === 'cola') && moviendo) brillo = 4 * nav;
        else if (tipo === 'baliza' && moviendo && (fase * 0.85) % 1 < 0.12) { brillo = 8 * (0.3 + 0.7 * n); kf = 1.1; }
        else if (tipo === 'estrobo' && vuelo && (estrobo < 0.06 || (estrobo > 0.16 && estrobo < 0.22))) { brillo = 14; kf = 1.3; }
        brillo *= a.aparicion;
        v.set(...p).applyMatrix4(m4);
        centro.setXYZ(base + k, v.x, v.y, v.z);
        const c = COLORES[tipo];
        tinte.setXYZ(base + k, c[0] * brillo, c[1] * brillo, c[2] * brillo);
        tam.setX(base + k, brillo > 0 ? Math.max(r0 * s, dist * K_LUZ * kf) * Math.min(1, a.aparicion * 2) : 0);
      });
    }
    aviones.instanceMatrix.needsUpdate = true;
    centro.needsUpdate = tinte.needsUpdate = tam.needsUpdate = true;
  }
  return { aviones, luces, actualizar };
}

// ---------------------------------------------------------------------------------------------------------------
// datos = './datos/centro/'. Devuelve { grupo, actualizar(dt, hora, camara) }; `trafico` queda para depurar.
// ---------------------------------------------------------------------------------------------------------------
export async function crearAeropuerto({ terreno, datos }) {
  const r = await fetch(datos + 'aeropuerto.json');
  if (!r.ok) throw new Error(`No se pudo cargar ${datos}aeropuerto.json: ${r.status}`);
  const d = await r.json();
  const trafico = crearTrafico(d);
  const grupo = new THREE.Group();
  grupo.name = 'Aeropuerto El Dorado';
  const flota = crearFlota(trafico, d.y);
  grupo.add(mallaSabana(d, terreno), ...mallasPavimento(d, trafico.pistas), mallaEdificios(d), mallaLucesFijas(d, trafico.pistas), flota.aviones, flota.luces);
  let listo = false;
  function actualizar(dt, hora, camara) {
    // El primer cuadro simula 15 minutos a la hora de la escena: los aviones ya vienen repartidos en la secuencia.
    if (!listo) { trafico.calentar(hora); listo = true; }
    trafico.paso(dt, hora);
    flota.actualizar(camara, grupo.parent?.fog);
  }
  return { grupo, actualizar, trafico };
}
