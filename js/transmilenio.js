import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { attribute, texture, uv, vec2, vec3, float, color, mix, step, smoothstep, abs, fract, max, min, fwidth } from 'three/tsl';
import { noche } from './edificios.js';
import { geometriaRueda } from './vehiculos.js';

// TransMilenio: buses articulados rojos que recorren los carriles exclusivos (vías con bus=true) y estaciones en el
// separador hechas con los vagones de OpenStreetMap (datos/centro/transmilenio.json, ver tools/transmilenio-centro.mjs).
// Cada bus son dos cuerpos con fuelle: el de adelante se apoya en sus dos ejes sobre la trayectoria y el de atrás
// cuelga del pivote y apoya su eje sobre la misma trayectoria, así dobla como un articulado de verdad.
// Todo se dibuja con instancias: 4 llamadas para los buses y 4 para las estaciones.

const ROD = 0.42; // altura de la calzada de bus sobre el terreno (ALTO de una vía de servicio en vias.js)
const PISO = 0.92; // piso de la plataforma = piso del bus (los de TransMilenio son de piso alto)
const MEDIO = 1.27; // medio ancho del bus
const RADIO = 0.5; // radio de las llantas
// Puntos del bus medidos desde la trompa hacia atrás, en metros a lo largo de la trayectoria.
const EJE1 = 2.6, EJE2 = 8.5, PIVOTE = 11.65, EJE3 = 15.2, LARGO = 18;
const ACEL = 1.1, FRENO = 1.5, FRENO_MAX = 4; // m/s²
const RUTAS = ['B74 Portal Norte', 'H75 Portal Usme', 'K86 Portal Eldorado', 'J72 Universidades', 'L10 Portal 20 de Julio',
  'F23 Portal Américas', 'D21 Portal 80', 'G43 Portal Sur'];

// ---------------------------------------------------------------------------------------------------------------
// Recorridos: los tramos de bus se unen en cadenas continuas en el sentido de circulación.
// ---------------------------------------------------------------------------------------------------------------
export function armarCadenas(vias, minimo = 150) {
  const llave = ([x, z]) => `${x},${z}`;
  const lineas = [];
  for (const v of vias) {
    if (!v.bus || v.p.length < 2) continue;
    lineas.push(v.p);
    if (!v.unSentido) lineas.push([...v.p].reverse());
  }
  // Nodos: puntas de cada línea y vértices que comparte con otra (desvíos y empalmes a mitad de un tramo).
  const usos = new Map();
  for (const p of lineas) for (const q of p) usos.set(llave(q), (usos.get(llave(q)) || 0) + 1);
  const aristas = [];
  const dir = (a, b) => { const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
  for (const p of lineas) {
    let tramo = [p[0]];
    for (let i = 1; i < p.length; i++) {
      tramo.push(p[i]);
      if (i < p.length - 1 && usos.get(llave(p[i])) < 2) continue;
      aristas.push({ p: tramo, a: llave(tramo[0]), b: llave(p[i]), d0: dir(tramo[0], tramo[1]), d1: dir(tramo.at(-2), tramo.at(-1)) });
      tramo = [p[i]];
    }
  }
  const salen = new Map(), llegan = new Set(), usadas = new Set();
  for (const e of aristas) {
    if (!salen.has(e.a)) salen.set(e.a, []);
    salen.get(e.a).push(e);
    llegan.add(e.b);
  }
  // En cada cruce sigue la salida más derecha de frente (la que menos gira); nunca da la vuelta en U.
  const seguir = (e) => {
    const lista = [e], vistos = new Set([e.a]);
    while (!vistos.has(e.b)) {
      vistos.add(e.b);
      let mejor = null, md = -0.2;
      for (const c of salen.get(e.b) || []) {
        const d = e.d1[0] * c.d0[0] + e.d1[1] * c.d0[1];
        if (d > md) { md = d; mejor = c; }
      }
      if (!mejor) break;
      lista.push((e = mejor));
    }
    return lista;
  };
  const cadenas = [];
  const agregar = (lista) => {
    for (const e of lista) usadas.add(e);
    const p = [...lista[0].p];
    for (const e of lista.slice(1)) p.push(...e.p.slice(1));
    const s = [0];
    for (let i = 1; i < p.length; i++) s.push(s[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]));
    if (s.at(-1) >= minimo) cadenas.push({ p, s, largo: s.at(-1), ciclo: llave(p[0]) === llave(p.at(-1)) });
  };
  // Primero desde donde entran los buses a la zona; luego desde los tramos que quedaron sin recorrer (desvíos).
  for (const e of aristas) if (!llegan.has(e.a)) agregar(seguir(e));
  for (const e of aristas) if (!usadas.has(e)) agregar(seguir(e));
  return cadenas;
}

// Posición sobre la cadena a s metros del inicio (fuera de ella sigue derecho), corrida a la izquierda según desvio().
function punto(c, s) {
  const { p, s: acum } = c;
  let i = 0, j = p.length - 2;
  // Búsqueda binaria del tramo que contiene s.
  while (i < j) { const m = (i + j + 1) >> 1; if (acum[m] <= s) i = m; else j = m - 1; }
  const [ax, az] = p[i], [bx, bz] = p[i + 1], l = acum[i + 1] - acum[i] || 1, t = (s - acum[i]) / l;
  const ux = (bx - ax) / l, uz = (bz - az) / l, d = desvio(c, s);
  return [ax + (bx - ax) * t + uz * d, az + (bz - az) * t - ux * d]; // la izquierda es (uz, -ux)
}

