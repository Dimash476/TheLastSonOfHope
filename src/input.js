// Слой ввода.
//
// Игра читает ТОЛЬКО объект `input.state` — абстрактные «намерения» игрока.
// Сейчас его заполняет клавиатура и мышь (KeyboardMouseSource).
// На втором этапе появится HandSource (MediaPipe → WebSocket), который будет
// писать в тот же самый state — остальной код игры менять не придётся.

export function createInputState() {
  return {
    moveX: 0,        // -1..1  влево / вправо
    moveZ: 0,        // -1..1  назад / вперёд
    moveY: 0,        // -1..1  вниз / вверх
    boost: false,    // сверхскорость
    hyper: false,    // гиперскорость (Shift + E)
    ultra: false,    // третий уровень (Shift + Q)
    lookDX: 0,       // накопленное смещение камеры за кадр (пиксели)
    lookDY: 0,
    punch: false,    // одиночный удар (срабатывает один кадр)
    heavyHeld: false,// мощный удар: зарядка, пока true; удар при отпускании
    slam: false,     // удар о землю (один кадр)
    grab: false,     // схватить / бросить (один кадр)
    dash: false,     // рывок (один кадр)
    reset: false,    // восстановить город (один кадр)
    toggleHelp: false,
    cycleTime: false,
    cycleWeather: false,
    nextTrack: false,
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
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
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
    // Ctrl не используем: в браузере Ctrl+W закрывает вкладку
    s.hyper = s.boost && k.has('KeyE');
    s.ultra = s.boost && k.has('KeyQ');
    s.moveY = (k.has('Space') ? 1 : 0) - (k.has('KeyC') ? 1 : 0);
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
}
