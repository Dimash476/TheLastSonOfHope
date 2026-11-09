import { CITY, WORLD } from '../config.js';
import { mulberry32, clamp, smoothstep, lerp } from '../utils.js';

// Общая раскладка карты: типы кварталов, районы, река, мосты, набережная,
// парк с прудом, городки вдали, рельеф (горы, озёра, острова).
// Этим модулем пользуются генератор города, шейдер земли, транспорт и физика.

export const BLOCK = {
  URBAN: 0, PARK: 1, SUBURB: 2, RIVER: 3, EMPTY: 4,
  BIGPARK: 5, INDUSTRIAL: 6, PORT: 7, STADIUM: 8, BEACH: 9, MEGA: 10,
};

export const HALF = CITY.grid * CITY.block * 0.5;          // 4400 м — край сетки
export const PLANE_HALF = HALF + 250;                      // плоская «городская» земля
export const RIVER_Z = -HALF + CITY.riverRow * CITY.block + CITY.block / 2; // центр русла
export const RIVER_HALF_W = CITY.block / 2 - CITY.road / 2 - CITY.sidewalk; // 38 м
export const QUAY_X = HALF + CITY.road / 2 + CITY.sidewalk + 12;          // набережная: восточнее — море
export const SEA_BED = -14;

// Районы (центры и радиусы, м). Центры новых районов — в центрах кварталов.
export const DISTRICTS = {
  downtown: { x: 0, z: 0, r: 560, h: 340 },
  midtown: { x: 1250, z: -1100, r: 380, h: 280 },
  westgate: { x: -2050, z: -850, r: 400, h: 300 },     // деловой квартал на западе с башнями-близнецами
  southside: { x: 1650, z: 2050, r: 420, h: 300 },     // южный деловой квартал между стадионом и пляжем
  newcity: { x: -3450, z: -3350, r: 520, h: 420 },     // «новый сити» на северо-западной окраине: самые высокие башни
  oldtown: { x: -1100, z: 1000, r: 450 },
  sleeper: { x: -2250, z: 2350, r: 760 },              // спальный район: панельные корпуса и дворы
  campus: { x: 850, z: -2550, r: 250 },                // университетский городок
};
// Телебашня «Надежда» — на своей площади у южного берега реки (центр квартала)
export const TV_TOWER = { x: -1650, z: 450 };
export const LANDMARK = { x: -50, z: -150 };                // главный небоскрёб
export const BIG_PARK = { minX: -700, minZ: -1500, maxX: -300, maxZ: -1100 };
export const POND = { x: -500, z: -1300, r: 58 };
export const STADIUM = { x: 850, z: 950 };
// Городской пляж на юго-востоке: от прибрежной улицы (x = HALF − 100) песок уходит в море
export const BEACH = { x0: HALF - 100 + CITY.road / 2 + CITY.sidewalk, minZ: 2000, maxZ: HALF, x1: PLANE_HALF };
export const inBeach = (x, z) => x > BEACH.x0 - 0.5 && z > BEACH.minZ && z < BEACH.maxZ && x < BEACH.x1 + 400;
// Пирс развлечений: от набережной над пляжем в море, в конце — широкая площадка с аттракционами
export const PIER = { z: 2750, len: 370, w: 18, platFrom: 230, platW: 66 };
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
const inCircle = (x, z, D) => Math.hypot(x - D.x, z - D.z) < D.r;
export const inOldTown = (x, z) => inCircle(x, z, DISTRICTS.oldtown);
export const inSleeper = (x, z) => inCircle(x, z, DISTRICTS.sleeper);
export const inCampus = (x, z) => inCircle(x, z, DISTRICTS.campus);
export const inNewCity = (x, z) => inCircle(x, z, DISTRICTS.newcity);

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
    else if (inCampus(cx, cz)) type = BLOCK.URBAN;                                  // кампус — сплошь корпуса и дворы
    else if (inSleeper(cx, cz)) type = rnd() < 0.08 ? BLOCK.PARK : BLOCK.URBAN;     // спальный район (и скверы)
    else if (inNewCity(cx, cz)) type = BLOCK.URBAN;                                 // «новый сити» среди пригорода
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

// Высотность: пять кластеров небоскрёбов (деловой центр, мидтаун, западный и южный кварталы,
// «новый сити»). 1 — высота делового центра; в «новом сити» башни выше, там больше 1
export function skylineAt(x, z) {
  const d = DISTRICTS;
  const peak = (D) => Math.exp(-((Math.hypot(x - D.x, z - D.z) / D.r) ** 2)) * (D.h / d.downtown.h);
  return Math.max(peak(d.downtown), peak(d.midtown), peak(d.westgate), peak(d.southside), peak(d.newcity));
}

