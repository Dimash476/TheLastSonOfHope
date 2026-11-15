// Сохранение режима «Сюжет» в браузере: на какой главе игрок, что пройдено, флаги сюжета и найденные записи.
// localStorage может быть недоступен (приватное окно, запрет сайта) — тогда игра идёт без сохранения.

const KEY = 'tlsoh.story';

export const freshSave = () => ({ chapter: 0, done: [], flags: {}, notes: [] });

export function loadSave() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && Number.isInteger(s.chapter)) {
      return {
        chapter: s.chapter,
        done: Array.isArray(s.done) ? s.done : [],
        flags: s.flags && typeof s.flags === 'object' ? s.flags : {},
        notes: Array.isArray(s.notes) ? s.notes : [],
      };
    }
  } catch { /* нет сохранения */ }
  return null;
}

export function writeSave(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* без сохранения */ }
}

export function clearSave() {
  try { localStorage.removeItem(KEY); } catch { /* без сохранения */ }
}
