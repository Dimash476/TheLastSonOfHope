import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { WORLD } from '../config.js';
import { mulberry32 } from '../utils.js';
import { ISLE, ISLE_BAYS, ISLE_ROCKS, isleToWorld, islandSample, islandHeight } from './layout.js';
import { makeBeachGeometries, createTintMaterial } from './beach.js';
import { makePersonGeometry, createPeopleMaterial } from './people.js';
import { createGlowPoolMaterial } from './props.js';

// Райский остров: вулкан с зелёными гребнями, золотой пляж на закат, бирюзовая лагуна
// (её рисует вода — см. environment.js), пальмы и джунгли, пляжная тусовка
// (тики-бар, сцена с диджеем, костёр, факелы, гирлянды, танцы, купальщики)
// и тихая бухта среди чёрных лавовых скал — гамак, качели, плед с фонарём, никого.

const WL = WORLD.waterLevel;
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const AX = new THREE.Vector3(1, 0, 0), AZ = new THREE.Vector3(0, 0, 1);
const HIP_Y = 0.92, SHOULDER_Y = 1.42, NECK_Y = 1.47;
const SWIM = [0xe63946, 0x2a9d8f, 0xf4a261, 0x1d3557, 0xffd166, 0x8338ec, 0xff6b9a, 0x06d6a0, 0xffffff];
const SKIN = [0xf1c7a5, 0xe0ac85, 0xc68a62, 0x9a6640, 0x6b4429, 0xd29b74];
const HAIR = [0x1b1410, 0x3b2618, 0x6b4a2a, 0xa07a48, 0x2a2a2a, 0xd8b878];

// Части с атрибутами материала пляжа: цвет вершин, tint (цвет экземпляра), sway (ветер)
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
// Дешёвый гладкий шум 0..1 для прогалин в лесу
function fbmLike(x, z) {
  const s = Math.sin(x * 1.7 + Math.sin(z * 1.3) * 1.1) * Math.sin(z * 1.9 + Math.sin(x * 0.7) * 1.4);
  return 0.5 + 0.5 * (s * 0.6 + 0.4 * Math.sin(x * 4.1 + z * 3.3));
}
const C = (r0, r1, h, x, y, z, s = 8) => new THREE.CylinderGeometry(r1, r0, h, s).translate(x, y, z);

export class Island {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.uTime = { value: 0 };
    this.t = 0;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.near = new THREE.Group();      // всё, что видно только вблизи (2.5–4 км)
    this.group.add(this.near);
    const rnd = mulberry32(4242);

    // Опорные точки: пляж тусовки и тихая бухта (берег, нормаль в мир, касательная)
    const frame = (bay, inland) => {
      const [cx, cz] = isleToWorld(bay.cu, bay.cv);
      const nw = new THREE.Vector2(...isleToWorld(bay.cu + bay.nu, bay.cv + bay.nv)).sub(new THREE.Vector2(cx, cz)).normalize();
      // берег — на окружности бухты со стороны суши; центр — на inland м глубже
      const sx = cx - nw.x * bay.r, sz = cz - nw.y * bay.r;
      return { x: sx - nw.x * inland, z: sz - nw.y * inland, n: nw, t: new THREE.Vector2(-nw.y, nw.x) };
    };
    this.party = frame(ISLE_BAYS[0], 50);
    this.cove = frame(ISLE_BAYS[1], 28);

