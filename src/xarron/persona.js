import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { HeroModel, sculptBody, bodyRefs, BUMP_GLSL, makeBootGeometry, createEyeMaterial } from '../player/model.js';
import { SkinnedHero } from '../player/skinned.js';
import { Cape } from '../player/cape.js';
import { smoothstep, damp, clamp } from '../utils.js';

// Лица Тарвэна во плоти: именные персонажи на той же модели, что герой и Ксарг (Filip, CC-BY-4.0),
// с тем же процедурным ригом — дышат, переносят вес, поворачивают голову к герою, жестикулируют
// в разговоре. У каждого своя лепка (у женщин — своя фигура и черты лица), своё лицо и возраст,
// причёска, одежда Ксаррона (высокий ворот, кокетка, знак дома на груди), у знати — платье в пол,
// у стражи — латы, плащ с физикой ткани, вещи в руках. Рисуются только вблизи (до ~260 м):
// дальше их место отмечает световой столб (index.js).

const URL = 'assets/models/hero/scene.gltf';
const DRAW_R = 260;
const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _sph = new THREE.Sphere(new THREE.Vector3(), 2);
const GRAV = new THREE.Vector3(0, -14, 0);
const gauss = (d, r) => Math.exp(-(d / r) * (d / r));
const v3 = (a) => new THREE.Vector3(...a);

