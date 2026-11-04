import * as THREE from 'three';
import { mulberry32 } from '../utils.js';
import { NOISE_GLSL, INOISE_GLSL, CRATER_GLSL, BUMP_GLSL } from './space.js';

// Отдельная карта планеты: касание шара сбоку или снизу переносит героя сюда (сверху — обычная
// посадка на шар). Карта стоит на настоящем верху тела: над головой те же звёзды, Солнце и кольца,
// а сам шар на это время спрятан. Рельеф — в основной сцене, поэтому герой и камни отбрасывают
// на него обычные тени. Подъём выше EXIT_ALT возвращает в космос.
//
// Высоты лежат в двух периодичных тайлах (большие формы и мелочь под ногами) — их читают и
// вершинный шейдер, и физика. Сетка — вложенные квадраты (clipmap): CPU её не пересчитывает,
// а вершины каждого уровня привязаны к своей решётке, поэтому рельеф не «плывёт» при движении.

const TN = 512, MASK = TN - 1;
const BIG_SP = 40, FINE_SP = 2.5;                  // шаг тайлов, м
const BIG_P = TN * BIG_SP, FINE_P = TN * FINE_SP;  // период тайлов, м
const GRID_H = 48, LEVELS = 11;                    // ±48 ячеек на уровень, ячейки 1 м … 1 км
const RV = 200000;                                 // кривизна на вид: прячет край сетки, даёт горизонт
const EXIT_ALT = 3000;                             // выше этого — выход в космос
const CELL_S = 4, RANGE_S = 16;                    // мелкие камни: ячейка, м, и радиус в ячейках
const CELL_B = 50, RANGE_B = 20;                   // валуны

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const RIDGE = (v) => 1 - Math.abs(v);
const BILLOW = (v) => Math.sqrt(v * v + 0.04);   // модуль со скруглённым изломом: клубы без острых складок

// ---------------------------------------------------------------- генерация тайлов
// Слой периодического шума: решётка fx×fz случайных значений в [-1, 1], плавная интерполяция
function addNoise(out, fx, fz, amp, rnd, shape) {
  const L = new Float32Array(fx * fz);
  for (let i = 0; i < L.length; i++) L[i] = rnd() * 2 - 1;
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const ix = new Int32Array(TN), tx = new Float32Array(TN);
  for (let i = 0; i < TN; i++) {
    const x = i * fx / TN, c = Math.floor(x);
    ix[i] = c; tx[i] = fade(x - c);
  }
  let k = 0;
  for (let j = 0; j < TN; j++) {
    const z = j * fz / TN, cz = Math.floor(z), tz = fade(z - cz);
    const r0 = cz * fx, r1 = ((cz + 1) % fz) * fx;
    for (let i = 0; i < TN; i++, k++) {
      const c0 = ix[i], c1 = (c0 + 1) % fx, ax = tx[i];
      const top = L[r0 + c0] + (L[r0 + c1] - L[r0 + c0]) * ax;
      const bot = L[r1 + c0] + (L[r1 + c1] - L[r1 + c0]) * ax;
      const v = top + (bot - top) * tz;
      out[k] += amp * (shape ? shape(v) : v);
    }
  }
}

function fbm(fx, fz, oct, gain, rnd, shape) {
  const out = new Float32Array(TN * TN);
  let a = 1, sum = 0;
  for (let o = 0; o < oct; o++) {
    const f = 1 << o;
    if (fx * f > TN / 2 || fz * f > TN / 2) break;
    addNoise(out, fx * f, fz * f, a, rnd, shape);
    sum += a; a *= gain;
  }
  for (let k = 0; k < out.length; k++) out[k] /= sum;
  return out;
}

// Кратер: чаша с плоским дном, вал, выбросы; свежие — со светлыми лучами в тайле яркости
function stampCrater(H, A, sp, cx, cz, r, depth, rim, fresh, rayPhase) {
  const R = Math.ceil(r * 2.4 / sp), ci = Math.round(cx / sp), cj = Math.round(cz / sp);
  for (let dj = -R; dj <= R; dj++) {
    const row = ((cj + dj) & MASK) * TN, dz = (cj + dj) * sp - cz;
    for (let di = -R; di <= R; di++) {
      const dx = (ci + di) * sp - cx, d = Math.hypot(dx, dz) / r;
      if (d > 2.4) continue;
      const k = row + ((ci + di) & MASK), e = d - 1;
      if (d < 1) {
        H[k] += depth * (Math.max(d * d, 0.25) - 1) + rim * Math.exp(-e * e / 0.035);
        A[k] += -0.1 * (1 - d * d) + fresh * 0.25;
      } else {
        H[k] += rim * (0.75 * Math.exp(-e * e / 0.035) + 0.25 * Math.exp(-e * 2.2));
        const ray = Math.sin(Math.atan2(dz, dx) * 9 + rayPhase);
        A[k] += fresh * Math.exp(-e * 1.6) * (0.2 + 0.45 * ray * ray) * smooth(2.4, 1.6, d);
      }
    }
  }
}

function scatterCraters(H, A, sp, n, rMin, rMax, depthK, rimK, rnd) {
  const P = TN * sp;
  for (let i = 0; i < n; i++) {
    const r = rMin * Math.pow(rMax / rMin, Math.pow(rnd(), 2.6));
    stampCrater(H, A, sp, rnd() * P, rnd() * P, r, r * depthK * Math.min(1, Math.pow(300 / r, 0.35)), r * rimK * Math.min(1, Math.pow(300 / r, 0.5)), rnd() < 0.12 ? 0.5 + rnd() * 0.5 : rnd() * 0.12, rnd() * 6.28);
  }
}

const newTiles = () => ({
  bigH: new Float32Array(TN * TN), bigA: new Float32Array(TN * TN),
  fineH: new Float32Array(TN * TN), fineA: new Float32Array(TN * TN),
});

