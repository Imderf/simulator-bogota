import * as THREE from 'three/webgpu';
import { ZONA } from './marco.js';

// Dirección del sol (x este, y arriba, z sur) para una hora local de Bogotá y un día del año.
// En el ecuador el sol sale y se pone cerca de las 6 todo el año y pasa casi por encima de la cabeza.
export function direccionSol(hora, diaDelAno, destino = new THREE.Vector3()) {
  const rad = Math.PI / 180;
  const lat = ZONA.origen.lat * rad;
  const dec = -23.44 * rad * Math.cos((2 * Math.PI * (diaDelAno + 10)) / 365);
  // Bogotá está en UTC-5 (meridiano -75); la longitud real corrige unos 4 minutos.
  const solar = hora + (ZONA.origen.lon + 75) / 15;
  const H = (solar - 12) * 15 * rad;
  const elev = Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(-Math.sin(H), Math.tan(dec) * Math.cos(lat) - Math.sin(lat) * Math.cos(H));
  return destino.set(Math.sin(az) * Math.cos(elev), Math.sin(elev), -Math.cos(az) * Math.cos(elev));
}

export function diaDelAno(fecha = new Date()) {
  return Math.floor((fecha - new Date(fecha.getFullYear(), 0, 0)) / 86400000);
}
