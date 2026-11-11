"use strict";
/* 三角洲行动 · 改枪码工作台 —— Electron 主进程
 * 启动内置服务器 + 原生小窗口（无需安装 Python 或 Edge）。 */

const { app, BrowserWindow, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { createServerCore } = require("./server-core");

let win = null;
let server = null;
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit(); // 已有实例在运行：由 second-instance 聚焦已有窗口
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  app.whenReady().then(boot).catch(err => {
    console.error("启动失败:", err);
    app.quit();
  });
}

function dataDir() {
  // 打包后写入用户数据目录（安装目录只读）；开发模式用项目内 data/
  if (app.isPackaged) {
    const d = path.join(app.getPath("userData"), "data");
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
  const d = path.join(__dirname, "data");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

async function boot() {
  server = await createServerCore({
    dataDir: dataDir(),
    appDir: path.join(__dirname, "app"),
    port: 8137,
  });
  const url = "http://localhost:" + server.port;

  // 自动化冒烟测试：--smoke 启动服务后立即退出，不创建窗口
  if (process.argv.includes("--smoke")) {
    console.log("SMOKE-OK port=" + server.port);
    setTimeout(() => app.exit(0), 600);
    return;
  }

  win = new BrowserWindow({
    width: 430,
    height: 780,
    minWidth: 360,
    minHeight: 520,
    backgroundColor: "#0b0e13",
    autoHideMenuBar: true,
    title: "改枪码工作台",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  win.loadURL(url);
  // 外部链接走系统浏览器
  win.webContents.setWindowOpenHandler(({ url: u }) => { shell.openExternal(u); return { action: "deny" }; });
  win.on("closed", () => { win = null; });
}

app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});

app.on("window-all-closed", () => {
  try { if (server) server.stop(); } catch {}
  app.quit(); // 关窗即整体退出（工具类应用，避免后台残留）
});
