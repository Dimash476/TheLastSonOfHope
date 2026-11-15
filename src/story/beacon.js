import * as THREE from 'three';
import { groundHeight } from '../world/layout.js';
import { WORLD } from '../config.js';

// Знак в мире — зов к следующей главе вместо метки на экране. Его видно издалека:
//  pillar — тонкий столб тёплого света до облаков (дом, маяк);
//  smoke  — чёрный дым пожара, клонится по ветру;
//  dust   — широкая бурая пыль над горой.
// Вблизи знак гаснет, чтобы не слепить и не закрывать само место.

const KINDS = {
  pillar: { h: 4200, r: 14, top: 1.0, lean: 0, color: 0xffe2b0, add: true, near: 600, alpha: 0.55 },
  smoke: { h: 1400, r: 70, top: 3.2, lean: 350, color: 0x2a2724, add: false, near: 250, alpha: 0.8 },
  dust: { h: 5200, r: 900, top: 1.6, lean: 1500, color: 0x8a7a62, add: false, near: 2500, alpha: 0.5 },
};

const VERT = `
  uniform float uTime, uTop, uLean;
  varying vec2 vUv; varying vec3 vW;
  void main() {
    vUv = uv;
    vec3 p = position;
    float y = uv.y;
    // Расширение кверху и лёгкий снос ветром
    p.xz *= mix(1.0, uTop, y);
    p.x += y * y * uLean * (0.85 + 0.15 * sin(uTime * 0.07));
    vec4 w = modelMatrix * vec4(p, 1.0);
    vW = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;

const FRAG = `
  uniform vec3 uColor, uCam;
  uniform float uTime, uAlpha, uNear, uAdd;
  varying vec2 vUv; varying vec3 vW;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }
  void main() {
    float y = vUv.y;
    // Края цилиндра мягкие: плотнее там, где смотрим «сквозь толщу»
    float edge = pow(abs(sin(vUv.x * 3.14159 * 2.0 + 0.6)), 0.6);
    float n = noise(vec2(vUv.x * 9.0, y * 6.0 - uTime * 0.12)) * 0.6 + noise(vec2(vUv.x * 23.0, y * 17.0 - uTime * 0.3)) * 0.4;
    float body = mix(1.0, n * 1.6, 1.0 - uAdd);
    float a = uAlpha * body * smoothstep(0.0, 0.04, y) * (1.0 - smoothstep(0.55, 1.0, y)) * mix(0.55, 1.0, edge);
    // Вблизи гаснет
    a *= smoothstep(uNear * 0.4, uNear, distance(uCam, vW));
    if (!(a > 0.002)) discard;
    gl_FragColor = vec4(uColor * mix(1.0, 1.0 + (1.0 - y) * 0.8, uAdd), clamp(a, 0.0, 1.0));
  }`;

export class Beacon {
  constructor(scene) {
    this.scene = scene;
    this.u = {
      uTime: { value: 0 }, uTop: { value: 1 }, uLean: { value: 0 }, uColor: { value: new THREE.Color() }, uCam: { value: new THREE.Vector3() },
      uAlpha: { value: 0 }, uNear: { value: 500 }, uAdd: { value: 1 },
    };
    this.mats = {
      add: new THREE.ShaderMaterial({ uniforms: this.u, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false }),
      norm: new THREE.ShaderMaterial({ uniforms: this.u, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
    };
    const geo = new THREE.CylinderGeometry(1, 1, 1, 32, 24, true).translate(0, 0.5, 0);
    this.mesh = new THREE.Mesh(geo, this.mats.add);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 5;
    scene.add(this.mesh);
    this.pos = new THREE.Vector3();
    this.on = false;
    this.k = 0;          // проявление 0..1
    this.r = 0;          // радиус, где зов «сработал»
  }

  // Поставить знак: call из CHAPTERS ({ kind, at: [x, z], r })
  show(call) {
    const K = KINDS[call.kind] || KINDS.pillar;
    const [x, z] = call.at;
    const y = Math.max(WORLD.waterLevel ?? 0, groundHeight(x, z));
    this.pos.set(x, y, z);
    this.mesh.position.copy(this.pos);
    this.mesh.scale.set(K.r, K.h, K.r);
    this.mesh.material = K.add ? this.mats.add : this.mats.norm;
    this.u.uColor.value.set(K.color);
    this.u.uTop.value = K.top;
    this.u.uLean.value = K.lean / K.r;
    this.u.uNear.value = K.near;
    this.u.uAdd.value = K.add ? 1 : 0;
    this.alpha = K.alpha;
    this.r = call.r ?? 800;
    this.on = true;
    this.k = 0;
    this.mesh.visible = true;
  }

  hide() {
    this.on = false;
  }

  // Долетел ли герой (по горизонтали и не выше вершины знака)
  reached(p) {
    if (!this.on) return false;
    return Math.hypot(p.x - this.pos.x, p.z - this.pos.z) < this.r && p.y < this.pos.y + this.mesh.scale.y;
  }

  update(dt, camera) {
    this.k += ((this.on ? 1 : 0) - this.k) * Math.min(1, dt * 0.8);
    if (!this.on && this.k < 0.01) { this.mesh.visible = false; return; }
    this.u.uTime.value += dt;
    this.u.uAlpha.value = this.alpha * this.k;
    this.u.uCam.value.copy(camera.position);
  }
}
