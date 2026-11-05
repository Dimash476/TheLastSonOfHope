import * as THREE from 'three';
import { SPACE } from '../config.js';
import { clamp, lerp, smoothstep } from '../utils.js';

// Тяжесть боя: всё, что делает удар ударом. Без случайной тряски камеры — масса передаётся
// хит-стопом, наездом объектива, провалом музыки, низким звуком и тем, что происходит вокруг:
// пыль, стекло, кольца воздуха, столбы дыма и пепел над разрушенным городом.

const UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _cp = new THREE.Vector3();

// ---------------------------------------------------------------- звуковой банк
// Рендерится заранее, поэтому даже самый тяжёлый звук стоит в игре одного проигрывания буфера
const RATE = 32000;

function noiseBuf(c, sec, brown = false) {
  const n = Math.floor(c.sampleRate * sec), b = c.createBuffer(1, n, c.sampleRate), d = b.getChannelData(0);
  let last = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w;
  }
  return b;
}

function drive(c, k, dest) {
  const s = c.createWaveShaper(), n = 1024, a = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; a[i] = Math.tanh(x * k) / Math.tanh(k); }
  s.curve = a;
  s.connect(dest);
  return s;
}

function sweep(c, dest, t, dur, from, to, gain, type = 'sine', curve = 0.35) {
  const o = c.createOscillator(), g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(from, t);
  o.frequency.exponentialRampToValueAtTime(to, t + dur * curve);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(dest);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function nburst(c, dest, buf, t, dur, gain, { type = 'lowpass', freq = 800, to = null, q = 0.8, attack = 0.002, pan = 0 } = {}) {
  const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
  s.buffer = buf;
  s.loop = true;
  f.type = type;
  f.Q.value = q;
  f.frequency.setValueAtTime(freq, t);
  if (to) f.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f).connect(g);
  if (pan) { const p = c.createStereoPanner(); p.pan.value = pan; g.connect(p).connect(dest); } else g.connect(dest);
  s.start(t, Math.random());
  s.stop(t + dur + 0.02);
}

