import * as THREE from 'three';
import { spaceK } from './kin.js';
import { BODIES } from '../world/bodies.js';
import { blowQuat, followBlow, reelHit, tickReel } from '../player/model.js';
import { clamp, damp, lerp, smoothstep } from '../utils.js';

// Серия ударов в полёте. Каждый удар — отдельный кадр, как в кино:
// рывок к цели → время вязнет, герой замахивается всем телом (камера уходит вбок) →
// кулак идёт к цели → стоп-кадр → тело цели складывается вокруг кулака, кулак давит его дальше →
// воздух рвётся, и цель уносит. Пока она летит, можно нажать удар ещё раз и догнать её.
// Цель ведёт себя так, как будто её и правда гонят: врезается в здания, уходит ввысь или в землю.

const MAX_HITS = 6;
const DMG = [34, 40, 48, 58, 70, 120];
// Узор направлений: удары идут то вправо-вверх, то влево — серия не летит по прямой
const PATTERN = [[0.5, 0.35], [-0.6, 0.2], [0.3, 0.7], [-0.4, -0.15], [0.6, 0.4]];
// Куда встаёт камера: вбок, снизу, из-за спины цели. Кулак всегда виден
const ANGLES = [
  { a: 5, b: 0.6, c: -0.5, fov: 40 },
  { a: 3.4, b: -3, c: 1.1, fov: 46 },
  { a: 1.5, b: 0.5, c: 4.6, fov: 44 },
];
const FINAL_ANGLE = { a: 6.6, b: 0.9, c: -0.4, fov: 34 };
const UP = new THREE.Vector3(0, 1, 0);
const _d = new THREE.Vector3(), _v = new THREE.Vector3(), _r = new THREE.Vector3(), _s = new THREE.Vector3(), _cp = new THREE.Vector3();
const _p0 = new THREE.Vector3(), _q = new THREE.Quaternion();

