import { mulberry32, smoothstep } from '../utils.js';
import { CITY } from '../config.js';

const G = CITY.grid, GH = G * CITY.block * 0.5;   // 112 кварталов, край сетки 5600 м

// Сарыдала — степная столица (вторая карта Симулятора). Здесь только данные плана:
// река, районы, проспекты, площади. Здания ставит steppecity.js, общие системы
// (земля, транспорт, люди) читают план через layout.js.
//
// Река течёт с запада на восток широкой S-образной излучиной. Южный (левый) берег —
// новый город: деловой центр, парадная ось, жилые комплексы. Северный (правый) —
// старый: сталинки в центре, панельные микрорайоны, промзона на востоке.
// Вокруг — частный сектор и открытая степь до горизонта.

// ---------------------------------------------------------------- река
export const riverZ = (x) => 100 + 520 * Math.sin(x * 0.0006 + 0.3) + 90 * Math.sin(x * 0.0017 + 1.0);
export const riverHW = (x) => 125 + 25 * Math.sin(x * 0.0009 + 1.0);
// Пляжи на внутренних изгибах: x центра, берег (1 — южный, −1 — северный), полудлина
export const BEACHES = [
  { x: -2350, side: -1, len: 260 },
  { x: 1500, side: -1, len: 320 },
  { x: 3500, side: 1, len: 220 },
];
// 0..1: насколько в точке (x, берег) пляж — пологий песчаный спуск вместо гранита
export function beachK(x, side) {
  let k = 0;
  for (const b of BEACHES) if (b.side === side) k = Math.max(k, 1 - smoothstep(b.len * 0.7, b.len, Math.abs(x - b.x)));
  return k;
}
// То же самое для шейдеров (одинаковые формулы — вода, земля и физика совпадают)
export const RIVER_GLSL = `
  float riverZ(float x) { return 100.0 + 520.0 * sin(x * 0.0006 + 0.3) + 90.0 * sin(x * 0.0017 + 1.0); }
  float riverHW(float x) { return 125.0 + 25.0 * sin(x * 0.0009 + 1.0); }
  float beachK(float x, float side) {
    float k = 0.0;
    ${BEACHES.map((b) => `if (side * ${b.side.toFixed(1)} > 0.0) k = max(k, 1.0 - smoothstep(${(b.len * 0.7).toFixed(1)}, ${b.len.toFixed(1)}, abs(x - (${b.x.toFixed(1)}))));`).join('\n    ')}
    return k;
  }`;
// Ширина откоса берега: у гранитной набережной крутой, на пляже пологий
export const bankRun = (x, side) => 6 + 34 * beachK(x, side);

// ---------------------------------------------------------------- районы
// Ключи те же, что у приморского города: их читают земля, звуки, животные
export const S_DISTRICTS = {
  downtown: { x: 250, z: 1350, r: 620, h: 330 },     // деловой центр на левом берегу у оси
  midtown: { x: -1250, z: 900, r: 420, h: 250 },     // западный деловой квартал у реки
  westgate: { x: 450, z: -750, r: 380, h: 190 },     // старый деловой центр правого берега
  southside: { x: 1950, z: 2650, r: 450, h: 240 },   // новый южный деловой район
  newcity: { x: -2300, z: 2550, r: 650, h: 230 },    // новые высотные жилые комплексы на юго-западе
  oldtown: { x: 1050, z: -350, r: 650 },             // старый центр: сталинки, кирпич, бульвары
  sleeper: { x: -1750, z: -1750, r: 1300 },          // панельные микрорайоны правого берега
  campus: { x: 2650, z: -1650, r: 280 },             // университет
  // Внешнее кольцо (город вырос до 11 км)
  eastjk: { x: 3700, z: 2400, r: 750 },              // новый восточный жилой массив с башнями
  northmd: { x: 900, z: -3500, r: 1200 },            // северные микрорайоны 80-х
  westmd: { x: -3900, z: 300, r: 900 },              // западные микрорайоны вдоль реки
  southold: { x: -900, z: 3700, r: 700 },            // южный посёлок 50-х: сталинки и кирпич
  techpark: { x: -3300, z: -3300, r: 520 },          // технопарк: офисы среднего роста
};
export const S_LANDMARK = { x: -350, z: 1750 };       // центральная башня на оси
export const S_TV_TOWER = { x: 1e6, z: 1e6 };         // телебашни нет
export const S_BIG_PARK = { minX: -1000, minZ: -800, maxX: -400, maxZ: -300 };
export const S_POND = { x: -700, z: -560, r: 70 };
export const S_STADIUM = { x: 2050, z: 2150 };

