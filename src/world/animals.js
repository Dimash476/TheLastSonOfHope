import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CITY, DEBRIS } from '../config.js';
import { HALF, BLOCK, blockAt, inSleeper } from './layout.js';

// Собаки и кошки.
// Собаки: гуляют с хозяевами на поводке или свободно бегают в парках, у домов пригорода
// и во дворах спального района; когда герой
// приземлился и стоит — подбегают, прыгают, виляют хвостом и лают.
// Кошки: сидят, умываются, гуляют; убегают, если герой подходит близко или пролетает.
// Ударная волна подбрасывает их (без жестокости — встают и бегут).

const DOGS = 96, CATS = 90, LEASHED = 50;
// Окрасы: основной цвет c, второй c2 и узор pat
// собаки: 0 — однотонный, 1 — светлые грудь/живот/морда/лапы, 2 — пятна, 3 — тёмный «чепрак» на спине
// кошки: 0 — однотонная, 1 — полосатая (табби), 2 — «смокинг» (белая грудь и носочки), 3 — трёхцветная
const DOG_BREEDS = [
  { c: 0xc8913f, c2: 0xf0e2c4, pat: 1, ears: 'F' },
  { c: 0x1c1a19, c2: 0xa8652a, pat: 1, ears: 'P' },
  { c: 0xf2efe8, c2: 0x26201c, pat: 2, ears: 'F' },
  { c: 0x9a6a38, c2: 0x1c1612, pat: 3, ears: 'P' },
  { c: 0x6e6e6c, c2: 0xece8e0, pat: 1, ears: 'P' },
  { c: 0x5a3a22, c2: 0x5a3a22, pat: 0, ears: 'F' },
  { c: 0xe0d0b0, c2: 0x7a5232, pat: 2, ears: 'F' },
  { c: 0x2a2624, c2: 0xf0ece4, pat: 1, ears: 'F' },
];
const CAT_COATS = [
  { c: 0xd88a42, c2: 0x8a4a1a, pat: 1 },
  { c: 0x9a9a94, c2: 0x3a3a38, pat: 1 },
  { c: 0x222120, c2: 0xf0ece4, pat: 2 },
  { c: 0xf0ece0, c2: 0xf0ece0, pat: 0 },
  { c: 0x7a5a3a, c2: 0x2a1c12, pat: 1 },
  { c: 0xf0ece4, c2: 0xd07a30, pat: 3 },
  { c: 0x1e1d1c, c2: 0x1e1d1c, pat: 0 },
  { c: 0x8a8a8a, c2: 0xf0ece4, pat: 2 },
];
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const UP = new THREE.Vector3(0, 1, 0);
const FWD = new THREE.Vector3(0, 0, 1);

