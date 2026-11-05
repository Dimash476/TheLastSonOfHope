import * as THREE from 'three';
import { PLAYER as P, MACH, WORLD, SPACE } from '../config.js';
import { newReel, tickReel, HeroModel } from './model.js';
import { clamp, damp, lerp, smoothstep } from '../utils.js';
import { EyeLaser } from './laser.js';
import { BODIES, CAP_NY, nearestBody, bodyGroundAt } from '../world/bodies.js';

const _qI = new THREE.Quaternion();
const CAPE_INERTIA = 0.6;  // доля поворота тела, которую плащ «не замечает» (инерция ткани)

const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _cp = new THREE.Vector3();
const _p0 = new THREE.Vector3(), _seg = new THREE.Vector3(), _rel = new THREE.Vector3(), _bn = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();

// Вилтрумит: полёт, сверхскорость, бег, удары, мощный удар, удар о землю.
export class Player {
  constructor(scene, world) {
    this.world = world; // { city, debris, dust, sparks, effects, audio, toast }
    this.model = new HeroModel();
    this.root = new THREE.Group();
    this.model.group.position.y = -1.0; // вращаемся вокруг таза, а не ступней
    this.root.add(this.model.group);
    scene.add(this.root);

    this.pos = new THREE.Vector3(0, 0, 0);
    this.vel = new THREE.Vector3();
    this.grounded = true;
    this.groundY = 0;
    this.facing = new THREE.Vector3(0, 0, -1);
    this.quat = new THREE.Quaternion();

    this.punchT = -1;      // -1 — нет удара; иначе прошедшее время
    this.punchSide = 'R';
    this.punchHit = false;
    this.punchPower = 0;
    this.charge = 0;
    this.slamming = false;
    this.supersonic = false;
    this.hitstop = 0;
    this.dashT = 0;
    this.dashCd = 0;
    this.dashDir = new THREE.Vector3();
    this.ghostT = 0;
    this.held = null; // { kind, sys, ref }
    this.laser = new EyeLaser(scene, world);
    this.lasering = false;
    this.braking = false;
    this.latAccel = new THREE.Vector3();
    this.roll = 0;
    this.boomT = 0;
    this.landT = 0;      // «супергеройское» приземление на колено
    this.falling = false; // сошёл с уступа — падает под силой тяжести, пока не встанет на землю
    this.takeoffT = 0;   // присед перед взлётом
    this.dipT = 0; this.dipK = 0;   // амортизация ногами после приземления
    this.boosting = false;
    this.slowmo = 0;     // замедление времени (читает главный цикл)
    this.knockT = 0;     // отброшен ударом босса: управление ненадолго потеряно
    this.reel = newReel();   // как тело отзывается на удар
    this.blow = null;        // удар сцены: { side, f, k, pitch }
    this.poseQ = null;       // корпус ведёт сцена, а не полёт
    this.throwT = -1;    // бросок мяча: время с начала замаха (-1 — не бросаем)
    this.stepIdx = 0;
    this.driven = null;  // функция (dt, input, camDir): телом управляет режим, а не игрок (серия ударов, сцены)
    this.lockDir = null; // направление на цель: корпус и удар идут туда, а не за камерой

    this.anim = { stand: 1, hover: 0, fly: 0, slam: 0, run: 0, runPhase: 0, sprint: 0, punch: null, charge: 0, bob: 0, lift: 0 };
    this.spawn();
  }

  spawn() {
    // Старт на крыше одного из высоких зданий в центре
    const city = this.world.city;
    let best = null, bestTop = 0;
    for (const b of city.buildings) {
      if (b.kind !== 'building' || Math.hypot(b.x, b.z) > 300) continue;
      const top = city.segs[b.segs[b.segs.length - 1]];
      const h = top.y0 + top.h;
      if (top.alive && h > 60 && h < 140 && h > bestTop) { best = top; bestTop = h; }
    }
    if (best) this.pos.set(best.x, bestTop, best.z);
    else this.pos.set(0, 0, 0);
    this.onBody = this.nearBody = null;
    this.vel.set(0, 0, 0);
    this.grounded = true;
    this.falling = false;
    this.slamming = false;
    this.charge = 0;
    this.punchT = -1;
    this.dashT = 0;
    this.held = null;
    this.throwT = -1;
  }

  get speed() { return this.vel.length(); }
  get center() { return _v2.copy(this.pos).addScaledVector(UP, 1.0); }

