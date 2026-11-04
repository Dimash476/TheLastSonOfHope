import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { CITY, WORLD, SPACE } from '../config.js';
import { mulberry32, smoothstep, lerp } from '../utils.js';
import { HALF, PLANE_HALF, RIVER_Z, RIVER_HALF_W, TOWNS, blockTypes, TERRAIN_RES, terrainHeights, coastX, forestMask, QUAY_X, SEA_BED, BIG_PARK, POND, STADIUM, BEACH, plainK, MEGA_SITES, ISLE, isleToWorld, islandSample, DISTRICTS } from './layout.js';

// Небо, солнце, туман, земля с дорогами, рельеф, вода, облака.
export class Environment {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.time = 0;

    // ---------- Небо ----------
    const sky = this.sky = new Sky();
    sky.scale.setScalar(400000);
    const u = sky.material.uniforms;
    u.turbidity.value = 4;
    u.rayleigh.value = 1.4;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.82;
    // Прозрачность неба: на высоте и ночью сквозь него видны космос и звёзды
    u.uOpacity = { value: 1 };
    u.uSkyGain = { value: 1 };
    u.uTwilight = { value: 0 };   // сила сумеречного свечения (солнце чуть за горизонтом)
    sky.material.transparent = true;
    sky.material.depthWrite = false;
    sky.material.fragmentShader = sky.material.fragmentShader
      .replace('void main() {', 'uniform float uOpacity; uniform float uSkyGain; uniform float uTwilight;\nvoid main() {')
      .replace(/gl_FragColor = vec4\(\s*retColor,\s*1\.0\s*\);/, `
        // Фиолетовый час: у горизонта со стороны заката — розово-оранжевая полоса, переходящая
        // в лиловую; выше — глубокий фиолетовый. Модель неба сама этого почти не даёт.
        vec3 twDir = normalize( vWorldPosition - cameraPosition );
        vec2 hs = normalize( vSunDirection.xz + 1e-5 ), hd = normalize( twDir.xz + 1e-5 );
        float toward = max( dot( hs, hd ), 0.0 );
        float up = max( twDir.y, 0.0 );
        vec3 band = mix( vec3( 0.42, 0.16, 0.42 ), vec3( 1.0, 0.42, 0.26 ), pow( toward, 4.0 ) ) * exp( -up * 7.0 );
        vec3 zenith = vec3( 0.13, 0.07, 0.3 ) * ( 0.35 + 0.65 * smoothstep( 0.0, 0.7, up ) );
        vec3 tw = ( band * ( 0.55 + 0.45 * toward ) + zenith ) * uTwilight;
        float twA = clamp( dot( tw, vec3( 0.33 ) ) * 6.0, 0.0, 1.0 );
        gl_FragColor = vec4( retColor * uSkyGain + tw, max( uOpacity, twA ) );`);
    this.sunDir = new THREE.Vector3();
    this.lightDir = new THREE.Vector3();
    scene.add(sky);

    // ---------- Туман ----------
    this.fogColor = new THREE.Color(0xb7c6d8);
    scene.fog = new THREE.FogExp2(this.fogColor.clone(), WORLD.fogDensity);

    // ---------- Свет ----------
    this.hemi = new THREE.HemisphereLight(0xcfe3ff, 0x4a4436, 0.55);
    scene.add(this.hemi);

