import * as THREE from 'three';
import { CITY, WORLD, DEBRIS } from '../config.js';
import { mulberry32, clamp, lerp } from '../utils.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeShapeGeometries, createShapeMaterial, addGeometricBlock, addMegaLandmark, addTvTower } from './landmarks.js';
import { MEGA_SITES, DISTRICTS, inSleeper, inCampus } from './layout.js';
import { BLOCK, HALF, blockTypes, isBridgeRoad, RIVER_Z, RIVER_HALF_W, TOWNS, groundHeight, skylineAt, inOldTown, LANDMARK, QUAY_X, blockAt, BEACH, PIER, pierDeckY, beachHeight } from './layout.js';

const PALETTE = [
  0xc9bba3, 0xb5a58c, 0xd8d2c4, // бетон / песчаник
  0x8f9aa6, 0x6f7f91,           // серые
  0x7d93ad, 0x5a7896, 0x40566e, // стеклянные синие
  0x9c5b45, 0x8a4f3c,           // кирпич
  0xe8e4dc,                     // белый
];
const GLASS = new Set([0x7d93ad, 0x5a7896, 0x40566e]);
const HOUSE_PALETTE = [0xe9dcc4, 0xd7c3a3, 0xc9d3d8, 0xe6d2b5, 0xb9c4a8, 0xd9b8a0, 0xf0ece4];
const ROOF_PALETTE = [0x7a3b2e, 0x5d4a3f, 0x3e464f, 0x6b5a4a, 0x8a4a36];
const OLD_PALETTE = [0x9c5b45, 0x8a4f3c, 0xa86a50, 0x7e4636, 0x94503a, 0xc9bba3, 0xd6c6a6];
const WAREHOUSE_PALETTE = [0x9a9890, 0xb3ada0, 0x7f8a91, 0xa49a86, 0x8c8f88, 0x6f7a72];
const CONTAINER_PALETTE = [0xa8402e, 0x2f5f8f, 0xc77a2a, 0x3d7a4a, 0xd8d4c8, 0x8a2f2a, 0x4a6b7d, 0xb59a3a];
// Панельные дома (пастель), штукатурка домов среднего пояса, кирпич и песчаник кампуса
const PANEL_PALETTE = [0xd9d2c3, 0xcfd3d6, 0xe3cdb4, 0xbfcab9, 0xd8d8d0, 0xc9bfd0, 0xe6dcc0];
const STUCCO_PALETTE = [0xd9c7a8, 0xc9b49a, 0xe3d9c6, 0xb7a58e, 0xcfc4b3, 0xa9b4b9, 0xd6b8a0, 0xbfae95];
const CAMPUS_PALETTE = [0x9c5b45, 0x8a4f3c, 0xa86a50, 0xd6c6a6, 0xc9b48f];

const CELL = 50;  // ячейка пространственной сетки
const CHUNK = 600;  // участок, рисуемый одним вызовом на материал (крупнее — меньше вызовов)
const ATTACH_CHUNK = 400; // детали на зданиях: скрываются по расстоянию, участки мельче
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const _c = new THREE.Color();
const SMALL_ATTACH = new Set(['door', 'awning', 'cornice', 'fireescape', 'vent', 'ac', 'neonH']);
const ROOF_ATTACH = new Set(['tank', 'antenna']); // мелочь на крышах: с высоты не видна
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qs = new THREE.Quaternion();
const _ps = new THREE.Vector3();
const _ss = new THREE.Vector3();
const UP_AXIS = new THREE.Vector3(0, 1, 0);
const GLASS_COLOR = new THREE.Color(0xbcd6e8);
const REBAR_COLOR = new THREE.Color(0x6b3a26);
const SLAB_COLOR = new THREE.Color(0x8d8b86);

