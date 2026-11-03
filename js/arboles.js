import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { cargarBinario } from './binario.js';

const Q = 0.5;
const CELDA = 500;
export const FORMAS = ['copa', 'conifera', 'palma', 'eucalipto', 'arbusto'];

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

const pintar = (g, color) => {
  const c = new THREE.Color(color), n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
};
const pieza = (g, color, y, sx = 1, sy = 1, sz = 1) => {
  g = g.index ? g.toNonIndexed() : g;
  g.scale(sx, sy, sz);
  g.translate(0, y, 0);
  g.deleteAttribute('uv');
  return pintar(g, color);
};

// Geometrías de altura 1: la instancia las escala a la altura real del árbol.
function geometria(forma) {
  const tronco = 0x5b4636;
  switch (forma) {
    case 1: return mergeGeometries([pieza(new THREE.CylinderGeometry(0.02, 0.03, 0.3, 5), tronco, 0.15),
      pieza(new THREE.ConeGeometry(0.17, 0.85, 7), 0x2f4a2e, 0.55)]);
    case 2: return mergeGeometries([pieza(new THREE.CylinderGeometry(0.015, 0.025, 0.85, 5), 0x7a6a55, 0.42),
      pieza(new THREE.IcosahedronGeometry(0.16, 0), 0x52703a, 0.9, 1.3, 0.45, 1.3)]);
    case 3: return mergeGeometries([pieza(new THREE.CylinderGeometry(0.015, 0.03, 0.55, 5), 0xa89c8a, 0.27),
      pieza(new THREE.IcosahedronGeometry(0.17, 0), 0x6b7d5a, 0.7, 0.9, 1.6, 0.9)]);
    case 4: return mergeGeometries([pieza(new THREE.IcosahedronGeometry(0.5, 0), 0x4f6a36, 0.45, 1, 0.9, 1)]);
    default: return mergeGeometries([pieza(new THREE.CylinderGeometry(0.025, 0.04, 0.45, 5), tronco, 0.22),
      pieza(new THREE.IcosahedronGeometry(0.3, 0), 0x46663a, 0.68, 1, 0.85, 1)]);
  }
}

export function mallasArboles(lista, terreno, excluir = () => false) {
  const grupo = new THREE.Group();
  grupo.name = 'Arboles';
  const material = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });
  const geos = FORMAS.map((_, f) => geometria(f));
  const celdas = new Map();
  for (const a of lista) {
    if (excluir(a)) continue;
    const llave = `${Math.floor(a.x / CELDA)},${Math.floor(a.z / CELDA)},${a.forma}`;
    if (!celdas.has(llave)) celdas.set(llave, []);
    celdas.get(llave).push(a);
  }
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const eje = new THREE.Vector3(0, 1, 0), tinte = new THREE.Color();
  for (const [llave, arboles] of celdas) {
    const forma = Number(llave.split(',')[2]);
    const malla = new THREE.InstancedMesh(geos[forma], material, arboles.length);
    arboles.forEach((a, i) => {
      const h = Math.max(1, a.alt), r = ((a.x * 13.7 + a.z * 7.3) % 1 + 1) % 1;
      const ancho = forma === 4 ? Math.min(h, 2.5) : h * (0.8 + r * 0.4);
      q.setFromAxisAngle(eje, r * Math.PI * 2);
      malla.setMatrixAt(i, m4.compose(p.set(a.x, terreno.altura(a.x, a.z) - 0.2, a.z), q, s.set(ancho, h, ancho)));
      malla.setColorAt(i, tinte.setHSL(0.25 + r * 0.06, 0.25, 0.85 + r * 0.3));
    });
    malla.computeBoundingSphere();
    malla.castShadow = forma !== 4;
    malla.receiveShadow = true;
    grupo.add(malla);
  }
  return grupo;
}
