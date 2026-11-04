import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { vertexColor, float } from 'three/tsl';
import { noche } from './edificios.js';

// Bici urbana de ciclorruta: marco tubular, guardabarros, parrilla, cubrecadena y luces. Mira hacia -z con el
// origen a ras del suelo, bajo el eje de las bielas. Idea y física adaptadas de Slop New York (mrdoob, MIT):
// js/controllers.js; el modelo se armó de nuevo con estas medidas.

// Medidas que usa el ciclista (otro módulo): no cambiarlas sin avisar. Con la fase f que devuelve animar(), el
// pedal derecho (x = +0,14) va en biela + radioBiela·(0, −cos f, sin f) y el izquierdo (x = −0,14) en el opuesto.
export const BICI = { sillin: [0, 0.98, 0.18], biela: [0, 0.32, 0], radioBiela: 0.17, punos: [0.27, 1.08, -0.42] };

const RADIO = 0.33; // rueda de 0,66 m
const EJE_T = [0, RADIO, 0.44], EJE_D = [0, RADIO, -0.62];
const DESARROLLO = 2.6; // vueltas de rueda por pedalada: unas 80 por minuto a 7 m/s

const C = (hex) => new THREE.Color(hex);
const NEGRO = C(0x18191b), GRIS = C(0x3a3d42), PLATA = C(0xb8bcc2), CUERO = C(0x2a211c);

