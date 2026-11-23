import * as THREE from 'three';
import { PLAYER } from '../config.js';
import { smoothstep } from '../utils.js';
import { Tarven, cityMask, wrapD, CX, CZ, R_CITY, R_EDGE, GROUND_GLSL, SITES, AVENUES } from './tarven.js';
import { MAP_TILE } from '../world/planetmap.js';
import { Folk } from './folk.js';
import { CAST, BARKS, WRECK } from './cast.js';
import { Talk } from './talk.js';
import { Personas } from './persona.js';
import { AirRescue } from './aircar.js';

// Жизнь на Ксарроне: столица Тарвэн на карте поверхности, её жители и именные персонажи.
// Для карты планеты (planetmap.js) это «то, что стоит на карте» (decor): выравнивает плато,
// рисует мостовую, даёт крыши под ноги и стены для столкновений, ставит героя на подлёт к городу.
// Город есть всегда, а узнаёт о нём игрок после победы над Ксаргом: перехват и мысль героя (rumor).
// Память (с кем говорил, что узнал, горит ли башня дома Вэйр) — в браузере, как путь к Ксаррону.

const KEY = 'tlsoh.tarven';
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _hh = new THREE.Vector3();
const _fr = new THREE.Frustum(), _pv = new THREE.Matrix4();

