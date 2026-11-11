import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { SPACE } from '../config.js';
import { BODIES, REGION, XARRON_ORIGIN } from './bodies.js';
import { NOISE_GLSL } from './space.js';

// Чёрная дыра за Солнцем и белая дыра у системы Ксаррона — два выхода одной кротовой норы.
// Рисуются не сеткой, а отдельным проходом сразу после космоса:
// для каждого пикселя луч идёт от камеры мимо дыры по настоящей траектории света
// (уравнение фотона у шварцшильдовской дыры), поэтому звёзды, Солнце и планеты за ней
// искривляются и раздваиваются в кольцо, тень и фотонное кольцо получаются сами,
// а дальняя половина аккреционного диска загибается дугой над и под тенью.
// Чёрная дыра вблизи притягивает героя (на Shift и выше можно вырваться); за горизонтом — сцена падения
// и выброс в космос над Землёй, а после победы над Ксаргом — переход к белой дыре (wormhole.js).
// Белая дыра — наоборот: на месте тени слепящий свет, газ диска течёт наружу, героя отталкивает.

// Дыра по настройкам: центр (pos — от origin), ось диска (раскрыт к toward на tilt градусов
// и повёрнут на небе на roll). Для HUD: метка с названием и расстоянием (r — откуда ставить метку: над тенью)
function makeHole(id, cfg, origin, toward, sys, white) {
  const C = new THREE.Vector3(...cfg.pos).add(origin), RS = cfg.rs;
  const to = toward.clone().sub(C).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const p = up.addScaledVector(to, -up.dot(to)).normalize();
  p.applyAxisAngle(to, THREE.MathUtils.degToRad(cfg.roll));
  const t = THREE.MathUtils.degToRad(cfg.tilt);
  const axis = p.multiplyScalar(Math.cos(t)).addScaledVector(to, Math.sin(t)).normalize();
  const e1 = new THREE.Vector3(1, 0, 0).addScaledVector(axis, -axis.x).normalize();
  return { id, name: cfg.name, c: C, r: RS * 3, rs: RS, axis, e1, disk: cfg.disk, sys, white, toward: to };
}
export const BLACK_HOLE = makeHole('blackhole', SPACE.blackHole, new THREE.Vector3(), new THREE.Vector3(), 'sol', false);
export const WHITE_HOLE = makeHole('whitehole', SPACE.xarron.whiteHole, XARRON_ORIGIN, XARRON_ORIGIN, 'xarron', true);

const MAX_BODIES = 10;
const BMAX = 40;     // в радиусах горизонта: зона, где дыра заметно искажает картинку