export class Chain {
  constructor(inv) {
    this.inv = inv;
    this.kin = null;
    this.state = null;   // chase | window | tail
    this.phase = null;   // для chase: rush | coil | drive | push
    this.n = 0;
    this.best = 0;
    this.side = 1;
    this.hits = [];
    this.aim = new THREE.Vector3();
    this.hitDir = new THREE.Vector3(0, 0, 1);
    this.camS = new THREE.Vector3();
    this.camU = new THREE.Vector3();
    this.camD = new THREE.Vector3();
    this.shot = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 40 };
    this.driven = (dt) => this.chase(dt);
  }

  reset() {
    this.kin = null;
    this.state = null;
    this.phase = null;
    this.n = 0;
    this.best = 0;
    this.queued = false;
    this.side = 1;
    const P = this.inv.player;
    if (P.driven === this.driven) P.driven = null;
    P.blow = null;
    P.poseQ = null;
    this.clearShot();
  }

  get active() { return !!this.kin; }

  // Начало серии: враг получил удар и отлетает. kind: punch | heavy | ram | throw | slam | car
  open(kin, dir, kind, power = 0) {
    if (this.kin === kin) {
      if (this.state === 'window') { reelHit(kin.reel, 0.7, this.n % 3); this.launch(kin, dir, 0.7 + power * 0.5); }
      return true;
    }
    if (this.kin) return false;
    const I = this.inv;
    this.kin = kin;
    this.n = kind === 'punch' ? 1 : 2;
    this.queued = false;
    kin.chainEnd?.();
    kin.go?.('knock');
    kin.reel.ext = true;
    reelHit(kin.reel, 0.85 + power * 0.3, Math.floor(Math.random() * 3));
    this.hitDir.copy(dir);
    this.launch(kin, dir, 1 + power * 0.6);
    this.openWindow();
    I.bestChain = Math.max(I.bestChain, this.n);
    return true;
  }

  // Отправить цель в полёт; скорость растёт с номером удара, вверх улетает особенно быстро
  launch(kin, dir, mul = 1, knock = 0.5) {
    if (kin.kind === 'general') this.inv.arenaDir(dir, 0.45);
    const sk = spaceK(kin.pos.y);
    const up = smoothstep(0.4, 0.9, dir.y);
    const speed = lerp(300, 2400, sk) * (1 + this.n * 0.12) * (1 + up * 2.5 * (1 - sk)) * mul;
    kin.launch(dir, speed, knock);
  }

  openWindow() {
    this.state = 'window';
    this.phase = null;
    // Ждёт дольше, чем нужно: нажать можно спокойно, удар сам дождётся, пока цель отлетит
    this.windowLen = lerp(1.5, 1.1, Math.min(1, (this.n - 1) / (MAX_HITS - 1)));
    this.windowT = 0;
    this.inv.timeScale = 0.16;
  }

  // Цель врезалась и лежит: добить можно, но окно уже не продлевается
  onTargetCrash() {
    if (this.state === 'window') this.windowLen = Math.min(this.windowLen, this.windowT + 0.7);
  }

  // Конец серии: цель приходит в себя, герой снова свободен
  end(keepKnock = false) {
    const I = this.inv, kin = this.kin, P = I.player;
    if (kin) {
      if (kin.alive && kin.knock > 0 && !keepKnock) kin.knock = Math.min(kin.knock, 0.3);
      kin.reel.ext = false;
    }
    this.kin = null;
    this.state = null;
    this.phase = null;
    this.queued = false;
    I.timeScale = 1;
    if (P.driven === this.driven) P.driven = null;
    P.lockDir = null;
    P.boosting = false;
    this.clearShot();
  }

  // ---------------------------------------------------------------- кадр: реальное время
  update(realDt) {
    const I = this.inv, P = I.player, kin = this.kin;
    followBlow(P, realDt);
    if (!kin) return;
    // Держим цель в отлёте, пока идёт серия: она не может собраться
    if (kin.alive && (kin.state === 'knock' || kin.kind === 'soldier') && kin.state !== 'gone' && kin.state !== 'down') kin.knock = Math.max(kin.knock, 0.3);
    if (!kin.alive && kin.kind === 'soldier' && kin.state !== 'gone' && this.state === 'window') { this.end(); return; }
    // Тело цели живёт в своём времени: при замедлении оно всё равно успевает сложиться
    tickReel(kin.reel, realDt * (P.hitstop > 0 ? 0.04 : 0.8));
    if (kin.state === 'knock') kin.anim.knock = damp(kin.anim.knock, 1, 14, realDt);
    if (this.phase !== 'push' && this.phase !== 'coil' && this.phase !== 'drive') kin.vel.multiplyScalar(Math.exp(-2.4 * realDt * I.timeScale));
    if (!I.heroAlive) { this.end(); return; }

    this.updateShot(realDt);
    if (this.state === 'window') {
      this.windowT += realDt;
      // После стоп-кадра время оживает постепенно: успеваешь увидеть, как цель уносит
      if (I.slowT <= 0) I.timeScale = lerp(0.16, 0.5, smoothstep(0, 0.7, this.windowT));
      if (this.windowT > 0.75) this.clearShot();
      if (this.queued && this.windowT > 0.62) {
        this.beginChase();
        return;
      }
      if (this.windowT >= this.windowLen) this.end();
    } else if (this.state === 'tail') {
      this.tailT -= realDt;
      if (this.tailT <= 0) this.end(true);
    }
  }

  // ---------------------------------------------------------------- рывок к цели
  beginChase() {
    const I = this.inv, P = I.player, kin = this.kin;
    this.state = 'chase';
    this.phase = 'rush';
    this.queued = false;
    this.clearShot();
    P.driven = this.driven;
    P.punchT = -1;
    P.punchHit = true;
    P.charge = 0;
    P.dashT = 0;
    P.slamming = false;
    P.falling = false;
    P.grounded = false;
    P.knockT = 0;
    P.lasering = false;
    P.poseQ = null;
    P.boosting = true;
    this.aim.copy(I.camRig.direction);
    const d = kin.c.distanceTo(I.heroC);
    this.big = kin.kind === 'general';
    this.left = clamp(d / 900, 0.28, 0.5);
    this.final = this.n >= MAX_HITS - 1;
    this.coilLen = !this.big ? 0.2 : this.final ? 0.68 : 0.5;
    this.driveLen = this.big ? 0.14 : 0.09;
    this.side = -this.side;
    P.blow = { side: this.side > 0 ? 'R' : 'L', f: 0, k: 0, pitch: 0 };
    I.timeScale = 0.85;
    _d.subVectors(kin.c, I.heroC).normalize();
    I.fx.chainRush(I.heroC, _d);
  }

  // Функция движения героя (player.driven) на время рывка и удара
  chase() {
    const I = this.inv, P = I.player, kin = this.kin;
    if (!kin) { P.driven = null; return; }
    const rdt = I.realDt;
    this.left -= rdt;
    const c = _s.copy(P.pos).addScaledVector(UP, 1);
    _d.subVectors(kin.c, c);
    const dist = _d.length();
    _d.divideScalar(dist || 1);
    P.lockDir = (P.lockDir || new THREE.Vector3()).copy(_d);
    // До какого зазора дойти к концу этапа. Время считаем настоящее: от замедления рывок не зависит
    const gap = this.phase === 'rush' ? (this.big ? 13 : 6) : this.phase === 'coil' ? 2.5 : 1.35;
    const speed = Math.max(0, dist - gap) / Math.max(this.left, 0.02);
    _p0.copy(P.pos);
    P.pos.addScaledVector(_d, Math.min(speed * rdt, Math.max(0, dist - gap)));
    P.vel.copy(_d).multiplyScalar(this.phase === 'rush' ? Math.max(speed, 90) : this.phase === 'push' ? 4 : 14);
    if (Math.min(_p0.y, P.pos.y) < 700) this.ram(_p0, P.pos, speed);
    this.keepAbove(P);

    const b = P.blow;
    if (this.phase === 'rush') {
      if (this.left <= 0 || dist <= gap + 0.3) this.startCoil();
      return;
    }
    if (this.phase === 'coil') {
      b.k = Math.min(1, b.k + rdt / 0.1);
      b.f = clamp(1 - this.left / this.coilLen, 0, 1);
      this.leanTo(_d, -0.26, rdt, 12);
      if (this.left <= 0) {
        this.phase = 'drive';
        this.left = this.driveLen;
        I.timeScale = 0.3;
      }
    } else if (this.phase === 'drive') {
      b.k = 1;
      b.f = 1 + clamp(1 - this.left / this.driveLen, 0, 1);
      this.leanTo(_d, 0.42, rdt, 22);
      if (this.left <= 0) this.contact();
    } else if (this.phase === 'push') {
      // Кулак вошёл и давит дальше: цель ещё не улетела, тело только складывается
      b.f = 2 + 0.28 * clamp(1 - this.left / this.pushLen, 0, 1);
      this.leanTo(_d, 0.5, rdt, 10);
      if (this.left <= 0) this.release();
    }
  }

  startCoil() {
    const I = this.inv, P = I.player, kin = this.kin;
    this.phase = 'coil';
    this.left = this.coilLen;
    I.timeScale = this.big ? 0.2 : 0.4;
    kin.vel.multiplyScalar(0.15);
    P.boosting = false;
    P.poseQ = P.quat.clone();
    if (this.big) this.startShot();
    // Воздух втягивается и обрывается ровно в момент удара; оркестр уходит заранее
    I.fx.play('preHit', { gain: 0.95, rate: 0.62 / (this.coilLen + this.driveLen) });
    I.theme.duck(0.65);
  }

  // Плавно ведём корпус героя: лицом к цели, с наклоном от неё (замах) или в неё (удар)
  leanTo(dir, lean, rdt, rate) {
    const P = this.inv.player;
    if (!P.poseQ) P.poseQ = P.quat.clone();
    P.poseQ.slerp(blowQuat(_q, dir, lean), 1 - Math.exp(-rate * rdt));
  }

  // Герой прошивает здания на пути
  ram(from, to, speed) {
    const W = this.inv.world, city = W.city;
    const n = Math.min(6, Math.ceil(from.distanceTo(to) / 6));
    let smashed = 0;
    for (let i = 1; i <= n && smashed < 3; i++) {
      _r.lerpVectors(from, to, i / n);
      _r.y += 1;
      city.sphereQuery(_r, 1.4, this.hits);
      for (const b of this.hits) {
        if (smashed >= 3) break;
        city.closestPoint(b, _r, _cp);
        const dir = _v.subVectors(to, from).normalize().clone();
        city.destroySeg(b, _cp.clone(), dir, Math.min(speed * 0.25, 140));
        this.inv.fx.pierce(_cp.clone(), dir, speed);
        smashed++;
      }
    }
  }

  keepAbove(P) {
    const W = this.inv.world;
    P.groundY = W.city.groundHeightAt(P.pos.x, P.pos.z, P.pos.y + 0.5);
    if (P.pos.y < P.groundY) P.pos.y = P.groundY;
    for (const B of BODIES) {
      _v.subVectors(P.pos, B.c);
      const l = _v.length();
      if (l < B.r + 1.5) P.pos.copy(B.c).addScaledVector(_v, (B.r + 1.5) / l);
    }
  }

  // ---------------------------------------------------------------- удар
  contact() {
    const I = this.inv, P = I.player, kin = this.kin;
    // Генерал во второй половине боя иногда успевает встретить кулак
    if (kin.kind === 'general' && kin.alive && Math.random() < kin.tempo.breakChain) {
      const k = this.kin;
      P.driven = null;
      this.end();
      I.clash(k);
      return;
    }
    const i = Math.min(this.n, MAX_HITS - 1);
    this.final = this.n >= MAX_HITS - 1;
    const dmg = DMG[i];
    const point = P.model.fistWorldPos(P.blow?.side || 'R', new THREE.Vector3());
    // Куда полетит: взгляд в момент нажатия + узор + клавиши
    const dir = this.pickDir(kin);
    this.hitDir.copy(dir);
    this.n++;
    I.bestChain = Math.max(I.bestChain, this.n);
    this.best = Math.max(this.best, this.n);
    if (kin.kind === 'general') kin.damage(dmg, point, dir, 'chain');
    else {
      kin.hp -= dmg;
      if (kin.hp <= 0) I.onSoldierDown(kin);
    }
    this.dead = !kin.alive;
    // Тело принимает удар. Сразу не улетает: кулак сначала давит его
    reelHit(kin.reel, this.final ? 1.35 : 1.1, this.n % 3);
    kin.reel.ext = true;
    if (!this.dead) kin.go?.('knock');
    kin.knock = this.dead ? 99 : Math.max(kin.knock, 0.5);
    kin.grounded = false;
    kin.vel.copy(dir).multiplyScalar(22);
    I.timeScale = 0.12;
    this.phase = 'push';
    // Вся тяжесть удара — в BattleFX; никакой тряски, только хит-стоп и объектив
    if (this.dead && kin.kind === 'general') P.hitstop = Math.max(P.hitstop, 0.42);
    else I.fx.chainHit(point, dir, this.n, this.final || this.dead, kin);
    this.pushLen = this.left = P.hitstop + (!this.big ? 0.06 : this.final || this.dead ? 0.42 : 0.26);
  }

  // Кулак отпускает: цель уносит, воздух рвётся кольцами
  release() {
    const I = this.inv, P = I.player, kin = this.kin, dir = this.hitDir;
    P.driven = null;
    P.falling = false;
    P.grounded = false;
    P.vel.copy(dir).multiplyScalar(12);
    reelHit(kin.reel, 0.5, kin.reel.kind);
    I.fx.chainRelease(kin.c, dir, this.n, this.final || this.dead, kin);
    if (this.dead || this.final) {
      // Финальный удар: большой разгон и долгий кадр
      if (this.dead) kin.launch(dir, lerp(420, 2200, spaceK(kin.pos.y)), kin.kind === 'general' ? 99 : 1.5);
      else {
        kin.go?.('knock');
        this.launch(kin, dir, 1.8, 1.6);
        kin.finalHit = true;
      }
      I.theme.stinger();
      I.slowFor(0.14, 1.1);
      this.state = 'tail';
      this.phase = null;
      this.tailT = this.big ? 1.1 : 0.2;
      return;
    }
    kin.go?.('knock');
    this.launch(kin, dir, 1);
    this.openWindow();
  }

  pickDir(kin) {
    const I = this.inv, input = I.input;
    const d = new THREE.Vector3().copy(this.aim);
    const right = _r.crossVectors(this.aim, UP);
    if (right.lengthSq() < 0.01) right.set(1, 0, 0);
    right.normalize();
    const [px, py] = PATTERN[this.n % PATTERN.length];
    d.addScaledVector(right, px * 0.55).addScaledVector(UP, py * 0.55);
    if (input) {
      d.addScaledVector(right, input.moveX * 1.1).addScaledVector(UP, input.moveY * 1.1);
    }
    d.normalize();
    // У земли и над городом отправляем вниз только сознательно: взгляд вниз или клавиша C
    if (kin.pos.y - kin.groundY < 80 && this.aim.y > -0.45 && !(input && input.moveY < 0)) d.y = Math.max(d.y, 0.12);
    return d.normalize();
  }

  // ---------------------------------------------------------------- кадр удара
  startShot() {
    const I = this.inv, kin = this.kin, city = I.world.city;
    const D = this.camD.subVectors(kin.c, I.heroC).normalize();
    const S = this.camS.crossVectors(D, UP);
    if (S.lengthSq() < 0.01) S.set(1, 0, 0);
    S.normalize();
    this.camU.crossVectors(S, D).normalize();
    this.angle = this.final ? FINAL_ANGLE : ANGLES[(this.n - 1) % ANGLES.length];
    this.camSide = this.side;
    this.camT = 0;
    // Сторона, где нет стены; нет такой — останемся за плечом
    const inside = (s) => city.isInside(this.shotPos(_v, s, 1));
    if (inside(this.camSide)) {
      this.camSide = -this.camSide;
      if (inside(this.camSide)) return;
    }
    this.shotOn = true;
    this.shot.look.lerpVectors(I.heroC, kin.c, 0.5);
    this.shot.fov = this.angle.fov;
    this.updateShot(0);
    I.camRig.shot = this.shot;
  }

  // Центр кадра — середина между героем и целью; dolly > 1 — камера ещё далеко
  shotPos(out, side, dolly) {
    const I = this.inv, A = this.angle;
    out.lerpVectors(I.heroC, this.kin.c, this.state === 'chase' ? 0.5 : 0);
    if (this.state !== 'chase') out.addScaledVector(this.camD, 1.2);
    out.addScaledVector(this.camS, A.a * side * dolly).addScaledVector(this.camU, A.b).addScaledVector(this.camD, A.c);
    return out;
  }

  updateShot(realDt) {
    if (!this.shotOn) return;
    const I = this.inv, kin = this.kin, S = this.shot, A = this.angle;
    this.camT += realDt;
    const pos = S.pos;
    // Камера медленно наезжает весь замах
    this.shotPos(pos, this.camSide, lerp(1.22, 1, smoothstep(0, this.coilLen + 0.2, this.camT)));
    const gy = I.world.city.groundHeightAt(pos.x, pos.z, pos.y + 1) + 0.6;
    if (pos.y < gy) pos.y = gy;
    if (this.state === 'chase') {
      _v.lerpVectors(I.heroC, kin.c, 0.5);
      S.look.lerp(_v, 1 - Math.exp(-12 * realDt));
      S.fov = A.fov - I.fx.zoom;
    } else {
      // Цель улетает: объектив сужается и ведёт её взглядом
      S.look.lerp(kin.c, 1 - Math.exp(-11 * realDt));
      const far = kin.c.distanceTo(pos);
      S.fov = clamp(A.fov * 22 / Math.max(far, 1), 13, A.fov) - I.fx.zoom * 0.4;
    }
  }

  clearShot() {
    const R = this.inv.camRig;
    this.shotOn = false;
    if (R && R.shot === this.shot) R.shot = null;
  }
}
