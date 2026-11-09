import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { SPACE } from '../config.js';
import { BODIES } from './bodies.js';
import { NOISE_GLSL } from './space.js';

// Чёрная дыра за Солнцем. Рисуется не сеткой, а отдельным проходом сразу после космоса:
// для каждого пикселя луч идёт от камеры мимо дыры по настоящей траектории света
// (уравнение фотона у шварцшильдовской дыры), поэтому звёзды, Солнце и планеты за ней
// искривляются и раздваиваются в кольцо, тень и фотонное кольцо получаются сами,
// а дальняя половина аккреционного диска загибается дугой над и под тенью.
// Вблизи дыра притягивает героя (на Shift и выше можно вырваться); за горизонтом — сцена падения
// и выброс в космос над Землёй.

const cfg = SPACE.blackHole;
const RS = cfg.rs;
const C = new THREE.Vector3(...cfg.pos);

// Ось диска: раскрыт к Земле на tilt градусов и повёрнут на небе на roll
const AXIS = (() => {
  const toEarth = C.clone().negate().normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const p = up.addScaledVector(toEarth, -up.dot(toEarth)).normalize();
  p.applyAxisAngle(toEarth, THREE.MathUtils.degToRad(cfg.roll));
  const t = THREE.MathUtils.degToRad(cfg.tilt);
  return p.multiplyScalar(Math.cos(t)).addScaledVector(toEarth, Math.sin(t)).normalize();
})();
const E1 = new THREE.Vector3(1, 0, 0).addScaledVector(AXIS, -AXIS.x).normalize();

// Для HUD: метка с названием и расстоянием (r — откуда ставить метку: над тенью)
export const BLACK_HOLE = { id: 'blackhole', name: cfg.name, c: C, r: RS * 3, rs: RS, axis: AXIS };

const MAX_BODIES = 10;
const BMAX = 40;     // в радиусах горизонта: зона, где дыра заметно искажает картинку

