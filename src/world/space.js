import * as THREE from 'three';
import { SPACE } from '../config.js';
import { mulberry32 } from '../utils.js';

// Отдельная «космическая» сцена: звёзды, Земля-шар с атмосферой и облаками, Луна, Солнце.
// Рисуется ПЕРЕД основной сценой со своей камерой (огромная дальность прорисовки),
// а основная сцена рисуется поверх. Внизу у земли её закрывает небо.

const NOISE_GLSL = /* glsl */`
  float hash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float noise3(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash3(i), hash3(i + vec3(1,0,0)), f.x), mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), f.x), mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm3(vec3 p, int oct) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 8; i++) { if (i >= oct) break; s += a * noise3(p); p *= 2.02; a *= 0.5; }
    return s;
  }`;

export class Space {
  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, 1, 10, 3e6);
    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.uniforms = {
      uSun: { value: this.sunDir },
      uTime: { value: 0 },
      uStars: { value: 0 },
    };
    this.earthCenter = new THREE.Vector3(0, -SPACE.earthRadius, 0);
    this.moonCenter = new THREE.Vector3(...SPACE.moonPos);

    this.createStars();
    this.createEarth();
    this.createMoon();
    this.createSun();
  }

  createStars() {
    const N = 7000, rnd = mulberry32(5);
    const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), size = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const u = rnd() * 2 - 1, a = rnd() * Math.PI * 2, r = Math.sqrt(1 - u * u);
      pos[i * 3] = Math.cos(a) * r * 2e6; pos[i * 3 + 1] = u * 2e6; pos[i * 3 + 2] = Math.sin(a) * r * 2e6;
      const t = rnd();
      const c = new THREE.Color().setHSL(t < 0.3 ? 0.6 : t < 0.6 ? 0.1 : 0.0, 0.3 + rnd() * 0.3, 0.8 + rnd() * 0.2);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      size[i] = rnd() < 0.03 ? 3.5 : 1 + rnd() * 1.6;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */`
        attribute float aSize; attribute vec3 color; varying vec3 vColor;
        void main() { vColor = color; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = aSize; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: /* glsl */`
        uniform float uStars; varying vec3 vColor;
        void main() { float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d);
          gl_FragColor = vec4(vColor * 2.0, a * uStars); }`,
      transparent: true, depthWrite: false,
    });
    this.stars = new THREE.Points(geo, mat);
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);
  }

  createEarth() {
    const R = SPACE.earthRadius;
    const earthMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */`
        varying vec3 vN; varying vec3 vW;
        void main() { vN = normalize(position); vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */`
        uniform vec3 uSun;
        varying vec3 vN; varying vec3 vW;
        ${NOISE_GLSL}
        void main() {
          vec3 n = normalize(vN);
          float h = fbm3(n * 4.0 + vec3(3.1, 1.7, 0.4), 7);
          // Наш регион (верх шара) — всегда суша
          h += smoothstep(0.985, 0.999, n.y) * 0.25;
          float land = smoothstep(0.5, 0.52, h);
          float detail = fbm3(n * 60.0, 4);
          vec3 ocean = mix(vec3(0.01, 0.05, 0.14), vec3(0.03, 0.12, 0.25), smoothstep(0.35, 0.5, h));
          vec3 ground = mix(vec3(0.12, 0.22, 0.07), vec3(0.35, 0.3, 0.18), smoothstep(0.55, 0.7, h + detail * 0.15));
          ground = mix(ground, vec3(0.5, 0.48, 0.45), smoothstep(0.72, 0.8, h));
          float ice = smoothstep(0.85, 0.92, abs(n.z));
          vec3 col = mix(ocean, ground, land);
          col = mix(col, vec3(0.9, 0.93, 0.96), ice);
          float diff = dot(n, uSun);
          float day = smoothstep(-0.12, 0.25, diff);
          vec3 lit = col * (0.03 + 1.6 * max(diff, 0.0));
          // Огни городов на ночной стороне
          float cityLights = land * (1.0 - ice) * step(0.8, fbm3(n * 90.0, 3)) * (1.0 - day);
          lit += vec3(1.0, 0.75, 0.4) * cityLights * 0.6;
          // Атмосферная дымка к краю диска
          vec3 v = normalize(cameraPosition - vW);
          float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
          lit = mix(lit, vec3(0.35, 0.55, 1.0) * (0.15 + 0.9 * day), rim * 0.7);
          gl_FragColor = vec4(lit, 1.0);
        }`,
    });
    this.earth = new THREE.Mesh(new THREE.SphereGeometry(R, 192, 96), earthMat);
    this.earth.position.copy(this.earthCenter);
    this.scene.add(this.earth);

    // Облака
    const cloudMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */`
        varying vec3 vN;
        void main() { vN = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform vec3 uSun; uniform float uTime;
        varying vec3 vN;
        ${NOISE_GLSL}
        void main() {
          vec3 n = normalize(vN);
          float c = fbm3(n * 7.0 + vec3(uTime * 0.002, 0.0, 0.0), 6);
          c = smoothstep(0.5, 0.75, c);
          float diff = max(dot(n, uSun), 0.0);
          gl_FragColor = vec4(vec3(1.0) * (0.04 + 1.5 * diff), c * 0.85);
        }`,
      transparent: true, depthWrite: false,
    });
    this.clouds = new THREE.Mesh(new THREE.SphereGeometry(R * 1.006, 128, 64), cloudMat);
    this.clouds.position.copy(this.earthCenter);
    this.scene.add(this.clouds);

    // Свечение атмосферы по краю
    const atmoMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */`
        varying vec3 vN; varying vec3 vW;
        void main() { vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */`
        uniform vec3 uSun;
        varying vec3 vN; varying vec3 vW;
        void main() {
          vec3 v = normalize(vW - cameraPosition);
          float rim = pow(max(dot(vN, v), 0.0), 2.5);
          float day = smoothstep(-0.3, 0.4, dot(normalize(vN), uSun));
          gl_FragColor = vec4(vec3(0.3, 0.55, 1.0) * rim * (0.2 + 1.8 * day), rim);
        }`,
      transparent: true, depthWrite: false, side: THREE.BackSide, blending: THREE.AdditiveBlending,
    });
    this.atmo = new THREE.Mesh(new THREE.SphereGeometry(R * 1.035, 128, 64), atmoMat);
    this.atmo.position.copy(this.earthCenter);
    this.scene.add(this.atmo);
  }

  createMoon() {
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */`
        varying vec3 vN;
        void main() { vN = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform vec3 uSun;
        varying vec3 vN;
        ${NOISE_GLSL}
        // Кратеры: ячейки с «чашами»
        float craters(vec3 p) {
          vec3 i = floor(p), f = fract(p);
          float r = 0.0;
          for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
            vec3 g = vec3(x, y, z);
            vec3 o = vec3(hash3(i + g), hash3(i + g + 7.1), hash3(i + g + 13.7));
            float d = length(g + o - f);
            float s = 0.25 + 0.3 * hash3(i + g + 3.3);
            r += smoothstep(s, s * 0.7, d) * 0.6 - smoothstep(s * 1.15, s, d) * smoothstep(s * 0.85, s, d) * 0.5;
          }
          return r;
        }
        void main() {
          vec3 n = normalize(vN);
          float h = fbm3(n * 5.0, 6);
          float c = craters(n * 14.0) * 0.6 + (fbm3(n * 80.0, 3) - 0.5) * 0.4;
          vec3 col = mix(vec3(0.32), vec3(0.62, 0.61, 0.58), smoothstep(0.35, 0.65, h)) * (1.0 - c * 0.35);
          float diff = max(dot(n, uSun), 0.0);
          gl_FragColor = vec4(col * (0.015 + 1.7 * diff), 1.0);
        }`,
    });
    this.moon = new THREE.Mesh(new THREE.SphereGeometry(SPACE.moonRadius, 128, 64), mat);
    this.moon.position.copy(this.moonCenter);
    this.scene.add(this.moon);
  }

  createSun() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.15, 'rgba(255,248,230,1)');
    grd.addColorStop(0.35, 'rgba(255,220,160,0.35)');
    grd.addColorStop(1, 'rgba(255,200,120,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    this.sun = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: new THREE.Color(6, 5.6, 5), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    this.sun.scale.setScalar(160000);
    this.scene.add(this.sun);
  }

  // Ближайшее расстояние от точки до поверхности Земли или Луны
  surfaceDistance(p) {
    return Math.min(p.distanceTo(this.earthCenter) - SPACE.earthRadius, p.distanceTo(this.moonCenter) - SPACE.moonRadius);
  }

  update(dt, mainCamera, sunDir, spaceK, nightK) {
    this.uniforms.uTime.value += dt;
    this.sunDir.copy(sunDir);
    this.sun.position.copy(mainCamera.position).addScaledVector(sunDir, 1.5e6);
    this.sun.material.opacity = Math.max(spaceK, 0);
    // Звёзды: в космосе и ночью
    this.uniforms.uStars.value = Math.max(spaceK, nightK * 0.9);
    this.stars.position.copy(mainCamera.position);
    // Земля-шар и Луна нужны только высоко (внизу их закрывает рельеф)
    const high = mainCamera.position.y > 6000;
    this.earth.visible = this.clouds.visible = this.atmo.visible = high;
    this.moon.visible = high || nightK > 0.5;

    const cam = this.camera;
    cam.position.copy(mainCamera.position);
    cam.quaternion.copy(mainCamera.quaternion);
    cam.fov = mainCamera.fov;
    cam.aspect = mainCamera.aspect;
    // Ближняя плоскость — по расстоянию до ближайшей поверхности (точность глубины)
    cam.near = Math.min(5000, Math.max(1, this.surfaceDistance(cam.position) * 0.5));
    cam.far = 3e6;
    cam.updateProjectionMatrix();
  }
}
