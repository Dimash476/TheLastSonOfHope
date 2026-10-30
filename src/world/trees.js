import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CITY } from '../config.js';
import { mulberry32 } from '../utils.js';
import { HALF, BLOCK, blockTypes, BIG_PARK, POND, PLANE_HALF, forestMask, groundHeight, fbm, parkPathDist, bigParkPaths, bigParkPathDist, PARK_RING } from './layout.js';

const CELL = 60;
const CHUNK = 500;      // крупные участки — меньше вызовов отрисовки
const VIEW = 900;      // дальше деревья не рисуем
const FOREST_CHUNK = 1200;
const FOREST_VIEW = 1900; // лес на холмах виден дальше
const FOREST_R = 9000;
const LOD_NEAR = 230;    // ближе — подробные деревья, дальше — упрощённые (на глаз не отличить)
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const UP = new THREE.Vector3(0, 1, 0);

// Деревья: парки, улицы города и пригорода. Кроны качаются, от ударов деревья ломаются.
export class Trees {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.list = [];
    this.cells = new Map();
    this.uTime = { value: 0 };
    const rnd = mulberry32(CITY.seed + 77);
    this.generate(rnd);
    this.buildMeshes(rnd);
  }

  generate(rnd) {
    const g = CITY.grid, B = CITY.block;
    // Порода: в лесу на высоте — ели, ниже — смешанный лес; в городе — липы, дубы, берёзы
    const pick = (forest, y) => {
      const r = rnd();
      if (forest) return y > 220 || r < 0.35 ? 'conifer' : r < 0.65 ? 'oak' : 'broad';
      return r < 0.52 ? 'broad' : r < 0.74 ? 'oak' : r < 0.93 ? 'birch' : 'conifer';
    };
    const add = (x, z, y = 0, scale = 1, forest = false) => {
      const t = { x, z, y, forest, kind: pick(forest, y), alive: true, s: (0.75 + rnd() * 0.6) * scale, rot: rnd() * Math.PI * 2, shade: 0.8 + rnd() * 0.35 };
      this.list.push(t);
      const key = Math.floor(x / CELL) * 100000 + Math.floor(z / CELL);
      if (!this.cells.has(key)) this.cells.set(key, []);
      this.cells.get(key).push(t);
    };
    for (let i = 0; i < g; i++) for (let j = 0; j < g; j++) {
      const type = blockTypes[j * g + i];
      const bx = -HALF + i * B, bz = -HALF + j * B;
      if (type === BLOCK.PARK) {
        const cx = bx + B / 2, cz = bz + B / 2;
        // Аллеи: деревья по обе стороны дорожек крест-накрест
        for (let t = PARK_RING + 6; t < B / 2 - 12; t += 7.5) for (const sgn of [-1, 1]) for (const side of [-4.2, 4.2]) {
          add(cx + sgn * t, cz + side, 0, 1.05); add(cx + side, cz + sgn * t, 0, 1.05);
        }
        // Кольцо деревьев вокруг площади
        for (let a = 0; a < 12; a++) { const an = a / 12 * Math.PI * 2 + 0.26; add(cx + Math.cos(an) * (PARK_RING + 4.5), cz + Math.sin(an) * (PARK_RING + 4.5), 0, 0.95); }
        // Рощицы в четвертях, подальше от дорожек
        for (let k = 0; k < 40; k++) {
          const x = bx + 15 + rnd() * 70, z = bz + 15 + rnd() * 70;
          if (parkPathDist(x, z) > 6.5 && Math.hypot(x - cx, z - cz) > PARK_RING + 8) add(x, z);
        }
      } else if (type === BLOCK.URBAN || type === BLOCK.SUBURB) {
        // Деревья на тротуаре (в городе) или на газоне у дороги (в пригороде)
        const inset = type === BLOCK.URBAN ? 10.8 : 14;
        const steps = type === BLOCK.URBAN ? [17, 50, 83] : [20, 40, 60, 80];
        for (const t of steps) {
          if (rnd() < 0.15) continue;
          add(bx + t, bz + inset); add(bx + t, bz + B - inset);
          add(bx + inset, bz + t); add(bx + B - inset, bz + t);
        }
      }
    }
    // Центральный парк: густые рощи, поляны и берег пруда без деревьев
    const P = BIG_PARK;
    for (let k = 0; k < 2600; k++) {
      const x = P.minX + 14 + rnd() * (P.maxX - P.minX - 28), z = P.minZ + 14 + rnd() * (P.maxZ - P.minZ - 28);
      if (Math.hypot(x - POND.x, z - POND.z) < POND.r + 14) continue;
      if (bigParkPathDist(x, z) < 9) continue;          // вдоль дорожек — аллеи (ниже)
      if (fbm(x * 0.012, z * 0.012, 3) < 0.48) continue; // поляны
      add(x, z, 0, 1.15);
    }
    // Аллеи центрального парка: ровные ряды деревьев вдоль извилистых дорожек
    const along = (fx, fz, from, to, step) => {
      for (let u = from; u < to; u += step) {
        const x = fx(u), z = fz(u), x2 = fx(u + 1), z2 = fz(u + 1);
        const tx = x2 - x, tz = z2 - z, tl = Math.hypot(tx, tz) || 1, nx = -tz / tl, nz = tx / tl;
        for (const s of [-5.2, 5.2]) {
          const ax = x + nx * s, az = z + nz * s;
          if (ax > P.minX + 10 && ax < P.maxX - 10 && az > P.minZ + 10 && az < P.maxZ - 10 && Math.hypot(ax - POND.x, az - POND.z) > POND.r + 4) add(ax, az, 0, 1.1);
        }
      }
    };
    const cxP = (P.minX + P.maxX) / 2, czP = (P.minZ + P.maxZ) / 2;
    along((u) => u, (u) => czP + 60 * Math.sin(u * 0.012), P.minX, P.maxX, 9);
    along((u) => cxP + 50 * Math.sin(u * 0.015 + 1), (u) => u, P.minZ, P.maxZ, 9);
    along((u) => POND.x + Math.cos(u / (POND.r + 9)) * (POND.r + 9), (u) => POND.z + Math.sin(u / (POND.r + 9)) * (POND.r + 9), 0, Math.PI * 2 * (POND.r + 9), 10);
    // Леса на холмах вокруг города
    const step = 30;
    for (let x = -FOREST_R; x <= FOREST_R; x += step) for (let z = -FOREST_R; z <= FOREST_R; z += step) {
      if (Math.max(Math.abs(x), Math.abs(z)) < PLANE_HALF + 150) continue;
      const px = x + (rnd() - 0.5) * step, pz = z + (rnd() - 0.5) * step;
      const y = groundHeight(px, pz);
      if (rnd() > forestMask(px, pz, y)) continue;
      add(px, pz, y - 0.5, 2.3 + rnd() * 0.9, true);
    }
  }

  buildMeshes(rnd) {
    const geos = makeTreeGeometries(false);
    const lods = makeTreeGeometries(true);
    // Теневой двойник в кадре невидим (ни цвета, ни глубины), а в карту теней пишется
    // упрощённой формой: тень та же, а вершин в разы меньше
    const shadowOnly = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
    // Ветер: кроны (выше 2.5 м) покачиваются, у каждого дерева своя фаза
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          {
            float h = max(0.0, transformed.y - 2.5);
            float ph = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.23;
            transformed.x += sin(uTime * 1.3 + ph) * 0.05 * h;
            transformed.z += cos(uTime * 1.1 + ph * 1.3) * 0.04 * h;
          }`);
    };
    const groups = new Map();
    for (const t of this.list) {
      const C = t.forest ? FOREST_CHUNK : CHUNK;
      const key = `${t.forest ? 'f' : 'c'}${t.kind}:${Math.floor(t.x / C)},${Math.floor(t.z / C)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    this.chunks = [];
    const col = new THREE.Color();
    for (const list of groups.values()) {
      const m = new THREE.InstancedMesh(geos[list[0].kind], mat, list.length);
      m.receiveShadow = true;
      list.forEach((t, i) => {
        t.mesh = m; t.slot = i;
        this.write(t);
        col.setRGB(t.shade, t.shade * (0.95 + rnd() * 0.1), t.shade * 0.9);
        m.setColorAt(i, col);
      });
      m.computeBoundingSphere();
      m.computeBoundingBox();
      // Упрощённая копия (вдали) и теневой двойник — те же матрицы и цвета, другая сетка
      const lo = new THREE.InstancedMesh(lods[list[0].kind], mat, list.length);
      const sh = new THREE.InstancedMesh(lods[list[0].kind], shadowOnly, list.length);
      for (const x of [lo, sh]) {
        x.instanceMatrix = m.instanceMatrix;
        x.instanceColor = m.instanceColor;
        x.boundingSphere = m.boundingSphere;
        x.boundingBox = m.boundingBox;
      }
      lo.receiveShadow = true;
      sh.castShadow = true;
      sh.renderOrder = 10;   // в кадре — после всего: почти все пиксели отсекает тест глубины
      this.scene.add(m, lo, sh);
      const b = m.boundingBox;
      this.chunks.push({ m, lo, sh, x: m.boundingSphere.center.x, z: m.boundingSphere.center.z, b, view: list[0].forest ? FOREST_VIEW : VIEW });
    }
  }

  write(t) {
    if (t.alive) {
      _q.setFromAxisAngle(UP, t.rot);
      _m.compose(_v.set(t.x, t.y, t.z), _q, _s.setScalar(t.s));
    } else _m.copy(_zero);
    t.mesh.setMatrixAt(t.slot, _m);
    t.mesh.instanceMatrix.needsUpdate = true;
  }

  near(x, z, r, cb) {
    const x0 = Math.floor((x - r) / CELL), x1 = Math.floor((x + r) / CELL);
    const z0 = Math.floor((z - r) / CELL), z1 = Math.floor((z + r) / CELL);
    for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) {
      const l = this.cells.get(i * 100000 + j);
      if (l) for (const t of l) if (t.alive && Math.hypot(t.x - x, t.z - z) < r) cb(t);
    }
  }

  // Дерево ломается: ствол улетает обломком, листва — облачком
  breakTree(t, dir, force) {
    t.alive = false;
    this.write(t);
    const W = this.world, f = Math.min(35, force);
    W.debris.spawn(t.x, t.y + 1.8 * t.s, t.z, 0.35 * t.s, 3.2 * t.s, 0.35 * t.s, dir.x * f, 3 + f * 0.25, dir.z * f, new THREE.Color(0x4a3524), 0);
    W.dust.burst(_v.set(t.x, t.y + 4.5 * t.s, t.z), 10, { size: [2, 5], speed: 6 + f * 0.3, life: [1.5, 3], color: 0x3f6b2a, gravity: 4, dir });
  }

  impulse(center, radius, force) {
    this.near(center.x, center.z, radius, (t) => {
      const k = 1 - Math.hypot(t.x - center.x, t.z - center.z) / radius;
      if (force * k < 8) return;
      const dir = new THREE.Vector3(t.x - center.x, 0, t.z - center.z).normalize();
      this.breakTree(t, dir, force * k);
    });
  }

  hit(center, radius, vel) {
    let any = false;
    this.near(center.x, center.z, radius + 0.6, (t) => {
      if (center.y - t.y > 8 * t.s) return;
      this.breakTree(t, vel.clone().setY(0).normalize(), Math.max(12, vel.length() * 0.4));
      any = true;
    });
    return any;
  }

  update(dt, camPos) {
    this.uTime.value += dt;
    for (const c of this.chunks) {
      const vis = camPos.y < 2500 && Math.hypot(c.x - camPos.x, c.z - camPos.z) < c.view + camPos.y;
      // Расстояние до ближайшей точки участка (а не до центра)
      const dx = Math.max(c.b.min.x - camPos.x, 0, camPos.x - c.b.max.x), dz = Math.max(c.b.min.z - camPos.z, 0, camPos.z - c.b.max.z);
      const near = Math.hypot(dx, dz, Math.max(0, camPos.y - c.b.max.y)) < LOD_NEAR;
      c.m.visible = vis && near;
      c.lo.visible = vis && !near;
      c.sh.visible = vis;
    }
  }

  reset() { for (const t of this.list) if (!t.alive) { t.alive = true; this.write(t); } }
}

