import * as THREE from 'three';
import { groundHeight, LANDMARK } from '../world/layout.js';
import { clamp, damp, lerp, smoothstep } from '../utils.js';

// Колосс — босс режима «Битва»: каменный великан ~45 м с магмой в трещинах.
// Модель собрана из простых фигур на «суставах» (группы), анимация процедурная:
// ходьба, удары кулаком, удар о землю с ударной волной, бросок скалы, луч из глаз,
// взрыв ядра. Попадания героя считаются по капсулам вдоль костей.
//
// Три фазы (по запасу сил): с каждой Колосс быстрее и злее, во второй — луч из глаз,
// в третьей — взрыв ядра. Накопив урон, он падает на колено — ядро на груди открыто.

const S = 32;   // масштаб модели (~2.25 м → ~72 м)
const K = S / 20;   // множитель дистанций (атаки настраивались под рост 45 м)
export const TITAN = {
  hp: 42000,
  walk: 14,              // м/с
  engage: 420,           // ближе этого (по горизонтали) Колосс дерётся с героем, дальше — крушит город
  poiseMax: 3600,        // столько урона за короткое время — и он падает на колено
};

const UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _c1 = new THREE.Vector3(), _c2 = new THREE.Vector3();
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _h = new THREE.Vector3(), _e = new THREE.Vector3();
const Z = new THREE.Vector3(0, 0, 1);
const X = new THREE.Vector3(1, 0, 0);
const ss = smoothstep;
// Окно: нарастает на [a, b], спадает на [c, d]
const win = (t, a, b, c, d) => ss(a, b, t) * (1 - ss(c, d, t));
const wrapA = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// Ближайшие точки двух отрезков (p1q1 и p2q2) → c1, c2; возвращает квадрат расстояния
function segSeg(p1, q1, p2, q2, c1, c2) {
  const d1 = _a.subVectors(q1, p1), d2 = _b.subVectors(q2, p2), r = _c.subVectors(p1, p2);
  const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r);
  let s = 0, t = 0;
  if (a <= 1e-8 && e <= 1e-8) { s = t = 0; } else if (a <= 1e-8) { t = clamp(f / e, 0, 1); } else {
    const c = d1.dot(r);
    if (e <= 1e-8) { s = clamp(-c / a, 0, 1); } else {
      const b = d1.dot(d2), den = a * e - b * b;
      s = den > 1e-8 ? clamp((b * f - c * e) / den, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); } else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  c1.copy(p1).addScaledVector(d1, s);
  c2.copy(p2).addScaledVector(d2, t);
  return c1.distanceToSquared(c2);
}

