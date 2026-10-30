import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CITY } from '../config.js';
import { mulberry32 } from '../utils.js';
import { HALF, RIVER_Z, RIVER_HALF_W, BIG_PARK, BLOCK, blockAt } from './layout.js';
import { VEHICLE_TYPES, createVehicleMaterial } from './vehicles.js';

// Уличная жизнь: светофоры на перекрёстках, скамейки, урны, гидранты, остановки
// с подсвеченной рекламой. Всё статичное и инстансное, рисуется только рядом
// с камерой. Светофоры переключаются прямо в шейдере (без работы процессора).

const CHUNK = 250;
const VIEW = 600;
// Мелочь (урны, скамейки, знаки, велосипеды, столики) вдали меньше пикселя — рисуем ближе,
// а тени от неё — только рядом (дальше они всё равно не различимы)
const SMALL = new Set(['bin', 'hydrant', 'bench', 'signRound', 'signBlue', 'bikes', 'cafe']);
const SMALL_VIEW = 380;
const SHADOW_NEAR = 130;
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const UP = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);

export class StreetLife {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.uNight = { value: 0 };
    this.uTime = { value: 0 };
    this.items = [];
    this.cells = new Map();
    const geos = makeGeometries();
    const groups = new Map();
    const add = (type, x, z, rot, color = 0xffffff) => {
      const it = { type, x, z, rot, color, alive: true };
      this.items.push(it);
      const key = Math.floor(x / CHUNK) * 1000 + Math.floor(z / CHUNK);
      if (!groups.has(key)) groups.set(key, {});
      const g = groups.get(key);
      (g[type] = g[type] || []).push(it);
      const ck = Math.floor(x / 40) * 100000 + Math.floor(z / 40);
      if (!this.cells.has(ck)) this.cells.set(ck, []);
      this.cells.get(ck).push(it);
    };
    const inPark = (x, z) => x > BIG_PARK.minX + 12 && x < BIG_PARK.maxX - 12 && z > BIG_PARK.minZ + 12 && z < BIG_PARK.maxZ - 12;
    const onBridge = (z) => Math.abs(z - RIVER_Z) < RIVER_HALF_W + 4;
    const lim = CITY.urbanHalf;
    const rnd = mulberry32(CITY.seed + 51);
    const curb = CITY.road / 2, walk = CITY.road / 2 + CITY.sidewalk;

    // Светофоры: на каждом перекрёстке центра — 4 столба по углам
    for (let k = 0; k <= CITY.grid; k++) for (let l = 0; l <= CITY.grid; l++) {
      const x = -HALF + k * CITY.block, z = -HALF + l * CITY.block;
      if (Math.max(Math.abs(x), Math.abs(z)) > lim || inPark(x, z) || onBridge(z)) continue;
      if (blockAt(x + 1, z + 1) !== BLOCK.URBAN && blockAt(x - 1, z - 1) !== BLOCK.URBAN) continue;
      const o = curb + 0.9;
      // Каждый столб смотрит навстречу своему потоку машин
      add('signal', x + o, z + o, Math.PI);
      // Дорожный знак у перекрёстка (без надписей): круглый или синий прямоугольный
      if (rnd() < 0.45) add(rnd() < 0.5 ? 'signRound' : 'signBlue', x - o, z + o + 7, Math.PI / 2);
      add('signal', x - o, z - o, 0);
      add('signal', x - o, z + o, Math.PI / 2);
      add('signal', x + o, z - o, -Math.PI / 2);
    }

