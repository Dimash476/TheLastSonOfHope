import * as THREE from 'three';
import { Titan, TITAN } from './titan.js';

// Режим «Битва с боссом»: Колосс падает на город, герой должен его остановить.
// Проигрыш — если у героя кончилось здоровье. Разрушения не ограничены: пока герой
// далеко, Колосс идёт крушить центр.

const SPAWN = new THREE.Vector3(-420, 0, -1180);   // центральный парк, ~1 км от небоскрёбов
const _p = new THREE.Vector3();

export class BossBattle {
  constructor(scene, world, player, hud, camera) {
    this.world = world;
    this.player = player;
    this.hud = hud;
    this.camera = camera;
    this.titan = new Titan(scene, world, this);
    this.active = false;
    this.ended = false;
    this.onEnd = null;
    const $ = (id) => document.getElementById(id);
    this.el = {
      ui: $('boss-ui'), phase: $('boss-phase'), fill: $('boss-fill'), lag: $('boss-lag'),
      hero: $('hero-ui'), heroFill: $('hero-fill'), heroLag: $('hero-lag'), heroTxt: $('hero-value'),
      marker: $('boss-marker'), markerTxt: $('boss-marker-d'), hurt: $('hurt-flash'),
    };
  }

  start() {
    this.active = true;
    this.ended = false;
    this.heroHP = 100;
    this.heroDown = false;
    this.lastHurt = -99;
    this.lastHurtAny = -99;
    this.time = 0;
    this.endT = null;
    this.hurtK = 0;
    this.lagBoss = 1;
    this.lagHero = 1;
    this.titan.spawn(SPAWN);
    this.world.boss = this.titan;
    this.player.knockT = 0;
    this.el.ui.classList.remove('hidden');
    this.el.hero.classList.remove('hidden');
    this.el.phase.textContent = 'ФАЗА 1 · ПРОБУЖДЕНИЕ';
    this.banner('ТРЕВОГА! НА ГОРОД ПАДАЕТ КОЛОСС', 3.5);
    setTimeout(() => { if (this.active && !this.ended && this.time > 3) this.banner('ОСТАНОВИ КОЛОССА!', 3); }, 4200);
  }

  stop() {
    this.active = false;
    this.world.boss = null;
    this.titan.hide();
    this.player.knockT = 0;
    this.el.ui.classList.add('hidden');
    this.el.hero.classList.add('hidden');
    this.el.marker.classList.add('hidden');
    this.el.hurt.style.opacity = 0;
  }

  banner(text, t = 2.2) { this.hud.toast(text, t); }

  onPhase(ph) {
    this.el.phase.textContent = ph === 2 ? 'ФАЗА 2 · ЯРОСТЬ' : 'ФАЗА 3 · СЕРДЦЕ МАГМЫ';
    this.banner(ph === 2 ? 'ФАЗА 2 · ЯРОСТЬ — БЕРЕГИСЬ ЛУЧА ИЗ ГЛАЗ' : 'ФАЗА 3 · СЕРДЦЕ МАГМЫ', 3);
  }

  onBossDown() {
    if (this.endT !== null) return;
    this.endT = 5.5;
    this.endWin = true;
    this.banner('КОЛОСС ПОВЕРЖЕН!', 3.5);
  }

  // Урон герою. knock — скорость отброса (или null), cont — непрерывный урон (луч)
  hurtHero(amount, knock, cont = false) {
    if (!this.active || this.ended || this.heroDown) return;
    if (!cont && this.time - this.lastHurt < 0.5) return;
    const P = this.player, W = this.world;
    this.heroHP = Math.max(0, this.heroHP - amount);
    this.lastHurtAny = this.time;
    this.hurtK = Math.min(1, this.hurtK + (cont ? amount * 0.04 : 0.65));
    if (!cont) {
      this.lastHurt = this.time;
      W.audio?.punch(1, 'concrete', P.pos.clone());
      W.effects.impactFX(0.7, null, 0.1, 7);
    }
    if (knock) {
      P.vel.copy(knock);
      P.knockT = 0.65;
      P.grounded = false;
      P.falling = false;
      P.slamming = false;
      P.dashT = 0;
      P.charge = 0;
      P.hitstop = Math.max(P.hitstop, 0.06);
    }
    if (this.heroHP <= 0) {
      this.titan.releaseHero();
      this.titan.dropFromHero();
      this.heroDown = true;
      P.knockT = 3;
      if (!knock) P.vel.set(0, -20, 0);
      this.finishIn(false, 'hero', 2.8);
      this.banner('ГЕРОЙ ПОВЕРЖЕН', 2.8);
    }
  }

