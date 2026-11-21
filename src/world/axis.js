import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CITY, WORLD } from '../config.js';
import { MEGA_SITES, RIVER_Z, RIVER_HALF_W, RIVERSIDE_HALF, HALF, PLANE_HALF, isBridgeRoad, STEPPE, riverZAt, riverHWAt } from './layout.js';
import { beachK, urbanScore } from './steppeplan.js';
import { createTintMaterial } from './beach.js';

// Парадная ось левого берега и набережные: бульвары с длинными бассейнами, «поющими»
// фонтанами (вечером подсвечены и меняют цвет), цветники, скамейки и фонари;
// гранитные набережные по обоим берегам реки — парапет, фонари, скамейки, лестницы
// к воде, причалы с теплоходами-ресторанами и белый пешеходный мост-арка.

const WL = WORLD.waterLevel;
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

function part(geo, color, tint = 0) {
  if (geo.index) geo = geo.toNonIndexed();
  if (geo.attributes.uv) geo.deleteAttribute('uv');
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const n = geo.attributes.position.count, c = new THREE.Color(color);
  const col = new Float32Array(n * 3), t = new Float32Array(n).fill(tint), sw = new Float32Array(n);
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('tint', new THREE.BufferAttribute(t, 1));
  geo.setAttribute('sway', new THREE.BufferAttribute(sw, 1));
  return geo;
}
const B = (w, h, d, x, y, z) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
const C = (r0, r1, h, x, y, z, s = 8) => new THREE.CylinderGeometry(r1, r0, h, s).translate(x, y, z);
const M = (l) => mergeGeometries(l);
const mx = (x, y, z, rot = 0, s = 1) => new THREE.Matrix4().compose(_v.set(x, y, z), _q.setFromAxisAngle(UP, rot), _s.setScalar(s));

// Струи фонтанов: частицы летят вверх по параболе и падают (весь полёт считает шейдер)
function makeJets(origins, { up, spread, life, size, n }) {
  const pos = [], seed = [];
  for (const o of origins) for (let i = 0; i < n; i++) { pos.push(o.x, o.y, o.z); seed.push(Math.random(), Math.random(), o.k ?? 1); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 3));
  geo.computeBoundingSphere();
  geo.boundingSphere.radius += up * up / 19 + spread * life;
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uUp: { value: up }, uSpread: { value: spread }, uLife: { value: life }, uSize: { value: size },
      uCol: { value: new THREE.Color(0xe8f4ff) }, uGlow: { value: 0 }, uFogCol: { value: new THREE.Color() }, uFogD: { value: 0 } },
    vertexShader: `uniform float uTime, uUp, uSpread, uLife, uSize; attribute vec3 aSeed; varying float vA; varying float vDist;
      void main() {
        float ph = fract(uTime / uLife + aSeed.x);
        float t = ph * uLife * (0.85 + 0.3 * aSeed.y);
        float a = aSeed.y * 6.2832 + aSeed.x * 17.0;
        float v = uUp * aSeed.z * (0.92 + 0.16 * aSeed.y);
        vec3 p = position + vec3(cos(a) * uSpread * t, v * t - 4.9 * t * t, sin(a) * uSpread * t);
        p.y = max(p.y, position.y - 0.2);
        vA = smoothstep(0.0, 0.05, ph) * (1.0 - smoothstep(0.8, 1.0, ph));
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
        gl_PointSize = uSize * 700.0 / max(1.0, -mv.z);
      }`,
    fragmentShader: `uniform vec3 uCol, uFogCol; uniform float uGlow, uFogD; varying float vA; varying float vDist;
      void main() {
        vec2 d = gl_PointCoord - 0.5; float r = dot(d, d) * 4.0; if (r > 1.0) discard;
        float f = 1.0 - exp(-uFogD * uFogD * vDist * vDist);
        gl_FragColor = vec4(mix(uCol * (1.0 + uGlow * 1.5), uFogCol, f), (1.0 - r) * vA * 0.55);
      }`,
    transparent: true, depthWrite: false,
  });
  return new THREE.Points(geo, mat);
}

