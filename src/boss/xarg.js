import * as THREE from 'three';
import { Kin, spaceK } from './kin.js';
import { EyeLaser } from '../player/laser.js';
import { PLAYER as P } from '../config.js';
import { aimBlow, BLOW_WAY, blowQuat, followBlow, reelHit, whirlPose } from '../player/model.js';
import { lerp, clamp, smoothstep } from '../utils.js';

// Генерал Ксарг: тот же размер и те же способности, что у героя — удары, заряженный удар, рывок,
// лазер, удар о землю, захват, полёт на сверхскорости и серия ударов в полёте.
// Движется как герой: бегает по земле, приседает перед взлётом, тормозит корпусом, садится на колено.
// Между атаками держит режим: давит, кружит, отступает и заходит на пролёт, догоняет, идёт пешком.
// Он пришёл драться: хватает и швыряет, бьёт сериями и плечом с разгона, а отлетев от удара, резко
// тормозит и сразу идёт в ответ. Сам открывается после своих атак — это окно для контратаки.

export const XARG_HP = 1000;
const DMG = { jab: 7, last: 10, heavy: 22, dive: 14, hurl: 24, shoulder: 16, chain: [10, 12, 14, 18] };
// По фазам: задержка замаха, шанс блока/уклонения, пауза между решениями, ударов в серии, как часто хватает,
// сколько секунд переводит дух после атаки
const TEMPO = [null,
  { windup: 0.46, guard: 0.5, think: [0.25, 0.6], strikes: 2, breakChain: 0.12, hits: 2, grabCd: 7, rest: 1 },
  { windup: 0.4, guard: 0.62, think: [0.18, 0.45], strikes: 3, breakChain: 0.22, hits: 3, grabCd: 6, rest: 0.85 },
  { windup: 0.34, guard: 0.72, think: [0.1, 0.3], strikes: 4, breakChain: 0.32, hits: 4, grabCd: 5, rest: 0.7 },
];
// Сколько метров от него до героя, которого он несёт перед собой: кулак упирается в грудь
const GRIP = 1.1;
// Через сколько секунд он прилетает к улетевшему герою
const CHASE_TIME = [10, 15];
const INTRO_LEN = 5.2;       // с: столько он летит к герою во вступлении
const INTRO_WIDE = 3.6;      // с: столько длится общий план
const ARC_R = 1100;          // м: радиус круга в небе над городом
const ARC_SPAN = Math.PI * 1.6;   // сколько круга он проходит
const ARC_TILT = 1.22;       // наклон круга: он почти стоит, дальняя часть уходит высоко в небо
const RAM_FRONT = 0.8;      // рад: откуда камера смотрит в начале проноса (0 — прямо спереди)
const RAM_WINDUP = 0.32;     // с: в конце проноса он тормозит и замахивается героем, как для броска
const ATTACKS = ['chain', 'shoulder', 'grab', 'carry', 'combo', 'heavy', 'dive', 'hurl', 'laser', 'tackle'];
// Удары его серии по порядку. Последний всегда сверху: в землю
const KINDS = ['hook', 'straight', 'back'];

