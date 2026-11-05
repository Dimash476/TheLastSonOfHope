import * as THREE from 'three';
import { MACH, PLAYER } from './config.js';
import { BODIES } from './world/bodies.js';

const _p = new THREE.Vector3(), _up = new THREE.Vector3();
const fmtKm = (m) => {
  const km = m / 1000;
  return km < 10 ? `${km.toFixed(1).replace('.', ',')} км` : `${Math.round(km).toLocaleString('ru-RU')} км`;
};

export class HUD {
  constructor() {
    const $ = (id) => document.getElementById(id);
    this.el = {
      hud: $('hud'), speed: $('speed-value'), speedUnit: $('speed-unit'), mach: $('mach'), alt: $('alt-value'),
      destroyed: $('destroyed-value'), fps: $('fps-value'), help: $('help'), toast: $('toast'),
      chargeWrap: $('charge-wrap'), chargeFill: $('charge-fill'), interact: $('interact'),
    };
    this.fpsAcc = 0; this.fpsFrames = 0;
    this.toastTimer = 0;
    // Метки Луны и планет в космосе: название и расстояние до поверхности
    this.bodyMarks = BODIES.map((b) => {
      const el = document.createElement('div');
      el.className = 'body-marker hidden';
      el.innerHTML = `<span class="name">${b.name}</span><span class="dist"></span><div class="pin"></div>`;
      this.el.hud.appendChild(el);
      return { b, el, dist: el.querySelector('.dist'), last: '' };
    });
  }

  // Метки ставим над диском тела; рядом с телом (его имя уже в HUD) и позади камеры — прячем
  markers(camera, player, show) {
    show = show && camera.position.y > 25000;
    camera.updateMatrixWorld();
    _up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    const w = window.innerWidth, h = window.innerHeight;
    for (const m of this.bodyMarks) {
      const b = m.b;
      let vis = show && player.nearBody !== b;
      if (vis) {
        // «Перед камерой» — по знаку z в её системе (project() не годится: тела дальше far)
        vis = _p.copy(b.c).applyMatrix4(camera.matrixWorldInverse).z < 0;
        _p.applyMatrix4(camera.projectionMatrix);
        vis = vis && Math.abs(_p.x) < 1.1 && Math.abs(_p.y) < 1.1;
      }
      if (vis) {
        const x = Math.min(w - 50, Math.max(50, (_p.x * 0.5 + 0.5) * w)), y = (0.5 - _p.y * 0.5) * h;
        _p.copy(b.c).addScaledVector(_up, b.r * (b.rings ? 1.2 : 1)).applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix);
        const top = Math.min(y, (0.5 - _p.y * 0.5) * h);
        vis = y - top < h * 0.35;   // тело уже во весь экран — метка не нужна
        m.el.style.transform = `translate(${x.toFixed(1)}px, ${(top - 6).toFixed(1)}px) translate(-50%, -100%)`;
        const txt = fmtKm(player.pos.distanceTo(b.c) - b.r);
        if (txt !== m.last) { m.dist.textContent = txt; m.last = txt; }
      }
      m.el.classList.toggle('hidden', !vis);
    }
  }

  show(v) { this.el.hud.classList.toggle('hidden', !v); }
  toggleHelp() {
    // В бою подсказка по умолчанию скрыта (#hud.fight): там H её показывает
    if (this.el.hud.classList.contains('fight')) this.el.help.classList.toggle('shown');
    else this.el.help.classList.toggle('hidden');
  }

  toast(text, t = 1.6) {
    this.el.toast.textContent = text;
    this.el.toast.classList.add('show');
    this.toastTimer = t;
  }

  update(dt, player, city) {
    const speed = player.vel.length();
    // Скорость в м/с; от 1000 м/с — в км/с
    if (speed < 1000) {
      this.el.speed.textContent = Math.round(speed);
      this.el.speedUnit.textContent = 'м/с';
    } else {
      this.el.speed.textContent = (speed / 1000).toFixed(speed < 10000 ? 2 : 1).replace('.', ',');
      this.el.speedUnit.textContent = 'км/с';
    }
    const m = speed / MACH;
    this.el.mach.textContent = `MACH ${m.toFixed(2)}`;
    this.el.mach.classList.toggle('supersonic', m >= 1);
    // У Луны и планет — высота над их поверхностью
    const nb = player.nearBody;
    const alt = nb ? Math.max(0, player.bodyAlt) : player.pos.y;
    const altTxt = (alt >= 1000 ? `${(alt / 1000).toFixed(alt >= 100000 ? 0 : 1)} км` : `${Math.round(alt)} м`) + (nb ? ` · ${nb.name}` : '');
    if (altTxt !== this.lastAlt) { this.el.alt.textContent = altTxt; this.lastAlt = altTxt; }
    this.el.destroyed.textContent = city.destroyed;

    // Подсказка: можно погладить собаку или кошку
    const pet = player.petting || player.petTarget;
    const it = player.interactTarget;
    const act = it ? `<kbd>E</kbd> ${it.type === 'help' ? 'помочь подняться' : it.type === 'ball' ? 'бросить мяч' : 'поприветствовать'}` : '';
    const petTxt = pet ? `<kbd>ПКМ</kbd> погладить ${pet.kind === 'dog' ? 'собаку' : 'кошку'}` : '';
    // Посадка: сверху — на сам шар, сбоку и снизу — перенос на отдельную карту. С карты — вверх, в космос
    const land = player.grounded ? ''
      : player.world.planetMap.active ? (player.bodyAlt > 200 ? 'выше 3 км — выход в космос' : '')
      : nb && player.belowCap ? 'сверху — посадка на шар, сбоку — перенос на карту планеты' : '';
    const txt = player.petting ? '♥' : [petTxt, act, land].filter(Boolean).join(' &nbsp;·&nbsp; ');
    if (txt !== this.lastInteract) { this.el.interact.innerHTML = txt; this.lastInteract = txt; }
    this.el.interact.classList.toggle('show', !!txt);

    const c = player.charge / PLAYER.heavyMaxCharge;
    this.el.chargeWrap.classList.toggle('active', c > 0);
    this.el.chargeFill.style.width = `${Math.round(c * 100)}%`;

    this.fpsAcc += dt; this.fpsFrames++;
    if (this.fpsAcc > 0.5) {
      // Если включилось адаптивное качество — показываем ступень рядом с FPS
      const ql = this.qualityLevel || 0;
      this.el.fps.textContent = Math.round(this.fpsFrames / this.fpsAcc) + (ql > 0 ? ` · эконом ${ql}` : '');
      this.fpsAcc = 0; this.fpsFrames = 0;
    }

    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.el.toast.classList.remove('show');
    }
  }
}
