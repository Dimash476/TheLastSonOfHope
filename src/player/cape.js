import * as THREE from 'three';

// Большой длинный плащ: ткань из сетки точек (Verlet) с ограничениями длины.
// Книзу плащ шире, чем у плеч, — поэтому сам ложится крупными складками.
// Симуляция идёт в локальных координатах персонажа, поэтому плащ остаётся
// стабильным даже на скорости в тысячи м/с: скорость полёта превращается
// во «встречный ветер», а гравитация поворачивается вместе с телом.

const W = 17, H = 30;     // точек по ширине и длине
const LENGTH = 2.05;      // длина от плеч, м (почти до земли)
const FLARE = 5.0;        // во сколько раз низ шире верха (расширяется в основном к подолу)
const SPREAD = 14;        // м/с²: подол мягко раскрывается в стороны — плащ не схлопывается в «трубу»

export class Cape {
  constructor(parent) {
    this.parent = parent; // группа модели персонажа (локальная система координат)
    const n = W * H;
    this.pos = new Float32Array(n * 3);
    this.prev = new Float32Array(n * 3);
    this.t = 0;
    this.floorY = null;   // высота земли в локальных координатах (когда стоим)

    // Ограничения: соседи по горизонтали, вертикали, диагонали и через одну (жёсткость на изгиб)
    const cons = [];
    const add = (a, b) => cons.push(a, b, 0);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (x < W - 1) add(i, i + 1);
      if (y < H - 1) add(i, i + W);
      if (x < W - 1 && y < H - 1) { add(i, i + W + 1); add(i + 1, i + W); }
      if (y < H - 2) add(i, i + 2 * W);
      if (x < W - 2) add(i, i + 2);
    }
    // Связи в типизированных массивах: индексы (×3), длина покоя, «вес» концов
    const nc = cons.length / 3;
    this.ca = new Int32Array(nc); this.cb = new Int32Array(nc);
    this.cr = new Float32Array(nc); this.cw = new Float32Array(nc);
    for (let k = 0; k < nc; k++) {
      const a = cons[k * 3], b = cons[k * 3 + 1];
      this.ca[k] = a * 3; this.cb[k] = b * 3;
      // Верхний ряд закреплён: тогда двигаем только второй конец (вес 1), иначе пополам
      this.cw[k] = a < W ? 1 : b < W ? -1 : 0.5;
    }