// Парадная ось левого берега: площади 3×3 вдоль одной линии. Свои постройки (steppecity.js):
// торговый центр-купол, бульвары с фонтанами, башня «Шанырак», концертный зал-«лента»
export const S_AXIS = {
  z: 1750,
  kinds: [[-1550, 'mallDome'], [-1250, 'boulevard'], [-950, 'boulevard'], [-650, 'boulevard'], [-350, 'shanyrak'],
    [-50, 'boulevard'], [250, 'boulevard'], [550, 'ribbonHall']],
};
// Отдельные доминанты: большая мечеть на правом берегу, пирамида-дворец культуры,
// выставочная сфера на юго-востоке, цирк-«шатёр» в старом центре
export const S_AXIS_EXTRA = [[-2450, -1050, 'grandMosque'], [1450, 1350, 'ziggurat'], [2950, 3150, 'expoSphere'], [1550, -1050, 'circus']];

// Городки вокруг: дачи и аулы (центры кратны 100 м)
export const S_TOWNS = [
  { x: -9000, z: -4000, grid: 8, seed: 71 },
  { x: -2000, z: 10500, grid: 10, seed: 72 },
  { x: 9500, z: -9000, grid: 7, seed: 73 },
  { x: 10500, z: 4500, grid: 9, seed: 74 },
  { x: 2500, z: -12000, grid: 6, seed: 75 },
  { x: -12000, z: 6000, grid: 6, seed: 76 },
];
// Степные озёра — мелкие, с камышом по берегам
export const S_LAKES = [
  { x: -8400, z: 3500, r: 1100 },
  { x: 6500, z: -6000, r: 800 },
  { x: -5200, z: -8500, r: 650 },
  { x: 8200, z: 7600, r: 900 },
  { x: 14000, z: -1500, r: 1300 },
];

// ---------------------------------------------------------------- проспекты
// Проспекты: ряды и колонны кварталов с бульваром и парковками между двумя проезжими
// частями. Шаг неровный (700–900 м) — город делится на микрорайоны разного размера
const AV_COLS = new Set([3, 10, 17, 24, 32, 39, 47, 56, 64, 71, 79, 88, 95, 102, 109]);
const AV_ROWS = new Set([2, 9, 16, 24, 31, 39, 48, 55, 63, 72, 79, 87, 95, 103, 110]);
// Трассы: эти проспекты выходят из города в степь и идут до края карты
const HW_COLS = new Set([32, 79]), HW_ROWS = new Set([31, 72]);

const inCircle = (x, z, D) => Math.hypot(x - D.x, z - D.z) < D.r;
function hash(i, j, s) {
  let h = (i * 374761393 + j * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
// Плавный шум для границ районов (чтобы они не были кругами и квадратами)
function smoothNoise(x, z, s) {
  const ix = Math.floor(x), iz = Math.floor(z);
  let fx = x - ix, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx); fz = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iz, s), b = hash(ix + 1, iz, s), c = hash(ix, iz + 1, s), d = hash(ix + 1, iz + 1, s);
  return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz;
}
// ---------------------------------------------------------------- контур города
// Насколько точка внутри города (м; < 0 — за чертой). Граница — неровный круг вокруг
// центра, вытянутый вдоль реки (город растёт по берегам) и языками вдоль трасс
const HW_X = [...HW_COLS].map((i) => -GH + (i + 0.5) * 100), HW_Z = [...HW_ROWS].map((j) => -GH + (j + 0.5) * 100);
export function urbanScore(x, z) {
  const dx = x, dz = z - 150, d = Math.hypot(dx, dz), th = Math.atan2(dz, dx);
  const R = 4000 + 1000 * (smoothNoise(Math.cos(th) * 1.4 + 5, Math.sin(th) * 1.4 + 5, 21) - 0.5)
    + 600 * (smoothNoise(Math.cos(th) * 4 + 9, Math.sin(th) * 4 + 9, 22) - 0.5)
    - 1800 * smoothstep(GH - 900, GH + 100, Math.max(Math.abs(x), Math.abs(z)));   // к краю сетки — степь, без прямого среза
  const river = 1150 * Math.exp(-(((z - riverZ(x)) / 700) ** 2));
  let hw = 0;
  for (const hx of HW_X) hw = Math.max(hw, 650 * Math.exp(-(((x - hx) / 260) ** 2)));
  for (const hz of HW_Z) hw = Math.max(hw, 650 * Math.exp(-(((z - hz) / 260) ** 2)));
  return R + river + hw * smoothstep(-200, 900, R + river - d + 900) - d;
}
// Мосты через реку — на каждой пятой дороге вдоль Z, только в городе
export const sBridgeRoad = (k) => k % 5 === 0 && urbanScore(-GH + k * 100, riverZ(-GH + k * 100)) > -150;

