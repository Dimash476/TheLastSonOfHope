import * as THREE from 'three';
import { groundHeight } from '../world/layout.js';

// Лазер из глаз (удерживать Z): два раскалённых луча от глаз героя в точку прицела.
// Луч «шагает» вдоль направления камеры до первого препятствия: здание (плавит секцию),
// земля (оставляет подпалину), машина (взрывается), вертолёт (сбит), деревья и фонари.
// Людей не ранит — только пугает. Все тяжёлые эффекты — с частотой ~8 раз в секунду.

const RANGE = 1200;
const STEP = 2.0;
const DPS = 650;          // урон по зданию в секунду
const CAR_DPS = 260;
const CHARGE_T = 0.85;    // накопление энергии, с
const RAMP_T = 1.1;       // нарастание мощности после выстрела, с
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _left = new THREE.Vector3();
const Z = new THREE.Vector3(0, 0, 1);

export class EyeLaser {
  constructor(scene, world) {
    this.world = world;
    this.charge = 0;          // накопление 0..1
    this.power = 0;           // мощность луча 0..1
    this.lit = false;         // луч выпущен
    this.front = 0;           // сколько метров пролетел фронт луча
    this.t = 0;
    this.tick = 0;            // таймер «тяжёлых» эффектов
    this.acc = 0;             // накопленный урон по текущей секции
    this.accSeg = null;
    this.lastScorch = new THREE.Vector3(1e9, 0, 0);
    this.hit = new THREE.Vector3();
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);

