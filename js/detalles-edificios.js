import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ALTURA_PISO, esColonial } from './edificios.js';

// Detalle 3D de las casas coloniales de La Candelaria que el shader de fachadas no puede dar: balcones de madera con
// baranda en el segundo piso y alero de teja de barro al borde del techo. Son dos mallas instanciadas (una instancia por
// muro), así que cuestan dos llamadas a la GPU en toda la ciudad. Los muros que dan a otra casa (medianeras) no llevan
// nada: se prueba un punto a 1,4 m por fuera del muro contra las plantas vecinas.
// Adaptado de Slop New York (mrdoob, MIT): js/building-details.js (rechazo contra vecinos y reserva en la calle).

const CELDA = 40;
const llave = (i, j) => `${i},${j}`;
const adentro = (x, z, anillo) => {
  let si = false;
  for (let i = 0, j = anillo.length - 1; i < anillo.length; j = i++) {
    const [xi, zi] = anillo[i], [xj, zj] = anillo[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) si = !si;
  }
  return si;
};
const azar = (k) => { const s = Math.sin(k * 91.7 + 17.3) * 43758.5453; return s - Math.floor(s); };

const MADERAS = [0x5a3a22, 0x3f2a1a, 0x2f5a3c, 0x7a3b2a, 0x274a73].map((c) => new THREE.Color(c));
const TEJAS = [0xa0522d, 0x9a4a28, 0xb05f35, 0x8c4326].map((c) => new THREE.Color(c));

// Balcón de 1 m de largo (se estira por instancia), 0,9 m de fondo: losa, baranda con balaustres y soportes.
function geoBalcon() {
  const partes = [];
  const caja = (w, h, d, x, y, z) => partes.push(new THREE.BoxGeometry(w, h, d).translate(x, y, z));
  caja(1, 0.1, 0.9, 0, 0, 0.45); // piso
  for (const x of [-0.46, 0.46]) caja(0.07, 0.1, 0.5, x, -0.12, 0.3); // ménsulas
  caja(1, 0.05, 0.05, 0, 0.98, 0.88); // pasamanos
  caja(0.05, 0.05, 0.9, -0.48, 0.98, 0.45); caja(0.05, 0.05, 0.9, 0.48, 0.98, 0.45);
  caja(1, 0.04, 0.04, 0, 0.2, 0.88);
  for (let i = 0; i < 11; i++) caja(0.035, 0.78, 0.035, -0.45 + i * 0.09, 0.57, 0.88);
  for (const x of [-0.48, 0.48]) for (let k = 1; k < 5; k++) caja(0.03, 0.78, 0.03, x, 0.57, 0.88 - k * 0.18);
  return mergeGeometries(partes.map((g) => { const n = g.toNonIndexed(); n.deleteAttribute('uv'); return n; }));
}
// Alero: losa inclinada de 0,7 m que sale del muro con el borde hacia abajo, y canal de remate con hileras de teja.
function geoAlero() {
  const partes = [];
  const caja = (w, h, d, x, y, z, rx = 0) => { const g = new THREE.BoxGeometry(w, h, d); g.rotateX(rx); g.translate(x, y, z); partes.push(g); };
  caja(1, 0.07, 0.75, 0, -0.1, 0.34, 0.22); // faldón
  for (let i = 0; i < 8; i++) caja(0.08, 0.05, 0.75, -0.44 + i * 0.125, -0.06, 0.34, 0.22); // hileras de teja
  caja(1, 0.09, 0.07, 0, -0.27, 0.7); // canal
  return mergeGeometries(partes.map((g) => { const n = g.toNonIndexed(); n.deleteAttribute('uv'); return n; }));
}

