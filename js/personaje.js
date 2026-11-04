import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  Fn, If, attribute, positionGeometry, normalGeometry, color, float, vec2, vec3,
  abs, sign, sin, fract, step, smoothstep, mix, normalize,
} from 'three/tsl';

// Personaje de cuerpo suave: cada pieza es una superficie que une anillos superelípticos (torso, piernas, brazos,
// cabeza, pelo, tenis) y cuelga de un pivote en su articulación, así se anima con rotaciones. Para un solo personaje
// no hace falta skinning: las piezas se traslapan en codos y rodillas.
// Adaptado de Slop New York (mrdoob, MIT): pedestrians.js. Allá el personaje mira a +z; aquí todo va girado media
// vuelta para mirar a -z (la izquierda queda en -x). El origen está en los pies.

// Medidas en metros de una persona de 1,75 m; el grupo `cuerpo` la escala a 1,72.
const ESCALA = 0.98;
const MUSLO = 0.42, CANILLA = 0.42, TOBILLO = 0.08;
const BRAZO = 0.3, ANTEBRAZO_MANO = 0.32; // del codo al centro de la palma
const PELVIS = new THREE.Vector3(0, 0.96, 0);
const CUELLO = new THREE.Vector3(0, 1.52, 0.012);
const LADOS = [-1, 1]; // izquierda, derecha
const hombroDe = (s) => new THREE.Vector3(s * 0.185, 1.43, 0.015);
const caderaDe = (s) => new THREE.Vector3(s * 0.09, TOBILLO + CANILLA + MUSLO, 0);
const PARTE = { torso: 0, pierna: 1, zapato: 2, manga: 3, mano: 4, cabeza: 5, pelo: 6 };
const COLORES = { piel: 0xb07a52, pelo: 0x1b1512, chaqueta: 0x3b4352, pantalon: 0x2f4361, zapatos: 0x34363b };

// Bicicleta: la arma otro módulo con estas medidas, en el marco de la raíz del personaje.
const SILLIN = new THREE.Vector3(0, 0.98, 0.18);
const EJE_BIELAS = new THREE.Vector3(0, 0.32, 0);
const BIELA = 0.17, PEDAL_X = 0.1;
const MANUBRIO = new THREE.Vector3(0.27, 1.08, -0.42); // puño derecho; el izquierdo en -x
const BOLA = new THREE.Vector3(0, -0.088, -0.115); // lo que pisa el pedal (bajo la bola del pie), desde el tobillo

// ---------------------------------------------------------------------------------------------------------------
// Anillos y superficies.
// ---------------------------------------------------------------------------------------------------------------
// Anillo superelíptico horizontal: rx de lado, rzD hacia el frente (-z) y rzA hacia atrás. a = π/2 es el frente;
// `bulto(a)` empuja puntos hacia afuera (nariz, orejas).
function anillo(y, rx, rzD, rzA, cz, n, ex = 2, bulto = null, cx = 0) {
  const e = 2 / ex, puntos = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    let x = -Math.sign(c) * Math.abs(c) ** e * rx;
    let z = -Math.sign(s) * Math.abs(s) ** e * (s >= 0 ? rzD : rzA);
    const b = bulto ? bulto(a) : 0;
    if (b) { const r = Math.hypot(x, z) || 1; x += (x / r) * b; z += (z / r) * b; }
    puntos.push(new THREE.Vector3(cx + x, y, cz + z));
  }
  return puntos;
}

// Bulto gaussiano alrededor del ángulo a0.
function lobulo(a, a0, ancho) {
  let d = a - a0;
  d -= Math.round(d / (Math.PI * 2)) * Math.PI * 2;
  return Math.exp(-(d * d) / (ancho * ancho));
}

