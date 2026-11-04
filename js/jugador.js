import * as THREE from 'three/webgpu';
import { noche } from './edificios.js';
import { crearVehiculo, TIPOS } from './vehiculos.js';

// Recorrer la ciudad a pie o en carro. El personaje se arma con piezas simples y los carros salen de vehiculos.js:
// no hay modelos.

const mat = (color, extra = {}) => new THREE.MeshStandardNodeMaterial({ color, roughness: 0.8, ...extra });
const pieza = (geo, material, x, y, z, padre) => {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  m.castShadow = true;
  padre.add(m);
  return m;
};

// ---------------------------------------------------------------------------------------------------------------
// Personaje: unos 1,72 m. Piernas y brazos cuelgan de pivotes para animar el paso.
// ---------------------------------------------------------------------------------------------------------------
function crearPersonaje() {
  const raiz = new THREE.Group();
  raiz.name = 'Personaje';
  const piel = mat(0xb8835a), jean = mat(0x2f3e5a), chaqueta = mat(0x7a2e2a), zapato = mat(0x1d1b19), pelo = mat(0x1e1712);
  const cuerpo = new THREE.Group();
  raiz.add(cuerpo);
  pieza(new THREE.BoxGeometry(0.42, 0.56, 0.24), chaqueta, 0, 1.2, 0, cuerpo);
  pieza(new THREE.BoxGeometry(0.4, 0.14, 0.22), jean, 0, 0.88, 0, cuerpo);
  pieza(new THREE.CylinderGeometry(0.055, 0.06, 0.08, 8), piel, 0, 1.52, 0, cuerpo);
  const cabeza = pieza(new THREE.SphereGeometry(0.115, 14, 10), piel, 0, 1.63, 0, cuerpo);
  cabeza.scale.set(1, 1.12, 1.05);
  pieza(new THREE.SphereGeometry(0.12, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), pelo, 0, 1.66, 0.01, cuerpo);
  const extremidad = (x, y, largo, ancho, material, punta, colorPunta) => {
    const pivote = new THREE.Group();
    pivote.position.set(x, y, 0);
    cuerpo.add(pivote);
    pieza(new THREE.BoxGeometry(ancho, largo, ancho), material, 0, -largo / 2, 0, pivote);
    if (punta) pieza(punta, colorPunta, 0, -largo - 0.03, -0.04, pivote); // el frente es -z
    return pivote;
  };
  const piernaI = extremidad(-0.1, 0.84, 0.8, 0.15, jean, new THREE.BoxGeometry(0.14, 0.07, 0.26), zapato);
  const piernaD = extremidad(0.1, 0.84, 0.8, 0.15, jean, new THREE.BoxGeometry(0.14, 0.07, 0.26), zapato);
  const brazoI = extremidad(-0.27, 1.45, 0.62, 0.11, chaqueta, new THREE.SphereGeometry(0.055, 8, 6), piel);
  const brazoD = extremidad(0.27, 1.45, 0.62, 0.11, chaqueta, new THREE.SphereGeometry(0.055, 8, 6), piel);
  let fase = 0;
  const animar = (velocidad, dt) => {
    fase += dt * (2.2 + velocidad * 2.4);
    const amplitud = Math.min(0.75, velocidad * 0.32);
    piernaI.rotation.x = Math.sin(fase) * amplitud;
    piernaD.rotation.x = -Math.sin(fase) * amplitud;
    brazoI.rotation.x = -Math.sin(fase) * amplitud * 0.8;
    brazoD.rotation.x = Math.sin(fase) * amplitud * 0.8;
    cuerpo.position.y = Math.abs(Math.sin(fase)) * amplitud * 0.06;
  };
  return { raiz, animar };
}