    const geo = new THREE.PlaneGeometry(1, 1, W - 1, H - 1);
    this.geo = geo;
    // Тяжёлая красная ткань с отливом; изнутри темнее, по краю — тёмная кайма
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0x5e1424, roughness: 0.65, metalness: 0.0, side: THREE.DoubleSide,
      sheen: 0.7, sheenRoughness: 0.45, sheenColor: new THREE.Color(0.5, 0.16, 0.2),
    });
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vCapeUv;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCapeUv = uv;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vCapeUv;')
        .replace('#include <color_fragment>', `#include <color_fragment>
          {
            vec2 e = min(vCapeUv, 1.0 - vCapeUv);
            float hem = 1.0 - smoothstep(0.012, 0.03, min(e.x, e.y * 0.6));
            diffuseColor.rgb *= 1.0 - hem * 0.45;
            if (!gl_FrontFacing) diffuseColor.rgb *= 0.6;
          }`);
    };
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    parent.add(this.mesh);

    // Застёжки спрятаны: плащ крепится поверх плеч, крепления не видно
    const claspMat = new THREE.MeshStandardMaterial({ color: 0xb8bcc4, roughness: 0.35, metalness: 0.95 });
    this.clasps = [0, 1].map(() => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.02, 20).rotateX(Math.PI / 2), claspMat);
      m.castShadow = true;
      m.visible = false;
      parent.add(m);
      return m;
    });

    this.anchorL = new THREE.Vector3();
    this.anchorR = new THREE.Vector3();
    this.initialized = false;
    this.colliders = []; // [{ c: Vector3, r }] в локальных координатах
    this.capsules = [];  // [{ a: Vector3, b: Vector3, r }] — руки и ноги по костям
  }

  // Начальное положение: висит от плеч, книзу расширяется
  reset() {
    const mid = new THREE.Vector3().lerpVectors(this.anchorL, this.anchorR, 0.5);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const v = y / (H - 1), t = x / (W - 1);
      const flare = 1 + (FLARE - 1) * Math.pow(v, 1.35);
      const a = new THREE.Vector3().lerpVectors(this.anchorL, this.anchorR, t);
      this.pos[i] = this.prev[i] = mid.x + (a.x - mid.x) * flare;
      this.pos[i + 1] = this.prev[i + 1] = a.y - v * LENGTH;
      // Чуть выгнут назад — будто лежит на спине
      this.pos[i + 2] = this.prev[i + 2] = a.z - 0.05 - Math.sin(v * Math.PI) * 0.12;
    }
    // Длины покоя (широкий низ задаёт ширину ткани → складки)
    const P = this.pos;
    for (let k = 0; k < this.ca.length; k++) {
      const a = this.ca[k], b = this.cb[k];
      const dx = P[a] - P[b], dy = P[a + 1] - P[b + 1], dz = P[a + 2] - P[b + 2];
      this.cr[k] = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    this.initialized = true;
  }

  // anchorL/R — точки крепления на плечах (локально); gravity, wind — ускорения в локальных координатах
  update(dt, anchorL, anchorR, gravity, wind) {
    this.anchorL.copy(anchorL);
    this.anchorR.copy(anchorR);
    if (!this.initialized) this.reset();
    if (!(dt > 1e-5) || !Number.isFinite(gravity.x + gravity.y + gravity.z + wind.x + wind.y + wind.z)) return;
    const steps = 2, h = Math.min(dt, 1 / 30) / steps;
    const P = this.pos, Q = this.prev;
    const windLen = wind.length();
    // Направления «поперёк» потока — вдоль них ткань волнуется
    const wDir = windLen > 0.1 ? wind.clone().divideScalar(windLen) : new THREE.Vector3(0, 0, -1);
    const side = new THREE.Vector3(1, 0, 0).addScaledVector(wDir, -wDir.x).normalize();
    const lift = new THREE.Vector3().crossVectors(wDir, side).normalize();
    const flutterK = Math.min(1, windLen / 35);

    for (let s = 0; s < steps; s++) {
      this.t += h;
      const t = this.t;
      // Лёгкий ветерок, когда стоим: медленно меняет силу и направление
      const breeze = (1 - flutterK) * (1.6 + 1.2 * Math.sin(t * 0.7) + 0.6 * Math.sin(t * 1.9));
      for (let y = 1; y < H; y++) for (let x = 0; x < W; x++) {
        const k = y * W + x, i = k * 3;
        const v = y / (H - 1), u = x / (W - 1) - 0.5;
        // Волны бегут от плеч к низу; к нижнему краю амплитуда растёт
        const freq = 6 + windLen * 0.015;
        const wave = Math.sin(t * freq - v * 9 + u * 2.5) + 0.55 * Math.sin(t * freq * 1.7 - v * 15 - u * 4.0);
        const amp = (flutterK * (4 + Math.min(windLen, 200) * 0.06) + breeze * 0.6) * (0.25 + v);
        const fx = gravity.x + wind.x + side.x * wave * amp * 0.5 + lift.x * wave * amp + breeze * u * 0.8 + u * SPREAD * Math.pow(v, 0.7) * (1 - flutterK * 0.7);
        const fy = gravity.y + wind.y + side.y * wave * amp * 0.5 + lift.y * wave * amp;
        const fz = gravity.z + wind.z + side.z * wave * amp * 0.5 + lift.z * wave * amp - breeze * 1.2;
        const damp = 0.99;
        let vx = (P[i] - Q[i]) * damp, vy = (P[i + 1] - Q[i + 1]) * damp, vz = (P[i + 2] - Q[i + 2]) * damp;
        Q[i] = P[i]; Q[i + 1] = P[i + 1]; Q[i + 2] = P[i + 2];
        P[i] += vx + fx * h * h;
        P[i + 1] += vy + fy * h * h;
        P[i + 2] += vz + fz * h * h;
      }
      // Верхний ряд закреплён на плечах
      for (let x = 0; x < W; x++) {
        const tt = x / (W - 1), i = x * 3;
        P[i] = Q[i] = anchorL.x + (anchorR.x - anchorL.x) * tt;
        P[i + 1] = Q[i + 1] = anchorL.y + (anchorR.y - anchorL.y) * tt;
        P[i + 2] = Q[i + 2] = anchorL.z + (anchorR.z - anchorL.z) * tt;
      }
      this.solve(4);
      this.collide();
    }
    // Самовосстановление: если ткань «сломалась» (NaN), начинаем заново
    if (!Number.isFinite(P[(W * H - 1) * 3 + 1])) { this.reset(); }

    // Застёжки на точках крепления, повёрнуты по направлению спины
    this.clasps[0].position.copy(anchorL).add(new THREE.Vector3(-0.03, 0, 0.02));
    this.clasps[1].position.copy(anchorR).add(new THREE.Vector3(0.03, 0, 0.02));
    this.writeGeometry();
  }

  solve(iterations) {
    const P = this.pos, CA = this.ca, CB = this.cb, CR = this.cr, CW = this.cw, n = CA.length;
    for (let it = 0; it < iterations; it++) {
      for (let k = 0; k < n; k++) {
        const a = CA[k], b = CB[k];
        const dx = P[b] - P[a], dy = P[b + 1] - P[a + 1], dz = P[b + 2] - P[a + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-9;
        const diff = (d - CR[k]) / d;
        const w = CW[k];
        // w = 1: двигаем только b; w = -1: только a; 0.5: оба поровну
        const ka = w === 1 ? 0 : w === -1 ? diff : diff * 0.5;
        const kb = w === -1 ? 0 : w === 1 ? diff : diff * 0.5;
        P[a] += dx * ka; P[a + 1] += dy * ka; P[a + 2] += dz * ka;
        P[b] -= dx * kb; P[b + 1] -= dy * kb; P[b + 2] -= dz * kb;
      }
    }
  }

  // Ткань не проходит сквозь тело и ложится на землю
  collide() {
    const P = this.pos;
    for (const { c, r } of this.colliders) {
      for (let k = W; k < W * H; k++) {
        const i = k * 3;
        const dx = P[i] - c.x, dy = P[i + 1] - c.y, dz = P[i + 2] - c.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < r * r && d2 > 1e-8) {
          const d = Math.sqrt(d2), s = (r - d) / d;
          P[i] += dx * s; P[i + 1] += dy * s; P[i + 2] += dz * s;
        }
      }
    }
    // Капсулы (бедро, голень, плечо): ткань выталкивается от отрезка кости
    for (const { a, b, r } of this.capsules) {
      const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
      const L2 = abx * abx + aby * aby + abz * abz + 1e-9;
      for (let k = W; k < W * H; k++) {
        const i = k * 3;
        const px = P[i] - a.x, py = P[i + 1] - a.y, pz = P[i + 2] - a.z;
        const t = Math.max(0, Math.min(1, (px * abx + py * aby + pz * abz) / L2));
        const dx = px - abx * t, dy = py - aby * t, dz = pz - abz * t;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < r * r && d2 > 1e-8) {
          const d = Math.sqrt(d2), s = (r - d) / d;
          P[i] += dx * s; P[i + 1] += dy * s; P[i + 2] += dz * s;
        }
      }
    }
    if (this.floorY !== null) {
      const Q = this.prev;
      for (let k = W; k < W * H; k++) {
        const i = k * 3;
        if (P[i + 1] < this.floorY) {
          P[i + 1] = this.floorY;
          // трение о землю
          P[i] = Q[i] + (P[i] - Q[i]) * 0.5;
          P[i + 2] = Q[i + 2] + (P[i + 2] - Q[i + 2]) * 0.5;
        }
      }
    }
  }

  writeGeometry() {
    const a = this.geo.attributes.position.array, P = this.pos;
    // PlaneGeometry нумерует строки сверху вниз — как и наша сетка
    for (let k = 0; k < W * H; k++) {
      a[k * 3] = P[k * 3]; a[k * 3 + 1] = P[k * 3 + 1]; a[k * 3 + 2] = P[k * 3 + 2];
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.computeVertexNormals();
  }
}