const LENS_F = /* glsl */`
  uniform sampler2D tDiffuse;
  uniform mat4 uInvProj, uProj;
  uniform mat3 uCamRot;
  uniform vec3 uBH, uN, uE1;
  uniform float uRin, uRout, uTime, uFall, uAspect;
  uniform int uSteps, uNB;
  uniform vec4 uBodies[${MAX_BODIES}];
  varying vec2 vUv;
  ${NOISE_GLSL}

  const float BMAX = ${BMAX.toFixed(1)};

  // Повернуть направление v в плоскости (v, к центру) на угол a
  vec3 bend(vec3 v, vec3 x, float a) {
    vec3 toC = -x - dot(-x, v) * v;
    float l = length(toC);
    if (l < 1e-6 || a <= 0.0) return v;
    return normalize(v * cos(a) + toC / l * sin(a));
  }

  // Ближайшее попадание прямого луча в тело (t > 0), иначе -1
  float hitBody(vec3 ro, vec3 rd) {
    float best = -1.0;
    for (int i = 0; i < ${MAX_BODIES}; i++) {
      if (i >= uNB) break;
      vec3 oc = ro - uBodies[i].xyz;
      float b = dot(oc, rd), c = dot(oc, oc) - uBodies[i].w * uBodies[i].w;
      float h = b * b - c;
      if (h < 0.0) continue;
      float t = -b - sqrt(h);
      if (t > 0.0 && (best < 0.0 || t < best)) best = t;
    }
    return best;
  }

  // Цвет раскалённого газа по температуре (1 — у внутреннего края): тёмно-красный → оранжевый →
  // жёлто-белый → голубовато-белый
  vec3 heat(float t) {
    vec3 c = mix(vec3(0.5, 0.05, 0.01), vec3(1.0, 0.36, 0.07), smoothstep(0.15, 0.5, t));
    c = mix(c, vec3(1.0, 0.78, 0.48), smoothstep(0.45, 0.95, t));
    c = mix(c, vec3(0.82, 0.9, 1.15), smoothstep(1.05, 1.8, t));
    return c;
  }

  // Звёзды там, куда луч уходит за край экрана
  vec3 stars(vec3 d) {
    vec3 q = d * 260.0, i = floor(q), f = fract(q) - 0.5;
    float h = hash3(i);
    float s = smoothstep(0.985, 1.0, h) * smoothstep(0.42, 0.0, length(f));
    return vec3(0.9, 0.93, 1.0) * s * 1.4;
  }

  // Излучение диска в точке p (луч идёт по v): rgb и непрозрачность
  vec4 disk(vec3 p, vec3 v) {
    float r = length(p);
    vec3 e2 = cross(uN, uE1);
    float ph = atan(dot(p, e2), dot(p, uE1));
    // Кеплерово вращение: внутренние слои быстрее. Узор крутится двумя фазами со сменой,
    // чтобы спирали не закручивались до бесконечности
    float om = sqrt(0.5 / (r * r * r)) * 3.2;
    const float P = 9.0;
    float t1 = fract(uTime / P), t2 = fract(uTime / P + 0.5);
    float w1 = 1.0 - abs(2.0 * t1 - 1.0);
    float a1 = ph - om * t1 * P, a2 = ph - om * t2 * P;
    float lr = log(r);
    float n1 = fbm3(vec3(cos(a1) * 4.5, sin(a1) * 4.5, lr * 6.0), 5);
    float n2 = fbm3(vec3(cos(a2) * 4.5, sin(a2) * 4.5, lr * 6.0) + 7.3, 5);
    // Крупные сгустки плазмы поверх тонких прожилок
    float clump = mix(fbm3(vec3(cos(a2) * 1.6, sin(a2) * 1.6, lr * 2.2) + 3.1, 3), fbm3(vec3(cos(a1) * 1.6, sin(a1) * 1.6, lr * 2.2) + 3.1, 3), w1);
    float n = mix(n2, n1, w1);
    // Кольцевые полосы и прожилки
    float bands = 0.78 + 0.22 * sin(lr * 22.0 + n * 7.0);
    float dens = clamp((n - 0.3) * 2.0 + (clump - 0.5) * 1.6, 0.0, 1.0) * bands;
    // Температура: пик чуть дальше внутреннего края, наружу остывает
    float x = uRin / r;
    float T = pow(x, 0.75) * pow(max(1.0 - sqrt(x), 0.0), 0.25) * 2.05;
    // Доплер: сторона, летящая к нам, ярче и голубее; у самой дыры свет краснеет
    float beta = min(0.75, sqrt(0.5 / max(r - 1.0, 0.2)));
    vec3 vel = normalize(cross(uN, p)) * beta;
    float gam = inversesqrt(1.0 - beta * beta);
    float dop = 1.0 / (gam * (1.0 - dot(vel, -v)));
    float g = dop * sqrt(max(1.0 - 1.0 / r, 0.0));
    float te = T * g;
    vec3 col = heat(te) * (0.2 + 1.5 * te * te) * pow(g, 3.0);
    col *= 0.55 + 0.9 * dens;
    float edge = smoothstep(uRin * 0.97, uRin * 1.06, r) * (1.0 - smoothstep(uRout * 0.62, uRout, r));
    float a = clamp((0.35 + 0.75 * dens) * (0.45 + 0.6 * T), 0.0, 0.96) * edge;
    return vec4(col * 2.4 * edge, a);
  }

  void main() {
    vec4 base = texture2D(tDiffuse, vUv);
    vec4 vp = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
    vec3 rd = normalize(uCamRot * normalize(vp.xyz / vp.w));
    vec3 ro = -uBH;                       // камера относительно дыры, в радиусах горизонта
    float D = length(ro);
    float tc = -dot(ro, rd);              // где луч ближе всего к дыре
    float b = length(cross(ro, rd));      // прицельное расстояние

    vec3 col = vec3(0.0);
    float T = 1.0;
    vec3 dirF = rd;
    bool captured = false;
    if (b > uRout * 3.2 && D > BMAX && uFall <= 0.0) { gl_FragColor = base; return; }
    // Тело ближе дыры заслоняет её
    float tb = hitBody(ro, rd);
    if (tb > 0.0 && (tb < tc || tc < 0.0)) { gl_FragColor = base; return; }

    // Точный расчёт луча — только внутри сферы RB вокруг диска; снаружи свет отклоняется слабо,
    // и этот хвост (до входа и после выхода) считается по формуле слабого поля
    float RB = uRout * 1.3;
    // Снаружи сферы луч входит в неё, только если дыра впереди: иначе за спиной появлялась вторая
    if ((b < RB && tc > 0.0) || D < RB) {
      vec3 x = ro, v = rd;
      if (D > RB) {
        float L = sqrt(max(RB * RB - b * b, 0.0));
        x = ro + rd * (tc - L);
        v = bend(rd, x, (1.0 - L / RB) / max(b, 1e-3));
      }
      vec3 h = cross(x, v);
      float h2 = dot(h, h);
      float rmin = length(x);
      for (int i = 0; i < 200; i++) {
        if (i >= uSteps) break;
        float r = length(x);
        rmin = min(rmin, r);
        if (r < 1.0) { captured = true; break; }
        if (r > RB + 0.01 && dot(x, v) > 0.0) break;
        float dt = clamp(r * mix(0.05, 0.14, smoothstep(2.5, 8.0, r)), 0.012, 3.0);
        float r5 = r * r; r5 *= r5 * r;
        vec3 a = -1.5 * h2 * x / r5;
        vec3 xn = x + v * dt + 0.5 * a * dt * dt;
        float rn = length(xn), rn5 = rn * rn; rn5 *= rn5 * rn;
        v += 0.5 * (a - 1.5 * h2 * xn / rn5) * dt;
        // Пересечение плоскости диска
        float y0 = dot(x, uN), y1 = dot(xn, uN);
        if (y0 * y1 < 0.0) {
          vec3 p = mix(x, xn, y0 / (y0 - y1));
          float rp = length(p);
          if (rp > uRin * 0.95 && rp < uRout) {
            vec4 e = disk(p, normalize(v));
            col += T * e.rgb * e.a;
            T *= 1.0 - e.a;
          }
        }
        x = xn;
        if (T < 0.02) break;
      }
      // Остаток отклонения после выхода из сферы
      vec3 vh = normalize(v);
      if (!captured) {
        float bb = length(cross(x, vh)), sx = dot(x, vh);
        dirF = bend(vh, x, (1.0 - sx / length(x)) / max(bb, 1e-3));
      }
      // Сильное искажение неба — только около дыры: с Земли звёзды не размазываются по всему небу
      float kf = 1.0 - smoothstep(uRout * 1.6, uRout * 3.2, b);
      if (!captured) dirF = normalize(mix(rd, dirF, kf));
      // Фотонное кольцо: лучи с моментом у критического (3√3/2) обходят дыру у сферы фотонов
      // (только те, что к ней подошли: луч от дыры наружу с тем же моментом кольца не даёт)
      if (!captured) col += T * vec3(1.0, 0.86, 0.68) * 1.8 * exp(-pow((sqrt(h2) - 2.598) / 0.03, 2.0)) * (1.0 - smoothstep(1.8, 2.4, rmin));
    } else {
      // Слабое отклонение вдали от дыры, плавно на нет к 3,2 внешних радиуса диска.
      // Считается от камеры до бесконечности: если дыра позади, луч почти не гнётся
      float k = 1.0 - smoothstep(uRout * 1.6, uRout * 3.2, b);
      dirF = bend(rd, ro, (1.0 - dot(ro, rd) / D) / b * k);
    }

    vec3 bg = vec3(0.0);
    if (!captured) {
      vec3 vv = transpose(uCamRot) * dirF;
      vec4 cl = uProj * vec4(vv, 1.0);
      vec2 uv2 = cl.xy / cl.w * 0.5 + 0.5;
      float tb2 = hitBody(ro, dirF);
      bool fore = tb2 > 0.0 && tb2 < D;   // там на экране тело перед дырой — его не берём
      if (vv.z < 0.0 && all(greaterThan(uv2, vec2(0.0))) && all(lessThan(uv2, vec2(1.0))) && !fore)
        bg = texture2D(tDiffuse, uv2).rgb;
      else bg = stars(dirF);
    }
    vec3 outc = col + T * bg;

    // Падение за горизонт: внешний мир сжимается в светлое кольцо и гаснет
    if (uFall > 0.0) {
      vec2 c = (vUv - 0.5) * vec2(uAspect, 1.0);
      float rr = length(c);
      float R = mix(0.75, 0.0, smoothstep(0.0, 1.0, uFall));
      vec2 suv = 0.5 + (vUv - 0.5) * (0.75 / max(R, 0.02)) * 0.35;
      vec3 inside = texture2D(tDiffuse, clamp(suv, 0.0, 1.0)).rgb * vec3(0.7, 0.9, 1.5) * (1.0 + 3.0 * uFall);
      float ang = atan(c.y, c.x);
      float streak = 0.6 + 0.4 * noise3(vec3(ang * 9.0, rr * 4.0 - uTime * 6.0, 2.0));
      vec3 ring = vec3(0.8, 0.9, 1.3) * exp(-pow((rr - R) / (0.012 + 0.03 * R), 2.0)) * (3.0 + 6.0 * uFall) * streak;
      vec3 fall = (rr < R ? inside : vec3(0.0)) + ring;
      outc = mix(outc, fall, smoothstep(0.0, 0.12, uFall));
    }
    gl_FragColor = vec4(outc, 1.0);
  }`;

