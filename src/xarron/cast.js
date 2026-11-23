import * as THREE from 'three';
import { CX, CZ, SITES, RIFT } from './tarven.js';

// Лица Тарвэна. У каждого — место в городе, одежда, портрет для окна разговора и свои темы.
// Разговор — дерево: узел говорит текст и даёт ответы; ответ, по которому уже прошли, второй раз
// не предлагается. S — что знает игра: won (Ксарг побеждён), veyr (башня дома Вэйр горит),
// met (с кем уже говорил), facts (что уже узнал: тогда открываются новые темы у других).

const polar = (r, deg) => [CX + r * Math.cos(deg * Math.PI / 180), CZ + r * Math.sin(deg * Math.PI / 180)];
const faceTo = (x, z, tx, tz) => Math.atan2(tx - x, tz - z);

const STAFF = new THREE.CylinderGeometry(0.016, 0.022, 1.9, 8).translate(0, -0.75, 0.06);
const TIP = new THREE.OctahedronGeometry(0.05).translate(0, 0.24, 0.06);
const HALO = new THREE.TorusGeometry(0.2, 0.007, 6, 48);
const CRYSTAL = new THREE.OctahedronGeometry(0.065).scale(0.7, 1.3, 0.7).translate(0, -0.69, 0.09);
const SPIKE = (s) => new THREE.ConeGeometry(0.045, 0.2, 6).rotateZ(-s * 0.5).translate(s * 0.27, 1.56, 0);

export const CAST = [
  {
    id: 'lissan', name: 'Кадет Лиссан', title: 'кадет третьего круга', color: '#7cc8ff',
    spot: (c) => { const [gx, gz] = SITES.gardens, x = gx + 7, z = gz + 39; return [x, c.hC, z, faceTo(x, z, CX, CZ)]; },
    look: { h: 0.98, skin: [0.85, 0.66, 0.52], hairC: [0.12, 0.07, 0.04], hair: 'short', garb: [0.6, 0.64, 0.7], legs: [0.3, 0.32, 0.36], sigil: [0.4, 1.3, 2.2] },
    face: { bg: ['#1b2c44', '#0b1220'], glow: '#7cc8ff', skin: '#d9a888', hair: '#2a1a10', style: 'crop', eye: '#4a6a8a', cloth: '#9aa4b2', cloth2: '#6c7686', collar: 'cadet', mood: 'eager', age: 0, w: 0.94 },
  },
  {
    id: 'aumara', name: 'Регент Аумара', title: 'глава Совета', color: '#d8e6ff',
    spot: (c) => { const [x, z] = polar(236, 200); return [x, c.hC, z, faceTo(CX, CZ, x, z)]; },
    look: {
      h: 1.07, skin: [0.88, 0.74, 0.66], hairC: [0.86, 0.86, 0.9], hair: 'long', garb: [0.9, 0.9, 0.93], robe: [0.9, 0.9, 0.93], mantle: [0.14, 0.16, 0.26],
      sigil: [1.8, 1.8, 2.0],
      extras: [
        { geo: STAFF, color: [0.75, 0.78, 0.85], arm: 'R' }, { geo: TIP, color: [0.6, 0.85, 1], glow: [0.8, 1.6, 2.4], arm: 'R' },
        { geo: HALO, color: [0.8, 0.85, 1], glow: [0.7, 0.9, 1.4], at: [0, 1.74, -0.13] },
      ],
    },
    face: { bg: ['#26304a', '#0c0f1a'], glow: '#cfe0ff', skin: '#e2c2ae', hair: '#e8e8ee', style: 'long', eye: '#7a8aa0', cloth: '#e6e8f0', cloth2: '#232a44', collar: 'high', mood: 'stern', age: 0.85, halo: true, w: 0.9 },
  },
  {
    id: 'orven', name: 'Мастер Орвен', title: 'хранитель Архива Домов', color: '#9fe6d2',
    spot: (c) => { const [x, z] = polar(556, 190); return [x, c.hC, z, faceTo(x, z, CX, CZ)]; },
    look: {
      h: 1.0, skin: [0.8, 0.62, 0.5], hairC: [0.9, 0.9, 0.9], hair: 'tail', beard: true, garb: [0.22, 0.27, 0.27], robe: [0.18, 0.22, 0.22], mantle: [0.3, 0.33, 0.32],
      sigil: [0.3, 1.8, 1.4], extras: [{ geo: CRYSTAL, color: [0.5, 1, 0.9], glow: [0.4, 1.6, 1.4], arm: 'L' }],
    },
    face: { bg: ['#1a3430', '#08120f'], glow: '#7fe8cf', skin: '#c99a7c', hair: '#e4e4e4', style: 'bald', beard: 'full', eye: '#5a7a6a', cloth: '#3a4646', cloth2: '#283232', collar: 'high', mood: 'warm', age: 1, w: 1.0 },
  },
  {
    id: 'sairen', name: 'Сайрен', title: 'капитан гвардии, дочь Ксарга', color: '#ff8a70',
    spot: (c) => { const [ax, az] = SITES.arena, x = ax - 6, z = az; return [x, c.hC + 1.2, z, faceTo(x, z, CX, CZ)]; },
    look: {
      type: 'guard', h: 1.04, skin: [0.86, 0.7, 0.6], hairC: [0.03, 0.03, 0.03], hair: 'tail', garb: [0.03, 0.03, 0.035], armor: [0.05, 0.05, 0.06],
      mantle: [0.3, 0.03, 0.03], legs: [0.03, 0.03, 0.035], sigil: [2.2, 0.35, 0.15],
    },
    face: { bg: ['#3a1414', '#110606'], glow: '#ff6a4a', skin: '#dcb29a', hair: '#0c0a0a', style: 'tail', eye: '#5a3a2a', cloth: '#1a1a1e', cloth2: '#5a0e0c', collar: 'armor', mood: 'stern', age: 0.1, w: 0.9 },
  },
  {
    id: 'korvas', name: 'Адмирал Корвас', title: 'флот и верфи', color: '#ffb25a',
    spot: (c) => { const [px, pz] = SITES.port, x = px + 104, z = pz + 8; return [x, c.hC, z, faceTo(x, z, CX, CZ)]; },
    look: {
      type: 'guard', h: 1.1, skin: [0.6, 0.44, 0.34], hairC: [0.3, 0.3, 0.32], hair: 'none', beard: true, garb: [0.04, 0.04, 0.05], armor: [0.09, 0.08, 0.07],
      mantle: [0.08, 0.07, 0.07], legs: [0.04, 0.04, 0.05], sigil: [2.0, 1.0, 0.3],
      extras: [{ geo: SPIKE(1), color: [0.2, 0.17, 0.14], at: [0, 0, 0] }, { geo: SPIKE(-1), color: [0.2, 0.17, 0.14], at: [0, 0, 0] }],
    },
    face: { bg: ['#3a2610', '#120b04'], glow: '#ffb25a', skin: '#9a7058', hair: '#4a4a4e', style: 'bald', beard: 'short', eye: '#6a5030', cloth: '#26221e', cloth2: '#5a4428', collar: 'armor', mood: 'smirk', age: 0.55, scar: true, w: 1.08 },
  },
  {
    id: 'daerra', name: 'Дэрра', title: 'голос Разлома', color: '#e8b070',
    spot: (c) => { const [x, z] = c.market; return [x + 4, c.hC - RIFT.depth, z, faceTo(x, z, ...SITES.citadel)]; },
    look: { type: 'wingless', h: 0.97, skin: [0.62, 0.45, 0.34], hairC: [0.14, 0.08, 0.05], hair: 'long', garb: [0.32, 0.26, 0.2], mantle: [0.4, 0.32, 0.22], legs: [0.22, 0.2, 0.18] },
    face: { bg: ['#3a2a18', '#120c06'], glow: '#e8a050', skin: '#a8785a', hair: '#2a160c', style: 'hood', eye: '#3a2a1a', cloth: '#5a4630', cloth2: '#6e5838', collar: 'hood', mood: 'smirk', age: 0.35, w: 0.95 },
  },
];

