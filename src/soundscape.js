import * as THREE from 'three';
import { HALF, PLANE_HALF, QUAY_X, BIG_PARK } from './world/layout.js';

// Живой звук мира поверх базового движка (audio.js):
// полёт (хлопанье плаща, гул сверхзвука, «вжух» мимо зданий, тишина и гул космоса),
// жизнь города (гомон толпы, восторг и аплодисменты, испуганные возгласы, моторы рядом,
// прибой, чайки, сверчки ночью), пространство (эхо по окружению)
// и своя музыка настроения, которая подстраивается под происходящее.

const _v = new THREE.Vector3();
const _segs = [];
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
const ss = THREE.MathUtils.smoothstep;

// Аккорды (MIDI) по настроениям. Тональность ре мажор — светлая, «надежда».
const MOODS = {
  calm: { len: 8, cutoff: 1100, gain: 1, bells: [0.5, 1.6], chords: [[50, 57, 62, 66], [45, 57, 61, 64], [47, 54, 62, 66], [43, 55, 59, 62]] },
  night: { len: 10, cutoff: 700, gain: 0.8, bells: [1.2, 3.0], chords: [[47, 54, 59, 62], [43, 55, 59, 62], [50, 57, 62, 66], [45, 52, 57, 61]] },
  epic: { len: 4, cutoff: 1800, gain: 1.25, bells: null, chords: [[47, 54, 59, 62], [43, 55, 59, 62], [50, 57, 62, 66], [45, 57, 61, 64]] },
  space: { len: 12, cutoff: 800, gain: 0.9, bells: [0.8, 2.2], chords: [[50, 57, 61, 66, 69], [52, 59, 64, 68], [50, 57, 62, 69], [47, 54, 61, 66]] },
};

export class Soundscape {
  constructor(audio) {
    this.a = audio;
    this.built = false;
    this.t = 0;
    this.scoreOn = true;
    this.intensity = 0;          // «накал» боя для музыки 0..1
    this.lastDestroyed = 0;
    this.prevNearest = 1e9;
    this.lastPass = 0;
    this.lastCheer = -100;
    this.lastGasp = -100;
    this.prevGather = 0;
    this.prevFlee = 0;
    this.nextGull = 3;
    this.spaceT = 0;
    this.prevLand = 0;
  }

