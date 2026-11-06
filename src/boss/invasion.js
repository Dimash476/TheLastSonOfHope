import * as THREE from 'three';
import { KinFactory } from './kinmodel.js';
import { Warship, SHIP } from './warship.js';
import { Soldier, Bolts } from './soldier.js';
import { Xarg, XARG_HP } from './xarg.js';
import { Chain } from './chain.js';
import { Seize } from './seize.js';
import { Finale } from './finale.js';
import { Story } from './story.js';
import { Parley } from './parley.js';
import { BattleTheme } from './theme.js';
import { BattleFX } from './battlefx.js';
import { spaceK } from './kin.js';
import { reelHit } from '../player/model.js';
import { PLAYER as PC } from '../config.js';
import { clamp, lerp } from '../utils.js';

// Режим «Вторжение»: предупреждение → корабль входит в атмосферу → десант и генерал спускаются →
// переговоры → бой с десантом → дуэль с генералом Ксаргом: сначала он тащит героя в центр города,
// дальше бой идёт среди небоскрёбов и в космосе. Корабль можно разгромить и протаранить насквозь.
// Для героя весь этот отряд — один «босс»: класс держит тот же набор методов, что и Колосс (world.boss).

const SITE = new THREE.Vector3(-420, 0, -1180);        // центральный парк, ~1 км от небоскрёбов
const FACE = new THREE.Vector3(420, 0, 1180).normalize();   // строй смотрит на центр города
const ARRIVE = 20;      // с: от края космоса до зависания над парком
const WARN_T = 11;
const SOLDIERS = 10;
const WAVE_GOAL = 6;    // столько солдат надо вывести из боя: дальше генерал отзывает остальных
const HERO_HP = 500;    // в этом режиме герой держит впятеро больше, чем в бою с Колоссом