// Стон металла: низкие пилы, которые гуляют по тону, сквозь резонансный фильтр
function groan(c, dest, t, dur, base, gain) {
  const f = c.createBiquadFilter(), g = c.createGain();
  f.type = 'lowpass';
  f.Q.value = 7;
  f.frequency.setValueAtTime(320, t);
  f.frequency.exponentialRampToValueAtTime(150, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(gain, t + dur * 0.25);
  g.gain.linearRampToValueAtTime(0.0001, t + dur);
  f.connect(g).connect(dest);
  for (const m of [1, 1.02, 2.03]) {
    const o = c.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(base * m, t);
    o.frequency.linearRampToValueAtTime(base * m * 0.72, t + dur);
    o.connect(f);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
}

// Низкий звон металла: негармонические призвуки
function clang(c, dest, t, base, gain, dur) {
  for (const [r, g] of [[1, 1], [1.46, 0.72], [2.32, 0.55], [3.37, 0.34], [4.91, 0.2]]) sweep(c, dest, t, dur / Math.sqrt(r), base * r, base * r * 0.97, gain * g, 'sine', 1);
}

// Щебень: россыпь коротких глухих ударов, в начале чаще
function rubble(c, dest, n, t, span, count, gain, lo, hi) {
  for (let i = 0; i < count; i++) {
    const at = t + Math.pow(Math.random(), 1.6) * span;
    nburst(c, dest, n, at, 0.04 + Math.random() * 0.13, gain * (0.5 + Math.random()) * (1 - (at - t) / (span * 1.3)), { type: 'bandpass', freq: lo + Math.random() * (hi - lo), q: 2.2, pan: (Math.random() - 0.5) * 1.5 });
  }
}

// Удар кулака: щелчок кости, перегруженное тело, провал суба, низкий металл, хвост
function hitSound(c, d, n, b, p) {
  const hard = drive(c, 4.4, d), soft = drive(c, 2, d);
  nburst(c, hard, n, 0, 0.012, 1, { type: 'highpass', freq: 3000 });
  nburst(c, d, n, 0, 0.03, 0.45, { type: 'bandpass', freq: 5200, q: 0.7 });
  sweep(c, hard, 0, 0.26, 300 * p, 62 * p, 1, 'triangle', 0.3);
  nburst(c, hard, n, 0, 0.16, 1, { freq: 2400 * p, to: 180 });
  sweep(c, soft, 0, 1.2, 135 * p, 30 * p, 1, 'sine', 0.22);
  sweep(c, soft, 0.012, 0.8, 70 * p, 26, 0.8, 'sine', 0.4);
  clang(c, d, 0, 92 * p, 0.2, 0.6);
  nburst(c, d, b, 0.01, 1.4, 0.85, { freq: 360, to: 50, attack: 0.01 });
}

// Удар серии в полёте: два удара подряд, как один — кость и всё тело, потом суб держит пол
function chainSound(c, d, n, b, p) {
  const hard = drive(c, 5.4, d), mid = drive(c, 2.6, d);
  nburst(c, mid, n, 0, 0.018, 1, { type: 'highpass', freq: 1800 });
  sweep(c, hard, 0, 0.24, 420 * p, 70 * p, 1, 'triangle', 0.22);
  nburst(c, hard, n, 0, 0.1, 1, { freq: 3400 * p, to: 260 });
  sweep(c, hard, 0.028, 0.5, 190 * p, 44 * p, 1, 'sawtooth', 0.3);
  nburst(c, hard, b, 0.028, 0.4, 1, { freq: 900, to: 120 });
  sweep(c, mid, 0.01, 1.9, 120 * p, 24, 1, 'sine', 0.22);
  sweep(c, mid, 0.03, 1.4, 62 * p, 22, 0.9, 'sine', 0.4);
  clang(c, mid, 0, 84 * p, 0.34, 1.1);
  groan(c, d, 0.03, 1.1, 46 * p, 0.2);
  nburst(c, d, b, 0.04, 2.6, 1, { freq: 480, to: 40, attack: 0.01 });
  rubble(c, d, n, 0.08, 1.2, 16, 0.12, 200, 1400);
}

const SOUNDS = {
  hit0: { sec: 2, wet: 0.2, build: (c, d, n, b) => hitSound(c, d, n, b, 1) },
  hit1: { sec: 2, wet: 0.2, build: (c, d, n, b) => hitSound(c, d, n, b, 0.86) },
  hit2: { sec: 2, wet: 0.2, build: (c, d, n, b) => hitSound(c, d, n, b, 1.14) },
  chain0: { sec: 3.4, wet: 0.32, build: (c, d, n, b) => chainSound(c, d, n, b, 1) },
  chain1: { sec: 3.4, wet: 0.32, build: (c, d, n, b) => chainSound(c, d, n, b, 0.88) },
  chain2: { sec: 3.4, wet: 0.32, build: (c, d, n, b) => chainSound(c, d, n, b, 1.1) },
  // Последний удар серии: ломается всё сразу, дальше долгий обвал воздуха
  chainFinal: { sec: 7, wet: 0.6, build(c, d, n, b) {
    chainSound(c, d, n, b, 0.8);
    const dr = drive(c, 3.4, d);
    sweep(c, dr, 0.02, 3.4, 92, 17, 1, 'sine', 0.3);
    sweep(c, dr, 0.08, 1.8, 170, 30, 0.8, 'sawtooth', 0.26);
    nburst(c, d, b, 0.05, 6.2, 1, { freq: 620, to: 30, attack: 0.02 });
    rubble(c, d, n, 0.2, 4, 40, 0.14, 160, 1200);
    groan(c, d, 0.2, 3.6, 38, 0.3);
  } },
  // Затишье перед ударом: воздух втягивается и обрывается
  preHit: { sec: 0.75, wet: 0.1, build(c, d, n, b) {
    nburst(c, d, n, 0, 0.62, 0.6, { type: 'bandpass', freq: 520, q: 0.7, attack: 0.58 });
    nburst(c, d, b, 0, 0.62, 1, { freq: 300, attack: 0.56 });
  } },
  // Рывок на сверхскорости: хлопок воздуха, двойной удар и гул следом
  rush: { sec: 2.8, wet: 0.35, build(c, d, n, b) {
    const dr = drive(c, 3.2, d);
    for (const t of [0, 0.07]) {
      nburst(c, dr, n, t, 0.05, 1, { type: 'highpass', freq: 600 });
      sweep(c, dr, t, 0.8, 125, 28, 0.95, 'sine', 0.3);
    }
    nburst(c, dr, n, 0.03, 0.7, 0.8, { type: 'bandpass', freq: 800, to: 200, q: 0.8, attack: 0.02 });
    nburst(c, d, b, 0.03, 2.3, 1, { freq: 420, to: 60, attack: 0.03 });
  } },
  // Сверхзвуковой хлопок: двойной удар воздуха и долгий гул
  bigBoom: { sec: 5.5, wet: 0.6, build(c, d, n, b) {
    const dr = drive(c, 3.4, d);
    for (const t of [0, 0.085]) {
      nburst(c, dr, n, t, 0.06, 1, { type: 'highpass', freq: 400 });
      sweep(c, dr, t, 1.1, 120, 24, 1, 'sine', 0.3);
      sweep(c, dr, t, 0.3, 240, 60, 0.7, 'sawtooth', 0.4);
    }
    nburst(c, d, b, 0.02, 5, 1, { freq: 460, to: 38, attack: 0.02 });
  } },
  // Тело сквозь здание: бетон, щебень, сталь, стекло
  smash: { sec: 4.6, wet: 0.5, build(c, d, n, b) {
    const dr = drive(c, 3.6, d);
    sweep(c, dr, 0, 0.9, 105, 25, 1, 'sine', 0.3);
    sweep(c, dr, 0, 0.3, 240, 54, 0.9, 'sawtooth', 0.34);
    nburst(c, dr, n, 0, 0.26, 1, { freq: 1900, to: 220 });
    nburst(c, d, b, 0, 4, 1, { freq: 340, to: 50, attack: 0.03 });
    rubble(c, d, n, 0.03, 2.6, 60, 0.3, 200, 1700);
    for (let i = 0; i < 26; i++) {
      const t = 0.08 + Math.pow(Math.random(), 1.4) * 1.6;
      nburst(c, d, n, t, 0.02 + Math.random() * 0.05, 0.04 + Math.random() * 0.06, { type: 'bandpass', freq: 3600 + Math.random() * 3800, q: 5, pan: (Math.random() - 0.5) * 1.6 });
    }
    clang(c, d, 0.02, 70, 0.22, 1.3);
    groan(c, d, 0.12, 2.4, 50, 0.3);
  } },
  // Пролёт рядом: только воздух, без роста тона
  flyby: { sec: 1.8, wet: 0.3, build(c, d, n, b) {
    nburst(c, d, n, 0, 1.3, 0.55, { type: 'bandpass', freq: 380, to: 1100, q: 0.9, attack: 0.46 });
    nburst(c, d, b, 0, 1.45, 1, { freq: 260, to: 110, attack: 0.5 });
  } },
  // Кулак в кулак: низкий металлический удар
  clash: { sec: 3.2, wet: 0.5, build(c, d, n, b) {
    const dr = drive(c, 4, d);
    sweep(c, dr, 0, 1.1, 140, 26, 1, 'sine', 0.26);
    sweep(c, dr, 0, 0.26, 330, 70, 1, 'sawtooth', 0.26);
    nburst(c, dr, n, 0, 0.06, 1, { type: 'highpass', freq: 900 });
    clang(c, drive(c, 1.6, d), 0, 118, 0.42, 2.2);
    nburst(c, d, b, 0.02, 2.4, 0.8, { freq: 420, to: 60, attack: 0.02 });
  } },
  // Удар о землю: всё уходит вниз
  slam: { sec: 4.2, wet: 0.55, build(c, d, n, b) {
    const dr = drive(c, 3.6, d);
    sweep(c, dr, 0, 1.7, 86, 18, 1, 'sine', 0.3);
    sweep(c, dr, 0, 0.3, 200, 44, 0.9, 'sawtooth', 0.34);
    nburst(c, dr, n, 0, 0.2, 1, { freq: 1300, to: 160 });
    nburst(c, d, b, 0.02, 3.7, 1, { freq: 300, to: 34, attack: 0.02 });
    rubble(c, d, n, 0.08, 2, 40, 0.26, 180, 1000);
  } },
  // Корабль: долгий стон корпуса
  shipGroan: { sec: 8, wet: 0.75, build(c, d, n, b) {
    groan(c, d, 0, 7, 34, 0.6);
    groan(c, d, 1.2, 5.6, 51, 0.42);
    nburst(c, d, b, 0, 7.5, 0.8, { freq: 170, to: 60, attack: 1.2 });
    for (const t of [0.9, 2.3, 3.1, 4.6, 5.5]) { sweep(c, d, t, 0.8, 300 + Math.random() * 200, 90, 0.1, 'sawtooth', 1); clang(c, d, t, 60 + Math.random() * 40, 0.14, 1.2); }
  } },
  shipBlast: { sec: 6.5, wet: 0.7, build(c, d, n, b) {
    const dr = drive(c, 4, d);
    sweep(c, dr, 0, 2.8, 78, 16, 1, 'sine', 0.3);
    sweep(c, dr, 0.14, 1.8, 58, 18, 0.8, 'sine', 0.4);
    sweep(c, dr, 0, 0.5, 180, 40, 0.8, 'sawtooth', 0.4);
    nburst(c, dr, n, 0, 0.5, 1, { freq: 2100, to: 110 });
    nburst(c, d, b, 0, 5.8, 1, { freq: 460, to: 30, attack: 0.02 });
    rubble(c, d, n, 0.1, 3.8, 50, 0.24, 180, 1200);
  } },
  // Главный калибр корабля: разряд сверху вниз и удар по кварталу
  shipGun: { sec: 6, wet: 0.7, build(c, d, n, b) {
    const dr = drive(c, 5, d);
    sweep(c, dr, 0, 0.5, 260, 38, 1, 'sawtooth', 0.5);
    sweep(c, dr, 0, 0.5, 130, 26, 1, 'square', 0.5);
    nburst(c, dr, n, 0, 0.3, 1, { freq: 2600, to: 200 });
    sweep(c, dr, 0.02, 2.2, 74, 17, 1, 'sine', 0.3);
    nburst(c, d, b, 0.02, 5.2, 1, { freq: 420, to: 30, attack: 0.02 });
    rubble(c, d, n, 0.15, 3.4, 44, 0.22, 170, 1100);
  } },
  // Падение с орбиты в землю: самый большой звук боя
  meteor: { sec: 11, wet: 0.8, build(c, d, n, b) {
    const dr = drive(c, 4.4, d), hard = drive(c, 7, d);
    nburst(c, hard, n, 0, 0.09, 1, { type: 'highpass', freq: 500 });
    sweep(c, hard, 0, 0.7, 300, 34, 1, 'sawtooth', 0.34);
    sweep(c, dr, 0, 4.4, 90, 14, 1, 'sine', 0.26);
    sweep(c, dr, 0.05, 3, 50, 15, 1, 'sine', 0.4);
    nburst(c, dr, n, 0, 0.8, 1, { freq: 3200, to: 90 });
    nburst(c, d, b, 0, 10, 1, { freq: 620, to: 24, attack: 0.03 });
    rubble(c, d, n, 0.2, 7, 90, 0.26, 150, 1300);
    groan(c, d, 0.6, 5.4, 32, 0.34);
    clang(c, d, 0.04, 58, 0.3, 3.4);
  } },
  // Башня кренится: стон стали и нарастающий гул
  towerFall: { sec: 8, wet: 0.75, build(c, d, n, b) {
    groan(c, d, 0, 6.4, 44, 0.6);
    groan(c, d, 0.6, 5.2, 66, 0.34);
    nburst(c, d, b, 0.2, 7, 1, { freq: 240, to: 110, attack: 3.4 });
    for (const t of [0.1, 0.8, 1.7, 2.6, 3.4, 4.5]) clang(c, d, t, 50 + Math.random() * 60, 0.16, 1.2);
    rubble(c, d, n, 0.3, 6.5, 50, 0.2, 200, 1600);
  } },
  // Далёкий взрыв: только низ и хвост, долетает с опозданием
  farBlast: { sec: 6.5, wet: 0.95, build(c, d, n, b) {
    const dr = drive(c, 2.2, d);
    sweep(c, dr, 0, 2, 62, 20, 1, 'sine', 0.3);
    sweep(c, dr, 0.16, 1.5, 48, 19, 0.7, 'sine', 0.4);
    nburst(c, dr, n, 0, 0.3, 0.7, { freq: 620, to: 120 });
    nburst(c, d, b, 0, 5.6, 1, { freq: 260, to: 34, attack: 0.04 });
  } },
  // Вход в атмосферу: рваное пламя вокруг тел
  entry: { sec: 6, loop: true, wet: 0.2, build(c, d, n, b) {
    const dr = drive(c, 3, d);
    nburst(c, dr, b, 0, 7, 1, { freq: 520, to: 520, attack: 0.3 });
    nburst(c, dr, n, 0, 7, 0.45, { type: 'bandpass', freq: 780, to: 780, q: 0.6, attack: 0.3 });
    nburst(c, d, n, 0, 7, 0.12, { type: 'highpass', freq: 3000, attack: 0.3 });
    for (let t = 0; t < 7; t += 0.08 + Math.random() * 0.26) sweep(c, dr, t, 0.2, 90 + Math.random() * 60, 42, 0.4, 'sawtooth', 1);
  } },
  // Два луча упёрлись друг в друга: рёв, треск и давление
  beamLock: { sec: 4, loop: true, wet: 0.3, build(c, d, n, b) {
    const dr = drive(c, 5, d);
    nburst(c, dr, b, 0, 5, 1, { freq: 340, to: 340, attack: 0.2 });
    for (const f of [41, 41.6, 82.3, 123]) sweep(c, dr, 0, 5, f, f, 0.34, 'sawtooth', 1);
    for (let t = 0; t < 5; t += 0.03 + Math.random() * 0.11) nburst(c, d, n, t, 0.03 + Math.random() * 0.05, 0.1 + Math.random() * 0.34, { type: 'bandpass', freq: 900 + Math.random() * 2800, q: 1.2, pan: (Math.random() - 0.5) * 1.2 });
  } },
  // Город вокруг боя: низкий гул, глухие далёкие удары, осыпающийся камень. Без сирен и гудков
  warBed: { sec: 18, loop: true, wet: 0.9, build(c, d, n, b) {
    nburst(c, d, b, 0, 19, 0.5, { freq: 150, to: 150, attack: 1 });
    for (let t = 0.4; t < 18; t += 1.2 + Math.random() * 3) {
      sweep(c, d, t, 1.6, 52 + Math.random() * 18, 22, 0.32 + Math.random() * 0.3, 'sine', 0.4);
      nburst(c, d, b, t, 2.6, 0.5, { freq: 240, to: 50, attack: 0.05 });
    }
    rubble(c, d, n, 0.5, 17, 70, 0.05, 240, 1300);
  } },
};

async function renderSound(def) {
  // Петля: рендерим на секунду дольше и заводим конец в начало
  const fade = def.loop ? 1 : 0, total = Math.ceil((def.sec + fade) * RATE);
  const c = new OfflineAudioContext(2, total, RATE);
  const inp = c.createGain(), wet = c.createGain(), conv = c.createConvolver();
  const irN = Math.floor(RATE * 2.6), ir = c.createBuffer(2, irN, RATE);
  for (let ch = 0; ch < 2; ch++) {
    const a = ir.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < irN; i++) {
      const t = i / irN;
      lp += ((Math.random() * 2 - 1) - lp) * (0.5 - 0.42 * t);
      a[i] = lp * Math.pow(1 - t, 2.2);
    }
  }
  conv.buffer = ir;
  wet.gain.value = def.wet;
  inp.connect(c.destination);
  inp.connect(conv).connect(wet).connect(c.destination);
  // Всё вместе ещё раз через насыщение: удары плотные, без пустот между слоями
  def.build(c, inp, noiseBuf(c, 2), noiseBuf(c, 3, true));
  let buf = await c.startRendering();
  if (def.loop) {
    const len = Math.round(def.sec * RATE), N = RATE * fade, res = new AudioBuffer({ numberOfChannels: 2, length: len, sampleRate: RATE });
    for (let ch = 0; ch < 2; ch++) {
      const from = buf.getChannelData(ch), to = res.getChannelData(ch);
      to.set(from.subarray(0, len));
      for (let i = 0; i < N; i++) { const k = i / N; to[i] = from[i] * k + from[len + i] * (1 - k); }
    }
    buf = res;
  }
  let peak = 0;
  for (let ch = 0; ch < 2; ch++) { const a = buf.getChannelData(ch); for (let i = 0; i < a.length; i++) peak = Math.max(peak, Math.abs(a[i])); }
  const norm = 0.95 / Math.max(peak, 1e-4);
  for (let ch = 0; ch < 2; ch++) { const a = buf.getChannelData(ch); for (let i = 0; i < a.length; i++) a[i] *= norm; }
  return buf;
}

async function renderBank() {
  const out = {}, jobs = Object.entries(SOUNDS);
  const worker = async () => {
    while (jobs.length) {
      const [k, def] = jobs.shift();
      out[k] = await renderSound(def);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return out;
}

// ---------------------------------------------------------------- след в полёте
// Лента за телом на большой скорости: один объект, одна отрисовка
const RIB = 30;
class Ribbon {
  constructor(scene, color) {
    this.pts = Array.from({ length: RIB }, () => new THREE.Vector3());
    this.ages = new Float32Array(RIB).fill(9);
    this.pos = new Float32Array(RIB * 6);
    this.alpha = new Float32Array(RIB * 2);
    const idx = [];
    for (let i = 0; i < RIB - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aA', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(idx);
    const m = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
      uniforms: { uColor: { value: color } },
      vertexShader: 'attribute float aA; varying float vA; void main() { vA = aA; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform vec3 uColor; varying float vA; void main() { gl_FragColor = vec4(uColor * vA, vA); }',
    });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 4;
    scene.add(this.mesh);
    this.acc = 0;
  }

  clear() {
    this.ages.fill(9);
    this.mesh.visible = false;
  }

  update(dt, p, speed, cam) {
    this.acc += dt;
    const lit = speed > 170;
    if (this.acc > 0.012) {
      this.acc = 0;
      for (let i = RIB - 1; i > 0; i--) { this.pts[i].copy(this.pts[i - 1]); this.ages[i] = this.ages[i - 1]; }
      this.ages[0] = lit ? 0 : 9;
    }
    this.pts[0].copy(p);
    for (let i = 0; i < RIB; i++) this.ages[i] += dt;
    const k = smoothstep(170, 620, speed);
    let any = false;
    for (let i = 0; i < RIB; i++) {
      const a = this.pts[i], b = this.pts[Math.min(RIB - 1, i + 1)];
      _a.subVectors(cam, a);
      _b.subVectors(b, a).cross(_a);
      if (_b.lengthSq() < 1e-6) _b.set(0, 0.01, 0); else _b.normalize();
      const fade = Math.max(0, 1 - this.ages[i] / 0.34) * (1 - i / (RIB - 1));
      const w = (0.16 + 0.75 * k) * (0.35 + 0.65 * fade);
      this.pos[i * 6] = a.x + _b.x * w; this.pos[i * 6 + 1] = a.y + _b.y * w; this.pos[i * 6 + 2] = a.z + _b.z * w;
      this.pos[i * 6 + 3] = a.x - _b.x * w; this.pos[i * 6 + 4] = a.y - _b.y * w; this.pos[i * 6 + 5] = a.z - _b.z * w;
      const al = fade * (0.28 + 0.5 * k);
      this.alpha[i * 2] = al;
      this.alpha[i * 2 + 1] = al;
      if (al > 0.01) any = true;
    }
    this.mesh.visible = any;
    if (any) {
      this.mesh.geometry.attributes.position.needsUpdate = true;
      this.mesh.geometry.attributes.aA.needsUpdate = true;
    }
  }
}

// ---------------------------------------------------------------- пепел в воздухе
// Точки живут в кубе вокруг камеры: сдвигаются только в шейдере, на процессоре ничего не считается
class Ash {
  constructor(scene) {
    const N = 640, pos = new Float32Array(N * 3), seed = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = Math.random() * 120; pos[i * 3 + 1] = Math.random() * 70; pos[i * 3 + 2] = Math.random() * 120;
      seed[i] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    this.u = { uTime: { value: 0 }, uK: { value: 0 }, uScale: { value: 600 }, uCam: { value: new THREE.Vector3() } };
    const m = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, toneMapped: false, uniforms: this.u,
      vertexShader: `
        attribute float aSeed;
        uniform float uTime, uK, uScale; uniform vec3 uCam;
        varying float vA, vE;
        void main() {
          vec3 p = position;
          p.y -= uTime * (1.1 + aSeed * 1.8);
          p.x += uTime * 1.7 + sin(uTime * 0.6 + aSeed * 40.0) * 1.6;
          p.z += uTime * 0.9 + cos(uTime * 0.5 + aSeed * 30.0) * 1.6;
          vec3 b = vec3(120.0, 70.0, 120.0);
          p = mod(p - uCam + b * 0.5, b) - b * 0.5 + uCam;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vE = step(0.9, aSeed);
          gl_PointSize = (vE > 0.5 ? 0.13 : 0.2 + aSeed * 0.2) * uScale / max(-mv.z, 0.1);
          vA = uK * smoothstep(1.0, 6.0, -mv.z) * smoothstep(58.0, 30.0, length(mv.xyz));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying float vA, vE;
        uniform float uTime;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.2, d);
          vec3 col = mix(vec3(0.16, 0.15, 0.14), vec3(2.2, 0.75, 0.2), vE);
          gl_FragColor = vec4(col, a * vA * mix(0.75, 0.95, vE));
        }`,
    });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
    this.points.visible = false;
    this.points.renderOrder = 5;
    scene.add(this.points);
  }

  update(dt, k, cam, scale) {
    const u = this.u;
    u.uK.value += (k - u.uK.value) * Math.min(1, dt * 0.8);
    this.points.visible = u.uK.value > 0.01;
    if (!this.points.visible) return;
    u.uTime.value += dt;
    u.uCam.value.copy(cam);
    u.uScale.value = scale;
  }
}

