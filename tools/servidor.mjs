// Servidor estático para desarrollo: sirve el repo sin caché para ver cada cambio al recargar.
// Uso: node tools/servidor.mjs [puerto]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = fileURLToPath(new URL('..', import.meta.url));
const PUERTO = Number(process.argv[2] || 8801);
const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.gz': 'application/octet-stream', '.svg': 'image/svg+xml',
};

http.createServer((req, res) => {
  const ruta = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const archivo = path.join(RAIZ, ruta.endsWith('/') ? ruta + 'index.html' : ruta);
  if (!archivo.startsWith(RAIZ) || archivo.includes(`${path.sep}tools${path.sep}data${path.sep}`)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(archivo, (err, datos) => {
    if (err) { res.writeHead(404).end('No encontrado'); return; }
    res.writeHead(200, { 'Content-Type': TIPOS[path.extname(archivo)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(datos);
  });
}).listen(PUERTO, '127.0.0.1', () => console.log(`Simulador Bogotá en http://127.0.0.1:${PUERTO}`));