// ---------------------------------------------------------------- лепка
// Женская фигура из той же базовой модели: грудь, узкая талия, бёдра, тоньше шея, руки и плечи;
// лицо мягче — уже челюсть, меньше подбородок, выше скулы, ниже надбровья, полнее губы.
function sculptFemale(sk, body, eyes) {
  const g = body.geometry, P = g.attributes.position, N = g.attributes.normal;
  const R = bodyRefs(sk, body), u = R.u;
  const B = (n) => sk.bindLocal(n, body).divideScalar(u);
  const bones = {};
  for (const n of ['LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm', 'LeftHand', 'RightHand', 'LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg']) bones[n] = B(n);
  let eyeY = R.head.y + 0.06, eyeZ = R.head.z + 0.09;
  if (eyes.length) {
    const box = new THREE.Box3();
    for (const m of eyes) { m.geometry.computeBoundingBox(); box.union(m.geometry.boundingBox.clone().applyMatrix4(sk.meshInv.get(m).clone().invert()).applyMatrix4(sk.meshInv.get(body))); }
    eyeY = (box.min.y + box.max.y) / 2 / u; eyeZ = box.max.z / u;
  }
  const seg = (p, a, b) => {
    const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
    const t = clamp(((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / (abx * abx + aby * aby + abz * abz), 0, 1);
    return { d: Math.hypot(p.x - a.x - abx * t, p.y - a.y - aby * t, p.z - a.z - abz * t), t };
  };
  const p = new THREE.Vector3(), n = new THREE.Vector3(), c = new THREE.Vector3();
  const hips = R.hips, chest = R.chest, neck = R.neck, head = R.head;
  for (let i = 0; i < P.count; i++) {
    p.set(P.getX(i) / u, P.getY(i) / u, P.getZ(i) / u);
    n.set(N.getX(i), N.getY(i), N.getZ(i));
    let push = 0, sx = 1, dz = 0, dy = 0;
    const cx = p.x - hips.x, front = Math.max(0, n.z);
    const isHead = p.y > neck.y + 0.02 && Math.abs(cx) < 0.13;
    if (!isHead) {
      for (const sgn of [-1, 1]) {
        c.set(chest.x + sgn * 0.088, chest.y - 0.015, chest.z + 0.055);
        push += 0.03 * gauss(p.distanceTo(c), 0.072) * (0.3 + 0.7 * front);
      }
      const trunk = Math.abs(cx) < 0.2 ? 1 : 0;
      push -= 0.016 * gauss(p.y - (hips.y + 0.17), 0.07) * trunk;                                   // талия
      push += 0.017 * gauss(p.y - (hips.y - 0.03), 0.085) * Math.max(0, Math.abs(n.x) - 0.15) * (Math.abs(cx) < 0.24 ? 1 : 0); // бёдра
      push += 0.008 * gauss(p.y - (hips.y - 0.06), 0.07) * Math.max(0, -n.z) * trunk;               // ягодицы
      push -= 0.009 * gauss(Math.hypot(Math.abs(cx) - 0.05, p.y - (neck.y - 0.03)), 0.06);         // трапеции
      push -= 0.012 * gauss(p.y - (neck.y + 0.005), 0.035) * (Math.abs(cx) < 0.085 ? 1 : 0);          // шея тоньше
      for (const s of ['Left', 'Right']) {
        const arm = bones[s + 'Arm'], fore = bones[s + 'ForeArm'], hand = bones[s + 'Hand'];
        push -= 0.013 * gauss(p.distanceTo(arm), 0.085);                                            // дельты
        let q = seg(p, arm, fore); push -= 0.007 * gauss(q.d, 0.07) * Math.sin(Math.PI * q.t);      // плечо
        q = seg(p, fore, hand); push -= 0.004 * gauss(q.d, 0.06);                                   // предплечье
        q = seg(p, bones[s + 'UpLeg'], bones[s + 'Leg']); push += 0.004 * gauss(q.d, 0.1) * Math.sin(Math.PI * q.t);
      }
    } else {
      const hx = p.x - head.x, ax = Math.abs(hx), fz = smoothstep(head.z - 0.02, head.z + 0.05, p.z);
      const jaw = gauss(p.y - (eyeY - 0.1), 0.036) * (0.4 + 0.6 * fz);
      sx -= 0.04 + 0.1 * jaw;   // вся голова уже, челюсть — заметно
      const chin = gauss(p.y - (eyeY - 0.128), 0.016) * gauss(ax, 0.03) * fz;
      dz -= 0.003 * chin; dy += 0.008 * chin; sx -= 0.04 * chin;
      dy += 0.004 * gauss(p.y - (eyeY - 0.12), 0.025) * fz;   // лицо короче
      push += 0.0035 * gauss(p.y - (eyeY - 0.022), 0.013) * gauss(ax - 0.05, 0.016) * fz;          // скулы
      push -= 0.006 * gauss(p.y - (eyeY - 0.115), 0.022) * gauss(ax - 0.05, 0.02) * (0.5 + 0.5 * fz);  // углы челюсти круглее
      dz -= 0.0022 * gauss(p.y - (eyeY + 0.021), 0.01) * gauss(ax - 0.03, 0.03) * smoothstep(eyeZ - 0.03, eyeZ, p.z); // надбровья
      push += 0.0022 * gauss(p.y - (eyeY - 0.084), 0.006) * gauss(ax, 0.017) * fz;                 // губы
    }
    const x = isHead ? head.x + (p.x - head.x) * sx : p.x;
    P.setXYZ(i, (x + n.x * push) * u, (p.y + n.y * push + dy) * u, (p.z + n.z * push + dz) * u);
  }
  P.needsUpdate = true;
  g.computeVertexNormals();
  g.computeBoundingBox();
}

// Глаза относительно головы (метры) — по габаритам сетки глаз
function eyeRef(sk, mesh, eyes, R) {
  let eye = new THREE.Vector3(0.035, R.head.y + 0.06, R.head.z + 0.09);
  if (eyes.length) {
    const toBody = sk.meshInv.get(mesh), box = new THREE.Box3();
    for (const m of eyes) {
      m.geometry.computeBoundingBox();
      box.union(m.geometry.boundingBox.clone().applyMatrix4(sk.meshInv.get(m).clone().invert()).applyMatrix4(toBody));
    }
    box.min.divideScalar(R.u); box.max.divideScalar(R.u);
    const er = (box.max.y - box.min.y) / 2;
    eye = new THREE.Vector3(R.head.x + Math.max(0.02, (box.max.x - box.min.x) / 2 - er), (box.min.y + box.max.y) / 2, box.max.z - er);
  }
  return eye;
}

// ---------------------------------------------------------------- тело: одежда, кожа, лицо
// Одна программа на всех: различия — в uniform-ах (цвета, пол, возраст, латы, борода)
function createPersonaMaterial(sk, mesh, eyes, B) {
  const R = bodyRefs(sk, mesh), eye = eyeRef(sk, mesh, eyes, R);
  const mat = new THREE.MeshPhysicalMaterial({ roughness: 0.6, metalness: 0, sheen: 0.4, sheenRoughness: 0.5, sheenColor: new THREE.Color(0.2, 0.2, 0.22) });
  mat.customProgramCacheKey = () => 'tarven-persona';
  const U = {
    uHead: { value: R.head }, uNeckY: { value: R.neck.y }, uTop: { value: R.top }, uChest: { value: R.chest }, uHipsY: { value: R.hips.y },
    uKneeY: { value: R.knee.y }, uElbowX: { value: Math.abs(R.fore.x - R.chest.x) }, uWristX: { value: Math.abs(R.hand.x - R.chest.x) },
    uU: { value: R.u }, uEye: { value: eye }, uFootTop: { value: R.minY + 0.08 },
    uC1: { value: v3(B.cloth) }, uC2: { value: v3(B.cloth2) }, uTrim: { value: v3(B.trim) }, uLeg: { value: v3(B.legs || B.cloth) },
    uBoot: { value: v3(B.boot) }, uGlove: { value: v3(B.glove || B.boot) }, uSigil: { value: v3(B.sigil || [0, 0, 0]) },
    uSkin: { value: v3(B.skin) }, uHair: { value: v3(B.hair) }, uBrow: { value: v3(B.brow || B.hair) },
    uArmor: { value: v3(B.armor || [0, 0, 0]) },
    // x — женщина, y — возраст, z — латы, w — борода (0 нет, 1 короткая, 2 полная)
    uLook: { value: new THREE.Vector4(B.sex === 'f' ? 1 : 0, B.age || 0, B.armor ? 1 : 0, B.beard === 'full' ? 2 : B.beard ? 1 : 0) },
    // x — линия волос надо лбом, y — 1 «венчик» (лысина сверху), 2 — бритая голова; z — шрам, w — помада
    uHairL: { value: new THREE.Vector4(B.hairFront ?? 0.72, B.style === 'fringe' ? 1 : B.style === 'bald' ? 2 : 0, B.scar ? 1 : 0, B.lips ?? 0.5) },
  };
  mat.userData.U = U;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, U);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBind;\nvarying vec3 vBindN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBind = position;\nvBindN = normal;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vBind;
        varying vec3 vBindN;
        uniform vec3 uHead, uChest, uEye, uC1, uC2, uTrim, uLeg, uBoot, uGlove, uSigil, uSkin, uHair, uBrow, uArmor;
        uniform float uNeckY, uTop, uHipsY, uKneeY, uElbowX, uWristX, uU, uFootTop;
        uniform vec4 uLook, uHairL;
        float zTrim = 0.0, zSkin = 0.0, zHair = 0.0, zPlate = 0.0, zSig = 0.0, pH = 0.0;
        ${BUMP_GLSL}
        float groove(float d, float w) { return 1.0 - smoothstep(w * 0.55, w, d); }
        float h31(vec3 p) { return fract(sin(dot(p, vec3(12.9, 78.2, 37.7))) * 43758.5); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 p = vBind / uU;
          if (p.y < uFootTop) discard;   // ступня — под сапогом
          vec3 nb = normalize(vBindN);
          float px = length(fwidth(p));
          float fine = 1.0 - smoothstep(0.0008, 0.0025, px);
          float ax = abs(p.x - uChest.x);
          float frontK = smoothstep(-0.05, 0.25, nb.z);
          float beltY = uHipsY + 0.11;
          float isArm = step(0.235, ax);
          float torso = (1.0 - isArm) * step(beltY, p.y) * step(p.y, uNeckY + 0.06);
          vec3 col = uC1;
          float trim = 0.0, plate = 0.0, seam = 0.0;

          // ---- кокетка: от плеч вниз к груди, по краю — кант
          float yokeY = uChest.y + 0.1 - ax * 0.42;
          float yoke = torso * step(yokeY, p.y);
          col = mix(col, uC2, yoke);
          trim = max(trim, torso * groove(abs(p.y - yokeY), 0.0045));
          // ---- планка по центру и боковые швы
          float placket = torso * (1.0 - yoke) * step(ax, 0.03) * frontK;
          col = mix(col, uC2, placket);
          trim = max(trim, torso * (1.0 - yoke) * frontK * groove(abs(ax - 0.03), 0.0035));
          seam = max(seam, torso * groove(abs(abs(nb.x) - 0.92), 0.06));
          // ---- высокий стоячий ворот
          // ворот закрывает шею до самой челюсти; спереди открыт только подбородок
          float collarTop = uNeckY + 0.085;
          float collar = (1.0 - isArm) * step(uNeckY - 0.06, p.y) * step(p.y, collarTop) * step(abs(p.x - uHead.x), 0.085)
                         * (1.0 - step(uEye.z - 0.075, p.z) * step(uEye.y - 0.135, p.y));
          col = mix(col, uC2, collar);
          trim = max(trim, collar * groove(abs(p.y - collarTop), 0.006));
          // ---- пояс и пряжка
          float belt = (1.0 - isArm) * step(abs(p.y - beltY), 0.03);
          col = mix(col, uC2 * 0.75, belt);
          trim = max(trim, belt * groove(abs(abs(p.y - beltY) - 0.028), 0.004));
          float buckle = belt * frontK * step(ax, 0.028) * step(abs(p.y - beltY), 0.022);
          trim = max(trim, buckle);
          pH += buckle * 0.0024 + belt * 0.0015;
          // ---- рукава: манжеты от середины предплечья, перчатки
          float cuffX = uElbowX + (uWristX - uElbowX) * 0.45;
          float cuff = step(cuffX, ax) * isArm;
          col = mix(col, uC2, cuff);
          trim = max(trim, isArm * groove(abs(ax - cuffX), 0.005));
          float glove = step(uWristX + 0.012, ax);
          col = mix(col, uGlove, glove);
          // ---- ноги и сапоги
          float leg = (1.0 - isArm) * step(p.y, beltY - 0.03);
          col = mix(col, uLeg, leg);
          float bootY = uKneeY - 0.02;
          float boot = (1.0 - isArm) * step(p.y, bootY);
          col = mix(col, uBoot, boot);
          trim = max(trim, (1.0 - isArm) * groove(abs(p.y - bootY), 0.005));
          seam = max(seam, leg * (1.0 - boot) * groove(abs(nb.x) - 0.95, 0.05));

          // ---- латы стражи: грудь, наплечья, наручи, наколенники и поножи
          if (uLook.z > 0.5) {
            float pec = torso * step(uChest.y - 0.14 + ax * 0.3, p.y) * step(ax, 0.2) * (1.0 - collar);
            float sh = step(0.17, ax) * step(uNeckY - 0.12, p.y) * step(ax, uElbowX - 0.06) * smoothstep(0.1, 0.35, nb.y);
            float vamb = isArm * step(uElbowX + 0.04, ax) * step(ax, uWristX + 0.01);
            float knee = (1.0 - isArm) * step(abs(p.y - uKneeY), 0.07) * frontK;
            float abs_ = torso * (1.0 - pec) * step(ax, 0.13 + (p.y - beltY) * 0.3) * step(beltY + 0.03, p.y);
            plate = max(max(pec, sh), max(max(vamb, knee), abs_ * 0.9));
            float abT = (p.y - beltY) / 0.045;
            seam = max(seam, abs_ * groove(abs(fract(abT) - 0.5) * 0.045, 0.0032));
            seam = max(seam, pec * groove(ax, 0.004));
            trim = max(trim, pec * groove(abs(p.y - (uChest.y - 0.14 + ax * 0.3)), 0.0045));
            trim = max(trim, vamb * groove(abs(ax - (uElbowX + 0.04)), 0.005));
            float scratch = h31(floor(p * 700.0));
            col = mix(col, uArmor * (0.85 + 0.3 * scratch * fine), plate);
            pH += plate * 0.0026;
          }

          // ---- знак дома на груди: круг, внутри — ромб звезды; светится
          vec2 e = vec2(p.x - uChest.x, p.y - (uChest.y + 0.055));
          float ef = (1.0 - isArm) * step(uChest.z + 0.02, p.z) * smoothstep(0.0, 0.3, nb.z);
          float er = length(e);
          float ring = ef * groove(abs(er - 0.038), 0.005);
          float star = ef * (1.0 - smoothstep(0.9, 1.0, abs(e.x) / 0.016 + abs(e.y) / 0.03));
          zSig = max(ring, star) * step(0.01, dot(uSigil, vec3(1.0)));
          col = mix(col, uTrim, ring);
          pH += ring * 0.0012 + star * 0.0016;

          col *= 1.0 - seam * 0.35;
          col = mix(col, uTrim, trim);
          pH += trim * 0.0012 - seam * 0.0008;
          float weave = sin(p.x * 2400.0) * sin(p.y * 2400.0 + p.z * 800.0);
          pH += weave * 0.00018 * fine * (1.0 - plate) * (1.0 - trim);
          zTrim = trim;
          zPlate = plate;

          // ---- кожа, лицо, волосы
          float fdx = abs(p.x - uHead.x);
          zSkin = step(uNeckY + 0.015, p.y) * step(fdx, 0.4) * (1.0 - collar);
          float t = (p.y - uHead.y) / max(uTop - uHead.y, 1e-3);
          float back = clamp((uHead.z - p.z) / 0.08 + 0.6, 0.0, 1.0);
          // У мужчин линия выше на висках (залысины), у женщин — ниже: волосы закрывают виски
          float hFront = uHairL.x + mix(0.06, -0.09, uLook.x) * smoothstep(0.012, 0.045, fdx);
          float hairLine = mix(hFront, 0.05, back * back) + (fract(sin(p.x * 251.7) * 437.5) - 0.5) * 0.015;
          float hz = zSkin * smoothstep(hairLine - 0.015, hairLine + 0.015, t);
          // «Венчик»: сверху лысина, волосы только на висках и затылке
          if (uHairL.y > 1.5) hz = 0.0;
          else if (uHairL.y > 0.5) hz *= (1.0 - smoothstep(0.5, 0.6, t)) * smoothstep(0.15, 0.45, back + 0.25 * smoothstep(0.05, 0.09, fdx));
          zHair = hz;
          float ex = abs(uEye.x - uHead.x), dx = fdx - ex;
          float faceFront = step(uEye.z - 0.05, p.z);
          float fem = uLook.x, age = uLook.y;
          // Брови: у женщин тоньше и выше, с изломом; у мужчин — тяжелее и прямее
          float browY = uEye.y + mix(0.0235, 0.027, fem) + mix(0.002, 0.004, fem) * (1.0 - (dx / 0.026) * (dx / 0.026)) - dx * mix(0.03, 0.05, fem);
          float bw = mix(mix(0.0058, 0.0032, clamp(dx / 0.022 * 0.5 + 0.5, 0.0, 1.0)), mix(0.0036, 0.0018, clamp(dx / 0.022 * 0.5 + 0.5, 0.0, 1.0)), fem);
          float brow = zSkin * step(uEye.z - 0.02, p.z) * (1.0 - smoothstep(0.019, 0.024, abs(dx + 0.002))) * (1.0 - smoothstep(bw * 0.7, bw, abs(p.y - browY)));
          vec3 skin = uSkin;
          // Румянец, нос, губы
          float cheek = zSkin * smoothstep(0.03, 0.0, abs(p.y - (uEye.y - 0.035))) * smoothstep(0.02, 0.05, fdx);
          vec3 skinC = mix(skin, skin * vec3(1.12, 0.86, 0.84), cheek * mix(0.45, 0.8, fem));
          float nose = zSkin * smoothstep(0.012, 0.0, fdx) * smoothstep(0.03, 0.0, abs(p.y - (uEye.y - 0.035))) * step(uEye.z, p.z);
          skinC = mix(skinC, skin * vec3(1.1, 0.88, 0.86), nose * 0.4);
          float lipY = uEye.y - 0.084;
          float lips = zSkin * smoothstep(mix(0.025, 0.023, fem), 0.015, fdx) * smoothstep(mix(0.008, 0.011, fem), 0.003, abs(p.y - lipY)) * step(uEye.z - 0.014, p.z);
          skinC = mix(skinC, skinC * mix(vec3(0.86, 0.62, 0.6), vec3(0.82, 0.42, 0.44), uHairL.w * fem), lips * 0.8);
          // Объём: глазницы, под скулами, под челюстью, ноздри, линия рта
          float sockets = zSkin * faceFront * exp(-pow((p.y - (uEye.y + 0.004)) / 0.016, 2.0)) * exp(-pow(dx / 0.024, 2.0));
          float underCheek = zSkin * faceFront * exp(-pow((p.y - (uEye.y - 0.058)) / 0.014, 2.0)) * exp(-pow((fdx - 0.05) / 0.014, 2.0));
          float underJaw = zSkin * smoothstep(-0.15, -0.65, nb.y) * step(p.y, uEye.y - 0.05);
          float nostril = zSkin * exp(-pow((p.y - (uEye.y - 0.055)) / 0.006, 2.0)) * exp(-pow((fdx - 0.014) / 0.006, 2.0)) * step(uEye.z - 0.01, p.z);
          float mouthLine = zSkin * exp(-pow((p.y - (lipY + 0.0005)) / 0.0017, 2.0)) * smoothstep(0.024, 0.014, fdx) * step(uEye.z - 0.012, p.z);
          // Верхнее веко с ресницами (у женщин — темнее и длиннее, «стрелка»)
          float lid = zSkin * faceFront * exp(-pow((p.y - (uEye.y + 0.0085 - max(0.0, dx) * 0.08)) / mix(0.0018, 0.0024, fem), 2.0)) * smoothstep(0.016, 0.006, abs(dx + 0.001 - fem * 0.002));
          // Возраст: морщины на лбу, «гусиные лапки», носогубные складки, мешки под глазами
          float fh = (p.y - (uEye.y + 0.045)) / 0.011;
          float forehead = zSkin * faceFront * step(uEye.y + 0.035, p.y) * step(p.y, uEye.y + 0.08) * smoothstep(0.05, 0.02, fdx) * groove(abs(fract(fh) - 0.5), 0.12);
          float crow = zSkin * faceFront * smoothstep(0.012, 0.0, abs(fdx - ex - 0.022)) * groove(abs(fract((p.y - uEye.y) / 0.006) - 0.5), 0.18) * step(abs(p.y - uEye.y), 0.012);
          float fold = zSkin * faceFront * exp(-pow((fdx - 0.016 - (uEye.y - 0.05 - p.y) * 0.45) / 0.0026, 2.0)) * smoothstep(uEye.y - 0.045, uEye.y - 0.055, p.y) * smoothstep(uEye.y - 0.095, uEye.y - 0.08, p.y);
          float bags = zSkin * faceFront * exp(-pow((p.y - (uEye.y - 0.016)) / 0.004, 2.0)) * exp(-pow(dx / 0.014, 2.0));
          skinC *= 1.0 - 0.2 * sockets - 0.08 * underCheek - 0.3 * underJaw - 0.35 * nostril - 0.4 * mouthLine
                   - mix(0.45, 0.75, fem) * lid - age * (0.1 * forehead + 0.16 * crow + 0.18 * bags) - (0.06 + 0.12 * age) * (1.0 - 0.6 * fem) * fold;
          skinC = mix(skinC, vec3(dot(skinC, vec3(0.3, 0.5, 0.2))) * vec3(1.02, 0.98, 0.96), age * 0.18);
          // Щетина у мужчин без бороды; борода — цветом волос
          float stub = (1.0 - fem) * zSkin * faceFront * smoothstep(uEye.y - 0.055, uEye.y - 0.085, p.y) * smoothstep(uNeckY + 0.02, uNeckY + 0.07, p.y) * (1.0 - lips);
          float stubN = h31(floor(p * 2200.0));
          float beard = step(0.5, uLook.w) * zSkin * smoothstep(uEye.y - 0.045, uEye.y - 0.06, p.y) * step(uNeckY - 0.02, p.y)
                        * step(uHead.z - 0.04, p.z) * (1.0 - lips * 0.85) * (1.0 - smoothstep(0.004, 0.0, abs(p.y - lipY) - 0.007) * smoothstep(0.018, 0.012, fdx));
          skinC = mix(skinC, skinC * vec3(0.62, 0.62, 0.68), stub * (1.0 - beard) * (0.4 + 0.28 * stubN) * (1.0 - step(0.5, uLook.w)));
          // Старый шрам через щёку
          float sx = p.x - uHead.x + ex + 0.01, sy = p.y - uEye.y + 0.03;
          float scar = uHairL.z * zSkin * faceFront * exp(-pow((sx - sy * 0.3) / 0.0015, 2.0)) * smoothstep(0.045, 0.03, abs(sy));
          skinC = mix(skinC, skin * vec3(1.15, 0.8, 0.8), scar * 0.85);

          col = mix(col, skinC, zSkin);
          float hairTone = 0.85 + 0.3 * h31(vec3(floor(p.xz * 300.0), 1.0));
          col = mix(col, uHair * hairTone, max(zHair, beard * 0.95));
          col = mix(col, uBrow, brow * 0.92 * (1.0 - scar));
          zHair = max(zHair, beard);
          pH *= 1.0 - zSkin;
          diffuseColor.rgb = col;
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.34, zTrim);
        roughnessFactor = mix(roughnessFactor, 0.3, zPlate);
        roughnessFactor = mix(roughnessFactor, 0.45, zSkin);
        roughnessFactor = mix(roughnessFactor, 0.7, zHair);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        metalnessFactor = mix(metalnessFactor, 0.8, zPlate * (1.0 - zSkin));
        metalnessFactor = mix(metalnessFactor, 1.0, zTrim * (1.0 - zSkin));`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        normal = heroBump(-vViewPosition, normal, pH);`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
        material.sheenColor *= (1.0 - zPlate) * (1.0 - zTrim) * (1.0 - zSkin);
        material.sheenColor += vec3(0.12, 0.04, 0.025) * zSkin * (1.0 - zHair);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += uSigil * zSig * 2.2;`);
  };
  return mat;
}

// ---------------------------------------------------------------- волосы и борода
// Участок кожи в своей зоне «выдавливается» по нормалям и становится отдельной сеткой
// на том же скелете: двигается с головой. zone(x, y, z) > 0 — внутри; thick(...) — толщина, м
function shell(sk, body, R, zone, thick, color, sheen) {
  const g = body.geometry, P = g.attributes.position, N = g.attributes.normal;
  const Z = new Float32Array(P.count);
  for (let i = 0; i < P.count; i++) Z[i] = zone(P.getX(i) / R.u, P.getY(i) / R.u, P.getZ(i) / R.u);
  const idx = g.index ? g.index.array : [...Array(P.count).keys()];
  const remap = new Map(), tris = [];
  for (let k = 0; k < idx.length; k += 3) {
    const a = idx[k], b = idx[k + 1], c = idx[k + 2];
    if (Math.min(Z[a], Z[b], Z[c]) < -0.012) continue;
    for (const v of [a, b, c]) { if (!remap.has(v)) remap.set(v, remap.size); tris.push(remap.get(v)); }
  }
  if (!tris.length) return null;
  const n = remap.size, pos = new Float32Array(n * 3), si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  const SI = g.attributes.skinIndex, SW = g.attributes.skinWeight;
  for (const [v, j] of remap) {
    const x = P.getX(v) / R.u, y = P.getY(v) / R.u, z = P.getZ(v) / R.u;
    const [d, dy, dz] = thick(x, y, z, Z[v]);
    pos[j * 3] = (x + N.getX(v) * d) * R.u;
    pos[j * 3 + 1] = (y + N.getY(v) * d + dy) * R.u;
    pos[j * 3 + 2] = (z + N.getZ(v) * d + dz) * R.u;
    for (let c = 0; c < 4; c++) { si[j * 4 + c] = SI.getComponent(v, c); sw[j * 4 + c] = SW.getComponent(v, c); }
  }
  const hg = new THREE.BufferGeometry();
  hg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  hg.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  hg.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  hg.setIndex(tris);
  hg.computeVertexNormals();
  const m = new THREE.SkinnedMesh(hg, hairMaterial(color, sheen, R));
  m.position.copy(body.position); m.quaternion.copy(body.quaternion); m.scale.copy(body.scale);
  m.bind(body.skeleton, body.bindMatrix);
  m.castShadow = true;
  m.frustumCulled = false;
  body.parent.add(m);
  return m;
}

// Пряди: тонкие полосы вдоль причёски с блеском
function hairMaterial(color, sheen, R, side = THREE.FrontSide) {
  const mat = new THREE.MeshPhysicalMaterial({ color: new THREE.Color().setRGB(...color), roughness: 0.42, sheen: 0.5, sheenRoughness: 0.4, sheenColor: new THREE.Color().setRGB(...sheen), side });
  mat.customProgramCacheKey = () => 'tarven-hair' + side;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uU = { value: R ? R.u : 1 };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHair;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHair = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vHair;\nuniform float uU;\n${BUMP_GLSL}\nfloat hairH = 0.0;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 p = vHair / uU;
          float s = p.x * 640.0 + sin(p.y * 30.0 + p.z * 25.0) * 3.0;
          float strand = fract(sin(floor(s) * 91.3) * 437.5);
          float fine = 1.0 - smoothstep(0.0004, 0.0012, length(fwidth(p)));
          diffuseColor.rgb *= mix(1.0, 0.75 + 0.5 * strand, fine);
          float wv = sin(p.y * 120.0 + sin(p.x * 60.0) * 2.0);
          diffuseColor.rgb *= 0.9 + 0.16 * wv;
          hairH = (sin(s * 6.2832) * 0.00018 + wv * 0.0006) * fine;
        }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        normal = heroBump(-vViewPosition, normal, hairH);`);
  };
  return mat;
}