    // Скамейки, урны, гидранты, остановки — вдоль тротуаров
    for (let k = 0; k <= CITY.grid; k++) {
      const line = -HALF + k * CITY.block;
      if (Math.abs(line) > lim) continue;
      for (let seg = -HALF; seg < HALF; seg += CITY.block) {
        if (seg < -lim || seg >= lim) continue;
        for (const side of [-1, 1]) for (const axis of [0, 1]) {
          for (const t of [18, 50, 82]) {
            const a = seg + t;
            // axis 0: улица вдоль X (z = line); axis 1: вдоль Z (x = line)
            const px = (o) => (axis === 0 ? a : line + side * o), pz = (o) => (axis === 0 ? line + side * o : a);
            const rot = axis === 0 ? (side > 0 ? Math.PI : 0) : (side > 0 ? -Math.PI / 2 : Math.PI / 2);
            if (inPark(px(walk), pz(walk)) || (axis === 1 && onBridge(a))) continue;
            const bt = blockAt(px(walk + 2), pz(walk + 2));
            if (bt !== BLOCK.URBAN && bt !== BLOCK.PARK) continue;
            const r = rnd();
            if (t === 50 && r < 0.12) {
              add('stop', px(walk - 1.0), pz(walk - 1.0), rot);
              // Велопарковка рядом с остановкой
              const b2 = a + 6;
              add('bikes', axis === 0 ? b2 : line + side * (walk - 1.2), axis === 0 ? line + side * (walk - 1.2) : b2, rot);
            } else if ((t === 18 || t === 82) && r > 0.86) add('cafe', px(walk - 1.4), pz(walk - 1.4), rot);
            else if (r < 0.32) add('bench', px(walk - 0.7), pz(walk - 0.7), rot);
            else if (r < 0.5) add('bin', px(curb + 1.4), pz(curb + 1.4), rot);
            else if (r < 0.58) add('hydrant', px(curb + 0.9), pz(curb + 0.9), rot);
          }
        }
      }
    }

    // Припаркованные машины у бордюров (фары выключены)
    const PARK = ['sedan', 'hatch', 'suv', 'van', 'sedan', 'hatch', 'taxi'];
    const typeOf = Object.fromEntries(VEHICLE_TYPES.map((t) => [t.name, t]));
    for (let k = 0; k <= CITY.grid; k++) {
      const line = -HALF + k * CITY.block;
      if (Math.abs(line) > lim) continue;
      for (let seg = -HALF; seg < HALF; seg += CITY.block) {
        if (seg < -lim || seg >= lim) continue;
        for (const side of [-1, 1]) for (const axis of [0, 1]) {
          for (const t of [24, 36, 64, 76]) {
            if (rnd() > 0.22) continue;
            const a = seg + t, off = curb - 1.6;
            const x = axis === 0 ? a : line + side * off, z = axis === 0 ? line + side * off : a;
            if (inPark(x, z) || (axis === 1 && onBridge(a))) continue;
            const bt = blockAt(axis === 0 ? x : line + side * (walk + 2), axis === 0 ? line + side * (walk + 2) : z);
            if (bt !== BLOCK.URBAN && bt !== BLOCK.SUBURB) continue;
            const name = PARK[Math.floor(rnd() * PARK.length)], T = typeOf[name];
            const rot = (axis === 0 ? Math.PI / 2 : 0) + (rnd() < 0.5 ? Math.PI : 0);
            add('car_' + name, x, z, rot, T.colors[Math.floor(rnd() * T.colors.length)]);
          }
        }
      }
    }
    const carGeos = {};
    for (const t of VEHICLE_TYPES) if (t.name !== 'bus') carGeos['car_' + t.name] = t.geo();
    this.carMat = createVehicleMaterial({ value: 0 });