function pintar(g, color) {
  g = g.index ? g.toNonIndexed() : g;
  g.deleteAttribute('uv');
  const n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set([color.r, color.g, color.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

// Tubo recto de a a b (puntos [x, y, z]).
const ARRIBA = new THREE.Vector3(0, 1, 0), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _q = new THREE.Quaternion();
function tubo(lista, color, a, b, r, lados = 8) {
  _a.fromArray(a); _b.fromArray(b);
  const g = new THREE.CylinderGeometry(r, r, _a.distanceTo(_b), lados);
  g.applyQuaternion(_q.setFromUnitVectors(ARRIBA, _b.clone().sub(_a).normalize()));
  g.translate((_a.x + _b.x) / 2, (_a.y + _b.y) / 2, (_a.z + _b.z) / 2);
  lista.push(pintar(g, color));
}
const pieza = (lista, color, g, [x, y, z]) => lista.push(pintar(g.translate(x, y, z), color));

// Rueda con llanta, rin, manzana y radios, centrada en su eje (que va a lo largo de x).
function geometriaRueda() {
  const partes = [
    pintar(new THREE.TorusGeometry(RADIO - 0.025, 0.025, 6, 28).rotateY(Math.PI / 2), NEGRO),
    pintar(new THREE.TorusGeometry(RADIO - 0.045, 0.01, 4, 28).rotateY(Math.PI / 2), PLATA),
  ];
  tubo(partes, PLATA, [-0.05, 0, 0], [0.05, 0, 0], 0.02);
  // Radios: salen alternados de cada lado de la manzana, como en una rueda real.
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2, s = i % 2 ? 1 : -1;
    tubo(partes, PLATA, [s * 0.035, Math.sin(a) * 0.02, Math.cos(a) * 0.02], [0, Math.sin(a) * 0.283, Math.cos(a) * 0.283], 0.0022, 3);
  }
  return mergeGeometries(partes);
}

// Guardabarros: arco de toro aplanado; el ángulo 0 es adelante y π/2 arriba.
const guardabarros = (inicio, largo, eje) =>
  new THREE.TorusGeometry(0.36, 0.012, 3, 14, largo).rotateZ(inicio).scale(1, 1, 2.2).rotateY(Math.PI / 2).translate(...eje);

function geometriaCuadro(color) {
  const M = new THREE.Color(color), p = [];
  const [, ys, zs] = BICI.sillin, [, yb] = BICI.biela;
  const tubSillin = (k) => [0, yb + (ys - yb) * k, zs * k]; // punto del tubo del sillín (0 = biela, 1 = sillín)
  const direccion = (y) => [0, y, -0.62 + (y - RADIO) * 0.3]; // eje de la dirección, unos 73°
  // Marco: tubo del sillín, superior, diagonal, de dirección y caja de las bielas.
  tubo(p, M, BICI.biela, tubSillin(0.72), 0.017);
  tubo(p, M, tubSillin(0.67), direccion(0.86), 0.017);
  tubo(p, M, BICI.biela, direccion(0.75), 0.02);
  tubo(p, M, direccion(0.73), direccion(0.9), 0.022);
  tubo(p, M, [-0.045, yb, 0], [0.045, yb, 0], 0.022);
  for (const s of [-1, 1]) {
    // Vainas y tirantes hasta el eje trasero; tenedor hasta el delantero.
    tubo(p, M, [s * 0.025, yb, 0.02], [s * 0.062, RADIO, 0.44], 0.011, 6);
    tubo(p, M, [s * 0.03, tubSillin(0.67)[1], tubSillin(0.67)[2]], [s * 0.065, RADIO + 0.015, 0.435], 0.009, 6);
    tubo(p, M, [s * 0.045, ...direccion(0.72).slice(1)], [s * 0.055, RADIO, -0.62], 0.012, 6);
  }
  tubo(p, M, [-0.05, ...direccion(0.725).slice(1)], [0.05, ...direccion(0.725).slice(1)], 0.018);
  // Tija, potencia, manubrio curvo hacia atrás y puños donde van las manos.
  tubo(p, PLATA, tubSillin(0.7), tubSillin(0.93), 0.012);
  tubo(p, PLATA, direccion(0.9), direccion(1.0), 0.014);
  tubo(p, PLATA, direccion(1.0), [0, 1.05, -0.49], 0.014);
  tubo(p, PLATA, [-0.17, 1.05, -0.49], [0.17, 1.05, -0.49], 0.011);
  const [xp, yp, zp] = BICI.punos;
  for (const s of [-1, 1]) {
    tubo(p, PLATA, [s * 0.17, 1.05, -0.49], [s * xp, yp, zp], 0.011);
    tubo(p, NEGRO, [s * (xp - 0.045), yp - 0.014, zp - 0.032], [s * (xp + 0.045), yp + 0.014, zp + 0.032], 0.017);
  }
  pieza(p, CUERO, new THREE.SphereGeometry(1, 12, 6).scale(0.08, 0.028, 0.135), [0, ys - 0.028, zs - 0.01]);
  // Guardabarros, parrilla trasera, plato y cubrecadena (al lado derecho, +x).
  p.push(pintar(guardabarros(0.87, 2.62, EJE_T), GRIS), pintar(guardabarros(0.35, 2.25, EJE_D), GRIS));
  for (const s of [-1, 1]) {
    tubo(p, NEGRO, [s * 0.06, 0.72, 0.27], [s * 0.06, 0.72, 0.64], 0.007, 5);
    tubo(p, NEGRO, [s * 0.066, RADIO + 0.01, 0.45], [s * 0.06, 0.72, 0.6], 0.007, 5);
    tubo(p, NEGRO, [s * 0.06, 0.72, 0.27], [s * 0.035, tubSillin(0.6)[1], tubSillin(0.6)[2] + 0.02], 0.006, 5);
  }
  for (const z of [0.36, 0.5, 0.64]) tubo(p, NEGRO, [-0.06, 0.72, z], [0.06, 0.72, z], 0.006, 5);
  pieza(p, GRIS, new THREE.TorusGeometry(0.095, 0.008, 3, 16).rotateY(Math.PI / 2), [0.052, yb, 0]);
  pieza(p, NEGRO, new THREE.BoxGeometry(0.008, 0.13, 0.55), [0.064, RADIO, 0.2]);
  return mergeGeometries(p);
}

// Luces: farola blanca bajo el manubrio y piloto rojo en la parrilla; brillan de noche (bloom).
function geometriaLuces() {
  const l = [];
  pieza(l, C(0xfff4d8), new THREE.BoxGeometry(0.06, 0.045, 0.04), [0, 0.86, -0.505]);
  pieza(l, C(0xe01818), new THREE.BoxGeometry(0.06, 0.035, 0.015), [0, 0.7, 0.655]);
  return mergeGeometries(l);
}

const MAT = {
  partes: new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.25 }),
  luces: new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.3 }),
};
MAT.luces.emissiveNode = vertexColor().mul(float(0.15).add(noche.mul(2.5)));

