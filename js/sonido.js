// Sonido del simulador, todo sintetizado con Web Audio: no hay archivos de audio. Ruidos, golpes y bucles se
// calculan una sola vez, la primera vez que hacen falta; después solo quedan vivas la ciudad, el viento y la voz
// del modo actual (carro, bici o helicóptero), que entra y sale con fundido.
//
// Adaptado de Slop New York (mrdoob, MIT): audio-synthesis.js (escape, rotor, turbina, rueda libre, cadena y las
// voces que los mueven), audio-events.js (pasos, bocina, ráfagas y viento) y audio-system.js (activar, silencio,
// compresor y pausa con la pestaña oculta).
//
// API:
//   const sonido = crearSonido();
//   sonido.activar();              // en el primer clic o tecla (política de autoplay)
//   sonido.silenciar(true|false);  // se guarda en localStorage 'bogota-sonido'
//   sonido.silenciado;             // boolean
//   sonido.actualizar(estado, dt); // cada cuadro
//   sonido.pito();                 // bocina del carro; en bici, el timbre
// estado = { modo, velocidad (m/s), noche 0..1, alto (m sobre el suelo), cercaPlaza 0..1, enTransMilenio 0..1,
//            cercaArboles 0..1 (opcional, 0,3 si falta), hora 0..24 (opcional, hora del reloj si falta) }

const TAU = Math.PI * 2;
const CLAVE = 'bogota-sonido';
const VOLUMEN = 0.5;
const finito = (v, d = 0) => (Number.isFinite(v) ? v : d);
const lim = (v, a = 0, b = 1) => Math.max(a, Math.min(b, finito(v)));
const suave = (v) => { const x = lim(v); return x * x * (3 - 2 * x); };
const alAzar = (lista) => lista[Math.floor(Math.random() * lista.length)];

// Generador repetible: los mismos sonidos en cada carga.
function azar(semilla) {
  let s = Math.imul(semilla, 2654435761) >>> 0 || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

// Los parámetros de los filtros se leen una vez por bloque (k-rate): basta y ahorra cálculo por muestra.
// Adaptado de Slop New York (mrdoob, MIT): audio-synthesis.js
function nuevoFiltro(ctx, tipo, frecuencia, q = 0.7) {
  const f = ctx.createBiquadFilter();
  for (const p of [f.frequency, f.detune, f.Q, f.gain]) if (p.automationRate !== undefined) p.automationRate = 'k-rate';
  f.type = tipo;
  f.frequency.value = frecuencia;
  f.Q.value = q;
  return f;
}

// Lleva un parámetro hacia un valor sin saltos. Ignora cambios mínimos para no llenar la línea de tiempo.
const ultimos = new WeakMap();
function ir(param, valor, t, tau = 0.08) {
  const antes = ultimos.get(param);
  if (antes !== undefined && Math.abs(antes - valor) <= Math.abs(valor) * 0.002 + 1e-4) return;
  ultimos.set(param, valor);
  param.cancelScheduledValues(t);
  param.setTargetAtTime(valor, t, tau);
}

// ---------------------------------------------------------------------------------------------------------------
// Buffers
// ---------------------------------------------------------------------------------------------------------------

// Sonido suelto: muestra a muestra, centrado, con fundidos cortos en los extremos y llevado a un pico fijo.
// Adaptado de Slop New York (mrdoob, MIT): audio-events.js
function suelto(ctx, dur, fn, pico = 0.6) {
  const sr = ctx.sampleRate, buf = ctx.createBuffer(1, Math.ceil(dur * sr), sr), d = buf.getChannelData(0);
  let media = 0, max = 0;
  for (let i = 0; i < d.length; i++) { d[i] = fn(i / sr, i); media += d[i]; }
  media /= d.length;
  for (let i = 0; i < d.length; i++) {
    const fundido = Math.min(1, i / (sr * 0.002), (d.length - 1 - i) / (sr * 0.012));
    d[i] = (d[i] - media) * fundido;
    max = Math.max(max, Math.abs(d[i]));
  }
  const k = max > 0 ? pico / max : 0;
  for (let i = 0; i < d.length; i++) d[i] *= k;
  return buf;
}

// Bucle de golpes sumados con vuelta al inicio: se centra y se nivela por energía, sin fundidos, para que empalme.
// Adaptado de Slop New York (mrdoob, MIT): audio-synthesis.js
function nivelar(buf, rms, techo = 0.9) {
  const d = buf.getChannelData(0);
  let media = 0, energia = 0, pico = 0;
  for (let i = 0; i < d.length; i++) media += d[i];
  media /= d.length;
  for (let i = 0; i < d.length; i++) {
    d[i] -= media;
    energia += d[i] * d[i];
    pico = Math.max(pico, Math.abs(d[i]));
  }
  const k = Math.min(techo / Math.max(pico, 1e-4), rms / Math.max(Math.sqrt(energia / d.length), 1e-4));
  for (let i = 0; i < d.length; i++) d[i] *= k;
  return buf;
}

// Ruido blanco de 2 s: la materia prima del tráfico, el viento, las llantas y el soplido del rotor.
function ruido(ctx) {
  const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), d = buf.getChannelData(0), r = azar(0x6e796361);
  for (let i = 0; i < d.length; i++) d[i] = r() * 2 - 1;
  return buf;
}

// Señal lenta y dispareja (no una onda seno) para las ráfagas del viento y las oleadas del tráfico.
// Adaptado de Slop New York (mrdoob, MIT): audio-events.js
function rafagas(ctx) {
  const sr = 8000, buf = ctx.createBuffer(1, sr * 24, sr), d = buf.getChannelData(0), r = azar(349);
  const rapido = Array.from({ length: 48 }, r), lento = Array.from({ length: 12 }, r);
  const curva = (nudos, pos) => {
    const i = Math.floor(pos), t = pos - i, n = nudos.length;
    const a = nudos[(i + n - 1) % n], b = nudos[i % n], c = nudos[(i + 1) % n], e = nudos[(i + 2) % n];
    return 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - e) * t * t + (-a + 3 * b - 3 * c + e) * t * t * t);
  };
  for (let i = 0; i < d.length; i++) {
    const f = i / d.length;
    d[i] = 0.38 + 0.54 * lim(curva(rapido, f * 48) * 0.36 + curva(lento, f * 12) * 0.64);
  }
  return buf;
}

