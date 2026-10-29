import * as THREE from 'three';
import { smoothstep, lerp } from '../utils.js';
import { loadSkinnedHero } from './skinned.js';
import { Cape } from './cape.js';

// Процедурная модель героя (собственный образ) + процедурная анимация.
// Модель смотрит вдоль +Z, ступни в начале координат. Правая сторона персонажа — это -X.

const JOINTS = ['pelvis', 'spine', 'chest', 'neck', 'shL', 'elL', 'shR', 'elR', 'hipL', 'knL', 'ankL', 'hipR', 'knR', 'ankR'];

const POSE = {
  // Гордая стойка: грудь вперёд, подбородок приподнят, ноги чуть шире плеч
  stand: {
    spine: [-0.03, 0, 0], chest: [-0.07, 0, 0], neck: [0.05, 0, 0],
    shL: [0.04, 0, 0.16], shR: [0.04, 0, -0.16], elL: [-0.18, 0, 0], elR: [-0.18, 0, 0],
    hipL: [0, 0, 0.07], hipR: [0, 0, -0.07], ankL: [0, 0, -0.07], ankR: [0, 0, 0.07],
  },
  hover: {
    spine: [0.05, 0, 0], neck: [0, 0, 0],
    shL: [-0.1, 0, 0.35], shR: [-0.1, 0, -0.35], elL: [-0.45, 0, 0], elR: [-0.45, 0, 0],
    hipL: [-0.35, 0, 0.04], knL: [0.7, 0, 0], ankL: [0.45, 0, 0],
    hipR: [-0.05, 0, -0.04], knR: [0.25, 0, 0], ankR: [0.5, 0, 0],
  },
  fly: {
    neck: [-0.75, 0, 0],
    shR: [-3.0, 0, 0.08], elR: [0, 0, 0],
    shL: [0.25, 0, 0.14], elL: [-0.25, 0, 0],
    hipL: [0.06, 0, 0.03], knL: [0.12, 0, 0], ankL: [0.9, 0, 0],
    hipR: [-0.02, 0, -0.03], knR: [0.4, 0, 0], ankR: [0.9, 0, 0],
  },
  // Приземление на одно колено, кулак упирается в землю
  land: {
    pelvis: [0, 0, 0], spine: [0.55, 0, 0], chest: [0.2, 0, 0], neck: [-0.55, 0, 0],
    hipL: [-1.55, 0, 0.15], knL: [1.65, 0, 0], ankL: [-0.1, 0, 0],
    hipR: [0.25, 0, -0.1], knR: [1.95, 0, 0], ankR: [0.9, 0, 0],
    shR: [-0.55, 0, -0.15], elR: [-0.15, 0, 0],
    shL: [0.35, 0, 0.75], elL: [-0.5, 0, 0],
  },
  // Воздушное торможение: корпус назад, руки и ноги вперёд
  brake: {
    spine: [-0.35, 0, 0], neck: [0.25, 0, 0],
    shL: [-1.1, 0, 0.9], shR: [-1.1, 0, -0.9], elL: [-0.35, 0, 0], elR: [-0.35, 0, 0],
    hipL: [-0.9, 0, 0.15], knL: [0.5, 0, 0], ankL: [0.3, 0, 0],
    hipR: [-0.7, 0, -0.15], knR: [0.6, 0, 0], ankR: [0.3, 0, 0],
  },
  slam: {
    spine: [0.3, 0, 0], neck: [0.2, 0, 0],
    shL: [-2.7, 0, 0.25], shR: [-2.7, 0, -0.25], elL: [-0.5, 0, 0], elR: [-0.5, 0, 0],
    hipL: [-1.3, 0, 0.1], knL: [1.9, 0, 0], ankL: [0.4, 0, 0],
    hipR: [-1.1, 0, -0.1], knR: [1.7, 0, 0], ankR: [0.4, 0, 0],
  },
};

export class HeroModel {
  constructor() {
    this.group = new THREE.Group();
    this.j = {};
    this.t = 0;
    this.build();
    this.group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.skinned = null;
    this.cape = null;
    this.loadBody();
  }

  // Человеческое тело со скелетом (Free Rigged Male Basemesh, автор Filip, CC-BY-4.0).
  // Пока грузится — виден процедурный «манекен».
  loadBody() {
    loadSkinnedHero('assets/models/hero/scene.gltf', { height: 1.88, chestScale: 1.1 }).then((sk) => {
      const body = sk.meshes.find((m) => m.geometry.attributes.position.count > 5000);
      const eyes = sk.meshes.filter((m) => m !== body);
      for (const m of eyes) m.material = createEyeMaterial();
      this.eyeMats = eyes.map((m) => m.material);
      body.material = createSuitMaterial(sk, body, eyes);
      buildHair(sk, body);
      buildBoots(sk, body);
      this.group.traverse((o) => { if (o.isMesh) o.visible = false; });
      this.group.add(sk.scene);
      sk.scene.traverse((o) => { if (o.isMesh) o.visible = true; });
      this.skinned = sk;
      this.cape = new Cape(this.group);
    }).catch((e) => console.warn('Модель персонажа не загрузилась, остаётся процедурная:', e));
  }

