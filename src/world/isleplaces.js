import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { WORLD } from '../config.js';
import { ISLE, ISLE_FALL, ISLE_LIGHTHOUSE, isleShoreAt, isleToWorld, islandSample, islandHeight } from './layout.js';
import { makeBeachGeometries } from './beach.js';

// Новые места Райского острова: водопад с озерцом в джунглях, тлеющий кратер вулкана,
// бунгало на сваях над лагуной, маяк на лавовом мысу, рыбацкая деревня, коралловый риф
// со стайками рыб, черепахи, фламинго, попугаи над лесом, остов старого корабля, плюмерии.

const WL = WORLD.waterLevel;
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const UP = new THREE.Vector3(0, 1, 0);
const AX = new THREE.Vector3(1, 0, 0);

// Части с атрибутами материала пляжа (как в island.js): цвет, tint, sway
function part(geo, color, tint = 0, swayFn = null) {
  if (geo.index) geo = geo.toNonIndexed();
  if (geo.attributes.uv) geo.deleteAttribute('uv');
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const n = geo.attributes.position.count, c = new THREE.Color(color), P = geo.attributes.position;
  const col = new Float32Array(n * 3), t = new Float32Array(n), sw = new Float32Array(n);
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; t[i] = tint; sw[i] = swayFn ? swayFn(P.getY(i)) : 0; }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('tint', new THREE.BufferAttribute(t, 1));
  geo.setAttribute('sway', new THREE.BufferAttribute(sw, 1));
  return geo;
}
const B = (w, h, d, x, y, z) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
const C = (r0, r1, h, x, y, z, s = 8) => new THREE.CylinderGeometry(r1, r0, h, s).translate(x, y, z);
const M = (l) => mergeGeometries(l);
const ico = (r, d = 0) => new THREE.IcosahedronGeometry(r, d);

// Система координат у берега по локальной точке острова (u, v) и нормали к морю (nu, nv)
function frameOf(L) {
  const [x, z] = isleToWorld(L.u, L.v);
  const [x2, z2] = isleToWorld(L.u + L.nu, L.v + L.nv);
  const n = new THREE.Vector2(x2 - x, z2 - z).normalize();
  return { x, z, n, t: new THREE.Vector2(-n.y, n.x) };
}

// Дым, брызги, пар: точки, которые сами поднимаются и тают в шейдере (один вызов отрисовки)
function makePuffs({ n, origin, spread, rise, drift, size, rate, color, color2, alpha, additive = false }) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(n * 3), seed = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { seed[i * 2] = Math.random(); seed[i * 2 + 1] = Math.random(); }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 2));
  geo.boundingSphere = new THREE.Sphere(origin.clone().add(new THREE.Vector3(drift.x * 0.5, rise * 0.5, drift.z * 0.5)), rise + spread + drift.length() + size[1]);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uOrigin: { value: origin.clone() }, uSpread: { value: spread }, uRise: { value: rise },
      uDrift: { value: drift.clone() }, uSize: { value: new THREE.Vector2(size[0], size[1]) }, uRate: { value: rate },
      uCol: { value: new THREE.Color(color) }, uCol2: { value: new THREE.Color(color2 ?? color) }, uAlpha: { value: alpha }, uScale: { value: 700 },
      uFogCol: { value: new THREE.Color() }, uFogD: { value: 0 },
    },
    vertexShader: `uniform float uTime, uSpread, uRise, uRate, uScale; uniform vec3 uOrigin, uDrift; uniform vec2 uSize;
      attribute vec2 aSeed; varying float vLife; varying float vDist;
      void main() {
        float life = fract(uTime * uRate * (0.8 + 0.4 * aSeed.y) + aSeed.x);
        vLife = life;
        float a = aSeed.x * 40.0 + aSeed.y * 13.0;
        vec3 p = uOrigin + vec3(cos(a), 0.0, sin(a)) * uSpread * (0.3 + 0.7 * aSeed.y) * (0.4 + life)
               + vec3(0.0, uRise * life, 0.0) + uDrift * life * life
               + vec3(sin(uTime * 0.7 + a), 0.0, cos(uTime * 0.6 + a)) * uSpread * 0.3 * life;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
        gl_PointSize = mix(uSize.x, uSize.y, sqrt(life)) * uScale / max(1.0, -mv.z);
      }`,
    fragmentShader: `uniform vec3 uCol, uCol2, uFogCol; uniform float uAlpha, uFogD; varying float vLife; varying float vDist;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r = dot(d, d) * 4.0;
        if (r > 1.0) discard;
        float a = (1.0 - r) * (1.0 - r) * uAlpha * smoothstep(0.0, 0.12, vLife) * (1.0 - vLife);
        vec3 c = mix(uCol, uCol2, smoothstep(0.0, 0.5, vLife));
        float f = 1.0 - exp(-uFogD * uFogD * vDist * vDist);
        gl_FragColor = vec4(mix(c, uFogCol, f), a);
      }`,
    transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = true;
  return pts;
}

