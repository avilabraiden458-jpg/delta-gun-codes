"use strict";

/* ================= 基础 ================= */
const CATS = [
  { id: "突击步枪", color: "#ff8a00" },
  { id: "冲锋枪", color: "#4cc2ff" },
  { id: "轻机枪", color: "#ff5c5c" },
  { id: "精确射手步枪", color: "#7ee787" },
  { id: "狙击枪", color: "#c792ea" },
  { id: "霰弹枪", color: "#ffd166" },
  { id: "手枪", color: "#8a93a5" },
  { id: "其他", color: "#6b7480" },
];
const CAT_COLOR = Object.fromEntries(CATS.map(c => [c.id, c.color]));
const LS_KEY = "delta_gun_codes";

let MODE = "local";        // "server"（已连服务器，可手机同步） | "local"（纯本地浏览器存储）
let guns = [];
let info = null;           // /api/info 的结果
let currentCat = "全部";
let keyword = "";
let editingId = null;      // 正在编辑的记录 id；null = 新增
let pollTimer = null;
let pollFail = 0;

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const show = el => el.classList.remove("hidden");
const hide = el => el.classList.add("hidden");

/* ================= 主题颜色 ================= */
const THEMES = window.DELTA_THEMES || {};
let currentTheme = "delta";

function applyTheme(id, save) {
  const t = THEMES[id];
  if (!t) return;
  const root = document.documentElement.style;
  root.setProperty("--accent", t.accent);
  root.setProperty("--accent-2", t.accent2);
  root.setProperty("--on-accent", t.on);
  root.setProperty("--accent-rgb", t.rgb);
  if (save !== false) {
    try { localStorage.setItem("delta_theme", id); } catch {}
  }
  currentTheme = id;
  document.querySelectorAll(".theme-item").forEach(el =>
    el.classList.toggle("on", el.dataset.theme === id));
}

function openThemeModal() {
  $("#themeList").innerHTML = Object.entries(THEMES).map(([id, t]) => `
    <button class="theme-item ${id === currentTheme ? "on" : ""}" data-theme="${esc(id)}"
            style="--sw:${esc(t.accent)};--sw2:${esc(t.accent2)}">
      <i class="theme-swatch"></i><span class="name">${esc(t.name)}</span><span class="tick">✓</span>
    </button>`).join("");
  show($("#themeModal"));
}

function openSettingsModal() {
  $("#rowThemeName").textContent = (THEMES[currentTheme] || {}).name || "三角洲橙";
  show($("#settingsModal"));
}

