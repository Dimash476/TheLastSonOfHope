import * as THREE from 'three';
import { CITY } from '../config.js';
import { mulberry32, lerp } from '../utils.js';
import { BLOCK, HALF, blockTypes, MEGA_SITES, DISTRICTS, skylineAt, STADIUM, SUPERS, riverZAt, riverHWAt } from './layout.js';
import { addMegaLandmark, addGiant } from './landmarks.js';

// Застройка Сарыдалы (степная карта). Каждый квартал заполняется по характеру района
// (steppeplan.js → суперкварталы SUPERS): стеклянные башни делового центра, жилые комплексы со
// дворами, сталинки старого центра, панельные микрорайоны, частный сектор, заводы.
// Все здания — обычные секции City (разрушаются как везде). Тип фасада — b.style:
//   1 — панель (швы, лоджии), 2 — сталинка (руст, тяги, сандрики), 3 — жилой комплекс
//   (крупные окна, цветные вставки), 4 — цветное стекло, 5 — торговый центр (глухие
//   стены, рекламный пояс), 6 — школа/больница (ленточные окна), 7 — завод (профлист),
//   8 — частный дом.

const B = CITY.block, M = CITY.road / 2 + CITY.sidewalk, LOT = B - M * 2;   // 76 м внутри квартала
const ST = { panel: 1, stalin: 2, jk: 3, glass: 4, mall: 5, pub: 6, ind: 7, house: 8 };

const PANEL = [0xd9d4c8, 0xcfc6b0, 0xb8c4c8, 0xd8c9a6, 0xc4b9a8, 0xe8d9b0, 0xa9c0cf, 0xd6c0b4];
const STALIN = [0xe6d3a3, 0xdcc8a8, 0xe2c4b0, 0xcfc2a6, 0xd8cdb8, 0xc9b48f, 0xe8dcc0];
const JK = [0xeeeae2, 0xe8dfd0, 0xd6d2cc, 0xc9b8a0, 0xb4b0aa, 0xe4d6c0, 0x9aa0a6];
const GLASS = [0x4f78a8, 0x3f8a8a, 0xb08a3e, 0x8a6a4a, 0x9aa8b4, 0x34424e, 0x4a7a5e, 0x6a8cb8];
const MALL = [0xd8d4cc, 0xbfc4c8, 0xe0d6c4, 0xc8c0b4];
const PUB = [0xeceae4, 0xe6dccb, 0xdfe2e4];
const HOUSE = [0xe9dcc4, 0xd7c3a3, 0xc9d3d8, 0xf0ece4, 0xe2c9a0, 0xbcc9b0, 0xd9b8a0, 0xcfd6c4];
const PROFNASTIL = [0x2f6fa8, 0x3f7a4a, 0x8a2f2a, 0x5a4a40, 0x8a8f94, 0x2a7a7a, 0x6a3a5a];
const BRICK = [0x9c5b45, 0x8a4f3c, 0xa86a50, 0xb07a5a];
const GOLD = 0xd8b048, WHITE = 0xf2efe8;

const pick = (rnd, a) => a[Math.floor(rnd() * a.length)];
const fixed = () => 0.5;

export function generateSteppe(city, rnd) {
  const g = CITY.grid;
  const add = (p, style) => city.addBuilding({ glass: false, ...p, style }, rnd);
  const ctx = { city, rnd, add };

  // Площади: свои доминанты Сарыдалы, бульвары оси, мечеть
  MEGA_SITES.forEach((s, i) => {
    const r = mulberry32(CITY.seed + 900 + i);
    if (LANDMARKS[s.kind]) LANDMARKS[s.kind](city, s, r);
    else addMegaLandmark(city, s, i, r);
  });

  // ТЭЦ — на четырёх кварталах промзоны (2×2), с трубами и градирнями
  const chpI = Math.floor((4550 + HALF) / B), chpJ = Math.floor((-2650 + HALF) / B);
  const skip = new Set();
  if (blockTypes[chpJ * g + chpI] === BLOCK.INDUSTRIAL) {
    for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) skip.add((chpJ + b) * g + chpI + a);
    addCHP(ctx, -HALF + (chpI + 1) * B, -HALF + (chpJ + 1) * B);
  }

  // Застройка по суперкварталам (steppeplan.js → SUPERS): микрорайон, жилой комплекс, деловой
  // квартал, квартал сталинок ставится целиком — одной композицией, без улиц внутри
  const done = new Uint8Array(g * g);
  for (const s of SUPERS) {
    const r = { x0: s.x0 + M, z0: s.z0 + M, x1: s.x1 - M, z1: s.z1 - M };
    const n0 = city.buildings.length;
    if (s.cat === 'ind') {
      for (let a = 0; a < s.w; a++) for (let b = 0; b < s.h; b++) {
        if (skip.has((s.j + b) * g + s.i + a)) continue;
        const k0 = city.buildings.length;
        city.fillIndustrialBlock(-HALF + (s.i + a) * B, -HALF + (s.j + b) * B, rnd);
        for (let k = k0; k < city.buildings.length; k++) city.buildings[k].style = ST.ind;
      }
    } else FILL[s.cat](ctx, r);
    if (s.cat !== 'ind' && s.cat !== 'cbd') plantYard(city, rnd, r, n0);
    for (let a = 0; a < s.w; a++) for (let b = 0; b < s.h; b++) done[(s.j + b) * g + s.i + a] = 1;
  }
  // Остальное — по кварталам: кампус, частный сектор, стадион, монументы на развязках
  for (let i = 0; i < g; i++) for (let j = 0; j < g; j++) {
    const c = j * g + i;
    if (skip.has(c) || done[c]) continue;
    const type = blockTypes[c];
    const bx = -HALF + i * B, bz = -HALF + j * B, cx = bx + B / 2, cz = bz + B / 2;
    if (type === BLOCK.URBAN) city.fillCampusBlock(bx, bz, rnd, Math.hypot(cx - DISTRICTS.campus.x, cz - DISTRICTS.campus.z) < 60);
    else if (type === BLOCK.PRIVATE) fillPrivate(ctx, cx, cz);
    else if (type === BLOCK.STADIUM) city.addStadium(STADIUM.x, STADIUM.z);
    else if (type === BLOCK.ROUND) addMonument(ctx, cx, cz, i * 31 + j);
  }
}

// Деревья во дворе: сетка точек по участку, кроме занятых корпусами (с отступом) и проезда у края
function plantYard(city, rnd, r, n0) {
  const segs = [];
  for (let k = n0; k < city.buildings.length; k++) for (const s of city.buildings[k].segs) { const sg = city.segs[s]; if (sg.y0 < 1) segs.push(sg); }
  for (let x = r.x0 + 9; x < r.x1 - 9; x += 10) for (let z = r.z0 + 9; z < r.z1 - 9; z += 10) {
    if (rnd() < 0.55) continue;
    const px = x + (rnd() - 0.5) * 5, pz = z + (rnd() - 0.5) * 5;
    if (segs.some((s) => Math.abs(px - s.x) < s.w / 2 + 4 && Math.abs(pz - s.z) < s.d / 2 + 4)) continue;
    city.yardTrees.push([px, pz]);
  }
}