// Внешность во плоти (persona.js): цвета в линейном пространстве; height — рост, м; age 0..1;
// style — причёска (crop, long, tail, fringe — «венчик», bald); pose — как стоит; props — вещи
const IRIS = {
  grey: ['vec3(0.2, 0.26, 0.34)', 'vec3(0.36, 0.42, 0.5)'], blue: ['vec3(0.1, 0.2, 0.32)', 'vec3(0.24, 0.38, 0.52)'],
  green: ['vec3(0.13, 0.22, 0.15)', 'vec3(0.28, 0.38, 0.27)'], brown: ['vec3(0.1, 0.05, 0.025)', 'vec3(0.22, 0.12, 0.06)'],
  amber: ['vec3(0.26, 0.14, 0.04)', 'vec3(0.42, 0.28, 0.1)'],
};
const BODIES = {
  lissan: {
    sex: 'm', height: 1.8, age: 0, skin: [0.45, 0.29, 0.2], hair: [0.05, 0.03, 0.015], style: 'crop', hairFront: 0.74, iris: IRIS.blue,
    cloth: [0.3, 0.34, 0.4], cloth2: [0.09, 0.11, 0.15], trim: [0.55, 0.58, 0.63], legs: [0.08, 0.09, 0.11], boot: [0.02, 0.02, 0.025], glove: [0.04, 0.045, 0.05],
    sigil: [0.4, 1.3, 2.2], pose: 'attention',
  },
  aumara: {
    sex: 'f', height: 1.8, age: 0.85, skin: [0.5, 0.36, 0.29], hair: [0.6, 0.61, 0.66], brow: [0.32, 0.32, 0.35], style: 'long', hairFront: 0.7, hairLen: 0.46,
    iris: IRIS.grey, lips: 0.3, cloth: [0.78, 0.79, 0.84], cloth2: [0.07, 0.09, 0.17], trim: [0.75, 0.77, 0.82], legs: [0.78, 0.79, 0.84], boot: [0.55, 0.57, 0.62],
    glove: [0.78, 0.79, 0.84], gown: [0.72, 0.73, 0.79], gownR: 0.37, cape: 0x1a2038, capeSheen: [0.25, 0.3, 0.5], sigil: [1.8, 1.9, 2.2],
    props: ['staff', 'halo'], pose: 'staff',
  },
  orven: {
    sex: 'm', height: 1.76, age: 1, skin: [0.4, 0.26, 0.18], hair: [0.55, 0.55, 0.56], style: 'fringe', beard: 'full', iris: IRIS.green,
    cloth: [0.05, 0.09, 0.09], cloth2: [0.025, 0.045, 0.045], trim: [0.45, 0.58, 0.52], legs: [0.04, 0.06, 0.06], boot: [0.03, 0.03, 0.03], glove: [0.4, 0.26, 0.18],
    gown: [0.045, 0.08, 0.08], gownR: 0.33, cape: 0x28302e, capeSheen: [0.15, 0.22, 0.2], sigil: [0.3, 1.8, 1.4], props: ['crystal'], pose: 'crystal',
  },
  sairen: {
    sex: 'f', height: 1.79, age: 0.1, skin: [0.48, 0.32, 0.24], hair: [0.012, 0.01, 0.01], style: 'long', hairLen: 0.3, hairFront: 0.68, iris: IRIS.brown, lips: 0.55,
    cloth: [0.025, 0.025, 0.03], cloth2: [0.14, 0.015, 0.015], trim: [0.5, 0.12, 0.06], armor: [0.035, 0.035, 0.045], legs: [0.02, 0.02, 0.025],
    boot: [0.015, 0.015, 0.018], glove: [0.02, 0.02, 0.022], sigil: [2.2, 0.35, 0.15], cape: 0x5a0c0a, capeSheen: [0.5, 0.1, 0.08], pose: 'hips',
  },
  korvas: {
    sex: 'm', height: 1.95, age: 0.55, skin: [0.24, 0.14, 0.09], hair: [0.07, 0.07, 0.075], style: 'bald', beard: 'short', scar: true, iris: IRIS.amber,
    cloth: [0.03, 0.03, 0.035], cloth2: [0.16, 0.1, 0.04], trim: [0.55, 0.38, 0.15], armor: [0.09, 0.075, 0.06], legs: [0.025, 0.025, 0.03],
    boot: [0.02, 0.02, 0.02], glove: [0.03, 0.025, 0.02], sigil: [2.0, 1.0, 0.3], cape: 0x141110, capeSheen: [0.2, 0.14, 0.08], props: ['pauldron'], pose: 'hips',
  },
  daerra: {
    sex: 'f', height: 1.72, age: 0.35, skin: [0.3, 0.18, 0.11], hair: [0.04, 0.02, 0.01], style: 'long', hairLen: 0.34, hairFront: 0.69, iris: IRIS.brown, lips: 0.2,
    cloth: [0.12, 0.085, 0.055], cloth2: [0.07, 0.05, 0.035], trim: [0.3, 0.22, 0.12], legs: [0.06, 0.05, 0.04], boot: [0.05, 0.035, 0.025], glove: [0.3, 0.18, 0.11],
    gown: [0.1, 0.075, 0.05], gownR: 0.3, cape: 0x3a2a1a, capeSheen: [0.22, 0.16, 0.1], pose: 'arms',
  },
};
for (const c of CAST) c.body = BODIES[c.id];