  finishIn(win, reason, t) {
    if (this.endT !== null) return;
    this.endT = t;
    this.endWin = win;
    this.endReason = reason;
  }

  update(dt, realDt) {
    if (!this.active) return;
    this.time += dt;
    const T = this.titan;
    T.update(dt, this.player);

    // Здоровье героя понемногу восстанавливается, если 8 с его не задевали
    if (!this.heroDown && this.time - this.lastHurtAny > 8) this.heroHP = Math.min(100, this.heroHP + 3 * dt);
    if (this.endT !== null && !this.ended) {
      this.endT -= realDt;
      if (this.endT <= 0) this.finish();
    }

    // ---- полосы
    const bossK = Math.max(0, T.hp / TITAN.hp), heroK = this.heroHP / 100;
    this.lagBoss = Math.max(bossK, this.lagBoss - realDt * 0.25);
    this.lagHero = Math.max(heroK, this.lagHero - realDt * 0.4);
    this.el.fill.style.width = `${bossK * 100}%`;
    this.el.lag.style.width = `${this.lagBoss * 100}%`;
    this.el.ui.classList.toggle('stagger', T.state === 'stagger');
    this.el.heroFill.style.width = `${heroK * 100}%`;
    this.el.heroLag.style.width = `${this.lagHero * 100}%`;
    this.el.hero.classList.toggle('low', heroK < 0.3);
    const hpTxt = `${Math.ceil(this.heroHP)} / 100`;
    if (hpTxt !== this.lastHpTxt) { this.el.heroTxt.textContent = hpTxt; this.lastHpTxt = hpTxt; }
    this.hurtK = Math.max(0, this.hurtK - realDt * 1.6);
    this.el.hurt.style.opacity = Math.min(1, this.hurtK + (heroK < 0.3 && !this.heroDown ? 0.25 + 0.1 * Math.sin(this.time * 6) : 0));

    // ---- метка: где Колосс (когда далеко или за кадром)
    const cam = this.camera;
    _p.copy(T.wp.headTop).y += 10;
    const d = _p.distanceTo(cam.position);
    const show = T.root.visible && T.state !== 'dead' && d > 250;
    this.el.marker.classList.toggle('hidden', !show);
    if (show) {
      _p.project(cam);
      let x = _p.x, y = _p.y;
      const behind = _p.z > 1;
      if (behind) { x = -x; y = -y; }
      const k = Math.max(Math.abs(x) / 0.92, Math.abs(y) / 0.85, behind ? 1.0001 : 0);
      const edge = k > 1;
      if (edge) { x /= k; y /= k; }
      this.el.marker.style.transform = `translate(${(x * 0.5 + 0.5) * window.innerWidth}px, ${(-y * 0.5 + 0.5) * window.innerHeight}px)`;
      this.el.marker.classList.toggle('edge', edge);
      this.el.markerTxt.textContent = d >= 1000 ? `${(d / 1000).toFixed(1).replace('.', ',')} км` : `${Math.round(d)} м`;
    }
  }

  finish() {
    this.ended = true;
    const m = Math.floor(this.time / 60), s = Math.floor(this.time % 60);
    const lost = this.titan.cityLoss;
    const stats = `Время боя ${m}:${String(s).padStart(2, '0')} · разрушено Колоссом зданий: ${lost}`;
    if (this.endWin) this.onEnd?.(true, 'ГОРОД СПАСЁН', `Колосс повержен. ${stats}`);
    else this.onEnd?.(false, 'ГЕРОЙ ПОВЕРЖЕН', `Колосс оказался сильнее — в этот раз. ${stats}`);
  }
}