/* ================= 启动 ================= */
async function init() {
  fillCategorySelect();
  bindEvents();
  try {
    const r = await fetch("/api/guns", { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    guns = d.guns || [];
    MODE = "server";
    fetchInfo();
    startPolling();
  } catch {
    MODE = "local";
    guns = readLocal();
  }
  if (MODE === "server") {
    // 心跳：告诉服务器「有页面在用」。全部页面关闭约 4 分钟后服务自动退出
    const beat = () => fetch("/api/heartbeat", { method: "POST" }).catch(() => {});
    beat();
    setInterval(beat, 5000);
    document.addEventListener("visibilitychange", beat); // 回到前台立即补一次心跳
  }
  // 主题：恢复上次选择（变量已在页面头部提前应用，这里只对齐状态）
  let saved = "delta";
  try { saved = localStorage.getItem("delta_theme") || "delta"; } catch {}
  if (THEMES[saved]) currentTheme = saved;
  applyTheme(currentTheme, false);
  renderSyncState();
  render();
}

function fillCategorySelect() {
  $("#fCategory").innerHTML = CATS.map(c => `<option value="${esc(c.id)}">${esc(c.id)}</option>`).join("");
}

/* ================= 数据读写 ================= */
function readLocal() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch { return []; }
}
function saveLocal() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(guns)); } catch {}
}
function normalize(raw) {
  const cat = CATS.some(c => c.id === raw.category) ? raw.category : "其他";
  return {
    id: String(raw.id || ("local-" + Date.now() + "-" + Math.floor(Math.random() * 1e4))),
    category: cat,
    name: String(raw.name || "").slice(0, 40),
    code: String(raw.code || "").slice(0, 80),
    note: String(raw.note || "").slice(0, 200),
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
}

async function apiAdd(gun) {
  if (MODE === "server") {
    const r = await fetch("/api/guns", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(gun),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "保存失败");
    const saved = await r.json();
    guns.unshift(saved); // 立即写入本地状态，无需等轮询
    return saved;
  }
  const g = normalize({ ...gun, id: null, updatedAt: Date.now() });
  guns.unshift(g); saveLocal();
  return g;
}

async function apiUpdate(gun) {
  if (MODE === "server") {
    const r = await fetch("/api/guns/" + encodeURIComponent(gun.id), {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(gun),
    });
    if (!r.ok) throw new Error("更新失败");
    const saved = await r.json();
    const i = guns.findIndex(x => x.id === saved.id);
    if (i >= 0) guns[i] = saved; else guns.unshift(saved); // 立即更新本地状态
    return saved;
  }
  const g = normalize(gun);
  const i = guns.findIndex(x => x.id === g.id);
  if (i >= 0) guns[i] = g; else guns.unshift(g);
  saveLocal();
  return g;
}

async function apiDelete(id) {
  if (MODE === "server") {
    const r = await fetch("/api/guns/" + encodeURIComponent(id), { method: "DELETE" });
    if (!r.ok) throw new Error("删除失败");
    guns = guns.filter(g => g.id !== id);
  } else {
    guns = guns.filter(g => g.id !== id);
    saveLocal();
  }
  render();
}

async function reloadFromServer() {
  const r = await fetch("/api/guns", { cache: "no-store" });
  const d = await r.json();
  guns = d.guns || [];
}

/* ================= 渲染 ================= */
function render() {
  renderSidebar();
  renderGrid();
}

function renderSidebar() {
  const counts = {};
  guns.forEach(g => { counts[g.category] = (counts[g.category] || 0) + 1; });
  const items = [{ id: "全部", color: "#e8eaee", n: guns.length }]
    .concat(CATS.map(c => ({ id: c.id, color: c.color, n: counts[c.id] || 0 })));
  $("#sidebar").innerHTML = `<i class="cat-thumb" aria-hidden="true"></i>` + items.map(it => `
    <button class="cat ${it.id === currentCat ? "on" : ""}" data-cat="${esc(it.id)}">
      <i style="background:${it.color}"></i>${esc(it.id)}<b>${it.n}</b>
    </button>`).join("");
  positionCatThumb(false);
}

/* 选中滑块：滑动到当前分类胶囊下方（animate=false 时不带动画，用于重建后对齐） */
function positionCatThumb(animate = true) {
  const thumb = document.querySelector("#sidebar .cat-thumb");
  const active = document.querySelector("#sidebar .cat.on");
  if (!thumb || !active) return;
  if (!animate) thumb.style.transition = "none";
  thumb.style.left = active.offsetLeft + "px";
  thumb.style.top = active.offsetTop + "px";
  thumb.style.width = active.offsetWidth + "px";
  thumb.style.height = active.offsetHeight + "px";
  thumb.style.opacity = "1";
  if (!animate) { void thumb.offsetHeight; thumb.style.transition = ""; }
  const rail = document.getElementById("sidebar");
  if (rail) rail.classList.toggle("draggable", rail.scrollWidth > rail.clientWidth + 1);
}

/* 点击回弹（衰减振荡） */
function pop(el) {
  if (!el) return;
  el.classList.remove("pop");
  void el.offsetWidth;
  el.classList.add("pop");
}

function visibleGuns() {
  const kw = keyword.trim().toLowerCase();
  return guns
    .filter(g => currentCat === "全部" || g.category === currentCat)
    .filter(g => !kw ||
      (g.name || "").toLowerCase().includes(kw) ||
      (g.code || "").toLowerCase().includes(kw) ||
      (g.note || "").toLowerCase().includes(kw))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function renderGrid() {
  const list = visibleGuns();
  $("#emptyText").textContent = keyword || currentCat !== "全部"
    ? "没有符合条件的改枪码" : "还没有改枪码";
  list.length ? show($("#grid")) : hide($("#grid"));
  list.length ? hide($("#empty")) : show($("#empty"));

  $("#grid").innerHTML = list.map(g => {
    const c = CAT_COLOR[g.category] || "#6b7480";
    return `
    <article class="card" data-id="${esc(g.id)}">
      <div class="card-head">
        <span class="chip" style="color:${c};border-color:${c}66">${esc(g.category)}</span>
        <h3 title="${esc(g.name)}">${hl(g.name)}</h3>
      </div>
      <button class="code" data-act="copy" title="点击复制改枪码">
        <span>${hl(g.code)}</span><span class="copy-ic">复制</span>
      </button>
      ${g.note ? `<p class="note">${hl(g.note)}</p>` : ""}
      <div class="card-foot">
        <span class="time">${timeAgo(g.updatedAt)}</span>
        <span class="ops">
          <button data-act="edit">编辑</button>
          <button data-act="del" class="danger">删除</button>
        </span>
      </div>
    </article>`;
  }).join("");
}

function timeAgo(ts) {
  if (!ts) return "";
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return "刚刚";
  if (s < 3600) return Math.floor(s / 60) + " 分钟前";
  if (s < 86400) return Math.floor(s / 3600) + " 小时前";
  if (s < 86400 * 30) return Math.floor(s / 86400) + " 天前";
  return new Date(ts).toLocaleDateString();
}

/* 搜索命中高亮（关键词含 HTML 敏感字符时跳过高亮，保证安全） */
function hl(text) {
  const safe = esc(text);
  const kw = keyword.trim();
  if (!kw || /["'&<>]/.test(kw)) return safe;
  const re = new RegExp("(" + kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi");
  return safe.replace(re, "<mark>$1</mark>");
}

/* ================= 同步状态 & 轮询 ================= */
const SYNC_ONLINE = '<i class="dot green"></i>已连接服务器 · 手机可同步';

function renderSyncState() {
  const el = $("#syncState");
  el.innerHTML = MODE === "server" ? SYNC_ONLINE
    : '<i class="dot gray"></i>本地模式（手机同步需双击「启动工作台」）';
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    // 弹窗打开或正在输入时暂停轮询，避免打断操作
    if (document.querySelector(".overlay:not(.hidden)")) return;
    const el = document.activeElement;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) return;
    try {
      const r = await fetch("/api/guns", { cache: "no-store" });
      if (!r.ok) throw 0;
      const d = await r.json();
      if (JSON.stringify(d.guns) !== JSON.stringify(guns)) {
        guns = d.guns || [];
        render();
        toast("数据已同步");
      }
      pollFail = 0;
      $("#syncState").innerHTML = SYNC_ONLINE;
    } catch {
      if (++pollFail >= 3) {
        $("#syncState").innerHTML = '<i class="dot red"></i>服务器连接中断';
      }
    }
  }, 8000);
}

/* ================= 事件绑定 ================= */
function bindEvents() {
  // 侧栏分类：滑块丝滑滑动（轻阻尼）+ 点击回弹；仅刷新卡片，不重建侧栏
  $("#sidebar").addEventListener("click", e => {
    const btn = e.target.closest(".cat");
    if (!btn || btn.classList.contains("on")) return;
    const prev = document.querySelector("#sidebar .cat.on");
    if (prev) prev.classList.remove("on");
    btn.classList.add("on");
    currentCat = btn.dataset.cat;
    positionCatThumb(true);
    pop(btn);
    renderGrid();
  });

  // 搜索
  $("#search").addEventListener("input", e => {
    keyword = e.target.value;
    renderGrid();
  });

  // 卡片操作（复制 / 编辑 / 删除）
  $("#grid").addEventListener("click", async e => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const id = btn.closest(".card")?.dataset.id;
    const gun = guns.find(g => g.id === id);
    if (!gun) return;

    if (btn.dataset.act === "copy") {
      const ok = await copyText(gun.code);
      if (ok) {
        btn.classList.add("copied");
        btn.querySelector(".copy-ic").textContent = "已复制";
        setTimeout(() => {
          btn.classList.remove("copied");
          btn.querySelector(".copy-ic").textContent = "复制";
        }, 1200);
        toast("已复制改枪码，去游戏「改枪 → 导入方案」里粘贴");
      } else {
        toast("复制失败，请长按/选中改枪码手动复制", true);
      }
    } else if (btn.dataset.act === "edit") {
      openEditor(gun);
    } else if (btn.dataset.act === "del") {
      if (confirm(`确定删除「${gun.name}」的改枪码吗？`)) {
        try { await apiDelete(id); toast("已删除"); }
        catch (err) { toast(String(err.message || err), true); }
      }
    }
  });

  // 新增（顶部按钮 + 小窗悬浮键）
  $("#btnAdd").addEventListener("click", () => openEditor(null));
  $("#fab").addEventListener("click", () => openEditor(null));

  // 弹窗通用：关闭按钮 / 点击遮罩 / Esc
  document.querySelectorAll(".overlay").forEach(ov => {
    ov.addEventListener("click", e => { if (e.target === ov) hide(ov); });
    ov.querySelectorAll("[data-close]").forEach(b =>
      b.addEventListener("click", () => hide(ov)));
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") document.querySelectorAll(".overlay:not(.hidden)")
      .forEach(ov => hide(ov));
  });

  // 保存
  $("#editorForm").addEventListener("submit", async e => {
    e.preventDefault();
    const gun = {
      id: editingId || undefined,
      category: $("#fCategory").value,
      name: $("#fName").value.trim(),
      code: $("#fCode").value.trim(),
      note: $("#fNote").value.trim(),
    };
    if (!gun.name) return toast("请填写枪械名称", true);
    if (!gun.code) return toast("请填写改枪码", true);
    // 重复改枪码提醒（改枪码是去重主键，重复保存通常意味着粘贴错了）
    const dup = guns.find(g => g.id !== editingId && (g.code || "").toLowerCase() === gun.code.toLowerCase());
    if (dup && !confirm(`改枪码 ${gun.code} 已存在于「${dup.name}」。\n仍要保存为另一条记录吗？`)) return;
    try {
      if (editingId) await apiUpdate(gun); else await apiAdd(gun);
      editorDirty = false;
      hide($("#modal"));
      render();
      toast(editingId ? "已保存修改" : "已收藏改枪码");
    } catch (err) {
      toast(String(err.message || err), true);
    }
  });

  // 编辑弹窗：分段切换 + 拖放区 + 左右滑动手势
  $("#editorSeg").addEventListener("click", e => {
    const b = e.target.closest(".seg-btn");
    if (b && b.dataset.page !== editorPage) switchEditorPage(b.dataset.page);
  });
  $("#dropzone").addEventListener("click", () => $("#importPick").click());
  $("#dropzone").addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#importPick").click(); }
  });
  let tsX = 0, tsY = 0;
  $("#editorPages").addEventListener("touchstart", e => {
    tsX = e.touches[0].clientX; tsY = e.touches[0].clientY;
  }, { passive: true });
  $("#editorPages").addEventListener("touchend", e => {
    const dx = e.changedTouches[0].clientX - tsX, dy = e.changedTouches[0].clientY - tsY;
    if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      switchEditorPage(dx < 0 ? "import" : "form");
    }
  }, { passive: true });
  // 页面内容高度变化（如备注换行）时弹性跟随
  const pageRO = new ResizeObserver(() => {
    if (!$("#modal").classList.contains("hidden")) syncEditorHeight();
  });
  document.querySelectorAll("#editorPages .epage").forEach(p => pageRO.observe(p));
  // 窗口尺寸变化 / 布局断点切换时，分类滑块重新对齐
  window.addEventListener("resize", () => positionCatThumb(false));

  // 分类栏：鼠标按住左右拖动（1:1 跟手 + 惯性阻尼滑行）；触屏保留原生顺滑滚动
  const rail = $("#sidebar");
  let dragOn = false, dragMoved = false, dragCaptured = false, captureId = -1,
      dragStartX = 0, dragStartY = 0, dragStartScroll = 0, lastX = 0, lastT = 0,
      momV = 0, momRaf = 0;

  const railScrollable = () => rail.scrollWidth > rail.clientWidth + 1;
  const railRefresh = () => rail.classList.toggle("draggable", railScrollable());
  railRefresh();

  rail.addEventListener("pointerdown", e => {
    railRefresh();
    if (e.pointerType !== "mouse" || e.button !== 0 || !railScrollable()) return;
    cancelAnimationFrame(momRaf);
    dragOn = true; dragMoved = false; dragCaptured = false; captureId = -1;
    dragStartX = lastX = e.clientX; dragStartY = e.clientY;
    dragStartScroll = rail.scrollLeft;
    momV = 0; lastT = performance.now();
    rail.classList.add("dragging-rail");
  });
  window.addEventListener("pointermove", e => {
    if (!dragOn) return;
    const dx = e.clientX - dragStartX;
    if (!dragMoved && Math.abs(dx) < 5 && Math.abs(e.clientY - dragStartY) < 5) return;
    dragMoved = true;
    // 确认进入拖动后捕获指针：鼠标移出窗口边界也能继续收尾，不卡拖拽状态
    if (!dragCaptured && e.pointerId !== undefined && rail.setPointerCapture) {
      try { rail.setPointerCapture(e.pointerId); dragCaptured = true; captureId = e.pointerId; } catch {}
    }
    e.preventDefault();   // 阻止拖动过程中的文本选择等原生行为
    const max = rail.scrollWidth - rail.clientWidth;
    rail.scrollLeft = Math.max(0, Math.min(max, dragStartScroll - dx));
    const now = performance.now();
    momV = (e.clientX - lastX) / Math.max(1, now - lastT) * 16;   // 折算每帧速度
    lastX = e.clientX; lastT = now;
  });
  const railDragEnd = e => {
    if (!dragOn) return;
    dragOn = false;
    rail.classList.remove("dragging-rail");
    if (dragCaptured && rail.hasPointerCapture && rail.hasPointerCapture(captureId)) {
      rail.releasePointerCapture(captureId);
    }
    dragCaptured = false;
    if (!dragMoved) return;
    const max = rail.scrollWidth - rail.clientWidth;
    const step = () => {                    // 惯性滑行：指数阻尼衰减，撞边软停
      if (Math.abs(momV) < 0.12) return;
      const next = rail.scrollLeft - momV;
      if (next < 0 || next > max) momV *= 0.35;
      rail.scrollLeft = Math.max(0, Math.min(max, next));
      momV *= 0.94;
      momRaf = requestAnimationFrame(step);
    };
    momRaf = requestAnimationFrame(step);
  };
  window.addEventListener("pointerup", railDragEnd);
  window.addEventListener("pointercancel", railDragEnd);
  window.addEventListener("blur", railDragEnd);              // 窗口失焦保险
  document.documentElement.addEventListener("pointerleave", railDragEnd);
  rail.addEventListener("click", e => {     // 拖动后拦截误触点击
    if (dragMoved) { e.stopPropagation(); e.preventDefault(); dragMoved = false; }
  }, true);

  // 编辑未保存时，拦截窗口关闭
  $("#editorForm").addEventListener("input", () => { editorDirty = true; });
  window.addEventListener("beforeunload", e => {
    if (editorDirty && !$("#modal").classList.contains("hidden")) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  // 设置面板（主题颜色 / 手机连接的入口收在设置里），点击带轻阻尼回弹
  $("#btnSettings").addEventListener("click", e => { pop(e.currentTarget); openSettingsModal(); });
  $("#rowTheme").addEventListener("click", e => { pop(e.currentTarget); openThemeModal(); });
  $("#rowPhone").addEventListener("click", e => { pop(e.currentTarget); openPhoneModal(); });
  $("#themeList").addEventListener("click", e => {
    const item = e.target.closest(".theme-item");
    if (item) { pop(item); applyTheme(item.dataset.theme); }
  });
  $("#btnCopyUrl").addEventListener("click", async () => {
    const ok = info && await copyText(info.lanUrl);
    toast(ok ? "地址已复制" : "复制失败，请手动输入地址", !ok);
  });

  // 备份导出 / 导入
  $("#btnExport").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(guns, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "改枪码备份-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
    toast("备份文件已导出");
  });
  $("#btnImport").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", e => {
    const f = e.target.files[0];
    if (f) importJson(f);
    e.target.value = "";
  });

  // 多格式文件导入
  $("#btnImportFile").addEventListener("click", () => $("#importPick").click());
  $("#importPick").addEventListener("change", e => {
    const f = e.target.files[0];
    if (f) handleFilePick(f);
    e.target.value = "";
  });
  $("#fileRows").addEventListener("change", updateFileCount);
  $("#btnImportConfirm").addEventListener("click", confirmFileImport);

  // 拖拽文件到窗口任意位置即可导入（进入预览，不会直接改数据）
  ["dragover", "drop"].forEach(ev =>
    document.addEventListener(ev, e => e.preventDefault()));
  document.addEventListener("dragenter", e => {
    if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) {
      document.body.classList.add("dragging");
    }
  });
  document.addEventListener("dragleave", e => {
    if (!e.relatedTarget) document.body.classList.remove("dragging");
  });
  document.addEventListener("drop", e => {
    document.body.classList.remove("dragging");
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFilePick(f);
  });
}

