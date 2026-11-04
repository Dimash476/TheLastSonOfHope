// Слой ввода.
//
// Игра читает ТОЛЬКО объект `input.state` — абстрактные «намерения» игрока.
// Его заполняют клавиатура и мышь (KeyboardMouseSource), а в режиме «Камера» —
// ещё и HandSource: жесты с веб-камеры (GameTracking/Moves.py, MediaPipe → WebSocket)
// подменяют движение. Остальной код игры не знает, откуда пришёл ввод.

export function createInputState() {
  return {
    moveX: 0,        // -1..1  влево / вправо
    moveZ: 0,        // -1..1  назад / вперёд
    moveY: 0,        // -1..1  вниз / вверх
    boost: false,    // сверхскорость
    cruise: false,   // лёгкое ускорение без сверхзвука (W + Q)
    hyper: false,    // гиперскорость (Shift + E)
    ultra: false,    // третий уровень (Shift + Q)
    warp: false,     // четвёртый уровень (Shift + F)
    boostK: null,    // 0..1 — плавный уровень ускорения с камеры (null — уровни по клавишам)
    lookDX: 0,       // накопленное смещение камеры за кадр (пиксели)
    lookDY: 0,
    punch: false,    // одиночный удар (срабатывает один кадр)
    heavyHeld: false,// мощный удар: зарядка, пока true; удар при отпускании
    slam: false,     // удар о землю (один кадр)
    slamHeld: false, // X удерживается: пике продолжается, отпустили — остановка
    laser: false,    // лазер из глаз (пока удерживается Z)
    grab: false,     // схватить / бросить (один кадр)
    dash: false,     // рывок (один кадр)
    reset: false,    // восстановить город (один кадр)
    toggleHelp: false,
    cycleTime: false,
    cycleWeather: false,
    nextTrack: false,
    interact: false, // E: действие рядом (мяч собаке, привет людям, помочь подняться)
    photo: false,    // P: фоторежим
    slowmo: false,   // V: замедление времени
    toggleControl: false, // Ctrl: управление ПК / камера
  };
}

export class KeyboardMouseSource {
  constructor(domElement, state) {
    this.dom = domElement;
    this.state = state;
    this.keys = new Set();
    this.locked = false;

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Tab') e.preventDefault();
      if (e.repeat) return;
      // Ctrl нажат отдельно (без других клавиш) — переключение ПК / камера.
      // Отдельно, чтобы случайные сочетания вроде Ctrl+W не путались с переключением
      this.ctrlSolo = e.code === 'ControlLeft' || e.code === 'ControlRight';
      this.keys.add(e.code);
      if (e.code === 'KeyX') state.slam = true;
      if (e.code === 'KeyK') state.reset = true;
      if (e.code === 'KeyH') state.toggleHelp = true;
      if (e.code === 'KeyR') state.grab = true;
      if (e.code === 'KeyB') state.punch = true;
      if (e.code === 'KeyY') state.dash = true;
      if (e.code === 'KeyT') state.cycleTime = true;
      if (e.code === 'KeyU') state.cycleWeather = true;
      if (e.code === 'KeyM') state.nextTrack = true;
      if (e.code === 'KeyE' && !e.shiftKey) state.interact = true;
      if (e.code === 'KeyP') state.photo = true;
      if (e.code === 'KeyV') state.slowmo = true;
      if (e.code === 'CapsLock') state.walk = !state.walk;
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if ((e.code === 'ControlLeft' || e.code === 'ControlRight') && this.ctrlSolo) state.toggleControl = true;
      this.ctrlSolo = false;
    });
    window.addEventListener('blur', () => this.keys.clear());

    domElement.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      if (e.button === 0) state.punch = true;
      if (e.button === 2) state.heavyHeld = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 2) state.heavyHeld = false;
    });
    window.addEventListener('contextmenu', (e) => e.preventDefault());

    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      state.lookDX += e.movementX;
      state.lookDY += e.movementY;
    });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.dom;
      if (!this.locked) { this.keys.clear(); state.heavyHeld = false; }
    });
  }

  requestLock() { this.dom.requestPointerLock(); }

  update() {
    const k = this.keys, s = this.state;
    const axis = (pos, neg) => (k.has(pos) ? 1 : 0) - (k.has(neg) ? 1 : 0);
    s.moveZ = axis('KeyW', 'KeyS');
    s.moveX = axis('KeyD', 'KeyA');
    s.boost = k.has('ShiftLeft') || k.has('ShiftRight');
    // Ctrl в сочетаниях не используем: в браузере Ctrl+W закрывает вкладку
    s.hyper = s.boost && k.has('KeyE');
    s.ultra = s.boost && k.has('KeyQ');
    s.warp = s.boost && k.has('KeyF');
    s.cruise = !s.boost && k.has('KeyQ');
    s.moveY = (k.has('Space') ? 1 : 0) - (k.has('KeyC') ? 1 : 0);
    s.slamHeld = k.has('KeyX');
    s.laser = k.has('KeyZ');
    s.boostK = null;
  }
}

