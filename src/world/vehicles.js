import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Транспорт: седан, хэтчбек, внедорожник, такси, фургон, автобус.
// Кузов — профиль сбоку с колёсными арками, выдавленный на ширину машины (с фаской),
// поверх — тонированная кабина, крыша, бамперы, решётка, зеркала, колёса с дисками, фары.
// Каждая вершина знает, что она такое (атрибут part):
//   0 — краска (цвет экземпляра), 1 — стекло, 2 — пластик/резина, 3 — хром, 4 — фара, 5 — стоп-сигнал.
// Машина смотрит вдоль +Z, колёса стоят на y = 0.

const PAINT = 0, GLASS = 1, PLASTIC = 2, CHROME = 3, HEAD = 4, TAIL = 5;
const PART_COLOR = {
  [PAINT]: 0xffffff, [GLASS]: 0x161d24, [PLASTIC]: 0x1b1c1e, [CHROME]: 0xb8bcc2, [HEAD]: 0xfff6dc, [TAIL]: 0x9a0d0d,
};

function tag(geo, part, color = PART_COLOR[part]) {
  if (geo.index) geo = geo.toNonIndexed();
  geo.deleteAttribute('uv');
  const n = geo.attributes.position.count, c = new THREE.Color(color);
  const col = new Float32Array(n * 3), pa = new Float32Array(n);
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; pa[i] = part; }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('part', new THREE.BufferAttribute(pa, 1));
  return geo;
}

// Профиль (в плоскости z–y) выдавливается по ширине w вдоль X
function extrudeProfile(pts, w, bevel = 0.06) {
  const shape = new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(z, y)));
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.01, w - bevel * 2), bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel * 0.8, bevelSegments: 2, curveSegments: 6,
  });
  geo.translate(0, 0, -(w - bevel * 2) / 2);
  geo.rotateY(-Math.PI / 2); // x профиля → +z машины, выдавливание → x
  geo.computeVertexNormals();
  return geo;
}

// Нижняя линия кузова с арками колёс (wheels — положения осей по Z, от кормы к носу)
function bottomWithArches(L, wheels, r, y0) {
  const pts = [];
  pts.push([-L / 2, y0]);
  for (const cz of wheels) {
    const R = r + 0.08;
    pts.push([cz - R, y0]);
    for (let k = 1; k < 8; k++) { const a = Math.PI - (k / 8) * Math.PI; pts.push([cz + Math.cos(a) * R, r + Math.sin(a) * R * 0.95]); }
    pts.push([cz + R, y0]);
  }
  pts.push([L / 2, y0]);
  return pts;
}

function box(w, h, d, x, y, z) { return new THREE.BoxGeometry(w, h, d).translate(x, y, z); }

function wheel(r, w, x, z) {
  const tire = tag(new THREE.CylinderGeometry(r, r, w, 16).rotateZ(Math.PI / 2).translate(x, r, z), PLASTIC, 0x0e0e0f);
  const hub = tag(new THREE.CylinderGeometry(r * 0.62, r * 0.62, w + 0.02, 10).rotateZ(Math.PI / 2).translate(x, r, z), CHROME, 0x9a9ea4);
  return [tire, hub];
}