// ---------------------------------------------------------------- обломок, который бросает генерал
class Slab {
  constructor(inv) {
    this.inv = inv;
    const g = new THREE.BoxGeometry(1, 1, 1, 3, 2, 3);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      p.setXYZ(i, p.getX(i) * (0.82 + Math.random() * 0.36), p.getY(i) * (0.78 + Math.random() * 0.44), p.getZ(i) * (0.82 + Math.random() * 0.36));
    }
    const flat = g.toNonIndexed();
    flat.computeVertexNormals();
    this.mesh = new THREE.Mesh(flat, new THREE.MeshStandardMaterial({ color: 0x75716a, roughness: 0.96, metalness: 0.05, flatShading: true }));
    this.mesh.scale.set(9, 5, 7);
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    inv.scene.add(this.mesh);
    this.vel = new THREE.Vector3();
    this.ang = new THREE.Vector3();
    this.state = 'off';
    this.hits = [];
  }

  reset() {
    this.state = 'off';
    this.mesh.visible = false;
    this.owner = null;
  }

  lift(owner) {
    this.owner = owner;
    this.state = 'held';
    this.mesh.visible = true;
    this.smashed = 0;
    this.t = 0;
  }

  // Бросок на упреждение: летит туда, где герой будет
  hurl(speed) {
    const I = this.inv, H = I.player;
    _a.copy(I.heroC).sub(this.mesh.position);
    const lead = _a.length() / speed;
    _a.addScaledVector(H.vel, Math.min(lead, 0.5)).normalize();
    this.vel.copy(_a).multiplyScalar(speed);
    this.ang.set((Math.random() - 0.5) * 7, (Math.random() - 0.5) * 7, (Math.random() - 0.5) * 7);
    this.state = 'fly';
    this.t = 0;
    I.fx.play('flyby', { pos: this.mesh.position, gain: 0.9 });
  }

  update(dt) {
    if (this.state === 'off') return;
    const I = this.inv, W = I.world, M = this.mesh;
    if (this.state === 'held') {
      const O = this.owner;
      M.position.copy(O.pos).addScaledVector(UP, 6.6);
      M.rotation.z = Math.sin(O.t * 7) * 0.05;
      if (O.state === 'hurl') return;
      // Его сбили с броском: обломок просто падает
      this.vel.set(0, 0, 0);
      this.ang.set(1, 0.6, 0.8);
      this.state = 'fly';
      this.t = 0;
    }
    this.t += dt;
    M.rotation.x += this.ang.x * dt;
    M.rotation.y += this.ang.y * dt;
    M.rotation.z += this.ang.z * dt;
    _b.copy(M.position);
    this.vel.y -= 16 * dt;
    M.position.addScaledVector(this.vel, dt);
    if (Math.random() < 0.6) W.dust.burst(M.position, 1, { size: [2, 5], speed: 2, life: [0.5, 1.1], color: 0x8a847a });
    const p = M.position;
    const speed = this.vel.length();

    // Герой: рывок уводит от него, удар в нужный момент разбивает
    const H = I.player, d = _c.subVectors(I.heroC, p).length();
    if (d < 7.5 && H.punchT >= 0 && H.punchT < 0.36) {
      I.fx.hit(p.clone(), this.vel.clone().normalize(), 0.8);
      W.debris.explode(p, 16, 40);
      this.reset();
      return;
    }
    if (d < 5 && H.dashT <= 0 && !H.driven) {
      const dir = this.vel.clone().normalize();
      I.hurtHero(16, _a.copy(dir).setY(Math.max(dir.y, 0.12)).normalize().multiplyScalar(260).clone(), false, 0);
      I.fx.hit(p.clone(), dir, 1);
      W.debris.explode(p, 16, 36);
      this.reset();
      return;
    }
    // Дома пробивает, но вязнет; земля останавливает
    if (Math.min(_b.y, p.y) < 700) {
      W.city.sphereQuery(p, 3.6, this.hits);
      for (const s of this.hits) {
        W.city.closestPoint(s, p, _cp);
        const dir = this.vel.clone().normalize();
        W.city.destroySeg(s, _cp.clone(), dir, Math.min(speed * 0.3, 120));
        I.fx.pierce(_cp.clone(), dir, speed);
        this.vel.multiplyScalar(0.72);
        if (++this.smashed >= 3) { I.fx.crash(_cp.clone(), 0.55); this.reset(); return; }
      }
    }
    const gy = W.city.groundHeightAt(p.x, p.z, p.y + 0.5);
    if (p.y <= gy + 1.5 || this.t > 6) {
      if (p.y <= gy + 1.5) I.fx.crash(p.clone().setY(gy), 0.6);
      this.reset();
    }
  }
}