// Escape de un motor pequeño de 4 cilindros: 20 ciclos completos a unas vueltas de referencia. Dos bancos (1.200 y
// 3.600 rpm) con la misma semilla comparten las fases de encendido y se mezclan sin desfase.
// Adaptado de Slop New York (mrdoob, MIT): audio-synthesis.js
function escape(ctx, rpm, semilla) {
  const sr = ctx.sampleRate, ciclos = 20, cil = 4;
  const largo = Math.round(ciclos * 120 / rpm * sr), buf = ctx.createBuffer(1, largo, sr), d = buf.getChannelData(0);
  const r = azar(semilla), ruidoR = azar(semilla ^ 0x65786861);
  const pesos = Array.from({ length: cil }, () => 0.83 + r() * 0.34);
  const dur = Math.round(sr * 0.048), intervalo = largo / (ciclos * cil);
  for (let k = 0; k < ciclos * cil; k++) {
    let i = (Math.round((k + (r() - 0.5) * 0.012) * intervalo) + largo) % largo;
    const peso = pesos[k % cil] * (0.92 + r() * 0.16), caida = 0.012 * (0.95 + r() * 0.1);
    let grave = 0;
    for (let j = 0; j < dur; j++) {
      const t = j / sr, blanco = ruidoR() * 2 - 1;
      grave += (blanco - grave) * 0.16;
      const ataque = 1 - Math.exp(-t / 0.00065), cola = Math.exp(-t / caida);
      // El pulso decae en segundos, no en ciclos: a altas vueltas no se vuelve un zumbido fino.
      const pulso = Math.exp(-t / 0.0022) - 0.36 * Math.exp(-t / 0.009);
      d[i] += peso * ataque * (pulso + Math.sin(TAU * 145 * t) * cola * 0.34 + grave * cola * 0.28);
      if (++i === largo) i = 0;
    }
  }
  return nivelar(buf, 0.3);
}

// Rotor de 4 palas: golpe de presión por pala y, aparte, la envolvente de su estela para modular el soplido.
// Adaptado de Slop New York (mrdoob, MIT): audio-synthesis.js
function rotor(ctx) {
  const sr = ctx.sampleRate, vueltas = 16, palas = 4, largo = Math.round(sr * vueltas / 5.2);
  const sonido = ctx.createBuffer(1, largo, sr), envolvente = ctx.createBuffer(1, largo, sr);
  const d = sonido.getChannelData(0), m = envolvente.getChannelData(0), r = azar(0x726f746f);
  const fuerzas = [1, 0.73, 0.96, 0.76], intervalo = largo / (vueltas * palas);
  for (let k = 0; k < vueltas * palas; k++) {
    let i = (Math.round((k + (r() - 0.5) * 0.012) * intervalo) + largo) % largo;
    const fuerza = fuerzas[k % palas] * (0.94 + r() * 0.12);
    let turbulencia = 0;
    for (let j = 0; j < sr * 0.085; j++) {
      const t = j / sr;
      turbulencia += (r() * 2 - 1 - turbulencia) * 0.24;
      const ataque = 1 - Math.exp(-t / 0.0003);
      const presion = (1 - t / 0.0032) * Math.exp(-t / 0.0032);
      const cuerpo = Math.sin(t * TAU * 52) * Math.exp(-t / 0.021) * 0.32;
      const tc = t - 0.005, chasquido = tc > 0 ? (1 - tc / 0.0008) * Math.exp(-tc / 0.0008) * 0.24 : 0;
      const estela = ataque * Math.exp(-t / 0.016);
      d[i] += fuerza * (presion * ataque + cuerpo + chasquido + turbulencia * estela * 0.42);
      m[i] += fuerza * estela;
      if (++i === largo) i = 0;
    }
  }
  let pico = 0;
  for (let i = 0; i < largo; i++) pico = Math.max(pico, m[i]);
  for (let i = 0; i < largo; i++) m[i] /= pico;
  return { sonido: nivelar(sonido, 0.29), envolvente };
}

// Turbina: dos tonos cercanos que baten despacio, con ciclos enteros en 2 s para que el bucle empalme.
// Adaptado de Slop New York (mrdoob, MIT): audio-synthesis.js
function turbina(ctx) {
  const sr = ctx.sampleRate, buf = ctx.createBuffer(1, sr * 2, sr), d = buf.getChannelData(0), r = azar(0x74757262);
  let grave = 0;
  for (let i = 0; i < d.length; i++) {
    const t = i / sr, n = r() * 2 - 1, aleteo = Math.sin(TAU * 23 * t) * 0.12;
    grave += (n - grave) * 0.18;
    d[i] = Math.sin(TAU * 1580 * t + aleteo) * 0.3 + Math.sin(TAU * 1593 * t - aleteo) * 0.24
      + Math.sin(TAU * 3160 * t + aleteo * 2) * 0.12 + Math.sin(TAU * 790 * t) * 0.08 + (n - grave) * 0.25;
  }
  return nivelar(buf, 0.22, 0.8);
}

// Rueda libre: 60 uñas por segundo a velocidad de referencia, cada una un golpe seco un poco distinto.
// Adaptado de Slop New York (mrdoob, MIT): audio-synthesis.js
function trinquete(ctx) {
  const sr = ctx.sampleRate, largo = sr * 2, buf = ctx.createBuffer(1, largo, sr), d = buf.getChannelData(0);
  const r = azar(0x7061776c), dientes = 120;
  for (let k = 0; k < dientes; k++) {
    let i = (Math.round((k + (r() - 0.5) * 0.18) / dientes * largo) + largo) % largo;
    const fuerza = 0.65 + r() * 0.35, caida = 0.00035 + r() * 0.0002;
    let previo = 0;
    for (let j = 0; j < sr * 0.0024; j++) {
      const t = j / sr, n = r() * 2 - 1;
      d[i] += (n - previo * 0.8) * fuerza * (1 - Math.exp(-t / 0.00004)) * Math.exp(-t / caida);
      previo = n;
      if (++i === largo) i = 0;
    }
  }
  return nivelar(buf, 0.15, 0.85);
}

