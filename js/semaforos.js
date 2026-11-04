import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { attribute, uniform, uv, positionGeometry, float, vec2, vec3, color, mix, step, mod, fract, length, clamp, smoothstep, max, min, dot } from 'three/tsl';
import { noche } from './edificios.js';
import { anchoVia, andenVia } from './vias.js';

// Semáforos en los cruces donde llega una avenida o calle principal (vías de carros de clase 0 a 2, también cuando la
// otra es local). Los nodos de un mismo cruce (las dos calzadas de una avenida con separador) forman un grupo con un
// solo reloj: eje 0 es la vía más importante y eje 1 la que la cruza; verde, amarillo y todo en rojo, con un desfase
// por grupo para que no cambien todos a la vez. El peatón cruza una calzada con el verde de la vía paralela a su paso,
// y deja de arrancar cuando ya no alcanzaría a cruzar. trafico.js y peatones.js leen el mismo reloj que los lentes,
// que se encienden en la GPU. Solo se dibujan los cruces cercanos a la cámara: siete mallas instanciadas.
// Adaptado de Slop New York (mrdoob, MIT): js/city-config.js (SIGNAL_TIMING, signalPhase, walkSignal) y
// js/street-details.js (lentes que leen el reloj en el shader, cabeza con viseras de túnel).

export const VERDE = 0, AMARILLO = 1, ROJO = 2;
// Segundos: verde del eje principal y del secundario, amarillo, todo en rojo, y cuánto antes del final del verde
// paralelo deja de arrancar el peatón (lo que tarda en atravesar unos 15 m caminando).
export const TIEMPOS = { verde: [28, 22], amarillo: 3, todoRojo: 2, despeje: 12 };
const { verde: V, amarillo: A, todoRojo: R, despeje: D } = TIEMPOS;
export const CICLO = V[0] + V[1] + 2 * (A + R);
const INICIO = [0, V[0] + A + R]; // cuándo arranca el verde de cada eje dentro del ciclo
const RADIO_GRUPO = 25; // nodos con semáforo a menos de esto son el mismo cruce
const RADIO_VISTA = 420; // se dibujan los cruces a menos de esto de la cámara
const ALTO_MAXIMO = 500; // más alto que esto sobre el piso no se distinguen

const enEje = (t, eje) => (((t - INICIO[eje]) % CICLO) + CICLO) % CICLO;
// Luz de los carros que llegan por una vía del eje `eje` en el segundo t del reloj del grupo.
export function luz(t, eje) {
  const s = enEje(t, eje);
  return s < V[eje] ? VERDE : s < V[eje] + A ? AMARILLO : ROJO;
}
// Luz del peatón que atraviesa las calzadas del eje `eje`: camina con el verde del otro eje; AMARILLO es el muñeco
// verde titilando (ya no se arranca, el que va termina de cruzar).
export function paso(t, eje) {
  const o = 1 - eje, s = enEje(t, o);
  return s < V[o] - D ? VERDE : s < V[o] + A ? AMARILLO : ROJO;
}

