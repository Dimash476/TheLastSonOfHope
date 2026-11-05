import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { HeroModel, sculptBody, bodyRefs, BUMP_GLSL, makeBootGeometry, createEyeMaterial } from '../player/model.js';
import { SkinnedHero } from '../player/skinned.js';
import { Cape } from '../player/cape.js';
import { smoothstep } from '../utils.js';

// Ксаррониты: генерал Ксарг и его солдаты.
// Та же базовая модель и тот же процедурный риг, что у героя (поэтому умеют те же движения),
// но своя лепка, свой панцирь и своё лицо. Геометрия и материалы одни на всех: солдат —
// это 2 вызова отрисовки (тело и латы), генерал — ещё волосы и плащ.

const URL = 'assets/models/hero/scene.gltf';
const OPTS = { height: 1.88, chestScale: 1.1 };

export const STYLE = {
  // Ксарг: воронёный, почти чёрный металл, тёмная бронза кромок
  general: {
    plate: [0.016, 0.018, 0.024], plate2: [0.03, 0.032, 0.04], under: [0.012, 0.012, 0.015],
    trim: [0.3, 0.17, 0.065], glow: [1, 0.2, 0.05], rough: 0.36,
  },
  // Солдаты: серая сталь и окислившаяся бронза
  soldier: {
    plate: [0.055, 0.06, 0.07], plate2: [0.085, 0.09, 0.1], under: [0.016, 0.017, 0.02],
    trim: [0.2, 0.09, 0.05], glow: [1.0, 0.42, 0.08], rough: 0.42,
  },
};

const glslVec = (a) => `vec3(${a.map((v) => v.toFixed(4)).join(', ')})`;

// ---------------------------------------------------------------- лепка
// Поверх атлетичной фигуры героя: корпус и бёдра чуть объёмнее (панцирь), у генерала — своё
// лицо: длинное и худое, тяжёлые надбровья, глубокие глазницы, прямой нос, запавшие щёки.
function sculptKin(sk, body, eyes, kind) {
  const g = body.geometry, P = g.attributes.position, N = g.attributes.normal;
  const R = bodyRefs(sk, body), u = R.u;
  let eyeY = R.head.y + 0.06, eyeZ = R.head.z + 0.09;
  if (eyes.length) {
    const box = new THREE.Box3();
    for (const m of eyes) { m.geometry.computeBoundingBox(); box.union(m.geometry.boundingBox.clone().applyMatrix4(sk.meshInv.get(m).clone().invert()).applyMatrix4(sk.meshInv.get(body))); }
    eyeY = (box.min.y + box.max.y) / 2 / u; eyeZ = box.max.z / u;
  }
  const gauss = (d, r) => Math.exp(-(d / r) * (d / r));
  const p = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < P.count; i++) {
    p.set(P.getX(i) / u, P.getY(i) / u, P.getZ(i) / u);
    n.set(N.getX(i), N.getY(i), N.getZ(i));
    const cx = p.x - R.hips.x;
    const isHead = p.y > R.neck.y + 0.02 && Math.abs(cx) < 0.13;
    let push = 0, sx = 1, dy = 0, dz = 0;
    if (!isHead) {
      const torso = smoothstep(R.hips.y + 0.08, R.hips.y + 0.16, p.y) * (1 - smoothstep(R.neck.y - 0.05, R.neck.y, p.y)) * (Math.abs(cx) < 0.25 ? 1 : 0);
      push += 0.011 * torso * (0.45 + 0.55 * Math.max(0, n.z));
      const thigh = (p.y < R.hips.y - 0.06 && p.y > R.knee.y + 0.08) ? 1 : 0;
      push += 0.005 * thigh;
      const shin = (p.y < R.knee.y - 0.06 && p.y > R.foot.y + 0.1) ? 1 : 0;
      push += 0.006 * shin * Math.max(0, n.z);
    } else if (kind === 'general') {
      const hx = p.x - R.head.x, ax = Math.abs(hx);
      const fz = smoothstep(R.head.z - 0.02, R.head.z + 0.05, p.z);
      sx -= 0.04 * gauss(p.y - (eyeY - 0.05), 0.035) * fz;                                  // лицо уже
      push -= 0.0065 * gauss(p.y - (eyeY - 0.062), 0.02) * gauss(ax - 0.05, 0.018) * fz;    // запавшие щёки
      push += 0.003 * gauss(p.y - (eyeY - 0.022), 0.012) * gauss(ax - 0.056, 0.014) * fz;   // скулы
      dz += 0.0048 * gauss(p.y - (eyeY + 0.021), 0.008) * gauss(ax - 0.028, 0.034) * fz;    // надбровья
      push -= 0.0032 * gauss(p.y - (eyeY + 0.002), 0.011) * gauss(ax - 0.034, 0.017) * fz;  // глазницы
      dz += 0.0036 * gauss(p.y - (eyeY - 0.024), 0.03) * gauss(ax, 0.009) * fz;             // прямой нос
      dy -= 0.0055 * smoothstep(eyeY - 0.09, eyeY - 0.135, p.y) * fz;                       // длинный подбородок
    }
    const x = isHead ? R.head.x + (p.x - R.head.x) * sx : p.x;
    P.setXYZ(i, (x + n.x * push) * u, (p.y + n.y * push + dy) * u, (p.z + n.z * push + dz) * u);
  }
  P.needsUpdate = true;
  g.computeVertexNormals();
  g.computeBoundingBox();
}

