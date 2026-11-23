import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makePersonGeometry } from '../world/people.js';
import { curvePatch, CX, CZ, SITES, RIFT, R_CITY } from './tarven.js';
import { mulberry32, damp } from '../utils.js';

// Жители Тарвэна. Те же части, что у людей Земли (голова, волосы, руки), но своя одежда: туника
// с высоким воротом, длинное платье или мантия, у стражи — латы. На груди светится знак дома.
// Ходят по площадям, проспектам и Садам, сидят на трибунах Арены, летают между башнями;
// внизу, в Разломе, — бескрылые. На героя реагируют по-своему: после победы над Ксаргом кто-то
// кланяется, стража отдаёт честь кулаком к груди, кто-то отворачивается, а бескрылые поднимают кулак.
// Именные персонажи (cast.js) — такие же жители, только у них своё место и вещи в руках.

const HIP = 0.92, SHOULDER = 1.42, NECK = 1.47;
const DRAW_R = 280;          // дальше не рисуем
const UP = new THREE.Vector3(0, 1, 0), RX = new THREE.Vector3(1, 0, 0);
const _m = new THREE.Matrix4(), _u = new THREE.Matrix4(), _h = new THREE.Matrix4(), _t = new THREE.Matrix4();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler();
const _v = new THREE.Vector3(), _s = new THREE.Vector3(), _w = new THREE.Vector3();
const _sph = new THREE.Sphere(new THREE.Vector3(), 1.4), _fr = new THREE.Frustum(), _pv = new THREE.Matrix4();
const C = (r, g, b) => new THREE.Color().setRGB(r, g, b);

const SKIN = [C(0.95, 0.8, 0.7), C(0.85, 0.66, 0.52), C(0.7, 0.5, 0.38), C(0.5, 0.34, 0.24), C(0.33, 0.22, 0.16)];
const HAIR = [C(0.04, 0.035, 0.035), C(0.12, 0.07, 0.04), C(0.55, 0.56, 0.6), C(0.85, 0.85, 0.88), C(0.25, 0.06, 0.04)];
const GARB = [C(0.86, 0.86, 0.88), C(0.6, 0.62, 0.66), C(0.08, 0.12, 0.25), C(0.05, 0.05, 0.06), C(0.3, 0.06, 0.08), C(0.25, 0.28, 0.33), C(0.8, 0.76, 0.66)];
const DULL = [C(0.3, 0.25, 0.2), C(0.22, 0.2, 0.18), C(0.35, 0.3, 0.24), C(0.18, 0.16, 0.15), C(0.27, 0.22, 0.17)];
const SIGIL = [C(1.6, 1.0, 0.4), C(0.4, 1.3, 2.0), C(1.2, 0.6, 2.0), C(2.0, 0.4, 0.3), C(1.8, 1.8, 1.8), C(0.3, 1.8, 1.1)];
const ARMOR = C(0.06, 0.065, 0.075), UNDER = C(0.03, 0.03, 0.035), GUARD_RED = C(0.22, 0.03, 0.03), GUARD_SIGIL = C(2.0, 0.35, 0.15);

function part(geo, color, tint) {
  if (geo.index) geo = geo.toNonIndexed();
  const c = new THREE.Color(color), n = geo.attributes.position.count;
  const a = new Float32Array(n * 3), t = new Float32Array(n).fill(tint);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
  geo.setAttribute('tint', new THREE.BufferAttribute(t, 1));
  if (geo.attributes.uv) geo.deleteAttribute('uv');
  return geo;
}
const S = (r, w, h, sx, sy, sz, x, y, z) => new THREE.SphereGeometry(r, w, h).scale(sx, sy, sz).translate(x, y, z);

