import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32, smoothstep, lerp, clamp } from '../utils.js';

// Корабль Ксаррона: чёрный клин с двумя боковыми лезвиями, башней и кольцом двигателей.
// Геометрия — пять сеток по частям корпуса: издалека это силуэт, вблизи панели и огни из шейдера.
// Нос смотрит вдоль +Z; начало координат — центр корпуса.
//
// Его можно разгромить: удар и луч оставляют пробоины, тело на скорости проходит насквозь с дырами
// на входе и выходе. Лезвия, башня и кольцо отваливаются, а без главного корпуса он падает на город.
// Один таран его не валит: с каждым пролётом он сильнее горит, кренится и садится.

export const SHIP = { length: 1240, hoverY: 900, belly: 74 };

const ACCENT = new THREE.Color(1.0, 0.4, 0.09);
const H = SHIP.length / 2;
const HULL_ST = [
  { z: H, w: 1.5, h: 1.2, cy: 12, top: 0, keel: 0 },
  { z: H - 150, w: 56, h: 16, cy: 12, top: 8, keel: 8 },
  { z: H - 380, w: 122, h: 38, cy: 6, top: 28, keel: 14 },
  { z: H - 660, w: 165, h: 58, cy: 0, top: 44, keel: 24 },
  { z: H - 930, w: 158, h: 62, cy: 2, top: 42, keel: 26 },
  { z: H - 1120, w: 118, h: 54, cy: 6, top: 30, keel: 18 },
  { z: -H, w: 92, h: 44, cy: 8, top: 18, keel: 8 },
];
const BLADE_ST = [
  { z: H - 300, w: 0.8, h: 1, cy: -8, top: 0, keel: 0 },
  { z: H - 480, w: 22, h: 22, cy: -8, top: 9, keel: 22 },
  { z: H - 800, w: 36, h: 36, cy: -6, top: 14, keel: 44 },
  { z: H - 1100, w: 32, h: 34, cy: -2, top: 10, keel: 24 },
  { z: -H + 40, w: 14, h: 18, cy: 2, top: 2, keel: 4 },
];
const HULL_EXP = 0.72, BLADE_EXP = 0.6, BLADE_X = 268;
const BRIDGE_Z = [H - 620, H - 800, H - 980];

// Прочность частей и скорость, с которой тело проходит корпус насквозь
const PART_HP = { main: 3500, L: 800, R: 800, tower: 600, ring: 800 };
const RAM_SPEED = 120;
const RAMS = 5;         // столько пролётов насквозь выдерживает главный корпус
const RAM_GAP = 1.2;    // с: пока тело внутри и ещё столько после выхода, это всё тот же пролёт
const WOUND_RADIO = [null,
  'ШТАБ: Есть пробитие корпуса. Он ещё держится.',
  'ШТАБ: Корабль горит. Пожар идёт вдоль всего корпуса.',
  'ШТАБ: Он кренится и теряет высоту!',
  'ШТАБ: Корпус трещит по швам. Ещё один такой удар, и он рухнет.',
];
const HOLES = 16;
const FIRES = 8;
// Откуда бьют орудия
const GUNS = [[110, -40, 180], [-110, -40, 180], [150, -55, -160], [-150, -55, -160], [268, -55, -120], [-268, -55, -120], [0, -80, 300]];

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3(), _l = new THREE.Vector3(), _n = new THREE.Vector3();
const _q = new THREE.Quaternion();

// Внутри тела лофта? Та же формула, что строит его поверхность
function inLoft(st, exp, x, y, z) {
  if (z > st[0].z || z < st[st.length - 1].z) return false;
  let i = 0;
  while (i < st.length - 2 && z < st[i + 1].z) i++;
  const a = st[i], b = st[i + 1], k = (a.z - z) / (a.z - b.z);
  const w = lerp(a.w, b.w, k), ax = Math.abs(x) / w;
  if (ax >= 1) return false;
  const q = 2 / exp, h = lerp(a.h, b.h, k) * Math.pow(1 - Math.pow(ax, q), 1 / q);
  const ridge = Math.exp(-Math.pow(x / (w * 0.28 + 1), 2));
  const dy = y - lerp(a.cy, b.cy, k);
  return dy >= 0 ? dy < h + ridge * lerp(a.top, b.top, k) : -dy < h + ridge * lerp(a.keel, b.keel, k);
}

// Корпус по сечениям: st[i] = { z, w, h, cy, keel } — суперэллипс с гребнем сверху и килем снизу
function loft(st, seg = 18, exp = 0.72) {
  const pos = [], idx = [];
  for (const s of st) {
    for (let j = 0; j < seg; j++) {
      const a = (j / seg) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      const x = Math.sign(ca) * Math.pow(Math.abs(ca), exp) * s.w;
      let y = Math.sign(sa) * Math.pow(Math.abs(sa), exp) * s.h;
      const ridge = Math.exp(-Math.pow(x / (s.w * 0.28 + 1), 2));
      y += sa > 0 ? ridge * (s.top ?? 0) : -ridge * (s.keel ?? 0);
      pos.push(x, s.cy + y, s.z);
    }
  }
  for (let i = 0; i < st.length - 1; i++) for (let j = 0; j < seg; j++) {
    const a = i * seg + j, b = i * seg + (j + 1) % seg, c = a + seg, d = b + seg;
    idx.push(a, c, b, b, c, d);
  }
  // Заглушки на концах
  const n = pos.length / 3;
  for (const [ring, last] of [[0, false], [st.length - 1, true]]) {
    const s = st[ring];
    pos.push(0, s.cy, s.z);
    const c = pos.length / 3 - 1;
    for (let j = 0; j < seg; j++) {
      const a = ring * seg + j, b = ring * seg + (j + 1) % seg;
      if (last) idx.push(a, b, c); else idx.push(b, a, c);
    }
  }
  void n;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g.toNonIndexed();
}

const place = (g, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => {
  g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz)));
  return g;
};

// Все детали приводим к одному набору атрибутов; glow — свечение части
function finish(g, glow = 0) {
  const n = g.index ? g.toNonIndexed() : g;
  for (const a of Object.keys(n.attributes)) if (a !== 'position') n.deleteAttribute(a);
  n.computeVertexNormals();
  n.setAttribute('aGlow', new THREE.Float32BufferAttribute(new Float32Array(n.attributes.position.count).fill(glow), 1));
  return n;
}

