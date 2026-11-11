"use strict";
/* 三角洲行动 · 改枪码工作台 —— Node 服务器核心（零依赖，Electron 内置运行）
 * 与 Python 便携版（server.py）API 完全一致。 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const fileparse = require("./fileparse");

const CATEGORIES = ["突击步枪", "冲锋枪", "轻机枪", "精确射手步枪", "狙击枪", "霰弹枪", "手枪", "其他"];
const VERSION = "1.1.0";
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function lanIp() {
  const ifs = os.networkInterfaces();
  for (const list of Object.values(ifs)) {
    for (const it of list || []) {
      if (it.family === "IPv4" && !it.internal) return it.address;
    }
  }
  return "127.0.0.1";
}

function createServerCore({ dataDir, port = 8137, appDir, host = "0.0.0.0" }) {
  const DATA_FILE = path.join(dataDir, "guns.json");
  const BACKUP_DIR = path.join(dataDir, "backups");
  const APP_DIR = path.resolve(appDir);
  let lastBackupDay = "";

  const loadGuns = () => {
    try {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      return Array.isArray(data) ? data : [];
    } catch (e) {
      if (e.code !== "ENOENT") {
        let bad = "";
        try {
          bad = DATA_FILE + ".corrupt-" + Math.floor(Date.now() / 1000);
          fs.renameSync(DATA_FILE, bad);
        } catch {}
        console.warn("[警告] 数据文件解析失败，已备份为", path.basename(bad));
      }
      return null; // 文件不存在
    }
  };

  const saveGuns = guns => {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    // 每天首次写入前滚动备份上一版数据，保留 7 份
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    if (lastBackupDay !== today && fs.existsSync(DATA_FILE)) {
      try {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
        fs.copyFileSync(DATA_FILE, path.join(BACKUP_DIR, "guns-" + today + ".json"));
        lastBackupDay = today;
        const olds = fs.readdirSync(BACKUP_DIR).filter(f => /^guns-\d{8}\.json$/.test(f)).sort();
        for (const f of olds.slice(0, -7)) fs.unlinkSync(path.join(BACKUP_DIR, f));
      } catch {}
    }
    const tmp = DATA_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(guns, null, 2), "utf8");
    fs.renameSync(tmp, DATA_FILE); // 原子替换
  };

  if (loadGuns() === null) saveGuns([{
    id: "example-1", category: "突击步枪", name: "示例 · M4A1（可删除）", code: "A1B2C3D4E5",
    note: "点卡片上的改枪码即可复制。点右下角「＋」新增，或在弹窗里切到「导入文件」批量导入。",
    updatedAt: Date.now(),
  }]);

  const newId = () => Date.now() + "-" + Math.random().toString(16).slice(2, 8);
  const revOf = guns => guns.length ? guns.length + "-" + Math.max(...guns.map(g => g.updatedAt || 0)) : "0-0";

  function cleanGun(raw) {
    if (!raw || typeof raw !== "object") return null;
    const code = String(raw.code || "").trim();
    const name = String(raw.name || "").trim();
    if (!code || !name) return null;
    const cat = CATEGORIES.includes(raw.category) ? raw.category : "其他";
    return {
      id: String(raw.id || newId()).slice(0, 64),
      category: cat,
      name: name.slice(0, 40),
      code: code.slice(0, 80),
      note: String(raw.note || "").trim().slice(0, 200),
      updatedAt: Number(raw.updatedAt) || Date.now(),
    };
  }

  function sendJson(res, obj, status = 200) {
    const body = Buffer.from(JSON.stringify(obj), "utf8");
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length, "Cache-Control": "no-store" });
    res.end(body);
  }
  function readBody(req, limit = 20 * 1024 * 1024) {
    return new Promise(resolve => {
      const n = parseInt(req.headers["content-length"] || "0", 10) || 0;
      if (n <= 0 || n > limit) return resolve(null);
      const chunks = [];
      let got = 0;
      req.on("data", c => { got += c.length; if (got > limit) { resolve(null); req.destroy(); } else chunks.push(c); });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", () => resolve(null));
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = (req.url || "/").split("?")[0].split("#")[0];
    try {
      /* ---- API ---- */
      if (url === "/api/guns" && req.method === "GET") {
        return sendJson(res, { guns: loadGuns() || [], rev: revOf(loadGuns() || []) });
      }
      if (url === "/api/guns" && req.method === "POST") {
        const gun = cleanGun(JSON.parse((await readBody(req)) || "{}"));
        if (!gun) return sendJson(res, { error: "枪名和改枪码不能为空" }, 400);
        const guns = loadGuns() || [];
        gun.id = newId(); gun.updatedAt = Date.now();
        guns.unshift(gun); saveGuns(guns);
        return sendJson(res, gun);
      }
      if (url === "/api/heartbeat" && req.method === "POST") return sendJson(res, { ok: true });
      if (url === "/api/info" && req.method === "GET") {
        const guns = loadGuns() || [];
        return sendJson(res, {
          version: VERSION, port,
          lanUrl: "http://" + lanIp() + ":" + port,
          localUrl: "http://localhost:" + port,
          categories: CATEGORIES, rev: revOf(guns),
        });
      }
      let m;
      if ((m = url.match(/^\/api\/guns\/([\w-]+)$/)) && req.method === "PUT") {
        const patch = cleanGun(JSON.parse((await readBody(req)) || "{}"));
        if (!patch) return sendJson(res, { error: "枪名和改枪码不能为空" }, 400);
        const guns = loadGuns() || [];
        const i = guns.findIndex(g => g.id === m[1]);
        if (i < 0) return sendJson(res, { error: "未找到该记录" }, 404);
        patch.id = m[1]; patch.updatedAt = Date.now();
        guns[i] = patch; saveGuns(guns);
        return sendJson(res, patch);
      }
      if ((m = url.match(/^\/api\/guns\/([\w-]+)$/)) && req.method === "DELETE") {
        const guns = loadGuns() || [];
        const rest = guns.filter(g => g.id !== m[1]);
        if (rest.length === guns.length) return sendJson(res, { error: "未找到该记录" }, 404);
        saveGuns(rest);
        return sendJson(res, { ok: true });
      }
      if (url === "/api/import" && req.method === "POST") {
        let body = null;
        try { body = JSON.parse((await readBody(req)) || "null"); } catch {}
        const items = body && typeof body === "object" && !Array.isArray(body) ? body.guns : body;
        const mode = body && body.mode === "merge" ? "merge" : "replace";
        if (!Array.isArray(items)) return sendJson(res, { error: "格式不正确" }, 400);
        const cleaned = items.map(cleanGun).filter(Boolean);
        if (mode === "merge") {
          const guns = loadGuns() || [];
          const seen = new Set(guns.map(g => String(g.code || "").toUpperCase()));
          const added = [];
          for (const g of cleaned) {
            const k = g.code.toUpperCase();
            if (seen.has(k)) continue;
            seen.add(k);
            g.updatedAt = Date.now();
            guns.unshift(g);
            added.push(g);
          }
          saveGuns(guns);
          return sendJson(res, { ok: true, mode: "merge", added: added.length, skipped: cleaned.length - added.length, guns: added });
        }
        saveGuns(cleaned);
        return sendJson(res, { ok: true, mode: "replace", count: cleaned.length });
      }
      if (url === "/api/import/file" && req.method === "POST") {
        const raw = await readBody(req);
        if (!raw) return sendJson(res, { error: "文件内容为空或超过 20MB 上限" }, 400);
        let fname = "未命名文件";
        try { fname = decodeURIComponent(req.headers["x-filename"] || fname); } catch {}
        const result = fileparse.parseFile(fname, raw);
        if (result.error) return sendJson(res, result, 400);
        return sendJson(res, result);
      }

      /* ---- 静态文件 ---- */
      let rel = url === "/" ? "index.html" : url.slice(1);
      const full = path.resolve(APP_DIR, rel);
      if (!full.startsWith(APP_DIR + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("404 Not Found");
      }
      const body = fs.readFileSync(full);
      res.writeHead(200, { "Content-Type": MIME[path.extname(full).toLowerCase()] || "application/octet-stream", "Content-Length": body.length, "Cache-Control": "no-store" });
      res.end(body);
    } catch (e) {
      try { sendJson(res, { error: "服务器内部错误：" + String(e.message || e).slice(0, 120) }, 500); } catch {}
    }
  });

  return new Promise((resolve, reject) => {
    let tries = 0;
    const tryListen = p => {
      server.once("error", err => {
        if (err.code === "EADDRINUSE" && tries < 20) tryListen(++tries);
        else reject(err);
      });
      server.listen(p, host, () => resolve({ port: p, stop: () => server.close() }));
    };
    tryListen(port);
  });
}

module.exports = { createServerCore, CATEGORIES, VERSION };