    const mk = (color, opacity) => new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    });
    // Цилиндр длиной 1 вдоль +Z, начало в 0 — растягиваем на длину луча
    const tube = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true).translate(0, 0.5, 0).rotateX(Math.PI / 2);
    const coreMat = this.coreMat = mk(new THREE.Color(5, 2.2, 1.6), 1);
    const glowMat = this.glowMat = mk(new THREE.Color(3, 0.25, 0.12), 0.45);
    this.beams = [0, 1].map(() => {
      const core = new THREE.Mesh(tube, coreMat), glow = new THREE.Mesh(tube, glowMat);
      core.frustumCulled = glow.frustumCulled = false;
      this.group.add(core, glow);
      return { core, glow };
    });
    const ball = new THREE.SphereGeometry(1, 12, 8);
    this.eyeGlow = [0, 1].map(() => { const m = new THREE.Mesh(ball, mk(new THREE.Color(4, 0.6, 0.35), 0.9)); this.group.add(m); return m; });
    this.hitGlow = new THREE.Mesh(ball, mk(new THREE.Color(5, 1.6, 0.7), 0.85));
    this.hitHalo = new THREE.Mesh(ball, mk(new THREE.Color(2.5, 0.3, 0.1), 0.35));
    this.group.add(this.hitGlow, this.hitHalo);
  }

  // Положение глаз в мире (по кости головы модели)
  eyes(player, outL, outR) {
    const model = player.model;
    const head = model.skinned ? model.skinned.bone('Head') : null;
    if (head) head.getWorldPosition(_v);
    else _v.copy(player.pos).add(_v2.set(0, 1.65, 0));
    model.group.getWorldQuaternion(_q);
    _fwd.set(0, 0, 1).applyQuaternion(_q);
    _up.set(0, 1, 0).applyQuaternion(_q);
    _left.set(1, 0, 0).applyQuaternion(_q);
    const base = _v.addScaledVector(_up, 0.085).addScaledVector(_fwd, 0.1);
    outL.copy(base).addScaledVector(_left, 0.033);
    outR.copy(base).addScaledVector(_left, -0.033);
  }

  // Ищем первое препятствие вдоль луча
  trace(origin, dir) {
    const W = this.world, city = W.city;
    let dist = RANGE, seg = null, ground = false;
    for (let d = 1.5; d < RANGE; d += STEP) {
      _v.copy(origin).addScaledVector(dir, d);
      const s = city.segAt(_v, 0.3);
      if (s) { dist = d; seg = s; break; }
      if (_v.y <= groundHeight(_v.x, _v.z)) { dist = d; ground = true; break; }
    }
    // Машины и вертолёт — ближе ли они, чем найденная точка
    let car = null, heli = false;
    for (const c of W.traffic.cars) {
      if (c.state === 'none' || c.state === 'held') continue;
      _v2.copy(c.pos).setY(c.pos.y + 0.8).sub(origin);
      const along = _v2.dot(dir);
      if (along < 1 || along > dist) continue;
      if (_v2.addScaledVector(dir, -along).lengthSq() < 2.4 * 2.4) { dist = along; car = c; seg = null; ground = false; }
    }
    const H = W.air?.heli;
    if (H && H.g.visible && (H.state === 'orbit' || H.state === 'patrol')) {
      _v2.copy(H.g.position).sub(origin);
      const along = _v2.dot(dir);
      if (along > 1 && along < dist && _v2.addScaledVector(dir, -along).lengthSq() < 16) { dist = along; heli = true; car = null; seg = null; ground = false; }
    }
    // Босс
    const B = W.boss?.rayHit(origin, dir, dist);
    if (B) return { dist: B.dist, seg: null, ground: false, car: null, heli: false, boss: true };
    return { dist, seg, ground, car, heli };
  }

  update(dt, firing, aimDir, player) {
    const W = this.world;
    // Фазы: накопление энергии в глазах → вспышка, луч «вылетает» к цели → мощность нарастает.
    // Отпустили Z на зарядке — энергия рассеивается без выстрела.
    if (firing) {
      if (!this.lit) {
        this.charge = Math.min(1, this.charge + dt / CHARGE_T);
        if (this.charge >= 1) {
          this.lit = true;
          this.front = 0;
          W.audio?.laserIgnite();
        }
      } else this.power = Math.min(1, this.power + dt / RAMP_T);
    } else {
      this.lit = false;
      this.charge = Math.max(0, this.charge - dt * 3);
      this.power = Math.max(0, this.power - dt * 4);
    }
    this.t += dt;
    const P = this.power * this.power * (3 - 2 * this.power); // плавное нарастание
    const beamOn = this.lit || this.power > 0.01;
    // Глаза: на зарядке пульсируют всё чаще, при выстреле — ровный яркий свет
    const pulse = 0.65 + 0.35 * Math.sin(this.t * (8 + 45 * this.charge));
    const eyeK = Math.max(this.charge * this.charge * pulse, beamOn ? 0.5 + 0.5 * P : 0);
    player.model.setEyeGlow?.(eyeK);
    W.audio?.setLaser(this.lit ? 1 : this.charge, beamOn ? Math.max(0.15, P) * (this.lit ? 1 : this.power) : 0);
    if (eyeK < 0.02 && !beamOn) { this.group.visible = false; this.accSeg = null; this.acc = 0; return; }
    this.group.visible = true;

    const eL = new THREE.Vector3(), eR = new THREE.Vector3();
    this.eyes(player, eL, eR);
    const mid = eL.clone().add(eR).multiplyScalar(0.5);
    const dir = aimDir.clone().normalize();
    const res = this.lit ? this.trace(mid, dir) : { dist: this.hit.distanceTo(mid) };
    if (this.lit) this.hit.copy(mid).addScaledVector(dir, res.dist);

    // Зарядка: искры срываются с глаз
    if (!beamOn && this.charge > 0.3 && Math.random() < this.charge * 0.6) {
      W.sparks.burst(Math.random() < 0.5 ? eL : eR, 1, { size: [0.03, 0.08], speed: 1.5, life: [0.08, 0.2], color: 0xff5030, gravity: 0 });
    }
    if (this.lit && this.front === 0) W.effects.flash?.(mid, 3);
    // Фронт луча летит к цели
    this.front = this.lit ? this.front + 900 * dt : this.front;
    const reach = Math.min(res.dist, Math.max(this.front, 0.1));
    const arrived = this.lit && this.front >= res.dist;

    // Цвет: тёмно-красный → раскалённо-белый по мощности; ширина растёт и «дышит»
    this.coreMat.color.setRGB(3 + 2 * P, 0.35 + 1.9 * P, 0.2 + 1.4 * P);
    this.glowMat.opacity = 0.25 + 0.3 * P;
    const w = beamOn ? (0.22 + 0.78 * P) * (1 + (0.1 + 0.15 * P) * Math.sin(this.t * 60) + 0.08 * Math.sin(this.t * 23)) : 0;
    [eL, eR].forEach((e, i) => {
      const b = this.beams[i];
      const end = _v2.copy(mid).addScaledVector(dir, reach);
      const len = Math.max(0.1, e.distanceTo(end));
      for (const m of [b.core, b.glow]) {
        m.visible = beamOn;
        m.position.copy(e);
        m.quaternion.setFromUnitVectors(Z, _v.subVectors(end, e).normalize());
      }
      b.core.scale.set(0.022 * w, 0.022 * w, len);
      b.glow.scale.set(0.09 * w, 0.09 * w, len);
      this.eyeGlow[i].position.copy(e);
      this.eyeGlow[i].scale.setScalar(beamOn ? 0.035 * (0.6 + 0.4 * P) : 0.012 + 0.03 * this.charge * pulse);
    });
    const hs = Math.min(3, 0.25 + res.dist * 0.004) * (0.3 + 0.7 * P);
    this.hitGlow.position.copy(this.hit);
    this.hitGlow.scale.setScalar(hs * (0.8 + 0.3 * Math.random()));
    this.hitHalo.position.copy(this.hit);
    this.hitHalo.scale.setScalar(hs * 2.6);
    this.hitGlow.visible = this.hitHalo.visible = beamOn && arrived && res.dist < RANGE - 1;
    if (!arrived || res.dist >= RANGE - 1) return;

    // ---- воздействие
    const p = this.hit.clone();
    const dmg = Math.pow(P, 1.5);
    if (Math.random() < 0.3 + 0.5 * P) W.sparks.burst(p, 3, { size: [0.15, 0.45], speed: 12, life: [0.2, 0.6], color: 0xffb070, gravity: 20 });
    if (res.seg) {
      if (this.accSeg !== res.seg) { this.accSeg = res.seg; this.acc = 0; }
      this.acc += DPS * dmg * dt;
    } else if (res.boss) W.boss.takeHit(DPS * 0.5 * dmg * dt, p, dir, 'laser', W.boss.rayHit(this.hit.clone().addScaledVector(dir, -3), dir, 6)?.cap);
    else if (res.car) W.traffic.damageCar(res.car, CAR_DPS * dmg * dt);
    else if (res.heli && P > 0.5) W.air.crashHeli(dir.clone().multiplyScalar(15));

    this.tick -= dt;
    if (this.tick > 0) return;
    this.tick = 0.12;
    if (res.seg && this.acc > 1) {
      // Плавим секцию: урон порциями, подпалина на стене
      const s = res.seg;
      const n = W.city.faceNormal(s, p);
      W.city.damage(s, this.acc, p, n.clone().negate(), 4);
      this.acc = 0;
      W.dust.burst(p, 2, { size: [1.5, 3.5], speed: 3, life: [1, 2.5], color: 0x3a3634, rise: 1.5 });
      if (Math.random() < 0.08) W.fire.add(p.clone().addScaledVector(n, 0.5), { size: 0.7, life: 8 });
    } else if (res.ground) {
      if (p.distanceTo(this.lastScorch) > 1.6) { W.effects.crater?.(p, 1.2); this.lastScorch.copy(p); }
      W.dust.burst(p, 2, { size: [1, 2.5], speed: 4, life: [0.6, 1.4], color: 0x4a4440 });
    }
    // Деревья и фонари у точки попадания, люди и птицы пугаются
    W.trees?.hit(p, 1.2, dir.clone().multiplyScalar(20));
    W.props?.hit(p, 0.8, dir.clone().multiplyScalar(20), 40);
    W.street?.impulse(p, 2, 12);
    W.people?.scareAround?.(p, 30);
    W.air?.scareBirds?.(p, 120);
  }
}
