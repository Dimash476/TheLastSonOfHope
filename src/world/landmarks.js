import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CITY } from '../config.js';

// Геометрическая архитектура: сферы, купола, круглые и витые башни, стеклянные
// пирамиды, башни-«пули», геодезические купола. Стоят там, где нет высоток, и
// ломают «квадратный» силуэт города.
//
// Каждая форма — секция здания (как обычный блок): столкновения и разрушение идут
// по её коробке w×h×d, а рисуется сетка формы, вписанная в эту коробку
// (x, z ∈ [-0.5, 0.5], y ∈ [0, 1]). Атрибут part задаёт зону материала:
//   0 — изогнутое стекло (окна по окружности), 1 — глухая отделка,
//   2 — светящаяся полоса (ночью горит), 3 — плоское стекло (окна по граням),
//   4 — панели геокупола (часть — стекло, часть — глухие).

const TWIST = 0.21;   // поворот витой башни на секцию (рад)

function withPart(geo, part) {
  if (geo.index) geo = geo.toNonIndexed();
  if (geo.attributes.uv) geo.deleteAttribute('uv');
  const n = geo.attributes.position.count;
  geo.setAttribute('part', new THREE.BufferAttribute(new Float32Array(n).fill(part), 1));
  return geo;
}

export function makeShapeGeometries() {
  const M = (l) => mergeGeometries(l);
  const cyl = (r0, r1, h, y, seg = 40) => new THREE.CylinderGeometry(r1, r0, h, seg, 1, true).translate(0, y + h / 2, 0);
  const disc = (r, y) => new THREE.CircleGeometry(r, 40).rotateX(-Math.PI / 2).translate(0, y, 0);

  // Сфера на тонком постаменте
  const sphere = M([
    withPart(new THREE.SphereGeometry(0.46, 48, 28).translate(0, 0.54, 0), 0),
    withPart(cyl(0.2, 0.2, 0.1, 0), 1),
    withPart(new THREE.TorusGeometry(0.465, 0.008, 6, 64).rotateX(Math.PI / 2).translate(0, 0.54, 0), 2),
  ]);
  // Купол на барабане с фонарём наверху
  const dome = M([
    withPart(cyl(0.5, 0.5, 0.42, 0), 3),
    withPart(new THREE.SphereGeometry(0.5, 48, 16, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.95, 1).translate(0, 0.42, 0), 0),
    withPart(new THREE.TorusGeometry(0.505, 0.012, 6, 64).rotateX(Math.PI / 2).translate(0, 0.42, 0), 2),
    withPart(cyl(0.06, 0.06, 0.06, 0.88, 16), 1),
    withPart(disc(0.06, 0.94), 1),
  ]);
  // Круглая стеклянная секция башни (ставится стопкой) и венец со светом
  const round = withPart(cyl(0.5, 0.5, 1, 0), 0);
  const crown = M([
    withPart(cyl(0.5, 0.42, 0.6, 0), 0),
    withPart(new THREE.TorusGeometry(0.44, 0.02, 6, 48).rotateX(Math.PI / 2).translate(0, 0.6, 0), 2),
    withPart(disc(0.42, 0.6), 1),
    withPart(cyl(0.03, 0.01, 0.4, 0.6, 8), 1),
  ]);
  // Витая башня: секция-«брусок» с закруткой (каждая следующая повёрнута ещё на TWIST)
  const twistGeo = new THREE.BoxGeometry(1, 1, 1, 1, 6, 1).translate(0, 0.5, 0);
  {
    const P = twistGeo.attributes.position, v = new THREE.Vector3();
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i);
      const a = v.y * TWIST, c = Math.cos(a), s = Math.sin(a);
      P.setXYZ(i, v.x * c - v.z * s, v.y, v.x * s + v.z * c);
    }
    twistGeo.computeVertexNormals();
  }
  const twist = withPart(twistGeo, 3);
  // Стеклянная пирамида (основание вписано в квадрат) с каркасом-рёбрами
  const pyramid = M([
    withPart(new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 6).rotateY(Math.PI / 4).translate(0, 0.5, 0), 3),
  ]);
  // Башня-«пуля»: плавный профиль, сужается к острой верхушке
  const pts = [];
  for (let i = 0; i <= 28; i++) {
    const t = i / 28;
    const r = 0.5 * Math.pow(Math.max(0, 1 - Math.pow(t, 2.4)), 0.55) * (0.86 + 0.14 * Math.sin(Math.PI * Math.min(1, t * 2.2)));
    pts.push(new THREE.Vector2(Math.max(0.001, r), t));
  }
  const bullet = M([
    withPart(new THREE.LatheGeometry(pts, 44), 0),
    withPart(new THREE.TorusGeometry(0.47, 0.01, 6, 48).rotateX(Math.PI / 2).translate(0, 0.32, 0), 2),
  ]);
  // Геодезический купол: полусфера из треугольных панелей
  const ico = new THREE.IcosahedronGeometry(0.5, 3);
  const P = ico.attributes.position, keep = [];
  for (let i = 0; i < P.count; i += 3) {
    const cy = (P.getY(i) + P.getY(i + 1) + P.getY(i + 2)) / 3;
    if (cy > -0.01) for (let k = 0; k < 3; k++) keep.push(P.getX(i + k), Math.max(0, P.getY(i + k)) * 2, P.getZ(i + k));
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(keep, 3));
  geo.computeVertexNormals();
  // Панель: стекло или глухая — случайно по треугольнику
  const part = new Float32Array(keep.length / 3);
  for (let t = 0; t < part.length; t += 3) { const v = Math.random() < 0.6 ? 4 : 1; part[t] = part[t + 1] = part[t + 2] = v; }
  geo.setAttribute('part', new THREE.BufferAttribute(part, 1));
  const geodome = geo;

  // Белая колонна-ствол (ставится стопкой) и раскрытая «чаша» на её вершине
  const pillar = withPart(cyl(0.5, 0.5, 1, 0, 24), 1);
  const cradle = M([
    withPart(cyl(0.14, 0.5, 1, 0, 32), 1),
    withPart(new THREE.TorusGeometry(0.5, 0.02, 6, 48).rotateX(Math.PI / 2).translate(0, 1, 0), 2),
  ]);
  // Огромный наклонный шатёр: стеклянный конус с вершиной, смещённой в сторону
  const tentGeo = new THREE.ConeGeometry(0.5, 1, 56, 14, true).translate(0, 0.5, 0);
  {
    const p = tentGeo.attributes.position;
    for (let i = 0; i < p.count; i++) p.setX(i, p.getX(i) + p.getY(i) * 0.16);
    tentGeo.computeVertexNormals();
  }
  const tent = M([
    withPart(tentGeo, 0),
    withPart(new THREE.TorusGeometry(0.5, 0.012, 6, 64).rotateX(Math.PI / 2).translate(0, 0.01, 0), 2),
    withPart(cyl(0.012, 0.004, 0.08, 0.96, 8).translate(0.155, 0, 0), 1),
  ]);

  // Часовой ярус башни: глухой куб, на каждой грани — циферблат (ночью светится) и стрелки
  const clockFace = (ry) => [
    withPart(new THREE.CircleGeometry(0.34, 32).translate(0, 0.5, 0.505).rotateY(ry), 2),
    withPart(new THREE.BoxGeometry(0.035, 0.2, 0.012).translate(0, 0.1, 0).rotateZ(-1.05).translate(0, 0.5, 0.515).rotateY(ry), 3),
    withPart(new THREE.BoxGeometry(0.028, 0.28, 0.012).translate(0, 0.14, 0).rotateZ(1.05).translate(0, 0.5, 0.515).rotateY(ry), 3),
  ];
  const clock = M([withPart(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), 1), ...[0, 1, 2, 3].flatMap((k) => clockFace(k * Math.PI / 2))]);
  // Глухой четырёхгранный шатёр (крыша башни), грани плоские
  const spire = withPart(new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1).rotateY(Math.PI / 4).translate(0, 0.5, 0), 1);
  spire.computeVertexNormals();

  // Плита «Спирали»: светлое перекрытие и стеклянный этаж над ним
  const slab = M([
    withPart(new THREE.BoxGeometry(1, 0.16, 1).translate(0, 0.08, 0), 1),
    withPart(new THREE.BoxGeometry(0.94, 0.84, 0.94).translate(0, 0.58, 0), 3),
  ]);
  // Стеклянный короб: сплошной витраж с переплётом (башни и мост «Врат»)
  const glassbox = withPart(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), 3);

  const out = { sphere, dome, round, crown, twist, pyramid, bullet, geodome, pillar, cradle, tent, clock, spire, slab, glassbox };
  // Гигантские формы вращения, нарезанные на ярусы (ключи вида «orb:3»), и кольца, нарезанные на дуги
  for (const name in GIANTS) {
    const slices = buildGiant(GIANTS[name]);
    slices.forEach((s, k) => { out[`${name}:${k}`] = s.geo; });
  }
  for (const name in RINGS) buildRing(RINGS[name]).forEach((s, k) => { out[`${name}:${k}`] = s.geo; });
  for (const k in out) out[k].computeBoundingSphere();
  return out;
}

