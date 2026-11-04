import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { ClusteredLighting } from 'three/addons/lighting/ClusteredLighting.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { SunLight } from 'three/addons/lights/SunLight.js';
import { SunLightNode } from 'three/addons/lights/SunLightNode.js';
import { mix, vec2, vec3, vec4, float, max, min, uniform, pass, smoothstep, positionWorldDirection, color,
  mrt, output, normalView, positionView, metalness, roughness, dot, pow, length, screenUV, screenSize, Fn,
  positionWorld, cameraPosition, normalize, exp, abs, pmremTexture, fog } from 'three/tsl';
import { ZONA, aMundo } from './marco.js';
import { cargarTerreno, mallaTerreno, materialTerreno } from './terreno.js';
import { crearAgua } from './agua.js';
import { cargarEdificios, mallasEdificios, noche, ALTURA_PISO } from './edificios.js';
import { cargarArboles, mallasArboles } from './arboles.js';
import { cargarLineas, mallaVias, texturaSuelo, mojado } from './vias.js';
import { construirLugares, puntosDeVista, cameraPos } from './lugares.js';
import { direccionSol, diaDelAno } from './sol.js';
import { crearChoques } from './choques.js';
import { crearRecorrido } from './jugador.js';
import { estacionar } from './vehiculos.js';
import { crearFarolas } from './farolas.js';
import { crearCalles } from './calles.js';
import { crearMinimapa } from './minimapa.js';
import { crearSonido } from './sonido.js';
import { crearTransMilenio } from './transmilenio.js';
import { crearPeatones } from './peatones.js';
import { crearTrafico } from './trafico.js';
import { crearAeropuerto } from './aeropuerto.js';

const DATOS = `./datos/${ZONA.nombre}/`;
const barra = document.querySelector('#carga-barra'), textoCarga = document.querySelector('#carga-texto');
let avance = 0;
const paso = (texto, cuanto) => { avance += cuanto; barra.style.width = `${Math.min(100, avance)}%`; textoCarga.textContent = texto; };
// Deja que el navegador pinte la barra antes de seguir con el trabajo pesado.
// Con la pestaña en segundo plano no llegan cuadros: el tope de tiempo evita que la carga se quede esperando.
const respirar = () => new Promise((listo) => { requestAnimationFrame(() => setTimeout(listo, 0)); setTimeout(listo, 80); });

const renderer = new THREE.WebGPURenderer({ antialias: true });
// Como Slop New York: resolución 1:1 con antialiasing. En pantallas retina la 2× cuesta cuatro veces más píxeles y la
// interfaz (HTML) se ve nítida igual.
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1; // la exposición va en el postproceso, antes del bloom
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// Muchas luces pequeñas (farolas, faros) sin que cada píxel las recorra todas.
renderer.lighting = new ClusteredLighting(256, 32, 24, 48);
document.querySelector('#escena').appendChild(renderer.domElement);
await renderer.init();
paso('Preparando la ciudad', 5);

const escena = new THREE.Scene();
const camara = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 1, 60000);
const controles = new OrbitControls(camara, renderer.domElement);
controles.enableDamping = true;
controles.maxPolarAngle = Math.PI * 0.49;
controles.minDistance = 25;
controles.maxDistance = 12000;
controles.screenSpacePanning = false;

