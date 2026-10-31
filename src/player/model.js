import * as THREE from 'three';
import { smoothstep, lerp, clamp } from '../utils.js';
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
  // Парение: грудь раскрыта, руки слегка в стороны, одно колено согнуто, носки вниз
  hover: {
    spine: [0.02, 0, 0], chest: [-0.08, 0, 0], neck: [0.02, 0, 0],
    shL: [-0.05, 0, 0.42], shR: [-0.05, 0, -0.42], elL: [-0.4, 0, 0], elR: [-0.4, 0, 0],
    hipL: [-0.55, 0, 0.06], knL: [1.05, 0, 0], ankL: [0.6, 0, 0],
    hipR: [-0.08, 0, -0.05], knR: [0.22, 0, 0], ankR: [0.65, 0, 0],
  },
  // Полёт: руки свободно вдоль тела, ноги вместе, носки вытянуты.
  // На ускорениях обе руки уходят вперёд (см. animate, p.boost)
  fly: {
    spine: [-0.06, 0, 0], chest: [-0.08, 0, 0], neck: [-0.8, 0, 0],
    shR: [0.34, 0.12, -0.1], elR: [-0.22, 0, 0],
    shL: [0.34, -0.12, 0.1], elL: [-0.22, 0, 0],
    hipL: [0.04, 0, 0.015], knL: [0.08, 0, 0], ankL: [1.05, 0, 0],
    hipR: [-0.04, 0, -0.015], knR: [0.32, 0, 0], ankR: [1.0, 0, 0],
  },
  // Падение с уступа: руки в стороны для равновесия, ноги готовятся к приземлению
  fall: {
    spine: [0.06, 0, 0], chest: [-0.04, 0, 0], neck: [0.12, 0, 0],
    shL: [-0.55, 0, 0.85], shR: [-0.45, 0, -0.8], elL: [-0.45, 0, 0], elR: [-0.5, 0, 0],
    hipL: [-0.55, 0, 0.1], knL: [0.85, 0, 0], ankL: [0.15, 0, 0],
    hipR: [-0.2, 0, -0.08], knR: [0.5, 0, 0], ankR: [0.3, 0, 0],
  },
  // Стойка «руки на поясе» после нескольких секунд покоя
  hips: {
    shL: [0.62, -0.38, 0.62], elL: [-1.6, 0, 0],
    shR: [0.62, 0.38, -0.62], elR: [-1.6, 0, 0],
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

const _pivot = new THREE.Vector3();

export class HeroModel {
  constructor() {
    this.group = new THREE.Group();
    this.j = {};
    this.t = 0;
    this.runBob = 0;
    this.POSE = POSE;
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
      sculptBody(sk, body, eyes);
      for (const m of eyes) m.material = createEyeMaterial(m);
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
  // frameRot — поворот тела за кадр (старая → новая система), для инерции ткани
  updateCape(dt, gravity, wind, onGround = false, frameRot = null) {
    if (!this.cape) return;
    if (frameRot) this.cape.applyFrameRotation(frameRot, _pivot.copy(this.group.position).negate());
    this.cape.floorY = onGround ? 0.03 : null;
    this.group.updateMatrixWorld(true);
    const back = new THREE.Vector3(0, 0, -1).applyQuaternion(this.rigQuat('chest'));
    // Крепление — на самом верху плеч (над трапецией), чуть позади: ткань лежит на плечах
    // и спадает за спину, поэтому самого крепления не видно
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.rigQuat('chest'));
    const aL = this.bonePos('LeftShoulder', new THREE.Vector3()).addScaledVector(back, 0.045).addScaledVector(up, 0.075);
    const aR = this.bonePos('RightShoulder', new THREE.Vector3()).addScaledVector(back, 0.045).addScaledVector(up, 0.075);
    aL.x += 0.19; aR.x -= 0.19; // плащ шире плеч
    const c = this.cape.colliders;
    c.length = 0;
    // Тело с запасом на толщину ткани: спина, лопатки, поясница, ягодицы, шея
    const sp2 = this.bonePos('Spine2', new THREE.Vector3()), hips = this.bonePos('Hips', new THREE.Vector3());
    const sideV = new THREE.Vector3(1, 0, 0).applyQuaternion(this.rigQuat('chest'));
    c.push({ c: sp2, r: 0.22 });
    for (const s of [-1, 1]) c.push({ c: sp2.clone().addScaledVector(sideV, 0.1 * s).addScaledVector(back, 0.05).addScaledVector(up, 0.03), r: 0.15 });
    c.push({ c: this.bonePos('Neck', new THREE.Vector3()), r: 0.1 });
    const hipsBack = new THREE.Vector3(0, 0, -1).applyQuaternion(this.rigQuat('pelvis'));
    for (const s of [-1, 1]) c.push({ c: hips.clone().add(new THREE.Vector3(0.09 * s, -0.09, 0)).addScaledVector(hipsBack, 0.06), r: 0.14 });
    // Дельты: ткань ложится на плечи, а не проваливается в них
    c.push({ c: this.bonePos('LeftArm', new THREE.Vector3()).addScaledVector(up, 0.02), r: 0.085 });
    c.push({ c: this.bonePos('RightArm', new THREE.Vector3()).addScaledVector(up, 0.02), r: 0.085 });
    c.push({ c: this.bonePos('Spine', new THREE.Vector3()), r: 0.2 });
    c.push({ c: hips, r: 0.21 });
    // Руки и ноги — капсулами вдоль костей: при согнутом колене голень не протыкает ткань
    const cap = this.cape.capsules;
    cap.length = 0;
    const seg = (a, b, r) => cap.push({ a: this.bonePos(a, new THREE.Vector3()), b: this.bonePos(b, new THREE.Vector3()), r });
    for (const s of ['Left', 'Right']) {
      seg(s + 'UpLeg', s + 'Leg', 0.13);
      seg(s + 'Leg', s + 'Foot', 0.1);
      seg(s + 'Arm', s + 'ForeArm', 0.085);
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

    const total = p.stand + p.hover + p.fly + p.slam + (p.fall || 0) + 1e-6;
    add(POSE.stand, p.stand / total);
    add(POSE.hover, p.hover / total);
    add(POSE.fly, p.fly / total);
    add(POSE.slam, p.slam / total);
    add(POSE.fall, (p.fall || 0) / total);
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

    // Походка по биомеханике человека. Фаза u (0..1) — цикл левой ноги, 0 — касание пяткой.
    // Тазобедренный, коленный и голеностоп идут по реальным кривым шага / бега; стопа
    // в опоре стоит ровно на земле; высота таза считается из длины ног (маятник в шаге,
    // фаза полёта в беге); руки работают навстречу ногам, таз и плечи скручиваются.
    this.runBob = 0;
    const gw = (p.gait || 0) * (p.stand / total);
    if (gw > 0.001) {
      const hs = p.hs || 0, uL = fract(p.runPhase / TAU), uR = fract(uL + 0.5);
      const runK = smoothstep(2.4, 4.4, hs), sp = smoothstep(14, 45, hs);
      const G = gaitParams(runK, sp);
      const L = gaitLeg(uL, G), R = gaitLeg(uR, G);
      acc.hipL[0] -= L.hip * gw; acc.knL[0] += L.knee * gw; acc.ankL[0] += L.ank * gw;
      acc.hipR[0] -= R.hip * gw; acc.knR[0] += R.knee * gw; acc.ankR[0] += R.ank * gw;
      // Ноги ставятся почти по одной линии, а не на ширине стойки
      acc.hipL[2] -= 0.06 * gw; acc.hipR[2] += 0.06 * gw;
      acc.ankL[2] += 0.06 * gw; acc.ankR[2] -= 0.06 * gw;
      // Руки: маятник от плеча навстречу ногам; в беге локти ~90° и сильнее сгибаются впереди
      const swingL = -Math.cos(TAU * (uL - G.hipPeak)), swingR = -swingL;   // >0 — рука впереди
      const armA = lerp(0.24, lerp(0.62, 0.95, sp), runK);
      const armOff = lerp(0.06, lerp(0.12, 0.2, sp), runK);
      acc.shL[0] += (-swingL * armA + armOff) * gw;
      acc.shR[0] += (-swingR * armA + armOff) * gw;
      const elB = lerp(0.18, lerp(1.4, 1.6, sp), runK), elS = lerp(0.18, 0.3, runK);
      acc.elL[0] -= (elB - 0.18 + Math.max(0, swingL) * elS) * gw;
      acc.elR[0] -= (elB - 0.18 + Math.max(0, swingR) * elS) * gw;
      // В беге кисти чуть заходят к центру корпуса
      acc.shL[1] -= Math.max(0, swingL) * 0.18 * runK * gw; acc.shR[1] += Math.max(0, swingR) * 0.18 * runK * gw;
      acc.shL[2] -= 0.08 * runK * gw; acc.shR[2] += 0.08 * runK * gw;
      // Скручивание: таз вслед за выносимой ногой, плечи — навстречу, голова держит курс
      const yaw = Math.cos(TAU * (uL - G.hipPeak)), tw = lerp(0.07, lerp(0.11, 0.17, sp), runK);
      acc.pelvis[1] -= yaw * tw * gw;
      acc.spine[1] += yaw * tw * 0.65 * gw;
      acc.chest[1] += yaw * tw * 0.85 * gw;
      acc.neck[1] -= yaw * tw * 0.45 * gw;
      // Таз: над опорной ногой бедро выше, над маховой — чуть проседает
      const roll = Math.sin(TAU * uL) * lerp(0.045, 0.03, runK);
      acc.pelvis[2] += roll * gw;
      acc.spine[2] -= roll * 0.8 * gw;
      // Наклон корпуса растёт со скоростью, голова держит горизонт
      const lean = lerp(0.03, lerp(0.1, 0.3, sp), runK);
      acc.spine[0] += lean * gw;
      acc.chest[0] += lerp(0, 0.06, sp) * gw;
      acc.neck[0] -= lean * 0.75 * gw;
      // Высота таза: опорная стопа на земле, в беге — полёт по дуге между шагами
      this.runBob = gaitPelvis(uL, uR, L, R, G) * gw;
    }
    // Разгон / торможение и поворот: корпус наклоняется навстречу ускорению
    if (p.leanF || p.leanS) {
      const k = p.stand / total;
      acc.spine[0] += (p.leanF || 0) * k;
      acc.neck[0] -= (p.leanF || 0) * 0.6 * k;
      acc.spine[2] -= (p.leanS || 0) * 0.6 * k;
      acc.chest[2] -= (p.leanS || 0) * 0.4 * k;
      acc.neck[2] += (p.leanS || 0) * 0.5 * k;
    }
    // Присед: толчок перед взлётом и амортизация после приземления
    if (p.dip > 0.01) {
      const d = p.dip * (p.stand / total);
      acc.hipL[0] -= 0.75 * d; acc.hipR[0] -= 0.75 * d;
      acc.knL[0] += 1.25 * d; acc.knR[0] += 1.25 * d;
      acc.ankL[0] -= 0.5 * d; acc.ankR[0] -= 0.5 * d;
      acc.spine[0] += 0.35 * d; acc.neck[0] -= 0.25 * d;
      acc.shL[0] += 0.35 * d; acc.shR[0] += 0.35 * d;
      acc.elL[0] -= 0.3 * d; acc.elR[0] -= 0.3 * d;
      this.runBob -= 0.2 * d;
    }

    // Руки на поясе — уверенная поза героя в покое
    if (p.idle > 0.01) {
      mixArm(acc, 'L', POSE.hips.shL, POSE.hips.elL, p.idle);
      mixArm(acc, 'R', POSE.hips.shR, POSE.hips.elR, p.idle);
      acc.chest[0] -= 0.05 * p.idle;
      acc.hipL[2] += 0.04 * p.idle;
      acc.hipR[2] -= 0.04 * p.idle;
    }
    // Покой: дыхание, лёгкий перенос веса
    const sway = Math.sin(this.t * 0.45) * p.stand * (1 - (p.gait || 0));
    acc.pelvis[2] += sway * 0.025;
    acc.spine[2] -= sway * 0.02;

    // Полёт: ветер треплет конечности, в вираже голова и рука уходят в поворот
    if (p.fly > 0.01) {
      const w = p.fly, r = p.roll || 0, gust = (p.gust || 0) * w, f = this.t * 21;
      acc.elL[0] += Math.sin(f * 1.3 + 1) * 0.05 * gust;
      acc.shL[2] += Math.sin(f) * 0.035 * gust;
      acc.knL[0] += Math.sin(f * 0.9 + 2) * 0.06 * gust;
      acc.knR[0] += Math.sin(f * 1.1 + 4) * 0.06 * gust;
      acc.ankL[0] += Math.sin(f * 1.7) * 0.05 * gust;
      acc.neck[1] += r * 0.3 * w;
      acc.spine[1] += r * 0.12 * w;
      acc.shR[2] += r * 0.2 * w;
      acc.hipL[2] -= r * 0.1 * w;
      acc.hipR[2] -= r * 0.1 * w;
      // Набор высоты — грудь раскрыта; пике — ноги чуть сгибаются
      const climb = p.climb || 0;
      acc.chest[0] -= Math.max(0, climb) * 0.12 * w;
      acc.knR[0] += Math.max(0, -climb) * 0.15 * w;
      // Ускорение (Shift, рывок, гипер) — обе руки вытянуты вперёд, кулаки рядом
      const bk = Math.max(p.boost || 0, p.hyper || 0) * w;
      if (bk > 0.01) {
        mixArm(acc, 'L', [-3.0, 0, -0.11], [-0.05, 0, 0], bk);
        mixArm(acc, 'R', [-3.0, 0, 0.11], [-0.05, 0, 0], bk);
        acc.neck[0] -= 0.12 * bk;
      }
    }

    // Голова смотрит туда, куда смотрит камера (на земле и в зависании)
    const lw = (p.stand / total + p.hover / total) * (1 - 0.7 * smoothstep(0, 6, p.hs || 0) * (p.gait || 0)) * (p.look ?? 1);
    acc.neck[1] += clamp(p.lookYaw || 0, -0.85, 0.85) * lw;
    acc.neck[0] += clamp(-(p.lookPitch || 0) * 0.5, -0.35, 0.4) * lw;

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

    // Приветствие: рука поднята, ладонь машет
    if (p.wave > 0.01) {
      const s = Math.sin(this.t * 9);
      mixArm(acc, 'R', [-2.75, 0, -0.45 + s * 0.22], [-0.5 - s * 0.2, 0, 0], p.wave);
      acc.neck[0] -= 0.06 * p.wave;
    }
    // Бросок мяча: замах из-за головы и хлёсткий вынос руки вперёд
    if (p.throwT >= 0) {
      const t = p.throwT, k = smoothstep(0.3, 0.5, t), w = t < 0.75 ? smoothstep(0, 0.15, t) : 1 - smoothstep(0.75, 1, t);
      mixArm(acc, 'R', [lerp(-2.7, -1.15, k), 0, lerp(-0.35, -0.05, k)], [lerp(-1.8, -0.1, k), 0, 0], w);
      acc.spine[1] += lerp(-0.35, 0.3, k) * w;
      acc.spine[0] += lerp(-0.08, 0.18, k) * w;
      acc.shL[0] += -0.55 * w;
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
    this.j.pelvis.position.y = 1.0 + (p.bob || 0) + this.runBob - 0.5 * Math.max(p.land || 0, (p.pet || 0) * 0.85);
    if (this.skinned) this.skinned.sync(this);
  }
}

// ---------------------------------------------------------------- походка
const TAU = Math.PI * 2;
const THIGH = 0.44, SHIN = 0.43, LEG = THIGH + SHIN, TOE = 0.17;
const fract = (x) => x - Math.floor(x);
// Периодический «колокол» вокруг фазы c шириной w
function bell(u, c, w) { const d = fract(u - c + 0.5) - 0.5; return Math.exp(-(d * d) / (2 * w * w)); }

// Параметры шага (runK 0 → ходьба, 1 → бег; sp — спринт)
function gaitParams(runK, sp) {
  const r = (walk, run, sprint) => lerp(walk, lerp(run, sprint, sp), runK);
  return {
    runK, sp,
    hipC: r(0.1, 0.15, 0.2), hipA: r(0.34, 0.55, 0.75),           // бедро: центр и размах (сгибание вперёд > 0)
    hipPeak: r(0.9, 0.84, 0.8),                                     // пик выноса бедра; в беге — раньше, потом «загребание» назад
    kStance: r(0.2, 0.5, 0.35), kSwing: r(1.0, 1.55, 2.1),         // колено: опора и мах
    kSwingAt: r(0.72, 0.64, 0.6), kBase: r(0.06, 0.12, 0.14),
    stanceEnd: r(0.62, 0.38, 0.3),                                  // конец опоры (отрыв носка)
    push: r(0.55, 0.7, 0.85),                                        // отталкивание носком
    swingAnk: r(-0.08, 0.2, 0.3),                                    // стопа в махе (относительно голени)
    flight: r(0, 0.035, 0.07),                                       // подлёт таза в беге
  };
}

// Углы одной ноги в фазе u: hip — сгибание вперёд, knee — сгибание, ank — голеностоп (+ носок вниз)
function gaitLeg(u, G) {
  const hip = G.hipC + G.hipA * Math.cos(TAU * (u - G.hipPeak));
  const knee = G.kBase + G.kStance * bell(u, 0.13, 0.07) + G.kSwing * bell(u, G.kSwingAt, 0.12);
  // Стопа в опоре: пятка → ровно → подъём на носок; угол стопы к земле
  const foot = -0.22 * bell(u, 0.0, 0.035) * (1 - G.runK * 0.8) + G.push * bell(u, G.stanceEnd - 0.03, 0.06);
  const uu = u > 0.9 ? u - 1 : u;
  const contact = smoothstep(-0.06, 0.0, uu) * (1 - smoothstep(G.stanceEnd - 0.02, G.stanceEnd + 0.07, uu));
  // В опоре голеностоп держит стопу на земле; в махе — свободная стопа
  const ankStance = foot + hip - knee;
  const ank = lerp(G.swingAnk, ankStance, contact);
  return { hip, knee, ank, foot, contact, u };
}
function legReach(l) {
  return THIGH * Math.cos(l.hip) + SHIN * Math.cos(l.hip - l.knee) + TOE * Math.max(0, Math.sin(l.foot)) * l.contact;
}
// Смещение таза по высоте: в опоре — по вытянутости опорной ноги, в полёте — дуга
function gaitPelvis(uL, uR, L, R, G) {
  const se = G.stanceEnd;
  const inL = uL < se, inR = uR < se;
  if (inL || inR) return Math.max(inL ? legReach(L) : -9, inR ? legReach(R) : -9) - LEG;
  const u = uL < 0.5 ? uL : uR;              // фаза после отрыва последней ноги
  const s = clamp((u - se) / Math.max(0.05, 0.5 - se), 0, 1);
  const y0 = legReach(gaitLeg(se, G)) - LEG, y1 = legReach(gaitLeg(0, G)) - LEG;
  return lerp(y0, y1, s) + G.flight * 4 * s * (1 - s);
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

// Лепка тела и лица прямо из вершин базовой модели (в исходной позе, до скиннинга):
// атлетичная фигура (плечи, грудь, спина V-силуэтом, руки, ноги, узкая талия) и мужественное
// лицо (широкая чёткая челюсть, квадратный подбородок, скулы, надбровные дуги).
// Смещения — вдоль нормалей и «раздвиганием» по X; всё плавно затухает (без швов и складок).
function sculptBody(sk, body, eyes) {
  const g = body.geometry, P = g.attributes.position, N = g.attributes.normal;
  g.computeBoundingBox();
  const u = (g.boundingBox.max.y - g.boundingBox.min.y) / 1.88;
  const B = (n) => sk.byName[n] ? sk.bindLocal(n, body).divideScalar(u) : null;
  const bones = {};
  for (const n of ['Hips', 'Spine', 'Spine2', 'Neck', 'Head', 'LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm', 'LeftHand', 'RightHand',
    'LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg', 'LeftFoot', 'RightFoot']) bones[n] = B(n);
  const head = bones.Head, neck = bones.Neck, chest = bones.Spine2, hips = bones.Hips;
  // Глаза (метры): высота и ширина посадки — ориентир для лепки лица
  let eyeY = head.y + 0.06, eyeZ = head.z + 0.09;
  if (eyes.length) {
    const box = new THREE.Box3();
    for (const m of eyes) { m.geometry.computeBoundingBox(); box.union(m.geometry.boundingBox.clone().applyMatrix4(sk.meshInv.get(m).clone().invert()).applyMatrix4(sk.meshInv.get(body))); }
    eyeY = (box.min.y + box.max.y) / 2 / u; eyeZ = box.max.z / u;
  }
  const gauss = (d, r) => Math.exp(-(d / r) * (d / r));
  const seg = (p, a, b) => {
    const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / (abx * abx + aby * aby + abz * abz)));
    return { d: Math.hypot(p.x - a.x - abx * t, p.y - a.y - aby * t, p.z - a.z - abz * t), t };
  };
  const p = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < P.count; i++) {
    p.set(P.getX(i) / u, P.getY(i) / u, P.getZ(i) / u);
    n.set(N.getX(i), N.getY(i), N.getZ(i));
    let push = 0, sx = 1, dz = 0, dy = 0;
    const cx = p.x - hips.x, side = Math.sign(cx) || 1;
    const front = Math.max(0, n.z), up = Math.max(0, n.y);
    const isHead = p.y > neck.y + 0.02 && Math.abs(cx) < 0.13;
    if (!isHead) {
      // ---- тело
      for (const s of ['Left', 'Right']) {
        const arm = bones[s + 'Arm'], fore = bones[s + 'ForeArm'], hand = bones[s + 'Hand'];
        const upLeg = bones[s + 'UpLeg'], leg = bones[s + 'Leg'], foot = bones[s + 'Foot'];
        if (arm) push += 0.013 * gauss(p.distanceTo(arm), 0.085);                         // дельты
        if (arm && fore) { const q = seg(p, arm, fore); push += 0.009 * gauss(q.d, 0.07) * Math.sin(Math.PI * q.t); } // бицепс/трицепс
        if (fore && hand) { const q = seg(p, fore, hand); push += 0.005 * gauss(q.d, 0.06) * Math.sin(Math.PI * Math.min(1, q.t * 1.6)); } // предплечья
        if (upLeg && leg) { const q = seg(p, upLeg, leg); push += 0.011 * gauss(q.d, 0.1) * Math.sin(Math.PI * q.t) * (0.6 + 0.4 * front); } // бёдра
        if (leg && foot) { const q = seg(p, leg, foot); push += 0.008 * gauss(q.d, 0.08) * Math.max(0, Math.sin(Math.PI * q.t * 1.4)) * Math.max(0, -n.z); } // икры
      }
      // Грудные: две массы спереди
      for (const sgn of [-1, 1]) {
        const c = new THREE.Vector3(chest.x + sgn * 0.085, chest.y + 0.02, chest.z + 0.06);
        push += 0.012 * gauss(p.distanceTo(c), 0.085) * front;
      }
      // Широчайшие — V-силуэт; трапеции — мощная шея
      const latY = THREE.MathUtils.smoothstep(p.y, hips.y + 0.12, chest.y - 0.02) * (1 - THREE.MathUtils.smoothstep(p.y, chest.y + 0.08, chest.y + 0.14));
      push += 0.009 * latY * Math.max(0, Math.abs(n.x) - 0.3) * (Math.abs(cx) < 0.22 ? 1 : 0);
      if (neck) push += 0.008 * gauss(Math.hypot(Math.abs(cx) - 0.07, p.y - (neck.y - 0.05)), 0.06) * up;
      // Талия уже (вес ~55%): лёгкое втягивание по бокам и спереди
      push -= 0.007 * gauss(p.y - (hips.y + 0.16), 0.06) * (Math.abs(cx) < 0.2 ? 1 : 0);
    } else {
      // ---- лицо (только передняя часть головы)
      const hx = p.x - head.x, ax = Math.abs(hx), fz = THREE.MathUtils.smoothstep(p.z, head.z - 0.02, head.z + 0.05);
      // Челюсть шире и чётче: раздвигаем нижнюю треть лица
      const jaw = gauss(p.y - (eyeY - 0.105), 0.026) * fz;
      sx += 0.05 * jaw;
      // Квадратный подбородок: вперёд, чуть вниз и шире
      const chin = gauss(p.y - (eyeY - 0.13), 0.018) * gauss(ax, 0.03) * fz;
      dz += 0.006 * chin; dy -= 0.002 * chin; sx += 0.04 * chin;
      // Скулы и впадины под ними
      push += 0.0045 * gauss(p.y - (eyeY - 0.025), 0.014) * gauss(ax - 0.052, 0.014) * fz;
      push -= 0.0045 * gauss(p.y - (eyeY - 0.06), 0.015) * gauss(ax - 0.045, 0.015) * fz;
      // Надбровные дуги
      dz += 0.0032 * gauss(p.y - (eyeY + 0.021), 0.009) * gauss(ax - 0.03, 0.03) * THREE.MathUtils.smoothstep(p.z, eyeZ - 0.03, eyeZ);
    }
    const x = head && isHead ? head.x + (p.x - head.x) * sx : p.x;
    P.setXYZ(i, (x + n.x * push) * u, (p.y + n.y * push + dy) * u, (p.z + n.z * push + dz) * u);
  }
  P.needsUpdate = true;
  g.computeVertexNormals();
  g.computeBoundingBox();
}

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
  const front = 0.72 + 0.06 * smoothstep(0.012, 0.045, Math.abs(x - R.head.x));
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

  const mat = new THREE.MeshPhysicalMaterial({ roughness: 0.62, metalness: 0.0, sheen: 0.45, sheenRoughness: 0.55, sheenColor: new THREE.Color(0.26, 0.26, 0.27) });
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
          // Графит и винный: тёмная ткань, глубокий винный, матовое серебро
          vec3 white = vec3(0.034, 0.037, 0.042);   // графит (V-вставка)
          vec3 pearl = vec3(0.052, 0.055, 0.061);   // графит светлее (боковые панели)
          vec3 red = vec3(0.115, 0.011, 0.022);     // винный
          vec3 gold = vec3(0.56, 0.57, 0.6);        // матовое серебро
          vec3 skin = vec3(0.45, 0.272, 0.19);     // светлая европейская кожа
          vec3 hair = vec3(0.05, 0.026, 0.012);   // тёмно-каштановые волосы
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
          col = mix(col, vec3(0.5, 0.51, 0.54), star);
          zoneGold = max(zoneGold, ring);
          suitH += disc * 0.0016 + ring * 0.001 + star * 0.0012;

          // ---- Ткань: мелкое плетение (только белые части) ----
          float suitZone = (1.0 - zoneRed) * (1.0 - zoneGold) * (1.0 - disc);
          float weave = sin(p.x * 2600.0) * sin(p.y * 2600.0 + p.z * 900.0);
          suitH += weave * 0.0002 * fine * suitZone;
          // Кожа: зерно
          float grain = fract(sin(dot(floor(p * 900.0), vec3(12.9, 78.2, 37.7))) * 43758.5);
          suitH += (grain - 0.5) * 0.00012 * fine * zoneRed;

          // ---- Лицо, брови, волосы ----
          zoneSkin = step(uNeckY + 0.015, p.y) * step(abs(p.x - uHead.x), 0.4);
          float t = (p.y - uHead.y) / max(uTop - uHead.y, 1e-3);
          float back = clamp((uHead.z - p.z) / 0.08 + 0.6, 0.0, 1.0);
          float hFront = 0.72 + 0.06 * smoothstep(0.012, 0.045, abs(p.x - uHead.x));
          float hairLine = mix(hFront, 0.05, back * back) + (fract(sin(p.x * 251.7) * 437.5) - 0.5) * 0.02;
          zoneHair = zoneSkin * smoothstep(hairLine - 0.015, hairLine + 0.015, t);
          zoneHair *= mix(0.6, 1.0, smoothstep(0.1, 0.3, t));    // короткий затылок
          // Брови: дуга над глазом, чуть приподнята к внешнему краю
          float ex = abs(uEye.x - uHead.x);
          float dx = abs(p.x - uHead.x) - ex;
          float browY = uEye.y + 0.025 + 0.003 * (1.0 - (dx / 0.026) * (dx / 0.026)) - dx * 0.03;
          float bw = mix(0.0056, 0.003, clamp(dx / 0.022 * 0.5 + 0.5, 0.0, 1.0));
          float brow = zoneSkin * step(uEye.z - 0.02, p.z) * (1.0 - smoothstep(0.019, 0.024, abs(dx + 0.002)))
                       * (1.0 - smoothstep(bw * 0.7, bw, abs(p.y - browY)));
          zoneHair = max(zoneHair, brow * 0.9);
          // Лёгкий румянец на щеках и губах
          float cheek = zoneSkin * smoothstep(0.03, 0.0, abs(p.y - (uEye.y - 0.035))) * smoothstep(0.02, 0.05, abs(p.x - uHead.x));
          vec3 skinC = mix(skin, skin * vec3(1.1, 0.88, 0.86), cheek * 0.6);
          // Нос и уши чуть розовее, губы — темнее и теплее
          float fdx = abs(p.x - uHead.x);
          float nose = zoneSkin * smoothstep(0.012, 0.0, fdx) * smoothstep(0.03, 0.0, abs(p.y - (uEye.y - 0.035))) * step(uEye.z, p.z);
          skinC = mix(skinC, skin * vec3(1.12, 0.86, 0.84), nose * 0.5);
          float lips = zoneSkin * smoothstep(0.026, 0.016, fdx) * smoothstep(0.009, 0.003, abs(p.y - (uEye.y - 0.083))) * step(uEye.z - 0.012, p.z);
          skinC = mix(skinC, skinC * vec3(0.86, 0.6, 0.58), lips * 0.7);
          // Лёгкая тень щетины на челюсти, подбородке и над губой
          float faceFront = step(uEye.z - 0.05, p.z);
          float stub = zoneSkin * faceFront * smoothstep(uEye.y - 0.055, uEye.y - 0.085, p.y) * smoothstep(uNeckY + 0.02, uNeckY + 0.07, p.y) * (1.0 - lips);
          stub = max(stub, zoneSkin * faceFront * smoothstep(0.03, 0.02, fdx) * smoothstep(0.006, 0.0, abs(p.y - (uEye.y - 0.071))));
          float stubN = fract(sin(dot(floor(p * 2200.0), vec3(12.9, 78.2, 37.7))) * 43758.5);
          skinC = mix(skinC, skinC * vec3(0.66, 0.66, 0.72), stub * (0.48 + 0.28 * stubN));
          // Объём лица: тени глазниц, под скулами, под челюстью, у крыльев носа; линия губ
          float sockets = zoneSkin * faceFront * exp(-pow((p.y - (uEye.y + 0.004)) / 0.016, 2.0)) * exp(-pow((fdx - ex) / 0.024, 2.0));
          float underCheek = zoneSkin * faceFront * exp(-pow((p.y - (uEye.y - 0.058)) / 0.014, 2.0)) * exp(-pow((fdx - 0.05) / 0.014, 2.0));
          float underJaw = zoneSkin * smoothstep(-0.15, -0.65, nb.y) * step(p.y, uEye.y - 0.05);
          float nostril = zoneSkin * exp(-pow((p.y - (uEye.y - 0.055)) / 0.006, 2.0)) * exp(-pow((fdx - 0.014) / 0.006, 2.0)) * step(uEye.z - 0.01, p.z);
          float mouthLine = zoneSkin * exp(-pow((p.y - (uEye.y - 0.0835)) / 0.0018, 2.0)) * smoothstep(0.024, 0.014, fdx) * step(uEye.z - 0.012, p.z);
          skinC *= 1.0 - 0.18 * sockets - 0.05 * underCheek - 0.3 * underJaw - 0.35 * nostril - 0.35 * mouthLine;

          col = mix(col, red * (1.0 + grain * 0.12), zoneRed);
          col = mix(col, gold, zoneGold);
          col = mix(col, skinC, zoneSkin);
          col = mix(col, hair * (0.85 + 0.3 * fract(sin(dot(floor(p.xz * 300.0), vec2(12.9, 78.2))) * 4375.5)), zoneHair);
          suitH *= 1.0 - zoneSkin;
          diffuseColor.rgb = col;
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.33, zoneRed);
        roughnessFactor = mix(roughnessFactor, 0.38, zoneGold);
        roughnessFactor = mix(roughnessFactor, 0.44, zoneSkin);
        roughnessFactor = mix(roughnessFactor, 0.75, zoneHair);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        metalnessFactor = mix(metalnessFactor, 1.0, zoneGold * (1.0 - zoneSkin));`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        normal = heroBump(-vViewPosition, normal, suitH);`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
        material.sheenColor *= (1.0 - zoneSkin) * (1.0 - zoneRed) * (1.0 - zoneHair) * (1.0 - zoneGold);
        // Кожа: тёплое «подповерхностное» свечение по краям (свет проходит сквозь уши, нос)
        material.sheenColor += vec3(0.12, 0.04, 0.025) * zoneSkin * (1.0 - zoneHair);
        material.sheenRoughness = mix(material.sheenRoughness, 0.35, zoneSkin);`);
  };
  return mat;
}

// Объёмная причёска: участок кожи головы в зоне волос «выдавливается» по нормалям
// (сильнее к макушке и надо лбом — зачёс назад) и становится отдельной сеткой
// на том же скелете, поэтому двигается вместе с головой.
function buildHair(sk, body) {
  const R = bodyRefs(sk, body);
  const g = body.geometry, P = g.attributes.position, N = g.attributes.normal;
  const zone = new Float32Array(P.count), crown = new Float32Array(P.count);
  for (let i = 0; i < P.count; i++) {
    zone[i] = hairZone(R, P.getX(i) / R.u, P.getY(i) / R.u, P.getZ(i) / R.u);
    crown[i] = (P.getY(i) / R.u - R.head.y) / Math.max(R.top - R.head.y, 1e-3);
  }
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
    // Классическая мужская стрижка: виски и затылок короткие (но не выбритые),
    // сверху длиннее — волнистые пряди зачёсаны назад и чуть набок
    const edge = Math.pow(smoothstep(-0.012, 0.22, zone[v]), 1.3);
    const sideK = smoothstep(0.2, 0.75, crown[v]);
    const top = smoothstep(0.6, 0.86, crown[v]);
    const frontK = THREE.MathUtils.clamp((z - R.head.z) / 0.1 + 0.5, 0, 1);
    // Волна: крупные завитки-пряди сверху, мельче — по бокам
    const wave = Math.pow(Math.sin(z * 95 + Math.sin(x * 70) * 1.8 + Math.sin(x * 23) * 2.5) * 0.5 + 0.5, 1.5);
    const thick = edge * (0.003 + 0.004 * sideK + top * (0.011 + 0.009 * frontK) + top * 0.01 * wave);
    const nx = N.getX(v), ny = N.getY(v), nz = N.getZ(v);
    const sweep = edge * top;
    pos[j * 3] = (x + nx * thick + 0.005 * sweep) * R.u;                        // чуть набок
    pos[j * 3 + 1] = (y + ny * thick + 0.007 * sweep * frontK) * R.u;           // приподняты надо лбом
    pos[j * 3 + 2] = (z + nz * thick - 0.007 * sweep * (0.4 + frontK)) * R.u;   // зачёс назад
    for (let c = 0; c < 4; c++) { si[j * 4 + c] = SI.getComponent(v, c); sw[j * 4 + c] = SW.getComponent(v, c); }
  }
  const hg = new THREE.BufferGeometry();
  hg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  hg.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  hg.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  hg.setIndex(tris);
  hg.computeVertexNormals();

  const mat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color().setRGB(0.047, 0.024, 0.011), roughness: 0.44,
    sheen: 0.45, sheenRoughness: 0.4, sheenColor: new THREE.Color().setRGB(0.14, 0.07, 0.03),
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uU = { value: R.u };
    shader.uniforms.uHeadY = { value: R.head.y };
    shader.uniforms.uTop = { value: R.top };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHair;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHair = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vHair;\nuniform float uU, uHeadY, uTop;\n${BUMP_GLSL}\nfloat hairH = 0.0;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 p = vHair / uU;
          // Пряди идут назад (вдоль Z) с лёгкой волной
          float s = p.x * 620.0 + sin(p.z * 40.0) * 3.0;
          float strand = fract(sin(floor(s) * 91.3) * 437.5);
          float fine = 1.0 - smoothstep(0.0004, 0.0012, length(fwidth(p)));
          diffuseColor.rgb *= mix(1.0, 0.8 + 0.4 * strand, fine);
          hairH = sin(s * 6.2832) * 0.00018 * fine;
          // Короткие виски и затылок (fade): сквозь короткий волос просвечивает кожа
          float crown = (p.y - uHeadY) / max(uTop - uHeadY, 1e-3);
          float fade = (1.0 - smoothstep(0.1, 0.3, crown)) * 0.55;
          // Волнистые пряди: крупные волны поперёк зачёса — светлые гребни и тёмные впадины
          float topK = smoothstep(0.35, 0.75, crown);
          float wv = sin(p.z * 95.0 + sin(p.x * 70.0) * 1.8 + sin(p.x * 23.0) * 2.5);
          float clump = sin(p.x * 160.0 + sin(p.z * 60.0) * 2.0);
          diffuseColor.rgb *= mix(1.0, 0.72 + 0.55 * (0.5 + 0.5 * wv) + 0.12 * clump, topK);
          hairH += (wv * 0.0016 + clump * 0.0005) * topK;
          // Каштановый отлив на кончиках сверху
          diffuseColor.rgb *= 1.0 + 0.35 * smoothstep(0.75, 0.97, crown) * (0.5 + 0.5 * wv);
          float dots = fract(sin(dot(floor(p * 2600.0), vec3(12.9, 78.2, 37.7))) * 43758.5);
          vec3 skinT = vec3(0.45, 0.272, 0.19) * 0.82;
          diffuseColor.rgb = mix(diffuseColor.rgb, mix(skinT, diffuseColor.rgb, 0.35 + 0.35 * dots * fine), fade * 0.85);
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
    color: new THREE.Color().setRGB(0.115, 0.011, 0.022), vertexColors: true,
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

// Глаза: белок, серо-голубая радужка с тёмным ободком и лучиками, зрачок, влажный блеск
function createEyeMaterial(mesh) {
  // Радужка и зрачок — по расстоянию от оси взгляда каждого глаза (центры из габаритов меша)
  mesh.geometry.computeBoundingBox();
  const bb = mesh.geometry.boundingBox;
  const R = (bb.max.y - bb.min.y) / 2, cx = (bb.max.x - bb.min.x) / 4, cy = (bb.max.y + bb.min.y) / 2;
  const cz = bb.max.z - R, f = (v) => v.toFixed(5);
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.18, envMapIntensity: 0.4 });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBind;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBind = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBind;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec2 q = vec2(abs(vBind.x - ${f(bb.min.x + bb.max.x)} * 0.5) - ${f(cx)}, vBind.y - ${f(cy)}) / ${f(R)};
          float front = step(${f(cz)}, vBind.z);
          float r = length(q);
          float iris = front * (1.0 - smoothstep(0.5, 0.56, r));
          float pupil = front * (1.0 - smoothstep(0.2, 0.24, r));
          float ring = smoothstep(0.38, 0.54, r);
          float rays = 0.8 + 0.2 * sin(atan(q.y, q.x) * 37.0) * sin(atan(q.y, q.x) * 11.0 + 1.3);
          vec3 sclera = vec3(0.6, 0.57, 0.54) * (0.82 + 0.18 * front);
          vec3 irisC = mix(vec3(0.2, 0.32, 0.42), vec3(0.34, 0.44, 0.5), smoothstep(0.24, 0.42, r)) * rays;
          irisC = mix(irisC, vec3(0.05, 0.07, 0.1), ring * 0.8);
          diffuseColor.rgb = mix(mix(sclera, irisC, iris), vec3(0.01), pupil);
        }`);
  };
  return mat;
}
