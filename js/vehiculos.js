import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  attribute, vertexColor, float, vec2, vec3, abs, max, min, clamp, mix, step, smoothstep, length, fwidth, pow, dot,
  normalize, reflect, positionGeometry, normalGeometry, positionWorld, normalWorld, cameraPosition, materialColor,
  materialReference, uv,
} from 'three/tsl';
import { noche, pulso } from './edificios.js';
import { anchoVia } from './vias.js';

// Carros armados en código: la carrocería se arma con secciones a lo largo del carro (como costillas) a partir de
// perfiles de altura y ancho, y se le pegan detalles simples. Solo el exterior: los vidrios son oscuros y no hay
// interior. Faros, pilotos, parrilla, puertas y manijas se dibujan en la pintura con un shader.
// Cada carro mira hacia -z y su centro está entre los dos ejes, a ras del suelo.

// Adaptado de Slop New York (mrdoob, MIT): js/cars.js (smoothCurve).
// Interpola una lista de pares [t, valor] con un spline cúbico monótono (Fritsch-Carlson): pasa suave por los
// puntos sin pasarse de largo y, a diferencia del smoothstep por tramos, no se aplana en cada punto.
const curva = (puntos) => {
  const n = puntos.length, xs = puntos.map((p) => p[0]), ys = puntos.map((p) => p[1]);
  if (n === 1) return () => ys[0];
  const h = [], d = [];
  for (let i = 0; i < n - 1; i++) { h.push(xs[i + 1] - xs[i]); d.push((ys[i + 1] - ys[i]) / h[i]); }
  const m = [d[0]];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) { m.push(0); continue; }
    const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
    m.push((w1 + w2) / (w1 / d[i - 1] + w2 / d[i]));
  }
  m.push(d[n - 2]);
  return (t) => {
    if (t <= xs[0]) return ys[0];
    if (t >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (t > xs[i + 1]) i++;
    const u = (t - xs[i]) / h[i], u2 = u * u, u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * ys[i] + (u3 - 2 * u2 + u) * h[i] * m[i] + (-2 * u3 + 3 * u2) * ys[i + 1] + (u3 - u2) * h[i] * m[i + 1];
  };
};

