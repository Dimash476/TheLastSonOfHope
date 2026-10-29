import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { WORLD } from '../config.js';
import { HALF, QUAY_X, groundHeight } from './layout.js';

// Жизнь в небе и на воде: стаи голубей над улицами (разлетаются от героя и взрывов),
// чайки над портом, новостной вертолёт (кружит вокруг героя, его можно сбить),
// самолёты с инверсионным следом высоко в небе, лодки и паром в море.

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const UP = new THREE.Vector3(0, 1, 0);

const PIGEON_FLOCKS = 7, PIGEONS = 16, GULL_FLOCKS = 2, GULLS = 18;
const PORT = { x: HALF - 60, z: -900 };

export class AirLife {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.t = 0;
    this.uTime = { value: 0 };
    this.uNight = { value: 0 };
    this.createBirds();
    this.createHeli();
    this.createPlanes();
    this.createBoats();
  }

  // ================================================================ птицы
  createBirds() {
    const n = PIGEON_FLOCKS * PIGEONS + GULL_FLOCKS * GULLS;
    const geo = makeBirdGeometry();
    const flap = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3); // частота, размах, фаза
    geo.setAttribute('iFlap', flap);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float wing;\nattribute vec3 iFlap;\nuniform float uTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          {
            float w = abs(wing);
            float a = sin(uTime * iFlap.x + iFlap.z) * iFlap.y;
            transformed.y += a * w * 0.42;
            transformed.x *= 1.0 - max(0.0, -a) * w * 0.25; // на взмахе вниз крыло чуть складывается
          }`);
    };
    this.birds = new THREE.InstancedMesh(geo, mat, n);
    this.birds.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.birds.frustumCulled = false;
    this.birds.castShadow = true;
    this.birdFlap = flap;
    this.scene.add(this.birds);

    this.flocks = [];
    let slot = 0;
    const mk = (kind, count) => {
      const f = {
        kind, center: new THREE.Vector3(1e9, 0, 0), vel: new THREE.Vector3(), target: new THREE.Vector3(),
        scatter: 0, spread: 1, birds: [], angle: Math.random() * 6.28,
      };
      for (let i = 0; i < count; i++) {
        f.birds.push({
          slot: slot++, off: new THREE.Vector3((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 5, (Math.random() - 0.5) * 14),
          w: (Math.random() < 0.5 ? -1 : 1) * (0.3 + Math.random() * 0.6), ph: Math.random() * 6.28, pos: new THREE.Vector3(),
          heading: 0,
        });
        const color = kind === 'gull' ? new THREE.Color(0.95, 0.95, 0.93) : new THREE.Color().setHSL(0.6, 0.08, 0.2 + Math.random() * 0.12);
        this.birds.setColorAt(slot - 1, color);
      }
      this.flocks.push(f);
    };
    for (let i = 0; i < PIGEON_FLOCKS; i++) mk('pigeon', PIGEONS);
    for (let i = 0; i < GULL_FLOCKS; i++) mk('gull', GULLS);
  }

  placeFlock(f, cam) {
    if (f.kind === 'gull') {
      f.center.set(PORT.x + (Math.random() - 0.5) * 300, 35 + Math.random() * 30, PORT.z + (Math.random() - 0.5) * 1600);
    } else {
      const a = Math.random() * 6.28, r = 150 + Math.random() * 300;
      f.center.set(cam.x + Math.cos(a) * r, 25 + Math.random() * 50, cam.z + Math.sin(a) * r);
    }
    f.vel.set(0, 0, 0);
    this.pickTarget(f, cam);
  }

  pickTarget(f, cam) {
    if (f.kind === 'gull') return;
    const a = Math.random() * 6.28, r = 60 + Math.random() * 320;
    f.target.set(cam.x + Math.cos(a) * r, 20 + Math.random() * 60, cam.z + Math.sin(a) * r);
  }

  scatterFlock(f, from, loud = true) {
    if (f.scatter > 1.5) return;
    f.scatter = 4 + Math.random() * 2;
    const away = _v.subVectors(f.center, from).setY(0);
    if (away.lengthSq() < 1) away.set(Math.random() - 0.5, 0, Math.random() - 0.5);
    away.normalize();
    f.vel.copy(away).multiplyScalar(20).setY(9);
    if (loud) this.world.audio?.flutter(Math.min(1, f.birds.length / 16), f.center.clone());
  }

  updateBirds(dt, player, cam) {
    const show = cam.y < 2200;
    this.birds.visible = show;
    if (!show) return;
    const hero = player.pos, heroSpeed = player.vel.length();
    for (const f of this.flocks) {
      const far = Math.hypot(f.center.x - cam.x, f.center.z - cam.z);
      if (f.kind === 'pigeon' && far > 750) this.placeFlock(f, cam);
      if (f.kind === 'gull' && f.center.x > 1e8) this.placeFlock(f, cam);

      // Герой рядом (или пронёсся мимо) — стая взлетает
      const dHero = f.center.distanceTo(hero);
      if (dHero < 25 + f.spread * 8 || (dHero < 90 && heroSpeed > 60)) this.scatterFlock(f, hero);

      if (f.scatter > 0) {
        f.scatter -= dt;
        f.vel.y *= 1 - dt * 0.4;
        f.spread += (2.4 - f.spread) * Math.min(1, dt * 2);
        if (f.scatter <= 0) this.pickTarget(f, cam);
      } else {
        f.spread += (1 - f.spread) * Math.min(1, dt * 0.5);
        if (f.kind === 'gull') {
          // Чайки медленно кружат над портом
          f.angle += dt * 0.12;
          const cx = PORT.x, cz = f === this.flocks[this.flocks.length - 1] ? PORT.z + 900 : PORT.z;
          f.target.set(cx + Math.cos(f.angle) * 140, 45 + Math.sin(f.angle * 0.7) * 12, cz + Math.sin(f.angle) * 140);
        } else if (f.center.distanceTo(f.target) < 25) this.pickTarget(f, cam);
        const speed = f.kind === 'gull' ? 9 : 12;
        const want = _v.subVectors(f.target, f.center).normalize().multiplyScalar(speed);
        f.vel.lerp(want, Math.min(1, dt * 0.8));
      }
      // Не врезаемся в землю и в здания (просто подтягиваем вверх)
      const city = this.world.city;
      const minY = Math.max(groundHeight(f.center.x, f.center.z), 0) + 12;
      if (f.center.y < minY) f.vel.y += (minY - f.center.y) * dt * 2;
      if (city.segAt(_v2.copy(f.center).addScaledVector(f.vel, 1.5), 6)) f.vel.y += 25 * dt;
      f.center.addScaledVector(f.vel, dt);

      const yaw = Math.atan2(f.vel.x, f.vel.z);
      const flapF = f.kind === 'gull' ? 6 : (f.scatter > 0 ? 22 : 14);
      for (const b of f.birds) {
        // Каждая птица чуть кружит вокруг своего места в стае
        b.ph += dt * b.w;
        const ox = b.off.x * Math.cos(b.ph) - b.off.z * Math.sin(b.ph), oz = b.off.x * Math.sin(b.ph) + b.off.z * Math.cos(b.ph);
        b.pos.set(f.center.x + ox * f.spread, f.center.y + b.off.y * f.spread + Math.sin(this.t * 1.3 + b.slot) * 0.6, f.center.z + oz * f.spread);
        const tilt = Math.max(-0.5, Math.min(0.5, b.w * 0.6));
        _e.set(-Math.max(-0.4, Math.min(0.5, f.vel.y * 0.03)), yaw + b.w * 0.25, tilt, 'YXZ');
        const sc = f.kind === 'gull' ? 1.7 : 1;
        _m.compose(b.pos, _q.setFromEuler(_e), _s.setScalar(sc));
        this.birds.setMatrixAt(b.slot, _m);
        // Чайки часто парят (взмахи редко)
        const glide = f.kind === 'gull' ? 0.25 + 0.75 * Math.max(0, Math.sin(this.t * 0.4 + b.slot)) : 1;
        this.birdFlap.setXYZ(b.slot, flapF * (0.9 + (b.slot % 5) * 0.05), glide, b.slot * 1.7);
      }
    }
    this.birds.instanceMatrix.needsUpdate = true;
    this.birdFlap.needsUpdate = true;
  }

  // ================================================================ вертолёт
  createHeli() {
    const g = new THREE.Group();
    const body = new THREE.MeshStandardMaterial({ color: 0xe9e9e6, roughness: 0.4, metalness: 0.3 });
    const stripe = new THREE.MeshStandardMaterial({ color: 0x1d4f91, roughness: 0.4, metalness: 0.3 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1a1c1e, roughness: 0.6, metalness: 0.5 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x0e1820, roughness: 0.05, metalness: 0.9 });
    const add = (geo, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; g.add(m); return m; };
    add(new THREE.SphereGeometry(1.4, 16, 12).scale(1, 0.95, 2.0), body, 0, 0, 0);
    add(new THREE.SphereGeometry(1.25, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55).scale(0.95, 0.9, 1.3).rotateX(Math.PI / 2.3), glass, 0, 0.2, 1.4);
    add(new THREE.BoxGeometry(2.86, 0.35, 3.4), stripe, 0, -0.3, -0.2);
    add(new THREE.CylinderGeometry(0.22, 0.42, 6, 10).rotateX(Math.PI / 2), body, 0, 0.35, -5.2);
    add(new THREE.BoxGeometry(0.12, 1.6, 0.9), stripe, 0, 1.0, -8.0);
    add(new THREE.BoxGeometry(2.0, 0.1, 0.6), body, 0, 0.4, -7.6);
    for (const s of [-1, 1]) {
      add(new THREE.CylinderGeometry(0.06, 0.06, 3.6, 6).rotateX(Math.PI / 2), dark, s * 1.0, -1.65, 0.2);
      add(new THREE.BoxGeometry(0.06, 0.5, 0.06), dark, s * 1.0, -1.35, 1.0);
      add(new THREE.BoxGeometry(0.06, 0.5, 0.06), dark, s * 1.0, -1.35, -0.6);
    }
    add(new THREE.CylinderGeometry(0.15, 0.2, 0.6, 8), dark, 0, 1.55, 0);
    this.rotor = add(new THREE.BoxGeometry(11, 0.06, 0.32), dark, 0, 1.85, 0);
    this.rotor.add(new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.06, 11), dark));
    this.tailRotor = add(new THREE.BoxGeometry(0.06, 1.8, 0.18), dark, 0.18, 0.9, -8.1);
    this.heliLight = add(new THREE.SphereGeometry(0.12, 6, 4), new THREE.MeshBasicMaterial({ color: 0xff2020 }), 0, 1.85, -8.5);
    // Прожектор ночью: светящийся конус (без настоящего источника света — дёшево)
    const coneMat = new THREE.MeshBasicMaterial({ color: 0xfff2d0, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    this.beam = new THREE.Mesh(new THREE.ConeGeometry(14, 130, 24, 1, true).translate(0, -65, 0), coneMat);
    this.beam.position.set(0, -1.4, 1.6);
    g.add(this.beam);
    this.scene.add(g);
    this.heli = { g, state: 'patrol', vel: new THREE.Vector3(), target: new THREE.Vector3(), angle: 0, spin: 0, timer: 0, smokeT: 0 };
    g.position.set(HALF * 0.3, 160, -HALF * 0.3);
  }

  crashHeli(push) {
    const H = this.heli;
    if (H.state === 'crash' || H.state === 'gone') return;
    H.state = 'crash';
    H.vel.add(push);
    H.spin = 3 + Math.random() * 2;
    const p = H.g.position.clone();
    this.world.effects?.flash(p, 12);
    this.world.sparks?.burst(p, 25, { size: [0.3, 0.8], speed: 18, life: [0.3, 0.8], color: 0xffd28a });
    this.world.audio?.metal(1, p);
  }

  updateHeli(dt, player, cam, night) {
    const H = this.heli, g = H.g, hero = player.pos;
    const inCity = Math.abs(hero.x) < HALF + 600 && Math.abs(hero.z) < HALF + 600 && hero.y < 900;
    const speed = player.vel.length();
    if (H.state === 'gone') {
      H.timer -= dt;
      if (H.timer <= 0 && inCity) {
        // Новый вертолёт прилетает издалека
        H.state = 'patrol';
        const a = Math.random() * 6.28;
        g.position.set(hero.x + Math.cos(a) * 1500, 220, hero.z + Math.sin(a) * 1500);
        g.rotation.set(0, 0, 0);
        H.vel.set(0, 0, 0);
        g.visible = true;
      } else { this.world.audio?.setRotor(0); return; }
    }

    if (H.state === 'crash') {
      // Падает, вращаясь, с дымным следом
      H.vel.y -= 9.8 * dt;
      H.vel.multiplyScalar(1 - dt * 0.1);
      g.position.addScaledVector(H.vel, dt);
      g.rotation.y += H.spin * dt;
      g.rotation.z = Math.min(0.7, g.rotation.z + dt * 0.3);
      H.smokeT -= dt;
      if (H.smokeT <= 0) {
        H.smokeT = 0.05;
        this.world.dust?.burst(g.position.clone(), 1, { size: [2, 5], speed: 2, life: [2, 4], color: 0x2a2826, alpha: 0.8, rise: 0.5 });
      }
      const gy = this.world.city.groundHeightAt(g.position.x, g.position.z, g.position.y + 2);
      if (g.position.y <= gy + 1.2) {
        const p = g.position.clone();
        this.world.fire?.explosion(p, 1.3);
        this.world.effects?.shockwave(p, { type: 'sphere', radius: 22, life: 0.6, opacity: 0.4, color: 0xffa050 });
        this.world.audio?.explosion(0.9, p);
        this.world.debris?.explode(p, 20, 25);
        this.world.fire?.add(p, { size: 2, life: 30 });
        this.world.impact?.(p, 20, 30);
        g.visible = false;
        H.state = 'gone';
        H.timer = 40;
      }
    } else {
      // Новостной вертолёт: кружит вокруг героя, если тот в городе и не слишком быстр
      if (inCity && speed < 160) {
        H.state = 'orbit';
        H.angle += dt * 0.16;
        const R = 170, alt = Math.max(hero.y + 70, 110);
        H.target.set(hero.x + Math.cos(H.angle) * R, alt, hero.z + Math.sin(H.angle) * R);
      } else {
        H.state = 'patrol';
        if (g.position.distanceTo(H.target) < 40 || H.target.lengthSq() === 0) {
          H.target.set((Math.random() - 0.5) * HALF * 1.6, 150 + Math.random() * 80, (Math.random() - 0.5) * HALF * 1.6);
        }
      }
      const want = _v.subVectors(H.target, g.position);
      const d = want.length();
      want.normalize().multiplyScalar(Math.min(55, d * 0.6));
      H.vel.lerp(want, Math.min(1, dt * 0.9));
      g.position.addScaledVector(H.vel, dt);
      // Нос — по движению, корпус наклонён вперёд по скорости, в повороте — крен
      const hs = Math.hypot(H.vel.x, H.vel.z);
      if (hs > 1) {
        const yaw = Math.atan2(H.vel.x, H.vel.z);
        let dy = yaw - g.rotation.y; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        g.rotation.order = 'YXZ';
        g.rotation.y += dy * Math.min(1, dt * 1.5);
        g.rotation.x = Math.min(0.25, hs * 0.005);
        g.rotation.z = -dy * 0.5;
      }
      // Столкновение с героем или ударная волна — сбит
      if (g.position.distanceTo(hero) < 7 && speed > 15) this.crashHeli(player.vel.clone().multiplyScalar(0.4));
    }
    g.visible = g.visible && cam.y < 4000;
    this.rotor.rotation.y += dt * 38;
    this.tailRotor.rotation.x += dt * 60;
    this.heliLight.visible = Math.sin(this.t * 6) > 0.6;
    // Прожектор на героя ночью
    this.beam.material.opacity = H.state === 'orbit' ? 0.09 * night : 0;
    if (H.state === 'orbit') {
      this.beam.lookAt(hero);
      this.beam.rotateX(-Math.PI / 2);
    }
    // Звук винта: громче рядом
    const dist = g.position.distanceTo(cam);
    this.world.audio?.setRotor(g.visible ? 0.35 / (1 + dist / 70) : 0);
  }

  // ================================================================ самолёты
  createPlanes() {
    const mat = new THREE.MeshStandardMaterial({ color: 0xeef0f2, roughness: 0.35, metalness: 0.4 });
    const grey = new THREE.MeshStandardMaterial({ color: 0x9aa1a8, roughness: 0.4, metalness: 0.6 });
    const geo = mergeGeometries([
      new THREE.CylinderGeometry(2.0, 1.8, 38, 12).rotateX(Math.PI / 2),
      new THREE.SphereGeometry(2.0, 12, 8).scale(1, 1, 1.8).translate(0, 0, 19),
      new THREE.ConeGeometry(1.8, 7, 12).rotateX(-Math.PI / 2).translate(0, 0.4, -22),
      new THREE.BoxGeometry(36, 0.45, 5.5).translate(0, -0.6, 1),
      new THREE.BoxGeometry(12, 0.3, 3).translate(0, 0.6, -21),
      new THREE.BoxGeometry(0.4, 7, 4.5).translate(0, 4, -21),
    ].map((g) => { g.deleteAttribute('uv'); return g.index ? g.toNonIndexed() : g; }));
    const engines = mergeGeometries([-8, 8].map((x) => new THREE.CylinderGeometry(1.1, 1.0, 4.5, 10).rotateX(Math.PI / 2).translate(x, -1.6, 4)).map((g) => g.toNonIndexed()));
    const trailMat = this.trailMat = new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 0.35 } },
      transparent: true, depthWrite: false,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform float uOpacity; varying vec2 vUv; void main(){ float a = pow(vUv.y, 2.0) * uOpacity * (0.6 + 0.4 * sin(vUv.x * 6.2832 * 2.0)); gl_FragColor = vec4(vec3(1.0), a); }',
    });
    this.planes = [0, 1].map((i) => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(geo, mat), new THREE.Mesh(engines, grey));
      const strobe = new THREE.Mesh(new THREE.SphereGeometry(0.6, 6, 4), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      strobe.position.set(0, 2.2, -10);
      g.add(strobe);
      for (const [x, c] of [[-18, 0xff2020], [18, 0x20ff60]]) {
        const l = new THREE.Mesh(new THREE.SphereGeometry(0.5, 6, 4), new THREE.MeshBasicMaterial({ color: c }));
        l.position.set(x, -0.5, 1);
        g.add(l);
      }
      // Инверсионный след — длинная полупрозрачная лента позади
      const trail = new THREE.Mesh(new THREE.CylinderGeometry(4, 1.2, 2200, 8, 1, true).translate(0, -1100 - 25, 0).rotateX(Math.PI / 2), trailMat);
      trail.frustumCulled = false;
      g.add(trail);
      this.scene.add(g);
      return { g, strobe, dir: new THREE.Vector3(), timer: i * 40 };
    });
  }

  updatePlanes(dt, cam, weatherRain) {
    for (const p of this.planes) {
      p.timer -= dt;
      const far = Math.hypot(p.g.position.x - cam.x, p.g.position.z - cam.z);
      if (p.timer <= 0 && (far > 20000 || p.dir.lengthSq() === 0)) {
        // Новый пролёт: через небо над игроком, на высоте 3–4.5 км
        const a = Math.random() * 6.28, off = (Math.random() - 0.5) * 8000;
        p.dir.set(Math.cos(a), 0, Math.sin(a));
        p.g.position.set(cam.x - p.dir.x * 18000 - p.dir.z * off, 3000 + Math.random() * 1500, cam.z - p.dir.z * 18000 + p.dir.x * off);
        p.g.lookAt(_v.copy(p.g.position).add(p.dir));
        p.timer = 20 + Math.random() * 40;
      }
      p.g.position.addScaledVector(p.dir, 230 * dt);
      p.strobe.visible = (this.t % 1.6) < 0.08;
    }
    this.trailMat.uniforms.uOpacity.value = 0.35 * (1 - weatherRain);
  }

  // ================================================================ лодки
  createBoats() {
    const white = new THREE.MeshStandardMaterial({ color: 0xf0f0ec, roughness: 0.4 });
    const navy = new THREE.MeshStandardMaterial({ color: 0x1f2f45, roughness: 0.5 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x15202a, roughness: 0.05, metalness: 0.8 });
    const sail = new THREE.MeshStandardMaterial({ color: 0xfaf8f0, roughness: 0.8, side: THREE.DoubleSide });
    const red = new THREE.MeshStandardMaterial({ color: 0xa8302a, roughness: 0.5 });
    const wakeMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'varying vec2 vUv; void main(){ float edge = 1.0 - abs(vUv.x - 0.5) * 2.0; float a = (1.0 - vUv.y) * smoothstep(0.0, 0.5, edge) * 0.55; gl_FragColor = vec4(vec3(0.92, 0.96, 1.0), a); }',
    });
    const hull = (L, W, H, mat) => {
      const g = new THREE.CylinderGeometry(W / 2, W / 2.6, L, 10, 1).rotateX(Math.PI / 2).scale(1, H / W, 1);
      const m = new THREE.Mesh(g, mat); m.castShadow = true; return m;
    };
    const make = (type) => {
      const g = new THREE.Group();
      let L;
      if (type === 'yacht') {
        L = 14;
        g.add(hull(L, 4, 2.2, white));
        const cab = new THREE.Mesh(new THREE.BoxGeometry(3, 1.6, 6), white); cab.position.set(0, 1.6, -0.5); g.add(cab);
        const win = new THREE.Mesh(new THREE.BoxGeometry(3.05, 0.6, 5), glass); win.position.set(0, 1.8, -0.5); g.add(win);
      } else if (type === 'sail') {
        L = 10;
        g.add(hull(L, 3, 1.6, navy));
        const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 13, 6), white); mast.position.set(0, 7, 0.5); g.add(mast);
        const sg = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 1.2, 0.4, 0, 13, 0.6, 0, 1.2, -4.2], 3));
        sg.computeVertexNormals();
        g.add(new THREE.Mesh(sg, sail));
      } else {
        L = 46;
        g.add(hull(L, 12, 4, white));
        const deck = new THREE.Mesh(new THREE.BoxGeometry(10, 3, 30), white); deck.position.set(0, 3.2, 0); g.add(deck);
        const band = new THREE.Mesh(new THREE.BoxGeometry(10.1, 1.0, 30.1), glass); band.position.set(0, 3.6, 0); g.add(band);
        const stack = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.4, 4, 10), red); stack.position.set(0, 6.5, -6); g.add(stack);
      }
      const wake = new THREE.Mesh(new THREE.PlaneGeometry(L * 0.9, L * 4).rotateX(-Math.PI / 2).translate(0, 0.05, -L * 2.3), wakeMat);
      g.add(wake);
      this.scene.add(g);
      return g;
    };
    const specs = [
      ['ferry', 4200, 400, 1100, 900, 7], ['yacht', 3600, -1800, 480, 300, 9], ['yacht', 5200, 2600, 700, 500, 11],
      ['sail', 3900, 1200, 350, 250, 4], ['sail', 4800, -3200, 600, 400, 5], ['sail', 6400, -600, 450, 450, 4.5],
    ];
    this.boats = specs.map(([type, cx, cz, rx, rz, speed]) => ({
      g: make(type), cx: QUAY_X + (cx - 2850), cz, rx, rz, speed, a: Math.random() * 6.28, dir: Math.random() < 0.5 ? 1 : -1,
    }));
  }

  updateBoats(dt, cam) {
    const show = cam.y < 6000;
    for (const b of this.boats) {
      b.g.visible = show && Math.hypot(b.cx - cam.x, b.cz - cam.z) < 9000;
      const per = Math.PI * (b.rx + b.rz);
      b.a += b.dir * (b.speed / per) * Math.PI * 2 * dt;
      const x = b.cx + Math.cos(b.a) * b.rx, z = b.cz + Math.sin(b.a) * b.rz;
      const tx = -Math.sin(b.a) * b.rx * b.dir, tz = Math.cos(b.a) * b.rz * b.dir;
      b.g.position.set(x, WORLD.waterLevel + Math.sin(this.t * 1.1 + b.cx) * 0.15, z);
      b.g.rotation.set(Math.sin(this.t * 0.9 + b.cz) * 0.03, Math.atan2(tx, tz), Math.sin(this.t * 0.7 + b.cx) * 0.04, 'YXZ');
    }
  }

  // ================================================================ события
  impulse(center, radius, force) {
    for (const f of this.flocks) if (f.center.distanceTo(center) < radius * 3 + 80) this.scatterFlock(f, center);
    const H = this.heli;
    if (H.g.visible && H.g.position.distanceTo(center) < radius + 6 && force > 10) {
      this.crashHeli(_v.subVectors(H.g.position, center).normalize().multiplyScalar(Math.min(40, force)));
    }
  }

  scareBirds(center, r) {
    for (const f of this.flocks) if (f.center.distanceTo(center) < r) this.scatterFlock(f, center);
  }

  update(dt, player, cam, night, rain) {
    this.t += dt;
    this.uTime.value = this.t;
    this.updateBirds(dt, player, cam);
    this.updateHeli(dt, player, cam, night);
    this.updatePlanes(dt, cam, rain);
    this.updateBoats(dt, cam);
  }

  reset() {
    const H = this.heli;
    if (H.state === 'gone' || H.state === 'crash') { H.state = 'gone'; H.timer = 0.1; }
  }

  mute() { this.world.audio?.setRotor(0); }
}

// Птица: тело, голова, хвост, два крыла (атрибут wing: −1…1 по размаху — для взмахов)
function makeBirdGeometry() {
  const parts = [];
  const add = (geo, color, wingFn) => {
    if (geo.index) geo = geo.toNonIndexed();
    geo.deleteAttribute('uv');
    const n = geo.attributes.position.count, p = geo.attributes.position;
    const col = new Float32Array(n * 3), w = new Float32Array(n), c = new THREE.Color(color);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; w[i] = wingFn ? wingFn(p.getX(i)) : 0; }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('wing', new THREE.BufferAttribute(w, 1));
    parts.push(geo);
  };
  add(new THREE.SphereGeometry(0.11, 6, 4).scale(0.75, 0.7, 1.7), 0xffffff);
  add(new THREE.SphereGeometry(0.06, 5, 4).translate(0, 0.04, 0.2), 0xe8e8e8);
  const tail = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.15, -0.08, 0, -0.32, 0.08, 0, -0.32], 3));
  tail.computeVertexNormals();
  add(tail, 0xdddddd);
  for (const s of [-1, 1]) {
    // Крыло: широкое у тела, заострённое к концу
    const v = [0, 0, 0.08, 0, 0, -0.09, s * 0.25, 0.01, -0.06, 0, 0, 0.08, s * 0.25, 0.01, -0.06, s * 0.25, 0.01, 0.07,
      s * 0.25, 0.01, 0.07, s * 0.25, 0.01, -0.06, s * 0.48, 0, -0.08];
    const wg = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    wg.computeVertexNormals();
    add(wg, 0xcfd2d6, (x) => Math.abs(x) / 0.48);
  }
  const g = mergeGeometries(parts);
  g.computeVertexNormals();
  return g;
}
