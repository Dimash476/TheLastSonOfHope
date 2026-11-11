import * as THREE from 'three';
import { SPACE } from '../config.js';
import { mulberry32 } from '../utils.js';
import { ALL_BODIES, REGION, XARRON_ORIGIN, starOf, nearestBody } from './bodies.js';

// Отдельная «космическая» сцена: звёзды, Земля-шар с атмосферой и облаками, Солнце, Луна
// и планеты до Сатурна; далеко отсюда — система Ксаррона (голубой гипергигант в туманности,
// Ксаррон и его соседи). Рисуется ПЕРЕД основной сценой со своей камерой (огромная дальность
// прорисовки), а основная сцена рисуется поверх. Внизу у земли её закрывает небо.
//
// Расстояния здесь — до 3·10⁹ м, поэтому глубина логарифмическая (вручную, только в этих
// шейдерах): обычной не хватило бы и на облака Земли, и на камни у ног на Луне.
// Вершины переводим в систему камеры через modelViewMatrix (считается на CPU в double) —
// мировые координаты в миллионы метров во float32 дрожали бы.

// Звёзды — дальше всех тел (и дыр), иначе рисовались бы поверх планет. Гипергигант виден от белой дыры (1,2 млрд м),
// а наша система и система Ксаррона друг друга не видят: между ними ~5 млрд м, дальше FAR
const FAR = 3e9, STAR_DIST = 2.6e9;

export const LOGZ_V = 'varying float vLogZ;';
export const LOGZ_V_MAIN = 'vLogZ = 1.0 + gl_Position.w;';
export const LOGZ_F = 'uniform float uLogK; varying float vLogZ;';
export const LOGZ_F_MAIN = 'gl_FragDepth = log2(vLogZ) * uLogK;';

export const NOISE_GLSL = /* glsl */`
  float hash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float noise3(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash3(i), hash3(i + vec3(1,0,0)), f.x), mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), f.x), mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm3(vec3 p, int oct) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 8; i++) { if (i >= oct) break; s += a * noise3(p); p *= 2.02; a *= 0.5; }
    return s;
  }`;

// Мелкие детали поверхности считаются в метрах (сотни тысяч единиц): обычный hash3
// на таких числах теряет точность, поэтому решётка — целочисленная
export const INOISE_GLSL = /* glsl */`
  float ihash(ivec3 c) {
    uvec3 v = uvec3(c) * 1664525u + 1013904223u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    v ^= v >> 16u;
    v.x += v.y * v.z;
    return float(v.x) * (1.0 / 4294967296.0);
  }
  float inoise(vec3 x) {
    vec3 fl = floor(x), f = x - fl;
    ivec3 i = ivec3(fl);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(ihash(i), ihash(i + ivec3(1,0,0)), f.x), mix(ihash(i + ivec3(0,1,0)), ihash(i + ivec3(1,1,0)), f.x), f.y),
               mix(mix(ihash(i + ivec3(0,0,1)), ihash(i + ivec3(1,0,1)), f.x), mix(ihash(i + ivec3(0,1,1)), ihash(i + ivec3(1,1,1)), f.x), f.y), f.z);
  }
  // Деталь размером size (м) видна целиком, пока она не мельче ~16 пикселей; совсем мелкую не считаем
  float lod(float px, float size) { return 1.0 - smoothstep(size * 0.06, size * 0.25, px); }`;

// Кратеры одного масштаба: решётка ячеек cell (м), в доле density ячеек — чаша с валом
// и выбросами. Центр кратера — в средней половине ячейки, поэтому хватает 8 соседей.
// Возвращает высоту (м) с весом wh; в alb (с весом wa) — тон: чаша темнее, вал и свежие
// кратеры светлее (издалека кратеры видны тоном, вблизи — ещё и рельефом).
// При низком солнце дно у «солнечного» края уходит в тень вала (gShadow) — как на фото Луны
export const CRATER_GLSL = /* glsl */`
  vec3 gN, gSunT; float gTanA, gShadow;
  float craterLayer(vec3 q, float cell, float density, float wh, float wa, inout float alb) {
    vec3 x = q / cell, fl = floor(x), f = x - fl;
    ivec3 i = ivec3(fl), o = ivec3(step(0.5, f)) - 1;
    float h = 0.0;
    for (int k = 0; k < 8; k++) {
      ivec3 g = o + ivec3(k & 1, (k >> 1) & 1, (k >> 2) & 1), c = i + g;
      float r0 = ihash(c);
      if (r0 > density) continue;
      vec3 ctr = vec3(g) + 0.25 + 0.5 * vec3(ihash(c + 17), ihash(c + 31), ihash(c + 47));
      float rad = 0.1 + 0.2 * ihash(c + 61);
      float d = length(f - ctr) / rad;
      if (d > 1.4) continue;
      float bowl = d < 1.0 ? (d * d - 1.0) * 0.3 : 0.0;
      float rim = 0.09 * exp(-(d - 1.0) * (d - 1.0) * 30.0);
      float ej = d > 1.0 ? 0.03 * (1.0 - smoothstep(1.0, 1.4, d)) : 0.0;
      h += (bowl + rim + ej) * rad * cell;
      alb += wa * ((d < 1.0 ? -0.1 * (1.0 - d * d) : 0.0) + rim * 0.9
        + (1.0 - smoothstep(0.85, 1.3, d)) * (r0 < density * 0.2 ? 0.2 : 0.03));
      if (d < 1.0 && wh > 0.0) {
        // До вала в сторону солнца — tt метров; подняться нужно на глубину чаши и высоту вала
        vec3 x3 = (f - ctr) * cell;
        float z0 = dot(x3, gN), r = rad * cell;
        vec3 x = x3 - gN * z0;
        float xs = dot(x, gSunT);
        float tt = -xs + sqrt(max(xs * xs - dot(x, x) + r * r - z0 * z0, 0.0));
        float rise = (0.09 + (1.0 - d * d) * 0.3) * r;
        gShadow = min(gShadow, mix(1.0, smoothstep(-0.04 * r, 0.04 * r, tt * gTanA - rise), wh * smoothstep(1.0, 0.9, d)));
      }
    }
    return h * wh;
  }
  // Камни: невысокие купола, чуть темнее грунта
  float rockLayer(vec3 q, float cell, float density, float w, inout float alb) {
    vec3 x = q / cell, fl = floor(x), f = x - fl;
    ivec3 i = ivec3(fl), o = ivec3(step(0.5, f)) - 1;
    float h = 0.0;
    for (int k = 0; k < 8; k++) {
      ivec3 g = o + ivec3(k & 1, (k >> 1) & 1, (k >> 2) & 1), c = i + g;
      if (ihash(c + 5) > density) continue;
      vec3 ctr = vec3(g) + 0.25 + 0.5 * vec3(ihash(c + 11), ihash(c + 23), ihash(c + 37));
      float rad = 0.06 + 0.16 * ihash(c + 53) * ihash(c + 71);
      float d = length(f - ctr) / rad;
      if (d > 1.0) continue;
      h += sqrt(1.0 - d * d) * rad * cell * 0.55;
      alb -= w * 0.12;
    }
    return h * w;
  }`;

export const BUMP_GLSL = /* glsl */`
  // Рельеф светом: нормаль наклоняем по экранным производным высоты (без геометрии)
  vec3 bumpN(vec3 N, vec3 pos, float h) {
    vec3 dpx = dFdx(pos), dpy = dFdy(pos);
    float dhx = dFdx(h), dhy = dFdy(h);
    vec3 r1 = cross(dpy, N), r2 = cross(N, dpx);
    float det = dot(dpx, r1);
    vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
    return normalize(abs(det) * N - grad);
  }
`;

