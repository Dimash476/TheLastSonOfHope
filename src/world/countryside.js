import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../utils.js';
import { PLANE_HALF, plainK, sampleTerrain, forestMask } from './layout.js';

// За городом: стада коров и лошадей на лугах, красные амбары у полей, орлы над горами.

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const UP = new THREE.Vector3(0, 1, 0);

export class Countryside {
  constructor(scene, world) {
    this.world = world;
    this.t = 0;
    const rnd = mulberry32(777);
    const slopeAt = (x, z) => Math.hypot(sampleTerrain(x + 20, z) - sampleTerrain(x - 20, z), sampleTerrain(x, z + 20) - sampleTerrain(x, z - 20)) / 40;
    const goodMeadow = (x, z) => {
      const h = sampleTerrain(x, z);
      return h > 1 && h < 160 && plainK(x, z) > 0.6 && slopeAt(x, z) < 0.12 && forestMask(x, z, h) < 0.2;
    };
    // ---- стада
    const animals = [];
    let herds = 0;
    for (let k = 0; k < 600 && herds < 16; k++) {
      const a = rnd() * 6.28, r = PLANE_HALF + 800 + rnd() * 8000;
      const cx = Math.cos(a) * r, cz = Math.sin(a) * r;
      if (!goodMeadow(cx, cz)) continue;
      herds++;
      const kind = rnd() < 0.65 ? 'cow' : 'horse';
      const n = 5 + Math.floor(rnd() * 7);
      for (let i = 0; i < n; i++) {
        const x = cx + (rnd() - 0.5) * 50, z = cz + (rnd() - 0.5) * 50;
        animals.push({ kind, home: new THREE.Vector3(cx, 0, cz), pos: new THREE.Vector3(x, sampleTerrain(x, z), z), heading: rnd() * 6.28, target: new THREE.Vector3(x, 0, z), timer: rnd() * 8, graze: rnd(), ph: rnd() * 6 });
      }
    }
    this.animals = animals;
    const G = makeGeometries();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
    const count = (k) => Math.max(1, animals.filter((a) => a.kind === k).length);
    this.cows = new THREE.InstancedMesh(G.cow, mat, count('cow'));
    this.horses = new THREE.InstancedMesh(G.horse, mat, count('horse'));
    for (const m of [this.cows, this.horses]) { m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.castShadow = true; m.frustumCulled = false; scene.add(m); }
    let ci = 0, hi = 0;
    const cowCols = [0xffffff, 0x8a4a2a, 0x2a2420, 0xc9a27a];
    const horseCols = [0x6b3e22, 0x3a2418, 0xb08050, 0x1c1714, 0xd8cbb8];
    this.cows.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count('cow') * 3).fill(1), 3);
    this.horses.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count('horse') * 3).fill(1), 3);
    for (const a of animals) {
      if (a.kind === 'cow') { a.mesh = this.cows; a.slot = ci++; this.cows.setColorAt(a.slot, new THREE.Color(cowCols[Math.floor(rnd() * cowCols.length)])); }
      else { a.mesh = this.horses; a.slot = hi++; this.horses.setColorAt(a.slot, new THREE.Color(horseCols[Math.floor(rnd() * horseCols.length)])); }
    }

    // ---- амбары у полей
    const barns = [];
    for (let k = 0; k < 900 && barns.length < 18; k++) {
      const a = rnd() * 6.28, r = 4600 + rnd() * 6000;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (!goodMeadow(x, z) || slopeAt(x, z) > 0.06) continue;
      barns.push(_m.compose(_v.set(x, sampleTerrain(x, z) - 0.3, z), _q.setFromAxisAngle(UP, rnd() * 6.28), _s.setScalar(0.9 + rnd() * 0.4)).clone());
    }
    this.barns = new THREE.InstancedMesh(G.barn, mat, Math.max(1, barns.length));
    barns.forEach((m, i) => this.barns.setMatrixAt(i, m));
    this.barns.castShadow = this.barns.receiveShadow = true;
    scene.add(this.barns);

    // ---- орлы над вершинами
    const peaks = [];
    for (let k = 0; k < 3000 && peaks.length < 5; k++) {
      const a = rnd() * 6.28, r = 7000 + rnd() * 9000;
      const x = Math.cos(a) * r, z = Math.sin(a) * r, h = sampleTerrain(x, z);
      if (h > 1500 && peaks.every((p) => Math.hypot(p.x - x, p.z - z) > 3000)) peaks.push({ x, z, h, r: 250 + rnd() * 250, a: rnd() * 6.28, s: (rnd() < 0.5 ? 1 : -1) * (0.05 + rnd() * 0.04) });
    }
    this.eagles = peaks;
    this.eagleMesh = new THREE.InstancedMesh(G.eagle, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide }), Math.max(1, peaks.length));
    this.eagleMesh.frustumCulled = false;
    this.eagleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.eagleMesh);
  }

  update(dt, cam) {
    this.t += dt;
    // ---- стада (обновляем только близкие)
    const showA = cam.y < 2500;
    this.cows.visible = this.horses.visible = showA;
    if (showA) {
      for (const a of this.animals) {
        const d = Math.hypot(a.pos.x - cam.x, a.pos.z - cam.z);
        if (d > 2200) { a.mesh.setMatrixAt(a.slot, _m.makeScale(0, 0, 0)); continue; }
        a.timer -= dt;
        if (a.timer <= 0) {
          a.timer = 5 + Math.random() * 12;
          a.graze = Math.random() < 0.7 ? 1 : 0;
          const an = Math.random() * 6.28, r = Math.random() * 30;
          a.target.set(a.home.x + Math.cos(an) * r, 0, a.home.z + Math.sin(an) * r);
        }
        const tx = a.target.x - a.pos.x, tz = a.target.z - a.pos.z, td = Math.hypot(tx, tz);
        let moving = false;
        if (!a.graze && td > 0.5) {
          moving = true;
          const h = Math.atan2(tx, tz);
          a.heading += Math.atan2(Math.sin(h - a.heading), Math.cos(h - a.heading)) * Math.min(1, dt * 1.5);
          const sp = a.kind === 'horse' ? 1.4 : 0.8;
          a.pos.x += Math.sin(a.heading) * sp * dt; a.pos.z += Math.cos(a.heading) * sp * dt;
          a.pos.y = sampleTerrain(a.pos.x, a.pos.z);
        }
        // Пасётся: голова к земле (наклон корпуса), иногда поднимает
        a.ph += dt;
        const head = a.graze ? 0.12 + Math.sin(a.ph * 0.7) * 0.04 : 0;
        _e.set(head, a.heading, moving ? Math.sin(a.ph * 4) * 0.03 : 0, 'YXZ');
        a.mesh.setMatrixAt(a.slot, _m.compose(_v.set(a.pos.x, a.pos.y, a.pos.z), _q.setFromEuler(_e), _s.setScalar(1)));
      }
      this.cows.instanceMatrix.needsUpdate = this.horses.instanceMatrix.needsUpdate = true;
    }
    this.barns.visible = cam.y < 6000;
    // ---- орлы: широкие круги над вершиной, крылья слегка «дышат»
    this.eagles.forEach((e, i) => {
      e.a += e.s * dt;
      const x = e.x + Math.cos(e.a) * e.r, z = e.z + Math.sin(e.a) * e.r, y = e.h + 180 + Math.sin(this.t * 0.2 + i) * 30;
      _e.set(0, e.a + (e.s > 0 ? 0 : Math.PI), e.s > 0 ? -0.35 : 0.35, 'YXZ');
      this.eagleMesh.setMatrixAt(i, _m.compose(_v.set(x, y, z), _q.setFromEuler(_e), _s.setScalar(1 + 0.05 * Math.sin(this.t * 1.3 + i))));
    });
    this.eagleMesh.instanceMatrix.needsUpdate = true;
    this.eagleMesh.visible = cam.y < 8000;
  }
}

