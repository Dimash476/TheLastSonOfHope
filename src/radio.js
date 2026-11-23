import { SPACE, MAP } from './config.js';
import { QUAY_X, HALF } from './world/layout.js';

// Радио в Симуляторе (клавиша I): три земные станции и «Голос Тарвэна» на Ксарроне.
// Музыка своя, синтезируется по шагам (шестнадцатые) с забеганием вперёд, как музыка игры.
// Между песнями — выпуски новостей: о том, что сейчас натворил герой, о сценах на улицах,
// реклама и слухи. Текст — строкой радиоперехвата (#inv-radio), перед выпуском — позывной.
// Пока радио играет, своя музыка игры молчит. В космосе и на картах планет — только шум эфира.

const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const CITY = MAP === 'steppe' ? 'Сарыдала' : 'город';

// ---------------------------------------------------------------- станции
// prog — аккорды (MIDI) по тактам, bass — басовая нота такта, lead — мелодия такта [шаг, нота, длина в шагах]
const STATIONS = [
  {
    id: 'city', name: 'ГОРОД FM', freq: '101.4', bpm: 118,
    ident: `ГОРОД FM 101.4 — хиты ${MAP === 'steppe' ? 'Сарыдалы' : 'города'} с телебашни «Надежда».`,
    prog: [[57, 60, 64], [53, 57, 60], [55, 60, 64], [55, 59, 62]],
    bass: [45, 41, 48, 43],
    lead: [
      [[0, 76, 2], [3, 72, 1], [4, 74, 2], [6, 76, 2], [10, 79, 2], [12, 76, 4]],
      [[0, 77, 2], [3, 76, 1], [4, 72, 2], [8, 74, 2], [10, 72, 2], [12, 69, 4]],
      [[0, 72, 2], [3, 74, 1], [4, 76, 2], [6, 79, 2], [8, 81, 3], [12, 79, 4]],
      [[0, 79, 2], [2, 77, 2], [4, 76, 2], [6, 74, 2], [8, 71, 4], [12, 74, 4]],
    ],
  },
  {
    id: 'wave', name: 'ВОЛНА 88', freq: '88.0', bpm: 100,
    ident: 'ВОЛНА 88. Ночной город, неон и синтезатор.',
    prog: [[50, 53, 57], [46, 50, 53], [45, 48, 53], [48, 52, 55]],
    bass: [38, 34, 41, 36],
    lead: [
      [[0, 69, 8], [8, 72, 4], [12, 74, 4]],
      [[0, 74, 8], [8, 72, 4], [12, 70, 4]],
      [[0, 69, 12], [12, 65, 4]],
      [[0, 67, 8], [8, 64, 8]],
    ],
  },
  {
    id: 'calm', name: 'ТИШИНА', freq: '94.2', bpm: 76, swing: 0.3,
    ident: 'ТИШИНА 94.2. Медленная музыка для быстрых людей.',
    prog: [[53, 57, 60, 64], [52, 55, 59, 62], [50, 53, 57, 60], [48, 52, 55, 59]],
    bass: [41, 40, 38, 36],
    lead: [
      [[6, 76, 4], [12, 72, 3]],
      [[2, 74, 2], [4, 71, 6]],
      [[6, 72, 2], [8, 69, 6]],
      [[10, 67, 2], [12, 71, 4]],
    ],
  },
];
// Ксаррон: хор в миноре, глубокие барабаны, металлический колокол
const TARVEN = {
  id: 'tarven', name: 'ГОЛОС ТАРВЭНА', freq: '', bpm: 64,
  ident: 'ГОЛОС ТАРВЭНА. Говорит столица Ксаррона.',
  prog: [[48, 51, 55], [49, 53, 56], [44, 48, 51], [43, 47, 50]],
  bass: [36, 37, 32, 31],
  lead: [
    [[0, 72, 4], [8, 75, 4]],
    [[0, 73, 6], [8, 72, 4]],
    [[0, 68, 4], [6, 70, 2], [8, 72, 6]],
    [[0, 71, 8], [8, 67, 6]],
  ],
};