// Cuánto se corre el bus a la izquierda en s: se arrima a los vagones de su izquierda y se aparta de los de la derecha.
function desvio(c, s) {
  let suma = 0, peso = 0;
  for (const a of c.ajustes) {
    const fuera = Math.max(a.s0 - s, s - a.s1, 0);
    if (fuera >= a.rampa) continue;
    const t = 1 - fuera / a.rampa, w = t * t * (3 - 2 * t);
    suma += w * a.off;
    peso += w;
  }
  return suma / Math.max(1, peso);
}

// Paradas: vagones paralelos a la cadena y a su izquierda (las estaciones están en el separador y los buses abren
// las puertas a la izquierda). Los vagones seguidos de una misma estación forman un grupo; cada bus para en uno.
function paradasDe(c, vagones) {
  c.ajustes = [];
  const objetivos = [];
  for (const v of vagones) {
    const ex = -Math.sin(v.rumbo), ez = -Math.cos(v.rumbo);
    let m = null;
    for (let i = 0; i < c.p.length - 1; i++) {
      const [ax, az] = c.p[i], [bx, bz] = c.p[i + 1], l = c.s[i + 1] - c.s[i];
      if (l < 0.01) continue;
      const ux = (bx - ax) / l, uz = (bz - az) / l, t = Math.max(0, Math.min(l, (v.x - ax) * ux + (v.z - az) * uz));
      const dx = v.x - ax - ux * t, dz = v.z - az - uz * t, d = Math.hypot(dx, dz);
      if (!m || d < m.d) m = { d, s: c.s[i] + t, lat: dx * uz - dz * ux, par: Math.abs(ux * ex + uz * ez) };
    }
    if (!m || m.par < 0.9 || m.d > v.ancho / 2 + 9 || m.s <= 0 || m.s >= c.largo) continue;
    const libre = v.ancho / 2 + MEDIO + 0.2; // del eje del bus al centro del vagón cuando está arrimado
    const tramo = { s0: m.s - v.largo / 2, s1: m.s + v.largo / 2 };
    if (m.lat > 0) {
      const off = m.lat - libre;
      if (off < -2 || off > 8.5) continue;
      c.ajustes.push({ ...tramo, off, rampa: 15 + 4 * Math.abs(off) });
      objetivos.push(Math.min(c.largo - 1, m.s + LARGO / 2)); // el bus queda centrado en el vagón
    } else if (-m.lat < libre) {
      c.ajustes.push({ ...tramo, off: libre + m.lat, rampa: 15 });
    }
  }
  objetivos.sort((a, b) => a - b);
  c.grupos = [];
  for (const t of objetivos) {
    const g = c.grupos.at(-1);
    if (g && t - g.at(-1) < 110) g.push(t); else c.grupos.push([t]);
  }
}

