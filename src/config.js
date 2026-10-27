// Все игровые константы в одном месте — удобно подкручивать баланс.

export const MACH = 343; // скорость звука, м/с

export const PLAYER = {
  radius: 0.9,
  height: 1.85,

  flySpeed: 70,          // обычный полёт, м/с
  flyAccel: 3.5,         // насколько быстро скорость догоняет цель (1/с)
  boostSpeed: 900,       // предел сверхскорости в атмосфере, м/с (~Mach 2.6)
  spaceBoostSpeed: 9000, // предел сверхскорости в космосе, м/с
  boostAccel: 0.9,       // разгон в режиме сверхскорости
  hyperMul: 3,           // гиперскорость (Shift + E): во столько раз выше предел
  ultraMul: 8,           // третий уровень (Shift + Q)
  brakeAccel: 2.5,       // торможение без ввода (на малой скорости)
  flightBrake: 800,      // торможение силой полёта в атмосфере, м/с² (~80 g)
  spaceBrake: 300,       // торможение в космосе: базовое, м/с²
  spaceBrakeK: 2.2,      // + пропорционально скорости (1/с): с любой скорости — за ~2–3 с
  maxLatAccel: 980,      // предельная перегрузка в повороте, м/с² (~100 g)

  runSpeed: 14,
  sprintSpeed: 45,
  groundAccel: 10,

  ramSpeed: 110,         // выше этой скорости персонаж пробивает здания насквозь

  punchDuration: 0.38,
  punchHitTime: 0.12,
  punchReach: 3.2,
  punchDamage: 55,
  punchForce: 30,

  heavyMaxCharge: 1.6,   // сек до полной зарядки
  heavyBaseRadius: 10,
  heavyMaxRadius: 45,
  heavyDamage: 900,

  slamSpeed: 260,
  slamRadius: 40,
  slamDamage: 700,

  dashSpeed: 190,        // рывок
  dashTime: 0.18,
  dashCooldown: 0.45,

  grabRange: 8,          // захват
  throwSpeed: 140,
};

export const CITY = {
  grid: 48,            // кварталов по каждой оси (центр + пригород)
  block: 100,          // шаг сетки (квартал + дорога), м
  road: 16,            // ширина проезжей части
  sidewalk: 4,
  urbanHalf: 1400,     // до этого расстояния — город, дальше — пригород
  downtownRadius: 560,
  maxHeight: 270,
  segment: 12,         // высота «секции» здания (несколько этажей), м
  riverRow: 30,        // ряд кварталов, по которому течёт река
  seed: 1337,
};

export const DEBRIS = {
  max: 7000,
  gravity: 9.81 * 2.2, // чуть сильнее реальной — обломки выглядят тяжелее
  lifetime: 25,        // сек лежания до исчезновения
};

export const WORLD = {
  terrainSize: 44000,  // размер карты рельефа, м
  limit: 21000,        // граница полёта по горизонтали над Землёй, м
  waterLevel: -1.5,
  riverBed: -7,
  fogDensity: 0.00009,
  sunElevation: 28,
  sunAzimuth: 135,
};

export const SPACE = {
  atmosphere: 12000,   // высота, где небо начинает темнеть
  spaceAlt: 40000,     // выше — открытый космос
  earthRadius: 160000, // уменьшенная Земля, чтобы кривизна была видна
  moonRadius: 9000,
  moonPos: [60000, 190000, -120000],
  flightRadius: 1500000, // граница полётной зоны от центра карты, м
};

export const TRAFFIC = {
  cars: 140,
  people: 220,
  radius: 650,         // машины и люди живут в этом радиусе вокруг игрока
};
