import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../utils.js';
import { MAP_TILE } from '../world/planetmap.js';

// Тарвэн — столица Ксаррона на карте его поверхности. Город круглый, весь план — от Цитадели Совета:
// шесть проспектов-лучей и четыре кольцевых бульвара. Ближе к центру — Зал Домов (двенадцать башен
// знатных родов, среди них тёмная башня дома Вэйр), дальше Высокий город из кристальных башен,
// средний пояс террас, пояс куполов и внешний пояс сот. На востоке — Арена присяги, на северо-западе —
// Сады памяти, ещё дальше на северо-западе — Верфи (сорок кораблей флота), на юго-западе — порт
// с нитью орбитального лифта, на западе через город идёт Разлом: каньон, где живут бескрылые.
// Над поясом куполов — кольцо монорельса (Скайвей), над городом висят парящие острова.
//
// Город стоит на выровненном плато (shape правит тайл высот до текстур). Обычные дома ломаются
// (таран, удары, пике — срез и падение верхушки, внизу «разрушение»), а Цитадель, Зал Домов, Арена,
// Архив и Порт — из звёздного кристалла: от них герой отскакивает, как от скалы. Все меши — в одной группе
// (root): её начало — центр копии города, ближайшей к камере (тайл карты периодичен). Координаты
// внутри группы — «кадр города»: те же, что на тайле, центр в (CX, CZ). Кривизна горизонта — как
// у камней карты: дальние экземпляры опускаются на d²/2RV.

const { TN, BIG_SP, BIG_P, RV } = MAP_TILE;
export const CX = BIG_P / 2, CZ = BIG_P / 2;
export const R_CITY = 6400, R_EDGE = 7900;
const DEG = Math.PI / 180;
export const AVENUES = [30, 90, 150, 210, 270, 330].map((a) => a * DEG);
const AV_W = 45;                       // полуширина проспекта, м
export const RINGS = [950, 1900, 3000, 4400];
const RING_W = 35;
export const SKYWAY = { r: 3700, h: 56 };   // кольцо монорельса: радиус и высота полотна над плато
const polar = (r, deg) => [CX + r * Math.cos(deg * DEG), CZ + r * Math.sin(deg * DEG)];
// Места города (кадр города)
export const SITES = {
  citadel: [CX, CZ],
  arena: polar(1450, 0),
  gardens: polar(1400, 120),
  port: polar(2650, 240),
  archive: polar(615, 190),
  house: polar(775, 190),
  yards: polar(5250, 120),
  xargStela: polar(1400, 120).map((v, i) => v + (i ? 46 : 0)),
};
// Разлом: каньон-капсула от a до b; дно полушириной half, стены — ещё wall
export const RIFT = { a: polar(1990, 182), b: polar(4200, 194), half: 140, wall: 55, depth: 120 };
export const HOUSES = [
  { a: 350, c: [1, 0.62, 0.25] }, { a: 10, c: [0.3, 0.85, 1] }, { a: 50, c: [0.72, 0.42, 1] }, { a: 70, c: [1, 0.26, 0.2] },
  { a: 110, c: [1, 1, 1] }, { a: 130, c: [1, 0.84, 0.38] }, { a: 170, c: [0.2, 1, 0.72] }, { a: 190, c: [1, 0.82, 0.55], veyr: true },
  { a: 230, c: [1, 0.45, 0.72] }, { a: 250, c: [0.6, 0.8, 1] }, { a: 290, c: [1, 0.46, 0.12] }, { a: 310, c: [0.55, 1, 0.32] },
];

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
export const wrapD = (d) => d - Math.round(d / BIG_P) * BIG_P;

// Расстояние до оси Разлома (и параметр вдоль неё)
export function riftDist(x, z) {
  const [ax, az] = RIFT.a, [bx, bz] = RIFT.b, ux = bx - ax, uz = bz - az;
  const t = Math.max(0, Math.min(1, ((x - ax) * ux + (z - az) * uz) / (ux * ux + uz * uz)));
  return { d: Math.hypot(x - ax - ux * t, z - az - uz * t), t };
}
const riftCut = (x, z) => -RIFT.depth * smooth(RIFT.half + RIFT.wall, RIFT.half, riftDist(x, z).d);

// Доля «города» в точке тайла (1 — плато, 0 — дикие горы)
export function cityMask(x, z) {
  return smooth(R_EDGE, R_CITY, Math.hypot(wrapD(x - CX), wrapD(z - CZ)));
}

// Мостовая, проспекты и линии света — поверх грунта карты (вставка в шейдер рельефа, planetmap.js)
export const GROUND_GLSL = /* glsl */`
  uniform float uCityH;
  float cLine(float d, float w, float px) { return 1.0 - smoothstep(w, w + px * 1.5, d); }
  void cityGround(vec2 q, float r, float cm, float px, float y, inout vec3 col, inout vec3 emi, inout float h) {
    float rift = smoothstep(uCityH - 12.0, uCityH - 40.0, y);
    // Плиты звёздного камня: светлые, с тонкими швами; швы гаснут вдали
    vec3 stone = vec3(0.36, 0.37, 0.41) * (0.9 + 0.2 * inoise(vec3(q, 3.0) / 90.0));
    vec2 sl = abs(fract(q / 12.0) - 0.5) * 12.0;
    float seam = (1.0 - smoothstep(0.12, 0.12 + px, min(sl.x, sl.y))) * (1.0 - smoothstep(1.0, 4.0, px));
    stone *= 1.0 - 0.35 * seam;
    float ang = atan(q.y, q.x);
    // Проспекты-лучи: тёмное полотно, по краям и по оси — полосы света
    float av = 1e5;
    for (int i = 0; i < 6; i++) {
      float a = radians(30.0 + 60.0 * float(i));
      vec2 dir = vec2(cos(a), sin(a));
      float along = dot(q, dir);
      if (along > 600.0) av = min(av, abs(dot(q, vec2(-dir.y, dir.x))));
    }
    // Кольцевые бульвары
    float rg = min(min(min(abs(r - 950.0), abs(r - 1900.0)), abs(r - 3000.0)), abs(r - 4400.0));
    float road = min(av - 45.0, rg - 35.0);
    float onRoad = 1.0 - smoothstep(-1.0, 0.5 + px, road);
    vec3 asph = vec3(0.07, 0.075, 0.09) * (0.9 + 0.2 * inoise(vec3(q, 7.0) / 6.0));
    col = mix(col, mix(stone, asph, onRoad), cm * (1.0 - rift));
    float glow = 0.0;
    glow += cLine(abs(av - 2.0), 0.35, px) * step(av, 10.0) + cLine(abs(av - 41.0), 0.4, px);
    glow += cLine(abs(rg - 1.5), 0.3, px) + cLine(abs(rg - 32.0), 0.35, px);
    // Площадь Совета: концентрические круги и восемь лучей звезды от Цитадели
    float pl = 1.0 - smoothstep(560.0, 600.0, r);
    float ringL = cLine(abs(fract(r / 60.0) - 0.5) * 60.0 - 29.0, 0.0, px) * step(220.0, r);
    float star = cLine(abs(fract(ang / 0.7853982 + 0.5) - 0.5) * 0.7853982 * r, 0.5, px) * step(220.0, r);
    glow += (ringL * 0.6 + star) * pl;
    emi += vec3(0.35, 0.75, 1.3) * glow * cm * (1.0 - rift) * (1.0 - smoothstep(30.0, 90.0, px));
    // Дно Разлома: тёмный камень, пыль, тёплые пятна огней бескрылых
    vec3 rock = vec3(0.12, 0.105, 0.1) * (0.8 + 0.4 * inoise(vec3(q, 1.0) / 14.0));
    col = mix(col, rock, rift * cm);
    h *= mix(1.0 - cm, 1.0, rift);
  }`;

// ---------------------------------------------------------------- геометрии (единичные, низ в y = 0)
function flat(g) { g = g.toNonIndexed(); g.computeVertexNormals(); g.deleteAttribute('uv'); return g; }
function prism(sides, top) { return flat(new THREE.CylinderGeometry(top, 1, 1, sides, 1).translate(0, 0.5, 0)); }
function bladeGeo() {
  const g = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), p = g.attributes.position;
  for (let i = 0; i < p.count; i++) if (p.getY(i) > 0.99 && p.getX(i) > 0) p.setY(i, 0.74);
  return flat(g);
}
function arenaGeo() {
  // Профиль: низкий внутренний борт, ступени трибун вверх и наружу, стена с карнизом
  const pts = [[168, 0], [168, 9], [176, 9]];
  for (let s = 0; s < 12; s++) {
    const r = 176 + s * 8.5, y = 9 + s * 4.1;
    pts.push([r, y + 4.1], [r + 8.5, y + 4.1]);
  }
  pts.push([278, 62], [286, 62], [286, 0]);
  const g = new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(x, y)), 72);
  g.deleteAttribute('uv');
  return g;
}
function shipGeo() {
  // Клин корабля Ксаррона: острый нос, два боковых лезвия, корма с соплами (длина 1 вдоль +z)
  const hull = new THREE.ConeGeometry(0.5, 1, 4).rotateY(Math.PI / 4).rotateX(Math.PI / 2).scale(0.42, 0.16, 1);
  const bl = (s) => new THREE.BoxGeometry(0.03, 0.05, 0.62).rotateY(s * 0.32).translate(s * 0.2, 0, -0.12);
  const aft = new THREE.CylinderGeometry(0.1, 0.12, 0.1, 8).rotateX(Math.PI / 2).translate(0, 0, -0.5);
  return flat(mergeGeometries([hull, bl(1), bl(-1), aft].map((g) => g.toNonIndexed())).translate(0, 0.08, 0));
}
// Парящий остров: перевёрнутый скальный конус, верх в y = 0, остриё в y = −1
function isleGeo() {
  const g = new THREE.CylinderGeometry(1, 0.04, 1, 11, 5).translate(0, -0.5, 0), p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y > -0.01 || y < -0.99) continue;
    // Неровный скальный бок: сдвиг от самой точки, чтобы на шве цилиндра не было щели
    const h = Math.sin(p.getX(i) * 12.99 + y * 78.23 + p.getZ(i) * 37.72) * 43758.5453, k = 0.68 + 0.6 * (h - Math.floor(h));
    p.setX(i, p.getX(i) * k); p.setZ(i, p.getZ(i) * k);
  }
  return flat(g);
}
function craftGeo() {
  const body = new THREE.CapsuleGeometry(0.62, 3.1, 2, 8).rotateX(Math.PI / 2).scale(1.15, 0.5, 1);
  const fin = (s) => new THREE.BoxGeometry(1.5, 0.08, 0.9).translate(s * 0.9, 0, -1.2);
  const cab = new THREE.SphereGeometry(0.55, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.6, 1.6).translate(0, 0.2, 0.6);
  return mergeGeometries([body, fin(1), fin(-1), cab].map((g) => { g = g.toNonIndexed(); g.deleteAttribute('uv'); return g; }));
}
function craftLightsGeo() {
  const g = [new THREE.BoxGeometry(0.5, 0.14, 0.08).translate(0.42, 0, -2.25), new THREE.BoxGeometry(0.5, 0.14, 0.08).translate(-0.42, 0, -2.25),
    new THREE.BoxGeometry(1.6, 0.05, 0.05).translate(0, -0.05, 2.05)];
  return mergeGeometries(g.map((x) => { x.deleteAttribute('uv'); return x; }));
}