  update(dt, input, cam) {
    const W = this.world;
    const camDir = cam.direction;          // куда смотрит камера (3D)
    const flat = _v.set(camDir.x, 0, camDir.z);
    if (flat.lengthSq() < 1e-6) flat.copy(this.facing);
    flat.normalize();
    const camFlat = flat.clone();
    const right = new THREE.Vector3(-camFlat.z, 0, camFlat.x);

    // В кулаке Колосса: двигаться нельзя — только вырываться (ЛКМ / пробел / рывок)
    if (this.captured) {
      const space = input.moveY > 0;
      if (input.punch || input.dash || (space && !this.capSpace)) this.captured.struggle();
      this.capSpace = space;
      this.vel.set(0, 0, 0);
      this.charge = 0; this.slamming = false; this.grounded = false; this.falling = false; this.dashT = 0;
      this.laser.update(dt, false, camDir, this);
      this.updateOrientation(dt, camDir, camFlat);
      this.updateAnimation(dt, camDir);
      return;
    }

    // Телом управляет режим (серия ударов, сцены): ввод не двигает героя
    if (this.driven) {
      this.driven(dt, input, camDir);
      this.tickPunch(dt, camDir);
      this.laser.update(dt, false, camDir, this);
      this.updateOrientation(dt, camDir, camFlat);
      this.updateAnimation(dt, camDir);
      this.updateCloth(dt);
      this.updateHeld();
      W.effects.setCharge(this.model.fistWorldPos('R', _cp), 0);
      W.effects.chargeK = 0;
      W.audio?.setCharge(0);
      return;
    }

    // ------------------------------------------------ способности
    if (input.slam && !this.grounded && !this.slamming) {
      this.slamming = true;
      this.falling = false;
      this.vel.set(camFlat.x * 25, -P.slamSpeed, camFlat.z * 25);
      W.audio?.whoosh(1);
    }
    // Отпустили X до земли — пике прерывается, герой зависает на месте
    if (this.slamming && !input.slamHeld && !input.slam) {
      this.slamming = false;
      this.vel.set(0, 0, 0);
      W.dust.burst(this.center.clone(), 6, { size: [1.5, 3], speed: 6, life: [0.4, 0.8] });
    }

    // Рывок: короткий бросок в сторону движения
    this.dashCd -= dt;
    if (input.dash && this.dashCd <= 0 && !this.slamming) {
      const wish = new THREE.Vector3().addScaledVector(this.grounded ? camFlat : camDir, input.moveZ).addScaledVector(right, input.moveX);
      if (!this.grounded) wish.addScaledVector(UP, input.moveY);
      if (wish.lengthSq() < 0.01) wish.copy(this.grounded ? camFlat : camDir);
      this.dashDir.copy(wish.normalize());
      this.dashT = P.dashTime;
      this.dashCd = P.dashCooldown;
      this.ghostT = 0;
      W.effects.shockwave(this.center.clone(), { type: 'disc', dir: this.dashDir.clone(), radius: 6, life: 0.3, opacity: 0.6 });
      W.audio?.whoosh(0.9);
    }

    // Захват / бросок
    if (input.grab) {
      if (this.held) this.throwHeld(camDir);
      else this.tryGrab();
    }
    if (input.punch && this.held) { this.punchHeld(camDir); input.punch = false; }

    if (input.punch && (this.punchT < 0 || this.punchT > (this.punchLen ?? P.punchDuration) * 0.55) && this.charge <= 0 && !this.slamming) {
      this.startPunch(0);
      if (this.speed < 30) this.vel.addScaledVector(camDir, 10);
    }

    // Лазер из глаз (удерживать Z): бьёт туда, куда смотрит камера
    this.lasering = input.laser && !this.slamming && !this.held && this.charge <= 0;
    this.laser.update(dt, this.lasering, this.laserAim || camDir, this);

    // Погладить собаку или кошку: рядом с животным ПКМ гладит, а не заряжает удар
    this.petTarget = this.grounded && !this.held && !this.lasering && this.charge <= 0 ? W.animals?.findPettable(this.pos, 2.4) : null;
    this.petting = this.petTarget && input.heavyHeld ? this.petTarget : null;
    if (this.petting) W.animals.pet(this.petting, dt);

    // Действие рядом (E): помочь упавшему подняться, бросить мяч собаке, поприветствовать людей
    this.interactTarget = null;
    if (this.grounded && !this.held && !this.lasering && this.charge <= 0 && !this.petting && this.vel.length() < 8) {
      const down = W.people?.findDown(this.pos, 3);
      const dog = !down && W.animals?.findDogForBall(this.pos, 7);
      if (down) this.interactTarget = { type: 'help', ref: down };
      else if (dog) this.interactTarget = { type: 'ball', ref: dog };
      else if (W.people?.countNear(this.pos, 14) > 0) this.interactTarget = { type: 'greet' };
    }
    if (input.interact && this.interactTarget && this.throwT < 0) {
      const it = this.interactTarget;
      if (it.type === 'help') { W.people.helpUp(it.ref, this.pos); this.helpT = 0.9; }
      else if (it.type === 'ball') { this.throwT = 0; this.throwDir = camFlat.clone(); }
      else { W.people.greet(this.pos, cam.camera.position); this.waveT = 1.8; }
    }
    this.waveT = Math.max(0, (this.waveT || 0) - dt);
    this.helpT = Math.max(0, (this.helpT || 0) - dt);
    // Бросок мяча: замах из-за головы, мяч уходит в момент выноса руки вперёд
    if (this.throwT >= 0) {
      const t0 = this.throwT;
      this.throwT += dt;
      if (t0 < 0.3 && this.throwT >= 0.3) {
        const hand = this.model.fistWorldPos('R', new THREE.Vector3());
        W.animals.throwBall(hand, this.throwDir);
      }
      if (this.throwT > 0.65) this.throwT = -1;
    }

    // Мощный удар: зарядка и отпускание
    if (input.heavyHeld && !this.slamming && !this.held && !this.petting) {
      this.charge = Math.min(P.heavyMaxCharge, this.charge + dt);
    } else if (this.charge > 0) {
      if (this.charge > 0.12) this.heavyPunch(camDir, this.charge / P.heavyMaxCharge);
      this.charge = 0;
    }

    // ------------------------------------------------ движение
    this.cruiseOn = false;   // W + Q в полёте (выставляет fly)
    if (this.dashT > 0) {
      this.dashT -= dt;
      const sp = Math.max(P.dashSpeed, this.vel.length());
      this.vel.copy(this.dashDir).multiplyScalar(sp);
      if (this.grounded) this.vel.y = 0;
      // Остаточные изображения
      this.ghostT -= dt;
      if (this.ghostT <= 0) { W.effects.ghost(this.root); this.ghostT = 0.035; }
      if (this.dashT <= 0) this.vel.copy(this.dashDir).multiplyScalar(this.grounded ? P.runSpeed : P.flySpeed);
    } else if (this.knockT > 0) {
      // Отброшен ударом: летит по инерции, кувыркаясь; управление вернётся через миг
      this.knockT -= dt;
      this.vel.y -= 9.81 * 2 * dt;
      this.vel.multiplyScalar(Math.exp(-1.1 * dt));
    } else if (this.slamming) {
      // ввод игнорируется — летим вниз
    } else if (this.grounded) {
      const wish = new THREE.Vector3().addScaledVector(camFlat, input.moveZ).addScaledVector(right, input.moveX);
      if (wish.lengthSq() > 1) wish.normalize();
      // Пока поднимается с колена — стоит на месте
      const top = this.landT > 0.25 || this.petting ? 0 : input.boost ? P.sprintSpeed : input.cruise ? P.cruiseRun : input.walk ? P.walkSpeed : P.runSpeed;
      // Человек разгоняется быстрее, чем тормозит с бега; шаг набирается мягко
      const hs0 = Math.hypot(this.vel.x, this.vel.z);
      const accel = top < hs0 ? P.groundAccel * 0.75 : top <= P.walkSpeed + 0.1 ? 5 : P.groundAccel;
      this.vel.x = damp(this.vel.x, wish.x * top, accel, dt);
      this.vel.z = damp(this.vel.z, wish.z * top, accel, dt);
      this.vel.y = 0;
      // Взлёт: короткий присед и толчок ногами (с разбега — почти сразу)
      if (input.moveY > 0 && this.takeoffT <= 0) this.takeoffT = hs0 > 8 ? 0.07 : 0.16;
      if (this.takeoffT > 0) {
        this.takeoffT -= dt;
        if (this.takeoffT <= 0) {
          this.takeoffT = 0;
          this.grounded = false;
          this.falling = false;
          this.vel.y = 28;
          W.dust.burst(this.pos.clone().setY(this.groundY + 0.5), 14, { size: [2, 5], speed: 14, life: [0.8, 1.6], flat: true });
          W.audio?.whoosh(0.4);
        }
      }
    } else if (this.falling) {
      // Шагнул с уступа: свободное падение, в воздухе можно чуть подправить направление.
      // Пробел или ускорение — герой подхватывает себя и летит дальше
      if (input.moveY > 0 || input.boost || this.dashT > 0) this.falling = false;
      else {
        const wish = new THREE.Vector3().addScaledVector(camFlat, input.moveZ).addScaledVector(right, input.moveX);
        if (wish.lengthSq() > 1) wish.normalize();
        const hs = Math.hypot(this.vel.x, this.vel.z), top = Math.max(hs, P.runSpeed);
        this.vel.x = damp(this.vel.x, wish.x * top, wish.lengthSq() > 0.01 ? 1.2 : 0.3, dt);
        this.vel.z = damp(this.vel.z, wish.z * top, wish.lengthSq() > 0.01 ? 1.2 : 0.3, dt);
        // На Луне и планетах — их тяжесть (в той же игровой пропорции, что и земная)
        this.vel.y = Math.max(this.vel.y - (this.onBody ? this.onBody.g : 9.81) * 1.6 * dt, -P.slamSpeed * 0.5);
      }
      if (!this.falling) this.fly(dt, input, camDir, right);
    } else {
      this.fly(dt, input, camDir, right);
    }

    // Обычный спуск у самой земли плавно гасится — герой встаёт мягко.
    // Резкое падение (с ускорением, рывок, удар о землю) — без смягчения.
    if (!this.grounded && !this.slamming && !this.falling && this.dashT <= 0 && !input.boost) {
      const h = this.pos.y - this.groundY, limit = -Math.max(5, h * 2.2);
      if (h < 14 && this.vel.y < limit) this.vel.y = damp(this.vel.y, limit, 10, dt);
    }

    this.moveAndCollide(dt, input);
    this.touchObjects();

    // ------------------------------------------------ сверхзвук
    const mach = this.speed / MACH;
    if (!this.supersonic && mach >= 1) {
      this.supersonic = true;
      const dir = this.vel.clone().normalize();
      W.effects.shockwave(this.center.clone(), { type: 'disc', dir, radius: 70, life: 0.9, opacity: 1 });
      W.effects.shockwave(this.center.clone(), { type: 'sphere', radius: 45, life: 0.7, opacity: 0.6 });
      W.effects.flash(this.center, 25);
      W.audio?.boom(1.0, this.center.clone());
      W.effects.impactFX(0.7, null, 0.15, 10);
      if (!W.boss?.fightOn) W.toast?.('SONIC BOOM');
      if (this.pos.y - this.groundY < 60) W.impact?.(this.center.clone(), 70, 18);
    } else if (this.supersonic && mach < 0.9) this.supersonic = false;

    // Ударная волна сверхзвукового полёта у земли выбивает стёкла в соседних зданиях
    this.boomT -= dt;
    if (mach >= 1 && this.pos.y - this.groundY < 220 && this.boomT <= 0) {
      this.boomT = 0.12;
      const r = 35 + Math.min(90, (mach - 1) * 40 + 30);
      let n = 0;
      for (const s of W.city.sphereQuery(this.center.clone(), r, [])) {
        if (n++ > 10) break;
        W.city.shatterWindows(s, this.center, this.vel);
      }
    }

    // Пыль от полёта над самой землёй на большой скорости
    const alt = this.pos.y - this.groundY;
    if (!this.grounded && this.speed > 90 && alt < 30 && Math.random() < 0.9) {
      const k = 1 - alt / 30;
      W.dust.burst(new THREE.Vector3(this.pos.x, this.groundY + 1, this.pos.z), Math.ceil(3 * k), {
        size: [4, 10 * k + 4], speed: 10 + this.speed * 0.05, life: [1, 2.5], flat: true,
      });
    }
    if (this.grounded && this.vel.length() > P.runSpeed * 1.5 && Math.random() < 0.5) {
      W.dust.burst(this.pos.clone().setY(this.groundY + 0.3), 1, { size: [1.5, 3], speed: 2, life: [0.6, 1.2] });
    }

    this.tickPunch(dt, camDir);

    this.updateOrientation(dt, camDir, camFlat);
    this.updateAnimation(dt, camDir);
    this.updateCloth(dt);
    this.updateHeld();

    // Свечение кулака при зарядке
    const ck = this.charge / P.heavyMaxCharge;
    W.effects.setCharge(this.model.fistWorldPos('R', _cp), ck);
    W.effects.chargeK = ck;
    W.audio?.setCharge(ck);
    if (ck > 0.3) W.effects.shake(ck * ck * dt * 0.8);
    if (ck > 0 && Math.random() < ck * 0.8) W.sparks.burst(_cp, 1, { size: [0.2, 0.5], speed: 3, life: [0.2, 0.4], color: 0xffc860 });
  }