// Cadena: una vuelta de pedal a 60 rpm, eslabones alternos y dos empujes por vuelta.
// Adaptado de Slop New York (mrdoob, MIT): audio-synthesis.js
function cadena(ctx) {
  const sr = ctx.sampleRate, buf = ctx.createBuffer(1, sr, sr), d = buf.getChannelData(0), r = azar(0x63686169);
  const dientes = 48;
  for (let k = 0; k < dientes; k++) {
    const fase = k / dientes * TAU, empuje = 0.72 - Math.cos(fase * 2) * 0.18 + Math.sin(fase) * 0.06;
    const fuerza = empuje * (k % 2 ? 0.88 : 1) * (0.92 + r() * 0.16);
    let i = (Math.round((k + (r() - 0.5) * 0.1) / dientes * d.length) + d.length) % d.length;
    let previo = 0;
    for (let j = 0; j < sr * 0.003; j++) {
      const t = j / sr, n = r() * 2 - 1;
      d[i] += (n - previo * 0.65) * fuerza * (1 - Math.exp(-t / 0.00006)) * Math.exp(-t / 0.00045);
      previo = n;
      if (++i === d.length) i = 0;
    }
  }
  return nivelar(buf, 0.16, 0.8);
}

// Pisada en el andén: talón y planta con colores distintos y luego la arenilla; sin golpe con tono.
// Adaptado de Slop New York (mrdoob, MIT): audio-events.js
function pisada(ctx, semilla) {
  const r = azar(semilla);
  const tPlanta = 0.024 + r() * 0.035, tRoce = tPlanta + 0.025 + r() * 0.025;
  const granos = Array.from({ length: 5 }, () => ({ t: r() * 0.1, caida: 170 + r() * 300, nivel: 0.025 + r() * 0.075 }));
  const coef = [180, 1050, 4600].map((f) => 1 - Math.exp(-TAU * f / ctx.sampleRate));
  const bandas = [0, 0, 0];
  return suelto(ctx, 0.23, (t) => {
    const n = r() * 2 - 1;
    for (let i = 0; i < 3; i++) bandas[i] += (n - bandas[i]) * coef[i];
    const cuerpo = bandas[1] - bandas[0], arena = bandas[2] - bandas[1];
    const talon = (1 - Math.exp(-t * 1900)) * Math.exp(-t * 105);
    const p = Math.max(0, t - tPlanta), planta = (1 - Math.exp(-p * 1100)) * Math.exp(-p * 58);
    const q = Math.max(0, t - tRoce), roce = (1 - Math.exp(-q * 130)) * Math.exp(-q * 38);
    let sueltos = 0;
    for (const g of granos) if (t > g.t) sueltos += Math.exp(-(t - g.t) * g.caida) * g.nivel;
    return (bandas[0] * 0.25 + cuerpo * 0.9 + arena * 0.55) * talon
      + (bandas[0] * 0.3 + cuerpo * 0.65 + arena * 0.15) * planta
      + (arena * 0.22 + (n - bandas[2]) * 0.035) * roce + arena * sueltos;
  }, 0.55);
}

// Bocina de carro: dos lengüetas desafinadas con armónicos, que tardan un instante en asentarse.
// Adaptado de Slop New York (mrdoob, MIT): audio-events.js
function bocina(ctx, dur, semilla) {
  const r = azar(semilla), sr = ctx.sampleRate;
  const frecuencias = [365 + r() * 45, 465 + r() * 55], fases = [r(), r()], retraso = 0.006 + r() * 0.009;
  const armonicos = [0.52, 1, 0.65, 0.37, 0.24, 0.14, 0.085];
  let aleteo = 0, aire = 0;
  return suelto(ctx, dur, (t) => {
    const n = r() * 2 - 1;
    aleteo += (n - aleteo) * 0.008;
    aire += (n - aire) * 0.24;
    let tono = 0;
    for (let k = 0; k < 2; k++) {
      const local = Math.max(0, t - k * retraso), ataque = 1 - Math.exp(-local * (k ? 160 : 230));
      fases[k] += frecuencias[k] * (1 - 0.065 * Math.exp(-local * 65) + aleteo * 0.045 + Math.sin(local * 71 + k) * 0.0025) / sr;
      let zumbido = 0;
      for (let a = 0; a < armonicos.length; a++) zumbido += Math.sin(TAU * fases[k] * (a + 1)) * armonicos[a];
      tono += zumbido * ataque * (k ? 0.83 : 1);
    }
    return (tono * (0.95 + aleteo * 0.6) + aire * 0.17 + (n - aire) * Math.exp(-t * 55) * 0.6) * suave((dur - t) / 0.045);
  }, 0.7);
}

// Timbre de bicicleta: dos golpes rápidos sobre una campanita de parciales inarmónicos.
function timbre(ctx) {
  const parciales = [[1, 1, 0.45], [1.006, 0.6, 0.45], [1.51, 0.45, 0.25], [2.17, 0.3, 0.16], [2.79, 0.18, 0.1]];
  return suelto(ctx, 1.2, (t) => {
    let s = 0;
    for (const [inicio, fuerza] of [[0, 1], [0.15, 0.8]]) {
      const u = t - inicio;
      if (u >= 0) for (const [k, a, tau] of parciales) s += Math.sin(TAU * 2350 * k * u) * a * fuerza * Math.exp(-u / tau);
    }
    return s;
  }, 0.6);
}

