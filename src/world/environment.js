import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { CITY, WORLD, SPACE } from '../config.js';
import { mulberry32, smoothstep, lerp } from '../utils.js';
import { HALF, PLANE_HALF, RIVER_Z, RIVER_HALF_W, TOWNS, blockTypes, TERRAIN_RES, terrainHeights, coastX } from './layout.js';

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
    sky.material.transparent = true;
    sky.material.depthWrite = false;
    sky.material.fragmentShader = sky.material.fragmentShader
      .replace('void main() {', 'uniform float uOpacity;\nvoid main() {')
      .replace(/gl_FragColor = vec4\(\s*retColor,\s*1\.0\s*\);/, 'gl_FragColor = vec4( retColor, uOpacity );');
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

    this.timeIndex = 1;
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
    this.water = this.createWater();
    scene.add(this.water);

    // ---------- Облака ----------
    this.clouds = this.createClouds();
    scene.add(this.clouds);

    this.rain = this.createRain();
    scene.add(this.rain);

    this.applyAtmosphere();
  }

  // ---------------------------------------------------------------- время суток и погода
  static TIMES = [
    { name: 'УТРО', elev: 9, az: 95, sun: 0xffcf9a, sunI: 2.8, hemi: 0.3, fog: 0xbcb4ac, exposure: 0.55, night: 0.15 },
    { name: 'ДЕНЬ', elev: 48, az: 150, sun: 0xfff4e6, sunI: 3.8, hemi: 0.3, fog: 0x9fb3c8, exposure: 0.5, night: 0 },
    { name: 'ЗАКАТ', elev: 3.5, az: 250, sun: 0xff9550, sunI: 2.4, hemi: 0.22, fog: 0xb98c74, exposure: 0.58, night: 0.35 },
    { name: 'НОЧЬ', elev: -16, az: 250, sun: 0x8aa4ff, sunI: 0.35, hemi: 0.1, fog: 0x0c121c, exposure: 0.85, night: 1, moonLight: true },
  ];

  static WEATHERS = [
    { name: 'ЯСНО', fog: 0.65, clouds: 110, cloudLight: 1, sunMul: 1, turbidity: 2.2, wet: 0, rain: 0 },
    { name: 'ОБЛАЧНО', fog: 1.8, clouds: 260, cloudLight: 0.85, sunMul: 0.55, turbidity: 9, wet: 0, rain: 0 },
    { name: 'ДОЖДЬ', fog: 3.2, clouds: 260, cloudLight: 0.55, sunMul: 0.3, turbidity: 13, wet: 1, rain: 0.7 },
    { name: 'ГРОЗА', fog: 3.8, clouds: 260, cloudLight: 0.38, sunMul: 0.18, turbidity: 16, wet: 1, rain: 1, storm: true },
  ];

  cycleTime() { this.timeIndex = (this.timeIndex + 1) % Environment.TIMES.length; this.applyAtmosphere(); return Environment.TIMES[this.timeIndex].name; }
  cycleWeather() { this.weatherIndex = (this.weatherIndex + 1) % Environment.WEATHERS.length; this.applyAtmosphere(); return Environment.WEATHERS[this.weatherIndex].name; }

  applyAtmosphere() {
    const T = Environment.TIMES[this.timeIndex], W = Environment.WEATHERS[this.weatherIndex];
    this.T = T; this.W = W;
    const u = this.sky.material.uniforms;
    u.turbidity.value = W.turbidity;
    u.rayleigh.value = T.night > 0.9 ? 0.5 : 2.1 + W.turbidity * 0.03;
    u.mieCoefficient.value = 0.0025 + W.rain * 0.003;
    this.setSun(T.elev, T.az);
    // Ночью тени отбрасывает луна
    if (T.moonLight) this.lightDir.setFromSphericalCoords(1, THREE.MathUtils.degToRad(45), THREE.MathUtils.degToRad(200));
    else this.lightDir.copy(this.sunDir);
    this.sun.color.set(T.sun);
    this.baseSunI = T.sunI * W.sunMul;
    this.baseHemi = T.hemi * (0.7 + 0.3 * W.sunMul);
    this.hemi.color.set(T.night > 0.9 ? 0x334466 : 0xcfe3ff);
    this.baseFog = new THREE.Color(T.fog).lerp(new THREE.Color(T.night > 0.9 ? 0x0a0e14 : 0x4e555e), W.rain * 0.8);
    this.fogMul = W.fog;
    this.night = T.night;
    this.exposure = T.exposure * (1 - 0.4 * W.rain);
    this.clouds.count = W.clouds;
    this.cloudUniforms.uLight.value.setRGB(1, 0.99, 0.97).multiplyScalar(W.cloudLight * (T.night > 0.9 ? 0.12 : 1))
      .lerp(new THREE.Color(T.sun), T.night > 0.9 ? 0 : 0.3);
    this.groundMat.userData.uWet.value = W.wet;
    this.rain.visible = W.rain > 0;
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
    this.updateEnvMap();
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
    for (let k = 0; k < g * g; k++) data[k] = blockTypes[k] * 40;
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
        uTowns: { value: TOWNS.map((t) => new THREE.Vector3(t.x, t.z, t.grid * CITY.block * 0.5)) },
        uWet: mat.userData.uWet,
      });
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vWPos;
          uniform sampler2D uBlockMap;
          uniform float uGrid, uBlock, uHalf, uRoad, uWalk, uWet;
          uniform vec2 uRiver;
          uniform vec3 uTowns[${TOWNS.length}];
          float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float vnoise(vec2 p) {
            vec2 i = floor(p), f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
          }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          float groundWet = 0.0;
          {
            vec2 p = vWPos.xz;
            vec2 lp = mod(p, uBlock);
            vec2 d = min(lp, uBlock - lp);
            float minD = min(d.x, d.y);

            float inMain = step(abs(p.x), uHalf + uWalk) * step(abs(p.y), uHalf + uWalk);
            // Русло реки вырезаем — под ним меш канала и вода
            if (abs(p.y - uRiver.x) < uRiver.y && abs(p.x) < uHalf + 300.0) discard;

            vec3 grass   = vec3(0.20, 0.30, 0.13);
            vec3 asphalt = vec3(0.055, 0.058, 0.064);
            vec3 walk    = vec3(0.40, 0.39, 0.37);
            vec3 lot     = vec3(0.27, 0.27, 0.26);

            float type = 0.0;
            if (inMain > 0.5) {
              vec2 bidx = clamp(floor((p + uHalf) / uBlock), 0.0, uGrid - 1.0);
              type = floor(texture2D(uBlockMap, (bidx + 0.5) / uGrid).r * 255.0 / 40.0 + 0.5);
            }
            float inTown = 0.0;
            for (int i = 0; i < ${TOWNS.length}; i++) {
              vec2 q = abs(p - uTowns[i].xy);
              inTown = max(inTown, step(q.x, uTowns[i].z + uWalk) * step(q.y, uTowns[i].z + uWalk));
            }
            float roads = max(inMain, inTown);

            vec3 col = lot;
            if (type > 0.5 && type < 1.5) col = grass * 1.15;                        // парк
            if (type > 1.5 && type < 2.5) col = grass * 1.3 + vec3(0.02, 0.03, 0.0); // пригород: газоны
            if (type > 2.5 && type < 3.5) col = vec3(0.33, 0.32, 0.29);              // набережная
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
            float n = vnoise(p * 0.08) * 0.6 + vnoise(p * 0.6) * 0.4;
            col *= 0.82 + 0.3 * n;
            groundWet = uWet * (0.5 + 0.5 * isRoad * roads);
            col *= 1.0 - groundWet * 0.35;
            diffuseColor.rgb = col;
          }`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, 0.12, groundWet);`);
    };
    return mat;
  }

  // ---------------------------------------------------------------- рельеф
  createTerrain() {
    const N = TERRAIN_RES, size = WORLD.terrainSize;
    const geo = new THREE.PlaneGeometry(size, size, N, N).rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const H = terrainHeights, W = N + 1;
    const cGrass = new THREE.Color(0x3d5a2a), cDry = new THREE.Color(0x6b6a3e), cRock = new THREE.Color(0x6a625a);
    const cSnow = new THREE.Color(0xf2f4f8), cSand = new THREE.Color(0xcdb98e), cSea = new THREE.Color(0x4a5a52);
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
      const beach = x > coastX(z) - 500 ? 1 - ss(h, 2, 12) : 0;
      c.lerp(cSand, beach);
      c.lerp(cSea, ss(-h, 3, 20));
      colors[k * 3] = c.r; colors[k * 3 + 1] = c.g; colors[k * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vTPos;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvTPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vTPos;
          float th(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
          float tn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
            return mix(mix(th(i), th(i+vec2(1,0)), f.x), mix(th(i+vec2(0,1)), th(i+vec2(1,1)), f.x), f.y); }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          diffuseColor.rgb *= 0.8 + 0.35 * (tn(vTPos.xz * 0.01) * 0.6 + tn(vTPos.xz * 0.12) * 0.4);`);
    };
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    return mesh;
  }

  // Бетонный канал реки внутри города
  createRiverChannel() {
    const len = PLANE_HALF * 2 + 20, depth = -WORLD.riverBed;
    const group = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x6f6a62, roughness: 0.9 });
    const bed = new THREE.Mesh(new THREE.PlaneGeometry(len, RIVER_HALF_W * 2).rotateX(-Math.PI / 2), mat);
    bed.position.set(0, WORLD.riverBed, RIVER_Z);
    group.add(bed);
    for (const s of [-1, 1]) {
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(len, depth), mat);
      wall.position.set(0, WORLD.riverBed + depth / 2, RIVER_Z + s * RIVER_HALF_W);
      wall.rotation.y = s > 0 ? Math.PI : 0;
      group.add(wall);
    }
    group.traverse((o) => { o.receiveShadow = true; });
    return group;
  }

  createWater() {
    const geo = new THREE.PlaneGeometry(WORLD.terrainSize, WORLD.terrainSize, 1, 1).rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0x0f2a36, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.92 });
    mat.userData.uTime = { value: 0 };
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = mat.userData.uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWaterPos;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWaterPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vWaterPos;
          uniform float uTime;`)
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

    const count = 260;
    const geo = new THREE.PlaneGeometry(1, 1);
    this.cloudUniforms = {
      uMap: { value: tex },
      uFogColor: { value: this.fogColor },
      uFogDensity: { value: WORLD.fogDensity * 0.6 },
      uLight: { value: new THREE.Color(1, 0.99, 0.97) },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.cloudUniforms,
      vertexShader: /* glsl */`
        varying vec2 vUv;
        varying float vDist;
        void main() {
          vUv = uv;
          vec4 center = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          float s = length(instanceMatrix[0].xyz);
          center.xy += position.xy * s;
          vDist = -center.z;
          gl_Position = projectionMatrix * center;
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap;
        uniform vec3 uFogColor, uLight;
        uniform float uFogDensity;
        varying vec2 vUv;
        varying float vDist;
        void main() {
          vec4 t = texture2D(uMap, vUv);
          float fog = 1.0 - exp(-pow(uFogDensity * vDist, 2.0));
          float near = smoothstep(20.0, 160.0, vDist);
          // Низ облака темнее — ощущение объёма
          vec3 col = uLight * mix(0.72, 1.0, smoothstep(0.2, 0.8, vUv.y));
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
    while (i < count) {
      const cx = (rnd2() - 0.5) * 16000, cz = (rnd2() - 0.5) * 16000, cy = 900 + rnd2() * 700;
      const n = 4 + Math.floor(rnd2() * 6);
      for (let k = 0; k < n && i < count; k++, i++) {
        const sc = 200 + rnd2() * 300;
        m.makeScale(sc, sc, sc);
        m.setPosition(cx + (rnd2() - 0.5) * 450, cy + (rnd2() - 0.5) * 80, cz + (rnd2() - 0.5) * 450);
        mesh.setMatrixAt(i, m);
      }
    }
    mesh.frustumCulled = false;
    mesh.renderOrder = 10;
    return mesh;
  }

  update(dt, focus, camera) {
    this.time += dt;
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
