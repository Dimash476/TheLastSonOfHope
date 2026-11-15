import { CHAPTERS, NOTES } from './chapters.js';
import { loadSave, writeSave, freshSave } from './save.js';
import { Scene } from './scene.js';
import { Beacon } from './beacon.js';
import { StoryScore, CUES } from './score.js';
import { Lighthouse } from './props.js';
import { KinFactory } from '../boss/kinmodel.js';

// Режим «Сюжет»: главы по порядку, между ними свободное время.
// Глава — модуль с методами start(C), update(C, dt, realDt, input), stop(C); закончив, она зовёт C.complete().
// Пока у главы нет модуля, она показывает титр и отпускает в свободное время (сохранение остаётся на ней).
// В свободное время зов к следующей главе — радио и знак в мире; глава начинается, когда герой долетел.

const RADIO_DELAY = 6;    // с: через сколько после конца главы звучит зов

export class Campaign {
  constructor(scene, world, { player, camRig, camera, hud, env }) {
    this.root = scene;
    this.world = world;
    this.env = env;
    this.score = new StoryScore(world.audio);
    this._lighthouse = null;
    this.player = player;
    this.camRig = camRig;
    this.camera = camera;
    this.hud = hud;
    this.scene = new Scene({ player, camRig });
    this.beacon = new Beacon(scene);
    this.active = false;
    this.save = loadSave() || freshSave();
    this.chapter = null;      // идущая глава: { def, run }
    this.free = false;        // свободное время между главами
    this.callT = -1;          // отсчёт до радио-зова
    this.token = 0;           // номер запуска: старая сцена после смены главы ничего не трогает
  }

  // Маяк Элиаса: строится при первом обращении, виден только в сюжете
  get lighthouse() {
    if (!this._lighthouse) this._lighthouse = new Lighthouse(this.root);
    return this._lighthouse;
  }

  // Модели ксарронитов для сцен сюжета: своя фабрика (Вторжение не трогаем), грузится один раз
  kinShim() {
    if (!this._shim) {
      this._shim = new Promise((resolve) => {
        const factory = new KinFactory();
        factory.whenReady(() => resolve({ world: this.world, scene: this.root, factory, fx: { hit() {}, crash() {} } }));
      });
    }
    return this._shim;
  }

  // Заранее, пока игрок в меню сюжета: музыка рендерится несколько секунд, модель Ксарга грузится
  preload() {
    this.score.prepare(Object.keys(CUES));
    this.kinShim();
  }

  get hasSave() { return !!loadSave(); }
  get current() { return CHAPTERS[Math.min(this.save.chapter, CHAPTERS.length - 1)]; }
  get finished() { return this.save.chapter >= CHAPTERS.length; }

  // Начать: с сохранения, с новой игры (fresh) или с выбранной главы (n — только пройденные и текущая)
  start({ fresh = false, n = null } = {}) {
    this.active = true;
    if (fresh) { this.save = freshSave(); writeSave(this.save); }
    else this.save = loadSave() || this.save;
    // «Продолжить» к главе с зовом — в свободное время у знака: к ней герой летит сам
    if (n === null && !this.finished && this.current.call) { this.goFree(true); this.callT = 2; return; }
    const at = n ?? (this.finished ? CHAPTERS.length - 1 : this.save.chapter);
    this.runChapter(at);
  }

  stop() {
    if (!this.active) return;
    this.stopChapter();
    this.scene.end();
    this.scene.clearRadio();
    this.beacon.hide();
    this.score.stop(0.4);
    this._lighthouse?.show(false);
    this.free = false;
    this.active = false;
  }

  stopChapter() {
    this.token++;
    if (this.chapter?.run?.stop) this.chapter.run.stop(this);
    this.chapter = null;
  }

  async runChapter(n) {
    this.stopChapter();
    this.free = false;
    this.beacon.hide();
    this.callT = -1;
    const def = CHAPTERS[n];
    const token = this.token;
    let run = null;
    if (def.run) {
      try { run = (await def.run()).default; } catch (e) { console.error('Глава не загрузилась:', e); }
      if (token !== this.token || !this.active) return;
    }
    this.chapter = { def, run };
    if (run) { run.start(this); return; }
    this.score.stop(1);
    // Главы ещё нет: только титр
    await this.scene.play(async (S) => {
      await S.fade(false, 0.6);
      await S.card(def.act, def.title, 3.6);
      S.line('', 'Эта глава ещё в работе. Пока — свободный полёт.', 3.5);
    });
    if (token === this.token) this.goFree(false);
  }

  // Глава пройдена: отметить, сохранить и дальше — следующая глава или свободное время
  complete() {
    const def = this.chapter?.def;
    if (!def) return;
    if (!this.save.done.includes(def.n)) this.save.done.push(def.n);
    // Переигранная старая глава не отматывает прогресс назад
    this.save.chapter = Math.max(this.save.chapter, def.n + 1);
    writeSave(this.save);
    this.stopChapter();
    const next = CHAPTERS[def.n + 1];
    if (next && next.next === 'auto' && this.save.chapter === def.n + 1) this.runChapter(next.n);
    else this.goFree(true);
  }

  // Свободное время: если впереди глава с зовом — ставим знак и чуть позже даём радио
  goFree(call) {
    this.free = true;
    this.chapter = null;
    const next = CHAPTERS[this.save.chapter];
    if (call && next?.call) {
      this.beacon.show(next.call);
      this.callT = RADIO_DELAY;
    }
  }

  // Флаги сюжета: что уже случилось (сохраняются)
  flag(name, v) {
    if (v === undefined) return this.save.flags[name];
    this.save.flags[name] = v;
    writeSave(this.save);
  }

  // Найдена запись Илены
  addNote(id) {
    if (!NOTES[id] || this.save.notes.includes(id)) return;
    this.save.notes.push(id);
    writeSave(this.save);
    this.scene.radio(`ЗАПИСЬ: ${NOTES[id].title}`, 3.5);
  }

  get notes() { return this.save.notes.map((id) => ({ id, ...NOTES[id] })).filter((x) => x.text); }

  // K: в главе не работает (её сцены держат мир), в свободное время — как в Симуляторе
  get resetOK() { return !this.active || this.free; }

  update(dt, realDt, input) {
    if (!this.active) return;
    const S = this.scene;
    if (S.on && input.punch) S.skip();
    S.update(realDt);
    if (this.chapter?.run?.update) this.chapter.run.update(this, dt, realDt, input);
    if (this.free) {
      if (this.callT > 0) {
        this.callT -= realDt;
        const call = CHAPTERS[this.save.chapter]?.call;
        if (this.callT <= 0 && call?.radio) S.radio(call.radio[0], call.radio[1]);
      }
      if (this.beacon.on && this.beacon.reached(this.player.pos)) this.runChapter(this.save.chapter);
    }
  }

  // Знак рисуется и на паузе — обновляем его вне шага логики
  render(dt, paused) {
    this.beacon.update(dt, this.camera);
    this._lighthouse?.update(dt, this.env.night);
    this.score.setPaused(!!paused);
  }
}