// Moto de 125 cc (la de domicilios): un cilindro, cambios rápidos y Doppler al pasar. Devuelve también la curva de
// panorama del paso, para moverla de un lado al otro.
function moto(ctx, semilla) {
  const r = azar(semilla), sr = ctx.sampleRate, dur = 3.6;
  const cruce = 1.6 + r() * 0.4, vel = 11 + r() * 5, lado = 5 + r() * 6, desfase = r(), periodo = 1.1 + r() * 0.5;
  let fase = 0, rpm = 6000, tono = 0, x1 = 0, y1 = 0;
  const b = suelto(ctx, dur, (t) => {
    const x = vel * (t - cruce), dist = Math.hypot(x, lado), doppler = 343 / (343 + vel * x / dist);
    // Acelera, cambia (caída brusca de vueltas) y vuelve a acelerar.
    rpm += (5200 + 3200 * ((t / periodo + desfase) % 1) - rpm) * 0.003;
    fase += rpm / 120 * doppler / sr; // 4 tiempos: una explosión cada dos vueltas
    const p = fase % 1, n = r() * 2 - 1;
    const pulso = Math.exp(-p * 9) + n * Math.exp(-p * 5) * 0.35;
    // Más lejos, más apagada: el corte del paso bajo sube al acercarse.
    tono += (pulso - tono) * (1 - Math.exp(-TAU * (500 + 2500 * lado / dist) / sr));
    const y = tono - x1 + 0.995 * y1; // quita el componente continuo del tren de pulsos
    x1 = tono; y1 = y;
    return y * (lado / dist) * suave(t / 0.5) * suave((dur - t) / 0.5);
  }, 0.6);
  const curva = Float32Array.from({ length: 16 }, (_, i) => { const x = vel * (i / 15 * dur - cruce); return 0.85 * x / Math.hypot(x, lado); });
  return { b, curva };
}

// Copetón (Zonotrichia capensis): dos o tres silbidos limpios y un trino rápido al final, entre 3 y 6 kHz.
function copeton(ctx, semilla) {
  const r = azar(semilla), base = 3300 + r() * 900, notas = [];
  let t = 0.02;
  const nota = (dur, f0, f1, pausa) => { notas.push({ t0: t, dur, f0, f1 }); t += dur + pausa; };
  nota(0.22 + r() * 0.1, base * 1.3, base * 0.95, 0.06);
  nota(0.26 + r() * 0.12, base * 0.92, base * 1.22, 0.05);
  if (r() < 0.5) nota(0.18, base * 1.2, base, 0.05);
  const trino = base * (1.35 + r() * 0.2), cuantas = 5 + Math.floor(r() * 7);
  for (let i = 0; i < cuantas; i++) nota(0.028, trino, trino * 0.82, 0.018);
  let fase = 0, k = 0;
  return suelto(ctx, t + 0.03, (s) => {
    while (k < notas.length - 1 && s >= notas[k].t0 + notas[k].dur) k++;
    const n = notas[k], u = (s - n.t0) / n.dur;
    if (u < 0 || u > 1) return 0;
    fase += (n.f0 + (n.f1 - n.f0) * u) / ctx.sampleRate;
    return (Math.sin(TAU * fase) + Math.sin(2 * TAU * fase) * 0.06) * Math.sin(Math.PI * u) ** 0.7;
  }, 0.5);
}

// Campana mayor de la Catedral: parciales de campana (hum, prima, tercera menor, quinta, nominal con batido) que
// se apagan a ritmos distintos, más el golpe del badajo.
function campana(ctx) {
  const prima = 146.8; // re3
  const parciales = [[0.5, 0.35, 4.5], [1, 0.45, 3.2], [1.19, 0.5, 2.6], [1.5, 0.18, 1.8], [2, 0.55, 2.2],
    [2.008, 0.3, 2.2], [2.52, 0.18, 1.1], [3.01, 0.16, 0.9], [4.07, 0.1, 0.6], [5.3, 0.06, 0.35]];
  const r = azar(5);
  let badajo = 0;
  return suelto(ctx, 5, (t) => {
    let s = 0;
    for (const [k, a, tau] of parciales) s += Math.sin(TAU * prima * k * t) * a * Math.exp(-t / tau);
    badajo += (r() * 2 - 1 - badajo) * 0.25;
    return (s + badajo * Math.exp(-t * 90) * 0.8) * suave((5 - t) / 1.2);
  }, 0.6);
}

// Bus articulado que llega a la estación: chirrido de frenos que crece hasta detenerse y rumor de llantas.
function frenado(ctx) {
  const r = azar(91), coef = 1 - Math.exp(-TAU * 160 / ctx.sampleRate);
  let grave = 0;
  return suelto(ctx, 1.9, (t) => {
    grave += (r() * 2 - 1 - grave) * coef;
    const chirrido = Math.sin(TAU * (900 * t - 25 * t * t) + 0.6 * Math.sin(TAU * 6 * t)) * suave(t / 1.3) * suave((1.6 - t) / 0.06);
    return chirrido * 0.3 + grave * 6 * suave((1.65 - t) / 0.5);
  }, 0.5);
}

// Escape de aire de frenos y puertas: un soplido agudo que se apaga.
function aire(ctx) {
  const r = azar(77);
  let bajo = 0;
  return suelto(ctx, 1.2, (t) => {
    const n = r() * 2 - 1;
    bajo += (n - bajo) * 0.3;
    return (n - bajo) * (1 - Math.exp(-t * 120)) * Math.exp(-t * 3.2);
  }, 0.5);
}

// Aviso de puertas: seis pitidos cortos y parejos.
function puertas(ctx) {
  return suelto(ctx, 1.45, (t) => {
    const k = t % 0.25;
    if (k > 0.12) return 0;
    return (Math.sin(TAU * 2050 * t) + Math.sin(TAU * 4100 * t) * 0.15) * suave(k / 0.008) * suave((0.12 - k) / 0.012);
  }, 0.5);
}

// Se calculan la primera vez que se piden: así el primer clic no congela la pantalla con todo a la vez.
const RECURSOS = {
  ruido, rafagas, rotor, turbina, trinquete, cadena, timbre, campana, frenado, aire, puertas,
  escapeBajo: (c) => escape(c, 1200, 0x74617869),
  escapeAlto: (c) => escape(c, 3600, 0x74617869),
  pisadas: (c) => Array.from({ length: 6 }, (_, i) => pisada(c, i + 1)),
  pito: (c) => bocina(c, 0.32, 7),
  bocinas: (c) => [0.16, 0.3, 0.55].map((d, i) => bocina(c, d, 17 + i)),
  motos: (c) => [moto(c, 3), moto(c, 8)],
  copetones: (c) => Array.from({ length: 4 }, (_, i) => copeton(c, 40 + i)),
};

// ---------------------------------------------------------------------------------------------------------------
// Voces continuas del jugador
// ---------------------------------------------------------------------------------------------------------------