const LENS_F = /* glsl */`
  uniform sampler2D tDiffuse;
  uniform mat4 uInvProj, uProj;
  uniform mat3 uCamRot;
  uniform vec3 uBH, uN, uE1;
  uniform float uRin, uRout, uTime, uFall, uAspect;
  // Коллапс после победы: uUnst — сила (0…1), uPulse — вспышка волны, uWaveR/uWaveK — радиус (в rs) и сила
  // бегущей наружу гравитационной волны. uTunnel — полёт сквозь нору, uEmerge — выход из неё (1 → 0)
  uniform float uUnst, uPulse, uWaveR, uWaveK, uTunnel, uEmerge;
  uniform int uSteps, uNB;
  uniform vec4 uBodies[${MAX_BODIES}];
  varying vec2 vUv;
  ${NOISE_GLSL}

  const float BMAX = ${BMAX.toFixed(1)};

  // Повернуть направление v в плоскости (v, к центру) на угол a
  vec3 bend(vec3 v, vec3 x, float a) {
    vec3 toC = -x - dot(-x, v) * v;
    float l = length(toC);
    if (l < 1e-6 || a <= 0.0) return v;
    return normalize(v * cos(a) + toC / l * sin(a));
  }

  // Ближайшее попадание прямого луча в тело (t > 0), иначе -1
  float hitBody(vec3 ro, vec3 rd) {
    float best = -1.0;
    for (int i = 0; i < ${MAX_BODIES}; i++) {
      if (i >= uNB) break;
      vec3 oc = ro - uBodies[i].xyz;
      float b = dot(oc, rd), c = dot(oc, oc) - uBodies[i].w * uBodies[i].w;
      float h = b * b - c;
      if (h < 0.0) continue;
      float t = -b - sqrt(h);
      if (t > 0.0 && (best < 0.0 || t < best)) best = t;
    }
    return best;
  }

  // Цвет раскалённого газа по температуре (1 — у внутреннего края): тёмно-красный → оранжевый →
  // жёлто-белый → голубовато-белый
  vec3 heat(float t) {
  #ifdef WHITE
    // Белая дыра: газ холоднее на вид — фиолетовый с краю, голубой и белый к центру
    vec3 c = mix(vec3(0.35, 0.2, 0.7), vec3(0.45, 0.65, 1.2), smoothstep(0.15, 0.55, t));
    return mix(c, vec3(1.1, 1.12, 1.2), smoothstep(0.5, 1.1, t));
  #else
    vec3 c = mix(vec3(0.5, 0.05, 0.01), vec3(1.0, 0.36, 0.07), smoothstep(0.15, 0.5, t));
    c = mix(c, vec3(1.0, 0.78, 0.48), smoothstep(0.45, 0.95, t));
    c = mix(c, vec3(0.82, 0.9, 1.15), smoothstep(1.05, 1.8, t));
    return c;
  #endif
  }

  // Рябь от коллапса: сила отклонения света колеблется кольцами, бегущими наружу
  float ripple(float b) {
    return uUnst * 0.4 * sin(b * 0.75 - uTime * 3.4) * exp(-b / 30.0) + uWaveK * 1.4 * exp(-pow((b - uWaveR) / 3.0, 2.0));
  }

  // Звёзды там, куда луч уходит за край экрана
  vec3 stars(vec3 d) {
    vec3 q = d * 260.0, i = floor(q), f = fract(q) - 0.5;
    float h = hash3(i);
    float s = smoothstep(0.985, 1.0, h) * smoothstep(0.42, 0.0, length(f));
    return vec3(0.9, 0.93, 1.0) * s * 1.4;
  }

  // Излучение диска в точке p (луч идёт по v): rgb и непрозрачность
  vec4 disk(vec3 p, vec3 v) {
    float r = length(p);
    vec3 e2 = cross(uN, uE1);
    float ph = atan(dot(p, e2), dot(p, uE1));
    // Кеплерово вращение: внутренние слои быстрее. Узор крутится двумя фазами со сменой,
    // чтобы спирали не закручивались до бесконечности
    float om = sqrt(0.5 / (r * r * r)) * 3.2 * (1.0 + 1.5 * uUnst);
    const float P = 9.0;
    float t1 = fract(uTime / P), t2 = fract(uTime / P + 0.5);
    float w1 = 1.0 - abs(2.0 * t1 - 1.0);
    float a1 = ph - om * t1 * P, a2 = ph - om * t2 * P;
  #ifdef WHITE
    float lr = log(r) - uTime * 0.05;   // узор течёт наружу
  #else
    float lr = log(r);
  #endif
    float n1 = fbm3(vec3(cos(a1) * 4.5, sin(a1) * 4.5, lr * 6.0), 5);
    float n2 = fbm3(vec3(cos(a2) * 4.5, sin(a2) * 4.5, lr * 6.0) + 7.3, 5);
    // Крупные сгустки плазмы поверх тонких прожилок
    float clump = mix(fbm3(vec3(cos(a2) * 1.6, sin(a2) * 1.6, lr * 2.2) + 3.1, 3), fbm3(vec3(cos(a1) * 1.6, sin(a1) * 1.6, lr * 2.2) + 3.1, 3), w1);
    float n = mix(n2, n1, w1);
    // Кольцевые полосы и прожилки
    float bands = 0.78 + 0.22 * sin(lr * 22.0 + n * 7.0);
    float dens = clamp((n - 0.3) * 2.0 + (clump - 0.5) * 1.6, 0.0, 1.0) * bands;
    // Температура: пик чуть дальше внутреннего края, наружу остывает
    float x = uRin / r;
    float T = pow(x, 0.75) * pow(max(1.0 - sqrt(x), 0.0), 0.25) * 2.05;
    // Доплер: сторона, летящая к нам, ярче и голубее; у самой дыры свет краснеет
    float beta = min(0.75, sqrt(0.5 / max(r - 1.0, 0.2)));
    vec3 vel = normalize(cross(uN, p)) * beta;
    float gam = inversesqrt(1.0 - beta * beta);
    float dop = 1.0 / (gam * (1.0 - dot(vel, -v)));
    float g = dop * sqrt(max(1.0 - 1.0 / r, 0.0));
    float te = T * g;
    vec3 col = heat(te) * (0.2 + 1.5 * te * te) * pow(g, 3.0);
    col *= 0.55 + 0.9 * dens;
    // Коллапс: диск мерцает, наливается фиолетовым, с каждой волной вспыхивает багрово-лиловым,
    // по нему бегут светлые кольца волн
    col *= 1.0 + uUnst * (uPulse * 1.9 - 0.12) + uWaveK * 4.0 * exp(-pow((r - uWaveR) / 1.1, 2.0));
    col = mix(col, col * vec3(0.85, 0.78, 1.4), uUnst * 0.55);
    col = mix(col, col * vec3(1.6, 0.45, 1.5), uUnst * uPulse * 0.7);
    float edge = smoothstep(uRin * 0.97, uRin * 1.06, r) * (1.0 - smoothstep(uRout * 0.62, uRout, r));
    float a = clamp((0.35 + 0.75 * dens) * (0.45 + 0.6 * T), 0.0, 0.96) * edge;
    return vec4(col * 2.4 * edge, a);
  }

  void main() {
    vec4 base = texture2D(tDiffuse, vUv);
    // Направление луча — по ближней плоскости: у дальней (3·10⁹ м при ближней в десятки метров) w в float32
    // обнуляется и меняет знак, и низко над Землёй кадр через раз уходил в NaN — космос пропадал целиком
    vec4 vp = uInvProj * vec4(vUv * 2.0 - 1.0, -1.0, 1.0);
    vec3 rd = normalize(uCamRot * normalize(vp.xyz / vp.w));
    vec3 ro = -uBH;                       // камера относительно дыры, в радиусах горизонта
    float D = length(ro);
    float tc = -dot(ro, rd);              // где луч ближе всего к дыре
    float b = length(cross(ro, rd));      // прицельное расстояние
    // Искажение неба — кругом, как у настоящей дыры (решение автора: как в первой версии):
    // полная сила до 1,6 внешнего радиуса диска, на нет к 3,2 — с Земли звёзды не размазываются по всему небу
    float kf = 1.0 - smoothstep(uRout * 1.6, uRout * 3.2, b);

    vec3 col = vec3(0.0);
    float T = 1.0;
    vec3 dirF = rd;
    bool captured = false;
    vec3 farGlow = vec3(0.0);
  #ifdef WHITE
    // Издалека белая дыра — яркая звезда с ореолом: её видно и из космоса, и с планет системы.
    // Вблизи ореол уходит: там свой свет диска
    if (tc > 0.0) {
      float th = b / D, fk = smoothstep(BMAX, BMAX * 6.0, D);
      farGlow = vec3(0.75, 0.85, 1.1) * fk * (4.0 * exp(-th * th / 0.000016) + 0.9 * exp(-th / 0.02) + 0.15 * exp(-th / 0.08));
    }
  #endif
    if (b > uRout * 3.2 && D > BMAX && uFall <= 0.0 && uTunnel <= 0.0 && uEmerge <= 0.0) {
      if (farGlow.x > 1e-3) { float tq = hitBody(ro, rd); if (tq > 0.0 && tq < tc) farGlow = vec3(0.0); }
      gl_FragColor = base + vec4(farGlow, 0.0);
      return;
    }
    // Тело ближе дыры заслоняет её
    float tb = hitBody(ro, rd);
    if (tb > 0.0 && (tb < tc || tc < 0.0)) { gl_FragColor = base; return; }

    // Точный расчёт луча — только внутри сферы RB вокруг диска; снаружи свет отклоняется слабо,
    // и этот хвост (до входа и после выхода) считается по формуле слабого поля
    float RB = uRout * 1.3;
    // Снаружи сферы луч входит в неё, только если дыра впереди: иначе за спиной появлялась вторая
    if ((b < RB && tc > 0.0) || D < RB) {
      vec3 x = ro, v = rd;
      if (D > RB) {
        float L = sqrt(max(RB * RB - b * b, 0.0));
        x = ro + rd * (tc - L);
        v = bend(rd, x, (1.0 - L / RB) / max(b, 1e-3));
      }
      vec3 h = cross(x, v);
      float h2 = dot(h, h);
      float rmin = length(x);
      for (int i = 0; i < 200; i++) {
        if (i >= uSteps) break;
        float r = length(x);
        rmin = min(rmin, r);
        if (r < 1.0) { captured = true; break; }
        if (r > RB + 0.01 && dot(x, v) > 0.0) break;
        float dt = clamp(r * mix(0.05, 0.14, smoothstep(2.5, 8.0, r)), 0.012, 3.0);
        float r5 = r * r; r5 *= r5 * r;
        vec3 a = -1.5 * h2 * x / r5;
        vec3 xn = x + v * dt + 0.5 * a * dt * dt;
        float rn = length(xn), rn5 = rn * rn; rn5 *= rn5 * rn;
        v += 0.5 * (a - 1.5 * h2 * xn / rn5) * dt;
        // Пересечение плоскости диска
        float y0 = dot(x, uN), y1 = dot(xn, uN);
        if (y0 * y1 < 0.0) {
          vec3 p = mix(x, xn, y0 / (y0 - y1));
          float rp = length(p);
          if (rp > uRin * 0.95 && rp < uRout) {
            vec4 e = disk(p, normalize(v));
            col += T * e.rgb * e.a;
            T *= 1.0 - e.a;
          }
        }
        x = xn;
        if (T < 0.02) break;
      }
      // Остаток отклонения после выхода из сферы
      vec3 vh = normalize(v);
      if (!captured) {
        float bb = length(cross(x, vh)), sx = dot(x, vh);
        dirF = bend(vh, x, (1.0 - sx / length(x)) / max(bb, 1e-3) * (1.0 + ripple(b)));
      }
      // Сильное искажение неба — только около дыры: с Земли звёзды не размазываются по всему небу
      if (!captured) dirF = normalize(mix(rd, dirF, kf));
      // Фотонное кольцо: лучи с моментом у критического (3√3/2) обходят дыру у сферы фотонов
      // (только те, что к ней подошли: луч от дыры наружу с тем же моментом кольца не даёт)
  #ifdef WHITE
      vec3 ringC = vec3(0.9, 0.95, 1.1) * 2.6;
  #else
      vec3 ringC = vec3(1.0, 0.86, 0.68) * 1.8 * (1.0 + uUnst * 2.2 * uPulse);
  #endif
      if (!captured) col += T * ringC * exp(-pow((sqrt(h2) - 2.598) / 0.03, 2.0)) * (1.0 - smoothstep(1.8, 2.4, rmin));
      if (captured) {
  #ifdef WHITE
        // Вместо тени — слепящий свет, из глубины наружу течёт клубящийся поток
        vec3 pc = normalize(x);
        float fl = fbm3(pc * 3.0 + vec3(0.0, 0.0, -uTime * 0.5), 4);
        col += T * vec3(0.85, 0.92, 1.05) * (2.4 + 3.0 * fl);
  #else
        // Коллапс: у края тени — фиолетовая кайма, вспыхивает с каждой волной
        col += T * uUnst * (0.35 + uPulse) * vec3(0.55, 0.35, 1.1) * 1.6 * exp(-pow((sqrt(h2) - 2.45) / 0.12, 2.0));
  #endif
      }
    } else {
      // Слабое отклонение вдали от дыры, плавно на нет к 3,2 внешних радиуса диска.
      // Считается от камеры до бесконечности: если дыра позади, луч почти не гнётся
      dirF = bend(rd, ro, (1.0 - dot(ro, rd) / D) / b * kf * (1.0 + ripple(b)));
    }
  #ifdef WHITE
    // Ореол света вокруг белой дыры (дальше его раздует свечение)
    if (tc > 0.0) col += vec3(0.6, 0.72, 1.0) * 0.5 * exp(-max(b - 1.0, 0.0) / 3.5);
  #endif

    // Без кольца Эйнштейна (решение автора: «не нравится круг вокруг дыры»): небо за дырой не выворачивается
    // в круг из закрученных звёзд, а мягко увеличивается, как под линзой. Отклонение не больше 0,6 угла
    // от пикселя до дыры — картинка неба нигде не перехлёстывается через центр. Тень, диск, его дуги
    // и фотонное кольцо считаются выше и не меняются
    if (!captured) {
      vec3 hd = normalize(-ro);
      float th = atan(length(cross(rd, hd)), dot(rd, hd));
      float al = atan(length(cross(rd, dirF)), dot(rd, dirF));
      float cap = 0.6 * th;
      dirF = bend(rd, ro, al * cap / (al + cap + 1e-6));
    }

    vec3 bg = vec3(0.0);
    if (!captured) {
      vec3 vv = transpose(uCamRot) * dirF;
      vec4 cl = uProj * vec4(vv, 1.0);
      vec2 uv2 = cl.xy / cl.w * 0.5 + 0.5;
      float tb2 = hitBody(ro, dirF);
      bool fore = tb2 > 0.0 && tb2 < D;   // там на экране тело перед дырой — его не берём
      if (vv.z < 0.0 && all(greaterThan(uv2, vec2(0.0))) && all(lessThan(uv2, vec2(1.0))) && !fore)
        bg = texture2D(tDiffuse, uv2).rgb;
      else bg = stars(dirF);
    }
    vec3 outc = col + T * bg + farGlow;

    // Падение за горизонт: внешний мир сжимается в светлое кольцо и гаснет
    if (uFall > 0.0) {
      vec2 c = (vUv - 0.5) * vec2(uAspect, 1.0);
      float rr = length(c);
      float R = mix(0.75, 0.0, smoothstep(0.0, 1.0, uFall));
      vec2 suv = 0.5 + (vUv - 0.5) * (0.75 / max(R, 0.02)) * 0.35;
      vec3 inside = texture2D(tDiffuse, clamp(suv, 0.0, 1.0)).rgb * vec3(0.7, 0.9, 1.5) * (1.0 + 3.0 * uFall);
      float ang = atan(c.y, c.x);
      float streak = 0.6 + 0.4 * noise3(vec3(ang * 9.0, rr * 4.0 - uTime * 6.0, 2.0));
      vec3 ring = vec3(0.8, 0.9, 1.3) * exp(-pow((rr - R) / (0.012 + 0.03 * R), 2.0)) * (3.0 + 6.0 * uFall) * streak;
      vec3 fall = (rr < R ? inside : vec3(0.0)) + ring;
      outc = mix(outc, fall, smoothstep(0.0, 0.12, uFall));
    }

    // Сквозь нору: тьма, мимо несутся полосы света, впереди растёт белое пятно — выход
    if (uTunnel > 0.0) {
      vec2 c = (vUv - 0.5) * vec2(uAspect, 1.0);
      float rr = length(c), ang = atan(c.y, c.x);
      float z = 0.16 / max(rr, 0.015) + uTime * 7.0 * (1.0 + 2.0 * uTunnel);
      float st = noise3(vec3(cos(ang) * 7.0, sin(ang) * 7.0, z * 0.6));
      st = pow(st, 5.0) * 1.8 + pow(noise3(vec3(cos(ang) * 23.0, sin(ang) * 23.0, z * 1.4 + 5.0)), 7.0) * 1.4;
      vec3 tcol = mix(vec3(0.22, 0.1, 0.55), vec3(0.45, 0.65, 1.1), smoothstep(0.1, 0.6, rr)) * st * smoothstep(0.03, 0.35, rr);
      float hole = exp(-rr * rr / (0.0012 + 0.025 * uTunnel * uTunnel * uTunnel));
      tcol += vec3(1.0, 1.02, 1.1) * hole * (0.5 + 1.8 * uTunnel);
      float wk = smoothstep(0.82, 1.0, uTunnel);
      tcol = mix(tcol, vec3(2.4, 2.45, 2.6), wk * smoothstep(1.4 * wk + 0.02, 0.0, rr));
      outc = mix(outc, tcol, smoothstep(0.0, 0.08, uTunnel));
    }
    // Выход: из белой вспышки раскрывается кругом новый мир
    if (uEmerge > 0.0) {
      vec2 c = (vUv - 0.5) * vec2(uAspect, 1.0);
      float rr = length(c);
      float R = mix(1.3, 0.0, smoothstep(0.0, 1.0, uEmerge));
      vec3 em = rr < R ? outc : vec3(2.3, 2.38, 2.55) * (0.5 + 0.5 * uEmerge);
      em += vec3(0.8, 0.9, 1.3) * exp(-pow((rr - R) / (0.015 + 0.05 * R), 2.0)) * 4.0;
      outc = mix(outc, em, smoothstep(0.0, 0.1, uEmerge));
    }
    gl_FragColor = vec4(outc, 1.0);
  }`;