// Проход линзы: читает картинку космоса и рисует поверх неё дыру с искривлённым фоном
class LensPass extends Pass {
  constructor() {
    super();
    this.uniforms = {
      tDiffuse: { value: null },
      uInvProj: { value: new THREE.Matrix4() }, uProj: { value: new THREE.Matrix4() }, uCamRot: { value: new THREE.Matrix3() },
      uBH: { value: new THREE.Vector3() }, uN: { value: AXIS }, uE1: { value: E1 },
      uRin: { value: cfg.disk[0] }, uRout: { value: cfg.disk[1] }, uTime: { value: 0 }, uFall: { value: 0 }, uAspect: { value: 1 },
      uSteps: { value: 160 }, uNB: { value: 0 },
      uBodies: { value: Array.from({ length: MAX_BODIES }, () => new THREE.Vector4()) },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: LENS_F,
      depthTest: false, depthWrite: false,
    });
    this.fsQuad = new FullScreenQuad(this.material);
  }

  render(renderer, writeBuffer, readBuffer) {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.fsQuad.render(renderer);
  }

  dispose() { this.material.dispose(); this.fsQuad.dispose(); }
}

const _rel = new THREE.Vector3(), _t = new THREE.Vector3(), _m = new THREE.Matrix4(), _f = new THREE.Vector3();