// Внешний вид тел (физика — в config.SPACE.bodies)
//   kind 0 — каменные (кратеры, рельеф светом), 1 — облачные (полосы, вихри)
const LOOKS = {
  moon: { kind: 0, a: [0.32, 0.32, 0.32], b: [0.62, 0.61, 0.58], dens: 0.6 },
  mercury: { kind: 0, a: [0.30, 0.28, 0.26], b: [0.55, 0.51, 0.47], dens: 0.75 },
  mars: { kind: 0, mars: true, a: [0.30, 0.13, 0.06], b: [0.66, 0.33, 0.15], dens: 0.3, atmo: [0.22, 0.12, 0.09] },
  venus: { kind: 1, style: 0, a: [0.80, 0.68, 0.45], b: [0.95, 0.89, 0.70], bands: 2.5, warp: 2.5, stretch: 1.5, atmo: [0.55, 0.48, 0.3] },
  jupiter: { kind: 1, style: 1, a: [0.58, 0.40, 0.27], b: [0.93, 0.88, 0.77], bands: 9.0, warp: 0.8, stretch: 4.0, atmo: [0.15, 0.16, 0.2] },
  saturn: { kind: 1, style: 2, a: [0.74, 0.62, 0.42], b: [0.90, 0.82, 0.62], bands: 7.0, warp: 0.35, stretch: 6.0, atmo: [0.2, 0.19, 0.15] },
  // Система Ксаррона. Пиррак — у самой звезды: чёрная корка в трещинах лавы
  pyrrak: { kind: 0, lava: true, a: [0.05, 0.045, 0.045], b: [0.15, 0.12, 0.11], dens: 0.45, atmo: [0.3, 0.1, 0.03] },
  // kind 2 — живой мир: материки, океаны, льды, облака, огни городов (ocean, city — цвета моря и огней)
  xarron: { kind: 2, a: [0.08, 0.075, 0.085], b: [0.3, 0.25, 0.22], ocean: [0.015, 0.06, 0.1], city: [1.0, 0.62, 0.32], atmo: [0.22, 0.3, 0.62], halo: [0.35, 0.45, 1.0] },
  tel: { kind: 0, a: [0.19, 0.2, 0.22], b: [0.44, 0.45, 0.49], dens: 0.55 },
  gorgat: { kind: 1, style: 2, a: [0.3, 0.22, 0.42], b: [0.8, 0.76, 0.9], bands: 8.0, warp: 0.9, stretch: 4.5, atmo: [0.18, 0.14, 0.32], ringC: [[0.42, 0.4, 0.58], [0.8, 0.84, 0.97]] },
  skarn: { kind: 1, style: 0, a: [0.3, 0.6, 0.68], b: [0.6, 0.86, 0.9], bands: 3.0, warp: 1.2, stretch: 2.0, atmo: [0.2, 0.42, 0.5] },
};

// Звёзды: цвета плазмы от тёмного к светлому, края диска, короны и протуберанцев.
// gran — частота зёрен (у гипергиганта ячейки конвекции огромные), spot: −1 — тёмные пятна, + — горячие,
// gain — яркость, span — размер короны в радиусах звезды
const STAR_LOOKS = {
  sun: {
    c0: [1.0, 0.2, 0.01], c1: [1.0, 0.55, 0.1], c2: [1.0, 0.8, 0.45], limb: [1.0, 0.45, 0.2], gran: 70, spot: -1, gain: 1.7,
    corona: [1.0, 0.45, 0.14], prom: [1.0, 0.22, 0.04], rim: [1.0, 0.6, 0.25], span: 4,
  },
  velkar: {
    c0: [0.22, 0.38, 1.0], c1: [0.55, 0.75, 1.0], c2: [0.92, 0.96, 1.0], limb: [0.45, 0.6, 1.0], gran: 26, spot: 0.5, gain: 2.6,
    corona: [0.42, 0.62, 1.0], prom: [0.55, 0.42, 1.0], rim: [0.75, 0.88, 1.0], span: 3.6,
  },
};

const PLANET_V = /* glsl */`
  varying vec3 vN; varying vec3 vNv; varying vec3 vView;
  ${LOGZ_V}
  void main() {
    vN = normal;
    vNv = normalMatrix * normal;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vView = mv.xyz;
    gl_Position = projectionMatrix * mv;
    ${LOGZ_V_MAIN}
  }`;

