import * as THREE from 'three';
import { CITY, TRAFFIC, DEBRIS } from '../config.js';
import { HALF, isBridgeRoad, BIG_PARK, BEACH, inMega } from './layout.js';
import { VEHICLE_TYPES, createVehicleMaterial } from './vehicles.js';
import { createGlowPoolMaterial } from './props.js';

const N_NODES = CITY.grid + 1;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const _one = new THREE.Vector3(1, 1, 1);
const UP = new THREE.Vector3(0, 1, 0);

// Машины: ездят по дорогам вокруг игрока, их можно сбить, поднять и бросить.
// Состояния: drive — едет, held — в руках, fly — летит, wreck — разбита (горит).
export class Traffic {
  constructor(scene, world) {
    this.world = world; // { city, fire, effects, audio, debris, dust, sparks, impact }
    this.cars = [];
    // Свет фар на асфальте перед машиной (ночью)
    this.beamMat = createGlowPoolMaterial(0xfff0d0, 0.5);
    this.beams = new THREE.InstancedMesh(new THREE.PlaneGeometry(7, 20).rotateX(-Math.PI / 2).translate(0, 0.08, 12), this.beamMat, TRAFFIC.cars);
    this.beams.frustumCulled = false;
    this.beams.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.beams.renderOrder = 2;
    scene.add(this.beams);
    // Несколько типов машин — у каждого своя инстанс-сетка, материал общий
    this.uNight = { value: 0 };
    const mat = createVehicleMaterial(this.uNight);
    this.meshes = [];
    let made = 0;
    VEHICLE_TYPES.forEach((type, ti) => {
      const n = ti === VEHICLE_TYPES.length - 1 ? TRAFFIC.cars - made : Math.round(TRAFFIC.cars * type.weight);
      made += n;
      if (n <= 0) return;
      const mesh = new THREE.InstancedMesh(type.geo(), mat, n);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.meshes.push(mesh);
      for (let i = 0; i < n; i++) {
        const color = new THREE.Color(type.colors[Math.floor(Math.random() * type.colors.length)]);
        color.offsetHSL(0, 0, (Math.random() - 0.5) * 0.04);
        this.cars.push({
          mesh, slot: i, idx: this.cars.length, type: type.name, state: 'none', pos: new THREE.Vector3(), vel: new THREE.Vector3(), quat: new THREE.Quaternion(),
          ang: new THREE.Vector3(), color, heading: 0, node: [0, 0], dir: [1, 0], progress: 0, speed: 14,
          hp: type.name === 'bus' ? 220 : 100, burn: null, timer: 0, dead: false,
        });
        mesh.setColorAt(i, color);
      }
    });
  }

  setNight(k) { this.uNight.value = k; if (this.beamMat) this.beamMat.uniforms.uK.value = k; }

  // ---------------------------------------------------------------- дороги
  edgeValid(k, l, d) {
    const k2 = k + d[0], l2 = l + d[1];
    if (k2 < 0 || l2 < 0 || k2 >= N_NODES || l2 >= N_NODES) return false;
    // Дорога вдоль Z через реку — только там, где мост
    if (d[1] !== 0 && Math.min(l, l2) === CITY.riverRow && !isBridgeRoad(k)) return false;
    // Внутри центрального парка дорог нет
    const mx = -HALF + (k + k2) * CITY.block / 2, mz = -HALF + (l + l2) * CITY.block / 2;
    if (mx > BIG_PARK.minX && mx < BIG_PARK.maxX && mz > BIG_PARK.minZ && mz < BIG_PARK.maxZ) return false;
    // ...и внутри мега-площадей (дороги по периметру остаются)
    if (inMega(mx, mz, 1)) return false;
    // По пляжу машины не ездят
    if (mx > BEACH.x0 && mz > BEACH.minZ && mz < BEACH.maxZ) return false;
    return true;
  }

  nodePos(k, l) { return [-HALF + k * CITY.block, -HALF + l * CITY.block]; }