export class Axis {
  constructor(scene, world) {
    this.world = world;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.uTime = { value: 0 };
    this.mat = createTintMaterial(this.uTime);
    this.glowMat = new THREE.MeshBasicMaterial({ color: 0xffe2b0, toneMapped: false });
    this.jets = [];
    this.chunks = [];
    this.lamps = [];
    this.benches = [];
    this.buildBoulevards();
    // В степи набережные идут вдоль излучины, пешеходных мостов два
    if (STEPPE) {
      this.buildSteppeEmbankments();
      this.buildFootbridge(-150);
      this.buildFootbridge(2250);
    } else {
      this.buildEmbankments();
      this.buildFootbridge(-100);
    }
    this.flushStreet();
  }

  add(geo, list, colors, far = 2500, shadow = true, mat = this.mat) {
    if (!list.length) return null;
    const m = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((x, i) => { m.setMatrixAt(i, x); if (colors) m.setColorAt(i, new THREE.Color(colors[i % colors.length])); });
    if (!m.instanceColor && mat === this.mat) m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 3).fill(1), 3);
    m.castShadow = shadow; m.receiveShadow = true;
    m.computeBoundingSphere();
    this.group.add(m);
    this.chunks.push({ m, c: m.boundingSphere.center.clone(), far: far + m.boundingSphere.radius });
    return m;
  }

  // ---------------------------------------------------------------- бульвары оси
  buildBoulevards() {
    const granite = 0xb8b2a8, dark = 0x5a5650;
    // Длинный бассейн-канал с бортом и тёмным дном; вода — отдельной поверхностью
    const poolL = 230, poolW = 16;
    const pool = M([
      part(B(poolL + 2, 0.6, 1, 0, 0.3, -poolW / 2), granite), part(B(poolL + 2, 0.6, 1, 0, 0.3, poolW / 2), granite),
      part(B(1, 0.6, poolW, -poolL / 2, 0.3, 0), granite), part(B(1, 0.6, poolW, poolL / 2, 0.3, 0), granite),
      part(B(poolL, 0.05, poolW, 0, 0.03, 0), 0x1a3440),
    ]);
    // Круглая чаша главного фонтана в центре бульвара
    const bowl = M([
      part(new THREE.TorusGeometry(19, 0.7, 6, 48).rotateX(Math.PI / 2).translate(0, 0.5, 0), granite),
      part(new THREE.CircleGeometry(19, 48).rotateX(-Math.PI / 2).translate(0, 0.05, 0), 0x1a3440),
      part(C(3.2, 2.6, 1.6, 0, 0.8, 0, 16), granite),
    ]);
    // Цветники: длинные гряды вдоль бассейна (красные, жёлтые, сиреневые полосы)
    const bed = M([part(B(40, 0.35, 5, 0, 0.18, 0), 0x3a2a1e), part(B(39, 0.22, 1.4, 0, 0.45, -1.5), 0xffffff, 1), part(B(39, 0.22, 1.4, 0, 0.45, 0), 0xffffff, 1), part(B(39, 0.22, 1.4, 0, 0.45, 1.5), 0xffffff, 1)]);
    const lamp = M([part(C(0.12, 0.09, 5.5, 0, 2.75, 0, 8), 0x2a2c30), part(B(1.6, 0.08, 0.08, 0, 5.4, 0), 0x2a2c30), part(C(0.35, 0.35, 0.12, 0, 0.06, 0, 10), 0x2a2c30)]);
    const bench = M([part(B(2.0, 0.08, 0.5, 0, 0.45, 0), 0x8a6238), part(B(2.0, 0.5, 0.06, 0, 0.75, -0.24).rotateX(-0.15), 0x8a6238), part(B(0.08, 0.45, 0.5, -0.9, 0.22, 0), 0x2a2c30), part(B(0.08, 0.45, 0.5, 0.9, 0.22, 0), 0x2a2c30)]);
    const pools = [], bowls = [], beds = [], waters = [];
    const jetsSmall = [], jetsBig = [];
    for (const s of MEGA_SITES) {
      if (s.kind !== 'boulevard') continue;
      pools.push(mx(s.x, 0, s.z));
      bowls.push(mx(s.x, 0, s.z));
      waters.push(s);
      // Ряд струй вдоль бассейна (по обе стороны от центра) и высокая струя в чаше
      for (let x = -poolL / 2 + 8; x <= poolL / 2 - 8; x += 7) {
        if (Math.abs(x) < 24) continue;
        jetsSmall.push(new THREE.Vector3(s.x + x, 0.4, s.z - 4.5), new THREE.Vector3(s.x + x, 0.4, s.z + 4.5));
      }
      jetsBig.push(new THREE.Vector3(s.x, 1.7, s.z));
      for (let k = 0; k < 10; k++) { const a = k / 10 * Math.PI * 2; jetsBig.push(Object.assign(new THREE.Vector3(s.x + Math.cos(a) * 12, 0.4, s.z + Math.sin(a) * 12), { k: 0.6 })); }
      for (const side of [-1, 1]) for (let x = -105; x <= 105; x += 42) {
        if (Math.abs(x) < 30) continue;
        beds.push(mx(s.x + x, 0, s.z + side * 16));
      }
      for (const side of [-1, 1]) for (let x = -128; x <= 128; x += 21) {
        this.lamps.push([s.x + x, s.z + side * 26, side > 0 ? Math.PI / 2 : -Math.PI / 2]);
        if (Math.abs(x) > 20) this.benches.push([s.x + x + 10, s.z + side * 22, side > 0 ? Math.PI : 0]);
      }
    }
    this.add(pool, pools, null, 2500, false);
    this.add(bowl, bowls, null, 2500, false);
    this.add(bed, beds, [0xd83a4a, 0xf2c030, 0x9a5ad8, 0xff7a3a, 0xf4f0e8], 900, false);
    this.lampGeo = lamp; this.benchGeo = bench;
    // Газоны бульвара: широкие полосы травы вдоль бассейна (под аллеями)
    const lawnMat = new THREE.MeshStandardMaterial({ color: 0x4a7a32, roughness: 0.95 });
    const lawnGeo = new THREE.PlaneGeometry(250, 20).rotateX(-Math.PI / 2);
    for (const s of waters) for (const oz of [-46, 46, -104, 104]) {
      const l = new THREE.Mesh(lawnGeo, lawnMat);
      l.position.set(s.x, 0.04, s.z + oz);
      l.receiveShadow = true;
      this.group.add(l);
    }
    // Вода бассейнов: светлая бирюза с бликами
    const wmat = new THREE.MeshStandardMaterial({ color: 0x2a7a88, roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.85 });
    for (const s of waters) {
      const w = new THREE.Mesh(new THREE.PlaneGeometry(poolL, poolW - 1).rotateX(-Math.PI / 2), wmat);
      w.position.set(s.x, 0.35, s.z);
      const c = new THREE.Mesh(new THREE.CircleGeometry(18.5, 40).rotateX(-Math.PI / 2), wmat);
      c.position.set(s.x, 0.36, s.z);
      this.group.add(w, c);
    }
    if (jetsSmall.length) this.addJets(makeJets(jetsSmall, { up: 6, spread: 0.25, life: 1.3, size: 0.35, n: 22 }));
    if (jetsBig.length) this.addJets(makeJets(jetsBig, { up: 17, spread: 0.6, life: 3.4, size: 0.6, n: 70 }));
  }
  addJets(p) { this.jets.push(p); this.group.add(p); }

  // ---------------------------------------------------------------- набережные
  buildEmbankments() {
    const granite = 0xa8a298;
    const edges = [RIVER_Z - RIVER_HALF_W, RIVER_Z + RIVER_HALF_W];
    // Гранитный парапет секциями по 4 м; разрывы у мостов (каждая вторая улица)
    const parapet = part(B(4.05, 1.0, 0.6, 0, 0.5, 0), granite);
    const segs = [], steps = [];
    const bridgeNear = (x) => {
      const k = Math.round((x + HALF) / CITY.block);
      return isBridgeRoad(k) && Math.abs(x - (-HALF + k * CITY.block)) < 13;
    };
    for (const z of edges) {
      const out = z < RIVER_Z ? -1 : 1;
      for (let x = -RIVERSIDE_HALF; x < RIVERSIDE_HALF; x += 4) {
        if (bridgeNear(x + 2)) continue;
        // Лестницы к воде: каждые ~300 м — разрыв в парапете и ступени вниз
        const st = Math.abs(((x + 150) % 300 + 300) % 300 - 150) < 4;
        if (st) { steps.push(mx(x + 2, 0, z + out * 0.3, out > 0 ? 0 : Math.PI)); continue; }
        segs.push(mx(x + 2, 0, z + out * 0.3));
      }
      for (let x = -RIVERSIDE_HALF + 12; x < RIVERSIDE_HALF; x += 28) {
        if (bridgeNear(x)) continue;
        this.lamps.push([x, z + out * 2.2, out > 0 ? -Math.PI / 2 : Math.PI / 2]);
        if (!bridgeNear(x + 14)) this.benches.push([x + 14, z + out * 3.2, out > 0 ? Math.PI : 0]);
      }
    }
    this.add(parapet, segs, null, 1800, false);
    // Ступени: спуск к воде вдоль парапета
    const stair = M(Array.from({ length: 6 }, (_, k) => part(B(4, 0.25, 0.5, 0, -k * 0.27, -k * 0.5 - 0.3), granite)));
    this.add(stair, steps, null, 900, false);
    // Причалы с теплоходами-ресторанами (вечером горят окна и гирлянды)
    const boat = M([
      part(new THREE.CapsuleGeometry(3.2, 22, 4, 12).rotateZ(Math.PI / 2).scale(1, 0.45, 1), 0xf4f1ea),
      part(B(22, 0.2, 6.2, 0, 1.1, 0), 0x8a6238),
      part(B(16, 2.4, 5.2, -1, 2.4, 0), 0xf4f1ea),
      part(B(16.2, 0.8, 5.4, -1, 2.6, 0), 0x2a3a48),          // полоса окон
      part(B(17, 0.15, 6, -1, 3.65, 0), 0x2a5a8a),
      part(B(6, 1.6, 4.4, -2, 4.5, 0), 0xf4f1ea),
      part(C(0.3, 0.3, 1.6, 4, 5.0, 0, 8), 0x2a5a8a),
    ]);
    const boats = [], wins = [];
    for (const [x, side] of [[-1500, -1], [-700, 1], [100, -1], [500, 1], [1300, -1], [2100, 1]]) {
      if (bridgeNear(x)) continue;
      const z = RIVER_Z + side * (RIVER_HALF_W - 5);
      boats.push(mx(x, WL - 0.3, z));
      for (const sz of [-1, 1]) wins.push(new THREE.Matrix4().compose(_v.set(x - 1, WL - 0.3 + 2.6, z + sz * 2.72), _q.identity(), _s.set(16, 0.6, 1)));
    }
    this.add(boat, boats, null, 2500);
    const winGeo = new THREE.BoxGeometry(1, 1, 0.05);
    this.boatWins = this.add(winGeo, wins, null, 2500, false, this.glowMat);
  }

  // ---------------------------------------------------------------- набережные степной реки
  // Гранитный парапет вдоль обоих берегов излучины (по касательной к берегу), лестницы,
  // фонари и скамейки; на пляжах парапета нет — там зонтики и лежаки; теплоходы у берега
  buildSteppeEmbankments() {
    const granite = 0xa8a298;
    const parapet = part(B(1, 1.0, 0.6, 0, 0.5, 0), granite);
    const segs = [], steps = [], umbrellas = [], loungers = [];
    const bridgeNear = (x) => {
      const k = Math.round((x + HALF) / CITY.block);
      return isBridgeRoad(k) && Math.abs(x - (-HALF + k * CITY.block)) < 13;
    };
    const footNear = (x) => Math.abs(x + 150) < 6 || Math.abs(x - 2250) < 6;
    const slope = (x) => (riverZAt(x + 1) - riverZAt(x - 1)) / 2;
    const L = PLANE_HALF - 30;
    for (const side of [-1, 1]) {
      for (let x = -L; x < L; x += 4) {
        const xm = x + 2;
        if (bridgeNear(xm) || footNear(xm)) continue;
        // За чертой города берег естественный — без гранита
        if (urbanScore(xm, riverZAt(xm) + side * (riverHWAt(xm) + 40)) < 0) continue;
        const k = beachK(xm, side), s = slope(xm), rot = -Math.atan(s);
        const z = riverZAt(xm) + side * (riverHWAt(xm) + 0.3);
        if (k > 0.25) {
          // Пляж: зонтики с парой лежаков в несколько рядов
          if (k > 0.8 && Math.abs((xm % 16 + 16) % 16 - 8) < 2) for (const row of [10, 20, 30]) {
            const zz = z + side * row;
            umbrellas.push(mx(xm, 0, zz, 0));
            loungers.push(mx(xm - 1.2, 0, zz + side * 1.5, rot), mx(xm + 1.2, 0, zz + side * 1.5, rot));
          }
          continue;
        }
        const st = Math.abs(((xm + 150) % 300 + 300) % 300 - 150) < 4;
        const m = new THREE.Matrix4().compose(_v.set(xm, 0, z), _q.setFromAxisAngle(UP, rot), _s.set(4.05 * Math.hypot(1, s), 1, 1));
        if (st) { steps.push(mx(xm, 0, z, side > 0 ? rot : rot + Math.PI)); continue; }
        segs.push(m);
      }
      for (let x = -L + 12; x < L; x += 28) {
        if (bridgeNear(x) || footNear(x) || beachK(x, side) > 0.25) continue;
        if (urbanScore(x, riverZAt(x) + side * (riverHWAt(x) + 40)) < 0) continue;
        const z = riverZAt(x) + side * (riverHWAt(x) + 2.2), rot = -Math.atan(slope(x));
        this.lamps.push([x, z, rot + (side > 0 ? -Math.PI / 2 : Math.PI / 2)]);
        if (!bridgeNear(x + 14)) this.benches.push([x + 14, riverZAt(x + 14) + side * (riverHWAt(x + 14) + 3.2), rot + (side > 0 ? Math.PI : 0)]);
      }
    }
    this.add(parapet, segs, null, 1800, false);
    const stair = M(Array.from({ length: 6 }, (_, k) => part(B(4, 0.25, 0.5, 0, -k * 0.27, -k * 0.5 - 0.3), granite)));
    this.add(stair, steps, null, 900, false);
    const umbrella = M([part(C(0.04, 0.04, 2.4, 0, 1.2, 0, 6), 0xe8e4dc), part(new THREE.ConeGeometry(1.5, 0.5, 10, 1, true).translate(0, 2.45, 0), 0xffffff, 1)]);
    this.add(umbrella, umbrellas, [0xe84a3a, 0xf2c030, 0x3a8ad8, 0xf4f0e8, 0x2aa88a], 700, false);
    const lounger = M([part(B(0.7, 0.12, 1.9, 0, 0.32, 0), 0xf4f0e8), part(B(0.7, 0.1, 0.7, 0, 0.55, -0.75).rotateX(-0.6), 0xf4f0e8)]);
    this.add(lounger, loungers, null, 500, false);
    // Теплоходы-рестораны у гранитных берегов
    const boat = M([
      part(new THREE.CapsuleGeometry(3.2, 22, 4, 12).rotateZ(Math.PI / 2).scale(1, 0.45, 1), 0xf4f1ea),
      part(B(22, 0.2, 6.2, 0, 1.1, 0), 0x8a6238),
      part(B(16, 2.4, 5.2, -1, 2.4, 0), 0xf4f1ea),
      part(B(16.2, 0.8, 5.4, -1, 2.6, 0), 0x2a3a48),
      part(B(17, 0.15, 6, -1, 3.65, 0), 0x2a5a8a),
      part(B(6, 1.6, 4.4, -2, 4.5, 0), 0xf4f1ea),
      part(C(0.3, 0.3, 1.6, 4, 5.0, 0, 8), 0x2a5a8a),
    ]);
    const boats = [], wins = [];
    for (const [x, side] of [[-3100, 1], [-1800, -1], [-900, 1], [300, -1], [900, 1], [2700, -1], [3300, -1]]) {
      if (bridgeNear(x) || beachK(x, side) > 0) continue;
      const z = riverZAt(x) + side * (riverHWAt(x) - 6), rot = -Math.atan(slope(x));
      boats.push(mx(x, WL - 0.3, z, rot));
      for (const sz of [-1, 1]) {
        const o = new THREE.Vector3(-1, 2.6, sz * 2.72).applyAxisAngle(UP, rot);
        wins.push(new THREE.Matrix4().compose(_v.set(x + o.x, WL - 0.3 + o.y, z + o.z), _q.setFromAxisAngle(UP, rot), _s.set(16, 0.6, 1)));
      }
    }
    this.add(boat, boats, null, 2500);
    this.boatWins = this.add(new THREE.BoxGeometry(1, 1, 0.05), wins, null, 2500, false, this.glowMat);
  }

  // ---------------------------------------------------------------- пешеходный мост-арка
  buildFootbridge(x) {
    const rz = riverZAt(x), hw = riverHWAt(x);
    const zA = rz - hw - 4, zB = rz + hw + 4, L = zB - zA, H = STEPPE ? 46 : 34;
    const parts = [];
    // Настил чуть выгнут, две белые арки над ним, ванты к краям настила
    const deckY = (t) => 0.6 + Math.sin(Math.PI * t) * 2.2;
    for (let i = 0; i < 20; i++) {
      const t0 = i / 20, t1 = (i + 1) / 20, z0 = zA + L * t0, z1 = zA + L * t1, y0 = deckY(t0), y1 = deckY(t1);
      const len = Math.hypot(z1 - z0, y1 - y0), ang = Math.atan2(y1 - y0, z1 - z0);
      parts.push(part(B(7, 0.5, len, 0, 0, 0).rotateX(-ang).translate(x, (y0 + y1) / 2, (z0 + z1) / 2), 0xe8e4dc));
      for (const sx of [-3.3, 3.3]) parts.push(part(B(0.08, 1.1, len, 0, 0.8, 0).rotateX(-ang).translate(x + sx, (y0 + y1) / 2, (z0 + z1) / 2), 0x9aa8b0));
    }
    const arch = (sx) => {
      const pts = [];
      for (let i = 0; i <= 24; i++) { const t = i / 24; pts.push(new THREE.Vector3(x + sx * (1 - Math.sin(Math.PI * t) * 0.6), deckY(t) + Math.sin(Math.PI * t) * H, zA + L * t)); }
      return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 40, 0.7, 8);
    };
    parts.push(part(arch(-4.5), 0xf4f2ee), part(arch(4.5), 0xf4f2ee));
    for (let i = 2; i < 23; i += 2) {
      const t = i / 24, z = zA + L * t, yA = deckY(t) + Math.sin(Math.PI * t) * H;
      for (const sx of [-1, 1]) {
        const ax = x + sx * 4.5 * (1 - Math.sin(Math.PI * t) * 0.6), bx = x + sx * 3.3;
        const len = Math.hypot(ax - bx, yA - deckY(t));
        parts.push(part(new THREE.CylinderGeometry(0.05, 0.05, len, 4).rotateZ(Math.atan2(ax - bx, yA - deckY(t)) * -1).translate((ax + bx) / 2, (yA + deckY(t)) / 2, z), 0xd8dce0));
      }
    }
    this.add(M(parts), [new THREE.Matrix4()], null, 6000);
  }

  // Фонари и скамейки бульваров и набережных — общими экземплярными мешами
  flushStreet() {
    this.add(this.lampGeo, this.lamps.map(([x, z, r]) => mx(x, 0, z, r)), null, 1500, false);
    this.add(this.benchGeo, this.benches.map(([x, z, r]) => mx(x, 0, z, r)), null, 600, false);
    // Плафоны фонарей светятся вечером
    const heads = [];
    for (const [x, z, r] of this.lamps) for (const sx of [-0.75, 0.75]) heads.push(new THREE.Vector3(sx, 5.25, 0).applyAxisAngle(UP, r).add(_v.set(x, 0, z)).clone());
    this.add(new THREE.SphereGeometry(0.28, 8, 6), heads.map((p) => mx(p.x, p.y, p.z)), null, 3000, false, this.glowMat);
  }

  update(dt, camPos, env) {
    const t = this.uTime.value += dt;
    for (const c of this.chunks) c.m.visible = camPos.distanceTo(c.c) < c.far;
    const glowK = Math.max(env.golden * 0.5, env.night);
    this.glowMat.color.setRGB(1, 0.86, 0.62).multiplyScalar(0.25 + 1.8 * glowK);
    // Фонтаны: днём белая вода, вечером — подсветка меняет цвет (медленный перелив)
    const fog = env.scene?.fog;
    for (const j of this.jets) {
      const u = j.material.uniforms;
      u.uTime.value = t;
      u.uGlow.value = env.night;
      u.uCol.value.setRGB(0.9, 0.95, 1).lerp(new THREE.Color().setHSL((t * 0.03) % 1, 0.8, 0.6), env.night * 0.8);
      if (fog) { u.uFogCol.value.copy(fog.color); u.uFogD.value = fog.density; }
      j.visible = camPos.distanceTo(j.geometry.boundingSphere.center) < 3000;
    }
  }
}
