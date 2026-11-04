# Peso: por qué carga rápido

Slop New York publica unos 3,2 MB sin comprimir (medido el 2026-11-03): código, datos y estilos. No trae ni una imagen, ni un modelo 3D, ni un archivo de sonido. Copiamos esa disciplina.

## Cómo lo logra Slop New York

1. **Cero archivos pesados.** Texturas, fachadas, ventanas y agua salen de shaders TSL y de `canvas` dibujados en el navegador. El sonido se sintetiza con Web Audio (osciladores y filtros). No hay `TextureLoader` ni `GLTFLoader`.
2. **La ciudad se construye en código al cargar.** Los edificios son plantas extruidas; los lugares famosos se arman con piezas simples y materiales propios.
3. **Datos en binario compacto, no en GeoJSON.** 37.353 edificios caben en 440 KB y 70.680 árboles en 123 KB:
   - coordenadas cuantizadas a 0,5 m y alturas a 1 m;
   - cada punto se guarda como diferencia con el anterior, en varint con zigzag (casi siempre 1 byte);
   - X, Z y los atributos van en flujos separados, para que gzip los comprima mejor;
   - el archivo va en `.bin.gz` y se descomprime con `DecompressionStream`.
4. **three.js desde CDN** (jsDelivr) con import map. No se sube al repo y el navegador lo guarda en caché.
5. **Sin paso de compilación.** Módulos ES servidos tal cual, con `modulepreload` para que bajen en paralelo.
6. **Rendimiento al dibujar.** `InstancedMesh` para todo lo repetido, geometrías fusionadas, recorte por celdas, sombras con geometrías simplificadas y niveles de detalle en los árboles.

## Nuestras reglas

- Nada de imágenes, modelos ni audio en la página. Si algo parece necesitarlo, se resuelve con shader, `canvas` o síntesis.
- Los datos crudos (`tools/data/raw/`) nunca se suben. Solo los binarios ya procesados.
- **Presupuesto de la zona Centro: 2 MB de datos comprimidos** en total (edificios, árboles, terreno, vías). Una prueba en `tests/` falla si se pasa.
- three.js siempre desde CDN con versión exacta.
