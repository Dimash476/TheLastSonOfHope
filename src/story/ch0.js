import * as THREE from 'three';
import { ALL_BODIES, XARRON_ORIGIN } from '../world/bodies.js';
import { XARRON_GATE, EARTH_GATE, Portal } from '../world/portal.js';
import { WORLD } from '../config.js';
import { islandHeight } from '../world/layout.js';
import { Kin } from '../boss/kin.js';
import { Ship, Pod, Trail, TEIV_LIGHT } from './props.js';

// Пролог «Ночь перед присягой». Сцена целиком, управления нет, ЛКМ пропускает. Около трёх минут.
//  0. Чёрный экран: Совет Ксаррона объявляет, что род Тейв присягнёт на рассвете — и врата, и кровь Тейв.
//  A. Ксаррон: корабль Илены с младенцем уходит к Вратам Ксаррона, за ним сам летит молодой капитан Ксарг.
//     Разговор в погоне: ребёнка стерёг он; Ксарг бьёт лучом и ранит корабль; врата открываются на её кровь.
//  B. Земля, гроза у Райского острова: Илена напевает сыну и отпускает капсулу в прибой; предлагает Ксаргу
//     уйти домой, пока врата открыты, — он остаётся; она рушит врата. Корабль уходит вверх, Ксарг — за ним.
//  C. Берег: фонарь Элиаса, имя на капсуле — «АР…Н», «Адриан, значит». Название игры, «Двадцать лет спустя».
// Музыка (score.js): pro-council → pro-chase → pro-gate → pro-storm → pro-lullaby → pro-storm → pro-gate →
// pro-farewell → title. pro-gate ставится ровно за 4 с до вспышки врат.

const UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3(), _eye = new THREE.Vector3(), _eyePt = new THREE.Vector3();
const V = (x, y, z) => new THREE.Vector3(x, y, z);

const XARRON = ALL_BODIES.find((b) => b.id === 'xarron');
const CUES = ['pro-council', 'pro-chase', 'pro-gate', 'pro-storm', 'pro-lullaby', 'pro-farewell', 'title'];
const GATE_HIT = 4;   // с: удар в pro-gate

