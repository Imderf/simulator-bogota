import * as THREE from 'three/webgpu';
import { attribute, varying, vec3, floor, mod, pow } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { anchoVia, andenVia } from './vias.js';
import { crearEsqueleto, geometriasPiezas, materialPersonaje, anillo, superficie } from './personaje.js';

// Peatones: una multitud alrededor de la cámara que camina por los andenes, la Séptima peatonal y la Plaza de Bolívar,
// más o menos según la hora. Usan el cuerpo del jugador (js/personaje.js): cada persona tiene su esqueleto de pivotes
// sin mallas, y lo que se dibuja es una malla instanciada por pieza del cuerpo, con un juego detallado de cerca (con
// sombra) y uno liviano de lejos. Piel, pelo y ropa van por instancia; falda o abrigo, ruana, pelo largo, gorra,
// sombrilla y morral son mallas instanciadas aparte. En total unas 30 llamadas a la GPU.

const MAXIMO = 300; // personas a la vez (tamaño de las instancias)
const RADIO = 300; // m alrededor de la cámara
const CERCA = 45; // más cerca, cuerpo detallado y con sombra
const ALTO_MAXIMO = 400; // con la cámara más alta que esto sobre el piso no se distinguen: no se actualizan
const PLAZA_RADIO = 40; // la plaza es un cuadrado de 104 m girado con la cuadrícula; el círculo queda adentro, sin tocar andenes
const ADOQUIN = 0.25; // el adoquín de la plaza va 25 cm sobre el piso (lugares.js); los de la plaza pisan encima
const ESTATUA = 2.4; // radio del pedestal de Bolívar, que no está en los choques
const MUSEO_ORO = [352, -380];
const PESO_PLAZA = 1500; // la plaza cuenta como 1,5 km de andén
const PESO_REF = 25000; // con este peso de red a la redonda se llena el máximo (a 300 m de la plaza hay unos 31.000)
const GIRO = 4; // rad/s
const RADIO_PERSONA = 0.28;

// ---------------------------------------------------------------------------------------------------------------
// Cuánta gente: por hora y por zona.
// ---------------------------------------------------------------------------------------------------------------
// De 0 a 1: picos a la entrada de oficinas (7:30), al mediodía y a la salida (17:30); poca de noche y casi nadie de
// madrugada.
const HORAS = [[0, 0.04], [4.5, 0.03], [5.5, 0.18], [6.5, 0.6], [7.5, 1], [9, 0.7], [11, 0.72], [12.5, 0.95], [14, 0.78],
  [16, 0.72], [17.5, 1], [19, 0.75], [20.5, 0.35], [22, 0.14], [24, 0.04]];
export function densidadHora(hora) {
  const h = ((hora % 24) + 24) % 24;
  for (let i = 1; i < HORAS.length; i++) {
    const [h1, v1] = HORAS[i], [h0, v0] = HORAS[i - 1];
    if (h <= h1) return v0 + ((v1 - v0) * (h - h0)) / (h1 - h0);
  }
  return HORAS[0][1];
}

// Más gente alrededor de la Plaza de Bolívar y del Museo del Oro (la Séptima pesa más por ser peatonal).
const campana = (x, z, [cx, cz], r) => Math.exp(-((x - cx) ** 2 + (z - cz) ** 2) / (r * r));
const pesoZona = (x, z, plaza) => 1 + 3 * campana(x, z, plaza, 200) + 2 * campana(x, z, MUSEO_ORO, 150);
const de = (lista) => lista[Math.floor(Math.random() * lista.length)];
const envolver = (a) => a - Math.round(a / (Math.PI * 2)) * Math.PI * 2;
const rumboHacia = (dx, dz) => Math.atan2(-dx, -dz);

