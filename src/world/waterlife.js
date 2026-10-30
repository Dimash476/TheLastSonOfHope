import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { WORLD } from '../config.js';
import { mulberry32 } from '../utils.js';
import { POND, RIVER_Z, RIVER_HALF_W, BEACH, PIER } from './layout.js';

// Жизнь на воде: утки и лебеди на пруду и реке (отплывают от героя), камыш и кувшинки
// у пруда, выпрыгивающая рыба, стайка дельфинов у пляжа.

const W0 = WORLD.waterLevel;
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const UP = new THREE.Vector3(0, 1, 0);

export class WaterLife {
  constructor(scene, world) {
    this.world = world;
    this.t = 0;
    this.uTime = { value: 0 };
    const rnd = mulberry32(4242);
    const mat = createMat(this.uTime);
    const G = makeGeometries();

    // ---- птицы на воде: зона — пруд или отрезок реки
    this.birds = [];
    const zones = [
      { kind: 'pond', inside: (x, z) => Math.hypot(x - POND.x, z - POND.z) < POND.r - 4, cx: POND.x, cz: POND.z, r: POND.r - 6 },
      ...[-1500, -600, 300, 1200, 2100].map((x) => ({
        kind: 'river', inside: (px, pz) => Math.abs(pz - RIVER_Z) < RIVER_HALF_W - 4 && Math.abs(px - x) < 200, cx: x, cz: RIVER_Z, r: 150,
      })),
    ];
    const add = (type, zone, n) => {
      for (let i = 0; i < n; i++) {
        let x, z, k = 0;
        do { x = zone.cx + (rnd() - 0.5) * 2 * zone.r; z = zone.cz + (rnd() - 0.5) * 2 * (zone.kind === 'pond' ? zone.r : RIVER_HALF_W - 6); } while (!zone.inside(x, z) && ++k < 30);
        this.birds.push({ type, zone, pos: new THREE.Vector3(x, W0, z), heading: rnd() * 6.28, target: new THREE.Vector3(x, W0, z), timer: rnd() * 5, speed: 0, flee: 0 });
      }
    };
    for (const z of zones) { add('duck', z, z.kind === 'pond' ? 18 : 6); add('swan', z, z.kind === 'pond' ? 5 : 2); }
    this.duckMesh = this.inst(scene, G.duck, mat, this.birds.filter((b) => b.type === 'duck').length);
    this.swanMesh = this.inst(scene, G.swan, mat, this.birds.filter((b) => b.type === 'swan').length);
    let di = 0, si = 0;
    for (const b of this.birds) { b.mesh = b.type === 'duck' ? this.duckMesh : this.swanMesh; b.slot = b.type === 'duck' ? di++ : si++; }
    // Утки: разные оттенки (селезни с зелёной головой задаются геометрией, тут — тон тела)
    this.birds.forEach((b) => b.mesh.setColorAt(b.slot, new THREE.Color().setHSL(0.08, 0.25, b.type === 'duck' ? 0.35 + rnd() * 0.25 : 0.95)));

    // ---- камыш и кувшинки у пруда (статичные, покачиваются)
    const reeds = [], lilies = [];
    for (let i = 0; i < 70; i++) {
      const a = rnd() * 6.28, r = POND.r - 1 - rnd() * 5;
      reeds.push(_m.compose(_v.set(POND.x + Math.cos(a) * r, W0 - 0.3, POND.z + Math.sin(a) * r), _q.setFromAxisAngle(UP, rnd() * 6.28), _s.setScalar(0.8 + rnd() * 0.7)).clone());
    }
    for (let i = 0; i < 60; i++) {
      const a = rnd() * 6.28, r = POND.r * (0.55 + rnd() * 0.38);
      lilies.push(_m.compose(_v.set(POND.x + Math.cos(a) * r, W0 + 0.02, POND.z + Math.sin(a) * r), _q.setFromAxisAngle(UP, rnd() * 6.28), _s.setScalar(0.7 + rnd() * 0.8)).clone());
    }
    const rm = this.inst(scene, G.reed, mat, reeds.length); reeds.forEach((m, i) => rm.setMatrixAt(i, m));
    const lm = this.inst(scene, G.lily, mat, lilies.length); lilies.forEach((m, i) => { lm.setMatrixAt(i, m); lm.setColorAt(i, new THREE.Color(rnd() < 0.5 ? 0xf7c6d9 : 0xffffff)); });
    this.static = [rm, lm];

    // ---- рыба (одна сетка на несколько прыжков) и дельфины
    this.fishMesh = this.inst(scene, G.fish, mat, 6);
    for (let i = 0; i < 6; i++) this.fishMesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
    this.fish = [];
    this.fishT = 2;
    this.dolphMesh = this.inst(scene, G.dolphin, mat, 4);
    this.dolphins = [0, 1, 2, 3].map((i) => ({ i, off: new THREE.Vector3((rnd() - 0.5) * 12, 0, (rnd() - 0.5) * 18), ph: rnd() * 6.28 }));
    this.pod = { pos: new THREE.Vector3(BEACH.x0 + 260, 0, PIER.z + 400), dir: 1 };
  }

