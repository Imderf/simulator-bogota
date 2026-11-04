import * as THREE from 'three/webgpu';
import { Fn, texture, uv, positionWorld, positionView, normalView, normalWorldGeometry, fwidth, fract, floor, abs, dot, length,
  smoothstep, mix, max, min, float, vec2, vec3, color, specularColor, specularColorBlended, specularF90 } from 'three/tsl';
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

// Malla del relieve. El uv proyecta texturaSuelo (vias.js) sobre la caja de datos; el color lo pone materialTerreno.
export function mallaTerreno(t, texturaSuelo, cajaSuelo) {
  const { cols, filas, paso, ox, oz, h } = t;
  const pos = new Float32Array(cols * filas * 3), uvs = new Float32Array(cols * filas * 2);
  const { x0, z0, x1, z1 } = cajaSuelo;
  for (let j = 0; j < filas; j++) for (let i = 0; i < cols; i++) {
    const k = j * cols + i, x = ox + i * paso, z = oz + j * paso;
    pos.set([x, h[k], z], k * 3);
    uvs.set([(x - x0) / (x1 - x0), (z - z0) / (z1 - z0)], k * 2);
  }
  const idx = [];
  for (let j = 0; j < filas - 1; j++) for (let i = 0; i < cols - 1; i++) {
    const a = j * cols + i, b = a + 1, d = a + cols, e = d + 1;
    idx.push(a, d, b, b, d, e);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Ruido suave que se repite cada 256 texeles, hecho una vez en la CPU: cuatro campos independientes (r, g, b, a) de
// ruido de valor en dos octavas, con media 0,5 y desviación 0,2. Leerlo de una textura cuesta mucho menos que calcular
// ruido en cada píxel, y las mipmaps lo promedian de lejos: la textura fina no parpadea.
function texturaRuido() {
  const N = 256, datos = new Uint8Array(N * N * 4), campo = new Float32Array(N * N);
  let semilla = 1234567;
  const azar = () => (semilla = (semilla * 16807) % 2147483647) / 2147483647;
  const suave = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  for (let c = 0; c < 4; c++) {
    campo.fill(0);
    for (const [L, peso] of [[16, 1], [32, 0.5]]) {
      const red = Float32Array.from({ length: L * L }, azar), s = N / L;
      const v = (a, b) => red[(b % L) * L + (a % L)];
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const fx = i / s, fz = j / s, a = Math.floor(fx), b = Math.floor(fz), tx = suave(fx - a), tz = suave(fz - b);
        const arriba = v(a, b) + (v(a + 1, b) - v(a, b)) * tx, abajo = v(a, b + 1) + (v(a + 1, b + 1) - v(a, b + 1)) * tx;
        campo[j * N + i] += peso * (arriba + (abajo - arriba) * tz);
      }
    }
    let media = 0, desv = 0;
    for (const x of campo) media += x;
    media /= campo.length;
    for (const x of campo) desv += (x - media) ** 2;
    desv = Math.sqrt(desv / campo.length);
    for (let k = 0; k < campo.length; k++) datos[k * 4 + c] = Math.round(255 * Math.min(1, Math.max(0, 0.5 + (0.2 * (campo[k] - media)) / desv)));
  }
  const t = new THREE.DataTexture(datos, N, N);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

// Relieve fino por derivadas de pantalla (gradiente de superficie de Mikkelsen): no pide textura de normales ni tangentes.
// Adaptado de Slop New York (mrdoob, MIT): js/tsl-materials.js, bumpNormal.
const relieve = Fn(([altura]) => {
  const h = float(altura).toVar();
  const dpdx = positionView.dFdx(), dpdy = positionView.dFdy();
  const r1 = dpdy.cross(normalView), r2 = normalView.cross(dpdx), det = dpdx.dot(r1);
  return det.abs().mul(normalView).sub(det.sign().mul(h.dFdx().mul(r1).add(h.dFdy().mul(r2)))).normalize();
});

// Suelo de Bogotá con un solo material para todo el terreno (una llamada a la GPU): sabana de kikuyo que se seca hacia
// las afueras, suelo duro donde hay ciudad, parques más verdes, tierra en senderos y calvas, bosque andino con copas y
// eucaliptos en los cerros, roca de arenisca en lo más empinado y páramo arriba de ~3.300 m.
// texturaSuelo (vias.js) trae las máscaras de OpenStreetMap: r = parque 1, cancha ½ · g = bosque 1, senderos ≤ 0,45 ·
// b = plaza 1, parqueadero ½ · agua = r y b a ½ · a = ciudad (edificios y calles).
export function materialTerreno(texturaSuelo) {
  const m = new THREE.MeshStandardNodeMaterial();
  const p = positionWorld.xz, y = positionWorld.y, ruido = texturaRuido();
  // Ruido con rasgos de `tam` metros (16 texeles de la textura), girado para que las escalas no se alineen. Centrado en 0.
  const muestra = (tam, giro) => {
    const c = Math.cos(giro), s = Math.sin(giro);
    return texture(ruido, vec2(p.x.mul(c).sub(p.y.mul(s)), p.x.mul(s).add(p.y.mul(c))).div(tam * 16)).sub(0.5);
  };
  // Manchas de 220 m y 30 m, matas de 3 m, copas de 6 m, macollas de 45 cm y hojas de 12 cm.
  const m1 = muestra(220, 0.4), m2 = muestra(30, 1.3), m3 = muestra(3.2, 2.1), m6 = muestra(6, 4.4);
  const n1 = m1.r, n2 = m2.r, n3 = m3.r, n4 = muestra(0.45, 0.7).r, n5 = muestra(0.12, 2.9).r;

  // Máscaras. Fuera de la caja de datos el borde de la textura se estiraría: se apaga en los últimos ~15 m.
  const c = uv(), borde = min(min(c.x, c.y), min(c.x.oneMinus(), c.y.oneMinus()));
  const s = texture(texturaSuelo, c).mul(smoothstep(0, 0.003, borde));
  const lleno = (v) => smoothstep(0.65, 0.85, v), medio = (v) => smoothstep(0.12, 0.4, v).sub(lleno(v)).max(0);
  const parque = lleno(s.r), bosqueOSM = lleno(s.g), plaza = lleno(s.b);
  const cancha0 = medio(s.r), parqueo0 = medio(s.b), lodo = min(cancha0, parqueo0);
  const cancha = cancha0.sub(lodo), parqueo = parqueo0.sub(lodo);
  const urbano = smoothstep(0.25, 0.6, s.a.add(n2.mul(0.25)).add(n3.mul(0.06)));
  // Muchos andenes están en OpenStreetMap como senderos (footway): en la ciudad casi no dejan tierra.
  const sendero = medio(s.g).mul(mix(float(1), float(0.3), urbano));

  // Zonas por relieve. y = altura sobre la Plaza de Bolívar (2.606 m); pend = tangente de la pendiente.
  const ny = normalWorldGeometry.y, pend = ny.mul(ny).oneMinus().max(0).sqrt().div(ny.max(0.2));
  const alto = smoothstep(50, 150, y.add(n1.mul(60)));
  // Bosque en los cerros, con claros de potrero en las faldas; nunca donde hay casas ni canchas.
  const bosque = max(alto.mul(smoothstep(-0.12, 0, n2.add(alto.mul(0.4)))), smoothstep(0.25, 0.5, pend.add(n2.mul(0.15))))
    .mul(urbano.oneMinus()).mul(cancha.oneMinus());
  const paramo = smoothstep(640, 760, y.add(n1.mul(80)));
  const roca = smoothstep(0.8, 1.15, pend.add(n2.mul(0.3)).add(n3.mul(0.06)));
  // La sabana se seca hacia las afueras y por manchas (kikuyo verde en la ciudad, pajizo lejos).
  const seco = smoothstep(2200, 6500, length(p).add(n1.mul(1500))).add(n1.mul(-0.5).add(n2.mul(0.3))).clamp(0, 1);

  // Colores. tono: manchas de 30 m; brillo: matas, macollas y hojas (se vuelve 1 de lejos con las mipmaps).
  const tono = n2.mul(1.4).add(0.5).clamp(0, 1), brillo = n3.mul(0.35).add(n4.mul(0.3)).add(n5.mul(0.25)).add(1);
  const pasto = mix(mix(color(0x48612c), color(0x6c8139), tono), mix(color(0x8a8350), color(0xa49b62), tono), seco).mul(brillo);
  const cesped = mix(color(0x355c26), color(0x55802f), tono.add(n3).clamp(0, 1)).mul(brillo);
  const canchaCol = color(0x3d7d2f).mul(n4.mul(0.1).add(n2.mul(0.15)).add(1));
  const tierra = mix(color(0x664f3a), color(0x957a5b), smoothstep(-0.25, 0.25, m3.g.add(n4.mul(0.6)))).mul(n5.mul(0.25).add(1));
  // Ciudad: concreto y tierra apisonada, con matas de pasto donde no se pisa.
  const piso = mix(color(0x8a8579), color(0x786a5b), smoothstep(-0.15, 0.2, m2.g.add(n3.mul(0.5)))).mul(n4.mul(0.15).add(n5.mul(0.15)).add(1));
  const ciudad = mix(piso, pasto.mul(0.85), smoothstep(0.1, 0.3, m2.b.add(n3.mul(0.4))).mul(0.7));
  // Bosque: copas claras sobre huecos oscuros; manchas de eucalipto (gris verdoso) y pino (oscuro).
  const copa = smoothstep(-0.2, 0.2, m6.r);
  const especie = mix(mix(color(0x324a27), color(0x5a6a50), smoothstep(0.1, 0.3, m2.b)), color(0x25351f), smoothstep(0.15, 0.35, m2.b.negate()));
  const bosqueCol = mix(color(0x1b2716), especie.mul(n4.mul(0.25).add(1)), copa);
  // Páramo: pajonal con frailejones plateados.
  const paramoCol = mix(mix(color(0x726f47), color(0x96905f), tono), color(0xa5a588), smoothstep(0.15, 0.3, n4).mul(0.6)).mul(brillo);
  // Arenisca en capas de ~5 m, como en Monserrate y Guadalupe; se apagan cuando una capa ya no cabe en un par de píxeles.
  const fase = y.mul(1.3).add(n3.mul(6));
  const capas = fase.sin().mul(0.25).mul(smoothstep(0.6, 1.5, fwidth(fase)).oneMinus());
  const rocaCol = mix(color(0x564f44), color(0x8c826f), smoothstep(-0.3, 0.3, m6.g.add(n4.mul(0.5)).add(capas))).mul(n5.mul(0.25).add(1));
  // Plazas de piedra en losas de 80 cm con juntas (nítidas de cerca, promediadas de lejos) y parqueaderos de asfalto.
  const q = p.div(0.8), nitido = smoothstep(0.03, 0.1, fwidth(q.x).mul(0.8)).oneMinus();
  const junta = smoothstep(0.45, 0.48, max(abs(fract(q.x).sub(0.5)), abs(fract(q.y).sub(0.5)))).mul(nitido);
  const plazaCol = mix(color(0xb2a891), color(0x9a917d), azar(floor(q)).sub(0.5).mul(nitido).add(0.5))
    .mul(n3.mul(0.2).add(1)).mul(junta.mul(-0.3).add(1));
  const asfalto = vec3(0.05, 0.051, 0.054).mul(n3.mul(0.4).add(n4.mul(0.3)).add(1));

  // Calvas de tierra en el pasto: más en la sabana seca, pocas en los parques y ninguna en las canchas.
  const calva = smoothstep(0.14, 0.26,n2.mul(0.6).add(n3.mul(0.4)).add(n4.mul(0.15)))
    .mul(mix(mix(float(0.55), float(0.85), seco), float(0.2), parque)).mul(cancha.oneMinus());

  // Capas de abajo hacia arriba: [peso, color, altura del relieve fino (m), rugosidad].
  const hPasto = n3.mul(0.04).add(n4.mul(0.015)).add(n5.mul(0.004));
  let col = pasto, h = hPasto, rug = float(0.96);
  for (const [w, cw, hw, rw] of [
    [urbano, ciudad, n4.mul(0.004), 0.9],
    [parque, cesped, hPasto, 0.95],
    [cancha, canchaCol, n4.mul(0.003), 0.9],
    [calva, tierra, n4.mul(0.01).add(n5.mul(0.003)), 0.92],
    [max(bosque, bosqueOSM), bosqueCol, copa.mul(0.8), 0.95],
    [paramo, paramoCol, hPasto.mul(1.5), 0.95],
    [roca, rocaCol, n3.mul(0.25).add(n4.mul(0.04)).add(capas.mul(0.4)), 0.85],
    [sendero, tierra, n5.mul(0.003), 0.92],
    [plaza, plazaCol, junta.mul(-0.006), 0.8],
    [parqueo, asfalto, n4.mul(0.002), 0.85],
    [lodo, color(0x3a3226), float(0), 0.5],
  ]) {
    col = mix(col, cw, w);
    h = mix(h, hw, w);
    rug = mix(rug, float(rw), w);
  }
  m.colorNode = col;
  m.roughnessNode = rug;
  m.normalNode = relieve(h);
  // El pasto es un manto de hojas que se tapan entre sí, no un plano: con el brillo normal (F0 0,04 que sube a 1 al
  // rasante) refleja el cielo y se ve azulado de lejos. Adaptado de Slop New York (mrdoob, MIT): js/tsl-materials.js.
  m.setupSpecular = () => {
    specularColor.assign(vec3(0.025));
    specularColorBlended.assign(vec3(0.025));
    specularF90.assign(0.3);
  };
  return m;
}

// Azar por celda sin seno (hash12 de Dave Hoskins): el seno de números grandes cambia de una GPU a otra.
function azar(q) {
  const a = fract(vec3(q.x, q.y, q.x).mul(0.1031));
  const b = a.add(dot(a, a.yzx.add(33.33)));
  return fract(b.x.add(b.y).mul(b.z));
}