const _costura = new THREE.Vector3();
// Superficie cerrada por anillos del mismo número de puntos, con tapas opcionales en abanico desde el centro.
function superficie(anillos, parte, tapaInicio = false, tapaFin = false) {
  const filas = anillos.length, n = anillos[0].length, por = n + 1;
  const pos = [], idx = [];
  for (const a of anillos) for (let j = 0; j <= n; j++) { const p = a[j % n]; pos.push(p.x, p.y, p.z); }
  for (let i = 0; i < filas - 1; i++) {
    for (let j = 0; j < n; j++) {
      const a = i * por + j, b = a + 1, c = a + por + 1, d = a + por;
      idx.push(a, b, d, b, c, d);
    }
  }
  const tapa = (fila, invertir) => {
    const ini = pos.length / 3, centro = new THREE.Vector3();
    for (const p of anillos[fila]) { centro.add(p); pos.push(p.x, p.y, p.z); }
    centro.divideScalar(n);
    pos.push(centro.x, centro.y, centro.z);
    for (let j = 0; j < n; j++) {
      const a = ini + j, b = ini + ((j + 1) % n), c = ini + n;
      if (invertir) idx.push(c, b, a); else idx.push(c, a, b);
    }
  };
  if (tapaInicio) tapa(0, true);
  if (tapaFin) tapa(filas - 1, false);
  const geo = new THREE.BufferGeometry();
  geo.setIndex(idx);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  // El primer punto de cada anillo va repetido para cerrar: se promedian sus normales para que no se vea la costura.
  const nr = geo.attributes.normal;
  for (let i = 0; i < filas; i++) {
    const a = i * por, b = a + n;
    _costura.set(nr.getX(a) + nr.getX(b), nr.getY(a) + nr.getY(b), nr.getZ(a) + nr.getZ(b)).normalize();
    nr.setXYZ(a, _costura.x, _costura.y, _costura.z);
    nr.setXYZ(b, _costura.x, _costura.y, _costura.z);
  }
  geo.setAttribute('parte', new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3).fill(parte), 1));
  return geo;
}

// ---------------------------------------------------------------------------------------------------------------
// Perfiles. Filas de [y, rx, rz adelante, rz atrás, centro z] (z positivo = atrás), en el cuerpo de 1,75 m.
// ---------------------------------------------------------------------------------------------------------------
// Torso con chaqueta un poco más holgada que el cuerpo, cuello alto y un escalón en el ruedo (debajo, el jean).
const TORSO = [
  [1.615, 0.046, 0.044, 0.048, 0.004],
  [1.575, 0.051, 0.049, 0.053, 0.008],
  [1.546, 0.054, 0.051, 0.055, 0.011],
  [1.54, 0.066, 0.061, 0.066, 0.012], // borde del cuello de la chaqueta
  [1.51, 0.074, 0.066, 0.071, 0.015],
  [1.49, 0.11, 0.07, 0.076, 0.018],
  [1.47, 0.168, 0.083, 0.085, 0.02],
  [1.44, 0.194, 0.099, 0.093, 0.018],
  [1.4, 0.193, 0.112, 0.097, 0.014],
  [1.34, 0.184, 0.122, 0.1, 0.01],
  [1.27, 0.174, 0.121, 0.097, 0.006],
  [1.2, 0.164, 0.115, 0.093, 0.002],
  [1.13, 0.157, 0.109, 0.09, 0],
  [1.06, 0.161, 0.106, 0.093, 0],
  [0.99, 0.17, 0.104, 0.104, 0],
  [0.945, 0.174, 0.103, 0.111, 0], // ruedo de la chaqueta
  [0.93, 0.163, 0.092, 0.102, 0],
  [0.885, 0.152, 0.078, 0.1, 0],
  [0.845, 0.1, 0.055, 0.075, 0],
];

// Pierna del jean alrededor de su eje (x = ±0,09). En la rodilla los dos tramos se traslapan: el muslo termina
// angosto adentro de la canilla y la canilla empieza angosta adentro del muslo.
const MUSLO_PERFIL = [
  [0.975, 0.054, 0.054, 0.054, 0],
  [0.925, 0.062, 0.072, 0.075, 0],
  [0.865, 0.083, 0.088, 0.091, -0.003],
  [0.77, 0.078, 0.083, 0.083, -0.006],
  [0.67, 0.071, 0.075, 0.073, -0.008],
  [0.59, 0.064, 0.067, 0.064, -0.008],
  [0.535, 0.058, 0.062, 0.058, -0.008],
  [0.5, 0.056, 0.061, 0.056, -0.008],
  [0.47, 0.052, 0.056, 0.054, -0.004],
  [0.445, 0.038, 0.04, 0.04, -0.002],
];
const CANILLA_PERFIL = [
  [0.565, 0.04, 0.043, 0.04, -0.008],
  [0.535, 0.054, 0.058, 0.054, -0.008],
  [0.5, 0.053, 0.058, 0.053, -0.008],
  [0.465, 0.054, 0.058, 0.056, -0.004],
  [0.415, 0.054, 0.056, 0.06, 0],
  [0.335, 0.053, 0.054, 0.061, 0.004],
  [0.245, 0.051, 0.052, 0.054, 0.003],
  [0.17, 0.051, 0.053, 0.053, 0],
  [0.13, 0.052, 0.055, 0.053, -0.004],
  [0.1, 0.044, 0.046, 0.044, -0.004],
];

