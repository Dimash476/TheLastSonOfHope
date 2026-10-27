import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CITY, TRAFFIC, DEBRIS } from '../config.js';
import { HALF, BLOCK, blockAt } from './layout.js';

const SHIRTS = [0xd64541, 0x3a6fd8, 0xf2f2f2, 0x2b2b2b, 0x45a35b, 0xe0a030, 0x8e5bd0, 0x1f8f8f, 0xc76f9a, 0x6b8e23];
const PANTS = [0x22304a, 0x2b2b2b, 0x4a3b2a, 0x5a5f66, 0x1e3b5a];
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _e = new THREE.Euler();
const _one = new THREE.Vector3(1, 1, 1);
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const UP = new THREE.Vector3(0, 1, 0);
const RX = new THREE.Vector3(1, 0, 0);
const PERIM = 4 * (CITY.block - 20);

// Люди: гуляют по тротуарам вокруг кварталов, разбегаются от опасности,
// отлетают от ударных волн (и поднимаются — без жестокости).
export class People {
  constructor(scene, world) {
    this.world = world;
    const N = this.N = TRAFFIC.people;
    const mk = (geo, color, count) => {
      const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
      const m = new THREE.InstancedMesh(geo, mat, count);
      m.castShadow = true;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3).fill(1), 3);
      m.frustumCulled = false;
      scene.add(m);
      return m;
    };
    const geo = makePersonGeometry();
    this.upper = mk(geo.upper, 0xffffff, N);
    this.head = mk(geo.head, 0xffffff, N);
    this.legs = mk(geo.leg, 0xffffff, N * 2);

    this.list = [];
    for (let i = 0; i < N; i++) {
      const p = {
        slot: i, state: 'none', pos: new THREE.Vector3(), vel: new THREE.Vector3(), quat: new THREE.Quaternion(),
        ang: new THREE.Vector3(), heading: 0, phase: Math.random() * 6, block: [0, 0], s: 0, dirSign: 1,
        speed: 1.4, timer: 0, from: new THREE.Vector3(),
      };
      this.upper.setColorAt(i, new THREE.Color(SHIRTS[i % SHIRTS.length]));
      const pc = new THREE.Color(PANTS[(i * 7) % PANTS.length]);
      this.legs.setColorAt(i * 2, pc);
      this.legs.setColorAt(i * 2 + 1, pc);
      this.list.push(p);
    }
  }

  // Точка на тротуаре вокруг квартала по параметру s
  pathPoint(p, s, out) {
    const bx = -HALF + p.block[0] * CITY.block + 10, bz = -HALF + p.block[1] * CITY.block + 10;
    const L = CITY.block - 20;
    s = ((s % PERIM) + PERIM) % PERIM;
    const side = Math.floor(s / L), t = s - side * L;
    if (side === 0) out.set(bx + t, 0, bz);
    else if (side === 1) out.set(bx + L, 0, bz + t);
    else if (side === 2) out.set(bx + L - t, 0, bz + L);
    else out.set(bx, 0, bz + L - t);
    return out;
  }

  spawn(p, focus) {
    for (let tries = 0; tries < 15; tries++) {
      const a = Math.random() * Math.PI * 2, r = 30 + Math.random() * (TRAFFIC.radius * 0.6);
      const x = focus.x + Math.cos(a) * r, z = focus.z + Math.sin(a) * r;
      const t = blockAt(x, z);
      if (t === BLOCK.EMPTY || t === BLOCK.RIVER) continue;
      p.block = [Math.floor((x + HALF) / CITY.block), Math.floor((z + HALF) / CITY.block)];
      p.s = Math.random() * PERIM;
      p.dirSign = Math.random() < 0.5 ? 1 : -1;
      p.speed = 1.1 + Math.random() * 0.7;
      p.state = 'walk';
      this.pathPoint(p, p.s, p.pos);
      p.pos.y = this.world.city.groundHeightAt(p.pos.x, p.pos.z, 1);
      return;
    }
  }

  scare(p, from, time = 6) {
    if (p.state === 'walk' || p.state === 'flee') {
      p.state = 'flee';
      p.from.copy(from);
      p.timer = time + Math.random() * 3;
      p.speed = 5.5 + Math.random() * 2.5;
    }
  }

  knock(p, vel) {
    if (p.state === 'held') return;
    p.state = 'fly';
    p.vel.copy(vel);
    p.ang.set((Math.random() - 0.5) * 10, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 10);
    if (!(p.quat.lengthSq() > 0)) p.quat.identity();
    p.quat.setFromAxisAngle(UP, p.heading);
  }

  impulse(center, radius, force) {
    for (const p of this.list) {
      if (p.state === 'none' || p.state === 'held') continue;
      const d = p.pos.distanceTo(center);
      if (d < radius) {
        const k = 1 - d / radius;
        const dir = _v.subVectors(p.pos, center).setY(0);
        if (dir.lengthSq() < 0.01) dir.set(Math.random() - 0.5, 0, Math.random() - 0.5);
        dir.normalize();
        const f = Math.min(40, force * k);
        if (f > 3) this.knock(p, new THREE.Vector3(dir.x * f, f * 0.5 + 3, dir.z * f));
        else this.scare(p, center);
      } else if (d < radius * 4 + 60) this.scare(p, center);
    }
  }

  hit(center, radius, vel) {
    let any = false;
    for (const p of this.list) {
      if (p.state === 'none' || p.state === 'held') continue;
      if (_v.copy(p.pos).setY(p.pos.y + 1).distanceTo(center) > radius + 0.6) continue;
      // Аккуратно: герой сдерживает силу против людей
      this.knock(p, vel.clone().clampLength(0, 25).add(new THREE.Vector3(0, 6, 0)));
      any = true;
    }
    return any;
  }

  findGrabbable(pos, range) {
    let best = null, bestD = range;
    for (const p of this.list) {
      if (p.state === 'none' || p.state === 'held') continue;
      const d = p.pos.distanceTo(pos);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best ? { ref: best, dist: bestD } : null;
  }

  hold(p) { p.state = 'held'; p.vel.set(0, 0, 0); }
  setHeld(p, pos, facingQuat) {
    p.pos.copy(pos).add(new THREE.Vector3(0, -0.6, 0));
    p.quat.copy(facingQuat).multiply(_q.setFromAxisAngle(RX, Math.PI / 2));
  }
  throwObj(p, vel) { this.knock(p, vel.clone().clampLength(0, 45)); }

  update(dt, player) {
    const city = this.world.city, focus = player.pos;
    const inGrid = Math.abs(focus.x) < HALF + 300 && Math.abs(focus.z) < HALF + 300 && focus.y < 2000;
    const pSpeed = player.vel.length();

    for (const p of this.list) {
      if (p.state === 'none') {
        if (inGrid && Math.random() < 0.08) this.spawn(p, focus);
        if (p.state === 'none') { this.hide(p); continue; }
      }
      const dist = p.pos.distanceTo(focus);
      if ((dist > TRAFFIC.radius * 0.75 || !inGrid) && p.state !== 'held') { p.state = 'none'; this.hide(p); continue; }

      // Испугались пролетающего рядом героя
      if (p.state === 'walk' && dist < 35 && pSpeed > 25) this.scare(p, focus);

      let swing = 0;
      if (p.state === 'walk') {
        p.s += p.speed * p.dirSign * dt;
        const target = this.pathPoint(p, p.s, _v);
        const ahead = this.pathPoint(p, p.s + p.dirSign, new THREE.Vector3());
        // Если сошли с маршрута (после бегства) — плавно возвращаемся
        p.pos.x += (target.x - p.pos.x) * Math.min(1, dt * 2);
        p.pos.z += (target.z - p.pos.z) * Math.min(1, dt * 2);
        p.heading = Math.atan2(ahead.x - target.x, ahead.z - target.z);
        p.pos.y = city.groundHeightAt(p.pos.x, p.pos.z, p.pos.y + 1);
        p.phase += dt * p.speed * 4.5;
        swing = Math.sin(p.phase) * 0.5;
        p.quat.setFromAxisAngle(UP, p.heading);
      } else if (p.state === 'flee') {
        p.timer -= dt;
        const away = _v.subVectors(p.pos, p.from).setY(0);
        if (away.lengthSq() < 0.01) away.set(1, 0, 0);
        const want = Math.atan2(away.x, away.z) + Math.sin(p.phase * 0.3 + p.slot) * 0.4;
        let dh = Math.atan2(Math.sin(want - p.heading), Math.cos(want - p.heading));
        p.heading += dh * Math.min(1, dt * 5);
        const nx = p.pos.x + Math.sin(p.heading) * p.speed * dt, nz = p.pos.z + Math.cos(p.heading) * p.speed * dt;
        if (city.segAt(_v.set(nx, p.pos.y + 1, nz), 0.4)) p.heading += Math.PI / 2;
        else { p.pos.x = nx; p.pos.z = nz; }
        p.pos.y = city.groundHeightAt(p.pos.x, p.pos.z, p.pos.y + 1);
        p.phase += dt * p.speed * 2.2;
        swing = Math.sin(p.phase) * 0.9;
        p.quat.setFromAxisAngle(UP, p.heading);
        if (p.timer <= 0) {
          // Успокоились: продолжаем гулять вокруг ближайшего квартала
          p.state = 'walk';
          p.speed = 1.1 + Math.random() * 0.7;
          p.block = [Math.floor((p.pos.x + HALF) / CITY.block), Math.floor((p.pos.z + HALF) / CITY.block)];
          p.s = this.nearestS(p);
        }
      } else if (p.state === 'fly') {
        p.vel.y -= DEBRIS.gravity * 0.8 * dt;
        p.pos.addScaledVector(p.vel, dt);
        _e.set(p.ang.x * dt, p.ang.y * dt, p.ang.z * dt);
        p.quat.multiply(_q.setFromEuler(_e));
        if (city.segAt(_v.copy(p.pos).setY(p.pos.y + 0.8), 0.3)) { p.vel.x *= -0.3; p.vel.z *= -0.3; p.pos.addScaledVector(p.vel, dt * 2); }
        const gy = city.groundHeightAt(p.pos.x, p.pos.z, p.pos.y + 0.5);
        if (p.pos.y <= gy) {
          p.pos.y = gy;
          if (Math.abs(p.vel.y) > 6) { p.vel.y *= -0.3; p.vel.x *= 0.6; p.vel.z *= 0.6; }
          else {
            p.state = 'down';
            p.timer = 2.5 + Math.random() * 3;
            p.quat.setFromAxisAngle(UP, Math.random() * 6.28).multiply(_q.setFromAxisAngle(RX, Math.PI / 2 * (Math.random() < 0.5 ? 1 : -1)));
          }
        }
      } else if (p.state === 'down') {
        p.timer -= dt;
        p.pos.y = city.groundHeightAt(p.pos.x, p.pos.z, p.pos.y + 1) + 0.15;
        if (p.timer <= 0) { p.state = 'walk'; p.pos.y -= 0.15; this.scare(p, focus, 8); }
      }
      this.write(p, swing);
    }
    this.upper.instanceMatrix.needsUpdate = this.head.instanceMatrix.needsUpdate = this.legs.instanceMatrix.needsUpdate = true;
  }

  nearestS(p) {
    let best = 0, bestD = Infinity;
    for (let s = 0; s < PERIM; s += 4) {
      const d = this.pathPoint(p, s, _v).distanceToSquared(p.pos);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  write(p, swing) {
    _m.compose(p.pos, p.quat, _one);
    this.upper.setMatrixAt(p.slot, _m);
    this.head.setMatrixAt(p.slot, _m);
    for (let k = 0; k < 2; k++) {
      const side = k === 0 ? 1 : -1;
      _m2.compose(_v.set(side * 0.1, 0.92, 0), _q2.setFromAxisAngle(RX, swing * side), _one);
      this.legs.setMatrixAt(p.slot * 2 + k, _m2.premultiply(_m));
    }
  }

  hide(p) {
    this.upper.setMatrixAt(p.slot, _zero);
    this.head.setMatrixAt(p.slot, _zero);
    this.legs.setMatrixAt(p.slot * 2, _zero);
    this.legs.setMatrixAt(p.slot * 2 + 1, _zero);
  }

  clear() { for (const p of this.list) { p.state = 'none'; this.hide(p); } }
}

// Простой человечек: торс с руками (цвет рубашки), голова, нога (точка вращения в бедре)
function makePersonGeometry() {
  const colorize = (geo, color) => {
    const c = new THREE.Color(color), n = geo.attributes.position.count, a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
    geo.deleteAttribute('uv');
    return geo;
  };
  const torso = colorize(new THREE.CapsuleGeometry(0.17, 0.4, 2, 6).scale(1.15, 1, 0.75).translate(0, 1.22, 0), 0xffffff);
  const armL = colorize(new THREE.CapsuleGeometry(0.055, 0.5, 1, 4).translate(0.25, 1.15, 0), 0xffffff);
  const armR = colorize(new THREE.CapsuleGeometry(0.055, 0.5, 1, 4).translate(-0.25, 1.15, 0), 0xffffff);
  const head = colorize(new THREE.SphereGeometry(0.11, 7, 5).translate(0, 1.62, 0), 0xd9a882);
  const hair = colorize(new THREE.SphereGeometry(0.115, 7, 3, 0, Math.PI * 2, 0, Math.PI * 0.5).translate(0, 1.64, -0.01), 0x2a1d14);
  const leg = colorize(new THREE.CapsuleGeometry(0.07, 0.75, 1, 4).translate(0, -0.45, 0), 0xffffff);
  return { upper: mergeGeometries([torso, armL, armR]), head: mergeGeometries([head, hair]), leg };
}
