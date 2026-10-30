import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BLOCK, blockAt } from './layout.js';

// Мелкая живность парков и площадей:
// белки скачут по траве и взбегают на деревья, если герой рядом;
// бабочки порхают над клумбами днём;
// голуби клюют на площадях у фонтанов и с хлопаньем взлетают от героя.
// Всё появляется только рядом с камерой.

const SQ = 24, BF = 60, PG = 48;
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const BUTTERFLY = [0xffb703, 0xfb8500, 0xffffff, 0x8ecae6, 0xf72585, 0xb5e48c, 0xffd6a5];

export class Critters {
  constructor(scene, world) {
    this.world = world;
    this.t = 0;
    this.uTime = { value: 0 };
    const mat = createMat(this.uTime);
    const G = makeGeometries();
    const mk = (geo, n) => {
      const m = new THREE.InstancedMesh(geo, mat, n);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3);
      m.frustumCulled = false;
      for (let i = 0; i < n; i++) m.setMatrixAt(i, _zero);
      scene.add(m);
      return m;
    };
    this.sqMesh = mk(G.squirrel, SQ);
    this.bfMesh = mk(G.butterfly, BF);
    this.pgMesh = mk(G.pigeon, PG);
    // Взмахи крыльев задаются атрибутом экземпляра (частота, размах)
    this.bfFlap = new THREE.InstancedBufferAttribute(new Float32Array(BF * 2), 2);
    G.butterfly.setAttribute('iFlap', this.bfFlap);
    this.pgFlap = new THREE.InstancedBufferAttribute(new Float32Array(PG * 2), 2);
    G.pigeon.setAttribute('iFlap', this.pgFlap);
    for (let i = 0; i < BF; i++) this.bfMesh.setColorAt(i, new THREE.Color(BUTTERFLY[i % BUTTERFLY.length]));
    for (let i = 0; i < PG; i++) this.pgMesh.setColorAt(i, new THREE.Color().setHSL(0.6, 0.06, 0.25 + Math.random() * 0.25));
    this.sq = Array.from({ length: SQ }, (_, i) => ({ i, state: 'none', pos: new THREE.Vector3(), target: new THREE.Vector3(), heading: 0, timer: 0, phase: Math.random() * 6, tree: null, climb: 0 }));
    this.bf = Array.from({ length: BF }, (_, i) => ({ i, state: 'none', home: new THREE.Vector3(), pos: new THREE.Vector3(), ph: Math.random() * 6 }));
    this.pg = Array.from({ length: PG }, (_, i) => ({ i, state: 'none', pos: new THREE.Vector3(), heading: Math.random() * 6, vel: new THREE.Vector3(), timer: 0, peck: Math.random() * 6 }));
    this.spawnT = 0;
  }

  // Ближайшие деревья и клумбы/площади вокруг камеры (из уже созданных систем)
  nearTrees(c, r) {
    const out = [];
    this.world.trees?.near(c.x, c.z, r, (t) => { if (!t.forest && t.y === 0) out.push(t); });
    return out;
  }

  respawn(cam) {
    const W = this.world;
    // Белки — у деревьев в парках
    const trees = this.nearTrees(cam, 160).filter((t) => { const b = blockAt(t.x, t.z); return b === BLOCK.PARK || b === BLOCK.BIGPARK; });
    for (const s of this.sq) {
      if (s.state !== 'none' || !trees.length) continue;
      const t = trees[Math.floor(Math.random() * trees.length)];
      s.pos.set(t.x + (Math.random() - 0.5) * 6, 0, t.z + (Math.random() - 0.5) * 6);
      s.state = 'ground'; s.timer = 1 + Math.random() * 3; s.target.copy(s.pos); s.tree = null; s.climb = 0;
    }
    // Бабочки — над клумбами, днём
    const beds = (W.nature?.items || []).filter((it) => it.type === 'flowerbed' && it.alive && Math.hypot(it.x - cam.x, it.z - cam.z) < 140);
    for (const b of this.bf) {
      if (b.state !== 'none' || !beds.length) continue;
      const it = beds[Math.floor(Math.random() * beds.length)];
      b.home.set(it.x, 0.6, it.z); b.pos.copy(b.home); b.state = 'fly';
    }
    // Голуби — стайками на площадях у фонтанов
    const plazas = (W.nature?.items || []).filter((it) => it.type === 'fountain' && Math.hypot(it.x - cam.x, it.z - cam.z) < 260);
    let free = this.pg.filter((p) => p.state === 'none');
    for (const pl of plazas) {
      if (free.length < 6) break;
      if (this.pg.some((p) => p.state !== 'none' && Math.hypot(p.pos.x - pl.x, p.pos.z - pl.z) < 15)) continue;
      for (let k = 0; k < 8 && free.length; k++) {
        const p = free.pop();
        const a = Math.random() * 6.28, r = 5 + Math.random() * 3;
        p.pos.set(pl.x + Math.cos(a) * r, 0, pl.z + Math.sin(a) * r);
        p.state = 'walk'; p.timer = Math.random() * 3; p.heading = Math.random() * 6.28;
      }
    }
  }

  update(dt, player, cam, night) {
    this.t += dt;
    this.uTime.value = this.t;
    const show = cam.y < 300;
    this.sqMesh.visible = this.bfMesh.visible = this.pgMesh.visible = show;
    if (!show) return;
    this.spawnT -= dt;
    if (this.spawnT <= 0) { this.spawnT = 1.5; this.respawn(cam); }
    const hero = player.pos, hs = player.vel.length();
    const city = this.world.city;

    // ---- белки
    for (const s of this.sq) {
      if (s.state === 'none') { this.sqMesh.setMatrixAt(s.i, _zero); continue; }
      if (s.pos.distanceTo(cam) > 220) { s.state = 'none'; continue; }
      const dh = Math.hypot(hero.x - s.pos.x, hero.z - s.pos.z);
      let y = 0, pitch = 0, speed = 0;
      if (s.state === 'ground') {
        if (dh < 9 || (dh < 25 && hs > 15)) {
          // Испугалась: бежит к ближайшему дереву и забирается на ствол
          let best = null, bd = 1e9;
          this.world.trees?.near(s.pos.x, s.pos.z, 15, (t) => { const d = Math.hypot(t.x - s.pos.x, t.z - s.pos.z); if (d < bd) { bd = d; best = t; } });
          if (best) { s.tree = best; s.state = 'run'; s.target.set(best.x, 0, best.z); }
        } else {
          s.timer -= dt;
          if (s.timer <= 0) {
            s.timer = 0.6 + Math.random() * 2.5;
            const a = Math.random() * 6.28, r = Math.random() < 0.4 ? 0 : 1 + Math.random() * 5;
            s.target.set(s.pos.x + Math.cos(a) * r, 0, s.pos.z + Math.sin(a) * r);
          }
        }
      }
      if (s.state === 'ground' || s.state === 'run') {
        const tx = s.target.x - s.pos.x, tz = s.target.z - s.pos.z, td = Math.hypot(tx, tz);
        speed = td > 0.15 ? (s.state === 'run' ? 6 : 2.5) : 0;
        if (speed > 0) {
          s.heading = Math.atan2(tx, tz);
          const st = Math.min(td, speed * dt);
          s.pos.x += tx / td * st; s.pos.z += tz / td * st;
          s.phase += dt * speed * 3.5;
          y = Math.abs(Math.sin(s.phase)) * 0.15;      // прыжки
        }
        if (s.state === 'run' && td < 0.4) s.state = 'climb';
      }
      if (s.state === 'climb') {
        s.climb = Math.min(3.2 * (s.tree.s || 1), s.climb + dt * 3);
        y = s.climb; pitch = -Math.PI / 2;
        // Слезает, когда герой ушёл
        if (dh > 22 && s.climb > 2) { s.state = 'down'; }
      } else if (s.state === 'down') {
        s.climb -= dt * 2; y = Math.max(0, s.climb); pitch = Math.PI / 2;
        if (s.climb <= 0) { s.state = 'ground'; s.pos.x += 1; }
      }
      const off = s.state === 'climb' || s.state === 'down' ? 0.25 : 0;
      _e.set(pitch, s.heading, 0, 'YXZ');
      const gy = city.groundHeightAt(s.pos.x, s.pos.z, 2);
      this.sqMesh.setMatrixAt(s.i, _m.compose(_v.set(s.pos.x - Math.sin(s.heading) * off, gy + y, s.pos.z - Math.cos(s.heading) * off), _q.setFromEuler(_e), _s.setScalar(1)));
    }
    this.sqMesh.instanceMatrix.needsUpdate = true;

    // ---- бабочки (днём)
    const day = night < 0.5;
    for (const b of this.bf) {
      if (b.state === 'none' || !day || b.home.distanceTo(cam) > 180) { b.state = day && b.state !== 'none' && b.home.distanceTo(cam) <= 180 ? b.state : 'none'; this.bfMesh.setMatrixAt(b.i, _zero); continue; }
      b.ph += dt;
      const p = b.ph;
      b.pos.set(b.home.x + Math.sin(p * 0.7) * 1.6 + Math.sin(p * 2.3) * 0.4, b.home.y + 0.4 + Math.sin(p * 1.9) * 0.35, b.home.z + Math.cos(p * 0.6) * 1.6 + Math.cos(p * 2.9) * 0.4);
      const h = Math.atan2(Math.cos(p * 0.7) * 0.7, -Math.sin(p * 0.6) * 0.6);
      _e.set(0, h, 0);
      this.bfMesh.setMatrixAt(b.i, _m.compose(b.pos, _q.setFromEuler(_e), _s.setScalar(1)));
      this.bfFlap.setXY(b.i, 22 + (b.i % 5) * 2, 1);
    }
    this.bfMesh.instanceMatrix.needsUpdate = true;
    this.bfFlap.needsUpdate = true;

    // ---- голуби на площадях
    let scared = null;
    for (const p of this.pg) {
      if (p.state === 'none') { this.pgMesh.setMatrixAt(p.i, _zero); continue; }
      if (p.pos.distanceTo(cam) > 300) { p.state = 'none'; continue; }
      const dh = Math.hypot(hero.x - p.pos.x, hero.z - p.pos.z);
      if (p.state === 'walk' && (dh < 7 || (dh < 30 && hs > 12))) {
        p.state = 'fly';
        const ax = p.pos.x - hero.x, az = p.pos.z - hero.z, al = Math.hypot(ax, az) || 1;
        p.vel.set(ax / al * 6 + (Math.random() - 0.5) * 3, 5 + Math.random() * 2, az / al * 6 + (Math.random() - 0.5) * 3);
        p.timer = 4;
        scared = p.pos;
      }
      let pitch = 0, flap = 0;
      if (p.state === 'walk') {
        p.timer -= dt;
        if (p.timer <= 0) { p.timer = 1 + Math.random() * 3; p.heading += (Math.random() - 0.5) * 2; }
        const step = 0.35 * dt * (Math.sin(this.t * 3 + p.i) > 0 ? 1 : 0);
        p.pos.x += Math.sin(p.heading) * step; p.pos.z += Math.cos(p.heading) * step;
        // Клюёт: наклоняет корпус
        p.peck += dt * 6;
        pitch = Math.max(0, Math.sin(p.peck * 0.5 + p.i)) * 0.5;
        p.pos.y = 0;
      } else if (p.state === 'fly') {
        p.timer -= dt;
        p.vel.y += dt * 2;
        p.pos.addScaledVector(p.vel, dt);
        p.heading = Math.atan2(p.vel.x, p.vel.z);
        pitch = -0.3; flap = 1;
        if (p.timer <= 0) p.state = 'none';
      }
      _e.set(pitch, p.heading, 0, 'YXZ');
      const gy = p.state === 'walk' ? city.groundHeightAt(p.pos.x, p.pos.z, 2) : 0;
      this.pgMesh.setMatrixAt(p.i, _m.compose(_v.set(p.pos.x, p.pos.y + gy, p.pos.z), _q.setFromEuler(_e), _s.setScalar(1)));
      this.pgFlap.setXY(p.i, 16, flap);
    }
    if (scared) this.world.audio?.flutter(0.8, scared.clone());
    this.pgMesh.instanceMatrix.needsUpdate = true;
    this.pgFlap.needsUpdate = true;
  }
}