// Flota sin dibujo (se puede probar en node): avanza, frena, para en estaciones y no se monta en el bus de adelante.
export function crearFlota(cadenas, vagones, { cuantos = 16, semilla = 7 } = {}) {
  let sem = semilla;
  const azar = () => (sem = (sem * 16807) % 2147483647) / 2147483647;
  for (const c of cadenas) paradasDe(c, vagones);
  // Reparto: cada bus va a la cadena con más metros por bus.
  const reparto = cadenas.map(() => 0);
  for (let k = 0; k < cuantos && cadenas.length; k++) {
    let mejor = 0;
    cadenas.forEach((c, i) => { if (c.largo / (reparto[i] + 1) > cadenas[mejor].largo / (reparto[mejor] + 1)) mejor = i; });
    reparto[mejor]++;
  }
  const proxima = (b) => {
    const g = b.c.grupos.find((g) => g.at(-1) > b.s + 1);
    if (!g) { b.hasta = Infinity; b.para = false; return; }
    const delante = g.filter((t) => t > b.s + 1);
    b.para = azar() > 0.2; // algunos son expresos y siguen derecho
    b.hasta = b.para ? delante[Math.floor(azar() * delante.length)] : g.at(-1);
  };
  const buses = [];
  cadenas.forEach((c, i) => {
    for (let j = 0; j < reparto[i]; j++) {
      const b = { c, s: ((j + 0.3 + azar() * 0.4) * c.largo) / reparto[i], v: 0, vmax: 10 + azar() * 4, espera: 0, quieto: 0,
        oculto: false, frena: false, ruta: Math.floor(azar() * RUTAS.length), puntos: null };
      proxima(b);
      buses.push(b);
    }
  });
  const ubicar = (b) => [0, EJE1, EJE2, EJE3, LARGO].map((d) => punto(b.c, b.s - d));
  // Distancia de la trompa de b a un punto q si está adelante, en su carril (el cono se abre un poco con la distancia).
  const adelante = (b, q) => {
    const [F, A1, A2] = b.puntos, hx = A1[0] - A2[0], hz = A1[1] - A2[1], l = Math.hypot(hx, hz) || 1;
    const dx = q[0] - F[0], dz = q[1] - F[1], a = (dx * hx + dz * hz) / l, lat = Math.abs(dx * hz - dz * hx) / l;
    return a > 0 && a < 45 && lat < 1.8 + a * 0.06 ? a : Infinity;
  };
  const hueco = (b, i) => {
    let h = Infinity;
    buses.forEach((o, j) => {
      if (o === b || !o.puntos) return;
      const [, oA1, oA2] = o.puntos, [, A1, A2] = b.puntos;
      if ((oA1[0] - oA2[0]) * (A1[0] - A2[0]) + (oA1[1] - oA2[1]) * (A1[1] - A2[1]) <= 0) return; // va en otro sentido
      const a = Math.min(adelante(b, o.puntos[0]), adelante(b, o.puntos[2]), adelante(b, o.puntos[4]));
      // Si los dos se ven adelante (empalmes), pasa primero el de menor índice: así nunca se trancan.
      if (a < h && !(j > i && adelante(o, b.puntos[0]) < Infinity)) h = a;
    });
    return h;
  };

  function avanzar(dt) {
    for (const b of buses) b.puntos = b.oculto ? null : ubicar(b);
    buses.forEach((b, i) => {
      if (b.oculto) {
        // Reaparece al inicio de su cadena cuando no hay otro bus estorbando ahí.
        const [x, z] = punto(b.c, 0);
        if (buses.some((o) => o.puntos && o.puntos.some((q) => Math.hypot(q[0] - x, q[1] - z) < 30))) return;
        Object.assign(b, { s: 0, v: b.vmax * 0.7, oculto: false, quieto: 0 });
        b.puntos = ubicar(b);
        proxima(b);
        return;
      }
      if (b.espera > 0) { b.espera -= dt; b.v = 0; b.frena = true; return; }
      let vo = Math.min(b.vmax, Math.sqrt(2 * FRENO * Math.max(0, hueco(b, i) - 5)));
      if (b.para) vo = Math.min(vo, Math.sqrt(2 * FRENO * Math.max(0, b.hasta - b.s)));
      b.frena = vo < b.v - 0.2;
      b.v = Math.max(0, b.v + Math.max(-FRENO_MAX * dt, Math.min(ACEL * dt, vo - b.v)));
      b.s += b.v * dt;
      // Seguro contra trancones raros: el que lleva mucho rato quieto sale y vuelve a entrar.
      b.quieto = b.v < 0.1 ? b.quieto + dt : 0;
      if (b.para && b.hasta - b.s < 0.4 && b.v < 0.8) {
        Object.assign(b, { v: 0, espera: 6 + azar() * 8, para: false });
      } else if (b.s > b.hasta + 0.5) proxima(b);
      if (b.s > b.c.largo) {
        if (b.c.ciclo) { b.s -= b.c.largo; proxima(b); } else b.oculto = true;
      }
      if (b.quieto > 40) b.oculto = true;
    });
    for (const b of buses) b.puntos = b.oculto ? null : ubicar(b);
  }
  return { buses, avanzar };
}

// ---------------------------------------------------------------------------------------------------------------
// Geometría: secciones redondeadas unidas a lo largo de z (loft), como las costillas de los carros de vehiculos.js.
// ---------------------------------------------------------------------------------------------------------------

// Sección de superelipse centrada en cx: esquinas de abajo más cerradas que las de arriba. Va en sentido
// antihorario visto desde +z, para que las caras del loft miren hacia afuera.
function anillo(z, w, y0, y1, { cx = 0, abajo = 9, arriba = 5, M = 32 } = {}) {
  const pts = [], yc = (y0 + y1) / 2, h = (y1 - y0) / 2;
  for (let k = 0; k < M; k++) {
    const t = -Math.PI / 2 + (k / M) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t), n = s > 0 ? arriba : abajo;
    pts.push([cx + w * Math.sign(c) * Math.abs(c) ** (2 / n), yc + h * Math.sign(s) * Math.abs(s) ** (2 / n), z]);
  }
  return pts;
}

