import { CITY, WORLD } from '../config.js';
import { mulberry32, clamp, smoothstep, lerp } from '../utils.js';

// Общая раскладка карты: типы кварталов, река, мосты, городки вдали, рельеф.
// Этим модулем пользуются генератор города, шейдер земли, транспорт и физика.

export const BLOCK = { URBAN: 0, PARK: 1, SUBURB: 2, RIVER: 3, EMPTY: 4 };

export const HALF = CITY.grid * CITY.block * 0.5;          // 2400 м — край сетки
export const PLANE_HALF = HALF + 250;                      // плоская «городская» земля
export const RIVER_Z = -HALF + CITY.riverRow * CITY.block + CITY.block / 2; // центр русла
export const RIVER_HALF_W = CITY.block / 2 - CITY.road / 2 - CITY.sidewalk; // 38 м

// Городки вдали (центры кратны 100 м — дороги совпадают с сеткой шейдера)
export const TOWNS = [
  { x: -8000, z: -6000, grid: 10, seed: 11 },
  { x: -3000, z: 10000, grid: 8, seed: 22 },
  { x: 9000, z: -11000, grid: 6, seed: 33 },
];

// ---------------------------------------------------------------- кварталы
export const blockTypes = (() => {
  const g = CITY.grid, rnd = mulberry32(CITY.seed + 5);
  const t = new Uint8Array(g * g);
  for (let i = 0; i < g; i++) for (let j = 0; j < g; j++) {
    const cx = -HALF + (i + 0.5) * CITY.block, cz = -HALF + (j + 0.5) * CITY.block;
    let type;
    if (j === CITY.riverRow) type = BLOCK.RIVER;
    else if (Math.max(Math.abs(cx), Math.abs(cz)) < CITY.urbanHalf) type = Math.hypot(cx, cz) > 260 && rnd() < 0.07 ? BLOCK.PARK : BLOCK.URBAN;
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
function fbm(x, z, oct = 5) {
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

// Береговая линия: океан на востоке
export const coastX = (z) => HALF + 750 + (fbm(z * 0.0004, 3.7, 3) - 0.5) * 700;

// ---------------------------------------------------------------- рельеф (аналитический)
// Используется для построения меша рельефа. Внутри плоской городской зоны не важен.
export function terrainHeightRaw(x, z) {
  const dCity = Math.max(Math.abs(x), Math.abs(z));
  // Под городской плоскостью рельеф прячем глубже русла (иначе он закрыл бы реку)
  if (dCity < PLANE_HALF - 150) return WORLD.riverBed - 3;

  // Горы: растут с расстоянием от города
  const mountainMask = smoothstep(3200, 9000, Math.hypot(x * 0.9, z));
  const hills = fbm(x * 0.0007, z * 0.0007, 4) * 60;
  const mountains = ridged(x * 0.00018 + 7.1, z * 0.00018 - 3.3, 5) * 2600 * mountainMask;
  let h = hills * smoothstep(PLANE_HALF, PLANE_HALF + 1500, dCity) + mountains;

  // Океан на востоке: пляж и глубина
  const cx = coastX(z);
  const sea = smoothstep(cx - 300, cx + 900, x);
  h = lerp(h, -45 - (x - cx) * 0.01, sea);

  // Долина реки: на запад к горам и на восток к океану
  {
    const w = RIVER_HALF_W + 40 + Math.min(1, Math.max(0, -x / 8000)) * 120;
    const dz = Math.abs(z - RIVER_Z - Math.sin(x * 0.0006) * 300 * smoothstep(-HALF, -HALF - 3000, x));
    const valley = 1 - smoothstep(w, w * 3.5, dz);
    h = lerp(h, WORLD.riverBed + 1, valley);
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

function sampleTerrain(x, z) {
  const N = TERRAIN_RES, size = WORLD.terrainSize;
  const fx = clamp((x / size + 0.5) * N, 0, N - 0.001), fz = clamp((z / size + 0.5) * N, 0, N - 0.001);
  const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
  const A = terrainHeights, W = N + 1;
  // Та же триангуляция, что у PlaneGeometry
  const h00 = A[j * W + i], h10 = A[j * W + i + 1], h01 = A[(j + 1) * W + i], h11 = A[(j + 1) * W + i + 1];
  return u + v <= 1 ? h00 + (h10 - h00) * u + (h01 - h00) * v : h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
}

export const inRiver = (x, z) => Math.abs(z - RIVER_Z) < RIVER_HALF_W && Math.abs(x) < PLANE_HALF;

// Высота земли в точке (без зданий): река, город, рельеф
export function groundHeight(x, z) {
  if (Math.abs(x) < PLANE_HALF && Math.abs(z) < PLANE_HALF) return inRiver(x, z) ? WORLD.riverBed : 0;
  return sampleTerrain(x, z);
}
