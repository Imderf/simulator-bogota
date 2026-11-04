import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { attribute, texture, uv, uniform, vec2, vec3, float, floor, mod, mix } from 'three/tsl';
import { noche } from './edificios.js';
import { anchoVia, andenVia } from './vias.js';
import { aMundo } from './marco.js';

// Mobiliario urbano y vendedores ambulantes. Todo es instancias por tipo (una malla por tipo, con el color de cada
// pieza en los vértices), puesto sobre `calles.piso` y con un círculo en `choques` para que nadie lo atraviese.
//   · A lo largo de las vías con andén: canecas, bancas, bolardos, señales de tránsito, hidrantes y, en las
//     avenidas, paraderos del SITP; en los cruces, placas de nomenclatura azules.
//   · Vallas publicitarias y dos pantallas LED en las avenidas (avisos inventados, sin marcas reales).
//   · Vendedores ambulantes bogotanos con su puesto: tinto, frutas con sombrilla, obleas, mazorca, chazas de dulces
//     y minutos, empanadas; en la Séptima, la Plaza de Bolívar, el Parque Santander, el Chorro de Quevedo, el Eje
//     Ambiental y San Victorino. Solo están de día (de 5:30 a 20:30).
// Los sitios son deterministas (una semilla fija): el mismo mundo en cada carga.
// Adaptado de Slop New York (mrdoob, MIT): js/street-props.js (colocación a lo largo de las vías con rechazo contra
// los edificios, un InstancedMesh por tipo) y js/street-details.js (vallas y pantallas con textura de atlas).

const azar = (k) => { const s = Math.sin(k * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
const llave = (x, z) => `${Math.round(x * 2)},${Math.round(z * 2)}`;

// ---------------------------------------------------------------------------------------------------------------
// Piezas: se suman geometrías con su color y se funden en una sola, con el color en los vértices.
// ---------------------------------------------------------------------------------------------------------------
class Pieza {
  constructor() { this.l = []; }
  // geo ya posicionada o con [x, y, z] y rotación [rx, ry, rz]
  add(geo, hex, pos = [0, 0, 0], rot = [0, 0, 0]) {
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (rot[0] || rot[1] || rot[2]) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...rot)));
    g.translate(...pos);
    const c = new THREE.Color(hex), n = g.attributes.position.count, col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'color', 'uv'].includes(k)) g.deleteAttribute(k);
    this.l.push(g);
    return this;
  }
  caja(w, h, d, hex, pos, rot) { return this.add(new THREE.BoxGeometry(w, h, d), hex, pos, rot); }
  cil(r0, r1, h, hex, pos, rot, seg = 10) { return this.add(new THREE.CylinderGeometry(r0, r1, h, seg), hex, pos, rot); }
  esfera(r, hex, pos, seg = 8) { return this.add(new THREE.SphereGeometry(r, seg, seg - 2), hex, pos); }
  fin() { return mergeGeometries(this.l); }
}

// Sombrilla de gajos de dos colores: casquete de esfera con el color alternando por ángulo.
function sombrilla(P, c1, c2, y, radio = 1.15) {
  const g = new THREE.SphereGeometry(radio, 12, 3, 0, Math.PI * 2, 0, Math.PI * 0.34).toNonIndexed();
  const col = new Float32Array(g.attributes.position.count * 3), a = new THREE.Color(c1), b = new THREE.Color(c2), pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const gajo = Math.floor(((Math.atan2(pos.getZ(i), pos.getX(i)) + Math.PI) / (Math.PI * 2)) * 12 + 1e-4) % 2;
    // Los tres vértices de un triángulo comparten el gajo de su centro: se promedia por triángulo.
    col.set(gajo ? [b.r, b.g, b.b] : [a.r, a.g, a.b], i * 3);
  }
  const tri = new Float32Array(col.length);
  for (let t = 0; t < pos.count; t += 3) {
    const cx = (pos.getX(t) + pos.getX(t + 1) + pos.getX(t + 2)) / 3, cz = (pos.getZ(t) + pos.getZ(t + 1) + pos.getZ(t + 2)) / 3;
    const gajo = Math.floor(((Math.atan2(cz, cx) + Math.PI) / (Math.PI * 2)) * 12) % 2, c = gajo ? b : a;
    for (let k = 0; k < 3; k++) tri.set([c.r, c.g, c.b], (t + k) * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(tri, 3));
  g.translate(0, y, 0);
  P.l.push(g);
  P.cil(0.025, 0.025, y + 0.05, 0x777b80, [0, (y + 0.05) / 2 - 0.05, 0], [0, 0, 0], 6);
  return P;
}

