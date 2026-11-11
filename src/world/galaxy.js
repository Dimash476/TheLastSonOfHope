import * as THREE from 'three';
import { SPACE, PLAYER as P } from '../config.js';
import { REGION, REGIONS, setRegion, XARRON_ORIGIN, DEEP_ORIGIN, DEEP_LIGHT } from './bodies.js';
import { NOISE_GLSL } from './space.js';

// Галактики: Млечный Путь (наша — в ней обе системы) и группа соседних. Каждая — объём (диск с рукавами,
// ядро, пыль, области звездообразования; эллиптическая, неправильная, кольцо), шейдер идёт сквозь него лучом.
// Поэтому изнутри Млечный Путь сам собой встаёт полосой через всё небо, а снаружи виден целиком.
// Небо считается в кубическую текстуру: в системах — один раз (по кусочку за кадр, чтобы не было рывка),
// в межгалактическом полёте — непрерывно, грубее; новое небо проявляется поверх старого.
// В системе — две текстуры: сам Млечный Путь и отдельно соседи за ним (они видны только из космоса: с Земли
// на небе одна полоса). Туманности и звёздные скопления рисуются поверх неба по пикселям, тоже только из космоса.
// Свои координаты: метры, центр Млечного Пути в нуле, оси — как у мира. Межгалактика — регион 'deep':
// герой стоит у DEEP_ORIGIN («беговая дорожка»), а base — где эта точка в галактиках.
// В межгалактике за группой видна космическая паутина: нити и узлы из бесчисленных далёких галактик
// (синие, бирюзовые, зелёные — чем дальше слой, тем мельче ячейки). Она бесконечно далеко, поэтому считается
// один раз в свою кубическую текстуру, а россыпь галактик-точек вдоль нитей дорисовывает показ, по пикселям.
// Подписаны только Млечный Путь и его системы; остальные галактики группы — без имён

const G = SPACE.galaxy;

// Ещё галактики группы — без имён: раскиданы случайно, но всегда одинаково, друг на друга не налезают
function extraGalaxies(E, list) {
  let s = E.seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const unit = () => { const z = rnd() * 2 - 1, ph = rnd() * Math.PI * 2, q = Math.sqrt(1 - z * z); return [q * Math.cos(ph), z, q * Math.sin(ph)]; };
  const placed = list.map((g) => ({ c: new THREE.Vector3(...g.dir).normalize().multiplyScalar(g.dist || 0), r: g.r }));
  const TYPES = [0, 0, 0, 0, 0, 1, 1, 1, 2, 2, 3];
  const TINTS = [[1, 1, 1], [0.86, 0.95, 1.18], [1.12, 0.97, 0.82], [0.74, 0.9, 1.32], [1.18, 0.92, 0.72], [0.92, 1.0, 1.05]];
  const out = [];
  for (let i = 0; out.length < E.count && i < E.count * 40; i++) {
    const dir = unit(), dist = E.dist[0] + (E.dist[1] - E.dist[0]) * Math.sqrt(rnd());
    const type = TYPES[Math.floor(rnd() * TYPES.length)];
    const r = (E.r[0] + (E.r[1] - E.r[0]) * rnd() ** 1.6) * (type === 2 ? 0.45 : type === 3 ? 0.7 : 1);
    const c = new THREE.Vector3(...dir).multiplyScalar(dist);
    if (placed.some((o) => o.c.distanceTo(c) < (o.r + r) * 1.8)) continue;
    placed.push({ c, r });
    out.push({
      id: `g${out.length + 1}`, type, dir, dist, r, normal: unit(),
      arms: type === 0 ? 2 + Math.floor(rnd() * 3) : 0, pitch: type === 0 ? 0.24 + 0.2 * rnd() : 0,
      seed: 1 + 9 * rnd(), tint: TINTS[Math.floor(rnd() * TINTS.length)],
      bright: type === 1 ? 0.45 + 0.25 * rnd() : type === 2 ? 0.4 + 0.2 * rnd() : 0.75 + 0.5 * rnd(),
    });
  }
  return out;
}
const LIST = [...G.list, ...extraGalaxies(G.extra, G.list)];
const NG = LIST.length, NN = G.nebulae.length, NC = G.clusters.length;
const MAXS = 128;
const OUT_GAIN = 3;   // во сколько раз (+1) ярче галактика, когда смотришь на неё снаружи
const DEG = Math.PI / 180;