// Проход линзы: читает картинку космоса и рисует поверх неё дыру с искривлённым фоном
class LensPass extends Pass {
  constructor(H) {
    super();
    this.uniforms = {
      tDiffuse: { value: null },
      uInvProj: { value: new THREE.Matrix4() }, uProj: { value: new THREE.Matrix4() }, uCamRot: { value: new THREE.Matrix3() },
      uBH: { value: new THREE.Vector3() }, uN: { value: H.axis }, uE1: { value: H.e1 },
      uRin: { value: H.disk[0] }, uRout: { value: H.disk[1] }, uTime: { value: 0 }, uFall: { value: 0 }, uAspect: { value: 1 },
      uUnst: { value: 0 }, uPulse: { value: 0 }, uWaveR: { value: -100 }, uWaveK: { value: 0 }, uTunnel: { value: 0 }, uEmerge: { value: 0 },
      uSteps: { value: 160 }, uNB: { value: 0 },
      uBodies: { value: Array.from({ length: MAX_BODIES }, () => new THREE.Vector4()) },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      defines: H.white ? { WHITE: 1 } : {},
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: LENS_F,
      depthTest: false, depthWrite: false,
    });
    this.fsQuad = new FullScreenQuad(this.material);
  }

  render(renderer, writeBuffer, readBuffer) {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.fsQuad.render(renderer);
  }

  dispose() { this.material.dispose(); this.fsQuad.dispose(); }
}

