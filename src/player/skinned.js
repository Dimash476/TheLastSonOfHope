import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Человеческая модель со скелетом Mixamo.
// Позы по-прежнему считает процедурный «риг» HeroModel, а здесь его повороты
// переносятся на кости модели (ретаргетинг). Поэтому все анимации — полёт, удары,
// бег, захват — работают на новом теле без изменений.
// Загрузчик универсальный: подходит любая модель с костями Mixamo
// (имена вида «mixamorig:LeftArm» или «mixamorigLeftArm_10»).

const MAP = {
  Hips: 'pelvis', Spine: 'spine', Spine2: 'chest', Neck: 'neck',
  LeftArm: 'shL', LeftForeArm: 'elL', RightArm: 'shR', RightForeArm: 'elR',
  LeftUpLeg: 'hipL', LeftLeg: 'knL', LeftFoot: 'ankL',
  RightUpLeg: 'hipR', RightLeg: 'knR', RightFoot: 'ankR',
};
// Для этих костей риг считает «ноль» — конечность опущена вниз.
// Поправку вычисляем из реальной позы модели (T-поза, A-поза — неважно).
const LIMBS = [
  ['LeftArm', 'LeftForeArm'], ['LeftForeArm', 'LeftHand'],
  ['RightArm', 'RightForeArm'], ['RightForeArm', 'RightHand'],
  ['LeftUpLeg', 'LeftLeg'], ['LeftLeg', 'LeftFoot'],
  ['RightUpLeg', 'RightLeg'], ['RightLeg', 'RightFoot'],
];

const _q = new THREE.Quaternion();
const _inv = new THREE.Quaternion();
const DOWN = new THREE.Vector3(0, -1, 0);

export const boneShortName = (n) => n.replace(/^mixamorig:?/, '').replace(/_\d+$/, '');

export function loadSkinnedHero(url, opts) {
  return new GLTFLoader().loadAsync(url).then((gltf) => new SkinnedHero(gltf, opts));
}

export class SkinnedHero {
  // opts: { height, material(mesh) → Material, chestScale }
  constructor(gltf, opts = {}) {
    this.scene = gltf.scene;
    const s = this.scene;

    this.meshes = [];
    s.traverse((o) => { if (o.isSkinnedMesh) this.meshes.push(o); });
    // Ставим скелет в исходную (связанную) позу — файл может хранить другую позу
    for (const m of this.meshes) m.skeleton.pose();
    s.updateMatrixWorld(true);

    // Рост и ступни на земле
    const box = new THREE.Box3();
    for (const m of this.meshes) {
      m.computeBoundingBox();
      box.union(m.boundingBox.clone().applyMatrix4(m.matrixWorld));
    }
    const k = (opts.height || 1.85) / (box.max.y - box.min.y);
    s.scale.multiplyScalar(k);
    s.position.y -= box.min.y * k;
    s.updateMatrixWorld(true);

    // Обратные матрицы сеток в исходной позе (для перевода костей в координаты сетки)
    this.meshInv = new Map(this.meshes.map((m) => [m, m.matrixWorld.clone().invert()]));
    for (const m of this.meshes) {
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      if (opts.material) m.material = opts.material(m, this) || m.material;
    }

    // Кости в порядке иерархии + исходная ориентация и положение в системе модели
    this.bones = [];
    this.byName = {};
    const entryOf = new Map();
    s.traverse((o) => {
      if (!o.isBone) return;
      const short = boneShortName(o.name);
      const e = {
        bone: o, short, joint: MAP[short] || null, rest: null,
        bindWorld: o.getWorldQuaternion(new THREE.Quaternion()),
        bindPos: o.getWorldPosition(new THREE.Vector3()),
        parent: entryOf.get(o.parent) || null,
        target: new THREE.Quaternion(),
      };
      entryOf.set(o, e);
      this.bones.push(e);
      if (!this.byName[short]) this.byName[short] = e;
    });
    // Ориентация того, что стоит над самой верхней костью (Armature и т.п.)
    const top = this.bones[0].bone.parent;
    this.topParentWorld = top.getWorldQuaternion(new THREE.Quaternion());
    for (const e of this.bones) if (!e.parent) e.parentWorld = e.bone.parent.getWorldQuaternion(new THREE.Quaternion());

    // Поправки конечностей: поворот из направления в исходной позе в «вниз»
    for (const [a, b] of LIMBS) {
      const A = this.byName[a], B = this.byName[b];
      if (!A || !B) continue;
      const dir = B.bindPos.clone().sub(A.bindPos).normalize();
      A.rest = new THREE.Quaternion().setFromUnitVectors(dir, DOWN);
    }

    const hips = this.byName.Hips.bone;
    this.hipsBindPos = hips.position.clone();
    this.hipsParentScale = hips.parent.getWorldScale(new THREE.Vector3()).y;

    // Чуть шире грудь и плечи (дочерние кости компенсируем)
    const cs = opts.chestScale || 1;
    if (cs !== 1 && this.byName.Spine2) {
      this.byName.Spine2.bone.scale.set(cs, 1, cs * 0.96);
      for (const n of ['Neck', 'LeftShoulder', 'RightShoulder']) this.byName[n]?.bone.scale.set(1 / cs, 1, 1 / (cs * 0.96));
    }
  }

  bone(name) { return this.byName[name].bone; }

  // Положение кости в исходной позе в локальных координатах сетки (для «раскраски» костюма)
  bindLocal(name, mesh) {
    return this.byName[name].bindPos.clone().applyMatrix4(this.meshInv.get(mesh));
  }

  // Прикрепить объект к кости. pos/quat заданы в метрах в системе модели (в исходной позе),
  // дальше объект двигается вместе с костью.
  attach(boneName, obj, pos, quat = new THREE.Quaternion()) {
    const bone = this.bone(boneName);
    this.scene.updateMatrixWorld(true);
    const rootInv = this.scene.parent ? new THREE.Matrix4().copy(this.scene.parent.matrixWorld).invert() : new THREE.Matrix4();
    const boneM = bone.matrixWorld.clone().premultiply(rootInv);
    const m = new THREE.Matrix4().compose(pos, quat, new THREE.Vector3(1, 1, 1));
    obj.matrixAutoUpdate = false;
    obj.matrix.copy(boneM.invert().multiply(m));
    obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
    bone.add(obj);
  }

  // Ориентация сустава рига относительно его корня
  rigWorld(rig, name, out) {
    out.identity();
    let o = rig.j[name];
    while (o && o !== rig.group) { out.premultiply(o.quaternion); o = o.parent; }
    return out;
  }

  sync(rig) {
    for (const b of this.bones) {
      const parentTarget = b.parent ? b.parent.target : b.parentWorld;
      if (b.joint) {
        // цель = поворот сустава рига · поправка позы · исходная ориентация кости
        this.rigWorld(rig, b.joint, b.target);
        if (b.rest) b.target.multiply(b.rest);
        b.target.multiply(b.bindWorld);
      } else {
        // кость без сустава следует за родителем, сохраняя исходное положение
        const parentBind = b.parent ? b.parent.bindWorld : b.parentWorld;
        b.target.copy(parentTarget).multiply(_inv.copy(parentBind).invert()).multiply(b.bindWorld);
      }
      // локальный поворот = (цель родителя)⁻¹ · цель
      _q.copy(parentTarget).invert();
      b.bone.quaternion.copy(_q.multiply(b.target));
    }
    // Покачивание таза по высоте
    const bob = rig.j.pelvis.position.y - 1.0;
    this.byName.Hips.bone.position.y = this.hipsBindPos.y + bob / this.hipsParentScale;
  }
}
