import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CITY } from '../config.js';
import { mulberry32 } from '../utils.js';
import { HALF, BLOCK, blockTypes } from './layout.js';

const CELL = 60;
const CHUNK = 250;
const VIEW = 900;      // дальше деревья не рисуем
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
    const add = (x, z) => {
      const t = { x, z, alive: true, s: 0.75 + rnd() * 0.6, rot: rnd() * Math.PI * 2, shade: 0.8 + rnd() * 0.35 };
      this.list.push(t);
      const key = Math.floor(x / CELL) * 100000 + Math.floor(z / CELL);
      if (!this.cells.has(key)) this.cells.set(key, []);
      this.cells.get(key).push(t);
    };
    for (let i = 0; i < g; i++) for (let j = 0; j < g; j++) {
      const type = blockTypes[j * g + i];
      const bx = -HALF + i * B, bz = -HALF + j * B;
      if (type === BLOCK.PARK) {
        for (let k = 0; k < 34; k++) add(bx + 15 + rnd() * 70, bz + 15 + rnd() * 70);
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
  }

  buildMeshes(rnd) {
    const geo = makeTreeGeometry();
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
      const key = Math.floor(t.x / CHUNK) * 1000 + Math.floor(t.z / CHUNK);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    this.chunks = [];
    const col = new THREE.Color();
    for (const list of groups.values()) {
      const m = new THREE.InstancedMesh(geo, mat, list.length);
      m.castShadow = true;
      m.receiveShadow = true;
      list.forEach((t, i) => {
        t.mesh = m; t.slot = i;
        this.write(t);
        col.setRGB(t.shade, t.shade * (0.95 + rnd() * 0.1), t.shade * 0.9);
        m.setColorAt(i, col);
      });
      m.computeBoundingSphere();
      this.scene.add(m);
      this.chunks.push({ m, x: m.boundingSphere.center.x, z: m.boundingSphere.center.z });
    }
  }

  write(t) {
    if (t.alive) {
      _q.setFromAxisAngle(UP, t.rot);
      _m.compose(_v.set(t.x, 0, t.z), _q, _s.setScalar(t.s));
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
    W.debris.spawn(t.x, 1.8 * t.s, t.z, 0.35 * t.s, 3.2 * t.s, 0.35 * t.s, dir.x * f, 3 + f * 0.25, dir.z * f, new THREE.Color(0x4a3524), 0);
    W.dust.burst(_v.set(t.x, 4.5 * t.s, t.z), 10, { size: [2, 5], speed: 6 + f * 0.3, life: [1.5, 3], color: 0x3f6b2a, gravity: 4, dir });
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
    if (center.y > 8) return false;
    this.near(center.x, center.z, radius + 0.6, (t) => {
      this.breakTree(t, vel.clone().setY(0).normalize(), Math.max(12, vel.length() * 0.4));
      any = true;
    });
    return any;
  }

  update(dt, camPos) {
    this.uTime.value += dt;
    for (const c of this.chunks) c.m.visible = camPos.y < 2500 && Math.hypot(c.x - camPos.x, c.z - camPos.z) < VIEW + camPos.y;
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

function makeTreeGeometry() {
  const trunk = colorize(new THREE.CylinderGeometry(0.14, 0.22, 3.2, 6).translate(0, 1.6, 0), 0x4a3524);
  const crown1 = colorize(new THREE.IcosahedronGeometry(1.9, 1).scale(1, 1.15, 1).translate(0, 4.4, 0), 0x2f5a22);
  const crown2 = colorize(new THREE.IcosahedronGeometry(1.35, 1).translate(0.7, 5.6, 0.3), 0x3a6a2a);
  const crown3 = colorize(new THREE.IcosahedronGeometry(1.2, 1).translate(-0.8, 4.9, -0.5), 0x335f25);
  const g = mergeGeometries([trunk, crown1, crown2, crown3]);
  g.computeVertexNormals();
  return g;
}