const PLANET_F = /* glsl */`
  uniform vec3 uSun; uniform float uR; uniform vec3 uAxis; uniform vec3 uSpot; uniform vec3 uSeed;
  uniform vec3 uColA; uniform vec3 uColB; uniform vec3 uAtmo; uniform float uDens;
  uniform vec3 uLight; uniform vec3 uOcean; uniform vec3 uCity; uniform float uTime;
  varying vec3 vN; varying vec3 vNv; varying vec3 vView;
  ${LOGZ_F}
  ${NOISE_GLSL}
  ${INOISE_GLSL}
  ${CRATER_GLSL}
  // Своё свечение поверхности (лава) и то, что видно только ночью (огни городов), море — для блика
  vec3 gEmi; float gNightEmi; float gOcean;

#if KIND == 0
  // Каменная поверхность: моря и материки, кратеры от сотен метров до метра, реголит
  void surface(vec3 n, vec3 q, float px, out vec3 col, out float h) {
    float m = fbm3(n * 5.0 + uSeed, 6);
    col = mix(uColA, uColB, smoothstep(0.35, 0.65, m)) * (1.0 + (fbm3(n * 80.0, 3) - 0.5) * 0.14);
    float alb = 0.0;
    h = 0.0;
    float c1 = uR / 14.0, c2 = uR / 60.0;
    h += craterLayer(q, c1, uDens, lod(px, c1 * 0.4), 1.0, alb);
    float w = lod(px, c2 * 2.0);
    if (w > 0.0) h += craterLayer(q, c2, uDens, lod(px, c2 * 0.4), w, alb);
    w = lod(px, 40.0);
    if (w > 0.0) h += craterLayer(q, 40.0, uDens * 0.8, w, w, alb);
    w = lod(px, 9.0);
    if (w > 0.0) h += craterLayer(q, 9.0, uDens * 0.7, w, w, alb);
    w = lod(px, 2.2);
    if (w > 0.0) h += craterLayer(q, 2.2, uDens * 0.6, w, w, alb);
    w = lod(px, 1.6);
    if (w > 0.0) h += rockLayer(q, 1.6, 0.22, w, alb);
    // Пологие холмы и камешки — только светом
    w = lod(px, 300.0);
    if (w > 0.0) h += (inoise(q / 300.0) - 0.5) * 14.0 * w;
    w = lod(px, 30.0);
    if (w > 0.0) h += (inoise(q / 30.0) - 0.5) * 2.0 * w;
    w = lod(px, 0.6);
    if (w > 0.0) { float g = inoise(q / 0.6); h += (g - 0.5) * 0.06 * w; alb += (g - 0.5) * 0.08 * w; }
    // Реголит у самых ног: зернистость в сантиметры
    w = lod(px, 0.2);
    if (w > 0.0) { float g = inoise(q / 0.2) * 0.6 + inoise(q / 0.07) * 0.4; h += (g - 0.5) * 0.02 * w; alb += (g - 0.5) * 0.3 * w; }
    col *= clamp(1.0 + alb, 0.4, 1.8);
  #ifdef MARS
    // Тёмные области, рябь дюн и полярные шапки (по оси, не сверху — сверху садятся)
    w = lod(px, 8.0);
    if (w > 0.0) h += sin(dot(q, vec3(0.61, 0.32, 0.72)) * 0.8 + inoise(q / 40.0) * 6.0) * 0.25 * w * smoothstep(0.45, 0.6, m);
    float lat = abs(dot(n, uAxis)) + (m - 0.5) * 0.12;
    col = mix(col, vec3(0.9, 0.88, 0.86), smoothstep(0.88, 0.91, lat));
  #endif
  #ifdef LAVA
    // Корка в сетке трещин: лава светится сама, сильнее в широких разломах и вдали от кратеров
    float cr = 1.0 - abs(fbm3(n * 11.0 + uSeed * 0.7, 5) * 2.0 - 1.0);
    float cr2 = 1.0 - abs(fbm3(n * 37.0 + uSeed * 1.9, 4) * 2.0 - 1.0);
    float lava = smoothstep(0.86, 0.97, cr) + smoothstep(0.9, 0.98, cr2) * 0.6 * smoothstep(0.4, 0.6, m);
    w = lod(px, 900.0);
    if (w > 0.0) lava += w * smoothstep(0.92, 0.99, 1.0 - abs(inoise(q / 900.0) * 2.0 - 1.0)) * 0.5;
    lava = clamp(lava, 0.0, 1.0);
    float pulse = 0.85 + 0.15 * sin(uTime * 0.7 + fbm3(n * 20.0, 2) * 12.0);
    col = mix(col, vec3(0.1, 0.03, 0.01), lava);
    gEmi = mix(vec3(0.9, 0.18, 0.02), vec3(1.6, 0.75, 0.2), lava * lava) * lava * pulse;
  #endif
  }
#elif KIND == 2
  // Ксаррон: материки и океаны, хребты, льды у полюсов, облака; ночью — сети огней городов.
  // Верх шара (там садятся) — всегда суша
  void surface(vec3 n, vec3 q, float px, out vec3 col, out float h) {
    float lat = dot(n, uAxis);
    float c = fbm3(n * 2.4 + uSeed, 6) + smoothstep(0.8, 0.97, n.y) * 0.3;
    float land = smoothstep(0.495, 0.51, c);
    float mtn = pow(1.0 - abs(fbm3(n * 9.0 + uSeed * 1.3, 5) * 2.0 - 1.0), 3.0) * smoothstep(0.5, 0.58, c);
    vec3 ground = mix(uColA, uColB, smoothstep(0.52, 0.72, c) * 0.55 + mtn * 0.45);
    ground *= 0.88 + 0.24 * fbm3(n * 60.0 + uSeed, 3);
    vec3 sea = mix(uOcean * 0.55, uOcean, smoothstep(0.3, 0.49, c));
    sea = mix(sea, uOcean * 2.2, smoothstep(0.465, 0.495, c) * 0.6);   // мелководье у берегов
    col = mix(sea, ground, land);
    float ice = smoothstep(0.8, 0.86, abs(lat) + (c - 0.5) * 0.2);
    col = mix(col, vec3(0.76, 0.8, 0.88), ice);
    gOcean = (1.0 - land) * (1.0 - ice);
    // Города: гуще у побережий и в долинах, в горах и во льдах их нет
    float coast = 1.0 - smoothstep(0.0, 0.1, c - 0.5);
    float sprawl = smoothstep(0.5, 0.68, fbm3(n * 26.0 + uSeed * 2.1, 4));
    float lights = smoothstep(0.55, 0.8, fbm3(n * 140.0 + uSeed * 3.3, 3));
    gNightEmi = land * (1.0 - ice) * (1.0 - mtn) * (0.25 + 0.75 * coast) * sprawl * (0.35 + 0.9 * lights);
    // Рельеф светом и мелочь вблизи
    h = mtn * uR * 0.01;
    float alb = 0.0;
    float w = lod(px, 3000.0);
    if (w > 0.0) { float g = inoise(q / 3000.0); h += (g - 0.5) * 400.0 * w * land; alb += (g - 0.5) * 0.15 * w; }
    w = lod(px, 300.0);
    if (w > 0.0) { float g = inoise(q / 300.0); h += (g - 0.5) * 30.0 * w * land; alb += (g - 0.5) * 0.12 * w; }
    w = lod(px, 30.0);
    if (w > 0.0) { float g = inoise(q / 30.0); h += (g - 0.5) * 3.0 * w; alb += (g - 0.5) * 0.1 * w; }
    w = lod(px, 1.6);
    if (w > 0.0) h += rockLayer(q, 1.6, 0.2, w, alb);
    w = lod(px, 0.4);
    if (w > 0.0) { float g = inoise(q / 0.4); h += (g - 0.5) * 0.04 * w; alb += (g - 0.5) * 0.12 * w; }
    col *= clamp(1.0 + alb, 0.5, 1.6);
    // Облака: медленно плывут, ночью гасят огни под собой
    float cl = fbm3(n * 4.2 + vec3(uTime * 0.0015, 0.0, 0.0) + uSeed * 3.0, 5);
    float cm = smoothstep(0.54, 0.74, cl) * (1.0 - smoothstep(0.96, 1.0, n.y) * 0.7);
    col = mix(col, vec3(0.84, 0.86, 0.9), cm * 0.85);
    gNightEmi *= 1.0 - cm * 0.75;
    gOcean *= 1.0 - cm;
  }
#else
  // Облачный шар: полосы по параллелям, шум растянут вдоль них — вихри вытягиваются в ленты
  void surface(vec3 n, vec3 q, float px, out vec3 col, out float h) {
    h = 0.0;
    float lat = dot(n, uAxis);
    vec3 p = n + uAxis * lat * STRETCH;
    float w = fbm3(p * 3.0 + uSeed, 5);
    float t = fbm3(p * 7.0 + w * 2.0 + uSeed * 1.7, 5);
    float b = lat * BANDS + (w - 0.5) * WARP;
    // Полосы разной ширины: две синусоиды и рваные края
    float prof = sin(b * 3.14159) * 0.6 + sin(b * 1.73 + 1.3) * 0.4 + (t - 0.5) * 0.7;
    float zone = smoothstep(-0.45, 0.45, prof);
    col = mix(uColA, uColB, zone);
    // Промежуточные рыжеватые ленты и тонкие струи вдоль параллелей
    col = mix(col, (uColA + uColB) * vec3(0.5, 0.45, 0.42) + vec3(0.06, 0.03, 0.0), smoothstep(0.55, 0.85, noise3(vec3(lat * 7.0, 1.7, uSeed.x))) * 0.6);
    col *= 0.86 + 0.28 * mix(t, fbm3(p * 24.0 + uSeed, 3), 0.5);
  #if STYLE == 1
    // Юпитер: голубоватые полюса и Большое красное пятно
    col = mix(col, vec3(0.52, 0.53, 0.58) * (0.9 + 0.2 * t), smoothstep(0.72, 0.9, abs(lat)));
    vec3 dS = n - uSpot;
    float dl = dot(dS, uAxis);
    float e = length(vec2(length(dS - uAxis * dl) / 0.15, dl / 0.075));
    vec3 spot = mix(vec3(0.70, 0.29, 0.17), vec3(0.86, 0.52, 0.34), 0.5 + 0.5 * sin(e * 12.0 - t * 4.0));
    col = mix(col, spot, smoothstep(1.0, 0.7, e));
  #endif
  #if STYLE == 0
    // Венера: сплошная пелена, светлее к полюсам
    col = mix(col, uColB, smoothstep(0.5, 0.95, abs(lat)) * 0.5);
  #endif
    // Вблизи — клубы облаков помельче
    float d1 = lod(px, 3000.0);
    if (d1 > 0.0) col *= 1.0 + d1 * (inoise(p * uR / 3000.0) - 0.5) * 0.14;
    float d2 = lod(px, 300.0);
    if (d2 > 0.0) col *= 1.0 + d2 * (inoise(p * uR / 300.0) - 0.5) * 0.08;
    // У самой «поверхности» (верхушки облаков) — клочья и волокна под ногами
    float d3 = lod(px, 30.0);
    if (d3 > 0.0) col *= 1.0 + d3 * (inoise(p * uR / 30.0) - 0.5) * 0.12;
    float d4 = lod(px, 4.0);
    if (d4 > 0.0) col *= 1.0 + d4 * (inoise(p * uR / 4.0) * 0.6 + inoise(p * uR / 1.3) * 0.4 - 0.5) * 0.1;
  }
#endif

  ${BUMP_GLSL}

  void main() {
    vec3 n = normalize(vN);
    vec3 q = n * uR;
    vec3 Nv = normalize(vNv);
    float px = length(fwidth(vView));
    // Солнце в касательной плоскости: направление и тангенс высоты (для теней в кратерах)
    float sh = dot(uSun, n);
    vec3 st = uSun - n * sh;
    gN = n; gSunT = st / max(length(st), 1e-4); gTanA = sh / max(length(st), 1e-4); gShadow = 1.0;
    gEmi = vec3(0.0); gNightEmi = 0.0; gOcean = 0.0;
    vec3 col; float h;
    surface(n, q, px, col, h);
    vec3 L = normalize((viewMatrix * vec4(uSun, 0.0)).xyz);
    float geo = dot(Nv, L);
  #if KIND != 1
    vec3 Nb = bumpN(Nv, vView, h);
    float amb = 0.015;
  #else
    vec3 Nb = Nv;
    float amb = 0.02;
  #endif
    float diff = max(dot(Nb, L), 0.0) * smoothstep(-0.05, 0.08, geo) * gShadow;
    float mu = max(dot(Nv, normalize(-vView)), 0.0);
    vec3 lit = col * (amb + 1.7 * diff);
  #if KIND == 1
    lit *= 0.65 + 0.35 * mu;
  #endif
  #if KIND == 2
    // Блик звезды на море
    vec3 Hv = normalize(L + normalize(-vView));
    lit += gOcean * pow(max(dot(Nv, Hv), 0.0), 70.0) * 1.2 * smoothstep(-0.05, 0.1, geo);
  #endif
    lit *= uLight;
    lit += uAtmo * uLight * pow(1.0 - mu, 3.0) * smoothstep(-0.25, 0.3, geo);
    lit += gEmi + uCity * gNightEmi * 0.9 * smoothstep(0.06, -0.14, geo);
    gl_FragColor = vec4(lit, 1.0);
    ${LOGZ_F_MAIN}
  }`;