// ---------------------------------------------------------------------------------------------------------------
// Red para caminar: andenes de las vías de carros (no las de servicio ni las de TransMilenio, que no tienen) y calles
// peatonales, partidas en tramos entre esquinas. Cada tramo se recorta en sus puntas hasta donde empieza el andén
// (allí lo corta vias.js) y se camina corrido de su eje, por una franja a cada lado: el andén, o media peatonal.
// En la esquina se sigue por otro tramo, del lado más cercano: si ese lado queda al otro lado de una calle, se cruza
// por la esquina. No toca three: se prueba en node con los datos reales.
// Los datos no casan del todo: en uno de cada seis puntos el andén de 2 a 3,5 m de vias.js cae dentro de una planta
// del catastro (andenes angostos de La Candelaria, ejes corridos). Por eso la franja se angosta en cada punto hasta el
// primer muro, con muro(x0, z0, x1, z1) = fracción del trayecto antes de un muro (choques.rayo). Y un lado que cae casi
// todo sobre otra calzada (dentro(x, z), de calles.js) no se camina: es el del separador en las vías dobles, como las
// de carros junto a los carriles de TransMilenio.
// ---------------------------------------------------------------------------------------------------------------
export function crearRed(vias, centroPlaza, { dentro = () => false, muro = () => 1 } = {}) {
  const llave = (x, z) => `${x},${z}`;
  const caminable = (v) => !v.bus && (v.clase === 5 || (v.clase <= 3 && andenVia(v) > 0));

  // Esquinas: vértices donde los tramos caminables no siguen derecho (grado distinto de 2) y las puntas de cada vía.
  const grado = new Map(), nodos = new Set();
  for (const v of vias) {
    if (!caminable(v)) continue;
    v.p.forEach(([x, z], i) => { const c = llave(x, z); grado.set(c, (grado.get(c) || 0) + (i > 0) + (i < v.p.length - 1)); });
    nodos.add(llave(...v.p[0])).add(llave(...v.p.at(-1)));
  }
  for (const [c, g] of grado) if (g !== 2) nodos.add(c);
  // Lo que ocupa cada vía que pasa por una esquina (media calzada y su andén): los tramos de las otras se recortan ahí.
  const ocupa = new Map();
  vias.forEach((v, iv) => {
    if (v.clase > 5) return;
    const r = anchoVia(v) / 2 + andenVia(v);
    for (const [x, z] of v.p) { const c = llave(x, z); if (nodos.has(c)) (ocupa.get(c) ?? ocupa.set(c, []).get(c)).push(iv, r); }
  });
  const recorte = (c, iv) => {
    let r = 0;
    const o = ocupa.get(c) || [];
    for (let j = 0; j < o.length; j += 2) if (o[j] !== iv) r = Math.max(r, o[j + 1]);
    return r;
  };

  function tramo(v, iv, pts) {
    const d = [0];
    for (let i = 1; i < pts.length; i++) d.push(d[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const L = d.at(-1), ka = llave(...pts[0]), kb = llave(...pts.at(-1));
    let ra = recorte(ka, iv), rb = recorte(kb, iv);
    const f = Math.min(1, Math.max(0, L - 0.5) / (ra + rb || 1));
    ra *= f; rb *= f;
    const en = (s) => {
      let j = 0;
      while (j < pts.length - 2 && d[j + 1] < s) j++;
      const t = (s - d[j]) / (d[j + 1] - d[j] || 1);
      return [pts[j][0] + (pts[j + 1][0] - pts[j][0]) * t, pts[j][1] + (pts[j + 1][1] - pts[j][1]) * t];
    };
    // Eje recortado, con un punto cada 8 m como mucho para seguir de cerca los muros.
    const eje = [en(ra), ...pts.filter((_, i) => d[i] > ra + 0.05 && d[i] < L - rb - 0.05), en(L - rb)], x = [eje[0][0]], z = [eje[0][1]];
    for (let i = 1; i < eje.length; i++) {
      const [ax, az] = eje[i - 1], [bx, bz] = eje[i], k = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 8));
      for (let s = 1; s <= k; s++) { x.push(ax + ((bx - ax) * s) / k); z.push(az + ((bz - az) * s) / k); }
    }
    const n = x.length, largo = [0];
    for (let i = 1; i < n; i++) largo.push(largo[i - 1] + Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1]));
    // Dirección de cada tramo del eje (los de largo cero copian la anterior) y normal a la derecha del sentido del
    // dibujo en cada vértice, en inglete para que el corrimiento sea parejo en las curvas.
    let gx = pts.at(-1)[0] - pts[0][0], gz = pts.at(-1)[1] - pts[0][1];
    const gl = Math.hypot(gx, gz);
    [gx, gz] = gl > 1e-6 ? [gx / gl, gz / gl] : [1, 0];
    const ux = [], uz = [];
    for (let i = 0; i < n - 1; i++) {
      const dx = x[i + 1] - x[i], dz = z[i + 1] - z[i], l = Math.hypot(dx, dz);
      if (l > 1e-6) { gx = dx / l; gz = dz / l; }
      ux.push(gx); uz.push(gz);
    }
    const nx = [], nz = [];
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 2, i);
      let mx = -(uz[a] + uz[b]), mz = ux[a] + ux[b];
      const ml = Math.hypot(mx, mz);
      [mx, mz] = ml > 1e-6 ? [mx / ml, mz / ml] : [-uz[b], ux[b]];
      const k = 1 / Math.max(0.5, -mx * uz[b] + mz * ux[b]);
      nx.push(mx * k); nz.push(mz * k);
    }
    const w = anchoVia(v) / 2, an = andenVia(v), peatonal = v.clase === 5, [cx, cz] = en(L / 2);
    const zona = pesoZona(cx, cz, centroPlaza);
    // Franja [cerca, lejos] del eje a cada lado (índice 0: lado -1; 1: lado +1), recortada 0,4 m antes del primer muro.
    // Las distancias se miden sobre la normal en inglete, de largo k ≥ 1.
    const [lo0, hi0] = peatonal ? [0.75, w - 0.75] : [w + 0.45, w + an - 0.45];
    const lo = [[], []], hi = [[], []];
    const lados = [-1, 1].filter((lado, s) => {
      let contraMuro = 0, enCalzada = 0;
      for (let i = 0; i < n; i++) {
        const k = Math.hypot(nx[i], nz[i]), alcance = (hi0 + 0.4) * k;
        const libre = (muro(x[i], z[i], x[i] + (nx[i] / k) * lado * alcance, z[i] + (nz[i] / k) * lado * alcance) * alcance - 0.4) / k;
        const h = Math.max(0.3, Math.min(hi0, libre));
        hi[s].push(h);
        lo[s].push(Math.min(lo0, h));
        if (libre < (peatonal ? 0.3 : w + 0.1)) contraMuro++; // en una peatonal angosta se camina por el centro
        const m = (lo[s][i] + h) / 2;
        if (!peatonal && dentro(x[i] + nx[i] * lado * m, z[i] + nz[i] * lado * m)) enCalzada++;
      }
      return contraMuro <= n * 0.3 && enCalzada <= n * 0.5;
    });
    return {
      iv, peatonal, ka, kb, n, x, z, nx, nz, largo, cx, cz, zona, lados, lo, hi,
      // Para aparecer: un andén por lado caminable; la peatonal, más ancha y concurrida, vale el doble.
      peso: largo.at(-1) * zona * (peatonal ? 2 : 1) * lados.length,
    };
  }

  const aristas = [], ady = new Map();
  const unir = (c, a, extremo) => (ady.get(c) ?? ady.set(c, []).get(c)).push({ a, extremo });
  vias.forEach((v, iv) => {
    if (!caminable(v)) return;
    for (let i0 = 0, i = 1; i < v.p.length; i++) {
      if (i < v.p.length - 1 && !nodos.has(llave(...v.p[i]))) continue;
      const a = tramo(v, iv, v.p.slice(i0, i + 1));
      aristas.push(a);
      unir(a.ka, a, 0);
      unir(a.kb, a, 1);
      i0 = i;
    }
  });

  // Rejilla de 100 m por el punto medio de cada tramo, para elegir dónde aparece la gente cerca de la cámara.
  const CELDA = 100, celdas = new Map();
  for (const a of aristas) {
    const c = `${Math.floor(a.cx / CELDA)},${Math.floor(a.cz / CELDA)}`;
    (celdas.get(c) ?? celdas.set(c, []).get(c)).push(a);
  }
  const plaza = { x: centroPlaza[0], z: centroPlaza[1], r: PLAZA_RADIO, peso: PESO_PLAZA * pesoZona(...centroPlaza, centroPlaza) };

  // Tramos (y la plaza) a menos de `radio` de (x, z), con sus pesos acumulados para sortear.
  function cerca(x, z, radio) {
    const lista = [], acum = [];
    let total = 0;
    const sumar = (o) => { total += o.peso; lista.push(o); acum.push(total); };
    for (let i = Math.floor((x - radio) / CELDA); i <= Math.floor((x + radio) / CELDA); i++) {
      for (let j = Math.floor((z - radio) / CELDA); j <= Math.floor((z + radio) / CELDA); j++) {
        for (const a of celdas.get(`${i},${j}`) || []) if ((a.cx - x) ** 2 + (a.cz - z) ** 2 < radio * radio && a.peso > 0) sumar(a);
      }
    }
    if ((plaza.x - x) ** 2 + (plaza.z - z) ** 2 < radio * radio) sumar(plaza);
    return { lista, acum, total, x, z };
  }
  function sortear(c) {
    if (!c.lista.length) return null;
    const u = Math.random() * c.total;
    let lo = 0, hi = c.acum.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (c.acum[m] < u) lo = m + 1; else hi = m; }
    return c.lista[lo];
  }

  // Distancia al eje en el punto i: carril -1 va por el borde cercano de la franja y +1 por el lejano.
  const corrimiento = (a, lado, i, carril) => {
    const s = lado > 0 ? 1 : 0;
    return lado * (a.lo[s][i] + (carril + 1) * 0.5 * (a.hi[s][i] - a.lo[s][i]));
  };
  function objetivo(p) {
    const a = p.arista, off = corrimiento(a, p.lado, p.i, p.carril);
    p.ox = a.x[p.i] + a.nx[p.i] * off;
    p.oz = a.z[p.i] + a.nz[p.i] * off;
  }

  // Alguien nuevo en un punto al azar del tramo, en cualquiera de los dos andenes y caminando hacia cualquier lado.
  function ponerEnArista(p, a) {
    const L = a.largo.at(-1), u = Math.random() * L;
    let j = 0;
    while (j < a.n - 2 && a.largo[j + 1] < u) j++;
    const dx = a.x[j + 1] - a.x[j], dz = a.z[j + 1] - a.z[j], l = Math.hypot(dx, dz) || 1, t = Math.min(1, (u - a.largo[j]) / l);
    Object.assign(p, { modo: 'calle', arista: a, lado: de(a.lados), carril: Math.random() * 2 - 1, dir: Math.random() < 0.5 ? -1 : 1, pausa: 0, mirar: null });
    const off = corrimiento(a, p.lado, j, p.carril) * (1 - t) + corrimiento(a, p.lado, j + 1, p.carril) * t;
    p.x = a.x[j] + dx * t - (dz / l) * off;
    p.z = a.z[j] + dz * t + (dx / l) * off;
    p.i = p.dir > 0 ? j + 1 : j;
    objetivo(p);
  }

  // Llegó a su punto: el siguiente del tramo o, en la esquina, otro tramo. Devuelve cuántos metros hay hasta el
  // primer punto del tramo nuevo (más de unos 4 m es cruzar una calle) o 0 si sigue por el mismo.
  function siguiente(p) {
    const a = p.arista, i2 = p.i + p.dir;
    if (i2 >= 0 && i2 < a.n) { p.i = i2; objetivo(p); return 0; }
    const extremo = p.dir > 0 ? 1 : 0, nodo = extremo ? a.kb : a.ka;
    // Dirección con la que llega.
    const ia = Math.max(0, Math.min(a.n - 2, p.dir > 0 ? a.n - 2 : 0));
    let ex = (a.x[ia + 1] - a.x[ia]) * p.dir, ez = (a.z[ia + 1] - a.z[ia]) * p.dir;
    const el = Math.hypot(ex, ez) || 1;
    ex /= el; ez /= el;
    let mejor = null, puntaje = -Infinity;
    for (const s of ady.get(nodo) || []) {
      if ((s.a === a && s.extremo === extremo) || !s.a.lados.length) continue;
      const b = s.a, dir = s.extremo === 0 ? 1 : -1, i0 = s.extremo === 0 ? 0 : b.n - 1, i1 = Math.max(0, Math.min(b.n - 1, i0 + dir));
      const sx = b.x[i1] - b.x[i0], sz = b.z[i1] - b.z[i0], sl = Math.hypot(sx, sz) || 1;
      // Mejor derecho que voltear, un empujón hacia donde hay más gente y hacia la peatonal, y azar.
      const valor = ((ex * sx + ez * sz) / sl) * 0.8 + Math.random() + Math.max(-0.5, Math.min(0.5, (b.zona - a.zona) / a.zona)) + (b.peatonal ? 0.25 : 0);
      if (valor > puntaje) { puntaje = valor; mejor = { b, dir, i0 }; }
    }
    const px = p.ox, pz = p.oz;
    if (!mejor || Math.random() < 0.04) {
      // Calle ciega (o ganas de devolverse): cruza al otro andén, si lo hay, y vuelve por donde vino.
      p.dir = -p.dir;
      if (a.lados.length > 1) p.lado = -p.lado;
      objetivo(p);
      return Math.hypot(p.ox - px, p.oz - pz);
    }
    // Del lado del tramo nuevo que quede más cerca: la misma esquina o, si no, cruzando una sola calle.
    const { b, dir, i0 } = mejor;
    const lejos = (lado) => { const o = corrimiento(b, lado, i0, p.carril); return (b.x[i0] + b.nx[i0] * o - px) ** 2 + (b.z[i0] + b.nz[i0] * o - pz) ** 2; };
    const lado = b.lados.length > 1 ? (lejos(1) <= lejos(-1) ? 1 : -1) : b.lados[0];
    Object.assign(p, { arista: b, dir, i: i0, lado });
    objetivo(p);
    return Math.hypot(p.ox - px, p.oz - pz);
  }

  // Plaza: puntos al azar dentro del círculo, lejos del pedestal.
  function destinoPlaza(p) {
    for (let k = 0; k < 8; k++) {
      const ang = Math.random() * Math.PI * 2, d = 6 + Math.random() * 24;
      const x = p.x - Math.sin(ang) * d, z = p.z - Math.cos(ang) * d, r = Math.hypot(x - plaza.x, z - plaza.z);
      if (r < plaza.r && r > ESTATUA + 1.5) { p.ox = x; p.oz = z; return; }
    }
    const ang = Math.random() * Math.PI * 2, r = ESTATUA + 2 + Math.sqrt(Math.random()) * (plaza.r - ESTATUA - 2);
    p.ox = plaza.x + Math.cos(ang) * r;
    p.oz = plaza.z + Math.sin(ang) * r;
  }
  // Al llegar se queda un rato: unos quietos mirando la estatua o alrededor, otros una pausa corta, otros siguen.
  function pasearPlaza(p) {
    const t = Math.random();
    p.mirar = null;
    if (t < 0.12) {
      p.pausa = 30 + Math.random() * 90;
      p.mirar = Math.random() < 0.5 ? rumboHacia(plaza.x - p.x, plaza.z - p.z) : Math.random() * Math.PI * 2;
    } else if (t < 0.5) p.pausa = 2 + Math.random() * 8;
    destinoPlaza(p);
  }
  function ponerEnPlaza(p) {
    const ang = Math.random() * Math.PI * 2, r = ESTATUA + 1 + Math.sqrt(Math.random()) * (plaza.r - ESTATUA - 1);
    Object.assign(p, { modo: 'plaza', arista: null, x: plaza.x + Math.cos(ang) * r, z: plaza.z + Math.sin(ang) * r, pausa: 0, mirar: null });
    if (Math.random() < 0.25) pasearPlaza(p); else destinoPlaza(p);
  }

  return { aristas, ady, plaza, cerca, sortear, ponerEnArista, ponerEnPlaza, siguiente, pasearPlaza };
}

