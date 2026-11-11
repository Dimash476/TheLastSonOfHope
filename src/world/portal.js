import * as THREE from 'three';
import { SPACE } from '../config.js';
import { ALL_BODIES, XARRON_ORIGIN } from './bodies.js';
import { WHITE_HOLE } from './blackhole.js';
import { NOISE_GLSL, LOGZ_V, LOGZ_V_MAIN, LOGZ_F, LOGZ_F_MAIN } from './space.js';

// Врата: кольцо с клубящейся гладью. Пролетел сквозь — на той стороне, у вторых врат (это решает wormhole.js).
// Врата Ксаррона висят на орбите планеты (в космической сцене), земные — в небе над окраиной (в основной).
// Описания врат нужны и HUD (метки с расстоянием), поэтому они считаются здесь же при загрузке

const Z = new THREE.Vector3(0, 0, 1);

function xarronGate() {
  const G = SPACE.xarron.gate, b = ALL_BODIES.find((x) => x.id === G.body);
  const n = WHITE_HOLE.c.clone().sub(b.c).normalize();
  return { id: 'gate-xarron', name: G.name, sys: 'xarron', c: b.c.clone().addScaledVector(n, b.r * G.alt), n, r: G.R, hidden: false };
}

export const XARRON_GATE = xarronGate();
export const EARTH_GATE = {
  id: 'gate-earth', name: SPACE.earthGate.name, sys: 'sol',
  c: new THREE.Vector3(...SPACE.earthGate.pos), n: new THREE.Vector3(...SPACE.earthGate.dir).normalize(),
  r: SPACE.earthGate.R, hidden: true,
};

const DISC_F = /* glsl */`
  uniform float uTime, uK, uFlare;
  varying vec2 vP;
  ${NOISE_GLSL}
  void main() {
    float r = length(vP);
    if (r > 1.0) discard;
    // Спираль затягивает к центру; угол — через cos/sin, чтобы не было шва
    float sw = atan(vP.y, vP.x) + 2.4 / (r + 0.25) - uTime * 0.9;
    float n = fbm3(vec3(cos(sw) * 2.0, sin(sw) * 2.0, r * 4.0 - uTime * 0.6), 4);
    vec3 col = mix(vec3(0.16, 0.07, 0.4), vec3(0.35, 0.55, 1.15), smoothstep(0.3, 0.75, n)) * (0.5 + 1.5 * n);
    col += vec3(1.0, 1.0, 1.1) * exp(-r * r * 14.0) * (1.4 + 2.5 * uFlare);
    col += vec3(0.6, 0.75, 1.3) * exp(-pow((r - 0.97) / 0.035, 2.0)) * 2.5;
    float a = smoothstep(1.0, 0.9, r) * uK;
    gl_FragColor = vec4(col * (1.0 + 2.5 * uFlare) * a, a);
    #ifdef LOGZ
    LOGZ_MAIN
    #endif
  }`;

const FRAME_F = /* glsl */`
  uniform float uTime, uK, uFlare; uniform vec3 uSun;
  varying vec3 vN, vL;
  void main() {
    vec3 N = normalize(vN);
    float ang = atan(vL.y, vL.x);
    vec3 col = vec3(0.12, 0.12, 0.15) * (0.25 + 0.9 * max(dot(N, uSun), 0.0));
    // Прорези-огни по кольцу и бегущий по ним импульс; внутренний край светится гладью
    float s = fract(ang / 6.2831853 * 36.0);
    float slit = 1.0 - smoothstep(0.03, 0.07, abs(s - 0.5));
    float run = exp(-pow(fract(ang / 6.2831853 - uTime * 0.12) - 0.5, 2.0) / 0.004);
    float inner = smoothstep(0.3, 0.9, dot(N, -normalize(vec3(vL.xy, 0.0))));
    col += vec3(0.45, 0.6, 1.3) * (slit * (0.9 + 1.6 * run) + inner * 0.7) * uK * (1.0 + 2.0 * uFlare);
    gl_FragColor = vec4(col, 1.0);
    #ifdef LOGZ
    LOGZ_MAIN
    #endif
  }`;

export class Portal {
  // logK — uLogK космической сцены (там логарифмическая глубина); для основной сцены — null
  constructor(scene, G, logK = null) {
    this.G = G;
    this.k = 0;          // насколько открыты (0…1)
    this.open = 1;       // куда идёт k
    this.flare = 0;
    const lz = !!logK;
    const u = { uTime: { value: 0 }, uK: { value: 0 }, uFlare: { value: 0 }, uLogK: logK || { value: 0 } };
    this.u = u;
    const defs = lz ? { LOGZ: 1 } : {};
    const frag = (src) => (lz ? `${LOGZ_F}\n` : '') + src.replace('LOGZ_MAIN', LOGZ_F_MAIN);
    const vert = (pre, body) => `${pre} ${lz ? LOGZ_V : ''}
      void main() { ${body} gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); ${lz ? LOGZ_V_MAIN : ''} }`;
    const disc = new THREE.Mesh(new THREE.CircleGeometry(G.r, 128), new THREE.ShaderMaterial({
      uniforms: u, defines: defs,
      vertexShader: vert('varying vec2 vP;', `vP = position.xy / ${G.r.toFixed(1)};`),
      fragmentShader: frag(DISC_F),
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      // В космосе гладь светится поверх тьмы; в дневном небе Земли сложение выбеливает её — там она ложится поверх неба
      ...(lz ? { blending: THREE.AdditiveBlending } : { blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor }),
    }));
    this.uSun = { value: new THREE.Vector3(0, 1, 0) };
    const frame = new THREE.Mesh(new THREE.TorusGeometry(G.r * 1.03, G.r * 0.045, 20, 192), new THREE.ShaderMaterial({
      uniforms: { ...u, uSun: this.uSun }, defines: defs,
      vertexShader: vert('varying vec3 vN, vL;', 'vN = mat3(modelMatrix) * normal; vL = position;'),
      fragmentShader: frag(FRAME_F),
    }));
    this.group = new THREE.Group();
    this.group.add(disc, frame);
    this.group.position.copy(G.c);
    this.group.quaternion.setFromUnitVectors(Z, G.n);
    this.group.visible = false;
    scene.add(this.group);
  }

  // Отрезок a → b пересёк гладь врат
  crossed(a, b) {
    const G = this.G;
    const s0 = a.clone().sub(G.c).dot(G.n), s1 = b.clone().sub(G.c).dot(G.n);
    if (s0 * s1 > 0 || s0 === s1) return false;
    const p = a.clone().lerp(b, s0 / (s0 - s1));
    return p.distanceTo(G.c) < G.r * 0.95;
  }

  update(dt, show, sunDir) {
    this.k += ((show ? this.open : 0) - this.k) * Math.min(1, dt * 1.5);
    this.flare = Math.max(0, this.flare - dt * 0.8);
    this.group.visible = this.k > 0.01;
    const u = this.u;
    u.uTime.value += dt;
    u.uK.value = this.k;
    u.uFlare.value = this.flare * this.flare;
    if (sunDir) this.uSun.value.copy(sunDir);
  }
}

// Свет звезды Ксаррона на его врата
export const XARRON_GATE_SUN = XARRON_ORIGIN.clone().sub(XARRON_GATE.c).normalize();