// Опускание дальних экземпляров (кривизна горизонта карты) — для любых материалов экземпляров
export function curvePatch(shader, U) {
  shader.uniforms.uCamC = U.uCamC;
  shader.uniforms.uRvI = { value: 1 / (2 * RV) };
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nuniform vec2 uCamC; uniform float uRvI;')
    .replace('#include <project_vertex>', /* glsl */`
      vec4 rP = instanceMatrix * vec4(transformed, 1.0);
      float rD = distance(instanceMatrix[3].xz, uCamC);
      rP.y -= rD * rD * uRvI;
      vec4 mvPosition = modelViewMatrix * rP;
      gl_Position = projectionMatrix * mvPosition;`);
}

// Материал зданий: кристальный камень, ряды тёмного стекла с редкими огнями, полосы света дома;
// у дисков (RIM) — светящийся край
function buildingMaterial(U, rim) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.25, envMapIntensity: 0 });
  mat.customProgramCacheKey = () => 'tarven' + (rim ? 'rim' : '');
  mat.onBeforeCompile = (shader) => {
    curvePatch(shader, U);
    shader.uniforms.uCityH = U.uCityH;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 aGlow; attribute vec2 aInfo;
        varying vec3 vCP, vCN, vGlow, vObj; varying vec2 vInfo;`)
      .replace('vec4 mvPosition = modelViewMatrix * rP;', `
        vCP = (instanceMatrix * vec4(transformed, 1.0)).xyz;
        vCN = normalize(mat3(instanceMatrix) * objectNormal);
        vGlow = aGlow; vInfo = aInfo; vObj = position;
        vec4 mvPosition = modelViewMatrix * rP;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uCityH;
        varying vec3 vCP, vCN, vGlow, vObj; varying vec2 vInfo;
        float th21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`)
      .replace('#include <color_fragment>', /* glsl */`#include <color_fragment>
        vec3 fN = normalize(vCN);
        float fWin = 0.0; vec3 fEm = vec3(0.0);
        float fpx = length(fwidth(vCP));
        if (abs(fN.y) < 0.6) {
          vec2 ft = normalize(vec2(-fN.z, fN.x));
          float fu = dot(vCP.xz, ft), fy = vCP.y - uCityH;
          vec2 cell = vec2(fu / 3.4, fy / 4.4), fc = fract(cell), ic = floor(cell);
          float win = step(0.16, fc.y) * step(fc.y, 0.84) * step(0.1, fc.x) * step(fc.x, 0.9);
          win = mix(0.5, win, 1.0 - smoothstep(0.5, 2.0, fpx)) * vInfo.x;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.025, 0.04, 0.065), win * 0.85);
          fWin = win;
          fEm += vec3(1.0, 0.72, 0.45) * step(0.84, th21(ic + vInfo.y * 17.0)) * win * 0.7;
          float bd = abs(fract(fy / 28.0 + vInfo.y) - 0.5) * 28.0;
          fEm += vGlow * smoothstep(13.35 - fpx, 13.7, bd) * 1.7;
        } else diffuseColor.rgb *= 1.08;
        #ifdef RIM
          fEm += vGlow * smoothstep(0.93, 0.975, length(vObj.xz)) * 2.2;
        #endif`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix(roughness, 0.16, fWin);')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = mix(metalness, 0.55, fWin);')
      .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance += fEm;');
  };
  if (rim) mat.defines = { RIM: 1 };
  return mat;
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
const _c = new THREE.Vector3(), _n = new THREE.Vector3(), _o = new THREE.Vector3();
const _h = new THREE.Vector3(), _d = new THREE.Vector3(), _e = new THREE.Vector3(), _f = new THREE.Vector3(), _g = new THREE.Vector3();
const _s2 = new THREE.Vector3(), _q2 = new THREE.Quaternion();
const _m2 = new THREE.Matrix4(), _m3 = new THREE.Matrix4(), _m4 = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

// Разрушение: запасные места под верхушки, сужение видов к верху (для среза), камень обломков
const SPARE = { prism: 40, taper: 40, spire: 40, box: 60, blade: 30 };
const TOP_R = { taper: 0.62, spire: 0 };
const WHOLE = { dome: 1, disc: 1 };   // не режутся: при срезе уходят целиком
const CRYSTAL = [0xc9cdd8, 0xaeb5c3, 0xdad8d2, 0x98a0b0, 0x7f8798].map((c) => new THREE.Color(c));
const RIFT_STONE = [0x6c625a, 0x5a524b, 0x7a6f64].map((c) => new THREE.Color(c));
const CHUNK_G = 9.81 * 1.4;
const TRAIN_CARS = 5;

// Столкновения: t 0 — цилиндр или усечённый конус (rB, rT), 1 — повёрнутый ящик, 2 — кольцо Арены, 3 — купол
const GRID = 120, G0X = CX - 8200, G0Z = CZ - 8200, GN = 137;

export class Tarven {
  constructor(scene, world) {
    this.world = world;
    this.root = new THREE.Group();
    this.root.visible = false;
    scene.add(this.root);
    this.U = { uCamC: { value: new THREE.Vector2() }, uCityH: { value: 0 } };
    this.built = false;
    this.hC = 0;
    this.shift = new THREE.Vector2();   // какая копия города (в периодах тайла)
    this.cols = [];
    this.grid = new Map();
    this.veyrSlots = [];
    this.veyrLit = false;
    this.chunks = [];        // падающие верхушки
    this.wrecked = 0;        // сколько домов сломано с прилёта
    this.weldT = 0;
  }

  // ---------------------------------------------------------------- рельеф (до текстур карты)
  shape(T) {
    const H = T.bigH, B = T.base;
    let sum = 0, n = 0;
    for (let j = 0; j < TN; j += 2) for (let i = 0; i < TN; i += 2) {
      if (Math.hypot(wrapD(i * BIG_SP - CX), wrapD(j * BIG_SP - CZ)) < R_CITY) { sum += H[j * TN + i]; n++; }
    }
    this.hC = Math.round(n ? sum / n : 0);
    this.U.uCityH.value = this.hC;
    for (let j = 0; j < TN; j++) for (let i = 0; i < TN; i++) {
      const dx = wrapD(i * BIG_SP - CX), dz = wrapD(j * BIG_SP - CZ);
      const f = smooth(R_EDGE, R_CITY, Math.hypot(dx, dz));
      if (f <= 0) continue;
      const k = j * TN + i, want = this.hC + riftCut(CX + dx, CZ + dz);
      H[k] += (want - H[k]) * f;
      // Плато не ломается: «равнина» поднята до самого грунта
      B[k] = f > 0.999 ? H[k] : Math.min(H[k], B[k] + (H[k] - B[k]) * f);
    }
  }

  ground(x, z) { return this.hC + riftCut(x, z); }