function makeGeometries() {
  const part = (geo, color) => {
    if (geo.index) geo = geo.toNonIndexed();
    if (geo.attributes.uv) geo.deleteAttribute('uv');
    if (!geo.attributes.normal) geo.computeVertexNormals();
    const n = geo.attributes.position.count, c = new THREE.Color(color), col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return geo;
  };
  const S = (r, sx, sy, sz, x, y, z) => new THREE.SphereGeometry(r, 8, 6).scale(sx, sy, sz).translate(x, y, z);
  const C = (rt, rb, h, x, y, z) => new THREE.CylinderGeometry(rt, rb, h, 6).translate(x, y, z);
  const M = (l) => mergeGeometries(l);
  const legs = (h, r, dx, dz, col) => [[dx, dz], [-dx, dz], [dx, -dz], [-dx, -dz]].map(([x, z]) => part(C(r, r * 0.8, h, x, h / 2, z), col));
  // Корова: массивное тело, голова опущена вперёд, рожки, белые пятна (через окраску)
  const cow = M([
    part(S(0.6, 0.85, 0.75, 1.5, 0, 1.15, 0), 0xffffff), ...legs(0.9, 0.08, 0.3, 0.55, 0xffffff),
    part(S(0.25, 0.8, 0.85, 1.3, 0, 1.05, 1.05), 0xffffff), part(S(0.16, 1, 0.8, 1, 0, 0.98, 1.32), 0xd8b0a0),
    part(C(0.025, 0.04, 0.22, 0.17, 1.3, 1.0).rotateZ(-0.9), 0xe8e0d0), part(C(0.025, 0.04, 0.22, -0.17, 1.3, 1.0).rotateZ(0.9), 0xe8e0d0),
    part(S(0.28, 1.2, 0.6, 1, 0.25, 1.35, -0.2), 0x1a1612), part(S(0.22, 1, 0.7, 1.2, -0.3, 1.1, 0.4), 0x1a1612),
    part(C(0.03, 0.03, 0.7, 0, 0.95, -0.85).rotateX(0.25), 0x2a2420),
  ]);
  // Лошадь: стройное тело, длинная шея, грива, хвост
  const horse = M([
    part(S(0.5, 0.75, 0.75, 1.5, 0, 1.4, 0), 0xffffff), ...legs(1.15, 0.07, 0.24, 0.55, 0xffffff),
    part(C(0.14, 0.2, 0.9, 0, 1.85, 0.75).rotateX(0.6), 0xffffff), part(S(0.18, 0.8, 0.9, 1.6, 0, 2.05, 1.12).rotateX(0.5), 0xffffff),
    part(C(0.04, 0.06, 0.9, 0, 1.95, 0.65).rotateX(0.6).translate(0, 0.08, -0.05), 0x1a1410),
    part(C(0.05, 0.03, 0.9, 0, 1.15, -0.8).rotateX(0.35), 0x1a1410),
  ]);
  // Амбар: красные стены, белые углы, двускатная крыша, ворота
  const barn = M([
    part(new THREE.BoxGeometry(12, 6, 18).translate(0, 3, 0), 0x8e2a22),
    part(new THREE.CylinderGeometry(0.01, 7.2, 3.6, 4, 1).rotateY(Math.PI / 4).scale(1.18, 1, 1.85).translate(0, 7.8, 0), 0x3a3a3c),
    part(new THREE.BoxGeometry(4.5, 4.4, 0.2).translate(0, 2.2, 9.05), 0x6a1e18),
    ...[[-6, -9], [6, -9], [-6, 9], [6, 9]].map(([x, z]) => part(new THREE.BoxGeometry(0.4, 6, 0.4).translate(x, 3, z), 0xf2efe8)),
    part(new THREE.CylinderGeometry(2, 2, 9, 12).translate(9, 4.5, -5), 0xb8bcc2),
  ]);
  // Орёл: тёмные широкие крылья с «пальцами», светлая голова
  const eagle = M([
    part(S(0.25, 0.8, 0.7, 2.2, 0, 0, 0), 0x3a2a1e), part(S(0.13, 1, 1, 1.2, 0, 0.05, 0.6), 0xeeeae0),
    part(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0.35, 0, 0, -0.35, 1.2, 0.08, -0.25, 0, 0, 0.35, 1.2, 0.08, -0.25, 1.15, 0.08, 0.3, 1.15, 0.08, 0.3, 1.2, 0.08, -0.25, 2.1, 0.2, -0.05], 3)), 0x2e2218),
    part(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0.35, -1.2, 0.08, -0.25, 0, 0, -0.35, 0, 0, 0.35, -1.15, 0.08, 0.3, -1.2, 0.08, -0.25, -1.15, 0.08, 0.3, -2.1, 0.2, -0.05, -1.2, 0.08, -0.25], 3)), 0x2e2218),
    part(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.4, 0.3, 0, -0.95, -0.3, 0, -0.95], 3)), 0xeeeae0),
  ]);
  return { cow, horse, barn, eagle };
}
