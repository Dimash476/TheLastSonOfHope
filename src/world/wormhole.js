import * as THREE from 'three';
import { SPACE } from '../config.js';
import { REGION, setRegion, regionAt } from './bodies.js';
import { Portal, XARRON_GATE, EARTH_GATE, XARRON_GATE_SUN } from './portal.js';

// Кротовая нора: чёрная дыра за Солнцем → белая дыра у системы Ксаррона (только туда).
// До победы над Ксаргом чёрная дыра как раньше выбрасывает над Землёй. После каждой победы она начинает
// коллапсировать: диск мерцает и вспыхивает, по небу расходятся волны,
// и всё время слышен её гул — как у корабля, но волнами. Подсказок нет: герой сам решает лететь к ней.
// За горизонтом — туннель и выход из белой дыры в ~1,3 млрд м от звезды Ксаррона (дальше — своим ходом,
// W + Shift + R). Белая дыра никого не впускает (решение автора): домой — только через врата на орбите
// Ксаррона: земные врата открываются только в тот миг, когда герой выходит из них, прилетев с Ксаррона. Вернулся домой — коллапс стихает, но путь
// уже открыт навсегда: падение в чёрную дыру всегда ведёт к Ксаррону (просьба автора), а над Землёй ходят врата.
// Что путь открыт, помнится в браузере (localStorage), биты: 1 — дыра коллапсирует, 2 — земные врата открыты,
// 4 — во время этого коллапса герой уже долетел до Ксаррона (вернулся в нашу систему любым путём — коллапс стихает),
// 8 — путь найден: после первой победы дыра всегда ведёт к Ксаррону, даже когда не коллапсирует.
// Ключ новый: в старом бит 2 ставился и при возврате через белую дыру — оттуда берём только коллапс

const KEY = 'tlsoh.xarronPath';
const OLD_KEY = 'tlsoh.xarronGate';
const ONSET = 3.5;        // через столько секунд игры после победы дыра начинает коллапсировать
const PERIOD = [2, 3];    // волна раз в столько секунд
const EXIT_RS = 10;       // выход из белой дыры: на таком расстоянии от неё (в rs)
const EXIT_T = 1.7;       // сколько секунд героя выносит потоком, прежде чем отдать управление

const GATE_COOL = 1.5;    // после прохода сквозь врата столько секунд они не ловят: выход — у самой глади

const smooth = THREE.MathUtils.smoothstep, clamp = THREE.MathUtils.clamp;
const _o = new THREE.Vector3();
const load = () => {
  try {
    const v = localStorage.getItem(KEY);
    if (v !== null) return Number(v) || 0;
    const old = Number(localStorage.getItem(OLD_KEY)) || 0;
    localStorage.removeItem(OLD_KEY);
    return old & 1;
  } catch { return 0; }
};
const save = (v) => { try { if (v) localStorage.setItem(KEY, String(v)); else localStorage.removeItem(KEY); } catch { /* приватное окно */ } };

export class Wormhole {
  constructor(world, black, white) {
    this.world = world;
    this.black = black;
    this.white = white;
    const s = load();
    // Чёрная дыра коллапсирует только сразу после победы во Вторжении — в этой игре: не сохраняется
    // (решение автора: в Симуляторе коллапса нет вовсе)
    this.collapse = false;
    // Земные врата открыты, только пока герой в этой игре вышел из них, прилетев с Ксаррона: не сохраняются
    this.gatesOpen = false;
    this.away = false;           // после этой победы герой уже был у Ксаррона
    this.known = !!(s & 9);      // путь к Ксаррону найден (старые сохранения с коллапсом — тоже)
    this.onsetIn = -1;
    this.nextWave = 3;
    this.blocked = null;   // () => true, пока идёт бой: тогда дыра ведёт себя по-старому
    this.driven = null;
    this.prevPos = new THREE.Vector3();
    this.hasPrev = false;
    this.cool = 0;
    this.droneK = 0;
    EARTH_GATE.hidden = !this.gatesOpen;
    black.unstable = this.collapse ? 1 : 0;
    black.onCapture = (h, p) => this.capture(h, p);
    black.onThrough = (h, p, cam) => this.through(h, p, cam);
  }

  get open() { return this.collapse; }
  // Сохраняется только то, что путь к Ксаррону найден
  save() { save(this.known ? 8 : 0); }

  // Врата: на орбите Ксаррона (космическая сцена) и над Землёй (основная)
  build(scene, space, env) {
    this.env = env;
    this.xGate = new Portal(space.scene, XARRON_GATE, space.uniforms.uLogK);
    this.eGate = new Portal(scene, EARTH_GATE);
  }

