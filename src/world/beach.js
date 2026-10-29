import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CITY, WORLD } from '../config.js';
import { mulberry32 } from '../utils.js';
import { BEACH, beachHeight, PIER } from './layout.js';

// Городской пляж: песок со спуском в море, набегающая пена, набережная с пальмами
// и скамейками, зонты, шежлонги, полотенца с загорающими, вышки спасателей,
// волейбольная сетка, киоски. Мелочь разлетается от ударных волн.

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const UP = new THREE.Vector3(0, 1, 0);
const UMBRELLA = [0xd94a3a, 0x2f7fc1, 0xf2b632, 0x2aa198, 0xe76f9a, 0x6a4c93];
const TOWEL = [0xe63946, 0x457b9d, 0xf4a261, 0x2a9d8f, 0xffd166, 0x8338ec, 0xffffff, 0x06d6a0];
const SWIM = [0x1d3557, 0xe63946, 0x2a9d8f, 0x111111, 0xf4a261, 0x8338ec];
const PASTEL = [0x9ad0ec, 0xf4a6b8, 0xf9e07f, 0xa8e6cf, 0xc3aed6];
const SKIN = [0xf1c7a5, 0xe0ac85, 0xc68a62, 0x9a6640, 0x6b4429, 0xd29b74];
const WATERLINE = BEACH.x0 + 90 + (WORLD.waterLevel + 0.41) / -0.026; // где песок уходит под воду