// Расстояние от квартала (центр, полуразмер) до воды, м (отрицательное — квартал в реке)
export function riverGap(cx, cz, half) {
  let g = Infinity;
  for (let x = cx - half; x <= cx + half; x += 10) g = Math.min(g, Math.abs(cz - riverZ(x)) - riverHW(x) - half);
  return g;
}

// Характер застройки квартала:
// cbd — стеклянные башни, jk — новые жилые комплексы, mid — среднеэтажная смешанная,
// old — сталинки и кирпич, panel — панельный микрорайон, private — частный сектор,
// industrial — заводы и склады, campus — университет
export function steppeZone(x, z) {
  const D = S_DISTRICTS;
  const n = smoothNoise(x * 0.0012, z * 0.0012, 3) - 0.5;          // крупные пятна
  const s = urbanScore(x, z);
  const left = z > riverZ(x);
  // Выбор — пятнами ~400 м с неровными краями, а не каждой клетке отдельно: район цельный
  const pick = hash(Math.floor(x / 400 + n * 0.9), Math.floor(z / 400 - n * 0.9), 9);
  if (inCircle(x, z, D.campus)) return 'campus';
  if (x > 3300 && !left && z > -3600 && z < riverZ(x) - 350) return 'industrial';
  if (x < -3500 && z > 2900) return 'industrial';
  if (x > 1700 && x < 2600 && z < -3000) return 'industrial';                      // северная база и склады                      // северная база и склады
  if (inCircle(x, z, { x: D.newcity.x, z: D.newcity.z, r: D.newcity.r + n * 300 })) return 'jk';
  if (inCircle(x, z, { x: D.eastjk.x, z: D.eastjk.z, r: D.eastjk.r + n * 300 })) return pick < 0.8 ? 'jk' : 'mid';
  if (inCircle(x, z, { x: D.techpark.x, z: D.techpark.z, r: D.techpark.r + n * 200 })) return 'mid';
  if (s < 150) return pick < 0.3 ? 'jk' : 'private';
  if (s < 550) return pick < 0.15 ? 'private' : left ? 'jk' : 'panel';
  if (Math.hypot(x - D.southold.x, z - D.southold.z) < D.southold.r + n * 250) return pick < 0.7 ? 'old' : 'mid';
  if (Math.hypot(x - D.northmd.x, z - D.northmd.z) < D.northmd.r + n * 350) return pick < 0.85 ? 'panel' : 'mid';
  if (Math.hypot(x - D.westmd.x, z - D.westmd.z) < D.westmd.r + n * 300) return pick < 0.75 ? 'panel' : 'jk';
  if (left) {
    if (Math.hypot(x - D.downtown.x, z - D.downtown.z) < D.downtown.r + n * 200) return 'cbd';
    if (inCircle(x, z, D.midtown) || inCircle(x, z, D.southside)) return pick < 0.7 ? 'cbd' : 'jk';
    return pick < 0.48 ? 'jk' : pick < 0.75 ? 'mid' : 'panel';
  }
  if (inCircle(x, z, D.westgate)) return pick < 0.6 ? 'cbd' : 'old';
  if (Math.hypot(x - D.oldtown.x, z - D.oldtown.z) < D.oldtown.r + n * 250) return pick < 0.8 ? 'old' : 'mid';
  if (Math.hypot(x - D.sleeper.x, z - D.sleeper.z) < D.sleeper.r + n * 400) return pick < 0.88 ? 'panel' : 'mid';
  // Пояс между старым центром и окраиной: панельки вперемешку со сталинками и новыми домами
  const dOld = Math.hypot(x - D.oldtown.x, z - D.oldtown.z);
  return pick < 0.45 ? 'panel' : pick < 0.75 ? 'mid' : dOld < 1500 ? 'old' : 'jk';
}