const _rel = new THREE.Vector3(), _t = new THREE.Vector3(), _m = new THREE.Matrix4(), _f = new THREE.Vector3();

// H — BLACK_HOLE или WHITE_HOLE. Дыра живёт только в своей системе: в другой её проход выключен
export class BlackHole {
  constructor(scene, H = BLACK_HOLE) {
    this.H = H;
    this.world = null;
    this.pass = new LensPass(H);
    // Свет диска на героя: у дыры он тёплый силуэт на фоне тени, а не чёрное пятно на чёрном
    // (у белой — холодный и ярче)
    this.glow = new THREE.DirectionalLight(H.white ? 0xd8e6ff : 0xffb27a, 0);
    scene.add(this.glow, this.glow.target);
    this.fall = null;      // сцена падения: { t, flashed, gate } (gate — сквозь нору, а не выброс над Землёй)
    this.near = false;
    this.rumble = null;
    this.steps = 160;
    // Коллапс (ставит wormhole.js): unstable — цель 0…1, u — плавно к ней; waveT — сколько идёт текущая волна
    this.unstable = 0;
    this.u = 0;
    this.waveT = 99;
    this.emergeT = -1;     // выход из норы: вспышка раскрывается в мир
    this.prev = new THREE.Vector3();
    this.hasPrev = false;
    this.onCapture = null; // (дыра, герой) — что делать на горизонте; без него — обычное падение
    this.onThrough = null; // (дыра, герой, камера) — конец падения сквозь нору
  }

