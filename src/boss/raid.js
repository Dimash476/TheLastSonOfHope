import * as THREE from 'three';
import { ArcTrail } from './battlefx.js';
import { groundHeight, inRiver } from '../world/layout.js';
import { clamp, lerp, smoothstep } from '../utils.js';

// Второй отряд десанта громит город. Сначала это сцена после отказа на переговорах: генерал отправляет
// отряд на город, и герой видит, чем кончился его ответ. Потом, пока герой бьётся с волной, отряд
// четырьмя группами ломает кварталы вдали: таранит ряды домов насквозь, бьёт в улицы. Вдали видно
// оранжевый след за каждым. Подлетишь к группе — она бросает город и идёт на героя.

export const RAIDERS = 12;
const PER = 3;            // десантников в группе
const UP = new THREE.Vector3(0, 1, 0);
const _p0 = new THREE.Vector3(), _s = new THREE.Vector3(), _d = new THREE.Vector3(), _e = new THREE.Vector3(), _c = new THREE.Vector3(), _r = new THREE.Vector3();
const CRUISE = 150;       // м: ниже группа над районом не кружит
const ENGAGE = 250;       // м: герой ближе — вся группа бросает город и идёт на него
const GAP = [4, 2.5];     // с между налётами группы: от и плюс случайно до. Чаще — обломки города нагружают кадр
const SMASH_MAX = 3;      // столько секций пробивает налёт на башню
const LINE_MAX = 5;       // столько секций пробивает таран вдоль ряда домов
const DISTRICT_R = 240;   // м: радиус района, который ломает группа
const FAR = 500;          // м от камеры: дальше пролом без мелочей — пыль, звук, след
const ANIM_FAR = 400;     // м: дальше фигуру почти не анимируем, её и так видно точкой
// Планы сцены: с какой секунды идёт каждый. Время сцены идёт вместе с замедлениями
const CUT = { row: 3.2, street: 7.8, tower: 12.0, aerial: 17.2, dive: 21.4, hero: 24.6, face: 27.4, end: 30.0 };