function buildHull() {
  const rnd = mulberry32(90817);
  const parts = [];
  const towerParts = [], ringParts = [], side = { '-1': [], 1: [] };
  // Главный клин: острый нос, широкая середина, срезанная корма
  parts.push(finish(loft(HULL_ST)));
  // Боковые лезвия: узкие, короче корпуса и чуть ниже него
  for (const s of [-1, 1]) {
    side[s].push(finish(loft(BLADE_ST, 12, BLADE_EXP).translate(s * BLADE_X, 0, 0)));
    // Перемычки между корпусом и лезвиями
    for (const z of BRIDGE_Z) {
      side[s].push(finish(new THREE.BoxGeometry(150, 11, 30).translate(s * 188, 6, z)));
      side[s].push(finish(new THREE.BoxGeometry(150, 1.6, 2.2).translate(s * 188, 12.4, z), 1));
    }
  }
  // Башня ступенями на спине
  let tw = 66, td = 150, ty = 62;
  for (let i = 0; i < 5; i++) {
    const h = 20 - i * 1.5;
    const b = new THREE.CylinderGeometry(tw * 0.62, tw * 0.78, h, 6);
    place(b, 0, ty + h / 2, -290 + i * 6, 0, Math.PI / 6, 0, 1, 1, td / tw);
    towerParts.push(finish(b));
    towerParts.push(finish(new THREE.BoxGeometry(tw * 1.1, 1.3, 1.6).translate(0, ty + h * 0.72, -290 + i * 6 + td * 0.5), 1));
    ty += h; tw *= 0.76; td *= 0.72;
  }
  const spire = new THREE.ConeGeometry(7, 120, 6);
  towerParts.push(finish(place(spire, 0, ty + 60, -280)));
  // Кольцо двигателей на корме и три сопла
  const ring = new THREE.TorusGeometry(116, 11, 10, 48);
  ringParts.push(finish(place(ring, 0, 8, -H - 8)));
  const ringGlow = new THREE.TorusGeometry(105, 3.2, 8, 48);
  ringParts.push(finish(place(ringGlow, 0, 8, -H - 9), 1));
  for (const [x, y] of [[0, 8], [-58, 8], [58, 8]]) {
    parts.push(finish(new THREE.CylinderGeometry(24, 30, 42, 16, 1, true).rotateX(Math.PI / 2).translate(x, y, -H + 14)));
    parts.push(finish(new THREE.CircleGeometry(23, 16).rotateY(Math.PI).translate(x, y, -H - 4), 1));
  }
  for (const s of [-1, 1]) {
    side[s].push(finish(new THREE.CylinderGeometry(9, 13, 24, 12, 1, true).rotateX(Math.PI / 2).translate(s * BLADE_X, 2, -H + 30)));
    side[s].push(finish(new THREE.CircleGeometry(9, 12).rotateY(Math.PI).translate(s * BLADE_X, 2, -H + 18), 1));
  }
  // Ангар на брюхе: выступающая рама и светящийся проём
  parts.push(finish(new THREE.BoxGeometry(92, 8, 150).translate(0, -SHIP.belly + 4, -120)));
  parts.push(finish(new THREE.BoxGeometry(66, 2, 118).translate(0, -SHIP.belly - 0.6, -120), 1));

  // Цепочки огней вдоль бортов (длинные тонкие полосы) и надстройки
  for (const [z0, z1, x0, x1, y] of [
    [H - 40, H - 900, 14, 150, 10], [H - 120, H - 1100, 10, 104, 34],
  ]) {
    for (const s of [-1, 1]) {
      const n = 26;
      for (let i = 0; i < n; i++) {
        const t = i / n, t2 = (i + 0.72) / n;
        const a = new THREE.Vector3(s * lerp(x0, x1, Math.min(1, t * 1.7)), y * 0.35 + 8 * (1 - t), lerp(z0, z1, t));
        const b = new THREE.Vector3(s * lerp(x0, x1, Math.min(1, t2 * 1.7)), y * 0.35 + 8 * (1 - t2), lerp(z0, z1, t2));
        const d = b.clone().sub(a), l = d.length();
        const box = new THREE.BoxGeometry(1.2, 0.9, l);
        box.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), d.normalize()));
        box.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
        parts.push(finish(box, 1));
      }
    }
  }
  for (let i = 0; i < 170; i++) {
    const t = rnd(), z = H - 220 - t * 880;
    const wk = Math.sin(Math.min(1, (t + 0.1) * 1.3) * Math.PI) * 130;
    const x = (rnd() * 2 - 1) * (wk + 10);
    const w = 5 + rnd() * 18, d = 10 + rnd() * 46, h = 2.5 + rnd() * 11;
    const y = 40 - Math.abs(x) * 0.26 + h * 0.5;
    parts.push(finish(new THREE.BoxGeometry(w, h, d).translate(x, y, z)));
  }
  return {
    main: mergeGeometries(parts, false), L: mergeGeometries(side[-1], false), R: mergeGeometries(side[1], false),
    tower: mergeGeometries(towerParts, false), ring: mergeGeometries(ringParts, false),
  };
}

