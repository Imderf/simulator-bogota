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

### Rama `en-curso` (2026-11-04): física, fachadas, mobiliario y Monserrate — por revisar a la vista

Todo esto está en `en-curso` y **no se ha visto con GPU real**. En el contenedor se probó la lógica en node (`node tools/probar-fisica.mjs`, necesita `npm i --no-save three@0.187.0`) y los shaders y mallas nuevos en un navegador sin GPU (WebGL por software, no WebGPU: allí `readPixels` de WebGPU falla). Antes de publicar en `zona-centro`, abrirla en un navegador con WebGPU y mirar lo que sigue.

- **Semáforos, frenado y cruces** (`js/semaforos.js`, `js/trafico.js`, `js/peatones.js`): `node --check` limpio en todo `js/`. Prueba con las vías reales (855 cruces con semáforo, tráfico denso a las 8 h, 240 s simulados en cuatro sitios): las fases nunca dan verde cruzado ni verde al peatón con verde de los carros, ningún carro cruza la línea de pare en rojo, no hay NaN y hay a lo sumo un par de carros rozándose (penetración de 0,1 a 0,8 m, de un solo par por sitio). Sin cambios en esa lógica.
- **Monserrate y Circunvalar** (`js/vias.js`, `js/trafico.js`):
  - Las cintas de calzada, andén y senderos usaban la normal de cada tramo; en las curvas se abrían por fuera y se cruzaban por dentro. Ahora usan inglete por vértice (`ingletes`), recortado para que el borde de adentro no pase de la mitad del tramo más corto.
  - Las dos calzadas de un sentido de la Circunvalar dibujadas a menos de su ancho se pisaban (asfalto, andén y carriles). `separarCalzadas` les pone un `limite` de ancho igual a la distancia entre ejes y quita el andén del lado del separador; `anchoVia` y `andenVia` lo respetan, así que tráfico, semáforos y calles quedan de acuerdo.
  - En `armarRed` el carril desplazado usa el mismo recorte del inglete: el carril de adentro ya no hace lazo en una curva cerrada.
  - **Falta** (lo del diagnóstico del 2026-11-04): el bloqueo en el cruce de las aristas 8 y 307 (turnos/reserva) no se reprodujo en la simulación de node después del ajuste de calzadas, pero hay que confirmarlo en vivo; el parche que retira carros parados y solapados sigue ahí. El terreno de 32 m puede asomar por encima de la calzada del lado alto de la loma (hace falta un talud o aplanar el relieve junto a la vía). Y que el tour a Monserrate deje al jugador arriba, junto a la basílica.
- **Fachadas** (`js/edificios.js`, `js/detalles-edificios.js`): se mantienen el camino barato de lejos, el filtrado al tamaño del píxel y `fwidth` fuera de los `If`.
  - Vidrio con cuartos detrás (interior mapping): caja del ancho del vano y 4,2 m de fondo, con paredes, piso, techo, cuadro, mueble y bombillo por cuarto; de noche el bombillo alumbra el cuarto.
  - Relieve (`bumpNormal` de Mikkelsen, adaptado de Slop New York): pega hundida del ladrillo tolete, ventana metida en el muro, repisa, dintel, placas y cornisa.
  - La Candelaria a color (azul, ocre, rojo colonial, verde, amarillo, blanco, naranja) con zócalo oscuro del mismo tono, puertas y marcos de madera, y en 3D (`detalles-edificios.js`, dos mallas instanciadas): balcones de madera con baranda y aleros de teja, solo en muros que no son medianeras.
  - Ya estaban: locales en el primer piso, avisos de colores, cortinas metálicas de noche y rejas en las ventanas bajas de las casas.
  - **Falta**: nombres reales en los avisos; rejas en las vitrinas; tejado a dos aguas y chimeneas; medir el costo del shader en una GPU real (el detalle de cerca tiene ahora más ramas) y ajustar el brillo de los cuartos de noche con el bloom.
