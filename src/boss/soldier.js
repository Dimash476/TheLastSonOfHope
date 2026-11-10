import * as THREE from 'three';
import { Kin, spaceK } from './kin.js';
import { lerp } from '../utils.js';

// Десант Ксаррона: летают и бьют как герой, только слабее. Один держит ближний бой, остальные
// стреляют из наручей с дистанции. Несколько ударов — и солдат выходит из боя.

const _d = new THREE.Vector3(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
// Тяжесть волны: солдат держит серию из четырёх ударов, бьёт и стреляет больнее и чаще
const SOLDIER_HP = 170;
const MELEE_DMG = 8, BOLT_DMG = 2.5;
const BOLT_GAP = 0.45;   // с между выстрелами всего отряда
const LUNGE_GAP = [3, 3];   // с между бросками в ближний бой: от и плюс случайно до

export class Soldier extends Kin {
  constructor(inv, index) {
    super(inv, 'soldier');
    this.index = index;
    this.ring = 18 + (index % 4) * 8;
    this.side = index % 2 ? 1 : -1;
  }

  // Стоит в строю на месте слот
  stand(at, face) {
    this.reset();
    this.hp = SOLDIER_HP;
    this.state = 'form';
    this.slot = at.clone();
    this.place(at, face);
    this.root.visible = true;
    this.engaged = false;
    this.fireT = 1 + Math.random() * 3;
    this.lungeT = 2 + Math.random() * 4;
    this.fadeT = 0;
    this.deadT = 0;
    this.downK = 0;
  }

  // Спуск по колонне из брюха корабля; delay — когда начать
  drop(from, at, face, delay) {
    this.stand(at, face);
    this.state = 'wait';
    this.dropT = -delay;
    this.dropFrom = from.clone();
    this.root.visible = false;
  }

  engage() {
    if (!this.alive || this.state === 'down' || this.state === 'gone') return;
    this.engaged = true;
    if (this.state === 'form') this.state = 'fight';
  }

  retreat() {
    if (!this.alive || this.state === 'down' || this.state === 'gone') return;
    this.state = 'retreat';
    this.engaged = false;
    this.lasering = false;
  }

  onCrash(point) {
    if (!this.alive) this.fall(point);
    else { this.state = 'fight'; this.grounded = point.y <= this.groundY + 1; this.landT = 0.6; }
  }

  // Тело на земле: поза без сил и больше не считается
  fall() {
    this.state = 'down';
    this.grounded = true;
    this.knock = 0;
    this.downK = 1;
    this.fadeT = 16;
    this.vel.set(0, 0, 0);
    const side = Math.random() < 0.5 ? -1 : 1;
    this.lieQ = new THREE.Quaternion().setFromAxisAngle(_v.set(1, 0, 0), -Math.PI / 2 * 0.98).premultiply(new THREE.Quaternion().setFromAxisAngle(_v2.set(0, 1, 0), side * Math.random() * 3));
  }

  // Попадание: kind — punch | heavy | slam | ram | laser | throw | car; power 0..1
  receive(kind, power, point, dir) {
    if (!this.alive || this.state === 'down' || this.state === 'gone' || this.state === 'wait') return false;
    const I = this.inv;
    I.onFirstBlood();
    const dmg = kind === 'punch' ? 36 : kind === 'heavy' ? 50 + 90 * power : kind === 'slam' ? 60 : kind === 'ram' ? 45 + 60 * power : kind === 'laser' ? 170 * power : kind === 'throw' ? 70 : 60;
    this.hp -= dmg;
    this.engage();
    if (kind !== 'laser') this.hitFX(point, dir, kind === 'punch' ? 0.5 : 1);
    if (!this.alive) {
      I.onSoldierDown(this);
      this.lasering = false;
      this.launch(_d.copy(dir).setY(Math.max(dir.y, 0.12)).normalize(), kind === 'laser' ? 20 : lerp(70, 180, power) * (1 + spaceK(this.pos.y) * 4), 1.5);
      return true;
    }
    if (kind === 'laser') return true;
    const up = !this.grounded || !I.player.grounded;
    const away = _d.copy(dir).setY(Math.max(dir.y, 0.1)).normalize().clone();
    // В воздухе (или сильным ударом) — начало серии; на земле просто отшатывается
    if ((up || kind !== 'punch') && I.chain.open(this, away, kind, power)) return true;
    this.launch(away, up ? 150 : 34, up ? 0.8 : 0.42);
    return true;
  }

  update(dt, hero, camPos) {
    if (this.state === 'gone') return;
    if (this.state === 'wait') {
      this.dropT += dt;
      if (this.dropT < 0) return;
      this.state = 'drop';
      this.root.visible = true;
      this.pos.copy(this.dropFrom);
      this.grounded = false;
      this.knock = 0;
    }
    if (this.state === 'held') {
      // В руках героя: позицию задаёт он
      this.orient(dt);
      this.animate(dt, camPos);
      return;
    }
    if (this.state === 'down') {
      this.fadeT -= dt;
      if (this.fadeT <= 0) { this.state = 'gone'; this.root.visible = false; return; }
      // Лежит: быстро ложится, анимация больше не считается
      this.quat.slerp(this.lieQ, 1 - Math.exp(-9 * dt));
      this.pos.y += (this.groundY - 0.82 - this.pos.y) * Math.min(1, dt * 9);
      this.root.position.copy(this.pos).setY(this.pos.y + 1);
      this.root.quaternion.copy(this.quat);
      this.animate(dt, camPos);
      return;
    }
    const W = this.W;
    this.lookAtPoint(hero.center);
    const dist = this.c.distanceTo(hero.center);

    if (this.state === 'drop') {
      // Падает вдоль колонны, у самой земли резко гасит скорость
      const h = this.pos.y - this.slot.y;
      _d.subVectors(this.slot, this.pos);
      this.vel.set(_d.x * 2.2, -Math.min(220, 18 + h * 0.8), _d.z * 2.2);
      this.faceTarget = true;
      if (h < 1.5) {
        this.pos.copy(this.slot);
        this.vel.set(0, 0, 0);
        this.grounded = true;
        this.state = 'form';
        this.landT = 0.7;
        W.dust.burst(this.pos.clone().setY(this.pos.y + 0.4), 14, { size: [2, 5], speed: 12, life: [0.7, 1.6], flat: true });
        W.effects.shockwave(this.pos.clone().setY(this.pos.y + 0.3), { type: 'ring', radius: 8, life: 0.5, opacity: 0.6 });
        W.audio?.land(0.5, this.pos.clone());
      }
    } else if (this.knock > 0 && this.state !== 'retreat') {
      this.knock -= dt;
      if (!this.alive) {
        this.vel.y -= 26 * dt;
        // Тело, улетевшее в космос, на землю не вернётся
        this.deadT += dt;
        if (this.deadT > 8) { this.state = 'gone'; this.root.visible = false; return; }
      } else this.vel.multiplyScalar(Math.exp(-2.6 * dt));
      if (this.knock <= 0 && this.alive) { this.knock = 0; this.grounded = false; }
      if (this.knock <= 0 && !this.alive) this.knock = 0.5;   // тело летит, пока не упадёт
    } else if (this.state === 'retreat') {
      // Строем обратно на корабль
      this.inv.ship.bellyPos(_v);
      _d.subVectors(_v, this.pos);
      const l = _d.length();
      _d.divideScalar(l || 1);
      this.steer(dt, _d, 240, 3);
      this.grounded = false;
      this.faceTarget = false;
      if (l < 40) { this.state = 'gone'; this.root.visible = false; return; }
    } else if (this.state === 'fight') {
      this.fight(dt, hero, dist);
    } else if (this.state === 'lunge') {
      this.lunge(dt, hero, dist);
    } else {
      // В строю: стоит, пока не позовут; близкий противник — повод вступить в бой
      this.vel.set(0, 0, 0);
      if (dist < 16 && this.inv.fightOn) this.engage();
    }
    this.boosting = this.vel.lengthSq() > 200 * 200;
    this.move(dt);
    this.orient(dt);
    this.animate(dt, camPos);
  }

  fight(dt, hero, dist) {
    const I = this.inv, sk = spaceK(this.pos.y);
    // Сторона круга вокруг героя: каждый держит своё место
    _d.subVectors(this.c, hero.center).setY(0);
    if (_d.lengthSq() < 1) _d.set(1, 0, 0);
    _d.normalize().applyAxisAngle(_v.set(0, 1, 0), 0.5 * dt * this.side);
    _v2.copy(hero.center).addScaledVector(_d, this.ring);
    _v2.y = hero.center.y + 3 + (this.index % 3) * 4;
    _v.subVectors(_v2, this.c);
    const l = _v.length();
    _v.divideScalar(l || 1);
    const top = lerp(90, 900, sk) + (dist > 200 ? hero.speed * 1.05 : 0);
    this.steer(dt, _v, Math.min(top, l * 2.2), 4);
    if (this.grounded && _v.y > 0.1) this.grounded = false;

    // Удар в ближнем бою: один-два солдата за раз
    this.lungeT -= dt;
    if (this.lungeT <= 0 && dist < 70 && I.meleeSlots > 0) {
      I.meleeSlots--;
      this.state = 'lunge';
      this.lT = 0;
      this.lungeT = LUNGE_GAP[0] + Math.random() * LUNGE_GAP[1];
      return;
    }
    // Выстрел из наруча: рука вытягивается, через миг сгусток летит с упреждением
    this.fireT -= dt;
    if (this.fireT <= 0.42 && this.fireT > 0 && dist < 260) {
      this.punchT = 0.11;   // рука вперёд, пока целится
      this.punchSide = 'R';
      this.punchPower = 0;
    }
    if (this.fireT <= 0) {
      this.fireT = 1.8 + Math.random() * 2.8;
      // Огонь по очереди: иначе десять стволов разом просто не дают играть
      if (dist < 260 && I.boltCd <= 0) {
        I.boltCd = BOLT_GAP;
        this.model.fistWorldPos('R', _v);
        _v2.copy(hero.center).addScaledVector(hero.vel, dist / 260 * 0.7).sub(_v).normalize();
        _v2.x += (Math.random() - 0.5) * 0.05; _v2.y += (Math.random() - 0.5) * 0.05; _v2.z += (Math.random() - 0.5) * 0.05;
        I.bolts.fire(_v, _v2.normalize(), 260, BOLT_DMG);
      }
    }
  }

  lunge(dt, hero, dist) {
    const I = this.inv;
    this.lT += dt;
    this.lookAtPoint(hero.center);
    if (this.lT < 0.3) {
      // Замах: притормаживает и заносит руку
      this.vel.multiplyScalar(Math.exp(-6 * dt));
      this.charge = 0.3;
      return;
    }
    this.charge = 0;
    this.grounded = false;
    this.vel.copy(this.aim).multiplyScalar(Math.max(90, dist * 7));
    if (dist < 2.8 || this.lT > 0.9) {
      this.startPunch(0);
      if (dist < 3.4) I.meleeHit(this, MELEE_DMG, 34);
      this.state = 'fight';
      I.meleeSlots++;
      this.vel.multiplyScalar(0.15);
    }
  }
}

// Сгустки плазмы: один экземплярный меш, столкновение — с телом героя и зданиями
export class Bolts {
  constructor(scene, inv) {
    this.inv = inv;
    this.max = 28;
    const geo = new THREE.CapsuleGeometry(0.16, 3.4, 3, 8).rotateX(Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 1.9, 0.5), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, this.max);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    scene.add(this.mesh);
    this.list = Array.from({ length: this.max }, () => ({ on: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, dmg: 0 }));
    this.dummy = new THREE.Object3D();
    this.head = 0;
  }

  fire(from, dir, speed, dmg) {
    const b = this.list[this.head];
    this.head = (this.head + 1) % this.max;
    b.on = true;
    b.pos.copy(from);
    b.vel.copy(dir).multiplyScalar(speed);
    b.life = 2.2;
    b.dmg = dmg;
    this.inv.world.sparks.burst(from, 4, { size: [0.1, 0.3], speed: 6, life: [0.08, 0.2], color: 0xffa050 });
    this.inv.world.audio?.tone({ dur: 0.16, from: 900, to: 240, gain: 0.05, type: 'sawtooth' });
  }

  clear() {
    for (const b of this.list) b.on = false;
    this.mesh.count = 0;
  }

  update(dt, hero) {
    const W = this.inv.world;
    let n = 0;
    for (const b of this.list) {
      if (!b.on) continue;
      b.life -= dt;
      b.pos.addScaledVector(b.vel, dt);
      let hit = b.life <= 0;
      if (!hit && b.pos.y < W.city.groundHeightAt(b.pos.x, b.pos.z, b.pos.y)) hit = true;
      if (!hit && b.pos.y < 700 && W.city.segAt(b.pos)) { hit = true; W.effects.flash(b.pos, 6); }
      if (!hit && b.pos.distanceToSquared(hero.center) < 2.2) {
        hit = true;
        this.inv.boltHit(b, hero);
      }
      if (hit) {
        b.on = false;
        if (b.life > 0) W.sparks.burst(b.pos, 8, { size: [0.15, 0.5], speed: 12, life: [0.1, 0.3], color: 0xffb060 });
        continue;
      }
      this.dummy.position.copy(b.pos);
      this.dummy.quaternion.setFromUnitVectors(_v.set(0, 0, 1), _d.copy(b.vel).normalize());
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(n++, this.dummy.matrix);
    }
    this.mesh.count = n;
    if (n) this.mesh.instanceMatrix.needsUpdate = true;
  }
}