  // Глаза светятся красным, пока работает лазер
  setEyeGlow(k) {
    if (!this.eyeMats) return;
    for (const m of this.eyeMats) { m.emissive.setRGB(1, 0.12, 0.05); m.emissiveIntensity = k * 8; }
  }

  // Положение кости в координатах группы модели
  bonePos(name, out) {
    this.skinned.bone(name).getWorldPosition(out);
    return this.group.worldToLocal(out);
  }

  // gravity, wind — ускорения в локальных координатах модели; onGround — стоим ли на земле
  updateCape(dt, gravity, wind, onGround = false) {
    if (!this.cape) return;
    this.cape.floorY = onGround ? 0.03 : null;
    this.group.updateMatrixWorld(true);
    const back = new THREE.Vector3(0, 0, -1).applyQuaternion(this.rigQuat('chest'));
    const aL = this.bonePos('LeftShoulder', new THREE.Vector3()).addScaledVector(back, 0.11);
    const aR = this.bonePos('RightShoulder', new THREE.Vector3()).addScaledVector(back, 0.11);
    aL.x += 0.14; aR.x -= 0.14; // плащ шире плеч
    const c = this.cape.colliders;
    c.length = 0;
    c.push({ c: this.bonePos('Spine2', new THREE.Vector3()), r: 0.2 });
    c.push({ c: this.bonePos('Spine', new THREE.Vector3()), r: 0.18 });
    c.push({ c: this.bonePos('Hips', new THREE.Vector3()), r: 0.19 });
    for (const n of ['LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg']) {
      const a = this.bonePos(n, new THREE.Vector3());
      c.push({ c: a.add(new THREE.Vector3(0, -0.18, 0)), r: 0.11 });
    }
    this.cape.update(dt, aL, aR, gravity, wind);
  }

  rigQuat(name) {
    const q = new THREE.Quaternion();
    let o = this.j[name];
    while (o && o !== this.group) { q.premultiply(o.quaternion); o = o.parent; }
    return q;
  }

