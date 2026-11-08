// Боевая тема режима «Вторжение». Своя музыка в духе больших партитур Ханса Циммера: тёмная медленная гармония
// над педалью ре, широкая линия длинными нотами, стена низкой меди, ансамбль больших барабанов шестнадцатыми,
// пульсирующий бас в рисунке 3+3+2, рояль и контрапункт струнных поверх, зал с почти бесконечным хвостом.
// Форма на 32 такта: A низко и глухо, B шире, выше и плотнее. Мелодия написана для этой игры, из фильмов ничего не взято.
//
// Весь оркестр заранее рендерится в петли (OfflineAudioContext), в игре они просто проигрываются
// и микшируются по этапам боя — кадровой частоте это ничего не стоит.

const BPM = 76;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
const STEP = BEAT / 4;
const CHANGE = BAR * 2;   // смена аккорда и всех крупных событий
const TAIL = 8;
const BARS = 32;          // длина формы
const B_AT = 16;          // с этого такта вторая половина

const note = (m) => 440 * Math.pow(2, (m - 69) / 12);

// Ре минор. Голоса почти не двигаются, опора на квинты. r — на чём строить пустую квинту, если в басу не основной тон;
// sus — задержание [голос, нота]: голос приходит к ноте аккорда с опозданием на половину его длины
const CHORD = {
  Dm:   { bass: 38, v: [50, 57, 62, 65, 69], sus: [3, 67] },
  EbD:  { bass: 38, r: 39, v: [51, 58, 63, 67, 70] },
  BbD:  { bass: 38, r: 34, v: [50, 58, 62, 65, 70] },
  Eb:   { bass: 39, v: [51, 58, 63, 67, 70], sus: [3, 68] },
  Bb:   { bass: 34, v: [50, 58, 62, 65, 70], sus: [2, 63] },
  Gm:   { bass: 31, v: [50, 58, 62, 67, 70], sus: [4, 72] },
  Cm:   { bass: 36, v: [48, 55, 63, 67, 72], sus: [2, 65] },
  FA:   { bass: 33, r: 41, v: [48, 57, 60, 65, 69], sus: [1, 58] },
  DmF:  { bass: 41, r: 38, v: [50, 57, 62, 65, 69] },
  F:    { bass: 41, v: [48, 57, 60, 65, 69] },
  C:    { bass: 36, v: [48, 55, 64, 67, 72] },
  Asus: { bass: 33, v: [52, 57, 62, 64, 69] },
  A:    { bass: 33, v: [52, 57, 61, 64, 69] },
  D:    { bass: 38, v: [50, 57, 62, 66, 69] },
  D5:   { bass: 38, v: [50, 57, 62, 69, 74] },
};
const rootOf = (ch) => ch.r ?? ch.bass;

// [аккорд, тактов]; напряжение копится к концу каждой половины
const FORM = [
  ['Dm', 2], ['EbD', 2], ['BbD', 2], ['Gm', 2], ['Dm', 2], ['Eb', 2], ['Cm', 2], ['Asus', 1], ['A', 1],
  ['Bb', 2], ['FA', 2], ['Gm', 2], ['DmF', 2], ['Eb', 2], ['C', 2], ['Dm', 1], ['Bb', 1], ['Asus', 1], ['A', 1],
];

function eachChord(fn) {
  let bar = 0;
  for (const [k, bars] of FORM) {
    fn(CHORD[k], bar * BAR, bars, bar);
    bar += bars;
  }
}

// Широкая линия: [нота MIDI или null — пауза, длина в долях]. A спускается и ищет выход,
// B начинается там, где A остановилась, и каждая фраза берёт выше предыдущей
const LINE_A = [
  [null, 2], [62, 2], [69, 4],
  [70, 3], [67, 1], [65, 4],
  [65, 2], [62, 2], [58, 4],
  [62, 2], [67, 2], [70, 4],
  [69, 3], [65, 1], [62, 4],
  [63, 2], [70, 2], [67, 4],
  [72, 2], [67, 2], [75, 4],
  [74, 4], [73, 4],
];
const LINE_B = [
  [70, 2], [77, 2], [74, 4],
  [72, 2], [77, 2], [81, 4],
  [79, 3], [74, 1], [70, 4],
  [69, 2], [74, 2], [77, 4],
  [79, 2], [75, 2], [82, 4],
  [79, 2], [84, 2], [76, 4],
  [77, 2], [74, 2], [74, 2], [70, 2],
  [69, 4], [69, 2], [73, 2],
];
const LINE = [...LINE_A, ...LINE_B];
// Медь в A не поёт линию, а отвечает ей, пока та держит длинную ноту
const ANSWER = [
  [null, 12], [58, 2], [55, 2],
  [53, 4], [null, 8],
  [55, 2], [58, 2], [57, 4], [null, 8],
  [55, 2], [51, 2], [48, 4],
  [55, 2], [63, 2], [62, 4], [61, 4],
];
const rest = (bars) => [null, bars * 4];

// Огромный тёмный зал: редкие ранние отражения, дальше хвост на 7–8 секунд, верх гаснет быстрее низа
const IRS = new Map();
function impulse(rate) {
  if (IRS.has(rate)) return IRS.get(rate);
  const seconds = TAIL, pre = Math.floor(rate * 0.045), n = Math.floor(rate * seconds);
  const buf = new AudioBuffer({ numberOfChannels: 2, length: n, sampleRate: rate });
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / (n - pre);
      lp += ((Math.random() * 2 - 1) - lp) * (0.5 - 0.46 * Math.min(1, t * 2.4));
      d[i] = lp * Math.pow(1 - t, 1.7) * Math.exp(-t * 3.1);
    }
    for (let k = 0; k < 9; k++) {
      const at = pre + Math.floor(rate * (0.012 + Math.random() * 0.13));
      d[at] += (Math.random() < 0.5 ? -1 : 1) * (0.5 - k * 0.04);
    }
  }
  IRS.set(rate, buf);
  return buf;
}

