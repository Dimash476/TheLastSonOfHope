import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CITY } from '../config.js';
import { mulberry32 } from '../utils.js';
import { HALF, BLOCK, blockTypes, BIG_PARK, POND, PARK_PLAZA, PARK_RING, bigParkPathDist, parkPathDist } from './layout.js';
import { createGlowPoolMaterial } from './props.js';

// Живая природа и уют города: фонтаны на площадях парков, клумбы, кусты, живые изгороди,
// скамейки и фонари вдоль аллей (центральный парк и парки-кварталы), палисадники у домов.
// Всё инстансное, разбито на чанки и рисуется только рядом с камерой.

const CHUNK = 500;   // крупные участки — меньше вызовов отрисовки
const VIEW = 750;
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const UP = new THREE.Vector3(0, 1, 0);
const FLOWERS = [0xe63946, 0xf4a261, 0xffd166, 0xe76f9a, 0x9b5de5, 0xffffff, 0xff7b00, 0xc9184a];
const GREENS = [0x2f5a22, 0x3a6a2a, 0x335f25, 0x46752e, 0x2c4f20];

export class Nature {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.uTime = { value: 0 };
    this.uNight = { value: 0 };
    this.items = [];
    this.cells = new Map();
    const rnd = mulberry32(CITY.seed + 91);
    const groups = new Map();
    const add = (type, x, z, rot = 0, color = 0xffffff, sx = 1, sy = 1, sz = 1) => {
      const it = { type, x, z, rot, color, sx, sy, sz, alive: true };
      this.items.push(it);
      const key = Math.floor(x / CHUNK) * 1000 + Math.floor(z / CHUNK);
      if (!groups.has(key)) groups.set(key, {});
      const g = groups.get(key);
      (g[type] = g[type] || []).push(it);
      if (type === 'bench' || type === 'lamp') {
        const ck = Math.floor(x / 40) * 100000 + Math.floor(z / 40);
        if (!this.cells.has(ck)) this.cells.set(ck, []);
        this.cells.get(ck).push(it);
      }
      return it;
    };
    const face = (dx, dz) => Math.atan2(dx, dz); // поворот, чтобы смотреть в направлении (dx, dz)
    const flower = () => FLOWERS[Math.floor(rnd() * FLOWERS.length)];
    const green = () => GREENS[Math.floor(rnd() * GREENS.length)];