function colorize(geo, color) {
  if (geo.index) geo = geo.toNonIndexed();
  const c = new THREE.Color(color), n = geo.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    // Лёгкая вариация оттенка по вершинам — крона не выглядит пластиковой
    const k = 0.85 + Math.random() * 0.3;
    a[i * 3] = c.r * k; a[i * 3 + 1] = c.g * k; a[i * 3 + 2] = c.b * k;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
  geo.deleteAttribute('uv');
  return geo;
}

// Породы деревьев: раскидистая липа, могучий дуб, белоствольная берёза, ель.
// lo — упрощённая версия той же формы (для дали и для теней)
function makeTreeGeometries(lo) {
  const M = (parts) => { const g = mergeGeometries(parts); g.computeVertexNormals(); return g; };
  const ico = (r) => new THREE.IcosahedronGeometry(r, lo ? 0 : 1);
  const cyl = (a, b, h, n) => new THREE.CylinderGeometry(a, b, h, lo ? 4 : n);
  const cone = (r, h) => new THREE.ConeGeometry(r, h, lo ? 5 : 8);
  const broad = M([
    colorize(cyl(0.14, 0.22, 3.2, 6).translate(0, 1.6, 0), 0x4a3524),
    colorize(ico(1.9).scale(1, 1.15, 1).translate(0, 4.4, 0), 0x2f5a22),
    colorize(ico(1.35).translate(0.7, 5.6, 0.3), 0x3a6a2a),
    colorize(ico(1.2).translate(-0.8, 4.9, -0.5), 0x335f25),
  ]);
  // Дуб: толстый ствол с ветвями, широкая низкая крона из нескольких масс
  const oak = M([
    colorize(cyl(0.22, 0.38, 3.0, 7).translate(0, 1.5, 0), 0x3e2c1e),
    colorize(cyl(0.08, 0.14, 2.2, 5).rotateZ(0.8).translate(0.7, 3.2, 0), 0x3e2c1e),
    colorize(cyl(0.08, 0.14, 2.0, 5).rotateZ(-0.7).translate(-0.6, 3.1, 0.2), 0x3e2c1e),
    colorize(ico(2.1).scale(1.35, 0.8, 1.2).translate(0, 4.5, 0), 0x2a4d1c),
    colorize(ico(1.5).scale(1, 0.8, 1).translate(1.7, 4.2, 0.4), 0x31581f),
    colorize(ico(1.4).scale(1, 0.8, 1).translate(-1.6, 4.3, -0.5), 0x2d521d),
    colorize(ico(1.3).translate(0.2, 5.6, 0.6), 0x355e22),
  ]);
  // Берёза: тонкий белый ствол с тёмными отметинами, лёгкая вытянутая крона
  const birchTrunk = [];
  for (let k = 0; k < 6; k++) birchTrunk.push(colorize(cyl(0.1 - k * 0.008, 0.11 - k * 0.008, 0.9, 6).translate(0, 0.45 + k * 0.9, 0), k % 2 ? 0xe8e4da : 0xd8d2c4));
  for (let k = 0; k < 5; k++) birchTrunk.push(colorize(new THREE.BoxGeometry(0.21, 0.05, 0.21).translate(0, 0.7 + k * 1.05, 0), 0x2a2622));
  const birch = M([
    ...birchTrunk,
    colorize(ico(1.2).scale(0.9, 1.5, 0.9).translate(0, 5.6, 0), 0x6a9a3a),
    colorize(ico(0.9).scale(1, 1.3, 1).translate(0.45, 4.7, 0.2), 0x7aa844),
    colorize(ico(0.8).scale(1, 1.3, 1).translate(-0.4, 4.9, -0.3), 0x5f8f34),
  ]);
  // Ель: ярусы конусов, тёмная хвоя
  const conifer = M([
    colorize(cyl(0.1, 0.18, 2.0, 6).translate(0, 1.0, 0), 0x3a2a1c),
    colorize(cone(1.6, 2.6).translate(0, 2.6, 0), 0x1f3d22),
    colorize(cone(1.25, 2.3).translate(0, 3.9, 0), 0x234526),
    colorize(cone(0.9, 2.0).translate(0, 5.1, 0), 0x264a28),
    colorize(cone(0.5, 1.5).translate(0, 6.2, 0), 0x2a502c),
  ]);
  return { broad, oak, birch, conifer };
}