  // Удар: момент попадания и конец анимации
  tickPunch(dt, camDir) {
    if (this.punchT < 0) return;
    this.punchT += dt;
    if (!this.punchHit && this.punchT >= (this.punchHitAt ?? P.punchHitTime)) {
      this.punchHit = true;
      if (this.punchPower === 0) this.resolvePunch(camDir);
    }
    if (this.punchT > (this.punchLen ?? P.punchDuration) * (1 + this.punchPower * 0.5)) this.punchT = -1;
  }

  // Плащ: гравитация и встречный поток в системе координат персонажа
  updateCloth(dt) {
    {
      const inv = this.root.quaternion.clone().invert();
      const g = new THREE.Vector3(0, -14, 0).applyQuaternion(inv);
      const sp = this.vel.length();
      const wind = sp > 0.5 ? this.vel.clone().multiplyScalar(-Math.min(75, sp * 0.8) / sp).applyQuaternion(inv) : new THREE.Vector3();
      // Инерция: при торможении и разгоне ткань «отстаёт». Сила меньше гравитации —
      // плащ подаётся вперёд, но не перелетает через голову
      if (this.prevVel && dt > 1e-4) {
        const acc = this.vel.clone().sub(this.prevVel).divideScalar(dt).clampLength(0, 10);
        wind.addScaledVector(acc.applyQuaternion(inv), -1);
      }
      this.prevVel = (this.prevVel || new THREE.Vector3()).copy(this.vel);
      // Поворот тела за кадр: ткань почти не поворачивается вместе с ним (инерция)
      const frameRot = this.prevRootQ ? inv.clone().multiply(this.prevRootQ) : null;
      if (frameRot) frameRot.slerp(_qI, 1 - CAPE_INERTIA);
      this.prevRootQ = (this.prevRootQ || new THREE.Quaternion()).copy(this.root.quaternion);
      this.model.updateCape(dt, g, wind, this.grounded, frameRot);
    }
  }

  // Торможение, м/с²: в атмосфере — сила полёта (~80 g) + сопротивление воздуха,
  // в космосе воздуха нет — тормозим силой, пропорциональной скорости
  brakeDecel(speed, rho) {
    return rho * 0.0012 * speed * speed + lerp(P.spaceBrake + P.spaceBrakeK * speed, P.flightBrake, rho);
  }

