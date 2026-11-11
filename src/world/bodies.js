import * as THREE from 'three';
import { SPACE } from '../config.js';

// Луна и планеты в виде, удобном для физики, камеры и HUD: центр — вектор, ось — единичная.
// Тел две системы: наша (sol) и система Ксаррона (xarron) в ~5 млрд м отсюда. Физика, камера и HUD
// видят только тела системы, где сейчас герой (BODIES), космос рисует свою систему (ALL_BODIES)
const prep = (b, sys, o) => ({
  ...b,
  sys,
  c: new THREE.Vector3(...b.pos).add(o),
  axis: new THREE.Vector3(...(b.axis || [0, 0, 1])).normalize(),
});
const ZERO = new THREE.Vector3();
export const XARRON_ORIGIN = new THREE.Vector3(...SPACE.xarron.origin);
export const ALL_BODIES = [
  ...SPACE.bodies.map((b) => prep(b, 'sol', ZERO)),
  ...SPACE.xarron.bodies.map((b) => prep(b, 'xarron', XARRON_ORIGIN)),
];

// Межгалактическое пространство ('deep'): герой стоит у этой точки, а его место в галактиках хранит galaxy.js
export const DEEP_ORIGIN = new THREE.Vector3(...SPACE.galaxy.deepOrigin);
const DEEP_R = 5e11;

// Системы: центр и граница полётной зоны вокруг него
export const REGIONS = {
  sol: { id: 'sol', origin: ZERO, radius: SPACE.flightRadius },
  xarron: { id: 'xarron', origin: XARRON_ORIGIN, radius: SPACE.xarron.radius },
  deep: { id: 'deep', origin: DEEP_ORIGIN, radius: DEEP_R },
};
export const regionAt = (p) => (p.distanceToSquared(XARRON_ORIGIN) < SPACE.xarron.radius ** 2 ? 'xarron'
  : p.distanceToSquared(DEEP_ORIGIN) < DEEP_R ** 2 ? 'deep' : 'sol');

// Вне систем звезды нет: героя освещает свет галактик (направление ставит galaxy.js)
export const DEEP_LIGHT = { id: 'deep-light', sys: 'deep', star: true, c: new THREE.Vector3(0, 2e12, 0), r: 1, light: [0.82, 0.8, 0.86] };

// Тела текущей системы (массив меняется на месте — его держат другие модули) и её звезда
export const BODIES = [];
export let SUN = null;     // звезда системы героя: на неё садятся, она освещает остальных
export let REGION = null;
export const starOf = (sys) => ALL_BODIES.find((b) => b.star && b.sys === sys);

// Переход в другую систему (true — система сменилась)
export function setRegion(id) {
  if (id === REGION) return false;
  REGION = id;
  BODIES.length = 0;
  for (const b of ALL_BODIES) if (b.sys === id) BODIES.push(b);
  SUN = id === 'deep' ? DEEP_LIGHT : starOf(id);
  return true;
}
setRegion('sol');

// Садиться можно на «верхнюю шапку» шара: там, где поверхность смотрит вверх
// (направление от центра — не дальше ~37° от вертикали). Герой и камера живут
// в мире «Y — вверх», поэтому касание боков и низа ведёт на отдельную карту (planetmap.js)
export const CAP_NY = 0.8;

const _d = new THREE.Vector3();

// Ближайшее тело по расстоянию до поверхности: { body, alt } (alt — высота над ней)
export function nearestBody(p) {
  let body = null, alt = Infinity;
  for (const b of BODIES) {
    const a = _d.subVectors(p, b.c).length() - b.r;
    if (a < alt) { alt = a; body = b; }
  }
  return { body, alt };
}

// Высота поверхности тела под точкой p, если p над его верхней шапкой; иначе -Infinity
export function bodyGroundAt(b, p) {
  const dx = p.x - b.c.x, dy = p.y - b.c.y, dz = p.z - b.c.z;
  const d2 = dx * dx + dz * dz;
  if (dy <= 0 || dy * dy < CAP_NY * CAP_NY * (d2 + dy * dy)) return -Infinity;
  return b.c.y + Math.sqrt(Math.max(0, b.r * b.r - d2));
}