// Город из «секций»: каждое здание — стопка секций по ~12 м.
// Выбитая секция превращается в обломки, а всё, что было над ней, падает целым куском.
export class City {
  constructor(scene, fx) {
    this.scene = scene;
    this.fx = fx; // { debris, dust, sparks, effects, audio }
    this.buildings = [];
    this.segs = [];
    this.runs = []; // целые части зданий, рисуются одним блоком, пока не повреждены
    this.gasSpots = [];
    this.falling = [];
    this.destroyed = 0;
    this.onDestroyed = null;
    this.onImpact = null; // (point, radius, force) — для машин, людей, фонарей
    this.yardTrees = [];  // [x, z] деревьев во дворах кварталов (сажает trees.js)

    this.material = createBuildingMaterial();
    this.concrete = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0.05 });
    this.roofMat = new THREE.MeshStandardMaterial({ color: 0x6d6f73, roughness: 0.8, metalness: 0.2 });
    this.gableMat = new THREE.MeshStandardMaterial({ roughness: 0.75 });
    this.shapeMat = createShapeMaterial(this.material.userData.uNight);

    const rnd = mulberry32(CITY.seed);
    this.generateMain(rnd);
    for (const t of TOWNS) this.generateTown(t);
    this.generateBridges();
    this.generateHarbor(mulberry32(CITY.seed + 9));
    this.generatePier();
    this.buildMeshes();
    this.uTime = { value: 0 };
    this.generateAttachments();
    this.buildGrid();
  }

  // ================================================================ генерация
  generateMain(rnd) {
    const g = CITY.grid;
    // Отдельный поток случайностей для геометрических кварталов
    const rndShape = mulberry32(CITY.seed + 501);
    // Гиганты на мега-площадях (кварталы MEGA ниже пропускаются)
    MEGA_SITES.forEach((s, i) => (s.tower ? addTvTower(this, s) : addMegaLandmark(this, s, i, mulberry32(CITY.seed + 900 + i))));
    const at = (cx, cz, D) => Math.abs(cx - D.x) < 50 && Math.abs(cz - D.z) < 50;
    for (let i = 0; i < g; i++) for (let j = 0; j < g; j++) {
      const type = blockTypes[j * g + i];
      const bx = -HALF + i * CITY.block, bz = -HALF + j * CITY.block;
      const cx = bx + CITY.block / 2, cz = bz + CITY.block / 2;
      if (type === BLOCK.URBAN) {
        if (at(cx, cz, LANDMARK)) this.addLandmark(cx, cz);
        else if (at(cx, cz, DISTRICTS.westgate)) this.addTwinTowers(cx, cz);
        else if (inCampus(cx, cz)) this.fillCampusBlock(bx, bz, rnd, at(cx, cz, DISTRICTS.campus));
        else if (inSleeper(cx, cz)) this.fillSleeperBlock(bx, bz, rnd);
        else if (inOldTown(cx, cz)) this.fillOldTownBlock(bx, bz, rnd);
        // Там, где нет высоток, — иногда квартал-площадь с необычной постройкой
        else if (skylineAt(cx, cz) < 0.22 && rndShape() < 0.08) addGeometricBlock(this, bx, bz, rndShape);
        // Средний пояс: часть кварталов — сплошной периметр домов вокруг двора
        else if (skylineAt(cx, cz) < 0.12 && rndShape() < 0.3) this.fillPerimeterBlock(bx, bz, rnd);
        else this.fillUrbanBlock(bx, bz, rnd, 1);
      } else if (type === BLOCK.SUBURB) {
        if (rndShape() < 0.045) addGeometricBlock(this, bx, bz, rndShape, true);
        else this.fillSuburbBlock(bx, bz, rnd);
      }
      else if (type === BLOCK.INDUSTRIAL) this.fillIndustrialBlock(bx, bz, rnd);
      else if (type === BLOCK.PORT) this.fillPortBlock(bx, bz, rnd);
      else if (type === BLOCK.STADIUM) this.addStadium(cx, cz);
    }
  }

  // Главный небоскрёб города: подиум, ярусы стекла и шпиль
  addLandmark(x, z) {
    const fixed = () => 0.5;
    this.addBuilding({ x, z, w: 80, d: 80, h: 18, color: 0xd8d2c4, glass: false, roof: null }, fixed);
    const b = this.addBuilding({
      x, z, w: 46, d: 46, h: 432, color: 0x5a7896, glass: true,
      tiers: [{ at: 260, k: 0.78 }, { at: 360, k: 0.56 }, { at: 408, k: 0.36 }], roof: null,
    }, fixed);
    // Шпиль — часть здания: рушится вместе с ним
    for (let k = 0; k < 4; k++) this.addSeg(b, { x, z, w: 2.2 - k * 0.4, d: 2.2 - k * 0.4, y0: 432 + k * 12, h: 12, type: 'concrete' });
  }

  // «Близнецы»: две одинаковые стеклянные башни западного делового квартала, между
  // ними — два застеклённых перехода. Переход держится на обеих башнях: рушится
  // опора ниже него — падает и он (см. destroySeg)
  addTwinTowers(cx, cz) {
    const fixed = () => 0.5;
    this.addBuilding({ x: cx, z: cz, w: 74, d: 44, h: 14, color: 0xd8d2c4, glass: false, roof: null }, fixed);
    const towers = [-1, 1].map((s) => {
      const x = cx + s * 22;
      const b = this.addBuilding({
        x, z: cz, w: 26, d: 26, h: 312, color: 0x40566e, glass: true,
        tiers: [{ at: 240, k: 0.84 }, { at: 288, k: 0.62 }], roof: null,
      }, fixed);
      for (let k = 0; k < 3; k++) this.addSeg(b, { x, z: cz, w: 2 - k * 0.5, d: 2 - k * 0.5, y0: 312 + k * 12, h: 12, type: 'concrete' });
      b.links = [];
      return b;
    });
    for (const y0 of [156, 216]) {
      const br = this.newBuilding({ kind: 'building', x: cx, z: cz, color: 0x5a7896, glass: true });
      br.shaped = true; // без деталей на крыше
      const s = this.addSeg(br, { x: cx, z: cz, w: 20, d: 9, y0, h: 7 });
      for (const t of towers) t.links.push(s);
    }
  }

  // Спальный район: длинные панельные корпуса по краям квартала или точечные башни.
  // Двор (газон, дорожки, детская площадка) рисует шейдер земли, деревья — trees.js
  fillSleeperBlock(bx, bz, rnd) {
    const margin = CITY.road / 2 + CITY.sidewalk, lot = CITY.block - margin * 2, e = lot / 2;
    const cx = bx + CITY.block / 2, cz = bz + CITY.block / 2;
    // (u, v) — оси квартала; flip меняет их местами: корпуса стоят то вдоль X, то вдоль Z
    const flip = rnd() < 0.5;
    const put = (u, v, w, d, floors, roof = 'box') => this.addBuilding({
      x: cx + (flip ? v : u), z: cz + (flip ? u : v), w: flip ? d : w, d: flip ? w : d, h: floors * 3,
      color: PANEL_PALETTE[Math.floor(rnd() * PANEL_PALETTE.length)], glass: false, roof,
    }, rnd);
    const r = rnd();
    if (r < 0.55) {
      // Два длинных корпуса друг напротив друга, иногда — короткий с торца
      const F = [9, 9, 12, 16][Math.floor(rnd() * 4)];
      put(0, -(e - 7), lot - 2, 13, F);
      put(0, e - 7, lot - 2, 13, F);
      if (rnd() < 0.7) put((rnd() < 0.5 ? -1 : 1) * (e - 7), 0, 13, lot - 32, 5);
    } else if (r < 0.85) {
      // Две точечные башни по диагонали и двухэтажный детский сад
      const s = rnd() < 0.5 ? -1 : 1;
      put(-(e - 11), -s * (e - 11), 20, 20, 17 + Math.floor(rnd() * 9));
      put(e - 11, s * (e - 11), 20, 20, 17 + Math.floor(rnd() * 9));
      put(-(e - 17), s * (e - 9), 30, 14, 2, null);
    } else {
      // Корпус «углом»
      const F = rnd() < 0.5 ? 9 : 12;
      put(0, -(e - 7), lot - 2, 13, F);
      put(-(e - 7), 7.5, 13, lot - 17, F);
    }
    for (let k = 0, m = 4 + Math.floor(rnd() * 4); k < m; k++) {
      const u = (rnd() - 0.5) * 32, v = (rnd() - 0.5) * 32;
      if (Math.abs(u) < 12 && Math.abs(v) < 9) continue; // детская площадка
      this.yardTrees.push([cx + u, cz + v]);
    }
  }

  // Университетский городок: корпуса из кирпича и песчаника по краям квартала,
  // углы открыты — проходы на газон-«квадрат» с дорожками крест-накрест
  fillCampusBlock(bx, bz, rnd, center) {
    const margin = CITY.road / 2 + CITY.sidewalk, lot = CITY.block - margin * 2, e = lot / 2;
    const cx = bx + CITY.block / 2, cz = bz + CITY.block / 2;
    if (center) { this.addCampusCenter(cx, cz); return; }
    const open = rnd() < 0.5 ? Math.floor(rnd() * 4) : -1; // одна сторона иногда открыта
    for (let side = 0; side < 4; side++) {
      if (side === open) continue;
      const nx = [0, 0, -1, 1][side], nz = [-1, 1, 0, 0][side];
      const dep = 12 + rnd() * 3, len = lot - dep * 2 - 2 - rnd() * 6;
      this.addBuilding({
        x: cx + nx * (e - dep / 2), z: cz + nz * (e - dep / 2), w: nx ? dep : len, d: nx ? len : dep, h: 12 + rnd() * 10,
        color: CAMPUS_PALETTE[Math.floor(rnd() * CAMPUS_PALETTE.length)], glass: false,
        roof: 'gable', roofColor: 0x3e464f, ridge: nx ? 'z' : 'x',
      }, rnd);
    }
    for (const [u, v] of [[14, 0], [-14, 0], [0, 14], [0, -14]]) this.yardTrees.push([cx + u, cz + v]);
  }

  // Сердце кампуса: часовая башня (циферблаты ночью светятся) и библиотека под куполом
  addCampusCenter(cx, cz) {
    const fixed = () => 0.5;
    const tx = cx - 18, tz = cz - 14;
    const tower = this.addBuilding({ x: tx, z: tz, w: 12, d: 12, h: 48, color: 0xd6c6a6, glass: false, roof: null }, fixed);
    tower.shaped = true; // без деталей на крыше
    this.addSeg(tower, { x: tx, z: tz, w: 12, d: 12, y0: 48, h: 11, type: 'shape', shape: 'clock' });
    this.addSeg(tower, { x: tx, z: tz, w: 12.5, d: 12.5, y0: 59, h: 16, type: 'shape', shape: 'spire' }).color = new THREE.Color(0x4a5560);
    const lib = this.addBuilding({ x: cx + 10, z: cz + 12, w: 46, d: 30, h: 15, color: 0xe2d6bf, glass: false, roof: null }, fixed);
    lib.shaped = true;
    this.addSeg(lib, { x: cx + 10, z: cz + 12, w: 24, d: 24, y0: 15, h: 15, type: 'shape', shape: 'dome' }).color = new THREE.Color(0x6f9484);
  }

  // Средний пояс города: сплошной периметр 5–8-этажных домов вокруг закрытого двора
  fillPerimeterBlock(bx, bz, rnd) {
    const margin = CITY.road / 2 + CITY.sidewalk, lot = CITY.block - margin * 2;
    const x0 = bx + margin, z0 = bz + margin, dep = 13 + rnd() * 3;
    const n = 3 + Math.floor(rnd() * 2), H = 15 + rnd() * 9;
    const house = (x, z, w, d) => this.addBuilding({
      x, z, w: w - 0.4, d: d - 0.4, h: H * (0.85 + rnd() * 0.3),
      color: STUCCO_PALETTE[Math.floor(rnd() * STUCCO_PALETTE.length)], glass: false, roof: rnd() < 0.5 ? 'box' : null,
    }, rnd);
    // Стороны вдоль X — на всю длину, вдоль Z — между ними
    for (let k = 0; k < n; k++) {
      const x = x0 + lot * (k + 0.5) / n;
      house(x, z0 + dep / 2, lot / n, dep);
      house(x, z0 + lot - dep / 2, lot / n, dep);
    }
    const inner = lot - dep * 2;
    for (let k = 0; k < n - 1; k++) {
      const z = z0 + dep + inner * (k + 0.5) / (n - 1);
      house(x0 + dep / 2, z, dep, inner / (n - 1));
      house(x0 + lot - dep / 2, z, dep, inner / (n - 1));
    }
    const cx = bx + CITY.block / 2, cz = bz + CITY.block / 2;
    for (let k = 0, m = 2 + Math.floor(rnd() * 3); k < m; k++) this.yardTrees.push([cx + (rnd() - 0.5) * 30, cz + (rnd() - 0.5) * 30]);
  }

  // Старый город: плотная кирпичная застройка по периметру квартала, двор внутри
  fillOldTownBlock(bx, bz, rnd) {
    const margin = CITY.road / 2 + CITY.sidewalk, lot = CITY.block - margin * 2;
    const n = 4, cell = lot / n;
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
      if (a > 0 && a < n - 1 && b > 0 && b < n - 1) continue; // двор
      if (rnd() < 0.05) continue;
      const x = bx + margin + cell * (a + 0.5), z = bz + margin + cell * (b + 0.5);
      const color = OLD_PALETTE[Math.floor(rnd() * OLD_PALETTE.length)];
      this.addBuilding({
        x, z, w: cell - 0.6, d: cell - 0.6, h: 10 + rnd() * 14, color, glass: false,
        roof: rnd() < 0.6 ? 'gable' : 'box', roofColor: ROOF_PALETTE[Math.floor(rnd() * ROOF_PALETTE.length)],
      }, rnd);
    }
  }

  // Промзона: склады и цеха без окон, трубы
  fillIndustrialBlock(bx, bz, rnd) {
    const margin = CITY.road / 2 + CITY.sidewalk, lot = CITY.block - margin * 2;
    const x0 = bx + margin, z0 = bz + margin;
    const parts = rnd() < 0.55 ? [[0, 0.5], [0.5, 1]] : [[0, 1]];
    for (const [u0, u1] of parts) {
      if (rnd() < 0.1) continue;
      const w = lot * (u1 - u0) - 6 - rnd() * 8, d = lot - 10 - rnd() * 20;
      const x = x0 + lot * (u0 + u1) / 2, z = z0 + lot / 2 + (rnd() - 0.5) * 8;
      const color = WAREHOUSE_PALETTE[Math.floor(rnd() * WAREHOUSE_PALETTE.length)];
      this.addBuilding({ x, z, w, d, h: 8 + rnd() * 9, color, glass: false, type: 'concrete', roof: rnd() < 0.6 ? 'box' : null }, rnd);
    }
    if (rnd() < 0.3) {
      const x = x0 + 6 + rnd() * (lot - 12), z = z0 + 3 + rnd() * 3;
      this.addBuilding({ x, z, w: 4.5, d: 4.5, h: 36 + rnd() * 40, color: rnd() < 0.5 ? 0x8a4f3c : 0xa9a49a, glass: false, type: 'concrete', roof: null }, rnd);
    }
  }

  // Штабель контейнеров 12×2.6×2.5 (длинная сторона вдоль X)
  addContainerStack(x, z, levels, rnd, y0 = 0, d = 2.5) {
    const b = this.newBuilding({ kind: 'building', x, z, color: CONTAINER_PALETTE[Math.floor(rnd() * CONTAINER_PALETTE.length)], glass: false });
    for (let k = 0; k < levels; k++) this.addSeg(b, { x, z, w: 12, d, y0: y0 + k * 2.6, h: 2.6, type: 'concrete' });
    return b;
  }

  // Порт: контейнерные штабели и портальные краны у набережной
  fillPortBlock(bx, bz, rnd) {
    const margin = CITY.road / 2 + CITY.sidewalk, lot = CITY.block - margin * 2;
    const x0 = bx + margin, z0 = bz + margin;
    for (let r = 0; r < 4; r++) for (let c = 0; c < 5; c++) {
      if (rnd() < 0.3) continue;
      const x = x0 + 8 + r * 14, z = z0 + 6 + c * 15.5;
      const levels = 1 + Math.floor(rnd() * 4);
      for (let m = 0; m < 4; m++) {
        if (m > 0 && rnd() < 0.2) break;
        this.addContainerStack(x, z + m * 2.8, Math.max(1, levels - (m > 0 ? Math.floor(rnd() * 2) : 0)), rnd);
      }
    }
    // Кран у причала (через квартал)
    if (Math.round((bz + HALF) / CITY.block) % 2 === 0) {
      const x = HALF - 20, z = bz + CITY.block / 2 + (rnd() - 0.5) * 30;
      const b = this.newBuilding({ kind: 'building', x, z, color: rnd() < 0.5 ? 0xd88a2a : 0xc9a227, glass: false });
      for (let k = 0; k < 3; k++) this.addSeg(b, { x, z, w: 3.2, d: 3.2, y0: k * 13, h: 13, type: 'concrete' });
      this.addSeg(b, { x, z, w: 9, d: 7, y0: 39, h: 6, type: 'concrete' });             // кабина и машинное
      this.addSeg(b, { x: x + 30, z, w: 64, d: 2.4, y0: 45, h: 2.6, type: 'concrete' }); // стрела над водой
      this.addSeg(b, { x: x - 9, z, w: 10, d: 4, y0: 45, h: 3.2, type: 'concrete' });    // противовес
    }
  }

  // Стадион: трибуны в три яруса вокруг поля и мачты освещения
  addStadium(x, z) {
    const fixed = () => 0.5, seats = [0x7a3430, 0xa9a59c, 0x4a5a6e];
    const fw = 30, fd = 21, th = 5; // половины размеров поля, толщина яруса
    for (let t = 0; t < 3; t++) {
      const h = 4 + t * 4, o = t * th;
      const side = { color: seats[t], glass: false, type: 'concrete', roof: null, h };
      this.addBuilding({ ...side, x, z: z - fd - o - th / 2, w: (fw + o + th) * 2, d: th }, fixed);
      this.addBuilding({ ...side, x, z: z + fd + o + th / 2, w: (fw + o + th) * 2, d: th }, fixed);
      this.addBuilding({ ...side, x: x - fw - o - th / 2, z, w: th, d: (fd + o) * 2 }, fixed);
      this.addBuilding({ ...side, x: x + fw + o + th / 2, z, w: th, d: (fd + o) * 2 }, fixed);
    }
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const mx = x + sx * 44, mz = z + sz * 36;
      const b = this.addBuilding({ x: mx, z: mz, w: 1.6, d: 1.6, h: 36, color: 0x9aa0a6, glass: false, type: 'concrete', roof: null }, fixed);
      this.addSeg(b, { x: mx, z: mz, w: 6, d: 1.2, y0: 36, h: 3, type: 'concrete' });
    }
  }

  // Причалы в море за набережной и пришвартованные корабли
  // Деревянный пирс на сваях: по нему можно ходить, от ударов он ломается, как мосты
  generatePier() {
    const b = this.newBuilding({ kind: 'bridge', x: BEACH.x0 + PIER.len / 2, z: PIER.z, color: 0x8b6b4a, glass: false });
    const step = 15;
    for (let t = 0; t < PIER.len; t += step) {
      const x = BEACH.x0 + t + step / 2, top = pierDeckY(x);
      const wide = t >= PIER.platFrom, d = wide ? PIER.platW : PIER.w;
      this.addSeg(b, { x, z: PIER.z, w: step, d, y0: top - 0.5, h: 0.5, type: 'concrete' });
      // Сваи: ряды поперёк настила
      const rows = wide ? [-30, -15, 0, 15, 30] : [-PIER.w / 2 + 1, 0, PIER.w / 2 - 1];
      for (const dz of rows) {
        const bottom = Math.min(beachHeight(x), -1) - 3;
        this.addSeg(b, { x, z: PIER.z + dz, w: 0.7, d: 0.7, y0: bottom, h: top - 0.5 - bottom, type: 'concrete' });
      }
    }
  }

  generateHarbor(rnd) {
    for (let j = 2; j < CITY.grid - 2; j += 5) {
      const z = -HALF + j * CITY.block + CITY.block / 2;
      if (Math.abs(z - RIVER_Z) < 300 || (z > BEACH.minZ - 60 && z < BEACH.maxZ + 60)) continue;
      const len = 90 + rnd() * 60, x0 = QUAY_X - 2, parts = Math.ceil(len / 30);
      const b = this.newBuilding({ kind: 'bridge', x: x0 + len / 2, z, color: 0x9a978f, glass: false });
      for (let p = 0; p < parts; p++) this.addSeg(b, { x: x0 + (p + 0.5) * len / parts, z, w: len / parts, d: 18, y0: -1.6, h: 1.6, type: 'concrete' });
      for (let p = 1; p < parts; p++) for (const s of [-1, 1]) this.addSeg(b, { x: x0 + p * len / parts, z: z + s * 7, w: 2, d: 2, y0: -14, h: 12.4, type: 'concrete' });
      if (rnd() > 0.7) continue;
      // Корабль у причала: корпус, надстройка, палубный груз
      const sl = 70 + rnd() * 70, sz = z + (rnd() < 0.5 ? -1 : 1) * 19, sx = x0 + 10 + sl / 2;
      const ship = this.newBuilding({ kind: 'ship', x: sx, z: sz, color: [0x2b3a4a, 0x6b2a24, 0x2f4a3a, 0x3a3a3e][Math.floor(rnd() * 4)], glass: false });
      const n = Math.ceil(sl / 25);
      for (let p = 0; p < n; p++) this.addSeg(ship, { x: sx - sl / 2 + (p + 0.5) * sl / n, z: sz, w: sl / n, d: 16, y0: -6, h: 9, type: 'concrete' });
      const sup = this.newBuilding({ kind: 'building', x: sx - sl / 2 + 10, z: sz, color: 0xe8e4dc, glass: false });
      for (let k = 0; k < 3; k++) this.addSeg(sup, { x: sup.x, z: sz, w: 12, d: 14, y0: 3 + k * 3.5, h: 3.5, type: 'concrete' });
      for (let p = 1; p < n; p++) this.addContainerStack(sx - sl / 2 + (p + 0.5) * sl / n, sz, 1 + Math.floor(rnd() * 3), rnd, 3, 12);
    }
  }

  generateTown(t) {
    const rnd = mulberry32(t.seed);
    const half = t.grid * CITY.block / 2;
    for (let i = 0; i < t.grid; i++) for (let j = 0; j < t.grid; j++) {
      const bx = t.x - half + i * CITY.block, bz = t.z - half + j * CITY.block;
      const d = Math.max(Math.abs(bx + 50 - t.x), Math.abs(bz + 50 - t.z)) / half;
      if (rnd() < 0.08) continue;
      if (d < 0.45) this.fillUrbanBlock(bx, bz, rnd, 0.3);
      else this.fillSuburbBlock(bx, bz, rnd);
    }
  }

  // heightScale < 1 — для небольших городков
  fillUrbanBlock(bx, bz, rnd, heightScale) {
    const margin = CITY.road / 2 + CITY.sidewalk, lot = CITY.block - margin * 2;
    const cx = bx + CITY.block / 2, cz = bz + CITY.block / 2;
    const core = heightScale === 1 ? skylineAt(cx, cz) : 0.35;
    const hMax = lerp(22, CITY.maxHeight * heightScale, core);
    const nx = core > 0.6 ? (rnd() < 0.5 ? 1 : 2) : 2 + Math.floor(rnd() * 2);
    const nz = core > 0.6 ? (rnd() < 0.5 ? 1 : 2) : 2 + Math.floor(rnd() * 2);
    const cw = lot / nx, cd = lot / nz;
    const gasSlot = rnd() < 0.03 && nx * nz >= 4 ? Math.floor(rnd() * nx * nz) : -1;

    for (let a = 0; a < nx; a++) for (let b = 0; b < nz; b++) {
      const x = bx + margin + cw * (a + 0.5), z = bz + margin + cd * (b + 0.5);
      if (a * nz + b === gasSlot) { this.gasSpots.push({ x, z, w: cw - 4, d: cd - 4 }); continue; }
      if (rnd() < 0.06) continue;
      const gap = 3 + rnd() * 5;
      const w = cw - gap - rnd() * cw * 0.25, d = cd - gap - rnd() * cd * 0.25;
      const h = Math.max(8, hMax * (0.3 + 0.7 * rnd() ** 1.5) * (0.85 + rnd() * 0.3));
      const color = PALETTE[Math.floor(rnd() * PALETTE.length)];
      // Ступенчатая верхушка у высоких зданий
      const step = h > 70 && rnd() < 0.45 ? { at: h * (0.55 + rnd() * 0.25), k: 0.55 + rnd() * 0.25 } : null;
      this.addBuilding({ x, z, w, d, h, color, glass: GLASS.has(color), step, roof: rnd() < 0.7 ? 'box' : null }, rnd);
    }
  }

  fillSuburbBlock(bx, bz, rnd) {
    const margin = CITY.road / 2 + CITY.sidewalk, lot = CITY.block - margin * 2;
    const n = 3;
    const cell = lot / n;
    const gas = rnd() < 0.012;
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
      if (a === 1 && b === 1) {
        // Двор в центре квартала, иногда — заправка
        if (gas) this.gasSpots.push({ x: bx + margin + cell * 1.5, z: bz + margin + cell * 1.5, w: cell * 1.6, d: cell * 1.6 });
        continue;
      }
      if (rnd() < 0.12) continue;
      const x = bx + margin + cell * (a + 0.5) + (rnd() - 0.5) * 3;
      const z = bz + margin + cell * (b + 0.5) + (rnd() - 0.5) * 3;
      const w = 9 + rnd() * 6, d = 9 + rnd() * 6, h = rnd() < 0.3 ? 7 + rnd() * 2 : 4 + rnd() * 1.5;
      const color = HOUSE_PALETTE[Math.floor(rnd() * HOUSE_PALETTE.length)];
      this.addBuilding({ x, z, w, d, h, color, glass: false, roof: 'gable', roofColor: ROOF_PALETTE[Math.floor(rnd() * ROOF_PALETTE.length)] }, rnd);
    }
  }

  generateBridges() {
    const zA = RIVER_Z - RIVER_HALF_W - 3, zB = RIVER_Z + RIVER_HALF_W + 3;
    const parts = 4, len = (zB - zA) / parts;
    for (let k = 0; k <= CITY.grid; k++) {
      if (!isBridgeRoad(k)) continue;
      const x = -HALF + k * CITY.block;
      const b = this.newBuilding({ kind: 'bridge', x, z: RIVER_Z, color: 0x8e8c88, glass: false });
      for (let p = 0; p < parts; p++) {
        this.addSeg(b, { x, z: zA + len * (p + 0.5), w: CITY.road + 2, d: len, y0: -1.6, h: 1.6, type: 'concrete' });
      }
      // Опоры
      for (let p = 1; p < parts; p++) {
        this.addSeg(b, { x, z: zA + len * p, w: 4, d: 4, y0: WORLD.riverBed, h: -1.6 - WORLD.riverBed, type: 'concrete' });
      }
    }
  }

  newBuilding(props) {
    const b = { index: this.buildings.length, segs: [], counted: false, roof: null, ...props, color: new THREE.Color(props.color) };
    this.buildings.push(b);
    return b;
  }

  addSeg(b, s) {
    const seg = { index: this.segs.length, b: b.index, alive: true, type: s.type || 'building', ...s };
    seg.maxHp = 30 + seg.w * seg.d * seg.h * 0.004;
    seg.hp = seg.maxHp;
    b.segs.push(seg.index);
    this.segs.push(seg);
    return seg;
  }

  addBuilding(p, rnd) {
    const b = this.newBuilding({ kind: 'building', x: p.x, z: p.z, color: p.color, glass: p.glass });
    b.color.offsetHSL(0, 0, (rnd() - 0.5) * 0.08);
    // Нарезаем по высоте на секции; уступы сужают верхние ярусы
    const tiers = p.tiers || (p.step ? [p.step] : []);
    const n = Math.max(1, Math.round(p.h / CITY.segment));
    const sh = p.h / n;
    for (let k = 0; k < n; k++) {
      const y0 = k * sh;
      let kk = 1;
      for (const t of tiers) if (y0 >= t.at - 0.01) kk = t.k;
      this.addSeg(b, { x: p.x, z: p.z, w: p.w * kk, d: p.d * kk, y0, h: sh, type: p.type || 'building' });
    }
    // Подряд идущие секции одного размера — «цельный» блок для рендера
    if (n > 1) {
      let run = null;
      for (const si of b.segs) {
        const sg = this.segs[si];
        if (sg.type !== 'building') { run = null; continue; }
        if (!run || Math.abs(run.w - sg.w) > 0.01) {
          run = { b: b.index, x: sg.x, z: sg.z, w: sg.w, d: sg.d, y0: sg.y0, h: 0, segs: [], whole: true };
          this.runs.push(run);
        }
        run.segs.push(sg);
        run.h += sg.h;
        sg.run = run;
      }
    }
    if (p.roof === 'box') {
      b.roof = { kind: 'box', w: p.w * (0.2 + rnd() * 0.25), h: 2 + rnd() * 4, d: p.d * (0.2 + rnd() * 0.25), ox: (rnd() - 0.5) * p.w * 0.25, oz: (rnd() - 0.5) * p.d * 0.25 };
    } else if (p.roof === 'gable') {
      // Конёк вдоль X (или вдоль Z — крыша повёрнута, ширина и глубина меняются местами)
      const h = 2.2 + rnd() * 1.6, rz = p.ridge ? p.ridge === 'z' : rnd() >= 0.5;
      b.roof = { kind: 'gable', w: (rz ? p.d : p.w) + 0.8, h, d: (rz ? p.w : p.d) + 0.8, ox: 0, oz: 0, color: new THREE.Color(p.roofColor), rot: rz ? Math.PI / 2 : 0 };
    }
    return b;
  }

  // ================================================================ меши
  buildMeshes() {
    const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const gable = makeGableGeometry();
    const groups = new Map();
    const getGroup = (x, z) => {
      const key = Math.floor(x / CHUNK) * 100000 + Math.floor(z / CHUNK);
      if (!groups.has(key)) groups.set(key, { building: [], concrete: [], roofBox: [], gable: [], whole: [] });
      return groups.get(key);
    };
    for (const s of this.segs) {
      const g = getGroup(s.x, s.z), key = s.type === 'shape' ? 'shape:' + s.shape : s.type;
      (g[key] = g[key] || []).push(s);
    }
    const shapeGeos = makeShapeGeometries();
    for (const b of this.buildings) if (b.roof) getGroup(b.x, b.z)[b.roof.kind === 'box' ? 'roofBox' : 'gable'].push(b);
    for (const r of this.runs) getGroup(r.x, r.z).whole.push(r);

    this.meshes = [];
    const make = (geo, mat, n) => {
      const m = new THREE.InstancedMesh(geo, mat, n);
      m.castShadow = m.receiveShadow = true;
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3);
      this.scene.add(m);
      this.meshes.push(m);
      return m;
    };
    for (const g of groups.values()) {
      for (const type of ['building', 'concrete']) {
        if (!g[type].length) continue;
        const mesh = make(box, type === 'building' ? this.material : this.concrete, g[type].length);
        // Слоты получают только «одиночные» секции; секции цельных блоков —
        // позже, когда блок разделится (так видеокарта не тратит время на скрытое)
        let next = 0;
        for (const s of g[type]) { s.mesh = mesh; s.slot = s.run ? -1 : next++; if (s.slot >= 0) this.writeSeg(s, true); }
        mesh.count = mesh.userData.base = mesh.userData.next = next;
        mesh.computeBoundingSphere();
        this.segMeshes = this.segMeshes || [];
        this.segMeshes.push(mesh);
      }
      // Геометрическая архитектура: своя сетка на каждую форму
      for (const key in g) {
        if (!key.startsWith('shape:') || !g[key].length) continue;
        const mesh = make(shapeGeos[key.slice(6)], this.shapeMat, g[key].length);
        g[key].forEach((s, i) => { s.mesh = mesh; s.slot = i; this.writeSeg(s, true); });
        mesh.computeBoundingSphere();
      }
      if (g.whole.length) {
        const mesh = make(box, this.material, g.whole.length);
        g.whole.forEach((r, i) => { r.mesh = mesh; r.slot = i; this.writeRun(r); });
        mesh.computeBoundingSphere();
      }
      if (g.roofBox.length) {
        const mesh = make(box, this.roofMat, g.roofBox.length);
        g.roofBox.forEach((b, i) => { b.roof.mesh = mesh; b.roof.slot = i; this.writeRoof(b); });
        mesh.computeBoundingSphere();
      }
      if (g.gable.length) {
        const mesh = make(gable, this.gableMat, g.gable.length);
        g.gable.forEach((b, i) => { b.roof.mesh = mesh; b.roof.slot = i; this.writeRoof(b); });
        mesh.computeBoundingSphere();
      }
    }
  }

  segMatrix(s, out) {
    // Витые секции повёрнуты вокруг вертикали
    if (s.rot) return out.compose(_ps.set(s.x, s.y0, s.z), _qs.setFromAxisAngle(UP_AXIS, s.rot), _ss.set(s.w, s.h, s.d));
    return out.makeScale(s.w, s.h, s.d).setPosition(s.x, s.y0, s.z);
  }

  writeRun(r) {
    r.mesh.setMatrixAt(r.slot, r.whole ? _m.makeScale(r.w, r.h, r.d).setPosition(r.x, r.y0, r.z) : _zero);
    r.mesh.setColorAt(r.slot, this.buildings[r.b].color);
    r.mesh.instanceMatrix.needsUpdate = true;
    r.mesh.instanceColor.needsUpdate = true;
  }

  // Первое изменение секции: цельный блок заменяется отдельными секциями
  splitRun(r) {
    if (!r.whole) return;
    r.whole = false;
    this.writeRun(r);
    const mesh = r.segs[0].mesh;
    for (const sg of r.segs) if (sg.slot < 0) sg.slot = mesh.userData.next++;
    mesh.count = mesh.userData.next;
    for (const sg of r.segs) this.writeSeg(sg);
    mesh.computeBoundingSphere();
  }

  writeSeg(s, init = false) {
    if (s.att) this.writeAttachments(s);
    if (s.run && s.run.whole) {
      if (!init) this.splitRun(s.run);
      return;
    }
    if (s.slot < 0) return;
    s.mesh.setMatrixAt(s.slot, s.alive ? this.segMatrix(s, _m) : _zero);
    const b = this.buildings[s.b];
    _c.copy(s.color || b.color).multiplyScalar(0.55 + 0.45 * (s.hp / s.maxHp));
    s.mesh.setColorAt(s.slot, _c);
    s.mesh.instanceMatrix.needsUpdate = true;
    s.mesh.instanceColor.needsUpdate = true;
  }

  // Крыша стоит на верхней секции, пока та цела
  writeRoof(b) {
    const r = b.roof;
    const top = this.segs[b.segs[b.segs.length - 1]];
    if (top.alive) {
      _q.setFromAxisAngle(_v.set(0, 1, 0), r.rot || 0);
      _m.compose(_v.set(b.x + r.ox, top.y0 + top.h, b.z + r.oz), _q, new THREE.Vector3(r.w, r.h, r.d));
      r.mesh.setMatrixAt(r.slot, _m);
    } else r.mesh.setMatrixAt(r.slot, _zero);
    if (r.color) { r.mesh.setColorAt(r.slot, r.color); r.mesh.instanceColor.needsUpdate = true; }
    r.mesh.instanceMatrix.needsUpdate = true;
  }

  // ================================================================ детали на зданиях
  // Кондиционеры, баки, антенны и вытяжки на крышах, рекламные щиты, неоновые вывески.
  // Каждая деталь привязана к секции здания и исчезает вместе с ней.
  generateAttachments() {
    const rnd = mulberry32(CITY.seed + 31);
    const geos = makeAttachmentGeometries();
    const groups = new Map(); // ключ чанка → { тип: [{ seg, m, color }] }
    const put = (type, seg, m, color = 0xffffff) => {
      const key = Math.floor(seg.x / ATTACH_CHUNK) * 100000 + Math.floor(seg.z / ATTACH_CHUNK);
      if (!groups.has(key)) groups.set(key, {});
      const g = groups.get(key);
      (g[type] = g[type] || []).push({ seg, m, color });
    };
    const NEON = [0xff2a6d, 0x05d9e8, 0xffd319, 0x9b5de5, 0x00f5a0, 0xff7b00];
    const AD = [0xe63946, 0x2a9d8f, 0xf4a261, 0x457b9d, 0xffb703, 0x8338ec, 0x06d6a0];
    const AWNING = [0x7a2a2a, 0x2a5a4a, 0x2a3f6a, 0x8a6a2a, 0x5a2a5a, 0x3a3a3a, 0xa0522d];
    for (const b of this.buildings) {
      if (b.kind !== 'building' || b.shaped || (b.roof && b.roof.kind === 'gable')) continue;
      const top = this.segs[b.segs[b.segs.length - 1]];
      const roofY = top.y0 + top.h, H = roofY;
      // Красные заградительные огни на высотках, кранах и трубах (мигают)
      if (H > 38) {
        const ident = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
        if (top.w > 10 && top.d > 10) {
          for (const [sx, sz] of [[-1, -1], [1, 1]]) put('beacon', top, new THREE.Matrix4().compose(_v.set(top.x + sx * (top.w / 2 - 0.6), roofY, top.z + sz * (top.d / 2 - 0.6)), ident, one), 0xff1a10);
        } else put('beacon', top, new THREE.Matrix4().compose(_v.set(top.x, roofY, top.z), ident, one), 0xff1a10);
      }
      if (top.w < 6 || top.d < 6) continue;
      if (H < 7 || Math.abs(b.x) > HALF + 50 || Math.abs(b.z) > HALF + 50) continue;
      // Крыша: 1–4 детали в зависимости от площади
      const n = Math.min(4, 1 + Math.floor(top.w * top.d / 260 * rnd()));
      for (let i = 0; i < n; i++) {
        const x = top.x + (rnd() - 0.5) * (top.w - 4), z = top.z + (rnd() - 0.5) * (top.d - 4);
        const r = rnd(), rot = Math.floor(rnd() * 4) * Math.PI / 2;
        _q.setFromAxisAngle(_v.set(0, 1, 0), rot);
        if (r < 0.45) put('ac', top, new THREE.Matrix4().compose(_v.set(x, roofY, z), _q, new THREE.Vector3(1, 1, 1)));
        else if (r < 0.62 && H < 80) put('tank', top, new THREE.Matrix4().compose(_v.set(x, roofY, z), _q, new THREE.Vector3(1, 1, 1)));
        else if (r < 0.8) put('vent', top, new THREE.Matrix4().compose(_v.set(x, roofY, z), _q, new THREE.Vector3(1, 0.7 + rnd(), 1)));
        else put('antenna', top, new THREE.Matrix4().compose(_v.set(x, roofY, z), _q, new THREE.Vector3(1, 0.5 + rnd() * (H > 100 ? 2.5 : 1), 1)));
      }
      const urban = blockAt(b.x, b.z) === BLOCK.URBAN;
      if (!urban || top.type !== 'building') continue;
      // ---- Улица: какая сторона здания смотрит на ближайшую дорогу
      {
        const base0 = this.segs[b.segs[0]];
        const lx = ((b.x + HALF) % CITY.block + CITY.block) % CITY.block, lz = ((b.z + HALF) % CITY.block + CITY.block) % CITY.block;
        const opts = [[lx, -1, 0], [CITY.block - lx, 1, 0], [lz, 0, -1], [CITY.block - lz, 0, 1]].sort((p, q) => p[0] - q[0]);
        const [, nx, nz] = opts[0];
        const fa = Math.atan2(nx, nz), half = nx ? base0.w / 2 : base0.d / 2, along = nx ? base0.d : base0.w;
        const fx = base0.x + nx * half, fz = base0.z + nz * (nx ? 0 : half);
        const ox = nx ? 0 : 1, oz = nx ? 1 : 0;       // направление вдоль фасада
        _q.setFromAxisAngle(_v.set(0, 1, 0), fa);
        // Вход: дверь с козырьком
        const dOff = (rnd() - 0.5) * along * 0.5;
        put('door', base0, new THREE.Matrix4().compose(_v.set(fx + ox * dOff, 0, fz + oz * dOff), _q, new THREE.Vector3(1, 1, 1)));
        // Маркиза над витриной (не над дверью)
        if (rnd() < 0.45 && along > 9) {
          const aOff = dOff > 0 ? -along * 0.22 : along * 0.22, len = Math.min(along * 0.4, 9);
          put('awning', base0, new THREE.Matrix4().compose(_v.set(fx + ox * aOff, 0, fz + oz * aOff), _q, new THREE.Vector3(len / 4, 1, 1)), AWNING[Math.floor(rnd() * AWNING.length)]);
        }
        // Пожарная лестница на кирпичных домах старого города — на фасаде сбоку от входа
        if (inOldTown(b.x, b.z) && H > 9 && rnd() < 0.6) {
          const eOff = dOff > 0 ? -along * 0.3 : along * 0.3;
          for (let y = 3.6; y < H - 2; y += 3.6) {
            const seg = b.segs.map((si) => this.segs[si]).find((q) => q.y0 <= y && q.y0 + q.h > y) || base0;
            put('fireescape', seg, new THREE.Matrix4().compose(_v.set(fx + ox * eOff, y, fz + oz * eOff), _q, new THREE.Vector3(1, 1, 1)));
          }
        }
        // Карниз по краю крыши у невысоких каменных домов
        if (!b.glass && H > 10 && H < 120) {
          put('cornice', top, new THREE.Matrix4().compose(_v.set(top.x, roofY - 0.45, top.z), _q.identity(), new THREE.Vector3(top.w + 0.9, 1, top.d + 0.9)), 0xffffff);
        }
      }
      const core = skylineAt(b.x, b.z), old = inOldTown(b.x, b.z);
      // В спальном районе и кампусе — без рекламы и неона
      const calm = inSleeper(b.x, b.z) || inCampus(b.x, b.z);
      // Рекламный щит на крыше невысокого здания, повёрнут к улице
      if (!calm && H > 14 && H < 95 && top.w > 13 && rnd() < 0.05 + core * 0.08) {
        const face = rnd() < 0.5 ? 0 : Math.PI / 2;
        const len = (face ? top.d : top.w) * 0.75;
        _q.setFromAxisAngle(_v.set(0, 1, 0), face + (rnd() < 0.5 ? Math.PI : 0));
        put('board', top, new THREE.Matrix4().compose(_v.set(top.x, roofY, top.z), _q, new THREE.Vector3(len / 10, len / 10, 1)), AD[Math.floor(rnd() * AD.length)]);
      }
      // Неоновые вывески на фасаде у тротуара (чаще в старом городе и в центре)
      const signs = !calm && rnd() < (old ? 0.45 : 0.12 + core * 0.25) ? 1 + Math.floor(rnd() * 2) : 0;
      const base = this.segs[b.segs[0]];
      for (let i = 0; i < signs; i++) {
        const y = 4.5 + rnd() * Math.min(8, H - 7);
        const seg = b.segs.map((si) => this.segs[si]).find((s) => s.y0 <= y && s.y0 + s.h > y) || base;
        const side = Math.floor(rnd() * 4), a = side * Math.PI / 2;
        const nx = Math.round(Math.sin(a)), nz = Math.round(Math.cos(a));
        const along = (rnd() - 0.5) * 0.7;
        const px = seg.x + nx * (seg.w / 2) + (nz ? along * seg.w : 0);
        const pz = seg.z + nz * (seg.d / 2) + (nx ? along * seg.d : 0);
        _q.setFromAxisAngle(_v.set(0, 1, 0), a);
        put(rnd() < 0.6 ? 'neonV' : 'neonH', seg, new THREE.Matrix4().compose(_v.set(px, y, pz), _q, new THREE.Vector3(1, 1, 1)), NEON[Math.floor(rnd() * NEON.length)]);
      }
    }

    this.attachMat = createAttachmentMaterial(this.material.userData.uNight, this.uTime);
    this.attachChunks = [];
    for (const g of groups.values()) {
      const meshes = [];
      for (const type in g) {
        const list = g[type];
        const mesh = new THREE.InstancedMesh(geos[type], this.attachMat, list.length);
        mesh.name = type;
        mesh.castShadow = type === 'board' || type === 'tank';
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 3).fill(1), 3);
        list.forEach((a, i) => {
          a.mesh = mesh; a.slot = i;
          mesh.setMatrixAt(i, a.m);
          mesh.setColorAt(i, _c.set(a.color));
          (a.seg.att = a.seg.att || []).push(a);
        });
        mesh.computeBoundingSphere();
        this.scene.add(mesh);
        meshes.push(mesh);
      }
      const c = meshes[0].boundingSphere.center;
      this.attachChunks.push({ meshes, x: c.x, z: c.z });
    }
  }

  // Детали дальше ~1.6 км не рисуем: их не видно, а вершины считаются
  updateView(camPos, dt) {
    this.uTime.value += dt;
    if (!this.attachChunks) return;
    const far = 1600 + camPos.y * 0.5;
    for (const c of this.attachChunks) {
      const d = Math.hypot(c.x - camPos.x, c.z - camPos.z), d3 = Math.hypot(d, camPos.y);
      // Мелкие детали фасадов (двери, маркизы, карнизы, лестницы) — только вблизи (дальше они меньше пикселя)
      const near = this.smallAttachView ?? 600;
      for (const m of c.meshes) m.visible = SMALL_ATTACH.has(m.name) ? d < near && camPos.y < 450 : ROOF_ATTACH.has(m.name) ? d3 < 1300 : d < far;
    }
  }

  writeAttachments(s) {
    for (const a of s.att) {
      a.mesh.setMatrixAt(a.slot, s.alive ? a.m : _zero);
      a.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  // ================================================================ пространственная сетка
  buildGrid() {
    this.cells = new Map();
    this.stamp = new Uint32Array(this.segs.length);
    this.stampId = 0;
    for (const s of this.segs) {
      const x0 = Math.floor((s.x - s.w / 2) / CELL), x1 = Math.floor((s.x + s.w / 2) / CELL);
      const z0 = Math.floor((s.z - s.d / 2) / CELL), z1 = Math.floor((s.z + s.d / 2) / CELL);
      for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) {
        const key = i * 100000 + j;
        if (!this.cells.has(key)) this.cells.set(key, []);
        this.cells.get(key).push(s.index);
      }
    }
  }

  // Живые секции, чей footprint пересекает прямоугольник
  query(minX, minZ, maxX, maxZ, out = []) {
    out.length = 0;
    this.stampId++;
    const x0 = Math.floor(minX / CELL), x1 = Math.floor(maxX / CELL);
    const z0 = Math.floor(minZ / CELL), z1 = Math.floor(maxZ / CELL);
    for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) {
      const list = this.cells.get(i * 100000 + j);
      if (!list) continue;
      for (const idx of list) {
        if (this.stamp[idx] === this.stampId) continue;
        this.stamp[idx] = this.stampId;
        const s = this.segs[idx];
        if (s.alive) out.push(s);
      }
    }
    return out;
  }

  closestPoint(s, p, out) {
    return out.set(
      clamp(p.x, s.x - s.w / 2, s.x + s.w / 2),
      clamp(p.y, s.y0, s.y0 + s.h),
      clamp(p.z, s.z - s.d / 2, s.z + s.d / 2),
    );
  }

  sphereQuery(center, r, out = []) {
    const cand = this.query(center.x - r, center.z - r, center.x + r, center.z + r, this._sq || (this._sq = []));
    out.length = 0;
    for (const s of cand) {
      if (this.closestPoint(s, center, _v).distanceToSquared(center) <= r * r) out.push(s);
    }
    return out;
  }

  // Высота «пола» под точкой: земля, крыша или мост
  groundHeightAt(x, z, y) {
    let g = groundHeight(x, z);
    for (const s of this.query(x, z, x, z, this._q || (this._q = []))) {
      if (Math.abs(x - s.x) <= s.w / 2 && Math.abs(z - s.z) <= s.d / 2) {
        const top = s.y0 + s.h;
        if (y >= top - 1.5 && top > g) g = top;
      }
    }
    return g;
  }

  // Секция, внутри которой точка (или null)
  segAt(p, pad = 0) {
    for (const s of this.query(p.x - pad, p.z - pad, p.x + pad, p.z + pad, this._q2 || (this._q2 = []))) {
      if (Math.abs(p.x - s.x) < s.w / 2 + pad && Math.abs(p.z - s.z) < s.d / 2 + pad && p.y > s.y0 - pad && p.y < s.y0 + s.h + pad) return s;
    }
    return null;
  }

  isInside(p) { return this.segAt(p) !== null; }

  isGlass(s) { return this.buildings[s.b].glass; }

  // ================================================================ урон
  damage(s, amount, point, dir, force) {
    if (!s.alive) return false;
    s.hp -= amount;
    if (s.hp <= 0) { this.destroySeg(s, point, dir, force); return true; }

    // Частичное повреждение: куски из места удара + пыль
    const b = this.buildings[s.b];
    const chunks = clamp(Math.round(amount / 12), 3, 12);
    for (let i = 0; i < chunks; i++) {
      const sz = 0.4 + Math.random() * 1.5;
      this.fx.debris.spawn(
        point.x + (Math.random() - 0.5) * 2, point.y + (Math.random() - 0.5) * 2, point.z + (Math.random() - 0.5) * 2,
        sz, sz * (0.5 + Math.random()), sz,
        dir.x * force * (0.4 + Math.random() * 0.6) + (Math.random() - 0.5) * force * 0.5,
        dir.y * force * 0.5 + Math.random() * force * 0.4,
        dir.z * force * (0.4 + Math.random() * 0.6) + (Math.random() - 0.5) * force * 0.5,
        b.color, 0,
      );
    }
    this.spawnGlass(point, this.faceNormal(s, point), b.glass ? 16 : 6, force * 0.5);
    this.fx.dust.burst(point, 8, { size: [3, 7], speed: 6, life: [3, 6] });
    // Дыра и трещины на стене в месте удара
    if (b.kind === 'building') this.fx.effects.wallDecal?.(point, this.faceNormal(s, point), clamp(1.5 + amount / 25, 2, 9), s.index);
    this.writeSeg(s);
    return false;
  }

  // Нормаль грани секции, ближайшей к точке
  faceNormal(s, p) {
    const dx = (p.x - s.x) / (s.w / 2), dz = (p.z - s.z) / (s.d / 2), dy = (p.y - (s.y0 + s.h / 2)) / (s.h / 2);
    const ax = Math.abs(dx), az = Math.abs(dz), ay = Math.abs(dy);
    if (ay > ax && ay > az) return new THREE.Vector3(0, Math.sign(dy), 0);
    return ax > az ? new THREE.Vector3(Math.sign(dx), 0, 0) : new THREE.Vector3(0, 0, Math.sign(dz));
  }

  // Осколки стекла летят наружу от фасада
  spawnGlass(p, n, count, speed, spread = 2) {
    const gd = this.fx.glass;
    if (!gd) return;
    for (let i = 0; i < count; i++) {
      const s = 0.15 + Math.random() * 0.55;
      gd.spawn(
        p.x + (Math.random() - 0.5) * spread * 2, p.y + (Math.random() - 0.5) * spread, p.z + (Math.random() - 0.5) * spread * 2,
        s, 0.025, s * (0.6 + Math.random() * 0.8),
        n.x * speed * (0.4 + Math.random()) + (Math.random() - 0.5) * 6,
        n.y * speed * 0.5 + Math.random() * 5,
        n.z * speed * (0.4 + Math.random()) + (Math.random() - 0.5) * 6,
        GLASS_COLOR, 0,
      );
    }
  }

  // Звуковой удар: окна вылетают со стороны пролёта
  shatterWindows(s, from, vel) {
    if (s.glassBroken || (s.type !== 'building' && s.type !== 'shape')) return;
    s.glassBroken = true;
    const cp = this.closestPoint(s, from, new THREE.Vector3());
    const n = this.faceNormal(s, cp);
    this.spawnGlass(cp, n.clone().addScaledVector(vel.clone().normalize(), 0.5).normalize(), 18, 12, Math.min(10, Math.max(s.w, s.h) * 0.4));
    if (Math.random() < 0.3) this.fx.audio?.glass(0.5, cp);
  }

  countBuilding(b) {
    if (b.counted) return;
    b.counted = true;
    this.destroyed++;
    if (this.onDestroyed) this.onDestroyed(b);
  }

  destroySeg(s, point, dir, force) {
    if (!s.alive) return;
    s.alive = false;
    s.hp = 0;
    const b = this.buildings[s.b];
    this.fx.effects.clearDecals?.(s.index);
    this.countBuilding(b);
    this.writeSeg(s);
    this.shatter([s], null, point, dir, force, 0);
    this.fx.audio?.crumble(Math.min(1, (s.w * s.d * s.h) / 15000), b.glass ? 'glass' : 'concrete', point);
    this.onImpact?.(point, Math.max(s.w, s.d) * 0.8, force * 0.5);

    if (b.kind !== 'building') return;
    // Переход между башнями держится на обеих: рушится опора ниже него — падает и он
    if (b.links) for (const ls of b.links) if (ls.alive && ls.y0 >= s.y0) this.startFall(this.buildings[ls.b], [ls], dir, force);
    // Всё, что выше, теряет опору — падает целым куском
    const idx = b.segs.indexOf(s.index);
    const above = [];
    for (let k = idx + 1; k < b.segs.length; k++) {
      const u = this.segs[b.segs[k]];
      if (!u.alive) break;
      above.push(u);
    }
    if (above.length) this.startFall(b, above, dir, force);
    if (b.roof) this.writeRoof(b);
  }

  // Разбивает секции на обломки. xf — матрица преобразования (для падающих кусков)
  shatter(segs, xf, point, dir, force, baseVel) {
    const b = this.buildings[segs[0].b];
    const coarse = segs.length > 6;
    for (const s of segs) {
      const nx = clamp(Math.round(s.w / 5), coarse ? 1 : 2, coarse ? 3 : 5);
      const nz = clamp(Math.round(s.d / 5), coarse ? 1 : 2, coarse ? 3 : 5);
      const ny = clamp(Math.round(s.h / 5), 1, coarse ? 2 : 3);
      const sx = s.w / nx, sy = s.h / ny, sz = s.d / nz;
      for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) {
        _v.set(s.x - s.w / 2 + sx * (i + 0.5), s.y0 + sy * (j + 0.5), s.z - s.d / 2 + sz * (k + 0.5));
        if (xf) _v.applyMatrix4(xf);
        const dx = _v.x - point.x, dy = _v.y - point.y, dz = _v.z - point.z;
        const dist = Math.hypot(dx, dy, dz) + 0.001;
        const push = force * Math.exp(-dist / 18);
        const rad = push * 0.45 / dist;
        const delay = xf ? Math.random() * 0.05 : Math.min(dist / 90, 0.8) + Math.random() * 0.1;
        this.fx.debris.spawn(
          _v.x, _v.y, _v.z,
          sx * (0.75 + Math.random() * 0.2), sy * (0.75 + Math.random() * 0.2), sz * (0.75 + Math.random() * 0.2),
          dir.x * push * 0.7 + dx * rad + (Math.random() - 0.5) * 4,
          (baseVel || 0) * 0.3 + dir.y * push * 0.5 + dy * rad * 0.5 + Math.random() * 3,
          dir.z * push * 0.7 + dz * rad + (Math.random() - 0.5) * 4,
          b.color, delay,
        );
      }
      // Плиты перекрытий и арматура
      if (s.type === 'building' && s.w > 6) {
        const slabs = coarse ? 1 : 2;
        for (let i = 0; i < slabs; i++) {
          _v.set(s.x + (Math.random() - 0.5) * s.w * 0.3, s.y0 + s.h * (i + 0.5) / slabs, s.z + (Math.random() - 0.5) * s.d * 0.3);
          if (xf) _v.applyMatrix4(xf);
          this.fx.debris.spawn(_v.x, _v.y, _v.z, s.w * 0.55, 0.35, s.d * 0.35,
            dir.x * force * 0.3 + (Math.random() - 0.5) * 6, (baseVel || 0) * 0.3 + Math.random() * 3, dir.z * force * 0.3 + (Math.random() - 0.5) * 6,
            SLAB_COLOR, Math.random() * 0.3);
        }
        const rods = coarse ? 2 : 5;
        for (let i = 0; i < rods; i++) {
          _v.set(s.x + (Math.random() - 0.5) * s.w, s.y0 + Math.random() * s.h, s.z + (Math.random() - 0.5) * s.d);
          if (xf) _v.applyMatrix4(xf);
          this.fx.debris.spawn(_v.x, _v.y, _v.z, 0.07, 2 + Math.random() * 3, 0.07,
            dir.x * force * 0.5 + (Math.random() - 0.5) * 10, Math.random() * 6, dir.z * force * 0.5 + (Math.random() - 0.5) * 10,
            REBAR_COLOR, Math.random() * 0.4);
        }
        // Стекло
        _v.set(s.x, s.y0 + s.h * 0.5, s.z);
        if (xf) _v.applyMatrix4(xf);
        this.spawnGlass(_v, dir, coarse ? 6 : (b.glass ? 30 : 12), force * 0.4 + 6, Math.max(s.w, s.d) * 0.5);
      }
      // Пыль: густая и висит долго
      const n = clamp(Math.round((s.w + s.d) / 10), 2, 8);
      for (let i = 0; i < n; i++) {
        _v.set(s.x + (Math.random() - 0.5) * s.w, s.y0 + s.h * 0.5, s.z + (Math.random() - 0.5) * s.d);
        if (xf) _v.applyMatrix4(xf);
        this.fx.dust.burst(_v, 1, { size: [12, 30], speed: 4, life: [12, 22], delay: 0.6, rise: 0.8, alpha: 0.8 });
      }
    }
  }

  // ================================================================ падающие верхушки
  startFall(b, segs, dir, force) {
    for (const s of segs) { s.alive = false; this.writeSeg(s); this.fx.effects.clearDecals?.(s.index); }
    if (b.roof) this.writeRoof(b);

    // Падающий кусок рисуется теми же сетками, что и сами секции (коробка или формы):
    // по одной на каждую сетку, с общими номерами секций (чужие — нулевые)
    const mesh = new THREE.Group();
    mesh.matrixAutoUpdate = false;
    for (const src of new Set(segs.map((s) => s.mesh))) {
      const part = new THREE.InstancedMesh(src.geometry, src.material, segs.length);
      segs.forEach((s, i) => {
        part.setMatrixAt(i, s.mesh === src ? this.segMatrix(s, _m) : _zero);
        _c.copy(s.color || b.color).multiplyScalar(0.55 + 0.45 * (s.hp / s.maxHp));
        part.setColorAt(i, _c);
      });
      part.castShadow = part.receiveShadow = true;
      part.frustumCulled = false;
      mesh.add(part);
    }
    this.scene.add(mesh);

    const base = segs[0];
    const topY = segs[segs.length - 1].y0 + segs[segs.length - 1].h;
    // Наклон — в сторону удара (по горизонтали)
    const tilt = new THREE.Vector3(dir.x, 0, dir.z);
    if (tilt.lengthSq() < 1e-4) tilt.set(Math.random() - 0.5, 0, Math.random() - 0.5);
    tilt.normalize();
    const axis = new THREE.Vector3(tilt.z, 0, -tilt.x); // поворот вокруг этой оси наклоняет верх в сторону tilt
    const pivot = new THREE.Vector3(b.x + tilt.x * base.w / 2, base.y0, b.z + tilt.z * base.d / 2);
    const height = topY - base.y0;

    this.falling.push({
      b, segs, mesh, pivot, axis, tilt, height, base, crushed: 0,
      angle: 0, angVel: 0.05 + Math.min(0.6, force / 300), drop: 0, vy: 0, t: 0,
      supportY: this.supportBelow(b, base),
      hitSet: new Set(),
    });
  }

  // Верх уцелевшей части здания (или земля)
  supportBelow(b, base) {
    let y = groundHeight(b.x, b.z);
    for (const si of b.segs) {
      const s = this.segs[si];
      if (s.alive && s.y0 + s.h <= base.y0 + 0.01) y = Math.max(y, s.y0 + s.h);
    }
    return y;
  }

  updateFalling(dt) {
    const g = DEBRIS.gravity;
    for (let i = this.falling.length - 1; i >= 0; i--) {
      const f = this.falling[i];
      f.t += dt;
      f.vy -= g * dt;
      f.drop += f.vy * dt;
      // Опрокидывание ускоряется, как у падающего столба
      f.angVel += Math.sin(Math.max(f.angle, 0.05)) * (6 / Math.max(10, f.height)) * dt * 9;
      f.angle = Math.min(f.angle + f.angVel * dt, Math.PI / 2);

      const xf = this.fallMatrix(f, _m2);
      f.mesh.matrix.copy(xf);
      f.mesh.matrixWorldNeedsUpdate = true;

      // Нижняя точка куска и его верхушка в мире
      const baseY = f.segs[0].y0 + f.drop;
      const topLocal = new THREE.Vector3(f.b.x, f.base.y0 + f.height, f.b.z).applyMatrix4(xf);

      // Верхушка задевает соседние здания
      if (f.angle > 0.2) {
        const hits = this.sphereQuery(topLocal, 6, []);
        for (const s of hits) {
          if (s.b === f.b.index || f.hitSet.has(s.index)) continue;
          f.hitSet.add(s.index);
          this.damage(s, 200 + f.height * 4, topLocal.clone(), f.tilt, 25);
        }
      }

      const topDown = topLocal.y <= groundHeight(topLocal.x, topLocal.z) + 2 || f.t > 7;
      // Прогрессирующее обрушение: нижняя секция куска ломается об уцелевшую часть,
      // остальное продолжает падать и опрокидываться
      if (!topDown && baseY <= f.supportY && f.segs.length > 2 && f.supportY > groundHeight(f.b.x, f.b.z) + 1) {
        const s = f.segs.shift();
        for (const part of f.mesh.children) { part.setMatrixAt(f.crushed, _zero); part.instanceMatrix.needsUpdate = true; }
        f.crushed++;
        const p = new THREE.Vector3(f.b.x, f.supportY, f.b.z);
        this.shatter([s], xf, p, f.tilt, 15, f.vy);
        const stub = f.b.segs.map((si) => this.segs[si]).filter((u) => u.alive && u.y0 < f.supportY);
        if (stub.length) this.damage(stub[stub.length - 1], 60 + f.segs.length * 30, p, new THREE.Vector3(0, -1, 0), 15);
        f.supportY = this.supportBelow(f.b, f.base);
        f.vy *= 0.35;
        f.angVel += 0.08;
        this.fx.audio?.crumble(0.4, 'concrete', p);
        continue;
      }
      const landed = baseY <= f.supportY || topDown;
      if (landed) {
        const impactPoint = new THREE.Vector3(f.pivot.x, Math.max(f.supportY, f.pivot.y + f.drop), f.pivot.z);
        this.shatter(f.segs, xf, impactPoint, f.tilt, 25 + Math.min(60, -f.vy), f.vy);
        // Удар по уцелевшей части здания
        const stub = f.b.segs.map((si) => this.segs[si]).filter((s) => s.alive);
        if (stub.length) this.damage(stub[stub.length - 1], 80 + f.segs.length * 40, impactPoint, new THREE.Vector3(0, -1, 0), 20);
        this.fx.dust.burst(impactPoint, 24, { size: [10, 22], speed: 25, life: [4, 8], flat: true });
        this.fx.audio?.crumble(Math.min(1, f.segs.length / 8), 'concrete', impactPoint);
        this.onImpact?.(impactPoint, 30 + f.height * 0.5, 40);
        this.scene.remove(f.mesh);
        for (const part of f.mesh.children) part.dispose();
        this.falling.splice(i, 1);
      }
    }
  }

  // T(pivot + drop) · R(axis, angle) · T(-pivot): окна остаются «приклеены» к куску
  fallMatrix(f, out) {
    _q.setFromAxisAngle(f.axis, f.angle);
    out.makeTranslation(-f.pivot.x, -f.pivot.y, -f.pivot.z);
    _m.makeRotationFromQuaternion(_q).premultiply(new THREE.Matrix4().makeTranslation(f.pivot.x, f.pivot.y + f.drop, f.pivot.z));
    return out.premultiply(_m);
  }

  // Урон по площади (мощный удар, удар о землю, взрыв)
  damageRadius(center, radius, damage, force, dirHint = null) {
    const hits = this.sphereQuery(center, radius, []);
    const cp = new THREE.Vector3(), dir = new THREE.Vector3();
    let count = 0;
    // Сначала нижние секции — чтобы верх падал целым куском, а не рассыпался
    hits.sort((a, b) => a.y0 - b.y0);
    for (const s of hits) {
      if (!s.alive) continue;
      this.closestPoint(s, center, cp);
      const f = 1 - cp.distanceTo(center) / radius;
      dir.subVectors(cp, center);
      if (dir.lengthSq() < 1e-4) dir.set(0, 1, 0);
      dir.normalize();
      if (dirHint) dir.lerp(dirHint, 0.5).normalize();
      if (this.damage(s, damage * (0.35 + 0.65 * f), cp, dir, force * (0.4 + 0.6 * f))) count++;
    }
    this.onImpact?.(center, radius * 1.4, force);
    return count;
  }

  update(dt) { this.updateFalling(dt); }

  reset() {
    for (const f of this.falling) { this.scene.remove(f.mesh); for (const part of f.mesh.children) part.dispose(); }
    this.falling.length = 0;
    for (const r of this.runs) { r.whole = true; this.writeRun(r); for (const sg of r.segs) sg.slot = -1; }
    for (const m of this.segMeshes) { m.count = m.userData.next = m.userData.base; m.computeBoundingSphere(); }
    for (const s of this.segs) { s.alive = true; s.hp = s.maxHp; s.glassBroken = false; this.writeSeg(s, true); }
    for (const b of this.buildings) { b.counted = false; if (b.roof) this.writeRoof(b); }
    this.destroyed = 0;
  }
}

