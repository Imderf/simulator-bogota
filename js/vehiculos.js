import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { vertexColor, float } from 'three/tsl';
import { noche } from './edificios.js';

// Carros armados en código: la carrocería se arma con secciones a lo largo del carro (como costillas) a partir de
// perfiles de altura y ancho, y se le pegan detalles simples. Solo el exterior: los vidrios son oscuros y no hay
// interior. Cada carro mira hacia -z y su centro está entre los dos ejes, a ras del suelo.

// Interpola una lista de pares [t, valor] con curva suave entre puntos.
const curva = (puntos) => (t) => {
  if (t <= puntos[0][0]) return puntos[0][1];
  for (let i = 1; i < puntos.length; i++) {
    const [t1, v1] = puntos[i];
    if (t <= t1) {
      const [t0, v0] = puntos[i - 1], k = (t - t0) / (t1 - t0 || 1), s = k * k * (3 - 2 * k);
      return v0 + (v1 - v0) * s;
    }
  }
  return puntos.at(-1)[1];
};

// t va de 0 (trompa) a 1 (cola). Alturas en metros; anchos como fracción del medio ancho.
export const TIPOS = {
  taxi: {
    nombre: 'Taxi', largo: 3.6, ancho: 1.6, ejes: [0.17, 0.83], radio: 0.29, colores: [0xf2bf16],
    bajo: [[0, 0.34], [0.08, 0.2], [0.92, 0.2], [1, 0.36]],
    cintura: [[0, 0.62], [0.06, 0.8], [0.24, 0.9], [0.7, 0.94], [0.94, 0.96], [1, 0.86]],
    techo: [[0.22, 0.9], [0.4, 1.47], [0.86, 1.48], [0.97, 1.0]],
    parabrisas: [0.22, 0.4], vidrioTrasero: [0.86, 0.97], pilares: [0.6],
    anchoBajo: [[0, 0.88], [0.07, 0.98], [0.15, 1], [0.9, 1], [1, 0.93]], anchoTecho: 0.84,
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
  },
  camioneta: {
    nombre: 'Camioneta', largo: 4.5, ancho: 1.82, ejes: [0.18, 0.8], radio: 0.35,
    colores: [0x9aa3ab, 0x1c1d20, 0xf0efeb, 0x3d4a3f, 0x6b1f24, 0x47505a],
    bajo: [[0, 0.42], [0.08, 0.3], [0.92, 0.3], [1, 0.44]],
    cintura: [[0, 0.76], [0.05, 0.92], [0.27, 1.02], [0.8, 1.08], [0.97, 1.08], [1, 0.96]],
    techo: [[0.27, 1.02], [0.42, 1.62], [0.9, 1.63], [0.985, 1.12]],
    parabrisas: [0.27, 0.42], vidrioTrasero: [0.9, 0.985], pilares: [0.58, 0.79],
    anchoBajo: [[0, 0.9], [0.06, 0.98], [0.14, 1], [0.9, 1], [1, 0.95]], anchoTecho: 0.86,
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
  // Secciones: rejilla pareja más los puntos clave de los perfiles.
  const ts = new Set();
  for (let i = 0; i <= 40; i++) ts.add(i / 40);
  for (const lista of [T.cintura, T.techo, T.bajo]) for (const [t] of lista) ts.add(t);
  for (const e of T.ejes) for (let k = -6; k <= 6; k++) ts.add(Math.min(1, Math.max(0, e + (k / 6) * (T.radio + 0.07) / L)));
  const secciones = [...ts].sort((a, b) => a - b);

  const N = 14; // puntos por sección (ver mitad abajo, espejada)
  // Se arman dos versiones con la misma malla: con pasos de rueda (la que se ve) y sin ellos (solo para las
  // normales). Así los arcos no dejan franjas oscuras en el costado y el capó.
  const armar = (conArcos) => {
  const pos = [];
  for (const t of secciones) {
    const w = W * anchoB(t), yb = conArcos ? piso(t) : bajo(t), yc = cintura(t), yt = techo(t), wt = W * T.anchoTecho * Math.min(1, anchoB(t) + 0.05);
    const conCabina = yt > yc + 0.02;
    const mitad = [
      [0, yb], [w * 0.92, yb], [w, Math.min(yb + 0.12, yc - 0.1)], [w, yc - 0.06], [w * 0.96, yc],
      [conCabina ? wt : w * 0.92, conCabina ? yt - 0.07 : yc + 0.005], [conCabina ? wt * 0.86 : w * 0.8, yt], [0, yt],
    ];
    const anillo = [...mitad, ...mitad.slice(1, -1).reverse().map(([x, y]) => [-x, y])];
    for (const [x, y] of anillo) pos.push(x, y, z0 + t * L);
  }
  pos.push(0, 0.5, z0, 0, 0.5, z0 + L); // centros de las tapas
  return pos;
  };
  const pos = armar(true), posLisa = armar(false);
  const iCuerpo = [], iVidrio = [];
  const enRango = (t, [a, b]) => t >= a && t <= b;
  for (let s = 0; s < secciones.length - 1; s++) {
    const tm = (secciones[s] + secciones[s + 1]) / 2;
    const enCabina = techo(tm) > cintura(tm) + 0.05;
    const enLado = enCabina && tm > T.parabrisas[1] - 0.01 && tm < T.vidrioTrasero[0] + 0.01 && !T.pilares.some((p) => Math.abs(tm - p) < 0.012);
    const enFrente = enCabina && (enRango(tm, T.parabrisas) || enRango(tm, T.vidrioTrasero));
    for (let k = 0; k < N; k++) {
      const a = s * N + k, b = s * N + ((k + 1) % N), c = a + N, d = b + N;
      // Segmentos 4-5 y 9-10 son las ventanas laterales; 5-9 el techo (parabrisas y vidrio trasero en sus tramos).
      const lateral = k === 4 || k === 9, superior = k >= 5 && k <= 8;
      const lista = (lateral && enLado) || (superior && enFrente) || (lateral && enFrente) ? iVidrio : iCuerpo;
      lista.push(a, b, c, b, d, c); // normal hacia afuera
    }
  }
  // Tapas de la trompa y la cola.
  const ult = (secciones.length - 1) * N, base = pos.length / 3 - 2;
  for (let k = 0; k < N; k++) {
    iCuerpo.push(base, (k + 1) % N, k); // trompa, mira a -z
    iCuerpo.push(base + 1, ult + k, ult + ((k + 1) % N)); // cola, mira a +z
  }
  const atributos = new THREE.BufferGeometry();
  atributos.setAttribute('position', new THREE.Float32BufferAttribute(posLisa, 3));
  atributos.setIndex([...iCuerpo, ...iVidrio]);
  atributos.computeVertexNormals();
  atributos.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const con = (indices) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', atributos.attributes.position);
    g.setAttribute('normal', atributos.attributes.normal);
    g.setIndex(indices);
    return g.toNonIndexed();
  };
  return { cuerpo: con(iCuerpo), vidrio: con(iVidrio), z0, cintura, techo, anchoB, W, L };
}

