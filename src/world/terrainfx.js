import * as THREE from 'three';
import { WORLD } from '../config.js';
import { TERRAIN_RES, TERRAIN_TILE, terrainHeights, PLANE_HALF, islandHeight, terrainBaseRaw } from './layout.js';

// Разрушаемые горы вокруг города. Рельеф — общая сетка высот (по ней считают физика, глыбы,
// деревья) и плитки environment.terrain с теми же вершинами. Гора ломается как здание:
//   ram     — герой (или брошенный генерал) на таранной скорости врезается в склон: всё, что
//             на его пути и над ним, теряет опору и разваливается на глыбы (rocks.js);
//   collapse — затем по краям пролома склон, ставший слишком крутым, осыпается волной:
//             ячейка за ячейкой, с задержкой, новые глыбы катятся вниз в пролом;
//   crater  — удар о землю с пике: чаша, глыбы летят из неё во все стороны.
// Деревья не ломаются: уходят вместе со склоном. Город и райский остров не трогаем.
// Сброс (K, новый бой) — reset().

const N = TERRAIN_RES, W1 = N + 1, SIZE = WORLD.terrainSize, CELL = SIZE / N;
const RAM_R = 190;          // полуширина пролома, м: ровно настолько, чтобы ячейки под героем
                            // целиком ушли ниже него (иначе склон между вершинами вытолкнет вверх)
const CLEAR = 30;           // дно пролома ниже героя на столько, м (плюс рваные выступы вниз)
const TALUS = 1.15;         // крутизна, при которой край пролома держится (перепад на метр)
const COLLAPSE_R = 900;     // дальше от места удара склон не осыпается
const ROCK_BUDGET = 70;     // глыб за кадр (остальной объём — пыль)
const FRESH = new THREE.Color(0x5b5047);   // свежий скол: бурый камень

