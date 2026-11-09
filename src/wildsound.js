import * as THREE from 'three';
import { MUSIC_VOLUME } from './audio.js';
import { BIG_PARK, POND, RIVER_Z, RIVER_HALF_W, PLANE_HALF, HALF, DISTRICTS, BLOCK, blockAt, forestMask, sampleTerrain, islandSample } from './world/layout.js';

// Живые голоса мира поверх soundscape: всё синтезируется, без файлов.
// Природа: листва на ветру, певчие птицы днём, совы и лягушки ночью, утки у воды,
// коровы и лошади у стад. Город: голуби, звон чашек в кафе, детский смех в парках,
// собаки вдалеке в пригороде, колокола старого города (бьют часы), музыкальная
// шкатулка карусели на пирсе. Без сирен и гудков.

const ss = THREE.MathUtils.smoothstep, lerp = THREE.MathUtils.lerp;
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
const _p = new THREE.Vector3();

// Мелодия шкатулки: собственный медленный вальс (3/4), восьмые доли; 0 — пауза
const BOX_MELODY = [
  76, 0, 79, 0, 84, 0, 83, 0, 79, 0, 76, 0,
  74, 0, 77, 0, 81, 0, 79, 0, 76, 0, 72, 0,
  72, 0, 76, 0, 79, 0, 81, 0, 79, 77, 76, 0,
  74, 0, 71, 0, 74, 0, 72, 0, 0, 0, 0, 0,
];
const BOX_BASS = [48, 53, 55, 48]; // по такту

// Пляжная вечеринка на острове: 104 удара в минуту, шестнадцатые; аккорды C – Am – F – G
const PARTY_STEP = 60 / 104 / 4;
const PARTY_BASS = [36, 33, 29, 31];
const PARTY_PAN = [
  [72, 0, 76, 0, 79, 0, 76, 74, 0, 72, 0, 74, 76, 0, 0, 0],
  [69, 0, 72, 0, 76, 0, 74, 72, 0, 69, 0, 72, 74, 0, 72, 0],
  [65, 0, 69, 0, 72, 0, 74, 72, 0, 69, 0, 72, 77, 0, 76, 0],
  [67, 0, 71, 0, 74, 0, 79, 0, 76, 74, 0, 72, 71, 0, 67, 0],
];

export class WildSound {
  constructor(audio, soundscape) {
    this.a = audio;
    this.s = soundscape;
    this.next = {};
    this.lastHour = null;
    this.herdT = 0;
    this.herd = null;
    this.box = { step: 0, at: 0 };
  }

  build() {
    const a = this.a, ctx = a.ctx;
    this.built = true;
    // Листва: шелест — полоса высокого шума с медленными «порывами»
    const src = ctx.createBufferSource(); src.buffer = a.noise; src.loop = true; src.start(0, Math.random() * 2);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 3200; bp.Q.value = 0.45;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 6500;
    const am = ctx.createGain(); am.gain.value = 0.55;
    for (const [f, d] of [[0.13, 0.25], [0.31, 0.15], [0.053, 0.2]]) {
      const o = ctx.createOscillator(); o.frequency.value = f; o.start();
      const g = ctx.createGain(); g.gain.value = d; o.connect(g).connect(am.gain);
    }
    this.leafGain = ctx.createGain(); this.leafGain.gain.value = 0;
    src.connect(bp).connect(lp).connect(am).connect(this.leafGain).connect(a.ambBus);
    // Прибой у острова: медленные накаты и шипение пены по песку
    const surf = ctx.createBufferSource(); surf.buffer = a.brown; surf.loop = true; surf.start(0, Math.random() * 2);
    const slp = ctx.createBiquadFilter(); slp.type = 'lowpass'; slp.frequency.value = 700;
    const swell = ctx.createGain(); swell.gain.value = 0.55;
    const sl = ctx.createOscillator(); sl.frequency.value = 0.11; sl.start();
    const sd = ctx.createGain(); sd.gain.value = 0.45; sl.connect(sd).connect(swell.gain);
    const hiss = ctx.createBufferSource(); hiss.buffer = a.noise; hiss.loop = true; hiss.start(0, Math.random() * 2);
    const hbp = ctx.createBiquadFilter(); hbp.type = 'bandpass'; hbp.frequency.value = 2400; hbp.Q.value = 0.5;
    const hg = ctx.createGain(); hg.gain.value = 0.12;
    this.isleSurf = ctx.createGain(); this.isleSurf.gain.value = 0;
    surf.connect(slp).connect(swell); hiss.connect(hbp).connect(hg).connect(swell);
    swell.connect(this.isleSurf).connect(a.ambBus);
    this.party = { at: 0, step: 0 };
  }