// Persona de pie, de cara a +z.
function persona(P, camisa, x = 0, z = 0, gorra = null, piel = 0xb98563) {
  P.caja(0.15, 0.82, 0.17, 0x2b2f3a, [x - 0.1, 0.41, z]).caja(0.15, 0.82, 0.17, 0x2b2f3a, [x + 0.1, 0.41, z]);
  P.cil(0.2, 0.19, 0.66, camisa, [x, 1.15, z], [0, 0, 0], 8);
  P.cil(0.05, 0.05, 0.12, piel, [x, 1.53, z], [0, 0, 0], 6).esfera(0.115, piel, [x, 1.67, z]);
  P.cil(0.055, 0.055, 0.5, camisa, [x - 0.27, 1.2, z + 0.04], [0.5, 0, 0.12], 6).cil(0.055, 0.055, 0.5, camisa, [x + 0.27, 1.2, z + 0.04], [0.5, 0, -0.12], 6);
  if (gorra) P.cil(0.12, 0.13, 0.07, gorra, [x, 1.78, z], [0, 0, 0], 8).caja(0.18, 0.02, 0.1, gorra, [x, 1.76, z + 0.12]);
  return P;
}

// ---------------------------------------------------------------------------------------------------------------
// Vendedores: cada tipo es un puesto con su persona, de cara a +z (hacia donde pasa el cliente).
// ---------------------------------------------------------------------------------------------------------------
const rueda = (P, x, z, r = 0.22) => P.cil(r, r, 0.05, 0x222428, [x, r, z], [0, 0, Math.PI / 2], 10);
const VENDEDORES = {
  // Termos de tinto y aromática sobre un carrito de dos ruedas.
  tinto() {
    const P = new Pieza();
    P.caja(1.0, 0.07, 0.6, 0x8a8e93, [0, 0.82, 0]).caja(0.9, 0.55, 0.5, 0x4d5560, [0, 0.52, 0]);
    rueda(P, -0.55, 0.05); rueda(P, 0.55, 0.05);
    for (const [x, c] of [[-0.3, 0xb8bcc2], [0, 0xb8bcc2], [0.3, 0x2e5d9e]]) P.cil(0.1, 0.1, 0.45, c, [x, 1.1, -0.05], [0, 0, 0], 10).cil(0.06, 0.06, 0.04, 0x222428, [x, 1.34, -0.05]);
    P.caja(0.26, 0.2, 0.2, 0xe8e2d2, [0.2, 0.93, 0.18]); // vasos
    persona(P, 0x2f6f4f, 0, -0.75, 0x1b1d21);
    return P.fin();
  },
  // Frutas en canastas bajo una sombrilla grande.
  frutas() {
    const P = new Pieza();
    P.caja(1.7, 0.08, 0.9, 0xc9a26a, [0, 0.78, 0]).caja(1.6, 0.5, 0.8, 0x6b7078, [0, 0.5, 0]);
    rueda(P, -0.8, 0.0, 0.26); rueda(P, 0.8, 0.0, 0.26);
    const frutas = [0xd8402c, 0xf2b01e, 0x7cb342, 0xf28a1e, 0x8e2f77, 0xe8d24c];
    for (let i = 0; i < 6; i++) {
      const x = -0.65 + i * 0.26;
      P.cil(0.13, 0.11, 0.1, 0x8b5a2b, [x, 0.87, 0.12], [0, 0, 0], 8);
      for (let k = 0; k < 3; k++) P.esfera(0.075, frutas[i], [x + (k - 1) * 0.06, 0.97 + (k % 2) * 0.05, 0.12 + (k % 2) * 0.03], 6);
    }
    sombrilla(P, 0xe03a2f, 0xf4f0e6, 2.3, 1.3);
    persona(P, 0xe3d9c3, 0.2, -0.8, null, 0xa5714f);
    return P.fin();
  },
  // Obleas: el disco grande de oblea en el carrito y frascos de arequipe y mermelada.
  obleas() {
    const P = new Pieza();
    P.caja(0.9, 0.8, 0.55, 0xd9b36a, [0, 0.4, 0]).caja(1.0, 0.05, 0.65, 0xefe3c3, [0, 0.83, 0]);
    rueda(P, -0.5, 0.05); rueda(P, 0.5, 0.05);
    P.cil(0.42, 0.42, 0.03, 0xe9d3a0, [0, 1.05, -0.05], [-0.9, 0, 0], 16); // la oblea
    for (const [x, c] of [[-0.3, 0xd9a21b], [-0.1, 0xb23a48], [0.1, 0x7a4a2b], [0.3, 0xe86f4d]]) P.cil(0.05, 0.05, 0.1, c, [x, 0.91, 0.22], [0, 0, 0], 8);
    sombrilla(P, 0x2f80b8, 0xf4f0e6, 2.2, 1.15);
    persona(P, 0xd6643b, 0, -0.7, 0xf0efe8);
    return P.fin();
  },
  // Mazorca asada en un tambor con brasas.
  mazorca() {
    const P = new Pieza();
    P.caja(0.9, 0.06, 0.6, 0x555a60, [0, 0.8, 0]).caja(0.1, 0.8, 0.1, 0x3a3d42, [-0.38, 0.4, 0.2]).caja(0.1, 0.8, 0.1, 0x3a3d42, [0.38, 0.4, 0.2]).caja(0.1, 0.8, 0.1, 0x3a3d42, [-0.38, 0.4, -0.2]).caja(0.1, 0.8, 0.1, 0x3a3d42, [0.38, 0.4, -0.2]);
    P.cil(0.3, 0.27, 0.3, 0x2a2c30, [0.1, 0.98, 0], [0, 0, 0], 12).cil(0.26, 0.26, 0.02, 0xd4541a, [0.1, 1.13, 0], [0, 0, 0], 12);
    for (let i = 0; i < 6; i++) P.cil(0.045, 0.04, 0.24, i % 2 ? 0xe4b72a : 0xcf9a1c, [-0.18 + i * 0.07, 1.2, (i % 2) * 0.06 - 0.03], [0, 0, 1.45], 6);
    for (let i = 0; i < 3; i++) P.cil(0.04, 0.035, 0.22, 0xf0d060, [-0.3 + i * 0.12, 0.88, 0.22], [0, 0, 1.45], 6);
    rueda(P, -0.55, 0);
    sombrilla(P, 0xf2c200, 0xd8402c, 2.2, 1.15);
    persona(P, 0xb02a2a, 0, -0.75, 0xf0efe8);
    return P.fin();
  },
  // Chaza de dulces y minutos: caseta con mostrador, dulces en estantes y un teléfono en un tubo.
  chaza() {
    const P = new Pieza();
    P.caja(1.7, 0.9, 0.9, 0x2d6fb5, [0, 0.45, 0]); // mostrador
    P.caja(1.8, 0.05, 1.0, 0xe9e2d0, [0, 0.92, 0]);
    P.caja(0.05, 2.1, 0.05, 0x5a5f66, [-0.85, 1.05, -0.4]).caja(0.05, 2.1, 0.05, 0x5a5f66, [0.85, 1.05, -0.4]).caja(0.05, 1.7, 0.05, 0x5a5f66, [-0.85, 0.85, 0.42]).caja(0.05, 1.7, 0.05, 0x5a5f66, [0.85, 0.85, 0.42]);
    P.caja(1.9, 0.04, 1.2, 0xf2c200, [0, 2.0, 0.0], [0.12, 0, 0]); // toldo
    P.caja(1.7, 0.9, 0.04, 0x39414a, [0, 1.45, -0.42]); // panel de atrás
    const dulces = [0xd8402c, 0xf2b01e, 0x2fa05a, 0x2f80b8, 0xc2418f, 0xf28a1e];
    for (let i = 0; i < 12; i++) P.caja(0.14, 0.2, 0.06, dulces[i % 6], [-0.7 + (i % 6) * 0.28, 1.15 + Math.floor(i / 6) * 0.3, -0.37]);
    for (let i = 0; i < 5; i++) P.caja(0.2, 0.1, 0.12, dulces[(i + 2) % 6], [-0.6 + i * 0.3, 1.0, 0.25]);
    P.cil(0.025, 0.025, 1.1, 0x3b3f45, [0.55, 1.5, 0.3], [0, 0, 0], 6).caja(0.16, 0.1, 0.1, 0xd8402c, [0.55, 2.0, 0.3]).caja(0.5, 0.3, 0.04, 0xf2c200, [-0.45, 1.75, 0.44]); // teléfono y aviso de minutos
    persona(P, 0x3d3f8f, -0.3, -0.1, null, 0xc09672);
    return P.fin();
  },
  // Empanadas: vitrina caliente con su calentador y la sombrilla.
  empanadas() {
    const P = new Pieza();
    P.caja(1.1, 0.8, 0.6, 0xc8ccd0, [0, 0.4, 0]).caja(1.0, 0.45, 0.5, 0xbfd8e6, [0, 1.03, 0]).caja(0.9, 0.12, 0.4, 0xe2a53a, [0, 0.92, 0]);
    for (let i = 0; i < 5; i++) P.cil(0.07, 0.07, 0.05, 0xd89a2e, [-0.32 + i * 0.16, 1.0, 0.0], [0, 0, 0], 6);
    rueda(P, -0.6, 0.05); rueda(P, 0.6, 0.05);
    P.cil(0.1, 0.1, 0.25, 0x3e8f4d, [0.5, 1.4, 0], [0, 0, 0], 8); // el recipiente de ají
    sombrilla(P, 0xd8402c, 0xf2c200, 2.2, 1.15);
    persona(P, 0x5b8f3a, 0.1, -0.8, 0x1b1d21, 0xa5714f);
    return P.fin();
  },
};