    const sun = this.sun = new THREE.DirectionalLight(0xfff1dc, 3.2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = 160;
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 1500 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.25;
    scene.add(sun, sun.target);

    this.hour = 17.0;                    // время суток, ч (старт — на подходе к закату)
    this.timeScale = 24 / (20 * 60);    // сутки за 20 минут
    this.envDirty = true;
    this.envElev = 999; this.envAz = 999;
    this.golden = 0;
    this.weatherIndex = 0;
    this.night = 0;
    this.exposure = 0.5;
    this.altitudeK = 0;
    this.lightning = 0;
    this.nextLightning = 8;
    this.onThunder = null;

    // ---------- Земля ----------
    this.groundMat = this.createGroundMaterial();
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(PLANE_HALF * 2, PLANE_HALF * 2).rotateX(-Math.PI / 2), this.groundMat);
    plane.receiveShadow = true;
    scene.add(plane);
    for (const t of TOWNS) {
      const size = t.grid * CITY.block + 200;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2), this.groundMat);
      m.position.set(t.x, 0.15, t.z);
      m.receiveShadow = true;
      scene.add(m);
    }

    this.terrain = this.createTerrain();
    scene.add(this.terrain);
    scene.add(this.createRiverChannel());
    scene.add(this.createQuay());
    scene.add(this.createPond());
    this.water = this.createWater();
    scene.add(this.water);

    // ---------- Облака ----------
    this.clouds = this.createClouds();
    this.deck = this.createCloudDeck();
    scene.add(this.deck);
    scene.add(this.clouds);

    this.rain = this.createRain();
    scene.add(this.rain);

    this.applyAtmosphere();
    this.updateEnvMap();
  }

  // ---------------------------------------------------------------- время суток и погода
  // Сутки идут сами (~20 минут на круг). Опорные точки плавно смешиваются:
  // ночь → синий час → рассвет → утро → день → золотой час → закат → сумерки → ночь.
  static KEYS = [
    { h: 0, elev: -30, sun: 0x9db4ff, sunI: 0.42, hemi: 0.1, fog: 0x0d1020, exposure: 0.85, night: 1 },
    { h: 4.6, elev: -16, sun: 0x9db4ff, sunI: 0.42, hemi: 0.1, fog: 0x0f1224, exposure: 0.85, night: 1 },
    { h: 5.4, elev: -8, sun: 0x8a8ce0, sunI: 0.42, hemi: 0.14, fog: 0x22264a, exposure: 0.82, night: 0.85 },
    { h: 5.9, elev: -3.5, sun: 0xb08cc0, sunI: 0.7, hemi: 0.17, fog: 0x4a4560, exposure: 0.76, night: 0.6 },
    { h: 6.4, elev: 0.5, sun: 0xff8a5a, sunI: 1.5, hemi: 0.2, fog: 0xb08a84, exposure: 0.66, night: 0.35 },
    { h: 7.0, elev: 5, sun: 0xffa870, sunI: 2.3, hemi: 0.25, fog: 0xc0a090, exposure: 0.6, night: 0.15 },
    { h: 8.0, elev: 14, sun: 0xffd2a4, sunI: 3.0, hemi: 0.3, fog: 0xbcb4ac, exposure: 0.55, night: 0.05 },
    { h: 10, elev: 38, sun: 0xffe9cf, sunI: 3.6, hemi: 0.3, fog: 0xa7b6c8, exposure: 0.5, night: 0 },
    { h: 13, elev: 52, sun: 0xfff0dd, sunI: 3.8, hemi: 0.3, fog: 0x9fb3c8, exposure: 0.5, night: 0 },
    { h: 16.4, elev: 28, sun: 0xffdcb0, sunI: 3.5, hemi: 0.29, fog: 0xb0b4bc, exposure: 0.52, night: 0 },
    // Долгий закат: солнце медленно опускается в океан, небо — от золота к розовому и фиолетовому
    { h: 17.4, elev: 16, sun: 0xffcf96, sunI: 3.3, hemi: 0.27, fog: 0xc8b4a0, exposure: 0.53, night: 0 },
    { h: 18.2, elev: 9, sun: 0xffb070, sunI: 3.0, hemi: 0.24, fog: 0xd8a888, exposure: 0.56, night: 0.05 },
    { h: 18.9, elev: 4.5, sun: 0xff9a58, sunI: 2.6, hemi: 0.23, fog: 0xd09478, exposure: 0.58, night: 0.15 },
    { h: 19.5, elev: 1.5, sun: 0xff7a40, sunI: 2.2, hemi: 0.21, fog: 0xc07a68, exposure: 0.6, night: 0.3 },
    { h: 20.0, elev: -1.5, sun: 0xe85a6a, sunI: 1.4, hemi: 0.19, fog: 0x8e5670, exposure: 0.66, night: 0.45 },
    { h: 20.5, elev: -4.5, sun: 0x9a6ccc, sunI: 0.8, hemi: 0.2, fog: 0x4e3a68, exposure: 0.74, night: 0.65 },
    { h: 21.2, elev: -9, sun: 0x8a8ce0, sunI: 0.5, hemi: 0.15, fog: 0x2a2852, exposure: 0.82, night: 0.88 },
    { h: 22, elev: -16, sun: 0x9db4ff, sunI: 0.42, hemi: 0.1, fog: 0x0d1020, exposure: 0.85, night: 1 },
    { h: 24, elev: -30, sun: 0x9db4ff, sunI: 0.42, hemi: 0.1, fog: 0x0d1020, exposure: 0.85, night: 1 },
  ];
  // Клавиша T перескакивает к следующему из этих моментов
  // СУМЕРКИ — фиолетовый час: солнце уже за горизонтом, небо лиловое, зажигаются огни
  // ТРОПИКИ — особый романтический закат: персиковое, розовое, золотое и лавандовое небо,
  // тёплая дымка, светящиеся облака; включается только клавишей T (по часам не наступает)
  static LABELS = [{ h: 7.2, name: 'УТРО' }, { h: 13, name: 'ДЕНЬ' }, { h: 18.4, name: 'ЗАКАТ' }, { h: 19.72, name: 'ТРОПИКИ', tropic: true, from: 99 }, { h: 20.7, name: 'СУМЕРКИ', from: 20.2 }, { h: 23, name: 'НОЧЬ', from: 21.6 }];

  static WEATHERS = [
    { name: 'ЯСНО', fog: 0.65, clouds: 120, cloudLight: 1, sunMul: 1, turbidity: 2.2, wet: 0, rain: 0, deck: 0 },
    // Облачно: сплошная пелена с разрывами, но солнце пробивается и наполняет облака светом
    { name: 'ОБЛАЧНО', fog: 1.25, clouds: 420, cloudLight: 1.0, sunMul: 0.78, turbidity: 6, wet: 0, rain: 0, glow: 1, deck: 0.6 },
    { name: 'ДОЖДЬ', fog: 3.2, clouds: 640, cloudLight: 0.55, sunMul: 0.3, turbidity: 13, wet: 1, rain: 0.7, deck: 0.8 },
    { name: 'ГРОЗА', fog: 3.8, clouds: 640, cloudLight: 0.38, sunMul: 0.18, turbidity: 16, wet: 1, rain: 1, storm: true, deck: 0.9 },
  ];

  cycleTime() {
    const L = Environment.LABELS;
    // После «Тропиков» — следующий по времени режим (у них тот же час, что и закат)
    const next = (this.tropic ? L.find((l) => l.h > this.hour + 0.05 && !l.tropic) : L.find((l) => l.h > this.hour + 0.05)) || L[0];
    this.hour = next.h;
    this.tropic = !!next.tropic;
    if (this.tropic) this.weatherIndex = 0;   // тропический закат — ясный, с лёгкими облаками
    this.envDirty = true;
    this.applyAtmosphere();
    return next.name;
  }
  cycleWeather() { this.weatherIndex = (this.weatherIndex + 1) % Environment.WEATHERS.length; this.envDirty = true; this.applyAtmosphere(); return Environment.WEATHERS[this.weatherIndex].name; }

  // Параметры для текущего часа — смесь двух соседних опорных точек
  sampleTime(h) {
    const K = Environment.KEYS;
    let i = 0;
    while (i < K.length - 2 && K[i + 1].h <= h) i++;
    // Равномерное смешивание (без ускорений и «ступенек» на стыках)
    const a = K[i], b = K[i + 1], t = Math.min(1, Math.max(0, (h - a.h) / (b.h - a.h)));
    const c = (x, y) => new THREE.Color(x).lerp(new THREE.Color(y), t);
    return {
      elev: lerp(a.elev, b.elev, t), sunI: lerp(a.sunI, b.sunI, t), hemi: lerp(a.hemi, b.hemi, t),
      exposure: lerp(a.exposure, b.exposure, t), night: lerp(a.night, b.night, t), sun: c(a.sun, b.sun), fog: c(a.fog, b.fog),
    };
  }

  applyAtmosphere() {
    const W = Environment.WEATHERS[this.weatherIndex];
    const T = this.sampleTime(this.hour);
    const L = Environment.LABELS;
    const label = [...L].reverse().find((l) => this.hour >= (l.from ?? l.h - 1.5)) || L[L.length - 1];
    T.name = this.tropic ? 'ТРОПИКИ' : this.hour < 5.7 ? 'НОЧЬ' : label.name;
    // Тропический закат: тёплые персиковые тона, розовый рассеянный свет, лавандовое небо.
    // Пока солнце не ушло глубоко за горизонт; к ночи плавно уступает обычной палитре
    const tk = this.tropicK = this.tropic ? smoothstep(-13, 2, T.elev) : 0;
    if (tk > 0) {
      // Солнце касается океана: глубокий оранжево-алый; дымка — пурпурно-розовая
      T.sun.lerp(new THREE.Color(0xff6a62), 0.6 * tk);
      T.fog.lerp(new THREE.Color(0xa86a90), 0.75 * tk);
      T.exposure *= 1 + 0.08 * tk;
    }
    T.moonLight = T.elev < -3;
    this.T = T; this.W = W;
    // Золотой час: низкое солнце над горизонтом
    const golden = this.golden = smoothstep(22, 3, T.elev) * smoothstep(-6, 1, T.elev) * (1 - W.rain);
    const u = this.sky.material.uniforms;
    u.turbidity.value = W.turbidity + golden * 2;
    u.rayleigh.value = lerp(lerp(2.0, 3.2, golden) + W.turbidity * 0.03, 0.5, T.night);
    u.mieCoefficient.value = 0.0025 + W.rain * 0.003 + golden * 0.002;
    // Днём небо чуть приглушаем — глубже и синее, без пересвета
    u.uSkyGain.value = lerp(lerp(0.62, 0.95, golden), 1, T.night);
    // Сумеречное свечение: сильнее всего при солнце на 2–6° ниже горизонта, к ночи гаснет
    u.uTwilight.value = smoothstep(1.5, -2.5, T.elev) * smoothstep(-15, -6, T.elev) * (1 - W.rain * 0.8) * 0.9;
    if (tk > 0) {
      u.turbidity.value = lerp(u.turbidity.value, 6.0, tk);
      u.rayleigh.value = lerp(u.rayleigh.value, 4.4, tk);
      u.mieCoefficient.value = lerp(u.mieCoefficient.value, 0.004, tk);
      u.mieDirectionalG.value = lerp(0.82, 0.9, tk);
      u.uSkyGain.value = lerp(u.uSkyGain.value, 0.9, tk);
      // Фиолетовый час уже начинается: лиловый зенит, пурпурно-оранжевая полоса у горизонта
      u.uTwilight.value = Math.max(u.uTwilight.value, 0.85 * tk);
    } else u.mieDirectionalG.value = 0.82;
    // Солнце идёт с востока (6 ч) через юг (12 ч) на запад (18 ч)
    this.setSun(T.elev, this.sunAz());
    // Ночью тени отбрасывает луна
    const moonDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(45), THREE.MathUtils.degToRad(200));
    this.lightDir.copy(this.sunDir.y > 0.05 ? this.sunDir : moonDir);
    if (this.sunDir.y > -0.05 && this.sunDir.y <= 0.05) this.lightDir.lerpVectors(moonDir, this.sunDir, (this.sunDir.y + 0.05) / 0.1).normalize();
    this.sun.color.copy(T.sun);
    this.baseSunI = T.sunI * W.sunMul;
    this.baseHemi = T.hemi * (0.7 + 0.3 * W.sunMul);
    // Тропики: солнце уже в океане — песок светится отражённым лиловым небом, а не прямым светом
    if (tk > 0) { this.baseSunI *= 1 - 0.5 * tk; this.baseHemi *= 1 + 1.3 * tk; }
    // Киношная пара: прохладный рассеянный свет неба (тени) и тёплое солнце; на закате небо розовеет
    this.hemi.color.set(0xb9d2ff).lerp(new THREE.Color(0x3a4277), T.night).lerp(new THREE.Color(0xffc4a8), golden * 0.5).lerp(new THREE.Color(0xc890d8), 0.55 * tk);
    this.hemi.groundColor.set(0x55473a).lerp(new THREE.Color(0x1c1824), T.night).lerp(new THREE.Color(0x6a4060), 0.35 * tk);
    this.baseFog = T.fog.clone().lerp(new THREE.Color(T.night > 0.5 ? 0x0a0e14 : 0x4e555e), W.rain * 0.8);
    this.fogMul = W.fog * (1 + golden * 0.35) * (1 + 0.05 * tk);
    this.night = T.night;
    this.exposure = T.exposure * (1 - 0.4 * W.rain);
    this.clouds.count = tk > 0 ? Math.max(W.clouds, 160) : W.clouds;
    // Облака на закате подсвечены розово-золотым, ночью — тёмные
    this.cloudUniforms.uLight.value.setRGB(1, 0.99, 0.97).multiplyScalar(W.cloudLight * lerp(1, 0.12, T.night))
      .lerp(T.sun.clone().multiplyScalar(W.cloudLight * 1.1), 0.3 + golden * 0.55)
      .lerp(new THREE.Color(1.0, 0.5, 0.62).multiplyScalar(1.6), 0.8 * tk);
    // Свет солнца сквозь облака: тонкие края и всё, что между нами и солнцем, наполняется светом
    const sunUp = smoothstep(-0.04, 0.08, this.sunDir.y) * (1 - W.rain * 0.85);
    this.cloudUniforms.uSunCol.value.copy(T.sun).multiplyScalar(sunUp * (0.7 + 0.5 * (W.glow || 0) + 0.6 * tk));
    this.groundMat.userData.uWet.value = W.wet;
    this.rain.visible = W.rain > 0;
  }

  // Время идёт само; карта отражений неба пересчитывается, только когда солнце заметно сдвинулось
  // Солнце встаёт из-за гор на западе и садится в океан на востоке — закат над морем
  sunAz() { return 270 - (this.hour - 6) * 15; }

  stepTime(dt) {
    // В золотой час и сумерках время течёт медленнее — закатом можно насладиться
    const e0 = this.T ? this.T.elev : 30;
    const slow = smoothstep(18, 10, e0) * smoothstep(-11, -5, e0);
    // В «Тропиках» закат длится ещё дольше — мгновение растягивается
    this.hour = (this.hour + dt * this.timeScale * (1 - 0.72 * slow) * (this.tropic ? 0.3 : 1)) % 24;
    this.applyAtmosphere();
    const e = this.T.elev, az = this.sunAz();
    if (this.envDirty || Math.abs(e - this.envElev) > 3 || Math.abs(az - this.envAz) > 10) {
      this.envDirty = false;
      this.envElev = e; this.envAz = az;
      this.updateEnvMap();
    }
  }

  createRain() {
    const N = 5000;
    this.rainData = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      this.rainData[i * 3] = (Math.random() - 0.5) * 80;
      this.rainData[i * 3 + 1] = Math.random() * 50 - 15;
      this.rainData[i * 3 + 2] = (Math.random() - 0.5) * 80;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 6), 3).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.LineBasicMaterial({ color: 0xaab4c0, transparent: true, opacity: 0.35, depthWrite: false });
    const lines = new THREE.LineSegments(geo, mat);
    lines.frustumCulled = false;
    lines.visible = false;
    return lines;
  }

  updateRain(dt, cam) {
    if (!this.rain.visible) return;
    const d = this.rainData, a = this.rain.geometry.attributes.position.array;
    const fall = 32 * dt, len = 1.4;
    for (let i = 0; i < d.length / 3; i++) {
      let y = d[i * 3 + 1] - fall;
      if (y < -15) y += 50;
      d[i * 3 + 1] = y;
      const x = cam.position.x + d[i * 3], z = cam.position.z + d[i * 3 + 2], wy = cam.position.y + y;
      a[i * 6] = x; a[i * 6 + 1] = wy; a[i * 6 + 2] = z;
      a[i * 6 + 3] = x + 0.15; a[i * 6 + 4] = wy + len; a[i * 6 + 5] = z;
    }
    this.rain.geometry.attributes.position.needsUpdate = true;
    this.rain.material.opacity = 0.35 * this.W.rain;
  }

  setSun(elevation, azimuth) {
    const phi = THREE.MathUtils.degToRad(90 - elevation);
    const theta = THREE.MathUtils.degToRad(azimuth);
    this.sunDir.setFromSphericalCoords(1, phi, theta);
    this.sky.material.uniforms.sunPosition.value.copy(this.sunDir);
  }

  // Карта окружения из неба — для отражений в стёклах и воде
  updateEnvMap() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const skyScene = new THREE.Scene();
    const skyCopy = new Sky();
    skyCopy.scale.setScalar(1000);
    for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG', 'sunPosition']) {
      const v = this.sky.material.uniforms[k].value;
      skyCopy.material.uniforms[k].value = v.clone ? v.clone() : v;
    }
    skyScene.add(skyCopy);
    if (this.envRT) this.envRT.dispose();
    this.envRT = pmrem.fromScene(skyScene, 0, 0.1, 2000);
    this.scene.environment = this.envRT.texture;
    pmrem.dispose();
  }

  // ---------------------------------------------------------------- земля с дорогами
  createGroundMaterial() {
    const g = CITY.grid;
    const data = new Uint8Array(g * g);
    for (let k = 0; k < g * g; k++) data[k] = blockTypes[k] * 25;
    const tex = new THREE.DataTexture(data, g, g, THREE.RedFormat, THREE.UnsignedByteType);
    tex.magFilter = tex.minFilter = THREE.NearestFilter;
    tex.needsUpdate = true;

    const mat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 });
    mat.userData.uWet = { value: 0 };
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, {
        uBlockMap: { value: tex },
        uGrid: { value: g }, uBlock: { value: CITY.block }, uHalf: { value: HALF },
        uRoad: { value: CITY.road * 0.5 }, uWalk: { value: CITY.road * 0.5 + CITY.sidewalk },
        uRiver: { value: new THREE.Vector2(RIVER_Z, RIVER_HALF_W) },
        uQuay: { value: QUAY_X },
        uPark: { value: new THREE.Vector4(BIG_PARK.minX, BIG_PARK.minZ, BIG_PARK.maxX, BIG_PARK.maxZ) },
        uPond: { value: new THREE.Vector3(POND.x, POND.z, POND.r) },
        uStadium: { value: new THREE.Vector2(STADIUM.x, STADIUM.z) },
        uBeach: { value: new THREE.Vector3(BEACH.x0, BEACH.minZ, BEACH.maxZ) },
        uTowns: { value: TOWNS.map((t) => new THREE.Vector3(t.x, t.z, t.grid * CITY.block * 0.5)) },
        uMega: { value: (MEGA_SITES.length ? MEGA_SITES : [{ x: 1e6, z: 1e6, half: 1 }]).map((s) => new THREE.Vector3(s.x, s.z, s.half)) },
        uSleeper: { value: new THREE.Vector3(DISTRICTS.sleeper.x, DISTRICTS.sleeper.z, DISTRICTS.sleeper.r) },
        uCampus: { value: new THREE.Vector3(DISTRICTS.campus.x, DISTRICTS.campus.z, DISTRICTS.campus.r) },
        uWet: mat.userData.uWet,
      });
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vWPos;
          uniform sampler2D uBlockMap;
          uniform float uGrid, uBlock, uHalf, uRoad, uWalk, uWet, uQuay;
          uniform vec2 uRiver, uStadium;
          uniform vec4 uPark;
          uniform vec3 uPond;
          uniform vec3 uBeach;
          uniform vec3 uSleeper, uCampus;
          uniform vec3 uTowns[${TOWNS.length}];
          uniform vec3 uMega[${Math.max(1, MEGA_SITES.length)}];
          float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float vnoise(vec2 p) {
            vec2 i = floor(p), f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
          }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          float groundWet = 0.0, puddle = 0.0;
          {
            vec2 p = vWPos.xz;
            vec2 lp = mod(p, uBlock);
            vec2 d = min(lp, uBlock - lp);
            float minD = min(d.x, d.y);

            float inMain = step(abs(p.x), uHalf + uWalk) * step(abs(p.y), uHalf + uWalk);
            // Русло реки вырезаем — под ним меш канала и вода
            float inPlane = step(abs(p.x), uHalf + 300.0) * step(abs(p.y), uHalf + 300.0);
            if (abs(p.y - uRiver.x) < uRiver.y && abs(p.x) < uHalf + 300.0) discard;
            // Море за набережной и пруд в парке — тоже вода
            if (inPlane > 0.5 && p.x > uQuay) discard;
            // Пляж — отдельная сетка песка со спуском в воду
            if (inPlane > 0.5 && p.x > uBeach.x && p.y > uBeach.y && p.y < uBeach.z) discard;
            float pondD = length(p - uPond.xy);
            if (pondD < uPond.z) discard;

            vec3 grass   = vec3(0.20, 0.30, 0.13);
            vec3 asphalt = vec3(0.055, 0.058, 0.064);
            vec3 walk    = vec3(0.40, 0.39, 0.37);
            vec3 lot     = vec3(0.27, 0.27, 0.26);

            float type = 0.0;
            if (inMain > 0.5) {
              vec2 bidx = clamp(floor((p + uHalf) / uBlock), 0.0, uGrid - 1.0);
              type = floor(texture2D(uBlockMap, (bidx + 0.5) / uGrid).r * 255.0 / 25.0 + 0.5);
            }
            float inTown = 0.0;
            for (int i = 0; i < ${TOWNS.length}; i++) {
              vec2 q = abs(p - uTowns[i].xy);
              inTown = max(inTown, step(q.x, uTowns[i].z + uWalk) * step(q.y, uTowns[i].z + uWalk));
            }
            float roads = max(inMain, inTown);
            // Центральный парк — без дорог внутри, только по периметру
            float inPark = step(uPark.x + uWalk, p.x) * step(p.x, uPark.z - uWalk) * step(uPark.y + uWalk, p.y) * step(p.y, uPark.w - uWalk);
            roads *= 1.0 - inPark;
            // Мега-площади: внутри нет дорог, только по периметру
            float inMegaP = 0.0; vec2 megaC = vec2(0.0); float megaH = 1.0;
            for (int i = 0; i < ${Math.max(1, MEGA_SITES.length)}; i++) {
              vec2 q = abs(p - uMega[i].xy);
              if (q.x < uMega[i].z - uWalk && q.y < uMega[i].z - uWalk) { inMegaP = 1.0; megaC = uMega[i].xy; megaH = uMega[i].z - uWalk; }
            }
            roads *= 1.0 - inMegaP;

            vec3 col = lot;
            if (type > 0.5 && type < 1.5) {                                            // парк: площадь, кольцо, аллеи
              vec2 lq = lp - uBlock * 0.5;
              float r = length(lq);
              float pcross = r > 12.2 ? min(abs(lq.x), abs(lq.y)) : 1e9;
              float pd = min(pcross, abs(r - 12.2));
              col = mix(vec3(0.13, 0.22, 0.08), vec3(0.22, 0.31, 0.12), vnoise(p * 0.05) * 0.7 + vnoise(p * 0.4) * 0.3);
              col = mix(col, vec3(0.52, 0.47, 0.38), 1.0 - smoothstep(1.7, 2.2, pd));
              // Площадь с плиткой вокруг фонтана
              vec2 tl = abs(fract(lq / 1.2) - 0.5);
              vec3 paving = vec3(0.5, 0.48, 0.44) * (1.0 - step(0.46, max(tl.x, tl.y)) * 0.15);
              col = mix(col, paving, 1.0 - smoothstep(8.8, 9.2, r));
            }
            if (type > 1.5 && type < 2.5) col = grass * 1.3 + vec3(0.02, 0.03, 0.0); // пригород: газоны
            if (type > 2.5 && type < 3.5) col = vec3(0.33, 0.32, 0.29);              // набережная
            if (type > 5.5 && type < 6.5) {                                            // промзона: бетон с пятнами
              col = vec3(0.30, 0.295, 0.28) * (0.8 + 0.35 * vnoise(p * 0.05));
              col *= 1.0 - smoothstep(0.65, 0.8, vnoise(p * 0.3 + 3.0)) * 0.3;
            }
            if (type > 6.5 && type < 7.5) {                                            // порт: светлый бетон, жёлтая разметка
              col = vec3(0.38, 0.375, 0.36);
              vec2 sl = abs(fract(p / vec2(14.0, 15.5)) - 0.5);
              col = mix(col, vec3(0.75, 0.62, 0.2), step(0.48, max(sl.x, sl.y)) * 0.7);
            }
            if (type > 7.5 && type < 8.5) {                                            // стадион: поле с разметкой
              vec2 q = p - uStadium;
              col = vec3(0.36, 0.35, 0.33);
              float field = step(abs(q.x), 30.0) * step(abs(q.y), 21.0);
              vec3 turf = vec3(0.16, 0.34, 0.12) * (0.88 + 0.12 * step(0.5, fract(q.x / 6.0)));
              float lines = max(step(abs(abs(q.x) - 28.5), 0.12) * step(abs(q.y), 19.5), step(abs(abs(q.y) - 19.5), 0.12) * step(abs(q.x), 28.5));
              lines = max(lines, step(abs(q.x), 0.12) * step(abs(q.y), 19.5));
              lines = max(lines, step(abs(length(q) - 6.0), 0.12));
              col = mix(col, mix(turf, vec3(0.9), lines), field);
            }
            if (type < 0.5 && inMain > 0.5) {
              // Район квартала — по его центру (как и при застройке)
              vec2 bcen = (floor((p + uHalf) / uBlock) + 0.5) * uBlock - uHalf;
              vec2 lq = lp - uBlock * 0.5;
              if (length(bcen - uSleeper.xy) < uSleeper.z) {
                // Двор спального района: газон, дорожка-кольцо, выходы к улицам, детская площадка
                col = mix(vec3(0.15, 0.25, 0.09), vec3(0.23, 0.32, 0.13), vnoise(p * 0.07) * 0.7 + vnoise(p * 0.5) * 0.3);
                float path = min(abs(max(abs(lq.x), abs(lq.y)) - 19.0), max(abs(lq.y), 19.0 - abs(lq.x)));
                col = mix(col, vec3(0.36, 0.36, 0.35), 1.0 - smoothstep(1.0, 1.4, path));
                vec2 pg = abs(lq) - vec2(8.0, 5.5);
                float pgD = max(pg.x, pg.y);
                col = mix(col, vec3(0.70, 0.64, 0.50), 1.0 - step(1.2, pgD));                  // песок
                vec3 rubber = mix(vec3(0.55, 0.24, 0.19), vec3(0.20, 0.42, 0.52), step(0.0, lq.x));
                col = mix(col, rubber, 1.0 - step(0.0, pgD));                                   // резиновое покрытие
              } else if (length(bcen - uCampus.xy) < uCampus.z) {
                // Кампус: газон-«квадрат» с полосами стрижки, дорожки крест-накрест и кольцо;
                // в центре кампуса — мощёная площадь у башни и библиотеки
                col = mix(vec3(0.16, 0.28, 0.10), vec3(0.21, 0.34, 0.13), step(0.5, fract(lq.x / 5.0)));
                float path = min(abs(abs(lq.x) - abs(lq.y)) * 0.7071, abs(length(lq) - 9.0));
                vec3 stone = vec3(0.60, 0.55, 0.45);
                col = mix(col, stone, 1.0 - smoothstep(1.1, 1.5, path));
                col = mix(col, stone * 0.95, 1.0 - smoothstep(6.5, 7.0, length(lq)));
                vec2 tl = abs(fract(p / 1.4) - 0.5);
                vec3 plaza = stone * (0.92 + 0.08 * vnoise(p * 0.3)) * (1.0 - step(0.46, max(tl.x, tl.y)) * 0.12);
                col = mix(col, plaza, step(length(bcen - uCampus.xy), 1.0));
              }
            }
            col = mix(col, walk, step(minD, uWalk));
            float isRoad = step(minD, uRoad);
            col = mix(col, asphalt, isRoad);

            float dashA = step(d.x, 0.15) * step(mod(p.y, 12.0), 6.0) * step(uWalk, d.y);
            float dashB = step(d.y, 0.15) * step(mod(p.x, 12.0), 6.0) * step(uWalk, d.x);
            col = mix(col, vec3(0.85, 0.78, 0.45), max(dashA, dashB) * isRoad);

            // Сплошная краевая линия полосы
            float edgeA = step(abs(d.x - (uRoad - 0.7)), 0.08) * step(uWalk, d.y);
            float edgeB = step(abs(d.y - (uRoad - 0.7)), 0.08) * step(uWalk, d.x);
            col = mix(col, vec3(0.8), max(edgeA, edgeB) * 0.8);
            // Пешеходные переходы («зебры») у перекрёстков
            float zA = step(d.x, uRoad - 0.6) * step(uWalk + 0.5, d.y) * step(d.y, uWalk + 4.5) * step(0.5, fract(p.x * 0.9));
            float zB = step(d.y, uRoad - 0.6) * step(uWalk + 0.5, d.x) * step(d.x, uWalk + 4.5) * step(0.5, fract(p.y * 0.9));
            col = mix(col, vec3(0.86), max(zA, zB) * isRoad * 0.9);
            // Люки на полосах движения
            {
              float mA = length(vec2(mod(p.x, 33.0) - 16.5, d.y - 3.6)) * step(uWalk, d.x);
              float mB = length(vec2(mod(p.y, 33.0) - 16.5, d.x - 3.6)) * step(uWalk, d.y);
              float mh = min(mA + step(uRoad, d.y) * 99.0, mB + step(uRoad, d.x) * 99.0);
              float lid = 1.0 - smoothstep(0.42, 0.46, mh);
              float rim = smoothstep(0.36, 0.4, mh) * lid;
              col = mix(col, vec3(0.1, 0.1, 0.105) * (0.85 + 0.3 * step(0.5, fract(p.x * 4.0 + p.y * 4.0))), lid * isRoad);
              col = mix(col, vec3(0.2, 0.2, 0.2), rim * isRoad);
            }
            // Заплатки и тёмные пятна на асфальте
            float patchN = vnoise(p * 0.15);
            col *= 1.0 - isRoad * smoothstep(0.62, 0.7, patchN) * 0.25;
            col *= 1.0 - isRoad * smoothstep(0.75, 0.9, vnoise(p * 1.3 + 11.0)) * 0.2;
            // Бордюр и плитка тротуара
            float inWalk = step(uRoad, minD) * step(minD, uWalk);
            float curb = step(uRoad, minD) * step(minD, uRoad + 0.35);
            col = mix(col, vec3(0.58, 0.57, 0.55), curb);
            vec2 tile = abs(fract(p / 1.5) - 0.5);
            col *= 1.0 - inWalk * (1.0 - curb) * step(0.46, max(tile.x, tile.y)) * 0.25;

            col = mix(grass, col, roads);
            // Набережная: бетонная полоса между последней улицей и морем
            if (inPlane > 0.5 && p.x > uHalf + uWalk) {
              col = vec3(0.42, 0.41, 0.39) * (0.9 + 0.1 * step(0.5, fract(p.y / 3.0)));
              col = mix(col, vec3(0.7, 0.6, 0.2), step(uQuay - 0.6, p.x) * 0.8); // кромка причала
            }
            // Парк: аллеи и песчаный берег пруда
            if (inPark > 0.5) {
              col = mix(vec3(0.13, 0.22, 0.08), vec3(0.22, 0.31, 0.12), vnoise(p * 0.03) * 0.7 + vnoise(p * 0.25) * 0.3);
              float path = min(abs(p.y - (uPark.y + uPark.w) * 0.5 - 60.0 * sin(p.x * 0.012)), abs(p.x - (uPark.x + uPark.z) * 0.5 - 50.0 * sin(p.y * 0.015 + 1.0)));
              path = min(path, abs(pondD - uPond.z - 9.0));
              col = mix(col, vec3(0.52, 0.47, 0.38), 1.0 - smoothstep(1.6, 2.2, path));
              col = mix(col, vec3(0.58, 0.52, 0.4), 1.0 - smoothstep(uPond.z + 1.0, uPond.z + 4.0, pondD));
            }
            // Мега-площадь: светлый гранит, концентрические кольца, лучи от центра, газон по краю
            if (inMegaP > 0.5) {
              vec2 q = p - megaC;
              float r = length(q), ang = atan(q.y, q.x);
              vec2 tl = abs(fract(p / 3.0) - 0.5);
              col = vec3(0.58, 0.56, 0.52) * (0.9 + 0.1 * vnoise(p * 0.15)) * (1.0 - step(0.47, max(tl.x, tl.y)) * 0.1);
              float ring = 1.0 - smoothstep(0.6, 1.0, abs(fract(r / 24.0) - 0.5) * 24.0);
              float spoke = (1.0 - smoothstep(0.5, 0.9, abs(fract(ang / 6.2832 * 32.0) - 0.5) * r * 6.2832 / 32.0)) * step(20.0, r);
              col = mix(col, vec3(0.34, 0.33, 0.32), max(ring, spoke) * 0.75);
              float edge = max(abs(q.x), abs(q.y));
              vec3 lawn = mix(vec3(0.13, 0.22, 0.08), vec3(0.22, 0.31, 0.12), vnoise(p * 0.05));
              col = mix(col, lawn, smoothstep(megaH - 16.0, megaH - 15.0, edge));
              col = mix(col, vec3(0.6, 0.58, 0.54), smoothstep(megaH - 3.0, megaH - 2.5, edge));
            }
            float n = vnoise(p * 0.08) * 0.6 + vnoise(p * 0.6) * 0.4;
            col *= 0.82 + 0.3 * n;
            groundWet = uWet * (0.5 + 0.5 * isRoad * roads);
            // Лужи после дождя: тёмные гладкие пятна, в них отражается небо
            puddle = uWet * smoothstep(0.6, 0.68, vnoise(p * 0.06) * 0.7 + vnoise(p * 0.31) * 0.3) * roads;
            col = mix(col, col * 0.55 + vec3(0.01, 0.012, 0.016), puddle);
            col *= 1.0 - groundWet * 0.35;
            diffuseColor.rgb = col;
          }`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, 0.12, groundWet);
          roughnessFactor = mix(roughnessFactor, 0.02, puddle);`);
    };
    return mat;
  }

  // ---------------------------------------------------------------- рельеф
  createTerrain() {
    const N = TERRAIN_RES, size = WORLD.terrainSize;
    const geo = new THREE.PlaneGeometry(size, size, N, N).rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const farmA = new Float32Array(pos.count), meadowA = new Float32Array(pos.count);
    const H = terrainHeights, W = N + 1;
    const cGrass = new THREE.Color(0x3d5a2a), cDry = new THREE.Color(0x6b6a3e), cRock = new THREE.Color(0x6a625a);
    const cSnow = new THREE.Color(0xf2f4f8), cSand = new THREE.Color(0xcdb98e), cSea = new THREE.Color(0x4a5a52);
    const cForest = new THREE.Color(0x1b2c14);
    const c = new THREE.Color();
    const cell = size / N;
    const ss = THREE.MathUtils.smoothstep;

    for (let k = 0; k < pos.count; k++) {
      const x = pos.getX(k), z = pos.getZ(k);
      const i = Math.round((x / size + 0.5) * N), j = Math.round((z / size + 0.5) * N);
      const h = H[j * W + i];
      pos.setY(k, h);
      const hx = H[j * W + Math.min(N, i + 1)] - H[j * W + Math.max(0, i - 1)];
      const hz = H[Math.min(N, j + 1) * W + i] - H[Math.max(0, j - 1) * W + i];
      const slope = Math.hypot(hx, hz) / (2 * cell);

      c.copy(cGrass).lerp(cDry, ss(h, 150, 600));
      c.lerp(cRock, Math.max(ss(h, 700, 1300), ss(slope, 0.5, 0.9)));
      c.lerp(cSnow, ss(h, 1500, 1900) * (1 - ss(slope, 0.9, 1.4)));
      c.lerp(cForest, Math.min(1, forestMask(x, z, h) * 1.4));
      const beach = x > coastX(z) - 500 ? 1 - ss(h, 2, 12) : 0;
      c.lerp(cSand, beach);
      c.lerp(cSea, ss(-h, 3, 20));
      colors[k * 3] = c.r; colors[k * 3 + 1] = c.g; colors[k * 3 + 2] = c.b;
      // Равнины: поля (подальше от города, ровные места) и луга с цветами
      const pk = plainK(x, z), flat = 1 - ss(slope, 0.06, 0.18), low = 1 - ss(h, 120, 260), dry = h > 0.5 ? 1 : 0;
      farmA[k] = pk * flat * low * dry * ss(Math.hypot(x, z), 4200, 5600) * (1 - forestMask(x, z, h));
      meadowA[k] = Math.max(0, pk * low * dry - farmA[k]);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('farm', new THREE.BufferAttribute(farmA, 1));
    geo.setAttribute('meadow', new THREE.BufferAttribute(meadowA, 1));
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vTPos;\nattribute float farm;\nattribute float meadow;\nvarying float vFarm;\nvarying float vMeadow;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvTPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvFarm = farm;\nvMeadow = meadow;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vTPos;
          varying float vFarm;
          varying float vMeadow;
          float th(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
          float tn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
            return mix(mix(th(i), th(i+vec2(1,0)), f.x), mix(th(i+vec2(0,1)), th(i+vec2(1,1)), f.x), f.y); }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          diffuseColor.rgb *= 0.8 + 0.35 * (tn(vTPos.xz * 0.01) * 0.6 + tn(vTPos.xz * 0.12) * 0.4);
          {
            // Лоскутные поля: повёрнутые участки, у каждого своя культура и борозды
            vec2 q = mat2(0.94, -0.34, 0.34, 0.94) * vTPos.xz;
            vec2 cellId = floor(q / vec2(220.0, 160.0));
            float r = th(cellId);
            vec3 crop = r < 0.3 ? vec3(0.62, 0.52, 0.22) : r < 0.55 ? vec3(0.28, 0.42, 0.14) : r < 0.75 ? vec3(0.34, 0.25, 0.16) : vec3(0.45, 0.5, 0.2);
            float rc = (r < 0.5 ? q.x : q.y) * 1.6;
            float rows = 0.88 + 0.12 * sin(rc) * (1.0 - smoothstep(0.4, 1.2, fwidth(rc)));
            vec2 fb = abs(fract(q / vec2(220.0, 160.0)) - 0.5);
            float hedge = smoothstep(0.485, 0.495, max(fb.x, fb.y));
            vec3 farmCol = mix(crop * rows, vec3(0.16, 0.24, 0.1), hedge);
            diffuseColor.rgb = mix(diffuseColor.rgb, farmCol, smoothstep(0.25, 0.6, vFarm));
            // Луга: сочная трава и россыпь полевых цветов вблизи
            vec3 grass = mix(vec3(0.22, 0.36, 0.12), vec3(0.32, 0.44, 0.16), tn(vTPos.xz * 0.03));
            float fl = th(floor(vTPos.xz * 1.3));
            vec3 flower = fl > 0.985 ? vec3(0.9, 0.85, 0.3) : fl > 0.975 ? vec3(0.85, 0.3, 0.45) : fl > 0.965 ? vec3(0.9, 0.9, 0.95) : grass;
            float near = 1.0 - smoothstep(60.0, 220.0, length(vTPos - cameraPosition));
            vec3 meadowCol = mix(grass, flower, near * 0.9);
            diffuseColor.rgb = mix(diffuseColor.rgb, meadowCol, smoothstep(0.3, 0.7, vMeadow) * 0.85);
          }`);
    };
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    return mesh;
  }

  // Бетонный канал реки внутри города
  createRiverChannel() {
    const len = PLANE_HALF + 10 + QUAY_X, cx = (QUAY_X - PLANE_HALF - 10) / 2, depth = -WORLD.riverBed;
    const group = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x6f6a62, roughness: 0.9 });
    const bed = new THREE.Mesh(new THREE.PlaneGeometry(len, RIVER_HALF_W * 2).rotateX(-Math.PI / 2), mat);
    bed.position.set(cx, WORLD.riverBed, RIVER_Z);
    group.add(bed);
    for (const s of [-1, 1]) {
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(len, depth), mat);
      wall.position.set(cx, WORLD.riverBed + depth / 2, RIVER_Z + s * RIVER_HALF_W);
      wall.rotation.y = s > 0 ? Math.PI : 0;
      group.add(wall);
    }
    group.traverse((o) => { o.receiveShadow = true; });
    return group;
  }

  // Бетонная стенка набережной вдоль моря (с разрывом в устье реки)
  createQuay() {
    const group = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x77736b, roughness: 0.9 });
    const depth = -SEA_BED, z0 = -PLANE_HALF, z1 = PLANE_HALF;
    const spans = [[z0, RIVER_Z - RIVER_HALF_W], [RIVER_Z + RIVER_HALF_W, BEACH.minZ], [BEACH.maxZ, z1]];
    for (const [a, b] of spans) {
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(b - a, depth), mat);
      wall.rotation.y = Math.PI / 2;
      wall.position.set(QUAY_X, SEA_BED + depth / 2, (a + b) / 2);
      group.add(wall);
    }
    group.traverse((o) => { o.receiveShadow = true; });
    return group;
  }

  // Пруд в центральном парке: каменная чаша
  createPond() {
    const depth = -WORLD.riverBed;
    const mat = new THREE.MeshStandardMaterial({ color: 0x5d5a50, roughness: 0.95, side: THREE.BackSide });
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(POND.r, POND.r, depth, 64, 1, true), mat);
    wall.position.set(POND.x, WORLD.riverBed + depth / 2, POND.z);
    const bed = new THREE.Mesh(new THREE.CircleGeometry(POND.r, 64).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x3e4a38, roughness: 1 }));
    bed.position.set(POND.x, WORLD.riverBed, POND.z);
    const g = new THREE.Group();
    g.add(wall, bed);
    g.traverse((o) => { o.receiveShadow = true; });
    return g;
  }

  // Карта глубин у райского острова (для бирюзовой лагуны и прибоя): 0 — урез, 1 — 40 м и глубже
  makeIsleDepth() {
    const N = 256, data = new Uint8Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const [x, z] = isleToWorld((i / (N - 1) - 0.5) * ISLE.size, (j / (N - 1) - 0.5) * ISLE.size);
      const s = islandSample(x, z);
      const depth = s ? Math.max(0, WORLD.waterLevel - s.h) : 40;
      data[j * N + i] = Math.min(255, Math.round(depth / 40 * 255));
    }
    const tex = new THREE.DataTexture(data, N, N, THREE.RedFormat, THREE.UnsignedByteType);
    tex.magFilter = tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  }

  createWater() {
    const geo = new THREE.PlaneGeometry(WORLD.terrainSize, WORLD.terrainSize, 1, 1).rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0x0f2a36, roughness: 0.035, metalness: 0.15, transparent: true, opacity: 0.92 });
    mat.userData.uTime = { value: 0 };
    const isleTex = this.makeIsleDepth();
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = mat.userData.uTime;
      shader.uniforms.uIsleTex = { value: isleTex };
      shader.uniforms.uIsle = { value: new THREE.Vector4(ISLE.x, ISLE.z, ISLE.size, 0) };
      shader.uniforms.uIsleRot = { value: new THREE.Vector2(Math.cos(ISLE.rot), Math.sin(ISLE.rot)) };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWaterPos;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWaterPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vWaterPos;
          uniform float uTime;
          uniform sampler2D uIsleTex;
          uniform vec4 uIsle;
          uniform vec2 uIsleRot;
          float isleFoam = 0.0;`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          {
            // Лагуна у райского острова: бирюза на мелководье, лазурь глубже, сквозь воду — песок;
            // полосы пены идут по линиям равной глубины и бегут к берегу
            vec2 dq = vWaterPos.xz - uIsle.xy;
            vec2 il = vec2(dq.x * uIsleRot.x + dq.y * uIsleRot.y, -dq.x * uIsleRot.y + dq.y * uIsleRot.x) / uIsle.z + 0.5;
            if (il.x > 0.0 && il.y > 0.0 && il.x < 1.0 && il.y < 1.0) {
              float depth = texture2D(uIsleTex, il).r * 40.0;
              float edgeFade = smoothstep(0.0, 0.08, min(min(il.x, il.y), min(1.0 - il.x, 1.0 - il.y)));
              float shallow = (1.0 - smoothstep(0.3, 16.0, depth)) * edgeFade;
              float lagoon = (1.0 - smoothstep(8.0, 38.0, depth)) * edgeFade;
              vec3 turq = vec3(0.07, 0.62, 0.6), azure = vec3(0.02, 0.3, 0.46);
              diffuseColor.rgb = mix(diffuseColor.rgb, mix(azure, turq, shallow), lagoon);
              diffuseColor.a *= mix(1.0, 0.42, shallow);
              float n = 0.5 + 0.5 * sin(vWaterPos.x * 0.21 + vWaterPos.z * 0.13) * sin(vWaterPos.x * 0.07 - vWaterPos.z * 0.17 + uTime * 0.3);
              float lines = smoothstep(0.86, 0.97, sin(depth * 1.7 + uTime * 1.25)) * (1.0 - smoothstep(1.2, 4.0, depth)) * smoothstep(0.15, 0.5, depth);
              float shore = 1.0 - smoothstep(0.05, 0.45, depth);
              isleFoam = max(lines * (0.45 + 0.55 * n), shore * (0.55 + 0.45 * n)) * edgeFade;
              diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.96, 0.97, 0.96), isleFoam);
              diffuseColor.a = mix(diffuseColor.a, 0.95, isleFoam);
            }
          }`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, 0.7, isleFoam);`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          {
            // Волны: сумма синусоид по мировым координатам → возмущение нормали
            vec2 p = vWaterPos.xz;
            float t = uTime;
            vec2 g = vec2(0.0);
            g += vec2(0.8, 0.3) * cos(dot(p, vec2(0.8, 0.3)) * 0.12 + t * 1.1) * 0.5;
            g += vec2(-0.4, 0.9) * cos(dot(p, vec2(-0.4, 0.9)) * 0.21 + t * 1.6) * 0.35;
            g += vec2(0.6, -0.7) * cos(dot(p, vec2(0.6, -0.7)) * 0.53 + t * 2.3) * 0.2;
            g += vec2(-0.9, -0.2) * cos(dot(p, vec2(-0.9, -0.2)) * 1.31 + t * 3.1) * 0.1;
            // Мелкая рябь — солнечные блики искрятся
            g += vec2(0.3, 0.95) * cos(dot(p, vec2(0.3, 0.95)) * 2.9 + t * 4.3) * 0.06;
            g += vec2(-0.75, 0.66) * cos(dot(p, vec2(-0.75, 0.66)) * 5.7 + t * 5.9) * 0.035;
            float fade = 1.0 / (1.0 + length(vViewPosition) * 0.002);
            vec3 wn = normalize(vec3(-g.x * 0.25 * fade, 1.0, -g.y * 0.25 * fade));
            normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
          }`);
    };
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = WORLD.waterLevel;
    mesh.receiveShadow = true;
    return mesh;
  }

  // ---------------------------------------------------------------- облака
  createClouds() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const rnd = mulberry32(7);
    for (let i = 0; i < 22; i++) {
      const x = 30 + rnd() * 68, y = 40 + rnd() * 48, r = 14 + rnd() * 26;
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, 'rgba(255,255,255,0.55)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;

    const count = 640;
    const geo = new THREE.PlaneGeometry(1, 1);
    this.cloudUniforms = {
      uMap: { value: tex },
      uFogColor: { value: this.fogColor },
      uFogDensity: { value: WORLD.fogDensity * 0.6 },
      uLight: { value: new THREE.Color(1, 0.99, 0.97) },
      uSunDir: { value: this.sunDir },
      uSunCol: { value: new THREE.Color(0, 0, 0) },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.cloudUniforms,
      vertexShader: /* glsl */`
        varying vec2 vUv;
        varying float vDist;
        varying vec3 vCW;
        void main() {
          vUv = uv;
          vCW = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          vec4 center = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          float s = length(instanceMatrix[0].xyz);
          center.xy += position.xy * s;
          vDist = -center.z;
          gl_Position = projectionMatrix * center;
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap;
        uniform vec3 uFogColor, uLight, uSunDir, uSunCol;
        uniform float uFogDensity;
        varying vec2 vUv;
        varying float vDist;
        varying vec3 vCW;
        void main() {
          vec4 t = texture2D(uMap, vUv);
          float fog = 1.0 - exp(-pow(uFogDensity * vDist, 2.0));
          float near = smoothstep(20.0, 160.0, vDist);
          // Низ облака темнее — ощущение объёма
          vec3 col = uLight * mix(0.72, 1.0, smoothstep(0.2, 0.8, vUv.y));
          // Солнце сквозь облака: рассеяние вперёд (облака между нами и солнцем светятся),
          // тонкие края горят ярче — серебристая кайма
          vec3 V = normalize(vCW - cameraPosition);
          float fwd = pow(max(dot(V, uSunDir), 0.0), 6.0);
          float thin = 1.0 - smoothstep(0.12, 0.7, t.a);
          col += uSunCol * (fwd * (0.5 + 1.8 * thin) + thin * 0.22 + smoothstep(0.4, 1.0, vUv.y) * 0.12);
          col = mix(col, uFogColor, fog * 0.8);
          gl_FragColor = vec4(col, t.a * near * (1.0 - fog * 0.6));
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
    });

    const mesh = new THREE.InstancedMesh(geo, mat, count);
    const rnd2 = mulberry32(99);
    const m = new THREE.Matrix4();
    let i = 0;
    // Первые ~160 — отдельные кучевые облака (ясно); остальные — гряды для облачной погоды:
    // они заполняют промежутки и сливаются в сплошные полосы с просветами
    const X0 = -9000, X1 = 17000, Z0 = -12000, Z1 = 12000;
    while (i < 160) {
      const cx = X0 + rnd2() * (X1 - X0), cz = Z0 + rnd2() * (Z1 - Z0), cy = 900 + rnd2() * 700;
      const n = 4 + Math.floor(rnd2() * 6);
      for (let k = 0; k < n && i < 160; k++, i++) {
        const sc = 200 + rnd2() * 300;
        m.makeScale(sc, sc, sc);
        m.setPosition(cx + (rnd2() - 0.5) * 450, cy + (rnd2() - 0.5) * 80, cz + (rnd2() - 0.5) * 450);
        mesh.setMatrixAt(i, m);
      }
    }
    while (i < count) {
      // Гряда: вытянутая полоса из крупных плоских «клубов» вдоль ветра, с разрывами
      const cx = X0 + rnd2() * (X1 - X0), cz = Z0 + rnd2() * (Z1 - Z0), cy = 1000 + rnd2() * 500;
      const ang = 0.6 + (rnd2() - 0.5) * 0.5, len = 1800 + rnd2() * 2600, n = 14 + Math.floor(rnd2() * 14);
      for (let k = 0; k < n && i < count; k++, i++) {
        const t = (k / n - 0.5) * len, side = (rnd2() - 0.5) * 700;
        const sc = 380 + rnd2() * 420;
        m.makeScale(sc, sc * 0.75, sc);
        m.setPosition(cx + Math.cos(ang) * t - Math.sin(ang) * side, cy + (rnd2() - 0.5) * 120, cz + Math.sin(ang) * t + Math.cos(ang) * side);
        mesh.setMatrixAt(i, m);
      }
    }
    mesh.frustumCulled = false;
    mesh.renderOrder = 10;
    return mesh;
  }

  // ---------------------------------------------------------------- облачная пелена
  // Сплошной слой облаков на ~1.6 км: шум задаёт разрывы, ветер медленно несёт их.
  // Тонкие места просвечивают, со стороны солнца облака наполняются тёплым светом,
  // края горят серебром; снизу — серо-голубые днища, сверху — белые вершины
  createCloudDeck() {
    this.deckUniforms = {
      uTime: { value: 0 }, uCover: { value: 0 }, uSunDir: { value: this.sunDir },
      uSunCol: this.cloudUniforms.uSunCol, uLight: this.cloudUniforms.uLight, uFogColor: this.cloudUniforms.uFogColor,
      uDark: { value: 0 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.deckUniforms,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      vertexShader: `varying vec3 vW;
        void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `uniform float uTime, uCover, uDark;
        uniform vec3 uSunDir, uSunCol, uLight, uFogColor;
        varying vec3 vW;
        float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y); }
        float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += vn(p) * a; p = p * 2.03 + 11.7; a *= 0.5; } return s; }
        void main() {
          vec2 p = vW.xz * 0.00042 + vec2(uTime * 0.006, uTime * 0.0035);
          float d = fbm(p) * 0.75 + fbm(p * 3.1 + 5.0) * 0.25;
          d = clamp((d - 0.47) * 2.4 + 0.5, 0.0, 1.0);     // контрастнее: чёткие массы и ясные разрывы
          float cov = 1.0 - uCover;
          float a = smoothstep(cov - 0.06, cov + 0.1, d);
          float thick = smoothstep(cov, cov + 0.42, d);
          vec3 V = normalize(vW - cameraPosition);
          float below = step(0.0, V.y);
          float fwd = pow(max(dot(V, uSunDir), 0.0), 7.0);
          float edge = a * (1.0 - a) * 4.0;
          // Снизу: тёмные днища, светлее там, где облако тонкое; сверху — освещённые вершины
          vec3 col = uLight * mix(mix(0.95, 0.5, thick), mix(0.85, 1.15, 1.0 - thick), 1.0 - below);
          col = mix(col, col * vec3(0.55, 0.58, 0.66), uDark * thick);
          col += uSunCol * (fwd * (0.35 + 1.9 * (1.0 - thick)) + edge * 0.45 + fwd * edge * 1.2);
          float dist = length(vW.xz - cameraPosition.xz);
          float fade = 1.0 - smoothstep(9000.0, 26000.0, dist);
          col = mix(col, uFogColor, smoothstep(4000.0, 24000.0, dist) * 0.7);
          gl_FragColor = vec4(col, a * fade * 0.96);
          #include <colorspace_fragment>
        }`,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(60000, 60000, 1, 1).rotateX(-Math.PI / 2), mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 9;
    mesh.visible = false;
    return mesh;
  }

  update(dt, focus, camera, active = true) {
    this.time += dt;
    // Пелена облаков следует за камерой по горизонтали (узор — в мировых координатах)
    this.deckUniforms.uTime.value = this.time;
    this.deckUniforms.uCover.value += ((this.W.deck || 0) - this.deckUniforms.uCover.value) * Math.min(1, dt * 0.8);
    this.deckUniforms.uDark.value = this.W.rain;
    this.deck.position.set(camera.position.x, 1650, camera.position.z);
    this.deck.visible = this.deckUniforms.uCover.value > 0.02 && camera.position.y < 12000;
    if (active) this.stepTime(dt);
    this.water.material.userData.uTime.value = this.time;
    this.sun.position.copy(focus).addScaledVector(this.lightDir, 600);
    this.sun.target.position.copy(focus);

    // Высота: небо темнеет и становится прозрачным, туман исчезает
    const alt = camera.position.y;
    const k = this.altitudeK = smoothstep(3000, SPACE.spaceAlt * 0.7, alt);
    const skyOpacity = (1 - k) * (1 - this.night * 0.7);
    this.sky.material.uniforms.uOpacity.value = skyOpacity;
    this.sky.visible = skyOpacity > 0.01;
    const fogK = 1 - smoothstep(800, 7000, alt);
    this.scene.fog.density = WORLD.fogDensity * this.fogMul * fogK;
    this.scene.fog.color.copy(this.baseFog);
    this.cloudUniforms.uFogColor.value.copy(this.baseFog);
    this.clouds.visible = alt < 9000;
    this.rain.visible = this.W.rain > 0 && alt < 1500;

    // Рельеф растворяется на большой высоте — дальше видна Земля-шар
    const fade = 1 - smoothstep(11000, 24000, alt);
    for (const m of [this.terrain.material, this.water.material]) {
      const isWater = m === this.water.material;
      const wantT = isWater || fade < 0.999;
      if (m.transparent !== wantT) { m.transparent = wantT; m.needsUpdate = true; }
      m.opacity = isWater ? 0.92 * fade : fade;
    }
    this.terrain.visible = fade > 0.01;

    // Молнии в грозу
    let flash = 0;
    if (this.W.storm && alt < 3000) {
      this.nextLightning -= dt;
      if (this.nextLightning <= 0) {
        this.lightning = 1;
        this.nextLightning = 5 + Math.random() * 10;
        this.onThunder?.();
      }
    }
    if (this.lightning > 0) { flash = this.lightning * (0.5 + 0.5 * Math.sin(this.time * 60)); this.lightning = Math.max(0, this.lightning - dt * 3); }
    // В космосе нет рассеянного света неба, а солнце ярче
    this.sun.intensity = lerp(this.baseSunI, this.T.moonLight ? 0.4 : 3.6, k);
    this.hemi.intensity = this.baseHemi * (1 - k * 0.85) + flash * 3;
    this.updateRain(dt, camera);
  }
}
