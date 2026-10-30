import { MACH, PLAYER } from './config.js';

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
  }

  show(v) { this.el.hud.classList.toggle('hidden', !v); }
  toggleHelp() { this.el.help.classList.toggle('hidden'); }

  toast(text) {
    this.el.toast.textContent = text;
    this.el.toast.classList.add('show');
    this.toastTimer = 1.6;
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
    const alt = player.pos.y;
    this.el.alt.textContent = alt >= 1000 ? `${(alt / 1000).toFixed(alt >= 100000 ? 0 : 1)} км` : `${Math.round(alt)} м`;
    this.el.destroyed.textContent = city.destroyed;

    // Подсказка: можно погладить собаку или кошку
    const pet = player.petting || player.petTarget;
    const it = player.interactTarget;
    const act = it ? `<kbd>E</kbd> ${it.type === 'help' ? 'помочь подняться' : it.type === 'ball' ? 'бросить мяч' : 'поприветствовать'}` : '';
    const petTxt = pet ? `<kbd>ПКМ</kbd> погладить ${pet.kind === 'dog' ? 'собаку' : 'кошку'}` : '';
    const txt = player.petting ? '♥' : [petTxt, act].filter(Boolean).join(' &nbsp;·&nbsp; ');
    if (txt !== this.lastInteract) { this.el.interact.innerHTML = txt; this.lastInteract = txt; }
    this.el.interact.classList.toggle('show', !!txt);

    const c = player.charge / PLAYER.heavyMaxCharge;
    this.el.chargeWrap.classList.toggle('active', c > 0);
    this.el.chargeFill.style.width = `${Math.round(c * 100)}%`;

    this.fpsAcc += dt; this.fpsFrames++;
    if (this.fpsAcc > 0.5) {
      this.el.fps.textContent = Math.round(this.fpsFrames / this.fpsAcc);
      this.fpsAcc = 0; this.fpsFrames = 0;
    }

    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.el.toast.classList.remove('show');
    }
  }
}