// Cielo, sol y luz de relleno. La bruma de la sabana se hace con niebla lineal.
const cielo = new SkyMesh();
cielo.scale.setScalar(50000);
cielo.turbidity.value = 6;
cielo.rayleigh.value = 1.6;
cielo.mieCoefficient.value = 0.006;
cielo.mieDirectionalG.value = 0.8;
escena.add(cielo);
// Sol con sombras en cascada (como Slop New York): nítidas cerca de la cámara y que alcanzan lejos. La luz va desde su
// posición hacia el origen, así que basta poner ahí la dirección del sol (o de la luna).
SunLight.registerNode(SunLightNode);
const luzSol = new SunLight(0xfff3e0, 3.2);
luzSol.castShadow = true;
const maxTextura = renderer.backend?.device?.limits?.maxTextureDimension2D || 4096;
luzSol.shadow.mapSize.setScalar(maxTextura >= 6144 ? 3072 : 2048);
luzSol.shadow.camera.near = 0.5;
luzSol.shadow.camera.far = 300;
luzSol.shadow.normalBias = 0.05;
escena.add(luzSol);
const relleno = new THREE.HemisphereLight(0xcfe0f5, 0x5d5a50, 1.1);
escena.add(relleno);
// El cielo se hornea como mapa de entorno: sin él, vidrios y metales no reflejan nada y salen negros.
const pmrem = new THREE.PMREMGenerator(renderer), escenaCielo = new THREE.Scene();
let entorno = null;
function hornearCielo() {
  cielo.showSunDisc.value = 0;
  escenaCielo.add(cielo);
  entorno = pmrem.fromScene(escenaCielo, 0, 0.1, 100, { renderTarget: entorno });
  escena.environment = entorno.texture;
  escena.environmentIntensity = 0.2;
  cielo.showSunDisc.value = 1;
  escena.add(cielo);
  if (!escena.fogNode) escena.fogNode = nieblaAerea();
}
// Bruma de la sabana con el color del cielo horneado hacia donde se mira (Adaptado de Slop New York, mrdoob, MIT:
// lighting.js, createAerialFogNode). Más espesa abajo; de noche se mezcla con azul oscuro porque el cielo está negro.
const densidadNiebla = uniform(0.00006), nocheNiebla = uniform(0);
function nieblaAerea() {
  const hacia = positionWorld.sub(cameraPosition), dist = length(hacia), dir = hacia.div(max(dist, 0.001));
  const horizonte = normalize(vec3(dir.x, max(dir.y, 0.015), dir.z));
  const colorCielo = mix(pmremTexture(entorno.texture, horizonte, float(0)).rgb, color(0x141c2c), nocheNiebla);
  const H = float(900), ya = max(positionWorld.y, 0), yb = max(cameraPosition.y, 0), dy = yb.sub(ya);
  const ea = exp(ya.div(H).negate()), eb = exp(yb.div(H).negate());
  const media = abs(dy).greaterThan(1).select(ea.sub(eb).mul(H).div(dy), ea);
  const tau = densidadNiebla.mul(dist).mul(media);
  return fog(colorCielo, float(1).sub(exp(tau.mul(tau).negate())));
}
// De noche el cielo físico queda negro: se cambia por un degradé azul oscuro que empata con la niebla.
escena.backgroundNode = mix(color(0x141c2c), color(0x050a16), smoothstep(0, 0.6, positionWorldDirection.y));

// Datos en paralelo.
const [terreno, edificios, arboles, vias, suelo, lugaresDatos] = await Promise.all([
  cargarTerreno(DATOS + 'terreno.bin.gz').then((v) => (paso('Relieve listo', 15), v)),
  cargarEdificios(DATOS + 'edificios.bin.gz').then((v) => (paso('Edificios del catastro listos', 20), v)),
  cargarArboles(DATOS + 'arboles.bin.gz').then((v) => (paso('Árboles listos', 10), v)),
  cargarLineas(DATOS + 'vias.bin.gz', 'BOV2').then((v) => (paso('Vías listas', 5), v)),
  cargarLineas(DATOS + 'suelo.bin.gz', 'BOS1'),
  fetch(DATOS + 'lugares.json').then((r) => r.json()),
]);

const [cx0, cz0] = aMundo(ZONA.caja[0], ZONA.caja[3]), [cx1, cz1] = aMundo(ZONA.caja[2], ZONA.caja[1]);
const cajaSuelo = { x0: cx0, z0: cz0, x1: cx1, z1: cz1 };
paso('Armando los lugares', 10);
await respirar();
// Los lugares van primero: pueden aplanar el terreno bajo sus plantas antes de armar la malla.
const lugares = construirLugares(lugaresDatos, terreno, edificios);
const calles = crearCalles(vias, terreno, lugares.pisos ?? []);
// Lo que se apoya en el suelo (carros, personas, postes) usa el piso de las calles, no el del terreno.
const piso = { altura: calles.piso };
// Árboles del censo que caen dentro de una calzada (la vía de OpenStreetMap es más ancha que la real ahí): fuera.
const arbolesEnPie = arboles.filter((a) => !calles.dentro(a.x, a.z, -0.3));
escena.add(lugares.grupo);

