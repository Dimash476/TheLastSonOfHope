import * as THREE from 'three';
import { blowQuat, reelHit, whirlPose } from '../player/model.js';
import { clamp } from '../utils.js';

// Захват на R. Это не «взял и держишь», а сцена из трёх кадров: рывок к цели в замедлении, рука на горле,
// и дальше бросок. Над городом герой сперва тащит генерала перед собой сквозь дома, потом раскручивает
// на вытянутой руке и швыряет туда, куда смотрит; цель уносит, и её можно догнать серией ударов.
// Генерал может успеть встретить: тогда столкновение, и он сразу отвечает. Солдат просто швыряет.

const RANGE = 60;
const SOLDIER_RANGE = 34;
const COOLDOWN = 6;     // с: столько нельзя снова хватать генерала, пока он не открылся сам
const SHOT = 8;         // м: кадр раскрутки сбоку, обе фигуры целиком
const CLOSED = ['wait', 'descend', 'stand', 'watch', 'approach', 'scene', 'meteor', 'beamlock', 'cut', 'brawl', 'climb', 'carry', 'dead', 'seized', 'held'];

const UP = new THREE.Vector3(0, 1, 0);
const _d = new THREE.Vector3(), _s = new THREE.Vector3(), _v = new THREE.Vector3(), _cp = new THREE.Vector3();
const _p0 = new THREE.Vector3(), _k0 = new THREE.Vector3(), _r = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class Seize {
  constructor(inv) {
    this.inv = inv;
    this.hits = [];
    this.dir = new THREE.Vector3(0, 0, 1);
    this.throwDir = new THREE.Vector3(0, 0, 1);
    this.camS = new THREE.Vector3(1, 0, 0);
    this.shot = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 50 };
    this.driven = () => this.tick();
    this.reset();
  }

  reset() {
    const P = this.inv.player;
    if (P.driven === this.driven) P.driven = null;
    this.kin = null;
    this.state = null;
    this.readyAt = 0;
    this.watch = null;
    this.watchT = 0;
    this.clearShot();
  }

  // Нажата R. Цель в конусе взгляда; нет цели — обычный захват (машина, обломок)
  tryStart() {
    const I = this.inv, P = I.player;
    if (this.kin || P.held || P.driven || P.captured || P.knockT > 0 || P.charge > 0 || I.story.lock) return false;
    const t = I.findTarget(RANGE);
    if (!t || CLOSED.includes(t.state)) return false;
    const d = t.c.distanceTo(I.heroC);
    if (t.kind === 'soldier' && d > SOLDIER_RANGE) return false;
    if (t.kind === 'general' && !t.open && I.time < this.readyAt) return false;
    if (I.chain.kin) I.chain.end(true);
    this.kin = t;
    this.state = 'rush';
    this.left = clamp(d / 420, 0.14, 0.32);
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
    else if (this.state === 'drag') this.drag(rdt);
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
    const aim = I.camRig.direction;
    if (kin.kind === 'general' && this.wallAhead(aim)) this.startDrag(aim);
    else this.startSpin();
  }

  // Впереди дом, а они оба ещё не выше крыш: будет чем его бить
  wallAhead(aim) {
    const kin = this.kin, city = this.inv.world.city, c = kin.c;
    if (c.y - kin.groundY > 240) return false;
    _r.set(aim.x, 0, aim.z);
    if (_r.lengthSq() < 0.04) return false;
    _r.normalize();
    for (const s of city.sphereQuery(c, 230, this.hits)) {
      if (!s.alive) continue;
      city.closestPoint(s, c, _cp).sub(c);
      const l = _cp.length();
      if (l > 6 && _cp.dot(_r) / l > 0.8) return true;
    }
    return false;
  }

  startDrag(aim) {
    const I = this.inv, P = I.player, kin = this.kin;
    this.state = 'drag';
    this.left = 1.25;
    this.speed = 120;
    this.dir.set(aim.x, 0, aim.z).normalize();
    this.dragY = Math.max(P.pos.y, kin.groundY + 8);
    I.timeScale = 1;
    I.fx.play('rush');
    I.fx.cineFor(2.8);
    I.theme.duck(0.5);
  }

  // Несёт его перед собой на вытянутой руке, и дома ломаются об него
  drag(rdt) {
    const I = this.inv, P = I.player, kin = this.kin, city = I.world.city;
    this.speed = Math.min(380, this.speed + 900 * rdt);
    const gy = city.groundHeightAt(P.pos.x, P.pos.z, P.pos.y + 0.5);
    _d.copy(this.dir);
    _d.y = clamp((Math.max(this.dragY, gy + 6) - P.pos.y) * 0.03, -0.5, 0.5);
    _d.normalize();
    _p0.copy(P.pos);
    P.pos.addScaledVector(_d, this.speed * rdt);
    P.vel.copy(_d).multiplyScalar(this.speed);
    _k0.copy(kin.pos);
    kin.pos.copy(P.pos).addScaledVector(_d, 1.9);
    I.chain.ram(_p0, P.pos, this.speed);
    const smashed = I.chain.ram(_k0, kin.pos, this.speed);
    if (smashed) {
      kin.damage(6 * smashed, kin.c.clone(), _d.clone(), 'ram');
      reelHit(kin.reel, 0.9);
      P.hitstop = Math.max(P.hitstop, 0.035);
      this.speed *= 0.93;
    }
    I.chain.keepAbove(P);
    P.lockDir.copy(_d);
    blowQuat(P.poseQ, _d, 0.35);
    blowQuat(kin.poseQ, _v.copy(_d).negate(), -0.25);
    if (this.left <= 0) this.startSpin();
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

  // Рука разжимается: цель уносит, и начинается окно серии
  release() {
    const I = this.inv, P = I.player, kin = this.kin, dir = this.throwDir.clone();
    this.finish();
    if (P.blow) P.blow.f = 2;
    P.vel.copy(dir).multiplyScalar(-8);
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
    I.fx.crashZoom(12, 0.3);
  }

  finish() {
    const I = this.inv, P = I.player;
    if (P.driven === this.driven) P.driven = null;
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
    if (this.kin && (I.player.driven !== this.driven || I.heroDown)) this.abort();
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