// ---------------------------------------------------------------------------------------------------------------
// Detalles con color por vértice: llantas, farolas, parrilla, espejos, bómperes y placas amarillas.
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
  const { z0, L, W, cintura, techo, anchoB } = k;
  const zF = z0, zT = z0 + L;
  const yFaro = cintura(0.03) - 0.1, yPiloto = cintura(0.97) - 0.12;
  for (const s of [-1, 1]) {
    // Farolas y pilotos (van aparte para que se enciendan de noche).
    caja(luces, C(0xfff4d8), s * W * 0.62, yFaro, zF + 0.06, W * 0.42, 0.13, 0.12);
    caja(luces, C(0xd01818), s * W * 0.72, yPiloto, zT - 0.04, W * 0.34, 0.12, 0.1);
    // Espejos en la base del parabrisas.
    const tE = T.parabrisas[0] + 0.03, yE = cintura(tE) + 0.12;
    caja(partes, GRIS, s * (W * anchoB(tE) + 0.09), yE, z0 + tE * L, 0.16, 0.12, 0.08);
  }
  // Parrilla, bómperes y placas amarillas (como las de Colombia) adelante y atrás.
  caja(partes, NEGRO, 0, yFaro - 0.02, zF + 0.03, W * 0.7, 0.14, 0.06);
  caja(partes, GRIS, 0, 0.36, zF + 0.05, W * 1.9, 0.2, 0.14);
  caja(partes, GRIS, 0, 0.38, zT - 0.05, W * 1.9, 0.2, 0.14);
  caja(partes, PLACA, 0, 0.42, zF - 0.03, 0.34, 0.12, 0.02);
  caja(partes, PLACA, 0, yPiloto - 0.02, zT + 0.01, 0.34, 0.12, 0.02);
  if (T.taxi) {
    // Letrero en el techo y franja de cuadros a los lados.
    const tM = (T.parabrisas[1] + T.vidrioTrasero[0]) / 2;
    caja(luces, C(0xfaf3d2), 0, techo(tM) + 0.08, z0 + tM * L, 0.72, 0.16, 0.24);
    for (const s of [-1, 1]) for (let i = 0; i < 12; i++) {
      const t = 0.3 + i * 0.04;
      caja(partes, i % 2 ? NEGRO : C(0xf6f3ea), s * (W * anchoB(t) + 0.005), cintura(t) - 0.16, z0 + t * L, 0.02, 0.07, L * 0.04);
    }
  }
  if (T.barras) for (const s of [-1, 1]) caja(partes, CROMO, s * W * 0.7, techo(0.65) + 0.05, z0 + 0.66 * L, 0.05, 0.05, L * 0.42);
  if (T.platon) {
    // Platón: fondo oscuro un poco por debajo del borde.
    const [a, b] = T.platon, tm = (a + b) / 2;
    caja(partes, GRIS, 0, cintura(tm) + 0.005, z0 + tm * L, W * 1.7, 0.02, (b - a) * L);
  }
  return { partes: mergeGeometries(partes), luces: mergeGeometries(luces) };
}