  // Победа над Ксаргом: дыра снова коллапсирует (и после прошлых побед тоже). Начнётся, когда игрок будет в мире
  // Земные врата прячутся до следующего прилёта с Ксаррона (решение автора: появляются, только когда вошёл в них оттуда)
  unlock() {
    this.hideGate();
    if (this.collapse) return;
    this.collapse = true;
    this.away = false;
    this.save();
    this.onsetIn = ONSET;
  }

  hideGate() {
    this.gatesOpen = false;
    EARTH_GATE.hidden = true;
  }

  // Новая игра из меню: ни коллапса, ни земных врат
  newGame() {
    this.hideGate();
    if (this.collapse || this.onsetIn > 0) this.calm();
  }

  // Герой вышел из земных врат, прилетев с Ксаррона: коллапс стихает, врата над Землёй открыты до новой игры или победы
  settle() {
    this.gatesOpen = true;
    EARTH_GATE.hidden = false;
    this.calm();
  }

  // Герой вернулся в нашу систему: коллапс стихает, дыра снова как прежде
  calm() {
    this.collapse = this.away = false;
    this.save();
    this.onsetIn = -1;
    this.black.unstable = 0;
  }

  // Для проверок: вернуть дыру в прежнее состояние
  lock() {
    this.collapse = this.gatesOpen = this.away = this.known = false;
    this.save();
    this.onsetIn = -1;
    this.black.unstable = 0;
    EARTH_GATE.hidden = true;
  }

  // Путь ещё не найден (до первой победы, или коллапс после неё ещё не начался) или идёт бой — старое падение с выбросом над Землёй
  capture(h, player) {
    if (!this.known || this.blocked?.()) { h.startFall(player); return true; }
    h.startFall(player, true);
    this.transitSound();
    return true;
  }

  // Конец туннеля: выход из белой дыры лицом к звезде Ксаррона, поток выносит прочь от дыры
  through(h, player, camRig) {
    const W = this.world, H = this.white.H, dir = H.toward;
    player.grounded = false; player.falling = false; player.slamming = false;
    player.onBody = player.nearBody = null;
    W.effects.screenFlash = 1.5;
    this.exitSound(true);
    player.pos.copy(H.c).addScaledVector(dir, H.rs * EXIT_RS);
    setRegion('xarron');
    this.white.emerge();
    this.white.hasPrev = false;
    this.aim(camRig, dir);
    let t = 0;
    this.driven = (dt) => {
      t += dt;
      player.vel.copy(dir).multiplyScalar(THREE.MathUtils.lerp(9000, 400, smooth(t, 0, EXIT_T)));
      player.pos.addScaledVector(player.vel, dt);
      if (t > EXIT_T && player.driven === this.driven) player.driven = null;
    };
    player.driven = this.driven;
    W.toast?.(H.name.toUpperCase(), 2.4);
  }

  // Сквозь врата: вспышка — и ты у вторых. С Ксаррона выходишь к городу на полётной скорости,
  // на Ксаррон — лицом к планете, со своей скоростью (но не быстрее 9 км/с)
  jump(from, player, camRig) {
    const W = this.world, home = from === this.xGate, to = home ? this.eGate : this.xGate, G = to.G;
    const out = home ? _o.copy(G.n) : _o.copy(G.n).negate();
    const sp = player.vel.length();
    if (home) this.settle();
    player.pos.copy(G.c).addScaledVector(out, 25);
    player.vel.copy(out).multiplyScalar(home ? clamp(sp, 80, 250) : clamp(sp, 400, 9000));
    player.grounded = false; player.falling = false; player.slamming = false; player.cruising = false;
    player.onBody = player.nearBody = null;
    setRegion(regionAt(player.pos));
    this.black.hasPrev = this.white.hasPrev = false;
    this.aim(camRig, out);
    from.flare = to.flare = 1;
    W.effects.screenFlash = 1.6;
    W.audio?.whoosh(1);
    this.exitSound(!home);
    W.toast?.(home ? 'ЗЕМЛЯ' : G.name.toUpperCase(), 2.4);
    this.cool = GATE_COOL;
  }

  // Врата: открыты ли, свет на них и пролёт героя сквозь гладь (по отрезку пути за кадр)
  gates(dt, player, camRig) {
    if (!this.xGate) return;
    const W = this.world, busy = !!this.blocked?.();
    const xOn = REGION === 'xarron' && !W.space?.mapBodyId;
    const eOn = REGION === 'sol' && this.gatesOpen && !busy && !W.planetMap?.active;
    this.xGate.update(dt, xOn, XARRON_GATE_SUN);
    this.eGate.update(dt, eOn, this.env?.sunDir);
    this.cool -= dt;
    if (this.hasPrev && !player.driven && !W.planetMap?.active && !busy && this.cool <= 0) {
      for (const g of [xOn && this.xGate, eOn && this.eGate]) {
        if (g && g.k > 0.5 && g.crossed(this.prevPos, player.pos)) { this.jump(g, player, camRig); break; }
      }
    }
    this.prevPos.copy(player.pos);
    this.hasPrev = true;
  }

