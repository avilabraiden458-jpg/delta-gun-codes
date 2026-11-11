"use strict";
/* 多格式文件解析（Node 版，零依赖）：Markdown / Word(.docx) / Excel(.xlsx) / CSV / TSV / TXT
 * ZIP 读取用手写的 Central Directory 解析（zlib.inflateRawSync），
 * OOXML 只需提取固定结构，用小型标签正则即可覆盖。 */

const zlib = require("zlib");
const MAX_ROWS = 500;

const CODE_TOKEN = /[A-Za-z0-9][A-Za-z0-9_\-]{4,31}/g;
const SEP_ROW = /^:?-{2,}:?$/;

const CAT_RULES = [
  ["突击", "突击步枪"], ["ar", "突击步枪"],
  ["冲锋", "冲锋枪"], ["smg", "冲锋枪"],
  ["轻机", "轻机枪"], ["机枪", "轻机枪"], ["lmg", "轻机枪"],
  ["射手", "精确射手步枪"], ["dmr", "精确射手步枪"],
  ["狙击", "狙击枪"], ["sniper", "狙击枪"],
  ["霰弹", "霰弹枪"], ["散弹", "霰弹枪"], ["喷子", "霰弹枪"],
  ["手枪", "手枪"], ["pistol", "手枪"],
];

const HEADER_HINTS = {
  code: ["改枪码", "枪码", "分享码", "方案码", "配装码", "code"],
  name: ["枪名", "名称", "枪械", "武器", "name", "gun"],
  category: ["分类", "类别", "类型", "category", "type"],
  note: ["备注", "说明", "用途", "描述", "note", "desc"],
};

/* ---------- 基础工具 ---------- */

function normCat(s) {
  s = String(s || "").trim().toLowerCase();
  if (!s) return "";
  if (["其他", "其它", "other"].includes(s)) return "其他";
  for (const [k, v] of CAT_RULES) if (s.includes(k)) return v;
  return "";
}

function finish(name, code, note, cat) {
  code = String(code || "").trim();
  for (const ch of ["\u200b", "\u200c", "\u200d", "\ufeff", "\u2060", "\u00a0"]) code = code.split(ch).join("");
  code = code.replace(/\s+/g, "");
  if (!code || code.length > 60 || !/[A-Za-z0-9]/.test(code)) return null;
  name = String(name || "").replace(/\s*\n\s*/g, " ").trim() || "未命名";
  return { category: cat || "", name: name.slice(0, 40), code: code.slice(0, 80), note: String(note || "").trim().slice(0, 200) };
}

function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString("utf16le").slice(1);
  if (buf[0] === 0xfe && buf[1] === 0xff) { // 大端 UTF-16
    const be = Buffer.from(buf);
    be.swap16();
    return be.toString("utf16le").slice(1);
  }
  const s = buf.toString("utf8");
  if (!s.includes("\uFFFD")) return s.replace(/^\uFEFF/, ""); // utf-8-sig
  return buf.toString("latin1");                              // 极端情况兜底（GBK 文本建议另存为 UTF-8）
}

/* ---------- 极简 ZIP 读取（Central Directory → zlib.inflateRawSync） ---------- */

function zipEntries(buf) {
  let i = buf.length - 22;
  while (i >= 0 && buf.readUInt32LE(i) !== 0x06054b50) i--;
  if (i < 0) throw Object.assign(new Error("not a zip"), { code: "BADZIP" });
  const count = buf.readUInt16LE(i + 10);
  let off = buf.readUInt32LE(i + 16);
  const entries = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString("utf8");
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const data = buf.slice(lho + 30 + lNameLen + lExtraLen, lho + 30 + lNameLen + lExtraLen + csize);
    entries[name] = method === 8 ? zlib.inflateRawSync(data) : method === 0 ? data : Buffer.alloc(0);
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return entries;
}

/* ---------- 极简 XML 文本提取 ---------- */