// Manga: [distancia bajando desde el hombro, rx, rz, corrimiento hacia afuera, corrimiento hacia adelante].
// Los brazos se arman colgando derechos; la pose los abre un poco.
const MANGA_ARRIBA = [
  [-0.022, 0.026, 0.032, -0.024, 0],
  [-0.008, 0.042, 0.05, -0.014, 0],
  [0.012, 0.052, 0.057, -0.006, 0],
  [0.05, 0.055, 0.057, 0.001, 0],
  [0.1, 0.052, 0.052, 0.003, 0],
  [0.16, 0.048, 0.049, 0.001, 0.003],
  [0.23, 0.044, 0.046, 0, 0],
  [0.272, 0.042, 0.043, 0, -0.003],
  [0.3, 0.041, 0.042, 0, -0.005],
  [0.326, 0.04, 0.041, 0, -0.003],
  [0.348, 0.029, 0.03, 0, 0],
];
const MANGA_ABAJO = [
  [0.264, 0.03, 0.031, 0, -0.003],
  [0.276, 0.039, 0.04, 0, -0.003],
  [0.3, 0.039, 0.04, 0, -0.005],
  [0.328, 0.042, 0.043, 0, -0.003],
  [0.39, 0.043, 0.042, 0, 0],
  [0.465, 0.038, 0.035, 0, 0],
  [0.525, 0.034, 0.031, 0, 0],
  [0.542, 0.036, 0.033, 0, 0], // puño
  [0.55, 0.028, 0.026, 0, 0],
];
// Mano: [distancia, grueso, ancho, corrimiento hacia adelante]; las palmas giran un poco hacia atrás.
const MANO = [
  [0.525, 0.023, 0.026, 0],
  [0.555, 0.021, 0.03, 0.002],
  [0.595, 0.023, 0.04, 0.004],
  [0.64, 0.021, 0.042, 0.004],
  [0.68, 0.017, 0.037, 0.002],
  [0.712, 0.013, 0.028, 0],
  [0.728, 0.008, 0.015, 0],
];
const GIRO_MANO = 0.45;

const CABEZA = [
  [1.752, 0.018, 0.018, 0.02, 0.012],
  [1.738, 0.056, 0.058, 0.064, 0.013],
  [1.712, 0.078, 0.082, 0.092, 0.013],
  [1.682, 0.087, 0.09, 0.102, 0.011],
  [1.652, 0.088, 0.093, 0.103, 0.009],
  [1.622, 0.084, 0.094, 0.098, 0.007],
  [1.592, 0.078, 0.095, 0.09, 0.005],
  [1.562, 0.071, 0.091, 0.078, 0.002],
  [1.537, 0.063, 0.085, 0.066, -0.002],
  [1.514, 0.052, 0.074, 0.054, -0.008],
  [1.497, 0.03, 0.048, 0.032, -0.016],
];

// Nariz, cejas, pómulos, mentón y orejas empujados fuera de los anillos de la cabeza.
const relieveCara = (y) => (a) => {
  const frente = Math.PI / 2;
  let b = 0;
  if (Math.abs(y - 1.592) < 0.02) b += 0.017 * lobulo(a, frente, 0.16); // punta de la nariz
  if (Math.abs(y - 1.622) < 0.02) b += 0.007 * lobulo(a, frente, 0.14); // tabique
  if (Math.abs(y - 1.652) < 0.02) b += 0.004 * lobulo(a, frente, 0.6); // cejas
  if (Math.abs(y - 1.562) < 0.02) b += 0.004 * lobulo(a, frente, 0.2) + 0.004 * (lobulo(a, frente - 0.75, 0.3) + lobulo(a, frente + 0.75, 0.3));
  if (Math.abs(y - 1.514) < 0.012) b += 0.006 * lobulo(a, frente, 0.35); // mentón
  if (y < 1.64 && y > 1.575) b += 0.011 * (lobulo(a, -0.12, 0.22) + lobulo(a, Math.PI + 0.12, 0.22)); // orejas
  return b;
};

// Perfil de la cabeza a cualquier altura (para el casco de pelo).
function cabezaEn(y) {
  if (y >= CABEZA[0][0]) return CABEZA[0];
  for (let i = 0; i < CABEZA.length - 1; i++) {
    const a = CABEZA[i], b = CABEZA[i + 1];
    if (y <= a[0] && y >= b[0]) { const t = (a[0] - y) / (a[0] - b[0]); return a.map((v, k) => v + (b[k] - v) * t); }
  }
  return CABEZA.at(-1);
}
const lineaPelo = (a) => 1.62 + 0.055 * Math.sin(a) - 0.005 * Math.cos(2 * a);