// ---------------------------------------------------------------- дымное небо
// Купол вокруг камеры: закрывает только небо (всё остальное ближе него), у горизонта совпадает с туманом
const SMOG = new THREE.Color(0x77726a);
class SmogDome {
  constructor(scene) {
    this.u = { uK: { value: 0 }, uColor: { value: new THREE.Color() } };
    const m = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.BackSide, toneMapped: false, uniforms: this.u,
      vertexShader: 'varying vec3 vD; void main() { vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform float uK; uniform vec3 uColor; varying vec3 vD; void main() { float a = uK * mix(1.0, 0.6, smoothstep(0.0, 0.42, vD.y)); gl_FragColor = vec4(uColor, a); }',
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), m);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = -1;
    this.mesh.scale.setScalar(40000);
    scene.add(this.mesh);
  }

  set(k, color, cam) {
    this.mesh.visible = k > 0.003;
    if (!this.mesh.visible) return;
    this.u.uK.value = k;
    this.u.uColor.value.copy(color);
    this.mesh.position.copy(cam);
  }
}

// ---------------------------------------------------------------- основной класс
export class BattleFX {
  constructor(inv) {
    this.inv = inv;
    this.W = inv.world;
    this.A = inv.world.audio;
    this.zoom = 0;
    this.zoomT = 0;
    this.zoomHold = 0;
    this.gradeK = 0;
    this.columns = [];
    this.bank = null;
    this.ribHero = new Ribbon(inv.scene, new THREE.Color(0.85, 0.95, 1.4));
    this.ribXarg = new Ribbon(inv.scene, new THREE.Color(1.5, 0.55, 0.18));
    this.ash = new Ash(inv.scene);
    this.slab = new Slab(inv);
    this.hits = [];
    this.smashT = 0;
    this.boomT = 0;
    this.flyT = 0;
    this.xMach = false;
    this.skidAt = new THREE.Vector3(1e9, 0, 0);
    this.cineT = 0;
    this.timers = [];
    this.loops = {};
    this.smog = 0;
    this.frags = [];
    this.hazeT = 0;
    this.farT = 6;
    this.dome = new SmogDome(inv.scene);
  }

  prepare() {
    if (!this.preparing) this.preparing = renderBank().then((b) => { this.bank = b; });
  }

  reset() {
    this.zoom = 0;
    this.zoomT = 0;
    this.zoomHold = 0;
    this.gradeK = 0;
    this.columns.length = 0;
    this.ribHero.clear();
    this.ribXarg.clear();
    this.ash.u.uK.value = 0;
    this.ash.points.visible = false;
    this.slab.reset();
    this.xMach = false;
    this.cineT = 0;
    this.smashT = -9;
    this.timers.length = 0;
    this.smog = 0;
    this.frags.length = 0;
    this.farT = 6;
    this.dome.set(0, null, null);
    this.W.city.onCollapse = (p, h) => this.collapse(p, h);
  }

  stop() {
    this.reset();
    this.muteLoops();
    this.W.city.onCollapse = null;
    this.inv.el.bars.classList.remove('on');
  }

  // Отложенное действие: считается в реальном времени, замедления его не растягивают
  after(t, fn) { this.timers.push({ t, fn }); }

