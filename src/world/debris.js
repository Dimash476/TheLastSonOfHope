import * as THREE from 'three';
import { DEBRIS } from '../config.js';
import { groundHeight } from './layout.js';

const S_NONE = 0, S_FLY = 1, S_REST = 2, S_SINK = 3, S_HELD = 4;

// Пространственный хэш для столкновений обломков между собой
const CELL = 8, TABLE = 1 << 14;
const hashCell = (ix, iz) => ((ix * 73856093) ^ (iz * 19349663)) & (TABLE - 1);

// Обломки: один InstancedMesh на все куски + упрощённая физика:
// гравитация, рельеф, крыши и стены зданий, столкновения кусков друг с другом.
export class Debris {
  constructor(scene, { max = DEBRIS.max, glass = false } = {}) {
    const N = this.max = max;
    this.glass = glass;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    // Стекло — блестящее и отражает небо, бетон — матовый
    const mat = glass
      ? new THREE.MeshStandardMaterial({ roughness: 0.05, metalness: 0.9, envMapIntensity: 1.5 })
      : new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.02 });
    this.mesh = new THREE.InstancedMesh(geo, mat, N);
    this.mesh.castShadow = this.mesh.receiveShadow = true;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    scene.add(this.mesh);

    this.pos = new Float32Array(N * 3);
    this.vel = new Float32Array(N * 3);
    this.rot = new Float32Array(N * 4);
    this.ang = new Float32Array(N * 3);
    this.size = new Float32Array(N * 3);
    this.rad = new Float32Array(N);      // радиус «сферы» для столкновений
    this.delay = new Float32Array(N);
    this.rest = new Float32Array(N);
    this.floorY = new Float32Array(N);
    this.thrown = new Uint8Array(N);     // брошен игроком — бьёт здания сильнее
    this.state = new Uint8Array(N);
    this.next = 0;
    this.high = 0;

    this.head = new Int32Array(TABLE);
    this.link = new Int32Array(N);

    this.city = null;     // задаётся снаружи (для столкновений со зданиями)
    this.onImpact = null; // (point, radius, force) — сбивает людей и машины

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._dq = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._c = new THREE.Color();
    this._zero = new THREE.Matrix4().makeScale(0, 0, 0);
  }

  spawn(x, y, z, sx, sy, sz, vx, vy, vz, color, delay = 0) {
    // Пропускаем занятые игроком куски
    let i = this.next;
    for (let k = 0; k < 8 && this.state[i] === S_HELD; k++) i = (i + 1) % this.max;
    this.next = (i + 1) % this.max;
    if (i + 1 > this.high) { this.high = i + 1; this.mesh.count = this.high; }

    const i3 = i * 3, i4 = i * 4;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.size[i3] = sx; this.size[i3 + 1] = sy; this.size[i3 + 2] = sz;
    this.rad[i] = (sx + sy + sz) / 6;
    const spin = 1 + Math.hypot(vx, vy, vz) * 0.05;
    this.ang[i3] = (Math.random() - 0.5) * spin;
    this.ang[i3 + 1] = (Math.random() - 0.5) * spin;
    this.ang[i3 + 2] = (Math.random() - 0.5) * spin;
    this.rot[i4] = 0; this.rot[i4 + 1] = 0; this.rot[i4 + 2] = 0; this.rot[i4 + 3] = 1;
    this.delay[i] = delay;
    this.rest[i] = 0;
    this.thrown[i] = 0;
    this.state[i] = S_FLY;

    this._c.copy(color).multiplyScalar(this.glass ? 0.9 + Math.random() * 0.2 : 0.6 + Math.random() * 0.35);
    this.mesh.setColorAt(i, this._c);
    this.mesh.instanceColor.needsUpdate = true;
    this.writeMatrix(i);
    return i;
  }

  writeMatrix(i) {
    const i3 = i * 3, i4 = i * 4;
    this._p.set(this.pos[i3], this.pos[i3 + 1], this.pos[i3 + 2]);
    this._q.set(this.rot[i4], this.rot[i4 + 1], this.rot[i4 + 2], this.rot[i4 + 3]);
    this._s.set(this.size[i3], this.size[i3 + 1], this.size[i3 + 2]);
    this._m.compose(this._p, this._q, this._s);
    this.mesh.setMatrixAt(i, this._m);
  }

  wake(i) { if (this.state[i] === S_REST) { this.state[i] = S_FLY; this.rest[i] = 0; } }

  // Ударная волна расталкивает лежащие и летящие обломки
  explode(center, radius, force) {
    const r2 = radius * radius;
    for (let i = 0; i < this.high; i++) {
      const st = this.state[i];
      if (st !== S_FLY && st !== S_REST) continue;
      const i3 = i * 3;
      const dx = this.pos[i3] - center.x, dy = this.pos[i3 + 1] - center.y, dz = this.pos[i3 + 2] - center.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      const d = Math.sqrt(d2) + 0.01;
      const k = 1 - d / radius;
      const f = force * k / d / Math.max(1, this.rad[i] * 0.5);
      this.vel[i3] += dx * f;
      this.vel[i3 + 1] += Math.abs(dy * f) + force * 0.3 * k;
      this.vel[i3 + 2] += dz * f;
      this.delay[i] = 0;
      this.state[i] = S_FLY;
      this.rest[i] = 0;
    }
  }

  // ---------------------------------------------------------------- захват
  findGrabbable(p, range) {
    let best = -1, bestD = range * range;
    for (let i = 0; i < this.high; i++) {
      const st = this.state[i];
      if (st !== S_FLY && st !== S_REST) continue;
      if (this.rad[i] > 4) continue; // слишком большой кусок
      const i3 = i * 3;
      const dx = this.pos[i3] - p.x, dy = this.pos[i3 + 1] - p.y, dz = this.pos[i3 + 2] - p.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestD) { bestD = d2; best = i; }
    }
    return best >= 0 ? { index: best, dist: Math.sqrt(bestD) } : null;
  }

  hold(i) { this.state[i] = S_HELD; this.delay[i] = 0; }

  setHeld(i, p) {
    const i3 = i * 3;
    this.pos[i3] = p.x; this.pos[i3 + 1] = p.y + this.size[i3 + 1] * 0.5; this.pos[i3 + 2] = p.z;
    this.writeMatrix(i);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  throwPiece(i, v) {
    const i3 = i * 3;
    this.vel[i3] = v.x; this.vel[i3 + 1] = v.y; this.vel[i3 + 2] = v.z;
    this.ang[i3] = (Math.random() - 0.5) * 8; this.ang[i3 + 2] = (Math.random() - 0.5) * 8;
    this.state[i] = S_FLY;
    this.thrown[i] = 1;
  }

  heldPos(i, out) { const i3 = i * 3; return out.set(this.pos[i3], this.pos[i3 + 1], this.pos[i3 + 2]); }

  // ---------------------------------------------------------------- физика
  buildHash() {
    this.head.fill(-1);
    for (let i = 0; i < this.high; i++) {
      const st = this.state[i];
      if (st !== S_FLY && st !== S_REST) continue;
      if (st === S_FLY && this.delay[i] > 0) continue;
      const h = hashCell(Math.floor(this.pos[i * 3] / CELL), Math.floor(this.pos[i * 3 + 2] / CELL));
      this.link[i] = this.head[h];
      this.head[h] = i;
    }
  }

  // Возвращает true, если кусок опирается на что-то снизу
  collidePieces(i) {
    const i3 = i * 3, P = this.pos, V = this.vel;
    const x = P[i3], y = P[i3 + 1], z = P[i3 + 2], ri = this.rad[i];
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    let supported = false;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      for (let j = this.head[hashCell(cx + a, cz + b)]; j >= 0; j = this.link[j]) {
        if (j === i) continue;
        const j3 = j * 3;
        const dx = P[i3] - P[j3], dy = P[i3 + 1] - P[j3 + 1], dz = P[i3 + 2] - P[j3 + 2];
        const rr = ri + this.rad[j];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= rr * rr || d2 < 1e-6) continue;
        const d = Math.sqrt(d2), nx = dx / d, ny = dy / d, nz = dz / d;
        const pen = rr - d;
        const otherMoving = this.state[j] === S_FLY;
        const share = otherMoving ? 0.5 : 1;
        P[i3] += nx * pen * share; P[i3 + 1] += ny * pen * share; P[i3 + 2] += nz * pen * share;
        if (otherMoving) { P[j3] -= nx * pen * 0.5; P[j3 + 1] -= ny * pen * 0.5; P[j3 + 2] -= nz * pen * 0.5; }
        // Относительная скорость вдоль нормали
        const rvx = V[i3] - (otherMoving ? V[j3] : 0), rvy = V[i3 + 1] - (otherMoving ? V[j3 + 1] : 0), rvz = V[i3 + 2] - (otherMoving ? V[j3 + 2] : 0);
        const vn = rvx * nx + rvy * ny + rvz * nz;
        if (vn < 0) {
          const imp = -vn * 1.25 * share;
          V[i3] += nx * imp; V[i3 + 1] += ny * imp; V[i3 + 2] += nz * imp;
          if (otherMoving) { V[j3] -= nx * imp; V[j3 + 1] -= ny * imp; V[j3 + 2] -= nz * imp; }
          // Быстрый кусок будит лежащий
          else if (-vn > 8) { this.wake(j); V[j3] -= nx * imp * 0.5; V[j3 + 1] -= ny * imp * 0.3; V[j3 + 2] -= nz * imp * 0.5; }
        }
        if (ny > 0.55) supported = true;
      }
    }
    return supported;
  }

  // Столкновение со зданием: выталкиваем по ближайшей грани
  collideCity(i) {
    const city = this.city;
    if (!city) return false;
    const i3 = i * 3;
    this._p.set(this.pos[i3], this.pos[i3 + 1], this.pos[i3 + 2]);
    const s = city.segAt(this._p, this.rad[i] * 0.6);
    if (!s) return false;
    const r = this.rad[i] * 0.6;
    const px = s.w / 2 + r - Math.abs(this._p.x - s.x);
    const pz = s.d / 2 + r - Math.abs(this._p.z - s.z);
    const pyTop = s.y0 + s.h + r - this._p.y;
    const pyBot = this._p.y - (s.y0 - r);
    const m = Math.min(px, pz, pyTop, pyBot);
    const speed = Math.hypot(this.vel[i3], this.vel[i3 + 1], this.vel[i3 + 2]);
    let landed = false;
    if (m === pyTop) {
      this.pos[i3 + 1] += pyTop; landed = true;
      if (this.vel[i3 + 1] < 0) this.vel[i3 + 1] *= -0.25;
    } else if (m === pyBot) {
      this.pos[i3 + 1] -= pyBot;
      if (this.vel[i3 + 1] > 0) this.vel[i3 + 1] *= -0.3;
    } else if (m === px) {
      const sgn = Math.sign(this._p.x - s.x) || 1;
      this.pos[i3] += sgn * px;
      if (this.vel[i3] * sgn < 0) this.vel[i3] *= -0.3;
    } else {
      const sgn = Math.sign(this._p.z - s.z) || 1;
      this.pos[i3 + 2] += sgn * pz;
      if (this.vel[i3 + 2] * sgn < 0) this.vel[i3 + 2] *= -0.3;
    }
    // Тяжёлый быстрый кусок повреждает здание
    const mass = this.size[i3] * this.size[i3 + 1] * this.size[i3 + 2];
    if (speed > 35 && (mass > 3 || this.thrown[i])) {
      const dir = new THREE.Vector3(this.vel[i3], this.vel[i3 + 1], this.vel[i3 + 2]).normalize();
      const dmg = Math.min(400, speed * Math.cbrt(mass) * (this.thrown[i] ? 3 : 0.6));
      city.damage(s, dmg, this._p.clone(), dir, Math.min(40, speed * 0.3));
      this.vel[i3] *= 0.5; this.vel[i3 + 1] *= 0.5; this.vel[i3 + 2] *= 0.5;
    }
    return landed;
  }

  update(dt) {
    const g = DEBRIS.gravity;
    this.buildHash();
    let dirty = false;
    for (let i = 0; i < this.high; i++) {
      const st = this.state[i];
      if (st === S_NONE || st === S_HELD) continue;
      const i3 = i * 3, i4 = i * 4;

      if (st === S_FLY) {
        if (this.delay[i] > 0) { this.delay[i] -= dt; continue; }
        this.vel[i3 + 1] -= g * dt;
        const drag = 1 - 0.08 * dt;
        this.vel[i3] *= drag; this.vel[i3 + 2] *= drag;
        this.pos[i3] += this.vel[i3] * dt;
        this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
        this.pos[i3 + 2] += this.vel[i3 + 2] * dt;

        this._e.set(this.ang[i3] * dt, this.ang[i3 + 1] * dt, this.ang[i3 + 2] * dt);
        this._dq.setFromEuler(this._e);
        this._q.set(this.rot[i4], this.rot[i4 + 1], this.rot[i4 + 2], this.rot[i4 + 3]).multiply(this._dq);
        this.rot[i4] = this._q.x; this.rot[i4 + 1] = this._q.y; this.rot[i4 + 2] = this._q.z; this.rot[i4 + 3] = this._q.w;

        let support = this.collideCity(i);
        if (this.collidePieces(i)) support = true;

        // Рельеф / дно реки
        const half = Math.min(this.size[i3], this.size[i3 + 1], this.size[i3 + 2]) * 0.5;
        const gy = groundHeight(this.pos[i3], this.pos[i3 + 2]);
        if (this.pos[i3 + 1] < gy + half) {
          const impact = -this.vel[i3 + 1];
          this.pos[i3 + 1] = gy + half;
          if (this.vel[i3 + 1] < 0) this.vel[i3 + 1] *= -0.25;
          support = true;
          if (this.thrown[i] && impact > 30) this.onImpact?.(this._p.set(this.pos[i3], gy, this.pos[i3 + 2]), 6 + this.rad[i] * 2, impact * 0.5);
        }

        if (support) {
          this.vel[i3] *= 0.6; this.vel[i3 + 2] *= 0.6;
          this.ang[i3] *= 0.5; this.ang[i3 + 1] *= 0.5; this.ang[i3 + 2] *= 0.5;
          const sp = Math.abs(this.vel[i3]) + Math.abs(this.vel[i3 + 1]) + Math.abs(this.vel[i3 + 2]);
          if (sp < 1.5) {
            this.state[i] = S_REST; this.rest[i] = 0; this.thrown[i] = 0;
            this.vel[i3] = this.vel[i3 + 1] = this.vel[i3 + 2] = 0;
            this.floorY[i] = gy;
          }
        }
        this.writeMatrix(i);
        dirty = true;
      } else if (st === S_REST) {
        this.rest[i] += dt;
        if (this.rest[i] > DEBRIS.lifetime) this.state[i] = S_SINK;
        // Опора исчезла (например, рухнула крыша) — снова падаем
        else if ((i + Math.floor(this.rest[i] * 4)) % 30 === 0) {
          const below = this._p.set(this.pos[i3], this.pos[i3 + 1] - this.rad[i] - 0.5, this.pos[i3 + 2]);
          if (this.pos[i3 + 1] - this.rad[i] > groundHeight(below.x, below.z) + 1 && !this.city?.segAt(below)) this.wake(i);
        }
      } else if (st === S_SINK) {
        // Медленно уходит под землю и исчезает
        this.pos[i3 + 1] -= dt * 0.6;
        const maxS = Math.max(this.size[i3], this.size[i3 + 1], this.size[i3 + 2]);
        if (this.pos[i3 + 1] < this.floorY[i] - maxS) {
          this.state[i] = S_NONE;
          this.mesh.setMatrixAt(i, this._zero);
        } else this.writeMatrix(i);
        dirty = true;
      }
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear() {
    for (let i = 0; i < this.high; i++) { this.state[i] = S_NONE; this.mesh.setMatrixAt(i, this._zero); }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