  // Волна коллапса: светлое кольцо бежит по диску, небо вокруг дрожит
  wave() { this.waveT = 0; }

  // Герой выходит из этой дыры (или её вспышкой — над Землёй)
  emerge() { this.emergeT = 0; this.pass.uniforms.uEmerge.value = 1; }

  get here() { return REGION === this.H.sys && !this.off; }

  // Выключена (в Симуляторе и Битве дыр пока нет): не видна, не тянет, метки нет
  get off() { return !!this._off; }
  set off(v) { this._off = v; this.H.hidden = v; }

  // Качество: шагов луча меньше на слабой графике
  setQuality(i) { this.steps = [160, 120, 80][i] ?? 120; }

  // Видна ли дыра (вместе с зоной искажения) в кадре
  inView(cam) {
    _rel.copy(this.H.c).sub(cam.position);
    const d = _rel.length(), R = this.H.rs * BMAX * 1.2;
    if (d < R) return true;
    _f.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const ang = Math.acos(THREE.MathUtils.clamp(_rel.dot(_f) / d, -1, 1));
    const half = THREE.MathUtils.degToRad(cam.fov * 0.5) * Math.hypot(1, cam.aspect);
    // У белой дыры — ещё и ореол вокруг (виден издалека)
    return ang < half + Math.asin(Math.min(1, R / d)) + (this.H.white ? 0.3 : 0);
  }

