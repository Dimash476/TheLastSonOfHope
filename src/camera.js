import * as THREE from 'three';
import { damp, smoothstep, clamp } from './utils.js';
import { BODIES } from './world/bodies.js';

const _b = new THREE.Vector3();
const _f = new THREE.Vector3();

// Камера от третьего лица: вращение мышью, отдаление и FOV растут со скоростью,
// не проваливается в здания, под землю и под поверхность Луны и планет.
export class ThirdPersonCamera {
  constructor(camera) {
    this.camera = camera;
    this.yaw = Math.PI;      // смотрим на +Z... затем повернём в сторону центра
    this.pitch = -0.15;
    this.sensitivity = 0.0022;
    this.dist = 6;
    this.lag = new THREE.Vector3();
    this.direction = new THREE.Vector3(0, 0, -1);
    this.fov = camera.fov;
    this.focus = null;   // { pos, k, rate, dist, side, lift, fov } — камера поворачивается к цели, подходит к плечу и сужает угол
    this.shot = null;    // { pos, look, fov } — готовый кадр кинематографической сцены
  }

  update(dt, input, player, city, shake) {
    this.yaw -= input.lookDX * this.sensitivity;
    this.pitch = clamp(this.pitch - input.lookDY * this.sensitivity, -1.45, 1.45);

    // Цель в кадре: поворачиваем к ней поверх мыши; k — насколько сильно
    const F = this.focus, fk = F ? F.k : 0;
    if (fk > 0.001) {
      _f.copy(F.pos).sub(player.pos);
      _f.y -= 1.5;
      const tYaw = Math.atan2(-_f.x, -_f.z), tPitch = Math.atan2(_f.y, Math.hypot(_f.x, _f.z));
      let dy = tYaw - this.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      const r = (1 - Math.exp(-(F.rate ?? 9) * dt)) * fk;
      this.yaw += dy * r;
      this.pitch = clamp(this.pitch + (tPitch - this.pitch) * r, -1.45, 1.45);
    }

    const cp = Math.cos(this.pitch);
    this.direction.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);

    const speed = player.vel.length();
    const k = smoothstep(40, 800, speed);
    const distGoal = 5.5 + k * 7;
    this.dist = damp(this.dist, F ? distGoal + ((F.dist ?? distGoal) - distGoal) * fk : distGoal, F && fk > 0.3 ? 8 : 3, dt);

    // Камера чуть отстаёт на большой скорости — ощущение рывка
    const lagTarget = player.vel.clone().multiplyScalar(-0.006);
    if (lagTarget.length() > 5) lagTarget.setLength(5);
    lagTarget.multiplyScalar(1 - fk);
    this.lag.x = damp(this.lag.x, lagTarget.x, 4, dt);
    this.lag.y = damp(this.lag.y, lagTarget.y, 4, dt);
    this.lag.z = damp(this.lag.z, lagTarget.z, 4, dt);

    const target = player.pos.clone().add(new THREE.Vector3(0, 1.5 + (F?.lift ?? 0) * fk, 0));
    const right = new THREE.Vector3(-this.direction.z, 0, this.direction.x).normalize();
    target.addScaledVector(right, 0.55 + ((F?.side ?? 0.55) - 0.55) * fk); // камера чуть через правое плечо

    // Не заходим внутрь зданий: идём от персонажа к камере и останавливаемся перед стеной
    let d = this.dist;
    const p = new THREE.Vector3();
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      const t = (i / steps) * this.dist;
      p.copy(target).addScaledVector(this.direction, -t);
      if (city.isInside(p)) { d = Math.max(0.8, t - 0.6); break; }
    }

    // К стене приближаемся сразу (чтобы не заглядывать внутрь), отдаляемся плавно
    this.curDist = this.curDist === undefined ? d : (d < this.curDist ? d : damp(this.curDist, d, 3, dt));
    const pos = target.clone().addScaledVector(this.direction, -this.curDist).add(this.lag);
    pos.y = Math.max(pos.y, 0.4);
    const map = player.world.planetMap;
    if (map.active) pos.y = Math.max(pos.y, map.heightAt(pos.x, pos.z) + 0.8);
    else {
      for (const b of BODIES) {
        _b.subVectors(pos, b.c);
        const l = _b.length();
        if (l < b.r + 0.4) pos.copy(b.c).addScaledVector(_b, (b.r + 0.4) / l);
      }
    }
    pos.add(shake);
    this.camera.position.copy(pos);
    this.camera.lookAt(pos.clone().add(this.direction));

    let fovTarget = 70 + 28 * k * (1 - 0.5 * fk);
    if (F?.fov) fovTarget += (F.fov - fovTarget) * fk;
    this.baseFov = damp(this.baseFov ?? 70, fovTarget, F?.fov ? 9 : 4, dt);
    // extraFov — толчки от ударов и «прицеливание» при зарядке
    this.camera.fov = this.baseFov + (this.extraFov || 0);
    // Кинематографический кадр: камера стоит там, где задумано
    if (this.shot) {
      this.camera.position.copy(this.shot.pos);
      this.camera.lookAt(this.shot.look);
      this.camera.fov = this.shot.fov ?? this.camera.fov;
    }
    this.camera.updateProjectionMatrix();
  }
}