// ---------------------------------------------------------------- общие приёмы
// Палитра и эпоха — по району (ячейки ~650 м): соседние кварталы в одной гамме, а не вразнобой
const dhash = (x, z, s) => { const v = Math.sin(Math.floor(x / 650) * 127.1 + Math.floor(z / 650) * 311.7 + s * 74.7) * 43758.5453; return v - Math.floor(v); };
const dpick = (a, x, z, s) => a[Math.floor(dhash(x, z, s) * a.length)];
// Высотность: кластеры делового центра и «нового сити» (skylineAt) и башни вдоль набережной левого берега
function sky(x, z) {
  const w = z - riverZAt(x) - riverHWAt(x);
  const river = w > 60 && w < 560 && Math.abs(x) < 3600 ? 0.6 * (1 - Math.abs(w - 260) / 300) : 0;
  return Math.max(skylineAt(x, z), river);
}
// Корпуса суперквартала ставятся без пересечений и не выходят за участок (gap — зазор, < 0 — впритык)
function placer(ctx, r) {
  const used = [];
  const fits = (x, z, w, d, gap) => x - w / 2 >= r.x0 - 0.01 && x + w / 2 <= r.x1 + 0.01 && z - d / 2 >= r.z0 - 0.01 && z + d / 2 <= r.z1 + 0.01
    && !used.some((u) => Math.abs(x - u.x) < (w + u.w) / 2 + gap && Math.abs(z - u.z) < (d + u.d) / 2 + gap);
  const put = (p, style, gap = 8) => {
    if (!fits(p.x, p.z, p.w, p.d, gap)) return false;
    used.push({ x: p.x, z: p.z, w: p.w, d: p.d });
    ctx.add(p, style);
    return true;
  };
  return { put, fits };
}
// Корпуса вдоль сторон участка с проходами: секции длиной len(), разрывы gapF();
// стороны вдоль X идут от угла до угла (с отступом cx), вдоль Z — между ними (отступ cz)
function perimeter(P, r, inset, depth, len, gapF, make, cx, cz) {
  const sides = [
    { ax: 1, a0: r.x0 + cx, a1: r.x1 - cx, c: r.z0 + inset + depth / 2 },
    { ax: 1, a0: r.x0 + cx, a1: r.x1 - cx, c: r.z1 - inset - depth / 2 },
    { ax: 0, a0: r.z0 + cz, a1: r.z1 - cz, c: r.x0 + inset + depth / 2 },
    { ax: 0, a0: r.z0 + cz, a1: r.z1 - cz, c: r.x1 - inset - depth / 2 },
  ];
  sides.forEach((s, si) => {
    let a = s.a0;
    while (s.a1 - a >= 24) {
      let L = Math.min(len(), s.a1 - a);
      if (s.a1 - a - L < 30) L = s.a1 - a;   // хвост короче секции — продлеваем до угла
      const m = a + L / 2, p = make(si, L);
      P.put(s.ax ? { x: m, z: s.c, w: L, d: depth, ...p.b } : { x: s.c, z: m, w: depth, d: L, ...p.b }, p.style, p.gap ?? 2);
      a += L + gapF();
    }
  });
}
// Замкнутый двор: секции впритык по четырём сторонам (стороны вдоль Z — между угловыми), open — открытая сторона
function ring(P, q, depth, open, nPart, mk) {
  const W = q.x1 - q.x0, D = q.z1 - q.z0, mx = (q.x0 + q.x1) / 2, mz = (q.z0 + q.z1) / 2;
  const sides = [
    { x: mx, z: q.z0 + depth / 2, len: W, ax: 1 },
    { x: mx, z: q.z1 - depth / 2, len: W, ax: 1 },
    { x: q.x0 + depth / 2, z: mz, len: D - depth * 2, ax: 0 },
    { x: q.x1 - depth / 2, z: mz, len: D - depth * 2, ax: 0 },
  ];
  sides.forEach((s, si) => {
    if (si === open || s.len < 12) return;
    const n = nPart(s.len), part = s.len / n;
    for (let k = 0; k < n; k++) {
      const off = -s.len / 2 + part * (k + 0.5), p = mk(si, k, n);
      P.put({ x: s.ax ? s.x + off : s.x, z: s.ax ? s.z : s.z + off, w: s.ax ? part : depth, d: s.ax ? depth : part, ...p.b }, p.style, -0.5);
    }
  });
}
// Башня делового центра на подиуме: круглая с венцом, витая или призма с уступами и стеклянной короной
function tower({ city, rnd, add }, x, z, w, h, podH, color) {
  const shape = rnd();
  if (shape < 0.2) {
    const b = city.newBuilding({ kind: 'building', x, z, color, glass: true });
    b.shaped = true;
    const n = Math.max(4, Math.round(h / 16)), sh = h / n;
    for (let k = 0; k < n; k++) city.addSeg(b, { x, z, w, d: w, y0: podH + k * sh, h: sh, type: 'shape', shape: 'round' });
    city.addSeg(b, { x, z, w: w * 1.02, d: w * 1.02, y0: podH + h, h: 10, type: 'shape', shape: 'crown' });
  } else if (shape < 0.34) {
    const b = city.newBuilding({ kind: 'building', x, z, color, glass: true });
    b.shaped = true;
    const n = Math.max(5, Math.round(h / 14)), sh = h / n;
    for (let k = 0; k < n; k++) city.addSeg(b, { x, z, w: w * 0.92, d: w * 0.92, y0: podH + k * sh, h: sh, type: 'shape', shape: 'twist', rot: k * 0.21 });
  } else {
    const d = w * (0.8 + rnd() * 0.45);
    const tiers = rnd() < 0.6 ? [{ at: h * (0.55 + rnd() * 0.15), k: 0.82 }, { at: h * (0.82 + rnd() * 0.08), k: 0.64 }] : null;
    add({ x, z, w, d, h, y0: podH, color, tiers, roof: tiers ? null : 'box' }, ST.glass);
    if (h > 150 && rnd() < 0.55) {
      const k = tiers ? 0.64 : 1;
      const cb = city.newBuilding({ kind: 'building', x, z, color, glass: true });
      cb.shaped = true;
      city.addSeg(cb, { x, z, w: w * k, d: d * k, y0: podH + h, h: 22, type: 'shape', shape: 'pyramid' });
    }
  }
}