// ---------------------------------------------------------------------------------------------------------------
// Grupos: sin three, se prueba en node con las vías reales.
// ---------------------------------------------------------------------------------------------------------------
const llave = (x, z) => `${x},${z}`;
export function armarSemaforos(vias) {
  // Brazos de cada vértice: cada vía de carros sale de él hacia el punto anterior y el siguiente. `entra` dice si por
  // ese brazo llegan carros al nodo (en las de un sentido el dibujo va en el sentido en que se maneja).
  // radio: lo que despeja el cruce, como en vias.js (la cebra se pinta de radio + 0,6 a radio + 3,6 m).
  const brazos = new Map(), radio = new Map();
  for (const v of vias) {
    if (v.clase > 4 || v.p.length < 2) continue;
    const w = anchoVia(v) / 2, r = w + andenVia(v), carros = v.clase <= 3 && !v.bus;
    v.p.forEach(([x, z], i) => {
      const c = llave(x, z);
      radio.set(c, Math.max(radio.get(c) || 0, r));
      if (!carros) return;
      for (const s of [-1, 1]) {
        let j = i + s;
        while (j >= 0 && j < v.p.length && v.p[j][0] === x && v.p[j][1] === z) j += s;
        if (j < 0 || j >= v.p.length) continue;
        const dx = v.p[j][0] - x, dz = v.p[j][1] - z, l = Math.hypot(dx, dz);
        const lista = brazos.get(c) ?? brazos.set(c, []).get(c);
        lista.push({ via: v, i, s, dx: dx / l, dz: dz / l, w, clase: v.clase, entra: !v.unSentido || s < 0 });
      }
    });
  }
  const nodos = [];
  for (const [c, b] of brazos) {
    if (b.length < 3 || !b.some((a) => a.clase <= 2)) continue;
    const [x, z] = c.split(',').map(Number);
    nodos.push({ c, x, z, brazos: b, raiz: null });
  }
  // Unión de los nodos cercanos (rejilla del tamaño del radio).
  const raiz = (n) => (n.raiz ? (n.raiz = raiz(n.raiz)) : n);
  const celdas = new Map(), celda = (x, z) => `${Math.floor(x / RADIO_GRUPO)},${Math.floor(z / RADIO_GRUPO)}`;
  for (const n of nodos) (celdas.get(celda(n.x, n.z)) ?? celdas.set(celda(n.x, n.z), []).get(celda(n.x, n.z))).push(n);
  for (const n of nodos) {
    const i0 = Math.floor(n.x / RADIO_GRUPO), j0 = Math.floor(n.z / RADIO_GRUPO);
    for (let i = i0 - 1; i <= i0 + 1; i++) for (let j = j0 - 1; j <= j0 + 1; j++) {
      for (const o of celdas.get(`${i},${j}`) || []) {
        if (o === n || Math.hypot(o.x - n.x, o.z - n.z) > RADIO_GRUPO) continue;
        const a = raiz(n), b = raiz(o);
        if (a !== b) b.raiz = a;
      }
    }
  }
  const porRaiz = new Map(), grupos = [], porNodo = new Map();
  for (const n of nodos) {
    const r = raiz(n);
    let g = porRaiz.get(r);
    if (!g) { porRaiz.set(r, g = { id: grupos.length, x: 0, z: 0, mx: 1, mz: 0, desfase: 0, nodos: [] }); grupos.push(g); }
    g.nodos.push(n);
    porNodo.set(n.c, g);
  }
  for (const g of grupos) {
    g.x = g.nodos.reduce((s, n) => s + n.x, 0) / g.nodos.length;
    g.z = g.nodos.reduce((s, n) => s + n.z, 0) / g.nodos.length;
    // Eje principal: el brazo de la vía más importante (y, entre iguales, la más ancha).
    let mejor = null;
    for (const n of g.nodos) for (const a of n.brazos) if (!mejor || a.clase < mejor.clase || (a.clase === mejor.clase && a.w > mejor.w)) mejor = a;
    g.mx = mejor.dx; g.mz = mejor.dz;
    // Desfase fijo por posición: el mismo en cada carga.
    const h = Math.sin(g.x * 12.9898 + g.z * 78.233) * 43758.5453;
    g.desfase = (h - Math.floor(h)) * CICLO;
  }
  // Un brazo es interno si por su vía se llega a otro nodo del mismo grupo (el tramo del separador): ahí no hay
  // semáforo propio, se sigue con la luz con la que se entró.
  for (const g of grupos) for (const n of g.nodos) for (const a of n.brazos) {
    let i = a.i, d = 0;
    a.interno = false;
    for (;;) {
      const j = i + a.s;
      if (j < 0 || j >= a.via.p.length) break;
      d += Math.hypot(a.via.p[j][0] - a.via.p[i][0], a.via.p[j][1] - a.via.p[i][1]);
      if (d > RADIO_GRUPO * 1.6) break;
      const c = llave(...a.via.p[j]), o = porNodo.get(c);
      if (o) { a.interno = o === g; break; }
      if ((brazos.get(c)?.length || 0) >= 3) break;
      i = j;
    }
  }
  return { grupos, porNodo, radio };
}

// Eje de un brazo que sale del cruce hacia (dx, dz): 0 si va con la vía principal, 1 si la cruza.
export const ejeDe = (g, dx, dz) => (Math.abs(dx * g.mx + dz * g.mz) >= Math.SQRT1_2 ? 0 : 1);