// ================================================================ гиганты
// Форма вращения задаётся профилем r(y) (y и r — в долях диаметра D; высота = aspect·D).
// Её режем по высоте на ярусы: каждый ярус — отдельная секция здания со своей коробкой,
// поэтому столкновения повторяют силуэт, а рушится гигант по частям.
// radial — число граней (4 — пирамида, 6 — кристалл, много — гладко), flat — плоские грани,
// tilt — наклон оси (шатёр), part(y) — зона материала по высоте.
const sphereR = (y) => 0.5 * Math.sqrt(Math.max(0, 1 - (2 * y - 1) ** 2));
export const GIANTS = {
  orb: { aspect: 1, slices: 9, radial: 64, profile: (y) => Math.max(sphereR(y), y < 0.5 ? 0.06 : 0), part: (y) => (Math.abs(y - 0.5) < 0.006 ? 2 : 0) },
  dome: { aspect: 0.62, slices: 5, radial: 64,
    profile: (y) => { const h = y / 0.62; return h < 0.4 ? 0.5 : 0.5 * Math.sqrt(Math.max(0, 1 - ((h - 0.4) / 0.6) ** 2)); },
    part: (y) => { const h = y / 0.62; return h < 0.4 ? 3 : (Math.abs(h - 0.4) < 0.01 ? 2 : 0); } },
  geodome: { aspect: 0.5, slices: 4, radial: 16, flat: true, profile: (y) => 0.5 * Math.sqrt(Math.max(0, 1 - (y / 0.5) ** 2)), part: () => 4 },
  tent: { aspect: 1.2, slices: 10, radial: 72, tilt: 0.16, profile: (y) => 0.5 * Math.pow(1 - y / 1.2, 1.05), part: (y) => (y < 0.004 ? 2 : 0) },
  pyramid: { aspect: 0.85, slices: 8, radial: 4, flat: true, phase: Math.PI / 4, profile: (y) => Math.SQRT1_2 * (1 - y / 0.85), part: () => 3 },
  bullet: { aspect: 4.2, slices: 14, radial: 56,
    profile: (y) => { const t = y / 4.2; return 0.5 * Math.pow(Math.max(0, 1 - t ** 2.4), 0.55) * (0.86 + 0.14 * Math.sin(Math.PI * Math.min(1, t * 2.2))); },
    part: (y) => (Math.abs(y / 4.2 - 0.32) < 0.004 ? 2 : 0) },
  hyper: { aspect: 4, slices: 14, radial: 56,
    profile: (y) => { const t = y / 4; return t > 0.985 ? 0.0 : 0.5 * (0.52 + 0.48 * Math.pow(Math.abs((t - 0.62) / 0.62), 1.5)); },
    part: (y) => { const t = y / 4; return t > 0.97 ? 1 : (Math.abs(fract(t * 12) - 0.5) < 0.012 ? 2 : 0); } },
  crystal: { aspect: 3.2, slices: 10, radial: 6, flat: true,
    profile: (y) => { const t = y / 3.2; return t < 0.04 ? 0.42 + t * 2 : t < 0.78 ? 0.5 : 0.5 * (1 - (t - 0.78) / 0.22); }, part: () => 3 },
  saucer: { aspect: 0.24, slices: 2, radial: 72,
    profile: (y) => { const t = y / 0.24; return 0.5 * Math.pow(Math.sin(Math.PI * (0.08 + 0.84 * t)), 0.45) * (t < 0.5 ? 1 : 1 - (t - 0.5) * 0.5); },
    part: (y) => (Math.abs(y / 0.24 - 0.45) < 0.03 ? 2 : 0) },
  // Смотровая капсула телебашни: снизу — гладкая чаша, посередине — стеклянный пояс
  // (ресторан), над ним — светящееся кольцо и пологая крыша
  tvpod: { aspect: 0.8, slices: 4, radial: 64,
    profile: (y) => {
      const t = y / 0.8;
      if (t < 0.34) return 0.13 + 0.37 * Math.sin(t / 0.34 * Math.PI / 2);
      if (t < 0.66) return 0.5 - 0.035 * (t - 0.34) / 0.32;
      if (t < 0.72) return 0.47;
      return Math.max(0.06, 0.47 * Math.cos((t - 0.72) / 0.28 * Math.PI / 2));
    },
    part: (y) => { const t = y / 0.8; return t < 0.34 ? 1 : t < 0.655 ? 0 : t < 0.725 ? 2 : 1; } },
  pagoda: { aspect: 1.5, slices: 9, radial: 8, flat: true,
    profile: (y) => { const t = y / 1.5, k = Math.min(8, Math.floor(t * 9)), f = t * 9 - k; return 0.5 * (1 - k * 0.095) * (f > 0.86 ? 1.06 : 1 - f * 0.05); },
    part: (y) => (((y / 1.5) * 9) % 1 > 0.86 ? 2 : 3) },
  // «Чаша»: широкий постамент, тонкий светлый ствол и огромная стеклянная чаша со светящимся краем
  chalice: { aspect: 1.17, slices: 12, radial: 64,
    profile: (y) => {
      const t = y / 1.17;
      if (t < 0.04) return 0.2 - t * 2;
      if (t < 0.42) return 0.12 - (t - 0.04) * 0.08;
      return 0.09 + 0.41 * Math.pow((t - 0.42) / 0.58, 1.7);
    },
    part: (y) => { const t = y / 1.17; return t > 0.985 ? 2 : t < 0.42 ? 1 : 0; } },
};
function fract(x) { return x - Math.floor(x); }