// Двускатная крыша: основание 1×1 на y=0, конёк вдоль X на y=1
function makeGableGeometry() {
  const g = new THREE.BufferGeometry();
  const v = [
    -0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 1, 0, -0.5, 1, 0, // скат -Z
    0.5, 0, 0.5, -0.5, 0, 0.5, -0.5, 1, 0, 0.5, 1, 0,   // скат +Z
    -0.5, 0, 0.5, -0.5, 0, -0.5, -0.5, 1, 0,            // фронтон -X
    0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 1, 0,               // фронтон +X
  ];
  const idx = [0, 2, 1, 0, 3, 2, 4, 6, 5, 4, 7, 6, 8, 10, 9, 11, 13, 12];
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Материал зданий: фасады рисуются шейдером в координатах «здания»
// (instanceMatrix без modelMatrix), поэтому окна не растягиваются
// и остаются на месте, когда верхушка падает и вращается.
// Тип фасада определяется по цвету здания: стеклянный небоскрёб, кирпич,
// офис с пилястрами, жилой дом с балконами. За окнами — комнаты с объёмом
// (упрощённый interior mapping): видны пол, потолок, стены, ночью — свет.
function createBuildingMaterial() {
  // Чуть ниже альбедо: реальные фасады темнее, чем «чистые» цвета палитры
  const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.82, 0.82, 0.82), roughness: 0.78, metalness: 0.04 });
  mat.userData.uNight = { value: 0 };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = mat.userData.uNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBPos;\nvarying vec3 vBNrm;\nvarying vec2 vEdge;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        {
          vec4 bp = vec4(transformed, 1.0);
          vec3 bn = objectNormal;
          #ifdef USE_INSTANCING
            bp = instanceMatrix * bp;
            bn = mat3(instanceMatrix) * bn;
          #endif
          vBPos = bp.xyz;
          // Расстояние до вертикальных рёбер здания (м) — для мягкого затенения углов
          #ifdef USE_INSTANCING
            vEdge = vec2((0.5 - abs(position.z)) * length(instanceMatrix[2].xyz), (0.5 - abs(position.x)) * length(instanceMatrix[0].xyz));
          #else
            vEdge = vec2(9.0);
          #endif
          vBNrm = normalize(bn);
        }`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vBPos;
        varying vec3 vBNrm;
        varying vec2 vEdge;
        uniform float uNight;
        float bh21(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 15731.743); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float winMask = 0.0;
        float winRnd = 0.0;
        float isGlass = 0.0;
        vec3 interior = vec3(0.0);
        {
          vec3 an = abs(vBNrm);
          float wall = 1.0 - step(0.7, an.y);
          bool xFace = an.x > an.z;
          vec2 fuv = xFace ? vBPos.zy : vBPos.xy;

          // Тип фасада по цвету здания (нормированный цвет не меняется от повреждений)
          vec3 bc = vec3(0.6);
          #if defined(USE_INSTANCING_COLOR) || defined(USE_COLOR)
            bc = vColor.rgb;
          #endif
          vec3 nc = bc / (max(max(bc.r, bc.g), bc.b) + 1e-3);
          float styleRnd = fract(sin(dot(nc, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
          isGlass = step(1.12, nc.b / max(nc.r, 0.01));
          float isBrick = step(1.25, nc.r / max(nc.g, 0.01)) * (1.0 - isGlass);
          float isRes = (1.0 - isGlass) * (1.0 - isBrick) * step(0.5, styleRnd);
          float isOffice = (1.0 - isGlass) * (1.0 - isBrick) * (1.0 - isRes);

          vec2 cellSize = mix(vec2(3.0, 3.6), vec2(1.6, 3.6), isGlass);
          vec2 cell = fuv / cellSize;
          vec2 f = fract(cell);
          vec2 id = floor(cell);
          winRnd = bh21(id + floor(vBPos.xz * 0.01));

          // Проём окна для каждого типа (x0, x1, y0, y1)
          vec4 rect = vec4(0.14, 0.86, 0.22, 0.82);
          rect = mix(rect, vec4(0.03, 0.97, 0.05, 0.96), isGlass);
          rect = mix(rect, vec4(0.26, 0.74, 0.28, 0.80), isBrick);
          rect = mix(rect, vec4(0.18, 0.82, 0.32, 0.86), isRes);
          // Первый этаж — витрины
          float storefront = (1.0 - step(4.4, vBPos.y)) * (1.0 - isGlass);
          rect = mix(rect, vec4(0.05, 0.95, 0.04, 0.80), storefront);
          float w = step(rect.x, f.x) * step(f.x, rect.y) * step(rect.z, f.y) * step(f.y, rect.w);
          winMask = w * wall;

          // ---- Стена ----
          vec3 wallCol = diffuseColor.rgb;
          // Кирпичная кладка
          vec2 bu = fuv / vec2(0.25, 0.075);
          bu.x += step(1.0, mod(floor(bu.y), 2.0)) * 0.5;
          vec2 bf = fract(bu);
          // Вдали кладка мельче пикселя — заменяем её средним тоном (иначе муар)
          vec2 bw = fwidth(bu);
          float bfade = 1.0 - smoothstep(0.25, 0.6, max(bw.x, bw.y));
          float mortar = 1.0 - step(0.07, bf.x) * step(0.12, bf.y);
          vec3 brick = wallCol * mix(0.97, 0.82 + 0.3 * bh21(floor(bu)), bfade);
          brick = mix(brick, vec3(0.55, 0.53, 0.5) * 0.8, mix(0.13, mortar * 0.7, bfade));
          wallCol = mix(wallCol, brick, isBrick);
          // Пилястры у офисов
          float pil = step(fract(cell.x * 0.5), 0.06);
          wallCol *= 1.0 + pil * 0.12 * isOffice;
          // Балконы у жилых домов: плита и тень под ней
          float slab = step(0.2, f.y) * step(f.y, 0.3) * step(0.1, f.x) * step(f.x, 0.9);
          wallCol = mix(wallCol, wallCol * 1.18, slab * isRes);
          wallCol *= 1.0 - step(0.3, f.y) * step(f.y, 0.34) * 0.35 * isRes;
          // Стеклянный небоскрёб: перемычки между этажами — тёмная сталь
          wallCol = mix(wallCol, vec3(0.16, 0.18, 0.2), isGlass);
          // Межэтажные пояса, потёки, затенение у земли
          wallCol *= 1.0 - step(0.93, f.y) * 0.15 * (1.0 - isGlass);
          wallCol *= 0.93 + 0.07 * bh21(vec2(floor(fuv.x * 1.5), 7.0));
          wallCol *= mix(0.55, 1.0, smoothstep(0.0, 4.0, vBPos.y));

          // ---- Комната за окном (interior mapping) ----
          vec2 wuv = clamp((f - rect.xz) / (rect.yw - rect.xz), 0.0, 1.0);
          vec3 V = normalize(vBPos - cameraPosition);
          vec3 N = normalize(vBNrm);
          vec3 T = xFace ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
          vec3 rd = vec3(dot(V, T), V.y, -dot(V, N));
          // Ограничиваем компоненты ДО деления: драйвер может посчитать обе ветки
          // условия, и деление на ноль даст бесконечность → NaN → чёрные блоки от bloom
          rd.x = sign(rd.x + 1e-7) * max(abs(rd.x), 1e-3);
          rd.y = sign(rd.y + 1e-7) * max(abs(rd.y), 1e-3);
          rd.z = max(rd.z, 0.04);
          float depth = 1.3;
          vec3 ro = vec3(wuv, 0.0);
          vec3 tt = vec3(
            (step(0.0, rd.x) - ro.x) / rd.x,
            (step(0.0, rd.y) - ro.y) / rd.y,
            depth / rd.z);
          float t = min(min(tt.x, tt.y), tt.z);
          vec3 hit = ro + rd * t;
          vec3 tint = mix(vec3(0.78, 0.72, 0.62), vec3(0.62, 0.68, 0.76), fract(winRnd * 13.7));
          vec3 room;
          if (t == tt.z) {
            room = tint * 0.85;
            room *= 1.0 - step(hit.y, 0.32) * 0.45 * step(0.4, fract(winRnd * 5.1)); // мебель у стены
          } else if (t == tt.y) {
            room = rd.y > 0.0 ? vec3(0.92) : vec3(0.42, 0.33, 0.26) * (0.8 + 0.4 * tint.r); // потолок / пол
          } else {
            room = tint * 0.62;
          }
          room *= exp(-hit.z * 0.55);
          // Жалюзи в части окон
          float blinds = step(0.82, fract(winRnd * 3.7)) * step(0.5, fract(wuv.y * 14.0));
          room = mix(room, vec3(0.75, 0.73, 0.7), blinds * 0.85);
          interior = room;

          vec3 glassTint = mix(vec3(0.55, 0.68, 0.78), vec3(0.45, 0.55, 0.6), isGlass);
          vec3 winCol = interior * glassTint * 0.32;
          diffuseColor.rgb = mix(wallCol, winCol, winMask);
          // Мягкая тень у углов фасада (рассеянный свет хуже попадает в углы)
          float edgeD = xFace ? vEdge.x : vEdge.y;
          diffuseColor.rgb *= mix(1.0, mix(0.8, 1.0, smoothstep(0.0, 1.8, edgeD)), wall);
          // Рамы окон
          vec2 fr = abs(f - (rect.xz + rect.yw) * 0.5) - (rect.yw - rect.xz) * 0.5;
          float frame = winMask * step(-0.025, max(fr.x / cellSize.y * cellSize.x, fr.y));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.12, 0.13, 0.14), frame * (1.0 - isGlass) * 0.8);
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.05, winMask);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        metalnessFactor = mix(metalnessFactor, mix(0.35, 0.6, isGlass), winMask);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          // Свет в комнатах: днём редкие, ночью — большинство
          float lit = step(mix(0.93, 0.6, uNight), winRnd);
          vec3 warm = mix(vec3(1.0, 0.8, 0.52), vec3(0.78, 0.87, 1.0), step(0.8, fract(winRnd * 7.3)));
          totalEmissiveRadiance += winMask * lit * warm * (interior * 1.4 + 0.08) * mix(0.25, 1.35, uNight);
        }`);
  };
  return mat;
}