// Suelo: grama, tierra, bosque y roca en los cerros, plazas y parqueaderos según las máscaras de OpenStreetMap.
const tex = texturaSuelo(suelo, cajaSuelo, { vias, edificios });
const tierra = new THREE.Mesh(mallaTerreno(terreno, tex, cajaSuelo), materialTerreno(tex));
tierra.receiveShadow = true;
escena.add(tierra);
// Agua que se mueve: estanques, piletas de Las Aguas y el canal del Eje Ambiental.
const nombresVias = await fetch(DATOS + 'nombres-vias.json').then((r) => r.json()).catch(() => null);
escena.add(crearAgua({ suelo, terreno, vias, nombresVias }).grupo);
paso('Levantando edificios', 0);
await respirar();
const grupoEdificios = mallasEdificios(edificios, terreno, lugares.excluir).grupo;
escena.add(grupoEdificios);
// Techo más alto bajo (x, z): un rayo hacia abajo contra edificios y lugares. Así el helicóptero nunca aparece
// dentro de una torre como la Colpatria.
const rayoTecho = new THREE.Raycaster(), abajo = new THREE.Vector3(0, -1, 0), origenRayo = new THREE.Vector3();
function techo(x, z) {
  rayoTecho.set(origenRayo.set(x, 4000, z), abajo);
  const g = rayoTecho.intersectObjects([grupoEdificios, lugares.grupo], true)[0];
  return Math.max(terreno.altura(x, z), g ? g.point.y : -Infinity);
}
// En helicóptero, el tour pone la nave a un costado del lugar, mirándolo, y por encima de los techos de alrededor.
function vueloHacia(p) {
  const dir = new THREE.Vector3(-0.55, 0, 0.83);
  if (p.desde && Math.hypot(p.desde[0] - p.x, p.desde[1] - p.z) > 50) dir.set(p.desde[0] - p.x, 0, p.desde[1] - p.z);
  dir.normalize();
  const d = Math.max(120, (p.dist ?? 200) * 0.6), x = p.x + dir.x * d, z = p.z + dir.z * d;
  let alto = -Infinity;
  for (const [ox, oz] of [[0, 0], [20, 0], [-20, 0], [0, 20], [0, -20]]) alto = Math.max(alto, techo(x + ox, z + oz));
  return { x, z, y: Math.max(terreno.altura(x, z) + (p.alto ?? 120) * 0.6, alto + 35), rumbo: Math.atan2(-(p.x - x), -(p.z - z)) };
}
paso('Plantando árboles', 15);
await respirar();
// Los árboles cercanos (con hojas) se rehacen alrededor de la cámara; los lejanos son una versión lisa.
const bosque = mallasArboles(arbolesEnPie, terreno, (a) => lugares.excluir({ cx: a.x, cz: a.z }));
escena.add(bosque);
escena.add(mallaVias(vias, terreno));
paso('Preparando la vista', 10);
await respirar();

// Tour: en vista libre la cámara vuela hasta cada lugar; en los demás modos el jugador aparece allí.
const menu = document.querySelector('#lugares'), tour = document.querySelector('#tour');
let vuelo = null, minimapa = null, transmilenio = null;
function irA(p, inmediato = false) {
  const y = terreno.altura(p.x, p.z);
  const destinoT = new THREE.Vector3(p.x, y + 20, p.z);
  // Por defecto se mira hacia los cerros; si el lugar dice desde dónde verlo, la cámara se para de ese lado.
  const dir = new THREE.Vector3(-0.55, 0, 0.83);
  if (p.desde && Math.hypot(p.desde[0] - p.x, p.desde[1] - p.z) > 50) dir.set(p.desde[0] - p.x, 0, p.desde[1] - p.z);
  dir.normalize();
  const destinoC = destinoT.clone().addScaledVector(dir, p.dist).setY(y + p.alto);
  if (inmediato) { controles.target.copy(destinoT); camara.position.copy(destinoC); return; }
  vuelo = { t: 0, t0: controles.target.clone(), c0: camara.position.clone(), t1: destinoT, c1: destinoC };
}
const vistas = puntosDeVista(lugaresDatos, lugares.centroPlaza);
for (const p of vistas) {
  const li = document.createElement('li'), b = document.createElement('button'), texto = document.createElement('span');
  texto.textContent = p.nombre;
  if (p.nota) { const s = document.createElement('small'); s.textContent = p.nota; texto.append(s); }
  b.append(texto);
  b.addEventListener('click', () => {
    if (recorrido.modo === 'libre') irA(p);
    else { viajar(() => recorrido.teletransportar(p.llegada?.[0] ?? p.x, p.llegada?.[1] ?? p.z, recorrido.modo === 'volar' ? vueloHacia(p) : undefined)); minimapa?.destino(null); }
    menu.querySelectorAll('button').forEach((x) => x.classList.toggle('activo', x === b));
    tour.hidePopover();
    document.activeElement?.blur();
  });
  li.append(b);
  menu.append(li);
}
irA({ x: lugares.centroPlaza[0], z: lugares.centroPlaza[1], dist: 1400, alto: 650 }, true);