  // Физика полёта: инерция, ограничение перегрузки, сопротивление воздуха по высоте
  fly(dt, input, camDir, right) {
    const wish = new THREE.Vector3()
      .addScaledVector(camDir, input.moveZ)
      .addScaledVector(right, input.moveX)
      .addScaledVector(UP, input.moveY);
    const wl = Math.min(1, wish.length());
    const speed = this.vel.length();
    // Плотность воздуха падает с высотой (в космосе почти ноль)
    const rho = Math.exp(-Math.max(0, this.pos.y) / 8000);
    this.braking = false;
    this.boosting = false;
    this.latAccel.set(0, 0, 0);

    if (wl < 0.01) {
      // Без ввода: сопротивление воздуха (∝ v²) плюс «сила полёта», которой персонаж гасит скорость.
      // В космосе воздуха нет — тормозим только собственной силой (см. brakeDecel)
      const drag = this.brakeDecel(speed, rho);
      if (speed > 0.01) this.vel.multiplyScalar(Math.max(0, speed - drag * dt) / speed);
      if (speed < 60) this.vel.multiplyScalar(Math.exp(-P.brakeAccel * dt));
      this.braking = speed > 150 && rho > 0.3;
      return;
    }
    wish.normalize();
    const boosting = input.boost && input.moveZ > 0;
    this.boosting = boosting;
    // W + Q: лёгкое ускорение — плавно до P.cruiseSpeed и так же плавно обратно
    const cruise = !boosting && input.cruise && input.moveZ > 0;
    if (cruise) this.cruising = true; else if (boosting) this.cruising = false;
    this.cruiseOn = cruise;
    // На карте планеты высота мира огромна, но это не космос: скорость как в атмосфере, без гипера
    const onMap = this.world.planetMap.active;
    const spaceK = onMap ? 0 : smoothstep(SPACE.atmosphere, SPACE.spaceAlt, this.pos.y);
    // Уровни ускорения: Shift → Shift+E (гипер) → Shift+Q (третий) → Shift+F (четвёртый)
    // С камеры уровень плавный: 40^k (k от правой руки)
    const hyper = !boosting || onMap ? 1 : input.boostK != null ? Math.pow(P.warpMul, input.boostK)
      : input.warp ? P.warpMul : input.ultra ? P.ultraMul : input.hyper ? P.hyperMul : 1;
    const target = boosting ? lerp(P.boostSpeed, P.spaceBoostSpeed, spaceK) * hyper : cruise ? P.cruiseSpeed : P.flySpeed * wl;

    if (speed < 90 && !boosting && !cruise) {
      // Медленный полёт: плавно ведём вектор скорости
      this.vel.x = damp(this.vel.x, wish.x * target, P.flyAccel, dt);
      this.vel.y = damp(this.vel.y, wish.y * target, P.flyAccel, dt);
      this.vel.z = damp(this.vel.z, wish.z * target, P.flyAccel, dt);
      return;
    }

    // С места направление берём из ввода, иначе — текущее направление движения
    const dir = speed > 1 ? this.vel.clone().divideScalar(speed) : wish.clone();
    const angle = dir.angleTo(wish);
    let ns = speed;

    if (angle > 1.9) {
      // Резкий разворот назад: сначала воздушное торможение, разворот — когда скорость упадёт
      ns = Math.max(0, speed - this.brakeDecel(speed, rho) * 1.3 * dt);
      this.braking = true;
    } else {
      // Поворот ограничен перегрузкой: чем выше скорость, тем шире дуга (заносы)
      const maxTurn = Math.min(9, P.maxLatAccel / Math.max(speed, 1));
      const step = Math.min(angle, maxTurn * dt);
      if (angle > 1e-4) {
        const axis = new THREE.Vector3().crossVectors(dir, wish).normalize();
        const newDir = dir.clone().applyAxisAngle(axis, step);
        if (dt > 1e-5) this.latAccel.subVectors(newDir, dir).multiplyScalar(speed / dt);
        dir.copy(newDir);
      }
      // Разгон / сброс к целевой скорости
      if (speed > target && this.cruising && speed <= P.cruiseSpeed + 5) {
        // Отпустили W + Q: скорость уходит так же мягко, как набиралась
        ns = Math.max(damp(speed, target, P.cruiseAccel, dt), speed - P.cruiseMaxAccel * dt);
      } else if (speed > target) {
        // Отпустили ускорение (или гиперскорость): быстро сбрасываем скорость
        const brake = this.brakeDecel(speed, rho);
        ns = Math.max(target, speed - brake * dt);
      } else {
        ns = damp(speed, target, boosting && speed < target ? P.boostAccel : cruise ? P.cruiseAccel : 1.4, dt);
        if (cruise) ns = Math.min(ns, speed + P.cruiseMaxAccel * dt);
      }
      if (boosting) ns = Math.max(ns, Math.min(target, speed + (140 + spaceK * 1500) * hyper * dt));
      // Крутой вираж на скорости стоит энергии
      ns -= ns * 0.12 * Math.min(1, angle) * dt * rho;
    }
    this.vel.copy(dir).multiplyScalar(ns);
  }

  moveAndCollide(dt, input) {
    const W = this.world, city = W.city;
    const dist = this.vel.length() * dt;
    // Выше самых высоких зданий дробить шаг незачем (на 4-м уровне это тысячи подшагов)
    const aboveCity = Math.min(this.pos.y, this.pos.y + this.vel.y * dt) > 600;
    const steps = aboveCity ? 1 : Math.max(1, Math.ceil(dist / 1.5));
    const sdt = dt / steps;
    const hits = [];
    _p0.copy(this.pos);

    for (let s = 0; s < steps; s++) {
      this.pos.addScaledVector(this.vel, sdt);
      const c = this.center;
      city.sphereQuery(c, P.radius, hits);
      for (const b of hits) {
        const speed = this.vel.length();
        city.closestPoint(b, c, _cp);

        if (this.slamming) { this.slamImpact(_cp.clone()); break; }

        if (speed >= P.ramSpeed) {
          // Таран: пробиваем здание насквозь
          const dir = this.vel.clone().divideScalar(speed);
          city.destroySeg(b, _cp.clone(), dir, Math.min(speed * 0.3, 140));
          this.vel.multiplyScalar(0.9);
          W.effects.flash(_cp, 18);
          W.sparks.burst(_cp, 25, { size: [0.4, 1.2], speed: 30, life: [0.2, 0.6], color: 0xffd28a });
          W.debris.explode(_cp, 25, 30);
          W.audio?.punch(1);
          W.boss?.onRam?.(_cp, dir, speed);
          continue;
        }

        // Обычное столкновение: выталкиваем наружу
        const n = new THREE.Vector3().subVectors(c, _cp);
        let d = n.length();
        if (d > 1e-4) n.divideScalar(d);
        else {
          // Центр внутри здания — выталкиваем по ближайшей грани
          const px = b.w / 2 - Math.abs(c.x - b.x), pz = b.d / 2 - Math.abs(c.z - b.z), py = b.y0 + b.h - c.y;
          if (py < px && py < pz) n.set(0, 1, 0), d = -py;
          else if (px < pz) n.set(Math.sign(c.x - b.x), 0, 0), d = -px;
          else n.set(0, 0, Math.sign(c.z - b.z)), d = -pz;
        }
        this.pos.addScaledVector(n, P.radius - d);
        const vn = this.vel.dot(n);
        if (vn < 0) {
          if (-vn > 40) {
            city.damage(b, -vn * 0.6, _cp.clone(), n.clone().negate(), 12);
            W.audio?.punch(0.6);
          }
          this.vel.addScaledVector(n, -vn);
        }
        // Приземлились на крышу
        if (n.y > 0.7 && input.moveY <= 0 && Math.hypot(this.vel.x, this.vel.z) < 30) {
          this.grounded = true;
          this.vel.y = 0;
        }
      }
    }

    // Граница карты в атмосфере (в космосе её нет): мягко разворачиваем обратно
    if (this.pos.y < SPACE.atmosphere) {
      const L = WORLD.limit;
      for (const ax of ['x', 'z']) {
        if (Math.abs(this.pos[ax]) > L) {
          this.pos[ax] = Math.sign(this.pos[ax]) * L;
          if (this.vel[ax] * this.pos[ax] > 0) this.vel[ax] *= -0.3;
        }
      }
    }
    // Не улетаем в бесконечность
    // Мягкая граница полётной зоны: у края гасим только скорость «наружу»
    const R = SPACE.flightRadius;
    if (this.pos.length() > R) {
      const n = this.pos.clone().normalize();
      this.pos.setLength(R);
      const out = this.vel.dot(n);
      if (out > 0) this.vel.addScaledVector(n, -out);
    }

    const map = W.planetMap;
    if (map.active) {
      // Отдельная карта планеты: вместо шаров и города — её рельеф
      this.nearBody = this.onBody = map.body;
      this.groundY = map.heightAt(this.pos.x, this.pos.z);
      this.bodyAlt = this.pos.y - this.groundY;
      this.belowCap = false;
    } else {
      // Луна и планеты: твёрдые шары. Проверяем весь путь за кадр, а не только его конец:
      // на 360 км/с за кадр пролетаем километры и иначе проскочили бы насквозь
      for (const B of BODIES) this.collideBody(B, _p0);
      // Ближайшее тело: высота над ним (для HUD), название при подлёте
      const nb = nearestBody(this.pos), lim = Math.max(20000, nb.body.r);
      const near = nb.alt < lim || (this.nearBody === nb.body && nb.alt < lim * 1.5) ? nb.body : null;
      if (near && near !== this.nearBody) W.toast?.(near.name.toUpperCase(), 2.2);
      this.nearBody = near;
      this.bodyAlt = nb.alt;
      this.belowCap = !!near && this.pos.y - near.c.y < CAP_NY * _v.subVectors(this.pos, near.c).length();

      // На шаре держимся верхней шапки: дальше склон круче ~37° — там только летать
      if (this.grounded && this.onBody) {
        const B = this.onBody, dx = this.pos.x - B.c.x, dz = this.pos.z - B.c.z;
        const d = Math.hypot(dx, dz), capR = B.r * Math.sqrt(1 - CAP_NY * CAP_NY) * 0.995;
        if (d > capR) {
          this.pos.x = B.c.x + dx * capR / d; this.pos.z = B.c.z + dz * capR / d;
          const out = (this.vel.x * dx + this.vel.z * dz) / d;
          if (out > 0) { this.vel.x -= dx / d * out; this.vel.z -= dz / d * out; }
        }
      }

      // Земля / крыша под ногами (или верх Луны / планеты)
      this.groundY = city.groundHeightAt(this.pos.x, this.pos.z, this.pos.y);
      this.onBody = null;
      for (const B of BODIES) {
        const gy = bodyGroundAt(B, this.pos);
        if (gy > this.groundY) { this.groundY = gy; this.onBody = B; }
      }
    }
    if (this.pos.y <= this.groundY) {
      const impact = -this.vel.y;
      this.pos.y = this.groundY;
      if (this.slamming) { this.slamImpact(this.pos.clone()); return; }
      const steep = impact > 0.8 * Math.hypot(this.vel.x, this.vel.z);
      if (impact > 150 && steep && !this.lastDiveImpact) this.groundImpact(this.pos.clone(), Math.min(0.9, impact / 400));
      this.lastDiveImpact = impact > 150;
      if (this.vel.y < 0) this.vel.y = 0;
      if (!this.grounded && input.moveY <= 0 && (this.falling || Math.hypot(this.vel.x, this.vel.z) < 25)) {
        this.grounded = true;
        this.falling = false;
        // Ноги пружинят: чем сильнее удар, тем глубже присед
        if (impact > 1.5 && impact <= 45) { this.dipK = Math.min(1, 0.2 + impact / 22); this.dipT = 0.12 + 0.2 * this.dipK; }
        if (impact > 8) W.dust.burst(this.pos.clone().setY(this.groundY + 0.3), Math.min(10, 3 + Math.round(impact / 5)), { size: [1.5, 3.5], speed: 4 + impact * 0.12, life: [0.5, 1.2], flat: true, color: this.onBody?.dust });
        // Эффектная посадка на колено — только после быстрого падения
        if (impact > 45) this.heroLanding(Math.min(1, (impact - 45) / 110));
      }
    } else if (this.grounded && this.pos.y > this.groundY + 0.05) {
      // Склон или ступенька вниз — нога просто встаёт ниже. Уступ выше — падаем
      // (вместе с горизонтальной скоростью), а не повисаем в воздухе
      const gap = this.pos.y - this.groundY;
      if (gap > 0.45 + Math.hypot(this.vel.x, this.vel.z) * dt * 1.7) {
        this.grounded = false;
        this.falling = true;
        this.takeoffT = 0;
        this.vel.y = Math.min(this.vel.y, 0);
      }
    }
    if (this.grounded) this.pos.y = this.groundY;
  }