// Длинные волосы до лопаток: изогнутая «шторка» за головой, крепится к голове
function longHairGeometry(len, wTop, wBot) {
  const NU = 22, NV = 18, pos = [], uv = [], idx = [];
  for (let j = 0; j <= NV; j++) {
    const v = j / NV;
    for (let i = 0; i <= NU; i++) {
      const u = i / NU * 2 - 1;
      // Сверху — облегает затылок по дуге, ниже — свободно ложится на спину и чуть волнится
      // Сверху волосы заходят на виски и обрамляют лицо, ниже — уходят за плечи
      const a = u * (1.68 - 0.62 * smoothstep(0, 0.5, v));
      const r = 0.112 + 0.012 * v;
      const w = (wTop + (wBot - wTop) * smoothstep(0.2, 1, v)) / 0.2;
      const x = Math.sin(a) * r * Math.max(1, w * smoothstep(0.1, 0.6, v) + (1 - smoothstep(0.1, 0.6, v)));
      const zc = -Math.cos(a) * r * (1 - 0.35 * smoothstep(0.3, 0.8, v)) - 0.03 * smoothstep(0.25, 0.6, v) - 0.025 * v;
      const y = 0.11 - v * len + Math.sin(u * 9 + v * 4) * 0.004;
      pos.push(x, y, zc + Math.sin(u * 13) * 0.004 * v);
      uv.push(i / NU, v);
    }
  }
  for (let j = 0; j < NV; j++) for (let i = 0; i < NU; i++) {
    const a = j * (NU + 1) + i, b = a + 1, c = a + NU + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Высокий хвост: узел на затылке и прядь, падающая на спину
function tailGeometry() {
  const knot = new THREE.SphereGeometry(0.045, 12, 8).scale(1, 0.85, 1).translate(0, 0.17, -0.1);
  const pts = [];
  for (let k = 0; k <= 12; k++) { const t = k / 12; pts.push(new THREE.Vector2(0.034 * Math.sin(Math.PI * (0.15 + 0.85 * t)) * (1 - 0.6 * t) + 0.004, -t * 0.46)); }
  const tail = new THREE.LatheGeometry(pts, 12).rotateX(-0.42).translate(0, 0.16, -0.13);
  for (const g of [knot, tail]) g.deleteAttribute('uv');
  const out = new THREE.BufferGeometry();
  const merge = (gs) => { const all = gs.map((g) => g.toNonIndexed()); let n = 0; for (const g of all) n += g.attributes.position.count; const p = new Float32Array(n * 3); let o = 0; for (const g of all) { p.set(g.attributes.position.array, o); o += g.attributes.position.array.length; } return p; };
  out.setAttribute('position', new THREE.BufferAttribute(merge([knot, tail]), 3));
  out.computeVertexNormals();
  return out;
}

// Платье в пол (у знати и у Регента): колокол от пояса со складками и тёмной каймой
function gownGeometry(top, bottom, rTop, rBot) {
  const NA = 56, NV = 16, pos = [], col = [], idx = [];
  for (let j = 0; j <= NV; j++) {
    const v = j / NV, y = top + (bottom - top) * v;
    const r = rTop + (rBot - rTop) * Math.pow(v, 1.25);
    for (let i = 0; i <= NA; i++) {
      const a = i / NA * Math.PI * 2;
      const fold = (Math.sin(a * 9) * 0.6 + Math.sin(a * 17 + 1) * 0.4) * 0.014 * v;
      const rr = r + fold;
      pos.push(Math.sin(a) * rr, y, Math.cos(a) * rr * 0.82);
      const hem = v > 0.93 ? 0.35 : 1, panel = Math.abs(Math.sin(a)) < 0.12 && Math.cos(a) > 0 ? 0.8 : 1;
      col.push(hem * panel, hem * panel, hem * panel);
    }
  }
  for (let j = 0; j < NV; j++) for (let i = 0; i < NA; i++) {
    const a = j * (NA + 1) + i, b = a + 1, c = a + NA + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Сапоги по ступне (как у героя), своим цветом
function addBoots(sk, body, color) {
  const R = bodyRefs(sk, body), P = body.geometry.attributes.position;
  const toModel = sk.meshInv.get(body).clone().invert();
  const leather = new THREE.MeshPhysicalMaterial({ color: new THREE.Color().setRGB(...color), vertexColors: true, roughness: 0.32, clearcoat: 0.6, clearcoatRoughness: 0.3 });
  for (const [side, s] of [['Left', 1], ['Right', -1]]) {
    const pts = [], v = new THREE.Vector3();
    for (let i = 0; i < P.count; i++) {
      if (P.getY(i) / R.u > R.minY + 0.06 || Math.sign(P.getX(i) / R.u - R.hips.x) !== s) continue;
      pts.push(v.fromBufferAttribute(P, i).applyMatrix4(toModel).clone());
    }
    if (!pts.length) continue;
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
    const L = Math.min(0.3, l1 - l0 + 0.01), lc = (l0 + l1) / 2;
    const boot = new THREE.Mesh(makeBootGeometry(L, 0.104), leather);
    sk.attach(side + 'Foot', boot, new THREE.Vector3(mx + ax * lc, by - 0.004, mz + az * lc), new THREE.Quaternion().setFromAxisAngle(UP, yaw));
  }
}

// ---------------------------------------------------------------- вещи
const metal = (c, glow) => new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(...c), emissive: new THREE.Color().setRGB(...(glow || [0, 0, 0])), roughness: 0.3, metalness: 0.85 });
function makeProp(kind) {
  const g = new THREE.Group();
  if (kind === 'staff') {
    // Посох Регента: тонкое древко, навершие-кристалл в серебряной оправе
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.02, 1.95, 10).translate(0, 0.975, 0), metal([0.6, 0.62, 0.68])));
    g.add(new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.008, 6, 20).rotateX(Math.PI / 2).translate(0, 1.95, 0), metal([0.7, 0.72, 0.78])));
    g.add(new THREE.Mesh(new THREE.OctahedronGeometry(0.06).scale(0.75, 1.5, 0.75).translate(0, 2.04, 0), metal([0.5, 0.75, 1], [0.6, 1.3, 2.2])));
  } else if (kind === 'crystal') {
    g.add(new THREE.Mesh(new THREE.OctahedronGeometry(0.07).scale(0.7, 1.35, 0.7), metal([0.4, 0.95, 0.85], [0.35, 1.6, 1.35])));
  } else if (kind === 'halo') {
    g.add(new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.006, 6, 64), metal([0.8, 0.85, 1], [0.7, 0.9, 1.5])));
  } else if (kind === 'pauldron') {
    // Наплечник с гребнем и шипом назад-вверх
    const m = metal([0.1, 0.09, 0.08]);
    g.add(new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1.1, 0.75, 1.05), m));
    g.add(new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.2, 6).rotateX(-0.5).translate(0, 0.12, -0.04), m));
  } else if (kind === 'hood') {
    // Капюшон бескрылых, откинутый на плечи
    const cloth = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(0.16, 0.11, 0.07), roughness: 0.9, side: THREE.DoubleSide });
    g.add(new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.06, 8, 24, Math.PI * 1.3).rotateX(Math.PI / 2).rotateY(Math.PI * 0.85).scale(1, 0.7, 1.15), cloth));
  }
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}

