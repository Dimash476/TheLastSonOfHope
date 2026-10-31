import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

// «Киношная» атмосфера:
// 1) Свет солнца в дымке — туман в сторону солнца светится тёплым (рассеяние),
//    встраивается прямо в туман всех стандартных материалов (без лишних проходов).
// 2) Лучи солнца — радиальные «божественные лучи» от яркого неба у солнца.
// 3) Цветокоррекция по времени суток: холодные тени и тёплый свет днём,
//    янтарный золотой час, синяя ночь; мягкий контраст и лёгкое зерно плёнки.

// Общие для всех материалов значения. Это простые объекты {x,y,z}: three.js при клонировании
// униформ копирует ссылку на такой объект, поэтому изменение здесь видно сразу во всех шейдерах.
export const SUN_FOG = { dir: { x: 0, y: 1, z: 0 }, color: { x: 0, y: 0, z: 0 } };

// Вызывать до первой отрисовки
export function installSunFog() {
  for (const name in THREE.ShaderLib) {
    const lib = THREE.ShaderLib[name];
    if (!lib.uniforms || !lib.uniforms.fogColor) continue;
    lib.uniforms.fogSunDir = { value: SUN_FOG.dir };
    lib.uniforms.fogSunColor = { value: SUN_FOG.color };
  }
  const C = THREE.ShaderChunk;
  C.fog_pars_vertex = '#ifdef USE_FOG\n  varying float vFogDepth;\n  varying vec3 vFogDir;\n#endif';
  C.fog_vertex = '#ifdef USE_FOG\n  vFogDepth = - mvPosition.z;\n  vFogDir = transpose(mat3(viewMatrix)) * mvPosition.xyz;\n#endif';
  C.fog_pars_fragment = `#ifdef USE_FOG
    uniform vec3 fogColor;
    uniform vec3 fogSunDir;
    uniform vec3 fogSunColor;
    varying float vFogDepth;
    varying vec3 vFogDir;
    #ifdef FOG_EXP2
      uniform float fogDensity;
    #else
      uniform float fogNear;
      uniform float fogFar;
    #endif
  #endif`;
  C.fog_fragment = `#ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    #else
      float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
    #endif
    // Дымка светится в сторону солнца: широкое тёплое сияние + яркое ядро
    vec3 fDir = vFogDir / max(length(vFogDir), 1e-4);
    float sunDot = max(dot(fDir, fogSunDir), 0.0);
    vec3 fogCol = fogColor + fogSunColor * (pow(sunDot, 6.0) * 0.5 + pow(sunDot, 40.0) * 0.7);
    gl_FragColor.rgb = mix( gl_FragColor.rgb, fogCol, fogFactor );
  #endif`;
}

const VERT = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';

export function createGodRaysPass() {
  return new ShaderPass({
    uniforms: {
      tDiffuse: { value: null }, uSun: { value: new THREE.Vector2(0.5, 0.5) },
      uStrength: { value: 0 }, uColor: { value: new THREE.Color(1, 0.9, 0.75) }, uThreshold: { value: 1.2 },
    },
    vertexShader: VERT,
    fragmentShader: `uniform sampler2D tDiffuse; uniform vec2 uSun; uniform float uStrength, uThreshold; uniform vec3 uColor; varying vec2 vUv;
      void main() {
        vec4 base = texture2D(tDiffuse, vUv);
        vec2 d = (vUv - uSun) * (0.85 / 28.0);
        vec2 uv = vUv;
        float decay = 1.0;
        vec3 acc = vec3(0.0);
        for (int i = 0; i < 28; i++) {
          uv -= d;
          vec3 c = texture2D(tDiffuse, clamp(uv, 0.0, 1.0)).rgb;
          float l = dot(c, vec3(0.3, 0.59, 0.11));
          acc += min(c, vec3(8.0)) * smoothstep(uThreshold, uThreshold * 2.5, l) * decay;
          decay *= 0.955;
        }
        gl_FragColor = vec4(base.rgb + acc * (uStrength / 28.0) * uColor, base.a);
      }`,
  });
}

