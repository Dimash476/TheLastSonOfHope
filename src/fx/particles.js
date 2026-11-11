import * as THREE from 'three';

// Система частиц на Points: пыль (обычное смешивание) и искры/вспышки (аддитивное).
export class Particles {
  constructor(scene, { max = 3000, additive = false, color = 0xffffff, drag = 1.2 } = {}) {
    this.max = max;
    this.drag = drag;
    this.baseColor = new THREE.Color(color);

    const geo = new THREE.BufferGeometry();
    this.aPos = new Float32Array(max * 3);
    this.aSize = new Float32Array(max);
    this.aAlpha = new Float32Array(max);
    this.aColor = new Float32Array(max * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(this.aPos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.aSize, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.aAlpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.aColor, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo = geo;

    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.size0 = new Float32Array(max);
    this.size1 = new Float32Array(max);
    this.delay = new Float32Array(max);
    this.rise = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.alpha0 = new Float32Array(max);
    this.plume = new Uint8Array(max);
    this.next = 0;

    this.material = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 600 } },
      vertexShader: /* glsl */`
        attribute float aSize;
        attribute float aAlpha;
        attribute vec3 aColor;
        uniform float uScale;
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uScale / max(-mv.z, 0.1);
          // Не даём частицам у самой камеры закрывать весь экран
          vAlpha = aAlpha * smoothstep(0.5, 6.0, -mv.z);
          vColor = aColor;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c);
          float a = smoothstep(0.5, 0.0, d);
          ${additive ? 'a = a * a;' : 'a *= 0.85;'}
          if (a * vAlpha < 0.003) discard;
          gl_FragColor = vec4(vColor, a * vAlpha);
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });

    // Позиции частиц хранятся во float32 относительно своего начала (origin): в мировых числах
    // у Сатурна или Ксаррона (миллионы и миллиарды метров) пыль дрожала бы на метры и сотни метров.
    // Новая вспышка вдали от начала переносит его к себе
    this.origin = new THREE.Vector3();
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 6 : 5;
    scene.add(this.points);
  }

  setScale(heightPx, fovDeg) {
    this.material.uniforms.uScale.value = heightPx / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2));
  }

  // opts: size [min,max], speed, life [min,max], delay, rise (м/с² вверх), gravity, flat (разлёт по земле), color, dir, alpha,
  // plume (дым столбом: плотность держится почти до конца жизни, а не тает сразу)
  burst(pos, count, opts = {}) {
    const [smin, smax] = opts.size || [1, 3];
    const [lmin, lmax] = opts.life || [0.5, 1.5];
    const speed = opts.speed ?? 5;
    const color = opts.color ? new THREE.Color(opts.color) : this.baseColor;
    if (Math.abs(pos.x - this.origin.x) + Math.abs(pos.y - this.origin.y) + Math.abs(pos.z - this.origin.z) > 20000) this.rebase(pos);
    const O = this.origin;
    for (let n = 0; n < count; n++) {
      const i = this.next;
      this.next = (this.next + 1) % this.max;
      const i3 = i * 3;
      this.aPos[i3] = pos.x - O.x; this.aPos[i3 + 1] = pos.y - O.y; this.aPos[i3 + 2] = pos.z - O.z;

      let vx = Math.random() - 0.5, vy = Math.random() - 0.5, vz = Math.random() - 0.5;
      if (opts.flat) vy = Math.random() * 0.08;
      const l = Math.hypot(vx, vy, vz) || 1;
      const s = speed * (0.4 + Math.random() * 0.6) / l;
      vx *= s; vy *= s; vz *= s;
      if (opts.dir) {
        vx += opts.dir.x * speed; vy += opts.dir.y * speed; vz += opts.dir.z * speed;
      }
      this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;

      const sz = smin + Math.random() * (smax - smin);
      this.size0[i] = sz * 0.4;
      this.size1[i] = sz;
      this.life[i] = 0;
      this.maxLife[i] = lmin + Math.random() * (lmax - lmin);
      this.delay[i] = opts.delay ? Math.random() * opts.delay : 0;
      this.rise[i] = opts.rise || 0;
      this.grav[i] = opts.gravity || 0;
      this.alpha0[i] = opts.alpha ?? 1;
      this.plume[i] = opts.plume ? 1 : 0;

      const shade = 0.85 + Math.random() * 0.25;
      this.aColor[i3] = color.r * shade; this.aColor[i3 + 1] = color.g * shade; this.aColor[i3 + 2] = color.b * shade;
      this.aAlpha[i] = 0;
      this.aSize[i] = 0;
    }
  }

  // Перенести начало координат частиц в p: живые сдвигаются, совсем далёкие (после перелёта) гаснут
  rebase(p) {
    const dx = this.origin.x - p.x, dy = this.origin.y - p.y, dz = this.origin.z - p.z;
    const far = Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 1e6;
    for (let i = 0; i < this.max; i++) {
      if (this.maxLife[i] <= 0) continue;
      if (far) { this.maxLife[i] = 0; this.aAlpha[i] = 0; this.aSize[i] = 0; continue; }
      const i3 = i * 3;
      this.aPos[i3] += dx; this.aPos[i3 + 1] += dy; this.aPos[i3 + 2] += dz;
    }
    this.origin.copy(p);
    this.points.position.copy(p);
  }

  update(dt) {
    const drag = Math.exp(-this.drag * dt);
    const floor = 0.3 - this.origin.y;   // земля города (y = 0,3) в своих координатах
    for (let i = 0; i < this.max; i++) {
      const ml = this.maxLife[i];
      if (ml <= 0) continue;
      if (this.delay[i] > 0) { this.delay[i] -= dt; continue; }
      const t = (this.life[i] += dt) / ml;
      if (t >= 1) { this.maxLife[i] = 0; this.aAlpha[i] = 0; this.aSize[i] = 0; continue; }
      const i3 = i * 3;
      this.vel[i3] *= drag; this.vel[i3 + 1] = this.vel[i3 + 1] * drag + (this.rise[i] - this.grav[i]) * dt; this.vel[i3 + 2] *= drag;
      this.aPos[i3] += this.vel[i3] * dt;
      this.aPos[i3 + 1] = Math.max(floor, this.aPos[i3 + 1] + this.vel[i3 + 1] * dt);
      this.aPos[i3 + 2] += this.vel[i3 + 2] * dt;
      this.aSize[i] = this.size0[i] + (this.size1[i] - this.size0[i]) * Math.sqrt(t);
      this.aAlpha[i] = this.alpha0[i] * Math.min(1, t * 8) * (this.plume[i] ? 1 - t * t * t : (1 - t) * (1 - t));
    }
    const a = this.geo.attributes;
    a.position.needsUpdate = a.aSize.needsUpdate = a.aAlpha.needsUpdate = a.aColor.needsUpdate = true;
  }

  clear() { this.maxLife.fill(0); this.aAlpha.fill(0); }
}