// ---------------------------------------------------------------- фабрика и персонаж
export class Personas {
  constructor(root) {
    this.root = root;        // группа города (кадр города)
    this.list = [];
    this.ready = false;
    this.loading = false;
  }

  // Модель грузится один раз при первом прилёте; пока её нет — персонажей рисует толпа (folk.js)
  load(cast) {
    if (this.loading) return;
    this.loading = true;
    new GLTFLoader().loadAsync(URL).then((gltf) => {
      for (const c of cast) if (c.body) this.list.push(this.make(gltf.scene, c));
      this.ready = true;
    }).catch((e) => console.warn('Модель жителей Тарвэна не загрузилась:', e));
  }

  make(source, c) {
    const B = c.body, female = B.sex === 'f';
    const scene = cloneSkinned(source);
    scene.traverse((o) => { if (o.isSkinnedMesh) o.geometry = o.geometry.clone(); });
    const sk = new SkinnedHero({ scene }, { height: B.height, chestScale: female ? 0.87 : 1.08 });
    const body = sk.meshes.find((m) => m.geometry.attributes.position.count > 5000);
    const eyes = sk.meshes.filter((m) => m !== body);
    if (female) sculptFemale(sk, body, eyes); else sculptBody(sk, body, eyes);
    if (female) sk.bone('Head').scale.setScalar(0.96);
    body.material = createPersonaMaterial(sk, body, eyes, B);
    const eyeMat = createEyeMaterial(eyes[0], B.iris[0], B.iris[1]);
    for (const m of eyes) m.material = eyeMat;
    const R = bodyRefs(sk, body);
    // Волосы
    const hz = (front) => (x, y, z) => {
      if (y < R.neck.y + 0.015 || Math.abs(x - R.head.x) > 0.4) return -1;
      const t = (y - R.head.y) / Math.max(R.top - R.head.y, 1e-3);
      const back = clamp((R.head.z - z) / 0.08 + 0.6, 0, 1);
      const side = (female ? -0.09 : 0.06) * smoothstep(0.012, 0.045, Math.abs(x - R.head.x));
      return t - (front + side + (0.05 - front - side) * back * back);
    };
    const sheen = B.hair.map((v) => v * 2.4 + 0.02);
    if (B.style === 'crop' || B.style === 'long' || B.style === 'tail') {
      const front = B.hairFront ?? 0.72, z0 = hz(front);
      const thickK = B.style === 'crop' ? 0.008 : B.style === 'tail' ? 0.006 : 0.013;
      shell(sk, body, R, z0, (x, y, z, zz) => {
        const crown = (y - R.head.y) / Math.max(R.top - R.head.y, 1e-3), edge = Math.pow(smoothstep(-0.012, 0.2, zz), 1.2);
        const frontK = clamp((z - R.head.z) / 0.1 + 0.5, 0, 1);
        // Пробор и зачёс: у длинных — объём сверху, у хвоста — гладко назад
        return [edge * (0.003 + thickK * smoothstep(0.2, 0.8, crown)), 0.004 * edge * frontK * (B.style === 'crop' ? 1 : 0), -0.004 * edge * smoothstep(0.5, 0.9, crown)];
      }, B.hair, sheen);
    } else if (B.style === 'fringe') {
      const z0 = hz(0.72);
      shell(sk, body, R, (x, y, z) => {
        const t = (y - R.head.y) / Math.max(R.top - R.head.y, 1e-3), back = clamp((R.head.z - z) / 0.08 + 0.6, 0, 1);
        const side = smoothstep(0.05, 0.09, Math.abs(x - R.head.x));
        return Math.min(z0(x, y, z), 0.56 - t, back + 0.25 * side - 0.3);
      }, () => [0.006, 0, -0.002], B.hair, sheen);
    }
    // Борода: короткая — плотно по челюсти, полная — длиннее к подбородку
    if (B.beard) {
      const eye = eyeRef(sk, body, eyes, R), full = B.beard === 'full';
      shell(sk, body, R, (x, y, z) => {
        if (y > eye.y - 0.045 || y < R.neck.y - 0.03 || z < R.head.z - 0.035) return -1;
        const fdx = Math.abs(x - R.head.x);
        if (fdx < 0.026 && Math.abs(y - (eye.y - 0.086)) < 0.008 && z > eye.z - 0.02) return -1;   // рот открыт
        return Math.min(eye.y - 0.048 - y, y - (R.neck.y - 0.03), 0.075 - fdx);
      }, (x, y, z, zz) => {
        const chin = smoothstep(eye.y - 0.09, eye.y - 0.14, y) * smoothstep(0.05, 0.0, Math.abs(x - R.head.x));
        const e = smoothstep(-0.01, 0.02, zz);
        return full ? [e * (0.006 + 0.012 * chin), -0.035 * chin * e, 0.006 * chin * e] : [e * 0.0035, 0, 0];
      }, B.hair, sheen);
    }
    addBoots(sk, body, B.boot);

    const model = new HeroModel({ external: true });
    model.group.add(scene);
    model.skinned = sk;
    const group = new THREE.Group();
    group.add(model.group);
    group.visible = false;
    this.root.add(group);
    const P = { c, B, sk, model, group, body, props: {}, t: Math.random() * 10, talk: 0, gest: 0, near: false };
    // Длинные волосы и хвост — к голове
    if (B.style === 'long') {
      const m = new THREE.Mesh(longHairGeometry(B.hairLen || 0.4, 0.2, 0.26), hairMaterial(B.hair, sheen, null, THREE.DoubleSide));
      m.castShadow = true;
      sk.attach('Head', m, sk.byName.Head.bindPos.clone().add(new THREE.Vector3(0, 0, -0.005)));
    } else if (B.style === 'tail') {
      const m = new THREE.Mesh(tailGeometry(), hairMaterial(B.hair, sheen, null));
      m.castShadow = true;
      sk.attach('Head', m, sk.byName.Head.bindPos.clone());
    }
    // Платье в пол
    if (B.gown) {
      const top = R.hips.y + 0.14, bot = R.minY + 0.02;
      const g = new THREE.Mesh(gownGeometry(0, bot - top, 0.165, B.gownR || 0.32), new THREE.MeshPhysicalMaterial({
        color: new THREE.Color().setRGB(...B.gown), vertexColors: true, roughness: 0.6, sheen: 0.6, sheenRoughness: 0.45,
        sheenColor: new THREE.Color().setRGB(...B.gown.map((v) => Math.min(1, v * 0.8 + 0.05))), side: THREE.DoubleSide,
      }));
      g.castShadow = true;
      sk.attach('Hips', g, new THREE.Vector3(R.hips.x, top, R.hips.z * 0.6 + R.chest.z * 0.4));
    }
    // Плащ
    if (B.cape !== undefined) {
      model.cape = new Cape(model.group, {
        color: B.cape, sheenColor: new THREE.Color().setRGB(...(B.capeSheen || [0.2, 0.2, 0.25])), flare: B.capeFlare ?? 2.2, length: B.capeLen ?? B.height - 0.32,
      });
    }
    // Вещи (ставятся каждый кадр по костям)
    for (const k of B.props || []) {
      const m = makeProp(k);
      model.group.add(m);
      P.props[k] = m;
    }
    if (P.props.pauldron) {
      const m2 = makeProp('pauldron');
      model.group.add(m2);
      P.props.pauldron2 = m2;
    }
    P.anim = {
      stand: 1, hover: 0, fly: 0, slam: 0, fall: 0, land: 0, pet: 0, brake: 0, knock: 0, downed: 0, prop: 0, gait: 0, hs: 0, runPhase: 0,
      leanF: 0, leanS: 0, dip: 0, idle: B.pose === 'hips' ? 1 : 0, fp: 0, look: 1, lookYaw: 0, lookPitch: 0, charge: 0, guard: 0,
      lift: 0, carry: 0, grip: 0, choke: 0, wave: 0, throwT: -1, reel: null, blow: null, punch: null, bob: 0,
    };
    c.persona = P;
    return P;
  }