// spec: L, W — габарит; r — радиус колеса; wz — колёса от центра по Z; belt — линия капота/окон;
// nose/tail — высоты переда и зада; hood — где кончается капот; cabin: [z0 низ, z1 верх стекла спереди, z2 верх сзади, z3 низ сзади, top]
function makeVehicle(spec) {
  const { L, W, r, wz, belt, cabin, y0 = 0.32 } = spec;
  const parts = [];
  // Кузов: низ с арками, нос, капот, линия окон, корма
  const prof = bottomWithArches(L, [-wz, wz], r, y0);
  prof.push([L / 2 + 0.04, spec.nose * 0.55], [L / 2 - 0.02, spec.nose], [cabin[0], belt], [cabin[3], belt], [-L / 2 + 0.05, spec.tail], [-L / 2 - 0.03, spec.tail * 0.6]);
  parts.push(tag(extrudeProfile(prof, W, 0.07), PAINT));
  // Кабина (стекло) чуть уже кузова, крыша — краска
  const [c0, c1, c2, c3, top] = cabin;
  parts.push(tag(extrudeProfile([[c3, belt - 0.02], [c0, belt - 0.02], [c1, top], [c2, top]], W - 0.14, 0.04), GLASS));
  parts.push(tag(extrudeProfile([[c2 - 0.02, top - 0.01], [c1 + 0.02, top - 0.01], [c1 - 0.04, top + 0.06], [c2 + 0.06, top + 0.06]], W - 0.1, 0.03), PAINT));
  // Средняя стойка
  parts.push(tag(box(W - 0.12, top - belt, 0.12, 0, (top + belt) / 2, (c1 + c2) / 2 + 0.05), PAINT));
  // Бамперы, решётка, пороги
  parts.push(tag(box(W + 0.04, 0.22, 0.18, 0, y0 + 0.1, L / 2 + 0.02), PLASTIC, 0x26282b));
  parts.push(tag(box(W + 0.04, 0.22, 0.18, 0, y0 + 0.1, -L / 2 - 0.02), PLASTIC, 0x26282b));
  parts.push(tag(box(W * 0.5, spec.nose * 0.32, 0.05, 0, spec.nose * 0.62, L / 2 + 0.05), PLASTIC, 0x0d0e10));
  parts.push(tag(box(W + 0.02, 0.08, L - 2 * (wz + r + 0.12) > 0.3 ? L * 0.36 : 0.3, 0, y0 + 0.02, 0), PLASTIC, 0x202224));
  // Зеркала
  for (const s of [-1, 1]) parts.push(tag(box(0.22, 0.12, 0.1, s * (W / 2 + 0.08), belt + 0.08, c0 - 0.15), PAINT));
  // Фары и фонари
  for (const s of [-1, 1]) {
    parts.push(tag(box(W * 0.24, 0.13, 0.06, s * W * 0.32, spec.nose * 0.82, L / 2 + 0.03), HEAD));
    parts.push(tag(box(W * 0.24, 0.12, 0.06, s * W * 0.34, spec.tail * 0.86, -L / 2 - 0.03), TAIL));
  }
  // Колёса
  for (const z of [-wz, wz]) for (const s of [-1, 1]) parts.push(...wheel(r, 0.26, s * (W / 2 - 0.12), z));
  if (spec.extra) parts.push(...spec.extra);
  const g = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)));
  g.computeBoundingSphere();
  return g;
}

// Автобус и фургон — коробки со скруглёнными гранями и лентой окон
function makeBoxVehicle({ L, W, H, r, wz, windowBand, cabZ, glassAll = true }) {
  const parts = [];
  const y0 = 0.35;
  const axles = Array.isArray(wz) ? wz : [-wz, wz];
  const prof = bottomWithArches(L, axles, r, y0);
  prof.push([L / 2, H * 0.45], [L / 2 - 0.15, H], [-L / 2 + 0.08, H], [-L / 2, H * 0.4]);
  parts.push(tag(extrudeProfile(prof, W, 0.08), PAINT));
  // Лента окон по бокам и лобовое
  const [wy0, wy1] = windowBand;
  if (glassAll) parts.push(tag(box(W + 0.02, wy1 - wy0, L - 0.9, 0, (wy0 + wy1) / 2, 0.1), GLASS));
  else parts.push(tag(box(W + 0.02, wy1 - wy0, cabZ, 0, (wy0 + wy1) / 2, L / 2 - cabZ / 2 - 0.15), GLASS));
  parts.push(tag(box(W - 0.2, wy1 - wy0 + 0.2, 0.06, 0, (wy0 + wy1) / 2 + 0.05, L / 2 + 0.01), GLASS));
  parts.push(tag(box(W + 0.04, 0.25, 0.16, 0, y0 + 0.12, L / 2 + 0.03), PLASTIC, 0x26282b));
  parts.push(tag(box(W + 0.04, 0.25, 0.16, 0, y0 + 0.12, -L / 2 - 0.03), PLASTIC, 0x26282b));
  for (const s of [-1, 1]) {
    parts.push(tag(box(0.3, 0.16, 0.06, s * W * 0.36, 0.95, L / 2 + 0.04), HEAD));
    parts.push(tag(box(0.25, 0.3, 0.06, s * W * 0.4, 1.1, -L / 2 - 0.04), TAIL));
    parts.push(tag(box(0.12, 0.3, 0.12, s * (W / 2 + 0.1), wy0 + 0.2, L / 2 - 0.4), PLASTIC));
  }
  for (const z of axles) for (const s of [-1, 1]) parts.push(...wheel(r, 0.32, s * (W / 2 - 0.16), z));
  const g = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)));
  g.computeBoundingSphere();
  return g;
}

const sedanSpec = { L: 4.6, W: 1.84, r: 0.33, wz: 1.38, belt: 0.98, nose: 0.82, tail: 0.98, cabin: [0.95, 0.15, -1.0, -1.55, 1.45] };
const taxiSign = tag(box(0.6, 0.18, 0.22, 0, 1.6, -0.4), HEAD, 0xffe680);

