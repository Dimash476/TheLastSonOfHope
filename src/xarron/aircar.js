import * as THREE from 'three';
import { CX, CZ, R_CITY } from './tarven.js';

// Сцена Тарвэна: аэрокар над городом теряет тягу — дымит, мигает и падает.
// Догнать и коснуться (или E рядом) — герой ловит его над головой; E у земли или крыши — опустить.
// Жители внизу ликуют, «Голос Тарвэна» (радио, I) рассказывает об этом. Не успел — машина разбивается.

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

export class AirRescue {
  constructor(life) {
    this.life = life;          // XarronLife: city, folk, world, player, say, radioSay
    this.c = null;             // аэрокар сцены (из SkyTraffic.cars), на нём — fall
    this.wait = 50;
    // Для героя: «что держим» (player.held.sys) — координаты города ↔ мира
    const self = this;
    this.sys = {
      hold() {},
      setHeld(c, p, yawQ) { self.life.city.toCity(p, c.fall.p).y += 1.9; c.fall.q.copy(yawQ); },
      throwObj(c, vel) { self.drop(vel); },
      damageCar() {},
    };
  }

  // Точка в мире по координатам города
  wp(p) { return this.life.city.toWorld(p, new THREE.Vector3()); }

  start(h) {
    const T = this.life.city.traffic;
    // Аэрокар в 250–650 м от героя, над жилыми кольцами
    const fit = T.cars.filter((c) => !c.big && !c.fall && c.x !== undefined && Math.hypot(c.x - CX, c.z - CZ) < R_CITY - 300 && Math.hypot(c.x - h.x, c.z - h.z) > 250 && Math.hypot(c.x - h.x, c.z - h.z) < 650);
    if (!fit.length) { this.wait = 8; return; }
    const c = this.c = fit[Math.floor(Math.random() * fit.length)];
    c.fall = { p: new THREE.Vector3(c.x, c.y, c.z), q: new THREE.Quaternion().setFromAxisAngle(UP, c.yaw), v: new THREE.Vector3(Math.sin(c.yaw) * 18, 0, Math.cos(c.yaw) * 18), state: 'stall', t: 0, spin: (Math.random() < 0.5 ? -1 : 1) * 0.6, smokeT: 0, beepT: 0 };
    this.life.radioSay('КАНАЛ ГВАРДИИ: Аэрокар без тяги над кольцом! Падает! Всем бортам — в сторону!', 5);
    this.life.world.news?.('tarven:aircar', { now: true });
  }

  // Отпустили из рук (R или ЛКМ): снова падает, с той скоростью, что дали
  drop(vel) {
    const F = this.c?.fall;
    if (!F) return;
    F.state = 'fall';
    F.v.copy(vel).clampLength(0, 40);
  }