// Текстура струй воды: вертикальные полосы разной плотности (для водопада)
function streakTexture() {
  const cv = document.createElement('canvas');
  cv.width = 64; cv.height = 256;
  const g = cv.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, 64, 256);
  for (let i = 0; i < 110; i++) {
    const x = Math.random() * 64, w = 1 + Math.random() * 4, y = Math.random() * 256, h = 40 + Math.random() * 180;
    const v = 170 + Math.random() * 85;
    const gr = g.createLinearGradient(0, y, 0, y + h);
    gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(0.5, `rgb(${v},${v},${v})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(x, y, w, h); g.fillRect(x, y - 256, w, h);
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

export class IslePlaces {
  constructor(isle) {
    this.isle = isle;
    this.mat = isle.tintMat;
    this.t = 0;
    this.puffs = [];
    this.flames = [];          // огни факелов и очагов (мерцают)
    this.winMat = new THREE.MeshBasicMaterial({ color: 0xffc070, toneMapped: false });
    this.G = makeBeachGeometries();
    this.buildCrater();
    this.buildWaterfall();
    this.buildBungalows();
    this.buildLighthouse();
    this.buildVillage();
    this.buildReef();
    this.buildWreck();
    this.buildCritters();
    this.buildFlames();
  }

  // Экземплярный меш из готовой геометрии; far — дальность показа (через vegChunks острова)
  add(geo, list, colors, { shadow = true, far = 1600, parent = null } = {}) {
    if (!list.length) return null;
    const m = new THREE.InstancedMesh(geo, this.mat, list.length);
    list.forEach((mx, i) => { m.setMatrixAt(i, mx); m.setColorAt(i, new THREE.Color(colors ? colors[i % colors.length] : 0xffffff)); });
    m.castShadow = shadow; m.receiveShadow = true;
    m.computeBoundingSphere();
    (parent || this.isle.near).add(m);
    if (!parent) this.isle.vegChunks.push({ m, x: m.boundingSphere.center.x, z: m.boundingSphere.center.z, far: far + m.boundingSphere.radius, full: list.length });
    return m;
  }
  mx(x, y, z, rot = 0, s = 1) { return new THREE.Matrix4().compose(_v.set(x, y, z), _q.setFromAxisAngle(UP, rot), _s.setScalar(s)); }
  ground(x, z) { return islandHeight(x, z) ?? WL; }
  puff(opts, parent = this.isle.near) { const p = makePuffs(opts); parent.add(p); this.puffs.push(p); return p; }

  // ---------------------------------------------------------------- кратер вулкана
  buildCrater() {
    // Вершина — самая высокая точка в окрестности пика
    let best = null;
    for (let u = -1100; u <= -200; u += 20) for (let v = -300; v <= 550; v += 20) {
      const [x, z] = isleToWorld(u, v);
      const s = islandSample(x, z);
      if (s && (!best || s.h > best.h)) best = { x, z, h: s.h };
    }
    const c = this.peak = new THREE.Vector3(best.x, best.h, best.z);
    // Конус из тёмного шлака с воронкой: кольцо глыб вокруг озера лавы
    const rim = [];
    for (let i = 0; i < 46; i++) {
      const a = i / 46 * Math.PI * 2, r = 30 + Math.random() * 8;
      const x = c.x + Math.cos(a) * r, z = c.z + Math.sin(a) * r, s = 7 + Math.random() * 6;
      rim.push(new THREE.Matrix4().compose(_v.set(x, Math.max(this.ground(x, z), c.y - 6) + s * 0.25, z), _q.setFromEuler(_e.set(Math.random() * 3, Math.random() * 3, Math.random() * 3)), _s.set(s * 1.3, s, s * 1.3)));
    }
    this.add(part(new THREE.DodecahedronGeometry(1, 0), 0x2a2420), rim, [0xffffff, 0xd8c8c0, 0xb8a8a0], { far: 7000 });
    // Озеро лавы: светится, по нему ползут тёмные корки (шум в шейдере)
    this.lavaMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uK: { value: 1 } },
      vertexShader: 'varying vec2 vP; void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform float uTime, uK; varying vec2 vP;
        float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float n(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
        void main() {
          vec2 p = vP * 0.12;
          float k = n(p + vec2(uTime * 0.05, 0.0)) * 0.6 + n(p * 2.3 - vec2(0.0, uTime * 0.08)) * 0.4;
          float crust = smoothstep(0.45, 0.62, k);
          vec3 hot = mix(vec3(1.0, 0.85, 0.3), vec3(1.0, 0.32, 0.05), smoothstep(0.2, 0.5, k));
          vec3 c = mix(hot * (1.6 + 0.4 * sin(uTime * 1.3 + k * 6.0)), vec3(0.08, 0.05, 0.04), crust);
          gl_FragColor = vec4(c * uK, 1.0);
        }`,
      toneMapped: false,
    });
    const lava = new THREE.Mesh(new THREE.CircleGeometry(31, 32), this.lavaMat);
    lava.rotation.x = -Math.PI / 2;
    lava.position.set(c.x, c.y - 1.5, c.z);
    this.isle.group.add(lava);
    // Дым: столб над кратером, снизу подсвечен лавой, сносит ветром
    this.smoke = this.puff({ n: 70, origin: new THREE.Vector3(c.x, c.y + 2, c.z), spread: 24, rise: 380, drift: new THREE.Vector3(260, 40, -120),
      size: [40, 190], rate: 0.022, color: 0xc07858, color2: 0x8a8a90, alpha: 0.32 }, this.isle.group);
  }

  // ---------------------------------------------------------------- водопад
  buildWaterfall() {
    const F = ISLE_FALL;
    const [px, pz] = isleToWorld(F.u, F.v);
    islandSample(px, pz);                          // считает высоту озерца, если ещё нет
    const wy = F.h - 0.1;
    const P = this.isle.party;
    // Обрыв — со стороны склона (вглубь острова от пляжа)
    const inl = new THREE.Vector3(-P.n.x, 0, -P.n.y), side = new THREE.Vector3(P.t.x, 0, P.t.y);
    const H = 36;
    const lip = new THREE.Vector3(px, wy + H, pz).addScaledVector(inl, F.r * 0.95);
    this.fallLip = lip;
    // Скальная стена: глыбы, сложенные дугой и уходящие назад в склон
    const rocks = [], moss = [];
    for (let i = 0; i < 90; i++) {
      const sa = (Math.random() - 0.5) * 2, back = Math.random() * 30, yk = Math.random();
      if (Math.abs(sa) < 0.18 && back < 6 && yk > 0.15) continue;           // за самой струёй — ниша
      const p = lip.clone().addScaledVector(side, sa * (20 + back * 0.4)).addScaledVector(inl, 2 + back + Math.abs(sa) * 6);
      p.y = wy - 2 + yk * (H + 2) * (1 - Math.abs(sa) * 0.25);
      const s = 5 + Math.random() * 7;
      const mxr = new THREE.Matrix4().compose(p, _q.setFromEuler(_e.set(Math.random() * 3, Math.random() * 3, Math.random() * 3)), _s.set(s * 1.2, s, s * 1.2));
      (yk > 0.85 || Math.random() < 0.3 ? moss : rocks).push(mxr);
    }
    const rockGeo = part(new THREE.DodecahedronGeometry(1, 0), 0xffffff, 1);
    this.add(rockGeo, rocks, [0x4a4640, 0x55504a, 0x3e3a36], { far: 3500 });
    this.add(rockGeo, moss, [0x3d5a2e, 0x4a6a34, 0x34502a], { far: 3500 });
    // Папоротники и лианы по краю обрыва
    const ferns = [];
    for (let i = 0; i < 24; i++) {
      const p = lip.clone().addScaledVector(side, (Math.random() - 0.5) * 44).addScaledVector(inl, Math.random() * 10);
      ferns.push(this.mx(p.x, p.y + 2, p.z, Math.random() * 6.28, 1.2 + Math.random()));
    }
    const leaf = M([0, 1, 2, 3, 4, 5, 6].map((k) => part(new THREE.PlaneGeometry(0.7, 2.6).translate(0, 1.3, 0).rotateX(-0.9).rotateY(k * 0.9), 0xffffff, 1, (y) => y * 0.15)));
    this.add(leaf, ferns, [0x3a8a2a, 0x4a9a34, 0x2f7a28], { shadow: false, far: 900 });
    // Озерцо: прозрачная бирюза, по краю — камни
    const pond = new THREE.Mesh(new THREE.CircleGeometry(F.r * 1.12, 40), new THREE.MeshStandardMaterial({ color: 0x0c5a64, roughness: 0.06, metalness: 0.2, transparent: true, opacity: 0.86 }));
    pond.rotation.x = -Math.PI / 2;
    pond.position.set(px, wy, pz);
    this.isle.near.add(pond);
    const stones = [];
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * 6.28, r = F.r * (1.05 + Math.random() * 0.25);
      const x = px + Math.cos(a) * r, z = pz + Math.sin(a) * r, s = 0.8 + Math.random() * 1.8;
      stones.push(new THREE.Matrix4().compose(_v.set(x, this.ground(x, z) - s * 0.3, z), _q.setFromEuler(_e.set(a, a * 2, 0)), _s.set(s * 1.3, s * 0.7, s)));
    }
    this.add(rockGeo, stones, [0x5a5650, 0x6a665e, 0x4a5a3a], { far: 1200 });
    // Струя: две ленты с бегущими полосами, вылетает с уступа дугой и расширяется книзу
    const ribbon = (w0, w1, fwd) => {
      const seg = 28, pos = [], uv = [], idx = [];
      for (let i = 0; i <= seg; i++) {
        const k = i / seg;
        const c = lip.clone().addScaledVector(inl, -fwd * Math.sqrt(k) - 0.5);
        c.y = lip.y - (H + 0.2) * k;
        const w = (w0 + (w1 - w0) * k) / 2;
        for (const sgn of [-1, 1]) { const p = c.clone().addScaledVector(side, w * sgn); pos.push(p.x, p.y, p.z); uv.push(sgn < 0 ? 0 : 1, k * 3); }
        if (i < seg) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      return g;
    };
    const tex = streakTexture(), tex2 = tex.clone();
    tex2.needsUpdate = true; tex2.repeat.set(1.7, 1);
    this.fallTex = [tex, tex2];
    const fm = (t, op) => new THREE.MeshBasicMaterial({ color: 0xe6f6ff, alphaMap: t, transparent: true, opacity: op, depthWrite: false, side: THREE.DoubleSide });
    const r1 = new THREE.Mesh(ribbon(8, 11, 5), fm(tex, 1.0)), r2 = new THREE.Mesh(ribbon(10, 14, 6.5), fm(tex2, 0.7));
    this.isle.near.add(r1, r2);
    // Брызги и водяная пыль у подножия, пена кругами по воде
    const foot = new THREE.Vector3(px, wy, pz).addScaledVector(inl, F.r * 0.95 - 6);
    this.fallFoot = foot;
    this.puff({ n: 90, origin: foot, spread: 7, rise: 16, drift: new THREE.Vector3(-P.n.x * 10, 4, -P.n.y * 10).negate(), size: [2, 9], rate: 0.35, color: 0xffffff, color2: 0xe8f4ff, alpha: 0.2 });
    const foam = new THREE.Mesh(new THREE.RingGeometry(3, 11, 32), new THREE.MeshBasicMaterial({ color: 0xf4fbff, transparent: true, opacity: 0.55, depthWrite: false }));
    foam.rotation.x = -Math.PI / 2;
    foam.position.copy(foot).setY(wy + 0.05);
    this.foam = foam;
    this.isle.near.add(foam);
  }

  // ---------------------------------------------------------------- бунгало над лагуной
  buildBungalows() {
    const P = this.isle.party, isle = this.isle;
    const A = -215;                                      // линия причала вдоль пляжа
    // Где кончается песок на этой линии
    let b0 = 0;
    for (let b = 40; b > -400; b -= 2) { if (isle.at(P, A, b).y < WL - 0.3) { b0 = b + 6; break; } }
    const deckY = WL + 2.3;
    const pt = (a, b) => { const p = isle.at(P, a, b); return p.setY(deckY); };
    const face = isle.faceSea(P);
    const walk = [], posts = [];
    const L = 190;
    for (let d = 0; d < L; d += 3) {
      const p = pt(A, b0 - d);
      walk.push(this.mx(p.x, p.y, p.z, face));
      if (d % 6 === 0) for (const sx of [-1.3, 1.3]) { const q = pt(A + sx, b0 - d); posts.push(this.mx(q.x, q.y, q.z, face)); }
    }
    const plank = M([part(B(2.6, 0.18, 3.05, 0, 0, 0), 0x9a7a58), part(B(0.08, 0.9, 3.05, -1.25, 0.5, 0), 0x7a5c3c), part(B(0.08, 0.9, 3.05, 1.25, 0.5, 0), 0x7a5c3c)]);
    const post = part(C(0.13, 0.13, 6, 0, -3, 0, 6), 0x5a4028);
    this.add(plank, walk, null, { far: 2400 });
    this.add(post, posts, null, { shadow: false, far: 1500 });
    // Домики: сваи, настил с террасой и лесенкой в воду, стены, соломенная крыша-пирамида
    const straw = 0xc9a45c, wall = 0xd8c09a;
    const hut = M([
      ...[[-3.6, -3.6], [3.6, -3.6], [-3.6, 3.6], [3.6, 3.6], [0, -3.6], [0, 3.6], [-3.6, 0], [3.6, 0]].map(([x, z]) => part(C(0.18, 0.18, 6, x, -3, z, 6), 0x5a4028)),
      part(B(8.4, 0.25, 8.4, 0, 0, 0), 0x9a7a58),
      part(B(8.4, 0.25, 3.4, 0, 0, 5.8), 0xa88a62),                                   // терраса к морю
      part(B(0.08, 0.9, 3.4, -4.15, 0.55, 5.8), 0x7a5c3c), part(B(0.08, 0.9, 3.4, 4.15, 0.55, 5.8), 0x7a5c3c), part(B(8.4, 0.08, 0.08, 0, 1.0, 7.45), 0x7a5c3c),
      part(B(0.6, 0.08, 1.6, 2.6, 0.13, 5.6), 0xf4ecdc), part(B(0.6, 0.08, 1.6, 3.5, 0.13, 5.6), 0xf4ecdc),   // шезлонги
      ...[0, 1, 2, 3].map((k) => part(B(0.7, 0.05, 0.25, -3.0, -0.4 - k * 0.5, 7.4), 0x7a5c3c)),          // лесенка в воду
      part(B(6, 3.1, 6, 0, 1.68, 0), wall),
      part(B(2.0, 2.3, 0.1, 0, 1.3, 3.02), 0x2a3640),                                    // стеклянная дверь
      part(new THREE.ConeGeometry(6.4, 3.6, 4).rotateY(Math.PI / 4).translate(0, 5.0, 0), straw),
      part(new THREE.ConeGeometry(6.6, 0.4, 4, 1, true).rotateY(Math.PI / 4).translate(0, 3.35, 0), 0xb08a48),
      part(C(0.25, 0.05, 1.0, 0, 7.2, 0, 5), 0x8a6238),
    ]);
    const huts = [], wins = [], links = [];
    let k = 0;
    for (let d = 40; d < L; d += 34) for (const sgn of [-1, 1]) {
      const a = A + sgn * 15, b = b0 - d - (sgn > 0 ? 17 : 0);
      const c = pt(a, b);
      // Терраса — к морю (вдоль причала наружу)
      huts.push(this.mx(c.x, c.y, c.z, face + Math.PI * 0.0 + (sgn > 0 ? -0.15 : 0.15), 1));
      const cl = pt(A + sgn * 6, b);
      links.push(this.mx(cl.x, cl.y, cl.z, face + Math.PI / 2));
      // Окна по бокам двери: светятся вечером
      for (const wx of [-2.0, 2.0]) {
        const w = new THREE.Vector3(wx, 1.8, 3.04).applyAxisAngle(UP, face + (sgn > 0 ? -0.15 : 0.15));
        wins.push(new THREE.Matrix4().compose(_v.set(c.x + w.x, c.y + w.y, c.z + w.z), _q.setFromAxisAngle(UP, face + (sgn > 0 ? -0.15 : 0.15)), _s.set(1, 1, 1)));
      }
      k++;
    }
    this.add(hut, huts, null, { far: 3500 });
    this.add(plank, links, null, { far: 1800 });
    const winMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1.1, 1.0), this.winMat, wins.length);
    wins.forEach((m, i) => winMesh.setMatrixAt(i, m));
    this.isle.near.add(winMesh);
    // Факелы вдоль причала
    for (let d = 10; d < L; d += 24) for (const sx of [-1.4, 1.4]) { const p = pt(A + sx, b0 - d); this.flames.push({ p: p.setY(p.y + 2.3), s: 0.4, torch: true }); }
    this.pierLine = { A, b0, L };
  }

  // ---------------------------------------------------------------- маяк
  buildLighthouse() {
    const L = frameOf(ISLE_LIGHTHOUSE);
    const y0 = this.ground(L.x, L.z) - 0.5;
    const red = 0xc8352e, white = 0xf2efe8;
    const bands = [];
    const H = 30, n = 6;
    for (let i = 0; i < n; i++) {
      const r0 = 3.4 - i * 0.28, r1 = 3.4 - (i + 1) * 0.28;
      bands.push(part(C(r0, r1, H / n, 0, H / n * (i + 0.5), 0, 16), i % 2 ? red : white));
    }
    const tower = M([
      part(C(4.6, 4.2, 2.0, 0, 0.6, 0, 16), 0x6a6660),
      ...bands,
      part(C(2.9, 2.9, 0.4, 0, H + 0.2, 0, 16), 0x2a2a2a),                  // площадка
      part(new THREE.TorusGeometry(2.8, 0.06, 4, 24).rotateX(Math.PI / 2).translate(0, H + 1.2, 0), 0x2a2a2a),
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((k) => part(B(0.06, 1.0, 0.06, Math.cos(k * 0.785) * 2.8, H + 0.7, Math.sin(k * 0.785) * 2.8), 0x2a2a2a)),
      part(C(1.7, 1.7, 3.0, 0, H + 1.9, 0, 12), 0x36444c),                   // остеклённый фонарь
      part(new THREE.ConeGeometry(2.1, 1.8, 12).translate(0, H + 4.3, 0), red),
      part(C(0.08, 0.02, 1.2, 0, H + 5.6, 0, 4), 0x2a2a2a),
      // Домик смотрителя
      part(B(7, 3.4, 5, 7.5, 1.7, 0), white), part(new THREE.CylinderGeometry(0.01, 4.4, 2.2, 4, 1).rotateY(Math.PI / 4).scale(1.15, 1, 0.85).translate(7.5, 4.5, 0), red),
      part(B(1.0, 2.0, 0.1, 7.5, 1.0, 2.52), 0x5a3a22),
    ]);
    const rot = Math.atan2(L.n.x, L.n.y);
    this.add(tower, [this.mx(L.x, y0, L.z, rot)], null, { far: 9000, parent: this.isle.group });
    // Свет фонаря и два вращающихся луча (видны в сумерках и ночью, даже из города)
    this.lhTop = new THREE.Vector3(L.x, y0 + H + 1.9, L.z);
    this.lampMat = new THREE.MeshBasicMaterial({ color: 0xfff0c0, toneMapped: false });
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(1.1, 12, 8), this.lampMat);
    lamp.position.copy(this.lhTop);
    this.isle.group.add(lamp);
    this.beamMat = new THREE.ShaderMaterial({
      uniforms: { uK: { value: 0 } },
      vertexShader: 'varying float vY; void main() { vY = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform float uK; varying float vY; void main() { gl_FragColor = vec4(vec3(1.0, 0.92, 0.7) * uK * pow(vY, 2.2) * 0.35, 1.0); }',
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
    });
    // Конус: узкий конец у фонаря (uv.y = 1), широкий вдали
    const cone = new THREE.ConeGeometry(16, 320, 16, 1, true).translate(0, -160, 0).rotateZ(Math.PI / 2);
    const beams = new THREE.Group();
    beams.add(new THREE.Mesh(cone, this.beamMat));
    beams.add(new THREE.Mesh(cone.clone().rotateY(Math.PI), this.beamMat));
    beams.children.forEach((b) => { b.frustumCulled = false; });
    beams.position.copy(this.lhTop);
    this.beams = beams;
    this.isle.group.add(beams);
  }

  // ---------------------------------------------------------------- рыбацкая деревня
  buildVillage() {
    const F = this.village = frameOf(isleShoreAt(1.75, 0));
    const isle = this.isle, face = isle.faceSea(F);
    const at = (a, b) => isle.at(F, a, b);
    const roofC = 0xc4a058, wallC = 0xb89868;
    // Хижина на низких сваях: плетёные стены, двускатная соломенная крыша, крыльцо
    const roof = new THREE.CylinderGeometry(3.2, 3.2, 6.4, 3, 1).rotateZ(Math.PI / 2).scale(1, 0.75, 1).translate(0, 4.6, 0);
    const hut = M([
      ...[[-2.4, -1.9], [2.4, -1.9], [-2.4, 1.9], [2.4, 1.9]].map(([x, z]) => part(C(0.14, 0.14, 1.4, x, 0.7, z, 6), 0x5a4028)),
      part(B(5.4, 0.2, 4.4, 0, 1.4, 0), 0x8a6a48),
      part(B(4.6, 2.2, 3.6, 0, 2.6, 0), wallC),
      part(B(1.0, 1.6, 0.08, 0.6, 2.3, 1.82), 0x3a2618),
      part(B(1.6, 0.12, 1.4, 0.6, 1.4, 2.8), 0x8a6a48),
      ...[0, 1, 2].map((k) => part(B(1.0, 0.08, 0.3, 0.6, 1.05 - k * 0.35, 3.55 + k * 0.3), 0x6b4a2c)),
      part(roof, roofC),
    ]);
    const huts = [], spots = [[-32, 34], [-14, 42], [6, 38], [24, 44], [42, 32], [-46, 52], [-2, 62], [30, 64]];
    const wins = [];
    spots.forEach(([a, b], i) => {
      const p = at(a, b), r = face + (Math.random() - 0.5) * 0.5;
      huts.push(this.mx(p.x, p.y, p.z, r));
      const w = new THREE.Vector3(-1.2, 2.6, 1.83).applyAxisAngle(UP, r);
      wins.push(new THREE.Matrix4().compose(_v.set(p.x + w.x, p.y + w.y, p.z + w.z), _q.setFromAxisAngle(UP, r), _s.set(0.8, 0.7, 1)));
    });
    this.add(hut, huts, [0xffffff, 0xe8d8c0, 0xf0e0c8], { far: 3200 });
    const winMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), this.winMat, wins.length);
    wins.forEach((m, i) => winMesh.setMatrixAt(i, m));
    this.isle.near.add(winMesh);
    // Сети на шестах, вешала с рыбой, бочки, корзины
    const net = M([
      part(C(0.06, 0.06, 2.6, -2, 1.3, 0, 5), 0x6b4a2c), part(C(0.06, 0.06, 2.6, 2, 1.3, 0, 5), 0x6b4a2c),
      part(new THREE.PlaneGeometry(4, 1.8, 6, 3).translate(0, 1.5, 0), 0x6a7a6a, 0, (y) => y * 0.25),
      ...[0, 1, 2, 3, 4].map((k) => part(new THREE.ConeGeometry(0.06, 0.45, 4).rotateX(Math.PI).translate(-1.6 + k * 0.8, 2.25, 0.05), 0xa8b0b8)),
    ]);
    const nets = [];
    for (const [a, b] of [[-22, 18], [14, 20], [34, 16], [-40, 24]]) { const p = at(a, b); nets.push(this.mx(p.x, p.y, p.z, face + Math.PI / 2 + (Math.random() - 0.5) * 0.4)); }
    this.add(net, nets, null, { far: 1200 });
    const barrel = M([part(C(0.4, 0.45, 1.0, 0, 0.5, 0, 10), 0x7a5a38), part(new THREE.TorusGeometry(0.44, 0.03, 4, 12).rotateX(Math.PI / 2).translate(0, 0.25, 0), 0x3a3a3a), part(new THREE.TorusGeometry(0.44, 0.03, 4, 12).rotateX(Math.PI / 2).translate(0, 0.75, 0), 0x3a3a3a)]);
    const barrels = [];
    for (let i = 0; i < 14; i++) { const p = at(-40 + Math.random() * 80, 24 + Math.random() * 30); barrels.push(this.mx(p.x, p.y, p.z, Math.random() * 6)); }
    this.add(barrel, barrels, null, { far: 800 });
    // Причал и каноэ с балансиром: на песке и на воде (покачиваются)
    const canoe = M([
      part(new THREE.CapsuleGeometry(0.42, 5.2, 4, 10).rotateZ(Math.PI / 2).scale(1, 0.55, 0.65).translate(0, 0.25, 0), 0xffffff, 1),
      part(B(0.07, 0.07, 2.2, -1.1, 0.45, 1.0), 0x6b4a2c), part(B(0.07, 0.07, 2.2, 1.1, 0.45, 1.0), 0x6b4a2c),
      part(new THREE.CapsuleGeometry(0.1, 2.6, 3, 6).rotateZ(Math.PI / 2).translate(0, 0.12, 2.1), 0x6b4a2c),
      part(B(0.06, 0.06, 1.6, 0.8, 0.5, -0.4).rotateX(0.3), 0x8a6238),
    ]);
    const canoes = [];
    for (let i = 0; i < 5; i++) { const p = at(-30 + i * 13, 6 + Math.random() * 4); canoes.push(this.mx(p.x, p.y, p.z, face + Math.PI / 2 + (Math.random() - 0.5) * 0.4)); }
    const canoeCols = [0x8a4a2a, 0x2a6a8a, 0xc85a3a, 0x3a7a5a, 0xd8a040, 0x6a3a5a];
    this.add(canoe, canoes, canoeCols, { far: 1200 });
    // Дощатый причал в воду
    let b0 = 0;
    for (let b = 20; b > -200; b -= 2) { if (at(10, b).y < WL - 0.2) { b0 = b + 4; break; } }
    const deck = [], piles = [];
    for (let d = 0; d < 46; d += 3) {
      const p = at(10, b0 - d);
      deck.push(this.mx(p.x, WL + 1.3, p.z, face));
      if (d % 6 === 0) for (const sx of [-1.1, 1.1]) { const q = at(10 + sx, b0 - d); piles.push(this.mx(q.x, WL + 1.3, q.z, face)); }
    }
    this.add(part(B(2.2, 0.15, 3.05, 0, 0, 0), 0x8a6a48), deck, null, { far: 1500 });
    this.add(part(C(0.12, 0.12, 5, 0, -2.4, 0, 6), 0x4a3420), piles, null, { shadow: false, far: 1000 });
    // Лодки на воде: качаются на волнах (обновляются в update)
    this.boats = [];
    const bm = new THREE.InstancedMesh(canoe, this.mat, 4);
    for (let i = 0; i < 4; i++) {
      const p = at(-40 + i * 30 + Math.random() * 10, b0 - 30 - Math.random() * 60);
      this.boats.push({ p: p.setY(WL - 0.05), rot: Math.random() * 6.28, ph: Math.random() * 6 });
      bm.setColorAt(i, new THREE.Color(canoeCols[(i + 2) % canoeCols.length]));
    }
    bm.castShadow = true;
    this.boatMesh = bm;
    this.isle.near.add(bm);
    // Очаг посреди деревни: огонь и дымок
    const fire = at(4, 28);
    this.add(M([part(new THREE.TorusGeometry(1.0, 0.2, 6, 12).rotateX(Math.PI / 2).translate(0, 0.1, 0), 0x5a5650),
      ...[0, 1, 2].map((k) => part(C(0.1, 0.1, 1.3, 0, 0.12, 0, 5).rotateZ(Math.PI / 2).rotateY(k * 1.05), 0x3a2618))]), [this.mx(fire.x, fire.y, fire.z)], null, { far: 900 });
    this.flames.push({ p: fire.clone().setY(fire.y + 0.15), s: 1.2 });
    this.puff({ n: 30, origin: fire.clone().setY(fire.y + 1.5), spread: 0.6, rise: 26, drift: new THREE.Vector3(8, 4, 5), size: [1.5, 8], rate: 0.12, color: 0x9a9690, color2: 0xb8b8b8, alpha: 0.35 });
    // Факелы по краю деревни
    for (const [a, b] of [[-50, 20], [-20, 26], [20, 28], [50, 22], [-8, 52], [18, 54]]) {
      const p = at(a, b);
      this.add(part(C(0.05, 0.07, 2.4, 0, 1.2, 0, 6), 0x9a7a48), [this.mx(p.x, p.y, p.z)], null, { shadow: false, far: 700 });
      this.flames.push({ p: p.setY(p.y + 2.5), s: 0.45, torch: true });
    }
    // Пальмы и цветущие плюмерии вокруг хижин
    const palms = [];
    for (let i = 0; i < 16; i++) { const p = at(-70 + Math.random() * 140, 12 + Math.random() * 60); palms.push(this.mx(p.x, p.y - 0.3, p.z, Math.random() * 6.28, 1 + Math.random() * 0.4)); }
    this.add(this.G.palm, palms, null, { far: 3000 });
    this.buildPlumeria([
      ...Array.from({ length: 10 }, () => at(-60 + Math.random() * 120, 30 + Math.random() * 40)),
      ...Array.from({ length: 8 }, () => isle.at(isle.party, -260 + Math.random() * 90, 40 + Math.random() * 40)),
    ]);
  }

  buildPlumeria(points) {
    const flower = (x, y, z) => part(new THREE.SphereGeometry(0.22, 5, 4).scale(1, 0.5, 1).translate(x, y, z), 0xffffff, 1);
    const tree = M([
      part(C(0.22, 0.16, 2.4, 0, 1.2, 0, 6), 0x8a7a68),
      ...[0, 1, 2, 3].map((k) => part(C(0.12, 0.07, 2.2, 0, 1.1, 0, 5).rotateZ(0.7).rotateY(k * 1.57 + 0.3).translate(0, 2.2, 0), 0x8a7a68)),
      ...[0, 1, 2, 3].map((k) => part(ico(1.0).scale(1.2, 0.55, 1.2).translate(Math.cos(k * 1.57 + 0.3) * 1.5, 3.4, -Math.sin(k * 1.57 + 0.3) * 1.5), 0x3f7a2e, 0, (y) => y * 0.05)),
      ...Array.from({ length: 22 }, (_, i) => flower(Math.cos(i * 2.4) * (0.6 + (i % 5) * 0.3), 3.6 + (i % 3) * 0.2, Math.sin(i * 2.4) * (0.6 + (i % 5) * 0.3))),
    ]);
    this.add(tree, points.map((p) => this.mx(p.x, p.y, p.z, Math.random() * 6.28, 0.9 + Math.random() * 0.5)), [0xfff6e0, 0xff9ac0, 0xffe070, 0xff6a9a], { far: 1400 });
  }

  // ---------------------------------------------------------------- коралловый риф и рыбы
  buildReef() {
    const isle = this.isle, P = isle.party, pl = this.pierLine;
    const branch = M([0, 1, 2, 3, 4, 5].map((k) => part(new THREE.ConeGeometry(0.12, 1.2 + (k % 3) * 0.4, 5).translate(0, 0.6, 0).rotateZ((k % 3 - 1) * 0.5).rotateY(k * 1.1), 0xffffff, 1)));
    const brain = part(new THREE.SphereGeometry(0.9, 9, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.7, 1), 0xffffff, 1);
    const fan = part(new THREE.CircleGeometry(0.9, 10, 0, Math.PI).translate(0, 0.1, 0), 0xffffff, 1, (y) => y * 0.2);
    const tube = M([0, 1, 2, 3].map((k) => part(C(0.14, 0.18, 0.6 + k * 0.25, Math.cos(k * 1.7) * 0.3, 0.3 + k * 0.12, Math.sin(k * 1.7) * 0.3, 6), 0xffffff, 1)));
    const lists = [[], [], [], []];
    const centers = [];
    let tries = 0;
    while (centers.length < 70 && tries++ < 4000) {
      const a = -330 + Math.random() * 660, b = -60 - Math.random() * 380;
      if (Math.abs(a - pl.A) < 30 && b < pl.b0 + 10 && b > pl.b0 - pl.L - 20) continue;
      const p = isle.at(P, a, b);
      if (p.y > WL - 1.4 || p.y < WL - 7) continue;
      centers.push(p);
    }
    for (const c of centers) for (let i = 0; i < 12; i++) {
      const x = c.x + (Math.random() - 0.5) * 14, z = c.z + (Math.random() - 0.5) * 14;
      const y = this.ground(x, z);
      if (y > WL - 1.0) continue;
      const type = Math.floor(Math.random() * 4);
      lists[type].push(new THREE.Matrix4().compose(_v.set(x, y - 0.1, z), _q.setFromAxisAngle(UP, Math.random() * 6.28), _s.setScalar(0.7 + Math.random() * 1.1)));
    }
    const cols = [0xff5a6a, 0xff8a3a, 0xc85ad8, 0xffd040, 0x3ad0c0, 0xff7ab0, 0xf2f0e0];
    [branch, brain, fan, tube].forEach((g, i) => this.add(g, lists[i], cols.slice(i).concat(cols.slice(0, i)), { shadow: false, far: 700 }));
    // Стайки тропических рыб кружат над кораллами
    const fishGeo = M([part(new THREE.SphereGeometry(0.16, 6, 4).scale(1.8, 1, 0.5), 0xffffff, 1), part(new THREE.ConeGeometry(0.12, 0.2, 4).rotateZ(Math.PI / 2).translate(-0.36, 0, 0), 0xffffff, 1)]);
    this.schools = [];
    const nS = Math.min(6, centers.length), per = 26;
    const fm = new THREE.InstancedMesh(fishGeo, this.mat, nS * per);
    const fcols = [0xffd040, 0x3ab0ff, 0xff7a3a, 0x8aff6a, 0xff5ab0, 0xffffff];
    for (let s = 0; s < nS; s++) {
      const c = centers[Math.floor(s * centers.length / nS)];
      this.schools.push({ c, r: 4 + Math.random() * 5, sp: (0.25 + Math.random() * 0.3) * (s % 2 ? 1 : -1), depth: Math.max(c.y + 0.8, WL - 1.0), ph: Math.random() * 6 });
      for (let i = 0; i < per; i++) fm.setColorAt(s * per + i, new THREE.Color(fcols[s % fcols.length]));
    }
    fm.frustumCulled = false;
    this.fishMesh = fm; this.fishPer = per;
    this.fishOff = Array.from({ length: nS * per }, () => [Math.random() * 6.28, (Math.random() - 0.5) * 2.4, (Math.random() - 0.5) * 1.2]);
    this.isle.near.add(fm);
  }

  // ---------------------------------------------------------------- остов корабля у тихой бухты
  buildWreck() {
    const isle = this.isle, Cv = isle.cove;
    let p = null;
    for (let b = -60; b > -600 && !p; b -= 5) { const q = isle.at(Cv, 70, b); if (q.y < WL - 3.5) p = q; }
    if (!p) return;
    const wood = 0x4a3a2a, dark = 0x2a2018;
    const hull = M([
      part(new THREE.CapsuleGeometry(3.2, 20, 4, 12).rotateZ(Math.PI / 2).scale(1, 0.75, 0.85), wood),
      part(B(20, 0.3, 4.8, 0, 1.9, 0), 0x6a5238),
      part(B(5, 2.2, 4.4, -7, 3.0, 0), wood),                                           // кормовая надстройка
      part(C(0.35, 0.3, 14, 2, 8.5, 0, 6).rotateZ(0.35), dark),                          // сломанная мачта
      part(C(0.3, 0.25, 4, -4, 3.5, 0, 6), dark),
      part(B(0.2, 0.2, 7, 1.2, 9, 0).rotateX(0.4), dark),                                // рея
      ...[0, 1, 2, 3, 4].map((k) => part(new THREE.TorusGeometry(3.0, 0.18, 4, 10, Math.PI).rotateY(Math.PI / 2).rotateX(Math.PI).translate(8 + k * 1.6, 1.8, 0), dark)),  // рёбра носа
      part(new THREE.PlaneGeometry(4, 3).rotateY(0.3).translate(3, 10, 1), 0xb8a888, 0, (y) => (y - 8.5) * 0.4),  // обрывок паруса
    ]);
    const m = new THREE.Matrix4().compose(_v.set(p.x, WL - 1.6, p.z), _q.setFromEuler(_e.set(0.32, isle.faceSea(Cv) + 0.9, 0.12)), _s.setScalar(1));
    this.add(hull, [m], null, { far: 3000 });
  }

  // ---------------------------------------------------------------- черепахи, фламинго, попугаи
  buildCritters() {
    const isle = this.isle, P = isle.party, V = this.village;
    // Черепахи: панцирь, голова, ласты — ползут вдоль кромки воды туда-обратно
    const turtle = M([
      part(new THREE.SphereGeometry(0.55, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1.25, 0.6, 1), 0x5a6a3a),
      part(B(1.1, 0.06, 0.9, 0, 0.03, 0), 0xd8c898),
      part(new THREE.SphereGeometry(0.17, 6, 5).scale(1.3, 1, 1).translate(0.82, 0.1, 0), 0x8a8a5a),
      ...[[0.35, 0.55, 0.5], [0.35, -0.55, -0.5], [-0.45, 0.45, 0.3], [-0.45, -0.45, -0.3]].map(([x, z, r]) => part(B(0.5, 0.05, 0.18, x, 0.05, z).rotateY(r), 0x7a7a4a)),
    ]);
    this.turtles = [];
    const tm = new THREE.InstancedMesh(turtle, this.mat, 6);
    for (let i = 0; i < 6; i++) this.turtles.push({ a0: -170 + i * 60 + Math.random() * 20, b: -44 + Math.random() * 8, ph: Math.random() * 6.28, sp: 0.05 + Math.random() * 0.04 });
    tm.castShadow = true;
    this.turtleMesh = tm;
    this.isle.near.add(tm);
    // Фламинго на мелководье у деревни: стоят на одной ноге, изредка кланяются к воде
    const neck = new THREE.CatmullRomCurve3([new THREE.Vector3(0.25, 1.0, 0), new THREE.Vector3(0.45, 1.35, 0), new THREE.Vector3(0.3, 1.7, 0), new THREE.Vector3(0.45, 1.85, 0)]);
    const bird = M([
      part(new THREE.SphereGeometry(0.3, 8, 6).scale(1.5, 0.9, 0.9).translate(0, 1.0, 0), 0xffffff, 1),
      part(new THREE.TubeGeometry(neck, 8, 0.05, 5), 0xffffff, 1),
      part(new THREE.SphereGeometry(0.09, 6, 5).translate(0.47, 1.87, 0), 0xffffff, 1),
      part(new THREE.ConeGeometry(0.04, 0.14, 4).rotateZ(-2.2).translate(0.56, 1.82, 0), 0x2a2a2a),
      part(C(0.025, 0.025, 0.9, 0.05, 0.45, 0, 4), 0xe87a8a), part(C(0.025, 0.025, 0.5, 0.1, 0.8, 0.06, 4).rotateX(0.5), 0xe87a8a),
    ]);
    this.flamingos = [];
    const fl = new THREE.InstancedMesh(bird, this.mat, 18);
    for (let i = 0; i < 18; i++) {
      const p = isle.at(V, -60 + Math.random() * 50, -14 - Math.random() * 18);
      this.flamingos.push({ p: p.setY(Math.max(p.y, WL - 0.45)), rot: Math.random() * 6.28, ph: Math.random() * 20 });
      fl.setColorAt(i, new THREE.Color([0xff8aa8, 0xff9ab0, 0xf47a98][i % 3]));
    }
    fl.castShadow = true;
    this.flamingoMesh = fl;
    this.isle.near.add(fl);
    // Попугаи: стайки кружат над лесом за пляжем, машут крыльями
    const body = M([part(new THREE.SphereGeometry(0.14, 6, 4).scale(1.8, 0.9, 0.9), 0xffffff, 1), part(B(0.35, 0.02, 0.1, -0.35, 0, 0), 0xffffff, 1)]);
    const wing = part(B(0.18, 0.02, 0.5, 0, 0, 0.25), 0xffffff, 1);
    this.parrots = [];
    const nP = 24;
    this.parrotBody = new THREE.InstancedMesh(body, this.mat, nP);
    this.parrotWing = new THREE.InstancedMesh(wing, this.mat, nP * 2);
    const pcols = [0xe8302a, 0x2a6ae8, 0x2ab84a, 0xf2c020];
    for (let i = 0; i < nP; i++) {
      const fk = Math.floor(i / 6);
      const c = isle.at(P, -120 + fk * 90, 200 + (fk % 2) * 80);
      this.parrots.push({ c, r: 40 + fk * 8 + Math.random() * 10, h: c.y + 32 + Math.random() * 10, ph: i % 6 * 0.18 + fk, sp: 0.18 + fk * 0.02, flap: Math.random() * 6 });
      const col = new THREE.Color(pcols[fk % 4]);
      this.parrotBody.setColorAt(i, col); this.parrotWing.setColorAt(i * 2, col); this.parrotWing.setColorAt(i * 2 + 1, col);
    }
    this.parrotBody.frustumCulled = this.parrotWing.frustumCulled = false;
    this.isle.near.add(this.parrotBody, this.parrotWing);
  }

  // Огни факелов и очагов: те же языки пламени и пятна света, что на пляже тусовки
  buildFlames() {
    const isle = this.isle;
    this.flameMesh = new THREE.InstancedMesh(new THREE.ConeGeometry(0.5, 1.6, 8, 1).translate(0, 0.8, 0), isle.flameMesh.material, this.flames.length);
    this.flameMesh.frustumCulled = false;
    isle.near.add(this.flameMesh);
    const pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), isle.poolMat, this.flames.length);
    this.flames.forEach((f, i) => {
      const gy = f.torch ? f.p.y - 2.4 : f.p.y - 0.1;
      pools.setMatrixAt(i, new THREE.Matrix4().compose(_v.set(f.p.x, gy + 0.08, f.p.z), _q.identity(), _s.set(f.s * 9, 1, f.s * 9)));
    });
    isle.near.add(pools);
  }

  // ---------------------------------------------------------------- кадр
  // Дальнее (кратер, маяк) — всегда; ближнее — только когда остров рядом
  update(dt, camPos, env, near) {
    const t = this.t += dt;
    const night = env.night, glowK = Math.max(env.golden * 0.6, night);
    const fogD = env.scene?.fog?.density ?? 0;
    for (const p of this.puffs) {
      const u = p.material.uniforms;
      u.uTime.value = t;
      if (env.scene?.fog) { u.uFogCol.value.copy(env.scene.fog.color); u.uFogD.value = fogD; }
    }
    // Лава ярче в темноте; дым снизу подсвечен
    this.lavaMat.uniforms.uTime.value = t;
    this.lavaMat.uniforms.uK.value = 0.7 + 0.5 * glowK;
    this.smoke.material.uniforms.uCol.value.setRGB(0.55 + 0.4 * glowK, 0.42 + 0.05 * glowK, 0.36 - 0.1 * glowK);
    // Маяк: лучи вращаются, видны в сумерках и ночью
    const lk = THREE.MathUtils.smoothstep(glowK, 0.25, 0.75);
    this.beams.rotation.y = t * 0.6;
    this.beams.visible = lk > 0.01;
    this.beamMat.uniforms.uK.value = lk;
    this.lampMat.color.setRGB(1, 0.94, 0.75).multiplyScalar(0.6 + 2.4 * lk);
    if (!near) return;
    this.winMat.color.setRGB(1, 0.72, 0.4).multiplyScalar(0.15 + 1.6 * glowK);
    // Водопад: струи бегут вниз, пена дышит
    this.fallTex[0].offset.y = t * 1.6;
    this.fallTex[1].offset.y = t * 1.15;
    this.foam.material.opacity = 0.45 + 0.15 * Math.sin(t * 3.1);
    this.foam.scale.setScalar(1 + 0.06 * Math.sin(t * 2.3));
    const d = Math.hypot(camPos.x - this.isle.party.x, camPos.z - this.isle.party.z);
    // Огни
    const fm = this.flameMesh;
    this.flames.forEach((f, i) => {
      const fl = 0.8 + 0.25 * Math.sin(t * 13 + i * 2.1) + 0.15 * Math.sin(t * 23 + i);
      fm.setMatrixAt(i, _m.compose(f.p, _q.setFromAxisAngle(UP, t * 2 + i), _s.set(f.s * (0.9 + 0.1 * fl), f.s * fl, f.s * (0.9 + 0.1 * fl))));
    });
    fm.instanceMatrix.needsUpdate = true;
    // Лодки качаются
    this.boats.forEach((b, i) => {
      _q.setFromAxisAngle(UP, b.rot).multiply(_q2.setFromEuler(_e.set(Math.sin(t * 1.1 + b.ph) * 0.06, 0, Math.sin(t * 0.8 + b.ph) * 0.04)));
      this.boatMesh.setMatrixAt(i, _m.compose(_v.set(b.p.x, b.p.y + Math.sin(t * 1.3 + b.ph) * 0.12, b.p.z), _q, _s.setScalar(1)));
    });
    this.boatMesh.instanceMatrix.needsUpdate = true;
    // Живность — только вблизи (до ~1,5 км от пляжа тусовки и деревни)
    const dv = Math.hypot(camPos.x - this.village.x, camPos.z - this.village.z);
    if (d < 1500) this.updateNearParty(t);
    if (dv < 1200) this.updateFlamingos(t);
  }

  updateNearParty(t) {
    const isle = this.isle, P = isle.party;
    this.turtles.forEach((tr, i) => {
      const s = Math.sin(t * tr.sp + tr.ph);
      const a = tr.a0 + s * 18;
      const dir = Math.cos(t * tr.sp + tr.ph) >= 0 ? 1 : -1;
      const p = isle.at(P, a, tr.b);
      const yaw = Math.atan2(P.t.x * dir, P.t.y * dir) - Math.PI / 2;
      const wob = Math.sin(t * 3 + i) * 0.05;
      this.turtleMesh.setMatrixAt(i, _m.compose(_v.set(p.x, Math.max(p.y, WL - 0.3) + 0.02, p.z), _q.setFromEuler(_e.set(0, yaw + wob, wob * 0.5)), _s.setScalar(1)));
    });
    this.turtleMesh.instanceMatrix.needsUpdate = true;
    // Рыбы
    const fm = this.fishMesh, per = this.fishPer;
    this.schools.forEach((S, s) => {
      const base = t * S.sp + S.ph;
      for (let i = 0; i < per; i++) {
        const o = this.fishOff[s * per + i];
        const a = base + o[0] * 0.25;
        const r = S.r + o[1];
        const x = S.c.x + Math.cos(a) * r, z = S.c.z + Math.sin(a) * r;
        const y = S.depth + o[2] * 0.4 + Math.sin(t * 2 + o[0]) * 0.15;
        const yaw = -a + (S.sp > 0 ? -Math.PI / 2 : Math.PI / 2);
        fm.setMatrixAt(s * per + i, _m.compose(_v.set(x, y, z), _q.setFromAxisAngle(UP, yaw + Math.sin(t * 9 + i) * 0.15), _s.setScalar(1)));
      }
    });
    fm.instanceMatrix.needsUpdate = true;
    // Попугаи
    const B = this.parrotBody, W = this.parrotWing;
    this.parrots.forEach((p, i) => {
      const a = t * p.sp + p.ph;
      const x = p.c.x + Math.cos(a) * p.r, z = p.c.z + Math.sin(a) * p.r, y = p.h + Math.sin(a * 2) * 4;
      const yaw = -a - Math.PI / 2;
      _q.setFromEuler(_e.set(0, yaw, 0.25));
      _m.compose(_v.set(x, y, z), _q, _s.setScalar(1.4));
      B.setMatrixAt(i, _m);
      const f = Math.sin(t * 14 + p.flap) * 0.9;
      for (const sgn of [-1, 1]) {
        const wm = new THREE.Matrix4().compose(_v.set(0, 0, 0), _q2.setFromAxisAngle(AX, f * sgn), _s.set(1, 1, sgn));
        W.setMatrixAt(i * 2 + (sgn > 0 ? 0 : 1), wm.premultiply(_m));
      }
    });
    B.instanceMatrix.needsUpdate = true; W.instanceMatrix.needsUpdate = true;
  }

  updateFlamingos(t) {
    this.flamingos.forEach((f, i) => {
      // Раз в ~20 с птица наклоняется к воде
      const dip = Math.max(0, Math.sin(t * 0.3 + f.ph)) ** 8;
      _q.setFromEuler(_e.set(0, f.rot + Math.sin(t * 0.2 + f.ph) * 0.3, -dip * 0.9));
      this.flamingoMesh.setMatrixAt(i, _m.compose(f.p, _q, _s.setScalar(1)));
    });
    this.flamingoMesh.instanceMatrix.needsUpdate = true;
  }
}