  // Столкновение с Луной или планетой за кадр: отрезок p0 → pos против шара
  collideBody(B, p0) {
    const R = B.r;
    _rel.subVectors(p0, B.c);
    const c0 = _rel.lengthSq() - R * R;
    if (c0 < 0) {
      // Начали кадр внутри (касание, телепорт) — дальше по радиусу
      _bn.subVectors(this.pos, B.c);
      if (_bn.lengthSq() >= R * R) return;
      _bn.normalize();
    } else {
      _seg.subVectors(this.pos, p0);
      const a = _seg.lengthSq(), b = _rel.dot(_seg);
      if (a < 1e-12 || b >= 0) return;
      const disc = b * b - a * c0;
      if (disc < 0) return;
      const s = (-b - Math.sqrt(disc)) / a;
      if (s > 1) return;
      _bn.copy(_seg).multiplyScalar(s).add(_rel).normalize();
    }
    // Сверху: ноги на поверхность поставит обычная логика земли (посадка, удар о землю).
    // Если за кадр ушли глубже шапки — останавливаемся в точке входа
    if (_bn.y > CAP_NY) {
      if (bodyGroundAt(B, this.pos) === -Infinity) { this.pos.copy(B.c).addScaledVector(_bn, R); this.pos.y -= 0.001; }
      return;
    }
    // Сбоку и снизу: отодвигаем (тело героя — над ступнями) и переносим на отдельную карту планеты.
    // Пока идёт бой, карта недоступна: просто гасим скорость «внутрь»
    const W = this.world, speed = this.vel.length();
    this.pos.copy(B.c).addScaledVector(_bn, R + P.radius);
    if (_bn.y < 0) this.pos.y -= P.height * -_bn.y;
    if (W.planetMap.request(B, _bn, speed)) { this.vel.set(0, 0, 0); return; }
    const vn = this.vel.dot(_bn);
    if (vn < 0) {
      if (-vn > 150) {
        const p = B.c.clone().addScaledVector(_bn, R);
        W.effects.shockwave(p, { type: 'disc', dir: _bn.clone(), radius: 40 + Math.min(200, -vn * 0.1), life: 1.2, opacity: 0.8 });
        W.dust.burst(p, 30, { size: [6, 16], speed: 40, life: [2, 4], color: B.dust });
      }
      this.vel.addScaledVector(_bn, -vn);
    }
  }

  // Приземление на одно колено: трещина, пыль, волна по земле, тяжёлый удар
  heroLanding(k) {
    const W = this.world;
    this.landT = 0.55 + 0.35 * k;
    this.vel.set(0, 0, 0);
    const p = this.pos.clone();
    if (p.y < 1 && k > 0.45) W.effects.crater(p, 3 + 6 * k);
    W.effects.shockwave(p.clone().setY(p.y + 0.3), { type: 'ring', radius: 8 + 22 * k, life: 0.6, opacity: 0.7 });
    W.dust.burst(p.clone().setY(p.y + 0.4), Math.round(14 + 26 * k), { size: [2, 5 + 6 * k], speed: 10 + 25 * k, life: [0.8, 2.2], flat: true, color: this.onBody?.dust });
    W.debris.explode(p, 6 + 12 * k, 8 + 15 * k);
    W.impact?.(p, 8 + 15 * k, 10 + 20 * k);
    W.effects.shake(0.15 + 0.25 * k);
    W.effects.impactFX(0.3 + 0.4 * k, p, 0.08 * k, 4 + 5 * k);
    W.audio?.land(k, p);
    this.hitstop = Math.max(this.hitstop, 0.04 + 0.04 * k);
  }