export class Beach {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.uTime = { value: 0 };
    this.items = [];
    const rnd = mulberry32(CITY.seed + 71);
    scene.add(this.createSand(), this.createFoam());
    this.createDecor(rnd);
  }

  // ---------------------------------------------------------------- песок
  createSand() {
    const L = BEACH.x1 + 320 - BEACH.x0, D = BEACH.maxZ - BEACH.minZ;
    const geo = new THREE.PlaneGeometry(L, D, 90, 60).rotateX(-Math.PI / 2);
    geo.translate(BEACH.x0 + L / 2, 0, BEACH.minZ + D / 2);
    const P = geo.attributes.position, col = new Float32Array(P.count * 3);
    const dry = new THREE.Color(0xf7d596), wet = new THREE.Color(0xc29a62), deep = new THREE.Color(0x8f7f60), c = new THREE.Color();
    for (let i = 0; i < P.count; i++) {
      const x = P.getX(i), z = P.getZ(i);
      // Небольшие дюны на сухом песке
      const t = x - BEACH.x0;
      const dune = t < 75 ? Math.sin(z * 0.05 + t * 0.09) * Math.sin(z * 0.017) * 0.18 * Math.min(1, t / 10) : 0;
      const y = beachHeight(x) + dune;
      P.setY(i, y);
      c.copy(dry).lerp(wet, THREE.MathUtils.smoothstep(y, -1.0, -1.6)).lerp(deep, THREE.MathUtils.smoothstep(y, -1.8, -4));
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96 });
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vSandPos;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvSandPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vSandPos;
          float sh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          {
            // Зерно песка и следы-рябь от ветра
            vec2 p = vSandPos.xz;
            float grain = sh(floor(p * 9.0)) * 0.08 + sh(floor(p * 2.3)) * 0.06;
            float ripple = sin(p.x * 1.7 + sin(p.y * 0.3) * 2.0) * 0.03;
            diffuseColor.rgb *= 1.08 + grain + ripple;
            // Извилистая велодорожка вдоль пляжа
            float bx = ${(BEACH.x0 + 22).toFixed(1)} + sin(p.y * 0.008) * 7.0 + sin(p.y * 0.021) * 2.5;
            float bike = 1.0 - smoothstep(1.6, 1.9, abs(p.x - bx));
            float stripe = (1.0 - smoothstep(0.06, 0.1, abs(p.x - bx))) * step(0.5, fract(p.y / 3.0));
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.62, 0.6, 0.56), bike);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.95, 0.85, 0.3), stripe * bike);
          }`);
    };
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    // Боковые «юбки» песка (на краях пляжа не видно щели до дна)
    const skirtMat = new THREE.MeshStandardMaterial({ color: 0xb59c72, roughness: 1, side: THREE.DoubleSide });
    const g = new THREE.Group();
    g.add(mesh);
    for (const z of [BEACH.minZ, BEACH.maxZ]) {
      const n = 40, pos = [];
      for (let i = 0; i < n; i++) {
        const x0 = BEACH.x0 + (i / n) * L, x1 = BEACH.x0 + ((i + 1) / n) * L;
        const y0 = beachHeight(x0), y1 = beachHeight(x1);
        pos.push(x0, y0, z, x1, y1, z, x1, -16, z, x0, y0, z, x1, -16, z, x0, -16, z);
      }
      const sg = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      sg.computeVertexNormals();
      g.add(new THREE.Mesh(sg, skirtMat));
    }
    return g;
  }

  // Полоса пены у кромки воды: волны набегают на берег
  createFoam() {
    const D = BEACH.maxZ - BEACH.minZ;
    const geo = new THREE.PlaneGeometry(18, D, 1, 120).rotateX(-Math.PI / 2).translate(WATERLINE + 1, WORLD.waterLevel + 0.06, BEACH.minZ + D / 2);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.uTime },
      transparent: true, depthWrite: false,
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform float uTime; varying vec3 vP;
        void main() {
          float x = (vP.x - ${(WATERLINE - 8).toFixed(1)}) / 18.0;   // 0 — у берега, 1 — в море
          float wob = sin(vP.z * 0.11 + uTime * 0.7) * 0.05 + sin(vP.z * 0.37 - uTime * 0.9) * 0.03;
          // Гребень волны бежит к берегу и тает
          float ph = fract(uTime * 0.12 + wob);
          float crest = smoothstep(0.06, 0.0, abs(x - (1.0 - ph))) * smoothstep(0.0, 0.25, ph);
          float edge = smoothstep(0.08, 0.0, abs(x - 0.42 - wob * 2.0)) * 0.6;
          float a = max(crest, edge) * smoothstep(0.0, 0.1, x) * smoothstep(1.0, 0.8, x);
          a *= 0.55 + 0.45 * sin(vP.z * 1.3 + x * 20.0);
          gl_FragColor = vec4(vec3(0.95, 0.97, 1.0), a * 0.75);
        }`,
    });
    const m = new THREE.Mesh(geo, mat);
    m.renderOrder = 3;
    return m;
  }

  // ---------------------------------------------------------------- предметы
  createDecor(rnd) {
    const G = makeGeometries();
    const groups = {};
    const add = (type, x, z, rot, color = 0xffffff, scale = 1, y = null) => {
      // Под пирсом и рядом с ним песок свободен
      if (type !== 'tallpalm' && Math.abs(z - PIER.z) < PIER.w / 2 + 4 && x < BEACH.x0 + PIER.len) return null;
      const it = { type, x, z, y: y ?? beachHeight(x), rot, color, scale, alive: true };
      (groups[type] = groups[type] || []).push(it);
      this.items.push(it);
      return it;
    };
    const z0 = BEACH.minZ + 10, z1 = BEACH.maxZ - 10, x0 = BEACH.x0;
    // Набережная: пальмы, скамейки к морю, киоски
    // Высокие тонкие пальмы вдоль набережной — калифорнийский силуэт на фоне заката
    for (let z = z0; z < z1; z += 13 + rnd() * 4) add('tallpalm', x0 + 2.5 + rnd() * 1.2, z, rnd() * 6.28, 0xffffff, 0.85 + rnd() * 0.35, 0);
    for (let z = z0 + 8; z < z1; z += 32) add('bench', x0 + 5.5, z, Math.PI / 2, 0xffffff, 1, beachHeight(x0 + 5.5));
    for (const z of [z0 + 260, z0 + 760]) add('kiosk', x0 + 9, z, Math.PI / 2);
    // Пальмы и в глубине пляжа
    for (let i = 0; i < 26; i++) add('palm', x0 + 14 + rnd() * 40, z0 + rnd() * (z1 - z0), rnd() * 6.28, 0xffffff, 0.8 + rnd() * 0.5);
    // Зонты с шезлонгами и полотенцами
    for (let z = z0 + 20; z < z1 - 10; z += 11 + rnd() * 6) {
      for (const tx of [26, 40, 54, 68]) {
        if (rnd() < 0.35) continue;
        const x = x0 + tx + (rnd() - 0.5) * 5, zz = z + (rnd() - 0.5) * 5;
        add('umbrella', x, zz, rnd() * 6.28, UMBRELLA[Math.floor(rnd() * UMBRELLA.length)]);
        const lounge = rnd() < 0.5;
        for (const s of [-1, 1]) {
          if (rnd() < 0.25) continue;
          const lx = x + 1.3, lz = zz + s * 1.1;
          if (lounge) add('lounger', lx, lz, Math.PI / 2 + (rnd() - 0.5) * 0.3, TOWEL[Math.floor(rnd() * TOWEL.length)]);
          else add('towel', lx, lz, Math.PI / 2 + (rnd() - 0.5) * 0.6, TOWEL[Math.floor(rnd() * TOWEL.length)]);
          // Загорающий человек
          if (rnd() < 0.55) {
            const y = beachHeight(lx) + (lounge ? 0.38 : 0.03);
            if (Math.abs(lz - PIER.z) < PIER.w / 2 + 4) continue;
            const sb = add('sunbather', lx, lz, Math.PI / 2 + (rnd() - 0.5) * 0.4, SWIM[Math.floor(rnd() * SWIM.length)], 0.9 + rnd() * 0.15, y);
            if (sb) sb.skin = SKIN[Math.floor(rnd() * SKIN.length)];
          }
        }
      }
    }
    // Вышки спасателей и волейбольная сетка
    // Пастельные вышки спасателей
    for (const z of [z0 + 150, z0 + 420, z1 - 380, z1 - 120]) add('tower', WATERLINE - 22, z, -Math.PI / 2, PASTEL[Math.floor(rnd() * PASTEL.length)]);
    // Парочки сидят у воды, лицом к морю (и закату)
    for (let i = 0; i < 46; i++) add('couple', x0 + 78 + rnd() * 40, z0 + rnd() * (z1 - z0), Math.PI / 2 + (rnd() - 0.5) * 0.5, 0xffffff, 0.95 + rnd() * 0.1);
    add('volley', x0 + 50, (z0 + z1) / 2, 0);

    // Инстанс-сетки
    this.meshes = [];
    const mat = createTintMaterial(this.uTime);
    for (const type in groups) {
      const list = groups[type];
      const mesh = new THREE.InstancedMesh(G[type], mat, list.length);
      mesh.castShadow = type !== 'towel';
      mesh.receiveShadow = true;
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 3).fill(1), 3);
      list.forEach((it, i) => { it.mesh = mesh; it.slot = i; this.write(it); mesh.setColorAt(i, new THREE.Color(it.color)); });
      mesh.computeBoundingSphere();
      this.scene.add(mesh);
      this.meshes.push(mesh);
      // Кожа загорающих — отдельная сетка голов/рук того же расположения
      if (type === 'sunbather') {
        const skin = new THREE.InstancedMesh(G.sunbatherSkin, mat, list.length);
        skin.castShadow = true;
        skin.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 3).fill(1), 3);
        list.forEach((it, i) => { it.skinMesh = skin; skin.setColorAt(i, new THREE.Color(it.skin)); });
        this.skinMesh = skin;
        list.forEach((it) => this.write(it));
        skin.computeBoundingSphere();
        this.scene.add(skin);
        this.meshes.push(skin);
      }
    }
  }

  write(it) {
    if (it.alive) _m.compose(_v.set(it.x, it.y, it.z), _q.setFromAxisAngle(UP, it.rot), _s.setScalar(it.scale));
    else _m.copy(_zero);
    it.mesh.setMatrixAt(it.slot, _m);
    it.mesh.instanceMatrix.needsUpdate = true;
    if (it.skinMesh) { it.skinMesh.setMatrixAt(it.slot, _m); it.skinMesh.instanceMatrix.needsUpdate = true; }
  }

  // Ударная волна: зонты, шезлонги и полотенца разлетаются; загорающие вскакивают и убегают
  impulse(center, radius, force) {
    if (center.x < BEACH.x0 - radius - 50 || center.z < BEACH.minZ - radius || center.z > BEACH.maxZ + radius) return;
    const W = this.world;
    for (const it of this.items) {
      if (!it.alive || it.type === 'tower' || it.type === 'kiosk') continue;
      const d = Math.hypot(it.x - center.x, it.z - center.z);
      if (d > radius || force * (1 - d / radius) < 6) continue;
      it.alive = false;
      this.write(it);
      if (it.type === 'sunbather' || it.type === 'couple') {
        for (let k = it.type === 'couple' ? 2 : 1; k > 0; k--) W.people?.spawnAt?.(new THREE.Vector3(it.x + k * 0.5, it.y, it.z), center);
        continue;
      }
      const dir = _v.set(it.x - center.x, 0, it.z - center.z).normalize();
      const f = Math.min(30, force);
      const big = it.type === 'palm' ? [0.4, 6, 0.4] : it.type === 'umbrella' ? [2.4, 0.4, 2.4] : [0.7, 0.3, 1.8];
      W.debris?.spawn(it.x, it.y + 1, it.z, big[0], big[1], big[2], dir.x * f, 4 + f * 0.3, dir.z * f, new THREE.Color(it.color === 0xffffff ? 0x7a5a3a : it.color), 0);
    }
  }

  update(dt) { this.uTime.value += dt; }

  reset() { for (const it of this.items) if (!it.alive) { it.alive = true; this.write(it); } }
}