  spawnCar(car, focus) {
    // Случайный перекрёсток в кольце вокруг игрока
    for (let tries = 0; tries < 20; tries++) {
      const a = Math.random() * Math.PI * 2, r = 120 + Math.random() * (TRAFFIC.radius - 150);
      const k = Math.round((focus.x + Math.cos(a) * r + HALF) / CITY.block);
      const l = Math.round((focus.z + Math.sin(a) * r + HALF) / CITY.block);
      if (k < 0 || l < 0 || k >= N_NODES || l >= N_NODES) continue;
      const options = DIRS.filter((d) => this.edgeValid(k, l, d));
      if (!options.length) continue;
      car.node = [k, l];
      car.dir = options[Math.floor(Math.random() * options.length)];
      car.progress = Math.random() * 60;
      car.speed = car.type === 'bus' ? 8 + Math.random() * 3 : 10 + Math.random() * 8;
      car.state = 'drive';
      car.hp = car.type === 'bus' ? 220 : 100;
      car.dead = false;
      car.burn = null;
      car.heading = Math.atan2(car.dir[0], car.dir[1]);
      car.mesh.setColorAt(car.slot, car.color);
      car.mesh.instanceColor.needsUpdate = true;
      this.placeOnRoad(car);
      return true;
    }
    car.state = 'none';
    return false;
  }

  placeOnRoad(car) {
    const [x, z] = this.nodePos(car.node[0], car.node[1]);
    const [dx, dz] = car.dir;
    // Правостороннее движение: смещение вправо от направления
    const lane = 3.6;
    car.pos.set(x + dx * car.progress - dz * lane, 0, z + dz * car.progress + dx * lane);
    car.pos.y = this.world.city.groundHeightAt(car.pos.x, car.pos.z, 1);
  }

  // ---------------------------------------------------------------- взаимодействие
  launch(car, vel, angK = 1) {
    if (car.state === 'held') return;
    car.state = 'fly';
    car.vel.copy(vel);
    car.ang.set((Math.random() - 0.5) * 6 * angK, (Math.random() - 0.5) * 4 * angK, (Math.random() - 0.5) * 6 * angK);
  }

  damageCar(car, amount) {
    if (car.hp <= 0) return; // уже взорвалась
    car.hp -= amount;
    if (car.hp <= 0) this.explode(car);
  }

  explode(car) {
    const W = this.world;
    car.hp = 0;
    const p = car.pos.clone().add(new THREE.Vector3(0, 1, 0));
    W.fire.explosion(p, 0.8);
    W.effects.shockwave(p, { type: 'sphere', radius: 14, life: 0.5, opacity: 0.35, color: 0xffb060 });
    W.effects.flash(p, 20);
    W.audio?.explosion(0.6, p);
    W.debris.explode(p, 15, 20);
    W.impact?.(p, 14, 25, car);
    W.city.damageRadius(p, 8, 60, 15);
    car.burn = W.fire.add(car.pos, { size: 1.1, life: 25, target: car });
    // Обгоревший корпус
    car.mesh.setColorAt(car.slot, new THREE.Color(0x1a1714));
    car.mesh.instanceColor.needsUpdate = true;
    if (car.state === 'drive') this.launch(car, new THREE.Vector3((Math.random() - 0.5) * 6, 10, (Math.random() - 0.5) * 6));
  }

  // Ударная волна / взрыв рядом
  impulse(center, radius, force, source) {
    for (const car of this.cars) {
      if (car === source || car.state === 'none' || car.state === 'held') continue;
      const d = car.pos.distanceTo(center);
      if (d > radius) continue;
      const k = 1 - d / radius;
      const dir = _v.subVectors(car.pos, center).setY(0);
      if (dir.lengthSq() < 0.01) dir.set(Math.random() - 0.5, 0, Math.random() - 0.5);
      dir.normalize();
      const f = force * k;
      if (f < 4) continue;
      this.launch(car, new THREE.Vector3(dir.x * f, f * 0.6 + 3, dir.z * f), Math.min(2, f / 20));
      this.damageCar(car, f * 1.5);
    }
  }