// Мать героя — только портрет (запись в Архиве)
export const ILIRA = {
  id: 'ilira', name: 'Илира · запись Архива', color: '#ffd8a0',
  face: { bg: ['#3a2c18', '#0e0a06'], glow: '#ffd48a', skin: '#e0b496', hair: '#1a100a', style: 'long', eye: '#3a5060', cloth: '#e8e2d6', cloth2: '#7a1c18', collar: 'high', mood: 'warm', age: 0.1, holo: true, w: 0.92 },
};

// ---------------------------------------------------------------- разговоры
const T = (won, a, b) => (won ? a : b);
export const TALKS = {
  lissan: {
    start: (S) => (S.met.lissan ? 'again' : 'first'),
    nodes: {
      first: { text: (S) => T(S.won, 'Ты… это правда ты? Тот, кто вернулся с Земли вместо генерала? Прости. Мне, кадету, нельзя с тобой разговаривать. Наверное.', 'Звезда на груди… Такую носил только дом Вэйр. Но дом Вэйр погас двадцать лет назад. Кто ты?'), options: 'hub' },
      again: { text: 'Ты вернулся! В казарме до сих пор не верят, что я с тобой говорил.', options: 'hub' },
      hub: {
        text: 'Спрашивай. Для кадета я много знаю.',
        options: [
          { text: 'Кто ты?', next: 'who' },
          { text: 'Что это за место?', next: 'gardens' },
          { text: 'С кем мне здесь стоит поговорить?', next: 'guide' },
          { text: 'Хочешь, расскажу про Землю?', next: 'earth' },
          { text: 'Мне пора.', next: 'bye' },
        ],
      },
      who: { text: 'Лиссан, кадет третьего круга. Через год присяга, если пройду испытания. Отец говорит, что для солдата я слишком много спрашиваю.', options: 'hub' },
      gardens: { text: (S) => T(S.won, 'Сады памяти. Здесь стоит стела за каждого, кто пал за Ксаррон. Вон та, чёрная, — для генерала Ксарга. Имя ещё не высекли: Совет спорит, пал он с честью или нет.', 'Сады памяти. Здесь стоит стела за каждого, кто пал за Ксаррон. Чёрную ставят заранее, перед каждым походом, — для того, кто не вернётся. Говорят, генерал Ксарг сам выбрал для неё камень.'), options: 'hub' },
      guide: { text: 'Регент Аумара — у подножия Цитадели, она почти не уходит с площади. Мастер Орвен — у Архива Домов, рядом с тёмной башней. Сайрен с рассвета на Арене, это на востоке. Адмирал Корвас — в порту, у нити лифта. А в Разлом сверху не ходят… но ты ведь и не сверху.', options: 'hub' },
      earth: {
        text: 'Хочу! Правда, что небо там синее, а солнце одно, жёлтое и маленькое? И что никто не летает? Совсем никто?',
        options: [{ text: 'Правда. И всё равно они сильные.', next: 'earth2' }, { text: 'Когда-нибудь увидишь сам.', next: 'earth3' }],
      },
      earth2: { text: 'Сильные — и не летают… Наставник сказал бы, что так не бывает. Но наставник и Земли не видел.', options: 'hub' },
      earth3: { text: 'Если адмирал поведёт туда флот, увижу. Только я бы не хотел увидеть её так.', options: 'hub' },
      bye: { text: 'Звезда Вэйр… Я расскажу о тебе в казарме. Всё равно никто не поверит.', end: true },
    },
  },
  aumara: {
    start: (S) => (S.met.aumara ? 'again' : 'first'),
    nodes: {
      first: { text: (S) => T(S.won, 'Сын Илиры. Ты убил лучшего полководца Ксаррона и пришёл к нам сам. Это либо храбрость, либо очень плохой расчёт. Я ещё не решила, что именно.', 'Двадцать лет мы считали тебя мёртвым, сын Илиры. А теперь ты стоишь на моей площади, и стража не знает, что с тобой делать. Признаюсь, я тоже.'), options: 'hub' },
      again: { text: 'Снова ты. Говори, Вэйр: у Совета мало времени, а у меня ещё меньше.', options: 'hub' },
      hub: {
        text: 'Говори.',
        options: [
          { text: 'Зачем Совет послал Ксарга на Землю?', next: 'why' },
          { text: 'Кто я для Ксаррона?', next: 'status' },
          { text: 'Оставьте Землю в покое.', next: 'earth' },
          { text: 'Ты знала мою мать.', next: 'mother', if: (S) => S.facts.mother },
          { text: 'Башня Вэйр снова горит.', next: 'veyr', if: (S) => S.veyr },
          { text: 'Что такое Разлом?', next: 'rift' },
          { text: 'Прощай, Регент.', next: 'bye' },
        ],
      },
      why: { text: 'Совет не посылает, Совет голосует. Девять голосов против четырёх: Ксаррону нужны новые миры, а Земля была ближе всех. Мой голос был среди четырёх. Друзьями нас это не делает.', options: 'hub' },
      status: { text: (S) => T(S.won, 'По закону ты наследник изменницы. По праву силы — тот, кто победил генерала. Ксаррон всегда уважал второе больше первого. Поэтому ты жив и стоишь здесь.', 'По закону ты наследник изменницы, и стража должна была взять тебя у ворот. Но они смотрят на звезду у тебя на груди и не двигаются. Любопытно, правда?'), options: 'hub' },
      earth: {
        text: 'На верфях стоят сорок кораблей, и Корвас хочет вести их сам. Я могу задержать решение Совета, но не отменить. Если хочешь, чтобы Ксаррон тебя услышал, говори так, как здесь принято.',
        options: [{ text: 'Как здесь принято?', next: 'oath' }],
      },
      oath: {
        text: 'Принеси присягу на Арене. Тогда твой голос будет весить как голос дома Вэйр. Сейчас он весит как голос беглеца.',
        options: [{ text: 'Я не стану клясться бить слабых.', next: 'refuse' }, { text: 'Я подумаю.', next: 'think' }],
      },
      refuse: { text: 'Твоя мать сказала мне то же самое. За день до той ночи, на этой самой площади. Слово в слово.', options: 'hub' },
      think: { text: 'Думай быстрее Корваса.', options: 'hub' },
      mother: { text: 'Я подписала приказ о её розыске. А за год до того она учила мою дочь читать звёздные карты. Одно другому не мешает. На Ксарроне редко мешает.', options: 'hub' },
      veyr: { text: 'Видела. Весь Тарвэн видел. Совет соберётся сегодня же: ты дал им повод, и не один.', options: 'hub' },
      rift: { text: 'Там живут те, кто родился без силы. Ксаррон их не трогает. Ксаррон их просто не видит. Поверь, это милосерднее, чем было при моём деде.', options: 'hub' },
      bye: { text: 'Не прощайся. На Ксарроне это считают обещанием не возвращаться.', end: true },
    },
  },
  orven: {
    start: (S) => (S.met.orven ? 'again' : 'first'),
    nodes: {
      first: { text: 'Звезда Вэйр… Двадцать лет я стирал пыль с этой звезды на гербе и не думал, что увижу её на живом человеке. Подойди. Дай на тебя посмотреть. Да… глаза у тебя её.', options: 'hub' },
      again: { text: (S) => (S.veyr ? 'Смотри, как она горит. Я уже и забыл, какого цвета свет вашего дома.' : 'Вернулся. Хорошо. Старикам нужно, чтобы кто-то возвращался.'), options: 'hub' },
      hub: {
        text: 'Спрашивай. Архив для того и нужен.',
        options: [
          { text: 'Ты знал мою мать?', next: 'm1' },
          { text: 'Что это за тёмная башня?', next: 'tower', if: (S) => !S.veyr },
          { text: 'Что от неё осталось в Архиве?', next: 'rec', if: (S) => S.facts.mother },
          { text: 'Расскажи о Ксарроне.', next: 'lore' },
          { text: 'Мне пора, мастер.', next: 'bye' },
        ],
      },
      m1: {
        text: 'Илиру? Я её учил. Она была астрографом, лучшим в Архиве: читала звёздные карты, как другие читают письма. Землю нашла она — за много лет до той ночи. И никому не сказала. Только мне.',
        set: 'mother', options: [{ text: 'Почему она улетела?', next: 'm2' }],
      },
      m2: { text: 'Есть присяга, которую приносят за детей рода: обещают отдать ребёнка Арене, когда ему исполнится двадцать. Там он клянётся поднять руку на любого, на кого укажет Ксаррон. В ночь перед этой присягой она взяла корабль. И тебя.', options: 'hub' },
      tower: { text: 'Башня твоего дома. Совет велел погасить её в ту самую ночь, и с тех пор её никто не зажигал. Свет дома зажигает глава дома.', options: [{ text: 'А кто теперь глава дома Вэйр?', next: 'head' }] },
      head: { text: 'Последний из Вэйр стоит передо мной.', options: [{ text: 'Тогда я её зажгу.', next: 'light' }, { text: 'Пусть пока остаётся тёмной.', next: 'wait' }] },
      light: { text: 'Положи руку на знак у входа. Вот так… А теперь смотри.', act: 'lightVeyr', next: 'light2' },
      light2: { text: 'Двадцать лет. Теперь весь Тарвэн знает, что дом Вэйр вернулся. Совету это не понравится. А мне — очень.', options: 'hub' },
      wait: { text: 'Как скажешь. Она ждала двадцать лет, подождёт ещё.', options: 'hub' },
      rec: { text: 'Одна запись. Совет велел её стереть. Я сказал Совету, что стёр.', options: [{ text: 'Покажи.', next: 'play' }] },
      play: { who: 'ilira', text: 'Если ты это слышишь, значит, Орвен опять меня не послушался. Хорошо. Сын, на Ксарроне тебе скажут, что сила — это право. Не верь. Сила — это долг. Я увезла тебя туда, где никто не потребует от тебя клятвы. Если однажды захочешь её дать — выбери её сам.', next: 'play2' },
      play2: { text: 'Вот и всё. Двадцать лет я слушаю её один.', set: 'record', options: 'hub' },
      lore: { text: 'Когда-то Ксаррон строил из звёздного кристалла обсерватории, а не крепости. Потом мы стали сильнее всех вокруг и разучились задавать вопросы. Архив помнит, какими мы были. Поэтому сюда почти никто не ходит.', options: 'hub' },
      bye: { text: 'Иди. И возвращайся.', end: true },
    },
  },
  sairen: {
    start: (S) => (S.met.sairen ? 'again' : 'first'),
    nodes: {
      first: { text: (S) => T(S.won, 'Стой там. Ближе не надо. Ты убил моего отца. По закону Ксаррона у меня есть право вызова, и я им воспользуюсь. Не сегодня. Сегодня я хочу понять, кто ты такой.', 'Так вот как выглядит сын изменницы. Мой отец сейчас летит к твоей Земле, а ты здесь. Он будет разочарован.'), options: 'hub' },
      again: { text: (S) => (S.facts.duel ? 'Огни Арены ещё не зажгли. Не торопи меня.' : 'Опять ты. Арена большая, но тебя на ней сразу видно.'), options: 'hub' },
      hub: {
        text: 'Спрашивай, пока я разрешаю.',
        options: [
          { text: 'Каким он был?', next: 'father', if: (S) => S.won },
          { text: 'Я не хотел его смерти.', next: 'regret', if: (S) => S.won },
          { text: 'Что это за круг?', next: 'circle' },
          { text: 'Что ты думаешь о Корвасе?', next: 'korvas' },
          { text: 'Я принимаю твой вызов.', next: 'duel', if: (S) => S.won && !S.facts.duel, hot: true },
          { text: 'Прощай.', next: 'bye' },
        ],
      },
      father: { text: 'Строгим. Честным, по-своему: он ни разу мне не солгал, даже когда правда была жестокой. Он говорил, что слабость заразна. Иногда мне кажется, что он её просто боялся.', options: 'hub' },
      regret: { text: 'Не надо. Он не хотел бы, чтобы его жалели. Он хотел бы, чтобы его победил достойный. Я ещё не решила, достойный ли ты.', options: 'hub' },
      circle: { text: 'Круг клятвы. Здесь встают на колено перед Советом и клянутся силой служить Ксаррону. Отец стоял здесь. Я стояла здесь. Твоя мать стояла здесь.', options: 'hub' },
      korvas: { text: 'Корвас хочет то, что было у отца: флот и страх. Только отец знал, зачем ему флот. А Корвас знает лишь то, что хочет его.', options: 'hub' },
      duel: { text: 'Не торопись умирать. Когда я буду готова, ты узнаешь первым: на Арене зажгут огни.', set: 'duel', options: 'hub' },
      bye: { text: 'Ещё увидимся, сын Илиры. Ксаррон слишком мал для таких, как мы.', end: true },
    },
  },
  korvas: {
    start: (S) => (S.met.korvas ? 'again' : 'first'),
    nodes: {
      first: { text: (S) => T(S.won, 'А, вот и он. Человек, из-за которого у меня сорок кораблей без командира. Пожалуй, я должен тебя поблагодарить.', 'Сын Вэйр в моём порту. Ксарг улетел за Землёй, а кусок Земли сам пришёл ко мне. Забавно.'), options: 'hub' },
      again: { text: 'Всё ещё здесь, Вэйр? Порт — не музей. Тут работают.', options: 'hub' },
      hub: {
        text: 'Ну?',
        options: [
          { text: 'Что ты собираешься делать с флотом?', next: 'fleet' },
          { text: 'Только тронь Землю.', next: 'threat', hot: true },
          { text: 'Кто строит твои корабли?', next: 'yards' },
          { text: 'Ксарг был сильнее тебя.', next: 'insult' },
          { text: 'Мне пора.', next: 'bye' },
        ],
      },
      fleet: { text: 'То, для чего его строили. Ксарг был стар и любил долгие разговоры: предложения, переговоры, наместники. Я разговаривать не люблю.', options: 'hub' },
      threat: { text: 'Вот. Вот это я понимаю. Ты говоришь как ксарронит, а не как они. Так и передай им на Земле: я приду. Не сегодня и не завтра. Но приду.', set: 'korvas', options: 'hub' },
      yards: { text: 'Бескрылые из Разлома. Чтобы держать сварочный луч, сила не нужна, нужен паёк. Всё честно.', set: 'yards', options: 'hub' },
      insult: { text: (S) => T(S.won, 'Ксарг мёртв. Сила — это то, что осталось стоять.', 'Ксарг далеко. Сила — это тот, кто рядом.'), options: 'hub' },
      bye: { text: 'Мы ещё встретимся над твоей Землёй, Вэйр. Я подожду.', end: true },
    },
  },
  daerra: {
    start: (S) => (S.met.daerra ? 'again' : 'first'),
    nodes: {
      first: { text: 'Ну надо же. Наверху тебя боятся, а здесь — нет. Знаешь почему? Здесь ещё помнят, что значит звезда у тебя на груди.', options: 'hub' },
      again: { text: (S) => (S.veyr ? 'Видели твою башню. Отсюда её видно лучше, чем сверху. Старики плакали. Я — нет: подожду, что будет дальше.' : 'Снова спустился? Осторожнее, тут низкие потолки.'), options: 'hub' },
      hub: {
        text: 'Спрашивай, звезда.',
        options: [
          { text: 'Что она значит?', next: 'star' },
          { text: 'Кто такие бескрылые?', next: 'wingless' },
          { text: 'Корвас говорит, вы строите его корабли.', next: 'yards', if: (S) => S.facts.yards },
          { text: 'Чем я могу помочь?', next: 'help' },
          { text: 'Мне пора.', next: 'bye' },
        ],
      },
      star: { text: 'Дом Вэйр кормил Разлом. Не из жалости: твоя бабка говорила, что сильный, который не держит слабого, — просто опасный камень. Когда башню погасили, нас перестали кормить. Звезду мы помним лучше, чем Совет.', options: 'hub' },
      wingless: { text: 'Те, кто родился без силы. Детей проверяют: не взлетел к двенадцати — спускайся в Разлом. Присягу нам не приносить, судить нас Совету не за что. Наверху делают вид, что нас просто нет.', options: 'hub' },
      yards: { text: 'Строим. Корпус к корпусу, сорок штук. Каждый, кто там работает, знает, куда полетят эти корабли. Знает и молчит. Здесь не умеют спорить с теми, кто летает.', options: 'hub' },
      help: { text: 'Не обещай. Наверху все обещают. Хочешь помочь — приходи сюда иногда. Пусть видят, что звезда снова спускается в Разлом.', options: 'hub' },
      bye: { text: 'Иди, звезда. Только дорогу вниз не забудь.', end: true },
    },
  },
};

