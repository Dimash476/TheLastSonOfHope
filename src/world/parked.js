import * as THREE from 'three';
import { CITY } from '../config.js';
import { BLOCK, HALF, blockTypes, blockZones, groundHeight, roadCut } from './layout.js';
import { VEHICLE_TYPES, createVehicleMaterial } from './vehicles.js';

// Припаркованные машины Сарыдалы: ряды парковки вдоль бульваров проспектов и машины
// у дворовых проездов микрорайонов. Мест десятки тысяч, поэтому рисуются только ближайшие
// к камере (пул по видам машин). От ударов машины переворачиваются и сгорают; K чинит.

const R = 360;          // радиус показа, м
const CELL = 200;       // ячейка поиска мест
const POOL = 360;       // экземпляров на вид машины
const KINDS = ['sedan', 'hatch', 'suv', 'van'];

const hash = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1), _c = new THREE.Color();

export class ParkedCars {
  constructor(scene, world) {
    this.world = world;
    this.slots = [];    // { x, z, yaw, kind, color }
    this.cells = new Map();
    this.hurt = new Map();   // номер места → { roll, pitch, burnt }
    this.build();
    const types = KINDS.map((n) => VEHICLE_TYPES.find((t) => t.name === n));
    const mat = createVehicleMaterial(world.traffic.uNight);
    this.meshes = types.map((t) => {
      const m = new THREE.InstancedMesh(t.geo(), mat, POOL);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.setColorAt(0, _c.set(0xffffff));
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = false;
      scene.add(m);
      return m;
    });
    this.types = types;
    this.last = new THREE.Vector3(1e9, 0, 1e9);
    this.dirty = true;
  }

  place(x, z, yaw, k1, k2, chance) {
    if (hash(k1, k2) > chance) return;
    const r = hash(k2 + 7.3, k1 - 3.1), kind = r < 0.42 ? 0 : r < 0.66 ? 1 : r < 0.9 ? 2 : 3;
    const cols = VEHICLE_TYPES.find((t) => t.name === KINDS[kind]).colors;
    const slot = { x, z, yaw: yaw + (hash(k1 * 3.1, k2) - 0.5) * 0.08, kind, color: cols[Math.floor(hash(k1, k2 * 1.7) * cols.length)] };
    const key = Math.floor(x / CELL) * 100000 + Math.floor(z / CELL);
    if (!this.cells.has(key)) this.cells.set(key, []);
    this.cells.get(key).push(this.slots.length);
    this.slots.push(slot);
  }

  build() {
    const g = CITY.grid, B = CITY.block;
    for (let i = 0; i < g; i++) for (let j = 0; j < g; j++) {
      const type = blockTypes[j * g + i], zone = blockZones[j * g + i];
      const cx = -HALF + (i + 0.5) * B, cz = -HALF + (j + 0.5) * B;
      if (type === BLOCK.AVENUE && (zone === 1 || zone === 2)) {
        // Ряд парковки 15,5–20,5 м от оси бульвара, машины носом к газону; места по 2,7 м
        const alongZ = zone === 1, c0 = alongZ ? cz : cx;
        for (let k = Math.ceil((c0 - 37) / 2.7); 2.7 * k + 1.215 < c0 + 36; k++) {
          const t = 2.7 * k + 1.215;
          for (const s of [-1, 1]) {
            const yaw = (alongZ ? Math.PI / 2 : 0) + (s > 0 ? 0 : Math.PI);
            if (alongZ) this.place(cx + s * 18, t, yaw, t, cx + s, 0.62);
            else this.place(t, cz + s * 18, yaw, cz + s, t, 0.62);
          }
        }
      } else if (type === BLOCK.YARD) {
        // Вдоль дворового проезда-кольца (33,5 м от центра квартала), параллельно
        for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (roadCut(i, j, i + ax, j + az)) continue;   // внутри суперквартала проезда нет
          for (let t = -25; t <= 25; t += 5.8) {
            const x = cx + ax * 33.5 + az * t, z = cz + az * 33.5 + ax * t;
            this.place(x, z, ax !== 0 ? 0 : Math.PI / 2, x * 0.37, z * 0.53, 0.32);
          }
        }
      }
    }
  }

  impulse(point, radius, force) {
    const r = radius + 3;
    for (let cx = Math.floor((point.x - r) / CELL); cx <= Math.floor((point.x + r) / CELL); cx++) {
      for (let cz = Math.floor((point.z - r) / CELL); cz <= Math.floor((point.z + r) / CELL); cz++) {
        const list = this.cells.get(cx * 100000 + cz);
        if (!list) continue;
        for (const n of list) {
          const s = this.slots[n];
          const d = Math.hypot(s.x - point.x, s.z - point.z);
          if (d > r || this.hurt.has(n)) continue;
          const k = 1 - d / r;
          // Слабый удар — только помятые и сдвинутые, сильный — на боку или на крыше и сгоревшие
          const hard = force * k > 25;
          this.hurt.set(n, { roll: hard ? (Math.random() < 0.5 ? Math.PI / 2 : Math.PI) * Math.sign(Math.random() - 0.5) : (Math.random() - 0.5) * 0.3, yaw: (Math.random() - 0.5) * 1.2, burnt: hard });
          this.dirty = true;
        }
      }
    }
  }

  reset() { this.hurt.clear(); this.dirty = true; }

  update(focus) {
    if (!this.dirty && Math.hypot(focus.x - this.last.x, focus.z - this.last.z) < 25) return;
    this.dirty = false;
    this.last.copy(focus);
    const cnt = [0, 0, 0, 0];
    // Высоко над городом машины не различить — не рисуем
    if (focus.y - groundHeight(focus.x, focus.z) < 600) {
      for (let cx = Math.floor((focus.x - R) / CELL); cx <= Math.floor((focus.x + R) / CELL); cx++) {
        for (let cz = Math.floor((focus.z - R) / CELL); cz <= Math.floor((focus.z + R) / CELL); cz++) {
          const list = this.cells.get(cx * 100000 + cz);
          if (!list) continue;
          for (const n of list) {
            const s = this.slots[n];
            if (cnt[s.kind] >= POOL || Math.hypot(s.x - focus.x, s.z - focus.z) > R) continue;
            const h = this.hurt.get(n);
            _e.set(0, s.yaw + (h ? h.yaw : 0), h ? h.roll : 0, 'YXZ');
            const up = h && Math.abs(h.roll) > 1 ? (Math.abs(h.roll) > 2 ? 1.5 : 0.95) : 0;
            _m.compose(_v.set(s.x, groundHeight(s.x, s.z) + up, s.z), _q.setFromEuler(_e), _s);
            const m = this.meshes[s.kind], idx = cnt[s.kind]++;
            m.setMatrixAt(idx, _m);
            m.setColorAt(idx, h && h.burnt ? _c.set(0x141210) : _c.set(s.color));
          }
        }
      }
    }
    this.meshes.forEach((m, k) => {
      m.count = cnt[k];
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    });
  }
}
