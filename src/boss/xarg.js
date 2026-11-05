import * as THREE from 'three';
import { Kin, spaceK } from './kin.js';
import { EyeLaser } from '../player/laser.js';
import { PLAYER as P } from '../config.js';
import { blowQuat, followBlow, reelHit } from '../player/model.js';
import { lerp, clamp, smoothstep } from '../utils.js';

// Генерал Ксарг: тот же размер и те же способности, что у героя — удары, заряженный удар, рывок,
// лазер, удар о землю, захват, полёт на сверхскорости и серия ударов в полёте.
// Движется как герой: бегает по земле, приседает перед взлётом, тормозит корпусом, садится на колено.
// Между атаками держит режим: давит, кружит, отступает и заходит на пролёт, догоняет, идёт пешком.
// Реагирует на героя: уходит от заряда и луча. Сам открывается после своих атак — это окно для контратаки.

export const XARG_HP = 1000;
const DMG = { jab: 7, last: 9, heavy: 18, dive: 14, hurl: 16, chain: [8, 9, 10, 13] };
// По фазам: задержка замаха, шанс блока/уклонения, пауза между решениями
const TEMPO = [null,
  { windup: 0.46, guard: 0.5, think: [0.45, 1.0], strikes: 2, breakChain: 0 },
  { windup: 0.4, guard: 0.62, think: [0.3, 0.75], strikes: 3, breakChain: 0.1 },
  { windup: 0.34, guard: 0.72, think: [0.18, 0.5], strikes: 4, breakChain: 0.2 },
];

