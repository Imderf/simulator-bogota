import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  attribute, fract, step, floor, hash, mix, vec3, float, uniform, sin, abs, smoothstep, max, min, positionWorld, time,
} from 'three/tsl';
import { noche } from './edificios.js';

// Lugares emblemáticos de la zona Centro, armados a mano sobre las plantas de OpenStreetMap
// (datos/centro/lugares.json). Medidas y fuentes en docs/lugares.md. Lo que no tiene fuente va marcado "aprox.".

// ---------------------------------------------------------------------------------------------------------------
// Utilidades de geometría. Todo lleva el atributo `fachada` (u = metros a lo largo del muro, v = metros de altura)
// para que los materiales dibujen piedra, ladrillo y ventanas sin texturas.
// ---------------------------------------------------------------------------------------------------------------
const area = (p) => { let a = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j][0] * p[i][1] - p[i][0] * p[j][1]; return a / 2; };

function adentro([x, z], anillo) {
  let dentro = false;
  for (let i = 0, j = anillo.length - 1; i < anillo.length; j = i++) {
    const [xi, zi] = anillo[i], [xj, zj] = anillo[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) dentro = !dentro;
  }
  return dentro;
}

// Rectángulo de área mínima alineado con alguno de los lados: da el giro y el tamaño de cada edificio.
function rectangulo(anillo) {
  let mejor = null;
  for (let i = 0; i < anillo.length; i++) {
    const [ax, az] = anillo[i], [bx, bz] = anillo[(i + 1) % anillo.length];
    const ang = Math.atan2(bz - az, bx - ax), c = Math.cos(ang), s = Math.sin(ang);
    let u0 = Infinity, u1 = -Infinity, w0 = Infinity, w1 = -Infinity;
    for (const [x, z] of anillo) {
      const u = x * c + z * s, w = -x * s + z * c;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); w0 = Math.min(w0, w); w1 = Math.max(w1, w);
    }
    const a = (u1 - u0) * (w1 - w0);
    if (!mejor || a < mejor.a) {
      const um = (u0 + u1) / 2, wm = (w0 + w1) / 2;
      mejor = { a, ang, c, s, cx: um * c - wm * s, cz: um * s + wm * c, mu: (u1 - u0) / 2, mw: (w1 - w0) / 2 };
    }
  }
  // Punto del mundo a partir de coordenadas locales (u a lo largo, w a lo ancho).
  mejor.punto = (u, w) => [mejor.cx + u * mejor.c - w * mejor.s, mejor.cz + u * mejor.s + w * mejor.c];
  // Lado (u o w, signo) que mira hacia un punto: ahí va la fachada principal.
  mejor.ladoHacia = ([x, z]) => {
    const dx = x - mejor.cx, dz = z - mejor.cz;
    const u = dx * mejor.c + dz * mejor.s, w = -dx * mejor.s + dz * mejor.c;
    return Math.abs(u) / mejor.mu > Math.abs(w) / mejor.mw ? { eje: 'u', signo: Math.sign(u) } : { eje: 'w', signo: Math.sign(w) };
  };
  return mejor;
}

class Obra {
  constructor() { this.partes = new Map(); }
  agregar(material, geo) {
    if (!this.partes.has(material)) this.partes.set(material, []);
    this.partes.get(material).push(geo);
  }

  // Prisma vertical a partir de una planta (con huecos opcionales).
  prisma(material, anillo, y0, y1, huecos = [], { techo = true, piso = false } = {}) {
    const pos = [], fac = [];
    const anillos = [anillo, ...huecos].map((r, i) => ((i === 0) === (area(r) > 0) ? r : [...r].reverse()));
    for (const r of anillos) {
      let u = 0;
      for (let i = 0; i < r.length; i++) {
        const [ax, az] = r[i], [bx, bz] = r[(i + 1) % r.length], l = Math.hypot(bx - ax, bz - az);
        const q = [[ax, y0, az, u, 0], [bx, y1, bz, u + l, y1 - y0], [bx, y0, bz, u + l, 0],
          [ax, y0, az, u, 0], [ax, y1, az, u, y1 - y0], [bx, y1, bz, u + l, y1 - y0]];
        for (const [x, y, z, fu, fv] of q) { pos.push(x, y, z); fac.push(fu, fv); }
        u += l;
      }
    }
    const tapa = (y, arriba) => {
      const c = anillos[0].map(([x, z]) => new THREE.Vector2(x, z)), h = anillos.slice(1).map((r) => r.map(([x, z]) => new THREE.Vector2(x, z)));
      const pts = [...c, ...h.flat()];
      for (const t of THREE.ShapeUtils.triangulateShape(c, h)) {
        let tri = t.map((k) => pts[k]);
        const cruz = (tri[1].x - tri[0].x) * (tri[2].y - tri[0].y) - (tri[1].y - tri[0].y) * (tri[2].x - tri[0].x);
        if ((cruz > 0) === arriba) tri = tri.reverse();
        for (const p of tri) { pos.push(p.x, y, p.y); fac.push(p.x, -1); }
      }
    };
    if (techo) tapa(y1, true);
    if (piso) tapa(y0, false);
    this.agregar(material, geometria(pos, fac));
  }

