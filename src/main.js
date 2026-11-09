import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

import { createInputState, KeyboardMouseSource, HandSource, endFrame } from './input.js';
import { Environment } from './world/environment.js';
import { TerrainFX } from './world/terrainfx.js';
import { Rocks } from './world/rocks.js';
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
import { StreetLife } from './world/streetlife.js';
import { AirLife } from './world/air.js';
import { Beach } from './world/beach.js';
import { Island } from './world/island.js';
import { Pier } from './world/pier.js';
import { Nature } from './world/nature.js';
import { Animals } from './world/animals.js';
import { WaterLife } from './world/waterlife.js';
import { Critters } from './world/critters.js';
import { Countryside } from './world/countryside.js';
import { Props } from './world/props.js';
import { Space } from './world/space.js';
import { BlackHole } from './world/blackhole.js';
import { PlanetMap } from './world/planetmap.js';
import { Trees } from './world/trees.js';
import { Soundscape } from './soundscape.js';
import { WildSound } from './wildsound.js';
import { BossBattle } from './boss/battle.js';
import { Invasion } from './boss/invasion.js';
import { installSunFog, createGodRaysPass, createGradePass, updateCinematic } from './fx/cinematic.js';
import { HALF } from './world/layout.js';

// Туман со светом солнца — до создания и компиляции материалов
installSunFog();

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
// Чёрная дыра: искривляет уже нарисованный космос (до основной сцены — герой и город поверх)
const blackHole = new BlackHole(scene);
composer.addPass(blackHole.pass);
const mainPass = new RenderPass(scene, camera);
mainPass.clear = false;      // не стираем цвет космоса
mainPass.clearDepth = true;  // но глубину — стираем
composer.addPass(mainPass);
// Плавающее начало координат: у Луны и планет (сотни и тысячи км от центра) основную сцену
// рисуем со сдвигом к камере — иначе float32 в матрицах костей героя заметно дрожит.
// Ближе 65 км не сдвигаем: город и рельеф считают узоры по мировым координатам
// (а дальше 60 км их всё равно отсекает дальняя плоскость камеры)
const FAR_ORIGIN = 65000;
function renderFrame() {
  const far = camera.position.lengthSq() > FAR_ORIGIN * FAR_ORIGIN;
  if (far) scene.position.copy(camera.position).negate();
  composer.render();
  if (far) { scene.position.set(0, 0, 0); scene.updateMatrixWorld(); }
}
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
// Лучи солнца (по яркому небу, до тонмаппинга)
const godRays = createGodRaysPass();
composer.addPass(godRays);
// Эффект удара и скорости: радиальное размытие, цветовой сдвиг, вспышка, виньетка
const impactPass = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null }, uImpact: { value: 0 }, uCenter: { value: new THREE.Vector2(0.5, 0.5) },
    uSpeed: { value: 0 }, uFlash: { value: 0 }, uCharge: { value: 0 }, uSlow: { value: 0 },
  },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uImpact, uSpeed, uFlash, uCharge, uSlow; uniform vec2 uCenter; varying vec2 vUv;
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
      col *= 1.0 - (uSpeed * 0.45 + uImpact * 0.25 + uCharge * 0.4 + uSlow * 0.5) * smoothstep(0.35, 1.0, r);
      // Время вязнет: цвет уходит и холодеет, остаётся только сам удар
      col = mix(col, dot(col, vec3(0.3, 0.59, 0.11)) * vec3(0.93, 0.98, 1.08), uSlow * 0.38);
      col += uFlash * vec3(1.0, 0.96, 0.9);
      gl_FragColor = vec4(col, base.a);
    }`,
});
composer.addPass(impactPass);
composer.addPass(new OutputPass());
// Цветокоррекция по времени суток и зерно — в самом конце
const grade = createGradePass();
composer.addPass(grade);

// ---------------------------------------------------------------- мир
const hud = new HUD();
const audio = new GameAudio();
const soundscape = new Soundscape(audio);
const wild = new WildSound(audio, soundscape);
const debris = new Debris(scene);
const dust = new Particles(scene, { max: 6000, color: 0x9a8f80, drag: 1.1 });
const glass = new Debris(scene, { max: 2500, glass: true });
const sparks = new Particles(scene, { max: 1500, additive: true, color: 0xffd28a, drag: 2.5 });
const effects = new Effects(scene, camera);
effects.warmup();
effects.sparkSink = sparks;

const fx = { debris, glass, dust, sparks, effects, audio };
const city = new City(scene, fx);
debris.city = city;
glass.city = city;
const env = new Environment(scene, renderer);
env.onThunder = () => setTimeout(() => audio.thunder(), 300 + Math.random() * 1200);

const fire = new Fire(scene, dust);
const world = { ...fx, city, fire, camera, toast: (t, d) => hud.toast(t, d) };
const planetMap = world.planetMap = new PlanetMap(scene, space, world);
// Общее событие «удар/взрыв в точке»: разлетаются машины, люди, ломаются фонари
world.impact = (point, radius, force, source) => {
  traffic.impulse(point, radius, force, source);
  people.impulse(point, radius, force);
  props.impulse(point, radius, force);
  trees.impulse(point, radius, force);
  street.impulse(point, radius, force);
  air.impulse(point, radius, force);
  beach.impulse(point, radius, force);
  nature.impulse(point, radius, force);
  animals.impulse(point, radius, force);
  rocks.explode(point, radius, force);
};
const traffic = world.traffic = new Traffic(scene, world);
const people = world.people = new People(scene, world);
const props = world.props = new Props(scene, world, city.gasSpots);
const trees = world.trees = new Trees(scene, world);
const street = world.street = new StreetLife(scene, world);
const air = world.air = new AirLife(scene, world);
const beach = world.beach = new Beach(scene, world);
const island = world.island = new Island(scene, world);
const pier = world.pier = new Pier(scene, world);
const nature = world.nature = new Nature(scene, world);
const animals = world.animals = new Animals(scene, world);
const waterlife = world.waterlife = new WaterLife(scene, world);
const critters = world.critters = new Critters(scene, world);
const countryside = world.countryside = new Countryside(scene, world);
// Горы ломаются как здания: таран и удар разваливают склон на глыбы, края осыпаются
const rocks = world.rocks = new Rocks(scene, world);
const terrainFX = world.terrainFX = new TerrainFX(world, env);
blackHole.world = world;
world.soundscape = soundscape;
city.onImpact = (p, r, f) => world.impact(p, r, f);
debris.onImpact = (p, r, f) => world.impact(p, r, f);
const player = new Player(scene, world);
const camRig = new ThirdPersonCamera(camera);
const battle = new BossBattle(scene, world, player, hud, camera);
const invasion = new Invasion(scene, world, player, hud, camera, camRig);
invasion.onWarm = () => renderer.compile(scene, camera);
planetMap.blocked = () => battle.active || invasion.active;

city.onDestroyed = () => {
  if (city.destroyed % 25 === 0) hud.toast(`${city.destroyed} ЗДАНИЙ`);
};

// ---------------------------------------------------------------- ввод и пауза
const input = createInputState();
const kbm = new KeyboardMouseSource(renderer.domElement, input);
// Управление с камеры: Ctrl запускает GameTracking/Moves.py (через server.py), повторный Ctrl — останавливает
const hands = new HandSource(input);
const ctrlBadge = document.getElementById('ctrl-badge');
let ctrlText = '';
function setControl(cam, quiet) {
  hands.setEnabled(cam);
  ctrlBadge.classList.toggle('show', cam);
  ctrlText = '';
  if (!quiet) hud.toast(cam ? 'УПРАВЛЕНИЕ: КАМЕРА' : 'УПРАВЛЕНИЕ: ПК');
}
function updateCtrlBadge() {
  if (!hands.enabled) return;
  const t = hands.status();
  if (t !== ctrlText) { ctrlText = t; ctrlBadge.textContent = t; ctrlBadge.classList.toggle('live', hands.live); }
}


const overlay = document.getElementById('overlay');
const playBtn = document.getElementById('play-btn');
const $ = (id) => document.getElementById(id);
// Меню — только когда готово тело героя: иначе в игре остался бы процедурный «манекен»
$('modes').style.visibility = 'hidden';
player.model.ready.then(() => {
  $('loading').classList.add('hidden');
  $('modes').style.visibility = '';
});

// Главное меню: выбор режима. Симулятор и битва с боссом; сюжет — в разработке.
let paused = true;
let mode = null;            // 'sim' | 'boss' | 'invasion' (потом — 'story')
// Экран: main — выбор режима, pause — пауза, end — итог битвы
const showMenu = (which) => {
  $('modes').classList.toggle('hidden', which !== 'main');
  $('pause-btns').classList.toggle('hidden', which !== 'pause');
  $('battle-end').classList.toggle('hidden', which !== 'end');
  if (which !== 'main') $('story-note').classList.add('hidden');
};
showMenu('main');
function startPlaying() {
  audio.init();
  kbm.requestLock();
}
// Битва всегда начинается в целом городе; из битвы в симулятор — тоже с чистого листа
function enterMode(m) {
  if (battle.active) battle.stop();
  if (invasion.active) invasion.stop();
  if (m === 'boss') { resetWorld(true); battle.start(); }
  else if (m === 'invasion') { resetWorld(true); invasion.start(); }
  else if (mode === 'boss' || mode === 'invasion') resetWorld(true);
  mode = m;
  kbm.spinF = m === 'invasion';
}
function startMode(m) {
  enterMode(m);
  startPlaying();
}
$('mode-sim').addEventListener('click', () => startMode('sim'));
$('mode-boss').addEventListener('click', () => startMode('boss'));
$('mode-invasion').addEventListener('click', () => startMode('invasion'));
$('mode-story').addEventListener('click', () => { $('story-note').classList.remove('hidden'); });
playBtn.addEventListener('click', startPlaying);
$('end-retry').addEventListener('click', () => startMode(mode));
$('end-menu').addEventListener('click', () => { enterMode('sim'); mode = null; showMenu('main'); });
battle.onEnd = invasion.onEnd = (win, title, sub) => {
  $('end-title').textContent = title;
  $('end-sub').textContent = sub;
  $('battle-end').classList.toggle('lose', !win);
  document.exitPointerLock();
  showMenu('end');
};
$('menu-btn').addEventListener('click', () => {
  showMenu('main');
  // В меню — без фоторежима и замедления
  if (photo.on) setPhoto(false);
  if (slow.on) { slow.on = false; audio.setMuffle?.(0); slowBadge.classList.remove('show'); }
});
const modeEnded = () => (mode === 'invasion' ? invasion.ended : battle.ended);
renderer.domElement.addEventListener('click', () => { if (paused && mode && !modeEnded()) startPlaying(); });
document.addEventListener('pointerlockchange', () => {
  paused = !kbm.locked;
  overlay.classList.toggle('hidden', !paused);
  hud.show(!paused && !photo.on);
  // На паузе — «Продолжить» и «Главное меню»
  if (paused && mode) showMenu(modeEnded() ? 'end' : 'pause');
});

window.addEventListener('resize', () => {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
});

// ---------------------------------------------------------------- адаптивное качество
// Разрешение всегда полное — герой и даль остаются чёткими. Когда видеокарта не успевает
// (FPS ниже ~54), по ступеням и временно упрощаем то, что глазу почти незаметно:
//   1 — тени обновляются через кадр;
//   2 — плюс дальние деревья и мелкие детали упрощаются ближе;
//   3 — плюс тени раз в 3 кадра.
// Как только появляется запас — ступень за ступенью обратно. Нагрузку меряем таймером
// видеокарты (если браузер его даёт), иначе — по времени кадра. На паузе и в фоторежиме — максимум.
const dyn = { level: 0, base: Math.min(window.devicePixelRatio, 1.25), acc: 0, frames: 0, gpu: 0, gpuN: 0, calm: 0, slow: 0, queries: [], active: null, frame: 0 };
const _gl = renderer.getContext();
const _timer = _gl.getExtension('EXT_disjoint_timer_query_webgl2');
const LEVELS = [
  { shadowEvery: 1, lod: 350, streetSmall: 480, facade: 600 },
  { shadowEvery: 2, lod: 350, streetSmall: 480, facade: 600 },
  { shadowEvery: 2, lod: 230, streetSmall: 380, facade: 450 },
  { shadowEvery: 3, lod: 200, streetSmall: 340, facade: 420 },
];
function applyScale() {
  renderer.setPixelRatio(dyn.base);
  composer.setPixelRatio?.(dyn.base);
  composer.setSize(window.innerWidth, window.innerHeight);
  // Лёгкая резкость: мелкие детали чуть чётче
  grade.uniforms.uTexel.value.set(1 / Math.max(1, Math.round(window.innerWidth * dyn.base)), 1 / Math.max(1, Math.round(window.innerHeight * dyn.base)));
  grade.uniforms.uSharp.value = 0.25;
}
function applyLevel() {
  const L = LEVELS[dyn.level];
  trees.lodNear = L.lod;
  street.smallView = L.streetSmall;
  city.smallAttachView = L.facade;
  hud.qualityLevel = dyn.level;
}
// Перед кадром: обновлять ли карту теней в этом кадре
function shadowTick() {
  const every = LEVELS[dyn.level].shadowEvery;
  dyn.frame++;
  renderer.shadowMap.autoUpdate = every === 1;
  if (every > 1) renderer.shadowMap.needsUpdate = dyn.frame % every === 0;
}
function gpuBegin() {
  if (!_timer || dyn.active) return;
  dyn.active = _gl.createQuery();
  _gl.beginQuery(_timer.TIME_ELAPSED_EXT, dyn.active);
}
function gpuEnd() {
  if (!dyn.active) return;
  _gl.endQuery(_timer.TIME_ELAPSED_EXT);
  dyn.queries.push(dyn.active);
  dyn.active = null;
}
function gpuPoll() {
  while (dyn.queries.length && _gl.getQueryParameter(dyn.queries[0], _gl.QUERY_RESULT_AVAILABLE)) {
    const q = dyn.queries.shift();
    if (!_gl.getParameter(_timer.GPU_DISJOINT_EXT)) { dyn.gpu += _gl.getQueryParameter(q, _gl.QUERY_RESULT) / 1e6; dyn.gpuN++; }
    _gl.deleteQuery(q);
  }
  if (dyn.queries.length > 8) { for (const q of dyn.queries) _gl.deleteQuery(q); dyn.queries.length = 0; }
}
function setLevel(l) {
  l = THREE.MathUtils.clamp(l, 0, LEVELS.length - 1);
  if (l === dyn.level) return;
  dyn.level = l;
  applyLevel();
}
function updateAdaptiveQuality(dt) {
  if (_timer) gpuPoll();
  if (paused || photo.on) {
    setLevel(0);
    dyn.acc = dyn.frames = 0;
    return;
  }
  dyn.acc += dt; dyn.frames++;
  if (dyn.acc < 0.5) return;
  const frameMs = dyn.acc / dyn.frames * 1000;
  const gpuMs = dyn.gpuN ? dyn.gpu / dyn.gpuN : 0;
  dyn.acc = dyn.frames = dyn.gpu = dyn.gpuN = 0;
  // Тормозим (две проверки подряд) и виновата видеокарта (если тормозит процессор,
  // упрощение графики не поможет)
  if (frameMs > 18.5 && (!gpuMs || gpuMs > 13)) {
    dyn.calm = 0;
    if (++dyn.slow >= 2) { dyn.slow = 0; setLevel(dyn.level + 1); }
  } else {
    dyn.slow = 0;
    // Запас есть — возвращаем качество (с осторожностью: ступень назад стоит ~1–3 мс)
    const room = gpuMs ? gpuMs < 11.5 : frameMs < 17.5;
    dyn.calm = room ? dyn.calm + 1 : 0;
    if (dyn.calm >= (gpuMs ? 3 : 8)) { dyn.calm = 0; setLevel(dyn.level - 1); }
  }
}
window.addEventListener('resize', () => applyScale());
applyScale();

// Качество графики (G): для слабых видеокарт
const QUALITY = [
  { name: 'КАЧЕСТВО: ВЫСОКОЕ', pr: 1.25, shadows: true, shadowMap: 2048, bloom: true },
  { name: 'КАЧЕСТВО: СРЕДНЕЕ', pr: 1.0, shadows: true, shadowMap: 1024, bloom: true },
  { name: 'КАЧЕСТВО: НИЗКОЕ', pr: 0.75, shadows: false, shadowMap: 512, bloom: false },
];
let qualityIndex = 0;
function applyQuality(i) {
  const q = QUALITY[i];
  dyn.base = Math.min(window.devicePixelRatio, q.pr);
  applyScale();
  if (renderer.shadowMap.enabled !== q.shadows) {
    renderer.shadowMap.enabled = q.shadows;
    scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
  }
  env.sun.shadow.mapSize.set(q.shadowMap, q.shadowMap);
  env.sun.shadow.map?.dispose();
  env.sun.shadow.map = null;
  bloom.enabled = q.bloom;
  blackHole.setQuality(i);
  return q.name;
}
// Встроенная графика (Intel и т.п.) — сразу среднее качество
{
  const gl = renderer.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '';
  if (/Intel|UHD|Iris|Mali|Adreno|SwiftShader/i.test(gpu)) { qualityIndex = 1; applyQuality(1); }
}
// ---------------------------------------------------------------- фоторежим (P)
// Мир замирает, камера свободно облетает героя, фильтры, снимок сохраняется в PNG
const FILTERS = ['Без фильтра', 'Кино', 'Нуар', 'Тёплый закат', 'Винтаж', 'Холод'];
const photo = { on: false, yaw: 0, pitch: 0.15, dist: 5, lift: 0, filter: 0, letter: false };
const photoUI = document.getElementById('photo-ui');
const photoFilterEl = document.getElementById('photo-filter');
const photoFlash = document.getElementById('photo-flash');
const _pc = new THREE.Vector3();
function setPhoto(on) {
  photo.on = on;
  if (on) {
    _pc.copy(player.pos).setY(player.pos.y + 1.1);
    const off = camera.position.clone().sub(_pc);
    photo.dist = THREE.MathUtils.clamp(off.length(), 1.2, 60);
    photo.yaw = Math.atan2(off.x, off.z);
    photo.pitch = Math.asin(THREE.MathUtils.clamp(off.y / Math.max(off.length(), 1e-3), -1, 1));
    photo.lift = 0;
    photo.near = camera.near;
  } else if (photo.near) {
    camera.near = photo.near;
    camera.updateProjectionMatrix();
  }
  photoUI.classList.toggle('hidden', !on);
  hud.show(!on && !paused);
  grade.uniforms.uFilter.value = on ? photo.filter : 0;
  grade.uniforms.uLetter.value = on && photo.letter ? 1 : 0;
  photoFilterEl.textContent = FILTERS[photo.filter];
}
function updatePhotoCamera(dt) {
  photo.yaw -= input.lookDX * 0.004 + input.moveX * dt * 1.2;
  photo.pitch = THREE.MathUtils.clamp(photo.pitch + input.lookDY * 0.004, -1.2, 1.45);
  photo.dist = THREE.MathUtils.clamp(photo.dist * (1 - input.moveZ * dt * 1.6), 0.9, 120);
  photo.lift = THREE.MathUtils.clamp(photo.lift + input.moveY * dt * 2.5, -1.5, 40);
  _pc.copy(player.pos).setY(player.pos.y + 1.1 + photo.lift);
  const cp = Math.cos(photo.pitch);
  camera.position.set(_pc.x + Math.sin(photo.yaw) * cp * photo.dist, _pc.y + Math.sin(photo.pitch) * photo.dist, _pc.z + Math.cos(photo.yaw) * cp * photo.dist);
  camera.near = 0.08;
  camera.lookAt(_pc);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}
function savePhoto() {
  renderFrame();
  renderer.domElement.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `last-son-of-hope-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }, 'image/png');
  photoFlash.classList.add('on');
  requestAnimationFrame(() => requestAnimationFrame(() => photoFlash.classList.remove('on')));
  audio.ctx && soundscape.shutter?.(camera.position.clone());
}
renderer.domElement.addEventListener('wheel', (e) => {
  if (!photo.on) return;
  photo.dist = THREE.MathUtils.clamp(photo.dist * (e.deltaY > 0 ? 1.12 : 0.89), 0.9, 120);
}, { passive: true });

