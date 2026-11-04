import * as THREE from 'three/webgpu';
import { Fn, positionWorld, cameraPosition, cameraViewMatrix, time, mx_noise_float, fwidth, pmremTexture, reflect, dot, cos,
  smoothstep, mix, max, float, vec2, vec3, color, specularColor, specularColorBlended, specularF90 } from 'three/tsl';
import { altoVia } from './vias.js';

const AGUA = 2, PEATONAL = 5;
// El canal del Eje Ambiental (Salmona) corre por la Avenida Jiménez. En OpenStreetMap solo están como agua unos pocos
// trozos (y las piscinas escalonadas de Las Aguas hacia la Quinta de Bolívar); el resto se traza sobre la vía peatonal.
const CANALES = ['Avenida Jiménez'];
const ANCHO_CANAL = 1.6;
// Sobre el relieve: lo justo para no pelear con el terreno (que va por debajo con su lodo).
const SOBRE = 0.12;

// Agua de estanques, piscinas y el canal del Eje Ambiental en una sola malla (una llamada a la GPU).
// suelo: polígonos de cargarLineas('suelo...'); terreno: { altura(x, z) }; vias y nombresVias (el JSON de
// nombres-vias.json) son opcionales y solo sirven para el canal.
export function crearAgua({ suelo, terreno, vias = [], nombresVias = null }) {
  const pos = [];
  for (const { clase, p } of suelo) {
    if (clase !== AGUA) continue;
    const ys = p.map(([x, z]) => terreno.altura(x, z) + SOBRE);
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(p.map(([x, z]) => new THREE.Vector2(x, z)), [])) {
      triangulo(pos, [p[a][0], ys[a], p[a][1]], [p[b][0], ys[b], p[b][1]], [p[c][0], ys[c], p[c][1]]);
    }
  }
  // De cada calle con canal se toma su vía peatonal más al norte (si hay dos, la otra es el costado sur).
  if (nombresVias?.via?.length === vias.length) {
    for (const nombre of CANALES) {
      const media = (v) => v.p.reduce((s, q) => s + q[1], 0) / v.p.length;
      const v = vias.filter((v, k) => v.clase === PEATONAL && nombresVias.nombres[nombresVias.via[k]] === nombre)
        .sort((a, b) => media(a) - media(b))[0];
      if (v) canal(pos, v.p, terreno, altoVia(v) + 0.06);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  const malla = new THREE.Mesh(g, materialAgua());
  malla.receiveShadow = true;
  malla.name = 'Agua';
  const grupo = new THREE.Group();
  grupo.name = 'Agua';
  if (pos.length) grupo.add(malla);
  return { grupo };
}

// Triángulo mirando hacia arriba, sin importar el giro del polígono de OpenStreetMap.
function triangulo(pos, a, b, c) {
  const arriba = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]) > 0;
  pos.push(...a, ...(arriba ? b : c), ...(arriba ? c : b));
}

// Cinta de agua a lo largo de una línea, partida cada 8 m para que siga el relieve.
function canal(pos, p, terreno, alto) {
  for (let i = 0; i < p.length - 1; i++) {
    const [ax, az] = p[i], [bx, bz] = p[i + 1], l = Math.hypot(bx - ax, bz - az);
    if (l < 0.01) continue;
    const nx = (-(bz - az) / l) * ANCHO_CANAL / 2, nz = ((bx - ax) / l) * ANCHO_CANAL / 2, pasos = Math.ceil(l / 8);
    for (let s = 0; s < pasos; s++) {
      const [x0, z0, x1, z1] = [s / pasos, (s + 1) / pasos].flatMap((t) => [ax + (bx - ax) * t, az + (bz - az) * t]);
      const y0 = terreno.altura(x0, z0) + alto, y1 = terreno.altura(x1, z1) + alto;
      const q = [[x0 - nx, y0, z0 - nz], [x1 - nx, y1, z1 - nz], [x1 + nx, y1, z1 + nz], [x0 + nx, y0, z0 + nz]];
      triangulo(pos, q[0], q[1], q[2]);
      triangulo(pos, q[0], q[2], q[3]);
    }
  }
}

