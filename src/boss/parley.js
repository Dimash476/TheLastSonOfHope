import * as THREE from 'three';

// Переговоры с генералом. Разговор идёт по дереву реплик: реплика ждёт, пока игрок её дочитает и нажмёт
// «Дальше», потом выбор ответа цифрой или мышью с ЛКМ (курсора в захвате мыши нет).
// Камера — крупный план, ответ — через плечо героя.

const TREE = {
  start: {
    text: 'Не торопись, сын Ксаррона. Я генерал Ксарг. Двадцать лет мы считали тебя мёртвым, а ты всё это время прятался среди них.',
    options: [
      { text: 'Откуда ты меня знаешь?', next: 'origin' },
      { text: 'Что тебе нужно от Земли?', next: 'demand' },
      { text: 'Улетай, пока можешь.', next: 'warn' },
      { text: '[Ударить первым]', end: 'strike', hot: true },
    ],
  },
  origin: {
    text: 'Твой знак на груди. Такой носил весь твой род. Твоя мать украла корабль в ночь перед присягой и увезла тебя сюда. Совет называет это изменой. Я называю слабостью.',
    options: [
      { text: 'Что тебе нужно от Земли?', next: 'demand' },
      { text: 'Не смей говорить о ней.', next: 'warn' },
    ],
  },
  warn: {
    text: 'Улетать? Смотри наверх. За этим кораблём идёт ещё сорок. Ты один, и дерёшься ты так, как тебя научили они. Я не враг тебе, пока сам этого не захочешь.',
    options: [
      { text: 'Тогда чего ты хочешь?', next: 'demand' },
      { text: 'Я уже захотел.', end: 'fight', hot: true },
    ],
  },
  demand: {
    text: 'Сначала я предложу то, чего им никто не предлагал. Земля склоняется перед Ксарроном и живёт как наша колония. Откажется — и я сожгу её до камня. Ты будешь наместником: тебя они послушают.',
    options: [
      { text: 'А если я соглашусь?', next: 'accept' },
      { text: 'Дай людям время решить.', next: 'time' },
      { text: 'Земля не склонится. Ни перед кем.', end: 'fight', hot: true },
    ],
  },
  time: {
    text: 'Время? Ксаррон дал им время: двадцать лет, пока ты здесь рос. Я не совет. Ответ — сейчас.',
    options: [
      { text: 'Хорошо. Что от меня требуется?', next: 'accept' },
      { text: 'Тогда ответ — нет.', end: 'fight', hot: true },
    ],
  },
  accept: {
    text: 'Присяга. Преклони колено. Потом докажи её делом: подними руку на этот город. Один удар, и они поймут, кто теперь над ними.',
    options: [
      { text: 'Я не трону этих людей.', end: 'fight', hot: true },
      { text: '[Преклонить колено]', end: 'kneel' },
    ],
  },
};

// Последнее слово генерала: его тоже можно дочитать, бой начнётся только после «Дальше»
const CLOSING = {
  fight: 'Значит, как и она, выбрал чужих. Жаль. Десант, взять его. Живым не обязательно.',
  kneel: 'Правильно. Теперь смотри, как это делается.',
};

const UP = new THREE.Vector3(0, 1, 0);
const _r = new THREE.Vector3();
const _h = new THREE.Vector3();