// ---------------------------------------------------------------- панцирь в шейдере
// Плиты, швы и окантовка рисуются по координатам исходной позы (метры) и получают рельеф.
// Руки в этой позе идут вдоль X, поэтому зоны рук — по |x|, ног и корпуса — по y.
function createKinBodyMaterial(sk, mesh, eyes, kind) {
  const R = bodyRefs(sk, mesh), S = STYLE[kind];
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
  const face = kind === 'general';
  const mat = new THREE.MeshPhysicalMaterial({ roughness: 0.62, metalness: 0.0, sheen: 0.3, sheenRoughness: 0.5, sheenColor: new THREE.Color(0.2, 0.2, 0.22) });
  const uRage = mat.userData.uRage = { value: 0 };
  mat.customProgramCacheKey = () => 'kin-body-' + kind;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      uHead: { value: R.head }, uNeckY: { value: R.neck.y }, uTop: { value: R.top },
      uChest: { value: R.chest }, uHipsY: { value: R.hips.y },
      uKneeY: { value: R.knee.y }, uFootY: { value: R.foot.y },
      uElbowX: { value: Math.abs(R.fore.x - R.chest.x) }, uWristX: { value: Math.abs(R.hand.x - R.chest.x) },
      uU: { value: R.u }, uEye: { value: eye }, uFootTop: { value: R.minY + 0.08 }, uRage,
    });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBind;\nvarying vec3 vBindN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBind = position;\nvBindN = normal;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vBind;
        varying vec3 vBindN;
        uniform vec3 uHead, uChest, uEye;
        uniform float uNeckY, uTop, uHipsY, uKneeY, uFootY, uElbowX, uWristX, uU, uFootTop, uRage;
        float zPlate = 0.0, zTrim = 0.0, zSkin = 0.0, zHair = 0.0, kinH = 0.0, kinGlow = 0.0, kinRough = 0.0;
        ${BUMP_GLSL}
        float groove(float d, float w) { return 1.0 - smoothstep(w * 0.55, w, d); }
        float hash31(vec3 p) { return fract(sin(dot(p, vec3(12.9, 78.2, 37.7))) * 43758.5); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 p = vBind / uU;
          if (p.y < uFootTop) discard;   // ступня спрятана под сапогом
          ${face ? '' : 'if (p.y > uNeckY + 0.03 && abs(p.x - uChest.x) < 0.2) discard;   // голова внутри шлема'}
          vec3 nb = normalize(vBindN);
          float px = length(fwidth(p));
          float fine = 1.0 - smoothstep(0.0008, 0.0025, px);
          float ax = abs(p.x - uChest.x);
          float frontK = smoothstep(-0.05, 0.25, nb.z);
          float beltY = uHipsY + 0.105;
          float isArm = step(0.238, ax);
          float seam = 0.0, trim = 0.0, plate = 0.0, tone = 0.0;

          // ---- корпус: грудные плиты, шеврон, сегменты живота, спина
          float torso = (1.0 - isArm) * step(beltY, p.y) * step(p.y, uNeckY + 0.01);
          if (torso > 0.5) {
            float pecEdge = uChest.y - 0.1 + ax * 0.34;           // нижний край груди — шеврон вверх к бокам
            float pecD = p.y - pecEdge;
            float pec = step(0.0, pecD) * step(ax, 0.222);
            float absW = 0.128 + (p.y - beltY) * 0.34;
            float abT = (p.y - beltY - ax * 0.2) / 0.044;
            float abs_ = (1.0 - pec) * step(ax, absW);
            plate = max(pec, abs_);
            seam = max(seam, torso * groove(ax, 0.0042) * step(p.y, uChest.y + 0.16));              // грудина
            seam = max(seam, groove(abs(pecD), 0.0046) * step(ax, 0.222));                          // край груди
            seam = max(seam, abs_ * groove(abs(fract(abT) - 0.5) * 0.044, 0.0034));                  // сегменты
            seam = max(seam, groove(abs(ax - absW), 0.0042) * (1.0 - pec));                          // бока живота
            seam = max(seam, pec * groove(abs(ax - 0.222), 0.004));
            // Косая линия от ключицы к центру груди и кромка из бронзы
            float d1 = abs((ax - 0.2) * 0.62 + (p.y - (uChest.y + 0.06)) * 0.78);
            trim = max(trim, pec * frontK * groove(d1, 0.0052));
            tone = pec * smoothstep(0.08, 0.2, ax) * 0.4;
            // Спина: продольный гребень и лопатки
            float back = 1.0 - frontK;
            seam = max(seam, back * torso * groove(abs(ax - 0.095), 0.0042) * step(uChest.y - 0.1, p.y));
          }

          // ---- руки: стёганый рукав, наплечная плита сверху, наруч до кисти
          if (isArm > 0.5) {
            float vamb = step(uElbowX + 0.06, ax) * step(ax, uWristX + 0.012);
            float upper = step(ax, uElbowX - 0.03);
            float elbow = step(uElbowX - 0.03, ax) * step(ax, uElbowX + 0.06);
            if (vamb > 0.5) {
              plate = 1.0;
              trim = max(trim, groove(abs(ax - (uElbowX + 0.06)), 0.0055));
              trim = max(trim, groove(abs(ax - (uWristX + 0.012)), 0.0055));
              seam = max(seam, groove(abs(nb.y - 0.25), 0.05) * smoothstep(0.1, 0.0, abs(nb.z)));
              // Ребро наруча снаружи
              kinH += 0.003 * smoothstep(0.55, 0.95, nb.y);
            } else if (upper > 0.5) {
              plate = smoothstep(0.15, 0.3, nb.y);
              seam = max(seam, groove(abs(nb.y - 0.22), 0.05));
              seam = max(seam, plate * groove(abs(fract(ax / 0.06) - 0.5) * 0.06, 0.003));
            } else if (elbow > 0.5) {
              float ribs = abs(fract(ax / 0.016) - 0.5) * 0.016;
              seam = max(seam, groove(ribs, 0.0028) * fine);
            }
          }

          // ---- пояс и пряжка
          float belt = (1.0 - isArm) * step(abs(p.y - beltY), 0.028);
          if (belt > 0.5) {
            plate = 0.6;
            trim = max(trim, groove(abs(abs(p.y - beltY) - 0.026), 0.004));
            float buckle = frontK * step(ax, 0.032) * step(abs(p.y - beltY), 0.024);
            trim = max(trim, buckle);
            kinH += buckle * 0.0026;
          }

          // ---- таз: набедренные щитки спереди
          float hipZone = (1.0 - isArm) * step(uHipsY - 0.13, p.y) * step(p.y, beltY - 0.028);
          if (hipZone > 0.5) {
            float tasset = frontK;
            plate = max(plate, tasset);
            seam = max(seam, frontK * groove(ax, 0.0036));
            seam = max(seam, groove(abs(fract((beltY - p.y) / 0.06) - 0.5) * 0.06, 0.0034) * tasset * step(0.05, ax));
          }

          // ---- ноги: щиток бедра, наколенник, поножи
          float leg = step(p.y, uHipsY - 0.13);
          if (leg > 0.5) {
            float lx = abs(ax - 0.105);
            float thigh = step(uKneeY + 0.085, p.y);
            float knee = step(uKneeY - 0.065, p.y) * step(p.y, uKneeY + 0.085);
            float shin = step(p.y, uKneeY - 0.065);
            if (thigh > 0.5) {
              float panel = frontK * step(lx, 0.062);
              plate = max(plate, panel);
              seam = max(seam, frontK * groove(abs(lx - 0.062), 0.004));
              seam = max(seam, panel * groove(abs(fract((p.y - uKneeY) / 0.13) - 0.5) * 0.13, 0.0035));
              tone = panel * 0.25;
            } else if (knee > 0.5) {
              plate = max(plate, frontK);
              trim = max(trim, frontK * groove(abs(p.y - (uKneeY + 0.085)), 0.004));
              trim = max(trim, frontK * groove(abs(p.y - (uKneeY - 0.065)), 0.004));
              kinH += frontK * 0.004 * smoothstep(0.06, 0.0, abs(p.y - uKneeY - 0.01));
            } else if (shin > 0.5) {
              float greave = smoothstep(-0.35, -0.1, nb.z);
              plate = max(plate, greave);
              seam = max(seam, groove(abs(nb.z + 0.2), 0.05));
              seam = max(seam, greave * groove(lx, 0.0038));   // ребро голени
              tone = greave * 0.3;
            }
          }

          // ---- перчатки
          float glove = step(uWristX + 0.012, ax);

          // ---- эмблема на груди: перевёрнутый треугольник, рассечённый чертой
          vec2 e = vec2(ax, p.y - (uChest.y + 0.075));
          float ef = (1.0 - isArm) * step(uChest.z + 0.02, p.z) * smoothstep(0.0, 0.3, nb.z);
          float tri = max(e.x * 1.1 + e.y * 0.62 - 0.046, -e.y - 0.075 + e.x * 0.0);
          tri = max(e.x * 1.0 - (e.y + 0.075) * 0.62, e.y - 0.022);
          float emb = ef * (1.0 - smoothstep(-0.0015, 0.0015, tri));
          float cut = ef * step(e.x, 0.0042) * step(-0.066, e.y) * step(e.y, 0.03);
          float embOuter = ef * (1.0 - smoothstep(0.0025, 0.0055, abs(tri)));
          emb *= 1.0 - cut;
          kinH += (emb + cut * 0.4) * 0.0022;

          // ---- сборка цветов
          float ribs = sin(p.y * 900.0 + ax * 300.0);
          vec3 plateC = mix(${glslVec(S.plate)}, ${glslVec(S.plate2)}, tone);
          vec3 underC = ${glslVec(S.under)} * (1.0 + 0.5 * fine * ribs);
          vec3 trimC = ${glslVec(S.trim)};
          float scratch = hash31(floor(p * 700.0));
          vec3 col = mix(underC, plateC * (0.86 + 0.28 * scratch * fine), plate);
          col *= 1.0 - seam * 0.72;
          col = mix(col, ${glslVec(S.under)} * 1.4, glove);
          col = mix(col, trimC, trim);
          col = mix(col, trimC * 1.2, max(emb, embOuter));
          zPlate = max(plate, emb);
          zTrim = max(trim, max(emb, embOuter));
          kinH += plate * 0.0024 - seam * 0.0022 + trim * 0.0012;
          kinH += (1.0 - plate) * fine * ribs * 0.00016;
          kinRough = 0.05 * (scratch - 0.5) * fine;
          // Швы генерала раскаляются в ярости
          kinGlow = seam * uRage;
          ${face ? `
          // ---- лицо, волосы, шея
          float fdx = abs(p.x - uHead.x);
          zSkin = step(uNeckY + 0.012, p.y) * step(fdx, 0.4);
          float t = (p.y - uHead.y) / max(uTop - uHead.y, 1e-3);
          float backK = clamp((uHead.z - p.z) / 0.08 + 0.6, 0.0, 1.0);
          // Мысок надо лбом и высокие залысины у висков
          float hFront = 0.655 + 0.15 * smoothstep(0.004, 0.05, fdx);
          float hairLine = mix(hFront, 0.05, backK * backK);
          zHair = zSkin * smoothstep(hairLine - 0.012, hairLine + 0.012, t);
          float ex = abs(uEye.x - uHead.x);
          float dx = fdx - ex;
          float faceFront = step(uEye.z - 0.05, p.z);
          // Брови: низкие, прямые, тяжёлые, сходятся к переносице
          float browY = uEye.y + 0.0182 + dx * 0.2;
          float bw = mix(0.0064, 0.0032, clamp(dx / 0.022 * 0.5 + 0.5, 0.0, 1.0));
          float brow = zSkin * step(uEye.z - 0.02, p.z) * (1.0 - smoothstep(0.019, 0.024, abs(dx + 0.002))) * (1.0 - smoothstep(bw * 0.7, bw, abs(p.y - browY)));
          // Кожа: бледная, холодная; глазницы и щёки — в тени
          vec3 skin = vec3(0.34, 0.215, 0.165);
          vec3 skinC = skin;
          skinC = mix(skinC, skin * vec3(1.06, 0.9, 0.86), zSkin * smoothstep(0.012, 0.0, fdx) * smoothstep(0.03, 0.0, abs(p.y - (uEye.y - 0.035))) * step(uEye.z, p.z) * 0.5);
          float lips = zSkin * smoothstep(0.024, 0.015, fdx) * smoothstep(0.0065, 0.002, abs(p.y - (uEye.y - 0.085))) * step(uEye.z - 0.012, p.z);
          skinC = mix(skinC, skinC * vec3(0.8, 0.58, 0.56), lips * 0.75);
          // Щетина и седина на подбородке
          float stub = zSkin * faceFront * smoothstep(uEye.y - 0.05, uEye.y - 0.08, p.y) * smoothstep(uNeckY + 0.02, uNeckY + 0.07, p.y) * (1.0 - lips);
          stub = max(stub, zSkin * faceFront * smoothstep(0.03, 0.02, fdx) * smoothstep(0.006, 0.0, abs(p.y - (uEye.y - 0.071))));
          float stubN = fract(sin(dot(floor(p * 2200.0), vec3(12.9, 78.2, 37.7))) * 43758.5);
          skinC = mix(skinC, skinC * vec3(0.55, 0.55, 0.6), stub * (0.5 + 0.3 * stubN));
          float sockets = zSkin * faceFront * exp(-pow((p.y - (uEye.y + 0.004)) / 0.017, 2.0)) * exp(-pow((fdx - ex) / 0.025, 2.0));
          float underCheek = zSkin * faceFront * exp(-pow((p.y - (uEye.y - 0.06)) / 0.018, 2.0)) * exp(-pow((fdx - 0.05) / 0.016, 2.0));
          float underJaw = zSkin * smoothstep(-0.15, -0.65, nb.y) * step(p.y, uEye.y - 0.05);
          float nostril = zSkin * exp(-pow((p.y - (uEye.y - 0.055)) / 0.006, 2.0)) * exp(-pow((fdx - 0.014) / 0.006, 2.0)) * step(uEye.z - 0.01, p.z);
          float mouthLine = zSkin * exp(-pow((p.y - (uEye.y - 0.086)) / 0.0018, 2.0)) * smoothstep(0.024, 0.014, fdx) * step(uEye.z - 0.012, p.z);
          // Складки от носа к углам рта и у переносицы — лицо сурового человека
          float fold = zSkin * faceFront * exp(-pow(((fdx - 0.016 - (uEye.y - 0.05 - p.y) * 0.45)) / 0.0024, 2.0)) * smoothstep(uEye.y - 0.045, uEye.y - 0.055, p.y) * smoothstep(uEye.y - 0.095, uEye.y - 0.08, p.y);
          float frown = zSkin * faceFront * exp(-pow((fdx - 0.0055) / 0.0016, 2.0)) * exp(-pow((p.y - (uEye.y + 0.02)) / 0.012, 2.0));
          // Тяжёлое верхнее веко
          float lid = zSkin * faceFront * exp(-pow((p.y - (uEye.y + 0.0088)) / 0.0026, 2.0)) * exp(-pow((fdx - ex) / 0.018, 2.0));
          skinC *= 1.0 - 0.3 * sockets - 0.14 * underCheek - 0.32 * underJaw - 0.4 * nostril - 0.42 * mouthLine - 0.3 * fold - 0.28 * frown - 0.55 * lid;
          // Старый шрам через левую бровь
          float sx = p.x - uHead.x - ex, sy = p.y - uEye.y - 0.02;
          float scar = zSkin * faceFront * exp(-pow((sx + sy * 0.28) / 0.0013, 2.0)) * smoothstep(0.034, 0.024, abs(sy));
          skinC = mix(skinC, skin * vec3(1.15, 0.86, 0.84), scar * 0.8);
          vec3 hairC = vec3(0.012, 0.011, 0.012);
          col = mix(col, skinC, zSkin);
          col = mix(col, hairC, max(zHair, brow * 0.92 * (1.0 - scar)));
          zSkin *= 1.0 - zHair;
          kinH *= 1.0 - step(0.5, zSkin);
          ` : ''}
          diffuseColor.rgb = col;
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, ${S.rough.toFixed(2)} + kinRough, zPlate);
        roughnessFactor = mix(roughnessFactor, 0.34, zTrim);
        roughnessFactor = mix(roughnessFactor, 0.46, zSkin);
        roughnessFactor = mix(roughnessFactor, 0.72, zHair);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        metalnessFactor = mix(metalnessFactor, 0.82, zPlate * (1.0 - zSkin));
        metalnessFactor = mix(metalnessFactor, 1.0, zTrim * (1.0 - zSkin));`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        normal = heroBump(-vViewPosition, normal, kinH);`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
        material.sheenColor *= (1.0 - zPlate) * (1.0 - zTrim) * (1.0 - zSkin);
        material.sheenColor += vec3(0.1, 0.035, 0.022) * zSkin * (1.0 - zHair);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += ${glslVec(S.glow)} * kinGlow * 2.5;`);
  };
  return mat;
}

// ---------------------------------------------------------------- жёсткие детали
// Наплечники, воротник, сапоги, шлем: всё сливается в одну сетку на том же скелете.
// Каждая деталь привязана целиком к своей кости и строится в метрах в системе модели.
class Parts {
  constructor(sk, body) {
    this.sk = sk;
    this.body = body;
    this.toMesh = sk.meshInv.get(body);
    this.nm = new THREE.Matrix3().getNormalMatrix(this.toMesh);
    this.pos = []; this.nrm = []; this.col = []; this.glow = []; this.si = []; this.sw = []; this.idx = [];
  }

  bone(name) { return this.body.skeleton.bones.indexOf(this.sk.bone(name)); }
  at(name) { return this.sk.byName[name].bindPos.clone(); }

  // color: [r, g, b] (линейный) — поверх цвета вершин детали; glow: 0..1 — свечение
  add(geo, boneName, matrix, { color = [1, 1, 1], glow = 0 } = {}) {
    const g = geo.index ? geo : geo;
    const P = g.attributes.position, N = g.attributes.normal, C = g.attributes.color;
    const base = this.pos.length / 3, bi = this.bone(boneName);
    const v = new THREE.Vector3(), n = new THREE.Vector3();
    const nmx = new THREE.Matrix3().getNormalMatrix(matrix);
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i).applyMatrix4(matrix).applyMatrix4(this.toMesh);
      n.fromBufferAttribute(N, i).applyMatrix3(nmx).applyMatrix3(this.nm).normalize();
      this.pos.push(v.x, v.y, v.z);
      this.nrm.push(n.x, n.y, n.z);
      const c = C ? [C.getX(i), C.getY(i), C.getZ(i)] : [1, 1, 1];
      this.col.push(c[0] * color[0], c[1] * color[1], c[2] * color[2]);
      this.glow.push(glow);
      this.si.push(bi, 0, 0, 0);
      this.sw.push(1, 0, 0, 0);
    }
    const I = g.index;
    if (I) for (let i = 0; i < I.count; i++) this.idx.push(base + I.getX(i));
    else for (let i = 0; i < P.count; i++) this.idx.push(base + i);
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aGlow', new THREE.Float32BufferAttribute(this.glow, 1));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    g.setIndex(this.idx);
    return g;
  }
}

const M = (x, y, z, sx = 1, sy = sx, sz = sx, rx = 0, ry = 0, rz = 0) => new THREE.Matrix4().compose(
  new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz),
);

// Изогнутая пластина: участок эллипсоида. side — ±1, куда смотрит её «внешняя» сторона по X
function shellGeometry(phiS, phiL, thS, thL, wSeg = 16, hSeg = 8) {
  return new THREE.SphereGeometry(1, wSeg, hSeg, phiS, phiL, thS, thL);
}

// Стоячий воротник: развёртка вокруг шеи, спереди открыт, сзади выше и расходится наружу
function collarGeometry({ rBottom, rTop, hBack, hFront, open, base, rim }) {
  const NA = 36, NY = 6, pos = [], col = [], idx = [];
  for (let i = 0; i <= NA; i++) {
    const t = i / NA, a = -Math.PI + open + (Math.PI - open) * 2 * t;   // a=0 — спереди, ±π — сзади
    const backK = Math.pow(Math.abs(a) / Math.PI, 1.6);
    const h = hFront + (hBack - hFront) * backK;
    for (let j = 0; j <= NY; j++) {
      const v = j / NY, r = rBottom + (rTop - rBottom) * v * v;
      pos.push(Math.sin(a) * r, v * h, Math.cos(a) * r * 1.02);
      col.push(...(rim && j === NY ? rim : base));
    }
  }
  for (let i = 0; i < NA; i++) for (let j = 0; j < NY; j++) {
    const A = i * (NY + 1) + j, B = A + NY + 1;
    idx.push(A, A + 1, B, B, A + 1, B + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Шлем солдата: вытянутый назад, с гребнем и опущенной защитой шеи
function helmetGeometry() {
  const g = new THREE.SphereGeometry(1, 40, 30);
  const P = g.attributes.position;
  for (let i = 0; i < P.count; i++) {
    const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
    let X = x * 0.112, Y = y * 0.135, Z = z * 0.14;
    if (y < 0) {
      const k = -y;
      X *= 1 - 0.3 * k * Math.max(0, z);       // сужается к подбородку
      Z += 0.018 * k * Math.max(0, z);         // подбородок вперёд
      Y -= 0.02 * k * k;
      if (z < 0) { Y -= 0.05 * k * -z; Z -= 0.018 * k * -z; X *= 1 + 0.12 * k; }   // защита шеи
    }
    Y += 0.016 * Math.exp(-(x / 0.1) * (x / 0.1)) * Math.max(0, y);   // гребень
    Z -= 0.018 * Math.max(0, y) * Math.max(0, -z);                    // вытянут назад
    if (z > 0.1 && y > 0.12 && y < 0.42) Z += 0.008;                  // козырёк над визором
    P.setXYZ(i, X, Y, Z);
  }
  g.computeVertexNormals();
  return g;
}

function buildParts(sk, body, kind) {
  const S = STYLE[kind], parts = new Parts(sk, body);
  const R = bodyRefs(sk, body);
  const toModel = sk.meshInv.get(body).clone().invert();
  const metal = S.plate2.map((v) => v * 1.5), dark = S.plate.map((v) => v * 1.3), bronze = S.trim.map((v) => v * 1.1);

  // ---- сапоги: форма как у героя, по размеру ступни
  const P = body.geometry.attributes.position;
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
    const lc = (l0 + l1) / 2, L = Math.min(0.3, l1 - l0 + 0.012);
    parts.add(makeBootGeometry(L, 0.112), side + 'Foot', M(mx + ax * lc, by - 0.004, mz + az * lc, 1, 1, 1, 0, yaw, 0), { color: dark });
    // Стальной носок и обхват голени над сапогом
    const toe = shellGeometry(0, Math.PI * 2, 0, Math.PI * 0.5);
    parts.add(toe, side + 'Foot', M(mx + ax * (lc + L * 0.27), by + 0.018, mz + az * (lc + L * 0.27), 0.05, 0.03, 0.075, 0, yaw, 0), { color: metal });
    const a = parts.at(side + 'Foot');
    const cuff = new THREE.CylinderGeometry(0.058, 0.052, 0.09, 18, 1, true);
    parts.add(cuff, side + 'Foot', M(a.x, a.y + 0.055, a.z + 0.006, 1, 1, 1.08), { color: dark });
  }

  // ---- наплечники: неподвижный щиток на ключице и пластины на плече
  const layered = kind === 'general';
  for (const [side, sign] of [['Left', 1], ['Right', -1]]) {
    const A = parts.at(side + 'Arm');
    // Щиток над плечом — на кости груди, чтобы плечо двигалось под ним
    parts.add(shellGeometry(0, Math.PI * 2, 0, Math.PI * 0.52, 20, 8), 'Spine2',
      M(A.x - sign * 0.022, A.y + 0.012, A.z, 0.098, layered ? 0.066 : 0.056, 0.118, 0, 0, sign * -0.26), { color: metal });
    const lip = new THREE.TorusGeometry(1, 0.014, 6, 28);
    // Пластины по плечу: сверху вниз, каждая заходит на следующую
    const n = layered ? 3 : 2;
    for (let i = 0; i < n; i++) {
      const k = i / Math.max(1, n - 1);
      const x = A.x + sign * (0.035 + 0.058 * i), y = A.y + 0.022 - 0.013 * i;
      const g = shellGeometry(0, Math.PI * 2, 0, Math.PI * 0.58, 20, 7);
      parts.add(g, side + 'Arm', M(x, y, A.z - 0.005, 0.082 - 0.008 * i, 0.067 - 0.007 * i, 0.092 - 0.006 * i, 0, 0, sign * (-0.1 - 0.12 * k)), { color: i === 0 ? metal : dark });
      parts.add(lip, side + 'Arm', M(x, y, A.z - 0.005, 0.082 - 0.008 * i, 0.092 - 0.006 * i, 0.32, Math.PI / 2, 0, sign * (-0.1 - 0.12 * k)), { color: bronze });
    }
  }

  const neck = parts.at('Neck');
  if (kind === 'general') {
    // ---- высокий воротник: внешняя и внутренняя пластины, сзади выше затылка шеи
    const col = collarGeometry({ rBottom: 0.112, rTop: 0.15, hBack: 0.2, hFront: 0.036, open: 0.98, base: metal, rim: bronze });
    parts.add(col, 'Spine2', M(neck.x, neck.y - 0.058, neck.z + 0.016));
    const inner = collarGeometry({ rBottom: 0.1, rTop: 0.116, hBack: 0.12, hFront: 0.03, open: 1.12, base: dark });
    parts.add(inner, 'Spine2', M(neck.x, neck.y - 0.06, neck.z + 0.014));
    // Застёжка плаща: планка поперёк верха спины
    const bar = new THREE.BoxGeometry(0.34, 0.03, 0.022);
    parts.add(bar, 'Spine2', M(0, neck.y - 0.065, neck.z - 0.078, 1, 1, 1, 0.25, 0, 0), { color: bronze });
  } else {
    // ---- горжет солдата и шлем со светящимся визором
    const gorget = collarGeometry({ rBottom: 0.108, rTop: 0.1, hBack: 0.09, hFront: 0.06, open: 0.06, base: dark });
    parts.add(gorget, 'Spine2', M(neck.x, neck.y - 0.052, neck.z + 0.012));
    const hc = new THREE.Vector3(R.head.x, R.top - 0.118, R.head.z + 0.045);
    // Кости-голова: шлем крепится к ней целиком
    parts.add(helmetGeometry(), 'Head', M(hc.x, hc.y, hc.z), { color: metal });
    const visor = new THREE.SphereGeometry(1, 28, 3, Math.PI / 2 - 0.92, 1.84, 1.34, 0.11);
    parts.add(visor, 'Head', M(hc.x, hc.y, hc.z, 0.1145, 0.138, 0.1445), { color: [0.1, 0.05, 0.02], glow: 1 });
    const ridge = new THREE.BoxGeometry(0.008, 0.02, 0.19);
    parts.add(ridge, 'Head', M(hc.x, hc.y + 0.147, hc.z - 0.018), { color: bronze });
    // Спинной блок: ребристая плита между лопаток
    const pack = new THREE.BoxGeometry(0.24, 0.26, 0.05, 3, 4, 1);
    parts.add(pack, 'Spine2', M(0, 1.44, -0.178, 1, 1, 1, 0.06, 0, 0), { color: dark });
    for (const s of [-1, 1]) parts.add(new THREE.CylinderGeometry(0.024, 0.03, 0.2, 10), 'Spine2', M(s * 0.075, 1.45, -0.2), { color: metal });
  }
  return parts.build();
}

function createPartsMaterial(kind) {
  const S = STYLE[kind];
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: S.rough, metalness: 0.88, side: THREE.DoubleSide });
  mat.customProgramCacheKey = () => 'kin-parts-' + kind;
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aGlow;\nvarying float vGlowK;\nvarying vec3 vPart;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlowK = aGlow;\nvPart = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGlowK;\nvarying vec3 vPart;')
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        float pn = fract(sin(dot(floor(vPart * 1800.0), vec3(12.9, 78.2, 37.7))) * 43758.5);
        roughnessFactor += (pn - 0.5) * 0.06;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += ${glslVec(S.glow)} * vGlowK * 5.0;`);
  };
  return mat;
}

