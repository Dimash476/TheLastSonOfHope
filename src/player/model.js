import * as THREE from 'three';
import { smoothstep, lerp } from '../utils.js';
import { loadSkinnedHero } from './skinned.js';
import { Cape } from './cape.js';

// Процедурная модель героя (собственный образ) + процедурная анимация.
// Модель смотрит вдоль +Z, ступни в начале координат. Правая сторона персонажа — это -X.

const JOINTS = ['pelvis', 'spine', 'chest', 'neck', 'shL', 'elL', 'shR', 'elR', 'hipL', 'knL', 'ankL', 'hipR', 'knR', 'ankR'];

const POSE = {
  stand: { shL: [0, 0, 0.12], shR: [0, 0, -0.12], elL: [-0.15, 0, 0], elR: [-0.15, 0, 0] },
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
    loadSkinnedHero('assets/models/hero/scene.gltf', { height: 1.88, chestScale: 1.06 }).then((sk) => {
      for (const m of sk.meshes) m.material = m.geometry.attributes.position.count > 5000 ? createSuitMaterial(sk, m) : createEyeMaterial();
      this.group.traverse((o) => { if (o.isMesh) o.visible = false; });
      this.group.add(sk.scene);
      sk.scene.traverse((o) => { if (o.isMesh) o.visible = true; });
      this.skinned = sk;
      this.cape = new Cape(this.group);
    }).catch((e) => console.warn('Модель персонажа не загрузилась, остаётся процедурная:', e));
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
    this.j.pelvis.position.y = 1.0 + (p.bob || 0) - 0.5 * (p.land || 0);
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

// Костюм рисуется шейдером по зонам тела (в координатах исходной позы сетки):
// белый матовый костюм, тёмно-красные наручи с перчатками, сапоги и пояс,
// своя эмблема-ромб на груди, открытое лицо и тёмные волосы.
function createSuitMaterial(sk, mesh) {
  const L = (n) => sk.bindLocal(n, mesh);
  mesh.geometry.computeBoundingBox();
  const top = mesh.geometry.boundingBox.max.y;
  const head = L('Head'), neck = L('Neck'), chest = L('Spine2'), hips = L('Hips');
  const fore = L('LeftForeArm'), hand = L('LeftHand'), knee = L('LeftLeg'), foot = L('LeftFoot');
  const u = (top - mesh.geometry.boundingBox.min.y) / 1.88; // единиц сетки на метр

  const mat = new THREE.MeshPhysicalMaterial({ roughness: 0.55, metalness: 0.0, sheen: 0.35, sheenRoughness: 0.6, sheenColor: new THREE.Color(0.9, 0.9, 0.95) });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      uHead: { value: head }, uNeckY: { value: neck.y }, uTop: { value: top },
      uChest: { value: chest }, uHipsY: { value: hips.y },
      uBracerX: { value: fore.x + (hand.x - fore.x) * 0.42 },
      uBootY: { value: knee.y - (knee.y - foot.y) * 0.38 },
      uU: { value: u },
    });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBind;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBind = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vBind;
        uniform vec3 uHead, uChest;
        uniform float uNeckY, uTop, uHipsY, uBracerX, uBootY, uU;
        float zoneRed = 0.0, zoneSkin = 0.0, zoneHair = 0.0;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 p = vBind;
          float m = 1.0 / uU; // метры в единицах сетки → множитель
          // Цвета в линейном пространстве
          vec3 white = vec3(0.6, 0.6, 0.58);
          vec3 red = vec3(0.3, 0.018, 0.025);
          vec3 skin = vec3(0.52, 0.27, 0.17);
          vec3 hair = vec3(0.035, 0.022, 0.014);
          vec3 col = white;

          // Тонкие швы костюма по бокам корпуса и ног
          float seam = smoothstep(0.012 * uU, 0.0, abs(abs(p.x) - (abs(p.y - uHipsY) < 0.5 * uU ? 0.155 * uU : 0.0)));
          col *= 1.0 - seam * 0.12 * step(uBootY, p.y) * step(p.y, uNeckY);

          // Наручи и перчатки, сапоги, пояс
          zoneRed = max(zoneRed, step(uBracerX, abs(p.x)));
          zoneRed = max(zoneRed, step(p.y, uBootY));
          float belt = step(abs(p.y - (uHipsY + 0.11 * uU)), 0.032 * uU) * step(abs(p.x), 0.6 * uU);
          zoneRed = max(zoneRed, belt);
          // Окантовка верха сапог и наручей
          float trim = step(abs(p.y - uBootY), 0.012 * uU) + step(abs(abs(p.x) - uBracerX), 0.012 * uU);

          // Эмблема на груди: красный ромб с белым центром и красной сердцевиной
          vec2 e = vec2(p.x - uChest.x, p.y - (uChest.y + 0.05 * uU)) / (vec2(0.085, 0.11) * uU);
          float dm = abs(e.x) + abs(e.y);
          float front = step(uChest.z + 0.06 * uU, p.z);
          float emblem = front * (step(dm, 1.0) * (1.0 - step(dm, 0.78)) + step(dm, 0.38));
          zoneRed = max(zoneRed, emblem);

          // Лицо и шея — кожа; волосы — короткая стрижка
          zoneSkin = step(uNeckY + 0.015 * uU, p.y) * step(abs(p.x), 0.4 * uU);
          float t = (p.y - uHead.y) / max(uTop - uHead.y, 1e-3);
          float back = clamp((uHead.z - p.z) / (0.08 * uU) + 0.6, 0.0, 1.0);
          float hairLine = mix(0.66, 0.05, back) + (fract(sin(p.x * 91.7) * 437.5) - 0.5) * 0.03;
          zoneHair = zoneSkin * smoothstep(hairLine - 0.02, hairLine + 0.02, t);

          col = mix(col, red * (1.0 + trim * 0.6), zoneRed);
          col = mix(col, skin, zoneSkin);
          col = mix(col, hair * (0.85 + 0.3 * fract(sin(dot(floor(p.xz * 60.0), vec2(12.9, 78.2))) * 4375.5)), zoneHair);
          diffuseColor.rgb = col;
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.38, zoneRed);
        roughnessFactor = mix(roughnessFactor, 0.62, zoneSkin);
        roughnessFactor = mix(roughnessFactor, 0.8, zoneHair);`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
        material.sheenColor *= (1.0 - zoneSkin) * (1.0 - zoneRed) * (1.0 - zoneHair);`);
  };
  return mat;
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
