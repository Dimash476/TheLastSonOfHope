import * as THREE from 'three';
import { WORLD } from '../config.js';
import { groundHeight } from './layout.js';

// Глыбы разрушенных гор. Как обломки зданий, только крупные (от 3 до ~80 м) и каменные:
// летят, кувыркаются, бьются о склон, скатываются, раскалываются от сильного удара на части,
// громоздятся друг на друга (столкновения через пространственный хэш), полежав — уходят в осыпь.
// Герой на скорости пробивает глыбу насквозь, удары и взрывы (explode) их расталкивают.

const S_NONE = 0, S_FLY = 1, S_REST = 2, S_SINK = 3;
const MAX = 1200;
const KINDS = 3;                       // три формы глыб, у каждой свой InstancedMesh
const CELL = 64, TABLE = 1 << 12;      // хэш для столкновений глыб между собой
const hashCell = (ix, iz) => ((ix * 73856093) ^ (iz * 19349663)) & (TABLE - 1);
const G = 9.81 * 1.8;                  // чуть сильнее реальной — гора рушится тяжело, а не плывёт
const LIFE = 50;                       // сек лежания, потом глыба уходит в осыпь
const BOUNCE = 0.18, ROLL_DAMP = 2.2;

const STONE = [new THREE.Color(0x6e655c), new THREE.Color(0x585049), new THREE.Color(0x7d7468), new THREE.Color(0x4b4540)];
const SNOW = new THREE.Color(0xe9edf2);

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _dq = new THREE.Quaternion();
const _p = new THREE.Vector3(), _s = new THREE.Vector3(), _a = new THREE.Vector3(), _c = new THREE.Color();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