  // Длинный звук, который держится, пока идёт событие (пламя, лучи, гул города). 0 — тишина
  setLoop(name, gain, tau = 0.4) {
    const A = this.A;
    if (!A?.ctx || !this.bank?.[name]) return;
    let L = this.loops[name];
    if (!L) {
      if (gain <= 0) return;
      const s = A.ctx.createBufferSource(), g = A.ctx.createGain();
      s.buffer = this.bank[name];
      s.loop = true;
      g.gain.value = 0;
      s.connect(g).connect(A.master);
      s.start();
      L = this.loops[name] = { s, g };
    }
    L.g.gain.setTargetAtTime(gain, A.ctx.currentTime, tau);
  }

  // Пауза и конец боя: ничего длинного не остаётся звучать
  muteLoops() {
    const A = this.A;
    if (!A?.ctx) return;
    for (const k in this.loops) this.loops[k].g.gain.setTargetAtTime(0, A.ctx.currentTime, 0.15);
  }

  // Заранее записанный звук; pos — откуда (иначе рядом)
  play(name, { gain = 1, pos = null, rate = 1 } = {}) {
    const A = this.A;
    if (!A?.ctx || !this.bank?.[name]) return false;
    const ctx = A.ctx, s = ctx.createBufferSource(), g = ctx.createGain();
    s.buffer = this.bank[name];
    s.playbackRate.value = rate * (0.96 + Math.random() * 0.08);
    g.gain.value = gain;
    s.connect(g).connect(pos ? A.out(pos) : A.master);
    s.start();
    return true;
  }

  // Резкий наезд объектива, держится миг и плавно отпускает
  crashZoom(deg, hold = 0.14) {
    if (deg < this.zoomT && this.zoomHold > 0) return;
    this.zoomT = deg;
    this.zoomHold = hold;
  }

  // Киношные полосы на миг: только полосы, приборы и управление остаются
  cineFor(t) {
    this.cineT = Math.max(this.cineT, t);
    this.inv.el.bars.classList.add('on');
  }

  // Звук удара без остального: pos — откуда
  thud(k = 1, pos = null) {
    this.play(`hit${Math.floor(Math.random() * 3)}`, { gain: 0.45 + 0.55 * k, pos, rate: 1.06 - 0.12 * k }) || this.W.audio?.punch(k, 'concrete', pos?.clone());
  }

  // ---------------------------------------------------------------- удары
  // Воздух от удара бьёт вокруг: у земли — пылевое кольцо, у домов вылетают стёкла
  airBlast(point, dir, k) {
    const W = this.W;
    if (point.y >= 700) return;
    const gy = W.city.groundHeightAt(point.x, point.z, point.y + 0.5);
    if (point.y - gy < 22 && k > 0.55) {
      _a.set(point.x, gy + 0.4, point.z);
      W.effects.shockwave(_a.clone(), { type: 'ring', radius: 14 + 34 * k, life: 0.7, opacity: 0.6 });
      W.dust.burst(_a, Math.round(10 + 20 * k), { size: [4, 11], speed: 18 + 28 * k, life: [1, 2.4], flat: true });
    }
    if (k > 0.7) {
      const list = W.city.sphereQuery(point, 24 + 34 * k, this.hits);
      let n = 0;
      for (const s of list) {
        W.city.shatterWindows(s, point, dir);
        if (++n >= 7) break;
      }
    }
  }

  // k: 0.45 лёгкий, 0.6 обычный, 1 сильный
  hit(point, dir, k = 1) {
    const I = this.inv, W = this.W, P = I.player, near = point.distanceTo(I.camera.position);
    P.hitstop = Math.max(P.hitstop, 0.03 + 0.08 * k);
    W.effects.impactFX(k, point, 0.2 * k, 7 + 9 * k);
    W.effects.flash(point, 10 + 26 * k);
    W.sparks.burst(point, Math.round(12 + 26 * k), { size: [0.25, 1.1], speed: 18 + 26 * k, life: [0.12, 0.5], color: 0xffd9a0 });
    W.effects.shockwave(point.clone(), { type: 'disc', dir: dir.clone(), radius: 7 + 20 * k, life: 0.42, opacity: 0.45 + 0.45 * k, color: 0xffd8b0 });
    if (k > 0.55) {
      W.effects.shockwave(point.clone(), { type: 'sphere', radius: 4 + 8 * k, life: 0.3, opacity: 0.3 });
      W.dust.burst(point, Math.round(5 + 10 * k), { size: [2, 6 + 4 * k], speed: 10 + 14 * k, life: [0.5, 1.3], dir: dir.clone().multiplyScalar(0.7), color: 0xb4aca0 });
    }
    this.airBlast(point, dir, k);
    this.thud(k, point);
    if (k >= 0.9) this.play('bigBoom', { gain: 0.4, pos: point });
    I.theme.duck(k * 0.8);
    if (near > 22 && k > 0.5) this.crashZoom(3 + 6 * k);
  }

  // Кольцо воздуха вокруг точки. Камера не должна оказаться внутри: кадр важнее
  airRing(point, dir, R, life, opacity, color = 0xffffff) {
    const near = point.distanceTo(this.inv.camera.position);
    this.W.effects.shockwave(point.clone(), { type: 'disc', dir: dir.clone(), radius: Math.min(R, Math.max(3.5, near * 0.8)), life, opacity, color });
  }

  // Рывок серии: воздух рвётся за героем, и через миг музыка уходит — остаётся только этот рывок
  chainRush(from, dir) {
    const W = this.W, I = this.inv;
    this.airRing(from, dir, 22, 0.55, 0.38);
    W.effects.ghost(I.player.root);
    W.dust.burst(from, 8, { size: [2, 6], speed: 12, life: [0.4, 1], dir: dir.clone().multiplyScalar(-0.8), color: 0xbcb2a4 });
    this.play('rush') || W.audio?.whoosh(1);
    I.theme.duck(0.4);
  }

  // Удар серии в полёте. n — его номер: каждый следующий больше предыдущего, последний закрывает всё
  chainHit(point, dir, n, final, kin) {
    const I = this.inv, W = this.W, P = I.player, k = clamp((n - 2) / 4, 0, 1);
    P.hitstop = Math.max(P.hitstop, final ? 0.36 : 0.13 + 0.07 * k);
    // В стоп-кадре виден сам удар: вокруг кулака только короткая вспышка
    W.effects.impactFX(1, point, final ? 0.5 : 0.14 + 0.1 * k, 12 + 9 * k);
    W.effects.flash(point, 34 + 34 * k);
    const R = 18 + 30 * k + (final ? 34 : 0), warm = 0xffe2c4;
    this.airRing(point, dir, 3 + 2 * k, 0.5, 0.42, warm);
    // Стоп-кадр заканчивается — и воздух бьёт
    this.after(I.player.hitstop * 0.85, () => {
      this.airRing(point, dir, R * 0.7, 0.5, 0.4, warm);
      W.effects.shockwave(point.clone(), { type: 'sphere', radius: Math.min(R * 0.42, point.distanceTo(I.camera.position) * 0.6), life: 0.34, opacity: 0.32, color: warm });
    });
    // Искры веером вперёд, немного пыли обратно к кулаку
    W.sparks.burst(point, Math.round(46 + 44 * k), { size: [0.3, 1.5], speed: 46 + 46 * k, life: [0.16, 0.8], color: 0xffdcae, dir: dir.clone().multiplyScalar(0.6) });
    W.dust.burst(point, 6, { size: [2, 6], speed: 12, life: [0.4, 1], dir: _a.copy(dir).multiplyScalar(-0.7).clone(), color: 0xc4baaa });
    // Без расстояния: это происходит прямо перед камерой
    this.play(`chain${n % 3}`, { gain: 0.86 + 0.14 * k, rate: 1.03 - 0.09 * k }) || W.audio?.punch(1, 'concrete', point.clone());
    if (final) {
      this.play('chainFinal');
      W.effects.shockwave(point.clone(), { type: 'sphere', radius: R, life: 0.8, opacity: 0.5, color: 0xffd0a0 });
      this.cineFor(2.4);
    }
    I.theme.duck(final ? 1 : 0.82 + 0.18 * k);
    this.crashZoom(final ? 18 : 8 + 7 * k, final ? 0.55 : 0.2 + 0.1 * k);
  }