// Геометрии деталей (точка опоры — на крыше / на фасаде). Атрибуты:
// tint — брать цвет экземпляра (щиты, неон), glow — светится.
function makeAttachmentGeometries() {
  const part = (geo, color, tint = 0, glow = 0) => {
    if (geo.index) geo = geo.toNonIndexed();
    geo.deleteAttribute('uv');
    const c = new THREE.Color(color), n = geo.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('tint', new THREE.BufferAttribute(new Float32Array(n).fill(tint), 1));
    geo.setAttribute('glow', new THREE.BufferAttribute(new Float32Array(n).fill(glow), 1));
    return geo;
  };
  const B = (w, h, d, x, y, z) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
  const C = (r, h, x, y, z, s = 10) => new THREE.CylinderGeometry(r, r, h, s).translate(x, y, z);
  const merge = (l) => mergeGeometries(l);
  return {
    // Кондиционер: корпус, решётка вентилятора сверху
    ac: merge([part(B(2.2, 1.1, 1.4, 0, 0.55, 0), 0xb9bcbf), part(C(0.45, 0.06, 0.45, 1.13, 0), 0x2a2c2e), part(B(0.25, 0.3, 0.25, -0.8, 1.25, 0), 0x8a8d90)]),
    // Бак для воды на опорах (как на старых крышах)
    tank: merge([
      part(C(1.3, 2.4, 0, 2.4, 0, 14), 0x6b5240), part(new THREE.ConeGeometry(1.4, 0.7, 14).translate(0, 3.95, 0), 0x4a3a2e),
      ...[[-0.8, -0.8], [0.8, -0.8], [-0.8, 0.8], [0.8, 0.8]].map(([x, z]) => part(B(0.15, 1.2, 0.15, x, 0.6, z), 0x3a3c3e)),
    ]),
    vent: merge([part(C(0.35, 1.8, 0, 0.9, 0), 0x9a9da0), part(C(0.5, 0.25, 0, 1.85, 0), 0x6a6d70)]),
    antenna: merge([part(C(0.05, 6, 0, 3, 0, 5), 0x7a7d80), part(B(1.2, 0.05, 0.05, 0, 4.2, 0), 0x7a7d80), part(B(0.8, 0.05, 0.05, 0, 5.2, 0), 0x7a7d80),
      part(new THREE.SphereGeometry(0.12, 6, 4).translate(0, 6.05, 0), 0xff2020, 0, 1)]),
    // Щит 10×3.5 м на двух опорах (масштабируется по длине)
    board: merge([
      part(B(10, 3.5, 0.15, 0, 4.25, 0), 0xffffff, 1, 1),
      part(B(10.3, 3.8, 0.1, 0, 4.25, -0.12), 0x2b2d30),
      part(B(0.25, 2.5, 0.25, -3.5, 1.25, -0.3), 0x3a3c3e), part(B(0.25, 2.5, 0.25, 3.5, 1.25, -0.3), 0x3a3c3e),
      part(B(10, 0.1, 0.8, 0, 2.45, 0.3), 0x3a3c3e),
    ]),
    // Вертикальная вывеска торчит из стены; горизонтальная — над входом
    // Вход: дверь (стекло в раме), козырёк, ступенька, два фонарика
    door: merge([
      part(B(1.9, 2.5, 0.12, 0, 1.25, 0.04), 0x2a2c30), part(B(1.6, 2.2, 0.14, 0, 1.15, 0.05), 0x1a2834),
      part(B(0.06, 2.2, 0.16, 0, 1.15, 0.06), 0x8a8d92),
      part(B(2.8, 0.14, 1.4, 0, 2.9, 0.7), 0x3a3c40), part(B(2.4, 0.15, 0.6, 0, 0.07, 0.3), 0x9a968e),
      part(B(0.15, 0.25, 0.15, -1.2, 2.3, 0.12), 0xfff0c8, 0, 1), part(B(0.15, 0.25, 0.15, 1.2, 2.3, 0.12), 0xfff0c8, 0, 1),
    ]),
    // Маркиза 4 м (масштабируется по длине): наклонное полотно (цвет экземпляра) и кронштейны
    awning: merge([
      part(B(4, 0.06, 1.8, 0, 3.3, 0.85).rotateX(0.32).translate(0, 0.3, 0), 0xffffff, 1),
      part(B(4, 0.35, 0.04, 0, 2.95, 1.72), 0xffffff, 1),
      part(B(0.05, 0.05, 1.7, -1.9, 3.2, 0.85), 0x2a2a2a), part(B(0.05, 0.05, 1.7, 1.9, 3.2, 0.85), 0x2a2a2a),
    ]),
    // Пожарная лестница (один этаж): площадка с перилами и марш вниз
    fireescape: merge([
      part(B(3.2, 0.08, 1.2, 0, 0, 0.6), 0x2a2522), part(B(3.2, 0.9, 0.05, 0, 0.45, 1.2), 0x2a2522),
      part(B(0.05, 0.9, 1.2, -1.6, 0.45, 0.6), 0x2a2522), part(B(0.05, 0.9, 1.2, 1.6, 0.45, 0.6), 0x2a2522),
      part(new THREE.BoxGeometry(3.6, 0.06, 0.55).rotateZ(0.85).translate(0, -1.8, 0.85), 0x2a2522),
    ]),
    // Карниз: плита по периметру крыши (масштабируется под здание)
    cornice: merge([part(B(1, 0.5, 1, 0, 0.25, 0), 0xc8c0b0), part(B(0.98, 0.25, 0.98, 0, -0.1, 0), 0xa8a090)]),
    neonV: merge([part(B(0.35, 3.4, 1.3, 0, 0, 0.75), 0xffffff, 1, 1), part(B(0.45, 3.6, 0.1, 0, 0, 0.05), 0x222326)]),
    beacon: merge([part(C(0.12, 0.6, 0, 0.3, 0, 5), 0x3a3c3e), part(new THREE.SphereGeometry(0.32, 8, 6).translate(0, 0.75, 0), 0xffffff, 1, 2)]),
    neonH: merge([part(B(3.2, 0.7, 0.18, 0, 0, 0.12), 0xffffff, 1, 1), part(B(3.4, 0.85, 0.06, 0, 0, 0.02), 0x222326)]),
  };
}

