import * as THREE from 'three';
import { ISLE, isleToWorld, islandHeight } from '../world/layout.js';

// Предметы сюжета, которых нет в мире: корабль Илены, капсула с младенцем, маяк Элиаса, след двигателя.
// Всё процедурное, без новых моделей.

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _m = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

// Тёплый белый свет рода Тейв: им светятся корабль, капсула и знак
export const TEIV_LIGHT = new THREE.Color(1.0, 0.86, 0.62);

const glowMat = (color, k = 3) => new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(k), toneMapped: false });

// Свечение-«капля» вокруг точки (двигатель, огонь капсулы): спрайт с мягким краем
function glowSprite(color, size) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d'), grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.45)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const m = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), color: color.clone().multiplyScalar(2.2), blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, transparent: true });
  const s = new THREE.Sprite(m);
  s.scale.setScalar(size);
  return s;
}

// ---------------------------------------------------------------- корабль Илены
// Узкий светлый наконечник ~36 м: корпус-игла, два отведённых назад крыла, кабина — тёплая щель,
// два двигателя. Нос смотрит по +Z
export class Ship {
  constructor(scene) {
    const g = this.group = new THREE.Group();
    const hullMat = new THREE.MeshStandardMaterial({ color: 0xd9d2c4, metalness: 0.75, roughness: 0.32 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x2a2724, metalness: 0.6, roughness: 0.5 });
    const trim = glowMat(TEIV_LIGHT, 2.5);
    // Корпус: вытянутый конус, сплющенный по высоте
    const hull = new THREE.Mesh(new THREE.ConeGeometry(3.2, 34, 6, 1), hullMat);
    hull.rotation.x = Math.PI / 2;
    hull.scale.set(1, 1, 0.55);
    g.add(hull);
    // Хребет
    // Хребет кончается перед кабиной
    const spine = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.4, 19), darkMat);
    spine.position.set(0, 1.4, -5.5);
    g.add(spine);
    // Крылья: тонкие пластины, отведены назад
    for (const s of [-1, 1]) {
      const w = new THREE.Mesh(new THREE.BoxGeometry(14, 0.35, 7), hullMat);
      w.position.set(s * 7.5, -0.3, -9);
      w.rotation.y = s * 0.55;
      g.add(w);
      const edge = new THREE.Mesh(new THREE.BoxGeometry(13.5, 0.2, 0.25), trim);
      edge.position.set(s * 7.6, -0.25, -5.6);
      edge.rotation.y = s * 0.55;
      g.add(edge);
      // Двигатель под крылом
      const eng = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.4, 7, 12), darkMat);
      eng.rotation.x = Math.PI / 2;
      eng.position.set(s * 4.2, -0.9, -13);
      g.add(eng);
      const nozzle = new THREE.Mesh(new THREE.CircleGeometry(1.15, 16), glowMat(new THREE.Color(0.75, 0.85, 1.0), 4));
      nozzle.position.set(s * 4.2, -0.9, -16.55);
      nozzle.rotation.y = Math.PI;
      g.add(nozzle);
      const fl = glowSprite(new THREE.Color(0.7, 0.82, 1.0), 9);
      fl.position.set(s * 4.2, -0.9, -17.5);
      g.add(fl);
    }
    // Кабина: стеклянный пузырь на носу, изнутри залит тёплым светом; в нём тёмный силуэт Илены.
    // Внутренние стенки видны сквозь «стекло» (рисуется только изнанка), силуэт — тёмный на их фоне
    const cabin = new THREE.Group();
    cabin.position.set(0, 1.25, 8);
    const inner = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.1, 4), new THREE.MeshBasicMaterial({ map: cabinGlow(), color: TEIV_LIGHT.clone().multiplyScalar(1.3), side: THREE.BackSide, toneMapped: false }));
    cabin.add(inner);
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x1c1a18, metalness: 0.7, roughness: 0.4 });
    // Рама: рёбра по углам и две дуги — бока и верх остаются стеклом
    for (const [x, y] of [[0.92, 0.56], [-0.92, 0.56], [0.92, -0.56], [-0.92, -0.56]]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 4.06), frameMat);
      bar.position.set(x, y, 0);
      cabin.add(bar);
    }
    for (const z of [-2, 0.6, 2]) {
      const arc = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.06, 0.06), frameMat);
      arc.position.set(0, 0.56, z);
      cabin.add(arc);
      for (const x of [-0.92, 0.92]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.16, 0.06), frameMat);
        post.position.set(x, 0, z);
        cabin.add(post);
      }
    }
    // Силуэт: сидит лицом к носу, голова чуть склонена — к тому, что у неё на руках
    const shade = new THREE.MeshBasicMaterial({ color: 0x050404 });
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.32, 4, 10), shade);
    torso.position.set(0, -0.12, -0.5);
    torso.scale.set(1.25, 1, 0.8);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), shade);
    head.position.set(0, 0.34, -0.42);
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.15, 10, 8), shade);
    hair.position.set(0, 0.3, -0.5);
    hair.scale.set(0.95, 1.1, 0.9);
    const bundle = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), shade);
    bundle.position.set(0.05, -0.05, -0.28);
    bundle.scale.set(1.3, 0.8, 0.9);
    cabin.add(torso, head, hair, bundle);
    this.cabin = cabin;
    g.add(cabin);
    // Пробоина на правом крыле: огонь (виден, когда корабль ранен — burn)
    this.fire = glowSprite(new THREE.Color(1.0, 0.42, 0.1), 7);
    this.fire.position.set(6.2, 0.1, -9.5);
    this.fire.visible = false;
    g.add(this.fire);
    this.fireLight = new THREE.PointLight(0xff7a2a, 0, 60, 2);
    this.fireLight.position.copy(this.fire.position);
    g.add(this.fireLight);
    // Свет рода по хребту
    const line = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 20), trim);
    line.position.set(0, 2.15, -4);
    g.add(line);
    g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.frustumCulled = false; } });
    this.light = new THREE.PointLight(TEIV_LIGHT, 0, 160, 2);
    this.light.position.set(0, 2, 0);
    g.add(this.light);
    g.visible = false;
    scene.add(g);
    this.vel = new THREE.Vector3();
  }

  // Поставить и повернуть носом по направлению dir (крен roll вокруг оси носа)
  place(pos, dir, roll = 0) {
    this.group.position.copy(pos);
    // Нос — по dir, «верх» — к небу: корабль летит ровно, а не завален на бок
    _a.copy(dir).normalize();
    _m.lookAt(_a, _b.set(0, 0, 0), UP);
    this.group.quaternion.setFromRotationMatrix(_m);
    if (roll) this.group.rotateZ(roll);
  }

  // Огонь пробоины: k 0..1, t — время для мерцания
  burn(k, t) {
    this.fire.visible = k > 0.01;
    const f = k * (0.7 + 0.3 * Math.sin(t * 17) * Math.sin(t * 6.3));
    this.fire.material.opacity = f;
    this.fire.scale.setScalar(8 + 5 * f);
    this.fireLight.intensity = 300 * f;
  }

  // Точка корабля в координатах сцены — сразу по положению и повороту, не дожидаясь матриц кадра
  at(v) { return v.applyQuaternion(this.group.quaternion).add(this.group.position); }

  get nose() { return this.at(_c.set(0, 0, 16)); }
  get cockpit() { return this.at(_c.set(0, 1.25, 8)); }
  get wound() { return this.at(_c.copy(this.fire.position)); }
  get tail() { return this.at(_c.set(0, -0.9, -17)); }
}