export class Animals {
  constructor(scene, world) {
    this.world = world;
    this.t = 0;
    const G = makeGeometries();
    const mk = (geo, n, shadow = false, kind = 'dog', part = 0) => {
      geo.setAttribute('coat', new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4));
      const m = new THREE.InstancedMesh(geo, createAnimalMaterial(kind === 'cat', part), n);
      m.castShadow = shadow;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3);
      m.frustumCulled = false;
      scene.add(m);
      return m;
    };
    this.meshes = {
      // Тень отбрасывает только туловище собаки (лапы, хвосты и кошки — без теней: дешевле)
      dog: {
        body: mk(G.dogBody, DOGS, true), legs: mk(G.dogLeg, DOGS * 4, false, 'dog', 1), tail: mk(G.dogTail, DOGS, false, 'dog', 2),
        earsF: mk(G.dogEarsF, DOGS), earsP: mk(G.dogEarsP, DOGS), tongue: mk(G.dogTongue, DOGS),
      },
      cat: { body: mk(G.catBody, CATS, false, 'cat'), legs: mk(G.catLeg, CATS * 4, false, 'cat', 1), tail: mk(G.catTail, CATS, false, 'cat', 2) },
    };
    // Поводки: тонкие цилиндры длиной 1 вдоль +Z, растягиваются от руки хозяина к ошейнику
    this.leash = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.008, 0.008, 1, 4, 1, true).translate(0, 0.5, 0).rotateX(Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x2a2018 }), LEASHED);
    this.leash.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.leash.frustumCulled = false;
    scene.add(this.leash);

    this.createHearts(scene);
    // Теннисный мяч для игры с собакой
    const bm = new THREE.Mesh(new THREE.SphereGeometry(0.065, 12, 8), new THREE.MeshStandardMaterial({ color: 0xc8e04a, roughness: 0.7 }));
    bm.castShadow = true;
    bm.visible = false;
    scene.add(bm);
    this.ball = { mesh: bm, pos: new THREE.Vector3(), vel: new THREE.Vector3(), state: 'none', dog: null, spin: 0 };
    this.list = [];
    const add = (kind, i, coats) => {
      const big = kind === 'dog' ? [0.65, 0.85, 1.0, 1.15, 1.3][Math.floor(Math.random() * 5)] : 0.9 + Math.random() * 0.2;
      const a = {
        kind, slot: i, state: 'none', pos: new THREE.Vector3(), vel: new THREE.Vector3(), target: new THREE.Vector3(),
        heading: Math.random() * 6.28, phase: Math.random() * 6, speed: 0, size: big, timer: 0, owner: null,
        leashed: kind === 'dog' && i < LEASHED, wag: 0, sit: 0, jump: 0, ang: new THREE.Vector3(), quat: new THREE.Quaternion(), barkT: 0,
      };
      const coat = coats[Math.floor(Math.random() * coats.length)];
      const c = new THREE.Color(coat.c), c2 = new THREE.Color(coat.c2);
      a.ears = coat.ears;
      const M = this.meshes[kind];
      const paint = (mesh, idx) => {
        mesh.setColorAt(idx, c);
        mesh.geometry.attributes.coat.setXYZW(idx, c2.r, c2.g, c2.b, coat.pat);
      };
      paint(M.body, i); paint(M.tail, i);
      for (let k = 0; k < 4; k++) paint(M.legs, i * 4 + k);
      if (kind === 'dog') { paint(M.earsF, i); paint(M.earsP, i); }
      this.list.push(a);
    };
    for (let i = 0; i < DOGS; i++) add('dog', i, DOG_BREEDS);
    for (let i = 0; i < CATS; i++) add('cat', i, CAT_COATS);
  }

  // ---------------------------------------------------------------- появление
  spawn(a, focus) {
    const W = this.world;
    if (a.leashed) {
      // Хозяин — прохожий рядом, у которого ещё нет собаки
      const people = W.people.list;
      for (let k = 0; k < 12; k++) {
        const p = people[Math.floor(Math.random() * people.length)];
        if (p.state !== 'walk' || p.dog || p.pos.distanceTo(focus) > 300) continue;
        p.dog = a; a.owner = p;
        a.pos.copy(p.pos); a.state = 'walkies';
        return;
      }
      return;
    }
    for (let k = 0; k < 10; k++) {
      const ang = Math.random() * 6.28, r = 30 + Math.random() * 250;
      const x = focus.x + Math.cos(ang) * r, z = focus.z + Math.sin(ang) * r;
      const t = blockAt(x, z);
      if (a.kind === 'dog' && t !== BLOCK.PARK && t !== BLOCK.BIGPARK && t !== BLOCK.BEACH && t !== BLOCK.SUBURB && !(t === BLOCK.URBAN && inSleeper(x, z))) continue;
      if (a.kind === 'cat' && t !== BLOCK.URBAN && t !== BLOCK.SUBURB && t !== BLOCK.PARK) continue;
      // Кошки — у стен на тротуаре: прижимаемся к краю квартала
      let px = x, pz = z;
      if (a.kind === 'cat') {
        const lx = ((x + HALF) % CITY.block), lz = ((z + HALF) % CITY.block);
        if (Math.random() < 0.5) px = x - lx + (lx < 50 ? 11.5 : CITY.block - 11.5); else pz = z - lz + (lz < 50 ? 11.5 : CITY.block - 11.5);
      } else if (t === BLOCK.URBAN) {
        // Собака спального района — во дворе, у центра квартала
        const lx = ((x + HALF) % CITY.block), lz = ((z + HALF) % CITY.block);
        px = x - lx + CITY.block / 2 + (Math.random() - 0.5) * 30; pz = z - lz + CITY.block / 2 + (Math.random() - 0.5) * 30;
      }
      if (W.city.segAt(_v.set(px, 0.5, pz), 0.5)) continue;
      a.pos.set(px, W.city.groundHeightAt(px, pz, 2), pz);
      a.home = a.pos.clone();
      a.state = a.kind === 'dog' ? 'roam' : 'sit';
      a.target.copy(a.pos);
      a.timer = 2 + Math.random() * 6;
      return;
    }
  }

  // ---------------------------------------------------------------- ласка
  // Ближайшее спокойное животное рядом с героем (кого можно погладить)
  findPettable(pos, r) {
    let best = null, bd = r;
    for (const a of this.list) {
      if (a.state !== 'walkies' && a.state !== 'roam' && a.state !== 'greet' && a.state !== 'sit' && a.state !== 'walk') continue;
      const d = Math.hypot(a.pos.x - pos.x, a.pos.z - pos.z);
      if (d < bd && Math.abs(a.pos.y - pos.y) < 1.2) { bd = d; best = a; }
    }
    return best;
  }

  // ---------------------------------------------------------------- игра с мячом
  // Свободная собака рядом, которой можно бросить мяч
  findDogForBall(pos, r) {
    const b = this.ball;
    if (b.state === 'fly' || b.state === 'mouth') return null;
    let best = null, bd = r;
    for (const a of this.list) {
      if (a.kind !== 'dog' || a.leashed || (a.state !== 'greet' && a.state !== 'roam')) continue;
      const d = Math.hypot(a.pos.x - pos.x, a.pos.z - pos.z);
      if (d < bd) { bd = d; best = a; }
    }
    return best;
  }

  // Мяч летит по дуге; все свободные собаки рядом бросаются за ним
  throwBall(from, dir) {
    const b = this.ball;
    b.state = 'fly';
    b.pos.copy(from);
    b.vel.copy(dir).setY(0).normalize().multiplyScalar(15).add(_v.set(0, 6.5, 0));
    b.dog = null;
    for (const a of this.list) {
      if (a.kind !== 'dog' || a.leashed || (a.state !== 'greet' && a.state !== 'roam' && a.state !== 'sit')) continue;
      if (a.pos.distanceTo(from) > 25) continue;
      a.state = 'fetch'; a.fetch = 1; a.fetchT = 0;
      if (Math.random() < 0.5) this.world.soundscape?.bark(a.pos.clone(), a.size);
    }
  }

  dropBall(a) {
    const b = this.ball;
    b.state = 'ground'; b.dog = null; b.vel.set(0, 0, 0);
    b.pos.set(a.pos.x + Math.sin(a.heading) * 0.5 * a.size, 0, a.pos.z + Math.cos(a.heading) * 0.5 * a.size);
    b.pos.y = this.world.city.groundHeightAt(b.pos.x, b.pos.z, a.pos.y + 1) + 0.065;
  }

  updateBall(dt, focus) {
    const b = this.ball, W = this.world;
    if (b.state === 'none') { b.mesh.visible = false; return; }
    if (b.state === 'fly') {
      b.vel.y -= 9.8 * dt;
      b.pos.addScaledVector(b.vel, dt);
      if (W.city.segAt(_v.copy(b.pos), 0.1)) { b.vel.x *= -0.5; b.vel.z *= -0.5; b.pos.addScaledVector(b.vel, dt * 2); }
      const gy = W.city.groundHeightAt(b.pos.x, b.pos.z, b.pos.y + 0.5) + 0.065;
      if (b.pos.y < gy) {
        b.pos.y = gy;
        if (b.vel.y < -1.5) {
          W.soundscape?.ballBounce?.(b.pos.clone(), Math.min(1, -b.vel.y / 8));
          b.vel.y *= -0.55; b.vel.x *= 0.75; b.vel.z *= 0.75;
        } else {
          b.vel.y = 0;
          const f = Math.max(0, 1 - dt * 2.5);
          b.vel.x *= f; b.vel.z *= f;
          if (Math.hypot(b.vel.x, b.vel.z) < 0.15) b.state = 'ground';
        }
      }
      b.spin += Math.hypot(b.vel.x, b.vel.z) * dt * 15;
    } else if (b.state === 'mouth') {
      const a = b.dog, s = a.size;
      b.pos.set(a.pos.x + Math.sin(a.heading) * 0.6 * s, a.pos.y + 0.68 * s + a.jump, a.pos.z + Math.cos(a.heading) * 0.6 * s);
    }
    if (b.pos.distanceTo(focus) > 150) b.state = 'none';
    b.mesh.visible = b.state !== 'none';
    b.mesh.position.copy(b.pos);
    b.mesh.rotation.x = b.spin;
  }

  // Герой гладит: животное садится, радуется; над ним сердечки
  pet(a, dt) {
    a.petT = 0.25;
    // Поглаженная кошка ещё долго ходит за героем и трётся о ноги
    if (a.kind === 'cat') { a.petSum = (a.petSum || 0) + dt; if (a.petSum > 1.2) a.followT = 45; }
    a.heartT = (a.heartT || 0) - dt;
    if (a.heartT <= 0) {
      a.heartT = 0.45;
      this.spawnHeart(a.pos.x + (Math.random() - 0.5) * 0.3, a.pos.y + 0.75 * a.size, a.pos.z + (Math.random() - 0.5) * 0.3);
    }
    if (a.owner) a.owner.waitT = 0.6; // хозяин ждёт
    this.petted = a;
  }

  createHearts(scene) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#ff4d6d';
    g.beginPath();
    g.moveTo(32, 54);
    g.bezierCurveTo(4, 34, 6, 10, 22, 10);
    g.bezierCurveTo(28, 10, 32, 16, 32, 20);
    g.bezierCurveTo(32, 16, 36, 10, 42, 10);
    g.bezierCurveTo(58, 10, 60, 34, 32, 54);
    g.fill();
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.hearts = [];
    for (let i = 0; i < 24; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0 }));
      s.visible = false;
      scene.add(s);
      this.hearts.push({ s, t: 1 });
    }
  }

  spawnHeart(x, y, z) {
    const h = this.hearts.find((q) => q.t >= 1) || this.hearts[0];
    h.t = 0;
    h.s.position.set(x, y, z);
    h.vx = (Math.random() - 0.5) * 0.3;
    h.s.visible = true;
  }

  updateHearts(dt) {
    for (const h of this.hearts) {
      if (h.t >= 1) continue;
      h.t = Math.min(1, h.t + dt / 1.5);
      h.s.position.y += dt * 0.7;
      h.s.position.x += h.vx * dt;
      h.s.scale.setScalar(0.18 + h.t * 0.18);
      h.s.material.opacity = Math.sin(Math.PI * Math.min(1, h.t * 1.3));
      if (h.t >= 1) h.s.visible = false;
    }
  }

  // ---------------------------------------------------------------- события
  knock(a, vel) {
    a.state = 'fly';
    a.vel.copy(vel);
    a.ang.set((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 8);
    a.quat.setFromAxisAngle(UP, a.heading);
    if (a.owner) { a.owner.dog = null; a.owner = null; }
  }

  scare(a, from, t = 4) {
    if (a.state === 'fly' || a.state === 'down' || a.state === 'none') return;
    if (a.owner) return; // на поводке — только лает
    a.state = 'flee';
    a.from = from.clone();
    a.timer = t + Math.random() * 2;
  }

  impulse(center, radius, force) {
    for (const a of this.list) {
      if (a.state === 'none') continue;
      const d = a.pos.distanceTo(center);
      if (d < radius) {
        const f = Math.min(30, force * (1 - d / radius));
        const dir = _v.subVectors(a.pos, center).setY(0);
        if (dir.lengthSq() < 0.01) dir.set(1, 0, 0);
        dir.normalize();
        if (f > 3) this.knock(a, new THREE.Vector3(dir.x * f, f * 0.5 + 3, dir.z * f));
        else if (force > 8) this.scare(a, center);
      } else if (force > 25 && d < radius * 3 + 40) this.scare(a, center);
    }
  }

  // ---------------------------------------------------------------- кадр
  update(dt, player) {
    this.t += dt;
    const W = this.world, city = W.city, focus = player.pos;
    const inGrid = Math.abs(focus.x) < HALF + 300 && Math.abs(focus.z) < HALF + 300 && focus.y < 1500;
    const pSpeed = player.vel.length();
    const heroCalm = W.people.heroCalm > 1.0;
    let leashN = 0;
    this.rubbing = null;
    this.updateBall(dt, focus);

    for (const a of this.list) {
      const M = this.meshes[a.kind];
      if (a.state === 'none') {
        if (inGrid && Math.random() < 0.03) this.spawn(a, focus);
        if (a.state === 'none') { this.hide(a); continue; }
      }
      const dist = a.pos.distanceTo(focus);
      if (!inGrid || dist > 380 || (a.owner && a.owner.state === 'none')) {
        if (a.owner) { a.owner.dog = null; a.owner = null; }
        a.state = 'none'; this.hide(a); continue;
      }
      const flat = Math.hypot(focus.x - a.pos.x, focus.z - a.pos.z);
      let want = 0, wagT = 0.4, sitT = 0;
      // Гладят: сидим, смотрим на героя, собака радостно виляет хвостом
      if (a.petT > 0) {
        a.petT -= dt;
        a.speed = 0;
        const h = Math.atan2(focus.x - a.pos.x, focus.z - a.pos.z);
        a.heading += Math.atan2(Math.sin(h - a.heading), Math.cos(h - a.heading)) * Math.min(1, dt * 5);
        a.wag += (1.4 - a.wag) * Math.min(1, dt * 4);
        a.sit += (1 - a.sit) * Math.min(1, dt * 4);
        a.pos.y = city.groundHeightAt(a.pos.x, a.pos.z, a.pos.y + 1);
        if (a.kind === 'dog' && Math.random() < dt * 0.5) W.soundscape?.whine?.(a.pos.clone());
        this.write(a, 0, a.sit, 0, false);
        continue;
      }

      // Реакции на героя
      // Кошка убегает от быстрого героя; к спокойно подошедшему — можно подойти и погладить
      if (a.kind === 'cat' && !(a.petT > 0) && (a.state === 'sit' || a.state === 'walk') &&
          ((flat < 8 && pSpeed > 16) || (flat < 30 && pSpeed > 40) || (!player.grounded && flat < 12 && pSpeed > 10))) {
        this.scare(a, focus, 4);
        // Голос — редко и только если герой совсем рядом (иначе пролёт над улицей — сплошное «мяу»)
        if (flat < 15 && Math.random() < 0.25 && this.t - (this.lastMeow || -9) > 2) { this.lastMeow = this.t; W.soundscape?.meow(a.pos.clone(), true); }
      }
      if (a.kind === 'dog' && !a.owner && (a.state === 'roam') && heroCalm && flat < 40) a.state = 'greet';
      if (a.kind === 'cat' && a.followT > 0 && (a.state === 'sit' || a.state === 'walk')) a.state = 'follow';

      if (a.state === 'walkies') {
        // Идём рядом с хозяином, чуть справа и сзади
        const o = a.owner;
        const fx = Math.sin(o.heading), fz = Math.cos(o.heading);
        a.target.set(o.pos.x - fz * 1.2 - fx * 0.9, 0, o.pos.z + fx * 1.2 - fz * 0.9);
        want = Math.min(4.5, a.pos.distanceTo(_v.copy(a.target).setY(a.pos.y)) * 2.2);
        if (heroCalm && flat < 25) { wagT = 1; if (Math.random() < dt * 0.7) W.soundscape?.bark(a.pos.clone(), a.size); }
        // Поводок: рука хозяина → ошейник
        if (leashN < LEASHED && a.pos.distanceTo(o.pos) < 4) {
          const h = o.h || 1;
          _v.set(o.pos.x - fz * 0.28, o.pos.y + 0.85 * h, o.pos.z + fx * 0.28);
          _v2.set(a.pos.x + Math.sin(a.heading) * 0.35 * a.size, a.pos.y + 0.45 * a.size, a.pos.z + Math.cos(a.heading) * 0.35 * a.size);
          const len = _v.distanceTo(_v2);
          _q.setFromUnitVectors(FWD, _v2.sub(_v).normalize());
          this.leash.setMatrixAt(leashN++, _m.compose(_v, _q, _s.set(1, 1, len)));
        }
      } else if (a.state === 'roam') {
        a.timer -= dt;
        if (a.timer <= 0) {
          a.timer = 2 + Math.random() * 5;
          const r = Math.random() < 0.3 ? 0 : 6 + Math.random() * 20, an = Math.random() * 6.28;
          a.target.set(a.home.x + Math.cos(an) * r, 0, a.home.z + Math.sin(an) * r);
          a.run = Math.random() < 0.4;
        }
        const d = Math.hypot(a.target.x - a.pos.x, a.target.z - a.pos.z);
        want = d > 0.5 ? (a.run ? 5.5 : 1.8) : 0;
        if (want === 0) sitT = 1;
      } else if (a.state === 'greet') {
        // Подбегает к герою, прыгает и лает
        const ang = Math.atan2(a.pos.x - focus.x, a.pos.z - focus.z);
        a.target.set(focus.x + Math.sin(ang) * 1.8, 0, focus.z + Math.cos(ang) * 1.8);
        const d = Math.hypot(a.target.x - a.pos.x, a.target.z - a.pos.z);
        want = d > 0.4 ? Math.min(7, d * 2) : 0;
        wagT = 1;
        if (d < 1) { a.jump = Math.max(a.jump, Math.abs(Math.sin(this.t * 5 + a.slot)) * 0.25); a.target.set(focus.x, 0, focus.z); }
        a.barkT -= dt;
        if (a.barkT <= 0) { a.barkT = 0.8 + Math.random() * 2; W.soundscape?.bark(a.pos.clone(), a.size); }
        if (!heroCalm || flat > 60) { a.state = 'roam'; a.home = a.pos.clone(); }
      } else if (a.state === 'fetch') {
        // Мчится за мячом; первая добежавшая хватает его
        const b = this.ball;
        a.fetchT += dt;
        if (b.state === 'none' || b.state === 'mouth' || a.fetchT > 20) { a.state = 'roam'; a.home = a.pos.clone(); a.fetch = 0; a.timer = 0; }
        else {
          a.target.set(b.pos.x, 0, b.pos.z);
          const d = Math.hypot(b.pos.x - a.pos.x, b.pos.z - a.pos.z);
          want = Math.min(8.5, 2 + d * 1.6);
          wagT = 1;
          if (d < 0.45 * a.size + 0.25 && b.pos.y < a.pos.y + 0.8 * a.size) {
            b.state = 'mouth'; b.dog = a; a.state = 'return';
            for (const o of this.list) if (o !== a && o.state === 'fetch') { o.state = 'greet'; o.fetch = 0; }
          }
        }
      } else if (a.state === 'return') {
        // Несёт мяч герою, кладёт у ног и ждёт, подпрыгивая, нового броска
        const ang = Math.atan2(a.pos.x - focus.x, a.pos.z - focus.z);
        a.target.set(focus.x + Math.sin(ang) * 1.1, 0, focus.z + Math.cos(ang) * 1.1);
        const d = Math.hypot(a.target.x - a.pos.x, a.target.z - a.pos.z);
        want = d > 0.3 ? Math.min(6.5, d * 2.5) : 0;
        wagT = 1.3;
        if (d < 0.45 || (!player.grounded && flat > 40)) {
          this.dropBall(a);
          a.state = 'greet'; a.fetch = 0; a.jump = 0.3;
          this.spawnHeart(a.pos.x, a.pos.y + 0.8 * a.size, a.pos.z);
          W.soundscape?.bark(a.pos.clone(), a.size);
        }
      } else if (a.state === 'follow') {
        // Кошка после ласки: идёт за героем, а когда он стоит — трётся о ноги, хвост трубой
        a.followT -= dt;
        if (pSpeed > 1.5) {
          const ang = Math.atan2(a.pos.x - focus.x, a.pos.z - focus.z);
          a.target.set(focus.x + Math.sin(ang) * 1.2, 0, focus.z + Math.cos(ang) * 1.2);
          const d = Math.hypot(a.target.x - a.pos.x, a.target.z - a.pos.z);
          want = d > 0.3 ? Math.min(7, d * 2.2) : 0;
        } else {
          const ang = this.t * 0.9 + a.slot;
          a.target.set(focus.x + Math.sin(ang) * 0.48, 0, focus.z + Math.cos(ang) * 0.48);
          want = 0.8;
          if (flat < 0.9) this.rubbing = a;
          if (Math.random() < dt * 0.12) W.soundscape?.meow(a.pos.clone());
        }
        if (a.followT <= 0 || (!player.grounded && flat > 25) || flat > 60) { a.state = 'sit'; a.followT = 0; a.petSum = 0; a.timer = 5; a.home = a.pos.clone(); }
      } else if (a.state === 'sit') {
        sitT = 1;
        a.timer -= dt;
        if (a.timer <= 0) {
          a.timer = 4 + Math.random() * 8;
          if (Math.random() < 0.4) {
            a.state = 'walk';
            const an = Math.random() * 6.28, r = 3 + Math.random() * 10;
            a.target.set(a.pos.x + Math.cos(an) * r, 0, a.pos.z + Math.sin(an) * r);
          } else if (Math.random() < 0.25 && dist < 60) W.soundscape?.meow(a.pos.clone());
        }
      } else if (a.state === 'walk') {
        const d = Math.hypot(a.target.x - a.pos.x, a.target.z - a.pos.z);
        want = 1.2;
        if (d < 0.5) { a.state = 'sit'; a.timer = 3 + Math.random() * 6; }
      } else if (a.state === 'flee') {
        a.timer -= dt;
        const awx = a.pos.x - a.from.x, awz = a.pos.z - a.from.z, al = Math.hypot(awx, awz) || 1;
        a.target.set(a.pos.x + awx / al * 5, 0, a.pos.z + awz / al * 5);
        want = a.kind === 'cat' ? 8 : 6;
        if (a.timer <= 0) { a.state = a.kind === 'cat' ? 'sit' : 'roam'; a.home = a.pos.clone(); a.timer = 3; }
      } else if (a.state === 'fly') {
        a.vel.y -= DEBRIS.gravity * 0.8 * dt;
        a.pos.addScaledVector(a.vel, dt);
        _e.set(a.ang.x * dt, a.ang.y * dt, a.ang.z * dt);
        a.quat.multiply(_q.setFromEuler(_e));
        const gy = city.groundHeightAt(a.pos.x, a.pos.z, a.pos.y + 0.5);
        if (a.pos.y <= gy) {
          a.pos.y = gy;
          if (Math.abs(a.vel.y) > 5) { a.vel.y *= -0.3; a.vel.x *= 0.6; a.vel.z *= 0.6; }
          else { a.state = 'down'; a.timer = 1.5 + Math.random() * 2; }
        }
        this.write(a, 0, 0, 0, true);
        continue;
      } else if (a.state === 'down') {
        a.timer -= dt;
        if (a.timer <= 0) { a.home = a.pos.clone(); a.state = a.kind === 'cat' ? 'sit' : 'roam'; this.scare(a, focus, 3); }
        this.write(a, 0, 0, 0, true);
        continue;
      }

      // Движение к цели, поворот, обход стен
      const tx = a.target.x - a.pos.x, tz = a.target.z - a.pos.z, td = Math.hypot(tx, tz);
      a.speed += (Math.min(want, td / Math.max(dt, 1e-3)) - a.speed) * Math.min(1, dt * 5);
      if (td > 0.05 && a.speed > 0.05) {
        const h = Math.atan2(tx, tz);
        const dh = Math.atan2(Math.sin(h - a.heading), Math.cos(h - a.heading));
        a.heading += dh * Math.min(1, dt * 8);
        const nx = a.pos.x + Math.sin(a.heading) * a.speed * dt, nz = a.pos.z + Math.cos(a.heading) * a.speed * dt;
        if (!city.segAt(_v.set(nx, a.pos.y + 0.4, nz), 0.3)) { a.pos.x = nx; a.pos.z = nz; }
        else { a.target.copy(a.pos); a.timer = 0; }
      } else if (a.state === 'greet' || a.state === 'sit') {
        // Стоим мордой к герою (собака) или куда смотрели (кошка)
        if (a.kind === 'dog') a.heading += Math.atan2(Math.sin(Math.atan2(focus.x - a.pos.x, focus.z - a.pos.z) - a.heading), Math.cos(Math.atan2(focus.x - a.pos.x, focus.z - a.pos.z) - a.heading)) * Math.min(1, dt * 5);
      }
      a.pos.y = city.groundHeightAt(a.pos.x, a.pos.z, a.pos.y + 1);
      a.phase += dt * (2 + a.speed * 3.2 / a.size);
      a.wag += (wagT - a.wag) * Math.min(1, dt * 3);
      a.sit += (sitT - a.sit) * Math.min(1, dt * 3);
      a.jump *= Math.max(0, 1 - dt * 6);
      this.write(a, Math.min(1, a.speed / 3), a.sit, a.jump, false);
    }
    this.leash.count = leashN;
    // Мурлыканье, пока гладят кошку
    const purr = this.petted && this.petted.kind === 'cat' && this.petted.petT > 0 ? this.petted : this.rubbing;
    W.soundscape?.setPurr?.(purr ? 1 : 0, purr ? purr.pos : null);
    this.petted = this.petted && this.petted.petT > 0 ? this.petted : null;
    this.updateHearts(dt);
    this.leash.instanceMatrix.needsUpdate = true;
    for (const k of ['dog', 'cat']) for (const m of Object.values(this.meshes[k])) m.instanceMatrix.needsUpdate = true;
  }

  // run — доля бега (размах лап), sit — поза сидя, jump — подскок
  write(a, run, sit, jump, tumbling) {
    const M = this.meshes[a.kind], s = a.size;
    if (tumbling) _q.copy(a.quat);
    else {
      _q.setFromAxisAngle(UP, a.heading);
      // Сидя корпус приподнят спереди
      _q.multiply(_q2.setFromAxisAngle(_v.set(1, 0, 0), -0.55 * sit));
    }
    _m.compose(_v.set(a.pos.x, a.pos.y + jump + 0.05 * sit * s, a.pos.z), _q, _s.setScalar(s));
    M.body.setMatrixAt(a.slot, _m);
    if (a.kind === 'dog') {
      M.earsF.setMatrixAt(a.slot, a.ears === 'F' ? _m : _zero);
      M.earsP.setMatrixAt(a.slot, a.ears === 'P' ? _m : _zero);
      // Язык наружу, когда собака радуется или запыхалась после бега
      a.pant = (a.pant || 0) + ((a.wag > 0.7 || a.speed > 3 || a.fetch ? 1 : 0) - (a.pant || 0)) * 0.05;
      if (a.pant > 0.3 && !tumbling) {
        _m2.makeTranslation(0, -0.006 * Math.abs(Math.sin(this.t * 14)), 0).premultiply(_m);
        M.tongue.setMatrixAt(a.slot, _m2);
      } else M.tongue.setMatrixAt(a.slot, _zero);
    }
    // Лапы: рысь (диагональные пары вместе); сидя — задние подогнуты
    const L = a.kind === 'dog' ? LEGS_DOG : LEGS_CAT;
    for (let k = 0; k < 4; k++) {
      const [lx, ly, lz] = L[k], front = lz > 0;
      const sw = Math.sin(a.phase + (k === 0 || k === 3 ? 0 : Math.PI)) * 0.6 * run;
      const fold = front ? 0.55 * sit : -1.3 * sit;
      _m2.compose(_v.set(lx, ly, lz), _q2.setFromAxisAngle(_v2.set(1, 0, 0), sw + fold), _one);
      M.legs.setMatrixAt(a.slot * 4 + k, _m2.premultiply(_m));
    }
    // Хвост: виляет (у собак — сильно, когда рада), у кошек — плавно качается
    const T = a.kind === 'dog' ? TAIL_DOG : TAIL_CAT;
    // Сидя кошка обвивает хвостом бок (хвост лежит на земле сбоку)
    const wag = a.kind === 'dog' ? Math.sin(this.t * (6 + a.wag * 12)) * (0.25 + a.wag * 0.6) : Math.sin(this.t * 1.3 + a.slot) * (0.35 - 0.2 * sit) + 1.9 * sit;
    a.tailUp = (a.tailUp || 0) + ((a.state === 'follow' ? 1 : 0) - (a.tailUp || 0)) * 0.05;
    _e.set(a.kind === 'dog' ? -0.6 - a.wag * 0.4 : lerpN(-1.1 - 0.75 * sit, -0.15, a.tailUp), a.kind === 'dog' ? wag : wag * (1 - 0.7 * a.tailUp), 0, 'YXZ');
    _m2.compose(_v.set(T[0], T[1], T[2]), _q2.setFromEuler(_e), _one);
    M.tail.setMatrixAt(a.slot, _m2.premultiply(_m));
  }

  hide(a) {
    const M = this.meshes[a.kind];
    M.body.setMatrixAt(a.slot, _zero); M.tail.setMatrixAt(a.slot, _zero);
    if (a.kind === 'dog') for (const m of [M.earsF, M.earsP, M.tongue]) m.setMatrixAt(a.slot, _zero);
    for (let k = 0; k < 4; k++) M.legs.setMatrixAt(a.slot * 4 + k, _zero);
  }

  // Сцене нужна пустая площадка
  clearAround(center, r) {
    for (const a of this.list) {
      if (a.state === 'none' || a.pos.distanceTo(center) > r) continue;
      if (a.owner) a.owner.dog = null;
      a.owner = null;
      a.state = 'none';
      this.hide(a);
    }
  }

  clear() { for (const a of this.list) { if (a.owner) a.owner.dog = null; a.owner = null; a.state = 'none'; this.hide(a); } }
}

