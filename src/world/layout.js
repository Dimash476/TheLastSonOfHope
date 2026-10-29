import { CITY, WORLD } from '../config.js';
import { mulberry32, clamp, smoothstep, lerp } from '../utils.js';

// Общая раскладка карты: типы кварталов, районы, река, мосты, набережная,
// парк с прудом, городки вдали, рельеф (горы, озёра, острова).
// Этим модулем пользуются генератор города, шейдер земли, транспорт и физика.

export const BLOCK = {
  URBAN: 0, PARK: 1, SUBURB: 2, RIVER: 3, EMPTY: 4,
  BIGPARK: 5, INDUSTRIAL: 6, PORT: 7, STADIUM: 8, BEACH: 9,
};

export const HALF = CITY.grid * CITY.block * 0.5;          // 2800 м — край сетки
export const PLANE_HALF = HALF + 250;                      // плоская «городская» земля
export const RIVER_Z = -HALF + CITY.riverRow * CITY.block + CITY.block / 2; // центр русла
export const RIVER_HALF_W = CITY.block / 2 - CITY.road / 2 - CITY.sidewalk; // 38 м
export const QUAY_X = HALF + CITY.road / 2 + CITY.sidewalk + 12;          // набережная: восточнее — море
export const SEA_BED = -14;

// Районы (центры и радиусы, м)
export const DISTRICTS = {
  downtown: { x: 0, z: 0, r: 560, h: 270 },
  midtown: { x: 1250, z: -1100, r: 380, h: 210 },
  oldtown: { x: -1100, z: 1000, r: 450 },
};
export const LANDMARK = { x: -50, z: -150 };                // главный небоскрёб
export const BIG_PARK = { minX: -700, minZ: -1500, maxX: -300, maxZ: -1100 };
export const POND = { x: -500, z: -1300, r: 58 };
export const STADIUM = { x: 850, z: 950 };
// Городской пляж на юго-востоке: от прибрежной улицы (x = HALF − 100) песок уходит в море
export const BEACH = { x0: HALF - 100 + CITY.road / 2 + CITY.sidewalk, minZ: 1600, maxZ: 2800, x1: PLANE_HALF };
export const inBeach = (x, z) => x > BEACH.x0 - 0.5 && z > BEACH.minZ && z < BEACH.maxZ && x < BEACH.x1 + 400;
// Пирс развлечений: от набережной над пляжем в море, в конце — широкая площадка с аттракционами
export const PIER = { z: 2150, len: 370, w: 18, platFrom: 230, platW: 66 };
// Высота настила: пологий пандус от набережной до ~4 м над водой
export function pierDeckY(x) {
  const t = x - BEACH.x0;
  return t < 110 ? 0.3 + t * 0.034 : 4.04;
}
// Профиль пляжа: почти ровный сухой песок, потом пологий спуск под воду
export function beachHeight(x) {
  const t = Math.max(0, x - BEACH.x0);
  return t < 90 ? -0.05 - t * 0.004 : -0.41 - (t - 90) * 0.026;
}

// Городки вдали (центры кратны 100 м — дороги совпадают с сеткой шейдера)
export const TOWNS = [
  { x: -8000, z: -6000, grid: 10, seed: 11 },
  { x: -3000, z: 10000, grid: 8, seed: 22 },
  { x: 9000, z: -11000, grid: 6, seed: 33 },
  { x: -11500, z: 1500, grid: 8, seed: 44 },
  { x: 1500, z: -14500, grid: 6, seed: 55 },
];

const inRect = (x, z, R) => x > R.minX && x < R.maxX && z > R.minZ && z < R.maxZ;

// ---------------------------------------------------------------- кварталы
export const blockTypes = (() => {
  const g = CITY.grid, rnd = mulberry32(CITY.seed + 5);
  const t = new Uint8Array(g * g);
  for (let i = 0; i < g; i++) for (let j = 0; j < g; j++) {
    const cx = -HALF + (i + 0.5) * CITY.block, cz = -HALF + (j + 0.5) * CITY.block;
    let type;
    if (j === CITY.riverRow) type = BLOCK.RIVER;
    else if (inRect(cx, cz, BIG_PARK)) type = BLOCK.BIGPARK;
    else if (Math.abs(cx - STADIUM.x) < 50 && Math.abs(cz - STADIUM.z) < 50) type = BLOCK.STADIUM;
    else if (cx > HALF - 100 && cz > BEACH.minZ && cz < BEACH.maxZ) type = BLOCK.BEACH; // пляж
    else if (cx > HALF - 100) type = BLOCK.PORT;                                   // последняя колонна у моря
    else if (cx > HALF - 700 && cz > -(HALF - 300) && cz < 1400) type = BLOCK.INDUSTRIAL; // промзона у порта
    else if (Math.max(Math.abs(cx), Math.abs(cz)) < CITY.urbanHalf) type = Math.hypot(cx, cz) > 260 && rnd() < 0.06 ? BLOCK.PARK : BLOCK.URBAN;
    else type = rnd() < 0.06 ? BLOCK.PARK : BLOCK.SUBURB;
    t[j * g + i] = type;
  }
  return t;
})();