// Материал: tint — цвет экземпляра; wing — часть крыла (машет по iFlap: частота, размах)
function createMat(uTime) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float tint;\nattribute float wing;\nattribute vec2 iFlap;\nuniform float uTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          float w = abs(wing);
          float a = sin(uTime * iFlap.x + float(gl_InstanceID) * 1.7) * iFlap.y;
          transformed.y += a * w * 0.9;
          transformed.x *= 1.0 - max(0.0, a) * w * 0.3;
        }`)
      .replace('#include <color_vertex>', `
        vColor.rgb = color.rgb;
        #ifdef USE_INSTANCING_COLOR
          vColor.rgb *= mix(vec3(1.0), instanceColor.rgb, tint);
        #endif`);
  };
  return mat;
}

function makeGeometries() {
  const part = (geo, color, tint = 0, wingFn = null) => {
    if (geo.index) geo = geo.toNonIndexed();
    if (geo.attributes.uv) geo.deleteAttribute('uv');
    if (!geo.attributes.normal) geo.computeVertexNormals();
    const n = geo.attributes.position.count, c = new THREE.Color(color), P = geo.attributes.position;
    const col = new Float32Array(n * 3), w = new Float32Array(n);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; w[i] = wingFn ? wingFn(P.getX(i)) : 0; }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('tint', new THREE.BufferAttribute(new Float32Array(n).fill(tint), 1));
    geo.setAttribute('wing', new THREE.BufferAttribute(w, 1));
    return geo;
  };
  const S = (r, sx, sy, sz, x, y, z) => new THREE.SphereGeometry(r, 7, 5).scale(sx, sy, sz).translate(x, y, z);
  const M = (l) => mergeGeometries(l);
  // Белка: тело, голова с ушками, пушистый изогнутый хвост
  const tail = new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.08, -0.08), new THREE.Vector3(0, 0.2, -0.17), new THREE.Vector3(0, 0.32, -0.12), new THREE.Vector3(0, 0.36, -0.03),
  ]), 8, 0.045, 6);
  const squirrel = M([
    part(S(0.07, 0.8, 0.85, 1.3, 0, 0.08, 0), 0xa0522d), part(S(0.045, 1, 1, 1.1, 0, 0.13, 0.09), 0xa0522d),
    part(new THREE.ConeGeometry(0.015, 0.035, 4).translate(0.022, 0.18, 0.08), 0x8a4525), part(new THREE.ConeGeometry(0.015, 0.035, 4).translate(-0.022, 0.18, 0.08), 0x8a4525),
    part(tail, 0xb5653a), part(S(0.012, 1, 1, 1, 0.02, 0.14, 0.13), 0x111111), part(S(0.012, 1, 1, 1, -0.02, 0.14, 0.13), 0x111111),
  ]);
  // Бабочка: два крыла (машут), тонкое тельце
  const wingL = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0.03, 0.09, 0, 0.06, 0.08, 0, -0.04, 0, 0, 0.03, 0.08, 0, -0.04, 0, 0, -0.03], 3));
  const wingR = wingL.clone().scale(-1, 1, 1);
  const butterfly = M([part(wingL, 0xffffff, 1, (x) => x / 0.09), part(wingR, 0xffffff, 1, (x) => x / 0.09), part(S(0.008, 1, 1, 5, 0, 0, 0), 0x222222)]);
  // Голубь: тело, голова, клюв, крылья (машут в полёте)
  const pigeon = M([
    part(S(0.1, 0.8, 0.75, 1.4, 0, 0.13, 0), 0xffffff, 1), part(S(0.045, 1, 1, 1.1, 0, 0.24, 0.1), 0xffffff, 1),
    part(S(0.012, 1, 0.8, 1.8, 0, 0.235, 0.15), 0x3a3a3a),
    part(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0.16, 0.06, 0, 0.16, -0.08, 0.26, 0.17, -0.04], 3)), 0xbfc3c8, 0, (x) => x / 0.26),
    part(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0.16, 0.06, -0.26, 0.17, -0.04, 0, 0.16, -0.08], 3)), 0xbfc3c8, 0, (x) => x / 0.26),
    part(S(0.03, 0.5, 0.8, 1, 0, 0.06, 0.02), 0xc06070),
  ]);
  return { squirrel, butterfly, pigeon };
}
