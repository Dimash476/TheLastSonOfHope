import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CITY, TRAFFIC, DEBRIS } from '../config.js';
import { HALF, BLOCK, blockAt } from './layout.js';

const SHIRTS = [0x2f3e57, 0x7a2a2a, 0xd8d6d0, 0x2b2b2d, 0x4f6b4a, 0xb08a4a, 0x5b5f66, 0x8aa6c2, 0x6d4c6e, 0xc8b89a, 0x1f4a6e, 0xa8432f, 0xe8e4da];
const PANTS = [0x22304a, 0x2b2b2b, 0x4a3b2a, 0x5a5f66, 0x1e3b5a, 0x6b6457, 0xbab3a3, 0x3a3f46];
const SKIN = [0xf1c7a5, 0xe0ac85, 0xc68a62, 0x9a6640, 0x6b4429, 0xf5d5bd, 0xd29b74];
const HAIR = [0x1b1410, 0x3b2618, 0x6b4a2a, 0xa07a48, 0x2a2a2a, 0x8a8a88, 0x5a2a18];
const SKIRTS = [0x2b2b2d, 0x7a2a3a, 0x3a4a6a, 0xc8b89a, 0x5a6b4a, 0xd8d0c8, 0x8a5a7a];
const BAGS = [0x2a2a2c, 0x3a4a5a, 0x6a3a2a, 0x8a7a5a, 0x2f4f3f, 0xa83a2a];
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const _frustum = new THREE.Frustum();
const _pv = new THREE.Matrix4();
const _sph = new THREE.Sphere(new THREE.Vector3(), 1.6);
const ALWAYS_NEAR = 60;   // ближе — рисуем всегда (их тени могут попасть в кадр)
const UP = new THREE.Vector3(0, 1, 0);
const RX = new THREE.Vector3(1, 0, 0);
const PERIM = 4 * (CITY.block - 20);
const HIP_Y = 0.92, SHOULDER_Y = 1.42, NECK_Y = 1.47;