  build() {
    // Собственный образ героя: графитовый костюм, стальные пластины, изумрудные акценты
    const suit = new THREE.MeshStandardMaterial({ color: 0x1c1f26, roughness: 0.55, metalness: 0.15 });
    const armor = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.3, metalness: 0.85 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.4, metalness: 0.6 });
    const accent = new THREE.MeshStandardMaterial({ color: 0x1fbf8f, emissive: 0x0f8f68, emissiveIntensity: 0.6, roughness: 0.3, metalness: 0.4 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xd9a47e, roughness: 0.65 });
    const hairMat = new THREE.MeshStandardMaterial({ color: 0x2a1c14, roughness: 0.8 });
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0x1a2a2a, roughness: 0.2 });

    const joint = (name, parent, x, y, z) => {
      const g = new THREE.Group();
      g.position.set(x, y, z);
      parent.add(g);
      this.j[name] = g;
      return g;
    };
    const capsule = (parent, r, len, mat, y = -len / 2, sx = 1, sz = 1) => {
      const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 6, 14), mat);
      m.position.y = y;
      m.scale.set(sx, 1, sz);
      parent.add(m);
      return m;
    };

    // Таз, пояс и торс
    const pelvis = joint('pelvis', this.group, 0, 1.0, 0);
    capsule(pelvis, 0.14, 0.12, suit, 0.0, 1.25, 0.85).rotation.z = Math.PI / 2;
    const belt = new THREE.Mesh(new THREE.TorusGeometry(0.165, 0.022, 8, 28), accent);
    belt.rotation.x = Math.PI / 2;
    belt.scale.set(1.05, 0.72, 1);
    belt.position.y = 0.06;
    pelvis.add(belt);
    const spine = joint('spine', pelvis, 0, 0.08, 0);
    capsule(spine, 0.13, 0.12, suit, 0.1, 1.15, 0.8);
    const chest = joint('chest', spine, 0, 0.2, 0);
    capsule(chest, 0.16, 0.14, suit, 0.1, 1.3, 0.78);
    // Стальной нагрудник и эмблема
    const plate = new THREE.Mesh(new THREE.CapsuleGeometry(0.13, 0.08, 6, 14), armor);
    plate.scale.set(1.35, 1, 0.55);
    plate.position.set(0, 0.12, 0.045);
    chest.add(plate);
    const emblem = new THREE.Mesh(new THREE.OctahedronGeometry(0.045), accent);
    emblem.scale.set(0.8, 1.2, 0.35);
    emblem.position.set(0, 0.13, 0.125);
    chest.add(emblem);

    // Голова: открытое лицо, тёмные волосы зачёсаны назад
    const neck = joint('neck', chest, 0, 0.27, 0);
    capsule(neck, 0.055, 0.06, skin, 0.03);
    const head = new THREE.Group();
    head.position.y = 0.16;
    neck.add(head);
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.115, 24, 18), skin);
    skull.scale.set(0.9, 1.1, 1);
    head.add(skull);
    const jaw = new THREE.Mesh(new THREE.SphereGeometry(0.085, 16, 10), skin);
    jaw.scale.set(1.0, 0.7, 1.0);
    jaw.position.set(0, -0.06, 0.02);
    head.add(jaw);
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.016, 10, 8), eyeMat);
      eye.position.set(s * 0.04, 0.015, 0.1);
      head.add(eye);
      const brow = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.01, 0.015), hairMat);
      brow.position.set(s * 0.04, 0.042, 0.103);
      brow.rotation.z = s * 0.12;
      head.add(brow);
    }
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.124, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.5), hairMat);
    hair.scale.set(0.95, 1.05, 1.12);
    hair.position.set(0, 0.02, -0.02);
    hair.rotation.x = -0.35;
    head.add(hair);

    // Руки: стальные наплечники, тёмные перчатки
    for (const [side, s] of [['L', 1], ['R', -1]]) {
      const sh = joint('sh' + side, chest, s * 0.25, 0.18, 0);
      const pad = new THREE.Mesh(new THREE.SphereGeometry(0.085, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), armor);
      pad.scale.set(1.1, 0.9, 1.1);
      pad.position.y = 0.01;
      sh.add(pad);
      capsule(sh, 0.058, 0.2, suit, -0.14);
      const el = joint('el' + side, sh, 0, -0.3, 0);
      capsule(el, 0.052, 0.18, suit, -0.12);
      const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.062, 0.08, 14), dark);
      cuff.position.y = -0.2;
      el.add(cuff);
      const fist = new THREE.Mesh(new THREE.SphereGeometry(0.06, 14, 10), dark);
      fist.scale.set(0.95, 1.1, 1.05);
      fist.position.y = -0.28;
      el.add(fist);
      this['fist' + side] = fist;
    }

    // Ноги: костюм и стальные сапоги
    for (const [side, s] of [['L', 1], ['R', -1]]) {
      const hip = joint('hip' + side, pelvis, s * 0.1, -0.04, 0);
      capsule(hip, 0.078, 0.3, suit, -0.21);
      const kn = joint('kn' + side, hip, 0, -0.44, 0);
      capsule(kn, 0.064, 0.3, suit, -0.2);
      const shin = new THREE.Mesh(new THREE.CapsuleGeometry(0.067, 0.14, 4, 10), dark);
      shin.position.y = -0.33;
      kn.add(shin);
      const ank = joint('ank' + side, kn, 0, -0.43, 0);
      const boot = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.12, 4, 10), dark);
      boot.rotation.x = Math.PI / 2;
      boot.position.set(0, -0.035, 0.05);
      ank.add(boot);
    }
  }

  fistWorldPos(side, out) {
    if (this.skinned) return this.skinned.bone(side === 'L' ? 'LeftHand' : 'RightHand').getWorldPosition(out);
    return this['fist' + side].getWorldPosition(out);
  }

  // p: { stand, hover, fly, slam, run, runPhase, sprint, punch:{side,t,power,pitch}|null, charge, bob }
  animate(dt, p) {
    this.t += dt;
    const acc = {};
    for (const n of JOINTS) acc[n] = [0, 0, 0];
    const add = (pose, w) => {
      if (w <= 0) return;
      for (const n in pose) { const a = acc[n], v = pose[n]; a[0] += v[0] * w; a[1] += v[1] * w; a[2] += v[2] * w; }
    };

    const total = p.stand + p.hover + p.fly + p.slam + 1e-6;
    add(POSE.stand, p.stand / total);
    add(POSE.hover, p.hover / total);
    add(POSE.fly, p.fly / total);
    add(POSE.slam, p.slam / total);
    // Приземление на колено перекрывает стойку
    if (p.land > 0.01) for (const n in POSE.land) {
      const a = acc[n], v = POSE.land[n];
      for (let i = 0; i < 3; i++) a[i] = lerp(a[i], v[i], p.land);
    }
    // Гладим животное: опускаемся на колено, рука гладит по спине
    if (p.pet > 0.01) {
      const k = p.pet * 0.85;
      for (const n in POSE.land) {
        const a = acc[n], v = POSE.land[n];
        for (let i = 0; i < 3; i++) a[i] = lerp(a[i], v[i], k);
      }
      const stroke = Math.sin(this.t * 4.5);
      mixArm(acc, 'R', [-0.75 + stroke * 0.22, 0, -0.12], [-0.2 - stroke * 0.15, 0, 0], p.pet);
      acc.neck[0] += 0.35 * p.pet;
    }
    // Торможение накладывается поверх полётной позы
    if (p.brake > 0.01) for (const n in POSE.brake) {
      const a = acc[n], v = POSE.brake[n];
      for (let i = 0; i < 3; i++) a[i] = lerp(a[i], v[i], p.brake);
    }

    // Бег (процедурный цикл)
    if (p.run > 0) {
      const w = p.run * (p.stand / total), ph = p.runPhase, amp = lerp(0.8, 1.15, p.sprint);
      const sn = Math.sin(ph);
      acc.hipL[0] += -sn * amp * w;
      acc.hipR[0] += sn * amp * w;
      acc.knL[0] += (0.25 + Math.max(0, Math.sin(ph + 1.6)) * 1.4 * amp) * w;
      acc.knR[0] += (0.25 + Math.max(0, Math.sin(ph + 1.6 + Math.PI)) * 1.4 * amp) * w;
      acc.shL[0] += sn * 0.9 * amp * w;
      acc.shR[0] += -sn * 0.9 * amp * w;
      acc.elL[0] += -1.3 * w;
      acc.elR[0] += -1.3 * w;
      acc.spine[0] += lerp(0.15, 0.45, p.sprint) * w;
      acc.neck[0] += -lerp(0.1, 0.35, p.sprint) * w;
    }

    // Дыхание / покачивание в воздухе
    const breathe = Math.sin(this.t * 2.2);
    acc.chest[0] += breathe * 0.02;
    acc.shL[2] += breathe * 0.03 * p.hover;
    acc.shR[2] -= breathe * 0.03 * p.hover;
    acc.knL[0] += Math.sin(this.t * 1.6) * 0.08 * p.hover;

    // Зарядка мощного удара (правая рука)
    if (p.charge > 0) {
      const k = smoothstep(0, 0.4, p.charge);
      mixArm(acc, 'R', [0.8, 0, -0.35], [-2.3, 0, 0], k);
      acc.spine[1] += -0.6 * k;
      acc.chest[1] += -0.25 * k;
      acc.shL[0] += -0.6 * k;
      acc.shL[2] += 0.3 * k;
    }

    // Держим тяжёлое над головой
    if (p.lift > 0.01) {
      mixArm(acc, 'L', [-2.85, 0, 0.32], [-0.55, 0, 0], p.lift);
      mixArm(acc, 'R', [-2.85, 0, -0.32], [-0.55, 0, 0], p.lift);
      acc.spine[0] -= 0.12 * p.lift;
    }
    // Несём человека на руках
    if (p.carry > 0.01) {
      mixArm(acc, 'L', [-1.2, 0, 0.1], [-1.1, 0, 0], p.carry);
      mixArm(acc, 'R', [-1.2, 0, -0.1], [-1.1, 0, 0], p.carry);
    }

    // Удар
    if (p.punch) {
      const { side, t, power, pitch } = p.punch;
      const s = side === 'R' ? 1 : -1;
      const strike = smoothstep(0.12, 0.3, t);
      const w = t < 0.75 ? 1 : 1 - smoothstep(0.75, 1, t);
      const windSh = [0.5, 0, s * -0.3], windEl = [-2.1, 0, 0];
      const hitSh = [-1.57 - pitch, 0, s * 0.12], hitEl = [-0.05, 0, 0];
      const sh = windSh.map((v, i) => lerp(v, hitSh[i], strike));
      const el = windEl.map((v, i) => lerp(v, hitEl[i], strike));
      mixArm(acc, side, sh, el, w);
      const twist = lerp(-0.35, 0.55 + power * 0.25, strike) * s * w;
      acc.spine[1] += twist * 0.6;
      acc.chest[1] += twist * 0.5;
      acc.pelvis[1] += twist * 0.2;
      // Вторая рука уходит назад для баланса
      const other = side === 'R' ? 'L' : 'R';
      acc['sh' + other][0] += 0.5 * strike * w;
      acc['el' + other][0] += -1.2 * w;
    }

    for (const n of JOINTS) {
      const a = acc[n];
      this.j[n].rotation.set(a[0], a[1], a[2]);
    }
    this.j.pelvis.position.y = 1.0 + (p.bob || 0) - 0.5 * Math.max(p.land || 0, (p.pet || 0) * 0.85);
    if (this.skinned) this.skinned.sync(this);
  }
}