// ---------------------------------------------------------------------------------------------------------------
// Materiales compartidos por todos los carros.
// ---------------------------------------------------------------------------------------------------------------
const MAT = {
  pintura: new THREE.MeshPhysicalNodeMaterial({ roughness: 0.32, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.08 }),
  vidrio: new THREE.MeshStandardNodeMaterial({ color: 0x161c22, roughness: 0.06, metalness: 0.3 }),
  partes: new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.6 }),
  luces: new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.3 }),
};
MAT.luces.emissiveNode = vertexColor().mul(float(0.15).add(noche.mul(2.2)));

const cache = new Map();
export function geometrias(tipo) {
  if (!cache.has(tipo)) {
    const T = TIPOS[tipo], k = carroceria(T), d = detalles(T, k);
    const W = T.ancho / 2, z0 = k.z0;
    const ruedas = T.ejes.flatMap((e) => [-1, 1].map((s) => new THREE.Vector3(s * (W - 0.13), T.radio, z0 + e * T.largo)));
    cache.set(tipo, { T, cuerpo: k.cuerpo, vidrio: k.vidrio, partes: d.partes, luces: d.luces, ruedas, rueda: geometriaRueda(T.radio) });
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
  const pintura = MAT.pintura.clone();
  pintura.color.set(color);
  for (const [g, m] of [[G.cuerpo, pintura], [G.vidrio, MAT.vidrio], [G.partes, MAT.partes], [G.luces, MAT.luces]]) {
    const malla = new THREE.Mesh(g, m);
    malla.castShadow = malla.receiveShadow = true;
    cuerpo.add(malla);
  }
  const ruedas = G.ruedas.map((p) => {
    const eje = new THREE.Group();
    eje.position.copy(p);
    raiz.add(eje);
    const rueda = new THREE.Mesh(G.rueda, MAT.partes);
    rueda.castShadow = true;
    eje.add(rueda);
    return { eje, rueda, delantera: p.z < 0 };
  });
  const luz = new THREE.SpotLight(0xfff1d0, 0, 60, 0.5, 0.6, 1.2);
  luz.position.set(0, 0.8, G.T.largo * -0.5);
  luz.target.position.set(0, -0.6, -14);
  raiz.add(luz, luz.target);
  return { raiz, carroceria: cuerpo, ruedas, luz, tipo, color, radio: G.T.radio, largo: G.T.largo, ancho: G.T.ancho };
}

// ---------------------------------------------------------------------------------------------------------------
// Carros estacionados a lado y lado de las calles, dibujados con instancias (pocas llamadas a la GPU).
// ---------------------------------------------------------------------------------------------------------------
const ANCHO_VIA = [18, 13, 9, 7, 4.5];
export function estacionar({ vias, terreno, choques, centro, radio = 1300, maximo = 520, semilla = 7 }) {
  let s = semilla;
  const azar = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const tipos = Object.keys(TIPOS);
  const peso = { taxi: 0.22, sedan: 0.38, camioneta: 0.28, pickup: 0.12 };
  const lista = [];
  const prueba = { x: 0, z: 0 };
  for (const { clase, p } of vias) {
    if (clase < 2 || clase > 3) continue;
    for (let i = 0; i < p.length - 1 && lista.length < maximo * 3; i++) {
      const [ax, az] = p[i], [bx, bz] = p[i + 1], dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz);
      if (l < 30 || Math.hypot(ax - centro[0], az - centro[1]) > radio) continue;
      const ux = dx / l, uz = dz / l, nx = -uz, nz = ux;
      for (let d = 12; d < l - 12; d += 6.5 + azar() * 5) {
        if (azar() > 0.42) continue;
        const lado = azar() < 0.5 ? 1 : -1, off = ANCHO_VIA[clase] / 2 - 1.05;
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
    const instancias = [[G.cuerpo, MAT.pintura], [G.vidrio, MAT.vidrio], [partes, MAT.partes], [G.luces, MAT.luces]]
      .map(([g, m]) => { const im = new THREE.InstancedMesh(g, m, delTipo.length); im.castShadow = im.receiveShadow = true; grupo.add(im); return im; });
    delTipo.forEach((v, i) => {
      const L = G.T.largo, yA = terreno.altura(v.x - Math.sin(v.rumbo) * L * 0.3, v.z - Math.cos(v.rumbo) * L * 0.3);
      const yB = terreno.altura(v.x + Math.sin(v.rumbo) * L * 0.3, v.z + Math.cos(v.rumbo) * L * 0.3);
      q.setFromEuler(e.set(Math.atan2(yA - yB, L * 0.6), v.rumbo, 0, 'YXZ'));
      m4.compose(p.set(v.x, (yA + yB) / 2, v.z), q, uno);
      for (const im of instancias) im.setMatrixAt(i, m4);
      instancias[0].setColorAt(i, c.set(v.color));
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
