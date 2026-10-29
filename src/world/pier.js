import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BEACH, PIER, pierDeckY } from './layout.js';
import { createGlowPoolMaterial } from './props.js';

// Пирс развлечений: колесо обозрения, американские горки, карусель, кафе, входная арка,
// перила, фонари и гирлянды лампочек. Ночью всё светится, иногда над морем — фейерверк.

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const DECK = pierDeckY(BEACH.x0 + 200);
const X0 = BEACH.x0, Z = PIER.z;
const PASTEL = [0xf4a6b8, 0x9ad0ec, 0xf9e07f, 0xa8e6cf, 0xc3aed6, 0xffb38a];
const FIRE = [0xff4d6d, 0xffd166, 0x4cc9f0, 0x80ffdb, 0xf72585, 0xffffff, 0xff9f1c];

export class Pier {
  constructor(scene, world) {
    this.world = world;
    this.t = 0;
    this.uTime = { value: 0 };
    this.uNight = { value: 0 };
    this.group = new THREE.Group();
    scene.add(this.group);
    this.bulbMat = createBulbMaterial(this.uTime, this.uNight);
    this.solid = (color, rough = 0.6, metal = 0.2) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
    this.createWheel();
    this.createCoaster();
    this.createCarousel();
    this.createBuildings();
    this.createRailsAndLights();
    this.fireT = 5;
    this.rockets = [];
  }

  add(mesh, cast = true) { mesh.castShadow = cast; mesh.receiveShadow = true; this.group.add(mesh); return mesh; }