// Bucles, filtros y ganancias propios. Entra con fundido; al soltarla se apaga, se detiene y se desconecta sola.
function crearVoz(ctx, salida) {
  const nodos = [], fuentes = [];
  const propio = (n) => { nodos.push(n); return n; };
  const mezcla = propio(ctx.createGain());
  mezcla.gain.value = 0;
  mezcla.connect(salida);
  return {
    mezcla,
    ganancia(v = 0) { const g = propio(ctx.createGain()); g.gain.value = v; return g; },
    filtro(tipo, f, q) { return propio(nuevoFiltro(ctx, tipo, f, q)); },
    bucle(buf) { const s = propio(ctx.createBufferSource()); s.buffer = buf; s.loop = true; fuentes.push(s); return s; },
    arrancar(t) {
      // Misma fracción de arranque en todos los bucles: los bancos del escape y el rotor siguen en fase.
      const f = Math.random();
      fuentes.forEach((s) => s.start(t, f * s.buffer.duration));
      mezcla.gain.setTargetAtTime(1, t, 0.3);
    },
    soltar(t) {
      mezcla.gain.cancelScheduledValues(t);
      mezcla.gain.setTargetAtTime(0, t, 0.25);
      fuentes[0].onended = () => nodos.forEach((n) => n.disconnect());
      fuentes.forEach((s) => s.stop(t + 1.5));
    },
  };
}

// Carro (taxi pequeño, caja mecánica de 5). Sin el pedal a la mano, la carga se deduce de la aceleración y de la
// velocidad sostenida. Adaptado de Slop New York (mrdoob, MIT): audio-synthesis.js
function vozCarro(ctx, rec, salida) {
  const v = crearVoz(ctx, salida);
  const bajo = v.bucle(rec('escapeBajo')), alto = v.bucle(rec('escapeAlto'));
  const gBajo = v.ganancia(1), gAlto = v.ganancia(0), fEscape = v.filtro('lowpass', 600, 0.65), gEscape = v.ganancia();
  bajo.connect(gBajo).connect(fEscape);
  alto.connect(gAlto).connect(fEscape);
  fEscape.connect(gEscape).connect(v.mezcla);
  const calle = v.bucle(rec('ruido')), fAltos = v.filtro('highpass', 120, 0.5), fBajos = v.filtro('lowpass', 1000, 0.5), gCalle = v.ganancia();
  calle.connect(fAltos).connect(fBajos).connect(gCalle).connect(v.mezcla);
  const MARCHAS = [520, 330, 235, 178, 142]; // rpm por cada m/s
  const RALENTI = 820;
  let marcha = 0, rpm = RALENTI, acel = 0, velAnt = 0, bloqueo = 0, cambio = 0;
  v.actualizar = (vel, _alto, dt, t) => {
    acel += ((vel - velAnt) / dt - acel) * Math.min(1, dt * 5);
    velAnt = vel;
    const carga = lim(acel / 3 + vel / 45);
    if (vel < 0.5) marcha = 0;
    else if (t >= bloqueo) {
      const vueltas = vel * MARCHAS[marcha];
      if (marcha < MARCHAS.length - 1 && vueltas > 2600 + carga * 2200) { marcha++; bloqueo = t + 0.9; cambio = t + 0.3; }
      else if (marcha > 0 && vueltas < 1300) { marcha--; bloqueo = t + 0.9; }
    }
    // Al arrancar el embrague patina y las vueltas suben antes que la velocidad.
    const objetivo = lim(Math.max(RALENTI, vel * MARCHAS[marcha]) + carga * 1400 * Math.max(0.1, 1 - vel / 6), RALENTI, 6000);
    rpm += (objetivo - rpm) * (1 - Math.exp(-dt / (objetivo > rpm ? 0.15 : 0.09)));
    // En el cambio se suelta el acelerador un instante: el escape se apaga y las vueltas caen a la marcha nueva.
    const enCambio = t < cambio, esfuerzo = enCambio ? 0.03 : Math.min(1, carga + vel * 0.004), rapidez = enCambio ? 0.02 : 0.07;
    ir(bajo.playbackRate, rpm / 1200, t, 0.05);
    ir(alto.playbackRate, rpm / 3600, t, 0.05);
    const banco = suave((rpm - 1200) / 2400);
    ir(gBajo.gain, Math.cos(banco * Math.PI / 2), t, 0.07);
    ir(gAlto.gain, Math.sin(banco * Math.PI / 2), t, 0.07);
    ir(fEscape.frequency, 650 + rpm * 0.24 + esfuerzo * 1800, t, rapidez);
    ir(gEscape.gain, 0.2 + esfuerzo * 0.35, t, rapidez);
    const rodar = Math.min(1.3, vel / 25);
    ir(gCalle.gain, rodar ** 1.25 * 0.12, t, 0.18);
    ir(fBajos.frequency, 900 + Math.min(1, rodar) * 1000, t, 0.18);
  };
  return v;
}

// Bici: llanta en el asfalto, cadena al pedalear y rueda libre al dejar de pedalear.
// Adaptado de Slop New York (mrdoob, MIT): audio-synthesis.js
function vozBici(ctx, rec, salida) {
  const v = crearVoz(ctx, salida);
  const llanta = v.bucle(rec('ruido')), fAltos = v.filtro('highpass', 80, 0.6), fLlanta = v.filtro('lowpass', 650, 0.65), gLlanta = v.ganancia();
  llanta.connect(fAltos).connect(fLlanta).connect(gLlanta).connect(v.mezcla);
  const libre = v.bucle(rec('trinquete')), fLibre = v.filtro('bandpass', 3500, 0.5), gLibre = v.ganancia();
  libre.connect(fLibre).connect(gLibre).connect(v.mezcla);
  const eslabones = v.bucle(rec('cadena')), fCadena = v.filtro('bandpass', 2800, 0.5), gCadena = v.ganancia();
  eslabones.connect(fCadena).connect(gCadena).connect(v.mezcla);
  let velAnt = 0, acel = 0;
  v.actualizar = (vel, _alto, dt, t) => {
    acel += ((vel - velAnt) / dt - acel) * Math.min(1, dt * 5);
    velAnt = vel;
    // Sin el pedal a la vista: si no va perdiendo velocidad, pedalea; si la pierde, rueda libre.
    const pedalea = acel > -0.15, mov = Math.min(1.25, vel / 10), rueda = Math.min(1, vel / 2);
    ir(gLlanta.gain, mov ** 1.35 * 0.04, t, 0.15);
    ir(fLlanta.frequency, 250 + Math.min(1, mov) * 450, t, 0.15);
    // Ruedas de 35 cm de radio, 18 uñas en el piñón libre y 3,2 vueltas de rueda por pedalazo.
    ir(gLibre.gain, pedalea ? 0 : rueda * 0.22, t, 0.035);
    ir(libre.playbackRate, Math.max(0.01, vel * 18 / (TAU * 0.35 * 60)), t, 0.05);
    ir(gCadena.gain, pedalea ? rueda * (0.015 + lim(acel / 1.5) * 0.025) : 0, t, 0.05);
    ir(eslabones.playbackRate, Math.max(0.01, vel / (TAU * 0.35 * 3.2)), t, 0.05);
  };
  return v;
}

