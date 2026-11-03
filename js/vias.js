import * as THREE from 'three/webgpu';
import { cargarBinario } from './binario.js';

const Q = 0.5;
// troncal, principal, secundaria, local, servicio, peatonal, ciclorruta, escalera
const ANCHO = [18, 13, 9, 7, 4.5, 3, 2.5, 2.5];
const COLOR = [0x3b3c3e, 0x404143, 0x46474a, 0x4c4d50, 0x55565a, 0xa69d8f, 0x8c3f36, 0x9c958a].map((c) => new THREE.Color(c));
const ALTO = [0.5, 0.48, 0.46, 0.44, 0.42, 0.4, 0.43, 0.4];

export async function cargarLineas(url, firma) {
  const [meta, xs, zs] = await cargarBinario(url, firma);
  const n = meta.uint(), lista = new Array(n);
  let x = 0, z = 0;
  for (let k = 0; k < n; k++) {
    const clase = meta.uint(), p = [];
    for (let i = meta.uint(); i > 0; i--) { x += xs.int(); z += zs.int(); p.push([x * Q, z * Q]); }
    lista[k] = { clase, p };
  }
  return lista;
}

// Cintas apoyadas en el terreno, partidas cada 12 m para que sigan el relieve.
export function mallaVias(vias, terreno) {
  const pos = [], col = [];
  for (const { clase, p } of vias) {
    const w = ANCHO[clase] / 2, c = COLOR[clase], dy = ALTO[clase];
    for (let i = 0; i < p.length - 1; i++) {
      const [ax, az] = p[i], [bx, bz] = p[i + 1];
      const largo = Math.hypot(bx - ax, bz - az);
      if (largo < 0.01) continue;
      const nx = -(bz - az) / largo * w, nz = (bx - ax) / largo * w;
      const pasos = Math.max(1, Math.ceil(largo / 12));
      for (let s = 0; s < pasos; s++) {
        const t0 = s / pasos, t1 = (s + 1) / pasos;
        const x0 = ax + (bx - ax) * t0, z0 = az + (bz - az) * t0, x1 = ax + (bx - ax) * t1, z1 = az + (bz - az) * t1;
        const y0 = terreno.altura(x0, z0) + dy, y1 = terreno.altura(x1, z1) + dy;
        const v = [[x0 - nx, y0, z0 - nz], [x1 - nx, y1, z1 - nz], [x1 + nx, y1, z1 + nz], [x0 + nx, y0, z0 + nz]];
        for (const k of [0, 2, 1, 0, 3, 2]) { pos.push(...v[k]); col.push(c.r, c.g, c.b); }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  const m = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const malla = new THREE.Mesh(g, m);
  malla.receiveShadow = true;
  malla.name = 'Vias';
  return malla;
}

// Parques, bosques, agua y plazas pintados en un canvas que se proyecta sobre el terreno. No hay imágenes.
const COLOR_SUELO = ['#5b7a3c', '#3b5330', '#4d6a7a', '#5f8443', '#6c6b67', '#b3a892'];
export function texturaSuelo(suelo, caja, lado = 2048) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = lado;
  const ctx = canvas.getContext('2d');
  const sx = lado / (caja.x1 - caja.x0), sz = lado / (caja.z1 - caja.z0);
  for (const orden of [0, 1, 3, 4, 5, 2]) {
    for (const { clase, p } of suelo) {
      if (clase !== orden) continue;
      ctx.fillStyle = COLOR_SUELO[clase];
      ctx.beginPath();
      p.forEach(([x, z], i) => ctx[i ? 'lineTo' : 'moveTo']((x - caja.x0) * sx, (z - caja.z0) * sz));
      ctx.closePath();
      ctx.fill();
    }
  }
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.flipY = false;
  return t;
}