// Casco de pelo corto sobre el cuero cabelludo, de la coronilla (f = 0) a la línea del pelo (f = 1), más delgado
// en el borde para que las orejas asomen.
function anilloPelo(f, grosor, n) {
  const corona = CABEZA[0][0], centro = new THREE.Vector3(0, 1.635, 0.012), puntos = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, s = Math.sin(a);
    const y = corona + (lineaPelo(a) - corona) * f;
    const [, rx, rzD, rzA, cz] = cabezaEn(y);
    const p = new THREE.Vector3(-Math.cos(a) * rx, y, cz - s * (s >= 0 ? rzD : rzA)).sub(centro);
    puntos.push(p.multiplyScalar(1 + (grosor * (1 - 0.75 * f * f)) / Math.max(0.05, p.length())).add(centro));
  }
  return puntos;
}

// Tenis: [z desde el tobillo (positivo = hacia la punta), medio ancho, empeine, suela] relativos al tobillo.
const TENIS = [
  [-0.088, 0.021, -0.02, -0.066],
  [-0.078, 0.036, 0.016, -0.08],
  [-0.05, 0.044, 0.036, -0.08],
  [-0.01, 0.047, 0.032, -0.08],
  [0.04, 0.05, 0.006, -0.08],
  [0.09, 0.052, -0.022, -0.08],
  [0.13, 0.053, -0.035, -0.08],
  [0.165, 0.05, -0.044, -0.08],
  [0.192, 0.041, -0.05, -0.079],
  [0.208, 0.023, -0.056, -0.075],
];
function anilloTenis(cx, z, mitad, arriba, suela, n) {
  const medio = suela + (arriba - suela) * 0.38, puntos = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    const x = Math.sign(c) * Math.abs(c) ** 0.6 * mitad;
    const y = s >= 0 ? medio + (arriba - medio) * s ** 0.85 : medio - (medio - suela) * Math.abs(s) ** 0.35;
    puntos.push(new THREE.Vector3(cx - x, TOBILLO + y, -z));
  }
  return puntos;
}

// Todas las piezas en coordenadas del cuerpo en reposo. Se arman una vez por nivel de detalle y las comparten todos
// los personajes: 1 es el del jugador; la multitud usa uno con menos puntos por anillo para los de lejos.
const juegos = {};
const geometriasDe = (detalle = 1) => (juegos[detalle] ??= armarGeometrias(detalle));
function armarGeometrias(detalle) {
  const N = (n) => Math.max(4, Math.round(n * detalle));
  const fila = (cx, n, ex = 2) => ([y, rx, rzD, rzA, cz]) => anillo(y, rx, rzD, rzA, cz, N(n), ex, null, cx);
  const g = {
    torso: superficie(TORSO.map(([y, rx, rzD, rzA, cz]) => anillo(y, rx, rzD, rzA, cz, N(20), y > 1.5 ? 2 : y > 1.0 ? 2.35 : 2.15)), PARTE.torso, true, true),
    cabeza: mergeGeometries([
      superficie(CABEZA.map(([y, rx, rzD, rzA, cz]) => anillo(y, rx, rzD, rzA, cz, N(20), 2, relieveCara(y))), PARTE.cabeza, true, true),
      superficie([0.04, 0.22, 0.45, 0.68, 0.86, 1].map((f) => anilloPelo(f, 0.014, N(20))), PARTE.pelo, true),
    ]),
    brazo: [], antebrazo: [], muslo: [], canilla: [], tenis: [],
  };
  for (const s of LADOS) {
    g.muslo.push(superficie(MUSLO_PERFIL.map(fila(s * 0.09, 12)), PARTE.pierna, true, true));
    g.canilla.push(superficie(CANILLA_PERFIL.map(fila(s * 0.09, 12)), PARTE.pierna, true, true));
    g.tenis.push(superficie(TENIS.map(([z, m, arriba, suela]) => anilloTenis(s * 0.09, z, m, arriba, suela, N(12))), PARTE.zapato, true, true));

    const h = hombroDe(s), giro = s * GIRO_MANO;
    const manga = ([d, rx, rz, ox, oz]) => anillo(h.y - d, rx * 1.06, rz * 1.06, rz * 1.06, h.z - oz, N(10), 2, null, h.x + s * ox);
    // Gira un anillo alrededor del eje vertical que pasa por (x, z).
    const girar = (puntos, x, z, angulo) => puntos.map((p) => p.sub(_costura.set(x, 0, z)).applyAxisAngle(THREE.Object3D.DEFAULT_UP, angulo).add(_costura));
    const mano = MANO.map(([d, grueso, ancho, oz]) => girar(anillo(h.y - d, grueso, ancho, ancho, h.z - oz, N(8), 2, null, h.x), h.x, h.z - oz, giro));
    // Pulgar, por el borde delantero de la palma girada.
    const pulgar = [[0.565, 0.026, 0.011], [0.605, 0.038, 0.0105], [0.64, 0.044, 0.008]].map(([d, oz, r]) => {
      const o = new THREE.Vector3(-s * 0.006, 0, -oz).applyAxisAngle(THREE.Object3D.DEFAULT_UP, giro);
      return anillo(h.y - d, r, r, r, h.z + o.z, N(6), 2, null, h.x + o.x);
    });
    g.brazo.push(superficie(MANGA_ARRIBA.map(manga), PARTE.manga, true, true));
    g.antebrazo.push(mergeGeometries([
      superficie(MANGA_ABAJO.map(manga), PARTE.manga, true, true),
      superficie(mano, PARTE.mano, true, true),
      superficie(pulgar, PARTE.mano, true, true),
    ]));
  }
  return g;
}

