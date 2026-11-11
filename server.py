#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
三角洲行动 · 改枪码工作台 —— 本地轻量服务器
- 提供网页 (app/) 与数据接口 (/api/guns)
- 数据保存在 data/guns.json，纯本地文件，随时可备份
- 监听 0.0.0.0：同一 WiFi 下手机可直接访问，用于在手机上收藏改枪码
仅用 Python 标准库，无任何第三方依赖。
"""
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fileparse  # 多格式文件解析（MD/Word/Excel/CSV/TXT）

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.join(BASE_DIR, "app")
DATA_FILE = os.path.join(BASE_DIR, "data", "guns.json")
PORT = int(os.environ.get("PORT", "8137"))
LOCK = threading.Lock()

# ---- 页面心跳：用于「全部窗口关闭后自动退出服务」，不留后台进程 ----
STARTED = time.monotonic()
HB = {"first": None, "last": None}
HB_FIRST_GRACE = float(os.environ.get("HB_FIRST_GRACE", "600"))  # 启动后等待首个页面连接的最长时间
HB_STALE = float(os.environ.get("HB_STALE", "240"))              # 最后一次心跳后多久退出
# 注意：浏览器会把后台/最小化窗口的定时器节流到最低约 1 次/分钟，
# 因此容忍窗口取 4 分钟，避免窗口还在使用中就被误杀。

CATEGORIES = ["突击步枪", "冲锋枪", "轻机枪", "精确射手步枪", "狙击枪", "霰弹枪", "手枪", "其他"]

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}

EXAMPLE_GUN = {
    "id": "example-1",
    "category": "突击步枪",
    "name": "示例 · M4A1（可删除）",
    "code": "A1B2C3D4E5",
    "note": "点卡片上的改枪码即可复制，去游戏「改枪-导入方案」里粘贴。右上角「新增改枪码」可添加自己的码。",
    "updatedAt": int(time.time() * 1000),
}


def load_guns():
    """读取数据文件；文件不存在返回 None（用于首次初始化）"""
    try:
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except FileNotFoundError:
        return None
    except Exception as e:
        # 损坏的数据先就地备份再继续，绝不直接覆盖丢失
        bad = ""
        try:
            bad = DATA_FILE + ".corrupt-%d" % int(time.time())
            os.replace(DATA_FILE, bad)
        except OSError:
            pass
        print("[警告] 数据文件解析失败(%s)，原文件已备份为 %s，将以空数据继续" % (e, os.path.basename(bad)))
        return []


_LAST_BACKUP = {"day": ""}


def _daily_backup():
    """每天首次写入前，把当前数据滚动备份到 data/backups/，保留最近 7 份"""
    today = time.strftime("%Y%m%d")
    if _LAST_BACKUP["day"] == today or not os.path.isfile(DATA_FILE):
        return
    try:
        bdir = os.path.join(os.path.dirname(DATA_FILE), "backups")
        os.makedirs(bdir, exist_ok=True)
        shutil.copyfile(DATA_FILE, os.path.join(bdir, "guns-%s.json" % today))
        _LAST_BACKUP["day"] = today
        olds = sorted(f for f in os.listdir(bdir) if re.fullmatch(r"guns-\d{8}\.json", f))
        for f in olds[:-7]:
            os.remove(os.path.join(bdir, f))
    except OSError as e:
        print("[警告] 自动备份失败:", e)


def save_guns(guns):
    os.makedirs(os.path.dirname(DATA_FILE), exist_ok=True)
    _daily_backup()  # 备份的是写入前的上一版数据
    tmp = DATA_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(guns, f, ensure_ascii=False, indent=2)
    os.replace(tmp, DATA_FILE)  # 原子写入，避免写一半损坏


def new_id():
    return "%d-%s" % (int(time.time() * 1000), os.urandom(3).hex())


def clean_gun(raw):
    """校验并清洗一条改枪码记录，防止脏数据写入文件"""
    if not isinstance(raw, dict):
        return None
    code = str(raw.get("code") or "").strip()
    name = str(raw.get("name") or "").strip()
    if not code or not name:
        return None
    cat = str(raw.get("category") or "").strip()
    if cat not in CATEGORIES:
        cat = "其他"
    return {
        "id": str(raw.get("id") or new_id()),
        "category": cat,
        "name": name[:40],
        "code": code[:80],
        "note": str(raw.get("note") or "").strip()[:200],
        "updatedAt": int(raw.get("updatedAt") or time.time() * 1000),
    }


def rev_of(guns):
    """数据版本号：条数 + 最新更新时间，客户端轮询时用来判断是否有变化"""
    if not guns:
        return "0-0"
    return "%d-%d" % (len(guns), max(g.get("updatedAt", 0) for g in guns))


def lan_ip():
    """取本机局域网 IP（不真正发包，仅确定出口地址）"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("223.5.5.5", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def _find_exe(candidates):
    for p in candidates:
        if os.path.isfile(p):
            return p
    return None