// ---------------------------------------------------------------- деловой центр
// Башни на подиумах почти в каждой ячейке, самая высокая — первая; иногда пара башен-близнецов
// на общем подиуме; остальное — офисные корпуса средней высоты. Высота — по кластеру (до ~340 м)
function fillCBDBlock(ctx, r) {
  const { rnd } = ctx, P = placer(ctx, r);
  const W = r.x1 - r.x0, D = r.z1 - r.z0, cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
  const hMax = lerp(80, 340, Math.min(1, sky(cx, cz)));
  const color = dpick(GLASS, cx, cz, 6), alt = pick(rnd, GLASS);
  const nx = Math.max(1, Math.round(W / 80)), nz = Math.max(1, Math.round(D / 80)), cw = W / nx, cd = D / nz;
  const spots = [];
  for (let a = 0; a < nx; a++) for (let b = 0; b < nz; b++) spots.push({ x: r.x0 + cw * (a + 0.5), z: r.z0 + cd * (b + 0.5), o: rnd() });
  spots.sort((p, q) => p.o - q.o);
  const n = Math.max(1, Math.round(spots.length * (0.7 + 0.3 * rnd())));
  spots.forEach((s, q) => {
    if (q < n) {
      const h = Math.max(55, hMax * (q === 0 ? 0.82 + 0.18 * rnd() : 0.38 + 0.45 * rnd()));
      const podH = 8 + Math.floor(rnd() * 3) * 4;
      if (q > 0 && cw > 70 && rnd() < 0.2) {
        // Близнецы: две одинаковые башни на одном подиуме
        const w = Math.min(cw * 0.26, 22), pw = Math.min(cw - 4, w * 3.2), pd = Math.min(cd - 4, w * 1.5), c = rnd() < 0.6 ? color : alt;
        if (P.put({ x: s.x, z: s.z, w: pw, d: pd, h: podH, color: pick(rnd, MALL), roof: null }, ST.mall, 2)) {
          for (const sx of [-1, 1]) ctx.add({ x: s.x + sx * w * 0.85, z: s.z, w, d: w, h: h * 0.85, y0: podH, color: c, roof: 'box', tiers: [{ at: h * 0.72, k: 0.8 }] }, ST.glass);
        }
        return;
      }
      const w = Math.min(cw, cd) * 0.4 + rnd() * 6;
      const pw = Math.min(cw - 4, w * 1.9), pd = Math.min(cd - 4, w * 1.6);
      if (P.put({ x: s.x, z: s.z, w: pw, d: pd, h: podH, color: pick(rnd, MALL), roof: null }, ST.mall, 2)) tower(ctx, s.x, s.z, w, h, podH, rnd() < 0.7 ? color : alt);
    } else if (rnd() < 0.95) {
      const along = rnd() < 0.5, h = 28 + rnd() * 50;
      P.put({ x: s.x, z: s.z, w: along ? cw * 0.75 : 24, d: along ? 24 : cd * 0.75, h, color: rnd() < 0.5 ? color : pick(rnd, GLASS), roof: 'box' }, ST.glass, 2);
    }
  });
  // Между башнями — низкие павильоны и вход в паркинг
  for (let t = 0; t < spots.length; t++) {
    const x = r.x0 + 12 + rnd() * (W - 24), z = r.z0 + 12 + rnd() * (D - 24);
    P.put({ x, z, w: 14 + rnd() * 10, d: 10 + rnd() * 6, h: 5 + rnd() * 3, color: pick(rnd, MALL), roof: 'box' }, ST.mall, 6);
  }
}