const SKY_F = /* glsl */`
  uniform vec4 uGP[${NG}];   // xyz — камера в осях галактики, в её радиусах; w — тип (-1 — не считать)
  uniform mat3 uGM[${NG}];   // мир → оси галактики
  uniform vec4 uGA[${NG}];   // рукава, закрутка, зерно, яркость
  uniform vec3 uGT[${NG}];   // оттенок
  uniform int uSteps, uLayer;   // слой: 0 — только Млечный Путь, 1 — соседи за ним, 2 — всё вместе (межгалактика)
  uniform float uField, uIn;   // uIn — насколько камера внутри Млечного Пути
  uniform vec3 uMWN;            // ось диска Млечного Пути
  varying vec3 vDir;
  ${NOISE_GLSL}

  vec2 sph(vec3 o, vec3 d, float R) {
    float b = dot(o, d), c = dot(o, o) - R * R, h = b * b - c;
    if (h < 0.0) return vec2(1.0, -1.0);
    h = sqrt(h);
    return vec2(-b - h, -b + h);
  }

  const vec3 OLD = vec3(1.0, 0.64, 0.34), YOUNG = vec3(0.5, 0.7, 1.25), HII = vec3(1.35, 0.22, 0.38);

  // Плотность света (em) и пыли (ab) в точке p (в радиусах галактики)
  void dens(float type, vec3 p, vec4 A, inout vec3 em, inout float ab) {
    float r = length(p.xy);
    if (type == 1.0) {
      // Эллиптическая: старые звёзды, яркое ядро, плавный спад (без пыли)
      float q = length(p * vec3(1.0, 1.35, 1.7));
      em += OLD * (exp(-pow(q, 0.33) * 6.5) * 9.0 + exp(-q * q * 2.2) * 0.25);
      return;
    }
    if (type == 2.0) {
      // Неправильная: клочья молодых звёзд и розовые области звездообразования
      float n = fbm3(p * 2.6 + A.z, 3);
      float k = smoothstep(1.0, 0.2, length(p * vec3(1.0, 1.0, 1.6))) * max(0.0, n - 0.32) * 3.0;
      em += YOUNG * k * 0.9 + HII * k * smoothstep(0.5, 0.75, noise3(p * 7.0 - A.z)) * 2.0;
      ab += k * 3.0 * smoothstep(0.45, 0.6, noise3(p * 4.0 + 9.0));
      return;
    }
    float th = atan(p.y, p.x);
    float n = noise3(p * 7.0 + A.z);
    if (type == 3.0) {
      // Кольцо: маленькое тёплое ядро и голубое кольцо в узлах звездообразования
      float ring = exp(-pow((r - 0.72) / 0.11, 2.0)) * exp(-abs(p.z) / 0.03);
      float knots = 0.45 + 0.9 * noise3(vec3(cos(th) * 4.0, sin(th) * 4.0, r * 6.0) + A.z);
      em += YOUNG * ring * knots * 2.2 + HII * ring * smoothstep(0.62, 0.85, knots) * 2.5;
      em += OLD * exp(-(r * r + p.z * p.z * 3.0) / 0.006) * 4.0;
      ab += ring * smoothstep(0.5, 0.7, noise3(p * 9.0)) * 25.0;
      return;
    }
    // Спираль: логарифмические рукава из молодых звёзд, старый диск, перемычка и балдж,
    // тонкий слой пыли клочьями — гуще по внутреннему краю рукавов
    float ph = A.x * (th - log(max(r, 0.02)) / tan(A.y)) + A.z;
    float arm = 0.5 + 0.5 * cos(ph);
    float armK = arm * arm * arm;
    float edge = smoothstep(1.15, 0.7, r);
    // Звёздные облака: диск не гладкий, а клочьями (изнутри полоса Млечного Пути зернистая, как на снимках)
    float cl = fbm3(p * 16.0 + A.z, 4);
    float clump = 0.15 + 3.0 * cl * cl;
    float az = abs(p.z);
    float old = exp(-r / 0.3 - az / (0.022 * (1.0 + r))) * edge;
    float young = exp(-r / 0.42 - az / (0.011 * (1.0 + r))) * edge * (0.1 + armK);
    // Перемычка (повёрнута к рукавам) и балдж: тёплое сердце
    vec2 bq = vec2(0.9 * p.x + 0.43 * p.y, -0.43 * p.x + 0.9 * p.y);
    float bar = exp(-(bq.x * bq.x / 0.012 + bq.y * bq.y / 0.0035 + p.z * p.z / 0.0022));
    float bul = exp(-length(vec3(p.xy, p.z * 1.6)) / 0.065);
    em += OLD * (old * 1.4 * clump + (bar * 2.2 + bul * 4.2) * (0.55 + 0.9 * cl)) + YOUNG * young * 2.6 * clump;
    // Области звездообразования — розовые узлы на рукавах
    em += HII * smoothstep(0.72, 0.88, noise3(p * 26.0 - A.z)) * armK * young * 4.0;
    float darm = pow(0.5 + 0.5 * cos(ph + 0.5), 2.0);
    float dn = fbm3(p * 18.0 - A.z * 2.3, 5);
    ab += exp(-r / 0.45 - az / (0.0065 * (1.0 + r))) * (0.2 + 1.8 * darm) * smoothstep(0.36, 0.66, dn) * smoothstep(0.02, 0.12, r) * 110.0 * (0.4 + n);
  }

  // Луч сквозь галактику i: свет и сколько пропущено того, что за ней
  vec4 galaxy(int i, vec3 rd, float jit, out float tin) {
    vec4 Pp = uGP[i];
    tin = 1e9;
    if (Pp.w < 0.0) return vec4(0.0, 0.0, 0.0, 1.0);
    float type = Pp.w;
    vec3 o = Pp.xyz, d = uGM[i] * rd;
    vec2 h = sph(o, d, type == 1.0 || type == 2.0 ? 1.05 : 1.25);
    if (type == 0.0 || type == 3.0) {
      // Диск: ещё и слой ±Z
      const float Z = 0.2;
      if (abs(d.z) > 1e-5) {
        float a = (-Z - o.z) / d.z, b = (Z - o.z) / d.z;
        h.x = max(h.x, min(a, b)); h.y = min(h.y, max(a, b));
      } else if (abs(o.z) > Z) h = vec2(1.0, -1.0);
    }
    if (h.y <= max(h.x, 0.0)) return vec4(0.0, 0.0, 0.0, 1.0);
    bool inside = h.x < 0.0;
    float t0 = max(h.x, 0.0), L = h.y - t0;
    tin = t0;
    vec3 col = vec3(0.0); float T = 1.0;
    float fN = float(uSteps);
    for (int k = 0; k < ${MAXS}; k++) {
      if (k >= uSteps) break;
      // Изнутри шаги гуще у камеры: ближняя пыль и облака крупные на небе
      float a = (float(k) + jit) / fN;
      float s = inside ? a * a : a;
      float dl = L * (inside ? 2.0 * a : 1.0) / fN;
      vec3 p = o + d * (t0 + L * s);
      vec3 em = vec3(0.0); float ab = 0.0;
      dens(type, p, uGA[i], em, ab);
      // Ближние звёзды не сливаются в свечение — на небе они отдельными точками; светится далёкая толща диска
      float near = inside ? smoothstep(0.012, 0.07, t0 + L * s) : 1.0;
      col += T * em * near * dl;
      T *= exp(-ab * dl);
      if (T < 0.01) break;
    }
    return vec4(col * uGT[i] * uGA[i].w, T);
  }

  // Изнутри полоса — как на снимках неба: яркие звёздные облака и рваные тёмные провалы пыли (гуще у середины полосы,
  // бурые по краям). Рисунок на небе, а не в объёме: так он чёткий, а снаружи галактики его нет
  vec3 skyMod(vec3 rd, vec3 c) {
    float b = dot(rd, uMWN);
    float clouds = 0.4 + 1.5 * smoothstep(0.38, 0.78, fbm3(rd * 7.0 + 1.3, 5));
    float dn = fbm3(rd * 10.0 + 7.7, 6);
    float fil = 1.0 - abs(noise3(rd * 15.0 + 3.1) * 2.0 - 1.0);
    float dark = smoothstep(0.46, 0.68, dn) * 0.9 + pow(fil, 9.0) * 0.55;
    float k = clamp(dark * (0.3 + 0.7 * exp(-b * b / 0.0045)), 0.0, 0.93);
    vec3 o = c * mix(1.0, clouds, 0.85) * (1.0 - k) * mix(vec3(1.0), vec3(1.0, 0.72, 0.5), k);
    return mix(c, o, uIn);
  }

  // Полоса — из бесчисленных звёзд: мягкое зерно по текселям (чёткие звёзды в ней дорисовывает показ, по пикселям экрана)
  vec3 grain(vec3 rd, vec3 c) {
    return c * (0.7 + 0.6 * hash3(floor(rd * 1500.0) + 0.37));
  }

  // Далёкие галактики: крошечные овалы, редкие и тусклые, собраны в скопления
  vec3 field(vec3 rd) {
    vec3 q = rd * 42.0, c = floor(q);
    float hc = hash3(c + 7.1);
    float clu = smoothstep(0.55, 0.8, noise3(rd * 5.0 + 3.3));
    if (hc < 0.97 - 0.2 * clu) return vec3(0.0);
    vec3 ctr = c + 0.5 + (vec3(hash3(c + 1.3), hash3(c + 2.7), hash3(c + 4.1)) - 0.5) * 0.5;
    vec3 v = q - ctr;
    vec3 ax = normalize(vec3(hash3(c + 5.0), hash3(c + 6.0), hash3(c + 8.0)) - 0.5);
    float al = dot(v, ax);
    vec3 pp = v - ax * al;
    float sz = 0.05 + 0.08 * hash3(c + 9.0);
    float e = exp(-(dot(pp, pp) * 4.0 + al * al) / (sz * sz));
    vec3 tint = mix(vec3(1.0, 0.8, 0.6), vec3(0.7, 0.85, 1.2), hash3(c + 3.3));
    return tint * e * 0.08;
  }

  void main() {
    vec3 rd = normalize(vDir);
    float jit = hash3(rd * 917.3 + 0.5);
    float t0mw, ti;
    vec4 mw = galaxy(0, rd, jit, t0mw);
    vec3 mwc = grain(rd, skyMod(rd, mw.rgb));
    if (uLayer == 0) { gl_FragColor = vec4(mwc, 1.0); return; }
    // Остальные галактики — перед Млечным Путём и за ним (изнутри все за ним — видны сквозь его пыль)
    vec3 front = vec3(0.0), back = field(rd) * uField;
    float Tf = 1.0;
    for (int i = 1; i < ${NG}; i++) {
      vec4 g = galaxy(i, rd, jit, ti);
      if (ti < t0mw) { front += Tf * g.rgb; Tf *= g.a; }
      else back = g.rgb + g.a * back;
    }
    vec3 col = uLayer == 1 ? front + Tf * mw.a * back : front + Tf * (mwc + mw.a * back);
    gl_FragColor = vec4(col, 1.0);
  }`;