// Punto a `dist` metros del vértice i de la vía, siguiendo su trazo en el sentido s, con la dirección del tramo.
export function aLoLargo(via, i, s, dist) {
  let d = dist;
  for (;;) {
    const j = i + s;
    if (j < 0 || j >= via.p.length) break;
    const [ax, az] = via.p[i], [bx, bz] = via.p[j], l = Math.hypot(bx - ax, bz - az);
    if (l > 1e-6 && (d <= l || j + s < 0 || j + s >= via.p.length)) {
      const t = d / l;
      return { x: ax + (bx - ax) * t, z: az + (bz - az) * t, tx: (bx - ax) / l, tz: (bz - az) / l };
    }
    d -= l;
    i = j;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Modelo: poste gris con base de franjas amarillas y negras, cabeza negra de tres luces con viseras y placa de
// contraste amarilla (en las avenidas también colgada de un brazo sobre los carriles) y semáforo peatonal de dos
// cuadros con el muñeco quieto (rojo) y caminando (verde). Las caras con luces miran a +z.
// ---------------------------------------------------------------------------------------------------------------
const ALTO_BAJO = 3.3, ALTO_ALTO = 6.2, Y_BRAZO = 5.95;
const CABEZA = { w: 0.34, h: 1.0, d: 0.24, r: 0.1, ys: [0.31, 0, -0.31] }; // lentes de 20 cm
const PEATON = { w: 0.3, h: 0.6, d: 0.2, lado: 0.22, ys: [0.14, -0.14] };

function pintar(g, hex) {
  g = g.index ? g.toNonIndexed() : g;
  const n = g.attributes.position.count, c = new THREE.Color(hex), col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'color'].includes(k)) g.deleteAttribute(k);
  return g;
}
function geometriaCabeza() {
  const { w, h, d, r, ys } = CABEZA, NEGRO = 0x141414;
  return mergeGeometries([
    pintar(new THREE.BoxGeometry(w + 0.22, h + 0.22, 0.02).translate(0, 0, -d / 2 - 0.01), 0xf2c200), // placa de contraste
    pintar(new THREE.BoxGeometry(w, h, d), NEGRO),
    pintar(new THREE.BoxGeometry(0.06, 0.2, 0.06).translate(0, h / 2 + 0.1, 0), 0x55585c), // soporte
    // Visera de túnel sobre cada lente (media caña abierta abajo).
    ...ys.map((y) => pintar(new THREE.CylinderGeometry(r + 0.03, r + 0.03, 0.2, 12, 1, true, -Math.PI / 2, Math.PI).rotateX(Math.PI / 2).translate(0, y, d / 2 + 0.1), NEGRO)),
  ]);
}
function geometriaPeaton() {
  const { w, h, d, lado, ys } = PEATON, NEGRO = 0x141414;
  return mergeGeometries([
    pintar(new THREE.BoxGeometry(w, h, d), NEGRO),
    ...ys.map((y) => pintar(new THREE.BoxGeometry(w, 0.02, 0.1).translate(0, y + lado / 2 + 0.02, d / 2 + 0.05), NEGRO)),
  ]);
}
// Lentes con su número de luz por vértice (0 rojo, 1 amarillo, 2 verde; en el peatonal 0 rojo, 1 verde).
function lentes(piezas) {
  const g = mergeGeometries(piezas.map(([geo, k]) => {
    geo.setAttribute('luz', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count).fill(k), 1));
    return geo;
  }));
  return g;
}
const geometriaLentes = () => lentes(CABEZA.ys.map((y, k) => [new THREE.CircleGeometry(CABEZA.r, 20).translate(0, y, CABEZA.d / 2 + 0.004), k]));
const geometriaLentesPeaton = () => lentes(PEATON.ys.map((y, k) => [new THREE.PlaneGeometry(PEATON.lado, PEATON.lado).translate(0, y, PEATON.d / 2 + 0.004), k]));