// Une anillos del mismo número de puntos (ordenados por z creciente) con normales suaves; las tapas van aparte
// para que queden planas.
function loft(anillos, pieza = 0, tapas = true) {
  const n = anillos[0].length, pos = anillos.flat(2), idx = [];
  for (let s = 0; s < anillos.length - 1; s++) for (let k = 0; k < n; k++) {
    const a = s * n + k, b = s * n + ((k + 1) % n), c = a + n, d = b + n;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const partes = [g.toNonIndexed()];
  if (tapas) {
    for (const [a, adelante] of [[anillos[0], true], [anillos.at(-1), false]]) {
      const c = a.reduce((m, p) => [m[0] + p[0] / n, m[1] + p[1] / n, m[2] + p[2] / n], [0, 0, 0]), t = [];
      for (let k = 0; k < n; k++) t.push(...c, ...(adelante ? a[(k + 1) % n] : a[k]), ...(adelante ? a[k] : a[(k + 1) % n]));
      const tapa = new THREE.BufferGeometry();
      tapa.setAttribute('position', new THREE.Float32BufferAttribute(t, 3));
      tapa.computeVertexNormals();
      partes.push(tapa);
    }
  }
  const malla = mergeGeometries(partes);
  malla.setAttribute('pieza', new THREE.Float32BufferAttribute(new Float32Array(malla.attributes.position.count).fill(pieza), 1));
  return malla;
}

// Redondeo en planta de las puntas: cuánto se mete el costado a u metros de la punta con radio r.
const redondeo = (u, r) => (u >= r ? 0 : r - Math.sqrt(r * r - (r - Math.max(0, u)) ** 2));

// Un cuerpo del articulado, de z0 (adelante, -z) a z1. nariz: trompa con parabrisas inclinado; ejes: pasos de rueda.
function cuerpo(z0, z1, { nariz = false, cola = false, ejes = [] }) {
  // La pintura va por shader: basta con anillos donde cambia la forma (puntas y pasos de rueda) y algunos en medio.
  const zs = new Set();
  for (let z = z0; z < z1; z += 1.5) zs.add(z);
  for (const u of [0, 0.03, 0.08, 0.15, 0.25, 0.4, 0.6, 0.9, 1.2]) { zs.add(z0 + u); zs.add(z1 - u); }
  for (const e of ejes) for (let k = -6; k <= 6; k++) zs.add(e + (k / 6) * 0.64);
  const anillos = [...zs].filter((z) => z >= z0 && z <= z1).sort((a, b) => a - b).map((z) => {
    const r0 = nariz ? 0.25 : 0.1, r1 = cola ? 0.25 : 0.1, dentro = Math.max(redondeo(z - z0, r0), redondeo(z1 - z, r1));
    let y0 = 0.42 + dentro * 0.5;
    // Paso de rueda: el bajo sube en arco sobre cada eje.
    for (const e of ejes) { const d = Math.abs(z - e); if (d < 0.64) y0 = Math.max(y0, RADIO + Math.sqrt(0.64 * 0.64 - d * d)); }
    const a = anillo(z, MEDIO - dentro, y0, 3.12 - dentro * 0.4, { M: 28 });
    // Parabrisas inclinado hacia atrás arriba, y la cola apenas recogida.
    for (const q of a) {
      const g = Math.max(0, (q[1] - 1.25) / 1.85) ** 1.3;
      if (nariz) q[2] += 0.2 * g * Math.max(0, 1 - (z - z0) / 1.2);
      if (cola) q[2] -= 0.06 * g * Math.max(0, 1 - (z1 - z) / 0.8);
    }
    return a;
  });
  return loft(anillos);
}

// Pieza redondeada simple (bómperes, aire acondicionado, espejos).
function bloque(z0, z1, w, y0, y1, pieza, opciones = {}) {
  const zs = [...new Set([0, 0.02, 0.06, 0.12, 0.2].flatMap((u) => [z0 + u, z1 - u]).concat([(z0 + z1) / 2]))]
    .filter((z) => z >= z0 && z <= z1).sort((a, b) => a - b);
  const r = Math.min(0.2, (z1 - z0) / 2);
  return loft(zs.map((z) => { const d = Math.max(redondeo(z - z0, r), redondeo(z1 - z, r)); return anillo(z, w - d * 0.6, y0, y1 - d * 0.3, { abajo: 5, arriba: 4, M: 20, ...opciones }); }), pieza);
}

// Geometrías de los dos cuerpos. Origen del de adelante: su primer eje; del de atrás: el pivote del fuelle.
function geometriasBus() {
  const zF = -EJE1, zE2 = EJE2 - EJE1, zFin = PIVOTE - EJE1 - 0.38;
  const espejos = [-1, 1].map((s) => {
    // Espejos "orejas de conejo": brazo que sale del techo y cuelga delante del parabrisas.
    const brazo = [];
    for (let t = 0; t <= 1; t += 0.125) brazo.push(anillo(zF + 0.45 - t * 0.75, 0.03, 2.8 - t * 0.3 - 0.03, 2.8 - t * 0.3 + 0.03, { cx: s * (1.18 + t * 0.22), abajo: 2, arriba: 2, M: 8 }));
    return [loft(brazo, 1), bloque(zF - 0.42, zF - 0.24, 0.06, 2.12, 2.52, 1, { cx: s * 1.42 })];
  }).flat();
  const adelante = mergeGeometries([
    cuerpo(zF, zFin, { nariz: true, ejes: [0, zE2] }),
    bloque(zF - 0.07, zF + 0.3, MEDIO - 0.03, 0.36, 0.6, 1), // bómper
    bloque(0.6, 4.4, 0.88, 3.0, 3.38, 2), // aire acondicionado
    ...espejos,
  ]);
  const zR = LARGO - PIVOTE, zE3 = EJE3 - PIVOTE;
  // Fuelle: anillos que alternan ancho para hacer los pliegues.
  const fuelle = [];
  for (let k = 0; k <= 16; k++) fuelle.push(anillo(-0.4 + k * 0.05 + 0.01, k % 2 ? 1.13 : 1.2, 0.55, k % 2 ? 2.95 : 3.0, { abajo: 6, arriba: 6, M: 24 }));
  const atras = mergeGeometries([
    cuerpo(0.38, zR, { cola: true, ejes: [zE3] }),
    loft(fuelle, 1),
    bloque(zR - 0.25, zR + 0.06, MEDIO - 0.03, 0.36, 0.6, 1),
    bloque(1.2, 4.6, 0.85, 3.0, 3.32, 2),
  ]);
  return { adelante, atras, zF, zFin, zR };
}

// ---------------------------------------------------------------------------------------------------------------
// Pintura por shader: rojo TransMilenio con franja blanca, ventanas oscuras que se iluminan de noche, puertas a la
// izquierda (-x, el bus mira a -z), faros y pilotos. Adaptado de Slop New York (mrdoob, MIT): js/bus.js.
// ---------------------------------------------------------------------------------------------------------------
function materialBus({ frente = null, cola = null, puertas = [], zA, zB }) {
  const p = attribute('position', 'vec3'), n = attribute('normal', 'vec3'), pieza = attribute('pieza', 'float');
  const freno = attribute('estado', 'vec2').x;
  // Franja de a a b con bordes suavizados al tamaño del píxel.
  const banda = (t, a, b) => {
    const f = max(fwidth(t), float(0.002));
    return smoothstep(float(a).sub(f), float(a).add(f), t).sub(smoothstep(float(b).sub(f), float(b).add(f), t));
  };
  const piel = float(1).sub(step(0.5, pieza));
  const lado = smoothstep(0.55, 0.8, abs(n.x)).mul(piel), izq = step(p.x, 0);
  let dz = float(99);
  for (const z of puertas) dz = min(dz, abs(p.z.sub(z)));
  const puerta = banda(dz, -1, 0.56).mul(banda(p.y, 0.95, 2.78)).mul(lado).mul(izq);
  // Dos hojas de vidrio por puerta.
  const hoja = banda(abs(dz.sub(0.27)), -1, 0.21).mul(banda(p.y, 1.05, 2.68)).mul(puerta);
  const pilar = banda(abs(fract(p.z.div(1.45)).sub(0.5)), 0.47, 1); // parales negros entre ventanas
  const ventana = banda(p.y, 1.32, 2.62).mul(banda(p.z, zA, zB)).mul(lado).mul(float(1).sub(puerta));
  let vidrio = ventana.mul(float(1).sub(pilar.mul(0.6)));
  let negro = float(0), faro = float(0), piloto = float(0), frontal = float(0);
  if (frente !== null) {
    const fr = smoothstep(0.45, 0.75, n.z.negate()).mul(step(p.z, frente + 0.5)).mul(piel);
    const parabrisas = banda(p.y, 1.18, 2.62).mul(banda(abs(p.x), -1, 0.84)).mul(fr);
    vidrio = max(vidrio, parabrisas.mul(float(1).sub(banda(p.x, -0.02, 0.02))));
    negro = max(negro, banda(p.y, 2.66, 3.0).mul(banda(abs(p.x), -1, 0.9)).mul(fr)); // marco del letrero de ruta
    faro = banda(p.y, 0.62, 0.8).mul(banda(abs(p.x), 0.52, 0.86)).mul(fr);
    frontal = fr;
  }
  if (cola !== null) {
    const co = smoothstep(0.45, 0.75, n.z).mul(step(cola - 0.5, p.z)).mul(piel);
    vidrio = max(vidrio, banda(p.y, 1.75, 2.6).mul(banda(abs(p.x), -1, 0.76)).mul(co));
    piloto = banda(p.y, 0.62, 1.35).mul(banda(abs(p.x), 0.8, 0.97)).mul(co);
  }
  const franja = banda(p.y, 1.0, 1.13).mul(max(lado, frontal)).mul(float(1).sub(puerta));
  const falda = float(1).sub(smoothstep(0.58, 0.62, p.y)).mul(piel);
  const techo = smoothstep(0.55, 0.8, n.y).mul(piel);
  let c = mix(color(0xc4161c), color(0xeceae4), franja);
  c = mix(c, color(0x2a2b2e), falda);
  c = mix(c, color(0xd6d7d4), techo);
  c = mix(c, color(0x0a0b0c), max(negro, puerta));
  const vidrioTotal = max(vidrio, hoja);
  c = mix(c, color(0x10161c), vidrioTotal);
  c = mix(c, color(0xf4f2ea), faro);
  c = mix(c, color(0x8a0d0d), piloto);
  c = mix(c, color(0x141517), step(0.5, pieza).mul(step(pieza, 1.5)));
  c = mix(c, color(0xcfd1d0), step(1.5, pieza));
  const m = new THREE.MeshStandardNodeMaterial();
  m.colorNode = c;
  m.roughnessNode = mix(float(0.38), float(0.1), vidrioTotal);
  m.metalnessNode = mix(float(0.12), float(0.4), vidrioTotal);
  // De noche: cabina con luz blanca fría, faros y pilotos (más fuertes al frenar) por encima del umbral del bloom.
  m.emissiveNode = vec3(0.8, 0.88, 1.0).mul(vidrioTotal.mul(noche).mul(1.1))
    .add(vec3(1.0, 0.96, 0.86).mul(faro.mul(noche.mul(3.2).add(0.8))))
    .add(vec3(1.0, 0.05, 0.03).mul(piloto.mul(noche.mul(1.6).add(freno.mul(2.4)).add(0.2))));
  return m;
}

// Letreros con texto en una sola textura (filas): rutas de los buses y nombres de las estaciones.
function atlas(textos, { ancho = 1024, alto = 64, fondo, tinta, fuente }) {
  const canvas = document.createElement('canvas');
  canvas.width = ancho;
  canvas.height = alto * textos.length;
  const ctx = canvas.getContext('2d');
  textos.forEach((t, i) => {
    ctx.fillStyle = fondo;
    ctx.fillRect(0, i * alto, ancho, alto);
    let px = alto * 0.62;
    ctx.font = `bold ${px}px ${fuente}`;
    const w = ctx.measureText(t).width;
    if (w > ancho * 0.92) { px *= (ancho * 0.92) / w; ctx.font = `bold ${px}px ${fuente}`; }
    ctx.fillStyle = tinta;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(t, ancho / 2, i * alto + alto / 2 + 2);
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false; // fila i ocupa v de i/N a (i+1)/N, con v = 0 arriba
  tex.anisotropy = 8;
  return tex;
}

// ---------------------------------------------------------------------------------------------------------------
// Estaciones: plataforma elevada con estructura metálica gris, vidrios, techo curvo, letrero rojo con el nombre y
// luz de noche. Cada vagón de OpenStreetMap es un módulo; todos van en 4 mallas.
// ---------------------------------------------------------------------------------------------------------------
function estaciones(vagones, terreno) {
  const nombres = [...new Set(vagones.map((v) => v.nombre))];
  const estructura = [], vidrios = [], luces = [], letreros = [];
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), uno = new THREE.Vector3(1, 1, 1), pos = new THREE.Vector3();
  const pintar = (g, hex) => {
    const c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    return g;
  };
  const caja = (lista, hex, x, y, z, sx, sy, sz) => {
    const g = new THREE.BoxGeometry(sx, sy, sz).toNonIndexed();
    g.deleteAttribute('uv');
    lista.push(pintar(g.translate(x, y, z).applyMatrix4(m4), hex));
  };
  const plano = (lista, x, y, z, sx, sy, giro) => {
    const g = new THREE.PlaneGeometry(sx, sy).rotateY(giro).translate(x, y, z).applyMatrix4(m4);
    if (lista !== letreros) g.deleteAttribute('uv');
    lista.push(g);
    return g;
  };
  const GRIS = 0x7c8288, CONCRETO = 0x9a968e, TECHO = 0xc9ccd0;
  for (const v of vagones) {
    const { largo: L, ancho: A } = v, ex = -Math.sin(v.rumbo), ez = -Math.cos(v.rumbo);
    const yA = terreno.altura(v.x + ex * L / 2, v.z + ez * L / 2), yB = terreno.altura(v.x - ex * L / 2, v.z - ez * L / 2);
    v.y = terreno.altura(v.x, v.z) + ROD;
    q.setFromEuler(e.set(Math.atan2(yA - yB, L), v.rumbo, 0, 'YXZ'));
    m4.compose(pos.set(v.x, v.y, v.z), q, uno);

    // Carriles de parada en concreto a lado y lado, un poco por debajo de las vías para que ellas manden donde se
    // cruzan. Siguen el terreno cada 8 m.
    const ap = [], w = A / 2 + 3.7, pasos = Math.ceil((L + 24) / 8);
    for (let k = 0; k < pasos; k++) {
      const t0 = -L / 2 - 12 + k * ((L + 24) / pasos), t1 = t0 + (L + 24) / pasos;
      const esq = [[-w, t0], [w, t0], [w, t1], [-w, t1]].map(([lx, lz]) => {
        const x = v.x + lx * -ez + lz * -ex, z = v.z + lx * ex + lz * -ez; // lx a la derecha del rumbo, lz hacia atrás
        return [x, terreno.altura(x, z) + ROD - 0.025, z];
      });
      for (const i of [0, 2, 1, 0, 3, 2]) ap.push(...esq[i]);
    }
    const gAp = new THREE.BufferGeometry();
    gAp.setAttribute('position', new THREE.Float32BufferAttribute(ap, 3));
    gAp.computeVertexNormals();
    estructura.push(pintar(gAp, 0x8b877f));

    caja(estructura, CONCRETO, 0, (PISO - 0.8) / 2, 0, A, PISO + 0.8, L); // plataforma
    const H = 2.75; // del piso al borde del techo
    for (const s of [-1, 1]) {
      const x = s * (A / 2 - 0.05);
      const nc = Math.round(L / 4);
      for (let k = 0; k <= nc; k++) caja(estructura, GRIS, x, PISO + H / 2, -L / 2 + 0.05 + (k * (L - 0.1)) / nc, 0.1, H, 0.1); // columnas
      caja(estructura, GRIS, x, PISO + 0.06, 0, 0.08, 0.12, L); // zócalo
      caja(estructura, GRIS, x, PISO + 1.05, 0, 0.05, 0.05, L); // baranda
      caja(estructura, GRIS, x, PISO + 2.55, 0, 0.07, 0.4, L); // friso bajo el techo
      plano(vidrios, x, PISO + 1.25, 0, L, 2.3, s * Math.PI / 2);
      plano(vidrios, 0, PISO + 1.25, s * (L / 2 - 0.05), A, 2.3, 0); // vidrio de las puntas
      caja(estructura, GRIS, 0, PISO + 2.55, s * (L / 2 - 0.05), A, 0.4, 0.07);
      // Letrero rojo con el nombre, en el friso de cada costado, mirando hacia afuera.
      const g = plano(letreros, s * (A / 2 + 0.005), PISO + 2.55, 0, Math.min(6.7, L * 0.5), 0.4, s * Math.PI / 2);
      const fila = nombres.indexOf(v.nombre), uvs = g.attributes.uv;
      for (let i = 0; i < uvs.count; i++) uvs.setY(i, (fila + 1 - uvs.getY(i)) / nombres.length);
    }
    // Techo curvo: arco arriba y abajo, extruido a lo largo del vagón.
    const X = A / 2 + 0.45, arco = (k, dy) => { const t = k / 8, x = X - 2 * X * t; return [x, PISO + H + dy + 0.4 * (1 - (x / X) ** 2)]; };
    const perfil = [...Array.from({ length: 9 }, (_, k) => arco(k, 0.1)), ...Array.from({ length: 9 }, (_, k) => arco(8 - k, 0))];
    // Antihorario visto desde +z: el borde derecho de abajo hacia arriba, el arco de arriba hacia la izquierda, y vuelve por abajo.
    const techo = loft([-L / 2 - 0.3, L / 2 + 0.3].map((z) => [perfil.at(-1), ...perfil.slice(0, -1)].map(([x, y]) => [x, y, z])), 0);
    techo.deleteAttribute('pieza');
    estructura.push(pintar(techo.applyMatrix4(m4), TECHO));
    const luz = new THREE.BoxGeometry(0.3, 0.04, L - 1).toNonIndexed();
    luz.deleteAttribute('uv');
    luces.push(luz.translate(0, PISO + H + 0.05, 0).applyMatrix4(m4));
  }

  const matEstructura = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.35 });
  const matVidrio = new THREE.MeshStandardNodeMaterial({ color: 0xa9c1cc, transparent: true, opacity: 0.28, roughness: 0.06, metalness: 0.2,
    side: THREE.DoubleSide, depthWrite: false });
  matVidrio.emissiveNode = vec3(0.6, 0.7, 0.8).mul(noche.mul(0.08));
  const matLuz = new THREE.MeshBasicNodeMaterial();
  matLuz.colorNode = vec3(0.92, 0.96, 1.0).mul(float(0.35).add(noche.mul(3.2)));
  const matLetrero = new THREE.MeshBasicNodeMaterial();
  const texNombres = atlas(nombres, { fondo: '#c4161c', tinta: '#ffffff', fuente: 'system-ui, sans-serif' });
  matLetrero.colorNode = texture(texNombres, uv()).rgb.mul(float(1).add(noche.mul(0.8)));
  const grupo = new THREE.Group();
  grupo.name = 'Estaciones';
  const mallas = [[estructura, matEstructura], [vidrios, matVidrio], [luces, matLuz], [letreros, matLetrero]].map(([l, m]) => new THREE.Mesh(mergeGeometries(l), m));
  mallas[0].castShadow = mallas[0].receiveShadow = true;
  grupo.add(...mallas);
  return grupo;
}