// Строит ярусы: геометрия каждого вписана в свою коробку; возвращает и саму коробку
// (смещение центра и размеры в долях D) для расстановки секций
const _giantCache = new Map();
export function buildGiant(G) {
  if (_giantCache.has(G)) return _giantCache.get(G);
  const H = G.aspect, n = G.slices, rows = 10, rad = G.radial, tilt = G.tilt || 0, phase = G.phase || 0;
  const out = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * H, b = ((k + 1) / n) * H;
    // Вершины кольцами: (rows+1) колец × (rad+1) точек; нормали — в «настоящих» пропорциях
    const pos = [], part = [];
    for (let r = 0; r <= rows; r++) {
      const y = a + (b - a) * r / rows, rr = G.profile(y), pv = G.part(y);
      for (let s = 0; s <= rad; s++) {
        const th = phase + s / rad * Math.PI * 2;
        pos.push(Math.cos(th) * rr + y * tilt, y, Math.sin(th) * rr);
        part.push(pv);
      }
    }
    const idx = [];
    for (let r = 0; r < rows; r++) for (let s = 0; s < rad; s++) {
      const i0 = r * (rad + 1) + s, i1 = i0 + 1, i2 = i0 + rad + 1, i3 = i2 + 1;
      idx.push(i0, i2, i1, i1, i2, i3);
    }
    // Крышка сверху у последнего яруса (если вершина не сходится в точку)
    let geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('part', new THREE.Float32BufferAttribute(part, 1));
    geo.setIndex(idx);
    if (k === n - 1 && G.profile(b) > 0.02) {
      const top = new THREE.CircleGeometry(G.profile(b), rad, phase).rotateX(-Math.PI / 2).translate(b * tilt, b, 0);
      top.deleteAttribute('uv');
      top.setAttribute('part', new THREE.Float32BufferAttribute(new Float32Array(top.attributes.position.count).fill(1), 1));
      geo.computeVertexNormals();
      top.computeVertexNormals();
      geo = mergeGeometries([geo.toNonIndexed(), top.toNonIndexed()]);
    } else if (G.flat) {
      geo = geo.toNonIndexed();
      geo.computeVertexNormals();
    } else geo.computeVertexNormals();
    if (G.flat && geo.index) { geo = geo.toNonIndexed(); geo.computeVertexNormals(); }
    // Коробка яруса и нормировка в единичный объём (x, z ∈ [-0.5, 0.5], y ∈ [0, 1])
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const cx = (bb.min.x + bb.max.x) / 2, cz = (bb.min.z + bb.max.z) / 2;
    const w = Math.max(1e-3, bb.max.x - bb.min.x), d = Math.max(1e-3, bb.max.z - bb.min.z), h = b - a;
    const P = geo.attributes.position, N = geo.attributes.normal, v = new THREE.Vector3();
    for (let i = 0; i < P.count; i++) {
      P.setXYZ(i, (P.getX(i) - cx) / w, (P.getY(i) - a) / h, (P.getZ(i) - cz) / d);
      // Нормаль после масштабирования экземпляром (w, h, d) останется верной
      v.set(N.getX(i) * w, N.getY(i) * h, N.getZ(i) * d).normalize();
      N.setXYZ(i, v.x, v.y, v.z);
    }
    out.push({ geo, cx, cz, w, d, y0: a, h });
  }
  _giantCache.set(G, out);
  return out;
}

