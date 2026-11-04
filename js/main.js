import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { ClusteredLighting } from 'three/addons/lighting/ClusteredLighting.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { vertexColor, texture, uv, mix, vec3, vec4, float, max, uniform, pass, smoothstep, positionWorldDirection, color } from 'three/tsl';
import { ZONA, aMundo } from './marco.js';
import { cargarTerreno, mallaTerreno } from './terreno.js';
import { cargarEdificios, mallasEdificios, noche, ALTURA_PISO } from './edificios.js';
import { cargarArboles, mallasArboles } from './arboles.js';
import { cargarLineas, mallaVias, texturaSuelo } from './vias.js';
import { construirLugares, puntosDeVista, cameraPos } from './lugares.js';
import { direccionSol, diaDelAno } from './sol.js';
import { crearChoques } from './choques.js';
import { crearRecorrido } from './jugador.js';
import { estacionar } from './vehiculos.js';
import { crearFarolas } from './farolas.js';
import { crearCalles } from './calles.js';

const DATOS = `./datos/${ZONA.nombre}/`;
const barra = document.querySelector('#carga-barra'), textoCarga = document.querySelector('#carga-texto');
let avance = 0;
const paso = (texto, cuanto) => { avance += cuanto; barra.style.width = `${Math.min(100, avance)}%`; textoCarga.textContent = texto; };
// Deja que el navegador pinte la barra antes de seguir con el trabajo pesado.
// Con la pestaña en segundo plano no llegan cuadros: el tope de tiempo evita que la carga se quede esperando.
const respirar = () => new Promise((listo) => { requestAnimationFrame(() => setTimeout(listo, 0)); setTimeout(listo, 80); });

const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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
const sol = new THREE.DirectionalLight(0xfff3e0, 3.2);
sol.castShadow = true;
sol.shadow.mapSize.set(2048, 2048);
Object.assign(sol.shadow.camera, { left: -700, right: 700, top: 700, bottom: -700, near: 10, far: 6000 });
sol.shadow.bias = -0.0004;
sol.shadow.normalBias = 0.6;
escena.add(sol, sol.target);
const relleno = new THREE.HemisphereLight(0xcfe0f5, 0x5d5a50, 1.1);
escena.add(relleno);
escena.fog = new THREE.Fog(0xb8c6d4, 2500, 22000);
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
escena.add(lugares.grupo);

const tex = texturaSuelo(suelo, cajaSuelo);
const matTerreno = new THREE.MeshStandardNodeMaterial({ roughness: 1 });
const t = texture(tex, uv());
matTerreno.colorNode = mix(vertexColor(), t.rgb, t.a);
const tierra = new THREE.Mesh(mallaTerreno(terreno, tex, cajaSuelo), matTerreno);
tierra.receiveShadow = true;
escena.add(tierra);
paso('Levantando edificios', 0);
await respirar();
escena.add(mallasEdificios(edificios, terreno, lugares.excluir).grupo);
paso('Plantando árboles', 15);
await respirar();
escena.add(mallasArboles(arboles, terreno, (a) => lugares.excluir({ cx: a.x, cz: a.z })));
escena.add(mallaVias(vias, terreno));
paso('Preparando la vista', 10);
await respirar();