// Каменные: Луна, Меркурий, Марс (у него ещё каньоны, столовые горы и дюны)
function genRocky(o, rnd) {
  const T = newTiles(), H = T.bigH, N2 = TN * TN;
  const low = fbm(3, 3, 7, 0.5, rnd), rid = fbm(5, 5, 6, 0.5, rnd, RIDGE), mask = fbm(2, 2, 3, 0.5, rnd);
  for (let k = 0; k < N2; k++) {
    const r = rid[k], m = smooth(-0.1, 0.3, mask[k]);
    H[k] = o.hills * low[k] + o.mtn * m * r * r * r;
  }
  if (o.mesa) {
    const mm = fbm(3, 3, 3, 0.5, rnd), STEP = 70;
    for (let k = 0; k < N2; k++) {
      const x = H[k] / STEP, fl = Math.floor(x);
      H[k] += ((fl + smooth(0.62, 1, x - fl)) * STEP - H[k]) * smooth(-0.05, 0.2, mm[k]);
    }
  }
  if (o.canyon) {
    const c = fbm(2, 2, 5, 0.5, rnd);
    for (let k = 0; k < N2; k++) H[k] -= o.canyon * (1 - smooth(0, 0.045, Math.abs(c[k])));
  }
  scatterCraters(H, T.bigA, BIG_SP, o.craters, 100, o.craterMax, 0.2, 0.05, rnd);

  const lump = fbm(8, 8, 5, 0.55, rnd);
  for (let k = 0; k < N2; k++) T.fineH[k] = o.lump * lump[k];
  if (o.dunes) {
    const warp = fbm(5, 5, 4, 0.5, rnd), zone = fbm(3, 3, 3, 0.5, rnd);
    let k = 0;
    for (let j = 0; j < TN; j++) {
      for (let i = 0; i < TN; i++, k++) {
        const a = (i * 28 + j * 14) / TN * Math.PI * 2 + warp[k] * 11;
        T.fineH[k] += o.dunes * smooth(-0.02, 0.2, zone[k]) * (1 - Math.abs(Math.sin(a)));
      }
    }
  }
  scatterCraters(T.fineH, T.fineA, FINE_SP, o.smallCraters, 3, 45, 0.22, 0.05, rnd);
  return T;
}

// Венера: лавовые равнины и щитовые вулканы с кальдерами
function genVenus(rnd) {
  const T = newTiles(), H = T.bigH, N2 = TN * TN;
  const low = fbm(3, 3, 6, 0.5, rnd), flow = fbm(6, 6, 5, 0.5, rnd, RIDGE);
  for (let k = 0; k < N2; k++) H[k] = 70 * low[k] + 70 * flow[k];
  for (let n = 0; n < 14; n++) {
    const cx = rnd() * BIG_P, cz = rnd() * BIG_P, r = 1400 + rnd() * 2800, hgt = 260 + rnd() * 520;
    const R = Math.ceil(r * 2.6 / BIG_SP), ci = Math.round(cx / BIG_SP), cj = Math.round(cz / BIG_SP);
    for (let dj = -R; dj <= R; dj++) {
      for (let di = -R; di <= R; di++) {
        const d = Math.hypot((ci + di) * BIG_SP - cx, (cj + dj) * BIG_SP - cz) / r;
        if (d > 2.6) continue;
        const k = ((cj + dj) & MASK) * TN + ((ci + di) & MASK);
        H[k] += hgt * Math.exp(-d * d * 1.5) * smooth(2.6, 1.8, d) - hgt * 0.35 * smooth(0.2, 0.13, d);
      }
    }
  }
  const lump = fbm(10, 10, 5, 0.55, rnd), plates = fbm(14, 14, 3, 0.5, rnd, RIDGE);
  for (let k = 0; k < N2; k++) T.fineH[k] = 1.4 * lump[k] + 0.9 * plates[k];
  return T;
}

// Юпитер и Сатурн: облачная «палуба» — округлые клубы
function genClouds(o, rnd) {
  const T = newTiles(), N2 = TN * TN;
  const b = fbm(o.f, o.f, 6, 0.6, rnd, BILLOW), f = fbm(16, 16, 5, 0.6, rnd, BILLOW);
  for (let k = 0; k < N2; k++) {
    T.bigH[k] = o.amp * b[k] * (2 - b[k]);
    T.bigA[k] = (b[k] - 0.4) * 0.6;
    T.fineH[k] = 3 * f[k] * (2 - f[k]);
  }
  return T;
}

