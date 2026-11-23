import * as THREE from 'three';
import { TALKS, ILIRA, drawPortrait } from './cast.js';

// Разговор с жителем Тарвэна. То же окно, что у переговоров с Ксаргом (#dialog), но с портретом
// собеседника. Герой стоит напротив, камера — крупно на того, кто говорит, а при выборе ответа —
// из-за плеча героя. Текст печатается; ЛКМ, пробел или Enter — дальше; 1–4 или мышь — ответ.

const UP = new THREE.Vector3(0, 1, 0);
const _h = new THREE.Vector3(), _r = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3();

export class Talk {
  constructor(life) {
    this.life = life;
    this.active = false;
    this.shot = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 38 };
    const $ = (id) => document.getElementById(id);
    this.el = { box: $('dialog'), who: $('dialog-who'), text: $('dialog-text'), opts: $('dialog-options'), next: $('dialog-next'), keys: $('dialog-keys'), face: $('dialog-face'), hud: $('hud'), bars: $('cine-bars') };
    this.faces = {};
    this.nextKey = false;
    window.addEventListener('keydown', (e) => {
      if (!this.active || e.repeat) return;
      if (e.code === 'Space' || e.code === 'Enter') { this.nextKey = true; return; }
      if (!this.choosing) return;
      const n = e.code.startsWith('Digit') ? Number(e.code.slice(5)) : 0;
      if (n >= 1 && n <= this.opts.length) this.pick(n - 1);
    });
    // Герой на месте разговора: подходит, встаёт и смотрит на собеседника
    this.hold = (dt) => {
      const P = this.player, d = _h.subVectors(this.spot, P.pos), l = d.length();
      if (l > 0.3) { P.vel.copy(d).multiplyScalar(Math.min(6, l * 3) / l); P.pos.addScaledVector(P.vel, dt); }
      else { P.vel.set(0, 0, 0); P.pos.copy(this.spot); }
      P.grounded = true; P.falling = false;
      P.groundY = this.spot.y;
      P.lockDir = (P.lockDir || new THREE.Vector3()).subVectors(this.npcPos, P.pos).setY(0).normalize();
    };
  }

  start(c, player, camRig) {
    const L = this.life, S = L.state, p = c.person;
    this.c = c; this.player = player; this.camRig = camRig;
    this.tree = TALKS[c.id];
    this.visited = new Set();
    this.active = true;
    // Место героя: в двух с половиной метрах перед собеседником, на той же земле
    this.npcPos = L.city.toWorld(_a.set(p.x, p.y, p.z), new THREE.Vector3());
    _r.subVectors(player.pos, this.npcPos).setY(0);
    if (_r.lengthSq() < 0.01) _r.set(Math.sin(p.yaw), 0, Math.cos(p.yaw));
    _r.normalize();
    this.spot = this.npcPos.clone().addScaledVector(_r, 2.5);
    this.spot.y = this.npcPos.y;
    p.yaw = Math.atan2(_r.x, _r.z);
    player.driven = this.hold;
    player.punchT = -1; player.charge = 0; player.slamming = false; player.lasering = false;
    this.el.box.classList.remove('hidden');
    this.el.box.classList.add('face');
    this.el.hud.classList.add('cine');
    this.el.bars.classList.add('on');
    camRig.shot = this.shot;
    this.shotInit = false;
    this.show(this.tree.start(S));
    if (!S.met[c.id]) { S.met[c.id] = true; L.save(); }
  }

  node(id) { return this.tree.nodes[id]; }

  show(id) {
    const n = this.node(id), L = this.life, S = L.state;
    this.id = id;
    this.n = n;
    this.visited.add(id);
    if (n.set) { S.facts[n.set] = true; L.save(); }
    if (n.act) L.act(n.act);
    this.txt = typeof n.text === 'function' ? n.text(S) : n.text;
    this.choosing = false;
    this.typeT = 0; this.shown = 0; this.ready = false;
    this.inputLock = 0.25;
    this.nextKey = false;
    const who = n.who === 'ilira' ? ILIRA : this.c;
    this.speaker = who;
    this.el.who.textContent = who.name.toUpperCase();
    this.el.who.style.color = who.color;
    this.el.box.style.borderTopColor = who.color;
    this.setFace(who);
    this.el.text.textContent = '';
    this.el.opts.innerHTML = '';
    this.el.opts.classList.add('hidden');
    this.el.next.classList.add('hidden');
    this.el.keys.classList.add('hidden');
    L.world.audio?.tone({ dur: 0.4, from: n.who === 'ilira' ? 520 : 180, to: n.who === 'ilira' ? 380 : 120, gain: 0.06 });
  }

  setFace(who) {
    const f = this.faces[who.id] || (this.faces[who.id] = drawPortrait(who.face));
    const g = this.el.face.getContext('2d');
    g.clearRect(0, 0, 240, 300);
    g.drawImage(f, 0, 0);
  }

  // Ответы: свои или общие «темы» (hub); темы, по которым уже говорили, не повторяем
  options() {
    const S = this.life.state, n = this.n;
    const list = n.options === 'hub' ? this.node('hub').options : n.options;
    return list.filter((o) => (!o.if || o.if(S)) && !(o.next && o.next !== 'bye' && this.visited.has(o.next)));
  }

  advance() {
    const n = this.n;
    if (n.next) { this.show(n.next); return; }
    if (n.end || !n.options) { this.finish(); return; }
    this.openChoices();
  }

  openChoices() {
    this.opts = this.options();
    if (!this.opts.length) { this.finish(); return; }
    this.choosing = true;
    this.selected = 0;
    this.lookAcc = 0;
    this.inputLock = 0.25;
    this.el.next.classList.add('hidden');
    this.el.keys.classList.remove('hidden');
    this.el.opts.innerHTML = '';
    this.opts.forEach((o, i) => {
      const row = document.createElement('div');
      row.className = 'dialog-opt' + (o.hot ? ' hot' : '');
      row.innerHTML = `<b>${i + 1}</b> `;
      row.append(o.text);
      this.el.opts.append(row);
    });
    this.el.opts.classList.remove('hidden');
    this.mark();
  }

  mark() { [...this.el.opts.children].forEach((c, i) => c.classList.toggle('sel', i === this.selected)); }

  pick(i) {
    const o = this.opts[i];
    this.life.world.audio?.whoosh(0.12);
    if (o.next) this.show(o.next);
    else this.finish();
  }

  finish() {
    if (!this.active) return;
    this.active = false;
    this.choosing = false;
    this.el.box.classList.add('hidden');
    this.el.box.classList.remove('face');
    this.el.box.style.borderTopColor = '';
    this.el.who.style.color = '';
    this.el.hud.classList.remove('cine');
    this.el.bars.classList.remove('on');
    if (this.camRig.shot === this.shot) this.camRig.shot = null;
    const P = this.player;
    if (P.driven === this.hold) P.driven = null;
    P.lockDir = null;
  }

  update(dt, input) {
    if (!this.active) return;
    this.inputLock -= dt;
    const press = (input.punch || this.nextKey) && this.inputLock <= 0;
    this.nextKey = false;
    input.punch = false;
    if (!this.choosing) {
      this.typeT += dt * 40;
      const n = Math.min(this.txt.length, Math.floor(this.typeT));
      if (n !== this.shown) { this.shown = n; this.el.text.textContent = this.txt.slice(0, n); }
      if (n >= this.txt.length && !this.ready) { this.ready = true; this.el.next.classList.remove('hidden'); }
      if (press) {
        if (n < this.txt.length) { this.typeT = this.txt.length; this.inputLock = 0.15; }
        else this.advance();
      }
    } else {
      this.lookAcc += input.lookDY;
      if (Math.abs(this.lookAcc) > 70) {
        const s = Math.sign(this.lookAcc), c = this.opts.length;
        this.selected = (this.selected + s + c) % c;
        this.lookAcc = 0;
        this.mark();
      }
      if (press) this.pick(this.selected);
    }
    this.frame(dt);
  }

  // Кадр: крупно собеседник, пока говорит; из-за плеча героя, пока выбираем ответ
  frame(dt) {
    const L = this.life, p = this.c.person, P = this.player;
    const head = L.headOf(this.c, _a);
    const face = _r.set(Math.sin(p.yaw), 0, Math.cos(p.yaw));
    const side = _b.crossVectors(face, UP).normalize();
    let pos, look;
    if (!this.choosing) {
      // Средний план: по грудь, чуть сбоку
      pos = head.clone().addScaledVector(face, 1.75).addScaledVector(side, 0.6).addScaledVector(UP, -0.02);
      look = head.clone().addScaledVector(UP, -0.14).addScaledVector(side, -0.2);
    } else {
      const hc = P.pos.clone().addScaledVector(UP, 1.62);
      const back = this.npcPos.clone().sub(P.pos).setY(0).normalize();
      const rt = new THREE.Vector3().crossVectors(back, UP).normalize();
      pos = hc.clone().addScaledVector(back, -2.2).addScaledVector(rt, 0.75).addScaledVector(UP, 0.12);
      look = head.clone();
    }
    const S = this.shot, k = this.shotInit ? 1 - Math.exp(-dt * 3.5) : 1;
    S.pos.lerp(pos, k);
    S.look.lerp(look, k);
    S.fov = 38;
    this.shotInit = true;
  }
}