  // ---------------------------------------------------------------- план и меши
  build() {
    if (this.built) return;
    this.built = true;
    const rnd = mulberry32(7741);
    const kinds = {
      prism: prism(6, 1), taper: prism(6, 0.62), spire: prism(6, 0), box: flat(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0)),
      blade: bladeGeo(), dome: new THREE.SphereGeometry(1, 16, 5, 0, Math.PI * 2, 0, Math.PI / 2), disc: prism(24, 1),
      pyr: flat(new THREE.CylinderGeometry(0, 1, 1, 4, 1).rotateY(Math.PI / 4).translate(0, 0.5, 0)), ship: shipGeo(),
      tether: prism(8, 1), arena: arenaGeo(), isle: isleGeo(),
    };
    kinds.dome.deleteAttribute('uv');
    const L = {};   // экземпляры по видам: { m, tint, glow, win, seed }
    // Ломаемое здание: что строится между begin() и end() — его части и тела
    let cur = null;
    this.blds = [];
    this.colB = [];
    const begin = () => { cur = { parts: [], cols: [] }; };
    const end = () => {
      const b = cur;
      cur = null;
      if (!b.parts.length) return;
      let y1 = -Infinity, r = 0;
      for (const p of b.parts) y1 = Math.max(y1, p.y0 + p.h);
      for (const id of b.cols) { r = Math.max(r, this.cols[id].R); this.colB[id] = b; }
      const c0 = this.cols[b.cols[0]];
      Object.assign(b, { x: c0.x, z: c0.z, y0: b.parts[0].y0, y1, r, hp0: 60 + r * (y1 - b.parts[0].y0) * 0.12, cut: Infinity, broken: false });
      b.hp = b.hp0;
      b.rift = b.y0 < hc - 10;   // жилища на дне Разлома — бурый камень
      b.orig = b.cols.map((id) => ({ ...this.cols[id] }));
      this.blds.push(b);
    };
    const put = (kind, x, y, z, sx, sy, sz, yaw, tint, glow, win, seed = rnd()) => {
      _q.setFromAxisAngle(UP, yaw);
      const m = new THREE.Matrix4().compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
      (L[kind] || (L[kind] = [])).push({ m, tint, glow, win, seed });
      const i = L[kind].length - 1;
      if (cur) cur.parts.push({ kind, i, m, y0: y, h: sy, hc: sy, gone: false });
      return { kind, i };
    };
    const hc = this.hC;
    // fl — тонкий диск в воздухе (венец, платформа): снизу его можно задеть головой
    const col = (c) => { const id = this.addCol(c); if (cur) cur.cols.push(id); };
    const cyl = (x, z, y0, y1, rB, rT = rB, fl = false) => col({ t: 0, x, z, y0, y1, rB, rT, fl, R: Math.max(rB, rT) });
    const box = (x, z, y0, y1, hx, hz, yaw) => col({ t: 1, x, z, y0, y1, hx, hz, c: Math.cos(yaw), s: Math.sin(yaw), R: Math.hypot(hx, hz) });

    const PALE = [[0.78, 0.8, 0.86], [0.7, 0.74, 0.82], [0.84, 0.83, 0.8], [0.62, 0.66, 0.74], [0.9, 0.9, 0.93]];
    const pale = () => PALE[Math.floor(rnd() * PALE.length)];
    const GLOWS = [[0.3, 0.75, 1.1], [0.4, 0.85, 1.2], [1.1, 0.7, 0.35], [0.55, 0.7, 1.2], [0.25, 0.95, 1.0]];
    const glowC = () => GLOWS[Math.floor(rnd() * (rnd() < 0.8 ? 2 : GLOWS.length))];
    const dim = (c, k) => c.map((v) => v * k);

    // Башня-игла: шестигранный ствол, венец, шпиль, кольца-венцы
    const spireTower = (x, z, r, H, tint, glow, opt = {}) => {
      const yaw = rnd() * Math.PI, sh = H * 0.8, out = [];
      out.push(put('prism', x, hc, z, r, sh, r, yaw, tint, glow, opt.win ?? 1));
      cyl(x, z, hc, hc + sh, r * 0.95);
      out.push(put('taper', x, hc + sh, z, r * 1.06, H * 0.08, r * 1.06, yaw, tint, glow, 0.6));
      cyl(x, z, hc + sh, hc + sh + H * 0.08, r * 1.0, r * 0.66);
      out.push(put('spire', x, hc + sh + H * 0.08, z, r * 0.62, H * 0.22, r * 0.62, yaw, tint, glow, 0));
      cyl(x, z, hc + sh + H * 0.08, hc + H * 1.1, r * 0.55, r * 0.05);
      const rings = opt.rings ?? (H > 260 ? 2 : rnd() < 0.5 ? 1 : 0);
      for (let k = 0; k < rings; k++) {
        const y = hc + sh * (0.45 + 0.25 * k);
        out.push(put('disc', x, y, z, r * 1.45, 2.6, r * 1.45, 0, tint, glow, 0));
        cyl(x, z, y, y + 2.6, r * 1.45, r * 1.45, true);
      }
      return out;
    };
    const bladeTower = (x, z, w, d, H, tint, glow) => {
      const yaw = Math.atan2(-(z - CZ), x - CX) + (rnd() < 0.5 ? 0 : Math.PI);
      put('blade', x, hc, z, w, H, d, yaw, tint, glow, 1);
      box(x, z, hc, hc + H * 0.87, w / 2, d / 2, yaw);
    };
    const terrace = (x, z, w, d, H, tint, glow, win = 0.8) => {
      const yaw = Math.atan2(-(z - CZ), x - CX);
      let y = hc, k = 1;
      const tiers = 2 + Math.floor(rnd() * 2);
      for (let t = 0; t < tiers; t++) {
        const h = H / tiers * (1.2 - t * 0.2);
        put('box', x, y, z, w * k, h, d * k, yaw, tint, glow, win);
        box(x, z, y, y + h, w * k / 2, d * k / 2, yaw);
        y += h; k *= 0.72;
      }
    };
    // Соты: несколько шестигранных башен разной высоты на общем подиуме, у каждой — венец
    const hive = (x, z, R, H, tint, glow) => {
      put('prism', x, hc, z, R, 4, R, rnd(), dim(tint, 0.85), glow, 0);
      cyl(x, z, hc, hc + 4, R * 0.9);
      const n = 3 + Math.floor(rnd() * 4), a0 = rnd() * 6.28;
      for (let k = 0; k < n; k++) {
        const a = a0 + k / n * Math.PI * 2, rr = k === 0 ? 0 : R * 0.55, px = x + Math.cos(a) * rr, pz = z + Math.sin(a) * rr;
        const r = R * (0.2 + rnd() * 0.1), h = H * (k === 0 ? 1.25 : 0.45 + rnd() * 0.5), yaw = rnd();
        put('prism', px, hc + 4, pz, r, h, r, yaw, tint, glow, 1);
        cyl(px, pz, hc + 4, hc + 4 + h, r * 0.95);
        put('taper', px, hc + 4 + h, pz, r * 1.05, r * 0.7, r * 1.05, yaw, tint, glow, 0.4);
        cyl(px, pz, hc + 4 + h, hc + 4 + h + r * 0.7, r, r * 0.66);
      }
    };
    const dome = (x, z, r, tint, glow) => {
      put('disc', x, hc, z, r * 1.08, 3, r * 1.08, 0, tint, glow, 0);
      put('dome', x, hc + 3, z, r, r * 0.8, r, 0, tint, glow, 0.25);
      cyl(x, z, hc, hc + 3, r * 1.08);
      col({ t: 3, x, z, y0: hc + 3, r, k: 0.8, R: r });
    };

    // --- Цитадель Совета: подиум, ярусы, четыре плавника, шпиль ~2 км
    {
      const [x, z] = SITES.citadel, T = [0.86, 0.87, 0.92], G = [0.45, 0.85, 1.3];
      put('disc', x, hc, z, 210, 42, 210, 0, [0.5, 0.52, 0.58], G, 0.3);
      cyl(x, z, hc, hc + 42, 210);
      put('prism', x, hc + 42, z, 125, 400, 125, 0, T, G, 1, 0.13);
      cyl(x, z, hc + 42, hc + 442, 118);
      put('taper', x, hc + 442, z, 118, 420, 118, 0, T, G, 1, 0.31);
      cyl(x, z, hc + 442, hc + 862, 112, 70);
      put('prism', x, hc + 862, z, 66, 480, 66, Math.PI / 6, T, G, 1, 0.57);
      cyl(x, z, hc + 862, hc + 1342, 63);
      put('spire', x, hc + 1342, z, 66, 760, 66, Math.PI / 6, T, G, 0, 0.77);
      cyl(x, z, hc + 1342, hc + 2100, 58, 4);
      for (let k = 0; k < 4; k++) {
        const a = (45 + 90 * k) * DEG, fx = x + Math.cos(a) * 190, fz = z + Math.sin(a) * 190, yaw = -a;
        put('blade', fx, hc + 42, fz, 160, 980, 16, yaw, T, G, 0.15);
        box(fx, fz, hc + 42, hc + 42 + 980 * 0.87, 80, 8, yaw);
      }
      for (const y of [hc + 300, hc + 700, hc + 1100]) {
        put('disc', x, y, z, y < hc + 800 ? 160 : 96, 5, y < hc + 800 ? 160 : 96, 0, T, [0.5, 0.95, 1.5], 0);
        cyl(x, z, y, y + 5, y < hc + 800 ? 160 : 96, y < hc + 800 ? 160 : 96, true);
      }
      // Парящие платформы вокруг: на каждой беседка-купол
      this.platforms = [];
      for (let k = 0; k < 6; k++) {
        const a = 60 * k * DEG, px = x + Math.cos(a) * 430, pz = z + Math.sin(a) * 430, py = hc + 170 + k * 75;
        put('disc', px, py, pz, 56, 7, 56, 0, [0.8, 0.82, 0.88], [0.4, 0.9, 1.4], 0);
        cyl(px, pz, py, py + 7, 56, 56, true);
        put('dome', px + 24, py + 7, pz, 12, 9, 12, 0, [0.85, 0.86, 0.9], G, 0.3);
        this.addCol({ t: 3, x: px + 24, z: pz, y0: py + 7, r: 12, k: 0.75, R: 12 });
        this.platforms.push([px, py + 7, pz]);
      }
    }

    // --- Зал Домов: двенадцать башен родов; башня дома Вэйр погашена
    for (const Hs of HOUSES) {
      const [x, z] = polar(775, Hs.a), H = 560 + rnd() * 300;
      const tint = Hs.veyr ? [0.16, 0.16, 0.19] : Hs.c.map((v) => 0.68 + v * 0.18);
      const parts = spireTower(x, z, 34, H, tint, Hs.veyr ? [0, 0, 0] : dim(Hs.c, 1.25), { rings: 2, win: Hs.veyr ? 0.4 : 1 });
      if (Hs.veyr) { this.veyrSlots = parts; this.veyrGlow = dim(Hs.c, 1.6); this.veyrTop = hc + H * 1.1; }
    }
    // Архив Домов — кристальная пирамида перед тёмной башней
    {
      const [x, z] = SITES.archive;
      put('pyr', x, hc, z, 46, 58, 46, 0, [0.72, 0.8, 0.9], [0.6, 0.9, 1.3], 0.5);
      for (let s = 0; s < 6; s++) box(x, z, hc + s * 9.5, hc + (s + 1) * 9.5, 46 * (1 - s / 6) * 0.7, 46 * (1 - s / 6) * 0.7, 0);
    }