// ---------------------------------------------------------------------------------------------------------------
// Ropa. Paletas en sRGB (0xRRGGBB): Bogotá se viste oscuro y abrigado. Piel, pelo y jean adaptados de Slop New York
// (mrdoob, MIT): pedestrians.js.
// ---------------------------------------------------------------------------------------------------------------
const PIEL = [0xe8c3a0, 0xe0b48f, 0xd9a077, 0xc68863, 0xb07a52, 0xa96f4c, 0x8a5535, 0x6b3d24];
const PELO = [0x0f0c0b, 0x1a1512, 0x1a1512, 0x2a2624, 0x3a2a1a, 0x584022, 0x8f6d43];
const CANAS = [0x6e6862, 0x9c968f, 0xc4beb6];
const CHAQUETAS = [0x1f1d22, 0x2b3a52, 0x33332f, 0x4f5238, 0x5a2f2f, 0x223047, 0x6a6a66, 0x7d5a3c, 0xa63a32, 0x3c5a7a];
const ABRIGOS = [0x1f1d22, 0x2a2a2e, 0x8a6a44, 0x3a3f4a, 0x4a2a2e, 0x6a5a48, 0x223047];
const SACOS = [0x7a2630, 0x5b6b4a, 0x9a8f7a, 0xc9c1b2, 0x2e3e5c, 0x8c5a7a, 0x4a4a4e, 0xb8a27a];
const CAMISAS = [0xe8e6e0, 0xb8c4d8, 0xcfc8b8, 0x9aa7b8, 0xd9c7c0, 0xf0ece2];
const RUANAS = [0x6b5a48, 0x8f8070, 0x3f3a36, 0x7a6248, 0xb8ab94, 0x4a3c30, 0x5a4a3a];
const PANTALONES = [0x2f4361, 0x35485b, 0x22242c, 0x51473d, 0x7c7160, 0x1f2a3d, 0x2f4361, 0x3a3a3e];
const FALDAS = [0x1c1c22, 0x2f3a52, 0x5a2a2e, 0x46413b, 0x7a6a5a, 0x2a3a2a];
const MEDIAS = [0x1c1c22, 0x2a2a30, 0x3a2e2a];
const ZAPATOS = [0x1b1a1a, 0x1b1a1a, 0x3a2a20, 0x34363b, 0x6b4a32, 0xe4e0d7];
const GORRAS = [0x1f1d22, 0xd4b800, 0x1f3f8a, 0xa63a32, 0xe8e4dc, 0x2b3a52];
const SOMBRILLAS = [0x141414, 0x141414, 0x141414, 0x1f2f5a, 0x6a1f2a, 0x2a5a3a, 0xd4b030];
const MORRALES = [0x222222, 0x2b3a52, 0x5a2f2f, 0x3f5a3a, 0x4a4a4e];
// Uniformes de colegio: saco, pantalón, jardinera y sudadera de educación física.
const COLEGIOS = [
  { saco: 0x1f2f5a, pantalon: 0x3a3f4a, falda: 0x3a3f4a, sudadera: 0x1f3f8a },
  { saco: 0x6a1f2a, pantalon: 0x2a2a30, falda: 0x6a1f2a, sudadera: 0x8a1f2a },
  { saco: 0x1f4a2e, pantalon: 0x3a3f4a, falda: 0x1f4a2e, sudadera: 0x2a6a3a },
];
const FALDA = 0, RUANA = 1, PELO_LARGO = 2, GORRA = 3, SOMBRILLA = 4, MORRAL = 5;