// Свет в кабине: ярче к середине стенки, к краям темнеет — так силуэт стоит в пятне света
function cabinGlow() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d'), grd = g.createRadialGradient(32, 32, 4, 32, 32, 40);
  grd.addColorStop(0, '#fff');
  grd.addColorStop(0.6, '#7a6a58');
  grd.addColorStop(1, '#1e1814');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cv);
}

// Надпись на капсуле: буквы рода Тейв, середина сбита песком и ударом
function nameTexture() {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 96;
  const g = cv.getContext('2d');
  g.fillStyle = '#fff';
  g.font = 'bold 74px Georgia, serif';
  g.textBaseline = 'middle';
  g.fillText('А', 20, 52);
  g.fillText('Р', 92, 52);
  g.fillText('Н', 420, 52);
  // Стёртая середина: обрывки штрихов
  g.globalAlpha = 0.35;
  for (const [x, w] of [[180, 14], [222, 8], [262, 18], [318, 10], [352, 12]]) g.fillRect(x, 30 + (x % 3) * 8, w, 34 - (x % 5) * 4);
  // Царапины поверх всего
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'destination-out';
  g.lineWidth = 3;
  for (let i = 0; i < 14; i++) { g.beginPath(); const x = 30 + i * 34; g.moveTo(x, 8 + (i * 13) % 30); g.lineTo(x + 40, 70 + (i * 7) % 20); g.stroke(); }
  return new THREE.CanvasTexture(cv);
}