  // Кулак отпустил, цель уносит: воздух рвётся кольцами вдоль её пути, у земли и у домов всё отвечает
  chainRelease(point, dir, n, final, kin) {
    const I = this.inv, W = this.W, k = clamp((n - 2) / 4, 0, 1);
    const R = 16 + 26 * k + (final ? 30 : 0);
    this.airRing(point, dir, R, 0.5, 0.4);
    W.effects.ghost(kin.root);
    for (let i = 1; i <= 3; i++) {
      this.after(i * 0.1, () => {
        if (kin.root.visible) this.airRing(kin.c, dir, R * (0.55 + i * 0.25), 0.5, 0.28 - i * 0.06);
      });
    }
    W.dust.burst(point, Math.round(10 + 16 * k), { size: [3, 9 + 7 * k], speed: 26 + 32 * k, life: [0.6, 1.9], dir: dir.clone().multiplyScalar(0.9), color: 0xc4baaa });
    this.airBlast(point, dir, 0.8 + 0.2 * k);
    this.play('bigBoom', { gain: 0.45 + 0.4 * k, rate: 1.08 - 0.14 * k });
    I.theme.duck(0.6 + 0.3 * k);
  }

  // Размен ударами лицом к лицу: всё вокруг отвечает на каждый удар
  brawlHit(point, dir, k = 1) {
    const I = this.inv, W = this.W, P = I.player;
    P.hitstop = Math.max(P.hitstop, 0.09 + 0.06 * k);
    W.effects.impactFX(1, point, 0.12 + 0.1 * k, 9 + 6 * k);
    W.effects.flash(point, 34 + 26 * k);
    this.airRing(point, dir, 16 + 22 * k, 0.5, 0.4, 0xffe2c4);
    W.sparks.burst(point, Math.round(26 + 26 * k), { size: [0.25, 1.1], speed: 34 + 26 * k, life: [0.14, 0.6], color: 0xffdcae });
    this.airBlast(point, dir, 0.75 + 0.25 * k);
    const gy = W.city.groundHeightAt(point.x, point.z, point.y + 0.5);
    if (point.y - gy < 8) {
      W.effects.crater(_a.set(point.x, gy, point.z).clone(), 6 + 5 * k);
      W.debris.explode(_a, 6, 22);
      W.impact?.(_a, 18, 14);
    }
    this.play(`chain${Math.floor(Math.random() * 3)}`, { gain: 0.75 + 0.25 * k, rate: 1.05 - 0.1 * k }) || W.audio?.punch(1, 'concrete', point.clone());
    I.theme.duck(0.75);
    this.crashZoom(6 + 5 * k, 0.16);
  }

  // Главный калибр бьёт по кварталу. Дальше — огонь, обломки и дым на полнеба
  bombard(pt) {
    const I = this.inv, W = this.W;
    I.ship.fireGun(pt);
    W.city.damageRadius(pt, 34, 1500, 70);
    W.effects.shockwave(pt.clone(), { type: 'sphere', radius: 54, life: 0.8, opacity: 0.55, color: 0xffb070 });
    W.fire.explosion(pt, 2.4);
    W.dust.burst(pt, 14, { size: [18, 48], speed: 34, life: [6, 12], color: 0x3a342e, rise: 8, alpha: 0.42, plume: true });
    const gy = W.city.groundHeightAt(pt.x, pt.z, 400);
    this.smokeAt(_a.set(pt.x, gy, pt.z).clone(), 1);
    this.launchFrags(pt, 4);
    this.play('shipGun', { pos: pt }) || W.audio?.boom(0.8, pt.clone());
    if (pt.distanceTo(I.camera.position) < 700) { I.theme.duck(0.5); W.effects.impactFX(0.4, pt, 0.08, 4); }
  }