/* ================= 新增/编辑弹窗（双页：改枪码表单 / 导入文件） ================= */
let editorDirty = false;   // 编辑中未保存标记
let editorPage = "form";   // 当前页："form" | "import"

function switchEditorPage(p) {
  editorPage = p;
  $("#modal").classList.toggle("on-import", p === "import");
  $("#editorSeg").classList.toggle("on-import", p === "import");
  document.querySelectorAll("#editorSeg .seg-btn").forEach(b =>
    b.classList.toggle("on", b.dataset.page === p));
  $("#modalTitle").textContent = p === "import"
    ? "导入文件"
    : (editingId ? "编辑改枪码" : "新增改枪码");
  syncEditorHeight();
}

function syncEditorHeight() {
  const wrap = $("#editorPages");
  const active = wrap.querySelector(`.epage[data-page="${editorPage}"]`);
  if (active) wrap.style.height = (active.scrollHeight + 8) + "px";
}

function openEditor(gun) {
  editingId = gun ? gun.id : null;
  editorDirty = false;
  $("#fCategory").value = gun ? gun.category : (CATS.some(c => c.id === currentCat) ? currentCat : "突击步枪");
  $("#fName").value = gun ? gun.name : "";
  $("#fCode").value = gun ? gun.code : "";
  $("#fNote").value = gun ? (gun.note || "") : "";
  show($("#modal"));
  switchEditorPage("form");
  setTimeout(() => $("#f" + (gun ? "Name" : "Code"))?.focus(), 60);
}