function makeGeometry() {
  const base = makePersonGeometry();
  // Туника: широкая грудь, плечи, высокий стоячий ворот, тёмный пояс
  const torso = mergeGeometries([
    part(new THREE.CylinderGeometry(0.205, 0.165, 0.44, 12).scale(1, 1, 0.62).translate(0, 1.22, 0), 0xffffff, 1),
    part(S(0.205, 12, 5, 1.06, 0.45, 0.62, 0, 1.42, 0), 0xffffff, 1),
    part(S(0.078, 8, 6, 1, 0.9, 1, 0.195, 1.395, 0), 0xffffff, 1),
    part(S(0.078, 8, 6, 1, 0.9, 1, -0.195, 1.395, 0), 0xffffff, 1),
    part(new THREE.CylinderGeometry(0.088, 0.1, 0.15, 12, 1, true).translate(0, 1.53, -0.006), 0xffffff, 1),
    part(new THREE.CylinderGeometry(0.17, 0.17, 0.05, 12).scale(1, 1, 0.66).translate(0, 1.02, 0), 0x16161a, 0),
    part(new THREE.CylinderGeometry(0.168, 0.178, 0.18, 12).scale(1, 1, 0.68).translate(0, 0.93, 0), 0xffffff, 1),
    part(new THREE.BoxGeometry(0.012, 0.4, 0.008).translate(0, 1.22, 0.128), 0x9a9aa6, 0),
  ]);
  // Длинное платье от пояса до щиколоток (у знати и у Регента)
  const robe = part(new THREE.CylinderGeometry(0.175, 0.31, 0.9, 14).scale(1, 1, 0.78).translate(0, 0.53, 0), 0xffffff, 1);
  // Мантия с плеч: полукольцо за спиной до колен
  const mantle = part(new THREE.CylinderGeometry(0.24, 0.4, 1.06, 14, 1, true, Math.PI * 0.55, Math.PI * 0.9).translate(0, 0.96, -0.02), 0xffffff, 1);
  // Латы: наплечники, нагрудник, воротник
  const armor = mergeGeometries([
    part(S(0.115, 10, 6, 1.15, 0.72, 1.05, 0.225, 1.45, 0), 0xffffff, 1),
    part(S(0.115, 10, 6, 1.15, 0.72, 1.05, -0.225, 1.45, 0), 0xffffff, 1),
    part(new THREE.CylinderGeometry(0.222, 0.185, 0.36, 12, 1, true, -1.15, 2.3).scale(1, 1, 0.66).translate(0, 1.26, 0.005), 0xffffff, 1),
    part(new THREE.CylinderGeometry(0.1, 0.12, 0.08, 10).translate(0, 1.5, 0), 0xffffff, 1),
  ]);
  // Нога: бедро, колено, голень, высокий сапог
  const leg = mergeGeometries([
    part(new THREE.CylinderGeometry(0.088, 0.068, 0.44, 10).translate(0, -0.22, 0), 0xffffff, 1),
    part(S(0.07, 8, 6, 1, 0.8, 1, 0, -0.45, 0.01), 0xffffff, 1),
    part(new THREE.CylinderGeometry(0.068, 0.058, 0.2, 10).translate(0, -0.56, 0), 0xffffff, 1),
    part(new THREE.CylinderGeometry(0.062, 0.054, 0.26, 10).translate(0, -0.76, 0), 0x121216, 0),
    part(new THREE.CapsuleGeometry(0.05, 0.15, 2, 8).rotateX(Math.PI / 2).scale(1.05, 0.8, 1).translate(0, -0.865, 0.045), 0x121216, 0),
  ]);
  const sigil = new THREE.CircleGeometry(0.034, 6).rotateZ(Math.PI / 6).translate(0, 1.34, 0.131);
  sigil.deleteAttribute('uv');
  return { torso, robe, mantle, armor, leg, sigil, head: base.head, hairShort: base.hairShort, hairLong: base.hairLong, hairTail: base.hairTail, beard: base.beard, arm: base.arm };
}