export class BlackHole {
  constructor(scene) {
    this.world = null;
    this.pass = new LensPass();
    // Свет диска на героя: у дыры он тёплый силуэт на фоне тени, а не чёрное пятно на чёрном
    this.glow = new THREE.DirectionalLight(0xffb27a, 0);
    scene.add(this.glow, this.glow.target);
    this.fall = null;      // сцена падения: { t, from }
    this.near = false;
    this.rumble = null;
    this.steps = 160;
  }

  // Качество: шагов луча меньше на слабой графике
  setQuality(i) { this.steps = [160, 120, 80][i] ?? 120; }

  // Видна ли дыра (вместе с зоной искажения) в кадре
  inView(cam) {
    _rel.copy(C).sub(cam.position);
    const d = _rel.length(), R = RS * BMAX * 1.2;
    if (d < R) return true;
    _f.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const ang = Math.acos(THREE.MathUtils.clamp(_rel.dot(_f) / d, -1, 1));
    const half = THREE.MathUtils.degToRad(cam.fov * 0.5) * Math.hypot(1, cam.aspect);
    return ang < half + Math.asin(Math.min(1, R / d));
  }

  // Направление на дыру (для «призрака» сквозь дневное небо)
  skyHole(camPos) { return _t.copy(C).sub(camPos).normalize(); }

  update(dt, camera, spaceCam, earthCenter, earthR) {
    const U = this.pass.uniforms;
    U.uTime.value += dt;
    U.uSteps.value = this.steps;
    U.uAspect.value = camera.aspect;
    spaceCam.updateMatrixWorld();
    U.uInvProj.value.copy(spaceCam.projectionMatrixInverse);
    U.uProj.value.copy(spaceCam.projectionMatrix);
    U.uCamRot.value.setFromMatrix4(_m.extractRotation(spaceCam.matrixWorld));
    U.uBH.value.copy(C).sub(spaceCam.position).divideScalar(RS);
    // Тела, которые могут заслонить дыру (в радиусах горизонта, относительно камеры)
    let n = 0;
    const put = (c, r) => { if (n < MAX_BODIES) U.uBodies.value[n++].set((c.x - spaceCam.position.x) / RS, (c.y - spaceCam.position.y) / RS, (c.z - spaceCam.position.z) / RS, r / RS); };
    put(earthCenter, earthR);
    for (const b of BODIES) put(b.c, b.r);
    U.uNB.value = n;
    this.pass.enabled = this.fall !== null || this.inView(spaceCam);
  }