  // ---------------------------------------------------------------- построение (когда звук уже включён)
  build() {
    const a = this.a, ctx = a.ctx;
    this.built = true;
    const loop = (buf) => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(0, Math.random() * 2); return s; };
    const gain = (v = 0) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    const filt = (type, f, q = 0.7) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
    const osc = (type, f) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.start(); return o; };

    // --- плащ хлопает на ветру: полоса шума с неровной амплитудной «дробью»
    this.capeGain = gain();
    const capeAM = gain(0.5);
    // Плавная волна (прямоугольная давала «трещотку»)
    this.capeLfo = osc('sine', 9);
    const capeDepth = gain(0.5); this.capeLfo.connect(capeDepth).connect(capeAM.gain);
    loop(a.noise).connect(filt('bandpass', 320, 0.6)).connect(filt('lowpass', 900)).connect(capeAM).connect(this.capeGain).connect(a.master);
    // --- гул сверхзвука: глубокий рокот
    this.sonicGain = gain();
    loop(a.brown).connect(filt('lowpass', 140)).connect(this.sonicGain).connect(a.master);
    osc('sine', 38).connect(gain(0.4)).connect(this.sonicGain);
    // --- тонкий свист разреженного воздуха на высоте
    this.highGain = gain();
    loop(a.noise).connect(filt('highpass', 2600)).connect(this.highGain).connect(a.master);
    // --- космос: тихий глубокий гул
    this.spaceGain = gain();
    const sp = filt('lowpass', 300);
    for (const f of [55, 82.4, 110.3]) osc('sine', f).connect(gain(0.3)).connect(sp);
    // Волна отдельным узлом: приходя прямо в spaceGain, она качала громкость и там, где гула быть не должно
    const spSwell = gain(0.7), spLfo = osc('sine', 0.07), spDepth = gain(0.3);
    spLfo.connect(spDepth).connect(spSwell.gain);
    sp.connect(spSwell).connect(this.spaceGain).connect(a.ambBus);

    // --- гомон толпы: три «форманты» шума со случайным движением
    this.murmurGain = gain();
    this.murmurBands = [500, 1150, 2300].map((f) => {
      const b = filt('bandpass', f, 2.2), g = gain(0.5);
      loop(a.noise).connect(b).connect(g).connect(this.murmurGain);
      return { b, g, f };
    });
    this.murmurGain.connect(a.ambBus);
    // --- моторы двух ближайших машин
    this.engines = [0, 1].map(() => {
      const o1 = osc('sawtooth', 45), o2 = osc('square', 90);
      const lp = filt('lowpass', 320, 1.2), g = gain(), pan = ctx.createStereoPanner();
      o1.connect(lp); o2.connect(gain(0.35)).connect(lp);
      lp.connect(g).connect(pan).connect(a.ambBus);
      return { o1, o2, g, pan };
    });
    // --- прибой: медленные «накаты»
    this.surfGain = gain();
    const swell = gain(0.6), swLfo = osc('sine', 0.11), swDepth = gain(0.4);
    swLfo.connect(swDepth).connect(swell.gain);
    loop(a.brown).connect(filt('lowpass', 650)).connect(swell).connect(this.surfGain).connect(a.ambBus);
    loop(a.noise).connect(filt('bandpass', 1800, 0.5)).connect(gain(0.08)).connect(swell);
    // --- сверчки ночью: высокий тон, «стрекот» и паузы
    this.cricketGain = gain();
    const cr = osc('sine', 4600), crGate = gain(0), crFast = osc('square', 28), crSlow = osc('square', 0.7);
    const crFastD = gain(0.5), crSlowD = gain(0.5);
    crFast.connect(crFastD).connect(crGate.gain); crSlow.connect(crSlowD).connect(crGate.gain);
    cr.connect(crGate).connect(this.cricketGain).connect(a.ambBus);

    // --- музыка
    this.musicBus = gain(0);
    this.musicFilter = filt('lowpass', 1100, 0.6);
    this.musicFilter.connect(this.musicBus);
    this.musicBus.connect(a.master);
    this.musicSend = gain(0.6); this.musicBus.connect(this.musicSend).connect(a.reverb);
    this.masterRef = a.master;
    this.mood = 'calm';
    this.chordIdx = 0;
    this.nextChord = ctx.currentTime + 0.5;
    this.nextBell = ctx.currentTime + 2;
    this.nextBeat = ctx.currentTime + 0.5;
    this.beat = 0;
  }

  toggleScore() { this.scoreOn = !this.scoreOn; return this.scoreOn; }

  // ---------------------------------------------------------------- голоса толпы
  // Гласная «а/о» из пилы через две форманты — простой синтез голоса
  voice(t0, f0, glide, dur, gainV, formants, dest) {
    const ctx = this.a.ctx;
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.linearRampToValueAtTime(f0 * glide[0], t0 + dur * 0.3);
    o.frequency.linearRampToValueAtTime(f0 * glide[1], t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gainV, t0 + Math.min(0.08, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    for (const [f, q, k] of formants) {
      const b = ctx.createBiquadFilter(); b.type = 'bandpass'; b.frequency.value = f; b.Q.value = q;
      const kg = ctx.createGain(); kg.gain.value = k;
      o.connect(b).connect(kg).connect(g);
    }
    g.connect(dest);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }

  // Восторг толпы: «о-о-о!» разными голосами, потом аплодисменты
  cheer(k, pos) {
    if (!this.a.ctx) return;
    const a = this.a, t = a.ctx.currentTime, dest = a.out(pos);
    const n = 4 + Math.round(k * 7);
    for (let i = 0; i < n; i++) {
      const f0 = 140 + Math.random() * 150 * (Math.random() < 0.4 ? 1.6 : 1);
      this.voice(t + Math.random() * 0.35, f0, [1.35, 0.95], 0.7 + Math.random() * 0.6, 0.05, [[650 + Math.random() * 150, 5, 1], [1100 + Math.random() * 200, 6, 0.6]], dest);
    }
    for (let i = 0; i < 26 + k * 20; i++) {
      a.noiseBurst({ dur: 0.02 + Math.random() * 0.02, freq: 1800 + Math.random() * 1800, type: 'bandpass', q: 0.9, gain: 0.05, attack: 0.002, delay: 0.5 + Math.random() * 2.4, dest });
    }
  }

  // Испуганные короткие «ах!»
  gasp(k, pos) {
    if (!this.a.ctx) return;
    const a = this.a, t = a.ctx.currentTime, dest = a.out(pos);
    for (let i = 0; i < 2 + Math.round(k * 4); i++) {
      this.voice(t + Math.random() * 0.25, 280 + Math.random() * 180, [1.1, 0.7], 0.3 + Math.random() * 0.2, 0.05, [[820, 5, 1], [1300, 6, 0.7]], dest);
    }
  }

  // Лай: «гав-гав» — короткий тон с формантой и шумовой атакой; крупная собака ниже
  bark(pos, size = 1) {
    const a = this.a;
    if (!a.ctx || !a.listener || pos.distanceTo(a.listener) > 90) return;
    const t = a.ctx.currentTime, dest = a.out(pos), n = 1 + Math.floor(Math.random() * 2.5);
    const f0 = (300 + Math.random() * 60) / Math.max(0.6, size);
    for (let i = 0; i < n; i++) {
      const t0 = t + i * (0.18 + Math.random() * 0.08);
      this.voice(t0, f0, [1.15, 0.7], 0.13, 0.09, [[f0 * 2.8, 3, 1], [f0 * 5.5, 4, 0.5]], dest);
      a.noiseBurst({ dur: 0.05, freq: 1400, type: 'bandpass', q: 1, gain: 0.05, attack: 0.002, delay: t0 - t, dest });
    }
  }

  // Мяуканье: «мя-а-у» — тон вверх-вниз, форманта раскрывается и закрывается; испуганное — коротко и резко
  meow(pos, scared = false) {
    const a = this.a, ctx = a.ctx;
    if (!ctx || !a.listener || pos.distanceTo(a.listener) > 60) return;
    const t0 = ctx.currentTime + Math.random() * 0.1, dur = scared ? 0.25 : 0.55 + Math.random() * 0.25, dest = a.out(pos);
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    const f = 480 + Math.random() * 180;
    o.frequency.setValueAtTime(f * 0.9, t0);
    o.frequency.linearRampToValueAtTime(f * (scared ? 1.6 : 1.35), t0 + dur * 0.35);
    o.frequency.linearRampToValueAtTime(f * 0.85, t0 + dur);
    const b = ctx.createBiquadFilter(); b.type = 'bandpass'; b.Q.value = 4;
    b.frequency.setValueAtTime(800, t0); b.frequency.linearRampToValueAtTime(2000, t0 + dur * 0.4); b.frequency.linearRampToValueAtTime(900, t0 + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(scared ? 0.08 : 0.05, t0 + 0.06); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(b).connect(g).connect(dest); o.start(t0); o.stop(t0 + dur + 0.05);
  }

  // Фейерверк: свист взлёта и хлопок с потрескиванием искр
  fireworkLaunch(pos) {
    const a = this.a, ctx = a.ctx;
    if (!ctx || !a.listener || pos.distanceTo(a.listener) > 3000) return;
    const t0 = ctx.currentTime, dest = a.out(pos);
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(900, t0); o.frequency.exponentialRampToValueAtTime(2600, t0 + 1.8);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.025, t0 + 0.2); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 2);
    o.connect(g).connect(dest); o.start(t0); o.stop(t0 + 2.05);
  }

  fireworkBoom(pos) {
    const a = this.a;
    if (!a.ctx || !a.listener || pos.distanceTo(a.listener) > 4000) return;
    const dest = a.out(pos);
    a.noiseBurst({ dur: 0.9, freq: 260, type: 'lowpass', gain: 0.5, attack: 0.004, brown: true, dest });
    a.tone({ dur: 0.7, from: 90, to: 38, gain: 0.35, dest });
    for (let i = 0; i < 24; i++) a.noiseBurst({ dur: 0.02, freq: 3000 + Math.random() * 3000, type: 'bandpass', q: 1, gain: 0.04, attack: 0.001, delay: 0.25 + Math.random() * 1.4, dest });
  }

  // Щелчок затвора телефона
  shutter(pos) {
    const a = this.a;
    if (!a.ctx || !a.listener || pos.distanceTo(a.listener) > 40) return;
    const dest = a.out(pos);
    a.noiseBurst({ dur: 0.03, freq: 4200, type: 'bandpass', q: 1.5, gain: 0.06, attack: 0.001, dest });
    a.noiseBurst({ dur: 0.04, freq: 2600, type: 'bandpass', q: 1.5, gain: 0.05, attack: 0.001, delay: 0.07, dest });
  }

  // Мягкий отскок теннисного мяча
  ballBounce(pos, k = 1) {
    const a = this.a;
    if (!a.ctx || !a.listener || pos.distanceTo(a.listener) > 50) return;
    a.tone({ dur: 0.08, from: 260, to: 180, gain: 0.06 * k, dest: a.out(pos) });
  }

  // «Спасибо!» — две слоговые гласные с подъёмом интонации
  thanks(pos) {
    const a = this.a;
    if (!a.ctx || !a.listener) return;
    const t = a.ctx.currentTime, dest = a.out(pos), f0 = 160 + Math.random() * 120;
    this.voice(t, f0, [1.05, 1.0], 0.16, 0.06, [[700, 5, 1], [1200, 6, 0.5]], dest);
    this.voice(t + 0.2, f0 * 1.2, [1.25, 1.1], 0.3, 0.06, [[500, 5, 1], [1700, 6, 0.6]], dest);
  }

  // Мурлыканье: низкий «рокот» с частыми пульсами (громкость задаёт игра)
  setPurr(k, pos) {
    const a = this.a, ctx = a.ctx;
    if (!ctx || !this.built) return;
    if (!this.purrGain) {
      const s = ctx.createBufferSource(); s.buffer = a.brown; s.loop = true;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 380;
      const am = ctx.createGain(); am.gain.value = 0.5;
      const lfo = ctx.createOscillator(); lfo.type = 'triangle'; lfo.frequency.value = 26;
      const d = ctx.createGain(); d.gain.value = 0.5; lfo.connect(d).connect(am.gain);
      const breath = ctx.createOscillator(); breath.frequency.value = 0.45;
      const bd = ctx.createGain(); bd.gain.value = 0.3; breath.connect(bd).connect(am.gain);
      this.purrGain = ctx.createGain(); this.purrGain.gain.value = 0;
      s.connect(lp).connect(am).connect(this.purrGain).connect(a.ambBus);
      s.start(); lfo.start(); breath.start();
    }
    this.purrGain.gain.setTargetAtTime(k * 0.35, ctx.currentTime, 0.2);
  }

  // Радостное поскуливание собаки
  whine(pos) {
    const a = this.a, ctx = a.ctx;
    if (!ctx || !a.listener) return;
    const t0 = ctx.currentTime, dest = a.out(pos);
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(800, t0); o.frequency.linearRampToValueAtTime(1250, t0 + 0.18); o.frequency.linearRampToValueAtTime(950, t0 + 0.45);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.03, t0 + 0.05); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
    o.connect(g).connect(dest); o.start(t0); o.stop(t0 + 0.55);
  }

  // Плеск рыбы: короткий «плюх»
  plop(pos) {
    const a = this.a;
    if (!a.ctx || !a.listener || pos.distanceTo(a.listener) > 45) return;
    const dest = a.out(pos);
    // Мягкий всплеск без «тука»: шум с плавной атакой
    a.noiseBurst({ dur: 0.35, freq: 1100, sweepTo: 450, type: 'bandpass', q: 0.6, gain: 0.05, attack: 0.03, dest });
  }

  // Крик чайки: тон падает, с вибрато
  gull(pos) {
    const a = this.a, ctx = a.ctx, dest = a.out(pos);
    const calls = 1 + Math.floor(Math.random() * 3);
    for (let c = 0; c < calls; c++) {
      const t0 = ctx.currentTime + c * (0.35 + Math.random() * 0.15), dur = 0.28 + Math.random() * 0.15;
      const o = ctx.createOscillator(); o.type = 'triangle';
      o.frequency.setValueAtTime(1500 + Math.random() * 300, t0);
      o.frequency.exponentialRampToValueAtTime(850, t0 + dur);
      const vib = ctx.createOscillator(); vib.frequency.value = 32;
      const vd = ctx.createGain(); vd.gain.value = 90; vib.connect(vd).connect(o.frequency);
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.03, t0 + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g).connect(dest); o.start(t0); o.stop(t0 + dur + 0.05); vib.start(t0); vib.stop(t0 + dur + 0.05);
    }
  }

  // «Вжух» мимо здания: шум, тон уходит вниз
  passBy(speed, pos) {
    const k = Math.min(1, speed / 350);
    this.a.noiseBurst({ dur: 0.5 + 0.3 * (1 - k), freq: 1800 + k * 1600, sweepTo: 300, type: 'bandpass', q: 0.8, gain: 0.1 + 0.25 * k, attack: 0.15, dest: this.a.out(pos) });
  }

  // ---------------------------------------------------------------- музыка
  padNote(t0, n, len, g) {
    const ctx = this.a.ctx;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(g, t0 + Math.min(2, len * 0.3));
    env.gain.setValueAtTime(g, t0 + len * 0.8);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + len + 2.5);
    for (const det of [-6, 6]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth';
      o.frequency.value = midi(n); o.detune.value = det;
      o.connect(env); o.start(t0); o.stop(t0 + len + 2.6);
    }
    env.connect(this.musicFilter);
  }

  bell(t0, n, g) {
    const ctx = this.a.ctx;
    for (const [mul, type, k, dec] of [[1, 'triangle', 1, 2.4], [2.01, 'sine', 0.35, 1.2], [3.98, 'sine', 0.12, 0.6]]) {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = midi(n) * mul;
      const e = ctx.createGain();
      e.gain.setValueAtTime(0.0001, t0);
      e.gain.exponentialRampToValueAtTime(g * k, t0 + 0.01);
      e.gain.exponentialRampToValueAtTime(0.0001, t0 + dec);
      o.connect(e).connect(this.musicBus);
      o.start(t0); o.stop(t0 + dec + 0.05);
    }
  }

  drum(t0, kind, g) {
    const ctx = this.a.ctx;
    if (kind === 'kick') {
      const o = ctx.createOscillator(); o.frequency.setValueAtTime(110, t0); o.frequency.exponentialRampToValueAtTime(42, t0 + 0.25);
      const e = ctx.createGain(); e.gain.setValueAtTime(g, t0); e.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.45);
      o.connect(e).connect(this.musicBus); o.start(t0); o.stop(t0 + 0.5);
    } else {
      const s = ctx.createBufferSource(); s.buffer = this.a.noise;
      const b = ctx.createBiquadFilter(); b.type = 'bandpass'; b.frequency.value = kind === 'snare' ? 1700 : 380; b.Q.value = 0.8;
      const e = ctx.createGain(); e.gain.setValueAtTime(g, t0); e.gain.exponentialRampToValueAtTime(0.0001, t0 + (kind === 'snare' ? 0.18 : 0.3));
      s.connect(b).connect(e).connect(this.musicBus); s.start(t0, Math.random() * 2); s.stop(t0 + 0.35);
    }
  }

  bassNote(t0, n, g) {
    const ctx = this.a.ctx;
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = midi(n);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420; lp.Q.value = 3;
    const e = ctx.createGain(); e.gain.setValueAtTime(0.0001, t0);
    e.gain.exponentialRampToValueAtTime(g, t0 + 0.01); e.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
    o.connect(lp).connect(e).connect(this.musicBus); o.start(t0); o.stop(t0 + 0.25);
  }

  updateScore(dt, mood, audible) {
    const ctx = this.a.ctx, now = ctx.currentTime;
    // Громкость музыки: тише, если играет своя mp3 или пауза
    this.musicBus.gain.setTargetAtTime(audible ? 0.075 * MOODS[this.mood].gain : 0, now, 1.2);
    if (!audible && this.musicBus.gain.value < 0.002) { this.nextChord = now + 0.3; this.nextBeat = now + 0.3; return; }
    // Аккорды: настроение меняется на границе аккорда
    while (this.nextChord < now + 0.3) {
      if (mood !== this.mood) { this.mood = mood; this.chordIdx = 0; }
      const M = MOODS[this.mood];
      const ch = M.chords[this.chordIdx % M.chords.length];
      for (const n of ch) this.padNote(this.nextChord, n, M.len, 0.05 / ch.length * 4);
      this.musicFilter.frequency.setTargetAtTime(M.cutoff, this.nextChord, 2);
      this.chord = ch;
      this.chordIdx++;
      this.nextChord += M.len;
    }
    const M = MOODS[this.mood];
    // Колокольчики — ноты аккорда выше на октаву-две
    if (M.bells && this.chord) {
      while (this.nextBell < now + 0.2) {
        const n = this.chord[Math.floor(Math.random() * this.chord.length)] + (Math.random() < 0.5 ? 12 : 24);
        this.bell(this.nextBell, n, 0.06);
        this.nextBell += M.bells[0] + Math.random() * (M.bells[1] - M.bells[0]);
      }
    } else this.nextBell = now + 1;
    // В бою — басовое остинато и барабаны (120 уд/мин, восьмые)
    if (this.mood === 'epic' && this.chord) {
      while (this.nextBeat < now + 0.2) {
        const b = this.beat % 8;
        this.bassNote(this.nextBeat, this.chord[0] - 12, 0.16);
        if (b === 0 || b === 4) this.drum(this.nextBeat, 'kick', 0.7);
        if (b === 2 || b === 6) this.drum(this.nextBeat, 'snare', 0.25);
        if (b === 7) this.drum(this.nextBeat, 'tom', 0.3);
        this.beat++;
        this.nextBeat += 0.25;
      }
    } else this.nextBeat = Math.max(this.nextBeat, now);
  }

  // ---------------------------------------------------------------- кадр
  update({ dt, player, camera, people, traffic, city, env, paused }) {
    const a = this.a;
    if (!a.ctx) return;
    if (!this.built) this.build();
    // Движок пересобрал выход (самовосстановление) — переподключаем свои слои
    if (this.masterRef !== a.master) {
      for (const n of [this.capeGain, this.sonicGain, this.highGain, this.musicBus]) { n.disconnect(); n.connect(a.master); }
      this.musicBus.connect(this.musicSend);
      this.musicSend.disconnect(); this.musicSend.connect(a.reverb);
      this.masterRef = a.master;
    }
    const ctx = a.ctx, t = ctx.currentTime, tc = 0.12;
    this.t += dt;
    const cam = camera.position, speed = player.vel.length();
    const inSpace = env.altitudeK, live = paused ? 0 : 1;
    const air = player.grounded ? 0 : 1;

    // ---- полёт
    this.capeGain.gain.setTargetAtTime(live * air * ss(speed, 15, 250) * 0.07 * (1 - inSpace), t, tc);
    this.capeLfo.frequency.setTargetAtTime(5 + Math.min(speed, 500) * 0.02, t, 0.4);
    this.sonicGain.gain.setTargetAtTime(live * (player.calm ? 0 : 1) * ss(speed / 343, 0.9, 2.5) * 0.22 * (1 - inSpace), t, 0.25);
    this.highGain.gain.setTargetAtTime(live * ss(cam.y, 400, 6000) * (1 - inSpace) * (0.01 + 0.03 * ss(speed, 50, 900)), t, 0.3);
    this.spaceGain.gain.setTargetAtTime(live * ss(inSpace, 0.3, 0.9) * 0.05, t, 1);
    // «Вжух» мимо зданий: ближайшая секция в радиусе 30 м
    if (!paused && air && speed > 35 && cam.y < 600) {
      city.sphereQuery(player.center, 30, _segs);
      let best = 1e9, bp = null;
      for (const s of _segs) {
        city.closestPoint(s, player.center, _v);
        const d = _v.distanceTo(player.center);
        if (d < best) { best = d; bp = _v.clone(); }
      }
      // «Вжух» — только при настоящем пролёте мимо: расстояние заметно уменьшалось
      // и начало расти (а не когда летим вдоль стены на одном расстоянии)
      if (best < this.minNearest) this.minNearest = best;
      const passing = this.minNearest < 12 && best > this.minNearest + 2.5 && this.approachedFrom - this.minNearest > 6;
      if (bp && passing && speed > 45 && this.t - this.lastPass > 0.9) {
        this.passBy(speed, this.passPoint || bp);
        this.lastPass = this.t;
      }
      if (best <= this.minNearest + 0.01) this.passPoint = bp;
      if (passing || best > 25) { this.minNearest = best; this.approachedFrom = best; }
      this.approachedFrom = Math.max(this.approachedFrom || 0, best);
      this.prevNearest = best;
    } else { this.prevNearest = 1e9; this.minNearest = 1e9; this.approachedFrom = 0; }

    // ---- пространство: сколько высоких секций вокруг камеры (раз в полсекунды)
    this.spaceT -= dt;
    if (this.spaceT <= 0) {
      this.spaceT = 0.5;
      city.sphereQuery(cam, 70, _segs);
      let tall = 0;
      for (const s of _segs) if (s.y0 + s.h > cam.y - 10) tall++;
      a.setSpace(Math.min(1, tall / 40) * (1 - ss(cam.y, 150, 800)), inSpace);
    }

    // ---- толпа
    let near = 0, flee = 0, fx = 0, fz = 0;
    for (const p of people.list) {
      if (p.state === 'none') continue;
      const d = p.pos.distanceTo(cam);
      if (d < 35 && p.state !== 'flee') near++;
      if (d < 70 && p.state === 'flee') { flee++; fx += p.pos.x; fz += p.pos.z; }
    }
    const murmur = live * Math.min(1, near / 25) * (1 - inSpace);
    this.murmurGain.gain.setTargetAtTime(murmur * 0.1, t, 0.4);
    for (const m of this.murmurBands) {
      if (Math.random() < dt * 3) {
        m.g.gain.setTargetAtTime(0.35 + Math.random() * 0.65, t, 0.25);
        m.b.frequency.setTargetAtTime(m.f * (0.85 + Math.random() * 0.3), t, 0.05);
      }
    }
    // Толпа собралась вокруг героя — восторг и аплодисменты
    const gathered = people.gatherCount || 0;
    if (!paused && gathered >= 6 && this.prevGather < 6 && this.t - this.lastCheer > 20) {
      this.cheer(Math.min(1, gathered / 25), player.pos.clone());
      this.lastCheer = this.t;
    }
    // Эффектное приземление рядом с людьми — тоже ахают от восторга
    if (!paused && player.landT > 0.5 && this.prevLand <= 0.5 && near >= 5 && this.t - this.lastCheer > 6) {
      this.cheer(Math.min(1, near / 20) * 0.7, player.pos.clone());
      this.lastCheer = this.t;
    }
    this.prevLand = player.landT;
    this.prevGather = gathered;
    // Резко много испуганных — короткие возгласы
    if (!paused && flee - this.prevFlee >= 5 && this.t - this.lastGasp > 1.5) {
      this.gasp(Math.min(1, flee / 20), new THREE.Vector3(fx / flee, cam.y < 50 ? 1.5 : 0, fz / flee));
      this.lastGasp = this.t;
    }
    this.prevFlee = flee;

    // ---- моторы двух ближайших машин (громкость по расстоянию, панорама)
    const right = a.listenerRight;
    const cars = [];
    for (const c of traffic.cars) {
      if (c.state !== 'drive') continue;
      const d = c.pos.distanceTo(cam);
      if (d < 45) cars.push([d, c]);
    }
    cars.sort((x, y) => x[0] - y[0]);
    this.engines.forEach((e, i) => {
      const it = cars[i];
      if (!it || paused) { e.g.gain.setTargetAtTime(0, t, 0.3); return; }
      const [d, c] = it, k = 1 - d / 45;
      const base = c.type === 'bus' || c.type === 'van' ? 32 : 42;
      e.o1.frequency.setTargetAtTime(base + c.speed * 2.4, t, 0.2);
      e.o2.frequency.setTargetAtTime((base + c.speed * 2.4) * 2.01, t, 0.2);
      e.g.gain.setTargetAtTime(k * k * 0.07, t, 0.2);
      if (right) e.pan.pan.setTargetAtTime(Math.max(-0.9, Math.min(0.9, _v.subVectors(c.pos, cam).normalize().dot(right))), t, 0.1);
    });

    // ---- природа
    const overSea = cam.x > QUAY_X - 20;
    const coast = (overSea ? 1 : ss(QUAY_X - cam.x, 500, 40) * (Math.abs(cam.z) < PLANE_HALF ? 1 : 0)) * (1 - ss(cam.y, 30, 400));
    this.surfGain.gain.setTargetAtTime(live * coast * 0.11, t, 0.6);
    const r = Math.max(Math.abs(cam.x), Math.abs(cam.z));
    const inPark = cam.x > BIG_PARK.minX && cam.x < BIG_PARK.maxX && cam.z > BIG_PARK.minZ && cam.z < BIG_PARK.maxZ;
    const nature = Math.max(ss(r, 1500, 2700), inPark ? 1 : 0) * (1 - ss(cam.y, 20, 250));
    this.cricketGain.gain.setTargetAtTime(live * nature * ss(env.night, 0.5, 0.9) * 0.012 * (1 - env.W.rain), t, 1);
    // Больше птиц в парке днём (используется фоновым щебетом движка)
    if (inPark) a.amb.park = Math.max(a.amb.park || 0, 1);
    // Чайки у порта
    this.nextGull -= dt;
    if (!paused && this.nextGull <= 0) {
      this.nextGull = 2.5 + Math.random() * 6;
      const port = Math.hypot(cam.x - (HALF - 60), 0) < 450 && Math.abs(cam.z) < HALF + 200 && cam.y < 250;
      if ((port || overSea) && env.night < 0.6) this.gull(_v.set(cam.x + (Math.random() - 0.5) * 80, cam.y + 20, cam.z + (Math.random() - 0.5) * 80).clone());
    }

    // ---- музыка: накал боя растёт от разрушений, лазера и мощных ударов
    const destroyed = city.destroyed;
    this.intensity += Math.max(0, destroyed - this.lastDestroyed) * 0.07;
    this.lastDestroyed = destroyed;
    if (player.lasering) this.intensity += dt * 0.25;
    if (player.charge > 0) this.intensity += dt * 0.15;
    this.intensity = Math.min(1, Math.max(0, this.intensity - dt * 0.05));
    const mood = inSpace > 0.5 ? 'space' : this.intensity > 0.35 ? 'epic' : env.night > 0.6 ? 'night' : 'calm';
    const userMusic = (a.music && !a.music.paused) || a.themeOn;
    this.updateScore(dt, mood, this.scoreOn && !paused && !userMusic);
  }
}