// ---------------------------------------------------------------- мега-площади
// Несколько мест, где квартал 3×3 (≈300 м с дорогами по краям) — одна огромная площадь без
// внутренних дорог с гигантской постройкой. Только там, где нет высоток: вне делового
// центра, старого города и реки, на городской или пригородной застройке.
// Площади 5×5 (≈500 м): гигантская сфера и новые гиганты BIG_KINDS (см. landmarks.js)
export const BIG_KINDS = ['gate', 'chalice', 'spiral', 'ring', 'halo'];
export const MEGA_SITES = (() => {
  const g = CITY.grid, rnd = mulberry32(CITY.seed + 777), B = CITY.block;
  const cell = (x) => Math.floor((x + HALF) / B);
  // Площадь телебашни 3×3 — первой, остальные обходят её стороной
  const tower = { i: cell(TV_TOWER.x), j: cell(TV_TOWER.z), x: TV_TOWER.x, z: TV_TOWER.z, half: B * 1.5, tower: true, n: 1 };
  const free = (i, j, n) => {
    for (let a = -n; a <= n; a++) for (let b = -n; b <= n; b++) {
      const t = blockTypes[(j + b) * g + (i + a)];
      if (t !== BLOCK.URBAN && t !== BLOCK.SUBURB) return false;
    }
    return true;
  };
  // Гигантская сфера: площадь 5×5 кварталов примерно в километре от главного небоскрёба
  let giant = null, giantScore = Infinity;
  for (let i = 3; i < g - 3; i++) for (let j = 3; j < g - 3; j++) {
    if (Math.abs(j - CITY.riverRow) < 4 || !free(i, j, 2)) continue;
    const x = -HALF + (i + 0.5) * B, z = -HALF + (j + 0.5) * B;
    if (inOldTown(x, z) || Math.hypot(x - tower.x, z - tower.z) < 700) continue;
    const score = Math.abs(Math.hypot(x - LANDMARK.x, z - LANDMARK.z) - 1100);
    if (score < giantScore) { giantScore = score; giant = { i, j, x, z, half: B * 2.5, giant: true, n: 2 }; }
  }
  // Место под площадь (n — полуширина в кварталах): только городская или пригородная застройка,
  // вдали от реки, небоскрёбов, старого города, спального района и кампуса
  const fits = (i, j, n) => {
    if (i < n + 1 || j < n + 1 || i >= g - n - 1 || j >= g - n - 1 || Math.abs(j - CITY.riverRow) < n + 2 || !free(i, j, n)) return false;
    const x = -HALF + (i + 0.5) * B, z = -HALF + (j + 0.5) * B;
    if (skylineAt(x, z) > 0.3 || inOldTown(x, z) || Math.hypot(x - LANDMARK.x, z - LANDMARK.z) < 700) return false;
    if (Math.hypot(x - DISTRICTS.sleeper.x, z - DISTRICTS.sleeper.z) < DISTRICTS.sleeper.r + 150 + n * 100) return false;
    return Math.hypot(x - DISTRICTS.campus.x, z - DISTRICTS.campus.z) >= DISTRICTS.campus.r + 150 + n * 100;
  };
  const sites = giant ? [tower, giant] : [tower];
  const far = (c, d) => !sites.some((s) => Math.hypot(s.x - c.x, s.z - c.z) < d + (s.n - 1) * 150);
  // Новые гиганты на площадях 5×5 — кольцом в 1,6–3,8 км от главного небоскрёба, далеко друг от друга
  const big = [];
  for (let i = 0; i < g; i++) for (let j = 0; j < g; j++) {
    if (!fits(i, j, 2)) continue;
    const x = -HALF + (i + 0.5) * B, z = -HALF + (j + 0.5) * B, d = Math.hypot(x - LANDMARK.x, z - LANDMARK.z);
    if (d > 1600 && d < 3800) big.push({ i, j, x, z, r: rnd() });
  }
  big.sort((p, q) => p.r - q.r);
  for (const kind of BIG_KINDS) {
    const c = big.find((c) => far(c, 1300));
    if (c) sites.push({ i: c.i, j: c.j, x: c.x, z: c.z, half: B * 2.5, n: 2, kind });
  }
  const cands = [];
  for (let i = 0; i < g; i++) for (let j = 0; j < g; j++) if (fits(i, j, 1)) cands.push({ i, j, x: -HALF + (i + 0.5) * B, z: -HALF + (j + 0.5) * B, r: rnd() });
  cands.sort((p, q) => p.r - q.r);
  let reg = 0;
  for (const c of cands) {
    if (reg >= 15) break;
    if (!far(c, 850)) continue;
    sites.push({ i: c.i, j: c.j, x: c.x, z: c.z, half: B * 1.5, n: 1, reg: reg++ });
  }
  for (const s of sites) for (let a = -s.n; a <= s.n; a++) for (let b = -s.n; b <= s.n; b++) blockTypes[(s.j + b) * g + (s.i + a)] = BLOCK.MEGA;
  return sites;
})();
// Мега-площадь, в которую попадает точка (pad > 0 — отступ внутрь от краёв, например под тротуары)
export function inMega(x, z, pad = 0) {
  for (const s of MEGA_SITES) if (Math.abs(x - s.x) < s.half - pad && Math.abs(z - s.z) < s.half - pad) return s;
  return null;
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

// Равнины (0..1): широкие луга и поля между горными массивами
export function plainK(x, z) {
  const far = smoothstep(PLANE_HALF + 300, PLANE_HALF + 2200, Math.max(Math.abs(x), Math.abs(z)));
  return far * smoothstep(0.6, 0.44, fbm(x * 0.00011 + 3.3, z * 0.00011 - 5.1, 3));
}

// Лес на холмах вокруг города (маска 0..1): нужна и рельефу (цвет), и деревьям
export function forestMask(x, z, h) {
  const d = Math.hypot(x, z);
  const ring = smoothstep(PLANE_HALF + 200, PLANE_HALF + 900, Math.max(Math.abs(x), Math.abs(z))) * (1 - smoothstep(10000, 15000, d)) * (1 - 0.85 * plainK(x, z));
  const n = smoothstep(0.47, 0.56, fbm(x * 0.0009 + 13.1, z * 0.0009 - 7.7, 4));
  // Хвойный пояс поднимается по склонам до ~1,7 км, выше — альпийские луга
  return ring * n * (1 - smoothstep(1300, 1800, h)) * smoothstep(2, 10, h);
}

const LAKES = [
  { x: -6500, z: 2500, r: 950 },
  { x: 2500, z: -6800, r: 700 },
  { x: -4200, z: -9200, r: 600 },
];
const ISLANDS = [
  { x: 6400, z: 1600, r: 520, h: 45 },
  { x: 7800, z: -2600, r: 850, h: 140 },
  { x: 5600, z: 4600, r: 420, h: 30 },
  // Дальние вулканические островки — силуэты на фоне заката за райским островом
  { x: 17500, z: -300, r: 950, h: 640 },
  { x: 15600, z: 2600, r: 700, h: 380 },
  { x: 14300, z: -2100, r: 520, h: 250 },
  { x: 13700, z: 4300, r: 320, h: 95 },
];

// ---------------------------------------------------------------- райский остров
// Тропический остров в океане на востоке — прямо по курсу заката. Вулкан с зелёными
// гребнями, широкий золотой пляж на восточном берегу (тусовка) и тихая бухта среди
// чёрных лавовых скал (там никого нет). Свою детальную сетку рисует island.js,
// а высоты отсюда нужны и сетке, и физике (по пляжу можно ходить).
export const ISLE = { x: 9400, z: 400, rx: 1750, rz: 1050, rot: 0.3, size: 4400 };
const isleC = Math.cos(ISLE.rot), isleS = Math.sin(ISLE.rot);
export const isleToLocal = (x, z) => { const dx = x - ISLE.x, dz = z - ISLE.z; return [dx * isleC + dz * isleS, -dx * isleS + dz * isleC]; };
export const isleToWorld = (u, v) => [ISLE.x + u * isleC - v * isleS, ISLE.z + u * isleS + v * isleC];
// Точка берега эллипса под углом phi и наружная нормаль (в локальных координатах острова)
function isleShore(phi, inset = 0) {
  const u = ISLE.rx * Math.cos(phi), v = ISLE.rz * Math.sin(phi);
  let nu = u / (ISLE.rx * ISLE.rx), nv = v / (ISLE.rz * ISLE.rz);
  const l = Math.hypot(nu, nv); nu /= l; nv /= l;
  return { u: u - nu * inset, v: v - nv * inset, nu, nv };
}
// Бухта пляжа-тусовки (смотрит на закат) и тихая бухта (в километре, за скалами)
const partyShore = isleShore(0.22, 140), coveShore = isleShore(-0.78, 40);
export const ISLE_BAYS = [
  { ...partyShore, r: 400, cu: partyShore.u + partyShore.nu * 330, cv: partyShore.v + partyShore.nv * 330 },
  { ...coveShore, r: 95, cu: coveShore.u + coveShore.nu * 60, cv: coveShore.v + coveShore.nv * 60 },
];
const coveT = [-ISLE_BAYS[1].nv, ISLE_BAYS[1].nu];
// Лавовые скалы — мысы по краям тихой бухты и россыпь у берега
export const ISLE_ROCKS = [
  { u: ISLE_BAYS[1].u + coveT[0] * 105, v: ISLE_BAYS[1].v + coveT[1] * 105, r: 55, h: 16 },
  { u: ISLE_BAYS[1].u - coveT[0] * 105, v: ISLE_BAYS[1].v - coveT[1] * 105, r: 60, h: 19 },
  { u: ISLE_BAYS[1].u + coveT[0] * 140 + ISLE_BAYS[1].nu * 40, v: ISLE_BAYS[1].v + coveT[1] * 140 + ISLE_BAYS[1].nv * 40, r: 28, h: 9 },
  { u: ISLE_BAYS[1].u - coveT[0] * 150 + ISLE_BAYS[1].nu * 45, v: ISLE_BAYS[1].v - coveT[1] * 150 + ISLE_BAYS[1].nv * 45, r: 30, h: 10 },
];
const ISLE_PEAK = { u: -0.38 * ISLE.rx, v: 0.12 * ISLE.rz, h: 980, r: 1400 };
// Песок у воды и пляж: где начинается пляж (от уреза), его ширина
const SAND_W = 115;
const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };

// Подробные данные точки острова: высота, расстояние от берега (м, > 0 — суша), скалы
export function islandSample(x, z) {
  const [u, v] = isleToLocal(x, z);
  if (Math.abs(u) > ISLE.size / 2 + 2 || Math.abs(v) > ISLE.size / 2 + 2) return null;
  const ang = Math.atan2(v / ISLE.rz, u / ISLE.rx);
  let e = Math.hypot(u / ISLE.rx, v / ISLE.rz);
  // Неровный берег: шум по углу (непрерывен по кругу)
  e *= 1 + (fbm(Math.cos(ang) * 1.8 + 3.1, Math.sin(ang) * 1.8 - 2.3, 3) - 0.5) * 0.2;
  let sd = (1 - e) * 1250;
  for (const B of ISLE_BAYS) sd = smin(sd, Math.hypot(u - B.cu, v - B.cv) - B.r, 70);
  const wl = WORLD.waterLevel;
  let h;
  if (sd < 0) {
    // Пологий шельф: бирюзовое мелководье на сотни метров, дальше — глубина
    h = wl - 0.4 + sd * 0.032 - Math.max(0, -sd - 650) * 0.12;
    h = Math.max(h, -70);
  } else if (sd < SAND_W) {
    h = wl + 0.25 + Math.pow(sd / SAND_W, 1.25) * 3.4;
  } else {
    const base = wl + 3.65 + (sd - SAND_W) * 0.035 + fbm(u * 0.004 + 7, v * 0.004 - 3, 3) * 22 * smoothstep(SAND_W, 420, sd);
    // Пологий щитовой вулкан и второй, меньший пик; вершины неровные
    const dp = Math.hypot(u - ISLE_PEAK.u, v - ISLE_PEAK.v);
    const d2 = Math.hypot(u - 0.12 * ISLE.rx, v + 0.38 * ISLE.rz);
    const shield = (d, r) => { const k = Math.max(0, 1 - d / r); return k * k * (3 - 2 * k); };
    let hv = Math.max(ISLE_PEAK.h * Math.pow(shield(dp, ISLE_PEAK.r), 1.15), 520 * Math.pow(shield(d2, 760), 1.2));
    hv *= 0.82 + 0.3 * fbm(u * 0.0025 + 4, v * 0.0025 - 1, 4);
    // Радиальные гребни и глубокие зелёные ущелья, как на гавайских вулканах
    const th = Math.atan2(v - ISLE_PEAK.v, u - ISLE_PEAK.u);
    const rid = Math.pow(Math.abs(Math.sin(th * 13 + fbm(u * 0.002, v * 0.002, 3) * 5)), 0.45);
    hv *= 0.58 + 0.42 * rid;
    h = base + hv * smoothstep(80, 600, sd);
  }
  // Чёрные лавовые скалы
  let rock = 0;
  for (const R of ISLE_ROCKS) {
    const d = Math.hypot(u - R.u, v - R.v) * (1 + 0.35 * (fbm(u * 0.03, v * 0.03, 2) - 0.5));
    if (d < R.r) {
      const k = 1 - (d / R.r) ** 2;
      h = Math.max(h, wl - 2 + (R.h + 2) * Math.sqrt(k) * (0.75 + 0.5 * fbm(u * 0.06 + 2, v * 0.06, 2)));
      rock = Math.max(rock, smoothstep(0, 0.5, k));
    }
  }
  return { h, sd, rock, u, v };
}
export function islandHeight(x, z) {
  const s = islandSample(x, z);
  return s ? s.h : null;
}