// Estado en la GPU: el mismo cálculo que luz() y paso() con el reloj del grupo (atributo sem = eje, desfase).
function fases(reloj) {
  const sem = attribute('sem', 'vec2'), eje = sem.x, t = mod(reloj.add(sem.y), CICLO);
  const tramo = (e) => mod(t.sub(e.mul(INICIO[1])).add(CICLO), CICLO);
  const verdeDe = (e) => mix(float(V[0]), float(V[1]), e);
  return { t, eje, tramo, verdeDe };
}
const encendida = noche.mul(2.2).add(1.6); // sobre el umbral del bloom de noche; de día igual se ve
function materialLentes(reloj) {
  const { eje, tramo, verdeDe } = fases(reloj), k = attribute('luz', 'float');
  const s = tramo(eje), v = verdeDe(eje);
  const verde = float(1).sub(step(v, s)), amarillo = step(v, s).mul(float(1).sub(step(v.add(A), s)));
  const rojo = float(1).sub(verde).sub(amarillo);
  const es1 = step(0.5, k).mul(float(1).sub(step(1.5, k))), es2 = step(1.5, k), es0 = float(1).sub(es1).sub(es2);
  const prendida = es0.mul(rojo).add(es1.mul(amarillo)).add(es2.mul(verde));
  const tono = color(0xff2414).mul(es0).add(color(0xffa010).mul(es1)).add(color(0x18ffa0).mul(es2));
  const m = new THREE.MeshBasicNodeMaterial();
  m.colorNode = mix(tono.mul(0.07), tono.mul(encendida), prendida);
  return m;
}
// Muñeco por distancias a segmentos (cabeza, tronco, piernas y brazos), quieto o dando un paso.
function munieco(p, caminando) {
  const seg = (a, b) => {
    const pa = p.sub(vec2(...a)), ba = vec2(b[0] - a[0], b[1] - a[1]);
    const l2 = Math.max(1e-6, (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2);
    return length(pa.sub(ba.mul(clamp(dot(pa, ba).div(l2), 0, 1))));
  };
  const trazo = (d, r) => float(1).sub(smoothstep(r - 0.02, r + 0.02, d));
  const partes = caminando
    ? [[[0.53, 0.82], [0.53, 0.82], 0.085], [[0.52, 0.66], [0.48, 0.43], 0.07], [[0.48, 0.43], [0.35, 0.13], 0.05],
      [[0.49, 0.43], [0.62, 0.13], 0.05], [[0.51, 0.63], [0.37, 0.47], 0.04], [[0.53, 0.63], [0.67, 0.5], 0.04]]
    : [[[0.5, 0.82], [0.5, 0.82], 0.085], [[0.5, 0.66], [0.5, 0.43], 0.075], [[0.46, 0.43], [0.45, 0.12], 0.045],
      [[0.54, 0.43], [0.55, 0.12], 0.045], [[0.43, 0.65], [0.41, 0.43], 0.035], [[0.57, 0.65], [0.59, 0.43], 0.035]];
  return partes.map(([a, b, r]) => trazo(seg(a, b), r)).reduce((m, x) => max(m, x));
}
function materialLentesPeaton(reloj) {
  const { t, eje, tramo, verdeDe } = fases(reloj), k = attribute('luz', 'float');
  // Camina con el verde del otro eje, titila desde el despeje hasta el fin de su amarillo, y luego rojo.
  const o = float(1).sub(eje), s = tramo(o), v = verdeDe(o);
  const pasa = float(1).sub(step(v.sub(D), s)), titila = step(v.sub(D), s).mul(float(1).sub(step(v.add(A), s)));
  const rojo = float(1).sub(pasa).sub(titila);
  const verde = step(0.5, k), prendida = mix(rojo, max(pasa, titila.mul(step(0.5, fract(t.mul(1.6))))), verde);
  const tono = mix(color(0xff3a14), color(0x18ffa0), verde);
  const figura = mix(munieco(uv(), false), munieco(uv(), true), verde);
  const m = new THREE.MeshBasicNodeMaterial();
  m.colorNode = mix(color(0x050505), mix(tono.mul(0.09), tono.mul(encendida), prendida), figura);
  return m;
}
function materialPoste() {
  // Base con franjas amarillas y negras de 25 cm hasta 1,5 m; arriba, gris galvanizado.
  const y = positionGeometry.y, franja = step(0.5, fract(y.div(0.5)));
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.5, metalness: 0.45 });
  m.colorNode = mix(vec3(0.42, 0.43, 0.45), mix(color(0x141414), color(0xf2c200), franja), float(1).sub(step(1.5, y)));
  return m;
}