// ---------------------------------------------------------------- капсула
// Тёмная гладкая капсула ~2,6 м со знаком-звездой из тёплого света
export class Pod {
  constructor(scene) {
    const g = this.group = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.62, 1.4, 8, 20), new THREE.MeshStandardMaterial({ color: 0x1c1a1a, metalness: 0.85, roughness: 0.25 }));
    body.rotation.z = Math.PI / 2;
    g.add(body);
    const mat = glowMat(TEIV_LIGHT, 3);
    // Знак: четыре луча звезды на боку и пояс
    for (let i = 0; i < 4; i++) {
      const ray = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.62, 0.02), mat);
      ray.position.set(0, 0, 0.63);
      ray.rotation.z = (i * Math.PI) / 4;
      g.add(ray);
    }
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.63, 0.025, 6, 32), mat);
    band.rotation.y = Math.PI / 2;
    g.add(band);
    // Имя над знаком, выбито и почти стёрто: читаются только «АР» и «Н»
    const name = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.16), new THREE.MeshBasicMaterial({
      map: nameTexture(), color: TEIV_LIGHT.clone().multiplyScalar(1.4), transparent: true, depthWrite: false, toneMapped: false,
    }));
    name.position.set(0, 0.38, 0.512);
    name.rotation.x = -0.66;
    g.add(name);
    this.glow = glowSprite(TEIV_LIGHT, 6);
    g.add(this.glow);
    this.light = new THREE.PointLight(TEIV_LIGHT, 0, 40, 2);
    g.add(this.light);
    g.visible = false;
    scene.add(g);
    this.vel = new THREE.Vector3();
  }

  // Мерцание: k 0..1 — насколько ярко горит
  shine(k, t) {
    const f = k * (0.75 + 0.25 * Math.sin(t * 2.3));
    this.glow.material.opacity = f;
    this.light.intensity = 22 * f;
  }
}

// ---------------------------------------------------------------- маяк
// На западном мысу Райского острова, смотрит на море, где когда-то вспыхнули врата.
// Башня в белых и тёмно-красных поясах, галерея, фонарь и вращающийся луч; у подножия — дом смотрителя
export function lighthouseSpot() {
  // Ищем по оси острова с запада первую точку суши повыше прибоя
  for (let u = -ISLE.rx * 1.05; u < -ISLE.rx * 0.5; u += 10) {
    const [x, z] = isleToWorld(u, -ISLE.rz * 0.08);
    const h = islandHeight(x, z);
    if (h !== null && h > 6) return new THREE.Vector3(x, h, z);
  }
  const [x, z] = isleToWorld(-ISLE.rx * 0.8, 0);
  return new THREE.Vector3(x, Math.max(4, islandHeight(x, z) ?? 4), z);
}