- **Mobiliario y vendedores** (`js/mobiliario.js`, integrado en `js/main.js` e `index.html`): una malla instanciada por tipo, sobre `calles.piso` y con círculo en `choques`. Canecas, bancas, bolardos, hidrantes, señales (pare, velocidad, prohibido parquear, ceda), 125 paraderos del SITP en avenidas, 165 placas de nomenclatura en cruces, 72 vallas y una pantalla LED que rota tres avisos (la segunda no encontró avenida cercana). Vendedores de día (5:30 a 20:30): tinto, frutas con sombrilla, obleas, mazorca (cuatro en la Plaza de Bolívar), chazas de dulces y minutos y empanadas, en la Séptima, la plaza, el Parque Santander, el Chorro de Quevedo, el Eje Ambiental y San Victorino. **Falta**: las placas muestran texto de ejemplo (CL 12, KR 7…), no el nombre real de la vía; la segunda pantalla LED; humo de la mazorca y vapor del tinto; que los vendedores se muevan o hablen; revisar a la vista que no queden sobre calzada.

Pendiente en general: semáforos y peatones se vieron solo por números, no en pantalla.

### Prioridad para la próxima sesión: tráfico en Monserrate (reporte de Imderf, 2026-11-03)

En la Avenida Carrera 5 Este / Avenida Carrera 5A Este, junto a la estación de abajo del teleférico y el funicular de Monserrate (x ≈ 1.680, z ≈ -520): dos carros (taxi amarillo y sedán blanco) quedan **montados uno sobre otro, lado a lado**, en una vía de doble sentido en pendiente; los carros **saltan** (cambios bruscos de altura) al subir; y la calzada queda como un escalón con el terreno por encima del andén. Revisar en js/trafico.js el desplazamiento de carril por sentido cuando la vía tiene 1 carril o ninguno declarado (los dos sentidos no pueden compartir el mismo carril), el suavizado de la altura de los vehículos sobre calles.piso en pendiente, y en js/vias.js la cinta en curvas cerradas con pendiente.

**Diagnóstico medido en vivo (2026-11-04, Imderf + Claude):** (1) En el cruce de las aristas 8 y 307 (x≈1770, z≈-456) un taxi y una camioneta llevan más de 70 s parados con los centros a 3,6 m (se pisan: hacen falta 4,05 m): es un bloqueo entre las dos calzadas que se juntan; lo que llega detrás se apila encima. (2) Hay 3-4 pares de carros que se solapan en movimiento: las dos calzadas de un solo sentido de la Av. Circunvalar (clase 1, 2 carriles, ancho 7 m) están dibujadas en OSM tan cerca que sus carriles se superponen en el espacio. (3) Los saltos de altura casi no existen (solo ~1 m en un par de carros). Ya está en esta rama un parche que retira carros parados que se solapan aunque se vean (js/trafico.js, bucle de retiro), pero no basta porque los nuevos reaparecen en el bloqueo. Falta: resolver el bloqueo del cruce (turnos/reserva), y separar o fusionar los carriles de calzadas paralelas muy cercanas (por ejemplo, un solo juego de carriles si dos vías de un sentido van a menos de ~6 m).

**Pista más fuerte (2026-11-04):** cuatro vehículos (bus, moto, camioneta, taxi) llevan más de 40 s parados en la línea de pare de la arista 3482 (x≈1615, z≈-524, cruce con semáforo, ePare 81,9) y todos tienen como `sig` (vehículo de adelante) al vehículo id 307, que NO está en `sim.vehiculos`. Sospecha, sin confirmar: un vehículo retirado sigue referenciado como líder y los de atrás lo esperan para siempre. Revisar `retirar()` y la asignación de `sig` en js/trafico.js (limpiar `sig`/`con` de quien apunte al retirado) y reproducir con `simulador.trafico.sim.vehiculos.filter(v => v.activo && v.espera > 15)` en la consola cerca de (1615,-524).

También: al elegir **Monserrate en el tour** caminando, el jugador aparece al pie del cerro (andén más cercano) sin ver la basílica. Que aparezca arriba, en la explanada junto a la basílica (lugares.js: basilicaMonserrate), mirando hacia ella, con la cámara que la muestre; en Manejar, en la vía de acceso más cercana con vista al cerro.

### Comparación con Slop New York (2026-11-04)

- Golden hour: corregida la oscuridad (relleno de luz con sol bajo).
- Rendimiento: 21-34 fps frente a 60-80 de la referencia en el mismo Chrome. Costos por grupo (Plaza de Bolívar): carros estacionados +6 fps al ocultarlos, detalle de edificios +4, edificios +3, vías +3; sombras de carros/tráfico/gente/mobiliario +4. Siguiente: medir con resolución menor, simplificar de lejos los shaders de terreno y asfalto, limitar los estacionados con pintura completa y probar SSR a un cuarto de resolución.

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
