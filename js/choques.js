// Choques contra las plantas de los edificios. Los muros se guardan como segmentos en una rejilla de celdas
// de 16 m; cada paso solo revisa las celdas alrededor del personaje o del carro.

const CELDA = 16;

export function crearChoques(plantas) {
  const celdas = new Map();
  const llave = (i, j) => i * 100003 + j;
  for (const anillo of plantas) {
    for (let k = 0; k < anillo.length; k++) {
      const [ax, az] = anillo[k], [bx, bz] = anillo[(k + 1) % anillo.length];
      const seg = [ax, az, bx, bz];
      const i0 = Math.floor(Math.min(ax, bx) / CELDA), i1 = Math.floor(Math.max(ax, bx) / CELDA);
      const j0 = Math.floor(Math.min(az, bz) / CELDA), j1 = Math.floor(Math.max(az, bz) / CELDA);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const c = llave(i, j);
        if (!celdas.has(c)) celdas.set(c, []);
        celdas.get(c).push(seg);
      }
    }
  }

  // Empuja un círculo (x, z, radio) fuera de los muros. Devuelve la normal del último choque o null.
  function empujar(p, radio) {
    let normal = null;
    for (let vuelta = 0; vuelta < 3; vuelta++) {
      let movido = false;
      const i0 = Math.floor((p.x - radio) / CELDA), i1 = Math.floor((p.x + radio) / CELDA);
      const j0 = Math.floor((p.z - radio) / CELDA), j1 = Math.floor((p.z + radio) / CELDA);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const lista = celdas.get(llave(i, j));
        if (!lista) continue;
        for (const [ax, az, bx, bz] of lista) {
          const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
          const t = Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.z - az) * dz) / l2));
          const qx = ax + dx * t, qz = az + dz * t;
          const ex = p.x - qx, ez = p.z - qz, d = Math.hypot(ex, ez);
          if (d >= radio || d < 1e-6) continue;
          p.x += (ex / d) * (radio - d);
          p.z += (ez / d) * (radio - d);
          normal = [ex / d, ez / d];
          movido = true;
        }
      }
      if (!movido) break;
    }
    return normal;
  }

  return { empujar };
}