// ---------------------------------------------------------------- новости
// Каждое событие: строки на выбор, задержка до выпуска (с) и «перезарядка» (с)
const NEWS = {
  destroy1: { cd: 0, lines: ['Срочно: в городе рухнуло здание. Очевидцы видели человека в плаще. Подробности уточняются.', 'Экстренно: обрушение в центре. Свидетели говорят, что здание «просто попалось ему на пути».'] },
  destroy10: { cd: 0, lines: ['Мэрия подсчитала: за день разрушено уже десять зданий. Страховщики просят героя быть поаккуратнее.'] },
  destroy40: { cd: 0, lines: ['В городе сорок новых пустырей. Застройщики потирают руки, мэрия созывает экстренное заседание.'] },
  destroy100: { cd: 0, lines: ['Сто зданий за день. Наш аналитик говорит, что это рекорд. Наш аналитик, впрочем, уже переехал за город.'] },
  destroy250: { cd: 0, lines: ['Город почти сровнялся с землёй. Если вы нас слышите — значит, телебашня «Надежда» ещё стоит.'] },
  restored: { cd: 60, lines: ['Чудо дня: разрушенные дома снова стоят на месте. Строители разводят руками и просят не задавать вопросов.'] },
  sonic: { cd: 150, lines: ['Слушатели жалуются на хлопки над крышами: снова кто-то преодолел звуковой барьер прямо над городом. Берегите стёкла.', 'Стекольщики города сообщают о рекордных заказах. Причина — сверхзвук над крышами.', 'Над городом прогремел звуковой удар. Сигнализации машин просят прощения за шум.'] },
  space: { cd: 300, lines: ['Обсерватория сообщает: человек в плаще только что покинул атмосферу. Счастливого пути — и возвращайся к ужину.', 'Радары ПВО засекли объект, уходящий в космос без ракеты. Военные решили сделать вид, что ничего не видели.'] },
  moon: { cd: 300, lines: ['Телескопы засекли героя на Луне. Первая высадка без ракеты, скафандра и бюджета.'] },
  planet: { cd: 200, lines: ['Астрономы: герой побывал на планете {name}. Сувениров, надеемся, не привёз.', 'Обсерватория: человека в плаще видели у планеты {name}. Учёные просят хотя бы фото.'] },
  sun: { cd: 300, lines: ['Астрономы просят героя не трогать Солнце. Это единственное, что у нас есть.'] },
  blackhole: { cd: 300, lines: ['Астрономы в шоке: герой летал к чёрной дыре. Учёные просят больше так не делать. Ну или хотя бы снять видео.'] },
  gone: { cd: 0, lines: ['Телескопы потеряли героя на {min}. Где он был, не знает никто. Вернулся — и ладно.', 'Пропажа на {min}, и вот он снова над городом. Говорят, на плаще — пыль чужой планеты.'] },
  heli: { cd: 120, lines: ['Вертолёт телеканала только что упал над городом. Пилот цел и, по его словам, «очень впечатлён».', 'Минус ещё один вертолёт телеканала. Редакция просит героя облетать съёмочную группу.'] },
  carLift: { cd: 90, lines: ['Очевидцы: {where} герой поднял машину над головой. Водитель просит вернуть её на место. Желательно на колёса.', 'Видео дня: человек в плаще держит легковушку одной рукой. Автосалоны в шоке.'] },
  busLift: { cd: 120, lines: ['{where} герой поднял целый автобус. Пассажиры говорят, что это была лучшая поездка за месяц.'] },
  personHeld: { cd: 90, lines: ['Горожанин прокатился на руках у героя. Говорит: страшно, но советует.', 'Ещё один прохожий полетал с героем. Очередь, по слухам, уже на квартал.'] },
  help: { cd: 90, lines: ['Герой помог упавшему прохожему подняться. Мелочь, а приятно.', 'Свидетели: человек в плаще помог встать пешеходу и даже отряхнул ему куртку.'] },
  ball: { cd: 120, lines: ['В парке герой бросал мяч собаке. Мяч, говорят, долетел до соседнего района. Собака счастлива.'] },
  greet: { cd: 150, lines: ['Соцсети заполнили селфи с человеком в плаще. Он, кажется, не против.', 'Тренд дня — селфи с героем. Лучшие снимки — с размытым плащом.'] },
  autograph: { cd: 120, lines: ['Поклонник героя получил автограф и обещает повесить его в рамку. Над кроватью.', 'Автограф героя уже продают в сети. Подлинность подтверждает только плащ на фото.'] },
  stopCar: { cd: 90, lines: ['Водитель, которого герой остановил ладонью: «Я думал, что врезался в стену. Стена улыбалась».', 'Новое правило дорожного движения: если на дороге стоит человек в плаще — тормозите. Он всё равно остановит.'] },
  placeRoof: { cd: 120, lines: ['Загадка дня: на крыше дома появилась машина. Владелец ищет очень длинную лестницу.'] },
  placeCar: { cd: 120, lines: ['Герой аккуратно поставил машину обратно. Владелец уже выложил видео.'] },
  personRoof: { cd: 120, lines: ['Горожанин застрял на крыше: его туда поставил герой. Говорит, вид отличный, но хочется домой.'] },
  placePerson: { cd: 120, lines: ['Горожанин, которого герой бережно поставил на землю, просит повторить.'] },
  plane: { cd: 120, lines: ['Пассажиры рейса рассказывают: самолёт ненадолго нёс на руках человек в плаще. Экипаж аплодировал.'] },
  planeLand: { cd: 120, lines: ['Невероятно: самолёт приземлился посреди города. На руках. Пассажиры целы, экипаж просит отпуск.'] },
  // Сцены на улицах (scenes.js)
  chase: { cd: 0, lines: ['Внимание: ограблен ювелирный магазин. Грабители уходят на тёмной машине, полиция преследует. Будьте осторожны на дорогах.'] },
  chaseWin: { cd: 0, lines: ['Погоня окончена: машину грабителей остановил герой. Полиция благодарит и просит в следующий раз оставить машину целой.', 'Грабители задержаны. По словам полиции, их машину «остановило небо».'] },
  chaseLost: { cd: 0, lines: ['Грабители ушли от погони. Полиция ищет тёмный седан и просит звонить, если увидите.'] },
  fire: { cd: 0, lines: ['На дороге авария: машина горит, водитель внутри. Пожарные в пути.'] },
  fireWin: { cd: 0, lines: ['Водителя вытащили из горящей машины, а огонь сдуло одним выдохом. Пожарные приехали — тушить было нечего.'] },
  cat: { cd: 0, lines: ['Звонок в эфир: девочка плачет под деревом — котёнок залез на самую верхушку и не может слезть.'] },
  catWin: { cd: 0, lines: ['Котёнок снова дома. Хозяйка говорит, что герой даже не взял благодарность — только помахал.'] },
  busker: { cd: 0, lines: ['На улице играет музыкант: собралась толпа. Заглядывайте, если рядом.'] },
  coin: { cd: 0, lines: ['Уличному музыканту подкинул монетку сам герой. Музыкант уверяет, что монета была ещё тёплая.'] },
};