// Cuerpo, paso y ropa de alguien que aparece. Los accesorios quedan como { tipo, color, largo }.
export function vestir(p, hora) {
  const r = Math.random;
  const mujer = r() < 0.5, colegio = hora > 6 && hora < 18.5 && r() < 0.1, mayor = !colegio && r() < 0.12;
  // Escalas de la raíz: alto, y ancho y fondo por contextura (las mujeres un poco más angostas).
  p.alto = colegio ? 0.8 + 0.12 * r() : (mujer ? 0.93 : 0.98) + 0.08 * r() - (mayor ? 0.03 : 0);
  p.ancho = (mujer ? 0.92 : 1) * (0.9 + 0.22 * r());
  p.velDeseada = mayor ? 0.85 + 0.25 * r() : colegio ? 1.3 + 0.35 * r() : 1.15 + 0.4 * r();
  if (p.modo === 'plaza') p.velDeseada *= 0.8; // pasean
  const piel = de(PIEL), pelo = mayor ? de(CANAS) : de(PELO), extras = [];
  let arriba, abajo = de(PANTALONES), zapatos = de(ZAPATOS), falda = null, largo = 1;
  if (colegio) {
    const u = de(COLEGIOS);
    if (r() < 0.3) { arriba = abajo = u.sudadera; zapatos = 0xe4e0d7; } else {
      arriba = u.saco;
      zapatos = 0x141414;
      if (mujer) { falda = u.falda; abajo = r() < 0.5 ? 0xe8e4dc : u.saco; } else abajo = u.pantalon;
    }
    if (r() < 0.8) extras.push([MORRAL, de(MORRALES)]);
  } else {
    const t = r();
    if (t < (mayor ? 0.3 : 0.08)) { arriba = de(SACOS); extras.push([RUANA, de(RUANAS)]); } else if (t < 0.3) {
      arriba = falda = de(ABRIGOS); // abrigo largo: el faldón llega abajo de la rodilla
      largo = 1.35;
    } else arriba = de(t < 0.52 ? SACOS : t < 0.85 ? CHAQUETAS : CAMISAS);
    if (mujer && largo === 1 && r() < 0.3) { falda = de(FALDAS); abajo = r() < 0.4 ? piel : de(MEDIAS); }
    if (r() < 0.15) extras.push([MORRAL, de(MORRALES)]);
  }
  if (falda !== null) extras.push([FALDA, falda]);
  if (r() < (mujer ? 0.7 : 0.04)) extras.push([PELO_LARGO, pelo]);
  if (r() < (mujer ? 0.04 : 0.14)) extras.push([GORRA, de(GORRAS)]);
  p.sombrilla = r() < 0.07; // Bogotá llueve
  if (p.sombrilla) extras.push([SOMBRILLA, de(SOMBRILLAS)]);
  p.ropa[0] = piel; p.ropa[1] = pelo; p.ropa[2] = arriba; p.ropa[3] = abajo; p.zapatos = zapatos;
  p.accesorios = extras.map(([tipo, color]) => ({ tipo, color, largo: tipo === FALDA ? largo : 1 }));
}

