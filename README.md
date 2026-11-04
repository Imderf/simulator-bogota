# Simulador Bogotá

Una simulación de Bogotá en el navegador, hecha con [three.js](https://threejs.org/), WebGPURenderer y TSL. La idea es recorrer la ciudad a pie, en carro, en bicicleta o en helicóptero, con su relieve real, sus edificios y sus lugares emblemáticos.

Empezamos por Bogotá. Después vendrán otras ciudades y pueblos de Colombia.

*A browser simulation of Bogotá, Colombia, built with three.js, WebGPU and TSL. Inspired by [Slop New York](https://github.com/mrdoob/slop-newyork).*

## Estado

Primera versión de la zona Centro. **Pruébalo en línea: https://imderf.github.io/simulator-bogota/** (se publica sola desde la rama `zona-centro`).

Es para computador. En celular aparece una pantalla que pide abrirlo en un computador o activar «Sitio de escritorio» en el navegador.

Para verla en local: `npm run inicio` y abrir http://127.0.0.1:8801. Ese servidor no guarda caché, así que cada cambio se ve al recargar. Necesita un navegador con WebGPU o WebGL 2.

Para regenerar los datos: `npm install` y luego `npm run datos`.

- [Plan por fases y estado](docs/plan.md)
- [Peso: por qué carga rápido](docs/peso.md)
- [Fuentes de datos](docs/fuentes-de-datos.md)
- [Lugares emblemáticos](docs/lugares.md)
- [Cómo trabajamos en el repo](docs/colaboracion.md)

## Inspiración

Este proyecto toma como punto de partida [Slop New York](https://github.com/mrdoob/slop-newyork) de mrdoob (licencia MIT). El código que adaptemos de ahí conserva su aviso de licencia en [LICENSE](LICENSE).

## Licencia y datos

El código se publica bajo la [licencia MIT](LICENSE).

Datos geográficos: Unidad Administrativa Especial de Catastro Distrital y Jardín Botánico de Bogotá, a través de [Datos Abiertos Bogotá](https://datosabiertos.bogota.gov.co/) (CC BY 4.0); © [colaboradores de OpenStreetMap](https://www.openstreetmap.org/copyright) (ODbL); relieve de Copernicus DEM GLO-30 (Unión Europea y ESA). Cada fuente conserva su propia licencia.

## Autores

Imderf R. y Jaime O.