// ---------------------------------------------------------------- жилые комплексы
// Четыре вида комплексов (по району, соседние похожи): замкнутые дворы ~95 м, башни на
// стилобате, «гребёнка» — параллельные корпуса-каскады, и дворы буквой П с уступами
function fillJKComplex(ctx, r) {
  const { rnd } = ctx;
  const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
  const v = (dhash(cx, cz, 20) + rnd() * 0.5) % 1;
  if (v < 0.4) jkRings(ctx, r);
  else if (v < 0.62) jkStylobate(ctx, r);
  else if (v < 0.82) jkComb(ctx, r);
  else jkCascade(ctx, r);
}
function jkParams(r) {
  const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
  const k = Math.min(1, sky(cx, cz) * 1.3);
  return { k, base: lerp(30, 66, k), c1: dpick(JK, cx, cz, 3), c2: dpick(JK, cx, cz, 4) };
}
function jkRings(ctx, r) {
  const { rnd } = ctx, P = placer(ctx, r);
  const W = r.x1 - r.x0, D = r.z1 - r.z0, { k, base, c1, c2 } = jkParams(r);
  const nx = Math.max(1, Math.round(W / 95)), nz = Math.max(1, Math.round(D / 95)), cw = W / nx, cd = D / nz;
  const towers = 1 + Math.floor(rnd() * (nx * nz > 2 ? 4 : 2));
  for (let t = 0; t < towers; t++) {
    const a = Math.floor(rnd() * nx), b = Math.floor(rnd() * nz), w = 22 + rnd() * 6;
    const x = r.x0 + cw * a + (rnd() < 0.5 ? w / 2 + 2 : cw - w / 2 - 2), z = r.z0 + cd * b + (rnd() < 0.5 ? w / 2 + 2 : cd - w / 2 - 2);
    const h = base + 35 + rnd() * (40 + 100 * k);
    P.put({ x, z, w, d: w, h, color: rnd() < 0.7 ? c1 : c2, roof: 'box', tiers: h > 110 ? [{ at: h * 0.82, k: 0.86 }] : null }, ST.jk, 1);
  }
  for (let a = 0; a < nx; a++) for (let b = 0; b < nz; b++) {
    const q = { x0: r.x0 + cw * a + 2, z0: r.z0 + cd * b + 2, x1: r.x0 + cw * (a + 1) - 2, z1: r.z0 + cd * (b + 1) - 2 };
    const open = Math.floor(rnd() * 7), step = Math.floor(rnd() * 4);   // открытая сторона (если < 4); сторона, где дом ниже
    ring(P, q, 15, open, (L) => Math.max(1, Math.round(L / 34)), (si, kk) => ({
      b: { h: Math.max(15, base + (si === step ? -12 : 0) + ((kk + si) % 3) * 6 - 6), color: rnd() < 0.85 ? c1 : c2, roof: 'box' }, style: ST.jk,
    }));
    // Во дворе — детский сад или подземный паркинг с павильоном
    const mx = (q.x0 + q.x1) / 2, mz = (q.z0 + q.z1) / 2;
    if (rnd() < 0.35) P.put({ x: mx, z: mz, w: 26, d: 16, h: 7, color: pick(rnd, [0xf2e6c8, 0xe8d0c8, 0xd8e4cc]), roof: 'box' }, ST.pub, 6);
  }
}
function jkStylobate(ctx, r) {
  // Стилобат на два этажа (магазины, паркинг) и на нём 3–6 башен по 25–40 этажей
  const { rnd, add } = ctx, P = placer(ctx, r);
  const W = r.x1 - r.x0, D = r.z1 - r.z0, cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2, { k, base, c1, c2 } = jkParams(r);
  const sw = W - 16, sd = D - 16, podH = 8;
  const nx = Math.max(1, Math.round(sw / 60)), nz = Math.max(1, Math.round(sd / 60));
  const accent = pick(rnd, GLASS);
  for (let a = 0; a < nx; a++) for (let b = 0; b < nz; b++) {
    if (nx * nz > 2 && rnd() < 0.25) continue;
    const w = 20 + rnd() * 6, d = w * (0.8 + rnd() * 0.4);
    const x = cx - sw / 2 + sw / nx * (a + 0.5) + (rnd() - 0.5) * 8, z = cz - sd / 2 + sd / nz * (b + 0.5) + (rnd() - 0.5) * 8;
    const h = base + 30 + rnd() * (50 + 70 * k);
    // свой подиум у каждой башни (магазины, вход в паркинг), между ними — зелёный двор
    if (!P.put({ x, z, w: Math.min(sw / nx - 4, w * 1.9), d: Math.min(sd / nz - 4, d * 1.7), h: podH, color: pick(rnd, MALL), roof: null }, ST.mall, 4)) continue;
    add({ x, z, w: Math.min(w, sw / nx - 6), d: Math.min(d, sd / nz - 6), h, y0: podH, color: rnd() < 0.75 ? c1 : c2, roof: 'box', tiers: rnd() < 0.5 ? [{ at: h * 0.85, k: 0.84 }] : null }, ST.jk);
    // Стеклянная «шапка» у части башен
    if (rnd() < 0.3) add({ x, z, w: w * 0.7, d: d * 0.7, h: 8, y0: podH + h, color: accent, roof: null, glass: true }, ST.glass);
  }
}
function jkComb(ctx, r) {
  // Гребёнка: параллельные корпуса поперёк длинной стороны, высота растёт каскадом к одному
  // концу; вдоль улицы их связывает низкий торговый корпус
  const { rnd } = ctx, P = placer(ctx, r);
  const W = r.x1 - r.x0, D = r.z1 - r.z0, { k, base, c1, c2 } = jkParams(r);
  const alongX = W >= D, L = alongX ? W : D, S = alongX ? D : W;
  const s0 = alongX ? r.z0 : r.x0, l0 = alongX ? r.x0 : r.z0, up = rnd() < 0.5;
  // торговый корпус вдоль одной длинной стороны
  const fs = s0 + 8;
  P.put(alongX ? { x: (r.x0 + r.x1) / 2, z: fs, w: L - 10, d: 14, h: 7, color: pick(rnd, MALL), roof: 'box' } : { x: fs, z: (r.z0 + r.z1) / 2, w: 14, d: L - 10, h: 7, color: pick(rnd, MALL), roof: 'box' }, ST.mall, 0);
  const n = Math.max(2, Math.floor((L - 10) / 34));
  for (let q = 0; q < n; q++) {
    const u = l0 + 5 + (L - 10) / n * (q + 0.5), len = S - 30;
    const nSec = Math.max(1, Math.round(len / 30));
    for (let t = 0; t < nSec; t++) {
      const v = s0 + 22 + len / nSec * (t + 0.5);
      const tt = up ? t / Math.max(1, nSec - 1) : 1 - t / Math.max(1, nSec - 1);
      const h = Math.max(18, base * 0.6 + tt * (base * 0.8 + 40 * k));
      P.put(alongX ? { x: u, z: v, w: 15, d: len / nSec + 0.5, h, color: (q + t) % 4 === 0 ? c2 : c1, roof: 'box' } : { x: v, z: u, w: len / nSec + 0.5, d: 15, h, color: (q + t) % 4 === 0 ? c2 : c1, roof: 'box' }, ST.jk, -1);
    }
  }
}
function jkCascade(ctx, r) {
  // Дворы буквой П: открытой стороной к солнцу (на юг), высота уступами от 6 до 20 этажей
  const { rnd } = ctx, P = placer(ctx, r);
  const W = r.x1 - r.x0, D = r.z1 - r.z0, { k, base, c1, c2 } = jkParams(r);
  const nx = Math.max(1, Math.round(W / 85)), nz = Math.max(1, Math.round(D / 85)), cw = W / nx, cd = D / nz;
  const hi = base + 20 + 30 * k, lo = 18;
  for (let a = 0; a < nx; a++) for (let b = 0; b < nz; b++) {
    const q = { x0: r.x0 + cw * a + 3, z0: r.z0 + cd * b + 3, x1: r.x0 + cw * (a + 1) - 3, z1: r.z0 + cd * (b + 1) - 3 };
    ring(P, q, 14, 1, (L) => Math.max(2, Math.round(L / 22)), (si, kk, nn) => {
      // задняя сторона — самая высокая, боковые спускаются к открытой
      const t = si === 0 ? 1 : si === 2 || si === 3 ? 1 - (kk + 0.5) / nn : 0.3;
      return { b: { h: lo + (hi - lo) * t, color: si === 0 && rnd() < 0.5 ? c2 : c1, roof: 'box' }, style: ST.jk };
    });
  }
}