    // Меши по чанкам
    this.matStatic = createStreetMaterial(this.uNight, this.uTime);
    this.chunks = [];
    for (const g of groups.values()) {
      const meshes = [];
      for (const type in g) {
        const list = g[type];
        const car = type.startsWith('car_');
        const mesh = new THREE.InstancedMesh(car ? carGeos[type] : geos[type], car ? this.carMat : this.matStatic, list.length);
        mesh.castShadow = type !== 'hydrant';
        if (car) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 3).fill(1), 3);
        list.forEach((it, i) => { it.mesh = mesh; it.slot = i; this.write(it); if (car) mesh.setColorAt(i, new THREE.Color(it.color)); });
        mesh.computeBoundingSphere();
        mesh.userData.small = SMALL.has(type);
        mesh.userData.shadow = mesh.castShadow;
        this.scene.add(mesh);
        meshes.push(mesh);
      }
      const c = meshes[0].boundingSphere.center;
      this.chunks.push({ meshes, x: c.x, z: c.z });
    }
  }

  write(it) {
    if (it.alive) _m.compose(_v.set(it.x, 0, it.z), _q.setFromAxisAngle(UP, it.rot), ONE);
    else _m.copy(_zero);
    it.mesh.setMatrixAt(it.slot, _m);
    it.mesh.instanceMatrix.needsUpdate = true;
  }

  // Ударная волна сносит мелочь (обломок улетает)
  impulse(center, radius, force) {
    const r = radius, W = this.world;
    const x0 = Math.floor((center.x - r) / 40), x1 = Math.floor((center.x + r) / 40);
    const z0 = Math.floor((center.z - r) / 40), z1 = Math.floor((center.z + r) / 40);
    for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) {
      const list = this.cells.get(i * 100000 + j);
      if (!list) continue;
      for (const it of list) {
        if (!it.alive) continue;
        const d = Math.hypot(it.x - center.x, it.z - center.z);
        if (d > r || force * (1 - d / r) < 7) continue;
        it.alive = false;
        this.write(it);
        const dir = _v.set(it.x - center.x, 0, it.z - center.z).normalize();
        const f = Math.min(30, force);
        const size = it.type === 'signal' ? [0.2, 4.5, 0.2] : it.type === 'stop' ? [3.5, 2.4, 0.3] : it.type.startsWith('car_') ? [1.9, 1.4, 4.4] : [0.6, 0.8, 0.6];
        W.debris?.spawn(it.x, size[1] / 2 + 0.2, it.z, size[0], size[1], size[2], dir.x * f, 3 + f * 0.3, dir.z * f, new THREE.Color(0x4a4e54), 0);
      }
    }
  }

  update(dt, camPos) {
    this.uTime.value += dt;
    for (const c of this.chunks) {
      const d = Math.hypot(c.x - camPos.x, c.z - camPos.z), v = camPos.y < 900 && d < VIEW;
      const dn = Math.max(0, d - CHUNK * 0.71);   // до ближайшего края участка
      for (const m of c.meshes) {
        m.visible = v && (!m.userData.small || d < SMALL_VIEW + camPos.y);
        m.castShadow = m.userData.shadow && (!m.userData.small || dn < SHADOW_NEAR);
      }
    }
  }

  setNight(k) { this.uNight.value = k; }

  reset() { for (const it of this.items) if (!it.alive) { it.alive = true; this.write(it); } }
}