export function crearBici(color = 0x1f6fb5) {
  const raiz = new THREE.Group();
  raiz.name = 'Bici';
  const malla = (g, m, padre = raiz) => {
    const x = new THREE.Mesh(g, m);
    x.castShadow = true;
    padre.add(x);
    return x;
  };
  malla(geometriaCuadro(color), MAT.partes);
  malla(geometriaLuces(), MAT.luces);
  const rueda = geometriaRueda();
  const ruedas = [EJE_T, EJE_D].map((eje) => { const r = malla(rueda, MAT.partes); r.position.fromArray(eje); return r; });

  // Bielas: giran alrededor de su eje; los pedales giran al revés para quedar siempre planos.
  const bielas = new THREE.Group();
  bielas.position.fromArray(BICI.biela);
  raiz.add(bielas);
  const brazo = pintar(new THREE.BoxGeometry(0.014, BICI.radioBiela, 0.03), PLATA);
  const pedal = pintar(new THREE.BoxGeometry(0.09, 0.02, 0.065), NEGRO);
  const pedales = [1, -1].map((s) => {
    // Derecha (+x) apunta abajo con fase 0; izquierda, arriba.
    malla(brazo, MAT.partes, bielas).position.set(s * 0.085, -s * BICI.radioBiela / 2, 0);
    const p = malla(pedal, MAT.partes, bielas);
    p.position.set(s * 0.14, -s * BICI.radioBiela, 0);
    return p;
  });

  let fase = 0;
  const animar = (velocidad, dt) => {
    const vuelta = (velocidad * dt) / RADIO;
    for (const r of ruedas) r.rotation.x -= vuelta; // hacia -z la parte de arriba avanza
    fase += vuelta / DESARROLLO; // piñón fijo: también giran hacia atrás en reversa
    bielas.rotation.x = -fase;
    for (const p of pedales) p.rotation.x = fase;
    return fase;
  };
  return { raiz, animar };
}

// ---------------------------------------------------------------------------------------------------------------
// Física: b = { x, z, rumbo, vel, giro, inclinacion }; entrada = { avance, giro, correr, freno }.
// ---------------------------------------------------------------------------------------------------------------
const hacia = (v, meta, paso) => (v < meta ? Math.min(meta, v + paso) : Math.max(meta, v - paso));

export function moverBici(b, entrada, dt) {
  const { avance = 0, giro = 0, correr = false, freno = false } = entrada;
  const max = correr ? 10 : 7;
  if (freno) b.vel = hacia(b.vel, 0, 6 * dt);
  else if (avance > 0) {
    if (b.vel < 0) b.vel = hacia(b.vel, 0, 5 * dt);
    else if (b.vel < max) b.vel = Math.min(max, b.vel + avance * (correr ? 3.2 : 2.4) * dt);
    else b.vel = hacia(b.vel, max, 1.5 * dt); // soltó Shift: baja sola a 7 m/s
  } else if (avance < 0) b.vel = b.vel > 0.05 ? hacia(b.vel, 0, 4.5 * dt) : hacia(b.vel, -1.5, 1.2 * dt);
  else b.vel = hacia(b.vel, 0, (0.12 + 0.012 * b.vel * b.vel) * dt); // rodadura y aire

  // Giro: el radio crece con la velocidad (unos 3 m despacio, 6,5 m a 7 m/s); quieta no gira.
  b.giro += (giro - b.giro) * Math.min(1, dt * 6);
  const guinada = (b.giro * b.vel) / (2.6 + 0.55 * Math.abs(b.vel));
  b.rumbo += guinada * dt;
  b.x -= Math.sin(b.rumbo) * b.vel * dt;
  b.z -= Math.cos(b.rumbo) * b.vel * dt;
  // Se inclina hacia adentro de la curva lo que pide el equilibrio (tan θ = v·ω / g), con tope de unos 29°.
  const meta = Math.max(-0.5, Math.min(0.5, Math.atan((b.vel * guinada) / 9.8)));
  b.inclinacion += (meta - b.inclinacion) * Math.min(1, dt * 5);
  return b;
}