// Космическая паутина: три слоя на разных расстояниях. Слой — ячейки Вороного (пустоты): их стенки на небе —
// нити, места, где сходятся три пустоты, — узлы (скопления галактик). Ближний слой синий и крупный,
// средний бирюзовый, дальний зелёный и мелкий. rgb — свечение, a — густота галактик (для россыпи при показе)
const WEB_F = /* glsl */`
  varying vec3 vDir;
  ${NOISE_GLSL}

  // Расстояния до трёх ближайших центров ячеек
  vec3 worley(vec3 p) {
    vec3 c = floor(p), f = p - c;
    float d1 = 9.0, d2 = 9.0, d3 = 9.0;
    for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) for (int z = -1; z <= 1; z++) {
      vec3 o = vec3(float(x), float(y), float(z)), q = c + o;
      vec3 r = o + vec3(hash3(q + 0.37), hash3(q + vec3(17.13, 3.71, 9.37)), hash3(q + vec3(5.91, 31.7, 13.3))) - f;
      float d = dot(r, r);
      if (d < d1) { d3 = d2; d2 = d1; d1 = d; }
      else if (d < d2) { d3 = d2; d2 = d; }
      else if (d < d3) d3 = d;
    }
    return sqrt(vec3(d1, d2, d3));
  }

  float layer(vec3 rd, float S, float seed, float w) {
    vec3 p = rd * S + seed;
    // Нити не прямые: пространство чуть закручено шумом
    p += 0.6 * (vec3(noise3(p * 1.3 + seed), noise3(p * 1.3 + seed + 4.3), noise3(p * 1.3 + seed + 8.9)) - 0.5);
    vec3 F = worley(p);
    float wall = F.y - F.x, node = F.z - F.x;
    float fil = exp(-wall * wall / (w * w));
    float knot = exp(-node * node / (w * w * 3.0));
    // Вдоль нитей галактики собраны клочьями, в узлах — гуще всего
    float clump = 0.14 + 1.3 * smoothstep(0.3, 0.85, fbm3(p * 3.5 - seed, 3));
    return fil * clump + knot * (0.6 + 1.6 * clump);
  }

  void main() {
    vec3 rd = normalize(vDir);
    float a = layer(rd, 2.3, 3.7, 0.065);
    float b = layer(rd, 4.1, 9.1, 0.06);
    float c = layer(rd, 7.2, 15.3, 0.055);
    vec3 col = vec3(0.3, 0.46, 1.3) * a + vec3(0.1, 0.92, 0.88) * b * 0.8 + vec3(0.36, 1.0, 0.42) * c * 0.55;
    // Пустота не чёрная: голубая дымка клочьями, к ярким местам светлее, поперёк — бурые волокна пыли
    float cloud = smoothstep(0.42, 0.78, fbm3(rd * 2.2 + 11.3, 6));
    float glow = smoothstep(0.58, 0.85, fbm3(rd * 4.5 + 2.1, 5));
    vec3 haze = vec3(0.2, 0.36, 1.0) * cloud * (0.7 + 1.8 * glow) + vec3(0.6, 0.75, 1.1) * cloud * glow * glow;
    float dust = smoothstep(0.5, 0.68, fbm3(rd * 5.0 + 23.0, 6)) * cloud;
    haze = haze * (1.0 - 0.75 * dust) + vec3(0.36, 0.19, 0.09) * dust * 0.6;
    gl_FragColor = vec4(col + haze * 3.6, a + b * 0.85 + c * 0.7);
  }`;