// Recorrido a pie y en taxi. Los choques usan las plantas del catastro y las de los lugares hechos a mano.
// Los muros del catastro llevan la altura aproximada del techo (para la cámara); los de los lugares, sin límite.
const muros = edificios.filter((e) => !lugares.excluir(e)).map((e) => {
  const suelo = Math.min(...e.anillos[0].map(([x, z]) => terreno.altura(x, z)));
  return { anillo: e.anillos[0], techo: suelo + e.pisos * ALTURA_PISO };
});
for (const anillo of lugares.solidos) muros.push({ anillo, techo: Infinity });
// Troncos de los árboles de más de 3 m; los arbustos no estorban.
const troncos = arbolesEnPie.filter((a) => a.forma !== 4 && a.alt >= 3).map((a) => [a.x, a.z, a.alt > 12 ? 0.35 : 0.22]);
const choques = crearChoques(muros, troncos);
// Carros estacionados en calles secundarias y locales alrededor de la plaza; también suman a los choques.
const estacionados = estacionar({ vias, terreno: piso, choques, centro: lugares.centroPlaza });
escena.add(estacionados.grupo);
const farolas = crearFarolas({ vias, terreno: piso, choques, excluir: lugares.excluir });
escena.add(farolas.grupo);
// TransMilenio: buses articulados por los carriles exclusivos y estaciones en el separador.
// Recibe el terreno real: el módulo ya levanta buses y estaciones a la altura de la calzada de bus.
transmilenio = await crearTransMilenio({ vias, terreno, datos: DATOS });
escena.add(transmilenio.grupo);
// Losa de parada (concreto a lado y lado) y plataforma de cada estación como piso, para no hundirse junto a ellas.
calles.agregarPisos(transmilenio.vagones.flatMap((v) => {
  const ex = -Math.sin(v.rumbo), ez = -Math.cos(v.rumbo);
  const rect = (w, l) => [[-w, -l], [w, -l], [w, l], [-w, l]].map(([lx, lz]) => [v.x + lx * -ez + lz * -ex, v.z + lx * ex + lz * -ez]);
  const y = terreno.altura(v.x, v.z) + 0.42;
  return [{ anillo: rect(v.ancho / 2 + 3.7, v.largo / 2 + 12), y: y - 0.025 }, { anillo: rect(v.ancho / 2, v.largo / 2), y: y + 0.92 }];
}));
// Gente caminando por andenes, la Séptima y la plaza; cuánta depende de la hora.
const peatones = crearPeatones({ vias, calles, choques, lugares });
escena.add(peatones.grupo);
// Botón TransMilenio: lista de estaciones; la cámara vuela a cada una para ver llegar y parar los buses.
{
  const lista = document.querySelector('#lista-estaciones'), pop = document.querySelector('#estaciones');
  const estaciones = new Map();
  for (const v of transmilenio.vagones) {
    const e = estaciones.get(v.nombre) || { nombre: v.nombre, x: 0, z: 0, n: 0, rumbo: v.rumbo };
    e.x += v.x; e.z += v.z; e.n++;
    estaciones.set(v.nombre, e);
  }
  for (const e of [...estaciones.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))) {
    const li = document.createElement('li'), b = document.createElement('button'), texto = document.createElement('span');
    // La cámara se para sobre la avenida, a lo largo del carril: de lado los edificios tapan la estación.
    const x = e.x / e.n, z = e.z / e.n, lx = -Math.sin(e.rumbo), lz = -Math.cos(e.rumbo);
    texto.textContent = e.nombre;
    const nota = document.createElement('small');
    nota.textContent = e.n > 1 ? `${e.n} vagones` : 'Estación sencilla';
    texto.append(nota);
    b.append(texto);
    b.addEventListener('click', () => {
      // En vista libre la cámara vuela a la estación; en los demás modos el jugador aparece junto a ella.
      if (recorrido.modo === 'libre') irA({ x, z, dist: 75, alto: 26, desde: [x + lx * 100, z + lz * 100] });
      else viajar(() => recorrido.teletransportar(x, z, recorrido.modo === 'volar' ? vueloHacia({ x, z, dist: 160, alto: 60, desde: [x + lx * 100, z + lz * 100] }) : undefined));
      lista.querySelectorAll('button').forEach((y) => y.classList.toggle('activo', y === b));
      pop.hidePopover();
      document.activeElement?.blur();
    });
    li.append(b);
    lista.append(li);
  }
}
// 1 dentro de una estación, 0 a más de 60 m: para el pitido de puertas y el frenado de los buses.
const cercaEstacion = (x, z) => Math.max(0, ...transmilenio.vagones.map((v) => 1 - Math.hypot(v.x - x, v.z - z) / 60));
const [px, pz] = [lugares.centroPlaza[0] + 14, lugares.centroPlaza[1] + 14];
const catedral = lugares.solidos[0];
const ccx = catedral.reduce((s, [x]) => s + x, 0) / catedral.length, ccz = catedral.reduce((s, [, z]) => s + z, 0) / catedral.length;
const recorrido = crearRecorrido({
  escena, camara, terreno: piso, choques, calles, techo, estacionados, elJoystick: document.querySelector('#joystick'), lienzo: renderer.domElement,
  inicio: { x: px, z: pz, rumbo: Math.atan2(-(ccx - px), -(ccz - pz)) }, // mirando hacia la Catedral
});
// El Dorado, a 14 km: sabana, pistas, terminal y aviones que llegan y salen según la hora.
const aeropuerto = await crearAeropuerto({ terreno, datos: DATOS });
escena.add(aeropuerto.grupo);
// Tráfico: carros, taxis, motos y buses del SITP por sus carriles; cuántos depende de la hora.
const trafico = crearTrafico({ vias, calles, choques, estacionados, jugador: () => {
  const [x, z] = recorrido.modo === 'libre' ? [controles.target.x, controles.target.z] : recorrido.posicion();
  return { x, z, modo: recorrido.modo };
} });
escena.add(trafico.grupo);
// Minimapa tipo GPS abajo a la izquierda, con las placas de las dos calles más cercanas.
// Con clic o M se abre el Atlas de Bogotá: buscador, zoom y clic para aparecer en ese punto.
minimapa = await crearMinimapa({
  contenedor: document.querySelector('#mapa'), vias, edificios, suelo, datos: DATOS,
  lugares: vistas.map(({ nombre, nota, x, z }) => ({ nombre, nota, x, z })),
  alIr: (x, z) => {
    if (recorrido.modo === 'libre') irA({ x, z, dist: 260, alto: 120 });
    else { viajar(() => recorrido.teletransportar(x, z, recorrido.modo === 'volar' ? vueloHacia({ x, z, dist: 200, alto: 120 }) : undefined)); minimapa.destino(null); }
  },
});
document.querySelector('#boton-mapa').addEventListener('click', () => minimapa.abrir());
const dirCam = new THREE.Vector3();
const botonesModo = [...document.querySelectorAll('#modos button')];
const botonTaxi = document.querySelector('#taxi'), indicador = document.querySelector('#modos .indicador');
// La píldora amarilla se desliza hasta el botón del modo activo; en vista libre se esconde.
function moverIndicador(m) {
  const b = botonesModo.find((x) => x.dataset.modo === m);
  indicador.style.setProperty('--visible', b ? 1 : 0);
  if (b) { indicador.style.setProperty('--x', `${b.offsetLeft}px`); indicador.style.setProperty('--ancho', `${b.offsetWidth}px`); }
}
function elegirModo(m) {
  const antes = recorrido.modo;
  if (m === antes) return;
  // Al bajar de la vista libre, el personaje aparece donde mira la cámara (cerca de la plaza se queda en su punto de partida).
  const lejos = Math.hypot(controles.target.x - px, controles.target.z - pz) > 300;
  if (m !== 'libre' && antes === 'libre' && (lejos || !primeraVez)) {
    // A pie aparece en el andén; el carro, en jugador.js, en el carril de la calle más cercana.
    const anden = calles.anden(controles.target.x, controles.target.z);
    if (anden) recorrido.llevarA(anden.x, anden.z, anden.rumbo);
    else recorrido.llevarA(controles.target.x, controles.target.z);
  }
  if (antes === 'libre') primeraVez = false;
  recorrido.cambiar(m);
  vuelo = null;
  controles.enabled = m === 'libre';
  if (m === 'libre') {
    const [x, z] = recorrido.posicion();
    controles.target.set(x, terreno.altura(x, z) + 2, z);
    camara.position.y += 40;
  }
  document.body.dataset.modo = m;
  botonesModo.forEach((b) => b.classList.toggle('activo', b.dataset.modo === m));
  moverIndicador(m);
  botonTaxi.textContent = m === 'manejar' ? 'Bajarse' : 'Subir al carro';
}
let primeraVez = true;
botonesModo.forEach((b) => b.addEventListener('click', (e) => {
  elegirModo(b.dataset.modo);
  // Sin foco en el botón: si no, Espacio lo vuelve a presionar mientras se maneja.
  if (e.detail) b.blur();
}));
botonTaxi.addEventListener('click', () => elegirModo(recorrido.modo === 'manejar' ? 'caminar' : 'manejar'));
addEventListener('resize', () => moverIndicador(recorrido.modo));
const MODOS = ['caminar', 'manejar', 'bici', 'volar'];
addEventListener('keydown', (e) => {
  if (e.repeat || /INPUT|TEXTAREA/.test(e.target.tagName)) return;
  const n = /^Digit([1-4])$/.exec(e.code);
  if (n) elegirModo(MODOS[n[1] - 1]);
  if (e.code === 'KeyE' && /caminar|manejar/.test(recorrido.modo)) elegirModo(recorrido.modo === 'manejar' ? 'caminar' : 'manejar');
  if (e.code === 'KeyV') elegirModo(recorrido.modo === 'libre' ? 'caminar' : 'libre');
  if (e.code === 'KeyH') document.body.classList.toggle('limpio');
});
document.body.dataset.modo = 'libre';
document.querySelector('#boton-ocultar').addEventListener('click', () => document.body.classList.toggle('limpio'));