function folkMaterial(U, side) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side, envMapIntensity: 0 });
  mat.customProgramCacheKey = () => 'tarvenfolk' + side;
  mat.onBeforeCompile = (shader) => {
    curvePatch(shader, U);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float tint;')
      .replace('#include <color_vertex>', `
        vColor.rgb = color.rgb;
        #ifdef USE_INSTANCING_COLOR
          vColor.rgb *= mix(vec3(1.0), instanceColor.rgb, tint);
        #endif`);
  };
  return mat;
}

const pick = (a, r) => a[Math.floor(r * a.length) % a.length];

export class Folk {
  constructor(city, world) {
    this.city = city;
    this.world = world;
    this.list = [];
    this.rnd = mulberry32(2207);
    this.t = 0;
  }

  // ---------------------------------------------------------------- население
  build(cast) {
    const R = this.rnd, city = this.city, hc = city.hC;
    const fl = hc - RIFT.depth;
    const ring = (cx, cz, r0, r1) => () => { const a = R() * 6.283, r = Math.sqrt(r0 * r0 + R() * (r1 * r1 - r0 * r0)); return [cx + Math.cos(a) * r, cz + Math.sin(a) * r]; };
    const line = (ax, az, bx, bz, w) => () => { const t = R(), o = (R() - 0.5) * 2 * w, l = Math.hypot(bx - ax, bz - az); return [ax + (bx - ax) * t - (bz - az) / l * o, az + (bz - az) * t + (bx - ax) / l * o]; };
    const polar = (r, a) => [CX + Math.cos(a) * r, CZ + Math.sin(a) * r];
    const add = (n, type, home, opt = {}) => { for (let k = 0; k < n; k++) this.add(type, home, opt); };

    add(80, 'citizen', ring(CX, CZ, 235, 560));
    for (let k = 0; k < 14; k++) {
      const a = k / 14 * 6.283 + 0.11, [x, z] = polar(200, a);
      this.add('guard', null, { stand: [x, hc + 42, z, a] });
    }
    add(22, 'citizen', ring(...SITES.archive, 70, 150));
    for (let i = 0; i < 6; i++) {
      const a = (30 + 60 * i) * Math.PI / 180, [ax, az] = polar(1000, a), [bx, bz] = polar(6000, a);
      add(40, 'citizen', line(ax, az, bx, bz, 30));
    }
    // Верфи: рабочие между доками и рядами кораблей, охрана
    const [yx, yz] = SITES.yards;
    add(50, 'citizen', ring(yx, yz, 60, 640));
    add(10, 'guard', ring(yx, yz, 100, 700));
    // Парящие острова: гуляют по садам
    for (const [x, y, z, r] of city.isles) add(4, 'citizen', ring(x, z, 4, r * 0.7), { y, slow: true });
    // Арена: зрители на трибунах лицом к кругу, стража на песке
    const [ax, az] = SITES.arena;
    for (let k = 0; k < 80; k++) {
      const a = R() * 6.283, r = 182 + R() * 90, x = ax + Math.cos(a) * r, z = az + Math.sin(a) * r;
      this.add(R() < 0.2 ? 'guard' : 'citizen', null, { stand: [x, city.roofAt(x, z, 1e9), z, Math.atan2(ax - x, az - z)], seat: true });
    }
    for (let k = 0; k < 6; k++) {
      const a = k / 6 * 6.283, x = ax + Math.cos(a) * 80, z = az + Math.sin(a) * 80;
      this.add('guard', null, { stand: [x, hc, z, Math.atan2(ax - x, az - z)], spar: k });
    }
    const [gx, gz] = SITES.gardens;
    add(30, 'citizen', ring(gx, gz, 40, 250), { slow: true });
    for (let k = 0; k < 10; k++) {
      const a = R() * 6.283, r = 60 + Math.floor(R() * 7) * 28 + 4, x = gx + Math.cos(a) * r, z = gz + Math.sin(a) * r;
      this.add('citizen', null, { stand: [x, hc, z, Math.atan2(gx - x, gz - z) + Math.PI], mourn: true });
    }
    const [px, pz] = SITES.port;
    add(30, 'citizen', ring(px, pz, 110, 380));
    add(10, 'guard', ring(px, pz, 100, 300));
    // Разлом: бескрылые на дне; у рынка — толпа
    const [rax, raz] = RIFT.a, [rbx, rbz] = RIFT.b;
    add(100, 'wingless', line(rax, raz, rbx, rbz, 22), { y: fl });
    add(18, 'wingless', ring(...city.market, 8, 40), { y: fl });
    // Летают между башнями
    add(100, 'citizen', () => polar(600 + R() * 5200, R() * 6.283), { fly: true });
    for (const [x, y, z] of city.platforms) {
      for (const o of [-1, 1]) this.add(R() < 0.4 ? 'guard' : 'citizen', null, { stand: [x - 20, y, z + o * 14, R() * 6.283] });
    }
    for (const c of cast) this.npc(c);
    this.createMeshes();
  }

