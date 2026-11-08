import * as THREE from 'three';
import { groundHeight } from '../world/layout.js';

// Лазер из глаз (удерживать Z): два раскалённых луча от глаз героя в точку прицела.
// Луч «шагает» вдоль направления камеры до первого препятствия: здание (плавит секцию),
// земля (оставляет подпалину), машина (взрывается), вертолёт (сбит), деревья и фонари.
// Людей не ранит — только пугает. Все тяжёлые эффекты — с частотой ~8 раз в секунду.
// Z + ЛКМ — усиление, пока держишь: плотный красный поток извивается и бьёт сильнее, звук грубее и плотнее.

const RANGE = 1200;
const STEP = 2.0;
const DPS = 650;          // урон по зданию в секунду
const CAR_DPS = 260;
const CHARGE_T = 0.85;    // накопление энергии, с
const RAMP_T = 1.1;       // нарастание мощности после выстрела, с
const BOOST_DMG = 1.6;    // усиленный луч бьёт во столько раз сильнее
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _left = new THREE.Vector3();
const Z = new THREE.Vector3(0, 0, 1);

export class EyeLaser {
  // orange — луч героя: обычный оранжевый, усиленный красный. Без него — раскалённо-белый луч генерала
  constructor(scene, world, { orange = false } = {}) {
    this.world = world;
    this.hue = orange
      ? { g: [0.3, 1.1], b: [0.05, 0.15], glow: [3, 0.7, 0.06] }
      : { g: [0.35, 1.9], b: [0.2, 1.4], glow: [3, 0.25, 0.12] };
    this.charge = 0;          // накопление 0..1
    this.power = 0;           // мощность луча 0..1
    this.boost = 0;           // усиление 0..1
    this.kicked = false;      // удар от включения усиления уже был
    this.kickT = -1;
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
    // Оболочки луча. uSoft 0 — ровная трубка, больше — край мягко сходит на нет.
    // uWrithe — поток извивается и бугрится, волны бегут от глаз к цели. uRip — по нему бегут вспышки и спираль
    const shell = (color, opacity, blending = THREE.AdditiveBlending) => new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending, toneMapped: false,
      uniforms: { uColor: { value: color }, uOpacity: { value: opacity }, uSoft: { value: 0 }, uRip: { value: 0 }, uWrithe: { value: 0 }, uT: { value: 0 } },
      vertexShader: `uniform float uWrithe; uniform float uT; varying vec3 vN; varying vec3 vV; varying vec3 vAx; varying float vD; varying float vA;
        void main() {
          float d = position.z * length(modelMatrix[2].xyz), k = uWrithe * smoothstep(0.0, 5.0, d);
          vec3 p = position;
          p.xy *= 1.0 + k * (0.22 * sin(d * 0.31 - uT * 47.0) + 0.14 * sin(d * 0.83 - uT * 61.0));
          p.xy += k * 0.3 * vec2(sin(d * 0.19 - uT * 33.0), cos(d * 0.23 - uT * 39.0));
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vN = normalMatrix * normal; vV = -mv.xyz; vAx = normalMatrix * vec3(0.0, 0.0, 1.0); vD = d; vA = uv.x;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `uniform vec3 uColor; uniform float uOpacity; uniform float uSoft; uniform float uRip; uniform float uT; varying vec3 vN; varying vec3 vV; varying vec3 vAx; varying float vD; varying float vA;
        void main() {
          // Край считаем поперёк оси трубки: вдоль оси, из-за спины героя, луч иначе гаснет целиком
          vec3 V = normalize(vV), ax = normalize(vAx);
          float edge = pow(max(0.001, abs(dot(normalize(vN), normalize(V - ax * dot(V, ax) + vec3(0.0001))))), uSoft);
          float run = (0.72 + 0.28 * sin(vD * 1.7 - uT * 70.0)) * (0.8 + 0.2 * sin(vD * 0.6 - uT * 31.0));
          float spiral = smoothstep(0.2, 1.0, sin(vA * 18.85 + vD * 0.9 - uT * 85.0));
          vec3 col = uColor * (1.0 + uRip * (spiral * 1.2 + (run - 0.7) * 1.5));
          gl_FragColor = vec4(col, uOpacity * edge * mix(1.0, (0.55 + 0.45 * run) * smoothstep(0.0, 1.5, vD), uRip));
        }`,
    });
    // Цилиндр длиной 1 вдоль +Z, начало в 0 — растягиваем на длину луча. Кольца гуще у глаз: там поток извивается плавно
    const tube = new THREE.CylinderGeometry(1, 1, 1, 12, 90, true).translate(0, 0.5, 0).rotateX(Math.PI / 2);
    const rings = tube.attributes.position;
    for (let i = 0; i < rings.count; i++) rings.setZ(i, rings.getZ(i) * rings.getZ(i));
    const coreMat = this.coreMat = shell(new THREE.Color(5, 2.2, 1.6), 1);
    const glowMat = this.glowMat = shell(new THREE.Color(3, 0.25, 0.12), 0.45);
    // Плотное тело усиленного луча: не прибавляется к фону, а закрывает его, поэтому остаётся красным и над светлым городом
    const rageMat = this.rageMat = shell(new THREE.Color(2, 0.01, 0.005), 0, THREE.NormalBlending);
    rageMat.uniforms.uSoft.value = 0.45;
    rageMat.uniforms.uRip.value = 1;
    this.beams = [0, 1].map(() => {
      const core = new THREE.Mesh(tube, coreMat), glow = new THREE.Mesh(tube, glowMat), rage = new THREE.Mesh(tube, rageMat);
      core.frustumCulled = glow.frustumCulled = rage.frustumCulled = false;
      rage.renderOrder = 1;
      glow.renderOrder = 2;
      core.renderOrder = 3;
      this.group.add(core, glow, rage);
      return { core, glow, rage };
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

  update(dt, firing, aimDir, player, boosted = false) {
    const W = this.world;
    // Усиление раскрывается быстро и спадает чуть медленнее
    const hard = firing && boosted;
    this.boost += ((hard ? 1 : 0) - this.boost) * (1 - Math.exp(-(hard ? 9 : 5) * dt));
    const B = this.boost;
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
      } else this.power = Math.min(1, this.power + (1 + 2 * B) * dt / RAMP_T);
    } else {
      this.lit = false;
      this.charge = Math.max(0, this.charge - dt * 3);
      this.power = Math.max(0, this.power - dt * 4);
    }
    this.t += dt;
    // Включил усиление — поток вспыхивает, как второй выстрел
    const kick = hard && this.lit;
    if (kick && !this.kicked && this.t - this.kickT > 0.3) {
      this.kickT = this.t;
      W.audio?.laserBoostHit?.();
    }
    this.kicked = kick;
    const P = this.power * this.power * (3 - 2 * this.power); // плавное нарастание
    const beamOn = this.lit || this.power > 0.01;
    // Глаза: на зарядке пульсируют всё чаще, при выстреле — ровный яркий свет
    const pulse = 0.65 + 0.35 * Math.sin(this.t * (8 + 45 * this.charge));
    const eyeK = Math.max(this.charge * this.charge * pulse, beamOn ? 0.5 + 0.5 * P : 0);
    player.model.setEyeGlow?.(eyeK);
    W.audio?.setLaserBoost?.(B);
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

    // Цвет: тёмно-красный → раскалённо-белый по мощности; ширина растёт и «дышит».
    // Усиленный: сердцевина раскалена докрасна, не добела, вокруг неё жар и плотное красное тело,
    // а весь поток извивается, и ширина рвётся без всякого ритма
    const flare = B * Math.max(0, 1 - (this.t - this.kickT) / 0.25);
    const c = this.hue, keep = 1 - B;
    this.coreMat.uniforms.uColor.value.setRGB((3 + 2 * P) * (1 + 0.1 * B + 0.8 * flare), (c.g[0] + c.g[1] * P) * keep + 0.13 * B, (c.b[0] + c.b[1] * P) * keep + 0.06 * B);
    this.coreMat.uniforms.uSoft.value = 1.2 * B;
    this.glowMat.uniforms.uColor.value.setRGB(c.glow[0] * keep + 2.2 * B, c.glow[1] * keep + 0.02 * B, c.glow[2] * keep + 0.01 * B);
    this.glowMat.uniforms.uOpacity.value = 0.25 + 0.3 * P + 0.15 * B;
    this.glowMat.uniforms.uSoft.value = 1.2 * B;
    this.rageMat.uniforms.uOpacity.value = B * (0.9 + 0.1 * Math.random());
    for (const m of [this.coreMat, this.glowMat, this.rageMat]) {
      m.uniforms.uT.value = this.t;
      m.uniforms.uWrithe.value = B;
    }
    const rip = (1 + B * (0.5 * (Math.random() - 0.5) + 0.12 * Math.sin(this.t * 97))) * (1 + 0.7 * flare);
    const w = beamOn ? (0.22 + 0.78 * P) * (1 + (0.1 + 0.15 * P) * Math.sin(this.t * 60) + 0.08 * Math.sin(this.t * 23)) * rip : 0;
    [eL, eR].forEach((e, i) => {
      const b = this.beams[i];
      const end = _v2.copy(mid).addScaledVector(dir, reach);
      const len = Math.max(0.1, e.distanceTo(end));
      for (const m of [b.core, b.glow, b.rage]) {
        m.visible = beamOn;
        m.position.copy(e);
        m.quaternion.setFromUnitVectors(Z, _v.subVectors(end, e).normalize());
      }
      const cw = 0.022 * w * (1 + 3 * B), gw = 0.09 * w * (1 + 3 * B), rw = 0.09 * w * (1 + 4 * B);
      b.core.scale.set(cw, cw, len);
      b.glow.scale.set(gw, gw, len);
      b.rage.scale.set(rw, rw, len);
      b.rage.visible = beamOn && B > 0.02;
      this.eyeGlow[i].position.copy(e);
      this.eyeGlow[i].material.color.setRGB(4 + 3 * B, 0.6 - 0.48 * B, 0.35 - 0.28 * B);
      this.eyeGlow[i].scale.setScalar((beamOn ? 0.035 * (0.6 + 0.4 * P) : 0.012 + 0.03 * this.charge * pulse) * (1 + 1.8 * B));
    });
    // С луча срываются искры
    if (beamOn && B > 0.2) {
      const near = Math.min(reach, 70);
      for (let i = 0; i < 2; i++) {
        const a = Math.random();
        W.sparks.burst(_v2.copy(mid).addScaledVector(dir, a * a * near), 1, { size: [0.03, 0.1 + 0.08 * B], speed: 5 + 7 * B, life: [0.08, 0.28], color: 0xff2a12, gravity: 0 });
      }
    }
    const hs = Math.min(3, 0.25 + res.dist * 0.004) * (0.3 + 0.7 * P) * (1 + 1.1 * B);
    this.hitGlow.material.color.setRGB(5 + 3 * B, 1.6 - 1.1 * B, 0.7 - 0.5 * B);
    this.hitHalo.material.color.setRGB(2.5 + 1.5 * B, 0.3 - 0.22 * B, 0.1 - 0.07 * B);
    this.hitHalo.material.opacity = 0.35 + 0.3 * B;
    this.hitGlow.position.copy(this.hit);
    this.hitGlow.scale.setScalar(hs * (0.8 + 0.3 * Math.random()));
    this.hitHalo.position.copy(this.hit);
    this.hitHalo.scale.setScalar(hs * 2.6);
    this.hitGlow.visible = this.hitHalo.visible = beamOn && arrived && res.dist < RANGE - 1;
    if (!arrived || res.dist >= RANGE - 1) return;

    // ---- воздействие
    const p = this.hit.clone();
    const dmg = Math.pow(P, 1.5) * (1 + (BOOST_DMG - 1) * B);
    if (Math.random() < 0.3 + 0.5 * P + 0.3 * B) W.sparks.burst(p, Math.round(3 + 9 * B), { size: [0.15, 0.45 + 0.4 * B], speed: 12 + 24 * B, life: [0.2, 0.6 + 0.3 * B], color: B > 0.4 ? 0xff4a20 : 0xffb070, gravity: 20 });
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
      W.dust.burst(p, 2 + Math.round(3 * B), { size: [1.5, 3.5 + 2.5 * B], speed: 3 + 6 * B, life: [1, 2.5], color: 0x3a3634, rise: 1.5 });
      if (Math.random() < 0.08 + 0.2 * B) W.fire.add(p.clone().addScaledVector(n, 0.5), { size: 0.7, life: 8 });
    } else if (res.ground) {
      if (p.distanceTo(this.lastScorch) > 1.6 + 1.4 * B) { W.effects.crater?.(p, 1.2 + 1.6 * B); this.lastScorch.copy(p); }
      W.dust.burst(p, 2 + Math.round(4 * B), { size: [1, 2.5 + 2 * B], speed: 4 + 9 * B, life: [0.6, 1.4], color: 0x4a4440 });
    }
    if (B > 0.3) W.effects.flash?.(p, 8 + 10 * B);
    // Деревья и фонари у точки попадания, люди и птицы пугаются
    W.trees?.hit(p, 1.2, dir.clone().multiplyScalar(20));
    W.props?.hit(p, 0.8, dir.clone().multiplyScalar(20), 40);
    W.street?.impulse(p, 2, 12);
    W.people?.scareAround?.(p, 30);
    W.air?.scareBirds?.(p, 120);
  }
}