// Солнце: зёрна плазмы (грануляция) крупные и мелкие, медленно кипят; тёмные пятна с полутенью,
// яркие факелы у края, потемнение к краю диска. Вблизи — всё мельче, до десятков метров под ногами
const SUN_F = /* glsl */`
  uniform float uR, uTime, uFade, uGran, uSpotK, uGain; uniform vec3 uSeed, uC0, uC1, uC2, uLimbC;
  varying vec3 vN; varying vec3 vNv; varying vec3 vView;
  ${LOGZ_F}
  ${NOISE_GLSL}
  ${INOISE_GLSL}
  // Ячейки конвекции: светлый центр, тёмные дорожки между зёрнами
  float cells(vec3 x) {
    vec3 fl = floor(x), f = x - fl;
    float a = 8.0, b = 8.0;
    for (int k = 0; k < 27; k++) {
      ivec3 g = ivec3(k % 3 - 1, (k / 3) % 3 - 1, k / 9 - 1), c = ivec3(fl) + g;
      vec3 o = vec3(g) + vec3(ihash(c), ihash(c + 19), ihash(c + 41)) - f;
      float d = dot(o, o);
      if (d < a) { b = a; a = d; } else if (d < b) b = d;
    }
    // Ярче к центру зерна, тёмная дорожка на границе
    return smoothstep(0.0, 0.3, sqrt(b) - sqrt(a)) * (1.0 - 0.55 * sqrt(a));
  }
  void main() {
    vec3 n = normalize(vN);
    float px = length(fwidth(vView));
    float t = uTime;
    // Край диска — только издалека: у поверхности взгляд скользящий, и тогда темнело бы всё
    float far = smoothstep(uR * 0.03, uR * 0.4, length(vView));
    float mu = mix(1.0, max(dot(normalize(vNv), normalize(-vView)), 0.0), far);
    // Крупные течения и супергранулы — по всему шару
    vec3 w = vec3(fbm3(n * 3.0 + uSeed + t * 0.004, 4), fbm3(n * 3.0 + uSeed.yzx - t * 0.003, 4), 0.0);
    float big = fbm3(n * 9.0 + w * 1.5 + vec3(0.0, t * 0.01, 0.0), 5);
    float gr = cells(n * uGran + w * 2.0 + vec3(t * 0.006, 0.0, 0.0));
    float b = 0.55 + 0.45 * mix(big, gr, 0.55);
    // Вблизи — мелкие гранулы в метрах (целочисленный шум: без дрожи на больших числах)
    vec3 q = n * uR;
    float l1 = lod(px, 9000.0);
    if (l1 > 0.0) b = mix(b, b * (0.6 + 0.6 * cells(q / 9000.0 + vec3(0.0, t * 0.03, 0.0))), l1);
    float l2 = lod(px, 900.0);
    if (l2 > 0.0) b *= 1.0 + l2 * (inoise(q / 900.0 + vec3(t * 0.08)) - 0.5) * 0.5;
    float l3 = lod(px, 90.0);
    if (l3 > 0.0) b *= 1.0 + l3 * (inoise(q / 90.0 + vec3(t * 0.25)) - 0.5) * 0.35;
    // Под ногами — кипящие зёрна в десятки метров и рябь в метры
    float l4 = lod(px, 40.0);
    if (l4 > 0.0) b *= mix(1.0, 0.45 + 0.9 * cells(q / 40.0 + vec3(0.0, t * 0.35, 0.0)), l4 * 0.9);
    float l6 = lod(px, 8.0);
    if (l6 > 0.0) b *= mix(1.0, 0.7 + 0.5 * cells(q / 8.0 + vec3(t * 0.6, 0.0, 0.0)), l6);
    float l5 = lod(px, 5.0);
    if (l5 > 0.0) b *= 1.0 + l5 * (inoise(q / 5.0 + vec3(t * 1.1)) - 0.5) * 0.45;
    // Пятна: тёмная тень в светлой полутени (у горячего гипергиганта — наоборот, яркие сгустки)
    float sp = fbm3(n * 5.0 + uSeed * 1.7, 4);
    float pen = smoothstep(0.66, 0.7, sp), umb = smoothstep(0.71, 0.74, sp);
    b *= 1.0 + uSpotK * (pen * 0.45 + umb * 0.45);
    // Факелы: светлые прожилки, заметнее у края
    float fac = smoothstep(0.62, 0.66, sp) * (1.0 - pen) + smoothstep(0.6, 0.7, fbm3(n * 22.0 + uSeed, 3)) * 0.4;
    b += fac * (1.0 - mu) * 0.6;
    // Цвет по «температуре»: тёмное — красно-оранжевое, светлое — почти белое
    vec3 col = mix(uC0, uC1, smoothstep(0.35, 0.95, b));
    col = mix(col, uC2, smoothstep(0.95, 1.25, b));
    // Потемнение к краю: край краснее (у голубой звезды — синее) и тусклее
    float limb = 0.22 + 0.78 * pow(mu, 0.55);
    col *= mix(uLimbC, vec3(1.0), pow(mu, 0.35));
    gl_FragColor = vec4(col * b * limb * uGain * uFade, uFade);
    ${LOGZ_F_MAIN}
  }`;

// Корона и протуберанцы: плоскость в центре Солнца, всегда к камере (диск закрывает её середину).
// Лучи-стримеры по углу, у края — петли и языки плазмы; всё медленно меняется
const CORONA_F = /* glsl */`
  uniform float uTime, uFade, uSpan; uniform vec3 uSeed, uCorC, uPromC, uRimC;
  varying vec2 vUv;
  ${LOGZ_F}
  ${NOISE_GLSL}
  void main() {
    vec2 p = (vUv - 0.5) * 2.0 * uSpan;   // в радиусах Солнца
    float r = length(p), a = atan(p.y, p.x);
    if (r < 0.98) discard;
    vec2 cs = vec2(cos(a), sin(a));
    float e = r - 1.0, t = uTime;
    // Ровное свечение
    float glow = exp(-e * 2.6) * 0.9 + exp(-e * 0.7) * 0.18;
    // Стримеры: вытянутые по радиусу лучи
    float st = fbm3(vec3(cs * 3.5, t * 0.01) + uSeed, 4);
    float rays = pow(fbm3(vec3(cs * 14.0, e * 0.6 - t * 0.02) + uSeed, 4), 2.0);
    float corona = glow * (0.55 + 1.1 * st) + rays * exp(-e * 1.1) * 1.4;
    // Протуберанцы: яркие петли и языки у самого края
    float pr = fbm3(vec3(cs * 9.0, e * 7.0 - t * 0.06) + uSeed * 1.3, 5);
    float zone = smoothstep(0.55, 0.75, fbm3(vec3(cs * 2.2, t * 0.005) + uSeed.zxy, 3));
    float prom = smoothstep(0.5, 0.62, pr) * zone * exp(-e * 4.5);
    // У самого диска — горячий край
    float rim = exp(-e * 22.0);
    vec3 col = uCorC * corona * 0.7 + uPromC * prom * 6.0 + uRimC * rim * 2.0;
    col *= smoothstep(uSpan, uSpan * 0.7, r);
    gl_FragColor = vec4(col * uFade, 1.0);
    ${LOGZ_F_MAIN}
  }`;

// Туманность вокруг гипергиганта: пузырь газа, который звезда сбросила с себя. Сфера рисуется
// изнутри (BackSide), а шейдер сам идёт лучом сквозь оболочку: видно и снаружи (от белой дыры —
// светящееся облако в волокнах), и изнутри (из системы небо в дымке). Ближе к звезде газ голубой,
// снаружи — фиолетово-розовый. Расстояния — в долях внешнего радиуса
const NEBULA_F = /* glsl */`
  uniform vec3 uCamL; uniform vec2 uRad; uniform float uTime, uGain; uniform int uN;
  varying vec3 vL;
  ${LOGZ_F}
  ${NOISE_GLSL}
  vec2 sph(vec3 o, vec3 d, float R) {
    float b = dot(o, d), c = dot(o, o) - R * R, h = b * b - c;
    if (h < 0.0) return vec2(1.0, -1.0);
    h = sqrt(h);
    return vec2(-b - h, -b + h);
  }
  void main() {
    vec3 o = uCamL / uRad.y, d = normalize(vL - uCamL);
    float ri = uRad.x / uRad.y;
    vec2 to = sph(o, d, 1.0), ti = sph(o, d, ri * 0.92);
    float t0 = max(to.x, 0.0), t1 = to.y;
    // Изнутри полости — только оболочка за её краем
    if (length(o) < ri * 0.92) t0 = max(t0, ti.y);
    if (t1 <= t0) discard;
    vec3 col = vec3(0.0);
    float dt = (t1 - t0) / float(uN);
    for (int i = 0; i < 8; i++) {
      if (i >= uN) break;
      vec3 p = o + d * (t0 + (float(i) + 0.5) * dt);
      float r = length(p);
      float shell = smoothstep(ri * 0.92, ri + (1.0 - ri) * 0.35, r) * (1.0 - smoothstep(0.82, 1.0, r));
      if (shell <= 0.0) continue;
      vec3 q = p * 3.2 + vec3(0.0, uTime * 0.0004, 0.0);
      float n = fbm3(q, 4);
      float fil = pow(1.0 - abs(n * 2.0 - 1.0), 5.0);   // волокна по «гребням» шума
      float dens = shell * (0.15 + 1.6 * fil) * smoothstep(0.32, 0.62, n + 0.12);
      vec3 c = mix(vec3(0.3, 0.5, 1.0), vec3(0.75, 0.32, 0.78), smoothstep(ri, 0.95, r));
      col += c * dens * dt;
    }
    gl_FragColor = vec4(col * uGain, 1.0);
    ${LOGZ_F_MAIN}
  }`;

