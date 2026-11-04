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

### Carros con forma real y estacionados (2026-11-03)

- Cuatro tipos armados en código (`js/vehiculos.js`): **taxi** compacto, **sedán**, **camioneta** y **pickup**. La carrocería sale de perfiles a lo largo del carro (piso con pasos de rueda, cintura, techo y anchos), con vidrios oscuros y sin interior. Detalles: farolas y pilotos que se encienden de noche, parrilla, espejos, bómperes y placas amarillas como las de Colombia.
- 520 carros estacionados a lado y lado de calles secundarias y locales alrededor de la plaza, con colores variados. Se dibujan con instancias: cuatro tipos en 16 llamadas a la GPU.
- Con E el jugador se sube al carro más cercano (estacionado o uno que dejó); el que suelta se queda donde lo dejó.

### Solo computador (2026-11-03)

En celular se muestra una pantalla que pide abrirlo en computador o activar «Sitio de escritorio», y no se descarga la ciudad. En modo escritorio el navegador se presenta como de escritorio y el simulador carga normal.

### Noche y calles (2026-11-03, Imderf)

Primeras mejoras tomadas de Slop New York tras la revisión de Imderf (se veía "tipo Minecraft" y la noche casi negra):

- **Noche legible**: postproceso con bloom (`RenderPipeline`), la exposición antes del bloom, luna azul con sombras, relleno azul, cielo nocturno en degradé y el cielo horneado como mapa de entorno (vidrios y metales ya reflejan).
- **Farolas** (`js/farolas.js`): postes con luminaria LED a lo largo de las vías; de noche las 32 más cercanas alumbran de verdad con `ClusteredLighting` y el resto brilla por el bombillo.
- **Ventanas sin parpadeo**: bordes suavizados al tamaño del píxel; de lejos se promedian. Luz cálida casi siempre y algunas oficinas con luz fría.
- **Vías de verdad** (`js/vias.js`): calzada con asfalto y parches, bordes blancos en avenidas, eje amarillo en las de doble sentido, líneas entre carriles en las de un sentido, cebras al llegar a los cruces, andenes con bordillo que se cortan en los cruces y carriles de TransMilenio en concreto.
- **Datos de vías BOV2**: sentido (`oneway`), carriles (`lanes`) y si son solo de buses (TransMilenio), más las calles peatonales separadas de los senderos. Para rehacer solo las vías: `node tools/construir-centro.mjs vias`.
- **El carro aparece en la calle** (`js/calles.js`): en el carril derecho de la calle de carros más cercana y en el sentido en que se maneja, nunca en la plaza. Alrededor de la Plaza de Bolívar las calles 10 y 11 y la Séptima son peatonales; el taxi del comienzo queda en la Calle 11, junto a la Catedral. El bordillo no deja subir el carro al andén ni a la plaza.

### Interfaz y recorrido (2026-11-03, Imderf)

Lo que más gustó de Slop New York, adaptado:

- **Barra de arriba**: Golden hour, Mediodía, Hora azul y Noche, con ajuste fino de la hora; arranca siempre a mediodía. Tour, sonido (N) y vista limpia (H).
- **Tour de 14 paradas** (`puntosDeVista` en `js/lugares.js`): Plaza de Bolívar, Casa de Nariño, Teatro Colón, Museo Botero y Luis Ángel Arango, Chorro de Quevedo, La Candelaria, Museo del Oro, Eje Ambiental, Quinta de Bolívar, Monserrate, Torre Colpatria, Museo Nacional, Planetario y Torres del Parque. Guadalupe, Bacatá y Avianca salen del menú (siguen en la ciudad). En vista libre la cámara vuela al lugar; en los demás modos el jugador aparece allí (el carro en el carril, a pie en el andén).
- **Cuatro modos** con teclas 1 a 4 y píldora amarilla: Caminar, Manejar, Bici (`js/bici.js`) y Volar en helicóptero (`js/helicoptero.js`). V vuelve a la vista libre. Tablero con velocidad en km/h y altura.
- **Personaje nuevo** (`js/personaje.js`): cuerpo suave por anillos (sin cajas), camina, corre y pedalea con los pies en los pedales.
- **Minimapa GPS** (`js/minimapa.js`) con las placas de las dos calles más cercanas; los nombres salen de OpenStreetMap a `datos/centro/nombres-vias.json`.
- **Sonido sintetizado** (`js/sonido.js`, sin archivos): ciudad, motor, bici, pasos, rotor, campanas cerca de la Catedral; B para el pito.
- **Piso de las calles** (`calles.piso`): personas, carros y postes se apoyan sobre la calzada o el andén, no sobre el terreno (antes quedaban hundidos medio metro).

### Tandas siguientes (2026-11-03, Imderf)

Publicadas una a una en `zona-centro` (ver los commits para el detalle):

- **Luz y materiales**: SunLight con sombras en cascada, reflejos en pantalla (SSR), gradación de cámara, bruma de la sabana, calles mojadas con charcos, resolución 1:1 con antialiasing.
- **Fachadas y carros**: fachada bogotana por shader con camino barato de lejos; carros de silueta suave con faros dibujados y sombra de contacto. Casas a nivel del andén en las lomas.
- **TransMilenio** (`js/transmilenio.js`, `datos/centro/transmilenio.json`): buses articulados y 27 estaciones; botón TransMilenio con la lista de estaciones (reemplaza a Hora azul).
- **Árboles con hojas** (`js/arboles.js`), sin los que caían sobre la calzada.
- **Suelo y agua** (`materialTerreno` en `js/terreno.js`, `js/agua.js`): grama, tierra, bosque, roca y páramo; agua con olas y reflejos.
- **Peatones y tráfico** (`js/peatones.js`, `js/trafico.js`): hasta 300 personas y 190 vehículos en hora pico, según la hora.
- **Plaza de Bolívar fiel** (`js/lugares.js`, fuentes en `docs/lugares.md`): estatua de Tenerani, losas, faroles, palomas, reflectores; `lugares.pisos` para que nadie se hunda.
- **Aeropuerto El Dorado** (`js/aeropuerto.js`, `datos/centro/aeropuerto.json`) con aviones que llegan y salen.
- **Atlas de Bogotá** (`js/minimapa.js`): mapa grande con buscador y clic para ir.
- **Viajes**: vuelo de cámara al cambiar de lugar en todos los modos; el helicóptero aparece a un costado y por encima de los techos (rayo hacia abajo).
- **Piso**: `calles.piso` mide en el eje de la vía y suma losas de lugares y estaciones.

En curso: fachadas al nivel de la referencia (vidrio con cuartos, rejas, avisos, balcones), vendedores ambulantes y mobiliario urbano, semáforos y física entre peatones y tráfico.

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