// Люди: гуляют по тротуарам вокруг кварталов и реагируют на героя:
// задирают головы и показывают на него, когда он зависает над улицей,
// собираются вокруг, когда он приземлился (кто-то машет), разбегаются
// от опасности и отлетают от ударных волн (и поднимаются — без жестокости).
export class People {
  constructor(scene, world) {
    this.world = world;
    const N = this.N = TRAFFIC.people;
    const mat = createPeopleMaterial();
    const mk = (geo, count) => {
      const m = new THREE.InstancedMesh(geo, mat, count);
      m.castShadow = true;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3).fill(1), 3);
      m.frustumCulled = false;
      scene.add(m);
      return m;
    };
    const geo = makePersonGeometry();
    this.torso = mk(geo.torso, N);
    this.head = mk(geo.head, N);
    this.hairShort = mk(geo.hairShort, N);
    this.hairLong = mk(geo.hairLong, N);
    this.arms = mk(geo.arm, N * 2);
    this.legs = mk(geo.leg, N * 2);
    // Аксессуары: рюкзак, кепка, юбка, телефон в руке (снимают героя)
    this.bag = mk(geo.bag, N);
    this.cap = mk(geo.cap, N);
    this.skirt = mk(geo.skirt, N);
    this.phone = mk(geo.phone, N);
    this.bag.castShadow = this.cap.castShadow = this.phone.castShadow = false;
    this.meshes = [this.torso, this.head, this.hairShort, this.hairLong, this.arms, this.legs, this.bag, this.cap, this.skirt, this.phone];

    // Вспышки камер телефонов (селфи с героем)
    const fc = document.createElement('canvas');
    fc.width = fc.height = 64;
    const fg = fc.getContext('2d'), grd = fg.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.25, 'rgba(230,240,255,0.6)'); grd.addColorStop(1, 'rgba(200,220,255,0)');
    fg.fillStyle = grd; fg.fillRect(0, 0, 64, 64);
    const fm = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(fc), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
    this.flashes = [];
    for (let i = 0; i < 4; i++) {
      const s = new THREE.Sprite(fm);
      s.visible = false;
      scene.add(s);
      this.flashes.push({ s, t: 0 });
    }
    this.selfieDir = new THREE.Vector3(0, 0, 1);

    this.list = [];
    this.heroCalm = 0; // сколько секунд герой спокойно стоит на земле
    const pick = (a) => new THREE.Color(a[Math.floor(Math.random() * a.length)]);
    for (let i = 0; i < N; i++) {
      const r = Math.random();
      const p = {
        slot: i, state: 'none', pos: new THREE.Vector3(), vel: new THREE.Vector3(), quat: new THREE.Quaternion(),
        ang: new THREE.Vector3(), heading: 0, phase: Math.random() * 6, block: [0, 0], s: 0, dirSign: 1,
        speed: 1.4, timer: 0, from: new THREE.Vector3(), target: new THREE.Vector3(),
        h: 0.9 + Math.random() * 0.18,                   // рост
        hair: r < 0.35 ? 'long' : r < 0.92 ? 'short' : 'none',
        gesture: Math.random(),                           // кто показывает рукой, кто машет
        look: 0, armL: 0, armR: 0, wave: 0, phone: 0,
        w: 0.88 + Math.random() * 0.24,                  // телосложение
      };
      p.skirt = p.hair === 'long' && Math.random() < 0.5;
      p.bag = Math.random() < 0.22;
      p.cap = p.hair !== 'long' && Math.random() < 0.2;
      const skin = pick(SKIN);
      const shirt = pick(SHIRTS), pants = p.skirt ? (Math.random() < 0.5 ? skin : new THREE.Color(0x1c1a1c)) : pick(PANTS);
      // Цвета храним у человека: в кадр он попадает под разными номерами экземпляров
      p.cols = { shirt, pants, skin, hair: pick(HAIR), skirt: pick(SKIRTS), bag: pick(BAGS), cap: pick(SHIRTS) };
      this.list.push(p);
    }
    this.drawN = 0;
    this.drawOwner = new Array(N).fill(null);
    for (const m of this.meshes) m.count = 0;
  }

  // Номер экземпляра для человека в этом кадре; цвета переписываем, только если номер сменил владельца
  drawSlot(p) {
    const i = this.drawN++;
    if (this.drawOwner[i] !== p) {
      this.drawOwner[i] = p;
      const c = p.cols;
      this.torso.setColorAt(i, c.shirt);
      this.arms.setColorAt(i * 2, c.shirt); this.arms.setColorAt(i * 2 + 1, c.shirt);
      this.legs.setColorAt(i * 2, c.pants); this.legs.setColorAt(i * 2 + 1, c.pants);
      this.head.setColorAt(i, c.skin);
      this.hairShort.setColorAt(i, c.hair); this.hairLong.setColorAt(i, c.hair);
      this.skirt.setColorAt(i, c.skirt);
      this.bag.setColorAt(i, c.bag);
      this.cap.setColorAt(i, c.cap);
      this.colorsDirty = true;
    }
    return i;
  }

  // Точка на тротуаре вокруг квартала по параметру s
  pathPoint(p, s, out) {
    const bx = -HALF + p.block[0] * CITY.block + 10, bz = -HALF + p.block[1] * CITY.block + 10;
    const L = CITY.block - 20;
    s = ((s % PERIM) + PERIM) % PERIM;
    const side = Math.floor(s / L), t = s - side * L;
    if (side === 0) out.set(bx + t, 0, bz);
    else if (side === 1) out.set(bx + L, 0, bz + t);
    else if (side === 2) out.set(bx + L - t, 0, bz + L);
    else out.set(bx, 0, bz + L - t);
    return out;
  }

  spawn(p, focus) {
    for (let tries = 0; tries < 15; tries++) {
      const a = Math.random() * Math.PI * 2, r = 25 + Math.random() * Math.random() * (TRAFFIC.radius * 0.5);
      const x = focus.x + Math.cos(a) * r, z = focus.z + Math.sin(a) * r;
      const t = blockAt(x, z);
      if (t === BLOCK.EMPTY || t === BLOCK.RIVER) continue;
      p.block = [Math.floor((x + HALF) / CITY.block), Math.floor((z + HALF) / CITY.block)];
      p.s = Math.random() * PERIM;
      p.dirSign = Math.random() < 0.5 ? 1 : -1;
      p.speed = 1.1 + Math.random() * 0.7;
      p.state = 'walk';
      this.pathPoint(p, p.s, p.pos);
      p.pos.y = this.world.city.groundHeightAt(p.pos.x, p.pos.z, 1);
      // Иногда — парочка: второй идёт рядом, держась за руку
      if (Math.random() < 0.16) {
        const q = this.list.find((o) => o.state === 'none' && o !== p);
        if (q) {
          q.state = 'walk'; q.lead = p; p.mate = q;
          q.block = p.block.slice(); q.s = p.s; q.dirSign = p.dirSign; q.speed = p.speed = 1.0 + Math.random() * 0.3;
          q.pos.copy(p.pos);
        }
      }
      return;
    }
  }

  scare(p, from, time = 6) {
    if (p.state === 'walk' || p.state === 'flee' || p.state === 'watch' || p.state === 'gather') {
      p.state = 'flee';
      p.from.copy(from);
      p.timer = time + Math.random() * 3;
      p.speed = 5.5 + Math.random() * 2.5;
    }
  }

  knock(p, vel) {
    if (p.state === 'held') return;
    p.state = 'fly';
    p.vel.copy(vel);
    p.ang.set((Math.random() - 0.5) * 10, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 10);
    if (!(p.quat.lengthSq() > 0)) p.quat.identity();
    p.quat.setFromAxisAngle(UP, p.heading);
  }

  impulse(center, radius, force) {
    for (const p of this.list) {
      if (p.state === 'none' || p.state === 'held') continue;
      const d = p.pos.distanceTo(center);
      if (d < radius) {
        const k = 1 - d / radius;
        const dir = _v.subVectors(p.pos, center).setY(0);
        if (dir.lengthSq() < 0.01) dir.set(Math.random() - 0.5, 0, Math.random() - 0.5);
        dir.normalize();
        const f = Math.min(40, force * k);
        if (f > 3) this.knock(p, new THREE.Vector3(dir.x * f, f * 0.5 + 3, dir.z * f));
        else if (force > 8) this.scare(p, center);
      } else if (force > 25 && d < radius * 3 + 40) this.scare(p, center);
    }
    // Слабые толчки (мягкая посадка, шаги) не мешают людям подойти к герою
    if (force > 25) this.heroCalm = 0;
  }

  hit(center, radius, vel) {
    let any = false;
    for (const p of this.list) {
      if (p.state === 'none' || p.state === 'held') continue;
      if (_v.copy(p.pos).setY(p.pos.y + 1).distanceTo(center) > radius + 0.6) continue;
      // Аккуратно: герой сдерживает силу против людей
      this.knock(p, vel.clone().clampLength(0, 25).add(new THREE.Vector3(0, 6, 0)));
      any = true;
    }
    return any;
  }

  findGrabbable(pos, range) {
    let best = null, bestD = range;
    for (const p of this.list) {
      if (p.state === 'none' || p.state === 'held') continue;
      const d = p.pos.distanceTo(pos);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best ? { ref: best, dist: bestD } : null;
  }

  // Испугать всех в радиусе (без толчков) — например, от лазера
  scareAround(center, r) {
    for (const p of this.list) if (p.state !== 'none' && p.pos.distanceTo(center) < r) this.scare(p, center, 4);
    this.heroCalm = 0;
  }

  // Появиться в точке и сразу убегать (например, загорающий вскочил от взрыва)
  spawnAt(pos, from) {
    const p = this.list.find((q) => q.state === 'none');
    if (!p) return;
    p.pos.copy(pos);
    p.block = [Math.floor((pos.x + HALF) / CITY.block), Math.floor((pos.z + HALF) / CITY.block)];
    p.state = 'walk';
    this.scare(p, from, 6);
  }

  // Герой идёт сквозь толпу — люди мягко расступаются (без падений)
  nudge(center, r) {
    for (const p of this.list) {
      if (p.state === 'none' || p.state === 'held' || p.state === 'fly' || p.state === 'down') continue;
      const dx = p.pos.x - center.x, dz = p.pos.z - center.z, d = Math.hypot(dx, dz);
      if (d >= r || Math.abs(p.pos.y - center.y) > 2.5) continue;
      const k = (r - d) / Math.max(d, 0.05);
      p.pos.x += dx * k; p.pos.z += dz * k;
    }
  }

  // ---------------------------------------------------------------- общение с героем
  findDown(pos, r) {
    let best = null, bd = r;
    for (const p of this.list) {
      if (p.state !== 'down') continue;
      const d = Math.hypot(p.pos.x - pos.x, p.pos.z - pos.z);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  countNear(pos, r) {
    let n = 0;
    for (const p of this.list) {
      if ((p.state === 'walk' || p.state === 'watch' || p.state === 'gather') && Math.hypot(p.pos.x - pos.x, p.pos.z - pos.z) < r) n++;
    }
    return n;
  }

  // Герой подаёт руку: человек встаёт, благодарит и машет
  helpUp(p, hero) {
    p.pos.y = this.world.city.groundHeightAt(p.pos.x, p.pos.z, p.pos.y + 1);
    p.heading = Math.atan2(hero.x - p.pos.x, hero.z - p.pos.z);
    this.backToWalk(p);
    p.thankT = 3;
    this.world.soundscape?.thanks?.(p.pos.clone().setY(p.pos.y + 1.6));
    this.world.animals?.spawnHeart(p.pos.x, p.pos.y + 2.0 * p.h, p.pos.z);
  }

  // Герой здоровается: люди машут в ответ, радуются, снимают; двое подходят сделать селфи
  greet(center, camPos) {
    this.selfieDir.set(camPos.x - center.x, 0, camPos.z - center.z);
    if (this.selfieDir.lengthSq() < 1e-4) this.selfieDir.set(0, 0, 1);
    this.selfieDir.normalize();
    const near = [];
    for (const p of this.list) {
      if (p.state !== 'walk' && p.state !== 'watch' && p.state !== 'gather') continue;
      const d = Math.hypot(p.pos.x - center.x, p.pos.z - center.z);
      if (d > 16) continue;
      p.greetT = 2.2 + Math.random() * 1.5;
      near.push([d, p]);
    }
    near.sort((a, b) => a[0] - b[0]);
    let side = Math.random() < 0.5 ? 1 : -1;
    for (const [d, p] of near.slice(0, 2)) {
      if (d > 10 || p.lead || p.mate || p.dog) continue;
      p.state = 'selfie'; p.timer = 4.2; p.flashed = false; p.selfieSide = side; side = -side;
    }
    if (near.length) this.world.soundscape?.cheer(Math.min(1, near.length / 12) * 0.6, center.clone().setY(center.y + 1.5));
  }

  flash(pos) {
    const f = this.flashes.find((q) => q.t <= 0) || this.flashes[0];
    f.t = 0.22;
    f.s.position.copy(pos);
    f.s.visible = true;
    this.world.soundscape?.shutter?.(pos);
  }

  hold(p) { p.state = 'held'; p.vel.set(0, 0, 0); }
  setHeld(p, pos, facingQuat) {
    p.pos.copy(pos).add(new THREE.Vector3(0, -0.6, 0));
    p.quat.copy(facingQuat).multiply(_q.setFromAxisAngle(RX, Math.PI / 2));
  }
  throwObj(p, vel) { this.knock(p, vel.clone().clampLength(0, 45)); }

  // Повернуться лицом к точке (плавно)
  face(p, x, z, dt, k = 4) {
    const want = Math.atan2(x - p.pos.x, z - p.pos.z);
    const dh = Math.atan2(Math.sin(want - p.heading), Math.cos(want - p.heading));
    p.heading += dh * Math.min(1, dt * k);
  }

  backToWalk(p) {
    p.state = 'walk';
    p.speed = 1.1 + Math.random() * 0.7;
    p.block = [Math.floor((p.pos.x + HALF) / CITY.block), Math.floor((p.pos.z + HALF) / CITY.block)];
    p.s = this.nearestS(p);
  }

  update(dt, player) {
    const city = this.world.city, focus = player.pos;
    // Рисуем только тех, кто в кадре (и всех рядом); остальные не тратят видеокарту
    this.drawN = 0;
    const cam = this.world.camera;
    if (cam) {
      _pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      _frustum.setFromProjectionMatrix(_pv);
      this.camPos = cam.position;
    }
    const inGrid = Math.abs(focus.x) < HALF + 300 && Math.abs(focus.z) < HALF + 300 && focus.y < 2000;
    const pSpeed = player.vel.length();
    // Герой стоит на земле спокойно — люди подходят посмотреть
    this.heroCalm = player.grounded && pSpeed < 4 && !player.held ? this.heroCalm + dt : 0;
    const gatherOn = this.heroCalm > 1.0;
    // Толпа держится, пока герой рядом на земле (ходит, бьёт воздух — неважно) или висит низко;
    // расходится только когда он улетел или умчался
    const heroLow = player.grounded || player.pos.y - (player.groundY || 0) < 8;
    const crowdKeep = heroLow && pSpeed < 30;
    const hoverOn = !player.grounded && pSpeed < 30;
    // Толпа вокруг героя — не больше ~28 человек (остальные смотрят издали или идут дальше)
    const room = (this.gatherCount || 0) < 28;
    let gathering = 0;

    for (const p of this.list) {
      if (p.state === 'none') {
        if (inGrid && Math.random() < 0.08) this.spawn(p, focus);
        if (p.state === 'none') { this.hide(p); continue; }
      }
      const dist = p.pos.distanceTo(focus);
      if ((dist > TRAFFIC.radius * 0.6 || !inGrid) && p.state !== 'held') { p.state = 'none'; this.hide(p); continue; }
      const dx = focus.x - p.pos.x, dz = focus.z - p.pos.z, flat = Math.hypot(dx, dz), above = focus.y - p.pos.y;

      // Испугались пролетающего рядом героя
      if ((p.state === 'walk' || p.state === 'watch' || p.state === 'gather') && dist < 20 && pSpeed > 70) this.scare(p, focus);

      // Реакции на героя
      // Испуг проходит, если герой спокойно стоит рядом — люди возвращаются посмотреть
      if (p.state === 'flee' && this.heroCalm > 3 && flat < 70) p.state = 'walk';
      if (p.state === 'walk') {
        if (gatherOn && room && flat < 70 && Math.random() < dt * 1.2) {
          p.state = 'gather';
          this.gatherCount = (this.gatherCount || 0) + 1;
          // Место в толпе — угол и расстояние от героя (толпа следует за ним)
          p.ga = Math.atan2(-dx, -dz) + (Math.random() - 0.5) * 2.2;
          p.gr = 5 + Math.random() * 7;
          p.speed = 1.5 + Math.random() * 0.6;
        } else if (hoverOn && flat < 90 && above > 2.5 && above < 250 && Math.random() < dt * 2) {
          p.state = 'watch';
          p.timer = 3 + Math.random() * 4;
        }
      }

      let swing = 0, armSwing = 0;
      let lookT = 0, armLT = 0, armRT = 0, waveT = 0, phoneT = 0;
      // Пара: если ведущий ушёл с прогулки (толпа, испуг) — пара распадается
      if (p.lead && (p.lead.state !== 'walk' || p.state !== 'walk' || p.lead.mate !== p)) { if (p.lead.mate === p) p.lead.mate = null; p.lead = null; }
      if (p.mate && p.mate.lead !== p) p.mate = null;
      p.holdSide = p.lead ? 1 : p.mate ? -1 : 0;
      if (p.state === 'walk' && (p.waitT > 0 || p.thankT > 0 || p.greetT > 0)) {
        // Ждём, пока герой гладит нашу собаку; благодарим за помощь; отвечаем на приветствие
        p.waitT = (p.waitT || 0) - dt;
        p.thankT = (p.thankT || 0) - dt;
        p.greetT = (p.greetT || 0) - dt;
        this.face(p, focus.x, focus.z, dt, 3);
        lookT = 0.15;
        if (p.thankT > 0) { armRT = -2.9; waveT = 1; }
      } else if (p.state === 'walk' && p.lead) {
        // Идём справа от ведущего, шаг в шаг, держась за руки
        const L = p.lead, rx = -Math.cos(L.heading), rz = Math.sin(L.heading);
        p.pos.x += (L.pos.x + rx * 0.62 - p.pos.x) * Math.min(1, dt * 6);
        p.pos.z += (L.pos.z + rz * 0.62 - p.pos.z) * Math.min(1, dt * 6);
        p.pos.y = L.pos.y;
        p.heading = L.heading;
        p.phase = L.phase + 0.4;
        swing = Math.sin(p.phase) * 0.45;
        armSwing = -swing * 0.5;
        p.s = L.s;
      } else if (p.state === 'walk') {
        p.s += p.speed * p.dirSign * dt;
        const target = this.pathPoint(p, p.s, _v);
        const ahead = this.pathPoint(p, p.s + p.dirSign, _v2);
        // Если сошли с маршрута (после бегства/толпы) — возвращаемся обычным шагом, без рывка
        const ox = target.x - p.pos.x, oz = target.z - p.pos.z, od = Math.hypot(ox, oz);
        const back = Math.min(od, p.speed * 1.5 * dt);
        if (od > 1e-4) { p.pos.x += ox / od * back; p.pos.z += oz / od * back; }
        p.heading = od > 1.5 ? Math.atan2(ox, oz) : Math.atan2(ahead.x - target.x, ahead.z - target.z);
        if (od > 1.5) p.s -= p.speed * p.dirSign * dt * 0.7; // пока догоняем маршрут, точка на нём почти ждёт
        p.pos.y = city.groundHeightAt(p.pos.x, p.pos.z, p.pos.y + 1);
        p.phase += dt * p.speed * 4.5;
        swing = Math.sin(p.phase) * 0.5;
        armSwing = -swing * 0.7;
      } else if (p.state === 'watch') {
        // Остановились, смотрят вверх; кто-то показывает пальцем
        p.timer -= dt;
        this.face(p, focus.x, focus.z, dt, 3);
        lookT = Math.min(1.1, Math.atan2(Math.max(0, above - 1.5), Math.max(flat, 1)));
        if (p.gesture < 0.35) armRT = -2.4 - lookT * 0.4;
        else if (p.gesture < 0.6) { armRT = -1.45 - lookT * 0.75; phoneT = 1; } // снимают на телефон
        if (p.timer <= 0 || !hoverOn || flat > 100) this.backToWalk(p);
      } else if (p.state === 'gather') {
        gathering++;
        p.target.set(focus.x + Math.sin(p.ga) * p.gr, 0, focus.z + Math.cos(p.ga) * p.gr);
        const tx = p.target.x - p.pos.x, tz = p.target.z - p.pos.z, td = Math.hypot(tx, tz);
        if (td > 0.4) {
          // Догоняют героя: быстрее, если он далеко ушёл
          const step = Math.min(td, p.speed * (td > 6 ? 2.2 : 1) * dt);
          const nx = p.pos.x + tx / td * step, nz = p.pos.z + tz / td * step;
          if (!city.segAt(_v.set(nx, p.pos.y + 1, nz), 0.4)) { p.pos.x = nx; p.pos.z = nz; } else p.gr = Math.max(3, p.gr - dt * 3);
          p.heading = Math.atan2(tx, tz);
          p.phase += dt * p.speed * 4.5;
          swing = Math.sin(p.phase) * 0.5;
          armSwing = -swing * 0.7;
        } else {
          // Стоят вокруг героя: смотрят на него, переминаются, кто-то машет
          this.face(p, focus.x, focus.z, dt, 3);
          lookT = Math.atan2(Math.max(0, above + 1.0), Math.max(flat, 1)) * 0.6;
          p.phase += dt;
          if (p.gesture > 0.7) { armRT = -2.9; waveT = 1; }
          else if (p.gesture < 0.15) armRT = -2.2;          // показывает
          else if (p.gesture < 0.45) { armRT = -1.5; phoneT = 1; } // снимает героя
        }
        p.pos.y = city.groundHeightAt(p.pos.x, p.pos.z, p.pos.y + 1);
        if (!crowdKeep || flat > 60) this.backToWalk(p);
      } else if (p.state === 'selfie') {
        // Селфи с героем: встаёт рядом, лицом к «камере», телефон в вытянутой руке — вспышка
        p.timer -= dt;
        const D = this.selfieDir, rx = D.z, rz = -D.x;
        p.target.set(focus.x + rx * 0.8 * p.selfieSide + D.x * 0.2, 0, focus.z + rz * 0.8 * p.selfieSide + D.z * 0.2);
        const tx = p.target.x - p.pos.x, tz = p.target.z - p.pos.z, td = Math.hypot(tx, tz);
        if (td > 0.25 && p.timer > 1.8) {
          const step = Math.min(td, 2.4 * dt);
          const nx = p.pos.x + tx / td * step, nz = p.pos.z + tz / td * step;
          if (!city.segAt(_v.set(nx, p.pos.y + 1, nz), 0.4)) { p.pos.x = nx; p.pos.z = nz; }
          p.heading = Math.atan2(tx, tz);
          p.phase += dt * 11;
          swing = Math.sin(p.phase) * 0.5;
          armSwing = -swing * 0.7;
        } else {
          const want = Math.atan2(D.x, D.z);
          p.heading += Math.atan2(Math.sin(want - p.heading), Math.cos(want - p.heading)) * Math.min(1, dt * 6);
          armRT = -2.3; phoneT = 1; lookT = 0.3;
          // Свободной рукой — «знак мира» или обнимает героя за плечо
          armLT = p.selfieSide > 0 ? -2.4 : -0.6;
          if (!p.flashed && p.timer < 1.3) {
            p.flashed = true;
            this.flash(_v.set(p.pos.x + Math.sin(p.heading) * 0.5, p.pos.y + 1.95 * p.h, p.pos.z + Math.cos(p.heading) * 0.5).clone());
          }
        }
        p.pos.y = city.groundHeightAt(p.pos.x, p.pos.z, p.pos.y + 1);
        if (p.timer <= 0) { this.backToWalk(p); p.greetT = 1.5; }
      } else if (p.state === 'flee') {
        p.timer -= dt;
        const away = _v.subVectors(p.pos, p.from).setY(0);
        if (away.lengthSq() < 0.01) away.set(1, 0, 0);
        const want = Math.atan2(away.x, away.z) + Math.sin(p.phase * 0.3 + p.slot) * 0.4;
        const dh = Math.atan2(Math.sin(want - p.heading), Math.cos(want - p.heading));
        p.heading += dh * Math.min(1, dt * 5);
        const nx = p.pos.x + Math.sin(p.heading) * p.speed * dt, nz = p.pos.z + Math.cos(p.heading) * p.speed * dt;
        if (city.segAt(_v.set(nx, p.pos.y + 1, nz), 0.4)) p.heading += Math.PI / 2;
        else { p.pos.x = nx; p.pos.z = nz; }
        p.pos.y = city.groundHeightAt(p.pos.x, p.pos.z, p.pos.y + 1);
        p.phase += dt * p.speed * 2.2;
        swing = Math.sin(p.phase) * 0.9;
        // Бегут, размахивая руками; некоторые прикрывают голову
        if (p.gesture < 0.3) { armLT = -2.6; armRT = -2.6; } else armSwing = -swing * 1.2;
        if (p.timer <= 0) this.backToWalk(p);
      } else if (p.state === 'fly') {
        p.vel.y -= DEBRIS.gravity * 0.8 * dt;
        p.pos.addScaledVector(p.vel, dt);
        _e.set(p.ang.x * dt, p.ang.y * dt, p.ang.z * dt);
        p.quat.multiply(_q.setFromEuler(_e));
        if (city.segAt(_v.copy(p.pos).setY(p.pos.y + 0.8), 0.3)) { p.vel.x *= -0.3; p.vel.z *= -0.3; p.pos.addScaledVector(p.vel, dt * 2); }
        const gy = city.groundHeightAt(p.pos.x, p.pos.z, p.pos.y + 0.5);
        armLT = -2.8; armRT = -2.8;
        if (p.pos.y <= gy) {
          p.pos.y = gy;
          if (Math.abs(p.vel.y) > 6) { p.vel.y *= -0.3; p.vel.x *= 0.6; p.vel.z *= 0.6; }
          else {
            p.state = 'down';
            p.timer = 2.5 + Math.random() * 3;
            p.quat.setFromAxisAngle(UP, Math.random() * 6.28).multiply(_q.setFromAxisAngle(RX, Math.PI / 2 * (Math.random() < 0.5 ? 1 : -1)));
          }
        }
      } else if (p.state === 'down') {
        p.timer -= dt;
        p.pos.y = city.groundHeightAt(p.pos.x, p.pos.z, p.pos.y + 1) + 0.15;
        if (p.timer <= 0) { p.state = 'walk'; p.pos.y -= 0.15; this.scare(p, focus, 8); }
      }
      // Ответ на приветствие героя: машут, радуются (руки вверх) или снимают на телефон
      if (p.greetT > 0) {
        if (p.state !== 'walk') p.greetT -= dt;
        if (p.state === 'walk' || p.state === 'watch' || p.state === 'gather') {
          if (p.gesture > 0.5) { armRT = -2.9; waveT = 1; }
          else if (p.gesture < 0.25) { armLT = -2.7; armRT = -2.7; }
          else { armRT = -1.5; phoneT = 1; }
        }
      }
      if (p.state === 'walk' || p.state === 'watch' || p.state === 'gather' || p.state === 'flee' || p.state === 'selfie') p.quat.setFromAxisAngle(UP, p.heading);
      // Плавные переходы жестов
      const k = Math.min(1, dt * 6);
      p.look += (lookT - p.look) * k;
      p.armL += (armLT - p.armL) * k;
      p.armR += (armRT - p.armR) * k;
      p.wave += (waveT - p.wave) * k;
      p.phone += (phoneT - p.phone) * k;
      this.write(p, swing, armSwing);
    }
    this.gatherCount = gathering;
    for (const f of this.flashes) {
      if (f.t <= 0) continue;
      f.t -= dt;
      const k = Math.max(0, f.t / 0.22);
      f.s.scale.setScalar(0.6 + 1.6 * k);
      f.s.material.opacity = k;
      if (f.t <= 0) f.s.visible = false;
    }
    for (const m of this.meshes) {
      m.count = m === this.arms || m === this.legs ? this.drawN * 2 : this.drawN;
      m.instanceMatrix.needsUpdate = true;
      if (this.colorsDirty && m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    this.colorsDirty = false;
  }

  nearestS(p) {
    let best = 0, bestD = Infinity;
    for (let s = 0; s < PERIM; s += 4) {
      const d = this.pathPoint(p, s, _v).distanceToSquared(p.pos);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  write(p, swing, armSwing) {
    if (this.camPos && p.pos.distanceTo(this.camPos) > ALWAYS_NEAR) {
      _sph.center.set(p.pos.x, p.pos.y + 1, p.pos.z);
      if (!_frustum.intersectsSphere(_sph)) return;
    }
    const slot = this.drawSlot(p);
    const w = p.w || 1;
    _m.compose(p.pos, p.quat, _s.set(p.h * w, p.h, p.h * w));
    this.torso.setMatrixAt(slot, _m);
    this.bag.setMatrixAt(slot, p.bag ? _m : _zero);
    this.skirt.setMatrixAt(slot, p.skirt ? _m : _zero);
    // Голова (с волосами) наклоняется назад, когда человек смотрит вверх; ширина плеч её не растягивает
    _m2.compose(_v.set(0, NECK_Y, 0), _q2.setFromAxisAngle(RX, -p.look), _s.set(1 / w, 1, 1 / w)).premultiply(_m);
    this.head.setMatrixAt(slot, _m2);
    this.hairShort.setMatrixAt(slot, p.hair === 'short' && !p.cap ? _m2 : _zero);
    this.hairLong.setMatrixAt(slot, p.hair === 'long' ? _m2 : _zero);
    this.cap.setMatrixAt(slot, p.cap ? _m2 : _zero);
    _s.set(1 / w, 1, 1 / w);
    for (let k = 0; k < 2; k++) {
      const side = k === 0 ? 1 : -1;
      _m2.compose(_v.set(side * 0.1, HIP_Y, 0), _q2.setFromAxisAngle(RX, swing * side), _s);
      this.legs.setMatrixAt(slot * 2 + k, _m2.premultiply(_m));
      // Руки: размах при ходьбе, жесты (поднять, показать, помахать)
      const lift = side > 0 ? p.armL : p.armR;
      let rx = armSwing * side + lift, rz = 0;
      // Держатся за руки: рука тянется к партнёру
      if (p.holdSide === side && lift === 0) { rx = -0.12; rz = side * 0.38; }
      if (side < 0 && p.wave > 0.01) rz = -(0.35 + Math.sin(p.phase * 9) * 0.35) * p.wave;
      _e.set(rx, 0, rz + side * 0.06);
      _m2.compose(_v.set(side * 0.215, SHOULDER_Y, 0), _q2.setFromEuler(_e), _s);
      this.arms.setMatrixAt(slot * 2 + k, _m2.premultiply(_m));
      if (side < 0) this.phone.setMatrixAt(slot, p.phone > 0.4 ? _m2 : _zero);
    }
  }

  // Неактивные просто не попадают в кадр (см. write)
  hide() {}

  clear() {
    for (const p of this.list) p.state = 'none';
    for (const m of this.meshes) m.count = 0;
  }
}

// Материал людей: атрибут tint решает, какие части берут цвет экземпляра
// (одежда, кожа, волосы), а какие остаются своего цвета (кисти, обувь)
function createPeopleMaterial() {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float tint;')
      .replace('#include <color_vertex>', `
        vColor.rgb = color.rgb;
        #ifdef USE_INSTANCING_COLOR
          vColor.rgb *= mix(vec3(1.0), instanceColor.rgb, tint);
        #endif`);
  };
  return mat;
}

// Человек из частей. Точки вращения: ноги — в бедре, руки — в плече, голова — в основании шеи.
function makePersonGeometry() {
  const part = (geo, color, tint) => {
    if (geo.index) geo = geo.toNonIndexed();
    const c = new THREE.Color(color), n = geo.attributes.position.count;
    const a = new Float32Array(n * 3), t = new Float32Array(n).fill(tint);
    for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
    geo.setAttribute('tint', new THREE.BufferAttribute(t, 1));
    geo.deleteAttribute('uv');
    return geo;
  };
  const merge = (list) => mergeGeometries(list);
  // Торс: грудь шире талии, плечи, воротник, таз
  const torso = merge([
    part(new THREE.CylinderGeometry(0.2, 0.16, 0.42, 8).scale(1, 1, 0.62).translate(0, 1.22, 0), 0xffffff, 1),
    part(new THREE.SphereGeometry(0.2, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2).scale(1.05, 0.45, 0.62).translate(0, 1.42, 0), 0xffffff, 1),
    part(new THREE.CylinderGeometry(0.165, 0.17, 0.16, 8).scale(1, 1, 0.66).translate(0, 0.98, 0), 0xffffff, 1),
  ]);
  // Голова: шея, череп, нос, уши
  const head = merge([
    part(new THREE.CylinderGeometry(0.048, 0.055, 0.1, 6).translate(0, 0.03, 0), 0xffffff, 1),
    part(new THREE.SphereGeometry(0.1, 10, 8).scale(0.88, 1.08, 1).translate(0, 0.17, 0.005), 0xffffff, 1),
    part(new THREE.BoxGeometry(0.03, 0.045, 0.04).translate(0, 0.155, 0.098), 0xffffff, 1),
    part(new THREE.SphereGeometry(0.022, 5, 4).scale(0.5, 1, 0.8).translate(0.088, 0.16, 0), 0xffffff, 1),
    part(new THREE.SphereGeometry(0.022, 5, 4).scale(0.5, 1, 0.8).translate(-0.088, 0.16, 0), 0xffffff, 1),
    // Лицо: глаза, брови, губы, подбородок
    part(new THREE.SphereGeometry(0.011, 5, 4).scale(1.2, 0.8, 0.5).translate(0.034, 0.182, 0.099), 0x1a1410, 0),
    part(new THREE.SphereGeometry(0.011, 5, 4).scale(1.2, 0.8, 0.5).translate(-0.034, 0.182, 0.099), 0x1a1410, 0),
    part(new THREE.BoxGeometry(0.032, 0.007, 0.008).rotateZ(-0.12).translate(0.035, 0.205, 0.097), 0x2a1c14, 0),
    part(new THREE.BoxGeometry(0.032, 0.007, 0.008).rotateZ(0.12).translate(-0.035, 0.205, 0.097), 0x2a1c14, 0),
    part(new THREE.BoxGeometry(0.036, 0.007, 0.008).translate(0, 0.118, 0.092), 0x8a4a42, 0),
    part(new THREE.SphereGeometry(0.03, 6, 4).scale(1.1, 0.7, 0.8).translate(0, 0.095, 0.07), 0xffffff, 1),
  ]);
  const hairShort = part(new THREE.SphereGeometry(0.106, 10, 5, 0, Math.PI * 2, 0, Math.PI * 0.55).scale(0.92, 1.0, 1.05).translate(0, 0.19, -0.008), 0xffffff, 1);
  const hairLong = merge([
    part(new THREE.SphereGeometry(0.108, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.6).scale(0.95, 1.02, 1.06).translate(0, 0.185, -0.01), 0xffffff, 1),
    part(new THREE.BoxGeometry(0.19, 0.24, 0.06).translate(0, 0.08, -0.075), 0xffffff, 1),
  ]);
  // Рука висит из плеча: рукав, кисть
  const arm = merge([
    part(new THREE.CapsuleGeometry(0.048, 0.46, 2, 6).translate(0, -0.27, 0), 0xffffff, 1),
    part(new THREE.SphereGeometry(0.045, 6, 4).scale(0.8, 1.2, 0.6).translate(0, -0.6, 0.01), 0xc99a78, 0),
  ]);
  // Нога из бедра: брючина сужается книзу, ботинок
  const leg = merge([
    part(new THREE.CylinderGeometry(0.085, 0.058, 0.82, 7).translate(0, -0.41, 0), 0xffffff, 1),
    part(new THREE.BoxGeometry(0.1, 0.08, 0.25).translate(0, -0.87, 0.04), 0x1c1a19, 0),
  ]);
  // Рюкзак, кепка с козырьком, юбка, телефон (в правой руке, экран к владельцу)
  const bag = merge([
    part(new THREE.BoxGeometry(0.27, 0.34, 0.13).translate(0, 1.2, -0.17), 0xffffff, 1),
    part(new THREE.BoxGeometry(0.2, 0.12, 0.04).translate(0, 1.1, -0.25), 0xffffff, 1),
    part(new THREE.BoxGeometry(0.035, 0.02, 0.28).translate(0.1, 1.43, -0.04), 0x222222, 0),
    part(new THREE.BoxGeometry(0.035, 0.02, 0.28).translate(-0.1, 1.43, -0.04), 0x222222, 0),
  ]);
  const cap = merge([
    part(new THREE.SphereGeometry(0.108, 10, 5, 0, Math.PI * 2, 0, Math.PI * 0.5).scale(0.95, 0.75, 1.04).translate(0, 0.19, -0.004), 0xffffff, 1),
    part(new THREE.CylinderGeometry(0.07, 0.07, 0.008, 10).scale(1, 1, 0.75).translate(0, 0.198, 0.1), 0xffffff, 1),
  ]);
  const skirt = part(new THREE.CylinderGeometry(0.17, 0.26, 0.46, 10).scale(1, 1, 0.72).translate(0, 0.74, 0), 0xffffff, 1);
  const phone = merge([
    part(new THREE.BoxGeometry(0.072, 0.01, 0.145).translate(0, -0.65, 0.0), 0x161618, 0),
    part(new THREE.BoxGeometry(0.062, 0.002, 0.128).translate(0, -0.644, 0.0), 0xa8dcff, 0),
  ]);
  return { torso, head, hairShort, hairLong, arm, leg, bag, cap, skirt, phone };
}