  // Направление на дыру (для «призрака» сквозь дневное небо)
  skyHole(camPos) { return _t.copy(this.H.c).sub(camPos).normalize(); }

  update(dt, camera, spaceCam, earthCenter, earthR) {
    const U = this.pass.uniforms, RS = this.H.rs;
    if (!this.here) { this.pass.enabled = false; return; }
    U.uTime.value += dt;
    // Коллапс: диск мерцает и «дышит» внутренним краем, по нему расходятся волны
    this.u += (this.unstable - this.u) * Math.min(1, dt * 0.35);
    this.waveT += dt;
    const wk = Math.max(0, 1 - this.waveT / 6), u = this.u, t = U.uTime.value;
    U.uUnst.value = u;
    // Пульс: вспышка с каждой волной и частое неровное дрожание между ними
    U.uPulse.value = u * (Math.exp(-this.waveT * 1.3) + 0.3 * (0.5 + 0.5 * Math.sin(t * 3.1) * Math.sin(t * 1.7 + 1)));
    U.uWaveR.value = this.H.disk[0] + this.waveT * 14;
    U.uWaveK.value = wk * wk * u;
    U.uRin.value = this.H.disk[0] * (1 - 0.3 * u * (0.5 + 0.5 * Math.sin(t * 2.2)));
    if (this.emergeT >= 0) {
      this.emergeT += dt;
      U.uEmerge.value = Math.max(0, 1 - this.emergeT / 1.8);
      if (this.emergeT > 1.8) this.emergeT = -1;
    }
    U.uSteps.value = this.steps;
    U.uAspect.value = camera.aspect;
    spaceCam.updateMatrixWorld();
    U.uInvProj.value.copy(spaceCam.projectionMatrixInverse);
    U.uProj.value.copy(spaceCam.projectionMatrix);
    U.uCamRot.value.setFromMatrix4(_m.extractRotation(spaceCam.matrixWorld));
    U.uBH.value.copy(this.H.c).sub(spaceCam.position).divideScalar(RS);
    // Тела, которые могут заслонить дыру (в радиусах горизонта, относительно камеры)
    let n = 0;
    const put = (c, r) => { if (n < MAX_BODIES) U.uBodies.value[n++].set((c.x - spaceCam.position.x) / RS, (c.y - spaceCam.position.y) / RS, (c.z - spaceCam.position.z) / RS, r / RS); };
    if (this.H.sys === 'sol') put(earthCenter, earthR);
    for (const b of BODIES) put(b.c, b.r);
    U.uNB.value = n;
    this.pass.enabled = this.fall !== null || this.emergeT >= 0 || this.inView(spaceCam);
  }