// Кольцо верфей Ксаррона на орбите: рельсы, доки с огнями окон и мигающие маяки.
// Издалека мелочь сливается в средний тон, тень планеты ложится на кольцо
const YARDS_F = /* glsl */`
  uniform vec3 uSun, uLight; uniform float uR, uTime; uniform vec2 uRing; uniform vec3 uAxis;
  varying vec3 vRel; varying vec2 vL;
  ${LOGZ_F}
  ${NOISE_GLSL}
  void main() {
    float r = length(vL) / uR, u = (r - uRing.x) / (uRing.y - uRing.x);
    if (u < 0.0 || u > 1.0) discard;
    float s = (atan(vL.y, vL.x) / 6.2831853 + 0.5) * 320.0, fs = fract(s), is = floor(s);
    float px = fwidth(s) + fwidth(u) * 40.0;
    float hs = hash3(vec3(is, 3.1, 7.7));
    float rails = max(max(smoothstep(0.035, 0.0, abs(u - 0.1)), smoothstep(0.035, 0.0, abs(u - 0.9))), smoothstep(0.02, 0.0, abs(u - 0.5)));
    float len = 0.35 + 0.5 * hs;
    float dock = step(0.08, fs) * step(fs, 0.08 + len) * step(0.18, u) * step(u, 0.82) * step(0.2, hs);
    float a = max(rails, dock);
    // Вдали — средняя плотность конструкций
    float far = smoothstep(0.4, 1.5, px);
    a = mix(a, 0.42, far);
    if (a < 0.01) discard;
    // Окна доков и маяки на рельсах
    float wx = fract(fs * 18.0), wy = fract(u * 14.0);
    float win = dock * step(0.55, hash3(vec3(floor(fs * 18.0) + is * 31.0, floor(u * 14.0), 1.0))) * smoothstep(0.35, 0.2, abs(wx - 0.5)) * smoothstep(0.35, 0.2, abs(wy - 0.5));
    float beacon = rails * step(0.92, hs) * step(0.5, fract(uTime * 0.8 + hs * 5.0));
    vec3 metal = mix(vec3(0.16, 0.16, 0.18), vec3(0.3, 0.29, 0.3), hs);
    float along = dot(vRel, uSun), sh = 1.0;
    if (along < 0.0) sh = smoothstep(uR * 0.97, uR * 1.03, length(vRel - uSun * along));
    float lit = 0.25 + 0.75 * abs(dot(uAxis, uSun));
    vec3 col = metal * uLight * (0.03 + 1.4 * lit * sh);
    vec3 glow = vec3(1.0, 0.7, 0.4) * win * 1.6 + vec3(1.0, 0.15, 0.1) * beacon * 3.0;
    col += mix(glow, vec3(0.9, 0.6, 0.35) * 0.12, far);
    gl_FragColor = vec4(col, a);
    ${LOGZ_F_MAIN}
  }`;

const _v = new THREE.Vector3(), _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3(), _n0 = new THREE.Vector3();
const Z = new THREE.Vector3(0, 0, 1);

