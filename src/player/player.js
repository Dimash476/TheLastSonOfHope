import * as THREE from 'three';
import { PLAYER as P, MACH, WORLD, SPACE } from '../config.js';
import { HeroModel } from './model.js';
import { clamp, damp, lerp, smoothstep } from '../utils.js';

const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _cp = new THREE.Vector3();
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
    this.braking = false;
    this.latAccel = new THREE.Vector3();
    this.roll = 0;
    this.boomT = 0;
    this.landT = 0;      // «супергеройское» приземление на колено
    this.slowmo = 0;     // замедление времени (читает главный цикл)
    this.stepIdx = 0;

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
    this.vel.set(0, 0, 0);
    this.grounded = true;
    this.slamming = false;
    this.charge = 0;
    this.punchT = -1;
    this.dashT = 0;
    this.held = null;
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

    // ------------------------------------------------ способности
    if (input.slam && !this.grounded && !this.slamming) {
      this.slamming = true;
      this.vel.set(camFlat.x * 25, -P.slamSpeed, camFlat.z * 25);
      W.audio?.whoosh(1);
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

    if (input.punch && (this.punchT < 0 || this.punchT > P.punchDuration * 0.55) && this.charge <= 0 && !this.slamming) {
      this.startPunch(0);
      if (this.speed < 30) this.vel.addScaledVector(camDir, 10);
    }

    // Мощный удар: зарядка и отпускание
    if (input.heavyHeld && !this.slamming && !this.held) {
      this.charge = Math.min(P.heavyMaxCharge, this.charge + dt);
    } else if (this.charge > 0) {
      if (this.charge > 0.12) this.heavyPunch(camDir, this.charge / P.heavyMaxCharge);
      this.charge = 0;
    }

    // ------------------------------------------------ движение
    if (this.dashT > 0) {
      this.dashT -= dt;
      const sp = Math.max(P.dashSpeed, this.vel.length());
      this.vel.copy(this.dashDir).multiplyScalar(sp);
      if (this.grounded) this.vel.y = 0;
      // Остаточные изображения
      this.ghostT -= dt;
      if (this.ghostT <= 0) { W.effects.ghost(this.root); this.ghostT = 0.035; }
      if (this.dashT <= 0) this.vel.copy(this.dashDir).multiplyScalar(this.grounded ? P.runSpeed : P.flySpeed);
    } else if (this.slamming) {
      // ввод игнорируется — летим вниз
    } else if (this.grounded) {
      const wish = new THREE.Vector3().addScaledVector(camFlat, input.moveZ).addScaledVector(right, input.moveX);
      if (wish.lengthSq() > 1) wish.normalize();
      // Пока поднимается с колена — стоит на месте
      const top = this.landT > 0.25 ? 0 : input.boost ? P.sprintSpeed : P.runSpeed;
      this.vel.x = damp(this.vel.x, wish.x * top, P.groundAccel, dt);
      this.vel.z = damp(this.vel.z, wish.z * top, P.groundAccel, dt);
      this.vel.y = 0;
      if (input.moveY > 0) {
        // Взлёт
        this.grounded = false;
        this.vel.y = 28;
        W.dust.burst(this.pos.clone().setY(this.groundY + 0.5), 14, { size: [2, 5], speed: 14, life: [0.8, 1.6], flat: true });
        W.audio?.whoosh(0.4);
      }
    } else {
      this.fly(dt, input, camDir, right);
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
      W.toast?.('SONIC BOOM');
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

    // ------------------------------------------------ удар: момент попадания
    if (this.punchT >= 0) {
      this.punchT += dt;
      if (!this.punchHit && this.punchT >= P.punchHitTime) {
        this.punchHit = true;
        if (this.punchPower === 0) this.resolvePunch(camDir);
      }
      if (this.punchT > P.punchDuration * (1 + this.punchPower * 0.5)) this.punchT = -1;
    }

    this.updateOrientation(dt, camDir, camFlat);
    this.updateAnimation(dt, camDir);
    // Плащ: гравитация и встречный поток в системе координат персонажа
    {
      const inv = this.root.quaternion.clone().invert();
      const g = new THREE.Vector3(0, -14, 0).applyQuaternion(inv);
      const sp = this.vel.length();
      const wind = sp > 0.5 ? this.vel.clone().multiplyScalar(-Math.min(75, sp * 0.8) / sp).applyQuaternion(inv) : new THREE.Vector3();
      this.model.updateCape(dt, g, wind, this.grounded);
    }
    this.updateHeld();

    // Свечение кулака при зарядке
    const ck = this.charge / P.heavyMaxCharge;
    W.effects.setCharge(this.model.fistWorldPos('R', _cp), ck);
    W.effects.chargeK = ck;
    W.audio?.setCharge(ck);
    if (ck > 0.3) W.effects.shake(ck * ck * dt * 0.8);
    if (ck > 0 && Math.random() < ck * 0.8) W.sparks.burst(_cp, 1, { size: [0.2, 0.5], speed: 3, life: [0.2, 0.4], color: 0xffc860 });
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
    const spaceK = smoothstep(SPACE.atmosphere, SPACE.spaceAlt, this.pos.y);
    // Уровни ускорения: Shift → Shift+E (гипер) → Shift+Q (третий уровень)
    const hyper = !boosting ? 1 : input.ultra ? P.ultraMul : input.hyper ? P.hyperMul : 1;
    const target = boosting ? lerp(P.boostSpeed, P.spaceBoostSpeed, spaceK) * hyper : P.flySpeed * wl;

    if (speed < 90 && !boosting) {
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
      if (speed > target) {
        // Отпустили ускорение (или гиперскорость): быстро сбрасываем скорость
        const brake = this.brakeDecel(speed, rho);
        ns = Math.max(target, speed - brake * dt);
      } else {
        ns = damp(speed, target, boosting && speed < target ? P.boostAccel : 1.4, dt);
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
    const steps = Math.max(1, Math.ceil(dist / 1.5));
    const sdt = dt / steps;
    const hits = [];

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

    // Луна: твёрдая поверхность
    const moon = _v.set(...SPACE.moonPos);
    const toMoon = this.center.clone().sub(moon);
    const md = toMoon.length();
    if (md < SPACE.moonRadius + P.radius) {
      const n = toMoon.divideScalar(md);
      this.pos.addScaledVector(n, SPACE.moonRadius + P.radius - md);
      const vn = this.vel.dot(n);
      if (vn < 0) {
        if (-vn > 150) {
          // Удар о Луну
          const p = moon.clone().addScaledVector(n, SPACE.moonRadius);
          W.effects.shockwave(p, { type: 'disc', dir: n, radius: 40 + Math.min(200, -vn * 0.1), life: 1.2, opacity: 0.8 });
          W.dust.burst(p, 30, { size: [6, 16], speed: 40, life: [2, 4], color: 0x8a8884 });
          if (!this.onMoon) W.toast?.('ЛУНА');
        }
        this.vel.addScaledVector(n, -vn);
      }
      this.onMoon = true;
    } else if (md > SPACE.moonRadius + 5000) this.onMoon = false;

    // Земля / крыша под ногами
    this.groundY = city.groundHeightAt(this.pos.x, this.pos.z, this.pos.y);
    if (this.pos.y <= this.groundY) {
      const impact = -this.vel.y;
      this.pos.y = this.groundY;
      if (this.slamming) { this.slamImpact(this.pos.clone()); return; }
      const steep = impact > 0.8 * Math.hypot(this.vel.x, this.vel.z);
      if (impact > 150 && steep && !this.lastDiveImpact) this.groundImpact(this.pos.clone(), Math.min(0.9, impact / 400));
      this.lastDiveImpact = impact > 150;
      if (this.vel.y < 0) this.vel.y = 0;
      if (!this.grounded && input.moveY <= 0 && Math.hypot(this.vel.x, this.vel.z) < 25) {
        this.grounded = true;
        if (impact > 15) W.dust.burst(this.pos.clone().setY(this.groundY + 0.4), 10, { size: [2, 4], speed: 10, life: [0.6, 1.4], flat: true });
        if (impact > 28) this.heroLanding(Math.min(1, impact / 120));
      }
    } else if (this.grounded && this.pos.y > this.groundY + 0.05) {
      // Здание под нами разрушено или сошли с края крыши — просто зависаем
      this.grounded = false;
    }
    if (this.grounded) this.pos.y = this.groundY;
  }

  // Приземление на одно колено: трещина, пыль, волна по земле, тяжёлый удар
  heroLanding(k) {
    const W = this.world;
    this.landT = 0.55 + 0.35 * k;
    this.vel.set(0, 0, 0);
    const p = this.pos.clone();
    if (p.y < 1) W.effects.crater(p, 3 + 6 * k);
    W.effects.shockwave(p.clone().setY(p.y + 0.3), { type: 'ring', radius: 8 + 22 * k, life: 0.6, opacity: 0.7 });
    W.dust.burst(p.clone().setY(p.y + 0.4), Math.round(14 + 26 * k), { size: [2, 5 + 6 * k], speed: 10 + 25 * k, life: [0.8, 2.2], flat: true });
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
    W.people?.hit(c, 0.8, this.vel.clone().multiplyScalar(0.5));
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
    W.dust.burst(point.clone().setY(point.y + 1), Math.round(30 + 40 * k), { size: [6, 16], speed: 30 + 50 * k, life: [1.5, 3.5], flat: true });
    W.dust.burst(point, 12, { size: [8, 18], speed: 8, life: [2, 4], rise: 3 });
    W.effects.flash(point, 30 * k + 10);
    if (k >= 1) W.effects.shake(0.3);
    W.effects.impactFX(0.6 + 0.4 * k, point, 0.25 * k, 8 * k);
    W.audio?.boom(0.5 + 0.5 * k, point);
    W.audio?.crumble(0.3 + 0.4 * k, 'concrete', point);
  }

  updateOrientation(dt, camDir, camFlat) {
    const hv = new THREE.Vector3(this.vel.x, 0, this.vel.z);
    const speed = this.vel.length();
    const acting = this.punchT >= 0 || this.charge > 0 || !!this.held;

    // Куда смотрит персонаж по горизонтали
    let targetFacing;
    if (acting) targetFacing = camFlat;
    else if (this.grounded) targetFacing = hv.lengthSq() > 1 ? hv.clone().normalize() : this.facing;
    else targetFacing = speed > 5 && hv.lengthSq() > 4 ? hv.clone().normalize() : camFlat;
    this.facing.lerp(targetFacing, 1 - Math.exp(-12 * dt)).setY(0).normalize();

    const upright = new THREE.Quaternion().setFromAxisAngle(UP, Math.atan2(this.facing.x, this.facing.z));

    // Поза полёта: голова вперёд по скорости, лицом к земле
    let flyK = 0;
    let flyQ = upright;
    if (!this.grounded && !acting && !this.slamming && speed > 5) {
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
    } else if (!this.grounded && !acting && !this.slamming) {
      // Лёгкий наклон в сторону движения при медленном полёте
      const local = hv.clone().applyQuaternion(upright.clone().invert());
      const lean = new THREE.Quaternion().setFromEuler(new THREE.Euler(local.z * 0.04, 0, -local.x * 0.04));
      flyQ = upright.clone().multiply(lean);
      flyK = 1;
    }
    _q.copy(upright).slerp(flyQ, flyK);
    this.quat.slerp(_q, 1 - Math.exp(-10 * dt));
    this.flyK = !this.grounded && speed > 5 && !acting ? smoothstep(12, 55, speed) * (this.braking ? 0.3 : 1) : 0;

    this.root.position.copy(this.pos).addScaledVector(UP, 1.0);
    this.root.quaternion.copy(this.quat);
  }

  updateAnimation(dt, camDir) {
    const a = this.anim;
    const air = this.grounded ? 0 : 1;
    const slam = this.slamming ? 1 : 0;
    a.stand = damp(a.stand, 1 - air, 12, dt);
    a.fly = damp(a.fly, air * (1 - slam) * this.flyK, 8, dt);
    a.hover = damp(a.hover, air * (1 - slam) * (1 - this.flyK), 8, dt);
    a.slam = damp(a.slam, slam, 14, dt);

    const hs = Math.hypot(this.vel.x, this.vel.z);
    a.run = this.grounded ? clamp(hs / P.runSpeed, 0, 1) : 0;
    a.sprint = smoothstep(P.runSpeed, P.sprintSpeed, hs);
    a.runPhase += dt * Math.min(24, 3 + hs * 0.55);
    // Тяжёлые шаги: стук, пыль, лёгкий толчок камеры на спринте
    const step = Math.floor(a.runPhase / Math.PI);
    if (this.grounded && hs > 3 && step !== this.stepIdx) {
      const k = Math.min(1, hs / P.sprintSpeed);
      this.world.audio?.footstep(0.4 + 0.8 * k);
      this.world.dust.burst(this.pos.clone().setY(this.groundY + 0.15), Math.ceil(1 + 3 * k), { size: [0.6, 1.6 + 2 * k], speed: 1.5 + 4 * k, life: [0.4, 1.0], flat: true });
      if (k > 0.6) { this.world.effects.shake(0.05 * k); this.world.effects.fovKick = Math.max(this.world.effects.fovKick, 0.8 * k); }
    }
    this.stepIdx = step;
    this.landT = Math.max(0, this.landT - dt);
    a.land = damp(a.land || 0, this.landT > 0.25 && this.grounded ? 1 : 0, this.landT > 0.25 ? 18 : 5, dt);
    a.bob = air * (1 - this.flyK) * Math.sin(performance.now() * 0.002) * 0.06;

    const pitch = Math.asin(clamp(camDir.y, -1, 1));
    a.punch = this.punchT >= 0
      ? { side: this.punchSide, t: this.punchT / (P.punchDuration * (1 + this.punchPower * 0.5)), power: this.punchPower, pitch }
      : null;
    a.charge = this.charge;
    a.lift = damp(a.lift, this.held && this.held.kind !== 'person' ? 1 : 0, 10, dt);
    a.brake = damp(a.brake || 0, this.braking && !this.grounded ? 1 : 0, 6, dt);
    a.carry = damp(a.carry || 0, this.held && this.held.kind === 'person' ? 1 : 0, 10, dt);
    this.model.animate(dt, a);
  }
}
