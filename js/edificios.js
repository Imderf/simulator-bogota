import * as THREE from 'three/webgpu';
import { attribute, vertexColor, fract, step, floor, hash, mix, vec3, float, uniform } from 'three/tsl';
import { cargarBinario } from './binario.js';

const Q = 0.5;
export const ALTURA_PISO = 3.0;
const CELDA = 400;

export async function cargarEdificios(url) {
  const [meta, xs, zs] = await cargarBinario(url, 'BOE1');
  const n = meta.uint(), lista = new Array(n);
  let x = 0, z = 0;
  for (let k = 0; k < n; k++) {
    const pisos = meta.uint(), anillos = [];
    for (let r = meta.uint(); r > 0; r--) {
      const anillo = [];
      for (let p = meta.uint(); p > 0; p--) { x += xs.int(); z += zs.int(); anillo.push([x * Q, z * Q]); }
      anillos.push(anillo);
    }
    let cx = 0, cz = 0;
    for (const [a, b] of anillos[0]) { cx += a; cz += b; }
    lista[k] = { pisos, anillos, cx: cx / anillos[0].length, cz: cz / anillos[0].length };
  }
  if (!meta.fin() || !xs.fin() || !zs.fin()) throw new Error('Datos de edificios dañados');
  return lista;
}

const area = (p) => { let a = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j][0] * p[i][1] - p[i][0] * p[j][1]; return a / 2; };
const azar = (k) => { const s = Math.sin(k * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

// Paletas: ladrillo bogotano, estuco claro, concreto y vidrio para las torres.
const LADRILLO = [0x8f4630, 0x9c5236, 0xa45e3f, 0x7f3d2b, 0xb06a48].map((c) => new THREE.Color(c));
const ESTUCO = [0xd9d0bf, 0xe4dccc, 0xcfc5b2, 0xe8e1d3].map((c) => new THREE.Color(c));
const CONCRETO = [0x9a9893, 0xa8a49b, 0x8b8a86].map((c) => new THREE.Color(c));
const VIDRIO_TORRE = [0x6d7d8c, 0x7e8b96, 0x5f6f7e].map((c) => new THREE.Color(c));
const TEJA = new THREE.Color(0xa0522d), TECHO = new THREE.Color(0x77736c);

// La Candelaria (aprox.): casas bajas blancas con techo de teja.
const enCandelaria = (x, z) => x > -150 && x < 1050 && z > -650 && z < 650;

function colores(e, k) {
  const r = azar(k);
  if (e.pisos <= 3 && enCandelaria(e.cx, e.cz)) return [ESTUCO[Math.floor(r * ESTUCO.length)], TEJA];
  if (e.pisos >= 20) return [r < 0.5 ? VIDRIO_TORRE[Math.floor(r * 6)] : CONCRETO[Math.floor(r * 6) % 3], TECHO];
  const fam = r < 0.55 ? LADRILLO : r < 0.8 ? ESTUCO : CONCRETO;
  return [fam[Math.floor(azar(k + 7) * fam.length)], r < 0.55 && e.pisos <= 2 ? TEJA : TECHO];
}

export function mallasEdificios(lista, terreno, excluir = () => false) {
  const celdas = new Map();
  lista.forEach((e, k) => {
    if (excluir(e)) return;
    const llave = `${Math.floor(e.cx / CELDA)},${Math.floor(e.cz / CELDA)}`;
    if (!celdas.has(llave)) celdas.set(llave, { pos: [], col: [], fac: [] });
    agregar(celdas.get(llave), e, k, terreno);
  });
  const grupo = new THREE.Group();
  grupo.name = 'Edificios';
  const material = materialFachada();
  for (const c of celdas.values()) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(c.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(c.col, 3));
    g.setAttribute('fachada', new THREE.Float32BufferAttribute(c.fac, 2));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, material);
    m.castShadow = m.receiveShadow = true;
    grupo.add(m);
  }
  return { grupo, material };
}

function agregar(c, e, k, terreno) {
  const exterior = e.anillos[0];
  let min = Infinity, max = -Infinity;
  for (const [x, z] of exterior) { const h = terreno.altura(x, z); min = Math.min(min, h); max = Math.max(max, h); }
  const abajo = min - 3;
  const arriba = min + (max - min) * 0.5 + e.pisos * ALTURA_PISO + 0.6;
  const [muro, techo] = colores(e, k);
  const semilla = azar(k + 3) * 5000;

  const anillos = e.anillos.map((r, i) => {
    const ccw = area(r) > 0;
    return (i === 0) === ccw ? r : [...r].reverse(); // exterior antihorario, huecos horario
  });
  // Muros: normal hacia afuera = (dz, -dx).
  for (const r of anillos) {
    let u = semilla;
    for (let i = 0; i < r.length; i++) {
      const [ax, az] = r[i], [bx, bz] = r[(i + 1) % r.length];
      const largo = Math.hypot(bx - ax, bz - az);
      const v0 = abajo - min, v1 = arriba - min;
      const q = [[ax, abajo, az, u, v0], [bx, arriba, bz, u + largo, v1], [bx, abajo, bz, u + largo, v0],
        [ax, abajo, az, u, v0], [ax, arriba, az, u, v1], [bx, arriba, bz, u + largo, v1]];
      for (const [x, y, z, fu, fv] of q) { c.pos.push(x, y, z); c.col.push(muro.r, muro.g, muro.b); c.fac.push(fu, fv); }
      u += largo;
    }
  }
  // Techo plano.
  const contorno = anillos[0].map(([x, z]) => new THREE.Vector2(x, z));
  const huecos = anillos.slice(1).map((r) => r.map(([x, z]) => new THREE.Vector2(x, z)));
  const puntos = [...contorno, ...huecos.flat()];
  for (const [a, b, d] of THREE.ShapeUtils.triangulateShape(contorno, huecos)) {
    const tri = [puntos[a], puntos[b], puntos[d]];
    const cruz = (tri[1].x - tri[0].x) * (tri[2].y - tri[0].y) - (tri[1].y - tri[0].y) * (tri[2].x - tri[0].x);
    if (cruz > 0) tri.reverse(); // la normal debe apuntar hacia +y
    for (const p of tri) { c.pos.push(p.x, arriba, p.y); c.col.push(techo.r, techo.g, techo.b); c.fac.push(0, -1); }
  }
}

// Ventanas por shader: cada 2,8 m a lo ancho y cada piso a lo alto. De noche algunas se encienden.
export const noche = uniform(0);
function materialFachada() {
  const f = attribute('fachada', 'vec2');
  const fx = fract(f.x.div(2.8)), fy = fract(f.y.div(ALTURA_PISO));
  const ventana = step(0.2, fx).mul(step(fx, 0.8)).mul(step(0.32, fy)).mul(step(fy, 0.85)).mul(step(1.0, f.y));
  const celda = floor(f.x.div(2.8)).add(floor(f.y.div(ALTURA_PISO)).mul(173.0));
  const encendida = step(0.58, hash(celda));
  const vidrio = vec3(0.16, 0.19, 0.23);
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0.0 });
  m.colorNode = mix(vertexColor(), vidrio, ventana.mul(0.8));
  m.roughnessNode = mix(float(0.88), float(0.25), ventana);
  m.emissiveNode = vec3(1.0, 0.78, 0.48).mul(ventana).mul(encendida).mul(noche).mul(1.6);
  return m;
}
