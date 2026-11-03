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

  return { cols, filas, paso, ox, oz, base, h, altura, ancho: (cols - 1) * paso, largo: (filas - 1) * paso };
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