// ---------------------------------------------------------------------------------------------------------------
// Los semáforos completos. choques (opcional): los postes estorban a pie.
// ---------------------------------------------------------------------------------------------------------------
export function crearSemaforos({ vias, calles, choques = null }) {
  const { grupos, porNodo, radio } = armarSemaforos(vias);
  let reloj = 0;
  const relojU = uniform(0);

  // Instancias por tipo, en el orden de los grupos: cada grupo guarda dónde empieza y cuántas tiene de cada tipo.
  const TIPOS = ['bajo', 'alto', 'brazo', 'cabeza', 'peaton'];
  const datos = Object.fromEntries(TIPOS.map((t) => [t, { m: [], sem: [] }]));
  const o = new THREE.Object3D(), prueba = { x: 0, z: 0 };
  const poner = (tipo, g, x, y, z, rumbo, sem = null, largo = 1) => {
    o.position.set(x, y, z);
    o.rotation.set(0, rumbo, 0);
    o.scale.set(largo, 1, 1);
    o.updateMatrix();
    datos[tipo].m.push(...o.matrix.elements);
    if (sem) datos[tipo].sem.push(eje(g, sem[0], sem[1]), g.desfase);
  };
  const eje = (g, dx, dz) => ejeDe(g, dx, dz);
  const libre = (x, z) => {
    if (calles.dentro(x, z, 0.2)) return false; // no en la calzada de otra vía
    if (!choques) return true;
    prueba.x = x; prueba.z = z;
    return !choques.empujar(prueba, 0.25); // ni dentro de un edificio
  };
  const mira = (fx, fz) => Math.atan2(fx, fz); // rumbo que lleva la cara +z hacia (fx, fz)
  for (const g of grupos) {
    g.desde = Object.fromEntries(TIPOS.map((t) => [t, datos[t].m.length / 16]));
    for (const n of g.nodos) {
      const r = radio.get(n.c) || 8;
      for (const a of n.brazos) {
        if (a.interno) continue;
        // Junto a la cebra, del lado de afuera, a lado y lado de la calzada.
        const p = aLoLargo(a.via, a.i, a.s, r + 4.2);
        if (!p) continue;
        const rx = p.tz, rz = -p.tx; // derecha de quien llega al cruce por este brazo
        const off = a.w + 0.55, ex = a.dx, ez = a.dz;
        const xd = p.x + rx * off, zd = p.z + rz * off, xi = p.x - rx * off, zi = p.z - rz * off;
        const bandera = a.entra && a.clase <= 2;
        if (libre(xd, zd)) {
          const y = calles.piso(xd, zd);
          poner(bandera ? 'alto' : 'bajo', g, xd, y, zd, 0);
          choques?.agregar([xd, zd, 0.12]);
          poner('peaton', g, xd - rx * 0.16, y + 2.3, zd - rz * 0.16, mira(-rx, -rz), [ex, ez]);
          if (a.entra) {
            // En el poste, mirando a los que llegan; en avenidas, otra colgada de un brazo sobre sus carriles.
            poner('cabeza', g, xd - rx * 0.24, y + 2.95, zd - rz * 0.24, mira(p.tx, p.tz), [ex, ez]);
            if (bandera) {
              const largo = Math.max(2.5, Math.min(7, (a.via.unSentido ? 2 * a.w : a.w) - 0.8));
              poner('brazo', g, xd, y + Y_BRAZO, zd, Math.atan2(rz, -rx), null, largo);
              poner('cabeza', g, xd - rx * (largo - 0.3), y + Y_BRAZO - 0.12 - CABEZA.h / 2 - 0.2, zd - rz * (largo - 0.3), mira(p.tx, p.tz), [ex, ez]);
            }
          }
        }
        if (libre(xi, zi)) {
          const y = calles.piso(xi, zi);
          poner('bajo', g, xi, y, zi, 0);
          choques?.agregar([xi, zi, 0.12]);
          poner('peaton', g, xi + rx * 0.16, y + 2.3, zi + rz * 0.16, mira(rx, rz), [ex, ez]);
        }
      }
    }
    g.hasta = Object.fromEntries(TIPOS.map((t) => [t, datos[t].m.length / 16]));
  }

  // Mallas: la cabeza y sus lentes comparten matriz (igual el peatonal).
  const grupo = new THREE.Group();
  grupo.name = 'Semaforos';
  const total = (t) => Math.max(1, datos[t].m.length / 16);
  const malla = (geo, mat, tipo, sombra) => {
    const im = new THREE.InstancedMesh(geo, mat, total(tipo));
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.frustumCulled = false; // se llenan con los cruces cercanos
    im.castShadow = sombra;
    im.receiveShadow = sombra;
    im.count = 0;
    im.userData.tipo = tipo;
    grupo.add(im);
    return im;
  };
  const conSem = (geo, tipo) => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(total(tipo) * 2), 2);
    a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('sem', a);
    return geo;
  };
  const matCaja = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.2, side: THREE.DoubleSide });
  const matPoste = materialPoste();
  const matBrazo = new THREE.MeshStandardNodeMaterial({ color: 0x6b6e72, roughness: 0.5, metalness: 0.45 });
  const mallas = [
    malla(new THREE.CylinderGeometry(0.07, 0.085, ALTO_BAJO, 8).translate(0, ALTO_BAJO / 2, 0), matPoste, 'bajo', true),
    malla(new THREE.CylinderGeometry(0.09, 0.11, ALTO_ALTO, 8).translate(0, ALTO_ALTO / 2, 0), matPoste, 'alto', true),
    malla(new THREE.BoxGeometry(1, 0.1, 0.1).translate(0.5, 0, 0), matBrazo, 'brazo', true),
    malla(geometriaCabeza(), matCaja, 'cabeza', true),
    malla(conSem(geometriaLentes(), 'cabeza'), materialLentes(relojU), 'cabeza', false),
    malla(geometriaPeaton(), matCaja, 'peaton', true),
    malla(conSem(geometriaLentesPeaton(), 'peaton'), materialLentesPeaton(relojU), 'peaton', false),
  ];

  // Llena las mallas con los grupos a menos de RADIO_VISTA de (x, z).
  let cx = Infinity, cz = Infinity;
  function llenar(x, z) {
    cx = x; cz = z;
    for (const im of mallas) im.count = 0;
    for (const g of grupos) {
      if ((g.x - x) ** 2 + (g.z - z) ** 2 > RADIO_VISTA * RADIO_VISTA) continue;
      for (const im of mallas) {
        const t = im.userData.tipo, desde = g.desde[t], n = g.hasta[t] - desde;
        if (!n) continue;
        im.instanceMatrix.array.set(datos[t].m.slice(desde * 16, (desde + n) * 16), im.count * 16);
        const sem = im.geometry.attributes.sem;
        if (sem) sem.array.set(datos[t].sem.slice(desde * 2, (desde + n) * 2), im.count * 2);
        im.count += n;
      }
    }
    for (const im of mallas) {
      im.instanceMatrix.needsUpdate = true;
      if (im.geometry.attributes.sem) im.geometry.attributes.sem.needsUpdate = true;
    }
  }

  const tiempo = (g) => reloj + g.desfase;
  const api = {
    grupo, grupos,
    // Grupo del semáforo del vértice (x, z) de una vía, o null si ese cruce no tiene.
    grupoEn: (x, z) => porNodo.get(llave(x, z)) || null,
    eje,
    estado: (g, e) => luz(tiempo(g), e), // VERDE, AMARILLO o ROJO para los carros del eje e
    peatonal: (g, e) => paso(tiempo(g), e), // para quien atraviesa las calzadas del eje e
    puedeCruzar: (g, e) => paso(tiempo(g), e) === VERDE,
    get reloj() { return reloj; },
    actualizar(dt, camara = null) {
      reloj += dt;
      relojU.value = reloj;
      if (!camara) return;
      const { x, y, z } = camara.position;
      if (y - calles.piso(x, z) > ALTO_MAXIMO) { for (const im of mallas) im.count = 0; cx = Infinity; return; }
      if (Math.hypot(x - cx, z - cz) > 30) llenar(x, z);
    },
  };
  return api;
}
