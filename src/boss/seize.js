import * as THREE from 'three';
import { blowQuat, reelHit, whirlPose } from '../player/model.js';
import { clamp } from '../utils.js';

// Захват на R, как с предметами, только одной рукой за шею. Подлетать самому не надо: дальность та же, что у серии ударов.
// Рука на горле, и дальше управление у игрока: герой несёт цель куда хочет, дома ломаются об неё.
// R отпускает, ЛКМ или B швыряет туда, куда смотрит камера, F раскручивает на вытянутой руке и швыряет.
// F издалека сразу идёт в раскрутку. Сам генерал из хватки не вырывается.
// Он может успеть встретить руку: тогда столкновение, и он сразу отвечает.

const COOLDOWN = 3;     // с: столько нельзя снова хватать генерала, пока он не открылся сам
const NECK = 0.56;      // м: от центра тела до шеи
const THROAT = 0.2;     // м: от оси тела до горла
const DRAG_SPEED = 60;  // м/с: с такой скорости цель в руке ломает дома
const SHOT = 8;         // м: кадр раскрутки сбоку, обе фигуры целиком
const CLOSED = ['wait', 'descend', 'stand', 'watch', 'approach', 'scene', 'meteor', 'beamlock', 'cut', 'brawl', 'climb', 'carry', 'tackle', 'dead', 'seized', 'held'];

const UP = new THREE.Vector3(0, 1, 0);
const _d = new THREE.Vector3(), _s = new THREE.Vector3(), _v = new THREE.Vector3(), _cp = new THREE.Vector3();
const _p0 = new THREE.Vector3(), _r = new THREE.Vector3(), _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
const _q = new THREE.Quaternion(), _m = new THREE.Matrix4();

