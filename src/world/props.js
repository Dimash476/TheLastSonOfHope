import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CITY } from '../config.js';
import { HALF, RIVER_Z, RIVER_HALF_W, BIG_PARK, inMega } from './layout.js';

const CELL = 60;
const CHUNK = 200;
const LAMP_VIEW = 650; // дальше этого фонари не рисуем (их слишком много)
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const _one = new THREE.Vector3(1, 1, 1);
const UP = new THREE.Vector3(0, 1, 0);

// Фонари вдоль дорог (ломаются) и заправки (взрываются).
export class Props {
  constructor(scene, world, gasSpots) {
    this.scene = scene;
    this.world = world;
    this.lamps = [];
    this.stations = [];
    this.cells = new Map();
    this.bulbMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.85, 0.55) });
    this.night = 0;
    this.createLamps();
    for (const s of gasSpots) this.createStation(s);
  }

  // ---------------------------------------------------------------- фонари
  createLamps() {
    const pole = makeLampGeometry();
    const bulb = new THREE.BoxGeometry(0.4, 0.1, 0.6).translate(0, 7.62, 1.6);
    const mat = new THREE.MeshStandardMaterial({ color: 0x4a4e54, roughness: 0.5, metalness: 0.7 });
    const lim = CITY.urbanHalf;
    const inPark = (x, z) => (x > BIG_PARK.minX + 12 && x < BIG_PARK.maxX - 12 && z > BIG_PARK.minZ + 12 && z < BIG_PARK.maxZ - 12) || !!inMega(x, z, 12);
    const groups = new Map();
    const offset = CITY.road / 2 + 0.8;
    for (let k = 0; k <= CITY.grid; k++) {
      const line = -HALF + k * CITY.block;
      if (Math.abs(line) > lim) continue;
      for (let seg = -HALF; seg < HALF; seg += CITY.block) {
        if (seg < -lim || seg >= lim) continue;
        for (const t of [33, 66]) {
          for (const side of [-1, 1]) {
            // Фонари вдоль дорог по X (z = line) и по Z (x = line)
            if (!inPark(seg + t, line + side * offset)) this.addLamp(groups, seg + t, line + side * offset, side > 0 ? Math.PI : 0);
            const z = seg + t;
            if (inPark(line + side * offset, z)) continue;
            if (Math.abs(z - RIVER_Z) < RIVER_HALF_W + 2) continue; // не ставим на мостах
            this.addLamp(groups, line + side * offset, z, side > 0 ? -Math.PI / 2 : Math.PI / 2);
          }
        }
      }
    }
    this.lampChunks = [];
    // Пятно света под плафоном (ночью)
    const poolGeo = new THREE.PlaneGeometry(16, 16).rotateX(-Math.PI / 2).translate(0, 0.06, 2.2);
    this.poolMat = createGlowPoolMaterial(0xffc27a, 0.55);
    for (const list of groups.values()) {
      const m = new THREE.InstancedMesh(pole, mat, list.length);
      const b = new THREE.InstancedMesh(bulb, this.bulbMat, list.length);
      const pool = new THREE.InstancedMesh(poolGeo, this.poolMat, list.length);
      m.castShadow = true;
      list.forEach((L, i) => { L.mesh = m; L.bulb = b; L.pool = pool; L.slot = i; this.writeLamp(L); });
      m.computeBoundingSphere(); b.computeBoundingSphere(); pool.computeBoundingSphere();
      pool.renderOrder = 2;
      this.scene.add(m, b, pool);
      this.lampChunks.push({ m, b, pool, x: m.boundingSphere.center.x, z: m.boundingSphere.center.z });
    }
  }

  addLamp(groups, x, z, rot) {
    const L = { x, z, rot, alive: true, index: this.lamps.length };
    this.lamps.push(L);
    const key = Math.floor(x / CHUNK) * 1000 + Math.floor(z / CHUNK);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(L);
    const ck = Math.floor(x / CELL) * 100000 + Math.floor(z / CELL);
    if (!this.cells.has(ck)) this.cells.set(ck, []);
    this.cells.get(ck).push(L);
  }

  writeLamp(L) {
    if (L.alive) {
      _q.setFromAxisAngle(UP, L.rot);
      _m.compose(_v.set(L.x, 0, L.z), _q, _one);
    } else _m.copy(_zero);
    L.mesh.setMatrixAt(L.slot, _m);
    L.bulb.setMatrixAt(L.slot, _m);
    L.pool.setMatrixAt(L.slot, _m);
    L.mesh.instanceMatrix.needsUpdate = L.bulb.instanceMatrix.needsUpdate = L.pool.instanceMatrix.needsUpdate = true;
  }

  lampsNear(x, z, r, cb) {
    const x0 = Math.floor((x - r) / CELL), x1 = Math.floor((x + r) / CELL);
    const z0 = Math.floor((z - r) / CELL), z1 = Math.floor((z + r) / CELL);
    for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) {
      const list = this.cells.get(i * 100000 + j);
      if (list) for (const L of list) if (L.alive && Math.hypot(L.x - x, L.z - z) < r) cb(L);
    }
  }

  breakLamp(L, dir, force) {
    L.alive = false;
    this.writeLamp(L);
    const W = this.world;
    const f = Math.min(40, force);
    // Столб улетает обломком
    W.debris.spawn(L.x, 4, L.z, 0.3, 8, 0.3, dir.x * f, 4 + f * 0.3, dir.z * f, new THREE.Color(0x4a4e54), 0);
    W.sparks.burst(_v.set(L.x, 7.5, L.z), 10, { size: [0.2, 0.5], speed: 6, life: [0.3, 0.8], color: 0xfff0b0, gravity: 15 });
    W.audio?.metal(0.3, new THREE.Vector3(L.x, 5, L.z));
  }

  // ---------------------------------------------------------------- заправки
  createStation(spot) {
    const w = Math.min(spot.w, 34), d = Math.min(spot.d, 26);
    const geo = makeStationGeometry(w, d);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.2 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(spot.x, 0, spot.z);
    mesh.castShadow = mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.stations.push({ x: spot.x, z: spot.z, w, d, hp: 120, alive: true, mesh });
  }

  explodeStation(st) {
    if (!st.alive) return;
    st.alive = false;
    st.mesh.visible = false;
    const W = this.world;
    const p = new THREE.Vector3(st.x, 3, st.z);
    W.fire.explosion(p, 2.6);
    W.effects.shockwave(p, { type: 'sphere', radius: 70, life: 0.8, opacity: 0.45, color: 0xffa050 });
    W.effects.shockwave(p.clone().setY(1), { type: 'ring', radius: 110, life: 1.0, opacity: 0.7, color: 0xffc080 });
    W.effects.flash(p, 60);
    W.audio?.explosion(1.2, p);
    for (let i = 0; i < 40; i++) {
      const s = 0.5 + Math.random() * 2;
      W.debris.spawn(st.x + (Math.random() - 0.5) * st.w, 2 + Math.random() * 4, st.z + (Math.random() - 0.5) * st.d,
        s, s * 0.4, s, (Math.random() - 0.5) * 60, 15 + Math.random() * 35, (Math.random() - 0.5) * 60,
        new THREE.Color(i % 3 ? 0xd8d8d8 : 0xc0392b), 0);
    }
    W.fire.add(new THREE.Vector3(st.x, 0, st.z), { size: 4, life: 45 });
    W.fire.add(new THREE.Vector3(st.x + st.w * 0.3, 0, st.z), { size: 2.5, life: 35 });
    W.city.damageRadius(p, 45, 450, 50);
  }

  // ---------------------------------------------------------------- события
  // Ударная волна: ломает фонари, повреждает заправки
  impulse(center, radius, force) {
    this.lampsNear(center.x, center.z, radius, (L) => {
      if (force * (1 - Math.hypot(L.x - center.x, L.z - center.z) / radius) < 6) return;
      const dir = _v.set(L.x - center.x, 0, L.z - center.z).normalize();
      this.breakLamp(L, dir.clone(), force);
    });
    for (const st of this.stations) {
      if (!st.alive) continue;
      const d = Math.hypot(st.x - center.x, st.z - center.z) - Math.max(st.w, st.d) / 2;
      if (d < radius) { st.hp -= force * 2 * (1 - Math.max(0, d) / radius); if (st.hp <= 0) this.explodeStation(st); }
    }
  }

  // Удар / таран игрока
  hit(center, radius, vel, damage) {
    let any = false;
    this.lampsNear(center.x, center.z, radius + 0.5, (L) => {
      if (center.y > 9) return;
      this.breakLamp(L, vel.clone().setY(0).normalize(), Math.max(15, vel.length() * 0.5));
      any = true;
    });
    for (const st of this.stations) {
      if (!st.alive || center.y > 8) continue;
      if (Math.abs(center.x - st.x) < st.w / 2 + radius && Math.abs(center.z - st.z) < st.d / 2 + radius) {
        st.hp -= damage;
        any = true;
        this.world.sparks.burst(center, 10, { size: [0.2, 0.6], speed: 10, life: [0.2, 0.5], color: 0xffd080 });
        if (st.hp <= 0) this.explodeStation(st);
      }
    }
    return any;
  }

  // Показываем только фонари рядом с камерой
  update(camPos) {
    for (const c of this.lampChunks) {
      const v = camPos.y < 1500 && Math.hypot(c.x - camPos.x, c.z - camPos.z) < LAMP_VIEW;
      c.m.visible = c.b.visible = v;
      c.pool.visible = v && this.night > 0.05;
    }
  }

  setNight(k) {
    this.night = k;
    this.bulbMat.color.setRGB(1, 0.85, 0.55).multiplyScalar(0.25 + k * 3.5);
    this.poolMat.uniforms.uK.value = k;
  }

  reset() {
    for (const L of this.lamps) if (!L.alive) { L.alive = true; this.writeLamp(L); }
    for (const st of this.stations) { st.alive = true; st.hp = 120; st.mesh.visible = true; }
  }
}