  // Событие с частотой «раз в ~rate секунд» (со случайным разбросом)
  ev(name, rate, dt) {
    if (this.next[name] === undefined) this.next[name] = Math.random() * rate;
    this.next[name] -= dt;
    if (this.next[name] > 0) return false;
    this.next[name] = rate * (0.5 + Math.random());
    return true;
  }

  around(cam, r0, r1, y0, y1) {
    const ang = Math.random() * Math.PI * 2, r = r0 + Math.random() * (r1 - r0);
    return new THREE.Vector3(cam.x + Math.cos(ang) * r, cam.y + y0 + Math.random() * (y1 - y0), cam.z + Math.sin(ang) * r);
  }

  update({ dt, camera, env, world, paused, menu = paused, slow = 1 }) {
    const a = this.a;
    if (!a.ctx || !a.ambBus) return;
    if (!this.built) this.build();
    this.updatePartyTrack(world, camera, env, menu, slow, dt);
    const ctx = a.ctx, t = ctx.currentTime, cam = camera.position;
    const r = Math.max(Math.abs(cam.x), Math.abs(cam.z));
    const outside = r > PLANE_HALF;
    const h = outside ? sampleTerrain(cam.x, cam.z) : 0;
    const low = 1 - ss(cam.y - Math.max(0, h), 25, 220);
    const night = env.night, day = 1 - ss(night, 0.3, 0.7), rain = env.W.rain;
    const bt = r < HALF ? blockAt(cam.x, cam.z) : -1;
    const inBig = cam.x > BIG_PARK.minX && cam.x < BIG_PARK.maxX && cam.z > BIG_PARK.minZ && cam.z < BIG_PARK.maxZ;
    const inPark = inBig || bt === BLOCK.PARK || bt === BLOCK.BIGPARK;
    const country = ss(r, PLANE_HALF + 100, PLANE_HALF + 700);
    const forest = outside ? forestMask(cam.x, cam.z, h) : 0;
    const green = Math.max(inPark ? 1 : 0, country * 0.8, forest) * low * (1 - rain * 0.7);
    const live = paused ? 0 : 1;

    this.leafGain.gain.setTargetAtTime(live * Math.max(inPark ? 0.8 : 0, forest, country * 0.35) * low * 0.03, t, 0.8);
    if (paused) return;

    // ---- птицы, совы
    if (green * day > 0.2 && this.ev('song', 3.2 / (green * day), dt)) this.songbird(this.around(cam, 10, 40, 3, 14));
    if (green * night > 0.4 && this.ev('owl', 20, dt)) this.owl(this.around(cam, 30, 70, 8, 20));

    // ---- вода: утки днём, лягушки ночью
    const dPond = Math.hypot(cam.x - POND.x, cam.z - POND.z) - POND.r;
    const dRiver = Math.abs(cam.x) < PLANE_HALF ? Math.abs(cam.z - RIVER_Z) - RIVER_HALF_W : 1e9;
    const water = Math.max(1 - ss(dPond, 10, 140), 1 - ss(dRiver, 10, 110)) * low;
    const wp = () => (dPond < dRiver
      ? new THREE.Vector3(POND.x + (Math.random() - 0.5) * POND.r, 0.3, POND.z + (Math.random() - 0.5) * POND.r)
      : new THREE.Vector3(cam.x + (Math.random() - 0.5) * 60, 0.3, RIVER_Z + (Math.random() - 0.5) * RIVER_HALF_W));
    if (water * day > 0.25 && this.ev('duck', 6, dt)) this.quack(wp());
    if (water * night > 0.25 && this.ev('frog', 1.4, dt)) this.frog(wp());
    if (outside && green * night > 0.3 && this.ev('frogFar', 4, dt)) this.frog(this.around(cam, 40, 80, -2, 0));

    // ---- стада: мычание и ржание рядом
    this.herdT -= dt;
    if (this.herdT <= 0) {
      this.herdT = 0.6;
      this.herd = null;
      let best = 180;
      for (const an of world.countryside?.animals || []) {
        const d = an.pos.distanceTo(cam);
        if (d < best) { best = d; this.herd = an; }
      }
    }
    if (this.herd && day > 0.3 && this.ev('herd', 9, dt)) {
      _p.copy(this.herd.pos).setY(this.herd.pos.y + 1.5);
      if (this.herd.kind === 'cow') this.moo(_p.clone()); else this.neigh(_p.clone());
    }

    // ---- город: собаки вдалеке, голуби, кафе, дети
    const suburb = ss(r, 2100, 2900) * (1 - ss(r, HALF + 200, HALF + 1200)) * low;
    if (suburb > 0.3 && this.ev('dogFar', 28, dt)) this.s.bark(this.around(cam, 55, 85, 0, 2), 0.8 + Math.random() * 0.6);
    const street = (a.amb.urban || 0) * (1 - ss(cam.y, 8, 40)) * (1 - rain);
    if (street * day > 0.3 && this.ev('coo', 9, dt)) this.coo(this.around(cam, 6, 22, 0, 4));
    if (street * day > 0.4 && this.ev('cup', 7, dt)) this.clink(this.around(cam, 6, 22, 0.8, 1.2));
    if (inPark && day > 0.5 && low > 0.6 && rain < 0.3 && this.ev('kids', 15, dt)) this.laugh(this.around(cam, 15, 40, 1, 1.5));

    // ---- колокола старого города: бьют часы и иногда звонят перезвоном
    const old = DISTRICTS.oldtown;
    const oldK = (1 - ss(Math.hypot(cam.x - old.x, cam.z - old.z), 350, 1100)) * (1 - ss(cam.y, 300, 1500));
    const hr = Math.floor(env.hour);
    const belfry = _p.set(old.x, 45, old.z).clone();
    if (this.lastHour !== null && hr !== this.lastHour && oldK > 0.05) this.toll(hr % 12 || 12, belfry);
    this.lastHour = hr;
    if (oldK > 0.3 && day > 0.3 && this.ev('chime', 150, dt)) this.carillon(belfry);

    // ---- райский остров: прибой у берегов и музыка пляжной вечеринки
    const isl = outside ? islandSample(cam.x, cam.z) : null;
    const coastK = isl ? (1 - ss(Math.abs(isl.sd), 20, 280)) * (1 - ss(cam.y - Math.max(0, isl.h), 20, 260)) : 0;
    this.isleSurf.gain.setTargetAtTime(coastK * 0.14 * (1 - rain * 0.3), t, 0.8);
    const party = world.island?.party;
    if (party) {
      _p.set(party.x, cam.y < 60 ? 2 : 6, party.z);
      const pk = (1 - ss(_p.distanceTo(cam), 40, 420)) * (1 - rain * 0.7);
      if (pk > 0.01) {
        if (!this.track?.list.length) this.partyMusic(t, _p.clone(), pk);
        if (pk > 0.4 && this.ev('partyCheer', 26, dt)) this.s.cheer(0.45, _p.clone());
      } else this.party.at = 0;
    }

    // ---- шкатулка карусели
    const car = world.pier?.carousel;
    if (car) {
      car.getWorldPosition(_p);
      const k = (1 - ss(_p.distanceTo(cam), 15, 110)) * (1 - rain * 0.6);
      if (k > 0.01) this.musicBox(t, _p.clone().setY(_p.y + 3), k);
      else this.box.at = 0;
    }
  }