export function blockAt(x, z) {
  const i = Math.floor((x + HALF) / CITY.block), j = Math.floor((z + HALF) / CITY.block);
  if (i < 0 || j < 0 || i >= CITY.grid || j >= CITY.grid) return BLOCK.EMPTY;
  return blockTypes[j * CITY.grid + i];
}

// Высотность центра: два кластера небоскрёбов (деловой центр и мидтаун)
export function skylineAt(x, z) {
  const d = DISTRICTS;
  const a = Math.exp(-((Math.hypot(x - d.downtown.x, z - d.downtown.z) / d.downtown.r) ** 2));
  const b = Math.exp(-((Math.hypot(x - d.midtown.x, z - d.midtown.z) / d.midtown.r) ** 2)) * (d.midtown.h / d.downtown.h);
  return Math.max(a, b);
}
export const inOldTown = (x, z) => Math.hypot(x - DISTRICTS.oldtown.x, z - DISTRICTS.oldtown.z) < DISTRICTS.oldtown.r;

// Дороги вдоль оси Z (x = -HALF + k*block) пересекают реку. Мост — на каждой второй.
export const isBridgeRoad = (k) => k % 2 === 0;

// ---------------------------------------------------------------- шум
function hash2(ix, iz) {
  let h = (ix * 374761393 + iz * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  let fx = x - ix, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx); fz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return lerp(lerp(a, b, fx), lerp(c, d, fx), fz);
}
export function fbm(x, z, oct = 5) {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { s += a * vnoise(x * f, z * f); f *= 2.03; a *= 0.5; }
  return s;
}
// «Хребтовый» шум — острые гребни гор
function ridged(x, z, oct = 5) {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { const n = 1 - Math.abs(vnoise(x * f, z * f) * 2 - 1); s += a * n * n; f *= 2.1; a *= 0.5; }
  return s;
}

// Береговая линия: у города море подходит прямо к набережной, дальше — неровный берег
export const coastX = (z) => {
  const wild = HALF + 750 + (fbm(z * 0.0004, 3.7, 3) - 0.5) * 900;
  return lerp(QUAY_X, wild, smoothstep(PLANE_HALF, PLANE_HALF + 2500, Math.abs(z)));
};

// Лес на холмах вокруг города (маска 0..1): нужна и рельефу (цвет), и деревьям
export function forestMask(x, z, h) {
  const d = Math.hypot(x, z);
  const ring = smoothstep(PLANE_HALF + 200, PLANE_HALF + 900, Math.max(Math.abs(x), Math.abs(z))) * (1 - smoothstep(7000, 11000, d));
  const n = smoothstep(0.47, 0.56, fbm(x * 0.0009 + 13.1, z * 0.0009 - 7.7, 4));
  return ring * n * (1 - smoothstep(700, 1100, h)) * smoothstep(2, 10, h);
}

const LAKES = [
  { x: -6500, z: 2500, r: 950 },
  { x: 2500, z: -6800, r: 700 },
  { x: -4200, z: -9200, r: 600 },
];
const ISLANDS = [
  { x: 5600, z: 1600, r: 520, h: 45 },
  { x: 7000, z: -2600, r: 850, h: 140 },
  { x: 4800, z: 4600, r: 420, h: 30 },
];