const BEAM_V = `varying float vY; varying vec3 vW; void main() { vY = uv.y; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const BEAM_F = `uniform float uK; uniform vec3 uColor; varying float vY;
  void main() { float a = uK * pow(1.0 - vY, 2.2) * 0.35; if (a < 0.002) discard; gl_FragColor = vec4(uColor * a, a); }`;

export class Lighthouse {
  constructor(scene) {
    this.base = lighthouseSpot();
    const g = this.group = new THREE.Group();
    g.position.copy(this.base);
    const H = 30;
    this.H = H;
    // Башня из поясов
    const white = new THREE.MeshStandardMaterial({ color: 0xe8e4dc, roughness: 0.8 });
    const red = new THREE.MeshStandardMaterial({ color: 0x7a1d1a, roughness: 0.75 });
    const bands = 5;
    for (let i = 0; i < bands; i++) {
      const y0 = (i / bands) * H, y1 = ((i + 1) / bands) * H;
      const r0 = 4.6 - (y0 / H) * 1.7, r1 = 4.6 - (y1 / H) * 1.7;
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, y1 - y0, 24), i % 2 ? red : white);
      m.position.y = (y0 + y1) / 2;
      g.add(m);
    }
    const dark = new THREE.MeshStandardMaterial({ color: 0x1e2226, metalness: 0.6, roughness: 0.5 });
    const gallery = new THREE.Mesh(new THREE.CylinderGeometry(4.0, 4.0, 0.5, 24), dark);
    gallery.position.y = H + 0.25;
    g.add(gallery);
    const rail = new THREE.Mesh(new THREE.TorusGeometry(3.9, 0.06, 4, 32), dark);
    rail.rotation.x = Math.PI / 2;
    rail.position.y = H + 1.4;
    g.add(rail);
    // Фонарная: стекло светится изнутри
    this.lampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.9, 0.7).multiplyScalar(2.2), toneMapped: false });
    const lamp = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 2.1, 3.2, 16), this.lampMat);
    lamp.position.y = H + 2.1;
    g.add(lamp);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(2.6, 2.4, 16), red);
    roof.position.y = H + 4.9;
    g.add(roof);
    // Дом смотрителя
    const house = new THREE.Mesh(new THREE.BoxGeometry(9, 4.5, 7), white);
    house.position.set(9, 2.25, 3);
    g.add(house);
    const hr = new THREE.Mesh(new THREE.ConeGeometry(6.4, 3, 4), new THREE.MeshStandardMaterial({ color: 0x4a3a32, roughness: 0.9 }));
    hr.position.set(9, 6, 3);
    hr.rotation.y = Math.PI / 4;
    hr.scale.set(1, 1, 0.8);
    g.add(hr);
    const win = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.2), new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.75, 0.45).multiplyScalar(1.6), toneMapped: false }));
    win.position.set(4.49, 2.4, 3);
    win.rotation.y = -Math.PI / 2;
    g.add(win);
    g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    // Луч: два встречных конуса, вращаются вокруг башни
    this.beamU = { uK: { value: 1 }, uColor: { value: new THREE.Color(1.0, 0.92, 0.75) } };
    const beamMat = new THREE.ShaderMaterial({ uniforms: this.beamU, vertexShader: BEAM_V, fragmentShader: BEAM_F, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false });
    this.beam = new THREE.Group();
    this.beam.position.y = H + 2.1;
    const L = 900;
    for (const s of [-1, 1]) {
      // uv.y у конуса: 1 у вершины (фонарь), 0 у основания — переворачиваем, чтобы луч гас вдали
      const cone = new THREE.Mesh(new THREE.ConeGeometry(70, L, 24, 1, true), beamMat);
      const uv = cone.geometry.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
      cone.rotation.z = s * Math.PI / 2;
      cone.position.x = -s * L / 2;
      cone.frustumCulled = false;
      this.beam.add(cone);
    }
    this.beam.rotation.z = -0.03;
    g.add(this.beam);
    this.light = new THREE.PointLight(0xffe2b0, 0, 120, 2);
    this.light.position.y = H + 2.1;
    g.add(this.light);
    g.visible = false;
    scene.add(g);
    this.night = 0;
  }

  get top() { return _a.copy(this.base).addScaledVector(UP, this.H + 2); }

  show(on) { this.group.visible = on; }

  update(dt, night) {
    if (!this.group.visible) return;
    this.beam.rotation.y += dt * 0.55;
    this.night = night;
    this.beamU.uK.value = night;
    this.beam.visible = night > 0.02;
    this.light.intensity = 900 * night;
  }
}

// ---------------------------------------------------------------- след
// Лента из последних точек пути, развёрнутая к камере; к хвосту тает
export class Trail {
  constructor(scene, color, width = 2, n = 48) {
    this.n = n;
    this.width = width;
    this.pts = [];
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(n * 2 * 3);
    this.alpha = new Float32Array(n * 2);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aA', new THREE.BufferAttribute(this.alpha, 1));
    const idx = [];
    for (let i = 0; i < n - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    geo.setIndex(idx);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: color.clone() }, uK: { value: 1 } },
      vertexShader: 'attribute float aA; varying float vA; void main() { vA = aA; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform vec3 uColor; uniform float uK; varying float vA; void main() { float a = vA * uK; if (a < 0.003) discard; gl_FragColor = vec4(uColor * a, a); }',
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.step = 0;
  }

  clear() { this.pts.length = 0; this.mesh.visible = false; }

  // Добавить точку не чаще, чем раз в minStep метров
  push(p, minStep = 4) {
    const last = this.pts[0];
    if (last && last.distanceToSquared(p) < minStep * minStep) { last.copy(p); return; }
    this.pts.unshift(p.clone());
    if (this.pts.length > this.n) this.pts.pop();
  }

  update(camPos) {
    const P = this.pts, n = P.length;
    this.mesh.visible = n > 1;
    if (n < 2) return;
    // Вершины — от первой точки: у Ксаррона мировые координаты в миллиардах метров, float32 их не удержит
    const off = this.mesh.position.copy(P[0]);
    for (let i = 0; i < this.n; i++) {
      const j = Math.min(i, n - 1), p = P[j], q = P[Math.min(j + 1, n - 1)], r = P[Math.max(j - 1, 0)];
      _a.subVectors(r, q);
      if (_a.lengthSq() < 1e-6) _a.set(0, 0, 1);
      _b.subVectors(camPos, p);
      _a.cross(_b).normalize();
      const k = i < n ? 1 - i / (n - 1) : 0, w = this.width * (0.3 + 0.7 * k);
      for (const s of [0, 1]) {
        const o = (i * 2 + s) * 3, sg = s ? 1 : -1;
        this.pos[o] = p.x - off.x + _a.x * w * sg;
        this.pos[o + 1] = p.y - off.y + _a.y * w * sg;
        this.pos[o + 2] = p.z - off.z + _a.z * w * sg;
        // У самого тела след только начинается: иначе вблизи он закрывает того, кто летит
        this.alpha[i * 2 + s] = i < n ? k * k * Math.min(1, i / 6) : 0;
      }
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.geometry.attributes.aA.needsUpdate = true;
  }
}