  add(type, home, opt = {}) {
    const R = this.rnd;
    const p = {
      type, home, x: 0, y: 0, z: 0, yaw: R() * 6.283, tx: 0, tz: 0, wait: R() * 4, v: 0,
      speed: (type === 'wingless' ? 1.05 : 1.25) + R() * 0.45, phase: R() * 6.283, slow: !!opt.slow,
      h: (type === 'wingless' ? 0.98 : 1.04) + R() * 0.1, react: '', reactT: 0, noticed: false, bow: 0, look: 0, headYaw: 0,
      armL: 0, armR: 0, armRz: 0, stag: 0, sx: 0, sz: 0, flyK: 0, alt: 0, seat: !!opt.seat, mourn: !!opt.mourn, spar: opt.spar ?? -1,
      groundY: opt.y, npc: null, vis: false,
    };
    // Внешность
    p.skin = pick(SKIN, R());
    p.hairC = pick(HAIR, R());
    p.hair = R() < 0.45 ? 'short' : R() < 0.5 ? 'long' : R() < 0.6 ? 'tail' : 'none';
    p.beard = p.hair !== 'long' && R() < 0.2;
    if (type === 'guard') {
      Object.assign(p, { garb: UNDER, robeOn: false, mantleOn: R() < 0.55, mantleC: GUARD_RED, armorOn: true, armorC: ARMOR, sigilC: GUARD_SIGIL, legC: UNDER });
      p.hair = R() < 0.7 ? 'short' : 'tail'; p.beard = false;
    } else if (type === 'wingless') {
      Object.assign(p, { garb: pick(DULL, R()), robeOn: R() < 0.35, robeC: pick(DULL, R()), mantleOn: R() < 0.3, mantleC: pick(DULL, R()), armorOn: false, sigilC: null, legC: pick(DULL, R()) });
    } else {
      const g = pick(GARB, R());
      Object.assign(p, { garb: g, robeOn: R() < 0.55, robeC: R() < 0.5 ? g : pick(GARB, R()), mantleOn: R() < 0.4, mantleC: pick(GARB, R()), armorOn: false, sigilC: R() < 0.75 ? pick(SIGIL, R()) : null, legC: pick(GARB, R()) });
    }
    if (opt.stand) {
      const [x, y, z, yaw] = opt.stand;
      Object.assign(p, { mode: 'stand', x, y, z, yaw, groundY: y });
    } else if (opt.fly) {
      const [x, z] = home();
      Object.assign(p, { mode: 'fly', x, z, alt: 80 + R() * 320, speed: 22 + R() * 40 });
      p.y = this.city.hC + p.alt;
      [p.tx, p.tz] = home();
    } else {
      const [x, z] = home();
      Object.assign(p, { mode: 'walk', x, z });
      [p.tx, p.tz] = home();
      p.y = p.groundY ?? this.city.ground(x, z);
    }
    p.yaw0 = p.yaw;
    this.list.push(p);
    return p;
  }

