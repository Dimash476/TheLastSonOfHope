import * as THREE from 'three';
import { XARG_HP } from './xarg.js';
import { blowQuat, reelHit } from '../player/model.js';
import { groundHeight, inRiver } from '../world/layout.js';
import { SPACE } from '../config.js';
import { clamp, lerp, smoothstep } from '../utils.js';

// Что происходит в бою помимо ударов. Всё это его часть, а не задания: никаких шкал и кнопок на экране,
// герой делает то же, что и всегда (бьёт, уворачивается, стреляет), а итог виден в кадре.
//  · корабль начинает бить по городу — пока он цел, это не прекратится;
//  · генерал срезает лучом небоскрёб и роняет его на героя;
//  · сходятся два луча: кто кого передавит;
//  · падение с орбиты вдвоём, сквозь огонь, в центр города;
//  · последний размен: он идёт сквозь удары;
//  · конец: тишина, пепел, радио.

const UP = new THREE.Vector3(0, 1, 0);
const AXIS = new THREE.Vector3(1, 0, 0);
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3(), _s = new THREE.Vector3();
const _q = new THREE.Quaternion();

// Огонь вокруг падающих тел: конус с вершиной у того, кто летит ниже
class Plasma {
  constructor(scene) {
    this.u = { uHot: { value: 0 }, uTime: { value: 0 } };
    const geo = new THREE.CylinderGeometry(0.15, 1, 1, 28, 12, true).translate(0, -0.5, 0);
    const m = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false, uniforms: this.u,
      vertexShader: `
        varying vec2 vUv; varying vec3 vN; varying vec3 vV;
        void main() {
          vUv = uv;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal);
          vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform float uHot; uniform float uTime; varying vec2 vUv; varying vec3 vN; varying vec3 vV;
        float n(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        float fbm(vec2 p) {
          vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          float a = mix(mix(n(i), n(i + vec2(1, 0)), f.x), mix(n(i + vec2(0, 1)), n(i + vec2(1, 1)), f.x), f.y);
          return a;
        }
        void main() {
          float along = 1.0 - vUv.y;
          float tear = fbm(vec2(vUv.x * 18.0, along * 5.0 - uTime * 7.0)) * 0.6 + fbm(vec2(vUv.x * 42.0, along * 12.0 - uTime * 13.0)) * 0.4;
          float rim = pow(1.0 - abs(dot(vN, vV)), 1.4);
          float body = (1.0 - smoothstep(0.1, 1.0, along)) * smoothstep(0.32 * along, 0.95, tear + rim * 0.55);
          vec3 hot = mix(vec3(6.0, 4.6, 3.2), vec3(5.0, 1.5, 0.3), smoothstep(0.0, 0.35, along));
          hot = mix(hot, vec3(1.4, 0.16, 0.04), smoothstep(0.35, 0.85, along));
          gl_FragColor = vec4(hot * body * uHot, body * uHot);
        }`,
    });
    this.mesh = new THREE.Mesh(geo, m);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  // tip — вершина, dir — куда летят, hot 0..1
  update(tip, dir, hot, dt) {
    this.mesh.visible = hot > 0.01;
    if (!this.mesh.visible) return;
    this.u.uHot.value = hot;
    this.u.uTime.value += dt;
    this.mesh.position.copy(tip);
    this.mesh.quaternion.setFromUnitVectors(UP, dir);
    const r = 3.4 + 5 * hot, l = 24 + 46 * hot;
    this.mesh.scale.set(r, l, r);
  }
}