  update(dt, input) {
    const L = this.life, P = L.player, W = L.world;
    const h = L.city.toCity(P.pos, _w);
    if (!this.c) {
      if (P.grounded || h.y < L.city.hC + 3000) if ((this.wait -= dt) <= 0) this.start(h);
      return false;
    }
    const c = this.c, F = c.fall;
    F.t += dt;
    const held = P.held?.kind === 'aircar';
    if (F.state === 'stall' || F.state === 'fall') {
      // Сначала клюёт носом и теряет высоту, потом падает
      if (F.state === 'stall' && F.t > 3) F.state = 'fall';
      F.v.y -= (F.state === 'stall' ? 3 : 9) * dt;
      F.v.y = Math.max(F.v.y, -34);
      F.v.x *= Math.exp(-0.4 * dt); F.v.z *= Math.exp(-0.4 * dt);
      F.p.addScaledVector(F.v, dt);
      F.q.multiply(_q.setFromAxisAngle(UP, F.spin * dt)).multiply(_q.setFromAxisAngle(_v.set(1, 0, 0), Math.sin(F.t * 3) * 0.3 * dt));
      // Дым и короткий писк тревоги
      if ((F.smokeT -= dt) <= 0) {
        F.smokeT = 0.05;
        W.dust?.burst(this.wp(F.p), 1, { size: [1.5, 3.5], speed: 1, life: [1.5, 3], color: 0x2a2826, alpha: 0.55 });
        if (Math.random() < 0.3) W.sparks?.burst(this.wp(F.p), 2, { size: [0.2, 0.4], speed: 5, life: [0.2, 0.4], color: 0xffb060 });
      }
      if ((F.beepT -= dt) <= 0) {
        F.beepT = 0.7;
        const a = W.audio;
        if (a?.ctx) { const d = a.out(this.wp(F.p)); a.tone({ dur: 0.12, from: 1320, to: 1300, gain: 0.05, type: 'square', dest: d }); a.tone({ dur: 0.12, from: 990, to: 980, gain: 0.05, type: 'square', delay: 0.16, dest: d }); }
      }
      // Коснулся — поймал; рядом — E
      const d = Math.hypot(F.p.x - h.x, F.p.y - (h.y + 1), F.p.z - h.z);
      const claim = !P.held && !P.driven && P.charge <= 0 && d < 9;
      if (claim) {
        if (d < 4.5 || input.interact) { input.interact = false; this.catch(); return true; }
        P.interactTarget = { type: 'xcatch', label: 'поймать аэрокар' };
      }
      // Земля или крыша
      const g = Math.max(L.city.ground(F.p.x, F.p.z), L.city.roofAt(F.p.x, F.p.z, F.p.y));
      if (F.p.y <= g + 0.6) this.crash(g);
      return claim;
    }
    if (F.state === 'held') {
      if (!held) { F.state = 'fall'; return false; }
      // У земли или крыши — E опустить
      const g = Math.max(L.city.ground(h.x, h.z), L.city.roofAt(h.x, h.z, h.y));
      if (h.y - g < 8 && P.vel.length() < 12) {
        P.interactTarget = { type: 'xplace', label: 'опустить аэрокар' };
        if (input.interact) { input.interact = false; this.setDown(g); }
        return true;
      }
      return false;
    }
    if (F.state === 'down' || F.state === 'wreck') {
      // Постоит, потом взлетит на свою полосу (разбитый — просто исчезнет)
      if (F.t > 25) {
        if (F.state === 'wreck') { this.finish(); return false; }
        F.state = 'rise'; F.t = 0;
      }
      return false;
    }
    if (F.state === 'rise') {
      // Вертикально вверх, потом догоняет свою полосу
      if (F.t < 4) F.p.y += 10 * dt;
      else F.p.lerp(_v.set(c.x, c.y, c.z), Math.min(1, dt * 0.9 * (F.t - 3)));
      _q.setFromAxisAngle(UP, c.yaw);
      F.q.slerp(_q, Math.min(1, dt * 2));
      if ((F.t > 4 && F.p.distanceTo(_v.set(c.x, c.y, c.z)) < 4) || F.t > 20) this.finish();
    }
    return false;
  }

  catch() {
    const L = this.life, P = L.player, W = L.world, F = this.c.fall;
    F.state = 'held';
    P.held = { kind: 'aircar', sys: this.sys, ref: this.c };
    P.vel.multiplyScalar(0.4);
    W.audio?.metal(0.5, this.wp(F.p));
    W.effects?.shockwave(P.center.clone(), { type: 'sphere', radius: 8, life: 0.35, opacity: 0.35 });
    L.later(0.8, () => L.say('— Держу. Не двигайтесь.', 2.6));
  }

  setDown(g) {
    const L = this.life, P = L.player, W = L.world, F = this.c.fall;
    P.held = null;
    P.helpT = 0.6;
    const h = L.city.toCity(P.pos, _w);
    F.p.set(h.x + P.facing.x * 3.2, g + 0.45, h.z + P.facing.z * 3.2);
    _q.setFromAxisAngle(UP, Math.atan2(P.facing.x, P.facing.z));
    F.q.copy(_q);
    F.state = 'down'; F.t = 0;
    W.dust?.burst(this.wp(F.p), 6, { size: [1, 2.5], speed: 3, life: [0.5, 1] });
    W.audio?.land(0.4, this.wp(F.p));
    this.cheer(F.p);
    L.later(1.5, () => L.say(Math.random() < 0.5 ? '— Ты… ты сын Илиры? Спасибо. Спасибо!' : '— Мы живы… Дома не поверят.', 3.5));
    W.news?.('tarven:aircarWin');
  }

  crash(g) {
    const L = this.life, W = L.world, F = this.c.fall;
    F.p.y = g + 0.4;
    F.state = 'wreck'; F.t = 0;
    const p = this.wp(F.p);
    W.fire?.explosion(p, 0.5);
    W.audio?.explosion(0.45, p);
    W.effects?.shockwave(p, { type: 'sphere', radius: 12, life: 0.5, opacity: 0.35, color: 0xffb060 });
    L.folk.impulse(F.p, 25, 12);
    W.news?.('tarven:aircarLost');
  }

  cheer(at) {
    for (const p of this.life.folk.list) {
      if (p.mode === 'fly' || Math.hypot(p.x - at.x, p.z - at.z) > 70) continue;
      p.noticed = true; p.react = 'cheer'; p.reactT = 0;
    }
    this.life.world.soundscape?.cheer?.(0.5, this.wp(at));
  }

  finish() {
    if (this.c) this.c.fall = null;
    this.c = null;
    this.wait = 90 + Math.random() * 70;
  }

  reset() {
    if (this.life.player.held?.kind === 'aircar') this.life.player.held = null;
    this.finish();
    this.wait = 50;
  }
}