// Луч: с борта корабля во врата (тёплый) или из глаз Ксарга (красный)
class Beam {
  constructor(scene, color = new THREE.Color(1.0, 0.88, 0.66)) {
    this.u = { uK: { value: 0 }, uTime: { value: 0 }, uColor: { value: color } };
    const m = new THREE.ShaderMaterial({
      uniforms: this.u, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform float uK, uTime; uniform vec3 uColor; varying vec2 vUv;
        void main() { float e = 1.0 - abs(vUv.x - 0.5) * 2.0; float a = uK * pow(e, 1.5) * (0.85 + 0.15 * sin(vUv.y * 80.0 - uTime * 40.0));
          gl_FragColor = vec4(uColor * 3.0 * a, a); }`,
    });
    this.mesh = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 10, 1, true).translate(0, 0.5, 0), m);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  set(a, b, w, k, dt) {
    this.mesh.visible = k > 0.01;
    if (!this.mesh.visible) return;
    _d.subVectors(b, a);
    this.mesh.position.copy(a);
    this.mesh.quaternion.setFromUnitVectors(UP, _d.clone().normalize());
    this.mesh.scale.set(w, _d.length(), w);
    this.u.uK.value = k;
    this.u.uTime.value += dt;
  }
}

// Ударная волна врат: светящаяся сфера, расходится и гаснет
class Shock {
  constructor(scene) {
    this.u = { uK: { value: 0 } };
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), new THREE.ShaderMaterial({
      uniforms: this.u, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
      vertexShader: 'varying vec3 vN, vV; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vN = normalize(mat3(modelMatrix) * normal); vV = normalize(cameraPosition - w.xyz); gl_Position = projectionMatrix * viewMatrix * w; }',
      fragmentShader: 'uniform float uK; varying vec3 vN, vV; void main() { float f = pow(1.0 - abs(dot(vN, vV)), 2.5); float a = uK * f; gl_FragColor = vec4(vec3(1.0, 0.92, 0.8) * 2.5 * a, a); }',
    }));
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.t = -1;
  }

  fire(p, r) { this.t = 0; this.r = r; this.mesh.position.copy(p); this.mesh.visible = true; }

  update(dt) {
    if (this.t < 0) return;
    this.t += dt;
    const k = Math.min(1, this.t / 2.2);
    this.mesh.scale.setScalar(this.r * (0.3 + 6 * (1 - Math.pow(1 - k, 3))));
    this.u.uK.value = (1 - k) * 0.9;
    if (k >= 1) { this.t = -1; this.mesh.visible = false; }
  }
}

// Ксарг-кукла: та же модель, что во Вторжении (своя фабрика), но телом ведёт сцена.
// Молодой капитан одет иначе, чем генерал: плащ тёмно-красный, швы брони тлеют — чтобы его не спутать с героем
class Puppet extends Kin {
  constructor(shim) {
    super(shim, 'general');
    this.faceTarget = false;
    this.grounded = false;
    const cape = this.model.cape?.mesh?.material;
    if (cape) {
      cape.color.set(0x4a0c12);
      cape.sheenColor?.setRGB(0.55, 0.1, 0.08);
    }
    // Холодный контровой свет над плечом: ночью в грозе без него от Ксарга остался бы только тлеющий шов
    this.rim = new THREE.PointLight(0x8fa4d8, 0, 14, 2);
    this.rim.position.set(0, 2.6, -2.2);
    this.root.add(this.rim);
  }

  // Насколько тлеют швы: в погоне — злость
  rage(k) { this.model.setRage(k); }

  // Где глаза (в координатах сцены): из них бьёт луч
  eyes(out) {
    const head = this.model.skinned?.byName?.Head?.bone;
    if (!head) return out.copy(this.c);
    // Матрицы — с прошлого кадра, а летит он километры в секунду: берём голову относительно тела
    // и прикладываем к тому, где тело сейчас
    head.getWorldPosition(out).sub(this.root.getWorldPosition(_eye));
    return out.add(this.root.position);
  }

  tick(dt, camPos) {
    this.root.visible = true;
    this.orient(dt);
    this.animate(dt, camPos);
  }
}

export default {
  async start(C) {
    const S = C.scene, P = C.player, W = C.world;
    this.C = C;
    this.t = 0;
    this.seg = null;
    this.burnK = 0;
    this.eyeK = 0;
    // Предметы сцены
    const scn = C.root;
    this.ship = this.ship || new Ship(scn);
    this.pod = this.pod || new Pod(scn);
    this.shipTrail = this.shipTrail || new Trail(scn, new THREE.Color(0.55, 0.7, 1.0), 2.2, 36);
    this.fireTrail = this.fireTrail || new Trail(scn, new THREE.Color(1.0, 0.42, 0.1), 1.1, 40);
    this.xTrail = this.xTrail || new Trail(scn, new THREE.Color(0.55, 0.16, 0.06), 0.7, 60);
    this.beam = this.beam || new Beam(scn);
    this.eyeBeam = this.eyeBeam || new Beam(scn, new THREE.Color(1.0, 0.18, 0.06));
    this.shock = this.shock || new Shock(scn);
    this.eGate = this.eGate || new Portal(scn, { ...EARTH_GATE, hidden: false });
    this.eGate.open = 0;
    this.lantern = this.lantern || this.makeLantern(scn);
    const xGate = W.wormhole?.xGate;
    this.xGate = xGate;
    // Камера пролога побывает у Ксаррона: это не «свой полёт» героя, путь через дыру в Симуляторе не открывается
    if (this.flownWas === undefined) this.flownWas = W.wormhole?.flown;
    // Музыка и модель Ксарга — заранее; пока грузятся, экран чёрный
    C.score.prepare(CUES);
    const shim = await C.kinShim();
    this.xarg = this.xarg || new Puppet(shim);
    if (C.chapter?.run !== this) return;
    P.root.visible = false;
    P.vel.set(0, 0, 0);
    this.hold = (dt) => { P.vel.set(0, 0, 0); P.grounded = false; P.falling = false; };
    P.driven = this.hold;

    const ok = await S.play(async (S) => {
      S.el.fade.style.transition = 'none';
      S.el.fade.classList.add('on');
      // Музыку не ждём дольше пары секунд: голос Совета идёт над чёрным экраном, гул догонит его
      // (catchUp в partXarron); остальные реплики дособираются, пока звучат первые
      await Promise.race([C.score.prepare(CUES.slice(0, 1)), S.wait(2.5)]);
      await this.partXarron(S);
      await this.partEarth(S);
      await this.partShore(S);
      // Название, затем — через двадцать лет
      await S.fade(true, 2.2);
      C.score.play('title', { fade: 2 });
      await S.wait(0.6);
      await S.card('', 'The Last Son of Hope', 7.5);
      await S.wait(1.2);
      await S.card('ДВАДЦАТЬ ЛЕТ СПУСТЯ', 'Райский остров', 3.4);
    });
    this.finish(ok);
  },

  // ---------------------------------------------------------------- A. Ксаррон
  async partXarron(S) {
    const C = this.C, P = C.player, X = XARRON, G = XARRON_GATE;
    // Ночная сторона: Вэлкар за планетой, у края — его кайма
    const sun = _a.copy(XARRON_ORIGIN).sub(X.c).normalize().clone();
    const side = _b.crossVectors(sun, UP).normalize().clone();
    // Планета не на весь кадр: смотрим чуть мимо центра, чтобы у края было небо и кайма звезды
    const camA = X.c.clone().addScaledVector(sun, -X.r * 4.6).addScaledVector(UP, X.r * 1.1).addScaledVector(side, X.r * 0.9);
    const camA2 = X.c.clone().addScaledVector(sun, -X.r * 3.7).addScaledVector(UP, X.r * 0.85).addScaledVector(side, X.r * 0.7);
    const lookA = X.c.clone().addScaledVector(side, -X.r * 0.55).addScaledVector(UP, X.r * 0.25);
    if (this.xGate) { this.xGate.open = 0; this.xGate.k = 0; }
    P.pos.copy(camA);
    S.cut(camA, lookA, 40);
    this.seg = { t0: S.t, fn: () => { P.pos.copy(S.shot.pos); } };

    // A0: чёрный экран, голос Совета над мерными ударами присяги
    C.score.play('pro-council', { fade: 0.05, catchUp: true });
    await S.wait(1.6);
    await S.say('СОВЕТ КСАРРОНА', 'Род Тейв присягнёт на рассвете.', 3.6);
    await S.say('СОВЕТ КСАРРОНА', 'Врата будут служить Ксаррону. И кровь Тейв — тоже.', 4.8);
    await S.wait(1.2);
    // A1: ночная сторона в огнях городов, медленный наезд
    S.move({ pos: camA2, look: lookA, fov: 38 }, 14);
    await S.fade(false, 3);
    await S.card('ДВАДЦАТЬ ЛЕТ НАЗАД', 'Ксаррон', 4.5);
    await S.wait(0.8);

    // Погоня к вратам: корабль в 150 км от них, Ксарг в 4 км за ним и нагоняет. Путь — интегралом:
    // перед вратами сцена сжимает время (rush), чтобы корабль долетел ровно к удару музыки
    const toGate = G.c.clone().sub(X.c).normalize();
    const lat = _c.crossVectors(toGate, UP).normalize().clone();
    const start = G.c.clone().addScaledVector(toGate, -150000).addScaledVector(lat, 6000);
    const dir = G.c.clone().sub(start).normalize();
    const ship = this.ship, xg = this.xarg;
    const ch = { s: 0, gap: 4200, sv: 2800, rush: 1 };
    ship.group.visible = true;
    ship.light.intensity = 800;
    ship.burn(0, 0);
    this.shipTrail.clear(); this.fireTrail.clear(); this.xTrail.clear();
    xg.rage(0.55);
    xg.rim.intensity = 0;
    xg.vel.copy(dir).multiplyScalar(ch.sv);
    xg.place(start.clone().addScaledVector(dir, -ch.gap), dir);
    xg.root.visible = false;
    const shipPos = new THREE.Vector3();
    this.seg = {
      t0: S.t, fn: (t, dt) => {
        ch.s += ch.sv * ch.rush * dt;
        ch.gap = Math.max(380, ch.gap - 230 * ch.rush * dt);
        shipPos.copy(start).addScaledVector(dir, ch.s);
        ship.place(shipPos, dir, Math.sin(t * 0.7) * 0.12);
        ship.burn(this.burnK, t);
        this.shipTrail.push(ship.tail, 30);
        if (this.burnK > 0) this.fireTrail.push(ship.wound, 20);
        // Ксарг идёт не в самом следе корабля, а чуть сбоку и выше: камера рядом с ним не должна попадать в след
        _b.copy(start).addScaledVector(dir, ch.s - ch.gap).addScaledVector(lat, -140).addScaledVector(UP, 45);
        xg.pos.copy(_b);
        xg.c.copy(_b).addScaledVector(UP, 1.0);
        xg.vel.copy(dir).multiplyScalar(ch.sv);
        if (xg.root.visible) this.xTrail.push(xg.c, 8);
        // Луч из глаз — в пробоину на крыле
        this.eyeBeam.set(xg.eyes(_eyePt), ship.wound, 0.7, this.eyeK, dt);
        P.pos.copy(S.shot.pos);
      },
    };
    // Кадры погони — от тех, кто в ней, каждый кадр заново
    const camFly = (p) => () => { S.shot.pos.copy(p); S.shot.look.copy(ship.group.position); S.shot.fov = 44; };
    const camCockpit = () => this.cockpitShot(S);
    const camXarg = () => {
      S.shot.pos.copy(xg.c).addScaledVector(dir, 5.5).addScaledVector(lat, -3.4).addScaledVector(UP, 1.0);
      S.shot.look.copy(xg.c).addScaledVector(UP, 0.4);
      S.shot.fov = 40;
    };
    const camBehind = () => {
      S.shot.pos.copy(ship.group.position).addScaledVector(dir, -55).addScaledVector(UP, 14).addScaledVector(lat, 10);
      S.shot.look.copy(ship.group.position).addScaledVector(dir, 200);
      S.shot.fov = 50;
    };
    // Выстрел: из-за плеча Ксарга, корабль впереди — луч уходит от его глаз к крылу
    const camShot = () => {
      _a.subVectors(ship.group.position, xg.c).normalize();
      S.shot.pos.copy(xg.c).addScaledVector(_a, -5).addScaledVector(lat, -1.8).addScaledVector(UP, 1.1);
      S.shot.look.copy(ship.group.position);
      S.shot.fov = 34;
    };
    // Попадание: крыло крупно, на нём занимается огонь
    const camWing = () => {
      S.shot.pos.copy(ship.at(_a.set(26, 11, 8)));
      S.shot.look.copy(ship.wound);
      S.shot.fov = 40;
    };

    // A2: корабль идёт на нас и проносится мимо; позади — ночная сторона в огнях
    C.score.play('pro-chase', { fade: 1.5 });
    this.seg.fn(0, 0);
    this.seg.cam = camFly(shipPos.clone().addScaledVector(dir, ch.sv * 2.4).addScaledVector(lat, 70).addScaledVector(UP, 18));
    S.line('ВЕРФИ КСАРРОНА', 'Несанкционированный старт. Корабль рода Тейв идёт к вратам.', 4.4);
    await S.wait(3.6);
    // A2б: кабина, в тёплом свете — силуэт с ребёнком на руках
    this.seg.cam = camCockpit;
    await S.say('ИЛЕНА', 'Тише, тише. Смотри — звёзды.', 3.4);
    // A3: Ксарг, крупно, сбоку и чуть впереди; плащ рвётся назад, швы брони тлеют
    xg.root.visible = true;
    this.seg.cam = camXarg;
    await S.say('КСАРГ', 'Верфи, врата не открывать. Я её догоню.', 3.6);
    await S.say('ВЕРФИ КСАРРОНА', 'Капитан, врата откроются на её кровь. Не на наш приказ.', 4.4);
    await S.say('КСАРГ', 'Илена. Остановись. Совет простит тебя, если ты отдашь его.', 4.6);
    // A4: за кормой, впереди — далёкие врата
    this.seg.cam = camBehind;
    await S.say('ИЛЕНА', 'У него есть имя, Ксарг. Ты держал его на руках.', 4.2);
    this.seg.cam = camXarg;
    await S.say('КСАРГ', 'Мне приказали его стеречь.', 2.8);
    this.seg.cam = camCockpit;
    await S.say('ИЛЕНА', 'Совет никогда не просил прощения. И ты не будешь.', 4);
    this.seg.cam = camXarg;
    await S.say('КСАРГ', 'Последний раз, Илена. Поверни.', 3);
    // A5: выстрел — луч задевает крыло, там занимается огонь
    this.seg.cam = camShot;
    await S.wait(0.7);
    this.eyeK = 1;
    await S.wait(0.8);
    this.burnK = 1;
    ship.light.intensity = 1400;
    this.seg.cam = camWing;
    await S.wait(0.4);
    this.eyeK = 0;
    ship.light.intensity = 800;
    await S.wait(1.3);
    this.seg.cam = camCockpit;
    await S.wait(1.4);
    // A6: врата раскрываются на её кровь
    if (this.xGate) this.xGate.open = 1;
    const wide = G.c.clone().addScaledVector(lat, G.r * 2.2).addScaledVector(dir, -G.r * 1.6).addScaledVector(UP, G.r * 0.4);
    this.seg.cam = () => { S.shot.pos.copy(wide); S.shot.look.copy(G.c).addScaledVector(dir, -G.r * 0.8); S.shot.fov = 52; };
    await S.say('ВЕРФИ КСАРРОНА', 'Врата открываются! Это её кровь, мы их не удержим!', 3.4);
    this.seg.cam = camXarg;
    await S.say('КСАРГ', 'Тогда я пройду с ней.', 2.4);
    // Последний отрезок до врат — ровно за GATE_HIT секунд, под удар музыки
    this.seg.cam = () => { S.shot.pos.copy(wide); S.shot.look.copy(G.c).addScaledVector(dir, -G.r * 0.8); S.shot.fov = 52; };
    C.score.play('pro-gate', { fade: 0.4 });
    const rem = Math.max(0, G.c.distanceTo(start) - ch.s);
    ch.rush = rem / (ch.sv * GATE_HIT);
    await S.wait(GATE_HIT - 0.4);
    if (this.xGate) this.xGate.flare = 1;
    await S.wait(0.4);
    // Вспышка — в белое
    this.flash();
    ship.group.visible = false;
    xg.root.visible = false;
    this.eyeBeam.set(_a, _b, 1, 0, 0);
    this.shipTrail.clear(); this.fireTrail.clear(); this.xTrail.clear();
    await S.wait(1.2);
  },

  // ---------------------------------------------------------------- B. Земля
  async partEarth(S) {
    const C = this.C, P = C.player, env = C.env, G = EARTH_GATE, ship = this.ship, xg = this.xarg;
    // Ночь и гроза
    this.storm(true);
    const lh = C.lighthouse;
    lh.show(true);
    // Куда упадёт капсула: прибой к западу от маяка
    const shore = this.shorePoint(lh.base);
    this.shore = shore;
    const gate = this.eGate;
    gate.open = 0; gate.k = 0;
    // B1: низко над морем, на врата
    const cam1 = V(G.c.x - 700, 22, G.c.z + 260);
    P.pos.copy(cam1);
    S.cut(cam1, V(G.c.x, G.c.y * 0.7, G.c.z), 55);
    this.seg = { t0: S.t, fn: () => { P.pos.copy(S.shot.pos); } };
    await S.wait(0.4);
    C.score.play('pro-storm', { fade: 0.8 });
    env.lightning = 1;
    gate.open = 1;
    await S.wait(1.6);
    gate.flare = 1;
    // Корабль вываливается из врат к острову, раненый; Ксарг — через миг
    const out = G.n.clone();
    const p0 = G.c.clone();
    // Корабль идёт вдоль берега над морем, в полукилометре от прибоя
    const west = V(-0.97, 0, -0.25).normalize(), coast = V(0.25, 0, -0.97);
    const aim = shore.clone().addScaledVector(west, 500).addScaledVector(coast, 3000).setY(55);
    const t0 = S.t;
    ship.group.visible = true;
    ship.light.intensity = 900;
    this.burnK = 1;
    xg.root.visible = false;
    xg.rage(0.8);
    xg.rim.intensity = 40;
    this.shipTrail.clear(); this.fireTrail.clear(); this.xTrail.clear();
    const shipPos = new THREE.Vector3().copy(p0);
    const shipVel = out.clone().multiplyScalar(420).addScaledVector(UP, -60);
    xg.pos.copy(p0);
    xg.vel.copy(out).multiplyScalar(300);
    let xOut = false, turn = false, climb = false;
    const pod = this.pod;
    this.seg = {
      t0, fn: (t, dt) => {
        // Корабль: тянется к острову, выравнивается низко над водой; потом разворот на врата и подъём.
        // У врат он зависает в километре от кольца — пока Илена говорит, он не должен в них влететь
        const goal = turn ? (climb ? this.climbAim : G.c) : aim;
        _a.subVectors(goal, shipPos);
        const dist = _a.length();
        _a.normalize();
        const sp = climb ? 700 : turn ? Math.min(380, Math.max(40, (dist - 900) * 0.4)) : 330;
        shipVel.lerp(_a.multiplyScalar(sp), 1 - Math.exp(-(turn ? 1.8 : 1.1) * dt));
        shipPos.addScaledVector(shipVel, dt);
        if (!climb) shipPos.y = Math.max(shipPos.y, 40);
        // Нос держим на цель, даже когда корабль почти стоит
        ship.place(shipPos, turn && !climb ? _b.subVectors(G.c, shipPos) : shipVel, Math.sin(t * 2.1) * 0.25);
        ship.burn(this.burnK, t);
        this.shipTrail.push(ship.tail, 6);
        this.fireTrail.push(ship.wound, 4);
        // Ксарг — из врат через 1,4 с; держится за кораблём, но ниже и медленнее
        if (t > 1.4 && !xOut) { xOut = true; xg.root.visible = true; }
        if (xOut) {
          // За кормой, по курсу носа (у врат корабль почти стоит — по скорости сторону не понять);
          // у врат — ближе, в свете корабля
          _b.copy(shipPos).addScaledVector(_c.set(0, 0, 1).applyQuaternion(ship.group.quaternion), turn ? -70 : -160).addScaledVector(UP, turn ? -6 : -20);
          if (this.xLook) _b.copy(this.xLook);
          _c.subVectors(_b, xg.pos);
          xg.vel.lerp(_c.multiplyScalar(1.2).clampLength(0, this.xLook ? 60 : 520), 1 - Math.exp(-2 * dt));
          xg.pos.addScaledVector(xg.vel, dt);
          xg.c.copy(xg.pos).addScaledVector(UP, 1.0);
          this.xTrail.push(xg.c, 3);
        }
        // Капсула: по своей дуге в прибой
        if (this.podFly) {
          const f = this.podFly;
          f.t += dt;
          const k = Math.min(1, f.t / f.dur);
          pod.group.position.lerpVectors(f.a, f.b, k);
          pod.group.position.y += Math.sin(k * Math.PI) * f.arc;
          pod.group.rotation.x += dt * 3;
          if (k >= 1) { this.podFly = null; this.podK = 1; pod.group.position.copy(f.b); pod.group.rotation.set(0.1, 0.6, 0.05); C.world.effects?.splash?.(f.b, 1); }
        }
        if (this.camFn) this.camFn(t, dt);
        P.pos.copy(S.shot.pos);
      },
    };
    // Сбоку от корабля по ходу: side — в сторону моря
    const sideOf = (out) => {
      _a.copy(shipVel).setY(0).normalize();
      out.crossVectors(_a, UP).normalize();
      if (out.dot(west) < 0) out.negate();
      return out;
    };
    // B1 продолжение: держим врата, корабль и Ксарг вываливаются из них
    this.camFn = () => { S.shot.look.lerp(shipPos, 0.08); };
    await S.wait(2.8);
    // B2: три четверти спереди, со стороны моря: виден весь корабль и огонь на крыле, за ним — остров и маяк
    this.camFn = () => {
      sideOf(_b);
      S.shot.pos.copy(shipPos).addScaledVector(_a, 30).addScaledVector(_b, 34).setY(shipPos.y + 5);
      S.shot.look.copy(shipPos).addScaledVector(_a, -4);
      S.shot.fov = 42;
    };
    await S.say('ИЛЕНА', 'Земля. Здесь тебя никто не знает.', 3.4);
    // B3: кабина вплотную; гроза отступает, Илена напевает сыну
    this.camFn = () => this.cockpitShot(S);
    C.score.play('pro-lullaby', { fade: 2.5 });
    await S.wait(5);
    await S.say('ИЛЕНА', 'Арэн. Живи так, чтобы тебя не нашли.', 4);
    await S.say('ИЛЕНА', 'А если найдут — живи всё равно.', 3.6);
    // B4: капсула уходит дугой в прибой, камера провожает её
    pod.group.visible = true;
    pod.group.position.copy(shipPos).addScaledVector(UP, -3);
    // Корабль к этому времени ушёл вдоль берега: капсула летит дугой, по дальности — от 2,4 до 4,5 с
    const podDist = shipPos.distanceTo(shore);
    const podDur = Math.min(4.5, Math.max(2.4, podDist / 350));
    this.podFly = { a: shipPos.clone().addScaledVector(UP, -3), b: shore.clone(), arc: Math.min(120, 30 + podDist * 0.05), dur: podDur, t: 0 };
    this.podT = 0;
    // В полёте свет капсулы приглушён: камера рядом, иначе ореол закроет кадр
    this.podK = 0.3;
    const podCam = sideOf(new THREE.Vector3()).multiplyScalar(9).addScaledVector(UP, 3);
    S.cut(pod.group.position.clone().add(podCam), pod.group.position, 44);
    this.camFn = (t, dt) => {
      // Камера летит вместе с капсулой: она слишком быстрая, чтобы догонять её плавно
      S.shot.pos.copy(pod.group.position).add(podCam);
      S.shot.look.copy(pod.group.position);
      S.shot.fov = 44;
    };
    await S.wait(podDur + 0.9);
    // B5: корабль разворачивается к вратам; Ксарг крупно — она говорит с ним по связи
    turn = true;
    this.xLook = null;
    C.score.play('pro-storm', { fade: 1.6, offset: 14 });
    // Ксарг в профиль, за ним — корабль у раскрытых врат: он выбирает, лететь ли домой
    this.camFn = () => {
      _a.subVectors(shipPos, xg.c).setY(0).normalize();
      _b.crossVectors(_a, UP).normalize();
      S.shot.pos.copy(xg.c).addScaledVector(_b, 5).addScaledVector(_a, -2.5).addScaledVector(UP, 0.5);
      S.shot.look.copy(xg.c).addScaledVector(_a, 3);
      S.shot.fov = 42;
    };
    await S.say('ИЛЕНА', 'Ксарг. Врата открыты. Хочешь домой — лети сейчас.', 4.6);
    await S.wait(1.4);
    env.lightning = 1;
    await S.say('КСАРГ', 'Без него — нет.', 2.4);
    // B6: за кормой; луч во врата под нарастание музыки, удар — на обрушении
    this.camFn = (t, dt) => {
      _a.subVectors(G.c, shipPos).normalize();
      _c.copy(shipPos).addScaledVector(_a, -70).addScaledVector(UP, 16);
      S.shot.pos.lerp(_c, 1 - Math.exp(-5 * dt));
      S.shot.look.lerp(G.c, 1 - Math.exp(-3 * dt));
      S.shot.fov = 50;
      const k = this.beamK || 0;
      this.beam.set(ship.nose, G.c, 1.6 + 2 * k, k, dt);
    };
    C.score.play('pro-gate', { fade: 0.4 });
    await S.wait(1.2);
    this.beamK = 0.4;
    S.line('ИЛЕНА', 'Теперь никто не пройдёт. Ни сюда, ни обратно.', 3.2);
    await S.wait(1);
    this.beamK = 1;
    gate.flare = 1.4;
    await S.wait(GATE_HIT - 2.2);
    // Врата складываются
    this.beamK = 0;
    this.beam.set(ship.nose, G.c, 1, 0, 0);
    gate.open = 0;
    gate.k = 0.02;
    this.shock.fire(G.c, G.r);
    this.flash();
    climb = true;
    this.climbAim = V(G.c.x + 4000, 9000, G.c.z - 6000);
    // Обрушение — общим планом с воды
    this.camFn = null;
    S.cut(V(G.c.x - 900, 26, G.c.z + 420), G.c, 56);
    await S.wait(1.8);
    env.lightning = 1;
    // B7: корабль уводит погоню вверх; Ксарг на миг замирает над морем
    this.xLook = xg.pos.clone().addScaledVector(UP, 30);
    // Из-за плеча Ксарга: корабль уходит вверх, в тучи
    this.camFn = () => {
      _a.subVectors(shipPos, xg.c).normalize();
      _b.crossVectors(_a, UP).normalize();
      S.shot.pos.copy(xg.c).addScaledVector(_a, -7).addScaledVector(_b, 2.2).addScaledVector(UP, 1.2);
      S.shot.look.copy(xg.c).addScaledVector(_a, 60);
      S.shot.fov = 46;
    };
    await S.wait(1.2);
    // Молния высвечивает его на миг — ночью над морем иначе виден только тлеющий шов
    env.lightning = 1;
    await S.say('КСАРГ', 'Ты заперла нас обоих.', 3);
    C.score.play('pro-farewell', { fade: 2.5 });
    await S.wait(0.6);
    // Ксарг оглядывается на море — капсулы он не видит — и уходит за кораблём
    this.camFn = () => {
      _a.subVectors(this.shore, xg.c).setY(0).normalize();
      S.shot.pos.copy(xg.c).addScaledVector(_a, 6).addScaledVector(UP, 0.6);
      S.shot.look.copy(xg.c).addScaledVector(UP, 0.5);
      S.shot.fov = 38;
    };
    this.xTrail.clear();
    xg.faceTarget = true;
    xg.lookAtPoint(this.shore);
    await S.wait(0.5);
    env.lightning = 1;
    await S.say('КСАРГ', 'Где он, Илена?', 2.6);
    xg.faceTarget = false;
    this.xLook = this.climbAim;
    this.camFn = (t, dt) => {
      S.shot.look.lerp(xg.c, 1 - Math.exp(-3 * dt));
    };
    await S.wait(2.6);
  },

  // ---------------------------------------------------------------- C. Берег
  async partShore(S) {
    const C = this.C, P = C.player, pod = this.pod, lh = C.lighthouse, shore = this.shore;
    this.ship.group.visible = false;
    this.xarg.root.visible = false;
    this.shipTrail.clear(); this.fireTrail.clear(); this.xTrail.clear();
    pod.group.visible = true;
    pod.group.position.copy(shore);
    pod.group.rotation.set(0.1, 0.6, 0.05);
    this.podFly = null;
    this.podK = 1;
    // Камера низко у воды, капсула в пене, за ней на мысу маяк
    _a.subVectors(shore, lh.base).setY(0).normalize();
    const toSea = _a.clone();
    const c0 = shore.clone().addScaledVector(toSea, 26).addScaledVector(_b.crossVectors(toSea, UP), 8).setY(shore.y + 2.2);
    const c1 = shore.clone().addScaledVector(toSea, 9).addScaledVector(_b, 3).setY(shore.y + 1.3);
    S.cut(c0, V(shore.x, shore.y + 6, shore.z).lerp(lh.top, 0.25), 42);
    this.camFn = null;
    this.seg = { t0: S.t, fn: (t, dt) => { P.pos.copy(S.shot.pos); this.lanternTick(t, dt); } };
    this.lantern.visible = true;
    // Фонарь спускается с мыса вдоль берега к капсуле
    const along = _c.crossVectors(toSea, UP).normalize().clone();
    this.lanternFrom = lh.base.clone().addScaledVector(toSea, 30).addScaledVector(along, -60);
    this.lanternTo = shore.clone().addScaledVector(toSea, -4).addScaledVector(along, -4);
    this.lanternT = 0;
    this.lanternGo = null;
    this.lanternLow = 0;
    S.move({ pos: c1, look: V(shore.x, shore.y + 0.6, shore.z), fov: 34 }, 14);
    await S.wait(4.5);
    await S.say('ЭЛИАС', 'Эй… Кто тут?', 2.6);
    await S.wait(7.4);
    // C2: Элиас над капсулой, свет фонаря на имени. Смотрим сверху, как он
    const nameAt = V(0, 0.38, 0.512).applyQuaternion(pod.group.quaternion).add(pod.group.position);
    const nameN = V(0, Math.sin(0.66), Math.cos(0.66)).applyQuaternion(pod.group.quaternion);
    this.lanternGo = { from: this.lantern.position.clone(), to: nameAt.clone().addScaledVector(nameN, 1.8).addScaledVector(along, -0.9), t: 0, dur: 1.6 };
    this.lanternLow = 1;
    // Вблизи капсула не слепит: её свет — тлеющий, имя читается в свете фонаря
    this.podK = 0.35;
    S.cut(nameAt.clone().addScaledVector(nameN, 1.9).addScaledVector(UP, 0.5).addScaledVector(along, 0.5), nameAt, 38);
    S.move({ pos: nameAt.clone().addScaledVector(nameN, 1.2).addScaledVector(UP, 0.25).addScaledVector(along, 0.25), look: nameAt, fov: 34 }, 12);
    await S.say('ЭЛИАС', 'Господи. Ты же совсем маленький.', 3.4);
    await S.say('ЭЛИАС', 'А… Р… Н. Остальное стёрто.', 3.4);
    await S.say('ЭЛИАС', 'Адриан, значит.', 2.8);
    await S.wait(0.6);
    // C3: снова издали: фонарь поднимается и уходит к маяку, капсула гаснет — она больше никого не ждёт
    S.cut(c0, V(shore.x, shore.y + 6, shore.z).lerp(lh.top, 0.25), 42);
    this.lanternGo = { from: this.lantern.position.clone(), to: this.lanternFrom.clone(), t: 0, dur: 16 };
    this.lanternLow = 0;
    this.podDim = true;
    await S.say('ЭЛИАС', 'Ну тише. Тише. Пойдём домой.', 3.6);
    await S.wait(3);
  },

  // ---------------------------------------------------------------- помощь
  // Кабина вплотную: сбоку, чуть впереди и выше — в осях самого корабля, чтобы корпус не закрывал стекло
  cockpitShot(S) {
    const ship = this.ship;
    S.shot.pos.copy(ship.at(_d.set(5.6, 2.6, 11.6)));
    S.shot.look.copy(ship.at(_d.set(-0.2, 1.1, 7.0)));
    S.shot.fov = 44;
  },

  makeLantern(scene) {
    const g = new THREE.Group();
    const light = new THREE.PointLight(0xffc27a, 120, 30, 2);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.75, 0.4).multiplyScalar(4), toneMapped: false }));
    g.add(light, bulb);
    g.visible = false;
    scene.add(g);
    return g;
  },

  // Фонарь: кто-то спускается с мыса к воде, фонарь покачивается в такт шагам; у капсулы — опускается к ней
  lanternTick(t, dt) {
    if (!this.lantern.visible || !this.lanternFrom) return;
    this.lanternT += dt;
    const L = this.lantern.position;
    if (this.lanternGo) {
      const g = this.lanternGo;
      g.t += dt;
      L.lerpVectors(g.from, g.to, Math.min(1, g.t / g.dur));
    } else L.lerpVectors(this.lanternFrom, this.lanternTo, Math.min(1, Math.max(0, (this.lanternT - 3) / 11)));
    const gy = Math.max(WORLD.waterLevel ?? 0, islandHeight(L.x, L.z) ?? 0);
    this.lowK = (this.lowK || 0) + (this.lanternLow - (this.lowK || 0)) * (1 - Math.exp(-2.5 * dt));
    // Идёт — фонарь на уровне руки и качается; склонился над капсулой — фонарь у самой земли и почти неподвижен
    const walk = this.lanternGo && this.lanternLow ? 0.15 : 1;
    L.y = gy + 1.0 - this.lowK * 0.45 + Math.abs(Math.sin(this.lanternT * 3.4)) * 0.08 * walk;
    // Склонился — фонарь у самой капсулы, свет прикрыт ладонью
    this.lantern.children[0].intensity = 120 * Math.min(1, this.lanternT / 2) * (1 - 0.85 * this.lowK);
  },

  // Точка прибоя к западу от маяка: первая точка, где остров уже у самой воды
  shorePoint(base) {
    const dir = _a.set(-0.97, 0, -0.25).normalize().clone();
    let last = base.clone();
    for (let d = 10; d < 600; d += 4) {
      _b.copy(base).addScaledVector(dir, d);
      const h = islandHeight(_b.x, _b.z);
      if (h === null || h < 0.4) return V(_b.x, Math.max(0.3, (WORLD.waterLevel ?? 0) + 0.3), _b.z);
      last = _b.clone();
    }
    return last;
  },

  storm(on) {
    const env = this.C.env;
    if (on) {
      this.envWas = this.envWas || { hour: env.hour, weather: env.weatherIndex, tropic: env.tropic, timeScale: env.timeScale };
      env.hour = 0.6;
      env.tropic = false;
      env.weatherIndex = 3;
      env.timeScale = 0;
    }
    env.envDirty = true;
    env.applyAtmosphere();
  },

  // Белая вспышка на весь экран и медленный уход
  flash() {
    const f = document.getElementById('photo-flash');
    if (!f) return;
    f.classList.add('on');
    setTimeout(() => f.classList.remove('on'), 90);
  },

  update(C, dt, realDt) {
    const S = C.scene;
    if (this.seg && S.on) {
      this.seg.fn(S.t - this.seg.t0, realDt);
      this.seg.cam?.(S.t - this.seg.t0);
    }
    const cam = C.camera.position;
    if (this.xarg?.root.visible) this.xarg.tick(realDt, cam);
    this.shipTrail?.update(cam);
    this.fireTrail?.update(cam);
    this.xTrail?.update(cam);
    this.shock?.update(realDt);
    if (this.eGate) this.eGate.update(realDt, this.eGate.open > 0 || this.eGate.k > 0.02, C.env.sunDir);
    if (this.pod?.group.visible) {
      this.podT = (this.podT || 0) + realDt;
      if (this.podDim) this.podK = Math.max(0.12, (this.podK ?? 1) - realDt * 0.15);
      this.pod.shine(this.podK ?? 1, this.podT);
    }
  },

  // Пролог кончился (или его пропустили): всё убрать, утро над островом, герой на маяке
  finish(played) {
    const C = this.C;
    if (!C || C.chapter?.run !== this) return;
    this.cleanup();
    C.score.stop(played ? 3 : 0.5);
    C.complete();
  },

  cleanup() {
    const C = this.C, P = C.player, env = C.env;
    this.seg = null;
    this.camFn = null;
    this.podDim = false;
    this.podK = 1;
    this.eyeK = 0;
    this.burnK = 0;
    this.lanternGo = null;
    this.lanternLow = 0;
    this.lowK = 0;
    for (const o of [this.ship?.group, this.pod?.group, this.xarg?.root, this.lantern]) if (o) o.visible = false;
    this.shipTrail?.clear(); this.fireTrail?.clear(); this.xTrail?.clear();
    this.beam?.set(_a, _b, 1, 0, 0);
    this.eyeBeam?.set(_a, _b, 1, 0, 0);
    if (this.eGate) { this.eGate.open = 0; this.eGate.k = 0; this.eGate.group.visible = false; }
    if (this.xGate) this.xGate.open = 1;
    const wh = C.world.wormhole;
    if (wh && this.flownWas !== undefined) { wh.flown = this.flownWas; wh.save(); this.flownWas = undefined; }
    if (this.envWas) {
      env.hour = 6.4;
      env.weatherIndex = 0;
      env.tropic = false;
      env.timeScale = this.envWas.timeScale;
      env.envDirty = true;
      env.applyAtmosphere();
      this.envWas = null;
    }
    document.getElementById('story-fade').classList.remove('on');
    P.root.visible = true;
    if (P.driven === this.hold) P.driven = null;
    // Утро: герой у маяка, на галерее
    C.lighthouse.show(true);
    P.pos.copy(C.lighthouse.top).add(V(0, -1.5, 3.4));
    P.vel.set(0, 0, 0);
    P.grounded = false;
    C.camRig.yaw = Math.atan2(0.97, 0.25);
    C.camRig.pitch = -0.05;
  },

  stop(C) {
    if (this.C) this.cleanup();
    C.score.stop(0.3);
  },
};