// Плавно ведёт плечо и локоть руки к заданной позе
function mixArm(acc, side, sh, el, w) {
  const A = acc['sh' + side], B = acc['el' + side];
  for (let i = 0; i < 3; i++) {
    A[i] = lerp(A[i], sh[i], w);
    B[i] = lerp(B[i], el[i], w);
  }
}

// Рельеф (bump) по процедурной карте высот h (в метрах) — без текстур.
// Метод Mikkelsen: производные позиции и высоты по экрану дают наклон нормали.
const BUMP_GLSL = `
  vec3 heroBump(vec3 pos, vec3 n, float h) {
    vec3 dpx = dFdx(pos), dpy = dFdy(pos);
    float dhx = dFdx(h), dhy = dFdy(h);
    vec3 r1 = cross(dpy, n), r2 = cross(n, dpx);
    float det = dot(dpx, r1);
    vec3 o = abs(det) * n - sign(det) * (dhx * r1 + dhy * r2);
    float l = length(o);
    return l > 1e-12 ? o / l : n;
  }`;

// Точки скелета в исходной позе в координатах сетки, переведённые в метры
function bodyRefs(sk, mesh) {
  mesh.geometry.computeBoundingBox();
  const bb = mesh.geometry.boundingBox;
  const u = (bb.max.y - bb.min.y) / 1.88; // единиц сетки на метр
  const L = (n) => sk.bindLocal(n, mesh).divideScalar(u);
  return {
    u, top: bb.max.y / u, minY: bb.min.y / u,
    head: L('Head'), neck: L('Neck'), chest: L('Spine2'), hips: L('Hips'),
    fore: L('LeftForeArm'), hand: L('LeftHand'), knee: L('LeftLeg'), foot: L('LeftFoot'),
  };
}

