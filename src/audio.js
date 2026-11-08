// Звук: эффекты синтезируются на WebAudio (без файлов), музыка — mp3 из папки music/.
//
// Реалистичность держится на трёх вещах:
//  1) «гранулы» — сотни коротких всплесков фильтрованного шума (осколки, щебень);
//  2) эхо города — свёрточная реверберация со сгенерированным откликом;
//  3) расстояние — далёкий звук тише, глуше и приходит с задержкой (скорость звука).

const SPEED_OF_SOUND = 343;
// Громкость своей музыки из music/: идёт мимо общего выхода, поэтому равняется на эффекты отдельно
export const MUSIC_VOLUME = 0.7;
// Дистанции «шин»: звук идёт в ближайшую по расстоянию (постоянные каналы, без лишних узлов)
const BUS_DIST = [0, 30, 70, 150, 300, 600, 1200, 2500];
const MAX_VOICES = 200;

// Мягкое насыщение (tanh): добавляет гармоники — звук плотнее и «сочнее»
function softClipCurve(drive) {
  const n = 2048, c = new Float32Array(n), norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(x * drive) / norm; }
  return c;
}

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.tracks = [];
    this.trackIndex = 0;
    this.musicOn = true;
    this.musicHold = false;  // своя музыка на паузе, пока играет тема боя (boss/theme.js)
    this.themeOn = false;    // тема боя звучит: фоновая музыка игры молчит
    this.music = null;
    this.listener = null; // позиция камеры (Vector3), задаётся снаружи
    this.listenerRight = null; // направление «вправо» от камеры — для панорамы
    this.voices = 0;
    this.watchT = 0;
    // Фон города: 0..1 — насколько мы «в городе» (место, высота, космос)
    this.amb = { urban: 0, night: 0, rain: 0 };
    this.nextEvent = { swish: 2, bird: 3 };
    this.lastAmbT = 0;
  }

  init() {
    if (this.ctx) { this.ctx.resume(); this.music?.paused && this.musicOn && !this.musicHold && this.music.play().catch(() => {}); return; }
    const ctx = this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    // Браузер может приостановить звук (переключение окна, гарнитура) — сразу возобновляем
    ctx.onstatechange = () => { if (ctx.state !== 'running' && ctx.state !== 'closed' && !this.paused) ctx.resume().catch(() => {}); };
    this.buildOutput();

    // Белый и «коричневый» (глубокий, для гула) шум
    const len = ctx.sampleRate * 3;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    this.brown = ctx.createBuffer(1, len, ctx.sampleRate);
    const w = this.noise.getChannelData(0), b = this.brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      w[i] = Math.random() * 2 - 1;
      last = (last + 0.02 * w[i]) / 1.02;
      b[i] = last * 3.5;
    }

    // Эхо города: отклик — затухающий стерео-шум с ранними отражениями
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.makeImpulse(2.6, 2.4);
    this.reverbGain = ctx.createGain();
    this.reverbGain.gain.value = 0.55;
    this.reverb.connect(this.reverbGain).connect(this.master);
    this.buildBuses();
    this.buildAmbience();

    // Ветер
    const src = ctx.createBufferSource();
    src.buffer = this.noise; src.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass'; this.windFilter.Q.value = 0.7;
    this.windGain = ctx.createGain(); this.windGain.gain.value = 0;
    src.connect(this.windFilter).connect(this.windGain).connect(this.master);
    src.start();

    // Дождь
    const rain = ctx.createBufferSource();
    rain.buffer = this.noise; rain.loop = true;
    const rf = ctx.createBiquadFilter(); rf.type = 'highpass'; rf.frequency.value = 1800;
    this.rainGain = ctx.createGain(); this.rainGain.gain.value = 0;
    rain.connect(rf).connect(this.rainGain).connect(this.master);
    rain.start();

    // Гул зарядки мощного удара (включается громкостью)
    this.chargeOsc = [ctx.createOscillator(), ctx.createOscillator()];
    this.chargeOsc[0].type = 'sawtooth'; this.chargeOsc[1].type = 'sawtooth';
    this.chargeOsc[0].frequency.value = 42; this.chargeOsc[1].frequency.value = 42.7;
    this.chargeFilter = ctx.createBiquadFilter(); this.chargeFilter.type = 'lowpass'; this.chargeFilter.frequency.value = 180;
    this.chargeGain = ctx.createGain(); this.chargeGain.gain.value = 0;
    for (const o of this.chargeOsc) { o.connect(this.chargeFilter); o.start(); }
    this.chargeFilter.connect(this.chargeGain).connect(this.master);

    this.loadMusic();
  }

  // master → насыщение → низы/присутствие → компрессор («склейка») → лимитер → выход
  buildOutput() {
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.75;
    // Силу насыщения задаёт громкость на входе: сам изгиб кривой у работающего узла менять нельзя
    this.outPre = ctx.createGain();
    const drive = ctx.createWaveShaper();
    drive.curve = softClipCurve(2.7);
    drive.oversample = '2x';
    const low = this.outLow = ctx.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = 90; low.gain.value = 5;
    const body = ctx.createBiquadFilter(); body.type = 'peaking'; body.frequency.value = 220; body.Q.value = 0.8; body.gain.value = 2;
    const presence = ctx.createBiquadFilter(); presence.type = 'peaking'; presence.frequency.value = 2800; presence.Q.value = 0.9; presence.gain.value = 2.5;
    const glue = this.outGlue = ctx.createDynamicsCompressor();
    glue.threshold.value = -16; glue.ratio.value = 3.5; glue.attack.value = 0.006; glue.release.value = 0.22; glue.knee.value = 8;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -2; limiter.ratio.value = 20; limiter.attack.value = 0.001; limiter.release.value = 0.08; limiter.knee.value = 0;
    // Общий фильтр на выходе: в замедлении времени звук «под водой»
    if (!this.muffle) {
      this.muffle = ctx.createBiquadFilter(); this.muffle.type = 'lowpass'; this.muffle.frequency.value = 20000; this.muffle.Q.value = 0.7;
      this.muffle.connect(ctx.destination);
    }
    this.master.connect(this.outPre).connect(drive).connect(low).connect(body).connect(presence).connect(glue).connect(limiter).connect(this.muffle);
    this.outChain = [this.master, this.outPre, drive, low, body, presence, glue, limiter];
    this.applyHeavy();
  }

  // Режим большого боя: выход жёстче — перегруз сильнее, низ шире, компрессор плотнее
  setHeavy(on) {
    this.heavy = on;
    if (this.ctx) this.applyHeavy();
  }

  applyHeavy() {
    const h = this.heavy;
    this.outPre.gain.value = h ? 0.84 : 0.59;
    this.outLow.gain.value = h ? 8 : 5;
    this.outGlue.threshold.value = h ? -22 : -16;
    this.outGlue.ratio.value = h ? 5 : 3.5;
  }

  // Постоянные каналы по дальности: громкость, «глухость», задержка (скорость звука), эхо
  buildBuses() {
    const ctx = this.ctx;
    this.buses = BUS_DIST.map((d, i) => {
      const g = ctx.createGain();
      g.gain.value = 1 / (1 + d / 70);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = Math.max(350, 18000 * Math.exp(-d / 450));
      let node = g.connect(lp);
      if (d > 0) {
        const t = Math.min(3.5, d / SPEED_OF_SOUND);
        const delay = ctx.createDelay(t + 0.05);
        delay.delayTime.value = t;
        node = node.connect(delay);
      }
      node.connect(this.master);
      const send = ctx.createGain();
      send.gain.value = Math.min(0.9, 0.3 + d / 900);
      node.connect(send).connect(this.reverb);
      return g;
    });
  }

  // ---------------------------------------------------------------- фон мегаполиса
  // Фон идёт по ОТДЕЛЬНОМУ мягкому каналу — мимо насыщения и подъёма низов,
  // которые делают удары плотными. Самый глубокий бас срезан: фон не давит.
  // Синтезированный фон не повторяется — он бесшовный по определению.
  // Если положить запись assets/audio/city_ambience.(mp3|ogg) — играет она, без швов.
  buildAmbience() {
    const ctx = this.ctx;
    this.ambBus = ctx.createGain();
    this.ambBus.gain.value = 1;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 55; hp.Q.value = 0.5;
    const soft = ctx.createBiquadFilter(); soft.type = 'lowpass'; soft.frequency.value = 5500;
    this.ambBus.connect(hp).connect(soft).connect(this.muffle || ctx.destination);

    const loop = (buf) => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(0, Math.random() * 2); return s; };
    // Мягкий гул далёкого трафика
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 320; lp.Q.value = 0.4;
    const hum = ctx.createBiquadFilter(); hum.type = 'peaking'; hum.frequency.value = 140; hum.Q.value = 0.7; hum.gain.value = 3;
    this.trafficGain = ctx.createGain(); this.trafficGain.gain.value = 0;
    loop(this.brown).connect(lp).connect(hum).connect(this.trafficGain).connect(this.ambBus);
    // Ветер между зданиями: широкий мягкий шелест, «порывы» — медленным колебанием тона и громкости
    this.windAmbFilter = ctx.createBiquadFilter(); this.windAmbFilter.type = 'bandpass'; this.windAmbFilter.frequency.value = 520; this.windAmbFilter.Q.value = 0.35;
    const windSoft = ctx.createBiquadFilter(); windSoft.type = 'lowpass'; windSoft.frequency.value = 1400;
    this.airGain = ctx.createGain(); this.airGain.gain.value = 0;
    loop(this.noise).connect(this.windAmbFilter).connect(windSoft).connect(this.airGain).connect(this.ambBus);

    this.loadAmbienceFile();
  }

  // Своя запись фона (по желанию): играет бесшовно через AudioBuffer
  async loadAmbienceFile() {
    for (const url of ['assets/audio/city_ambience.mp3', 'assets/audio/city_ambience.ogg']) {
      try {
        const r = await fetch(url);
        if (!r.ok) continue;
        const buf = await this.ctx.decodeAudioData(await r.arrayBuffer());
        const src = this.ctx.createBufferSource();
        src.buffer = buf; src.loop = true;
        this.fileAmbGain = this.ctx.createGain(); this.fileAmbGain.gain.value = 0;
        src.connect(this.fileAmbGain).connect(this.ambBus);
        src.start();
        this.ambFile = true;
        return;
      } catch { /* файла нет или не читается — остаётся синтез */ }
    }
  }

  // Проезжающая машина вдалеке: тихий мягкий шорох шин, медленно проходит мимо
  carPass(k) {
    const ctx = this.ctx, t = ctx.currentTime, dur = 3 + Math.random() * 2.5;
    const src = ctx.createBufferSource(); src.buffer = this.brown;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 0.3;
    const f0 = 380 + Math.random() * 200;
    f.frequency.setValueAtTime(f0, t); f.frequency.linearRampToValueAtTime(f0 * 1.6, t + dur * 0.5); f.frequency.linearRampToValueAtTime(f0 * 0.85, t + dur);
    const g = ctx.createGain();
    // Плавная «колоколообразная» огибающая, без резких фронтов
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.045 * k, t + dur * 0.5); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const pan = ctx.createStereoPanner(); const dir = Math.random() < 0.5 ? -1 : 1;
    pan.pan.setValueAtTime(-0.7 * dir, t); pan.pan.linearRampToValueAtTime(0.7 * dir, t + dur);
    src.connect(f).connect(g).connect(pan).connect(this.ambBus);
    src.start(t, Math.random() * 2); src.stop(t + dur + 0.1);
  }

  // Птица вдалеке: короткие тихие посвисты
  bird(k) {
    const ctx = this.ctx, n = 2 + Math.floor(Math.random() * 3), f0 = 2600 + Math.random() * 2000;
    const pan = ctx.createStereoPanner(); pan.pan.value = Math.random() * 1.4 - 0.7;
    pan.connect(this.ambBus);
    for (let i = 0; i < n; i++) {
      const t = ctx.currentTime + i * (0.1 + Math.random() * 0.07), d = 0.05 + Math.random() * 0.06;
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(f0 * (0.9 + Math.random() * 0.2), t); o.frequency.exponentialRampToValueAtTime(f0 * (1.15 + Math.random() * 0.3), t + d);
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.012 * k, t + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g).connect(pan); o.start(t); o.stop(t + d + 0.02);
    }
  }

  // Взлёт стаи: частые мягкие хлопки крыльев
  // Мягкие глухие взмахи (без щелчков), не чаще раза в 3 с и только если стая рядом
  flutter(k = 1, pos = null) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (now - (this.lastFlutter || 0) < 3) return;
    if (pos && this.listener && pos.distanceTo(this.listener) > 40) return;
    this.lastFlutter = now;
    const n = 3 + Math.floor(k * 3), dest = this.out(pos);
    for (let i = 0; i < n; i++) {
      this.noiseBurst({ dur: 0.14 + Math.random() * 0.06, freq: 650 + Math.random() * 250, type: 'lowpass', q: 0.5, gain: 0.03 * k, attack: 0.04, delay: i * (0.09 + Math.random() * 0.05), dest });
    }
  }

  // Винт вертолёта: ровное глухое «хлопанье» лопастей; громкость задаёт игра (по расстоянию)
  setRotor(k) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    if (!this.rotorGain) {
      const src = ctx.createBufferSource(); src.buffer = this.brown; src.loop = true;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 170; bp.Q.value = 0.9;
      const chop = ctx.createGain(); chop.gain.value = 0.5;
      const lfo = ctx.createOscillator(); lfo.type = 'triangle'; lfo.frequency.value = 17;
      const depth = ctx.createGain(); depth.gain.value = 0.48;
      lfo.connect(depth).connect(chop.gain);
      this.rotorGain = ctx.createGain(); this.rotorGain.gain.value = 0;
      src.connect(bp).connect(chop).connect(this.rotorGain).connect(this.ambBus);
      src.start(); lfo.start();
    }
    this.rotorGain.gain.setTargetAtTime(Math.min(0.5, k), ctx.currentTime, 0.25);
  }

  // Лазер-плазма. charge 0..1 — накопление: низкий рык, который дрожит всё быстрее.
  // power 0..1 — мощность луча: тяжёлый перегруженный рёв на самых низах, грязная середина, треск разрядов.
  buildLaser() {
    const ctx = this.ctx;
    this.laserOut = ctx.createGain(); this.laserOut.gain.value = 0.9;
    this.laserOut.connect(this.master);
    // --- зарядка: две пилы через фильтр и перегруз, снизу суб, громкость «дрожит» всё быстрее
    this.chgOsc = [ctx.createOscillator(), ctx.createOscillator()];
    this.chgOsc[0].type = 'sawtooth'; this.chgOsc[1].type = 'sawtooth';
    this.chgFilter = ctx.createBiquadFilter(); this.chgFilter.type = 'lowpass'; this.chgFilter.frequency.value = 180; this.chgFilter.Q.value = 3;
    const chgDrive = ctx.createWaveShaper(); chgDrive.curve = softClipCurve(3); chgDrive.oversample = '2x';
    this.chgTrem = ctx.createGain(); this.chgTrem.gain.value = 0.6;
    this.chgLfo = ctx.createOscillator(); this.chgLfo.frequency.value = 6;
    const lfoDepth = ctx.createGain(); lfoDepth.gain.value = 0.4;
    this.chgLfo.connect(lfoDepth).connect(this.chgTrem.gain);
    this.chgGain = ctx.createGain(); this.chgGain.gain.value = 0;
    for (const o of this.chgOsc) { o.connect(this.chgFilter); o.start(); }
    this.chgFilter.connect(chgDrive).connect(this.chgTrem).connect(this.chgGain).connect(this.laserOut);
    this.chgLfo.start();
    const chgSub = ctx.createOscillator(); chgSub.frequency.value = 34;
    this.chgSubGain = ctx.createGain(); this.chgSubGain.gain.value = 0;
    chgSub.connect(this.chgSubGain).connect(this.laserOut); chgSub.start();
    // --- рёв луча: низкие пилы и квадрат с медленной вибрацией, сильный перегруз, фильтр раскрывается с мощностью
    const buzz = [ctx.createOscillator(), ctx.createOscillator(), ctx.createOscillator(), ctx.createOscillator()];
    buzz[0].type = 'sawtooth'; buzz[1].type = 'sawtooth'; buzz[2].type = 'sawtooth'; buzz[3].type = 'square';
    buzz[0].frequency.value = 41; buzz[1].frequency.value = 41.6; buzz[2].frequency.value = 82.3; buzz[3].frequency.value = 27.5;
    const fm = ctx.createOscillator(); fm.frequency.value = 13;
    const fmDepth = this.plasmaFm = ctx.createGain(); fmDepth.gain.value = 3;
    fm.connect(fmDepth); for (const o of buzz) fmDepth.connect(o.frequency);
    this.plasmaOsc = buzz;
    const drive = ctx.createWaveShaper(); drive.curve = softClipCurve(7); drive.oversample = '2x';
    this.plasmaFilter = ctx.createBiquadFilter(); this.plasmaFilter.type = 'lowpass'; this.plasmaFilter.frequency.value = 300; this.plasmaFilter.Q.value = 4;
    this.buzzGain = ctx.createGain(); this.buzzGain.gain.value = 0;
    const bmix = ctx.createGain(); bmix.gain.value = 0.4;
    for (const o of buzz) { o.connect(bmix); o.start(); }
    fm.start();
    bmix.connect(drive).connect(this.plasmaFilter).connect(this.buzzGain).connect(this.laserOut);
    // --- горение: глубокий шум как от реактивного сопла и грязная середина, рваная на 27 Гц
    const roar = ctx.createBufferSource(); roar.buffer = this.brown; roar.loop = true;
    const rbp = ctx.createBiquadFilter(); rbp.type = 'bandpass'; rbp.frequency.value = 180; rbp.Q.value = 0.8;
    const rdrive = ctx.createWaveShaper(); rdrive.curve = softClipCurve(3);
    this.roarGain = ctx.createGain(); this.roarGain.gain.value = 0;
    roar.connect(rbp).connect(rdrive).connect(this.roarGain).connect(this.laserOut); roar.start();
    const mid = ctx.createBufferSource(); mid.buffer = this.noise; mid.loop = true;
    const mbp = ctx.createBiquadFilter(); mbp.type = 'bandpass'; mbp.frequency.value = 900; mbp.Q.value = 1.4;
    const tear = ctx.createGain(); tear.gain.value = 0.55;
    const tearLfo = ctx.createOscillator(); tearLfo.type = 'square'; tearLfo.frequency.value = 27;
    const tearDepth = ctx.createGain(); tearDepth.gain.value = 0.45;
    tearLfo.connect(tearDepth).connect(tear.gain); tearLfo.start();
    this.midGain = ctx.createGain(); this.midGain.gain.value = 0;
    mid.connect(mbp).connect(tear).connect(this.midGain).connect(this.laserOut); mid.start();
    // --- треск разрядов: петля из случайных щелчков разной силы
    const len = ctx.sampleRate * 2, crackle = ctx.createBuffer(1, len, ctx.sampleRate), c = crackle.getChannelData(0);
    for (let i = 0; i < len;) {
      const amp = Math.pow(Math.random(), 2.5), dur = 40 + Math.random() * 300;
      for (let k = 0; k < dur && i + k < len; k++) c[i + k] += (Math.random() * 2 - 1) * amp * Math.exp(-k / (dur * 0.3));
      i += Math.floor(dur * 0.3 + Math.random() * ctx.sampleRate * 0.012);
    }
    const cs = ctx.createBufferSource(); cs.buffer = crackle; cs.loop = true;
    const cbp = ctx.createBiquadFilter(); cbp.type = 'bandpass'; cbp.frequency.value = 1100; cbp.Q.value = 0.7;
    this.crackGain = ctx.createGain(); this.crackGain.gain.value = 0;
    cs.connect(cbp).connect(this.crackGain).connect(this.laserOut); cs.start();
    // --- шипение
    const hs = ctx.createBufferSource(); hs.buffer = this.noise; hs.loop = true;
    const hhp = ctx.createBiquadFilter(); hhp.type = 'highpass'; hhp.frequency.value = 4500;
    this.hissGain = ctx.createGain(); this.hissGain.gain.value = 0;
    hs.connect(hhp).connect(this.hissGain).connect(this.laserOut); hs.start();
    // --- усиление: слой ниже основного. Пилы и квадрат на сильном перегрузе, рваные на 33 Гц
    const grind = [31, 31.5, 46.5, 62.4].map((f, i) => {
      const o = ctx.createOscillator();
      o.type = i === 2 ? 'square' : 'sawtooth';
      o.frequency.value = f;
      return o;
    });
    const gfm = ctx.createOscillator(); gfm.type = 'sawtooth'; gfm.frequency.value = 19;
    const gfmDepth = ctx.createGain(); gfmDepth.gain.value = 5;
    gfm.connect(gfmDepth); for (const o of grind) gfmDepth.connect(o.frequency);
    const gmix = ctx.createGain(); gmix.gain.value = 0.5;
    for (const o of grind) { o.connect(gmix); o.start(); }
    gfm.start();
    const gdrive = ctx.createWaveShaper(); gdrive.curve = softClipCurve(16); gdrive.oversample = '2x';
    const glp = ctx.createBiquadFilter(); glp.type = 'lowpass'; glp.frequency.value = 1500; glp.Q.value = 1.5;
    const gtear = ctx.createGain(); gtear.gain.value = 0.7;
    const gtearLfo = ctx.createOscillator(); gtearLfo.type = 'square'; gtearLfo.frequency.value = 33;
    const gtearDepth = ctx.createGain(); gtearDepth.gain.value = 0.3;
    gtearLfo.connect(gtearDepth).connect(gtear.gain); gtearLfo.start();
    this.grindGain = ctx.createGain(); this.grindGain.gain.value = 0;
    gmix.connect(gdrive).connect(glp).connect(gtear).connect(this.grindGain).connect(this.laserOut);
    // --- и под ним плотный гул: глубокий шум и суб
    const rumble = ctx.createBufferSource(); rumble.buffer = this.brown; rumble.loop = true;
    const rlp = ctx.createBiquadFilter(); rlp.type = 'lowpass'; rlp.frequency.value = 110;
    const rumDrive = ctx.createWaveShaper(); rumDrive.curve = softClipCurve(4);
    this.rumbleGain = ctx.createGain(); this.rumbleGain.gain.value = 0;
    rumble.connect(rlp).connect(rumDrive).connect(this.rumbleGain).connect(this.laserOut); rumble.start();
    const bsub = ctx.createOscillator(); bsub.frequency.value = 29;
    this.boostSubGain = ctx.createGain(); this.boostSubGain.gain.value = 0;
    bsub.connect(this.boostSubGain).connect(this.laserOut); bsub.start();
  }

  // Усиление луча 0..1: основной рёв садится ниже и грязнее, снизу добавляется свой слой
  setLaserBoost(k) { this.laserBoost = k; }

  setLaser(charge, power) {
    if (!this.ctx) return;
    if (!this.laserOut) this.buildLaser();
    const t = this.ctx.currentTime, k = 0.04;
    // Рык зарядки растёт снизу, а не пищит; при выстреле уходит под рёв луча
    const f = 58 + 240 * Math.pow(charge, 1.6);
    this.chgOsc[0].frequency.setTargetAtTime(f, t, k);
    this.chgOsc[1].frequency.setTargetAtTime(f * 1.012, t, k);
    this.chgFilter.frequency.setTargetAtTime(170 + 1300 * charge * charge, t, k);
    this.chgLfo.frequency.setTargetAtTime(5 + 32 * charge * charge, t, k);
    this.chgGain.gain.setTargetAtTime(charge * charge * 0.1 * (1 - power * 0.85), t, k);
    this.chgSubGain.gain.setTargetAtTime(charge * 0.26 * (1 - power * 0.6), t, k);
    const rel = power > 0.01 ? 0.05 : 0.12, b = this.laserBoost || 0;
    this.buzzGain.gain.setTargetAtTime(power * 0.26, t, rel);
    this.plasmaFilter.frequency.setTargetAtTime(300 + (1500 + 1100 * b) * power, t, 0.08);
    this.plasmaFm.gain.setTargetAtTime(3 + 9 * b, t, 0.08);
    for (const o of this.plasmaOsc) o.detune.setTargetAtTime(-350 * b, t, 0.08);
    this.roarGain.gain.setTargetAtTime(power * 0.42 * (1 + 0.3 * b), t, rel);
    this.midGain.gain.setTargetAtTime(power * 0.075 * (1 + 1.2 * b), t, rel);
    this.crackGain.gain.setTargetAtTime(power * 0.3 * (1 + 0.6 * b), t, 0.06);
    this.hissGain.gain.setTargetAtTime(power * 0.012, t, 0.08);
    this.grindGain.gain.setTargetAtTime(power * b * 0.26, t, rel);
    this.rumbleGain.gain.setTargetAtTime(power * b * 0.5, t, rel);
    this.boostSubGain.gain.setTargetAtTime(power * b * 0.3, t, rel);
  }

  // Вспышка выстрела: тяжёлый хлопок, тон обрушивается вниз
  laserIgnite() {
    if (!this.ctx) return;
    this.boom(0.35);
    this.noiseBurst({ dur: 0.5, freq: 3200, sweepTo: 180, type: 'lowpass', gain: 0.4, attack: 0.003 });
    this.tone({ dur: 0.45, from: 200, to: 32, gain: 0.34, type: 'sawtooth' });
    this.tone({ dur: 0.7, from: 70, to: 28, gain: 0.45 });
  }

  // Включение усиления: короткий тяжёлый удар, тон проваливается на самое дно
  laserBoostHit() {
    if (!this.ctx) return;
    this.boom(0.4);
    this.noiseBurst({ dur: 0.35, freq: 2200, sweepTo: 120, type: 'lowpass', gain: 0.35, attack: 0.002 });
    this.tone({ dur: 0.4, from: 140, to: 26, gain: 0.34, type: 'sawtooth' });
    this.tone({ dur: 0.55, from: 60, to: 24, gain: 0.42 });
  }

  // Данные о месте: urban 0..1 (центр города у земли — 1), park 0..1 (пригород/зелень), night, rain
  setAmbience(urban, park, night, rain) {
    this.amb.urban = urban; this.amb.park = park; this.amb.night = night; this.amb.rain = rain;
  }

  updateAmbience(paused) {
    const ctx = this.ctx, t = ctx.currentTime, A = this.amb;
    const day = 1 - A.night * 0.5, quiet = 1 - A.rain * 0.5;
    // Когда играет своя музыка — фон тише, чтобы её не перебивать
    const duck = this.music && !this.music.paused ? 0.55 : 1;
    const u = paused ? 0 : A.urban * duck;
    // Медленные «порывы» ветра (несколько несоизмеримых синусов — не повторяется)
    const gust = 0.6 + 0.25 * Math.sin(t * 0.21) + 0.15 * Math.sin(t * 0.077 + 1.3);
    this.windAmbFilter.frequency.setTargetAtTime(420 + 260 * gust, t, 0.8);
    if (this.ambFile) {
      this.fileAmbGain.gain.setTargetAtTime(u * 0.5 * quiet, t, 0.6);
      this.trafficGain.gain.setTargetAtTime(0, t, 0.5);
      this.airGain.gain.setTargetAtTime(0, t, 0.5);
      return;
    }
    this.trafficGain.gain.setTargetAtTime(u * 0.08 * day * quiet * (0.9 + 0.1 * Math.sin(t * 0.13)), t, 0.8);
    this.airGain.gain.setTargetAtTime(u * 0.02 * gust * quiet, t, 0.8);
    if (paused || u < 0.05) return;
    const dt = Math.min(0.5, t - (this.lastAmbT || t));
    this.lastAmbT = t;
    const E = this.nextEvent;
    for (const k in E) E[k] -= dt;
    if (E.swish <= 0) { this.carPass(u * day * quiet); E.swish = (8 + Math.random() * 12) / Math.max(0.4, day); }
    if (E.bird <= 0) { if (A.night < 0.5 && A.rain < 0.5) this.bird((A.park ?? 0.3) * 0.8 + 0.2); E.bird = (6 + Math.random() * 12) / Math.max(0.3, A.park ?? 0.3); }
  }

  // Если что-то сломалось (NaN в цепочке, звук приостановлен) — чиним
  watchdog() {
    const ctx = this.ctx;
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    if (!this.probe) {
      this.probe = ctx.createAnalyser();
      this.probe.fftSize = 256;
      this.probeBuf = new Float32Array(256);
      this.outChain[this.outChain.length - 1].connect(this.probe);
    }
    this.probe.getFloatTimeDomainData(this.probeBuf);
    for (let i = 0; i < this.probeBuf.length; i++) {
      if (!Number.isFinite(this.probeBuf[i])) { this.rebuild(); return; }
    }
  }

  rebuild() {
    for (const n of this.outChain) n.disconnect();
    for (const b of this.buses) b.disconnect();
    this.reverbGain.disconnect();
    this.probe = null;
    this.buildOutput();
    this.reverb = this.ctx.createConvolver();
    this.reverb.buffer = this.makeImpulse(2.6, 2.4);
    this.reverb.connect(this.reverbGain).connect(this.master);
    this.buildBuses();
    this.windGain.disconnect(); this.windGain.connect(this.master);
    this.rainGain.disconnect(); this.rainGain.connect(this.master);
    this.chargeGain.disconnect(); this.chargeGain.connect(this.master);
    if (this.laserOut) { this.laserOut.disconnect(); this.laserOut.connect(this.master); }
    this.voices = 0;
  }

  makeImpulse(seconds, decay) {
    const ctx = this.ctx, n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) {
        const t = i / n;
        // Ранние отражения от фасадов + плотный «хвост»
        const early = i < ctx.sampleRate * 0.12 && Math.random() < 0.004 ? 1.5 : 0;
        d[i] = ((Math.random() * 2 - 1) + early) * Math.pow(1 - t, decay);
      }
    }
    return buf;
  }

  // ---------------------------------------------------------------- музыка
  // python-сервер отдаёт список файлов папки — берём оттуда все mp3/ogg/m4a
  async loadMusic() {
    try {
      const html = await (await fetch('music/')).text();
      const files = [...html.matchAll(/href="([^"]+\.(?:mp3|ogg|m4a|wav|flac|webm|opus|aac))"/gi)].map((m) => 'music/' + m[1]);
      this.tracks = [...new Set(files)];
    } catch { this.tracks = []; }
    if (this.tracks.length) this.playTrack(0);
  }

  playTrack(i) {
    if (!this.tracks.length) return;
    this.trackIndex = (i + this.tracks.length) % this.tracks.length;
    if (this.music) this.music.pause();
    // У каждого трека свой плеер: он помнит, где остановился, и продолжит с того же места
    const url = this.tracks[this.trackIndex];
    this.players ||= {};
    if (!this.players[url]) {
      const m = this.players[url] = new Audio(url);
      m.volume = MUSIC_VOLUME;
      m.addEventListener('ended', () => { m.currentTime = 0; this.playTrack(this.trackIndex + 1); });
    }
    this.music = this.players[url];
    if (this.musicOn && !this.musicHold) this.music.play().catch(() => {});
  }

  // Тема боя играет — своя музыка ждёт на паузе (или наоборот)
  holdMusic(on) {
    this.musicHold = on;
    if (!this.music) return;
    if (on) this.music.pause();
    else if (this.musicOn) this.music.play().catch(() => {});
  }

  // M: следующий трек; единственный трек ставит на паузу и снимает с неё; если треков нет — ничего
  nextTrack() {
    if (!this.tracks.length) return null;
    if (this.tracks.length === 1 && this.music && !this.music.paused) {
      this.musicOn = false;
      this.music.pause();
      return 'Пауза';
    }
    this.musicOn = true;
    this.musicHold = false;
    this.playTrack(this.trackIndex + 1);
    return decodeURIComponent(this.tracks[this.trackIndex].split('/').pop());
  }

  toggleMusic() {
    this.musicOn = !this.musicOn;
    if (!this.music) return this.musicOn;
    if (this.musicOn) this.music.play().catch(() => {}); else this.music.pause();
    return this.musicOn;
  }

  // ---------------------------------------------------------------- пространство
  // Выход для звука из точки pos: громкость, «глухость» и задержка по расстоянию + эхо
  out(pos) {
    let d = 0;
    if (pos && this.listener) d = pos.distanceTo(this.listener);
    if (!Number.isFinite(d)) d = 0;
    let i = 0;
    while (i < BUS_DIST.length - 1 && d > (BUS_DIST[i] + BUS_DIST[i + 1]) / 2) i++;
    // Панорама: звук справа — в правом канале. Вблизи (меньше 3 м) — по центру.
    const r = this.listenerRight;
    if (!pos || !r || d < 3) return this.buses[i];
    const pan = this.ctx.createStereoPanner();
    const k = ((pos.x - this.listener.x) * r.x + (pos.y - this.listener.y) * r.y + (pos.z - this.listener.z) * r.z) / d;
    pan.pan.value = Math.max(-1, Math.min(1, k)) * Math.min(0.9, d / 20);
    pan.connect(this.buses[i]);
    return pan;
  }

  // Замедление времени: высокие частоты уходят, слышен низкий «гул» и удары
  setMuffle(k) {
    if (!this.ctx || !this.muffle) return;
    this.muffle.frequency.setTargetAtTime(k > 0 ? 700 : 20000, this.ctx.currentTime, k > 0 ? 0.12 : 0.25);
    this.tone({ dur: 0.7, from: k > 0 ? 240 : 60, to: k > 0 ? 55 : 220, gain: 0.12 });
  }

  // Пространство: в «каньонах» небоскрёбов эхо глубже, на открытом месте — суше
  setSpace(enclosed, inSpace) {
    if (!this.ctx) return;
    this.reverbGain.gain.setTargetAtTime((0.3 + 0.55 * enclosed) * (1 - inSpace * 0.8), this.ctx.currentTime, 0.5);
  }

  // ---------------------------------------------------------------- примитивы
  noiseBurst({ dur = 0.3, freq = 800, type = 'lowpass', gain = 0.5, attack = 0.005, sweepTo = null, q = 1, delay = 0, brown = false, dest = null }) {
    if (!this.ctx || this.voices >= MAX_VOICES || !Number.isFinite(gain + freq + dur + delay)) return;
    const ctx = this.ctx, t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    this.voices++;
    src.onended = () => { this.voices--; };
    src.buffer = brown ? this.brown : this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = type; f.Q.value = q; f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(gain, 0.0002), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(dest || this.master);
    src.start(t, Math.random() * 2); src.stop(t + dur + 0.05);
  }

  tone({ dur = 0.3, from = 120, to = 40, gain = 0.5, type = 'sine', delay = 0, dest = null }) {
    if (!this.ctx || this.voices >= MAX_VOICES || !Number.isFinite(gain + from + to + dur + delay)) return;
    const ctx = this.ctx, t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    this.voices++;
    o.onended = () => { this.voices--; };
    o.type = type;
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(dest || this.master);
    o.start(t); o.stop(t + dur + 0.05);
  }

  // Короткая «гранула» резонансного шума — щелчок осколка, камешек
  grain(dest, t0, freq, q, dur, gain) {
    // Ограничитель: не больше ~1000 гранул в секунду, чтобы массовые разрушения не грузили процессор
    const now = this.ctx.currentTime;
    if (now - (this.budgetT || 0) > 0.25) { this.budgetT = now; this.grainCount = 0; }
    if (++this.grainCount > 250) return;
    // Гранулы не занимают последние 60 голосов — они зарезервированы под удары и взрывы
    if (this.voices > MAX_VOICES - 60) return;
    this.noiseBurst({ dur, freq, type: 'bandpass', q, gain, attack: 0.001, delay: t0, dest });
  }

  // Общий «тяжёлый» слой: суббас + тело + щелчок. Делает удары плотными и весомыми
  impactLayer(o, k, deep = 1) {
    // В большом бою у каждого удара рваный низ и хруст
    if (this.heavy) {
      this.tone({ dur: 0.26 + 0.2 * deep, from: 75 * deep + 30, to: 30, gain: 0.55 * k, type: 'sawtooth', dest: o });
      this.noiseBurst({ dur: 0.07, freq: 950, type: 'bandpass', q: 0.7, gain: 0.8 * k, attack: 0.001, dest: o });
    }
    this.tone({ dur: 0.5 + 0.3 * deep, from: 55 * deep + 20, to: 26, gain: 0.9 * k, dest: o });                   // суббас
    this.noiseBurst({ dur: 0.18 + 0.1 * deep, freq: 260, type: 'bandpass', q: 0.9, gain: 0.9 * k, attack: 0.003, dest: o }); // тело
    this.noiseBurst({ dur: 0.012, freq: 3200, type: 'highpass', gain: 0.5 * k, attack: 0.0005, dest: o });          // щелчок
  }

  // ---------------------------------------------------------------- материалы
  // Стекло: резкий хруст удара, затем десятки звонких осколков, которые сыплются и затихают
  glass(k = 1, pos = null) {
    if (!this.ctx) return;
    const o = this.out(pos);
    this.noiseBurst({ dur: 0.22, freq: 1800, type: 'highpass', gain: 0.7 * k, attack: 0.001, dest: o });
    this.noiseBurst({ dur: 0.12, freq: 900, type: 'bandpass', q: 1.5, gain: 0.35 * k, attack: 0.002, dest: o }); // «тело» разбитого листа
    this.noiseBurst({ dur: 0.35, freq: 5200, type: 'bandpass', q: 0.8, gain: 0.3 * k, attack: 0.002, dest: o });
    const n = Math.round(22 + 45 * k);
    for (let i = 0; i < n; i++) {
      // Плотно в начале, реже к концу (падающие осколки)
      const t = Math.pow(Math.random(), 1.8) * (0.9 + 0.7 * k);
      const f = 2600 + Math.random() * 7000;
      this.grain(o, t, f, 14 + Math.random() * 30, 0.03 + Math.random() * 0.1, (0.18 + Math.random() * 0.35) * k * (1 - t / 1.8));
    }
  }

  // Бетон: глухой удар + хруст
  concrete(k = 1, pos = null) {
    if (!this.ctx) return;
    const o = this.out(pos);
    this.impactLayer(o, 0.8 * k, 1);
    this.tone({ dur: 0.32, from: 85, to: 32, gain: 0.6 * k, dest: o });
    this.noiseBurst({ dur: 0.22, freq: 700, gain: 0.6 * k, attack: 0.002, dest: o });
    this.noiseBurst({ dur: 0.012, freq: 3500, type: 'highpass', gain: 0.4 * k, attack: 0.0005, dest: o }); // щелчок
    for (let i = 0; i < 16; i++) this.grain(o, Math.random() * 0.45, 300 + Math.random() * 1900, 3, 0.04 + Math.random() * 0.08, 0.2 * k);
  }

  // Металл: удар + негармонический звон + дребезг
  metal(k = 1, pos = null) {
    if (!this.ctx) return;
    const o = this.out(pos);
    this.impactLayer(o, 0.6 * k, 0.8);
    const base = 140 + Math.random() * 120;
    for (const r of [1, 2.32, 4.25, 6.63, 9.38]) {
      this.tone({ dur: 0.35 + 0.6 * k / Math.sqrt(r), from: base * r, to: base * r * 0.985, gain: 0.1 * k / Math.sqrt(r), type: 'sine', dest: o });
    }
    this.noiseBurst({ dur: 0.08, freq: 2500, type: 'bandpass', q: 1.2, gain: 0.5 * k, attack: 0.001, dest: o });
    this.tone({ dur: 0.2, from: 90, to: 40, gain: 0.5 * k, dest: o });
    for (let i = 0; i < 6; i++) this.grain(o, 0.05 + Math.random() * 0.4, 1500 + Math.random() * 3000, 12, 0.03, 0.12 * k);
  }

  // Удар кулаком: тяжёлый «бум» + щелчок + материал цели
  punch(k = 1, material = 'concrete', pos = null) {
    if (!this.ctx) return;
    const o = this.out(pos);
    this.impactLayer(o, k, 1.2);
    this.tone({ dur: 0.38, from: 72, to: 28, gain: 0.7 * k, dest: o });
    this.tone({ dur: 0.12, from: 160, to: 60, gain: 0.5 * k, type: 'triangle', dest: o });
    this.noiseBurst({ dur: 0.015, freq: 4000, type: 'highpass', gain: 0.45 * k, attack: 0.0005, dest: o });
    if (material === 'glass') { this.concrete(k * 0.5, pos); this.glass(k * 0.9, pos); }
    else if (material === 'metal') this.metal(k, pos);
    else this.concrete(k, pos);
  }

  // Ударная волна: низкий раскат с долгим эхом
  boom(k = 1, pos = null) {
    if (!this.ctx) return;
    const o = this.out(pos);
    this.impactLayer(o, k, 1.5);
    this.tone({ dur: 1.4 + k, from: 60, to: 18, gain: 1.0 * k, dest: o });
    this.tone({ dur: 0.6, from: 120, to: 35, gain: 0.5 * k, type: 'triangle', dest: o });
    this.noiseBurst({ dur: 1.6 + 1.4 * k, freq: 600, sweepTo: 60, gain: 0.95 * k, attack: 0.006, brown: true, dest: o });
    this.noiseBurst({ dur: 0.05, freq: 2500, type: 'highpass', gain: 0.5 * k, attack: 0.001, dest: o });
  }

  explosion(k = 1, pos = null) {
    if (!this.ctx) return;
    this.boom(k, pos);
    const o = this.out(pos);
    // Треск огня и град обломков
    for (let i = 0; i < 40 * k; i++) this.grain(o, 0.1 + Math.random() * 1.8, 800 + Math.random() * 3500, 4, 0.02 + Math.random() * 0.05, 0.12 * k);
    for (let i = 0; i < 25 * k; i++) this.grain(o, 0.4 + Math.random() * 1.6, 200 + Math.random() * 900, 3, 0.05 + Math.random() * 0.1, 0.15 * k);
  }

  // Обрушение: гул, сотни камней щебня, иногда стон стальных конструкций
  crumble(k = 1, material = 'concrete', pos = null) {
    if (!this.ctx) return;
    // Много секций рушатся в один момент — звучит одно, но мощное обрушение
    const now = this.ctx.currentTime;
    if (now - (this.lastCrumble || 0) < 0.15) return;
    this.lastCrumble = now;
    const o = this.out(pos);
    const len = 2.2 + 3 * k;
    this.impactLayer(o, 0.6 + 0.4 * k, 1.4);
    this.noiseBurst({ dur: len, freq: 160, gain: 0.7 + 0.5 * k, attack: 0.25, brown: true, dest: o });
    this.noiseBurst({ dur: len * 0.7, freq: 450, type: 'bandpass', q: 0.7, gain: 0.3 + 0.3 * k, attack: 0.15, dest: o }); // хруст середины
    this.tone({ dur: 1.6 + k, from: 48, to: 26, gain: 0.45 * k, dest: o });
    const n = Math.round(40 + 140 * k);
    for (let i = 0; i < n; i++) {
      const t = Math.pow(Math.random(), 1.4) * len;
      const big = Math.random() < 0.3;
      this.grain(o, t, big ? 150 + Math.random() * 400 : 600 + Math.random() * 2200, big ? 2 : 4,
        big ? 0.08 + Math.random() * 0.12 : 0.02 + Math.random() * 0.06, (big ? 0.35 : 0.18) * (0.5 + k * 0.6) * (1 - t / (len * 1.2)));
    }
    if (k > 0.4 && Math.random() < 0.6) {
      // Стон металла: низкий тон с медленным «плаванием»
      const ctx = this.ctx, t = ctx.currentTime + 0.2;
      const osc = ctx.createOscillator(); osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(75, t); osc.frequency.exponentialRampToValueAtTime(42, t + 1.8);
      const lfo = ctx.createOscillator(); lfo.frequency.value = 5; const lg = ctx.createGain(); lg.gain.value = 3;
      lfo.connect(lg).connect(osc.frequency);
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 420;
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.16 * k, t + 0.3); g.gain.exponentialRampToValueAtTime(0.0001, t + 2);
      osc.connect(f).connect(g).connect(o);
      osc.start(t); lfo.start(t); osc.stop(t + 2.1); lfo.stop(t + 2.1);
    }
    if (material === 'glass') this.glass(0.6 + 0.4 * k, pos);
  }

  whoosh(k = 1) {
    if (this.heavy) this.noiseBurst({ dur: 0.3 + 0.3 * k, freq: 170, gain: 0.5 * k, attack: 0.08, brown: true });
    this.noiseBurst({ dur: 0.25 + 0.3 * k, freq: 350, sweepTo: 2200, type: 'bandpass', q: 1.2, gain: 0.3 * k, attack: 0.07 });
  }

  // Тяжёлый шаг: низкий стук + хруст гравия
  footstep(k = 1) {
    if (!this.ctx) return;
    this.tone({ dur: 0.14, from: 70, to: 38, gain: 0.35 * k });
    this.noiseBurst({ dur: 0.07, freq: 900, gain: 0.12 * k, attack: 0.002 });
    for (let i = 0; i < 3; i++) this.grain(this.master, Math.random() * 0.05, 1200 + Math.random() * 1500, 5, 0.02, 0.05 * k);
  }

  // Приземление: удар о землю, осыпающаяся крошка
  land(k = 1, pos = null) {
    if (!this.ctx) return;
    this.punch(0.7 + 0.5 * k, 'concrete', pos);
    this.boom(0.35 * k, pos);
  }

  // Гул зарядки мощного удара: громче и выше с зарядом
  setCharge(k) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.chargeGain.gain.setTargetAtTime(k > 0 ? 0.05 + k * k * 0.28 : 0, t, 0.05);
    this.chargeOsc[0].frequency.setTargetAtTime(40 + k * 35, t, 0.05);
    this.chargeOsc[1].frequency.setTargetAtTime(40.7 + k * 36, t, 0.05);
    this.chargeFilter.frequency.setTargetAtTime(150 + k * 500, t, 0.05);
  }

  thunder() {
    if (!this.ctx) return;
    const o = this.out(null);
    this.noiseBurst({ dur: 4.5, freq: 260, sweepTo: 50, gain: 0.85, attack: 0.04, brown: true, dest: o });
    for (let i = 0; i < 30; i++) this.grain(o, Math.random() * 1.5, 80 + Math.random() * 300, 1.5, 0.15 + Math.random() * 0.3, 0.25);
  }

  update(speed, paused, rain = 0, inSpace = 0) {
    if (!this.ctx) return;
    this.paused = paused;
    // Раз в секунду проверяем, что звук жив
    const now = performance.now();
    if (!paused && now - this.watchT > 1000) { this.watchT = now; this.watchdog(); }
    const t = this.ctx.currentTime;
    const k = Math.min(1, speed / 500);
    // В вакууме звук ветра пропадает
    this.windGain.gain.setTargetAtTime(paused ? 0 : (0.02 + k * 0.35) * (1 - inSpace), t, 0.1);
    this.windFilter.frequency.setTargetAtTime(250 + Math.min(speed, 2000) * 2.5, t, 0.1);
    this.rainGain.gain.setTargetAtTime(paused ? 0 : rain * 0.12, t, 0.3);
    this.updateAmbience(paused);
    if (paused) {
      this.setCharge(0);
      if (this.laserOut) this.setLaser(0, 0);
    }
  }
}