  // cam — камера в кадре города; hero — голова героя в кадре города; talk — кто сейчас говорит
  update(dt, cam, hero, talk, frustum) {
    if (!this.ready) return;
    for (const P of this.list) {
      const p = P.c.person;
      const d = Math.hypot(p.x - cam.x, p.y - cam.y, p.z - cam.z);
      _sph.center.set(p.x + this.root.position.x, p.y + 1 + this.root.position.y, p.z + this.root.position.z);
      const vis = d < DRAW_R && (d < 6 || frustum.intersectsSphere(_sph));
      P.group.visible = vis;
      if (!vis) continue;
      P.group.position.set(p.x, p.y, p.z);
      P.group.rotation.y = p.yaw;
      // Реже — вдали: кадр в 3 для дальних
      P.skip = (P.skip || 0) + 1;
      if (d > 70 && P.skip % 3) continue;
      const adt = d > 70 ? dt * 3 : dt;
      this.pose(P, adt, hero, talk);
    }
  }

  pose(P, dt, hero, talk) {
    const p = P.c.person, A = P.anim, m = P.model, B = P.B;
    P.t += dt;
    // Голова — на героя, пока он рядом
    const dx = hero.x - p.x, dz = hero.z - p.z, dh = Math.hypot(dx, dz);
    let yaw = Math.atan2(dx, dz) - p.yaw;
    yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
    const near = dh < 22 && Math.abs(yaw) < 1.9;
    A.lookYaw = damp(A.lookYaw, near ? clamp(yaw, -0.85, 0.85) : Math.sin(P.t * 0.23) * 0.25, 4, dt);
    A.lookPitch = damp(A.lookPitch, near ? clamp(Math.atan2(hero.y - (p.y + 1.6), dh + 0.3), -0.5, 0.6) : 0, 4, dt);
    // Говорит: руки помогают словам
    const speaking = talk && talk.c === P.c && !talk.choosing && talk.shown < (talk.txt?.length || 0);
    P.talk = damp(P.talk, speaking ? 1 : 0, 3, dt);
    const sk = m.skinned;
    m.skinned = null;
    m.animate(dt, A);
    const j = m.j, tk = P.talk, s = Math.sin(P.t * 2.7), s2 = Math.sin(P.t * 1.9 + 1.3);
    // Своя поза
    if (B.pose === 'staff') {
      j.shR.rotation.x += -0.3; j.shR.rotation.z += 0.04; j.elR.rotation.x += -1.0;
      j.shL.rotation.x += -0.25 - tk * (0.35 + 0.15 * s); j.elL.rotation.x += -0.9 - tk * (0.4 + 0.2 * s2); j.shL.rotation.z += -0.08;
    } else if (B.pose === 'crystal') {
      j.shL.rotation.x += -0.5; j.shL.rotation.z += -0.06; j.elL.rotation.x += -1.25; j.elL.rotation.y += 0.6;
      j.shR.rotation.x += -tk * (0.45 + 0.2 * s); j.elR.rotation.x += -tk * (0.9 + 0.3 * s2);
    } else if (B.pose === 'arms') {
      // Руки скрещены на груди
      j.shL.rotation.set(-0.32, -0.95, 0.18); j.elL.rotation.set(-1.72, 0, 0);
      j.shR.rotation.set(-0.26, 0.95, -0.18); j.elR.rotation.set(-1.62, 0, 0);
      if (tk > 0.01) { j.shR.rotation.x += -0.2 * tk * s; j.shR.rotation.y -= 0.4 * tk; j.elR.rotation.x += 0.7 * tk; }
    } else if (B.pose === 'hips') {
      if (tk > 0.01) { j.shR.rotation.x += -0.8 * tk; j.shR.rotation.y -= 0.38 * tk; j.shR.rotation.z += 0.5 * tk; j.elR.rotation.x += 0.4 * tk + 0.2 * s * tk; }
    } else {
      // Стоит «смирно»: руки вдоль тела; в разговоре — сдержанный жест
      j.shR.rotation.x += -tk * (0.5 + 0.18 * s); j.elR.rotation.x += -tk * (0.8 + 0.25 * s2);
    }
    // Поклон / кивок из реакций толпы
    if (p.bow) { j.spine.rotation.x += p.bow * 0.6; j.neck.rotation.x += p.bow * 0.4; }
    sk.sync(m);
    m.skinned = sk;
    // Вещи по костям (в системе модели)
    const pr = P.props;
    if (pr.staff) {
      m.bonePos('RightHand', _v);
      pr.staff.position.set(_v.x, _v.y - 1.12, _v.z + 0.03);
    }
    if (pr.crystal) {
      m.bonePos('LeftHand', _v);
      pr.crystal.position.set(_v.x, _v.y + 0.16 + Math.sin(P.t * 2) * 0.015, _v.z + 0.06);
      pr.crystal.rotation.y = P.t * 0.9;
    }
    if (pr.halo) {
      m.bonePos('Head', _v);
      pr.halo.position.set(_v.x, _v.y + 0.2, _v.z - 0.14);
      pr.halo.rotation.set(0.25, 0, 0);
    }
    if (pr.pauldron) {
      m.bonePos('LeftArm', _v); pr.pauldron.position.set(_v.x + 0.02, _v.y + 0.035, _v.z); pr.pauldron.rotation.set(0, 0, -0.35);
      m.bonePos('RightArm', _w); pr.pauldron2.position.set(_w.x - 0.02, _w.y + 0.035, _w.z); pr.pauldron2.rotation.set(0, 0, 0.35);
    }
    if (pr.hood) {
      m.bonePos('Neck', _v);
      pr.hood.position.set(_v.x, _v.y - 0.02, _v.z - 0.07);
    }
    // Плащ: тяжесть вниз, лёгкий ветер столицы
    if (m.cape) m.updateCape(Math.min(dt, 1 / 30), GRAV, _w.set(Math.sin(P.t * 0.7) * 1.2, 0, -1.5 + Math.sin(P.t * 1.3) * 0.8), true);
  }

  // Голова персонажа в мире (камера разговора)
  head(c, out) {
    const P = c.persona;
    if (!P || !this.ready || !P.group.visible) return null;
    return P.sk.bone('Head').getWorldPosition(out).add(_w.set(0, 0.06, 0));
  }

  hideAll() { for (const P of this.list) P.group.visible = false; }
}