// ---------------------------------------------------------------------------------------------------------------
// Material: un color por pieza y los detalles pintados en el shader con la posición en reposo (cremallera, cuello,
// bolsillos, costuras, jean gastado, cordones, ojos, cejas y boca). Sin texturas. Cada color puede ser un número o un
// nodo TSL: la multitud pasa nodos que leen el color de cada instancia.
// ---------------------------------------------------------------------------------------------------------------
function crearMaterial(c) {
  const material = new THREE.MeshStandardNodeMaterial({ metalness: 0 });
  const q = positionGeometry, n = normalGeometry, parte = attribute('parte', 'float');
  const [piel, pelo, chaqueta, jean, tenis] = ['piel', 'pelo', 'chaqueta', 'pantalon', 'zapatos'].map((k) => (c[k]?.isNode ? c[k] : color(new THREE.Color(c[k]))));
  const linea = (x, ancho) => smoothstep(ancho, ancho * 0.4, abs(x)); // 1 sobre una línea fina en x = 0

  material.colorNode = Fn(() => {
    const col = vec3(piel).toVar();
    If(parte.lessThan(0.5), () => {
      // Chaqueta: cremallera, bolsillos sesgados, costuras de los costados, cuello alto y resorte en el ruedo.
      // Debajo del ruedo, el jean; arriba del cuello, la piel.
      const pecho = smoothstep(-0.035, -0.075, q.z);
      const ax = abs(q.x);
      const cremallera = linea(q.x, 0.006).mul(pecho).mul(0.45);
      const bolsillos = linea(q.y.sub(1.0).sub(ax.sub(0.06).mul(1.5)), 0.004).mul(step(0.06, ax)).mul(step(ax, 0.125)).mul(pecho).mul(0.35);
      const costados = smoothstep(0.985, 0.998, abs(n.x)).mul(0.15);
      const resorte = smoothstep(0.965, 0.955, q.y).mul(0.14);
      const cuello = smoothstep(1.486, 1.494, q.y).mul(0.1);
      const tela = chaqueta.mul(float(1).sub(cremallera).sub(bolsillos).sub(costados).sub(resorte).sub(cuello));
      col.assign(mix(mix(jean, tela, step(0.937, q.y)), piel, step(1.543, q.y)));
    }).ElseIf(parte.lessThan(1.5), () => {
      // Jean: costura de afuera más clara, muslos y rodillas gastados, dobladillo abajo.
      const costura = smoothstep(0.975, 0.995, n.x.mul(sign(q.x))).mul(0.45);
      const gastado = smoothstep(-0.4, -0.85, n.z).mul(smoothstep(0.45, 0.6, q.y)).mul(smoothstep(0.92, 0.78, q.y)).mul(0.22);
      const dobladillo = smoothstep(0.13, 0.122, q.y).mul(0.2);
      col.assign(jean.mul(float(1).add(costura).add(gastado).sub(dobladillo)));
    }).ElseIf(parte.lessThan(2.5), () => {
      // Tenis: suela blanca con borde, puntera más clara y cordones en el empeine.
      const suela = smoothstep(0.03, 0.024, q.y);
      const borde = linea(q.y.sub(0.033), 0.003).mul(0.3);
      const puntera = smoothstep(-0.15, -0.175, q.z).mul(0.12);
      const cordones = step(0.55, fract(q.z.mul(80))).mul(linea(abs(q.x).sub(0.09), 0.016))
        .mul(step(q.z, 0)).mul(step(-0.09, q.z)).mul(step(0.07, q.y));
      col.assign(mix(mix(tenis.mul(float(1).add(puntera).sub(borde)), color(0xe4e0d7), suela), color(0xf2f0ea), cordones.mul(0.75)));
    }).ElseIf(parte.lessThan(3.5), () => {
      // Mangas: resorte en el puño y costura del hombro.
      const puno = smoothstep(0.945, 0.935, q.y).mul(0.16);
      const hombro = linea(q.y.sub(1.415), 0.003).mul(0.2);
      col.assign(chaqueta.mul(float(1).sub(puno).sub(hombro)));
    }).ElseIf(parte.greaterThan(5.5), () => {
      // Pelo con mechones apenas marcados.
      col.assign(pelo.mul(sin(q.x.mul(170).add(q.z.mul(130))).mul(0.06).add(0.97)));
    }).ElseIf(parte.greaterThan(4.5), () => {
      // Cara: el pelo pintado sobre el cuero (bajo el casco), ojos, cejas y boca.
      const hd = normalize(vec2(q.x, float(0.01).sub(q.z)));
      const lineaY = hd.y.mul(0.055).add(1.62).sub(hd.x.mul(hd.x).sub(hd.y.mul(hd.y)).mul(0.005));
      const cuero = smoothstep(lineaY.sub(0.004), lineaY.add(0.004), q.y);
      const frente = smoothstep(-0.06, -0.08, q.z);
      const ojoX = abs(abs(q.x).sub(0.031));
      const ojos = smoothstep(0.011, 0.006, ojoX).mul(smoothstep(0.0055, 0.002, abs(q.y.sub(1.627)))).mul(frente);
      const cejas = smoothstep(0.016, 0.01, ojoX).mul(smoothstep(0.0035, 0.0012, abs(q.y.sub(1.646)))).mul(frente);
      const boca = smoothstep(0.022, 0.014, abs(q.x)).mul(smoothstep(0.0045, 0.0015, abs(q.y.sub(1.549)))).mul(frente);
      const cara = mix(mix(piel.mul(float(1).sub(ojos.mul(0.75))), pelo, cejas.mul(0.75)), piel.mul(color(0xb06a5c)).mul(1.15), boca.mul(0.6));
      col.assign(mix(cara, pelo, cuero));
    });
    return col;
  })();

  const es = (id) => step(abs(parte.sub(id)), 0.25);
  material.roughnessNode = float(0.85).sub(es(PARTE.mano).add(es(PARTE.cabeza)).mul(0.3)).sub(es(PARTE.zapato).mul(0.25)).sub(es(PARTE.pelo).mul(0.1));
  return material;
}