  // Caja girada con el marco de un rectángulo: centro (u, w), medio ancho (du, dw).
  caja(material, r, u, w, du, dw, y0, y1) {
    this.prisma(material, [r.punto(u - du, w - dw), r.punto(u + du, w - dw), r.punto(u + du, w + dw), r.punto(u - du, w + dw)], y0, y1);
  }

  cilindro(material, [x, z], radio, y0, y1, lados = 16) {
    const p = [];
    for (let i = 0; i < lados; i++) { const a = (i / lados) * Math.PI * 2; p.push([x + Math.cos(a) * radio, z + Math.sin(a) * radio]); }
    this.prisma(material, p, y0, y1);
  }

  // Sólido de revolución (cúpulas, linternas, agujas) con su perfil [radio, altura].
  torno(material, [x, z], perfil, lados = 16) {
    const g = new THREE.LatheGeometry(perfil.map(([r, y]) => new THREE.Vector2(r, y)), lados).toNonIndexed();
    g.translate(x, 0, z);
    const p = g.attributes.position, fac = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) { fac[i * 2] = Math.atan2(p.getZ(i) - z, p.getX(i) - x) * 4; fac[i * 2 + 1] = p.getY(i); }
    g.deleteAttribute('uv');
    g.deleteAttribute('normal');
    g.setAttribute('fachada', new THREE.BufferAttribute(fac, 2));
    g.computeVertexNormals();
    this.agregar(material, g);
  }

  // Frontón triangular sobre una fachada: base de ancho 2·du a la altura y0, alto h, grosor 2·dw.
  fronton(material, r, u, w, du, dw, y0, h) {
    const a = r.punto(u - du, w), b = r.punto(u + du, w), pos = [], fac = [];
    const ex = -r.s * dw, ez = r.c * dw;
    const cara = (s) => {
      const cima = [(a[0] + b[0]) / 2 + ex * s, y0 + h, (a[1] + b[1]) / 2 + ez * s];
      const tri = [[a[0] + ex * s, y0, a[1] + ez * s], [b[0] + ex * s, y0, b[1] + ez * s], cima];
      for (const p of s > 0 ? tri : [tri[0], tri[2], tri[1]]) { pos.push(...p); fac.push(0, p[1] - y0); }
    };
    cara(1); cara(-1);
    for (const [p, q] of [[a, b], [b, a]]) {
      const cima = [(a[0] + b[0]) / 2, y0 + h, (a[1] + b[1]) / 2];
      const v = [[p[0] - ex, y0, p[1] - ez], [p[0] + ex, y0, p[1] + ez], [cima[0] + ex, cima[1], cima[2] + ez], [cima[0] - ex, cima[1], cima[2] - ez]];
      for (const k of [0, 2, 1, 0, 3, 2]) { pos.push(...v[k]); fac.push(0, 1); }
    }
    this.agregar(material, geometria(pos, fac));
  }

  // Disco vertical (relojes) mirando hacia `normal` ([x, z]).
  disco(material, [x, y, z], normal, radio) {
    const g = new THREE.CylinderGeometry(radio, radio, 0.25, 24).toNonIndexed();
    g.rotateX(Math.PI / 2);
    g.rotateY(Math.atan2(normal[0], normal[1]));
    g.translate(x + normal[0] * 0.15, y, z + normal[1] * 0.15);
    g.deleteAttribute('uv');
    g.setAttribute('fachada', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    this.agregar(material, g);
  }

  // Marco de una fachada: `a` corre a lo largo del frente y `b` sale hacia afuera (0 = plano del frente).
  frente(r, lado) {
    const f = (lado.eje === 'u' ? r.mu : r.mw) * lado.signo;
    const L = (a, b) => (lado.eje === 'u' ? [f + b * lado.signo, a] : [a, f + b * lado.signo]);
    const normal = lado.eje === 'u' ? [r.c * lado.signo, r.s * lado.signo] : [-r.s * lado.signo, r.c * lado.signo];
    return {
      L, normal, largo: lado.eje === 'u' ? r.mw : r.mu,
      punto: (a, b) => r.punto(...L(a, b)),
      // Pieza rectangular pegada al frente: ancho a lo largo, fondo hacia afuera.
      panel: (material, a, b, ancho, fondo, y0, y1) => {
        const [u, w] = L(a, b);
        const [du, dw] = lado.eje === 'u' ? [fondo / 2, ancho / 2] : [ancho / 2, fondo / 2];
        this.caja(material, r, u, w, du, dw, y0, y1);
      },
    };
  }

  mallas(nombre) {
    const grupo = new THREE.Group();
    grupo.name = nombre;
    for (const [material, geos] of this.partes) {
      const m = new THREE.Mesh(mergeGeometries(geos), material);
      m.castShadow = m.receiveShadow = true;
      grupo.add(m);
    }
    return grupo;
  }
}

function geometria(pos, fac) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('fachada', new THREE.Float32BufferAttribute(fac, 2));
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------------------------------------------
// Materiales: piedra arenisca, estuco, ladrillo, teja, vidrio y la fachada de LED de Colpatria. Todo con TSL.
// ---------------------------------------------------------------------------------------------------------------
const fac = () => attribute('fachada', 'vec2');