/* ================= 手机连接弹窗 ================= */
async function fetchInfo() {
  try {
    const r = await fetch("/api/info", { cache: "no-store" });
    info = await r.json();
  } catch { info = null; }
}

async function openPhoneModal() {
  if (MODE !== "server") {
    $("#qrBox").innerHTML = `<div class="qr-fallback">当前是「本地模式」<br>手机同步功能不可用<br><br>请在电脑上双击<br><b>启动工作台.bat</b></div>`;
    $("#phoneUrl").textContent = "—";
    show($("#phoneModal"));
    return;
  }
  if (!info) await fetchInfo();
  const url = info ? info.lanUrl : "";
  $("#phoneUrl").textContent = url || "无法获取局域网地址";
  renderQR(url);
  show($("#phoneModal"));
}

function renderQR(text) {
  const box = $("#qrBox");
  if (!text) {
    box.innerHTML = `<div class="qr-fallback">无法生成二维码</div>`;
    return;
  }
  try {
    if (typeof qrcode === "function") {
      const qr = qrcode(0, "M");
      qr.addData(text);
      qr.make();
      box.innerHTML = qr.createSvgTag(4, 2);
      return;
    }
  } catch {}
  box.innerHTML = `<div class="qr-fallback">二维码库未加载<br>请在手机浏览器输入下方地址</div>`;
}