// ================================================================ кольца
// Кольцо режется по окружности на дуги; каждая дуга — секция со своей коробкой (как ярусы
// гигантов), поэтому столкновения повторяют форму, а рушится кольцо по частям.
// vertical — кольцо стоит (ось вдоль Z), иначе лежит (ось вертикальна). Размеры — в долях
// внешнего диаметра D: r0, r1 — внутренний и внешний радиусы, t — толщина.
// Окна там, где грань вертикальна: у стоящего кольца — на плоских сторонах, у лежащего —
// на внешнем ободе; остальное — глухая отделка. Внутренний край светится
export const RINGS = {
  ring: { vertical: true, pieces: 24, r0: 0.41, r1: 0.5, t: 0.1 },
  halo: { vertical: false, pieces: 16, r0: 0.38, r1: 0.5, t: 0.09 },
};
// Дуга k начинается снизу (у стоящего кольца) или с оси +X (у лежащего) и идёт против часовой
export const ringAngle = (R, k) => (R.vertical ? -Math.PI / 2 : 0) + (k / R.pieces) * Math.PI * 2;
const _ringCache = new Map();
export function buildRing(R) {
  if (_ringCache.has(R)) return _ringCache.get(R);
  const out = [], m = 4, h = R.t / 2;
  // Точка кольца: радиус r, угол a, смещение по оси кольца s
  const pt = (r, a, s) => (R.vertical ? [r * Math.cos(a), r * Math.sin(a), s] : [r * Math.cos(a), s, r * Math.sin(a)]);
  const axis = R.vertical ? [0, 0, 1] : [0, 1, 0];
  const radial = (a, sg) => (R.vertical ? [sg * Math.cos(a), sg * Math.sin(a), 0] : [sg * Math.cos(a), 0, sg * Math.sin(a)]);
  const side = R.vertical ? 3 : 1, rim = R.vertical ? 1 : 3;
  for (let k = 0; k < R.pieces; k++) {
    const a0 = ringAngle(R, k), a1 = ringAngle(R, k + 1);
    const pos = [], nrm = [], part = [];
    // Четырёхугольник с заданной нормалью; обход подбираем так, чтобы грань смотрела наружу
    const quad = (A, B, C, D, n, p) => {
      const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
      const flip = (u[1] * v[2] - u[2] * v[1]) * n[0] + (u[2] * v[0] - u[0] * v[2]) * n[1] + (u[0] * v[1] - u[1] * v[0]) * n[2] < 0;
      for (const P of flip ? [A, C, B, A, D, C] : [A, B, C, A, C, D]) { pos.push(...P); nrm.push(...n); part.push(p); }
    };
    const quadN = (A, B, C, D, nA, nB, p) => {
      // Изогнутая грань: нормали по вершинам (A, D — на угле a0; B, C — на a1)
      const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
      const n = [(nA[0] + nB[0]) / 2, (nA[1] + nB[1]) / 2, (nA[2] + nB[2]) / 2];
      const flip = (u[1] * v[2] - u[2] * v[1]) * n[0] + (u[2] * v[0] - u[0] * v[2]) * n[1] + (u[0] * v[1] - u[1] * v[0]) * n[2] < 0;
      const vs = [[A, nA], [B, nB], [C, nB], [D, nA]];
      for (const i of flip ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3]) { pos.push(...vs[i][0]); nrm.push(...vs[i][1]); part.push(p); }
    };
    for (let i = 0; i < m; i++) {
      const b0 = a0 + (a1 - a0) * i / m, b1 = a0 + (a1 - a0) * (i + 1) / m;
      for (const sg of [-1, 1]) {
        // Плоские стороны, у внутреннего края — светящаяся полоса
        const n = axis.map((c) => c * sg), rb = R.r0 + 0.012;
        quad(pt(R.r0, b0, sg * h), pt(R.r0, b1, sg * h), pt(rb, b1, sg * h), pt(rb, b0, sg * h), n, 2);
        quad(pt(rb, b0, sg * h), pt(rb, b1, sg * h), pt(R.r1, b1, sg * h), pt(R.r1, b0, sg * h), n, side);
      }
      quadN(pt(R.r1, b0, -h), pt(R.r1, b1, -h), pt(R.r1, b1, h), pt(R.r1, b0, h), radial(b0, 1), radial(b1, 1), rim);
      quadN(pt(R.r0, b0, -h), pt(R.r0, b1, -h), pt(R.r0, b1, h), pt(R.r0, b0, h), radial(b0, -1), radial(b1, -1), 2);
    }
    // Торцы: видны, когда соседняя дуга выбита
    for (const [a, sg] of [[a0, -1], [a1, 1]]) {
      const t = R.vertical ? [-Math.sin(a) * sg, Math.cos(a) * sg, 0] : [-Math.sin(a) * sg, 0, Math.cos(a) * sg];
      quad(pt(R.r0, a, -h), pt(R.r1, a, -h), pt(R.r1, a, h), pt(R.r0, a, h), t, 1);
    }
    let geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('part', new THREE.Float32BufferAttribute(part, 1));
    // Коробка дуги и нормировка в единичный объём (как у ярусов гигантов)
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const cx = (bb.min.x + bb.max.x) / 2, cz = (bb.min.z + bb.max.z) / 2;
    const w = bb.max.x - bb.min.x, d = bb.max.z - bb.min.z, hh = bb.max.y - bb.min.y;
    const P = geo.attributes.position, N = geo.attributes.normal, v = new THREE.Vector3();
    for (let i = 0; i < P.count; i++) {
      P.setXYZ(i, (P.getX(i) - cx) / w, (P.getY(i) - bb.min.y) / hh, (P.getZ(i) - cz) / d);
      v.set(N.getX(i) * w, N.getY(i) * hh, N.getZ(i) * d).normalize();
      N.setXYZ(i, v.x, v.y, v.z);
    }
    out.push({ geo, cx, cz, w, d, y0: bb.min.y, h: hh });
  }
  _ringCache.set(R, out);
  return out;
}

