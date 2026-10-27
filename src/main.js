import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

import { createInputState, KeyboardMouseSource, endFrame } from './input.js';
import { Environment } from './world/environment.js';
import { City } from './world/city.js';
import { Debris } from './world/debris.js';
import { Particles } from './fx/particles.js';
import { Effects } from './fx/effects.js';
import { Player } from './player/player.js';
import { ThirdPersonCamera } from './camera.js';
import { GameAudio } from './audio.js';
import { HUD } from './hud.js';
import { Fire } from './fx/fire.js';
import { Traffic } from './world/traffic.js';
import { People } from './world/people.js';
import { Props } from './world/props.js';
import { Space } from './world/space.js';
import { Trees } from './world/trees.js';

// ---------------------------------------------------------------- рендер
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.5;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.5, 60000);
scene.add(camera);

const space = new Space();
const composer = new EffectComposer(renderer);
const spacePass = new RenderPass(space.scene, space.camera);
composer.addPass(spacePass);
const mainPass = new RenderPass(scene, camera);
mainPass.clear = false;      // не стираем цвет космоса
mainPass.clearDepth = true;  // но глубину — стираем
composer.addPass(mainPass);
// Страховка: битые пиксели (NaN/бесконечность) обнуляем до bloom,
// иначе он раздувает их в чёрные прямоугольники
composer.addPass(new ShaderPass({
  uniforms: { tDiffuse: { value: null } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      bool bad = any(isnan(c)) || any(isinf(c));
      gl_FragColor = bad ? vec4(0.0, 0.0, 0.0, 1.0) : max(c, vec4(0.0));
    }`,
}));
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.3, 0.4, 1.0);
composer.addPass(bloom);
// Эффект удара и скорости: радиальное размытие, цветовой сдвиг, вспышка, виньетка
const impactPass = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null }, uImpact: { value: 0 }, uCenter: { value: new THREE.Vector2(0.5, 0.5) },
    uSpeed: { value: 0 }, uFlash: { value: 0 }, uCharge: { value: 0 },
  },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uImpact, uSpeed, uFlash, uCharge; uniform vec2 uCenter; varying vec2 vUv;
    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      vec2 dir = vUv - uCenter;
      float blur = uImpact * 0.06 + uSpeed * 0.035 * length(vUv - 0.5);
      vec3 col = base.rgb;
      if (blur > 0.0008) {
        vec3 acc = vec3(0.0);
        for (int i = 0; i < 10; i++) acc += texture2D(tDiffuse, vUv - dir * blur * (float(i) / 9.0)).rgb;
        col = acc / 10.0;
        float ca = uImpact * 0.012;
        col.r = mix(col.r, texture2D(tDiffuse, vUv + dir * ca).r, 0.7);
        col.b = mix(col.b, texture2D(tDiffuse, vUv - dir * ca).b, 0.7);
      }
      float r = length((vUv - 0.5) * vec2(1.6, 1.0));
      col *= 1.0 - (uSpeed * 0.45 + uImpact * 0.25 + uCharge * 0.4) * smoothstep(0.35, 1.0, r);
      col += uFlash * vec3(1.0, 0.96, 0.9);
      gl_FragColor = vec4(col, base.a);
    }`,
});
composer.addPass(impactPass);
composer.addPass(new OutputPass());

// ---------------------------------------------------------------- мир
const hud = new HUD();
const audio = new GameAudio();
const debris = new Debris(scene);
const dust = new Particles(scene, { max: 6000, color: 0x9a8f80, drag: 1.1 });
const glass = new Debris(scene, { max: 2500, glass: true });
const sparks = new Particles(scene, { max: 1500, additive: true, color: 0xffd28a, drag: 2.5 });
const effects = new Effects(scene, camera);
effects.sparkSink = sparks;

const fx = { debris, glass, dust, sparks, effects, audio };
const city = new City(scene, fx);
debris.city = city;
glass.city = city;
const env = new Environment(scene, renderer);
env.onThunder = () => setTimeout(() => audio.thunder(), 300 + Math.random() * 1200);

const fire = new Fire(scene, dust);
const world = { ...fx, city, fire, toast: (t) => hud.toast(t) };
// Общее событие «удар/взрыв в точке»: разлетаются машины, люди, ломаются фонари
world.impact = (point, radius, force, source) => {
  traffic.impulse(point, radius, force, source);
  people.impulse(point, radius, force);
  props.impulse(point, radius, force);
  trees.impulse(point, radius, force);
};
const traffic = world.traffic = new Traffic(scene, world);
const people = world.people = new People(scene, world);
const props = world.props = new Props(scene, world, city.gasSpots);
const trees = world.trees = new Trees(scene, world);
city.onImpact = (p, r, f) => world.impact(p, r, f);
debris.onImpact = (p, r, f) => world.impact(p, r, f);
const player = new Player(scene, world);
const camRig = new ThirdPersonCamera(camera);

city.onDestroyed = () => {
  if (city.destroyed % 25 === 0) hud.toast(`${city.destroyed} ЗДАНИЙ`);
};

// ---------------------------------------------------------------- ввод и пауза
const input = createInputState();
const kbm = new KeyboardMouseSource(renderer.domElement, input);

const overlay = document.getElementById('overlay');
const playBtn = document.getElementById('play-btn');
document.getElementById('loading').classList.add('hidden');
playBtn.classList.remove('hidden');

let paused = true;
function startPlaying() {
  audio.init();
  kbm.requestLock();
}
playBtn.addEventListener('click', startPlaying);
renderer.domElement.addEventListener('click', () => { if (paused) startPlaying(); });
document.addEventListener('pointerlockchange', () => {
  paused = !kbm.locked;
  overlay.classList.toggle('hidden', !paused);
  hud.show(!paused);
  playBtn.textContent = 'Продолжить';
});

window.addEventListener('resize', () => {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
});

// Качество графики (G): для слабых видеокарт
const QUALITY = [
  { name: 'КАЧЕСТВО: ВЫСОКОЕ', pr: 1.25, shadows: true, shadowMap: 2048, bloom: true },
  { name: 'КАЧЕСТВО: СРЕДНЕЕ', pr: 1.0, shadows: true, shadowMap: 1024, bloom: true },
  { name: 'КАЧЕСТВО: НИЗКОЕ', pr: 0.75, shadows: false, shadowMap: 512, bloom: false },
];
let qualityIndex = 0;
function applyQuality(i) {
  const q = QUALITY[i];
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pr));
  composer.setPixelRatio?.(Math.min(window.devicePixelRatio, q.pr));
  composer.setSize(window.innerWidth, window.innerHeight);
  if (renderer.shadowMap.enabled !== q.shadows) {
    renderer.shadowMap.enabled = q.shadows;
    scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
  }
  env.sun.shadow.mapSize.set(q.shadowMap, q.shadowMap);
  env.sun.shadow.map?.dispose();
  env.sun.shadow.map = null;
  bloom.enabled = q.bloom;
  return q.name;
}
// Встроенная графика (Intel и т.п.) — сразу среднее качество
{
  const gl = renderer.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '';
  if (/Intel|UHD|Iris|Mali|Adreno|SwiftShader/i.test(gpu)) { qualityIndex = 1; applyQuality(1); }
}
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyG' && !paused) { qualityIndex = (qualityIndex + 1) % QUALITY.length; hud.toast(applyQuality(qualityIndex)); }
});

