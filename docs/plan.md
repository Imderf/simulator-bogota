# Plan por fases

1. **Planificación.** Datos, licencias, zona inicial y lista de lugares.
2. **Terreno y datos.** Scripts en `tools/` que bajan catastro, árboles, relieve y vías, y generan los archivos que lee la simulación. Los datos crudos no se suben al repo.
3. **Zona piloto: Centro.** La Candelaria, Plaza de Bolívar, Centro Internacional y Monserrate. Tiene los edificios más altos, los lugares más conocidos y los cerros.
4. **Lugares emblemáticos hechos a mano**, uno por uno. Ver [lugares.md](lugares.md).
5. **Vida en la calle.** TransMilenio, SITP, taxis amarillos, motos, ciclorrutas, peatones y lluvia.
6. **Resto de Bogotá** por localidades, cuidando el rendimiento.
7. **Plantilla para otras ciudades.** Separar lo que es propio de Bogotá de lo que sirve para cualquier ciudad o pueblo de Colombia.

## Lo que hace distinta a Bogotá

- **Relieve.** Nueva York es plana. Bogotá está a unos 2.600 m, con los Cerros Orientales al lado. Calles, edificios, árboles y física tienen que apoyarse en un terreno real.
- **Cuadrícula de calles y carreras**, paralela a los cerros. La nomenclatura (Calle 26, Carrera 7) sirve para el mapa y el radar.
- **Luz del ecuador.** Amanece y anochece cerca de las 6 todo el año.
- **Transporte propio.** Buses articulados en carriles exclusivos, estaciones en el separador, muchas motos y ciclovía los domingos.

## Decisiones técnicas abiertas

- Origen del sistema de coordenadas: propuesta, la Plaza de Bolívar.
- Cómo restar la altura base (unos 2.600 m) para no perder precisión.
- Cuántos edificios aguanta un celular: el catastro tiene 2,4 millones de construcciones.
