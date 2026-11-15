import * as THREE from 'three';
import { clamp, smoothstep } from '../utils.js';

// Режиссёр сцен режима «Сюжет». Сцена — обычная async-функция: она ставит кадры, говорит реплики
// и ждёт (await S.wait / S.say / S.move), а время ей отсчитывает update из общего цикла.
// Пока сцена идёт: кинорамка, приборы спрятаны, герой стоит (или им ведёт сама сцена через P.driven),
// камера снимает кадр camRig.shot. ЛКМ пропускает сцену: все ожидания сразу выполняются,
// сцена доходит до конца без пауз и оставляет мир в том виде, в каком он был бы после неё.

const _a = new THREE.Vector3(), _b = new THREE.Vector3();
const ease = (k) => smoothstep(0, 1, k);

export class Scene {
  constructor({ player, camRig }) {
    this.player = player;
    this.camRig = camRig;
    this.on = false;
    this.skipping = false;
    this.skippable = true;
    this.t = 0;                 // реальное время с начала сцены
    this.waits = [];            // [момент, resolve]
    this.tween = null;          // { from, to, t0, dur, curve }
    this.shot = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 45, roll: 0 };
    this.still = () => { this.player.vel.set(0, 0, 0); };
    const $ = (id) => document.getElementById(id);
    this.el = {
      hud: $('hud'), bars: $('cine-bars'), fade: $('story-fade'),
      sub: $('story-sub'), who: $('story-sub-who'), text: $('story-sub-text'),
      radio: $('story-radio'), card: $('story-card'), kicker: $('story-card-kicker'), title: $('story-card-title'),
    };
    this.gen = 0;               // номер запуска: старая сцена после новой ничего не трогает
    this.subT = 0;
    this.radioT = 0;
    this.radioQ = [];
  }

  // Запустить сцену. fn(S) — async-функция; промис выполнится, когда сцена кончится (или её пропустят)
  async play(fn, { skippable = true, camera = true, hold = true } = {}) {
    if (this.on) this.end();
    const gen = ++this.gen;
    this.on = true;
    this.skipping = false;
    this.skippable = skippable;
    this.t = 0;
    const P = this.player;
    if (hold) P.driven = this.still;
    // Кадр по умолчанию — за спиной героя, пока сцена не поставит свой
    if (camera) {
      this.cut(_a.copy(P.pos).add(_b.set(0, 3, 9)), _b.copy(P.pos).setY(P.pos.y + 1.4), 45);
      this.camRig.shot = this.shot;
    }
    this.setCine(true);
    // Сцена получает не сам режиссёр, а его «пульт»: если сцену сменила другая, все вызовы старой
    // становятся пустыми (и ожидания сразу выполняются), так что она не тронет кадр и не закончит новую
    const S = new Proxy(this, {
      get: (t, k) => {
        const v = t[k];
        if (typeof v !== 'function') return v;
        return gen === t.gen ? v.bind(t) : () => Promise.resolve();
      },
    });
    try { await fn(S); } catch (e) { console.error('Сцена упала:', e); }
    const mine = gen === this.gen;
    if (mine) this.end();
    return mine;
  }

  end() {
    if (!this.on) return;
    this.on = false;
    this.gen++;
    this.skipping = false;
    this.tween = null;
    for (const [, r] of this.waits) r();
    this.waits.length = 0;
    if (this.player.driven === this.still) this.player.driven = null;
    if (this.camRig.shot === this.shot) this.camRig.shot = null;
    this.setCine(false);
    this.hideSub();
    this.el.card.classList.remove('on');
  }

  skip() {
    if (!this.on || !this.skippable || this.skipping) return;
    this.skipping = true;
    this.hideSub();
    this.el.card.classList.remove('on');
    if (this.tween) { this.applyTween(1); this.tween = null; }
    for (const [, r] of this.waits) r();
    this.waits.length = 0;
  }

  setCine(on) {
    this.el.hud.classList.toggle('cine', on);
    this.el.hud.classList.toggle('story-cine', on);
    this.el.bars.classList.toggle('on', on);
  }

  // ---------------------------------------------------------------- время
  wait(t) {
    if (this.skipping || !this.on || !(t > 0)) return Promise.resolve();
    return new Promise((r) => this.waits.push([this.t + t, r]));
  }

  // ---------------------------------------------------------------- камера
  cut(pos, look, fov = this.shot.fov, roll = 0) {
    this.tween = null;
    this.shot.pos.copy(pos);
    this.shot.look.copy(look);
    this.shot.fov = fov;
    this.shot.roll = roll;
    this.camRig.shot = this.shot;
  }

  // Плавный проезд камеры от нынешнего кадра (или from) к to за t секунд; ждёт конца проезда
  move(to, t, from = null) {
    const f = from || this.shot;
    this.tween = {
      p0: f.pos.clone(), l0: f.look.clone(), f0: f.fov ?? this.shot.fov, r0: f.roll ?? 0,
      p1: to.pos.clone(), l1: to.look.clone(), f1: to.fov ?? this.shot.fov, r1: to.roll ?? 0,
      t0: this.t, dur: Math.max(0.01, t), curve: to.curve || ease,
    };
    this.camRig.shot = this.shot;
    if (this.skipping) { this.applyTween(1); this.tween = null; }
    return this.wait(t);
  }

  applyTween(k) {
    const T = this.tween, c = T.curve(clamp(k, 0, 1));
    this.shot.pos.lerpVectors(T.p0, T.p1, c);
    this.shot.look.lerpVectors(T.l0, T.l1, c);
    this.shot.fov = T.f0 + (T.f1 - T.f0) * c;
    this.shot.roll = T.r0 + (T.r1 - T.r0) * c;
  }

  // ---------------------------------------------------------------- слова
  // Реплика с именем говорящего; ждёт, пока её дочитают
  say(who, text, t = 0) {
    if (this.skipping) return Promise.resolve();
    const dur = Math.max(t, 1.8 + text.length * 0.06);
    this.line(who, text, dur);
    return this.wait(dur);
  }

  // То же без ожидания (реплика поверх действия)
  line(who, text, t = 0) {
    if (this.skipping) return;
    this.el.who.textContent = who || '';
    this.el.who.classList.toggle('hidden', !who);
    this.el.text.textContent = text;
    this.el.sub.classList.remove('hidden');
    this.subT = Math.max(t, 1.8 + text.length * 0.06);
  }

  hideSub() {
    this.subT = 0;
    this.el.sub.classList.add('hidden');
  }

  // Радио — строка сбоку, живёт и вне сцен (зов к следующей главе, диспетчер)
  radio(text, t = 5.5) {
    if (this.radioT > 0) { this.radioQ.push([text, t]); return; }
    this.el.radio.textContent = text;
    this.el.radio.classList.remove('hidden');
    this.radioT = t;
  }

  clearRadio() {
    this.radioQ.length = 0;
    this.radioT = 0;
    this.el.radio.classList.add('hidden');
  }

  // Затемнение: on — в чёрное, off — из чёрного, за t секунд
  fade(on, t = 1.2) {
    const el = this.el.fade;
    el.style.transition = this.skipping ? 'none' : `opacity ${t}s ease`;
    el.classList.toggle('on', on);
    return this.wait(t);
  }

  // Титр главы: маленькая строка сверху и большое название
  async card(kicker, title, t = 4.2) {
    if (this.skipping) return;
    this.el.kicker.textContent = kicker;
    this.el.title.textContent = title;
    this.el.card.classList.add('on');
    await this.wait(t);
    this.el.card.classList.remove('on');
    await this.wait(0.9);
  }

  // ---------------------------------------------------------------- кадр
  update(dt) {
    if (this.subT > 0) { this.subT -= dt; if (this.subT <= 0) this.hideSub(); }
    if (this.radioT > 0) {
      this.radioT -= dt;
      if (this.radioT <= 0) {
        this.el.radio.classList.add('hidden');
        const next = this.radioQ.shift();
        if (next) this.radio(next[0], next[1]);
      }
    }
    if (!this.on) return;
    this.t += dt;
    if (this.tween) {
      const k = (this.t - this.tween.t0) / this.tween.dur;
      this.applyTween(k);
      if (k >= 1) this.tween = null;
    }
    if (this.waits.length) {
      const due = this.waits.filter((w) => w[0] <= this.t);
      if (due.length) {
        this.waits = this.waits.filter((w) => w[0] > this.t);
        for (const [, r] of due) r();
      }
    }
  }
}
