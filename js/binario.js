// Lector del formato binario que escribe tools/binario.mjs.

export async function cargarBinario(url, firma) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`No se pudo cargar ${url}: ${r.status}`);
  let datos = new Uint8Array(await r.arrayBuffer());
  // Algunos servidores mandan el .gz con Content-Encoding: gzip y el navegador ya lo descomprimió.
  if (datos[0] === 0x1f && datos[1] === 0x8b) {
    const flujo = new Response(datos).body.pipeThrough(new DecompressionStream('gzip'));
    datos = new Uint8Array(await new Response(flujo).arrayBuffer());
  }
  const vista = new DataView(datos.buffer);
  const leida = String.fromCharCode(...datos.subarray(0, 4));
  if (leida !== firma) throw new Error(`${url}: se esperaba ${firma} y llegó ${leida}`);
  const n = vista.getUint32(4, true);
  const flujos = [];
  let cursor = 8 + n * 4;
  for (let i = 0; i < n; i++) {
    const largo = vista.getUint32(8 + i * 4, true);
    flujos.push(lector(datos, cursor, cursor + largo));
    cursor += largo;
  }
  return flujos;
}

function lector(datos, inicio, fin) {
  let c = inicio;
  const uint = () => {
    let v = 0, s = 0, b;
    do {
      if (c >= fin) throw new Error('Datos cortados');
      b = datos[c++];
      v |= (b & 127) << s;
      s += 7;
    } while (b & 128);
    return v >>> 0;
  };
  return {
    uint,
    int: () => { const v = uint(); return (v >>> 1) ^ -(v & 1); },
    fin: () => c === fin,
  };
}
