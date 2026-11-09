import * as THREE from 'three';
import { Player } from '../player/player.js';
import { PLAYER as P, SPACE, WORLD } from '../config.js';
import { BODIES, bodyGroundAt } from '../world/bodies.js';
import { newReel, reelHit } from '../player/model.js';
import { clamp, damp, smoothstep } from '../utils.js';

// Общее тело ксаррониты: та же модель движения и те же анимации, что у героя.
// Поведение (солдат, генерал) — в наследниках: они задают vel, aim и флаги анимации.

const { updateAnimation, updateCloth } = Player.prototype;
const UP = new THREE.Vector3(0, 1, 0);
const _p0 = new THREE.Vector3(), _s = new THREE.Vector3(), _cp = new THREE.Vector3(), _n = new THREE.Vector3();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();

export const spaceK = (y) => smoothstep(SPACE.atmosphere, SPACE.spaceAlt, y);

export class Kin {
  constructor(inv, kind) {
    this.inv = inv;
    this.W = inv.world;
    this.kind = kind;
    // Анимация заимствована у героя: своим шагам незачем топать на весь город и трясти камеру
    this.world = Object.create(inv.world);
    this.world.audio = null;
    this.world.effects = { shake() {}, fovKick: 0 };
    this.model = inv.factory.make(kind);
    this.root = new THREE.Group();
    this.model.group.position.y = -1.0;
    this.root.add(this.model.group);
    this.root.visible = false;
    inv.scene.add(this.root);

    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.facing = new THREE.Vector3(0, 0, 1);
    this.quat = new THREE.Quaternion();
    this.aim = new THREE.Vector3(0, 0, 1);
    this.aimFlat = new THREE.Vector3(0, 0, 1);
    this.c = new THREE.Vector3();
    this.latAccel = new THREE.Vector3();
    this.hits = [];
    this.spinAxis = new THREE.Vector3(1, 0, 0);
    this.reset();
  }

  reset() {
    this.vel.set(0, 0, 0);
    this.grounded = true; this.falling = false; this.slamming = false;
    this.groundY = 0;
    this.punchT = -1; this.punchSide = 'R'; this.punchPower = 0; this.punchHit = true;
    this.charge = 0; this.lasering = false; this.held = null; this.petting = null;
    this.takeoffT = 0; this.dipT = 0; this.dipK = 0; this.landT = 0;
    this.boosting = false; this.cruiseOn = false; this.braking = false; this.dashT = 0;
    this.waveT = 0; this.helpT = 0; this.throwT = -1; this.stepIdx = 0; this.idleT = 0;
    this.roll = 0; this.flyK = 0; this.spin = 0; this.spinRate = 0;
    this.knock = 0; this.guardK = 0; this.downK = 0; this.faceTarget = true;
    this.animAcc = 0; this.animSkip = 0; this.smashed = 0;
    this.hp = 100;
    this.reel = newReel();
    this.blow = null;
    this.poseQ = null;
    this.anim = { stand: 1, hover: 0, fly: 0, slam: 0, run: 0, runPhase: 0, sprint: 0, punch: null, charge: 0, bob: 0, lift: 0, knock: 0, guard: 0, downed: 0 };
    this.prevVel = null; this.prevRootQ = null;
  }

  get center() { return this.c; }
  get alive() { return this.hp > 0; }

  place(at, face) {
    this.pos.copy(at);
    this.vel.set(0, 0, 0);
    if (face) { this.facing.copy(face).setY(0).normalize(); this.aim.copy(this.facing); this.aimFlat.copy(this.facing); }
    this.quat.setFromAxisAngle(UP, Math.atan2(this.facing.x, this.facing.z));
    this.c.copy(this.pos).addScaledVector(UP, 1.0);
    this.root.position.copy(this.c);
    this.root.quaternion.copy(this.quat);
  }

  // Смотрим на точку (центр цели)
  lookAtPoint(p) {
    this.aim.subVectors(p, this.c);
    const l = this.aim.length();
    if (l > 1e-3) this.aim.divideScalar(l); else this.aim.copy(this.facing);
    this.aimFlat.set(this.aim.x, 0, this.aim.z);
    if (this.aimFlat.lengthSq() > 1e-4) this.aimFlat.normalize(); else this.aimFlat.copy(this.facing);
    return l;
  }

  // Плавно вести скорость к направлению dir и величине speed
  steer(dt, dir, speed, rate = 5) {
    this.vel.x = damp(this.vel.x, dir.x * speed, rate, dt);
    this.vel.y = damp(this.vel.y, dir.y * speed, rate, dt);
    this.vel.z = damp(this.vel.z, dir.z * speed, rate, dt);
  }

  startPunch(power = 0) {
    this.punchT = 0;
    this.punchPower = power;
    this.punchHit = true;
    this.punchSide = power > 0 ? 'R' : (this.punchSide === 'R' ? 'L' : 'R');
  }

