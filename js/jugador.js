import * as THREE from 'three/webgpu';
import { noche } from './edificios.js';
import { crearVehiculo, TIPOS } from './vehiculos.js';
import { crearBici, moverBici } from './bici.js';
import { crearHelicoptero, moverHelicoptero } from './helicoptero.js';
import { crearPersonaje } from './personaje.js';

// Recorrer la ciudad a pie, en carro, en bici o en helicóptero. Todo se arma en código: no hay modelos.

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
      return { avance, giro, correr: t('ShiftLeft', 'ShiftRight') || Math.hypot(toque.x, toque.y) > 0.92, freno: t('Space'),
        subir: t('Space', 'KeyE'), bajar: t('KeyQ', 'KeyC') };
    },
    teclas,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// El recorrido: modos, física y cámara.
// ---------------------------------------------------------------------------------------------------------------
export function crearRecorrido({ escena, camara, terreno, choques, calles, techo = (x, z) => terreno.altura(x, z), inicio, elJoystick, lienzo, estacionados }) {
  // Altura segura para el helicóptero: 35 m sobre el techo más alto alrededor del punto.
  const sobreTechos = (x, z) => Math.max(...[[0, 0], [20, 0], [-20, 0], [0, 20], [0, -20]].map(([a, b]) => techo(x + a, z + b))) + 35;
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
  // Bici y helicóptero: como el carro, cada uno se queda donde se dejó. Aparecen junto al jugador la primera vez
  // o si quedaron lejos.
  const bici = crearBici(), heli = crearHelicoptero();
  bici.raiz.visible = heli.raiz.visible = false;
  escena.add(bici.raiz, heli.raiz);
  const b = { x: 0, z: 0, rumbo: 0, vel: 0, giro: 0, inclinacion: 0, puesta: false };
  const h = { x: 0, y: 0, z: 0, rumbo: 0, vel: 0, velY: 0, cabeceo: 0, alabeo: 0, puesto: false };
  let potencia = 0;
  let modo = 'libre';
  const camPos = new THREE.Vector3(), mira = new THREE.Vector3();
  const colocar = () => {
    // En la bici el personaje va montado: su raíz cuelga de la bici.
    if (modo !== 'bici') {
      persona.raiz.position.set(p.x, terreno.altura(p.x, p.z), p.z);
      persona.raiz.rotation.set(0, p.rumbo, 0);
    }
    colocarTaxi();
  };
  const colocarBici = () => {
    // Inclinación según el suelo bajo las dos ruedas (ejes a 0,62 m adelante y 0,44 m atrás).
    const s = Math.sin(b.rumbo), co = Math.cos(b.rumbo);
    const yD = terreno.altura(b.x - s * 0.62, b.z - co * 0.62), yT = terreno.altura(b.x + s * 0.44, b.z + co * 0.44);
    bici.raiz.position.set(b.x, terreno.altura(b.x, b.z), b.z);
    bici.raiz.rotation.set(Math.atan2(yD - yT, 1.06), b.rumbo, b.inclinacion, 'YXZ');
  };
  const colocarHeli = () => {
    heli.raiz.position.set(h.x, h.y, h.z);
    heli.raiz.rotation.set(h.cabeceo, h.rumbo, h.alabeo, 'YXZ');
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
    // Al dejar la bici o el helicóptero, la persona queda al lado (bajo el helicóptero, en el andén más cercano).
    if (modo === 'bici') {
      escena.add(persona.raiz);
      persona.pararse();
      p.x = b.x - Math.cos(b.rumbo) * 0.9; p.z = b.z + Math.sin(b.rumbo) * 0.9; p.rumbo = b.rumbo; p.vel = 0;
      choques.empujar(p, 0.35);
    } else if (modo === 'volar') {
      const a = calles.anden(h.x, h.z, 120) || { x: h.x + 4, z: h.z, rumbo: h.rumbo };
      p.x = a.x; p.z = a.z; p.rumbo = a.rumbo; p.vel = 0;
      choques.empujar(p, 0.35);
    }
    if (nuevo === 'bici') {
      if (!b.puesta || Math.hypot(b.x - p.x, b.z - p.z) > 25) Object.assign(b, { x: p.x, z: p.z, rumbo: p.rumbo, puesta: true });
      Object.assign(b, { vel: 0, giro: 0, inclinacion: 0 });
      bici.raiz.visible = true;
      bici.raiz.add(persona.raiz);
      persona.raiz.position.set(0, 0, 0);
      persona.raiz.rotation.set(0, 0, 0);
      colocarBici();
    } else if (nuevo === 'volar') {
      // Aparece flotando a 60 m sobre el jugador; si ya estaba cerca, sigue donde se dejó.
      if (!h.puesto || Math.hypot(h.x - p.x, h.z - p.z) > 400) {
        Object.assign(h, { x: p.x, z: p.z, y: Math.max(terreno.altura(p.x, p.z) + 60, sobreTechos(p.x, p.z)), rumbo: p.rumbo, puesto: true });
      }
      Object.assign(h, { vel: 0, velY: 0 });
      heli.raiz.visible = true;
      colocarHeli();
    }
    if (nuevo === 'manejar') {
      // Se sube al carro más cercano a menos de 4,5 m: uno estacionado o uno que dejó antes.
      let elegido = null, dmin = 4.5;
      const dist = (x, z) => Math.hypot(x - p.x, z - p.z);
      if (modo !== 'libre') {
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
        if (Math.hypot(x - p.x, z - p.z) > 25 || modo === 'libre') {
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
    persona.raiz.visible = nuevo !== 'manejar' && nuevo !== 'volar';
    modo = nuevo;
    camPos.copy(camara.position);
    colocar();
    return modo;
  }

  function actualizar(dt) {
    const n = noche.value;
    v.luz.intensity = modo === 'manejar' ? n * 40 : 0;
    // Fuera de su modo el helicóptero deja girar las palas en vacío si quedó en el aire.
    heli.animar(dt, modo === 'volar' ? potencia : h.y - terreno.altura(h.x, h.z) > 2 ? 0.5 : 0);
    if (modo === 'libre') return null;
    const entrada = controles.leer(), { avance, giro, correr, freno } = entrada;

    if (modo === 'bici') {
      moverBici(b, entrada, dt);
      choques.empujar(b, 0.45);
      colocarBici();
      persona.pedalear(bici.animar(b.vel, dt) + Math.PI, b.inclinacion); // la bici cuenta la fase desde el pedal derecho; el ciclista, desde el izquierdo
      return seguir(b.x, b.z, b.rumbo, 4.8, 2.0, 1.3, dt);
    }

    if (modo === 'volar') {
      potencia = moverHelicoptero(h, entrada, dt, terreno.altura);
      colocarHeli();
      return seguir(h.x, h.z, h.rumbo, 12 + Math.abs(h.vel) * 0.12, 3.5, 1.6, dt, h.y);
    }

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

  // Arrastrar gira la cámara alrededor y la rueda acerca o aleja (como Slop New York). Quieto, la vista se queda
  // donde la dejaste para mirar un edificio; al moverse vuelve sola detrás 2,5 s después de soltar.
  const vista = { yaw: 0, alto: 0, zoom: 1, arrastrando: false, px: 0, py: 0, soltado: 0 };
  lienzo.addEventListener('wheel', (e) => {
    if (modo === 'libre') return;
    e.preventDefault();
    vista.zoom = Math.max(0.45, Math.min(4, vista.zoom * Math.exp(e.deltaY * 0.0012)));
  }, { passive: false });
  lienzo.addEventListener('pointerdown', (e) => {
    if (modo === 'libre' || e.target !== lienzo) return;
    vista.arrastrando = true; vista.px = e.clientX; vista.py = e.clientY;
  });
  addEventListener('pointermove', (e) => {
    if (!vista.arrastrando) return;
    vista.yaw -= (e.clientX - vista.px) * 0.006;
    vista.alto = Math.max(-0.6, Math.min(3, vista.alto + (e.clientY - vista.py) * 0.004));
    vista.px = e.clientX; vista.py = e.clientY;
  });
  addEventListener('pointerup', () => { if (vista.arrastrando) vista.soltado = performance.now(); vista.arrastrando = false; });

  // Cámara detrás, suavizada. Si un muro se interpone, se acerca; si queda bajo el terreno, sube.
  const deseo = new THREE.Vector3();
  function seguir(x, z, rumbo, dist, alto, mirarAlto, dt, yBase = terreno.altura(x, z)) {
    const vel = ({ manejar: c.vel, caminar: p.vel, bici: b.vel, volar: Math.hypot(h.vel, h.velY) })[modo] ?? 0;
    if (!vista.arrastrando && Math.abs(vel) > 0.5 && performance.now() - vista.soltado > 2500) {
      vista.yaw *= Math.exp(-dt * 1.5);
      vista.alto *= Math.exp(-dt * 1.5);
    }
    dist *= vista.zoom;
    const y = yBase, a = rumbo + vista.yaw;
    mira.set(x, y + mirarAlto, z);
    const alt = alto * (1 + vista.alto) * vista.zoom;
    deseo.set(x + Math.sin(a) * dist, y + alt, z + Math.cos(a) * dist);
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
    posicion: () => (modo === 'manejar' ? [c.x, c.z] : modo === 'bici' ? [b.x, b.z] : modo === 'volar' ? [h.x, h.z] : [p.x, p.z]),
    rumbo: () => (modo === 'manejar' ? c.rumbo : modo === 'bici' ? b.rumbo : modo === 'volar' ? h.rumbo : p.rumbo),
    velocidad: () => ({ manejar: c.vel, caminar: p.vel, bici: b.vel, volar: Math.hypot(h.vel, h.velY) })[modo] ?? 0,
    altura: () => (modo === 'manejar' ? c.y ?? 0 : modo === 'volar' ? h.y : terreno.altura(p.x, p.z)),
    nombreCarro: () => TIPOS[v.tipo]?.nombre || 'Carro',
    llevarA(x, z, rumbo = p.rumbo) { p.x = x; p.z = z; p.rumbo = rumbo; p.vel = 0; choques.empujar(p, 0.35); colocar(); },
    // Tour: el carro aparece en el carril de la calle más cercana al lugar; a pie, en el andén.
    // vuelo: { x, z, y, rumbo } para el helicóptero (main.js lo calcula a un costado del lugar).
    teletransportar(x, z, vuelo) {
      if (modo === 'manejar') {
        const q = calles.carril(x, z, c.rumbo, 500);
        if (!q) return;
        Object.assign(c, { x: q.x, z: q.z, rumbo: q.rumbo, vel: 0, giro: 0, y: null, vy: 0, inercia: 0 });
        colocarTaxi();
      } else if (modo === 'volar') {
        Object.assign(h, vuelo || { x, z, y: Math.max(h.y, terreno.altura(x, z) + 120, sobreTechos(x, z)) }, { vel: 0, velY: 0 });
        colocarHeli();
      } else if (modo === 'bici') {
        const a = calles.anden(x, z, 500) || { x, z, rumbo: b.rumbo };
        Object.assign(b, { x: a.x, z: a.z, rumbo: a.rumbo, vel: 0 });
        colocarBici();
      } else {
        const a = calles.anden(x, z, 500) || { x, z, rumbo: p.rumbo };
        this.llevarA(a.x, a.z, a.rumbo);
      }
    },
    teclas: controles.teclas,
  };
}