function load() {
  try { return { met: {}, facts: {}, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { met: {}, facts: {} }; }
}

export class XarronLife {
  constructor(scene, world, { player, camRig, wormhole }) {
    this.world = world;
    this.player = player;
    this.camRig = camRig;
    this.wormhole = wormhole;
    this.city = new Tarven(scene, world);
    this.folk = new Folk(this.city, world);
    this.personas = new Personas(this.city.root);
    this.rdt = 1 / 60;
    this.talk = new Talk(this);
    this.rescue = new AirRescue(this);   // сцена: падающий аэрокар
    this.state = load();
    this.active = false;
    this.ready = false;
    // Для карты планеты
    this.center = [CX, CZ];
    this.radii = [R_CITY, R_EDGE];
    this.groundGLSL = GROUND_GLSL;
    this.uCityH = this.city.U.uCityH;
    // Реплики и перехваты: очередь по времени
    this.queue = [];
    this.subT = 0; this.radioT = 0;
    this.el = { sub: document.getElementById('inv-sub'), radio: document.getElementById('inv-radio') };
    this.barkCd = 0;
    // Имена над персонажами
    const hud = document.getElementById('hud');
    for (const c of CAST) {
      const t = document.createElement('div');
      t.className = 'npc-tag';
      t.innerHTML = `<b>${c.name}</b><span class="t">${c.title}</span><span class="d"></span>`;
      t.style.setProperty('--c', c.color);
      hud.append(t);
      c.tag = t;
      c.tagD = t.querySelector('.d');
    }
  }

  get won() { return !!(this.state.won || this.wormhole?.known); }

  save() { try { localStorage.setItem(KEY, JSON.stringify(this.state)); } catch { /* приватное окно */ } }

  // ---------------------------------------------------------------- для карты планеты
  shape(T) { this.city.shape(T); }
  mask(x, z) { return cityMask(x, z); }

  roof(wx, wz, wy) {
    if (!this.active) return -Infinity;
    // Пике на скорости тарана: крыши обычных домов не держат — их продавливает столкновение
    const r = this.city.root.position, fast = -this.player.vel.y > PLAYER.ramSpeed;
    const t = this.city.roofAt(wx - r.x, wz - r.z, wy - r.y, fast);
    return t === -Infinity ? t : t + r.y;
  }

  collide(hero, p0) { return this.active && this.city.collide(hero, p0, PLAYER.radius, PLAYER.ramSpeed); }

  // Удар героя по домам столицы (точка мира): задели ли что-то
  strike(p, r, dmg, dir) { return this.active && this.city.strike(p, r, dmg, dir); }

  // Касание Ксаррона: на край города, лицом к Цитадели, плавно вниз
  enter(map, x, z) {
    if (!this.ready) {
      this.ready = true;
      this.city.build();
      this.folk.build(CAST);
      this.city.setVeyr(!!this.state.veyr);
      this.personas.load(CAST);
      this.makeBeacons();
    }
    this.active = true;
    this.city.root.visible = true;
    this.city.shift.set(0, 0);
    this.city.repair();
    this.wreckI = 0;
    this.yardsSeen = false;
    // Подлёт — над ближайшим к стороне касания проспектом: внизу идут люди, впереди Цитадель
    const dx0 = wrapD(x - CX), dz0 = wrapD(z - CZ), a0 = Math.atan2(dz0, dx0);
    let av = AVENUES[0];
    for (const a of AVENUES) if (Math.abs(Math.atan2(Math.sin(a - a0), Math.cos(a - a0))) < Math.abs(Math.atan2(Math.sin(av - a0), Math.cos(av - a0)))) av = a;
    const dx = Math.cos(av), dz = Math.sin(av), l = 1;
    const R = R_CITY - 1400, dir = new THREE.Vector3(-dx, -0.05, -dz).normalize();
    this.camRig.yaw = Math.atan2(-dir.x, -dir.z);
    this.camRig.pitch = -0.12;
    if (!this.state.arrived) {
      this.state.arrived = true;
      this.save();
      this.later(2.5, () => this.say(this.won ? 'Тарвэн. Отсюда она меня увезла.' : 'Тарвэн… Столица Ксаррона.', 4));
    }
    return { x: CX + dx / l * R, z: CZ + dz / l * R, alt: 140, fall: 3, dir, speed: 40, title: 'ТАРВЭН · СТОЛИЦА КСАРРОНА' };
  }

  leave() {
    this.active = false;
    this.city.root.visible = false;
    this.talk.finish();
    this.rescue.reset();
    for (const c of CAST) c.tag.classList.remove('show');
  }

  // После света и камеры: какая копия города в кадре, жители, имена
  view(camera, O) {
    if (!this.active) return;
    this.city.place(O, camera.position);
    this.folk.draw(camera);
    _pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _fr.setFromProjectionMatrix(_pv);
    const cam = this.city.toCity(camera.position, _v), hh = this.city.toCity(this.player.pos, _hh);
    hh.y += 0.6;
    this.personas.update(this.rdt, cam, hh, this.talk.active ? this.talk : null, _fr);
    for (const c of CAST) if (c.persona) c.person.vis = c.persona.group.visible;
    this.beacons(cam);
    this.tags(camera);
  }

  // ---------------------------------------------------------------- шаг
  update(dt, realDt, input) {
    this.rdt = realDt;
    this.timers(realDt);
    this.ambience();
    if (!this.active) return;
    const P = this.player, h = this.city.toCity(P.pos, _v);
    this.city.update(dt, P);
    // Над верфями — впервые за прилёт: перехват и мысль героя
    if (!this.yardsSeen && Math.hypot(h.x - SITES.yards[0], h.z - SITES.yards[1]) < 1100) {
      this.yardsSeen = true;
      this.radioSay('КАНАЛ ВЕРФЕЙ: Корпус тридцать восемь — на стапель. Сварка по третьему доку, без остановки.', 5.5);
      this.later(6.5, () => this.say('Целый флот… Тридцать, сорок кораблей. И строят дальше.', 4));
    }
    // Город отвечает на разрушения: гвардия, Сайрен, регент
    const w = WRECK[this.wreckI];
    if (w && this.city.wrecked >= w.n) {
      this.wreckI++;
      this.later(1.2, () => (w.radio ? this.radioSay(w.radio, 6) : this.say(w.say, 4.5)));
    }
    this.folk.update(dt, h, P.vel, P.grounded, this.won, this.talk.active ? this.talk.c : null);
    if (this.talk.active) { this.talk.update(realDt, input); return; }
    if (this.rescue.update(dt, input)) return;
    this.barkCd -= realDt;
    // Рядом с кем-то и стоим (или почти): E — поговорить или поздороваться
    if (P.driven || P.vel.length() > 9 || !(P.grounded || P.bodyAlt < 3)) return;
    let best = null, bd = 6.5;
    for (const c of CAST) {
      const p = c.person, d = Math.hypot(p.x - h.x, p.z - h.z);
      if (d < bd && Math.abs(p.y - h.y) < 3) { bd = d; best = c; }
    }
    if (best) {
      P.interactTarget = { type: 'talk', label: `поговорить · ${best.name}` };
      if (input.interact) { input.interact = false; this.talk.start(best, P, this.camRig); }
      return;
    }
    const f = this.folk.nearest(h.x, h.z, 9, h.y);
    if (!f) return;
    P.interactTarget = { type: 'xgreet', label: 'поприветствовать' };
    if (input.interact && this.barkCd <= 0) {
      input.interact = false;
      this.barkCd = 1.5;
      P.waveT = 1.8;
      f.noticed = true;
      f.react = this.folk.choose(f, this.won, Math.random());
      f.reactT = 0;
      const pool = BARKS[f.type] || BARKS.citizen, lines = this.won ? pool.won : pool.not;
      this.say(`— ${lines[Math.floor(Math.random() * lines.length)]}`, 3.2);
    }
  }

  // Ударная волна в городе: жителей отбрасывает на шаг
  impulse(point, r, force) {
    if (!this.active) return;
    this.folk.impulse(this.city.toCity(point, _w), r, force);
  }

  // Сцены и вещи из разговоров
  act(name) {
    if (name !== 'lightVeyr') return;
    this.state.veyr = true;
    this.save();
    this.city.setVeyr(true);
    const W = this.world, [x, z] = SITES.house;
    const p = this.city.toWorld(_w.set(x, this.city.hC + 40, z), new THREE.Vector3());
    W.effects?.shockwave(p, { type: 'ring', radius: 260, life: 2.2, opacity: 0.5, color: 0xffd8a0 });
    W.audio?.boom(0.35, p.clone());
    this.later(1.2, () => W.toast?.('ДОМ ВЭЙР', 3));
  }

  // Победа над Ксаргом: о Тарвэне герой узнаёт из перехвата
  rumor() {
    this.state.won = true;
    this.save();
    this.later(7, () => this.radioSay('ПЕРЕХВАТ · КАНАЛ КСАРРОНА: …генерал Ксарг не выходит на связь. Корабль потерян. Повторяю, корабль потерян.', 6.5));
    this.later(14.5, () => this.radioSay('ПЕРЕХВАТ: Совет созывает все дома в Тарвэн. Всем домам — в Тарвэн.', 6));
    this.later(21.5, () => this.say('Тарвэн… Столица Ксаррона. Значит, дорога туда — через чёрную дыру.', 5));
  }

  reset() {
    this.talk.finish();
    this.rescue.reset();
    this.folk.clear?.();
    this.city.repair();
  }

  // ---------------------------------------------------------------- мелочи
  later(t, fn) { this.queue.push({ t, fn }); }

  timers(dt) {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const q = this.queue[i];
      if ((q.t -= dt) <= 0) { this.queue.splice(i, 1); q.fn(); }
    }
    if (this.subT > 0 && (this.subT -= dt) <= 0) this.el.sub.classList.add('hidden');
    if (this.radioT > 0 && (this.radioT -= dt) <= 0) this.el.radio.classList.add('hidden');
  }

  say(text, t) {
    this.el.sub.textContent = text;
    this.el.sub.classList.remove('hidden');
    this.subT = t;
  }

  radioSay(text, t) {
    this.el.radio.textContent = text;
    this.el.radio.classList.remove('hidden');
    this.radioT = t;
  }

  // Имя над персонажем: вблизи — имя и звание, издалека (до 6 км) — имя и расстояние над его столбом света
  tags(camera) {
    const hide = this.talk.active || !this.active;
    const cam = this.city.toCity(camera.position, _hh);
    for (const c of CAST) {
      const p = c.person;
      let on = false;
      if (!hide) {
        this.headOf(c, _w);
        const d = _w.distanceTo(camera.position), far = d >= 90;
        if (d < 6000 && (far || p.vis)) {
          const dh = Math.hypot(p.x - cam.x, p.z - cam.z);
          _w.y += far ? 4 - dh * dh / (2 * MAP_TILE.RV) : 0.45;
          _w.project(camera);
          if (_w.z < 1 && Math.abs(_w.x) < 1.05 && Math.abs(_w.y) < 1.05) {
            on = true;
            const x = (_w.x + 1) / 2 * window.innerWidth, y = (1 - _w.y) / 2 * window.innerHeight;
            c.tag.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px) translate(-50%, -100%)`;
            c.tag.classList.toggle('far', far);
            if (far) {
              const t = d < 1000 ? `${Math.round(d / 10) * 10} м` : `${(d / 1000).toFixed(1).replace('.', ',')} км`;
              if (c.tagT !== t) { c.tagT = t; c.tagD.textContent = t; }
              c.tag.style.opacity = '0.9';
            } else c.tag.style.opacity = '1';
          }
        }
      }
      c.tag.classList.toggle('show', on);
    }
  }

  // Столб света над каждым из шести: видно с воздуха через весь город. Вблизи (и в разговоре) гаснет
  makeBeacons() {
    const geo = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true).translate(0, 0.5, 0);
    for (const c of CAST) {
      const mat = new THREE.ShaderMaterial({
        uniforms: { uC: { value: new THREE.Color(c.color) }, uK: { value: 0 } },
        vertexShader: `varying float vY; varying vec3 vN, vV;
          void main() {
            vY = position.y;
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: `uniform vec3 uC; uniform float uK; varying float vY; varying vec3 vN, vV;
          void main() {
            float f = abs(dot(normalize(vN), normalize(vV)));
            float a = uK * (0.25 + 0.75 * f * f) * pow(1.0 - vY, 1.3) * smoothstep(0.0, 0.01, vY);
            gl_FragColor = vec4(uC * 2.2 + 0.25 * f * f * f, a);
          }`,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
      });
      const m = new THREE.Mesh(geo, mat);
      m.frustumCulled = false;
      m.visible = false;
      m.renderOrder = 5;
      this.city.root.add(m);
      c.beacon = m;
    }
  }

  // cam — камера в кадре города. Шире вдали (иначе тоньше пикселя), ниже — по кривизне карты
  beacons(cam) {
    for (const c of CAST) {
      const b = c.beacon, p = c.person;
      if (!b) continue;
      const dh = Math.hypot(p.x - cam.x, p.z - cam.z);
      const k = this.talk.active ? 0 : smoothstep(30, 160, dh) * 0.9;
      b.visible = k > 0.01;
      if (!b.visible) continue;
      const w = Math.max(1.2, dh / 110);
      b.position.set(p.x, p.y + 2.4 - dh * dh / (2 * MAP_TILE.RV), p.z);
      b.scale.set(w, 900, w);
      b.material.uniforms.uK.value = k;
    }
  }

  // Голова персонажа в мире: у модели во плоти — по кости, иначе — по фигуре толпы
  headOf(c, out) { return this.personas.head(c, out) || this.folk.headOf(c.person, out); }

  // Гул столицы: далёкий шум коридоров и мягкий низкий тон, тише с высотой и за городом
  ambience() {
    const A = this.world.audio;
    if (!A?.ctx) return;
    let k = 0;
    if (this.active) {
      const h = this.city.toCity(this.player.pos, _w);
      const r = Math.hypot(h.x - CX, h.z - CZ), alt = h.y - this.city.hC;
      k = (1 - smoothstep(R_CITY, R_CITY + 1500, r)) * (1 - smoothstep(600, 2600, alt)) * (this.talk.active ? 0.5 : 1);
    }
    if (!this.hum) {
      if (k <= 0) return;
      const ctx = A.ctx, out = ctx.createGain();
      out.gain.value = 0;
      const n = ctx.createBufferSource(); n.buffer = A.noise; n.loop = true;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 340; bp.Q.value = 0.5;
      const ng = ctx.createGain(); ng.gain.value = 0.5;
      n.connect(bp).connect(ng).connect(out);
      for (const [f, v] of [[55, 0.35], [82.4, 0.22], [110.3, 0.12]]) {
        const o = ctx.createOscillator(); o.frequency.value = f;
        const g = ctx.createGain(); g.gain.value = v;
        o.connect(g).connect(out); o.start();
      }
      n.start();
      out.connect(A.master);
      this.hum = out;
    }
    this.hum.gain.setTargetAtTime(k * 0.09, A.ctx.currentTime, 0.6);
  }
}