// Brazo derecho de quien lleva sombrilla: hombro adelante y un poco hacia adentro, codo doblado.
function sostener(esq) {
  const b = esq.brazos[1];
  b.hombro.rotation.set(0.35, 0, -0.12);
  b.codo.rotation.set(1.25, 0, 0);
}

// Accesorios en coordenadas del cuerpo en reposo, como las piezas: van con el torso (pieza 0) o la cabeza (pieza 1).
function geometriasAccesorios() {
  const tubo = (filas, n, tapa = false) => superficie(filas.map(([y, rx, rzD, rzA, cz]) => anillo(y, rx, rzD, rzA, cz, n)), 0, tapa);
  // Falda en A, holgada para que las rodillas no la atraviesen; con más largo es el faldón del abrigo.
  const falda = tubo([[0.985, 0.168, 0.11, 0.118, 0], [0.93, 0.18, 0.125, 0.13, 0], [0.8, 0.205, 0.16, 0.16, 0], [0.65, 0.23, 0.2, 0.19, 0], [0.53, 0.245, 0.215, 0.2, 0]], 14);
  // Ruana: del cuello cae sobre los hombros y tapa los brazos hasta medio muslo.
  const ruana = tubo([[1.55, 0.062, 0.058, 0.062, 0.012], [1.5, 0.16, 0.1, 0.1, 0.015], [1.45, 0.27, 0.15, 0.13, 0.015], [1.38, 0.31, 0.17, 0.15, 0.012], [1.15, 0.33, 0.18, 0.16, 0.005], [0.86, 0.34, 0.19, 0.17, 0]], 16);
  // Pelo largo: una concha por detrás y a los lados de la cabeza que cae sobre la espalda; adelante queda dentro de la cara.
  const pelo = tubo([[1.735, 0.07, 0.04, 0.085, 0.02], [1.69, 0.098, 0.05, 0.112, 0.02], [1.6, 0.104, 0.035, 0.118, 0.03], [1.5, 0.1, 0.02, 0.105, 0.045], [1.4, 0.11, 0.005, 0.09, 0.06]], 14);
  // Gorra: copa sobre el casco de pelo y visera (media elipse plana adelante).
  const gorra = mergeGeometries([
    tubo([[1.776, 0.025, 0.025, 0.028, 0.012], [1.76, 0.068, 0.07, 0.077, 0.013], [1.735, 0.09, 0.094, 0.104, 0.013], [1.7, 0.097, 0.1, 0.11, 0.012], [1.672, 0.098, 0.1, 0.11, 0.011]], 14, true),
    superficie([anillo(1.676, 0.085, 0.19, 0, 0, 12), anillo(1.667, 0.085, 0.19, 0, 0, 12)], 0, true, true),
  ]);
  const morral = new THREE.BoxGeometry(0.27, 0.36, 0.12).translate(0, 1.2, 0.16);
  // Sombrilla en la mano derecha con el brazo en su pose: se arma un esqueleto así, se mira dónde queda la palma
  // (en reposo, cerca de (0,185; 0,81)) y se lleva a coordenadas del torso en reposo. El palo se inclina hacia la cabeza.
  const esq = crearEsqueleto();
  sostener(esq);
  esq.cadera.rotation.set(0, 0, 0);
  esq.raiz.updateMatrixWorld(true);
  const [torso, , , , , , , , , , , antebrazo] = esq.piezas, m = new THREE.Matrix4();
  const mano = new THREE.Vector3(0.185, 0.81, 0.015).sub(antebrazo.punto).applyMatrix4(antebrazo.pivote.matrixWorld)
    .applyMatrix4(m.copy(torso.pivote.matrixWorld).multiply(new THREE.Matrix4().makeTranslation(-torso.punto.x, -torso.punto.y, -torso.punto.z)).invert());
  const eje = new THREE.Vector3(-mano.x * 0.6, 1, -mano.z * 0.6).normalize();
  const sombrilla = mergeGeometries([
    new THREE.CylinderGeometry(0.009, 0.009, 1.0, 5).translate(0, 0.42, 0),
    new THREE.ConeGeometry(0.5, 0.2, 8, 1, true).translate(0, 0.92, 0),
  ]).applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), eje)).translate(mano.x, mano.y, mano.z);
  return [[falda, 0], [ruana, 0], [pelo, 1], [gorra, 1], [sombrilla, 0], [morral, 0]];
}

