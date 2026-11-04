import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { vec3, float } from 'three/tsl';
import { noche } from './edificios.js';
import { anchoVia, andenVia } from './vias.js';

// Postes de alumbrado a lo largo de las vías. Todos se dibujan con dos instancias (poste y luminaria); de noche
// solo los más cercanos a la cámara alumbran de verdad, con un grupo fijo de luces que se reparte cada cuadro
// (como en Slop New York, street-details.js). El resto brilla por el bombillo y el bloom.

// Metros entre postes por clase (troncal, principal, secundaria, local, servicio, peatonal); las demás no llevan.
const PASO = [30, 32, 34, 36, 0, 24];
const ALTO = 8.5, BRAZO = 1.6;
const LUCES = 32, ALCANCE = 120, CELDA = 128;

export function crearFarolas({ vias, terreno, choques, excluir = () => false }) {
  // Sitios: a lado y lado, alternando, sobre el andén. Se descartan los que caen dentro de un edificio
  // o a menos de 12 m de otro poste.
  const sitios = [], ocupado = new Set(), prueba = { x: 0, z: 0 };
  for (const via of vias) {
    const { clase, p } = via, paso = PASO[clase];
    if (!paso || via.bus) continue;
    // Sobre el andén, cerca del bordillo.
    const off = anchoVia(via) / 2 + (andenVia(via) ? Math.min(1.2, andenVia(via) * 0.4) : 0.8);
    let lado = 1, prox = paso / 2, hecho = 0; // prox: distancia a lo largo de la vía del siguiente poste
    for (let i = 0; i < p.length - 1; i++) {
      const [ax, az] = p[i], [bx, bz] = p[i + 1], dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz);
      if (l < 0.1) continue;
      const ux = dx / l, uz = dz / l, nx = -uz, nz = ux;
      for (; prox <= hecho + l; prox += paso, lado = -lado) {
        const d = prox - hecho, x = ax + ux * d + nx * off * lado, z = az + uz * d + nz * off * lado;
        const llave = `${Math.round(x / 12)},${Math.round(z / 12)}`;
        if (ocupado.has(llave) || excluir({ cx: x, cz: z })) continue;
        prueba.x = x; prueba.z = z;
        if (choques.empujar(prueba, 0.5)) continue;
        ocupado.add(llave);
        // La luminaria cuelga hacia el centro de la vía.
        sitios.push({ x, z, y: terreno.altura(x, z), rumbo: Math.atan2(nx * lado, nz * lado), hx: x - nx * lado * BRAZO, hz: z - nz * lado * BRAZO });
      }
      hecho += l;
    }
  }

  // Poste gris con brazo y luminaria LED plana. El brazo apunta hacia -z: la instancia lo gira hacia la vía.
  const poste = mergeGeometries([
    new THREE.CylinderGeometry(0.07, 0.12, ALTO, 6).translate(0, ALTO / 2, 0),
    new THREE.CylinderGeometry(0.045, 0.045, BRAZO, 5).rotateX(Math.PI / 2).translate(0, ALTO - 0.15, -BRAZO / 2),
    new THREE.BoxGeometry(0.34, 0.1, 0.62).translate(0, ALTO - 0.12, -BRAZO),
  ]);
  const bombillo = new THREE.BoxGeometry(0.26, 0.03, 0.5).translate(0, ALTO - 0.185, -BRAZO);
  const matPoste = new THREE.MeshStandardNodeMaterial({ color: 0x6f7378, roughness: 0.55, metalness: 0.6 });
  // De día el bombillo se ve gris; de noche pasa del umbral del bloom.
  const matBombillo = new THREE.MeshBasicNodeMaterial();
  matBombillo.colorNode = vec3(1.0, 0.88, 0.7).mul(float(0.35).add(noche.mul(3.6)));
  const postes = new THREE.InstancedMesh(poste, matPoste, sitios.length);
  const bombillos = new THREE.InstancedMesh(bombillo, matBombillo, sitios.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), uno = new THREE.Vector3(1, 1, 1), pos = new THREE.Vector3();
  sitios.forEach((s, i) => {
    m4.compose(pos.set(s.x, s.y - 0.02, s.z), q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, s.rumbo), uno);
    postes.setMatrixAt(i, m4);
    bombillos.setMatrixAt(i, m4);
  });
  postes.castShadow = true;
  postes.computeBoundingSphere();
  bombillos.computeBoundingSphere();
  const grupo = new THREE.Group();
  grupo.name = 'Farolas';
  grupo.add(postes, bombillos);

  // Grupo fijo de luces: cono ancho hacia abajo que cubre calzada y andén. Decay menor que 2 para que el charco
  // de luz llegue más lejos.
  const luces = [];
  for (let i = 0; i < LUCES; i++) {
    const l = new THREE.SpotLight(0xffe2b8, 0, 26, 0.96, 0.82, 1.25);
    l.position.set(0, -1000, 0);
    grupo.add(l, l.target);
    luces.push(l);
  }
  const celdas = new Map();
  for (const s of sitios) {
    const llave = `${Math.floor(s.x / CELDA)},${Math.floor(s.z / CELDA)}`;
    if (!celdas.has(llave)) celdas.set(llave, []);
    celdas.get(llave).push(s);
  }
  const activos = [];
  const suave = (d, a, b) => { const t = Math.min(1, Math.max(0, (b - d) / (b - a))); return t * t * (3 - 2 * t); };

  function actualizar(camara) {
    const fuerza = Math.min(1.25, Math.max(0, (noche.value - 0.2) * 1.5));
    let n = 0;
    if (fuerza > 0.001) {
      const { x: cx, y: cy, z: cz } = camara.position, e = camara.matrixWorld.elements, fx = -e[8], fz = -e[10];
      const alto = cy - terreno.altura(cx, cz);
      activos.length = 0;
      for (let ix = Math.floor((cx - ALCANCE) / CELDA); ix <= Math.floor((cx + ALCANCE) / CELDA); ix++) {
        for (let iz = Math.floor((cz - ALCANCE) / CELDA); iz <= Math.floor((cz + ALCANCE) / CELDA); iz++) {
          for (const s of celdas.get(`${ix},${iz}`) || []) {
            const dx = s.x - cx, dz = s.z - cz, d = Math.sqrt(dx * dx + dz * dz + alto * alto);
            // Las que quedan detrás de la cámara pesan menos.
            const ef = d + Math.max(0, 6 - dx * fx - dz * fz) * 2.8;
            if (ef < ALCANCE) { s.ef = ef; activos.push(s); }
          }
        }
      }
      activos.sort((a, b) => a.ef - b.ef);
      n = Math.min(LUCES, activos.length);
      const corte = activos.length > LUCES ? activos[LUCES].ef : ALCANCE;
      for (let i = 0; i < n; i++) {
        const s = activos[i], l = luces[i];
        l.position.set(s.hx, s.y + ALTO - 0.25, s.hz);
        l.target.position.set(s.hx, s.y, s.hz);
        l.target.updateMatrixWorld();
        l.intensity = 95 * fuerza * suave(s.ef, corte * 0.62, corte);
      }
    }
    for (let i = n; i < LUCES; i++) { luces[i].intensity = 0; luces[i].position.set(0, -1000, 0); }
  }

  return { grupo, actualizar, sitios };
}