// Показ неба: две кубические текстуры (старая и новая проявляется поверх), к каждой — соседи из космоса (uDK*),
// а поверх — туманности и звёздные скопления, по пикселям экрана (чёткие), тоже только из космоса (uDeco)
const SHOW_F = /* glsl */`
  uniform samplerCube uA, uB, uDA, uDB;
  uniform float uMix, uK, uDKA, uDKB, uDeco, uPix, uIn;
  uniform float uE;            // ночь с Земли: полоса ярче и бело-голубая, как на ночных снимках
  uniform samplerCube uWeb;    // космическая паутина (только в межгалактике, вес uWebK)
  uniform float uWebK;
  uniform vec4 uND[${NN}];   // туманность: направление; w — тангенс углового радиуса (0 — не рисовать)
  uniform mat3 uNM[${NN}];   // её оси на небе
  uniform vec4 uNA[${NN}];   // тип, зерно, яркость, пыль
  uniform vec3 uNC1[${NN}], uNC2[${NN}];
  uniform vec4 uCD[${NC}];   // скопление: направление; w — тангенс углового радиуса (0 — не рисовать)
  uniform mat3 uCM[${NC}];
  uniform vec4 uCA[${NC}];   // тип, зерно, яркость
  uniform int uNSteps;
  varying vec3 vDir;
  ${NOISE_GLSL}

  // Туманность: луч сквозь шар, видимый под своим угловым радиусом
  vec4 nebula(int j, vec3 rd, float jit) {
    vec4 D = uND[j];
    if (D.w <= 0.0) return vec4(0.0, 0.0, 0.0, 1.0);
    vec3 l = uNM[j] * rd;
    if (l.z <= 0.0) return vec4(0.0, 0.0, 0.0, 1.0);
    vec2 uv = l.xy / (l.z * D.w);
    float q = dot(uv, uv);
    if (q >= 1.0) return vec4(0.0, 0.0, 0.0, 1.0);
    vec4 A = uNA[j];
    float hz = sqrt(1.0 - q), dl = 2.0 * hz / float(uNSteps);
    vec3 col = vec3(0.0); float T = 1.0;
    for (int k = 0; k < 40; k++) {
      if (k >= uNSteps) break;
      vec3 p = vec3(uv, -hz + (float(k) + jit) * dl);
      float r = length(p);
      vec3 em; float ab = 0.0;
      if (A.x < 0.5) {
        // Светящийся газ: клочья красного водорода, к сердцу — бирюза, поперёк — тёмные волокна пыли
        // Края рваные: форма закручена шумом, а не шар
        vec3 w = p + 0.6 * (vec3(noise3(p * 1.3 + A.y), noise3(p * 1.3 + A.y + 5.2), noise3(p * 1.3 + A.y + 9.7)) - 0.5);
        float rw = length(w);
        float shell = pow(smoothstep(1.05, 0.0, rw), 1.4);
        float gas = smoothstep(0.36, 0.85, fbm3(w * 1.8 + A.y, 5)) * shell;
        float m = smoothstep(0.35, 0.8, noise3(w * 2.2 - A.y));
        em = uNC1[j] * pow(gas, 1.4) * 4.0 + mix(uNC1[j], vec3(1.25, 0.55, 0.75), m) * gas * 0.6
           + uNC2[j] * gas * exp(-rw * rw * 8.0) * 2.0;
        float fil = 1.0 - abs(noise3(w * 2.8 + A.y * 2.0) * 2.0 - 1.0);
        ab = pow(fil, 12.0) * shell * A.w * 7.0;
      } else if (A.x < 1.5) {
        // Планетарная: бирюзовое кольцо с красной каймой
        float sh = exp(-pow((r - 0.62) / 0.14, 2.0)) * (0.75 + 0.5 * noise3(p * 6.0 + A.y));
        em = mix(uNC1[j], uNC2[j], smoothstep(0.52, 0.8, r)) * sh * 6.0 + uNC1[j] * smoothstep(0.62, 0.0, r) * 0.8;
      } else {
        // Отражательная: голубая волокнистая дымка
        float f = fbm3(p * 2.6 + A.y, 5);
        float w = max(0.0, f - 0.36) * 2.6 * smoothstep(1.0, 0.1, r);
        em = mix(uNC1[j], uNC2[j], f) * w * w * 4.0;
      }
      col += T * em * dl;
      T *= exp(-ab * dl);
    }
    return vec4(col * A.z, T);
  }

  // Звезда в ячейке решётки (cs — размер ячейки в радиусах скопления)
  vec3 cellStar(vec2 uv, vec2 ci, float cs, float seed, float prob, float px, float big, vec3 c1, vec3 c2) {
    if (hash3(vec3(ci, seed)) >= prob) return vec3(0.0);
    vec2 sp = (ci + 0.2 + 0.6 * vec2(hash3(vec3(ci, seed + 1.3)), hash3(vec3(ci, seed + 2.7)))) * cs;
    float b = pow(hash3(vec3(ci, seed + 4.1)), 3.0);
    float s = px * (0.75 + big * b);
    vec2 d = uv - sp;
    return mix(c1, c2, hash3(vec3(ci, seed + 6.6))) * exp(-dot(d, d) / (2.0 * s * s)) * (0.8 + 4.0 * big * b);
  }

  // Скопление: шаровое — плотный тёплый шар, к краю рассыпается на звёзды; рассеянное — горсть ярких голубых звёзд
  vec3 cluster(int j, vec3 rd) {
    vec4 D = uCD[j];
    if (D.w <= 0.0) return vec3(0.0);
    vec3 l = uCM[j] * rd;
    if (l.z <= 0.0) return vec3(0.0);
    vec2 uv = l.xy / (l.z * D.w);
    float rr = length(uv);
    if (rr > 1.6) return vec3(0.0);
    vec4 A = uCA[j];
    float px = uPix / D.w;
    vec3 c = vec3(0.0);
    if (A.x < 0.5) {
      c += vec3(1.0, 0.86, 0.66) * max(0.0, 1.0 / (1.0 + rr * rr / 0.02) - 0.03) * 0.45;
      float cs = max(px * 2.4, 0.03);
      float prob = clamp(1.3 / (1.0 + rr * rr / 0.15) - 0.12, 0.0, 0.9);
      vec2 ci = floor(uv / cs);
      for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++)
        c += cellStar(uv, ci + vec2(x, y), cs, A.y, prob, px, 0.6, vec3(1.0, 0.9, 0.75), vec3(1.0, 0.78, 0.55)) * 0.5;
    } else {
      float cs = 0.2;
      vec2 ci = floor(uv / cs);
      for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) {
        vec2 cc = ci + vec2(x, y);
        float prob = 0.5 * smoothstep(1.25, 0.15, length((cc + 0.5) * cs));
        c += cellStar(uv, cc, cs, A.y, prob, px, 1.6, vec3(0.72, 0.84, 1.15), vec3(1.0, 0.95, 0.88));
      }
    }
    return c * A.z;
  }

  // Полоса из звёзд: чем ярче в этом месте свечение, тем гуще россыпь — по пикселям экрана, поэтому чётко
  vec3 bandStars(vec3 d, float L) {
    vec3 o = vec3(0.0);
    // Только изнутри галактики: снаружи она — свечение рукавов, а не россыпь
    float k = smoothstep(0.025, 0.22, L) * uIn;
    if (k < 0.01) return o;
    for (int i = 0; i < 2; i++) {
      float N = i == 0 ? 260.0 : 600.0;
      vec3 ci = floor(d * N);
      if (hash3(ci + 11.3 + float(i) * 7.0) > k * (i == 0 ? 0.4 : 0.55)) continue;
      vec3 sd = normalize(ci + 0.25 + 0.5 * vec3(hash3(ci + 1.7), hash3(ci + 2.9), hash3(ci + 4.3)));
      float a = length(d - sd), s = uPix * 0.65;
      float br = (i == 0 ? 1.1 : 0.5) * (0.35 + 1.8 * pow(hash3(ci + 6.1), 2.0)) * (0.25 + L * 2.5);
      o += mix(vec3(1.0, 0.8, 0.58), vec3(0.74, 0.86, 1.12), hash3(ci + 8.2)) * br * exp(-a * a / (2.0 * s * s));
    }
    return o;
  }

  // Паутина: мягкое свечение нитей и россыпь галактик-точек вдоль них (чем гуще нить, тем больше точек)
  vec3 web(vec3 d) {
    vec4 w = textureCube(uWeb, d);
    vec3 o = w.rgb * 0.045;
    vec3 hue = w.rgb / max(1e-3, max(w.r, max(w.g, w.b)));
    for (int i = 0; i < 2; i++) {
      float N = i == 0 ? 330.0 : 760.0;
      vec3 ci = floor(d * N);
      if (hash3(ci + 21.7 + float(i) * 5.3) > clamp(w.a * (i == 0 ? 0.18 : 0.32) - 0.025, 0.0, 0.85)) continue;
      vec3 sd = normalize(ci + 0.25 + 0.5 * vec3(hash3(ci + 3.1), hash3(ci + 5.3), hash3(ci + 7.9)));
      float a = length(d - sd), s = uPix * (i == 0 ? 0.85 : 0.6);
      float br = (i == 0 ? 0.65 : 0.34) * (0.3 + 1.6 * pow(hash3(ci + 9.4), 3.0));
      o += mix(hue, vec3(0.78, 0.9, 1.05), 0.3 * hash3(ci + 2.2)) * br * exp(-a * a / (2.0 * s * s));
    }
    // Россыпь звёзд по всему небу: мелкие и редкие яркие с ореолом, бело-голубые и тёплые
    for (int i = 0; i < 2; i++) {
      float N = i == 0 ? 200.0 : 520.0;
      vec3 ci = floor(d * N);
      if (hash3(ci + 41.3 + float(i) * 3.7) > (i == 0 ? 0.09 : 0.2)) continue;
      vec3 sd = normalize(ci + 0.25 + 0.5 * vec3(hash3(ci + 1.9), hash3(ci + 4.7), hash3(ci + 6.3)));
      float a = length(d - sd), s = uPix * 0.7;
      float b = pow(hash3(ci + 8.8), 4.0);
      float br = (i == 0 ? 0.9 : 0.4) * (0.35 + 2.2 * b);
      vec3 tint = mix(vec3(0.8, 0.9, 1.15), vec3(1.0, 0.82, 0.6), step(0.8, hash3(ci + 3.4)));
      o += tint * br * (exp(-a * a / (2.0 * s * s)) + b * 0.12 * exp(-a / (s * 5.0)));
    }
    return o;
  }

  void main() {
    vec3 d = normalize(vDir);
    vec3 a = textureCube(uA, d).rgb + uDKA * textureCube(uDA, d).rgb;
    vec3 b = textureCube(uB, d).rgb + uDKB * textureCube(uDB, d).rgb;
    vec3 c = mix(a, b, uMix);
    // Насыщенно, как на снимках: тёплое ядро, голубоватые звёздные облака, бурая пыль
    float L = dot(c, vec3(0.3, 0.55, 0.15));
    c = max(mix(vec3(L), c, 1.45), 0.0);
    // С Земли ночью: светлая бело-голубая полоса, пыль в ней остаётся тёмными провалами
    if (uE > 0.001) c = mix(c, vec3(0.74, 0.86, 1.2) * L * 2.1, 0.8 * uE);
    c += bandStars(d, L) * (1.0 + 0.8 * uE);
    if (uDeco > 0.001) {
      float jit = hash3(d * 731.7 + 0.5);
      for (int j = 0; j < ${NN}; j++) {
        vec4 n = nebula(j, d, jit);
        c = c * mix(1.0, n.a, uDeco) + n.rgb * uDeco;
      }
      for (int j = 0; j < ${NC}; j++) c += cluster(j, d) * uDeco;
    }
    // Паутина — за всем: изнутри Млечного Пути её почти заслоняет его свет, за яркими галактиками её не видно
    if (uWebK > 0.001) c += web(d) * uWebK * (1.0 - 0.6 * uIn) * (1.0 - smoothstep(0.015, 0.2, L));
    gl_FragColor = vec4(c * uK, 1.0);
  }`;