// Helicóptero: golpeteo del rotor, soplido de las palas y turbina. La potencia sale de la subida y la aceleración.
// Adaptado de Slop New York (mrdoob, MIT): audio-synthesis.js
function vozHeli(ctx, rec, salida) {
  const v = crearVoz(ctx, salida), helice = rec('rotor');
  const golpe = v.bucle(helice.sonido), fGolpe = v.filtro('lowpass', 1500, 0.5), gGolpe = v.ganancia();
  golpe.connect(fGolpe).connect(gGolpe).connect(v.mezcla);
  const soplido = v.bucle(rec('ruido')), fSoplido = v.filtro('lowpass', 1400, 0.5), gSoplido = v.ganancia();
  soplido.connect(fSoplido).connect(gSoplido).connect(v.mezcla);
  // La estela de cada pala modula el soplido con la misma fase del golpeteo.
  const estela = v.bucle(helice.envolvente), gEstela = v.ganancia();
  estela.connect(gEstela).connect(gSoplido.gain);
  const silbido = v.bucle(rec('turbina')), fSilbido = v.filtro('bandpass', 2400, 0.55), gSilbido = v.ganancia();
  silbido.connect(fSilbido).connect(gSilbido).connect(v.mezcla);
  let altoAnt = null, velAnt = 0, subida = 0, acel = 0;
  v.actualizar = (vel, alto, dt, t) => {
    const k = Math.min(1, dt * 3);
    subida += ((altoAnt === null ? 0 : (alto - altoAnt) / dt) - subida) * k;
    acel += ((vel - velAnt) / dt - acel) * k;
    altoAnt = alto;
    velAnt = vel;
    const vuelo = Math.min(1, vel / 40);
    const carga = lim(0.3 + subida * 0.07 + Math.max(0, acel) * 0.05 + vuelo * 0.25);
    const bajada = lim(-subida / 8) * (1 - vuelo * 0.6); // bajar despacio hace sonar más las palas
    // Un rotor gobernado casi no cambia de vueltas: cambia la fuerza del golpe y del soplido.
    const tasa = 0.994 - carga * 0.012 + vuelo * 0.004;
    ir(golpe.playbackRate, tasa, t, 0.3);
    ir(estela.playbackRate, tasa, t, 0.3);
    ir(gGolpe.gain, 0.32 + carga * 0.18 + bajada * 0.12 + vuelo * 0.025, t, 0.22);
    ir(fGolpe.frequency, 1150 + carga * 700 + bajada * 1800, t, 0.22);
    ir(gSoplido.gain, 0.022 + carga * 0.025, t, 0.22);
    ir(gEstela.gain, 0.18 + carga * 0.25 + bajada * 0.25, t, 0.22);
    ir(fSoplido.frequency, 800 + carga * 650 + vuelo * 900, t, 0.25);
    ir(fSilbido.frequency, 2000 + carga * 900, t, 0.25);
    ir(gSilbido.gain, 0.055 + carga * 0.055, t, 0.22);
    ir(silbido.playbackRate, 0.92 + carga * 0.16, t, 0.4);
  };
  return v;
}

const VOCES = { manejar: vozCarro, bici: vozBici, volar: vozHeli };

// ---------------------------------------------------------------------------------------------------------------
// Capas de ambiente
// ---------------------------------------------------------------------------------------------------------------

// Rumor de ciudad: tráfico lejano (grave) y siseo de llantas, con oleadas lentas como semáforos que cambian.
function capaCiudad(ctx, rec, salida) {
  const fuente = ctx.createBufferSource();
  fuente.buffer = rec('ruido');
  fuente.loop = true;
  const grave = nuevoFiltro(ctx, 'lowpass', 320, 0.5), siseo = nuevoFiltro(ctx, 'bandpass', 1000, 0.5);
  const gGrave = ctx.createGain(), gSiseo = ctx.createGain(), olas = ctx.createGain();
  gGrave.gain.value = gSiseo.gain.value = olas.gain.value = 0;
  const lfo = ctx.createBufferSource();
  lfo.buffer = rec('rafagas');
  lfo.loop = true;
  lfo.playbackRate.value = 0.35;
  fuente.connect(grave).connect(gGrave).connect(olas);
  fuente.connect(siseo).connect(gSiseo).connect(olas);
  lfo.connect(olas.gain);
  olas.connect(salida);
  fuente.start(0, 0.41);
  lfo.start();
  return (dia, cerca, t) => {
    ir(gGrave.gain, 1.4 * dia * (0.7 + 0.3 * cerca), t, 0.8);
    ir(grave.frequency, 220 + 100 * cerca, t, 0.8);
    ir(gSiseo.gain, 0.12 * dia * cerca, t, 0.8);
  };
}

