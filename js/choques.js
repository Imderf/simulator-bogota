// Choques contra las plantas de los edificios y los troncos de los árboles. Los muros se guardan como segmentos
// en una rejilla de celdas de 16 m (con la altura del techo, para la cámara); los troncos, como círculos.
// Cada paso solo revisa las celdas alrededor del personaje, del carro o de la cámara.

const CELDA = 16;
const llave = (i, j) => i * 100003 + j;

export function crearChoques(muros, troncos = []) {
  const celdas = new Map();
  const celda = (i, j) => {
    const c = llave(i, j);
    if (!celdas.has(c)) celdas.set(c, { segs: [], troncos: [] });
    return celdas.get(c);
  };
  // muros: [{ anillo, techo }] con el techo en metros (Infinity si no se sabe).
  for (const { anillo, techo } of muros) {
    for (let k = 0; k < anillo.length; k++) {
      const [ax, az] = anillo[k], [bx, bz] = anillo[(k + 1) % anillo.length];
      const seg = [ax, az, bx, bz, techo];
      const i0 = Math.floor(Math.min(ax, bx) / CELDA), i1 = Math.floor(Math.max(ax, bx) / CELDA);
      const j0 = Math.floor(Math.min(az, bz) / CELDA), j1 = Math.floor(Math.max(az, bz) / CELDA);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) celda(i, j).segs.push(seg);
    }
  }
  for (const t of troncos) celda(Math.floor(t[0] / CELDA), Math.floor(t[1] / CELDA)).troncos.push(t);

  const recorrer = (x0, z0, x1, z1, fn) => {
    for (let i = Math.floor(x0 / CELDA); i <= Math.floor(x1 / CELDA); i++)
      for (let j = Math.floor(z0 / CELDA); j <= Math.floor(z1 / CELDA); j++) {
        const c = celdas.get(llave(i, j));
        if (c) fn(c);
      }
  };

  // Empuja un círculo (p.x, p.z, radio) fuera de muros y troncos. Devuelve la normal del último choque o null.
  function empujar(p, radio) {
    let normal = null;
    for (let vuelta = 0; vuelta < 3; vuelta++) {
      let movido = false;
      const salir = (qx, qz, r) => {
        const ex = p.x - qx, ez = p.z - qz, d = Math.hypot(ex, ez);
        if (d >= r || d < 1e-6) return;
        p.x += (ex / d) * (r - d);
        p.z += (ez / d) * (r - d);
        normal = [ex / d, ez / d];
        movido = true;
      };
      recorrer(p.x - radio, p.z - radio, p.x + radio, p.z + radio, (c) => {
        for (const [ax, az, bx, bz] of c.segs) {
          const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
          const t = Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.z - az) * dz) / l2));
          salir(ax + dx * t, az + dz * t, radio);
        }
        for (const [tx, tz, tr] of c.troncos) salir(tx, tz, radio + tr);
      });
      if (!movido) break;
    }
    return normal;
  }

  // Fracción (0 a 1) del trayecto de a hasta b antes del primer muro más alto que la altura y del trayecto.
  // Sirve para que la cámara no quede detrás de una pared.
  function rayo(ax, ay, az, bx, by, bz) {
    let mejor = 1;
    const dx = bx - ax, dz = bz - az;
    recorrer(Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz), (c) => {
      for (const [sx, sz, ex, ez, techo] of c.segs) {
        const fx = ex - sx, fz = ez - sz, den = dx * fz - dz * fx;
        if (Math.abs(den) < 1e-9) continue;
        const t = ((sx - ax) * fz - (sz - az) * fx) / den, u = ((sx - ax) * dz - (sz - az) * dx) / den;
        if (t > 0 && t < mejor && u >= 0 && u <= 1 && ay + (by - ay) * t < techo) mejor = t;
      }
    });
    return mejor;
  }

  return { empujar, rayo };
}