// Material de la multitud: el del jugador con cinco colores por instancia, empacados como enteros 0xRRGGBB en dos
// atributos (un float32 guarda exactos hasta 2^24). Se desempacan en el vértice: interpolados por el triángulo, el
// entero podría perder sus últimos bits. Así son cinco atributos en vez de nueve (WebGPU deja ocho).
function materialMultitud() {
  const ropa = attribute('ropa', 'vec4');
  const tinte = (f) => varying(pow(vec3(floor(f.div(65536)), mod(floor(f.div(256)), 256), mod(f, 256)).div(255), vec3(2.2)));
  return materialPersonaje({ piel: tinte(ropa.x), pelo: tinte(ropa.y), chaqueta: tinte(ropa.z), pantalon: tinte(ropa.w), zapatos: tinte(attribute('zapatos', 'float')) });
}

// ---------------------------------------------------------------------------------------------------------------
// La multitud.
// ---------------------------------------------------------------------------------------------------------------
export function crearPeatones({ vias, calles, choques, lugares }) {
  const red = crearRed(vias, lugares.centroPlaza, {
    dentro: calles.dentro,
    muro: (x0, z0, x1, z1) => choques.rayo(x0, -1e9, z0, x1, -1e9, z1), // tan bajo que cuenta cualquier muro
  });
  const plaza = red.plaza;
  const grupo = new THREE.Group();
  grupo.name = 'Peatones';
  const dinamico = (a) => a.setUsage(THREE.DynamicDrawUsage);
  // Arrancan con todas las instancias en cero (sin dibujar nada) para que la compilación inicial vea el tamaño completo.
  const instancias = (geo, material, sombra) => {
    const m = new THREE.InstancedMesh(geo, material, MAXIMO);
    dinamico(m.instanceMatrix).array.fill(0);
    m.frustumCulled = false; // están repartidos alrededor de la cámara
    m.castShadow = sombra;
    m.receiveShadow = true;
    grupo.add(m);
    return m;
  };

  // Cuerpo: una malla por pieza en dos juegos (cerca y lejos). Las mallas de un juego comparten los atributos de ropa:
  // la instancia s es la misma persona en todas.
  const material = materialMultitud();
  const juegos = [1, 0.5].map((detalle) => {
    const ropa = dinamico(new THREE.InstancedBufferAttribute(new Float32Array(MAXIMO * 4), 4));
    const zapatos = dinamico(new THREE.InstancedBufferAttribute(new Float32Array(MAXIMO), 1));
    const mallas = geometriasPiezas(detalle).map((g) => {
      const geo = g.clone(); // las del jugador quedan sin estos atributos
      geo.setAttribute('ropa', ropa);
      geo.setAttribute('zapatos', zapatos);
      return instancias(geo, material, detalle === 1);
    });
    return { mallas, ropa, zapatos, n: 0 };
  });
  // Cada pieza se dibuja con pivote.matrixWorld · T(-punto); el punto es el mismo para todos.
  const modelo = crearEsqueleto();
  const OFF = modelo.piezas.map(({ punto }) => new THREE.Matrix4().makeTranslation(-punto.x, -punto.y, -punto.z));
  const matAccesorio = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, side: THREE.DoubleSide });
  matAccesorio.colorNode = attribute('tono', 'vec3');
  const extras = geometriasAccesorios().map(([geo, pieza]) => {
    const tono = dinamico(new THREE.InstancedBufferAttribute(new Float32Array(MAXIMO * 3), 3));
    geo.setAttribute('tono', tono);
    return { malla: instancias(geo, matAccesorio, false), tono, pieza, n: 0 };
  });

  const gente = Array.from({ length: MAXIMO }, (_, id) => ({
    id, activo: false, esq: crearEsqueleto(), mats: OFF.map(() => new Float32Array(16)), accMats: [],
    ropa: new Float32Array(4), zapatos: 0, accesorios: [],
    x: 0, y: 0, z: 0, rumbo: 0, vel: 0, velDeseada: 1.3, pausa: 0, mirar: null, modo: 'calle',
    arista: null, i: 0, dir: 1, lado: 1, carril: 0, ox: 0, oz: 0,
    alto: 1, ancho: 1, sombrilla: false, acumulado: 0, atasco: 0, saltos: 0, nuevo: false, dist: 0, ve: false,
  }));
  const libres = gente.map((p) => p).reverse();
  let activos = 0, cuadro = 0, cand = null, cx = 0, cz = 0;
  const frustum = new THREE.Frustum(), esfera = new THREE.Sphere(new THREE.Vector3(), 2), _m = new THREE.Matrix4(), _c = new THREE.Color();

  const piso = (p) => calles.piso(p.x, p.z) + (p.modo === 'plaza' ? ADOQUIN : 0);
  const seVe = (p) => { esfera.center.set(p.x, p.y + 1, p.z); return frustum.intersectsSphere(esfera); };

  function quitar(p) {
    p.activo = false;
    libres.push(p);
    activos--;
  }

  // Aparece alguien en un tramo o en la plaza sorteados por peso. Adaptado de Slop New York (mrdoob, MIT):
  // pedestrian-system.js — dentro de la vista solo aparece lejos; si falta mucha gente (al cargar, al saltar a otro
  // lugar o al cambiar la hora) aparece donde sea.
  function aparecer(hora, relleno) {
    const p = libres.at(-1);
    for (let intento = 0; intento < 6; intento++) {
      const o = red.sortear(cand);
      if (!o) return;
      if (o === plaza) red.ponerEnPlaza(p); else red.ponerEnArista(p, o);
      const d = Math.hypot(p.x - cx, p.z - cz);
      if (d > RADIO) continue;
      p.y = piso(p);
      if (!relleno && d < 150 && seVe(p)) continue;
      libres.pop();
      activos++;
      vestir(p, hora);
      while (p.accMats.length < p.accesorios.length) p.accMats.push(new Float32Array(16));
      for (const a of p.accesorios) {
        a.tono = _c.set(a.color).toArray(new Float32Array(3)); // sRGB → lineal
        a.offset = a.largo === 1 ? OFF[extras[a.tipo].pieza] : new THREE.Matrix4().makeScale(1, a.largo, 1).multiply(OFF[extras[a.tipo].pieza]);
      }
      Object.assign(p, { activo: true, nuevo: true, acumulado: 0, atasco: 0, saltos: 0, vel: p.pausa > 0 ? 0 : p.velDeseada, rumbo: p.mirar ?? rumboHacia(p.ox - p.x, p.oz - p.z) });
      return;
    }
  }

  // Rejilla de 2 m con las posiciones del cuadro, para esquivarse.
  const rejilla = new Map(), celda = (x, z) => (Math.floor(x / 2) + 8192) * 16384 + Math.floor(z / 2) + 8192;
  function esquivar(p, fx, fz, dt) {
    const ix = Math.floor(p.x / 2), iz = Math.floor(p.z / 2);
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        for (const q of rejilla.get((ix + a + 8192) * 16384 + iz + b + 8192) || []) {
          if (q === p || !q.activo) continue;
          const ex = p.x - q.x, ez = p.z - q.z, d2 = ex * ex + ez * ez;
          if (d2 > 4 || d2 < 1e-6) continue;
          const d = Math.sqrt(d2);
          if (d < 0.65) {
            // Encima: se separan (cada uno la mitad en su turno).
            p.x += (ex / d) * (0.65 - d) * 0.5;
            p.z += (ez / d) * (0.65 - d) * 0.5;
          } else if (p.vel > 0.3 && -(ex * fx + ez * fz) > d * 0.6) {
            // El otro va adelante: se corre a su derecha. Si los dos lo hacen, se cruzan sin chocar.
            const k = 0.6 * dt * (2 - d);
            p.x -= fz * k;
            p.z += fx * k;
          }
        }
      }
    }
  }

  function llegar(p) {
    if (p.modo === 'plaza') return red.pasearPlaza(p);
    const cruce = red.siguiente(p);
    // En la esquina, antes de cruzar, a veces espera mirando al otro lado.
    if (cruce > 4 && Math.random() < 0.6) {
      p.pausa = 0.4 + Math.random() * 3;
      p.mirar = rumboHacia(p.ox - p.x, p.oz - p.z);
    } else if (cruce > 0 && Math.random() < 0.03) {
      p.pausa = 3 + Math.random() * 7; // se para a mirar algo
      p.mirar = null;
    }
  }

  function mover(p, dt) {
    if (p.pausa > 0) p.pausa -= dt;
    const quiere = p.pausa > 0 ? 0 : p.velDeseada;
    p.vel += Math.max(-3 * dt, Math.min(1.5 * dt, quiere - p.vel));
    let dx = p.ox - p.x, dz = p.oz - p.z;
    for (let n = 0; n < 4 && p.pausa <= 0 && dx * dx + dz * dz < 0.36; n++) {
      llegar(p);
      p.saltos = 0;
      dx = p.ox - p.x; dz = p.oz - p.z;
    }
    // Camina hacia donde mira y voltea a lo sumo GIRO: las esquinas salen redondeadas.
    const deseado = p.pausa > 0 ? p.mirar ?? p.rumbo : rumboHacia(dx, dz);
    p.rumbo += Math.max(-GIRO * dt, Math.min(GIRO * dt, envolver(deseado - p.rumbo)));
    const fx = -Math.sin(p.rumbo), fz = -Math.cos(p.rumbo), x0 = p.x, z0 = p.z;
    p.x += fx * p.vel * dt;
    p.z += fz * p.vel * dt;
    esquivar(p, fx, fz, dt);
    if (p.modo === 'plaza') {
      const ex = p.x - plaza.x, ez = p.z - plaza.z, d = Math.hypot(ex, ez);
      if (d < ESTATUA && d > 1e-6) { p.x = plaza.x + (ex / d) * ESTATUA; p.z = plaza.z + (ez / d) * ESTATUA; }
    }
    choques.empujar(p, RADIO_PERSONA);
    // Atascado contra un muro o un árbol: salta al siguiente punto. Si sigue pasando y no se ve, se quita.
    if (quiere > 0 && Math.hypot(p.x - x0, p.z - z0) < 0.3 * quiere * dt) p.atasco += dt; else p.atasco = 0;
    if (p.atasco > 2.5) { p.atasco = 0; p.saltos++; llegar(p); }
    p.y = piso(p);
  }

  function posar(p) {
    const { raiz, piezas } = p.esq;
    raiz.position.set(p.x, p.y, p.z);
    raiz.rotation.set(0, p.rumbo, 0);
    raiz.scale.set(p.ancho, p.alto, p.ancho);
    raiz.updateMatrixWorld(true);
    for (let k = 0; k < piezas.length; k++) _m.multiplyMatrices(piezas[k].pivote.matrixWorld, OFF[k]).toArray(p.mats[k]);
    for (let k = 0; k < p.accesorios.length; k++) {
      const a = p.accesorios[k];
      _m.multiplyMatrices(piezas[extras[a.tipo].pieza].pivote.matrixWorld, a.offset).toArray(p.accMats[k]);
    }
  }

  function dibujar(p) {
    const j = p.dist < CERCA ? juegos[0] : juegos[1], s = j.n++;
    for (let k = 0; k < j.mallas.length; k++) j.mallas[k].instanceMatrix.array.set(p.mats[k], s * 16);
    j.ropa.array.set(p.ropa, s * 4);
    j.zapatos.array[s] = p.zapatos;
    for (let k = 0; k < p.accesorios.length; k++) {
      const a = p.accesorios[k], e = extras[a.tipo], s2 = e.n++;
      e.malla.instanceMatrix.array.set(p.accMats[k], s2 * 16);
      e.tono.array.set(a.tono, s2 * 3);
    }
  }

  // hora de 0 a 24; camara: la de la escena (sus matrices del cuadro anterior bastan).
  function actualizar(dt, hora, camara) {
    cuadro++;
    cx = camara.position.x;
    cz = camara.position.z;
    // Muy alto no se dibujan ni se mueven. Se vacían las instancias en vez de ocultar el grupo: así la compilación
    // de los shaders al cargar (con la cámara a cientos de metros) igual los incluye.
    if (camara.position.y - calles.piso(cx, cz) > ALTO_MAXIMO) {
      for (const m of grupo.children) m.count = 0;
      return;
    }
    frustum.setFromProjectionMatrix(_m.multiplyMatrices(camara.projectionMatrix, camara.matrixWorldInverse), camara.coordinateSystem, camara.reversedDepth);
    if (!cand || Math.hypot(cx - cand.x, cz - cand.z) > 25) cand = red.cerca(cx, cz, RADIO);
    const meta = Math.round(MAXIMO * densidadHora(hora) * Math.min(1, Math.max(0.3, cand.total / PESO_REF)));

    rejilla.clear();
    for (const p of gente) {
      if (!p.activo) continue;
      p.dist = Math.hypot(p.x - cx, p.z - cz);
      p.ve = seVe(p);
      const c = celda(p.x, p.z);
      (rejilla.get(c) ?? rejilla.set(c, []).get(c)).push(p);
    }
    // Se van los que quedaron lejos, y fuera de la vista los que sobran o se atascan.
    for (const p of gente) {
      if (p.activo && (p.dist > RADIO + 40 || (!p.ve && (activos > meta || p.saltos > 3)))) quitar(p);
    }
    const falta = Math.min(meta - activos, libres.length);
    const relleno = activos < meta * 0.5;
    for (let k = relleno ? falta : Math.min(falta, 3); k > 0; k--) aparecer(hora, relleno);

    for (const j of juegos) j.n = 0;
    for (const e of extras) e.n = 0;
    for (const p of gente) {
      if (!p.activo) continue;
      if (p.nuevo) { p.dist = Math.hypot(p.x - cx, p.z - cz); p.ve = seVe(p); }
      // Menos actualizaciones lejos y fuera de la vista; el tiempo se acumula para no perder pasos.
      p.acumulado += dt;
      const cada = !p.ve ? 8 : p.dist < 40 ? 1 : p.dist < 110 ? 2 : 4;
      if (p.nuevo || (cuadro + p.id) % cada === 0) {
        const t = Math.min(0.25, p.acumulado);
        mover(p, t);
        p.esq.animar(p.vel, t);
        if (p.sombrilla) sostener(p.esq);
        posar(p);
        p.acumulado = 0;
        p.nuevo = false;
      }
      if (p.ve) dibujar(p);
    }
    for (const j of juegos) {
      for (const m of j.mallas) { m.count = j.n; m.instanceMatrix.needsUpdate = true; }
      j.ropa.needsUpdate = j.zapatos.needsUpdate = true;
    }
    for (const e of extras) { e.malla.count = e.n; e.malla.instanceMatrix.needsUpdate = true; e.tono.needsUpdate = true; }
  }

  return { grupo, actualizar, get cantidad() { return activos; } };
}