// ---------------------------------------------------------------- старый центр
// Сталинки сплошным периметром вокруг всего квартала, высота ступенями, угловая башня со шпилем;
// в глубине — флигели, кирпичные пятиэтажки или школа. Иногда квартал кирпичных «хрущёвок»
function fillOldBlock(ctx, r) {
  const { city, rnd, add } = ctx, P = placer(ctx, r);
  const W = r.x1 - r.x0, D = r.z1 - r.z0, cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
  const brick = dpick(BRICK, cx, cz, 11);
  if (dhash(cx, cz, 21) < 0.25 && rnd() < 0.8) {
    // Кирпичные пятиэтажки: строчки с двором-сквером посередине
    const alongX = W >= D;
    perimeter(P, r, 3, 12, () => 50 + rnd() * 20, () => 12 + rnd() * 8, () => ({ b: { h: 15, color: brick, roof: 'box' }, style: 0, gap: 6 }), 0, 24);
    for (let v = (alongX ? r.z0 : r.x0) + 36; v < (alongX ? r.z1 : r.x1) - 34; v += 30) {
      for (let u = (alongX ? r.x0 : r.z0) + 34; u < (alongX ? r.x1 : r.z1) - 34; u += 62) {
        P.put(alongX ? { x: u, z: v, w: 52, d: 12, h: 15, color: brick, roof: 'box' } : { x: v, z: u, w: 12, d: 52, h: 15, color: brick, roof: 'box' }, 0, 8);
      }
    }
    return;
  }
  const color = dpick(STALIN, cx, cz, 9), h = 17 + Math.floor(dhash(cx, cz, 10) * 3) * 3.5;
  ring(P, r, 13, 9, (L) => Math.max(1, Math.round(L / 38)), (si, kk) => ({ b: { h: h + ((kk * 7 + si * 3) % 4 === 0 ? 3.5 : 0), color, roof: null }, style: ST.stalin }));
  const corners = W > 120 || D > 120 ? 1 + (rnd() < 0.5) : rnd() < 0.25 ? 1 : 0;
  for (let t = 0; t < corners; t++) {
    const sx = rnd() < 0.5 ? -1 : 1, sz = rnd() < 0.5 ? -1 : 1, w = 15;
    const x = sx < 0 ? r.x0 + w / 2 : r.x1 - w / 2, z = sz < 0 ? r.z0 + w / 2 : r.z1 - w / 2;
    add({ x, z, w, d: w, h: h + 14, color, roof: null }, ST.stalin);
    const b = city.newBuilding({ kind: 'building', x, z, color: 0x5a6a5a, glass: false });
    b.shaped = true;
    city.addSeg(b, { x, z, w: w * 0.8, d: w * 0.8, y0: h + 14, h: 16, type: 'shape', shape: 'spire' });
  }
  if (W > 140 || D > 140) {
    const alongX = W >= D;
    for (let v = (alongX ? r.z0 : r.x0) + 38; v < (alongX ? r.z1 : r.x1) - 36; v += 30) {
      for (let u = (alongX ? r.x0 : r.z0) + 40; u < (alongX ? r.x1 : r.z1) - 40; u += 62) {
        P.put(alongX ? { x: u, z: v, w: 52, d: 12, h: 15, color: brick, roof: 'box' } : { x: v, z: u, w: 12, d: 52, h: 15, color: brick, roof: 'box' }, 0, 8);
      }
    }
  } else {
    // Флигель во дворе и гаражи
    P.put(W >= D ? { x: cx, z: cz, w: Math.max(12, W - 44), d: 11, h: 10, color, roof: null } : { x: cx, z: cz, w: 11, d: Math.max(12, D - 44), h: 10, color, roof: null }, ST.stalin, 7);
  }
}

// ---------------------------------------------------------------- среднеэтажные кварталы
// Торговый центр с парковкой и гостиницей, больничный городок, базар, офисный парк, таунхаусы
// или дома 5–12 этажей по периметру со школой и домами-точками во дворе
function fillMidBlock(ctx, r) {
  const { rnd } = ctx, P = placer(ctx, r);
  const W = r.x1 - r.x0, D = r.z1 - r.z0, cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
  const t = rnd(), big = W * D > 20000, tech = Math.hypot(cx - DISTRICTS.techpark.x, cz - DISTRICTS.techpark.z) < DISTRICTS.techpark.r + 150;
  if (tech || (big && t < 0.12)) {
    // Офисный парк: стеклянные корпуса 6–16 этажей вокруг общей площади
    const nx = Math.max(1, Math.round(W / 60)), nz = Math.max(1, Math.round(D / 60)), c = dpick(GLASS, cx, cz, 15);
    for (let a = 0; a < nx; a++) for (let b = 0; b < nz; b++) {
      if (rnd() < 0.15) continue;
      const x = r.x0 + W / nx * (a + 0.5), z = r.z0 + D / nz * (b + 0.5), w = Math.min(W / nx - 12, 26 + rnd() * 14), d = Math.min(D / nz - 12, 20 + rnd() * 12);
      P.put({ x, z, w, d, h: 22 + rnd() * 30, color: rnd() < 0.7 ? c : pick(rnd, GLASS), roof: 'box', tiers: rnd() < 0.3 ? [{ at: 30, k: 0.8 }] : null }, ST.glass, 8);
    }
    return;
  }
  if (big && t < 0.32) {
    const mw = Math.min(W - 24, 160), md = Math.min(D - 44, 100);
    P.put({ x: cx, z: r.z0 + md / 2 + 6, w: mw, d: md, h: 15 + rnd() * 6, color: pick(rnd, MALL), roof: 'box' }, ST.mall, 0);
    P.put({ x: r.x1 - 16, z: r.z1 - 16, w: 24, d: 24, h: 50 + rnd() * 45, color: pick(rnd, GLASS), roof: 'box' }, ST.glass, 6);
    P.put({ x: r.x0 + 16, z: r.z1 - 16, w: 26, d: 20, h: 8, color: pick(rnd, MALL), roof: 'box' }, ST.mall, 6);
    return;
  }
  if (big && t < 0.42) {
    const pc = pick(rnd, PUB);
    P.put({ x: cx, z: cz - 20, w: Math.min(W - 30, 110), d: 16, h: 30 + rnd() * 9, color: pc, roof: 'box' }, ST.pub, 0);
    P.put({ x: cx - 30, z: cz + 22, w: 44, d: 28, h: 12, color: pc, roof: 'box' }, ST.pub, 6);
    P.put({ x: cx + 34, z: cz + 22, w: 36, d: 24, h: 9, color: pc, roof: 'box' }, ST.pub, 6);
    perimeter(P, r, 2, 12, () => 40 + rnd() * 20, () => 14 + rnd() * 10, () => ({ b: { h: 15, color: pc, roof: 'box' }, style: ST.pub, gap: 8 }), 0, 22);
    return;
  }
  if (t < 0.5) {
    // Базар: крытый рынок под двускатной крышей и ряды палаток вокруг
    const hw = Math.min(W - 30, 90), hd = Math.min(D - 30, 46);
    P.put({ x: cx, z: cz, w: hw, d: hd, h: 11, color: pick(rnd, [0xd8cdb8, 0xc9b8a0, 0xe0d6c4]), roof: 'gable', ridge: hw > hd ? 'x' : 'z', roofColor: pick(rnd, PROFNASTIL) }, ST.mall, 0);
    for (let x = r.x0 + 6; x < r.x1 - 6; x += 7) for (const z of [r.z0 + 6, r.z1 - 6]) {
      if (rnd() < 0.2) continue;
      P.put({ x, z, w: 5.5, d: 4.5, h: 3, color: pick(rnd, [0xe6e0d4, 0x3f7a8a, 0xc8a050, 0xa84a3a, 0x6a8a4a]), roof: 'box' }, ST.mall, 0.8);
    }
    for (let z = r.z0 + 16; z < r.z1 - 16; z += 7) for (const x of [r.x0 + 6, r.x1 - 6]) {
      if (rnd() < 0.25) continue;
      P.put({ x, z, w: 4.5, d: 5.5, h: 3, color: pick(rnd, [0xe6e0d4, 0x3f7a8a, 0xc8a050, 0xa84a3a]), roof: 'box' }, ST.mall, 0.8);
    }
    return;
  }
  if (t < 0.62) {
    // Таунхаусы: ряды трёхэтажных домов с двускатными крышами
    const alongX = W >= D, c = dpick(HOUSE, cx, cz, 16), roofC = dpick(PROFNASTIL, cx, cz, 17);
    for (let v = (alongX ? r.z0 : r.x0) + 8; v < (alongX ? r.z1 : r.x1) - 8; v += 22) {
      for (let u = (alongX ? r.x0 : r.z0) + 4; u < (alongX ? r.x1 : r.z1) - 30; u += 46) {
        P.put(alongX ? { x: u + 21, z: v, w: 42, d: 10, h: 9, color: rnd() < 0.7 ? c : pick(rnd, HOUSE), roof: 'gable', ridge: 'x', roofColor: roofC } : { x: v, z: u + 21, w: 10, d: 42, h: 9, color: rnd() < 0.7 ? c : pick(rnd, HOUSE), roof: 'gable', ridge: 'z', roofColor: roofC }, ST.house, 2);
      }
    }
    return;
  }
  const kind = dhash(cx, cz, 12), style = kind < 0.45 ? ST.jk : kind < 0.75 ? ST.stalin : ST.panel;
  const pal = style === ST.jk ? JK : style === ST.stalin ? STALIN : PANEL;
  const c1 = dpick(pal, cx, cz, 13), c2 = dpick(pal, cx, cz, 14);
  if (big) {
    const pc = pick(rnd, PUB);
    P.put({ x: cx, z: cz - 12, w: 60, d: 14, h: 12, color: pc, roof: 'box' }, ST.pub, 20);
    P.put({ x: cx - 23, z: cz + 8, w: 14, d: 26, h: 12, color: pc, roof: null }, ST.pub, -0.5);
    P.put({ x: cx + 23, z: cz + 8, w: 14, d: 26, h: 12, color: pc, roof: null }, ST.pub, -0.5);
  }
  perimeter(P, r, 2, 14, () => 30 + rnd() * 32, () => 6 + rnd() * 10,
    () => ({ b: { h: style === ST.stalin ? 15 + rnd() * 9 : 15 + rnd() * 24, color: rnd() < 0.8 ? c1 : c2, roof: 'box' }, style }), 0, 22);
  // Во дворе — дома-точки
  for (let k = 0, n = Math.round(W * D / 4500); k < n; k++) {
    const x = r.x0 + 30 + rnd() * Math.max(1, W - 60), z = r.z0 + 30 + rnd() * Math.max(1, D - 60);
    P.put({ x, z, w: 18, d: 18, h: 24 + rnd() * 18, color: rnd() < 0.6 ? c1 : c2, roof: 'box' }, style, 12);
  }
}