  // Именной персонаж: место, взгляд, одежда и вещи — из его описания
  npc(c) {
    const [x, y, z, yaw] = c.spot(this.city);
    const L = c.look;
    const p = this.add(L.type || 'citizen', null, { stand: [x, y, z, yaw] });
    Object.assign(p, {
      npc: c, h: L.h ?? 1.06, skin: C(...L.skin), hairC: C(...L.hairC), hair: L.hair, beard: !!L.beard,
      garb: C(...L.garb), robeOn: !!L.robe, robeC: L.robe ? C(...L.robe) : null, mantleOn: !!L.mantle, mantleC: L.mantle ? C(...L.mantle) : null,
      armorOn: !!L.armor, armorC: L.armor ? C(...L.armor) : null, sigilC: L.sigil ? C(...L.sigil) : null, legC: C(...(L.legs || L.garb)),
      bow: 0,
    });
    c.person = p;
    c.extras = (L.extras || []).map((e) => {
      const m = new THREE.Mesh(e.geo, new THREE.MeshStandardMaterial({ color: new THREE.Color(...e.color), emissive: new THREE.Color(...(e.glow || [0, 0, 0])), roughness: 0.4, metalness: 0.5 }));
      m.matrixAutoUpdate = false;
      m.castShadow = true;
      m.userData.off = new THREE.Matrix4().compose(new THREE.Vector3(...(e.at || [0, 0, 0])), new THREE.Quaternion().setFromEuler(new THREE.Euler(...(e.rot || [0, 0, 0]))), new THREE.Vector3(1, 1, 1));
      m.userData.arm = e.arm;
      m.visible = false;
      this.city.root.add(m);
      return m;
    });
    return p;
  }

  createMeshes() {
    const g = makeGeometry(), U = this.city.U, N = this.list.length;
    const mat = folkMaterial(U, THREE.FrontSide), mat2 = folkMaterial(U, THREE.DoubleSide);
    const sigMat = new THREE.MeshBasicMaterial({ toneMapped: false });
    sigMat.onBeforeCompile = (s) => curvePatch(s, U);
    const mk = (geo, n, m = mat, shadow = true) => {
      const im = new THREE.InstancedMesh(geo, m, n);
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.frustumCulled = false;
      im.castShadow = shadow;
      im.count = 0;
      this.city.root.add(im);
      return im;
    };
    this.M = {
      torso: mk(g.torso, N), robe: mk(g.robe, N), mantle: mk(g.mantle, N, mat2), armor: mk(g.armor, N), legs: mk(g.leg, N * 2),
      arms: mk(g.arm, N * 2), head: mk(g.head, N), hairShort: mk(g.hairShort, N), hairLong: mk(g.hairLong, N), hairTail: mk(g.hairTail, N),
      beard: mk(g.beard, N, mat, false), sigil: mk(g.sigil, N, sigMat, false),
    };
  }