// ---------------------------------------------------------------- горы
// Хребты растут с расстоянием от города: у окраин ~1,5 км, дальше 4–6 км
function ridgesAt(x, z) {
  const mask = smoothstep(4000, 9800, Math.hypot(x * 0.9, z));
  const amp = 4600 + 2000 * smoothstep(9000, 17000, Math.hypot(x, z));
  return Math.pow(ridged(x * 0.00018 + 7.1, z * 0.00018 - 3.3, 6), 1.3) * amp * mask * (1 - 0.94 * plainK(x, z));
}
// Прежние, более низкие хребты (до ~3 км) — на западе за городом, где река уходит в горы
const OLD_WEST = { x: -14500, z: -4000, r0: 6500, r1: 9500 };
function oldRidgesAt(x, z) {
  const mask = smoothstep(3200, 9000, Math.hypot(x * 0.9, z));
  return Math.pow(ridged(x * 0.00018 + 7.1, z * 0.00018 - 3.3, 5), 1.25) * 3300 * mask * (1 - 0.94 * plainK(x, z));
}
// Великан на северо-западе — высочайшая вершина (~8,8 км): тот же массив, что был здесь,
// только шире в GIANT.s раз и выше в GIANT.hs раз
export const GIANT = { x: -14500, z: -16500, s: 1.6, hs: 1.51, r0: 5500, r1: 9000 };
function mountainsAt(x, z) {
  let h = ridgesAt(x, z);
  const dw = Math.hypot(x - OLD_WEST.x, z - OLD_WEST.z);
  if (dw < OLD_WEST.r1) h = lerp(oldRidgesAt(x, z), h, smoothstep(OLD_WEST.r0, OLD_WEST.r1, dw));
  const G = GIANT, dg = Math.hypot(x - G.x, z - G.z);
  if (dg < G.r1) {
    const big = ridgesAt(G.x + (x - G.x) / G.s, G.z + (z - G.z) / G.s) * G.hs;
    h = Math.max(h, big * (1 - smoothstep(G.r0, G.r1, dg)));
  }
  return h;
}