const _v = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const smooth = THREE.MathUtils.smoothstep;

// Оси диска: z — нормаль, x, y — в плоскости
function basis(n) {
  const z = n.clone().normalize();
  const x = new THREE.Vector3(1, 0, 0).addScaledVector(z, -z.x);
  if (x.lengthSq() < 1e-4) x.set(0, 1, 0).addScaledVector(z, -z.y);
  x.normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  return { x, y, z, m: new THREE.Matrix3().set(x.x, x.y, x.z, y.x, y.y, y.z, z.x, z.y, z.z) };
}

// Галактики и системы в координатах галактик (метры)
const GALS = LIST.map((g) => {
  const c = new THREE.Vector3(...g.dir);
  if (g.dist) c.normalize().multiplyScalar(g.dist); else c.set(0, 0, 0);
  // normal: null — ребром к Млечному Пути
  const n = g.normal ? new THREE.Vector3(...g.normal) : new THREE.Vector3().crossVectors(c.clone().normalize(), new THREE.Vector3(0.3, 1, 0.2)).normalize();
  return { ...g, c, B: basis(n) };
});
const MW = GALS[0];
// Ядро с Земли видно там, где диск ближе всего к зениту
const toCore = new THREE.Vector3(0, 1, 0).addScaledVector(MW.B.z, -MW.B.z.y).normalize();
function sysPos(S) {
  const dir = toCore.clone().negate().applyAxisAngle(MW.B.z, S.ang);
  return MW.c.clone().addScaledVector(dir, S.r * MW.r).addScaledVector(MW.B.z, S.z * MW.r);
}
const SYS = {
  sol: { id: 'sol', name: 'Солнечная система', g: sysPos(G.sol), origin: REGIONS.sol.origin },
  xarron: { id: 'xarron', name: 'Система Вэлкара', g: sysPos(G.xarron), origin: XARRON_ORIGIN },
};

// Направление на небе системы по галактическим долготе и широте (градусы): l = 0 — на ядро, b = 0 — середина полосы
function skyDir(S, l, b) {
  const e1 = MW.c.clone().sub(S.g).addScaledVector(MW.B.z, -MW.c.clone().sub(S.g).dot(MW.B.z)).normalize();
  const e3 = MW.B.z, e2 = new THREE.Vector3().crossVectors(e3, e1);
  const cb = Math.cos(b * DEG);
  return e1.multiplyScalar(cb * Math.cos(l * DEG)).addScaledVector(e2, cb * Math.sin(l * DEG)).addScaledVector(e3, Math.sin(b * DEG)).normalize();
}
// Оси на небе: z — на объект, x, y — поперёк, повёрнуты на случайный угол
function skyAxes(dir, seed) {
  const x = new THREE.Vector3().crossVectors(dir, MW.B.z);
  if (x.lengthSq() < 1e-6) x.set(1, 0, 0);
  x.normalize().applyAxisAngle(dir, seed * 2.4);
  const y = new THREE.Vector3().crossVectors(dir, x);
  return new THREE.Matrix3().set(x.x, x.y, x.z, y.x, y.y, y.z, dir.x, dir.y, dir.z);
}
const DECALS = (list) => list.map((o) => {
  const dir = skyDir(SYS[o.sys], o.l, o.b);
  return { ...o, dir, m: skyAxes(dir, o.seed), t: Math.tan(o.size * DEG) };
});
const NEBS = DECALS(G.nebulae), CLUS = DECALS(G.clusters);