/* ================= 备份导入 ================= */
async function importJson(file) {
  try {
    const arr = JSON.parse(await file.text());
    const items = Array.isArray(arr) ? arr : arr.guns;
    if (!Array.isArray(items)) throw new Error("格式不正确");

    if (MODE === "server") {
      if (guns.length && !confirm(`导入备份将覆盖当前全部 ${guns.length} 条记录，\n确定继续吗？`)) return;
      const r = await fetch("/api/import", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guns: items }),
      });
      if (!r.ok) throw new Error("导入失败");
      const d = await r.json();
      await reloadFromServer();
      render();
      toast("已导入 " + d.count + " 条记录（覆盖现有数据）");
    } else {
      const key = g => (g.name || "") + "|" + (g.code || "");
      const seen = new Set(guns.map(key));
      let n = 0;
      for (const it of items) {
        if (it && it.name && it.code && !seen.has(key(it))) {
          guns.unshift(normalize(it));
          seen.add(key(it));
          n++;
        }
      }
      saveLocal();
      render();
      toast("已导入 " + n + " 条新记录（相同记录自动跳过）");
    }
  } catch (err) {
    toast("导入失败：" + (err.message || "文件格式不正确"), true);
  }
}

/* ================= 多格式文件导入（MD / Word / Excel / CSV / TXT） ================= */
let pendingRows = [];

