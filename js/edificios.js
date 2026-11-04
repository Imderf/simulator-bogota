import * as THREE from 'three/webgpu';
import {
  Fn, If, property, attribute, varying, fract, step, floor, hash, mix, vec2, vec3, vec4, float, uniform, fwidth, smoothstep, max, min,
  clamp, abs, mod, pow, dot, cos, normalView, positionViewDirection, mx_noise_float,
} from 'three/tsl';
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
const VIDRIO_TORRE = [0x8a9bab, 0x98a4ae, 0x7f90a0].map((c) => new THREE.Color(c));
const TEJA = new THREE.Color(0xa0522d), TECHO = new THREE.Color(0x77736c);

// La Candelaria (aprox.): casas bajas blancas con techo de teja.
const enCandelaria = (x, z) => x > -150 && x < 1050 && z > -650 && z < 650;

// Familias de fachada, que el shader dibuja distinto: 0 ladrillo, 1 estuco, 2 concreto, 3 vidrio de torre, 4 casa colonial.
function colores(e, k) {
  const r = azar(k);
  if (e.pisos <= 3 && enCandelaria(e.cx, e.cz)) return [ESTUCO[Math.floor(r * ESTUCO.length)], TEJA, 4];
  if (e.pisos >= 20) return r < 0.5 ? [VIDRIO_TORRE[Math.floor(r * 6)], TECHO, 3] : [CONCRETO[Math.floor(r * 6) % 3], TECHO, 2];
  const fam = r < 0.55 ? 0 : r < 0.8 ? 1 : 2, lista = [LADRILLO, ESTUCO, CONCRETO][fam];
  return [lista[Math.floor(azar(k + 7) * lista.length)], r < 0.55 && e.pisos <= 2 ? TEJA : TECHO, fam];
}
// Locales en el primer piso: casi todo el centro es comercial; menos en las casas de un piso y en La Candelaria.
const comercial = (e, k, fam) => azar(k + 11) < (fam === 4 ? 0.35 : e.pisos === 1 ? 0.3 : 0.7);
// Un color y los rasgos del edificio caben en dos números enteros exactos en float32 (menos de 2^24).
const empacar = (c) => Math.round(c.r * 255) * 65536 + Math.round(c.g * 255) * 256 + Math.round(c.b * 255);

export function mallasEdificios(lista, terreno, excluir = () => false) {
  const celdas = new Map();
  lista.forEach((e, k) => {
    if (excluir(e)) return;
    const llave = `${Math.floor(e.cx / CELDA)},${Math.floor(e.cz / CELDA)}`;
    if (!celdas.has(llave)) celdas.set(llave, { pos: [], fac: [], sue: [], est: [] });
    agregar(celdas.get(llave), e, k, terreno);
  });
  const grupo = new THREE.Group();
  grupo.name = 'Edificios';
  const material = materialFachada();
  for (const c of celdas.values()) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(c.pos, 3));
    g.setAttribute('fachada', new THREE.Float32BufferAttribute(c.fac, 3));
    g.setAttribute('suelo', new THREE.Float32BufferAttribute(c.sue, 2));
    g.setAttribute('estilo', new THREE.Float32BufferAttribute(c.est, 2));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, material);
    m.castShadow = m.receiveShadow = true;
    grupo.add(m);
  }
  return { grupo, material };
}

