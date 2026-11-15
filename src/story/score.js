// Музыка режима «Сюжет». Своя партитура: у каждого героя свой мотив, сцена берёт нужную реплику (cue).
// Все мелодии написаны для этой игры. Синтез тот же по духу, что у боевой темы: реплика заранее рендерится
// в буфер (OfflineAudioContext) и в игре просто проигрывается — кадровой частоте это ничего не стоит.
//
// Лейтмотивы (полностью — в docs/story.md, раздел «Музыка»):
//  · Илена — ми дорийский, виолончель соло: подъём на квинту, спуск, тоска на до-диезе (дорийская секста);
//  · Ксарг и империя — низкая медь: ми — фа — ми — си — до, полутон вверх и тритон вниз, военные барабаны;
//  · Надежда (главная тема) — тот же ход ми — си — ми, что у Илены, но в мажоре и у валторн: сын договаривает мать.

const note = (m) => 440 * Math.pow(2, (m - 69) / 12);
const TAIL = 7;

// ---------------------------------------------------------------- зал и общие узлы
const IRS = new Map();
function impulse(rate, seconds = 6) {
  const key = rate * 100 + seconds;
  if (IRS.has(key)) return IRS.get(key);
  const pre = Math.floor(rate * 0.04), n = Math.floor(rate * seconds);
  const buf = new AudioBuffer({ numberOfChannels: 2, length: n, sampleRate: rate });
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / (n - pre);
      lp += ((Math.random() * 2 - 1) - lp) * (0.55 - 0.48 * Math.min(1, t * 2.2));
      d[i] = lp * Math.pow(1 - t, 1.6) * Math.exp(-t * 2.8);
    }
    for (let k = 0; k < 8; k++) d[pre + Math.floor(rate * (0.01 + Math.random() * 0.12))] += (Math.random() < 0.5 ? -1 : 1) * (0.45 - k * 0.04);
  }
  IRS.set(key, buf);
  return buf;
}