// Материал: tint = 1 — часть берёт цвет экземпляра (полоски зонта, полотенце, купальник).
// sway = высота над землёй для покачивания листьев пальм.
function createTintMaterial(uTime) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float tint;\nattribute float sway;\nuniform float uTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          float ph = 0.0;
          #ifdef USE_INSTANCING
            ph = instanceMatrix[3].x * 0.31 + instanceMatrix[3].z * 0.17;
          #endif
          transformed.x += sin(uTime * 1.4 + ph) * 0.06 * sway;
          transformed.z += cos(uTime * 1.1 + ph * 1.3) * 0.05 * sway;
        }`)
      .replace('#include <color_vertex>', `
        vColor.rgb = color.rgb;
        #ifdef USE_INSTANCING_COLOR
          vColor.rgb *= mix(vec3(1.0), instanceColor.rgb, tint);
        #endif`);
  };
  return mat;
}

function makeGeometries() {
  const part = (geo, color, tint = 0, swayFn = null) => {
    if (geo.index) geo = geo.toNonIndexed();
    if (geo.attributes.uv) geo.deleteAttribute('uv');
    if (!geo.attributes.normal) geo.computeVertexNormals();
    const n = geo.attributes.position.count, c = new THREE.Color(color), P = geo.attributes.position;
    const col = new Float32Array(n * 3), t = new Float32Array(n), sw = new Float32Array(n);
    const tf = typeof tint === 'function' ? tint : () => tint;
    for (let i = 0; i < n; i++) {
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      t[i] = tf(i); sw[i] = swayFn ? swayFn(P.getY(i)) : 0;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('tint', new THREE.BufferAttribute(t, 1));
    geo.setAttribute('sway', new THREE.BufferAttribute(sw, 1));
    return geo;
  };
  const B = (w, h, d, x, y, z) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
  const C = (r, h, x, y, z, s = 8) => new THREE.CylinderGeometry(r, r, h, s).translate(x, y, z);
  const M = (l) => mergeGeometries(l);

  // Пальма: наклонный ствол из колец, крона из поникших листьев
  const makePalm = (rings, ringH, r0, lean, fronds, frondLen) => {
    const parts = [];
    let px = 0, py = 0;
    for (let i = 0; i < rings; i++) {
      const r = r0 * (1 - i / rings * 0.45);
      parts.push(part(new THREE.CylinderGeometry(r * 0.92, r, ringH, 7).translate(px, py + ringH / 2, 0), i % 2 ? 0x8a6a48 : 0x7a5c3c));
      py += ringH; px += lean * (0.4 + i / rings);
    }
    for (let k = 0; k < fronds; k++) {
      const a = (k / fronds) * Math.PI * 2 + 0.2, pos = [];
      const seg = 6, len = frondLen;
      for (let s2 = 0; s2 < seg; s2++) {
        const t0 = s2 / seg, t1 = (s2 + 1) / seg;
        const r0b = t0 * len, r1 = t1 * len, y0 = Math.sin(t0 * 2.4) * 0.25 * len - t0 * t0 * 0.6 * len, y1 = Math.sin(t1 * 2.4) * 0.25 * len - t1 * t1 * 0.6 * len;
        const w0 = 0.12 * len * Math.sin(Math.PI * Math.min(1, t0 + 0.1)), w1 = 0.12 * len * Math.sin(Math.PI * Math.min(1, t1 + 0.1));
        const ca = Math.cos(a), sa = Math.sin(a), nx = -sa, nz = ca;
        const P = (r, y, w) => [px + ca * r + nx * w, py + y, sa * r + nz * w];
        pos.push(...P(r0b, y0, -w0), ...P(r1, y1, -w1), ...P(r1, y1, w1), ...P(r0b, y0, -w0), ...P(r1, y1, w1), ...P(r0b, y0, w0));
      }
      const fg = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      fg.computeVertexNormals();
      parts.push(part(fg, k % 2 ? 0x3d7a2c : 0x4a8a34, 0, (y) => Math.max(0, y - py * 0.8) * 0.4));
    }
    parts.push(part(new THREE.SphereGeometry(r0 * 1.3, 6, 4).translate(px, py, 0), 0x5a4026));
    return M(parts);
  };
  const palm = makePalm(9, 0.9, 0.26, 0.08, 8, 3.6);
  // Высокая «калифорнийская» пальма: тонкий ствол 20+ м и небольшая пышная крона
  const tallpalm = makePalm(22, 1.0, 0.24, 0.025, 11, 3.2);

  // Сидящая парочка: двое рядом, она склонила голову ему на плечо
  const seated = (dx, shirt, lean) => {
    const g = [
      part(B(0.36, 0.55, 0.24, 0, 0.5, -0.05).rotateZ(lean), shirt),
      part(new THREE.SphereGeometry(0.11, 8, 6).translate(0, 0.9, -0.03).rotateZ(lean * 1.6), 0xd29b74),
      part(B(0.34, 0.14, 0.5, 0, 0.12, 0.22), 0x2a3550),
      part(B(0.32, 0.4, 0.12, 0, 0.18, 0.5), 0x2a3550),
      part(B(0.09, 0.4, 0.09, 0.2, 0.5, 0.05).rotateX(-0.6), 0xd29b74),
      part(B(0.09, 0.4, 0.09, -0.2, 0.5, 0.05).rotateX(-0.6), 0xd29b74),
    ];
    return g.map((q) => q.translate(dx, 0, 0));
  };
  const couple = M([...seated(-0.27, 0xf4f1ea, 0.0), ...seated(0.27, 0xd94a6a, -0.22), part(B(1.6, 0.02, 1.4, 0, 0.01, 0.2), 0xe8d0a0)]);

  // Зонт: шест и купол в полоску (каждый второй клин — цвет экземпляра)
  const canopy = new THREE.ConeGeometry(1.5, 0.55, 12, 1, true).translate(0, 2.25, 0).toNonIndexed();
  const umbrella = M([part(C(0.035, 2.3, 0, 1.15, 0, 6), 0xdddddd), part(canopy, 0xf4f1ea, (i) => Math.floor(i / 3) % 2)]);
  const lounger = M([
    part(B(0.65, 0.06, 1.3, 0, 0.32, -0.25), 0xffffff, 1), part(B(0.65, 0.06, 0.6, 0, 0.52, 0.62).rotateX(-0.6), 0xffffff, 1),
    ...[[-0.28, -0.8], [0.28, -0.8], [-0.28, 0.5], [0.28, 0.5]].map(([x, z]) => part(B(0.04, 0.3, 0.04, x, 0.15, z), 0xcfcfcf)),
  ]);
  const towel = part(B(0.85, 0.02, 1.8, 0, 0.01, 0), 0xffffff, 1);
  // Загорающий лежит на спине: туловище в купальнике (цвет экземпляра) + кожа отдельно
  const sunbather = M([part(B(0.36, 0.18, 0.5, 0, 0.1, 0.05), 0xffffff, 1)]);
  const sunbatherSkin = M([
    part(new THREE.SphereGeometry(0.11, 8, 6).scale(0.95, 0.85, 1).translate(0, 0.11, 0.48), 0xffffff, 1),
    part(new THREE.CapsuleGeometry(0.12, 0.3, 2, 6).rotateX(Math.PI / 2).translate(0, 0.11, 0.22), 0xffffff, 1),
    part(new THREE.CapsuleGeometry(0.075, 0.75, 2, 6).rotateX(Math.PI / 2).translate(-0.1, 0.08, -0.62), 0xffffff, 1),
    part(new THREE.CapsuleGeometry(0.075, 0.75, 2, 6).rotateX(Math.PI / 2).translate(0.1, 0.08, -0.62), 0xffffff, 1),
    part(new THREE.CapsuleGeometry(0.05, 0.5, 2, 5).rotateX(Math.PI / 2).translate(-0.26, 0.07, 0.05), 0xffffff, 1),
    part(new THREE.CapsuleGeometry(0.05, 0.5, 2, 5).rotateX(Math.PI / 2).translate(0.26, 0.07, 0.05), 0xffffff, 1),
  ]);
  const bench = M([
    part(B(1.8, 0.07, 0.45, 0, 0.45, 0), 0x8a6a48), part(B(1.8, 0.4, 0.06, 0, 0.75, -0.22), 0x8a6a48),
    part(B(0.07, 0.45, 0.45, -0.8, 0.22, 0), 0x3b3f44), part(B(0.07, 0.45, 0.45, 0.8, 0.22, 0), 0x3b3f44),
  ]);
  const kiosk = M([
    part(B(3.6, 2.6, 2.6, 0, 1.3, 0), 0xf3efe4), part(B(3.6, 0.9, 0.05, 0, 1.6, 1.31), 0x2b3a44),
    part(B(4.4, 0.15, 3.4, 0, 2.75, 0.3), 0xffffff, (i) => Math.floor(i / 6) % 2),
    part(B(3.8, 0.5, 0.15, 0, 2.5, 2.0), 0xffffff, 1),
  ]);
  const tower = M([
    ...[[-0.9, -0.9], [0.9, -0.9], [-0.9, 0.9], [0.9, 0.9]].map(([x, z]) => part(B(0.14, 2.6, 0.14, x, 1.3, z), 0xf3efe4)),
    part(B(2.2, 0.12, 2.2, 0, 2.6, 0), 0xf3efe4), part(B(2.0, 1.4, 2.0, 0, 3.35, 0), 0xffffff, 1),
    part(B(2.1, 0.5, 2.1, 0, 3.6, 0), 0xf3efe4), part(new THREE.ConeGeometry(1.7, 0.7, 4).rotateY(Math.PI / 4).translate(0, 4.4, 0), 0xffffff, 1),
    part(B(0.06, 1.0, 1.4, 1.03, 3.35, 0), 0x223344),
    part(B(0.6, 0.06, 1.8, 0, 1.3, 1.6).rotateX(0.85), 0xf3efe4),
  ]);
  const volley = M([part(C(0.06, 2.6, 0, 1.3, -4.5), 0xdddddd), part(C(0.06, 2.6, 0, 1.3, 4.5), 0xdddddd), part(B(0.03, 0.9, 9, 0, 2.05, 0), 0x222222),
    part(B(8, 0.02, 16, 0, 0.02, 0), 0xf4f1ea)]);
  return { palm, tallpalm, couple, umbrella, lounger, towel, sunbather, sunbatherSkin, bench, kiosk, tower, volley };
}