// Olas finas: [largo (m), rumbo (rad), pendiente]. Largos sin múltiplos comunes para que no se note la repetición.
const OLAS = [[3.1, 0.3, 0.05], [1.9, 1.2, 0.045], [1.23, -0.5, 0.045], [0.77, 0.9, 0.04], [0.49, -0.1, 0.035], [0.31, 1.6, 0.03]];

// Agua quieta de ciudad. Idea adaptada de Slop New York (mrdoob, MIT): js/tsl-materials.js, createWaterMaterial:
// - Normales de olas que se mueven con el tiempo; la pendiente de las olas más pequeñas que un píxel se vuelve
//   rugosidad en vez de parpadear, así el brillo del sol se abre en un camino de destellos a lo lejos.
// - El metal lleva el Fresnel del agua (F0 = 0,02): pesa los reflejos en pantalla (SSR) del postproceso y le quita
//   cuerpo al agua de canto. El brillo especular queda gris (no se tiñe del color del agua).
// - El cielo del mapa de entorno se refleja completo según Fresnel (la escena usa environmentIntensity 0,2 para el
//   resto) y el agua deja ver un poco el fondo: más transparente mirando hacia abajo, más espejo al rasante.
function materialAgua() {
  const m = new THREE.MeshStandardNodeMaterial({ transparent: true, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  const p = positionWorld.xz, pie = max(fwidth(p.x), fwidth(p.y));
  // Rachas de viento que se mueven despacio y frentes de onda torcidos, para que no se vea una rejilla de senos.
  const racha = mx_noise_float(p.mul(0.08).add(time.mul(0.04))).mul(0.8).add(0.85);
  const torcer = mx_noise_float(p.mul(0.3).add(5.1)).mul(2);
  let pendiente = vec2(0, 0), varianza = float(0.0004);
  OLAS.forEach(([L, rumbo, s], i) => {
    // Velocidad de aguas profundas: w = √(g·k).
    const k = (2 * Math.PI) / L, w = Math.sqrt(9.8 * k), dx = Math.cos(rumbo), dz = Math.sin(rumbo);
    const fase = p.x.mul(dx * k).add(p.y.mul(dz * k)).add(torcer.mul(0.6 + 0.25 * i)).sub(time.mul(w));
    const nitida = smoothstep(L * 0.15, L * 0.4, pie).oneMinus(), a = racha.mul(s);
    pendiente = pendiente.add(vec2(dx, dz).mul(cos(fase).mul(a).mul(nitida)));
    varianza = varianza.add(a.mul(a).mul(0.5).mul(nitida.oneMinus()));
  });
  const normal = vec3(pendiente.x.negate(), 1, pendiente.y.negate()).normalize();
  m.normalNode = cameraViewMatrix.transformDirection(normal);
  // Alfa de GGX ≈ pendiente media de las olas que no se ven; rugosidad = √alfa.
  const rugosidad = varianza.pow(0.25).clamp(0.06, 0.45);
  m.roughnessNode = rugosidad;

  const vista = cameraPosition.sub(positionWorld).normalize();
  const fresnel = float(1).sub(dot(normal, vista).clamp(0, 1)).pow(5).mul(0.98).add(0.02);
  m.metalnessNode = fresnel.mul(1.6).clamp(0, 0.9);
  m.setupSpecular = () => {
    specularColor.assign(vec3(0.02));
    specularColorBlended.assign(vec3(0.02));
    specularF90.assign(1);
  };
  // Agua verdosa de canal y estanque, con manchas de sedimento.
  m.colorNode = mix(color(0x1c3330), color(0x2c3b29), smoothstep(-0.3, 0.3, mx_noise_float(p.mul(0.03))));
  m.opacityNode = mix(float(0.72), float(0.97), fresnel);
  // Cielo reflejado: se lee el mapa de entorno de la escena al compilar (el cielo horneado de main.js).
  const rayo = reflect(vista.negate(), normal);
  m.emissiveNode = Fn(({ scene }) => (scene?.environment ? pmremTexture(scene.environment, rayo, rugosidad).rgb.mul(fresnel).mul(0.8) : vec3(0)))();
  return m;
}