// Viento: dos canales de ruido con ráfagas propias, a lado y lado.
// Adaptado de Slop New York (mrdoob, MIT): audio-events.js
function capaViento(ctx, rec, salida) {
  const canales = [-0.7, 0.7].map((pan, i) => {
    const fuente = ctx.createBufferSource(), rafaga = ctx.createBufferSource();
    fuente.buffer = rec('ruido');
    rafaga.buffer = rec('rafagas');
    fuente.loop = rafaga.loop = true;
    rafaga.playbackRate.value = i ? 0.79 : 1;
    const f = nuevoFiltro(ctx, 'lowpass', 1000, 0.4), g = ctx.createGain(), mod = ctx.createGain(), p = ctx.createStereoPanner();
    g.gain.value = mod.gain.value = 0;
    p.pan.value = pan;
    fuente.connect(f).connect(g).connect(mod).connect(p).connect(salida);
    rafaga.connect(mod.gain);
    fuente.start(0, 0.9 + i * 0.6);
    rafaga.start(0, i * 8.9);
    return { f, g };
  });
  return (nivel, corte, t) => {
    for (const c of canales) { ir(c.g.gain, nivel, t, 0.6); ir(c.f.frequency, corte, t, 0.8); }
  };
}

const horaReal = () => { const d = new Date(); return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600; };

// ---------------------------------------------------------------------------------------------------------------
// Sistema
// ---------------------------------------------------------------------------------------------------------------