export class Story {
  constructor(inv) {
    this.inv = inv;
    this.plasma = new Plasma(inv.scene);
    this.shot = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 55 };
    this.mid = new THREE.Vector3();
    this.prevMid = new THREE.Vector3();
    this.fallDir = new THREE.Vector3(0, -1, 0);
    this.camOff = new THREE.Vector3();
    this.list = [];
    this.fallDrive = (dt, input) => this.fallStep(dt, input);
    this.still = () => { const P = this.inv.player; P.vel.set(0, 0, 0); };
    this.$radio = document.getElementById('inv-radio');
    this.reset();
  }

  reset() {
    this.fall = null;
    this.aft = null;
    this.fallDone = false;
    this.lock = null;
    this.cut = null;
    this.brawlOn = false;
    this.brawlDone = false;
    this.spaceT = 0;
    this.bombOn = false;
    this.bombT = 3;
    this.cutCd = 8;
    this.lockCd = 0;
    this.cutLook = 0;
    this.cutHit = false;
    this.endT = 0;
    this.endCam = false;
    this.radioT = 0;
    this.radioQ = [];
    this.saidDuel = false;
    this.saidShip = false;
    this.duelTime = 0;
    this.endRadio = false;
    this.plasma.mesh.visible = false;
    this.$radio.classList.add('hidden');
  }

  stop() {
    const I = this.inv, P = I.player;
    if (P.driven === this.fallDrive || P.driven === this.still) P.driven = null;
    I.player.laserAim = null;
    this.reset();
  }

  get busy() { return !!(this.fall || this.aft || this.lock || this.cut); }

  // Перехват связи: маленькая строка сбоку, город живёт своей жизнью
  radio(text, t = 5.5) {
    if (this.radioT > 0) { this.radioQ.push([text, t]); return; }
    this.$radio.textContent = text;
    this.$radio.classList.remove('hidden');
    this.radioT = t;
  }

  // ---------------------------------------------------------------- кадр
  update(dt, realDt, input) {
    const I = this.inv, X = I.xarg, P = I.player;
    if (this.radioT > 0) {
      this.radioT -= realDt;
      if (this.radioT <= 0) {
        this.$radio.classList.add('hidden');
        const next = this.radioQ.shift();
        if (next) this.radio(next[0], next[1]);
      }
    }
    if (I.endT !== null && I.endWin) { this.ending(realDt); return; }
    if (!X || I.stage !== 'duel' || !X.alive) return;
    if (I.heroDown) {
      if (this.fall || this.aft || this.lock) this.cancel();
      return;
    }
    if (!this.saidDuel) {
      this.saidDuel = true;
      this.radio('ШТАБ: Цель вошла в центр. Всем подразделениям отойти.');
    }
    this.duelTime += realDt;
    this.lockCd -= realDt;
    this.cutCd -= realDt;
    if (this.aft) { this.aftermath(realDt); return; }
    if (this.fall) { this.fallFrame(realDt); return; }
    if (this.lock) { this.lockFrame(realDt, input); return; }
    this.tryBombard(realDt);
    if (this.cut) this.cutFrame(realDt);
    else this.tryCut();
    this.watchFalling();
    if (I.chain.kin) return;
    this.tryLock();
    this.tryFall(realDt);
    this.tryBrawl();
    if (this.brawlOn && I.slowT <= 0 && !I.chain.kin) I.timeScale = 0.75;
  }

  cancel() {
    const I = this.inv, P = I.player, X = I.xarg;
    if (P.driven === this.fallDrive || P.driven === this.still) P.driven = null;
    P.poseQ = null;
    X.poseQ = null;
    P.laserAim = null;
    this.fall = null;
    this.aft = null;
    this.lock = null;
    this.plasma.mesh.visible = false;
    I.fx.setLoop('entry', 0, 0.1);
    I.fx.setLoop('beamLock', 0, 0.1);
    if (I.camRig.shot === this.shot) I.camRig.shot = null;
    I.setCine(false);
  }

  // ---------------------------------------------------------------- корабль бьёт по городу
  tryBombard(realDt) {
    const I = this.inv, S = I.ship, X = I.xarg, P = I.player, W = I.world;
    if (!S.alive || S.state !== 'hover') {
      if (this.bombOn && !S.alive && !this.saidShip) {
        this.saidShip = true;
        this.radio('ШТАБ: Обстрел прекратился. Повторяю, обстрел прекратился.');
      }
      return;
    }
    if (!this.bombOn) {
      if (X.hp > XARG_HP * 0.9 && this.duelTime < 35) return;
      this.bombOn = true;
      this.bombT = 2.5;
      I.say('Ты бережёшь их? Корабль, огонь по городу.', 3.6);
      this.radio('ШТАБ: Корабль открыл огонь по жилым кварталам.');
    }
    if (P.pos.y > SPACE.atmosphere) return;
    this.bombT -= realDt;
    if (this.bombT > 0) return;
    this.bombT = 6 + Math.random() * 5;
    // Рядом с боем, но не по герою: высоко — бьёт по центру города
    const low = P.pos.y < 700;
    _c.set(low ? P.pos.x : 0, 60, low ? P.pos.z : 0);
    W.city.sphereQuery(_c, 700, this.list);
    let best = null;
    for (let i = 0; i < 24 && this.list.length; i++) {
      const s = this.list[Math.floor(Math.random() * this.list.length)];
      if (!s.alive || s.type === undefined) continue;
      const d = Math.hypot(s.x - _c.x, s.z - _c.z);
      if (d < 180) continue;
      best = s;
      break;
    }
    if (best) I.fx.bombard(new THREE.Vector3(best.x, best.y0 + best.h * Math.random(), best.z));
  }

  // ---------------------------------------------------------------- срез небоскрёба
  tryCut() {
    const I = this.inv, X = I.xarg, P = I.player, W = I.world;
    if (this.cutCd > 0 || X.state !== 'neutral' || X.hp > XARG_HP * 0.78 || X.pos.y > 500 || P.pos.y > 500 || I.chain.kin || this.brawlOn) return;
    W.city.sphereQuery(I.heroC, 170, this.list);
    let pick = null;
    for (const s of this.list) {
      if (!s.alive) continue;
      const b = W.city.buildings[s.b];
      if (b.kind !== 'building' || b.segs.length < 3) continue;
      const top = W.city.segs[b.segs[b.segs.length - 1]];
      if (!top.alive || top.y0 + top.h < 70) continue;
      if (Math.hypot(b.x - P.pos.x, b.z - P.pos.z) < 20) continue;
      const k = W.city.segs[b.segs[Math.round((b.segs.length - 1) * 0.45)]];
      if (!k.alive) continue;
      pick = k;
      break;
    }
    if (!pick) { this.cutCd = 4; return; }
    this.cutCd = 50;
    X.go('cut');
    X.lasering = true;
    X.vel.multiplyScalar(0.2);
    X.laserAim.subVectors(_a.set(pick.x, pick.y0 + pick.h * 0.5, pick.z), X.c).normalize();
    _s.crossVectors(X.laserAim, UP).normalize();
    this.cut = {
      seg: pick,
      center: new THREE.Vector3(pick.x, pick.y0 + pick.h * 0.5, pick.z),
      side: _s.clone(),
      w: Math.max(pick.w, pick.d) * 0.6,
      t: 0,
    };
    I.fx.cineFor(3);
  }

  cutFrame(realDt) {
    const I = this.inv, X = I.xarg, W = I.world, C = this.cut;
    if (X.state !== 'cut') { X.lasering = false; this.cut = null; return; }
    if (X.laser.lit) C.t += realDt;
    // Луч проходит здание поперёк
    const k = smoothstep(0, 1.1, C.t);
    _a.copy(C.center).addScaledVector(C.side, lerp(C.w, -C.w, k));
    X.laserAim.subVectors(_a, X.c).normalize();
    if (C.t < 1.1) return;
    X.lasering = false;
    X.go('recover');
    X.recoverT = 0.6;
    _d.subVectors(I.heroC, C.center).setY(0).normalize();
    const n = W.city.falling.length;
    W.city.destroySeg(C.seg, C.center.clone(), _d.clone(), 140);
    const f = W.city.falling[n];
    if (f) {
      this.falling = f;
      this.fallingT = 0;
      this.cutHit = false;
      this.cutLook = 2.6;
      const top = this.chunkTop(f, _b);
      I.fx.play('towerFall', { pos: top });
      I.slowFor(0.55, 1.6);
      I.fx.crashZoom(6, 0.6);
    }
    I.say('Вот что бывает с домами, за которыми ты прячешься.', 3.6);
    this.cut = null;
  }

  chunkTop(f, out) {
    return out.set(f.b.x, f.base.y0 + f.height, f.b.z).applyMatrix4(f.mesh.matrix);
  }

  // Падающая часть башни накрывает героя, если он остался под ней
  watchFalling() {
    const I = this.inv, f = this.falling;
    if (!f) return;
    this.fallingT += I.realDt;
    if (this.cutLook > 0) this.cutLook -= I.realDt;
    if (this.fallingT > 7 || !I.world.city.falling.includes(f)) { this.falling = null; return; }
    if (this.cutHit) return;
    const top = this.chunkTop(f, _a), base = _b.set(f.b.x, f.base.y0, f.b.z).applyMatrix4(f.mesh.matrix);
    _c.subVectors(top, base);
    const t = clamp(_d.subVectors(I.heroC, base).dot(_c) / _c.lengthSq(), 0, 1);
    _d.copy(base).addScaledVector(_c, t);
    if (_d.distanceTo(I.heroC) < 16 && I.player.dashT <= 0) {
      this.cutHit = true;
      const dir = _c.copy(I.heroC).sub(top).setY(-0.6).normalize().clone();
      I.hurtHero(24, dir.clone().multiplyScalar(240), false, 0);
      I.fx.crash(I.heroC.clone(), 0.9);
    }
  }

  // ---------------------------------------------------------------- скрещённые лучи
  tryLock() {
    const I = this.inv, X = I.xarg, P = I.player;
    if (this.lockCd > 0 || X.state !== 'laser' || !X.laser.lit || !P.lasering || !P.laser.lit) return;
    const d = X.c.distanceTo(I.heroC);
    if (d < 12 || d > 600) return;
    I.camera.getWorldDirection(_a);
    _b.subVectors(X.c, I.heroC).normalize();
    if (_a.dot(_b) < 0.93 || X.laserAim.dot(_c.copy(_b).negate()) < 0.9) return;
    this.lockCd = 25;
    X.go('beamlock');
    X.lasering = true;
    this.lock = { s: 0.5, t: 0, pos: new THREE.Vector3().lerpVectors(I.heroC, X.c, 0.5), off: 0, fx: 0, burn: 0 };
    I.timeScale = 0.6;
    I.slowT = 0;
    I.fx.cineFor(8);
    I.fx.setLoop('beamLock', 0.9, 0.08);
    I.sayOnce('Дави. Если сможешь.', 2.6);
  }

  lockFrame(realDt, input) {
    const I = this.inv, X = I.xarg, P = I.player, W = I.world, L = this.lock;
    L.t += realDt;
    const d = X.c.distanceTo(I.heroC);
    const firing = P.lasering && P.laser.lit;
    // Держишь луч — его сила понемногу берёт верх; давишь вперёд — точка идёт к нему; отпустил — его луч идёт на тебя
    if (firing) L.s += realDt * (0.17 * Math.max(0, input.moveZ) - 0.02 * X.phase);
    else L.s -= realDt * 1.6;
    L.s = clamp(L.s, 0, 1);
    L.pos.lerpVectors(I.heroC, X.c, L.s);
    L.pos.y += 0.6;
    P.laserAim = (P.laserAim || new THREE.Vector3()).subVectors(L.pos, _a.copy(I.heroC).addScaledVector(UP, 0.65)).normalize();
    X.laserAim.subVectors(L.pos, _a.copy(X.c).addScaledVector(UP, 0.65)).normalize();
    X.vel.multiplyScalar(Math.exp(-3 * realDt));
    // Там, где лучи встретились, рвётся всё
    L.fx -= realDt;
    if (L.fx <= 0) {
      L.fx = 0.16;
      W.effects.shockwave(L.pos.clone(), { type: 'disc', dir: _b.subVectors(X.c, I.heroC).normalize().clone(), radius: 11, life: 0.4, opacity: 0.28, color: 0xffb080 });
      W.effects.flash(L.pos, 24);
      W.sparks.burst(L.pos, 18, { size: [0.3, 1.1], speed: 38, life: [0.2, 0.7], color: 0xffc080 });
    }
    L.burn -= realDt;
    if (L.burn <= 0) {
      L.burn = 0.25;
      if (L.pos.y < 700) {
        W.city.damageRadius(L.pos.clone(), 8, 200, 12);
        const gy = W.city.groundHeightAt(L.pos.x, L.pos.z, L.pos.y + 0.5);
        if (L.pos.y - gy < 14) {
          W.effects.crater(_a.set(L.pos.x, gy, L.pos.z).clone(), 8);
          W.dust.burst(_a, 8, { size: [4, 12], speed: 24, life: [1, 2.6], flat: true });
        }
      }
    }
    const dead = !firing && L.s <= 0.05 && P.dashT > 0;
    if (L.s >= 0.97) { this.endLock(1); return; }
    if (L.s <= 0.03) { this.endLock(-1); return; }
    if (dead || L.t > 7 || d > 900 || d < 7 || X.state !== 'beamlock') this.endLock(0);
  }

  // who: 1 — его луч отброшен и взрыв у него, -1 — луч накрыл героя, 0 — оба отлетают
  endLock(who) {
    const I = this.inv, X = I.xarg, P = I.player, L = this.lock;
    this.lock = null;
    P.laserAim = null;
    I.fx.setLoop('beamLock', 0, 0.08);
    I.timeScale = 1;
    I.slowFor(0.3, 0.5);
    X.lasering = false;
    const dir = _a.subVectors(X.c, I.heroC).normalize().clone();
    if (who > 0) {
      X.damage(110, X.c.clone(), dir, 'laser');
      if (!X.alive) return;
      I.fx.clash(X.c.clone(), dir);
      X.go('knock');
      I.chain.open(X, dir, 'heavy', 1);
    } else if (who < 0) {
      I.fx.clash(I.heroC.clone(), dir);
      I.hurtHero(40, dir.clone().negate().multiplyScalar(300), false, 0);
      X.go('recover');
      X.recoverT = 0.6;
    } else {
      I.fx.clash(L.pos.clone(), dir);
      P.vel.copy(dir).multiplyScalar(-160);
      P.knockT = 0.3;
      X.launch(dir, 190, 0.5);
      X.go('knock');
    }
  }

  // ---------------------------------------------------------------- падение с орбиты
  tryFall(realDt) {
    const I = this.inv, X = I.xarg, P = I.player;
    if (this.fallDone || !X.climbed || this.brawlOn) return;
    const high = SPACE.atmosphere * 0.8;
    if (X.pos.y < high || P.pos.y < high || X.c.distanceTo(I.heroC) > 1500) return;
    if (!['neutral', 'combo', 'recover', 'stun'].includes(X.state)) return;
    this.spaceT += realDt;
    if (this.spaceT > 9 || X.hp < XARG_HP * 0.5) this.beginFall();
  }

  beginFall() {
    const I = this.inv, X = I.xarg, P = I.player;
    this.mid.lerpVectors(I.heroC, X.c, 0.5);
    // Падают на квартал, а не в реку: воронка и пыль должны быть видны
    const to = new THREE.Vector3();
    for (let i = 0; i < 12; i++) {
      to.set((Math.random() - 0.5) * 240, 0, (Math.random() - 0.5) * 240);
      if (!inRiver(to.x, to.z - 40) && !inRiver(to.x, to.z) && !inRiver(to.x, to.z + 40)) break;
    }
    to.y = Math.max(0, groundHeight(to.x, to.z));
    const y0 = this.mid.y, drop = y0 - to.y, T = clamp(y0 / 3600, 8, 12);
    this.fall = {
      t: 0, T, u: 0, to, from: this.mid.clone(), y0, top: 0, ang: Math.random() * 6,
      B: Math.min(700 * T, drop * 0.7), A: 0, hitT: -1, xT: 1, xHit: -1, hot: 0, cam: 0, cut: -1,
    };
    this.fall.A = drop - this.fall.B;
    this.prevMid.copy(this.mid);
    X.chainEnd();
    X.lasering = false;
    X.charge = 0;
    X.knock = 0;
    X.guardK = 0;
    X.boosting = false;
    X.go('scene');
    P.driven = this.fallDrive;
    P.charge = 0;
    P.lasering = false;
    P.dashT = 0;
    P.slamming = false;
    P.knockT = 0;
    P.grounded = false;
    P.falling = false;
    P.punchT = -1;
    P.lockDir = null;
    P.poseQ = P.quat.clone();
    X.poseQ = X.quat.clone();
    I.camRig.shot = this.shot;
    I.setCine(true);
    I.fx.hit(this.mid.clone(), _a.subVectors(I.heroC, X.c).normalize().clone(), 1);
    I.fx.setLoop('entry', 0);
    I.say('Ты хотел быть их щитом? Тогда падай.', 3.6, true);
    this.radio('ОРБИТАЛЬНЫЙ МОНИТОРИНГ: два объекта сошли с орбиты. Расчётная точка падения — центр города.', 6.5);
  }

  // Вызывается из player.driven: тела и камера двигаются в одном кадре
  fallStep(dt, input) {
    const I = this.inv, X = I.xarg, P = I.player, F = this.fall;
    if (!F) { P.driven = null; return; }
    const rdt = I.realDt, left = (1 - F.u) * F.T;
    // Последние полсекунды время вязнет: земля идёт на камеру
    F.t += rdt * (left < 0.55 ? 0.35 : 1);
    I.timeScale = left < 0.55 ? 0.3 : 1;
    F.u = clamp(F.t / F.T, 0, 1);
    const u = F.u, v = 1 - u;
    this.prevMid.copy(this.mid);
    const h = smoothstep(0, 1, u);
    this.mid.set(lerp(F.from.x, F.to.x, h), F.to.y + 4 + F.A * Math.pow(v, 2.3) + F.B * v, lerp(F.from.z, F.to.z, h));
    _a.subVectors(this.mid, this.prevMid);
    const speed = _a.length() / Math.max(rdt, 1e-3);
    if (speed > 1) this.fallDir.lerp(_a.normalize(), 1 - Math.exp(-5 * rdt)).normalize();
    const D = this.fallDir;
    // Сцепились и кувыркаются. Кто выше, тот ближе к небу; кто ниже — того и бьёт о землю
    F.ang += rdt * 1.1;
    _s.crossVectors(D, AXIS);
    if (_s.lengthSq() < 0.02) _s.set(0, 0, 1);
    _s.normalize().applyAxisAngle(D, F.ang);
    const half = 0.74;
    _b.copy(this.mid).addScaledVector(_s, half).addScaledVector(D, -F.top * 0.9);
    _c.copy(this.mid).addScaledVector(_s, -half).addScaledVector(D, F.top * 0.9);
    P.pos.copy(_b).addScaledVector(UP, -1);
    X.pos.copy(_c).addScaledVector(UP, -1);
    _a.copy(D).multiplyScalar(speed);
    P.vel.copy(_a);
    X.vel.copy(_a);
    _d.subVectors(_c, _b).normalize();
    P.lockDir = (P.lockDir || new THREE.Vector3()).copy(_d);
    P.poseQ.copy(blowQuat(_q, _d, 0.1));
    X.poseQ.copy(blowQuat(_q, _d.negate(), 0.1));
    X.anim.lift = 0;

    // Те же удары, что и всегда: кто бьёт, тот и оказывается сверху
    if (input.punch && (P.punchT < 0 || P.punchT > 0.38)) {
      P.startPunch(0);
      P.punchHit = true;
      F.hitT = P.punchHitAt ?? 0.2;
    }
    if (F.hitT > 0) {
      F.hitT -= rdt;
      if (F.hitT <= 0) this.fallBlow(true);
    }
    F.xT -= rdt;
    if (F.xT <= 0) {
      F.xT = 0.8 + Math.random() * 0.5;
      X.startPunch(0);
      F.xHit = X.punchHitAt;
    }
    if (F.xHit > 0) {
      F.xHit -= rdt;
      if (F.xHit <= 0) this.fallBlow(false);
    }
    if (u >= 1) this.fallImpact();
  }

  fallBlow(hero) {
    const I = this.inv, X = I.xarg, P = I.player, F = this.fall;
    if (!F) return;
    const from = hero ? I.heroC : X.c, to = hero ? X.c : I.heroC;
    _a.subVectors(to, from).normalize();
    const dir = _a.clone(), at = _b.lerpVectors(from, to, 0.6).clone();
    if (hero) {
      F.top = clamp(F.top + 0.3, -1, 1);
      X.damage(14, at, dir, 'chain');
      reelHit(X.reel, 0.9);
    } else {
      F.top = clamp(F.top - 0.26, -1, 1);
      I.hurtHero(5, null, false, 0);
    }
    I.fx.brawlHit(at, dir, 0.8);
    P.hitstop = Math.min(P.hitstop, 0.08);
  }

  // То, что идёт с падением кадр за кадром: огонь, звук, камера
  fallFrame(realDt) {
    const I = this.inv, F = this.fall, D = this.fallDir, y = this.mid.y;
    const hot = smoothstep(52000, 30000, y) * smoothstep(1500, 6000, y);
    F.hot += (hot - F.hot) * (1 - Math.exp(-3 * realDt));
    _a.copy(this.mid).addScaledVector(D, Math.abs(F.top) * 0.9 + 1.5);
    this.plasma.update(_a, D, F.hot, realDt);
    I.fx.setLoop('entry', 0.3 + 0.7 * F.hot, 0.5);
    if (F.hot > 0.3 && Math.random() < realDt * 30) I.world.sparks.burst(_a, 3, { size: [0.3, 1], speed: 24, life: [0.2, 0.7], color: 0xffa050, dir: D.clone().multiplyScalar(-0.9) });
    // Камера: вплотную → снизу навстречу → сверху, город летит в кадр
    const u = F.u, st = u < 0.34 ? 0 : u < 0.68 ? 1 : 2;
    let fov = 50;
    _s.crossVectors(D, AXIS).normalize();
    if (st === 0) _b.copy(_s).multiplyScalar(5.6).addScaledVector(D, -1.4);
    else if (st === 1) { _b.copy(D).multiplyScalar(8.5).addScaledVector(_s, 3.2); fov = 58; }
    else { _b.copy(D).multiplyScalar(-6.4).addScaledVector(_s, 2.4); fov = 72; }
    if (F.cut !== st) { F.cut = st; this.camOff.copy(_b); }
    this.camOff.lerp(_b, 1 - Math.exp(-3 * realDt));
    this.shot.pos.copy(this.mid).add(this.camOff);
    if (st === 2) this.shot.look.copy(this.mid).addScaledVector(D, 14);
    else this.shot.look.copy(this.mid);
    this.shot.fov = fov - I.fx.zoom;
    const gy = Math.max(0, groundHeight(this.shot.pos.x, this.shot.pos.z)) + 2;
    if (this.shot.pos.y < gy) this.shot.pos.y = gy;
  }

  fallImpact() {
    const I = this.inv, X = I.xarg, P = I.player, F = this.fall, p = F.to.clone();
    this.fall = null;
    this.fallDone = true;
    this.plasma.mesh.visible = false;
    I.fx.setLoop('entry', 0, 0.05);
    I.fx.meteor(p, 1);
    I.slowFor(0.14, 1.5);
    const gx = F.to.x, gz = F.to.z;
    const onTop = F.top >= 0;
    P.vel.set(0, 0, 0);
    X.vel.set(0, 0, 0);
    P.poseQ = null;
    X.poseQ = null;
    P.lockDir = null;
    P.pos.set(gx + 3, Math.max(0, groundHeight(gx + 3, gz)), gz + 1);
    X.pos.set(gx - 2.5, Math.max(0, groundHeight(gx - 2.5, gz)), gz - 1);
    P.grounded = true;
    X.grounded = true;
    P.landT = 2.8;
    P.driven = this.still;
    this.aft = { t: 0, p, onTop, said: false };
    if (onTop) {
      X.damage(150, p.clone(), UP, 'chain');
      X.go('down');
      X.downT = 5.2;
      X.landT = 5.2;
      I.hurtHero(10, null, false, 0);
    } else {
      X.damage(50, p.clone(), UP, 'chain');
      X.landT = 1.6;
      X.go('recover');
      X.recoverT = 3;
      I.hurtHero(42, null, false, 0);
    }
    // С высоты: воронка, кольцо пыли и квартал, которого больше нет. Внизу камере мешают падающие дома
    const a0 = Math.random() * Math.PI * 2, city = I.world.city;
    for (let i = 0; i < 8; i++) {
      const a = a0 + i * 0.785;
      this.shot.pos.set(p.x + Math.cos(a) * 110, p.y + 400, p.z + Math.sin(a) * 110);
      let clear = true;
      for (let u = 0; clear && u < 0.95; u += 0.08) clear = !city.isInside(_a.lerpVectors(this.shot.pos, p, u));
      if (clear) break;
    }
    this.shot.look.copy(p).setY(p.y + 3);
    this.shot.fov = 62;
  }

  aftermath(realDt) {
    const I = this.inv, A = this.aft, P = I.player;
    A.t += realDt;
    this.shot.fov = Math.max(42, this.shot.fov - realDt * 6);
    if (!A.said && A.t > 1.4) {
      A.said = true;
      I.say(A.onTop ? 'Это… ничего… не меняет.' : 'Вставай. Я ещё не закончил с тобой.', 3.2, true);
      this.radio('ШТАБ: …Центра больше нет. Кто-нибудь, ответьте.', 6);
    }
    if (A.t < 2.8) return;
    this.aft = null;
    if (P.driven === this.still) P.driven = null;
    if (I.camRig.shot === this.shot) I.camRig.shot = null;
    I.setCine(false);
  }

  // ---------------------------------------------------------------- он не пошёл наверх: падает сам
  startMeteor() {
    const I = this.inv, X = I.xarg;
    X.go('meteor');
    X.meteorT = 0;
    this.meteorFix = null;
    I.say('Не пошёл за мной? Тогда небо придёт к тебе.', 3.6, true);
    I.fx.setLoop('entry', 0.8, 0.5);
  }

  meteorTick(dt) {
    const I = this.inv, X = I.xarg, W = I.world;
    X.meteorT += dt;
    X.grounded = false;
    X.boosting = true;
    X.smashed = 0;
    const d = X.dist, speed = clamp(d / 1.5, 900, 6000);
    if (!this.meteorFix && d / speed < 0.3) this.meteorFix = _d.subVectors(I.heroC, X.c).normalize().clone();
    X.vel.copy(this.meteorFix || X.aim).multiplyScalar(speed);
    const y = X.pos.y, hot = smoothstep(1000, 5000, y) * 0.9;
    this.plasma.update(_a.copy(X.c).addScaledVector(_b.copy(X.vel).normalize(), 2), _b, hot, dt);
    const gy = W.city.groundHeightAt(X.pos.x, X.pos.z, X.pos.y + 3);
    if (X.pos.y - gy > Math.max(5, speed * dt * 1.5) && d > 7) return;
    // Удар
    const p = X.pos.clone();
    p.y = gy;
    X.vel.set(0, 0, 0);
    X.pos.y = gy;
    X.boosting = false;
    this.plasma.mesh.visible = false;
    I.fx.setLoop('entry', 0, 0.08);
    I.fx.meteor(p, 0.7);
    I.slowFor(0.2, 0.9);
    this.fallDone = true;
    X.grounded = true;
    X.landT = 1.2;
    X.go('recover');
    X.recoverT = 1.4;
    const hd = I.heroC.distanceTo(p);
    if (hd < 60 && I.player.dashT <= 0) {
      _c.subVectors(I.heroC, p).setY(5).normalize();
      I.hurtHero(30 * (1 - hd / 60) + 8, _c.clone().multiplyScalar(170), false, 0);
    }
    this.radio('ШТАБ: Удар по центру. Повторяю, удар по центру города.');
  }

  // ---------------------------------------------------------------- последний размен
  tryBrawl() {
    const I = this.inv, X = I.xarg;
    if (this.brawlOn || this.brawlDone || X.hp > XARG_HP * 0.16) return;
    if (X.c.distanceTo(I.heroC) > 300 || !['neutral', 'combo', 'recover', 'stun', 'down', 'guard'].includes(X.state)) return;
    this.brawlOn = true;
    X.startBrawl();
    I.say('Ты… думаешь… что это конец?', 3, true);
    I.fx.cineFor(4);
  }

  // ---------------------------------------------------------------- конец
  ending(realDt) {
    const I = this.inv, P = I.player, X = I.xarg;
    this.endT += realDt;
    this.brawlOn = false;
    this.brawlDone = true;
    if (!this.endRadio && this.endT > 5) {
      this.endRadio = true;
      this.radio(I.shipDown ? 'ШТАБ: Корабль лежит в парке. Он… он их остановил.' : 'ШТАБ: Корабль уходит. Он… он их остановил.', 5);
    }
    if (this.endT < 2.8) return;
    if (!this.endCam) {
      this.endCam = true;
      I.setCine(true);
      P.driven = I.holdHero;
      P.punchT = -1;
      P.charge = 0;
      P.lasering = false;
      I.camRig.shot = this.shot;
    }
    // Герой стоит посреди того, что осталось
    const a = (this.endT - 2.8) * 0.16 + 0.8, S = this.shot;
    S.pos.set(I.heroC.x + Math.cos(a) * 8.5, 0, I.heroC.z + Math.sin(a) * 8.5);
    // Снизу вверх: за спиной героя дымное небо, а не стена дома
    S.pos.y = Math.max(I.heroC.y - 3.6, I.world.city.groundHeightAt(S.pos.x, S.pos.z, I.heroC.y + 2) + 0.7);
    const far = X.c.distanceTo(I.heroC);
    S.look.copy(I.heroC);
    if (far < 200) S.look.lerp(X.c, 0.25);
    S.fov = 38;
  }
}