// ---------------------------------------------------------------- замедление времени (V)
// Мир живёт в 4 раза медленнее, герой — в обычном темпе; звук приглушён
const slow = { on: false, k: 1 };
const slowBadge = document.getElementById('slowmo-badge');

window.addEventListener('keydown', (e) => {
  if (photo.on && !paused) {
    const n = e.code.startsWith('Digit') ? Number(e.code.slice(5)) : 0;
    if (n >= 1 && n <= FILTERS.length) { photo.filter = n - 1; grade.uniforms.uFilter.value = photo.filter; photoFilterEl.textContent = FILTERS[photo.filter]; }
    if (e.code === 'KeyL') { photo.letter = !photo.letter; grade.uniforms.uLetter.value = photo.letter ? 1 : 0; }
    if (e.code === 'Enter') savePhoto();
    if (e.code === 'KeyH') photoUI.classList.toggle('min');
    return;
  }
  if (e.code === 'KeyN' && !paused) {
    if (invasion.active) hud.toast(invasion.theme.toggle() ? 'ТЕМА БОЯ: ВКЛ' : 'ТЕМА БОЯ: ВЫКЛ');
    else hud.toast(soundscape.toggleScore() ? 'МУЗЫКА: ВКЛ' : 'МУЗЫКА: ВЫКЛ');
  }
  if (e.code === 'KeyG' && !paused) { qualityIndex = (qualityIndex + 1) % QUALITY.length; hud.toast(applyQuality(qualityIndex)); }
});

