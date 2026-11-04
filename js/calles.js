import { anchoVia, andenVia, altoVia, BORDILLO } from './vias.js';

// Consultas sobre las vías: dónde poner un carro (en su carril y en el sentido en que se maneja), dónde poner a
// alguien a pie (en el andén), si un punto está sobre la calzada y a qué altura está el piso. Rejilla de 64 m.
const CELDA = 64;

// Punto dentro de un polígono [[x, z], ...] (regla par-impar).
const adentro = ([x, z], anillo) => {
  let si = false;
  for (let i = 0, j = anillo.length - 1; i < anillo.length; j = i++) {
    const [xi, zi] = anillo[i], [xj, zj] = anillo[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) si = !si;
  }
  return si;
};

// pisos: superficies elevadas de los lugares hechos a mano ({ anillo, y }), como la losa de la Plaza de Bolívar.
export function crearCalles(vias, terreno, pisos = []) {
  const celdas = new Map();
  for (const v of vias) {
    const w = anchoVia(v) / 2, an = andenVia(v), dy = altoVia(v), r = w + an;
    for (let i = 0; i < v.p.length - 1; i++) {
      const [ax, az] = v.p[i], [bx, bz] = v.p[i + 1];
      const s = { ax, az, bx, bz, w, an, dy, v };
      for (let ix = Math.floor((Math.min(ax, bx) - r) / CELDA); ix <= Math.floor((Math.max(ax, bx) + r) / CELDA); ix++) {
        for (let iz = Math.floor((Math.min(az, bz) - r) / CELDA); iz <= Math.floor((Math.max(az, bz) + r) / CELDA); iz++) {
          const k = `${ix},${iz}`;
          if (!celdas.has(k)) celdas.set(k, []);
          celdas.get(k).push(s);
        }
      }
    }
  }

  // Recorre los tramos cercanos y llama f(tramo, distancia, punto más cercano, dirección).
  function recorrer(x, z, radio, f) {
    const vistos = new Set();
    for (let ix = Math.floor((x - radio) / CELDA); ix <= Math.floor((x + radio) / CELDA); ix++) {
      for (let iz = Math.floor((z - radio) / CELDA); iz <= Math.floor((z + radio) / CELDA); iz++) {
        for (const s of celdas.get(`${ix},${iz}`) || []) {
          if (vistos.has(s)) continue;
          vistos.add(s);
          const dx = s.bx - s.ax, dz = s.bz - s.az, l2 = dx * dx + dz * dz || 1, l = Math.sqrt(l2);
          const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / l2));
          const qx = s.ax + dx * t, qz = s.az + dz * t;
          f(s, Math.hypot(qx - x, qz - z), qx, qz, dx / l, dz / l);
        }
      }
    }
  }

  // ¿El punto está sobre la calzada de alguna vía de carros? `margen` > 0 da gracia (el carro contra el bordillo);
  // < 0 exige estar bien adentro (un árbol de alcorque junto al bordillo no cuenta).
  function dentro(x, z, margen = 0.5) {
    let si = false;
    recorrer(x, z, 1, (s, d) => { if (s.v.clase <= 4 && d <= s.w + margen) si = true; });
    return si;
  }

  // Altura del piso donde se pisa: las vías van levantadas sobre el terreno y los andenes un bordillo más.
  // Personas, carros y postes se apoyan aquí; si no, quedan hundidos en el pavimento.
  function piso(x, z) {
    let extra = 0;
    recorrer(x, z, 1, (s, d) => {
      if (d <= s.w) extra = Math.max(extra, s.dy);
      else if (s.an && d <= s.w + s.an) extra = Math.max(extra, s.dy + BORDILLO);
    });
    let y = terreno.altura(x, z) + extra;
    for (const p of pisos) if (adentro([x, z], p.anillo)) y = Math.max(y, p.y);
    return y;
  }

  // Carril para un carro cerca de (x, z): la calle de carros más cercana (no de servicio ni de TransMilenio).
  // En una de doble sentido toma el sentido más parecido a `rumbo` y se pone a la derecha.
  function carril(x, z, rumbo = 0, radio = 250) {
    let mejor = null, dmin = Infinity;
    recorrer(x, z, radio, (s, d, qx, qz, ux, uz) => {
      if (s.v.clase > 3 || s.v.bus || d >= dmin) return;
      dmin = d;
      let dirx = ux, dirz = uz;
      // Rumbo: el carro avanza hacia (-sin r, -cos r).
      if (!s.v.unSentido && -Math.sin(rumbo) * ux - Math.cos(rumbo) * uz < 0) { dirx = -ux; dirz = -uz; }
      // Derecha de la dirección de avance: (-dirz, dirx). Centro del carril de la derecha.
      const carriles = s.v.carriles || (s.v.unSentido ? 1 : 2);
      const anchoCarril = (s.w * 2) / carriles, lado = s.w - anchoCarril / 2;
      mejor = { x: qx - dirz * lado, z: qz + dirx * lado, rumbo: Math.atan2(-dirx, -dirz) };
    });
    return mejor;
  }

  // Punto del andén más cercano a (x, z), mirando a lo largo de la calle.
  function anden(x, z, radio = 250) {
    let mejor = null, dmin = Infinity;
    recorrer(x, z, radio, (s, d, qx, qz, ux, uz) => {
      if (s.v.bus || !s.an || d >= dmin) return;
      dmin = d;
      // Del lado de la calle donde está el punto.
      const lado = (x - qx) * -uz + (z - qz) * ux >= 0 ? 1 : -1, off = s.w + s.an / 2;
      mejor = { x: qx - uz * off * lado, z: qz + ux * off * lado, rumbo: Math.atan2(-ux, -uz) };
    });
    return mejor;
  }

  // Superficies que se agregan después de crear las calles (las plataformas y losas de TransMilenio).
  const agregarPisos = (lista) => pisos.push(...lista);
  return { dentro, carril, anden, piso, agregarPisos };
}