// Menú de lugares: la cámara vuela hasta cada uno.
const menu = document.querySelector('#lugares');
let vuelo = null;
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
for (const p of puntosDeVista(lugaresDatos, lugares.centroPlaza)) {
  const b = document.createElement('button');
  b.textContent = p.nombre;
  b.addEventListener('click', () => {
    if (recorrido.modo !== 'volar') elegirModo('volar');
    irA(p);
    menu.querySelectorAll('button').forEach((x) => x.classList.toggle('activo', x === b));
  });
  menu.appendChild(b);
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
const troncos = arboles.filter((a) => a.forma !== 4 && a.alt >= 3).map((a) => [a.x, a.z, a.alt > 12 ? 0.35 : 0.22]);
const choques = crearChoques(muros, troncos);
// Carros estacionados en calles secundarias y locales alrededor de la plaza; también suman a los choques.
const estacionados = estacionar({ vias, terreno, choques, centro: lugares.centroPlaza });
escena.add(estacionados.grupo);
const calles = crearCalles(vias);
const farolas = crearFarolas({ vias, terreno, choques, excluir: lugares.excluir });
escena.add(farolas.grupo);
const [px, pz] = [lugares.centroPlaza[0] + 14, lugares.centroPlaza[1] + 14];
const catedral = lugares.solidos[0];
const ccx = catedral.reduce((s, [x]) => s + x, 0) / catedral.length, ccz = catedral.reduce((s, [, z]) => s + z, 0) / catedral.length;
const recorrido = crearRecorrido({
  escena, camara, terreno, choques, calles, estacionados, elJoystick: document.querySelector('#joystick'), lienzo: renderer.domElement,
  inicio: { x: px, z: pz, rumbo: Math.atan2(-(ccx - px), -(ccz - pz)) }, // mirando hacia la Catedral
});
const botonesModo = [...document.querySelectorAll('#modos button')];
const botonTaxi = document.querySelector('#taxi');
function elegirModo(m) {
  const antes = recorrido.modo;
  // Al bajar de Volar, el personaje aparece donde mira la cámara (cerca de la plaza se queda en su punto de partida).
  const lejos = Math.hypot(controles.target.x - px, controles.target.z - pz) > 300;
  if ((m === 'caminar' || m === 'manejar') && antes === 'volar' && (lejos || !primeraVez)) {
    // A pie aparece en el andén; el carro, en jugador.js, en el carril de la calle más cercana.
    const anden = calles.anden(controles.target.x, controles.target.z);
    if (anden) recorrido.llevarA(anden.x, anden.z, anden.rumbo);
    else recorrido.llevarA(controles.target.x, controles.target.z);
  }
  if (antes === 'volar') primeraVez = false;
  recorrido.cambiar(m);
  vuelo = null;
  controles.enabled = m === 'volar';
  if (m === 'volar') {
    const [x, z] = recorrido.posicion();
    controles.target.set(x, terreno.altura(x, z) + 2, z);
    camara.position.y += 40;
  }
  document.body.dataset.modo = m;
  botonesModo.forEach((b) => b.classList.toggle('activo', b.dataset.modo === m));
  botonTaxi.textContent = m === 'manejar' ? 'Bajarse' : 'Subir al carro';
}
let primeraVez = true;
botonesModo.forEach((b) => b.addEventListener('click', () => elegirModo(b.dataset.modo)));
botonTaxi.addEventListener('click', () => elegirModo(recorrido.modo === 'manejar' ? 'caminar' : 'manejar'));
addEventListener('keydown', (e) => {
  if (e.repeat || /INPUT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.code === 'KeyE' && recorrido.modo !== 'volar') elegirModo(recorrido.modo === 'manejar' ? 'caminar' : 'manejar');
  if (e.code === 'KeyV') elegirModo(recorrido.modo === 'volar' ? 'caminar' : 'volar');
});
document.body.dataset.modo = 'volar';

// Postproceso: la exposición va antes del bloom para que su umbral siga el brillo real; ACES se aplica al final.
// El pico que entra al bloom se limita para que los LED de Colpatria no quemen la imagen.
const exposicion = uniform(0.6);
const expuesto = max(pass(escena, camara).getTextureNode('output').rgb, vec3(0)).mul(exposicion);
const pico = max(max(expuesto.r, expuesto.g), expuesto.b);
const brillo = bloom(vec4(expuesto.mul(float(8).div(max(pico, 8))), 1), 0.2, 0.4, 1.2);
brillo.setResolutionScale(0.5);
const tuberia = new THREE.RenderPipeline(renderer, vec4(expuesto.add(brillo.rgb), 1));

// Hora del día. Arranca con la hora real de Bogotá.
const control = document.querySelector('#hora'), etiqueta = document.querySelector('#hora-texto');
const ahora = new Date(), horaBogota = (ahora.getUTCHours() - 5 + 24) % 24 + ahora.getUTCMinutes() / 60;
control.value = String(Math.round(horaBogota * 4) / 4);
const dirSol = new THREE.Vector3(), dirLuz = new THREE.Vector3(), dia = diaDelAno(ahora);
// Noche "de cine", como en Slop New York: luna azul con sombras, relleno azul y lo que brilla por encima del bloom.
const LUNA = new THREE.Vector3(-0.35, 0.82, 0.45).normalize();
const C_DIA = new THREE.Color(0xb8c6d4), C_NOCHE = new THREE.Color(0x141c2c), cNiebla = new THREE.Color();
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
  sol.intensity = 3.2 * luz + 0.4 * luna;
  if (altura > -0.02) sol.color.setHSL(0.09, 0.6, 0.55 + 0.4 * luz); else sol.color.set(0x8cb0e8);
  relleno.intensity = 0.45 + 0.35 * claro;
  relleno.color.lerpColors(CIELO[0], CIELO[1], claro);
  relleno.groundColor.lerpColors(SUELO[0], SUELO[1], claro);
  noche.value = 1 - ss(altura, -0.08, 0.12);
  escena.fog.color.copy(cNiebla.copy(C_NOCHE).lerp(C_DIA, ss(altura, -0.12, 0.2)));
  cielo.visible = altura > -0.1;
  exposicion.value = 0.48 + 0.37 * (1 - luz);
  brillo.strength.value = 0.12 + 0.2 * (1 - luz);
  brillo.threshold.value = 1.0 + 0.4 * luz;
  if (horneada !== h) { horneada = h; hornearCielo(); }
}
control.addEventListener('input', aplicarHora);
aplicarHora();

window.addEventListener('resize', () => {
  camara.aspect = window.innerWidth / window.innerHeight;
  camara.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const reloj = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(0.05, reloj.getDelta());
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
  const mira = recorrido.actualizar(dt);
  if (!mira) {
    controles.update();
    const piso = terreno.altura(camara.position.x, camara.position.z) + 8;
    if (camara.position.y < piso) camara.position.y = piso;
  }
  const centroSombra = mira || controles.target;
  cameraPos.value.copy(camara.position);
  sol.position.copy(centroSombra).addScaledVector(dirLuz, 3000);
  sol.target.position.copy(centroSombra);
  lugares.animar(reloj.elapsedTime);
  farolas.actualizar(camara);
  tuberia.render();
});

// La primera vez cada material compila su shader: se hace antes de quitar la pantalla de carga.
await renderer.compileAsync(escena, camara);
paso('Listo', 10);
document.querySelector('#carga').classList.add('oculta');
// Para depurar desde la consola del navegador.
window.simulador = { escena, camara, controles, terreno, irA, recorrido, elegirModo, choques, troncos, estacionados, farolas, calles, vias, exposicion, brillo };