// ---------------------------------------------------------------------------------------------------------------
// IK de dos huesos en el espacio del cuerpo. Orienta `arriba` (hijo de un padre con orientación qPadre) para que
// su -y vaya hacia el medio y dobla `medio` solo en su eje x. `polo` dice hacia dónde sale la articulación del medio;
// `signo` es el lado z local hacia el que sale en reposo (rodilla: -1, adelante; codo: +1, atrás).
// Devuelve la orientación del segundo hueso en el cuerpo.
// ---------------------------------------------------------------------------------------------------------------
const _d = new THREE.Vector3(), _b = new THREE.Vector3(), _w = new THREE.Vector3();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
const _m = new THREE.Matrix4(), _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
function dosHuesos(qPadre, arriba, medio, origen, meta, l1, l2, polo, signo) {
  _d.subVectors(meta, origen);
  const d = THREE.MathUtils.clamp(_d.length(), Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-3);
  _d.normalize();
  const a = Math.acos(THREE.MathUtils.clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1));
  _b.copy(polo).addScaledVector(_d, -polo.dot(_d)).normalize();
  _y.copy(_d).multiplyScalar(-Math.cos(a)).addScaledVector(_b, -Math.sin(a));
  _z.copy(_b).multiplyScalar(signo).addScaledVector(_y, -signo * _b.dot(_y)).normalize();
  _x.crossVectors(_y, _z);
  _q1.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
  arriba.quaternion.copy(qPadre).invert().multiply(_q1);
  // Del medio a la meta, visto desde el primer hueso: ángulo de la bisagra.
  _w.subVectors(meta, origen).addScaledVector(_y, l1).applyQuaternion(_q2.copy(_q1).invert());
  medio.rotation.set(Math.atan2(-_w.z, -_w.y), 0, 0);
  return _q1.multiply(medio.quaternion);
}

// ---------------------------------------------------------------------------------------------------------------
// El personaje.
// ---------------------------------------------------------------------------------------------------------------
const _origen = new THREE.Vector3(), _meta = new THREE.Vector3(), _polo = new THREE.Vector3();
const _bola = new THREE.Vector3(), _qPie = new THREE.Quaternion(), EJE_X = new THREE.Vector3(1, 0, 0);

export function crearPersonaje(opciones = {}) {
  const { raiz, animar, pedalear, pararse } = armarCuerpo(crearMaterial({ ...COLORES, ...opciones }));
  return { raiz, animar, pedalear, pararse };
}

