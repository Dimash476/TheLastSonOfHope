"""Локальный сервер для игры: как `python -m http.server`, но без кэширования,
чтобы браузер всегда загружал свежие версии файлов после обновлений.

Ещё он запускает и останавливает управление с камеры (GameTracking/Moves.py),
когда игра переключается в режим «Камера» (Ctrl):
  POST /tracking/start   — запустить (если уже работает — ничего не делает)
  POST /tracking/stop    — остановить
  GET  /tracking/status  — {"running": bool, "error": "последняя строка лога"}
  GET  /tracking/stream  — поток жестов для игры (text/event-stream): Moves.py печатает
                           по строке JSON на кадр, сервер пересылает каждую игре
Python для скрипта (нужен mediapipe 0.10.21) ищется так: переменная TRACKING_PYTHON,
GameTracking/.venv, затем тот же Python, что у сервера."""
import atexit
import http.server
import json
import os
import subprocess
import sys
import threading
import time
from urllib.parse import urlsplit

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
ROOT = os.path.dirname(os.path.abspath(__file__))
TRACK_DIR = os.path.join(ROOT, "GameTracking")
SCRIPT = os.path.join(TRACK_DIR, "Moves.py")
LOG = os.path.join(TRACK_DIR, "Moves.log")
LOCAL = ("127.0.0.1", "::1", "::ffff:127.0.0.1")


def tracking_python():
    exe = os.path.join("Scripts", "python.exe") if os.name == "nt" else os.path.join("bin", "python")
    for c in (os.environ.get("TRACKING_PYTHON"), os.path.join(TRACK_DIR, ".venv", exe)):
        if c and os.path.isfile(c):
            return c
    return sys.executable


def kill_with_server(proc):
    """Windows: скрипт закроется вместе с сервером, даже если окно сервера просто закрыли
    (иначе камера осталась бы включённой). Процесс кладётся в «задание», которое Windows
    завершает целиком, когда закрывается последний дескриптор — то есть когда умирает сервер."""
    if os.name != "nt":
        return
    import ctypes
    from ctypes import wintypes

    class Basic(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong), ("PerJobUserTimeLimit", ctypes.c_longlong),
                    ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
                    ("SchedulingClass", wintypes.DWORD)]

    class Extended(ctypes.Structure):
        _fields_ = [("Basic", Basic), ("Io", ctypes.c_ulonglong * 6), ("ProcessMemoryLimit", ctypes.c_size_t),
                    ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t),
                    ("PeakJobMemoryUsed", ctypes.c_size_t)]

    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateJobObjectW.restype = wintypes.HANDLE
    global _job
    if _job is None:
        _job = k32.CreateJobObjectW(None, None)
        info = Extended()
        info.Basic.LimitFlags = 0x2000    # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        k32.SetInformationJobObject(wintypes.HANDLE(_job), 9, ctypes.byref(info), ctypes.sizeof(info))
    k32.AssignProcessToJobObject(wintypes.HANDLE(_job), wintypes.HANDLE(int(proc._handle)))


_job = None


