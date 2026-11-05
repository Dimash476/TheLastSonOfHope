// Боевая тема режима «Вторжение». Своя музыка в духе больших партитур Ханса Циммера: медленная гармония
// без лишних терций, широкая восходящая линия струнных длинными нотами, низкая медь, пульсирующий бас,
// протяжные синтезаторы, редкие огромные удары и зал с почти бесконечным хвостом.
// Мелодия написана для этой игры, из фильмов ничего не взято.
//
// Весь оркестр заранее рендерится в петли (OfflineAudioContext), в игре они просто проигрываются
// и микшируются по этапам боя — кадровой частоте это ничего не стоит.

const BPM = 76;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
const STEP = BEAT / 4;
const CHANGE = BAR * 2;   // смена аккорда и всех крупных событий
const TAIL = 8;

const note = (m) => 440 * Math.pow(2, (m - 69) / 12);

// Ре минор. Аккорд держится два такта; голоса почти не двигаются, опора на квинты
const CHORD = {
  Dm:   { bass: 38, v: [50, 57, 62, 65, 69] },
  Bb:   { bass: 34, v: [50, 58, 62, 65, 70] },
  F:    { bass: 41, v: [48, 57, 60, 65, 69] },
  C:    { bass: 36, v: [48, 55, 62, 67, 72] },
  Gm:   { bass: 31, v: [50, 58, 62, 67, 70] },
  Asus: { bass: 33, v: [52, 57, 62, 64, 69] },
  A:    { bass: 33, v: [52, 57, 61, 64, 69] },
  D:    { bass: 38, v: [50, 57, 62, 66, 69] },
  D5:   { bass: 38, v: [50, 57, 62, 69, 74] },
};
// [аккорд, тактов]; 16 тактов, напряжение копится к последнему
const FORM = [['Dm', 2], ['Bb', 2], ['F', 2], ['C', 2], ['Dm', 2], ['Bb', 2], ['Gm', 2], ['Asus', 1], ['A', 1]];

function eachChord(fn) {
  let bar = 0;
  for (const [k, bars] of FORM) {
    fn(CHORD[k], bar * BAR, bars, bar);
    bar += bars;
  }
}