  // Удар кулаком / таран игрока: возвращает true, если что-то задели
  hit(center, radius, vel, damage) {
    let any = false;
    for (const car of this.cars) {
      if (car.state === 'none' || car.state === 'held') continue;
      if (_v.copy(car.pos).setY(car.pos.y + 0.8).distanceTo(center) > radius + 2.2) continue;
      any = true;
      this.launch(car, vel.clone().add(new THREE.Vector3(0, vel.length() * 0.25 + 4, 0)), 1.5);
      this.damageCar(car, damage);
      this.world.sparks.burst(_v.copy(car.pos).setY(car.pos.y + 1), 12, { size: [0.2, 0.6], speed: 15, life: [0.2, 0.5], color: 0xffe0a0 });
      this.world.audio?.metal(Math.min(1, damage / 80), car.pos);
    }
    return any;
  }

  findGrabbable(p, range) {
    let best = null, bestD = range;
    for (const car of this.cars) {
      if (car.state === 'none' || car.state === 'held') continue;
      const d = car.pos.distanceTo(p);
      if (d < bestD) { bestD = d; best = car; }
    }
    return best ? { ref: best, dist: bestD } : null;
  }

  hold(car) {
    car.state = 'held';
    car.vel.set(0, 0, 0);
    car.ang.set(0, 0, 0);
  }

  setHeld(car, p, facingQuat) {
    car.pos.copy(p).add(new THREE.Vector3(0, 0.2, 0));
    // Держим над головой поперёк
    car.quat.copy(facingQuat).multiply(_q.setFromAxisAngle(UP, Math.PI / 2));
  }