// Между новостями
const FILLER = [
  'Реклама. Пельменная «У причала»: лепим так, будто от этого зависит судьба мира.',
  'Реклама. Химчистка «Плащ за час». Даже если вы пролетели сквозь здание.',
  'Реклама. Страхование «Крыша+»: от пожара, потопа и падающих машин.',
  'Реклама. Застройщик «Нерушимый». Мы строим дома, которые выдерживают почти всё. Почти.',
  'Реклама. Очки «Сверхзвук»: защищают от солнца, ветра и чужих взглядов.',
  'Реклама. Стекольная мастерская «Окно»: после пролёта героя работаем круглосуточно.',
  'Опрос в эфире: шестьдесят процентов горожан хотят, чтобы герой летал потише. Остальные — чтобы он прилетел к ним.',
  'Учёные спорят, почему плащ героя не рвётся. Портные спорят, где он его шьёт.',
  'Слух дня: герой не ест, не спит и не платит за парковку.',
  'Голуби у телебашни, говорят, перестали бояться людей в плащах.',
  'Мэрия обсуждает воздушные светофоры. Пока — для одного человека.',
  'Звонок в эфир: «Я видел, как он завис над моим балконом и смотрел на закат. Это нормально?»',
];
const WEATHER = [
  'Погода: ясно. Отличный день, чтобы смотреть в небо.',
  'Погода: облачно, местами — человек в плаще.',
  'Погода: дождь. Берите зонты, летающим — капюшоны.',
  'Погода: гроза. Просьба не подниматься к молниям. Это касается одного нашего слушателя.',
];
const TARVEN_NEWS = [
  'Совет домов заседает третий день. На повестке — сын Илиры, верфи и будущее Ксаррона.',
  'Верфи сообщают: корпус тридцать девять готов к спуску. Слава труду домов.',
  'Жителей внешнего кольца просят не выходить на крыши: в небе чужак. Или свой — Совет ещё не решил.',
  'Говорят старики: Илира тоже любила летать над Скайвеем ночью.',
  'Погода в Тарвэне: свет Вэлкара ровный, ветер с верфей, пыль умеренная.',
  'Поезда Скайвея ходят по расписанию. Просьба к летающим — не садиться на крышу вагона.',
  'Рынок у Арены: цены на камень с Тэль снова выросли.',
  'Гвардия напоминает: полёты ниже шпилей Цитадели запрещены. Для всех. Почти для всех.',
];
const TARVEN_EVENTS = {
  aircar: { cd: 0, lines: ['Авария в небе! Аэрокар потерял тягу над кольцом и падает!'] },
  aircarWin: { cd: 0, lines: ['Сын Илиры поймал падающий аэрокар. Совет молчит, но люди на площади аплодируют.', 'Аэрокар цел, пассажиры целы. Чужак с Земли поймал его в воздухе. Тарвэн такого не видел со времён Илиры.'] },
  aircarLost: { cd: 0, lines: ['Аэрокар разбился у кольца. Гвардия оцепила квартал.'] },
};