// Что говорят прохожие, если с ними поздороваться (E)
export const BARKS = {
  citizen: {
    won: ['Это он… Тот, кто победил Ксарга.', 'Не смотри на него так открыто.', 'Говорят, он вырос на какой-то Земле, среди бескрылых.', 'Сын изменницы — и сильнее генерала. Совет этого не простит.', 'Дом Вэйр… Я думала, его больше нет.', 'Сила есть сила. Даже если она пришла не оттуда.'],
    not: ['Звезда Вэйр? Не может быть.', 'Он не из стражи. Кто он такой?', 'Сын Илиры… Говорили, он умер.', 'Не подходи к нему. Пусть стража разбирается.'],
  },
  guard: {
    won: ['Мы не станем тебя останавливать. Ты победил генерала.', 'Регент велела тебя не трогать.', 'Проходи, Вэйр.'],
    not: ['Стой. Хотя нет… иди. Приказа на тебя нет.', 'Звезда Вэйр. Я доложу.'],
  },
  wingless: {
    won: ['Звезда вернулась!', 'Это правда он? Спустился к нам?', 'Наверху говорят — убийца. А по мне, так первый, кто сюда спустился.'],
    not: ['Звезда Вэйр… Мама рассказывала.', 'Ты к нам? Сверху сюда не спускаются.', 'Осторожнее, тут низкие потолки.'],
  },
};