// Метки HUD в межгалактике: системы и Млечный Путь — остальные галактики без подписей (c и hidden ставит update)
export const GAL_MARKS = [
  ...Object.values(SYS).map((s) => ({ id: `sys-${s.id}`, name: s.id === 'sol' ? 'Солнце' : 'Вэлкар', sys: 'deep', c: new THREE.Vector3(), r: 0, g: s.g, hidden: true })),
  ...GALS.filter((g) => g.name).map((g) => ({ id: `gal-${g.id}`, name: g.name, sys: 'deep', c: new THREE.Vector3(), r: g.r, g: g.c, gal: g, hidden: true })),
];

// Насколько точка (в координатах галактик) внутри галактики: 1 — в толще звёзд, 0 — снаружи
function insideK(g, p) {
  _v.subVectors(p, g.c).applyMatrix3(g.B.m).divideScalar(g.r);
  if (g.type === 0 || g.type === 3) return smooth(-Math.hypot(_v.x, _v.y), -1.35, -1.0) * smooth(-Math.abs(_v.z), -0.3, -0.06);
  return smooth(-_v.length(), -1.2, -0.85);
}

const QUAL = [
  { size: 512, steps: 96, fastSize: 192, fastSteps: 36, nsteps: 28, webSize: 512 },
  { size: 384, steps: 72, fastSize: 160, fastSteps: 30, nsteps: 22, webSize: 384 },
  { size: 256, steps: 56, fastSize: 128, fastSteps: 24, nsteps: 16, webSize: 256 },
];

export class Galaxy {
  constructor(renderer, spaceScene, world) {
    this.renderer = renderer;
    this.world = world;
    this.base = new THREE.Vector3();      // где DEEP_ORIGIN в галактиках (в межгалактике)
    this.gal = new THREE.Vector3().copy(SYS.sol.g);   // где сейчас камера в галактиках
    this.heroGal = new THREE.Vector3().copy(SYS.sol.g);
    this.prevGal = new THREE.Vector3();
    this.hasPrev = false;
    this.armed = true;        // вылет из системы: Tab нужно отпустить после входа, иначе сразу вылетишь обратно
    this.where = 'milky';     // в какой галактике герой (null — между ними)
    this.starK = 1;
    this.decoK = 0;
    this.decoRegion = null;
    this.q = QUAL[1];
    this.off = false;         // в Симуляторе и Битве галактик пока нет (ставит main.js)

    // Небо считается в кубическую текстуру, пока на экране другая; потом новая проявляется поверх
    this.makeTargets();
    this.bakeScene = new THREE.Scene();
    const U = this.U = {
      uGP: { value: GALS.map(() => new THREE.Vector4()) },
      uGM: { value: GALS.map((g) => g.B.m.clone()) },
      uGA: { value: GALS.map((g) => new THREE.Vector4(g.arms, g.pitch, g.seed, g.bright * 2)) },
      uGT: { value: GALS.map((g) => new THREE.Vector3(...g.tint)) },
      uSteps: { value: 72 }, uLayer: { value: 0 }, uField: { value: 1 }, uIn: { value: 1 }, uMWN: { value: MW.B.z.clone() },
    };
    this.bakeMesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.ShaderMaterial({
      uniforms: U,
      vertexShader: 'varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: SKY_F,
      side: THREE.BackSide, depthTest: false, depthWrite: false,
    }));
    this.bakeScene.add(this.bakeMesh);
    this.webScene = new THREE.Scene();
    this.webScene.add(new THREE.Mesh(this.bakeMesh.geometry, new THREE.ShaderMaterial({
      vertexShader: 'varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: WEB_F,
      side: THREE.BackSide, depthTest: false, depthWrite: false,
    })));
    this.webK = 0;
    this.cubeCam = new THREE.CubeCamera(0.1, 10, this.front.rt);
    this.cubeCam.coordinateSystem = renderer.coordinateSystem;
    this.cubeCam.updateCoordinateSystem();
    this.cubeCam.updateMatrixWorld(true);
    this.bakedAt = new THREE.Vector3(Infinity, 0, 0);
    this.bakedFine = false;
    this.bakedDeep = false;