// Атрибуты: lamp — линза светофора (1 красный, 2 жёлтый, 3 зелёный), glow — подсветка рекламы
function makeGeometries() {
  const part = (geo, color, lamp = 0, glow = 0) => {
    if (geo.index) geo = geo.toNonIndexed();
    geo.deleteAttribute('uv');
    const c = new THREE.Color(color), n = geo.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('lamp', new THREE.BufferAttribute(new Float32Array(n).fill(lamp), 1));
    geo.setAttribute('glow', new THREE.BufferAttribute(new Float32Array(n).fill(glow), 1));
    return geo;
  };
  const B = (w, h, d, x, y, z) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
  const C = (r, h, x, y, z, s = 8) => new THREE.CylinderGeometry(r, r, h, s).translate(x, y, z);
  const M = (l) => mergeGeometries(l);
  const METAL = 0x3b3f44;
  // Светофор: столб, кронштейн над дорогой, корпус с тремя линзами (смотрит вдоль +Z)
  const lenses = [1, 2, 3].map((lamp, i) => part(new THREE.CylinderGeometry(0.13, 0.13, 0.06, 10).rotateX(Math.PI / 2).translate(0, 5.25 - i * 0.36, 1.45 + 0.17), 0x111111, lamp));
  const signal = M([
    part(C(0.09, 5.6, 0, 2.8, 0), METAL),
    part(B(0.08, 0.08, 1.6, 0, 5.55, 0.8), METAL),
    part(B(0.38, 1.15, 0.3, 0, 4.9, 1.45), 0x16181a),
    ...[0, 1, 2].map((i) => part(B(0.36, 0.05, 0.16, 0, 5.4 - i * 0.36, 1.66), 0x16181a)),
    ...lenses,
    part(B(0.2, 0.3, 0.15, 0.15, 1.1, 0.1), 0x2c2e31),
  ]);
  const bench = M([
    part(B(1.8, 0.06, 0.45, 0, 0.45, 0), 0x6b4a2e), part(B(1.8, 0.4, 0.05, 0, 0.75, -0.22), 0x6b4a2e),
    part(B(0.06, 0.45, 0.45, -0.8, 0.22, 0), METAL), part(B(0.06, 0.45, 0.45, 0.8, 0.22, 0), METAL),
  ]);
  const bin = M([part(C(0.25, 0.85, 0, 0.43, 0, 10), 0x2e4a3a), part(C(0.27, 0.06, 0, 0.88, 0, 10), 0x1e2a22)]);
  const hydrant = M([part(C(0.13, 0.6, 0, 0.3, 0), 0xb3261e), part(new THREE.SphereGeometry(0.14, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 0.6, 0), 0xb3261e),
    part(C(0.05, 0.36, 0, 0.42, 0).rotateZ(Math.PI / 2), 0xb3261e)]);
  // Остановка: крыша, стеклянная задняя стенка, светящийся рекламный короб, скамья
  const stop = M([
    part(B(3.6, 0.1, 1.5, 0, 2.5, -0.1), 0x9aa0a6),
    part(B(3.4, 1.9, 0.05, 0, 1.4, -0.8), 0x7c8d99),
    part(B(0.08, 2.5, 0.08, -1.7, 1.25, -0.8), METAL), part(B(0.08, 2.5, 0.08, 1.7, 1.25, -0.8), METAL),
    part(B(0.08, 2.5, 0.08, -1.7, 1.25, 0.5), METAL), part(B(0.08, 2.5, 0.08, 1.7, 1.25, 0.5), METAL),
    part(B(1.2, 1.8, 0.2, 1.95, 1.2, -0.3), 0xffffff, 0, 1),
    part(B(2.2, 0.06, 0.4, -0.4, 0.5, -0.55), 0x5a5f66),
  ]);
  // Столик кафе: круглый стол, два стула, зонт и двое посетителей
  const seated = (x, z, face, shirt) => {
    const g = [
      B(0.38, 0.5, 0.24, 0, 0.75, -0.05), B(0.34, 0.14, 0.45, 0, 0.5, 0.18), B(0.3, 0.45, 0.12, 0, 0.25, 0.42),
    ].map((q) => part(q, shirt));
    g.push(part(new THREE.SphereGeometry(0.11, 8, 6).translate(0, 1.15, -0.02), 0xd29b74));
    g.push(part(B(0.09, 0.35, 0.09, 0.2, 0.75, 0.15).rotateX(-0.9), 0xd29b74), part(B(0.09, 0.35, 0.09, -0.2, 0.75, 0.15).rotateX(-0.9), 0xd29b74));
    return g.map((q) => q.rotateY(face).translate(x, 0, z));
  };
  const chair = (x, z, face) => [B(0.45, 0.05, 0.45, 0, 0.45, 0), B(0.45, 0.45, 0.04, 0, 0.7, -0.22), B(0.04, 0.45, 0.04, 0.2, 0.22, 0.2), B(0.04, 0.45, 0.04, -0.2, 0.22, 0.2)]
    .map((q) => part(q.rotateY(face).translate(x, 0, z), 0x3a3c40));
  const cafe = M([
    part(C(0.4, 0.03, 0, 0.74, 0, 16), 0xe8e4dc), part(C(0.04, 0.72, 0, 0.36, 0, 6), 0x3a3c40),
    ...chair(-0.7, 0, Math.PI / 2), ...chair(0.7, 0, -Math.PI / 2),
    ...seated(-0.75, 0, Math.PI / 2, 0x2f3e57), ...seated(0.75, 0, -Math.PI / 2, 0xa8432f),
    part(C(0.03, 2.4, 0, 1.2, 0, 6), 0xdddddd), part(new THREE.ConeGeometry(1.4, 0.45, 10, 1, true).translate(0, 2.4, 0), 0xe8dcc0),
  ]);
  // Знаки: круглый (красная кайма) и синий прямоугольный — без надписей
  const disc = (r, z) => new THREE.CylinderGeometry(r, r, 0.03, 18).rotateX(Math.PI / 2).translate(0, 2.45, z);
  const signRound = M([part(C(0.04, 2.6, 0, 1.3, 0, 6), 0x9aa0a6), part(disc(0.32, 0.03), 0xb3261e), part(disc(0.25, 0.05), 0xf2f2f2)]);
  const signBlue = M([part(C(0.04, 2.6, 0, 1.3, 0, 6), 0x9aa0a6), part(B(0.55, 0.55, 0.03, 0, 2.45, 0.04), 0x1f5aa6), part(B(0.35, 0.08, 0.035, 0, 2.45, 0.045), 0xf2f2f2)]);
  // Велопарковка: дуги и три велосипеда
  const bikes = [part(B(2.6, 0.05, 0.05, 0, 0.75, 0), 0x8a8d92)];
  for (const x of [-0.9, 0, 0.9]) {
    bikes.push(part(new THREE.TorusGeometry(0.33, 0.025, 4, 14).translate(0, 0.35, 0).rotateY(Math.PI / 2).translate(x, 0, -0.5), 0x1c1c1c));
    bikes.push(part(new THREE.TorusGeometry(0.33, 0.025, 4, 14).translate(0, 0.35, 0).rotateY(Math.PI / 2).translate(x, 0, 0.5), 0x1c1c1c));
    bikes.push(part(B(0.04, 0.04, 1.0, x, 0.6, 0), [0xb3261e, 0x2a6fdb, 0x2a9d8f][(x + 1) | 0] || 0x2a6fdb));
    bikes.push(part(B(0.04, 0.5, 0.04, x, 0.6, -0.2).rotateX(0.2), 0x1c1c1c));
    bikes.push(part(B(0.5, 0.04, 0.04, x, 0.95, 0.42), 0x1c1c1c));
  }
  return { signal, bench, bin, hydrant, stop, cafe, signRound, signBlue, bikes: M(bikes) };
}