// Глыба с рваными гранями: икосаэдр с неровным радиусом, срезанный несколькими плоскостями
// (плоские сколы, как у расколотой скалы). Совпадающие вершины смещаем одинаково — без щелей
function rockGeometry(seed) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const ico = new THREE.IcosahedronGeometry(0.5, 1);
  const p = ico.attributes.position, off = new Map();
  const cuts = [];
  for (let k = 0; k < 4; k++) {
    const n = new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
    cuts.push({ n, d: 0.28 + rnd() * 0.14 });
  }
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(4)},${p.getY(i).toFixed(4)},${p.getZ(i).toFixed(4)}`;
    if (!off.has(key)) {
      _p.set(p.getX(i), p.getY(i), p.getZ(i)).multiplyScalar(0.8 + rnd() * 0.4);
      for (const c of cuts) {
        const e = _p.dot(c.n) - c.d;
        if (e > 0) _p.addScaledVector(c.n, -e);
      }
      off.set(key, _p.toArray());
    }
    const o = off.get(key);
    p.setXYZ(i, o[0], o[1], o[2]);
  }
  ico.computeVertexNormals();
  return ico;
}

export class Rocks {
  constructor(scene, world) {
    this.world = world;
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0, flatShading: true });
    this.meshes = [];
    const per = Math.ceil(MAX / KINDS);
    for (let k = 0; k < KINDS; k++) {
      const m = new THREE.InstancedMesh(rockGeometry(7919 * (k + 3)), mat, per);
      m.castShadow = m.receiveShadow = true;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(per * 3), 3);
      m.frustumCulled = false;
      m.count = 0;
      scene.add(m);
      this.meshes.push(m);
    }
    this.pos = new Float32Array(MAX * 3);
    this.vel = new Float32Array(MAX * 3);
    this.rot = new Float32Array(MAX * 4);
    this.ang = new Float32Array(MAX * 3);
    this.size = new Float32Array(MAX * 3);
    this.rad = new Float32Array(MAX);
    this.life = new Float32Array(MAX);
    this.calm = new Float32Array(MAX);   // сколько уже почти не движется
    this.state = new Uint8Array(MAX);
    this.head = new Int32Array(TABLE);
    this.link = new Int32Array(MAX);
    this.next = 0;
    this.high = 0;
    this.live = 0;
    this.fxT = 0;                         // пауза между пылью и грохотом от падений
    this.dirty = new Uint8Array(KINDS);
  }

  // Новая глыба размером s (м); snow — доля снега на ней (0..1)
  spawn(x, y, z, s, vx, vy, vz, snow = 0) {
    let i = this.next;
    // Не затираем ту, что ещё летит: ищем свободную или лежащую
    for (let k = 0; k < 16 && this.state[i] === S_FLY; k++) i = (i + 1) % MAX;
    this.next = (i + 1) % MAX;
    if (i + 1 > this.high) {
      this.high = i + 1;
      for (let k = 0; k < KINDS; k++) this.meshes[k].count = Math.ceil((this.high - k) / KINDS);
    }
    if (this.state[i] === S_NONE) this.live++;
    const i3 = i * 3, i4 = i * 4;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    const sx = s * (0.8 + Math.random() * 0.45), sy = s * (0.55 + Math.random() * 0.45), sz = s * (0.75 + Math.random() * 0.45);
    this.size[i3] = sx; this.size[i3 + 1] = sy; this.size[i3 + 2] = sz;
    this.rad[i] = (sx + sy + sz) / 6;
    const spin = (0.4 + Math.hypot(vx, vy, vz) * 0.02) * 6 / (2 + this.rad[i]);
    this.ang[i3] = (Math.random() - 0.5) * spin; this.ang[i3 + 1] = (Math.random() - 0.5) * spin; this.ang[i3 + 2] = (Math.random() - 0.5) * spin;
    _q.setFromAxisAngle(_a.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(), Math.random() * 6.28);
    this.rot[i4] = _q.x; this.rot[i4 + 1] = _q.y; this.rot[i4 + 2] = _q.z; this.rot[i4 + 3] = _q.w;
    this.life[i] = LIFE * (0.8 + Math.random() * 0.4);
    this.calm[i] = 0;
    this.state[i] = S_FLY;
    _c.copy(STONE[(Math.random() * STONE.length) | 0]).multiplyScalar(0.8 + Math.random() * 0.35);
    if (snow > 0) _c.lerp(SNOW, snow * (0.4 + Math.random() * 0.5));
    const m = this.meshes[i % KINDS];
    m.setColorAt((i / KINDS) | 0, _c);
    m.instanceColor.needsUpdate = true;
    this.write(i);
    return i;
  }

  write(i) {
    const i3 = i * 3, i4 = i * 4, k = i % KINDS;
    _p.set(this.pos[i3], this.pos[i3 + 1], this.pos[i3 + 2]);
    _q.set(this.rot[i4], this.rot[i4 + 1], this.rot[i4 + 2], this.rot[i4 + 3]);
    _s.set(this.size[i3], this.size[i3 + 1], this.size[i3 + 2]);
    this.meshes[k].setMatrixAt((i / KINDS) | 0, _m.compose(_p, _q, _s));
    this.dirty[k] = 1;
  }

  kill(i) {
    this.state[i] = S_NONE;
    this.live--;
    const k = i % KINDS;
    this.meshes[k].setMatrixAt((i / KINDS) | 0, _zero);
    this.dirty[k] = 1;
  }

  // Расколоть глыбу на части, разлетающиеся от точки удара со скоростью v
  shatter(i, vx, vy, vz, push = 1) {
    const i3 = i * 3, r = this.rad[i];
    const x = this.pos[i3], y = this.pos[i3 + 1], z = this.pos[i3 + 2];
    this.kill(i);
    const n = r > 14 ? 4 + ((Math.random() * 3) | 0) : r > 5 ? 3 : 0;
    const s = r * 2 * (n ? 0.62 / Math.cbrt(n / 2) : 0);
    for (let k = 0; k < n; k++) {
      const ox = (Math.random() - 0.5) * r, oy = (Math.random() - 0.3) * r, oz = (Math.random() - 0.5) * r;
      const out = (6 + Math.random() * 18) * push;
      const l = Math.hypot(ox, oy, oz) || 1;
      this.spawn(x + ox, y + oy, z + oz, s * (0.7 + Math.random() * 0.5),
        vx + ox / l * out, vy + Math.abs(oy / l) * out * 0.6 + 4, vz + oz / l * out);
    }
    // Мелочь и пыль — как от обломков зданий
    const W = this.world;
    _c.copy(STONE[1]);
    for (let k = 0; k < Math.min(10, 3 + r); k++) {
      const a = Math.random() * 6.28, q = 0.6 + Math.random() * Math.random() * Math.min(5, r * 0.35);
      W.debris?.spawn(x, y, z, q, q * 0.7, q * 0.8, vx * 0.5 + Math.cos(a) * 15 * push, vy * 0.5 + 6 + Math.random() * 14, vz * 0.5 + Math.sin(a) * 15 * push, _c, 0);
    }
    W.dust?.burst(_p.set(x, y, z).clone(), Math.round(6 + r), { size: [r * 0.6, r * 1.6], speed: 8 + r * 0.6, life: [2, 5], color: 0x8a7e72, gravity: 1.2 });
  }

  // Ударная волна или взрыв расталкивает глыбы; совсем близкие раскалывает
  explode(center, radius, force) {
    const r2 = radius * radius;
    for (let i = 0; i < this.high; i++) {
      const st = this.state[i];
      if (st !== S_FLY && st !== S_REST) continue;
      const i3 = i * 3;
      const dx = this.pos[i3] - center.x, dy = this.pos[i3 + 1] - center.y, dz = this.pos[i3 + 2] - center.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      const d = Math.sqrt(d2) + 0.01, k = 1 - d / radius;
      const f = force * k / Math.max(1, this.rad[i] * 0.35);
      if (f > 60 && this.rad[i] > 5) { this.shatter(i, dx / d * f * 0.5, f * 0.4, dz / d * f * 0.5); continue; }
      this.vel[i3] += dx / d * f; this.vel[i3 + 1] += Math.abs(dy / d) * f + f * 0.3; this.vel[i3 + 2] += dz / d * f;
      this.state[i] = S_FLY;
      this.calm[i] = 0;
    }
  }

  buildHash() {
    this.head.fill(-1);
    for (let i = 0; i < this.high; i++) {
      const st = this.state[i];
      if (st !== S_FLY && st !== S_REST) continue;
      const h = hashCell(Math.floor(this.pos[i * 3] / CELL), Math.floor(this.pos[i * 3 + 2] / CELL));
      this.link[i] = this.head[h];
      this.head[h] = i;
    }
  }

  // Глыбы расталкивают друг друга с учётом массы; true — лежит на другой глыбе
  collide(i) {
    const P = this.pos, V = this.vel, i3 = i * 3, ri = this.rad[i], mi = ri * ri * ri;
    const cx = Math.floor(P[i3] / CELL), cz = Math.floor(P[i3 + 2] / CELL);
    let supported = false;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      for (let j = this.head[hashCell(cx + a, cz + b)]; j >= 0; j = this.link[j]) {
        if (j === i) continue;
        const j3 = j * 3;
        const dx = P[i3] - P[j3], dy = P[i3 + 1] - P[j3 + 1], dz = P[i3 + 2] - P[j3 + 2];
        const rr = (ri + this.rad[j]) * 0.85;      // формы неровные: чуть «вкладываются» друг в друга
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= rr * rr || d2 < 1e-6) continue;
        const d = Math.sqrt(d2), nx = dx / d, ny = dy / d, nz = dz / d, pen = rr - d;
        const rj = this.rad[j], mj = rj * rj * rj;
        const moving = this.state[j] === S_FLY;
        const wi = moving ? mj / (mi + mj) : 1;      // лёгкая уступает тяжёлой
        P[i3] += nx * pen * wi; P[i3 + 1] += ny * pen * wi; P[i3 + 2] += nz * pen * wi;
        if (moving) { const wj = 1 - wi; P[j3] -= nx * pen * wj; P[j3 + 1] -= ny * pen * wj; P[j3 + 2] -= nz * pen * wj; }
        const rvx = V[i3] - (moving ? V[j3] : 0), rvy = V[i3 + 1] - (moving ? V[j3 + 1] : 0), rvz = V[i3 + 2] - (moving ? V[j3 + 2] : 0);
        const vn = rvx * nx + rvy * ny + rvz * nz;
        if (vn < 0) {
          const imp = -vn * 1.2;
          V[i3] += nx * imp * wi; V[i3 + 1] += ny * imp * wi; V[i3 + 2] += nz * imp * wi;
          if (moving) { const wj = 1 - wi; V[j3] -= nx * imp * wj; V[j3 + 1] -= ny * imp * wj; V[j3 + 2] -= nz * imp * wj; }
          // Тяжёлая глыба сдвигает лежащую
          else if (-vn > 6 && mi > mj * 0.3) { this.state[j] = S_FLY; this.calm[j] = 0; V[j3] -= nx * imp * 0.4; V[j3 + 2] -= nz * imp * 0.4; }
        }
        if (ny > 0.5) supported = true;
      }
    }
    return supported;
  }

  // Удар о склон: звук и пыль (не чаще ~8 раз в секунду), сильный — раскалывает
  land(i, speed) {
    const r = this.rad[i];
    if (speed > 48 && r > 6) { const i3 = i * 3; this.shatter(i, this.vel[i3] * 0.5, Math.abs(this.vel[i3 + 1]) * 0.25, this.vel[i3 + 2] * 0.5, 0.8); return true; }
    if (speed > 14 && r > 4 && this.fxT <= 0) {
      this.fxT = 0.12;
      const i3 = i * 3, W = this.world;
      _p.set(this.pos[i3], this.pos[i3 + 1] - r * 0.6, this.pos[i3 + 2]);
      W.dust?.burst(_p.clone(), Math.round(4 + r * 0.4), { size: [r * 0.5, r * 1.4], speed: 4 + speed * 0.15, life: [2, 5], color: 0x8a7e72, gravity: 1 });
      if (r > 9) W.audio?.crumble(Math.min(1, 0.3 + r * 0.02 + speed * 0.005), 'concrete', _p.clone());
    }
    return false;
  }

  update(dt, player) {
    if (!this.live) return;
    this.fxT -= dt;
    this.buildHash();
    const P = this.pos, V = this.vel;
    const hp = player?.pos, hv = player?.vel, hs = hv ? hv.length() : 0;
    for (let i = 0; i < this.high; i++) {
      const st = this.state[i];
      if (st === S_NONE) continue;
      const i3 = i * 3, i4 = i * 4, r = this.rad[i];

      if (st === S_SINK) {
        P[i3 + 1] -= (1.5 + r * 0.08) * dt;
        if (P[i3 + 1] < groundHeight(P[i3], P[i3 + 2]) - r * 1.2) { this.kill(i); continue; }
        this.write(i);
        continue;
      }

      // Герой на скорости проходит сквозь глыбу, она разлетается по его ходу
      if (hp && hs > 40) {
        const dx = P[i3] - hp.x, dy = P[i3 + 1] - hp.y, dz = P[i3 + 2] - hp.z, R = r + 3;
        if (dx * dx + dy * dy + dz * dz < R * R) {
          const k = Math.min(0.6, 25 / hs + 0.15);
          this.shatter(i, hv.x * k, hv.y * k + 5, hv.z * k, 1.4);
          continue;
        }
      }

      if (st === S_REST) {
        this.life[i] -= dt;
        if (this.life[i] <= 0) this.state[i] = S_SINK;
        // Земля под лежащей глыбой могла уйти (обрушение) — снова падает
        else if (groundHeight(P[i3], P[i3 + 2]) < P[i3 + 1] - r * 1.4 && !this.collide(i)) this.state[i] = S_FLY;
        continue;
      }

      V[i3 + 1] -= G * dt;
      const drag = 1 - 0.03 * dt;
      V[i3] *= drag; V[i3 + 1] *= drag; V[i3 + 2] *= drag;
      P[i3] += V[i3] * dt; P[i3 + 1] += V[i3 + 1] * dt; P[i3 + 2] += V[i3 + 2] * dt;

      // Склон: выталкиваем по нормали рельефа, отскок слабый, вдоль склона — катится и тормозит
      const x = P[i3], z = P[i3 + 2], gy = groundHeight(x, z), foot = r * 0.7;
      let contact = false;
      if (P[i3 + 1] - foot < gy) {
        const e = Math.max(4, r);
        let nx = -(groundHeight(x + e, z) - groundHeight(x - e, z)) / (2 * e), nz = -(groundHeight(x, z + e) - groundHeight(x, z - e)) / (2 * e);
        const l = Math.hypot(nx, 1, nz), ny = 1 / l;
        nx /= l; nz /= l;
        P[i3 + 1] = gy + foot;
        const vn = V[i3] * nx + V[i3 + 1] * ny + V[i3 + 2] * nz;
        if (vn < 0) {
          if (this.land(i, -vn)) continue;
          const j = -(1 + BOUNCE) * vn;
          V[i3] += nx * j; V[i3 + 1] += ny * j; V[i3 + 2] += nz * j;
        }
        const damp = Math.max(0, 1 - ROLL_DAMP * dt * (0.5 + ny));
        V[i3] *= damp; V[i3 + 2] *= damp; if (V[i3 + 1] > 0) V[i3 + 1] *= damp;
        // Вращение как у катящегося камня: ось = нормаль × скорость
        const w = 1 / Math.max(1, r);
        this.ang[i3] = (ny * V[i3 + 2] - nz * V[i3 + 1]) * w;
        this.ang[i3 + 1] *= 0.9;
        this.ang[i3 + 2] = (nx * V[i3 + 1] - ny * V[i3]) * w;
        contact = ny > 0.62;      // на крутой стене не задерживается — скатывается
      }
      if (P[i3 + 1] < WORLD.waterLevel - r) { this.state[i] = S_SINK; continue; }
      const onRock = this.collide(i);

      _a.set(this.ang[i3] * dt, this.ang[i3 + 1] * dt, this.ang[i3 + 2] * dt);
      const ang = _a.length();
      if (ang > 1e-5) {
        _dq.setFromAxisAngle(_a.divideScalar(ang), ang);
        _q.set(this.rot[i4], this.rot[i4 + 1], this.rot[i4 + 2], this.rot[i4 + 3]).premultiply(_dq);
        this.rot[i4] = _q.x; this.rot[i4 + 1] = _q.y; this.rot[i4 + 2] = _q.z; this.rot[i4 + 3] = _q.w;
      }

      const sp = Math.hypot(V[i3], V[i3 + 1], V[i3 + 2]);
      if ((contact || onRock) && sp < 4) {
        this.calm[i] += dt;
        if (this.calm[i] > 0.4) { this.state[i] = S_REST; V[i3] = V[i3 + 1] = V[i3 + 2] = 0; }
      } else this.calm[i] = 0;
      this.write(i);
    }
    for (let k = 0; k < KINDS; k++) if (this.dirty[k]) { this.meshes[k].instanceMatrix.needsUpdate = true; this.dirty[k] = 0; }
  }

  reset() {
    for (let i = 0; i < this.high; i++) if (this.state[i] !== S_NONE) this.kill(i);
    for (let k = 0; k < KINDS; k++) { this.meshes[k].instanceMatrix.needsUpdate = true; this.dirty[k] = 0; }
    this.live = 0;
  }
}