const UP = new THREE.Vector3(0, 1, 0);
const _p = new THREE.Vector3(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _r = new THREE.Vector3();
const ARENA_R = 620;    // м от центра города: ближе этого бой никуда не тянем

const ALERT = [
  'ПЕРЕХВАТ СВЯЗИ · ОРБИТАЛЬНЫЙ МОНИТОРИНГ',
  'Сигнал неземного происхождения.',
  'Масса объекта — 4,1 млн т. Скорость снижается. Курс — Земля.',
];

export class Invasion {
  constructor(scene, world, player, hud, camera, camRig) {
    this.scene = scene;
    this.world = world;
    this.player = player;
    this.hud = hud;
    this.camera = camera;
    this.camRig = camRig;
    this.active = false;
    this.ended = false;
    this.onEnd = null;
    this.timeScale = 1;
    this.slowT = 0;
    this.fightOn = false;
    this.meleeSlots = 2;
    this.heroC = new THREE.Vector3();
    this.heroDown = false;
    this.heroMax = HERO_HP;
    this.bestChain = 0;
    this.realDt = 1 / 60;
    this.told = new Set();
    this.heroBody = { root: player.root, c: this.heroC };
    this.focus = { pos: new THREE.Vector3(), k: 0, rate: 6, dist: undefined, side: undefined, lift: 0, fov: 0 };
    this.shot = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 55 };
    this.softLock = true;

    this.factory = new KinFactory();
    this.fx = new BattleFX(this);
    this.ship = new Warship(scene, this);
    this.prevHero = new THREE.Vector3();
    this.prevXarg = new THREE.Vector3();
    this.bolts = new Bolts(scene, this);
    this.chain = new Chain(this);
    this.seize = new Seize(this);
    this.finale = new Finale(this);
    this.parley = new Parley(this);
    this.story = new Story(this);
    this.theme = new BattleTheme(world.audio);
    this.soldiers = [];
    this.xarg = null;
    this.pool = false;
    this.factory.whenReady(() => {
      for (let i = 0; i < SOLDIERS; i++) this.soldiers.push(new Soldier(this, i));
      this.xarg = new Xarg(this);
      for (const s of this.soldiers) { s.state = 'gone'; s.root.visible = false; }
      this.xarg.state = 'wait';
      this.pool = true;
      if (this.active) this.warmUp();
    });

    const $ = (id) => document.getElementById(id);
    this.el = {
      ui: $('boss-ui'), title: $('boss-title'), phase: $('boss-phase'), fill: $('boss-fill'), lag: $('boss-lag'),
      hero: $('hero-ui'), heroFill: $('hero-fill'), heroLag: $('hero-lag'), heroTxt: $('hero-value'),
      marker: $('boss-marker'), markerTxt: $('boss-marker-d'), hurt: $('hurt-flash'),
      alert: $('inv-alert'), alertBody: $('inv-alert-body'), sub: $('inv-sub'), hint: $('inv-hint'), hud: $('hud'), bars: $('cine-bars'),
      shipUI: $('ship-ui'), shipFill: $('ship-fill'),
    };
    // Удержание героя, пока идёт сцена: завис там, где был
    this.holdHero = (dt) => {
      const P = this.player;
      if (P.grounded) P.vel.set(0, 0, 0);
      else { P.vel.multiplyScalar(Math.exp(-3 * dt)); P.pos.addScaledVector(P.vel, dt); }
    };
    this.kneelHero = () => {
      const P = this.player;
      P.vel.set(0, 0, 0);
      P.grounded = true;
      P.landT = 0.8;
    };
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Tab' || !this.active || !this.fightOn) return;
      this.softLock = !this.softLock;
      this.banner(this.softLock ? 'ЗАХВАТ ЦЕЛИ: ВКЛ' : 'ЗАХВАТ ЦЕЛИ: ВЫКЛ', 1.2);
    });
  }

  // ---------------------------------------------------------------- запуск и выход
  start() {
    const P = this.player, W = this.world;
    this.active = true;
    this.ended = false;
    this.time = 0;
    this.fightLen = null;
    this.stage = 'warn';
    this.stageT = 0;
    this.fightOn = false;
    this.heroHP = HERO_HP;
    this.heroDown = false;
    this.subQ = [];
    this.punchBuf = 0;
    this.recoverCd = 0;
    this.shipDown = false;
    this.prevHero.copy(P.pos);
    this.lastHurt = -99;
    this.lastHurtAny = -99;
    this.hurtK = 0;
    this.lagBoss = 1;
    this.lagHero = 1;
    this.endT = null;
    this.endWin = false;
    this.endBad = false;
    this.shipLeaveT = null;
    this.bestChain = 0;
    this.downCount = 0;
    this.counterT = 0;
    this.timeScale = 1;
    this.slowT = 0;
    this.duelT = null;
    this.pendingClimb = false;
    this.ramCd = 0;
    this.boltCd = 0;
    this.assistT = 0;
    this.assistKin = null;
    this.prevPunchT = -1;
    this.wasSlam = false;
    this.muteT = 0;
    this.softT = 0;
    this.softKin = null;
    this.scareT = 0;
    this.engageT = 0;
    this.dodgeLock = false;
    this.subT = 0;
    this.hintT = 0;
    this.spaceOn = false;
    this.siteClear = false;
    this.destroyed0 = W.city.destroyed;
    this.focus.k = 0;
    this.shotKind = null;
    this.told.clear();
    this.sideCur = 1.5;
    this.pausedNow = false;
    W.boss = this;
    W.audio?.setHeavy?.(true);
    // В этом бою каждый удар идёт всем телом
    P.punchLen = 0.72;
    P.punchHitAt = 0.2;
    P.knockT = 0;
    P.driven = null;
    P.lockDir = null;
    P.captured = null;
    this.camRig.focus = this.focus;
    this.camRig.shot = null;
    this.chain.reset();
    this.seize.reset();
    this.finale.reset();
    this.story.reset();
    this.bolts.clear();
    this.parley.cancel();
    if (this.pool) this.hideKin();

    // Колонна идёт из ангара позади центра корпуса: ставим корабль так, чтобы она упала в парк
    this.ship.arrive(SITE, ARRIVE);
    const f = _v.set(Math.sin(this.ship.yaw), 0, Math.cos(this.ship.yaw));
    this.ship.target.addScaledVector(f, 120);
    this.ship.groundY = this.ground(SITE.x, SITE.z);

    this.el.alert.classList.remove('hidden');
    this.el.alertBody.textContent = '';
    this.alertT = 0;
    this.el.ui.classList.add('hidden');
    this.el.hero.classList.add('hidden');
    this.el.sub.classList.add('hidden');
    this.el.hint.classList.add('hidden');
    this.el.hud.classList.add('fight');
    this.setCine(false);
    this.theme.prepare();
    this.fx.prepare();
    this.fx.reset();
    this.el.shipUI.classList.add('hidden');
    if (this.pool) this.warmUp();
  }

  stop() {
    const P = this.player;
    this.active = false;
    this.world.boss = null;
    this.theme.stop();
    this.ship.hide();
    this.ship.fireGun(null);
    if (this.pool) this.hideKin();
    this.bolts.clear();
    this.chain.reset();
    this.seize.reset();
    this.finale.reset();
    this.story.stop();
    this.parley.cancel();
    P.punchLen = undefined;
    P.punchHitAt = undefined;
    P.blow = null;
    P.poseQ = null;
    P.knockT = 0;
    this.world.audio?.setHeavy?.(false);
    if (P.captured === this.xarg) P.captured = null;
    P.driven = null;
    P.lockDir = null;
    this.camRig.focus = null;
    this.camRig.shot = null;
    this.timeScale = 1;
    this.setCine(false);
    this.fx.stop();
    for (const k of ['ui', 'hero', 'marker', 'alert', 'sub', 'hint', 'shipUI']) this.el[k].classList.add('hidden');
    this.el.hud.classList.remove('fight');
    this.el.hurt.style.opacity = 0;
  }

  hideKin() {
    for (const s of this.soldiers) { s.hide(); s.state = 'gone'; }
    this.xarg.hide();
    this.xarg.state = 'wait';
    this.xarg.releaseHero();
  }

  // Один раз компилируем шейдеры отряда, чтобы их появление не дало рывка кадра
  warmUp() {
    if (this.warmed || !this.onWarm) return;
    this.warmed = true;
    const list = [...this.soldiers, this.xarg];
    for (const k of list) k.root.visible = true;
    const ship = this.ship.group.visible;
    this.ship.group.visible = true;
    this.onWarm();
    for (const k of list) k.root.visible = false;
    this.ship.group.visible = ship;
  }

  ground(x, z) { return Math.max(0, this.world.city.groundHeightAt(x, z, 400)); }

  // ---------------------------------------------------------------- сообщения на экране
  // Строка под полосой босса: большая надпись hud.toast в бою закрывала бы цель.
  // В бою это только состояние захвата цели: всё остальное говорят герои и радио
  banner(text, t = 2.2) {
    this.el.hint.textContent = text;
    this.el.hint.classList.remove('hidden');
    this.hintT = t;
  }

  // Субтитр держится столько, чтобы его успели прочитать; пока он на экране, следующий ждёт очереди.
  // now — важная реплика (конец боя): сразу, очередь сбрасывается
  say(text, t = 0, now = false) {
    if (this.finale.on && !now) return;
    if (now) this.subQ.length = 0;
    else if (this.subT > 0) {
      if (this.subQ.length >= 2) this.subQ.shift();
      this.subQ.push([text, t]);
      return;
    }
    this.el.sub.textContent = text;
    this.el.sub.classList.remove('hidden');
    this.subT = Math.max(t, 1.6 + text.length * 0.058);
  }

  sayOnce(text, t = 0) {
    if (this.told.has(text)) return;
    this.told.add(text);
    this.say(text, t);
  }

  setCine(on) {
    this.el.hud.classList.toggle('cine', on);
    this.el.bars.classList.toggle('on', on);
  }

  slowFor(scale, t) {
    this.timeScale = scale;
    this.slowT = t;
  }

  get heroAlive() { return !this.heroDown; }

  // Пауза и панель итога: ничего длинного не звучит (гул корабля, луч, петли боя)
  setPaused(p) {
    this.theme.setPaused(p);
    if (p === this.pausedNow) return;
    this.pausedNow = p;
    if (p && this.active) {
      this.ship.setHum(0);
      this.fx.muteLoops();
    }
  }

  heroToXarg() { return _v2.subVectors(this.xarg.c, this.heroC).normalize(); }

  // ---------------------------------------------------------------- этапы
  setStage(name) {
    this.stage = name;
    this.stageT = 0;
  }

  // Строй в парке: 2 ряда по 5, генерал впереди
  slots() {
    const right = _r.crossVectors(FACE, UP).normalize();
    const out = [];
    for (let i = 0; i < SOLDIERS; i++) {
      const row = i < 5 ? 0 : 1, col = i % 5 - 2;
      const p = SITE.clone().addScaledVector(right, col * 4.2).addScaledVector(FACE, -5 - row * 4.2);
      p.y = this.ground(p.x, p.z);
      out.push(p);
    }
    return out;
  }

  xargSlot() {
    const p = SITE.clone().addScaledVector(FACE, 7);
    p.y = this.ground(p.x, p.z);
    return p;
  }

  beginLanding() {
    this.setStage('landing');
    this.ship.hoverNow();
    this.ship.setBeam(true);
    this.clearSite();
    const from = this.ship.bellyPos(new THREE.Vector3());
    this.slots().forEach((p, i) => this.soldiers[i].drop(from, p, FACE, 0.3 + i * 0.45));
    this.xarg.spawnAt(this.xargSlot(), FACE);
    this.xargDrop = false;
    this.world.audio?.boom(0.5);
  }

  // Колонна бьёт в землю: деревья и всё лёгкое разлетается, под строем поляна
  clearSite() {
    const W = this.world;
    if (this.siteClear) return;
    this.siteClear = true;
    const c = SITE.clone().setY(this.ground(SITE.x, SITE.z));
    W.trees?.near(c.x, c.z, 96, (t) => {
      _v.set(t.x - c.x, 0, t.z - c.z).normalize();
      W.trees.breakTree(t, _v.clone(), 26);
    });
    // Кусты волна не валит: без них отряд не стоит по колено в зелени
    for (const it of W.nature?.items || []) {
      if (!it.alive || (it.type !== 'bush' && it.type !== 'flowerbed' && it.type !== 'hedge')) continue;
      if (Math.hypot(it.x - c.x, it.z - c.z) > 96) continue;
      it.alive = false;
      W.nature.write(it);
    }
    W.impact?.(c, 110, 34);
    W.effects.shockwave(c.clone().setY(c.y + 0.6), { type: 'ring', radius: 110, life: 1.1, opacity: 0.8 });
    W.dust.burst(c.clone().setY(c.y + 1), 46, { size: [6, 16], speed: 44, life: [1.6, 3.4], flat: true });
    W.audio?.boom(0.7, c);
  }

  // Пропуск сцены: корабль уже висит, все на местах
  skipScene() {
    this.clearSite();
    this.ship.hoverNow();
    this.ship.setBeam(false);
    this.slots().forEach((p, i) => { this.soldiers[i].stand(p, FACE); });
    const X = this.xarg;
    if (X.state !== 'stand') X.spawnAt(this.xargSlot(), FACE);
    X.root.visible = true;
    X.go('stand');
    X.grounded = true;
  }

  beginMeet() {
    const P = this.player;
    this.setStage('meet');
    this.setCine(false);
    this.camRig.shot = null;
    this.focus.k = 0;
    if (P.driven === this.holdHero) P.driven = null;
    this.ship.setBeam(false);
    const X = this.xarg;
    if (X.state === 'descend') { X.pos.copy(X.slot); X.grounded = true; X.vel.set(0, 0, 0); X.go('stand'); }
    this.say('Сын Ксаррона. Спустись. Поговорим.', 5);
    this.story.radio('ШТАБ: Генерал стоит в парке. Один. Он ждёт тебя.');
  }

  onParleyEnd(result) {
    const X = this.xarg, P = this.player, W = this.world;
    if (result === 'kneel') { this.beginBadEnd(); return; }
    if (result === 'strike') {
      // Удар первым: генерал не ждал, это честный урон
      const dir = _v.subVectors(X.c, this.heroC).normalize().clone();
      P.startPunch(1);
      P.punchHit = true;
      X.hp -= 70;
      X.hitFX(X.c.clone(), dir, 1);
      W.effects.shockwave(X.c.clone(), { type: 'disc', dir, radius: 18, life: 0.5, opacity: 0.9 });
      W.effects.impactFX(1, X.c.clone(), 0.3, 12);
      this.fx.play('chain0') || W.audio?.punch(1, 'concrete', X.c.clone());
      this.fx.play('bigBoom', { gain: 0.5 });
      this.startFight('Ударил первым. Значит, чему-то они тебя научили. Десант, взять его.');
      return;
    }
    this.startFight();
  }

  // Хватит разговоров: бой начался (отказ в переговорах или игрок ударил раньше)
  onFirstBlood() {
    if (this.fightOn || !this.pool) return;
    this.startFight('Ты бьёшь первым. Как они. Десант, взять его.');
  }

  startFight(line) {
    if (this.fightOn || !this.pool) return;
    const P = this.player, X = this.xarg;
    this.parley.cancel();
    if (this.stage !== 'meet' && this.stage !== 'parley') this.skipScene();
    this.fightOn = true;
    this.setStage('wave');
    this.setCine(false);
    this.camRig.shot = null;
    if (P.driven === this.holdHero) P.driven = null;
    P.lockDir = null;
    X.watchAt = SITE.clone().addScaledVector(FACE, -18).addScaledVector(UP, 70);
    X.go('watch');
    X.grounded = false;
    this.el.alert.classList.add('hidden');
    this.ship.setBeam(false);
    if (line) this.say(line, 4.5);
    this.engageT = 0;
    this.engaged = 0;
    this.meleeSlots = 2;
    this.engageNext(4);
    this.theme.start('wave');
    this.el.ui.classList.remove('hidden');
    this.el.hero.classList.remove('hidden');
    this.el.title.textContent = 'ДЕСАНТ КСАРРОНА';
    this.el.phase.textContent = '';
    this.lagBoss = 1;
  }

  engageNext(n) {
    for (const s of this.soldiers) {
      if (n <= 0) break;
      if (s.state === 'form') { s.engage(); n--; }
    }
  }

  onSoldierDown() {
    this.downCount++;
    this.engageNext(1);
    if (this.stage === 'wave') {
      const left = Math.max(0, WAVE_GOAL - this.downCount);
      if (left === 0 && this.duelT === null) this.duelT = 1.2;
    }
  }

  beginDuel() {
    const X = this.xarg;
    this.chain.end();
    this.setStage('duel');
    this.duelT = null;
    for (const s of this.soldiers) s.retreat();
    this.bolts.clear();
    this.el.title.textContent = 'ГЕНЕРАЛ КСАРГ';
    this.lagBoss = X.hp / XARG_HP;
    this.say('Хватит. Он мой.', 3);
    this.theme.setSection('duel');
    X.go('neutral');
    // Первым делом он тащит героя в город: дальше бой идёт среди домов, а не над парком
    if (!X.startTackle()) X.startDive();
    X.cd.taunt = 8;
  }

  onXargHurt() { /* полоса здоровья обновляется в updateBars */ }

  onXargPhase(ph) {
    if (ph === 2) {
      this.pendingClimb = true;
      this.say('Здесь тебе есть что беречь. Поднимись туда, где нечего.', 3.5);
    } else {
      this.say('Довольно. Я сожгу твою Землю, а ты будешь смотреть.', 3.5);
    }
  }

  // Генерал убит. Сцена сама скажет, когда показать итог
  onXargDown(dir) {
    if (this.endT !== null) return;
    this.finishIn(true, 999);
    this.fightLen = this.time;
    this.finale.begin(dir);
    for (const s of this.soldiers) s.retreat();
  }

  // Корабль уничтожен: это не обязательно для победы, но такое он запомнит
  onShipDown() {
    this.shipDown = true;
    this.shipLeaveT = null;
    this.slowFor(0.4, 1.3);
    this.fx.cineFor(5);
    this.fx.crashZoom(8, 0.5);
    if (this.stage === 'duel' && this.xarg.alive) this.say('Четыре тысячи моих солдат. Ты заплатишь за каждого.', 4, true);
    this.theme.stinger();
    this.theme.duck(1);
  }

  onShipHit() {
    if (!this.fightOn) this.onFirstBlood();
    this.el.shipUI.classList.remove('hidden');
    if (this.stage === 'duel' && this.pool) this.xarg.defendShip();
  }

  // Бой тянется к центру города: сильные удары отбрасывают туда, где есть что ломать
  arenaDir(dir, k = 0.8) {
    const p = this.heroC, r = Math.hypot(p.x, p.z);
    if (r < ARENA_R || p.y > 2000 || spaceK(p.y) > 0) return dir;
    _r.set(-p.x, 0, -p.z).normalize();
    return dir.addScaledVector(_r, clamp((r - ARENA_R) / 800, 0, 1) * k).normalize();
  }

  // Герой на скорости прошёл сквозь здание
  onRam(point, dir, speed) {
    if (this.fightOn) this.fx.pierce(point.clone(), dir, speed);
  }

  // Плохая концовка: герой присягает, корабль начинает с этого города
  beginBadEnd() {
    const P = this.player;
    this.setStage('badend');
    this.fightOn = false;
    this.setCine(true);
    P.driven = this.kneelHero;
    P.lockDir = _v.subVectors(this.xarg.pos, P.pos).setY(0).normalize().clone();
    this.gunT = 0;
    this.theme.start('space');
    this.camRig.shot = this.shot;
    this.finishIn(false, 11);
    this.endBad = true;
  }

  finishIn(win, t) {
    if (this.endT !== null) return;
    this.endT = t;
    this.endWin = win;
  }

  finish() {
    this.ended = true;
    this.ship.setHum(0);
    this.fx.muteLoops();
    this.world.audio?.setLaser(0, 0);
    const len = this.fightLen ?? this.time, m = Math.floor(len / 60), s = Math.floor(len % 60);
    const lost = this.world.city.destroyed - this.destroyed0;
    const stats = `Бой длился ${m}:${String(s).padStart(2, '0')} · разрушено зданий: ${lost}`;
    const after = this.shipDown
      ? 'Корабль лежит в руинах центрального парка. Десанту больше некуда возвращаться.'
      : 'Корабль ушёл на орбиту. Они знают, где ты живёшь, и они вернутся.';
    if (this.endBad) this.onEnd?.(false, 'НАМЕСТНИК', 'Земля стала колонией Ксаррона. Города больше нет, зато ты теперь здесь главный.');
    else if (this.endWin) this.onEnd?.(true, 'ЗЕМЛЯ ВЫСТОЯЛА', `Ксарг мёртв. ${after} ${stats}`);
    else this.onEnd?.(false, 'ГЕРОЙ ПОВЕРЖЕН', `Ксарг оказался сильнее, и город остался без защиты. ${stats}`);
  }

  // ---------------------------------------------------------------- урон герою
  // knock — вектор скорости отброса (или null), cont — непрерывный урон (луч)
  hurtHero(amount, knock, cont = false, minGap = 0.12) {
    if (!this.active || this.ended || this.heroDown || !this.fightOn || this.finale.on) return;
    const P = this.player, W = this.world;
    if (P.driven === this.chain.driven || P.driven === this.seize.driven) return;   // в рывке серии и в захвате его не поймать
    if (!cont && this.time - this.lastHurt < minGap) return;
    this.heroHP = Math.max(0, this.heroHP - amount);
    this.lastHurtAny = this.time;
    this.hurtK = Math.min(1, this.hurtK + (cont ? amount * 0.04 : 0.55));
    if (!cont) {
      this.lastHurt = this.time;
      reelHit(P.reel, clamp(amount / 14, 0.4, 1), -1);
      W.effects.impactFX(0.6, null, 0.08, 6);
    }
    // Пока идёт серия, героя можно задеть, но не сбить с неё
    if (knock && !this.chain.active) {
      const sp = knock.length();
      if (sp > 100) this.arenaDir(knock);
      P.vel.copy(knock);
      // Сильный удар уносит далеко: выйти из полёта можно рывком
      P.knockT = clamp(sp / 420, 0.5, 1.1);
      P.grounded = false;
      P.falling = false;
      P.slamming = false;
      P.dashT = 0;
      P.charge = 0;
      P.punchT = -1;
      P.lockDir = null;
      this.assistT = 0;
    }
    if (this.heroHP <= 0) {
      this.heroDown = true;
      this.xarg.releaseHero();
      this.xarg.chainEnd();
      this.xarg.lasering = false;
      this.xarg.go('recover');
      this.xarg.recoverT = 99;
      this.chain.end();
      P.knockT = 3;
      if (!knock) P.vel.set(0, -20, 0);
      this.finishIn(false, 3.2);
      this.say('Сын Ксаррона умер на чужой земле. Как и его мать.', 3, true);
      this.theme.finish(false);
    }
  }

  meleeHit(kin, dmg, knockSpeed) {
    const P = this.player;
    if (P.dashT > 0) { this.onDodge(kin); return; }
    this.hurtHero(dmg, _v.copy(kin.aim).setY(Math.max(kin.aim.y, 0.15)).normalize().multiplyScalar(knockSpeed).clone());
    this.fx.thud(0.7);
  }

  boltHit(b, hero) {
    if (hero.dashT > 0) return;
    this.hurtHero(b.dmg, null, false, 0.05);
    this.fx.thud(0.3);
  }

  // Рывок в момент удара: короткое замедление и окно для контратаки
  onDodge(kin) {
    const W = this.world;
    if (this.dodgeLock) return;
    this.dodgeLock = true;
    this.counterT = 0.9;
    this.slowFor(0.25, 0.32);
    W.effects.fovKick = Math.max(W.effects.fovKick || 0, 4);
    if (kin.kind === 'general') {
      kin.chainEnd();
      kin.go('recover');
      kin.recoverT = 0.7;
      kin.vel.multiplyScalar(0.2);
    }
  }

  // Кулак в кулак: оба отлетают, генерал дольше собирается.
  // big — лобовое столкновение на полном ходу: обоих разносит гораздо дальше
  clash(kin, big = false) {
    const P = this.player;
    const dir = _v.subVectors(this.heroC, kin.c);
    if (dir.lengthSq() < 0.01) dir.copy(kin.aim).negate();
    dir.normalize();
    const point = _p.lerpVectors(this.heroC, kin.c, 0.5).clone();
    const sp = lerp(70, 200, spaceK(point.y)) * (big ? 3.2 : 1);
    P.vel.copy(dir).multiplyScalar(sp);
    P.knockT = big ? 0.55 : 0.22;
    P.grounded = false;
    P.falling = false;
    P.punchT = -1;
    kin.chainEnd();
    kin.launch(dir.clone().negate(), sp * 1.2, 0.55);
    kin.go('knock');
    if (kin.kind === 'general') kin.cd.answer = 1.5;
    this.counterT = 1;
    this.fx.clash(point, dir);
    if (big) {
      this.fx.play('collide', { pos: point });
      this.fx.crashZoom(13, 0.3);
    }
    this.slowFor(big ? 0.2 : 0.3, big ? 0.5 : 0.3);
  }

  // Генерал вырывается, если герой держит его слишком долго
  xargBreaksHold(x) {
    const P = this.player;
    P.held = null;
    x.go('recover');
    x.recoverT = 0.3;
    this.hurtHero(8, _v.copy(x.aim).setY(0.3).normalize().multiplyScalar(90).clone());
    x.bigHitFX(this.heroC.clone(), x.aim, 0.5);
  }

  // ---------------------------------------------------------------- цель для героя (как у Колосса)
  // Кто сейчас может получить удар
  isTarget(k) {
    if (!k.root.visible || !k.alive) return false;
    if (k.kind === 'soldier') return k.state !== 'down' && k.state !== 'gone' && k.state !== 'wait' && k.state !== 'drop' && k.state !== 'retreat';
    return k.state !== 'wait' && k.state !== 'descend' && k.state !== 'dead';
  }

  each(fn) {
    if (!this.pool) return;
    for (const s of this.soldiers) if (this.isTarget(s)) fn(s);
    if (this.isTarget(this.xarg)) fn(this.xarg);
  }

  hit(center, r, dmg, dir, kind) {
    if (!this.pool) return false;
    const d = (this.player.lockDir && kind === 'punch' ? this.player.lockDir : dir).clone().normalize();
    if (kind === 'punch') {
      let best = null, bd = Infinity;
      this.each((k) => {
        const dd = k.c.distanceTo(center);
        const ok = dd < r + 1 || (k === this.assistKin && k.c.distanceTo(this.heroC) < 5.5);
        if (ok && dd < bd) { best = k; bd = dd; }
      });
      if (!best) return this.ship.hitSphere(center, r, dmg, d, kind);
      best.receive('punch', 0, best.c.clone().addScaledVector(d, -0.4), d);
      return true;
    }
    const power = clamp(dmg / PC.heavyDamage, 0, 1);
    let any = false;
    this.each((k) => {
      if (k.c.distanceTo(center) >= r + 1.2 && k !== this.assistKin) return;
      k.receive('heavy', power, k.c.clone().addScaledVector(d, -0.4), d);
      any = true;
    });
    return any || this.ship.hitSphere(center, r, dmg, d, kind);
  }

  // Луч героя
  rayHit(origin, dir, maxDist) {
    // Два луча упёрлись друг в друга: дальше точки встречи ни один не идёт
    if (this.story.lock) return { dist: origin.distanceTo(this.story.lock.pos), cap: null };
    let best = null, bd = maxDist;
    this.each((k) => {
      _v.subVectors(k.c, origin);
      const along = _v.dot(dir);
      if (along < 1 || along > bd) return;
      if (_v.addScaledVector(dir, -along).lengthSq() < 1.2) { bd = along; best = { dist: along, cap: k }; }
    });
    return this.ship.rayHit(origin, dir, bd) || best;
  }

  takeHit(amount, point, dir, kind, cap) {
    if (!cap) return;
    cap.receive('laser', (amount / 325) * (cap.kind === 'general' ? 0.36 : 1), point, dir);
  }

  // Схватить можно только оглушённого
  findGrabbable(p, range) {
    let best = null, bd = Math.min(range, 6);
    this.each((k) => {
      const stunned = k.kind === 'general' ? (k.state === 'stun' || k.state === 'down') : k.knock > 0;
      if (!stunned) return;
      const d = k.c.distanceTo(p);
      if (d < bd) { bd = d; best = { ref: k, dist: d }; }
    });
    return best;
  }

  hold(k) {
    k.vel.set(0, 0, 0);
    k.knock = 0;
    k.grounded = false;
    if (k.kind === 'general') { k.go('held'); k.heldT = 1.7; } else k.state = 'held';
  }

  setHeld(k, p, yawQ) {
    k.pos.copy(p).addScaledVector(UP, -1);
    k.vel.set(0, 0, 0);
    if (yawQ) k.quat.copy(yawQ);
  }

  throwObj(k, vel) {
    const dir = vel.clone().normalize();
    if (k.kind === 'soldier') k.state = 'fight';
    k.receive('throw', 1, k.c.clone(), dir);
  }

  damageCar() { /* удар по тому, кого держим: бросок уже посчитан */ }

  // Брошенные машины и обломки
  hitByThrown() {
    const W = this.world;
    for (const car of W.traffic?.cars || []) {
      if (!car.thrown || car.state !== 'fly') continue;
      const sp = car.vel.length();
      if (sp < 40) continue;
      this.each((k) => {
        if (!car.thrown || k.c.distanceToSquared(car.pos) > 12) return;
        k.receive('car', 1, car.pos.clone(), car.vel.clone().normalize());
        if (car.hp > 0) W.traffic.explode(car);
        car.vel.multiplyScalar(-0.2);
        car.thrown = false;
      });
    }
    const D = W.debris;
    for (let i = 0; i < D.high; i++) {
      if (!D.thrown[i] || D.state[i] !== 1) continue;
      const i3 = i * 3;
      _p.set(D.pos[i3], D.pos[i3 + 1], D.pos[i3 + 2]);
      const sp = Math.hypot(D.vel[i3], D.vel[i3 + 1], D.vel[i3 + 2]);
      if (sp < 35) continue;
      this.each((k) => {
        if (!D.thrown[i] || k.c.distanceToSquared(_p) > 9) return;
        k.receive('throw', 0.6, _p.clone(), _v2.set(D.vel[i3], D.vel[i3 + 1], D.vel[i3 + 2]).normalize().clone());
        D.thrown[i] = 0;
      });
    }
  }

  // Ближайшая цель в конусе взгляда; генерал важнее солдат
  findTarget(range) {
    const dir = this.camRig.direction;
    let best = null, bs = Infinity;
    this.each((k) => {
      if (k.state === 'watch') return;
      _v.subVectors(k.c, this.heroC);
      const d = _v.length();
      if (d > range) return;
      const dot = d > 0.01 ? _v.dot(dir) / d : 1;
      if (dot < 0.45 && d > 4) return;
      const s = d * (1.6 - dot) * (k.kind === 'general' ? 0.5 : 1);
      if (s < bs) { bs = s; best = k; }
    });
    return best;
  }

  // Перед ходом героя. Нажатие удара не теряется: пока кулак занят или идёт хит-стоп, оно ждёт четверть секунды.
  // Рывок выводит из отброса. Заряженный удар отпущен — рывок к цели, чтобы он не ушёл в пустоту
  preUpdate(input, dt) {
    this.realDt = dt;
    if (!this.active || !this.fightOn || !this.pool) return;
    const P = this.player;
    // R рядом с врагом запускает сцену захвата. Врага нет — обычный захват: машина или обломок
    if (input.grab && this.seize.tryStart()) input.grab = false;
    const free = (P.punchT < 0 || P.punchT > (P.punchLen ?? PC.punchDuration) * 0.55) && P.charge <= 0 && !P.slamming && !P.driven;
    if (this.chain.kin) {
      // Идёт серия: нажатие — это следующий удар серии, он дождётся своего кадра
      if (input.punch) this.chain.queued = true;
      input.punch = false;
      this.punchBuf = 0;
    } else if (P.captured || P.held) this.punchBuf = 0;
    else if (input.punch) this.punchBuf = free ? 0 : 0.25;
    else if (this.punchBuf > 0) {
      this.punchBuf -= dt;
      if (free) { input.punch = true; this.punchBuf = 0; }
    }
    this.recoverCd -= dt;
    if (input.dash && P.knockT > 0 && this.recoverCd <= 0 && !P.driven && !P.captured && !this.heroDown) {
      this.recoverCd = 1.2;
      P.knockT = 0;
      P.dashCd = 0;
      P.vel.multiplyScalar(0.15);
      this.world.effects.shockwave(this.heroC.clone(), { type: 'sphere', radius: 9, life: 0.3, opacity: 0.45 });
    }
    if (input.heavyHeld || P.charge <= 0.12 || P.driven || P.captured) return;
    const t = this.findTarget(34);
    if (!t) return;
    _v.subVectors(t.c, _p.copy(P.pos).addScaledVector(UP, 1));
    const d = _v.length();
    this.assistKin = t;
    this.assistT = 0;
    if (d <= 3.2) return;
    _v.divideScalar(d);
    P.pos.addScaledVector(_v, d - 3);
    P.grounded = false;
    P.falling = false;
    const W = this.world;
    W.effects.ghost(P.root);
    W.effects.shockwave(this.heroC.clone(), { type: 'disc', dir: _v.clone(), radius: 8, life: 0.3, opacity: 0.6 });
    W.audio?.whoosh(0.9);
  }

  // Удар рукой притягивает героя к цели — как во всех боевиках: промахнуться в воздухе почти невозможно
  trackPunch(dt) {
    const P = this.player;
    const started = P.punchT >= 0 && !P.punchHit && P.punchPower === 0 && (this.prevPunchT < 0 || P.punchT < this.prevPunchT);
    this.prevPunchT = P.punchT;
    if (started && !P.driven) {
      this.fx.play('swing', { gain: 0.7 });
      const t = this.findTarget(45);
      if (t) { this.assistKin = t; this.assistT = P.punchHitAt ?? PC.punchHitTime; }
    }
    if (this.assistT > 0 && this.assistKin) {
      this.assistT -= dt;
      const t = this.assistKin;
      _v.subVectors(t.c, this.heroC);
      const d = _v.length();
      if (d > 0.01) {
        _v.divideScalar(d);
        P.lockDir = (P.lockDir || new THREE.Vector3()).copy(_v);
        const gap = d - 2.2;
        if (gap > 0) {
          const sp = Math.min(gap / Math.max(this.assistT, 0.02), 420);
          P.pos.addScaledVector(_v, sp * dt);
          P.vel.copy(_v).multiplyScalar(Math.min(sp, 40));
        }
        if (t.c.y - this.heroC.y > 2 || !t.grounded) { P.grounded = false; P.falling = false; }
      }
    }
    if (P.punchT < 0 && this.assistT <= 0 && !P.driven) {
      if (P.lockDir) P.lockDir = null;
      this.assistKin = null;
    }
  }

  // Камера: мягко ведёт на цель; в серии — вплотную и жёстко
  updateFocus(realDt, input) {
    const F = this.focus, C = this.chain, X = this.xarg;
    if (Math.abs(input.lookDX) + Math.abs(input.lookDY) > 3) this.muteT = 0.6;
    else this.muteT -= realDt;
    const St = this.story;
    let want = 0, target = null;
    F.rate = 6;
    F.dist = undefined;
    F.side = undefined;
    F.lift = 0;
    F.fov = 0;
    // Удары серии чередуют сторону: камера переходит через плечо вслед за ними
    this.sideCur += ((C.side || 1) * 1.5 - this.sideCur) * (1 - Math.exp(-5 * realDt));
    if (St.lock) { F.pos.copy(St.lock.pos); F.k += (0.85 - F.k) * (1 - Math.exp(-6 * realDt)); F.rate = 7; F.dist = 7; F.side = 2.2; F.lift = 0.5; F.fov = 48; return; }
    if (St.cutLook > 0 && St.falling) { St.chunkTop(St.falling, F.pos); F.k += (0.75 - F.k) * (1 - Math.exp(-5 * realDt)); F.rate = 5; F.dist = 7; F.side = 1.6; F.fov = 62; return; }
    if (this.seize.kin) { target = this.seize.kin; want = 0.85; F.rate = 10; F.dist = 6; F.side = 1.8; F.lift = 0.7; F.fov = 58; }
    else if (St.brawlOn && !C.kin) { target = X; want = 0.8; F.rate = 10; F.dist = 4; F.side = 1.4; F.lift = 0.3; F.fov = 46; }
    else if (C.kin && C.state === 'chase') { target = C.kin; want = 1; F.rate = 16; F.dist = 6; F.side = this.sideCur; F.lift = 0.7; F.fov = 66; }
    else if (C.kin) {
      // Цель улетает: объектив сужается вслед за ней, как у оператора с длинным фокусом
      target = C.kin;
      want = this.muteT > 0 ? 0.55 : 0.85;
      F.rate = 12; F.dist = 5.2; F.side = this.sideCur; F.lift = 0.7;
      F.fov = clamp(46 * 120 / Math.max(1, target.c.distanceTo(this.heroC)), 20, 46);
    }
    else if (X && X.state === 'chain' && X.blow) { target = X; want = 0.9; F.rate = 12; F.dist = 3.8; F.side = 1.7; F.lift = 0.4; F.fov = 44; }
    else if (X && (X.state === 'chain' || X.state === 'carry' || X.state === 'shoulder' || X.state === 'grab')) { target = X; want = 0.6; F.rate = 8; F.dist = 5.5; F.side = 1.2; }
    else if (this.fightOn && this.softLock && !this.heroDown && this.muteT <= 0) {
      this.softT -= realDt;
      if (this.softT <= 0) {
        this.softT = 0.25;
        this.softKin = this.stage === 'duel' ? (X.alive && X.c.distanceTo(this.heroC) < 150 ? X : null) : this.findTarget(70);
      }
      if (this.softKin && this.softKin.alive) { target = this.softKin; want = 0.35; }
    }
    if (target) F.pos.copy(target.c);
    F.k += (want - F.k) * (1 - Math.exp(-10 * realDt));
  }

  // ---------------------------------------------------------------- кадр
  update(dt, realDt, input) {
    if (!this.active) return;
    const P = this.player, W = this.world, cam = this.camera.position;
    this.input = input;
    this.time += realDt;
    this.stageT += realDt;
    this.heroC.copy(P.pos).addScaledVector(UP, 1);
    if (this.counterT > 0) this.counterT -= realDt;
    if (P.dashT <= 0) this.dodgeLock = false;
    // Отбросило и отпустило: резко тормозит корпусом, воздух бьёт вокруг
    const knocked = P.knockT > 0;
    if (this.wasKnocked && !knocked && !P.grounded && !P.driven && !P.captured && P.dashT <= 0 && !this.heroDown && this.fightOn) {
      if (P.speed > 40) W.effects.shockwave(this.heroC.clone(), { type: 'disc', dir: P.vel.clone().normalize(), radius: 10, life: 0.35, opacity: 0.55 });
      P.vel.multiplyScalar(0.18);
      this.fx.play('brake');
    }
    this.wasKnocked = knocked;
    if (this.slowT > 0) {
      this.slowT -= realDt;
      if (this.slowT <= 0) this.timeScale = this.chain.state === 'window' ? 0.5 : 1;
    }

    this.ship.update(dt, cam, W.audio);
    this.ship.collide(P, this.prevHero, dt);
    this.prevHero.copy(P.pos);

    if (this.pool) {
      this.boltCd -= dt;
      this.bolts.update(dt, P);
      this.meleeSlots = 2;
      for (const s of this.soldiers) {
        s.update(dt, P, cam);
        if (s.state === 'lunge') this.meleeSlots--;
      }
      this.xarg.update(dt, P, cam);
      if (this.xarg.knock > 0) this.ship.collide(this.xarg, this.prevXarg, dt);
      this.prevXarg.copy(this.xarg.pos);
      this.story.update(dt, realDt, input);
    }
    this.fx.update(dt, realDt);
    this.stepStage(dt, realDt, input);
    this.chain.update(realDt);
    this.seize.update(realDt);
    this.finale.update(realDt);
    this.parley.update(realDt, input);

    if (this.fightOn && this.pool && !this.heroDown) {
      this.trackPunch(dt);
      this.hitByThrown();
      // Удар о землю задевает всех рядом
      if (this.wasSlam && !P.slamming && P.grounded) {
        const at = P.pos.clone();
        this.each((k) => {
          const d = k.c.distanceTo(at);
          if (d < 24) k.receive('slam', 1 - d / 24, k.c.clone(), _v.subVectors(k.c, at).setY(4).normalize().clone());
        });
      }
      // Таран на скорости
      this.ramCd -= realDt;
      const sp = P.speed;
      if (sp > 140 && this.ramCd <= 0 && !P.driven && !P.captured && P.knockT <= 0) {
        this.each((k) => {
          // Оба шли на полном ходу навстречу: никто никого не пробил, столкнулись
          const headOn = k === this.xarg && (k.state === 'shoulder' || k.state === 'grab' || (k.state === 'chain' && k.chainStep === 'rush')) && P.vel.dot(k.vel) < 0;
          if (this.ramCd > 0 || k.c.distanceTo(this.heroC) > 2.6 + (sp + (headOn ? k.vel.length() : 0)) * realDt) return;
          this.ramCd = 0.5;
          if (headOn) { this.clash(k, true); return; }
          const dir = P.vel.clone().normalize();
          k.receive('ram', clamp(sp / 900, 0, 1), k.c.clone(), dir);
          P.vel.multiplyScalar(0.45);
        });
      }
    }
    this.wasSlam = P.slamming;

    if (this.pool) this.updateFocus(realDt, input);
    this.scareT -= realDt;
    if (this.scareT <= 0 && this.pool && this.xarg.root.visible) {
      this.scareT = 1;
      W.people?.scareAround?.(this.xarg.pos, 240);
      W.air?.scareBirds?.(this.xarg.pos, 280);
    }
    this.updateUI(realDt);
    if (this.shipLeaveT !== null) {
      this.shipLeaveT -= realDt;
      if (this.shipLeaveT <= 0) { this.shipLeaveT = null; this.ship.leave(); }
    }
    if (this.endT !== null && !this.ended) {
      this.endT -= realDt;
      if (this.endT <= 0) this.finish();
    }
  }

  stepStage(dt, realDt, input) {
    const P = this.player, X = this.xarg, S = this.shot;
    const t = this.stageT;
    switch (this.stage) {
      case 'warn': {
        this.tickAlert(realDt);
        if (t >= WARN_T) {
          this.setStage('descent');
          this.el.alert.classList.add('hidden');
          this.setCine(true);
          P.driven = this.holdHero;
          P.punchT = -1; P.charge = 0; P.slamming = false; P.lasering = false; P.dashT = 0;
          this.shotPos = this.groundPoint(SITE.clone().addScaledVector(FACE, 260).add(_v.set(70, 0, 0)), 2.5);
        }
        break;
      }
      case 'descent': {
        // Сначала герой смотрит вверх, потом вид с земли — корабль закрывает небо
        const F = this.focus;
        if (t < 4.5) {
          F.pos.copy(this.ship.group.position);
          F.rate = 2.5;
          F.k = 0.9;
        } else {
          F.k = 0;
          S.pos.copy(this.shotPos);
          S.look.copy(this.ship.group.position);
          S.fov = 58;
          this.camRig.shot = S;
        }
        if (this.pool && (this.ship.state === 'hover' || input.punch)) {
          this.beginLanding();
          if (input.punch) { this.skipScene(); this.beginMeet(); }
        }
        break;
      }
      case 'landing': {
        if (input.punch) { this.skipScene(); this.beginMeet(); break; }
        if (!this.xargDrop && t >= 3.2) {
          this.xargDrop = true;
          X.slot = this.xargSlot();
          X.slotY = X.slot.y;
          X.place(this.ship.bellyPos(_v), FACE);
          X.root.visible = true;
          X.grounded = false;
          X.go('descend');
        }
        const right = _r.crossVectors(FACE, UP).normalize();
        this.camRig.shot = S;
        if (t < 5) {
          // Строй снизу: фигуры падают вдоль колонны
          S.pos.copy(SITE).addScaledVector(FACE, 48).addScaledVector(right, 16);
          S.pos.y = this.ground(S.pos.x, S.pos.z) + 1.8;
          S.look.copy(SITE).setY(S.pos.y + 42 - t * 6);
          S.fov = 62;
        } else {
          // Генерал: крупный план, он садится и встаёт с колена
          const c = X.c;
          S.pos.copy(X.slot).addScaledVector(FACE, 9.5).addScaledVector(right, -3.4);
          S.pos.y = X.slotY + 1.15;
          S.look.lerp(_v.copy(c).setY(c.y + 0.25), 1 - Math.exp(-5 * realDt));
          S.fov = 42;
        }
        if (X.state === 'stand' && X.landT <= 0) this.beginMeet();
        else if (t > 18) this.beginMeet();
        break;
      }
      case 'meet': {
        const d = X.c.distanceTo(this.heroC);
        if (d < 42 && P.speed < 400 && !P.captured) {
          this.setStage('parley');
          this.parley.start();
        } else if (t > 45) {
          this.startFight('Молчание — тоже ответ. Десант, взять его.');
        } else if (t > 25 && X.state === 'stand') {
          X.go('approach');
          this.say('Ждать я не стану.', 2.5);
        }
        break;
      }
      case 'parley': break;
      case 'wave': {
        this.engageT += realDt;
        if (this.engageT > 7) { this.engageT = 0; this.engageNext(1); }
        if (this.duelT !== null) {
          this.duelT -= realDt;
          if (this.duelT <= 0) this.beginDuel();
        } else if (t > 150) this.beginDuel();
        break;
      }
      case 'duel': {
        if (this.pendingClimb && !this.chain.kin && ['neutral', 'recover', 'regain'].includes(X.state)) {
          this.pendingClimb = false;
          if (X.startClimb()) this.story.radio('ОРБИТАЛЬНЫЙ МОНИТОРИНГ: Цель уходит вертикально вверх. Покидает атмосферу.');
        }
        // Музыка следует за боем: в космосе барабаны уходят
        const y = this.camera.position.y;
        if (!this.spaceOn && y > 14000) this.spaceOn = true;
        else if (this.spaceOn && y < 10000) this.spaceOn = false;
        if (this.endT === null && !this.heroDown) {
          const St = this.story;
          this.theme.setSection(St.fall ? 'fall' : St.brawlOn ? 'last' : X.phase === 3 ? 'rage' : this.spaceOn ? 'space' : X.phase === 2 ? 'rise' : 'duel');
        }
        break;
      }
      case 'badend': {
        const Wd = this.world;
        const back = _v.copy(P.pos).sub(_v2.set(0, 0, 0)).setY(0).normalize();
        S.pos.copy(P.pos).addScaledVector(back, 5).addScaledVector(UP, 1.9);
        S.look.set(0, 45, 0);
        S.fov = 52;
        if (t > 3) {
          this.gunT -= realDt;
          if (this.gunT <= 0) {
            this.gunT = 0.38;
            const a = Math.random() * Math.PI * 2, r = Math.random() * 300;
            const pt = new THREE.Vector3(Math.cos(a) * r, 14 + Math.random() * 30, Math.sin(a) * r);
            this.ship.fireGun(pt);
            Wd.city.damageRadius(pt, 38, 1500, 70);
            Wd.effects.shockwave(pt.clone(), { type: 'sphere', radius: 40, life: 0.6, opacity: 0.45 });
            Wd.effects.flash(pt, 50);
            Wd.audio?.boom(0.8, pt.clone());
            Wd.audio?.explosion(0.7, pt.clone());
          }
        }
        break;
      }
      default:
    }
    void dt;
  }

  groundPoint(p, h) {
    p.y = this.ground(p.x, p.z) + h;
    return p;
  }

  // Панель перехвата: строки печатаются, в конце идёт обратный отсчёт
  tickAlert(realDt) {
    this.alertT += realDt;
    const full = ALERT.join('\n');
    const n = Math.min(full.length, Math.floor(this.alertT * 42));
    const left = Math.max(0, Math.ceil(WARN_T - this.stageT));
    let txt = full.slice(0, n);
    if (n >= full.length) txt += `\nДо входа в атмосферу: 00:${String(left).padStart(2, '0')}`;
    if (txt !== this.lastAlert) { this.el.alertBody.textContent = txt; this.lastAlert = txt; }
  }

  // ---------------------------------------------------------------- HUD
  updateUI(realDt) {
    const el = this.el, X = this.xarg, P = this.player;
    if (this.subT > 0) {
      this.subT -= realDt;
      if (this.subT <= 0) {
        el.sub.classList.add('hidden');
        const next = this.subQ.shift();
        if (next) this.say(next[0], next[1]);
      }
    }
    if (this.hintT > 0) { this.hintT -= realDt; if (this.hintT <= 0) el.hint.classList.add('hidden'); }

    if (this.fightOn || this.stage === 'badend') {
      if (!this.heroDown && this.time - this.lastHurtAny > 8) this.heroHP = Math.min(HERO_HP, this.heroHP + 8 * realDt);
      const bossK = this.stage === 'wave' ? Math.max(0, 1 - this.downCount / WAVE_GOAL) : Math.max(0, X.hp / XARG_HP);
      const heroK = this.heroHP / HERO_HP;
      this.lagBoss = Math.max(bossK, this.lagBoss - realDt * 0.25);
      this.lagHero = Math.max(heroK, this.lagHero - realDt * 0.4);
      el.fill.style.width = `${bossK * 100}%`;
      el.lag.style.width = `${this.lagBoss * 100}%`;
      el.ui.classList.toggle('stagger', this.stage === 'duel' && (X.state === 'stun' || X.state === 'down'));
      el.heroFill.style.width = `${heroK * 100}%`;
      el.heroLag.style.width = `${this.lagHero * 100}%`;
      el.hero.classList.toggle('low', heroK < 0.3);
      el.shipFill.style.width = `${this.ship.healthK * 100}%`;
      const hpTxt = `${Math.ceil(this.heroHP)} / ${HERO_HP}`;
      if (hpTxt !== this.lastHpTxt) { el.heroTxt.textContent = hpTxt; this.lastHpTxt = hpTxt; }
      this.hurtK = Math.max(0, this.hurtK - realDt * 1.6);
      el.hurt.style.opacity = Math.min(1, this.hurtK + (heroK < 0.3 && !this.heroDown ? 0.25 + 0.1 * Math.sin(this.time * 6) : 0));
    }

    // Метка: корабль до посадки, потом генерал
    let mark = null, far = 250;
    if (this.stage === 'warn') mark = this.ship.group.position;
    else if (this.stage === 'meet' && this.pool) { mark = X.c; far = 60; }
    else if ((this.stage === 'wave' || this.stage === 'duel') && this.pool && X.alive) mark = X.c;
    const cine = this.stage === 'descent' || this.stage === 'landing' || this.stage === 'parley' || this.stage === 'badend';
    const cam = this.camera;
    let show = false;
    if (mark && !cine) {
      _p.copy(mark);
      const d = _p.distanceTo(cam.position);
      _p.project(cam);
      let x = _p.x, y = _p.y;
      const behind = _p.z > 1;
      if (behind) { x = -x; y = -y; }
      const k = Math.max(Math.abs(x) / 0.92, Math.abs(y) / 0.85, behind ? 1.0001 : 0);
      const edge = k > 1;
      if (edge) { x /= k; y /= k; }
      show = d > far || (edge && d > 14 && this.stage === 'duel');
      if (show) {
        el.marker.style.transform = `translate(${(x * 0.5 + 0.5) * window.innerWidth}px, ${(-y * 0.5 + 0.5) * window.innerHeight}px)`;
        el.marker.classList.toggle('edge', edge);
        const dist = d >= 1000 ? `${(d / 1000).toFixed(1).replace('.', ',')} км` : `${Math.round(d)} м`;
        el.markerTxt.textContent = this.stage === 'warn' ? `ОБЪЕКТ ${dist}` : dist;
      }
    }
    el.marker.classList.toggle('hidden', !show);
    void P;
  }
}

export { SHIP };