function colorize(geo, color) {
  const c = new THREE.Color(color), n = geo.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
  if (geo.index) geo = geo.toNonIndexed();
  geo.deleteAttribute('uv');
  return geo;
}

// Столб с изогнутой «рукой», плафон смотрит вдоль +Z
function makeLampGeometry() {
  const pole = new THREE.BoxGeometry(0.22, 8, 0.22).translate(0, 4, 0);
  const arm = new THREE.BoxGeometry(0.1, 0.1, 1.8).translate(0, 7.8, 0.85);
  const head = new THREE.BoxGeometry(0.5, 0.18, 0.8).translate(0, 7.75, 1.6);
  return mergeGeometries([pole, arm, head].map((g) => { g.deleteAttribute('uv'); return g.index ? g.toNonIndexed() : g; }));
}

// Заправка: навес на опорах, колонки, магазинчик
function makeStationGeometry(w, d) {
  const parts = [];
  parts.push(colorize(new THREE.BoxGeometry(w * 0.7, 0.9, d * 0.6).translate(-w * 0.1, 5.6, 0), 0xf2f2f2));
  parts.push(colorize(new THREE.BoxGeometry(w * 0.7 + 0.1, 0.35, d * 0.6 + 0.1).translate(-w * 0.1, 5.2, 0), 0xc0392b));
  for (const [x, z] of [[-0.35, -0.22], [0.15, -0.22], [-0.35, 0.22], [0.15, 0.22]]) {
    parts.push(colorize(new THREE.BoxGeometry(0.5, 5.2, 0.5).translate(x * w, 2.6, z * d), 0xdddddd));
  }
  for (const [x, z] of [[-0.3, -0.1], [0.1, -0.1], [-0.3, 0.1], [0.1, 0.1]]) {
    parts.push(colorize(new THREE.BoxGeometry(0.9, 1.7, 0.6).translate(x * w, 0.85, z * d), 0xc0392b));
    parts.push(colorize(new THREE.BoxGeometry(0.92, 0.4, 0.62).translate(x * w, 1.5, z * d), 0xf2f2f2));
  }
  parts.push(colorize(new THREE.BoxGeometry(w * 0.25, 4, d * 0.5).translate(w * 0.36, 2, 0), 0xe8e2d0));
  parts.push(colorize(new THREE.BoxGeometry(w * 0.25 + 0.1, 0.6, d * 0.5 + 0.1).translate(w * 0.36, 4.2, 0), 0x2e7d32));
  parts.push(colorize(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2).translate(0, 0.03, 0), 0x3a3a3c));
  return mergeGeometries(parts);
}

// Пятно света на земле (ночью): мягкий радиальный градиент, аддитивно, без настоящего источника света
export function createGlowPoolMaterial(color, strength) {
  return new THREE.ShaderMaterial({
    uniforms: { uK: { value: 0 }, uColor: { value: new THREE.Color(color) } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 p = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          p = instanceMatrix * p;
        #endif
        gl_Position = projectionMatrix * modelViewMatrix * p;
      }`,
    fragmentShader: `uniform float uK; uniform vec3 uColor; varying vec2 vUv;
      void main() {
        float r = length(vUv - 0.5) * 2.0;
        float a = pow(max(0.0, 1.0 - r), 2.2) * uK * ${strength.toFixed(2)};
        gl_FragColor = vec4(uColor * a, 1.0);
      }`,
  });
}