const UP = new THREE.Vector3(0, 1, 0);
const _d = new THREE.Vector3(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _p = new THREE.Vector3();
const _ls = new THREE.Vector3(), _lc = new THREE.Vector3();
const _q = new THREE.Quaternion();

const TAUNTS = [
  'Ты бьёшь, как они. С оглядкой.',
  'Это всё, чему тебя научили?',
  'Ты слишком долго жил среди хрупких.',
  'Перестань беречь их. Они тебя не сберегут.',
  'На Ксарроне такого, как ты, не взяли бы и в караул.',
];

export class Xarg extends Kin {
  constructor(inv) {
    super(inv, 'general');
    const W = inv.world;
    // Лазер героя, только бьёт по герою: подменяем цель и не трогаем звук его собственного луча
    const laserWorld = Object.create(W);
    laserWorld.boss = {
      rayHit: (origin, dir, maxDist) => {
        if (inv.story.lock) return { dist: origin.distanceTo(inv.story.lock.pos) };
        const H = inv.player;
        _lc.copy(H.pos).addScaledVector(UP, 1.0);
        _ls.subVectors(_lc, origin);
        const along = _ls.dot(dir);
        if (along < 1 || along > maxDist) return null;
        return _ls.addScaledVector(dir, -along).lengthSq() < 1.7 * 1.7 ? { dist: along } : null;
      },
      takeHit: (amount) => { if (!inv.story.lock) inv.hurtHero(amount * 0.05, null, true); },
    };
    laserWorld.audio = {
      // Звук луча слышно издалека, но вблизи он в разы тяжелее
      setLaser: (c, p) => {
        if (inv.player.lasering) return;
        const k = clamp(1 - (this.dist || 0) / 900, 0.35, 1);
        W.audio?.setLaser(c * k, p * k);
      },
      laserIgnite: () => W.audio?.laserIgnite(),
    };
    this.laser = new EyeLaser(inv.scene, laserWorld);
    this.laserAim = new THREE.Vector3(0, 0, 1);
    // Бьёт так же тяжело, как герой: длинный замах и проход всем телом
    this.punchLen = 0.72;
    this.punchHitAt = 0.2;
    this.carryDir = new THREE.Vector3(0, 0, 1);
    this.flyDir = new THREE.Vector3(0, 0, 1);

    // Свечение кулака на зарядке
    this.fist = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), new THREE.MeshBasicMaterial({
      color: new THREE.Color(5, 1.3, 0.35), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    }));
    this.fist.visible = false;
    this.fist.frustumCulled = false;
    inv.scene.add(this.fist);
    this.rage = 0;
  }

  spawnAt(at, face) {
    this.reset();
    this.hp = XARG_HP;
    this.phase = 1;
    this.state = 'wait';
    this.t = 0;
    this.place(at, face);
    this.root.visible = false;
    this.cd = { laser: 3, heavy: 2, dive: 5, grab: 6, taunt: 6, hurl: 6 };
    this.mode = null;
    this.modeT = 0;
    this.modeS = 0;
    this.reactCd = 0;
    this.burnT = 0;
    this.evadeThen = null;
    this.thinkT = 1;
    this.strafe = 1;
    this.strafeT = 1;
    this.rage = 0;
    this.guarded = 0;
    this.inRow = 0;
    this.chainN = 0;
    this.climbed = false;
    this.deadDown = false;
    this.finalHit = false;
    this.ramming = false;
    this.lieQ = null;
    this.model.setRage(0);
    this.model.setEyeGlow?.(0);
    this.fist.visible = false;
    this.laser.group.visible = false;
  }

  go(state) {
    this.state = state;
    this.t = 0;
    if (state !== 'chain' && this.blow && this.blow.f < 2) { this.blow = null; this.poseQ = null; }
    else if (state !== 'chain' && this.blow) this.poseQ = null;
  }

  get tempo() { return TEMPO[this.phase]; }

  // Открыт для удара: не блокирует и не уклоняется
  get open() { return ['stun', 'down', 'knock', 'recover', 'laser', 'heavy', 'held', 'dive', 'hurl', 'brawl', 'cut'].includes(this.state); }

  // ---------------------------------------------------------------- попадания героя
  // kind: punch | heavy | slam | ram | laser | throw | car; power 0..1
  receive(kind, power, point, dir) {
    if (!this.alive || this.state === 'wait' || this.state === 'descend') return false;
    const I = this.inv, W = this.W;
    // Сцены идут своим ходом: удар там решает другое
    if (this.state === 'scene' || this.state === 'meteor' || this.state === 'beamlock') return true;
    if (['stand', 'watch', 'approach'].includes(this.state)) {
      // Пока не вступил в бой: отбрасывает легко и презрительно
      if (this.state === 'stand' || this.state === 'approach') I.onFirstBlood(this);
      if (this.state === 'watch' && kind !== 'laser') {
        this.hitFX(point, dir, 0.4);
        this.guardK = 1;
        this.guardT = 0.35;
        I.hurtHero(4, _v.copy(dir).negate().setY(0.2).normalize().multiplyScalar(90));
        I.say('Сначала пройди их.', 1.6);
      }
      if (this.state === 'watch') return true;
    }
    const T = this.tempo;
    if (kind === 'laser') {
      const k = this.guardK > 0.3 ? 0.35 : 1;
      this.damage(power * 90 * k, point, dir, kind);
      if (this.state === 'neutral' && Math.random() < 0.02) this.startEvade(dir);
      return true;
    }
    // Последний размен: не защищается и не улетает, просто принимает и идёт дальше
    if (this.state === 'brawl') {
      this.damage(kind === 'punch' ? 26 : kind === 'heavy' ? 40 + 60 * power : 30, point, dir, kind);
      if (!this.alive) return true;
      I.fx.brawlHit(point, dir, kind === 'punch' ? 0.8 : 1);
      reelHit(this.reel, 0.95);
      this.vel.addScaledVector(dir, 16);
      return true;
    }
    const punchLike = kind === 'punch';
    const canDefend = !this.open && !I.counterT && ['neutral', 'guard', 'evade'].includes(this.state);
    if (punchLike && canDefend && Math.random() < T.guard) {
      if (Math.random() < 0.34 && this.dashCdOk()) this.startEvade(dir);
      else this.block(point, dir);
      return true;
    }
    // Заряженный удар пробивает блок; слабый — вязнет в нём
    if (kind === 'heavy' && canDefend && power < 0.35 && Math.random() < T.guard) { this.block(point, dir); return true; }

    const dmg = kind === 'punch' ? 22 : kind === 'heavy' ? 28 + 92 * power : kind === 'slam' ? 60 : kind === 'ram' ? 18 + 50 * power : kind === 'throw' ? 45 : 40;
    this.damage(dmg, point, dir, kind);
    if (!this.alive) return true;
    this.hitFX(point, dir, punchLike ? 0.6 : 1);
    const heroAir = !I.player.grounded;
    this.inRow = punchLike ? this.inRow + 1 : 3;
    const launchIt = kind !== 'punch' || heroAir || !this.grounded || this.inRow >= 3 || I.counterT > 0;
    if (launchIt) {
      this.inRow = 0;
      this.guardK = 0;
      if (!I.chain.open(this, dir, kind, power)) {
        this.chainEnd();
        this.go('knock');
        this.launch(dir, lerp(150, 900, spaceK(this.pos.y)), 0.5);
      }
    } else {
      // Короткая заминка: на земле серия из трёх ударов подбрасывает его
      this.go('stun');
      this.stunT = 0.3;
      this.vel.addScaledVector(dir, 16);
    }
    return true;
  }

  dashCdOk() { return !this.evadeCd || this.evadeCd <= 0; }

  block(point, dir) {
    const W = this.W;
    this.go('guard');
    this.guardT = 0.45;
    this.guardK = 1;
    this.guarded++;
    this.vel.addScaledVector(dir, 10);
    W.sparks.burst(point, 12, { size: [0.15, 0.5], speed: 16, life: [0.1, 0.3], color: 0xffe6c0 });
    W.effects.shockwave(point.clone(), { type: 'disc', dir: dir.clone(), radius: 2.6, life: 0.2, opacity: 0.5 });
    this.inv.fx.play('clash', { gain: 0.4, pos: point, rate: 1.25 }) || W.audio?.metal(0.35, point.clone());
    reelHit(this.reel, 0.3, 0);
    this.damage(2.5, point, dir, 'guard');
  }

  startEvade(dir, then = null) {
    this.go('evade');
    this.evadeCd = 1.6;
    this.evadeThen = then;
    this.dashT = 0.18;
    // В сторону от удара
    _d.crossVectors(dir, UP);
    if (_d.lengthSq() < 0.01) _d.set(1, 0, 0);
    _d.normalize().multiplyScalar(Math.random() < 0.5 ? -1 : 1).addScaledVector(dir, 0.3).normalize();
    this.evadeDir = (this.evadeDir || new THREE.Vector3()).copy(_d);
    this.ghostT = 0;
    this.guardK = 0;
    this.W.effects.shockwave(this.c.clone(), { type: 'disc', dir: _d.clone(), radius: 5, life: 0.25, opacity: 0.5 });
    this.W.audio?.whoosh(0.7);
  }

  damage(d, point, dir, kind) {
    if (!this.alive) return;
    this.hp -= d;
    // До последнего размена он не падает: его конец — отдельный кадр
    if (!this.inv.story.brawlOn) this.hp = Math.max(this.hp, XARG_HP * 0.12);
    this.inv.onXargHurt(d, kind);
    if (this.hp <= 0) { this.hp = 0; this.die(dir); return; }
    const ph = this.hp > XARG_HP * 2 / 3 ? 1 : this.hp > XARG_HP / 3 ? 2 : 3;
    if (ph > this.phase) {
      this.phase = ph;
      this.inv.onXargPhase(ph);
      if (ph === 3) { this.rage = 1; this.model.setRage(1); }
    }
  }

  die(dir) {
    this.lasering = false;
    this.charge = 0;
    this.fist.visible = false;
    this.model.setRage(0);
    this.releaseHero();
    this.go('dead');
    this.launch(_d.copy(dir).normalize(), lerp(220, 1200, spaceK(this.pos.y)), 99);
    this.inv.fx.finalBlow(this.c.clone(), dir.clone().normalize());
    this.inv.onXargDown();
  }

  // Самому герою: удар долетел? Рывок даёт неуязвимость, встречный удар — столкновение кулаков
  tryHit(reach) {
    const I = this.inv, H = I.player;
    const dist = this.c.distanceTo(I.heroC);
    if (dist > reach) return 'miss';
    if (H.dashT > 0) { I.onDodge(this); return 'dodge'; }
    if (H.punchT >= 0 && H.punchT < (H.punchHitAt ?? P.punchHitTime) + 0.09) { I.clash(this); return 'clash'; }
    return 'hit';
  }

  // ---------------------------------------------------------------- решения
  neutral(dt) {
    const I = this.inv, H = I.player, sk = spaceK(this.pos.y);
    const d = this.dist;
    const T = this.tempo;
    this.modeT -= dt;
    this.modeS += dt;
    this.strafeT -= dt;
    if (this.strafeT <= 0) { this.strafe = Math.random() < 0.5 ? -1 : 1; this.strafeT = 0.8 + Math.random() * 1.6; }
    if (this.cd.taunt <= 0) { this.cd.taunt = 14 + Math.random() * 10; I.say(TAUNTS[Math.floor(Math.random() * TAUNTS.length)], 2.4); }
    if (this.reactHero(dt)) return;
    if (!this.mode || this.modeT <= 0) {
      if (this.mode === 'backoff') this.afterBackoff();
      else this.pickMode();
      if (this.state !== 'neutral') return;
    }
    // Взлетает так же, как герой: короткий присед и толчок
    if (this.grounded && this.mode !== 'ground' && this.takeoffT <= 0) this.takeoffT = 0.14;

    const top = lerp(180, 2400, sk);
    _v.crossVectors(this.aim, UP);
    if (_v.lengthSq() < 0.01) _v.set(1, 0, 0);
    _v.normalize();
    let rate = 5;
    switch (this.mode) {
      case 'circle':
        // Кружит на дистанции и ищет момент
        _d.copy(_v).multiplyScalar(this.strafe * (30 + this.phase * 5)).addScaledVector(this.aim, clamp((d - 24) * 2.2, -30, top * 0.5));
        _d.y += Math.sin(this.modeS * 1.7) * 5;
        rate = 3.5;
        if (d > 70) this.setMode('press');
        break;
      case 'backoff':
        // Разворачивается и уходит, чтобы зайти на новый удар с разгона
        this.faceTarget = false;
        _d.copy(this.aim).multiplyScalar(-lerp(150, 900, sk)).addScaledVector(UP, 18).addScaledVector(_v, this.strafe * 30);
        rate = 6;
        if (d > 75) this.modeT = 0;
        break;
      case 'flyby':
        if (this.modeS < this.flyTime) {
          this.faceTarget = false;
          this.boosting = true;
          _d.copy(this.flyDir).multiplyScalar(this.flySpeed);
          rate = 12;
        } else {
          // Тормозит корпусом за спиной героя и сразу бьёт с разворота
          this.braking = true;
          _d.set(0, 0, 0);
          rate = 7;
          if (this.vel.length() < 60 || this.modeS > this.flyTime + 0.45) {
            this.setMode('press');
            this.startCombo();
            this.strikeT *= 0.7;
            return;
          }
        }
        break;
      case 'chase': {
        // Герой удирает: догоняет на форсаже
        const v = H.speed * 1.08 + clamp((d - 10) * 3, 0, top);
        _d.copy(this.aim).multiplyScalar(v);
        this.boosting = v > 250;
        rate = 6;
        if (d < 26 || H.speed < 120) this.setMode('press');
        break;
      }
      case 'ground': {
        const low = H.grounded || H.pos.y - this.groundY < 3;
        if (!low) { this.setMode('press'); _d.copy(this.aim).multiplyScalar(30); break; }
        if (this.grounded) {
          // Идёт на него пешком: бегом издалека, вблизи — шагом вбок
          const run = this.landT > 0.25 ? 0 : d > 40 ? P.sprintSpeed : d > 7 ? P.runSpeed * 1.4 : 0;
          _d.copy(this.aimFlat).multiplyScalar(run).addScaledVector(_v, d < 14 ? this.strafe * 4 : 0);
          _d.y = 0;
          rate = 7;
        } else {
          // Снижается рядом с ним
          _d.copy(H.pos).addScaledVector(this.aimFlat, -12).sub(this.pos).multiplyScalar(2.2).clampLength(0, 110);
          if (this.pos.y - this.groundY < 1.4) this.touchDown();
        }
        break;
      }
      default: {
        // Давит: сближается на дистанцию удара, смещаясь вбок
        const want = d > 40 ? 3 : 6;
        const closing = clamp((d - want) * 3.4, -top * 0.4, top) + (d > 150 ? H.speed * 1.08 : 0);
        _d.copy(this.aim).multiplyScalar(closing).addScaledVector(_v, d < 60 ? this.strafe * 14 : 0);
        this.boosting = closing > 250;
      }
    }
    this.vel.lerp(_d, 1 - Math.exp(-rate * dt));
    if (this.grounded) this.vel.y = 0;

    this.thinkT -= dt;
    if (this.thinkT > 0) return;
    this.thinkT = lerp(T.think[0], T.think[1], Math.random());
    this.decide();
  }

  setMode(m) {
    this.mode = m;
    this.modeS = 0;
    const r = Math.random();
    this.modeT = m === 'press' ? 1.4 + r * 1.2 : m === 'circle' ? 1 + r * 1.4 : m === 'backoff' ? 0.7 + r * 0.35 : m === 'ground' ? 2.5 + r * 2 : 3;
    // Кружит не просто так: сначала выбирает момент
    if (m === 'circle') this.thinkT = Math.max(this.thinkT, 0.6 + r * 0.8);
  }

  // Как двигаться дальше: смотрит, что делает герой
  pickMode() {
    const H = this.inv.player, d = this.dist, r = Math.random();
    const low = H.grounded || H.pos.y - this.groundY < 3;
    if (low && d < 220 && H.speed < 60) this.setMode('ground');
    else if (H.speed > 170 && d > 40) this.setMode('chase');
    else if (d > 110) this.setMode('press');
    else this.setMode(r < 0.36 ? 'press' : r < 0.68 ? 'circle' : 'backoff');
  }

  // Отошёл: заряд, луч или заход на пролёт со сверхскорости
  afterBackoff() {
    const I = this.inv, d = this.dist, r = Math.random();
    this.setMode('press');
    if (r < 0.33 && this.cd.heavy <= 0) { this.startHeavy(); return; }
    if (r < 0.55 && this.cd.laser <= 0) { this.startLaser(); return; }
    this.flySpeed = lerp(340, 2800, spaceK(this.pos.y));
    _v.crossVectors(this.aim, UP);
    if (_v.lengthSq() < 0.01) _v.set(1, 0, 0);
    _v.normalize();
    this.flyDir.copy(I.heroC).addScaledVector(_v, this.strafe * 9).addScaledVector(UP, 3).sub(this.c).normalize();
    this.flyTime = clamp(d / this.flySpeed + 0.3, 0.35, 1.1);
    this.setMode('flyby');
    I.fx.play('flyby', { pos: this.c });
    this.W.effects.shockwave(this.c.clone(), { type: 'disc', dir: this.flyDir.clone(), radius: 9, life: 0.3, opacity: 0.6 });
  }

  // Какой приём сейчас
  decide() {
    const H = this.inv.player, d = this.dist, r = Math.random();
    if (this.mode === 'backoff' || this.mode === 'flyby') return;
    if (d > 140) {
      if (this.cd.laser <= 0 && r < 0.4) this.startLaser();
      return;
    }
    if (this.mode === 'circle' && r < 0.35) return;
    // Бежит к нему: до удара ещё далеко
    if (this.mode === 'ground' && d > 14 && r > 0.25) return;
    if (this.cd.hurl <= 0 && d > 34 && r < 0.3 && this.startHurl()) return;
    if (d > 26) {
      if (H.grounded && this.cd.dive <= 0 && r < 0.3) { this.startDive(); return; }
      if (this.cd.laser <= 0 && r < 0.5) { this.startLaser(); return; }
      if (this.cd.heavy <= 0 && r < 0.7) { this.startHeavy(); return; }
      this.startCombo();
      return;
    }
    if (this.phase >= 2 && this.cd.grab <= 0 && r < 0.2) { this.startGrab(); return; }
    if (this.cd.heavy <= 0 && r < 0.42) { this.startHeavy(); return; }
    // Финт: рывок вбок и удар оттуда
    if (this.phase >= 2 && r < 0.52 && this.dashCdOk()) { this.startEvade(this.aim); return; }
    this.startCombo();
  }

  // Что он успевает заметить: заряд, луч, удар сверху, рывок
  reactHero(dt) {
    const I = this.inv, H = I.player, d = this.dist;
    this.reactCd -= dt;
    if (this.reactCd > 0) return false;
    if (H.charge > P.heavyMaxCharge * 0.45 && d < 30) {
      this.reactCd = 0.8;
      if (Math.random() < 0.55 && this.dashCdOk()) { this.startEvade(this.aim); return true; }
      if (this.cd.heavy <= 0) { this.startHeavy(); return true; }
      return false;
    }
    if (H.lasering && this.dashCdOk()) {
      I.camera.getWorldDirection(_v2);
      if (_v2.dot(_p.subVectors(this.c, I.heroC).normalize()) > 0.96) {
        this.reactCd = 1.2;
        // Со второй фазы может не уйти, а ответить лучом в луч
        if (this.phase >= 2 && Math.random() < 0.5 && this.cd.laser <= 3) { this.startLaser(); return true; }
        // Луч смотрит прямо на него: уходит вбок и отвечает своим
        this.startEvade(this.aim, this.cd.laser <= 2 ? 'laser' : null);
        return true;
      }
    }
    if (H.slamming && d < 90 && this.dashCdOk()) {
      this.reactCd = 1;
      this.startEvade(this.aim);
      return true;
    }
    if (H.dashT > 0 && d < 12 && this.phase >= 2 && Math.random() < 0.4) {
      this.reactCd = 0.8;
      this.startCombo();
      this.strikeT *= 0.6;
      return true;
    }
    return false;
  }

  // Встал на ноги: тяжело, если падал быстро
  touchDown() {
    const v = this.vel.length();
    this.grounded = true;
    this.pos.y = this.groundY;
    this.vel.y = 0;
    if (v > 60) {
      this.landT = 0.7;
      this.crashFX(this.pos.clone(), 0.25);
    } else {
      this.dipK = 0.6;
      this.dipT = 0.22;
      this.W.dust.burst(this.pos.clone().setY(this.groundY + 0.2), 6, { size: [0.8, 2.2], speed: 4, life: [0.4, 1], flat: true });
    }
  }

  startCombo() {
    this.go('combo');
    this.strikes = this.tempo.strikes - (Math.random() < 0.35 ? 1 : 0);
    this.strikeT = this.tempo.windup;
    this.punched = false;
  }

  combo(dt) {
    const I = this.inv, T = this.tempo;
    this.strikeT -= dt;
    const d = this.dist;
    // Подлетает так, чтобы оказаться рядом к моменту удара
    if (d > 2.2) {
      const need = Math.max(30, (d - 2.0) / Math.max(this.strikeT, 0.05));
      _d.copy(this.aim).multiplyScalar(Math.min(need, lerp(420, 3000, spaceK(this.pos.y))));
      this.vel.lerp(_d, 1 - Math.exp(-14 * dt));
      this.grounded = this.grounded && d < 3 && I.player.grounded;
    } else this.vel.multiplyScalar(Math.exp(-10 * dt));
    if (!this.punched && this.strikeT < this.punchHitAt) { this.startPunch(0); this.punched = true; I.fx.play('preHit', { gain: 0.4, pos: this.c, rate: 2.2 }) || this.W.audio?.whoosh(0.3); }
    if (this.strikeT > 0) return;
    const last = this.strikes <= 1;
    const res = this.tryHit(3.6);
    if (res === 'hit') {
      const kn = _v.copy(this.aim).setY(Math.max(this.aim.y, last ? 0.22 : 0.05)).normalize();
      I.hurtHero(last ? DMG.last : DMG.jab, kn.clone().multiplyScalar(last ? 130 : 24), false, 0.14);
      this.hitFX(_p.copy(I.heroC), this.aim, last ? 0.8 : 0.45);
      if (last && this.phase >= 2 && Math.random() < 0.4) { this.startChain(); return; }
    }
    if (res === 'dodge' || res === 'clash') return;
    this.strikes--;
    if (this.strikes <= 0) {
      this.go('recover');
      this.recoverT = res === 'hit' ? 0.3 : 0.62;
      return;
    }
    this.strikeT = T.windup * 0.8;
    this.punched = false;
  }

  startHeavy() {
    this.go('heavy');
    this.cd.heavy = 6 - this.phase;
    this.chargeT = 0.95 - this.phase * 0.1;
    this.rush = false;
    this.W.audio?.tone({ dur: this.chargeT, from: 60, to: 180, gain: 0.14, type: 'sawtooth' });
  }

  heavy(dt) {
    const I = this.inv, W = this.W;
    const d = this.dist;
    if (!this.rush) {
      this.charge = Math.min(P.heavyMaxCharge, (this.t / this.chargeT) * P.heavyMaxCharge);
      this.vel.multiplyScalar(Math.exp(-5 * dt));
      if (this.t >= this.chargeT) {
        this.rush = true;
        this.rushT = 0;
        W.effects.shockwave(this.c.clone(), { type: 'disc', dir: this.aim.clone(), radius: 8, life: 0.3, opacity: 0.6 });
        I.fx.play('rush', { pos: this.c }) || W.audio?.whoosh(1);
        this.charge = 0;
        this.startPunch(1);
      }
      return;
    }
    this.rushT += dt;
    this.grounded = false;
    this.vel.copy(this.aim).multiplyScalar(Math.max(110, Math.min(d / 0.14, lerp(520, 4200, spaceK(this.pos.y)))));
    if (d > 4.5 && this.rushT < 0.5) return;
    this.punchT = Math.max(this.punchT, this.punchHitAt);
    const res = this.tryHit(5.5);
    const at = I.heroC.clone();
    if (res === 'hit') {
      const dir = _v.copy(this.aim).setY(Math.max(this.aim.y, 0.18)).normalize().clone();
      I.hurtHero(DMG.heavy, dir.clone().multiplyScalar(lerp(270, 1500, spaceK(this.pos.y))), false, 0);
      this.bigHitFX(at, dir, 1);
      if (!I.player.grounded && this.phase >= 2) { this.startChain(); return; }
    } else if (res === 'miss') {
      // Промах: кулак уходит в пустоту и бьёт по всему, что рядом
      const c = _p.copy(this.c).addScaledVector(this.aim, 5).clone();
      if (c.y < 700) W.city.damageRadius(c, 14, 200, 50, this.aim);
      W.effects.shockwave(c, { type: 'sphere', radius: 12, life: 0.4, opacity: 0.35 });
      I.fx.play('slam', { gain: 0.5, pos: c }) || W.audio?.boom(0.4, c);
    }
    if (res === 'dodge' || res === 'clash') return;
    this.vel.multiplyScalar(0.1);
    this.go('recover');
    this.recoverT = res === 'hit' ? 0.5 : 1.05;
  }

  startLaser() {
    this.go('laser');
    this.cd.laser = 11 - this.phase * 2;
    this.laserAim.copy(this.aim);
    this.laserDur = 2.3 + this.phase * 0.5;
    this.sweepSide = Math.random() < 0.5 ? -1 : 1;
    this.burnT = 0;
  }

  laserTick(dt) {
    const I = this.inv;
    this.lasering = true;
    this.vel.multiplyScalar(Math.exp(-4 * dt));
    if (this.grounded) this.vel.y = 0;
    // Луч отстаёт от цели: уйти с него можно, стоять на месте нельзя
    const rate = 1.8 + this.phase * 0.6;
    _d.copy(this.aim);
    // Со второй фазы ведёт лучом по дуге через всё вокруг героя: режет дома
    if (this.phase >= 2 && this.t > 0.85) {
      _d.applyAxisAngle(UP, Math.cos(((this.t - 0.85) / (this.laserDur - 0.85)) * Math.PI) * 0.6 * this.sweepSide);
    }
    this.laserAim.lerp(_d, 1 - Math.exp(-rate * dt)).normalize();
    this.burnT -= dt;
    if (this.burnT <= 0 && this.laser.lit && this.laser.power > 0.4 && this.laser.hit.distanceTo(this.c) < 1190) {
      this.burnT = 0.2;
      I.fx.burn(this.laser.hit.clone(), this.laserAim);
    }
    if (this.t >= this.laserDur) {
      this.lasering = false;
      this.go('recover');
      this.recoverT = 0.55;
    }
  }

  startDive() {
    this.go('dive');
    this.cd.dive = 12 - this.phase * 2;
    this.grounded = false;
    this.diving = false;
  }

  dive(dt) {
    const I = this.inv, W = this.W;
    if (!this.diving) {
      // Набирает высоту над героем
      _d.copy(I.heroC);
      _d.y += 62;
      _d.sub(this.c);
      const l = _d.length();
      this.vel.lerp(_d.divideScalar(l || 1).multiplyScalar(170), 1 - Math.exp(-7 * dt));
      if (l < 10 || this.t > 1.1) {
        this.diving = true;
        this.slamming = true;
        this.vel.copy(I.heroC).addScaledVector(I.player.vel, 0.2).sub(this.c).normalize().multiplyScalar(P.slamSpeed * 1.2);
        W.audio?.whoosh(1);
      }
      return;
    }
    if (this.dist < 4.5 && !I.player.grounded) this.slamHit(this.c.clone());
    else if (this.t > 5) { this.slamming = false; this.go('recover'); this.recoverT = 0.4; }
  }

  slamHit(point) {
    const I = this.inv, W = this.W;
    this.slamming = false;
    this.diving = false;
    this.vel.set(0, 0, 0);
    if (point.y < 700) W.city.damageRadius(point, 26, 320, 60);
    this.crashFX(point, 0.9);
    const h = I.heroC, d = h.distanceTo(point);
    if (d < 24) {
      const k = 1 - d / 24;
      const dir = _v.subVectors(h, point).setY(4).normalize().clone();
      I.hurtHero(DMG.dive * (0.45 + 0.55 * k), dir.multiplyScalar(60 + 120 * k), false, 0);
    }
    this.grounded = point.y <= this.groundY + 2;
    this.landT = 0.95;
    this.go('recover');
    this.recoverT = 0.95;
  }

  startGrab() {
    this.go('grab');
    this.cd.grab = 13 - this.phase * 2;
  }

  grab(dt) {
    const I = this.inv, H = I.player;
    this.anim.lift = Math.min(0.75, this.t * 3);
    if (this.t < 0.32) { this.vel.multiplyScalar(Math.exp(-5 * dt)); return; }
    const d = this.dist;
    this.grounded = false;
    this.vel.copy(this.aim).multiplyScalar(Math.max(60, Math.min(d / 0.1, 520)));
    if (d < 2.7) {
      if (H.dashT > 0) { I.onDodge(this); return; }
      this.anim.lift = 0;
      this.beginCarry(this.pos.y < 500 && Math.random() < 0.6 ? 'ram' : 'up');
      I.hurtHero(3, null, false, 0);
      I.fx.thud(0.7);
      return;
    }
    if (this.t > 0.85) { this.anim.lift = 0; this.go('recover'); this.recoverT = 0.7; }
  }

  // Герой пойман: ram — тащит его перед собой к центру города сквозь дома, up — уносит вверх
  beginCarry(mode) {
    const I = this.inv, H = I.player;
    H.captured = this;
    H.punchT = -1;
    H.vel.set(0, 0, 0);
    H.grounded = false;
    H.falling = false;
    this.grounded = false;
    this.go('carry');
    this.struggleN = 0;
    this.carryMode = mode;
    if (mode === 'ram') {
      const r = Math.hypot(this.pos.x, this.pos.z);
      if (r < 400) this.carryDir.copy(this.aimFlat);
      else this.carryDir.set(-this.pos.x, 0, -this.pos.z).normalize();
      this.carryY = clamp(this.pos.y, 26, 64);
      this.carryT = clamp(r / 340, 1.6, 3.4);
    } else this.carryT = 1.9;
    I.sayOnce('Дёргайся. Это всё, что тебе осталось.', 2.6);
  }

  carry(dt) {
    const I = this.inv, H = I.player;
    this.carryT -= dt;
    this.anim.lift = 1;
    const sk = spaceK(this.pos.y);
    this.boosting = true;
    if (this.carryMode === 'ram') {
      // Перед собой, на вытянутых руках: дома пробивает героем
      this.smashed = 0;
      _d.copy(this.carryDir);
      _d.y = clamp((this.carryY - this.pos.y) * 0.03, -0.5, 0.5);
      this.vel.lerp(_d.normalize().multiplyScalar(340), 1 - Math.exp(-5 * dt));
      H.pos.copy(this.pos).addScaledVector(_p.copy(this.vel).normalize(), 2.6);
    } else {
      _d.set(0, 1, 0);
      this.vel.lerp(_d.multiplyScalar(lerp(190, 1200, sk)), 1 - Math.exp(-4 * dt));
      // Над головой
      H.pos.copy(this.pos).addScaledVector(UP, 2.0);
    }
    H.vel.copy(this.vel);
    if (this.carryT > 0) return;
    this.releaseHero();
    this.anim.lift = 0;
    this.boosting = false;
    // Вниз, в город; протащив по городу — вперёд, в следующие дома
    const dir = this.carryMode === 'ram'
      ? _v.copy(this.carryDir).multiplyScalar(0.9).setY(-0.3).normalize().clone()
      : _v.copy(this.facing).multiplyScalar(0.55).setY(-1).normalize().clone();
    I.hurtHero(DMG.hurl, dir.clone().multiplyScalar(lerp(420, 1700, sk)), false, 0);
    this.bigHitFX(I.heroC.clone(), dir, 0.9);
    this.startPunch(1);
    this.go('recover');
    this.recoverT = 0.5;
  }

  // Рывки вырывающегося героя (см. Player.update)
  struggle() {
    if (this.state !== 'carry') return;
    this.struggleN++;
    const W = this.W;
    W.sparks.burst(this.inv.heroC, 5, { size: [0.15, 0.4], speed: 9, life: [0.1, 0.25], color: 0xffe2a8 });
    if (this.struggleN < 7) return;
    this.releaseHero();
    this.anim.lift = 0;
    this.go('stun');
    this.stunT = 1.0;
    const dir = _v.copy(this.aim).normalize();
    this.vel.copy(dir).multiplyScalar(-36);
    this.inv.player.vel.copy(dir).multiplyScalar(18);
    W.effects.shockwave(this.c.clone(), { type: 'sphere', radius: 8, life: 0.35, opacity: 0.45 });
    W.effects.impactFX(0.6, null, 0.1, 8);
    this.inv.fx.play('clash', { gain: 0.7 }) || W.audio?.boom(0.4);
  }

  releaseHero() {
    const H = this.inv.player;
    if (H.captured === this) H.captured = null;
    this.anim.lift = 0;
  }

  // Каждое здание на пути бьёт по герою, которого он тащит
  onPierce() {
    if (this.state === 'carry') this.inv.hurtHero(3, null, false, 0);
  }

  // Удар с разгона в начале дуэли: героя уносит с окраины в центр города
  startTackle() {
    const H = this.inv.player;
    if (Math.hypot(H.pos.x, H.pos.z) < 450 || H.pos.y > 600) return false;
    this.go('tackle');
    this.grounded = false;
    this.tackled = false;
    this.inv.fx.cineFor(1.5);
    return true;
  }

  tackle(dt) {
    const I = this.inv, H = I.player, W = this.W, d = this.dist;
    this.anim.lift = Math.min(0.75, this.t * 3);
    if (this.t < 0.35) {
      this.vel.copy(this.aim).multiplyScalar(-30);
      return;
    }
    if (!this.tackled) {
      this.tackled = true;
      W.effects.shockwave(this.c.clone(), { type: 'disc', dir: this.aim.clone(), radius: 12, life: 0.35, opacity: 0.7 });
      I.fx.play('rush', { pos: this.c }) || W.audio?.whoosh(1);
    }
    this.boosting = true;
    this.vel.copy(this.aim).multiplyScalar(Math.max(240, Math.min(d / 0.1, 900)));
    if (d < 3.2) {
      if (H.dashT > 0) { I.onDodge(this); return; }
      this.beginCarry('ram');
      I.fx.hit(I.heroC.clone(), this.aim.clone(), 1);
      I.hurtHero(6, null, false, 0);
      I.fx.cineFor(3.4);
      return;
    }
    if (this.t > 2.5) {
      this.vel.multiplyScalar(0.3);
      this.go('neutral');
    }
  }

  // Вырывает кусок здания или земли и бросает на упреждение. Рядом нет ни того, ни другого — не бросает
  startHurl() {
    if (this.pos.y > 800) return false;
    if (this.pos.y - this.groundY > 40 && !this.W.city.sphereQuery(this.c, 46, this.hits).length) return false;
    this.go('hurl');
    this.cd.hurl = 13 - this.phase * 2;
    this.slabUp = false;
    return true;
  }

  hurl(dt) {
    const fx = this.inv.fx, W = this.W;
    this.vel.multiplyScalar(Math.exp(-6 * dt));
    this.anim.lift = Math.min(1, this.t * 3.4);
    if (!this.slabUp && this.t > 0.2) {
      this.slabUp = true;
      const near = W.city.sphereQuery(this.c, 46, this.hits);
      if (near.length) {
        W.city.closestPoint(near[0], this.c, _p);
        W.city.damageRadius(_p.clone(), 6, 260, 16);
      } else {
        _p.copy(this.pos).setY(this.groundY);
        W.effects.crater(_p.clone(), 6);
      }
      fx.rip(_p.clone());
      fx.slab.lift(this);
    }
    if (this.t > 0.72) {
      fx.slab.hurl(280);
      this.anim.lift = 0;
      this.startPunch(1);
      this.go('recover');
      this.recoverT = 0.45;
    }
  }

  bigHitFX(point, dir, k) {
    this.inv.fx.hit(point.clone(), dir.clone().normalize(), k);
  }

  // ---------------------------------------------------------------- его серия ударов по герою
  // Герой отлетает, генерал догоняет его на сверхскорости. Ударить в момент касания — перехват.
  startChain() {
    this.go('chain');
    this.chainN = 0;
    this.chainPause = 0.32;
    this.chainStep = 'pause';
  }

  // Те же кадры, что у серии героя: рывок, долгий замах в замедлении, кулак, стоп-кадр.
  // На замахе есть время ответить: рывок уводит, встречный удар разбивает серию о кулак
  chain(dt) {
    const I = this.inv, H = I.player, d = this.dist, rdt = I.realDt;
    this.grounded = false;
    if (this.chainStep === 'pause') {
      this.chainPause -= dt;
      this.vel.multiplyScalar(Math.exp(-6 * dt));
      if (this.chainPause <= 0) {
        this.chainStep = 'rush';
        this.rushLeft = Math.max(0.2, Math.min(0.4, d / 1100));
        this.W.effects.shockwave(this.c.clone(), { type: 'disc', dir: this.aim.clone(), radius: 12, life: 0.4, opacity: 0.8 });
        I.fx.play('rush') || this.W.audio?.whoosh(1);
        I.theme.duck(0.35);
      }
      return;
    }
    if (this.chainStep === 'rush') {
      this.rushLeft -= dt;
      this.boosting = true;
      this.vel.copy(this.aim).multiplyScalar(Math.max(0, d - 9) / Math.max(this.rushLeft, 0.03));
      if (d > 10 && this.rushLeft > 0) return;
      this.chainStep = 'coil';
      this.boosting = false;
      this.coilLeft = this.coilAll = 0.46;
      this.blow = { side: this.chainN % 2 ? 'L' : 'R', f: 0, k: 0, pitch: 0 };
      this.poseQ = this.quat.clone();
      I.timeScale = 0.3;
      I.fx.play('preHit', { rate: 0.62 / 0.56 });
      I.theme.duck(0.65);
      return;
    }
    const ts = Math.max(I.timeScale, 0.05);
    if (this.chainStep === 'coil') {
      this.coilLeft -= rdt;
      const b = this.blow;
      b.k = Math.min(1, b.k + rdt / 0.1);
      b.f = clamp(1 - this.coilLeft / this.coilAll, 0, 1);
      this.poseQ.slerp(blowQuat(_q, this.aim, -0.26), 1 - Math.exp(-12 * rdt));
      this.vel.copy(this.aim).multiplyScalar(Math.max(0, d - 2.5) / (Math.max(this.coilLeft, 0.02) * ts));
      if (this.coilLeft <= 0) { this.chainStep = 'drive'; this.coilLeft = 0.11; I.timeScale = 0.4; }
      return;
    }
    this.coilLeft -= rdt;
    this.blow.f = 1 + clamp(1 - this.coilLeft / 0.11, 0, 1);
    this.poseQ.slerp(blowQuat(_q, this.aim, 0.42), 1 - Math.exp(-22 * rdt));
    this.vel.copy(this.aim).multiplyScalar(Math.max(0, d - 1.35) / (Math.max(this.coilLeft, 0.02) * ts));
    if (this.coilLeft > 0) return;
    // Касание
    this.vel.multiplyScalar(0.05);
    if (H.dashT > 0) { this.chainEnd(); I.onDodge(this); return; }
    if (H.punchT >= 0 && H.punchT < (H.punchHitAt ?? P.punchHitTime) + 0.16) { this.chainEnd(); I.clash(this); return; }
    const n = this.chainN++;
    // Новое направление каждый раз; последний — вниз, в землю
    const lastHit = n >= DMG.chain.length - 1;
    _v.copy(this.aim);
    if (lastHit) _v.set(this.aim.x * 0.4, -1, this.aim.z * 0.4).normalize();
    else {
      _v2.crossVectors(this.aim, UP).normalize().multiplyScalar((n % 2 ? -1 : 1) * 0.55);
      _v.add(_v2).addScaledVector(UP, 0.35).normalize();
    }
    const sk = spaceK(this.pos.y);
    I.timeScale = 1;
    reelHit(H.reel, lastHit ? 1.3 : 1.05, n % 3);
    const kick = _v.clone();
    I.hurtHero(DMG.chain[n], kick.clone().multiplyScalar(lerp(lastHit ? 620 : 340, 2600, sk)), false, 0);
    I.fx.chainHit(I.heroC.clone(), kick, 2 + n, lastHit, I.heroBody);
    I.fx.chainRelease(I.heroC, kick, 2 + n, lastHit, I.heroBody);
    I.slowFor(0.22, 0.42);
    if (lastHit || !I.heroAlive) { this.chainEnd(); return; }
    this.chainPause = 0.5;
    this.chainStep = 'pause';
  }

  chainEnd() {
    this.boosting = false;
    if (this.state === 'chain') {
      if (this.chainStep === 'coil' || this.chainStep === 'drive') { this.inv.timeScale = 1; this.blow = null; this.poseQ = null; }
      this.chainStep = null;
      this.go('recover');
      this.recoverT = 0.7;
    }
  }

  // ---------------------------------------------------------------- подъём: зовёт бой наверх
  startClimb() {
    if (this.climbed) return false;
    this.climbed = true;
    this.go('climb');
    this.grounded = false;
    this.lasering = false;
    this.charge = 0;
    this.climbY = Math.max(36000, this.pos.y + 20000);
    return true;
  }

  climb(dt) {
    const I = this.inv, H = I.player;
    const sk = spaceK(this.pos.y);
    const above = this.pos.y >= this.climbY - 200;
    this.boosting = !above;
    this.faceTarget = above;
    if (!above) {
      _d.set(0, 1, 0);
      this.vel.lerp(_d.multiplyScalar(lerp(1500, 7000, sk)), 1 - Math.exp(-2 * dt));
      this.grounded = false;
    } else {
      this.vel.multiplyScalar(Math.exp(-3 * dt));
      if (this.dist < 800) { this.go('neutral'); this.thinkT = 0.4; return; }
    }
    // Не полетел следом: падает на него сам, с самого верха
    if (this.t > 16) I.story.startMeteor();
    void H;
  }

  // ---------------------------------------------------------------- последний размен
  // Идёт на дистанцию руки сквозь удары и бьёт. Встречный удар гасит его кулак, рывок уводит от него
  startBrawl() {
    this.chainEnd();
    this.lasering = false;
    this.charge = 0;
    this.guardK = 0;
    this.knock = 0;
    this.go('brawl');
    this.swingT = 0.8;
    this.swung = false;
    this.grounded = false;
  }

  brawl(dt) {
    const I = this.inv, H = I.player, d = this.dist;
    _d.copy(this.aim).multiplyScalar(clamp((d - 2.6) * 5, -20, lerp(260, 1800, spaceK(this.pos.y))));
    this.vel.lerp(_d, 1 - Math.exp(-8 * dt));
    if (d > 3) this.grounded = false;
    this.swingT -= dt;
    if (!this.swung && this.swingT < this.punchHitAt) {
      this.startPunch(0);
      this.swung = true;
      I.fx.play('preHit', { gain: 0.7, rate: 1.8 });
    }
    if (this.swingT > 0) return;
    this.swingT = 0.6 + Math.random() * 0.25;
    this.swung = false;
    if (d > 4) return;
    if (H.dashT > 0) { I.slowFor(0.3, 0.25); return; }
    if (H.punchT >= 0 && H.punchT < (H.punchHitAt ?? P.punchHitTime) + 0.1) {
      I.fx.clash(_p.lerpVectors(this.c, I.heroC, 0.5).clone(), this.aim.clone());
      I.slowFor(0.35, 0.22);
      return;
    }
    I.hurtHero(10, null, false, 0);
    H.vel.addScaledVector(this.aim, 20);
    I.fx.brawlHit(I.heroC.clone(), this.aim.clone(), 1);
  }

  onCrash(point) {
    if (this.state === 'dead') { this.deadDown = true; return; }
    if (this.inv.chain.kin === this) this.inv.chain.onTargetCrash();
    this.grounded = point.y <= this.groundY + 2;
    this.go('down');
    // После финального удара серии лежит дольше: это окно игрока
    this.downT = this.finalHit ? 2.6 : 1.25 - this.phase * 0.15;
    this.finalHit = false;
    this.landT = this.downT;
  }

  touchGround(impact) {
    if (this.slamming) { this.slamHit(this.pos.clone()); return; }
    if (this.knock > 0 && impact > 60) { this.crash(this.pos.clone(), impact); return; }
    if (this.state === 'dead') { this.grounded = true; return; }
    if (this.state === 'descend' && impact > 5) { this.grounded = true; return; }
  }

  // ---------------------------------------------------------------- кадр
  update(dt, hero, camPos) {
    if (this.state === 'wait') return;
    const I = this.inv;
    this.t += dt;
    if (hero.captured === this && this.state !== 'carry') this.releaseHero();
    for (const k in this.cd) this.cd[k] -= dt;
    if (this.evadeCd > 0) this.evadeCd -= dt;
    this.dist = this.lookAtPoint(I.heroC);
    followBlow(this, I.realDt || dt);
    this.faceTarget = true;
    this.boosting = false;
    this.braking = false;
    if (this.guardT > 0) { this.guardT -= dt; if (this.guardT <= 0) this.guardK = 0; }
    if (this.dashT > 0) this.dashT -= dt;
    // Конец приседа: толчок ногами с пылью
    if (this.takeoffT > 0) {
      this.takeoffT -= dt;
      if (this.takeoffT <= 0) {
        this.takeoffT = 0;
        if (this.grounded) {
          this.grounded = false;
          this.vel.y = Math.max(this.vel.y, 28);
          this.W.dust.burst(this.pos.clone().setY(this.groundY + 0.2), 14, { size: [1, 3.4], speed: 9, life: [0.5, 1.3], flat: true });
          this.W.audio?.whoosh(0.4);
        }
      }
    }

    switch (this.state) {
      case 'stand': this.vel.set(0, 0, 0); break;
      case 'descend': {
        // Спускается по колонне последним: медленно, не глядя под ноги
        const h = this.pos.y - this.slotY;
        this.vel.set((this.slot.x - this.pos.x) * 1.5, -Math.max(14, Math.min(170, h * 0.9)), (this.slot.z - this.pos.z) * 1.5);
        this.grounded = false;
        if (h < 0.6) {
          this.pos.copy(this.slot);
          this.vel.set(0, 0, 0);
          this.grounded = true;
          this.landT = 1.35;
          this.crashFX(this.pos.clone(), 0.42);
          this.go('stand');
        }
        break;
      }
      case 'approach': {
        // Герой не пришёл: летит к нему сам, поверх домов
        _d.copy(this.aim).multiplyScalar(clamp((this.dist - 14) * 2, 0, 260));
        if (this.dist > 70) _d.y = clamp(this.inv.player.pos.y + 120 - this.pos.y, 0, 90);
        this.vel.lerp(_d, 1 - Math.exp(-3 * dt));
        this.grounded = false;
        this.boosting = this.dist > 80;
        break;
      }
      case 'watch': {
        // Смотрит с высоты, как дерётся десант
        _d.copy(this.watchAt).sub(this.pos);
        this.vel.copy(_d).multiplyScalar(1.2).clampLength(0, 90);
        this.grounded = false;
        break;
      }
      case 'neutral': this.neutral(dt); break;
      case 'combo': this.combo(dt); break;
      case 'heavy': this.heavy(dt); break;
      case 'laser': this.laserTick(dt); break;
      case 'dive': this.dive(dt); break;
      case 'grab': this.grab(dt); break;
      case 'carry': this.carry(dt); break;
      case 'tackle': this.tackle(dt); break;
      case 'hurl': this.hurl(dt); break;
      case 'chain': this.chain(dt); break;
      case 'climb': this.climb(dt); break;
      case 'brawl': this.brawl(dt); break;
      case 'meteor': I.story.meteorTick(dt); break;
      case 'cut': this.vel.multiplyScalar(Math.exp(-5 * dt)); break;
      case 'guard':
        this.vel.multiplyScalar(Math.exp(-6 * dt));
        if (this.t > 0.4) {
          // Два-три блока подряд — и он отвечает сам
          if (this.guarded >= 2) { this.guarded = 0; this.guardK = 0; this.startCombo(); this.strikeT *= 0.55; }
          else this.go('neutral');
        }
        break;
      case 'evade':
        this.ghostT -= dt;
        if (this.ghostT <= 0) { this.W.effects.ghost(this.root); this.ghostT = 0.05; }
        this.vel.copy(this.evadeDir).multiplyScalar(lerp(190, 900, spaceK(this.pos.y)));
        this.grounded = false;
        if (this.t > 0.2) {
          this.vel.multiplyScalar(0.25);
          // Уход с линии — и сразу ответ
          if (this.evadeThen === 'laser') { this.evadeThen = null; this.startLaser(); }
          else if (this.dist < 34 && Math.random() < 0.7) { this.startCombo(); this.strikeT *= 0.7; }
          else this.go('neutral');
        }
        break;
      case 'recover':
        this.recoverT -= dt;
        this.vel.multiplyScalar(Math.exp(-6 * dt));
        this.braking = !this.grounded && this.vel.length() > 60;
        if (this.recoverT <= 0) { this.go('neutral'); this.thinkT = 0.15; this.pickMode(); }
        break;
      case 'stun':
        this.stunT -= dt;
        this.vel.multiplyScalar(Math.exp(-5 * dt));
        if (this.stunT <= 0) { this.go('neutral'); this.thinkT = 0.05; }
        break;
      case 'held':
        this.vel.set(0, 0, 0);
        this.heldT -= dt;
        if (this.heldT <= 0) I.xargBreaksHold(this);
        break;
      case 'knock':
        // Держит серия героя — пока она идёт, он летит и не собирается
        if (I.chain.kin !== this) this.knock -= dt;
        this.vel.multiplyScalar(Math.exp(-1.5 * dt));
        this.vel.y -= 14 * (1 - spaceK(this.pos.y)) * dt;
        this.faceTarget = false;
        if (this.knock <= 0) {
          this.knock = 0;
          this.vel.multiplyScalar(0.2);
          this.W.effects.shockwave(this.c.clone(), { type: 'disc', dir: this.aim.clone(), radius: 7, life: 0.3, opacity: 0.5 });
          this.go('neutral');
          this.thinkT = 0.25;
        }
        break;
      case 'down':
        this.downT -= dt;
        this.vel.set(0, 0, 0);
        if (this.downT <= 0) { this.go('neutral'); this.thinkT = 0.1; this.grounded = this.pos.y <= this.groundY + 0.1; }
        break;
      case 'dead':
        // Лёг после борозды по земле или врезался
        if (!this.deadDown && this.pos.y <= this.groundY + 0.1 && Math.hypot(this.vel.x, this.vel.z) < 70) this.deadDown = true;
        if (this.deadDown) { this.vel.set(0, 0, 0); this.downK = 1; this.knock = 0; }
        else { this.knock = 99; this.vel.multiplyScalar(Math.exp(-0.6 * dt)); this.vel.y -= 14 * (1 - spaceK(this.pos.y)) * dt; }
        this.faceTarget = false;
        break;
      default:
    }

    // Лазер: бьёт туда, где сейчас laserAim
    if (this.lasering || this.laser.group.visible) this.laser.update(dt, this.lasering, this.laserAim, this);

    // На большой скорости пробивает здания насквозь
    this.ramming = this.state !== 'dead' && this.vel.lengthSq() > 200 * 200;
    if (!this.ramming && this.knock <= 0) this.smashed = 0;
    if (this.state !== 'scene') this.move(dt);
    this.orient(dt);
    if (this.deadDown) {
      // Лежит там, где упал
      if (!this.lieQ) this.lieQ = new THREE.Quaternion().setFromAxisAngle(_v.set(1, 0, 0), -Math.PI / 2 * 0.98);
      this.quat.slerp(this.lieQ, 1 - Math.exp(-9 * dt));
      this.root.quaternion.copy(this.quat);
      this.root.position.y = this.groundY + 0.18;
    }
    this.animate(dt, camPos);

    // Кулак светится на зарядке
    const ck = this.charge / P.heavyMaxCharge;
    this.fist.visible = ck > 0.02;
    if (this.fist.visible) {
      this.model.fistWorldPos('R', this.fist.position);
      this.fist.material.opacity = ck * 0.9;
      this.fist.scale.setScalar(0.08 + ck * 0.34 + Math.sin(this.t * 40) * 0.03 * ck);
      if (Math.random() < ck * 0.7) this.W.sparks.burst(this.fist.position, 1, { size: [0.08, 0.2], speed: 3, life: [0.15, 0.3], color: 0xff8040 });
    }
  }

  hide() {
    super.hide();
    this.fist.visible = false;
    this.laser.group.visible = false;
    this.lasering = false;
  }
}