function resetWorld(quiet = false) {
  city.reset();
  debris.clear();
  glass.clear();
  dust.clear();
  sparks.clear();
  effects.clear();
  fire.clear();
  traffic.clear();
  people.clear();
  animals.clear();
  props.reset();
  trees.reset();
  terrainFX.reset();
  blackHole.reset();
  street.reset();
  air.reset();
  beach.reset();
  nature.reset();
  planetMap.leave();
  player.spawn();
  if (!quiet) hud.toast('ГОРОД ВОССТАНОВЛЕН');
}

// ---------------------------------------------------------------- цикл
const clock = new THREE.Clock();
const _camRight = new THREE.Vector3();
let hitstop = 0;

function frame() {
  requestAnimationFrame(frame);
  const dt = clock.getDelta();
  step(Math.min(dt, 0.05), !paused);
  shadowTick();
  gpuBegin();
  renderFrame();
  gpuEnd();
  updateAdaptiveQuality(Math.min(dt, 0.1));
}

// Один шаг симуляции (отдельно от рендера — удобно для тестов)
function step(dt, active) {
  // Кадр с нулевым шагом времени пропускаем: деление на dt дало бы NaN
  if (!(dt > 1e-5)) return;
  if (active && input.photo) setPhoto(!photo.on);
  if (active && photo.on) {
    // Фоторежим: мир стоит, крутится только камера
    kbm.update();
    if (input.toggleHelp) hud.toggleHelp();
    updatePhotoCamera(dt);
  } else if (active) {
    kbm.update();
    if (input.toggleControl) setControl(!hands.enabled);
    hands.update(dt, player, camRig.sensitivity);
    updateCtrlBadge();
    if (input.slowmo) {
      slow.on = !slow.on;
      audio.setMuffle?.(slow.on ? 1 : 0);
      slowBadge.classList.toggle('show', slow.on);
    }
    if (input.reset && mode !== 'boss' && mode !== 'invasion') resetWorld();
    if (input.toggleHelp) hud.toggleHelp();
    if (input.cycleTime && env.cycleTime) hud.toast(env.cycleTime());
    if (input.cycleWeather && env.cycleWeather) hud.toast(env.cycleWeather());
    if (input.nextTrack) {
      if (invasion.active) hud.toast(invasion.theme.next(), 2.6);
      else {
        const name = audio.nextTrack();
        hud.toast(name ? `♪ ${name}` : 'Положите mp3 в папку music/');
      }
    }

    // Хит-стоп: на долю секунды замедляем время при сильном ударе
    if (player.hitstop > 0) { hitstop = Math.max(hitstop, player.hitstop); player.hitstop = 0; }
    let gdt = dt;
    if (hitstop > 0) { hitstop -= dt; gdt = dt * 0.08; }
    // Замедление времени после полностью заряженного удара
    if (player.slowmo > 0) { player.slowmo -= dt; gdt *= 0.25; }
    // Вторжение само замедляет время: окно серии, уклонение, финальный удар
    if (invasion.active) gdt *= invasion.timeScale;
    // Замедление: мир медленнее, герой в своём темпе
    slow.k += ((slow.on ? 0.25 : 1) - slow.k) * Math.min(1, dt * 6);
    const pdt = gdt;
    gdt *= slow.k;

    invasion.preUpdate(input, dt);
    // Притяжение дыры — до хода героя: иначе модель встаёт на старое место, а камера уходит вперёд
    blackHole.tick(dt, player, camRig);
    player.update(pdt, input, camRig);
    planetMap.tick(player);
    if (mode === 'boss') battle.update(gdt, dt);
    if (mode === 'invasion') invasion.update(gdt, dt, input);
    city.update(gdt);
    debris.update(gdt);
    glass.update(gdt);
    traffic.update(gdt, player.pos);
    people.update(gdt, player);
    animals.update(gdt, player);
    waterlife.update(gdt, player, camera.position);
    critters.update(gdt, player, camera.position, env.night);
    countryside.update(gdt, camera.position);
    terrainFX.update(gdt);
    rocks.update(gdt, player);
    fire.update(gdt);
    dust.update(gdt);
    sparks.update(gdt);
    effects.update(gdt, player, invasion.active ? dt : gdt);
    air.update(gdt, player, camera.position, env.night, env.W.rain);
    hud.update(dt, player, city);
  }

  if (!photo.on) camRig.update(dt, input, player, city, effects.shakeOffset);
  env.update(dt, player.pos, camera, !paused && !photo.on);
  if (invasion.active) invasion.fx.applyEnv(env, scene, camera);
  planetMap.update(paused || photo.on ? 0 : dt, camera, env, player);
  space.update(dt, camera, env.sunDir, env.altitudeK, env.night, player);
  blackHole.update(paused ? 0 : dt, camera, space.camera, space.earthCenter, space.earthR);
  env.setSkyHole(blackHole.skyHole(camera.position), 1 - env.night);
  hud.markers(camera, player, !paused && !photo.on && !planetMap.active);
  // Космос рисуем, только когда небо хоть немного прозрачное
  // (и днём, если в кадре чёрная дыра — она проглядывает сквозь небо призраком)
  spacePass.enabled = env.sky.material.uniforms.uOpacity.value < 0.995 || blackHole.pass.enabled;
  blackHole.pass.enabled = blackHole.pass.enabled && spacePass.enabled;
  mainPass.clear = !spacePass.enabled;
  props.update(camera.position);
  city.updateView(camera.position, dt);
  trees.update(dt, camera.position);
  street.update(dt, camera.position);
  beach.update(dt);
  island.update(paused || photo.on ? 0 : dt * slow.k, camera.position, env, player);
  pier.update(paused || photo.on ? 0 : dt * slow.k, env.night, camera.position);
  nature.update(dt, camera.position);
  // На высоком и среднем качестве (со свечением) картинка чуть темнее
  renderer.toneMappingExposure = env.exposure * (1 - env.altitudeK * 0.25) * (bloom.enabled ? 0.88 : 1) * (1 - 0.32 * (env.glare || 0)) * (invasion.active ? 1 - 0.18 * invasion.fx.smog : 1);
  city.material.userData.uNight.value = env.night;
  props.setNight(env.night);
  traffic.setNight(env.night);
  street.setNight(env.night);
  nature.setNight(env.night);
  const h = renderer.domElement.height;
  dust.setScale(h, camera.fov);
  sparks.setScale(h, camera.fov);
  fire.setScale(h, camera.fov);
  // Пост-эффекты удара/скорости и «толчки» камеры
  impactPass.uniforms.uImpact.value = effects.impact;
  impactPass.uniforms.uCenter.value.copy(effects.impactCenter);
  impactPass.uniforms.uFlash.value = effects.screenFlash;
  impactPass.uniforms.uCharge.value = effects.chargeK;
  impactPass.uniforms.uSlow.value = invasion.active ? invasion.fx.slowK : 0;
  impactPass.uniforms.uSpeed.value = THREE.MathUtils.smoothstep(player.vel.length(), 150, 3000) * (1 - env.altitudeK * 0.6);
  camRig.extraFov = effects.fovKick - effects.chargeK * 9 - (invasion.active ? invasion.fx.zoom : 0);
  updateCinematic({ env, camera, godRays, grade, dt, quality: qualityIndex });
  // Лёгкая виньетка всегда (киношный кадр), сильнее — в фоторежиме и замедлении
  grade.uniforms.uVig.value = photo.on ? 0.35 : 0.16 + (1 - slow.k) * 0.5;
  if (invasion.active) invasion.fx.applyGrade(grade);
  // Свечение: мягче днём, сильнее на закате и ночью — огни города «дышат»
  bloom.strength = 0.26 + env.night * 0.26;
  audio.listener = camera.position;
  // Фон мегаполиса: громче в центре и у земли, тише в пригороде и с высотой, нет в космосе
  {
    const cp = camera.position, r = Math.max(Math.abs(cp.x), Math.abs(cp.z));
    const inCity = 1 - THREE.MathUtils.smoothstep(r, 2400, 3800);
    const inSuburb = THREE.MathUtils.smoothstep(r, 2100, 2900) * (1 - THREE.MathUtils.smoothstep(r, HALF + 200, HALF + 1200));
    const low = 1 - THREE.MathUtils.smoothstep(cp.y, 150, 1800);
    audio.setAmbience(Math.max(inCity, inSuburb * 0.45) * low, inSuburb * low, env.night, env.W.rain);
  }
  audio.listenerRight = _camRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
  soundscape.update({ dt, player, camera, people, traffic, city, env, paused });
  wild.update({ dt: dt * slow.k, camera, env, world, paused: paused || photo.on, menu: paused, slow: slow.k });
  if (paused) air.mute();
  invasion.setPaused(paused || invasion.ended);
  audio.update(player.vel.length(), paused, player.pos.y < 1500 ? env.W.rain : 0, env.altitudeK);
  endFrame(input);
}