export function crearSonido() {
  let silenciado = false;
  try { silenciado = localStorage.getItem(CLAVE) === 'off'; } catch { /* almacenamiento bloqueado: suena por defecto */ }
  let ctx = null, roto = false, rec, mezcla, maestro, ambiente, filtroAmb, voces, ciudad, viento;
  let modoActual = null, voz = null, acumulado = 0, fasePaso = 0.7, pitoHasta = 0;
  let horaAnt = null, campanadas = 0, proxCampana = 0;
  const prox = { pito: 2, moto: 4, pajaro: 1.5, bus: 3 };

  function construir() {
    const Contexto = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Contexto) { roto = true; return; }
    ctx = new Contexto({ latencyHint: 'interactive' });
    const memo = {};
    rec = (nombre) => (memo[nombre] ??= RECURSOS[nombre](ctx));
    mezcla = ctx.createGain();
    const compresor = ctx.createDynamicsCompressor();
    compresor.threshold.value = -18;
    compresor.knee.value = 12;
    compresor.ratio.value = 4;
    compresor.attack.value = 0.005;
    compresor.release.value = 0.25;
    maestro = ctx.createGain();
    maestro.gain.value = 0;
    maestro.gain.setTargetAtTime(VOLUMEN, ctx.currentTime, 0.6);
    mezcla.connect(compresor).connect(maestro).connect(ctx.destination);
    // La calle pasa por un paso bajo: dentro del carro o de la cabina se oye apagada.
    ambiente = ctx.createGain();
    filtroAmb = nuevoFiltro(ctx, 'lowpass', 16000, 0.5);
    ambiente.connect(filtroAmb).connect(mezcla);
    voces = ctx.createGain();
    voces.gain.value = 1.2;
    voces.connect(mezcla);
    ciudad = capaCiudad(ctx, rec, ambiente);
    viento = capaViento(ctx, rec, mezcla);
    // Con la pestaña oculta el bucle de dibujo se detiene: el audio también, para que no quede zumbando.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) ctx.suspend().catch(() => {});
      else if (!silenciado) ctx.resume().catch(() => {});
    });
  }

  function activar() {
    if (silenciado || roto) return;
    if (!ctx) {
      try { construir(); } catch (e) {
        console.warn('[sonido] No se pudo iniciar el audio', e);
        ctx?.close().catch(() => {});
        ctx = null;
        roto = true;
      }
      if (!ctx) return;
    }
    if (ctx.state !== 'running' && !document.hidden) ctx.resume().catch(() => {}); // otro gesto puede reintentar
  }

  function silenciar(si = true) {
    silenciado = !!si;
    try { localStorage.setItem(CLAVE, silenciado ? 'off' : 'on'); } catch { /* sin almacenamiento: dura la sesión */ }
    if (!ctx) { activar(); return; }
    const t = ctx.currentTime;
    maestro.gain.cancelScheduledValues(t);
    maestro.gain.setTargetAtTime(silenciado ? 0 : VOLUMEN, t, 0.08);
    // Se suspende tras el fundido; si alguien quitó el silencio entretanto, no.
    if (silenciado) setTimeout(() => { if (silenciado) ctx.suspend().catch(() => {}); }, 400);
    else activar();
  }

  // Sonido suelto: fuente → (paso bajo) → volumen → panorama → destino. Se desconecta solo al terminar.
  function sonar(buf, { t = ctx.currentTime, vol = 1, tasa = 1, pan = 0, curvaPan = null, corte = 0, destino = ambiente } = {}) {
    const fuente = ctx.createBufferSource();
    fuente.buffer = buf;
    fuente.playbackRate.value = tasa;
    const nodos = [fuente];
    if (corte) { const f = ctx.createBiquadFilter(); f.frequency.value = corte; nodos.push(f); }
    const g = ctx.createGain();
    g.gain.value = vol;
    const p = ctx.createStereoPanner();
    if (curvaPan) p.pan.setValueCurveAtTime(curvaPan, t, buf.duration / tasa);
    else p.pan.value = pan;
    nodos.push(g, p);
    for (let i = 1; i < nodos.length; i++) nodos[i - 1].connect(nodos[i]);
    p.connect(destino);
    fuente.onended = () => nodos.forEach((n) => n.disconnect());
    fuente.start(t);
  }

  function pito() {
    if (!ctx || ctx.state !== 'running' || ctx.currentTime < pitoHasta) return;
    if (modoActual === 'manejar') { sonar(rec('pito'), { vol: 0.3, corte: 3000, destino: mezcla }); pitoHasta = ctx.currentTime + 0.25; }
    else if (modoActual === 'bici') { sonar(rec('timbre'), { vol: 0.22, destino: mezcla }); pitoHasta = ctx.currentTime + 0.5; }
  }

  function actualizar(estado = {}, dt = 1 / 60) {
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    dt = lim(dt, 0, 0.1);
    const modo = estado.modo || 'libre';
    const vel = Math.abs(lim(estado.velocidad, -200, 200));
    if (modo !== modoActual) {
      voz?.soltar(t);
      voz = VOCES[modo] ? VOCES[modo](ctx, rec, voces) : null;
      voz?.arrancar(t);
      modoActual = modo;
      ir(filtroAmb.frequency, modo === 'manejar' ? 1800 : modo === 'volar' ? 2600 : 16000, t, 0.3);
      ir(ambiente.gain, modo === 'manejar' ? 0.6 : modo === 'volar' ? 0.5 : 1, t, 0.3);
      acumulado = 1; // la voz nueva se ajusta ya
    }

    // Pasos en cada cuadro para no perder el compás: la cadencia es la de la animación de jugador.js.
    if (modo === 'caminar' && vel > 0.25) {
      fasePaso += dt * (2.2 + vel * 2.4) / Math.PI;
      if (fasePaso >= 1) {
        fasePaso -= 1;
        sonar(alAzar(rec('pisadas')), { vol: 0.16 + lim(vel / 4.2) * 0.12, tasa: 0.9 + Math.random() * 0.17 + vel * 0.02,
          pan: (Math.random() - 0.5) * 0.2, destino: mezcla });
      }
    } else fasePaso = 0.7; // el primer paso llega rápido al arrancar

    // El resto basta a 20 Hz.
    acumulado += dt;
    if (acumulado < 0.05) return;
    const paso = Math.min(acumulado, 0.2);
    acumulado = 0;
    const noche = lim(estado.noche), alto = Math.max(0, finito(estado.alto));
    const plaza = lim(estado.cercaPlaza), tm = lim(estado.enTransMilenio), arboles = lim(estado.cercaArboles ?? 0.3);
    const dia = 1 - noche * 0.6;
    const cerca = 1 - suave(alto / 120); // la calle se pierde con la altura

    voz?.actualizar(vel, alto, paso, t);
    ciudad(dia, cerca, t);
    // El viento sube con la altura y con la velocidad cuando el aire pega de frente.
    const exposicion = Math.sqrt(lim(alto / 300));
    const frente = lim(modo === 'volar' ? vel / 45 : modo === 'bici' ? vel / 10 : modo === 'caminar' ? vel / 12 : 0);
    const resguardo = modo === 'manejar' ? 0.25 : modo === 'volar' ? 0.5 : 1;
    viento((0.05 + exposicion * 0.25 + frente * 0.3) * resguardo * (1 - noche * 0.2), 800 + frente * 1200 + exposicion * 900, t);

    // Pitos lejanos; a veces el "pi-pii" de dos toques.
    if ((prox.pito -= paso) <= 0) {
      prox.pito = (2 + Math.random() * 7) * (1 + noche * 2);
      if (cerca > 0.05) {
        const b = alAzar(rec('bocinas')), tasa = 0.92 + Math.random() * 0.16;
        const opciones = { vol: 0.09 * dia * cerca * (0.4 + Math.random() * 0.6), tasa, pan: (Math.random() * 2 - 1) * 0.8, corte: 900 + Math.random() * 1100 };
        sonar(b, opciones);
        if (Math.random() < 0.35) sonar(b, { ...opciones, t: t + b.duration / tasa + 0.08 });
      }
    }
    // Motos que pasan de un lado al otro.
    if ((prox.moto -= paso) <= 0) {
      prox.moto = (4 + Math.random() * 9) * (1 + noche * 1.5);
      if (cerca > 0.05) {
        const m = alAzar(rec('motos'));
        sonar(m.b, { vol: 0.2 * cerca * (0.5 + Math.random() * 0.5) * (1 - noche * 0.3), tasa: 0.92 + Math.random() * 0.16,
          curvaPan: Math.random() < 0.5 ? m.curva : m.curva.map((x) => -x) });
      }
    }
    // Copetones de día, cerca de árboles y plazas; a veces otro responde desde el otro lado.
    if ((prox.pajaro -= paso) <= 0) {
      prox.pajaro = 2.5 + Math.random() * 6;
      const ganas = Math.max(arboles, plaza) * (1 - suave((noche - 0.3) / 0.4)) * (1 - suave(alto / 40));
      if (Math.random() < ganas) {
        const lista = rec('copetones'), pan = (Math.random() * 2 - 1) * 0.9, vol = 0.07 * (0.4 + Math.random() * 0.6);
        sonar(alAzar(lista), { vol, pan, tasa: 0.96 + Math.random() * 0.08 });
        if (Math.random() < 0.4) sonar(alAzar(lista), { t: t + 1.6 + Math.random(), vol: vol * 0.6, pan: -pan * 0.8, tasa: 0.96 + Math.random() * 0.08 });
      }
    }
    // Campanas de la Catedral en punto: una campanada por hora (de 1 a 12). Un salto grande de la hora no cuenta.
    const hora = Number.isFinite(estado.hora) ? estado.hora : horaReal();
    if (horaAnt !== null && Math.floor(hora) !== Math.floor(horaAnt) && (hora - horaAnt + 24) % 24 < 0.05) {
      campanadas = Math.floor(hora) % 12 || 12;
      proxCampana = 0;
    }
    horaAnt = hora;
    if (campanadas > 0 && (proxCampana -= paso) <= 0) {
      campanadas--;
      proxCampana = 2.6;
      if (plaza > 0) sonar(rec('campana'), { vol: 0.35 * plaza });
    }
    // Estación de TransMilenio: frena el bus, suelta aire, pitan las puertas al abrir y al cerrar.
    if (tm > 0.02) {
      if ((prox.bus -= paso) <= 0) {
        prox.bus = 20 + Math.random() * 20;
        const v = 0.12 * tm;
        sonar(rec('frenado'), { vol: v, corte: 5000 });
        sonar(rec('aire'), { t: t + 1.7, vol: v * 0.8, corte: 7000 });
        sonar(rec('puertas'), { t: t + 2.3, vol: v * 0.7 });
        sonar(rec('puertas'), { t: t + 9.5, vol: v * 0.7 });
        sonar(rec('aire'), { t: t + 11.2, vol: v * 0.5, tasa: 1.2, corte: 7000 });
      }
    } else prox.bus = 2; // al llegar a una estación el primer bus no tarda
  }

  return { activar, silenciar, get silenciado() { return silenciado; }, actualizar, pito };
}