  aim(camRig, d) {
    if (!camRig) return;
    camRig.yaw = Math.atan2(-d.x, -d.z);
    camRig.pitch = Math.asin(THREE.MathUtils.clamp(d.y, -1, 1));
  }

  update(dt, player, camRig) {
    this.gates(dt, player, camRig);
    if (!this.collapse) return;
    // Долетел до Ксаррона — запомнить; потом оказался дома (врата, меню, перезагрузка) — коллапс стихает
    if (REGION === 'xarron' && !this.away) { this.away = true; this.save(); }
    if (REGION === 'sol' && this.away && !this.black.fall) { this.calm(); return; }
    if (this.onsetIn > 0) {
      this.onsetIn -= dt;
      if (this.onsetIn > 0) return;
      // Начало коллапса: первая волна сразу; с этого мига путь к Ксаррону открыт навсегда
      this.black.unstable = 1;
      if (!this.known) { this.known = true; this.save(); }
      this.nextWave = 0;
    }
    if (REGION !== 'sol') return;
    this.nextWave -= dt;
    if (this.nextWave > 0) return;
    this.nextWave = PERIOD[0] + Math.random() * (PERIOD[1] - PERIOD[0]);
    this.black.wave();
    const L = this.loudness(player);
    this.swell(L);
    this.waveSound(0.5 * L, this.near);
  }

  // Насколько слышно дыру (0…1): у самой дыры — во всю силу, в космосе громче, чем на Земле, но слышно везде
  loudness(player) {
    const H = this.black.H, r = player.pos.distanceTo(H.c) / H.rs;
    this.near = 1 - smooth(r, 20, 160);
    return Math.max(this.near, 0.45 + 0.25 * smooth(player.pos.y, SPACE.atmosphere, SPACE.spaceAlt));
  }

  // Гул коллапса — каждый кадр, и на паузе тоже (там он стихает)
  drone(player, paused) {
    const A = this.world.audio;
    if (!A?.ctx || !A.master) return;
    const on = !paused && this.collapse && REGION === 'sol' && !this.black.fall;
    const k = on ? this.black.u * (0.06 + 0.16 * this.loudness(player)) : 0;
    if (!this.hum) {
      if (k <= 0.002) return;
      this.hum = this.makeDrone(A);
    }
    this.hum.out.gain.setTargetAtTime(k, A.ctx.currentTime, k > 0 ? 0.5 : 0.15);
  }

  // Как гул корабля — пилы через октаву и бурый шум под низким фильтром, — но волнами: вторая пара пил
  // чуть расстроена (биения), громкость и фильтр медленно качаются
  makeDrone(A) {
    const ctx = A.ctx;
    const out = ctx.createGain(); out.gain.value = 0;
    const swell = ctx.createGain(); swell.gain.value = 1;
    const trem = ctx.createGain(); trem.gain.value = 0.65;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.42;
    const lg = ctx.createGain(); lg.gain.value = 0.35;
    lfo.connect(lg).connect(trem.gain);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 150; lp.Q.value = 2;
    const fl = ctx.createOscillator(); fl.frequency.value = 0.27;
    const fg = ctx.createGain(); fg.gain.value = 60;
    fl.connect(fg).connect(lp.frequency);
    const oscs = [[33, 1], [66, 0.8], [33.55, 0.9], [67.3, 0.7]].map(([f, v]) => {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
      const g = ctx.createGain(); g.gain.value = v * 0.5;
      o.connect(g).connect(lp);
      return o;
    });
    const rum = ctx.createBufferSource(); rum.buffer = this.brown(ctx); rum.loop = true;
    const rg = ctx.createGain(); rg.gain.value = 0.8;
    rum.connect(rg).connect(lp);
    lp.connect(trem).connect(swell).connect(out).connect(A.master);
    for (const s of [lfo, fl, rum, ...oscs]) s.start();
    return { out, swell, lp };
  }

  // С каждой волной гул вздымается и светлеет, потом опадает
  swell(L) {
    const h = this.hum, A = this.world.audio;
    if (!h || !A?.ctx) return;
    const t = A.ctx.currentTime;
    for (const [p, peak, base, tau] of [[h.swell.gain, 1.8 + L, 1, 0.7], [h.lp.frequency, 420, 150, 0.8]]) {
      p.cancelScheduledValues(t);
      p.setValueAtTime(p.value, t);
      p.linearRampToValueAtTime(peak, t + 0.5);
      p.setTargetAtTime(base, t + 0.6, tau);
    }
  }