// Сами карты. Цвета линейные; тени — свет солнца (оно всегда со стороны +x, высота sunEl)
// style: 0 камень, 1 Марс, 2 Венера, 3 облака
const LOOKS = {
  moon: {
    style: 0, a: [0.2, 0.2, 0.195], b: [0.46, 0.45, 0.43], c: [0.3, 0.29, 0.28], dens: 0.6, rock: [0.28, 0.275, 0.265], rocks: 0.32, boulders: 0.24,
    sunEl: 17, sunI: 8.5, sunC: [1, 0.97, 0.93], hemiI: 1.8, hemiC: [0.5, 0.55, 0.65], hemiG: [0.3, 0.29, 0.27], exposure: 0.72, shadow: 1,
    earth: [-0.28, 0.42, -0.86],
    gen: (r) => genRocky({ hills: 110, mtn: 900, craters: 150, craterMax: 2800, lump: 1.6, smallCraters: 320 }, r),
  },
  mercury: {
    style: 0, a: [0.2, 0.18, 0.165], b: [0.4, 0.36, 0.32], c: [0.26, 0.24, 0.22], dens: 0.75, rock: [0.24, 0.22, 0.2], rocks: 0.36, boulders: 0.28,
    sunEl: 26, sunI: 8.5, sunC: [1, 0.96, 0.9], hemiI: 1.8, hemiC: [0.5, 0.5, 0.55], hemiG: [0.28, 0.26, 0.24], exposure: 0.6, shadow: 1,
    gen: (r) => genRocky({ hills: 70, mtn: 520, craters: 360, craterMax: 3200, lump: 1.4, smallCraters: 520 }, r),
  },
  mars: {
    style: 1, a: [0.3, 0.13, 0.06], b: [0.62, 0.3, 0.14], c: [0.36, 0.19, 0.11], dens: 0.3, rock: [0.3, 0.16, 0.1], rocks: 0.3, boulders: 0.24,
    sunEl: 30, sunI: 4.6, sunC: [1, 0.9, 0.78], hemiI: 1.3, hemiC: [0.85, 0.62, 0.45], hemiG: [0.5, 0.28, 0.16], exposure: 0.62, shadow: 0.92,
    fog: 0.000055, sky: { hor: [0.92, 0.6, 0.35], zen: [0.5, 0.31, 0.19], glow: [0.55, 0.58, 0.68], aH: 1, aZ: 0.97 },
    gen: (r) => genRocky({ hills: 130, mtn: 1150, mesa: true, canyon: 420, craters: 28, craterMax: 1800, lump: 0.9, dunes: 1.3, smallCraters: 36 }, r),
  },
  venus: {
    style: 2, a: [0.17, 0.1, 0.06], b: [0.42, 0.27, 0.13], c: [0.13, 0.085, 0.06], dens: 0, rock: [0.14, 0.09, 0.065], rocks: 0.26, boulders: 0.14,
    sunEl: 48, sunI: 2.6, sunC: [1, 0.76, 0.42], hemiI: 2.4, hemiC: [1, 0.72, 0.36], hemiG: [0.55, 0.3, 0.13], exposure: 0.62, shadow: 0.4,
    fog: 0.00016, sky: { hor: [0.8, 0.5, 0.17], zen: [0.52, 0.29, 0.09], glow: [0.55, 0.36, 0.12], aH: 1, aZ: 1, cloud: [0.92, 0.65, 0.27], cloudK: 0.6, scale: [1.1, 2.6] },
    gen: genVenus,
  },
  jupiter: {
    style: 3, a: [0.98, 0.72, 0.52], b: [1.18, 1.12, 1.05], c: [1.06, 0.84, 0.64], dens: 0, rocks: 0, boulders: 0, bands: 2600, warp: 0.5,
    sunEl: 34, sunI: 2.8, sunC: [1, 0.95, 0.85], hemiI: 2.2, hemiC: [0.85, 0.78, 0.68], hemiG: [0.62, 0.46, 0.33], exposure: 0.6, shadow: 0.3,
    fog: 0.00009, sky: { hor: [0.62, 0.48, 0.34], zen: [0.08, 0.08, 0.12], glow: [0.42, 0.36, 0.27], aH: 1, aZ: 0.85, cloud: [0.72, 0.56, 0.4], cloudK: 0.7, scale: [0.8, 3] },
    gen: (r) => genClouds({ f: 6, amp: 520 }, r),
  },
  saturn: {
    style: 3, a: [0.9, 0.74, 0.46], b: [1.12, 1.06, 0.9], c: [1, 0.86, 0.58], dens: 0, rocks: 0, boulders: 0, bands: 3400, warp: 0.3,
    sunEl: 26, sunI: 2.8, sunC: [1, 0.96, 0.87], hemiI: 2.0, hemiC: [0.85, 0.8, 0.68], hemiG: [0.66, 0.56, 0.4], exposure: 0.6, shadow: 0.3,
    fog: 0.00007, sky: { hor: [0.74, 0.66, 0.47], zen: [0.05, 0.05, 0.08], glow: [0.42, 0.38, 0.27], aH: 1, aZ: 0.45, cloud: [0.82, 0.74, 0.54], cloudK: 0.35, scale: [0.7, 3.5] },
    gen: (r) => genClouds({ f: 4, amp: 300 }, r),
  },
};