async function handleFilePick(file) {
  if (!file) return;
  if (MODE !== "server") return toast("文件导入需要通过服务运行：请用桌面快捷方式打开", true);
  if (!/\.(md|markdown|txt|csv|tsv|xlsx|docx)$/i.test(file.name)) {
    return toast("暂不支持该格式（旧版 .doc/.xls 请先另存为 .docx/.xlsx）", true);
  }
  toast("正在解析「" + file.name + "」…");
  try {
    const buf = await file.arrayBuffer();
    const r = await fetch("/api/import/file", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Filename": encodeURIComponent(file.name),
      },
      body: buf,
    });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || "解析失败");
    if (!d.guns.length) throw new Error("文件里没有识别到改枪码");
    pendingRows = d.guns;
    $("#fileMeta").textContent = "已解析「" + file.name + "」· " + d.fmt + " · 识别到 " + d.guns.length + " 条";
    renderFileRows();
    show($("#fileModal"));
  } catch (err) {
    toast(String(err.message || err), true);
  }
}

function renderFileRows() {
  $("#fileRows").innerHTML = pendingRows.map((g, i) => {
    const c = CAT_COLOR[g.category] || "#8a93a5";
    return `
    <label class="frow">
      <input type="checkbox" checked data-i="${i}">
      <span class="frow-main">
        <span class="frow-top">
          <b>${esc(g.name || "未命名")}</b>
          ${g.category ? `<span class="chip" style="color:${c};border-color:${c}66">${esc(g.category)}</span>` : ""}
        </span>
        <code>${esc(g.code)}</code>
        ${g.note ? `<span class="frow-note">${esc(g.note)}</span>` : ""}
      </span>
    </label>`;
  }).join("");
  updateFileCount();
}