function piedra(color, { bloque = [1.4, 0.55], ventanas = null } = {}) {
  const f = fac();
  const fila = floor(f.y.div(bloque[1]));
  const ju = fract(f.x.div(bloque[0]).add(fila.mul(0.5))), jv = fract(f.y.div(bloque[1]));
  const junta = max(step(ju, 0.03), step(jv, 0.05)).mul(step(0.0, f.y));
  const ruido = hash(floor(f.x.div(bloque[0]).add(fila.mul(0.5))).add(fila.mul(57.0))).mul(0.08);
  let c = vec3(...new THREE.Color(color).toArray()).mul(float(0.96).add(ruido)).mul(float(1).sub(junta.mul(0.22)));
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 });
  if (ventanas) {
    const [ancho, alto, desde] = ventanas;
    const vx = fract(f.x.div(ancho)), vy = fract(f.y.sub(desde).div(alto));
    const v = step(0.3, vx).mul(step(vx, 0.7)).mul(step(0.25, vy)).mul(step(vy, 0.8)).mul(step(desde, f.y));
    c = mix(c, vec3(0.13, 0.15, 0.17), v);
    m.emissiveNode = vec3(1.0, 0.8, 0.5).mul(v).mul(noche).mul(0.9);
  }
  m.colorNode = c;
  return m;
}

function ladrillo(color, { ventanas = null } = {}) {
  const f = fac();
  const fila = floor(f.y.div(0.075));
  const ju = fract(f.x.div(0.25).add(fila.mul(0.5))), jv = fract(f.y.div(0.075));
  const junta = max(step(ju, 0.06), step(jv, 0.12));
  // De lejos las juntas se funden en un tono medio para no hacer moiré.
  const lejos = smoothstep(40.0, 160.0, positionWorld.sub(cameraPos).length());
  const tinte = hash(floor(f.x.div(0.25).add(fila.mul(0.5))).add(fila.mul(31.0))).mul(0.12);
  const base = vec3(...new THREE.Color(color).toArray());
  let c = mix(base.mul(float(0.94).add(tinte)).mul(float(1).sub(junta.mul(0.25))), base.mul(0.93), lejos);
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.92 });
  if (ventanas) {
    const [ancho, alto] = ventanas;
    const vx = fract(f.x.div(ancho)), vy = fract(f.y.div(alto));
    const v = step(0.15, vx).mul(step(vx, 0.85)).mul(step(0.35, vy)).mul(step(vy, 0.82)).mul(step(3.0, f.y));
    c = mix(c, vec3(0.12, 0.14, 0.16), v.mul(0.9));
    m.emissiveNode = vec3(1.0, 0.78, 0.5).mul(v).mul(step(0.55, hash(floor(f.x.div(ancho)).add(floor(f.y.div(alto)).mul(91.0))))).mul(noche).mul(1.4);
  }
  m.colorNode = c;
  return m;
}

// Balaustrada: barrotes claros con huecos oscuros entre ellos, sin geometría extra.
function balaustrada(color) {
  const f = fac();
  const hueco = step(0.55, fract(f.x.div(0.38))).mul(step(0.18, f.y)).mul(step(f.y, 0.95));
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 });
  m.colorNode = mix(vec3(...new THREE.Color(color).toArray()), vec3(0.18, 0.17, 0.16), hueco);
  return m;
}

function plano(color, opciones = {}) {
  return new THREE.MeshStandardNodeMaterial({ color, roughness: 0.85, ...opciones });
}

// Colpatria: pilastras verticales de concreto blanco y franjas de vidrio (fotos de Commons).
// De noche las franjas son la pantalla de LED: unos 120 m de fachada con color animado.
export const cameraPos = uniform(new THREE.Vector3());
function colpatria(alto) {
  const f = fac();
  const franja = step(0.58, fract(f.x.div(1.55)));
  const conLed = step(alto - 120, f.y).mul(franja);
  const ola = fract(f.y.div(60).sub(time.mul(0.08)).add(sin(f.x.mul(0.05).add(time.mul(0.6))).mul(0.15)));
  const led = mix(mix(vec3(0.95, 0.1, 0.35), vec3(0.15, 0.4, 1.0), smoothstep(0.2, 0.5, ola)), vec3(1.0, 0.85, 0.2), smoothstep(0.6, 0.9, ola));
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.6 });
  m.colorNode = mix(vec3(0.86, 0.85, 0.82), vec3(0.12, 0.15, 0.18), franja);
  m.roughnessNode = mix(float(0.7), float(0.2), franja);
  m.emissiveNode = led.mul(conLed).mul(noche).mul(2.2);
  return m;
}

function vidrioTorre(color) {
  const f = fac();
  const losa = step(fract(f.y.div(3.2)), 0.12);
  const parteluz = step(fract(f.x.div(1.6)), 0.05);
  // Sin mapa de entorno un vidrio metálico se ve negro: se simula con poco metal y algo de brillo.
  const m = new THREE.MeshStandardNodeMaterial({ metalness: 0.08, roughness: 0.32 });
  const base = vec3(...new THREE.Color(color).toArray());
  m.colorNode = mix(base, base.mul(0.55), max(losa, parteluz));
  m.emissiveNode = vec3(0.9, 0.85, 0.7).mul(step(0.7, hash(floor(f.x.div(1.6)).add(floor(f.y.div(3.2)).mul(77.0))))).mul(noche).mul(0.8).mul(float(1).sub(losa));
  return m;
}

