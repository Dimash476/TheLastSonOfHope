import * as THREE from 'three';
import { WORLD } from '../config.js';
import { groundHeight, HALF } from './layout.js';

// Астероид (Симулятор): время от времени к Земле летит каменная глыба ~120 м.
// Сначала — яркая точка в небе, которая растёт; в атмосфере камень раскаляется, за ним тянется
// огненный хвост и дым, слышен нарастающий гул. Перехватить можно где угодно:
//   • таран на скорости или удар рядом — астероид раскалывается, обломки сгорают огнём;
//   • медленное касание — герой упирается и несёт его: увёл вверх за атмосферу — улетел.
// Не успел — удар за городом: вспышка, ударная волна, воронка, столб пыли.
// Никаких надписей и заданий — всё читается в кадре.

const R = 60;                     // радиус глыбы, м
const SPEED = 3200;               // скорость подлёта, м/с
const START = 520000;             // путь от точки старта до цели, м
const NEAR = 45000;               // дальше — рисуем «звездой» на этом расстоянии (дальняя плоскость камеры 60 км)
const ATMO = 100000;              // ниже — трение о воздух, накал и хвост
const TRAIL = 3000;
const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
const _a = new THREE.Vector3();

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.15, 'rgba(255,230,180,0.9)');
  gr.addColorStop(0.4, 'rgba(255,140,60,0.35)'); gr.addColorStop(1, 'rgba(255,80,20,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

// Глыба: икосаэдр, продавленный шумом — неровный камень с гранями
function rockGeometry(seed) {
  const geo = new THREE.IcosahedronGeometry(1, 3);
  const P = geo.attributes.position;
  for (let i = 0; i < P.count; i++) {
    _v.fromBufferAttribute(P, i);
    const n = Math.sin(_v.x * 3.1 + seed) * Math.sin(_v.y * 2.7 + seed * 2) * Math.sin(_v.z * 3.3 - seed) * 0.22
      + Math.sin(_v.x * 7.3 - _v.z * 5.1 + seed) * 0.06;
    _v.multiplyScalar(1 + n).multiply(_a.set(1.15, 0.85, 1));
    P.setXYZ(i, _v.x, _v.y, _v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

export class Asteroid {
  constructor(scene, world) {
    this.world = world;
    this.scene = scene;
    this.state = 'idle';           // idle → fly → (carried) → gone
    this.timer = 170 + Math.random() * 90;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.spin = new THREE.Vector3();
    this.heat = 0;
    this.t = 0;
    this.carry = 0;
    this.rumbleT = 0;
    // Камень: тёмный базальт; накал — оранжевое свечение (emissive)
    this.mat = new THREE.MeshStandardMaterial({ color: 0x4a443e, roughness: 0.95, flatShading: true, emissive: 0xff5a1a, emissiveIntensity: 0 });
    this.rock = new THREE.Mesh(rockGeometry(1.7), this.mat);
    this.rock.scale.setScalar(R);
    this.rock.castShadow = true;
    this.rock.visible = false;
    scene.add(this.rock);
    // Сияние вокруг (вблизи) и «звезда» (издалека) — без тумана, поверх неба
    const tex = glowTexture();
    const sm = () => new THREE.SpriteMaterial({ map: tex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false, toneMapped: false });
    this.glow = new THREE.Sprite(sm());
    this.star = new THREE.Sprite(sm());
    this.glow.visible = this.star.visible = false;
    this.star.renderOrder = 5;
    scene.add(this.glow, this.star);
    // Огненный хвост и дым: точки с временем рождения, старение считает шейдер
    const pos = new Float32Array(TRAIL * 3), birth = new Float32Array(TRAIL).fill(-100), kind = new Float32Array(TRAIL);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aBirth', new THREE.BufferAttribute(birth, 1));
    geo.setAttribute('aKind', new THREE.BufferAttribute(kind, 1));
    this.trailMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uScale: { value: 700 } },
      vertexShader: `uniform float uTime, uScale; attribute float aBirth, aKind; varying float vAge; varying float vKind;
        void main() {
          float age = uTime - aBirth; vAge = age; vKind = aKind;
          vec3 p = position + vec3(0.0, age * 6.0 * aKind, 0.0);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          float sz = aKind > 0.5 ? 70.0 + age * 55.0 : 90.0 * (1.0 - age / 1.4);
          gl_PointSize = age < 0.0 || age > (aKind > 0.5 ? 16.0 : 1.4) ? 0.0 : max(0.0, sz) * uScale / max(1.0, -mv.z);
        }`,
      fragmentShader: `varying float vAge; varying float vKind;
        void main() {
          vec2 d = gl_PointCoord - 0.5; float r = dot(d, d) * 4.0; if (r > 1.0) discard;
          if (vKind > 0.5) {
            float a = (1.0 - r) * 0.3 * (1.0 - vAge / 16.0);
            gl_FragColor = vec4(vec3(0.42, 0.38, 0.36), a);
          } else {
            float k = clamp(vAge / 1.4, 0.0, 1.0);
            vec3 c = mix(vec3(1.0, 0.95, 0.7), vec3(1.0, 0.35, 0.08), k) * (2.2 - 1.6 * k);
            gl_FragColor = vec4(c, (1.0 - r) * (1.0 - k));
          }
        }`,
      transparent: true, depthWrite: false, toneMapped: false,
    });
    this.trail = new THREE.Points(geo, this.trailMat);
    this.trail.frustumCulled = false;
    this.trailIdx = 0;
    scene.add(this.trail);
    // Обломки после раскола: горящие куски разлетаются и гаснут
    this.frags = [];
    this.fragMesh = new THREE.InstancedMesh(rockGeometry(4.2), this.mat, 40);
    this.fragMesh.frustumCulled = false;
    this.fragMesh.count = 0;
    scene.add(this.fragMesh);
  }

  // Новый астероид: цель — за городом (5–9 км от центра), подлёт под 40–60° к горизонту
  spawn(target = null) {
    const a = Math.random() * Math.PI * 2, r = 5000 + Math.random() * 4000;
    const T = target ? target.clone() : new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
    T.y = groundHeight(T.x, T.z);
    const h = Math.random() * Math.PI * 2, el = THREE.MathUtils.degToRad(40 + Math.random() * 20);
    _d.set(Math.cos(h) * Math.cos(el), -Math.sin(el), Math.sin(h) * Math.cos(el));
    this.pos.copy(T).addScaledVector(_d, -START);
    this.vel.copy(_d).multiplyScalar(SPEED);
    this.spin.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.25);
    this.state = 'fly';
    this.heat = 0;
    this.carry = 0;
    this.rock.visible = true;
    this.mat.emissiveIntensity = 0;
    return T;
  }

  clear() {
    this.state = 'idle';
    this.timer = 300 + Math.random() * 240;
    this.rock.visible = this.glow.visible = this.star.visible = false;
    this.frags.length = 0;
    this.fragMesh.count = 0;
  }

  // ctx: { dt, player, camera, active (Симулятор у Земли), env }
  update({ dt, player, camera, active }) {
    this.t += dt;
    this.trailMat.uniforms.uTime.value = this.t;
    this.updateFrags(dt);
    if (this.state === 'idle') {
      if (active && (this.timer -= dt) <= 0) this.spawn();
      return;
    }
    if (!active) { this.clear(); return; }
    const P = player;
    // Полёт: тяготение и (в атмосфере) лёгкое торможение; накал растёт с плотностью воздуха
    const alt = this.pos.y;
    const air = THREE.MathUtils.clamp(1 - alt / ATMO, 0, 1);
    this.vel.y -= 9.8 * dt;
    if (air > 0 && this.carry <= 0) this.vel.multiplyScalar(1 - air * air * 0.04 * dt);
    const speed = this.vel.length();
    const heatT = air > 0 ? Math.min(1, air * 1.6) * THREE.MathUtils.smoothstep(speed, 300, 1500) : 0;
    this.heat += (heatT - this.heat) * Math.min(1, dt * 1.5);
    // Герой: столкновение по отрезку пути за кадр (на сверхскоростях точка проскочит)
    const p0 = _a.copy(P.pos).addScaledVector(P.vel, -dt);
    const rel = _v.copy(P.vel).sub(this.vel);
    const hit = segSphere(p0, P.pos, this.pos, R + 4 + speed * dt * 0.5);
    if (hit) {
      const relSpeed = rel.length();
      if (relSpeed > 600 || P.punchT >= 0 || P.dashT > 0) { this.shatter(P); return; }
      // Медленно — упирается и несёт: астероид движется вместе с героем, чуть впереди
      this.carry = 0.4;
      this.vel.lerp(P.vel, Math.min(1, dt * 8));
      _d.copy(this.pos).sub(P.pos).normalize();
      this.pos.copy(P.pos).addScaledVector(_d, R + 3.5);
    }
    this.carry -= dt;
    this.pos.addScaledVector(this.vel, dt);
    this.rock.rotation.x += this.spin.x * dt; this.rock.rotation.y += this.spin.y * dt; this.rock.rotation.z += this.spin.z * dt;
    // Унесли за атмосферу и толкнули прочь — улетел
    if (this.pos.y > 160000 && this.vel.y > 0) { this.clear(); return; }
    // Удар о землю или воду
    const gy = groundHeight(this.pos.x, this.pos.z);
    if (this.pos.y - R * 0.4 <= Math.max(gy, WORLD.waterLevel)) { this.impact(gy); return; }
    this.draw(camera, dt, speed);
  }

  draw(camera, dt, speed) {
    const d = this.pos.distanceTo(camera.position);
    const heat = this.heat;
    this.mat.emissiveIntensity = heat * 2.2;
    // Вблизи — сам камень и сияние вокруг; издалека — «звезда», растущая по мере подлёта
    this.rock.visible = d < NEAR + R;
    this.rock.position.copy(this.pos);
    this.glow.visible = this.rock.visible && heat > 0.02;
    this.glow.position.copy(this.pos);
    this.glow.scale.setScalar(R * (3 + heat * 5));
    this.glow.material.opacity = heat;
    this.star.visible = !this.rock.visible;
    if (this.star.visible) {
      _d.copy(this.pos).sub(camera.position).normalize();
      this.star.position.copy(camera.position).addScaledVector(_d, NEAR);
      // Видимый размер: не меньше яркой точки; в атмосфере — пылающий шар
      const ang = Math.max(R * (1 + heat * 6) / d, 0.012 + heat * 0.02);
      this.star.scale.setScalar(ang * NEAR * 2.4);
      this.star.material.opacity = 0.55 + 0.45 * heat;
      this.star.material.color.setRGB(1, 0.85 - heat * 0.35, 0.7 - heat * 0.5);
    }
    // Хвост: огонь у самого камня, дым дольше висит в небе
    if (heat > 0.05 && d < 70000) {
      const A = this.trail.geometry.attributes;
      const n = Math.ceil(heat * 10);
      for (let k = 0; k < n; k++) {
        const i = this.trailIdx = (this.trailIdx + 1) % TRAIL;
        const back = Math.random() * speed * dt;
        _v.copy(this.vel).normalize().multiplyScalar(-back - R * 0.6).add(this.pos);
        _v.x += (Math.random() - 0.5) * R * 1.2; _v.y += (Math.random() - 0.5) * R * 1.2; _v.z += (Math.random() - 0.5) * R * 1.2;
        A.position.setXYZ(i, _v.x, _v.y, _v.z);
        A.aBirth.setX(i, this.t - Math.random() * dt);
        A.aKind.setX(i, k % 3 === 0 ? 1 : 0);
      }
      A.position.needsUpdate = A.aBirth.needsUpdate = A.aKind.needsUpdate = true;
    }
    // Гул: нарастает с накалом и близостью
    const W = this.world;
    if (heat > 0.1 && d < 40000 && (this.rumbleT -= dt) <= 0) {
      this.rumbleT = 0.45;
      const k = heat * Math.min(1, 6000 / Math.max(800, d));
      W.audio?.noiseBurst({ dur: 0.9, freq: 160 + heat * 120, gain: 0.35 * k, attack: 0.25, brown: true });
    }
  }

  // Раскол: вспышка, ударная волна, горящие обломки разлетаются (вниз почти не падают — сгорают)
  shatter(P) {
    const W = this.world, p = this.pos.clone();
    W.effects?.flash(p, 60);
    W.effects?.shockwave(p, { radius: R * 9, life: 0.9, color: 0xffc080 });
    W.effects?.impactFX(1, p, 0.6, 6);
    W.sparks?.burst(p, 260, { speed: 220, life: [0.8, 2.2], size: [6, 16], color: 0xffb060 });
    W.dust?.burst(p, 160, { speed: 90, life: [3, 7], size: [25, 60] });
    W.audio?.explosion(1, p);
    W.audio?.boom(1, p);
    if (P) P.hitstop = Math.max(P.hitstop || 0, 0.12);
    for (let i = 0; i < 40; i++) {
      _d.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      this.frags.push({
        p: p.clone().addScaledVector(_d, R * 0.5), v: _d.clone().multiplyScalar(80 + Math.random() * 220).addScaledVector(this.vel, 0.3),
        s: R * (0.08 + Math.random() * 0.18), life: 4 + Math.random() * 4, rot: new THREE.Euler(Math.random() * 3, Math.random() * 3, 0),
      });
    }
    this.rock.visible = this.glow.visible = this.star.visible = false;
    this.state = 'idle';
    this.timer = 360 + Math.random() * 240;
  }

  updateFrags(dt) {
    if (!this.frags.length) return;
    const m = this.fragMesh, M = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    let n = 0;
    for (let i = this.frags.length - 1; i >= 0; i--) {
      const f = this.frags[i];
      f.life -= dt;
      if (f.life <= 0) { this.frags.splice(i, 1); continue; }
      f.v.y -= 9.8 * dt;
      f.v.multiplyScalar(1 - dt * 0.4);
      f.p.addScaledVector(f.v, dt);
      f.rot.x += dt * 2; f.rot.y += dt * 1.3;
      // Сгорают на лету: к концу жизни уменьшаются
      const k = Math.min(1, f.life / 2);
      M.compose(f.p, q.setFromEuler(f.rot), s.setScalar(f.s * k));
      m.setMatrixAt(n++, M);
      if (Math.random() < 0.5) this.world.sparks?.burst(f.p, 1, { speed: 6, life: [0.3, 0.8], size: [3, 7], color: 0xff8a3a });
    }
    m.count = n;
    m.instanceMatrix.needsUpdate = true;
  }

  // Падение: вспышка, ударная волна, воронка, пыль; в городе — рушит дома
  impact(gy) {
    const W = this.world;
    const wet = gy < WORLD.waterLevel;
    const p = this.pos.clone().setY(Math.max(gy, WORLD.waterLevel));
    W.effects?.flash(p, 120);
    W.effects?.shockwave(p, { radius: 1800, life: 2.6, type: 'ring', color: wet ? 0xe8f4ff : 0xffd0a0 });
    W.effects?.shockwave(p, { radius: 700, life: 1.4, color: 0xffa060 });
    W.effects?.impactFX(1, p, 1, 10);
    W.effects?.crater(p, 260);
    W.terrainFX?.crater(p, 420, 160);
    W.dust?.burst(p.clone().setY(p.y + 40), 500, { speed: 260, life: [6, 14], size: [60, 160], color: wet ? 0xe8eef2 : 0x8a7a68 });
    W.sparks?.burst(p, 300, { speed: 300, life: [1, 3], size: [8, 20], color: 0xffa040 });
    W.audio?.explosion(1, p);
    W.audio?.boom(1, p);
    W.impact?.(p, 1500, 900);
    // Если глыбу увели в город — разрушения
    if (Math.abs(p.x) < HALF + 300 && Math.abs(p.z) < HALF + 300) W.city?.damageRadius(p, 260, 1e6, 400);
    this.rock.visible = this.glow.visible = this.star.visible = false;
    this.state = 'idle';
    this.timer = 360 + Math.random() * 240;
  }
}

// Пересекает ли отрезок a→b сферу (c, r)
function segSphere(a, b, c, r) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const l2 = abx * abx + aby * aby + abz * abz;
  let t = l2 > 0 ? ((c.x - a.x) * abx + (c.y - a.y) * aby + (c.z - a.z) * abz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a.x + abx * t - c.x, y = a.y + aby * t - c.y, z = a.z + abz * t - c.z;
  return x * x + y * y + z * z < r * r;
}