// Широкая линия на 16 тактов: [нота MIDI, длина в долях]. Каждая фраза начинается выше предыдущей
const LINE = [
  [62, 2], [69, 6],
  [70, 2], [69, 2], [65, 4],
  [65, 2], [69, 2], [72, 4],
  [74, 2], [72, 2], [67, 4],
  [69, 2], [74, 6],
  [77, 2], [74, 2], [70, 4],
  [70, 2], [74, 2], [79, 4],
  [76, 4], [73, 4],
];

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
  let beat = 0;
  for (const [m, len] of line) {
    const t = start + beat * BEAT, dur = len * BEAT, f = note(m + oct), at = Math.max(start, t - 0.01);
    for (const o of oscs) {
      if (beat === 0) o.frequency.setValueAtTime(f, start);
      else o.frequency.setTargetAtTime(f, Math.max(start, t - 0.03), 0.045);
    }
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

// Партии: каждая строит граф в OfflineAudioContext c и занимает bars тактов.
// rate — частота рендера, level — громкость (RMS) после выравнивания: баланс задаётся здесь и в MIX
const STEMS = {
  // Остинато: низкие струнные шестнадцатыми с акцентами 3+3+2, поверх альты восьмыми по аккорду
  pulse: { bars: 16, rate: 24000, wet: 0.2, level: 0.085, build(c, dest) {
    const ACC = [1, 0.34, 0.42, 0.86, 0.34, 0.42, 0.8, 0.42, 1, 0.34, 0.42, 0.86, 0.34, 0.42, 0.8, 0.58];
    const out = filter(c, 'lowpass', 3000, 0.5);
    out.connect(dest);
    eachChord((ch, t0, bars) => {
      for (let s = 0; s < bars * 16; s++) {
        const t = t0 + s * STEP, a = ACC[s % 16], m = ch.bass + 12;
        const f = c.createBiquadFilter(), g = c.createGain();
        f.type = 'lowpass';
        f.Q.value = 1.2;
        f.frequency.setValueAtTime(500 + a * 1900, t);
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
      for (let s = 0; s < bars * 8; s++) {
        const t = t0 + s * 2 * STEP, m = ch.v[[1, 2, 1, 3][s % 4]];
        const g = c.createGain(), p = c.createStereoPanner(), o = c.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = note(m);
        o.detune.value = s % 2 ? 6 : -6;
        p.pan.value = s % 2 ? 0.46 : -0.46;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(s % 4 === 0 ? 0.05 : 0.034, t + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, t + STEP * 1.7);
        o.connect(g).connect(p).connect(out);
        o.start(t);
        o.stop(t + STEP * 1.75);
      }
    });
  } },

  // Низкий пульсирующий бас: ровная волна давления, рисунок тот же 3+3+2
  bass: { bars: 16, rate: 16000, ch: 1, wet: 0.04, level: 0.13, build(c, dest) {
    const sat = shaper(c, 1.8);
    sat.connect(dest);
    const lp = filter(c, 'lowpass', 210, 0.9);
    lp.connect(sat);
    eachChord((ch, t0, bars) => {
      const f0 = note(ch.bass) * (ch.bass > 38 ? 0.5 : 1);
      for (let b = 0; b < bars; b++) {
        for (const [s, k] of [[0, 1], [3, 0.74], [6, 0.82], [8, 0.96], [11, 0.74], [14, 0.82]]) {
          const t = t0 + (b * 16 + s) * STEP, len = STEP * 3.4;
          const g = c.createGain(), o = c.createOscillator(), o2 = c.createOscillator(), g2 = c.createGain();
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(0.55 * k, t + 0.012);
          g.gain.exponentialRampToValueAtTime(0.1 * k, t + len);
          g.gain.linearRampToValueAtTime(0, t + len + 0.02);
          o.frequency.value = f0;
          o.connect(g).connect(dest);
          g2.gain.setValueAtTime(0.0001, t);
          g2.gain.exponentialRampToValueAtTime(0.26 * k, t + 0.012);
          g2.gain.exponentialRampToValueAtTime(0.03 * k, t + len);
          g2.gain.linearRampToValueAtTime(0, t + len + 0.02);
          o2.type = 'sawtooth';
          o2.frequency.value = f0;
          o2.connect(g2).connect(lp);
          for (const x of [o, o2]) { x.start(t); x.stop(t + len + 0.04); }
        }
      }
    });
  } },

  // Протяжные синтезаторные слои: пустые квинты и нона, фильтр медленно дышит на каждом аккорде
  synth: { bars: 16, rate: 16000, wet: 0.95, level: 0.085, build(c, dest) {
    eachChord((ch, t0, bars) => {
      const dur = bars * BAR + 1.2;
      const lp = filter(c, 'lowpass', 300, 2.2), air = filter(c, 'lowpass', 2400, 0.5);
      lp.frequency.setValueAtTime(260, t0);
      lp.frequency.linearRampToValueAtTime(1500, t0 + dur * 0.7);
      lp.frequency.linearRampToValueAtTime(420, t0 + dur);
      lp.connect(dest);
      air.connect(dest);
      for (const m of [ch.bass + 12, ch.bass + 19, ch.bass + 24, ch.bass + 26]) {
        stack(c, lp, t0, dur, note(m), { n: 4, spread: 11, gain: 0.07, attack: 0.9, release: 0.9, peak: 0.72, width: 0.9 });
      }
      for (const m of [ch.bass + 36, ch.bass + 43]) {
        stack(c, air, t0, dur, note(m), { n: 2, spread: 7, gain: 0.012, attack: 1.4, release: 1, peak: 0.7, width: 0.8, type: 'triangle' });
      }
    });
  } },

  // Струнный аккорд: тёплая масса в середине, растёт на всю длину и уходит в зал
  strings: { bars: 16, rate: 24000, wet: 1, level: 0.08, build(c, dest) {
    const hp = filter(c, 'highpass', 110, 0.6), b1 = filter(c, 'peaking', 420, 0.8, 2.5), b3 = filter(c, 'peaking', 2500, 0.8, 3);
    const vib = vibrato(c, 4.9, 8);
    hp.connect(b1).connect(b3).connect(dest);
    eachChord((ch, t0, bars) => {
      const dur = bars * BAR + 0.9, lp = filter(c, 'lowpass', 900, 0.5);
      lp.frequency.setValueAtTime(900, t0);
      lp.frequency.linearRampToValueAtTime(3200, t0 + dur * 0.75);
      lp.frequency.linearRampToValueAtTime(1800, t0 + dur);
      lp.connect(hp);
      for (const m of [...ch.v, ch.bass + 12]) {
        stack(c, lp, t0, dur, note(m), { n: 4, spread: 13, gain: 0.05, attack: 0.5, release: 0.75, peak: 0.74, vib, width: 0.85 });
      }
    });
  } },

  // Широкая линия. Первые 16 тактов — виолончели и альты, вторые — вступают скрипки октавой выше
  lead: { bars: 32, rate: 24000, wet: 1.1, level: 0.085, build(c, dest, noise) {
    const twice = [...LINE, ...LINE];
    desk(c, dest, twice, { oct: -12, n: 5, spread: 13, gain: 0.08, cut: 2400, air: 0.05, noise, vibRate: 4.7, vib: 9 });
    desk(c, dest, twice, { oct: 0, n: 6, spread: 15, gain: 0.1, cut: 3400, air: 0.05, noise, vibRate: 5.1, vib: 10 });
    const fade = c.createGain();
    fade.gain.setValueAtTime(0, 0);
    fade.gain.setValueAtTime(0, 14 * BAR);
    fade.gain.linearRampToValueAtTime(1, 16 * BAR);
    fade.gain.setValueAtTime(1, 31.5 * BAR);
    fade.gain.linearRampToValueAtTime(0, 32 * BAR);
    fade.connect(dest);
    desk(c, fade, twice, { oct: 12, n: 7, spread: 17, gain: 0.1, cut: 5200, air: 0.06, noise, vibRate: 5.5, vib: 12 });
  } },

  // Горны и тромбоны в унисон с линией, двумя октавами вниз: глубокая медь под струнами
  horn: { bars: 32, rate: 16000, wet: 0.85, level: 0.08, build(c, dest) {
    const twice = [...LINE, ...LINE];
    desk(c, dest, twice, { oct: -12, n: 5, spread: 9, width: 0.45, gain: 0.13, cut: 1300, vib: 4, vibRate: 4.4, swell: 0.3, drive: 1.5 });
    desk(c, dest, twice, { oct: -24, n: 4, spread: 7, width: 0.3, gain: 0.13, cut: 700, vib: 2, vibRate: 4.1, swell: 0.3, drive: 1.9 });
  } },

  // Низкая медь: на каждой смене аккорда длинный набухающий удар, фильтр раскрывается и закрывается
  brass: { bars: 16, rate: 22050, wet: 0.8, level: 0.09, build(c, dest) {
    const sat = shaper(c, 2.5);
    sat.connect(dest);
    eachChord((ch, t0, bars, bar) => {
      const dur = bars * BAR + 0.5, big = bar % 8 === 0 ? 1 : 0.76;
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.Q.value = 1.1;
      f.frequency.setValueAtTime(170, t0);
      f.frequency.exponentialRampToValueAtTime(700 + big * 1200, t0 + Math.min(1, dur * 0.3));
      f.frequency.exponentialRampToValueAtTime(320, t0 + dur);
      f.connect(sat);
      for (const [dm, w] of [[0, 0.8], [12, 1], [19, 0.8], [24, 0.8]]) {
        stack(c, f, t0, dur, note(ch.bass + dm), { n: 4, spread: 10, gain: 0.085 * big * w, attack: 0.16, release: 0.7, peak: 0.28, width: 0.5 });
      }
    });
  } },

  // Низкий мужской хор на открытых квинтах
  choir: { bars: 16, rate: 16000, wet: 1.1, level: 0.055, build(c, dest) {
    const bus = c.createGain();
    for (const [f, q, g] of [[520, 6, 1], [950, 8, 0.65], [2500, 9, 0.22]]) {
      const a = c.createGain();
      a.gain.value = g;
      bus.connect(filter(c, 'bandpass', f, q)).connect(a).connect(dest);
    }
    const vib = vibrato(c, 4.3, 9);
    eachChord((ch, t0, bars) => {
      const dur = bars * BAR + 1;
      for (const m of [ch.bass + 12, ch.bass + 19, ch.bass + 24, ch.bass + 31]) {
        stack(c, bus, t0, dur, note(m), { n: 3, spread: 10, gain: 0.26, attack: 1.1, release: 1, peak: 0.7, vib, width: 0.7 });
      }
    });
  } },

  // Огромные удары только на акцентах; к концу каждой восьмитактовой фразы — раскат и тарелка
  drums: { bars: 16, rate: 28000, wet: 0.6, level: 0.1, build(c, dest, noise) {
    const sat = shaper(c, 1.9);
    sat.connect(dest);
    const GRAN = { from: 60, to: 30, fall: 0.55, decay: 2.6, slap: 560 };
    const TAIKO = { from: 108, to: 54, fall: 0.2, decay: 0.95, slap: 1500 };
    for (let bar = 0; bar < 16; bar += 2) {
      const t = bar * BAR;
      const at = (s) => t + s * STEP;
      drum(c, sat, noise, at(0), 1, GRAN);
      drum(c, sat, noise, at(0), 0.75, TAIKO);
      drum(c, sat, noise, at(6), 0.55, TAIKO);
      drum(c, sat, noise, at(12), 0.62, TAIKO);
      drum(c, sat, noise, at(16), 0.8, GRAN);
      drum(c, sat, noise, at(22), 0.5, TAIKO);
      drum(c, sat, noise, at(28), 0.6, TAIKO);
      if (bar % 8 === 6) {
        // Раскат: чем дальше, тем сильнее; тон не растёт, только сила
        for (let s = 24; s < 32; s++) drum(c, sat, noise, at(s), 0.34 + (s - 24) * 0.075, { ...TAIKO, players: 2 });
        burst(c, dest, at(16), 16 * STEP, noise, { type: 'highpass', freq: 2600, gain: 0.2, attack: 16 * STEP * 0.95 });
      } else {
        drum(c, sat, noise, at(30), 0.72, TAIKO);
      }
      if (bar % 8 === 0) burst(c, dest, t, 3.6, noise, { type: 'highpass', freq: 2200, gain: 0.3, attack: 0.004 });
    }
  } },
};

// Разовые: нарастание перед новым этапом, удар медью, победа, поражение.
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
  // Победа без фанфар: линия поднимается редкими нотами, в конце минор уходит в чистый ре мажор
  victory: { sec: BAR * 13, rate: 24000, wet: 1.1, level: 0.11, build(c, dest, noise) {
    const sat = shaper(c, 1.6);
    sat.connect(dest);
    const vib = vibrato(c, 5, 8), seq = [['Bb', 2], ['F', 2], ['Gm', 2], ['Asus', 1], ['A', 1], ['D', 6]];
    const lp = filter(c, 'lowpass', 2800, 0.5);
    lp.connect(dest);
    let bar = 0;
    for (const [k, bars] of seq) {
      const ch = CHORD[k], t = bar * BAR, dur = bars * BAR + 0.8, last = k === 'D';
      for (const m of [...ch.v, ch.bass + 12]) stack(c, lp, t, dur, note(m), { n: 4, spread: 13, gain: 0.05, attack: 0.6, release: last ? 3 : 0.8, peak: last ? 0.3 : 0.7, vib, width: 0.85 });
      for (const m of [ch.bass + 12, ch.bass + 19]) stack(c, sat, t, dur, note(m), { n: 3, spread: 8, gain: 0.05, attack: 0.5, release: last ? 3 : 0.8, peak: last ? 0.3 : 0.6, width: 0.4 });
      stack(c, dest, t, dur, note(ch.bass), { n: 1, gain: 0.2, attack: 0.3, release: last ? 3 : 0.5, peak: 0.5, type: 'sine', width: 0 });
      drum(c, sat, noise, t, last ? 1 : 0.5, { from: 58, to: 30, fall: 0.55, decay: 2.6, slap: 500 });
      bar += bars;
    }
    const tune = [[70, 4], [74, 4], [72, 4], [77, 4], [74, 4], [79, 4], [76, 4], [73, 4], [74, 24]];
    desk(c, dest, tune, { oct: 12, n: 7, spread: 17, gain: 0.09, cut: 4600, air: 0.05, noise, vib: 12, vibRate: 5.3, swell: 0.3 });
    desk(c, dest, tune, { oct: 0, n: 6, spread: 15, gain: 0.1, cut: 3000, air: 0.05, noise, vib: 10, swell: 0.3 });
    desk(c, dest, tune, { oct: -12, n: 5, spread: 9, width: 0.45, gain: 0.13, cut: 1300, vib: 4, vibRate: 4.4, swell: 0.3, drive: 1.5 });
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
  wave:  { synth: [0.9, 0],  bass: [0.55, 0], pulse: [0.45, 2], strings: [0.4, 6],   drums: [0.34, 8],  brass: [0.28, 14], choir: [0, 0],    lead: [0, 0],     horn: [0, 0] },
  duel:  { synth: [0.75, 0], bass: [0.85, 0], pulse: [0.72, 0], strings: [0.7, 0],   drums: [0.65, 0],  brass: [0.5, 0],   choir: [0.25, 8], lead: [0.55, 4],  horn: [0.3, 8] },
  rise:  { synth: [0.75, 0], bass: [1, 0],    pulse: [0.9, 0],  strings: [0.85, 0],  drums: [0.85, 0],  brass: [0.75, 0],  choir: [0.5, 0],  lead: [0.8, 0],   horn: [0.65, 2] },
  space: { synth: [1, 0],    bass: [0.45, 0], pulse: [0.2, 0],  strings: [0.95, 0],  drums: [0, 0],     brass: [0.25, 0],  choir: [0.9, 0],  lead: [1, 0],     horn: [0.5, 0] },
  fall:  { synth: [0.7, 0],  bass: [1, 0],    pulse: [1, 0],    strings: [1, 0],     drums: [1.05, 0],  brass: [1, 0],     choir: [1, 0],    lead: [1, 0],     horn: [1, 0] },
  rage:  { synth: [0.8, 0],  bass: [1.05, 0], pulse: [1, 0],    strings: [1, 0],     drums: [1.1, 0],   brass: [1, 0],     choir: [0.8, 0],  lead: [1, 0],     horn: [1, 0] },
  last:  { synth: [0.6, 0],  bass: [0.9, 0],  pulse: [0.55, 0], strings: [1.1, 0],   drums: [0.8, 0],   brass: [1, 0],     choir: [1.1, 0],  lead: [1.15, 0],  horn: [1.1, 0] },
};

export class BattleTheme {
  constructor(audio) {
    this.audio = audio;
    this.buffers = null;
    this.playing = false;
    this.muted = false;
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
    this.t0 = ctx.currentTime + 0.12;
    this.sources = Object.keys(STEMS).map((k) => {
      const s = ctx.createBufferSource();
      s.buffer = this.buffers[k];
      s.loop = true;
      s.connect(this.gains[k]);
      s.start(this.t0);
      return s;
    });
    A.holdMusic(true);
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

  stinger() { if (this.playing && !this.muted) this.shot('stinger', undefined, 0.95); }

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

  // M: тема → свои треки из music/ по очереди → снова тема. Возвращает текст подсказки
  next() {
    const A = this.audio;
    if (!A.tracks.length) return 'Положите файлы в папку music/ — пока играет тема боя';
    if (!this.muted) {
      this.muted = true;
      this.trackPos = 0;
      A.themeOn = false;
      this.applyVolume();
      A.musicOn = true;
      A.musicHold = false;
      A.playTrack(0);
      return `♪ ${decodeURIComponent(A.tracks[0].split('/').pop())}`;
    }
    if (this.trackPos < A.tracks.length - 1) {
      this.trackPos++;
      A.playTrack(this.trackPos);
      return `♪ ${decodeURIComponent(A.tracks[this.trackPos].split('/').pop())}`;
    }
    this.muted = false;
    A.holdMusic(true);
    A.themeOn = true;
    this.applyVolume();
    return '♪ Тема боя';
  }

  // N: выключить или вернуть тему
  toggle() {
    this.muted = !this.muted;
    this.audio.themeOn = !this.muted;
    this.applyVolume();
    return !this.muted;
  }

  stop() {
    const A = this.audio;
    if (!this.playing) { this.wantStart = null; return; }
    this.playing = false;
    this.muted = false;
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