function updateFileCount() {
  const n = $("#fileRows").querySelectorAll("input:checked").length;
  $("#fileCount").textContent = "已选 " + n + " / 共 " + pendingRows.length + " 条";
  $("#btnImportConfirm").disabled = n === 0;
}

async function confirmFileImport() {
  const sel = [...$("#fileRows").querySelectorAll("input:checked")]
    .map(b => pendingRows[+b.dataset.i]);
  if (!sel.length) return;
  const btn = $("#btnImportConfirm");
  btn.disabled = true;
  try {
    const r = await fetch("/api/import", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "merge", guns: sel }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "导入失败");
    (d.guns || []).forEach(g => guns.unshift(g));
    render();
    hide($("#fileModal"));
    // 若是从新增弹窗的导入页进来的，导入完成后一并关闭弹窗
    if (!$("#modal").classList.contains("hidden")) {
      editorDirty = false;
      hide($("#modal"));
    }
    toast("已导入 " + d.added + " 条" + (d.skipped ? "，跳过 " + d.skipped + " 条重复" : ""));
  } catch (err) {
    toast(String(err.message || err), true);
  } finally {
    btn.disabled = false;
  }
}

/* ================= 工具 ================= */
async function copyText(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  // http 局域网访问（手机端）的兜底方案
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;top:-9999px;opacity:0";
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch { return false; }
}

let toastTimer = null;
function toast(msg, isErr) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("err", !!isErr);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

init();