// Cada vértice lleva:
//   fachada = (metros desde la esquina donde empieza el muro, altura sobre la base de los pisos, largo del muro);
//             en los techos el largo es -1.
//   suelo   = altura de la acera en las dos esquinas del muro, medida desde la base de los pisos.
//   estilo  = (color empacado, familia + 8·comercial + 16·pisos + 2048·semilla).
function agregar(c, e, k, terreno) {
  const exterior = e.anillos[0];
  let min = Infinity, max = -Infinity;
  for (const [x, z] of exterior) { const h = terreno.altura(x, z); min = Math.min(min, h); max = Math.max(max, h); }
  // Los pisos arrancan a media loma: del lado de abajo queda un zócalo alto y del de arriba el primer piso se
  // mete un poco en la pendiente, como en las calles empinadas de La Candelaria.
  const base = min + (max - min) * 0.5;
  const abajo = min - 3;
  const arriba = base + e.pisos * ALTURA_PISO + 0.6;
  const [muro, techo, familia] = colores(e, k);
  const rasgos = familia + 8 * (comercial(e, k, familia) ? 1 : 0) + 16 * Math.min(e.pisos, 127) + 2048 * Math.floor(azar(k + 3) * 4096);
  const cMuro = empacar(muro), cTecho = empacar(techo);

  const anillos = e.anillos.map((r, i) => {
    const ccw = area(r) > 0;
    return (i === 0) === ccw ? r : [...r].reverse(); // exterior antihorario, huecos horario
  });
  // Muros: normal hacia afuera = (dz, -dx).
  const v0 = abajo - base, v1 = arriba - base;
  for (const r of anillos) {
    for (let i = 0; i < r.length; i++) {
      const [ax, az] = r[i], [bx, bz] = r[(i + 1) % r.length];
      const largo = Math.hypot(bx - ax, bz - az);
      const sa = terreno.altura(ax, az) - base, sb = terreno.altura(bx, bz) - base;
      const q = [[ax, abajo, az, 0, v0], [bx, arriba, bz, largo, v1], [bx, abajo, bz, largo, v0],
        [ax, abajo, az, 0, v0], [ax, arriba, az, 0, v1], [bx, arriba, bz, largo, v1]];
      for (const [x, y, z, s, v] of q) { c.pos.push(x, y, z); c.fac.push(s, v, largo); c.sue.push(sa, sb); c.est.push(cMuro, rasgos); }
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
    for (const p of tri) { c.pos.push(p.x, arriba, p.y); c.fac.push(0, v1, -1); c.sue.push(0, 0); c.est.push(cTecho, rasgos); }
  }
}

export const noche = uniform(0);

// Adaptado de Slop New York (mrdoob, MIT): js/tsl-materials.js (filteredPulse y boxCoverage).
// Qué fracción del píxel (ancho w, en unidades de x) cae donde fract(x) está entre a y b. Es un filtro de caja exacto:
// cuando la celda se hace más chica que un píxel queda su promedio (b - a) y la fachada no parpadea ni hace moiré.
export const pulso = Fn(([x, a, b, w]) => {
  const lo = float(a).toVar(), hi = float(b).toVar(), m = max(float(w), 0.0001).mul(0.5).toVar();
  const integral = (t) => floor(t).mul(hi.sub(lo)).add(clamp(fract(t), lo, hi).sub(lo));
  return integral(float(x).add(m)).sub(integral(float(x).sub(m))).div(m.mul(2));
});
// Lo mismo para un tramo que no se repite: fracción del píxel (medio ancho m) que queda dentro de [a, b].
export const tramo = Fn(([x, a, b, m]) => {
  const mv = max(float(m), 0.001).toVar();
  return clamp(min(float(x).add(mv), b).sub(max(float(x).sub(mv), a)).div(mv.mul(2)), 0, 1);
});
// Paleta de colores vivos (avisos, zócalos pintados) a partir de un número entre 0 y 1.
const matiz = (h, sat, luz) => cos(vec3(0, 0.33, 0.67).add(h).mul(6.283)).mul(sat).add(luz);

// Fachada bogotana por shader: un solo material para los 51.000 edificios. Todo se filtra al tamaño del píxel, así
// que de lejos cada detalle queda en su color promedio en vez de parpadear.
// Para que la vista general no pese, color, rugosidad, brillo de noche y oclusión salen de una sola función con
// ramas: los techos se van directo; los muros pasan por un camino barato (color promedio, ventanas filtradas, primer
// piso promediado) y solo cuando el píxel mide menos de 12 a 20 cm se calcula el detalle, que se funde con el barato.
// Dentro del detalle, el ladrillo, las manchas y el primer piso solo se calculan donde existen y se alcanzan a ver.
function materialFachada() {
  const f = attribute('fachada', 'vec3'), suelo = attribute('suelo', 'vec2'), e = attribute('estilo', 'vec2');
  // Se desempaca en el vértice, donde los enteros todavía son exactos (ya interpolados podrían no serlo).
  const tinte = varying(vec3(floor(e.x.div(65536)), mod(floor(e.x.div(256)), 256), mod(e.x, 256)).div(255));
  const rasgos = varying(vec4(mod(e.y, 8), mod(floor(e.y.div(8)), 2), mod(floor(e.y.div(16)), 128), floor(e.y.div(2048))));
  // three arma primero el color y después lee rugosidad, emisión y oclusión: la función del color las deja listas.
  const rugosidad = property('float'), emision = property('vec3'), oclusion = property('float');

  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0.0 });
  m.colorNode = Fn(() => {
    const s = f.x, y = f.y, largo = f.z, uno = float(1);
    // Las derivadas van antes de cualquier If: WGSL no deja calcularlas dentro de una rama.
    const mx = fwidth(s).toVar(), my = fwidth(y).toVar(); // metros por píxel a lo largo y a lo alto
    const c = vec3(tinte).toVar(), rug = float(0.9).toVar(), emi = vec3(0).toVar(), ao = float(1).toVar();

    If(largo.greaterThan(0), () => { // los techos llevan largo -1 y se quedan con su color
      const fam = floor(rasgos.x.add(0.5)), esComercial = step(0.5, rasgos.y), pisos = floor(rasgos.z.add(0.5));
      const semilla = floor(rasgos.w.add(0.5)).toVar();
      const de = (k) => float(1).sub(step(0.5, abs(fam.sub(k)))).toVar();
      const [ladrillo, estuco, concreto, torre, colonial] = [0, 1, 2, 3, 4].map(de);
      const segun = (l, es, cc, t, k) => ladrillo.mul(l).add(estuco.mul(es)).add(concreto.mul(cc)).add(torre.mul(t)).add(colonial.mul(k));
      const sinTorre = uno.sub(torre);
      const mx2 = mx.mul(0.5).toVar(), my2 = my.mul(0.5).toVar();
      // 1 de cerca; 0 cuando el píxel pasa de 20 cm y ya no se alcanza a ver ni un alféizar. Se toma el lado más fino:
      // un muro visto de lado desde la calle conserva sus líneas horizontales (placas, repisas, cornisa).
      const cerca = uno.sub(smoothstep(0.12, 0.2, min(mx, my))).toVar();

      // Vanos: un número entero por muro, centrados entre dos pilares de esquina. Muros muy cortos quedan ciegos.
      const anchoVano = segun(2.6, 2.8, 3.0, 1.5, 3.4);
      const pilar = min(segun(0.45, 0.4, 0.5, 0, 0.6), largo.mul(0.15)).toVar();
      const util = max(largo.sub(pilar.mul(2)), 0.01).toVar();
      const vanos = max(floor(util.div(anchoVano).add(0.5)), 1).toVar();
      const ancho = util.div(vanos).toVar();
      const gu = s.sub(pilar).div(ancho), gv = y.div(ALTURA_PISO);
      const cu = fract(gu).toVar(), cv = fract(gv).toVar(), columna = floor(gu).toVar(), piso = floor(gv).toVar();
      const wu = mx.div(ancho).toVar(), wv = my.div(ALTURA_PISO).toVar(); // el píxel medido en celdas
      const lejos = smoothstep(0.2, 0.5, max(wu, wv)).toVar();
      const enMuro = step(pilar, s).mul(step(s, largo.sub(pilar))).mul(step(anchoVano.mul(0.55), util)).toVar();

      // Acera: sube o baja a lo largo del muro. El suelo al centro de cada vano decide si cabe la ventana completa.
      const aqui = (u) => mix(suelo.x, suelo.y, clamp(u.div(largo), 0, 1));
      const h = y.sub(aqui(s)).toVar();
      const bajo = tramo(h, -50, 3, my2).toVar(); // primer piso: locales, zócalo y puertas
      const vx = segun(0.22, 0.2, 0.12, 0.03, 0.32).toVar(), vy0 = segun(0.3, 0.3, 0.33, 0.1, 0.24).toVar(), vy1 = segun(0.85, 0.83, 0.8, 0.93, 0.86).toVar();
      const hay = enMuro.mul(step(aqui(columna.add(0.5).mul(ancho).add(pilar)).add(3.1), piso.add(vy0).mul(ALTURA_PISO))).mul(step(piso.add(0.5), pisos)).toVar();
      const vano = pulso(cu, vx, uno.sub(vx), wu).mul(pulso(cv, vy0, vy1, wv)).mul(hay).toVar();
      const desdeArriba = pisos.mul(ALTURA_PISO).add(0.6).sub(y).toVar();
      const remate = tramo(desdeArriba, -1, 0.6, my2).mul(uno.sub(colonial));
      const moldura = segun(vec3(0.6, 0.58, 0.54), tinte.mul(1.1), tinte.mul(0.92), tinte.mul(0.4), tinte.mul(1.05)).toVar();

      // Vidrio: oscuro, con el cielo reflejado según el ángulo.
      const fresnel = pow(uno.sub(clamp(dot(normalView, positionViewDirection), 0, 1)), 3).toVar();
      const cielo = mix(vec3(0.5, 0.6, 0.72), vec3(0.02, 0.03, 0.06), noche).toVar();
      const reflejo = cielo.mul(mix(vec3(1), tinte.mul(1.4), torre)).toVar();
      const brilloVidrio = fresnel.mul(0.6).add(mix(float(0.1), float(0.3), torre)).toVar();
      // De noche: cada cuarto con su bombillo (casi todos cálidos; las torres de oficinas, más fríos).
      const celda = columna.add(1000).add(piso.add(100).mul(173)).add(semilla.mul(997)).toVar();
      const encendida = mix(step(0.58, hash(celda)), float(0.42), lejos);
      const tonoLuz = mix(hash(celda.add(17)), float(0.5), lejos);
      const luz = mix(vec3(1.0, 0.76, 0.46), vec3(0.82, 0.9, 1.0), step(mix(float(0.82), float(0.45), torre), tonoLuz)).mul(tonoLuz.mul(0.8).add(0.6));
      // De lejos el promedio se baja a la mitad: si no, la fachada entera se ve color crema en vez de puntos de luz.
      const luzVentana = luz.mul(encendida).mul(mix(float(1.5), float(0.45), lejos)).toVar();
      // Primer piso: locales de unos 4,5 m (de noche varios bajan la cortina) o zócalo en las casas.
      const enLocal = esComercial.mul(step(pilar, s)).mul(step(s, largo.sub(pilar))).mul(step(2.4, util)).toVar();
      const colorVitrina = mix(vec3(0.05), cielo, fresnel.mul(0.6).add(0.1)).toVar();
      const zocalo = tramo(h, -50, mix(float(0.9), float(0.45), esComercial), my2).mul(bajo).toVar();
      const gris = vec3(0.27, 0.26, 0.25);
      const rugMuro = segun(0.9, 0.82, 0.86, 0.4, 0.85).toVar();

      // Camino barato: muro en su color promedio (ladrillo con pega, estuco con manchas), ventanas filtradas con
      // vidrio y marco promediados, y el primer piso como una franja de vitrinas.
      const cerradoMedio = mix(float(0.15), float(0.6), noche);
      const franjaLocal = tramo(h, 0, 2.5, my2).mul(enLocal).mul(bajo);
      const muroMedio = segun(mix(tinte, vec3(0.47, 0.45, 0.42), 0.14), tinte.mul(0.93), tinte.mul(0.9), tinte.mul(0.5), tinte.mul(0.94));
      const marcoMedio = segun(vec3(0.1, 0.1, 0.11), vec3(0.8, 0.8, 0.78), vec3(0.16, 0.17, 0.18), vec3(0.12, 0.14, 0.16), vec3(0.15, 0.15, 0.09));
      const ventanaMedia = mix(mix(vec3(0.107, 0.105, 0.102), reflejo, brilloVidrio).mul(0.85), marcoMedio, 0.2);
      let lejano = mix(muroMedio, moldura, remate);
      lejano = mix(lejano, ventanaMedia, vano);
      lejano = mix(lejano, gris, zocalo);
      lejano = mix(lejano, mix(mix(vec3(0.3), colorVitrina, 0.7), vec3(0.45), cerradoMedio), franjaLocal.mul(0.9));
      c.assign(lejano);
      rug.assign(mix(rugMuro, float(0.12), max(vano.mul(0.8), franjaLocal.mul(0.6).mul(uno.sub(cerradoMedio)))));
      emi.assign(luzVentana.mul(vano).mul(0.8).add(vec3(1, 0.85, 0.65).mul(1.8 * 0.62).mul(franjaLocal).mul(uno.sub(cerradoMedio))));

      If(cerca.greaterThan(0.001), () => {
        // Ventanas con marco de 6 cm y parteluz (en las torres el marco es el montante entre paneles).
        const mu = float(0.06).div(ancho), mv = 0.06 / ALTURA_PISO;
        const luzVano = pulso(cu, vx.add(mu), uno.sub(vx).sub(mu), wu).mul(pulso(cv, vy0.add(mv), vy1.sub(mv), wv));
        const parteluz = pulso(cu, float(0.5).sub(mu.mul(0.5)), float(0.5).add(mu.mul(0.5)), wu).mul(sinTorre);
        const travesano = pulso(cv, vy1.sub(0.16), vy1.sub(0.16 - mv), wv).mul(colonial);
        const vidrio = luzVano.mul(uno.sub(max(parteluz, travesano))).mul(hay).toVar();
        const marco = max(vano.sub(vidrio), 0);
        // Repisa (alféizar) con su sombra debajo, y viga de concreto (dintel) sobre las ventanas de ladrillo y concreto.
        const anchoRepisa = pulso(cu, vx.sub(mu), uno.sub(vx).add(mu), wu).mul(hay).mul(sinTorre).toVar();
        const alfeizar = pulso(cv, vy0.sub(0.03), vy0, wv).mul(anchoRepisa);
        const bajoAlfeizar = pulso(cv, vy0.sub(0.065), vy0.sub(0.03), wv).mul(anchoRepisa);
        const dintel = pulso(cv, vy1, vy1.add(0.05), wv).mul(anchoRepisa).mul(ladrillo.add(concreto));
        // La ventana está metida en el muro: el dintel y una jamba le hacen sombra al vidrio.
        const hondura = uno.sub(max(smoothstep(vy1.sub(0.12), vy1, cv).mul(0.55), uno.sub(smoothstep(vx, vx.add(0.1), cu)).mul(0.35)).mul(sinTorre)).toVar();
        // Línea de placa en cada piso y remate: cornisa con sombra debajo, o alero de teja en las casas coloniales.
        const placa = pulso(cv, 0, 0.07, wv).mul(uno.sub(bajo)).mul(ladrillo.add(concreto).add(estuco.mul(0.4)));
        const cornisa = tramo(desdeArriba, 0.6, 0.78, my2).mul(uno.sub(colonial));
        const coronacion = tramo(desdeArriba, -1, 0.05, my2).mul(uno.sub(colonial));
        const alero = tramo(desdeArriba, -1, 0.8, my2).mul(colonial);

        // Ladrillo tolete a la vista en aparejo de soga (24,5 x 7,5 cm con la pega), como en los barrios y en Salmona.
        // Solo en muros de ladrillo y mientras cada pieza mida al menos un píxel; si no, su promedio.
        const wl = vec2(mx.div(0.25), my.div(0.075)).toVar();
        const colorLadrillo = mix(tinte, vec3(0.47, 0.45, 0.42), 0.14).toVar();
        If(ladrillo.greaterThan(0.5).and(max(wl.x, wl.y).lessThan(1)), () => {
          const fila = y.div(0.075), hilada = floor(fila);
          const pieza = s.div(0.25).add(mod(hilada.add(100), 2).mul(0.5));
          const pega = uno.sub(pulso(pieza, 0.04, 1, wl.x).mul(pulso(fila, 0.14, 1, wl.y)));
          const tono = hash(floor(pieza).add(hilada.add(100).mul(1301)).add(semilla.mul(17))).sub(0.5)
            .mul(uno.sub(smoothstep(0.5, 1, max(wl.x, wl.y)))); // cada ladrillo con su tono, solo de cerca
          colorLadrillo.assign(mix(tinte.mul(tono.mul(0.28).add(1)), vec3(0.47, 0.45, 0.42), pega.mul(0.85)));
        });
        // Estuco y concreto con manchas, chorreones bajo las ventanas y humedad que sube del andén.
        const manchas = uno.sub(smoothstep(0, 1.4, h)).mul(0.18).toVar();
        If(ladrillo.add(torre).lessThan(0.5), () => {
          const ruido = mx_noise_float(vec2(s, y).add(semilla.mul(3.7)).mul(0.3));
          manchas.addAssign(smoothstep(0.05, 0.6, ruido).mul(0.14));
          If(mx.lessThan(0.2), () => { // los chorreones miden unos 60 cm: de más lejos no se ven
            const chorreo = mx_noise_float(vec2(s.mul(1.6), y.mul(0.1)).add(semilla));
            manchas.addAssign(smoothstep(0.1, 0.7, chorreo).mul(0.12).mul(uno.sub(smoothstep(0.05, 0.2, mx))));
          });
        });
        const liso = tinte.mul(uno.sub(manchas));
        // Concreto a la vista con juntas de formaleta cada 1,2 m y cada 0,6 m.
        const juntas = max(uno.sub(pulso(s.div(1.2), 0.012, 1, mx.div(1.2))), uno.sub(pulso(y.div(0.6), 0.025, 1, my.div(0.6))));
        const muro = segun(colorLadrillo, liso, liso.mul(uno.sub(juntas.mul(0.3))), tinte.mul(0.5), liso);
        const madera = mix(vec3(0.08, 0.2, 0.13), vec3(0.22, 0.11, 0.05), step(0.5, hash(semilla.add(11)))).toVar();
        const colorMarco = segun(vec3(0.1, 0.1, 0.11), vec3(0.8, 0.8, 0.78), vec3(0.16, 0.17, 0.18), vec3(0.12, 0.14, 0.16), madera);
        // De día algunas ventanas muestran cortina.
        const cortina = mix(step(0.62, hash(celda.add(5))), float(0.38), lejos);
        const adentro = mix(vec3(0.05, 0.06, 0.07), vec3(0.3, 0.26, 0.21), cortina.mul(0.6));
        const colorVidrio = mix(adentro, reflejo, brilloVidrio).mul(hondura).toVar();

        let cerca1 = muro;
        cerca1 = mix(cerca1, moldura, max(placa, remate));
        cerca1 = cerca1.mul(uno.sub(cornisa.mul(0.45)).mul(uno.sub(alero.mul(0.5))));
        cerca1 = mix(cerca1, moldura.mul(1.15), coronacion);
        cerca1 = mix(cerca1, moldura.mul(1.12), alfeizar).mul(uno.sub(bajoAlfeizar.mul(0.45)));
        cerca1 = mix(cerca1, vec3(0.6, 0.58, 0.54).mul(0.95), dintel);
        cerca1 = mix(cerca1, colorMarco.mul(hondura), marco);
        cerca1 = mix(cerca1, colorVidrio, vidrio);
        const cN = cerca1.toVar(), brillo = vidrio.toVar(), emiN = luzVentana.mul(vidrio).toVar();

        // Primer piso, solo donde lo hay.
        If(bajo.greaterThan(0.001), () => {
          // Locales con vitrina, puerta y aviso; de noche varios bajan la cortina metálica.
          const locales = max(floor(util.div(4.5).add(0.5)), 1), anchoLocal = util.div(locales).toVar();
          const gl = s.sub(pilar).div(anchoLocal), xl = fract(gl).mul(anchoLocal).toVar(), local = floor(gl).add(semilla.mul(31)).toVar();
          const lejosLocal = smoothstep(0.1, 0.3, mx.div(anchoLocal)).toVar();
          const hayLocal = enLocal.mul(bajo);
          const xPuerta = mix(float(0.4), anchoLocal.sub(1.4), step(0.5, hash(local.add(3)))).toVar();
          const vitrina = tramo(xl, 0.3, anchoLocal.sub(0.3), mx2).mul(tramo(h, 0.45, 2.5, my2));
          const portal = tramo(xl, xPuerta, xPuerta.add(1), mx2).mul(tramo(h, -1, 2.5, my2));
          const hueco = max(vitrina, portal).mul(hayLocal).toVar();
          const cristal = max(tramo(xl, 0.36, anchoLocal.sub(0.36), mx2).mul(tramo(h, 0.5, 2.44, my2)),
            tramo(xl, xPuerta.add(0.06), xPuerta.add(0.94), mx2).mul(tramo(h, -1, 2.44, my2))).mul(hayLocal).toVar();
          const cerrado = mix(step(hash(local.add(9)), mix(float(0.15), float(0.6), noche)), float(0.35), lejosLocal).toVar();
          const persiana = vec3(0.5, 0.51, 0.52).mul(uno.sub(pulso(h.div(0.09), 0, 0.3, my.div(0.09)).mul(0.35)));
          const aviso = tramo(xl, 0.15, anchoLocal.sub(0.15), mx2).mul(tramo(h, 2.6, 3, my2)).mul(hayLocal).mul(sinTorre);
          const colorAviso = mix(matiz(hash(local.add(21)), 0.4, 0.5), vec3(0.5), lejosLocal);
          const luzLocal = mix(vec3(1.0, 0.8, 0.55), vec3(0.85, 0.92, 1.0), step(0.6, hash(local.add(13)))).mul(1.8);
          // Vivienda: zócalo pintado en las casas coloniales, ventanas con reja y una puerta por muro.
          const casa = uno.sub(esComercial).mul(bajo);
          const colorZocalo = mix(gris, matiz(hash(semilla.add(41)), 0.18, 0.32), colonial);
          const vanoPuerta = floor(hash(semilla.add(largo.mul(7))).mul(vanos));
          const conPuerta = uno.sub(step(0.5, abs(columna.sub(vanoPuerta)))).mul(step(3.5, largo)).toVar();
          const puerta = conPuerta.mul(tramo(cu.mul(ancho), ancho.sub(1.1).mul(0.5), ancho.add(1.1).mul(0.5), mx2)).mul(tramo(h, -1, 2.3, my2)).mul(enMuro).mul(casa);
          const ventanaBaja = pulso(cu, vx, uno.sub(vx), wu).mul(tramo(h, 1, 2.4, my2)).mul(enMuro).mul(casa).mul(uno.sub(conPuerta)).toVar();
          const reja = uno.sub(pulso(s.div(0.13), 0, 0.82, mx.div(0.13))).mul(ventanaBaja).toVar(); // barrotes cada 13 cm
          const colorPuerta = mix(mix(vec3(0.14, 0.15, 0.16), vec3(0.25, 0.14, 0.07), step(0.5, hash(semilla.add(5)))), madera, colonial);

          let b = mix(cN, colorZocalo, zocalo);
          b = mix(b, vec3(0.33, 0.34, 0.35), hueco);
          b = mix(b, colorVitrina, cristal);
          b = mix(b, persiana, hueco.mul(cerrado));
          b = mix(b, colorAviso, aviso);
          b = mix(b, colorVidrio, ventanaBaja);
          b = mix(b, vec3(0.06), reja);
          b = mix(b, colorPuerta, puerta);
          cN.assign(b);
          brillo.assign(max(max(brillo, cristal.mul(uno.sub(cerrado))), ventanaBaja.mul(uno.sub(reja))));
          emiN.assign(emiN.add(luzLocal.mul(cristal).mul(uno.sub(cerrado))).add(luzVentana.mul(ventanaBaja).mul(uno.sub(reja)).mul(0.53)));
        });

        c.assign(mix(c, cN, cerca));
        rug.assign(mix(rug, mix(rugMuro, float(0.12), brillo), cerca));
        emi.assign(mix(emi, emiN, cerca));
      });

      // Mugre a ras del andén y luz cálida que rebota de la calle en los primeros pisos.
      c.assign(c.mul(smoothstep(-0.2, 1, h).mul(0.25).add(0.75))
        .add(vec3(0.95, 0.6, 0.35).mul(smoothstep(0, 4, h).mul(uno.sub(smoothstep(8, 20, h))).mul(0.035).mul(uno.sub(noche)))));
      // Oclusión del cañón urbano: la calle ve menos cielo que los pisos altos.
      ao.assign(mix(float(0.5), uno, smoothstep(0, 24, h)).mul(smoothstep(-0.5, 2.5, h).mul(0.2).add(0.8)));
    });

    rugosidad.assign(rug);
    emision.assign(emi.mul(noche));
    oclusion.assign(ao);
    return c;
  })();
  m.roughnessNode = rugosidad;
  m.emissiveNode = emision;
  m.aoNode = oclusion;
  return m;
}