// ---------------------------------------------------------------- панельные микрорайоны
// Микрорайон целиком: длинные корпуса вдоль улиц с проходами во двор, «свечки» на углах,
// в глубине — школа буквой П и детский сад; внутри строчные ряды пятиэтажек или
// точечные башни, гаражи и магазинчики. У поздних — иногда «лежачий небоскрёб» на всю
// сторону. Эпоха и цвет — общие для района
function fillPanelMD(ctx, r) {
  const { rnd } = ctx, P = placer(ctx, r);
  const W = r.x1 - r.x0, D = r.z1 - r.z0, cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
  const era = Math.floor(dhash(cx, cz, 5) * 3);    // 0 — пятиэтажки, 1 — девятиэтажки, 2 — поздние, с башнями
  const c1 = dpick(PANEL, cx, cz, 1), c2 = dpick(PANEL, cx, cz, 2);
  const H = [[15, 15, 15], [27, 27, 36], [27, 36, 48]][era];
  if (W > 150 && D > 150) {
    const pc = pick(rnd, PUB), sx = cx + (rnd() - 0.5) * W * 0.2, sz = cz + (rnd() - 0.5) * D * 0.2;
    P.put({ x: sx, z: sz - 14, w: 64, d: 14, h: 12, color: pc, roof: 'box' }, ST.pub, 24);
    P.put({ x: sx - 25, z: sz + 6, w: 14, d: 26, h: 12, color: pc, roof: null }, ST.pub, -0.5);
    P.put({ x: sx + 25, z: sz + 6, w: 14, d: 26, h: 12, color: pc, roof: null }, ST.pub, -0.5);
    const kx = cx + (sx < cx ? 1 : -1) * W * 0.24, kz = cz + (sz < cz ? 1 : -1) * D * 0.18;
    P.put({ x: kx, z: kz, w: 36, d: 22, h: 7, color: pick(rnd, [0xf2e6c8, 0xe8d0c8, 0xd8e4cc]), roof: 'box' }, ST.pub, 14);
  } else if (W * D > 14000 && rnd() < 0.5) {
    P.put({ x: cx, z: cz, w: 34, d: 20, h: 7, color: pick(rnd, [0xf2e6c8, 0xe8d0c8, 0xd8e4cc]), roof: 'box' }, ST.pub, 14);
  }
  if (era > 0) for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    if (rnd() < 0.35) continue;
    P.put({ x: sx < 0 ? r.x0 + 12 : r.x1 - 12, z: sz < 0 ? r.z0 + 12 : r.z1 - 12, w: 18, d: 18, h: era === 2 ? 48 + rnd() * 18 : 36 + rnd() * 12, color: c2, roof: 'box' }, ST.panel, 4);
  }
  const long = era === 2 && rnd() < 0.35;
  perimeter(P, r, 3, long ? 14 : 12.5, () => (long ? 1000 : era === 0 ? 55 + rnd() * 25 : 70 + rnd() * 70), () => 12 + rnd() * 12,
    () => ({ b: { h: long ? 48 : H[Math.floor(rnd() * 3)], color: rnd() < 0.8 ? c1 : c2, roof: 'box' }, style: ST.panel, gap: 6 }), long ? 4 : 0, 30);
  if (era === 0 || rnd() < 0.5) {
    // Строчная застройка: параллельные ряды корпусов
    const alongX = W >= D;
    for (let v = (alongX ? r.z0 : r.x0) + 40; v < (alongX ? r.z1 : r.x1) - 36; v += 31) {
      for (let u = (alongX ? r.x0 : r.z0) + 40; u < (alongX ? r.x1 : r.z1) - 38; u += 64 + rnd() * 8) {
        const L = 52 + rnd() * 12, h = H[Math.floor(rnd() * 3)];
        P.put(alongX ? { x: u, z: v, w: L, d: 12, h, color: c1, roof: 'box' } : { x: v, z: u, w: 12, d: L, h, color: c1, roof: 'box' }, ST.panel, 8);
      }
    }
  } else {
    for (let t = 0, n = Math.round(W * D / 3400); t < n; t++) {
      const x = r.x0 + 36 + rnd() * Math.max(1, W - 72), z = r.z0 + 36 + rnd() * Math.max(1, D - 72);
      P.put({ x, z, w: 20, d: 20, h: H[2] + rnd() * 18, color: rnd() < 0.5 ? c1 : c2, roof: 'box' }, ST.panel, 14);
    }
  }
  // Гаражи рядами и магазинчики-павильоны в свободных местах
  const gar = [0x8a8a86, 0x7a6a5a, 0x9a8a78, 0x6a7a80];
  for (let t = 0, n = Math.round(W * D / 9000); t < n; t++) {
    const x = r.x0 + 20 + rnd() * Math.max(1, W - 40), z = r.z0 + 20 + rnd() * Math.max(1, D - 40), ax = rnd() < 0.5;
    if (rnd() < 0.5) P.put(ax ? { x, z, w: 36, d: 6, h: 3, color: pick(rnd, gar), roof: null } : { x, z, w: 6, d: 36, h: 3, color: pick(rnd, gar), roof: null }, 0, 6);
    else P.put({ x, z, w: 16 + rnd() * 6, d: 10 + rnd() * 4, h: 4.5, color: pick(rnd, MALL), roof: 'box' }, ST.mall, 6);
  }
}