// Управление с веб-камеры. GameTracking/Moves.py каждый кадр присылает:
// { calib, face, yaw, pitch (−1..1), fly, boost, k (0..1) }
//   голова     → поворот камеры (как джойстик: держишь голову повёрнутой — камера поворачивает)
//   левая рука → полёт вперёд, кулак → сверхскорость
//   правая     → k: плавный множитель сверхскорости 40^k (≈0.30 → ×3, 0.56 → ×8, 1 → ×40)
const HAND_URL = 'ws://127.0.0.1:8765';
const YAW_RATE = 2.0;     // рад/с при полном отклонении головы (чувствительность самой головы — max_x / max_up / max_down в Moves.py)
const PITCH_RATE = 1.4;
const LOOK_SMOOTH = 0.08; // с: скрипт присылает 5–15 кадров в секунду — между ними поворот меняется плавно, без ступенек

export class HandSource {
  constructor(state) {
    this.state = state;
    this.enabled = false;
    this.ws = null;
    this.msg = null;
    this.lastMsg = 0;
    this.retryT = 0;
    this.proc = 'idle';     // скрипт: idle | starting | manual (сервер не умеет запускать) | error
    this.error = '';
    this.pollT = 0;
    this.yaw = 0;           // сглаженные yaw/pitch, которыми реально крутится камера
    this.pitch = 0;
    // Закрыли вкладку в режиме камеры — просим сервер остановить скрипт
    // (а если закроют сам сервер — скрипт закроется вместе с ним)
    window.addEventListener('pagehide', () => { if (this.enabled) navigator.sendBeacon?.('/tracking/stop'); });
  }

  setEnabled(on) {
    this.enabled = on;
    this.retryT = 0;
    if (on) this.launch();
    else { this.close(); this.shutdown(); }
  }

  // server.py запускает GameTracking/Moves.py; если сервер другой (или игра не с localhost) — запуск вручную
  async launch() {
    this.proc = 'starting';
    this.error = '';
    this.pollT = 1.5;
    try {
      const r = await fetch('/tracking/start', { method: 'POST', headers: { 'X-Hope-Tracking': '1' } });
      if (!this.enabled) return;
      const j = r.ok ? await r.json() : null;
      if (!j?.ok) {
        this.proc = r.status === 404 || r.status === 501 ? 'manual' : 'error';
        this.error = j?.error || '';
      }
    } catch {
      if (this.enabled) this.proc = 'manual';
    }
  }

  shutdown() {
    if (this.proc === 'manual') return;
    this.proc = 'idle';
    fetch('/tracking/stop', { method: 'POST' }).catch(() => {});
  }

  // Пока связи нет — следим, не упал ли скрипт (нет mediapipe, занята камера…)
  async poll() {
    try {
      const j = await (await fetch('/tracking/status')).json();
      if (this.enabled && this.proc === 'starting' && !j.running && !this.live) { this.proc = 'error'; this.error = j.error; }
    } catch { /* сервер без управления камерой */ }
  }