  // Лампочки (инстансы маленьких сфер): цвет экземпляра, ночью ярко, «бегущие» огни
  bulbs(points, colors, r = 0.12, chase = 1) {
    const geo = new THREE.SphereGeometry(r, 6, 4);
    const ch = new Float32Array(points.length);
    const mesh = new THREE.InstancedMesh(geo, this.bulbMat, points.length);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(points.length * 3), 3);
    points.forEach((p, i) => {
      mesh.setMatrixAt(i, _m.makeTranslation(p.x, p.y, p.z));
      mesh.setColorAt(i, new THREE.Color(colors[i % colors.length]));
      ch[i] = chase * (i / points.length);
    });
    geo.setAttribute('chase', new THREE.InstancedBufferAttribute(ch, 1));
    return mesh;
  }

  // ---------------------------------------------------------------- колесо обозрения
  createWheel() {
    const R = 26, hubY = DECK + R + 4, cx = X0 + 318, cz = Z - 14;
    this.wheelC = new THREE.Vector3(cx, hubY, cz);
    const white = this.solid(0xf2f2ee, 0.4, 0.5);
    // Опоры: две А-образные рамы
    for (const sx of [-3, 3]) for (const sz of [-1, 1]) {
      const footZ = cz + sz * 14;
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.6, Math.hypot(hubY - DECK, footZ - cz) + 1, 0.6), white);
      leg.position.set(cx + sx, (DECK + hubY) / 2, (cz + footZ) / 2);
      leg.rotation.x = -Math.atan2(footZ - cz, hubY - DECK) ;
      this.add(leg);
    }
    this.add(new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 7, 16).rotateZ(Math.PI / 2), white)).position.copy(this.wheelC);
    // Вращающаяся часть: обод, спицы, огни (плоскость колеса — YZ, ось — X)
    this.wheel = new THREE.Group();
    this.wheel.position.copy(this.wheelC);
    for (const dx of [-1.6, 1.6]) {
      const rim = new THREE.Mesh(new THREE.TorusGeometry(R, 0.3, 6, 72).rotateY(Math.PI / 2).translate(dx, 0, 0), white);
      rim.castShadow = true;
      this.wheel.add(rim);
    }
    const spokes = [];
    for (let k = 0; k < 18; k++) {
      const a = (k / 18) * Math.PI * 2;
      for (const dx of [-1.6, 1.6]) spokes.push(new THREE.BoxGeometry(0.15, R, 0.15).translate(dx, R / 2, 0).rotateX(a));
    }
    this.wheel.add(new THREE.Mesh(mergeGeometries(spokes), white));
    const pts = [];
    for (let k = 0; k < 72; k++) { const a = (k / 72) * Math.PI * 2; for (const dx of [-1.9, 1.9]) pts.push(new THREE.Vector3(dx, Math.sin(a) * R, Math.cos(a) * R)); }
    for (let k = 0; k < 18; k++) { const a = (k / 18) * Math.PI * 2; for (let r = 4; r < R; r += 3) pts.push(new THREE.Vector3(1.75, Math.sin(a) * r, Math.cos(a) * r)); }
    this.wheel.add(this.bulbs(pts, [0xff4d6d, 0xffd166, 0x4cc9f0, 0xf72585, 0x80ffdb], 0.42, 6));
    this.group.add(this.wheel);
    // Кабинки висят ровно (каждый кадр ставим на обод)
    const cabGeo = mergeGeometries([
      new THREE.BoxGeometry(2.2, 1.8, 2.2).translate(0, -1.6, 0),
      new THREE.ConeGeometry(1.7, 0.7, 4).rotateY(Math.PI / 4).translate(0, -0.35, 0),
    ].map((g) => g.toNonIndexed()));
    this.cabins = new THREE.InstancedMesh(cabGeo, new THREE.MeshStandardMaterial({ roughness: 0.5 }), 18);
    for (let k = 0; k < 18; k++) this.cabins.setColorAt(k, new THREE.Color(PASTEL[k % PASTEL.length]));
    this.add(this.cabins);
    this.R = R;
  }

  // ---------------------------------------------------------------- американские горки
  createCoaster() {
    const zc = Z + 21, xa = X0 + 240, xb = X0 + 362;
    const P = [
      [xa, 3, zc - 7], [xa + 25, 3, zc - 8], [xa + 45, 24, zc - 6], [xa + 60, 6, zc - 2], [xa + 75, 16, zc + 3],
      [xa + 92, 5, zc + 6], [xb, 12, zc + 4], [xb + 4, 10, zc - 4], [xb - 12, 4, zc - 9], [xa + 80, 9, zc - 10],
      [xa + 55, 14, zc - 11], [xa + 30, 4, zc - 11], [xa + 6, 6, zc - 10],
    ].map(([x, y, z]) => new THREE.Vector3(x, DECK + y, z));
    this.track = new THREE.CatmullRomCurve3(P, true, 'catmullrom', 0.4);
    const rail = this.solid(0xd94a3a, 0.5, 0.5);
    this.add(new THREE.Mesh(new THREE.TubeGeometry(this.track, 360, 0.28, 6, true), rail));
    // Опоры трассы
    const sup = [];
    for (let i = 0; i < 70; i++) {
      const p = this.track.getPointAt(i / 70);
      const h = p.y - DECK;
      if (h > 1) sup.push(new THREE.BoxGeometry(0.25, h, 0.25).translate(p.x, DECK + h / 2, p.z));
    }
    this.add(new THREE.Mesh(mergeGeometries(sup), this.solid(0xf2f2ee, 0.5, 0.4)));
    // Поезд из 4 вагончиков
    const car = mergeGeometries([new THREE.BoxGeometry(1.6, 0.9, 2.4).translate(0, 0.6, 0), new THREE.BoxGeometry(1.4, 0.4, 0.3).translate(0, 1.2, 1.0)].map((g) => g.toNonIndexed()));
    this.cars = new THREE.InstancedMesh(car, new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.3 }), 4);
    for (let i = 0; i < 4; i++) this.cars.setColorAt(i, new THREE.Color([0x2a6fdb, 0xffd166, 0x2a6fdb, 0xffd166][i]));
    this.add(this.cars);
    this.trackLen = this.track.getLength();
    this.trainU = 0;
    this.trainV = 10;
    this.trackTop = Math.max(...P.map((p) => p.y));
  }

  // ---------------------------------------------------------------- карусель
  createCarousel() {
    const c = new THREE.Vector3(X0 + 262, DECK, Z - 22);
    const base = this.solid(0xf3efe4, 0.5, 0.1);
    this.add(new THREE.Mesh(new THREE.CylinderGeometry(7, 7.2, 0.6, 32), base)).position.set(c.x, c.y + 0.3, c.z);
    // Полосатый купол: клинья по очереди красные и белые
    const roof = new THREE.ConeGeometry(7.6, 3.2, 16, 1).toNonIndexed();
    const col = new Float32Array(roof.attributes.position.count * 3);
    for (let i = 0; i < roof.attributes.position.count; i++) {
      const cc = new THREE.Color(Math.floor(i / 6) % 2 ? 0xd94a3a : 0xfff6e8);
      col[i * 3] = cc.r; col[i * 3 + 1] = cc.g; col[i * 3 + 2] = cc.b;
    }
    roof.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.add(new THREE.Mesh(roof, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5 }))).position.set(c.x, c.y + 6.6, c.z);
    this.add(new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 5, 10), this.solid(0xc9a24a, 0.3, 0.9))).position.set(c.x, c.y + 3, c.z);
    // Вращающаяся платформа с лошадками на шестах
    this.carousel = new THREE.Group();
    this.carousel.position.copy(c);
    const horse = mergeGeometries([
      new THREE.BoxGeometry(0.5, 0.6, 1.4).translate(0, 1.4, 0), new THREE.BoxGeometry(0.4, 0.7, 0.4).rotateX(-0.5).translate(0, 1.9, 0.65),
      new THREE.CylinderGeometry(0.05, 0.05, 4.6, 6).translate(0, 2.4, 0),
    ].map((g) => g.toNonIndexed()));
    const horses = new THREE.InstancedMesh(horse, new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.2 }), 12);
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2, r = k % 2 ? 5 : 3.6;
      horses.setMatrixAt(k, _m.compose(_v.set(Math.cos(a) * r, 0.6 + (k % 3) * 0.25, Math.sin(a) * r), _q.setFromAxisAngle(UP, -a), _s.set(1, 1, 1)));
      horses.setColorAt(k, new THREE.Color(PASTEL[k % PASTEL.length]));
    }
    horses.castShadow = true;
    this.carousel.add(horses);
    const ring = [];
    for (let k = 0; k < 40; k++) { const a = (k / 40) * Math.PI * 2; ring.push(new THREE.Vector3(Math.cos(a) * 7.4, 5.0, Math.sin(a) * 7.4)); }
    this.carousel.add(this.bulbs(ring, [0xffe0a0, 0xfff4d0], 0.22, 2));
    this.group.add(this.carousel);
  }

  // ---------------------------------------------------------------- кафе и арка
  createBuildings() {
    const cafeMat = new THREE.MeshStandardMaterial({ color: 0xf3efe4, roughness: 0.6 });
    const cafe = this.add(new THREE.Mesh(new THREE.BoxGeometry(14, 6, 18), cafeMat));
    cafe.position.set(X0 + 355, DECK + 3, Z - 20);
    const winMat = new THREE.MeshStandardMaterial({ color: 0x223040, roughness: 0.1, metalness: 0.6, emissive: new THREE.Color(1, 0.75, 0.45), emissiveIntensity: 0 });
    this.cafeWindows = winMat;
    this.add(new THREE.Mesh(new THREE.BoxGeometry(14.1, 2.2, 15), winMat), false).position.set(X0 + 355, DECK + 3.2, Z - 20);
    this.add(new THREE.Mesh(new THREE.BoxGeometry(15, 0.6, 19), this.solid(0x2a9d8f, 0.5, 0.2))).position.set(X0 + 355, DECK + 6.3, Z - 20);
    // Входная арка с лампочками
    const ax = X0 + 5, aw = PIER.w / 2 + 0.5;
    const post = this.solid(0xf2f2ee, 0.4, 0.3);
    for (const s of [-1, 1]) this.add(new THREE.Mesh(new THREE.BoxGeometry(0.8, 7, 0.8), post)).position.set(ax, pierDeckY(ax) + 3.5, Z + s * aw);
    const arch = new THREE.Mesh(new THREE.TorusGeometry(aw, 0.35, 8, 32, Math.PI).rotateY(Math.PI / 2), post);
    arch.position.set(ax, pierDeckY(ax) + 7, Z);
    this.add(arch);
    const pts = [];
    for (let k = 0; k <= 30; k++) { const a = (k / 30) * Math.PI; pts.push(new THREE.Vector3(ax - 0.4, pierDeckY(ax) + 7 + Math.sin(a) * aw, Z + Math.cos(a) * aw)); }
    this.group.add(this.bulbs(pts, [0xffd166, 0xff4d6d, 0x4cc9f0], 0.3, 3));
  }

  // ---------------------------------------------------------------- перила, фонари, гирлянды
  createRailsAndLights() {
    const rails = [], posts = [];
    const lampPts = [], strings = [];
    const edge = (x0, x1, z) => {
      for (let x = x0; x < x1; x += 15) {
        const xm = Math.min(x + 7.5, x1), y = pierDeckY(xm);
        rails.push(new THREE.BoxGeometry(15, 0.1, 0.1).translate(xm, y + 1.05, z));
        rails.push(new THREE.BoxGeometry(15, 0.08, 0.08).translate(xm, y + 0.55, z));
        for (let px = x; px < x + 15; px += 2.5) posts.push(new THREE.BoxGeometry(0.1, 1.05, 0.1).translate(px, pierDeckY(px) + 0.52, z));
      }
    };
    const xs = X0, xp = X0 + PIER.platFrom, xe = X0 + PIER.len;
    edge(xs + 8, xp, Z - PIER.w / 2 + 0.2); edge(xs + 8, xp, Z + PIER.w / 2 - 0.2);
    edge(xp, xe, Z - PIER.platW / 2 + 0.2); edge(xp, xe, Z + PIER.platW / 2 - 0.2);
    const railMat = this.solid(0xf2f2ee, 0.5, 0.3);
    this.add(new THREE.Mesh(mergeGeometries(rails), railMat), false);
    this.add(new THREE.Mesh(mergeGeometries(posts), railMat), false);
    // Фонари вдоль пирса и гирлянды между ними (провисают)
    const lamps = [];
    for (let x = xs + 12; x < xe; x += 18) {
      const w = x > xp ? PIER.platW : PIER.w;
      for (const s of [-1, 1]) {
        const z = Z + s * (w / 2 - 0.8), y = pierDeckY(x);
        lamps.push(new THREE.CylinderGeometry(0.08, 0.1, 5, 6).translate(x, y + 2.5, z));
        lampPts.push(new THREE.Vector3(x, y + 5.1, z));
      }
    }
    this.add(new THREE.Mesh(mergeGeometries(lamps), this.solid(0x22262a, 0.5, 0.6)));
    this.group.add(this.bulbs(lampPts, [0xfff2d8], 0.32, 0));
    for (let i = 0; i + 2 < lampPts.length; i += 2) {
      for (const k of [0, 1]) {
        const a = lampPts[i + k], b = lampPts[i + 2 + k];
        for (let t = 0.05; t < 1; t += 0.09) {
          strings.push(new THREE.Vector3().lerpVectors(a, b, t).add(_v.set(0, -0.9 * Math.sin(Math.PI * t) - 0.3, 0)));
        }
      }
    }
    this.group.add(this.bulbs(strings, [0xffe2a0, 0xff9fb2, 0xfff4d0, 0xa0e0ff], 0.16, 8));
    // Пятна света на настиле
    this.poolMat = createGlowPoolMaterial(0xffd9a0, 0.5);
    const pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(10, 10).rotateX(-Math.PI / 2), this.poolMat, lampPts.length);
    lampPts.forEach((p, i) => pools.setMatrixAt(i, _m.makeTranslation(p.x, pierDeckY(p.x) + 0.08, p.z)));
    pools.renderOrder = 2;
    this.pools = pools;
    this.group.add(pools);
  }

  // ---------------------------------------------------------------- фейерверк
  launchRocket() {
    const p = new THREE.Vector3(X0 + PIER.len + 30 + Math.random() * 60, DECK, Z + (Math.random() - 0.5) * 120);
    this.rockets.push({ p, v: new THREE.Vector3((Math.random() - 0.5) * 6, 55 + Math.random() * 20, (Math.random() - 0.5) * 6), t: 0, fuse: 2.2 + Math.random() * 0.8, color: FIRE[Math.floor(Math.random() * FIRE.length)] });
    this.world.soundscape?.fireworkLaunch?.(p.clone());
  }

  updateFireworks(dt, night, camPos) {
    const W = this.world;
    const near = Math.hypot(camPos.x - (X0 + PIER.len), camPos.z - Z) < 5000 && camPos.y < 3000;
    if (night > 0.7 && near) {
      this.fireT -= dt;
      if (this.fireT <= 0) {
        // Иногда — залп из нескольких ракет
        const n = Math.random() < 0.3 ? 3 + Math.floor(Math.random() * 3) : 1;
        for (let i = 0; i < n; i++) setTimeout(() => this.launchRocket(), i * 250);
        this.fireT = 5 + Math.random() * 10;
      }
    }
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i];
      r.t += dt;
      r.v.y -= 9.8 * dt * 0.6;
      r.p.addScaledVector(r.v, dt);
      if (Math.random() < 0.7) W.sparks.burst(r.p.clone(), 1, { size: [0.5, 0.9], speed: 2, life: [0.3, 0.6], color: 0xffd8a0, gravity: 3 });
      if (r.t >= r.fuse) {
        // Взрыв: шар искр основного цвета и немного белых
        W.sparks.burst(r.p.clone(), 170, { size: [2.6, 4.6], speed: 75, life: [1.6, 2.8], color: r.color, gravity: 3 });
        W.sparks.burst(r.p.clone(), 40, { size: [2.0, 3.2], speed: 35, life: [1.0, 1.8], color: 0xffffff, gravity: 3 });
        W.effects?.flash?.(r.p.clone(), 6);
        W.soundscape?.fireworkBoom?.(r.p.clone());
        this.rockets.splice(i, 1);
      }
    }
  }

  // ---------------------------------------------------------------- кадр
  update(dt, night, camPos) {
    this.t += dt;
    this.uTime.value = this.t;
    this.uNight.value = night;
    const vis = Math.hypot(camPos.x - (X0 + 250), camPos.z - Z) < 4500 && camPos.y < 4000;
    this.group.visible = vis;
    this.poolMat.uniforms.uK.value = night;
    this.pools.visible = night > 0.05;
    this.cafeWindows.emissiveIntensity = 0.15 + night * 1.5;
    this.updateFireworks(dt, night, camPos);
    if (!vis) return;
    // Колесо медленно вращается, кабинки висят ровно
    const ang = this.t * 0.05;
    this.wheel.rotation.x = ang;
    for (let k = 0; k < 18; k++) {
      const a = ang + (k / 18) * Math.PI * 2;
      _v.set(this.wheelC.x, this.wheelC.y + Math.sin(a) * this.R, this.wheelC.z + Math.cos(a) * this.R);
      this.cabins.setMatrixAt(k, _m.makeTranslation(_v.x, _v.y, _v.z));
    }
    this.cabins.instanceMatrix.needsUpdate = true;
    // Поезд горок: скорость от высоты (разгон на спусках)
    const p0 = this.track.getPointAt(this.trainU);
    this.trainV = Math.sqrt(Math.max(9, 2 * 9.8 * (this.trackTop - p0.y + 1.5)));
    this.trainU = (this.trainU + this.trainV * dt / this.trackLen) % 1;
    for (let i = 0; i < 4; i++) {
      const u = (this.trainU - i * 2.7 / this.trackLen + 1) % 1;
      const p = this.track.getPointAt(u), tg = this.track.getTangentAt(u);
      this.cars.setMatrixAt(i, _m.compose(p, _q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), tg), _s.set(1, 1, 1)));
    }
    this.cars.instanceMatrix.needsUpdate = true;
    this.carousel.rotation.y = this.t * 0.4;
  }
}

// Лампочки: цвет экземпляра; днём слабо, ночью ярко; chase — «бегущий огонь» по цепочке
function createBulbMaterial(uTime, uNight) {
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.uniforms.uNight = uNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float chase;\nuniform float uTime, uNight;\nvarying float vK;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vK = mix(0.35, 4.5, uNight) * (chase > 0.0 ? 0.55 + 0.45 * step(0.5, fract(chase - uTime * 0.6)) : 1.0);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vK;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vK;');
  };
  mat.toneMapped = false;
  return mat;
}