// t va de 0 (trompa) a 1 (cola). Alturas en metros; anchos como fracción del medio ancho.
// puertas: dónde van las costuras de las puertas; manijas: dónde van las manijas (en t).
export const TIPOS = {
  taxi: {
    nombre: 'Taxi', largo: 3.6, ancho: 1.6, ejes: [0.17, 0.83], radio: 0.29, colores: [0xf2bf16],
    bajo: [[0, 0.34], [0.08, 0.2], [0.92, 0.2], [1, 0.36]],
    cintura: [[0, 0.62], [0.06, 0.8], [0.24, 0.9], [0.7, 0.94], [0.94, 0.96], [1, 0.86]],
    techo: [[0.22, 0.9], [0.4, 1.47], [0.86, 1.48], [0.97, 1.0]],
    parabrisas: [0.22, 0.4], vidrioTrasero: [0.86, 0.97], pilares: [0.6],
    anchoBajo: [[0, 0.88], [0.07, 0.98], [0.15, 1], [0.9, 1], [1, 0.93]], anchoTecho: 0.84,
    puertas: [0.25, 0.6, 0.8], manijas: [0.54, 0.76],
    taxi: true,
  },
  sedan: {
    nombre: 'Sedán', largo: 4.3, ancho: 1.7, ejes: [0.19, 0.79], radio: 0.31,
    colores: [0x2b2f36, 0xb9bcc0, 0x8d1b1b, 0xe9e7e2, 0x1f3550, 0x5a5e63],
    bajo: [[0, 0.34], [0.09, 0.22], [0.92, 0.22], [1, 0.36]],
    cintura: [[0, 0.64], [0.05, 0.8], [0.29, 0.9], [0.62, 0.95], [0.8, 1.0], [0.97, 0.98], [1, 0.8]],
    techo: [[0.3, 0.91], [0.46, 1.42], [0.62, 1.43], [0.78, 1.0]],
    parabrisas: [0.3, 0.46], vidrioTrasero: [0.62, 0.78], pilares: [0.54],
    anchoBajo: [[0, 0.86], [0.06, 0.97], [0.15, 1], [0.86, 1], [0.97, 0.96], [1, 0.9]], anchoTecho: 0.8,
    puertas: [0.31, 0.54, 0.7], manijas: [0.48, 0.66],
  },
  camioneta: {
    nombre: 'Camioneta', largo: 4.5, ancho: 1.82, ejes: [0.18, 0.8], radio: 0.35,
    colores: [0x9aa3ab, 0x1c1d20, 0xf0efeb, 0x3d4a3f, 0x6b1f24, 0x47505a],
    bajo: [[0, 0.42], [0.08, 0.3], [0.92, 0.3], [1, 0.44]],
    cintura: [[0, 0.76], [0.05, 0.92], [0.27, 1.02], [0.8, 1.08], [0.97, 1.08], [1, 0.96]],
    techo: [[0.27, 1.02], [0.42, 1.62], [0.9, 1.63], [0.985, 1.12]],
    parabrisas: [0.27, 0.42], vidrioTrasero: [0.9, 0.985], pilares: [0.58, 0.79],
    anchoBajo: [[0, 0.9], [0.06, 0.98], [0.14, 1], [0.9, 1], [1, 0.95]], anchoTecho: 0.86,
    puertas: [0.29, 0.58, 0.77], manijas: [0.53, 0.73],
    barras: true,
  },
  pickup: {
    nombre: 'Pickup', largo: 5.3, ancho: 1.85, ejes: [0.16, 0.74], radio: 0.37,
    colores: [0xefeeea, 0x8b9096, 0x22262b, 0x7d1c1c, 0x2d3e55],
    bajo: [[0, 0.46], [0.07, 0.34], [0.94, 0.34], [1, 0.48]],
    cintura: [[0, 0.8], [0.05, 0.98], [0.25, 1.06], [0.97, 1.1], [1, 1.04]],
    techo: [[0.25, 1.06], [0.38, 1.78], [0.55, 1.79], [0.585, 1.1]],
    parabrisas: [0.25, 0.38], vidrioTrasero: [0.55, 0.585], pilares: [0.47],
    anchoBajo: [[0, 0.9], [0.06, 0.98], [0.13, 1], [0.95, 1], [1, 0.98]], anchoTecho: 0.88,
    puertas: [0.26, 0.47, 0.585], manijas: [0.42, 0.55],
    platon: [0.6, 0.97],
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Carrocería y vidrios.
// ---------------------------------------------------------------------------------------------------------------
function carroceria(T) {
  const L = T.largo, W = T.ancho / 2, z0 = -L * (T.ejes[0] + T.ejes[1]) / 2;
  const bajo = curva(T.bajo), cintura = curva(T.cintura), techoK = curva(T.techo), anchoB = curva(T.anchoBajo);
  const [tc0, tc1] = [T.techo[0][0], T.techo.at(-1)[0]];
  const techo = (t) => (t > tc0 && t < tc1 ? Math.max(cintura(t), techoK(t)) : cintura(t));
  // Pasos de rueda: el piso sube en arco sobre cada eje.
  const piso = (t) => {
    let y = bajo(t);
    for (const e of T.ejes) {
      const d = Math.abs(t - e) * L, r = T.radio + 0.07;
      if (d < r) y = Math.max(y, 0.12 + Math.sqrt(r * r - d * d) + T.radio * 0.35);
    }
    return y;
  };
  // Secciones: rejilla pareja, más apretada en la trompa y la cola, más los puntos clave de los perfiles.
  const ts = new Set();
  for (let i = 0; i <= 48; i++) ts.add(i / 48);
  for (const t of [0.008, 0.016, 0.984, 0.992]) ts.add(t);
  for (const lista of [T.cintura, T.techo, T.bajo]) for (const [t] of lista) ts.add(t);
  for (const e of T.ejes) for (let k = -6; k <= 6; k++) ts.add(Math.min(1, Math.max(0, e + (k / 6) * (T.radio + 0.07) / L)));
  const secciones = [...ts].sort((a, b) => a - b);

  // Adaptado de Slop New York (mrdoob, MIT): js/cars.js (bodyHalfProfile).
  // Media sección, del centro del piso al centro del techo: esquina de abajo (estribo al punto más ancho) y de arriba
  // (al filo de la cintura) superelípticas, la ventana lateral hasta el riel del techo y un techo abombado. Donde no
  // hay cabina, el riel baja hasta la cintura y la comba queda como el capó o el baúl abombados.
  const seccion = (t, conArcos) => {
    const w = W * anchoB(t), yb = conArcos ? piso(t) : bajo(t), yc = cintura(t), yt = techo(t);
    const yS = yc - (yc - yb) * 0.35, xB = w * 0.9, xE = w * 0.95;
    const cabina = Math.min(1, Math.max(0, (yt - yc) / 0.12));
    const tope = Math.max(yt, yc + 0.05), comba = 0.05 + 0.02 * cabina, yR = Math.max(yc, tope - comba);
    const xR = xE * 0.97 + (W * T.anchoTecho * Math.min(1, anchoB(t) + 0.05) - xE * 0.97) * cabina;
    const mitad = [[0, yb]];
    for (const a of [0, 1 / 3, 2 / 3, 1]) {
      const th = (a * Math.PI) / 2;
      mitad.push([xB + (w - xB) * Math.sin(th) ** (2 / 2.8), yS - (yS - yb) * Math.cos(th) ** (2 / 2.8)]);
    }
    for (const a of [0.5, 1]) {
      const th = (a * Math.PI) / 2;
      mitad.push([xE + (w - xE) * Math.cos(th) ** (2 / 3.2), yS + (yc - yS) * Math.sin(th) ** (2 / 3.2)]);
    }
    for (const f of [1, 0.62, 0.3, 0]) mitad.push([xR * f, yR + comba * (1 - f * f)]);
    return { mitad, yc, yR };
  };

  const N = 20; // puntos por sección (11 de la mitad, espejados sin repetir los del centro)
  // Se arman dos versiones con la misma malla: con pasos de rueda (la que se ve) y sin ellos (solo para las
  // normales). Así los arcos no dejan franjas oscuras en el costado y el capó.
  // perfil = (cintura, riel del techo) en cada sección: el shader dibuja con eso molduras, manijas y marcos.
  const armar = (conArcos) => {
    const pos = [], perfil = [];
    for (const t of secciones) {
      const { mitad, yc, yR } = seccion(t, conArcos);
      const anillo = [...mitad, ...mitad.slice(1, -1).reverse().map(([x, y]) => [-x, y])];
      for (const [x, y] of anillo) { pos.push(x, y, z0 + t * L); perfil.push(yc, yR); }
    }
    pos.push(0, 0.5, z0, 0, 0.5, z0 + L); // centros de las tapas
    perfil.push(cintura(0), cintura(0), cintura(1), cintura(1));
    return { pos, perfil };
  };
  const real = armar(true), lisa = armar(false);
  const iCuerpo = [], iVidrio = [];
  const enRango = (t, [a, b]) => t >= a && t <= b;
  // Bordes de los vidrios a lo largo del carro (pilares y unión del parabrisas con las ventanas): ahí va el marco.
  const bordes = new Set([T.parabrisas[1], T.vidrioTrasero[0]].map((t) => z0 + t * L));
  let antes = false;
  for (let s = 0; s < secciones.length - 1; s++) {
    const tm = (secciones[s] + secciones[s + 1]) / 2;
    const enCabina = techo(tm) > cintura(tm) + 0.05;
    const enLado = enCabina && tm > T.parabrisas[1] - 0.01 && tm < T.vidrioTrasero[0] + 0.01 && !T.pilares.some((p) => Math.abs(tm - p) < 0.012);
    const enFrente = enCabina && (enRango(tm, T.parabrisas) || enRango(tm, T.vidrioTrasero));
    if ((enLado || enFrente) !== antes) bordes.add(z0 + secciones[s] * L);
    antes = enLado || enFrente;
    for (let k = 0; k < N; k++) {
      const a = s * N + k, b = s * N + ((k + 1) % N), c = a + N, d = b + N;
      // Segmentos 6 y 13 son las ventanas laterales; 7 a 12 el techo (parabrisas y vidrio trasero en sus tramos).
      const lateral = k === 6 || k === 13, superior = k >= 7 && k <= 12;
      const lista = (lateral && enLado) || (superior && enFrente) || (lateral && enFrente) ? iVidrio : iCuerpo;
      lista.push(a, b, c, b, d, c); // normal hacia afuera
    }
  }
  // Tapas de la trompa y la cola.
  const ult = (secciones.length - 1) * N, base = real.pos.length / 3 - 2;
  for (let k = 0; k < N; k++) {
    iCuerpo.push(base, (k + 1) % N, k); // trompa, mira a -z
    iCuerpo.push(base + 1, ult + k, ult + ((k + 1) % N)); // cola, mira a +z
  }
  const atributos = new THREE.BufferGeometry();
  atributos.setAttribute('position', new THREE.Float32BufferAttribute(lisa.pos, 3));
  atributos.setIndex([...iCuerpo, ...iVidrio]);
  atributos.computeVertexNormals();
  atributos.setAttribute('position', new THREE.Float32BufferAttribute(real.pos, 3));
  const perfil = new THREE.Float32BufferAttribute(real.perfil, 2);
  const con = (indices) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', atributos.attributes.position);
    g.setAttribute('normal', atributos.attributes.normal);
    g.setAttribute('perfil', perfil);
    g.setIndex(indices);
    return g.toNonIndexed();
  };
  return {
    cuerpo: con(iCuerpo), vidrio: con(iVidrio), z0, cintura, techo, anchoB, W, L, bordes: [...bordes],
    yFaro: cintura(0.03) - 0.1, yPiloto: cintura(0.97) - 0.12,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Detalles con color por vértice: llantas, espejos, bómperes y placas amarillas.
// ---------------------------------------------------------------------------------------------------------------
const C = (hex) => new THREE.Color(hex);
const NEGRO = C(0x141516), GRIS = C(0x2c2e31), RIN = C(0xa4a7ab), PLACA = C(0xf3c51c), CROMO = C(0xc9ccd0);
function caja(lista, color, x, y, z, sx, sy, sz, rx = 0) {
  const g = new THREE.BoxGeometry(sx, sy, sz).toNonIndexed();
  if (rx) g.rotateX(rx);
  g.translate(x, y, z);
  pintar(g, color);
  lista.push(g);
}
function pintar(g, color) {
  g.deleteAttribute('uv');
  const n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set([color.r, color.g, color.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}
export function geometriaRueda(radio) {
  const llanta = pintar(new THREE.CylinderGeometry(radio, radio, 0.22, 18).rotateZ(Math.PI / 2).toNonIndexed(), NEGRO);
  const rin = pintar(new THREE.CylinderGeometry(radio * 0.6, radio * 0.6, 0.225, 12).rotateZ(Math.PI / 2).toNonIndexed(), RIN);
  return mergeGeometries([llanta, rin]);
}

function detalles(T, k) {
  const partes = [], luces = [];
  const { z0, L, W, cintura, techo, anchoB, yPiloto } = k;
  const zF = z0, zT = z0 + L;
  for (const s of [-1, 1]) {
    // Espejos en la base del parabrisas.
    const tE = T.parabrisas[0] + 0.03, yE = cintura(tE) + 0.12;
    caja(partes, GRIS, s * (W * anchoB(tE) + 0.09), yE, z0 + tE * L, 0.16, 0.12, 0.08);
  }
  // Bómperes y placas amarillas (como las de Colombia) adelante y atrás.
  caja(partes, GRIS, 0, 0.36, zF + 0.05, W * 1.9, 0.2, 0.14);
  caja(partes, GRIS, 0, 0.38, zT - 0.05, W * 1.9, 0.2, 0.14);
  caja(partes, PLACA, 0, 0.42, zF - 0.03, 0.34, 0.12, 0.02);
  caja(partes, PLACA, 0, yPiloto - 0.02, zT + 0.01, 0.34, 0.12, 0.02);
  if (T.taxi) {
    // Letrero en el techo (va con las luces para que se encienda de noche).
    const tM = (T.parabrisas[1] + T.vidrioTrasero[0]) / 2;
    caja(luces, C(0xfaf3d2), 0, techo(tM) + 0.08, z0 + tM * L, 0.72, 0.16, 0.24);
  }
  if (T.barras) for (const s of [-1, 1]) caja(partes, CROMO, s * W * 0.7, techo(0.65) + 0.05, z0 + 0.66 * L, 0.05, 0.05, L * 0.42);
  if (T.platon) {
    // Platón: fondo oscuro un poco por debajo del borde.
    const [a, b] = T.platon, tm = (a + b) / 2;
    caja(partes, GRIS, 0, cintura(tm) + 0.005, z0 + tm * L, W * 1.7, 0.02, (b - a) * L);
  }
  return { partes: mergeGeometries(partes), luces: luces.length ? mergeGeometries(luces) : null };
}

// ---------------------------------------------------------------------------------------------------------------
// Materiales. Los detalles se dibujan con bordes suavizados al tamaño del píxel (sin parpadeo), como en
// Slop New York (mrdoob, MIT): js/cars.js. d < 0 es adentro; w es lo que mide un píxel en esa dirección.
// ---------------------------------------------------------------------------------------------------------------
const adentro = (d, w) => clamp(float(0.5).sub(d.div(w)), 0, 1);
const franja = (d, a, w) => clamp(min(d.add(a), w.mul(0.5)).sub(max(d.sub(a), w.mul(-0.5))).div(w), 0, 1); // |d| < a
const rectangulo = (x, y, ax, ay, r, wx, wy) => {
  const qx = abs(x).sub(ax - r), qy = abs(y).sub(ay - r);
  const d = length(max(vec2(qx, qy), vec2(0))).add(min(max(qx, qy), 0)).sub(r);
  return adentro(d, mix(wy, wx, step(qy, qx)));
};
const NEGRO_MATE = vec3(0.035, 0.037, 0.04);

// Reflejo del cielo: el mapa de entorno de la escena va muy bajito (0,2) y la pintura y los vidrios se verían mates.
// Se mira hacia dónde rebota la vista: arriba el cielo (claro de día, azul oscuro de noche), abajo la calle.
const vista = normalize(cameraPosition.sub(positionWorld));
const rebote = reflect(vista.negate(), normalWorld);
const fresnel = pow(float(1).sub(clamp(dot(normalWorld, vista), 0, 1)), 5);
const cieloArriba = mix(mix(vec3(0.8, 0.85, 0.9), vec3(0.4, 0.55, 0.8), smoothstep(0, 0.5, rebote.y)), vec3(0.03, 0.045, 0.08), noche);
const reflejo = mix(vec3(0.05).mul(float(1).sub(noche.mul(0.8))), cieloArriba, smoothstep(-0.08, 0.04, rebote.y));

// Pintura con laca, faros, pilotos, parrilla, molduras, puertas y manijas. Los estacionados (instancias) traen su
// color en el atributo `pintura` y no prenden luces; el carro suelto usa material.color y material.faros (0 a 1).
function materialPintura(T, k, instancias) {
  const p = positionGeometry, n = normalGeometry, perfil = attribute('perfil', 'vec2');
  const fw = max(fwidth(p), vec3(0.0005));
  const pintura = instancias ? attribute('pintura', 'vec3') : materialColor;
  const faros = instancias ? float(0) : materialReference('faros', 'float');
  const W = k.W, zt = (t) => k.z0 + t * k.L, uno = float(1);
  const ax = abs(p.x), lado = smoothstep(0.45, 0.7, abs(n.x)), cintura = perfil.x, riel = perfil.y;

  // Puertas: costuras finas y manijas en los costados, entre el estribo y la moldura de la ventana.
  const enPuertas = lado.mul(adentro(p.y.sub(cintura).add(0.03), fw.y)).mul(adentro(float(T.bajo[1][1] + 0.1).sub(p.y), fw.y));
  let costura = float(0), dManija = float(9);
  for (const t of T.puertas) costura = max(costura, franja(p.z.sub(zt(t)), 0.004, fw.z));
  for (const t of T.manijas) dManija = min(dManija, abs(p.z.sub(zt(t))));
  const manija = rectangulo(dManija, p.y.sub(cintura).add(0.09), 0.065, 0.012, 0.008, fw.z, fw.y).mul(enPuertas);
  const nicho = rectangulo(dManija, p.y.sub(cintura).add(0.096), 0.04, 0.022, 0.015, fw.z, fw.y).mul(enPuertas);
  // Moldura de caucho bajo las ventanas y pilares en negro: así los vidrios se leen enmarcados.
  const cabina = adentro(float(zt(T.parabrisas[0])).sub(p.z), fw.z).mul(adentro(p.z.sub(zt(T.vidrioTrasero[1])), fw.z));
  const moldura = lado.mul(franja(p.y.sub(cintura).add(0.012), 0.012, fw.y)).mul(cabina);
  const pilar = lado.mul(adentro(cintura.add(0.005).sub(p.y), fw.y)).mul(adentro(p.y.sub(riel).sub(0.01), fw.y));
  // Faros (con el bombillo hacia afuera), parrilla con listones y pilotos, solo en las caras de adelante y atrás.
  const frente = adentro(p.z.sub(k.z0 + 0.3), fw.z).mul(smoothstep(0.1, 0.35, n.z.negate()));
  const cola = adentro(float(k.z0 + k.L - 0.3).sub(p.z), fw.z).mul(smoothstep(0.1, 0.35, n.z));
  const fx = W * 0.62, fa = W * 0.21;
  const faro = rectangulo(ax.sub(fx), p.y.sub(k.yFaro), fa, 0.065, 0.03, fw.x, fw.y).mul(frente);
  const bombillo = rectangulo(ax.sub(fx + fa * 0.4), p.y.sub(k.yFaro), fa * 0.42, 0.04, 0.03, fw.x, fw.y).mul(frente);
  const parrilla = rectangulo(p.x, p.y.sub(k.yFaro - 0.03), W * 0.34, 0.06, 0.02, fw.x, fw.y).mul(frente);
  const listones = pulso(p.y.div(0.025), 0, 0.45, fw.y.div(0.025));
  const piloto = rectangulo(ax.sub(W * 0.72), p.y.sub(k.yPiloto), W * 0.17, 0.06, 0.02, fw.x, fw.y).mul(cola);
  const mate = max(max(moldura, pilar), parrilla);

  const ao = smoothstep(0.15, 0.6, p.y).mul(0.25).add(0.75);
  let c = pintura.mul(ao).mul(uno.sub(costura.mul(enPuertas).mul(0.6))).mul(uno.sub(nicho.mul(0.5)));
  c = mix(c, pintura.mul(0.6).add(0.25), manija);
  if (T.taxi) {
    // Franja de dos filas de cuadros blancos y negros a los lados, como los taxis de Bogotá.
    const enFranja = lado.mul(franja(p.y.sub(cintura).add(0.175), 0.035, fw.y))
      .mul(adentro(float(zt(0.28)).sub(p.z), fw.z)).mul(adentro(p.z.sub(zt(0.84)), fw.z));
    const a = pulso(p.z.div(0.035), 0, 0.5, fw.z.div(0.035)), b = pulso(p.y.sub(cintura).div(0.035), 0, 0.5, fw.y.div(0.035));
    c = mix(c, mix(vec3(0.02), vec3(0.85), a.mul(b).add(uno.sub(a).mul(uno.sub(b)))), enFranja);
  }
  c = mix(c, NEGRO_MATE, mate);
  c = mix(c, vec3(0.12), parrilla.mul(listones));
  c = mix(c, vec3(0.7, 0.72, 0.75), faro);
  c = mix(c, vec3(0.92), bombillo);
  c = mix(c, vec3(0.4, 0.02, 0.02), piloto);

  const m = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.3, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.06 });
  if (!instancias) m.faros = 0;
  m.colorNode = c;
  m.roughnessNode = mix(float(0.3), float(0.6), mate);
  m.clearcoatNode = uno.sub(mate);
  // De noche, con el carro andando, faros y pilotos pasan de 1 para que brillen con el bloom.
  const luzFaro = vec3(1, 0.96, 0.88).mul(faro.mul(faros.mul(1.6).add(0.05)).add(bombillo.mul(faros.mul(2.6))));
  const luzPiloto = vec3(1, 0.05, 0.04).mul(piloto.mul(faros.mul(2.6).add(0.03)));
  m.emissiveNode = reflejo.mul(fresnel.mul(0.45).add(0.03)).mul(uno.sub(mate)).add(luzFaro).add(luzPiloto);
  return m;
}

// Vidrio oscuro que refleja el cielo, con marco de caucho sobre la cintura, bajo el techo y en los pilares.
function materialVidrio(k) {
  const p = positionGeometry, n = normalGeometry, perfil = attribute('perfil', 'vec2');
  const fw = max(fwidth(p), vec3(0.0005));
  const lado = smoothstep(0.35, 0.6, abs(n.x));
  let dz = float(9);
  for (const z of k.bordes) dz = min(dz, abs(p.z.sub(z)));
  const marco = max(max(franja(p.y.sub(perfil.x), 0.025, fw.y), franja(perfil.y.sub(p.y), 0.025, fw.y)).mul(lado), franja(dz, 0.03, fw.z));
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.05, metalness: 0 });
  m.colorNode = mix(vec3(0.02, 0.025, 0.03), vec3(0.012), marco);
  m.roughnessNode = mix(float(0.05), float(0.6), marco);
  m.emissiveNode = reflejo.mul(fresnel.mul(0.75).add(0.1)).mul(float(1).sub(marco.mul(0.9)));
  return m;
}

const MAT = {
  partes: new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.6 }),
  luces: new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.3 }),
  sombra: new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
};
MAT.luces.emissiveNode = vertexColor().mul(float(0.15).add(noche.mul(2.2)));
{
  // Adaptado de Slop New York (mrdoob, MIT): js/tsl-materials.js (createContactShadowMaterial).
  // Sombra de contacto: rectángulo redondeado que se desvanece hacia afuera, más oscuro bajo las cuatro llantas.
  const q = abs(uv().sub(0.5).mul(2)), r = q.sub(vec2(0.64, 0.7));
  const d = length(max(r, vec2(0))).add(min(max(r.x, r.y), 0));
  const chasis = float(1).sub(smoothstep(-0.14, 0.3, d));
  const nucleo = float(1).sub(smoothstep(0.12, 0.76, q.x)).mul(float(1).sub(smoothstep(0.16, 0.82, q.y)));
  const llantas = float(1).sub(smoothstep(0, 0.22, length(q.sub(vec2(0.64, 0.56)).mul(vec2(1.4, 1)))));
  MAT.sombra.colorNode = vec3(0.01, 0.012, 0.015);
  MAT.sombra.opacityNode = clamp(chasis.mul(0.72).add(nucleo.mul(0.18)).add(llantas.mul(0.18)), 0, 0.88);
}