// Зона волос (та же формула, что и в шейдере): > 0 — волосы, значение растёт к макушке
function hairZone(R, x, y, z) {
  if (y < R.neck.y + 0.015 || Math.abs(x - R.head.x) > 0.4) return -1;
  const t = (y - R.head.y) / Math.max(R.top - R.head.y, 1e-3);
  const back = THREE.MathUtils.clamp((R.head.z - z) / 0.08 + 0.6, 0, 1);
  // Спереди линия высокая, с залысинами у висков; сбоку — над ушами; сзади — низко
  const front = 0.76 + 0.05 * smoothstep(0.012, 0.045, Math.abs(x - R.head.x));
  return t - lerp(front, 0.05, back * back);
}

// Костюм рисуется шейдером по зонам тела (в координатах исходной позы сетки):
// белый костюм с V-образными панелями и красной окантовкой, тёмно-красные кожаные
// перчатки, сапоги и пояс, золотые кромки и пряжка, своя эмблема — круг с вытянутой
// звездой надежды. Ткань, швы и эмблема имеют рельеф. Лицо, брови, волосы.
function createSuitMaterial(sk, mesh, eyes) {
  const R = bodyRefs(sk, mesh);
  // Центр левого глаза в метрах (для бровей)
  let eye = new THREE.Vector3(0.035, R.head.y + 0.06, R.head.z + 0.09);
  if (eyes.length) {
    // Оба глаза могут быть одной сеткой: берём общий габарит и радиус глаза
    const toBody = sk.meshInv.get(mesh), box = new THREE.Box3();
    for (const m of eyes) {
      m.geometry.computeBoundingBox();
      box.union(m.geometry.boundingBox.clone().applyMatrix4(sk.meshInv.get(m).clone().invert()).applyMatrix4(toBody));
    }
    box.min.divideScalar(R.u); box.max.divideScalar(R.u);
    const er = (box.max.y - box.min.y) / 2;
    eye = new THREE.Vector3(R.head.x + Math.max(0.02, (box.max.x - box.min.x) / 2 - er), (box.min.y + box.max.y) / 2, box.max.z - er);
  }

  const mat = new THREE.MeshPhysicalMaterial({ roughness: 0.55, metalness: 0.0, sheen: 0.35, sheenRoughness: 0.6, sheenColor: new THREE.Color(0.9, 0.9, 0.95) });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      uHead: { value: R.head }, uNeckY: { value: R.neck.y }, uTop: { value: R.top },
      uChest: { value: R.chest }, uHipsY: { value: R.hips.y },
      uBracerX: { value: R.fore.x + (R.hand.x - R.fore.x) * 0.42 },
      uBootY: { value: R.knee.y - (R.knee.y - R.foot.y) * 0.38 },
      uU: { value: R.u }, uEye: { value: eye }, uFootTop: { value: R.minY + 0.08 },
    });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBind;\nvarying vec3 vBindN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBind = position;\nvBindN = normal;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vBind;
        varying vec3 vBindN;
        uniform vec3 uHead, uChest, uEye;
        uniform float uNeckY, uTop, uHipsY, uBracerX, uBootY, uU, uFootTop;
        float zoneRed = 0.0, zoneSkin = 0.0, zoneHair = 0.0, zoneGold = 0.0, suitH = 0.0;
        ${BUMP_GLSL}
        float segDist(vec2 p, vec2 a, vec2 b) {
          vec2 pa = p - a, ba = b - a;
          return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 p = vBind / uU;          // метры
          if (p.y < uFootTop) discard;  // ступня спрятана под сапогом
          vec3 nb = normalize(vBindN);
          // Цвета в линейном пространстве
          vec3 white = vec3(0.56, 0.56, 0.545);
          vec3 pearl = vec3(0.42, 0.435, 0.46);
          vec3 red = vec3(0.27, 0.016, 0.022);
          vec3 gold = vec3(0.6, 0.4, 0.12);
          vec3 skin = vec3(0.52, 0.28, 0.18);
          vec3 hair = vec3(0.03, 0.018, 0.011);
          // Размер пикселя на поверхности — мелкий рельеф гасим вдали (без ряби)
          float px = length(fwidth(p));
          float fine = 1.0 - smoothstep(0.0008, 0.0025, px);

          // ---- V-панели корпуса: от плеч к поясу, спереди и сзади ----
          float beltY = uHipsY + 0.11;
          vec2 vA = vec2(sign(p.x - uChest.x) * 0.19 + uChest.x, uNeckY - 0.04);
          vec2 vB = vec2(uChest.x, beltY + 0.035);
          float torso = step(beltY, p.y) * step(p.y, uNeckY - 0.02) * step(abs(p.x - uChest.x), 0.23);
          float vd = segDist(p.xy, vA, vB);
          float piping = torso * (1.0 - smoothstep(0.0025, 0.0045, vd));
          float k = clamp((p.y - vB.y) / (vA.y - vB.y), 0.0, 1.0);
          float inside = torso * step(abs(p.x - uChest.x), k * 0.19);
          vec3 col = mix(pearl, white, max(inside, 1.0 - torso));
          col = mix(col, white * 0.94, (1.0 - torso) * step(uBootY, p.y) * smoothstep(0.3, 0.9, abs(nb.x)) * 0.5);
          suitH += piping * 0.0012 - torso * (1.0 - smoothstep(0.004, 0.007, vd)) * 0.0004;

          // ---- Перчатки с наручами и сапоги: кожа с зерном, золотая кромка ----
          float bracer = step(uBracerX, abs(p.x));
          float boot = step(p.y, uBootY);
          zoneRed = max(bracer, boot);
          float trim = max(1.0 - smoothstep(0.004, 0.007, abs(abs(p.x) - uBracerX)),
                           1.0 - smoothstep(0.004, 0.007, abs(p.y - uBootY)));
          zoneGold = max(zoneGold, trim);
          suitH += trim * 0.0018 + zoneRed * 0.0015;

          // ---- Пояс с пряжкой ----
          float bd = abs(p.y - beltY);
          float belt = step(bd, 0.03) * step(abs(p.x - uChest.x), 0.21) * (1.0 - bracer);
          zoneRed = max(zoneRed, belt);
          float front = smoothstep(0.2, 0.6, nb.z);
          float buckle = belt * front * step(length(vec2(p.x - uChest.x, p.y - beltY) / vec2(1.4, 1.0)), 0.026);
          zoneGold = max(zoneGold, buckle);
          suitH += belt * 0.002 + buckle * 0.0025 - belt * (1.0 - smoothstep(0.024, 0.03, bd)) * 0.0;
          zoneRed = max(zoneRed, piping);

          // ---- Эмблема: тёмно-красный круг, золотой обод, белая звезда надежды ----
          vec2 e = p.xy - vec2(uChest.x, uChest.y + 0.05);
          float ef = step(uChest.z + 0.02, p.z) * smoothstep(0.0, 0.3, nb.z);
          float r = length(e);
          float disc = ef * (1.0 - smoothstep(0.075, 0.078, r));
          float ring = ef * (1.0 - smoothstep(0.0035, 0.006, abs(r - 0.073)));
          vec2 q = abs(e) / vec2(0.027, 0.06);
          float star = ef * (1.0 - smoothstep(0.92, 1.0, pow(q.x, 0.55) + pow(q.y, 0.55)));
          col = mix(col, red, disc);
          col = mix(col, white * 1.05, star);
          zoneGold = max(zoneGold, ring);
          suitH += disc * 0.0016 + ring * 0.001 + star * 0.0012;

          // ---- Ткань: мелкое плетение (только белые части) ----
          float suitZone = (1.0 - zoneRed) * (1.0 - zoneGold) * (1.0 - disc);
          float weave = sin(p.x * 2600.0) * sin(p.y * 2600.0 + p.z * 900.0);
          suitH += weave * 0.00012 * fine * suitZone;
          // Кожа: зерно
          float grain = fract(sin(dot(floor(p * 900.0), vec3(12.9, 78.2, 37.7))) * 43758.5);
          suitH += (grain - 0.5) * 0.00012 * fine * zoneRed;

          // ---- Лицо, брови, волосы ----
          zoneSkin = step(uNeckY + 0.015, p.y) * step(abs(p.x - uHead.x), 0.4);
          float t = (p.y - uHead.y) / max(uTop - uHead.y, 1e-3);
          float back = clamp((uHead.z - p.z) / 0.08 + 0.6, 0.0, 1.0);
          float hFront = 0.76 + 0.05 * smoothstep(0.012, 0.045, abs(p.x - uHead.x));
          float hairLine = mix(hFront, 0.05, back * back) + (fract(sin(p.x * 251.7) * 437.5) - 0.5) * 0.02;
          zoneHair = zoneSkin * smoothstep(hairLine - 0.015, hairLine + 0.015, t);
          // Брови: дуга над глазом, чуть приподнята к внешнему краю
          float ex = abs(uEye.x - uHead.x);
          float dx = abs(p.x - uHead.x) - ex;
          float browY = uEye.y + 0.026 + 0.004 * (1.0 - (dx / 0.026) * (dx / 0.026)) + dx * 0.04;
          float bw = mix(0.0045, 0.0025, clamp(dx / 0.022 * 0.5 + 0.5, 0.0, 1.0));
          float brow = zoneSkin * step(uEye.z - 0.02, p.z) * (1.0 - smoothstep(0.019, 0.024, abs(dx + 0.002)))
                       * (1.0 - smoothstep(bw * 0.7, bw, abs(p.y - browY)));
          zoneHair = max(zoneHair, brow * 0.9);
          // Лёгкий румянец на щеках и губах
          float cheek = zoneSkin * smoothstep(0.03, 0.0, abs(p.y - (uEye.y - 0.035))) * smoothstep(0.02, 0.05, abs(p.x - uHead.x));
          vec3 skinC = mix(skin, skin * vec3(1.08, 0.9, 0.88), cheek * 0.6);

          col = mix(col, red * (1.0 + grain * 0.12), zoneRed);
          col = mix(col, gold, zoneGold);
          col = mix(col, skinC, zoneSkin);
          col = mix(col, hair * (0.85 + 0.3 * fract(sin(dot(floor(p.xz * 300.0), vec2(12.9, 78.2))) * 4375.5)), zoneHair);
          suitH *= 1.0 - zoneSkin;
          diffuseColor.rgb = col;
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.33, zoneRed);
        roughnessFactor = mix(roughnessFactor, 0.28, zoneGold);
        roughnessFactor = mix(roughnessFactor, 0.6, zoneSkin);
        roughnessFactor = mix(roughnessFactor, 0.75, zoneHair);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        metalnessFactor = mix(metalnessFactor, 1.0, zoneGold * (1.0 - zoneSkin));`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        normal = heroBump(-vViewPosition, normal, suitH);`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
        material.sheenColor *= (1.0 - zoneSkin) * (1.0 - zoneRed) * (1.0 - zoneHair) * (1.0 - zoneGold);`);
  };
  return mat;
}

// Объёмная причёска: участок кожи головы в зоне волос «выдавливается» по нормалям
// (сильнее к макушке и надо лбом — зачёс назад) и становится отдельной сеткой
// на том же скелете, поэтому двигается вместе с головой.
function buildHair(sk, body) {
  const R = bodyRefs(sk, body);
  const g = body.geometry, P = g.attributes.position, N = g.attributes.normal;
  const zone = new Float32Array(P.count);
  for (let i = 0; i < P.count; i++) zone[i] = hairZone(R, P.getX(i) / R.u, P.getY(i) / R.u, P.getZ(i) / R.u);
  const idx = g.index ? g.index.array : [...Array(P.count).keys()];
  const remap = new Map(), tris = [];
  for (let k = 0; k < idx.length; k += 3) {
    const a = idx[k], b = idx[k + 1], c = idx[k + 2];
    if (Math.min(zone[a], zone[b], zone[c]) < -0.012) continue;
    for (const v of [a, b, c]) {
      if (!remap.has(v)) remap.set(v, remap.size);
      tris.push(remap.get(v));
    }
  }
  if (!tris.length) return;
  const n = remap.size;
  const pos = new Float32Array(n * 3), si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  const SI = g.attributes.skinIndex, SW = g.attributes.skinWeight;
  for (const [v, j] of remap) {
    const x = P.getX(v) / R.u, y = P.getY(v) / R.u, z = P.getZ(v) / R.u;
    const taper = Math.pow(smoothstep(-0.012, 0.3, zone[v]), 1.6);
    const frontK = THREE.MathUtils.clamp((z - R.head.z) / 0.1 + 0.5, 0, 1);
    const topK = THREE.MathUtils.clamp((y - R.head.y) / Math.max(R.top - R.head.y, 1e-3), 0, 1);
    // Толщина: тонко у кромки, объём на макушке и над лбом
    const thick = 0.0015 + taper * (0.006 + 0.012 * topK + 0.014 * frontK * topK);
    const nx = N.getX(v), ny = N.getY(v), nz = N.getZ(v);
    pos[j * 3] = (x + nx * thick) * R.u;
    pos[j * 3 + 1] = (y + ny * thick + 0.004 * frontK * taper) * R.u;
    pos[j * 3 + 2] = (z + nz * thick - 0.006 * taper * topK) * R.u; // зачёс назад
    for (let c = 0; c < 4; c++) { si[j * 4 + c] = SI.getComponent(v, c); sw[j * 4 + c] = SW.getComponent(v, c); }
  }
  const hg = new THREE.BufferGeometry();
  hg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  hg.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  hg.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  hg.setIndex(tris);
  hg.computeVertexNormals();

  const mat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color().setRGB(0.032, 0.019, 0.012), roughness: 0.48,
    sheen: 1, sheenRoughness: 0.35, sheenColor: new THREE.Color().setRGB(0.3, 0.2, 0.13),
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uU = { value: R.u };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHair;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHair = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vHair;\nuniform float uU;\n${BUMP_GLSL}\nfloat hairH = 0.0;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 p = vHair / uU;
          // Пряди идут назад (вдоль Z) с лёгкой волной
          float s = p.x * 900.0 + sin(p.z * 40.0) * 3.0;
          float strand = fract(sin(floor(s) * 91.3) * 437.5);
          float fine = 1.0 - smoothstep(0.0006, 0.002, length(fwidth(p)));
          diffuseColor.rgb *= 0.7 + 0.6 * strand;
          hairH = sin(s * 6.2832) * 0.00025 * fine;
        }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        normal = heroBump(-vViewPosition, normal, hairH);`);
  };
  const hair = new THREE.SkinnedMesh(hg, mat);
  hair.position.copy(body.position);
  hair.quaternion.copy(body.quaternion);
  hair.scale.copy(body.scale);
  hair.bind(body.skeleton, body.bindMatrix);
  hair.castShadow = true;
  hair.frustumCulled = false;
  body.parent.add(hair);
}