    // Показ: шар вокруг камеры космоса, рисуется первым, ничего не заслоняет
    const tex = this.front.rt.texture;
    this.D = {
      uA: { value: tex }, uB: { value: tex }, uDA: { value: this.front.deco.texture }, uDB: { value: this.front.deco.texture },
      uMix: { value: 0 }, uK: { value: 1 }, uDKA: { value: 0 }, uDKB: { value: 0 }, uDeco: { value: 0 }, uPix: { value: 0.002 }, uIn: { value: 1 },
      uND: { value: NEBS.map(() => new THREE.Vector4()) },
      uNM: { value: NEBS.map((n) => n.m) },
      uNA: { value: NEBS.map((n) => new THREE.Vector4(n.type, n.seed, n.bright, n.dust)) },
      uNC1: { value: NEBS.map((n) => new THREE.Vector3(...n.c1)) },
      uNC2: { value: NEBS.map((n) => new THREE.Vector3(...n.c2)) },
      uCD: { value: CLUS.map(() => new THREE.Vector4()) },
      uCM: { value: CLUS.map((c) => c.m) },
      uCA: { value: CLUS.map((c) => new THREE.Vector4(c.type, c.seed, c.bright, 0)) },
      uNSteps: { value: this.q.nsteps },
      uWeb: { value: this.web.texture }, uWebK: { value: 0 }, uE: { value: 0 },
    };
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), new THREE.ShaderMaterial({
      uniforms: this.D,
      vertexShader: 'varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: SHOW_F,
      side: THREE.BackSide, depthTest: false, depthWrite: false,
    }));
    this.sky.scale.setScalar(5e5);   // не 1e9: при ближней плоскости <1 м грани неба отсекались дальней (точность float32)
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    spaceScene.add(this.sky);
  }

  // Два подробных неба (у каждого — своя текстура соседей, вдвое меньше) и два маленьких — для межгалактического
  // полёта (там небо считается каждый кадр, всё в одной текстуре)
  makeTargets() {
    this.skies?.forEach((s) => { s.rt.dispose(); s.deco?.dispose(); });
    const opt = { type: THREE.HalfFloatType, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    const mk = (n) => new THREE.WebGLCubeRenderTarget(n, opt);
    const q = this.q, ds = Math.max(128, q.size >> 1);
    this.skies = [
      { rt: mk(q.size), deco: mk(ds), hasDeco: false },
      { rt: mk(q.size), deco: mk(ds), hasDeco: false },
      { rt: mk(q.fastSize), deco: null, hasDeco: false },
      { rt: mk(q.fastSize), deco: null, hasDeco: false },
    ];
    this.front = this.skies[0];   // показано целиком
    this.next = null;             // посчитано и проявляется поверх front
    this.mix = 0; this.fading = false; this.bake = null; this.bakedAt?.set(Infinity, 0, 0);
    // Паутина бесконечно далеко: считается один раз, по кусочку за кадр
    this.web?.dispose();
    this.web = mk(q.webSize);
    this.webBake = { face: 0, tile: 0, tiles: Math.max(1, q.webSize >> 7) };
    this.webDone = false;
    if (this.D) this.D.uWeb.value = this.web.texture;
  }

  setQuality(i) {
    const q = QUAL[i] ?? QUAL[1];
    if (q === this.q) return;
    this.q = q;
    this.makeTargets();
    this.D.uNSteps.value = q.nsteps;
  }

  // Точка мира → координаты галактик (в текущем регионе)
  toGal(p, out) {
    if (REGION === 'deep') return out.copy(this.base).add(p).sub(DEEP_ORIGIN);
    const S = SYS[REGION] || SYS.sol;
    return out.copy(S.g).add(p).sub(S.origin);
  }

  // Край системы на W + Shift + Tab: вылет в галактику
  escape(player) {
    if (this.off || !this.armed || REGION === 'deep' || this.world.planetMap?.active) return false;
    const S = SYS[REGION];
    if (!S) return false;
    this.base.copy(S.g).add(player.pos).sub(S.origin);
    this.where = 'milky';
    player.pos.copy(DEEP_ORIGIN);
    player.onBody = player.nearBody = null;
    player.grounded = false;
    setRegion('deep');
    this.hasPrev = false;
    this.world.toast?.(this.whereName().toUpperCase(), 2.4);
    return true;
  }

  // Межгалактика: «беговая дорожка» — до хода героя возвращаем его к DEEP_ORIGIN, сдвигая base
  preTick(player) {
    if (REGION !== 'deep') return;
    _v.subVectors(player.pos, DEEP_ORIGIN);
    this.base.add(_v);
    player.pos.copy(DEEP_ORIGIN);
  }

  // После хода героя: вход в систему, граница группы, в какой галактике герой
  postTick(dt, player, input) {
    if (input.gear !== 5) this.armed = true;
    this.toGal(player.pos, this.heroGal);
    if (REGION !== 'deep') { this.hasPrev = false; return; }
    if (this.hasPrev) {
      for (const S of Object.values(SYS)) {
        if (this.prevGal.distanceTo(S.g) <= G.catchR) {
          // Уже рядом со звездой (только что вылетел или сбросил скорость на подлёте): пока улетаешь — не ловит,
          // повернул к звезде — вход. Иначе можно было долететь до самой метки, а системы нет
          _a.subVectors(S.g, this.heroGal);
          const sp = player.vel.length(), d = _a.length();
          if (sp > 50 && d > 1 && player.vel.dot(_a) > 0.5 * sp * d) { this.enter(S, player); return; }
          continue;
        }
        // Ближайшая к звезде точка пути за кадр
        _a.subVectors(this.heroGal, this.prevGal);
        const L2 = _a.lengthSq();
        const t = L2 > 0 ? THREE.MathUtils.clamp(_b.subVectors(S.g, this.prevGal).dot(_a) / L2, 0, 1) : 1;
        _c.copy(this.prevGal).addScaledVector(_a, t);
        if (_c.distanceTo(S.g) < G.catchR) { this.enter(S, player); return; }
      }
    }
    // Граница группы: дальше не пускаем, гасим только скорость «наружу»
    const r = this.heroGal.length();
    if (r > G.bound) {
      _a.copy(this.heroGal).divideScalar(r);
      this.base.addScaledVector(_a, G.bound - r);
      this.heroGal.addScaledVector(_a, G.bound - r);
      const out = player.vel.dot(_a);
      if (out > 0) player.vel.addScaledVector(_a, -out);
    }
    this.prevGal.copy(this.heroGal);
    this.hasPrev = true;
    // Переход из галактики в галактику — надпись
    let where = null;
    for (const g of GALS) if (insideK(g, this.heroGal) > 0.5) { where = g.id; break; }
    if (where !== this.where) {
      this.where = where;
      this.world.toast?.(this.whereName().toUpperCase(), 2.4);
    }
  }

  whereName() {
    if (REGION !== 'deep') return SYS[REGION]?.name || '';
    const g = GALS.find((x) => x.id === this.where);
    return g ? g.name || 'Другая галактика' : 'Межгалактическое пространство';
  }

  // Вход в систему: на её краю, со стороны подлёта, к центру, не быстрее W + Shift + R
  enter(S, player) {
    const R = REGIONS[S.id].radius * 0.97;
    _a.subVectors(this.prevGal, S.g);
    if (_a.lengthSq() < 1) _a.copy(player.vel).negate();
    _a.normalize();
    const sp = Math.min(player.vel.length(), P.starSpeed);
    setRegion(S.id);
    player.pos.copy(S.origin).addScaledVector(_a, R);
    if (player.vel.dot(_a) > 0 || player.vel.lengthSq() < 1) player.vel.copy(_a).negate();
    player.vel.setLength(sp);
    player.onBody = player.nearBody = null;
    this.armed = false;
    this.hasPrev = false;
    this.where = 'milky';
    this.world.toast?.(S.name.toUpperCase(), 2.6);
  }

  // Для проверок: в межгалактику, в точку p (координаты галактик)
  teleport(p, player) {
    this.base.copy(p);
    player.pos.copy(DEEP_ORIGIN);
    player.vel.set(0, 0, 0);
    player.onBody = player.nearBody = null; player.grounded = false;
    setRegion('deep');
    this.hasPrev = false;
  }

  get systems() { return SYS; }
  get galaxies() { return GALS; }

  // Туманности и скопления — на небе той системы, где герой (в межгалактике их нет)
  placeDecals() {
    if (this.decoRegion === REGION) return;
    this.decoRegion = REGION;
    NEBS.forEach((n, j) => this.D.uND.value[j].set(n.dir.x, n.dir.y, n.dir.z, n.sys === REGION ? n.t : 0));
    CLUS.forEach((c, j) => this.D.uCD.value[j].set(c.dir.x, c.dir.y, c.dir.z, c.sys === REGION ? c.t : 0));
  }

  // Каждый кадр: где камера, метки, звёзды, свет, кусочек неба
  update(dt, camera, spaceCamera) {
    // Выключено (Симулятор и Битва): небо — одни звёзды, как раньше
    this.sky.visible = !this.off;
    if (this.off) {
      this.starK = 1;
      for (const m of GAL_MARKS) m.hidden = true;
      return;
    }
    this.toGal(camera.position, this.gal);
    const deep = REGION === 'deep';
    // Звёзды-точки — только внутри галактики
    let k = 0;
    for (const g of GALS) k = Math.max(k, insideK(g, this.gal));
    this.starK = deep ? k : 1;
    // Метки: в межгалактике — системы и галактики (свою, в которой герой, не показываем)
    for (const m of GAL_MARKS) {
      m.hidden = !deep || (m.gal && m.gal.id === this.where);
      if (m.hidden) continue;
      m.c.copy(DEEP_ORIGIN).add(m.g).sub(this.base);
    }
    // Свет: от ближайшей к взгляду яркой галактики (в Млечном Пути — от ядра)
    let bd = Infinity;
    if (deep) {
      let best = null;
      for (const g of GALS) { const d = g.c.distanceTo(this.gal) / g.r; if (d < bd) { bd = d; best = g; } }
      _a.subVectors(best.c, this.gal);
      if (_a.lengthSq() < 1) _a.set(0, 1, 0);
      DEEP_LIGHT.c.copy(camera.position).addScaledVector(_a.normalize(), 1e14);
    }
    // Соседние галактики, туманности и скопления — только из космоса: с Земли (и с поверхности планет) на небе
    // одна полоса Млечного Пути
    this.decoK = deep || this.world.planetMap?.active ? 0
      : REGION === 'sol' ? smooth(camera.position.y, SPACE.atmosphere, SPACE.spaceAlt) : 1;
    this.placeDecals();

    this.sky.position.copy(spaceCamera.position);
    if (this.fading) {
      this.mix += dt / (deep ? 0.18 : 0.6);
      if (this.mix >= 1) { this.front = this.next; this.next = null; this.mix = 0; this.fading = false; }
    }
    const A = this.front, B = this.next || this.front, D = this.D;
    D.uMix.value = this.mix;
    D.uA.value = A.rt.texture; D.uB.value = B.rt.texture;
    D.uDA.value = (A.deco || this.skies[0].deco).texture; D.uDB.value = (B.deco || this.skies[0].deco).texture;
    D.uDKA.value = A.hasDeco ? this.decoK : 0; D.uDKB.value = B.hasDeco ? this.decoK : 0;
    D.uDeco.value = this.decoK;
    D.uIn.value = insideK(MW, this.gal);
    D.uPix.value = camera.fov * DEG / Math.max(1, this.renderer.domElement.height);
    // Ночь с Земли (в системе Солнца, ниже космоса)
    D.uE.value = REGION === 'sol' && !this.world.planetMap?.active ? 1 - smooth(camera.position.y, SPACE.atmosphere, SPACE.spaceAlt) : 0;
    // Паутина — только в самой межгалактике: вылетел из системы, но ещё в галактике (или рядом с ней) — её нет.
    // Проявляется за полтора–два с половиной радиуса от ближайшей галактики
    const webT = deep && this.webDone ? smooth(bd, 1.5, 2.5) : 0;
    this.webK = THREE.MathUtils.clamp(this.webK + Math.sign(webT - this.webK) * Math.min(Math.abs(webT - this.webK), dt / 0.6), 0, 1);
    D.uWebK.value = this.webK;
    this.step(deep);
    if (!this.webDone) this.bakeWeb();
  }

  // Кусочек паутины за кадр
  bakeWeb() {
    const B = this.webBake, rt = this.web, n = B.tiles, s = rt.width / n;
    const r = this.renderer, prev = r.getRenderTarget();
    rt.scissor.set((B.tile % n) * s, Math.floor(B.tile / n) * s, s, s);
    rt.scissorTest = n > 1;
    r.setRenderTarget(rt, B.face);
    r.render(this.webScene, this.cubeCam.children[B.face]);
    rt.scissorTest = false;
    r.setRenderTarget(prev);
    if (++B.tile >= n * n) { B.tile = 0; B.face++; }
    if (B.face >= 6) this.webDone = true;
  }

  // Небо: кусочек за кадр в свободное небо, пока на экране front. В системе — подробно (24 кусочка), потом
  // соседи (6 кусочков), раз на систему; в межгалактике в полёте — грубо, по грани за кадр; остановился — ещё раз подробно
  step(deep) {
    if (this.fading) return;
    if (!this.bake) {
      const moved = this.bakedAt.distanceTo(this.gal);
      const fast = deep && moved > 1e9;
      const need = !isFinite(moved) || fast || this.bakedDeep !== deep || (deep ? !this.bakedFine : moved > 1e11);
      if (!need) return;
      const S = this.skies, sky = fast ? (S[2] === this.front ? S[3] : S[2]) : (S[0] === this.front ? S[1] : S[0]);
      this.bake = { face: 0, tile: 0, tiles: fast ? 1 : 2, pos: this.gal.clone(), fine: !fast, deep, sky, rt: sky.rt, layer: deep ? 2 : 0 };
      this.prepare(this.bake);
    }
    const B = this.bake, rt = B.rt, n = B.tiles, s = rt.width / n;
    const tx = B.tile % n, ty = Math.floor(B.tile / n);
    const r = this.renderer, prev = r.getRenderTarget();
    rt.scissor.set(tx * s, ty * s, s, s);
    rt.scissorTest = n > 1;
    r.setRenderTarget(rt, B.face);
    r.render(this.bakeScene, this.cubeCam.children[B.face]);
    rt.scissorTest = false;
    r.setRenderTarget(prev);
    if (++B.tile >= n * n) { B.tile = 0; B.face++; }
    if (B.face < 6) return;
    if (B.layer === 0) {
      // Млечный Путь готов — теперь соседи за ним, в свою текстуру
      B.layer = 1; B.rt = B.sky.deco; B.tiles = 1; B.face = 0; B.tile = 0;
      this.prepare(B);
      return;
    }
    // Готово: проявляем новое небо поверх старого
    B.sky.hasDeco = B.layer === 1;
    this.bakedAt.copy(B.pos); this.bakedFine = B.fine; this.bakedDeep = B.deep;
    this.bake = null;
    this.next = B.sky;
    this.fading = true;
    this.mix = 0;
  }

  // Камера в осях каждой галактики — в double на CPU
  prepare(B) {
    const U = this.U, p = B.pos;
    const kMW = insideK(MW, p);
    // Ближе к ядру полоса ярче — экспозиция как у глаза, привыкшего к темноте: у Ксаррона не пересвечено
    _v.subVectors(p, MW.c).applyMatrix3(MW.B.m);
    const expo = THREE.MathUtils.lerp(1, THREE.MathUtils.clamp((Math.hypot(_v.x, _v.y) / MW.r / G.sol.r) ** 1.5, 0.35, 1), kMW);
    GALS.forEach((g, i) => {
      // Снаружи луч проходит диск поперёк (тонко), изнутри — вдоль: чтобы галактика снаружи не была в разы
      // тусклее своей же полосы на небе, снаружи её свет сильнее. Соседи из нашей галактики — тусклые, как в жизни
      const k = insideK(g, p);
      let gain = 1 + OUT_GAIN * (1 - k);
      if (i > 0) gain *= THREE.MathUtils.lerp(1, 0.1, kMW); else gain *= expo;
      U.uGA.value[i].w = g.bright * 2 * gain;
      _v.subVectors(p, g.c).applyMatrix3(g.B.m).divideScalar(g.r);
      U.uGP.value[i].set(_v.x, _v.y, _v.z, g.type);
    });
    U.uLayer.value = B.layer;
    U.uIn.value = kMW;
    U.uSteps.value = !B.fine ? this.q.fastSteps : B.layer === 1 ? Math.round(this.q.steps * 0.6) : this.q.steps;
  }
}
