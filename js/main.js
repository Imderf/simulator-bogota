import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { vertexColor, texture, uv, mix, vec3 } from 'three/tsl';
import { ZONA, aMundo } from './marco.js';
import { cargarTerreno, mallaTerreno } from './terreno.js';
import { cargarEdificios, mallasEdificios, noche } from './edificios.js';
import { cargarArboles, mallasArboles } from './arboles.js';
import { cargarLineas, mallaVias, texturaSuelo } from './vias.js';
import { construirLugares, puntosDeVista, cameraPos } from './lugares.js';
import { direccionSol, diaDelAno } from './sol.js';

const DATOS = `./datos/${ZONA.nombre}/`;
const barra = document.querySelector('#carga-barra'), textoCarga = document.querySelector('#carga-texto');
let avance = 0;
const paso = (texto, cuanto) => { avance += cuanto; barra.style.width = `${Math.min(100, avance)}%`; textoCarga.textContent = texto; };

const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.55;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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

// Datos en paralelo.
const [terreno, edificios, arboles, vias, suelo, lugaresDatos] = await Promise.all([
  cargarTerreno(DATOS + 'terreno.bin.gz').then((v) => (paso('Relieve listo', 15), v)),
  cargarEdificios(DATOS + 'edificios.bin.gz').then((v) => (paso('Edificios del catastro listos', 20), v)),
  cargarArboles(DATOS + 'arboles.bin.gz').then((v) => (paso('Árboles listos', 10), v)),
  cargarLineas(DATOS + 'vias.bin.gz', 'BOV1').then((v) => (paso('Vías listas', 5), v)),
  cargarLineas(DATOS + 'suelo.bin.gz', 'BOS1'),
  fetch(DATOS + 'lugares.json').then((r) => r.json()),
]);

const [cx0, cz0] = aMundo(ZONA.caja[0], ZONA.caja[3]), [cx1, cz1] = aMundo(ZONA.caja[2], ZONA.caja[1]);
const cajaSuelo = { x0: cx0, z0: cz0, x1: cx1, z1: cz1 };
const tex = texturaSuelo(suelo, cajaSuelo);
const matTerreno = new THREE.MeshStandardNodeMaterial({ roughness: 1 });
const t = texture(tex, uv());
matTerreno.colorNode = mix(vertexColor(), t.rgb, t.a);
const tierra = new THREE.Mesh(mallaTerreno(terreno, tex, cajaSuelo), matTerreno);
tierra.receiveShadow = true;
escena.add(tierra);
paso('Armando los lugares', 10);

const lugares = construirLugares(lugaresDatos, terreno, edificios);
escena.add(lugares.grupo);
escena.add(mallasEdificios(edificios, terreno, lugares.excluir).grupo);
paso('Plantando árboles', 15);
escena.add(mallasArboles(arboles, terreno, lugares.excluir));
escena.add(mallaVias(vias, terreno));
paso('Listo', 20);

// Menú de lugares: la cámara vuela hasta cada uno.
const menu = document.querySelector('#lugares');
let vuelo = null;
function irA(p, inmediato = false) {
  const y = terreno.altura(p.x, p.z);
  const destinoT = new THREE.Vector3(p.x, y + 20, p.z);
  const dir = new THREE.Vector3(-0.55, 0, 0.83).normalize(); // mirando hacia los cerros
  const destinoC = destinoT.clone().addScaledVector(dir, p.dist).setY(y + p.alto);
  if (inmediato) { controles.target.copy(destinoT); camara.position.copy(destinoC); return; }
  vuelo = { t: 0, t0: controles.target.clone(), c0: camara.position.clone(), t1: destinoT, c1: destinoC };
}
for (const p of puntosDeVista(lugaresDatos, lugares.centroPlaza)) {
  const b = document.createElement('button');
  b.textContent = p.nombre;
  b.addEventListener('click', () => { irA(p); menu.querySelectorAll('button').forEach((x) => x.classList.toggle('activo', x === b)); });
  menu.appendChild(b);
}
irA({ x: lugares.centroPlaza[0], z: lugares.centroPlaza[1], dist: 1400, alto: 650 }, true);

// Hora del día. Arranca con la hora real de Bogotá.
const control = document.querySelector('#hora'), etiqueta = document.querySelector('#hora-texto');
const ahora = new Date(), horaBogota = (ahora.getUTCHours() - 5 + 24) % 24 + ahora.getUTCMinutes() / 60;
control.value = String(Math.round(horaBogota * 4) / 4);
const dirSol = new THREE.Vector3(), dia = diaDelAno(ahora);
const C_DIA = new THREE.Color(0xb8c6d4), C_NOCHE = new THREE.Color(0x0d1320), cNiebla = new THREE.Color();
function aplicarHora() {
  const h = Number(control.value);
  etiqueta.textContent = `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
  direccionSol(h, dia, dirSol);
  cielo.sunPosition.value.copy(dirSol);
  const altura = dirSol.y;
  const luz = THREE.MathUtils.smoothstep(altura, -0.05, 0.25);
  sol.intensity = 3.2 * luz;
  sol.color.setHSL(0.09, 0.6, 0.55 + 0.4 * luz);
  relleno.intensity = 0.15 + 1.0 * THREE.MathUtils.smoothstep(altura, -0.15, 0.3);
  noche.value = 1 - THREE.MathUtils.smoothstep(altura, -0.08, 0.12);
  escena.fog.color.copy(cNiebla.copy(C_NOCHE).lerp(C_DIA, THREE.MathUtils.smoothstep(altura, -0.12, 0.2)));
  renderer.toneMappingExposure = 0.45 + 0.15 * luz;
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
  if (vuelo) {
    vuelo.t = Math.min(1, vuelo.t + dt / 2.2);
    const k = vuelo.t * vuelo.t * (3 - 2 * vuelo.t);
    controles.target.lerpVectors(vuelo.t0, vuelo.t1, k);
    camara.position.lerpVectors(vuelo.c0, vuelo.c1, k);
    camara.position.y += Math.sin(Math.PI * k) * vuelo.c0.distanceTo(vuelo.c1) * 0.15;
    if (vuelo.t >= 1) vuelo = null;
  }
  controles.update();
  const piso = terreno.altura(camara.position.x, camara.position.z) + 8;
  if (camara.position.y < piso) camara.position.y = piso;
  cameraPos.value.copy(camara.position);
  sol.position.copy(controles.target).addScaledVector(dirSol, 3000);
  sol.target.position.copy(controles.target);
  lugares.animar(reloj.elapsedTime);
  renderer.render(escena, camara);
});

document.querySelector('#carga').classList.add('oculta');