  // Отброшен ударом: летит спиной вперёд и кувыркается
  launch(dir, speed, t = 0.7) {
    this.vel.copy(dir).multiplyScalar(speed);
    this.knock = t;
    this.grounded = false;
    this.falling = false;
    this.slamming = false;
    this.charge = 0;
    this.punchT = -1;
    this.lasering = false;
    this.landT = 0;
    this.smashed = 0;
    this.spinRate = (Math.random() < 0.5 ? -1 : 1) * (4 + Math.random() * 5);
  }

  // Попадание: вся тяжесть удара собрана в BattleFX
  hitFX(point, dir, k = 1) {
    if (!this.reel.ext) reelHit(this.reel, 0.35 + 0.6 * k);
    this.inv.fx.hit(point.clone(), (dir || this.aim).clone().normalize(), this.kind === 'soldier' ? k * 0.7 : k);
  }

  // Удар о землю или здание на большой скорости: воронка, пыль, волна
  crashFX(point, k) {
    this.inv.fx.crash(point, k);
  }

  // Перемещение и столкновения: здания, земля, Луна и планеты
  move(dt) {
    const W = this.W, city = W.city;
    _p0.copy(this.pos);
    this.pos.addScaledVector(this.vel, dt);
    if (Math.min(_p0.y, this.pos.y) < 700) this.collideCity();
    if (this.pos.y < SPACE.atmosphere) {
      const L = WORLD.limit;
      if (Math.abs(this.pos.x) > L) { this.pos.x = Math.sign(this.pos.x) * L; this.vel.x *= -0.3; }
      if (Math.abs(this.pos.z) > L) { this.pos.z = Math.sign(this.pos.z) * L; this.vel.z *= -0.3; }
    }
    const R = SPACE.flightRadius;
    if (this.pos.length() > R) {
      this.pos.setLength(R);
      this.vel.multiplyScalar(0.3);
    }
    // Брошенный в горы пробивает их насквозь
    const sp = this.vel.length();
    if (this.knock > 0 && sp > 110 && Math.min(_p0.y, this.pos.y) < 9000) W.terrainFX?.ram(_p0, this.pos, sp, 0.5);
    this.onBody = null;
    this.groundY = city.groundHeightAt(this.pos.x, this.pos.z, this.pos.y + 0.5);
    for (const B of BODIES) {
      _n.subVectors(this.pos, B.c);
      const l = _n.length();
      if (l < B.r + 1) {
        _n.divideScalar(l);
        const vn = this.vel.dot(_n);
        if (this.knock > 0 && vn < -80) this.crash(_cp.copy(B.c).addScaledVector(_n, B.r).clone(), -vn);
        this.pos.copy(B.c).addScaledVector(_n, B.r + 1);
        if (vn < 0) this.vel.addScaledVector(_n, -vn);
      }
      const gy = bodyGroundAt(B, this.pos);
      if (gy > this.groundY) { this.groundY = gy; this.onBody = B; }
    }
    if (this.pos.y <= this.groundY) {
      const impact = -this.vel.y;
      this.pos.y = this.groundY;
      if (this.vel.y < 0) this.vel.y = 0;
      // Пологий удар о землю — борозда; крутой — воронка
      if (impact > 3 * Math.hypot(this.vel.x, this.vel.z)) this.touchGround(impact);
      else this.touchGround(Math.min(impact, 40));
      this.skid(dt);
    } else if (this.grounded && this.pos.y > this.groundY + 0.5) {
      this.grounded = false;
    }
    if (this.grounded) this.pos.y = this.groundY;
  }

  touchGround(impact) {
    if (this.knock > 0 && impact > 60) this.crash(this.pos.clone(), impact);
  }

  // Летит низко и быстро: тело вспахивает землю и не сразу останавливается
  skid(dt) {
    const hs = Math.hypot(this.vel.x, this.vel.z);
    if (this.knock <= 0 || this.pos.y - this.groundY > 1.2 || hs < 60 || this.groundY > 700) return;
    this.vel.multiplyScalar(Math.exp(-1.6 * dt));
    this.skidD = (this.skidD || 0) + hs * dt;
    if (this.skidD > 6) {
      this.skidD = 0;
      this.inv.fx.furrow(this.pos, hs);
    }
  }

  // Удар об землю или стену в полёте: наследник решает, что дальше (упасть, встать)
  crash(point, speed) {
    this.crashFX(point, Math.min(1, speed / 420));
    this.vel.multiplyScalar(0.1);
    this.knock = Math.min(this.knock, 0);
    this.onCrash?.(point, speed);
  }