class Tracking:
    """Один процесс Moves.py на сервер."""

    def __init__(self):
        self.proc = None
        self.log = None
        self.lock = threading.Lock()
        self.frame = None                   # последняя строка JSON от Moves.py
        self.seq = 0                        # номер кадра: поток ждёт следующий
        self.fresh = threading.Condition()

    def running(self):
        return self.proc is not None and self.proc.poll() is None

    def start(self):
        with self.lock:
            if self.running():
                return
            self._close_log()
            self.log = open(LOG, "wb")
            env = dict(os.environ, PYTHONIOENCODING="utf-8")
            flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
            self.proc = subprocess.Popen([tracking_python(), "-u", SCRIPT], cwd=TRACK_DIR, env=env,
                                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, creationflags=flags)
            threading.Thread(target=self._read, args=(self.proc, self.log), daemon=True).start()
            try:
                kill_with_server(self.proc)
            except Exception:
                pass    # без этой страховки скрипт всё равно остановится по Ctrl и при штатном выходе

    def _read(self, proc, log):
        """Строки JSON — кадры для игры, остальное (калибровка, ошибки) — в Moves.log."""
        for line in proc.stdout:
            if line.lstrip().startswith(b"{"):
                with self.fresh:
                    self.frame = line.strip()
                    self.seq += 1
                    self.fresh.notify_all()
            else:
                try:
                    log.write(line)
                    log.flush()
                except (OSError, ValueError):
                    pass    # лог уже закрыт — скрипт останавливают

    # Ждёт кадр новее seq (не дольше timeout); возвращает (seq, кадр) или None
    def next_frame(self, seq, timeout):
        with self.fresh:
            self.fresh.wait_for(lambda: self.seq != seq, timeout)
            return (self.seq, self.frame) if self.seq != seq else None

    def stop(self):
        with self.lock:
            if self.running():
                self.proc.terminate()
                try:
                    self.proc.wait(3)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
            self.proc = None    # остановили сами — это не ошибка
            self._close_log()

    def _close_log(self):
        if self.log:
            self.log.close()
            self.log = None

    def status(self):
        running = self.running()
        error = ""
        if not running and self.proc is not None and self.proc.returncode not in (0, None):
            try:
                with open(LOG, encoding="utf-8", errors="replace") as f:
                    lines = [l.strip() for l in f if l.strip() and not l.startswith(("W0000", "I0000", "INFO:"))]
                error = lines[-1] if lines else f"код выхода {self.proc.returncode}"
            except OSError:
                error = f"код выхода {self.proc.returncode}"
        return {"running": running, "error": error[-200:]}


tracking = Tracking()
atexit.register(tracking.stop)


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, *args):
        pass  # не засоряем консоль

    # Управлять камерой можно только с этого компьютера и только со страницы самой игры
    def _allowed(self, need_header):
        if self.client_address[0] not in LOCAL:
            return False
        origin = self.headers.get("Origin")
        if origin and urlsplit(origin).hostname not in ("localhost", "127.0.0.1"):
            return False
        # Свой заголовок: чужой сайт не сможет отправить его без разрешения CORS — запуск камеры только из игры
        return not need_header or self.headers.get("X-Hope-Tracking") == "1"

    def _json(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/tracking/status":
            return self._json(200, tracking.status()) if self._allowed(False) else self._json(403, {})
        if path == "/tracking/stream":
            return self._stream() if self._allowed(False) else self._json(403, {})
        super().do_GET()

    # Поток жестов: каждый кадр Moves.py — событие; пока кадров нет, раз в секунду — пустая строка-«пульс»
    def _stream(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        seq = tracking.seq
        try:
            while True:
                got = tracking.next_frame(seq, 1.0)
                if got:
                    seq, frame = got
                    self.wfile.write(b"data: " + frame + b"\n\n")
                else:
                    self.wfile.write(b":\n\n")
                self.wfile.flush()
        except (OSError, ValueError):
            pass    # вкладку закрыли

    def do_POST(self):
        path = urlsplit(self.path).path
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(min(length, 4096))
        if path == "/tracking/start":
            if not self._allowed(True):
                return self._json(403, {"ok": False})
            try:
                tracking.start()
            except OSError as e:
                return self._json(500, {"ok": False, "error": str(e)})
            return self._json(200, {"ok": True})
        if path == "/tracking/stop":
            # Остановить можно и без заголовка (sendBeacon при закрытии вкладки его не шлёт)
            if not self._allowed(False):
                return self._json(403, {"ok": False})
            tracking.stop()
            return self._json(200, {"ok": True})
        self.send_error(404)


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    print(f"The Last son of Hope: http://localhost:{PORT}")
    try:
        http.server.ThreadingHTTPServer(("", PORT), NoCacheHandler).serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        tracking.stop()