    // --- Арена присяги: трибуны кольцом, в центре обсидиановый круг клятвы
    {
      const [x, z] = SITES.arena;
      put('arena', x, hc, z, 1, 1, 1, 0, [0.64, 0.64, 0.7], [1.2, 0.35, 0.2], 0);
      this.addCol({ t: 2, x, z, r0: 168, r1: 286, y0: hc, yIn: hc + 9, yOut: hc + 62, R: 286 });
      put('disc', x, hc, z, 58, 1.2, 58, 0, [0.03, 0.03, 0.04], [1.3, 0.3, 0.18], 0);
      cyl(x, z, hc, hc + 1.2, 58);
      for (let k = 0; k < 8; k++) {
        const a = k * Math.PI / 4, ox = x + Math.cos(a) * 300, oz = z + Math.sin(a) * 300;
        put('prism', ox, hc, oz, 7, 110, 7, a, [0.16, 0.16, 0.19], [1.2, 0.32, 0.2], 0);
        cyl(ox, oz, hc, hc + 110, 7);
      }
    }

    // --- Сады памяти: ряды стел; чёрная пустая стела Ксарга
    {
      const [gx, gz] = SITES.gardens;
      for (let ring = 0; ring < 7; ring++) {
        const rr = 60 + ring * 28, n = Math.floor(rr * 2 * Math.PI / 13);
        for (let k = 0; k < n; k++) {
          const a = k / n * Math.PI * 2 + ring * 0.2, x = gx + Math.cos(a) * rr, z = gz + Math.sin(a) * rr;
          if (Math.abs(Math.sin(a - 0.4)) < 0.08) continue;   // дорожка к центру
          const h = 6 + rnd() * 6;
          put('box', x, hc, z, 2.6, h, 0.8, -a + Math.PI / 2, [0.74, 0.76, 0.82], [0.5, 0.85, 1.2], 0, rnd());
          box(x, z, hc, hc + h, 1.3, 0.4, -a + Math.PI / 2);
        }
      }
      const [sx, sz] = SITES.xargStela;
      put('box', sx, hc, sz, 5.5, 26, 1.6, 0.3, [0.02, 0.02, 0.025], [0, 0, 0], 0);
      box(sx, sz, hc, hc + 26, 2.75, 0.8, 0.3);
      put('disc', gx, hc, gz, 24, 0.6, 24, 0, [0.5, 0.52, 0.58], [0.5, 0.85, 1.2], 0);
    }

    // --- Порт: площадки, корабли, нить орбитального лифта
    {
      const [x, z] = SITES.port, T = [0.55, 0.57, 0.63];
      put('disc', x, hc, z, 95, 14, 95, 0, T, [0.4, 0.9, 1.4], 0.2);
      cyl(x, z, hc, hc + 14, 95);
      put('tether', x, hc + 14, z, 5, 26000, 5, 0, [0.85, 0.9, 1], [0.6, 1, 1.6], 0);
      cyl(x, z, hc + 14, hc + 4200, 5);
      for (let k = 0; k < 5; k++) {
        const a = (k * 72 + 20) * DEG, px = x + Math.cos(a) * 250, pz = z + Math.sin(a) * 250;
        put('disc', px, hc, pz, 64, 6, 64, 0, T, [1.1, 0.55, 0.25], 0);
        cyl(px, pz, hc, hc + 6, 64);
        const yaw = rnd() * Math.PI * 2, len = 70 + rnd() * 40;
        put('ship', px, hc + 6, pz, len, len, len, yaw, [0.05, 0.055, 0.065], [1, 0.3, 0.1], 0);
        box(px, pz, hc + 6, hc + 6 + len * 0.18, len * 0.2, len * 0.48, yaw);
      }
    }

    // --- Разлом: жилища бескрылых на дне, ярусами по краям; площадь рынка посередине
    {
      const [ax, az] = RIFT.a, [bx, bz] = RIFT.b, ux = bx - ax, uz = bz - az, len = Math.hypot(ux, uz);
      const tx = ux / len, tz = uz / len, nx = -tz, nz = tx, yaw0 = Math.atan2(-tz, tx), fl = hc - RIFT.depth;
      this.market = [ax + ux * 0.5, az + uz * 0.5];
      const WARM = [[1.2, 0.55, 0.22], [1.1, 0.42, 0.16], [0.9, 0.6, 0.3]];
      for (let s = 40; s < len - 40; s += 13 + rnd() * 9) {
        if (Math.abs(s - len * 0.5) < 55) continue;
        for (const side of [-1, 1]) {
          for (let row = 0; row < 3; row++) {
            const off = side * (26 + row * 30 + rnd() * 10);
            if (Math.abs(off) > RIFT.half - 12 || rnd() < 0.18) continue;
            const x = ax + tx * s + nx * off, z = az + tz * s + nz * off;
            let y = fl;
            const stack = 1 + Math.floor(rnd() * (row === 2 ? 4 : 3));
            const w = 8 + rnd() * 9, d = 7 + rnd() * 6;
            begin();
            for (let k = 0; k < stack; k++) {
              const h = 5 + rnd() * 5, kk = 1 - k * 0.12;
              const tint = [0.36 + rnd() * 0.1, 0.32 + rnd() * 0.08, 0.29 + rnd() * 0.06];
              put('box', x, y, z, w * kk, h, d * kk, yaw0 + (rnd() - 0.5) * 0.3, tint, WARM[Math.floor(rnd() * 3)].map((v) => v * (rnd() < 0.5 ? 0.6 : 0)), 0.4);
              box(x, z, y, y + h, w * kk / 2, d * kk / 2, yaw0);
              y += h;
            }
            end();
          }
        }
      }
    }

    // --- Верфи: сорок кораблей флота. Восемь — в доках, недостроенные, под рёбрами каркаса и кранами;
    // тридцать два готовых стоят рядами на поле. Над стапелями — сварка (welds, искры — в update)
    this.welds = [];
    {
      const [yx, yz] = SITES.yards, ua = 120 * DEG, ux = Math.cos(ua), uz = Math.sin(ua), tx = -uz, tz = ux;
      const at = (u, t) => [yx + ux * u + tx * t, yz + uz * u + tz * t];
      const HULL = [0.06, 0.065, 0.075], STEEL = [0.5, 0.52, 0.58], ORANGE = [1.2, 0.55, 0.2];
      const yawU = Math.atan2(-ux, -uz);   // нос к городу
      for (let k = 0; k < 8; k++) {
        const t = -490 + k * 140, len = 210 + rnd() * 40, hw = len * 0.22 + 8;
        const [dx, dz] = at(0, t);
        // Дно дока и стенки
        put('box', dx, hc, dz, hw * 2 + 14, 0.8, 290, -ua + Math.PI / 2, [0.2, 0.21, 0.24], [0.4, 0.9, 1.4], 0);
        for (const s of [-1, 1]) {
          const [wx, wz] = at(0, t + s * (hw + 4));
          begin();
          put('box', wx, hc, wz, 6, 18, 290, -ua + Math.PI / 2, STEEL, ORANGE, 0.2);
          box(wx, wz, hc, hc + 18, 3, 145, -ua + Math.PI / 2);
          end();
        }
        put('ship', dx, hc + 4, dz, len, len, len, yawU, HULL, [1, 0.3, 0.1], 0);
        box(dx, dz, hc, hc + 4 + len * 0.18, len * 0.2, len * 0.46, yawU);
        // Каркас кормы: рёбра-арки над недостроенной половиной
        for (let q = 0; q < 5; q++) {
          const u = 15 + q * 22, [rx, rz] = at(u, t), top = hc + 40 + q * 2;
          begin();
          for (const s of [-1, 1]) {
            const [px, pz] = at(u, t + s * (hw - 6));
            put('box', px, hc, pz, 3, top - hc, 3, -ua, STEEL, ORANGE, 0);
            box(px, pz, hc, top, 1.5, 1.5, -ua);
          }
          put('box', rx, top, rz, 3, 3, hw * 2 - 9, -ua, STEEL, ORANGE, 0);
          box(rx, rz, top, top + 3, 1.5, hw - 4.5, -ua);
          end();
          for (let w = 0; w < 2; w++) {
            const [wx, wz] = at(u, t + (rnd() - 0.5) * hw * 1.4);
            this.welds.push([wx, top - 2 - rnd() * 24, wz]);
          }
        }
        // Козловой кран над доком: две ноги, балка, тележка с грузом
        begin();
        const cu = -40 - rnd() * 40, ch = 120 + rnd() * 30;
        for (const s of [-1, 1]) {
          const [cx, cz] = at(cu, t + s * (hw + 16));
          put('box', cx, hc, cz, 7, ch, 7, -ua, [0.62, 0.46, 0.2], ORANGE, 0);
          box(cx, cz, hc, hc + ch, 3.5, 3.5, -ua);
        }
        const [bx, bz] = at(cu, t);
        put('box', bx, hc + ch, bz, 9, 8, hw * 2 + 40, -ua, [0.62, 0.46, 0.2], ORANGE, 0);
        box(bx, bz, hc + ch, hc + ch + 8, 4.5, hw + 20, -ua);
        const [gx, gz] = at(cu, t + (rnd() - 0.5) * hw);
        put('box', gx, hc + ch - 36, gz, 12, 30, 12, -ua, [0.3, 0.3, 0.34], ORANGE, 0);
        end();
      }
      // Готовые корабли рядами по обе стороны доков
      for (const u of [-420, 420]) for (let k = 0; k < 16; k++) {
        const [sx, sz] = at(u + (rnd() - 0.5) * 30, -540 + k * 72), len = 95 + rnd() * 35;
        put('disc', sx, hc, sz, len * 0.32, 1.5, len * 0.32, 0, [0.3, 0.31, 0.35], [1.1, 0.55, 0.25], 0);
        put('ship', sx, hc + 3, sz, len, len, len, yawU + (rnd() - 0.5) * 0.08, HULL, [1, 0.3, 0.1], 0);
        box(sx, sz, hc, hc + 3 + len * 0.18, len * 0.2, len * 0.46, yawU);
      }
    }