function noiseBuffer(c, sec = 2) {
  const n = Math.floor(c.sampleRate * sec), buf = c.createBuffer(1, n, c.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function shaper(c, k) {
  const s = c.createWaveShaper(), n = 1024, a = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; a[i] = Math.tanh(x * k) / Math.tanh(k); }
  s.curve = a;
  s.oversample = '2x';
  return s;
}

// Сухой + зал; низы в зал не идут, иначе хвост превращается в кашу
function room(c, wet) {
  const inp = c.createGain(), w = c.createGain(), conv = c.createConvolver(), hp = c.createBiquadFilter();
  conv.buffer = impulse(c.sampleRate);
  hp.type = 'highpass';
  hp.frequency.value = 140;
  w.gain.value = wet;
  inp.connect(c.destination);
  inp.connect(conv).connect(hp).connect(w).connect(c.destination);
  return inp;
}

function filter(c, type, freq, q = 0.7, gain = 0) {
  const f = c.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  f.gain.value = gain;
  return f;
}

function vibrato(c, rate, cents, start = 0) {
  const o = c.createOscillator(), g = c.createGain();
  o.frequency.value = rate;
  g.gain.value = cents;
  o.connect(g);
  o.start(start);
  return g;
}

// Несколько расстроенных генераторов на одну ноту. Нота набухает к доле peak и немного спадает
function stack(c, dest, t, dur, freq, { n = 4, spread = 12, gain = 0.05, attack = 0.3, release = 0.5, peak = 0.7, vib = null, width = 0.7, type = 'sawtooth' }) {
  const g = c.createGain(), top = Math.max(t + attack + 0.01, t + dur * peak), off = Math.max(top + 0.01, t + dur - release);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain * 0.55, t + attack);
  g.gain.linearRampToValueAtTime(gain, top);
  g.gain.linearRampToValueAtTime(gain * 0.75, off);
  g.gain.linearRampToValueAtTime(0, t + dur);
  g.connect(dest);
  for (let i = 0; i < n; i++) {
    const k = n > 1 ? (i / (n - 1)) * 2 - 1 : 0;
    const o = c.createOscillator(), p = c.createStereoPanner();
    o.type = type;
    o.frequency.value = freq;
    o.detune.value = k * spread + (Math.random() - 0.5) * 3;
    if (vib) vib.connect(o.detune);
    p.pan.value = k * width;
    o.connect(p).connect(g);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
}

// Шумовой всплеск
function burst(c, dest, t, dur, noise, { type = 'lowpass', freq = 800, to = null, q = 1, gain = 0.3, attack = 0.002, pan = 0 }) {
  const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
  s.buffer = noise;
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

// Смычковая группа ведёт линию без разрывов: генераторы одни на всю партию и перетекают с ноты на ноту.
// Каждая нота проседает на смене смычка и снова растёт, вибрато вступает с опозданием
function desk(c, dest, line, { oct = 0, n = 6, spread = 15, width = 0.85, gain = 0.1, vib = 10, vibRate = 5.1, cut = 3400, start = 0, air = 0, noise = null, swell = 0.38, drive = 0 }) {
  const env = c.createGain(), lp = filter(c, 'lowpass', cut, 0.5), hp = filter(c, 'highpass', 90, 0.6);
  const b1 = filter(c, 'peaking', 420, 0.9, 3), b2 = filter(c, 'peaking', 1100, 1, 1.5), b3 = filter(c, 'peaking', 2700, 0.8, 4);
  if (drive) env.connect(shaper(c, drive)).connect(hp);
  else env.connect(hp);
  hp.connect(b1).connect(b2).connect(b3).connect(lp).connect(dest);
  const vg = c.createGain(), lfo = c.createOscillator();
  vg.gain.value = 0;
  lfo.frequency.value = vibRate;
  lfo.connect(vg);
  lfo.start(start);
  let total = 0;
  for (const [, len] of line) total += len;
  const end = start + total * BEAT, oscs = [];
  for (let i = 0; i < n; i++) {
    const k = n > 1 ? (i / (n - 1)) * 2 - 1 : 0;
    const o = c.createOscillator(), p = c.createStereoPanner();
    o.type = 'sawtooth';
    o.detune.value = k * spread + (Math.random() - 0.5) * 4;
    vg.connect(o.detune);
    p.pan.value = k * width;
    o.connect(p).connect(env);
    o.start(start);
    o.stop(end + 0.02);
    oscs.push(o);
  }
  lfo.stop(end + 0.02);
  // Шорох смычка: без него пилы звучат синтезатором
  if (air && noise) {
    const s = c.createBufferSource(), a = c.createGain();
    s.buffer = noise;
    s.loop = true;
    a.gain.value = air;
    s.connect(filter(c, 'bandpass', 3800, 0.6)).connect(a).connect(env);
    s.start(start);
    s.stop(end + 0.02);
  }
  env.gain.setValueAtTime(0, start);
  let beat = 0, first = true;
  for (const [m, len] of line) {
    const t = start + beat * BEAT, dur = len * BEAT, at = Math.max(start, t - 0.01);
    if (m === null) {
      env.gain.setTargetAtTime(0, at, 0.15);
      beat += len;
      continue;
    }
    const f = note(m + oct);
    for (const o of oscs) {
      if (first) o.frequency.setValueAtTime(f, start);
      else o.frequency.setTargetAtTime(f, Math.max(start, t - 0.03), 0.045);
    }
    first = false;
    env.gain.setTargetAtTime(gain * 0.58, at, 0.04);
    env.gain.setTargetAtTime(gain, t + 0.06, dur * swell);
    lp.frequency.setTargetAtTime(cut * 0.5, at, 0.05);
    lp.frequency.setTargetAtTime(cut, t + 0.06, dur * swell);
    vg.gain.setTargetAtTime(vib * 0.2, t, 0.04);
    vg.gain.setTargetAtTime(vib, t + 0.4, 0.5);
    beat += len;
  }
  env.gain.setTargetAtTime(0, end - 0.06, 0.02);
}

// Большой барабан: мембрана падает по тону, сверху глухой удар колотушки. Трое бьют почти вместе
function drum(c, dest, noise, t, k, { from = 58, to = 30, fall = 0.5, decay = 2.4, slap = 500, players = 3 } = {}) {
  for (let i = 0; i < players; i++) {
    const pan = players > 1 ? (i / (players - 1)) * 2 - 1 : 0;
    const at = t + (i ? Math.random() * 0.012 : 0);
    const o = c.createOscillator(), g = c.createGain(), p = c.createStereoPanner();
    o.frequency.setValueAtTime(from * (1 + (Math.random() - 0.5) * 0.06), at);
    o.frequency.exponentialRampToValueAtTime(to, at + fall);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(k * 0.55, at + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, at + decay);
    p.pan.value = pan * 0.4;
    o.connect(g).connect(p).connect(dest);
    o.start(at);
    o.stop(at + decay + 0.02);
    burst(c, dest, at, 0.12, noise, { freq: slap, to: 110, gain: k * 0.28, pan: pan * 0.4 });
  }
}

// Рояль: затухающие обертоны и стук молоточка. Верхние гаснут раньше
function piano(c, dest, noise, t, m, k, { len = 4, pan = 0, hammer = true, partials = [[1, 1, 1], [2, 0.4, 0.6], [3, 0.18, 0.4], [4.02, 0.07, 0.26]] } = {}) {
  const f = note(m), p = c.createStereoPanner();
  p.pan.value = pan;
  p.connect(dest);
  for (const [r, a, d] of partials) {
    const o = c.createOscillator(), g = c.createGain(), end = t + len * d;
    o.frequency.value = f * r;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(k * a, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    o.connect(g).connect(p);
    o.start(t);
    o.stop(end + 0.02);
  }
  if (hammer) burst(c, p, t, 0.03, noise, { type: 'bandpass', freq: Math.min(f * 6, 6000), q: 0.8, gain: k * 0.16 });
}

// Удар по металлу: негармоничные обертоны, быстро гаснет
function clang(c, dest, noise, t, k, pan = 0) {
  const p = c.createStereoPanner();
  p.pan.value = pan;
  p.connect(dest);
  for (const [f, a, d] of [[233, 1, 0.55], [587, 0.7, 0.42], [1061, 0.5, 0.3], [1693, 0.28, 0.2]]) {
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'triangle';
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(k * a, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g).connect(p);
    o.start(t);
    o.stop(t + d + 0.02);
  }
  burst(c, p, t, 0.05, noise, { type: 'highpass', freq: 1800, gain: k * 0.5 });
}

// Форманты: один и тот же аккорд звучит как голоса, а не как генераторы
function voices(c, dest, bands) {
  const bus = c.createGain();
  for (const [f, q, g] of bands) {
    const a = c.createGain();
    a.gain.value = g;
    bus.connect(filter(c, 'bandpass', f, q)).connect(a).connect(dest);
  }
  return bus;
}

// Огибающая партии: [такт, уровень]
function envelope(c, dest, points) {
  const g = c.createGain();
  g.gain.setValueAtTime(points[0][1], 0);
  for (const [bar, v] of points.slice(1)) g.gain.linearRampToValueAtTime(v, bar * BAR);
  g.connect(dest);
  return g;
}

// Партии: каждая строит граф в OfflineAudioContext c и занимает bars тактов.
// rate — частота рендера, level — громкость (RMS) после выравнивания: баланс задаётся здесь и в MIX
const STEMS = {
  // Остинато: низкие струнные шестнадцатыми с акцентами 3+3+2. В B поверх альты: группы по три против четырёх
  pulse: { bars: BARS, rate: 22050, wet: 0.2, level: 0.085, build(c, dest) {
    const ACC = [1, 0.3, 0.36, 0.86, 0.3, 0.36, 0.8, 0.4, 1, 0.3, 0.36, 0.86, 0.3, 0.36, 0.8, 0.55];
    const out = filter(c, 'lowpass', 2800, 0.5);
    out.connect(dest);
    eachChord((ch, t0, bars, bar) => {
      const hi = bar >= B_AT;
      for (let s = 0; s < bars * 16; s++) {
        const t = t0 + s * STEP, a = ACC[s % 16], m = ch.bass + 12;
        const f = c.createBiquadFilter(), g = c.createGain();
        f.type = 'lowpass';
        f.Q.value = 1.2;
        f.frequency.setValueAtTime((hi ? 500 : 340) + a * (hi ? 1900 : 1250), t);
        f.frequency.exponentialRampToValueAtTime(300 + a * 300, t + 0.14);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.1 + a * 0.2, t + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, t + STEP * 1.15);
        for (const det of [-9, 9]) {
          const o = c.createOscillator();
          o.type = 'sawtooth';
          o.frequency.value = note(m);
          o.detune.value = det;
          o.connect(f);
          o.start(t);
          o.stop(t + STEP * 1.2);
        }
        f.connect(g).connect(out);
      }
      if (!hi) return;
      for (let b = 0; b < bars; b++) {
        [0, 3, 6, 9, 12, 14].forEach((s, i) => {
          const t = t0 + (b * 16 + s) * STEP, m = ch.v[[1, 2, 3, 2, 1, 3][i]];
          const g = c.createGain(), pan = c.createStereoPanner(), o = c.createOscillator();
          o.type = 'sawtooth';
          o.frequency.value = note(m);
          o.detune.value = i % 2 ? 6 : -6;
          pan.pan.value = i % 2 ? 0.46 : -0.46;
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(i === 0 ? 0.06 : 0.042, t + 0.008);
          g.gain.exponentialRampToValueAtTime(0.0001, t + STEP * 2);
          o.connect(g).connect(pan).connect(out);
          o.start(t);
          o.stop(t + STEP * 2.05);
        });
      }
    });
  } },

  // Низкий пульсирующий бас: волна давления в том же рисунке. В B основания движутся и прыгают на октаву
  bass: { bars: BARS, rate: 12000, ch: 1, wet: 0.04, level: 0.13, build(c, dest) {
    const sat = shaper(c, 1.8);
    sat.connect(dest);
    const lp = filter(c, 'lowpass', 210, 0.9);
    lp.connect(sat);
    eachChord((ch, t0, bars, bar) => {
      const f0 = note(ch.bass) * (ch.bass > 38 ? 0.5 : 1), hi = bar >= B_AT;
      for (let b = 0; b < bars; b++) {
        for (const [s, k, oct] of [[0, 1, 1], [3, 0.74, 2], [6, 0.82, 1], [8, 0.96, 1], [11, 0.74, 2], [14, 0.82, 1]]) {
          const t = t0 + (b * 16 + s) * STEP, len = STEP * 3.4, f = f0 * (hi ? oct : 1);
          const g = c.createGain(), o = c.createOscillator(), o2 = c.createOscillator(), g2 = c.createGain();
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(0.55 * k, t + 0.012);
          g.gain.exponentialRampToValueAtTime(0.1 * k, t + len);
          g.gain.linearRampToValueAtTime(0, t + len + 0.02);
          o.frequency.value = f;
          o.connect(g).connect(dest);
          g2.gain.setValueAtTime(0.0001, t);
          g2.gain.exponentialRampToValueAtTime(0.26 * k, t + 0.012);
          g2.gain.exponentialRampToValueAtTime(0.03 * k, t + len);
          g2.gain.linearRampToValueAtTime(0, t + len + 0.02);
          o2.type = 'sawtooth';
          o2.frequency.value = f;
          o2.connect(g2).connect(lp);
          for (const x of [o, o2]) { x.start(t); x.stop(t + len + 0.04); }
        }
      }
    });
  } },

  // Протяжные синтезаторные слои: пустые квинты, фильтр медленно дышит на каждом аккорде
  synth: { bars: BARS, rate: 16000, wet: 0.95, level: 0.085, build(c, dest) {
    eachChord((ch, t0, bars, bar) => {
      const dur = bars * BAR + 1.2, r = rootOf(ch), top = bar >= B_AT ? 1700 : 950;
      const lp = filter(c, 'lowpass', 300, 2.2), air = filter(c, 'lowpass', 2400, 0.5);
      lp.frequency.setValueAtTime(240, t0);
      lp.frequency.linearRampToValueAtTime(top, t0 + dur * 0.7);
      lp.frequency.linearRampToValueAtTime(380, t0 + dur);
      lp.connect(dest);
      air.connect(dest);
      for (const m of [r + 12, r + 19, r + 24]) {
        stack(c, lp, t0, dur, note(m), { n: 4, spread: 11, gain: 0.08, attack: 0.9, release: 0.9, peak: 0.72, width: 0.9 });
      }
      for (const m of [r + 36, r + 43]) {
        stack(c, air, t0, dur, note(m), { n: 2, spread: 7, gain: 0.012, attack: 1.4, release: 1, peak: 0.7, width: 0.8, type: 'triangle' });
      }
    });
  } },

  // Струнный аккорд: разделённые голоса с задержаниями. В A тёмная масса посередине, в B открывается вверх
  strings: { bars: BARS, rate: 22050, wet: 1, level: 0.08, build(c, dest) {
    const hp = filter(c, 'highpass', 110, 0.6), b1 = filter(c, 'peaking', 420, 0.8, 2.5), b3 = filter(c, 'peaking', 2500, 0.8, 3);
    const vib = vibrato(c, 4.9, 8);
    hp.connect(b1).connect(b3).connect(dest);
    eachChord((ch, t0, bars, bar) => {
      const hi = bar >= B_AT, len = bars * BAR, dur = len + 0.9, half = len / 2;
      const lp = filter(c, 'lowpass', 800, 0.5);
      lp.frequency.setValueAtTime(800, t0);
      lp.frequency.linearRampToValueAtTime(hi ? 3600 : 1900, t0 + dur * 0.75);
      lp.frequency.linearRampToValueAtTime(hi ? 2000 : 1100, t0 + dur);
      lp.connect(hp);
      const o = { n: 4, spread: 13, gain: 0.05, attack: 0.5, release: 0.75, peak: 0.74, vib, width: 0.85 };
      ch.v.forEach((m, i) => {
        if (ch.sus && ch.sus[0] === i) {
          stack(c, lp, t0, half + 0.4, note(ch.sus[1]), { ...o, release: 0.4, peak: 0.6 });
          stack(c, lp, t0 + half, dur - half, note(m), { ...o, attack: 0.35 });
        } else stack(c, lp, t0, dur, note(m), o);
      });
      stack(c, lp, t0, dur, note(ch.bass + 12), o);
      if (hi) for (const m of ch.v.slice(2)) stack(c, lp, t0, dur, note(m + 12), { ...o, n: 3, spread: 15, gain: 0.028, attack: 0.8, peak: 0.78, width: 0.9 });
    });
  } },

  // Широкая линия. Виолончели ведут всю форму, альты прибавляются к B, скрипки вступают только в B
  lead: { bars: BARS, rate: 22050, wet: 1.1, level: 0.085, build(c, dest, noise) {
    desk(c, dest, LINE, { oct: -12, n: 5, spread: 13, gain: 0.09, cut: 2400, air: 0.05, noise, vibRate: 4.7, vib: 9 });
    const mid = envelope(c, dest, [[0, 0.5], [14, 0.5], [16, 1], [31.5, 1], [32, 0.5]]);
    desk(c, mid, LINE, { oct: 0, n: 6, spread: 15, gain: 0.1, cut: 3400, air: 0.05, noise, vibRate: 5.1, vib: 10 });
    const top = envelope(c, dest, [[0, 0], [14, 0], [16, 0.55], [31.5, 0.55], [32, 0]]);
    desk(c, top, LINE, { oct: 12, n: 7, spread: 17, gain: 0.1, cut: 5200, air: 0.06, noise, vibRate: 5.5, vib: 12 });
  } },

  // Горны и тромбоны: в A короткие ответы линии, в B унисон с ней двумя октавами вниз
  horn: { bars: BARS, rate: 16000, wet: 0.85, level: 0.08, build(c, dest) {
    const b = [rest(B_AT), ...LINE_B];
    desk(c, dest, [...ANSWER, rest(B_AT)], { oct: 0, n: 5, spread: 9, width: 0.45, gain: 0.13, cut: 1200, vib: 3, vibRate: 4.3, swell: 0.3, drive: 1.5 });
    desk(c, dest, b, { oct: -12, n: 5, spread: 9, width: 0.45, gain: 0.13, cut: 1300, vib: 4, vibRate: 4.4, swell: 0.3, drive: 1.5 });
    desk(c, dest, b, { oct: -24, n: 4, spread: 7, width: 0.3, gain: 0.13, cut: 700, vib: 2, vibRate: 4.1, swell: 0.3, drive: 1.9 });
  } },

  // Стена низкой меди: на начале фразы огромный набухающий удар, на прочих аккордах глуше; в B ещё и маркато 3+3+2
  brass: { bars: BARS, rate: 22050, wet: 0.8, level: 0.09, build(c, dest) {
    const sat = shaper(c, 2.7);
    sat.connect(dest);
    eachChord((ch, t0, bars, bar) => {
      const dur = bars * BAR + 0.5, big = bar % 8 === 0 ? 1 : 0.55, r = rootOf(ch);
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.Q.value = 1.1;
      f.frequency.setValueAtTime(150, t0);
      f.frequency.exponentialRampToValueAtTime(420 + big * 1500, t0 + Math.min(1, dur * 0.3));
      f.frequency.exponentialRampToValueAtTime(280, t0 + dur);
      f.connect(sat);
      for (const [m, w] of [[ch.bass, 0.8], [r + 12, 1], [r + 19, 0.8], [r + 24, 0.8]]) {
        stack(c, f, t0, dur, note(m), { n: 4, spread: 10, gain: 0.085 * big * w, attack: 0.14, release: 0.7, peak: 0.26, width: 0.5 });
      }
      if (bar < B_AT) return;
      const stab = filter(c, 'lowpass', 1500, 0.8);
      stab.connect(sat);
      for (let b = 0; b < bars; b++) {
        for (const s of [0, 3, 6, 8, 11, 14]) {
          for (const m of [r + 12, r + 19, r + 24]) {
            stack(c, stab, t0 + (b * 16 + s) * STEP, 0.26, note(m), { n: 2, spread: 8, gain: 0.035, attack: 0.012, release: 0.1, peak: 0.1, width: 0.4 });
          }
        }
      }
    });
  } },

  // Низкий мужской хор на пустых квинтах; в B над ним высокие голоса по нотам аккорда
  choir: { bars: BARS, rate: 16000, wet: 1.1, level: 0.055, build(c, dest) {
    const low = voices(c, dest, [[520, 6, 1], [950, 8, 0.65], [2500, 9, 0.22]]);
    const high = voices(c, dest, [[720, 7, 1], [1180, 8, 0.6], [2850, 9, 0.3]]);
    const vib = vibrato(c, 4.3, 9);
    eachChord((ch, t0, bars, bar) => {
      const dur = bars * BAR + 1, r = rootOf(ch);
      for (const m of [r + 12, r + 19, r + 24, r + 31]) {
        stack(c, low, t0, dur, note(m), { n: 3, spread: 10, gain: 0.26, attack: 1.1, release: 1, peak: 0.7, vib, width: 0.7 });
      }
      if (bar >= B_AT) for (const m of ch.v.slice(2)) stack(c, high, t0, dur, note(m + 12), { n: 3, spread: 12, gain: 0.15, attack: 1.2, release: 1, peak: 0.75, vib, width: 0.9 });
    });
  } },

  // Огромные удары на акцентах; к концу каждой восьмитактовой фразы раскат и тарелка. В B ударов больше
  drums: { bars: BARS, rate: 22050, wet: 0.6, level: 0.1, build(c, dest, noise) {
    const sat = shaper(c, 1.9);
    sat.connect(dest);
    const GRAN = { from: 60, to: 30, fall: 0.55, decay: 2.6, slap: 560 };
    const TAIKO = { from: 108, to: 54, fall: 0.2, decay: 0.95, slap: 1500 };
    for (let bar = 0; bar < BARS; bar += 2) {
      const t = bar * BAR, hi = bar >= B_AT;
      const at = (s) => t + s * STEP;
      drum(c, sat, noise, at(0), 1, GRAN);
      drum(c, sat, noise, at(0), 0.75, TAIKO);
      if (hi) drum(c, sat, noise, at(6), 0.55, TAIKO);
      drum(c, sat, noise, at(12), hi ? 0.62 : 0.5, TAIKO);
      drum(c, sat, noise, at(16), hi ? 0.85 : 0.7, GRAN);
      if (hi) drum(c, sat, noise, at(22), 0.5, TAIKO);
      drum(c, sat, noise, at(28), hi ? 0.6 : 0.46, TAIKO);
      if (bar % 8 === 6) {
        // Раскат: чем дальше, тем сильнее; тон не растёт, только сила
        for (let s = 24; s < 32; s++) drum(c, sat, noise, at(s), 0.34 + (s - 24) * 0.075, { ...TAIKO, players: 2 });
        burst(c, dest, at(16), 16 * STEP, noise, { type: 'highpass', freq: 2600, gain: 0.2, attack: 16 * STEP * 0.95 });
      } else if (hi) {
        drum(c, sat, noise, at(30), 0.72, TAIKO);
      }
      if (bar % 8 === 0) burst(c, dest, t, 3.6, noise, { type: 'highpass', freq: 2200, gain: 0.3, attack: 0.004 });
    }
  } },

  // Ансамбль больших барабанов: сплетённые рисунки шестнадцатыми вступают по очереди, в B к ним добавляется металл
  toms: { bars: BARS, rate: 16000, wet: 0.35, level: 0.09, build(c, dest, noise) {
    const sat = shaper(c, 1.7);
    sat.connect(dest);
    const LOW = { from: 92, to: 50, fall: 0.16, decay: 0.55, slap: 1100, players: 2 };
    const MID = { from: 150, to: 90, fall: 0.1, decay: 0.34, slap: 1800, players: 1 };
    const L = 'x..x..x.x..x..x.', M = '..x..x......x..x', R = '....x.......x...';
    for (let bar = 0; bar < BARS; bar++) {
      const t = bar * BAR, rise = bar < 8 ? 0.45 : bar < B_AT ? 0.65 : bar < 24 ? 0.85 : 1;
      const roll = bar % 8 === 7;
      for (let s = 0; s < 16; s++) {
        const at = t + s * STEP;
        if (L[s] === 'x' && (bar >= 4 || s % 8 === 0)) drum(c, sat, noise, at, rise * (s % 8 === 0 ? 1 : 0.72), LOW);
        if (bar >= 8 && M[s] === 'x' && !(roll && s >= 8)) drum(c, sat, noise, at, rise * 0.6, MID);
        if (bar >= 12 && R[s] === 'x') burst(c, dest, at, 0.07, noise, { type: 'bandpass', freq: 2400, q: 1.4, gain: 0.26 * rise, pan: s < 8 ? -0.4 : 0.4 });
        if (roll && s >= 8) drum(c, sat, noise, at, rise * (0.35 + (s - 8) * 0.07), MID);
      }
      if (bar >= B_AT && bar % 2 === 1) {
        clang(c, dest, noise, t + 4 * STEP, 0.3 * rise, -0.35);
        clang(c, dest, noise, t + 12 * STEP, 0.26 * rise, 0.35);
      }
    }
  } },

  // Верхний этаж. В A тревожное высокое тремоло, в B быстрый контрапункт по нотам аккорда группами по три
  counter: { bars: BARS, rate: 16000, wet: 0.85, level: 0.05, build(c, dest) {
    const trem = c.createGain(), lfo = c.createOscillator(), depth = c.createGain();
    trem.gain.value = 0.55;
    depth.gain.value = 0.45;
    lfo.frequency.value = 9.5;
    lfo.connect(depth).connect(trem.gain);
    lfo.start(0);
    lfo.stop(B_AT * BAR + 1);
    trem.connect(filter(c, 'highpass', 500, 0.6)).connect(dest);
    const fast = filter(c, 'lowpass', 3600, 0.5);
    fast.connect(dest);
    eachChord((ch, t0, bars, bar) => {
      if (bar < B_AT) {
        for (const m of ch.v.slice(3)) stack(c, trem, t0, bars * BAR + 0.4, note(m + 12), { n: 3, spread: 14, gain: 0.035, attack: 0.9, release: 0.6, peak: 0.8, width: 0.9 });
        return;
      }
      const seq = [ch.v[2], ch.v[3], ch.v[4], ch.v[2] + 12, ch.v[4], ch.v[3]];
      for (let b = 0; b < bars; b++) {
        [0, 3, 6, 9, 12, 14].forEach((s, i) => {
          stack(c, fast, t0 + (b * 16 + s) * STEP, STEP * (s >= 12 ? 2 : 3), note(seq[i] + 12), { n: 2, spread: 9, gain: i === 0 ? 0.06 : 0.045, attack: 0.012, release: 0.08, peak: 0.15, width: 0.6 });
        });
      }
    });
  } },

  // Рояль в большом пустом зале. В A редко, по одной ноте той же линии в низком регистре; в B настойчивые октавы восьмыми
  piano: { bars: BARS, rate: 16000, wet: 0.9, level: 0.05, build(c, dest, noise) {
    const out = filter(c, 'lowpass', 4200, 0.5);
    out.connect(dest);
    let beat = 0;
    for (const [m, len] of LINE_A) {
      if (m !== null) piano(c, out, noise, beat * BEAT, m - 12, 0.5, { len: 5, pan: -0.15 });
      beat += len;
    }
    const light = [[1, 1, 1], [2, 0.3, 0.5]];
    eachChord((ch, t0, bars, bar) => {
      if (bar < B_AT) return;
      const top = ch.v[4] + 12;
      for (let s = 0; s < bars * 8; s++) {
        const t = t0 + s * BEAT / 2, k = s % 4 === 0 ? 0.42 : s % 2 === 0 ? 0.3 : 0.22;
        piano(c, out, noise, t, top, k, { len: 1.3, pan: 0.2, hammer: s % 4 === 0, partials: light });
        piano(c, out, noise, t, top - 12, k * 0.6, { len: 1.3, pan: -0.1, hammer: false, partials: light });
      }
    });
  } },
};

// Разовые: нарастание перед новым этапом, удар медью, сцена у тела, победа, поражение.
// Подъёма по высоте нет: только крещендо, чтобы ничего не напоминало сирену
const SHOTS = {
  riser: { sec: CHANGE, rate: 22050, wet: 0.5, level: 0.07, build(c, dest, noise) {
    burst(c, dest, 0.02, CHANGE - 0.04, noise, { type: 'bandpass', freq: 900, q: 0.5, gain: 0.3, attack: CHANGE * 0.93 });
    burst(c, dest, 0.02, CHANGE - 0.04, noise, { type: 'highpass', freq: 3000, gain: 0.16, attack: CHANGE * 0.95 });
    for (const m of [26, 38, 45, 50, 57]) {
      stack(c, dest, 0, CHANGE, note(m), { n: 4, spread: 10, gain: 0.05, attack: CHANGE * 0.6, release: 0.05, peak: 0.97, width: 0.8 });
    }
  } },
  // Удар всем низом оркестра: открытая квинта, короткая атака и хвост в огромный зал
  stinger: { sec: 7, rate: 28000, wet: 0.9, level: 0.2, build(c, dest, noise) {
    const sat = shaper(c, 2.6), f = c.createBiquadFilter();
    sat.connect(dest);
    f.type = 'lowpass';
    f.Q.value = 1;
    f.frequency.setValueAtTime(200, 0);
    f.frequency.exponentialRampToValueAtTime(2600, 0.32);
    f.frequency.exponentialRampToValueAtTime(420, 3.6);
    f.connect(sat);
    for (const m of [26, 38, 45, 50, 57, 62]) {
      stack(c, f, 0, 4.4, note(m), { n: 5, spread: 13, gain: 0.08, attack: 0.04, release: 2.2, peak: 0.16, width: 0.6 });
    }
    drum(c, sat, noise, 0, 1, { from: 74, to: 26, fall: 0.8, decay: 3.2, slap: 900 });
    drum(c, dest, noise, 0.012, 0.8, { from: 52, to: 24, fall: 1, decay: 3.6, slap: 300 });
  } },
  // Над телом: педаль ре, одинокая виолончель медленно проходит начало главной линии, редкий рояль
  fallen: { sec: BAR * 9, rate: 22050, wet: 1.1, level: 0.05, build(c, dest, noise) {
    const sec = BAR * 9, lp = filter(c, 'lowpass', 700, 0.5), vib = vibrato(c, 4.4, 6);
    lp.connect(dest);
    stack(c, dest, 0, sec, note(38), { n: 1, gain: 0.16, attack: 2, release: 3, peak: 0.5, type: 'sine', width: 0 });
    let bar = 0;
    for (const [k, bars] of [['Dm', 3], ['BbD', 3], ['Gm', 3]]) {
      const ch = CHORD[k];
      for (const m of ch.v.slice(0, 3)) stack(c, lp, bar * BAR, bars * BAR + 0.9, note(m), { n: 3, spread: 10, gain: 0.045, attack: 1.6, release: 1.4, peak: 0.6, vib, width: 0.8 });
      bar += bars;
    }
    desk(c, dest, [[null, 2], [50, 2], [57, 8], [58, 6], [55, 2], [53, 8], [50, 8]], { n: 2, spread: 5, width: 0.2, gain: 0.11, cut: 1800, air: 0.04, noise, vib: 11, vibRate: 4.6, swell: 0.5 });
    for (const [b, m] of [[2, 62], [3.5, 69], [5, 65], [6.5, 62], [8, 57]]) piano(c, dest, noise, b * BAR, m, 0.34, { len: 6, pan: 0.2 });
  } },
  // Конец: тема второй половины возвращается медленно и без барабанного рисунка, чем дальше, тем шире,
  // и минор наконец уходит в чистый ре мажор. Ре мажор приходится на затемнение
  victory: { sec: BAR * 14, rate: 22050, wet: 1.1, level: 0.11, build(c, dest, noise) {
    const all = envelope(c, dest, [[0, 0.42], [4, 0.6], [8, 1], [14, 1]]);
    const sat = shaper(c, 1.6);
    sat.connect(all);
    const vib = vibrato(c, 5, 8), seq = [['Bb', 2], ['F', 2], ['Gm', 1], ['Eb', 1], ['Asus', 1], ['A', 1], ['D', 6]];
    const lp = filter(c, 'lowpass', 2800, 0.5);
    lp.connect(all);
    let bar = 0;
    for (const [k, bars] of seq) {
      const ch = CHORD[k], t = bar * BAR, dur = bars * BAR + 0.8, last = k === 'D';
      for (const m of [...ch.v, ch.bass + 12]) stack(c, lp, t, dur, note(m), { n: 4, spread: 13, gain: 0.05, attack: 0.6, release: last ? 3 : 0.8, peak: last ? 0.3 : 0.7, vib, width: 0.85 });
      for (const m of [ch.bass + 12, ch.bass + 19]) stack(c, sat, t, dur, note(m), { n: 3, spread: 8, gain: 0.05, attack: 0.5, release: last ? 3 : 0.8, peak: last ? 0.3 : 0.6, width: 0.4 });
      stack(c, all, t, dur, note(ch.bass), { n: 1, gain: 0.2, attack: 0.3, release: last ? 3 : 0.5, peak: 0.5, type: 'sine', width: 0 });
      drum(c, sat, noise, t, last ? 1 : 0.42, { from: 58, to: 30, fall: 0.55, decay: 2.6, slap: 500 });
      bar += bars;
    }
    const tune = [[70, 2], [77, 2], [74, 4], [72, 2], [77, 2], [81, 4], [79, 2], [74, 2], [75, 4], [74, 4], [73, 4], [74, 24]];
    desk(c, all, tune, { oct: 12, n: 7, spread: 17, gain: 0.06, cut: 4600, air: 0.05, noise, vib: 12, vibRate: 5.3, swell: 0.3 });
    desk(c, all, tune, { oct: 0, n: 6, spread: 15, gain: 0.1, cut: 3000, air: 0.05, noise, vib: 10, swell: 0.3 });
    desk(c, all, tune, { oct: -12, n: 5, spread: 9, width: 0.45, gain: 0.13, cut: 1300, vib: 4, vibRate: 4.4, swell: 0.3, drive: 1.5 });
  } },
  // Поражение: всё уходит вниз, одна линия над низкими струнами
  defeat: { sec: BAR * 10, rate: 22050, wet: 1.1, level: 0.075, build(c, dest, noise) {
    const lp = filter(c, 'lowpass', 1000, 0.5);
    lp.connect(dest);
    const vib = vibrato(c, 4.4, 6), seq = [['Dm', 2], ['Bb', 2], ['Gm', 2], ['D5', 4]];
    let bar = 0;
    for (const [k, bars] of seq) {
      const ch = CHORD[k], t = bar * BAR, dur = bars * BAR + 0.9;
      for (const m of [ch.v[0], ch.v[1], ch.bass + 12]) stack(c, lp, t, dur, note(m), { n: 4, spread: 12, gain: 0.08, attack: 0.9, release: 1.2, peak: 0.6, vib, width: 0.8 });
      stack(c, dest, t, dur, note(ch.bass), { n: 1, gain: 0.16, attack: 0.5, release: 1, peak: 0.5, type: 'sine', width: 0 });
      bar += bars;
    }
    drum(c, dest, noise, 0, 1, { from: 56, to: 28, fall: 0.7, decay: 3.2, slap: 400 });
    desk(c, dest, [[69, 8], [65, 8], [62, 8], [57, 16]], { n: 5, spread: 13, gain: 0.07, cut: 2000, vib: 8, vibRate: 4.6, swell: 0.5 });
  } },
};

// Рендер партии в буфер. Хвост реверберации заворачивается в начало, чтобы петля была бесшовной.
// Громкость выравнивается по RMS: тембры разные, и только так их можно честно смешать
async function renderStem(def, loop) {
  const seconds = loop ? def.bars * BAR : def.sec;
  const rate = def.rate, chans = def.ch || 2;
  const total = Math.ceil((seconds + TAIL) * rate);
  const c = new OfflineAudioContext(chans, total, rate);
  const noise = noiseBuffer(c);
  const inp = room(c, def.wet);
  def.build(c, inp, noise);
  const out = await c.startRendering();
  let res = out;
  if (loop) {
    const len = Math.round(seconds * rate);
    res = new AudioBuffer({ numberOfChannels: chans, length: len, sampleRate: rate });
    for (let ch = 0; ch < chans; ch++) {
      const from = out.getChannelData(ch), to = res.getChannelData(ch);
      to.set(from.subarray(0, len));
      for (let i = len; i < total; i++) to[(i - len) % len] += from[i];
    }
  }
  let sum = 0, peak = 0;
  for (let ch = 0; ch < chans; ch++) {
    const d = res.getChannelData(ch);
    for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); sum += v * v; if (v > peak) peak = v; }
  }
  const rms = Math.sqrt(sum / (res.length * chans));
  const k = Math.min(def.level / Math.max(rms, 1e-5), 0.98 / Math.max(peak, 1e-5));
  for (let ch = 0; ch < chans; ch++) {
    const d = res.getChannelData(ch);
    for (let i = 0; i < d.length; i++) d[i] *= k;
  }
  return res;
}

