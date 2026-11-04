// Prueba en node de semáforos y tráfico con las vías reales (BOV2): fases sin conflicto, nadie pasa en rojo, nadie se
// atraviesa en 240 s simulados. Necesita three para importar js/vias.js: npm i --no-save three@0.187.0 && node tools/probar-fisica.mjs
import fs from 'node:fs';
globalThis.fetch = async (u) => { const b = fs.readFileSync(String(u)); return { ok: true, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }; };
const R = new URL('../', import.meta.url).pathname;
const { cargarLineas } = await import(R + 'js/vias.js');
const sem = await import(R + 'js/semaforos.js');
const tr = await import(R + 'js/trafico.js');
const vias = await cargarLineas(R + 'datos/centro/vias.bin.gz', 'BOV2');
console.log('vías', vias.length);
// --- Semáforos
const S = sem.armarSemaforos(vias);
console.log('grupos', S.grupos.length, 'nodos', S.nodos?.length);
let malos = 0;
for (let t = 0; t < sem.CICLO; t += 0.5) for (const e of [0, 1]) {
  const a = sem.luz(t, 0), b = sem.luz(t, 1);
  if (a === sem.VERDE && b !== sem.ROJO) malos++;
  if (b === sem.VERDE && a !== sem.ROJO) malos++;
  // peatón del eje e cruza con el verde del otro eje: nunca debe tener VERDE mientras su propio eje (carros) tiene verde
  if (sem.paso(t, e) === sem.VERDE && sem.luz(t, e) === sem.VERDE) malos++;
}
console.log('conflictos de fase', malos, 'ciclo', sem.CICLO);
const stub = { grupoEn: (x, z) => S.porNodo.get(`${x},${z}`) || null, eje: (g, dx, dz) => sem.ejeDe(g, dx, dz), estado: (g, e) => sem.luz(reloj + g.desfase, e) };
let reloj = 0;
// --- Tráfico
const red = tr.armarRed(vias);
console.log('aristas', red.aristas.length, 'nodos', red.nodos.length);
const flota = [];
const FL = [['taxi',50,4.3,1.75,2.55,0.9],['sedan',42,4.5,1.78,2.65,0.9],['camioneta',36,4.7,1.85,2.75,0.95],['pickup',12,5.3,1.9,3.2,1]];
// reutiliza la flota real pidiéndola a través de una simulación mínima: se copia FLOTA a mano
const mk = (tipo, cuantos, largo, ancho, eje, adelante, conductor) => ({ tipo, cuantos, largo, ancho, eje, adelante, conductor, colores: [0] });
const C = { a: 1.8, b: 2.6, T: 1.3, s0: 2.0, aLat: 2.4, bMax: 8, vel: 1 };
for (const f of FL) flota.push(mk(f[0], f[1], f[2], f[3], f[4], 0.9, C));
flota.push({ ...mk('moto', 50, 2, 0.8, 1.32, 0.34, { a: 2.8, b: 3, T: 0.8, s0: 1, aLat: 3.2, bMax: 8, vel: 1.12 }), moto: true });
flota.push({ ...mk('bus', 10, 12, 2.5, 6, 2.55, { a: 1, b: 2, T: 1.7, s0: 3, aLat: 1.6, bMax: 6, vel: 0.85 }), bus: true });
const focos = { monserrate1: [1770, -456], monserrate2: [1650, -520], septima: [-300, -1100], plaza: [0, 0] };
for (const [n, [fx, fz]] of Object.entries(focos)) {
  const sim = tr.crearSimulacion(red, flota, { semaforos: stub });
  let cruces = 0, solap = 0, peor = 0, maxEspera = 0, nanes = 0, rojos = 0; const pares = new Set();
  const dt = 1 / 30;
  for (let i = 0; i < 240 * 30; i++) {
    reloj += dt;
    sim.actualizar(dt, 8, { x: fx, z: fz }, null, null, null);
    const A = sim.activos;
    for (const v of A) { const cruzo = !v.prevCon && v.prevE === v.e && v.e && v.e.sem && v.prevS < v.e.pare && (v.s >= v.e.pare || v.con); if (cruzo) { const l = sem.luz(reloj + v.e.sem.desfase, v.e.eje); cruces++; if (l === sem.ROJO) { rojos++; if (rojos < 4) console.log('rojo', v.id, v.vel.toFixed(1), (reloj+v.e.sem.desfase)%60); } } v.prevE = v.e; v.prevS = v.s; v.prevCon = !!v.con; }
    for (const v of A) { if (!isFinite(v.cx + v.cz + v.vel)) nanes++; maxEspera = Math.max(maxEspera, v.espera); }
    if (i % 15 === 0) for (let a = 0; a < A.length; a++) for (let b = a + 1; b < A.length; b++) {
      const p = A[a], q = A[b];
      const d = Math.hypot(p.cx - q.cx, p.cz - q.cz);
      if (d > 6) continue;
      // distancia entre cápsulas
      const cap = (o) => [o.cx + o.hx * o.T.capsula[0], o.cz + o.hz * o.T.capsula[0], o.cx + o.hx * o.T.capsula[1], o.cz + o.hz * o.T.capsula[1]];
      const [ax, az, bx, bz] = cap(p), [cx, cz, dx, dz] = cap(q);
      let m = 1e9; for (let s = 0; s <= 1; s += 0.1) for (let u = 0; u <= 1; u += 0.1) m = Math.min(m, Math.hypot(ax + (bx - ax) * s - cx - (dx - cx) * u, az + (bz - az) * s - cz - (dz - cz) * u));
      const lim = (p.T.radioChoque + q.T.radioChoque) * 0.8;
      if (m < lim && !(p.T.moto || q.T.moto)) { solap++; pares.add(Math.min(p.id, q.id) + '-' + Math.max(p.id, q.id)); peor = Math.max(peor, lim - m); }
    }
  }
  console.log(n, 'activos', sim.activos.length, 'obj', sim.objetivo, 'solapes(muestras)', solap, 'pares', pares.size, 'peor penetración', peor.toFixed(2), 'esperaMax', maxEspera.toFixed(0), 'NaN', nanes, 'cambios de arista con semáforo', cruces, 'pasadas en rojo a >2m/s', rojos);
}