// Para la multitud (js/peatones.js): el mismo esqueleto sin mallas, que solo anota cada pieza con su pivote y su punto
// de articulación en reposo; la malla instanciada de esa pieza va con la matriz pivote.matrixWorld · T(-punto).
export const crearEsqueleto = () => armarCuerpo(null);
// Geometrías en el orden de esqueleto.piezas: torso, cabeza, pierna izquierda (muslo, canilla, tenis), derecha,
// brazo izquierdo (brazo, antebrazo con mano), derecho.
export function geometriasPiezas(detalle = 1) {
  const g = geometriasDe(detalle);
  return [g.torso, g.cabeza, ...[0, 1].flatMap((i) => [g.muslo[i], g.canilla[i], g.tenis[i]]), ...[0, 1].flatMap((i) => [g.brazo[i], g.antebrazo[i]])];
}
export { crearMaterial as materialPersonaje, anillo, superficie };

function armarCuerpo(material) {
  const geos = geometriasDe();
  const raiz = new THREE.Group();
  raiz.name = 'Personaje';
  const cuerpo = new THREE.Group();
  cuerpo.scale.setScalar(ESCALA);
  raiz.add(cuerpo);

  // Cada pivote va en su articulación y la malla adentro se corre al revés: la geometría queda en coordenadas del
  // cuerpo en reposo, que es lo que usa el shader para los detalles.
  const piezas = [];
  const pivote = (padre, punto, puntoPadre, geo, nombre) => {
    const g = new THREE.Group();
    g.name = nombre;
    g.position.subVectors(punto, puntoPadre);
    padre.add(g);
    if (geo) piezas.push({ pivote: g, punto: punto.clone() });
    if (geo && material) {
      const m = new THREE.Mesh(geo, material);
      m.position.copy(punto).negate();
      m.castShadow = true;
      g.add(m);
    }
    return g;
  };
  const cadera = pivote(cuerpo, PELVIS, new THREE.Vector3(), geos.torso, 'cadera');
  const cabeza = pivote(cadera, CUELLO, PELVIS, geos.cabeza, 'cabeza');
  const piernas = LADOS.map((s, i) => {
    const pc = caderaDe(s), pr = new THREE.Vector3(pc.x, TOBILLO + CANILLA, 0), pt = new THREE.Vector3(pc.x, TOBILLO, 0);
    const muslo = pivote(cadera, pc, PELVIS, geos.muslo[i], 'muslo');
    const rodilla = pivote(muslo, pr, pc, geos.canilla[i], 'rodilla');
    const pie = pivote(rodilla, pt, pr, geos.tenis[i], 'pie');
    return { punto: pc, muslo, rodilla, pie };
  });
  const brazos = LADOS.map((s, i) => {
    const ph = hombroDe(s), pc = ph.clone().setY(ph.y - BRAZO);
    const hombro = pivote(cadera, ph, PELVIS, geos.brazo[i], 'hombro');
    const codo = pivote(hombro, pc, ph, geos.antebrazo[i], 'codo');
    return { punto: ph, hombro, codo };
  });

  let fase = 0, reloj = 0;
  // velocidad en m/s. Caminando el muslo abre lo justo para la zancada; corriendo el torso se inclina, los codos se
  // doblan y hay un rebote. Quieto, el peso pasa despacio de un pie al otro y la cabeza mira alrededor.
  const animar = (velocidad, dt) => {
    const v = Math.abs(velocidad);
    reloj += dt;
    const paso = Math.min(1, v / 1.4), correr = THREE.MathUtils.smoothstep(v, 2.2, 3.8), quieto = 1 - Math.min(1, v / 0.4);
    const cadencia = 0.8 + 0.15 * v; // ciclos por segundo (dos pasos)
    if (v > 0.02) fase = (fase + dt * Math.PI * 2 * cadencia) % (Math.PI * 2);
    const abre = Math.min(0.75, Math.asin(Math.min(1, v / cadencia / 3.4)));
    const inclina = -(0.04 * paso + 0.16 * correr);
    const peso = Math.sin(reloj * 0.45) * quieto; // + carga el pie derecho
    const corre = 0.022 * peso;
    const ladeo = 0.035 * peso + 0.03 * paso * Math.cos(fase);
    cadera.rotation.set(inclina, 0, ladeo);
    let alto = 0;
    piernas.forEach(({ muslo, rodilla, pie }, i) => {
      const p = fase + i * Math.PI;
      const vuelo = Math.max(0, Math.cos(p + 0.5)) ** 1.5; // la rodilla se dobla al comienzo del vuelo
      const suelta = Math.max(0, -LADOS[i] * peso);
      const m = abre * Math.sin(p);
      const r = -(0.05 * paso + vuelo * (0.25 + 0.75 * paso + 0.8 * correr) * Math.min(1, v / 0.3) + 0.14 * suelta);
      const apoyo = Math.max(THREE.MathUtils.clamp(0.5 - Math.cos(p) * 3, 0, 1) * (1 - quieto), quieto * (1 - 0.6 * suelta));
      muslo.rotation.set(m - inclina, 0, -corre / 0.88 - ladeo);
      rodilla.rotation.set(r, 0, 0);
      const pi = -(m + r) * apoyo + (0.22 * Math.sin(p) + 0.3 * vuelo) * paso;
      pie.rotation.set(pi, 0, 0);
      // Altura de la cadera: la pierna que llega más abajo (contando talón o punta del tenis) pisa el suelo.
      const b = m + r + pi;
      alto = Math.max(alto, 0.04 + MUSLO * Math.cos(m) + CANILLA * Math.cos(m + r)
        + Math.max(0.08 * Math.cos(b) + 0.088 * Math.sin(b), 0.075 * Math.cos(b) - 0.208 * Math.sin(b)));
    });
    cadera.position.set(corre, alto + 0.05 * correr * Math.abs(Math.sin(fase)), 0);
    brazos.forEach(({ hombro, codo }, i) => {
      const p = fase + i * Math.PI;
      const vaiven = (0.3 * paso + 0.35 * correr) * Math.sin(p); // al revés de la pierna del mismo lado
      hombro.rotation.set(-vaiven - inclina * 0.8 + 0.03 * quieto * Math.sin(reloj * 0.7 + i * 2), 0, LADOS[i] * (0.08 + 0.14 * correr));
      codo.rotation.set(0.12 + 0.2 * paso + 1.05 * correr + 0.25 * paso * Math.max(0, -Math.sin(p)), 0, 0);
    });
    cabeza.rotation.set(-inclina * 0.7, 0.18 * quieto * Math.sin(reloj * 0.21), 0);
  };

  // Sobre la bicicleta: fase 0 = pedal izquierdo abajo; crece pedaleando hacia adelante (abajo, atrás, arriba,
  // adelante), o sea que las bielas giran con rotation.x = -fase. inclinacion en rad, con el signo de rotation.z
  // (positivo hacia la izquierda): el torso se ladea la mitad y se agacha un poco más.
  const pedalear = (faseBiela, inclinacion = 0) => {
    const agacha = 0.5 + Math.abs(inclinacion) * 0.3;
    cadera.position.set(SILLIN.x, SILLIN.y + 0.06, SILLIN.z + 0.02).divideScalar(ESCALA);
    cadera.rotation.set(-agacha, 0, inclinacion * 0.5);
    cabeza.rotation.set(agacha * 0.8, 0, -inclinacion * 0.4);
    const qc = cadera.quaternion;
    const articulacion = (punto) => _origen.copy(punto).sub(PELVIS).applyQuaternion(qc).add(cadera.position);
    piernas.forEach(({ punto, muslo, rodilla, pie }, i) => {
      const a = faseBiela + i * Math.PI;
      // El tobillo queda donde la bola del pie, con el pie inclinado según la vuelta, pisa el pedal.
      _qPie.setFromAxisAngle(EJE_X, -(0.16 + 0.16 * Math.cos(a) - 0.1 * Math.sin(a)));
      _meta.set(LADOS[i] * PEDAL_X, EJE_BIELAS.y - Math.cos(a) * BIELA, EJE_BIELAS.z + Math.sin(a) * BIELA).divideScalar(ESCALA)
        .sub(_bola.copy(BOLA).applyQuaternion(_qPie));
      const qCanilla = dosHuesos(qc, muslo, rodilla, articulacion(punto), _meta, MUSLO, CANILLA, _polo.set(LADOS[i] * 0.1, 0.4, -1), -1);
      pie.quaternion.copy(qCanilla).invert().multiply(_qPie);
    });
    brazos.forEach(({ punto, hombro, codo }, i) => {
      _meta.set(LADOS[i] * MANUBRIO.x, MANUBRIO.y + 0.03, MANUBRIO.z).divideScalar(ESCALA);
      dosHuesos(qc, hombro, codo, articulacion(punto), _meta, BRAZO, ANTEBRAZO_MANO, _polo.set(LADOS[i] * 0.3, -0.7, 0.6), 1);
    });
  };

  const pararse = () => animar(0, 0);
  pararse();
  return { raiz, animar, pedalear, pararse, piezas, cadera, cabeza, brazos };
}