function resetWorld() {
  city.reset();
  debris.clear();
  glass.clear();
  dust.clear();
  sparks.clear();
  effects.clear();
  fire.clear();
  traffic.clear();
  people.clear();
  props.reset();
  trees.reset();
  player.spawn();
  hud.toast('ГОРОД ВОССТАНОВЛЕН');
}

// ---------------------------------------------------------------- цикл
const clock = new THREE.Clock();
let hitstop = 0;

function frame() {
  requestAnimationFrame(frame);
  step(Math.min(clock.getDelta(), 0.05), !paused);
  composer.render();
}

// Один шаг симуляции (отдельно от рендера — удобно для тестов)
function step(dt, active) {
  // Кадр с нулевым шагом времени пропускаем: деление на dt дало бы NaN
  if (!(dt > 1e-5)) return;
  if (active) {
    kbm.update();
    if (input.reset) resetWorld();
    if (input.toggleHelp) hud.toggleHelp();
    if (input.cycleTime && env.cycleTime) hud.toast(env.cycleTime());
    if (input.cycleWeather && env.cycleWeather) hud.toast(env.cycleWeather());
    if (input.nextTrack) {
      const name = audio.nextTrack();
      hud.toast(name ? `♪ ${name}` : 'Положите mp3 в папку music/');
    }

    // Хит-стоп: на долю секунды замедляем время при сильном ударе
    if (player.hitstop > 0) { hitstop = Math.max(hitstop, player.hitstop); player.hitstop = 0; }
    let gdt = dt;
    if (hitstop > 0) { hitstop -= dt; gdt = dt * 0.08; }
    // Замедление времени после полностью заряженного удара
    if (player.slowmo > 0) { player.slowmo -= dt; gdt *= 0.25; }

    player.update(gdt, input, camRig);
    city.update(gdt);
    debris.update(gdt);
    glass.update(gdt);
    traffic.update(gdt, player.pos);
    people.update(gdt, player);
    fire.update(gdt);
    dust.update(gdt);
    sparks.update(gdt);
    effects.update(gdt, player);
    hud.update(dt, player, city);
  }

  camRig.update(dt, input, player, city, effects.shakeOffset);
  env.update(dt, player.pos, camera);
  space.update(dt, camera, env.sunDir, env.altitudeK, env.night);
  // Космос рисуем, только когда небо хоть немного прозрачное
  spacePass.enabled = env.sky.material.uniforms.uOpacity.value < 0.995;
  mainPass.clear = !spacePass.enabled;
  props.update(camera.position);
  trees.update(dt, camera.position);
  // На высоком и среднем качестве (со свечением) картинка чуть темнее
  renderer.toneMappingExposure = env.exposure * (1 - env.altitudeK * 0.25) * (bloom.enabled ? 0.88 : 1);
  city.material.userData.uNight.value = env.night;
  props.setNight(env.night);
  const h = renderer.domElement.height;
  dust.setScale(h, camera.fov);
  sparks.setScale(h, camera.fov);
  fire.setScale(h, camera.fov);
  // Пост-эффекты удара/скорости и «толчки» камеры
  impactPass.uniforms.uImpact.value = effects.impact;
  impactPass.uniforms.uCenter.value.copy(effects.impactCenter);
  impactPass.uniforms.uFlash.value = effects.screenFlash;
  impactPass.uniforms.uCharge.value = effects.chargeK;
  impactPass.uniforms.uSpeed.value = THREE.MathUtils.smoothstep(player.vel.length(), 150, 3000) * (1 - env.altitudeK * 0.6);
  camRig.extraFov = effects.fovKick - effects.chargeK * 9;
  audio.listener = camera.position;
  // Фон мегаполиса: громче в центре и у земли, тише в пригороде и с высотой, нет в космосе
  {
    const cp = camera.position, r = Math.max(Math.abs(cp.x), Math.abs(cp.z));
    const inCity = 1 - THREE.MathUtils.smoothstep(r, 1300, 2600);
    const inSuburb = THREE.MathUtils.smoothstep(r, 1000, 1800) * (1 - THREE.MathUtils.smoothstep(r, 2600, 3600));
    const low = 1 - THREE.MathUtils.smoothstep(cp.y, 150, 1800);
    audio.setAmbience(Math.max(inCity, inSuburb * 0.45) * low, inSuburb * low, env.night, env.W.rain);
  }
  audio.update(player.vel.length(), paused, player.pos.y < 1500 ? env.W.rain : 0, env.altitudeK);
  endFrame(input);
}

// Первый кадр — до клика, чтобы за меню был виден город
camRig.update(0.016, input, player, city, effects.shakeOffset);
frame();

// Для отладки из консоли
window.game = {
  scene, camera, renderer, player, city, debris, glass, effects, input, camRig, traffic, people, props, trees, fire, env, audio, space,
  // Запуск без захвата мыши (для автотестов)
  unpause() { paused = false; overlay.classList.add('hidden'); hud.show(true); },
  // Прогнать n кадров симуляции с фиксированным шагом
  sim(n, dt = 1 / 60) { for (let i = 0; i < n; i++) step(dt, true); composer.render(); },
};