def open_app_window(url):
    """优先用 Edge/Chrome 的 --app 模式打开独立小窗口（类小程序，无浏览器界面），
    找不到时退回系统默认浏览器。"""
    exe = _find_exe([
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    ])
    if exe:
        try:
            subprocess.Popen([exe, "--app=" + url, "--window-size=430,780"])
            return
        except OSError:
            pass
    threading.Timer(0.3, lambda: webbrowser.open(url)).start()


def _is_our_server():
    """端口被占用时，确认是不是本工具自己的服务"""
    try:
        from urllib.request import urlopen
        with urlopen("http://localhost:%d/api/info" % PORT, timeout=2) as r:
            return b"localUrl" in r.read(500)
    except Exception:
        return False


def _alert(msg):
    """无控制台（pythonw）情况下也能弹出的原生错误提示"""
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(0, msg, "改枪码工作台", 0x10)
    except Exception:
        print(msg)


def _watchdog():
    """心跳看门狗：所有页面关闭约 90 秒后静默退出，避免残留后台进程"""
    stale = 0
    while True:
        time.sleep(5)
        now = time.monotonic()
        if HB["first"] is None:
            if now - STARTED > HB_FIRST_GRACE:
                break  # 迟迟没有任何页面连接
            continue
        if now - HB["last"] > HB_STALE:
            stale += 1
            if stale >= 2:  # 连续两次确认无心跳（防止系统唤醒瞬间误判）
                break
        else:
            stale = 0
    os._exit(0)