export function createGradePass() {
  return new ShaderPass({
    uniforms: {
      tDiffuse: { value: null }, uTime: { value: 0 },
      uShadow: { value: new THREE.Vector3(-0.02, 0.03, 0.06) },
      uHigh: { value: new THREE.Vector3(0.05, 0.02, -0.03) },
      uSat: { value: 1.08 }, uContrast: { value: 0.18 }, uGrain: { value: 0.02 },
      uFilter: { value: 0 }, uVig: { value: 0 }, uLetter: { value: 0 },
      uTexel: { value: new THREE.Vector2(1 / 1024, 1 / 768) }, uSharp: { value: 0.2 },
    },
    vertexShader: VERT,
    fragmentShader: `uniform sampler2D tDiffuse; uniform float uTime, uSat, uContrast, uGrain, uFilter, uVig, uLetter, uSharp; uniform vec2 uTexel; uniform vec3 uShadow, uHigh; varying vec2 vUv;
      float h(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      void main() {
        vec4 base = texture2D(tDiffuse, vUv);
        vec3 c = clamp(base.rgb, 0.0, 1.0);
        // Резкость: возвращает чёткость мелким деталям (особенно при сниженном разрешении).
        // Сила ограничена локальным контрастом — без ореолов вокруг контуров
        if (uSharp > 0.001) {
          vec3 n = texture2D(tDiffuse, vUv + vec2(0.0, uTexel.y)).rgb, s = texture2D(tDiffuse, vUv - vec2(0.0, uTexel.y)).rgb;
          vec3 e = texture2D(tDiffuse, vUv + vec2(uTexel.x, 0.0)).rgb, w = texture2D(tDiffuse, vUv - vec2(uTexel.x, 0.0)).rgb;
          vec3 mn = min(c, min(min(n, s), min(e, w))), mx = max(c, max(max(n, s), max(e, w)));
          vec3 avg = (n + s + e + w) * 0.25;
          c = clamp(c + (c - avg) * uSharp * 1.6, mn, mx);
        }
        c = mix(c, c * c * (3.0 - 2.0 * c), uContrast);          // мягкая S-кривая
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        // Раздельное тонирование: тени и светлые тона (белое не трогаем — без пересвета)
        c += uShadow * (1.0 - l) * (1.0 - l) + uHigh * l * l * (1.0 - l) * 3.0;
        c = mix(vec3(l), c, uSat);
        c += (h(vUv * 1000.0 + fract(uTime) * 91.0) - 0.5) * uGrain; // зерно
        // Фильтры фоторежима: 1 кино, 2 нуар, 3 тёплый закат, 4 винтаж, 5 холод
        if (uFilter > 0.5) {
          float L = dot(c, vec3(0.2126, 0.7152, 0.0722));
          if (uFilter < 1.5) { c += vec3(0.03, 0.0, -0.03) * L - vec3(0.02, -0.01, -0.04) * (1.0 - L); c = mix(c, c * c * (3.0 - 2.0 * c), 0.3); }
          else if (uFilter < 2.5) { c = vec3(smoothstep(0.04, 0.96, L)); c += (h(vUv * 700.0 + uTime) - 0.5) * 0.05; }
          else if (uFilter < 3.5) { c *= vec3(1.12, 0.98, 0.8); c = mix(vec3(L), c, 1.15); }
          else if (uFilter < 4.5) { c = mix(c, vec3(L) * vec3(1.08, 0.96, 0.78), 0.6); c = c * 0.86 + 0.08; }
          else { c *= vec3(0.88, 1.0, 1.14); c = mix(vec3(L), c, 0.85); }
        }
        vec2 dv = vUv - 0.5;
        c *= 1.0 - uVig * dot(dv, dv) * 2.4;
        if (uLetter > 0.5 && abs(vUv.y - 0.5) > 0.4) c = vec3(0.0);
        gl_FragColor = vec4(c, base.a);
      }`,
  });
}