function createHullMaterial() {
  const uTime = { value: 0 }, uHeat = { value: 0 }, uDead = { value: 0 }, uHoleN = { value: 0 };
  const uHoles = { value: Array.from({ length: HOLES }, () => new THREE.Vector4(0, 0, 0, 0)) };
  const mat = new THREE.MeshStandardMaterial({ color: 0x3a3e4a, roughness: 0.46, metalness: 0.55, side: THREE.DoubleSide });
  mat.userData = { uTime, uHeat, uDead, uHoleN, uHoles };
  mat.customProgramCacheKey = () => 'xarron-hull';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uShipTime = uTime;
    shader.uniforms.uShipHeat = uHeat;
    shader.uniforms.uShipDead = uDead;
    shader.uniforms.uHoleN = uHoleN;
    shader.uniforms.uHoles = uHoles;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aGlow;\nvarying float vShipGlow;\nvarying vec3 vShip;\nvarying vec3 vShipN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvShipGlow = aGlow;\nvShip = position;\nvShipN = normal;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vShipGlow;
        varying vec3 vShip;
        varying vec3 vShipN;
        uniform float uShipTime, uShipHeat, uShipDead;
        uniform int uHoleN;
        uniform vec4 uHoles[${HOLES}];
        float shipHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5); }
        float shipLine(float v, float w) { float d = abs(fract(v) - 0.5); return 1.0 - smoothstep(0.5 - w, 0.5, d); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          // Обгоревший край пробоины, изнутри корпус тёмный
          diffuseColor.rgb *= 1.0 - 0.92 * shipBurn;
          if (!gl_FrontFacing) diffuseColor.rgb *= 0.16;
          vec3 n = abs(vShipN);
          // Боковые грани рисуем по YZ, верх и низ — по XZ
          vec2 q = n.y > 0.5 ? vShip.xz : vShip.zy;
          vec2 big = q / vec2(44.0, 72.0), small = q / vec2(11.0, 18.0);
          float cell = shipHash(floor(big));
          float cellS = shipHash(floor(small) + 7.0);
          float w = max(fwidth(big.x), fwidth(big.y));
          float lineB = max(shipLine(big.x, 0.018 + w), shipLine(big.y, 0.012 + w));
          float lineS = max(shipLine(small.x, 0.02), shipLine(small.y, 0.02)) * step(0.5, cell);
          diffuseColor.rgb *= 0.55 + 0.5 * cell + 0.28 * cellS * step(0.5, cell);
          diffuseColor.rgb *= 1.0 - lineB * 0.75 - lineS * 0.32;
          // Окна: редкие ряды огней на бортах
          float side = 1.0 - smoothstep(0.35, 0.6, n.y);
          vec2 wc = vShip.zy / vec2(7.0, 6.0);
          float win = step(0.72, shipHash(floor(wc))) * step(0.3, fract(wc.x)) * step(fract(wc.x), 0.8) * step(0.35, fract(wc.y)) * step(fract(wc.y), 0.75);
          vShipWin = win * side * (1.0 - smoothstep(0.0, 0.25, w * 8.0));
          // На днище — редкие сигнальные огни по сетке панелей
          float under = smoothstep(-0.4, -0.75, vShipN.y);
          vec2 bc = fract(big) - 0.5;
          vShipWin += under * step(0.8, cell) * (1.0 - smoothstep(0.03, 0.05, length(bc * vec2(44.0, 72.0)) / 44.0));
        }`)
      .replace('void main() {', `float vShipWin = 0.0, shipBurn = 0.0, shipEdge = 0.0;
        void main() {
          // Пробоины: дыра с неровным краем, вокруг раскалённая кромка и копоть
          if (uHoleN > 0) {
            float best = 9.0;
            float nz = sin(vShip.x * 0.31 + vShip.z * 0.17) * sin(vShip.y * 0.43 + vShip.z * 0.29) * 0.16 + sin(vShip.x * 1.1 + vShip.y * 0.9) * 0.05;
            for (int i = 0; i < uHoleN; i++) {
              if (uHoles[i].w <= 0.0) continue;
              best = min(best, length(vShip - uHoles[i].xyz) / uHoles[i].w + nz);
            }
            if (best < 1.0) discard;
            shipEdge = 1.0 - smoothstep(1.0, 1.14, best);
            shipBurn = 1.0 - smoothstep(1.0, 2.1, best);
          }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        if (!gl_FrontFacing) roughnessFactor = 1.0;`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        if (!gl_FrontFacing) metalnessFactor = 0.0;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += vec3(${ACCENT.r.toFixed(2)}, ${ACCENT.g.toFixed(2)}, ${ACCENT.b.toFixed(2)}) * (vShipGlow * (3.2 + 0.4 * sin(uShipTime * 1.7)) + vShipWin * 0.8) * (1.0 - uShipDead) * (gl_FrontFacing ? 1.0 : 0.0);
        totalEmissiveRadiance += vec3(1.0, 0.36, 0.09) * shipEdge * 4.5;
        if (!gl_FrontFacing && uHoleN > 0) totalEmissiveRadiance += vec3(0.55, 0.13, 0.03) * (0.22 + 0.1 * sin(uShipTime * 3.1 + vShip.z * 0.04));
        // Разогрев при входе в атмосферу: нос и нижняя часть светятся
        totalEmissiveRadiance += vec3(1.0, 0.36, 0.08) * uShipHeat * 3.0 * smoothstep(100.0, 620.0, vShip.z) * smoothstep(0.2, -0.6, vShipN.y + 0.4);`);
  };
  return mat;
}

export class Warship {
  constructor(scene, inv) {
    this.inv = inv;
    this.kind = 'ship';
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);
    this.mat = createHullMaterial();
    this.parts = {};
    const geos = buildHull();
    for (const k of Object.keys(geos)) {
      const mesh = new THREE.Mesh(geos[k], this.mat);
      mesh.frustumCulled = false;
      this.group.add(mesh);
      geos[k].computeBoundingBox();
      this.parts[k] = { mesh, key: k, hp: PART_HP[k], max: PART_HP[k], off: false, gone: false, vel: new THREE.Vector3(), ang: new THREE.Vector3(), off0: new THREE.Vector3(), center: geos[k].boundingBox.getCenter(new THREE.Vector3()) };
    }
    this.toL = new THREE.Matrix4();
    this.fires = [];
    this.alive = true;
    this.aggro = false;
    this.holeI = 0;
    this.laserAcc = 0;
    this.pitch = 0;
    this.roll = 0;