// ---------------------------------------------------------------- рельеф (аналитический)
// Используется для построения меша рельефа. Внутри плоской городской зоны не важен.
export function terrainHeightRaw(x, z) {
  const dCity = Math.max(Math.abs(x), Math.abs(z));
  // Под городской плоскостью рельеф прячем глубже русла (иначе он закрыл бы реку и море)
  if (dCity < PLANE_HALF - 150) return x > QUAY_X ? SEA_BED : WORLD.riverBed - 3;

  // Горы: растут с расстоянием от города
  const mountainMask = smoothstep(3200, 9000, Math.hypot(x * 0.9, z));
  const hills = fbm(x * 0.0007, z * 0.0007, 4) * 70;
  const mountains = ridged(x * 0.00018 + 7.1, z * 0.00018 - 3.3, 5) * 2600 * mountainMask;
  let h = hills * smoothstep(PLANE_HALF, PLANE_HALF + 1500, dCity) + mountains;

  // Долина реки: на запад к горам и на восток к морю
  {
    const w = RIVER_HALF_W + 40 + Math.min(1, Math.max(0, -x / 8000)) * 120;
    const dz = Math.abs(z - RIVER_Z - Math.sin(x * 0.0006) * 300 * smoothstep(-HALF, -HALF - 3000, x));
    const valley = 1 - smoothstep(w, w * 3.5, dz);
    h = lerp(h, WORLD.riverBed + 1, valley);
  }

  // Озёра в долинах
  for (const L of LAKES) {
    const d = Math.hypot(x - L.x, z - L.z) * (1 + 0.25 * (fbm(x * 0.002, z * 0.002, 2) - 0.5));
    h = lerp(-10, h, smoothstep(L.r * 0.65, L.r * 1.25, d));
  }

  // Плоские площадки под дальние городки
  for (const t of TOWNS) {
    const r = t.grid * CITY.block * 0.5;
    const d = Math.max(Math.abs(x - t.x), Math.abs(z - t.z));
    h = lerp(-0.3, h, smoothstep(r + 100, r + 1400, d));
  }

  // Плавный переход к плоскому городу
  const flat = 1 - smoothstep(PLANE_HALF - 100, PLANE_HALF + 600, dCity);
  h = lerp(h, -0.3, flat);

  // Море на востоке (поверх всего): у города — сразу глубина за набережной
  const cx = coastX(z);
  const width = lerp(60, 1200, smoothstep(PLANE_HALF, PLANE_HALF + 2500, Math.abs(z)));
  const sea = smoothstep(cx - 20, cx + width, x);
  h = lerp(h, Math.min(SEA_BED, -45 - (x - cx) * 0.01), sea);

  // Острова в море
  for (const I of ISLANDS) {
    const d = Math.hypot(x - I.x, z - I.z) * (1 + 0.3 * (fbm(x * 0.003 + 5, z * 0.003, 2) - 0.5));
    const k = 1 - smoothstep(0, I.r, d);
    if (k > 0) h = Math.max(h, -20 + (I.h + 20) * k * k * (0.8 + 0.4 * fbm(x * 0.004, z * 0.004, 3)));
  }
  return h;
}

// ---------------------------------------------------------------- сетка высот для физики
export const TERRAIN_RES = 256;
export const terrainHeights = (() => {
  const N = TERRAIN_RES, size = WORLD.terrainSize;
  const a = new Float32Array((N + 1) * (N + 1));
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
    const x = -size / 2 + (i / N) * size, z = -size / 2 + (j / N) * size;
    a[j * (N + 1) + i] = terrainHeightRaw(x, z);
  }
  return a;
})();

export function sampleTerrain(x, z) {
  const N = TERRAIN_RES, size = WORLD.terrainSize;
  const fx = clamp((x / size + 0.5) * N, 0, N - 0.001), fz = clamp((z / size + 0.5) * N, 0, N - 0.001);
  const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
  const A = terrainHeights, W = N + 1;
  // Та же триангуляция, что у PlaneGeometry
  const h00 = A[j * W + i], h10 = A[j * W + i + 1], h01 = A[(j + 1) * W + i], h11 = A[(j + 1) * W + i + 1];
  return u + v <= 1 ? h00 + (h10 - h00) * u + (h01 - h00) * v : h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
}

export const inRiver = (x, z) => Math.abs(z - RIVER_Z) < RIVER_HALF_W && Math.abs(x) < PLANE_HALF;
export const inPond = (x, z) => Math.hypot(x - POND.x, z - POND.z) < POND.r;

// ---------------------------------------------------------------- дорожки парков
// (те же формулы в шейдере земли — деревья, скамейки и фонари стоят вдоль них)
// Маленький парк-квартал: площадь с фонтаном в центре, кольцо клумб, кольцевая дорожка
// и две аллеи крест-накрест. Возвращает расстояние до ближайшей дорожки (м).
export const PARK_PLAZA = 9, PARK_RING = 12.2;
export function parkPathDist(x, z) {
  const lx = ((x + HALF) % CITY.block) - CITY.block / 2, lz = ((z + HALF) % CITY.block) - CITY.block / 2;
  const r = Math.hypot(lx, lz);
  const cross = r > PARK_RING ? Math.min(Math.abs(lx), Math.abs(lz)) : 1e9;
  return Math.min(cross, Math.abs(r - PARK_RING));
}
// Центральный парк: две извилистые аллеи и дорожка вокруг пруда
export const bigParkPaths = [
  (x, z) => Math.abs(z - (BIG_PARK.minZ + BIG_PARK.maxZ) * 0.5 - 60 * Math.sin(x * 0.012)),
  (x, z) => Math.abs(x - (BIG_PARK.minX + BIG_PARK.maxX) * 0.5 - 50 * Math.sin(z * 0.015 + 1)),
  (x, z) => Math.abs(Math.hypot(x - POND.x, z - POND.z) - POND.r - 9),
];
export const bigParkPathDist = (x, z) => Math.min(...bigParkPaths.map((f) => f(x, z)));

// Высота земли в точке (без зданий): река, пруд, море у набережной, город, рельеф
export function groundHeight(x, z) {
  if (Math.abs(x) < PLANE_HALF && Math.abs(z) < PLANE_HALF) {
    if (inBeach(x, z)) return beachHeight(x);
    if (x > QUAY_X) return SEA_BED;
    return inRiver(x, z) || inPond(x, z) ? WORLD.riverBed : 0;
  }
  return sampleTerrain(x, z);
}