// Типы кварталов: те же коды, что у приморского города, плюс проспекты, развязки,
// дворы микрорайонов и частный сектор
// Номер характера застройки квартала (для шейдера земли: дворы, плитка, газоны)
export const ZONE_ID = { cbd: 1, jk: 2, mid: 3, old: 4, panel: 5, private: 6, industrial: 7, campus: 8 };
export const S_ZONES = new Uint8Array(G * G);
export function steppeBlockTypes(BLOCK, HALF, g, B) {
  const t = new Uint8Array(g * g), rnd = mulberry32(4242);
  for (let i = 0; i < g; i++) for (let j = 0; j < g; j++) {
    const cx = -HALF + (i + 0.5) * B, cz = -HALF + (j + 0.5) * B;
    const gap = riverGap(cx, cz, B / 2), s = urbanScore(cx, cz);
    let type;
    if (s <= 0) {
      // За чертой города: дачи у края, посёлки пятнами, трассы с лесополосами, остальное — степь
      const fringe = s > -400 && smoothNoise(cx * 0.0022, cz * 0.0022, 42) > 0.5 - s / 1400;
      const village = s > -2600 && smoothNoise(cx * 0.0017 + 3, cz * 0.0017, 43) > 0.73 && gap > 60;
      if (HW_COLS.has(i) || HW_ROWS.has(j)) { type = BLOCK.AVENUE; S_ZONES[j * g + i] = HW_COLS.has(i) ? 4 : 5; }
      else if (fringe || village) { type = BLOCK.PRIVATE; S_ZONES[j * g + i] = ZONE_ID.private; }
      else type = BLOCK.EMPTY;
    } else if (gap < 34) type = BLOCK.RIVER;                                       // берег: набережные и пляжи
    else if (cx > S_BIG_PARK.minX && cx < S_BIG_PARK.maxX && cz > S_BIG_PARK.minZ && cz < S_BIG_PARK.maxZ) type = BLOCK.BIGPARK;
    else if (Math.abs(cx - S_STADIUM.x) < 50 && Math.abs(cz - S_STADIUM.z) < 50) type = BLOCK.STADIUM;
    else if (AV_COLS.has(i) || AV_ROWS.has(j)) {
      // Направление проспекта — в младших битах (1 — вдоль Z, 2 — вдоль X, 3 — перекрёсток-сквер)
      const both = AV_COLS.has(i) && AV_ROWS.has(j);
      S_ZONES[j * g + i] = both ? 3 : AV_COLS.has(i) ? 1 : 2;
      type = both && s > 500 && rnd() < 0.55 ? BLOCK.ROUND : BLOCK.AVENUE;
    }
    // Скверы вдоль набережных — полосами по 300–400 м, с разрывами под застройку у воды
    else if (gap < 140 && s > 500 && hash(Math.floor(cx / 350), cz > riverZ(cx) ? 1 : 0, 17) < 0.55) type = BLOCK.PARK;
    else {
      const zone = steppeZone(cx, cz);
      S_ZONES[j * g + i] = ZONE_ID[zone];
      type = zone === 'panel' ? BLOCK.YARD : zone === 'private' ? BLOCK.PRIVATE : zone === 'industrial' ? BLOCK.INDUSTRIAL : BLOCK.URBAN;
    }
    t[j * g + i] = type;
  }
  return t;
}