  // ---------------------------------------------------------------- поведение
  // h — герой в кадре города; won — Ксарг побеждён; talkTo — с кем идёт разговор
  update(dt, h, hv, grounded, won, talkTo) {
    this.t += dt;
    const R = this.rnd, near = 42;
    for (const p of this.list) {
      const dx = h.x - p.x, dz = h.z - p.z, dh = Math.hypot(dx, dz), dy = h.y - p.y;
      // Заметили героя: он рядом и невысоко
      const close = dh < near && dy > -6 && dy < 35 && p.mode !== 'fly';
      if (close && !p.noticed) {
        p.noticed = true;
        p.react = this.choose(p, won, R());
        p.reactT = 0;
      } else if (!close && p.noticed && dh > near + 25) { p.noticed = false; p.react = ''; }
      if (p.npc) p.react = dh < 16 || p.npc === talkTo ? 'watch' : '';
      p.reactT += dt;
      const faceYaw = Math.atan2(dx, dz);

      if (p.stag > 0) {
        p.stag -= dt;
        p.x += p.sx * dt; p.z += p.sz * dt;
        p.sx = damp(p.sx, 0, 3, dt); p.sz = damp(p.sz, 0, 3, dt);
        p.armL = damp(p.armL, -1.4, 10, dt); p.armR = damp(p.armR, -1.4, 10, dt);
        p.bow = damp(p.bow, -0.25, 8, dt);
        if (p.groundY === undefined && p.mode === 'walk') p.y = this.city.ground(p.x, p.z);
        continue;
      }

      if (p.mode === 'fly') { this.fly(p, dt, h, dh); continue; }

      let walking = false, wantBow = 0, armR = 0, armL = 0, armRz = 0, turnTo = null;
      if (p.react) {
        const t = p.reactT;
        if (p.react === 'back') {
          if (t < 4) {
            _v.set(-dx, 0, -dz).normalize();
            p.x += _v.x * 1.7 * dt; p.z += _v.z * 1.7 * dt;
            turnTo = Math.atan2(_v.x, _v.z);
            walking = true;
          } else turnTo = faceYaw;
        } else if (p.react === 'turn') turnTo = faceYaw + Math.PI;
        else {
          turnTo = faceYaw;
          if (p.react === 'bow' && t > 0.5 && t < 3.2) wantBow = 0.6;
          if (p.react === 'salute' && t > 0.3 && t < 3) { armR = -1.05; armRz = 0.95; }
          if (p.react === 'cheer' && t > 0.4 && t < 2.6) armR = -2.9 + Math.sin(t * 7) * 0.15;
        }
        if (p.npc && p.npc === talkTo) { armR = -0.45 + Math.sin(this.t * 2.6) * 0.25; armL = -0.15 + Math.sin(this.t * 1.7 + 1) * 0.12; }
      } else if (p.mode === 'walk') {
        // Идёт к своей точке, постоит — и к следующей
        const tx = p.tx - p.x, tz = p.tz - p.z, d = Math.hypot(tx, tz);
        if (d < 1.5) {
          p.wait -= dt;
          if (p.wait <= 0) { [p.tx, p.tz] = p.home(); p.wait = 1.5 + R() * 6; }
        } else {
          const sp = p.speed * (p.slow ? 0.65 : 1);
          p.x += tx / d * sp * dt; p.z += tz / d * sp * dt;
          turnTo = Math.atan2(tx, tz);
          walking = true;
        }
      } else if (p.spar >= 0) {
        // Стража на песке Арены отрабатывает удары парами
        const s = Math.sin(this.t * 3.1 + p.spar * 1.7);
        armR = s > 0.4 ? -1.5 : -0.4; armL = s < -0.4 ? -1.5 : -0.4;
      } else if (p.mourn) wantBow = 0.22;
      if (p.mode === 'walk' && p.groundY === undefined) p.y = this.city.ground(p.x, p.z);
      if (turnTo !== null) {
        let d = turnTo - p.yaw;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        p.yaw += d * Math.min(1, dt * 5);
      } else if (p.mode === 'stand' && !p.npc) {
        let d = p.yaw0 - p.yaw;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        p.yaw += d * Math.min(1, dt * 2);
      }
      // Голова — на героя, если он рядом и не за спиной
      let hy = 0, lp = 0;
      if (p.noticed || (p.npc && dh < 30)) {
        let d = faceYaw - p.yaw;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        if (Math.abs(d) < 1.9) { hy = Math.max(-1, Math.min(1, d)); lp = Math.max(-0.5, Math.min(0.85, Math.atan2(dy + 0.2, dh + 0.5))); }
      }
      p.headYaw = damp(p.headYaw, hy, 6, dt);
      p.look = damp(p.look, lp, 6, dt);
      if (walking) p.phase += dt * 6.2 * (p.slow ? 0.7 : 1);
      p.v = damp(p.v, walking ? 1 : 0, 6, dt);
      p.bow = damp(p.bow, wantBow, 4, dt);
      const sw = Math.sin(p.phase) * 0.55 * p.v;
      p.armR = damp(p.armR, armR || sw * 0.6, 8, dt);
      p.armL = damp(p.armL, armL || -sw * 0.6, 8, dt);
      p.armRz = damp(p.armRz, armRz, 8, dt);
    }
  }