const cache = new Map();
export function geometrias(tipo) {
  if (!cache.has(tipo)) {
    const T = TIPOS[tipo], k = carroceria(T), d = detalles(T, k);
    const W = T.ancho / 2, z0 = k.z0;
    const ruedas = T.ejes.flatMap((e) => [-1, 1].map((s) => new THREE.Vector3(s * (W - 0.13), T.radio, z0 + e * T.largo)));
    const sombra = new THREE.PlaneGeometry(T.ancho + 0.5, T.largo + 0.6).rotateX(-Math.PI / 2).translate(0, 0.03, z0 + T.largo / 2);
    const mat = { pintura: materialPintura(T, k, true), suelta: materialPintura(T, k, false), vidrio: materialVidrio(k) };
    cache.set(tipo, { T, cuerpo: k.cuerpo, vidrio: k.vidrio, partes: d.partes, luces: d.luces, ruedas, rueda: geometriaRueda(T.radio), sombra, mat });
  }
  return cache.get(tipo);
}

// Un carro suelto (el que maneja el jugador): ruedas aparte para girarlas y luz de faros.
export function crearVehiculo(tipo, color) {
  const G = geometrias(tipo);
  const raiz = new THREE.Group();
  raiz.name = `Vehiculo-${tipo}`;
  const cuerpo = new THREE.Group();
  raiz.add(cuerpo);
  const luz = new THREE.SpotLight(0xfff1d0, 0, 60, 0.5, 0.6, 1.2);
  luz.position.set(0, 0.8, G.T.largo * -0.5);
  luz.target.position.set(0, -0.6, -14);
  raiz.add(luz, luz.target);
  const pintura = G.mat.suelta.clone();
  pintura.color.set(color);
  // Faros y pilotos se prenden con la luz que jugador.js enciende de noche mientras se maneja.
  Object.defineProperty(pintura, 'faros', { get: () => Math.min(1, luz.intensity / 30) });
  for (const [g, m] of [[G.cuerpo, pintura], [G.vidrio, G.mat.vidrio], [G.partes, MAT.partes], [G.luces, MAT.luces]]) {
    if (!g) continue;
    const malla = new THREE.Mesh(g, m);
    malla.castShadow = malla.receiveShadow = true;
    cuerpo.add(malla);
  }
  raiz.add(new THREE.Mesh(G.sombra, MAT.sombra));
  const ruedas = G.ruedas.map((p) => {
    const eje = new THREE.Group();
    eje.position.copy(p);
    raiz.add(eje);
    const rueda = new THREE.Mesh(G.rueda, MAT.partes);
    rueda.castShadow = true;
    eje.add(rueda);
    return { eje, rueda, delantera: p.z < 0 };
  });
  return { raiz, carroceria: cuerpo, ruedas, luz, tipo, color, radio: G.T.radio, largo: G.T.largo, ancho: G.T.ancho };
}