export class Seize {
  constructor(inv) {
    this.inv = inv;
    this.hits = [];
    this.throwDir = new THREE.Vector3(0, 0, 1);
    this.holdVel = new THREE.Vector3();
    this.holdPrev = new THREE.Vector3();
    this.camS = new THREE.Vector3(1, 0, 0);
    this.shot = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 50 };
    this.driven = () => this.tick();
    this.reset();
  }

  reset() {
    const P = this.inv.player;
    if (P.driven === this.driven) P.driven = null;
    if (this.kin) this.kin.anim.choke = 0;
    P.gripping = false;
    this.kin = null;
    this.state = null;
    this.whirlNow = false;
    this.readyAt = 0;
    this.watch = null;
    this.watchT = 0;
    this.clearShot();
  }

  // Цель уже в руке, и герой летает сам
  get holding() { return this.state === 'hold'; }

  // Нажата R. Цель в поле зрения; смотрит мимо и рядом есть что взять — обычный захват (машина, обломок).
  // whirl (нажата F): сразу в раскрутку
  tryStart(whirl = false) {
    const I = this.inv, P = I.player;
    if (this.kin || P.held || P.driven || P.captured || P.knockT > 0 || P.charge > 0 || I.story.lock) return false;
    const far = I.chain.far, t = I.findTarget(far) || (P.canGrab() ? null : I.nearestTarget(far));
    if (!t || CLOSED.includes(t.state)) return false;
    const d = t.c.distanceTo(I.heroC);
    if (t.kind === 'general' && !t.open && I.time < this.readyAt) return false;
    if (I.chain.kin) I.chain.end(true);
    this.kin = t;
    this.state = 'rush';
    this.whirlNow = whirl;
    this.left = clamp(d / 700, 0.18, 0.5);
    this.all = this.left;
    P.driven = this.driven;
    P.punchT = -1;
    P.punchHit = true;
    P.dashT = 0;
    P.slamming = false;
    P.falling = false;
    P.grounded = false;
    P.lasering = false;
    P.boosting = true;
    P.blow = { side: 'R', f: 0, k: 0, pitch: 0, kind: 'straight' };
    P.poseQ = P.quat.clone();
    I.timeScale = 0.45;
    _d.subVectors(t.c, I.heroC).normalize();
    I.fx.chainRush(I.heroC, _d);
    return true;
  }

  // Функция движения героя (player.driven). Время настоящее: замедление на длину сцены не влияет
  tick() {
    const I = this.inv, rdt = I.realDt;
    if (!this.kin) { I.player.driven = null; return; }
    this.left -= rdt;
    if (this.state === 'rush') this.rush(rdt);
    else this.spin(rdt);
  }

  rush(rdt) {
    const I = this.inv, P = I.player, kin = this.kin, b = P.blow;
    _s.copy(P.pos).addScaledVector(UP, 1);
    _d.subVectors(kin.c, _s);
    const dist = _d.length(), gap = 1.9;
    _d.divideScalar(dist || 1);
    const speed = Math.max(0, dist - gap) / Math.max(this.left, 0.02);
    _p0.copy(P.pos);
    P.pos.addScaledVector(_d, Math.min(speed * rdt, Math.max(0, dist - gap)));
    P.vel.copy(_d).multiplyScalar(Math.max(speed, 90));
    if (Math.min(_p0.y, P.pos.y) < 700) I.chain.ram(_p0, P.pos, speed);
    I.chain.keepAbove(P);
    P.lockDir = (P.lockDir || new THREE.Vector3()).copy(_d);
    b.k = Math.min(1, b.k + rdt / 0.08);
    b.f = Math.min(1.99, 1.99 * (1 - this.left / this.all));
    P.poseQ.slerp(blowQuat(_q, _d, 0.3), 1 - Math.exp(-14 * rdt));
    if (this.left <= 0 || dist <= gap + 0.2) this.grasp();
  }

  // Рука дошла. Генерал, если не открыт, может успеть встретить
  grasp() {
    const I = this.inv, P = I.player, kin = this.kin;
    if (kin.kind === 'general' && !kin.open && Math.random() < 0.2 + 0.12 * kin.phase) {
      this.finish();
      P.blow = null;
      P.poseQ = null;
      I.clash(kin, true);
      return;
    }
    if (kin.kind === 'general') {
      kin.chainEnd();
      kin.releaseHero();
      kin.lasering = false;
      kin.charge = 0;
      kin.guardK = 0;
      kin.go('seized');
      kin.blow = null;
    } else {
      kin.state = 'held';
      kin.lasering = false;
    }
    kin.poseQ = kin.quat.clone();
    kin.vel.set(0, 0, 0);
    kin.knock = 0.5;
    kin.grounded = false;
    kin.reel.ext = false;
    reelHit(kin.reel, 1, 1);
    _d.subVectors(kin.c, I.heroC).normalize();
    I.fx.hit(_v.lerpVectors(I.heroC, kin.c, 0.6).clone(), _d.clone(), 0.85);
    // Рука на горле: стоп-кадр, объектив наезжает, дальше кадр идёт как в кино
    P.hitstop = Math.max(P.hitstop, 0.12);
    I.fx.crashZoom(9, 0.2);
    if (this.whirlNow) {
      I.fx.cineFor(2.6);
      this.startSpin();
    } else this.startHold();
  }

  // Управление возвращается к игроку, рука остаётся на шее
  startHold() {
    const I = this.inv, P = I.player, kin = this.kin;
    this.state = 'hold';
    if (P.driven === this.driven) P.driven = null;
    P.blow = null;
    P.poseQ = null;
    P.lockDir = null;
    P.boosting = false;
    P.gripping = true;
    P.vel.multiplyScalar(0.35);
    I.timeScale = 1;
    kin.knock = 0;
    kin.anim.choke = 1;
    this.holdVel.copy(P.vel);
    this.holdPrev.copy(kin.pos);
  }

  // Каждый кадр, уже после хода цели: её шея там, где кулак героя. На ходу тело тянется следом
  holdTick(rdt) {
    const I = this.inv, P = I.player, kin = this.kin;
    if (rdt > 0) this.holdVel.lerp(P.vel, 1 - Math.exp(-7 * rdt));
    // Шея сверху, ноги висят и отстают от хода
    _y.copy(this.holdVel).clampLength(0, 130).multiplyScalar(0.8).addScaledVector(UP, 60).normalize();
    _z.subVectors(I.heroC.copy(P.pos).addScaledVector(UP, 1), P.model.fistWorldPos('R', _cp));
    _z.addScaledVector(_y, -_z.dot(_y));
    if (_z.lengthSq() < 1e-4) _z.set(P.facing.x, 0, P.facing.z).negate();
    _z.normalize();
    _x.crossVectors(_y, _z);
    _q.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
    kin.poseQ.slerp(_q, rdt > 0 ? 1 - Math.exp(-9 * rdt) : 0);
    // Центр тела ниже кулака вдоль его собственной оси и дальше от героя: кулак на горле спереди
    _s.set(0, NECK, THROAT).applyQuaternion(kin.poseQ);
    kin.pos.copy(_cp).sub(_s).addScaledVector(UP, -1);
    // У самой земли ноги волочатся по ней, а не уходят под асфальт
    kin.pos.y = Math.max(kin.pos.y, I.world.city.groundHeightAt(kin.pos.x, kin.pos.z, kin.pos.y + 1));
    kin.vel.set(0, 0, 0);
    kin.grounded = false;
    kin.orient(rdt);
    // Цель — таран: дома лопаются об неё, ей это тоже больно
    const sp = P.speed;
    if (sp > DRAG_SPEED && Math.min(this.holdPrev.y, kin.pos.y) < 700) {
      const smashed = I.chain.ram(this.holdPrev, kin.pos, sp);
      if (smashed) {
        _d.copy(P.vel).normalize();
        if (kin.kind === 'general') kin.damage(6 * smashed, kin.c.clone(), _d.clone(), 'ram');
        else {
          kin.hp -= 12 * smashed;
          if (kin.hp <= 0) I.onSoldierDown(kin);
        }
        reelHit(kin.reel, 0.9);
        P.hitstop = Math.max(P.hitstop, 0.035);
      }
    }
    this.holdPrev.copy(kin.pos);
  }

  // R: просто разжимает руку
  drop() {
    const P = this.inv.player, kin = this.kin;
    this.finish();
    kin.poseQ = null;
    kin.knock = 0;
    kin.grounded = false;
    kin.vel.copy(P.vel).multiplyScalar(0.6);
    if (kin.kind === 'general') { kin.go('recover'); kin.recoverT = 0.45; }
    else kin.state = 'fight';
  }

  // ЛКМ или B: швыряет не останавливаясь, рука уходит в удар
  hurl() {
    const I = this.inv, P = I.player;
    this.throwAim(this.throwDir);
    P.blow = { side: 'R', f: 1.75, k: 1, pitch: 0, kind: 'straight' };
    P.poseQ = P.quat.clone();
    I.fx.play('swing', { gain: 0.95, rate: 0.8 });
    this.release(false);
  }

  // F: рука с целью уходит в раскрутку прямо из хватки
  spinFromHold() {
    const I = this.inv, P = I.player;
    P.gripping = false;
    this.kin.anim.choke = 0;
    P.driven = this.driven;
    P.boosting = false;
    P.blow = { side: 'R', f: 1.99, k: 1, pitch: 0, kind: 'straight' };
    P.poseQ = P.quat.clone();
    P.lockDir = new THREE.Vector3(0, 0, 1);
    I.fx.cineFor(2.6);
    this.startSpin();
  }

  // Раскрутка. К концу рука идёт ровно по линии броска, поэтому цель уходит туда, куда он смотрит
  startSpin() {
    const I = this.inv, P = I.player, kin = this.kin, big = kin.kind === 'general';
    this.state = 'spin';
    this.left = this.all = big ? 0.95 : 0.55;
    this.throwAim(this.throwDir);
    const s = this.s = Math.random() < 0.5 ? -1 : 1, T = this.throwDir;
    _s.copy(P.pos).addScaledVector(UP, 1);
    this.a0 = Math.atan2(kin.c.z - _s.z, kin.c.x - _s.x);
    const end = Math.atan2(-T.x * s, T.z * s);
    this.da = (big ? Math.PI * 2 : 0) + ((((end - this.a0) * s) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    P.vel.multiplyScalar(0.25);
    I.timeScale = 0.5;
    I.fx.play('whirl', { rate: big ? 1 : 1.6 });
    I.theme.duck(0.7);
    this.startShot();
  }

  // Клавиши и взгляд решают: вверх так вверх, вниз так вниз. Смотрит перед собой — в ближайший дом на линии, иначе к земле
  throwAim(out) {
    const I = this.inv, kin = this.kin, input = I.input, city = I.world.city, aim = I.camRig.direction, c = kin.c;
    out.copy(aim);
    if (input && Math.abs(input.moveX) + Math.abs(input.moveY) > 0.1) {
      _r.crossVectors(aim, UP);
      if (_r.lengthSq() < 0.01) _r.set(1, 0, 0);
      out.addScaledVector(_r.normalize(), input.moveX).addScaledVector(UP, input.moveY);
    } else if (aim.y < 0.35) {
      let best = -Infinity;
      if (c.y < 700) {
        for (const s of city.sphereQuery(c, 200, this.hits)) {
          if (!s.alive) continue;
          city.closestPoint(s, c, _cp).sub(c);
          const l = _cp.length();
          if (l < 10) continue;
          const dot = _cp.dot(aim) / l;
          if (dot > 0.6 && dot > best) { best = dot; _v.copy(_cp); }
        }
      }
      if (best > -Infinity) out.copy(_v);
      else if (c.y - kin.groundY > 40) out.y -= 0.7;
    }
    return out.normalize();
  }

  spin(rdt) {
    const I = this.inv, P = I.player, kin = this.kin;
    const k = 1 - clamp(this.left / this.all, 0, 1), a = this.a0 + this.s * this.da * k * k;
    P.vel.multiplyScalar(Math.exp(-6 * rdt));
    P.pos.addScaledVector(P.vel, rdt);
    I.chain.keepAbove(P);
    _s.copy(P.pos).addScaledVector(UP, 1);
    whirlPose(_s, a, 2.7, 0.1, _cp, kin.poseQ, P.poseQ);
    kin.pos.copy(_cp).addScaledVector(UP, -1);
    P.lockDir.subVectors(_cp, _s).normalize();
    if (this.left <= 0) this.release();
  }

  // Рука разжимается: цель уносит, и начинается окно серии. После раскрутки герой гасит ход, на лету летит дальше
  release(stop = true) {
    const I = this.inv, P = I.player, kin = this.kin, dir = this.throwDir.clone();
    this.finish();
    if (P.blow) P.blow.f = 2;
    if (stop) P.vel.copy(dir).multiplyScalar(-8);
    kin.poseQ = null;
    kin.knock = 0;
    kin.grounded = false;
    if (kin.kind === 'general') {
      kin.go('knock');
      kin.finalHit = true;
    } else kin.state = 'fight';
    this.watch = kin;
    this.watchT = 0.7;
    kin.receive('throw', 1, kin.c.clone(), dir);
    I.fx.chainRelease(kin.c, dir, 4, false, kin);
    I.fx.play('sonicBoom', { gain: 0.9 });
    I.fx.crashZoom(14, 0.4);
    I.fx.airRing(kin.c, dir, 34, 0.6, 0.5);
    I.theme.duck(0.9);
  }

  finish() {
    const I = this.inv, P = I.player;
    if (P.driven === this.driven) P.driven = null;
    if (this.kin) this.kin.anim.choke = 0;
    P.gripping = false;
    P.lockDir = null;
    P.boosting = false;
    I.timeScale = 1;
    this.kin = null;
    this.state = null;
    this.readyAt = I.time + COOLDOWN;
  }

  // Сцену прервали извне: отпускаем цель как есть
  abort() {
    const kin = this.kin;
    this.finish();
    this.clearShot();
    if (kin.poseQ) kin.poseQ = null;
    kin.knock = 0;
    if (kin.state === 'seized') { kin.go('recover'); kin.recoverT = 0.3; }
    else if (kin.state === 'held') kin.state = 'fight';
    this.inv.player.blow = null;
    this.inv.player.poseQ = null;
  }

  // ---------------------------------------------------------------- кадр раскрутки: издалека и сбоку
  startShot() {
    const I = this.inv, kin = this.kin, city = I.world.city, S = this.camS, R = I.camRig;
    if (R.shot) return;
    _cp.lerpVectors(I.heroC, kin.c, 0.5);
    S.subVectors(kin.c, I.heroC).cross(UP);
    if (S.lengthSq() < 0.01) S.set(1, 0, 0);
    S.normalize();
    if (Math.random() < 0.5) S.negate();
    if (city.isInside(_v.copy(_cp).addScaledVector(S, SHOT))) {
      S.negate();
      if (city.isInside(_v.copy(_cp).addScaledVector(S, SHOT))) return;
    }
    this.shotOn = true;
    this.shot.pos.copy(_v).addScaledVector(UP, 2.2);
    this.shot.look.copy(I.heroC);
    this.shot.fov = 52;
    R.shot = this.shot;
  }

  // Каждый кадр в реальном времени
  update(rdt) {
    const I = this.inv, S = this.shot;
    if (this.holding) {
      // Цель забрала сцена, или герой упал: рука разжимается
      const kin = this.kin;
      if (I.heroDown || I.story.lock || I.story.brawlOn || I.finale.on || !kin.alive || (kin.state !== 'seized' && kin.state !== 'held')) this.abort();
      else this.holdTick(rdt);
    } else if (this.kin && (I.player.driven !== this.driven || I.heroDown)) this.abort();
    if (!this.shotOn) return;
    if (this.kin) {
      _v.copy(I.heroC).addScaledVector(this.camS, SHOT).addScaledVector(UP, 2.2);
      S.pos.lerp(_v, 1 - Math.exp(-5 * rdt));
      S.look.lerp(I.heroC, 1 - Math.exp(-10 * rdt));
      S.fov = 52 - I.fx.zoom;
    } else {
      // Цель уносит: камера на месте, объектив сужается вслед за ней
      this.watchT -= rdt;
      if (this.watchT <= 0 || !this.watch) { this.clearShot(); return; }
      S.look.lerp(this.watch.c, 1 - Math.exp(-10 * rdt));
      S.fov = clamp(52 * 16 / Math.max(1, S.pos.distanceTo(this.watch.c)), 14, 52) - I.fx.zoom * 0.4;
    }
    const gy = I.world.city.groundHeightAt(S.pos.x, S.pos.z, S.pos.y + 1) + 0.6;
    if (S.pos.y < gy) S.pos.y = gy;
  }

  clearShot() {
    this.shotOn = false;
    const R = this.inv.camRig;
    if (R && R.shot === this.shot) R.shot = null;
  }
}