  choose(p, won, r) {
    if (p.npc) return 'watch';
    if (p.type === 'guard') return won ? 'salute' : 'watch';
    if (p.type === 'wingless') return won ? (r < 0.45 ? 'cheer' : 'watch') : (r < 0.25 ? 'cheer' : 'watch');
    if (p.seat) return 'watch';
    return won ? (r < 0.35 ? 'bow' : r < 0.75 ? 'watch' : r < 0.9 ? 'back' : 'turn') : (r < 0.6 ? 'watch' : r < 0.9 ? 'back' : 'bow');
  }

  // Полёт: от точки к точке на своей высоте; герою уступают дорогу
  fly(p, dt, h, dh) {
    const tx = p.tx - p.x, tz = p.tz - p.z, d = Math.hypot(tx, tz);
    if (d < 30) { [p.tx, p.tz] = p.home(); p.alt = 80 + this.rnd() * 320; }
    const want = Math.atan2(tx, tz);
    let dy = want - p.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    p.yaw += dy * Math.min(1, dt * 0.8);
    p.x += Math.sin(p.yaw) * p.speed * dt;
    p.z += Math.cos(p.yaw) * p.speed * dt;
    let ty = this.city.hC + p.alt;
    if (dh < 30 && Math.abs(h.y - p.y) < 20) ty += h.y > p.y ? -25 : 25;
    p.y = damp(p.y, ty, 1.2, dt);
    p.flyK = 1;
  }

  // Ударная волна рядом: не падают (сильные), но их отбрасывает на шаг и они закрываются руками
  impulse(c, r, force) {
    for (const p of this.list) {
      if (p.mode === 'fly') continue;
      const dx = p.x - c.x, dz = p.z - c.z, d = Math.hypot(dx, dz);
      if (d > r || Math.abs(p.y - c.y) > r) continue;
      const k = Math.min(9, force * (1 - d / r) * 0.12) / Math.max(d, 1);
      p.sx = dx * k; p.sz = dz * k;
      p.stag = 1.2 + Math.random() * 0.6;
      p.noticed = false;
    }
  }