    // --- Скайвей: кольцо монорельса на опорах над поясом куполов (поезда — в SkyTraffic)
    {
      const rr = SKYWAY.r, y = hc + SKYWAY.h, n = Math.round(2 * Math.PI * rr / 110), seg = 2 * Math.PI * rr / n + 0.6;
      for (let k = 0; k < n; k++) {
        const a = k / n * Math.PI * 2, x = CX + Math.cos(a) * rr, z = CZ + Math.sin(a) * rr;
        // Над Разломом — пролёт без опор
        if (riftDist(x, z).d > RIFT.half + RIFT.wall + 12) {
          begin();
          put('prism', x, hc, z, 3.4, SKYWAY.h - 2.4, 3.4, 0, [0.6, 0.62, 0.68], [0.4, 0.9, 1.4], 0);
          cyl(x, z, hc, y - 2.4, 3.4);
          end();
        }
        const a2 = (k + 0.5) / n * Math.PI * 2, mx = CX + Math.cos(a2) * rr, mz = CZ + Math.sin(a2) * rr;
        put('box', mx, y - 2.4, mz, 11, 2.4, seg, -a2, [0.55, 0.57, 0.63], [0.4, 0.9, 1.4], 0);
        box(mx, mz, y - 2.4, y, 5.5, seg / 2, -a2);
      }
    }

    // --- Парящие острова: скалы на антигравах над городом, сверху сад, беседка и игла
    this.isles = [];
    for (let k = 0; k < 7; k++) {
      const a = (k * 51 + 17) * DEG, rr = 2350 + (k % 3) * 620 + rnd() * 180, R = 55 + rnd() * 55;
      const x = CX + Math.cos(a) * rr, z = CZ + Math.sin(a) * rr, y = hc + 300 + rnd() * 170;
      put('isle', x, y, z, R, R * 1.3, R, rnd() * 6.28, [0.3, 0.26, 0.24], [0, 0, 0], 0);
      cyl(x, z, y - R * 1.3, y, R * 0.05, R);
      // Кольцо антиграва под остриём
      put('disc', x, y - R * 0.95, z, R * 0.3, 1.6, R * 0.3, 0, [0.2, 0.22, 0.26], [0.4, 1.1, 1.6], 0);
      put('disc', x, y, z, R * 1.02, 3, R * 1.02, 0, [0.24, 0.36, 0.27], [0.3, 1.0, 0.7], 0);
      cyl(x, z, y, y + 3, R * 1.02, R * 1.02, true);
      put('dome', x + R * 0.35, y + 3, z, R * 0.24, R * 0.2, R * 0.24, 0, [0.85, 0.86, 0.9], [0.4, 0.9, 1.4], 0.3);
      this.addCol({ t: 3, x: x + R * 0.35, z, y0: y + 3, r: R * 0.24, k: 0.83, R: R * 0.24 });
      const sx = x - R * 0.3, sz = z + R * 0.25, sh = R * 0.9;
      put('prism', sx, y + 3, sz, R * 0.08, sh, R * 0.08, 0, [0.85, 0.86, 0.9], [0.4, 0.9, 1.4], 1);
      put('spire', sx, y + 3 + sh, sz, R * 0.08, R * 0.5, R * 0.08, 0, [0.85, 0.86, 0.9], [0.4, 0.9, 1.4], 0);
      cyl(sx, sz, y + 3, y + 3 + sh, R * 0.08);
      this.isles.push([x, y + 3, z, R]);
    }

    // --- Кварталы: Высокий город, пояс террас, пояс куполов, внешний пояс сот
    const sites = [[SITES.arena, 345], [SITES.gardens, 290], [SITES.port, 430], [SITES.archive, 80], [SITES.yards, 900]];
    for (const [x, , z, R] of this.isles) sites.push([[x, z], R * 0.9]);
    const free = (x, z, fp) => {
      const dx = x - CX, dz = z - CZ, r = Math.hypot(dx, dz);
      if (r < 985 + fp || r > R_CITY - 150) return false;
      for (const a of AVENUES) {
        const along = dx * Math.cos(a) + dz * Math.sin(a), perp = Math.abs(-dx * Math.sin(a) + dz * Math.cos(a));
        if (along > 0 && perp < AV_W + 8 + fp) return false;
      }
      for (const rr of RINGS) if (Math.abs(r - rr) < RING_W + 8 + fp) return false;
      if (Math.abs(r - SKYWAY.r) < 16 + fp) return false;
      for (const [[sx, sz], sr] of sites) if (Math.hypot(x - sx, z - sz) < sr + fp) return false;
      return riftDist(x, z).d > RIFT.half + RIFT.wall + 40 + fp;
    };
    const STEP = 62;
    for (let gz = CZ - R_CITY; gz < CZ + R_CITY; gz += STEP) {
      for (let gx = CX - R_CITY; gx < CX + R_CITY; gx += STEP) {
        const x = gx + (rnd() - 0.5) * STEP * 0.5, z = gz + (rnd() - 0.5) * STEP * 0.5;
        const r = Math.hypot(x - CX, z - CZ), u = rnd();
        if (r < 1860) {
          // Высокий город: иглы и лезвия, выше к центру
          const fp = 14 + rnd() * 12;
          if (u > 0.6 || !free(x, z, fp)) continue;
          const H = (180 + rnd() * 300) * (1.25 - (r - 985) / 875 * 0.55);
          begin();
          if (rnd() < 0.72) spireTower(x, z, fp, H, pale(), glowC());
          else bladeTower(x, z, fp * 2.6, fp * 0.75, H * 0.8, pale(), glowC());
          end();
        } else if (r < 2960) {
          const fp = 12 + rnd() * 12;
          if (u > 0.52 || !free(x, z, fp)) continue;
          const v = rnd();
          begin();
          if (v < 0.32) spireTower(x, z, fp * 0.85, 70 + rnd() * 150, pale(), glowC());
          else if (v < 0.75) terrace(x, z, fp * 2.2, fp * 1.7, 30 + rnd() * 60, pale(), glowC());
          else bladeTower(x, z, fp * 2.4, fp * 0.7, 80 + rnd() * 90, pale(), glowC());
          end();
        } else if (r < 4330) {
          const fp = 10 + rnd() * 14;
          if (u > 0.5 || !free(x, z, fp)) continue;
          const v = rnd();
          begin();
          if (v < 0.42) dome(x, z, fp, pale(), glowC());
          else if (v < 0.88) terrace(x, z, fp * 2, fp * 1.6, 14 + rnd() * 30, pale(), glowC(), 0.6);
          else spireTower(x, z, fp * 0.7, 50 + rnd() * 50, pale(), glowC(), { rings: 0 });
          end();
        } else {
          // Внешний пояс: новые кварталы-соты (башни на общем подиуме), террасы и сады-купола; к краю реже
          const edge = smooth(R_CITY - 150, R_CITY - 1300, r), fp = 16 + rnd() * 22;
          if (u > 0.42 * edge || !free(x, z, fp)) continue;
          const v = rnd();
          begin();
          if (v < 0.45) hive(x, z, fp, 40 + rnd() * 90 * edge, pale(), glowC());
          else if (v < 0.75) terrace(x, z, fp * 1.8, fp * 1.4, 16 + rnd() * 36, pale(), glowC(), 0.7);
          else dome(x, z, fp * 0.8, pale(), rnd() < 0.5 ? [0.3, 1.0, 0.6] : glowC());
          end();
        }
      }
    }