// ---------------------------------------------------------------- рельеф (аналитический)
// Используется для построения меша рельефа. Внутри плоской городской зоны не важен.
export const terrainHeightRaw = (x, z) => terrainCore(x, z, true);
// Та же земля без гор: луга, холмы, долины, озёра. Ниже неё гору не проломить —
// за городом ломаются только горы, а равнины и холмы остаются целыми
export const terrainBaseRaw = (x, z) => terrainCore(x, z, false);
const BASE_KEEP = 120;
function terrainCore(x, z, withMountains) {
  const dCity = Math.max(Math.abs(x), Math.abs(z));
  // Под городской плоскостью рельеф прячем глубже русла (иначе он закрыл бы реку и море)
  if (dCity < PLANE_HALF - 150) return x > QUAY_X ? SEA_BED : WORLD.riverBed - 3;

  // На равнинах горы и холмы сглаживаются в пологие луга
  const pk = plainK(x, z);
  const hills = fbm(x * 0.0007, z * 0.0007, 4) * 70 * (1 - 0.55 * pk);
  let h = hills * smoothstep(PLANE_HALF, PLANE_HALF + 1500, dCity);
  const m = mountainsAt(x, z);
  // Неломаемая часть: на равнинах — весь рельеф (там «горный» шум даёт только холмы),
  // у гор — нижние BASE_KEEP м: подножие и холмы вокруг остаются целыми
  h += withMountains ? m : Math.max(Math.min(m, BASE_KEEP), m * smoothstep(0.12, 0.4, pk));

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
export const TERRAIN_RES = 512;   // ячейка ~86 м
export const TERRAIN_TILE = 32;   // плитка сетки рельефа (16×16 плиток по ~2,75 км)
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
  // Райский остров — точная высота (пляж, скалы, склоны вулкана)
  const ih = islandHeight(x, z);
  if (ih !== null) return ih;
  return sampleTerrain(x, z);
}
