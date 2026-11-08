import * as THREE from 'three';
import { spaceK } from './kin.js';
import { BODIES } from '../world/bodies.js';
import { aimBlow, blowQuat, BLOW_WAY, followBlow, reelHit, tickReel } from '../player/model.js';
import { clamp, damp, lerp, smoothstep } from '../utils.js';

// Серия ударов. Каждый удар — отдельный кадр, как в кино, и каждый начинается только с нажатия:
// рывок к цели → время вязнет, герой замахивается всем телом (камера уходит вбок) →
// кулак идёт к цели → стоп-кадр → тело цели складывается вокруг кулака, кулак давит его дальше →
// воздух рвётся, и цель уносит. Пока она летит, можно нажать удар ещё раз и догнать её.
// Подлетать самому не надо: цель на нормальной дистанции герой находит сам. Клавиши выбирают, каким будет удар.
// Цель ведёт себя так, как будто её и правда гонят: врезается в здания, уходит ввысь или в землю.
//
// Чистая ЛКМ по генералу снята иначе, одним кадром: без замедления и без замаха. Камера едет вплотную за плечом
// героя и обходит его с креном, он на полном ходу настигает цель, кулак входит за пару кадров, рука остаётся вытянутой,
// цель сразу уносит, и следом склейка: длинный объектив с другого конца её пути, она летит прямо на камеру.
// Клавиши (A/D, S, Пробел, C, Shift) и заряд по-прежнему дают кадры с замахом.

const MAX_HITS = 6;
const DMG = [34, 40, 48, 58, 70, 120];
const RUSH = 300;              // м: с такого расстояния нажатие само несёт героя к цели (в космосе втрое дальше)
const SHOULDER = [18, 200];    // м: для удара плечом нужен разгон: в упор его не сделать, издалека он не долетит
const HOLD = 0.55;             // с: столько цель успевает отлететь, прежде чем герой пойдёт за ней
const BUF = 0.25;              // с: столько ждёт нажатие, пока герой приходит в себя
const FILM_COIL = 0.4;         // с: кулак заведён назад ещё на подлёте, цель уже растёт в кадре
const FILM_DRIVE = 0.12;       // с: кулак идёт к цели
const FILM_LUNGE = 1.35;       // в последний миг герой бросается вперёд быстрее, чем летел, и уходит от камеры
const FILM_HOLD = 0.25;        // с: столько цель успевает отлететь, прежде чем герой пойдёт за ней
const FILM_CUT = 0.6;          // с: столько после удара камера летит с героем за целью, дальше склейка
const FILM_LEAN = 1.0;         // наклон корпуса в ударе: герой не встаёт в полёте, рука идёт вдоль линии полёта
// Удары серии на чистой ЛКМ. Последний — сверху или снизу, смотря куда смотрит герой
const KINDS = ['straight', 'hook', 'straight', 'back', 'shoulder'];
// Узор направлений: удары идут то вправо-вверх, то влево — серия не летит по прямой
const PATTERN = [[0.5, 0.35], [-0.6, 0.2], [0.3, 0.7], [-0.4, -0.15], [0.6, 0.4]];
// Как разыгрывается удар: замах и ход кулака, как вязнет время на замахе, сколько кулак давит цель,
// как далеко её уносит, куда она сгибается (тело, челюсть, бок) и откуда снимает камера.
// Камера: a вбок, b вверх, c вперёд к цели; arc — дуга, которую она проходит за замах
const STAGE = {
  straight: { coil: 0.46, drive: 0.12, slow: 0.2, push: 0.24, mul: 1 },
  hook: { coil: 0.58, drive: 0.14, slow: 0.16, push: 0.3, mul: 1.1, reel: 2, angle: { a: 4.2, b: -0.7, c: 1.4, fov: 42, arc: -0.75 } },
  back: { coil: 0.74, drive: 0.12, slow: 0.14, push: 0.32, mul: 1.2, reel: 2, angle: { a: 3.2, b: -1.2, c: -0.8, fov: 40, arc: 1.5 } },
  shoulder: { coil: 0, drive: 0, slow: 0.32, push: 0.02, mul: 1.35, reel: 0, angle: { a: 3.2, b: 0.9, c: 6.5, fov: 46 } },
  hammer: { coil: 0.6, drive: 0.13, slow: 0.16, push: 0.28, mul: 1.25, reel: 0, angle: { a: 3, b: 3.8, c: 0.6, fov: 44, arc: 0.5 } },
  upper: { coil: 0.52, drive: 0.12, slow: 0.18, push: 0.28, mul: 1, reel: 1, angle: { a: 2.8, b: -3.2, c: 1, fov: 48, arc: -0.5 } },
};
// Прямые удары: вбок, снизу, из-за спины цели. Кулак всегда виден
const ANGLES = [
  { a: 5, b: 0.6, c: -0.5, fov: 40 },
  { a: 3.4, b: -3, c: 1.1, fov: 46 },
  { a: 1.5, b: 0.5, c: 4.6, fov: 44 },
];
const FINAL_ANGLE = { a: 6.6, b: 0.9, c: -0.4, fov: 34 };
const SUPER_ANGLE = { a: 5, b: -1.5, c: -1, fov: 34, arc: 1.2 };
const PLOW_ANGLE = { a: 6, b: 1, c: -1.5, fov: 58 };
// Генерал в этих состояниях занят сценой или ещё не вступил: серию на нём не начать
const CLOSED = ['wait', 'descend', 'stand', 'watch', 'approach', 'scene', 'meteor', 'beamlock', 'climb', 'carry', 'tackle', 'seized', 'held', 'brawl', 'dead'];
const UP = new THREE.Vector3(0, 1, 0);
const _d = new THREE.Vector3(), _v = new THREE.Vector3(), _r = new THREE.Vector3(), _s = new THREE.Vector3(), _cp = new THREE.Vector3();
const _p0 = new THREE.Vector3(), _k0 = new THREE.Vector3(), _f = new THREE.Vector3(), _a = new THREE.Vector3(), _o = new THREE.Vector3();
const _fq = new THREE.Quaternion();