  // Притяжение (у белой дыры — отталкивание), падение и выброс. Вызывается до хода героя
  tick(dt, player, camRig) {
    const W = this.world, U = this.pass.uniforms, H = this.H, RS = H.rs;
    if (!this.here || W.planetMap?.active) { this.glow.intensity = 0; this.setRumble(0); this.hasPrev = false; return; }
    // Ближе всего к центру за прошлый кадр — по всему пути: на W + Shift + R за кадр пролетаем ~1700 км
    // и проскочили бы горизонт насквозь
    let rPath = Infinity;
    if (this.hasPrev && !player.driven) {
      _f.subVectors(player.pos, this.prev);
      const L2 = _f.lengthSq();
      if (L2 > 1 && L2 < 1e18) {
        const k = THREE.MathUtils.clamp(_t.subVectors(H.c, this.prev).dot(_f) / L2, 0, 1);
        _t.copy(this.prev).addScaledVector(_f, k);
        rPath = _t.distanceTo(H.c) / RS;
        if (rPath < 1.25 && !H.white) player.pos.copy(_t);
      }
    }
    this.prev.copy(player.pos);
    this.hasPrev = true;
    _rel.copy(H.c).sub(player.pos);
    const d = _rel.length(), r = d / RS;
    this.glow.intensity = this.fall ? 0 : (H.white ? 6 : 4) * (1 - THREE.MathUtils.smoothstep(r, 4, 70));
    this.glow.position.copy(player.pos).addScaledVector(_rel, 50 / d);
    this.glow.target.position.copy(player.pos);
    if (this.fall) return this.tickFall(dt, player, camRig);
    this.setRumble(THREE.MathUtils.clamp(1 - (r - 2) / 40, 0, 1));
    const near = r < 30;
    if (near && !this.near) W.toast?.(H.name.toUpperCase(), 2.2);
    this.near = near;
    if (player.driven) return;
    // Белая дыра никого не впускает: долетел до неё (хоть на W + Shift + R) — отбрасывает назад вспышкой
    if (H.white) {
      if (r < 1.6 || rPath < 1.6) { this.repel(player, rPath < r ? _t : player.pos); return; }
    } else if ((r < 1.25 || rPath < 1.25) && this.capture(player)) return;
    if (r > 40) return;
    // Тянет к центру и закручивает вдоль диска; на Shift и выше всегда можно вырваться.
    // Земля в ~115 rs — до неё тяга не достаёт (сходит на нет к 40 rs).
    // Белая дыра так же сильно отталкивает: пробиться к ней можно только на Shift и выше
    let vp = Math.min(400000, 20000 * (10 / r) ** 2) * (1 - THREE.MathUtils.smoothstep(r, 25, 40));
    const speed = player.vel.length();
    if (player.boosting) vp = Math.min(vp, 0.5 * speed);
    _rel.divideScalar(d);
    _t.crossVectors(H.axis, _rel).normalize();
    player.pos.addScaledVector(_rel, H.white ? -vp * dt : vp * dt).addScaledVector(_t, vp * 0.35 * dt);
    this.prev.copy(player.pos);
    U.uFall.value = 0;
  }

  // Герой у горизонта чёрной дыры: решает нора (wormhole.js); без неё — выброс над Землёй
  capture(player) {
    if (this.onCapture) return this.onCapture(this, player);
    this.startFall(player);
    return true;
  }