// Ставит дугу k кольца name: диаметр D, центр кольца (x, yc, z)
function addRingPiece(city, b, name, k, x, yc, z, D, color = null) {
  const s = buildRing(RINGS[name])[k];
  const seg = city.addSeg(b, { x: x + s.cx * D, z: z + s.cz * D, w: s.w * D, d: s.d * D, y0: yc + s.y0 * D, h: s.h * D, type: 'shape', shape: `${name}:${k}` });
  if (color) seg.color = new THREE.Color(color);
  return seg;
}

// Ставит гиганта: диаметр D, центр (x, z), основание y0. color — цвет для всех ярусов
export function addGiant(city, b, name, x, z, D, y0, color = null) {
  const slices = buildGiant(GIANTS[name]);
  slices.forEach((s, k) => {
    const seg = city.addSeg(b, { x: x + s.cx * D, z: z + s.cz * D, w: s.w * D, d: s.d * D, y0: y0 + s.y0 * D, h: s.h * D, type: 'shape', shape: `${name}:${k}` });
    if (color) seg.color = new THREE.Color(color);
  });
  return y0 + GIANTS[name].aspect * D;
}

// ================================================================ телебашня «Надежда»
// Самое высокое сооружение города (≈515 м) на своей площади у реки: сужающийся
// бетонный ствол, техническое кольцо-«тарелка», смотровая капсула со стеклянным
// поясом и светящимся кольцом (ночью сияет над городом), мачта антенны с
// заградительным огнём. Рушится по секциям, как всё остальное: верх падает целиком.
export function addTvTower(city, site) {
  const { x, z } = site, fixed = () => 0.5;
  city.addBuilding({ x, z, w: 70, d: 70, h: 3, color: 0xd9d3c7, glass: false, type: 'concrete', roof: null }, fixed);
  // Вестибюль — низкое стеклянное кольцо вокруг основания
  const hall = city.newBuilding({ kind: 'building', x, z, color: 0x7aa0c8, glass: true });
  hall.shaped = true;
  city.addSeg(hall, { x, z, w: 50, d: 50, y0: 3, h: 9, type: 'shape', shape: 'round' });
  // Сама башня — одно здание: секции идут снизу вверх (выбитая роняет всё, что выше)
  const b = city.newBuilding({ kind: 'building', x, z, color: 0xe9e6df, glass: false });
  const n = 28, sh = 352 / n;
  for (let k = 0; k < n; k++) {
    const y0 = 3 + k * sh, D = 24 - 12 * k / (n - 1);    // 24 → 12 м
    city.addSeg(b, { x, z, w: D, d: D, y0, h: sh, type: 'shape', shape: 'pillar' });
    if (k === 18) addGiant(city, b, 'saucer', x, z, 38, y0 + sh * 0.4, 0xf2efe8);
  }
  addGiant(city, b, 'tvpod', x, z, 50, 345, SILVER);
  for (let k = 0; k < 2; k++) city.addSeg(b, { x, z, w: 9, d: 9, y0: 385 + k * 10, h: 10, type: 'shape', shape: 'pillar' });
  // Мачта антенны: ступенями тоньше; на верхушке — красный огонь (ставит city.js)
  const mast = [[4.5, 12], [4.5, 12], [3, 14], [3, 14], [2, 20], [1.4, 20], [0.9, 18]];
  let y = 405;
  for (const [w, h] of mast) { city.addSeg(b, { x, z, w, d: w, y0: y, h, type: 'concrete' }); y += h; }
}

