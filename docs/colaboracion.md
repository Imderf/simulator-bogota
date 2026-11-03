# Cómo trabajamos en el repo

Somos dos trabajando en paralelo. Estas reglas evitan pisarnos.

1. **Antes de empezar**, traer lo último (`git fetch`) y leer lo que subió el otro.
2. **Una rama por tarea** y un pull request para entrar a `main`. El otro lo revisa.
3. **Nunca** `git push --force` ni reescribir historia en ramas compartidas.
4. **Volver a traer lo último** justo antes de empujar.
5. **Sin datos crudos pesados** en el repo: van en `tools/data/raw/`, que está en `.gitignore`. Se suben solo los archivos ya procesados que usa la simulación.
6. **Sin llaves ni rutas locales** en el código.
7. **Cada fuente nueva** se anota en [fuentes-de-datos.md](fuentes-de-datos.md) con su licencia.