  // Волна: низкий тон уходит вниз и плывёт (вибрато), громкость качается волнами,
  // под ним — шум, у которого «дышит» фильтр
  waveSound(g, near) {
    const A = this.world.audio;
    if (!A?.ctx || !A.master) return;
    const ctx = A.ctx, t = ctx.currentTime, dur = 4.4;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(g, t + 0.6);
    out.gain.setTargetAtTime(0.0001, t + 1.8, 0.85);
    out.connect(A.master);
    const trem = ctx.createGain(); trem.gain.value = 0.6;
    const lfo = ctx.createOscillator();
    lfo.frequency.setValueAtTime(3.4, t); lfo.frequency.linearRampToValueAtTime(1.1, t + dur);
    const lg = ctx.createGain(); lg.gain.value = 0.4;
    lfo.connect(lg).connect(trem.gain);
    trem.connect(out);
    const vib = ctx.createOscillator();
    vib.frequency.setValueAtTime(4.8, t); vib.frequency.linearRampToValueAtTime(1.5, t + dur);
    const vg = ctx.createGain(); vg.gain.value = 6;
    vib.connect(vg);
    const o1 = ctx.createOscillator(); o1.type = 'sine';
    o1.frequency.setValueAtTime(74, t); o1.frequency.exponentialRampToValueAtTime(23, t + dur);
    const o2 = ctx.createOscillator(); o2.type = 'triangle';
    o2.frequency.setValueAtTime(111, t); o2.frequency.exponentialRampToValueAtTime(35, t + dur);
    vg.connect(o1.frequency); vg.connect(o2.frequency);
    const g2 = ctx.createGain(); g2.gain.value = 0.22;
    o1.connect(trem); o2.connect(g2).connect(trem);
    const nz = ctx.createBufferSource(); nz.buffer = this.brown(ctx);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(380 + 400 * near, t); lp.frequency.exponentialRampToValueAtTime(80, t + dur);
    const fl = ctx.createOscillator(); fl.frequency.value = 1.7;
    const fg = ctx.createGain(); fg.gain.value = 70 + 120 * near;
    fl.connect(fg).connect(lp.frequency);
    const ng = ctx.createGain(); ng.gain.value = 0.55;
    nz.connect(lp).connect(ng).connect(out);
    const end = t + dur + 0.6;
    for (const s of [lfo, vib, o1, o2, nz, fl]) { s.start(t); s.stop(end); }
  }

  // Туннель: нарастающий рёв, тон ползёт вверх и плывёт
  transitSound() {
    const A = this.world.audio;
    if (!A?.ctx || !A.master) return;
    const ctx = A.ctx, t = ctx.currentTime + 2.2, dur = 3.4;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.42, t + dur);
    out.gain.setTargetAtTime(0.0001, t + dur, 0.08);
    out.connect(A.master);
    const nz = ctx.createBufferSource(); nz.buffer = this.brown(ctx);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.8;
    bp.frequency.setValueAtTime(160, t); bp.frequency.exponentialRampToValueAtTime(2400, t + dur);
    nz.connect(bp).connect(out);
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(42, t); o.frequency.exponentialRampToValueAtTime(170, t + dur);
    const vib = ctx.createOscillator(); vib.frequency.value = 5.5;
    const vg = ctx.createGain(); vg.gain.value = 5;
    vib.connect(vg).connect(o.frequency);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 600;
    const og = ctx.createGain(); og.gain.value = 0.18;
    o.connect(lp).connect(og).connect(out);
    for (const s of [nz, o, vib]) { s.start(t); s.stop(t + dur + 0.5); }
  }

  // Выход: удар и светлый звон (из белой дыры — выше и ярче)
  exitSound(bright) {
    const A = this.world.audio;
    if (!A?.ctx || !A.master) return;
    A.boom(1.3);
    const ctx = A.ctx, t = ctx.currentTime;
    for (const [f, k] of bright ? [[523, 1], [784, 0.7], [1046, 0.4]] : [[392, 1], [587, 0.6]]) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.09 * k, t + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 3.2);
      o.connect(g).connect(A.master);
      o.start(t); o.stop(t + 3.3);
    }
  }

  // Бурый шум (общий буфер на 5 с)
  brown(ctx) {
    if (this.noiseBuf) return this.noiseBuf;
    const buf = ctx.createBuffer(1, ctx.sampleRate * 5, ctx.sampleRate), ch = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < ch.length; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; ch[i] = last * 3.5; }
    return (this.noiseBuf = buf);
  }
}