// Сапоги: гладкая форма по размеру ступни (узкая пятка, широкий подъём,
// закруглённый носок, плоская подошва). Ступня тела под ними скрыта шейдером.
function buildBoots(sk, body) {
  const R = bodyRefs(sk, body);
  const P = body.geometry.attributes.position;
  const toModel = sk.meshInv.get(body).clone().invert(); // сетка → система модели (метры)
  const leather = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color().setRGB(0.27, 0.016, 0.022), vertexColors: true,
    roughness: 0.3, clearcoat: 0.7, clearcoatRoughness: 0.28,
  });
  for (const [side, s] of [['Left', 1], ['Right', -1]]) {
    // Вершины ступни (нижние ~6 см) этой стороны
    const pts = [], v = new THREE.Vector3();
    for (let i = 0; i < P.count; i++) {
      if (P.getY(i) / R.u > R.minY + 0.06 || Math.sign(P.getX(i) / R.u - R.hips.x) !== s) continue;
      pts.push(v.fromBufferAttribute(P, i).applyMatrix4(toModel).clone());
    }
    if (!pts.length) continue;
    // Главная ось ступни на плоскости XZ (носок может смотреть чуть в сторону)
    let mx = 0, mz = 0, by = Infinity;
    for (const q of pts) { mx += q.x; mz += q.z; by = Math.min(by, q.y); }
    mx /= pts.length; mz /= pts.length;
    let xx = 0, xz = 0, zz = 0;
    for (const q of pts) { const dx = q.x - mx, dz = q.z - mz; xx += dx * dx; xz += dx * dz; zz += dz * dz; }
    let yaw = 0.5 * Math.atan2(2 * xz, zz - xx);
    if (Math.abs(yaw) > Math.PI / 2) yaw -= Math.sign(yaw) * Math.PI;
    const ax = Math.sin(yaw), az = Math.cos(yaw);
    let l0 = Infinity, l1 = -Infinity;
    for (const q of pts) { const l = (q.x - mx) * ax + (q.z - mz) * az; l0 = Math.min(l0, l); l1 = Math.max(l1, l); }
    const lc = (l0 + l1) / 2;
    const L = Math.min(0.3, l1 - l0 + 0.01);
    const c = new THREE.Vector3(mx + ax * lc, by - 0.004, mz + az * lc);
    const boot = new THREE.Mesh(makeBootGeometry(L, 0.108), leather);
    sk.attach(side + 'Foot', boot, c, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw));
  }
}