// Lugares: (lat, lon), radio de búsqueda en m y cuántos de cada tipo. `plaza` se coloca dentro de la plaza.
const PUESTOS = [
  { lugar: 'Séptima', ll: [4.5997, -74.0752], radio: 330, tipos: { tinto: 5, frutas: 2, chaza: 3, empanadas: 2 } },
  { lugar: 'Plaza de Bolívar', plaza: true, tipos: { mazorca: 4, tinto: 2, obleas: 2 } },
  { lugar: 'Parque Santander', xz: [352, -380], radio: 90, tipos: { tinto: 2, frutas: 1, obleas: 1, chaza: 2 } },
  { lugar: 'Chorro de Quevedo', xz: [703, 103], radio: 90, tipos: { tinto: 1, obleas: 1, empanadas: 2 } },
  { lugar: 'Eje Ambiental', ll: [4.6013, -74.0735], radio: 260, tipos: { tinto: 2, frutas: 1, obleas: 2, empanadas: 1 } },
  { lugar: 'San Victorino', ll: [4.6030, -74.0806], radio: 200, tipos: { tinto: 2, frutas: 4, chaza: 3, empanadas: 1 } },
];

// ---------------------------------------------------------------------------------------------------------------
// Mobiliario fijo.
// ---------------------------------------------------------------------------------------------------------------
const FIJOS = {
  caneca: { r: 0.3, geo: () => new Pieza().cil(0.26, 0.22, 0.85, 0x2f6d46, [0, 0.45, 0], [0, 0, 0], 10).cil(0.28, 0.28, 0.06, 0x24523a, [0, 0.9, 0], [0, 0, 0], 10).caja(0.2, 0.08, 0.02, 0x101214, [0, 0.7, 0.26]).fin() },
  banca: { r: 0.6, geo: () => new Pieza().caja(1.7, 0.07, 0.48, 0x7a4a2b, [0, 0.46, 0]).caja(1.7, 0.4, 0.05, 0x7a4a2b, [0, 0.78, -0.22], [-0.15, 0, 0])
    .caja(0.08, 0.46, 0.5, 0x4a4d52, [-0.75, 0.23, 0]).caja(0.08, 0.46, 0.5, 0x4a4d52, [0.75, 0.23, 0]).fin() },
  bolardo: { r: 0.15, geo: () => new Pieza().cil(0.09, 0.1, 0.8, 0x8a8d92, [0, 0.4, 0], [0, 0, 0], 8).esfera(0.095, 0x8a8d92, [0, 0.8, 0], 8).cil(0.102, 0.102, 0.1, 0xf2c200, [0, 0.66, 0], [0, 0, 0], 8).fin() },
  hidrante: { r: 0.25, geo: () => new Pieza().cil(0.13, 0.15, 0.6, 0xc8302a, [0, 0.3, 0], [0, 0, 0], 8).esfera(0.13, 0xc8302a, [0, 0.62, 0]).cil(0.05, 0.05, 0.4, 0xb02722, [0, 0.45, 0], [0, 0, Math.PI / 2], 6).cil(0.08, 0.08, 0.1, 0xf2c200, [0, 0.22, 0], [0, 0, 0], 8).fin() },
  // Señales: poste gris con la placa de frente (+z).
  pare: { r: 0.12, geo: () => señal((P) => P.cil(0.34, 0.34, 0.025, 0xc8302a, [0, 2.4, 0.04], [Math.PI / 2, Math.PI / 8, 0], 8).cil(0.27, 0.27, 0.01, 0xf2efe6, [0, 2.4, 0.055], [Math.PI / 2, Math.PI / 8, 0], 8)) },
  velocidad: { r: 0.12, geo: () => señal((P) => P.cil(0.3, 0.3, 0.025, 0xc8302a, [0, 2.4, 0.04], [Math.PI / 2, 0, 0], 16).cil(0.23, 0.23, 0.01, 0xf2efe6, [0, 2.4, 0.055], [Math.PI / 2, 0, 0], 16).caja(0.18, 0.2, 0.01, 0x1a1c20, [0, 2.4, 0.065])) },
  prohibido: { r: 0.12, geo: () => señal((P) => P.cil(0.3, 0.3, 0.025, 0x1f4f9e, [0, 2.4, 0.04], [Math.PI / 2, 0, 0], 16).caja(0.07, 0.5, 0.01, 0xc8302a, [0, 2.4, 0.055], [0, 0, 0.78]).caja(0.07, 0.5, 0.01, 0xc8302a, [0, 2.4, 0.056], [0, 0, -0.78])) },
  ceda: { r: 0.12, geo: () => señal((P) => P.cil(0.4, 0.4, 0.025, 0xc8302a, [0, 2.38, 0.04], [Math.PI / 2, Math.PI, 0], 3).cil(0.25, 0.25, 0.01, 0xf2efe6, [0, 2.36, 0.055], [Math.PI / 2, Math.PI, 0], 3)) },
  // Paradero del SITP: techo, panel azul de atrás, banca, y el poste con la señal azul y roja.
  paradero: { r: 1.4, geo: () => {
    const P = new Pieza();
    P.caja(3.2, 0.1, 1.5, 0x3a3f46, [0, 2.5, 0]).caja(3.3, 0.04, 1.6, 0x1f6fb5, [0, 2.57, 0]);
    P.caja(0.08, 2.5, 0.08, 0x4a4d52, [-1.5, 1.25, -0.6]).caja(0.08, 2.5, 0.08, 0x4a4d52, [1.5, 1.25, -0.6]);
    P.caja(3.0, 1.5, 0.04, 0x9fc3d6, [0, 1.5, -0.7]).caja(3.0, 0.3, 0.05, 0x1f6fb5, [0, 0.45, -0.7]);
    P.caja(2.4, 0.06, 0.4, 0x7a4a2b, [0, 0.5, -0.45]).caja(0.06, 0.5, 0.36, 0x4a4d52, [-1.0, 0.25, -0.45]).caja(0.06, 0.5, 0.36, 0x4a4d52, [1.0, 0.25, -0.45]);
    P.cil(0.04, 0.04, 3.0, 0x6f7378, [1.9, 1.5, 0.5], [0, 0, 0], 6).cil(0.32, 0.32, 0.03, 0x1f6fb5, [1.9, 2.9, 0.52], [Math.PI / 2, 0, 0], 16).caja(0.38, 0.1, 0.012, 0xc8302a, [1.9, 2.9, 0.54]);
    return P.fin();
  } },
};
function señal(placa) {
  const P = new Pieza();
  P.cil(0.035, 0.035, 2.5, 0x6f7378, [0, 1.25, 0], [0, 0, 0], 6);
  placa(P);
  return P.fin();
}

