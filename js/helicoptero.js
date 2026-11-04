import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LoftGeometry } from 'three/addons/geometries/LoftGeometry.js';
import { positionGeometry, normalGeometry, vec2, vec3, float, color, abs, max, min, length, fwidth, smoothstep, step, mix, uniform } from 'three/tsl';
import { noche } from './edificios.js';

// Helicóptero turístico: fuselaje y capó en loft suavizado, cabina panorámica con ventanas por shader, cola con
// aletas, patines de tubo y rotores con disco de desenfoque.
// Adaptado de Slop New York (mrdoob, MIT): js/helicopter.js (formas y medidas) y js/controllers.js (rotores,
// luces y vuelo). Las medidas de allá miran hacia +z: todo se arma así dentro de `cuerpo`, que se gira 180°
// para que el modelo mire hacia -z como los carros. Ojo: dentro de `cuerpo` la izquierda del piloto es +x.

const C = (hex) => new THREE.Color(hex);
const BLANCO = 0xf3f5f7, AMARILLO = 0xfcd116, AZUL = 0x1d3f8f;
const OSCURO = C(0x2a2e33), METAL = C(0x4a5058), PALA = C(0x1e232a);
const PISO = 0.3, TECHO = 450; // altura mínima (aterrizado) y máxima sobre el terreno