// ---------------------------------------------------------------- суперкварталы
// Соседние кварталы одного характера сливаются в большой квартал без улиц внутри:
// микрорайон 300–400 м, жилой комплекс 200–300 м, деловой квартал и сталинки 100–200 м.
// Улицы остаются только между суперкварталами — шахматки из клеток 100 м больше нет.
// JOIN_E / JOIN_N: квартал слит с соседом по +X / +Z (улицы между ними нет)
export const S_SUPER = new Int32Array(G * G).fill(-1);
export const JOIN_E = new Uint8Array(G * G), JOIN_N = new Uint8Array(G * G);
const SIZES = {
  panel: [[4, 3], [3, 4], [4, 4], [3, 3], [3, 2], [2, 3], [2, 2]],
  jk: [[3, 2], [2, 3], [3, 3], [2, 2], [2, 1], [1, 2]],
  cbd: [[2, 2], [2, 1], [1, 2]],
  old: [[2, 2], [2, 1], [1, 2]],
  mid: [[3, 2], [2, 3], [2, 2], [2, 1], [1, 2]],
  ind: [[3, 3], [3, 2], [2, 3], [2, 2]],
};
export function buildSuper(t, BLOCK, g, HALF, B) {
  const supers = [], rnd = mulberry32(777);
  const ZC = ['', 'cbd', 'jk', 'mid', 'old'];
  const cat = (c) => {
    const ty = t[c];
    if (ty === BLOCK.YARD) return 'panel';
    if (ty === BLOCK.INDUSTRIAL) return 'ind';
    if (ty === BLOCK.URBAN && S_ZONES[c] !== ZONE_ID.campus) return ZC[S_ZONES[c]] || 'mid';
    return null;
  };
  for (let j = 0; j < g; j++) for (let i = 0; i < g; i++) {
    const c0 = j * g + i, k = cat(c0);
    if (S_SUPER[c0] >= 0 || !k) continue;
    const opts = SIZES[k].map(([w, h]) => ({ w, h, s: w * h * (0.55 + rnd() * 0.9) })).sort((a, b) => b.s - a.s);
    opts.push({ w: 1, h: 1 });
    let pick = null;
    for (const o of opts) {
      if (i + o.w > g || j + o.h > g) continue;
      let ok = true;
      for (let a = 0; a < o.w && ok; a++) for (let b = 0; b < o.h && ok; b++) {
        const c = (j + b) * g + i + a;
        if (S_SUPER[c] >= 0 || cat(c) !== k) ok = false;
      }
      if (ok) { pick = o; break; }
    }
    const id = supers.length;
    supers.push({ i, j, w: pick.w, h: pick.h, cat: k, x0: -HALF + i * B, z0: -HALF + j * B, x1: -HALF + (i + pick.w) * B, z1: -HALF + (j + pick.h) * B });
    for (let a = 0; a < pick.w; a++) for (let b = 0; b < pick.h; b++) S_SUPER[(j + b) * g + i + a] = id;
  }
  // Улицы, которых нет: внутри суперквартала, между клетками степи, вдоль береговой полосы
  for (let j = 0; j < g; j++) for (let i = 0; i < g; i++) {
    const c = j * g + i;
    const both = (d, ty) => t[c] === ty && t[c + d] === ty;
    const same = (d) => S_SUPER[c] >= 0 && S_SUPER[c] === S_SUPER[c + d];
    if (i < g - 1) JOIN_E[c] = same(1) || both(1, BLOCK.EMPTY) || (both(1, BLOCK.RIVER) && !sBridgeRoad(i + 1)) ? 1 : 0;
    if (j < g - 1) JOIN_N[c] = same(g) || both(g, BLOCK.EMPTY) || both(g, BLOCK.RIVER) ? 1 : 0;
  }
  // Поперечные улицы через проспект, которые ни к чему не ведут (по обе стороны — суперкварталы
  // или степь), тоже убираем: проспект идёт сплошным бульваром
  const avAt = (i, j, zs) => i >= 0 && j >= 0 && i < g && j < g && t[j * g + i] === BLOCK.AVENUE && zs.includes(S_ZONES[j * g + i]);
  for (let j = 0; j < g - 1; j++) for (let i = 1; i < g - 1; i++) {
    if (avAt(i, j, [1, 4]) && avAt(i, j + 1, [1, 4]) && JOIN_N[j * g + i - 1] && JOIN_N[j * g + i + 1]) JOIN_N[j * g + i] = 1;
  }
  for (let j = 1; j < g - 1; j++) for (let i = 0; i < g - 1; i++) {
    if (avAt(i, j, [2, 5]) && avAt(i + 1, j, [2, 5]) && JOIN_E[(j - 1) * g + i] && JOIN_E[(j + 1) * g + i]) JOIN_E[j * g + i] = 1;
  }
  return supers;
}