// Наклоны (RG), тени от солнца (B) и яркость (A) — обычная текстура с мипами.
// Тень хранится как высота луча над грунтом со знаком: граница получается гладкой, а не по текселям
function bakeTexture(H, A, sp, tanE) {
  const gap = new Float32Array(TN * TN), drop = sp * tanE, range = drop * 12;
  for (let j = 0; j < TN; j++) {
    const row = j * TN;
    let ray = -Infinity;
    // Идём от солнца (+x): луч опускается с каждым шагом, вершины его поднимают. Тайл замкнут — два прохода
    for (let pass = 0; pass < 2; pass++) {
      for (let i = TN - 1; i >= 0; i--) {
        const h = H[row + i];
        ray -= drop;
        if (pass) gap[row + i] = Math.max(-range, Math.min(range, ray - h));
        if (h > ray) ray = h;
      }
    }
  }
  // Лучи считаются по строкам независимо: чуть размываем поперёк, иначе край тени идёт зубцами
  const soft = new Float32Array(TN * TN);
  for (let j = 0, k = 0; j < TN; j++) {
    const j0 = ((j - 1) & MASK) * TN, j1 = ((j + 1) & MASK) * TN;
    for (let i = 0; i < TN; i++, k++) soft[k] = (gap[j0 + i] + 2 * gap[k] + gap[j1 + i]) * 0.25;
  }
  const px = new Uint8Array(TN * TN * 4), enc = (s) => Math.round((0.5 + 0.5 * s / (1 + Math.abs(s))) * 255);
  for (let j = 0, k = 0; j < TN; j++) {
    const j0 = ((j - 1) & MASK) * TN, j1 = ((j + 1) & MASK) * TN, row = j * TN;
    for (let i = 0; i < TN; i++, k++) {
      px[k * 4] = enc((H[row + ((i + 1) & MASK)] - H[row + ((i - 1) & MASK)]) / (2 * sp));
      px[k * 4 + 1] = enc((H[j1 + i] - H[j0 + i]) / (2 * sp));
      px[k * 4 + 2] = Math.round((0.5 + 0.5 * Math.max(-1, Math.min(1, soft[k] / range))) * 255);
      px[k * 4 + 3] = Math.round((0.5 + 0.5 * Math.max(-1, Math.min(1, A[k]))) * 255);
    }
  }
  const t = new THREE.DataTexture(px, TN, TN, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

function heightTexture(H) {
  const t = new THREE.DataTexture(H, TN, TN, THREE.RedFormat, THREE.FloatType);
  t.internalFormat = 'R32F';
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}

// Сглаженное чтение тайла (квадратичный B-сплайн): один и тот же расчёт в шейдере и физике
function readTile(H, x, z, sp) {
  const fx = x / sp, fz = z / sp, cx = Math.floor(fx + 0.5), cz = Math.floor(fz + 0.5);
  const tx = fx - cx, tz = fz - cz;
  const ax = 0.5 * (0.5 - tx) * (0.5 - tx), bx = 0.75 - tx * tx, dx = 0.5 * (0.5 + tx) * (0.5 + tx);
  const az = 0.5 * (0.5 - tz) * (0.5 - tz), bz = 0.75 - tz * tz, dz = 0.5 * (0.5 + tz) * (0.5 + tz);
  const i0 = (cx - 1) & MASK, i1 = cx & MASK, i2 = (cx + 1) & MASK;
  const r0 = ((cz - 1) & MASK) * TN, r1 = (cz & MASK) * TN, r2 = ((cz + 1) & MASK) * TN;
  return az * (ax * H[r0 + i0] + bx * H[r0 + i1] + dx * H[r0 + i2])
    + bz * (ax * H[r1 + i0] + bx * H[r1 + i1] + dx * H[r1 + i2])
    + dz * (ax * H[r2 + i0] + bx * H[r2 + i1] + dx * H[r2 + i2]);
}

const TILE_GLSL = /* glsl */`
  float tile(highp sampler2D t, vec2 p, float sp) {
    vec2 x = p / sp, c = floor(x + 0.5), f = x - c;
    vec2 w0 = 0.5 * (0.5 - f) * (0.5 - f), w1 = 0.75 - f * f, w2 = 0.5 * (0.5 + f) * (0.5 + f);
    ivec2 i = ivec2(c);
    float s = 0.0;
    for (int b = -1; b <= 1; b++) {
      float wz = b < 0 ? w0.y : b == 0 ? w1.y : w2.y;
      for (int a = -1; a <= 1; a++) {
        float wx = a < 0 ? w0.x : a == 0 ? w1.x : w2.x;
        s += wx * wz * texelFetch(t, (i + ivec2(a, b)) & ${MASK}, 0).r;
      }
    }
    return s;
  }`;

// ---------------------------------------------------------------- материалы
const SURFACE_GLSL = /* glsl */`
#if STYLE <= 1
  void surf(vec3 q, float px, float slope, float alb, out vec3 col, out float h, out vec3 emi) {
    emi = vec3(0.0); h = 0.0;
    float m = inoise(q / 2600.0 + 3.1) * 0.55 + inoise(q / 640.0 + 7.7) * 0.3 + inoise(q / 160.0 + 1.3) * 0.15;
    col = mix(uColA, uColB, smoothstep(0.28, 0.72, m));
    col = mix(col, uColC, smoothstep(0.3, 0.75, slope));
    // Шум на плоскости: повёрнутые координаты, чтобы не проступала решётка.
    // Кратеры и камни — объёмные слои, режем их посередине ячейки (там центры)
    vec3 qr = vec3(0.8 * q.x + 0.6 * q.z, 0.37, -0.6 * q.x + 0.8 * q.z), qs = vec3(0.6 * q.x - 0.8 * q.z, 0.71, 0.8 * q.x + 0.6 * q.z);
    float w = lod(px, 30.0);
    if (w > 0.0) { float g = inoise(qr / 30.0); h += (g - 0.5) * 1.6 * w; alb += (g - 0.5) * 0.16 * w; }
    w = lod(px, 28.0);
    if (w > 0.0) h += craterLayer(q + vec3(0.0, 14.0, 0.0), 28.0, uDens * 0.8, w, w, alb);
    w = lod(px, 9.0);
    if (w > 0.0) h += craterLayer(q + vec3(0.0, 4.5, 0.0), 9.0, uDens * 0.7, w, w, alb);
    w = lod(px, 2.2);
    if (w > 0.0) h += craterLayer(q + vec3(0.0, 1.1, 0.0), 2.2, uDens * 0.6, w, w, alb);
    w = lod(px, 1.6);
    if (w > 0.0) h += rockLayer(q + vec3(0.0, 0.8, 0.0), 1.6, 0.22, w, alb);
    w = lod(px, 0.6);
    if (w > 0.0) { float g = inoise(qr / 0.6); h += (g - 0.5) * 0.06 * w; alb += (g - 0.5) * 0.08 * w; }
    w = lod(px, 0.2);
    if (w > 0.0) { float g = inoise(qs / 0.2) * 0.6 + inoise(qr / 0.07) * 0.4; h += (g - 0.5) * 0.02 * w; alb += (g - 0.5) * 0.3 * w; }
    col *= clamp(1.0 + alb, 0.4, 1.8);
  #if STYLE == 1
    // Марс: тёмный базальтовый песок, рябь дюн, слоистые скалы
    col = mix(col, vec3(0.16, 0.09, 0.07), smoothstep(0.55, 0.72, inoise(q / 420.0 + 21.0)) * 0.55 * (1.0 - smoothstep(0.3, 0.7, slope)));
    w = lod(px, 3.0);
    if (w > 0.0) h += sin(dot(q.xz, vec2(1.3, 1.75)) + inoise(q / 18.0) * 6.0) * 0.05 * w * (1.0 - smoothstep(0.2, 0.5, slope));
    col *= 1.0 + sin(vY * 0.9 + inoise(q / 80.0) * 3.0) * 0.2 * smoothstep(0.35, 0.9, slope);
  #endif
  }
#elif STYLE == 2
  // Венера: базальт в трещинах, светлые наносы; в редких трещинах и ручьях светится лава
  vec2 voro(vec2 x) {
    vec2 fl = floor(x), f = x - fl;
    ivec2 i = ivec2(fl);
    float a = 8.0, b = 8.0;
    for (int dz = -1; dz <= 1; dz++) {
      for (int dx = -1; dx <= 1; dx++) {
        ivec3 c = ivec3(i.x + dx, i.y + dz, 7);
        float d = length(vec2(float(dx) + ihash(c), float(dz) + ihash(c + 13)) - f);
        if (d < a) { b = a; a = d; } else if (d < b) b = d;
      }
    }
    return vec2(a, b);
  }
  void surf(vec3 q, float px, float slope, float alb, out vec3 col, out float h, out vec3 emi) {
    emi = vec3(0.0); h = 0.0;
    float m = inoise(q / 2200.0 + 2.1) * 0.6 + inoise(q / 520.0 + 5.3) * 0.28 + inoise(q / 130.0) * 0.12;
    col = mix(uColA, uColB, smoothstep(0.32, 0.72, m));
    col = mix(col, uColC, smoothstep(0.25, 0.7, slope));
    float zone = smoothstep(0.42, 0.6, inoise(q / 2600.0 + 9.0));
    float riv = 1.0 - smoothstep(0.0, 0.014, abs(inoise(q / 800.0 + 4.0) - 0.5));
    emi += vec3(2.6, 0.7, 0.12) * riv * zone * (0.75 + 0.25 * sin(uTime * 0.9 + q.x * 0.02));
    col *= 1.0 - riv * zone * 0.7;
    vec3 qr = vec3(0.8 * q.x + 0.6 * q.z, 0.37, -0.6 * q.x + 0.8 * q.z), qs = vec3(0.6 * q.x - 0.8 * q.z, 0.71, 0.8 * q.x + 0.6 * q.z);
    float w = lod(px, 7.0);
    if (w > 0.0) {
      vec2 f = voro((q.xz + vec2(inoise(qr / 2.6), inoise(qs / 2.6)) * 2.4) / 7.0);
      float crack = 1.0 - smoothstep(0.0, 0.035, f.y - f.x);
      h -= crack * 0.07 * w;
      col *= 1.0 - crack * 0.42 * w;
      emi += vec3(2.2, 0.55, 0.08) * crack * w * smoothstep(0.6, 0.72, inoise(q / 170.0 + 13.0)) * (0.7 + 0.3 * sin(uTime * 1.3 + q.z * 0.1));
    }
    w = lod(px, 30.0);
    if (w > 0.0) { float g = inoise(qr / 30.0); h += (g - 0.5) * 1.2 * w; alb += (g - 0.5) * 0.2 * w; }
    w = lod(px, 0.7);
    if (w > 0.0) { float g = inoise(qr / 0.7); h += (g - 0.5) * 0.05 * w; alb += (g - 0.5) * 0.14 * w; }
    w = lod(px, 0.2);
    if (w > 0.0) { float g = inoise(qs / 0.2); h += (g - 0.5) * 0.012 * w; alb += (g - 0.5) * 0.2 * w; }
    col *= clamp(1.0 + alb, 0.4, 1.8);
  }
#else
  // Юпитер и Сатурн: полосы по одной оси, клубы и волокна, ветер их медленно сдвигает
  void surf(vec3 q, float px, float slope, float alb, out vec3 col, out float h, out vec3 emi) {
    h = 0.0;
    vec3 d = vec3(0.8 * q.x + 0.6 * q.z + uTime * 7.0, 0.37, -0.6 * q.x + 0.8 * q.z);
    float b = q.z / uBands + (inoise(d / 1400.0) - 0.5) * uWarp;
    float prof = sin(b * 6.283) * 0.6 + sin(b * 3.6 + 1.3) * 0.4 + (inoise(d / 320.0) - 0.5) * 0.9;
    col = mix(uColA, uColB, smoothstep(-0.5, 0.5, prof));
    col = mix(col, uColC, smoothstep(0.55, 0.85, inoise(vec3(q.z / uBands * 3.0, 1.7, 4.0))) * 0.5);
    // Клубы разного тона: белые шапки, рыжие просветы между ними
    float puff = inoise(d / 180.0) * 0.5 + inoise(d / 60.0 + 3.0) * 0.3 + inoise(d / 17.0 + 7.0) * 0.2;
    col = mix(col, uColB, smoothstep(0.45, 0.68, puff) * 0.85);
    col = mix(col, uColA, smoothstep(0.42, 0.26, puff) * 0.6);
    float w = lod(px, 40.0);
    if (w > 0.0) { float g = inoise(d / 40.0); h += g * 7.0 * w; alb += (g - 0.5) * 0.14 * w; }
    w = lod(px, 8.0);
    if (w > 0.0) { float g = inoise(d / 8.0); h += g * 1.6 * w; alb += (g - 0.5) * 0.08 * w; }
    w = lod(px, 2.0);
    if (w > 0.0) { float g = inoise(d / 2.0); h += g * 0.3 * w; alb += (g - 0.5) * 0.04 * w; }
    col *= clamp(1.0 + alb, 0.5, 1.6);
    emi = col * 0.36;   // свет рассеивается внутри облаков
  }
#endif`;

function terrainMaterial(M, uCam, uTime) {
  const L = M.look, mat = new THREE.MeshStandardMaterial({ roughness: 0.97, metalness: 0, envMapIntensity: 0 });
  mat.defines.STYLE = L.style;
  mat.customProgramCacheKey = () => `planetmap${L.style}`;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      uCam, uTime, uRvI: { value: 1 / (2 * RV) },
      tBig: { value: M.tBig }, tFine: { value: M.tFine }, tNB: { value: M.tNB }, tNF: { value: M.tNF },
      uColA: { value: new THREE.Vector3(...L.a) }, uColB: { value: new THREE.Vector3(...L.b) }, uColC: { value: new THREE.Vector3(...L.c) },
      uDens: { value: L.dens }, uTanE: { value: M.tanE }, uShK: { value: L.shadow },
      uBands: { value: L.bands || 1 }, uWarp: { value: L.warp || 0 },
    });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform highp sampler2D tBig, tFine;
        uniform vec2 uCam; uniform float uRvI;
        varying vec2 vR; varying float vY;
        ${TILE_GLSL}`)
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
      // position = (i, шаг уровня, j). Каждый уровень привязан к своей решётке; у внешнего края
      // нечётные вершины сползают на решётку следующего уровня — и стыка не видно
      .replace('#include <begin_vertex>', /* glsl */`
        float sG = position.y;
        vec2 p0 = floor(uCam / (2.0 * sG) + 0.5) * 2.0 * sG + position.xz * sG;
        float dG = max(abs(p0.x - uCam.x), abs(p0.y - uCam.y)) / sG;
        vec2 pM = p0 - mod(position.xz, 2.0) * sG * smoothstep(${(GRID_H * 0.62).toFixed(1)}, ${(GRID_H - 5).toFixed(1)}, dG);
        float dC = distance(pM, uCam);
        float fK = 1.0 - smoothstep(1500.0, 3000.0, dC);
        float hT = tile(tBig, pM, ${BIG_SP.toFixed(1)});
        if (fK > 0.0) hT += fK * tile(tFine, pM, ${FINE_SP.toFixed(1)});
        vR = pM - uCam; vY = hT;   // относительно камеры: в десятках км интерполяция грубее мелких деталей
        vec3 transformed = vec3(pM.x, hT - dC * dC * uRvI, pM.y);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`#include <common>
        uniform sampler2D tNB, tNF;
        uniform float uTime, uTanE, uDens, uShK, uBands, uWarp;
        uniform vec2 uCam;
        uniform vec3 uColA, uColB, uColC;
        varying vec2 vR; varying float vY;
        ${INOISE_GLSL}
        ${CRATER_GLSL}
        ${BUMP_GLSL}
        ${SURFACE_GLSL}
        vec2 decS(vec2 e) { vec2 v = e * 2.0 - 1.0; return v / max(1.0 - abs(v), 0.03); }`)
      .replace('#include <color_fragment>', /* glsl */`
        vec2 vP = uCam + vR;
        vec4 nB = texture2D(tNB, vP / ${BIG_P.toFixed(1)} + ${(0.5 / TN).toFixed(7)});
        vec4 nF = texture2D(tNF, vP / ${FINE_P.toFixed(1)} + ${(0.5 / TN).toFixed(7)});
        #if STYLE == 3
          vec2 sl = decS(nB.rg) * 0.55 + decS(nF.rg) * 0.22;   // облака мягче камня
        #else
          vec2 sl = decS(nB.rg) + decS(nF.rg);
        #endif
        gN = vec3(0.0, 1.0, 0.0); gSunT = vec3(1.0, 0.0, 0.0); gTanA = uTanE; gShadow = 1.0;
        vec3 sCol, sEmi; float sH;
        surf(vec3(vP.x, 0.0, vP.y), length(fwidth(vR)), length(sl), (nB.a + nF.a - 1.0) * 2.0, sCol, sH, sEmi);
        diffuseColor.rgb = sCol;`)
      .replace('#include <normal_fragment_begin>', /* glsl */`#include <normal_fragment_begin>
        normal = bumpN(normalize(mat3(viewMatrix) * normalize(vec3(-sl.x, 1.0, -sl.y))), -vViewPosition, sH);`)
      .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance += sEmi;')
      // Запечённые тени гор и кратеров гасят только прямой свет
      .replace('#include <aomap_fragment>', /* glsl */`
        float bS = mix(1.0, (1.0 - smoothstep(0.47, 0.58, nB.b)) * (1.0 - smoothstep(0.47, 0.58, nF.b)), uShK) * mix(1.0, gShadow, uShK);
        reflectedLight.directDiffuse *= bS; reflectedLight.directSpecular *= bS;
        #include <aomap_fragment>`);
  };
  return mat;
}