const FILL = { cbd: fillCBDBlock, jk: fillJKComplex, old: fillOldBlock, mid: fillMidBlock, panel: fillPanelMD };

// ---------------------------------------------------------------- частный сектор
// Участки 19×38 м (как разметка земли): дом у улицы, баня или сарай в глубине
function fillPrivate({ rnd, add }, cx, cz) {
  for (let a = 0; a < 4; a++) for (let b = 0; b < 2; b++) {
    if (rnd() < 0.12) continue;
    const px = cx - 38 + 19 * (a + 0.5), front = b === 0 ? -1 : 1;
    const big = rnd() < 0.18;
    const w = big ? 12 : 7.5 + rnd() * 3, d = big ? 10 : 6.5 + rnd() * 2.5, h = big ? 6.8 : rnd() < 0.25 ? 6 : 3.4 + rnd() * 0.8;
    const pz = cz + front * (38 - 4 - d / 2);
    const color = big && rnd() < 0.5 ? pick(rnd, BRICK) : pick(rnd, HOUSE);
    add({ x: px + (rnd() - 0.5) * 3, z: pz, w, d, h, color, roof: 'gable', ridge: 'x', roofColor: pick(rnd, PROFNASTIL) }, ST.house);
    if (rnd() < 0.55) add({ x: px + (rnd() - 0.5) * 8, z: cz + front * (6 + rnd() * 6), w: 3.5 + rnd() * 2, d: 3 + rnd() * 2, h: 2.6, color: pick(rnd, [0x8a6a4a, 0x9a9a92, 0x7a5a40]), roof: 'gable', roofColor: pick(rnd, PROFNASTIL) }, ST.house);
  }
}

// ---------------------------------------------------------------- ТЭЦ
// Главный корпус, котельная, две полосатые трубы и две градирни (видны из любой точки)
function addCHP({ city, rnd, add }, cx, cz) {
  add({ x: cx - 30, z: cz + 30, w: 90, d: 44, h: 34, color: 0xb9b4aa, roof: 'box' }, ST.ind);
  add({ x: cx - 30, z: cz - 10, w: 50, d: 30, h: 56, color: 0xa8a49a, roof: 'box' }, ST.ind);
  for (const [ox, H] of [[-62, 180], [-40, 150]]) {
    const b = city.newBuilding({ kind: 'building', x: cx + ox, z: cz - 40, color: WHITE, glass: false });
    b.shaped = true;
    const n = 12, sh = H / n;
    for (let k = 0; k < n; k++) {
      const sg = city.addSeg(b, { x: cx + ox, z: cz - 40, w: 11 - k * 0.4, d: 11 - k * 0.4, y0: k * sh, h: sh, type: 'shape', shape: 'pillar' });
      sg.color = new THREE.Color(k % 2 ? 0xc8402e : 0xeeeae2);
    }
  }
  // Градирни: стопка колец разного диаметра — силуэт гиперболоида
  const prof = [70, 62, 55, 50, 47, 46, 48, 52];
  for (const [ox, oz] of [[40, -45], [40, 40]]) {
    const b = city.newBuilding({ kind: 'building', x: cx + ox, z: cz + oz, color: 0xb8b4ac, glass: false });
    b.shaped = true;
    prof.forEach((D, k) => city.addSeg(b, { x: cx + ox, z: cz + oz, w: D, d: D, y0: k * 11, h: 11, type: 'shape', shape: 'pillar' }));
  }
}

// ---------------------------------------------------------------- монументы на развязках
function addMonument({ city }, cx, cz, seed) {
  const r = mulberry32(seed + 77);
  const kind = Math.floor(r() * 4);
  const b = city.newBuilding({ kind: 'building', x: cx, z: cz, color: 0xd9d3c7, glass: false });
  b.shaped = true;
  city.addSeg(b, { x: cx, z: cz, w: 15, d: 15, y0: 0, h: 2, type: 'shape', shape: 'pillar' });
  if (kind === 0) {
    // Стела с золотым навершием
    for (let k = 0; k < 4; k++) city.addSeg(b, { x: cx, z: cz, w: 4 - k * 0.6, d: 4 - k * 0.6, y0: 2 + k * 8, h: 8, type: 'shape', shape: 'pillar' });
    addGiant(city, b, 'bullet', cx, cz, 2.2, 34, GOLD);
  } else if (kind === 1) {
    // Глобус на постаменте
    city.addSeg(b, { x: cx, z: cz, w: 6, d: 6, y0: 2, h: 8, type: 'shape', shape: 'pillar' });
    addGiant(city, b, 'orb', cx, cz, 11, 10, 0x5a8ab8);
  } else if (kind === 2) {
    // Обелиск
    city.addSeg(b, { x: cx, z: cz, w: 4, d: 4, y0: 2, h: 26, type: 'concrete' });
    city.addSeg(b, { x: cx, z: cz, w: 4, d: 4, y0: 28, h: 5, type: 'shape', shape: 'spire' });
  } else {
    // Арка-«шанырак»: кольцо на четырёх опорах
    for (const [ox, oz] of [[-5, -5], [5, -5], [-5, 5], [5, 5]]) city.addSeg(b, { x: cx + ox, z: cz + oz, w: 1.4, d: 1.4, y0: 2, h: 14, type: 'shape', shape: 'pillar' });
    addGiant(city, b, 'saucer', cx, cz, 16, 16, GOLD);
  }
}

// ---------------------------------------------------------------- доминанты Сарыдалы
const shapedB = (city, x, z, color, glass = true) => { const b = city.newBuilding({ kind: 'building', x, z, color, glass }); b.shaped = true; return b; };
const base = (city, x, z, w, h = 3) => city.addBuilding({ x, z, w, d: w, h, color: 0xd9d3c7, glass: false, type: 'concrete', roof: null }, fixed);

