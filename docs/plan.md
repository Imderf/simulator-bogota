# Plan por fases

Estado al 2026-11-03.

| Fase | Qué | Estado |
|---|---|---|
| 1 | Planificación: datos, licencias, zona inicial, lista de lugares | Hecha |
| 2 | Terreno y datos: scripts que bajan y compactan | Hecha para la zona Centro |
| 3 | Zona piloto Centro: motor base | Funciona; probado en escritorio y celular emulado |
| 4 | Lugares emblemáticos hechos a mano | Prioridad 1 armada y revisada en pantalla |
| 5 | Vida en la calle: TransMilenio, SITP, taxis, motos, peatones, lluvia | Pendiente |
| 6 | Resto de Bogotá por localidades | Pendiente |
| 7 | Plantilla para otras ciudades y pueblos de Colombia | Pendiente |

## Lo que ya está

### Datos (fase 2)

- `tools/bajar-centro.mjs` baja catastro, árboles, OpenStreetMap y Copernicus a `tools/data/raw/` (fuera de git).
- `tools/construir-centro.mjs` los convierte en binarios compactos en `datos/centro/`.
- `tools/lugares-centro.mjs` saca de OpenStreetMap las plantas de los lugares emblemáticos.
- **Toda la zona Centro pesa 944 KB**: relieve de 484 × 520 puntos cada 32 m (173 KB), 51.262 edificios (522 KB), 70.697 árboles (134 KB), 6.183 vías (89 KB), suelo (26 KB) y lugares (9 KB). Ver [peso.md](peso.md).
- Marco de coordenadas compartido en `js/marco.js`: metros, origen en la Plaza de Bolívar, base a 2.606 m.

### Motor (fase 3)

- `index.html` sin paso de compilación; three.js r187 desde jsDelivr con WebGPU y TSL.
- Terreno con colores por altura y pendiente, más parques, bosques, agua y plazas pintados en un `canvas`.
- Edificios del catastro extruidos sobre el relieve, con ventanas por shader que se encienden de noche. Colores bogotanos: ladrillo, estuco, concreto; casas blancas con teja en La Candelaria.
- Árboles del Jardín Botánico como instancias, con cinco formas según la especie.
- Vías de OpenStreetMap como cintas sobre el terreno.
- Cielo, sol calculado para la latitud de Bogotá y la hora real, y control de hora.
- Cámara orbital con menú de lugares que vuela hasta cada uno.

### Lugares (fase 4)

Plaza de Bolívar (plaza, estatua, Capitolio con pórtico de 18 columnas, Catedral con dos torres de 52 m, Palacio Liévano, Palacio de Justicia), Torre Colpatria (196 m, fachada de LED animada de noche), BD Bacatá (216 y 167 m), Edificio Avianca (161 m), Torres del Parque, La Santamaría, Planetario, Museo Nacional, Teatro Colón, Monserrate (basílica de torre única, estaciones, funicular y teleférico con cabina) y Guadalupe (ermita y Virgen de 15 m). Fuentes en [lugares.md](lugares.md).

### Primera prueba en el navegador (2026-11-03)

Funcionó al primer intento: sin errores de shader y a 120 cuadros por segundo en un Mac. Lo que se corrigió:

- El vidrio de Bacatá y Avianca salía negro: sin mapa de entorno, un material muy metálico no refleja nada. Ahora usa poco metal.
- Las torres genéricas de 20 o más pisos se veían casi negras a la sombra: paleta más clara.
- Monserrate y Guadalupe quedaban enterrados o sobre un muro de 60 m: la malla de 32 m redondea las cimas. Ahora se aplana el terreno bajo su planta (`terreno.aplanar`), como la explanada real.
- La cámara llegaba de lado a la Catedral: cada lugar puede decir desde dónde se mira (`desde`).
- Con la pestaña oculta el lienzo mide 0 y WebGPU fallaba: ahora no dibuja hasta que el lienzo tenga tamaño.
- La barra de carga no avanzaba: ahora deja pintar entre pasos y compila los shaders antes de quitar la pantalla.

### Recorrer a pie y en taxi (2026-11-03)

- Tres modos: **Volar**, **Caminar** y **Manejar** (barra abajo; en celular, arriba a la izquierda).
- Personaje de 1,72 m armado con piezas simples, con paso animado. Camina a 1,6 m/s y corre a 4,2 m/s.
- Taxi amarillo compacto con franja de cuadros, letrero en el techo, ruedas que giran y doblan, faros que alumbran de noche. Física sencilla: aceleración, freno, reversa y giro según la velocidad; máximo unos 54 km/h (80 km/h con Shift).
- Choques contra las plantas del catastro y de los lugares (`js/choques.js`, rejilla de 16 m).
- Teclado: W A S D o flechas, Shift, Espacio, E para subir o bajar del taxi, V para volar. En celular: joystick y botón del taxi.
- Al pasar de Volar a Caminar o Manejar, el personaje (o el taxi) aparece en la calle más cercana a donde mira la cámara, alineado con ella.

### Recorrido afinado (2026-11-03)

- **Suspensión del taxi**: mide el suelo bajo las cuatro ruedas y la carrocería lo sigue con resortes; se inclina en las lomas, se ladea en las curvas y baja la trompa al frenar.
- **Árboles**: 27.899 troncos (los de más de 3 m) cuentan para los choques.
- **Cámara**: se acerca si un muro se interpone y vuelve suave cuando hay espacio. Arrastrar sobre la escena gira la vista; al soltar, vuelve sola detrás.

## Lo que sigue

1. **Probar en un celular real**: Android e iPhone, con datos móviles.
2. **Medir rendimiento** en un celular de gama media. Si no da, recortar por distancia los árboles y edificios lejanos.
3. **Prueba de peso** en `tests/` que falle si `datos/` pasa de 2 MB.
4. **Afinar los lugares** con las fotos de Commons: frontón y relojes de la Catedral, arcada del Liévano, ventanas de Colpatria, terrazas reales de Salmona.
5. **Bosque de los cerros**: árboles generados sobre los Cerros Orientales, que no están en el censo urbano.
6. **Tráfico y TransMilenio**: carros que circulen por las vías y buses rojos por la Caracas y la 7.
7. **Fase 5**: TransMilenio por la Caracas y la 7, taxis amarillos y motos.
8. **Publicar en GitHub Pages** cuando Imderf y Jaime lo aprueben.

## Lo que hace distinta a Bogotá

- **Relieve.** Nueva York es plana. Bogotá está a unos 2.600 m, con los Cerros Orientales al lado. Calles, edificios, árboles y física se apoyan en un terreno real.
- **La cuadrícula del centro está girada unos 31°** hacia el nor-noreste. Cada lugar se modela en su propio marco, alineado con su planta.
- **Luz del ecuador.** Amanece y anochece cerca de las 6 todo el año.
- **Transporte propio.** Buses articulados en carriles exclusivos, estaciones en el separador, muchas motos y ciclovía los domingos.

## Decisiones tomadas

- Origen en la Plaza de Bolívar; la altura base (2.606 m) se resta para no perder precisión.
- Relieve de Copernicus GLO-30 suavizado: en la sabana se toma el mínimo local para quitar techos.
- Edificios de menos de 6 m² se descartan (casetas y errores del catastro).
- Altura de cada edificio = pisos × 3 m.