// Материал: стекло со стойками и этажами (окна идут по окружности или по граням),
// глухая отделка, светящиеся полосы; ночью — свет в окнах
export function createShapeMaterial(uNight) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.1 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = uNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float part;\nvarying float vPart;\nvarying vec3 vSPos;\nvarying vec3 vSNrm;\nvarying float vRad;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        {
          vec4 wp = vec4(transformed, 1.0);
          vec3 wn = objectNormal;
          float sx = 1.0;
          #ifdef USE_INSTANCING
            wp = instanceMatrix * wp;
            wn = mat3(instanceMatrix) * wn;
            sx = length(instanceMatrix[0].xyz);
          #endif
          vSPos = wp.xyz;
          vSNrm = normalize(wn);
          vPart = part;
          // Длина дуги по окружности (м): окна одинаковой ширины на любом радиусе
          vRad = atan(position.z, position.x) * length(position.xz) * sx;
        }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uNight;
        varying float vPart;
        varying vec3 vSPos;
        varying vec3 vSNrm;
        varying float vRad;
        float sh21(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 15731.743); }
        float glassK = 0.0, litK = 0.0, bandK = 0.0;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float pt = floor(vPart + 0.5);
          vec3 base = diffuseColor.rgb;
          bandK = step(1.5, pt) * step(pt, 2.5);
          float solid = step(0.5, pt) * step(pt, 1.5);
          float glassy = 1.0 - solid - bandK;
          // Координаты фасада: дуга (изогнутое стекло) или грань (плоское)
          vec3 an = abs(vSNrm);
          float u = pt < 0.5 ? vRad : (an.x > an.z ? vSPos.z : vSPos.x);
          vec2 cell = vec2(u / 2.2, vSPos.y / 3.6);
          vec2 f = fract(cell), id = floor(cell);
          float rnd = sh21(id + floor(vSPos.xz * 0.02));
          // Стойки и межэтажные пояса — тонкий светлый металл
          float mull = 1.0 - step(0.045, f.x) * step(f.x, 0.955) * step(0.06, f.y) * step(f.y, 0.92);
          // Геокупол: панели-треугольники, светлый каркас по краям фасетов
          float geo = step(3.5, pt);
          mull = mix(mull, 0.0, geo);
          glassK = glassy * (1.0 - mull);
          vec3 glassC = base * vec3(0.36, 0.38, 0.42) + vec3(0.015, 0.025, 0.035);
          vec3 frameC = mix(vec3(0.72, 0.74, 0.76), base, 0.25);
          vec3 col = mix(frameC, glassC, glassK);
          col = mix(col, base * 0.92, solid);
          col = mix(col, vec3(0.9, 0.86, 0.78), bandK);
          diffuseColor.rgb = col;
          // Свет в окнах: днём редко, ночью много
          litK = glassK * step(mix(0.92, 0.64, uNight), rnd) * (1.0 - geo * 0.5);
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.06, glassK);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        metalnessFactor = mix(metalnessFactor, 0.75, glassK);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          vec3 warm = mix(vec3(1.0, 0.78, 0.5), vec3(0.8, 0.88, 1.0), step(0.75, fract(vSPos.y * 0.37 + vSPos.x * 0.011)));
          totalEmissiveRadiance += litK * warm * mix(0.1, 0.85, uNight);
          // Светящиеся кольца и венцы: днём чуть заметны, ночью — мягкое сияние
          totalEmissiveRadiance += bandK * vec3(1.0, 0.82, 0.6) * mix(0.15, 2.6, uNight);
        }`);
  };
  return mat;
}

// Палитры: стекло (бирюза, изумруд, золото, серебро, синева) и отделка (белый, крем, медь)
const GLASS_TINTS = [0x5aa6b8, 0x4f9a86, 0xa8b4c0, 0x4f73b0, 0x7aa0c8];
const GOLD = 0xd9a84e, EMERALD = 0x3f9a78, SILVER = 0xc8ccd0;
const SOLID_TINTS = [0xf2efe8, 0xe6dccb, 0xd8d4cc];

// ================================================================ мега-площади
// Гигант в центре площади ≈ 276×276 м. Каждая площадь — своя постройка (без повторов, пока
// хватает видов): огромная сфера, башня с золотым шаром, шатёр, пирамида, ступенчатая
// пагода, «гиперболоид», кластер кристаллов, башня-«тарелка», золотые и изумрудные башни,
// башня-«пуля», концертный купол.
const MEGA_KINDS = ['orb', 'crownTower', 'tent', 'pyramid', 'pagoda', 'hyper', 'crystals', 'saucer', 'twinGold', 'emerald', 'bullet', 'dome'];
export function addMegaLandmark(city, site, index, rnd) {
  const { x, z } = site, L = (site.half - 12) * 2;           // ширина площади без тротуаров
  const order = MEGA_KINDS.map((k, i) => [k, Math.sin(i * 12.9898 + 4.1) * 43758.5 % 1]).sort((p, q) => p[1] - q[1]).map((p) => p[0]);
  // Площади 5×5 — под гигантскую сферу и новых гигантов (вид задан в layout.js), остальные — по очереди
  const kind = site.kind || (site.giant ? 'megaOrb' : order[(site.reg ?? index) % order.length]);
  const fixed = () => 0.5;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const shaped = (bx, bz, color) => { const b = city.newBuilding({ kind: 'building', x: bx, z: bz, color, glass: true }); b.shaped = true; return b; };
  const seg = (b, shape, sx, sz, w, d, y0, h, rot = 0) => city.addSeg(b, { x: sx, z: sz, w, d, y0, h, type: 'shape', shape, rot });
  const stack = (b, shape, sx, sz, w, y0, H, rot0 = 0, drot = 0) => {
    const n = Math.max(3, Math.round(H / 16)), sh = H / n;
    for (let k = 0; k < n; k++) seg(b, shape, sx, sz, w, w, y0 + k * sh, sh, rot0 + k * drot);
    return y0 + H;
  };
  // Стилобат — широкое каменное основание
  const base = (w, h = 4) => city.addBuilding({ x, z, w, d: w, h, color: 0xd9d3c7, glass: false, type: 'concrete', roof: null }, fixed);

  if (kind === 'megaOrb') {
    // Огромная стеклянная сфера ~450 м на широком стилобате — видна из любой точки города
    base(L * 0.97, 6);
    addGiant(city, shaped(x, z, 0x6f9cc4), 'orb', x, z, L * 0.94, 6);
  } else if (kind === 'orb') {
    base(L * 0.82, 5);
    addGiant(city, shaped(x, z, pick([0x5aa6b8, 0x4f73b0, SILVER])), 'orb', x, z, L * 0.74, 5);
  } else if (kind === 'crownTower') {
    base(110, 5);
    const b = shaped(x, z, 0xf2efe8);
    const top = stack(b, 'pillar', x, z, 26, 5, 250 + rnd() * 30);
    seg(b, 'cradle', x, z, 96, 96, top, 42);
    addGiant(city, b, 'orb', x, z, 74, top + 6, GOLD);
  } else if (kind === 'tent') {
    addGiant(city, shaped(x, z, pick([SILVER, 0xe0d2b0, 0xb8d0d8])), 'tent', x, z, L * 0.86, 0);
  } else if (kind === 'pyramid') {
    base(L * 0.94, 3);
    addGiant(city, shaped(x, z, pick([0x7aa0c8, 0xa8b4c0, GOLD])), 'pyramid', x, z, L * 0.84, 3);
  } else if (kind === 'pagoda') {
    base(L * 0.9, 4);
    addGiant(city, shaped(x, z, pick([0x5aa6b8, 0x8c6a8a, EMERALD])), 'pagoda', x, z, L * 0.78, 4);
  } else if (kind === 'hyper') {
    base(160, 5);
    addGiant(city, shaped(x, z, pick([0xa8b4c0, 0x7aa0c8])), 'hyper', x, z, 112, 5);
  } else if (kind === 'crystals') {
    // Кластер кристаллов разной высоты: ледяное стекло, сирень, бирюза
    base(L * 0.8, 3);
    const tints = [0xa8c8e8, 0x9a8ac8, 0x8ad0d0, 0xc8d8f0];
    for (const [ox, oz, Dk] of [[0, 0, 82], [-62, 48, 58], [66, 40, 50], [-48, -66, 46], [58, -58, 40]]) {
      addGiant(city, shaped(x + ox, z + oz, pick(tints)), 'crystal', x + ox, z + oz, Dk + rnd() * 10, 3);
    }
  } else if (kind === 'saucer') {
    // Высокий ствол и огромная «тарелка» смотровой площадки наверху
    base(100, 5);
    const b = shaped(x, z, 0xe8eef0);
    const top = stack(b, 'pillar', x, z, 30, 5, 230 + rnd() * 30);
    const st = addGiant(city, b, 'saucer', x, z, 190, top - 10, 0x9ab8d0);
    stack(b, 'pillar', x, z, 4, st - 4, 60);
  } else if (kind === 'twinGold') {
    base(L * 0.8, 5);
    for (const s of [-1, 1]) {
      const bx = x + s * 46, H = 360 + rnd() * 60;
      const b = shaped(bx, z, GOLD);
      const top = stack(b, 'round', bx, z, 56, 5, H);
      seg(b, 'crown', bx, z, 56, 56, top, 36);
    }
  } else if (kind === 'emerald') {
    base(L * 0.8, 5);
    for (const [ox, oz, H] of [[-55, -45, 300], [55, 45, 440], [50, -60, 360]]) {
      const b = shaped(x + ox, z + oz, EMERALD);
      stack(b, 'twist', x + ox, z + oz, 54, 5, H + rnd() * 30, rnd() * Math.PI, 0.21);
    }
  } else if (kind === 'bullet') {
    base(150, 5);
    addGiant(city, shaped(x, z, pick(GLASS_TINTS)), 'bullet', x, z, 96, 5);
  } else if (kind === 'dome') {
    base(L * 0.9, 4);
    addGiant(city, shaped(x, z, pick(SOLID_TINTS)), 'dome', x, z, L * 0.82, 4);
  } else if (kind === 'geodome') {
    addGiant(city, shaped(x, z, 0xe8eef0), 'geodome', x, z, L * 0.9, 0);
  } else if (kind === 'gate') {
    // «Врата» ~420 м: две стеклянные башни, сверху их накрывает огромный золотой корпус-мост.
    // Мост держится на обеих: выбили опору ниже него — он падает (как переход у «Близнецов»)
    base(L * 0.9, 5);
    const color = pick([0x40566e, 0x5a7896, 0x4f73b0]);
    const towers = [-1, 1].map((s) => {
      const b = shaped(x + s * 100, z, color);
      stack(b, 'glassbox', x + s * 100, z, 56, 5, 343);
      b.links = [];
      return b;
    });
    const br = shaped(x, z, GOLD);
    for (const [y0, h] of [[348, 36], [384, 36]]) for (let k = 0; k < 6; k++) {
      const s = seg(br, 'glassbox', x - 128 + 256 * (k + 0.5) / 6, z, 256 / 6, 62, y0, h);
      for (const t of towers) t.links.push(s);
    }
  } else if (kind === 'chalice') {
    // «Чаша» ~350 м: тонкий ствол раскрывается в стеклянную чашу ~300 м в поперечнике
    base(150, 5);
    addGiant(city, shaped(x, z, pick([0x4f73b0, 0x5aa6b8, 0x7aa0c8])), 'chalice', x, z, 300, 5);
  } else if (kind === 'spiral') {
    // «Спираль» ~500 м: плиты-этажи, каждая повёрнута и сдвинута относительно нижней — закрученная лестница
    base(160, 5);
    const b = shaped(x, z, pick([0x5aa6b8, 0x4f9a86, 0x4f73b0, 0x7aa0c8]));
    const n = 40, sh = 12.4, R = 15, da = 0.16;
    for (let k = 0; k < n; k++) {
      const a = k * da, w = 74 - 28 * k / (n - 1);
      seg(b, 'slab', x + Math.cos(a) * R, z + Math.sin(a) * R, w, w, 5 + k * sh, sh, a);
    }
    stack(b, 'pillar', x + Math.cos(n * da) * R, z + Math.sin(n * da) * R, 3, 5 + n * sh, 36);
  } else if (kind === 'ring') {
    // «Кольцо» ~350 м: стоящее на ребре кольцо-здание, окна на обеих сторонах, внутренний край светится.
    // Две половины — отдельные здания: выбитая дуга роняет всё, что выше неё на своей стороне
    const D = 340, yc = 2 + D / 2, R = RINGS.ring;
    city.addBuilding({ x, z, w: 170, d: 80, h: 10, color: 0xd9d3c7, glass: false, type: 'concrete', roof: null }, fixed);
    const color = pick([0x7aa0c8, 0x5aa6b8, 0x4f73b0]);
    const right = shaped(x + D / 4, z, color), left = shaped(x - D / 4, z, color);
    for (let k = 0; k < R.pieces / 2; k++) addRingPiece(city, right, 'ring', k, x, yc, z, D);
    for (let k = R.pieces - 1; k >= R.pieces / 2; k--) addRingPiece(city, left, 'ring', k, x, yc, z, D);
  } else if (kind === 'halo') {
    // «Нимб» ~360 м: три круглые башни держат над площадью огромное лежащее кольцо; ночью его
    // внутренний край светится. Кольцо держится на всех трёх: выбили опору — оно падает
    const D = 360, top = 330, R = RINGS.halo, rr = (R.r0 + R.r1) / 2 * D;
    base(L * 0.94, 4);
    const color = pick(GLASS_TINTS);
    const towers = [0, 1, 2].map((i) => {
      const a = Math.PI / 2 + i * Math.PI * 2 / 3, tx = x + Math.cos(a) * rr, tz = z + Math.sin(a) * rr;
      const b = shaped(tx, tz, color);
      stack(b, 'round', tx, tz, 40, 4, top - 4);
      b.links = [];
      return b;
    });
    const ring = shaped(x, z, 0xe8eef0);
    for (let k = 0; k < R.pieces; k++) {
      const s = addRingPiece(city, ring, 'halo', k, x, top + R.t * D / 2, z, D);
      for (const t of towers) t.links.push(s);
    }
    // В центре площади — стеклянный купол-павильон
    addGiant(city, shaped(x, z, pick([0x5aa6b8, 0x4f73b0])), 'dome', x, z, 120, 4);
  }
}

// Квартал-площадь с одной крупной постройкой — масштабные формы в духе современной
// столичной архитектуры: огромная сфера, башня с золотым шаром на чаше, наклонный
// шатёр, большая пирамида, пары золотых и изумрудных башен. Занимают весь участок
// и заметно возвышаются над малоэтажной застройкой вокруг.
// small — для пригорода: павильоны поменьше.
export function addGeometricBlock(city, bx, bz, rnd, small = false) {
  const margin = CITY.road / 2 + CITY.sidewalk, lot = CITY.block - margin * 2;   // ≈ 76 м
  const cx = bx + CITY.block / 2, cz = bz + CITY.block / 2;
  const fixed = () => 0.5;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const kinds = small ? ['sphere', 'dome', 'geodome', 'pyramid']
    : ['orb', 'crownTower', 'tent', 'pyramid', 'twinGold', 'emerald', 'bullet', 'dome', 'geodome'];
  const kind = pick(kinds);
  const shaped = (x, z, color) => { const b = city.newBuilding({ kind: 'building', x, z, color, glass: true }); b.shaped = true; return b; };
  const seg = (b, shape, x, z, w, d, y0, h, rot = 0) => city.addSeg(b, { x, z, w, d, y0, h, type: 'shape', shape, rot });
  const stack = (b, shape, x, z, w, y0, H, rot0 = 0, drot = 0) => {
    const n = Math.max(3, Math.round(H / CITY.segment)), sh = H / n;
    for (let k = 0; k < n; k++) seg(b, shape, x, z, w, w, y0 + k * sh, sh, rot0 + k * drot);
    return y0 + H;
  };
  // Площадь-подиум из светлого камня
  const podium = (w, h = 1.5) => city.addBuilding({ x: cx, z: cz, w, d: w, h, color: 0xd9d3c7, glass: false, type: 'concrete', roof: null }, fixed);

  if (small) {
    // Пригород: павильоны 40–55 м
    const D = 40 + rnd() * 15;
    if (kind === 'sphere') { podium(Math.min(lot, D + 10)); seg(shaped(cx, cz, pick(GLASS_TINTS)), 'sphere', cx, cz, D, D, 1.5, D); }
    else if (kind === 'dome') { podium(Math.min(lot, D + 8)); seg(shaped(cx, cz, pick(SOLID_TINTS)), 'dome', cx, cz, D, D, 1.5, D * 0.62); }
    else if (kind === 'geodome') seg(shaped(cx, cz, 0xe8eef0), 'geodome', cx, cz, D, D, 0, D / 2);
    else { podium(Math.min(lot, D + 8)); seg(shaped(cx, cz, pick(GLASS_TINTS)), 'pyramid', cx, cz, D, D, 1.5, D * 0.72); }
    return;
  }

  const L = lot - 2;
  if (kind === 'orb') {
    // Огромная стеклянная сфера на низком подиуме
    const D = L - rnd() * 6;
    podium(lot, 3);
    seg(shaped(cx, cz, pick([0x5aa6b8, 0x4f73b0, SILVER])), 'sphere', cx, cz, D, D, 3, D);
  } else if (kind === 'crownTower') {
    // Белая башня-ствол, раскрытая чаша и золотой шар наверху (~110 м)
    podium(46, 2);
    const b = shaped(cx, cz, 0xf2efe8);
    const top = stack(b, 'pillar', cx, cz, 9, 2, 80 + rnd() * 16);
    seg(b, 'cradle', cx, cz, 30, 30, top, 14);
    // Шар — часть той же башни (рушится вместе с ней), но своего, золотого цвета
    seg(b, 'sphere', cx, cz, 24, 24, top + 2, 24).color = new THREE.Color(GOLD);
  } else if (kind === 'tent') {
    // Огромный наклонный шатёр из стекла на всю площадь (110–130 м)
    seg(shaped(cx, cz, pick([SILVER, 0xe0d2b0, 0xb8d0d8])), 'tent', cx, cz, L, L, 0, 110 + rnd() * 20);
  } else if (kind === 'pyramid') {
    podium(lot, 2);
    seg(shaped(cx, cz, pick([0x7aa0c8, 0xa8b4c0, GOLD])), 'pyramid', cx, cz, L - 4, L - 4, 2, (L - 4) * 0.85);
  } else if (kind === 'twinGold') {
    // Две золотые круглые башни с наклонными венцами (140–170 м)
    podium(lot, 3);
    for (const s of [-1, 1]) {
      const x = cx + s * 17, H = 140 + rnd() * 30;
      const b = shaped(x, cz, GOLD);
      const top = stack(b, 'round', x, cz, 26, 3, H);
      seg(b, 'crown', x, cz, 26, 26, top, 16);
    }
  } else if (kind === 'emerald') {
    // Пара изумрудных витых башен разной высоты (160–220 м)
    podium(lot, 3);
    for (const [ox, oz, H] of [[-15, -12, 160 + rnd() * 20], [15, 12, 195 + rnd() * 25]]) {
      const b = shaped(cx + ox, cz + oz, EMERALD);
      stack(b, 'twist', cx + ox, cz + oz, 26, 3, H, rnd() * Math.PI, 0.21);
    }
  } else if (kind === 'bullet') {
    podium(lot, 3);
    seg(shaped(cx, cz, pick(GLASS_TINTS)), 'bullet', cx, cz, 44, 44, 3, 170 + rnd() * 40);
  } else if (kind === 'dome') {
    // Большой концертный купол на колоннаде-барабане
    podium(lot, 2);
    seg(shaped(cx, cz, pick(SOLID_TINTS)), 'dome', cx, cz, L - 4, L - 4, 2, (L - 4) * 0.66);
  } else if (kind === 'geodome') {
    seg(shaped(cx, cz, 0xe8eef0), 'geodome', cx, cz, L, L, 0, L / 2);
  }
}