  startPunch(power) {
    this.punchT = 0;
    this.punchHit = false;
    this.punchPower = power;
    this.punchSide = power > 0 ? 'R' : (this.punchSide === 'R' ? 'L' : 'R');
    this.world.audio?.whoosh(0.25 + power * 0.4);
  }

  resolvePunch(aim) {
    const W = this.world;
    const chest = this.center.clone().addScaledVector(UP, 0.35);
    const hitC = chest.clone().addScaledVector(aim, P.punchReach);
    const hits = W.city.sphereQuery(hitC, 2.4, []);
    const vel = aim.clone().multiplyScalar(45);
    let material = null;
    if (W.traffic?.hit(hitC, 2.4, vel, 60)) material = 'metal';
    if (W.props?.hit(hitC, 2.4, vel, 60)) material = material || 'metal';
    if (W.trees?.hit(hitC, 2.4, vel)) material = material || 'concrete';
    if (W.people?.hit(hitC, 2.4, aim.clone().multiplyScalar(14))) material = material || 'body';
    if (W.boss?.hit(hitC, 2.4, P.punchDamage, aim, 'punch')) material = material || 'concrete';
    for (const b of hits) {
      W.city.closestPoint(b, hitC, _cp);
      W.city.damage(b, P.punchDamage, _cp.clone(), aim, P.punchForce);
      if (!material) material = W.city.isGlass(b) ? 'glass' : 'concrete';
    }
    if (!material) return;
    if (hits.length) W.city.closestPoint(hits[0], hitC, _cp); else _cp.copy(hitC);
    W.sparks.burst(_cp, 18, { size: [0.3, 0.9], speed: 18, life: [0.15, 0.4], color: 0xffe2a8 });
    W.effects.shockwave(_cp.clone(), { type: 'sphere', radius: 3, life: 0.25, opacity: 0.35 });
    W.effects.flash(_cp, 6);
    W.effects.shake(0.14);
    W.effects.impactFX(0.35, _cp.clone(), 0.05, 3);
    W.audio?.punch(0.75, material === 'body' ? 'concrete' : material, _cp.clone());
    this.hitstop = 0.05;
  }

  // ------------------------------------------------ захват и бросок
  tryGrab() {
    const W = this.world, c = this.center;
    const opts = [];
    const add = (kind, sys, r) => { if (r) opts.push({ kind, sys, ref: r.ref ?? r.index, dist: r.dist }); };
    add('car', W.traffic, W.traffic?.findGrabbable(c, P.grabRange));
    add('person', W.people, W.people?.findGrabbable(c, P.grabRange));
    add('debris', W.debris, W.debris.findGrabbable(c, P.grabRange));
    add('boss', W.boss, W.boss?.findGrabbable(c, P.grabRange + 16));
    if (!opts.length) return;
    opts.sort((a, b) => a.dist - b.dist);
    const o = opts[0];
    this.held = o;
    if (o.kind === 'debris') o.sys.hold(o.ref); else o.sys.hold(o.ref);
    W.audio?.whoosh(0.3);
    if (o.kind === 'car') W.audio?.metal(0.3);
  }

  throwHeld(dir) {
    const W = this.world, h = this.held;
    if (!h) return;
    this.held = null;
    const vel = dir.clone().multiplyScalar(h.kind === 'person' ? 22 : P.throwSpeed).add(this.vel);
    if (h.kind === 'boss') vel.y = Math.max(vel.y, 20);
    if (h.kind === 'debris') h.sys.throwPiece(h.ref, vel);
    else h.sys.throwObj(h.ref, vel);
    W.effects.shockwave(this.center.clone().addScaledVector(dir, 2), { type: 'disc', dir: dir.clone(), radius: 5, life: 0.25, opacity: 0.5 });
    W.audio?.whoosh(1.0);
    W.audio?.boom(0.25);
    W.effects.impactFX(0.3, null, 0, 5);
    W.effects.shockwave(this.center.clone().addScaledVector(dir, 3), { type: 'sphere', radius: 9, life: 0.35, opacity: 0.35 });
    this.hitstop = 0.035;
    this.startPunch(0.2);
    this.punchHit = true;
  }

  // Удар по тому, что держим: вещь улетает с силой удара
  punchHeld(dir) {
    const W = this.world, h = this.held;
    if (!h) return;
    if (h.kind === 'person') { this.throwHeld(dir); return; } // людей не бьём — аккуратно отпускаем
    this.held = null;
    const vel = dir.clone().multiplyScalar(P.throwSpeed * 1.8).add(this.vel);
    if (h.kind === 'debris') h.sys.throwPiece(h.ref, vel);
    else { h.sys.throwObj(h.ref, vel); h.sys.damageCar(h.ref, 60); }
    const p = this.center.clone().addScaledVector(UP, 1.2);
    W.sparks.burst(p, 20, { size: [0.3, 0.9], speed: 20, life: [0.15, 0.4], color: 0xffe2a8 });
    W.effects.shockwave(p, { type: 'disc', dir: dir.clone(), radius: 8, life: 0.3, opacity: 0.6 });
    W.audio?.punch(0.9, h.kind === 'car' ? 'metal' : 'concrete');
    W.effects.shake(0.18);
    W.effects.impactFX(0.5, p, 0.1, 6);
    this.hitstop = 0.06;
    this.startPunch(0);
    this.punchHit = true;
  }

  updateHeld() {
    const h = this.held;
    if (!h) return;
    const yawQ = new THREE.Quaternion().setFromAxisAngle(UP, Math.atan2(this.facing.x, this.facing.z));
    const p = this.center.clone();
    if (h.kind === 'person') p.addScaledVector(this.facing, 0.55).addScaledVector(UP, 0.4);
    else p.addScaledVector(UP, 1.45);
    if (h.kind === 'debris') h.sys.setHeld(h.ref, p);
    else h.sys.setHeld(h.ref, p, yawQ);
  }

  // Столкновения с машинами, людьми и фонарями при движении
  touchObjects() {
    const W = this.world, sp = this.vel.length();
    if (sp < 10) return;
    const c = this.center;
    if (W.traffic?.hit(c, 1.0, this.vel.clone().multiplyScalar(0.9), sp * 0.8)) {
      if (sp < P.ramSpeed) this.vel.multiplyScalar(0.85);
    }
    // Шагом и бегом по земле люди просто расступаются; сбивает только быстрый полёт или рывок
    if (this.grounded && sp < 25) W.people?.nudge?.(c, 1.1);
    else W.people?.hit(c, 0.8, this.vel.clone().multiplyScalar(0.5));
    W.props?.hit(c, 0.6, this.vel, sp);
    W.trees?.hit(c, 0.8, this.vel);
  }