export class Chain {
  constructor(inv) {
    this.inv = inv;
    this.kin = null;
    this.state = null;   // chase | window | tail
    this.phase = null;   // для chase: rush | coil | drive | push | plow
    this.fresh = false;  // первый удар ещё идёт: серии пока нет, цель может его встретить
    this.queued = false;
    this.keys = { x: 0, y: 0, z: 0, boost: false, heavy: 0 };   // что было зажато в момент нажатия
    this.buf = 0;
    this.readyAt = 0;
    this.n = 0;
    this.best = 0;
    this.side = 1;
    this.hits = [];
    this.aim = new THREE.Vector3();
    this.from = new THREE.Vector3();
    this.hitDir = new THREE.Vector3(0, 0, 1);
    this.camS = new THREE.Vector3();
    this.camU = new THREE.Vector3();
    this.camD = new THREE.Vector3();
    this.camPull = 0;      // на сколько герой в рывке ушёл от камеры
    this.whip = 0;         // крен камеры от удара
    this.shot = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 40, roll: 0 };
    this.film = false;     // удар идёт одним кадром, в настоящем времени
    this.filmRig = false;  // камера за плечом героя
    this.tele = false;     // камера на пути цели
    this.driven = (dt) => this.chase(dt);
  }

  reset() {
    this.kin = null;
    this.state = null;
    this.phase = null;
    this.fresh = false;
    this.n = 0;
    this.best = 0;
    this.queued = false;
    this.buf = 0;
    this.readyAt = 0;
    this.heavyC = 0;
    this.side = 1;
    this.film = false;
    const P = this.inv.player;
    if (P.driven === this.driven) P.driven = null;
    P.blow = null;
    P.poseQ = null;
    this.clearShot();
  }

  get active() { return !!this.kin; }

  // В серии героя не достать; пока идёт первый удар по генералу, его ещё можно сбить
  get safe() { return !!this.kin && (!this.fresh || this.kin.kind !== 'general'); }

  // Кулак уже идёт: столкнётся со встречным ударом
  get striking() { return this.phase === 'coil' || this.phase === 'drive'; }

  // Встречный удар: кулаки сходятся только на последнем отрезке
  get meeting() { return this.phase === 'drive' || (this.phase === 'coil' && this.left < 0.05); }

  // Нажатие дойдёт до следующего удара: кулак уже дошёл или цель уже летит. На рывке и замахе оно ничего не значит
  get accepting() { return this.state === 'window' || this.phase === 'drive' || this.phase === 'push' || this.phase === 'plow'; }

  // Ничто не держит героя: можно идти в удар
  get free() {
    const I = this.inv, P = I.player;
    return !this.kin && !P.driven && !P.captured && !P.held && P.knockT <= 0 && !P.slamming && I.time >= this.readyAt;
  }

  get ready() { return this.free && this.inv.player.charge <= 0; }

  // Докуда нажатие само несёт героя. На большой скорости — дальше
  get far() {
    const P = this.inv.player;
    return Math.max(lerp(RUSH, RUSH * 3, spaceK(P.pos.y)), P.speed * 0.6);
  }

  // Кого бить: ближайший в поле зрения, генерал важнее; если там пусто — ближайший вообще.
  // Последний размен и упор лучей идут своим ходом
  pickTarget() {
    const I = this.inv;
    if (I.story.lock || I.story.brawlOn || I.finale.on || I.heroDown) return null;
    const far = this.far, t = I.findTarget(far) || I.nearestTarget(far);
    return t && !(t.kind === 'general' && CLOSED.includes(t.state)) ? t : null;
  }

  remember(input, heavy = 0) {
    const K = this.keys;
    K.x = input?.moveX || 0;
    K.y = input?.moveY || 0;
    K.z = input?.moveZ || 0;
    K.boost = !!input?.boost;
    K.heavy = heavy;
  }

  // ЛКМ. Один удар на одно нажатие. false — бить некого: это обычный удар
  press(input) {
    if (this.kin) {
      if (this.accepting) {
        this.remember(input);
        this.queued = true;
      }
      return true;
    }
    if (!this.ready) {
      this.remember(input);
      this.buf = BUF;
      return true;
    }
    const t = this.pickTarget();
    if (!t) return false;
    this.remember(input);
    this.startOn(t);
    return true;
  }

  // ПКМ отпущена (вызывает герой): супер-удар. Бить некого — обычный заряженный удар
  releaseHeavy(c) {
    const I = this.inv, P = I.player;
    if (this.kin) {
      if (this.accepting) {
        this.remember(I.input, c);
        this.queued = true;
      }
      return;
    }
    const t = this.free ? this.pickTarget() : null;
    if (!t) {
      I.snapHeavy();
      P.heavyPunch(I.camRig.direction, c);
      return;
    }
    this.remember(I.input, c);
    this.startOn(t);
  }

  // Каждый кадр перед ходом героя: нажатие, которое ждало, пока он придёт в себя
  tick(dt) {
    if (this.buf <= 0) return;
    this.buf -= dt;
    if (!this.ready) return;
    this.buf = 0;
    const t = this.pickTarget();
    if (t) this.startOn(t);
  }

  // Первый удар: серии ещё нет, герой просто идёт к цели
  startOn(kin) {
    this.kin = kin;
    this.n = 0;
    this.fresh = true;
    this.beginChase();
  }

  // Начало серии другим способом: брошенная машина, таран, бросок. kind: punch | heavy | ram | throw | slam | car
  open(kin, dir, kind, power = 0) {
    if (this.kin === kin) {
      if (this.state === 'window') { reelHit(kin.reel, 0.7, this.n % 3); this.launch(kin, dir, 0.7 + power * 0.5); }
      return true;
    }
    if (this.kin) return false;
    const I = this.inv;
    this.kin = kin;
    this.n = kind === 'punch' ? 1 : 2;
    this.fresh = false;
    this.queued = false;
    this.film = true;
    kin.chainEnd?.();
    kin.go?.('knock');
    kin.reel.ext = true;
    reelHit(kin.reel, 0.85 + power * 0.3, Math.floor(Math.random() * 3));
    this.hitDir.copy(dir);
    this.launch(kin, dir, 1 + power * 0.6);
    this.openWindow();
    I.bestChain = Math.max(I.bestChain, this.n);
    return true;
  }

  // Отправить цель в полёт; скорость растёт с номером удара, вверх улетает особенно быстро
  launch(kin, dir, mul = 1, knock = 0.5) {
    if (kin.kind === 'general') this.inv.arenaDir(dir, 0.45);
    const sk = spaceK(kin.pos.y);
    const up = smoothstep(0.4, 0.9, dir.y);
    // В космосе не быстрее, чем в небе над городом: иначе цель за секунду уносит из виду
    const speed = lerp(300, 420, sk) * (1 + this.n * 0.12) * (1 + up * 2.5 * (1 - sk)) * mul;
    kin.launch(dir, speed, knock);
  }

  openWindow() {
    this.state = 'window';
    this.phase = null;
    // Ждёт дольше, чем нужно: нажать можно спокойно, удар сам дождётся, пока цель отлетит
    this.windowLen = this.film ? 2.2 : lerp(1.8, 1.4, Math.min(1, (this.n - 1) / (MAX_HITS - 1)));
    this.windowT = 0;
    this.inv.timeScale = this.film ? 1 : 0.16;
  }

  // Цель врезалась и лежит: добить можно, но окно уже не продлевается
  onTargetCrash() {
    if (this.state === 'window') this.windowLen = Math.min(this.windowLen, this.windowT + 0.9);
  }

  // Конец серии: цель приходит в себя, герой снова свободен
  end(keepKnock = false) {
    const I = this.inv, kin = this.kin, P = I.player;
    if (kin) {
      if (!this.fresh) {
        if (kin.alive && kin.knock > 0 && !keepKnock) kin.knock = Math.min(kin.knock, 0.3);
        kin.reel.ext = false;
        // Теперь его очередь: пока собирается и идёт в ответ, новую серию не начать
        if (kin.kind === 'general') kin.cd.answer = Math.max(kin.knock, 0) + 1.2;
      }
      if (this.phase === 'plow') kin.poseQ = null;
    }
    this.kin = null;
    this.state = null;
    this.phase = null;
    this.fresh = false;
    this.queued = false;
    this.heavyC = 0;
    this.film = false;
    I.timeScale = 1;
    if (P.driven === this.driven) P.driven = null;
    P.lockDir = null;
    P.boosting = false;
    P.barrel = 0;
    // Оборвалось на замахе: рука не остаётся занесённой
    if (P.blow && P.blow.f < 2) { P.blow = null; P.poseQ = null; }
    this.clearShot();
  }

  // ---------------------------------------------------------------- кадр: реальное время
  update(realDt) {
    const I = this.inv, P = I.player, kin = this.kin;
    followBlow(P, realDt);
    if (!kin) return;
    if (!I.heroAlive) { this.end(); return; }
    this.updateShot(realDt);
    if (this.fresh) return;
    // Держим цель в отлёте, пока идёт серия: она не может собраться
    if (kin.alive && (kin.state === 'knock' || kin.kind === 'soldier') && kin.state !== 'gone' && kin.state !== 'down') kin.knock = Math.max(kin.knock, 0.3);
    if (!kin.alive && kin.kind === 'soldier' && kin.state !== 'gone' && this.state === 'window') { this.end(); return; }
    // Тело цели живёт в своём времени: при замедлении оно всё равно успевает сложиться
    tickReel(kin.reel, realDt * (P.hitstop > 0 ? 0.04 : 0.8));
    if (kin.state === 'knock') kin.anim.knock = damp(kin.anim.knock, 1, 14, realDt);
    // В кадре без замедления цель уносит далеко: тормозит только её собственный полёт
    if (this.film ? this.phase === 'rush' : this.state !== 'chase' || this.phase === 'rush') kin.vel.multiplyScalar(Math.exp(-2.4 * realDt * I.timeScale));

    if (this.state === 'window') {
      this.windowT += realDt;
      // После стоп-кадра время оживает постепенно: успеваешь увидеть, как цель уносит
      if (!this.film) {
        if (I.slowT <= 0) I.timeScale = lerp(0.16, 0.5, smoothstep(0, 0.7, this.windowT));
        if (this.windowT > 0.75) this.clearShot();
      }
      // Он уже решил идти наверх: следующего удара не будет, иначе подъём можно пропустить совсем
      if (this.queued && this.windowT > (this.film ? FILM_HOLD : HOLD) && !I.pendingClimb) {
        this.beginChase();
        return;
      }
      if (this.windowT >= this.windowLen) this.end();
    } else if (this.state === 'tail') {
      this.tailT -= realDt;
      if (this.tailT <= 0) this.end(true);
    }
  }

  // ---------------------------------------------------------------- какой удар
  // Клавиши в момент нажатия. Без клавиш — та самая серия. Shift работает только на своей дистанции
  pickKind(d) {
    const K = this.keys;
    if (K.boost && d >= SHOULDER[0] && d <= SHOULDER[1] * (1 + 2 * spaceK(this.kin.pos.y))) return 'shoulder';
    if (K.y > 0) return 'upper';
    if (K.y < 0) return 'hammer';
    if (K.x) return 'hook';
    if (K.z < 0) return 'back';
    if (this.heavyC >= 0.35) return 'straight';
    if (this.final) return this.aim.y > 0.35 ? 'upper' : 'hammer';
    if (!this.big) return this.n % 2 ? 'hook' : 'straight';
    const kind = KINDS[this.n % KINDS.length];
    return kind === 'shoulder' && d < SHOULDER[0] ? 'hook' : kind;
  }

  // ---------------------------------------------------------------- рывок к цели
  beginChase() {
    const I = this.inv, P = I.player, kin = this.kin, K = this.keys;
    this.state = 'chase';
    this.phase = 'rush';
    this.queued = false;
    // Камера ещё за плечом героя: следующий удар продолжает тот же кадр
    const take = this.filmRig;
    this.clearShot();
    I.slowT = 0;
    P.driven = this.driven;
    P.punchT = -1;
    P.punchHit = true;
    P.charge = 0;
    P.dashT = 0;
    P.slamming = false;
    P.falling = false;
    P.grounded = false;
    P.knockT = 0;
    P.lasering = false;
    P.poseQ = null;
    P.boosting = true;
    _d.subVectors(kin.c, I.heroC);
    const d = _d.length();
    _d.divideScalar(d || 1);
    // Цель не обязательно там, куда смотрит камера: удар идёт туда, где она
    this.aim.copy(I.camRig.direction);
    if (this.aim.dot(_d) < 0.6) this.aim.copy(_d);
    this.big = kin.kind === 'general';
    this.heavyC = K.heavy;
    K.heavy = 0;
    this.sup = this.heavyC >= 0.35;
    this.final = this.n >= MAX_HITS - 1 || this.heavyC >= 0.85;
    // Без клавиш и без заряда: тот самый удар одним кадром
    this.film = this.big && !this.sup && !K.x && !K.y && K.z >= 0
      && !(K.boost && d >= SHOULDER[0] && d <= SHOULDER[1] * (1 + 2 * spaceK(kin.pos.y)));
    // Цель уходит туда, куда идёт сам кулак, взгляд только чуть доворачивает
    if (this.film) this.aim.lerp(_d, 0.65).normalize();
    this.kind = this.film ? 'straight' : this.pickKind(d);
    const St = STAGE[this.kind];
    this.coilLen = !this.big ? 0.2 : this.sup ? lerp(0.62, 0.95, this.heavyC) : this.final ? 0.68 : St.coil;
    this.driveLen = this.big ? St.drive : 0.09;
    // Руки строго по очереди: левая, правая, левая. Счёт общий с обычными ударами героя.
    // Только боковой с A/D бьёт той рукой, которая гонит цель в эту сторону: вправо её гонит левая
    if (this.kind === 'hook' && K.x) this.side = K.x > 0 ? -1 : 1;
    else this.side = P.punchSide === 'R' ? -1 : 1;
    P.punchSide = this.side > 0 ? 'R' : 'L';
    P.blow = { side: this.side > 0 ? 'R' : 'L', f: 0, k: 0, pitch: 0, kind: this.kind };
    this.hitDir.copy(this.pickDir(kin));
    // Боковой и с разворота заходят сбоку: цель уходит от кулака, а не мимо него
    this.from.copy(this.hitDir).setY(0);
    this.flank = (this.kind === 'hook' || this.kind === 'back') && this.from.lengthSq() > 0.05;
    if (this.flank) this.from.normalize().negate();
    if (this.film) {
      this.left = this.all = clamp(d / 280, 0.36, 1.6);
      this.filmV = d / this.all;
      // Цель не начинает нового удара, пока он летит: прервать его может только то, что уже начато
      kin.thinkT = Math.max(kin.thinkT, this.all + 0.2);
      // Длинный подлёт: герой один раз проворачивается вокруг своей оси, и успевает до замаха
      this.barrelS = this.all - FILM_COIL - FILM_DRIVE > 0.45 && this.n % 2 ? this.side : 0;
      I.timeScale = 1;
      this.startFilmShot(take);
    } else if (this.kind === 'shoulder') {
      // Разгон виден: герой разворачивается боком и набирает ход, время вокруг почти стоит
      this.left = this.all = clamp(d / 420, 0.34, 0.62);
      this.d0 = d;
      this.boomed = false;
      this.swung = false;
      P.poseQ = P.quat.clone();
      I.timeScale = St.slow;
      if (this.big) this.startShot();
    } else {
      this.left = clamp(d / 900, 0.28, 0.5);
      I.timeScale = 0.85;
    }
    I.fx.chainRush(I.heroC, _d);
  }

  // Функция движения героя (player.driven) на время рывка и удара
  chase() {
    const I = this.inv, P = I.player, kin = this.kin;
    if (!kin) { P.driven = null; return; }
    // Цель исчезла раньше, чем кулак дошёл
    if (this.phase !== 'push' && this.phase !== 'plow' && !I.isTarget(kin)) { this.end(); return; }
    const rdt = I.realDt;
    this.left -= rdt;
    if (this.film && this.phase !== 'push') { this.filmFlight(rdt); return; }
    if (this.phase === 'plow') { this.plow(rdt); return; }
    const c = _s.copy(P.pos).addScaledVector(UP, 1), way = BLOW_WAY[this.kind], shoulderRush = this.kind === 'shoulder' && this.phase === 'rush';
    // Лицом к цели. Идёт к точке над ней, если бьёт сверху, и под ней, если снизу; боковой заходит сбоку
    _f.subVectors(kin.c, c).normalize();
    P.lockDir = (P.lockDir || new THREE.Vector3()).copy(_f);
    _a.copy(kin.c);
    if (this.phase !== 'rush') _a.y += way.rise;
    if (this.flank) _d.copy(this.from);
    else _d.subVectors(c, _a).normalize();
    // До какого зазора дойти к концу этапа. Время считаем настоящее: от замедления рывок не зависит
    const gap = shoulderRush ? way.gap : this.phase === 'rush' ? (this.big ? 13 : 6) : this.phase === 'coil' ? way.gap + 1.15 : way.gap;
    _a.addScaledVector(_d, gap);
    _d.subVectors(_a, c);
    const dist = _d.length();
    _d.divideScalar(dist || 1);
    // Плечом разгоняется до самого удара; остальное идёт ровно
    const speed = shoulderRush ? Math.max(60, 2 * this.d0 * (1 - this.left / this.all) / this.all) : dist / Math.max(this.left, 0.02);
    _p0.copy(P.pos);
    P.pos.addScaledVector(_d, this.left <= 0 ? dist : Math.min(speed * rdt, dist));
    P.vel.copy(_d).multiplyScalar(this.phase === 'rush' ? Math.max(speed, 90) : this.phase === 'push' ? 4 : 14);
    if (Math.min(_p0.y, P.pos.y) < 700) this.ram(_p0, P.pos, speed);
    this.keepAbove(P);

    const b = P.blow;
    if (shoulderRush) {
      const k = 1 - this.left / this.all;
      b.k = Math.min(1, b.k + rdt / 0.1);
      b.f = Math.min(1.9, 1.9 * k);
      this.leanTo(_f, rdt, 16);
      if (!this.boomed && k > 0.5) {
        // Звуковой барьер: воздух рвётся кольцом, музыка уходит, остаётся только этот рывок
        this.boomed = true;
        I.fx.airRing(I.heroC, _f, 24, 0.5, 0.5);
        I.fx.play('sonicBoom', { gain: 0.7 });
        I.fx.crashZoom(6, 0.2);
        I.theme.duck(0.85);
      }
      if (!this.swung && this.left < 0.14) {
        this.swung = true;
        I.fx.play('swing', { gain: 0.95, rate: 0.72 });
      }
      if (this.left <= 0 || dist <= 0.3) {
        b.f = 2;
        this.contact();
      }
      return;
    }
    if (this.phase === 'rush') {
      if (this.left <= 0 || dist <= 0.3) this.startCoil();
      return;
    }
    if (this.phase === 'coil') {
      b.k = Math.min(1, b.k + rdt / 0.1);
      b.f = clamp(1 - this.left / this.coilLen, 0, 1);
      this.leanTo(_f, rdt, 12);
      // Супер-удар: кулак наливается светом, пока идёт замах
      if (this.sup && this.big) {
        P.model.fistWorldPos(b.side, _cp);
        I.world.sparks.burst(_cp, 2, { size: [0.12, 0.4], speed: 6, life: [0.15, 0.4], color: 0xffd9a0 });
      }
      if (this.left <= 0) {
        this.phase = 'drive';
        this.left = this.driveLen;
        I.timeScale = 0.3;
        I.fx.play('swing', { gain: 0.95, rate: this.final || this.sup ? 0.8 : 1 });
      }
    } else if (this.phase === 'drive') {
      b.k = 1;
      b.f = 1 + clamp(1 - this.left / this.driveLen, 0, 1);
      this.leanTo(_f, rdt, 22);
      if (this.left <= 0) this.contact();
    } else if (this.phase === 'push') {
      // Кулак вошёл и давит дальше: цель ещё не улетела, тело только складывается
      b.f = 2 + 0.28 * clamp(1 - this.left / this.pushLen, 0, 1);
      if (!this.film) this.leanTo(_f, rdt, 10);
      if (this.left <= 0) {
        if (this.kind === 'shoulder' && !this.dead) this.startPlow();
        else this.release();
      }
    }
  }

  // Подлёт и удар без остановки: ход один и тот же до самого контакта, рука уходит и возвращается прямо в полёте
  filmFlight(rdt) {
    const I = this.inv, P = I.player, kin = this.kin, b = P.blow;
    const c = _s.copy(P.pos).addScaledVector(UP, 1);
    _f.subVectors(kin.c, c).normalize();
    P.lockDir = (P.lockDir || new THREE.Vector3()).copy(_f);
    _a.copy(kin.c).addScaledVector(_f, -BLOW_WAY.straight.gap);
    _d.subVectors(_a, c);
    const dist = _d.length();
    _d.divideScalar(dist || 1);
    // Ход не падает до самого удара: цель идёт навстречу — кулак дойдёт раньше. В последний миг рывок
    const speed = this.filmV = Math.max(this.filmV, dist / Math.max(this.left, 0.02));
    const v = speed * (this.phase === 'drive' ? FILM_LUNGE : 1);
    _p0.copy(P.pos);
    P.pos.addScaledVector(_d, Math.min(v * rdt, dist));
    P.vel.copy(_d).multiplyScalar(v);
    if (Math.min(_p0.y, P.pos.y) < 700) this.ram(_p0, P.pos, v);
    this.keepAbove(P);
    const strike = FILM_COIL + FILM_DRIVE, reach = Math.max(0, dist - v * rdt) / v;
    if (this.barrelS) {
      const e = smoothstep(0, 1, (this.all - this.left) / Math.max(0.05, this.all - strike - 0.05));
      P.barrel = this.barrelS * Math.PI * 2 * e;
    }
    if (reach > strike) return;
    // Кулак заведён ещё на подлёте; корпус из полёта идёт в удар, но не встаёт
    if (this.phase === 'rush') {
      this.phase = 'coil';
      P.barrel = 0;
      P.poseQ = P.quat.clone();
      b.pitch = FILM_LEAN + 0.1;
      I.theme.duck(0.65);
    }
    if (reach > FILM_DRIVE && this.phase === 'coil') {
      b.k = Math.min(1, b.k + rdt / 0.12);
      b.f = smoothstep(0, 0.6, 1 - (reach - FILM_DRIVE) / FILM_COIL);
    } else {
      // Рывок: кулак вперёд, и герой уходит от камеры
      if (this.phase === 'coil') {
        this.phase = 'drive';
        I.fx.play('swing', { gain: 0.95 });
      }
      b.k = 1;
      b.f = 1 + clamp(1 - reach / FILM_DRIVE, 0, 1);
      this.camPull = 2.4 * clamp(1 - reach / FILM_DRIVE, 0, 1);
    }
    P.poseQ.slerp(blowQuat(_fq, _f, FILM_LEAN), 1 - Math.exp(-(this.phase === 'drive' ? 22 : 8) * rdt));
    if (reach <= 0.004) {
      b.f = 2;
      this.contact();
    }
  }

  startCoil() {
    const I = this.inv, P = I.player, kin = this.kin;
    this.phase = 'coil';
    this.left = this.coilLen;
    I.timeScale = !this.big ? 0.4 : this.sup ? 0.12 : STAGE[this.kind].slow;
    if (!this.fresh) kin.vel.multiplyScalar(0.15);
    P.boosting = false;
    P.poseQ = P.quat.clone();
    if (this.big) this.startShot();
    if (this.big && (this.sup || this.final)) I.fx.cineFor(this.coilLen + 1.6);
    // Супер-удар: объектив медленно наезжает весь замах
    if (this.big && this.sup) I.fx.crashZoom(9, this.coilLen);
    // Воздух втягивается и обрывается ровно в момент удара; оркестр уходит заранее
    I.fx.play('preHit', { gain: 0.95, rate: 0.62 / (this.coilLen + this.driveLen) });
    I.theme.duck(0.65);
  }

  // Ведём корпус героя: лицом к цели, с наклоном и поворотом, какие нужны этому удару
  leanTo(dir, rdt, rate) {
    const P = this.inv.player;
    if (!P.poseQ) P.poseQ = P.quat.clone();
    aimBlow(P.poseQ, dir, P.blow, rdt, rate);
  }

  // Герой прошивает здания на пути
  ram(from, to, speed) {
    const W = this.inv.world, city = W.city;
    const n = Math.min(6, Math.ceil(from.distanceTo(to) / 6));
    let smashed = 0;
    for (let i = 1; i <= n && smashed < 3; i++) {
      _r.lerpVectors(from, to, i / n);
      _r.y += 1;
      city.sphereQuery(_r, 1.4, this.hits);
      for (const b of this.hits) {
        if (smashed >= 3) break;
        city.closestPoint(b, _r, _cp);
        const dir = _v.subVectors(to, from).normalize().clone();
        city.destroySeg(b, _cp.clone(), dir, Math.min(speed * 0.25, 140));
        this.inv.fx.pierce(_cp.clone(), dir, speed);
        smashed++;
      }
    }
    return smashed;
  }

  keepAbove(P) {
    const W = this.inv.world;
    P.groundY = W.city.groundHeightAt(P.pos.x, P.pos.z, P.pos.y + 0.5);
    if (P.pos.y < P.groundY) P.pos.y = P.groundY;
    for (const B of BODIES) {
      _v.subVectors(P.pos, B.c);
      const l = _v.length();
      if (l < B.r + 1.5) P.pos.copy(B.c).addScaledVector(_v, (B.r + 1.5) / l);
    }
  }

  // ---------------------------------------------------------------- удар
  contact() {
    const I = this.inv, P = I.player, kin = this.kin, St = STAGE[this.kind], c = this.heavyC, shoulder = this.kind === 'shoulder';
    // Плечо бьёт всем телом: удар там, где сошлись корпуса
    const point = shoulder ? new THREE.Vector3().lerpVectors(I.heroC, kin.c, 0.55) : P.model.fistWorldPos(P.blow?.side || 'R', new THREE.Vector3());
    const dir = this.hitDir;
    if (kin.kind === 'general' && kin.alive) {
      if (this.fresh) {
        // Серии ещё нет: он может успеть встретить удар
        const meet = kin.meetBlow(c);
        if (meet) { this.met(meet, point, dir); return; }
      } else if (Math.random() < kin.tempo.breakChain + 0.06 * (this.n - 1)) {
        // Во второй половине боя иногда успевает встретить кулак и посреди серии
        const k = this.kin;
        this.end();
        I.clash(k);
        return;
      }
    }
    if (this.fresh) {
      this.fresh = false;
      kin.chainEnd?.();
      kin.engage?.();
      I.onFirstBlood();
    }
    const i = Math.min(this.n, MAX_HITS - 1);
    const dmg = c > 0 ? Math.max(DMG[i], 28 + 92 * c) : DMG[i];
    this.n += c > 0.6 ? 2 : 1;
    I.bestChain = Math.max(I.bestChain, this.n);
    this.best = Math.max(this.best, this.n);
    if (kin.kind === 'general') kin.damage(dmg, point, dir, 'chain');
    else {
      kin.hp -= dmg;
      if (kin.hp <= 0) I.onSoldierDown(kin);
    }
    // Генерала могла забрать сцена или конец боя
    if (this.kin !== kin) return;
    this.dead = !kin.alive;
    if (this.dead) { this.film = false; this.clearShot(); }
    // Тело принимает удар. Сразу не улетает: кулак сначала давит его
    reelHit(kin.reel, this.final ? 1.35 : 1.1, St.reel ?? this.n % 3);
    kin.reel.ext = true;
    if (!this.dead) kin.go?.('knock');
    kin.knock = this.dead ? 99 : Math.max(kin.knock, 0.5);
    kin.grounded = false;
    kin.vel.copy(dir).multiplyScalar(22);
    I.timeScale = this.film ? 1 : 0.12;
    this.phase = 'push';
    // Вся тяжесть удара — в BattleFX; никакой тряски, только хит-стоп и объектив
    if (this.dead && kin.kind === 'general') P.hitstop = Math.max(P.hitstop, 0.42);
    else I.fx.chainHit(point, dir, shoulder || this.sup ? Math.max(this.n, 5) : this.n, this.final || this.dead, kin);
    if (shoulder || this.sup) {
      I.fx.airRing(point, dir, 40, 0.6, 0.55);
      I.fx.play('bigBoom', { gain: 0.8 });
    }
    // Одним кадром: удар без стоп-кадра, только короткая запинка. Камеру разворачивает вслед за ударом
    if (this.film) {
      P.hitstop = Math.min(P.hitstop, this.final ? 0.08 : 0.045);
      this.whip = this.camSide * 0.42;
    }
    this.pushLen = this.left = this.film ? P.hitstop + 0.03 : P.hitstop + (!this.big ? (shoulder ? 0.02 : 0.06) : this.final || this.dead ? 0.42 : this.sup ? 0.36 : St.push);
  }

  // Он успел. Первый удар разбился о него: серии не будет
  met(how, point, dir) {
    const I = this.inv, P = I.player, kin = this.kin, b = P.blow;
    this.end();
    if (how === 'clash') { I.clash(kin); return; }
    this.readyAt = I.time + 0.45;
    // Рука идёт до конца, а не застывает занесённой
    if (b) { P.blow = b; P.poseQ = P.quat.clone(); b.f = 2; b.k = 1; }
    P.falling = false;
    P.grounded = false;
    if (how === 'evade') {
      // Кулак прошёл сквозь воздух
      kin.startEvade(dir);
      P.vel.copy(dir).multiplyScalar(26);
      I.fx.airRing(point, dir, 7, 0.3, 0.3);
      I.slowFor(0.3, 0.28);
      return;
    }
    kin.block(point, dir);
    kin.thinkT = Math.min(kin.thinkT, 0.1);
    P.vel.copy(dir).multiplyScalar(-48);
    P.knockT = 0.16;
    I.fx.hit(point, dir, 0.7);
    I.slowFor(0.35, 0.22);
  }

  // Плечо вошло, и герой не останавливается: несёт цель перед собой сквозь всё, что по дороге
  startPlow() {
    const I = this.inv, kin = this.kin;
    this.phase = 'plow';
    this.left = this.pushLen = this.big ? 0.62 : 0.26;
    this.plowV = 170;
    I.timeScale = 0.45;
    kin.poseQ = kin.quat.clone();
    I.fx.play('rush');
    I.fx.cineFor(1.4);
    if (this.big) {
      this.clearShot();
      this.startShot(PLOW_ANGLE);
    }
  }

  plow(rdt) {
    const I = this.inv, P = I.player, kin = this.kin, dir = this.hitDir, b = P.blow;
    this.plowV = Math.min(430, this.plowV + 1300 * rdt);
    _p0.copy(P.pos);
    _k0.copy(kin.pos);
    P.pos.addScaledVector(dir, this.plowV * rdt);
    P.vel.copy(dir).multiplyScalar(this.plowV);
    this.keepAbove(P);
    kin.pos.copy(P.pos).addScaledVector(dir, 1.9);
    kin.vel.copy(dir).multiplyScalar(22);
    kin.grounded = false;
    let smashed = 0;
    if (Math.min(_p0.y, P.pos.y) < 700) smashed = this.ram(_k0, kin.pos, this.plowV) + this.ram(_p0, P.pos, this.plowV);
    if (smashed && kin.alive) {
      if (kin.kind === 'general') kin.damage(5 * smashed, kin.c.clone(), dir, 'ram');
      reelHit(kin.reel, 0.8, 0);
      P.hitstop = Math.max(P.hitstop, 0.04);
      this.plowV *= 0.93;
    }
    if (this.kin !== kin) return;
    b.f = 2 + 0.28 * clamp(1 - this.left / this.pushLen, 0, 1);
    this.leanTo(dir, rdt, 14);
    if (kin.poseQ) blowQuat(kin.poseQ, _v.copy(dir).negate(), -0.3);
    if (this.left <= 0) {
      kin.poseQ = null;
      this.release();
    }
  }

  // Кулак отпускает: цель уносит, воздух рвётся кольцами
  release() {
    const I = this.inv, P = I.player, kin = this.kin, dir = this.hitDir, St = STAGE[this.kind], c = this.heavyC;
    P.driven = null;
    P.falling = false;
    P.grounded = false;
    P.boosting = false;
    // В кадре без замедления герой не останавливается: летит дальше с вытянутой рукой
    P.vel.copy(dir).multiplyScalar(this.film ? 150 : 12);
    this.relT = 0;
    reelHit(kin.reel, 0.5, kin.reel.kind);
    I.fx.chainRelease(kin.c, dir, this.n, this.final || this.dead, kin);
    this.heavyC = 0;
    if (this.dead || this.final) {
      // Финальный удар: большой разгон и долгий кадр
      if (this.dead) kin.launch(dir, lerp(420, 700, spaceK(kin.pos.y)), kin.kind === 'general' ? 99 : 1.5);
      else {
        kin.go?.('knock');
        this.launch(kin, dir, 1.8, 1.6);
        kin.finalHit = true;
      }
      I.theme.stinger();
      if (!this.film) I.slowFor(0.14, 1.1);
      this.state = 'tail';
      this.phase = null;
      this.tailT = this.big ? 1.1 : 0.2;
      return;
    }
    kin.go?.('knock');
    this.launch(kin, dir, St.mul * (1 + c * 0.6) * (this.film ? 2 : 1));
    // Одним кадром герой не тормозит: летит за ней, а она всё равно уходит вдаль
    if (this.film) P.vel.copy(dir).multiplyScalar(clamp(kin.vel.length() * 0.7, 150, 420));
    this.openWindow();
  }

  // Куда полетит цель: взгляд в момент нажатия и сам удар
  pickDir(kin) {
    const K = this.keys, kind = this.kind;
    const d = new THREE.Vector3().copy(this.aim);
    const right = _r.crossVectors(this.aim, UP);
    if (right.lengthSq() < 0.01) right.set(1, 0, 0);
    right.normalize();
    // Боковой гонит поперёк, с разворота в другую сторону, сверху вниз, снизу вверх
    const s = this.side > 0 ? -1 : 1;
    if (kind === 'hook') d.addScaledVector(right, s * 1.3).addScaledVector(UP, 0.12);
    else if (kind === 'back') d.addScaledVector(right, -s * 0.9).addScaledVector(UP, 0.25);
    else if (kind === 'shoulder') d.addScaledVector(UP, 0.08);
    else if (kind === 'hammer') d.set(this.aim.x * 0.35, -1, this.aim.z * 0.35);
    else if (kind === 'upper') d.multiplyScalar(0.35).addScaledVector(UP, 1);
    else {
      const [px, py] = PATTERN[this.n % PATTERN.length];
      d.addScaledVector(right, px * 0.55).addScaledVector(UP, py * 0.55);
    }
    d.normalize();
    // У земли и над городом отправляем вниз только сознательно: взгляд вниз или клавиша C
    if (kind !== 'hammer' && kin.pos.y - kin.groundY < 80 && this.aim.y > -0.45 && K.y >= 0) d.y = Math.max(d.y, 0.12);
    return d.normalize();
  }

  // ---------------------------------------------------------------- кадр удара
  pickAngle() {
    if (this.sup) return SUPER_ANGLE;
    if (this.final) return FINAL_ANGLE;
    return STAGE[this.kind].angle || ANGLES[this.n % ANGLES.length];
  }

  startShot(angle = this.pickAngle()) {
    const I = this.inv, kin = this.kin, city = I.world.city;
    const D = this.camD.subVectors(kin.c, I.heroC).normalize();
    const S = this.camS.crossVectors(D, UP);
    if (S.lengthSq() < 0.01) S.set(1, 0, 0);
    S.normalize();
    this.camU.crossVectors(S, D).normalize();
    this.angle = angle;
    this.camSide = this.side;
    this.camT = 0;
    // Сторона, где нет стены; нет такой — останемся за плечом
    const inside = (s) => city.isInside(this.shotPos(_v, s, 1));
    if (inside(this.camSide)) {
      this.camSide = -this.camSide;
      if (inside(this.camSide)) return;
    }
    this.shotOn = true;
    this.shot.look.lerpVectors(I.heroC, kin.c, 0.5);
    this.shot.fov = this.angle.fov;
    this.updateShot(0);
    I.camRig.shot = this.shot;
  }

  // Центр кадра — середина между героем и целью; dolly > 1 — камера ещё далеко, arc — ещё не дошла по дуге.
  // Плечом на разгоне камера стоит за целью, и герой идёт прямо в объектив
  shotPos(out, side, dolly, arc = 0) {
    const I = this.inv, A = this.angle;
    if (this.kind === 'shoulder' && this.phase === 'rush') out.copy(this.kin.c);
    else if (this.state === 'chase') out.lerpVectors(I.heroC, this.kin.c, 0.5);
    else out.copy(I.heroC).addScaledVector(this.camD, 1.2);
    _o.copy(this.camS).multiplyScalar(A.a * side * dolly).addScaledVector(this.camU, A.b).addScaledVector(this.camD, A.c);
    if (arc) _o.applyAxisAngle(UP, arc);
    // Пока между ними разрыв, камера дальше: в кадре оба, и она наезжает по мере того, как он подходит
    if (this.state === 'chase' && this.phase !== 'rush') {
      const cam = I.camera, fit = I.heroC.distanceTo(this.kin.c) * 0.5 / (0.7 * Math.tan(A.fov * Math.PI / 360) * cam.aspect), l = _o.length();
      if (l < fit) _o.multiplyScalar(fit / l);
    }
    return out.add(_o);
  }

  // Один кадр за плечом героя. Продолжая прежний, камера идёт обратно: то за спину, то почти в профиль
  startFilmShot(take) {
    const I = this.inv, S = this.shot, kin = this.kin;
    if (take) {
      this.filmFrom = this.filmA;
      this.filmTo = this.filmA > 0.75 ? 0.4 : 1.05;
    } else {
      this.filmFrom = 0.3;
      this.filmTo = 1.05;
      this.camSide = this.side;
      this.camT = Math.random() * 6;
      this.camD.subVectors(kin.c, I.heroC).normalize();
    }
    this.filmA = this.filmFrom;
    this.camPull = 0;
    this.filmRig = true;
    this.tele = false;
    this.shotOn = true;
    this.placeFilmShot(0);
    I.camRig.shot = S;
  }

  // Камера вплотную: герой занимает полкадра, цель впереди почти по центру. Крен всё время меняется
  placeFilmShot(rdt) {
    const I = this.inv, P = I.player, kin = this.kin, S = this.shot, D = this.camD;
    this.camT += rdt;
    const h = _s.copy(P.pos).addScaledVector(UP, 1);
    _v.subVectors(kin.c, h);
    if (_v.lengthSq() > 0.01) D.lerp(_v.normalize(), 1 - Math.exp(-7 * rdt)).normalize();
    const R = _r.crossVectors(D, UP);
    if (R.lengthSq() < 0.01) R.set(1, 0, 0);
    R.normalize();
    _o.crossVectors(R, D);
    if (this.state === 'chase' && this.phase !== 'push') {
      const k = clamp(1 - this.left / this.all, 0, 1);
      this.filmA = lerp(this.filmFrom, this.filmTo, k * k * (3 - 2 * k));
    }
    // Рывок уносит героя от камеры, потом она его догоняет
    if (this.phase !== 'drive') this.camPull *= Math.exp(-5 * rdt);
    this.whip *= Math.exp(-4.5 * rdt);
    const a = this.filmA, dist = 2.6 + this.camPull;
    S.pos.copy(h).addScaledVector(D, -Math.cos(a) * dist).addScaledVector(R, Math.sin(a) * dist * this.camSide).addScaledVector(_o, 0.55);
    S.look.copy(h).addScaledVector(D, lerp(30, 1.2, smoothstep(0.45, 0.95, a))).addScaledVector(_o, 0.2);
    const gy = I.world.city.groundHeightAt(S.pos.x, S.pos.z, S.pos.y + 1) + 0.6;
    if (S.pos.y < gy) S.pos.y = gy;
    S.roll = this.camSide * (0.14 + 0.26 * Math.sin(this.camT * 1.3)) + 0.015 * Math.sin(this.camT * 9) + this.whip;
    S.fov = 55 - I.fx.zoom * 0.6;
  }

  // Склейка: длинный объектив впереди на её пути, чуть ниже: она летит на камеру на фоне неба и растёт в кадре
  startTele() {
    const I = this.inv, kin = this.kin, S = this.shot, sp = kin.vel.length();
    if (sp < 60) { this.clearShot(); return; }
    _v.copy(kin.vel).divideScalar(sp);
    _r.crossVectors(_v, UP);
    if (_r.lengthSq() < 0.01) _r.set(1, 0, 0);
    _r.normalize();
    const far = clamp(sp * 0.62, 180, 620);
    S.pos.copy(kin.c).addScaledVector(_v, far).addScaledVector(_r, far * 0.08 * this.camSide).addScaledVector(UP, -far * 0.05);
    S.pos.y = Math.min(S.pos.y, kin.c.y - far * 0.06);
    const city = I.world.city, gy = city.groundHeightAt(S.pos.x, S.pos.z, S.pos.y + 1) + 2;
    if (S.pos.y < gy) S.pos.y = gy;
    if (city.isInside(S.pos)) { this.clearShot(); return; }
    this.filmRig = false;
    this.tele = true;
    S.look.copy(kin.c);
    S.roll = 0;
    S.fov = 8;
  }

  updateFilm(realDt) {
    const I = this.inv, input = I.input, K = this.keys, S = this.shot;
    if (this.state !== 'chase') {
      this.relT += realDt;
      // Управление вернулось к игроку: кадр уступает сразу
      if (this.relT > 0.12 && input && (input.moveX || input.moveY || input.boost || input.moveZ < 0 || (input.moveZ > 0 && K.z <= 0) || Math.abs(input.lookDX) + Math.abs(input.lookDY) > 6)) {
        this.clearShot();
        return;
      }
    }
    if (this.tele) {
      S.look.lerp(_v.copy(this.kin.c).addScaledVector(this.kin.vel, 0.04), 1 - Math.exp(-20 * realDt));
      S.fov = 8 - I.fx.zoom * 0.1;
      if (this.relT > FILM_CUT + 1.8) this.clearShot();
      return;
    }
    this.placeFilmShot(realDt);
    if (this.state !== 'chase' && this.relT > FILM_CUT) this.startTele();
  }

  updateShot(realDt) {
    if (!this.shotOn) return;
    if (this.filmRig || this.tele) { this.updateFilm(realDt); return; }
    const I = this.inv, kin = this.kin, S = this.shot, A = this.angle;
    this.camT += realDt;
    const pos = S.pos;
    // Камера медленно наезжает весь замах и проходит свою дугу
    const e = smoothstep(0, this.coilLen + 0.2, this.camT);
    this.shotPos(pos, this.camSide, lerp(1.22, 1, e), A.arc ? A.arc * this.camSide * (1 - e) : 0);
    const gy = I.world.city.groundHeightAt(pos.x, pos.z, pos.y + 1) + 0.6;
    if (pos.y < gy) pos.y = gy;
    if (this.phase === 'rush') {
      // Длинный объектив: герой идёт издалека, и чем ближе, тем шире кадр
      S.look.copy(I.heroC);
      S.fov = clamp(340 / Math.max(1, pos.distanceTo(I.heroC)), 10, A.fov + 14) - I.fx.zoom;
    } else if (this.phase === 'plow') {
      // Несутся на полном ходу: кадр жёстко с ними
      S.look.lerpVectors(I.heroC, kin.c, 0.5);
      S.fov = A.fov - I.fx.zoom;
    } else if (this.state === 'chase') {
      _v.lerpVectors(I.heroC, kin.c, 0.5);
      S.look.lerp(_v, 1 - Math.exp(-12 * realDt));
      S.fov = A.fov - I.fx.zoom;
    } else {
      // Цель улетает: объектив сужается и ведёт её взглядом
      S.look.lerp(kin.c, 1 - Math.exp(-11 * realDt));
      const far = kin.c.distanceTo(pos);
      S.fov = clamp(A.fov * 22 / Math.max(far, 1), 13, A.fov) - I.fx.zoom * 0.4;
    }
  }

  clearShot() {
    const R = this.inv.camRig;
    this.shotOn = false;
    this.filmRig = false;
    this.tele = false;
    this.shot.roll = 0;
    if (R && R.shot === this.shot) R.shot = null;
  }
}