export class Parley {
  constructor(inv) {
    this.inv = inv;
    this.active = false;
    this.shot = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 40 };
    const $ = (id) => document.getElementById(id);
    this.el = { box: $('dialog'), who: $('dialog-who'), text: $('dialog-text'), opts: $('dialog-options'), next: $('dialog-next'), keys: $('dialog-keys') };
    this.nextKey = false;
    this.keyHandler = (e) => {
      if (!this.active || e.repeat) return;
      if (e.code === 'Space' || e.code === 'Enter') { this.nextKey = true; return; }
      if (!this.choosing) return;
      const n = e.code.startsWith('Digit') ? Number(e.code.slice(5)) : 0;
      if (n >= 1 && n <= this.node.options.length) this.pick(n - 1);
    };
    window.addEventListener('keydown', this.keyHandler);
    // Удержание героя в сцене: стоит напротив генерала и смотрит на него
    this.hold = (dt) => {
      const P = inv.player, X = inv.xarg;
      this.walk(dt, P, X);
    };
  }

  start() {
    const I = this.inv, X = I.xarg, P = I.player;
    this.active = true;
    this.placed = false;
    // Место разговора: герой и генерал лицом к лицу
    X.vel.set(0, 0, 0);
    X.go('stand');
    this.spot = new THREE.Vector3();
    _r.subVectors(P.pos, X.pos).setY(0);
    if (_r.lengthSq() < 1) _r.copy(X.facing);
    _r.normalize();
    this.spot.copy(X.pos).addScaledVector(_r, 10);
    this.spot.y = X.grounded ? I.world.city.groundHeightAt(this.spot.x, this.spot.z, X.pos.y + 8) : X.pos.y;
    P.driven = this.hold;
    P.lockDir = _r.clone().negate();
    P.punchT = -1;
    P.charge = 0;
    P.knockT = 0;
    P.slamming = false;
    P.lasering = false;
    this.shotKind = 'xarg';
    this.el.box.classList.remove('hidden');
    I.setCine(true);
    I.camRig.shot = this.shot;
    this.say('start');
  }

  say(id) { this.show(TREE[id]); }

  show(node) {
    this.node = node;
    this.choosing = false;
    this.selected = 0;
    this.typeT = 0;
    this.shown = 0;
    this.ready = false;
    this.nextKey = false;
    this.inputLock = 0.2;
    this.shotKind = 'xarg';
    this.el.who.textContent = 'ГЕНЕРАЛ КСАРГ';
    this.el.text.textContent = '';
    this.el.opts.innerHTML = '';
    this.el.opts.classList.add('hidden');
    this.el.next.classList.add('hidden');
    this.el.keys.classList.add('hidden');
    this.inv.world.audio?.tone({ dur: 0.5, from: 90, to: 60, gain: 0.1 });
  }

  // После «Дальше»: ответы или, если это последнее слово, сам итог разговора
  advance() {
    if (this.node.end) this.finish(this.node.end);
    else this.openChoices();
  }

  openChoices() {
    this.choosing = true;
    this.shotKind = 'hero';
    this.selected = 0;
    this.el.next.classList.add('hidden');
    this.el.keys.classList.remove('hidden');
    this.el.opts.innerHTML = '';
    this.node.options.forEach((o, i) => {
      const row = document.createElement('div');
      row.className = 'dialog-opt' + (o.hot ? ' hot' : '');
      row.innerHTML = `<b>${i + 1}</b> `;
      row.append(o.text);
      this.el.opts.append(row);
    });
    this.el.opts.classList.remove('hidden');
    this.mark();
    this.lookAcc = 0;
    this.inputLock = 0.25;
  }

  mark() {
    [...this.el.opts.children].forEach((c, i) => c.classList.toggle('sel', i === this.selected));
  }

  pick(i) {
    const o = this.node.options[i];
    this.inv.world.audio?.whoosh(0.15);
    this.lastPick = o.text;
    if (o.next) { this.say(o.next); return; }
    if (CLOSING[o.end]) { this.show({ text: CLOSING[o.end], end: o.end }); return; }
    this.finish(o.end);
  }

  finish(result) {
    const I = this.inv, P = I.player;
    this.active = false;
    this.choosing = false;
    this.el.box.classList.add('hidden');
    I.camRig.shot = null;
    I.setCine(false);
    P.driven = null;
    P.lockDir = null;
    I.onParleyEnd(result);
  }

  // Отмена (игрок ударил раньше или сцена прервана)
  cancel() {
    if (!this.active) return;
    this.active = false;
    this.choosing = false;
    this.el.box.classList.add('hidden');
    this.inv.camRig.shot = null;
    const P = this.inv.player;
    if (P.driven === this.hold) P.driven = null;
    P.lockDir = null;
  }

  walk(dt, P, X) {
    // Плавно на место: подлетает и опускается на землю
    _h.subVectors(this.spot, P.pos);
    const d = _h.length();
    const speed = Math.min(d * 2.6, 140);
    if (d > 0.4) {
      P.vel.copy(_h).divideScalar(d).multiplyScalar(speed);
      P.pos.addScaledVector(P.vel, dt);
      P.grounded = false;
      P.falling = false;
    } else {
      P.vel.set(0, 0, 0);
      P.pos.copy(this.spot);
      P.grounded = X.grounded;
    }
    P.groundY = this.spot.y;
    P.lockDir = (P.lockDir || new THREE.Vector3()).subVectors(X.pos, P.pos).setY(0).normalize();
  }

  // Камера и печать текста — по реальному времени; dtReal не зависит от замедлений
  update(realDt, input) {
    if (!this.active) return;
    const I = this.inv, X = I.xarg, P = I.player, S = this.shot;

    // Текст печатается; первое нажатие — сразу весь, следующее — дальше. Сам он никуда не уходит
    const txt = this.node.text;
    this.inputLock -= realDt;
    const press = (input.punch || this.nextKey) && this.inputLock <= 0;
    this.nextKey = false;
    if (!this.choosing) {
      this.typeT += realDt * 38;
      const n = Math.min(txt.length, Math.floor(this.typeT));
      if (n !== this.shown) { this.shown = n; this.el.text.textContent = txt.slice(0, n); }
      if (n >= txt.length && !this.ready) { this.ready = true; this.el.next.classList.remove('hidden'); }
      if (press) {
        if (n < txt.length) { this.typeT = txt.length; this.inputLock = 0.15; }
        else this.advance();
      }
    } else {
      // Выбор мышью: сдвиг вверх-вниз двигает строку
      this.lookAcc += input.lookDY;
      if (Math.abs(this.lookAcc) > 70) {
        const s = Math.sign(this.lookAcc), c = this.node.options.length;
        this.selected = (this.selected + s + c) % c;
        this.lookAcc = 0;
        this.mark();
      }
      if (press) this.pick(this.selected);
    }

    // Камера: крупно генерал, когда говорит; через плечо героя при выборе
    const head = X.model.skinned.bone('Head').getWorldPosition(_h);
    _r.crossVectors(X.facing, UP).normalize();
    if (this.shotKind === 'xarg') {
      this.smooth(_r.clone().multiplyScalar(0.42).add(head).addScaledVector(X.facing, 1.45).addScaledVector(UP, 0.02), head.clone().addScaledVector(UP, 0.04), 36, realDt);
    } else {
      const hc = P.pos.clone().addScaledVector(UP, 1.62);
      const back = X.pos.clone().sub(P.pos).setY(0).normalize();
      const rt = new THREE.Vector3().crossVectors(back, UP).normalize();
      this.smooth(hc.clone().addScaledVector(back, -2.3).addScaledVector(rt, 0.75).addScaledVector(UP, 0.1), head.clone(), 42, realDt);
    }
    void S;
  }

  smooth(pos, look, fov, dt) {
    const S = this.shot;
    if (!this.placed) { S.pos.copy(pos); S.look.copy(look); S.fov = fov; this.placed = true; return; }
    const k = 1 - Math.exp(-6 * dt);
    S.pos.lerp(pos, k);
    S.look.lerp(look, k);
    S.fov += (fov - S.fov) * k;
  }
}