// Первый кадр — до клика, чтобы за меню был виден город
camRig.update(0.016, input, player, city, effects.shakeOffset);
frame();

// Для отладки из консоли
window.game = {
  scene, camera, renderer, player, city, battle, invasion, hands, setControl, wild, island, debris, glass, effects, input, camRig, traffic, people, props, trees, street, air, beach, pier, nature, animals, waterlife, critters, countryside, soundscape, fire, composer, bloom, godRays, grade, env, audio, space, planetMap, blackHole,
  // Запуск без захвата мыши (для автотестов)
  unpause() { paused = false; overlay.classList.add('hidden'); hud.show(true); },
  // Начать режим без захвата мыши (для автотестов)
  mode(m) { enterMode(m); },
  // Прогнать n кадров симуляции с фиксированным шагом
  sim(n, dt = 1 / 60) { for (let i = 0; i < n; i++) step(dt, true); renderFrame(); },
  // То же без рендера: шаги логики для проверок боя
  steps(n, dt = 1 / 60) { for (let i = 0; i < n; i++) step(dt, true); },
  // Кадр с адаптивным качеством (frameDt — сколько «длился» кадр), состояние — в quality
  quality: dyn,
  frameQ(frameDt) { shadowTick(); gpuBegin(); renderFrame(); gpuEnd(); updateAdaptiveQuality(frameDt); },
};