function decodeXml(s) {
  return String(s || "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
function textsIn(xml, tag) {
  const re = new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + tag + ">", "g");
  let m, out = [];
  while ((m = re.exec(xml))) out.push(decodeXml(m[1]));
  return out;
}
function cellText(chunk) { return textsIn(chunk, "w:t").join(" ").trim(); }

/* ---------- 表格 → 记录 ---------- */

function matchHeader(row) {
  const cm = {};
  row.forEach((cell, i) => {
    const c = String(cell || "").trim().toLowerCase();
    if (!c) return;
    for (const [key, hints] of Object.entries(HEADER_HINTS)) {
      if (cm[key] === undefined && hints.some(h => c.includes(h))) cm[key] = i;
    }
  });
  if (cm.code === undefined) {           // 兜底：任何带"码"字的列
    const i = row.findIndex(c => String(c || "").includes("码"));
    if (i >= 0) cm.code = i;
  }
  return cm.code !== undefined ? cm : null;
}

function cellAt(row, i) { return row && i < row.length ? String(row[i] || "").trim() : ""; }

function rowToGun(row, cm, defaultCat) {
  const code = cellAt(row, cm.code);
  if (!code || ["改枪码", "枪码", "分享码", "方案码", "code"].includes(code.toLowerCase())) return null;
  let name = cm.name !== undefined ? cellAt(row, cm.name) : "";
  const cat = cm.category !== undefined ? cellAt(row, cm.category) : "";
  const note = cm.note !== undefined ? cellAt(row, cm.note) : "";
  if (!name) {
    const used = new Set(Object.values(cm).concat(cm.note !== undefined ? [cm.note] : []));
    for (let i = 0; i < row.length; i++) {
      if (!used.has(i) && String(row[i] || "").trim()) { name = String(row[i]).trim(); break; }
    }
  }
  return finish(name, code, note, normCat(cat) || defaultCat || "");
}

function rowHeuristic(row, defaultCat) {
  const cells = row.map(c => String(c || "").trim()).filter(Boolean);
  if (!cells.length) return null;
  let code = "";
  for (const c of [...cells].sort((a, b) => b.length - a.length)) {
    if (c.length <= 40 && /^[A-Za-z0-9][A-Za-z0-9_\- ]{3,39}$/.test(c)) { code = c.replace(/\s+/g, ""); break; }
  }
  if (!code) return null;
  const rest = cells.filter(c => c !== code);
  return finish(rest[0] || "", code, rest.slice(1).join(" "), defaultCat);
}

function rowsToGuns(rows, defaultCat) {
  defaultCat = defaultCat || "";
  let headerIdx = -1, cm = null;
  for (let i = 0; i < Math.min(6, rows.length); i++) {
    const m = matchHeader(rows[i]);
    if (m) { headerIdx = i; cm = m; break; }
  }
  if (headerIdx >= 0) {
    const out = [];
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const g = rowToGun(rows[i], cm, defaultCat);
      if (g) out.push(g);
    }
    return out;
  }
  const out = [];
  for (const row of rows) {
    const g = rowHeuristic(row, defaultCat);
    if (g) out.push(g);
  }
  return out;
}

/* ---------- 自由文本 → 记录 ---------- */