// Точки крепления лап и хвоста (в метрах, собака/кошка «размера 1»), морда вдоль +Z
const LEGS_DOG = [[0.12, 0.42, 0.24], [-0.12, 0.42, 0.24], [0.12, 0.42, -0.24], [-0.12, 0.42, -0.24]];
const LEGS_CAT = [[0.07, 0.22, 0.14], [-0.07, 0.22, 0.14], [0.07, 0.22, -0.15], [-0.07, 0.22, -0.15]];
const TAIL_DOG = [0, 0.52, -0.36];
const lerpN = (a, b, t) => a + (b - a) * t;
const TAIL_CAT = [0, 0.3, -0.22];

// Материал шерсти: tint — какие части берут цвет экземпляра; coat (rgb второго цвета + номер узора)
// рисует подпалины, пятна, полосы и «носочки» в локальных координатах части тела
function createAnimalMaterial(cat, part) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
  mat.defines = { CAT: cat ? 1 : 0, PART: part };
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float tint;\nattribute vec4 coat;\nvarying vec4 vCoat;\nvarying vec3 vLoc;\nvarying float vTint;\nvarying float vSeed;')
      .replace('#include <color_vertex>', `
        vColor.rgb = color.rgb;
        #ifdef USE_INSTANCING_COLOR
          vColor.rgb *= mix(vec3(1.0), instanceColor.rgb, tint);
        #endif
        vCoat = coat; vLoc = position; vTint = tint; vSeed = float(gl_InstanceID) * 7.31;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec4 vCoat; varying vec3 vLoc; varying float vTint; varying float vSeed;
        float aHash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
        float aNoise(vec3 p) {
          vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(aHash(i), aHash(i + vec3(1, 0, 0)), f.x), mix(aHash(i + vec3(0, 1, 0)), aHash(i + vec3(1, 1, 0)), f.x), f.y),
                     mix(mix(aHash(i + vec3(0, 0, 1)), aHash(i + vec3(1, 0, 1)), f.x), mix(aHash(i + vec3(0, 1, 1)), aHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float pat = floor(vCoat.w + 0.5);
          vec3 p = vLoc, c2 = vCoat.rgb;
          float m = 0.0, dark = 0.0;
          vec3 q = p * 8.0 + vec3(vSeed, vSeed * 0.37, 0.0);
          #if CAT == 0
            #if PART == 0
              float light = max(smoothstep(0.44, 0.37, p.y), max(smoothstep(0.22, 0.3, p.z) * smoothstep(0.66, 0.58, p.y), smoothstep(0.5, 0.56, p.z) * smoothstep(0.77, 0.72, p.y)));
              float saddle = smoothstep(0.55, 0.61, p.y) * smoothstep(0.34, 0.22, p.z) * smoothstep(-0.4, -0.3, p.z);
            #elif PART == 1
              float light = smoothstep(-0.18, -0.3, p.y);
              float saddle = 0.0;
            #else
              float light = smoothstep(0.22, 0.3, p.y);
              float saddle = 1.0;
            #endif
            if (pat == 1.0) m = light;
            else if (pat == 2.0) m = smoothstep(0.6, 0.64, aNoise(q));
            else if (pat == 3.0) m = saddle;
          #else
            #if PART == 0
              float stripes = smoothstep(0.15, 0.75, sin(p.z * 80.0 + sin(p.y * 45.0) * 1.3)) * smoothstep(0.25, 0.33, p.y)
                            + smoothstep(0.3, 0.8, sin(p.x * 160.0)) * smoothstep(0.42, 0.44, p.y) * step(0.17, p.z);
              float bib = max(smoothstep(0.24, 0.19, p.y), max(smoothstep(0.2, 0.25, p.z) * smoothstep(0.4, 0.35, p.y), smoothstep(0.255, 0.275, p.z) * smoothstep(0.405, 0.39, p.y)));
            #elif PART == 1
              float stripes = smoothstep(0.2, 0.8, sin(p.y * 95.0));
              float bib = smoothstep(-0.11, -0.16, p.y);
            #else
              float stripes = smoothstep(0.2, 0.8, sin(p.y * 75.0));
              float bib = 0.0;
            #endif
            if (pat == 1.0) m = clamp(stripes, 0.0, 1.0) * 0.85;
            else if (pat == 2.0) m = bib;
            else if (pat == 3.0) { m = smoothstep(0.58, 0.62, aNoise(q)); dark = smoothstep(0.63, 0.67, aNoise(q + 17.0)); }
          #endif
          diffuseColor.rgb = mix(diffuseColor.rgb, c2, m * vTint);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.06, 0.055, 0.05), dark * vTint);
        }`);
  };
  return mat;
}