const PAIR = { chaseWin: 'chase', chaseLost: 'chase', fireWin: 'fire', catWin: 'cat', 'tarven:aircarWin': 'tarven:aircar', 'tarven:aircarLost': 'tarven:aircar' };

// Где это: грубо по месту героя
function where(p) {
  const r = Math.max(Math.abs(p.x), Math.abs(p.z));
  if (MAP !== 'steppe' && p.x > QUAY_X - 40) return 'У моря';
  if (r < 900) return 'В самом центре';
  if (r < HALF) return 'В городе';
  return 'За городом';
}

export class Radio {
  constructor(audio, world) {
    this.a = audio;
    this.world = world;
    this.on = -1;           // номер станции, −1 — выключено
    this.built = false;
    this.el = document.getElementById('inv-radio');
    this.badge = document.getElementById('radio-badge');
    this.queue = [];
    this.cds = {};
    this.newsT = 0;         // строка новостей на экране, с
    this.fillT = 25;        // до следующей «вставки»
    this.prev = {};
    this.hinted = false;
    this.goneAt = 0;
    this.t = 0;
  }

  // ---------------------------------------------------------------- звук
  build() {
    const a = this.a, ctx = a.ctx;
    this.built = true;
    this.masterRef = a.master;
    const g = (v) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    // Шина станции → провал на новости → «радийная» полоса → выход
    this.bus = g(0);
    this.duck = g(1);
    this.hp = ctx.createBiquadFilter(); this.hp.type = 'highpass'; this.hp.frequency.value = 70;
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 11000; this.lp.Q.value = 0.5;
    this.out = g(1);
    this.bus.connect(this.duck).connect(this.hp).connect(this.lp).connect(this.out);
    this.send = g(0.12); this.bus.connect(this.send);
    // Шум эфира: в космосе, на чужих планетах и при переключении
    this.hiss = g(0);
    const src = ctx.createBufferSource(); src.buffer = a.noise; src.loop = true; src.start();
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2200; bp.Q.value = 0.4;
    src.connect(bp).connect(this.hiss);
    this.connectOut();
    this.next = ctx.currentTime + 0.2;
    this.step = 0;
  }

  connectOut() {
    const a = this.a;
    this.out.disconnect(); this.send.disconnect(); this.hiss.disconnect();
    this.out.connect(a.master); this.send.connect(a.reverb); this.hiss.connect(a.master);
    this.masterRef = a.master;
  }