  heavyPunch(aim, c) {
    const W = this.world;
    this.startPunch(c);
    this.punchHit = true; // урон наносится сразу, анимация догоняет
    const chest = this.center.clone().addScaledVector(UP, 0.35);
    const center = chest.clone().addScaledVector(aim, 3 + c * 4);
    const radius = lerp(P.heavyBaseRadius, P.heavyMaxRadius, c);
    W.city.damageRadius(center, radius, P.heavyDamage * (0.25 + 0.75 * c), 40 + 90 * c, aim);
    W.boss?.hit(center, 3 + radius * 0.35, P.heavyDamage * (0.25 + 0.75 * c), aim, 'heavy');
    W.debris.explode(center, radius * 1.5, 30 + 60 * c);
    W.effects.shockwave(center, { type: 'sphere', radius: radius * 1.3, life: 0.5 + c * 0.4, opacity: 0.4 });
    W.effects.shockwave(center, { type: 'disc', dir: aim, radius: radius * 1.8, life: 0.6 + c * 0.4, opacity: 0.8 });
    W.effects.flash(center, 15 + c * 40);
    W.effects.shake(0.15 + c * 0.25);
    W.effects.impactFX(0.5 + 0.5 * c, center, c > 0.95 ? 0.55 : 0.2 * c, 6 + 10 * c);
    W.dust.burst(center, Math.round(10 + c * 30), { size: [4, 12], speed: 20 + c * 40, life: [1.5, 3], dir: aim });
    W.sparks.burst(center, Math.round(20 + c * 40), { size: [0.4, 1.4], speed: 35, life: [0.2, 0.6], color: 0xffd28a });
    W.audio?.boom(0.4 + c * 0.6, center);
    W.audio?.punch(0.8 + c * 0.4, 'concrete', center);
    this.vel.addScaledVector(aim, -8 * c);
    this.hitstop = 0.03 + c * 0.04;
    // Полный заряд — короткое замедление времени
    if (c > 0.95) this.slowmo = 0.5;
  }

  slamImpact(point) {
    const W = this.world;
    this.slamming = false;
    this.vel.set(0, 0, 0);
    const center = point.clone();
    W.city.damageRadius(center, P.slamRadius, P.slamDamage, 70);
    this.groundImpact(center, 1);
    this.grounded = true;
    this.landT = 0.95; // встаёт с колена после удара о землю
  }

  groundImpact(point, k) {
    const W = this.world;
    const r = P.slamRadius * (0.4 + 0.6 * k);
    if (point.y < 1) W.effects.crater(point, 10 + 22 * k);
    W.effects.shockwave(point.clone().setY(point.y + 0.6), { type: 'ring', radius: r * 2.2, life: 0.9, opacity: 0.9 });
    W.effects.shockwave(point, { type: 'sphere', radius: r * 1.1, life: 0.6, opacity: 0.35 });
    W.debris.explode(point, r * 1.6, 25 + 45 * k);
    W.impact?.(point, r * 2, 30 + 40 * k);
    W.dust.burst(point.clone().setY(point.y + 1), Math.round(30 + 40 * k), { size: [6, 16], speed: 30 + 50 * k, life: [1.5, 3.5], flat: true, color: this.onBody?.dust });
    W.dust.burst(point, 12, { size: [8, 18], speed: 8, life: [2, 4], rise: 3, color: this.onBody?.dust });
    W.effects.flash(point, 30 * k + 10);
    if (k >= 1) W.effects.shake(0.3);
    W.effects.impactFX(0.6 + 0.4 * k, point, 0.25 * k, 8 * k);
    W.audio?.boom(0.5 + 0.5 * k, point);
    W.audio?.crumble(0.3 + 0.4 * k, 'concrete', point);
  }