// Лофт по длине стопы: сечения — суперэллипсы, подошва плоская
function makeBootGeometry(L, W) {
  const NS = 28, NR = 24;
  const pos = [], col = [], idx = [];
  for (let i = 0; i <= NS; i++) {
    const t = i / NS;                                     // 0 — пятка, 1 — носок
    const end = Math.pow(Math.max(0, 1 - Math.pow(Math.abs(2 * t - 1), 5)), 0.32);
    const w = W * (0.66 + 0.34 * smoothstep(0.0, 0.62, t)) * end * 0.5;
    const h = lerp(0.115, 0.042, smoothstep(0.28, 0.95, t)) * Math.max(end, 0.15);
    const z = (t - 0.5) * L;
    for (let j = 0; j < NR; j++) {
      const a = (j / NR) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      const x = Math.sign(ca) * Math.pow(Math.abs(ca), 0.55) * w;
      // Низ почти плоский (подошва), верх скруглён
      const yy = sa < 0 ? -Math.pow(Math.abs(sa), 0.18) : Math.pow(sa, 0.8);
      const y = h * 0.5 * (1 + yy);
      pos.push(x, Math.max(0, y), z);
      const sole = y < 0.012 ? 0.2 : 1;
      col.push(sole, sole, sole * 1.05);
    }
  }
  for (let i = 0; i < NS; i++) for (let j = 0; j < NR; j++) {
    const a = i * NR + j, b = i * NR + (j + 1) % NR, c = a + NR, d = b + NR;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Глаза: белок и тёмная радужка спереди
function createEyeMaterial() {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.15 });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBind;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBind = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBind;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb = mix(vec3(0.42, 0.4, 0.37), vec3(0.025, 0.016, 0.01), step(0.162, vBind.z));`);
  };
  return mat;
}