// Sonido sintetizado. El navegador solo deja arrancar el audio después de un clic o una tecla.
const sonido = crearSonido(), botonSonido = document.querySelector('#boton-sonido');
const marcarSonido = () => botonSonido.setAttribute('aria-pressed', String(!sonido.silenciado));
addEventListener('pointerdown', sonido.activar, { passive: true });
addEventListener('keydown', sonido.activar);
botonSonido.addEventListener('click', () => { sonido.silenciar(!sonido.silenciado); marcarSonido(); });
addEventListener('keydown', (e) => {
  if (e.repeat || /INPUT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.code === 'KeyN') { sonido.silenciar(!sonido.silenciado); marcarSonido(); }
  if (e.code === 'KeyB') sonido.pito();
});
marcarSonido();

// Postproceso (Adaptado de Slop New York, mrdoob, MIT: main.js y post-processing.js):
// - Reflejos en pantalla (SSR) a media resolución solo en lo brillante: charcos, agua, vidrio y carros.
// - La exposición va antes del bloom para que su umbral siga el brillo real; el pico que entra al bloom se limita
//   para que los LED de Colpatria no quemen la imagen. ACES se aplica al final.
// - Gradación de cámara: contraste, saturación, balance de blancos, sombras frías y luces cálidas, viñeta suave.
const escenaPass = pass(escena, camara);
const RUGOSIDAD_SSR = 0.75, fundidoSSR = smoothstep(360, 180, positionView.z.negate());
const mrtEscena = mrt({
  output,
  normal: normalView,
  metalRough: vec2(roughness.lessThan(RUGOSIDAD_SSR).select(metalness.mul(fundidoSSR), 0), roughness),
});
mrtEscena.setBlendMode('normal', new THREE.BlendMode(THREE.MaterialBlending));
mrtEscena.setBlendMode('metalRough', new THREE.BlendMode(THREE.MaterialBlending));
escenaPass.setMRT(mrtEscena);
const colorEscena = escenaPass.getTextureNode('output'), metalRough = escenaPass.getTextureNode('metalRough');
const reflejo = ssr(colorEscena, escenaPass.getTextureNode('depth'), escenaPass.getTextureNode('normal'), {
  metalnessNode: metalRough.r, roughnessNode: metalRough.g, camera: camara,
});
Object.assign(reflejo, { resolutionScale: 0.5, blurQuality: 1, binaryRefine: true, screenEdgeFadeBlack: true });
reflejo.maxDistance.value = 42; reflejo.thickness.value = 0.85; reflejo.quality.value = 0.25; reflejo.intensity.value = 0.5;
const reflejos = reflejo.mul(metalRough.r.greaterThan(0).select(smoothstep(RUGOSIDAD_SSR, 0.55, metalRough.g), 0));