function noiseBuffer(c, sec = 2) {
  const n = Math.floor(c.sampleRate * sec), buf = c.createBuffer(1, n, c.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function filter(c, type, freq, q = 0.7, gain = 0) {
  const f = c.createBiquadFilter();
  f.type = type; f.frequency.value = freq; f.Q.value = q; f.gain.value = gain;
  return f;
}

// Сухой сигнал + зал (низ в зал не идёт)
function room(c, wet, seconds) {
  const inp = c.createGain(), w = c.createGain(), conv = c.createConvolver(), hp = filter(c, 'highpass', 150);
  conv.buffer = impulse(c.sampleRate, seconds);
  w.gain.value = wet;
  inp.connect(c.destination);
  inp.connect(conv).connect(hp).connect(w).connect(c.destination);
  return inp;
}

// ---------------------------------------------------------------- инструменты
// Ровный пласт: несколько расстроенных пил, медленная атака, тёмный фильтр (струнный фон, хоровой «аах»)
function pad(c, dest, t, dur, notes, { gain = 0.04, attack = 2, release = 2.5, cut = 1400, n = 3, spread = 10, type = 'sawtooth', formant = false } = {}) {
  const g = c.createGain(), lp = filter(c, 'lowpass', cut, 0.4);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + attack);
  g.gain.setValueAtTime(gain, Math.max(t + attack, t + dur - release));
  g.gain.linearRampToValueAtTime(0, t + dur);
  if (formant) {
    // «Аах»: две форманты гласной поверх приглушённого сигнала
    const dry = c.createGain(), f1 = filter(c, 'bandpass', 720, 4), f2 = filter(c, 'bandpass', 1150, 5), mix = c.createGain();
    dry.gain.value = 0.25;
    g.connect(lp);
    lp.connect(dry).connect(mix);
    lp.connect(f1).connect(mix);
    lp.connect(f2).connect(mix);
    mix.gain.value = 1.6;
    mix.connect(dest);
  } else g.connect(lp).connect(dest);
  for (const m of notes) {
    for (let i = 0; i < n; i++) {
      const k = n > 1 ? (i / (n - 1)) * 2 - 1 : 0;
      const o = c.createOscillator(), p = c.createStereoPanner();
      o.type = type;
      o.frequency.value = note(m);
      o.detune.value = k * spread + (Math.random() - 0.5) * 4;
      p.pan.value = k * 0.7;
      o.connect(p).connect(g);
      o.start(t); o.stop(t + dur + 0.05);
    }
  }
}

// Смычковое соло (виолончель): одни генераторы на всю фразу, ноты перетекают, смычок проседает и набухает,
// вибрато вступает с опозданием; шорох смычка из шума
function bow(c, dest, noise, t0, line, beat, { oct = 0, gain = 0.09, cut = 2600, vib = 14, n = 4, spread = 7, pan = 0, swell = 0.4 } = {}) {
  const env = c.createGain(), lp = filter(c, 'lowpass', cut, 0.5), hp = filter(c, 'highpass', 70, 0.6);
  const b1 = filter(c, 'peaking', 260, 1.1, 5), b2 = filter(c, 'peaking', 900, 1.2, 2), b3 = filter(c, 'peaking', 2300, 1, 3);
  const p = c.createStereoPanner();
  p.pan.value = pan;
  env.connect(hp).connect(b1).connect(b2).connect(b3).connect(lp).connect(p).connect(dest);
  const vg = c.createGain(), lfo = c.createOscillator();
  vg.gain.value = 0;
  lfo.frequency.value = 5.2;
  lfo.connect(vg);
  let total = 0;
  for (const [, len] of line) total += len;
  const end = t0 + total * beat;
  lfo.start(t0); lfo.stop(end + 0.1);
  const oscs = [];
  for (let i = 0; i < n; i++) {
    const k = n > 1 ? (i / (n - 1)) * 2 - 1 : 0;
    const o = c.createOscillator();
    o.type = 'sawtooth';
    o.detune.value = k * spread;
    vg.connect(o.detune);
    o.connect(env);
    o.start(t0); o.stop(end + 0.1);
    oscs.push(o);
  }
  const s = c.createBufferSource(), a = c.createGain();
  s.buffer = noise; s.loop = true; a.gain.value = 0.012;
  s.connect(filter(c, 'bandpass', 3200, 0.7)).connect(a).connect(env);
  s.start(t0); s.stop(end + 0.1);
  env.gain.setValueAtTime(0, t0);
  let b = 0, first = true;
  for (const [m, len] of line) {
    const t = t0 + b * beat, dur = len * beat;
    if (m === null) { env.gain.setTargetAtTime(0, Math.max(t0, t - 0.02), 0.2); b += len; continue; }
    const f = note(m + oct);
    for (const o of oscs) {
      if (first) o.frequency.setValueAtTime(f, t0);
      else o.frequency.setTargetAtTime(f, Math.max(t0, t - 0.04), 0.05);
    }
    first = false;
    env.gain.setTargetAtTime(gain * 0.55, Math.max(t0, t - 0.01), 0.05);
    env.gain.setTargetAtTime(gain, t + 0.08, dur * swell);
    lp.frequency.setTargetAtTime(cut * 0.55, Math.max(t0, t - 0.01), 0.05);
    lp.frequency.setTargetAtTime(cut, t + 0.08, dur * swell);
    vg.gain.setTargetAtTime(vib * 0.15, t, 0.05);
    vg.gain.setTargetAtTime(vib, t + 0.45, 0.6);
    b += len;
  }
  env.gain.setTargetAtTime(0, end - 0.3, 0.25);
}

// Медь: каждая нота — пилы через фильтр, который раскрывается на атаке («бра-а»)
function brass(c, dest, t0, line, beat, { oct = 0, gain = 0.08, n = 4, spread = 9, open = 1600, shut = 380 } = {}) {
  let b = 0;
  for (const [m, len] of line) {
    const t = t0 + b * beat, dur = len * beat;
    b += len;
    if (m === null) continue;
    const g = c.createGain(), lp = filter(c, 'lowpass', shut, 1.2);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.09);
    g.gain.setTargetAtTime(gain * 0.8, t + 0.2, 0.4);
    g.gain.setTargetAtTime(0, t + dur - 0.12, 0.08);
    lp.frequency.setValueAtTime(shut, t);
    lp.frequency.linearRampToValueAtTime(open, t + 0.12);
    lp.frequency.setTargetAtTime(open * 0.6, t + 0.2, 0.5);
    g.connect(lp).connect(dest);
    for (let i = 0; i < n; i++) {
      const k = n > 1 ? (i / (n - 1)) * 2 - 1 : 0;
      const o = c.createOscillator(), p = c.createStereoPanner();
      o.type = 'sawtooth';
      o.frequency.value = note(m + oct);
      o.detune.value = k * spread;
      p.pan.value = k * 0.5;
      o.connect(p).connect(g);
      o.start(t); o.stop(t + dur + 0.3);
    }
  }
}