const LANDMARKS = {
  // Башня «Шанырак» (~280 м): белый ствол и три опоры-ноги, сходящиеся кверху, смотровой
  // диск со стеклянным поясом и золотая сетчатая корона-купол со шпилем
  shanyrak(city, s) {
    const { x, z } = s;
    base(city, x, z, 120, 2);
    const b = shapedB(city, x, z, WHITE, false);
    const n = 13, sh = 16;
    for (let k = 0; k < n; k++) city.addSeg(b, { x, z, w: 20 - k * 0.7, d: 20 - k * 0.7, y0: 2 + k * sh, h: sh, type: 'shape', shape: 'pillar' });
    for (let leg = 0; leg < 3; leg++) {
      const a = leg / 3 * Math.PI * 2;
      for (let k = 0; k < 10; k++) {
        const rr = 34 - k * 2.7;
        city.addSeg(b, { x: x + Math.cos(a) * rr, z: z + Math.sin(a) * rr, w: 5.5 - k * 0.2, d: 5.5 - k * 0.2, y0: 2 + k * sh, h: sh, type: 'shape', shape: 'pillar' });
      }
    }
    const top = 2 + n * sh;
    addGiant(city, b, 'saucer', x, z, 46, top, 0xe8e4dc);
    const g = shapedB(city, x, z, GOLD);
    addGiant(city, g, 'geodome', x, z, 36, top + 10, GOLD);
    addGiant(city, g, 'bullet', x, z, 4, top + 28, GOLD);
  },
  // Торговый центр-купол: огромная геодезическая сфера-полусфера на подиуме и стеклянные крылья
  mallDome(city, s) {
    const { x, z } = s;
    base(city, x, z, 270, 3);
    addGiant(city, shapedB(city, x, z, 0x8ab0c8), 'geodome', x, z, 220, 3);
    for (const k of [-1, 1]) {
      const b = shapedB(city, x + k * 118, z, 0x6a90b0);
      city.addSeg(b, { x: x + k * 118, z, w: 26, d: 120, y0: 3, h: 18, type: 'shape', shape: 'glassbox' });
    }
  },
  // Концертный зал «Раковина»: огромная белая «тарелка» и стеклянное фойе
  ribbonHall(city, s) {
    const { x, z } = s;
    base(city, x, z, 240, 3);
    addGiant(city, shapedB(city, x, z, 0xf0ece0, false), 'saucer', x, z, 190, 3);
    const f = shapedB(city, x, z - 100, 0x7aa0c0);
    city.addSeg(f, { x, z: z - 100, w: 90, d: 22, y0: 3, h: 14, type: 'shape', shape: 'glassbox' });
  },
  // Выставочная сфера на кольце опор и павильоны вокруг
  expoSphere(city, s) {
    const { x, z } = s;
    base(city, x, z, 240, 2);
    const b = shapedB(city, x, z, 0x9ab8d8);
    for (let k = 0; k < 8; k++) {
      const a = k / 8 * Math.PI * 2;
      city.addSeg(b, { x: x + Math.cos(a) * 26, z: z + Math.sin(a) * 26, w: 3, d: 3, y0: 2, h: 20, type: 'shape', shape: 'pillar' });
    }
    addGiant(city, b, 'orb', x, z, 96, 14, 0x9ab8d8);
    for (let k = 0; k < 6; k++) {
      const a = k / 6 * Math.PI * 2 + 0.3, px = x + Math.cos(a) * 92, pz = z + Math.sin(a) * 92;
      const p = shapedB(city, px, pz, [0x5aa6b8, 0xc8a050, 0x8a6ab0][k % 3]);
      addGiant(city, p, 'geodome', px, pz, 30, 2);
    }
  },
  // Цирк: красно-белый купол со световым венцом
  circus(city, s) {
    const { x, z } = s;
    base(city, x, z, 180, 2);
    const b = shapedB(city, x, z, 0xe8e2d6, false);
    city.addSeg(b, { x, z, w: 96, d: 96, y0: 2, h: 12, type: 'shape', shape: 'round' });
    addGiant(city, shapedB(city, x, z, 0xc8402e), 'cupola', x, z, 90, 14, 0xc8402e);
    city.addSeg(b, { x, z, w: 10, d: 10, y0: 14 + 90 * 0.62 - 2, h: 8, type: 'shape', shape: 'crown' });
  },
  // Дворец культуры-зиккурат: ступени бронзового стекла на белом основании
  ziggurat(city, s) {
    const { x, z } = s;
    base(city, x, z, 200, 4);
    const b = shapedB(city, x, z, 0xb08a4e);
    for (let k = 0; k < 6; k++) {
      const w = 150 - k * 22;
      city.addSeg(b, { x, z, w, d: w, y0: 4 + k * 13, h: 13, type: 'shape', shape: k % 2 ? 'slab' : 'glassbox' });
    }
    addGiant(city, b, 'pyramid', x, z, 38, 4 + 6 * 13, GOLD);
  },
  // Большая мечеть: белый объём, голубой главный купол с золотом, малые купола, четыре минарета
  grandMosque(city, s) {
    const { x, z } = s;
    base(city, x, z, 250, 3);
    const white = 0xf6f3ec, blue = 0x4a8ad0;
    city.addBuilding({ x, z, w: 130, d: 130, h: 32, color: white, glass: false, roof: null, style: ST.pub }, fixed);
    const b = shapedB(city, x, z, white, false);
    city.addSeg(b, { x, z, w: 80, d: 80, y0: 32, h: 14, type: 'shape', shape: 'round' });
    addGiant(city, b, 'cupola', x, z, 86, 46, blue);
    for (let k = 0; k < 3; k++) { const sg = city.addSeg(b, { x, z, w: 2.6 - k * 0.7, d: 2.6 - k * 0.7, y0: 46 + 86 * 0.62 + k * 7, h: 7, type: 'shape', shape: 'pillar' }); sg.color = new THREE.Color(GOLD); }
    for (const [ox, oz] of [[-48, -48], [48, -48], [-48, 48], [48, 48]]) addGiant(city, shapedB(city, x + ox, z + oz, white, false), 'cupola', x + ox, z + oz, 26, 32, blue);
    for (const [ox, oz] of [[-100, -100], [100, -100], [-100, 100], [100, 100]]) {
      const mb = shapedB(city, x + ox, z + oz, white, false);
      for (let k = 0; k < 7; k++) city.addSeg(mb, { x: x + ox, z: z + oz, w: 8 - k * 0.3, d: 8 - k * 0.3, y0: 3 + k * 14, h: 14, type: 'shape', shape: 'pillar' });
      city.addSeg(mb, { x: x + ox, z: z + oz, w: 10, d: 10, y0: 101, h: 5, type: 'shape', shape: 'crown' });
      addGiant(city, mb, 'bullet', x + ox, z + oz, 5.5, 106, GOLD);
    }
  },
};