export const VEHICLE_TYPES = [
  { name: 'sedan', weight: 0.36, colors: [0x8a1c1c, 0x1f2a36, 0xd9dcde, 0x6c7378, 0x24486e, 0x101112, 0x4a4f54, 0x7a6a58], geo: () => makeVehicle(sedanSpec) },
  { name: 'hatch', weight: 0.2, colors: [0xb8b2a6, 0x2f6b8f, 0xc23b22, 0x3b5d3a, 0xe6e2da, 0x22252a], geo: () => makeVehicle({ L: 4.0, W: 1.78, r: 0.31, wz: 1.25, belt: 0.95, nose: 0.78, tail: 1.0, cabin: [0.75, 0.0, -1.55, -1.95, 1.47] }) },
  { name: 'suv', weight: 0.2, colors: [0x15181b, 0x5a5f63, 0xe8e8e6, 0x2c3b2c, 0x4b2f22, 0x1e3350], geo: () => makeVehicle({ L: 4.75, W: 1.96, r: 0.38, wz: 1.45, belt: 1.15, nose: 1.0, tail: 1.15, y0: 0.42, cabin: [1.05, 0.35, -1.75, -2.2, 1.8] }) },
  { name: 'taxi', weight: 0.1, colors: [0xe6b81e], geo: () => makeVehicle({ ...sedanSpec, extra: [taxiSign] }) },
  { name: 'van', weight: 0.1, colors: [0xeeeeea, 0xdedad0, 0x2b4f7a, 0xa8a8a4], geo: () => makeBoxVehicle({ L: 5.3, W: 2.0, H: 2.35, r: 0.36, wz: 1.75, windowBand: [1.35, 1.95], cabZ: 1.3, glassAll: false }) },
  { name: 'bus', weight: 0.04, colors: [0x2f7d5b, 0xc9452e, 0x2d5c9a], geo: () => makeBoxVehicle({ L: 11, W: 2.5, H: 3.05, r: 0.48, wz: [-3.3, 3.1], windowBand: [1.25, 2.55] }) },
];

// Общий материал: краска берёт цвет экземпляра, стекло блестит, фары светятся ночью
export function createVehicleMaterial(uNight) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.4 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = uNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float part;\nvarying float vPart;\nvarying float vBurnt;')
      .replace('#include <color_vertex>', `
        vColor.rgb = color.rgb;
        vPart = part;
        vBurnt = 0.0;
        #ifdef USE_INSTANCING_COLOR
          float isPaint = 1.0 - step(0.5, part);
          vColor.rgb *= mix(vec3(1.0), instanceColor.rgb, isPaint);
          // Сгоревшая машина (очень тёмный цвет): всё темнеет, фары гаснут
          vBurnt = 1.0 - step(0.12, max(instanceColor.r, max(instanceColor.g, instanceColor.b)));
          vColor.rgb *= mix(1.0, 0.25, vBurnt * (1.0 - isPaint));
        #endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vPart;\nvarying float vBurnt;\nuniform float uNight;')
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        float pGlass = step(0.5, vPart) * step(vPart, 1.5);
        float pPlastic = step(1.5, vPart) * step(vPart, 2.5);
        float pChrome = step(2.5, vPart) * step(vPart, 3.5);
        float pLight = step(3.5, vPart);
        roughnessFactor = 0.26;
        roughnessFactor = mix(roughnessFactor, 0.04, pGlass);
        roughnessFactor = mix(roughnessFactor, 0.85, pPlastic);
        roughnessFactor = mix(roughnessFactor, 0.2, pChrome + pLight);
        roughnessFactor = mix(roughnessFactor, 0.9, vBurnt);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        metalnessFactor = mix(0.55, 0.9, pGlass);
        metalnessFactor = mix(metalnessFactor, 0.0, pPlastic);
        metalnessFactor = mix(metalnessFactor, 1.0, pChrome);
        metalnessFactor = mix(metalnessFactor, 0.1, pLight + vBurnt);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          float head = step(3.5, vPart) * step(vPart, 4.5);
          float tail = step(4.5, vPart);
          vec3 glow = head * vec3(1.0, 0.93, 0.78) * mix(0.15, 4.0, uNight)
                    + tail * vec3(1.0, 0.04, 0.02) * mix(0.35, 2.2, uNight);
          totalEmissiveRadiance += glow * (1.0 - vBurnt);
        }`);
  };
  return mat;
}