  // Удар с орбиты о землю. k — насколько полно: 1 два тела с самого верха, меньше — падение одного
  meteor(point, k = 1) {
    const I = this.inv, W = this.W, g = point.y;
    W.city.damageRadius(_a.copy(point).setY(g + 14).clone(), 60 + 70 * k, 2600, 90 + 40 * k);
    W.impact?.(point, 110 + 110 * k, 50 + 30 * k);
    W.effects.crater(point, 30 + 46 * k);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + Math.random(), r = (22 + Math.random() * 18) * (0.6 + k);
      W.effects.crater(_a.set(point.x + Math.cos(a) * r, g, point.z + Math.sin(a) * r).clone(), 12 + 16 * k);
    }
    _b.copy(point).setY(g + 1);
    W.effects.shockwave(_b.clone(), { type: 'ring', radius: 240 + 360 * k, life: 3, opacity: 1 });
    W.effects.shockwave(_b.clone(), { type: 'ring', radius: 120 + 180 * k, life: 1.8, opacity: 0.9, color: 0xffd0a0 });
    W.effects.shockwave(_b.clone(), { type: 'sphere', radius: 60 + 90 * k, life: 1, opacity: 0.8, color: 0xffb070 });
    W.dust.burst(_b, Math.round(70 + 130 * k), { size: [26, 84], speed: 90 + 80 * k, life: [6, 15], flat: true, color: 0x8a8174, alpha: 0.85 });
    W.dust.burst(_b, Math.round(24 + 36 * k), { size: [40, 120], speed: 30, rise: 16, life: [9, 17], color: 0x4f483f, alpha: 0.5, plume: true });
    W.fire.explosion(point, 2.5 + 2.5 * k);
    W.debris.explode(point, 26 + 40 * k, 50 + 50 * k);
    W.sparks.burst(point, 90, { size: [0.5, 2], speed: 90, life: [0.3, 1.4], color: 0xffc080 });
    W.effects.flash(point, 120);
    W.effects.impactFX(1, point, 0.95, 30);
    I.player.hitstop = Math.max(I.player.hitstop, 0.3);
    if (point.y < 700) {
      let n = 0;
      for (const s of W.city.sphereQuery(_b, 240 + 200 * k, this.hits)) {
        W.city.shatterWindows(s, point, UP);
        if (++n > 70) break;
      }
    }
    this.smokeAt(point.clone(), 1.5);
    this.launchFrags(point, 6);
    this.play('meteor', { gain: 0.8 + 0.2 * k }) || W.audio?.boom(1, point.clone());
    I.theme.duck(1);
    I.theme.stinger();
    this.crashZoom(18, 0.8);
    this.cineFor(5);
  }

  // Горящие обломки летят дугой и оставляют дым
  launchFrags(p, n) {
    for (let i = 0; i < n; i++) {
      if (this.frags.length >= 10) this.frags.shift();
      const a = Math.random() * Math.PI * 2, s = 50 + Math.random() * 90;
      this.frags.push({ pos: p.clone(), vel: new THREE.Vector3(Math.cos(a) * s, 60 + Math.random() * 110, Math.sin(a) * s), acc: 0, t: 0 });
    }
  }

  // Тело врезалось в землю или стену: воронка, кольцо, стена пыли
  crash(point, k) {
    const I = this.inv, W = this.W;
    const gy = W.city.groundHeightAt(point.x, point.z, point.y + 0.5);
    const onGround = point.y - gy < 3;
    if (onGround) W.effects.crater(point.clone().setY(gy), 5 + 14 * k);
    _a.copy(point).setY(point.y + 0.5);
    W.effects.shockwave(_a.clone(), { type: 'ring', radius: 18 + 56 * k, life: 0.9, opacity: 0.85 });
    W.effects.shockwave(_a.clone(), { type: 'sphere', radius: 6 + 18 * k, life: 0.4, opacity: 0.35, color: 0xffc090 });
    W.dust.burst(_a, Math.round(24 + 46 * k), { size: [4, 14], speed: 20 + 44 * k, life: [1.6, 3.8], flat: onGround });
    W.dust.burst(_a, Math.round(8 + 14 * k), { size: [5, 12], speed: 10 + 18 * k, life: [1.5, 3], rise: 3, color: 0x8c8478 });
    W.debris.explode(point, 8 + 24 * k, 18 + 40 * k);
    W.effects.flash(point, 12 + 30 * k);
    W.effects.impactFX(0.3 + 0.7 * k, point, 0.16 * k, 6 + 10 * k);
    W.impact?.(point, 14 + 40 * k, 18 + 34 * k);
    this.play('slam', { gain: 0.5 + 0.5 * k, pos: point }) || W.audio?.boom(0.35 + 0.5 * k, point);
    W.audio?.crumble(0.2 + 0.4 * k, 'concrete', point);
    I.theme.duck(0.5 * k);
    this.crashZoom(3 + 7 * k);
    if (k > 0.45 && onGround) this.smokeAt(point.clone().setY(gy), 0.8);
  }

  // Тело прошло сквозь здание: облако бьёт с обеих сторон, стена рушится вокруг дыры
  pierce(point, dir, speed) {
    const I = this.inv, W = this.W, k = clamp(speed / 620, 0.4, 1);
    _a.copy(point).addScaledVector(dir, -3);
    W.dust.burst(_a, Math.round(14 + 14 * k), { size: [4, 12], speed: 10 + 16 * k, life: [1.2, 3], dir: _b.copy(dir).multiplyScalar(-0.8).clone(), color: 0xa89f92 });
    _a.copy(point).addScaledVector(dir, 6);
    W.dust.burst(_a, Math.round(20 + 18 * k), { size: [5, 15], speed: 18 + 26 * k, life: [1.4, 3.4], dir: dir.clone(), color: 0xa89f92 });
    W.effects.shockwave(point.clone(), { type: 'disc', dir: dir.clone(), radius: 12 + 14 * k, life: 0.45, opacity: 0.7, color: 0xe8dccb });
    W.effects.flash(point, 16 + 12 * k);
    W.sparks.burst(point, 20, { size: [0.4, 1.2], speed: 30, life: [0.2, 0.6], color: 0xffd28a });
    W.debris.explode(point, 18, 26 + 16 * k);
    W.city.damageRadius(point, 9, 300 + 240 * k, 50 + 30 * k, dir);
    if (I.time - this.smashT > 0.22) {
      this.smashT = I.time;
      this.play('smash', { gain: 0.6 + 0.4 * k, pos: point }) || W.audio?.punch(1, 'concrete', point.clone());
      W.audio?.glass(0.5, point.clone());
      I.theme.duck(0.42);
      if (point.distanceTo(I.camera.position) > 26) this.crashZoom(3 + 4 * k, 0.1);
      this.smokeAt(point.clone().setY(W.city.groundHeightAt(point.x, point.z, 400)), 0.7);
    }
  }

  // Столкновение кулаков
  clash(point, dir) {
    const W = this.W, I = this.inv;
    W.effects.shockwave(point.clone(), { type: 'disc', dir: dir.clone(), radius: 34, life: 0.55, opacity: 1, color: 0xffe2c0 });
    W.effects.shockwave(point.clone(), { type: 'disc', dir: _a.copy(dir).negate().clone(), radius: 22, life: 0.4, opacity: 0.7 });
    W.effects.shockwave(point.clone(), { type: 'sphere', radius: 14, life: 0.35, opacity: 0.5 });
    W.sparks.burst(point, 60, { size: [0.3, 1.2], speed: 52, life: [0.15, 0.7], color: 0xffe2b0 });
    W.effects.flash(point, 40);
    W.effects.impactFX(1, point, 0.34, 16);
    I.player.hitstop = Math.max(I.player.hitstop, 0.13);
    this.play('clash', { pos: point }) || W.audio?.metal(0.8, point.clone());
    this.play('bigBoom', { gain: 0.5, pos: point });
    I.theme.duck(0.85);
    this.crashZoom(7, 0.16);
    if (point.y < 700) for (const s of W.city.sphereQuery(point, 55, this.hits)) W.city.shatterWindows(s, point, dir);
  }

  // Кусок здания упал на землю: волна пыли по улице
  collapse(point, h) {
    const W = this.W, I = this.inv;
    const k = clamp(h / 160, 0.25, 1);
    const gy = W.city.groundHeightAt(point.x, point.z, 400);
    _a.set(point.x, gy + 1, point.z);
    W.effects.shockwave(_a.clone(), { type: 'ring', radius: 40 + 90 * k, life: 1.3, opacity: 0.6 });
    W.dust.burst(_a, Math.round(30 + 50 * k), { size: [10, 26], speed: 32 + 34 * k, life: [3, 7], flat: true });
    this.play('slam', { gain: 0.45 + 0.55 * k, pos: _a.clone(), rate: 0.86 });
    if (_a.distanceTo(I.camera.position) < 500) I.theme.duck(0.4 * k);
    this.smokeAt(_a.clone(), 0.7 + 0.5 * k);
  }

  // Вырвал кусок из стены или земли
  rip(point) {
    const W = this.W;
    W.dust.burst(point, 26, { size: [3, 9], speed: 16, life: [0.8, 2], color: 0xa89f92 });
    W.debris.explode(point, 8, 18);
    this.play('hit0', { gain: 0.8, pos: point, rate: 0.72 }) || W.audio?.punch(0.8, 'concrete', point);
    W.audio?.crumble(0.3, 'concrete', point);
  }

  // Точка, куда бьёт луч генерала: рубит здание и оставляет за собой огонь
  burn(point, dir) {
    const W = this.W;
    if (point.y < 700) {
      W.city.damageRadius(point, 7, 240, 14, dir);
      if (point.y - W.city.groundHeightAt(point.x, point.z, point.y + 0.5) < 1.5) W.effects.crater(point, 2);
    }
    W.dust.burst(point, 3, { size: [3, 7], speed: 6, life: [1, 2.4], color: 0x34302c, rise: 3 });
    W.sparks.burst(point, 10, { size: [0.2, 0.7], speed: 22, life: [0.2, 0.6], color: 0xffb070, gravity: 20 });
  }

  // Столб чёрного дыма и огонь у основания
  smokeAt(point, k = 1) {
    const W = this.W;
    if (point.y > 700) return;
    for (const s of this.columns) {
      if (s.pos.distanceToSquared(point) < 3600) { s.t = Math.max(0, s.t - 8); return; }
    }
    if (this.columns.length >= 12) this.columns.shift();
    this.columns.push({ pos: point.clone(), t: 0, life: 40, acc: 0, k });
    W.fire.add(point.clone().setY(point.y + 1), { size: 1.6 + 1.6 * k, life: 28 });
  }

  // Последний удар боя
  finalBlow(point, dir) {
    const W = this.W, I = this.inv;
    W.effects.shockwave(point.clone(), { type: 'disc', dir: dir.clone(), radius: 90, life: 1, opacity: 1, color: 0xfff0d8 });
    W.effects.shockwave(point.clone(), { type: 'sphere', radius: 50, life: 0.8, opacity: 0.55, color: 0xffd0a0 });
    W.effects.flash(point, 90);
    W.effects.impactFX(1, point, 0.95, 26);
    I.player.hitstop = Math.max(I.player.hitstop, 0.42);
    W.sparks.burst(point, 90, { size: [0.4, 1.8], speed: 80, life: [0.2, 1], color: 0xffdcae });
    W.dust.burst(point, 40, { size: [8, 24], speed: 60, life: [2, 5], color: 0xa89f92 });
    this.play('chainFinal');
    this.play('bigBoom');
    this.play('clash', { rate: 0.7 });
    I.theme.duck(1);
    this.crashZoom(18, 0.7);
    this.cineFor(4);
    if (point.y < 700) for (const s of W.city.sphereQuery(point, 90, this.hits)) W.city.shatterWindows(s, point, dir);
  }

  // ---------------------------------------------------------------- кадр
  update(dt, realDt) {
    const I = this.inv, W = this.W, P = I.player, X = I.xarg, cam = I.camera.position;
    for (let i = this.timers.length - 1; i >= 0; i--) {
      const T = this.timers[i];
      T.t -= realDt;
      if (T.t <= 0) { this.timers.splice(i, 1); T.fn(); }
    }
    // Наезд: быстро подъехать, чуть подержать, медленно отпустить
    if (this.zoomHold > 0) {
      this.zoomHold -= realDt;
      this.zoom += (this.zoomT - this.zoom) * (1 - Math.exp(-40 * realDt));
    } else {
      this.zoomT = 0;
      this.zoom += (0 - this.zoom) * (1 - Math.exp(-3.6 * realDt));
    }
    if (this.cineT > 0) {
      this.cineT -= realDt;
      if (this.cineT <= 0 && !I.el.hud.classList.contains('cine')) I.el.bars.classList.remove('on');
    }

    if (I.pool) {
      this.ribHero.update(realDt, I.heroC, P.driven || P.knockT > 0 ? Math.max(P.speed, 200) : P.speed, cam);
      if (X.root.visible) this.ribXarg.update(realDt, X.c, X.vel.length(), cam);
      else if (this.ribXarg.mesh.visible) this.ribXarg.clear();
    }

    // Столбы дыма
    for (let i = this.columns.length - 1; i >= 0; i--) {
      const s = this.columns[i];
      s.t += dt;
      if (s.t > s.life) { this.columns.splice(i, 1); continue; }
      s.acc += dt * 7 * Math.min(1, (s.life - s.t) / 8);
      while (s.acc >= 1) {
        s.acc -= 1;
        _a.copy(s.pos).add(_b.set((Math.random() - 0.5) * 12, 2, (Math.random() - 0.5) * 12));
        W.dust.burst(_a, 1, { size: [24 * s.k, 62 * s.k], speed: 3, life: [11, 18], rise: 22, color: 0x2c2823, alpha: 0.46, plume: true });
      }
    }

    // Пепел густеет по мере разрушений; в космосе его нет
    const fight = I.fightOn && !I.ended;
    const lost = W.city.destroyed - I.destroyed0;
    const low = 1 - smoothstep(600, 2200, cam.y);
    this.ash.update(realDt, fight ? (0.3 + 0.7 * Math.min(1, lost / 14)) * low : 0, cam, W.dust.material.uniforms.uScale.value);
    this.updateCity(dt, realDt, fight, lost, low);

    // Цвет боя: холоднее и контрастнее, в космосе цвет возвращается
    const gradeT = fight ? 1 - smoothstep(SPACE.atmosphere * 0.5, SPACE.atmosphere, cam.y) : 0;
    this.gradeK += (gradeT - this.gradeK) * Math.min(1, realDt * 1.5);

    if (!I.pool || !fight) return;
    this.slab.update(dt);

    // Генерал: хлопок при переходе звука, пыль у земли, пролёт мимо камеры
    if (X.root.visible) {
      const sp = X.vel.length();
      if (sp > 340 && !this.xMach) {
        this.xMach = true;
        const d = _a.copy(X.vel).divideScalar(sp).clone();
        W.effects.shockwave(X.c.clone(), { type: 'disc', dir: d, radius: 62, life: 0.85, opacity: 0.9 });
        W.effects.shockwave(X.c.clone(), { type: 'sphere', radius: 34, life: 0.6, opacity: 0.45 });
        this.play('bigBoom', { gain: 0.8, pos: X.c }) || W.audio?.boom(0.8, X.c.clone());
        if (X.pos.y - X.groundY < 60) W.impact?.(X.c.clone(), 60, 14);
      } else if (sp < 280) this.xMach = false;
      const alt = X.pos.y - X.groundY;
      if (!X.grounded && sp > 90 && alt < 30 && Math.random() < 0.8) {
        const k = 1 - alt / 30;
        W.dust.burst(_a.set(X.pos.x, X.groundY + 1, X.pos.z), Math.ceil(3 * k), { size: [4, 10 * k + 4], speed: 10 + sp * 0.05, life: [1, 2.5], flat: true });
      }
      this.flyT -= realDt;
      if (this.flyT <= 0 && sp > 150 && X.c.distanceTo(cam) < 40) {
        this.flyT = 0.7;
        this.play('flyby', { gain: Math.min(1, sp / 400), pos: X.c });
      }
      // Стёкла вылетают и от него
      this.boomT -= dt;
      if (this.xMach && alt < 220 && this.boomT <= 0) {
        this.boomT = 0.14;
        let n = 0;
        for (const s of W.city.sphereQuery(X.c, 60, this.hits)) {
          W.city.shatterWindows(s, X.c, X.vel);
          if (++n > 8) break;
        }
      }
    }

    // Герой летит по земле после удара: борозда
    const hs = Math.hypot(P.vel.x, P.vel.z);
    if (P.knockT > 0 && P.pos.y - P.groundY < 1.2 && hs > 50 && P.groundY < 700) {
      if (P.pos.distanceToSquared(this.skidAt) > 36) {
        this.skidAt.copy(P.pos);
        this.furrow(P.pos, hs);
      }
    }
  }

  // След от тела по земле
  furrow(pos, speed) {
    const W = this.W, k = clamp(speed / 300, 0.3, 1);
    W.effects.crater(pos, 2.4 + 3.6 * k);
    _a.copy(pos).setY(pos.y + 0.6);
    W.dust.burst(_a, Math.round(7 + 10 * k), { size: [3, 8], speed: 8 + 14 * k, life: [0.8, 2], flat: true });
    W.debris.explode(pos, 3, 10 + 12 * k);
    W.impact?.(pos, 8, 8);
    if (Math.random() < 0.3) this.play('hit1', { gain: 0.45, pos, rate: 0.7 });
  }

  // Город вокруг боя: пелена густеет с разрушениями, вдали рвётся, сверху падает горящее.
  // Всё это видно и слышно вдали от героя, но не отвлекает управление
  updateCity(dt, realDt, fight, lost, low) {
    const I = this.inv, W = this.W, cam = I.camera.position;
    const want = fight ? 0.34 + 0.66 * smoothstep(0, 40, lost) : 0;
    this.smog += (want - this.smog) * Math.min(1, realDt * (fight ? 0.14 : 0.5));
    this.setLoop('warBed', fight && I.endT === null ? low * (0.16 + 0.42 * this.smog) : 0, 1.2);
    for (let i = this.frags.length - 1; i >= 0; i--) {
      const f = this.frags[i];
      f.t += dt;
      f.vel.y -= 26 * dt;
      f.pos.addScaledVector(f.vel, dt);
      f.acc += dt * 14;
      while (f.acc >= 1) {
        f.acc -= 1;
        W.dust.burst(f.pos, 1, { size: [3, 8], speed: 1, life: [1.6, 3.4], color: 0x2a2622, alpha: 0.5, plume: true });
        W.fire.flames.burst(f.pos, 1, { size: [1.2, 2.8], speed: 1, life: [0.25, 0.55], color: 0xffa040 });
      }
      const gy = W.city.groundHeightAt(f.pos.x, f.pos.z, f.pos.y + 1);
      if (f.pos.y <= gy || f.t > 9) {
        if (f.pos.y <= gy) {
          W.dust.burst(f.pos, 5, { size: [4, 10], speed: 12, life: [1, 2.4], flat: true });
          W.sparks.burst(f.pos, 10, { size: [0.2, 0.7], speed: 20, life: [0.2, 0.6], color: 0xffb070 });
        }
        this.frags.splice(i, 1);
      }
    }
    if (!fight || low < 0.05) return;
    // Клочья пыли висят над улицами: дальше сорока метров картинка уже не чистая
    this.hazeT -= realDt;
    if (this.hazeT <= 0) {
      this.hazeT = 0.3 / Math.max(0.2, this.smog);
      const a = Math.random() * Math.PI * 2, r = 50 + Math.random() * 220;
      _a.set(cam.x + Math.cos(a) * r, 0, cam.z + Math.sin(a) * r);
      _a.y = W.city.groundHeightAt(_a.x, _a.z, 400) + 6 + Math.random() * 34;
      W.dust.burst(_a, 1, { size: [50, 120], speed: 2, life: [9, 15], rise: 1, color: 0x8d857a, alpha: 0.13 + 0.12 * this.smog, plume: true });
    }
    // Дальний бой: взрывы над кварталами, которых мы не видим вблизи
    this.farT -= realDt;
    if (this.farT <= 0) {
      this.farT = 4 + Math.random() * 5;
      const a = Math.random() * Math.PI * 2, r = 500 + Math.random() * 900;
      _a.set(cam.x + Math.cos(a) * r, 0, cam.z + Math.sin(a) * r);
      const gy = W.city.groundHeightAt(_a.x, _a.z, 400);
      _a.y = gy + 10 + Math.random() * 90;
      const p = _a.clone();
      W.fire.explosion(p, 1.3 + Math.random());
      W.dust.burst(p, 8, { size: [14, 38], speed: 20, life: [5, 11], color: 0x3a342e, rise: 7, alpha: 0.4, plume: true });
      this.launchFrags(p, 2);
      this.play('farBlast', { pos: p, gain: 0.7 + Math.random() * 0.3 });
      if (Math.random() < 0.4) this.smokeAt(p.clone().setY(gy), 0.8);
    }
  }

  // Небо над боем: туман гуще и серее, солнце пробивается сквозь дым. Вызывается из main.js после env.update
  applyEnv(env, scene, camera) {
    const k = this.smog;
    if (k < 0.002) { this.dome.set(0, null, null); return; }
    scene.fog.density *= 1 + 3.2 * k;
    scene.fog.color.lerp(SMOG, 0.72 * k);
    env.sun.intensity *= 1 - 0.3 * k;
    env.hemi.intensity *= 1 - 0.14 * k;
    this.dome.set(k * (1 - smoothstep(1200, 6000, camera.position.y)), scene.fog.color, camera.position);
  }

  // Поверх цветокоррекции неба: вызывается из main.js каждый кадр
  applyGrade(grade) {
    const k = this.gradeK, s = this.smog;
    if (k < 0.002) return;
    const u = grade.uniforms;
    u.uSat.value *= lerp(1, 0.8 - 0.2 * s, k);
    u.uContrast.value += (0.13 + 0.08 * s) * k;
    u.uShadow.value.x -= 0.012 * k;
    u.uShadow.value.z += 0.02 * k;
    u.uHigh.value.x += 0.008 * s * k;
    u.uHigh.value.z -= 0.006 * k;
    u.uVig.value += (0.1 + 0.08 * s) * k;
  }
}