  inst(scene, geo, mat, n) {
    const m = new THREE.InstancedMesh(geo, mat, Math.max(1, n));
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, n) * 3).fill(1), 3);
    m.frustumCulled = false;
    m.castShadow = false;
    scene.add(m);
    return m;
  }

  // Прыжок рыбы: дуга над водой и брызги
  jump(x, z, big = false) {
    const f = this.fish.find((q) => q.t >= 1) || (this.fish.length < 6 ? { t: 1, i: this.fish.length } : null);
    if (!f) return;
    if (!this.fish.includes(f)) this.fish.push(f);
    Object.assign(f, { t: 0, x, z, h: Math.random() * 6.28, big });
    this.splash(x, z, 0.6);
  }

  splash(x, z, k) {
    this.world.dust?.burst(_v.set(x, W0 + 0.2, z).clone(), Math.round(5 * k + 3), { size: [0.3, 0.8], speed: 3 * k + 1, life: [0.4, 0.9], color: 0xe8f0f4, gravity: 9 });
  }

  update(dt, player, camPos) {
    this.t += dt;
    this.uTime.value = this.t;
    const near = (x, z, r) => Math.hypot(camPos.x - x, camPos.z - z) < r && camPos.y < 600;
    const hero = player.pos;
    // ---- утки и лебеди
    const showBirds = near(POND.x, POND.z, 900) || near(camPos.x, RIVER_Z, 700);
    this.duckMesh.visible = this.swanMesh.visible = showBirds;
    if (showBirds) {
      for (const b of this.birds) {
        const dh = Math.hypot(hero.x - b.pos.x, hero.z - b.pos.z);
        if (dh < 14 && hero.y < 12) b.flee = 3;
        b.timer -= dt;
        if (b.flee > 0) {
          b.flee -= dt;
          // Отплываем от героя (быстрее, с брызгами у уток)
          const ax = b.pos.x - hero.x, az = b.pos.z - hero.z, al = Math.hypot(ax, az) || 1;
          b.target.set(b.pos.x + ax / al * 6, W0, b.pos.z + az / al * 6);
          if (b.type === 'duck' && Math.random() < dt * 4) this.splash(b.pos.x, b.pos.z, 0.2);
        } else if (b.timer <= 0) {
          b.timer = 3 + Math.random() * 8;
          const a = Math.random() * 6.28, r = Math.random() * 12;
          b.target.set(b.pos.x + Math.cos(a) * r, W0, b.pos.z + Math.sin(a) * r);
        }
        const tx = b.target.x - b.pos.x, tz = b.target.z - b.pos.z, td = Math.hypot(tx, tz);
        const want = td > 0.3 ? (b.flee > 0 ? 3 : b.type === 'swan' ? 0.6 : 0.9) : 0;
        b.speed += (want - b.speed) * Math.min(1, dt * 2);
        if (td > 0.05) {
          const h = Math.atan2(tx, tz);
          b.heading += Math.atan2(Math.sin(h - b.heading), Math.cos(h - b.heading)) * Math.min(1, dt * 2);
        }
        const nx = b.pos.x + Math.sin(b.heading) * b.speed * dt, nz = b.pos.z + Math.cos(b.heading) * b.speed * dt;
        if (b.zone.inside(nx, nz)) { b.pos.x = nx; b.pos.z = nz; } else { b.target.set(b.zone.cx, W0, b.zone.cz); b.heading += 0.05; }
        const bob = Math.sin(this.t * 1.6 + b.slot) * 0.03;
        _e.set(Math.sin(this.t * 1.1 + b.slot) * 0.04, b.heading, Math.sin(this.t * 1.3 + b.slot * 2) * 0.05, 'YXZ');
        b.mesh.setMatrixAt(b.slot, _m.compose(_v.set(b.pos.x, W0 + bob, b.pos.z), _q.setFromEuler(_e), _s.setScalar(1)));
      }
      this.duckMesh.instanceMatrix.needsUpdate = this.swanMesh.instanceMatrix.needsUpdate = true;
    }
    for (const m of this.static) m.visible = near(POND.x, POND.z, 700);

    // ---- рыба: иногда выпрыгивает рядом с камерой (пруд, река, море у пляжа)
    this.fishT -= dt;
    // Рыба прыгает, только когда камера низко у воды (её видно и слышно, а не «стук» на пролёте)
    if (this.fishT <= 0 && camPos.y < 60 && player.vel.length() < 30) {
      this.fishT = 2 + Math.random() * 5;
      if (near(POND.x, POND.z, 300)) {
        const a = Math.random() * 6.28, r = Math.random() * (POND.r - 8);
        this.jump(POND.x + Math.cos(a) * r, POND.z + Math.sin(a) * r);
      } else if (Math.abs(camPos.z - RIVER_Z) < 250) {
        this.jump(camPos.x + (Math.random() - 0.5) * 160, RIVER_Z + (Math.random() - 0.5) * (RIVER_HALF_W * 1.4));
      } else if (camPos.x > BEACH.x0 - 200 && camPos.z > BEACH.minZ - 300 && camPos.z < BEACH.maxZ + 300) {
        this.jump(BEACH.x0 + 160 + Math.random() * 300, camPos.z + (Math.random() - 0.5) * 300, true);
      }
    }
    for (const f of this.fish) {
      if (f.t >= 1) { this.fishMesh.setMatrixAt(f.i, _m.makeScale(0, 0, 0)); continue; }
      const prev = f.t;
      f.t = Math.min(1, f.t + dt / 0.9);
      const y = W0 + Math.sin(f.t * Math.PI) * (f.big ? 1.6 : 0.8);
      const fx = f.x + Math.sin(f.h) * (f.t - 0.5) * 1.6, fz = f.z + Math.cos(f.h) * (f.t - 0.5) * 1.6;
      _e.set(-Math.cos(f.t * Math.PI) * 1.1, f.h, 0, 'YXZ');
      this.fishMesh.setMatrixAt(f.i, _m.compose(_v.set(fx, y, fz), _q.setFromEuler(_e), _s.setScalar(f.big ? 1.6 : 1)));
      if (prev < 0.95 && f.t >= 0.95) { this.splash(fx, fz, 0.5); this.world.soundscape?.plop?.(new THREE.Vector3(fx, W0, fz)); }
    }
    this.fishMesh.instanceMatrix.needsUpdate = true;

    // ---- дельфины: стайка ходит вдоль пляжа, выныривает дугой
    const showD = near(this.pod.pos.x, this.pod.pos.z, 2500);
    this.dolphMesh.visible = showD;
    if (showD) {
      const p = this.pod;
      p.pos.z += p.dir * 5 * dt;
      if (p.pos.z > BEACH.maxZ + 300) p.dir = -1;
      if (p.pos.z < BEACH.minZ - 300) p.dir = 1;
      for (const d of this.dolphins) {
        const ph = this.t * 1.3 + d.ph;
        const arc = Math.sin(ph);
        const y = W0 - 1.2 + Math.max(0, arc) * 2.2;
        _e.set(-Math.cos(ph) * 0.7 * (arc > -0.2 ? 1 : 0), p.dir > 0 ? 0 : Math.PI, 0, 'YXZ');
        this.dolphMesh.setMatrixAt(d.i, _m.compose(_v.set(p.pos.x + d.off.x, y, p.pos.z + d.off.z + Math.sin(ph * 0.5) * 2), _q.setFromEuler(_e), _s.setScalar(1)));
        // Брызги при выходе из воды и нырке
        if (Math.abs(Math.sin(ph)) < 0.06 && Math.random() < 0.5) this.splash(p.pos.x + d.off.x, p.pos.z + d.off.z, 0.8);
      }
      this.dolphMesh.instanceMatrix.needsUpdate = true;
    }
  }
}