const _p = new THREE.Vector3(), _d = new THREE.Vector3(), _c = new THREE.Color();
const ss = THREE.MathUtils.smoothstep;
const hash = (i, j) => { let h = (i * 374761393 + j * 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

export class TerrainFX {
  constructor(world, env) {
    this.world = world;
    this.env = env;
    this.H = terrainHeights;
    this.orig = terrainHeights.slice();
    // Земля без гор под каждой ячейкой (считается по мере надобности): ниже неё не ломаем
    this.base = new Float32Array(terrainHeights.length).fill(NaN);
    this.data = env.terrainData;
    this.origCol = this.data.colors.slice();
    this.origFarm = this.data.farm.slice();
    this.origMeadow = this.data.meadow.slice();
    this.tiles = env.terrain.tiles;
    this.nT = N / TERRAIN_TILE;
    this.dirty = null;       // прямоугольник изменённых вершин за кадр: [i0, j0, i1, j1]
    this.touched = false;    // было ли что-то сломано (для reset)
    this.fxT = 0;            // пауза между облаками пыли и грохотом при таране
    this.queue = [];         // осыпь: { i, j, t, ox, oz } — ячейка проверит соседей через t с
    this.budget = ROCK_BUDGET;
    this.flow = new THREE.Vector3();   // куда летят глыбы от тарана (скорость героя)
  }

  // Горы — там, где земля берётся из сетки высот (вне города и острова)
  isMountain(x, z) {
    if (Math.abs(x) < PLANE_HALF && Math.abs(z) < PLANE_HALF) return false;
    if (Math.abs(x) > SIZE / 2 - CELL || Math.abs(z) > SIZE / 2 - CELL) return false;
    return islandHeight(x, z) === null;
  }
  // Высота земли без гор в узле сетки: луга, холмы и степь не ломаются
  baseAt(i, j) {
    const k = j * W1 + i;
    let b = this.base[k];
    if (b !== b) b = this.base[k] = Math.max(WORLD.riverBed, terrainBaseRaw(this.cellX(i), this.cellZ(j)) + 2);
    return b;
  }
  // Есть ли в узле гора над землёй (хотя бы пара метров камня)
  rockAbove(i, j) { return this.H[j * W1 + i] > this.baseAt(i, j) + 2; }
  cellX(i) { return -SIZE / 2 + i * CELL; }
  cellZ(j) { return -SIZE / 2 + j * CELL; }

  // Таран: путь p0 → p1 за кадр. Где склон на пути — гора над героем и перед ним разваливается.
  // Возвращает true, если что-то обрушилось (тогда земля под героем уже ниже)
  ram(p0, p1, speed, k = 1) {
    _d.subVectors(p1, p0);
    const len = _d.length();
    // Немного вперёд по ходу: голову и того, кого герой несёт перед собой, тоже пропускаем
    const lead = Math.min(40, 6 + speed * 0.02);
    const total = len + lead;
    const steps = Math.min(64, Math.max(1, Math.ceil(total / (CELL * 0.5))));
    if (len > 1e-6) _d.divideScalar(len); else _d.set(0, 0, 0);
    // Глыбы летят по ходу тарана, но не со скоростью героя: гора тяжёлая
    this.flow.copy(_d).multiplyScalar(Math.min(70, 15 + speed * 0.08));
    let cut = 0;
    for (let s = 0; s <= steps; s++) {
      _p.copy(p0).addScaledVector(_d, total * s / steps);
      if (!this.isMountain(_p.x, _p.z)) continue;
      if (!this.rockAbove(Math.round((_p.x + SIZE / 2) / CELL), Math.round((_p.z + SIZE / 2) / CELL))) continue;
      // Ломаем, только если склон на пути (выше ног), а не когда просто летим низко над ним
      if (this.heightAt(_p.x, _p.z) <= _p.y - 1) continue;
      const floor = _p.y - CLEAR * k;
      // Дно рваное: выступы только вниз, чтобы герой не цеплялся
      cut += this.carve(_p.x, _p.z, RAM_R, (d, i, j) => floor - hash(i, j) * 35 - d * 25, 0.8, 'ram');
    }
    if (cut > 0) this.ramFX(p1, cut, speed);
    return cut > 0;
  }

  // Воронка: чаша глубиной depth и радиусом r вокруг точки удара, глыбы — из неё во все стороны
  crater(point, r, depth) {
    if (!this.isMountain(point.x, point.z)) return false;
    if (!this.rockAbove(Math.round((point.x + SIZE / 2) / CELL), Math.round((point.z + SIZE / 2) / CELL))) return false;
    const h0 = Math.min(point.y, this.heightAt(point.x, point.z));
    this.flow.set(0, 0, 0);
    const cut = this.carve(point.x, point.z, r, (d, i, j) => h0 - depth * (1 - d * d) - hash(i, j) * 8, 0, 'crater', point);
    if (cut <= 0) return false;
    this.burst(point, Math.min(1, cut / 2e4 + 0.4));
    this.world.audio?.crumble(1, 'concrete', point.clone());
    this.world.audio?.boom(0.8, point.clone());
    return true;
  }

  // Срезать вершины в радиусе r до высоты target(d, i, j) (d — доля радиуса); от доли edge к краю
  // стенка плавно уходит к прежней высоте. Срезанное становится глыбами, края — в очередь осыпи.
  // Возвращает срезанный объём (условно, м·ячейка)
  carve(x, z, r, target, edge, kind, center) {
    const H = this.H;
    const fi = (x + SIZE / 2) / CELL, fj = (z + SIZE / 2) / CELL, rc = r / CELL;
    const i0 = Math.max(1, Math.floor(fi - rc)), i1 = Math.min(N - 1, Math.ceil(fi + rc));
    const j0 = Math.max(1, Math.floor(fj - rc)), j1 = Math.min(N - 1, Math.ceil(fj + rc));
    let cut = 0;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const d = Math.hypot(i - fi, j - fj) / rc;
        if (d >= 1) continue;
        const k = j * W1 + i, h = H[k];
        const t = target(d, i, j);
        const want = edge > 0 ? t + (h - t) * ss(d, edge, 1) : t;
        if (want >= h - 0.01) continue;
        const nh = Math.max(want, this.baseAt(i, j));
        if (nh >= h - 0.01) continue;
        cut += h - nh;
        H[k] = nh;
        this.mark(i, j);
        this.crumble(i, j, nh, h, kind, center);
        this.queue.push({ i, j, t: 0.05 + Math.random() * 0.1, ox: i, oz: j });
      }
    }
    if (cut > 0) {
      this.touched = true;
      this.world.trees?.bury(x, z, r + CELL, (a, b) => this.heightAt(a, b));
    }
    return cut;
  }

  // Столб камня от nh до h над ячейкой теряет опору и разваливается на глыбы
  crumble(i, j, nh, h, kind, center) {
    const dh = h - nh;
    if (dh < 3) return;
    const R = this.world.rocks;
    const x = this.cellX(i), z = this.cellZ(j);
    const snow = ss(h, 3300, 4200);
    if (!R || this.budget <= 0) return;
    const n = Math.min(this.budget, Math.min(5, Math.ceil(dh / 70)));
    this.budget -= n;
    const s = Math.min(75, Math.max(5, dh / n * 0.5));
    for (let m = 0; m < n; m++) {
      const y = nh + dh * (m + 0.3 + Math.random() * 0.4) / n;
      const px = x + (Math.random() - 0.5) * CELL * 0.8, pz = z + (Math.random() - 0.5) * CELL * 0.8;
      let vx, vy, vz;
      if (kind === 'crater') {
        const ox = px - center.x, oz = pz - center.z, l = Math.hypot(ox, oz) || 1, f = 20 + Math.random() * 35;
        vx = ox / l * f; vy = 25 + Math.random() * 45; vz = oz / l * f;
      } else if (kind === 'ram') {
        // По ходу тарана и в стороны от пролома; верх столба почти сразу падает
        vx = this.flow.x * (0.4 + Math.random() * 0.7) + (Math.random() - 0.5) * 30;
        vy = this.flow.y * 0.3 + (Math.random() - 0.3) * 18;
        vz = this.flow.z * (0.4 + Math.random() * 0.7) + (Math.random() - 0.5) * 30;
      } else {
        // Осыпь: съезжает с края в пролом
        vx = (Math.random() - 0.5) * 10; vy = -2 - Math.random() * 6; vz = (Math.random() - 0.5) * 10;
      }
      R.spawn(px, y, pz, s * (0.65 + Math.random() * 0.6), vx, vy, vz, snow);
    }
  }

  // Осыпь краёв: ячейка, рядом с которой земля ушла вниз, держится, только пока перепад
  // не круче TALUS; иначе обрушивается до допустимого и тянет за собой соседей
  collapse(dt) {
    const Q = this.queue, H = this.H;
    if (!Q.length) return;
    let n = 0;
    const keep = [];
    for (let q = 0; q < Q.length; q++) {
      const c = Q[q];
      c.t -= dt;
      if (c.t > 0 || n > 260) { keep.push(c); continue; }
      n++;
      const hc = H[c.j * W1 + c.i];
      for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
        if (!a && !b) continue;
        const i = c.i + a, j = c.j + b;
        if (i < 1 || j < 1 || i > N - 1 || j > N - 1) continue;
        if (Math.hypot(i - c.ox, j - c.oz) * CELL > COLLAPSE_R) continue;
        const k = j * W1 + i, h = H[k];
        const lim = hc + TALUS * CELL * Math.hypot(a, b) * (0.85 + hash(i, j) * 0.3);
        if (h <= lim + 2) continue;
        if (!this.isMountain(this.cellX(i), this.cellZ(j))) continue;
        const nl = Math.max(lim, this.baseAt(i, j));
        if (h <= nl + 2) continue;
        H[k] = nl;
        this.mark(i, j);
        this.crumble(i, j, nl, h, 'slide');
        this.touched = true;
        // Волна идёт дальше не сразу: склон рушится на глазах, а не за один кадр
        keep.push({ i, j, t: 0.08 + Math.random() * 0.22, ox: c.ox, oz: c.oz });
        if (this.fxT <= 0 && h - lim > 25) {
          this.fxT = 0.18;
          const x = this.cellX(i), z = this.cellZ(j);
          _p.set(x, lim + (h - lim) * 0.5, z);
          this.world.dust?.burst(_p.clone(), 16, { size: [25, 70], speed: 14, life: [3, 7], color: 0x857a6e, gravity: 0.8 });
          this.world.audio?.crumble(0.7, 'concrete', _p.clone());
          this.world.trees?.bury(x, z, CELL * 1.5, (u, v) => this.heightAt(u, v));
        }
      }
    }
    this.queue = keep;
  }

  mark(i, j) {
    const D = this.dirty;
    if (!D) this.dirty = [i, j, i, j];
    else { D[0] = Math.min(D[0], i); D[1] = Math.min(D[1], j); D[2] = Math.max(D[2], i); D[3] = Math.max(D[3], j); }
  }

  // Та же триангуляция, что у сетки (как sampleTerrain), но без города
  heightAt(x, z) {
    const fx = Math.min(N - 0.001, Math.max(0, (x / SIZE + 0.5) * N)), fz = Math.min(N - 0.001, Math.max(0, (z / SIZE + 0.5) * N));
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j, A = this.H;
    const h00 = A[j * W1 + i], h10 = A[j * W1 + i + 1], h01 = A[(j + 1) * W1 + i], h11 = A[(j + 1) * W1 + i + 1];
    return u + v <= 1 ? h00 + (h10 - h00) * u + (h01 - h00) * v : h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
  }

  // Пыль и грохот там, где герой проламывается; не чаще ~12 раз в секунду
  ramFX(p, cut, speed) {
    if (this.fxT > 0) return;
    this.fxT = 0.08;
    const k = Math.min(1, cut / 2e4 + 0.35);
    this.burst(p, k);
    const A = this.world.audio;
    if (A) { A.crumble(0.6 + 0.4 * k, 'concrete', p.clone()); if (Math.random() < 0.4) A.boom(0.5 + 0.4 * k, p.clone()); }
    this.world.effects?.impactFX(0.25 + 0.3 * k, p, 0.1, 2 * k);
  }

  burst(p, k) {
    const W = this.world;
    W.dust?.burst(p.clone(), Math.round(16 + 30 * k), { size: [14, 40 + 50 * k], speed: 20 + 40 * k, life: [3, 7], color: 0x7d7064, gravity: 1.2 });
    W.effects?.shockwave(p.clone(), { type: 'ring', radius: 70 + 140 * k, life: 0.8, opacity: 0.45, color: 0xcbbfa8 });
  }

  // Раз в кадр: осыпь, затем изменения — в задетые плитки (высоты, нормали, цвет свежего скола)
  update(dt) {
    this.fxT -= dt;
    this.budget = ROCK_BUDGET;
    this.collapse(dt);
    const D = this.dirty;
    if (!D) return;
    this.dirty = null;
    const C = this.data.colors, F = this.data.farm, M = this.data.meadow, H = this.H;
    const i0 = Math.max(0, D[0] - 1), j0 = Math.max(0, D[1] - 1), i1 = Math.min(N, D[2] + 1), j1 = Math.min(N, D[3] + 1);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * W1 + i;
        // Чем глубже срезано, тем больше голого камня: ни травы, ни полей, ни снега
        const fresh = ss(this.orig[k] - H[k], 2, 40);
        if (fresh <= 0) continue;
        _c.setRGB(this.origCol[k * 3], this.origCol[k * 3 + 1], this.origCol[k * 3 + 2]).lerp(FRESH, fresh * 0.9);
        C[k * 3] = _c.r; C[k * 3 + 1] = _c.g; C[k * 3 + 2] = _c.b;
        F[k] = this.origFarm[k] * (1 - fresh); M[k] = this.origMeadow[k] * (1 - fresh);
      }
    }
    this.refresh(i0, j0, i1, j1);
  }

  // Перенести прямоугольник вершин в плитки, которые он задевает (вершины на стыке есть у обеих)
  refresh(i0, j0, i1, j1) {
    const T = TERRAIN_TILE;
    const ta0 = Math.max(0, Math.floor((i0 - 1) / T)), ta1 = Math.min(this.nT - 1, Math.floor(i1 / T));
    const tb0 = Math.max(0, Math.floor((j0 - 1) / T)), tb1 = Math.min(this.nT - 1, Math.floor(j1 / T));
    for (let tb = tb0; tb <= tb1; tb++) for (let ta = ta0; ta <= ta1; ta++) {
      const tile = this.tiles[tb * this.nT + ta], u = tile.userData;
      const a0 = Math.max(0, i0 - u.i0), a1 = Math.min(T, i1 - u.i0), b0 = Math.max(0, j0 - u.j0), b1 = Math.min(T, j1 - u.j0);
      if (a0 > a1 || b0 > b1) continue;
      this.env.refreshTerrainTile(tile, a0, b0, a1, b1);
      tile.geometry.computeBoundingSphere();
    }
  }

  // Горы как были
  reset() {
    this.queue.length = 0;
    this.world.rocks?.reset();
    if (!this.touched) return;
    this.touched = false;
    this.H.set(this.orig);
    this.data.colors.set(this.origCol);
    this.data.farm.set(this.origFarm);
    this.data.meadow.set(this.origMeadow);
    this.dirty = null;
    this.refresh(0, 0, N, N);
  }
}