// ---------------------------------------------------------------------------------------------------------------
// Controles: teclado y joystick táctil. Devuelven avance (-1 a 1), giro (-1 a 1) y correr.
// ---------------------------------------------------------------------------------------------------------------
function crearControles(elJoystick) {
  const teclas = new Set();
  const enCampo = (e) => /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
  addEventListener('keydown', (e) => { if (!enCampo(e)) teclas.add(e.code); });
  addEventListener('keyup', (e) => teclas.delete(e.code));
  addEventListener('blur', () => teclas.clear());
  const toque = { x: 0, y: 0, activo: false };
  const perilla = elJoystick.querySelector('span');
  let id = null, cx = 0, cy = 0;
  elJoystick.addEventListener('pointerdown', (e) => {
    id = e.pointerId;
    try { elJoystick.setPointerCapture(id); } catch { /* algunos navegadores no la permiten: igual funciona sin ella */ }
    const r = elJoystick.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2;
    toque.activo = true; mover(e);
  });
  const mover = (e) => {
    if (e.pointerId !== id) return;
    let dx = (e.clientX - cx) / 48, dy = (e.clientY - cy) / 48;
    const l = Math.hypot(dx, dy); if (l > 1) { dx /= l; dy /= l; }
    toque.x = dx; toque.y = dy;
    perilla.style.transform = `translate(${dx * 34}px, ${dy * 34}px)`;
  };
  const soltar = (e) => { if (e.pointerId !== id) return; id = null; toque.activo = false; toque.x = toque.y = 0; perilla.style.transform = ''; };
  elJoystick.addEventListener('pointermove', mover);
  elJoystick.addEventListener('pointerup', soltar);
  elJoystick.addEventListener('pointercancel', soltar);
  const t = (...c) => c.some((k) => teclas.has(k));
  return {
    leer() {
      let avance = (t('KeyW', 'ArrowUp') ? 1 : 0) - (t('KeyS', 'ArrowDown') ? 1 : 0);
      let giro = (t('KeyA', 'ArrowLeft') ? 1 : 0) - (t('KeyD', 'ArrowRight') ? 1 : 0);
      if (toque.activo) { avance = -toque.y; giro = -toque.x; }
      return { avance, giro, correr: t('ShiftLeft', 'ShiftRight') || Math.hypot(toque.x, toque.y) > 0.92, freno: t('Space') };
    },
    teclas,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// El recorrido: modos, física y cámara.
// ---------------------------------------------------------------------------------------------------------------
export function crearRecorrido({ escena, camara, terreno, choques, calles, inicio, elJoystick, lienzo, estacionados }) {
  const persona = crearPersonaje();
  escena.add(persona.raiz);
  const controles = crearControles(elJoystick);
  // v es el carro que se maneja (o el último que se manejó). Los que quedan quietos fuera de las instancias
  // van en `sueltos`, con círculos de choque para que no se puedan atravesar a pie.
  let v = crearVehiculo('taxi', TIPOS.taxi.colores[0]);
  escena.add(v.raiz);
  const sueltos = [];
  const soltar = (veh, x, z, rumbo) => {
    veh.pose = { x, z, rumbo };
    veh.circulos = [-1, 1].map((k) => [x - Math.sin(rumbo) * k * veh.largo * 0.27, z - Math.cos(rumbo) * k * veh.largo * 0.27, veh.ancho * 0.52]);
    veh.circulos.forEach(choques.agregar);
    if (!sueltos.includes(veh)) sueltos.push(veh);
  };
  const tomar = (veh) => {
    veh.circulos?.forEach((circ) => { circ[2] = -10; });
    const i = sueltos.indexOf(veh);
    if (i >= 0) sueltos.splice(i, 1);
  };

  const p = { x: inicio.x, z: inicio.z, rumbo: inicio.rumbo, vel: 0 };
  // El taxi del comienzo espera en la calle de carros más cercana (junto a la Plaza de Bolívar, la Carrera 8).
  const arranque = calles.carril(inicio.x, inicio.z, inicio.rumbo) || { x: inicio.x + 9, z: inicio.z + 4, rumbo: inicio.rumbo };
  const c = { x: arranque.x, z: arranque.z, rumbo: arranque.rumbo, vel: 0, giro: 0, rodado: 0,
    y: null, vy: 0, cabeceo: 0, alabeo: 0, vCabeceo: 0, vAlabeo: 0 };
  choques.empujar(c, 2.1);
  soltar(v, c.x, c.z, c.rumbo);
  let modo = 'volar';
  const camPos = new THREE.Vector3(), mira = new THREE.Vector3();
  const colocar = () => {
    persona.raiz.position.set(p.x, terreno.altura(p.x, p.z), p.z);
    persona.raiz.rotation.y = p.rumbo;
    colocarTaxi();
  };
  // Suspensión: se mide el suelo bajo las cuatro ruedas y la carrocería lo sigue con resortes amortiguados,
  // así se inclina en las lomas de La Candelaria y rebota un poco al frenar o al cambiar de pendiente.
  const colocarTaxi = (dt = 0) => {
    const sx = Math.sin(c.rumbo), sz = Math.cos(c.rumbo), lx = Math.cos(c.rumbo), lz = -Math.sin(c.rumbo);
    const rueda = (adelante, lado) => terreno.altura(c.x - sx * adelante + lx * lado, c.z - sz * adelante + lz * lado);
    const za = -v.ruedas[0].eje.position.z, zb = v.ruedas.at(-1).eje.position.z, lado = Math.abs(v.ruedas[0].eje.position.x);
    const di = rueda(za, -lado), dd = rueda(za, lado), ti = rueda(-zb, -lado), td = rueda(-zb, lado);
    const yMeta = (di + dd + ti + td) / 4;
    const cabeceoMeta = Math.atan2((di + dd) / 2 - (ti + td) / 2, za + zb);
    const alabeoMeta = Math.atan2((di + ti) / 2 - (dd + td) / 2, lado * 2);
    if (c.y === null || dt === 0) { c.y = yMeta; c.cabeceo = cabeceoMeta; c.alabeo = alabeoMeta; }
    else {
      const resorte = (v, vel, meta, k, amort) => { const a = (meta - v) * k - vel * amort; return [v + (vel + a * dt) * dt, vel + a * dt]; };
      [c.y, c.vy] = resorte(c.y, c.vy, yMeta, 160, 18);
      [c.cabeceo, c.vCabeceo] = resorte(c.cabeceo, c.vCabeceo, cabeceoMeta + c.inercia * 0.012, 90, 11);
      [c.alabeo, c.vAlabeo] = resorte(c.alabeo, c.vAlabeo, alabeoMeta - c.giro * Math.abs(c.vel) * 0.004, 90, 11);
      if (c.y < yMeta - 0.15) { c.y = yMeta - 0.15; c.vy = Math.max(0, c.vy); }
    }
    v.raiz.position.set(c.x, c.y, c.z);
    v.raiz.rotation.set(0, c.rumbo, 0);
    v.raiz.rotateX(c.cabeceo);
    v.raiz.rotateZ(c.alabeo);
  };
  c.inercia = 0;
  colocar();

  const usar = (veh, x, z, rumbo) => {
    tomar(veh);
    v = veh;
    Object.assign(c, { x, z, rumbo, vel: 0, giro: 0, y: null, vy: 0, vCabeceo: 0, vAlabeo: 0, inercia: 0, velAntes: 0 });
  };

  function cambiar(nuevo) {
    if (nuevo === modo) return modo;
    if (nuevo === 'manejar') {
      // Se sube al carro más cercano a menos de 4,5 m: uno estacionado o uno que dejó antes.
      let elegido = null, dmin = 4.5;
      const dist = (x, z) => Math.hypot(x - p.x, z - p.z);
      if (modo !== 'volar') {
        for (const veh of sueltos) { const d = dist(veh.pose.x, veh.pose.z); if (d < dmin) { dmin = d; elegido = { veh }; } }
        for (const e of estacionados?.lista || []) {
          if (e.oculto) continue;
          const d = dist(e.x, e.z);
          if (d < dmin) { dmin = d; elegido = { estacionado: e }; }
        }
      }
      if (elegido?.estacionado) {
        const e = elegido.estacionado;
        estacionados.ocultar(e);
        const nuevoCarro = crearVehiculo(e.tipo, e.color);
        escena.add(nuevoCarro.raiz);
        usar(nuevoCarro, e.x, e.z, e.rumbo);
      } else if (elegido?.veh) {
        usar(elegido.veh, elegido.veh.pose.x, elegido.veh.pose.z, elegido.veh.pose.rumbo);
      } else {
        // Si no hay uno al lado, el último carro: a menos de 25 m se sube; si está lejos, aparece en el carril
        // de la calle de carros más cercana, nunca en una plaza o un andén.
        const { x, z, rumbo } = v.pose || c;
        if (Math.hypot(x - p.x, z - p.z) > 25 || modo === 'volar') {
          const q = calles.carril(p.x, p.z, p.rumbo) || { x: p.x, z: p.z, rumbo: p.rumbo };
          tomar(v);
          choques.empujar(q, 2.1);
          usar(v, q.x, q.z, q.rumbo);
        } else usar(v, x, z, rumbo);
      }
      persona.raiz.visible = false;
    } else if (modo === 'manejar') {
      // Se baja por el lado izquierdo y el carro queda ahí.
      soltar(v, c.x, c.z, c.rumbo);
      p.x = c.x - Math.cos(c.rumbo) * (v.ancho / 2 + 0.9); p.z = c.z + Math.sin(c.rumbo) * (v.ancho / 2 + 0.9); p.rumbo = c.rumbo;
      choques.empujar(p, 0.35);
      c.vel = 0;
    }
    if (nuevo !== 'manejar') persona.raiz.visible = true;
    modo = nuevo;
    camPos.copy(camara.position);
    colocar();
    return modo;
  }

  function actualizar(dt) {
    const n = noche.value;
    v.luz.intensity = modo === 'manejar' ? n * 40 : 0;
    if (modo === 'volar') return null;
    const { avance, giro, correr, freno } = controles.leer();

    if (modo === 'caminar') {
      const objetivo = avance * (correr ? 4.2 : 1.6);
      p.vel += (objetivo - p.vel) * Math.min(1, dt * 8);
      p.rumbo += giro * dt * 2.6;
      p.x -= Math.sin(p.rumbo) * p.vel * dt;
      p.z -= Math.cos(p.rumbo) * p.vel * dt;
      choques.empujar(p, 0.35);
      persona.animar(Math.abs(p.vel), dt);
      colocar();
      return seguir(p.x, p.z, p.rumbo, 5.2, 2.4, 1.5, dt);
    }

    // Manejar: aceleración, freno, rozamiento y giro de bicicleta (radio según la velocidad).
    const MAX = correr ? 22 : 15;
    if (freno) c.vel *= Math.max(0, 1 - dt * 4);
    else if (avance > 0) c.vel += (c.vel < 0 ? 9 : 4.2) * dt;
    else if (avance < 0) c.vel -= (c.vel > 0 ? 9 : 2.5) * dt;
    else c.vel *= Math.max(0, 1 - dt * 0.6);
    c.vel = Math.max(-5, Math.min(MAX, c.vel));
    c.inercia += (((c.vel - (c.velAntes ?? c.vel)) / Math.max(dt, 1e-3)) - c.inercia) * Math.min(1, dt * 6);
    c.velAntes = c.vel;
    c.giro += (giro * 0.55 - c.giro) * Math.min(1, dt * 6);
    c.rumbo += (c.vel / (v.largo * 0.62)) * Math.tan(c.giro * (1 - Math.min(0.6, Math.abs(c.vel) / 40))) * dt;
    const antes = [c.x, c.z];
    c.x -= Math.sin(c.rumbo) * c.vel * dt;
    c.z -= Math.cos(c.rumbo) * c.vel * dt;
    // Bordillo: si iba por la calzada no puede subirse al andén, a una plaza o a un parque.
    if (calles.dentro(antes[0], antes[1]) && !calles.dentro(c.x, c.z)) {
      [c.x, c.z] = antes;
      c.vel *= -0.2;
    }
    // Dos círculos (adelante y atrás) cubren la carrocería.
    for (const off of [-v.largo * 0.27, v.largo * 0.27]) {
      const q = { x: c.x - Math.sin(c.rumbo) * off, z: c.z - Math.cos(c.rumbo) * off };
      const nrm = choques.empujar(q, v.ancho * 0.52);
      if (nrm) {
        c.x = q.x + Math.sin(c.rumbo) * off; c.z = q.z + Math.cos(c.rumbo) * off;
        c.vel *= -0.25;
      }
    }
    c.rodado += c.vel * dt / v.radio;
    for (const r of v.ruedas) {
      r.rueda.rotation.x = -c.rodado;
      r.eje.rotation.y = r.delantera ? c.giro : 0;
    }
    colocarTaxi(dt);
    return seguir(c.x, c.z, c.rumbo, v.largo * 2.1 + 1.5 + Math.abs(c.vel) * 0.15, 2.6 + v.largo * 0.25, 1.2, dt);
  }

  // Arrastrar sobre la escena gira la cámara alrededor; al soltar vuelve sola detrás.
  const vista = { yaw: 0, alto: 0, arrastrando: false, px: 0, py: 0 };
  lienzo.addEventListener('pointerdown', (e) => {
    if (modo === 'volar' || e.target !== lienzo) return;
    vista.arrastrando = true; vista.px = e.clientX; vista.py = e.clientY;
  });
  addEventListener('pointermove', (e) => {
    if (!vista.arrastrando) return;
    vista.yaw -= (e.clientX - vista.px) * 0.006;
    vista.alto = Math.max(-0.6, Math.min(1.2, vista.alto + (e.clientY - vista.py) * 0.004));
    vista.px = e.clientX; vista.py = e.clientY;
  });
  addEventListener('pointerup', () => { vista.arrastrando = false; });

  // Cámara detrás, suavizada. Si un muro se interpone, se acerca; si queda bajo el terreno, sube.
  const deseo = new THREE.Vector3();
  function seguir(x, z, rumbo, dist, alto, mirarAlto, dt) {
    if (!vista.arrastrando) {
      vista.yaw *= Math.exp(-dt * 1.5);
      vista.alto *= Math.exp(-dt * 1.5);
    }
    const y = terreno.altura(x, z), a = rumbo + vista.yaw;
    mira.set(x, y + mirarAlto, z);
    const h = alto * (1 + vista.alto);
    deseo.set(x + Math.sin(a) * dist, y + h, z + Math.cos(a) * dist);
    const t = choques.rayo(mira.x, mira.y, mira.z, deseo.x, deseo.y, deseo.z);
    if (t < 1) deseo.lerpVectors(mira, deseo, Math.max(0.15, t - 0.6 / dist));
    deseo.y = Math.max(deseo.y, terreno.altura(deseo.x, deseo.z) + 1.2);
    // Acercarse es inmediato (para no ver a través del muro); alejarse, suave.
    const cerca = mira.distanceTo(deseo) < mira.distanceTo(camPos);
    camPos.lerp(deseo, cerca ? 1 : 1 - Math.exp(-dt * 5));
    camara.position.copy(camPos);
    camara.lookAt(mira);
    return mira;
  }

  return {
    cambiar, actualizar,
    get modo() { return modo; },
    posicion: () => (modo === 'manejar' ? [c.x, c.z] : [p.x, p.z]),
    llevarA(x, z, rumbo = p.rumbo) { p.x = x; p.z = z; p.rumbo = rumbo; p.vel = 0; choques.empujar(p, 0.35); colocar(); },
    teclas: controles.teclas,
  };
}
