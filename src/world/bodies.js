import * as THREE from 'three';
import { SPACE } from '../config.js';

// Луна и планеты в виде, удобном для физики, камеры и HUD: центр — вектор, ось — единичная
export const BODIES = SPACE.bodies.map((b) => ({
  ...b,
  c: new THREE.Vector3(...b.pos),
  axis: new THREE.Vector3(...(b.axis || [0, 0, 1])).normalize(),
}));

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