  // ---------------------------------------------------------------- голоса
  // Тон с мягкой атакой и спадом (без щелчков)
  note(t0, f0, f1, dur, g, dest, type = 'sine', att = 0.012) {
    const ctx = this.a.ctx;
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    const e = ctx.createGain();
    e.gain.setValueAtTime(0.0001, t0);
    e.gain.exponentialRampToValueAtTime(g, t0 + Math.min(att, dur * 0.4));
    e.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(e).connect(dest);
    o.start(t0); o.stop(t0 + dur + 0.03);
  }

  // Певчие птицы: трель, свист, «чирик» или мелодичная флейта
  songbird(pos) {
    const ctx = this.a.ctx, dest = this.a.out(pos), t = ctx.currentTime + 0.05, kind = Math.floor(Math.random() * 4);
    const g = 0.025;
    if (kind === 0) {
      const f = 4000 + Math.random() * 1500, n = 8 + Math.floor(Math.random() * 7);
      for (let i = 0; i < n; i++) this.note(t + i * 0.065, f * (i % 2 ? 1.08 : 0.95), f * (i % 2 ? 0.98 : 1.04), 0.045, g * 0.8, dest);
    } else if (kind === 1) {
      const f = 2400 + Math.random() * 800;
      for (let i = 0; i < 2 + Math.floor(Math.random() * 2); i++) {
        this.note(t + i * 0.42, f, f * 1.45, 0.16, g, dest);
        this.note(t + i * 0.42 + 0.16, f * 1.45, f * 1.1, 0.18, g, dest);
      }
    } else if (kind === 2) {
      for (let i = 0; i < 3; i++) this.note(t + i * 0.12, 6200, 3200, 0.06, g * 0.7, dest);
      for (let i = 0; i < 6; i++) this.note(t + 0.4 + i * 0.05, 4800, 4300, 0.035, g * 0.6, dest);
    } else {
      const scale = [0, 2, 4, 7, 9, 12], base = 1700 + Math.random() * 600;
      let tt = t;
      for (let i = 0; i < 4 + Math.floor(Math.random() * 3); i++) {
        const f = base * Math.pow(2, scale[Math.floor(Math.random() * scale.length)] / 12), d = 0.12 + Math.random() * 0.12;
        this.note(tt, f, f * (Math.random() < 0.3 ? 1.12 : 0.98), d, g, dest, 'sine', 0.02);
        tt += d + 0.03;
      }
    }
  }

