import * as THREE from 'three/webgpu';
import { cargarBinario } from './binario.js';

// Malla de alturas (Copernicus GLO-30 suavizado). y = altura sobre la Plaza de Bolívar.
export async function cargarTerreno(url) {
  const [meta, alturas] = await cargarBinario(url, 'BOT1');
  const cols = meta.uint(), filas = meta.uint(), paso = meta.uint();
  const ox = -meta.uint(), oz = -meta.uint(), base = meta.uint();
  const h = new Float32Array(cols * filas);
  for (let j = 0; j < filas; j++) {
    let v = 0;
    for (let i = 0; i < cols; i++) { v += alturas.int(); h[j * cols + i] = v * 0.25; }
  }

  const altura = (x, z) => {
    const fx = Math.min(cols - 1.001, Math.max(0, (x - ox) / paso));
    const fz = Math.min(filas - 1.001, Math.max(0, (z - oz) / paso));
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
    const a = h[j * cols + i], b = h[j * cols + i + 1], c = h[(j + 1) * cols + i], d = h[(j + 1) * cols + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  };

  // Explanada bajo una planta (la cima de Monserrate, Guadalupe): los puntos de adentro quedan a la altura y,
  // y los de una franja de `margen` metros alrededor se mezclan con el relieve original. Llamar antes de armar la malla.
  const aplanar = (anillo, y, margen = paso * 1.5) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of anillo) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const i0 = Math.max(0, Math.floor((x0 - margen - ox) / paso)), i1 = Math.min(cols - 1, Math.ceil((x1 + margen - ox) / paso));
    const j0 = Math.max(0, Math.floor((z0 - margen - oz) / paso)), j1 = Math.min(filas - 1, Math.ceil((z1 + margen - oz) / paso));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const p = [ox + i * paso, oz + j * paso];
      const d = dentro(p, anillo) ? 0 : distancia(p, anillo);
      if (d > margen) continue;
      const k = j * cols + i, t = 1 - d / margen;
      h[k] += (y - h[k]) * t * t * (3 - 2 * t);
    }
  };

  return { cols, filas, paso, ox, oz, base, h, altura, aplanar, ancho: (cols - 1) * paso, largo: (filas - 1) * paso };
}

function dentro([x, z], anillo) {
  let d = false;
  for (let i = 0, j = anillo.length - 1; i < anillo.length; j = i++) {
    const [xi, zi] = anillo[i], [xj, zj] = anillo[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) d = !d;
  }
  return d;
}

function distancia([x, z], anillo) {
  let m = Infinity;
  for (let i = 0, j = anillo.length - 1; i < anillo.length; j = i++) {
    const [ax, az] = anillo[j], [bx, bz] = anillo[i], dx = bx - ax, dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    m = Math.min(m, Math.hypot(x - ax - dx * t, z - az - dz * t));
  }
  return m;
}

// Colores del suelo según altura y pendiente: sabana urbana, potreros y cerros de bosque.
const C_CIUDAD = new THREE.Color(0x8d877b), C_PASTO = new THREE.Color(0x7d8a52);
const C_BOSQUE = new THREE.Color(0x3d5530), C_PARAMO = new THREE.Color(0x6f7350), C_ROCA = new THREE.Color(0x7a7166);

export function mallaTerreno(t, texturaSuelo, cajaSuelo) {
  const { cols, filas, paso, ox, oz, h } = t;
  const pos = new Float32Array(cols * filas * 3), col = new Float32Array(cols * filas * 3), uv = new Float32Array(cols * filas * 2);
  const c = new THREE.Color();
  for (let j = 0; j < filas; j++) for (let i = 0; i < cols; i++) {
    const k = j * cols + i, x = ox + i * paso, z = oz + j * paso, y = h[k];
    pos.set([x, y, z], k * 3);
    const dx = h[j * cols + Math.min(cols - 1, i + 1)] - h[j * cols + Math.max(0, i - 1)];
    const dz = h[Math.min(filas - 1, j + 1) * cols + i] - h[Math.max(0, j - 1) * cols + i];
    const pendiente = Math.hypot(dx, dz) / (2 * paso);
    // La sabana está a ~0 m; los cerros suben hasta ~+800 m.
    if (y < 25 && pendiente < 0.08) c.copy(C_CIUDAD);
    else if (y < 120) c.copy(C_PASTO).lerp(C_BOSQUE, Math.min(1, pendiente * 2));
    else if (y < 700) c.copy(C_BOSQUE);
    else c.copy(C_BOSQUE).lerp(C_PARAMO, Math.min(1, (y - 700) / 200));
    if (pendiente > 0.9) c.lerp(C_ROCA, 0.5);
    col.set([c.r, c.g, c.b], k * 3);
    uv.set([(x - cajaSuelo.x0) / (cajaSuelo.x1 - cajaSuelo.x0), (z - cajaSuelo.z0) / (cajaSuelo.z1 - cajaSuelo.z0)], k * 2);
  }
  const idx = [];
  for (let j = 0; j < filas - 1; j++) for (let i = 0; i < cols - 1; i++) {
    const a = j * cols + i, b = a + 1, d = a + cols, e = d + 1;
    idx.push(a, d, b, b, d, e);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