class Handler(BaseHTTPRequestHandler):
    server_version = "GunCodes/1.0"

    # ---------- 基础输出 ----------
    def _send(self, status, ctype, body: bytes):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # 客户端提前断开是正常现象

    def _json(self, obj, status=200):
        self._send(status, "application/json; charset=utf-8",
                   json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def _content_length(self):
        try:
            return int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            return 0

    def _read_body(self):
        n = self._content_length()
        if n <= 0 or n > 1024 * 1024:
            return None
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return None

    def _read_raw(self, limit=20 * 1024 * 1024):
        n = self._content_length()
        if n <= 0 or n > limit:
            return None
        try:
            return self.rfile.read(n)
        except Exception:
            return None

    # ---------- 路由 ----------
    def do_GET(self):
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        if path == "/api/guns":
            with LOCK:
                guns = load_guns() or []
            self._json({"guns": guns, "rev": rev_of(guns)})
        elif path == "/api/info":
            with LOCK:
                guns = load_guns() or []
            self._json({
                "version": "1.1.0",
                "port": PORT,
                "lanUrl": "http://%s:%d" % (lan_ip(), PORT),
                "localUrl": "http://localhost:%d" % PORT,
                "categories": CATEGORIES,
                "rev": rev_of(guns),
            })
        else:
            self._static(path)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/guns":
            gun = clean_gun(self._read_body())
            if not gun:
                self._json({"error": "枪名和改枪码不能为空"}, 400)
                return
            with LOCK:
                guns = load_guns() or []
                gun["id"] = new_id()
                gun["updatedAt"] = int(time.time() * 1000)
                guns.insert(0, gun)
                save_guns(guns)
            self._json(gun)
        elif path == "/api/heartbeat":
            now = time.monotonic()
            if HB["first"] is None:
                HB["first"] = now
            HB["last"] = now
            self._json({"ok": True})
        elif path == "/api/import":
            body = self._read_body()
            items = body.get("guns") if isinstance(body, dict) else body
            mode = body.get("mode", "replace") if isinstance(body, dict) else "replace"
            if not isinstance(items, list):
                self._json({"error": "格式不正确"}, 400)
                return
            cleaned = [g for g in (clean_gun(x) for x in items) if g]
            with LOCK:
                if mode == "merge":
                    # 合并导入：按改枪码去重，已有相同码的自动跳过
                    guns = load_guns() or []
                    seen = {g.get("code", "").upper() for g in guns}
                    added = []
                    for g in cleaned:
                        k = g["code"].upper()
                        if k in seen:
                            continue
                        seen.add(k)
                        g["updatedAt"] = int(time.time() * 1000)
                        guns.insert(0, g)
                        added.append(g)
                    save_guns(guns)
                    self._json({"ok": True, "mode": "merge", "added": len(added),
                                "skipped": len(cleaned) - len(added), "guns": added})
                else:
                    save_guns(cleaned)
                    self._json({"ok": True, "mode": "replace", "count": len(cleaned)})
        elif path == "/api/import/file":
            # 多格式文件解析（只解析返回候选，不直接入库；确认后走 /api/import merge）
            from urllib.parse import unquote
            raw = self._read_raw()
            if not raw:
                self._json({"error": "文件内容为空或超过 20MB 上限"}, 400)
                return
            fname = unquote(self.headers.get("X-Filename") or "未命名文件")
            result = fileparse.parse_file(fname, raw)
            if result.get("error"):
                self._json(result, 400)
                return
            self._json(result)
        else:
            self._json({"error": "not found"}, 404)

    def do_PUT(self):
        m = re.match(r"^/api/guns/([\w-]+)$", self.path.split("?", 1)[0])
        if not m:
            self._json({"error": "not found"}, 404)
            return
        patch = clean_gun(self._read_body() or {})
        if not patch:
            self._json({"error": "枪名和改枪码不能为空"}, 400)
            return
        with LOCK:
            guns = load_guns() or []
            for i, g in enumerate(guns):
                if g.get("id") == m.group(1):
                    patch["id"] = g["id"]
                    patch["updatedAt"] = int(time.time() * 1000)
                    guns[i] = patch
                    save_guns(guns)
                    self._json(guns[i])
                    return
        self._json({"error": "未找到该记录"}, 404)

    def do_DELETE(self):
        m = re.match(r"^/api/guns/([\w-]+)$", self.path.split("?", 1)[0])
        if not m:
            self._json({"error": "not found"}, 404)
            return
        with LOCK:
            guns = load_guns() or []
            rest = [g for g in guns if g.get("id") != m.group(1)]
            if len(rest) == len(guns):
                self._json({"error": "未找到该记录"}, 404)
                return
            save_guns(rest)
        self._json({"ok": True})

    # ---------- 静态文件 ----------
    def _static(self, path):
        if path in ("", "/"):
            path = "/index.html"
        full = os.path.abspath(os.path.join(APP_DIR, path.lstrip("/")))
        if not full.startswith(os.path.abspath(APP_DIR) + os.sep) or not os.path.isfile(full):
            self._send(404, "text/plain; charset=utf-8", b"404 Not Found")
            return
        ext = os.path.splitext(full)[1].lower()
        with open(full, "rb") as f:
            self._send(200, MIME.get(ext, "application/octet-stream"), f.read())

    def log_message(self, fmt, *args):
        pass  # 静默访问日志，保持控制台清爽


def main():
    with LOCK:
        if load_guns() is None:
            save_guns([EXAMPLE_GUN])
            print("（首次运行）已创建示例数据 data/guns.json")

    try:
        srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    except OSError:
        if _is_our_server():
            open_app_window("http://localhost:%d" % PORT)  # 服务已在运行，直接再开一个窗口
        else:
            _alert("端口 %d 被其他程序占用，改枪码工作台无法启动。\n"
                   "可编辑 server.py 顶部的 PORT 换一个端口。" % PORT)
        return
    srv.daemon_threads = True

    print("=" * 52)
    print("   三角洲行动 · 改枪码工作台 已启动")
    print("   电脑访问 : http://localhost:%d" % PORT)
    print("   手机访问 : http://%s:%d   （需同一 WiFi）" % (lan_ip(), PORT))
    print("   数据文件 : data/guns.json  (可直接备份)")
    print("   提示     : 关闭全部工作台窗口后，服务约 4 分钟自动退出")
    print("=" * 52)

    if os.environ.get("NO_BROWSER") != "1":
        threading.Timer(0.6, lambda: open_app_window("http://localhost:%d" % PORT)).start()
    threading.Thread(target=_watchdog, daemon=True).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已退出，改枪码数据保存在 data/guns.json")


if __name__ == "__main__":
    main()
