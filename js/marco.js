// Zona piloto y marco de coordenadas. Lo usan la página y los scripts de tools/.
// Marco: 1 unidad = 1 m, x = este, z = sur (el norte es -z), y = altura sobre BASE.
// Origen en el centro de la Plaza de Bolívar.

export const ZONA = {
  nombre: 'centro',
  // Caja oeste, sur, este, norte (grados). Cubre La Candelaria, el Centro Internacional,
  // las Torres del Parque, Monserrate y Guadalupe.
  caja: [-74.090, 4.583, -74.045, 4.625],
  origen: { lon: -74.07604, lat: 4.59814 },
};

const A = 6378137.0;
const E2 = 6.69437999014e-3;
const PHI0 = (ZONA.origen.lat * Math.PI) / 180;
const S = Math.sin(PHI0);
const N = A / Math.sqrt(1 - E2 * S * S);
const M = (A * (1 - E2)) / Math.pow(1 - E2 * S * S, 1.5);
export const KX = (Math.PI / 180) * N * Math.cos(PHI0); // metros por grado de longitud
export const KY = (Math.PI / 180) * M; // metros por grado de latitud

// Plano tangente local: [x, z] en metros.
export const aMundo = (lon, lat) => [(lon - ZONA.origen.lon) * KX, -(lat - ZONA.origen.lat) * KY];
export const aGeo = (x, z) => [ZONA.origen.lon + x / KX, ZONA.origen.lat - z / KY];