  voice(t, type, f, dur, gain, { attack = 0.005, cut = 0, q = 1, det = 0, dest = this.bus, glide = 0 } = {}) {
    const ctx = this.a.ctx;
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t); o.detune.value = det;
    if (glide) o.frequency.exponentialRampToValueAtTime(glide, t + dur);
    const e = ctx.createGain();
    e.gain.setValueAtTime(0.0001, t);
    e.gain.exponentialRampToValueAtTime(gain, t + attack);
    e.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let n = o;
    if (cut) { const f2 = ctx.createBiquadFilter(); f2.type = 'lowpass'; f2.frequency.value = cut; f2.Q.value = q; n = n.connect(f2); }
    n.connect(e).connect(dest);
    o.start(t); o.stop(t + dur + 0.05);
  }

  noise(t, dur, gain, type, f, q = 1, dest = this.bus) {
    const ctx = this.a.ctx;
    const s = ctx.createBufferSource(); s.buffer = this.a.noise;
    const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q;
    const e = ctx.createGain();
    e.gain.setValueAtTime(gain, t); e.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(b).connect(e).connect(dest);
    s.start(t, Math.random() * 2); s.stop(t + dur + 0.05);
  }

  kick(t, g, f0 = 130, f1 = 45, dur = 0.38) { this.voice(t, 'sine', f0, dur, g, { glide: f1, attack: 0.002 }); }

  // Пэд «хором»: две пилы через форманты гласной «а»
  choir(t, n, dur, g) {
    const ctx = this.a.ctx;
    const e = ctx.createGain();
    e.gain.setValueAtTime(0.0001, t);
    e.gain.exponentialRampToValueAtTime(g, t + dur * 0.35);
    e.gain.exponentialRampToValueAtTime(0.0001, t + dur + 1.5);
    for (const fm of [720, 1150]) {
      const b = ctx.createBiquadFilter(); b.type = 'bandpass'; b.frequency.value = fm; b.Q.value = 5;
      b.connect(e);
      for (const det of [-9, 9]) {
        const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = midi(n); o.detune.value = det;
        o.connect(b); o.start(t); o.stop(t + dur + 1.6);
      }
    }
    e.connect(this.bus);
  }

  // Электропиано: синус с призвуком, мягко
  keys(t, n, dur, g) {
    this.voice(t, 'sine', midi(n), dur, g, { attack: 0.01 });
    this.voice(t, 'triangle', midi(n) * 2, dur * 0.4, g * 0.25, { attack: 0.005 });
  }

  // Один шаг (шестнадцатая) текущей станции
  playStep(S, t, s) {
    const st = s % 16, bar = Math.floor(s / 16), ci = bar % 4;
    const ch = S.prog[ci], root = S.bass[ci];
    const sec = Math.floor(bar / 8) % 4;     // вступление, куплет, проигрыш, припев
    const len = 60 / S.bpm / 4;
    const drums = sec !== 2;
    const lead = sec >= 2;
    const ln = lead ? S.lead[ci].find((l) => l[0] === st) : null;
    if (S.id === 'city') {
      if (drums && st % 4 === 0) this.kick(t, 0.9);
      if (drums && sec > 0 && (st === 4 || st === 12)) { this.noise(t, 0.16, 0.38, 'bandpass', 1500, 0.9); this.noise(t + 0.012, 0.12, 0.22, 'bandpass', 2100, 1); }
      if (st % 4 === 2) this.noise(t, 0.07, drums ? 0.2 : 0.08, 'highpass', 7500);
      else if (drums) this.noise(t, 0.03, 0.05, 'highpass', 9000);
      if (st % 4 === 2) this.voice(t, 'sawtooth', midi(root), len * 1.6, 0.22, { cut: 520, q: 4 });
      if (st === 0 || st === 3 || st === 6 || st === 10) for (const n of ch) this.voice(t, 'square', midi(n + 12), len * 1.2, 0.035, { cut: 2600, q: 1.5, det: n % 2 ? 6 : -6 });
      if (ln) this.voice(t, 'square', midi(ln[1]), ln[2] * len, 0.05, { cut: 3200, attack: 0.01 });
    } else if (S.id === 'wave') {
      if (drums && (st === 0 || st === 8)) this.kick(t, 0.9, 110, 40, 0.5);
      if (drums && (st === 4 || st === 12)) { this.noise(t, 0.35, 0.32, 'bandpass', 1300, 0.6); this.voice(t, 'triangle', 190, 0.12, 0.18, { glide: 120 }); }
      if (drums && st % 2 === 0) this.noise(t, 0.05, 0.07, 'highpass', 8000);
      if (st % 2 === 0) this.voice(t, 'sawtooth', midi(root + (st % 4 === 2 ? 12 : 0)), len * 1.8, 0.18, { cut: 700, q: 6 });
      const arp = [0, 1, 2, 1, 0, 1, 2, 1];
      this.voice(t, 'triangle', midi(ch[arp[st % 8]] + 12 + (st >= 8 ? 12 : 0)), len * 0.9, 0.06, { attack: 0.003 });
      if (st === 0) for (const n of ch) for (const d of [-8, 8]) this.voice(t, 'sawtooth', midi(n), len * 16, 0.022, { attack: 0.6, cut: 1300, det: d });
      if (ln) this.voice(t, 'sawtooth', midi(ln[1]), ln[2] * len, 0.045, { cut: 2200, attack: 0.08, det: 5 });
    } else if (S.id === 'calm') {
      if (drums && (st === 0 || st === 10)) this.kick(t, 0.55, 95, 45, 0.3);
      if (drums && (st === 4 || st === 12)) this.noise(t, 0.14, 0.14, 'bandpass', 1900, 0.7);
      if (drums && st % 2 === 0) this.noise(t, 0.04, 0.05 + (st % 4 === 0 ? 0.03 : 0), 'highpass', 6500);
      if (st === 0) this.voice(t, 'sine', midi(root), len * 7, 0.3, { attack: 0.02 });
      if (st === 10) this.voice(t, 'sine', midi(root + 7), len * 5, 0.22, { attack: 0.02 });
      if (st === 0) for (const n of ch) this.keys(t + Math.random() * 0.02, n + 12, len * 6, 0.05);
      if (st === 7) for (const n of ch.slice(1)) this.keys(t, n + 12, len * 3, 0.035);
      if (ln) this.keys(t, ln[1], ln[2] * len, 0.05);
      // Треск пластинки
      if (Math.random() < 0.5) this.noise(t + Math.random() * len, 0.008, 0.08 + Math.random() * 0.1, 'highpass', 3000);
    } else {
      if (st === 0) for (const n of ch) this.choir(t, n, len * 16, 0.05);
      if (st === 0 || st === 10) this.voice(t, 'sine', st ? 62 : 74, 0.7, 0.75, { glide: 34, attack: 0.004 });
      if (st === 0) this.voice(t, 'sine', midi(root), len * 14, 0.22, { attack: 0.3 });
      if (st === 8 && sec !== 0) for (const m of [1, 2.76, 5.4]) this.voice(t, 'sine', midi(ch[0] + 24) * m, 1.8 / m, 0.04 / m);
      if (ln) this.voice(t, 'triangle', midi(ln[1]), ln[2] * len * 1.4, 0.06, { attack: 0.05 });
      if (st % 4 === 2 && sec > 0) this.noise(t, 0.09, 0.05, 'bandpass', 4200, 3);
    }
  }

  station() {
    return this.here === 'tarven' ? TARVEN : STATIONS[this.on];
  }

  // I: выключено → станции по кругу → выключено
  cycle() {
    this.on = this.on + 1 >= STATIONS.length ? -1 : this.on + 1;
    this.a.radioOn = this.on >= 0;
    this.switchT = 0.35;
    this.step = 0;
    if (this.a.ctx && this.built) this.next = this.a.ctx.currentTime + 0.3;
    if (this.on < 0) { this.hideNews(); return 'РАДИО: ВЫКЛ'; }
    // Позывной станции чуть позже
    this.queue = this.queue.filter((q) => q.kind !== 'ident');
    this.queue.unshift({ kind: 'ident', at: this.t + 2.5, exp: this.t + 30 });
    const S = this.here === 'tarven' ? TARVEN : STATIONS[this.on];
    return `РАДИО: ${S.name}${S.freq ? ' ' + S.freq : ''}`;
  }

  // ---------------------------------------------------------------- события
  // kind — ключ NEWS (или TARVEN_EVENTS при tarven), d — подстановки {name}, {where}, {min}
  event(kind, d = {}) {
    const tar = kind.startsWith('tarven:');
    const key = tar ? kind.slice(7) : kind;
    const N = tar ? TARVEN_EVENTS[key] : NEWS[key];
    if (!N) return;
    if ((this.cds[kind] || -1e9) > this.t) return;
    this.cds[kind] = this.t + (N.cd || 0);
    let text = pick(N.lines);
    for (const k in d) text = text.replace(`{${k}}`, d[k]);
    // Свежее — вперёд; старое ждёт не больше 90 с (успеть включить радио или вернуться в зону сигнала)
    // Итог сцены отменяет её ещё не прозвучавший анонс
    const intro = PAIR[kind];
    this.queue = this.queue.filter((q) => q.kind !== kind && q.kind !== intro);
    this.queue.push({ kind, text, tar, at: this.t + (d.now ? 0.5 : 2 + Math.random() * 2), exp: this.t + 90 });
    if (this.queue.length > 4) this.queue.shift();
    if (this.on < 0 && !this.hinted && !tar) {
      this.hinted = true;
      this.world.hud?.toast('I — РАДИО: ПРО ТЕБЯ УЖЕ ГОВОРЯТ', 3.2);
    }
  }

  // Слежка за миром: что произошло с прошлого кадра
  watch(ctx) {
    const { player, city, air, planetMap, blackHole, region } = ctx;
    const P = this.prev, p = player.pos;
    const d = city.destroyed;
    if (P.d != null) {
      if (d < P.d && P.d >= 3) this.event('restored');
      for (const n of [1, 10, 40, 100, 250]) if (P.d < n && d >= n && region === 'sol' && !planetMap.active) this.event('destroy' + n);
    }
    P.d = d;
    const low = region === 'sol' && !planetMap.active && p.y < 2500 && p.y > -100;
    if (player.supersonic && !P.sonic && low) this.event('sonic');
    P.sonic = player.supersonic;
    const up = region === 'sol' && p.y > SPACE.atmosphere * 1.5;
    if (up && !P.up && !planetMap.active) this.event('space');
    P.up = up;
    const body = planetMap.active ? planetMap.body : null;
    if (body && body !== P.body && body.sys === 'sol') {
      if (body.id === 'moon') this.event('moon');
      else if (body.star) this.event('sun');
      else this.event('planet', { name: body.name });
    }
    P.body = body;
    const bh = blackHole && !blackHole.off && blackHole.fall;
    if (bh && !P.bh) this.event('blackhole');
    P.bh = bh;
    // Ушёл из Солнечной системы и вернулся
    if (region !== 'sol' && P.region === 'sol') this.goneAt = this.t;
    if (region === 'sol' && P.region && P.region !== 'sol' && this.t - this.goneAt > 20) {
      const m = Math.max(1, Math.round((this.t - this.goneAt) / 60));
      this.event('gone', { min: m === 1 ? 'минуту' : m < 5 ? `${m} минуты` : `${m} минут` });
    }
    P.region = region;
    const heli = air?.heli?.state === 'crash';
    if (heli && !P.heli) this.event('heli');
    P.heli = heli;
    const h = player.held;
    const hk = h ? (h.kind === 'car' ? (h.ref?.type === 'bus' ? 'busLift' : 'carLift') : h.kind === 'person' ? 'personHeld' : '') : '';
    if (hk && hk !== P.held && low) this.event(hk, { where: where(p) });
    P.held = hk;
  }

  // ---------------------------------------------------------------- кадр
  // live — радио может играть (Симулятор, не меню и не фоторежим)
  update(dt, live, ctx) {
    this.t += dt;
    const { player, region, planetMap, xarron } = ctx;
    this.here = region === 'xarron' && planetMap.active && planetMap.body?.id === 'xarron' && xarron?.active ? 'tarven' : region === 'sol' && !planetMap.active ? 'earth' : 'none';
    if (live) this.watch(ctx);
    const a = this.a;
    a.radioOn = this.on >= 0 && live;
    // Сигнал: над Землёй слабеет за атмосферой, на чужих планетах и в межзвёздном — нет
    let sig = 0;
    if (this.here === 'earth') sig = 1 - Math.min(1, Math.max(0, (player.pos.y - SPACE.atmosphere * 2) / (SPACE.atmosphere * 6)));
    else if (this.here === 'tarven') sig = 1;
    const playing = this.on >= 0 && live;
    this.badge?.classList.toggle('show', playing);
    if (playing && this.badge) {
      const S = this.station();
      const txt = sig < 0.15 ? `РАДИО · НЕТ СИГНАЛА` : `РАДИО · ${S.name}${S.freq ? ' ' + S.freq : ''}`;
      if (this.badge.textContent !== txt) this.badge.textContent = txt;
    }
    if (!a.ctx) return;
    if (!this.built) this.build();
    if (this.masterRef !== a.master) this.connectOut();
    const now = a.ctx.currentTime;
    if (this.switchT > 0) this.switchT -= dt;
    const vol = playing ? 0.085 * Math.min(1, sig * 1.4) : 0;
    this.bus.gain.setTargetAtTime(vol, now, playing ? 0.4 : 0.25);
    this.lp.frequency.setTargetAtTime(2400 + 8600 * sig, now, 0.3);
    const hiss = playing ? 0.012 * (1 - sig) + (this.switchT > 0 ? 0.03 : 0) : 0;
    this.hiss.gain.setTargetAtTime(hiss, now, 0.08);
    this.duck.gain.setTargetAtTime(this.newsT > 0 ? 0.35 : 1, now, 0.25);
    // Ноты станции
    if (!playing || sig < 0.05 || this.bus.gain.value < 0.001 && vol === 0) {
      this.next = now + 0.1;
    } else {
      const S = this.station();
      if (this.lastS !== S) { this.lastS = S; this.step = 0; this.next = now + 0.15; }
      if (this.next < now - 0.3) this.next = now + 0.05;   // вкладка спала — не догоняем
      const len = 60 / S.bpm / 4;
      while (this.next < now + 0.15) {
        const sw = S.swing && this.step % 4 === 2 ? S.swing * len : 0;
        this.playStep(S, this.next + sw, this.step);
        this.next += len;
        this.step++;
      }
    }
    // Новости
    if (this.newsT > 0 && (this.newsT -= dt) <= 0) this.hideNews();
    this.queue = this.queue.filter((q) => q.exp > this.t);
    if (!playing || sig < 0.3 || this.newsT > 0 || xarron?.radioT > 0) return;
    const tar = this.here === 'tarven';
    // Сначала позывной станции, потом новости своего мира
    const q = this.queue.find((q) => q.at <= this.t && q.kind === 'ident') || this.queue.find((q) => q.at <= this.t && q.kind !== 'ident' && !!q.tar === tar);
    if (q) {
      this.queue.splice(this.queue.indexOf(q), 1);
      this.say(q.kind === 'ident' ? this.station().ident : q.text);
      return;
    }
    if ((this.fillT -= dt) <= 0) {
      this.fillT = 70 + Math.random() * 60;
      if (tar) this.say(pick(TARVEN_NEWS));
      else {
        const env = ctx.env, r = Math.random();
        if (r < 0.2) this.say(WEATHER[env.weatherIndex] || WEATHER[0]);
        else if (r < 0.35) this.say(this.timeLine(env.hour));
        else this.say(pick(FILLER));
      }
    }
  }

  timeLine(h) {
    if (h < 5.7 || h >= 22) return `Ночной эфир. ${CITY === 'город' ? 'Город' : CITY} спит, огни горят. Спокойной ночи — и мягкой посадки.`;
    if (h < 11) return 'Доброе утро! Кофе, тосты и прогноз: возможны пролёты героя.';
    if (h < 17) return 'День в городе. Пейте воду и не забывайте смотреть вверх.';
    return 'Вечер. Пробки на мостах, закат и музыка — оставайтесь с нами.';
  }

  say(text) {
    const S = this.station();
    this.el.textContent = `${S.name} · ${text}`;
    this.el.classList.remove('hidden');
    this.newsT = 4 + text.length / 16;
    this.fillT = Math.max(this.fillT, 25);
    // Позывной: три ноты мимо провала
    if (this.built) {
      const t = this.a.ctx.currentTime + 0.05;
      const notes = this.here === 'tarven' ? [72, 75, 79] : [76, 79, 84];
      notes.forEach((n, i) => this.voice(t + i * 0.13, 'sine', midi(n), 0.5, 0.06, { dest: this.out }));
    }
  }

  hideNews() {
    if (this.newsT > 0 || !this.el.classList.contains('hidden')) {
      if (!(this.world.xarron?.radioT > 0)) this.el.classList.add('hidden');
    }
    this.newsT = 0;
  }

  // K: очередь и строка новостей — заново; prev не трогаем, чтобы восстановление города попало в новости
  reset() {
    this.queue.length = 0;
    this.hideNews();
  }
}