  // Белая дыра отбрасывает: назад, туда, откуда герой подлетел (p — ближайшая к центру точка пути)
  repel(player, p) {
    const W = this.world, H = this.H, sp = player.vel.length();
    _f.subVectors(p, H.c);
    if (_f.lengthSq() < 1) _f.copy(player.vel).negate();
    if (_f.lengthSq() < 1) _f.copy(H.toward);
    _f.normalize();
    player.pos.copy(H.c).addScaledVector(_f, H.rs * 1.7);
    player.vel.copy(_f).multiplyScalar(THREE.MathUtils.clamp(sp * 0.3, 20000, 400000));
    this.prev.copy(player.pos);
    // Ломится снова и снова (W зажата) — вспышка и удар не чаще раза в секунду
    const now = performance.now();
    if (now - (this.repelAt || 0) < 1000) return;
    this.repelAt = now;
    W.effects.screenFlash = 1.4;
    W.audio?.boom(1.3);
  }

  startFall(player, gate = false) {
    const W = this.world, H = this.H;
    this.fall = { t: 0, flashed: false, gate };
    player.vel.set(0, 0, 0);
    this.driven = (dt) => {
      // Героя медленно затягивает в центр, после вспышки он уже над Землёй и висит на месте
      player.vel.set(0, 0, 0);
      if (this.fall?.flashed) return;
      _rel.copy(H.c).sub(player.pos);
      player.pos.addScaledVector(_rel, 0.25 * dt);
    };
    player.driven = this.driven;
    const A = W.audio;
    if (A?.ctx) {
      A.tone({ dur: 3.2, from: 90, to: 18, gain: 0.5 });
      A.noiseBurst({ dur: 3.0, freq: 300, sweepTo: 40, gain: 0.45, attack: 1.2, brown: true });
    }
  }

  tickFall(dt, player, camRig) {
    const W = this.world, F = this.fall, U = this.pass.uniforms;
    F.t += dt;
    U.uFall.value = Math.min(1, (F.t / 2.6) ** 1.6);
    if (F.gate) {
      // Сквозь нору: мир сжался в кольцо, дальше ~3 с туннеля, впереди растёт белый выход
      U.uTunnel.value = THREE.MathUtils.clamp((F.t - 2.4) / 3.2, 0, 1);
      if (F.t > 5.6) {
        U.uFall.value = 0; U.uTunnel.value = 0;
        if (player.driven === this.driven) player.driven = null;
        this.fall = null;
        this.near = false;
        this.hasPrev = false;
        this.onThrough?.(this, player, camRig);
      }
      return;
    }
    if (F.t > 2.6 && !F.flashed) {
      F.flashed = true;
      W.effects.screenFlash = 1.4;
      W.audio?.boom(1.2);
      // Выброс: в космос над Землёй, лицом к планете
      player.pos.set(0, 110000, 60000);
      player.vel.set(0, 0, 0);
      player.grounded = false; player.falling = false;   // висит в полёте, а не падает
      if (camRig) { camRig.yaw = 0; camRig.pitch = -0.7; }
    }
    if (F.t > 2.75) {
      U.uFall.value = 0;
      if (player.driven === this.driven) player.driven = null;
      this.fall = null;
      this.near = false;
    }
  }

  // Низкий гул у дыры: тон и шум, громче с приближением
  setRumble(k) {
    const A = this.world.audio;
    if (!A?.ctx || !A.master) return;
    if (!this.rumble) {
      if (k <= 0.001) return;
      const ctx = A.ctx;
      const g = ctx.createGain(); g.gain.value = 0;
      const o1 = ctx.createOscillator(); o1.type = 'sine'; o1.frequency.value = 31;
      const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = 46.5;
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.13;
      const lfoG = ctx.createGain(); lfoG.gain.value = 4;
      lfo.connect(lfoG).connect(o2.frequency);
      const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), ch = buf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < ch.length; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; ch[i] = last * 3.5; }
      const nz = ctx.createBufferSource(); nz.buffer = buf; nz.loop = true;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 160;
      const ng = ctx.createGain(); ng.gain.value = 0.6;
      o1.connect(g); o2.connect(g); nz.connect(lp).connect(ng).connect(g);
      g.connect(A.master);
      o1.start(); o2.start(); lfo.start(); nz.start();
      this.rumble = { g, lp };
    }
    const t = A.ctx.currentTime;
    this.rumble.g.gain.setTargetAtTime(0.32 * k * k, t, 0.4);
    this.rumble.lp.frequency.setTargetAtTime(120 + 260 * k, t, 0.4);
  }

  reset() {
    const U = this.pass.uniforms;
    U.uFall.value = 0; U.uTunnel.value = 0; U.uEmerge.value = 0;
    this.emergeT = -1;
    this.hasPrev = false;
    this.fall = null;
    this.glow.intensity = 0;
    this.setRumble(0);
  }
}