    // ---- парки-кварталы
    const g = CITY.grid, B = CITY.block;
    for (let i = 0; i < g; i++) for (let j = 0; j < g; j++) {
      if (blockTypes[j * g + i] !== BLOCK.PARK) continue;
      const cx = -HALF + i * B + B / 2, cz = -HALF + j * B + B / 2;
      add('fountain', cx, cz, rnd() * 6.28);
      // Кольцо клумб вокруг площади (с проходами к аллеям)
      for (let k = 0; k < 16; k++) {
        const a = (k + 0.5) / 16 * Math.PI * 2;
        if (k % 4 === 1 || k % 4 === 2) {
          add('flowerbed', cx + Math.cos(a) * (PARK_PLAZA + 1.3), cz + Math.sin(a) * (PARK_PLAZA + 1.3), -a, flower(), 1.6, 1, 0.9);
        }
      }
      // Скамейки на площади — лицом к фонтану
      for (let k = 0; k < 4; k++) {
        const a = (k + 0.5) * Math.PI / 2, x = cx + Math.cos(a) * (PARK_PLAZA - 1.8), z = cz + Math.sin(a) * (PARK_PLAZA - 1.8);
        add('bench', x, z, face(cx - x, cz - z));
      }
      // Вдоль аллей: скамейки с одной стороны, фонари с другой
      for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        for (const t of [20, 34]) {
          const px = cx + ax * t, pz = cz + az * t, nx = -az, nz = ax;
          add('bench', px + nx * 2.6, pz + nz * 2.6, face(-nx, -nz));
          add('lamp', px - nx * 2.4, pz - nz * 2.4, 0);
        }
      }
      // Живая изгородь по краю (разрывы у аллей)
      const e = B / 2 - 12.5;
      for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        for (const half of [-1, 1]) {
          // Отрезок изгороди от прохода аллеи (3.5 м) до угла
          const along = half * (e + 3.5) / 2;
          add('hedge', cx + sx * e + (sz ? along : 0), cz + sz * e + (sx ? along : 0), sx ? Math.PI / 2 : 0, green(), e - 3.5, 1, 1);
        }
      }
      // Кусты в рощах
      for (let k = 0; k < 10; k++) {
        const x = cx + (rnd() - 0.5) * 70, z = cz + (rnd() - 0.5) * 70;
        if (parkPathDist(x, z) > 4 && Math.hypot(x - cx, z - cz) > PARK_RING + 3) add('bush', x, z, rnd() * 6.28, green(), 0.8 + rnd() * 0.8, 0.7 + rnd() * 0.5, 0.8 + rnd() * 0.8);
      }
    }

    // ---- центральный парк: скамейки и фонари вдоль аллей, клумбы, кусты
    const P = BIG_PARK, cxP = (P.minX + P.maxX) / 2, czP = (P.minZ + P.maxZ) / 2;
    const inP = (x, z) => x > P.minX + 12 && x < P.maxX - 12 && z > P.minZ + 12 && z < P.maxZ - 12 && Math.hypot(x - POND.x, z - POND.z) > POND.r + 2;
    const alley = (fx, fz, from, to) => {
      let k = 0;
      for (let u = from; u < to; u += 15, k++) {
        const x = fx(u), z = fz(u), tx = fx(u + 1) - x, tz = fz(u + 1) - z, tl = Math.hypot(tx, tz) || 1, nx = -tz / tl, nz = tx / tl;
        const s = k % 2 ? 1 : -1;
        if (k % 2 === 0 && inP(x + nx * s * 2.8, z + nz * s * 2.8)) add('bench', x + nx * s * 2.8, z + nz * s * 2.8, face(-nx * s, -nz * s));
        if (k % 2 === 1 && inP(x - nx * s * 2.6, z - nz * s * 2.6)) add('lamp', x - nx * s * 2.6, z - nz * s * 2.6, 0);
      }
    };
    alley((u) => u, (u) => czP + 60 * Math.sin(u * 0.012), P.minX, P.maxX);
    alley((u) => cxP + 50 * Math.sin(u * 0.015 + 1), (u) => u, P.minZ, P.maxZ);
    alley((u) => POND.x + Math.cos(u / (POND.r + 9)) * (POND.r + 9), (u) => POND.z + Math.sin(u / (POND.r + 9)) * (POND.r + 9), 0, Math.PI * 2 * (POND.r + 9));
    for (let k = 0; k < 900; k++) {
      const x = P.minX + 14 + rnd() * (P.maxX - P.minX - 28), z = P.minZ + 14 + rnd() * (P.maxZ - P.minZ - 28);
      const d = bigParkPathDist(x, z);
      if (!inP(x, z) || d < 4) continue;
      if (k < 60 && d < 12) add('flowerbed', x, z, rnd() * 6.28, flower(), 2 + rnd() * 2, 1, 1 + rnd());
      else if (rnd() < 0.35) add('bush', x, z, rnd() * 6.28, green(), 0.8 + rnd(), 0.6 + rnd() * 0.6, 0.8 + rnd());
    }

    // ---- палисадники у домов пригорода
    for (const b of world.city.buildings) {
      if (b.kind !== 'building' || !b.roof || b.roof.kind !== 'gable') continue;
      const s = world.city.segs[b.segs[0]];
      if (Math.abs(b.x) > HALF + 50 || Math.abs(b.z) > HALF + 50) continue;
      for (let k = 0; k < 2; k++) {
        const sx = rnd() < 0.5 ? -1 : 1, sz = rnd() < 0.5 ? -1 : 1;
        add('bush', s.x + sx * (s.w / 2 + 0.9), s.z + sz * (s.d / 2 - 1 - rnd() * 2), rnd() * 6.28, green(), 0.6 + rnd() * 0.5, 0.6 + rnd() * 0.4, 0.6 + rnd() * 0.5);
      }
      if (rnd() < 0.7) {
        const side = Math.floor(rnd() * 4), a = side * Math.PI / 2;
        const nx = Math.round(Math.sin(a)), nz = Math.round(Math.cos(a));
        add('flowerbed', s.x + nx * (s.w / 2 + 1.1), s.z + nz * (s.d / 2 + 1.1), a, flower(), (nx ? s.d : s.w) * 0.25, 1, 0.7);
      }
    }

    // ---- сетки по чанкам
    const geos = makeGeometries();
    this.mat = createNatureMaterial(this.uTime, this.uNight);
    this.waterMat = createJetMaterial(this.uTime);
    this.poolMat = createGlowPoolMaterial(0xffd9a0, 0.5);
    const poolGeo = new THREE.PlaneGeometry(12, 12).rotateX(-Math.PI / 2).translate(0, 0.07, 0);
    this.chunks = [];
    for (const gr of groups.values()) {
      const meshes = [], night = [];
      for (const type in gr) {
        const list = gr[type];
        const mesh = new THREE.InstancedMesh(geos[type], this.mat, list.length);
        // Мелкая зелень без теней (заметно дешевле), крупные вещи — с тенями
        mesh.castShadow = type === 'bench' || type === 'lamp' || type === 'fountain';
        mesh.userData.small = type === 'bush' || type === 'flowerbed' || type === 'hedge';
        mesh.receiveShadow = true;
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 3).fill(1), 3);
        list.forEach((it, i) => { it.mesh = mesh; it.slot = i; mesh.setColorAt(i, _c.set(it.color)); });
        meshes.push(mesh);
        // Струи фонтанов и пятна света фонарей — свои сетки той же раскладки
        if (type === 'fountain') {
          const jets = new THREE.InstancedMesh(geos.jets, this.waterMat, list.length);
          list.forEach((it) => { it.jets = jets; });
          meshes.push(jets);
        }
        if (type === 'lamp') {
          const pool = new THREE.InstancedMesh(poolGeo, this.poolMat, list.length);
          pool.renderOrder = 2;
          list.forEach((it) => { it.pool = pool; });
          meshes.push(pool); night.push(pool);
        }
        list.forEach((it) => this.write(it));
      }
      for (const m of meshes) { m.computeBoundingSphere(); this.scene.add(m); }
      const c = meshes[0].boundingSphere.center;
      this.chunks.push({ meshes, night, x: c.x, z: c.z });
    }
    this.createFireflies();
  }

  // Светлячки в парках: ночью плавают над травой и мерцают
  createFireflies() {
    const pts = [], seeds = [];
    const g = CITY.grid, B = CITY.block, rnd = mulberry32(CITY.seed + 93);
    const put = (x, z) => { pts.push(x, 0.4 + rnd() * 2.2, z); seeds.push(rnd() * 100); };
    for (let i = 0; i < g; i++) for (let j = 0; j < g; j++) {
      if (blockTypes[j * g + i] !== BLOCK.PARK) continue;
      for (let k = 0; k < 30; k++) put(-HALF + i * B + 14 + rnd() * 72, -HALF + j * B + 14 + rnd() * 72);
    }
    const P = BIG_PARK;
    for (let k = 0; k < 900; k++) put(P.minX + 10 + rnd() * (P.maxX - P.minX - 20), P.minZ + 10 + rnd() * (P.maxZ - P.minZ - 20));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    geo.setAttribute('seed', new THREE.Float32BufferAttribute(seeds, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.uTime, uNight: this.uNight },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `attribute float seed; uniform float uTime, uNight; varying float vA;
        void main() {
          vec3 p = position;
          float t = uTime * 0.35 + seed;
          p += vec3(sin(t * 1.3) * 1.6 + sin(t * 0.37) * 2.5, sin(t * 0.9) * 0.6, cos(t * 1.1) * 1.6 + cos(t * 0.29) * 2.5);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          // Мерцание: вспыхивают и гаснут каждый в своём ритме
          vA = uNight * pow(max(0.0, sin(uTime * (0.8 + fract(seed) * 0.9) + seed * 7.0)), 3.0);
          gl_PointSize = 90.0 / max(-mv.z, 1.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `varying float vA;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.0, d) * vA;
          gl_FragColor = vec4(vec3(1.0, 0.95, 0.45) * a * 2.2, a);
        }`,
    });
    this.fireflies = new THREE.Points(geo, mat);
    this.fireflies.frustumCulled = false;
    this.scene.add(this.fireflies);
  }

  write(it) {
    if (it.alive) _m.compose(_v.set(it.x, 0, it.z), _q.setFromAxisAngle(UP, it.rot), _s.set(it.sx, it.sy, it.sz));
    else _m.copy(_zero);
    it.mesh.setMatrixAt(it.slot, _m);
    it.mesh.instanceMatrix.needsUpdate = true;
    for (const extra of [it.jets, it.pool]) if (extra) { extra.setMatrixAt(it.slot, _m); extra.instanceMatrix.needsUpdate = true; }
  }

  // Ударная волна ломает скамейки и фонари
  impulse(center, radius, force) {
    const W = this.world;
    const x0 = Math.floor((center.x - radius) / 40), x1 = Math.floor((center.x + radius) / 40);
    const z0 = Math.floor((center.z - radius) / 40), z1 = Math.floor((center.z + radius) / 40);
    for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) {
      for (const it of this.cells.get(i * 100000 + j) || []) {
        if (!it.alive) continue;
        const d = Math.hypot(it.x - center.x, it.z - center.z);
        if (d > radius || force * (1 - d / radius) < 7) continue;
        it.alive = false;
        this.write(it);
        const dir = _v.set(it.x - center.x, 0, it.z - center.z).normalize(), f = Math.min(30, force);
        const sz = it.type === 'lamp' ? [0.2, 4, 0.2] : [1.8, 0.5, 0.5];
        W.debris?.spawn(it.x, sz[1] / 2 + 0.3, it.z, sz[0], sz[1], sz[2], dir.x * f, 3 + f * 0.3, dir.z * f, new THREE.Color(0x4a3a2a), 0);
      }
    }
  }

  update(dt, camPos) {
    this.uTime.value += dt;
    for (const c of this.chunks) {
      const d = Math.hypot(c.x - camPos.x, c.z - camPos.z);
      const v = camPos.y < 900 && d < VIEW;
      // Кусты и клумбы — только вблизи
      const vs = camPos.y < 500 && d < VIEW * 0.65;
      for (const m of c.meshes) m.visible = m.userData.small ? vs : v;
      for (const m of c.night) m.visible = v && this.uNight.value > 0.05;
    }
    if (this.fireflies) this.fireflies.visible = this.uNight.value > 0.4 && camPos.y < 400;
  }

  setNight(k) { this.uNight.value = k; this.poolMat.uniforms.uK.value = k; }

  reset() { for (const it of this.items) if (!it.alive) { it.alive = true; this.write(it); } }
}

const _c = new THREE.Color();

// Материал: tint — цвет экземпляра (цветы, оттенок зелени), glow — светится ночью (плафоны),
// sway — покачивание (кусты и цветы на ветру)
function createNatureMaterial(uTime, uNight) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.uniforms.uNight = uNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float tint;\nattribute float glow;\nattribute float sway;\nuniform float uTime;\nvarying float vGlow;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          float ph = 0.0;
          #ifdef USE_INSTANCING
            ph = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.23;
          #endif
          transformed.x += sin(uTime * 1.7 + ph) * 0.05 * sway;
          transformed.z += cos(uTime * 1.3 + ph) * 0.04 * sway;
        }`)
      .replace('#include <color_vertex>', `
        vColor.rgb = color.rgb;
        #ifdef USE_INSTANCING_COLOR
          vColor.rgb *= mix(vec3(1.0), instanceColor.rgb, tint);
        #endif
        vGlow = glow;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;\nvarying float vGlow;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += vec3(1.0, 0.82, 0.55) * vGlow * mix(0.15, 3.2, uNight);`);
  };
  return mat;
}