// Placa de nomenclatura: poste corto con la placa azul de borde blanco (texto de la textura de atlas).
const TEXTOS_PLACA = ['CL 12', 'KR 7', 'CL 13', 'KR 5', 'AV 19', 'CL 11', 'KR 10', 'DG 15'];
function atlasPlacas() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 32 * TEXTOS_PLACA.length;
  const g = c.getContext('2d');
  TEXTOS_PLACA.forEach((t, i) => {
    g.fillStyle = '#1f5fa8'; g.fillRect(0, i * 32, 256, 32);
    g.strokeStyle = '#f2f4f6'; g.lineWidth = 3; g.strokeRect(3, i * 32 + 3, 250, 26);
    g.fillStyle = '#f2f4f6'; g.font = 'bold 21px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(t, 128, i * 32 + 17);
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

// Avisos de vallas y pantallas: dibujos y lemas inventados (sin marcas reales).
const AVISOS = [
  ['#f2b01e', '#c8302a', 'BOGOTÁ LATE'], ['#2f80b8', '#9fd0ea', 'AQUÍ VA TU AVISO'], ['#3e8f4d', '#d7ecc9', 'MÁS ÁRBOLES, MÁS CIUDAD'],
  ['#8e2f77', '#f0c3e3', 'TINTO CALIENTE 24 HORAS'], ['#d8402c', '#fbe0a8', 'LA CIUDAD NO PARA'], ['#1f3550', '#9bb7d6', 'VIAJA POR LA CIUDAD'],
];
function atlasAvisos(ancho, alto, cuantos, lateral = true) {
  const c = document.createElement('canvas');
  c.width = lateral ? ancho * cuantos : ancho; c.height = lateral ? alto : alto * cuantos;
  const g = c.getContext('2d');
  for (let i = 0; i < cuantos; i++) {
    const [a, b, texto] = AVISOS[i % AVISOS.length], ox = lateral ? i * ancho : 0, oy = lateral ? 0 : i * alto;
    const gr = g.createLinearGradient(ox, oy, ox + ancho, oy + alto);
    gr.addColorStop(0, a); gr.addColorStop(1, b);
    g.fillStyle = gr; g.fillRect(ox, oy, ancho, alto);
    g.fillStyle = 'rgba(255,255,255,0.18)';
    for (let k = 0; k < 5; k++) { g.beginPath(); g.arc(ox + ancho * (0.1 + 0.2 * k), oy + alto * (0.2 + 0.5 * ((k * 7) % 3) / 2), alto * 0.22, 0, 7); g.fill(); }
    g.fillStyle = '#fff'; g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = alto * 0.03;
    g.font = `bold ${alto * 0.16}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.strokeText(texto, ox + ancho / 2, oy + alto * 0.5); g.fillText(texto, ox + ancho / 2, oy + alto * 0.5);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

// ---------------------------------------------------------------------------------------------------------------
export function crearMobiliario({ vias, calles, choques, lugares }) {
  const grupo = new THREE.Group();
  grupo.name = 'Mobiliario';
  const sitios = Object.fromEntries([...Object.keys(FIJOS), 'placa', 'valla', 'led', ...Object.keys(VENDEDORES)].map((k) => [k, []]));
  const prueba = { x: 0, z: 0 }, usados = new Set();
  // Pone una pieza si cabe: fuera de edificios y de otros postes. Devuelve si la puso.
  const poner = (tipo, x, z, rumbo, radio, extra = {}) => {
    const k = llave(x, z);
    if (usados.has(k)) return false;
    prueba.x = x; prueba.z = z;
    if (choques.empujar(prueba, Math.max(radio, 0.3))) return false;
    usados.add(k);
    choques.agregar([x, z, radio]);
    sitios[tipo].push({ x, y: calles.piso(x, z), z, rumbo, ...extra });
    return true;
  };

  // --- A lo largo de las vías con andén ---
  let semilla = 0;
  const PASO = [0, 26, 24, 20]; // clases 1 a 3 (las troncales llevan TransMilenio y casi no tienen andén)
  const nodos = new Map();
  vias.forEach((via, vi) => {
    const { clase, p } = via;
    if (via.bus || clase > 3) return;
    const w = anchoVia(via) / 2, an = andenVia(via);
    for (const q of [p[0], p.at(-1)]) {
      const n = nodos.get(llave(q[0], q[1])) ?? nodos.set(llave(q[0], q[1]), { x: q[0], z: q[1], n: 0, r: 0, dx: 0, dz: 0, clase }).get(llave(q[0], q[1]));
      n.n++; n.r = Math.max(n.r, w + an);
      if (n.n === 1) { const o = q === p[0] ? p[1] : p.at(-2); const l = Math.hypot(o[0] - q[0], o[1] - q[1]) || 1; n.dx = (o[0] - q[0]) / l; n.dz = (o[1] - q[1]) / l; }
    }
    if (!an) return;
    const paso = PASO[clase] || 24;
    let prox = 6 + azar(vi) * paso, hecho = 0;
    for (let i = 0; i < p.length - 1; i++) {
      const [ax, az] = p[i], [bx, bz] = p[i + 1], dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz);
      if (l < 0.1) continue;
      const ux = dx / l, uz = dz / l, nx = -uz, nz = ux;
      for (; prox <= hecho + l; prox += paso * (0.8 + azar(semilla++) * 0.5)) {
        const d = prox - hecho, lado = azar(semilla++) < 0.5 ? 1 : -1, r = azar(semilla++);
        const cx = ax + ux * d, cz = az + uz * d;
        // Rumbo hacia la calle: el frente de la pieza (+z) mira al eje de la vía.
        const rumbo = Math.atan2(-nx * lado, -nz * lado);
        const medio = w + an * 0.5, borde = w + an - 0.35, junto = w + 0.45;
        if (r < 0.2) poner('caneca', cx + nx * lado * borde, cz + nz * lado * borde, rumbo, 0.3);
        else if (r < 0.31) poner('banca', cx + nx * lado * (medio + 0.2), cz + nz * lado * (medio + 0.2), rumbo + Math.PI, 0.6);
        else if (r < 0.46) { // línea de bolardos junto al bordillo
          for (let k = 0; k < 3; k++) poner('bolardo', cx + ux * (k - 1) * 1.6 + nx * lado * junto, cz + uz * (k - 1) * 1.6 + nz * lado * junto, 0, 0.15);
        } else if (r < 0.57) poner(['pare', 'velocidad', 'prohibido', 'ceda'][Math.floor(azar(semilla++) * 4)], cx + nx * lado * junto, cz + nz * lado * junto, rumbo + Math.PI + (azar(semilla++) - 0.5) * 0.5, 0.12);
        else if (r < 0.63) poner('hidrante', cx + nx * lado * (w + 0.8), cz + nz * lado * (w + 0.8), rumbo, 0.25);
        else if (r < 0.655 && clase <= 2 && an >= 3) poner('paradero', cx + nx * lado * (w + an * 0.62), cz + nz * lado * (w + an * 0.62), rumbo, 1.4, { l: d });
      }
      hecho += l;
    }
  });

  // --- Placas de nomenclatura en los cruces: en la esquina, sobre el andén ---
  let np = 0;
  for (const n of nodos.values()) {
    if (n.n < 3 || azar(n.x * 0.13 + n.z * 0.71) > 0.55 || np > 1400) continue;
    const ang = azar(n.x + n.z) * 6.283, rr = n.r + 0.4;
    // Esquina: en diagonal a las vías que llegan, a una distancia que cae sobre el andén.
    const x = n.x + Math.cos(ang) * rr * 1.05, z = n.z + Math.sin(ang) * rr * 1.05;
    if (calles.dentro(x, z, 0.3)) continue;
    if (poner('placa', x, z, Math.atan2(-Math.cos(ang), -Math.sin(ang)), 0.1, { celda: Math.floor(azar(n.x * 3.1 + n.z) * TEXTOS_PLACA.length) })) np++;
  }

  // --- Vallas en las avenidas, y las dos pantallas LED ---
  const vallaEn = (via, d, lado, tipo, extra) => {
    let hecho = 0;
    for (let i = 0; i < via.p.length - 1; i++) {
      const [ax, az] = via.p[i], [bx, bz] = via.p[i + 1], l = Math.hypot(bx - ax, bz - az);
      if (l > 0 && d <= hecho + l) {
        const t = d - hecho, ux = (bx - ax) / l, uz = (bz - az) / l, nx = -uz * lado, nz = ux * lado;
        const off = anchoVia(via) / 2 + andenVia(via) + 1.6;
        return poner(tipo, ax + ux * t + nx * off, az + uz * t + nz * off, Math.atan2(-nx, -nz), 0.3, extra);
      }
      hecho += l;
    }
    return false;
  };
  const largo = (v) => v.p.slice(1).reduce((s, q, i) => s + Math.hypot(q[0] - v.p[i][0], q[1] - v.p[i][1]), 0);
  let nv = 0;
  vias.forEach((via, vi) => {
    if (via.bus || via.clase > 1 || nv > 160) return;
    const L = largo(via);
    if (L < 70) return;
    if (azar(vi * 1.7) < 0.35 && vallaEn(via, L * (0.3 + azar(vi) * 0.4), azar(vi + 5) < 0.5 ? 1 : -1, 'valla', { celda: Math.floor(azar(vi * 9.1) * AVISOS.length) })) nv++;
  });
  // Pantallas LED: la avenida principal más cercana a San Victorino y al Eje Ambiental.
  for (const ll of [[4.6030, -74.0806], [4.6006, -74.0729]]) {
    const [tx, tz] = aMundo(ll[1], ll[0]);
    let mejor = null, dmin = 400;
    vias.forEach((via) => {
      if (via.bus || via.clase > 1) return;
      const L = largo(via);
      for (let d = 15; d < L - 15; d += 12) {
        let hecho = 0;
        for (let i = 0; i < via.p.length - 1; i++) {
          const [ax, az] = via.p[i], [bx, bz] = via.p[i + 1], l = Math.hypot(bx - ax, bz - az);
          if (l > 0 && d <= hecho + l) {
            const t = (d - hecho) / l, dd = Math.hypot(ax + (bx - ax) * t - tx, az + (bz - az) * t - tz);
            if (dd < dmin) { dmin = dd; mejor = [via, d]; }
            break;
          }
          hecho += l;
        }
      }
    });
    if (mejor) for (const lado of [1, -1]) if (vallaEn(mejor[0], mejor[1], lado, 'led', {})) break;
  }

  // --- Vendedores ---
  const vendedores = [];
  const lugarXZ = (c) => c.xz ?? aMundo(c.ll[1], c.ll[0]);
  const vecinoCalle = (x, z, radio) => {
    // Puntos de aceras y peatonales cerca de (x, z): cada 7 m a un lado y otro, de cara al eje de la vía.
    const c = [];
    for (const via of vias) {
      if (via.bus || via.clase > 5) continue;
      const w = anchoVia(via) / 2, an = andenVia(via);
      for (let i = 0; i < via.p.length - 1; i++) {
        const [ax, az] = via.p[i], [bx, bz] = via.p[i + 1], l = Math.hypot(bx - ax, bz - az);
        if (l < 0.5 || Math.hypot((ax + bx) / 2 - x, (az + bz) / 2 - z) > radio + l) continue;
        const ux = (bx - ax) / l, uz = (bz - az) / l;
        for (let s = 3; s < l; s += 7) for (const lado of [1, -1]) {
          const off = an ? w + an * 0.55 : w * 0.55, px = ax + ux * s - uz * lado * off, pz = az + uz * s + ux * lado * off;
          if (Math.hypot(px - x, pz - z) <= radio) c.push({ x: px, z: pz, rumbo: Math.atan2(uz * lado, -ux * lado), clase: via.clase });
        }
      }
    }
    return c;
  };
  for (const lugar of PUESTOS) {
    let candidatos;
    if (lugar.plaza) {
      const [cx, cz] = lugares.centroPlaza;
      candidatos = [];
      for (let dx = -45; dx <= 45; dx += 6) for (let dz = -45; dz <= 45; dz += 6) candidatos.push({ x: cx + dx, z: cz + dz, rumbo: azar(dx * 7 + dz) * 6.283, clase: 5 });
    } else {
      const [x, z] = lugarXZ(lugar);
      candidatos = vecinoCalle(x, z, lugar.radio);
    }
    // Mejor las peatonales y las calles pequeñas que una avenida; se desordena con la semilla fija.
    candidatos.sort((a, b) => (a.clase >= 4 ? 0 : 1) + azar(a.x * 0.37 + a.z * 0.91) - ((b.clase >= 4 ? 0 : 1) + azar(b.x * 0.37 + b.z * 0.91)));
    const puestos = [];
    for (const [tipo, cuantos] of Object.entries(lugar.tipos)) {
      for (let k = 0, hechos = 0; hechos < cuantos && k < candidatos.length; k++) {
        const c = candidatos[k];
        if (c.usado || puestos.some((o) => Math.hypot(o.x - c.x, o.z - c.z) < 14)) continue;
        if (calles.dentro(c.x, c.z, 0.2) && !lugar.plaza) continue; // sobre la calzada no
        if (!poner(tipo, c.x, c.z, c.rumbo, 0.9)) continue;
        c.usado = true;
        puestos.push(c);
        hechos++;
      }
    }
  }

  // --- Mallas ---
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), uno = new THREE.Vector3(1, 1, 1), pos = new THREE.Vector3();
  const colocar = (im, lista, escala = 1) => {
    lista.forEach((s, i) => {
      m4.compose(pos.set(s.x, s.y, s.z), q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, s.rumbo), uno.set(escala, escala, escala));
      im.setMatrixAt(i, m4);
    });
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    return im;
  };
  const matMetal = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.25 });
  for (const [tipo, def] of Object.entries(FIJOS)) {
    if (!sitios[tipo].length) continue;
    const im = colocar(new THREE.InstancedMesh(def.geo(), matMetal, sitios[tipo].length), sitios[tipo]);
    im.castShadow = tipo === 'paradero' || tipo === 'banca';
    im.name = tipo;
    grupo.add(im);
  }
  const vend = [];
  for (const tipo of Object.keys(VENDEDORES)) {
    if (!sitios[tipo].length) continue;
    const im = colocar(new THREE.InstancedMesh(VENDEDORES[tipo](), matMetal, sitios[tipo].length), sitios[tipo]);
    im.castShadow = true;
    im.name = `vendedor-${tipo}`;
    vend.push([im, sitios[tipo].length]);
    grupo.add(im);
  }

  // Placas: poste y placa con la textura del atlas, una celda por instancia.
  const unidadPlaca = new THREE.PlaneGeometry(0.9, 0.3).translate(0, 2.55, 0.06);
  const celdaPlaca = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(sitios.placa.length, 1)), 1);
  sitios.placa.forEach((s, i) => { celdaPlaca.array[i] = s.celda; });
  unidadPlaca.setAttribute('celda', celdaPlaca);
  if (sitios.placa.length) {
    const poste = new THREE.InstancedMesh(new Pieza().cil(0.035, 0.035, 2.6, 0x6f7378, [0, 1.3, 0], [0, 0, 0], 6).caja(0.95, 0.35, 0.05, 0xdfe3e6, [0, 2.55, 0.0]).fin(), matMetal, sitios.placa.length);
    const mp = new THREE.MeshStandardNodeMaterial({ roughness: 0.5, metalness: 0.1, side: THREE.DoubleSide });
    const t = atlasPlacas();
    // Cada cara con su celda del atlas (alto de una celda: 1 / cuántos textos).
    mp.colorNode = texture(t, vec2(uv().x, uv().y.div(TEXTOS_PLACA.length).add(float(1).sub(attribute('celda', 'float').add(1).div(TEXTOS_PLACA.length)))));
    const placas = new THREE.InstancedMesh(unidadPlaca, mp, sitios.placa.length);
    colocar(poste, sitios.placa); colocar(placas, sitios.placa);
    grupo.add(poste, placas);
  }

  // Vallas: estructura con dos postes y la cara con aviso. Pantallas LED: lo mismo, más grandes y emisivas.
  const cuadro = (ancho, alto, y) => new Pieza().caja(ancho + 0.3, alto + 0.3, 0.25, 0x30343a, [0, y, 0]).cil(0.1, 0.12, y - alto / 2, 0x4a4d52, [-ancho * 0.3, (y - alto / 2) / 2, 0], [0, 0, 0], 6).cil(0.1, 0.12, y - alto / 2, 0x4a4d52, [ancho * 0.3, (y - alto / 2) / 2, 0], [0, 0, 0], 6).fin();
  const tiempoLED = uniform(0);
  if (sitios.valla.length) {
    const estructura = colocar(new THREE.InstancedMesh(cuadro(6, 3, 6.4), matMetal, sitios.valla.length), sitios.valla);
    const cara = new THREE.PlaneGeometry(6, 3).translate(0, 6.4, 0.14);
    const cel = new THREE.InstancedBufferAttribute(new Float32Array(sitios.valla.length), 1);
    sitios.valla.forEach((s, i) => { cel.array[i] = s.celda; });
    cara.setAttribute('celda', cel);
    const mv = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, side: THREE.DoubleSide });
    const tex = atlasAvisos(512, 256, AVISOS.length, false);
    const col = texture(tex, vec2(uv().x, uv().y.div(AVISOS.length).add(float(1).sub(attribute('celda', 'float').add(1).div(AVISOS.length)))));
    mv.colorNode = col;
    mv.emissiveNode = col.rgb.mul(noche.mul(0.55)); // valla iluminada
    grupo.add(estructura, colocar(new THREE.InstancedMesh(cara, mv, sitios.valla.length), sitios.valla));
  }
  if (sitios.led.length) {
    const estructura = colocar(new THREE.InstancedMesh(cuadro(9, 5, 8.5), matMetal, sitios.led.length), sitios.led);
    const cara = new THREE.PlaneGeometry(9, 5).translate(0, 8.5, 0.14);
    const ml = new THREE.MeshStandardNodeMaterial({ roughness: 0.4, side: THREE.FrontSide });
    const tex = atlasAvisos(512, 288, 3, true), cuadroActual = floor(mod(tiempoLED.div(5), 3));
    const col = texture(tex, vec2(uv().x.add(cuadroActual).div(3), uv().y));
    // Brilla siempre un poco y mucho más de noche, por encima del umbral del bloom.
    ml.colorNode = col.rgb.mul(0.35);
    ml.emissiveNode = col.rgb.mul(noche.mul(2.2).add(0.7));
    grupo.add(estructura, colocar(new THREE.InstancedMesh(cara, ml, sitios.led.length), sitios.led));
  }

  let reloj = 0;
  const hayVendedores = (hora) => hora >= 5.5 && hora < 20.5;
  // Los vendedores desaparecen de noche (dejan de dibujarse). La pantalla pasa de aviso cada 5 s.
  function actualizar(dt, hora) {
    reloj += dt;
    tiempoLED.value = reloj;
    const dia = hayVendedores(((hora % 24) + 24) % 24);
    for (const [im, n] of vend) im.count = dia ? n : 0;
  }

  const total = Object.values(sitios).reduce((s, l) => s + l.length, 0);
  return { grupo, actualizar, sitios, total };
}