export class Raid {
  constructor(inv) {
    this.inv = inv;
    this.shot = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 60 };
    this.list = [];
    this.hits = [];
    this.groups = [];
    this.scene = null;
    this.muffled = false;
  }

  // Сцена идёт или группы в городе
  get busy() { return !!this.scene || this.groups.length > 0; }

  // Солдаты второго отряда: они в общем списке десанта, но живут по своим правилам, пока громят город
  attach(list) {
    this.list = list;
    for (const k of list) {
      k.raider = true;
      k.raid = null;
      k.lodN = Math.floor(Math.random() * 6);
      k.trail = new ArcTrail(this.inv.scene, new THREE.Color(1.1, 0.3, 0.12));
      k.trail.life = 2.2;
      k.trail.width = 1.1;
    }
  }

  reset() {
    this.scene = null;
    this.groups.length = 0;
    this.muffle(false);
    for (const k of this.list) { k.raid = null; k.trail.clear(); }
  }

  // Звук глохнет: высокие уходят, остаётся гул
  muffle(on) {
    if (this.muffled === on) return;
    this.muffled = on;
    this.inv.world.audio?.setMuffle?.(on ? 1 : 0);
  }

  // ---------------------------------------------------------------- кадр
  update(dt) {
    const I = this.inv, cam = I.camera.position, lens = Math.tan(I.camera.fov * Math.PI / 360);
    for (const k of this.list) {
      if (k.root.visible && (k.state === 'raid' || k.state === 'retreat')) {
        // След тянется всегда, и над районом тоже: по нему их видно издали (сам след рисуется только быстрее 120 м/с)
        k.trail.update(dt, k.c, Math.max(k.vel.length(), 130), cam, lens);
        // Только след: светящейся точки на голове нет
        k.trail.head.visible = false;
      } else if (k.trail.mesh.visible || k.trail.head.visible) k.trail.clear();
    }
    if (I.stage === 'wave' && I.fightOn && !I.heroDown) this.groupsTick(dt);
  }

  // Из Soldier.update, пока солдат громит город
  tick(k, dt, camPos) {
    const R = k.raid, W = this.inv.world;
    if (!R) { k.state = 'fight'; return; }
    if (R.mode === 'idle') return;
    R.t += dt;
    _p0.copy(k.pos);
    if (R.mode === 'cruise') this.cruise(k, R, dt);
    else if (R.mode === 'go') this.goTo(k, R, dt);
    else if (R.mode === 'run') this.run(k, R, dt);
    else if (R.mode === 'line') this.line(k, R, dt);
    else if (R.mode === 'dive') k.vel.copy(_d.subVectors(R.at, k.pos).normalize()).multiplyScalar(R.speed);
    else if (R.mode === 'rise') this.rise(k, R, dt);
    else k.vel.multiplyScalar(Math.exp(-2 * dt));
    k.pos.addScaledVector(k.vel, dt);
    if (Math.min(_p0.y, k.pos.y) < 700) this.sweep(k, R, _p0, k.pos);
    const gy = W.city.groundHeightAt(k.pos.x, k.pos.z, k.pos.y + 0.5);
    k.groundY = gy;
    if (R.mode === 'dive' && k.pos.y <= gy + 1.5) this.streetHit(k, R, gy);
    else if (k.pos.y < gy + 2) { k.pos.y = gy + 2; if (k.vel.y < 0) k.vel.y = 0; }
    // Головой по полёту
    const sp = k.vel.length();
    if (sp > 1) k.aim.copy(k.vel).divideScalar(sp);
    k.aimFlat.set(k.aim.x, 0, k.aim.z);
    if (k.aimFlat.lengthSq() > 1e-4) k.aimFlat.normalize(); else k.aimFlat.copy(k.facing);
    k.faceTarget = false;
    k.grounded = false;
    k.boosting = sp > 200;
    k.orient(dt);
    if (k.root.position.distanceToSquared(camPos) > ANIM_FAR * ANIM_FAR && ++k.lodN % 6) k.animAcc += dt;
    else k.animate(dt, camPos);
  }

  newRaid(mode = 'idle') {
    return { mode, lastB: -1, t: 0, at: new THREE.Vector3(), to: new THREE.Vector3(), dir: new THREE.Vector3(), speed: 0, next: 'hold', locked: false, smash: 0, max: SMASH_MAX, over: 120, group: null, line: null, phase: 0, ang: Math.random() * 6.28, rad: 120 + Math.random() * 120, dy: Math.random() * 40, sndT: -9 };
  }

  // Кружит над районом
  cruise(k, R, dt) {
    const g = R.group;
    if (!g) { R.mode = 'hold'; return; }
    R.ang += dt * 110 / R.rad;
    _e.set(g.c.x + Math.cos(R.ang) * R.rad, g.c.y + R.dy, g.c.z + Math.sin(R.ang) * R.rad);
    _d.set(-Math.sin(R.ang), 0, Math.cos(R.ang)).multiplyScalar(110).addScaledVector(_e.sub(k.pos), 0.8).clampLength(0, 300);
    k.vel.lerp(_d, 1 - Math.exp(-2.5 * dt));
  }

  // Летит в точку и там кружит или висит
  goTo(k, R, dt) {
    _d.subVectors(R.to, k.pos);
    const l = _d.length();
    if (l < 25) { R.mode = R.group ? 'cruise' : R.next; return; }
    _d.divideScalar(l).multiplyScalar(Math.min(R.speed, l * 2));
    k.vel.lerp(_d, 1 - Math.exp(-3 * dt));
  }

  // Налёт на башню: идёт в цель и по прямой насквозь, потом уходит вверх
  run(k, R, dt) {
    _d.subVectors(R.at, k.pos);
    if (!R.locked) {
      const l = _d.length();
      if (l < 70) R.locked = true;
      else R.dir.lerp(_d.divideScalar(l), 1 - Math.exp(-6 * dt)).normalize();
    }
    k.vel.copy(R.dir).multiplyScalar(R.speed);
    if ((R.locked && _d.subVectors(R.at, k.pos).dot(R.dir) < -R.over) || R.t > 8) this.endRun(R);
  }

  // Таран вдоль ряда домов: заход к началу ряда, у самого начала выравнивается и идёт насквозь
  line(k, R, dt) {
    const L = R.line;
    if (R.phase === 0) {
      // Заход сверху в точку перед рядом: издали над крышами, у самого ряда вниз
      _e.copy(L.start).addScaledVector(L.dir, -50);
      const l = _d.subVectors(_e, k.pos).length();
      _e.y += clamp(l * 0.35, 0, 220);
      _d.subVectors(_e, k.pos).normalize();
      k.vel.lerp(_d.multiplyScalar(R.speed), 1 - Math.exp(-8 * dt));
      if (l < 45 || R.t > 6) {
        R.phase = 1;
        R.t = 0;
        R.smash = 0;
        R.speed = R.lineSpeed;
        this.inv.world.effects.shockwave(k.c.clone(), { type: 'disc', dir: L.dir.clone(), radius: 16, life: 0.5, opacity: 0.55 });
        this.inv.fx.play('rush', { gain: 0.8, pos: k.c });
      }
      return;
    }
    // Вдоль ряда, быстро подтягиваясь на саму линию
    const u = _e.subVectors(k.pos, L.start).dot(L.dir);
    _e.copy(L.start).addScaledVector(L.dir, u + 20).sub(k.pos).multiplyScalar(4).clampLength(0, R.speed * 0.6);
    k.vel.copy(L.dir).multiplyScalar(R.speed).add(_e);
    if (_d.subVectors(L.end, k.pos).dot(L.dir) < 0 || R.t > 6) this.endRun(R);
  }

  endRun(R) {
    R.mode = 'rise';
    R.t = 0;
  }

  rise(k, R, dt) {
    _d.copy(R.dir).setY(0);
    if (_d.lengthSq() < 1e-3) _d.set(1, 0, 0);
    // Почти вертикально: над крышами, а не сквозь весь квартал
    _d.normalize().multiplyScalar(70).addScaledVector(UP, 230);
    k.vel.lerp(_d, 1 - Math.exp(-2.5 * dt));
    const top = R.group ? R.group.c.y : CRUISE;
    if (k.pos.y > top * 0.85 || R.t > 4) { R.mode = R.group ? 'cruise' : 'hold'; R.t = 0; }
  }

  startRun(k, target, speed, over = 90 + Math.random() * 80, max = SMASH_MAX) {
    const R = k.raid, W = this.inv.world;
    R.mode = 'run';
    R.t = 0;
    R.at.copy(target.p);
    R.dir.subVectors(R.at, k.pos).normalize();
    R.speed = speed;
    R.locked = false;
    R.smash = 0;
    R.max = max;
    R.over = over;
    // Срывается с места: воздух бьёт за ним
    W.effects.shockwave(k.c.clone(), { type: 'disc', dir: R.dir.clone(), radius: 14, life: 0.5, opacity: 0.55 });
    this.inv.fx.play('rush', { gain: 0.7, pos: k.c });
  }

  startLine(k, L, speed, max = LINE_MAX) {
    const R = k.raid;
    R.mode = 'line';
    R.phase = 0;
    R.t = 0;
    R.line = L;
    R.dir.copy(L.dir);
    R.speed = R.lineSpeed = speed;
    R.smash = 0;
    R.max = max;
  }

  startDive(k, at, speed = 340) {
    const R = k.raid;
    R.mode = 'dive';
    R.t = 0;
    R.at.copy(at);
    R.dir.subVectors(at, k.pos).normalize();
    R.speed = speed;
    this.inv.fx.play('rush', { gain: 0.8, pos: k.c });
  }

  launch(k, at, face) {
    k.stand(at, face);
    k.state = 'raid';
    k.root.visible = true;
    k.raid = k.raid?.mode === 'idle' ? Object.assign(k.raid, { mode: 'hold' }) : this.newRaid('hold');
    k.vel.copy(face).multiplyScalar(90).addScaledVector(UP, -40);
    k.trail.clear();
  }

  // ---------------------------------------------------------------- разрушение
  // Путь за кадр: всё, что попалось на пути, пробито насквозь
  sweep(k, R, p0, p1) {
    const city = this.inv.world.city, sp = k.vel.length();
    const n = Math.min(10, Math.max(1, Math.ceil(p0.distanceTo(p1) / 4)));
    // В пути к точке и над районом сквозь дома не ломится: ломают налёт, таран, пике
    if (R.mode === 'go' || R.mode === 'hold' || R.mode === 'cruise') return;
    const ram = R.mode === 'run' || R.mode === 'line';
    // Вдали каждый дом налёта по-настоящему не рушится: обвал и обломки цепляют соседей, и кадр тяжелеет.
    // Рушится первый, остальные — пыль и грохот вдоль следа
    const far = (!this.scene || R.bg) && p1.distanceToSquared(this.inv.camera.position) > FAR * FAR;
    for (let i = 1; i <= n; i++) {
      _s.lerpVectors(p0, p1, i / n);
      const s = city.segAt(_s, 1.2);
      if (!s) { R.lastB = -1; continue; }
      if (far && s.b === R.lastB) continue;
      if (ram && R.smash >= R.max) {
        // Хватит: дальше по верху
        k.pos.copy(_s).addScaledVector(R.dir, -2);
        R.dir.y = Math.max(R.dir.y, 0.6);
        R.dir.normalize();
        this.endRun(R);
        return;
      }
      const dir = _d.copy(k.vel).divideScalar(Math.max(sp, 1)).clone(), point = _s.clone();
      const b = R.lastB = s.b;
      // Вдали по-настоящему рушится первый дом налёта: издали видно, как он оседает, а кадр не тяжелеет
      if (!far || R.smash === 0) city.destroySeg(s, point, dir, Math.min(sp * 0.3, 140));
      R.smash++;
      // Вдоль ряда он почти не теряет ход: дом за домом
      k.vel.multiplyScalar(R.mode === 'line' ? 0.98 : 0.94);
      this.smash(k, point, dir, sp, b);
    }
  }

  // Пробил стену: пыль с обеих сторон, стекло, обломки. Вдали — только пыль и звук
  smash(k, point, dir, sp, building) {
    const I = this.inv, W = I.world, fx = I.fx, kk = clamp(sp / 620, 0.4, 1);
    const far = point.distanceTo(I.camera.position);
    const R = k.raid, now = I.time;
    if ((this.scene && !R.bg) || far < FAR) {
      W.dust.burst(_c.copy(point).addScaledVector(dir, -3), Math.round(8 + 8 * kk), { size: [4, 12], speed: 10 + 14 * kk, life: [1.2, 3], dir: dir.clone().multiplyScalar(-0.8), color: 0xa89f92 });
      W.dust.burst(_c.copy(point).addScaledVector(dir, 6), Math.round(12 + 12 * kk), { size: [5, 15], speed: 18 + 24 * kk, life: [1.4, 3.4], dir: dir.clone(), color: 0xa89f92 });
      W.effects.flash(point, 14 + 10 * kk);
      W.sparks.burst(point, 12, { size: [0.4, 1.2], speed: 30, life: [0.2, 0.6], color: 0xffd28a });
      W.debris.explode(point, 12, 24 + 14 * kk);
      // Края пробоины крошатся только в сцене: во время волны это лишняя работа на кадр
      if (this.scene) W.city.damageRadius(point, 6, 220, 50, dir);
      if (now - R.sndT > 0.22) {
        R.sndT = now;
        fx.play('smash', { gain: 0.55 + 0.35 * kk, pos: point }) || W.audio?.punch(1, 'concrete', point.clone());
        W.audio?.glass(0.4, point.clone());
      }
    } else {
      W.dust.burst(_c.copy(point).addScaledVector(dir, 6), 3, { size: [12, 26], speed: 10, life: [2, 4], dir: dir.clone(), color: 0x9a9184 });
      if (now - R.sndT > 0.5) { R.sndT = now; fx.play('farBlast', { gain: 0.45, pos: point }); }
    }
    // В сцене дым только в ключевых местах: столбов всего 12, лишние вытеснили бы их
    if (!this.scene && Math.random() < 0.15) fx.smokeAt(point.clone().setY(W.city.groundHeightAt(point.x, point.z, 400)), 0.7);
    this.scene?.onSmash?.(k, point, building);
  }

  // Пике в улицу: воронка, машины в воздух, люди бегут
  streetHit(k, R, gy) {
    const I = this.inv, W = I.world, fx = I.fx, sc = !!this.scene;
    const p = new THREE.Vector3(k.pos.x, gy, k.pos.z);
    if (sc || p.distanceTo(I.camera.position) < FAR) W.city.damageRadius(_c.copy(p).setY(gy + 4), sc ? 18 : 10, 260, 60);
    W.effects.crater(p, sc ? 16 : 12);
    W.effects.shockwave(p.clone().setY(gy + 0.6), { type: 'ring', radius: sc ? 110 : 70, life: 1.3, opacity: 0.85 });
    W.effects.shockwave(p.clone().setY(gy + 1), { type: 'sphere', radius: 18, life: 0.4, opacity: 0.4, color: 0xffc090 });
    W.dust.burst(_c.copy(p).setY(gy + 1), sc ? 70 : 46, { size: [6, 18], speed: 50, life: [1.6, 4], flat: true });
    W.debris.explode(p, 24, 50);
    W.effects.flash(p, 40);
    W.impact?.(p, sc ? 95 : 70, sc ? 75 : 55);
    W.people?.scareAround?.(p, 260);
    fx.play('slam', { gain: 0.9, pos: p }) || W.audio?.boom(0.8, p.clone());
    fx.smokeAt(p.clone(), 0.9);
    fx.launchFrags(p, 2);
    k.pos.y = gy + 2;
    const a = Math.random() * Math.PI * 2;
    R.dir.set(Math.cos(a), 0, Math.sin(a));
    k.vel.copy(R.dir).multiplyScalar(60).addScaledVector(UP, 80);
    this.endRun(R);
    this.scene?.onStreet?.(k, p);
  }

  // ---------------------------------------------------------------- цели
  // Секция дома в районе: по середине высоты, чтобы верх падал целым куском. tall — самая высокая из найденных
  pickSeg(center, r, minTop = 30, tall = false, skip = -1) {
    const city = this.inv.world.city, list = city.sphereQuery(_c.set(center.x, 40, center.z), r, this.hits);
    let best = null, bs = -1;
    for (let i = 0; i < 40 && list.length; i++) {
      const s = list[Math.floor(Math.random() * list.length)];
      const b = city.buildings[s.b];
      if (!s.alive || b.kind !== 'building' || b.index === skip) continue;
      const top = city.segs[b.segs[b.segs.length - 1]], topY = top.y0 + top.h;
      if (topY < minTop) continue;
      const score = tall ? topY : Math.random();
      if (score > bs) { bs = score; best = b; }
    }
    if (!best) return null;
    const segs = best.segs, last = segs.length - 1;
    let seg = null;
    for (let i = Math.round(last * (0.3 + 0.25 * Math.random())); i >= 0 && !seg; i--) if (city.segs[segs[i]].alive) seg = city.segs[segs[i]];
    if (!seg) return null;
    const top = city.segs[segs[last]];
    return { seg, b: best.index, p: new THREE.Vector3(seg.x, seg.y0 + seg.h * 0.5, seg.z), top: top.y0 + top.h };
  }

  // Прямая на низкой высоте сквозь как можно больше домов подряд: вдоль квартала или наискось.
  // roof — под самыми крышами: отваливаются верхние этажи, а не полдома (меньше обломков, легче кадру)
  pickLine(center, r, len = 520, tries = 8, roof = false) {
    const city = this.inv.world.city;
    let best = null, bn = 0;
    const seen = new Set();
    for (let i = 0; i < tries; i++) {
      const t = this.pickSeg(center, r, 25);
      if (!t) continue;
      const a = Math.random() < 0.7 ? Math.floor(Math.random() * 4) * Math.PI / 2 : Math.random() * Math.PI * 2;
      const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      const h = roof ? clamp(t.top - 9, 14, 70) : clamp(t.p.y, 14, 60);
      const mid = new THREE.Vector3(t.seg.x, h, t.seg.z);
      seen.clear();
      for (let u = -0.35 * len; u <= 0.65 * len; u += 6) {
        const s = city.segAt(_c.copy(mid).addScaledVector(dir, u));
        if (s) seen.add(s.b);
      }
      if (seen.size > bn) {
        bn = seen.size;
        best = { dir, mid, h, n: bn, start: mid.clone().addScaledVector(dir, -0.35 * len), end: mid.clone().addScaledVector(dir, 0.65 * len) };
      }
    }
    return best;
  }

  // Улица, которую таран пересекает над головами: промежуток между домами на линии
  findGap(L) {
    const city = this.inv.world.city, len = L.start.distanceTo(L.end);
    let inside = false, out = -1, best = null, bd = Infinity;
    for (let u = 0; u <= len; u += 3) {
      const now = !!city.segAt(_c.copy(L.start).addScaledVector(L.dir, u));
      if (inside && !now) out = u;
      if (!inside && now && out >= 0) {
        const w = u - out;
        // Ближе к середине ряда: до неё он уже пробил несколько домов
        const d = Math.abs((out + u) / 2 - len * 0.45);
        if (w > 10 && w < 45 && d < bd) { bd = d; best = L.start.clone().addScaledVector(L.dir, (out + u) / 2); }
      }
      inside = now;
    }
    if (best) best.y = Math.max(0, groundHeight(best.x, best.z));
    return best;
  }

  // Точка на улице: не в доме и не в реке
  streetPoint(c, r) {
    const city = this.inv.world.city;
    for (let i = 0; i < 16; i++) {
      const x = c.x + (Math.random() - 0.5) * 2 * r, z = c.z + (Math.random() - 0.5) * 2 * r;
      if (inRiver(x, z)) continue;
      const gy = Math.max(0, groundHeight(x, z));
      if (city.segAt(_c.set(x, gy + 2, z), 6)) continue;
      return new THREE.Vector3(x, gy, z);
    }
    return null;
  }

  // Район для группы: 700–1600 м от героя, где есть что ломать, и подальше от других групп
  pickDistrict(avoid = []) {
    const I = this.inv, city = I.world.city, hero = I.heroC;
    let best = null, bs = -Infinity, top = 0;
    for (let i = 0; i < 20; i++) {
      const a = Math.random() * Math.PI * 2, r = 700 + Math.random() * 900;
      const x = hero.x + Math.cos(a) * r, z = hero.z + Math.sin(a) * r;
      if (Math.hypot(x, z) > 2000 || inRiver(x, z)) continue;
      if (avoid.some((c) => Math.hypot(x - c.x, z - c.z) < 550)) continue;
      let n = 0, hi = 0;
      for (const s of city.sphereQuery(_c.set(x, 40, z), DISTRICT_R, this.hits)) {
        const t = s.y0 + s.h;
        if (t > 30) n++;
        if (t > hi) hi = t;
      }
      const score = n - Math.hypot(x, z) * 0.02;
      if (score > bs) { bs = score; best = new THREE.Vector3(x, 0, z); top = hi; }
    }
    if (!best) best = new THREE.Vector3(hero.x * 0.3 + (Math.random() - 0.5) * 600, 0, hero.z * 0.3 + (Math.random() - 0.5) * 600);
    best.y = Math.max(CRUISE, top + 35);
    return best;
  }

  // Куда поставить камеру, чтобы точку было видно: на земле или на крыше, без домов между
  findView(target, r0, r1, roof) {
    const city = this.inv.world.city;
    let best = null, bc = Infinity;
    const a0 = Math.random() * Math.PI * 2;
    for (let i = 0; i < 16; i++) {
      const a = a0 + i * 0.785 + (i >= 8 ? 0.39 : 0), r = i >= 8 ? r1 : r0;
      const x = target.x + Math.cos(a) * r, z = target.z + Math.sin(a) * r;
      if (inRiver(x, z)) continue;
      const gy = roof ? city.groundHeightAt(x, z, 1e4) : Math.max(0, groundHeight(x, z));
      const p = new THREE.Vector3(x, gy + (roof ? 2.5 : 1.7), z);
      if (city.segAt(p, 1.5)) continue;
      let block = 0;
      for (let u = 0.06; u < 0.85; u += 0.06) if (city.segAt(_c.lerpVectors(p, target, u))) block++;
      if (block < bc) { bc = block; best = p; if (!block) break; }
    }
    return best || new THREE.Vector3(target.x + r1, Math.max(0, groundHeight(target.x + r1, target.z)) + 60, target.z);
  }

  // ---------------------------------------------------------------- группы во время волны
  // Бой начался: второй отряд громит город, даже если сцены не было (ударил первым, промолчал)
  deploy() {
    if (this.groups.length) return;
    for (const k of this.list) {
      if (k.state !== 'gone' && k.raid) continue;
      k.raid = this.newRaid('idle');
      k.state = 'raid';
    }
    this.spread();
  }

  // Группы по три, каждая в своём районе
  spread() {
    const I = this.inv, from = I.ship.bellyPos(new THREE.Vector3()), taken = [];
    this.groups = [];
    for (let i = 0; i < this.list.length; i += PER) {
      const c = this.pickDistrict(taken);
      taken.push(c);
      this.groups.push({ c, members: this.list.slice(i, i + PER), cd: 1 + i * 0.4 });
    }
    for (const g of this.groups) {
      for (const k of g.members) {
        if (!k.alive || k.state !== 'raid') continue;
        if (k.raid.mode === 'idle') this.launch(k, _r.copy(from).add(_e.set((Math.random() - 0.5) * 20, 0, (Math.random() - 0.5) * 20)), _d.subVectors(g.c, from).setY(0).normalize());
        this.sendTo(k, g);
      }
    }
  }

  sendTo(k, g) {
    const R = k.raid;
    R.group = g;
    if (R.mode === 'run' || R.mode === 'line' || R.mode === 'dive') return;
    R.mode = 'go';
    R.speed = 320;
    R.to.set(g.c.x + Math.cos(R.ang) * R.rad, g.c.y + R.dy, g.c.z + Math.sin(R.ang) * R.rad);
  }

  groupsTick(dt) {
    const hero = this.inv.heroC;
    for (const g of this.groups) {
      let near = false, any = false;
      for (const k of g.members) {
        if (k.state !== 'raid') continue;
        any = true;
        if (k.c.distanceTo(hero) < ENGAGE) near = true;
      }
      if (!any) continue;
      // Герой прилетел к ним: вся группа бросает город и идёт на него
      if (near) {
        for (const k of g.members) if (k.state === 'raid') k.engage();
        continue;
      }
      g.cd -= dt;
      if (g.cd > 0) continue;
      g.cd = GAP[0] + Math.random() * GAP[1];
      let free = null, n = 0;
      for (const k of g.members) if (k.state === 'raid' && k.raid.mode === 'cruise' && Math.random() * ++n < 1) free = k;
      if (!free) { g.cd = 0.5; continue; }
      const r = Math.random();
      if (r < 0.15) {
        const at = this.streetPoint(g.c, DISTRICT_R);
        if (at) { this.startDive(free, at); continue; }
      }
      if (r < 0.9) {
        const L = this.pickLine(g.c, DISTRICT_R, 520, 8, true);
        if (L) { this.startLine(free, L, 320 + Math.random() * 100); continue; }
      }
      const t = this.pickSeg(g.c, DISTRICT_R, 25);
      if (t) { this.startRun(free, t, 300 + Math.random() * 160); continue; }
      // Ломать здесь больше нечего: группа уходит в другой район
      g.c = this.pickDistrict(this.groups.filter((o) => o !== g).map((o) => o.c));
      for (const k of g.members) if (k.state === 'raid') this.sendTo(k, g);
    }
  }

  // ---------------------------------------------------------------- сцена
  begin() {
    const I = this.inv, P = I.player, X = I.xarg;
    I.setStage('raid');
    I.setCine(true);
    I.camRig.shot = this.shot;
    P.driven = I.holdHero;
    P.punchT = -1; P.charge = 0; P.slamming = false; P.lasering = false; P.dashT = 0;
    X.vel.set(0, 0, 0);
    X.go('stand');
    const toX = _d.subVectors(X.pos, P.pos).setY(0);
    if (toX.lengthSq() < 1) toX.copy(X.facing).negate();
    P.lockDir = toX.normalize().clone();
    // Город впереди строя: генерал стоит спиной к парку, лицом к центру
    const dirC = new THREE.Vector3(-X.pos.x, 0, -X.pos.z).normalize();
    const center = new THREE.Vector3(0, 0, 0);
    const S = this.scene = {
      t: 0, lock: 0.5, cut: -1, placed: false, done: new Set(), dirC, center,
      v: dirC.clone(), rowOn: false, rowHit: false, crossed: false, towerHit: false, streetHit: false, ashT: 0,
      onSmash: (k, p, b) => this.sceneSmash(k, p, b),
      onStreet: (k, p) => this.sceneStreet(k, p),
    };
    S.from = I.ship.bellyPos(new THREE.Vector3());
    // Ряд домов, который первый проходит насквозь; камера идёт рядом над крышами
    S.row = this.pickLine(_e.copy(X.pos).lerp(center, 0.5), 260, 560, 14, true) || this.pickLine(center, 400, 560, 14, true);
    this.rowCamera(S);
    // Улица под тараном: люди внизу, он проходит над ними из дома в дом
    for (let i = 0; i < 4 && !S.gap; i++) {
      S.cross = this.pickLine(_e.copy(X.pos).lerp(center, 0.72), 260, 420, 10);
      S.gap = S.cross && this.findGap(S.cross);
    }
    if (!S.gap) { S.cross = S.row; S.gap = this.findGap(S.row) || S.row.mid.clone().setY(0); }
    this.gapCamera(S);
    S.tower = this.pickSeg(center, 340, 110, true) || this.pickSeg(center, 500, 50, true) || this.pickSeg(center, 600, 30);
    S.next = this.pickSeg(S.tower.p, 150, 45, false, S.tower.b) || S.tower;
    S.third = this.pickSeg(S.tower.p, 200, 35, false, S.tower.b) || S.next;
    S.street = this.streetPoint(_e.copy(X.pos).lerp(center, 0.75), 180) || this.streetPoint(center, 300) || S.tower.p.clone().setY(0);
    S.wideCam = this.findView(S.tower.p, 150, 230, true);
    S.wideCam.y += 6;
    S.streetCam = this.findView(_e.copy(S.street).setY(S.street.y + 6), 55, 80, false);
    // Башня проходит поперёк кадра: заход сбоку от взгляда камеры
    _r.subVectors(S.tower.p, S.wideCam).setY(0).normalize();
    const side = new THREE.Vector3().crossVectors(_r, UP).normalize();
    S.stage = [];
    S.stage[1] = S.cross.start.clone().addScaledVector(S.cross.dir, -120).setY(S.cross.h + 90);
    S.stage[2] = S.tower.p.clone().addScaledVector(side, 260).setY(S.tower.p.y + 40);
    S.stage[3] = S.next.p.clone().addScaledVector(side, -260).setY(S.next.p.y + 50);
    S.stage[4] = S.third.p.clone().addScaledVector(_r, 200).setY(Math.max(CRUISE, S.tower.top + 60));
    // Остальные ждут над центром: на общем плане они расходятся крест-накрест
    for (let i = 5; i <= 10; i++) {
      const a = Math.atan2(dirC.z, dirC.x) + Math.PI + (i - 5) * Math.PI / 3;
      S.stage[i] = new THREE.Vector3(Math.cos(a) * 520, 280 + (i % 3) * 40, Math.sin(a) * 520);
    }
    // Ждут не внутри домов
    for (let i = 2; i <= 4; i++) for (let n = 0; n < 20 && this.inv.world.city.segAt(S.stage[i], 6); n++) S.stage[i].y += 20;
    S.stage[11] = S.street.clone().addScaledVector(dirC, -120).setY(S.street.y + 300);
    for (const k of this.list) { k.raid = this.newRaid('idle'); k.root.visible = false; k.state = 'raid'; k.trail.clear(); }
  }

  // Камера ряда идёт параллельно, над крышами, со стороны пониже
  rowCamera(S) {
    const city = this.inv.world.city, L = S.row;
    const side = new THREE.Vector3().crossVectors(L.dir, UP).normalize();
    let bestY = Infinity, bestSide = side;
    for (const sg of [1, -1]) {
      let hi = 0;
      for (let u = -40; u <= L.start.distanceTo(L.end); u += 20) {
        _c.copy(L.start).addScaledVector(L.dir, u).addScaledVector(side, 55 * sg);
        hi = Math.max(hi, city.groundHeightAt(_c.x, _c.z, 1e4));
      }
      if (hi < bestY) { bestY = hi; bestSide = side.clone().multiplyScalar(sg); }
    }
    S.rowSide = bestSide;
    S.rowY = Math.max(bestY + 14, L.h + 30);
  }

  // Камера на улице: в 45 м вдоль улицы от места, где он пройдёт над головами
  gapCamera(S) {
    const city = this.inv.world.city, G = S.gap;
    const along = new THREE.Vector3().crossVectors(S.cross.dir, UP).normalize();
    S.gapCam = null;
    for (const sg of [1, -1, 0.6, -0.6]) {
      const p = G.clone().addScaledVector(along, 45 * sg);
      p.y = Math.max(0, groundHeight(p.x, p.z)) + 1.5;
      if (!city.segAt(p, 2) && !inRiver(p.x, p.z)) { S.gapCam = p; S.gapAlong = along.clone().multiplyScalar(Math.sign(sg)); break; }
    }
    if (!S.gapCam) { S.gapCam = this.findView(_e.copy(G).setY(G.y + 20), 45, 70, false); S.gapAlong = _r.subVectors(S.gapCam, G).setY(0).normalize().clone(); }
  }

  // Удары сцены: каждый по-своему тяжёлый. Камера не трясётся — только объектив, время и звук
  sceneSmash(k, p, b) {
    const I = this.inv, S = this.scene, gy = I.world.city.groundHeightAt(p.x, p.z, 400);
    if (k === this.list[0] && S.rowOn && !S.rowHit) {
      // Первый дом ряда: время вязнет, и видно, как он идёт сквозь стену за стеной
      S.rowHit = true;
      I.player.hitstop = Math.max(I.player.hitstop, 0.08);
      I.slowFor(0.35, 1.4);
      I.fx.crashZoom(6, 0.2);
      I.fx.smokeAt(_c.set(p.x, gy, p.z).clone(), 1.4);
    }
    if (k === this.list[1] && !S.crossed && _d.subVectors(p, S.gap).dot(S.cross.dir) > 0) {
      // Прошёл над улицей: сверху сыплется дом, внизу люди
      S.crossed = true;
      this.debrisRain(p);
      I.slowFor(0.4, 1.3);
      I.fx.crashZoom(5, 0.3);
    }
    if (b === S.tower.b && !S.towerHit) {
      S.towerHit = true;
      I.slowFor(0.3, 2.6);
      I.fx.crashZoom(5, 0.5);
      I.fx.play('towerFall', { pos: p });
      I.fx.play('bigBoom', { gain: 0.6, pos: p });
      I.fx.smokeAt(_c.set(p.x, gy, p.z).clone(), 1.6);
      this.muffle(true);
      I.fx.after(2.4, () => { if (this.scene && this.scene.t < CUT.hero) this.muffle(false); });
      I.world.audio?.tone({ dur: 4, from: 70, to: 42, gain: 0.22 });
    }
  }

  // Над улицей: обломки и стекло сыплются вниз, машины опрокидывает
  debrisRain(p) {
    const I = this.inv, W = I.world, G = this.scene.gap;
    W.debris.explode(p, 36, 26);
    W.dust.burst(p, 30, { size: [6, 16], speed: 22, life: [2, 4.5], color: 0xa89f92 });
    for (const s of W.city.sphereQuery(p, 45, this.hits)) W.city.shatterWindows(s, p, this.scene.cross.dir);
    W.impact?.(G, 40, 40);
    W.people?.scareAround?.(G, 160);
    I.fx.play('bigBoom', { gain: 0.6, pos: p });
  }

  sceneStreet(k, p) {
    const I = this.inv, S = this.scene;
    if (S.streetHit) return;
    S.streetHit = true;
    I.player.hitstop = Math.max(I.player.hitstop, 0.12);
    I.slowFor(0.35, 1.1);
    I.fx.crashZoom(10, 0.3);
    I.fx.play('bigBoom', { gain: 0.8, pos: p });
  }

  // Взрыв над кварталом: огонь, шлейф дыма, горящие обломки. Слышен издали
  blast(p) {
    const I = this.inv, W = I.world, fx = I.fx;
    const at = p.clone();
    W.fire.explosion(at, 2.4);
    W.dust.burst(at, 12, { size: [22, 56], speed: 26, life: [6, 12], color: 0x3a342e, rise: 9, alpha: 0.45, plume: true });
    W.effects.flash(at, 60);
    fx.launchFrags(at, 3);
    fx.play('farBlast', { pos: at, gain: 0.9 }) || W.audio?.boom(0.7, at.clone());
    fx.smokeAt(at.clone().setY(W.city.groundHeightAt(at.x, at.z, 400)), 1.4);
  }

  // Люди на улице бегут от места, где он сейчас пройдёт
  crowd() {
    const W = this.inv.world, S = this.scene;
    for (let i = 0; i < 16; i++) {
      const p = S.gap.clone().addScaledVector(S.gapAlong, 6 + Math.random() * 26).add(_c.set((Math.random() - 0.5) * 10, 0, (Math.random() - 0.5) * 10));
      if (W.city.segAt(_e.copy(p).setY(p.y + 1))) continue;
      W.people?.spawnAt?.(p, S.gap);
    }
    W.people?.scareAround?.(S.gap, 160);
  }

  // Что и когда делает отряд в сцене (с)
  cue(t) {
    const S = this.scene, L = this.list, I = this.inv;
    const at = (id, time, fn) => { if (t >= time && !S.done.has(id)) { S.done.add(id); fn(); } };
    const out = (i, to) => {
      const k = L[i];
      this.launch(k, _e.copy(S.from).addScaledVector(S.dirC, (i % 4) * 3).add(_r.set((i % 2 ? 1 : -1) * (4 + i), -i * 1.5, 0)), S.dirC);
      k.raid.mode = 'go';
      k.raid.to.copy(to);
      k.raid.speed = 360;
      k.raid.next = 'hold';
      if (i % 3 === 0) I.fx.play('rush', { gain: 0.6, pos: k.c });
    };
    const loose = (r) => {
      for (const k of L) {
        if (k.raid.mode !== 'hold') continue;
        const line = this.pickLine(S.center, r, 520, 5, true);
        // Фон: следы над городом, дома вдали без настоящих обвалов
        if (line) { this.startLine(k, line, 380, 6); k.raid.bg = true; }
      }
    };
    at('say', 0.3, () => I.say('Сначала город. Пусть видит, от чего он отказался.', 3.2, true));
    at('boom', 0.5, () => { I.fx.play('sonicBoom', { gain: 0.6 }); I.world.audio?.boom(0.5); });
    // Первый — сразу на ряд домов: за ним идёт камера второго плана
    at('r0', 0.4, () => {
      this.launch(L[0], S.from, S.dirC);
      const d = L[0].pos.distanceTo(S.row.start);
      this.startLine(L[0], S.row, 150, 12);
      // Заход быстрее: в ряд он входит к третьей секунде
      L[0].raid.speed = clamp(d / 2.6, 300, 600);
    });
    for (let i = 1; i < L.length; i++) at(`r${i}`, 0.4 + i * 0.2, () => out(i, S.stage[i]));
    at('radio1', 3.8, () => I.story.radio('ШТАБ: Цели над центром! Они идут сквозь здания!', 4));
    at('crowd', 7.9, () => this.crowd());
    at('r1go', 8.4, () => this.startLine(L[1], S.cross, 300, 8));
    at('radio2', 9.2, () => I.story.radio('ШТАБ: …люди на улицах, они не успевают уйти…', 3.8));
    at('r2run', 12.6, () => this.startRun(L[2], S.tower, 420, 160, 8));
    at('r3run', 13.5, () => this.startRun(L[3], S.next, 420, 140, 6));
    at('r4run', 14.3, () => this.startRun(L[4], S.third, 460, 120, 6));
    at('radio3', 14.4, () => I.story.radio('ШТАБ: Рухнула башня в центре. Там шёл рабочий день.', 4));
    // Общий план: все расходятся крест-накрест через центр
    for (let i = 5; i <= 10; i++) {
      at(`x${i}`, 16.9 + (i - 5) * 0.55, () => {
        const line = this.pickLine(S.center, 480, 600, 6, true);
        if (line) this.startLine(L[i], line, 380, 5);
      });
    }
    at('loose1', 17.4, () => loose(600));
    at('say2', 18.6, () => I.say('Так падал каждый мир, который сказал нам «нет».', 3.4, true));
    at('radio4', 19.6, () => I.story.radio('ОРБИТАЛЬНЫЙ МОНИТОРИНГ: Очаги по всему центру. Счёт идёт на кварталы.', 4));
    at('blast1', 18.2, () => this.blast(_e.copy(S.tower.p).setY(Math.min(S.tower.top * 0.5, 200))));
    at('blast2', 19.5, () => this.blast(_e.copy(S.row.mid).setY(S.row.h + 30)));
    at('blast3', 20.7, () => this.blast(_e.copy(S.next.p).setY(S.next.p.y + 20)));
    // Он уже над перекрёстком (камера смотрит снизу и до этого его не видит) и идёт отвесно вниз
    at('r11dive', 22.1, () => {
      L[11].pos.copy(S.street).addScaledVector(S.dirC, -40).setY(S.street.y + 340);
      L[11].trail.clear();
      this.startDive(L[11], S.street, 430);
    });
    // Герой смотрит на город: всё вязнет и глохнет, в ушах звенит, радио обрывается
    at('hero', CUT.hero, () => {
      I.slowFor(0.6, CUT.face - CUT.hero + 0.6);
      this.muffle(true);
      const A = I.world.audio;
      A?.tone({ dur: 4.5, from: 3900, to: 3700, gain: 0.025 });
      A?.tone({ dur: 5, from: 55, to: 40, gain: 0.25 });
      loose(700);
    });
    at('radio5', CUT.hero + 0.2, () => I.story.radio('ШТАБ: Центр… мы потеряли центр. Там были люди, там…', 3));
    at('say3', CUT.hero + 0.6, () => I.say('Вот твой ответ. Посмотри на него.', 3, true));
    // Взрывы и дым там, куда он смотрит: над крышами, чтобы их не закрыли ближние дома
    const ahead = (dist, side, y) => {
      _d.subVectors(S.tower.p, I.player.pos).setY(0).normalize();
      _r.crossVectors(_d, UP).normalize();
      return _e.copy(I.player.pos).addScaledVector(_d, dist).addScaledVector(_r, side).setY(y);
    };
    // Дым заранее: к этому плану столбы уже стоят над городом
    at('smoke', CUT.aerial + 2, () => {
      for (const [dist, side] of [[520, -160], [700, 60], [600, 260], [860, -40]]) {
        const p = ahead(dist, side, 0);
        I.fx.smokeAt(p.setY(I.world.city.groundHeightAt(p.x, p.z, 400)).clone(), 1.6);
      }
    });
    at('blast4', CUT.hero + 0.5, () => this.blast(ahead(620, -120, 170)));
    at('blast5', CUT.hero + 1.5, () => this.blast(ahead(780, 180, 220)));
    at('blast6', CUT.hero + 2.4, () => this.blast(ahead(560, 40, 150)));
    // Он поворачивается — звук возвращается: дальше бой
    at('unmuffle', CUT.face + 1.6, () => { this.muffle(false); I.world.audio?.boom(0.6); });
  }

  sceneFrame(dt, realDt, input) {
    const S = this.scene;
    if (!S) return;
    const I = this.inv, P = I.player, X = I.xarg, L = this.list;
    S.t += dt;
    S.lock -= realDt;
    // ЛКМ пропускает сцену, как спуск корабля
    if (input.punch && S.lock <= 0) { input.punch = false; this.finish(); return; }
    this.cue(S.t);
    if (S.t >= CUT.end) { this.finish(); return; }
    const t = S.t;
    const cut = t < CUT.row ? 0 : t < CUT.street ? 1 : t < CUT.tower ? 2 : t < CUT.aerial ? 3 : t < CUT.dive ? 4 : t < CUT.hero ? 5 : t < CUT.face ? 6 : 7;
    if (cut !== S.cut) { S.cut = cut; S.placed = false; }
    const head = _c.copy(P.pos).addScaledVector(UP, 1.62);
    let fov = 60, rate = 5;
    const pos = _s, look = _e;
    if (cut === 0) {
      // Снизу вверх: сначала люк корабля — отряд срывается из брюха; потом наклон вниз — генерал и город
      _r.crossVectors(S.dirC, UP).normalize();
      pos.copy(X.pos).addScaledVector(S.dirC, -3.8).addScaledVector(_r, 1.1);
      pos.y = X.pos.y + 0.6;
      const e = lerp(1.05, 0.5, smoothstep(1.2, 2.7, t));
      look.copy(pos).addScaledVector(S.dirC, Math.cos(e) * 100).addScaledVector(UP, Math.sin(e) * 100);
      fov = 76;
    } else if (cut === 1) {
      const k = L[0], R = k.raid;
      if (!S.rowOn && R.mode === 'line' && R.phase === 1) { S.rowOn = true; S.placed = false; }
      if (S.rowOn) {
        // Сбоку и сверху, вровень с ним: видно каждый дом, который он проходит
        const u = _d.subVectors(k.pos, S.row.start).dot(S.row.dir);
        pos.copy(S.row.start).addScaledVector(S.row.dir, u - 28).addScaledVector(S.rowSide, 55);
        pos.y = S.rowY;
        look.copy(k.c).addScaledVector(S.row.dir, 12);
        fov = 56;
        rate = 5;
      } else {
        // За ним, пока он идёт вниз к ряду
        _d.copy(k.vel);
        if (_d.lengthSq() > 100) S.v.lerp(_d.normalize(), 1 - Math.exp(-4 * realDt)).normalize();
        _r.crossVectors(S.v, UP);
        if (_r.lengthSq() < 1e-3) _r.set(1, 0, 0);
        _r.normalize();
        pos.copy(k.c).addScaledVector(S.v, -15).addScaledVector(UP, 3).addScaledVector(_r, 2);
        look.copy(k.c).addScaledVector(S.v, 35);
        fov = 66;
        rate = 0;
      }
    } else if (cut === 2) {
      // Улица: люди бегут на камеру, он проходит над ними из дома в дом, сверху сыплются обломки
      pos.copy(S.gapCam);
      const k = L[1], over = S.crossed ? 1 : 0;
      look.copy(S.gap).addScaledVector(UP, S.cross.h * 0.75);
      if (!S.crossed && k.raid.mode === 'line' && k.raid.phase === 1) look.lerp(k.c, 0.35);
      if (over) look.lerp(_d.copy(S.gap).addScaledVector(UP, 6), smoothstep(0, 1, S.fallK = Math.min(1, (S.fallK || 0) + realDt * 0.5)));
      fov = 64;
      rate = 3;
    } else if (cut === 3) {
      // С крыши напротив: башня, через неё проходят трое, верх падает
      pos.copy(S.wideCam);
      look.set(S.tower.p.x, lerp(S.tower.p.y + 10, S.tower.p.y - 4, smoothstep(CUT.tower, CUT.aerial, t)), S.tower.p.z);
      fov = lerp(54, 46, smoothstep(CUT.tower, CUT.aerial, t));
      rate = 2;
    } else if (cut === 4) {
      // Высоко над центром: следы крест-накрест, падают дома, растут столбы дыма
      const a = Math.atan2(S.dirC.z, S.dirC.x) + Math.PI + (t - CUT.aerial) * 0.05;
      pos.set(S.center.x + Math.cos(a) * 560, 620, S.center.z + Math.sin(a) * 560);
      look.copy(S.center).setY(40);
      fov = 52;
      rate = 2;
    } else if (cut === 5) {
      // На улице: он идёт сверху прямо в перекрёсток
      pos.copy(S.streetCam);
      const k = smoothstep(CUT.dive + 0.3, 22.6, t);
      look.copy(S.street).addScaledVector(UP, lerp(160, 5, k));
      if (!S.streetHit && L[11].root.visible && t > 22) look.lerp(L[11].c, 0.5);
      fov = 60;
      rate = 6;
    } else if (cut === 6) {
      // Через плечо героя: город горит, падает пепел
      _d.subVectors(S.tower.p, P.pos).setY(0).normalize();
      P.lockDir = _d.clone();
      _r.crossVectors(_d, UP).normalize();
      pos.copy(head).addScaledVector(_d, -2.4).addScaledVector(_r, 0.8).addScaledVector(UP, 0.35);
      look.copy(head).addScaledVector(_d, 120).addScaledVector(UP, 30);
      fov = 50;
      rate = 3;
      this.ash(realDt, head);
    } else {
      // Лицо героя: он медленно поворачивается к генералу
      _d.subVectors(X.pos, P.pos).setY(0).normalize();
      P.lockDir = _d.clone();
      _r.crossVectors(_d, UP).normalize();
      pos.copy(head).addScaledVector(_d, 1.7).addScaledVector(_r, 0.55).addScaledVector(UP, -0.05);
      look.copy(head).addScaledVector(UP, 0.02);
      fov = 40;
      rate = 4;
      this.ash(realDt, head);
    }
    const gy = Math.max(0, groundHeight(pos.x, pos.z)) + 1;
    if (pos.y < gy) pos.y = gy;
    this.place(pos, look, fov - I.fx.zoom, rate, realDt);
  }

  // Пепел вокруг героя: медленно падает сверху
  ash(realDt, head) {
    const S = this.scene;
    S.ashT -= realDt;
    if (S.ashT > 0) return;
    S.ashT = 0.12;
    _r.set(head.x + (Math.random() - 0.5) * 14, head.y + 4 + Math.random() * 6, head.z + (Math.random() - 0.5) * 14);
    this.inv.world.dust.burst(_r, 4, { size: [0.15, 0.4], speed: 0.6, life: [4, 7], color: 0x8a847c, alpha: 0.8 });
  }

  // Смена плана — сразу на место; внутри плана камера плавно ведёт
  place(pos, look, fov, rate, dt) {
    const S = this.shot, sc = this.scene;
    if (!sc.placed || rate <= 0) {
      S.pos.copy(pos); S.look.copy(look); S.fov = fov;
      sc.placed = true;
      return;
    }
    const k = 1 - Math.exp(-rate * dt);
    S.pos.lerp(pos, k);
    S.look.lerp(look, k);
    S.fov += (fov - S.fov) * k;
  }

  // Конец сцены (досмотрел или пропустил): начинается бой
  finish() {
    this.endScene();
    this.inv.startFight();
  }

  endScene() {
    const I = this.inv, P = I.player;
    if (!this.scene) return;
    this.scene = null;
    this.muffle(false);
    I.timeScale = 1;
    I.slowT = 0;
    if (I.camRig.shot === this.shot) I.camRig.shot = null;
    I.setCine(false);
    if (P.driven === I.holdHero) P.driven = null;
    P.lockDir = null;
  }
}