function extractLines(lines, curCat) {
  curCat = curCat || "";
  const out = [];
  let prev = "";
  for (const raw of lines) {
    let t = raw.trim();
    if (!t) continue;
    if (t.startsWith("#")) {
      const h = t.replace(/^#+\s*/, "");
      const c = normCat(h);
      if (c) curCat = c;
      prev = h;
      continue;
    }
    t = t.replace(/^[*\-·\s]+/, "").trim();   // 去列表符号
    const codes = t.match(CODE_TOKEN) || [];
    if (!codes.length) { prev = t.replace(/^[*\-·\s]+/, "").trim(); continue; }
    let code = codes[0];
    for (const c of codes) if (c.length >= code.length) code = c;
    let leftover = t.replace(code, " ").replace(/[#>*`|]+/g, " ").trim();
    let name = "", note = "";
    const m = leftover.match(/^([^:：]{1,24})[:：]\s*(.*)$/);
    if (m) {
      name = m[1].replace(/^[-—、，,\s]+|[-—、，,\s]+$/g, "");
      note = m[2].replace(/^[-—()（）\s]+|[-—()（）\s]+$/g, "");
    } else {
      const parts = leftover.split(/\s+/);
      name = (parts.shift() || "").replace(/^[-—、，,:：\s]+|[-—、，,:：\s]+$/g, "");
      note = parts.join(" ").replace(/^[-—()（）\s]+|[-—()（）\s]+$/g, "");
    }
    if (!name && prev) name = prev.replace(/[*_`]/g, "").slice(0, 24);
    const g = finish(name, code, note, curCat);
    if (g) out.push(g);
  }
  return { guns: out, curCat };
}

/* ---------- Markdown ---------- */

function parseMd(text) {
  const lines = text.split(/\r?\n/);
  const out = [], free = [];
  let curCat = "", tbl = [], fence = false, inTbl = false;
  const flush = () => {
    if (tbl.length >= 2) out.push(...rowsToGuns(tbl, curCat));
    tbl = [];
  };
  for (const ln of lines) {
    const s = ln.trim();
    if (s.startsWith("```") || s.startsWith("~~~")) {
      fence = !fence;
      if (inTbl) { inTbl = false; flush(); }
      continue;
    }
    if (fence) continue;
    if (s.startsWith("|") && s.endsWith("|") && (s.match(/\|/g) || []).length >= 2) {
      const cells = s.slice(1, -1).split("|").map(c => c.trim());
      if (cells.length && cells.every(c => !c || SEP_ROW.test(c))) continue;
      inTbl = true;
      tbl.push(cells);
      continue;
    }
    if (inTbl) { inTbl = false; flush(); }
    if (s.startsWith("#")) {
      const c = normCat(s.replace(/^#+\s*/, ""));
      if (c) curCat = c;
    }
    if (s) free.push(ln);
  }
  flush();
  out.push(...extractLines(free, curCat).guns);
  return out;
}

/* ---------- CSV / TSV ---------- */

function parseCsv(text) {
  const first = text.split(/\r?\n/)[0] || "";
  const counts = { "\t": 0, ",": 0, ";": 0, "|": 0 };
  for (const ch of Object.keys(counts)) counts[ch] = first.split(ch).length - 1;
  let delim = ",";
  let best = 0;
  for (const [ch, n] of Object.entries(counts)) if (n > best) { best = n; delim = ch; }
  const rows = [];
  // 支持 CSV 双引号包裹的简单状态机
  let row = [], cell = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { row.push(cell.trim()); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell.trim()); cell = "";
      if (row.some(c => c !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell.trim());
  if (row.some(c => c !== "")) rows.push(row);
  return rowsToGuns(rows);
}

/* ---------- Excel (.xlsx) ---------- */

const colIndex = ref => {
  let n = 0;
  for (const ch of ref) {
    if (/[A-Za-z]/.test(ch)) n = n * 26 + (ch.toUpperCase().charCodeAt(0) - 64);
    else break;
  }
  return n - 1;
};

function parseXlsx(data) {
  const zip = zipEntries(data);
  let shared = [];
  if (zip["xl/sharedStrings.xml"]) {
    const sst = zip["xl/sharedStrings.xml"].toString("utf8");
    for (const si of textsIn(sst, "si")) shared.push(textsIn(si, "t").join(""));
  }
  const sheets = Object.keys(zip).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort();
  if (!sheets.length) throw new Error("工作簿里没有工作表");
  const out = [];
  for (const sh of sheets) {
    const ws = zip[sh].toString("utf8");
    const rows = [];
    const rowRe = /<row[^>]*>([\s\S]*?)<\/row>|<row[^>]*\/>/g;
    let m;
    while ((m = rowRe.exec(ws))) {
      const chunk = m[0];
      const cells = {};
      const cRe = /<c([^>]*)>([\s\S]*?)<\/c>|<c([^>]*)\/>/g;
      let cm;
      while ((cm = cRe.exec(chunk))) {
        const attrs = cm[1] || cm[3] || "";
        const inner = cm[2] || "";
        const refM = attrs.match(/r="([A-Z]+)\d+"/i);
        const idx = refM ? colIndex(refM[1]) : Object.keys(cells).length;
        const tM = attrs.match(/t="(\w+)"/);
        const t = tM ? tM[1] : "";
        let text = "";
        if (t === "s") {
          const v = inner.match(/<v[^>]*>([\s\S]*?)<\/v>/);
          const idx2 = v && /^\d+$/.test(v[1]) ? +v[1] : -1;
          text = idx2 >= 0 && idx2 < shared.length ? shared[idx2] : "";
        } else if (t === "inlineStr") {
          text = textsIn(inner, "t").join("");
        } else {
          const v = inner.match(/<v[^>]*>([\s\S]*?)<\/v>/);
          text = v ? decodeXml(v[1]) : "";
        }
        if (idx >= 0) cells[idx] = String(text || "").trim();
      }
      if (Object.keys(cells).length) {
        const width = Math.max(...Object.keys(cells).map(Number)) + 1;
        rows.push(Array.from({ length: width }, (_, i) => cells[i] || ""));
      }
    }
    if (rows.length) out.push(...rowsToGuns(rows));
  }
  return out;
}

/* ---------- Word (.docx) ---------- */

function parseDocx(data) {
  const zip = zipEntries(data);
  const xml = zip["word/document.xml"].toString("utf8");
  const W = (tag) => new RegExp("<w:" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</w:" + tag + ">|<w:" + tag + "\\s[^>]*/>", "g");
  const paraText = chunk => textsIn(chunk.replace(/<\/w:p>/g, "</w:p>\n"), "w:t").join("").replace(/\n+/g, " ").trim();
  const out = [];
  const parts = xml.split(/(<w:tbl>[\s\S]*?<\/w:tbl>)/);
  for (const part of parts) {
    if (part.startsWith("<w:tbl>")) {
      const trows = [];
      for (const trM of part.match(/<w:tr[\s\S]*?<\/w:tr>/g) || []) {
        const cells = [];
        for (const tcM of trM.match(/<w:tc[\s\S]*?<\/w:tc>/g) || []) {
          cells.push(cellText(tcM.replace(/<\/w:p>/g, " ")));
        }
        if (cells.some(c => c !== "")) trows.push(cells);
      }
      if (trows.length) out.push(...rowsToGuns(trows));
    } else {
      for (const pM of part.match(/<w:p[\s\S]*?<\/w:p>/g) || []) {
        const text = paraText(pM);
        if (text) out.push(...extractLines([text]).guns);
      }
    }
  }
  return out;
}

/* ---------- 入口 ---------- */

function parseFile(filename, data) {
  const ext = filename.includes(".") ? filename.split(".").pop().toLowerCase() : "";
  let guns, fmt;
  try {
    if (["md", "markdown"].includes(ext)) { guns = parseMd(decodeText(data)); fmt = "Markdown(." + ext + ")"; }
    else if (ext === "txt") { guns = extractLines(decodeText(data).split(/\r?\n/)).guns; fmt = "文本(.txt)"; }
    else if (ext === "csv" || ext === "tsv") { guns = parseCsv(decodeText(data)); fmt = "表格(." + ext + ")"; }
    else if (ext === "xlsx") { guns = parseXlsx(data); fmt = "Excel(.xlsx)"; }
    else if (ext === "docx") { guns = parseDocx(data); fmt = "Word(.docx)"; }
    else if (ext === "xls" || ext === "doc") return { error: "旧版二进制 ." + ext + " 暂不支持，请在 Office 中另存为 ." + ext + "x 后重试" };
    else return { error: "暂不支持该格式，已支持：.md / .docx / .xlsx / .csv / .txt" };
  } catch (e) {
    if (e.code === "BADZIP" || /inflate|invalid/i.test(String(e.message)))
      return { error: "文件已损坏或只是改了扩展名（不是真正的 Office 文件）" };
    return { error: "解析失败：" + String(e.message || e).slice(0, 100) };
  }
  const seen = new Set(), dedup = [];
  for (const g of guns) {
    if (!g) continue;
    const k = g.code.toUpperCase();
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(g);
  }
  return { fmt, guns: dedup.slice(0, MAX_ROWS) };
}

module.exports = { parseFile, finish, normCat, rowsToGuns, extractLines };
