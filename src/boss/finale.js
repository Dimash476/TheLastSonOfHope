import * as THREE from 'three';
import { aimBlow, reelHit } from '../player/model.js';
import { groundHeight, inRiver } from '../world/layout.js';
import { clamp, damp, lerp, smoothstep } from '../utils.js';

// Конец боя. Это сцена, а не надпись: управление забрано, всё читается в кадре.
//  strike  — последний удар вязнет во времени, музыка обрывается, слышно только сам удар;
//  fall    — его уносит и бьёт о город: сперва глазами героя, потом с земли;
//  dust    — пыль и тишина;
//  descend — герой спускается сквозь дым и встаёт на краю воронки;
//  walk    — идёт к нему пешком;
//  words   — генерал приподнимается и договаривает. Швы на доспехе гаснут вместе с ним;
//  knee    — герой опускается на колено: сил больше нет;
//  crane   — встаёт, камера поднимается и показывает, что осталось от города, и всё уходит в чёрное.

const UP = new THREE.Vector3(0, 1, 0);
const RUBBLE = new THREE.Color(0x6a635c);
const AXIS_X = new THREE.Vector3(1, 0, 0);
const CITY_R = 800;       // м: куда бы его ни унесло, падает в город
const HIGH = 900;         // м над землёй: выше этого герой снижается вместе с ним
const LAST_T = 1.15;      // с: последние секунды падения снимаем с земли
const LAST_V = 2600;      // м/с: быстрее его в этом кадре просто не разглядеть
const RIM = 8;            // м от тела до места, где встаёт герой
const STOP = 2.4;         // м: где останавливается
const LIE = Math.PI / 2 * 0.98, PROPPED = 1.0;

// [с какой секунды, текст, сколько висит]
const WORDS = [
  [0.7, 'Сорок кораблей… Они всё равно придут.', 4],
  [5.4, 'Пусть приходят.', 2.4],
  [8.4, 'Ты мог… стоять рядом со мной.', 3.2],
  [12, 'Сын Ксаррона…', 2.2],
];

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _q = new THREE.Quaternion();

function headOf(model, body, out) {
  const b = model.skinned?.bone('Head');
  return b ? b.getWorldPosition(out) : out.copy(body).addScaledVector(UP, 0.65);
}