// Если герой ломает город: по одной реплике на порог (сколько домов сломано с прилёта)
export const WRECK = [
  { n: 1, radio: 'КАНАЛ ГВАРДИИ: Обрушение в жилом круге! Всем постам — к месту обрушения.' },
  { n: 6, radio: 'САЙРЕН · КАНАЛ ГВАРДИИ: Это он. Звезда Вэйр крушит город. Не стрелять — всё равно без толку.' },
  { n: 15, radio: 'РЕГЕНТ АУМАРА: Хватит. Ты пришёл доказать, что ты сын Илиры, — или что ты второй Ксарг?' },
  { n: 40, say: 'Они смотрят на меня так же, как Земля смотрела на Ксарга…' },
];

// ---------------------------------------------------------------- портреты
// Рисованный бюст: фон цвета дома, плечи и ворот, лицо со светом слева (от голубой звезды),
// волосы, глаза, брови и рот по характеру, морщины, шрам, борода. Рисуется один раз в холст 240×300.
export function drawPortrait(spec) {
  const cv = document.createElement('canvas');
  cv.width = 240; cv.height = 300;
  const g = cv.getContext('2d'), F = spec, w = F.w || 1;
  const bg = g.createLinearGradient(0, 0, 0, 300);
  bg.addColorStop(0, F.bg[0]); bg.addColorStop(1, F.bg[1]);
  g.fillStyle = bg; g.fillRect(0, 0, 240, 300);
  const glow = g.createRadialGradient(120, 120, 10, 120, 120, 150);
  glow.addColorStop(0, hexA(F.glow, 0.35)); glow.addColorStop(1, hexA(F.glow, 0));
  g.fillStyle = glow; g.fillRect(0, 0, 240, 300);
  const hx = 120, hy = 122, rx = 42 * w, ry = 54;
  if (F.halo) {
    g.save(); g.strokeStyle = hexA(F.glow, 0.9); g.lineWidth = 3; g.shadowColor = F.glow; g.shadowBlur = 18;
    g.beginPath(); g.ellipse(hx, hy - 18, 70, 70, 0, 0, Math.PI * 2); g.stroke(); g.restore();
  }
  // Волосы сзади и капюшон
  if (F.style === 'long' || F.style === 'tail') {
    g.fillStyle = F.hair;
    g.beginPath(); g.ellipse(hx, hy + (F.style === 'long' ? 30 : 5), rx * 1.22, ry * (F.style === 'long' ? 1.35 : 1.08), 0, 0, Math.PI * 2); g.fill();
  }
  if (F.collar === 'hood') {
    g.fillStyle = shade(F.cloth2, 0.7);
    g.beginPath(); g.ellipse(hx, hy + 6, rx * 1.55, ry * 1.4, 0, 0, Math.PI * 2); g.fill();
  }
  // Плечи и одежда
  const cl = g.createLinearGradient(40, 200, 220, 300);
  cl.addColorStop(0, shade(F.cloth, 1.15)); cl.addColorStop(1, shade(F.cloth, 0.6));
  g.fillStyle = cl;
  g.beginPath(); g.moveTo(0, 300); g.bezierCurveTo(10, 232, 60, 214, 120, 212); g.bezierCurveTo(180, 214, 230, 232, 240, 300); g.closePath(); g.fill();
  // Шея
  g.fillStyle = shade(F.skin, 0.82);
  g.fillRect(hx - 17 * w, hy + 38, 34 * w, 42);
  // Ворот
  g.fillStyle = F.cloth2;
  if (F.collar === 'high') {
    g.beginPath(); g.moveTo(hx - 34, 226); g.lineTo(hx - 26, hy + 58); g.lineTo(hx + 26, hy + 58); g.lineTo(hx + 34, 226); g.closePath(); g.fill();
    g.strokeStyle = hexA(F.glow, 0.6); g.lineWidth = 1.5; g.stroke();
  } else if (F.collar === 'armor') {
    for (const s of [-1, 1]) {
      const pg = g.createRadialGradient(hx + s * 78, 228, 4, hx + s * 78, 236, 48);
      pg.addColorStop(0, shade(F.cloth, 1.9)); pg.addColorStop(1, shade(F.cloth, 0.5));
      g.fillStyle = pg; g.beginPath(); g.ellipse(hx + s * 80, 240, 46, 28, s * 0.25, 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = F.cloth2; g.fillRect(hx - 30, 214, 60, 14);
  } else if (F.collar === 'cadet') {
    g.beginPath(); g.moveTo(hx - 24, 222); g.lineTo(hx, 246); g.lineTo(hx + 24, 222); g.lineTo(hx + 20, 210); g.lineTo(hx - 20, 210); g.closePath(); g.fill();
  }
  // Знак дома на груди
  g.save(); g.fillStyle = F.glow; g.shadowColor = F.glow; g.shadowBlur = 14;
  hexagon(g, hx, 272, 9); g.fill(); g.restore();
  // Лицо: свет слева сверху, тень справа
  const sk = g.createRadialGradient(hx - 16, hy - 20, 6, hx, hy, ry * 1.1);
  sk.addColorStop(0, shade(F.skin, 1.12)); sk.addColorStop(0.7, F.skin); sk.addColorStop(1, shade(F.skin, 0.68));
  g.fillStyle = sk;
  g.beginPath(); g.moveTo(hx, hy - ry);
  g.bezierCurveTo(hx + rx * 1.05, hy - ry, hx + rx, hy + ry * 0.35, hx + rx * 0.55, hy + ry * 0.78);
  g.quadraticCurveTo(hx, hy + ry * 1.08, hx - rx * 0.55, hy + ry * 0.78);
  g.bezierCurveTo(hx - rx, hy + ry * 0.35, hx - rx * 1.05, hy - ry, hx, hy - ry);
  g.fill();
  // Уши
  g.fillStyle = shade(F.skin, 0.85);
  for (const s of [-1, 1]) { g.beginPath(); g.ellipse(hx + s * rx * 0.98, hy + 4, 6, 11, 0, 0, Math.PI * 2); g.fill(); }
  // Скулы и тень у носа
  g.fillStyle = 'rgba(0,0,0,0.10)';
  g.beginPath(); g.ellipse(hx + rx * 0.55, hy + 14, 10, 18, 0.2, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(hx + 2, hy + 2); g.quadraticCurveTo(hx + 8, hy + 22, hx + 3, hy + 30); g.stroke();
  g.fillStyle = 'rgba(0,0,0,0.18)';
  g.beginPath(); g.ellipse(hx + 4, hy + 30, 9, 3.5, 0, 0, Math.PI * 2); g.fill();
  // Глаза
  const ey = hy - 2, M = F.mood;
  for (const s of [-1, 1]) {
    const ex = hx + s * 17 * w;
    g.fillStyle = '#ece6de';
    g.beginPath(); g.ellipse(ex, ey, 9, M === 'stern' ? 3.6 : 4.4, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = F.eye; g.beginPath(); g.arc(ex + 0.5, ey, 3.8, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#0a0808'; g.beginPath(); g.arc(ex + 0.5, ey, 1.8, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.8)'; g.beginPath(); g.arc(ex - 1, ey - 1.4, 1, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(20,10,8,0.85)'; g.lineWidth = 1.6;
    g.beginPath(); g.ellipse(ex, ey, 9.4, M === 'stern' ? 3.9 : 4.8, 0, Math.PI * 1.05, Math.PI * 1.95); g.stroke();
    // Брови: строгие опускаются к носу, тёплые — мягкой дугой
    const tilt = M === 'stern' ? 0.22 : M === 'smirk' ? (s > 0 ? -0.15 : 0.12) : M === 'eager' ? -0.12 : M === 'warm' ? -0.06 : 0;
    g.strokeStyle = F.style === 'bald' && F.hair ? shade(F.hair, 0.8) : shade(F.hair, 0.9); g.lineWidth = F.age > 0.7 ? 3.4 : 4;
    g.beginPath(); g.moveTo(ex - 10 * s, ey - 9 + (M === 'stern' ? 3 : 0)); g.quadraticCurveTo(ex, ey - 14 - (M === 'eager' ? 3 : 0), ex + 10 * s, ey - 11 - tilt * 10); g.stroke();
  }
  // Рот
  const my = hy + 40;
  g.strokeStyle = 'rgba(70,30,26,0.9)'; g.lineWidth = 2.4;
  g.beginPath();
  if (M === 'smirk') { g.moveTo(hx - 13, my + 1); g.quadraticCurveTo(hx, my + 3, hx + 14, my - 4); }
  else if (M === 'warm' || M === 'eager') { g.moveTo(hx - 13, my - 1); g.quadraticCurveTo(hx, my + 5, hx + 13, my - 1); }
  else { g.moveTo(hx - 13, my + 1); g.quadraticCurveTo(hx, my - 1, hx + 13, my + 1); }
  g.stroke();
  g.fillStyle = 'rgba(150,70,60,0.35)'; g.beginPath(); g.ellipse(hx, my + 5, 9, 3, 0, 0, Math.PI * 2); g.fill();
  // Возраст
  if (F.age > 0.3) {
    g.strokeStyle = `rgba(60,30,20,${0.2 + F.age * 0.25})`; g.lineWidth = 1.2;
    for (let k = 0; k < 3; k++) { g.beginPath(); g.moveTo(hx - 20, hy - 30 - k * 6); g.quadraticCurveTo(hx, hy - 33 - k * 6, hx + 20, hy - 30 - k * 6); g.stroke(); }
    for (const s of [-1, 1]) { g.beginPath(); g.moveTo(hx + s * 12, hy + 24); g.quadraticCurveTo(hx + s * 18, hy + 34, hx + s * 16, hy + 44); g.stroke(); }
    for (const s of [-1, 1]) { g.beginPath(); g.moveTo(hx + s * 10, ey + 8); g.quadraticCurveTo(hx + s * 17, ey + 11, hx + s * 24, ey + 7); g.stroke(); }
  }
  if (F.scar) {
    g.strokeStyle = 'rgba(210,140,130,0.9)'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(hx - 30, hy - 22); g.lineTo(hx - 8, hy + 26); g.stroke();
    g.strokeStyle = 'rgba(60,20,16,0.5)'; g.lineWidth = 1; g.stroke();
  }
  // Борода
  if (F.beard) {
    g.fillStyle = F.hair;
    g.beginPath(); g.moveTo(hx - rx * 0.92, hy + 8);
    const by = F.beard === 'full' ? hy + ry * 1.35 : hy + ry * 1.08;
    g.quadraticCurveTo(hx - rx * 0.8, by, hx, by + 4); g.quadraticCurveTo(hx + rx * 0.8, by, hx + rx * 0.92, hy + 8);
    g.quadraticCurveTo(hx + rx * 0.5, hy + 30, hx + 16, my - 4); g.quadraticCurveTo(hx, my - 8, hx - 16, my - 4);
    g.quadraticCurveTo(hx - rx * 0.5, hy + 30, hx - rx * 0.92, hy + 8); g.fill();
    g.strokeStyle = 'rgba(70,30,26,0.9)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(hx - 11, my + 1); g.quadraticCurveTo(hx, my + (M === 'warm' ? 4 : 0), hx + 11, my + 1); g.stroke();
  }
  // Волосы спереди
  g.fillStyle = F.hair;
  if (F.style === 'crop' || F.style === 'tail' || F.style === 'long') {
    g.beginPath(); g.moveTo(hx - rx * 1.06, hy + (F.style === 'crop' ? -6 : 10));
    g.bezierCurveTo(hx - rx * 1.2, hy - ry * 1.25, hx + rx * 1.2, hy - ry * 1.25, hx + rx * 1.06, hy + (F.style === 'crop' ? -6 : 10));
    g.quadraticCurveTo(hx + rx * 0.9, hy - ry * 0.55, hx + rx * 0.2, hy - ry * 0.72);
    g.quadraticCurveTo(hx - rx * 0.5, hy - ry * 0.6, hx - rx * 1.06, hy + (F.style === 'crop' ? -6 : 10));
    g.fill();
  } else if (F.style === 'bald') {
    g.fillStyle = 'rgba(255,255,255,0.12)';
    g.beginPath(); g.ellipse(hx - 14, hy - ry * 0.72, 16, 7, -0.3, 0, Math.PI * 2); g.fill();
    if (F.hair) { g.fillStyle = hexA(F.hair, 0.6); for (const s of [-1, 1]) { g.beginPath(); g.ellipse(hx + s * rx * 0.92, hy - 12, 6, 16, 0, 0, Math.PI * 2); g.fill(); } }
  } else if (F.style === 'hood') {
    g.fillStyle = F.cloth2;
    g.beginPath(); g.moveTo(hx - rx * 1.4, hy + 60); g.bezierCurveTo(hx - rx * 1.5, hy - ry * 1.6, hx + rx * 1.5, hy - ry * 1.6, hx + rx * 1.4, hy + 60);
    g.lineTo(hx + rx * 1.05, hy + 50); g.bezierCurveTo(hx + rx * 1.1, hy - ry * 1.1, hx - rx * 1.1, hy - ry * 1.1, hx - rx * 1.05, hy + 50); g.closePath(); g.fill();
    g.fillStyle = F.hair; g.beginPath(); g.ellipse(hx - rx * 0.4, hy - ry * 0.78, rx * 0.6, 9, -0.2, 0, Math.PI * 2); g.fill();
  }
  // Контровой свет цвета дома справа
  g.save(); g.globalCompositeOperation = 'lighter'; g.strokeStyle = hexA(F.glow, 0.35); g.lineWidth = 3;
  g.beginPath(); g.ellipse(hx + 2, hy, rx * 1.02, ry * 1.01, 0, -1.2, 1.0); g.stroke(); g.restore();
  // Запись: голубоватые строки развёртки
  if (F.holo) {
    g.fillStyle = 'rgba(160,220,255,0.10)';
    for (let y = 0; y < 300; y += 4) g.fillRect(0, y, 240, 1.5);
    g.fillStyle = 'rgba(120,200,255,0.10)'; g.fillRect(0, 0, 240, 300);
  }
  // Виньетка
  const vg = g.createRadialGradient(120, 140, 90, 120, 150, 210);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.65)');
  g.fillStyle = vg; g.fillRect(0, 0, 240, 300);
  return cv;
}

function hexagon(g, x, y, r) {
  g.beginPath();
  for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3 + Math.PI / 6; g[k ? 'lineTo' : 'moveTo'](x + Math.cos(a) * r, y + Math.sin(a) * r); }
  g.closePath();
}
function rgb(hex) { const v = parseInt(hex.slice(1), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; }
function shade(hex, k) { const [r, g, b] = rgb(hex); return `rgb(${Math.min(255, r * k) | 0},${Math.min(255, g * k) | 0},${Math.min(255, b * k) | 0})`; }
function hexA(hex, a) { const [r, g, b] = rgb(hex); return `rgba(${r},${g},${b},${a})`; }