// ---------------------------------------------------------------- волосы генерала
// Короткая военная стрижка: участок кожи головы выдавлен по нормалям на несколько миллиметров,
// виски седые, сквозь короткий волос у шеи просвечивает кожа.
function buildCropHair(sk, body) {
  const R = bodyRefs(sk, body);
  const g = body.geometry, P = g.attributes.position, N = g.attributes.normal;
  const zoneOf = (x, y, z) => {
    if (y < R.neck.y + 0.012 || Math.abs(x - R.head.x) > 0.4) return -1;
    const t = (y - R.head.y) / Math.max(R.top - R.head.y, 1e-3);
    const back = THREE.MathUtils.clamp((R.head.z - z) / 0.08 + 0.6, 0, 1);
    if (Math.abs(x - R.head.x) > 0.066 && t < 0.38) return -1;   // над ушами, но не на них
    const front = 0.655 + 0.055 * smoothstep(0.004, 0.05, Math.abs(x - R.head.x));
    return t - THREE.MathUtils.lerp(front, 0.05, back * back);
  };
  const zone = new Float32Array(P.count);
  for (let i = 0; i < P.count; i++) zone[i] = zoneOf(P.getX(i) / R.u, P.getY(i) / R.u, P.getZ(i) / R.u);
  const idx = g.index.array, remap = new Map(), tris = [];
  for (let k = 0; k < idx.length; k += 3) {
    const a = idx[k], b = idx[k + 1], c = idx[k + 2];
    if (Math.min(zone[a], zone[b], zone[c]) < -0.012) continue;
    for (const v of [a, b, c]) {
      if (!remap.has(v)) remap.set(v, remap.size);
      tris.push(remap.get(v));
    }
  }
  const n = remap.size, pos = new Float32Array(n * 3), si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  const SI = g.attributes.skinIndex, SW = g.attributes.skinWeight;
  for (const [v, j] of remap) {
    const x = P.getX(v) / R.u, y = P.getY(v) / R.u, z = P.getZ(v) / R.u;
    const edge = Math.pow(smoothstep(-0.012, 0.16, zone[v]), 1.2);
    const crown = smoothstep(0.55, 0.85, (y - R.head.y) / Math.max(R.top - R.head.y, 1e-3));
    const thick = edge * (0.0022 + 0.0055 * crown);
    pos[j * 3] = (x + N.getX(v) * thick) * R.u;
    pos[j * 3 + 1] = (y + N.getY(v) * thick) * R.u;
    pos[j * 3 + 2] = (z + N.getZ(v) * thick) * R.u;
    for (let c = 0; c < 4; c++) { si[j * 4 + c] = SI.getComponent(v, c); sw[j * 4 + c] = SW.getComponent(v, c); }
  }
  const hg = new THREE.BufferGeometry();
  hg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  hg.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  hg.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  hg.setIndex(tris);
  hg.computeVertexNormals();

  const mat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color().setRGB(0.014, 0.0125, 0.013), roughness: 0.52,
    sheen: 0.35, sheenRoughness: 0.4, sheenColor: new THREE.Color().setRGB(0.07, 0.07, 0.08),
  });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, { uU: { value: R.u }, uHeadY: { value: R.head.y }, uTop: { value: R.top }, uHeadX: { value: R.head.x } });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHair;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHair = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vHair;\nuniform float uU, uHeadY, uTop, uHeadX;\n${BUMP_GLSL}\nfloat hairH = 0.0;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 p = vHair / uU;
          float fine = 1.0 - smoothstep(0.0004, 0.0012, length(fwidth(p)));
          float dots = fract(sin(dot(floor(p * 2400.0), vec3(12.9, 78.2, 37.7))) * 43758.5);
          float crown = (p.y - uHeadY) / max(uTop - uHeadY, 1e-3);
          // Седина на висках: только там, где виски, и только часть волосков
          float temple = smoothstep(0.05, 0.085, abs(p.x - uHeadX)) * (1.0 - smoothstep(0.5, 0.85, crown));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2, 0.2, 0.21), temple * step(0.4, dots) * 0.75);
          diffuseColor.rgb *= mix(1.0, 0.72 + 0.56 * dots, fine);
          // Сквозь короткий волос внизу просвечивает кожа
          float fade = (1.0 - smoothstep(0.08, 0.32, crown)) * 0.65;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.3, 0.19, 0.145) * 0.8, fade * (0.5 + 0.5 * dots * fine));
          hairH = dots * 0.00022 * fine;
        }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        normal = heroBump(-vViewPosition, normal, hairH);`);
  };
  return { geometry: hg, material: mat };
}

// ---------------------------------------------------------------- фабрика
export class KinFactory {
  constructor() {
    this.ready = false;
    this.waiting = [];
    new GLTFLoader().loadAsync(URL).then((gltf) => {
      this.source = gltf.scene;
      this.protos = { general: this.prepare('general'), soldier: this.prepare('soldier') };
      this.ready = true;
      for (const fn of this.waiting) fn();
      this.waiting = [];
    }).catch((e) => console.warn('Модель ксарронитов не загрузилась:', e));
  }

  whenReady(fn) { if (this.ready) fn(); else this.waiting.push(fn); }

  prepare(kind) {
    const scene = cloneSkinned(this.source);
    const geos = [];
    scene.traverse((o) => { if (o.isSkinnedMesh) { o.geometry = o.geometry.clone(); geos.push(o.geometry); } });
    const sk = new SkinnedHero({ scene }, OPTS);
    const body = sk.meshes.find((m) => m.geometry.attributes.position.count > 5000);
    const eyes = sk.meshes.filter((m) => m !== body);
    sculptBody(sk, body, eyes);
    sculptKin(sk, body, eyes, kind);
    const proto = {
      geos,
      bodyMat: createKinBodyMaterial(sk, body, eyes, kind),
      partsGeo: buildParts(sk, body, kind),
      partsMat: createPartsMaterial(kind),
    };
    if (kind === 'general') {
      proto.hair = buildCropHair(sk, body);
      // Глаза генерала: холодные, почти бесцветные
      proto.eyeMat = createEyeMaterial(eyes[0], 'vec3(0.2, 0.2, 0.19)', 'vec3(0.42, 0.4, 0.34)');
    }
    return proto;
  }

  make(kind) {
    const P = this.protos[kind];
    const scene = cloneSkinned(this.source);
    let i = 0;
    scene.traverse((o) => { if (o.isSkinnedMesh) o.geometry = P.geos[i++]; });
    const sk = new SkinnedHero({ scene }, OPTS);
    const body = sk.meshes.find((m) => m.geometry.attributes.position.count > 5000);
    const eyes = sk.meshes.filter((m) => m !== body);
    body.material = P.bodyMat;
    const attachSkinned = (geometry, material, shadow = true) => {
      const m = new THREE.SkinnedMesh(geometry, material);
      m.position.copy(body.position);
      m.quaternion.copy(body.quaternion);
      m.scale.copy(body.scale);
      m.bind(body.skeleton, body.bindMatrix);
      m.castShadow = shadow;
      m.receiveShadow = true;
      m.frustumCulled = false;
      body.parent.add(m);
      return m;
    };
    attachSkinned(P.partsGeo, P.partsMat);
    const model = new HeroModel({ external: true });
    if (kind === 'general') {
      attachSkinned(P.hair.geometry, P.hair.material, false);
      for (const m of eyes) m.material = P.eyeMat;
      model.eyeMats = [P.eyeMat];
      // Длинный плащ: чёрный, с глубоким тёмно-бордовым отливом
      model.cape = new Cape(model.group, { color: 0x0b0a0c, sheenColor: new THREE.Color(0.2, 0.05, 0.05) });
    } else for (const m of eyes) m.visible = false;
    model.group.add(scene);
    model.skinned = sk;
    model.setRage = kind === 'general' ? (k) => { P.bodyMat.userData.uRage.value = k; } : () => {};
    return model;
  }
}
