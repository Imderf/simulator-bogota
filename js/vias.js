import * as THREE from 'three/webgpu';
import { attribute, vertexColor, positionWorld, cameraPosition, normalize, mx_noise_float, fwidth, fract, abs, pow, clamp, smoothstep, step, mix, max, float, vec2, vec3, uniform } from 'three/tsl';
import { cargarBinario } from './binario.js';

const Q = 0.5;
// troncal, principal, secundaria, local, servicio, peatonal, ciclorruta, escalera, sendero
const ANCHO = [14, 10, 7.5, 6.5, 4.5, 9, 2.5, 2.5, 2.5];
const ANDEN = [3.5, 3.5, 3, 2.2, 0];
const COLOR = [0x3b3c3e, 0x404143, 0x46474a, 0x4c4d50, 0x55565a, 0xa69d8f, 0x8c3f36, 0x9c958a, 0xa69d8f].map((c) => new THREE.Color(c));
const ALTO = [0.5, 0.48, 0.46, 0.44, 0.42, 0.4, 0.43, 0.4, 0.39];
const BORDILLO = 0.15;

// Ancho real: por carriles si OpenStreetMap los dice (3,2 m; 3,5 m los de TransMilenio), si no, por clase.
export const anchoVia = (v) => (v.clase <= 4 && v.carriles ? v.carriles * (v.bus ? 3.5 : 3.2) + 0.6 : v.bus ? 7 : ANCHO[v.clase]);
export const andenVia = (v) => (v.bus ? 0 : ANDEN[v.clase] || 0);
// Altura de la cinta sobre el terreno (se levanta para que el relieve de 32 m no la atraviese) y del bordillo.
export const altoVia = (v) => ALTO[v.clase];
export { BORDILLO };

// BOV2 trae además, por vía, sentido y uso (ver banderasVia en tools/construir-centro.mjs) y número de carriles.
// Las de un solo sentido quedan dibujadas en el sentido en que se maneja.
export async function cargarLineas(url, firma) {
  const [meta, xs, zs] = await cargarBinario(url, firma);
  const n = meta.uint(), lista = new Array(n);
  let x = 0, z = 0;
  for (let k = 0; k < n; k++) {
    const clase = meta.uint(), b = firma === 'BOV2' ? meta.uint() : 0, carriles = firma === 'BOV2' ? meta.uint() : 0, p = [];
    for (let i = meta.uint(); i > 0; i--) { x += xs.int(); z += zs.int(); p.push([x * Q, z * Q]); }
    if (b & 2) p.reverse();
    lista[k] = { clase, p, unSentido: !!(b & 1), bus: !!(b & 4), carriles };
  }
  return lista;
}

// Calzadas de carros con asfalto y marcas por shader, andenes con bordillo que se cortan en los cruces, y el resto
// (peatonales, ciclorrutas, escaleras, senderos) como cintas de color. Todo partido cada 12 m para seguir el relieve.
export function mallaVias(vias, terreno) {
  const grupo = new THREE.Group();
  grupo.name = 'Vias';
  grupo.add(calzadas(vias.filter((v) => v.clase <= 4), terreno));
  grupo.add(cintas(vias.filter((v) => v.clase > 4), terreno));
  return grupo;
}