// Обновление по состоянию неба (вызывать каждый кадр)
const _p = new THREE.Vector3();
// Тени — прохладные (бирюза / синева / лиловый в сумерках), свет — тёплый: киношный контраст тонов
const _night = { s: new THREE.Vector3(-0.025, -0.005, 0.085), h: new THREE.Vector3(0.05, 0.02, -0.015) };
const _day = { s: new THREE.Vector3(-0.03, 0.02, 0.06), h: new THREE.Vector3(0.05, 0.025, -0.03) };
const _gold = { s: new THREE.Vector3(0.005, -0.01, 0.075), h: new THREE.Vector3(0.12, 0.04, -0.06) };
const _tropic = { s: new THREE.Vector3(0.05, -0.03, 0.15), h: new THREE.Vector3(0.08, 0.01, 0.03) };
export function updateCinematic({ env, camera, godRays, grade, dt, quality }) {
  const night = env.night, golden = env.golden, rain = env.W.rain;
  // Цвет рассеяния у солнца: золото на закате, мягкий белый днём, почти нет ночью
  const sc = env.T.sun, k = (1 - night) * (1 - rain * 0.7) * (0.12 + golden * 0.95);
  SUN_FOG.dir.x = env.sunDir.x; SUN_FOG.dir.y = env.sunDir.y; SUN_FOG.dir.z = env.sunDir.z;
  SUN_FOG.color.x = sc.r * k; SUN_FOG.color.y = sc.g * k; SUN_FOG.color.z = sc.b * k;

  // Лучи: только если солнце перед камерой и над горизонтом
  _p.copy(camera.position).addScaledVector(env.sunDir, 10000).project(camera);
  const inFront = _p.z < 1 && env.sunDir.y > -0.03;
  const onScreen = Math.max(Math.abs(_p.x), Math.abs(_p.y));
  const vis = inFront ? 1 - THREE.MathUtils.smoothstep(onScreen, 0.9, 1.8) : 0;
  const strength = vis * (1 - night) * (1 - rain) * (0.35 + golden * 0.65) * (1 - env.altitudeK);
  godRays.enabled = quality < 2 && strength > 0.01;
  godRays.uniforms.uSun.value.set(_p.x * 0.5 + 0.5, _p.y * 0.5 + 0.5);
  godRays.uniforms.uStrength.value = strength * (1.1 - golden * 0.25);
  // «Адаптация глаза»: низкое солнце прямо в кадре — экспозиция плавно ниже, без ослепления
  const glareT = vis * (1 - night) * (1 - rain) * (1 - THREE.MathUtils.smoothstep(env.sunDir.y, 0.05, 0.5)) * (1 - env.altitudeK);
  env.glare = (env.glare || 0) + (glareT - (env.glare || 0)) * Math.min(1, dt * 2.5);
  godRays.uniforms.uColor.value.copy(sc).lerp(new THREE.Color(1, 1, 1), 0.3);

  // Цветокоррекция: смесь «день / золотой час / ночь»
  const u = grade.uniforms;
  u.uShadow.value.copy(_day.s).lerp(_gold.s, golden).lerp(_night.s, night);
  u.uHigh.value.copy(_day.h).lerp(_gold.h, golden).lerp(_night.h, night);
  u.uSat.value = 1.06 + golden * 0.08 - night * 0.12 - rain * 0.12;
  // Тропики: лавандовые тени, персиково-золотой свет, сочнее цвет
  const tk = env.tropicK || 0;
  if (tk > 0) {
    u.uShadow.value.lerp(_tropic.s, tk);
    u.uHigh.value.lerp(_tropic.h, tk);
    u.uSat.value += 0.14 * tk;
  }
  u.uContrast.value = 0.2 + golden * 0.06 + night * 0.04;
  u.uTime.value += dt;
}
