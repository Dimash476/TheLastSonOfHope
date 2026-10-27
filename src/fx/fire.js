import * as THREE from 'three';
import { Particles } from './particles.js';

// Огонь и дым: горящие машины, взорванные заправки.
export class Fire {
  constructor(scene, smoke) {
    this.flames = new Particles(scene, { max: 2500, additive: true, color: 0xff7a22, drag: 1.5 });
    this.smoke = smoke; // общая система пыли — дым рисуем ей же
    this.emitters = [];
    this._p = new THREE.Vector3();
  }

  // target — объект с полем pos (тогда огонь едет вместе с ним)
  add(pos, { size = 1, life = 20, target = null } = {}) {
    const e = { pos: pos.clone(), size, life, t: 0, target, acc: 0 };
    this.emitters.push(e);
    return e;
  }

  // Огненный шар взрыва
  explosion(pos, k = 1) {
    this.flames.burst(pos, Math.round(40 * k), { size: [4 * k, 10 * k], speed: 18 * k, life: [0.4, 1.0], color: 0xffa040, rise: 6 });
    this.flames.burst(pos, Math.round(20 * k), { size: [6 * k, 14 * k], speed: 8 * k, life: [0.6, 1.3], color: 0xff5010, rise: 10 });
    this.smoke.burst(pos, Math.round(18 * k), { size: [10 * k, 24 * k], speed: 10 * k, life: [4, 8], color: 0x2a2622, rise: 4, delay: 0.3, alpha: 0.85 });
  }

  update(dt) {
    for (let i = this.emitters.length - 1; i >= 0; i--) {
      const e = this.emitters[i];
      e.t += dt;
      if (e.target) e.pos.copy(e.target.pos);
      const fade = Math.min(1, (e.life - e.t) / 4);
      if (e.t >= e.life || (e.target && e.target.dead)) { this.emitters.splice(i, 1); continue; }
      // Частота частиц ∝ размеру огня
      e.acc += dt * 30 * e.size * fade;
      while (e.acc >= 1) {
        e.acc -= 1;
        this._p.set(e.pos.x + (Math.random() - 0.5) * 2 * e.size, e.pos.y + 0.5, e.pos.z + (Math.random() - 0.5) * 2 * e.size);
        this.flames.burst(this._p, 1, { size: [1.5 * e.size, 3.5 * e.size], speed: 1.5, life: [0.5, 1.1], color: Math.random() < 0.5 ? 0xff8a2a : 0xffc04a, rise: 9 });
        if (Math.random() < 0.35) {
          this._p.y += 2 * e.size;
          this.smoke.burst(this._p, 1, { size: [4 * e.size, 9 * e.size], speed: 1.5, life: [4, 8], color: 0x2c2825, rise: 3, alpha: 0.7 });
        }
      }
    }
    this.flames.update(dt);
  }

  setScale(h, fov) { this.flames.setScale(h, fov); }
  clear() { this.emitters.length = 0; this.flames.clear(); }
}