    // Гравитационная колонна из брюха: по ней спускается десант
    const beamMat = this.beamMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
      uniforms: { uTime: { value: 0 }, uK: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        varying vec2 vUv;
        uniform float uTime, uK;
        void main() {
          // Кольца бегут вниз, к земле колонна слабеет
          float rings = 0.55 + 0.45 * sin(vUv.y * 90.0 + uTime * 9.0);
          float edge = pow(abs(sin(vUv.x * 3.14159 * 8.0 + uTime * 0.3)), 2.0) * 0.25 + 0.75;
          float fall = smoothstep(0.0, 0.35, vUv.y);
          gl_FragColor = vec4(vec3(1.0, 0.52, 0.2) * 0.55, 1.0) * uK * rings * edge * mix(0.28, 1.0, fall) * 0.42;
        }`,
    });
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(26, 40, 1, 32, 1, true), beamMat);
    this.beam.frustumCulled = false;
    this.beam.visible = false;
    this.group.add(this.beam);

    // Огненная оболочка при входе в атмосферу
    this.heatMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 0.95, 0.25), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    this.heat = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), this.heatMat);
    this.heat.scale.set(280, 150, 820);
    this.heat.frustumCulled = false;
    this.group.add(this.heat);

    // Луч главного калибра (плохая концовка)
    const gunMat = this.gunMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 1.6, 0.4), transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    this.gun = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 18, 1, true).translate(0, -0.5, 0), gunMat);
    this.gun.visible = false;
    this.gun.frustumCulled = false;
    this.group.add(this.gun);

    this.t = 0;
    this.target = new THREE.Vector3();
    this.from = new THREE.Vector3();
    this.state = 'off';
    this.yaw = 0;
    this.hum = null;
  }

  get healthK() { return clamp(this.parts.main.hp / this.parts.main.max, 0, 1); }

  // Новый забег: корпус снова целый
  repair() {
    const U = this.mat.userData;
    for (const P of Object.values(this.parts)) {
      P.hp = P.max;
      P.off = false;
      P.gone = false;
      P.off0.set(0, 0, 0);
      P.mesh.visible = true;
      P.mesh.position.set(0, 0, 0);
      P.mesh.rotation.set(0, 0, 0);
    }
    for (const h of U.uHoles.value) h.set(0, 0, 0, 0);
    U.uHoleN.value = 0;
    U.uDead.value = 0;
    this.holeI = 0;
    this.killFires();
    this.alive = true;
    this.aggro = false;
    this.laserAcc = 0;
    this.pitch = 0;
    this.roll = 0;
    this.passT = 0;
    this.passMain = 0;
    this.passParts = new Set();
    this.insideT = 0;
    this.wounds = 0;
    this.sag = 0;
    this.blastN = 0;
    this.blastIn = 0;
    this.listSide = Math.random() < 0.5 ? -1 : 1;
    this.turretT = 2;
    this.group.rotation.z = 0;
  }

  killFires() {
    for (const f of this.fires) f.dead = true;
    this.fires.length = 0;
  }

  // Ставим у края атмосферы над точкой at; корабль снижается наклонно, носом вперёд
  arrive(at, duration) {
    this.repair();
    this.state = 'descent';
    this.t = 0;
    this.dur = duration;
    this.target.set(at.x, SHIP.hoverY, at.z);
    this.from.set(at.x + 26000, 48000, at.z - 24000);
    this.yaw = Math.atan2(this.target.x - this.from.x, this.target.z - this.from.z);
    this.group.position.copy(this.from);
    this.group.visible = true;
    this.beam.visible = false;
    this.gun.visible = false;
    this.beamMat.uniforms.uK.value = 0;
  }

  // Сразу над точкой (пропуск сцены)
  hoverNow() {
    this.state = 'hover';
    this.group.position.copy(this.target);
    this.group.visible = true;
    this.heatMat.opacity = 0;
    this.mat.userData.uHeat.value = 0;
  }

  leave() {
    if (this.state !== 'hover') return;
    this.state = 'leave';
    this.t = 0;
    this.from.copy(this.group.position);
    this.setBeam(false);
  }

  hide() {
    this.state = 'off';
    this.group.visible = false;
    this.beam.visible = false;
    this.gun.visible = false;
    this.setHum(0);
    this.killFires();
  }

  setBeam(on) { this.beamOn = on; }

  // Точка у брюха, откуда идёт колонна (мировые координаты)
  bellyPos(out) {
    return out.set(0, -SHIP.belly - 2, -120).applyQuaternion(this.group.quaternion).add(this.group.position);
  }

  // ---------------------------------------------------------------- корпус как препятствие
  // Часть корпуса в локальной точке или null. Формулы те же, что строят сетку
  partAt(x, y, z) {
    const P = this.parts;
    if (!P.main.off && inLoft(HULL_ST, HULL_EXP, x, y, z)) return 'main';
    for (const k of ['L', 'R']) {
      if (P[k].off) continue;
      const s = k === 'L' ? -1 : 1;
      if (inLoft(BLADE_ST, BLADE_EXP, x - s * BLADE_X, y, z)) return k;
      if (Math.abs(x - s * 188) < 75 && Math.abs(y - 6) < 6 && BRIDGE_Z.some((b) => Math.abs(z - b) < 15)) return k;
    }
    if (!P.tower.off && y > 60 && y < 150) {
      const sc = 1 - ((y - 62) / 88) * 0.72;
      if (Math.abs(x) < 48 * sc && Math.abs(z + 285) < 78 * sc) return 'tower';
    }
    if (!P.ring.off && Math.abs(z + H + 8) < 13 && Math.abs(Math.hypot(x, y - 8) - 116) < 13) return 'ring';
    return null;
  }

  inHole(l) {
    for (const h of this.mat.userData.uHoles.value) {
      if (h.w > 0 && Math.hypot(l.x - h.x, l.y - h.y, l.z - h.z) < h.w) return true;
    }
    return false;
  }

  // Тело переместилось из from в body.pos. На скорости — насквозь, медленно — упирается в борт снаружи.
  // Через готовую пробоину можно влететь на любой скорости: внутри корпус пустой.
  // Наружу выпускаем всегда: и на малой скорости, и когда корабль уже падает или лежит
  collide(body, from, dt = 0) {
    if (this.state === 'off') return;
    const g = this.group.position, R2 = 850 * 850;
    if (body.pos.distanceToSquared(g) > R2 && from.distanceToSquared(g) > R2) return;
    const speed = body.vel.length();
    _a.copy(from).applyMatrix4(this.toL);
    _b.copy(body.pos).applyMatrix4(this.toL);
    const n = Math.min(40, Math.max(1, Math.ceil(_a.distanceTo(_b) / 20)));
    let was = this.partAt(_a.x, _a.y, _a.z);
    _c.copy(_a);
    for (let i = 1; i <= n; i++) {
      _l.lerpVectors(_a, _b, i / n);
      const part = this.partAt(_l.x, _l.y, _l.z);
      if (!part === !was) { _c.copy(_l); continue; }
      const inside = !!was, touched = part || was;
      was = part;
      if (this.inHole(_l)) {
        // Новый заход через готовую пробоину тоже бьёт: снаружи цело, зато внутри рвётся всё, что по пути
        const L = _l.clone();
        if (speed >= RAM_SPEED && this.state === 'hover' && body === this.inv.player && this.passT <= 0) this.ram(L, body, speed, touched);
        _c.copy(L);
        continue;
      }
      if (speed >= RAM_SPEED && this.state === 'hover') {
        const L = _l.clone();
        this.ram(L, body, speed, touched);
        _c.copy(L);
        continue;
      }
      if (inside) { _c.copy(_l); continue; }
      // Борт: остаёмся по свою сторону, скорость вдоль него сохраняется
      body.pos.copy(_c).applyMatrix4(this.group.matrixWorld);
      _n.set(_c.x, _c.y - 6, 0);
      if (touched !== 'main') _n.set(_c.x - (touched === 'L' ? -BLADE_X : touched === 'R' ? BLADE_X : 0), _c.y - 6, 0);
      if (_n.lengthSq() < 1e-3) _n.set(0, 1, 0);
      _n.normalize().transformDirection(this.group.matrixWorld);
      const vn = body.vel.dot(_n);
      if (vn < 0) body.vel.addScaledVector(_n, -vn);
      if (body.knock > 0 && -vn > 40) body.crash?.(body.pos.clone(), -vn);
      return;
    }
    if (body !== this.inv.player) return;
    if (!was) { this.insideT = 0; return; }
    this.passT = RAM_GAP;
    // Завис внутри и не летит: корпус сам выдавливает наружу, в кадре здесь всё равно ничего не видно
    this.insideT += dt;
    if (speed < RAM_SPEED && this.insideT > 0.7) {
      _n.set(_b.x - (was === 'L' ? -BLADE_X : was === 'R' ? BLADE_X : 0), _b.y - 6, 0);
      if (_n.lengthSq() < 1e-3) _n.set(0, 1, 0);
      _n.normalize().transformDirection(this.group.matrixWorld);
      body.pos.addScaledVector(_n, Math.min(90, 30 + this.insideT * 30) * dt);
    }
  }

  // Удар сквозь обшивку: пробоина, взрыв, обломки корпуса
  ram(local, body, speed, part) {
    const I = this.inv, W = I.world, L = local.clone(), hero = body === I.player;
    // Вход и выход рвут обшивку, но за один пролёт корпус теряет не больше одной доли прочности,
    // с какой скорости ни влети и сколько частей ни задень
    const fresh = hero && this.passT <= 0;
    if (fresh) { this.passParts.clear(); this.passMain = 0; }
    if (hero) this.passT = RAM_GAP;
    const first = !hero || !this.passParts.has(part);
    if (hero) this.passParts.add(part);
    const M = this.parts.main, P = this.parts[part] || M, share = M.max / RAMS;
    const dir = _d.copy(body.vel).normalize().clone();
    const p = _l.copy(L).applyMatrix4(this.group.matrixWorld).clone();
    if (!first) { this.addHole(L, share); this.addFire(L); }
    else if (!hero) this.damage(part, 300, p, dir, L);
    else {
      // Лезвие, башня и кольцо отваливаются со второго раза, главному корпусу через них достаётся вполовину
      const take = Math.min(P === M ? 1 : 0.5, 1 - this.passMain);
      this.passMain += take;
      if (P === M) this.damage('main', share * take, p, dir, L);
      else {
        M.hp -= share * take;
        this.damage(part, P.max * 0.55, p, dir, L);
      }
      this.addHole(L, share);
    }
    W.effects.shockwave(p.clone(), { type: 'disc', dir, radius: 26 + Math.min(40, speed * 0.04), life: 0.6, opacity: 1, color: 0xffc890 });
    W.effects.shockwave(p.clone(), { type: 'sphere', radius: 18, life: 0.45, opacity: 0.45, color: 0xffa060 });
    W.fire.explosion(p, 1.8);
    W.sparks.burst(p, 60, { size: [0.4, 1.6], speed: 60, life: [0.2, 0.8], color: 0xffc070 });
    W.effects.flash(p, 50);
    W.effects.impactFX(1, p, 0.32, 14);
    this.chunks(p, dir, 14);
    I.player.hitstop = Math.max(I.player.hitstop, first ? 0.11 : 0.05);
    I.fx.play('shipRam', { gain: first ? 2.4 : 1.5, pos: p }) || W.audio?.metal(1, p.clone());
    I.fx.play('shipBlast', { gain: 1.4, pos: p });
    I.theme.duck(1);
    I.fx.crashZoom(first ? 9 : 5, first ? 0.28 : 0.15);
    if (fresh) I.slowFor(0.4, 0.3);
    body.vel.multiplyScalar(0.8);
  }

  // Куски обшивки: улетают вместе с ударом
  chunks(p, dir, n) {
    const D = this.inv.world.debris;
    for (let i = 0; i < n; i++) {
      const sp = 20 + Math.random() * 60;
      D.spawn(p.x, p.y, p.z, 1 + Math.random() * 3, 0.4 + Math.random(), 1 + Math.random() * 3,
        dir.x * sp + (Math.random() - 0.5) * 40, dir.y * sp + (Math.random() - 0.5) * 40, dir.z * sp + (Math.random() - 0.5) * 40, 0x2e3038, 0);
    }
  }

  // Урон части корпуса. Уязвим, только пока висит над городом
  damage(part, amount, world, dir, local = null) {
    if (this.state !== 'hover') return;
    const P = this.parts[part] || this.parts.main;
    const l = local || _l.copy(world).applyMatrix4(this.toL).clone();
    this.inv.onShipHit();
    this.aggro = true;
    P.hp -= amount;
    this.addHole(l, amount);
    if (amount >= 150) this.addFire(l);
    if (P.key !== 'main' && P.hp <= 0 && !P.off) this.dropPart(P.key);
    if (this.parts.main.hp <= 0) this.startFall();
    else this.wound();
  }

  // Корпус сдаёт по долям: на каждой доле новый стон, цепочка взрывов внутри, сильнее крен и просадка
  wound() {
    const M = this.parts.main, n = Math.floor((1 - M.hp / M.max) * RAMS + 1e-3);
    if (n <= this.wounds || this.state !== 'hover') return;
    this.wounds = n;
    this.blastN += 3 + n;
    this.blastIn = 0.25;
    this.inv.fx.play('shipGroan', { gain: 0.55 + n * 0.11, pos: this.group.position });
    this.inv.story.radio(WOUND_RADIO[n] || WOUND_RADIO[RAMS - 1], 4);
  }

  addHole(l, amount) {
    const U = this.mat.userData, r = clamp(amount * 0.03, 4, 40);
    // Рядом уже есть пробоина — она растёт
    for (const h of U.uHoles.value) {
      if (h.w > 0 && Math.hypot(l.x - h.x, l.y - h.y, l.z - h.z) < h.w * 1.1) { h.w = Math.min(46, Math.hypot(h.w, r)); return; }
    }
    U.uHoles.value[this.holeI].set(l.x, l.y, l.z, r);
    this.holeI = (this.holeI + 1) % HOLES;
    U.uHoleN.value = Math.max(U.uHoleN.value, this.holeI === 0 ? HOLES : this.holeI);
  }

  addFire(l) {
    if (this.fires.length >= FIRES) return;
    const f = { pos: new THREE.Vector3(), local: l.clone(), dead: false };
    f.pos.copy(l).applyMatrix4(this.group.matrixWorld);
    this.fires.push(f);
    this.inv.world.fire.add(f.pos, { size: 3.4, life: 600, target: f });
  }

  // Часть отломилась и падает сама по себе
  dropPart(key) {
    const P = this.parts[key], I = this.inv;
    P.off = true;
    const sx = key === 'L' ? -1 : key === 'R' ? 1 : 0;
    P.vel.set(sx * 14, 2, key === 'ring' ? -24 : 0);
    P.ang.set((Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.14, sx * 0.22 + (Math.random() - 0.5) * 0.1);
    _l.copy(P.center).applyMatrix4(this.group.matrixWorld);
    I.world.fire.explosion(_l, 4);
    I.world.effects.flash(_l, 60);
    I.fx.play('shipGroan', { gain: 0.8, pos: _l });
    I.fx.play('shipBlast', { gain: 0.8, pos: _l });
    I.story.radio(key === 'tower' ? 'ШТАБ: Есть! У корабля снесена башня.' : key === 'ring' ? 'ШТАБ: Двигатели корабля сбиты. Он теряет высоту.' : 'ШТАБ: От корабля отвалилось лезвие. Он рушится по кускам.', 4);
    if (this.state === 'hover') {
      this.parts.main.hp -= 300;
      if (this.parts.main.hp <= 0) this.startFall();
      else this.wound();
    }
  }

  // Удар рукой или заряженный удар: корпус рядом с кулаком
  hitSphere(center, r, dmg, dir, kind) {
    if (this.state !== 'hover') return false;
    for (const t of [0, 0.6, 1]) {
      _l.copy(center).addScaledVector(dir, r * t).applyMatrix4(this.toL);
      const part = this.partAt(_l.x, _l.y, _l.z);
      if (!part || this.inHole(_l)) continue;
      const L = _l.clone(), I = this.inv, W = I.world;
      const p = _a.copy(L).applyMatrix4(this.group.matrixWorld).clone();
      const heavy = kind !== 'punch';
      this.damage(part, heavy ? 150 + 350 * clamp(dmg / 900, 0, 1) : 30, p, dir, L);
      I.fx.hit(p, dir, heavy ? 1 : 0.6);
      this.chunks(p, _b.copy(dir).negate().clone(), heavy ? 10 : 3);
      if (heavy) { W.fire.explosion(p, 1.2); W.audio?.metal(1, p.clone()); } else W.audio?.metal(0.5, p.clone());
      return true;
    }
    return false;
  }

  // Луч героя: первая точка корпуса на пути
  rayHit(origin, dir, maxDist) {
    if (this.state !== 'hover') return null;
    _a.subVectors(this.group.position, origin);
    const along = _a.dot(dir), off2 = _a.lengthSq() - along * along, R2 = 760 * 760;
    if (off2 > R2) return null;
    const half = Math.sqrt(R2 - off2), end = Math.min(maxDist, along + half), step = Math.min(8, Math.max(1, maxDist / 3));
    _b.copy(origin).applyMatrix4(this.toL);
    _c.copy(dir).transformDirection(this.toL);
    for (let d = Math.max(1, along - half); d < end; d += step) {
      _l.copy(_b).addScaledVector(_c, d);
      if (this.partAt(_l.x, _l.y, _l.z) && !this.inHole(_l)) return { dist: d, cap: this };
    }
    return null;
  }

  receive(kind, power, point, dir) {
    if (this.state !== 'hover') return;
    this.laserAcc += power * 140;
    if (this.laserAcc < 45) return;
    _l.copy(point).applyMatrix4(this.toL);
    const a = this.laserAcc;
    this.laserAcc = 0;
    this.damage(this.partAt(_l.x, _l.y, _l.z) || 'main', a, point, dir);
    this.chunks(point, _a.copy(dir).negate().clone(), 3);
  }

  // Орудия: корабль отвечает, когда его трогают или герой подлетел слишком близко
  turrets(dt) {
    const I = this.inv, X = I.heroC;
    if (this.state !== 'hover' || !I.fightOn || I.heroDown) return;
    if (!this.aggro && X.distanceToSquared(this.group.position) > 700 * 700) return;
    this.turretT -= dt;
    if (this.turretT > 0) return;
    this.turretT = 0.9 + Math.random() * 0.6;
    let best = null, bd = Infinity;
    for (const g of GUNS) {
      _l.set(g[0], g[1], g[2]).applyMatrix4(this.group.matrixWorld);
      const d = _l.distanceToSquared(X);
      if (d < bd) { bd = d; best = g; }
    }
    if (bd > 1300 * 1300) return;
    _l.set(best[0], best[1], best[2]).applyMatrix4(this.group.matrixWorld);
    _d.copy(X).addScaledVector(I.player.vel, Math.sqrt(bd) / 480).sub(_l).normalize();
    I.bolts.fire(_l, _d, 480, 3);
  }

  // ---------------------------------------------------------------- падение
  startFall() {
    if (!this.alive) return;
    this.alive = false;
    this.state = 'falling';
    this.t = 0;
    this.vy = 0;
    this.blastT = 0;
    this.setBeam(false);
    this.setHum(0);
    this.inv.fx.play('shipGroan', { gain: 1, pos: this.group.position });
    this.inv.onShipDown();
  }

  // Случайная точка на корпусе: взрыв изнутри
  innerBlast(k) {
    const I = this.inv, W = I.world, p = _l;
    p.set((Math.random() - 0.5) * 240, (Math.random() - 0.3) * 60, (Math.random() - 0.5) * 1000);
    const L = p.clone();
    p.applyMatrix4(this.group.matrixWorld);
    W.fire.explosion(p, 1.5 * k);
    W.dust.burst(p, 16, { size: [18, 48], speed: 48, life: [3, 8], color: 0x37322d, rise: 5, alpha: 0.42, plume: true });
    W.effects.shockwave(p.clone(), { type: 'sphere', radius: 50 * k, life: 0.8, opacity: 0.5, color: 0xffa060 });
    W.effects.flash(p, 60);
    this.chunks(p, _a.set(0, 1, 0), 8);
    I.fx.play('shipBlast', { gain: 0.7, pos: p.clone() });
    if (Math.random() < 0.45) this.addHoleRaw(L);
  }

  addHoleRaw(l) {
    const U = this.mat.userData;
    U.uHoles.value[this.holeI].set(l.x, l.y, l.z, 10 + Math.random() * 18);
    this.holeI = (this.holeI + 1) % HOLES;
    U.uHoleN.value = Math.max(U.uHoleN.value, this.holeI === 0 ? HOLES : this.holeI);
  }

  // Точка касания земли по длине корпуса: нос падает первым, корма последней
  groundHit(i) {
    const I = this.inv, W = I.world;
    const z = H - 100 - (i / 7) * (SHIP.length - 200);
    const p = _l.set(0, -40, z).applyMatrix4(this.group.matrixWorld).clone();
    p.y = Math.max(this.groundY ?? 0, W.city.groundHeightAt(p.x, p.z, 400));
    W.city.damageRadius(p.clone().setY(p.y + 30), 120, 1200, 90);
    W.impact?.(p, 150, 60);
    W.effects.shockwave(p.clone().setY(p.y + 2), { type: 'ring', radius: 300, life: 2, opacity: 0.8 });
    W.dust.burst(p.clone().setY(p.y + 4), 90, { size: [36, 90], speed: 90, life: [6, 13], flat: true, color: 0x7a7163, alpha: 0.85 });
    W.dust.burst(p.clone().setY(p.y + 10), 36, { size: [50, 120], speed: 26, rise: 14, life: [8, 15], color: 0x574f45, alpha: 0.5, plume: true });
    W.fire.explosion(p, 3);
    W.effects.flash(p, 80);
    W.effects.impactFX(1, p, 0.3, 10);
    I.fx.smokeAt(p, 1.4);
    I.fx.play('shipBlast', { pos: p });
    I.fx.play('slam', { pos: p, rate: 0.75 });
    I.theme.duck(0.85);
  }

  updateFall(dt) {
    const g = this.group, f = _a.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const gy = this.groundY ?? 0, U = this.mat.userData;
    U.uDead.value = Math.min(1, U.uDead.value + dt * 0.7);
    if (this.state === 'falling') {
      this.vy = Math.min(62, this.vy + 6 * dt);
      g.position.y -= this.vy * dt;
      g.position.addScaledVector(f, 18 * dt);
      this.pitch += (0.14 - this.pitch) * Math.min(1, dt * 0.22);
      this.roll += (0.2 - this.roll) * Math.min(1, dt * 0.16);
      this.blastT -= dt;
      if (this.blastT <= 0) { this.blastT = 0.35; this.innerBlast(1); }
      // Отваливается всё, что ещё держалось
      for (const [k, at] of [['L', 2.5], ['tower', 4.2], ['R', 6], ['ring', 7.5]]) {
        if (this.t > at && !this.parts[k].off) this.dropPart(k);
      }
      // Нос опущен: он коснётся земли первым
      if (g.position.y - 80 - Math.sin(this.pitch) * 560 <= gy) {
        this.state = 'crash';
        this.t = 0;
        this.crashI = 0;
      }
    } else if (this.state === 'crash') {
      while (this.crashI < 8 && this.t >= this.crashI * 0.3) this.groundHit(this.crashI++);
      // Корпус ложится на брюхо
      const rest = gy + 60;
      g.position.y += (rest - g.position.y) * Math.min(1, dt * 1.3);
      g.position.addScaledVector(f, 26 * Math.exp(-this.t) * dt);
      this.pitch += (0.012 - this.pitch) * Math.min(1, dt * 1.3);
      this.roll += (0.05 - this.roll) * Math.min(1, dt * 1.3);
      if (this.t > 5) this.state = 'wreck';
    }
  }

  // Отломанные части падают сами
  updateParts(dt) {
    const gy = this.groundY ?? 0, I = this.inv;
    for (const P of Object.values(this.parts)) {
      if (!P.off || P.gone) continue;
      P.vel.y = Math.max(-90, P.vel.y - 15 * dt);
      P.off0.addScaledVector(P.vel, dt);
      P.mesh.rotation.x += P.ang.x * dt;
      P.mesh.rotation.y += P.ang.y * dt;
      P.mesh.rotation.z += P.ang.z * dt;
      // Вращение вокруг своего центра, а не центра корабля
      _q.setFromEuler(P.mesh.rotation);
      _l.copy(P.center).applyQuaternion(_q);
      P.mesh.position.copy(P.center).add(P.off0).sub(_l);
      _b.copy(P.center).add(P.off0).applyMatrix4(this.group.matrixWorld);
      if (Math.random() < 0.8) I.world.dust.burst(_b, 1, { size: [16, 34], speed: 5, life: [4, 9], color: 0x2e2a26, rise: 6, alpha: 0.4, plume: true });
      if (_b.y < gy + 25) {
        P.gone = true;
        P.mesh.visible = false;
        const p = _b.clone().setY(gy);
        I.world.city.damageRadius(p.clone().setY(gy + 20), 60, 800, 60);
        I.fx.crash(p, 1);
        I.world.dust.burst(p.clone().setY(gy + 3), 60, { size: [16, 36], speed: 50, life: [4, 9], flat: true });
        I.fx.smokeAt(p, 1.1);
      }
    }
  }

  // Низкий гул двигателей: громче, когда корабль рядом
  setHum(k, audio) {
    const A = audio || this.audio;
    if (!A?.ctx) return;
    this.audio = A;
    const ctx = A.ctx;
    if (!this.hum) {
      if (k <= 0) return;
      const out = ctx.createGain();
      out.gain.value = 0;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 130;
      const a = ctx.createOscillator(), b = ctx.createOscillator();
      a.type = b.type = 'sawtooth';
      // Ровно октава: близкие частоты дали бы биения, гул ходил бы волнами
      a.frequency.value = 33; b.frequency.value = 66;
      a.connect(lp); b.connect(lp);
      const rum = ctx.createBufferSource();
      rum.buffer = A.brown; rum.loop = true;
      rum.connect(lp);
      lp.connect(out).connect(A.master);
      a.start(); b.start(); rum.start();
      this.hum = { out, nodes: [a, b, rum] };
    }
    this.hum.out.gain.setTargetAtTime(k * 0.12, ctx.currentTime, k > 0 ? 0.6 : 0.2);
  }

  update(dt, listener, audio) {
    if (this.state === 'off') return;
    this.t += dt;
    if (this.passT > 0) this.passT -= dt;
    const U = this.mat.userData;
    U.uTime.value += dt;
    const g = this.group;
    if (this.state === 'descent') {
      const k = Math.min(1, this.t / this.dur);
      // Быстро падает из космоса, у самого города гасит скорость
      const e = 1 - Math.pow(1 - k, 2.1);
      g.position.lerpVectors(this.from, this.target, e);
      // В плотной атмосфере разогрев: сильнее всего на высоте 30–6 км
      const alt = g.position.y;
      const hot = smoothstep(52000, 30000, alt) * smoothstep(3500, 11000, alt);
      this.heatMat.opacity = hot * 0.5;
      U.uHeat.value = hot;
      if (k >= 1) { this.state = 'hover'; this.heatMat.opacity = 0; U.uHeat.value = 0; }
    } else if (this.state === 'hover') {
      // Раненый корабль садится и заваливается на борт; изнутри его рвёт ещё несколько секунд
      const w = this.wounds / RAMS, ease = 1 - Math.exp(-0.7 * dt);
      this.sag += (w * 130 - this.sag) * ease;
      this.pitch += (w * 0.055 - this.pitch) * ease;
      this.roll += (this.listSide * w * 0.075 - this.roll) * ease;
      g.position.y = this.target.y - this.sag + Math.sin(U.uTime.value * 0.35) * 4;
      if (this.blastN > 0) {
        this.blastIn -= dt;
        if (this.blastIn <= 0) {
          this.blastN--;
          this.blastIn = 0.35 + Math.random() * 0.6;
          this.innerBlast(0.6 + w * 0.5);
        }
      }
    } else if (this.state === 'leave') {
      const k = Math.min(1, this.t / 14);
      const e = k * k * k;
      g.position.lerpVectors(this.from, new THREE.Vector3(this.from.x - 8000, 70000, this.from.z + 9000), e);
      if (k >= 1) this.hide();
    } else this.updateFall(dt);
    if (this.state === 'off') return;
    g.rotation.y = this.yaw;
    g.rotation.x = this.state === 'descent' ? (1 - Math.min(1, this.t / this.dur)) * 0.22 : this.state === 'leave' ? -0.18 * Math.min(1, this.t / 3) : this.pitch;
    g.rotation.z = this.roll;
    g.updateMatrixWorld();
    this.toL.copy(g.matrixWorld).invert();
    this.heat.visible = this.heatMat.opacity > 0.002;
    this.updateParts(dt);
    for (const f of this.fires) f.pos.copy(f.local).applyMatrix4(g.matrixWorld);
    this.turrets(dt);

    // Колонна плавно разгорается и гаснет
    const B = this.beamMat.uniforms;
    B.uTime.value += dt;
    B.uK.value += ((this.beamOn ? 1 : 0) - B.uK.value) * Math.min(1, dt * 2);
    this.beam.visible = B.uK.value > 0.01;
    if (this.beam.visible) {
      const h = this.target.y - this.sag - SHIP.belly - 2 - (this.groundY ?? 0);
      this.beam.scale.set(1, h, 1);
      this.beam.position.set(0, -SHIP.belly - 2 - h / 2, -120);
    }
    if (this.gun.visible) {
      this.gunLeft -= dt;
      if (this.gunLeft <= 0) this.gun.visible = false;
    }
    // Бой окончен: корабль больше не гудит (на паузе сюда не попадаем, гул глушит Invasion.setPaused)
    if (listener && this.alive && !this.inv.ended) {
      const d = g.position.distanceTo(listener);
      this.setHum(smoothstep(30000, 1200, d), audio);
    }
  }

  // Выстрел главного калибра в точку; off — погасить
  fireGun(point) {
    if (!point) { this.gun.visible = false; return; }
    const from = this.bellyPos(new THREE.Vector3());
    const local = this.group.worldToLocal(from.clone()), end = this.group.worldToLocal(point.clone());
    const dir = end.clone().sub(local), l = dir.length();
    this.gun.visible = true;
    this.gunLeft = 0.32;
    this.gun.position.copy(local);
    this.gun.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir.normalize());
    this.gun.scale.set(9, l, 9);
  }
}