// Материал деталей: щиты и неон берут цвет экземпляра и светятся (ночью — ярко, неон мерцает)
function createAttachmentMaterial(uNight, uTime) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.3 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = uNight;
    shader.uniforms.uTime = uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float tint;\nattribute float glow;\nvarying float vGlow;\nvarying vec3 vLoc;\nvarying float vSeed;')
      .replace('#include <color_vertex>', `
        vColor.rgb = color.rgb;
        #ifdef USE_INSTANCING_COLOR
          vColor.rgb *= mix(vec3(1.0), instanceColor.rgb, tint);
        #endif
        vGlow = glow;
        vLoc = position;
        vSeed = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight, uTime;\nvarying float vGlow;\nvarying vec3 vLoc;\nvarying float vSeed;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        // Абстрактный «плакат»: диагональные полосы и светлое поле
        float poster = 0.6 + 0.4 * smoothstep(-0.3, 0.3, sin(vLoc.x * 0.9 + vLoc.y * 1.7 + vSeed * 6.0));
        poster *= 1.0 - 0.35 * step(0.55, fract(vLoc.x * 0.12 + vSeed));
        diffuseColor.rgb *= mix(1.0, poster, vGlow);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          float flick = 0.85 + 0.15 * sin(uTime * (2.0 + vSeed * 5.0) + vSeed * 40.0);
          flick *= step(0.04, fract(uTime * 0.13 + vSeed)); // изредка гаснет на миг
          float neon = min(vGlow, 1.0) * mix(0.18, 2.6, uNight) * mix(1.0, flick, uNight);
          // glow = 2: заградительный огонь — медленно мигает, виден и днём
          float beacon = step(1.5, vGlow) * smoothstep(0.35, 0.5, fract(uTime * 0.55 + vSeed * 0.3)) * mix(1.5, 6.0, uNight);
          totalEmissiveRadiance += diffuseColor.rgb * mix(neon, beacon, step(1.5, vGlow));
        }`);
  };
  return mat;
}