const UP = new THREE.Vector3(0, 1, 0);
const _d = new THREE.Vector3(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _p = new THREE.Vector3(), _r = new THREE.Vector3();
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
    this.throwDir = new THREE.Vector3(0, 0, 1);
    this.driveEnd = new THREE.Vector3();
    this.driveTo = new THREE.Vector3();
    this.widePos = new THREE.Vector3();
    this.prevH = new THREE.Vector3();
    this.shot = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 50 };
    this.shotS = new THREE.Vector3(1, 0, 0);
    this.shotT = 0;
    this.arcC = new THREE.Vector3();
    this.arcU = new THREE.Vector3();
    this.arcV = new THREE.Vector3();
    this.arcN = new THREE.Vector3();
    this.arcH = new THREE.Vector3();
    this.chaseAxis = new THREE.Vector3(0, 1, 0);
    this.heroWaits = (dt) => this.waitHero(dt);

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
    this.cd = { laser: 3, heavy: 2, dive: 5, grab: 3, taunt: 6, hurl: 6, shoulder: 2, ship: 0, chase: 0, answer: 0, rest: 0 };
    this.mode = null;
    this.modeT = 0;
    this.modeS = 0;
    this.fleeT = 0;
    this.chaseLeft = 0;
    this.fled = false;
    this.fledFar = false;
    this.calmT = 0;
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
    this.opening = false;
    this.driveShot = false;
    this.lieQ = null;
    this.model.setRage(0);
    this.model.setEyeGlow?.(0);
    this.fist.visible = false;
    this.laser.group.visible = false;
    this.clearShot();
  }

  go(state) {
    this.calmT = 0;
    if (ATTACKS.includes(this.state) && !ATTACKS.includes(state)) this.cd.rest = this.tempo.rest + Math.random() * 0.4;
    this.state = state;
    this.t = 0;
    if (state !== 'chain' && this.blow && this.blow.f < 2) { this.blow = null; this.poseQ = null; }
    else if (state !== 'chain' && this.blow) this.poseQ = null;
  }

  get tempo() { return TEMPO[this.phase]; }

  // Открыт для удара: не блокирует и не уклоняется
  get open() { return this.cd.answer <= 0 && ['stun', 'down', 'knock', 'regain', 'recover', 'laser', 'heavy', 'held', 'seized', 'dive', 'hurl', 'brawl', 'cut'].includes(this.state); }

  // ---------------------------------------------------------------- попадания героя
  // kind: punch | heavy | slam | ram | laser | throw | car; power 0..1
  receive(kind, power, point, dir) {
    if (!this.alive || this.state === 'wait' || this.state === 'descend') return false;
    const I = this.inv, W = this.W;
    // Сцены идут своим ходом: удар там решает другое
    if (this.state === 'scene' || this.state === 'meteor' || this.state === 'beamlock' || this.state === 'seized') return true;
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
    // Простым кулаком его не остановить, когда он сам пошёл в атаку или только что вышел из-под серии и идёт в ответ.
    // Влететь в него без разгона — то же самое. Против этого есть рывок и заряженный удар
    if ((kind === 'punch' || (kind === 'ram' && power < 0.6)) && (this.cd.answer > 0 || ['chain', 'shoulder', 'grab'].includes(this.state))) {
      this.parry(point, dir);
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
    // Только что вышел из-под серии и идёт в ответ: остановит его только сильный заряд, и то без новой серии
    if (kind === 'heavy' && this.cd.answer > 0 && power < 0.6) { this.block(point, dir); return true; }

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
      if (this.cd.answer > 0 || !I.chain.open(this, dir, kind, power)) {
        this.chainEnd();
        this.go('knock');
        this.launch(dir, lerp(150, 420, spaceK(this.pos.y)), 0.5);
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

  // Первый удар серии дошёл: успел ли он его встретить. clash — кулак в кулак, block — закрылся, evade — ушёл.
  // Открытый не успевает никогда, сильный заряд пробивает всё, кроме встречного удара
  meetBlow(power) {
    if (['chain', 'shoulder', 'grab'].includes(this.state)) return 'clash';
    if (this.cd.answer > 0 && power < 0.6) return 'block';
    const canDefend = !this.open && !(this.inv.counterT > 0) && ['neutral', 'guard', 'evade'].includes(this.state);
    if (!canDefend || power >= 0.35 || Math.random() >= this.tempo.guard * 0.6) return null;
    return Math.random() < 0.34 && this.dashCdOk() ? 'evade' : 'block';
  }

  block(point, dir) {
    this.go('guard');
    this.guardT = 0.45;
    this.guardK = 1;
    this.guarded++;
    this.vel.addScaledVector(dir, 10);
    this.parry(point, dir);
  }

  parry(point, dir) {
    const W = this.W;
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
    this.releaseHero();
    this.go('dead');
    this.inv.onXargDown(dir);
  }

  // Самому герою: удар долетел? Рывок даёт неуязвимость, встречный удар — столкновение кулаков
  tryHit(reach) {
    const I = this.inv, H = I.player;
    const dist = this.c.distanceTo(I.heroC);
    if (dist > reach) return 'miss';
    if (H.dashT > 0) { I.onDodge(this); return 'dodge'; }
    if ((H.punchT >= 0 && H.punchT < (H.punchHitAt ?? P.punchHitTime) + 0.09) || I.chain.meeting) { I.clash(this); return 'clash'; }
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
    // Герой улетел сам, а не отброшен ударом: миг провожает его взглядом и идёт следом, но прилетит нескоро
    const away = !H.grounded && d > 40 && H.speed > 120 && H.vel.dot(this.aim) > H.speed * 0.4;
    // Сразу после его удара герой летит ещё по инерции: это не бегство
    this.calmT = H.knockT > 0 ? 0 : this.calmT + dt;
    if (H.knockT > 0 || d < 40) this.fled = this.fledFar = false;
    else if (away && this.calmT > 1.2 && I.input && Math.abs(I.input.moveX) + Math.abs(I.input.moveY) + Math.abs(I.input.moveZ) > 0.1) this.fled = true;
    if (this.fled && d > 300) this.fledFar = true;
    // Отлетел недалеко и завис: бой идёт дальше. Улетел далеко: прилетит к сроку, даже если герой уже остановился
    const leaving = this.fled && (this.fledFar || away);
    this.fleeT = leaving ? this.fleeT + dt : Math.max(0, this.fleeT - dt * 2);
    // Уже идёт полным ходом — ждать незачем
    const underWay = this.fleeT > 0 && this.vel.dot(this.aim) > 200;
    if ((this.fleeT >= 0.6 - this.phase * 0.1 || underWay) && this.mode !== 'chase' && this.mode !== 'flyby') {
      this.setMode('chase');
      this.chaseLeft = lerp(CHASE_TIME[0], CHASE_TIME[1], Math.random());
      // Ось большой дуги: примерно вертикальна, с завалом и в случайную сторону
      this.chaseAxis.set((Math.random() - 0.5) * 0.7, Math.random() < 0.5 ? -1 : 1, (Math.random() - 0.5) * 0.7).normalize();
    }
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
            this.strike();
            return;
          }
        }
        break;
      case 'chase': {
        // Идёт следом большой дугой вокруг героя, чтобы его было видно, и в конце заходит прямо на него.
        // Подходит на такое расстояние, чтобы оказаться рядом к сроку, как бы герой ни удирал
        this.chaseLeft -= dt;
        const L = this.chaseLeft, ring = lerp(320, 900, sk);
        let radial = L > 1.6 ? clamp((d - ring) / (L - 1.2), -150, Infinity) : (d - 15) / Math.max(L, 0.2);
        radial += Math.max(0, H.vel.dot(this.aim));
        const s = Math.max(lerp(320, 1400, sk), Math.abs(radial) * 1.15);
        const round = Math.max(Math.sqrt(Math.max(s * s - radial * radial, 0)), s * 0.25) * smoothstep(0.2, 1.6, L);
        _r.crossVectors(this.aim, this.chaseAxis);
        if (_r.lengthSq() < 0.01) _r.copy(_v);
        _d.copy(this.aim).multiplyScalar(radial).addScaledVector(_r.normalize(), round);
        // Над домами, а не сквозь них, и всё время выше героя: так дуга читается на фоне неба
        if (sk < 0.5 && L > 1.6) _d.y += clamp((Math.max(H.pos.y + 80, this.groundY + 120) - this.pos.y) * 1.5, -120, 200);
        this.faceTarget = false;
        this.boosting = true;
        rate = 6;
        if (this.fleeT > 0) this.modeT = Math.max(this.modeT, 1);
        if (d < 40 || this.fleeT <= 0) {
          // Догнал, или герой передумал и остался рядом: теперь можно и ударить
          this.fleeT = 0;
          this.setMode('press');
          this.thinkT = Math.min(this.thinkT, 0.1);
        }
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
        // Герой только что сорвался с места: пока лишь смотрит ему вслед. Догнал — держится рядом
        const closing = this.fleeT > 0 ? clamp((d - want) * 3.4, -top * 0.4, top) * 0.2 : clamp((d - want) * 3.4, -top * 0.4, top) + Math.max(0, H.vel.dot(this.aim));
        _d.copy(this.aim).multiplyScalar(closing).addScaledVector(_v, d < 60 ? this.strafe * 14 : 0);
        // Издалека заходит дугой: вбок и чуть вверх, а не по прямой
        const swing = smoothstep(80, 200, d) * Math.max(closing, 0);
        if (swing > 0) { _d.addScaledVector(_v, (this.arcS || 1) * 0.4 * swing); _d.y += 0.12 * swing; this.faceTarget = false; }
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
    if (m === 'press') this.arcS = r < 0.5 ? -1 : 1;
    this.modeT = m === 'press' ? 1.4 + r * 1.2 : m === 'circle' ? 1 + r * 1.4 : m === 'backoff' ? 0.7 + r * 0.35 : m === 'ground' ? 2.5 + r * 2 : 3;
    // Кружит не просто так: сначала выбирает момент
    if (m === 'circle') this.thinkT = Math.max(this.thinkT, 0.3 + r * 0.4);
  }

  // Как двигаться дальше: смотрит, что делает герой
  pickMode() {
    const H = this.inv.player, d = this.dist, r = Math.random();
    const low = H.grounded || H.pos.y - this.groundY < 3;
    if (low && d < 220 && H.speed < 60) this.setMode('ground');
    else if (d > 110) this.setMode('press');
    else this.setMode(r < 0.7 ? 'press' : r < 0.85 ? 'circle' : 'backoff');
  }

  // Отошёл: заряд, луч или заход на пролёт со сверхскорости
  afterBackoff() {
    const I = this.inv, d = this.dist, r = Math.random();
    this.setMode('press');
    if (this.cd.rest > 0) return;
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

  // Какой приём сейчас. Герой в досягаемости — значит, атака есть всегда, вопрос только какая
  decide() {
    const H = this.inv.player, d = this.dist, r = Math.random();
    if (this.mode === 'backoff' || this.mode === 'flyby' || this.cd.rest > 0) return;
    // Герой уходит: сначала догнать, луч его только остановит. Бросается на него, когда догнал
    if (this.mode === 'chase' || this.fleeT > 0) return;
    if (d > 320) {
      if (this.cd.laser <= 0 && r < 0.5) this.startLaser();
      return;
    }
    if (this.mode === 'circle' && r < 0.2) return;
    // Бежит к нему: до удара ещё далеко
    if (this.mode === 'ground' && d > 14 && r > 0.25) return;
    if (this.cd.grab <= 0) { this.startGrab(); return; }
    if (this.cd.shoulder <= 0 && d > 24 && r < 0.45) { this.startShoulder(); return; }
    if (H.grounded && this.cd.dive <= 0 && r < 0.3) { this.startDive(); return; }
    if (this.cd.laser <= 0 && d > 60 && r < 0.3) { this.startLaser(); return; }
    if (this.cd.hurl <= 0 && d > 34 && r < 0.3 && this.startHurl()) return;
    if (this.cd.heavy <= 0 && r < 0.3) { this.startHeavy(); return; }
    // Финт: рывок вбок и удар оттуда
    if (this.phase >= 2 && d < 26 && r < 0.12 && this.dashCdOk()) { this.startEvade(this.aim); return; }
    // После серии даёт герою собраться: иначе из-под неё не выбраться вообще
    if (this.cd.chase > 0 && !H.grounded) return;
    this.strike();
  }

  // В воздухе бьёт сериями, на земле обычными ударами
  strike() {
    if (this.grounded && this.inv.player.grounded) this.startCombo();
    else this.startChain();
  }

  // Трогают его корабль: бросает всё и летит наперехват
  defendShip() {
    if (this.cd.ship > 0 || (this.state !== 'neutral' && this.state !== 'recover')) return;
    this.cd.ship = 9;
    this.inv.say(Math.random() < 0.5 ? 'Оставь корабль!' : 'Отойди от него!', 1.8);
    this.startChain();
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
      this.strike();
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
      I.hurtHero(last ? DMG.last : DMG.jab, kn.clone().multiplyScalar(last ? 220 : 24), false, 0.14);
      this.hitFX(_p.copy(I.heroC), this.aim, last ? 0.8 : 0.45);
      if (last && Math.random() < 0.5) { this.startChain(); return; }
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
      I.hurtHero(DMG.heavy, dir.clone().multiplyScalar(lerp(270, 700, spaceK(this.pos.y))), false, 0);
      this.bigHitFX(at, dir, 1);
      if (!I.player.grounded) { this.startChain(); return; }
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
    this.cd.grab = this.tempo.grabCd + Math.random() * 2.5;
    this.grabbing = false;
  }

  // Короткий замах и бросок на героя со сверхскорости: уйти можно рывком, а встречный удар его отбивает
  grab(dt) {
    const I = this.inv, H = I.player;
    this.anim.lift = Math.min(0.75, this.t * 3);
    if (this.t < 0.22) { this.vel.multiplyScalar(Math.exp(-5 * dt)); return; }
    const d = this.dist;
    if (!this.grabbing) {
      this.grabbing = true;
      this.W.effects.shockwave(this.c.clone(), { type: 'disc', dir: this.aim.clone(), radius: 12, life: 0.35, opacity: 0.7 });
      I.fx.play('rush', { gain: 0.85, pos: this.c });
    }
    this.grounded = false;
    this.boosting = true;
    this.vel.copy(this.aim).multiplyScalar(Math.max(90, Math.min(d / 0.1, lerp(1000, 3200, spaceK(this.pos.y)))));
    if (d < 3.2) {
      const res = this.tryHit(3.2);
      if (res !== 'hit') return;
      this.anim.lift = 0;
      const r = Math.random();
      this.beginCarry(r < 0.6 ? 'spin' : this.pos.y < 500 ? 'drive' : 'up');
      I.hurtHero(3, null, false, 0);
      I.fx.thud(0.7);
      return;
    }
    if (this.t > 1.2) { this.anim.lift = 0; this.vel.multiplyScalar(0.2); this.go('recover'); this.recoverT = 0.6; }
  }

  // Плечом с разгона: разворот боком и удар всем телом на полной скорости
  startShoulder() {
    this.go('shoulder');
    this.cd.shoulder = 7 - this.phase + Math.random() * 2;
    this.blow = { side: Math.random() < 0.5 ? 'R' : 'L', f: 0, k: 0, pitch: 0, kind: 'shoulder' };
    this.poseQ = this.quat.clone();
    this.rushing = false;
  }

  shoulder(dt) {
    const I = this.inv, rdt = I.realDt, b = this.blow, sk = spaceK(this.pos.y), d = this.dist;
    if (!b) { this.go('neutral'); return; }
    this.grounded = false;
    b.k = Math.min(1, b.k + rdt / 0.1);
    b.f = Math.min(1.8, this.t / 0.24);
    aimBlow(this.poseQ, this.aim, b, rdt, 14);
    if (this.t < 0.24) { this.vel.multiplyScalar(Math.exp(-8 * dt)); return; }
    if (!this.rushing) {
      this.rushing = true;
      this.W.effects.shockwave(this.c.clone(), { type: 'disc', dir: this.aim.clone(), radius: 14, life: 0.4, opacity: 0.75 });
      I.fx.play('rush', { pos: this.c });
      I.fx.play('swing', { gain: 0.8, pos: this.c, rate: 0.8 });
    }
    this.boosting = true;
    this.vel.copy(this.aim).multiplyScalar(Math.max(260, Math.min(d / 0.08, lerp(1100, 4200, sk))));
    if (d > 3.4 && this.t < 1.2) return;
    const res = this.tryHit(4.2);
    if (res === 'dodge' || res === 'clash') return;
    this.vel.multiplyScalar(0.15);
    b.f = 2;
    if (res === 'hit') {
      const kick = _v.copy(this.aim).addScaledVector(UP, 0.18).normalize().clone();
      reelHit(I.player.reel, 1.2, 0);
      I.hurtHero(DMG.shoulder, kick.clone().multiplyScalar(lerp(560, 900, sk)), false, 0);
      I.fx.chainHit(I.heroC.clone(), kick, 3, false, I.heroBody);
      I.fx.chainRelease(I.heroC, kick, 3, false, I.heroBody);
      I.slowFor(0.25, 0.35);
      if (Math.random() < 0.55) { this.startChain(); return; }
    }
    this.go('recover');
    this.recoverT = res === 'hit' ? 0.35 : 0.7;
  }

  // Куда швырнуть героя: в ближайший дом, нет домов — в землю
  throwAim(out) {
    const city = this.W.city, c = this.c;
    if (c.y < 700) {
      const near = city.sphereQuery(c, 170, this.hits);
      let bd = Infinity;
      for (const s of near) {
        if (!s.alive) continue;
        city.closestPoint(s, c, _p);
        const dd = _p.distanceToSquared(c);
        if (dd > 16 * 16 && dd < bd) { bd = dd; _v2.copy(_p); }
      }
      if (bd < Infinity) return out.subVectors(_v2, c).normalize();
    }
    if (c.y - this.groundY > 25) return out.set(this.aimFlat.x * 0.6, -1, this.aimFlat.z * 0.6).normalize();
    return out.copy(this.aimFlat).setY(0.08).normalize();
  }

  // Герой пойман: spin — раскручивает на вытянутой руке и швыряет, ram — вступление дуэли, несёт к центру города и швыряет,
  // drive — несёт сквозь дома со сменой кадров и швыряет, up — уносит вверх
  beginCarry(mode) {
    const I = this.inv, H = I.player;
    if (I.chain.kin) I.chain.end();
    if (I.seize.kin) I.seize.abort();
    H.captured = this;
    H.punchT = -1;
    H.vel.set(0, 0, 0);
    H.grounded = false;
    H.falling = false;
    H.blow = null;
    H.poseQ = null;
    this.grounded = false;
    this.go('carry');
    this.struggleN = 0;
    this.carryMode = mode;
    if (mode === 'ram') { this.beginRam(); return; }
    if (mode === 'drive') { this.beginDrive(); return; }
    if (mode === 'spin') {
      this.throwAim(this.throwDir);
      this.beginWhirl(0.95);
      I.sayOnce('Думал, ты один так умеешь?', 2.4);
      return;
    }
    this.carryT = 1.9;
    I.sayOnce('Дёргайся. Это всё, что тебе осталось.', 2.6);
  }

  // Раскрутка. Сколько крутить, чтобы к концу рука шла ровно по линии броска: от одного до двух оборотов
  beginWhirl(len) {
    const I = this.inv, H = I.player;
    this.carryMode = 'spin';
    this.carryT = this.carryAll = len;
    const s = this.whirlS = Math.random() < 0.5 ? -1 : 1, T = this.throwDir;
    this.whirlA = Math.atan2(I.heroC.z - this.c.z, I.heroC.x - this.c.x);
    const end = Math.atan2(-T.x * s, T.z * s);
    this.whirlD = Math.PI * 2 + ((((end - this.whirlA) * s) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    this.blow = { side: 'R', f: 1.99, k: 1, pitch: 0, kind: 'straight' };
    this.poseQ = this.quat.clone();
    H.poseQ = H.quat.clone();
    H.knockT = 0.5;
    H.hitstop = Math.max(H.hitstop, 0.06);
    I.slowFor(0.5, len);
    I.fx.play('whirl');
    I.theme.duck(0.7);
    this.clearShot();
    // Снизу: две фигуры на фоне неба. Смена кадра: крупные обломки, что висели перед камерой, уже не видны
    this.W.debris.clearAround(this.c.x, this.c.z, 26, 1.5);
    this.startShot(9, len + 0.45, -3.4);
    if (!I.camRig.shot) this.startShot(13, len + 0.45, 7);
  }

  // Раскрутка на вытянутой руке, каждый оборот быстрее предыдущего. В конце рука просто разжимается
  whirl() {
    const I = this.inv, H = I.player, rdt = I.realDt;
    this.carryT -= rdt;
    const k = 1 - clamp(this.carryT / this.carryAll, 0, 1), a = this.whirlA + this.whirlS * this.whirlD * k * k;
    this.vel.multiplyScalar(Math.exp(-8 * rdt));
    whirlPose(this.c, a, 2.7, 0.1, _p, H.poseQ, this.poseQ);
    H.pos.copy(_p).addScaledVector(UP, -1);
    H.vel.set(-Math.sin(a), 0, Math.cos(a)).multiplyScalar(this.whirlS * 70 * k);
    this.syncHero();
    if (this.carryT > 0) return;
    const sk = spaceK(this.pos.y), dir = this.throwDir.clone();
    this.releaseHero();
    reelHit(H.reel, 1.2, 2);
    I.hurtHero(DMG.hurl, dir.clone().multiplyScalar(lerp(640, 900, sk)), false, 0);
    I.fx.chainRelease(I.heroC, dir, 4, false, I.heroBody);
    I.fx.play('sonicBoom', { gain: 0.85 });
    I.fx.crashZoom(10, 0.25);
    I.slowFor(0.35, 0.3);
    if (this.blow) this.blow.f = 2;
    this.boosting = false;
    // Чаще всего летит следом и добивает
    if (Math.random() < 0.55) { this.startChain(); return; }
    this.go('recover');
    this.recoverT = 0.4;
  }

  // Герой уже походил в этом кадре, его ведёт генерал: тело не должно отставать на целый шаг
  syncHero() {
    const I = this.inv, H = I.player;
    H.root.position.copy(H.pos).addScaledVector(UP, 1);
    I.heroC.copy(H.pos).addScaledVector(UP, 1);
  }

  // Рука на груди героя, оба уже в позе
  gripHero() {
    const H = this.inv.player;
    this.blow = { side: 'R', f: 1.99, k: 1, pitch: 0, kind: 'straight' };
    this.poseQ = this.quat.clone();
    H.poseQ = H.quat.clone();
  }

  // Он сдвинется в конце своего хода: герой уже там, где будет рука
  holdHero(D, dt) {
    const H = this.inv.player;
    H.pos.copy(this.pos).addScaledVector(this.vel, dt).addScaledVector(D, GRIP);
    H.vel.copy(this.vel);
    this.syncHero();
    blowQuat(H.poseQ, _v.copy(D).negate(), -0.3);
    blowQuat(this.poseQ, D, 0.35);
  }

  // Вступление, «Хватит. Он мой.»: несёт героя перед собой к центру города, дома пробивает им
  beginRam() {
    const I = this.inv, r = Math.hypot(this.pos.x, this.pos.z);
    if (r < 400) this.carryDir.copy(this.aimFlat);
    else this.carryDir.set(-this.pos.x, 0, -this.pos.z).normalize();
    this.carryY = clamp(this.pos.y, 14, 30) + Math.max(0, this.W.city.groundHeightAt(this.pos.x, this.pos.z, -1e4));
    // Несёт через весь город: от этого кадра зависит вступление. Время идёт, когда он уже внизу, среди домов
    this.carryT = this.carryAll = clamp(r / 340, 3.4, 4.4);
    this.diveT = 1.8;
    this.ramT = 0;
    this.ramCam = 0;
    this.ramWalls = 0;
    this.ramKick = 0;
    this.ramSwing = null;
    this.ramSide = Math.random() < 0.5 ? -1 : 1;
    this.ramSteerT = 0;
    this.ramAim = null;
    this.gripHero();
    // Одна камера на всю сцену: сначала впереди, они летят прямо на неё, потом облетает их и садится за спину
    this.shotT = 0;
    this.shot.roll = 0;
    this.ramShot = true;
    this.placeRamShot(0);
    I.camRig.shot = this.shot;
    I.fx.cineFor(this.carryT + this.diveT + 1.6);
    I.sayOnce('Дёргайся. Это всё, что тебе осталось.', 2.6);
  }

  // На какой угол довернуть, чтобы впереди был дом. Прямо по курсу есть — не доворачивает; нигде нет — null
  wallAhead() {
    const city = this.W.city;
    for (const far of [75, 150]) {
      for (const a of [0, 0.22, -0.22, 0.45, -0.45]) {
        _v.copy(this.carryDir).applyAxisAngle(UP, a);
        _p.copy(this.pos).addScaledVector(_v, far).setY(this.carryY);
        if (city.sphereQuery(_p, 14 * far / 75, this.hits).some((b) => b.alive)) return a;
      }
    }
    return null;
  }

  // Камера сцены. Впереди на три четверти: его лицо над плечом героя, за ними город. Облёт. За спиной: дома впереди лопаются один за другим
  placeRamShot(rdt) {
    const I = this.inv, S = this.shot, H = I.heroC, city = this.W.city;
    const D = _d.copy(this.vel);
    if (D.lengthSq() < 1) D.copy(this.carryDir);
    D.normalize();
    const R = _r.crossVectors(D, UP);
    if (R.lengthSq() < 0.01) R.set(1, 0, 0);
    R.normalize().multiplyScalar(this.ramSide);
    _lc.lerpVectors(this.c, H, 0.5);
    this.ramCam += rdt;
    if (this.ramSwing === null && this.ramT > 0.9) this.ramSwing = this.ramCam;
    const a = lerp(RAM_FRONT, Math.PI, this.ramSwing === null ? 0 : smoothstep(0, 0.6, this.ramCam - this.ramSwing));
    const e = (a - RAM_FRONT) / (Math.PI - RAM_FRONT), dist = lerp(8, 6.5, e);
    _ls.copy(_lc).addScaledVector(D, Math.cos(a) * dist).addScaledVector(R, 1.6 + Math.sin(a) * dist).addScaledVector(UP, lerp(1, 1.8, e));
    // Впереди дом: кадр закрыт, камера сразу уходит в облёт
    if (this.ramSwing === null && (city.isInside(_ls) || this.walled(_ls, _lc))) this.ramSwing = this.ramCam - 0.25;
    S.pos.copy(_ls);
    const gy = city.groundHeightAt(S.pos.x, S.pos.z, S.pos.y + 1) + 0.8;
    if (S.pos.y < gy) S.pos.y = gy;
    _v.copy(H).addScaledVector(D, 28);
    S.look.lerpVectors(_lc, _v, smoothstep(0.4, 1, e));
    this.ramKick *= Math.exp(-7 * rdt);
    S.roll = this.ramSide * (0.06 + 0.07 * Math.sin(this.ramCam * 2.2)) + this.ramKick;
    S.fov = lerp(50, 68, e) - I.fx.zoom * 0.6;
  }

  ram(dt) {
    const I = this.inv, H = I.player, sk = spaceK(this.pos.y);
    this.carryT -= dt;
    this.boosting = true;
    this.smashed = 0;
    // Схватил высоко: сначала круто вниз, в дома, и только там тащит
    const high = this.pos.y - this.carryY > 12 && this.diveT > 0;
    if (high) { this.diveT -= dt; this.carryT += dt; }
    else this.ramT += dt;
    // Внизу разгоняется весь пронос; в конце резко тормозит: замах для броска
    const windup = !high && this.carryT < RAM_WINDUP;
    const v = high ? 420 : windup ? 150 : lerp(260, 470, smoothstep(0, this.carryAll - RAM_WINDUP, this.ramT));
    // Ведёт героя в дома: если прямо по курсу пусто, чуть доворачивает к ближайшему впереди
    if (!high && !windup) {
      this.ramSteerT -= dt;
      if (this.ramSteerT <= 0) { this.ramSteerT = 0.25; this.ramAim = this.wallAhead(); }
      if (this.ramAim !== null) {
        const turn = clamp(this.ramAim, -0.7 * dt, 0.7 * dt);
        this.carryDir.applyAxisAngle(UP, turn);
        this.ramAim -= turn;
      }
    }
    _d.copy(this.carryDir);
    _d.y = clamp((this.carryY - this.pos.y) * 0.03, high ? -1.6 : -0.5, 0.5);
    this.vel.lerp(_d.normalize().multiplyScalar(v), 1 - Math.exp(-(high ? 7 : windup ? 9 : 5) * dt));
    // На замахе рука с героем уходит назад, потом вперёд
    if (windup) {
      const k = 1 - this.carryT / RAM_WINDUP;
      _p.copy(this.vel).normalize().applyAxisAngle(UP, this.ramSide * 1.1 * Math.sin(k * Math.PI)).addScaledVector(UP, 0.35 * Math.sin(k * Math.PI));
      this.holdHero(_p.normalize(), dt);
    } else this.holdHero(_p.copy(this.vel).normalize(), dt);
    if (this.ramShot) this.placeRamShot(I.realDt || dt);
    if (this.carryT > 0) return;
    // Швыряет вперёд и вниз, в следующие дома. Дальше просто бой
    this.opening = false;
    this.releaseHero();
    this.boosting = false;
    const dir = _v.copy(this.carryDir).multiplyScalar(0.9).setY(-0.3).normalize().clone();
    I.hurtHero(DMG.hurl, dir.clone().multiplyScalar(lerp(620, 900, sk)), false, 0);
    this.bigHitFX(I.heroC.clone(), dir, 1.2);
    I.fx.airRing(I.heroC, dir, 30, 0.5, 0.55);
    I.fx.play('sonicBoom', { gain: 0.9 });
    I.fx.crashZoom(12, 0.3);
    I.slowFor(0.3, 0.32);
    H.hitstop = Math.max(H.hitstop, 0.09);
    I.say('Смотри, что от него останется.', 2.4);
    // Камера остаётся на месте броска и провожает героя длинным объективом
    if (this.ramShot) {
      this.ramShot = false;
      this.shot.roll = 0;
      this.shotT = 1.1;
    }
    this.startPunch(1);
    this.cd.grab = Math.max(this.cd.grab, 5);
    this.go('recover');
    this.recoverT = 0.5;
  }

  // Несёт героя через город на вытянутой руке и ломает им дома
  beginDrive() {
    const I = this.inv, H = I.player, r = Math.hypot(this.pos.x, this.pos.z);
    if (r < 400) this.carryDir.copy(this.aimFlat);
    else this.carryDir.set(-this.pos.x, 0, -this.pos.z).normalize();
    const y = clamp(this.pos.y, 26, 64) + Math.max(0, this.groundY);
    this.driveEnd.copy(this.pos).addScaledVector(this.carryDir, 620).setY(y);
    this.driveTo.copy(this.driveEnd);
    const way = this.pos.distanceTo(this.driveEnd);
    this.carryT = this.carryAll = clamp(way / 430, 1.5, 4.4);
    this.driveTop = Math.max(430, way / this.carryAll * 1.25);
    this.driveV = 130;
    this.driveWalls = 0;
    this.driveSide = Math.random() < 0.5 ? -1 : 1;
    this.driveWide = null;
    this.steerT = 0;
    this.prevH.copy(H.pos);
    this.gripHero();
    this.clearShot();
    this.driveShot = true;
    I.camRig.shot = this.shot;
    I.fx.cineFor(this.carryAll + 2);
    I.fx.play('rush');
    I.theme.duck(0.7);
    I.sayOnce('Дёргайся. Это всё, что тебе осталось.', 2.8);
  }

  // Рвётся к тому дому, что ближе всего по курсу: чтобы было чем бить
  aimWall() {
    const city = this.W.city, c = this.c, D = this.carryDir;
    this.driveTo.copy(this.driveEnd);
    let best = 0;
    for (const s of city.sphereQuery(_p.copy(c).addScaledVector(D, 110), 95, this.hits)) {
      if (!s.alive) continue;
      city.closestPoint(s, c, _v2).sub(c);
      const l = _v2.length();
      if (l < 8) continue;
      const dot = _v2.dot(D) / l;
      if (dot > 0.86 && dot > best) { best = dot; this.driveTo.copy(c).add(_v2); }
    }
  }

  drive(dt) {
    const I = this.inv, H = I.player;
    this.carryT -= dt;
    this.boosting = true;
    this.smashed = 0;
    this.driveV = Math.min(this.driveTop, this.driveV + 700 * dt);
    this.steerT -= dt;
    if (this.steerT <= 0) {
      this.steerT = 0.1;
      this.aimWall();
    }
    _d.subVectors(this.driveTo, this.pos).normalize();
    if (this.pos.y - this.groundY < 8) _d.y = Math.max(_d.y, 0.15);
    // Под конец вырывается из домов наверх: раскрутка будет на фоне неба, а не в проломе
    const rising = this.carryT < 0.55;
    if (rising) _d.copy(this.carryDir).setY(0).normalize().setY(1).normalize();
    const D = this.carryDir.lerp(_d, 1 - Math.exp(-(rising ? 7 : 4) * dt)).normalize();
    this.vel.copy(D).multiplyScalar(this.driveV);
    this.holdHero(D, dt);
    // Дома бьют по герою: он идёт первым
    if (Math.min(this.prevH.y, H.pos.y) < 700) {
      const n = I.chain.ram(this.prevH, H.pos, this.driveV);
      if (n) {
        this.driveWalls++;
        I.hurtHero(3, null, false, 0);
        H.hitstop = Math.max(H.hitstop, this.driveWalls === 1 ? 0.1 : 0.035);
        this.driveV *= 0.96;
        // Первая стена: время на миг вязнет, и видно, как она расходится
        if (this.driveWalls === 1) {
          I.slowFor(0.3, 0.4);
          I.fx.crashZoom(10, 0.25);
        }
      }
    }
    this.prevH.copy(H.pos);
    this.updateDriveShot();
    if (this.carryT > 0) return;
    // Над крышами тормозит всем телом и с разворота швыряет вниз, в следующие дома
    this.endDriveShot();
    this.W.effects.shockwave(this.c.clone(), { type: 'disc', dir: D.clone(), radius: 40, life: 0.6, opacity: 0.7 });
    I.fx.play('brake');
    this.throwDir.copy(D).setY(0).normalize().setY(-0.42).normalize();
    this.beginWhirl(0.6);
  }

  // Три кадра: спереди снизу, сбоку и общий план с места, мимо которого они пронесутся. Всё считается от героя: он уже стоит там, где будет в кадре
  updateDriveShot() {
    const I = this.inv, S = this.shot, D = this.carryDir, k = 1 - this.carryT / this.carryAll, s = this.driveSide;
    _ls.crossVectors(D, UP).normalize();
    S.look.copy(I.heroC).addScaledVector(D, -1.3);
    if (k >= 0.72 && this.driveWide === null) this.driveWide = this.pickWide();
    if (k < 0.38) {
      S.pos.copy(I.heroC).addScaledVector(D, 6).addScaledVector(_ls, 5.5 * s).addScaledVector(UP, -1.5);
      S.fov = 50;
    } else if (!this.driveWide) {
      S.pos.copy(S.look).addScaledVector(_ls, -8.5 * s).addScaledVector(UP, 1.4).addScaledVector(D, -1);
      S.fov = 62;
    } else {
      S.pos.copy(this.widePos);
      S.fov = clamp(2 * Math.atan(20 / S.pos.distanceTo(I.heroC)) * 180 / Math.PI, 16, 62);
    }
    S.fov -= I.fx.zoom;
    const gy = this.W.city.groundHeightAt(S.pos.x, S.pos.z, S.pos.y + 1) + 0.6;
    if (S.pos.y < gy) S.pos.y = gy;
  }

  // Точка для общего плана: они идут прямо на неё и проносятся мимо под конец. Дома не должны загораживать весь их путь. Нет такой — остаётся боковой кадр
  pickWide(time = this.carryT) {
    const I = this.inv, D = this.carryDir, way = this.driveV * time * 0.85;
    _p.copy(I.heroC).addScaledVector(D, way);
    _v.copy(I.heroC).addScaledVector(D, way * 0.5);
    for (const h of [16, 34, 60, 90]) {
      for (const s of [this.driveSide, -this.driveSide]) {
        this.widePos.copy(_p).addScaledVector(_ls, 50 * s).addScaledVector(UP, h);
        if (!this.walled(this.widePos, _p) && !this.walled(this.widePos, _v) && !this.walled(this.widePos, I.heroC)) return true;
      }
    }
    return false;
  }

  endDriveShot() {
    this.driveShot = false;
    this.clearShot();
  }

  carry(dt) {
    const I = this.inv, H = I.player;
    if (this.carryMode === 'spin') { this.whirl(); return; }
    if (this.carryMode === 'ram') { this.ram(dt); return; }
    if (this.carryMode === 'drive') { this.drive(dt); return; }
    this.carryT -= dt;
    this.anim.lift = 1;
    const sk = spaceK(this.pos.y);
    this.boosting = true;
    _d.set(0, 1, 0);
    this.vel.lerp(_d.multiplyScalar(lerp(190, 1200, sk)), 1 - Math.exp(-4 * dt));
    // Над головой
    H.pos.copy(this.pos).addScaledVector(UP, 2.0);
    H.vel.copy(this.vel);
    if (this.carryT > 0) return;
    this.releaseHero();
    this.anim.lift = 0;
    this.boosting = false;
    // Вниз, в город
    const dir = _v.copy(this.facing).multiplyScalar(0.55).setY(-1).normalize().clone();
    I.hurtHero(DMG.hurl, dir.clone().multiplyScalar(lerp(420, 800, sk)), false, 0);
    this.bigHitFX(I.heroC.clone(), dir, 0.9);
    this.startPunch(1);
    this.go('recover');
    this.recoverT = 0.5;
  }

  // Рывки вырывающегося героя (см. Player.update)
  struggle() {
    if (this.state !== 'carry' || this.opening) return;
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
    if (H.captured === this) { H.captured = null; H.poseQ = null; }
    this.anim.lift = 0;
  }

  // Герой нажал полёт: рука соскользнула, и он уходит
  breakFree() {
    const H = this.inv.player;
    this.ramShot = false;
    this.releaseHero();
    H.knockT = 0;
    this.boosting = false;
    this.blow = null;
    this.poseQ = null;
    this.vel.multiplyScalar(0.4);
    this.clearShot();
    this.go('recover');
    this.recoverT = 0.35;
  }

  // Каждое здание на пути бьёт по герою, которого он тащит
  onPierce() {
    if (this.state !== 'carry') return;
    const I = this.inv;
    I.hurtHero(3, null, false, 0);
    // Во вступлении каждый дом — удар: запинка, рывок объектива и крен камеры
    if (this.carryMode === 'ram') {
      this.ramWalls++;
      I.player.hitstop = Math.max(I.player.hitstop, 0.035);
      I.fx.crashZoom(5, 0.1);
      this.ramKick = this.ramSide * (this.ramWalls % 2 ? 0.16 : -0.12);
    }
  }

  // Первое, что он делает, когда десант кончился: огромным кругом проходит по небу над городом и выходит прямо на героя,
  // хватает, тащит перед собой сквозь дома к центру и швыряет.
  // Это сцена: от неё не увернуться и не вырваться. Герой уже в космосе: туда она не дотянется.
  // Круг заканчивается курсом на центр города: дальше он несёт туда же, не сворачивая
  startTackle() {
    const I = this.inv, H = I.player, h = I.heroC;
    if (H.pos.y > 4000) return false;
    const V = this.arcV.set(-H.pos.x, 0, -H.pos.z);
    if (V.length() < 400) V.copy(I.camRig.direction).setY(0);
    if (V.lengthSq() < 0.01) V.set(0, 0, 1);
    V.normalize();
    // U — от центра круга к герою: герой в нижней его точке, остальной круг выше, в небе
    this.arcU.crossVectors(V, UP).multiplyScalar(Math.random() < 0.5 ? -Math.cos(ARC_TILT) : Math.cos(ARC_TILT)).addScaledVector(UP, -Math.sin(ARC_TILT));
    this.arcC.copy(h).addScaledVector(this.arcU, -ARC_R);
    this.arcN.crossVectors(this.arcU, V).normalize();
    if (this.arcN.y < 0) this.arcN.negate();
    this.arcH.copy(h);
    this.arcPoint(_p, 0);
    this.pos.copy(_p).addScaledVector(UP, -1);
    this.c.copy(_p);
    this.vel.set(0, 0, 0);
    I.fx.arcXarg.clear();
    I.fx.arcXarg.life = 9;
    I.fx.arcXarg.width = 1.6;
    this.go('tackle');
    this.grounded = false;
    this.tackled = false;
    this.boomed = false;
    this.arcT = 0;
    // Герой ждёт и смотрит на него
    H.driven = this.heroWaits;
    H.punchT = -1;
    H.charge = 0;
    H.dashT = 0;
    H.slamming = false;
    H.knockT = 0;
    H.lasering = false;
    H.blow = null;
    H.poseQ = null;
    this.introS = 0;
    this.pickWideShot();
    this.placeWideShot();
    I.camRig.shot = this.shot;
    I.fx.cineFor(INTRO_LEN + 1);
    return true;
  }

  // Точка на круге через t секунд. Круг замыкается на том месте, где герой сейчас, даже если он ещё дрейфует
  arcPoint(out, t) {
    const e = Math.min(1, t / INTRO_LEN), a = ARC_SPAN * (1 - Math.pow(e, 1.25));
    out.copy(this.arcC).addScaledVector(this.arcU, ARC_R * Math.cos(a)).addScaledVector(this.arcV, -ARC_R * Math.sin(a));
    return out.addScaledVector(_v.subVectors(this.inv.heroC, this.arcH), e * e);
  }

  // Общий план издалека: камера низко за городом, город внизу кадра, над ним весь круг в небе.
  // С той стороны, где корабль дальше и не закрывает кадр, и на высоте, где не упирается в ближние дома
  pickWideShot() {
    const I = this.inv, S = this.shot, city = this.W.city, ship = I.ship.group.position;
    _d.copy(this.arcN).setY(0).normalize().multiplyScalar(ARC_R * 2.6);
    _p.copy(this.arcC).add(_d);
    _r.copy(this.arcC).sub(_d);
    S.pos.copy(_p.distanceToSquared(ship) > _r.distanceToSquared(ship) ? _p : _r);
    const gy = city.groundHeightAt(S.pos.x, S.pos.z, 3000);
    for (const up of [70, 130, 210, 320, 480]) {
      S.pos.y = gy + up;
      _d.subVectors(this.arcC, S.pos).normalize();
      if (!this.walled(S.pos, _p.copy(S.pos).addScaledVector(_d, 320))) break;
    }
  }

  placeWideShot() {
    const S = this.shot;
    S.look.lerpVectors(this.arcC, this.c, 0.04);
    S.look.y -= ARC_R * 0.2;
    S.fov = lerp(54, 50, Math.min(1, this.arcT / INTRO_WIDE));
  }

  // Герой тормозит и висит лицом к нему
  waitHero(dt) {
    const H = this.inv.player;
    if (this.state !== 'tackle') { H.driven = null; H.lockDir = null; return; }
    H.vel.multiplyScalar(Math.exp(-3 * dt));
    if (H.grounded) H.vel.set(0, 0, 0);
    H.pos.addScaledVector(H.vel, dt);
    this.inv.chain.keepAbove(H);
    H.lockDir = (H.lockDir || new THREE.Vector3()).subVectors(this.c, this.inv.heroC).normalize();
  }

  // За спиной героя, объектив на нём издалека. Чем ближе он, тем шире кадр, и в конце в нём оба
  placeIntroShot(s) {
    const I = this.inv, S = this.shot, h = I.heroC;
    _d.subVectors(this.c, h);
    const d = _d.length();
    _d.divideScalar(d || 1);
    _r.crossVectors(_d, UP);
    if (_r.lengthSq() < 0.01) _r.set(1, 0, 0);
    _r.normalize();
    S.pos.copy(h).addScaledVector(_d, -6).addScaledVector(_r, 1.7 * s).addScaledVector(UP, 0.7);
    const gy = I.world.city.groundHeightAt(S.pos.x, S.pos.z, S.pos.y + 1) + 0.6;
    if (S.pos.y < gy) S.pos.y = gy;
    const near = smoothstep(1100, 120, d);
    S.look.lerpVectors(this.c, h, d > 1 ? near * 8 / d : 0);
    S.fov = lerp(4, 52, near);
  }

  tackle(dt) {
    const I = this.inv, W = this.W, H = I.player, d = this.dist;
    this.boosting = true;
    this.faceTarget = false;
    this.arcT += dt;
    const e = Math.min(1, this.arcT / INTRO_LEN), left = INTRO_LEN - this.arcT;
    if (dt > 0) this.vel.subVectors(this.arcPoint(_p, this.arcT + dt), this.c).divideScalar(dt);
    if (!this.tackled && left < 1.5) {
      this.tackled = true;
      I.fx.play('rush', { gain: 1 }) || W.audio?.whoosh(1);
    }
    if (!this.boomed && d < 420) {
      this.boomed = true;
      I.fx.play('sonicBoom', { gain: 0.8 });
      I.fx.airRing(this.c, this.aim, 22, 0.5, 0.5);
    }
    if (this.arcT < INTRO_WIDE) this.placeWideShot();
    else {
      // Склейка: теперь он летит прямо на героя, из-за его спины
      if (!this.introS) {
        this.placeIntroShot(1);
        this.introS = W.city.isInside(this.shot.pos) ? -1 : 1;
        I.fx.play('sonicBoom', { gain: 0.45 });
      }
      this.placeIntroShot(this.introS);
    }
    if (e < 1 && d > Math.max(3.2, this.vel.length() * dt)) return;
    // Долетел: рука на горле, и сразу понёс
    this.clearShot();
    I.fx.arcXarg.life = 3;
    I.fx.arcXarg.width = 1;
    if (H.driven === this.heroWaits) H.driven = null;
    H.lockDir = null;
    this.opening = true;
    this.vel.clampLength(0, 520);
    this.beginCarry('ram');
    I.fx.hit(I.heroC.clone(), this.aim.clone(), 1);
    I.fx.play('bigBoom', { gain: 0.9 });
    I.hurtHero(6, null, false, 0);
    H.hitstop = Math.max(H.hitstop, 0.07);
    I.slowFor(0.3, 0.3);
    I.fx.crashZoom(10, 0.25);
    I.fx.cineFor(3.8);
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
    this.blow = null;
    this.poseQ = null;
    this.chainN = 0;
    this.chainMax = this.tempo.hits;
    this.chainPause = 0.12;
    this.chainStep = 'pause';
  }

  // Его удар виден сбоку: в кадре оба тела, и замах, и как героя уносит
  startShot(dist = 6.5, life = 1.1, up = 0.8) {
    const I = this.inv, R = I.camRig, S = this.shotS;
    if (R.shot) return;
    _lc.lerpVectors(this.c, I.heroC, 0.5);
    S.subVectors(I.heroC, this.c).cross(UP);
    if (S.lengthSq() < 0.01) S.set(1, 0, 0);
    S.normalize();
    if (Math.random() < 0.5) S.negate();
    const blocked = () => this.walled(_ls.copy(_lc).addScaledVector(S, dist).addScaledVector(UP, up), _lc);
    if (blocked()) {
      S.negate();
      if (blocked()) return;
    }
    this.shotDist = dist;
    this.shotUp = up;
    this.shotT = life;
    this.shot.pos.copy(_ls);
    this.shot.look.copy(_lc);
    this.shot.fov = 50;
    R.shot = this.shot;
  }

  // Камера в доме или дом между ней и тем, на что она смотрит
  walled(from, to) {
    const n = clamp(Math.ceil(from.distanceTo(to) / 8), 3, 30);
    for (let i = 0; i < n; i++) {
      if (this.W.city.sphereQuery(_v2.lerpVectors(from, to, i / n), 3, this.hits).some((b) => b.alive) || this.W.city.inFalling(_v2, 3)) return true;
    }
    return false;
  }

  updateShot(rdt) {
    const I = this.inv, S = this.shot;
    this.shotT -= rdt;
    if (this.shotT <= 0) { this.clearShot(); return; }
    const close = this.state === 'carry' || this.chainStep === 'coil' || this.chainStep === 'drive';
    _lc.lerpVectors(this.c, I.heroC, close ? 0.5 : 0.85);
    S.look.lerp(_lc, 1 - Math.exp(-12 * rdt));
    if (close) {
      _ls.copy(_lc).addScaledVector(this.shotS, this.shotDist).addScaledVector(UP, this.shotUp);
      S.pos.lerp(_ls, 1 - Math.exp(-6 * rdt));
    }
    const gy = this.W.city.groundHeightAt(S.pos.x, S.pos.z, S.pos.y + 1) + 0.6;
    if (S.pos.y < gy) S.pos.y = gy;
    // Героя уносит: объектив сужается вслед за ним
    S.fov = clamp(50 * 14 / Math.max(1, S.pos.distanceTo(I.heroC)), 16, 50) - I.fx.zoom * 0.5;
  }

  clearShot() {
    this.shotT = 0;
    this.ramShot = false;
    this.shot.roll = 0;
    const R = this.inv.camRig;
    if (R && R.shot === this.shot) R.shot = null;
  }

  // Те же кадры, что у серии героя: рывок, долгий замах в замедлении, кулак, стоп-кадр.
  // На замахе есть время ответить: рывок уводит, встречный удар может разбить серию о кулак
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
        // Издалека идёт на сверхзвуке: хлопок доходит раньше него
        if (d > 100) I.fx.play('sonicBoom', { gain: 0.55, pos: this.c });
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
      const closing = this.chainN >= this.chainMax - 1;
      this.blow = { side: this.chainN % 2 ? 'L' : 'R', f: 0, k: 0, pitch: 0, kind: closing ? 'hammer' : KINDS[this.chainN % KINDS.length] };
      this.poseQ = this.quat.clone();
      I.timeScale = 0.3;
      I.fx.play('preHit', { rate: 0.62 / 0.56 });
      I.theme.duck(0.65);
      if (this.chainN === 0 || closing) this.startShot();
      return;
    }
    const ts = Math.max(I.timeScale, 0.05), b = this.blow, way = BLOW_WAY[b.kind];
    // Идёт к точке над героем, если бьёт сверху
    _d.subVectors(I.heroC, this.c);
    _d.y += way.rise;
    const g = _d.length();
    _d.divideScalar(g || 1);
    if (this.chainStep === 'coil') {
      this.coilLeft -= rdt;
      b.k = Math.min(1, b.k + rdt / 0.1);
      b.f = clamp(1 - this.coilLeft / this.coilAll, 0, 1);
      aimBlow(this.poseQ, this.aim, b, rdt, 12);
      this.vel.copy(_d).multiplyScalar(Math.max(0, g - way.gap - 1.15) / (Math.max(this.coilLeft, 0.02) * ts));
      if (this.coilLeft <= 0) {
        this.chainStep = 'drive';
        this.coilLeft = 0.11;
        I.timeScale = 0.4;
        I.fx.play('swing', { gain: 0.95, pos: this.c, rate: b.kind === 'hammer' ? 0.8 : 1 });
      }
      return;
    }
    this.coilLeft -= rdt;
    b.f = 1 + clamp(1 - this.coilLeft / 0.11, 0, 1);
    aimBlow(this.poseQ, this.aim, b, rdt, 22);
    this.vel.copy(_d).multiplyScalar(Math.max(0, g - way.gap) / (Math.max(this.coilLeft, 0.02) * ts));
    if (this.coilLeft > 0) return;
    // Касание
    this.vel.multiplyScalar(0.05);
    if (H.dashT > 0) { this.chainEnd(); I.onDodge(this); return; }
    if (((H.punchT >= 0 && H.punchT < (H.punchHitAt ?? P.punchHitTime) + 0.16) || I.chain.meeting) && Math.random() < 0.5) { this.chainEnd(); I.clash(this); return; }
    const n = this.chainN++, lastHit = n >= this.chainMax - 1;
    // Героя уносит туда, куда толкает удар: боковой поперёк, с разворота в другую сторону, сверху в землю
    const s = b.side === 'R' ? -1 : 1;
    _v2.crossVectors(this.aim, UP);
    if (_v2.lengthSq() < 0.01) _v2.set(1, 0, 0);
    _v2.normalize();
    _v.copy(this.aim);
    if (b.kind === 'hammer') _v.set(this.aim.x * 0.4, -1, this.aim.z * 0.4);
    else if (b.kind === 'hook') _v.addScaledVector(_v2, s * 0.8).addScaledVector(UP, 0.1);
    else if (b.kind === 'back') _v.addScaledVector(_v2, -s * 0.7).addScaledVector(UP, 0.25);
    else _v.addScaledVector(UP, 0.35);
    _v.normalize();
    const sk = spaceK(this.pos.y);
    I.timeScale = 1;
    reelHit(H.reel, lastHit ? 1.3 : 1.05, n % 3);
    const kick = _v.clone();
    I.hurtHero(lastHit ? DMG.chain[3] : DMG.chain[n], kick.clone().multiplyScalar(lerp(lastHit ? 640 : 420, 900, sk)), false, 0);
    I.fx.chainHit(I.heroC.clone(), kick, 2 + n, lastHit, I.heroBody);
    I.fx.chainRelease(I.heroC, kick, 2 + n, lastHit, I.heroBody);
    I.slowFor(0.22, 0.42);
    if (lastHit || !I.heroAlive) { this.chainEnd(); return; }
    this.chainPause = 0.35;
    this.chainStep = 'pause';
  }

  chainEnd() {
    this.boosting = false;
    if (this.state === 'chain') {
      // Удар сорвался на замахе: кадр больше незачем держать
      if (this.chainStep === 'coil' || this.chainStep === 'drive') { this.inv.timeScale = 1; this.blow = null; this.poseQ = null; this.clearShot(); }
      this.chainStep = null;
      this.cd.chase = 2.2 - this.phase * 0.4;
      this.go('recover');
      this.recoverT = 0.45;
    }
  }

  // Собрался в воздухе: резко тормозит корпусом, миг висит на месте и сразу идёт в ответ
  startRegain() {
    this.knock = 0;
    if (this.grounded || this.pos.y - this.groundY < 1.5) {
      this.go('neutral');
      this.thinkT = 0.1;
      return;
    }
    this.go('regain');
    this.regainT = 0.38 - this.phase * 0.07 + Math.random() * 0.1;
    this.W.effects.shockwave(this.c.clone(), { type: 'disc', dir: _v.copy(this.vel).normalize().clone(), radius: 10, life: 0.35, opacity: 0.55 });
    this.inv.fx.play('brake', { pos: this.c });
  }

  regain(dt) {
    this.vel.multiplyScalar(Math.exp(-14 * dt));
    this.braking = this.vel.length() > 12;
    this.regainT -= dt;
    if (this.regainT > 0) return;
    this.go('neutral');
    this.setMode('press');
    this.thinkT = lerp(this.tempo.think[0], this.tempo.think[1], Math.random());
    if (this.dist > 700 || this.cd.rest > 0 || this.inv.pendingClimb) return;
    // Пока собирался, герой ушёл: дальше обычная погоня, а не бросок через полнеба
    const H = this.inv.player;
    if (this.dist > 60 && H.speed > 120 && H.vel.dot(this.aim) > 0) return;
    const r = Math.random();
    if (this.cd.grab <= 0 && r < 0.35) this.startGrab();
    else if (this.cd.shoulder <= 0 && this.dist > 24 && r < 0.6) this.startShoulder();
    else this.strike();
  }

  // ---------------------------------------------------------------- подъём: зовёт бой наверх
  startClimb() {
    if (this.climbed) return false;
    this.climbed = true;
    this.go('climb');
    this.grounded = false;
    this.lasering = false;
    this.charge = 0;
    this.climbY = Math.max(24000, this.pos.y + 20000);
    return true;
  }

  climb(dt) {
    const I = this.inv, H = I.player;
    const sk = spaceK(this.pos.y);
    const above = this.pos.y >= this.climbY - 200;
    this.boosting = !above;
    this.faceTarget = above;
    // Герой летит следом: держится впереди на виду и ведёт его за собой
    const follows = H.vel.y > 150;
    if (!above) {
      const top = lerp(1500, 7000, sk);
      _d.set(0, 1, 0);
      this.vel.lerp(_d.multiplyScalar(follows ? clamp(H.vel.y + (500 - this.dist) * 1.5, 200, top) : top), 1 - Math.exp(-2 * dt));
      this.grounded = false;
    } else {
      this.vel.multiplyScalar(Math.exp(-3 * dt));
      if (this.dist < 3000) { this.go('neutral'); this.thinkT = 0.4; return; }
    }
    if (follows) this.t = Math.min(this.t, 8);
    // Не полетел следом: падает на него сам, с самого верха
    if (this.t > 16) I.story.startMeteor();
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
    if ((H.punchT >= 0 && H.punchT < (H.punchHitAt ?? P.punchHitTime) + 0.1) || I.chain.meeting) {
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
    if (this.driveShot && this.state !== 'carry') this.endDriveShot();
    for (const k in this.cd) this.cd[k] -= dt;
    if (this.evadeCd > 0) this.evadeCd -= dt;
    this.dist = this.lookAtPoint(I.heroC);
    followBlow(this, I.realDt || dt);
    if (this.shotT > 0) this.updateShot(I.realDt || dt);
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
        // Смотрит с высоты, как дерётся десант. Герой улетел — идёт следом и держится поодаль
        if (this.dist > 350) this.watchAt.copy(I.heroC).addScaledVector(this.aim, -220).addScaledVector(UP, 70);
        _d.copy(this.watchAt).sub(this.pos).multiplyScalar(this.dist > 350 ? 0.25 : 1.2);
        if (this.dist <= 350) _d.clampLength(0, 90);
        this.vel.lerp(_d, 1 - Math.exp(-3 * dt));
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
      case 'shoulder': this.shoulder(dt); break;
      case 'regain': this.regain(dt); break;
      case 'seized': break;
      case 'climb': this.climb(dt); break;
      case 'brawl': this.brawl(dt); break;
      case 'meteor': I.story.meteorTick(dt); break;
      case 'cut': this.vel.multiplyScalar(Math.exp(-5 * dt)); break;
      case 'guard':
        this.vel.multiplyScalar(Math.exp(-6 * dt));
        if (this.t > 0.4) {
          // Два-три блока подряд — и он отвечает сам
          if (this.guarded >= 2) { this.guarded = 0; this.guardK = 0; this.strike(); }
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
          else if (this.dist < 60 && this.cd.rest <= 0 && Math.random() < 0.7) this.strike();
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
        if (this.knock <= 0) this.startRegain();
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
    this.clearShot();
  }
}