  // Данные свежие (Moves.py работает и видит камеру)
  get live() { return !!this.msg && this.ws?.readyState === 1 && performance.now() - this.lastMsg < 600; }

  connect() {
    try { this.ws = new WebSocket(HAND_URL); } catch { this.ws = null; return; }
    this.ws.onmessage = (e) => {
      try { this.msg = JSON.parse(e.data); this.lastMsg = performance.now(); } catch { /* битое сообщение — пропускаем */ }
    };
    this.ws.onclose = () => { this.ws = null; this.msg = null; };
  }

  close() {
    if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; }
    this.msg = null;
  }

  // После клавиатуры: подменяет движение жестами. sens — чувствительность мыши камеры (рад/пиксель)
  update(dt, player, sens) {
    if (!this.enabled) return;
    if (!this.ws) {
      this.retryT -= dt;
      if (this.retryT <= 0) { this.retryT = this.proc === 'starting' ? 0.7 : 2; this.connect(); }
    }
    if (!this.live && this.proc === 'starting') {
      this.pollT -= dt;
      if (this.pollT <= 0) { this.pollT = 1; this.poll(); }
    }
    const s = this.state, m = this.live ? this.msg : null;
    const fly = !!m?.fly;
    const air = !player.grounded && !player.falling;
    s.moveX = 0;
    s.moveZ = fly ? 1 : 0;
    // С земли с рукой в кадре — взлёт. Без руки: у самой земли — мягко садимся, выше — зависаем
    s.moveY = fly ? (air ? 0 : 1) : air && player.pos.y - player.groundY < 30 ? -0.6 : 0;
    // В кулаке Колосса: каждое сжатие левого кулака — рывок на свободу
    if (player.captured) s.moveY = m?.boost ? 1 : 0;
    s.boost = !!m?.boost;
    s.hyper = s.ultra = s.warp = s.cruise = false;
    s.boostK = m ? m.k : 0;
    // Линейно: лёгкое движение головы сразу даёт заметный поворот.
    // Новое значение приходит раз в 70–250 мс — подтягиваемся к нему плавно, а не скачком
    const on = m && !m.calib;
    const a = 1 - Math.exp(-dt / LOOK_SMOOTH);
    this.yaw += ((on ? m.yaw : 0) - this.yaw) * a;
    this.pitch += ((on ? m.pitch : 0) - this.pitch) * a;
    s.lookDX += this.yaw * YAW_RATE * dt / sens;
    s.lookDY -= this.pitch * PITCH_RATE * dt / sens;
  }

  // Строка для значка в углу экрана
  status() {
    const m = this.msg;
    if (!this.live) {
      if (this.proc === 'starting') return 'КАМЕРА · ЗАПУСК…';
      if (this.proc === 'error') return `КАМЕРА · ОШИБКА: ${this.error || 'см. GameTracking/Moves.log'}`.slice(0, 90);
      return 'КАМЕРА · ЗАПУСТИТЕ GameTracking/Moves.py';
    }
    if (m.calib) return 'КАМЕРА · КАЛИБРОВКА — СМОТРИТЕ ПРЯМО';
    if (!m.face) return 'КАМЕРА · НЕ ВИЖУ ЛИЦО';
    if (!m.fly) return 'КАМЕРА · ЛЕВАЯ РУКА — ПОЛЁТ';
    return m.boost ? `КАМЕРА · СВЕРХСКОРОСТЬ ×${Math.round(40 ** m.k)}` : 'КАМЕРА · ПОЛЁТ';
  }
}

// Сбрасывает одноразовые события в конце кадра.
export function endFrame(state) {
  state.lookDX = 0;
  state.lookDY = 0;
  state.punch = false;
  state.slam = false;
  state.reset = false;
  state.toggleHelp = false;
  state.grab = false;
  state.dash = false;
  state.cycleTime = false;
  state.cycleWeather = false;
  state.nextTrack = false;
  state.interact = false;
  state.photo = false;
  state.slowmo = false;
  state.toggleControl = false;
}