    this.buildTerrain();
    this.buildVegetation(rnd);
    this.buildParty(rnd);
    this.buildCove(rnd);
    this.buildCozy(rnd);
    this.lastZone = null;
  }

  // Точка в системе пляжа: a — вдоль берега, b — вглубь суши (м)
  at(F, a, b, out = new THREE.Vector3()) {
    const x = F.x + F.t.x * a - F.n.x * b, z = F.z + F.t.y * a - F.n.y * b;
    return out.set(x, islandHeight(x, z) ?? WL, z);
  }
  // Поворот «лицом к морю»
  faceSea(F) { return Math.atan2(F.n.x, F.n.y); }

  // ---------------------------------------------------------------- рельеф
  buildTerrain() {
    const N = 256, S = ISLE.size;
    const geo = new THREE.PlaneGeometry(S, S, N, N).rotateX(-Math.PI / 2);
    const P = geo.attributes.position, n = P.count;
    const col = new Float32Array(n * 3), sand = new Float32Array(n);
    const samples = new Array(n);
    for (let i = 0; i < n; i++) {
      const [x, z] = isleToWorld(P.getX(i), P.getZ(i));
      const s = islandSample(x, z);
      samples[i] = s;
      P.setXYZ(i, x, s.h, z);
    }
    geo.computeVertexNormals();
    const Nn = geo.attributes.normal;
    const cSandWet = new THREE.Color(0xc29a5e), cSand = new THREE.Color(0xdfb874), cSandDry = new THREE.Color(0xe9c88a);
    const cUnder = new THREE.Color(0xe8dcb4), cGrass = new THREE.Color(0x5f9a38), cLush = new THREE.Color(0x2f7a28);
    const cJungle = new THREE.Color(0x1c5a1e), cRed = new THREE.Color(0x7a4a2a), cRock = new THREE.Color(0x3f5a34);
    const cLava = new THREE.Color(0x1b1918), cPeak = new THREE.Color(0x58704a), cFloor = new THREE.Color(0x1f2e14);
    const c = new THREE.Color(), ss = THREE.MathUtils.smoothstep;
    for (let i = 0; i < n; i++) {
      const s = samples[i], slope = 1 - Nn.getY(i);
      if (s.sd < 0) c.copy(cUnder).lerp(cSandWet, ss(s.sd, -40, 0));
      else {
        c.copy(cSand).lerp(cSandDry, ss(s.sd, 25, 95));
        // Переход песок → трава → тропический лес → гребни
        const g = ss(s.sd, 100, 150);
        const veg = c.clone().copy(cGrass).lerp(cLush, ss(s.h, 5, 40)).lerp(cJungle, ss(s.h, 40, 220) * (0.6 + 0.4 * Math.random()));
        veg.lerp(cRed, ss(slope, 0.3, 0.55) * 0.3).lerp(cRock, ss(slope, 0.45, 0.7) * 0.7).lerp(cPeak, ss(s.h, 750, 980));
        // Под пологом леса — тёмная лесная подстилка
        veg.lerp(cFloor, ss(s.sd, 160, 210) * (1 - ss(s.h, 640, 760)) * 0.75);
        c.lerp(veg, g);
      }
      c.lerp(cLava, s.rock);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      sand[i] = (s.sd < 130 ? 1 : 0) * (1 - s.rock);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('sand', new THREE.BufferAttribute(sand, 1));
    geo.computeBoundingSphere();

    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float sand;\nvarying float vSand;\nvarying vec3 vIP;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSand = sand;\nvIP = position;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform float uTime;
          varying float vSand;
          varying vec3 vIP;
          float wetK = 0.0, foamK = 0.0;
          float ih(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          {
            // Волна накатывает на песок и отступает: граница «языка» воды бежит вверх-вниз,
            // за ней — мокрый тёмный песок, по кромке — пена
            float wl = ${WL.toFixed(2)};
            float along = dot(vIP.xz, vec2(0.0045, 0.0062));
            float cyc = 0.5 + 0.5 * sin(uTime * 0.55 + along * 6.0 + sin(along * 13.0) * 0.8);
            float edge = wl + 0.12 + cyc * 0.85;
            float y = vIP.y;
            float under = 1.0 - smoothstep(edge - 0.05, edge, y);
            wetK = vSand * (1.0 - smoothstep(edge, edge + 0.9, y));
            foamK = vSand * exp(-pow((y - edge) / 0.05, 2.0)) * (0.6 + 0.4 * ih(floor(vIP.xz * 3.0)));
            diffuseColor.rgb *= 1.0 - wetK * 0.32;
            // Тонкая плёнка воды на песке — бирюзовый отлив
            diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.55, 0.85, 0.85), under * vSand * 0.6);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.97, 0.97, 0.95), foamK);
            // Мелкое «зерно» песка
            diffuseColor.rgb *= 0.94 + 0.08 * ih(floor(vIP.xz * 4.0)) * vSand;
          }`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, 0.25, wetK * 0.8);`);
    };
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.terrain = mesh;
  }

  // ---------------------------------------------------------------- пальмы и джунгли
  buildVegetation(rnd) {
    const G = makeBeachGeometries();
    const mat = createTintMaterial(this.uTime);
    this.tintMat = mat;
    const half = ISLE.size / 2;
    const chunks = new Map();
    const put = (type, x, z, rot, s) => {
      const y = islandHeight(x, z);
      if (y === null) return;
      const cs = type === 'fern' || type === 'banana' ? 350 : 600;
      const key = `${type}:${Math.floor(x / cs)},${Math.floor(z / cs)}`;
      if (!chunks.has(key)) chunks.set(key, { type, list: [] });
      chunks.get(key).list.push(new THREE.Matrix4().compose(_v.set(x, y - 0.3, z), _q.setFromAxisAngle(UP, rot), _s.setScalar(s)));
    };
    const inParty = (x, z) => { const dx = x - this.party.x, dz = z - this.party.z; return Math.hypot(dx, dz) < 70; };
    const nearCove = (x, z) => Math.hypot(x - this.cove.x, z - this.cove.z) < 130;
    // Наружная нормаль (к морю) — по градиенту расстояния до берега
    const outward = (x, z) => {
      const a = islandSample(x + 4, z), b = islandSample(x - 4, z), c = islandSample(x, z + 4), d = islandSample(x, z - 4);
      const gx = (a.sd - b.sd), gz = (c.sd - d.sd), l = Math.hypot(gx, gz) || 1;
      return [-gx / l, -gz / l];
    };
    // Пальмы: вдоль кромки пляжа (наклонены к морю) и рощами чуть глубже
    let crest = 0, grove = 0;
    for (let k = 0; k < 60000 && (crest < 760 || grove < 420); k++) {
      const u = (rnd() - 0.5) * 2 * half, v = (rnd() - 0.5) * 2 * half;
      const [x, z] = isleToWorld(u, v);
      const s = islandSample(x, z);
      if (!s || s.rock > 0.05 || inParty(x, z) || nearCove(x, z)) continue;
      if (s.sd > 85 && s.sd < 150 && crest < 760) {
        const [nx, nz] = outward(x, z);
        const tall = rnd() < 0.35;
        put(tall ? 'tallpalm' : 'palm', x, z, Math.atan2(-nz, nx) + (rnd() - 0.5) * 0.6, tall ? 0.75 + rnd() * 0.35 : 1.0 + rnd() * 0.5);
        crest++;
      } else if (s.sd > 150 && s.sd < 230 && grove < 420 && rnd() < 0.6) {
        put(rnd() < 0.4 ? 'tallpalm' : 'palm', x, z, rnd() * 6.28, 0.9 + rnd() * 0.5);
        grove++;
      }
    }
    // Тропический лес: сразу за пальмами — сплошная чаща. Густота зависит от высоты
    // (низины и ущелья гуще), шум оставляет естественные прогалины. Над пологом —
    // деревья-великаны 40–65 м, у земли — папоротники и банановые листья.
    const step = 10;
    for (let u = -half; u < half; u += step) for (let v = -half; v < half; v += step) {
      const ju = u + (rnd() - 0.5) * step, jv = v + (rnd() - 0.5) * step;
      const [x, z] = isleToWorld(ju, jv);
      const s = islandSample(x, z);
      if (!s || s.rock > 0.05 || s.sd < 165 || s.h > 760 || inParty(x, z) || nearCove(x, z)) continue;
      const low = 1 - THREE.MathUtils.smoothstep(s.h, 220, 640);
      const clump = THREE.MathUtils.smoothstep(0.32, 0.55, fbmLike(x * 0.004, z * 0.004));
      // Полоса леса за пляжем — самая густая чаща (из неё выходишь к морю)
      const edge = 1 - THREE.MathUtils.smoothstep(s.sd, 380, 560);
      const dens = (0.25 + 0.75 * low) * (0.35 + 0.65 * clump * (1 - edge) + 0.65 * edge) * THREE.MathUtils.smoothstep(s.sd, 165, 195);
      const r = rnd();
      if (r < dens * (0.45 + 0.3 * edge)) put('canopy', x, z, rnd() * 6.28, (0.8 + rnd() * 0.75) * (0.85 + 0.3 * low));
      else if (r < dens * (0.45 + 0.3 * edge) + 0.012 * low && s.sd > 200 && s.h < 320) put('giant', x, z, rnd() * 6.28, 0.8 + rnd() * 0.45);
      if (low > 0.3 && rnd() < dens * (0.4 + 0.45 * edge)) {
        const ox = (rnd() - 0.5) * 8, oz = (rnd() - 0.5) * 8;
        put(rnd() < 0.55 ? 'fern' : 'banana', x + ox, z + oz, rnd() * 6.28, 0.8 + rnd() * 0.7);
      }
    }
    // ---- геометрии леса
    const frond = (len, wid, droop, n, py, col, sw) => {
      const out = [];
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + k * 0.37, pos = [], seg = 5;
        for (let s2 = 0; s2 < seg; s2++) {
          const t0 = s2 / seg, t1 = (s2 + 1) / seg;
          const y0 = Math.sin(t0 * 2.2) * 0.35 * len - t0 * t0 * droop * len, y1 = Math.sin(t1 * 2.2) * 0.35 * len - t1 * t1 * droop * len;
          const w0 = wid * len * Math.sin(Math.PI * Math.min(1, t0 + 0.12)), w1 = wid * len * Math.sin(Math.PI * Math.min(1, t1 + 0.12));
          const ca = Math.cos(a), sa = Math.sin(a), nx = -sa, nz = ca;
          const Pp = (r, y, w) => [ca * r + nx * w, py + y, sa * r + nz * w];
          pos.push(...Pp(t0 * len, y0, -w0), ...Pp(t1 * len, y1, -w1), ...Pp(t1 * len, y1, w1), ...Pp(t0 * len, y0, -w0), ...Pp(t1 * len, y1, w1), ...Pp(t0 * len, y0, w0));
        }
        const fg = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        fg.computeVertexNormals();
        out.push(part(fg, col, 1, sw));
      }
      return out;
    };
    const leafSway = (y) => Math.max(0, y) * 0.12;
    const crownSway = (base) => (y) => Math.max(0, y - base) * 0.08;
    const ico = (r) => new THREE.IcosahedronGeometry(r, 0);
    // Дерево полога: прямой ствол ~16 м и пышная крона из нескольких масс
    const canopy = mergeGeometries([
      part(C(0.55, 0.32, 16, 0, 8, 0, 6), 0x6a5a48),
      part(ico(5.2).scale(1.25, 0.7, 1.25).translate(0, 17.5, 0), 0xffffff, 1, crownSway(13)),
      part(ico(4.2).scale(1.2, 0.7, 1.2).translate(3.6, 15.6, 1.4), 0xffffff, 1, crownSway(13)),
      part(ico(4.0).scale(1.2, 0.7, 1.2).translate(-3.2, 16.0, -2.0), 0xffffff, 1, crownSway(13)),
      part(ico(3.4).scale(1.2, 0.7, 1.2).translate(0.6, 14.8, -3.6), 0xffffff, 1, crownSway(13)),
    ]);
    // Великан: ствол с корнями-контрфорсами, мощные ветви, крона-зонт 30+ м и лианы
    const bark = 0x9a9080;
    const giantParts = [
      part(C(3.8, 1.7, 7, 0, 3.5, 0, 9), bark),
      ...[0, 1, 2, 3, 4].map((k) => part(B(0.5, 6, 3.4, 0, 3, 2.2).rotateY(k * 1.2566), bark)),
      part(C(1.7, 1.15, 40, 0, 27, 0, 8), bark),
      ...[0, 1, 2, 3, 4, 5].map((k) => part(C(0.75, 0.35, 14, 0, 7, 0, 6).rotateZ(1.0).rotateY(k * 1.047 + 0.3).translate(0, 44, 0), bark)),
      part(ico(10).scale(1.7, 0.42, 1.7).translate(0, 53, 0), 0xffffff, 1, crownSway(45)),
      ...[0, 1, 2, 3, 4, 5, 6].map((k) => part(ico(7).scale(1.35, 0.5, 1.35).translate(Math.cos(k * 0.9) * 13, 49 + (k % 3), Math.sin(k * 0.9) * 13), 0xffffff, 1, crownSway(45))),
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((k) => part(B(0.14, 26 + (k % 3) * 6, 0.14, Math.cos(k * 0.8) * (9 + k % 4 * 2), 36 - (k % 3) * 3, Math.sin(k * 0.8) * (9 + k % 4 * 2)), 0x3f5a2c)),
    ];
    const giant = mergeGeometries(giantParts);
    // Подлесок: папоротник и банановые листья
    const fern = mergeGeometries(frond(2.4, 0.16, 0.7, 8, 0.15, 0xffffff, leafSway));
    const banana = mergeGeometries([part(C(0.16, 0.12, 2.4, 0, 1.2, 0, 6), 0x6a8a3a), ...frond(2.6, 0.32, 0.55, 6, 2.3, 0xffffff, leafSway)]);
    const geos = { palm: G.palm, tallpalm: G.tallpalm, canopy, giant, fern, banana };
    const greens = [0x2f7a2a, 0x3a8a30, 0x256b24, 0x4a9a3a, 0x1f5f22, 0x3f8f2a, 0x2a6a30];
    const leafy = [0x3a8a2a, 0x4a9a34, 0x2f7a28, 0x5aa83a];
    const far = { palm: 4000, tallpalm: 4500, canopy: 3800, giant: 7000, fern: 650, banana: 750 };
    this.vegChunks = [];
    for (const { type, list } of chunks.values()) {
      // Перемешиваем: вдали рисуем лишь первую часть списка — случайное прореживание
      for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
      const m = new THREE.InstancedMesh(geos[type], mat, list.length);
      list.forEach((mx, i) => {
        m.setMatrixAt(i, mx);
        if (type === 'canopy' || type === 'giant') m.setColorAt(i, new THREE.Color(greens[Math.floor(rnd() * greens.length)]));
        else if (type === 'fern' || type === 'banana') m.setColorAt(i, new THREE.Color(leafy[Math.floor(rnd() * leafy.length)]));
      });
      if (!m.instanceColor) { m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 3).fill(1), 3); }
      m.castShadow = type === 'palm' || type === 'tallpalm' || type === 'giant';
      m.receiveShadow = true;
      m.computeBoundingSphere();
      this.near.add(m);
      this.vegChunks.push({ m, x: m.boundingSphere.center.x, z: m.boundingSphere.center.z, far: far[type], full: list.length, thin: type === 'canopy' });
    }
  }

  // ---------------------------------------------------------------- тусовка на пляже
  buildParty(rnd) {
    const F = this.party, mat = this.tintMat, face = this.faceSea(F);
    const G = makeBeachGeometries();
    const add = (geo, list, colors) => {
      const m = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((mx, i) => { m.setMatrixAt(i, mx); m.setColorAt(i, new THREE.Color(colors ? colors[i % colors.length] : 0xffffff)); });
      m.castShadow = true; m.receiveShadow = true;
      m.computeBoundingSphere();
      this.near.add(m);
      return m;
    };
    const place = (a, b, rot = face, s = 1, dy = 0) => { const p = this.at(F, a, b); return new THREE.Matrix4().compose(_v.set(p.x, p.y + dy, p.z), _q.setFromAxisAngle(UP, rot), _s.setScalar(s)); };

    // Тики-бар: бамбуковые столбы, стойка, соломенная крыша, табуреты, вывеска-факелы
    const straw = 0xc9a45c, bamboo = 0x9a7a48, wood = 0x6b4a2c;
    const bar = mergeGeometries([
      ...[[-3.2, -2.2], [3.2, -2.2], [-3.2, 2.2], [3.2, 2.2]].map(([x, z]) => part(C(0.14, 0.14, 3.4, x, 1.7, z, 6), bamboo)),
      part(B(6.4, 1.1, 0.7, 0, 0.55, 2.0), wood), part(B(6.8, 0.1, 1.0, 0, 1.15, 2.05), 0x8a6238),
      part(B(6.0, 1.0, 0.5, 0, 0.5, -1.8), wood), part(B(5.6, 0.06, 0.5, 0, 1.8, -1.9), 0x8a6238),
      part(new THREE.ConeGeometry(5.4, 2.6, 4).rotateY(Math.PI / 4).translate(0, 4.6, 0), straw),
      part(new THREE.ConeGeometry(5.6, 0.5, 4, 1, true).rotateY(Math.PI / 4).translate(0, 3.4, 0), 0xb08a48),
      ...[-2.4, -0.8, 0.8, 2.4].map((x) => part(C(0.22, 0.22, 0.75, x, 0.38, 3.1, 8), 0x5a3a22)),
      ...[-2.2, -1.1, 0, 1.1, 2.2].map((x) => part(C(0.12, 0.08, 0.35, x, 2.0, -1.9, 6), [0xff6b9a, 0xffd166, 0x06d6a0, 0xf4a261, 0x8ad0ff][Math.round(x + 2.2) % 5])),
    ]);
    add(bar, [place(36, 46, face)]);

    // Сцена диджея: настил, стол с пультом, арка-ферма, колонки
    const stage = mergeGeometries([
      part(B(12, 0.8, 7, 0, 0.4, 0), 0x6b4a2c), part(B(3.2, 1.0, 1.0, 0, 1.3, -0.5), 0x1a1a1e),
      part(B(0.3, 6, 0.3, -5.6, 3.8, -3.2), 0x2a2a2e), part(B(0.3, 6, 0.3, 5.6, 3.8, -3.2), 0x2a2a2e), part(B(11.6, 0.4, 0.4, 0, 6.8, -3.2), 0x2a2a2e),
      part(B(1.2, 2.2, 1.0, -4.6, 1.9, -1.6), 0x111114), part(B(1.2, 2.2, 1.0, 4.6, 1.9, -1.6), 0x111114),
      part(B(1.4, 0.6, 1.0, -4.6, 3.3, -1.6), 0x111114), part(B(1.4, 0.6, 1.0, 4.6, 3.3, -1.6), 0x111114),
    ]);
    add(stage, [place(0, 40, face)]);
    // Огни сцены: цветные прожекторы на ферме и светящиеся полосы (мигают в такт)
    this.stageLightMat = new THREE.MeshBasicMaterial({ color: 0xff3a8a, toneMapped: false });
    const lights = [];
    for (let i = 0; i < 8; i++) {
      const p = this.at(F, -4.9 + i * 1.4, 40 + 3.2);
      lights.push(new THREE.Matrix4().compose(_v.set(p.x, p.y + 6.4, p.z), _q.setFromAxisAngle(UP, face), _s.set(0.5, 0.5, 0.5)));
    }
    this.stageLights = new THREE.InstancedMesh(new THREE.SphereGeometry(0.5, 10, 8), this.stageLightMat, lights.length);
    lights.forEach((mx, i) => this.stageLights.setMatrixAt(i, mx));
    this.near.add(this.stageLights);

    // Зонты, шезлонги, полотенца, парочки, загорающие
    const umb = [], lng = [], tw = [], cp = [], sb = [];
    for (let a = -95; a <= 95; a += 13) {
      if (Math.abs(a) < 26) continue;
      const b = -14 + (rnd() - 0.5) * 6;
      umb.push(place(a, b, rnd() * 6.28));
      lng.push(place(a - 1.6, b + 0.4, face + Math.PI, 1));
      lng.push(place(a + 1.6, b + 0.4, face + Math.PI, 1));
      if (rnd() < 0.5) tw.push(place(a + 4, b - 5, face + (rnd() - 0.5) * 0.4));
      if (rnd() < 0.35) cp.push(place(a + 5, b + 3, face + Math.PI + (rnd() - 0.5) * 0.3));
      if (rnd() < 0.5) sb.push(place(a + 4, b - 5, face + Math.PI / 2 + (rnd() - 0.5) * 0.3, 1, 0.03));
    }
    add(G.umbrella, umb, [0xd94a3a, 0x2f7fc1, 0xf2b632, 0x2aa198, 0xe76f9a, 0x6a4c93]);
    add(G.lounger, lng);
    add(G.towel, tw, [0xe63946, 0x457b9d, 0xf4a261, 0x2a9d8f, 0xffd166, 0x8338ec]);
    if (cp.length) add(G.couple, cp);
    if (sb.length) { add(G.sunbather, sb, SWIM); add(G.sunbatherSkin, sb, SKIN); }
    add(G.volley, [place(72, 8, face + Math.PI / 2)]);

    // Доски для сёрфинга воткнуты в песок, каноэ с балансиром
    const board = part(new THREE.CapsuleGeometry(0.28, 2.0, 4, 10).scale(1, 1, 0.18).translate(0, 1.2, 0), 0xffffff, 1);
    const boards = [];
    for (let i = 0; i < 7; i++) boards.push(place(-58 + i * 1.3, 30 + (i % 2) * 0.6, face + (rnd() - 0.5) * 0.3));
    add(board, boards, [0xffd166, 0x06d6a0, 0xff6b9a, 0x8ad0ff, 0xf4a261, 0xffffff, 0xe63946]);
    const canoe = mergeGeometries([
      part(new THREE.CapsuleGeometry(0.45, 6, 4, 10).rotateZ(Math.PI / 2).scale(1, 0.6, 0.7).translate(0, 0.3, 0), 0x8a4a2a),
      part(B(0.08, 0.08, 2.4, -1.2, 0.5, 1.1), 0x6b4a2c), part(B(0.08, 0.08, 2.4, 1.2, 0.5, 1.1), 0x6b4a2c),
      part(new THREE.CapsuleGeometry(0.12, 3, 3, 6).rotateZ(Math.PI / 2).translate(0, 0.15, 2.3), 0x6b4a2c),
    ]);
    add(canoe, [place(55, -6, face + Math.PI / 2 + 0.3)]);

    // Костёр: брёвна и пламя
    const fire = this.at(F, -28, 8);
    this.fireLogs = add(mergeGeometries([
      ...[0, 1, 2, 3, 4].map((k) => part(C(0.12, 0.12, 1.6, 0, 0.12, 0, 6).rotateZ(Math.PI / 2).rotateY(k * 1.26).translate(0, 0.1, 0), 0x3a2618)),
      part(new THREE.TorusGeometry(1.3, 0.18, 6, 14).rotateX(Math.PI / 2), 0x6a6a64),
    ]), [new THREE.Matrix4().makeTranslation(fire.x, fire.y, fire.z)]);
    // Брёвна-скамейки вокруг костра
    const logSeat = part(C(0.25, 0.25, 3.2, 0, 0.25, 0, 8).rotateZ(Math.PI / 2), 0x6b4a2c);
    add(logSeat, [0, 1, 2, 3].map((k) => new THREE.Matrix4().compose(_v.set(fire.x + Math.cos(k * 1.57 + 0.4) * 4, fire.y, fire.z + Math.sin(k * 1.57 + 0.4) * 4), _q.setFromAxisAngle(UP, k * 1.57 + 0.4 + Math.PI / 2), _s.setScalar(1))));

    // Пламя: костёр и факелы (мерцают); огненные языки — светящиеся конусы
    const flameMat = new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    this.flames = [];
    const torchGeo = part(C(0.05, 0.07, 2.4, 0, 1.2, 0, 6), bamboo);
    const torches = [];
    const torchPos = [];
    for (let a = -100; a <= 100; a += 12) for (const b of [28, -24]) {
      if (Math.abs(a) < 16 && b > 0) continue;
      const p = this.at(F, a + (b < 0 ? 6 : 0), b);
      torches.push(new THREE.Matrix4().makeTranslation(p.x, p.y, p.z));
      torchPos.push(p.clone().setY(p.y + 2.5));
    }
    add(torchGeo, torches);
    const flamePts = [{ p: fire.clone().setY(fire.y + 0.2), s: 2.2 }, ...torchPos.map((p) => ({ p, s: 0.45 }))];
    this.flameMesh = new THREE.InstancedMesh(new THREE.ConeGeometry(0.5, 1.6, 8, 1).translate(0, 0.8, 0), flameMat, flamePts.length);
    this.flameMesh.frustumCulled = false;
    this.flamePts = flamePts;
    this.near.add(this.flameMesh);
    // Тёплые пятна света на песке от огня
    this.poolMat = createGlowPoolMaterial(0xffa050, 0.9);
    const pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), this.poolMat, flamePts.length);
    flamePts.forEach((f, i) => pools.setMatrixAt(i, new THREE.Matrix4().compose(_v.set(f.p.x, f.p.y - (f.s > 1 ? 0.15 : 2.4), f.p.z), _q.identity(), _s.set(f.s * 9, 1, f.s * 9))));
    this.near.add(pools);

    // Гирлянды-лампочки между столбами вокруг танцпола
    const bulbs = [];
    const poles = [];
    for (let k = 0; k < 10; k++) { const ang = k / 10 * Math.PI * 2; poles.push(this.at(F, Math.cos(ang) * 22, 18 + Math.sin(ang) * 14)); }
    add(part(C(0.07, 0.07, 5, 0, 2.5, 0, 6), bamboo), poles.map((p) => new THREE.Matrix4().makeTranslation(p.x, p.y, p.z)));
    for (let k = 0; k < poles.length; k++) {
      const a = poles[k], b = poles[(k + 1) % poles.length];
      for (let i = 1; i < 12; i++) {
        const t = i / 12;
        bulbs.push(new THREE.Matrix4().makeTranslation(a.x + (b.x - a.x) * t, a.y + 4.9 + (b.y - a.y) * t - Math.sin(Math.PI * t) * 0.9, a.z + (b.z - a.z) * t));
      }
    }
    this.bulbMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0, toneMapped: false });
    const bulbMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.11, 6, 4), this.bulbMat, bulbs.length);
    bulbs.forEach((m, i) => bulbMesh.setMatrixAt(i, m));
    this.near.add(bulbMesh);

    // Танцующие люди и купальщики
    this.buildDancers(rnd);
  }

  buildDancers(rnd) {
    const F = this.party, G = makePersonGeometry(), mat = createPeopleMaterial();
    const N = 46;
    const mk = (geo, n) => {
      const m = new THREE.InstancedMesh(geo, mat, n);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3);
      m.castShadow = true;
      m.frustumCulled = false;
      this.near.add(m);
      return m;
    };
    this.dm = { torso: mk(G.torso, N), head: mk(G.head, N), hairS: mk(G.hairShort, N), hairL: mk(G.hairLong, N), arms: mk(G.arm, N * 2), legs: mk(G.leg, N * 2) };
    this.dancers = [];
    const pick = (a) => new THREE.Color(a[Math.floor(rnd() * a.length)]);
    for (let i = 0; i < N; i++) {
      // 38 — на танцполе, 8 — у стойки бара
      const bar = i >= 38;
      const a = bar ? 36 + (i - 41.5) * 1.4 : (rnd() - 0.5) * 30, b = bar ? 49.2 : 18 + (rnd() - 0.5) * 18;
      const p = this.at(F, a, b);
      const d = { p, h: 0.9 + rnd() * 0.18, ph: rnd() * 6.28, style: rnd(), hair: rnd() < 0.45 ? 'L' : 'S', bar, rot: bar ? this.faceSea(F) + Math.PI : rnd() * 6.28 };
      const skin = pick(SKIN), top = pick(SWIM), bottom = pick(SWIM), hair = pick(HAIR);
      this.dm.torso.setColorAt(i, top);
      this.dm.arms.setColorAt(i * 2, skin); this.dm.arms.setColorAt(i * 2 + 1, skin);
      this.dm.legs.setColorAt(i * 2, rnd() < 0.5 ? skin : bottom); this.dm.legs.setColorAt(i * 2 + 1, rnd() < 0.5 ? skin : bottom);
      this.dm.head.setColorAt(i, skin);
      this.dm.hairS.setColorAt(i, hair); this.dm.hairL.setColorAt(i, hair);
      this.dancers.push(d);
    }
    // Купальщики в лагуне: головы и плечи над водой покачиваются
    const sw = [];
    for (let i = 0; i < 12; i++) sw.push({ p: this.at(F, (rnd() - 0.5) * 120, -55 - rnd() * 60), ph: rnd() * 6.28 });
    this.swimmers = sw;
    this.swimMesh = new THREE.InstancedMesh(mergeGeometries([
      part(new THREE.SphereGeometry(0.11, 8, 6).translate(0, 0.25, 0), 0xffffff, 1),
      part(new THREE.SphereGeometry(0.22, 8, 6).scale(1.3, 0.5, 0.8), 0xffffff, 1),
    ]), this.tintMat, sw.length);
    sw.forEach((s, i) => this.swimMesh.setColorAt(i, new THREE.Color(SKIN[i % SKIN.length])));
    this.swimMesh.frustumCulled = false;
    this.near.add(this.swimMesh);
  }

  // ---------------------------------------------------------------- тихая бухта
  buildCove(rnd) {
    const F = this.cove, mat = this.tintMat, face = this.faceSea(F);
    const G = makeBeachGeometries();
    const add = (geo, list, colors) => {
      const m = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((mx, i) => { m.setMatrixAt(i, mx); m.setColorAt(i, new THREE.Color(colors ? colors[i % colors.length] : 0xffffff)); });
      m.castShadow = true; m.receiveShadow = true;
      m.computeBoundingSphere();
      this.near.add(m);
      return m;
    };
    const place = (a, b, rot = face, s = 1, dy = 0) => { const p = this.at(F, a, b); return new THREE.Matrix4().compose(_v.set(p.x, p.y + dy, p.z), _q.setFromAxisAngle(UP, rot), _s.setScalar(s)); };
    // Пальмы бухты: одна большая, склонённая к морю, и пара поменьше
    const lean = Math.atan2(-F.n.y, F.n.x);
    add(G.tallpalm, [place(-6, 30, lean, 1.15)]);
    add(G.palm, [place(4, 34, lean + 0.4, 1.4), place(-26, 40, lean - 0.3, 1.2), place(22, 44, lean + 0.2, 1.1)]);
    // Гамак между двумя столбами-пальмами (ткань провисает)
    const hm = [];
    const seg = 16, wid = 1.1, len = 4.2;
    for (let i = 0; i < seg; i++) for (const [t0, t1] of [[i / seg, (i + 1) / seg]]) {
      const y0 = 1.3 - Math.sin(Math.PI * t0) * 0.55, y1 = 1.3 - Math.sin(Math.PI * t1) * 0.55;
      const x0 = (t0 - 0.5) * len, x1 = (t1 - 0.5) * len;
      const w0 = wid * Math.sin(Math.PI * (0.15 + 0.7 * t0)), w1 = wid * Math.sin(Math.PI * (0.15 + 0.7 * t1));
      hm.push(x0, y0, -w0 / 2, x1, y1, -w1 / 2, x1, y1, w1 / 2, x0, y0, -w0 / 2, x1, y1, w1 / 2, x0, y0, w0 / 2);
    }
    const hg = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(hm, 3));
    hg.computeVertexNormals();
    const hammock = mergeGeometries([
      part(hg, 0xf2e6cc),
      part(C(0.1, 0.12, 2.2, -2.5, 1.1, 0, 6), 0x7a5c3c), part(C(0.1, 0.12, 2.2, 2.5, 1.1, 0, 6), 0x7a5c3c),
      part(B(0.03, 0.03, 0.6, -2.25, 1.35, 0).rotateZ(-0.4), 0xd8c8a8), part(B(0.03, 0.03, 0.6, 2.25, 1.35, 0).rotateZ(0.4), 0xd8c8a8),
    ]);
    add(hammock, [place(-2, 22, face + Math.PI / 2)]);
    this.hammockGeo = hammock;
    // Качели: рама из бруса, верёвки и доска — лицом к закату
    const swing = mergeGeometries([
      part(B(0.18, 3.4, 0.18, -1.2, 1.7, 0).rotateX(0.18), 0x6b4a2c), part(B(0.18, 3.4, 0.18, 1.2, 1.7, 0).rotateX(0.18), 0x6b4a2c),
      part(B(2.8, 0.18, 0.18, 0, 3.3, 0.3), 0x6b4a2c),
      part(B(0.03, 2.5, 0.03, -0.5, 2.0, 0.3), 0xd8c8a8), part(B(0.03, 2.5, 0.03, 0.5, 2.0, 0.3), 0xd8c8a8),
      part(B(1.3, 0.07, 0.4, 0, 0.72, 0.3), 0x8a6238),
    ]);
    add(swing, [place(10, 14, face)]);
    // Плед, подушки, фонарь и коряга-скамейка
    const blanket = mergeGeometries([
      part(B(2.2, 0.03, 1.6, 0, 0.02, 0), 0xb83a4a), part(B(2.2, 0.031, 0.15, 0, 0.025, -0.5), 0xf2e6cc), part(B(2.2, 0.031, 0.15, 0, 0.025, 0.5), 0xf2e6cc),
      part(new THREE.SphereGeometry(0.3, 8, 6).scale(1.3, 0.45, 0.9).translate(-0.6, 0.15, -0.55), 0xf2e6cc),
      part(new THREE.SphereGeometry(0.3, 8, 6).scale(1.3, 0.45, 0.9).translate(0.6, 0.15, -0.55), 0xe8b0a0),
      part(C(0.32, 0.32, 3.0, 0, 0.32, 0, 8).rotateZ(Math.PI / 2).translate(0, 0, -1.5), 0x8a7a68),
    ]);
    add(blanket, [place(-12, 10, face)]);
    const lp = this.at(F, -10.6, 9.2);
    this.lanternPos = lp.clone().setY(lp.y + 0.35);
    add(part(C(0.12, 0.12, 0.35, 0, 0.18, 0, 8), 0x3a3a3a), [new THREE.Matrix4().makeTranslation(lp.x, lp.y, lp.z)]);
    this.lanternMat = new THREE.MeshBasicMaterial({ color: 0xffc070, toneMapped: false });
    this.lantern = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 6), this.lanternMat);
    this.lantern.position.copy(this.lanternPos);
    this.near.add(this.lantern);
    const lpool = new THREE.Mesh(new THREE.PlaneGeometry(6, 6).rotateX(-Math.PI / 2), this.poolMat);
    lpool.position.set(lp.x, lp.y + 0.05, lp.z);
    this.near.add(lpool);
    // Цветущие кусты гибискуса по краю бухты
    const bush = mergeGeometries([
      part(new THREE.IcosahedronGeometry(1.1, 0).scale(1.2, 0.8, 1.2).translate(0, 0.7, 0), 0x2f6a2a),
      ...[0, 1, 2, 3, 4, 5].map((k) => part(new THREE.SphereGeometry(0.16, 6, 4).translate(Math.cos(k) * 0.9, 0.9 + (k % 2) * 0.3, Math.sin(k) * 0.9), 0xffffff, 1)),
    ]);
    const bushes = [];
    for (let i = 0; i < 14; i++) bushes.push(place(-45 + i * 7 + (rnd() - 0.5) * 3, 46 + rnd() * 10, rnd() * 6.28, 0.9 + rnd() * 0.5));
    add(bush, bushes, [0xff5a7a, 0xff8a4a, 0xffd0e0, 0xe03a5a]);
    this.bushGeo = bush;
    // Чёрные лавовые валуны на мысах бухты (и в воде у их подножия)
    const rocks = [];
    for (const R of ISLE_ROCKS) {
      const [rx, rz] = isleToWorld(R.u, R.v);
      for (let i = 0; i < 26; i++) {
        const a = rnd() * 6.28, d = Math.sqrt(rnd()) * R.r * 1.05;
        const x = rx + Math.cos(a) * d, z = rz + Math.sin(a) * d;
        const y = islandHeight(x, z) ?? WL;
        const s = (2 + rnd() * 5) * (1 - d / (R.r * 1.3));
        rocks.push(new THREE.Matrix4().compose(_v.set(x, y - s * 0.3, z), _q.setFromEuler(new THREE.Euler(rnd() * 3, rnd() * 3, rnd() * 3)), _s.set(s * (0.8 + rnd() * 0.5), s * (0.6 + rnd() * 0.5), s * (0.8 + rnd() * 0.5))));
      }
    }
    add(part(new THREE.DodecahedronGeometry(1, 0), 0x1d1b1a), rocks);
  }

  // ---------------------------------------------------------------- уют на пляже
  // Кровати-беседки с развевающимися занавесками, кресла у маленьких костров, дощатая
  // дорожка из джунглей с бумажными фонариками, гамаки, лаунж с подушками у бара,
  // свечи сердцем в тихой бухте, ракушки и морские звёзды у воды, песочные замки,
  // коряги, кокосы, пляжная трава у кромки леса, цветущие кусты
  buildCozy(rnd) {
    const mat = this.tintMat, P = this.party, Cv = this.cove;
    const add = (geo, list, colors, shadow = true, far = 1400) => {
      if (!list.length) return null;
      const m = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((mx, i) => { m.setMatrixAt(i, mx); m.setColorAt(i, new THREE.Color(colors ? colors[i % colors.length] : 0xffffff)); });
      m.castShadow = shadow; m.receiveShadow = true;
      m.computeBoundingSphere();
      this.near.add(m);
      this.vegChunks.push({ m, x: m.boundingSphere.center.x, z: m.boundingSphere.center.z, far: far + m.boundingSphere.radius, full: list.length });
      return m;
    };
    const place = (F, a, b, rot, s = 1, dy = 0) => { const p = this.at(F, a, b); return new THREE.Matrix4().compose(_v.set(p.x, p.y + dy, p.z), _q.setFromAxisAngle(UP, rot), _s.setScalar(s)); };
    const faceP = this.faceSea(P), faceC = this.faceSea(Cv);
    const wood = 0x8a6238, cream = 0xf4ecdc;
    this.cozyFlames = [];      // огоньки свечей и костров (мерцают вместе)
    this.glowBulbs = [];       // бумажные фонарики

    // ---- Кровати-беседки: рама, матрас, подушки, лёгкие занавески (колышутся от бриза)
    const curtainSway = (y) => Math.max(0, 2.3 - y) * 0.35;
    const curtain = (x, z, rot) => part(new THREE.PlaneGeometry(0.45, 2.3, 1, 6).translate(0, 1.25, 0).rotateY(rot).translate(x, 0, z), cream, 0, curtainSway);
    const daybed = mergeGeometries([
      ...[[-1.2, -1.1], [1.2, -1.1], [-1.2, 1.1], [1.2, 1.1]].map(([x, z]) => part(B(0.12, 2.6, 0.12, x, 1.3, z), 0xe8dcc4)),
      part(B(2.6, 0.1, 0.1, 0, 2.6, -1.1), 0xe8dcc4), part(B(2.6, 0.1, 0.1, 0, 2.6, 1.1), 0xe8dcc4),
      part(B(0.1, 0.1, 2.3, -1.2, 2.6, 0), 0xe8dcc4), part(B(0.1, 0.1, 2.3, 1.2, 2.6, 0), 0xe8dcc4),
      part(new THREE.PlaneGeometry(2.6, 2.4).rotateX(-Math.PI / 2).translate(0, 2.66, 0), cream),
      part(B(2.3, 0.35, 2.0, 0, 0.45, 0), 0x9a7a58), part(B(2.2, 0.18, 1.9, 0, 0.72, 0), 0xffffff),
      ...[-0.7, 0, 0.7].map((x) => part(new THREE.SphereGeometry(0.3, 8, 6).scale(1.2, 0.55, 0.7).translate(x, 0.95, -0.75), 0xffffff, 1)),
      curtain(-1.25, -0.85, Math.PI / 2), curtain(-1.25, 0.85, Math.PI / 2), curtain(1.25, -0.85, Math.PI / 2), curtain(1.25, 0.85, Math.PI / 2),
      curtain(-0.95, -1.15, 0), curtain(0.95, -1.15, 0),
    ]);
    add(daybed, [place(P, -118, 8, faceP), place(P, -138, 14, faceP + 0.15), place(P, 120, 8, faceP), place(P, 138, 14, faceP - 0.15)],
      [0xe87a6a, 0x7ac0c8, 0xf2c060, 0xc88ac0]);

    // ---- Маленькие костры с креслами-шезлонгами вокруг
    const pit = mergeGeometries([
      part(new THREE.TorusGeometry(0.9, 0.16, 6, 12).rotateX(Math.PI / 2).translate(0, 0.1, 0), 0x6a6660),
      ...[0, 1, 2].map((k) => part(C(0.08, 0.08, 1.1, 0, 0.1, 0, 5).rotateZ(Math.PI / 2).rotateY(k * 1.05), 0x3a2618)),
    ]);
    const chair = mergeGeometries([
      ...[0, 1, 2, 3, 4].map((k) => part(B(0.6, 0.04, 0.1, 0, 0.42 - k * 0.02, -0.2 + k * 0.12), 0xffffff, 1)),
      ...[0, 1, 2, 3, 4].map((k) => part(B(0.1, 0.9, 0.03, -0.24 + k * 0.12, 0.85, -0.42).rotateX(-0.35), 0xffffff, 1)),
      part(B(0.1, 0.03, 0.75, -0.38, 0.62, -0.05), 0xffffff, 1), part(B(0.1, 0.03, 0.75, 0.38, 0.62, -0.05), 0xffffff, 1),
      ...[[-0.36, 0.25], [0.36, 0.25], [-0.36, -0.35], [0.36, -0.35]].map(([x, z]) => part(B(0.06, 0.6, 0.06, x, 0.3, z), 0xffffff, 1)),
    ]);
    const pits = [], chairs = [];
    for (const [a, b] of [[-70, 12], [106, 24]]) {
      const c = this.at(P, a, b);
      pits.push(new THREE.Matrix4().makeTranslation(c.x, c.y, c.z));
      this.cozyFlames.push({ p: c.clone().setY(c.y + 0.12), s: 1.1 });
      for (let k = 0; k < 4; k++) {
        const ang = k / 4 * Math.PI * 2 + 0.4, x = c.x + Math.cos(ang) * 2.6, z = c.z + Math.sin(ang) * 2.6;
        chairs.push(new THREE.Matrix4().compose(_v.set(x, islandHeight(x, z) ?? c.y, z), _q.setFromAxisAngle(UP, Math.atan2(c.x - x, c.z - z)), _s.setScalar(1)));
      }
    }
    add(pit, pits);
    add(chair, chairs, [0xf4f1ea, 0x8ad0c8, 0xf2a08a, 0xa8c8f0]);

    // ---- Дощатая дорожка из джунглей к пляжу и фонарики вдоль неё
    const planks = [], posts = [];
    const lanternGlobes = [];
    for (let b = 118; b > 44; b -= 0.55) planks.push(place(P, -48 + Math.sin(b * 0.05) * 3, b, faceP, 1, 0.05));
    for (let b = 116; b > 46; b -= 7) for (const side of [-1.8, 1.8]) {
      const a = -48 + Math.sin(b * 0.05) * 3 + side;
      posts.push(place(P, a, b, faceP));
      const p = this.at(P, a, b);
      lanternGlobes.push(p.clone().setY(p.y + 1.55));
    }
    add(part(B(2.4, 0.06, 0.42, 0, 0.03, 0), 0x9a7a58), planks, null, false);
    add(part(C(0.05, 0.05, 1.5, 0, 0.75, 0, 6), 0x6b4a2c), posts, null, false);
    // Гирлянда бумажных фонариков над лаунжем у бара
    const loungeC = this.at(P, 30, 28);
    for (let i = 0; i < 14; i++) {
      const t = i / 13, p = this.at(P, 22 + t * 18, 26 + Math.sin(t * Math.PI) * 2);
      lanternGlobes.push(p.clone().setY(p.y + 3.2 - Math.sin(t * Math.PI) * 0.6));
    }
    const wire = new THREE.Line(new THREE.BufferGeometry().setFromPoints(lanternGlobes.slice(-14).map((p) => p.clone().setY(p.y + 0.22))), new THREE.LineBasicMaterial({ color: 0x2a2018 }));
    this.near.add(wire);
    this.paperMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    const globes = new THREE.InstancedMesh(new THREE.SphereGeometry(0.22, 10, 8).scale(1, 1.15, 1), this.paperMat, lanternGlobes.length);
    const paperCols = [0xffd9a0, 0xffb0c0, 0xffe6c0, 0xffa070, 0xf0c0ff];
    lanternGlobes.forEach((p, i) => { globes.setMatrixAt(i, new THREE.Matrix4().makeTranslation(p.x, p.y, p.z)); globes.setColorAt(i, new THREE.Color(paperCols[i % paperCols.length])); });
    this.near.add(globes);
    // Тёплые пятна света от фонариков на досках и песке
    const pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), this.poolMat, lanternGlobes.length);
    lanternGlobes.forEach((p, i) => pools.setMatrixAt(i, new THREE.Matrix4().compose(_v.set(p.x, (islandHeight(p.x, p.z) ?? p.y) + 0.12, p.z), _q.identity(), _s.set(4, 1, 4))));
    this.near.add(pools);

    // ---- Гамаки между пальмами у кромки пляжа
    add(this.hammockGeo, [place(P, -92, 66, faceP + Math.PI / 2), place(P, 88, 70, faceP + Math.PI / 2 + 0.3), place(P, 150, 60, faceP + Math.PI / 2 - 0.2)]);

    // ---- Лаунж у бара: ковёр, низкие столики, пуфы-подушки, свечи на столиках
    const rug = part(B(7, 0.03, 4.5, 0, 0.02, 0), 0xffffff, 1);
    add(rug, [new THREE.Matrix4().compose(_v.set(loungeC.x, loungeC.y, loungeC.z), _q.setFromAxisAngle(UP, faceP), _s.setScalar(1))], [0xc85a4a]);
    const table = mergeGeometries([part(C(0.55, 0.55, 0.08, 0, 0.42, 0, 12), wood), part(C(0.08, 0.1, 0.4, 0, 0.2, 0, 6), 0x5a3a22)]);
    const pouf = part(new THREE.SphereGeometry(0.42, 10, 6).scale(1, 0.55, 1).translate(0, 0.22, 0), 0xffffff, 1);
    const tables = [], poufs = [];
    for (const da of [-1.6, 1.6]) {
      const p = this.at(P, 30 + da, 28);
      tables.push(new THREE.Matrix4().makeTranslation(p.x, p.y, p.z));
      this.cozyFlames.push({ p: p.clone().setY(p.y + 0.6), s: 0.09, candle: true });
      for (let k = 0; k < 3; k++) {
        const ang = k * 2.1 + 0.5, x = p.x + Math.cos(ang) * 1.1, z = p.z + Math.sin(ang) * 1.1;
        poufs.push(new THREE.Matrix4().makeTranslation(x, islandHeight(x, z) ?? p.y, z));
      }
    }
    add(table, tables);
    add(pouf, poufs, [0xf2c060, 0x7ac0c8, 0xe87a6a, 0xf4ecdc, 0xc88ac0, 0x8ad0a0]);

    // ---- Песочные замки, коряги, кокосы под пальмами
    const castle = mergeGeometries([
      part(C(0.9, 1.0, 0.6, 0, 0.3, 0, 10), 0xd8b070), part(C(0.32, 0.36, 0.7, 0, 0.95, 0, 8), 0xd8b070),
      ...[0, 1, 2, 3].map((k) => part(C(0.18, 0.22, 0.5, Math.cos(k * 1.57) * 0.65, 0.85, Math.sin(k * 1.57) * 0.65, 6), 0xd8b070)),
      ...[0, 1, 2, 3].map((k) => part(new THREE.ConeGeometry(0.2, 0.3, 6).translate(Math.cos(k * 1.57) * 0.65, 1.25, Math.sin(k * 1.57) * 0.65), 0xd0a868)),
      part(new THREE.ConeGeometry(0.34, 0.5, 8).translate(0, 1.55, 0), 0xd0a868),
    ]);
    add(castle, [place(P, -18, -34, rnd() * 6), place(P, 9, -37, rnd() * 6, 0.8), place(P, 64, -31, rnd() * 6, 1.1)]);
    const drift = part(C(0.15, 0.08, 3.4, 0, 0, 0, 6).rotateZ(Math.PI / 2).translate(0, 0.12, 0), 0xb8a890);
    const logs = [];
    for (let i = 0; i < 12; i++) logs.push(place(P, -170 + rnd() * 340, -28 + rnd() * 50, rnd() * 6.28, 0.7 + rnd() * 0.6));
    add(drift, logs, null, true, 600);
    const coco = part(new THREE.SphereGeometry(0.16, 7, 5), 0x5a3a20);
    const cocos = [];
    for (let i = 0; i < 70; i++) {
      const a = -240 + rnd() * 480, b = 58 + rnd() * 30;
      for (let k = 0; k < 3; k++) cocos.push(place(P, a + (rnd() - 0.5) * 0.8, b + (rnd() - 0.5) * 0.8, 0, 1, 0.12));
    }
    add(coco, cocos, null, false, 450);

    // ---- Ракушки и морские звёзды у кромки воды (на пляже и в бухте)
    const starPts = [];
    for (let k = 0; k < 10; k++) { const r = k % 2 ? 0.06 : 0.16, a = k / 10 * Math.PI * 2; starPts.push(new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r)); }
    const star = part(new THREE.ExtrudeGeometry(new THREE.Shape(starPts), { depth: 0.03, bevelEnabled: false }).rotateX(-Math.PI / 2), 0xffffff, 1);
    const shell = part(new THREE.SphereGeometry(0.07, 6, 4, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.6, 1.25), 0xffffff, 1);
    const stars = [], shells = [];
    for (let i = 0; i < 700; i++) {
      const cove = i % 4 === 0, F = cove ? Cv : P;
      const a = cove ? -60 + rnd() * 120 : -200 + rnd() * 400, b = cove ? -24 + rnd() * 18 : -48 + rnd() * 26;
      (rnd() < 0.25 ? stars : shells).push(place(F, a, b, rnd() * 6.28, 0.7 + rnd() * 0.8, 0.01));
    }
    add(star, stars, [0xff7a4a, 0xf2a060, 0xe85a6a, 0xffc080], false, 260);
    add(shell, shells, [0xf4ece0, 0xf2d0c8, 0xe8d8b8, 0xffe8e0, 0xd8c0e0], false, 260);

    // ---- Свечи сердцем у пледа в тихой бухте
    const candles = [];
    const hc = this.at(Cv, -12, 10);
    for (let k = 0; k < 28; k++) {
      const t = k / 28 * Math.PI * 2;
      const hx = 16 * Math.sin(t) ** 3, hy = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
      const a = -12 + hx * 0.22, b = 10 + 3.6 + hy * 0.22;
      const p = this.at(Cv, a, b);
      candles.push(new THREE.Matrix4().makeTranslation(p.x, p.y, p.z));
      this.cozyFlames.push({ p: p.clone().setY(p.y + 0.2), s: 0.07, candle: true });
    }
    void hc;
    add(part(C(0.05, 0.05, 0.18, 0, 0.09, 0, 8), 0xf8f2e4), candles, null, false, 500);
    // Свечи на кроватях-беседках
    for (const [a, b] of [[-118, 8], [120, 8]]) { const p = this.at(P, a + 1.0, b + 1.4); this.cozyFlames.push({ p: p.clone().setY(p.y + 0.3), s: 0.08, candle: true }); }

    // ---- Цветущие кусты вдоль кромки леса у пляжа
    const bushes = [];
    for (let i = 0; i < 40; i++) bushes.push(place(P, -230 + rnd() * 460, 80 + rnd() * 25, rnd() * 6.28, 0.8 + rnd() * 0.7));
    add(this.bushGeo, bushes, [0xff5a7a, 0xff8a4a, 0xffd0e0, 0xe03a5a, 0xffe060]);

    // ---- Пляжная трава на дюнах у кромки леса (по всему острову, видна вблизи)
    const blade = [];
    for (let k = 0; k < 7; k++) {
      const a = k / 7 * Math.PI * 2 + 0.3, h = 0.6 + (k % 3) * 0.2, lean = 0.35;
      const bx = Math.cos(a) * 0.08, bz = Math.sin(a) * 0.08, tx = Math.cos(a) * lean, tz = Math.sin(a) * lean;
      blade.push(bx - 0.03 * Math.sin(a), 0, bz + 0.03 * Math.cos(a), bx + 0.03 * Math.sin(a), 0, bz - 0.03 * Math.cos(a), tx, h, tz);
    }
    const bg = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(blade, 3));
    bg.computeVertexNormals();
    const tuft = part(bg, 0xffffff, 1, (y) => y * 0.5);
    const chunks = new Map();
    const half = ISLE.size / 2;
    for (let k = 0; k < 90000; k++) {
      const [x, z] = isleToWorld((rnd() - 0.5) * 2 * half, (rnd() - 0.5) * 2 * half);
      const s = islandSample(x, z);
      if (!s || s.rock > 0.05 || s.sd < 70 || s.sd > 175) continue;
      const key = `${Math.floor(x / 300)},${Math.floor(z / 300)}`;
      if (!chunks.has(key)) chunks.set(key, []);
      chunks.get(key).push(new THREE.Matrix4().compose(_v.set(x, s.h - 0.05, z), _q.setFromAxisAngle(UP, rnd() * 6.28), _s.setScalar(0.8 + rnd() * 0.9)));
    }
    for (const list of chunks.values()) {
      const m = add(tuft, list, [0x9ab050, 0xb8b868, 0x7a9a40, 0xc8c078], false, 450);
      m.receiveShadow = false;
    }

    // Огоньки свечей и костров
    this.cozyFlameMesh = new THREE.InstancedMesh(new THREE.ConeGeometry(0.5, 1.6, 8, 1).translate(0, 0.8, 0), this.flameMesh.material, this.cozyFlames.length);
    this.cozyFlameMesh.frustumCulled = false;
    this.near.add(this.cozyFlameMesh);
    const cpools = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), this.poolMat, this.cozyFlames.length);
    this.cozyFlames.forEach((f, i) => cpools.setMatrixAt(i, new THREE.Matrix4().compose(_v.set(f.p.x, f.p.y - (f.candle ? 0.15 : 0.08), f.p.z), _q.identity(), _s.setScalar(f.candle ? 2.2 : 8))));
    this.near.add(cpools);
  }

  // ---------------------------------------------------------------- кадр
  update(dt, camPos, env, player) {
    this.t += dt;
    this.uTime.value = this.t;
    const d = Math.hypot(camPos.x - ISLE.x, camPos.z - ISLE.z);
    this.near.visible = d < 6000;
    if (!this.near.visible) return;
    for (const c of this.vegChunks) {
      const dc = Math.hypot(camPos.x - c.x, camPos.z - c.z);
      c.m.visible = dc < c.far;
      // Дальний полог сливается в сплошную массу — там хватает половины деревьев
      if (c.thin) c.m.count = dc > 900 ? Math.ceil(c.full * (dc > 1800 ? 0.4 : 0.6)) : c.full;
    }
    const night = env.night, glowK = Math.max(env.golden * 0.6, night);
    // Огонь мерцает; ночью и на закате ярче
    const fm = this.flameMesh;
    this.flamePts.forEach((f, i) => {
      const fl = 0.8 + 0.25 * Math.sin(this.t * 13 + i * 2.1) + 0.15 * Math.sin(this.t * 23 + i);
      fm.setMatrixAt(i, _m.compose(f.p, _q.setFromAxisAngle(UP, this.t * 2 + i), _s.set(f.s * (0.9 + 0.1 * fl), f.s * fl, f.s * (0.9 + 0.1 * fl))));
    });
    fm.instanceMatrix.needsUpdate = true;
    fm.material.opacity = 0.55 + 0.4 * glowK;
    this.poolMat.uniforms.uK.value = 0.25 + 0.75 * glowK;
    this.bulbMat.color.setRGB(1, 0.85, 0.62).multiplyScalar(0.4 + 1.6 * glowK);
    this.lanternMat.color.setRGB(1, 0.75, 0.42).multiplyScalar((0.5 + 1.8 * glowK) * (0.9 + 0.1 * Math.sin(this.t * 7)));
    // Бумажные фонарики и огоньки свечей и маленьких костров
    this.paperMat.color.setScalar(0.55 + 1.5 * glowK);
    const cf = this.cozyFlameMesh;
    this.cozyFlames.forEach((f, i) => {
      const fl = 0.8 + 0.25 * Math.sin(this.t * (f.candle ? 9 : 13) + i * 1.7) + 0.12 * Math.sin(this.t * 21 + i);
      cf.setMatrixAt(i, _m.compose(f.p, _q.identity(), _s.set(f.s, f.s * fl * (f.candle ? 1.4 : 1), f.s)));
    });
    cf.instanceMatrix.needsUpdate = true;
    // Сцена: прожекторы меняют цвет в такт. Синтезированная музыка — 104 удара в минуту;
    // свой трек (music/party/) — темп и удары берутся из его басов
    const M = this.music;
    this.beatPh = (this.beatPh || 0) + dt * (M?.bpm || 104) / 60;
    if (M?.kick) this.beatPh += (Math.round(this.beatPh) - this.beatPh) * 0.5;
    const beat = this.beatPh;
    const flash = M ? 0.35 + 0.65 * M.pulse : 0.6 + 0.4 * Math.abs(Math.sin(beat * Math.PI));
    this.stageLightMat.color.setHSL((Math.floor(beat / 4) * 0.17 + 0.9) % 1, 0.9, 0.5).multiplyScalar(0.6 + 1.6 * glowK * flash);
    this.updateDancers(beat);
    // Купальщики покачиваются на волнах
    this.swimmers.forEach((s, i) => this.swimMesh.setMatrixAt(i, _m.compose(_v.set(s.p.x, WL - 0.1 + Math.sin(this.t * 1.3 + s.ph) * 0.12, s.p.z), _q.identity(), _s.setScalar(1))));
    this.swimMesh.instanceMatrix.needsUpdate = true;
    // Надписи при прилёте
    const pp = player.pos;
    const s = islandSample(pp.x, pp.z);
    let zone = null;
    if (s && s.sd > -300 && pp.y < 600) zone = Math.hypot(pp.x - this.cove.x, pp.z - this.cove.z) < 120 ? 'cove' : 'isle';
    if (zone !== this.lastZone) {
      if (zone === 'isle' && this.lastZone !== 'cove') this.world.toast?.('РАЙСКИЙ ОСТРОВ');
      if (zone === 'cove') this.world.toast?.('ТИХАЯ БУХТА');
      this.lastZone = zone;
    }
  }

  updateDancers(beat) {
    const D = this.dm, ph = beat * Math.PI;
    const e = new THREE.Euler(), m2 = new THREE.Matrix4(), q2 = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    this.dancers.forEach((d, i) => {
      const bounce = d.bar ? 0 : Math.abs(Math.sin(ph + d.ph * 0.2)) * 0.1;
      const sway = d.bar ? Math.sin(beat * 0.5 + d.ph) * 0.05 : Math.sin(ph * 0.5 + d.ph) * 0.18;
      _q.setFromAxisAngle(UP, d.rot + (d.bar ? 0 : Math.sin(beat * 0.25 + d.ph) * 0.6));
      _q.multiply(q2.setFromAxisAngle(AZ, sway * 0.4));
      _m.compose(_v.set(d.p.x, d.p.y + bounce, d.p.z), _q, _s.setScalar(d.h));
      D.torso.setMatrixAt(i, _m);
      m2.compose(_v.set(0, NECK_Y, 0), q2.setFromAxisAngle(AX, d.bar ? 0.1 : -0.15 + Math.sin(ph) * 0.12), one).premultiply(_m);
      D.head.setMatrixAt(i, m2);
      D.hairS.setMatrixAt(i, d.hair === 'S' ? m2 : _zero);
      D.hairL.setMatrixAt(i, d.hair === 'L' ? m2 : _zero);
      for (let k = 0; k < 2; k++) {
        const side = k === 0 ? 1 : -1;
        const step = d.bar ? 0 : Math.sin(ph + side * 1.2 + d.ph) * 0.25;
        m2.compose(_v.set(side * 0.1, HIP_Y, 0), q2.setFromAxisAngle(AX, step), one);
        D.legs.setMatrixAt(i * 2 + k, m2.premultiply(_m));
        // Руки: кто-то вскидывает вверх в такт, кто-то качает перед собой
        let rx, rz;
        if (d.bar) { rx = side < 0 ? -1.2 : -0.3; rz = 0.1 * side; }
        else if (d.style < 0.45) { rx = -2.6 - Math.sin(ph + side) * 0.35; rz = side * (0.35 + Math.sin(ph * 0.5 + d.ph) * 0.2); }
        else { rx = -0.9 + Math.sin(ph + side * 1.6 + d.ph) * 0.7; rz = side * 0.25; }
        e.set(rx, 0, rz);
        m2.compose(_v.set(side * 0.215, SHOULDER_Y, 0), q2.setFromEuler(e), one);
        D.arms.setMatrixAt(i * 2 + k, m2.premultiply(_m));
      }
    });
    for (const m of Object.values(D)) m.instanceMatrix.needsUpdate = true;
  }
}
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
