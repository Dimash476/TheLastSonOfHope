import * as THREE from 'three';
import { CITY } from '../config.js';
import { HALF, BLOCK, blockAt } from './layout.js';

// Живые сцены на улицах (только в Симуляторе, в городе): по одной за раз, в 200–550 м от героя,
// раз в 1–2 минуты. Без меток и заданий: о сцене говорит радио, остальное видно в кадре.
//   погоня — грабители на тёмной машине, за ними полиция с мигалками (без сирен);
//   авария — машина горит, водитель внутри, вокруг зеваки: E вытащить, E задуть огонь;
//   котёнок на дереве — внизу плачет ребёнок: E снять, E отдать;
//   уличный музыкант — толпа слушает: E бросить монету.

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
const KINDS = ['chase', 'fire', 'cat', 'busker'];
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
// Аккорды музыканта (до мажор: C G Am F), перебор восьмыми
const BUSK = [[48, 55, 60, 64], [43, 55, 59, 62], [45, 57, 60, 64], [41, 53, 57, 60]];

export class Scenes {
  constructor(scene, world) {
    this.world = world;
    this.cur = null;
    this.wait = 45;
    this.last = '';
    this.kids = [];          // дети-актёры: рост вернём, когда исчезнут из виду
    this.coinCd = 0;
    // Мигалки полиции: красная и синяя на крыше каждой машины
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, 'rgba(255,255,255,0.6)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    this.lights = [0xff2a2a, 0x2a5cff, 0xff2a2a, 0x2a5cff].map((col) => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: col, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      s.scale.setScalar(1.6);
      s.visible = false;
      scene.add(s);
      return s;
    });
    // Котёнок: рыжий, с ушками и хвостом
    const fur = new THREE.MeshStandardMaterial({ color: 0xd9822b, roughness: 0.9 });
    const cat = this.cat = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8).scale(1, 0.85, 1.6), fur);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), fur); head.position.set(0, 0.12, 0.24);
    const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.035, 0.32, 6), fur); tail.position.set(0, 0.14, -0.27); tail.rotation.x = -0.6;
    cat.add(body, head, tail);
    for (const s of [-1, 1]) {
      const ear = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.08, 4), fur); ear.position.set(s * 0.06, 0.23, 0.24);
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.14, 5), fur);
      leg.position.set(s * 0.07, -0.13, 0.1);
      const leg2 = leg.clone(); leg2.position.z = -0.12;
      cat.add(ear, leg, leg2);
    }
    cat.visible = false;
    scene.add(cat);
    // Гитара музыканта
    const wood = new THREE.MeshStandardMaterial({ color: 0x8a5a2e, roughness: 0.6 });
    const guitar = this.guitar = new THREE.Group();
    const gb = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.44, 0.1), wood);
    const neck = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.62), new THREE.MeshStandardMaterial({ color: 0x3a2a1a }));
    neck.position.set(0.32, 0.12, 0); neck.rotation.set(0, Math.PI / 2, 0.35);
    guitar.add(gb, neck);
    guitar.visible = false;
    scene.add(guitar);
  }

  // ---------------------------------------------------------------- запуск
  start(player) {
    const kinds = KINDS.filter((k) => k !== this.last);
    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    const ok = this['start_' + kind](player);
    if (!ok) { this.wait = 10; return; }
    this.last = kind;
  }

  // Точка в городе на расстоянии [r0, r1] от героя
  spot(player, r0, r1) {
    for (let i = 0; i < 20; i++) {
      const a = Math.random() * Math.PI * 2, r = r0 + Math.random() * (r1 - r0);
      const x = player.pos.x + Math.cos(a) * r, z = player.pos.z + Math.sin(a) * r;
      if (Math.abs(x) > HALF - 60 || Math.abs(z) > HALF - 60) continue;
      const t = blockAt(x, z);
      if (t === BLOCK.EMPTY || t === BLOCK.RIVER || t === BLOCK.MEGA) continue;
      return [x, z];
    }
    return null;
  }

  // Машина на дороге в кольце [r0, r1]
  pickCar(player, r0, r1, bus = false) {
    const list = this.world.traffic.cars.filter((c) => c.state === 'drive' && c.hp > 0 && !(c.wait > 0) && (bus || c.type !== 'bus'));
    const fit = list.filter((c) => { const d = c.pos.distanceTo(player.pos); return d > r0 && d < r1; });
    return fit.length ? fit[Math.floor(Math.random() * fit.length)] : null;
  }

  actor(pos, heading, act = {}) {
    const p = this.world.people.spawnActor(pos, heading);
    if (!p) return null;
    p.act = act;
    this.cur.actors.push(p);
    return p;
  }

  // ---------------------------------------------------------------- погоня
  start_chase(player) {
    const W = this.world, T = W.traffic;
    const thief = this.pickCar(player, 250, 550);
    if (!thief) return false;
    // Полиция — из свободных машин, а если весь запас на дорогах — две самые дальние от героя
    const ok = (c) => c !== thief && (c.type === 'sedan' || c.type === 'suv') && (c.state === 'none' || c.state === 'drive');
    const free = T.cars.filter(ok).sort((a, b) => (a.state === 'none' ? -1e9 : -a.pos.distanceTo(player.pos)) - (b.state === 'none' ? -1e9 : -b.pos.distanceTo(player.pos)));
    if (free.length < 2) return false;
    thief.speed = 24;
    thief.mesh.setColorAt(thief.slot, new THREE.Color(0x15161a));
    thief.mesh.instanceColor.needsUpdate = true;
    const cops = free.slice(0, 2);
    for (const c of cops) {
      c.state = 'scene'; c.dead = false; c.hp = 100; c.pos.set(0, -1000, 0);
      c.mesh.setColorAt(c.slot, new THREE.Color(0xe8eaee));
      c.mesh.instanceColor.needsUpdate = true;
    }
    this.cur = { kind: 'chase', t: 0, actors: [], thief, cops, hist: [], histT: 0, done: false };
    W.news?.('chase', { now: true });
    return true;
  }

  update_chase(dt, player) {
    const W = this.world, S = this.cur, th = S.thief;
    if (!S.done) {
      // Пойман: в руках, сбит, стоит перед ладонью героя
      const caught = th.state === 'held' || th.state === 'fly' || th.state === 'wreck' || th.wait > 0 || th.hp <= 0;
      if (caught) {
        S.done = 'win'; S.endT = 12;
        W.news?.('chaseWin');
        W.soundscape?.cheer(0.6, player.pos.clone().setY(player.pos.y + 1.5));
      } else if (th.state !== 'drive' || S.t > 150) {
        S.done = 'lost'; S.endT = 0;
        W.news?.('chaseLost');
      } else {
        // След грабителей: полиция едет по нему с отставанием в 1 и 2 с
        S.histT -= dt;
        if (S.histT <= 0) {
          S.histT = 0.05;
          S.hist.push({ p: th.pos.clone(), q: th.quat.clone() });
          if (S.hist.length > 60) S.hist.shift();
        }
        S.cops.forEach((c, i) => {
          if (c.state !== 'scene') return;
          const k = S.hist.length - 1 - (i + 1) * 20;
          if (k < 0) return;
          c.pos.copy(S.hist[k].p); c.quat.copy(S.hist[k].q);
        });
      }
    }
    // Мигалки: попеременно, и после поимки ещё мигают
    const blink = Math.floor(this.t * 6) % 2;
    S.cops.forEach((c, i) => {
      const on = c.state === 'scene' && c.pos.y > -100;
      for (let j = 0; j < 2; j++) {
        const L = this.lights[i * 2 + j];
        L.visible = on && (j === blink);
        if (on) L.position.copy(_v.set((j ? 0.45 : -0.45), 1.75, -0.2).applyQuaternion(c.quat).add(c.pos));
      }
    });
    if (S.done && (S.endT -= dt) <= 0) this.end();
  }

  // ---------------------------------------------------------------- авария с огнём
  start_fire(player) {
    const W = this.world;
    const car = this.pickCar(player, 200, 480);
    if (!car) return false;
    car.state = 'scene';
    car.quat.multiply(_q.setFromAxisAngle(_v.set(0, 0, 1), 0.1));
    car.mesh.setColorAt(car.slot, car.color.clone().multiplyScalar(0.45));
    car.mesh.instanceColor.needsUpdate = true;
    const burn = W.fire.add(car.pos, { size: 0.9, life: 1e6, target: car });
    this.cur = { kind: 'fire', t: 0, actors: [], car, burn, rescued: false, out: false, done: false };
    // Зеваки вокруг: смотрят, снимают на телефон
    for (let i = 0; i < 4; i++) {
      const a = Math.random() * Math.PI * 2, r = 10 + Math.random() * 4;
      const pos = new THREE.Vector3(car.pos.x + Math.cos(a) * r, 0, car.pos.z + Math.sin(a) * r);
      if (W.city.segAt(_v.set(pos.x, 1, pos.z), 0.5)) continue;
      pos.y = W.city.groundHeightAt(pos.x, pos.z, car.pos.y + 1);
      this.actor(pos, Math.atan2(car.pos.x - pos.x, car.pos.z - pos.z), i % 2 ? { armR: -1.5, phone: 1, look: 0.1 } : { armL: -1.0, armR: -2.2, look: 0.1 });
    }
    W.news?.('fire');
    return true;
  }

  update_fire(dt, player) {
    const W = this.world, S = this.cur;
    if (S.done) { if ((S.endT -= dt) <= 0) this.end(); return; }
    if (S.car.state !== 'scene' || S.t > 160) {
      // Машину унесли или огонь не тронули слишком долго: огонь догорает сам
      S.burn.life = S.burn.t + 4;
      this.end();
      return;
    }
    if (S.rescued && S.out) {
      S.done = true; S.endT = 5;
      W.news?.('fireWin');
      W.soundscape?.cheer(0.5, S.car.pos.clone().setY(S.car.pos.y + 2));
      for (const p of S.actors) if (p.act) { p.act.armL = -2.7; p.act.armR = -2.7; p.act.phone = 0; }
      S.car.state = 'wreck'; S.car.timer = 0;
    }
  }

  // ---------------------------------------------------------------- котёнок на дереве
  start_cat(player) {
    const W = this.world;
    const at = this.spot(player, 220, 450);
    if (!at) return false;
    let tree = null;
    W.trees.near(at[0], at[1], 140, (t) => { if (!tree && !t.forest && t.s > 0.8) tree = t; });
    if (!tree) return false;
    const a = Math.random() * Math.PI * 2;
    const catPos = new THREE.Vector3(tree.x + Math.cos(a) * 0.9 * tree.s, tree.y + 6.0 * tree.s, tree.z + Math.sin(a) * 0.9 * tree.s);
    this.cur = { kind: 'cat', t: 0, actors: [], tree, catPos, catVel: new THREE.Vector3(), where: 'tree', meowT: 1, done: false };
    const kp = new THREE.Vector3(tree.x - Math.cos(a) * 2.6, 0, tree.z - Math.sin(a) * 2.6);
    kp.y = W.city.groundHeightAt(kp.x, kp.z, tree.y + 1);
    const kid = this.actor(kp, Math.atan2(tree.x - kp.x, tree.z - kp.z), { armR: -2.7, armL: -2.4, look: 1.1 });
    if (!kid) { this.cur = null; return false; }
    kid.h0 = kid.h; kid.h = 0.62;
    this.kids.push(kid);
    this.cur.kid = kid;
    this.cat.position.copy(catPos);
    this.cat.rotation.set(0, a + Math.PI, 0);
    this.cat.visible = true;
    W.news?.('cat');
    return true;
  }

  update_cat(dt, player) {
    const W = this.world, S = this.cur, kid = S.kid;
    if (S.where === 'tree') {
      // Дерево сломали — котёнок падает на землю (и ждёт там)
      if (!S.tree.alive || S.catVel.lengthSq() > 0) {
        S.catVel.y -= 9.8 * dt;
        S.catPos.addScaledVector(S.catVel, dt);
        const gy = W.city.groundHeightAt(S.catPos.x, S.catPos.z, S.catPos.y + 0.5);
        if (S.catPos.y <= gy + 0.18) { S.catPos.y = gy + 0.18; S.catVel.set(0, 0, 0); S.tree = { alive: true }; }
        else if (S.catVel.lengthSq() === 0) S.catVel.y = -0.01;
      }
      this.cat.position.copy(S.catPos);
      this.cat.rotation.z = Math.sin(this.t * 3) * 0.05;
    } else if (S.where === 'hero') {
      player.model.fistWorldPos('R', this.cat.position);
      this.cat.position.y += 0.1;
      this.cat.rotation.y = Math.atan2(player.facing.x, player.facing.z);
    } else if (S.where === 'kid') {
      this.cat.position.set(kid.pos.x + Math.sin(kid.heading) * 0.22, kid.pos.y + 1.05 * kid.h, kid.pos.z + Math.cos(kid.heading) * 0.22);
      this.cat.rotation.y = kid.heading + Math.PI / 2;
    }
    if (S.where !== 'kid' && (S.meowT -= dt) <= 0) { S.meowT = 2.2 + Math.random() * 2; W.soundscape?.meow?.(this.cat.position.clone()); }
    // Ребёнка сбили или он исчез — сцена кончилась
    if (kid.state !== 'actor' && S.where !== 'kid') { this.end(); return; }
    if (S.done && (S.endT -= dt) <= 0) {
      if (kid.state === 'actor') this.world.people.release(kid);
      if (S.endT < -15 || kid.state === 'none') this.end();
    }
  }

  // ---------------------------------------------------------------- уличный музыкант
  start_busker(player) {
    const W = this.world, B = CITY.block;
    const at = this.spot(player, 160, 380);
    if (!at) return false;
    const i = Math.floor((at[0] + HALF) / B), j = Math.floor((at[1] + HALF) / B);
    const pos = new THREE.Vector3(-HALF + i * B + B / 2, 0, -HALF + j * B + 10);
    if (W.city.segAt(_v.set(pos.x, 1, pos.z), 0.8)) return false;
    pos.y = W.city.groundHeightAt(pos.x, pos.z, 1);
    this.cur = { kind: 'busker', t: 0, actors: [], step: 0, next: 0, coins: 0, done: false };
    const man = this.actor(pos, Math.PI, { armL: -1.25, armR: -0.9, look: -0.15 });
    if (!man) { this.cur = null; return false; }
    this.cur.man = man;
    // Слушатели полукругом со стороны улицы
    for (let k = 0; k < 6; k++) {
      const a = Math.PI + (k / 5 - 0.5) * 2.0, r = 3.6 + Math.random() * 1.8;
      const sp = new THREE.Vector3(pos.x + Math.sin(a) * r, 0, pos.z + Math.cos(a) * r);
      sp.y = W.city.groundHeightAt(sp.x, sp.z, pos.y + 1);
      this.actor(sp, Math.atan2(pos.x - sp.x, pos.z - sp.z), k % 3 === 0 ? { armR: -1.5, phone: 1 } : { look: -0.05 });
    }
    this.guitar.visible = true;
    W.news?.('busker');
    return true;
  }

  update_busker(dt, player) {
    const W = this.world, S = this.cur, m = S.man;
    if (m.state !== 'actor' || S.t > 200) { this.end(); return; }
    // Перебор: правая рука бьёт по струнам
    m.act.armR = -0.95 + Math.sin(this.t * 13) * 0.18;
    const f = _v.set(Math.sin(m.heading), 0, Math.cos(m.heading));
    this.guitar.position.set(m.pos.x + f.x * 0.25, m.pos.y + 1.05 * m.h, m.pos.z + f.z * 0.25);
    this.guitar.rotation.set(0, m.heading, -0.35);
    // Музыка слышна вблизи
    const a = W.audio;
    if (a?.ctx && player.pos.distanceTo(m.pos) < 140) {
      const now = a.ctx.currentTime;
      if (S.next < now - 0.3) S.next = now + 0.05;
      while (S.next < now + 0.12) {
        const ch = BUSK[Math.floor(S.step / 8) % 4], n = ch[[0, 2, 1, 3, 2, 3, 1, 2][S.step % 8]];
        const dest = a.out(_v.set(m.pos.x, m.pos.y + 1.2, m.pos.z));
        a.tone({ dur: 0.9, from: midi(n), to: midi(n) * 0.998, gain: 0.09, type: 'triangle', delay: S.next - now, dest });
        if (S.step % 8 === 0) a.tone({ dur: 1.6, from: midi(ch[0] - 12), to: midi(ch[0] - 12), gain: 0.07, type: 'sine', delay: S.next - now, dest });
        S.next += 0.27;
        S.step++;
      }
    }
    // После монеты слушатели радуются
    for (const p of S.actors) if (p !== m && p.act) p.act.wave = this.coinCd > 0.5 ? 1 : 0;
  }

  // ---------------------------------------------------------------- E рядом со сценой
  target(player) {
    const S = this.cur;
    if (!S || S.done) return null;
    const hp = player.pos;
    if (S.kind === 'fire') {
      const d = hp.distanceTo(S.car.pos);
      if (!S.rescued && d < 7) return { label: 'вытащить водителя', run: (P) => this.rescue(P) };
      if (!S.out && d < 14) return { label: 'задуть огонь', run: (P) => this.blow(P) };
    } else if (S.kind === 'cat') {
      if (S.where === 'tree' && player.center.distanceTo(S.catPos) < 3.5) return { label: 'снять котёнка', run: () => this.takeCat() };
      if (S.where === 'hero' && player.grounded && Math.hypot(hp.x - S.kid.pos.x, hp.z - S.kid.pos.z) < 3.5) return { label: 'отдать котёнка', run: (P) => this.giveCat(P) };
    } else if (S.kind === 'busker') {
      if (player.grounded && this.coinCd <= 0 && Math.hypot(hp.x - S.man.pos.x, hp.z - S.man.pos.z) < 5) return { label: 'бросить монету', run: (P) => this.coin(P) };
    }
    return null;
  }

  rescue(P) {
    const W = this.world, S = this.cur, c = S.car;
    S.rescued = true;
    P.helpT = 0.9;
    P.faceAt = c.pos.clone();
    const side = _v.set(1, 0, 0).applyQuaternion(c.quat).setY(0).normalize();
    const pos = c.pos.clone().addScaledVector(side, Math.sign(side.dot(_v.subVectors(P.pos, c.pos)) || 1) * 2.2);
    pos.y = W.city.groundHeightAt(pos.x, pos.z, c.pos.y + 1);
    const d = this.actor(pos, Math.atan2(P.pos.x - pos.x, P.pos.z - pos.z), { armL: -0.6, armR: -0.6, look: -0.2 });
    W.audio?.metal(0.35, c.pos);
    W.dust.burst(pos.clone().setY(pos.y + 1), 6, { size: [1, 2.4], speed: 3, life: [0.5, 1], color: 0x3a3632 });
    if (d) setTimeout(() => {
      if (d.state !== 'actor') return;
      W.people.release(d);
      d.thankT = 3;
      W.soundscape?.thanks?.(d.pos.clone().setY(d.pos.y + 1.6));
      W.animals?.spawnHeart(d.pos.x, d.pos.y + 2 * d.h, d.pos.z);
    }, 1400);
  }

  blow(P) {
    const W = this.world, S = this.cur, c = S.car;
    S.out = true;
    S.burn.life = S.burn.t;          // огонь гаснет сразу
    P.faceAt = c.pos.clone();
    P.waveT = 0.6;
    const dir = _v.subVectors(c.pos, P.pos).setY(0).normalize().clone();
    W.effects.shockwave(P.center.clone().addScaledVector(dir, 2), { type: 'disc', dir, radius: 9, life: 0.45, opacity: 0.45 });
    W.dust.burst(c.pos.clone().setY(c.pos.y + 1.2), 22, { size: [2, 5], speed: 8, life: [1.2, 2.6], color: 0xd8dade, alpha: 0.5, dir });
    W.audio?.noiseBurst({ dur: 1.1, freq: 900, sweepTo: 300, type: 'lowpass', gain: 0.35, attack: 0.08 });
    W.audio?.whoosh(1.1);
  }

  takeCat() {
    const W = this.world, S = this.cur;
    S.where = 'hero';
    W.soundscape?.meow?.(this.cat.position.clone());
    W.soundscape?.cheer?.(0.2, S.kid.pos.clone().setY(S.kid.pos.y + 1));
    S.kid.act.armL = -2.9; S.kid.act.armR = -2.9;
  }

  giveCat(P) {
    const W = this.world, S = this.cur, kid = S.kid;
    S.where = 'kid';
    S.done = true; S.endT = 4;
    P.helpT = 0.8;
    P.faceAt = kid.pos.clone();
    kid.heading = Math.atan2(P.pos.x - kid.pos.x, P.pos.z - kid.pos.z);
    kid.act = { armL: -1.15, armR: -1.15, look: -0.1 };
    W.soundscape?.thanks?.(kid.pos.clone().setY(kid.pos.y + 1.2));
    W.soundscape?.meow?.(this.cat.position.clone());
    W.animals?.spawnHeart(kid.pos.x, kid.pos.y + 1.6, kid.pos.z);
    setTimeout(() => W.animals?.spawnHeart(kid.pos.x, kid.pos.y + 1.7, kid.pos.z), 450);
    W.news?.('catWin');
  }

  coin(P) {
    const W = this.world, S = this.cur, m = S.man;
    this.coinCd = 2.5;
    P.waveT = 0.7;
    P.faceAt = m.pos.clone();
    const at = _v.set(m.pos.x + Math.sin(m.heading) * 0.8, m.pos.y + 0.2, m.pos.z + Math.cos(m.heading) * 0.8).clone();
    W.sparks.burst(at, 8, { size: [0.15, 0.35], speed: 3, life: [0.3, 0.6], color: 0xffd25a });
    if (W.audio?.ctx) {
      W.audio.tone({ dur: 0.25, from: 2600, to: 2500, gain: 0.08, type: 'sine', dest: W.audio.out(at) });
      W.audio.tone({ dur: 0.3, from: 3300, to: 3250, gain: 0.05, type: 'sine', delay: 0.09, dest: W.audio.out(at) });
    }
    W.soundscape?.cheer?.(0.45, m.pos.clone().setY(m.pos.y + 1.6));
    m.act.look = -0.45;
    setTimeout(() => { if (m.act) m.act.look = -0.15; }, 900);
    if (!S.coins++) W.news?.('coin');
  }

  // ---------------------------------------------------------------- кадр
  update(dt, player, active) {
    this.t = (this.t || 0) + dt;
    this.coinCd = Math.max(0, this.coinCd - dt);
    // Дети снова взрослого роста, когда ушли из виду
    for (let i = this.kids.length - 1; i >= 0; i--) {
      const k = this.kids[i];
      if (k.state === 'actor') continue;
      if (k.state === 'none' || k.pos.distanceTo(player.pos) > 160) { k.h = k.h0; this.kids.splice(i, 1); }
    }
    const S = this.cur;
    if (!S) {
      if (!active) return;
      if ((this.wait -= dt) <= 0) this.start(player);
      return;
    }
    S.t += dt;
    // Улетел далеко или вышел из Симулятора — сцена тихо кончается
    const at = S.kind === 'chase' ? S.thief.pos : S.kind === 'fire' ? S.car.pos : S.kind === 'cat' ? S.kid.pos : S.man.pos;
    if (!active || at.distanceTo(player.pos) > 950) { this.end(); return; }
    this['update_' + S.kind](dt, player);
  }

  end() {
    const S = this.cur;
    if (!S) return;
    const W = this.world;
    for (const p of S.actors) W.people.release(p);
    if (S.kind === 'chase') for (const c of S.cops) if (c.state === 'scene') { c.state = 'wreck'; c.timer = S.done === 'win' ? 20 : 39; }
    if (S.kind === 'fire') { if (!S.out) S.burn.life = S.burn.t + 4; if (S.car.state === 'scene') { S.car.state = 'wreck'; S.car.timer = 0; } }
    for (const L of this.lights) L.visible = false;
    this.cat.visible = false;
    this.guitar.visible = false;
    this.cur = null;
    this.wait = 60 + Math.random() * 60;
  }

  reset() {
    this.end();
    for (const k of this.kids) k.h = k.h0;
    this.kids.length = 0;
    this.wait = 45;
  }
}