export class Space {
  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, 1, 10, FAR);
    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.uniforms = {
      uSun: { value: this.sunDir },
      uTime: { value: 0 },
      uStars: { value: 0 },
      uNightE: { value: 0 },   // ночь, увиденная с Земли (не из космоса)
      uLogK: { value: 1 / Math.log2(FAR + 1) },
    };
    this.earthCenter = new THREE.Vector3(0, -SPACE.earthRadius, 0);
    this.earthR = SPACE.earthRadius;
    this.mapBodyId = null;   // тело, на отдельной карте которого сейчас герой
    this.nebulaSamples = 5;

    // Небо у систем разное: у Ксаррона — другие созвездия и густая полоса Галактики.
    // С Земли звезда Ксаррона видна одной яркой голубой точкой
    this.starSets = {
      sol: this.createStars(5, 7000, 0, XARRON_ORIGIN),
      xarron: this.createStars(11, 9500, 0.45, null),
      // Между системами в Млечном Пути (и в других галактиках) — свои звёзды, гуще в полосе диска
      deep: this.createStars(17, 9000, 0.5, null),
    };
    this.stars = this.starSets.sol;
    this.createNightSky();
    this.createEarth();
    this.createBodies();
    this.createNebula();
    this.createPatch();
    this.createBlob();
  }

  // band — доля звёзд в полосе Галактики; mark — направление на звезду Ксаррона (одна яркая голубая)
  createStars(seed, N, band, mark) {
    const rnd = mulberry32(seed);
    const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), size = new Float32Array(N);
    const bn = new THREE.Vector3(0.3, 0.8, -0.52).normalize(), b1 = new THREE.Vector3(1, 0, 0).addScaledVector(bn, -bn.x).normalize(), b2 = new THREE.Vector3().crossVectors(bn, b1);
    for (let i = 0; i < N; i++) {
      if (band > 0 && rnd() < band) {   // без полосы — та же последовательность, что и раньше: небо Земли не меняется
        // Полоса: вокруг большого круга, гуще к середине
        const a = rnd() * Math.PI * 2, off = (rnd() + rnd() + rnd() - 1.5) * 0.14;
        _v.copy(b1).multiplyScalar(Math.cos(a)).addScaledVector(b2, Math.sin(a)).addScaledVector(bn, off).normalize().multiplyScalar(STAR_DIST);
      } else {
        const u = rnd() * 2 - 1, a = rnd() * Math.PI * 2, r = Math.sqrt(1 - u * u);
        _v.set(Math.cos(a) * r, u, Math.sin(a) * r).multiplyScalar(STAR_DIST);
      }
      pos[i * 3] = _v.x; pos[i * 3 + 1] = _v.y; pos[i * 3 + 2] = _v.z;
      const t = rnd();
      const c = new THREE.Color().setHSL(t < 0.3 ? 0.6 : t < 0.6 ? 0.1 : 0.0, 0.3 + rnd() * 0.3, 0.8 + rnd() * 0.2);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      size[i] = rnd() < 0.03 ? 3.5 : 1 + rnd() * 1.6;
    }
    if (mark) {
      _v.copy(mark).normalize().multiplyScalar(STAR_DIST);
      pos[0] = _v.x; pos[1] = _v.y; pos[2] = _v.z;
      col[0] = 0.55; col[1] = 0.72; col[2] = 1.0;
      size[0] = 4.2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */`
        attribute float aSize; attribute vec3 color; varying vec3 vColor;
        ${LOGZ_V}
        void main() { vColor = color; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = aSize; gl_Position = projectionMatrix * mv; ${LOGZ_V_MAIN} }`,
      fragmentShader: /* glsl */`
        uniform float uStars; varying vec3 vColor;
        ${LOGZ_F}
        void main() { float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d);
          gl_FragColor = vec4(vColor * 2.0, a * uStars); ${LOGZ_F_MAIN} }`,
      transparent: true, depthWrite: false,
    });
    const stars = new THREE.Points(geo, mat);
    stars.frustumCulled = false;
    this.scene.add(stars);
    return stars;
  }

  // Ночное небо с Земли: густая россыпь мелких звёзд по всему небу и глубокая синева над горизонтом
  // (вес uNightE — только ночью и только с Земли; из космоса небо прежнее)
  createNightSky() {
    const rnd = mulberry32(29), N = 26000;
    const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), size = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const u = rnd() * 2 - 1, a = rnd() * Math.PI * 2, r = Math.sqrt(1 - u * u);
      pos[i * 3] = Math.cos(a) * r * STAR_DIST; pos[i * 3 + 1] = u * STAR_DIST; pos[i * 3 + 2] = Math.sin(a) * r * STAR_DIST;
      // Почти все тусклые, редкие — яркие; цвет бело-голубой, изредка тёплый
      const br = Math.pow(rnd(), 4), t = rnd();
      const c = t < 0.12 ? [1, 0.86, 0.7] : t < 0.6 ? [0.82, 0.9, 1] : [0.95, 0.97, 1];
      const k = 0.3 + 1.3 * br;
      col[i * 3] = c[0] * k; col[i * 3 + 1] = c[1] * k; col[i * 3 + 2] = c[2] * k;
      size[i] = 1.1 + 1.8 * br + (rnd() < 0.008 ? 1.4 : 0);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    this.nightStars = new THREE.Points(geo, new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */`
        attribute float aSize; attribute vec3 color; varying vec3 vColor;
        ${LOGZ_V}
        void main() { vColor = color; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = aSize; gl_Position = projectionMatrix * mv; ${LOGZ_V_MAIN} }`,
      fragmentShader: /* glsl */`
        uniform float uNightE; varying vec3 vColor;
        ${LOGZ_F}
        void main() { float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.05, d);
          gl_FragColor = vec4(vColor * 1.6, a * uNightE); ${LOGZ_F_MAIN} }`,
      transparent: true, depthWrite: false,
    }));
    this.nightStars.frustumCulled = false;
    this.scene.add(this.nightStars);
    // Синева: у горизонта светлее, к зениту темнее — небо не чёрное, а глубоко-синее
    // Купол близко (10 км) и без теста глубины: на 2,6e9 м при ближней плоскости <1 м грани отсекались
    // дальней плоскостью из-за точности float32 — на небе были тёмные многоугольники.
    // Рисуется в списке непрозрачных сразу после неба галактик (-10), планеты ложатся поверх
    this.nightGlow = new THREE.Mesh(new THREE.SphereGeometry(1e4, 32, 16), new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */`
        varying vec3 vD;
        ${LOGZ_V}
        void main() { vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); ${LOGZ_V_MAIN} }`,
      fragmentShader: /* glsl */`
        uniform float uNightE; varying vec3 vD;
        ${LOGZ_F}
        void main() {
          float y = normalize(vD).y;
          vec3 c = mix(vec3(0.03, 0.05, 0.14), vec3(0.012, 0.018, 0.06), smoothstep(-0.05, 0.75, y));
          gl_FragColor = vec4(c * uNightE, 1.0); ${LOGZ_F_MAIN} }`,
      side: THREE.BackSide, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.nightGlow.renderOrder = -5;
    this.nightGlow.frustumCulled = false;
    this.scene.add(this.nightGlow);
  }

  createEarth() {
    const R = SPACE.earthRadius;
    const earthMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */`
        varying vec3 vN; varying vec3 vNv; varying vec3 vView;
        ${LOGZ_V}
        void main() { vN = normalize(position); vNv = normalMatrix * normal;
          vec4 mv = modelViewMatrix * vec4(position, 1.0); vView = mv.xyz;
          gl_Position = projectionMatrix * mv; ${LOGZ_V_MAIN} }`,
      fragmentShader: /* glsl */`
        uniform vec3 uSun;
        varying vec3 vN; varying vec3 vNv; varying vec3 vView;
        ${LOGZ_F}
        ${NOISE_GLSL}
        void main() {
          vec3 n = normalize(vN);
          float h = fbm3(n * 4.0 + vec3(3.1, 1.7, 0.4), 7);
          // Наш регион (верх шара) — всегда суша
          h += smoothstep(0.985, 0.999, n.y) * 0.25;
          float land = smoothstep(0.5, 0.52, h);
          float detail = fbm3(n * 60.0, 4);
          vec3 ocean = mix(vec3(0.01, 0.05, 0.14), vec3(0.03, 0.12, 0.25), smoothstep(0.35, 0.5, h));
          vec3 ground = mix(vec3(0.12, 0.22, 0.07), vec3(0.35, 0.3, 0.18), smoothstep(0.55, 0.7, h + detail * 0.15));
          ground = mix(ground, vec3(0.5, 0.48, 0.45), smoothstep(0.72, 0.8, h));
          float ice = smoothstep(0.85, 0.92, abs(n.z));
          vec3 col = mix(ocean, ground, land);
          col = mix(col, vec3(0.9, 0.93, 0.96), ice);
          float diff = dot(n, uSun);
          float day = smoothstep(-0.12, 0.25, diff);
          vec3 lit = col * (0.03 + 1.6 * max(diff, 0.0));
          // Огни городов на ночной стороне
          float cityLights = land * (1.0 - ice) * step(0.8, fbm3(n * 90.0, 3)) * (1.0 - day);
          lit += vec3(1.0, 0.75, 0.4) * cityLights * 0.6;
          // Атмосферная дымка к краю диска
          float rim = pow(1.0 - max(dot(normalize(vNv), normalize(-vView)), 0.0), 3.0);
          lit = mix(lit, vec3(0.35, 0.55, 1.0) * (0.15 + 0.9 * day), rim * 0.7);
          gl_FragColor = vec4(lit, 1.0);
          ${LOGZ_F_MAIN}
        }`,
    });
    this.earth = new THREE.Mesh(new THREE.SphereGeometry(R, 192, 96), earthMat);
    this.earth.position.copy(this.earthCenter);
    this.scene.add(this.earth);

    // Облака
    const cloudMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */`
        varying vec3 vN;
        ${LOGZ_V}
        void main() { vN = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); ${LOGZ_V_MAIN} }`,
      fragmentShader: /* glsl */`
        uniform vec3 uSun; uniform float uTime;
        varying vec3 vN;
        ${LOGZ_F}
        ${NOISE_GLSL}
        void main() {
          vec3 n = normalize(vN);
          float c = fbm3(n * 7.0 + vec3(uTime * 0.002, 0.0, 0.0), 6);
          c = smoothstep(0.5, 0.75, c);
          float diff = max(dot(n, uSun), 0.0);
          gl_FragColor = vec4(vec3(1.0) * (0.04 + 1.5 * diff), c * 0.85);
          ${LOGZ_F_MAIN}
        }`,
      transparent: true, depthWrite: false,
    });
    this.clouds = new THREE.Mesh(new THREE.SphereGeometry(R * 1.006, 128, 64), cloudMat);
    this.clouds.position.copy(this.earthCenter);
    this.scene.add(this.clouds);

    // Свечение атмосферы по краю
    const atmoMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */`
        varying vec3 vN; varying vec3 vNv; varying vec3 vView;
        ${LOGZ_V}
        void main() { vN = normal; vNv = normalMatrix * normal;
          vec4 mv = modelViewMatrix * vec4(position, 1.0); vView = mv.xyz;
          gl_Position = projectionMatrix * mv; ${LOGZ_V_MAIN} }`,
      fragmentShader: /* glsl */`
        uniform vec3 uSun;
        varying vec3 vN; varying vec3 vNv; varying vec3 vView;
        ${LOGZ_F}
        void main() {
          float rim = pow(max(dot(normalize(vNv), normalize(vView)), 0.0), 2.5);
          float day = smoothstep(-0.3, 0.4, dot(normalize(vN), uSun));
          gl_FragColor = vec4(vec3(0.3, 0.55, 1.0) * rim * (0.2 + 1.8 * day), rim);
          ${LOGZ_F_MAIN}
        }`,
      transparent: true, depthWrite: false, side: THREE.BackSide, blending: THREE.AdditiveBlending,
    });
    this.atmo = new THREE.Mesh(new THREE.SphereGeometry(R * 1.035, 128, 64), atmoMat);
    this.atmo.position.copy(this.earthCenter);
    this.scene.add(this.atmo);
  }

  // ---------------------------------------------------------------- Луна и планеты
  createBodies() {
    this.starBodies = [];
    this.bodies = ALL_BODIES.map((b, i) => {
      if (b.star) {
        const s = this.createStarBody(b, i);
        this.starBodies.push(s);
        return s;
      }
      const look = LOOKS[b.id], star = starOf(b.sys);
      // Свет — от звезды своей системы: тела стоят на месте, поэтому направление постоянное
      const sun = star.c.clone().sub(b.c).normalize();
      // Большое красное пятно — на стороне, обращённой к Земле, в южных широтах
      const toEarth = b.c.clone().negate().normalize();
      const spot = toEarth.addScaledVector(b.axis, -toEarth.dot(b.axis)).normalize()
        .multiplyScalar(Math.cos(0.38)).addScaledVector(b.axis, -Math.sin(0.38));
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          ...this.uniforms, uSun: { value: sun },
          uR: { value: b.r }, uAxis: { value: b.axis }, uSpot: { value: spot }, uSeed: { value: new THREE.Vector3(i * 7.3, i * 3.1, i * 5.7) },
          uColA: { value: new THREE.Vector3(...look.a) }, uColB: { value: new THREE.Vector3(...look.b) },
          uAtmo: { value: new THREE.Vector3(...(look.atmo || [0, 0, 0])) }, uDens: { value: look.dens || 0 },
          uLight: { value: new THREE.Vector3(...(star.light || [1, 1, 1])) },
          uOcean: { value: new THREE.Vector3(...(look.ocean || [0, 0, 0])) }, uCity: { value: new THREE.Vector3(...(look.city || [0, 0, 0])) },
        },
        defines: {
          KIND: look.kind, STYLE: look.style ?? -1,
          BANDS: (look.bands || 1).toFixed(2), WARP: (look.warp || 0).toFixed(2), STRETCH: (look.stretch || 0).toFixed(2),
          ...(look.mars ? { MARS: 1 } : {}),
          ...(look.lava ? { LAVA: 1 } : {}),
        },
        vertexShader: PLANET_V, fragmentShader: PLANET_F,
      });
      const seg = b.r > 100000 ? 256 : 128;
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(b.r, seg, seg / 2), mat);
      mesh.position.copy(b.c);
      this.scene.add(mesh);
      const body = { ...b, mesh, mat, ring: null, extras: [] };
      if (b.rings) body.ring = this.createRings(b, sun, look.ringC, star.light);
      if (b.yards) body.extras.push(this.createYards(b, sun, star.light));
      if (look.halo) body.extras.push(this.createHalo(b, sun, look.halo));
      return body;
    });
  }

  // Свечение атмосферы по краю (как у Земли)
  createHalo(b, sun, color) {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uLogK: this.uniforms.uLogK, uSun: { value: sun }, uC: { value: new THREE.Vector3(...color) } },
      vertexShader: /* glsl */`
        varying vec3 vN; varying vec3 vNv; varying vec3 vView;
        ${LOGZ_V}
        void main() { vN = normal; vNv = normalMatrix * normal;
          vec4 mv = modelViewMatrix * vec4(position, 1.0); vView = mv.xyz;
          gl_Position = projectionMatrix * mv; ${LOGZ_V_MAIN} }`,
      fragmentShader: /* glsl */`
        uniform vec3 uSun, uC;
        varying vec3 vN; varying vec3 vNv; varying vec3 vView;
        ${LOGZ_F}
        void main() {
          float rim = pow(max(dot(normalize(vNv), normalize(vView)), 0.0), 2.5);
          float day = smoothstep(-0.3, 0.4, dot(normalize(vN), uSun));
          gl_FragColor = vec4(uC * rim * (0.12 + 1.6 * day), rim);
          ${LOGZ_F_MAIN}
        }`,
      transparent: true, depthWrite: false, side: THREE.BackSide, blending: THREE.AdditiveBlending,
    });
    const m = new THREE.Mesh(new THREE.SphereGeometry(b.r * 1.035, 128, 64), mat);
    m.position.copy(b.c);
    this.scene.add(m);
    return m;
  }

  // Кольцо верфей в плоскости экватора
  createYards(b, sun, light) {
    const [r0, r1] = b.yards;
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uLogK: this.uniforms.uLogK, uTime: this.uniforms.uTime, uSun: { value: sun }, uLight: { value: new THREE.Vector3(...(light || [1, 1, 1])) },
        uR: { value: b.r }, uRing: { value: new THREE.Vector2(r0, r1) }, uAxis: { value: b.axis },
      },
      vertexShader: /* glsl */`
        varying vec3 vRel; varying vec2 vL;
        ${LOGZ_V}
        void main() { vRel = mat3(modelMatrix) * position; vL = position.xy;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); ${LOGZ_V_MAIN} }`,
      fragmentShader: YARDS_F,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(b.r * r0, b.r * r1, 720, 4), mat);
    ring.position.copy(b.c);
    ring.quaternion.setFromUnitVectors(Z, b.axis);
    this.scene.add(ring);
    return ring;
  }

  // Туманность-пузырь вокруг гипергиганта
  createNebula() {
    const [r0, r1] = SPACE.xarron.nebula;
    this.nebulaC = starOf('xarron').c;
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uLogK: this.uniforms.uLogK, uTime: this.uniforms.uTime, uCamL: { value: new THREE.Vector3() },
        uRad: { value: new THREE.Vector2(r0, r1) }, uGain: { value: 1.1 }, uN: { value: 5 },
      },
      vertexShader: /* glsl */`
        varying vec3 vL;
        ${LOGZ_V}
        void main() { vL = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); ${LOGZ_V_MAIN} }`,
      fragmentShader: NEBULA_F,
      transparent: true, depthWrite: false, side: THREE.BackSide, blending: THREE.AdditiveBlending,
    });
    this.nebula = new THREE.Mesh(new THREE.SphereGeometry(r1, 96, 48), mat);
    this.nebula.position.copy(this.nebulaC);
    this.nebula.frustumCulled = false;
    this.nebula.renderOrder = -1;
    this.scene.add(this.nebula);
  }

  // Качество: шагов луча в туманности меньше на слабой графике
  setQuality(i) { this.nebulaSamples = [5, 4, 3][i] ?? 4; }

  // Солнце: шар со своим шейдером (светится сам) и корона вокруг
  createStarBody(b, i) {
    const seed = new THREE.Vector3(i * 7.3 + 2.0, i * 3.1 + 5.0, i * 5.7 + 1.0);
    const S = STAR_LOOKS[b.id], v3 = (c) => ({ value: new THREE.Vector3(...c) });
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uLogK: this.uniforms.uLogK, uTime: this.uniforms.uTime, uR: { value: b.r }, uSeed: { value: seed }, uFade: { value: 0 },
        uC0: v3(S.c0), uC1: v3(S.c1), uC2: v3(S.c2), uLimbC: v3(S.limb), uGran: { value: S.gran }, uSpotK: { value: S.spot }, uGain: { value: S.gain },
      },
      vertexShader: PLANET_V, fragmentShader: SUN_F, transparent: true,
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(b.r, 256, 128), mat);
    mesh.position.copy(b.c);
    this.scene.add(mesh);
    const SPAN = S.span;
    const cmat = new THREE.ShaderMaterial({
      uniforms: {
        uLogK: this.uniforms.uLogK, uTime: this.uniforms.uTime, uSeed: { value: seed }, uFade: { value: 0 }, uSpan: { value: SPAN },
        uCorC: v3(S.corona), uPromC: v3(S.prom), uRimC: v3(S.rim),
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        ${LOGZ_V}
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); ${LOGZ_V_MAIN} }`,
      fragmentShader: CORONA_F,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    });
    const corona = new THREE.Mesh(new THREE.PlaneGeometry(2 * SPAN * b.r, 2 * SPAN * b.r), cmat);
    corona.position.copy(b.c);
    corona.frustumCulled = false;
    this.scene.add(corona);
    return { ...b, mesh, mat, ring: null, extras: [], corona };
  }

  // Кольца Сатурна: кольцо C (тусклое), плотное B, щель Кассини, A со щелью Энке;
  // тонкая структура колечек, тень планеты на кольцах. cols — свои цвета колец (тёмный и светлый)
  createRings(b, sun, cols, light) {
    const [r0, r1] = b.rings;
    const [c0, c1] = cols || [[0.60, 0.53, 0.43], [0.93, 0.87, 0.75]];
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        ...this.uniforms, uSun: { value: sun }, uR: { value: b.r }, uRing: { value: new THREE.Vector2(r0, r1) }, uAxis: { value: b.axis },
        uC0: { value: new THREE.Vector3(...c0) }, uC1: { value: new THREE.Vector3(...c1) }, uLight: { value: new THREE.Vector3(...(light || [1, 1, 1])) },
      },
      vertexShader: /* glsl */`
        varying vec3 vRel;
        ${LOGZ_V}
        void main() { vRel = mat3(modelMatrix) * position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); ${LOGZ_V_MAIN} }`,
      fragmentShader: /* glsl */`
        uniform vec3 uSun; uniform float uR; uniform vec2 uRing; uniform vec3 uAxis; uniform vec3 uC0, uC1, uLight;
        varying vec3 vRel;
        ${LOGZ_F}
        ${NOISE_GLSL}
        float n1(float x) { float i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(hash3(vec3(i, 1.3, 2.7)), hash3(vec3(i + 1.0, 1.3, 2.7)), f); }
        // Колечки частоты f: мельче пикселя — сливаются в средний тон
        float ringlet(float r, float f, float px) { return mix(n1(r * f), 0.5, smoothstep(0.3, 1.0, px * f)); }
        void main() {
          float r = length(vRel) / uR;
          if (r < uRing.x || r > uRing.y) discard;
          float px = fwidth(r);
          float a = r < 1.53 ? 0.22 : r < 1.95 ? 0.88 : r < 2.03 ? 0.04 : 0.62;
          a *= smoothstep(uRing.x, uRing.x + 0.02, r) * smoothstep(uRing.y, uRing.y - 0.02, r);
          a *= 1.0 - 0.9 * (1.0 - smoothstep(0.003, 0.006, abs(r - 2.214)));
          float fine = ringlet(r, 300.0, px) * 0.5 + ringlet(r, 1500.0, px) * 0.3 + ringlet(r, 7000.0, px) * 0.2;
          a = clamp(a * (0.45 + 1.1 * fine), 0.0, 0.95);
          vec3 col = mix(uC0, uC1, n1(r * 40.0)) * uLight;
          // Тень планеты
          float along = dot(vRel, uSun), sh = 1.0;
          if (along < 0.0) sh = smoothstep(uR * 0.97, uR * 1.03, length(vRel - uSun * along));
          float lit = 0.3 + 0.7 * abs(dot(uAxis, uSun));
          gl_FragColor = vec4(col * (0.02 + 1.5 * lit * sh), a);
          ${LOGZ_F_MAIN}
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(b.r * r0, b.r * r1, 512, 8), mat);
    ring.position.copy(b.c);
    ring.quaternion.setFromUnitVectors(Z, b.axis);
    this.scene.add(ring);
    return ring;
  }

  // Участок поверхности под камерой: сетка 128×128, гуще к центру. Вблизи шар из
  // треугольников был бы виден гранями (и герой стоял бы не на той высоте), поэтому
  // у самой поверхности тело рисуется этим участком — до горизонта с запасом
  createPatch() {
    const N = this.patchN = 128, V = (N + 1) * (N + 1);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(V * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(V * 3), 3));
    const idx = new Uint16Array(N * N * 6);
    let k = 0;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const a = j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1;
        idx[k++] = a; idx[k++] = b; idx[k++] = c;
        idx[k++] = b; idx[k++] = d; idx[k++] = c;
      }
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.patch = new THREE.Mesh(geo, this.bodies[0].mat);
    this.patch.frustumCulled = false;
    this.patch.visible = false;
    this.patchState = { body: null, n0: new THREE.Vector3(), theta: 0 };
    this.scene.add(this.patch);
  }

  buildPatch(body, n0, theta) {
    const N = this.patchN, R = body.r, T = Math.tan(theta);
    _e1.set(0, 1, 0);
    if (Math.abs(n0.y) > 0.9) _e1.set(1, 0, 0);
    _e1.cross(n0).normalize();
    _e2.crossVectors(n0, _e1);
    const pos = this.patch.geometry.attributes.position, nrm = this.patch.geometry.attributes.normal;
    const P = pos.array, Nm = nrm.array;
    const warp = (u) => (0.35 * u + 0.65 * u * Math.abs(u)) * T;
    let k = 0;
    for (let j = 0; j <= N; j++) {
      const v = warp(j / N * 2 - 1);
      for (let i = 0; i <= N; i++) {
        const u = warp(i / N * 2 - 1);
        const dx = n0.x + _e1.x * u + _e2.x * v, dy = n0.y + _e1.y * u + _e2.y * v, dz = n0.z + _e1.z * u + _e2.z * v;
        const l = 1 / Math.hypot(dx, dy, dz);
        const nx = dx * l, ny = dy * l, nz = dz * l;
        Nm[k] = nx; Nm[k + 1] = ny; Nm[k + 2] = nz;
        // Вершины — относительно точки поверхности под камерой: числа маленькие, float32 хватает
        P[k] = (nx - n0.x) * R; P[k + 1] = (ny - n0.y) * R; P[k + 2] = (nz - n0.z) * R;
        k += 3;
      }
    }
    pos.needsUpdate = true; nrm.needsUpdate = true;
    this.patch.position.copy(body.c).addScaledVector(n0, R);
    this.patch.material = body.mat;
    const st = this.patchState;
    st.body = body; st.n0.copy(n0); st.theta = theta;
  }

  updatePatch(camPos) {
    const { body: b, alt } = nearestBody(camPos);
    const body = b && this.bodies.find((x) => x.id === b.id);
    const st = this.patchState;
    if (!body || !body.mesh.visible || alt > body.r * 0.3) { this.patch.visible = false; st.body = null; return; }
    const R = body.r;
    // Угол от точки под камерой до горизонта — участок берём шире, с запасом на перемещение
    const want = Math.min(1.2, Math.acos(R / (R + Math.max(alt, 0.5))) * 1.35 + 60 / R);
    _n0.subVectors(camPos, body.c).normalize();
    if (st.body !== body || want > st.theta || want < st.theta * 0.5 || _n0.angleTo(st.n0) > st.theta * 0.15) {
      this.buildPatch(body, _n0, Math.min(1.25, want * 1.25));
    }
    this.patch.visible = true;
    body.mesh.visible = false;   // участок закрывает всю видимую часть шара
  }

  // Мягкая тень героя под ногами на Луне и планетах (основная сцена своих теней сюда не отбрасывает)
  createBlob() {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uLogK: this.uniforms.uLogK, uA: { value: 0 } },
      vertexShader: /* glsl */`
        varying vec2 vP;
        ${LOGZ_V}
        void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); ${LOGZ_V_MAIN} }`,
      fragmentShader: /* glsl */`
        uniform float uA; varying vec2 vP;
        ${LOGZ_F}
        void main() { gl_FragColor = vec4(0.0, 0.0, 0.0, uA * smoothstep(1.0, 0.15, length(vP))); ${LOGZ_F_MAIN} }`,
      transparent: true, depthWrite: false,
    });
    this.blob = new THREE.Mesh(new THREE.CircleGeometry(1, 32), mat);
    this.blob.visible = false;
    this.scene.add(this.blob);
  }

  updateBlob(hero) {
    const b = hero?.nearBody;
    this.blob.visible = false;
    if (!b) return;
    _v.subVectors(hero.pos, b.c);
    const l = _v.length(), alt = l - b.r;
    if (alt > 10 || alt < -1) return;
    _v.divideScalar(l);
    this.blob.position.copy(b.c).addScaledVector(_v, b.r + 0.05);
    this.blob.quaternion.setFromUnitVectors(Z, _v);
    this.blob.scale.setScalar(0.75 + Math.max(0, alt) * 0.12);
    this.blob.material.uniforms.uA.value = 0.5 * (1 - Math.max(0, alt) / 10);
    this.blob.visible = true;
  }

  // На карте Луны Земля стоит в небе; null — вернуть на место
  moveEarth(p) {
    const c = p || this.earthCenter;
    this.earth.position.copy(c);
    this.clouds.position.copy(c);
    this.atmo.position.copy(c);
  }

  // Ближайшее расстояние от точки до поверхности Земли, Луны или планеты
  surfaceDistance(p) {
    return Math.min(p.distanceTo(this.earthCenter) - SPACE.earthRadius, nearestBody(p).alt);
  }

  update(dt, mainCamera, sunDir, spaceK, nightK, hero) {
    this.uniforms.uTime.value += dt;
    this.sunDir.copy(sunDir);
    // Звёзды: в космосе и ночью
    this.uniforms.uStars.value = Math.max(spaceK, nightK * 0.9);
    // Рисуется только система, где сейчас герой: вторая всё равно дальше дальней плоскости
    const sys = REGION, home = sys === 'sol';
    for (const id in this.starSets) this.starSets[id].visible = id === sys;
    this.stars = this.starSets[sys];
    this.stars.position.copy(mainCamera.position);
    // Ночное небо Земли: только снизу, с самой Земли (не с карт планет и не из космоса)
    this.uniforms.uNightE.value = home && !this.mapBodyId ? nightK * (1 - spaceK) : 0;
    this.nightStars.visible = this.nightGlow.visible = this.uniforms.uNightE.value > 0.002;
    this.nightStars.position.copy(mainCamera.position);
    this.nightGlow.position.copy(mainCamera.position);
    // Земля-шар нужна только высоко (внизу её закрывает рельеф); Луна и планеты — ещё и ночью
    const high = mainCamera.position.y > 6000;
    this.earth.visible = this.clouds.visible = this.atmo.visible = high && home;
    const bodiesOn = high || nightK > 0.5;
    // На отдельной карте планеты её шара нет: под ногами — рельеф основной сцены
    // Солнце — только с высоты (внизу светит небесное солнце времени суток)
    const sunFade = Math.max(spaceK, 0);
    for (const b of this.bodies) {
      const mine = b.sys === sys;
      b.mesh.visible = mine && (b.star ? sunFade > 0.01 : bodiesOn) && b.id !== this.mapBodyId;
      if (b.ring) b.ring.visible = mine && bodiesOn;
      for (const e of b.extras) e.visible = mine && bodiesOn && b.id !== this.mapBodyId;
    }
    for (const s of this.starBodies) {
      s.mat.uniforms.uFade.value = sunFade;
      s.corona.material.uniforms.uFade.value = sunFade;
      s.corona.visible = s.sys === sys && sunFade > 0.01 && this.mapBodyId !== s.id;
      s.corona.quaternion.copy(mainCamera.quaternion);
    }
    // Туманность: луч считается от камеры в системе звезды (в double на CPU — без дрожи)
    this.nebula.visible = sys === 'xarron' && !this.mapBodyId;
    if (this.nebula.visible) {
      const U = this.nebula.material.uniforms;
      U.uCamL.value.subVectors(mainCamera.position, this.nebulaC);
      U.uN.value = this.nebulaSamples;
    }
    if (this.mapBodyId) {
      this.patch.visible = this.blob.visible = false;
      this.patchState.body = null;
    } else {
      this.updatePatch(mainCamera.position);
      this.updateBlob(hero);
    }

    const cam = this.camera;
    cam.position.copy(mainCamera.position);
    cam.quaternion.copy(mainCamera.quaternion);
    cam.fov = mainCamera.fov;
    cam.aspect = mainCamera.aspect;
    // Глубина логарифмическая — ближнюю плоскость можно держать маленькой
    cam.near = Math.min(5000, Math.max(0.25, this.surfaceDistance(cam.position) * 0.4));
    cam.far = FAR;
    cam.updateProjectionMatrix();
  }
}