function calzadas(vias, terreno) {
  // Cruces: vértices donde llegan tres o más tramos de vías de carros. Su radio despeja la vía más ancha y su andén.
  const cruces = new Map(), k = (x, z) => `${x},${z}`;
  for (const v of vias) {
    const r = anchoVia(v) / 2 + andenVia(v);
    v.p.forEach(([x, z], i) => {
      const c = cruces.get(k(x, z)) || { n: 0, r: 0 };
      c.n += (i > 0) + (i < v.p.length - 1);
      c.r = Math.max(c.r, r);
      cruces.set(k(x, z), c);
    });
  }
  const pos = [], via = [], tipo = [], aPos = [], aCol = [];
  const CEMENTO = new THREE.Color(0xb3ada3), BORDE = new THREE.Color(0xcfcac0);
  for (const v of vias) {
    const w = anchoVia(v) / 2, an = andenVia(v), dy = ALTO[v.clase];
    // codigo: 0 sin marcas, 1 un sentido, 2 doble sentido, 3 TransMilenio. Bordes blancos en las avenidas.
    const codigo = v.bus ? 3 : v.clase === 4 ? 0 : v.unSentido ? 1 : 2, bordes = v.clase <= 2 && !v.bus ? 1 : 0;
    // Distancia a lo largo de la vía y cruces sobre ella.
    const us = [0];
    for (let i = 1; i < v.p.length; i++) us.push(us[i - 1] + Math.hypot(v.p[i][0] - v.p[i - 1][0], v.p[i][1] - v.p[i - 1][1]));
    const nodos = [];
    v.p.forEach(([x, z], i) => { const c = cruces.get(k(x, z)); if (c.n >= 3) nodos.push([us[i], c.r]); });
    // ext: metros fuera del cruce más cercano (negativo adentro). Sirve para cortar andenes y pintar cebras.
    const ext = (u) => nodos.reduce((m, [un, r]) => Math.min(m, Math.abs(u - un) - r), 999);
    for (let i = 0; i < v.p.length - 1; i++) {
      const [ax, az] = v.p[i], [bx, bz] = v.p[i + 1], l = us[i + 1] - us[i];
      if (l < 0.01) continue;
      const ux = (bx - ax) / l, uz = (bz - az) / l, nx = -uz, nz = ux;
      // Puntos de corte: cada 12 m más los bordes de cruces y cebras, y el punto medio entre dos cruces.
      const ts = new Set([0, l]);
      for (let s = 12; s < l; s += 12) ts.add(s);
      for (const [un, r] of nodos) for (const d of [-r - 3.6, -r - 0.6, -r, r, r + 0.6, r + 3.6]) { const s = un + d - us[i]; if (s > 0 && s < l) ts.add(s); }
      for (let j = 0; j < nodos.length - 1; j++) { const s = (nodos[j][0] + nodos[j][1] + nodos[j + 1][0] - nodos[j + 1][1]) / 2 - us[i]; if (s > 0 && s < l) ts.add(s); }
      const lista = [...ts].sort((a, b) => a - b);
      for (let j = 0; j < lista.length - 1; j++) {
        const s0 = lista[j], s1 = lista[j + 1];
        const x0 = ax + ux * s0, z0 = az + uz * s0, x1 = ax + ux * s1, z1 = az + uz * s1;
        const y0 = terreno.altura(x0, z0) + dy, y1 = terreno.altura(x1, z1) + dy;
        const e0 = ext(us[i] + s0), e1 = ext(us[i] + s1);
        // Calzada: un borde en -w y el otro en +w (n apunta a la derecha del sentido del dibujo).
        const q = [[x0 - nx * w, y0, z0 - nz * w, -w, us[i] + s0, e0], [x1 - nx * w, y1, z1 - nz * w, -w, us[i] + s1, e1],
          [x1 + nx * w, y1, z1 + nz * w, w, us[i] + s1, e1], [x0 + nx * w, y0, z0 + nz * w, w, us[i] + s0, e0]];
        for (const t of [0, 2, 1, 0, 3, 2]) {
          const [x, y, z, lat, u, e] = q[t];
          pos.push(x, y, z); via.push(u, lat, w, e); tipo.push(v.carriles, codigo, bordes);
        }
        // Andenes a lado y lado, fuera de los cruces: bordillo vertical y superficie un poco más alta.
        if (!an || e0 < -0.01 || e1 < -0.01) continue;
        for (const lado of [-1, 1]) {
          const ix0 = x0 - nx * w * lado, iz0 = z0 - nz * w * lado, ix1 = x1 - nx * w * lado, iz1 = z1 - nz * w * lado;
          const ox0 = x0 - nx * (w + an) * lado, oz0 = z0 - nz * (w + an) * lado, ox1 = x1 - nx * (w + an) * lado, oz1 = z1 - nz * (w + an) * lado;
          const t0 = y0 + BORDILLO, t1 = y1 + BORDILLO;
          const o0 = Math.max(t0, terreno.altura(ox0, oz0) + dy + BORDILLO), o1 = Math.max(t1, terreno.altura(ox1, oz1) + dy + BORDILLO);
          const caras = [
            [[ix0, y0, iz0], [ix1, y1, iz1], [ix1, t1, iz1], [ix0, t0, iz0], BORDE],
            [[ix0, t0, iz0], [ix1, t1, iz1], [ox1, o1, oz1], [ox0, o0, oz0], CEMENTO],
          ];
          for (const [a, b, c, d, color] of caras) {
            // Orden según el lado para que la normal mire hacia afuera y hacia arriba.
            const tri = lado > 0 ? [a, b, c, a, c, d] : [a, c, b, a, d, c];
            for (const p of tri) { aPos.push(...p); aCol.push(color.r, color.g, color.b); }
          }
        }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('via', new THREE.Float32BufferAttribute(via, 4));
  g.setAttribute('tipo', new THREE.Float32BufferAttribute(tipo, 3));
  g.computeVertexNormals();
  const calzada = new THREE.Mesh(g, materialAsfalto());
  calzada.receiveShadow = true;
  const ga = new THREE.BufferGeometry();
  ga.setAttribute('position', new THREE.Float32BufferAttribute(aPos, 3));
  ga.setAttribute('color', new THREE.Float32BufferAttribute(aCol, 3));
  ga.computeVertexNormals();
  const matAnden = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.92 });
  // Losetas de 40 cm apenas marcadas y manchas grandes, para que el andén no sea un plano liso.
  const pa = positionWorld.xz, junta = max(abs(fract(pa.x.div(0.4)).sub(0.5)), abs(fract(pa.y.div(0.4)).sub(0.5)));
  matAnden.colorNode = vertexColor().mul(mx_noise_float(pa.mul(0.15)).mul(0.08).add(0.96))
    .mul(mix(float(1), float(0.88), smoothstep(0.44, 0.49, junta).mul(float(1).sub(smoothstep(0.02, 0.06, fwidth(pa.x))))));
  const andenes = new THREE.Mesh(ga, matAnden);
  andenes.receiveShadow = true;
  andenes.castShadow = true;
  const grupo = new THREE.Group();
  grupo.add(calzada, andenes);
  return grupo;
}

// Asfalto con manchas y parches; marcas viales en pintura blanca y amarilla. Las líneas se suavizan al tamaño del
// píxel y se desvanecen de lejos para no parpadear. En los cruces no se pintan líneas, solo las cebras al llegar.
function materialAsfalto() {
  const via = attribute('via', 'vec4'), tipo = attribute('tipo', 'vec3');
  const u = via.x, v = via.y, w = via.z, ext = via.w, carriles = tipo.x, codigo = tipo.y, bordes = tipo.z;
  const p = positionWorld.xz, fw = max(fwidth(v), 0.001);
  const linea = (x, ancho) => float(1).sub(smoothstep(float(ancho / 2).sub(fw), float(ancho / 2).add(fw), abs(x)));
  const tramos = (largo, periodo) => step(fract(u.div(periodo)), largo / periodo);
  const fuera = smoothstep(-0.3, 0.3, ext);
  const borde = linea(abs(v).sub(w).add(0.35), 0.12).mul(bordes);
  // Entre carriles de una vía de un sentido: blanco discontinuo.
  const ancho = w.mul(2).div(max(carriles, 1)), kc = v.add(w).div(ancho);
  const entre = linea(fract(kc.add(0.5)).sub(0.5).mul(ancho), 0.12).mul(step(0.5, kc)).mul(step(kc, carriles.sub(0.5)))
    .mul(tramos(3, 8)).mul(step(0.5, codigo)).mul(step(codigo, 1.5));
  // Eje de una vía de doble sentido: doble línea amarilla en avenidas, discontinua en calles locales.
  const eje = mix(linea(v, 0.12).mul(tramos(3, 8)), max(linea(v.sub(0.12), 0.1), linea(v.add(0.12), 0.1)), bordes)
    .mul(step(1.5, codigo)).mul(step(codigo, 2.5));
  const cebra = step(0.6, ext).mul(step(ext, 3.6)).mul(step(fract(v.div(1.1)), 0.55)).mul(step(abs(v), w.sub(0.3)))
    .mul(step(0.5, codigo)).mul(step(codigo, 2.5));
  const nitido = float(1).sub(smoothstep(0.15, 0.6, fw));
  const blanco = max(max(borde, entre).mul(fuera), cebra).mul(nitido), amarillo = eje.mul(fuera).mul(nitido);
  const ruido = mx_noise_float(p.mul(0.07)).mul(0.6).add(mx_noise_float(p.mul(0.8)).mul(0.25)).add(mx_noise_float(p.mul(6)).mul(0.15));
  // Parches de reparcheo más oscuros.
  const parche = smoothstep(0.55, 0.6, mx_noise_float(p.mul(0.045).add(7.3)));
  const asfalto = vec3(0.05, 0.051, 0.054).mul(ruido.mul(0.22).add(1)).mul(float(1).sub(parche.mul(0.25)));
  const concreto = vec3(0.27, 0.262, 0.245).mul(ruido.mul(0.12).add(1));
  // Calle mojada (Adaptado de Slop New York, mrdoob, MIT: tsl-materials.js, roadPuddleField y roadWetMasks): el agua
  // se junta primero en las partes bajas de un campo de ruido; con `mojado` aparecen manchas húmedas, una película
  // y charcos que reflejan como espejo (el SSR del postproceso pone ahí las luces y el cielo).
  const n01 = (q) => mx_noise_float(q).mul(0.5).add(0.5);
  const campo = n01(p.mul(vec2(0.095, 0.075))).mul(0.52).add(n01(p.mul(vec2(0.25, 0.22)).add(vec2(19.4, 11.8))).mul(0.34))
    .add(n01(p.mul(0.68).add(vec2(-7.3, 29.1))).mul(0.14));
  const nivel = mix(float(0.86), float(0.56), clamp(mojado.sub(0.1).div(0.55), 0, 1));
  const humedo = smoothstep(nivel.sub(0.09), nivel.sub(0.015), campo);
  const charco = smoothstep(nivel, nivel.add(0.022), campo).mul(smoothstep(0.1, 0.22, mojado));
  const pelicula = smoothstep(0.2, 0.8, mojado);
  const vista = normalize(cameraPosition.sub(positionWorld));
  const fresnel = pow(float(1).sub(abs(vista.y)), 5).mul(0.98).add(0.02);
  const m = new THREE.MeshStandardNodeMaterial({ polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const base = mix(asfalto, concreto, step(2.5, codigo));
  const pintado = mix(mix(base, vec3(0.72, 0.72, 0.7), blanco.mul(0.9)), vec3(0.78, 0.55, 0.06), amarillo.mul(0.9));
  m.colorNode = pintado.mul(mix(mix(float(1), float(0.72), humedo), float(0.6), charco)).mul(mix(float(1), float(0.8), pelicula));
  const seco = mix(float(0.93), float(0.6), max(blanco, amarillo));
  m.roughnessNode = mix(mix(mix(seco, float(0.68), pelicula.mul(0.7)), float(0.4), humedo.mul(0.85)), float(0.1), charco);
  m.metalnessNode = clamp(fresnel.mul(1.6), 0, 0.85).mul(max(charco, max(humedo.mul(0.35), pelicula.mul(0.15))));
  return m;
}

// Qué tan mojadas están las calles: 0 seco, 1 recién llovió. Lo pone main.js según la hora.
export const mojado = uniform(0.1);

// Cintas apoyadas en el terreno, partidas cada 12 m para que sigan el relieve.
function cintas(vias, terreno) {
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

// Máscaras del suelo para materialTerreno (terreno.js), pintadas en canvas desde OpenStreetMap. No hay imágenes.
// r: parque 1, cancha ½ · g: bosque 1, senderos ≤ 0,45 · b: plaza 1, parqueadero ½ · agua: r y b a ½ (lodo bajo el
// agua) · a: ciudad (cerca de edificios y calles de carros). Cada clase tapa a las anteriores, en el orden de abajo.
const CODIGO_SUELO = ['#ff0000', '#00ff00', '#800080', '#800000', '#000080', '#0000ff'];
export function texturaSuelo(suelo, caja, { vias = [], edificios = [], lado = 2048 } = {}) {
  const lienzo = document.createElement('canvas');
  lienzo.width = lienzo.height = lado;
  const ctx = lienzo.getContext('2d');
  const sx = lado / (caja.x1 - caja.x0), sz = lado / (caja.z1 - caja.z0);
  // Se dibuja en metros del mundo: el marco del lienzo hace la conversión, también de los anchos de línea.
  const metros = (c, k) => c.setTransform(sx * k, 0, 0, sz * k, -caja.x0 * sx * k, -caja.z0 * sz * k);
  const trazo = (c, p, cerrar) => { p.forEach(([x, z], i) => c[i ? 'lineTo' : 'moveTo'](x, z)); if (cerrar) c.closePath(); };
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, lado, lado);
  metros(ctx, 1);
  for (const orden of [0, 1, 3, 4, 5, 2]) {
    ctx.fillStyle = CODIGO_SUELO[orden];
    // Uno por uno: dos polígonos de la misma clase que se traslapan con giro contrario dejarían un hueco en un solo fill.
    for (const { clase, p } of suelo) if (clase === orden) { ctx.beginPath(); trazo(ctx, p, true); ctx.fill(); }
  }
  // Senderos (footway, path, track): tierra, con un halo de pasto pisado. 'lighten' toma el máximo por canal: no borra
  // el parque de abajo, no se nota dentro del bosque y no se acumula donde se cruzan.
  ctx.globalCompositeOperation = 'lighten';
  ctx.lineCap = ctx.lineJoin = 'round';
  for (const [estilo, extra] of [['#003200', 4], ['#007300', 0]]) {
    ctx.strokeStyle = estilo;
    ctx.lineWidth = ANCHO[8] + extra;
    ctx.beginPath();
    for (const v of vias) if (v.clase === 8) trazo(ctx, v.p, false);
    ctx.stroke();
  }
  const datos = ctx.getImageData(0, 0, lado, lado).data;

  // Canal a: dónde hay ciudad. Edificios y calles a un cuarto de resolución; al ampliarlos con suavizado quedan
  // borrosos, y el suelo duro se desvanece hacia el pasto lejos de las casas. Sin edificios todo cuenta como ciudad.
  const chico = document.createElement('canvas');
  chico.width = chico.height = lado / 4;
  const c2 = chico.getContext('2d');
  c2.fillStyle = edificios.length ? '#000' : '#fff';
  c2.fillRect(0, 0, lado / 4, lado / 4);
  metros(c2, 1 / 4);
  c2.fillStyle = c2.strokeStyle = '#fff';
  c2.beginPath();
  for (const e of edificios) trazo(c2, e.anillos[0], true);
  c2.fill();
  c2.lineCap = c2.lineJoin = 'round';
  for (let clase = 0; clase <= 5; clase++) {
    c2.lineWidth = ANCHO[clase] + 2 * (ANDEN[clase] || 0) + 6;
    c2.beginPath();
    for (const v of vias) if (v.clase === clase) trazo(c2, v.p, false);
    c2.stroke();
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'copy';
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(chico, 0, 0, lado, lado);
  const ciudad = ctx.getImageData(0, 0, lado, lado).data;
  for (let k = 3; k < datos.length; k += 4) datos[k] = ciudad[k - 3];

  // Datos, no color: sin espacio de color, con mipmaps para que de lejos se promedien.
  const t = new THREE.DataTexture(new Uint8Array(datos.buffer), lado, lado);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}