    // --- Меши
    const mats = { std: buildingMaterial(this.U, false), rim: buildingMaterial(this.U, true) };
    this.meshes = {};
    this.free = {};   // запасные места под падающие верхушки: вид → номера
    for (const [kind, list] of Object.entries(L)) {
      const n = list.length, sp = SPARE[kind] || 0, mesh = new THREE.InstancedMesh(kinds[kind], kind === 'disc' ? mats.rim : mats.std, n + sp);
      const glow = new Float32Array((n + sp) * 3), info = new Float32Array((n + sp) * 2), col = new Float32Array((n + sp) * 3);
      list.forEach((e, i) => {
        mesh.setMatrixAt(i, e.m);
        col.set(e.tint, i * 3); glow.set(e.glow, i * 3);
        info[i * 2] = e.win; info[i * 2 + 1] = e.seed;
      });
      this.free[kind] = [];
      for (let i = n; i < n + sp; i++) { mesh.setMatrixAt(i, ZERO); this.free[kind].push(i); }
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(col, 3);
      mesh.geometry = mesh.geometry.clone();
      mesh.geometry.setAttribute('aGlow', new THREE.InstancedBufferAttribute(glow, 3));
      mesh.geometry.setAttribute('aInfo', new THREE.InstancedBufferAttribute(info, 2));
      mesh.frustumCulled = false;
      mesh.castShadow = kind !== 'tether';
      mesh.receiveShadow = true;
      this.root.add(mesh);
      this.meshes[kind] = mesh;
    }
    this.count = Object.values(L).reduce((s, l) => s + l.length, 0);
    this.traffic = new SkyTraffic(this, mulberry32(99));
    this.setVeyr(this.veyrLit);
  }

  // Башня дома Вэйр: зажечь (глава дома вернулся) или погасить
  setVeyr(on) {
    this.veyrLit = on;
    if (!this.built) return;
    for (const { kind, i } of this.veyrSlots) {
      const m = this.meshes[kind], g = m.geometry.attributes.aGlow, c = m.instanceColor;
      const glow = on ? this.veyrGlow : [0, 0, 0];
      g.setXYZ(i, ...glow); g.needsUpdate = true;
      c.setXYZ(i, ...(on ? [0.82, 0.8, 0.78] : [0.16, 0.16, 0.19])); c.needsUpdate = true;
    }
  }

  addCol(c) {
    this.cols.push(c);
    const id = this.cols.length - 1;
    const i0 = Math.floor((c.x - c.R - G0X) / GRID), i1 = Math.floor((c.x + c.R - G0X) / GRID);
    const j0 = Math.floor((c.z - c.R - G0Z) / GRID), j1 = Math.floor((c.z + c.R - G0Z) / GRID);
    for (let j = Math.max(0, j0); j <= Math.min(GN - 1, j1); j++) for (let i = Math.max(0, i0); i <= Math.min(GN - 1, i1); i++) {
      const k = j * GN + i;
      let a = this.grid.get(k);
      if (!a) this.grid.set(k, a = []);
      a.push(id);
    }
    if (c.y1 !== undefined) this.top = Math.max(this.top || 0, c.y1);
    return id;
  }

  cell(x, z) {
    const i = Math.floor((x - G0X) / GRID), j = Math.floor((z - G0Z) / GRID);
    return i < 0 || j < 0 || i >= GN || j >= GN ? null : this.grid.get(j * GN + i);
  }

  // Крыша под точкой (кадр города): высота верха, если он не выше y + step; solidOnly — только нерушимые
  roofAt(x, z, y, solidOnly = false) {
    const a = this.cell(x, z);
    let best = -Infinity;
    if (!a) return best;
    for (const id of a) {
      if (this.cols[id].dead || (solidOnly && this.colB[id])) continue;
      const t = this.topAt(this.cols[id], x, z);
      if (t > best && t <= y + 1.6) best = t;
    }
    return best;
  }

  topAt(c, x, z) {
    const dx = x - c.x, dz = z - c.z;
    if (c.t === 0) {
      const d = Math.hypot(dx, dz);
      if (d > c.rB && d > c.rT) return -Infinity;
      if (c.rT >= c.rB) return d <= c.rB ? c.y1 : -Infinity;
      // Сужение: верх там, где радиус сечения равен d
      return d <= c.rT ? c.y1 : c.y0 + (c.y1 - c.y0) * (c.rB - d) / (c.rB - c.rT);
    }
    if (c.t === 1) {
      const lx = dx * c.c - dz * c.s, lz = dx * c.s + dz * c.c;
      return Math.abs(lx) <= c.hx && Math.abs(lz) <= c.hz ? c.y1 : -Infinity;
    }
    if (c.t === 2) {
      const d = Math.hypot(dx, dz);
      return d < c.r0 || d > c.r1 ? -Infinity : Math.min(c.yOut, c.yIn + (c.yOut - c.yIn) * (d - c.r0) / (c.r1 - c.r0 - 8));
    }
    const d = Math.hypot(dx, dz) / c.r;
    return d >= 1 ? -Infinity : c.y0 + c.r * c.k * Math.sqrt(1 - d * d);
  }

  // Шар (центр p, радиус R) против тела: глубина проникновения (>0) и нормаль в _n
  pen(c, p, R) {
    const dx = p.x - c.x, dz = p.z - c.z;
    if (c.t === 0) {
      const d = Math.hypot(dx, dz), h = c.y1 - c.y0;
      const yy = Math.min(c.y1, Math.max(c.y0, p.y));
      const rr = c.rB + (c.rT - c.rB) * (yy - c.y0) / h;
      if (d < rr && p.y >= c.y0 && p.y <= c.y1) {
        const side = rr - d, top = c.y1 - p.y, bot = p.y - c.y0;
        if (top < side && top <= bot) { _n.set(0, 1, 0); return top + R; }
        if (bot < side && c.fl) { _n.set(0, -1, 0); return bot + R; }
        _n.set(dx, 0, dz).normalize(); return side + R;
      }
      const cx = d > rr ? dx / d * rr : dx, cz = d > rr ? dz / d * rr : dz;
      _n.set(dx - cx, p.y - yy, dz - cz);
      const l = _n.length();
      if (l >= R || l < 1e-6) return 0;
      _n.divideScalar(l);
      return R - l;
    }
    if (c.t === 1) {
      const lx = dx * c.c - dz * c.s, lz = dx * c.s + dz * c.c;
      const qx = Math.max(-c.hx, Math.min(c.hx, lx)), qz = Math.max(-c.hz, Math.min(c.hz, lz)), qy = Math.max(c.y0, Math.min(c.y1, p.y));
      let ex = lx - qx, ey = p.y - qy, ez = lz - qz, l = Math.hypot(ex, ey, ez), depth;
      if (l < 1e-6) {
        const px = c.hx - Math.abs(lx), pz = c.hz - Math.abs(lz), py = c.y1 - p.y;
        if (py < px && py < pz) { ex = 0; ey = 1; ez = 0; depth = py + R; }
        else if (px < pz) { ex = Math.sign(lx); ey = 0; ez = 0; depth = px + R; }
        else { ex = 0; ey = 0; ez = Math.sign(lz); depth = pz + R; }
      } else {
        if (l >= R) return 0;
        ex /= l; ey /= l; ez /= l; depth = R - l;
      }
      // Обратно из ящика в мир: lx = x·c − z·s, lz = x·s + z·c
      _n.set(ex * c.c + ez * c.s, ey, -ex * c.s + ez * c.c);
      return depth;
    }
    if (c.t === 2) {
      const d = Math.hypot(dx, dz);
      if (d > c.r1 + R || d < c.r0 - R) return 0;
      const top = d < c.r0 ? c.yIn : d > c.r1 ? c.yOut : this.topAt(c, p.x, p.z);
      if (p.y - R > top || p.y < c.y0) return 0;
      if (d > c.r1 - 4) { _n.set(dx, 0, dz).normalize(); return c.r1 + R - d; }
      if (d < c.r0 + 2 && p.y < c.yIn) { _n.set(-dx, 0, -dz).normalize(); return d - c.r0 + R; }
      _n.set(0, 1, 0);
      return top - p.y + R;
    }
    // Купол: шар (сплюснутый по высоте) — от центра основания
    const ky = c.k, ey = (p.y - c.y0) / ky, l = Math.hypot(dx, ey, dz);
    if (p.y < c.y0 - R || l >= c.r + R || l < 1e-6) return 0;
    _n.set(dx, ey, dz).divideScalar(l);
    return c.r + R - l;
  }

  // ---------------------------------------------------------------- кадр
  // Какая копия города ближе к камере (смена — с запасом, чтобы не дёргалась на границе)
  place(O, cam) {
    const lx = cam.x - O.x - CX - this.shift.x * BIG_P, lz = cam.z - O.z - CZ - this.shift.y * BIG_P;
    if (Math.abs(lx) > BIG_P / 2 + 300) this.shift.x += Math.sign(lx);
    if (Math.abs(lz) > BIG_P / 2 + 300) this.shift.y += Math.sign(lz);
    this.root.position.set(O.x + this.shift.x * BIG_P, O.y, O.z + this.shift.y * BIG_P);
    this.U.uCamC.value.set(cam.x - this.root.position.x, cam.z - this.root.position.z);
  }

  // Точка мира → кадр города и обратно
  toCity(p, out) { return out.copy(p).sub(this.root.position); }
  toWorld(p, out) { return out.copy(p).add(this.root.position); }

  // Герой против зданий: путь центра за кадр; на первом касании — выталкиваем и гасим скорость внутрь
  collide(hero, p0, R, ramSpeed) {
    if (!this.built) return false;
    const q1 = this.toCity(hero.pos, _c), q0 = this.toCity(p0, _o);
    q1.y += 1; q0.y += 1;
    if (Math.min(q0.y, q1.y) > this.top + R) return false;
    const len = q0.distanceTo(q1), n = Math.min(500, Math.max(1, Math.ceil(len / 2)));
    for (let s = 1; s <= n; s++) {
      _p.lerpVectors(q0, q1, s / n);
      const a = this.cell(_p.x, _p.z);
      if (!a) continue;
      let hit = false;
      for (const id of a) {
        const c = this.cols[id];
        if (c.dead) continue;
        const depth = this.pen(c, _p, R);
        if (depth <= 0) continue;
        const vn = hero.vel.dot(_n), b = this.colB[id];
        // Обычный дом на скорости тарана — насквозь: срез у героя, верх валится по ходу; сверху — давим вниз
        if (b && -vn > ramSpeed) { this.ram(b, _p, hero.vel, _n.y > 0.7); continue; }
        hit = true;
        _p.addScaledVector(_n, depth);
        if (vn < 0) {
          const sp = hero.vel.length();
          hero.vel.addScaledVector(_n, -vn);
          if (-vn > ramSpeed) {
            // Звёздный кристал не ломается: удар, вспышка, герой теряет почти всю скорость
            hero.vel.multiplyScalar(0.15);
            this.toWorld(_p, _s).addScaledVector(_n, -R);
            const W = this.world;
            W.effects.flash(_s.clone(), 22);
            W.effects.shockwave(_s.clone(), { type: 'disc', dir: _n.clone(), radius: 12 + Math.min(60, sp * 0.03), life: 0.5, opacity: 0.7, color: 0xbfe6ff });
            W.sparks.burst(_s.clone(), 30, { size: [0.4, 1.4], speed: 35, life: [0.2, 0.7], color: 0x9fdcff });
            W.audio?.punch(1);
            W.effects.impactFX?.(0.35, _s.clone(), 0.1, 2);
          }
        }
      }
      if (hit) {
        _p.y -= 1;
        this.toWorld(_p, hero.pos);
        return true;
      }
    }
    return false;
  }

  update(dt, hero) {
    if (!this.built) return;
    const h = this.toCity(hero.pos, _c);
    this.traffic.update(dt, h);
    this.updateChunks(dt);
    // Сварка на стапелях: вспышки искр, если герой ближе 2,5 км к верфям
    const [yx, yz] = SITES.yards;
    if (Math.hypot(h.x - yx, h.z - yz) < 2500 && (this.weldT -= dt) <= 0) {
      this.weldT = 0.05 + Math.random() * 0.12;
      const w = this.welds[Math.floor(Math.random() * this.welds.length)];
      const p = this.toWorld(_g.set(w[0], w[1], w[2]), new THREE.Vector3());
      this.world.sparks?.burst(p, 10 + Math.floor(Math.random() * 12), { size: [0.25, 0.8], speed: 9, life: [0.3, 1.1], color: Math.random() < 0.6 ? 0xbfe6ff : 0xffc070 });
    }
  }

  // ---------------------------------------------------------------- разрушение
  // Цитадель, Зал Домов, Арена, Архив и Порт — из звёздного кристалла, остальное ломается

  // Таран: p — точка пути в кадре города, vel — скорость героя (немного гасим)
  ram(b, p, vel, dive) {
    _d.set(vel.x, 0, vel.z);
    if (_d.lengthSq() < 1e-6) _d.set(p.x - b.x, 0, p.z - b.z);
    if (_d.lengthSq() < 1e-6) _d.set(1, 0, 0);
    _d.normalize();
    this.breakAt(b, dive ? p.y - 9 : p.y - 3, _d, Math.min(90, vel.length() * 0.1), dive);
    vel.multiplyScalar(dive ? 0.97 : 0.9);
  }

  // Удар в точке мира pw радиусом r: урон домам в шаре; кончилась прочность — срез у места удара,
  // верх валится по dir (без dir — от центра удара). Возвращает, задели ли хоть что-то
  strike(pw, r, dmg, dir) {
    if (!this.built) return false;
    const q = this.toCity(pw, new THREE.Vector3()), hitB = new Set(), seen = new Set();
    let hit = false;
    const i0 = Math.floor((q.x - r - G0X) / GRID), i1 = Math.floor((q.x + r - G0X) / GRID);
    const j0 = Math.floor((q.z - r - G0Z) / GRID), j1 = Math.floor((q.z + r - G0Z) / GRID);
    for (let j = Math.max(0, j0); j <= Math.min(GN - 1, j1); j++) for (let i = Math.max(0, i0); i <= Math.min(GN - 1, i1); i++) {
      const a = this.grid.get(j * GN + i);
      if (!a) continue;
      for (const id of a) {
        if (seen.has(id)) continue;
        seen.add(id);
        const c = this.cols[id];
        if (c.dead || this.pen(c, q, r) <= 0) continue;
        hit = true;
        const b = this.colB[id];
        if (b) hitB.add(b);
      }
    }
    for (const b of hitB) {
      b.hp -= dmg;
      if (b.hp > 0) continue;
      if (dir) _d.set(dir.x, 0, dir.z); else _d.set(b.x - q.x, 0, b.z - q.z);
      if (_d.lengthSq() < 1e-6) _d.set(1, 0, 0);
      this.breakAt(b, q.y - Math.min(r * 0.5, 8), _d.normalize(), Math.min(90, dmg * 0.06), false);
    }
    return hit;
  }

  // Срез дома на высоте yc: ниже остаётся пень, выше — верхушка (части целиком или срезанный верх
  // в запасном месте) валится по dir и разлетается глыбами. crush — давим сверху: рассыпается сразу
  breakAt(b, yc, dir, push = 0, crush = false) {
    if (yc < b.y0 + 3) yc = b.y0;
    if (yc >= b.cut - 0.5) return false;
    const items = [];
    let hTop = 0;
    for (const p of b.parts) {
      const top = p.y0 + p.hc, mesh = this.meshes[p.kind];
      if (p.gone || top <= yc) continue;
      if (p.y0 >= yc - 0.01 || WHOLE[p.kind] || yc <= b.y0) {
        const m0 = new THREE.Matrix4();
        mesh.getMatrixAt(p.i, m0);
        items.push({ kind: p.kind, i: p.i, m0, own: false });
        p.gone = true;
      } else {
        // Пень — та же часть ниже среза; верх — в запасное место, шириной как сечение на срезе
        p.m.decompose(_h, _q2, _s2);
        const f = 1 + ((TOP_R[p.kind] ?? 1) - 1) * (yc - p.y0) / p.h;
        mesh.setMatrixAt(p.i, _m2.compose(_h, _q2, _e.set(_s2.x, yc - p.y0, _s2.z)));
        const s = this.free[p.kind]?.pop();
        if (s !== undefined) {
          _m2.compose(_e.set(_h.x, yc, _h.z), _q2, _f.set(_s2.x * f, top - yc, _s2.z * f));
          mesh.setMatrixAt(s, _m2);
          const g = mesh.geometry.attributes, ci = mesh.instanceColor;
          ci.setXYZ(s, ci.getX(p.i), ci.getY(p.i), ci.getZ(p.i)); ci.needsUpdate = true;
          g.aGlow.setXYZ(s, g.aGlow.getX(p.i), g.aGlow.getY(p.i), g.aGlow.getZ(p.i)); g.aGlow.needsUpdate = true;
          g.aInfo.setXY(s, g.aInfo.getX(p.i), g.aInfo.getY(p.i)); g.aInfo.needsUpdate = true;
          items.push({ kind: p.kind, i: s, m0: _m2.clone(), own: true });
        }
        p.hc = yc - p.y0;
      }
      hTop = Math.max(hTop, top - yc);
      mesh.instanceMatrix.needsUpdate = true;
    }
    if (!items.length) return false;
    // Тела: выше среза — нет, на срезе — укорочены; купола и тонкие венцы — целиком
    for (const id of b.cols) {
      const c = this.cols[id];
      if (c.dead) continue;
      if (c.t === 3 || c.fl) { if (yc < (c.y1 ?? c.y0 + c.r * c.k)) c.dead = true; continue; }
      if (c.y0 >= yc - 0.01) { c.dead = true; continue; }
      if (c.y1 > yc) {
        if (c.t === 0) c.rT = c.rB + (c.rT - c.rB) * (yc - c.y0) / (c.y1 - c.y0);
        c.y1 = yc;
      }
    }
    b.cut = yc;
    b.hp = 60 + b.r * (yc - b.y0) * 0.12;
    const W = this.world;
    if (!b.broken) { b.broken = true; this.wrecked++; if (W.city) W.city.destroyed++; }
    const ch = {
      items, h: hTop, r: b.r, rift: b.rift, t: 0, th: 0, w: 0.06 + push * 0.004,
      pivot: new THREE.Vector3(b.x + dir.x * b.r * 0.8, yc, b.z + dir.z * b.r * 0.8),
      axis: new THREE.Vector3(dir.z, 0, -dir.x), dir: dir.clone(),
      off: new THREE.Vector3(), vel: dir.clone().multiplyScalar(push * 0.15),
      life: Math.min(3.4, 1.0 + Math.sqrt(hTop) * 0.1),
    };
    // Срез: пыль кольцом, искры кристалла, треск
    const e = this.toWorld(_e.set(b.x, yc, b.z), new THREE.Vector3());
    W.dust?.burst(e, Math.round(8 + b.r * 0.5), { size: [b.r * 0.4, b.r * 1.1], speed: 10 + b.r * 0.4, life: [2, 4.5], flat: true, color: b.rift ? 0x8a7e72 : 0xc6ccd8 });
    W.sparks?.burst(e.clone(), 24, { size: [0.4, 1.3], speed: 30, life: [0.2, 0.7], color: b.rift ? 0xffc890 : 0x9fdcff });
    W.audio?.crumble(Math.min(1, 0.45 + b.r / 40), 'concrete', e.clone());
    if (!b.rift) W.audio?.glass(0.5, e.clone());
    if (crush) this.shatter(ch);
    else {
      this.chunks.push(ch);
      if (this.chunks.length > 14) this.shatter(this.chunks.shift());
    }
    return true;
  }

  // Верхушка клонится вокруг кромки среза (всё быстрее), сползает и падает; легла — рассыпается
  updateChunks(dt) {
    for (let k = this.chunks.length - 1; k >= 0; k--) {
      const ch = this.chunks[k];
      ch.t += dt;
      ch.w += (0.3 + 1.6 * Math.sin(Math.min(1.5, ch.th + 0.06))) * dt;
      ch.th = Math.min(1.5, ch.th + ch.w * dt);
      ch.vel.y -= CHUNK_G * dt * (0.2 + 0.8 * smooth(0.15, 0.9, ch.th));
      ch.off.addScaledVector(ch.vel, dt);
      this.chunkMatrix(ch);
      for (const it of ch.items) {
        const m = this.meshes[it.kind];
        m.setMatrixAt(it.i, _m4.multiplyMatrices(_m3, it.m0));
        m.instanceMatrix.needsUpdate = true;
      }
      if (ch.t >= ch.life || ch.th >= 1.45) { this.chunks.splice(k, 1); this.shatter(ch); }
    }
  }

  // Поворот верхушки: _m3 = T(кромка + сдвиг) · R(ось, θ) · T(−кромка)
  chunkMatrix(ch) {
    const P = ch.pivot, o = ch.off;
    _m3.makeTranslation(P.x + o.x, P.y + o.y, P.z + o.z);
    _m3.multiply(_m2.makeRotationFromQuaternion(_q2.setFromAxisAngle(ch.axis, ch.th)));
    _m3.multiply(_m2.makeTranslation(-P.x, -P.y, -P.z));
  }

  // Верхушка рассыпается: глыбы светлого кристалла (в Разломе — бурого камня), пыль, грохот
  shatter(ch) {
    const W = this.world, R = W.rocks, old = R?.stone;
    if (R) R.stone = ch.rift ? RIFT_STONE : CRYSTAL;
    this.chunkMatrix(ch);
    const per = Math.max(1, Math.ceil(Math.min(90, 8 + ch.h * 0.35) / ch.items.length));
    const spin = ch.w * ch.h * 0.4;
    let mid = null;
    for (const it of ch.items) {
      const mesh = this.meshes[it.kind];
      _m4.multiplyMatrices(_m3, it.m0).decompose(_h, _q2, _s2);
      const n = Math.min(per, 1 + Math.round(_s2.y / 6));
      const sz = Math.min(16, Math.max(2, Math.min(_s2.x, _s2.z) * 0.9));
      for (let j = 0; j < n && R; j++) {
        _f.set((Math.random() - 0.5) * 0.9, (j + Math.random()) / n, (Math.random() - 0.5) * 0.9).applyMatrix4(_m4);
        this.toWorld(_f, _g);
        const a = Math.random() * 6.28, out = 3 + Math.random() * 9;
        R.spawn(_g.x, _g.y, _g.z, sz * (0.45 + Math.random() * 0.6),
          ch.vel.x + ch.dir.x * spin * Math.random() + Math.cos(a) * out, ch.vel.y + Math.random() * 6,
          ch.vel.z + ch.dir.z * spin * Math.random() + Math.sin(a) * out);
      }
      if (!mid) mid = this.toWorld(_f.set(0, 0.5, 0).applyMatrix4(_m4), new THREE.Vector3());
      mesh.setMatrixAt(it.i, ZERO);
      mesh.instanceMatrix.needsUpdate = true;
      if (it.own) this.free[it.kind].push(it.i);
    }
    if (R) R.stone = old;
    if (!mid) return;
    W.impact?.(mid, 30 + ch.h * 0.3, 20);
    W.dust?.burst(mid, Math.round(12 + Math.min(40, ch.h * 0.15)), { size: [6 + ch.r * 0.3, 14 + ch.r * 0.7], speed: 12 + ch.r * 0.3, life: [3, 6], color: ch.rift ? 0x8a7e72 : 0xc6ccd8, gravity: 0.5 });
    W.audio?.crumble(Math.min(1, 0.5 + ch.h / 200), 'concrete', mid.clone());
    W.audio?.boom(Math.min(0.8, 0.25 + ch.h / 400), mid.clone());
  }

  // Город как был: пни, тела, верхушки (вход на карту и K)
  repair() {
    if (!this.built) return;
    for (const ch of this.chunks) for (const it of ch.items) {
      this.meshes[it.kind].setMatrixAt(it.i, ZERO);
      if (it.own) this.free[it.kind].push(it.i);
    }
    this.chunks.length = 0;
    for (const b of this.blds) {
      if (b.cut === Infinity) continue;
      for (const p of b.parts) { this.meshes[p.kind].setMatrixAt(p.i, p.m); p.gone = false; p.hc = p.h; }
      b.cols.forEach((id, k) => { this.cols[id] = { ...b.orig[k] }; });
      b.cut = Infinity; b.hp = b.hp0; b.broken = false;
    }
    this.wrecked = 0;
    for (const m of Object.values(this.meshes)) m.instanceMatrix.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- воздушные коридоры
// Аэрокары по кольцам над бульварами и вдоль лучей-проспектов, в два яруса и в обе стороны.
// На героя не налетают: рядом с ним поднимаются или опускаются.
class SkyTraffic {
  constructor(city, rnd) {
    this.city = city;
    const hc = city.hC, lanes = [];
    for (const rr of RINGS) for (const [alt, dir] of [[110, 1], [128, -1], [205, 1], [223, -1]]) lanes.push({ ring: rr + dir * 14, alt: hc + alt, dir, len: 2 * Math.PI * rr });
    for (const a of AVENUES) for (const [alt, dir] of [[150, 1], [250, -1]]) lanes.push({ a, alt: hc + alt, dir, r0: 700, len: 5400 });
    const total = lanes.reduce((s, l) => s + l.len, 0), N = this.N = 640;
    this.cars = [];
    for (const l of lanes) {
      const n = Math.round(N * l.len / total);
      for (let k = 0; k < n; k++) this.cars.push({ l, s: rnd() * l.len, v: 55 + rnd() * 70, big: rnd() < 0.14, dy: 0, c: rnd() });
    }
    const hullMat = new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.6, envMapIntensity: 0 });
    hullMat.onBeforeCompile = (s) => curvePatch(s, city.U);
    const lightMat = new THREE.MeshBasicMaterial({ toneMapped: false });
    lightMat.onBeforeCompile = (s) => curvePatch(s, city.U);
    const n = this.cars.length;
    this.hull = new THREE.InstancedMesh(craftGeo(), hullMat, n);
    this.lights = new THREE.InstancedMesh(craftLightsGeo(), lightMat, n);
    const HULL = [[0.85, 0.86, 0.9], [0.1, 0.1, 0.12], [0.55, 0.6, 0.7], [0.75, 0.2, 0.15]];
    this.cars.forEach((c, i) => {
      this.hull.setColorAt(i, new THREE.Color().setRGB(...HULL[Math.floor(c.c * 3.99)]));
      this.lights.setColorAt(i, new THREE.Color().setRGB(...(c.big ? [2.2, 0.9, 0.35] : [0.5, 1.6, 2.4])));
    });
    for (const m of [this.hull, this.lights]) {
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      city.root.add(m);
    }
    this.hull.castShadow = true;
    // Поезда скайвея: по кольцу в обе стороны, по своей колее; вагоны с полосой окон
    this.trains = [];
    for (let k = 0; k < 8; k++) this.trains.push({ s: k / 8 + rnd() * 0.05, dir: k % 2 ? 1 : -1, v: 75 + rnd() * 25 });
    const cars = this.trains.length * TRAIN_CARS;
    this.cars2 = new THREE.InstancedMesh(new THREE.BoxGeometry(4.2, 3.6, 21).translate(0, 1.8, 0), hullMat, cars);
    this.win2 = new THREE.InstancedMesh(new THREE.BoxGeometry(4.3, 0.7, 19.5).translate(0, 2.3, 0), lightMat, cars);
    for (let i = 0; i < cars; i++) {
      this.cars2.setColorAt(i, new THREE.Color().setRGB(0.88, 0.9, 0.95));
      this.win2.setColorAt(i, new THREE.Color().setRGB(0.6, 1.5, 2.2));
    }
    for (const m of [this.cars2, this.win2]) {
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      city.root.add(m);
    }
  }

  update(dt, hero) {
    const R = this.hull, Lm = this.lights;
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i], l = c.l;
      c.s = (c.s + c.v * dt) % l.len;
      let x, z, yaw, k = 1;
      if (l.ring) {
        const a = c.s / l.ring * l.dir;
        x = CX + Math.cos(a) * l.ring; z = CZ + Math.sin(a) * l.ring;
        yaw = Math.atan2(-Math.sin(a) * l.dir, Math.cos(a) * l.dir);
      } else {
        const r = l.dir > 0 ? l.r0 + c.s : l.r0 + l.len - c.s, ca = Math.cos(l.a), sa = Math.sin(l.a), off = l.dir * 16;
        x = CX + ca * r - sa * off; z = CZ + sa * r + ca * off;
        yaw = Math.atan2(ca * l.dir, sa * l.dir);
        k = smooth(0, 90, c.s) * smooth(l.len, l.len - 90, c.s);
      }
      // Рядом с героем — в сторону по высоте
      const dh = Math.hypot(x - hero.x, z - hero.z);
      const want = dh < 40 && Math.abs(l.alt + c.dy - hero.y) < 30 ? (hero.y > l.alt ? -1 : 1) * (40 - dh) : 0;
      c.dy += (want - c.dy) * Math.min(1, dt * 3);
      const sc = (c.big ? 3.2 : 1) * k;
      c.x = x; c.y = l.alt + c.dy; c.z = z; c.yaw = yaw;
      // Аэрокар без тяги (aircar.js): его ведёт сцена — падает, в руках у героя, стоит на земле
      if (c.fall) _m.compose(c.fall.p, c.fall.q, _s.set(1, 1, 1));
      else _m.compose(_p.set(x, l.alt + c.dy, z), _q.setFromAxisAngle(UP, yaw), _s.set(sc, sc, sc));
      R.setMatrixAt(i, _m);
      Lm.setMatrixAt(i, _m);
    }
    R.instanceMatrix.needsUpdate = Lm.instanceMatrix.needsUpdate = true;
    // Поезда: вагон за вагоном по дуге, колея — внутренняя или внешняя по направлению
    const rr = SKYWAY.r, y = this.city.hC + SKYWAY.h;
    let i = 0;
    for (const t of this.trains) {
      t.s = (t.s + t.dir * t.v * dt / (2 * Math.PI * rr) + 1) % 1;
      const lane = rr + t.dir * 2.6;
      for (let k = 0; k < TRAIN_CARS; k++, i++) {
        const a = t.s * Math.PI * 2 - t.dir * k * 22 / rr;
        _q.setFromAxisAngle(UP, -a + (t.dir > 0 ? 0 : Math.PI));
        _m.compose(_p.set(CX + Math.cos(a) * lane, y, CZ + Math.sin(a) * lane), _q, _s.set(1, 1, 1));
        this.cars2.setMatrixAt(i, _m);
        this.win2.setMatrixAt(i, _m);
      }
    }
    this.cars2.instanceMatrix.needsUpdate = this.win2.instanceMatrix.needsUpdate = true;
  }
}