  updateOrientation(dt, camDir, camFlat) {
    const hv = new THREE.Vector3(this.vel.x, 0, this.vel.z);
    const speed = this.vel.length();
    const acting = this.punchT >= 0 || this.charge > 0 || !!this.held || this.lasering;

    // Корпус ведёт сцена: удар в серии, падение
    if (this.poseQ) {
      this.quat.copy(this.poseQ);
      this.flyK = 0;
      this.root.position.copy(this.pos).addScaledVector(UP, 1.0);
      this.root.quaternion.copy(this.quat);
      return;
    }
    // Отброшен ударом: спина ведёт полёт, тело медленно кувыркается
    if (this.knockT > 0 && speed > 15 && !this.grounded) {
      this.tumble = (this.tumble || 0) + 2.2 * dt;
      const z = this.vel.clone().divideScalar(-speed), x = new THREE.Vector3().crossVectors(UP, z);
      if (x.lengthSq() < 1e-3) x.set(1, 0, 0);
      x.normalize();
      const y = new THREE.Vector3().crossVectors(z, x);
      _q.setFromRotationMatrix(_m.makeBasis(x, y, z)).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), this.tumble));
      this.quat.slerp(_q, 1 - Math.exp(-14 * dt));
      this.flyK = 0;
      this.root.position.copy(this.pos).addScaledVector(UP, 1.0);
      this.root.quaternion.copy(this.quat);
      return;
    }

    // Куда смотрит персонаж по горизонтали
    let targetFacing;
    if (this.petting) targetFacing = new THREE.Vector3(this.petting.pos.x - this.pos.x, 0, this.petting.pos.z - this.pos.z).normalize();
    else if (this.lockDir && Math.hypot(this.lockDir.x, this.lockDir.z) > 0.05) targetFacing = new THREE.Vector3(this.lockDir.x, 0, this.lockDir.z).normalize();
    else if (acting) targetFacing = camFlat;
    else if (this.grounded || this.falling) targetFacing = hv.lengthSq() > 1 ? hv.clone().normalize() : this.facing;
    else targetFacing = speed > 5 && hv.lengthSq() > 4 ? hv.clone().normalize() : camFlat;
    this.facing.lerp(targetFacing, 1 - Math.exp(-12 * dt)).setY(0).normalize();

    const upright = new THREE.Quaternion().setFromAxisAngle(UP, Math.atan2(this.facing.x, this.facing.z));

    // Поза полёта: голова вперёд по скорости, лицом к земле
    let flyK = 0;
    let flyQ = upright;
    if (!this.grounded && !acting && !this.slamming && !this.falling && speed > 5) {
      flyK = smoothstep(12, 55, speed);
      const y = this.vel.clone().divideScalar(speed);
      const z = new THREE.Vector3(0, -1, 0).addScaledVector(y, y.y); // -UP минус проекция на y
      if (z.lengthSq() < 0.02) z.copy(camFlat).addScaledVector(y, -camFlat.dot(y));
      z.normalize();
      const x = new THREE.Vector3().crossVectors(y, z);
      flyQ = new THREE.Quaternion().setFromRotationMatrix(_m.makeBasis(x, y, z));
      // Крен в вираже: спина наклоняется к центру поворота (как у самолёта)
      const lat = this.latAccel.dot(x);
      this.roll = damp(this.roll, -clamp(lat / 350, -1.25, 1.25), 6, dt);
      if (!Number.isFinite(this.roll)) this.roll = 0;
      flyQ.multiply(new THREE.Quaternion().setFromAxisAngle(UP, this.roll));
      // Воздушное торможение: корпус выпрямляется навстречу потоку
      if (this.braking) flyK *= 0.3;
    } else if (!this.grounded && !acting && !this.slamming && !this.falling) {
      // Лёгкий наклон в сторону движения при медленном полёте
      const local = hv.clone().applyQuaternion(upright.clone().invert());
      const lean = new THREE.Quaternion().setFromEuler(new THREE.Euler(local.z * 0.04, 0, -local.x * 0.04));
      flyQ = upright.clone().multiply(lean);
      flyK = 1;
    }
    _q.copy(upright).slerp(flyQ, flyK);
    this.quat.slerp(_q, 1 - Math.exp(-10 * dt));
    this.flyK = !this.grounded && !this.falling && speed > 5 && !acting ? smoothstep(12, 55, speed) * (this.braking ? 0.3 : 1) : 0;

    this.root.position.copy(this.pos).addScaledVector(UP, 1.0);
    this.root.quaternion.copy(this.quat);
  }

  updateAnimation(dt, camDir) {
    const a = this.anim;
    if (!this.reel.ext) tickReel(this.reel, dt);
    a.reel = this.reel;
    a.blow = this.blow;
    // У героя knockT; у отряда свой счётчик, вес ему задаёт Kin.animate
    if (this.knockT !== undefined) a.knock = damp(a.knock || 0, this.knockT > 0 && !this.grounded ? 1 : 0, 12, dt);
    const air = this.grounded ? 0 : 1;
    const slam = this.slamming ? 1 : 0;
    const fall = this.falling ? 1 : 0;
    a.stand = damp(a.stand, 1 - air, 12, dt);
    a.fly = damp(a.fly, air * (1 - slam) * this.flyK, 8, dt);
    a.hover = damp(a.hover, air * (1 - slam) * (1 - fall) * (1 - this.flyK), 8, dt);
    a.fall = damp(a.fall || 0, fall, 7, dt);
    a.slam = damp(a.slam, slam, 14, dt);

    const hs = Math.hypot(this.vel.x, this.vel.z);
    a.run = this.grounded ? clamp(hs / P.runSpeed, 0, 1) : 0;
    a.sprint = smoothstep(P.runSpeed, P.sprintSpeed, hs);
    a.hs = hs;
    a.gait = damp(a.gait || 0, this.grounded ? smoothstep(0.15, 1.1, hs) : 0, 10, dt);
    // Частота шагов как у человека: шаг ~1 цикл/с, бег ~1.8, спринт ~2.4 (ноги не «мельтешат»)
    a.runPhase += dt * Math.PI * 2 * (0.75 + 0.95 * (1 - Math.exp(-hs / 7)) + 0.015 * Math.min(hs, 60));
    // Наклон корпуса от разгона/торможения и в повороте (внутрь виража)
    if (dt > 1e-4) {
      const ax = (this.vel.x - (this.gPrevX ?? this.vel.x)) / dt, az = (this.vel.z - (this.gPrevZ ?? this.vel.z)) / dt;
      const g = this.grounded ? 1 : 0;
      const fwd = ax * this.facing.x + az * this.facing.z, side = ax * this.facing.z - az * this.facing.x;
      a.leanF = damp(a.leanF || 0, g * clamp(fwd * 0.012, -0.22, 0.2), 6, dt);
      a.leanS = damp(a.leanS || 0, g * clamp(side * 0.008, -0.3, 0.3), 6, dt);
    }
    this.gPrevX = this.vel.x; this.gPrevZ = this.vel.z;
    // Присед: перед взлётом и амортизация после приземления
    this.dipT = Math.max(0, this.dipT - dt);
    const crouch = this.takeoffT > 0 ? 0.8 : this.dipT > 0 ? this.dipK : 0;
    a.dip = damp(a.dip || 0, crouch, crouch > (a.dip || 0) ? 26 : 7, dt);
    // Ускорение (Shift, рывок, гипер) — обе руки вперёд
    a.boost = damp(a.boost || 0, !this.grounded && !this.slamming && (this.boosting || this.cruiseOn || this.dashT > 0) ? 1 : 0, 6, dt);
    // Шаги: стук, пыль, лёгкий толчок камеры на спринте (касание пяткой — фаза 0 и π)
    const step = Math.floor(a.runPhase / Math.PI);
    if (this.grounded && hs > 1 && step !== this.stepIdx) {
      const k = Math.min(1, hs / P.sprintSpeed);
      this.world.audio?.footstep(0.25 + 0.95 * k);
      if (hs > 5) this.world.dust.burst(this.pos.clone().setY(this.groundY + 0.15), Math.ceil(1 + 3 * k), { size: [0.6, 1.6 + 2 * k], speed: 1.5 + 4 * k, life: [0.4, 1.0], flat: true });
      if (k > 0.6) { this.world.effects.shake(0.05 * k); this.world.effects.fovKick = Math.max(this.world.effects.fovKick, 0.8 * k); }
    }
    this.stepIdx = step;
    this.landT = Math.max(0, this.landT - dt);
    a.land = damp(a.land || 0, this.landT > 0.25 && this.grounded ? 1 : 0, this.landT > 0.25 ? 18 : 5, dt);
    a.bob = air * (1 - this.flyK) * Math.sin(performance.now() * 0.002) * 0.06;

    const pitch = Math.asin(clamp((this.lockDir || camDir).y, -1, 1));
    const punchAll = (this.punchLen ?? P.punchDuration) * (1 + this.punchPower * 0.5);
    a.punch = this.punchT >= 0
      ? { side: this.punchSide, t: this.punchT / punchAll, power: this.punchPower, pitch, heavy: !!this.punchLen, hitAt: (this.punchHitAt ?? P.punchHitTime) / punchAll }
      : null;
    a.charge = this.charge;
    a.lift = damp(a.lift, this.held && this.held.kind !== 'person' ? 1 : 0, 10, dt);
    a.brake = damp(a.brake || 0, this.braking && !this.grounded ? 1 : 0, 6, dt);
    a.carry = damp(a.carry || 0, this.held && this.held.kind === 'person' ? 1 : 0, 10, dt);
    a.pet = damp(a.pet || 0, this.petting || this.helpT > 0 ? 1 : 0, 7, dt);
    a.wave = damp(a.wave || 0, this.waveT > 0 ? 1 : 0, 8, dt);
    a.throwT = this.throwT >= 0 ? this.throwT / 0.65 : -1;

    // Покой на земле дольше 3 с — руки на пояс
    const busy = hs > 1 || this.punchT >= 0 || this.charge > 0 || this.held || this.lasering || this.petting || this.landT > 0 || this.waveT > 0 || this.throwT >= 0 || this.helpT > 0;
    this.idleT = this.grounded && !busy ? (this.idleT || 0) + dt : 0;
    a.idle = damp(a.idle || 0, this.idleT > 3 ? 1 : 0, 3, dt);
    // Полёт: крен, сила встречного ветра, набор/снижение, гиперскорость
    const speed = this.vel.length();
    a.roll = this.roll || 0;
    a.gust = smoothstep(30, 400, speed);
    a.climb = speed > 1 ? this.vel.y / speed : 0;
    a.hyper = damp(a.hyper || 0, smoothstep(1200, 2600, speed), 3, dt);   // гипер (Shift+E) и выше
    // Взгляд за камерой: угол между направлением камеры и лицом героя
    const fz = this.facing.x * camDir.x + this.facing.z * camDir.z;
    const fx = this.facing.z * camDir.x - this.facing.x * camDir.z;
    const yaw = Math.atan2(fx, fz);
    const toward = Math.abs(yaw) < 2.2 ? 1 : 0;   // камера спереди — смотрим прямо
    a.lookYaw = damp(a.lookYaw || 0, toward * yaw, 5, dt);
    a.lookPitch = damp(a.lookPitch || 0, toward * Math.asin(clamp(camDir.y, -1, 1)), 5, dt);
    a.look = this.petting || this.landT > 0 ? 0 : 1;
    this.model.animate(dt, a);
  }
}
