# Fuentes de datos

Consultadas contra sus servicios el 2026-11-03.

| Qué | Fuente | Qué trae | Licencia |
|---|---|---|---|
| Edificios | Catastro Bogotá, capa [Construcción](https://datosabiertos.bogota.gov.co/dataset/construccion) ([servicio REST](https://serviciosgis.catastrobogota.gov.co/arcgis/rest/services/catastro/construccion/MapServer/0)) | 2.422.631 polígonos con número de pisos (`CONNPISOS`), sótanos y código de lote | CC BY 4.0 |
| Altura por manzana | Catastro, [Número de pisos ponderado por manzana](https://datosabiertos.bogota.gov.co/dataset/numero-de-pisos-ponderado-por-manzana) | Pisos promedio por manzana | CC BY 4.0 |
| Árboles | Jardín Botánico de Bogotá, [Arbolado Urbano](https://datosabiertos.bogota.gov.co/dataset/censo-arbolado-urbano) ([servicio REST](https://geoportal.jbb.gov.co/agc/rest/services/IDECA/CensoArbol/FeatureServer/0)) | 1.472.431 puntos con especie y altura | CC BY 4.0 |
| Curvas de nivel | Catastro, [Curva de nivel](https://datosabiertos.bogota.gov.co/dataset/curva-de-nivel-bogota-d-c) | 1.575 líneas, muy gruesas para el terreno | CC BY 4.0 |
| Relieve | Copernicus DEM GLO-30, celdas `N04_00_W075` y `N04_00_W074` | Modelo de superficie a 30 m | Libre con atribución |
| Vías, parques, ríos, nombres | OpenStreetMap vía Overpass | Calles con nombre, ciclorrutas, humedales | ODbL |
| TransMilenio y SITP | [Datos abiertos de TransMilenio](https://datosabiertos-transmilenio.hub.arcgis.com/) | Estaciones troncales y paraderos | Por verificar |

## Cuidado con los datos

- El catastro tiene valores extremos raros. Ejemplo: un edificio de 46 pisos en Usaquén norte que no cuadra. Hay que revisar a mano los más altos.
- El campo `CONALTURA` viene en 0. La altura se calcula como pisos × altura por piso.
- Copernicus mide la superficie, no el suelo: incluye techos y árboles. En zonas construidas hay que suavizarlo.
- Una base derivada de OpenStreetMap que se redistribuya queda bajo ODbL. El código sigue siendo MIT.

## Por buscar

- Modelo de terreno del IGAC con mejor resolución.
- Trazado y estaciones de la línea 1 del Metro de Bogotá.
- Fotos de referencia con licencia libre para los lugares emblemáticos.