// ---------------------------------------------------------------------------------------------------------------
// Los lugares.
// ---------------------------------------------------------------------------------------------------------------
export function construirLugares(datos, terreno, edificios) {
  const obra = new Obra();
  const suelo = (x, z) => terreno.altura(x, z);
  const minSuelo = (anillo) => Math.min(...anillo.map(([x, z]) => suelo(x, z)));
  // En los cerros la malla de 32 m redondea las cimas: se hace una explanada a la altura media de la planta.
  const explanada = (anillo, nivel) => {
    const y = nivel ?? anillo.reduce((s, [x, z]) => s + suelo(x, z), 0) / anillo.length;
    terreno.aplanar(anillo, y);
    return y;
  };
  const M = {
    arenisca: piedra(0xcdb88e),
    areniscaVentanas: piedra(0xcbb68c, { ventanas: [4.2, 6.5, 3] }),
    areniscaOscura: piedra(0xb8a47c),
    estucoAmarillo: piedra(0xe2cf8f, { bloque: [3, 3], ventanas: [3.6, 6, 0] }),
    estucoBlanco: piedra(0xf1eee6, { bloque: [3, 3] }),
    blancoVentanas: piedra(0xeeebe2, { bloque: [3, 3], ventanas: [3, 3.2, 1] }),
    ladrilloSalmona: ladrillo(0xb4643c, { ventanas: [3.2, 2.9] }),
    ladrilloPlaza: ladrillo(0x9a4a30),
    teja: plano(0xa4532f, { roughness: 0.8 }),
    pizarra: plano(0x55585c, { roughness: 0.6, metalness: 0.2 }),
    cupulaGris: plano(0x8f8a7e, { roughness: 0.7 }),
    bronce: plano(0x4a3c2a, { roughness: 0.4, metalness: 0.7 }),
    adoquin: piedra(0x9c9284, { bloque: [0.9, 0.9] }),
    arena: plano(0xc9a874),
    colpatria: colpatria(192),
    vidrioAzul: vidrioTorre(0x7f98b0),
    vidrioGris: vidrioTorre(0x8e98a3),
    cable: new THREE.LineBasicNodeMaterial({ color: 0x222222 }),
    cabina: plano(0xc0392b),
    madera: plano(0x5b3b22, { roughness: 0.7 }),
    sombra: plano(0x2a2622, { roughness: 1 }),
    reloj: plano(0xf2efe6, { roughness: 0.5 }),
    balaustrada: balaustrada(0xcdb88e),
  };

  const excluir = [];
  const plantas = {};
  for (const [k, v] of Object.entries(datos)) plantas[k] = v;

  // --- Plaza de Bolívar. Centro y giro a partir de los cuatro edificios que la rodean. ----------------------
  const capitolio = rectangulo(plantas.capitolio.anillos[0]);
  const centroPlaza = [0, 0];
  for (const k of ['capitolio', 'justicia', 'catedral', 'lievano']) {
    const r = rectangulo(plantas[k].anillos[0]);
    centroPlaza[0] += r.cx / 4; centroPlaza[1] += r.cz / 4;
  }
  const yPlaza = suelo(...centroPlaza);
  {
    const yp = yPlaza;
    // La plaza es plana: se aplana el terreno del cuadrado y sus andenes.
    const rp = { ...capitolio, cx: centroPlaza[0], cz: centroPlaza[1] };
    rp.punto = (u, w) => [rp.cx + u * rp.c - w * rp.s, rp.cz + u * rp.s + w * rp.c];
    terreno.aplanar([rp.punto(-64, -64), rp.punto(64, -64), rp.punto(64, 64), rp.punto(-64, 64)], yp, 40);
    // Marco de la plaza alineado con el Capitolio. Unos 13.900 m² con las calles (es.wiki): ~105 m de lado sin ellas (aprox.).
    const r = { ...capitolio, cx: centroPlaza[0], cz: centroPlaza[1] };
    r.punto = (u, w) => [r.cx + u * r.c - w * r.s, r.cz + u * r.s + w * r.c];
    obra.caja(M.adoquin, r, 0, 0, 52, 52, yp - 2, yp + 0.25);
    // Estatua de Bolívar (Tenerani, 1846) sobre su pedestal de 1927. Medidas aprox.
    obra.caja(M.areniscaOscura, r, 0, 0, 2.4, 2.4, yp, yp + 1.2);
    obra.caja(M.arenisca, r, 0, 0, 1.4, 1.4, yp + 1.2, yp + 5.2);
    obra.cilindro(M.bronce, centroPlaza, 0.45, yp + 5.2, yp + 6.6, 10);
    obra.torno(M.bronce, centroPlaza, [[0, 6.6], [0.42, 6.65], [0.3, 7.5], [0.22, 7.9], [0, 8.0]].map(([a, b]) => [a, yp + b]), 10);
  }

  // --- Capitolio Nacional: piedra rubia, dos pisos sobre un basamento, balaustrada y pórtico jónico
  // de "seis filas de tres columnas" (es.wiki). Alturas aprox. según las fotos de Commons.
  {
    const { anillos: [planta], huecos } = plantas.capitolio;
    const y0 = explanada(planta, yPlaza) // al nivel de la plaza;
    obra.prisma(M.arenisca, planta, y0 - 2, y0 + 3, huecos);
    obra.prisma(M.areniscaVentanas, planta, y0 + 3, y0 + 17, huecos);
    obra.prisma(M.areniscaOscura, planta, y0 + 17, y0 + 18.6, huecos);
    const r = capitolio, lado = r.ladoHacia(centroPlaza);
    const fachada = (lado.eje === 'u' ? r.mu : r.mw) * lado.signo;
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) {
      const a = (i - 2.5) * 5.2, b = fachada + lado.signo * (2.5 + j * 4.2);
      const p = lado.eje === 'u' ? r.punto(b, a) : r.punto(a, b);
      obra.cilindro(M.estucoBlanco, p, 0.65, y0 + 3, y0 + 15.5, 12);
    }
    const fondo = fachada + lado.signo * 6.7;
    const [cu, cw, du, dw] = lado.eje === 'u' ? [fondo, 0, 6.2, 16] : [0, fondo, 16, 6.2];
    obra.caja(M.arenisca, r, cu, cw, du, dw, y0, y0 + 3);
    obra.caja(M.areniscaOscura, r, cu, cw, du, dw, y0 + 15.5, y0 + 18.6);
    // Balaustrada y urnas sobre la cornisa (foto de Commons de la fachada sur).
    obra.prisma(M.balaustrada, planta, y0 + 18.6, y0 + 19.8, huecos, { techo: false });
    const F = obra.frente(r, lado);
    for (let a = -F.largo + 4; a <= F.largo - 4; a += 9) {
      const p = F.punto(a, -0.4);
      obra.torno(M.areniscaOscura, p, [[0.45, y0 + 19.8], [0.55, y0 + 20.4], [0.3, y0 + 20.9], [0.42, y0 + 21.5], [0, y0 + 21.7]], 8);
    }
  }

  // --- Catedral Primada: dos torres de 52 m (es.wiki) en la fachada hacia la plaza, frontón al centro,
  // piedra arenisca clara. Puertas: la central de 7,20 × 3,60 m y las laterales de 5,60 × 2,80 m (es.wiki).
  // Proporciones de cornisas, campanarios y reloj medidas sobre la foto de Commons de 2021. Ancho ~48 m aprox.
  {
    const [planta] = plantas.catedral.anillos;
    const y0 = explanada(planta, yPlaza) // al nivel de la plaza;
    obra.prisma(M.arenisca, planta, y0 - 2, y0 + 24);
    const r = rectangulo(planta), F = obra.frente(r, r.ladoHacia(centroPlaza));
    const c = Math.max(-F.largo + 26, Math.min(F.largo - 26, 0));
    // Cuerpo central y frontón.
    F.panel(M.arenisca, c, -2.5, 30, 5, y0, y0 + 30);
    F.panel(M.areniscaOscura, c, -2.5, 31, 5.6, y0 + 30, y0 + 31);
    const [fu, fw] = F.L(c, -2.5);
    // fronton() corre a lo largo de u: si la fachada mira por u, se le pasa el marco girado.
    if (F.L(1, 0)[1] === 1) obra.fronton(M.areniscaOscura, { ...r, punto: (a, b) => r.punto(b, a), s: -r.c, c: r.s }, fw, fu, 12, 2.5, y0 + 31, 6.5);
    else obra.fronton(M.areniscaOscura, r, fu, fw, 12, 2.5, y0 + 31, 6.5);
    const cima = F.punto(c, -2.5);
    obra.cilindro(M.arenisca, cima, 0.5, y0 + 37.3, y0 + 39, 8);
    obra.caja(M.bronce, { ...r, punto: (u, w) => [cima[0] + u * r.c - w * r.s, cima[1] + u * r.s + w * r.c] }, 0, 0, 0.12, 0.6, y0 + 39, y0 + 40.6);
    // Cornisa principal a ~16,4 m y basamento a lo ancho de toda la fachada.
    F.panel(M.areniscaOscura, c, 0.3, 49, 1.2, y0 + 15.8, y0 + 17);
    F.panel(M.areniscaOscura, c, 0.2, 49, 1, y0, y0 + 1.1);
    // Pilastras del primer cuerpo.
    for (const a of [-14.5, -8, 8, 14.5]) F.panel(M.arenisca, c + a, 0.25, 1.4, 0.6, y0 + 1.1, y0 + 15.8);
    // Puertas de madera.
    F.panel(M.madera, c, 0.12, 3.6, 0.4, y0, y0 + 7.2);
    for (const t of [-1, 1]) F.panel(M.madera, c + t * 11.2, 0.12, 2.8, 0.4, y0, y0 + 5.6);
    // Hornacina sobre la puerta central.
    F.panel(M.sombra, c, 0.1, 2.2, 0.3, y0 + 20, y0 + 24.5);
    for (const t of [-1, 1]) {
      const a = c + t * 19.5;
      F.panel(M.arenisca, a, -4.5, 9.2, 9.2, y0, y0 + 30);
      F.panel(M.areniscaOscura, a, -4.5, 10, 10, y0 + 30, y0 + 31);
      F.panel(M.arenisca, a, -4.5, 8, 8, y0 + 31, y0 + 40);
      F.panel(M.areniscaOscura, a, -4.5, 8.6, 8.6, y0 + 40, y0 + 41);
      // Vanos de campanas (frente y costados) y ventana del cuerpo bajo de la torre.
      F.panel(M.sombra, a, -0.45, 2.2, 0.3, y0 + 33.4, y0 + 37.8);
      F.panel(M.sombra, a, 0.1, 1.8, 0.3, y0 + 19, y0 + 23.5);
      const p = F.punto(a, -4.5);
      obra.torno(M.cupulaGris, p, [[3.6, y0 + 41], [3.5, y0 + 43], [2.8, y0 + 45.5], [1.4, y0 + 47], [0.8, y0 + 47.2], [0, y0 + 47.3]]);
      obra.cilindro(M.arenisca, p, 0.75, y0 + 47, y0 + 49.5, 8);
      obra.torno(M.cupulaGris, p, [[0.85, y0 + 49.5], [0.5, y0 + 50.3], [0.1, y0 + 51.2], [0, y0 + 52]], 8);
      // Pináculos en las esquinas del campanario.
      for (const [da, db] of [[-3.6, -0.9], [3.6, -0.9]]) {
        const q = F.punto(a + da, db);
        obra.torno(M.arenisca, q, [[0.35, y0 + 41], [0.3, y0 + 42.2], [0, y0 + 43.4]], 6);
      }
    }
    // Reloj en la torre norte, la de San Emigdio (es.wiki).
    const norte = [-1, 1].map((t) => c + t * 19.5).sort((a, b) => F.punto(a, 0)[1] - F.punto(b, 0)[1])[0];
    const pr = F.punto(norte, -0.5);
    obra.disco(M.reloj, [pr[0], y0 + 32.2, pr[1]], F.normal, 0.95);
    excluir.push(planta);
  }

  // --- Palacio Liévano (Alcaldía): fachada amarilla con arcada en el primer piso, cubierta gris
  // y mansardas en las esquinas (foto de Commons de 2020). 3 niveles (es.wiki). Alturas aprox.
  {
    const { anillos: [planta], huecos } = plantas.lievano;
    const y0 = explanada(planta, yPlaza) // al nivel de la plaza;
    obra.prisma(M.estucoAmarillo, planta, y0 - 2, y0 + 17, huecos);
    obra.prisma(M.pizarra, planta, y0 + 17, y0 + 18.5, huecos);
    const r = rectangulo(planta), lado = r.ladoHacia(centroPlaza);
    const largo = lado.eje === 'u' ? r.mw : r.mu, f = (lado.eje === 'u' ? r.mu : r.mw) * lado.signo;
    for (const t of [-1, 1]) {
      const a = t * (largo - 9), b = f - lado.signo * 9;
      const [u, w] = lado.eje === 'u' ? [b, a] : [a, b];
      obra.caja(M.pizarra, r, u, w, 9, 9, y0 + 18.5, y0 + 24);
    }
    // Arcada del primer piso: vanos oscuros entre pilares, un poco hundidos.
    const F = obra.frente(r, lado);
    for (let a = -F.largo + 6; a <= F.largo - 6; a += 5.6) F.panel(M.sombra, a, 0.05, 3.4, 0.2, y0, y0 + 4.6);
    F.panel(M.estucoBlanco, 0, 0.25, F.largo * 2, 0.5, y0 + 5, y0 + 5.6);
    excluir.push(planta);
  }

  // --- Palacio de Justicia: bloque de piedra (Roberto Londoño). Alto sin fuente: ~24 m aprox.
  {
    const { anillos: [planta], huecos } = plantas.justicia;
    const y0 = explanada(planta, yPlaza) // al nivel de la plaza;
    obra.prisma(M.areniscaOscura, planta, y0 - 2, y0 + 4, huecos);
    obra.prisma(M.areniscaVentanas, planta, y0 + 4, y0 + 24, huecos);
    excluir.push(planta);
  }
  excluir.push(plantas.capitolio.anillos[0]);

  // --- Teatro Colón y Museo Nacional (antiguo Panóptico): prioridad 3 y 2, volumen simple.
  for (const [k, mat, alto] of [['teatroColon', M.estucoBlanco, 20], ['museoNacional', M.arenisca, 12]]) {
    const [planta] = plantas[k].anillos;
    const y0 = minSuelo(planta);
    obra.prisma(mat, planta, y0 - 2, y0 + alto);
    excluir.push(planta);
  }

  // --- Torre Colpatria: 196 m con helipuerto, mirador a 192 m (es.wiki, Structurae). Planta de OSM.
  {
    const [planta] = plantas.colpatria.anillos;
    const y0 = minSuelo(planta);
    const r = rectangulo(planta);
    const escala = (f) => planta.map(([x, z]) => [r.cx + (x - r.cx) * f, r.cz + (z - r.cz) * f]);
    // La punta se retrae en dos escalones (foto de Commons de 2021).
    obra.prisma(M.colpatria, planta, y0 - 2, y0 + 180);
    obra.prisma(M.colpatria, escala(0.93), y0 + 180, y0 + 187);
    obra.prisma(M.colpatria, escala(0.85), y0 + 187, y0 + 192);
    obra.caja(M.estucoBlanco, r, 0, 0, r.mu - 3, r.mw - 3, y0 + 192, y0 + 195);
    obra.cilindro(M.pizarra, [r.cx, r.cz], 7, y0 + 195, y0 + 196, 20);
    excluir.push(planta);
  }

  // --- BD Bacatá: Torre Sur 216 m y Torre Norte 167 m (es.wiki, Skyscraper Center). La planta de OSM
  // de la Torre Sur está incompleta, así que se toman las del catastro (las dos construcciones con más pisos).
  {
    const cerca = edificios.filter((e) => Math.hypot(e.cx - 640, e.cz + 760) < 120).sort((a, b) => b.pisos - a.pisos);
    const [sur, norte] = cerca;
    for (const [e, alto, mat] of [[sur, 216, M.vidrioAzul], [norte, 167, M.vidrioGris]]) {
      if (!e) continue;
      const planta = e.anillos[0], y0 = minSuelo(planta);
      obra.prisma(mat, planta, y0 - 2, y0 + alto);
      excluir.push(planta);
    }
  }

  // --- Edificio Avianca: 161 m y 41 pisos (es.wiki). Planta de OSM.
  {
    const [planta] = plantas.avianca.anillos, y0 = minSuelo(planta);
    obra.prisma(M.vidrioGris, planta, y0 - 2, y0 + 161);
    excluir.push(planta);
  }

  // --- Torres del Parque (Salmona): ladrillo a la vista. Torre A 117 m y 37 pisos (OSM, Pulzo);
  // B y C 20 pisos (OSM). Se escalonan hacia arriba como las terrazas reales (forma aprox.).
  for (const [k, pisos] of [['torreA', 37], ['torreB', 20], ['torreC', 20]]) {
    const [planta] = plantas[k].anillos, y0 = minSuelo(planta);
    const alto = k === 'torreA' ? 117 : pisos * 2.9;
    const r = rectangulo(planta);
    const escala = (f) => planta.map(([x, z]) => [r.cx + (x - r.cx) * f, r.cz + (z - r.cz) * f]);
    obra.prisma(M.ladrilloSalmona, planta, y0 - 2, y0 + alto * 0.62);
    obra.prisma(M.ladrilloSalmona, escala(0.86), y0 + alto * 0.62, y0 + alto * 0.84);
    obra.prisma(M.ladrilloSalmona, escala(0.7), y0 + alto * 0.84, y0 + alto);
    excluir.push(planta);
  }

  // --- Plaza de Toros La Santamaría: anillo de ladrillo neomudéjar (es.wiki) con ruedo de arena.
  // Alto sin fuente: ~15 m aprox.
  {
    const { anillos: [planta], huecos } = plantas.santamaria;
    const y0 = minSuelo(planta);
    obra.prisma(M.ladrilloPlaza, planta, y0 - 2, y0 + 15, huecos);
    if (huecos[0]) obra.prisma(M.arena, huecos[0], y0 - 1, y0 + 0.3);
    excluir.push(planta);
  }

  // --- Planetario: cilindro con cúpula. OSM da 10 m de alto; la cúpula es aprox.
  {
    const [planta] = plantas.planetario.anillos, y0 = minSuelo(planta);
    const r = rectangulo(planta), radio = Math.min(r.mu, r.mw);
    obra.prisma(M.estucoBlanco, planta, y0 - 2, y0 + 6);
    obra.torno(M.cupulaGris, [r.cx, r.cz], Array.from({ length: 9 }, (_, i) => {
      const a = (i / 8) * Math.PI / 2;
      return [Math.cos(a) * radio * 0.8, y0 + 6 + Math.sin(a) * 8];
    }), 28);
    excluir.push(planta);
  }

  // --- Monserrate: basílica blanca con UNA torre central y techos de teja (foto de Commons de 2017;
  // corrige la idea de dos torres). Cima a 3.152 m (es.wiki). Alturas de la torre aprox.
  {
    const [planta] = plantas.basilicaMonserrate.anillos, y0 = explanada(planta);
    obra.prisma(M.areniscaOscura, planta, y0 - 4, y0 + 0.6); // zócalo
    obra.prisma(M.blancoVentanas, planta, y0 + 0.6, y0 + 10);
    obra.prisma(M.teja, planta, y0 + 10, y0 + 10.6, [], { techo: true });
    const r = rectangulo(planta), lado = r.ladoHacia([0, 0]); // la fachada mira a la ciudad
    const f = ((lado.eje === 'u' ? r.mu : r.mw) - 6) * lado.signo;
    const [u, w] = lado.eje === 'u' ? [f, 0] : [0, f];
    obra.caja(M.estucoBlanco, r, u, w, 3.2, 3.2, y0, y0 + 26);
    obra.caja(M.estucoBlanco, r, u, w, 2.4, 2.4, y0 + 26, y0 + 31);
    obra.caja(M.estucoBlanco, r, u, w, 1.7, 1.7, y0 + 31, y0 + 34);
    const p = r.punto(u, w);
    obra.torno(M.estucoBlanco, p, [[1.5, y0 + 34], [0.2, y0 + 38], [0, y0 + 38.2]], 8);
    obra.cilindro(M.bronce, p, 0.08, y0 + 38, y0 + 40, 4);
    for (const k of ['estacionTelefericoArriba', 'estacionFunicularArriba', 'estacionAbajo']) {
      const [pl] = plantas[k].anillos, ys = k === 'estacionAbajo' ? minSuelo(pl) : explanada(pl);
      obra.prisma(M.areniscaOscura, pl, ys - 3, ys + 0.5);
      obra.prisma(M.blancoVentanas, pl, ys + 0.5, ys + 7);
      obra.prisma(M.teja, pl, ys + 7, ys + 7.5);
    }
    excluir.push(planta);
  }

  // --- Guadalupe: ermita y la Virgen de 15 m (es.wiki). La figura es una silueta aprox.
  {
    const [planta] = plantas.guadalupe.anillos, y0 = explanada(planta);
    obra.prisma(M.areniscaOscura, planta, y0 - 3, y0 + 0.5);
    obra.prisma(M.estucoBlanco, planta, y0 + 0.5, y0 + 8);
    const r = rectangulo(planta), p = r.punto(-r.mu - 12, 0), ys = suelo(...p);
    obra.cilindro(M.arenisca, p, 2.5, ys - 2, ys + 4, 8);
    obra.torno(M.estucoBlanco, p, [[0, ys + 4], [1.6, ys + 4], [1.3, ys + 9], [0.9, ys + 14], [0.75, ys + 15.2], [0.9, ys + 16.5], [0.6, ys + 18.4], [0, ys + 19]], 12);
  }

  const grupo = obra.mallas('Lugares');

  // --- Funicular (vía sobre el cerro) y teleférico (cable entre estaciones, con su cabina roja).
  const tramos = ['funicular3', 'funicular2', 'funicular1'].map((k) => plantas[k].anillos[0]).flat();
  const via = [];
  for (let i = 0; i < tramos.length - 1; i++) {
    const [ax, az] = tramos[i], [bx, bz] = tramos[i + 1], n = Math.ceil(Math.hypot(bx - ax, bz - az) / 6);
    for (let s = 0; s < n; s++) { const t = s / n, x = ax + (bx - ax) * t, z = az + (bz - az) * t; via.push(new THREE.Vector3(x, suelo(x, z) + 0.6, z)); }
  }
  if (via.length) grupo.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(via), M.cable));

  const ruta = plantas.teleferico.anillos[0];
  const a = ruta[0], b = ruta.at(-1);
  const pa = new THREE.Vector3(a[0], suelo(...a) + 9, a[1]), pb = new THREE.Vector3(b[0], suelo(...b) + 9, b[1]);
  const cable = [];
  for (let i = 0; i <= 40; i++) { const t = i / 40, p = pa.clone().lerp(pb, t); p.y -= Math.sin(t * Math.PI) * 18; cable.push(p); }
  grupo.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(cable), M.cable));
  const cabina = new THREE.Mesh(new THREE.BoxGeometry(3, 2.6, 2.2), M.cabina);
  cabina.castShadow = true;
  grupo.add(cabina);
  const curva = new THREE.CatmullRomCurve3(cable);
  const animar = (t) => {
    const k = (Math.sin(t * 0.12) + 1) / 2; // va y vuelve
    curva.getPointAt(k, cabina.position);
    cabina.position.y -= 2;
    cabina.lookAt(pb.x, cabina.position.y, pb.z);
  };

  return { grupo, animar, excluir: (e) => excluir.some((p) => adentro([e.cx, e.cz], p)), solidos: excluir, centroPlaza };
}

// Puntos para el menú de lugares. La cámara se para del lado de `desde` (por defecto, la Plaza de Bolívar),
// a `dist` metros del objetivo y `alto` metros por encima del suelo.
export function puntosDeVista(datos, centroPlaza) {
  const centro = (k) => rectangulo(datos[k].anillos[0]);
  const v = (k, nombre, dist, alto, extra = {}) => { const r = centro(k); return { nombre, x: r.cx, z: r.cz, dist, alto, desde: centroPlaza, ...extra }; };
  return [
    { nombre: 'Plaza de Bolívar', x: centroPlaza[0], z: centroPlaza[1], dist: 260, alto: 120 },
    v('basilicaMonserrate', 'Monserrate', 300, 90),
    v('colpatria', 'Torre Colpatria', 480, 200),
    { nombre: 'BD Bacatá', x: 640, z: -760, dist: 520, alto: 330, desde: centroPlaza },
    v('torreA', 'Torres del Parque', 380, 160),
    v('santamaria', 'La Santamaría', 260, 140),
    v('catedral', 'Catedral Primada', 170, 45),
    v('guadalupe', 'Guadalupe', 170, 60),
    { nombre: 'La Candelaria', x: 450, z: 80, dist: 420, alto: 260 },
  ];
}