// ---------------------------------------------------------------------------------------------------------------
// Carros estacionados a lado y lado de las calles, dibujados con instancias (pocas llamadas a la GPU).
// ---------------------------------------------------------------------------------------------------------------
export function estacionar({ vias, terreno, choques, centro, radio = 1300, maximo = 520, semilla = 7 }) {
  let s = semilla;
  const azar = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const tipos = Object.keys(TIPOS);
  const peso = { taxi: 0.22, sedan: 0.38, camioneta: 0.28, pickup: 0.12 };
  const lista = [];
  const prueba = { x: 0, z: 0 };
  for (const via of vias) {
    const { clase, p } = via;
    if (clase < 2 || clase > 3 || via.bus) continue;
    for (let i = 0; i < p.length - 1 && lista.length < maximo * 3; i++) {
      const [ax, az] = p[i], [bx, bz] = p[i + 1], dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz);
      if (l < 30 || Math.hypot(ax - centro[0], az - centro[1]) > radio) continue;
      const ux = dx / l, uz = dz / l, nx = -uz, nz = ux;
      for (let d = 16; d < l - 16; d += 6.5 + azar() * 5) {
        if (azar() > 0.42) continue;
        const lado = azar() < 0.5 ? 1 : -1, off = anchoVia(via) / 2 - 1.05;
        const x = ax + ux * d + nx * off * lado, z = az + uz * d + nz * off * lado;
        // Si choca con un muro o un árbol, no cabe.
        prueba.x = x; prueba.z = z;
        if (choques.empujar(prueba, 2.4)) continue;
        let r = azar(), tipo = tipos[0];
        for (const t of tipos) { if ((r -= peso[t]) <= 0) { tipo = t; break; } }
        const cols = TIPOS[tipo].colores;
        const rumbo = Math.atan2(-ux, -uz) + (lado > 0 ? 0 : Math.PI); // de frente al tráfico de su lado
        lista.push({ tipo, color: cols[Math.floor(azar() * cols.length)], x, z, rumbo, orden: azar() });
      }
    }
  }
  // Se queda con `maximo` repartidos por toda la zona.
  lista.sort((a, b) => a.orden - b.orden);
  lista.length = Math.min(lista.length, maximo);

  const grupo = new THREE.Group();
  grupo.name = 'CarrosEstacionados';
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), uno = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
  const c = new THREE.Color();
  const mallas = {};
  for (const tipo of tipos) {
    const delTipo = lista.filter((v) => v.tipo === tipo);
    if (!delTipo.length) continue;
    const G = geometrias(tipo);
    const ruedas = mergeGeometries(G.ruedas.map((r) => G.rueda.clone().translate(r.x, r.y, r.z)));
    const partes = mergeGeometries([G.partes, ruedas]);
    // El color de cada carro va en un atributo por instancia que lee el shader de la pintura.
    const cuerpo = G.cuerpo.clone(), pintura = new THREE.InstancedBufferAttribute(new Float32Array(delTipo.length * 3), 3);
    cuerpo.setAttribute('pintura', pintura);
    const instancias = [[cuerpo, G.mat.pintura], [G.vidrio, G.mat.vidrio], [partes, MAT.partes], [G.luces, MAT.luces], [G.sombra, MAT.sombra]]
      .filter(([g]) => g)
      .map(([g, m]) => {
        const im = new THREE.InstancedMesh(g, m, delTipo.length);
        im.castShadow = im.receiveShadow = m !== MAT.sombra;
        grupo.add(im);
        return im;
      });
    delTipo.forEach((v, i) => {
      const L = G.T.largo, yA = terreno.altura(v.x - Math.sin(v.rumbo) * L * 0.3, v.z - Math.cos(v.rumbo) * L * 0.3);
      const yB = terreno.altura(v.x + Math.sin(v.rumbo) * L * 0.3, v.z + Math.cos(v.rumbo) * L * 0.3);
      q.setFromEuler(e.set(Math.atan2(yA - yB, L * 0.6), v.rumbo, 0, 'YXZ'));
      m4.compose(p.set(v.x, (yA + yB) / 2, v.z), q, uno);
      for (const im of instancias) im.setMatrixAt(i, m4);
      c.set(v.color);
      pintura.setXYZ(i, c.r, c.g, c.b);
      v.indice = i;
      // Dos círculos cubren la carrocería para los choques.
      v.circulos = [-1, 1].map((k) => [v.x - Math.sin(v.rumbo) * k * L * 0.27, v.z - Math.cos(v.rumbo) * k * L * 0.27, G.T.ancho * 0.52]);
      for (const circ of v.circulos) choques.agregar(circ);
    });
    for (const im of instancias) im.computeBoundingSphere();
    mallas[tipo] = instancias;
  }
  // Ocultar uno (cuando el jugador se lo lleva) o volver a mostrarlo.
  const cero = new THREE.Matrix4().makeScale(0, 0, 0);
  const ocultar = (v) => {
    for (const im of mallas[v.tipo]) { im.setMatrixAt(v.indice, cero); im.instanceMatrix.needsUpdate = true; }
    for (const circ of v.circulos) circ[2] = -10; // ya no estorba
    v.oculto = true;
  };
  return { grupo, lista, ocultar };
}