function createMat(uTime) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float tint;\nattribute float sway;\nuniform float uTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          float ph = 0.0;
          #ifdef USE_INSTANCING
            ph = instanceMatrix[3].x * 0.4 + instanceMatrix[3].z * 0.3;
          #endif
          transformed.x += sin(uTime * 1.5 + ph) * 0.06 * sway;
          transformed.z += cos(uTime * 1.2 + ph) * 0.05 * sway;
        }`)
      .replace('#include <color_vertex>', `
        vColor.rgb = color.rgb;
        #ifdef USE_INSTANCING_COLOR
          vColor.rgb *= mix(vec3(1.0), instanceColor.rgb, tint);
        #endif`);
  };
  return mat;
}

function makeGeometries() {
  const part = (geo, color, tint = 0, swayFn = null) => {
    if (geo.index) geo = geo.toNonIndexed();
    if (geo.attributes.uv) geo.deleteAttribute('uv');
    if (!geo.attributes.normal) geo.computeVertexNormals();
    const n = geo.attributes.position.count, c = new THREE.Color(color), P = geo.attributes.position;
    const col = new Float32Array(n * 3), sw = new Float32Array(n);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; sw[i] = swayFn ? swayFn(P.getY(i)) : 0; }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('tint', new THREE.BufferAttribute(new Float32Array(n).fill(tint), 1));
    geo.setAttribute('sway', new THREE.BufferAttribute(sw, 1));
    return geo;
  };
  const S = (r, sx, sy, sz, x, y, z) => new THREE.SphereGeometry(r, 8, 6).scale(sx, sy, sz).translate(x, y, z);
  const M = (l) => mergeGeometries(l);
  const duck = M([
    part(S(0.16, 1, 0.65, 1.6, 0, 0.04, 0), 0xffffff, 1),
    part(S(0.08, 1, 1, 1.1, 0, 0.2, 0.2), 0x1f5a2a),                 // зелёная голова селезня
    part(S(0.04, 1, 0.6, 1.6, 0, 0.19, 0.3), 0xe0a020),               // клюв
    part(S(0.09, 0.9, 0.6, 1.2, 0, 0.1, -0.22), 0x2a2a2a),            // хвост
  ]);
  // Лебедь: крупное тело, S-образная шея, оранжевый клюв
  const neck = new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.15, 0.25), new THREE.Vector3(0, 0.45, 0.3), new THREE.Vector3(0, 0.75, 0.2), new THREE.Vector3(0, 0.85, 0.32),
  ]), 8, 0.045, 6);
  const swan = M([
    part(S(0.3, 1, 0.6, 1.6, 0, 0.08, 0), 0xffffff, 1), part(S(0.2, 1.1, 0.7, 1, 0, 0.18, -0.25), 0xffffff, 1),
    part(neck, 0xffffff, 1), part(S(0.065, 1, 0.9, 1.3, 0, 0.86, 0.36), 0xffffff, 1),
    part(S(0.035, 0.8, 0.6, 1.8, 0, 0.84, 0.46), 0xe07a20),
  ]);
  // Камыш: пучок тонких стеблей с «рогозом» наверху
  const reedParts = [];
  for (let k = 0; k < 7; k++) {
    const a = k * 0.9, r = 0.15 + (k % 3) * 0.1, h = 1.6 + (k % 4) * 0.35;
    reedParts.push(part(new THREE.CylinderGeometry(0.012, 0.02, h, 4).translate(Math.cos(a) * r, h / 2, Math.sin(a) * r), 0x5b7a34, 0, (y) => y * 0.35));
    if (k % 2 === 0) reedParts.push(part(new THREE.CylinderGeometry(0.035, 0.035, 0.25, 6).translate(Math.cos(a) * r, h - 0.2, Math.sin(a) * r), 0x5a3a22, 0, (y) => y * 0.35));
  }
  const reed = M(reedParts);
  // Кувшинка: лист-диск с вырезом и цветок (цвет экземпляра)
  const leaf = new THREE.CircleGeometry(0.45, 14, 0.25, Math.PI * 2 - 0.5).rotateX(-Math.PI / 2);
  const flower = [];
  for (let k = 0; k < 8; k++) flower.push(part(new THREE.SphereGeometry(0.07, 5, 3).scale(0.6, 0.5, 1.6).translate(0, 0.06, 0.08).rotateY(k * Math.PI / 4).translate(0.1, 0, 0), 0xffffff, 1));
  const lily = M([part(leaf, 0x2f6a2a), ...flower, part(S(0.04, 1, 1, 1, 0.1, 0.08, 0), 0xffd166)]);
  const fish = M([part(S(0.12, 0.5, 0.6, 1.8, 0, 0, 0), 0x9aa6ae), part(new THREE.ConeGeometry(0.1, 0.18, 4).rotateX(-Math.PI / 2).translate(0, 0, -0.27), 0x7a868e)]);
  // Дельфин: обтекаемое тело, спинной плавник, хвост
  const dolphin = M([
    part(S(0.45, 0.85, 0.85, 2.6, 0, 0, 0), 0x6e7a86), part(S(0.3, 0.8, 0.5, 2.3, 0, -0.12, 0.05), 0xc8ccd0),
    part(S(0.12, 0.7, 0.6, 1.8, 0, -0.05, 1.25), 0x6e7a86),
    part(new THREE.ConeGeometry(0.22, 0.45, 4).scale(0.25, 1, 1).translate(0, 0.5, -0.1).rotateX(-0.3), 0x5e6a76),
    part(new THREE.BoxGeometry(0.9, 0.05, 0.3).translate(0, 0, -1.2), 0x5e6a76),
  ]);
  return { duck, swan, reed, lily, fish, dolphin };
}
