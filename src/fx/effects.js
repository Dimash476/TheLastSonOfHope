import * as THREE from 'three';
import { MACH } from '../config.js';
import { smoothstep, clamp } from '../utils.js';

// Визуальные эффекты: ударные волны, конус звукового барьера, линии скорости,
// тряска камеры, кратеры, вспышки света.
export class Effects {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.trauma = 0;
    // Экранный эффект удара (читает пост-обработка) и «толчок» поля зрения камеры
    this.impact = 0;
    this.impactCenter = new THREE.Vector2(0.5, 0.5);
    this.screenFlash = 0;
    this.fovKick = 0;
    this.chargeK = 0;
    this.shakeOffset = new THREE.Vector3();
    this.time = 0;

    // ---------- Ударные волны ----------
    this.waves = [];
    this.ringGeo = new THREE.RingGeometry(0.82, 1, 64, 1);
    this.sphereGeo = new THREE.SphereGeometry(1, 32, 16);
    this.waveMat = new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 1 }, uColor: { value: new THREE.Color(1, 1, 1) } },
      vertexShader: /* glsl */`
        varying vec3 vN; varying vec3 vV; varying vec2 vUv;
        void main() {
          vUv = uv;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal);
          vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform float uOpacity; uniform vec3 uColor;
        varying vec3 vN; varying vec3 vV; varying vec2 vUv;
        void main() {
          float rim = 1.0 - abs(dot(vN, vV));
          float a = pow(rim, 2.5) * uOpacity;
          gl_FragColor = vec4(uColor, a);
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    });
    this.ringMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    });

    // ---------- Конус звукового барьера ----------
    const coneGeo = new THREE.ConeGeometry(1, 1, 48, 8, true);
    coneGeo.translate(0, -0.5, 0); // вершина в начале координат
    coneGeo.rotateX(-Math.PI / 2); // основание конуса уходит вдоль +Z
    this.coneMat = new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 0 }, uTime: { value: 0 } },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform float uOpacity; uniform float uTime;
        varying vec2 vUv;
        float h(float x) { return fract(sin(x * 91.7) * 4375.5); }
        void main() {
          float along = vUv.y;                       // 1 у вершины, 0 у основания
          float streak = 0.6 + 0.4 * h(floor(vUv.x * 60.0) + floor(uTime * 20.0));
          float a = smoothstep(0.0, 0.45, along) * smoothstep(1.0, 0.85, along) * streak * uOpacity;
          gl_FragColor = vec4(vec3(1.0), a);
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    this.cone = new THREE.Mesh(coneGeo, this.coneMat);
    this.cone.visible = false;
    this.cone.renderOrder = 8;
    scene.add(this.cone);

    // ---------- Линии скорости (в пространстве камеры) ----------
    const N = 260;
    this.lineCount = N;
    this.linePos = new Float32Array(N * 6);
    this.lineData = [];
    for (let i = 0; i < N; i++) {
      const a = Math.random() * Math.PI * 2, r = 2.5 + Math.random() * 14;
      this.lineData.push({ x: Math.cos(a) * r, y: Math.sin(a) * r, z: -Math.random() * 120 });
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(this.linePos, 3).setUsage(THREE.DynamicDrawUsage));
    this.lineMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
    this.lines = new THREE.LineSegments(lg, this.lineMat);
    this.lines.frustumCulled = false;
    camera.add(this.lines);

    // ---------- Кратеры ----------
    this.craters = [];
    this.craterTex = makeCraterTexture();
    this.craterIdx = 0;
    for (let i = 0; i < 24; i++) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
        new THREE.MeshStandardMaterial({ map: this.craterTex, transparent: true, depthWrite: false, roughness: 1, polygonOffset: true, polygonOffsetFactor: -4 }),
      );
      m.visible = false;
      m.receiveShadow = true;
      scene.add(m);
      this.craters.push(m);
    }

    // ---------- Вспышка света ----------
    this.flashLight = new THREE.PointLight(0xffd9a0, 0, 120, 1.6);
    scene.add(this.flashLight);

    // ---------- Свечение кулака при зарядке ----------
    this.glow = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xffc860, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    scene.add(this.glow);

    // ---------- Остаточные изображения (рывок) ----------
    this.ghosts = [];
    this.ghostMat = new THREE.MeshBasicMaterial({ color: 0x8fb8ff, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false });

    // ---------- Огненный кокон при входе в атмосферу ----------
    const heatMat = this.waveMat.clone();
    heatMat.uniforms.uColor.value = new THREE.Color(2.5, 0.9, 0.3);
    this.heat = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), heatMat);
    this.heat.scale.set(1.6, 1.6, 3.2);
    this.heat.visible = false;
    scene.add(this.heat);
    this.sparkSink = null; // задаётся снаружи: система искр для огненного следа
  }

  ghost(root) {
    const g = root.clone();
    const mat = this.ghostMat.clone();
    g.traverse((o) => { if (o.isMesh) { o.material = mat; o.castShadow = false; o.receiveShadow = false; } });
    this.scene.add(g);
    this.ghosts.push({ g, mat, t: 0 });
  }

  // type: 'sphere' | 'ring' (горизонтальное кольцо) | 'disc' (кольцо, перпендикулярное dir)
  shockwave(pos, { radius = 30, life = 0.6, type = 'sphere', dir = null, opacity = 0.9, color = 0xffffff } = {}) {
    let mesh;
    if (type === 'sphere') {
      const mat = this.waveMat.clone();
      mat.uniforms.uColor.value = new THREE.Color(color);
      mesh = new THREE.Mesh(this.sphereGeo, mat);
    } else {
      const mat = this.ringMat.clone();
      mat.color = new THREE.Color(color);
      mesh = new THREE.Mesh(this.ringGeo, mat);
      if (type === 'ring') mesh.rotation.x = -Math.PI / 2;
      else if (dir) mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    }
    mesh.position.copy(pos);
    mesh.scale.setScalar(0.01);
    mesh.renderOrder = 7;
    this.scene.add(mesh);
    this.waves.push({ mesh, t: 0, life, radius, opacity, type });
  }

  flash(pos, intensity = 30) {
    this.flashLight.position.copy(pos);
    this.flashLight.intensity = Math.max(this.flashLight.intensity, intensity * 0.5);
  }

  // След удара на стене: дыра с трещинами. seg — номер секции (след исчезнет вместе с ней)
  wallDecal(pos, normal, size, seg) {
    if (!this.decals) {
      this.decals = [];
      this.decalIdx = 0;
      const tex = makeWallHoleTexture();
      for (let i = 0; i < 80; i++) {
        const m = new THREE.Mesh(
          new THREE.PlaneGeometry(1, 1),
          new THREE.MeshStandardMaterial({ map: tex, transparent: true, depthWrite: false, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -4 }),
        );
        m.visible = false;
        m.receiveShadow = true;
        this.scene.add(m);
        this.decals.push(m);
      }
    }
    const m = this.decals[this.decalIdx];
    this.decalIdx = (this.decalIdx + 1) % this.decals.length;
    m.position.copy(pos).addScaledVector(normal, 0.06);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    m.rotateZ(Math.random() * Math.PI * 2);
    m.scale.setScalar(size);
    m.userData.seg = seg;
    m.visible = true;
  }

  clearDecals(seg) {
    if (!this.decals) return;
    for (const m of this.decals) if (m.userData.seg === seg) m.visible = false;
  }

  crater(pos, size) {
    const m = this.craters[this.craterIdx];
    this.craterIdx = (this.craterIdx + 1) % this.craters.length;
    m.position.set(pos.x, pos.y + 0.05, pos.z);
    m.rotation.y = Math.random() * Math.PI * 2;
    m.scale.setScalar(size);
    m.visible = true;
  }

  clearCraters() {
    for (const c of this.craters) c.visible = false;
    if (this.decals) for (const m of this.decals) m.visible = false;
  }

  shake(amount) { this.trauma = clamp(this.trauma + amount, 0, 1); }

  // Удар по экрану: радиальная волна размытия из точки удара, цветовой сдвиг, вспышка,
  // камера на миг «врезается» (fov). Чем дальше удар от камеры, тем слабее.
  impactFX(strength, worldPos = null, flash = 0, fov = 0) {
    let k = strength;
    if (worldPos) {
      const d = worldPos.distanceTo(this.camera.position);
      k /= 1 + d / 90;
      const p = worldPos.clone().project(this.camera);
      if (p.z < 1) this.impactCenter.set(clamp(p.x * 0.5 + 0.5, 0, 1), clamp(p.y * 0.5 + 0.5, 0, 1));
      flash /= 1 + d / 120;
      fov /= 1 + d / 120;
    } else this.impactCenter.set(0.5, 0.5);
    this.impact = Math.max(this.impact, Math.min(1, k));
    this.screenFlash = Math.max(this.screenFlash, flash);
    this.fovKick = Math.max(this.fovKick, fov);
  }

  setCharge(pos, k) {
    this.glow.position.copy(pos);
    this.glow.material.opacity = k * 0.9;
    this.glow.scale.setScalar(0.6 + k * 2.2 + Math.sin(this.time * 40) * 0.15 * k);
  }

  update(dt, player) {
    this.time += dt;
    this.impact *= Math.exp(-dt * 5);
    this.screenFlash *= Math.exp(-dt * 9);
    this.fovKick *= Math.exp(-dt * 6);

    // Волны
    for (let i = this.waves.length - 1; i >= 0; i--) {
      const w = this.waves[i];
      w.t += dt;
      const t = w.t / w.life;
      if (t >= 1) {
        this.scene.remove(w.mesh);
        w.mesh.material.dispose();
        this.waves.splice(i, 1);
        continue;
      }
      const e = 1 - (1 - t) ** 3;
      w.mesh.scale.setScalar(Math.max(0.01, e * w.radius));
      const a = w.opacity * (1 - t);
      if (w.type === 'sphere') w.mesh.material.uniforms.uOpacity.value = a;
      else w.mesh.material.opacity = a;
    }

    for (let i = this.ghosts.length - 1; i >= 0; i--) {
      const gh = this.ghosts[i];
      gh.t += dt;
      gh.mat.opacity = 0.4 * (1 - gh.t / 0.3);
      if (gh.t >= 0.3) { this.scene.remove(gh.g); gh.mat.dispose(); this.ghosts.splice(i, 1); }
    }

    // Конус: ярче всего при переходе через Mach 1, затем слабее
    const speed = player.vel.length();

    // Вход в атмосферу: быстро вниз сквозь верхние слои
    const alt = player.pos.y;
    const heat = smoothstep(900, 3000, -player.vel.y) * smoothstep(2500, 9000, alt) * (1 - smoothstep(30000, 50000, alt));
    this.heat.visible = heat > 0.02;
    if (this.heat.visible) {
      const dir = player.vel.clone().normalize();
      this.heat.position.copy(player.pos).add(new THREE.Vector3(0, 1, 0)).addScaledVector(dir, 0.8);
      this.heat.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
      this.heat.material.uniforms.uOpacity.value = heat * (0.8 + 0.2 * Math.sin(this.time * 50));
      if (this.sparkSink && Math.random() < heat) {
        this.sparkSink.burst(this.heat.position, 3, { size: [0.6, 1.6], speed: 4, life: [0.2, 0.5], color: 0xff7a30 });
      }
    }
    const m = speed / MACH;
    const peak = smoothstep(0.85, 1.0, m) * (1 - smoothstep(1.05, 1.6, m) * 0.75);
    this.coneMat.uniforms.uOpacity.value = peak * 0.55;
    this.coneMat.uniforms.uTime.value = this.time;
    this.cone.visible = peak > 0.01;
    if (this.cone.visible) {
      const dir = player.vel.clone().normalize();
      this.cone.position.copy(player.pos).add(new THREE.Vector3(0, 1.0, 0)).addScaledVector(dir, 1.2);
      this.cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.negate());
      const len = 6 + 4 * smoothstep(1, 2, m);
      this.cone.scale.set(2.2, 2.2, len);
    }

    // Линии скорости
    const k = smoothstep(60, 500, speed);
    this.lineMat.opacity = k * 0.35;
    this.lines.visible = k > 0.01;
    if (this.lines.visible) {
      const move = speed * dt * 0.35;
      const len = 1 + k * 14;
      for (let i = 0; i < this.lineCount; i++) {
        const L = this.lineData[i];
        L.z += move;
        if (L.z > -2) L.z -= 120;
        const o = i * 6;
        this.linePos[o] = L.x; this.linePos[o + 1] = L.y; this.linePos[o + 2] = L.z;
        this.linePos[o + 3] = L.x; this.linePos[o + 4] = L.y; this.linePos[o + 5] = L.z - len;
      }
      this.lines.geometry.attributes.position.needsUpdate = true;
    }

    // Вспышка гаснет
    this.flashLight.intensity *= Math.exp(-dt * 9);

    // Тряска (trauma² даёт приятное затухание)
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
    const s = this.trauma * this.trauma;
    const t = this.time * 38;
    this.shakeOffset.set(
      (Math.sin(t * 1.1) + Math.sin(t * 2.3) * 0.5) * s * 0.9,
      (Math.sin(t * 1.7 + 1.3) + Math.sin(t * 2.9) * 0.5) * s * 0.9,
      0,
    );
  }

  clear() {
    for (const w of this.waves) { this.scene.remove(w.mesh); w.mesh.material.dispose(); }
    this.waves.length = 0;
    this.clearCraters();
  }
}

// Пробоина в стене: тёмная дыра, раскрошенный край, трещины
function makeWallHoleTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  // Раскрошенная зона
  const grd = g.createRadialGradient(128, 128, 10, 128, 128, 120);
  grd.addColorStop(0, 'rgba(60,55,50,0.9)');
  grd.addColorStop(0.5, 'rgba(90,85,78,0.5)');
  grd.addColorStop(1, 'rgba(90,85,78,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  // Неровная дыра
  g.fillStyle = 'rgba(8,8,10,0.97)';
  g.beginPath();
  for (let i = 0; i <= 24; i++) {
    const a = (i / 24) * Math.PI * 2, r = 30 + Math.random() * 22;
    const x = 128 + Math.cos(a) * r, y = 128 + Math.sin(a) * r;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.fill();
  // Трещины
  g.strokeStyle = 'rgba(20,18,16,0.85)';
  for (let i = 0; i < 12; i++) {
    let x = 128, y = 128, a = Math.random() * Math.PI * 2;
    g.lineWidth = 1 + Math.random() * 2.5;
    g.beginPath(); g.moveTo(x, y);
    for (let k = 0; k < 9; k++) {
      a += (Math.random() - 0.5) * 0.9;
      x += Math.cos(a) * 12; y += Math.sin(a) * 12;
      g.lineTo(x, y);
    }
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makeCraterTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grd.addColorStop(0, 'rgba(20,18,16,0.95)');
  grd.addColorStop(0.45, 'rgba(35,30,26,0.85)');
  grd.addColorStop(0.6, 'rgba(70,62,54,0.6)');
  grd.addColorStop(1, 'rgba(70,62,54,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  // Трещины
  g.strokeStyle = 'rgba(15,12,10,0.8)';
  for (let i = 0; i < 14; i++) {
    let x = 128, y = 128, a = Math.random() * Math.PI * 2;
    g.lineWidth = 2 + Math.random() * 2;
    g.beginPath(); g.moveTo(x, y);
    for (let k = 0; k < 8; k++) {
      a += (Math.random() - 0.5) * 0.8;
      x += Math.cos(a) * 14; y += Math.sin(a) * 14;
      g.lineTo(x, y);
    }
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