function pintar(g, color) {
  g = g.index ? g.toNonIndexed() : g;
  g.deleteAttribute('uv');
  const n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set([color.r, color.g, color.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

// Sección de 12 puntos: panza plana, costados anchos de cabina panorámica y techo abombado.
function seccion([z, ancho, abajo, arriba, panza = 0.68, hombro = 0.52]) {
  const h = Math.max(0.08, arriba - abajo);
  const der = [[ancho * panza * 0.55, abajo], [ancho * 0.92, abajo + h * 0.16], [ancho, abajo + h * hombro],
    [ancho * 0.88, abajo + h * 0.86], [ancho * 0.46, arriba - h * 0.03], [0, arriba]];
  const izq = der.slice(0, 5).reverse().map(([x, y]) => [-x, y]);
  return [[0, abajo], ...der, ...izq].reverse().map(([x, y]) => new THREE.Vector3(x, y, z));
}

// Las pocas secciones de referencia se remuestrean con curvas: cada una alrededor (cerrada) y luego cada costura a
// lo largo. Sale una superficie lisa sin facetas, con muchos menos números que modelar.
function loftSuave(perfil, alrededor, alLargo) {
  const anillos = perfil.map((s) => new THREE.CatmullRomCurve3(seccion(s), true, 'centripetal').getPoints(alrededor).slice(0, alrededor));
  const costuras = anillos[0].map((_, j) => new THREE.CatmullRomCurve3(anillos.map((a) => a[j]), false, 'centripetal').getPoints(alLargo - 1));
  return new LoftGeometry(costuras[0].map((_, i) => costuras.map((c) => c[i])), { capStart: true, capEnd: true });
}

// Perfil de ala de 6 puntos (aleta vertical y winglets). El orden deja las normales hacia afuera; en el original
// las aletas quedaban al revés.
const perfilAla = (x, y, z, grueso, cuerda) => [
  [x, y, z + cuerda * 0.5], [x + grueso, y, z + cuerda * 0.18], [x + grueso * 0.65, y, z - cuerda * 0.25],
  [x, y, z - cuerda * 0.5], [x - grueso * 0.65, y, z - cuerda * 0.25], [x - grueso, y, z + cuerda * 0.18],
].map(([a, b, c]) => new THREE.Vector3(a, b, c));

// ---------------------------------------------------------------------------------------------------------------
// Geometrías (en el marco de referencia: nariz hacia +z, base de los patines cerca de y = 0,01).
// ---------------------------------------------------------------------------------------------------------------
function geometriaFuselaje() {
  // [z, medio ancho, abajo, arriba, panza, hombro]: de la nariz (z = 2,82) a la punta de la cola (z = −5,85).
  const fuselaje = loftSuave([
    [2.82, 0.16, 0.88, 1.02, 0.5, 0.5], [2.62, 0.54, 0.72, 1.18, 0.62, 0.48], [2.2, 0.88, 0.58, 1.48, 0.72, 0.46],
    [1.55, 1.1, 0.52, 1.86, 0.78, 0.44], [0.75, 1.16, 0.5, 2.02, 0.8, 0.45], [-0.15, 1.14, 0.5, 2.02, 0.8, 0.46],
    [-0.95, 1.02, 0.54, 1.96, 0.74, 0.5], [-1.65, 0.74, 0.72, 1.84, 0.62, 0.54], [-2.35, 0.42, 1.12, 1.74, 0.45, 0.55],
    [-3.25, 0.31, 1.24, 1.72, 0.4, 0.55], [-4.35, 0.24, 1.32, 1.7, 0.38, 0.55], [-5.35, 0.18, 1.38, 1.68, 0.36, 0.55],
    [-5.85, 0.12, 1.43, 1.65, 0.35, 0.55],
  ], 32, 44);
  // Capó de las turbinas y base del mástil.
  const capo = loftSuave([
    [0.55, 0.32, 1.94, 2.12, 0.85, 0.45], [0.1, 0.56, 1.96, 2.38, 0.85, 0.48], [-0.55, 0.62, 1.94, 2.44, 0.85, 0.5],
    [-1.25, 0.56, 1.88, 2.36, 0.82, 0.5], [-1.85, 0.38, 1.76, 2.1, 0.78, 0.5], [-2.28, 0.2, 1.68, 1.82, 0.7, 0.5],
  ], 24, 14);
  return mergeGeometries([fuselaje, capo]);
}

function geometriaPartes() {
  const p = [];
  const azul = C(AZUL);
  // Aleta vertical en flecha (con aleta ventral) y estabilizador horizontal con winglets.
  p.push(pintar(new LoftGeometry([[-0.02, 0.88, -5.28, 0.05, 0.44], [0, 1.48, -5.25, 0.12, 0.88], [0, 1.95, -5.52, 0.1, 0.76],
    [0, 2.48, -5.82, 0.08, 0.6], [0, 2.82, -6.04, 0.05, 0.42]].map((s) => perfilAla(...s)), { capStart: true, capEnd: true }), azul));
  p.push(pintar(new LoftGeometry([-1.08, -0.55, 0, 0.55, 1.08].map((x) => {
    const k = 1 - Math.abs(x) * 0.24, cuerda = 0.46 * k, g = 0.045 * k, y = 1.54, z = -4.22 - Math.abs(x) * 0.12;
    return [[x, y, z + cuerda * 0.5], [x, y + g, z + cuerda * 0.15], [x, y + g * 0.6, z - cuerda * 0.25],
      [x, y, z - cuerda * 0.5], [x, y - g * 0.6, z - cuerda * 0.25], [x, y - g, z + cuerda * 0.15]].map((v) => new THREE.Vector3(...v)).reverse();
  }), { capStart: true, capEnd: true }), azul));
  for (const s of [-1, 1]) {
    p.push(pintar(new LoftGeometry([[-0.22, 0.028, 0.3], [0, 0.036, 0.38], [0.26, 0.024, 0.26]].map(([dy, g, cuerda]) =>
      perfilAla(s * (1.08 + Math.abs(dy) * 0.12), 1.54 + dy, -4.35 - Math.abs(dy) * 0.15, g, cuerda)), { capStart: true, capEnd: true }), azul));
    // Patín con la punta levantada, estribo para subir y travesaños en arco bajo la panza.
    const x = s * 1.12;
    const patin = new THREE.CatmullRomCurve3([[x, 0.28, 2.15], [x, 0.12, 1.88], [x, 0.07, 1.45], [x, 0.07, 0], [x, 0.07, -1.45], [x, 0.12, -1.75]].map((v) => new THREE.Vector3(...v)));
    p.push(pintar(new THREE.TubeGeometry(patin, 24, 0.046, 8), OSCURO));
    p.push(pintar(new THREE.BoxGeometry(0.14, 0.03, 0.88).translate(s * 1.02, 0.28, 0.42), OSCURO));
    // Escapes de las turbinas, atrás del capó.
    p.push(pintar(new THREE.CylinderGeometry(0.1, 0.125, 0.34, 12).rotateX(Math.PI * 0.46).rotateY(s * 0.1).translate(s * 0.24, 2.08, -1.72), METAL));
  }
  for (const z of [1.05, -0.82]) {
    const arco = new THREE.CatmullRomCurve3([[-1.12, 0.09], [-0.92, 0.42], [-0.62, 0.56], [0.62, 0.56], [0.92, 0.42], [1.12, 0.09]].map(([x, y]) => new THREE.Vector3(x, y, z)));
    p.push(pintar(new THREE.TubeGeometry(arco, 16, 0.044, 8), OSCURO));
  }
  p.push(pintar(new THREE.CylinderGeometry(0.015, 0.025, 0.35, 6).rotateX(Math.PI / 2).translate(0, 0.88, 2.88), OSCURO)); // pitot
  return mergeGeometries(p);
}

// Rotor principal de 4 palas con puntas amarillas (seguridad), mástil, plato y cubo.
function geometriaRotor() {
  const p = [
    pintar(new THREE.CylinderGeometry(0.11, 0.14, 0.52, 12).translate(0, -0.18, 0), OSCURO),
    pintar(new THREE.CylinderGeometry(0.24, 0.26, 0.08, 14).translate(0, -0.12, 0), METAL),
    pintar(new THREE.SphereGeometry(0.28, 14, 8).scale(1, 0.42, 1).translate(0, 0.04, 0), OSCURO),
  ];
  for (let b = 0; b < 4; b++) {
    const a = (b * Math.PI) / 2;
    p.push(pintar(new THREE.BoxGeometry(0.65, 0.045, 0.14).translate(0.52, 0, 0).rotateY(a), METAL));
    p.push(pintar(new THREE.BoxGeometry(4.25, 0.024, 0.26).rotateX(0.08).translate(2.58, 0, 0).rotateY(a), PALA));
    p.push(pintar(new THREE.BoxGeometry(0.2, 0.024, 0.26).rotateX(0.08).translate(4.805, 0, 0).rotateY(a), C(AMARILLO)));
  }
  return mergeGeometries(p);
}

function geometriaRotorCola() {
  const p = [pintar(new THREE.CylinderGeometry(0.09, 0.09, 0.18, 10).rotateZ(Math.PI / 2), METAL)];
  for (let b = 0; b < 4; b++) {
    const a = (b * Math.PI) / 2;
    p.push(pintar(new THREE.BoxGeometry(0.022, 0.66, 0.13).translate(0, 0.37, 0).rotateX(a), PALA));
    p.push(pintar(new THREE.BoxGeometry(0.022, 0.1, 0.13).translate(0, 0.75, 0).rotateX(a), C(AMARILLO)));
  }
  return mergeGeometries(p);
}

// ---------------------------------------------------------------------------------------------------------------
// Material del fuselaje: pintura blanca con franjas amarilla y azul, y vidrios dibujados con rectángulos redondeados
// (SDF con borde suavizado al tamaño del píxel). Todo en coordenadas de la geometría.
// ---------------------------------------------------------------------------------------------------------------
function materialFuselaje() {
  const p = positionGeometry, n = normalGeometry;
  const rect = (u, v, mu, mv, r) => {
    const q = abs(vec2(u, v)).sub(vec2(mu, mv)).add(r);
    const d = length(max(q, vec2(0))).add(min(max(q.x, q.y), 0)).sub(r);
    const e = max(fwidth(d), 0.001);
    return float(1).sub(smoothstep(e.negate(), e, d));
  };
  const parabrisas = rect(p.z.sub(1.74), p.y.sub(1.42), 0.76, 0.42, 0.14).mul(step(0.65, p.z)).mul(smoothstep(0.022, 0.036, abs(p.x)));
  const menton = rect(abs(p.x).sub(0.28), p.y.sub(0.84), 0.19, 0.11, 0.04).mul(step(1.9, p.z)); // ventanas a los pies
  const lateral = rect(p.z.sub(0.12), p.y.sub(1.38), 0.88, 0.34, 0.1).mul(step(0.45, abs(n.x)));
  const claraboya = rect(abs(p.x).sub(0.32), p.z.sub(1.25), 0.2, 0.38, 0.06).mul(step(1.72, p.y));
  const pilares = smoothstep(0.028, 0.044, abs(p.z.sub(1.06))).mul(smoothstep(0.026, 0.042, abs(p.z.sub(0.08))));
  const vidrio = max(max(parabrisas, lateral), max(menton, claraboya)).mul(pilares);

  // Franjas que bajan hacia la nariz y siguen por el botalón de cola.
  const linea = float(1).sub(p.z.mul(0.085)), e = max(fwidth(p.y), 0.004);
  const banda = (centro, medio) => float(1).sub(smoothstep(medio.sub(e), e.add(medio), abs(p.y.sub(centro))));
  const amarilla = banda(linea, float(0.05)), azul = banda(linea.sub(0.085), float(0.025));
  // Juntas de las puertas y rejilla de entrada de aire en el capó.
  const junta = (z) => float(1).sub(smoothstep(0.004, 0.012, abs(p.z.sub(z))));
  const juntas = max(junta(1.06), max(junta(0.08), junta(-0.82))).mul(step(0.55, abs(n.x))).mul(step(0.6, p.y)).mul(step(p.y, 1.75));
  const rejilla = rect(p.z.add(0.45), p.y.sub(2.18), 0.52, 0.13, 0.04).mul(step(0.35, abs(n.x)));

  let pintura = mix(mix(color(BLANCO), color(AMARILLO), amarilla), color(AZUL), azul).mul(float(1).sub(juntas.mul(0.45)));
  pintura = mix(pintura, color(0x1a1d22), rejilla);
  const cristal = mix(color(0x0f1c2a), color(0x2a4a66), n.y.mul(0.5).add(0.5));

  const m = new THREE.MeshStandardNodeMaterial();
  m.colorNode = mix(pintura, cristal, vidrio);
  m.roughnessNode = mix(float(0.25), float(0.05), vidrio);
  m.metalnessNode = mix(float(0.15), float(0.5), vidrio);
  m.emissiveNode = vec3(1, 0.85, 0.6).mul(vidrio).mul(noche).mul(0.25); // cabina con luz tenue de noche
  return m;
}

const MAT_PARTES = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.2 });
let geos = null; // se arman una vez

export function crearHelicoptero() {
  geos ??= { fuselaje: geometriaFuselaje(), partes: geometriaPartes(), rotor: geometriaRotor(), cola: geometriaRotorCola() };
  const raiz = new THREE.Group();
  raiz.name = 'Helicoptero';
  const cuerpo = new THREE.Group();
  cuerpo.rotation.y = Math.PI;
  geos.partes.computeBoundingBox();
  cuerpo.position.y = -geos.partes.boundingBox.min.y; // la base de los patines queda en y = 0
  raiz.add(cuerpo);
  const malla = (g, m, padre, sombra = true) => {
    const x = new THREE.Mesh(g, m);
    x.castShadow = sombra;
    x.receiveShadow = sombra;
    padre.add(x);
    return x;
  };
  malla(geos.fuselaje, materialFuselaje(), cuerpo);
  malla(geos.partes, MAT_PARTES, cuerpo);

  // Rotores. El disco translúcido se vuelve visible con las revoluciones, como la estela de las palas.
  const desenfoque = uniform(0);
  const matDisco = new THREE.MeshBasicNodeMaterial({ color: 0xc8d2dc, transparent: true, side: THREE.DoubleSide, depthWrite: false });
  matDisco.opacityNode = desenfoque;
  const rotor = new THREE.Group();
  rotor.position.set(0, 2.66, -0.35);
  malla(geos.rotor, MAT_PARTES, rotor);
  malla(new THREE.RingGeometry(0.4, 4.9, 48).rotateX(-Math.PI / 2), matDisco, rotor, false);
  const cola = new THREE.Group();
  cola.position.set(0.18, 2.02, -5.62);
  malla(geos.cola, MAT_PARTES, cola);
  malla(new THREE.CircleGeometry(0.85, 24).rotateY(Math.PI / 2), matDisco, cola, false);
  cuerpo.add(rotor, cola);

  // Luces: roja a babor (izquierda), verde a estribor y baliza roja arriba de la aleta. Pasan de 1 de noche y
  // el bloom las hace brillar.
  const luzNav = uniform(1), luzBaliza = uniform(0);
  const luz = (hex, brillo, x, y, z, r = 0.045) => {
    const m = new THREE.MeshBasicNodeMaterial();
    m.colorNode = color(hex).mul(brillo);
    malla(new THREE.SphereGeometry(r, 8, 6), m, cuerpo, false).position.set(x, y, z);
  };
  luz(0xff2020, luzNav, 1.12, 1.54, -4.35); // +x dentro de `cuerpo` es la izquierda del piloto
  luz(0x20ff60, luzNav, -1.12, 1.54, -4.35);
  luz(0xff3020, luzBaliza, 0, 2.86, -6.05, 0.05);

  let vueltas = 0, t = 0;
  const animar = (dt, potencia = 1) => {
    // Las palas tardan unos segundos en tomar vueltas y en detenerse.
    vueltas += (potencia * 30 - vueltas) * Math.min(1, dt * 0.7);
    rotor.rotation.y += vueltas * dt;
    cola.rotation.x += vueltas * 4.5 * dt;
    desenfoque.value = Math.min(1, vueltas / 30) * 0.14;
    t += dt;
    const fuerza = 1.2 + noche.value * 5, ciclo = t % 1.1;
    luzNav.value = (t % 1.2 < 0.85 ? 1 : 0.15) * fuerza;
    luzBaliza.value = ciclo < 0.07 || (ciclo > 0.18 && ciclo < 0.25) ? fuerza * 1.5 : 0.05; // doble destello
  };
  return { raiz, animar };
}

// ---------------------------------------------------------------------------------------------------------------
// Vuelo: h = { x, y, z, rumbo, vel, velY, cabeceo, alabeo }; entrada = { avance, giro, subir, bajar } (−1..1).
// Devuelve la potencia sugerida para animar(): poca en tierra, toda en el aire.
// ---------------------------------------------------------------------------------------------------------------
export function moverHelicoptero(h, entrada, dt, alturaSuelo) {
  const { avance = 0, giro = 0, subir = 0, bajar = 0 } = entrada;
  const vertical = subir - bajar;
  const enTierra = h.y <= alturaSuelo(h.x, h.z) + PISO + 0.02;
  h.t = (h.t || 0) + dt;
  // En el aire acelera hacia donde se le pide y sin mando se frena despacio; en tierra los patines lo frenan.
  if (avance && !enTierra) h.vel = Math.max(-12, Math.min(45, h.vel + avance * 14 * dt));
  else h.vel *= Math.exp(-dt * (enTierra ? 4 : 0.9));
  // Sin mando vertical se queda en el sitio, meciéndose unos 20 cm.
  if (vertical) h.velY = Math.max(-12, Math.min(12, h.velY + vertical * 18 * dt));
  else h.velY += ((enTierra ? 0 : Math.sin(h.t * 1.2) * 0.25) - h.velY) * Math.min(1, dt * 3);
  h.rumbo += giro * 1.1 * dt;
  h.x -= Math.sin(h.rumbo) * h.vel * dt;
  h.z -= Math.cos(h.rumbo) * h.vel * dt;
  h.y += h.velY * dt;
  const suelo = alturaSuelo(h.x, h.z);
  if (h.y < suelo + PISO) { h.y = suelo + PISO; h.velY = Math.max(0, h.velY); }
  if (h.y > suelo + TECHO) { h.y = suelo + TECHO; h.velY = Math.min(0, h.velY); }
  // Baja la nariz para avanzar y se ladea hacia el lado del giro. Cabeceo positivo = nariz arriba; alabeo
  // positivo = se ladea a la izquierda (como rotateX / rotateZ del modelo que mira hacia -z).
  const k = Math.min(1, dt * 3);
  const cabeceoMeta = enTierra ? 0 : -0.22 * (h.vel / 45) - avance * 0.05;
  const alabeoMeta = enTierra ? 0 : giro * (0.06 + 0.22 * Math.min(1, Math.abs(h.vel) / 25));
  h.cabeceo += (cabeceoMeta - h.cabeceo) * k;
  h.alabeo += (alabeoMeta - h.alabeo) * k;
  return enTierra && vertical <= 0 ? 0.35 : 1;
}