function rockMaterial(M, uCam) {
  const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(...M.look.rock), roughness: 0.92, metalness: 0, flatShading: true, envMapIntensity: 0 });
  mat.customProgramCacheKey = () => 'planetmap-rock';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uCam = uCam;
    shader.uniforms.uRvI = { value: 1 / (2 * RV) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec2 uCam; uniform float uRvI; varying vec3 vRq;')
      .replace('#include <project_vertex>', /* glsl */`
        vec4 rP = instanceMatrix * vec4(transformed, 1.0);
        vRq = rP.xyz - vec3(uCam.x, 0.0, uCam.y);
        float rD = distance(instanceMatrix[3].xz, uCam);
        rP.y -= rD * rD * uRvI;
        vec4 mvPosition = modelViewMatrix * rP;
        gl_Position = projectionMatrix * mvPosition;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec2 uCam;
        varying vec3 vRq;
        ${INOISE_GLSL}
        ${BUMP_GLSL}`)
      .replace('#include <color_fragment>', /* glsl */`
        vec3 rQ = vRq + vec3(uCam.x, 0.0, uCam.y);
        float rPx = length(fwidth(vRq));
        float rG = inoise(rQ * 1.3) * 0.6 + inoise(rQ * 4.1) * 0.4;
        float rW = lod(rPx, 0.6);
        float rH = (rG - 0.5) * 0.14 * lod(rPx, 2.0) + (inoise(rQ * 13.0) - 0.5) * 0.03 * rW;
        diffuseColor.rgb *= 0.8 + 0.4 * rG;`)
      .replace('#include <normal_fragment_begin>', /* glsl */`#include <normal_fragment_begin>
        normal = bumpN(normal, -vViewPosition, rH);`);
  };
  return mat;
}