  // Ближайший к точке житель (не летающий, не именной) в радиусе r
  nearest(x, z, r, y) {
    let best = null, bd = r;
    for (const p of this.list) {
      if (p.mode === 'fly' || p.npc) continue;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bd && Math.abs(p.y - y) < 4) { bd = d; best = p; }
    }
    return best;
  }

  // Голова персонажа в мире (для кадра разговора)
  headOf(p, out) {
    return this.city.toWorld(out.set(p.x, p.y + NECK * p.h + 0.16, p.z), out);
  }

  // ---------------------------------------------------------------- отрисовка
  draw(camera) {
    const M = this.M, cam = this.city.toCity(camera.position, _w), root = this.city.root.position;
    _pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _fr.setFromProjectionMatrix(_pv);
    const n = {};
    for (const k in M) n[k] = 0;
    const put = (k, m, c) => { const im = M[k], i = n[k]++; im.setMatrixAt(i, m); if (c) im.setColorAt(i, c); };
    for (const p of this.list) {
      const dc = Math.hypot(p.x - cam.x, p.y - cam.y, p.z - cam.z);
      p.vis = false;
      // Именной персонаж во плоти (persona.js) рисуется там
      if (dc > DRAW_R || p.npc?.persona) { this.hideExtras(p); continue; }
      _sph.center.set(p.x + root.x, p.y + 1 + root.y, p.z + root.z);
      if (dc > 8 && !_fr.intersectsSphere(_sph)) { this.hideExtras(p); continue; }
      p.vis = true;
      const far = dc > 110;
      // Тело: у летящего — горизонтально, головой вперёд
      _q.setFromAxisAngle(UP, p.yaw);
      _m.compose(_v.set(p.x, p.y, p.z), _q, _s.set(p.h, p.h, p.h));
      if (p.mode === 'fly') _m.multiply(_t.makeTranslation(0, 1, 0)).multiply(_h.makeRotationX(1.35)).multiply(_t.makeTranslation(0, -1, 0));
      // Верх тела наклоняется в поклоне от бедра
      _u.copy(_m);
      if (Math.abs(p.bow) > 0.01) _u.multiply(_t.makeTranslation(0, HIP, 0)).multiply(_h.makeRotationX(p.bow)).multiply(_t.makeTranslation(0, -HIP, 0));
      put('torso', _u, p.garb);
      if (p.robeOn) put('robe', _m, p.robeC);
      if (p.mantleOn) put('mantle', _u, p.mantleC);
      if (p.armorOn) put('armor', _u, p.armorC);
      if (p.sigilC && !far) put('sigil', _u, p.sigilC);
      // Ноги: шаг; в полёте — вместе, чуть назад
      const sw = p.mode === 'fly' ? 0.08 : Math.sin(p.phase) * 0.5 * p.v;
      for (const side of [1, -1]) {
        _h.compose(_v.set(side * 0.1, HIP, 0), _q2.setFromAxisAngle(RX, sw * side), _s.set(1, 1, 1));
        put('legs', _t.multiplyMatrices(_m, _h), p.legC);
      }
      // Голова: поворот на героя и наклон
      _e.set(-p.look, p.headYaw, 0, 'YXZ');
      _h.compose(_v.set(0, NECK, 0), _q2.setFromEuler(_e), _s.set(1, 1, 1));
      _t.multiplyMatrices(_u, _h);
      put('head', _t, p.skin);
      if (!far) {
        if (p.hair === 'short') put('hairShort', _t, p.hairC);
        else if (p.hair === 'long') put('hairLong', _t, p.hairC);
        else if (p.hair === 'tail') put('hairTail', _t, p.hairC);
        if (p.beard) put('beard', _t, p.hairC);
      }
      // Руки: размах, жесты; в полёте — вдоль тела
      for (const side of [1, -1]) {
        const rx = p.mode === 'fly' ? 0.25 : side > 0 ? p.armL : p.armR, rz = (side < 0 ? p.armRz : 0) + side * 0.06;
        _e.set(rx, 0, rz, 'XYZ');
        _h.compose(_v.set(side * 0.215, SHOULDER, 0), _q2.setFromEuler(_e), _s.set(1, 1, 1));
        const am = _t.multiplyMatrices(_u, _h);
        put('arms', am, p.garb);
        if (p.npc) this.placeExtras(p, _u, am, side);
      }
      if (p.npc) for (const e of p.npc.extras) if (!e.userData.arm) { e.matrix.multiplyMatrices(_u, e.userData.off); e.visible = true; }
    }
    for (const k in M) {
      M[k].count = n[k];
      M[k].instanceMatrix.needsUpdate = true;
      if (M[k].instanceColor) M[k].instanceColor.needsUpdate = true;
    }
  }

  // Вещь в руке (посох, кристалл) — за кистью; side −1 — правая
  placeExtras(p, u, arm, side) {
    for (const e of p.npc.extras) {
      if (e.userData.arm !== (side < 0 ? 'R' : 'L')) continue;
      e.matrix.multiplyMatrices(arm, e.userData.off);
      e.visible = true;
    }
  }

  hideExtras(p) { if (p.npc) for (const e of p.npc.extras) e.visible = false; }

  get drawn() { return this.M ? this.M.torso.count : 0; }

  clear() {
    for (const p of this.list) { p.react = ''; p.noticed = false; p.stag = 0; }
  }

  get inCity() { return R_CITY; }
}