  collideCity() {
    const W = this.W, city = W.city;
    const speed = this.vel.length();
    const dist = this.pos.distanceTo(_p0);
    const n = Math.min(8, Math.max(1, Math.ceil(dist / 3)));
    for (let i = 1; i <= n; i++) {
      _s.lerpVectors(_p0, this.pos, i / n);
      _s.y += 1;
      city.sphereQuery(_s, 1.1, this.hits);
      for (const b of this.hits) {
        city.closestPoint(b, _s, _cp);
        const flying = this.knock > 0 || this.ramming;
        if (flying && speed >= P.ramSpeed && this.smashed < 6) {
          // Отброшенное тело пробивает здание насквозь
          const dir = _n.copy(this.vel).divideScalar(speed).clone();
          city.destroySeg(b, _cp.clone(), dir, Math.min(speed * 0.3, 140));
          this.vel.multiplyScalar(0.86);
          this.smashed++;
          this.inv.fx.pierce(_cp.clone(), dir, speed);
          this.onPierce?.();
          continue;
        }
        if (i < n) continue;
        // Обычное столкновение: выталкиваем наружу
        _n.subVectors(_s, _cp);
        let d = _n.length();
        if (d > 1e-4) _n.divideScalar(d);
        else {
          const px = b.w / 2 - Math.abs(_s.x - b.x), pz = b.d / 2 - Math.abs(_s.z - b.z), py = b.y0 + b.h - _s.y;
          if (py < px && py < pz) { _n.set(0, 1, 0); d = -py; }
          else if (px < pz) { _n.set(Math.sign(_s.x - b.x) || 1, 0, 0); d = -px; }
          else { _n.set(0, 0, Math.sign(_s.z - b.z) || 1); d = -pz; }
        }
        this.pos.addScaledVector(_n, 1.1 - d);
        const vn = this.vel.dot(_n);
        if (vn < 0) {
          if (this.knock > 0 && -vn > 60) this.crash(_cp.clone(), -vn);
          this.vel.addScaledVector(_n, -vn);
        }
      }
    }
  }

  // Поворот корпуса: лицом к цели, в полёте — головой вперёд, отброшенный — спиной вперёд
  orient(dt) {
    // Корпус ведёт сцена: замах, удар, падение
    if (this.poseQ) {
      this.quat.copy(this.poseQ);
      this.flyK = 0;
      this.c.copy(this.pos).addScaledVector(UP, 1.0);
      this.root.position.copy(this.c);
      this.root.quaternion.copy(this.quat);
      return;
    }
    const speed = this.vel.length();
    const acting = this.punchT >= 0 || this.charge > 0 || this.lasering || this.guardK > 0.3;
    const look = this.faceTarget || acting;
    const hv = _s.set(this.vel.x, 0, this.vel.z);
    if (look) this.facing.lerp(this.aimFlat, 1 - Math.exp(-14 * dt));
    else if (hv.lengthSq() > 4) this.facing.lerp(hv.normalize(), 1 - Math.exp(-8 * dt));
    this.facing.setY(0);
    if (this.facing.lengthSq() < 1e-4) this.facing.copy(this.aimFlat);
    this.facing.normalize();
    _q.setFromAxisAngle(UP, Math.atan2(this.facing.x, this.facing.z));

    let rate = 10;
    this.flyK = 0;
    if (this.knock > 0 && speed > 15) {
      // Спина ведёт полёт, тело кувыркается сразу вокруг двух осей
      this.spin += this.spinRate * dt;
      _z.copy(this.vel).divideScalar(-speed);
      _x.crossVectors(UP, _z);
      if (_x.lengthSq() < 1e-3) _x.set(1, 0, 0);
      _x.normalize();
      _y.crossVectors(_z, _x);
      _q.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
      _q.multiply(_q2.setFromAxisAngle(_z.set(0, 0, 1), this.spin));
      _q.multiply(_q2.setFromAxisAngle(_x.set(1, 0, 0), this.spin * 0.6));
      rate = 14;
    } else if (!this.grounded && !acting && !this.slamming && !this.falling && speed > 12 && !(look && speed < 45)) {
      // Полёт: голова вперёд по скорости, лицом к земле (как у героя)
      const k = smoothstep(12, 55, speed);
      _y.copy(this.vel).divideScalar(speed);
      _z.set(0, -1, 0).addScaledVector(_y, _y.y);
      if (_z.lengthSq() < 0.02) _z.copy(this.aimFlat).addScaledVector(_y, -this.aimFlat.dot(_y));
      _z.normalize();
      _x.crossVectors(_y, _z);
      _q2.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
      _q.slerp(_q2, k);
      this.flyK = k;
    }
    this.quat.slerp(_q, 1 - Math.exp(-rate * dt));
    this.c.copy(this.pos).addScaledVector(UP, 1.0);
    this.root.position.copy(this.c);
    this.root.quaternion.copy(this.quat);
  }

  // Анимация, плащ и удары; дальние солдаты обновляются реже
  animate(dt, camPos) {
    if (this.punchT >= 0) {
      this.punchT += dt;
      if (this.punchT > (this.punchLen ?? P.punchDuration) * (1 + this.punchPower * 0.5)) this.punchT = -1;
    }
    const a = this.anim;
    a.knock = damp(a.knock, this.knock > 0 ? 1 : 0, 12, dt);
    a.guard = damp(a.guard, this.guardK, 16, dt);
    a.downed = damp(a.downed, this.downK, 8, dt);
    this.animAcc += dt;
    const far = this.root.position.distanceToSquared(camPos) > 170 * 170;
    if (far && ++this.animSkip % 3) return;
    const adt = this.animAcc;
    this.animAcc = 0;
    updateAnimation.call(this, adt, this.aim);
    if (this.model.cape && !far) updateCloth.call(this, adt);
  }

  hide() {
    this.root.visible = false;
    this.knock = 0;
  }
}

export { clamp };