function rockGeometry(detail) {
  const g = new THREE.IcosahedronGeometry(1, detail), p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 1 + 0.28 * Math.sin(x * 3.1 + 1.7) * Math.sin(y * 2.3 + 0.4) * Math.sin(z * 2.9 + 2.1)
      + 0.12 * Math.sin(x * 7.3 + y * 6.1 + 2) * Math.sin(z * 6.7 + 0.7);
    p.setXYZ(i, x * k, y * k, z * k);
  }
  g.computeVertexNormals();
  return g;
}

// Детерминированный случай для ячейки: камни и валуны не нужно хранить
function cellHash(x, z, s) {
  let h = Math.imul(x, 374761393) + Math.imul(z, 668265263) + Math.imul(s, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const _b = { x: 0, z: 0, s: 0 };

export class PlanetMap {
  constructor(scene, space, world) {
    this.scene = scene; this.space = space; this.world = world;
    this.active = false;
    this.body = null; this.cur = null; this.pending = null;
    this.O = new THREE.Vector3();   // начало карты — верх настоящего тела
    this.maps = {};
    this.uCam = { value: new THREE.Vector2() };
    this.uTime = { value: 0 };
    this.blackT = 0;
    this.fade = document.getElementById('map-fade');
    this.createGrid();
    this.createRocks();
    this.createDome();
  }

  // Вложенные квадраты одной геометрией: x, z — индексы ячейки, y — шаг уровня (см. begin_vertex)
  createGrid() {
    const H = GRID_H, hole = H / 2 - 1, pos = [], idx = [];
    for (let l = 0; l < LEVELS; l++) {
      const map = new Map(), s = 2 ** l;
      const vert = (i, j) => {
        const key = (i + H) * 1000 + (j + H);
        let v = map.get(key);
        if (v === undefined) { v = pos.length / 3; pos.push(i, s, j); map.set(key, v); }
        return v;
      };
      for (let j = -H; j < H; j++) {
        for (let i = -H; i < H; i++) {
          if (l > 0 && i >= -hole && i + 1 <= hole && j >= -hole && j + 1 <= hole) continue;
          const a = vert(i, j), b = vert(i + 1, j), c = vert(i, j + 1), d = vert(i + 1, j + 1);
          idx.push(a, c, b, b, c, d);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
    this.terrain = new THREE.Mesh(geo);
    this.terrain.frustumCulled = false;
    this.terrain.receiveShadow = true;
    this.terrain.visible = false;
    this.scene.add(this.terrain);
  }

  createRocks() {
    const make = (detail, n) => {
      const m = new THREE.InstancedMesh(rockGeometry(detail), undefined, n);
      m.frustumCulled = false;
      m.castShadow = true;
      m.visible = false;
      m.count = 0;
      this.scene.add(m);
      return m;
    };
    this.rocksS = make(1, (2 * RANGE_S + 1) ** 2);
    this.rocksB = make(2, (2 * RANGE_B + 1) ** 2);
  }

  // Небо планеты с атмосферой: купол в космической сцене поверх звёзд и Солнца
  createDome() {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uSun: { value: new THREE.Vector3(0, 1, 0) }, uTime: this.uTime,
        uHor: { value: new THREE.Vector3() }, uZen: { value: new THREE.Vector3() }, uGlow: { value: new THREE.Vector3() }, uCloud: { value: new THREE.Vector3() },
        uAH: { value: 1 }, uAZ: { value: 1 }, uCloudK: { value: 0 }, uScale: { value: new THREE.Vector2(1, 1) },
      },
      vertexShader: 'varying vec3 vD; void main() { vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: /* glsl */`
        uniform vec3 uSun, uHor, uZen, uGlow, uCloud; uniform float uTime, uAH, uAZ, uCloudK; uniform vec2 uScale;
        varying vec3 vD;
        ${NOISE_GLSL}
        void main() {
          vec3 d = normalize(vD);
          float hk = pow(1.0 - max(d.y, 0.0), 3.5);
          vec3 col = mix(uZen, uHor, hk);
          float a = mix(uAZ, uAH, hk);
          float s = max(dot(d, uSun), 0.0);
          col += uGlow * (pow(s, 6.0) * 0.25 + pow(s, 48.0) * 0.6);
          if (uCloudK > 0.0 && d.y > 0.0) {
            float c = fbm3(vec3(d.xz / (d.y + 0.12) * uScale + vec2(uTime * 0.004, 0.0), 1.0), 5);
            float m = smoothstep(0.42, 0.72, c) * smoothstep(0.0, 0.18, d.y) * uCloudK;
            col = mix(col, uCloud * (0.75 + 0.5 * pow(s, 4.0)), m);
            a = max(a, m);
          }
          gl_FragColor = vec4(col, a);
        }`,
      side: THREE.BackSide, transparent: true, depthTest: false, depthWrite: false,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(200000, 32, 16), mat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = 10;
    this.dome.visible = false;
    this.space.scene.add(this.dome);
  }

  build(body) {
    const look = LOOKS[body.id], el = THREE.MathUtils.degToRad(look.sunEl), tanE = Math.tan(el);
    const T = look.gen(mulberry32(Math.floor(body.r) + body.id.charCodeAt(1)));
    const color = (c) => new THREE.Color().setRGB(c[0], c[1], c[2]);
    const M = {
      look, tanE, bigH: T.bigH, fineH: T.fineH,
      sunDir: new THREE.Vector3(Math.cos(el), Math.sin(el), 0),
      sunC: color(look.sunC), hemiC: color(look.hemiC), hemiG: color(look.hemiG),
      fogC: color(look.sky ? look.sky.hor : [0, 0, 0]),
      tBig: heightTexture(T.bigH), tFine: heightTexture(T.fineH),
      tNB: bakeTexture(T.bigH, T.bigA, BIG_SP, tanE), tNF: bakeTexture(T.fineH, T.fineA, FINE_SP, tanE),
    };
    M.mat = terrainMaterial(M, this.uCam, this.uTime);
    if (look.rocks || look.boulders) M.rockMat = rockMaterial(M, this.uCam);
    return M;
  }

  // Касание сбоку: экран сразу чёрный, перенос — следующим кадром (создание карты спрятано)
  request(body, n, speed) {
    if (this.pending || this.active || this.blocked?.()) return false;
    this.pending = { body, n: n.clone(), speed, wait: 1 };
    this.setBlack();
    return true;
  }

  setBlack() {
    this.blackT = 3;
    this.fade.classList.add('black');
  }

  // После шага героя: перенос туда и обратно
  tick(hero) {
    if (this.blackT > 0 && --this.blackT === 0) this.fade.classList.remove('black');
    if (this.pending) {
      if (this.pending.wait-- <= 0) {
        const { body, n, speed } = this.pending;
        this.pending = null;
        this.enter(hero, body, n, speed);
      }
    } else if (this.active && hero.pos.y - this.O.y > EXIT_ALT) this.exit(hero);
  }

  enter(hero, body, n, speed) {
    const M = this.maps[body.id] || (this.maps[body.id] = this.build(body)), L = M.look;
    this.body = body; this.cur = M; this.active = true;
    const O = this.O.set(body.c.x, body.c.y + body.r, body.c.z);
    this.terrain.material = M.mat;
    this.terrain.position.copy(O);
    this.terrain.visible = true;
    for (const m of [this.rocksS, this.rocksB]) {
      m.position.copy(O);
      m.count = 0;
      m.visible = !!M.rockMat;
      if (M.rockMat) m.material = M.rockMat;
    }
    this.sx = this.bx = NaN;
    const S = L.sky, u = this.dome.material.uniforms;
    this.dome.visible = !!S;
    if (S) {
      u.uSun.value.copy(M.sunDir);
      u.uHor.value.set(...S.hor); u.uZen.value.set(...S.zen); u.uGlow.value.set(...S.glow);
      u.uAH.value = S.aH; u.uAZ.value = S.aZ;
      u.uCloud.value.set(...(S.cloud || [0, 0, 0])); u.uCloudK.value = S.cloudK || 0;
      if (S.scale) u.uScale.value.set(...S.scale);
    }
    this.space.mapBodyId = body.id;
    // С Луны настоящая Земля была бы под ногами — ставим её в небо
    if (L.earth) this.space.moveEarth(_p.set(...L.earth).normalize().multiplyScalar(2288000).add(O));

    // Какой стороной коснулись шара — в то место карты и попадаем
    const wrap = (v) => ((v % BIG_P) + BIG_P) % BIG_P;
    const x = wrap(Math.atan2(n.x, n.z) * body.r), z = wrap(Math.asin(n.y) * body.r);
    const fall = Math.min(200, Math.max(25, speed * 0.3)), alt = Math.max(40, fall * 1.6);
    const g = O.y + this.heightLocal(x, z);
    hero.pos.set(O.x + x, g + alt, O.z + z);
    hero.vel.set(0, -fall, 0);
    hero.grounded = false; hero.falling = true; hero.slamming = false;
    hero.takeoffT = 0; hero.dashT = 0; hero.cruising = false; hero.lastDiveImpact = false;
    hero.onBody = hero.nearBody = body;
    hero.groundY = g; hero.bodyAlt = alt; hero.belowCap = false;
    this.world.toast?.(body.name.toUpperCase(), 2.4);
    this.world.audio?.whoosh(0.7);
  }

  // Вверх с карты — в космос над настоящим шаром
  exit(hero) {
    const b = this.body, up = Math.max(hero.vel.y, 40);
    this.leave();
    this.setBlack();
    hero.pos.set(b.c.x, b.c.y + b.r + Math.max(2000, b.r * 0.02), b.c.z);
    hero.vel.set(0, Math.min(up, 200), 0);
    hero.falling = false;
  }

  leave() {
    this.pending = null;
    if (!this.active) return;
    this.active = false;
    this.body = this.cur = null;
    this.terrain.visible = this.rocksS.visible = this.rocksB.visible = this.dome.visible = false;
    this.space.mapBodyId = null;
    this.space.moveEarth(null);
    this.shadowRange(this.env, 160);
  }

  heightLocal(x, z) {
    const M = this.cur;
    return readTile(M.bigH, x, z, BIG_SP) + readTile(M.fineH, x, z, FINE_SP);
  }

  // Валун в ячейке (если он там есть) — в _b: центр и радиус
  boulder(ix, iz) {
    if (cellHash(ix, iz, 1) > this.cur.look.boulders) return false;
    const u = cellHash(ix, iz, 2);
    _b.x = (ix + 0.15 + 0.7 * cellHash(ix, iz, 3)) * CELL_B;
    _b.z = (iz + 0.15 + 0.7 * cellHash(ix, iz, 4)) * CELL_B;
    _b.s = 1.2 + 6.5 * u * u * u;
    return true;
  }

  // Земля под ногами (мировые координаты): рельеф и валуны
  heightAt(wx, wz) {
    const x = wx - this.O.x, z = wz - this.O.z;
    let h = this.heightLocal(x, z);
    const ix = Math.floor(x / CELL_B), iz = Math.floor(z / CELL_B);
    for (let j = iz - 1; j <= iz + 1; j++) {
      for (let i = ix - 1; i <= ix + 1; i++) {
        if (!this.boulder(i, j)) continue;
        const r = _b.s * 0.85, d2 = ((x - _b.x) ** 2 + (z - _b.z) ** 2) / (r * r);
        if (d2 >= 1) continue;
        h = Math.max(h, this.heightLocal(_b.x, _b.z) - _b.s * 0.2 + _b.s * 0.75 * Math.sqrt(1 - d2));
      }
    }
    return this.O.y + h;
  }

  updateRocks(x, z, alt) {
    const L = this.cur.look;
    if (L.rocks) {
      const ix = Math.floor(x / CELL_S), iz = Math.floor(z / CELL_S);
      this.rocksS.visible = alt < 500;
      if (this.rocksS.visible && (ix !== this.sx || iz !== this.sz)) {
        this.sx = ix; this.sz = iz;
        let n = 0;
        for (let j = iz - RANGE_S; j <= iz + RANGE_S; j++) {
          for (let i = ix - RANGE_S; i <= ix + RANGE_S; i++) {
            if (cellHash(i, j, 5) > L.rocks) continue;
            const u = cellHash(i, j, 6), s = 0.1 + 0.75 * u * u;
            const px = (i + cellHash(i, j, 7)) * CELL_S, pz = (j + cellHash(i, j, 8)) * CELL_S;
            _p.set(px, this.heightLocal(px, pz) - s * 0.2, pz);
            _e.set(u * 41, cellHash(i, j, 9) * 6.28, u * 17);
            _s.set(s * (0.8 + u), s * 0.7, s);
            this.rocksS.setMatrixAt(n++, _m.compose(_p, _q.setFromEuler(_e), _s));
          }
        }
        this.rocksS.count = n;
        this.rocksS.instanceMatrix.needsUpdate = true;
      }
    }
    if (L.boulders) {
      const ix = Math.floor(x / CELL_B), iz = Math.floor(z / CELL_B);
      if (ix !== this.bx || iz !== this.bz) {
        this.bx = ix; this.bz = iz;
        let n = 0;
        for (let j = iz - RANGE_B; j <= iz + RANGE_B; j++) {
          for (let i = ix - RANGE_B; i <= ix + RANGE_B; i++) {
            if (!this.boulder(i, j)) continue;
            const s = _b.s;
            _p.set(_b.x, this.heightLocal(_b.x, _b.z) - s * 0.2, _b.z);
            _e.set((cellHash(i, j, 10) - 0.5) * 0.5, cellHash(i, j, 11) * 6.28, (cellHash(i, j, 12) - 0.5) * 0.5);
            _s.set(s, s * 0.75, s * (0.8 + 0.4 * cellHash(i, j, 13)));
            this.rocksB.setMatrixAt(n++, _m.compose(_p, _q.setFromEuler(_e), _s));
          }
        }
        this.rocksB.count = n;
        this.rocksB.instanceMatrix.needsUpdate = true;
      }
    }
  }

  shadowRange(env, s) {
    const c = env.sun.shadow.camera;
    if (c.right === s) return;
    c.left = c.bottom = -s; c.right = c.top = s;
    c.updateProjectionMatrix();
    this.env = env;
  }

  // После env.update: свет, дымка и экспозиция карты вместо земного времени суток
  update(dt, camera, env, hero) {
    if (!this.active) return;
    const M = this.cur, L = M.look, O = this.O;
    const x = camera.position.x - O.x, z = camera.position.z - O.z;
    this.uCam.value.set(x, z);
    this.uTime.value += dt;
    this.updateRocks(x, z, camera.position.y - O.y - this.heightLocal(x, z));
    env.sunDir.copy(M.sunDir);
    env.lightDir.copy(M.sunDir);
    env.sun.position.copy(hero.pos).addScaledVector(M.sunDir, 600);
    env.sun.color.copy(M.sunC);
    env.sun.intensity = L.sunI;
    this.shadowRange(env, 80);   // низкое солнце растягивает тени по грунту: карта теней плотнее
    env.hemi.color.copy(M.hemiC);
    env.hemi.groundColor.copy(M.hemiG);
    env.hemi.intensity = L.hemiI;
    env.scene.fog.color.copy(M.fogC);
    env.scene.fog.density = L.fog || 0;
    env.night = 0;
    env.golden = 0;
    env.exposure = L.exposure;
    this.dome.position.copy(camera.position);
  }
}