  // Сова: «у-ху… у-у-у»
  owl(pos) {
    const dest = this.a.out(pos), t = this.a.ctx.currentTime + 0.05;
    this.note(t, 390, 370, 0.4, 0.05, dest, 'sine', 0.06);
    this.note(t + 0.55, 400, 380, 0.25, 0.045, dest, 'sine', 0.05);
    this.note(t + 0.9, 395, 360, 0.7, 0.05, dest, 'sine', 0.08);
  }

  // Утка: носовое «кря» 1–4 раза
  quack(pos) {
    const s = this.s, dest = this.a.out(pos), t = this.a.ctx.currentTime + 0.05, n = 1 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) s.voice(t + i * 0.17, 330 + Math.random() * 40, [0.92, 0.75], 0.13, 0.06, [[1100, 4, 1], [2300, 5, 0.6]], dest);
  }

  // Лягушка: низкое «ква» из коротких пульсов
  frog(pos) {
    const dest = this.a.out(pos), t = this.a.ctx.currentTime + Math.random() * 0.2, f = 110 + Math.random() * 90;
    for (let i = 0; i < 2 + Math.floor(Math.random() * 3); i++) this.note(t + i * 0.07, f, f * 0.9, 0.06, 0.05, dest, 'triangle', 0.008);
  }

  moo(pos) { this.s.voice(this.a.ctx.currentTime + 0.05, 105 + Math.random() * 25, [1.25, 0.82], 1.5, 0.09, [[420, 4, 1], [850, 5, 0.5]], this.a.out(pos)); }

  // Лошадь: дрожащее ржание сверху вниз и фырканье
  neigh(pos) {
    const s = this.s, dest = this.a.out(pos), t = this.a.ctx.currentTime + 0.05;
    for (let i = 0; i < 8; i++) s.voice(t + i * 0.09, 760 - i * 55, [1.12, 0.88], 0.1, 0.045, [[1300, 4, 1], [2500, 5, 0.4]], dest);
    this.a.noiseBurst({ dur: 0.3, freq: 700, type: 'bandpass', q: 0.8, gain: 0.05, attack: 0.02, delay: 0.95, dest });
  }

  // Голубь: мягкое «гу-у»
  coo(pos) {
    const dest = this.a.out(pos), t = this.a.ctx.currentTime + 0.05, f = 330 + Math.random() * 60;
    this.note(t, f, f * 1.12, 0.25, 0.035, dest, 'sine', 0.05);
    this.note(t + 0.28, f * 1.1, f * 0.85, 0.45, 0.03, dest, 'sine', 0.06);
  }

  // Звон чашек: два коротких «динь»
  clink(pos) {
    const dest = this.a.out(pos), t = this.a.ctx.currentTime + 0.05, f = 3000 + Math.random() * 1800;
    for (let i = 0; i < 1 + Math.floor(Math.random() * 2); i++) {
      this.note(t + i * 0.11, f, f * 0.995, 0.28, 0.012, dest, 'sine', 0.003);
      this.note(t + i * 0.11, f * 2.71, f * 2.7, 0.15, 0.005, dest, 'sine', 0.003);
    }
  }

  // Детский смех: «ха-ха-ха» высоким голосом
  laugh(pos) {
    const s = this.s, dest = this.a.out(pos), t = this.a.ctx.currentTime + 0.05, f0 = 340 + Math.random() * 120, n = 4 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) s.voice(t + i * 0.14, f0 * (1 - i * 0.03), [1.1, 0.9], 0.11, 0.035, [[950, 5, 1], [1600, 6, 0.6]], dest);
  }

  // Колокол: набор негармоничных обертонов с долгим затуханием
  bell(t0, f, g, dest) {
    for (const [r, k, d] of [[0.5, 0.6, 5], [1, 1, 3.5], [1.19, 0.5, 2.5], [1.5, 0.35, 2], [2, 0.45, 1.6], [2.74, 0.2, 1], [3.9, 0.12, 0.7]]) {
      this.note(t0, f * r, f * r * 0.999, d, g * k, dest, 'sine', 0.004);
    }
  }

  toll(count, pos) {
    const dest = this.a.out(pos), t = this.a.ctx.currentTime + 0.1;
    for (let i = 0; i < count; i++) this.bell(t + i * 2.2, 196, 0.08, dest);
  }

  carillon(pos) {
    const dest = this.a.out(pos), t = this.a.ctx.currentTime + 0.1;
    [79, 76, 77, 72, 72, 77, 79, 76].forEach((n, i) => this.bell(t + i * 0.55, midi(n), 0.035, dest));
  }

  // Шкатулка: ноты планируются чуть вперёд по часам звука — темп ровный
  musicBox(t, pos, k) {
    const B = this.box, step = 0.2;
    if (!B.at || B.at < t - 0.5) B.at = t + 0.05;
    while (B.at < t + 0.25) {
      const i = B.step % BOX_MELODY.length, n = BOX_MELODY[i];
      const dest = this.a.out(pos);
      if (n) this.pluck(B.at, midi(n), 0.035 * k, dest);
      if (i % 12 === 0) this.pluck(B.at, midi(BOX_BASS[Math.floor(i / 12) % BOX_BASS.length]), 0.03 * k, dest);
      B.at += step;
      B.step++;
    }
  }

  // ---------------------------------------------------------------- свой трек тусовки
  // Файлы из music/party/ играют на пляже вечеринки вместо синтезированной музыки.
  // Звук «живёт» на сцене: у танцпола — в полную силу, дальше — тише и глуше,
  // сбоку — смещается в нужное ухо. Пока звучит трек, своя музыка (M) уходит в тень.
  // По басам трека ловятся удары — в такт им мигают прожекторы и двигаются танцоры.
  async loadPartyTracks() {
    let list = [];
    try {
      const html = await (await fetch('music/party/')).text();
      list = [...new Set([...html.matchAll(/href="([^"]+\.(?:mp3|ogg|m4a|wav|flac|webm|opus|aac))"/gi)].map((m) => 'music/party/' + m[1]))];
    } catch { list = []; }
    const ctx = this.a.ctx;
    const el = new Audio();
    el.preload = 'auto';
    el.loop = list.length === 1;
    el.preservesPitch = false;
    const src = ctx.createMediaElementSource(el);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 18000; lp.Q.value = 0.5;
    const gain = ctx.createGain(); gain.gain.value = 0;
    const pan = ctx.createStereoPanner();
    src.connect(lp).connect(gain).connect(pan).connect(this.a.muffle || ctx.destination);
    // Анализ басов — до громкости, чтобы ритм ловился на любом расстоянии
    const an = ctx.createAnalyser(); an.fftSize = 1024; an.smoothingTimeConstant = 0.2;
    src.connect(an);
    this.track = { list, i: 0, el, lp, gain, pan, an, bins: new Uint8Array(an.frequencyBinCount), avg: 0, lastKick: 0, kicks: [], k: 0 };
    el.addEventListener('ended', () => { const T = this.track; if (T.list.length > 1) { T.i = (T.i + 1) % T.list.length; T.el.src = T.list[T.i]; T.el.play().catch(() => {}); } });
    if (list.length) el.src = list[0];
  }

  updatePartyTrack(world, camera, env, menu, slow, dt) {
    if (!this.track) { if (!this.trackLoading) { this.trackLoading = true; this.loadPartyTracks(); } return; }
    const T = this.track, isl = world.island;
    if (!T.list.length || !isl?.party) return;
    const ctx = this.a.ctx, t = ctx.currentTime, cam = camera.position;
    const party = isl.party;
    // Музыка звучит на всём острове (и над ним, и у берега), громче всего — у сцены.
    // Покинул остров — трек встаёт на паузу и ждёт; вернулся — играет с того же места
    const dx = party.x - cam.x, dz = party.z - cam.z, d = Math.hypot(dx, dz, Math.max(0, cam.y - 4));
    const s = islandSample(cam.x, cam.z);
    const onIsle = s && s.sd > -150 && cam.y - Math.max(0, s.h) < 700 ? 1 : 0;
    const zone = 1 - ss(d, 70, 700);
    const target = menu ? 0 : onIsle * lerp(0.45, 1, zone) * (1 - env.W.rain * 0.3);
    T.k += (target - T.k) * Math.min(1, dt * (target > T.k ? 1.2 : 2.5));
    if (T.k > 0.004) { if (T.el.paused) T.el.play().catch(() => {}); }
    else if (!T.el.paused) T.el.pause();
    T.gain.gain.setTargetAtTime(Math.pow(T.k, 1.4) * 0.65, t, 0.1);
    T.lp.frequency.setTargetAtTime(2500 + 15500 * Math.pow(zone, 1.6), t, 0.15);
    // Направление на сцену относительно камеры (внутри танцпола — звук со всех сторон)
    const R = this.a.listenerRight, len = Math.hypot(dx, dz) || 1;
    const side = R ? (dx * R.x + dz * R.z) / len : 0;
    T.pan.pan.setTargetAtTime(side * 0.7 * ss(d, 25, 140), t, 0.1);
    // Замедление времени (V) тянет и музыку — ниже и медленнее
    T.el.playbackRate = Math.max(0.5, Math.min(1, slow));
    // Своя музыка (M) отходит на второй план
    if (this.a.music) this.a.music.volume = MUSIC_VOLUME * (1 - 0.95 * T.k);
    // Удары баса: всплеск энергии низов над средним уровнем
    let kick = false;
    if (!T.el.paused) {
      T.an.getByteFrequencyData(T.bins);
      const binHz = ctx.sampleRate / T.an.fftSize;
      let e = 0, n = 0;
      for (let i = 1; i * binHz < 150; i++) { e += T.bins[i]; n++; }
      e /= Math.max(1, n) * 255;
      T.avg += (e - T.avg) * Math.min(1, dt * 1.5);
      if (e > T.avg * 1.18 + 0.04 && t - T.lastKick > 0.28) {
        kick = true;
        const iv = t - T.lastKick;
        if (iv < 1.2) { T.kicks.push(iv); if (T.kicks.length > 12) T.kicks.shift(); }
        T.lastKick = t;
      }
      T.pulse = Math.max((T.pulse || 0) * Math.exp(-dt * 7), kick ? 1 : 0);
    }
    // Темп: медиана интервалов между ударами (60–180 ударов в минуту)
    let bpm = null;
    if (T.kicks.length >= 4) {
      const s = [...T.kicks].sort((x, y) => x - y), iv = s[s.length >> 1];
      bpm = 60 / iv;
      while (bpm < 80) bpm *= 2;
      while (bpm > 180) bpm /= 2;
    }
    isl.music = T.el.paused ? null : { bpm, pulse: T.pulse || 0, kick };
  }

  // Пляжная музыка: бочка «четыре в пол», шейкер, хлопок, бас и мелодия стальных барабанов
  partyMusic(t, pos, k) {
    const B = this.party;
    if (!B.at || B.at < t - 0.5) B.at = t + 0.05;
    const dest = this.a.out(pos);
    while (B.at < t + 0.25) {
      const st = B.step % 16, bar = Math.floor(B.step / 16) % 4, t0 = B.at;
      if (st % 4 === 0) this.note(t0, 120, 42, 0.28, 0.16 * k, dest, 'sine', 0.004);
      this.a.noiseBurst({ dur: 0.04, freq: 7000, type: 'bandpass', q: 1.2, gain: (st % 2 ? 0.035 : 0.018) * k, attack: 0.002, delay: t0 - t, dest });
      if (st === 4 || st === 12) this.a.noiseBurst({ dur: 0.09, freq: 1700, type: 'bandpass', q: 0.8, gain: 0.05 * k, attack: 0.002, delay: t0 - t, dest });
      if ([0, 3, 6, 8, 11, 14].includes(st)) { const f = midi(PARTY_BASS[bar] + (st === 6 || st === 14 ? 12 : 0)); this.note(t0, f, f, 0.22, 0.07 * k, dest, 'triangle', 0.006); }
      const n = PARTY_PAN[bar][st];
      if (n) {
        const f = midi(n);
        this.note(t0, f, f, 0.45, 0.05 * k, dest, 'sine', 0.003);
        this.note(t0, f * 2.0, f * 2.0, 0.22, 0.02 * k, dest, 'sine', 0.003);
        this.note(t0, f * 3.96, f * 3.96, 0.12, 0.012 * k, dest, 'sine', 0.003);
      }
      B.at += PARTY_STEP;
      B.step++;
    }
  }

  pluck(t0, f, g, dest) {
    this.note(t0, f, f, 0.9, g, dest, 'sine', 0.003);
    this.note(t0, f * 2.0, f * 2.0, 0.45, g * 0.3, dest, 'sine', 0.003);
    this.note(t0, f * 3.01, f * 3.01, 0.25, g * 0.15, dest, 'sine', 0.003);
  }
}