  throwObj(car, vel) {
    car.state = 'fly';
    car.thrown = true;
    car.vel.copy(vel);
    car.ang.set((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 3);
  }

  // ---------------------------------------------------------------- обновление
  update(dt, focus) {
    const W = this.world, city = W.city;
    const inGrid = Math.abs(focus.x) < HALF + 400 && Math.abs(focus.z) < HALF + 400 && focus.y < 3000;
    const night = this.uNight.value > 0.05;
    for (const car of this.cars) {
      if (car.state === 'none') {
        if (inGrid && Math.random() < 0.05) this.spawnCar(car, focus);
        else { car.mesh.setMatrixAt(car.slot, _zero); if (night) this.beams.setMatrixAt(car.idx, _zero); continue; }
      }
      const far = car.pos.distanceTo(focus) > TRAFFIC.radius + 150;

      if (car.state === 'drive') {
        if (far || !inGrid) { car.state = 'none'; car.mesh.setMatrixAt(car.slot, _zero); if (night) this.beams.setMatrixAt(car.idx, _zero); continue; }
        car.progress += car.speed * dt;
        if (car.progress >= CITY.block) {
          car.node = [car.node[0] + car.dir[0], car.node[1] + car.dir[1]];
          car.progress -= CITY.block;
          const back = [-car.dir[0], -car.dir[1]];
          let options = DIRS.filter((d) => this.edgeValid(car.node[0], car.node[1], d) && !(d[0] === back[0] && d[1] === back[1]));
          if (!options.length) options = [back];
          // Чаще едем прямо
          const straight = options.find((d) => d[0] === car.dir[0] && d[1] === car.dir[1]);
          car.dir = straight && Math.random() < 0.6 ? straight : options[Math.floor(Math.random() * options.length)];
        }
        this.placeOnRoad(car);
        // Мост разрушен — падаем
        if (car.pos.y < -1) { this.launch(car, new THREE.Vector3(car.dir[0] * car.speed, 0, car.dir[1] * car.speed), 0.3); }
        const target = Math.atan2(car.dir[0], car.dir[1]);
        let dh = target - car.heading;
        dh = Math.atan2(Math.sin(dh), Math.cos(dh));
        car.heading += dh * Math.min(1, dt * 6);
        car.quat.setFromAxisAngle(UP, car.heading);
      } else if (car.state === 'fly' || car.state === 'wreck') {
        if (car.state === 'wreck') {
          car.timer += dt;
          if (car.timer > 40 || far) { car.state = 'none'; car.dead = true; continue; }
        } else this.flyStep(car, dt);
      }
      _m.compose(car.pos, car.quat, _one);
      car.mesh.setMatrixAt(car.slot, _m);
      if (night) this.beams.setMatrixAt(car.idx, car.state === 'drive' && car.hp > 0 ? _m : _zero);
    }
    this.beams.visible = night;
    if (night) this.beams.instanceMatrix.needsUpdate = true;
    for (const m of this.meshes) m.instanceMatrix.needsUpdate = true;
  }

  flyStep(car, dt) {
    const W = this.world, city = W.city;
    car.vel.y -= DEBRIS.gravity * dt;
    car.pos.addScaledVector(car.vel, dt);
    _e.set(car.ang.x * dt, car.ang.y * dt, car.ang.z * dt);
    car.quat.multiply(_q.setFromEuler(_e));
    const speed = car.vel.length();
    // След брошенной машины: воздух и искры за ней
    if (car.thrown && speed > 30) {
      W.dust.burst(car.pos.clone().add(new THREE.Vector3(0, 0.8, 0)), 1, { size: [1.5, 3], speed: 1, life: [0.3, 0.6], alpha: 0.5 });
      if (Math.random() < 0.5) W.sparks.burst(car.pos.clone().add(new THREE.Vector3(0, 0.8, 0)), 1, { size: [0.2, 0.4], speed: 3, life: [0.15, 0.3], color: 0xfff0d0 });
    }

    // Здания
    const c = _v.copy(car.pos).setY(car.pos.y + 0.8);
    const s = city.segAt(c, 1.2);
    if (s) {
      const dir = car.vel.clone().normalize();
      if (speed > 25) {
        city.damage(s, speed * (car.thrown ? 5 : 2), c.clone(), dir, Math.min(40, speed * 0.3));
        if (car.thrown) { W.effects.impactFX(0.6, c.clone(), 0.15, 6); W.effects.shockwave(c.clone(), { type: 'sphere', radius: 12, life: 0.4, opacity: 0.4 }); W.audio?.concrete(1, c.clone()); }
        W.audio?.metal(Math.min(1, speed / 80), car.pos);
        this.damageCar(car, speed * 1.2);
      }
      // Отскок от стены: разворачиваем горизонтальную скорость
      const px = s.w / 2 + 1.2 - Math.abs(c.x - s.x), pz = s.d / 2 + 1.2 - Math.abs(c.z - s.z), py = s.y0 + s.h + 1.2 - c.y;
      if (py < px && py < pz) { car.pos.y += py; car.vel.y = Math.abs(car.vel.y) * 0.2; }
      else if (px < pz) { car.pos.x += Math.sign(c.x - s.x) * px; car.vel.x *= -0.3; }
      else { car.pos.z += Math.sign(c.z - s.z) * pz; car.vel.z *= -0.3; }
      car.vel.multiplyScalar(0.6);
    }

    // Земля / крыши / мосты
    const gy = city.groundHeightAt(car.pos.x, car.pos.z, car.pos.y + 1);
    if (car.pos.y <= gy) {
      const impact = -car.vel.y;
      car.pos.y = gy;
      if (impact > 20) {
        this.damageCar(car, impact * (car.thrown ? 2 : 1));
        W.dust.burst(car.pos, 6, { size: [2, 5], speed: 6, life: [0.8, 1.6] });
        W.audio?.metal(Math.min(1, impact / 60), car.pos);
        if (car.thrown && impact > 40) W.impact?.(car.pos.clone(), 10, impact * 0.4, car);
      }
      car.vel.y = impact > 6 ? impact * 0.3 : 0;
      car.vel.x *= 0.7; car.vel.z *= 0.7;
      car.ang.multiplyScalar(0.6);
      if (car.vel.length() < 1.5) {
        car.state = 'wreck';
        car.timer = 0;
        car.thrown = false;
        // Ставим на колёса или на крышу — как упала
        const up = _v.set(0, 1, 0).applyQuaternion(car.quat);
        const yaw = Math.atan2(2 * (car.quat.w * car.quat.y + car.quat.x * car.quat.z), 1 - 2 * (car.quat.y ** 2 + car.quat.x ** 2));
        car.quat.setFromEuler(_e.set(up.y < 0 ? Math.PI : 0, yaw, 0));
        if (up.y < 0) car.pos.y += 1.6;
      }
    }
  }

  clear() {
    for (const car of this.cars) { car.state = 'none'; car.dead = true; car.mesh.setMatrixAt(car.slot, _zero); }
    for (const m of this.meshes) m.instanceMatrix.needsUpdate = true;
  }
}