// «Каменная» поверхность: вершины чуть смещены по псевдослучайной функции положения
// (совпадающие вершины смещаются одинаково — без щелей)
function rocky(geo, amp, seed = 1) {
  const p = geo.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const h = Math.sin(v.x * 37.1 + seed) * Math.sin(v.y * 29.7 + seed * 2.1) * Math.sin(v.z * 33.3 + seed * 0.7)
      + 0.5 * Math.sin(v.x * 91.3 + v.z * 57.1 + seed * 3.3);
    v.multiplyScalar(1 + amp * h);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

const KEYS = ['hips', 'spine', 'chest', 'neck', 'shL', 'elL', 'haL', 'shR', 'elR', 'haR', 'hpL', 'knL', 'anL', 'hpR', 'knR', 'anR'];
const NEUTRAL = {
  hips: [0, 0, 0], spine: [0.1, 0, 0], chest: [0.22, 0, 0], neck: [-0.3, 0, 0],
  shL: [0.05, 0, 0.22], elL: [-0.35, 0, 0], haL: [0, 0, 0],
  shR: [0.05, 0, -0.22], elR: [-0.35, 0, 0], haR: [0, 0, 0],
  hpL: [-0.05, 0, 0.05], knL: [0.1, 0, 0], anL: [0, 0, 0],
  hpR: [-0.05, 0, -0.05], knR: [0.1, 0, 0], anR: [0, 0, 0],
};
function mix(R, k, x, y, z, w) {
  if (w <= 0) return;
  const r = R[k];
  r[0] = lerp(r[0], x, w); r[1] = lerp(r[1], y, w); r[2] = lerp(r[2], z, w);
}

export class Titan {
  constructor(scene, world, battle) {
    this.scene = scene;
    this.world = world;
    this.battle = battle;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.R = {};
    for (const k of KEYS) this.R[k] = [0, 0, 0];
    this.rocks = [];
    this.waves = [];
    this.prevHero = new THREE.Vector3();
    this.cm = new THREE.Vector3();      // центр масс (таз) — вокруг него вращается тело в полёте
    this.liftP = new THREE.Vector3();
    this.liftYaw = 0;
    this.meteors = [];
    this.build();
    this.root.visible = false;
    scene.add(this.root);
  }

  // ================================================================ модель
  build() {
    const rockMat = this.rockMat = new THREE.MeshStandardMaterial({ color: 0x2f2925, roughness: 0.93, metalness: 0.05, flatShading: true });
    const plate = this.plateMat = new THREE.MeshStandardMaterial({ color: 0x4a423b, roughness: 0.68, metalness: 0.35, flatShading: true });
    const magma = this.magmaMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.9, 0.25) });
    const core = this.coreMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 2, 0.6) });
    const eye = this.eyeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 3, 0.8) });
    const J = this.j = {};
    const P = this.pts = {};
    const joint = (name, parent, x, y, z) => { const g = new THREE.Group(); g.position.set(x, y, z); parent.add(g); J[name] = g; P[name] = g; return g; };
    const mark = (name, parent, x, y, z) => { const g = new THREE.Object3D(); g.position.set(x, y, z); parent.add(g); P[name] = g; return g; };
    const mesh = (parent, geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
      m.castShadow = mat !== magma && mat !== core && mat !== eye;
      parent.add(m);
      return m;
    };
    const box = (w, h, d, amp = 0.08, seed = 1) => rocky(new THREE.BoxGeometry(w, h, d, 3, 3, 3), amp, seed);
    const caps = (r, len, amp = 0.08, seed = 1) => rocky(new THREE.CapsuleGeometry(r, len, 4, 9), amp, seed);
    const ball = (r, amp = 0.12, seed = 1) => rocky(new THREE.IcosahedronGeometry(r, 1), amp, seed);
    const cone = (r, h) => rocky(new THREE.ConeGeometry(r, h, 5, 2), 0.1, 4);
    const vein = (parent, len, w, x, y, z, rx = 0, ry = 0, rz = 0) => mesh(parent, new THREE.BoxGeometry(w, len, w * 0.6), magma, x, y, z, rx, ry, rz);

    this.root = new THREE.Group();
    this.body = new THREE.Group();
    this.body.scale.setScalar(S);
    this.root.add(this.body);

    // Таз и корпус: сгорбленный, широкие плечи, маленькая голова
    const hips = joint('hips', this.body, 0, 1.1, 0);
    mesh(hips, box(0.5, 0.26, 0.32, 0.08, 2), rockMat);
    mesh(hips, box(0.56, 0.08, 0.37, 0.04, 3), plate, 0, -0.04, 0);
    mesh(hips, box(0.2, 0.22, 0.05, 0.06, 4), plate, 0, -0.18, 0.15, -0.15);
    const spine = joint('spine', hips, 0, 0.12, 0);
    mesh(spine, caps(0.2, 0.12, 0.08, 5), rockMat, 0, 0.12, 0);
    vein(spine, 0.22, 0.018, 0.1, 0.12, 0.17, 0, 0, 0.4);
    vein(spine, 0.18, 0.015, -0.08, 0.1, 0.18, 0, 0, -0.5);
    const chest = joint('chest', spine, 0, 0.26, 0);
    mesh(chest, box(0.8, 0.5, 0.46, 0.07, 6), rockMat, 0, 0.24, 0.02);
    for (const s of [-1, 1]) {
      mesh(chest, box(0.32, 0.2, 0.08, 0.06, 7 + s), plate, s * 0.18, 0.33, 0.24, -0.15, s * 0.2, 0);
      mesh(chest, ball(0.21, 0.15, 9 + s), plate, s * 0.45, 0.44, 0).scale.set(1.1, 0.8, 1);
      mesh(chest, cone(0.07, 0.3), rockMat, s * 0.16, 0.4, -0.22, -0.8, 0, s * 0.2);
      mesh(chest, cone(0.06, 0.24), rockMat, s * 0.27, 0.2, -0.2, -0.9, 0, s * 0.3);
      vein(chest, 0.3, 0.02, s * 0.16, 0.12, 0.25, 0, 0, s * 0.9);
      vein(chest, 0.22, 0.016, s * 0.3, 0.3, 0.2, 0, 0, s * 0.3);
    }
    mesh(chest, cone(0.08, 0.34), rockMat, 0, 0.3, -0.25, -0.9, 0, 0);
    // Ядро: светится сквозь кольцо брони — главная уязвимая точка
    this.coreMesh = mesh(chest, new THREE.IcosahedronGeometry(0.085, 1), core, 0, 0.2, 0.26);
    mesh(chest, new THREE.TorusGeometry(0.11, 0.028, 6, 14), plate, 0, 0.2, 0.26);
    mark('core', chest, 0, 0.2, 0.27);
    mark('chestC', chest, 0, 0.24, 0);
    // Голова: тяжёлый лоб, челюсть, рога назад, светящиеся щели глаз
    const neck = joint('neck', chest, 0, 0.5, 0.06);
    mesh(neck, box(0.24, 0.25, 0.27, 0.1, 11), rockMat, 0, 0.11, 0.04);
    mesh(neck, box(0.28, 0.06, 0.09, 0.06, 12), plate, 0, 0.17, 0.17);
    mesh(neck, box(0.2, 0.08, 0.2, 0.08, 13), rockMat, 0, 0.0, 0.08);
    for (const s of [-1, 1]) {
      mesh(neck, new THREE.BoxGeometry(0.06, 0.02, 0.02), eye, s * 0.06, 0.13, 0.185, 0, 0, s * -0.2);
      mesh(neck, cone(0.035, 0.18), rockMat, s * 0.1, 0.25, -0.03, -0.5, 0, s * -0.5);
    }
    mark('eyes', neck, 0, 0.13, 0.2);
    mark('headTop', neck, 0, 0.27, 0.04);
    // Руки: короткое плечо, огромное предплечье, кулак-глыба
    for (const s of [1, -1]) {
      const L = s > 0 ? 'L' : 'R';
      const sh = joint('sh' + L, chest, s * 0.45, 0.38, 0);
      mesh(sh, caps(0.12, 0.2, 0.08, 14 + s), rockMat, 0, -0.17, 0);
      mesh(sh, box(0.2, 0.14, 0.22, 0.06, 15 + s), plate, s * 0.04, -0.06, 0);
      const el = joint('el' + L, sh, 0, -0.36, 0);
      mesh(el, caps(0.14, 0.18, 0.09, 16 + s), rockMat, 0, -0.17, 0);
      mesh(el, box(0.3, 0.12, 0.3, 0.06, 17 + s), plate, 0, -0.26, 0);
      vein(el, 0.24, 0.018, s * 0.08, -0.14, 0.11, 0.2, 0, 0.2 * s);
      vein(el, 0.2, 0.016, -s * 0.06, -0.12, 0.12, -0.15, 0, -0.3 * s);
      const ha = joint('ha' + L, el, 0, -0.34, 0);
      mesh(ha, box(0.21, 0.2, 0.21, 0.12, 18 + s), rockMat, 0, -0.09, 0.01);
      mesh(ha, box(0.22, 0.06, 0.08, 0.05, 19 + s), plate, 0, -0.14, 0.09);
      mark('fist' + L, ha, 0, -0.1, 0.01);
      // Сгусток жара в кулаке — предупреждение перед ударом
      const glow = new THREE.Mesh(new THREE.SphereGeometry(0.17, 14, 10), new THREE.MeshBasicMaterial({
        color: new THREE.Color(3, 1, 0.25), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      glow.position.set(0, -0.1, 0.01);
      ha.add(glow);
      this['glow' + L] = glow;
      // Ноги: толстые бёдра, бронированные голени, стопы-плиты
      const hp = joint('hp' + L, hips, s * 0.17, -0.06, 0);
      mesh(hp, caps(0.15, 0.22, 0.08, 20 + s), rockMat, 0, -0.23, 0);
      vein(hp, 0.24, 0.018, s * 0.05, -0.24, 0.14, 0.1, 0, 0.3 * s);
      const kn = joint('kn' + L, hp, 0, -0.48, 0);
      mesh(kn, ball(0.09, 0.15, 21 + s), plate, 0, 0, 0.1);
      mesh(kn, caps(0.13, 0.24, 0.08, 22 + s), rockMat, 0, -0.22, 0);
      mesh(kn, box(0.17, 0.3, 0.07, 0.06, 23 + s), plate, 0, -0.2, 0.11);
      const an = joint('an' + L, kn, 0, -0.46, 0);
      mesh(an, box(0.2, 0.1, 0.34, 0.08, 24 + s), rockMat, 0, -0.05, 0.07);
    }
    this.body.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });

    // Точки и капсулы попаданий (радиусы — в долях модели)
    this.wp = {};
    for (const k in P) this.wp[k] = new THREE.Vector3();
    this.caps = [
      { a: 'hips', b: 'neck', r: 0.31, mult: 1 },
      { a: 'neck', b: 'headTop', r: 0.17, mult: 1.3, head: true },
      { a: 'shL', b: 'elL', r: 0.14, mult: 1 }, { a: 'elL', b: 'haL', r: 0.16, mult: 1 }, { a: 'haL', b: 'fistL', r: 0.14, mult: 1 },
      { a: 'shR', b: 'elR', r: 0.14, mult: 1 }, { a: 'elR', b: 'haR', r: 0.16, mult: 1 }, { a: 'haR', b: 'fistR', r: 0.14, mult: 1 },
      { a: 'hpL', b: 'knL', r: 0.17, mult: 1 }, { a: 'knL', b: 'anL', r: 0.14, mult: 1 },
      { a: 'hpR', b: 'knR', r: 0.17, mult: 1 }, { a: 'knR', b: 'anR', r: 0.14, mult: 1 },
    ];
    for (const c of this.caps) c.r *= S;
    this.coreCap = { a: 'core', b: 'core', r: 0.12 * S, mult: 2, core: true };

    // Скала для броска: камень с раскалённой сердцевиной, видной сквозь трещины
    this.rockGeo = rocky(new THREE.IcosahedronGeometry(3.4, 1), 0.3, 31);
    this.rockCore = new THREE.IcosahedronGeometry(2.9, 1);

    // Луч из глаз (янтарный — не спутать с красным лазером героя)
    const tube = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true).translate(0, 0.5, 0).rotateX(Math.PI / 2);
    const add = (c, o) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    this.beamCore = new THREE.Mesh(tube, add(new THREE.Color(6, 4, 1.4), 1));
    this.beamGlow = new THREE.Mesh(tube, add(new THREE.Color(4, 1.2, 0.2), 0.45));
    this.beamHit = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), add(new THREE.Color(5, 2.4, 0.6), 0.8));
    for (const m of [this.beamCore, this.beamGlow, this.beamHit]) { m.visible = false; m.frustumCulled = false; this.scene.add(m); }
    // Сфера энергии взрыва ядра
    this.nova = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 18), add(new THREE.Color(3, 1, 0.25), 0.3));
    this.nova.visible = false;
    this.scene.add(this.nova);
  }

  // ================================================================ состояние
  get invulnerable() { return this.state === 'intro' || this.state === 'land' || this.state === 'roar' || this.state === 'dying' || this.state === 'dead'; }
  get alive() { return this.root.visible && this.state !== 'dying' && this.state !== 'dead'; }

  // Колосс падает с неба в точку at
  spawn(at) {
    this.hp = TITAN.hp;
    this.phase = 1;
    this.state = 'intro';
    this.stT = 0;
    this.t = 0;
    this.atk = null;
    this.cd = 2.5;
    this.novaCd = 4;
    this.beamCd = 0;
    this.poise = 0;
    this.flinch = 0;
    this.hitFlash = 0;
    this.walkK = 0;
    this.phi = 0;
    this.stepIdx = 0;
    this.sweepT = 0;
    this.scareT = 0;
    this.cityLoss = 0;
    this.goal = null;
    this.firstGoal = true;
    this.punchSide = 'R';
    this.glowK = 1;
    this.deflectHint = false;
    this.grabCd = 6; this.meteorCd = 4; this.chargeCd = 3; this.liftCd = 0;
    this.recoverT = 0;
    this.spin = 0;
    this.pos.set(at.x, groundHeight(at.x, at.z) + 1400, at.z);
    this.vel.set(0, -320, 0);
    this.yaw = Math.atan2(-at.x, -at.z);   // лицом к центру города
    this.clearProjectiles();
    this.body.rotation.set(0, 0, 0);
    this.root.visible = true;
    this.pose(1, true);
  }

  hide() {
    this.releaseHero();
    this.dropFromHero();
    this.root.visible = false;
    this.clearProjectiles();
  }

  clearProjectiles() {
    for (const r of this.rocks) this.scene.remove(r.mesh);
    this.rocks.length = 0;
    this.waves.length = 0;
    this.beamCore.visible = this.beamGlow.visible = this.beamHit.visible = false;
    this.nova.visible = false;
    for (const m of this.meteors) { this.scene.remove(m.mesh); this.scene.remove(m.ring); }
    this.meteors.length = 0;
  }

  // Разрушения, устроенные Колоссом, — в счёт урона городу
  smash(fn) {
    const city = this.world.city, before = city.destroyed;
    fn(city);
    this.cityLoss += city.destroyed - before;
  }

  sound(kind, k, p) {
    const a = this.world.audio;
    if (!a?.ctx) return;
    if (kind === 'roar') {
      const o = a.out(p);
      a.tone({ dur: 2.4, from: 92, to: 46, gain: 0.5 * k, type: 'sawtooth', dest: o });
      a.tone({ dur: 2.2, from: 61, to: 33, gain: 0.8 * k, type: 'triangle', dest: o });
      a.noiseBurst({ dur: 2.6, freq: 700, sweepTo: 160, type: 'bandpass', q: 0.8, gain: 0.9 * k, attack: 0.3, brown: true, dest: o });
      a.noiseBurst({ dur: 2.0, freq: 1500, sweepTo: 380, type: 'bandpass', q: 2, gain: 0.22 * k, attack: 0.2, dest: o });
    } else if (kind === 'step') a.boom(0.32 * k, p);
    else if (kind === 'hit') a.punch(k, 'concrete', p);
    else if (kind === 'boom') a.explosion(k, p);
  }

  // ================================================================ кадр
  update(dt, player) {
    if (!this.root.visible || !(dt > 0)) return;
    const W = this.world;
    this.t += dt;
    this.hitFlash = Math.max(0, this.hitFlash - dt * 4);
    this.liftCd -= dt;
    this.flinch = Math.max(0, this.flinch - dt * 2.5);
    this.poise = Math.max(0, this.poise - dt * 280);
    const gy = groundHeight(this.pos.x, this.pos.z);

    // ---- сценарий
    let move = 0, turnTo = null, turnRate = 1;
    if (this.state === 'intro') {
      this.pos.addScaledVector(this.vel, dt);
      const c = this.pos.clone().setY(this.pos.y + 1.2 * S);
      W.sparks.burst(c, 6, { size: [1.5, 4], speed: 20, life: [0.3, 0.8], color: 0xff8a30 });
      W.dust.burst(c, 2, { size: [10, 22], speed: 6, life: [1.5, 3], color: 0x2a2420 });
      if (this.pos.y <= gy) this.land(gy);
    } else if (this.state === 'land') {
      this.stT += dt;
      if (this.stT > 1.4) this.startRoar();
    } else if (this.state === 'roar') {
      const t0 = this.stT;
      this.stT += dt;
      if (t0 < 0.55 && this.stT >= 0.55) this.roarBlast(player);
      if (this.stT > 2.6) { this.state = 'fight'; this.cd = Math.min(this.cd, 1); }
    } else if (this.state === 'stagger') {
      this.stT += dt;
      if (this.stT > 4.2) { this.state = 'fight'; this.cd = 0.8; this.poise = 0; }
    } else if (this.state === 'dying') {
      const t0 = this.stT;
      this.stT += dt;
      if (t0 < 3.9 && this.stT >= 3.9) this.fallCrash();
      if (this.stT > 5.5) this.state = 'dead';
    } else if (this.state === 'lifted') {
      // Герой держит Колосса над головой; через несколько секунд тот вырывается
      this.stT += dt;
      this.cm.copy(this.liftP).addScaledVector(UP, 0.33 * S);
      this.yaw = this.liftYaw + Math.PI / 2;
      if (this.stT > 5) this.breakFree(player);
    } else if (this.state === 'thrown') {
      this.stT += dt;
      this.vel.y -= 22 * dt;
      this.cm.addScaledVector(this.vel, dt);
      this.body.rotation.x += this.spin * dt;
      // Летящее тело сносит здания на пути
      this.sweepT -= dt;
      if (this.sweepT <= 0) {
        this.sweepT = 0.05;
        const c = this.cm.clone(), v = this.vel.length();
        let n = 0;
        this.smash((city) => { n = city.damageRadius(c, 0.5 * S, 2500, 80, this.vel.clone().normalize()); });
        if (n) { this.vel.multiplyScalar(0.9); W.dust.burst(c, 6, { size: [8, 18], speed: 12, life: [2, 4] }); }
        if (v > 60) W.dust.burst(c, 2, { size: [6, 12], speed: 4, life: [1, 2], color: 0x5a5048 });
      }
      const gy2 = groundHeight(this.cm.x, this.cm.z);
      if (this.cm.y - 0.32 * S <= gy2 || this.stT > 12) this.crash(gy2);
    } else if (this.state === 'fight') {
      const r = this.think(dt, player);
      move = r.move; turnTo = r.turnTo; turnRate = r.turnRate;
    }

    // ---- поворот и шаг
    if (turnTo) {
      const want = Math.atan2(turnTo.x - this.pos.x, turnTo.z - this.pos.z);
      const d = wrapA(want - this.yaw);
      this.yaw += clamp(d, -turnRate * dt, turnRate * dt);
      if (Math.abs(d) > 0.9) move *= 0.3;
    }
    const spd = move * TITAN.walk * (1 + 0.12 * (this.phase - 1));
    if (this.state !== 'intro' && this.state !== 'lifted' && this.state !== 'thrown') {
      this.pos.x += Math.sin(this.yaw) * spd * dt;
      this.pos.z += Math.cos(this.yaw) * spd * dt;
      this.pos.y = groundHeight(this.pos.x, this.pos.z);
    }
    this.walkK = damp(this.walkK, spd > 0.5 ? 1 : 0, 4, dt);
    // Шаг ≈ 11 м: фаза цикла растёт с пройденным путём
    this.phi += dt * (spd > 0.5 ? spd : this.walkK * 2) / (22 * K) * Math.PI * 2;

    // ---- поза, кости, точки
    this.pose(dt);
    this.root.rotation.y = this.yaw;
    if (this.state === 'dying' || this.state === 'dead' || this.state === 'intro') this.root.position.copy(this.pos);
    else {
      // Тело вращается вокруг таза: корень ставим так, чтобы таз оказался в cm
      const hy = this.j.hips.position.y * S;
      if (this.state !== 'lifted' && this.state !== 'thrown') {
        _v.set(this.pos.x, this.pos.y + hy, this.pos.z);
        if (this.recoverT > 0) { this.recoverT -= dt; this.cm.lerp(_v, 1 - Math.exp(-4 * dt)); } else this.cm.copy(_v);
      }
      _v.set(0, hy, 0).applyAxisAngle(X, this.body.rotation.x).applyAxisAngle(UP, this.yaw);
      this.root.position.copy(this.cm).sub(_v);
    }
    this.root.updateMatrixWorld(true);
    for (const k in this.pts) this.pts[k].getWorldPosition(this.wp[k]);

    // ---- события: шаги, сметание зданий, атаки
    if (this.state === 'fight' || this.state === 'roar') this.footsteps(dt);
    if (this.atk) this.attackEvents(dt, player);
    this.updateRocks(dt, player);
    this.updateWaves(dt, player);
    this.updateMeteors(dt, player);
    if (this.state !== 'lifted' && this.state !== 'thrown' && !player.captured) this.collideHero(player);
    this.hitByThrown();
    this.scareT -= dt;
    if (this.scareT <= 0) { this.scareT = 1; W.people?.scareAround?.(this.pos, 260); W.air?.scareBirds?.(this.pos, 300); }

    // ---- свечение магмы: сильнее с каждой фазой, вспышка при попадании, гаснет после смерти
    const dead = this.state === 'dying' ? 1 - ss(3.5, 5.5, this.stT) : this.state === 'dead' ? 0 : 1;
    const novaK = this.atk?.type === 'nova' ? ss(0.6, 2.6, this.atk.t) * (this.atk.t < 2.6 ? 1 : 0) : 0;
    this.glowK = damp(this.glowK, ([1, 1.35, 1.8][this.phase - 1] + novaK * 2.5) * dead, 3, dt);
    const g = this.glowK, fl = this.hitFlash;
    const pulse = 0.85 + 0.15 * Math.sin(this.t * (3 + this.phase * 2));
    this.magmaMat.color.setRGB((3 + fl * 2) * g * pulse, (0.9 + fl * 2) * g * pulse, (0.25 + fl * 2) * g * pulse);
    const coreK = (this.state === 'stagger' ? 1.8 + 0.6 * Math.sin(this.t * 10) : 1) * g;
    this.coreMat.color.setRGB(5 * coreK, 2 * coreK, 0.6 * coreK);
    const eyeK = (this.atk?.type === 'beam' ? 1 + 1.5 * ss(0, 1.1, this.atk.t) : 1) * dead;
    this.eyeMat.color.setRGB(6 * eyeK, 3 * eyeK, 0.8 * eyeK);
    this.rockMat.emissive.setRGB(fl * 0.25, fl * 0.12, fl * 0.05);

    _h.copy(player.pos); _h.y += 1;
    this.prevHero.copy(_h);
  }

  // ================================================================ решение: драться или крушить город
  think(dt, player) {
    const hero = player.pos;
    const dx = hero.x - this.pos.x, dz = hero.z - this.pos.z, dh = Math.hypot(dx, dz);
    const heroGy = groundHeight(hero.x, hero.z);
    const alt = hero.y - heroGy;
    this.cd -= dt; this.novaCd -= dt; this.beamCd -= dt; this.grabCd -= dt; this.meteorCd -= dt; this.chargeCd -= dt;
    const out = { move: 0, turnTo: null, turnRate: 1 };

    if (this.atk) {
      // Во время замаха следит за героем, в момент удара — нет
      out.turnTo = hero;
      out.turnRate = this.atk.track ? 1.6 : 0;
      // Таран: бежит на героя, поворачивая медленно — можно увернуться
      if (this.atk.type === 'charge' && this.atk.t > 0.6 && this.atk.t < 3.0) { out.move = 5; out.turnRate = 0.45; }
      this.atk.t += dt * (1.15 + 0.2 * (this.phase - 1));
      if (this.atk.t >= this.atk.dur) { this.atk = null; this.cd = [1.3, 0.95, 0.6][this.phase - 1] + Math.random() * 0.4; }
      return out;
    }

    const engaged = dh < TITAN.engage && hero.y < 260 && !this.battle.heroDown;
    if (engaged) {
      out.turnTo = hero;
      out.turnRate = 1.1;
      if (this.cd <= 0) {
        const a = this.pickAttack(player, dh, alt);
        if (a) { this.startAttack(a, player); return out; }
      }
      out.move = dh > 26 * K ? 1 : 0;
    } else {
      // Герой далеко — Колосс идёт к самым высоким зданиям центра и сносит всё на пути
      const city = this.world.city;
      if (!this.goal || !city.segs[this.goal.segs[0]].alive || Math.hypot(this.goal.x - this.pos.x, this.goal.z - this.pos.z) < 14 * K) this.pickGoal();
      if (this.goal) { out.turnTo = _v.set(this.goal.x, 0, this.goal.z); out.move = 1; out.turnRate = 0.7; }
    }
    return out;
  }

  pickGoal() {
    const city = this.world.city;
    const cand = [];
    for (const b of city.buildings) {
      if (b.kind !== 'building' || !b.segs.length) continue;
      if (!city.segs[b.segs[0]].alive || Math.hypot(b.x, b.z) > 1000) continue;
      const top = city.segs[b.segs[b.segs.length - 1]];
      cand.push({ b, h: top.y0 + top.h, d: Math.hypot(b.x - this.pos.x, b.z - this.pos.z), dl: Math.hypot(b.x - LANDMARK.x, b.z - LANDMARK.z) });
    }
    if (!cand.length) { this.goal = null; return; }
    if (this.firstGoal) {
      // Сначала — к главному небоскрёбу
      this.firstGoal = false;
      cand.sort((p, q) => p.dl - q.dl);
    } else {
      cand.sort((p, q) => q.h - p.h);
      cand.length = Math.min(cand.length, 30);
      cand.sort((p, q) => p.d - q.d);
    }
    this.goal = cand[0].b;
  }

  pickAttack(player, dh, alt) {
    _h.copy(player.pos); _h.y += 1;
    const d3 = _h.distanceTo(this.wp.chestC);
    const r = Math.random();
    const front = (player.pos.x - this.pos.x) * Math.sin(this.yaw) + (player.pos.z - this.pos.z) * Math.cos(this.yaw) > 0;
    if (this.phase >= 3 && this.novaCd <= 0 && dh < 220 * K) return 'nova';
    if (this.grabCd <= 0 && d3 < 34 * K && r < 0.4) return 'grab';
    if (alt < 12 && dh < 0.6 * S) return 'stomp';
    if (d3 < 32 * K) return alt > 15 && front && Math.random() < 0.5 ? 'clap' : 'punch';
    if (alt < 14 && dh < 75 * K) return 'pound';
    if (this.phase >= 2 && this.meteorCd <= 0 && r < 0.35) return 'meteor';
    if (this.chargeCd <= 0 && dh > 90 && alt < 60 && r < 0.55) return 'charge';
    if (this.phase >= 2 && this.beamCd <= 0 && dh > 40 && Math.random() < 0.6) return 'beam';
    if (dh > 30 * K || alt > 45) return 'throw';
    return null;
  }

  startAttack(type, player) {
    const dur = { punch: 1.6, pound: 2.4, throw: 2.6, beam: 3.8, nova: 4.2, grab: 1.6, stomp: 1.7, clap: 1.6, meteor: 3.8, charge: 3.4 }[type];
    const A = this.atk = { type, t: 0, prev: 0, dur, track: true, ap: 0, taken: 0, hitHero: false, side: 'R' };
    if (type === 'grab') this.grabCd = 9;
    if (type === 'meteor') { this.meteorCd = 11; this.meteorT = 0; this.battle.banner('МАГМОВЫЙ ДОЖДЬ — НЕ СТОЙ НА МЕСТЕ!', 2); }
    if (type === 'charge') this.chargeCd = 8;
    if (type === 'punch' || type === 'grab') {
      // Бьёт рукой со стороны героя
      const lx = Math.cos(this.yaw), lz = -Math.sin(this.yaw);
      A.side = (player.pos.x - this.pos.x) * lx + (player.pos.z - this.pos.z) * lz > 0 ? 'L' : 'R';
    }
    if (type === 'beam') {
      this.beamCd = 5;
      // Луч начинает с земли между Колоссом и героем и «ползёт» к нему
      this.beamAim = new THREE.Vector3().lerpVectors(this.pos, player.pos, 0.45);
      this.beamAim.y = groundHeight(this.beamAim.x, this.beamAim.z);
      this.beamTick = 0;
    }
    if (type === 'nova') {
      this.novaCd = 12;
      this.battle.banner('КОЛОСС КОПИТ ЭНЕРГИЮ — ПРЕРВИ ИЛИ УЛЕТАЙ!');
    }
  }

  // ================================================================ поза
  pose(dt, snap = false) {
    const R = this.R;
    for (const k of KEYS) { const n = NEUTRAL[k]; R[k][0] = n[0]; R[k][1] = n[1]; R[k][2] = n[2]; }
    let hipsY = 1.1;
    const T = this.t, st = this.state, A = this.atk;
    const br = Math.sin(T * 1.4);
    R.chest[0] += 0.03 * br; R.shL[2] += 0.03 * br; R.shR[2] -= 0.03 * br;

    // Ходьба
    const w = this.walkK;
    if (w > 0.001) {
      const s = Math.sin(this.phi), c = Math.cos(this.phi);
      R.hpL[0] += -0.42 * s * w; R.hpR[0] += 0.42 * s * w;
      R.knL[0] += 0.75 * Math.max(0, c) * w; R.knR[0] += 0.75 * Math.max(0, -c) * w;
      R.shL[0] += 0.3 * s * w; R.shR[0] -= 0.3 * s * w;
      R.elL[0] -= 0.2 * Math.max(0, -s) * w; R.elR[0] -= 0.2 * Math.max(0, s) * w;
      R.chest[1] -= 0.1 * s * w; R.hips[1] += 0.08 * s * w; R.hips[2] += 0.04 * c * w;
      R.chest[0] += 0.08 * w;
      hipsY -= 0.05 * Math.abs(s) * w;
    }

    // Колено: падение с неба (сжался в комок), приземление, оглушение, первая часть смерти
    const kneel = (k) => {
      hipsY = lerp(hipsY, 0.72, k);
      mix(R, 'hpL', -1.25, 0, 0.05, k); mix(R, 'knL', 1.45, 0, 0, k);
      mix(R, 'hpR', 0.35, 0, -0.08, k); mix(R, 'knR', 1.75, 0, 0, k);
    };
    if (st === 'intro') {
      hipsY = 1.0;
      mix(R, 'hpL', -1.6, 0, 0.1, 1); mix(R, 'hpR', -1.6, 0, -0.1, 1);
      mix(R, 'knL', 1.9, 0, 0, 1); mix(R, 'knR', 1.9, 0, 0, 1);
      R.chest[0] = 0.8; R.spine[0] = 0.4; R.neck[0] = 0.3;
      mix(R, 'shL', -0.9, 0, -0.4, 1); mix(R, 'shR', -0.9, 0, 0.4, 1);
      mix(R, 'elL', -1.9, 0, 0, 1); mix(R, 'elR', -1.9, 0, 0, 1);
    } else if (st === 'land') {
      kneel(1);
      R.chest[0] = 0.75; R.neck[0] = -0.1;
      mix(R, 'shR', -0.95, 0, -0.1, 1); mix(R, 'elR', -0.1, 0, 0, 1);   // кулак в землю
      mix(R, 'shL', 0.3, 0, 0.5, 1);
    } else if (st === 'roar') {
      const k = win(this.stT, 0, 0.45, 2.0, 2.6);
      R.chest[0] = lerp(R.chest[0], -0.45, k); R.spine[0] = lerp(R.spine[0], -0.15, k); R.neck[0] = lerp(R.neck[0], -0.55, k);
      mix(R, 'shL', -0.5, 0, 1.25, k); mix(R, 'shR', -0.5, 0, -1.25, k);
      mix(R, 'elL', -1.1, 0, 0, k); mix(R, 'elR', -1.1, 0, 0, k);
      mix(R, 'hpL', -0.15, 0, 0.16, k); mix(R, 'hpR', -0.15, 0, -0.16, k);
      mix(R, 'knL', 0.35, 0, 0, k); mix(R, 'knR', 0.35, 0, 0, k);
      hipsY -= 0.06 * k;
    } else if (st === 'stagger') {
      const k = win(this.stT, 0, 0.35, 3.7, 4.2);
      kneel(k);
      R.chest[0] = lerp(R.chest[0], 0.7 + 0.06 * Math.sin(T * 4), k);
      mix(R, 'shR', -0.9, 0, -0.15, k); mix(R, 'elR', -0.2, 0, 0, k);
      mix(R, 'shL', -0.5, 0, 0.3, k); mix(R, 'elL', -1.1, 0, 0, k);
    } else if (st === 'dying' || st === 'dead') {
      const t = st === 'dead' ? 9 : this.stT;
      const back = win(t, 0, 0.5, 1.2, 2.0);
      R.chest[0] -= 0.8 * back; R.neck[0] -= 0.4 * back;
      mix(R, 'shL', -0.3, 0, 0.7, back); mix(R, 'shR', -0.3, 0, -0.7, back);
      const k = ss(1.2, 2.4, t);
      hipsY = lerp(hipsY, 0.66, k);
      mix(R, 'hpL', 0.2, 0, 0.1, k); mix(R, 'hpR', 0.2, 0, -0.1, k);
      mix(R, 'knL', 1.85, 0, 0, k); mix(R, 'knR', 1.85, 0, 0, k);
      R.chest[0] = lerp(R.chest[0], 0.3, k);
      mix(R, 'shL', 0.1, 0, 0.15, k); mix(R, 'shR', 0.1, 0, -0.15, k);
      // Падает ничком
      const f = ss(2.4, 3.9, t);
      this.body.rotation.x = 1.3 * f * f;
    }

    if (A) {
      const t = A.t;
      if (A.type === 'punch') {
        const s = A.side, sg = s === 'L' ? 1 : -1, o = s === 'L' ? 'R' : 'L';
        const w1 = win(t, 0, 0.5, 0.6, 0.7), w2 = win(t, 0.6, 0.7, 1.0, 1.45);
        A.track = t < 0.6;
        R.chest[1] += sg * 0.5 * w1 - sg * 0.4 * w2;
        R.chest[0] += -0.1 * w1 + 0.3 * w2;
        R.spine[0] += 0.15 * w2;
        mix(R, 'sh' + o, -0.7, 0, -sg * 0.2, w1);
        mix(R, 'hp' + o, -0.45, 0, 0, w2); mix(R, 'kn' + o, 0.35, 0, 0, w2);
        const pitch = R.hips[0] + R.spine[0] + R.chest[0];
        mix(R, 'sh' + s, 0.6, 0, sg * 0.35, w1);
        mix(R, 'el' + s, -1.7, 0, 0, w1);
        mix(R, 'sh' + s, -(Math.PI / 2 + A.ap + pitch), 0, -sg * 0.15, w2);
        mix(R, 'el' + s, -0.08, 0, 0, w2);
      } else if (A.type === 'pound') {
        const w1 = win(t, 0, 0.85, 0.95, 1.05), w2 = win(t, 0.95, 1.1, 1.6, 2.3);
        A.track = t < 0.9;
        R.chest[0] += -0.4 * w1 + 0.85 * w2; R.spine[0] += 0.35 * w2; R.neck[0] -= 0.2 * w1;
        mix(R, 'shL', -2.9, 0, 0.25, w1); mix(R, 'shR', -2.9, 0, -0.25, w1);
        mix(R, 'elL', -0.5, 0, 0, w1); mix(R, 'elR', -0.5, 0, 0, w1);
        mix(R, 'hpL', -0.7, 0, 0.12, w2); mix(R, 'hpR', -0.7, 0, -0.12, w2);
        mix(R, 'knL', 0.95, 0, 0, w2); mix(R, 'knR', 0.95, 0, 0, w2);
        hipsY -= 0.3 * w2;
        const pitch = R.hips[0] + R.spine[0] + R.chest[0];
        mix(R, 'shL', -pitch - 0.35, 0, 0.12, w2); mix(R, 'shR', -pitch - 0.35, 0, -0.12, w2);
        mix(R, 'elL', -0.1, 0, 0, w2); mix(R, 'elR', -0.1, 0, 0, w2);
      } else if (A.type === 'throw') {
        const w1 = win(t, 0, 0.45, 0.55, 0.8), w2 = win(t, 0.55, 1.0, 1.4, 1.5), w3 = win(t, 1.42, 1.56, 1.9, 2.4);
        A.track = t < 1.45;
        R.chest[0] += 0.75 * w1 - 0.35 * w2 + 0.4 * w3; R.spine[0] += 0.35 * w1;
        R.chest[1] += -0.45 * w2 + 0.45 * w3;
        mix(R, 'hpL', -0.6, 0, 0.08, w1); mix(R, 'hpR', -0.6, 0, -0.08, w1);
        mix(R, 'knL', 0.85, 0, 0, w1); mix(R, 'knR', 0.85, 0, 0, w1);
        mix(R, 'hpL', -0.45, 0, 0.05, w3); mix(R, 'knL', 0.3, 0, 0, w3);
        hipsY -= 0.28 * w1;
        const pitch = R.hips[0] + R.spine[0] + R.chest[0];
        mix(R, 'shR', -pitch + 0.15, 0, -0.1, w1); mix(R, 'elR', -0.1, 0, 0, w1);
        mix(R, 'shR', -3.0, 0, -0.25, w2); mix(R, 'elR', -1.4, 0, 0, w2);
        mix(R, 'shL', -1.2, 0, 0.3, w2);
        mix(R, 'shR', -(Math.PI / 2 + A.ap + pitch) + 0.25, 0, 0.1, w3); mix(R, 'elR', -0.1, 0, 0, w3);
      } else if (A.type === 'beam') {
        const k = win(t, 0, 0.6, 3.3, 3.8);
        A.track = true;
        R.chest[0] -= 0.12 * k;
        mix(R, 'shL', -0.4, 0, 0.7, k); mix(R, 'shR', -0.4, 0, -0.7, k);
        mix(R, 'elL', -1.0, 0, 0, k); mix(R, 'elR', -1.0, 0, 0, k);
        mix(R, 'hpL', -0.1, 0, 0.14, k); mix(R, 'hpR', -0.1, 0, -0.14, k);
        // Голова — на точку прицела
        if (this.beamAim) {
          _v.subVectors(this.beamAim, this.wp.eyes);
          const el = Math.atan2(_v.y, Math.hypot(_v.x, _v.z));
          const yawD = wrapA(Math.atan2(_v.x, _v.z) - this.yaw);
          const pitch = R.hips[0] + R.spine[0] + R.chest[0];
          R.neck[0] = lerp(R.neck[0], clamp(-el - pitch, -1.0, 0.7), k);
          R.neck[1] = lerp(R.neck[1], clamp(yawD, -0.8, 0.8), k);
        }
      } else if (A.type === 'nova') {
        const k = win(t, 0, 0.5, 3.4, 4.2);
        A.track = false;
        kneel(k);
        const rise = ss(0.6, 2.6, t), blast = win(t, 2.55, 2.7, 3.0, 3.8);
        const tr = 0.03 * rise * Math.sin(T * 45);
        R.chest[0] = lerp(R.chest[0], lerp(0.5, -0.25, rise) + tr - 0.3 * blast, k);
        R.neck[0] = lerp(R.neck[0], -0.4 * rise, k);
        mix(R, 'shL', -0.3, 0, 1.0 + 0.6 * blast, k); mix(R, 'shR', -0.3, 0, -1.0 - 0.6 * blast, k);
        mix(R, 'elL', -0.7 * (1 - blast), 0, 0, k); mix(R, 'elR', -0.7 * (1 - blast), 0, 0, k);
      }
    }

    if (A) {
      const t = A.t, pitchOf = () => R.hips[0] + R.spine[0] + R.chest[0];
      if (A.type === 'grab') {
        const s = A.side, sg = s === 'L' ? 1 : -1, o = s === 'L' ? 'R' : 'L';
        if (!A.caught) {
          // Тянется раскрытой ладонью
          const w1 = win(t, 0, 0.45, 0.5, 0.6), w2 = win(t, 0.5, 0.68, 1.0, 1.5);
          A.track = t < 0.5;
          R.chest[1] += sg * 0.4 * w1 - sg * 0.3 * w2;
          R.chest[0] += 0.3 * w2; R.spine[0] += 0.15 * w2;
          mix(R, 'hp' + o, -0.45, 0, 0, w2); mix(R, 'kn' + o, 0.35, 0, 0, w2);
          mix(R, 'sh' + s, 0.4, 0, sg * 0.5, w1); mix(R, 'el' + s, -1.3, 0, 0, w1);
          mix(R, 'sh' + s, -(Math.PI / 2 + A.ap + pitchOf()), 0, -sg * 0.1, w2);
          mix(R, 'el' + s, -0.25, 0, 0, w2);
          mix(R, 'ha' + s, -0.5, 0, 0, w2);
        } else {
          // Держит героя у лица и сжимает; в конце — швыряет о землю
          const h = A.ht, sq = 0.08 * Math.sin(h * 9);
          const k = ss(0, 0.4, h);
          R.chest[0] = lerp(R.chest[0], 0.05, k); R.neck[0] = lerp(R.neck[0], -0.05, k);
          mix(R, 'sh' + s, -1.15, 0, -sg * 0.15, k); mix(R, 'el' + s, -1.75 + sq, 0, 0, k);
          mix(R, 'sh' + o, -0.95, 0, sg * 0.25, k); mix(R, 'el' + o, -1.5 - sq, 0, 0, k);
          if (A.fin >= 0) {
            const f1 = win(A.fin, 0, 0.4, 0.45, 0.55), f2 = ss(0.45, 0.6, A.fin);
            R.chest[0] += -0.35 * f1 + 0.8 * f2; R.spine[0] += 0.3 * f2;
            mix(R, 'sh' + s, -2.9, 0, -sg * 0.2, f1); mix(R, 'el' + s, -0.6, 0, 0, f1);
            mix(R, 'hpL', -0.6, 0, 0.1, f2); mix(R, 'hpR', -0.6, 0, -0.1, f2);
            mix(R, 'knL', 0.8, 0, 0, f2); mix(R, 'knR', 0.8, 0, 0, f2);
            hipsY -= 0.25 * f2;
            mix(R, 'sh' + s, -pitchOf() - 0.3, 0, -sg * 0.1, f2); mix(R, 'el' + s, -0.1, 0, 0, f2);
          }
        }
      } else if (A.type === 'stomp') {
        const w1 = win(t, 0, 0.6, 0.62, 0.7), w2 = win(t, 0.62, 0.72, 1.1, 1.6);
        A.track = t < 0.55;
        mix(R, 'hpR', -1.35, 0, -0.1, w1); mix(R, 'knR', 1.55, 0, 0, w1);
        mix(R, 'knL', 0.3, 0, 0, w1);
        R.chest[0] += -0.15 * w1 + 0.3 * w2;
        mix(R, 'shL', -0.3, 0, 0.7, w1); mix(R, 'shR', -0.3, 0, -0.7, w1);
        mix(R, 'hpR', -0.3, 0, -0.08, w2); mix(R, 'knR', 0.15, 0, 0, w2);
        mix(R, 'knL', 0.45, 0, 0, w2);
        hipsY -= 0.08 * w2;
      } else if (A.type === 'clap') {
        const w1 = win(t, 0, 0.5, 0.55, 0.62), w2 = win(t, 0.55, 0.66, 1.0, 1.4);
        A.track = t < 0.55;
        R.chest[0] += -0.15 * w1 + 0.2 * w2;
        const a = -(Math.PI / 2 + A.ap + pitchOf());
        mix(R, 'shL', a * 0.85, 0, 1.4, w1); mix(R, 'shR', a * 0.85, 0, -1.4, w1);
        mix(R, 'elL', -0.25, 0, 0, w1); mix(R, 'elR', -0.25, 0, 0, w1);
        mix(R, 'shL', a, 0, -0.32, w2); mix(R, 'shR', a, 0, 0.32, w2);
        mix(R, 'elL', -0.05, 0, 0, w2); mix(R, 'elR', -0.05, 0, 0, w2);
      } else if (A.type === 'meteor') {
        const k = win(t, 0, 0.6, 3.2, 3.8);
        A.track = true;
        R.chest[0] -= 0.4 * k; R.neck[0] = lerp(R.neck[0], -0.65, k);
        mix(R, 'shL', -2.9, 0, 0.45, k); mix(R, 'shR', -2.9, 0, -0.45, k);
        mix(R, 'elL', -0.3, 0, 0, k); mix(R, 'elR', -0.3, 0, 0, k);
      } else if (A.type === 'charge') {
        const w0 = win(t, 0, 0.3, 0.45, 0.65), w = win(t, 0.5, 0.8, 3.0, 3.4);
        A.track = true;
        hipsY -= 0.12 * w0;
        R.chest[0] += 0.4 * w0 + 0.45 * w; R.neck[0] -= 0.35 * w;
        mix(R, 'knL', 0.6, 0, 0, w0); mix(R, 'knR', 0.6, 0, 0, w0);
        mix(R, 'shL', 0.75, 0, 0.35, w); mix(R, 'shR', 0.75, 0, -0.35, w);
        mix(R, 'elL', -0.7, 0, 0, w); mix(R, 'elR', -0.7, 0, 0, w);
      }
    }
    if (st === 'lifted' || st === 'thrown') {
      // Болтается в руках героя / кувыркается в полёте
      const f = Math.sin(T * 7), g = Math.cos(T * 5.3);
      mix(R, 'shL', -1.6 + 0.6 * f, 0, 0.9, 1); mix(R, 'shR', -1.6 - 0.6 * f, 0, -0.9, 1);
      mix(R, 'elL', -0.6, 0, 0, 1); mix(R, 'elR', -0.6, 0, 0, 1);
      mix(R, 'hpL', -0.5 + 0.5 * g, 0, 0.15, 1); mix(R, 'hpR', -0.5 - 0.5 * g, 0, -0.15, 1);
      mix(R, 'knL', 0.6, 0, 0, 1); mix(R, 'knR', 0.6, 0, 0, 1);
      R.neck[0] = -0.5;
    }

    // Отдача от сильных попаданий
    R.chest[0] -= 0.3 * this.flinch; R.neck[0] -= 0.2 * this.flinch;
    // Стопы — параллельно земле
    R.anL[0] = -(R.hips[0] + R.hpL[0] + R.knL[0]) * 0.9;
    R.anR[0] = -(R.hips[0] + R.hpR[0] + R.knR[0]) * 0.9;

    const rate = snap ? 1e6 : A && A.type !== 'beam' && A.type !== 'nova' && A.type !== 'meteor' ? 16 : 7;
    for (const k of KEYS) {
      const j = this.j[k], r = R[k];
      j.rotation.x = damp(j.rotation.x, r[0], rate, snap ? 1 : dt);
      j.rotation.y = damp(j.rotation.y, r[1], rate, snap ? 1 : dt);
      j.rotation.z = damp(j.rotation.z, r[2], rate, snap ? 1 : dt);
    }
    this.j.hips.position.y = damp(this.j.hips.position.y, hipsY, rate, snap ? 1 : dt);
    // Лёжа на руках героя — на спине; после падения плавно поднимается
    if (st === 'lifted') this.body.rotation.x = damp(this.body.rotation.x, -Math.PI / 2, 8, snap ? 1 : dt);
    else if (st !== 'dying' && st !== 'dead' && st !== 'thrown') this.body.rotation.x = damp(wrapA(this.body.rotation.x), 0, 3, snap ? 1 : dt);
  }

  // ================================================================ события атак
  attackEvents(dt, player) {
    const W = this.world, A = this.atk, t = A.t, t0 = A.prev;
    A.prev = t;
    const at = (x) => t0 < x && t >= x;
    _h.copy(player.pos); _h.y += 1;

    if (A.type === 'punch') {
      const s = A.side, fist = this.wp['fist' + s];
      if (A.track) A.ap = clamp(Math.atan2(_h.y - this.wp['sh' + s].y, Math.hypot(_h.x - this.wp['sh' + s].x, _h.z - this.wp['sh' + s].z)), -1.2, 1.35);
      this['glow' + s].material.opacity = 0.9 * win(t, 0.1, 0.55, 0.75, 0.95);
      this['glow' + s].scale.setScalar(1 + 0.6 * ss(0.1, 0.6, t));
      if (t > 0.64 && t < 0.92) {
        if (!A.hitHero && fist.distanceTo(_h) < 0.24 * S + 1.4) {
          A.hitHero = true;
          const dir = _v.subVectors(_h, this.wp.chestC).setY(0).normalize();
          dir.y = 0.35;
          this.battle.hurtHero(30, dir.normalize().multiplyScalar(170));
        }
        A.cityT = (A.cityT || 0) - dt;
        if (A.cityT <= 0) {
          A.cityT = 0.05;
          const f = fist.clone(), dir = _v2.subVectors(fist, this.wp['sh' + s]).normalize();
          this.smash((c) => c.damageRadius(f, 7 * K, 500, 40, dir));
        }
      }
      if (at(0.66)) W.audio?.whoosh(1);
    } else if (A.type === 'pound') {
      const k = win(t, 0.2, 0.9, 1.0, 1.15);
      this.glowL.material.opacity = this.glowR.material.opacity = 0.9 * k;
      if (at(1.12)) {
        const p = _v.addVectors(this.wp.fistL, this.wp.fistR).multiplyScalar(0.5);
        p.y = groundHeight(p.x, p.z);
        const c = p.clone();
        W.effects.shockwave(c.clone().setY(c.y + 1), { type: 'ring', radius: 170 * K, life: 1.6, opacity: 0.9, color: 0xffa060 });
        W.effects.shockwave(c, { type: 'sphere', radius: 45 * K, life: 0.7, opacity: 0.4, color: 0xffb080 });
        W.effects.crater(c, 34 * K);
        W.effects.flash(c, 60);
        W.effects.impactFX(0.6, c, 0.15, 8);
        W.debris.explode(c, 70, 60);
        W.dust.burst(c.clone().setY(c.y + 2), 40, { size: [10, 24], speed: 55, life: [2, 4], flat: true });
        W.impact?.(c, 140, 45);
        this.smash((city) => city.damageRadius(c, 36 * K, 900, 70));
        this.sound('boom', 1, c);
        this.waves.push({ p: c, t: 0, life: 1.6, R: 170 * K, hit: false });
      }
    } else if (A.type === 'throw') {
      if (A.track) A.ap = clamp(Math.atan2(_h.y - this.wp.shR.y, Math.hypot(_h.x - this.wp.shR.x, _h.z - this.wp.shR.z)), -0.8, 1.2) + 0.12;
      if (at(0.5)) {
        // Вырывает скалу из земли
        const p = this.wp.fistR.clone();
        p.y = groundHeight(p.x, p.z);
        W.dust.burst(p, 18, { size: [6, 14], speed: 18, life: [1.5, 3], flat: true });
        W.debris.explode(p, 20, 25);
        W.effects.crater(p, 9);
        this.sound('step', 1.4, p);
        const mesh = new THREE.Mesh(this.rockGeo, this.rockMat);
        mesh.add(new THREE.Mesh(this.rockCore, this.magmaMat));
        mesh.castShadow = true;
        mesh.scale.setScalar(K);
        this.scene.add(mesh);
        A.rock = { mesh, held: true, vel: new THREE.Vector3(), spin: new THREE.Vector3(Math.random() * 3, Math.random() * 3, Math.random() * 3), life: 0, deflected: false };
        this.rocks.push(A.rock);
      }
      if (A.rock?.held) A.rock.mesh.position.copy(this.wp.fistR).addScaledVector(UP, 1.5 * K);
      if (at(1.53) && A.rock?.held) {
        const r = A.rock;
        r.held = false;
        const p = r.mesh.position, speed = 165;
        const d = p.distanceTo(_h), T = d / speed;
        const target = _v.copy(_h).addScaledVector(player.vel, T * 0.7);
        r.vel.subVectors(target, p).divideScalar(Math.max(0.2, T));
        r.vel.y += 0.5 * 20 * T;
        W.audio?.whoosh(1);
        if (!this.deflectHint) { this.deflectHint = true; this.battle.banner('ОТБЕЙ СКАЛУ УДАРОМ!', 2); }
      }
    } else if (A.type === 'grab') this.grabEvents(dt, player, t);
    else if (A.type === 'stomp') {
      if (at(0.7)) {
        const p = this.wp.anR.clone();
        p.y = groundHeight(p.x, p.z);
        W.effects.shockwave(p.clone().setY(p.y + 1), { type: 'ring', radius: 70 * K, life: 1, opacity: 0.8, color: 0xffa060 });
        W.effects.crater(p, 0.35 * S);
        W.effects.flash(p, 40);
        W.debris.explode(p, 50 * K, 50);
        W.dust.burst(p.clone().setY(p.y + 2), 30, { size: [10, 20], speed: 45, life: [1.5, 3], flat: true });
        W.impact?.(p, 90 * K, 40);
        this.smash((c) => c.damageRadius(p, 0.4 * S, 1200, 60));
        this.sound('boom', 0.9, p);
        const d = Math.hypot(_h.x - p.x, _h.z - p.z), low = _h.y - p.y < 0.35 * S;
        if (low && d < 0.4 * S + 4) {
          const dir = _v.set(_h.x - p.x, 0, _h.z - p.z).normalize(); dir.y = 0.6;
          this.battle.hurtHero(36, dir.normalize().multiplyScalar(130));
        } else if (_h.y - p.y < 10 && d < 70 * K) {
          const dir = _v.set(_h.x - p.x, 0, _h.z - p.z).normalize(); dir.y = 0.9;
          this.battle.hurtHero(12, dir.normalize().multiplyScalar(70));
        }
      }
    } else if (A.type === 'clap') {
      if (A.track) A.ap = clamp(Math.atan2(_h.y - this.wp.chestC.y, Math.hypot(_h.x - this.wp.chestC.x, _h.z - this.wp.chestC.z)), -1.0, 1.3);
      const mid = _v.addVectors(this.wp.fistL, this.wp.fistR).multiplyScalar(0.5);
      if (t > 0.6 && t < 1.05 && !A.hitHero && this.wp.fistL.distanceTo(this.wp.fistR) < 0.8 * S && mid.distanceTo(_h) < 0.6 * S) {
        A.hitHero = true;
        const dir = _v2.subVectors(_h, this.wp.chestC).normalize(); dir.y = -0.4;
        this.battle.hurtHero(42, dir.normalize().multiplyScalar(160));
      }
      if (at(0.64)) {
        W.effects.shockwave(mid.clone(), { type: 'sphere', radius: 0.7 * S, life: 0.5, opacity: 0.5 });
        W.effects.impactFX(0.6, mid.clone(), 0.12, 8);
        this.sound('boom', 0.6, mid.clone());
        W.impact?.(mid.clone(), 40 * K, 25);
      }
    } else if (A.type === 'meteor') {
      if (t > 0.9 && t < 3.0) {
        this.meteorT -= dt;
        if (this.meteorT <= 0) { this.meteorT = 0.2; this.spawnMeteor(player); }
      }
      if (at(0.7)) this.sound('roar', 0.7, this.wp.headTop.clone());
    } else if (A.type === 'charge') {
      if (at(0.3)) this.sound('roar', 0.6, this.wp.headTop.clone());
      if (t > 0.6 && t < 3.0) {
        const fwd = _v2.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
        if (!A.hitHero && (Math.hypot(_h.x - this.pos.x, _h.z - this.pos.z) < 0.45 * S && _h.y < this.wp.headTop.y || _h.distanceTo(this.wp.chestC) < 0.6 * S)) {
          A.hitHero = true;
          const dir = fwd.clone(); dir.y = 0.5;
          this.battle.hurtHero(38, dir.normalize().multiplyScalar(240));
          A.t = Math.max(A.t, 3.0);
        }
        A.cityT = (A.cityT || 0) - dt;
        if (A.cityT <= 0) {
          A.cityT = 0.08;
          const c = this.wp.chestC.clone().addScaledVector(fwd, 0.3 * S);
          const c2 = this.wp.hips.clone().addScaledVector(fwd, 0.25 * S);
          const f = fwd.clone();
          this.smash((city) => { city.damageRadius(c, 0.5 * S, 1500, 70, f); city.damageRadius(c2, 0.45 * S, 1500, 70, f); });
        }
      }
    } else if (A.type === 'beam') this.updateBeam(dt, player, t);
    else if (A.type === 'nova') {
      const c = this.wp.chestC;
      const grow = ss(0.6, 2.6, t);
      this.nova.visible = t > 0.6 && t < 2.62;
      this.nova.position.copy(c);
      this.nova.scale.setScalar((4 + 22 * grow + Math.sin(this.t * 30) * grow) * K);
      this.nova.material.opacity = 0.15 + 0.3 * grow;
      if (t < 2.6 && A.taken >= 2200) {
        this.nova.visible = false;
        this.atk = null;
        this.battle.banner('ВЗРЫВ ПРЕРВАН!');
        this.startStagger();
        return;
      }
      if (at(2.6)) this.novaBlast(player);
    }
  }

  updateBeam(dt, player, t) {
    const W = this.world, on = t > 1.1 && t < 3.4;
    this.beamCore.visible = this.beamGlow.visible = on;
    this.beamHit.visible = false;
    if (!on) return;
    // Точка прицела ползёт к герою с ограниченной скоростью — от луча можно увернуться
    _h.copy(player.pos); _h.y += 1;
    const sp = 38 + 10 * this.phase;
    _v.subVectors(_h, this.beamAim);
    const d = _v.length();
    if (d > 1e-3) this.beamAim.addScaledVector(_v, Math.min(1, sp * dt / d));
    const o = this.wp.eyes, dir = _e.subVectors(this.beamAim, o).normalize();
    // Первое препятствие вдоль луча
    let dist = 1400, seg = null, ground = false;
    const city = W.city;
    for (let s = 4; s < 1400; s += 3) {
      _v2.copy(o).addScaledVector(dir, s);
      const g = city.segAt(_v2, 0.5);
      if (g) { dist = s; seg = g; break; }
      if (_v2.y <= groundHeight(_v2.x, _v2.z)) { dist = s; ground = true; break; }
    }
    const end = _v2.copy(o).addScaledVector(dir, dist);
    const wv = 1 + 0.12 * Math.sin(this.t * 55);
    for (const [m, r] of [[this.beamCore, 0.7], [this.beamGlow, 2.6]]) {
      m.position.copy(o);
      m.quaternion.setFromUnitVectors(Z, dir);
      m.scale.set(r * wv, r * wv, dist);
    }
    this.beamHit.visible = seg || ground;
    this.beamHit.position.copy(end);
    this.beamHit.scale.setScalar(5 + Math.random() * 2);
    // Герой в луче
    segSeg(o, end, _h, _h, _c1, _c2);
    if (_c1.distanceTo(_h) < 4.2) this.battle.hurtHero(55 * dt, null, true);
    // Плавит здания, оставляет подпалины на земле
    this.beamTick -= dt;
    if (this.beamTick > 0) return;
    this.beamTick = 0.1;
    const p = end.clone();
    W.sparks.burst(p, 8, { size: [0.4, 1.2], speed: 22, life: [0.2, 0.6], color: 0xffc060 });
    if (seg) {
      const n = city.faceNormal(seg, p);
      this.smash((c) => c.damage(seg, 260, p, n.clone().negate(), 10));
      if (Math.random() < 0.15) W.fire.add(p.clone().addScaledVector(n, 1), { size: 1.6, life: 10 });
    } else if (ground) {
      W.effects.crater(p, 3.5);
      W.dust.burst(p, 3, { size: [3, 7], speed: 6, life: [1, 2], color: 0x3a3430 });
      W.impact?.(p, 10, 15);
    }
    W.people?.scareAround?.(p, 60);
  }

  novaBlast(player) {
    const W = this.world, c = this.wp.chestC.clone();
    this.nova.visible = false;
    const g = c.clone(); g.y = groundHeight(g.x, g.z);
    W.effects.shockwave(c, { type: 'sphere', radius: 150 * K, life: 1.2, opacity: 0.6, color: 0xffa050 });
    W.effects.shockwave(g.clone().setY(g.y + 1), { type: 'ring', radius: 240, life: 1.5, opacity: 0.9, color: 0xff8a40 });
    W.effects.flash(c, 120);
    W.effects.impactFX(1, c, 0.5, 14);
    W.debris.explode(g, 140, 90);
    W.dust.burst(g.clone().setY(g.y + 3), 60, { size: [14, 30], speed: 70, life: [2.5, 5], flat: true });
    W.impact?.(g, 220, 60);
    this.smash((city) => city.damageRadius(g, 75 * K, 1300, 90));
    this.sound('boom', 1, c);
    this.sound('boom', 0.8, c);
    _h.copy(player.pos); _h.y += 1;
    const d = _h.distanceTo(c);
    const NR = 150 * K;
    if (d < NR) {
      const dir = _v.subVectors(_h, c).normalize();
      dir.y = Math.max(dir.y, 0.3);
      this.battle.hurtHero(20 + 55 * (1 - d / NR), dir.normalize().multiplyScalar(260));
    }
  }

  // ================================================================ захват героя
  grabEvents(dt, player, t) {
    const A = this.atk, s = A.side, fist = this.wp['fist' + s];
    if (!A.caught) {
      if (A.track) A.ap = clamp(Math.atan2(_h.y - this.wp['sh' + s].y, Math.hypot(_h.x - this.wp['sh' + s].x, _h.z - this.wp['sh' + s].z)), -1.2, 1.35);
      if (!A.done && t > 0.55 && t < 1.2 && !this.battle.heroDown && player.held?.kind !== 'boss' && fist.distanceTo(_h) < 0.3 * S + 4) {
        A.caught = true; A.ht = 0; A.fin = -1; A.esc = 0; A.need = 10 + 3 * this.phase;
        A.holdDur = 4.4 - 0.6 * this.phase;
        if (player.held) player.throwHeld(new THREE.Vector3(0, -1, 0));
        player.captured = this;
        this.battle.hurtHero(10, null);
        this.battle.banner('КОЛОСС СХВАТИЛ ТЕБЯ! ЖМИ ЛКМ / ПРОБЕЛ — ВЫРВИСЬ!', 2.5);
        this.sound('hit', 1, fist.clone());
      }
      return;
    }
    A.ht += dt;
    A.dur = A.t + 1;
    // Герой зажат в кулаке (торчит сверху)
    player.pos.copy(fist).addScaledVector(UP, 0.12 * S);
    player.pos.y -= 1;
    player.vel.set(0, 0, 0);
    if (A.fin < 0) {
      this.battle.hurtHero(6 * dt, null, true);
      if (Math.random() < 0.2) this.world.sparks.burst(fist, 2, { size: [0.4, 1], speed: 8, life: [0.2, 0.4], color: 0xff9040 });
      if (A.ht > A.holdDur) A.fin = 0;
    } else {
      A.fin += dt;
      if (A.fin >= 0.58) {
        // Швыряет о землю
        const p = fist.clone(); p.y = groundHeight(p.x, p.z);
        const W = this.world;
        this.releaseHero();
        A.caught = false; A.done = true;
        A.dur = A.t + 0.9;
        W.effects.shockwave(p.clone().setY(p.y + 1), { type: 'ring', radius: 60 * K, life: 0.9, opacity: 0.8, color: 0xffa060 });
        W.effects.crater(p, 0.3 * S);
        W.dust.burst(p.clone().setY(p.y + 2), 26, { size: [8, 18], speed: 40, life: [1.5, 3], flat: true });
        W.debris.explode(p, 40 * K, 45);
        this.smash((c) => c.damageRadius(p, 0.35 * S, 1000, 60));
        this.sound('boom', 0.9, p);
        const fwd = _v.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
        this.battle.hurtHero(28, new THREE.Vector3(fwd.x * 40, -180, fwd.z * 40));
      }
    }
  }

  // Герой бьётся в кулаке: ЛКМ / пробел / рывок
  struggle() {
    const A = this.atk;
    if (!A || A.type !== 'grab' || !A.caught || A.fin >= 0) return;
    A.esc++;
    const fist = this.wp['fist' + A.side];
    this.world.sparks.burst(fist, 8, { size: [0.4, 1.2], speed: 18, life: [0.2, 0.5], color: 0xffd28a });
    this.world.audio?.punch(0.4, 'concrete', fist.clone());
    this.flinch = Math.min(1, this.flinch + 0.08);
    if (A.esc < A.need) return;
    // Вырвался: кулак разжимается, Колосс шатается
    const player = this.battle.player;
    this.releaseHero();
    A.caught = false; A.done = true;
    A.dur = A.t + 0.7;
    const out = new THREE.Vector3().subVectors(player.pos, this.wp.chestC).setY(0).normalize();
    player.vel.copy(out).multiplyScalar(60); player.vel.y = 30;
    player.knockT = 0.3;
    this.world.effects.shockwave(fist.clone(), { type: 'sphere', radius: 18, life: 0.4, opacity: 0.6 });
    this.battle.banner('ВЫРВАЛСЯ!', 1.4);
    this.takeHit(600, fist.clone(), out, 'escape');
    this.poise += 1200;
    this.flinch = 1;
  }

  releaseHero() {
    const P = this.battle.player;
    if (P.captured === this) { P.captured = null; P.knockT = 0.4; }
  }

  // ================================================================ герой поднимает Колосса (R)
  findGrabbable(p, range) {
    if (!this.alive || this.liftCd > 0 || ['intro', 'land', 'roar', 'lifted', 'thrown'].includes(this.state)) return null;
    if (this.battle.player.captured) return null;
    let best = Infinity;
    for (const c of this.caps) {
      segSeg(p, p, this.wp[c.a], this.wp[c.b], _c1, _c2);
      best = Math.min(best, _c1.distanceTo(_c2) - c.r);
    }
    return best < range ? { ref: this, dist: Math.max(0, best) } : null;
  }

  hold() {
    this.releaseHero();
    this.atk = null;
    this.state = 'lifted';
    this.stT = 0;
    this.glowL.material.opacity = this.glowR.material.opacity = 0;
    this.beamCore.visible = this.beamGlow.visible = this.beamHit.visible = false;
    this.nova.visible = false;
    for (const r of this.rocks) if (r.held) { r.held = false; r.vel.set(0, -5, 0); }
    const P = this.battle.player;
    this.liftYaw = Math.atan2(P.facing.x, P.facing.z);
    this.liftP.copy(P.pos).addScaledVector(UP, 2.45);
    this.sound('roar', 0.7, this.wp.headTop.clone());
    this.battle.banner('КОЛОСС В ТВОИХ РУКАХ! R — БРОСИТЬ', 2);
  }

  setHeld(ref, p) {
    this.liftP.copy(p);
    const P = this.battle.player;
    this.liftYaw = Math.atan2(P.facing.x, P.facing.z);
  }

  throwObj(ref, vel) {
    this.state = 'thrown';
    this.stT = 0;
    this.sweepT = 0;
    this.vel.copy(vel).multiplyScalar(1.2);
    this.spin = -2.2 - Math.random();
    this.liftCd = 9;
  }

  // Удар по Колоссу, которого держит герой
  damageCar(ref, amount) { this.takeHit(amount * 6, this.cm.clone(), UP, 'heavy', this.caps[0]); }

  dropFromHero() {
    const P = this.battle.player;
    if (P.held?.kind === 'boss') P.held = null;
  }

  // Вырывается из рук героя
  breakFree(player) {
    this.dropFromHero();
    this.state = 'thrown';
    this.stT = 0;
    this.vel.set(0, -10, 0);
    this.spin = 1.5;
    this.liftCd = 9;
    const dir = new THREE.Vector3(-Math.sin(this.liftYaw), 0.4, -Math.cos(this.liftYaw)).normalize();
    this.battle.hurtHero(14, dir.multiplyScalar(110));
    this.world.effects.shockwave(this.cm.clone(), { type: 'sphere', radius: 0.8 * S, life: 0.6, opacity: 0.5, color: 0xffb080 });
    this.sound('roar', 0.8, this.cm.clone());
    this.battle.banner('КОЛОСС ВЫРВАЛСЯ!', 1.6);
  }

  // Рухнул после броска: урон от удара и оглушение
  crash(gy) {
    const W = this.world, v = this.vel.length();
    this.dropFromHero();
    const p = this.cm.clone(); p.y = gy;
    this.pos.copy(p);
    this.cm.y = Math.max(this.cm.y, gy + 0.3 * S);
    this.recoverT = 2.5;
    this.state = 'fight';
    this.vel.set(0, 0, 0);
    W.effects.shockwave(p.clone().setY(gy + 1), { type: 'ring', radius: 200 * K, life: 1.6, opacity: 0.9, color: 0xd8c0a0 });
    W.effects.shockwave(p, { type: 'sphere', radius: 60 * K, life: 0.8, opacity: 0.4 });
    W.effects.crater(p, 0.9 * S);
    W.effects.flash(p, 80);
    W.effects.impactFX(0.8, p, 0.25, 10);
    W.debris.explode(p, 120 * K, 70);
    W.dust.burst(p.clone().setY(gy + 3), 60, { size: [14, 30], speed: 60, life: [3, 6], flat: true });
    W.impact?.(p, 200 * K, 55);
    this.smash((c) => c.damageRadius(p, 0.8 * S, 2500, 80));
    this.sound('boom', 1, p);
    this.takeHit(Math.min(3500, 1200 + v * 12), p.clone().setY(gy + 0.5 * S), UP, 'throw', this.caps[0]);
    if (this.state === 'fight') this.startStagger();
  }

  // ================================================================ магмовый дождь
  spawnMeteor(player) {
    const tx = player.pos.x + (Math.random() - 0.5) * 140, tz = player.pos.z + (Math.random() - 0.5) * 140;
    const target = new THREE.Vector3(tx, groundHeight(tx, tz), tz);
    const from = target.clone().add(new THREE.Vector3((Math.random() - 0.5) * 200, 520, (Math.random() - 0.5) * 200));
    const mesh = new THREE.Mesh(this.rockGeo, this.rockMat);
    mesh.add(new THREE.Mesh(this.rockCore, this.magmaMat));
    mesh.scale.setScalar(0.8 + Math.random() * 0.5);
    mesh.position.copy(from);
    this.scene.add(mesh);
    const ring = new THREE.Mesh(this.warnGeo || (this.warnGeo = new THREE.RingGeometry(0.85, 1, 40).rotateX(-Math.PI / 2)),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.8, 0.2), transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
    ring.position.copy(target).y += 0.6;
    this.scene.add(ring);
    this.meteors.push({ mesh, ring, from, target, t: 0, life: 1.3 + Math.random() * 0.4, hit: false });
  }

  updateMeteors(dt, player) {
    const W = this.world;
    _h.copy(player.pos); _h.y += 1;
    for (let i = this.meteors.length - 1; i >= 0; i--) {
      const m = this.meteors[i];
      m.t += dt;
      const k = Math.min(1, m.t / m.life);
      m.mesh.position.lerpVectors(m.from, m.target, k * k);
      m.mesh.rotation.x += dt * 4; m.mesh.rotation.z += dt * 3;
      m.ring.scale.setScalar(16 * (0.4 + 0.6 * k));
      m.ring.material.opacity = 0.4 + 0.5 * Math.abs(Math.sin(m.t * 12));
      if (Math.random() < 0.8) W.sparks.burst(m.mesh.position, 2, { size: [1, 2.5], speed: 10, life: [0.2, 0.5], color: 0xff8030 });
      if (!m.hit && m.mesh.position.distanceTo(_h) < 7) {
        m.hit = true;
        this.battle.hurtHero(20, new THREE.Vector3(0, -60, 0));
      }
      if (k >= 1) {
        const p = m.target;
        W.effects.shockwave(p.clone().setY(p.y + 1), { type: 'ring', radius: 30, life: 0.6, opacity: 0.8, color: 0xff9040 });
        W.effects.crater(p, 9);
        W.fire.explosion(p.clone().setY(p.y + 2), 0.7);
        W.dust.burst(p, 10, { size: [6, 12], speed: 18, life: [1, 2.5] });
        W.impact?.(p, 25, 30);
        this.smash((c) => c.damageRadius(p, 16, 900, 50));
        if (Math.random() < 0.5) W.audio?.explosion(0.5, p);
        if (!m.hit && _h.distanceTo(p) < 17) {
          const dir = _v.subVectors(_h, p).normalize(); dir.y = Math.max(dir.y, 0.5);
          this.battle.hurtHero(22, dir.normalize().multiplyScalar(80));
        }
        this.scene.remove(m.mesh); this.scene.remove(m.ring); m.ring.material.dispose();
        this.meteors.splice(i, 1);
      }
    }
  }

  // ================================================================ сцены
  land(gy) {
    const W = this.world;
    this.pos.y = gy;
    this.vel.set(0, 0, 0);
    this.state = 'land';
    this.stT = 0;
    const c = this.pos.clone();
    W.effects.shockwave(c.clone().setY(gy + 1), { type: 'ring', radius: 260, life: 1.8, opacity: 0.9, color: 0xffa060 });
    W.effects.shockwave(c, { type: 'sphere', radius: 90, life: 1, opacity: 0.5, color: 0xffb080 });
    W.effects.crater(c, 45);
    W.effects.flash(c, 120);
    W.effects.impactFX(0.8, c, 0.35, 10);
    W.debris.explode(c, 120, 80);
    W.dust.burst(c.clone().setY(gy + 3), 70, { size: [14, 32], speed: 80, life: [3, 6], flat: true });
    W.impact?.(c, 220, 60);
    W.city.damageRadius(c, 50, 2500, 80);   // место падения — не в счёт урона городу
    this.sound('boom', 1, c);
    this.sound('boom', 1, c);
  }

  startRoar() {
    this.releaseHero();
    this.state = 'roar';
    this.stT = 0;
    this.atk = null;
    this.glowL.material.opacity = this.glowR.material.opacity = 0;
    this.beamCore.visible = this.beamGlow.visible = this.beamHit.visible = false;
    this.nova.visible = false;
    for (const r of this.rocks) if (r.held) { r.held = false; r.vel.set(0, -5, 0); }
  }

  roarBlast(player) {
    const W = this.world, c = this.wp.headTop.clone();
    this.sound('roar', 1, c);
    W.effects.shockwave(c, { type: 'sphere', radius: 130, life: 1.1, opacity: 0.3, color: 0xffc090 });
    W.impact?.(this.pos, 150, 25);
    W.air?.scareBirds?.(c, 800);
    _h.copy(player.pos); _h.y += 1;
    const d = _h.distanceTo(c);
    if (d < 140 * K && !this.battle.heroDown) {
      const dir = _v.subVectors(_h, this.wp.chestC).normalize();
      dir.y = Math.max(dir.y, 0.25);
      this.battle.hurtHero(6, dir.normalize().multiplyScalar(120 * (1 - d / (160 * K))));
    }
  }

  startStagger() {
    this.releaseHero();
    this.state = 'stagger';
    this.stT = 0;
    this.atk = null;
    this.poise = 0;
    this.glowL.material.opacity = this.glowR.material.opacity = 0;
    this.beamCore.visible = this.beamGlow.visible = this.beamHit.visible = false;
    this.nova.visible = false;
    for (const r of this.rocks) if (r.held) { r.held = false; r.vel.set(0, -5, 0); }
    const p = this.pos.clone();
    this.sound('step', 2, p);
    this.world.dust.burst(p.setY(p.y + 2), 24, { size: [8, 18], speed: 25, life: [1.5, 3], flat: true });
    this.battle.banner('КОЛОСС НА КОЛЕНЕ — БЕЙ В ЯДРО НА ГРУДИ!');
  }

  fallCrash() {
    const W = this.world;
    const p = this.pos.clone().add(_v.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)).multiplyScalar(26 * K));
    p.y = groundHeight(p.x, p.z);
    W.effects.shockwave(p.clone().setY(p.y + 1), { type: 'ring', radius: 200, life: 1.6, opacity: 0.8, color: 0xd8c0a0 });
    W.dust.burst(p.clone().setY(p.y + 3), 60, { size: [14, 30], speed: 50, life: [3, 6], flat: true });
    W.debris.explode(p, 90, 50);
    W.impact?.(p, 160, 35);
    W.city.damageRadius(p, 32, 1500, 40);
    this.sound('boom', 1, p);
  }

  // Шаги: на каждой опорной ноге — гул, пыль, урон тому, что под стопой
  footsteps(dt) {
    const W = this.world;
    const step = Math.floor((this.phi - Math.PI / 2) / Math.PI);
    if (step !== this.stepIdx && this.walkK > 0.3) {
      const foot = (step & 1) ? this.wp.anR : this.wp.anL;
      const p = foot.clone();
      p.y = groundHeight(p.x, p.z);
      this.sound('step', 1, p);
      W.dust.burst(p.clone().setY(p.y + 1), 10, { size: [5, 12], speed: 16, life: [1, 2.2], flat: true });
      W.effects.shockwave(p.clone().setY(p.y + 0.5), { type: 'ring', radius: 30 * K, life: 0.6, opacity: 0.4 });
      W.impact?.(p, 26 * K, 14);
      this.smash((c) => c.damageRadius(p, 8 * K, 400, 25));
    }
    this.stepIdx = step;
    // Корпус и колени сносят здания на пути
    this.sweepT -= dt;
    if (this.walkK > 0.3 && this.sweepT <= 0) {
      this.sweepT = 0.15;
      const city = W.city, fwd = _v.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      this.smash(() => {
        for (const [k, r0] of [['chestC', 11], ['hips', 9], ['knL', 6], ['knR', 6]]) {
          for (const s of city.sphereQuery(this.wp[k], r0 * K, [])) {
            if (!s.alive) continue;
            city.closestPoint(s, this.wp[k], _v2);
            city.damage(s, 700, _v2.clone(), fwd, 30);
          }
        }
      });
    }
  }

  // ================================================================ снаряды и волны
  updateRocks(dt, player) {
    const W = this.world;
    _h.copy(player.pos); _h.y += 1;
    for (let i = this.rocks.length - 1; i >= 0; i--) {
      const r = this.rocks[i];
      if (r.held) continue;
      const m = r.mesh, p = m.position;
      r.life += dt;
      if (r.deflected) {
        // Отбитая скала летит обратно в Колосса
        _v.subVectors(this.wp.chestC, p).normalize().multiplyScalar(170);
        r.vel.lerp(_v, Math.min(1, dt * 4));
      } else r.vel.y -= 20 * dt;
      p.addScaledVector(r.vel, dt);
      m.rotation.x += r.spin.x * dt; m.rotation.y += r.spin.y * dt; m.rotation.z += r.spin.z * dt;
      if (Math.random() < 0.6) W.dust.burst(p, 1, { size: [3, 6], speed: 2, life: [0.6, 1.2], color: 0x3a3028 });
      let boom = null;
      if (r.deflected) {
        if (this.alive && p.distanceTo(this.wp.chestC) < 0.45 * S) {
          boom = 'boss';
          this.takeHit(650, p.clone(), r.vel.clone().normalize(), 'rock', this.coreCap);
        }
      } else if (p.distanceTo(_h) < 4.8 * K && !this.battle.heroDown) {
        boom = 'hero';
        this.battle.hurtHero(22, r.vel.clone().normalize().setY(0.3).normalize().multiplyScalar(120));
      }
      if (!boom && (W.city.segAt(p, 1.5) || p.y <= groundHeight(p.x, p.z) + 1)) boom = 'world';
      if (!boom && r.life > 9) boom = 'world';
      if (boom) {
        const c = p.clone();
        W.debris.explode(c, 30, 40);
        W.dust.burst(c, 16, { size: [6, 14], speed: 25, life: [1.5, 3] });
        W.sparks.burst(c, 20, { size: [0.6, 1.6], speed: 30, life: [0.3, 0.8], color: 0xff9040 });
        W.effects.shockwave(c, { type: 'sphere', radius: 18, life: 0.5, opacity: 0.4, color: 0xffb070 });
        W.impact?.(c, 30, 30);
        const hit = (city) => city.damageRadius(c, 14 * K, 700, 50, r.vel.clone().normalize());
        if (r.deflected) hit(W.city); else this.smash(hit);
        this.sound('hit', 1, c);
        this.scene.remove(m);
        this.rocks.splice(i, 1);
      }
    }
  }

  // Ударная волна от удара о землю: бьёт тех, кто у земли, — подпрыгни!
  updateWaves(dt, player) {
    _h.copy(player.pos);
    for (let i = this.waves.length - 1; i >= 0; i--) {
      const w = this.waves[i];
      w.t += dt;
      const t = w.t / w.life;
      if (t >= 1) { this.waves.splice(i, 1); continue; }
      const r = (1 - (1 - t) ** 3) * w.R;
      const d = Math.hypot(_h.x - w.p.x, _h.z - w.p.z);
      const low = _h.y - groundHeight(_h.x, _h.z) < 9;
      if (!w.hit && low && Math.abs(d - r) < 8 && !this.battle.heroDown) {
        w.hit = true;
        const dir = _v.set(_h.x - w.p.x, 0, _h.z - w.p.z).normalize();
        dir.y = 0.8;
        this.battle.hurtHero(26, dir.normalize().multiplyScalar(100));
      }
    }
  }

  // ================================================================ попадания героя
  // Луч (лазер героя): расстояние до первой капсулы или null
  rayHit(origin, dir, maxDist) {
    if (!this.alive && this.state !== 'dying') return null;
    const end = _e.copy(origin).addScaledVector(dir, maxDist);
    let best = null;
    for (const c of [this.coreCap, ...this.caps]) {
      const A = this.wp[c.a], B = this.wp[c.b];
      const d2 = segSeg(origin, end, A, B, _c1, _c2);
      if (d2 >= c.r * c.r) continue;
      const along = _c1.distanceTo(origin) - Math.sqrt(c.r * c.r - d2);
      if (!best || along < best.dist) best = { dist: Math.max(0, along), cap: c };
    }
    return best;
  }

  // Удар по сфере (кулак, мощный удар): сначала — отбить скалу, затем — по телу
  hit(center, r, dmg, dir, kind) {
    if (!this.root.visible) return false;
    for (const rk of this.rocks) {
      if (rk.held || rk.deflected) continue;
      if (rk.mesh.position.distanceTo(center) < r + 4.5 * K) {
        rk.deflected = true;
        rk.life = 0;
        this.world.effects.shockwave(rk.mesh.position.clone(), { type: 'sphere', radius: 10, life: 0.35, opacity: 0.5 });
        this.battle.banner('ОТБИТО!', 1);
        return true;
      }
    }
    if (center.distanceTo(this.wp.chestC) > 0.9 * S + r) return false;
    let best = null, bd = Infinity;
    for (const c of [this.coreCap, ...this.caps]) {
      segSeg(center, center, this.wp[c.a], this.wp[c.b], _c1, _c2);
      const d = _c1.distanceTo(_c2) - c.r;
      if (d < r && d < bd) { bd = d; best = c; _v.copy(_c2); }
    }
    if (!best) return false;
    const p = _v.addScaledVector(_v2.subVectors(center, _v).normalize(), best.r).clone();
    this.takeHit(dmg, p, dir, kind, best);
    return true;
  }

  takeHit(dmg, point, dir, kind, cap = null) {
    const W = this.world;
    if (!this.root.visible || this.state === 'dead') return;
    if (this.invulnerable) {
      if (Math.random() < 0.3) W.sparks.burst(point, 4, { size: [0.3, 0.8], speed: 12, life: [0.1, 0.3], color: 0xffd0a0 });
      return;
    }
    let m = cap?.mult ?? 1;
    if (cap?.core && this.state === 'stagger') m = 3;
    else if (this.state === 'stagger') m *= 1.3;
    if (kind === 'punch') m *= 1.6;
    const d = dmg * m;
    this.hp -= d;
    this.poise += d;
    if (this.atk?.type === 'nova') this.atk.taken += d;
    this.hitFlash = Math.min(1, this.hitFlash + d / 500);
    this.flinch = Math.min(1, this.flinch + d / 1400);
    if (kind !== 'laser' || Math.random() < 0.3) {
      W.sparks.burst(point, Math.min(30, 4 + Math.round(d / 25)), { size: [0.4, 1.4], speed: 20, life: [0.2, 0.6], color: cap?.core ? 0xffe0a0 : 0xff8a30 });
    }
    if (d > 250) {
      // Откалываются куски камня
      const n = Math.min(10, Math.round(d / 150));
      for (let i = 0; i < n; i++) {
        const sz = 0.8 + Math.random() * 2.2;
        W.debris.spawn(point.x, point.y, point.z, sz, sz * 0.7, sz,
          (dir?.x || 0) * 15 + (Math.random() - 0.5) * 20, 5 + Math.random() * 12, (dir?.z || 0) * 15 + (Math.random() - 0.5) * 20, this.rockMat.color, 0);
      }
      W.dust.burst(point, 6, { size: [3, 7], speed: 8, life: [1, 2], color: 0x3a3028 });
    }
    if (cap?.core && d > 100) W.effects.flash(point, 30);
    if (kind === 'ram' || kind === 'slam' || kind === 'car' || kind === 'rock') this.sound('hit', 1, point);

    if (this.state === 'lifted' || this.state === 'thrown') { this.hp = Math.max(1, this.hp); return; }
    if (this.hp <= 0) { this.die(); return; }
    // Смена фазы
    const ph = this.hp > TITAN.hp * 2 / 3 ? 1 : this.hp > TITAN.hp / 3 ? 2 : 3;
    if (ph > this.phase) {
      this.phase = ph;
      this.battle.onPhase(ph);
      this.startRoar();
      return;
    }
    if (this.poise > TITAN.poiseMax && this.state === 'fight' && this.atk?.type !== 'nova') this.startStagger();
  }

  die() {
    this.releaseHero();
    this.dropFromHero();
    this.hp = 0;
    this.state = 'dying';
    this.stT = 0;
    this.atk = null;
    this.clearProjectiles();
    this.glowL.material.opacity = this.glowR.material.opacity = 0;
    this.sound('roar', 0.8, this.wp.headTop.clone());
    this.battle.onBossDown();
  }

  // Тело Колосса твёрдое: герой отскакивает, на скорости — таранит, в пике (X) — бьёт сверху
  collideHero(player) {
    if (!this.root.visible || this.state === 'intro') return;
    _h.copy(player.pos); _h.y += 1;
    if (_h.distanceTo(this.wp.chestC) > 3 * S && this.prevHero.distanceTo(this.wp.chestC) > 3 * S) return;
    let best = null, bd = Infinity;
    const q = new THREE.Vector3(), a = new THREE.Vector3();
    for (const c of this.caps) {
      const d2 = segSeg(this.prevHero, _h, this.wp[c.a], this.wp[c.b], _c1, _c2);
      const lim = c.r + 0.9;
      if (d2 < lim * lim && d2 < bd) { bd = d2; best = c; q.copy(_c1); a.copy(_c2); }
    }
    if (!best) return;
    const W = this.world;
    const n = _v2.subVectors(q, a);
    if (n.lengthSq() < 1e-6) n.copy(player.vel).negate();
    if (n.lengthSq() < 1e-6) n.set(0, 1, 0);
    n.normalize();
    const speed = player.vel.length();
    const contact = a.clone().addScaledVector(n, best.r);
    if (player.slamming) {
      player.slamming = false;
      this.takeHit(1100, contact, new THREE.Vector3(0, -1, 0), 'slam', best);
      player.vel.copy(n).multiplyScalar(30);
      player.vel.y = Math.max(player.vel.y, 25);
      W.effects.shockwave(contact.clone(), { type: 'sphere', radius: 25, life: 0.6, opacity: 0.5 });
      W.effects.impactFX(0.8, contact, 0.3, 10);
      player.hitstop = 0.09;
    } else if (speed > 80 && this.alive) {
      this.takeHit(Math.min(1600, speed * 1.5), contact, player.vel.clone().normalize(), 'ram', best);
      player.vel.copy(n).multiplyScalar(Math.min(60, speed * 0.25));
      W.effects.shockwave(contact.clone(), { type: 'sphere', radius: 14, life: 0.4, opacity: 0.5 });
      W.effects.impactFX(0.6, contact, 0.15, 8);
      player.hitstop = 0.07;
      player.dashT = 0;
    }
    // Выталкиваем из тела
    player.pos.copy(a).addScaledVector(n, best.r + 0.95);
    player.pos.y -= 1;
    const vn = player.vel.dot(n);
    if (vn < 0) player.vel.addScaledVector(n, -vn);
    if (player.grounded && player.pos.y > groundHeight(player.pos.x, player.pos.z) + 0.5) player.grounded = false;
  }

  // Брошенные героем машины и обломки
  hitByThrown() {
    if (!this.alive) return;
    const W = this.world, C = this.wp.chestC;
    const test = (p) => {
      if (p.distanceTo(C) > 0.9 * S + 4) return null;
      for (const c of this.caps) {
        segSeg(p, p, this.wp[c.a], this.wp[c.b], _c1, _c2);
        if (_c1.distanceTo(_c2) < c.r + 2) return c;
      }
      return null;
    };
    for (const car of W.traffic?.cars || []) {
      if (!car.thrown || car.state !== 'fly') continue;
      const sp = car.vel.length();
      if (sp < 40) continue;
      const c = test(car.pos);
      if (!c) continue;
      this.takeHit(Math.min(550, sp * 3), car.pos.clone(), car.vel.clone().normalize(), 'car', c);
      if (car.hp > 0) W.traffic.explode(car);
      car.vel.multiplyScalar(-0.2);
      car.thrown = false;
    }
    const D = W.debris;
    for (let i = 0; i < D.high; i++) {
      if (!D.thrown[i] || D.state[i] !== 1) continue;
      const i3 = i * 3;
      _v.set(D.pos[i3], D.pos[i3 + 1], D.pos[i3 + 2]);
      const sp = Math.hypot(D.vel[i3], D.vel[i3 + 1], D.vel[i3 + 2]);
      if (sp < 35) continue;
      const c = test(_v);
      if (!c) continue;
      this.takeHit(Math.min(400, sp * 2), _v.clone(), _v2.set(D.vel[i3], D.vel[i3 + 1], D.vel[i3 + 2]).normalize(), 'rock', c);
      D.thrown[i] = 0;
      D.vel[i3] *= -0.2; D.vel[i3 + 1] *= -0.2; D.vel[i3 + 2] *= -0.2;
    }
  }
}