// Струи фонтана: полупрозрачные «зонтики» воды, рябь бежит вверх и в стороны
function createJetMaterial(uTime) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime },
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: `varying vec2 vUv; varying float vH;
      void main() {
        vUv = uv; vH = position.y;
        vec4 p = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          p = instanceMatrix * p;
        #endif
        gl_Position = projectionMatrix * modelViewMatrix * p;
      }`,
    fragmentShader: `uniform float uTime; varying vec2 vUv; varying float vH;
      void main() {
        float streak = 0.5 + 0.5 * sin(vUv.x * 62.83 + sin(vUv.y * 9.0 + uTime * 3.0) * 1.5);
        float flow = 0.55 + 0.45 * sin(vUv.y * 22.0 - uTime * 9.0 + vUv.x * 12.0);
        float a = streak * flow * 0.55 * smoothstep(0.0, 0.15, vUv.y) * smoothstep(1.0, 0.75, vUv.y);
        gl_FragColor = vec4(vec3(0.85, 0.93, 1.0), a);
      }`,
  });
}

function makeGeometries() {
  const part = (geo, color, { tint = 0, glow = 0, sway = 0 } = {}) => {
    if (geo.index) geo = geo.toNonIndexed();
    if (geo.attributes.uv) geo.deleteAttribute('uv');
    if (!geo.attributes.normal) geo.computeVertexNormals();
    const n = geo.attributes.position.count, c = new THREE.Color(color), P = geo.attributes.position;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('tint', new THREE.BufferAttribute(new Float32Array(n).fill(tint), 1));
    geo.setAttribute('glow', new THREE.BufferAttribute(new Float32Array(n).fill(glow), 1));
    const sw = new Float32Array(n);
    if (sway) for (let i = 0; i < n; i++) sw[i] = Math.max(0, P.getY(i)) * sway;
    geo.setAttribute('sway', new THREE.BufferAttribute(sw, 1));
    return geo;
  };
  const B = (w, h, d, x, y, z) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
  const C = (rt, rb, h, x, y, z, s = 16, open = false) => new THREE.CylinderGeometry(rt, rb, h, s, 1, open).translate(x, y, z);
  const M = (l) => mergeGeometries(l);
  const STONE = 0xc9c2b4;
  // Фонтан: чаша, вода, колонна, верхняя чаша
  const fountain = M([
    part(C(4.2, 4.4, 0.7, 0, 0.35, 0, 28), STONE),
    part(C(3.8, 3.8, 0.04, 0, 0.55, 0, 28), 0x3d6f86),
    part(C(0.35, 0.45, 2.0, 0, 1.3, 0, 12), STONE),
    part(C(1.3, 0.5, 0.35, 0, 2.3, 0, 18), STONE),
    part(C(1.15, 1.15, 0.03, 0, 2.47, 0, 18), 0x3d6f86),
    part(C(0.12, 0.18, 0.7, 0, 2.8, 0, 8), STONE),
  ]);
  // Струи: центральный столб и «зонтик» падающей воды в нижнюю чашу
  const jets = mergeGeometries([
    new THREE.CylinderGeometry(0.08, 0.12, 1.6, 10, 1, true).translate(0, 3.9, 0),
    new THREE.CylinderGeometry(0.15, 1.25, 1.1, 18, 1, true).translate(0, 3.1, 0),
    new THREE.CylinderGeometry(1.3, 3.5, 2.2, 24, 1, true).translate(0, 1.4, 0),
  ].map((g) => g.toNonIndexed()));
  const bench = M([
    part(B(1.8, 0.07, 0.45, 0, 0.45, 0), 0x7a5a3a), part(B(1.8, 0.4, 0.06, 0, 0.75, -0.22), 0x7a5a3a),
    part(B(0.07, 0.45, 0.45, -0.8, 0.22, 0), 0x2b2e32), part(B(0.07, 0.45, 0.45, 0.8, 0.22, 0), 0x2b2e32),
  ]);
  const lamp = M([
    part(C(0.07, 0.09, 3.6, 0, 1.8, 0, 8), 0x22262a), part(C(0.18, 0.12, 0.12, 0, 3.6, 0, 8), 0x22262a),
    part(C(0.22, 0.16, 0.45, 0, 3.88, 0, 8), 0xfff2d8, { glow: 1 }), part(new THREE.ConeGeometry(0.3, 0.25, 8).translate(0, 4.22, 0), 0x22262a),
  ]);
  // Клумба 1×1 (масштабируется): бордюр, земля, цветы-бугорки (цвет экземпляра)
  const fl = [part(B(1, 0.22, 1, 0, 0.11, 0), 0xb8b0a0), part(B(0.9, 0.04, 0.9, 0, 0.23, 0), 0x4a3424)];
  const r = mulberry32(5);
  for (let k = 0; k < 14; k++) {
    const x = (r() - 0.5) * 0.8, z = (r() - 0.5) * 0.8;
    fl.push(part(new THREE.IcosahedronGeometry(0.09, 0).scale(1, 0.8, 1).translate(x, 0.32, z), 0xffffff, { tint: 1, sway: 0.4 }));
    fl.push(part(new THREE.IcosahedronGeometry(0.07, 0).translate(x * 0.9 + 0.04, 0.27, z * 0.9), 0x3f7a2c, { sway: 0.3 }));
  }
  const flowerbed = M(fl);
  const bush = M([
    part(new THREE.IcosahedronGeometry(0.9, 1).scale(1, 0.75, 1).translate(0, 0.6, 0), 0xffffff, { tint: 1, sway: 0.25 }),
    part(new THREE.IcosahedronGeometry(0.6, 0).translate(0.5, 0.75, 0.2), 0xffffff, { tint: 1, sway: 0.25 }),
  ]);
  const hedge = part(B(1, 0.9, 0.8, 0, 0.45, 0), 0xffffff, { tint: 1 });
  return { fountain, jets, bench, lamp, flowerbed, bush, hedge };
}