function makeGeometries() {
  const part = (geo, color = 0xffffff, tint = 1) => {
    if (geo.index) geo = geo.toNonIndexed();
    geo.deleteAttribute('uv');
    const n = geo.attributes.position.count, c = new THREE.Color(color), col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('tint', new THREE.BufferAttribute(new Float32Array(n).fill(tint), 1));
    return geo;
  };
  const S = (r, sx, sy, sz, x, y, z, w = 8, h = 5) => new THREE.SphereGeometry(r, w, h).scale(sx, sy, sz).translate(x, y, z);
  const M = (l) => mergeGeometries(l);
  // Собака: туловище, грудь, шея, голова, морда, нос, уши, глаза
  const dogBody = M([
    part(new THREE.CapsuleGeometry(0.15, 0.4, 2, 7).rotateX(Math.PI / 2).scale(1, 1.05, 1).translate(0, 0.5, 0)),
    part(S(0.16, 1, 1.05, 1, 0, 0.53, 0.2)),
    part(new THREE.CylinderGeometry(0.08, 0.1, 0.22, 8).rotateX(-0.6).translate(0, 0.65, 0.33)),
    part(S(0.11, 0.95, 1, 1.1, 0, 0.76, 0.42)),
    part(S(0.06, 0.9, 0.8, 1.4, 0, 0.72, 0.53)),
    part(S(0.025, 1, 0.8, 1, 0, 0.74, 0.61), 0x111111, 0),
    part(S(0.018, 1, 1, 1, 0.045, 0.79, 0.51), 0x0d0b0a, 0), part(S(0.018, 1, 1, 1, -0.045, 0.79, 0.51), 0x0d0b0a, 0),
    part(S(0.006, 1, 1, 1, 0.05, 0.796, 0.524), 0xffffff, 0), part(S(0.006, 1, 1, 1, -0.04, 0.796, 0.524), 0xffffff, 0),
    part(S(0.03, 1.4, 0.5, 1, 0.045, 0.815, 0.49)), part(S(0.03, 1.4, 0.5, 1, -0.045, 0.815, 0.49)),
    part(S(0.035, 1.2, 0.5, 1.4, 0, 0.685, 0.55)),
    part(S(0.15, 1, 0.95, 1.05, 0, 0.53, -0.22)),
    part(new THREE.CylinderGeometry(0.085, 0.085, 0.03, 10).rotateX(-0.6).translate(0, 0.66, 0.34), 0xc0392b, 0),
  ]);
  const ear = (sx, f) => f
    ? part(new THREE.SphereGeometry(0.05, 7, 5).scale(0.42, 1.35, 0.85).rotateZ(sx * 0.32).translate(sx * 0.098, 0.765, 0.385))
    : part(new THREE.ConeGeometry(0.045, 0.13, 5).rotateX(-0.12).rotateZ(-sx * 0.22).translate(sx * 0.062, 0.89, 0.4));
  const dogEarsF = M([ear(1, true), ear(-1, true)]);
  const dogEarsP = M([ear(1, false), ear(-1, false),
    part(new THREE.ConeGeometry(0.026, 0.08, 4).rotateX(-0.12).rotateZ(-0.22).translate(0.062, 0.875, 0.415), 0xc88a84, 0),
    part(new THREE.ConeGeometry(0.026, 0.08, 4).rotateX(-0.12).rotateZ(0.22).translate(-0.062, 0.875, 0.415), 0xc88a84, 0)]);
  const dogTongue = part(new THREE.SphereGeometry(0.03, 6, 4).scale(0.9, 0.22, 1.5).rotateX(0.55).translate(0, 0.665, 0.58), 0xd65a68, 0);
  const dogLeg = M([part(new THREE.CapsuleGeometry(0.045, 0.3, 1, 5).translate(0, -0.2, 0)), part(S(0.05, 1, 0.6, 1.4, 0, -0.4, 0.02))]);
  const dogTail = part(new THREE.CapsuleGeometry(0.03, 0.26, 1, 4).translate(0, 0.15, 0));
  // Кошка: стройнее, острые уши, длинный хвост
  const catBody = M([
    part(new THREE.CapsuleGeometry(0.08, 0.24, 2, 6).rotateX(Math.PI / 2).translate(0, 0.29, 0)),
    part(S(0.075, 1.1, 1, 1, 0, 0.4, 0.21)),
    part(new THREE.ConeGeometry(0.03, 0.06, 4).translate(0.04, 0.48, 0.21)),
    part(new THREE.ConeGeometry(0.03, 0.06, 4).translate(-0.04, 0.48, 0.21)),
    part(S(0.012, 1, 1, 1, 0.028, 0.415, 0.275), 0x9acd32, 0), part(S(0.012, 1, 1, 1, -0.028, 0.415, 0.275), 0x9acd32, 0),
    part(S(0.01, 1, 0.8, 1, 0, 0.39, 0.29), 0xd88a8a, 0),
    part(S(0.0085, 0.5, 1.4, 0.5, 0.028, 0.415, 0.2868), 0x080806, 0), part(S(0.0085, 0.5, 1.4, 0.5, -0.028, 0.415, 0.2868), 0x080806, 0),
    part(S(0.028, 1.25, 0.8, 0.9, 0, 0.386, 0.266)),
    part(new THREE.ConeGeometry(0.018, 0.04, 4).translate(0.04, 0.474, 0.218), 0xd89a9a, 0),
    part(new THREE.ConeGeometry(0.018, 0.04, 4).translate(-0.04, 0.474, 0.218), 0xd89a9a, 0),
    ...[1, -1].flatMap((sx) => [0.004, -0.004].map((dy) => part(new THREE.BoxGeometry(0.075, 0.0022, 0.0022).rotateZ(sx * dy * 25).translate(sx * 0.052, 0.387 + dy, 0.282), 0xeeeae2, 0))),
    part(S(0.085, 1, 1, 1.1, 0, 0.3, -0.11)),
    part(S(0.07, 1, 1.05, 0.9, 0, 0.31, 0.12)),
  ]);
  const catLeg = M([part(new THREE.CapsuleGeometry(0.022, 0.17, 1, 4).translate(0, -0.11, 0)), part(S(0.026, 1, 0.6, 1.3, 0, -0.21, 0.01))]);
  const catTail = part(new THREE.CapsuleGeometry(0.017, 0.3, 1, 4).translate(0, 0.17, 0));
  return { dogBody, dogLeg, dogTail, dogEarsF, dogEarsP, dogTongue, catBody, catLeg, catTail };
}