// По четыре партии разом: рендер идёт в своих потоках, а между сборками основной поток успевает отрисовать кадр
export async function renderAll() {
  const buffers = {};
  const jobs = [
    ...Object.entries(STEMS).map(([k, d]) => [k, d, true]),
    ...Object.entries(SHOTS).map(([k, d]) => [k, d, false]),
  ];
  const worker = async () => {
    while (jobs.length) {
      const [k, d, loop] = jobs.shift();
      buffers[k] = await renderStem(d, loop);
      await new Promise((r) => setTimeout(r));
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return buffers;
}

// Этапы боя и как в них собирается оркестр: [громкость, через сколько тактов вступает]. Партии входят
// по очереди, поэтому плотность и громкость растут постепенно, а самое большое остаётся на конец
const MIX = {
  wave:  { synth: [0.9, 0],  bass: [0.55, 0], pulse: [0.45, 2], strings: [0.4, 6],  drums: [0.3, 8],  toms: [0.3, 8],  brass: [0.28, 14], choir: [0.2, 8],  lead: [0, 0],    horn: [0, 0],     counter: [0.25, 4], piano: [0.7, 0] },
  duel:  { synth: [0.75, 0], bass: [0.85, 0], pulse: [0.72, 0], strings: [0.7, 0],  drums: [0.6, 0],  toms: [0.55, 0], brass: [0.5, 0],   choir: [0.25, 8], lead: [0.55, 4], horn: [0.3, 8],   counter: [0.45, 4], piano: [0.35, 0] },
  rise:  { synth: [0.75, 0], bass: [1, 0],    pulse: [0.9, 0],  strings: [0.85, 0], drums: [0.8, 0],  toms: [0.8, 0],  brass: [0.75, 0],  choir: [0.5, 0],  lead: [0.8, 0],  horn: [0.65, 2],  counter: [0.7, 0],  piano: [0.3, 0] },
  space: { synth: [1, 0],    bass: [0.45, 0], pulse: [0.2, 0],  strings: [0.95, 0], drums: [0, 0],    toms: [0, 0],    brass: [0.25, 0],  choir: [0.9, 0],  lead: [1, 0],    horn: [0.5, 0],   counter: [0.6, 0],  piano: [1, 0] },
  fall:  { synth: [0.7, 0],  bass: [1, 0],    pulse: [1, 0],    strings: [1, 0],    drums: [1.05, 0], toms: [1.05, 0], brass: [1, 0],     choir: [1, 0],    lead: [1, 0],    horn: [1, 0],     counter: [0.9, 0],  piano: [0.4, 0] },
  rage:  { synth: [0.8, 0],  bass: [1.05, 0], pulse: [1, 0],    strings: [1, 0],    drums: [1.1, 0],  toms: [1.1, 0],  brass: [1, 0],     choir: [0.8, 0],  lead: [1, 0],    horn: [1, 0],     counter: [1, 0],    piano: [0.35, 0] },
  last:  { synth: [0.6, 0],  bass: [0.9, 0],  pulse: [0.55, 0], strings: [1.1, 0],  drums: [0.8, 0],  toms: [0.8, 0],  brass: [1, 0],     choir: [1.1, 0],  lead: [1.15, 0], horn: [1.1, 0],   counter: [1, 0],    piano: [0.6, 0] },
};

export class BattleTheme {
  constructor(audio) {
    this.audio = audio;
    this.buffers = null;
    this.playing = false;
    this.muted = true;
    this.section = null;
    this.wantStart = null;
    this.gains = {};
    this.shots = new Set();
  }

  // Рендер идёт не в основном потоке: запускаем заранее, при старте режима
  prepare() {
    if (this.preparing) return this.preparing;
    this.preparing = renderAll().then((b) => {
      this.buffers = b;
      if (this.wantStart) { const s = this.wantStart; this.wantStart = null; this.start(s); }
      return b;
    });
    return this.preparing;
  }

  buildGraph() {
    const A = this.audio, ctx = A.ctx;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0;
    // Провал на сильных ударах: удар не спорит с оркестром, а прорезает его
    this.duckG = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 3; comp.attack.value = 0.02; comp.release.value = 0.35; comp.knee.value = 12;
    const limit = ctx.createDynamicsCompressor();
    limit.threshold.value = -4; limit.ratio.value = 20; limit.attack.value = 0.002; limit.release.value = 0.1; limit.knee.value = 0;
    this.bus.connect(this.duckG).connect(comp).connect(limit).connect(A.muffle);
    for (const k of Object.keys(STEMS)) {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(this.bus);
      this.gains[k] = g;
    }
  }

  start(section = 'wave') {
    const A = this.audio;
    if (!A.ctx) return;
    if (!this.buffers) { this.wantStart = section; this.prepare(); return; }
    if (this.playing) { this.setSection(section); return; }
    if (!this.bus) this.buildGraph();
    const ctx = A.ctx;
    this.playing = true;
    // Своя тема молчит, пока её не попросят: играет с партитурой на беззвучной шине, чтобы N включила её вовремя
    if (this.muted) {
      this.bus.gain.cancelScheduledValues(ctx.currentTime);
      this.bus.gain.value = 0;
    }
    this.t0 = ctx.currentTime + 0.12;
    this.sources = Object.keys(STEMS).map((k) => {
      const s = ctx.createBufferSource();
      s.buffer = this.buffers[k];
      s.loop = true;
      s.connect(this.gains[k]);
      s.start(this.t0);
      return s;
    });
    A.themeOn = true;
    this.section = null;
    this.setSection(section, true);
    this.applyVolume();
  }

  // Ближайшая смена аккорда, до которой остаётся хотя бы такт
  nextChange() {
    const t = this.audio.ctx.currentTime;
    return this.t0 + Math.ceil((t - this.t0 + BAR) / CHANGE) * CHANGE;
  }

  setSection(name, instant = false) {
    if (this.section === name || !this.playing) return;
    const ctx = this.audio.ctx, mix = MIX[name];
    this.section = name;
    const at = instant ? ctx.currentTime : this.nextChange();
    // Нарастание дотягивается ровно до начала этапа
    if (!instant) this.shot('riser', at - CHANGE, 0.85);
    for (const k of Object.keys(STEMS)) {
      const [level, delay] = mix[k], g = this.gains[k].gain, when = at + delay * BAR;
      g.cancelScheduledValues(ctx.currentTime);
      // Партия с задержкой ждёт на том, что было: вступает плавно, как в партитуре
      g.setTargetAtTime(level, when, instant ? 2.5 : 3.2);
    }
  }

  // when в прошлом — играем с нужного места: разовая часть всё равно заканчивается вовремя
  shot(name, when, gain = 1) {
    const ctx = this.audio.ctx;
    if (!ctx || !this.buffers || !this.bus) return;
    const s = ctx.createBufferSource(), g = ctx.createGain(), now = ctx.currentTime;
    const at = when ?? now;
    s.buffer = this.buffers[name];
    g.gain.value = gain;
    s.connect(g).connect(this.bus);
    s.onended = () => { this.shots.delete(s); s.disconnect(); g.disconnect(); };
    this.shots.add(s);
    if (at < now) s.start(now, now - at);
    else s.start(at);
  }

  stinger() { if (this.playing && !this.muted && this.section !== 'end') this.shot('stinger', undefined, 0.95); }

  // Обрыв: весь оркестр замолкает разом. Дальше только то, что сцена сама попросит сыграть
  cut() {
    if (!this.playing) return;
    const t = this.audio.ctx.currentTime;
    for (const k of Object.keys(STEMS)) {
      const g = this.gains[k].gain;
      g.cancelScheduledValues(t);
      g.setTargetAtTime(0, t, 0.08);
    }
    for (const s of this.shots) { try { s.stop(); } catch { /* уже остановлен */ } }
    this.section = 'end';
  }

  // Оркестр на мгновение проседает под ударом, k 0..1
  duck(k) {
    if (!this.playing || !this.duckG) return;
    const g = this.duckG.gain, t = this.audio.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(1 - 0.7 * k, t, 0.006);
    g.setTargetAtTime(1, t + 0.06 + 0.1 * k, 0.42);
  }

  // Финал: петли стихают, звучит разовая часть. Она доигрывает и на панели итога
  finish(win) {
    if (!this.playing) return;
    const ctx = this.audio.ctx;
    for (const k of Object.keys(STEMS)) {
      const g = this.gains[k].gain;
      g.cancelScheduledValues(ctx.currentTime);
      g.setTargetAtTime(0, ctx.currentTime + 0.2, 1.1);
    }
    this.section = 'end';
    this.shot(win ? 'victory' : 'defeat', ctx.currentTime + 0.5, 0.95);
  }

  applyVolume() {
    if (!this.bus) return;
    const t = this.audio.ctx.currentTime;
    const off = this.muted || (this.paused && this.section !== 'end');
    this.bus.gain.setTargetAtTime(off ? 0 : 0.62, t, this.paused ? 0.15 : 0.4);
  }

  setPaused(p) {
    if (this.paused === p) return;
    this.paused = p;
    this.applyVolume();
  }

  // M: свой трек играет — пауза, не играет — трек с места, где остановился, а тема боя уходит. Возвращает текст подсказки
  next() {
    const A = this.audio;
    if (!A.tracks.length) return 'Положите файлы в папку music/';
    if (A.music && !A.music.paused) {
      A.musicOn = false;
      A.music.pause();
      return '♪ Пауза';
    }
    this.muted = true;
    this.applyVolume();
    A.musicOn = true;
    A.musicHold = false;
    A.playTrack(A.trackIndex);
    return `♪ ${decodeURIComponent(A.tracks[A.trackIndex].split('/').pop())}`;
  }

  // N: тема боя звучит только по этой клавише. Свой трек на это время встаёт на паузу
  toggle() {
    this.muted = !this.muted;
    this.audio.holdMusic(!this.muted);
    if (!this.muted && !this.playing) this.start('wave');
    this.applyVolume();
    return !this.muted;
  }

  stop() {
    const A = this.audio;
    this.muted = true;
    if (!this.playing) { this.wantStart = null; A.holdMusic(false); return; }
    this.playing = false;
    this.paused = false;
    this.section = null;
    const t = A.ctx.currentTime;
    for (const k of Object.keys(STEMS)) this.gains[k].gain.cancelScheduledValues(t);
    this.bus.gain.cancelScheduledValues(t);
    this.bus.gain.setTargetAtTime(0, t, 0.3);
    const S = this.sources, Sh = [...this.shots];
    this.shots.clear();
    setTimeout(() => {
      for (const s of [...S, ...Sh]) { try { s.stop(); s.disconnect(); } catch { /* уже остановлен */ } }
      for (const k of Object.keys(STEMS)) if (!this.playing) this.gains[k].gain.value = 0;
    }, 1600);
    A.themeOn = false;
    A.holdMusic(false);
  }
}