const exposicion = uniform(0.6), contraste = uniform(1.1), saturacion = uniform(1.07), balance = uniform(new THREE.Vector3(1, 1, 1));
const expuesto = max(colorEscena.rgb.add(reflejos.rgb), vec3(0)).mul(exposicion).mul(balance);
const pico = max(max(expuesto.r, expuesto.g), expuesto.b);
const brillo = bloom(vec4(expuesto.mul(float(8).div(max(pico, 8))), 1), 0.2, 0.4, 1.2);
brillo.setResolutionScale(0.5);
const graduado = Fn(() => {
  const c = expuesto.add(brillo.rgb).toVar();
  const luma = dot(c, vec3(0.2126, 0.7152, 0.0722)).toVar();
  c.mulAssign(mix(vec3(0.965, 1.005, 1.045), vec3(1), smoothstep(0.02, 0.6, luma)).mul(mix(vec3(1), vec3(1.035, 1.005, 0.965), smoothstep(0.6, 3, luma))));
  c.mulAssign(pow(max(luma, 0.0001).div(0.18), contraste.sub(1)));
  const gris = dot(c, vec3(0.2126, 0.7152, 0.0722)), alto = max(max(c.r, c.g), c.b);
  const viveza = float(0.1).mul(float(1).sub(alto.sub(min(min(c.r, c.g), c.b)).div(max(alto, 0.0001))));
  c.assign(max(mix(vec3(gris), c, saturacion.add(viveza)), vec3(0)));
  const aspecto = screenSize.x.div(screenSize.y);
  const radio = length(screenUV.sub(0.5).mul(vec2(aspecto, 1))).div(length(vec2(aspecto, 1).mul(0.5)));
  return vec4(c.mul(float(1).sub(smoothstep(0.35, 1, radio).mul(0.12))), 1);
})();
const tuberia = new THREE.RenderPipeline(renderer, graduado);