  // Притяжение, падение и выброс. Вызывается до хода героя
  tick(dt, player, camRig) {
    const W = this.world, U = this.pass.uniforms;
    if (W.planetMap?.active) { this.glow.intensity = 0; this.setRumble(0); return; }
    _rel.copy(C).sub(player.pos);
    const d = _rel.length(), r = d / RS;
    this.glow.intensity = this.fall ? 0 : 4 * (1 - THREE.MathUtils.smoothstep(r, 4, 70));
    this.glow.position.copy(player.pos).addScaledVector(_rel, 50 / d);
    this.glow.target.position.copy(player.pos);
    if (this.fall) return this.tickFall(dt, player, camRig);
    this.setRumble(THREE.MathUtils.clamp(1 - (r - 2) / 40, 0, 1));
    const near = r < 30;
    if (near && !this.near) W.toast?.(cfg.name.toUpperCase(), 2.2);
    this.near = near;
    if (r > 40 || player.driven) return;
    // Тянет к центру и закручивает вдоль диска; на Shift и выше всегда можно вырваться.
    // Земля в ~115 rs — до неё тяга не достаёт (сходит на нет к 40 rs)
    let vp = Math.min(400000, 20000 * (10 / r) ** 2) * (1 - THREE.MathUtils.smoothstep(r, 25, 40));
    const speed = player.vel.length();
    if (player.boosting) vp = Math.min(vp, 0.5 * speed);
    _rel.divideScalar(d);
    _t.crossVectors(AXIS, _rel).normalize();
    player.pos.addScaledVector(_rel, vp * dt).addScaledVector(_t, vp * 0.35 * dt);
    if (r < 1.25) this.startFall(player);
    U.uFall.value = 0;
  }

  startFall(player) {
    const W = this.world;
    this.fall = { t: 0, flashed: false };
    player.vel.set(0, 0, 0);
    this.driven = (dt) => {
      // Героя медленно затягивает в центр, после вспышки он уже над Землёй и висит на месте
      player.vel.set(0, 0, 0);
      if (this.fall?.flashed) return;
      _rel.copy(C).sub(player.pos);
      player.pos.addScaledVector(_rel, 0.25 * dt);
    };
    player.driven = this.driven;
    const A = W.audio;
    if (A?.ctx) {
      A.tone({ dur: 3.2, from: 90, to: 18, gain: 0.5 });
      A.noiseBurst({ dur: 3.0, freq: 300, sweepTo: 40, gain: 0.45, attack: 1.2, brown: true });
    }
  }

  tickFall(dt, player, camRig) {
    const W = this.world, F = this.fall, U = this.pass.uniforms;
    F.t += dt;
    U.uFall.value = Math.min(1, (F.t / 2.6) ** 1.6);
    if (F.t > 2.6 && !F.flashed) {
      F.flashed = true;
      W.effects.screenFlash = 1.4;
      W.audio?.boom(1.2);
      // Выброс: в космос над Землёй, лицом к планете
      player.pos.set(0, 110000, 60000);
      player.vel.set(0, 0, 0);
      player.grounded = false; player.falling = false;   // висит в полёте, а не падает
      if (camRig) { camRig.yaw = 0; camRig.pitch = -0.7; }
    }
    if (F.t > 2.75) {
      U.uFall.value = 0;
      if (player.driven === this.driven) player.driven = null;
      this.fall = null;
      this.near = false;
    }
  }

  // Низкий гул у дыры: тон и шум, громче с приближением
  setRumble(k) {
    const A = this.world.audio;
    if (!A?.ctx || !A.master) return;
    if (!this.rumble) {
      if (k <= 0.001) return;
      const ctx = A.ctx;
      const g = ctx.createGain(); g.gain.value = 0;
      const o1 = ctx.createOscillator(); o1.type = 'sine'; o1.frequency.value = 31;
      const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = 46.5;
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.13;
      const lfoG = ctx.createGain(); lfoG.gain.value = 4;
      lfo.connect(lfoG).connect(o2.frequency);
      const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), ch = buf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < ch.length; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; ch[i] = last * 3.5; }
      const nz = ctx.createBufferSource(); nz.buffer = buf; nz.loop = true;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 160;
      const ng = ctx.createGain(); ng.gain.value = 0.6;
      o1.connect(g); o2.connect(g); nz.connect(lp).connect(ng).connect(g);
      g.connect(A.master);
      o1.start(); o2.start(); lfo.start(); nz.start();
      this.rumble = { g, lp };
    }
    const t = A.ctx.currentTime;
    this.rumble.g.gain.setTargetAtTime(0.32 * k * k, t, 0.4);
    this.rumble.lp.frequency.setTargetAtTime(120 + 260 * k, t, 0.4);
  }

  reset() {
    this.pass.uniforms.uFall.value = 0;
    this.fall = null;
    this.glow.intensity = 0;
    this.setRumble(0);
  }
}