// Рояль: затухающие обертоны и стук молоточка
function piano(c, dest, noise, t, m, k, { len = 5, pan = 0 } = {}) {
  const f = note(m), p = c.createStereoPanner();
  p.pan.value = pan;
  p.connect(dest);
  for (const [r, a, d] of [[1, 1, 1], [2, 0.38, 0.6], [3, 0.16, 0.4], [4.01, 0.06, 0.25]]) {
    const o = c.createOscillator(), g = c.createGain(), end = t + len * d;
    o.frequency.value = f * r;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(k * a, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    o.connect(g).connect(p);
    o.start(t); o.stop(end + 0.02);
  }
  burst(c, p, t, 0.03, noise, { type: 'bandpass', freq: Math.min(f * 6, 6000), q: 0.8, gain: k * 0.12 });
}

function burst(c, dest, t, dur, noise, { type = 'lowpass', freq = 800, to = null, q = 1, gain = 0.3, attack = 0.002, pan = 0 } = {}) {
  const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
  s.buffer = noise; s.loop = true;
  f.type = type; f.Q.value = q;
  f.frequency.setValueAtTime(freq, t);
  if (to) f.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f).connect(g);
  if (pan) { const p = c.createStereoPanner(); p.pan.value = pan; g.connect(p).connect(dest); } else g.connect(dest);
  s.start(t, Math.random()); s.stop(t + dur + 0.02);
}

// Большой барабан / литавра: мембрана падает по тону, сверху глухой удар
function drum(c, dest, noise, t, k, { from = 62, to = 32, fall = 0.45, decay = 2.2, slap = 520, players = 2 } = {}) {
  for (let i = 0; i < players; i++) {
    const pan = players > 1 ? (i / (players - 1)) * 2 - 1 : 0, at = t + (i ? Math.random() * 0.01 : 0);
    const o = c.createOscillator(), g = c.createGain(), p = c.createStereoPanner();
    o.frequency.setValueAtTime(from, at);
    o.frequency.exponentialRampToValueAtTime(to, at + fall);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(k * 0.6, at + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, at + decay);
    p.pan.value = pan * 0.35;
    o.connect(g).connect(p).connect(dest);
    o.start(at); o.stop(at + decay + 0.02);
    burst(c, dest, at, 0.11, noise, { freq: slap, to: 120, gain: k * 0.26, pan: pan * 0.35 });
  }
}