// Hora del día. Siempre arranca de día (mediodía); los botones de arriba la cambian.
const control = document.querySelector('#hora'), etiqueta = document.querySelector('#hora-texto');
const ahora = new Date();
control.value = '12';
const dirSol = new THREE.Vector3(), dirLuz = new THREE.Vector3(), dia = diaDelAno(ahora);
// Noche "de cine", como en Slop New York: luna azul con sombras, relleno azul y lo que brilla por encima del bloom.
const LUNA = new THREE.Vector3(-0.35, 0.82, 0.45).normalize();
const CIELO = [new THREE.Color(0x2a3c64), new THREE.Color(0xcfe0f5)], SUELO = [new THREE.Color(0x3a3036), new THREE.Color(0x5d5a50)];
let horneada = null;
function aplicarHora() {
  const h = Number(control.value);
  etiqueta.textContent = `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
  direccionSol(h, dia, dirSol);
  cielo.sunPosition.value.copy(dirSol);
  const altura = dirSol.y, ss = THREE.MathUtils.smoothstep;
  const luz = ss(altura, -0.05, 0.25), luna = 1 - ss(altura, -0.12, -0.02), claro = ss(altura, -0.15, 0.3);
  // Cuando el sol se esconde, la misma luz pasa a ser la luna.
  dirLuz.copy(altura > -0.02 ? dirSol : LUNA);
  luzSol.intensity = 3.2 * luz + 0.4 * luna;
  if (altura > -0.02) luzSol.color.setHSL(0.09, 0.6, 0.55 + 0.4 * luz); else luzSol.color.set(0x8cb0e8);
  relleno.intensity = 0.45 + 0.35 * claro;
  relleno.color.lerpColors(CIELO[0], CIELO[1], claro);
  relleno.groundColor.lerpColors(SUELO[0], SUELO[1], claro);
  noche.value = 1 - ss(altura, -0.08, 0.12);
  nocheNiebla.value = 1 - ss(altura, -0.12, 0.05);
  cielo.visible = altura > -0.1;
  // Golden hour: balance cálido; noche: un poco frío. Las calles se mojan hacia la tarde y la noche (Bogotá llueve).
  const dorada = ss(altura, -0.02, 0.08) * (1 - ss(altura, 0.25, 0.45));
  balance.value.set(1.015, 1, 0.985).lerp(new THREE.Vector3(1.045, 1, 0.955), dorada).lerp(new THREE.Vector3(0.985, 1, 1.035), noche.value);
  mojado.value = 0.1 + 0.2 * dorada + 0.5 * noche.value;
  exposicion.value = 0.48 + 0.37 * (1 - luz);
  brillo.strength.value = 0.12 + 0.2 * (1 - luz);
  brillo.threshold.value = 1.0 + 0.4 * luz;
  if (horneada !== h) { horneada = h; hornearCielo(); }
}
// Horas rápidas (Golden hour, mediodía, hora azul, noche); el deslizador queda para el ajuste fino.
const botonesHora = [...document.querySelectorAll('#horas button')];
const marcarHora = () => botonesHora.forEach((b) => b.classList.toggle('activo', Number(b.dataset.hora) === Number(control.value)));
botonesHora.forEach((b) => b.addEventListener('click', () => { control.value = b.dataset.hora; aplicarHora(); marcarHora(); }));
control.addEventListener('input', () => { aplicarHora(); marcarHora(); });
aplicarHora();
marcarHora();

window.addEventListener('resize', () => {
  camara.aspect = window.innerWidth / window.innerHeight;
  camara.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Tablero: qué se maneja, velocidad en km/h y altura en Volar. Cuadros por segundo en el título.
const NOMBRES = { libre: 'Vista libre', caminar: 'A pie', manejar: 'Taxi', bici: 'Bici urbana', volar: 'Helicóptero turístico' };
const elVehiculo = document.querySelector('#vehiculo'), elVelocidad = document.querySelector('#velocidad');
const elAltitud = document.querySelector('#altitud'), elFps = document.querySelector('#fps');
let cuadros = 0, tFps = 0;
function tablero(dt) {
  cuadros++; tFps += dt;
  if (tFps < 0.25) return;
  elFps.textContent = Math.round(cuadros / tFps);
  cuadros = 0; tFps = 0;
  const m = recorrido.modo;
  elVehiculo.textContent = m === 'manejar' ? recorrido.nombreCarro() : NOMBRES[m];
  elVelocidad.textContent = Math.round(Math.abs(recorrido.velocidad()) * 3.6);
  const [x, z] = recorrido.posicion();
  const alto = m === 'volar' ? recorrido.altura() - terreno.altura(x, z) : m === 'libre' ? camara.position.y - terreno.altura(camara.position.x, camara.position.z) : 0;
  elAltitud.textContent = m === 'volar' || m === 'libre' ? `Altura ${Math.round(alto)} m · ${Math.round(2606 + terreno.altura(x, z) + alto)} m s. n. m.` : '';
}

let ultimaMira = null;
// Viaje entre lugares en los modos de recorrido (tour, estaciones, atlas): el jugador aparece de una vez en el destino,
// pero la cámara sale de donde estaba, se aleja hacia arriba, cruza y baja hasta quedar detrás de él, como el vuelo
// de la vista libre.
let viaje = null;
const viajeC = new THREE.Vector3(), viajeT = new THREE.Vector3();
function viajar(accion) {
  const t0 = (ultimaMira ?? controles.target).clone(), c0 = camara.position.clone();
  accion();
  viaje = { t: 0, t0, c0 };
}
const reloj = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(0.05, reloj.getDelta());
  tablero(dt);
  // Con la pestaña o el panel ocultos el lienzo mide 0 y WebGPU no puede crear la imagen.
  if (!renderer.domElement.clientWidth || !renderer.domElement.clientHeight) return;
  if (vuelo) {
    vuelo.t = Math.min(1, vuelo.t + dt / 2.2);
    const k = vuelo.t * vuelo.t * (3 - 2 * vuelo.t);
    controles.target.lerpVectors(vuelo.t0, vuelo.t1, k);
    camara.position.lerpVectors(vuelo.c0, vuelo.c1, k);
    camara.position.y += Math.sin(Math.PI * k) * vuelo.c0.distanceTo(vuelo.c1) * 0.15;
    if (vuelo.t >= 1) vuelo = null;
  }
  // Con el atlas abierto el jugador no se mueve (la tecla que se tenía apretada no cuenta).
  const mira = minimapa.abierto && recorrido.modo !== 'libre' ? ultimaMira : (ultimaMira = recorrido.actualizar(dt));
  if (viaje && mira) {
    // jugador.js dejó la cámara en su sitio final de este cuadro: se mezcla con la de partida y se sube en arco.
    viaje.t = Math.min(1, viaje.t + dt / 2.4);
    const k = viaje.t * viaje.t * (3 - 2 * viaje.t);
    viajeC.copy(camara.position);
    const d = viaje.c0.distanceTo(viajeC);
    camara.position.lerpVectors(viaje.c0, viajeC, k);
    camara.position.y += Math.sin(Math.PI * k) * Math.min(700, Math.max(60, d * 0.35));
    camara.lookAt(viajeT.lerpVectors(viaje.t0, mira, k));
    if (viaje.t >= 1) viaje = null;
  } else if (viaje) viaje = null;
  if (!mira) {
    controles.update();
    const piso = terreno.altura(camara.position.x, camara.position.z) + 8;
    if (camara.position.y < piso) camara.position.y = piso;
  }
  camara.getWorldDirection(dirCam);
  const rumboCam = Math.atan2(-dirCam.x, -dirCam.z), libre = recorrido.modo === 'libre';
  const [jx, jz] = libre ? [controles.target.x, controles.target.z] : recorrido.posicion();
  minimapa.actualizar(jx, jz, libre ? rumboCam : recorrido.rumbo(), rumboCam, camara.position.y - terreno.altura(camara.position.x, camara.position.z));
  const dPlaza = Math.hypot(jx - lugares.centroPlaza[0], jz - lugares.centroPlaza[1]);
  sonido.actualizar({
    modo: recorrido.modo, velocidad: recorrido.velocidad(), noche: noche.value, hora: Number(control.value),
    alto: /caminar|manejar|bici/.test(recorrido.modo) ? 0 : camara.position.y - terreno.altura(camara.position.x, camara.position.z),
    cercaPlaza: 1 - THREE.MathUtils.smoothstep(dPlaza, 80, 250), enTransMilenio: cercaEstacion(jx, jz),
  }, dt);
  const centroSombra = mira || controles.target;
  cameraPos.value.copy(camara.position);
  luzSol.position.copy(dirLuz);
  // La cascada cercana queda nítida a nivel de calle y se alarga con la altura (helicóptero, vista libre).
  luzSol.shadow.camera.far = Math.max(300, Math.min(720, 260 + (camara.position.y - terreno.altura(camara.position.x, camara.position.z)) * 1.6));
  lugares.animar(reloj.elapsedTime);
  farolas.actualizar(camara);
  bosque.userData.actualizar?.(camara);
  transmilenio.actualizar(dt, camara);
  peatones.actualizar(dt, Number(control.value), camara);
  trafico.actualizar(dt, Number(control.value), camara);
  aeropuerto.actualizar(dt, Number(control.value), camara);
  tuberia.render();
});

// La primera vez cada material compila su shader: se hace antes de quitar la pantalla de carga.
await renderer.compileAsync(escena, camara);
paso('Listo', 10);
document.querySelector('#carga').classList.add('oculta');
// Para depurar desde la consola del navegador.
window.simulador = { escena, camara, controles, terreno, irA, recorrido, elegirModo, choques, troncos, estacionados, farolas, calles, vias, transmilenio, peatones, trafico, aeropuerto, arbolesEnPie, exposicion, brillo };