export function crearDetallesEdificios({ edificios, terreno, excluir = () => false }) {
  // Rejilla de plantas para saber qué hay por fuera de cada muro.
  const celdas = new Map();
  edificios.forEach((e, k) => {
    const r = e.anillos[0];
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of r) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    for (let i = Math.floor(x0 / CELDA); i <= Math.floor(x1 / CELDA); i++) for (let j = Math.floor(z0 / CELDA); j <= Math.floor(z1 / CELDA); j++) {
      const c = llave(i, j);
      (celdas.get(c) ?? celdas.set(c, []).get(c)).push(e);
    }
  });
  const ocupado = (x, z, propio) => {
    for (const e of celdas.get(llave(Math.floor(x / CELDA), Math.floor(z / CELDA))) || []) if (e !== propio && adentro(x, z, e.anillos[0])) return true;
    return false;
  };

  const balcones = [], aleros = [];
  edificios.forEach((e, k) => {
    if (!esColonial(e) || excluir(e)) return;
    let min = Infinity, max = -Infinity;
    for (const [x, z] of e.anillos[0]) { const h = terreno.altura(x, z); min = Math.min(min, h); max = Math.max(max, h); }
    const base = max + 0.45, arriba = base + e.pisos * ALTURA_PISO + 0.6;
    // Orientación del anillo: la normal hacia afuera de cada muro depende del giro.
    const r = e.anillos[0];
    let a2 = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) a2 += r[j][0] * r[i][1] - r[i][0] * r[j][1];
    const sg = a2 > 0 ? 1 : -1;
    let balcon = 0;
    for (let i = 0; i < r.length; i++) {
      const [ax, az] = r[i], [bx, bz] = r[(i + 1) % r.length], l = Math.hypot(bx - ax, bz - az);
      if (l < 3.5) continue;
      const ux = (bx - ax) / l, uz = (bz - az) / l, nx = uz * sg, nz = -ux * sg, mx = (ax + bx) / 2, mz = (az + bz) / 2;
      // Fuera del muro, a 1,4 m en el medio y a 1,4 m de cada punta: si hay otra casa, es medianera.
      if (ocupado(mx + nx * 1.4, mz + nz * 1.4, e) || ocupado(ax + ux * 0.8 + nx * 1.4, az + uz * 0.8 + nz * 1.4, e) || ocupado(bx - ux * 0.8 + nx * 1.4, bz - uz * 0.8 + nz * 1.4, e)) continue;
      const rumbo = Math.atan2(nx, nz), sa = terreno.altura(ax, az), sb = terreno.altura(bx, bz);
      aleros.push({ x: mx, y: arriba - 0.12, z: mz, rumbo, l: l + 0.3, c: Math.floor(azar(k * 7 + i) * TEJAS.length) });
      // Un balcón por casa de dos o más pisos, en el muro más largo que tenga el primer piso a su nivel.
      if (e.pisos >= 2 && balcon < 2 && l >= 5 && azar(k + i * 3) < 0.7) {
        const largo = Math.min(l - 1.6, 4.8);
        const piso = (e.pisos >= 3 ? 2 : 1) * ALTURA_PISO;
        // Si la acera baja a lo largo del muro, el balcón sigue a la parte alta (el andén más alto marca el piso).
        balcones.push({ x: mx, y: base + piso + 0.08 + Math.max(0, Math.min(sa, sb) - max) * 0, z: mz, rumbo, l: largo, c: Math.floor(azar(k * 13 + i) * MADERAS.length) });
        balcon++;
      }
    }
  });

  const grupo = new THREE.Group();
  grupo.name = 'DetallesEdificios';
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), esc = new THREE.Vector3(), col = new THREE.Color();
  const malla = (geo, lista, paleta, material) => {
    if (!lista.length) return;
    const im = new THREE.InstancedMesh(geo, material, lista.length);
    lista.forEach((s, i) => {
      m4.compose(pos.set(s.x, s.y, s.z), q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, s.rumbo), esc.set(s.l, 1, 1));
      im.setMatrixAt(i, m4);
      im.setColorAt(i, col.copy(paleta[s.c]));
    });
    im.instanceMatrix.needsUpdate = true;
    im.instanceColor.needsUpdate = true;
    im.castShadow = im.receiveShadow = true;
    im.computeBoundingSphere();
    grupo.add(im);
  };
  malla(geoBalcon(), balcones, MADERAS, new THREE.MeshStandardNodeMaterial({ roughness: 0.8 }));
  malla(geoAlero(), aleros, TEJAS, new THREE.MeshStandardNodeMaterial({ roughness: 0.75 }));
  return { grupo, cuantos: { balcones: balcones.length, aleros: aleros.length } };
}