export class Finale {
  constructor(inv) {
    this.inv = inv;
    this.shot = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 40 };
    this.dir = new THREE.Vector3(0, 0, 1);
    this.side = new THREE.Vector3(1, 0, 0);
    this.strikeSide = new THREE.Vector3(1, 0, 0);
    this.rim = new THREE.Vector3(1, 0, 0);
    this.from = new THREE.Vector3();
    this.to = new THREE.Vector3();
    this.heroFrom = new THREE.Vector3();
    this.heroAt = new THREE.Vector3();
    this.heroStop = new THREE.Vector3();
    this.camFix = new THREE.Vector3();
    this.prev = new THREE.Vector3();
    this.spinAxis = new THREE.Vector3(1, 0, 0);
    this.q0 = new THREE.Quaternion();
    this.yawQ = new THREE.Quaternion();
    this.$fade = document.getElementById('inv-fade');
    this.driven = () => this.drive();
    this.state = null;
    this.t = 0;
  }

  get on() { return !!this.state; }
  // Пропустить можно, когда последний удар уже показан
  get skippable() { return !!this.state && this.state !== 'init' && this.state !== 'strike'; }

  reset() {
    const I = this.inv, P = I.player;
    if (this.state) {
      if (P.driven === this.driven) P.driven = null;
      P.poseQ = null;
      P.blow = null;
      P.lockDir = null;
      if (I.camRig.shot === this.shot) I.camRig.shot = null;
      I.world.audio?.setMuffle?.(0);
      if (I.xarg) I.xarg.anim.prop = 0;
      for (const m of I.world.effects.craters) m.material.color.setScalar(1);
    }
    this.calm(false);
    this.state = null;
    this.$fade?.classList.remove('on');
  }

  // Удар уже попал. Сцена начнётся со следующего кадра: сейчас ещё идёт расчёт этого удара
  begin(dir) {
    if (this.state) return;
    this.dir.copy(dir);
    this.go('init');
  }

  go(state) {
    this.state = state;
    this.t = 0;
  }

  // Город после боя пуст: ни машин на ходу, ни прохожих
  calm(on) {
    const W = this.inv.world;
    if (W.traffic) W.traffic.calm = on;
    if (W.people) W.people.calm = on;
  }

  start() {
    const I = this.inv, P = I.player, X = I.xarg, St = I.story;
    if (I.chain.kin) I.chain.end(true);
    if (I.seize.kin) I.seize.reset();
    St.cancel();
    St.radioT = 0;
    St.radioQ.length = 0;
    St.$radio.classList.add('hidden');
    // Он уже мёртв: недосказанное в бою не должно всплыть поверх сцены
    I.subQ.length = 0;
    I.subT = 0;
    I.el.sub.classList.add('hidden');
    I.setCine(true);
    I.slowT = 0;
    this.calm(true);
    X.clearShot();
    X.go('scene');
    X.knock = 99;
    X.vel.set(0, 0, 0);
    X.blow = null;
    X.poseQ = X.quat.clone();
    X.grounded = false;
    X.reel.ext = true;
    reelHit(X.reel, 1.35, 1);
    X.model.setRage(0.8);
    P.driven = this.driven;
    P.punchT = -1;
    P.charge = 0;
    P.lasering = false;
    P.dashT = 0;
    P.slamming = false;
    P.falling = false;
    P.knockT = 0;
    P.boosting = false;
    P.grounded = false;
    P.poseQ = P.quat.clone();
    P.lockDir = new THREE.Vector3();
    P.blow = { side: 'R', f: 1.35, k: 1, pitch: 0.35, kind: 'straight' };
    // Линия удара и поперёк неё кадр
    _a.subVectors(X.c, I.heroC);
    if (_a.lengthSq() > 0.01) this.dir.copy(_a);
    this.dir.normalize();
    this.side.crossVectors(this.dir, UP);
    if (this.side.lengthSq() < 0.01) this.side.set(1, 0, 0);
    this.side.normalize();
    this.pickStrikeSide();
    I.fx.finalBlow(this.jaw(_b).clone(), this.dir.clone());
    I.theme.cut();
    I.world.audio?.setMuffle?.(1);
    I.camRig.shot = this.shot;
    this.go('strike');
  }

  // Куда приходится кулак: перед лицом, на линии удара
  jaw(out) {
    const X = this.inv.xarg;
    return headOf(X.model, X.c, out).addScaledVector(this.dir, -0.16);
  }

  // Откуда снимать сам удар: поперёк его линии и так, чтобы между камерой и бойцами не было дома
  pickStrikeSide() {
    const I = this.inv, city = I.world.city, up = _c.crossVectors(this.dir, this.side).normalize();
    _a.lerpVectors(I.heroC, I.xarg.c, 0.5);
    for (const a of [0, Math.PI, 0.6, Math.PI - 0.6, -0.6, Math.PI + 0.6, 1.2, Math.PI - 1.2, Math.PI / 2]) {
      _b.copy(this.side).multiplyScalar(Math.cos(a)).addScaledVector(up, Math.sin(a));
      let clear = true;
      for (let r = 1; clear && r <= 6; r++) clear = !city.isInside(_d.copy(_a).addScaledVector(_b, r));
      if (clear) { this.strikeSide.copy(_b); return; }
    }
    this.strikeSide.copy(this.side);
  }

  // ---------------------------------------------------------------- тела: из player.driven
  drive() {
    const I = this.inv, P = I.player, X = I.xarg, rdt = I.realDt, b = P.blow;
    if (this.state === 'init') return;
    P.idleT = 0;
    if (this.state === 'strike') {
      // Кулак доходит за миг настоящего времени, дальше всё вязнет
      // Запястье ведём точно к челюсти: тело встаёт так, как этого требует вытянутая рука
      this.jaw(_a).addScaledVector(this.dir, -0.1).sub(P.model.fistWorldPos('R', _b));
      P.pos.addScaledVector(_a, 1 - Math.exp(-22 * rdt));
      P.vel.set(0, 0, 0);
      P.lockDir.copy(this.dir);
      b.f = b.f < 2 ? Math.min(2, b.f + rdt * 5.4) : Math.min(2.3, b.f + rdt * 0.2);
      aimBlow(P.poseQ, this.dir, b, rdt, 16);
      // Голова уходит сразу и так и висит: пружина вернула бы её раньше, чем кончится кадр
      X.reel.k = damp(X.reel.k, 1.25, 16, rdt);
      X.reel.h = damp(X.reel.h, 0.7, 2.2, rdt);
      X.reel.v = X.reel.hv = 0;
      if (this.t > 0.5) X.pos.addScaledVector(this.dir, rdt * 1.4);
      return;
    }
    // Рука опускается сама, сцена её уже не держит
    if (b) {
      b.f += rdt * 1.3;
      if (b.f > 2.55) b.k = Math.max(0, 1 - (b.f - 2.55) / 0.45);
      if (b.f >= 3) { P.blow = null; P.poseQ = null; }
    }
    if (this.state === 'fall') { this.fallBody(rdt); this.fallHero(rdt); return; }
    if (this.state === 'dust') { this.hover(rdt); return; }
    if (this.state === 'descend') { this.descendHero(rdt); return; }
    // Дальше он на земле
    P.vel.set(0, 0, 0);
    P.grounded = true;
    P.pos.y = this.heroAt.y;
    if (this.state === 'walk' && this.t > 1.7) {
      _a.subVectors(this.heroStop, P.pos).setY(0);
      const l = _a.length();
      if (l > 0.03) {
        _a.divideScalar(l);
        const sp = Math.min(1.7, l * 3);
        P.vel.copy(_a).multiplyScalar(sp);
        P.pos.addScaledVector(_a, sp * rdt);
      }
    }
  }

  // Висит там, откуда ударил, и смотрит вниз
  hover(rdt) {
    const I = this.inv, P = I.player;
    P.vel.multiplyScalar(Math.exp(-4 * rdt));
    P.pos.addScaledVector(P.vel, rdt);
    _a.subVectors(I.xarg.c, I.heroC);
    if (_a.lengthSq() > 1) P.lockDir.copy(_a).normalize();
  }

  // ---------------------------------------------------------------- падение генерала
  startFall() {
    const I = this.inv, X = I.xarg, P = I.player, to = this.to;
    _a.set(this.dir.x, 0, this.dir.z);
    if (_a.lengthSq() < 0.01) _a.set(this.side.z, 0, -this.side.x);
    _a.normalize();
    const h0 = X.pos.y - Math.max(0, groundHeight(X.pos.x, X.pos.z));
    const L = clamp(h0 * 0.45, 90, 420);
    to.set(X.pos.x + _a.x * L, 0, X.pos.z + _a.z * L);
    const r = Math.hypot(to.x, to.z);
    if (r > CITY_R) { to.x *= CITY_R / r; to.z *= CITY_R / r; }
    for (let i = 0; i < 14 && (inRiver(to.x, to.z) || inRiver(to.x + 12, to.z) || inRiver(to.x - 12, to.z)); i++) {
      to.x += (Math.random() - 0.5) * 90;
      to.z += (Math.random() - 0.5) * 90;
    }
    to.y = Math.max(0, groundHeight(to.x, to.z));
    this.from.copy(X.pos);
    this.fallT = clamp(X.pos.distanceTo(to) / 1500, 1.7, 5.5);
    this.ang = 0;
    this.q0.copy(X.poseQ);
    this.spinAxis.copy(this.side).addScaledVector(_a, 0.35).normalize();
    // С большой высоты герой снижается следом, иначе оба пропадут из вида
    this.heroFrom.copy(P.pos);
    this.heroAt.copy(P.pos);
    if (P.pos.y > to.y + HIGH) this.heroAt.copy(to).addScaledVector(_a, -240).setY(to.y + HIGH);
    X.reel.ext = false;
    _b.subVectors(to, X.pos).normalize();
    I.fx.chainRelease(X.c, _b.clone(), 6, true, X);
    I.fx.play('sonicBoom', { gain: 0.9 });
    I.timeScale = 1;
    this.fixGroundCam();
    this.go('fall');
  }

  // Точка на земле, откуда видно место падения: сбоку от линии полёта и не внутри дома
  fixGroundCam() {
    const city = this.inv.world.city, to = this.to, a0 = Math.atan2(this.side.z, this.side.x);
    for (let i = 0; i < 10; i++) {
      const a = a0 + i * 0.63, h = 7 + i * 3;
      this.camFix.set(to.x + Math.cos(a) * 84, 0, to.z + Math.sin(a) * 84);
      this.camFix.y = Math.max(0, groundHeight(this.camFix.x, this.camFix.z)) + h;
      let clear = true;
      for (let u = 0; clear && u < 0.9; u += 0.1) clear = !city.isInside(_a.lerpVectors(this.camFix, to, u).setY(to.y + h));
      if (clear) return;
    }
    this.camFix.y = to.y + 60;
  }

  fallBody(rdt) {
    const I = this.inv, X = I.xarg, u = clamp(this.t / this.fallT, 0, 1), h = u * u * (3 - 2 * u);
    this.prev.copy(X.pos);
    X.pos.set(lerp(this.from.x, this.to.x, h), this.to.y + this.fallLeft(this.from.y - this.to.y), lerp(this.from.z, this.to.z, h));
    _a.subVectors(X.pos, this.prev);
    const speed = _a.length() / Math.max(rdt, 1e-3);
    X.vel.copy(_a).divideScalar(Math.max(rdt, 1e-3));
    if (Math.min(this.prev.y, X.pos.y) < 700) I.chain.ram(this.prev, X.pos, speed);
    this.ang += rdt * 2.4;
    X.poseQ.copy(this.q0).premultiply(_q.setFromAxisAngle(this.spinAxis, this.ang));
    const hot = smoothstep(1400, 3200, speed) * smoothstep(800, 3000, X.pos.y);
    I.fx.setLoop('entry', hot * 0.8, 0.3);
    if (hot > 0.02) I.story.plasma.update(_c.copy(X.c).addScaledVector(_b.copy(_a).normalize(), 2), _b, hot, rdt);
    else I.story.plasma.mesh.visible = false;
    // Дымный след: с земли его видно раньше, чем его самого
    if (speed > 400 && X.pos.y < 5000) {
      for (let k = 0; k < 3; k++) I.world.dust.burst(_c.lerpVectors(this.prev, X.pos, k / 3).addScaledVector(UP, 1), 1, { size: [9, 18], speed: 3, life: [1.4, 3], color: 0x4f483f, alpha: 0.6 });
    }
  }

  // Сколько ещё лететь. С большой высоты на смене кадра скорость падает: иначе с земли его не увидеть
  fallLeft(H) {
    const left = Math.max(0, this.fallT - this.t), last = LAST_V * LAST_T;
    if (H > last && left <= LAST_T) return LAST_V * left;
    if (H > last) { const u = this.t / (this.fallT - LAST_T); return last + (H - last) * (1 - u * u); }
    const u = clamp(this.t / this.fallT, 0, 1);
    return H * (1 - u * u);
  }

  fallHero(rdt) {
    const I = this.inv, P = I.player, u = clamp(this.t / (this.fallT - LAST_T), 0, 1), h = u * u * (3 - 2 * u);
    _a.copy(P.pos);
    P.pos.set(lerp(this.heroFrom.x, this.heroAt.x, h), this.heroAt.y + (this.heroFrom.y - this.heroAt.y) * (1 - u * u), lerp(this.heroFrom.z, this.heroAt.z, h));
    P.vel.subVectors(P.pos, _a).divideScalar(Math.max(rdt, 1e-3));
    _a.subVectors(I.xarg.c, I.heroC);
    if (_a.lengthSq() > 1) P.lockDir.copy(_a).normalize();
  }

  // Удар о землю: воронка, ударная волна, и генерал лежит в центре
  impact() {
    const I = this.inv, X = I.xarg, P = I.player, to = this.to;
    I.story.plasma.mesh.visible = false;
    I.fx.setLoop('entry', 0, 0.05);
    I.world.audio?.setMuffle?.(0);
    I.fx.meteor(to.clone(), 0.72);
    // Дно воронки снимаем в упор: чуть светлее обычного, чтобы тёмная броня на нём читалась
    for (const m of I.world.effects.craters) if (m.visible && m.position.distanceTo(to) < 80) m.material.color.setScalar(2.4);
    I.fx.after(1.4, () => I.fx.play('towerFall', { gain: 0.55 }));
    // Лежит ногами к герою: тот подойдёт и посмотрит ему в лицо
    _a.subVectors(I.heroC, to).setY(0);
    if (_a.lengthSq() < 4) _a.copy(this.side).setY(0);
    this.rim.copy(_a.normalize());
    this.yawQ.setFromAxisAngle(UP, Math.atan2(this.rim.x, this.rim.z));
    this.tilt = LIE;
    this.placeBody();
    X.vel.set(0, 0, 0);
    X.knock = 0;
    X.grounded = true;
    X.groundY = to.y;
    X.downK = 1;
    X.anim.prop = 0;
    this.side.set(-this.rim.z, 0, this.rim.x);
    // Столб дыма встаёт за телом, а не на нём: с верхнего кадра он закрыл бы обоих
    for (const s of I.fx.columns) if (s.pos.distanceToSquared(to) < 100) s.pos.addScaledVector(this.rim, -34);
    // Воронка горит: огонь по краям и за спиной у него, чтобы кадр не тонул в чёрном. Со стороны героя огня нет
    const rimA = Math.atan2(this.rim.z, this.rim.x);
    for (const [da, r, size] of [[1.5, 11, 1.6], [2.1, 7.5, 1.3], [2.75, 12, 2], [3.5, 8.5, 1.4], [4.15, 13, 1.8], [4.8, 10, 1.3]]) {
      I.world.fire.add(_a.set(to.x + Math.cos(rimA + da) * r, to.y + 0.6, to.z + Math.sin(rimA + da) * r).clone(), { size, life: 60 });
    }
    this.emberT = 0;
    this.heroAt.copy(to).addScaledVector(this.rim, RIM);
    this.heroAt.y = Math.max(0, groundHeight(this.heroAt.x, this.heroAt.z));
    this.heroStop.copy(to).addScaledVector(this.rim, STOP);
    P.vel.set(0, 0, 0);
    I.story.radio('ШТАБ: Падение в центре города. Ничего не видно. Кто-нибудь, ответьте.', 5.5);
    this.go('dust');
  }

  placeBody() {
    const X = this.inv.xarg, to = this.to;
    X.pos.set(to.x, to.y + 0.18 + (LIE - this.tilt) * 0.08 - 1, to.z);
    X.poseQ.copy(this.yawQ).multiply(_q.setFromAxisAngle(AXIS_X, -this.tilt));
  }

  // Угли летят, огонь отсвечивает на обоих
  ambient(realDt) {
    const W = this.inv.world, to = this.to;
    W.debris.clearAround(to.x, to.z, 16, 0.8);
    W.animals.clearAround(to, 40);
    _a.copy(to).addScaledVector(this.rim, -2.5).addScaledVector(this.side, 3).setY(to.y + 2.5);
    W.effects.flash(_a, 7 + Math.sin(this.t * 11) * 1.1 + Math.sin(this.t * 23) * 0.7);
    this.emberT -= realDt;
    if (this.emberT > 0) return;
    this.emberT = 0.05 + Math.random() * 0.09;
    const a = Math.random() * Math.PI * 2, r = 1.5 + Math.random() * 9;
    _a.set(to.x + Math.cos(a) * r, to.y + 0.3 + Math.random() * 1.5, to.z + Math.sin(a) * r);
    W.sparks.burst(_a, 1, { size: [0.03, 0.09], speed: 1.2, life: [1.4, 3.2], color: 0xffa050 });
    if (Math.random() < 0.12) W.dust.burst(_a, 1, { size: [2, 5], speed: 0.8, life: [3, 6], rise: 1.4, color: 0x5a524a, alpha: 0.32 });
  }

  // ---------------------------------------------------------------- герой спускается
  startDescend() {
    const I = this.inv, P = I.player;
    const W = I.world, to = this.to;
    W.debris.clearAround(to.x, to.z, 34);
    // Мелкий щебень вокруг: дно воронки не пустое. Дорожка, по которой он пойдёт, чистая
    for (let i = 0; i < 46; i++) {
      const a = Math.random() * Math.PI * 2, r = 2.5 + Math.random() * 19, x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (Math.abs(x * this.side.x + z * this.side.z) < 1.3 && x * this.rim.x + z * this.rim.z > 0) continue;
      const s = 0.2 + Math.random() * Math.random() * 1;
      W.debris.spawn(to.x + x, to.y + s, to.z + z, s * (0.7 + Math.random() * 0.8), s, s * (0.7 + Math.random() * 0.8), 0, -1, 0, RUBBLE);
    }
    this.heroFrom.copy(P.pos);
    this.descT = clamp(P.pos.distanceTo(this.heroAt) / 300, 3.4, 6);
    P.lockDir.copy(this.rim).negate();
    this.go('descend');
  }

  descendHero(rdt) {
    const I = this.inv, P = I.player, u = clamp(this.t / this.descT, 0, 1), e = 1 - Math.pow(1 - u, 2.4);
    this.prev.copy(P.pos);
    P.pos.lerpVectors(this.heroFrom, this.heroAt, e);
    _a.subVectors(P.pos, this.prev);
    const speed = _a.length() / Math.max(rdt, 1e-3);
    P.vel.copy(_a).divideScalar(Math.max(rdt, 1e-3));
    if (speed > 120 && Math.min(this.prev.y, P.pos.y) < 700) I.chain.ram(this.prev, P.pos, speed);
    _a.subVectors(this.to, P.pos).setY(0);
    if (_a.lengthSq() > 0.01) P.lockDir.copy(_a).normalize();
    if (u >= 1) this.land();
  }

  land() {
    const I = this.inv, P = I.player, W = I.world;
    P.pos.copy(this.heroAt);
    P.vel.set(0, 0, 0);
    P.grounded = true;
    P.groundY = this.heroAt.y;
    P.landT = 1.9;
    _a.copy(P.pos).setY(P.pos.y + 0.3);
    W.dust.burst(_a, 18, { size: [2, 6], speed: 11, life: [0.8, 2], flat: true });
    W.effects.shockwave(_a.clone(), { type: 'ring', radius: 9, life: 0.6, opacity: 0.45 });
    I.fx.play('slam', { gain: 0.35, pos: P.pos });
    I.theme.shot('fallen', undefined, 0.95);
    this.spoken = 0;
    this.go('walk');
  }

  // ---------------------------------------------------------------- кадр
  update(realDt) {
    const I = this.inv, S = this.shot;
    if (!this.state || this.state === 'done') return;
    if (this.state === 'init') this.start();
    this.t += realDt;
    if (I.camRig.shot !== S) I.camRig.shot = S;
    if (['descend', 'walk', 'words', 'knee', 'crane'].includes(this.state)) this.ambient(realDt);
    switch (this.state) {
      case 'strike': this.strikeFrame(realDt); break;
      case 'fall': this.fallFrame(); break;
      case 'dust': this.dustFrame(); break;
      case 'descend': this.descendFrame(); break;
      case 'walk': this.walkFrame(); break;
      case 'words': this.wordsFrame(); break;
      case 'knee': this.kneeFrame(); break;
      case 'crane': this.craneFrame(); break;
      default:
    }
    if (this.state !== 'strike') S.fov = Math.max(5, S.fov - I.fx.zoom * 0.5);
    // Камера не под землёй и не в стене: если попала в дом, подъезжает ближе к тому, на кого смотрит
    const city = I.world.city, gy = Math.max(0, groundHeight(S.pos.x, S.pos.z)) + 0.4;
    if (S.pos.y < gy) S.pos.y = gy;
    if (city.isInside(S.pos)) {
      _a.copy(S.pos);
      for (let k = 0.85; k > 0.05 && city.isInside(S.pos); k -= 0.15) S.pos.lerpVectors(S.look, _a, k);
    }
  }

  strikeFrame(realDt) {
    const I = this.inv, S = this.shot, X = I.xarg, E = I.world.effects;
    I.timeScale = 0.05;
    // Экранные следы удара живут во времени игры, а оно почти стоит: без этого кадр так и остался бы белым
    E.screenFlash *= Math.exp(-9 * realDt);
    E.impact *= Math.exp(-5 * realDt);
    E.fovKick *= Math.exp(-6 * realDt);
    this.jaw(_b);
    _a.lerpVectors(I.heroC, X.c, 0.5).lerp(_b, 0.5);
    S.pos.copy(_a).addScaledVector(this.strikeSide, 5 - this.t * 0.5).addScaledVector(UP, 0.2).addScaledVector(this.dir, -0.4);
    S.look.copy(_a);
    S.fov = 30;
    if (this.t > 1.25) this.startFall();
  }

  fallFrame() {
    const I = this.inv, S = this.shot, X = I.xarg, left = this.fallT - this.t;
    if (left > LAST_T) {
      // Глазами героя: длинный объектив ведёт падающее тело
      _a.subVectors(X.c, I.heroC);
      const d = _a.length();
      _a.divideScalar(d || 1);
      S.pos.copy(I.heroC).addScaledVector(_a, -3.2).addScaledVector(UP, 0.9).addScaledVector(this.side, 1.1);
      S.look.copy(X.c);
      S.fov = clamp(46 * 30 / Math.max(d, 1), 7, 46);
    } else {
      // С земли: он идёт на кадр
      S.pos.copy(this.camFix);
      S.look.lerpVectors(X.c, _a.copy(this.to).addScaledVector(UP, 4), 1 - clamp(left / LAST_T, 0, 1));
      S.fov = lerp(56, 20, clamp(X.pos.distanceTo(this.camFix) / 1800, 0, 1));
    }
    if (left <= 0) this.impact();
  }

  dustFrame() {
    const S = this.shot;
    S.pos.copy(this.camFix);
    S.look.copy(this.to).addScaledVector(UP, 4 + this.t * 0.8);
    S.fov = 56;
    if (this.t > 3) this.startDescend();
  }

  descendFrame() {
    const I = this.inv, S = this.shot;
    // От тела вверх: он спускается сквозь дым
    S.pos.copy(this.to).addScaledVector(this.rim, -3.4).addScaledVector(this.side, 2).addScaledVector(UP, 0.9);
    S.look.copy(I.heroC);
    S.fov = clamp(44 * 16 / Math.max(S.pos.distanceTo(I.heroC), 1), 8, 44);
  }

  walkFrame() {
    const I = this.inv, S = this.shot, P = I.player, to = this.to;
    // Идёт на камеру, у нижнего края кадра лежит генерал
    S.pos.copy(to).addScaledVector(this.rim, -3.1).addScaledVector(this.side, 0.9).addScaledVector(UP, 0.95);
    S.look.lerpVectors(this.heroStop, I.heroC, 0.75);
    S.look.y = lerp(to.y + 0.7, I.heroC.y, 0.6);
    S.fov = 36;
    if (this.t > 1.7 && P.pos.distanceTo(_a.copy(this.heroStop).setY(P.pos.y)) < 0.05) this.go('words');
  }

  wordsFrame() {
    const I = this.inv, S = this.shot, X = I.xarg, P = I.player, t = this.t;
    while (this.spoken < WORDS.length && t >= WORDS[this.spoken][0]) {
      const w = WORDS[this.spoken++];
      I.say(w[1], w[2], true);
    }
    // Приподнимается на локте, потом рука подламывается
    const up = smoothstep(0, 1.8, t), down = smoothstep(13.2, 14.6, t);
    this.tilt = lerp(lerp(LIE, PROPPED, up), LIE, down);
    X.anim.prop = up * (1 - down);
    this.placeBody();
    X.model.setRage(0.8 * (1 - smoothstep(11.8, 14.8, t)));
    headOf(X.model, X.c, _b);
    headOf(P.model, I.heroC, _c);
    _d.subVectors(_c, _b).normalize();
    if (t < 5 || (t >= 8.2 && t < 11.8)) {
      // Через плечо героя вниз, второй раз ближе
      const k = t < 5 ? 0.9 : 0.55;
      S.pos.copy(_c).addScaledVector(_d, k).addScaledVector(this.side, k * 0.6).addScaledVector(UP, 0.15);
      S.look.copy(_b);
      S.fov = t < 5 ? 34 : 28;
    } else if (t < 8.2) {
      // Снизу, его глазами
      S.pos.copy(_b).addScaledVector(_d, 0.5).addScaledVector(this.side, -0.3).addScaledVector(UP, 0.06);
      S.look.copy(_c);
      S.fov = 36;
    } else {
      // Сбоку: рука подламывается, швы гаснут
      S.pos.copy(_b).addScaledVector(this.side, 3 - (t - 11.8) * 0.06).addScaledVector(UP, 0.45).addScaledVector(this.rim, 0.5);
      S.look.copy(_b).addScaledVector(UP, -0.3).addScaledVector(this.rim, 0.25);
      S.fov = 30;
    }
    if (t > 16.6) this.startKnee();
  }

  startKnee() {
    const I = this.inv;
    I.player.landT = 6.2;
    this.camA = Math.atan2(this.side.z, this.side.x) + 0.5;
    this.pickCrane();
    I.theme.shot('victory', undefined, 0.95);
    I.fx.after(1.2, () => I.story.radio('ШТАБ: Всем постам. Цель упала. Повторяю, цель упала.', 4.5));
    this.go('knee');
  }

  kneeFrame() {
    const S = this.shot, to = this.to, a = this.camA + this.t * 0.035;
    _a.copy(to).addScaledVector(this.rim, STOP * 0.6);
    S.pos.set(_a.x + Math.cos(a) * 6.2, to.y + 1, _a.z + Math.sin(a) * 6.2);
    S.look.copy(_a).addScaledVector(UP, 0.7);
    S.fov = 38;
    if (this.t > 6) this.startCrane();
  }

  startCrane() {
    const I = this.inv, P = I.player;
    P.lockDir.copy(this.rim);
    if (!I.shipDown) I.shipLeaveT = 0.5;
    I.story.radio(I.shipDown ? 'ШТАБ: Корабль лежит в парке. Кто-нибудь его видит? …Он стоит. Повторяю, он ещё стоит.' : 'ШТАБ: Корабль уходит. Кто-нибудь его видит? …Он стоит. Повторяю, он ещё стоит.', 7);
    this.go('crane');
  }

  // Камера едет с той стороны, откуда он пришёл: огонь и дым у него за спиной. И так, чтобы по дороге не было домов
  pickCrane() {
    const I = this.inv, city = I.world.city, base = Math.atan2(this.rim.z, this.rim.x) - 0.4;
    this.craneA = base;
    for (const off of [0, 0.5, -0.5, 1, -1]) {
      let clear = true;
      for (let t = 1; clear && t <= 20; t++) clear = !city.isInside(this.cranePos(_a, I.heroC, base + off, t));
      if (clear) { this.craneA = base + off; break; }
    }
    // Осколки могли поджечь что угодно. Всё, что горит на её пути, гаснет заранее, пока она внизу и этого не видно
    const c = I.heroC, dx = Math.cos(this.craneA + 0.4), dz = Math.sin(this.craneA + 0.4);
    const inWay = (p) => {
      const x = p.x - c.x, z = p.z - c.z, along = x * dx + z * dz;
      return along > 3 && along < 190 && Math.abs(x * dz - z * dx) < 30;
    };
    for (const e of I.world.fire.emitters) if (inWay(e.pos)) e.life = 0;
    for (const s of I.fx.columns) if (inWay(s.pos)) s.t = s.life;
  }

  cranePos(out, c, a0, t) {
    const e = smoothstep(0.8, 18, t), a = a0 + t * 0.04, r = lerp(6.5, 150, e * e), h = lerp(0.4, 105, e * e);
    return out.set(c.x + Math.cos(a) * r, c.y + h, c.z + Math.sin(a) * r);
  }

  craneFrame() {
    const I = this.inv, S = this.shot, t = this.t, c = I.heroC;
    const e = smoothstep(0.8, 18, t);
    this.cranePos(S.pos, c, this.craneA, t);
    S.look.lerpVectors(c, _a.copy(c).addScaledVector(UP, 14), e);
    S.fov = lerp(40, 58, e);
    // Ре мажор в музыке приходит на 19-й секунде этого кадра: картинка уходит в чёрное вместе с ним
    if (t > 17) this.$fade?.classList.add('on');
    if (t > 20) { I.endT = 0; this.state = 'done'; }
  }
}