// Нарастание: шум с поднимающимся фильтром и поднимающийся тон
function riser(c, dest, noise, t, dur, k = 0.2) {
  burst(c, dest, t, dur, noise, { type: 'bandpass', freq: 300, to: 7000, q: 1.4, gain: k, attack: dur * 0.9 });
  const o = c.createOscillator(), g = c.createGain();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(110, t);
  o.frequency.exponentialRampToValueAtTime(880, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(k * 0.12, t + dur * 0.95);
  g.gain.linearRampToValueAtTime(0, t + dur + 0.02);
  o.connect(filter(c, 'lowpass', 2400)).connect(g).connect(dest);
  o.start(t); o.stop(t + dur + 0.05);
}

// Удар-«бум»: низ, шумовая волна и долгий хвост в зале
function boom(c, dest, noise, t, k = 1) {
  drum(c, dest, noise, t, k, { from: 70, to: 24, fall: 1.2, decay: 5, slap: 300, players: 3 });
  burst(c, dest, t, 3.5, noise, { freq: 2400, to: 80, gain: k * 0.25, attack: 0.01 });
}

// ---------------------------------------------------------------- лейтмотивы [нота MIDI | null, доли]
// Илена (ми дорийский): квинта вверх, спуск по ступеням; вторая фраза дотягивается до до-диеза и возвращается домой
export const ILENA_A = [[64, 3], [67, 1], [71, 4], [69, 2], [67, 1], [66, 1], [64, 4]];
export const ILENA_B = [[62, 2], [64, 1], [66, 1], [67, 3], [69, 1], [71, 2], [74, 2], [73, 5], [71, 1], [64, 8]];
// Ксарг: полутон вверх, обратно, тритон вниз — и полутон, который не разрешается
export const XARG = [[40, 1.5], [41, 0.5], [40, 2], [34, 2], [35, 4]];
// Надежда: ход Илены (ми — си — ми) в мажоре, дальше вниз по ступеням и снова к вершине
export const HOPE = [[64, 2], [71, 2], [76, 4], [75, 1], [73, 1], [71, 2], [76, 6]];

// Аккорды как наборы нот
const Em = [40, 52, 55, 59, 64], Cmaj7 = [36, 52, 55, 59, 64], D = [38, 50, 57, 62, 66], G = [43, 50, 55, 59, 62];
const Bm = [35, 50, 54, 59, 62], A = [45, 52, 57, 61, 64], Fl = [41, 53, 57, 60, 65];
const E = [40, 52, 56, 59, 64], Amaj = [45, 52, 57, 61, 64], Badd = [47, 54, 59, 63, 66];

// ---------------------------------------------------------------- реплики (cue)
// sec — длина (без хвоста зала), wet — сколько зала, level — громкость по RMS, build(c, out, noise)
export const CUES = {
  // Пролог, чёрный экран и Ксаррон: голос Совета над гулом на ми, мерные удары присяги (раз в 2,5 с, как шаги
  // церемонии) и низкий мужской хор; когда открывается планета — виолончель Илены, первая фраза.
  // Длина с запасом: сцена держит её, пока не начнётся погоня
  'pro-council': {
    sec: 40, wet: 0.55, level: 0.1,
    build(c, o, nz) {
      pad(c, o, 0, 40, [28, 40], { gain: 0.05, attack: 4, release: 4, cut: 380, n: 3 });
      pad(c, o, 1, 13, [40, 47, 52], { gain: 0.03, attack: 3, cut: 900, formant: true });
      for (let t = 1.2; t < 13; t += 2.5) drum(c, o, nz, t, 0.42, { from: 55, to: 30, fall: 0.6, decay: 3.2, slap: 260, players: 1 });
      // Илена: ми дорийский — до-диез в пласте вместо до, чуть светлее
      pad(c, o, 13, 26, [52, 59, 61, 64], { gain: 0.016, attack: 4, release: 4, cut: 1700 });
      pad(c, o, 14, 22, [64, 67, 71], { gain: 0.014, attack: 5, cut: 2200, formant: true });
      bow(c, o, nz, 15, ILENA_A, 1.1, { oct: -12, gain: 0.1 });
      bow(c, o, nz, 31, ILENA_A.slice(0, 3), 1.2, { oct: -12, gain: 0.07 });
    },
  },
  // Пролог, погоня у Ксаррона: остинато низких струн 3+3+2, барабаны, медь Ксарга входит и возвращается всё выше;
  // без финального удара — его даёт pro-gate в миг, когда раскрываются врата
  'pro-chase': {
    sec: 60, wet: 0.35, level: 0.12,
    build(c, o, nz) {
      const bpm = 100, beat = 60 / bpm, st = beat / 2;
      const pat = [1, 0, 0, 1, 0, 0, 1, 0];
      const roots = [40, 40, 41, 40, 40, 41, 43, 41];
      const bars = Math.floor(58 / (beat * 4));
      for (let bar = 0; bar < bars; bar++) {
        const t0 = bar * beat * 4, r = roots[bar % 8], k = Math.min(1, 0.6 + bar * 0.02);
        for (let i = 0; i < 8; i++) {
          const t = t0 + i * st;
          brass(c, o, t, [[r, 0.42]], 1, { oct: -12, gain: (pat[i] ? 0.07 : 0.04) * k, open: 900, shut: 200, n: 3 });
          if (pat[i]) drum(c, o, nz, t, 0.45 * k, { from: 90, to: 45, fall: 0.2, decay: 0.9, slap: 900, players: 2 });
        }
        // Раз в два такта — большой барабан на сильную долю
        if (bar % 2 === 0) drum(c, o, nz, t0, 0.6 * k);
      }
      pad(c, o, 0, 58, [52, 59, 64], { gain: 0.018, attack: 3, release: 3, cut: 1600, formant: true });
      brass(c, o, 2.4, XARG, beat * 1.4, { gain: 0.1 });
      brass(c, o, 14, XARG, beat * 1.3, { gain: 0.09 });
      brass(c, o, 26, XARG, beat * 1.2, { oct: 12, gain: 0.06 });
      // Середина — Илена отвечает Ксаргу виолончелью поверх остинато
      bow(c, o, nz, 33, ILENA_A, beat * 1.6, { oct: -12, gain: 0.07 });
      brass(c, o, 46, XARG, beat, { oct: 12, gain: 0.07 });
      brass(c, o, 46, XARG, beat, { gain: 0.09 });
    },
  },
  // Врата: четыре секунды нарастания (шум, тон, дробь литавр), на 4-й с удар и долгий низкий хвост.
  // Сцена ставит его ровно за 4 с до вспышки — и у Ксаррона, и при обрушении земных врат
  'pro-gate': {
    sec: 10, wet: 0.45, level: 0.12,
    build(c, o, nz) {
      riser(c, o, nz, 0, 4, 0.26);
      for (let i = 0; i < 14; i++) { const t = 4 - 4 * Math.pow(1 - i / 14, 1.6); drum(c, o, nz, t, 0.3 + 0.35 * (i / 14), { from: 80, to: 42, fall: 0.18, decay: 0.7, slap: 700, players: 1 }); }
      brass(c, o, 2, [[40, 1], [41, 1]], 1, { gain: 0.08 });
      boom(c, o, nz, 4, 1.15);
      pad(c, o, 4, 6, [28, 40], { gain: 0.04, attack: 0.05, release: 4, cut: 300 });
    },
  },
  // Пролог, гроза у Земли: то же остинато, но тише и ниже, в дожде; медь Ксарга глухо, издали
  'pro-storm': {
    sec: 44, wet: 0.4, level: 0.1,
    build(c, o, nz) {
      const bpm = 96, beat = 60 / bpm, st = beat / 2;
      const pat = [1, 0, 0, 1, 0, 0, 1, 0];
      const roots = [40, 40, 41, 40, 40, 41, 43, 44];
      const bars = Math.floor(42 / (beat * 4));
      for (let bar = 0; bar < bars; bar++) {
        const t0 = bar * beat * 4, r = roots[bar % 8];
        for (let i = 0; i < 8; i++) {
          const t = t0 + i * st;
          brass(c, o, t, [[r, 0.42]], 1, { oct: -12, gain: pat[i] ? 0.06 : 0.035, open: 800, shut: 200, n: 3 });
          if (pat[i]) drum(c, o, nz, t, 0.4, { from: 90, to: 45, fall: 0.2, decay: 0.9, slap: 900, players: 2 });
        }
      }
      pad(c, o, 0, 42, [52, 59, 64], { gain: 0.02, attack: 2, release: 3, cut: 1500, formant: true });
      brass(c, o, 2.5, XARG, beat * 1.4, { gain: 0.08 });
      brass(c, o, 16, XARG, beat * 1.2, { oct: 12, gain: 0.05 });
      brass(c, o, 30, XARG, beat * 1.4, { gain: 0.08 });
    },
  },
  // Колыбельная: гроза будто стихает, Илена напевает свою тему (мягкий «голос» без слов), под ней — рояль.
  // Под конец, когда капсула уходит, — низкий вздох струн
  'pro-lullaby': {
    sec: 26, wet: 0.6, level: 0.085,
    build(c, o, nz) {
      const beat = 0.95;
      pad(c, o, 0, 26, [40, 52], { gain: 0.03, attack: 2, release: 4, cut: 420, n: 2 });
      pad(c, o, 0.5, 25, [55, 59, 61], { gain: 0.012, attack: 3, release: 4, cut: 1200 });
      bow(c, o, nz, 1.2, ILENA_A, beat, { gain: 0.05, cut: 1300, n: 2, spread: 3, vib: 9, swell: 0.6 });
      bow(c, o, nz, 1.2 + 16 * beat, ILENA_B.slice(0, 7), beat, { gain: 0.045, cut: 1300, n: 2, spread: 3, vib: 9, swell: 0.6 });
      for (const [t, m] of [[1.2, 76], [5, 71], [9, 74], [13, 73], [17, 76], [21, 71]]) piano(c, o, nz, t, m, 0.035, { len: 6, pan: 0.2 });
      pad(c, o, 18, 8, [28, 40, 47], { gain: 0.05, attack: 2.5, release: 3, cut: 600, n: 3 });
    },
  },
  // Пролог, прощание: дождь, рояль медленными арпеджио, виолончель — вторая фраза Илены до до-диеза и домой;
  // на берегу (с 31-й доли) первую фразу Илены тихо повторяет рояль
  'pro-farewell': {
    sec: 48, wet: 0.55, level: 0.1,
    build(c, o, nz) {
      const beat = 1.05;
      const ch = [[Em, 4], [Cmaj7, 4], [D, 4], [G, 4], [Bm, 4], [A, 6], [Em, 4], [Cmaj7, 4], [G, 4], [Em, 6]];
      let t = 0;
      for (const [chord, len] of ch) {
        const dur = len * beat;
        pad(c, o, t, dur + 1.5, chord.slice(1), { gain: 0.014, attack: 1.2, release: 1.6, cut: 1300 });
        pad(c, o, t, dur + 1, [chord[0] - 12], { gain: 0.03, attack: 1, cut: 300, n: 2 });
        const arp = [chord[1], chord[2], chord[3], chord[4], chord[2] + 12];
        for (let i = 0; i < len * 2; i++) piano(c, o, nz, t + i * beat / 2, arp[i % arp.length] + 12, 0.06, { len: 4, pan: (i % 2 ? 0.25 : -0.25) });
        t += dur;
      }
      bow(c, o, nz, 1, ILENA_B, beat, { oct: -12, gain: 0.1 });
      // Берег: тема матери переходит к роялю — её подхватывает тот, кто нашёл ребёнка
      ILENA_A.reduce((b, [m, len]) => { if (m !== null) piano(c, o, nz, 31 * beat + b * beat, m + 12, 0.07, { len: 5 }); return b + len; }, 0);
      piano(c, o, nz, t, 76, 0.07, { len: 7 });
      piano(c, o, nz, t, 64, 0.06, { len: 7 });
    },
  },
  // Название игры: мотив Надежды у валторн над ми мажором — то, что у матери было тоской, у сына звучит светом
  'title': {
    sec: 16, wet: 0.5, level: 0.12,
    build(c, o, nz) {
      const beat = 60 / 66;
      const ch = [[E, 4], [Amaj, 4], [Badd, 4], [E, 6]];
      let t = 0;
      for (const [chord, len] of ch) {
        const dur = len * beat;
        pad(c, o, t, dur + 1.2, chord.slice(1).map((m) => m + 12), { gain: 0.02, attack: 0.8, release: 1.2, cut: 2600 });
        pad(c, o, t, dur + 1.2, [chord[0] - 12, chord[0]], { gain: 0.035, attack: 0.6, cut: 500, n: 3 });
        t += dur;
      }
      brass(c, o, 0.4, HOPE, beat, { oct: -12, gain: 0.085, open: 1300, shut: 300, n: 5, spread: 7 });
      bow(c, o, nz, 0.4, HOPE, beat, { gain: 0.035, cut: 3400 });
      drum(c, o, nz, 0, 0.6, { from: 70, to: 38, decay: 3 });
      drum(c, o, nz, 4 * beat, 0.5);
      drum(c, o, nz, 12 * beat, 0.8, { from: 70, to: 30, decay: 4 });
      burst(c, o, 9 * beat, 3 * beat, nz, { type: 'highpass', freq: 5000, gain: 0.06, attack: 3 * beat * 0.95 });
    },
  },
};

async function renderCue(def, rate) {
  const total = Math.ceil((def.sec + TAIL) * rate);
  const c = new OfflineAudioContext(2, total, rate);
  const nz = noiseBuffer(c);
  const out = room(c, def.wet, 6);
  def.build(c, out, nz);
  const res = await c.startRendering();
  // Громкость по RMS звучащей части, с защитой от перегруза
  let sum = 0, peak = 0;
  const len = Math.min(res.length, Math.ceil(def.sec * rate));
  for (let ch = 0; ch < 2; ch++) {
    const d = res.getChannelData(ch);
    for (let i = 0; i < res.length; i++) { const v = Math.abs(d[i]); if (i < len) sum += v * v; if (v > peak) peak = v; }
  }
  const rms = Math.sqrt(sum / (len * 2));
  const k = Math.min(def.level / Math.max(rms, 1e-5), 0.95 / Math.max(peak, 1e-5));
  for (let ch = 0; ch < 2; ch++) { const d = res.getChannelData(ch); for (let i = 0; i < d.length; i++) d[i] *= k; }
  return res;
}

// ---------------------------------------------------------------- проигрыватель
export class StoryScore {
  constructor(audio) {
    this.audio = audio;
    this.buffers = new Map();
    this.jobs = new Map();
    this.cur = null;          // { name, src, gain, t0, offset }
    this.paused = false;
    this.muted = false;       // N в сюжете
    this.rate = 44100;
  }

  // Отрендерить реплики заранее (глава зовёт при старте); повторный вызов ничего не делает. Реплики собираются
  // по одной: так первая из списка готова через секунды, а не после всех
  prepare(names) {
    return Promise.all(names.map((n) => {
      if (this.buffers.has(n)) return this.buffers.get(n);
      if (!this.jobs.has(n)) {
        // По очереди, в порядке просьбы: первая реплика готова быстро, остальные дособираются, пока она звучит
        this.queue = (this.queue || Promise.resolve()).then(() => renderCue(CUES[n], this.rate))
          .then((b) => { this.buffers.set(n, b); return b; })
          .catch((e) => { console.warn('Музыка не собралась:', n, e); return null; });
        this.jobs.set(n, this.queue);
      }
      return this.jobs.get(n);
    }));
  }

  bus() {
    const A = this.audio;
    if (!A.ctx || !A.muffle) return null;
    if (!this.out) {
      this.out = A.ctx.createGain();
      this.out.gain.value = this.muted ? 0 : 0.7;
      const limit = A.ctx.createDynamicsCompressor();
      limit.threshold.value = -6; limit.ratio.value = 12; limit.attack.value = 0.003; limit.release.value = 0.2;
      this.out.connect(limit).connect(A.muffle);
    }
    return this.out;
  }

  // Играть реплику с начала (или с offset секунд). fade — кроссфейд с прошлой.
  // Если реплика ещё собирается, прошлая звучит до её готовности (а не обрывается в тишину);
  // catchUp — начать не с начала, а с того места, где реплика была бы, начнись она вовремя
  async play(name, { fade = 1.2, offset = 0, catchUp = false } = {}) {
    const token = (this.token = (this.token || 0) + 1);
    const asked = performance.now();
    const buf = this.buffers.get(name) || (await this.prepare([name]))[0];
    if (!buf || token !== this.token) return;
    if (catchUp) offset += (performance.now() - asked) / 1000;
    this.stop(fade);
    const out = this.bus();
    if (!out) { this.cur = { name, offset, t0: 0, src: null, gain: null, lost: true }; return; }
    this.audio.holdMusic(true);
    this.cur = { name, offset, t0: 0, src: null, gain: null };
    if (!this.paused) this.startSrc(this.cur);
  }

  startSrc(cur) {
    const A = this.audio, ctx = A.ctx, buf = this.buffers.get(cur.name);
    if (!buf || cur.offset >= buf.duration) return;
    const s = ctx.createBufferSource(), g = ctx.createGain();
    s.buffer = buf;
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(1, ctx.currentTime + 0.08);
    s.connect(g).connect(this.out);
    s.start(ctx.currentTime, cur.offset);
    cur.src = s; cur.gain = g; cur.t0 = ctx.currentTime - cur.offset;
    s.onended = () => { if (this.cur === cur && cur.src === s) { this.cur = null; this.audio.holdMusic(false); } };
  }

  stopSrc(cur, fade) {
    if (!cur?.src) return;
    const ctx = this.audio.ctx, s = cur.src, g = cur.gain;
    cur.src = null;
    s.onended = null;
    g.gain.cancelScheduledValues(ctx.currentTime);
    g.gain.setValueAtTime(g.gain.value, ctx.currentTime);
    g.gain.linearRampToValueAtTime(0, ctx.currentTime + Math.max(0.02, fade));
    try { s.stop(ctx.currentTime + Math.max(0.03, fade) + 0.02); } catch { /* уже остановлен */ }
  }

  stop(fade = 1.2) {
    this.token = (this.token || 0) + 1;
    if (!this.cur) return;
    this.stopSrc(this.cur, fade);
    this.cur = null;
    this.audio.holdMusic(false);
  }

  // Пауза игры: музыка встаёт и потом идёт с того же места, чтобы не разойтись со сценой
  setPaused(p) {
    if (this.paused === p) return;
    this.paused = p;
    const cur = this.cur;
    if (!cur || !this.audio.ctx) return;
    if (p) {
      if (cur.src) { cur.offset = this.audio.ctx.currentTime - cur.t0; this.stopSrc(cur, 0.15); }
    } else if (this.bus()) this.startSrc(cur);
  }

  // N: музыка сюжета вкл/выкл
  toggle() {
    this.muted = !this.muted;
    if (this.out) this.out.gain.setTargetAtTime(this.muted ? 0 : 0.7, this.audio.ctx.currentTime, 0.3);
    return !this.muted;
  }
}