function createStreetMaterial(uNight, uTime) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.35 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = uNight;
    shader.uniforms.uTime = uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float lamp;\nattribute float glow;\nuniform float uTime;\nvarying vec3 vLit;\nvarying float vGlow;\nvarying vec3 vLoc;')
      .replace('#include <color_vertex>', `#include <color_vertex>
        vGlow = glow;
        vLoc = position;
        vLit = vec3(0.0);
        if (lamp > 0.5) {
          // Цикл 24 с: зелёный 10 с, жёлтый 2 с, красный 12 с; у поперечной улицы — со сдвигом
          vec3 ip = instanceMatrix[3].xyz;
          float off = fract(sin(dot(floor(ip.xz / 100.0 + 0.5), vec2(12.9898, 78.233))) * 43758.5453) * 24.0;
          float axis = step(0.5, abs(instanceMatrix[2].x));
          float t = mod(uTime + off + axis * 12.0, 24.0);
          float on = lamp < 1.5 ? step(12.0, t) : lamp < 2.5 ? step(10.0, t) * step(t, 12.0) : step(t, 10.0);
          vec3 c = lamp < 1.5 ? vec3(1.0, 0.06, 0.04) : lamp < 2.5 ? vec3(1.0, 0.55, 0.04) : vec3(0.1, 1.0, 0.45);
          vLit = c * on;
          vColor.rgb = mix(c * 0.12, c, on);
        }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;\nvarying vec3 vLit;\nvarying float vGlow;\nvarying vec3 vLoc;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          // Рекламный короб: светлый фон с цветными абстрактными полосами
          vec3 ad = mix(vec3(0.95, 0.92, 0.85), vec3(0.2, 0.55, 0.9), step(0.6, fract(vLoc.y * 1.3 + vLoc.x)));
          totalEmissiveRadiance += vLit * mix(1.2, 3.0, uNight) + vGlow * ad * mix(0.3, 1.8, uNight);
        }`);
  };
  return mat;
}