// ---------------------------------------------------------------------------------------------------------------
// Todo junto.
// ---------------------------------------------------------------------------------------------------------------
export async function crearTransMilenio({ vias, terreno, datos, cuantos = 18 }) {
  const r = await fetch(datos + 'transmilenio.json');
  const vagones = r.ok ? await r.json() : [];
  const cadenas = armarCadenas(vias);
  const flota = crearFlota(cadenas, vagones, { cuantos });
  const N = flota.buses.length;
  const grupo = new THREE.Group();
  grupo.name = 'TransMilenio';
  if (vagones.length) grupo.add(estaciones(vagones, terreno));
  if (!N) return { grupo, actualizar: () => {}, flota, cadenas, vagones };

  const G = geometriasBus();
  const estado = new THREE.InstancedBufferAttribute(new Float32Array(N * 2), 2); // x: freno, y: ruta
  flota.buses.forEach((b, i) => { estado.array[i * 2 + 1] = b.ruta; });
  estado.setUsage(THREE.DynamicDrawUsage);
  G.adelante.setAttribute('estado', estado);
  G.atras.setAttribute('estado', estado);
  // Letrero de ruta sobre el parabrisas, inclinado como él.
  const yL = 2.8, zL = G.zF + 0.2 * Math.max(0, (yL - 1.25) / 1.85) ** 1.3 - 0.015;
  const letrero = new THREE.PlaneGeometry(1.5, 0.26).rotateY(Math.PI).rotateX(0.13).translate(0, yL, zL);
  letrero.setAttribute('estado', estado);
  const matLetrero = new THREE.MeshBasicNodeMaterial();
  const texRutas = atlas(RUTAS, { alto: 64, fondo: '#0b0b0b', tinta: '#ffb21a', ancho: 384, fuente: 'ui-monospace, monospace' });
  const ruta = attribute('estado', 'vec2').y;
  matLetrero.colorNode = texture(texRutas, vec2(uv().x, ruta.add(float(1).sub(uv().y)).div(RUTAS.length))).rgb.mul(float(0.9).add(noche.mul(2.4)));
  const matRueda = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.6 });
  const mallas = {
    adelante: new THREE.InstancedMesh(G.adelante, materialBus({ frente: G.zF, puertas: [3.9 - EJE1, 7.1 - EJE1], zA: G.zF + 0.35, zB: G.zFin - 0.25 }), N),
    atras: new THREE.InstancedMesh(G.atras, materialBus({ cola: G.zR, puertas: [13.1 - PIVOTE, 16.6 - PIVOTE], zA: 0.6, zB: G.zR - 0.35 }), N),
    letreros: new THREE.InstancedMesh(letrero, matLetrero, N),
    ruedas: new THREE.InstancedMesh(geometriaRueda(RADIO), matRueda, N * 6),
  };
  for (const m of Object.values(mallas)) {
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false; // se mueven por toda la zona
    m.castShadow = m !== mallas.letreros;
    m.receiveShadow = true;
    grupo.add(m);
  }

  // Ruedas: [x, z, cuerpo] (0 adelante, 1 atrás).
  const RUEDAS = [-1, 1].flatMap((s) => [[s * 1.12, 0, 0], [s * 1.12, EJE2 - EJE1, 0], [s * 1.12, EJE3 - PIVOTE, 1]]);
  const m1 = new THREE.Matrix4(), m2 = new THREE.Matrix4(), tmp = new THREE.Matrix4(), giro = new THREE.Matrix4();
  const q = new THREE.Quaternion(), e = new THREE.Euler(), uno = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3(), piv = new THREE.Vector3();
  const cero = new THREE.Matrix4().makeScale(0, 0, 0);
  const alto = ([x, z]) => terreno.altura(x, z) + ROD;
  function colocar(i, b) {
    if (!b.puntos) {
      for (const m of [mallas.adelante, mallas.atras, mallas.letreros]) m.setMatrixAt(i, cero);
      for (let k = 0; k < 6; k++) mallas.ruedas.setMatrixAt(i * 6 + k, cero);
      return;
    }
    const [, A1, A2, A3] = b.puntos, y1 = alto(A1), y2 = alto(A2), y3 = alto(A3);
    let dx = A1[0] - A2[0], dz = A1[1] - A2[1];
    q.setFromEuler(e.set(Math.atan2(y1 - y2, Math.hypot(dx, dz)), Math.atan2(-dx, -dz), 0, 'YXZ'));
    m1.compose(p.set(A1[0], y1, A1[1]), q, uno);
    // El de atrás cuelga del pivote del de adelante y apunta a su eje sobre la trayectoria.
    piv.set(0, 0, PIVOTE - EJE1).applyMatrix4(m1);
    dx = piv.x - A3[0]; dz = piv.z - A3[1];
    q.setFromEuler(e.set(Math.atan2(piv.y - y3, Math.hypot(dx, dz)), Math.atan2(-dx, -dz), 0, 'YXZ'));
    m2.compose(piv, q, uno);
    mallas.adelante.setMatrixAt(i, m1);
    mallas.letreros.setMatrixAt(i, m1);
    mallas.atras.setMatrixAt(i, m2);
    giro.makeRotationX(-b.s / RADIO);
    RUEDAS.forEach(([x, z, k], j) => mallas.ruedas.setMatrixAt(i * 6 + j, tmp.makeTranslation(x, RADIO, z).multiply(giro).premultiply(k ? m2 : m1)));
  }

  // Luces de las estaciones: unas pocas reales en los vagones más cercanos a la cámara (como las farolas).
  const LUCES = 8, luces = [];
  for (let i = 0; i < LUCES; i++) {
    const l = new THREE.PointLight(0xe6efff, 0, 28, 1.4);
    l.position.set(0, -1000, 0);
    grupo.add(l);
    luces.push(l);
  }
  const orden = [...vagones];

  function actualizar(dt, camara) {
    flota.avanzar(Math.min(dt, 0.1));
    flota.buses.forEach((b, i) => { colocar(i, b); estado.array[i * 2] = b.frena ? 1 : 0; });
    for (const m of Object.values(mallas)) m.instanceMatrix.needsUpdate = true;
    estado.needsUpdate = true;
    const fuerza = Math.min(1, Math.max(0, (noche.value - 0.2) * 1.6));
    let n = 0;
    if (fuerza > 0 && camara && orden.length) {
      const { x, z } = camara.position;
      for (const v of orden) v.d2 = (v.x - x) ** 2 + (v.z - z) ** 2;
      orden.sort((a, b) => a.d2 - b.d2);
      for (; n < Math.min(LUCES, orden.length) && orden[n].d2 < 500 * 500; n++) {
        const v = orden[n];
        luces[n].position.set(v.x, v.y + PISO + 2.3, v.z);
        luces[n].intensity = 40 * fuerza;
      }
    }
    for (let i = n; i < LUCES; i++) { luces[i].intensity = 0; luces[i].position.set(0, -1000, 0); }
  }
  actualizar(0, null);

  return { grupo, actualizar, flota, cadenas, vagones };
}
