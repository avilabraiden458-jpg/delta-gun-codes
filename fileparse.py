#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
改枪码文件解析：Markdown / Word(.docx) / Excel(.xlsx) / CSV / TSV / TXT
仅用 Python 标准库（zipfile + XML + csv），解析结果统一为
[{category, name, code, note}, ...]，由 server.py 做最终校验与入库。
"""
import csv
import io
import re
import zipfile
import xml.etree.ElementTree as ET

MAX_ROWS = 500

CODE_TOKEN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_\-]{4,31}")   # 正文里疑似改枪码的词
SEP_ROW = re.compile(r"^:?-{2,}:?$")                          # Markdown 表格分隔行

CAT_RULES = [
    ("突击", "突击步枪"), ("ar", "突击步枪"),
    ("冲锋", "冲锋枪"), ("smg", "冲锋枪"),
    ("轻机", "轻机枪"), ("机枪", "轻机枪"), ("lmg", "轻机枪"),
    ("射手", "精确射手步枪"), ("dmr", "精确射手步枪"),
    ("狙击", "狙击枪"), ("sniper", "狙击枪"),
    ("霰弹", "霰弹枪"), ("散弹", "霰弹枪"), ("喷子", "霰弹枪"),
    ("手枪", "手枪"), ("pistol", "手枪"),
]

HEADER_HINTS = {
    "code": ("改枪码", "枪码", "分享码", "方案码", "配装码", "code"),
    "name": ("枪名", "名称", "枪械", "武器", "name", "gun"),
    "category": ("分类", "类别", "类型", "category", "type"),
    "note": ("备注", "说明", "用途", "描述", "note", "desc"),
}


def norm_cat(s):
    """把任意写法归一到游戏内的分类名；识别不了返回空串"""
    s = (s or "").strip().lower()
    if not s:
        return ""
    if s in ("其他", "其它", "other"):
        return "其他"
    for k, v in CAT_RULES:
        if k in s:
            return v
    return ""


def finish(name, code, note, cat):
    """组装一条记录，不合法的改枪码直接丢弃"""
    code = str(code or "").strip()
    # 清理复制粘贴常带的零宽字符与不可见空白，避免游戏里导入失败
    for ch in ("\u200b", "\u200c", "\u200d", "\ufeff", "\u2060", "\u00a0"):
        code = code.replace(ch, "")
    code = re.sub(r"\s+", "", code)
    if not code or len(code) > 60 or not re.search(r"[A-Za-z0-9]", code):
        return None
    name = re.sub(r"\s*\n\s*", " ", str(name or "")).strip() or "未命名"
    return {
        "category": cat or "",
        "name": name[:40],
        "code": code[:80],
        "note": str(note or "").strip()[:200],
    }


def decode_text(data):
    for enc in ("utf-8-sig", "utf-8", "gb18030", "utf-16"):
        try:
            return data.decode(enc)
        except (UnicodeDecodeError, UnicodeError):
            pass
    return data.decode("utf-8", "replace")


# ---------- 表格 → 记录（Excel / CSV / Word 表格 / MD 表格共用） ----------

def match_header(row):
    """识别表头行，返回 {字段: 列下标}；没有改枪码列则视为不是表头"""
    cm = {}
    for i, cell in enumerate(row):
        c = (cell or "").strip().lower()
        if not c:
            continue
        for key, hints in HEADER_HINTS.items():
            if key in cm:
                continue
            if any(h in c for h in hints):
                cm[key] = i
    if "code" not in cm:  # 兜底：任何带"码"字的列都当作改枪码列
        for i, cell in enumerate(row):
            if "码" in (cell or ""):
                cm["code"] = i
                break
    return cm if "code" in cm else {}


def cell_at(row, i):
    return row[i].strip() if row and i < len(row) else ""


def row_to_gun(row, cm, default_cat=""):
    code = cell_at(row, cm["code"])
    if not code or code.lower() in ("改枪码", "枪码", "分享码", "方案码", "code"):
        return None
    name = cell_at(row, cm["name"]) if "name" in cm else ""
    cat = cell_at(row, cm["category"]) if "category" in cm else ""
    note = cell_at(row, cm["note"]) if "note" in cm else ""
    if not name:  # 没有名称列：取第一个没被占用的格子
        used = set(cm.values()) | {cm.get("note")}
        for i, c in enumerate(row):
            if i not in used and (c or "").strip():
                name = c.strip()
                break
    return finish(name, code, note, norm_cat(cat) or default_cat)


def row_heuristic(row, default_cat=""):
    """无表头时的启发式：最长的字母数字格当改枪码，其余当名称/备注"""
    cells = [c.strip() for c in row if c and c.strip()]
    if not cells:
        return None
    code = ""
    for c in sorted(cells, key=len, reverse=True):
        if len(c) <= 40 and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_\- ]{3,39}", c):
            code = c.replace(" ", "")
            break
    if not code:
        return None
    rest = [c for c in cells if c != code]
    name = rest[0] if rest else ""
    note = " ".join(rest[1:]) if len(rest) > 1 else ""
    return finish(name, code, note, default_cat)


def rows_to_guns(rows, default_cat=""):
    header_i, cm = None, {}
    for i, row in enumerate(rows[:6]):
        m = match_header(row)
        if m:
            header_i, cm = i, m
            break
    out = []
    if header_i is not None:
        for row in rows[header_i + 1:]:
            g = row_to_gun(row, cm, default_cat)
            if g:
                out.append(g)
    else:
        for row in rows:
            g = row_heuristic(row, default_cat)
            if g:
                out.append(g)
    return out


# ---------- 自由文本 → 记录（TXT / MD 正文 / Word 段落） ----------

def extract_lines(lines, cur_cat=""):
    """逐行找改枪码：最长的字母数字词是码，剩余部分拆成名称与备注"""
    out = []
    prev = ""  # 上一行（标题/引导句），当前行缺名称时用
    for ln in lines:
        t = ln.strip()
        if not t:
            continue
        if t.startswith("#"):  # Markdown 标题：记为名称候选；若含分类词则切换当前分类
            h = t.lstrip("#").strip()
            c = norm_cat(h)
            if c:
                cur_cat = c
            prev = h
            continue
        t = t.lstrip("*-· ").strip()  # 去掉列表符号，避免被误当成名称的一部分
        codes = CODE_TOKEN.findall(t)
        if not codes:
            prev = t.lstrip("*-· ").strip()
            continue
        code = max(codes, key=lambda c: (len(c), -codes.index(c)))
        leftover = re.sub(r"[#>*`|]+", " ", t.replace(code, " ", 1)).strip()
        name = note = ""
        m = re.match(r"([^:：]{1,24})[:：]\s*(.*)", leftover)  # "M4A1：xxx" 形式
        if m:
            name = m.group(1).strip(" -—、，,")
            note = m.group(2).strip(" -—()（）")
        else:
            parts = leftover.split(None, 1)
            if parts:
                name = parts[0].strip(" -—、，,:：")
                if len(parts) > 1:
                    note = parts[1].strip(" -—()（）")
        if not name and prev:
            name = re.sub(r"[*_`]", "", prev)[:24]
        g = finish(name, code, note, cur_cat)
        if g:
            out.append(g)
    return out, cur_cat


# ---------- 各格式解析 ----------

def parse_md(text):
    """单遍扫描：标题随时更新分类上下文，表格结束时带着该上下文入库，
    其余自由行交给 extract_lines（内部同样遵循标题分类）。"""
    lines = text.splitlines()
    out, free = [], []
    cur_cat = ""
    tbl, fence, in_tbl = [], False, False

    def flush():
        nonlocal tbl
        if len(tbl) >= 2:
            out.extend(rows_to_guns(tbl, cur_cat))
        tbl = []

    for ln in lines:
        s = ln.strip()
        if s.startswith("```") or s.startswith("~~~"):
            fence = not fence
            if in_tbl:
                in_tbl = False
                flush()
            continue
        if fence:
            continue
        if s.startswith("|") and s.endswith("|") and s.count("|") >= 2:
            cells = [c.strip() for c in s.strip("|").split("|")]
            if cells and all(SEP_ROW.fullmatch(c) for c in cells if c):
                continue  # 分隔行
            in_tbl = True
            tbl.append(cells)
            continue
        if in_tbl:
            in_tbl = False
            flush()
        if s.startswith("#"):
            c = norm_cat(s.lstrip("#").strip())
            if c:
                cur_cat = c
        if s:
            free.append(ln)
    flush()
    free_guns, _ = extract_lines(free)
    out.extend(free_guns)
    return out


def parse_csv(text):
    first = text.splitlines()[0] if text.splitlines() else ""
    counts = {ch: first.count(ch) for ch in ("\t", ",", ";", "|")}
    delim = max(counts, key=counts.get)
    if counts[delim] == 0:
        delim = ","  # 一行里没有任何分隔符
    rows = []
    for row in csv.reader(io.StringIO(text), delimiter=delim):
        cells = [c.strip() for c in row]
        if any(cells):
            rows.append(cells)
    return rows_to_guns(rows)


XLSX_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def _col_index(ref):
    n = 0
    for ch in ref:
        if ch.isalpha():
            n = n * 26 + (ord(ch.upper()) - 64)
        else:
            break
    return n - 1


def parse_xlsx(data):
    zf = zipfile.ZipFile(io.BytesIO(data))
    shared = []
    if "xl/sharedStrings.xml" in zf.namelist():
        sst = ET.fromstring(zf.read("xl/sharedStrings.xml"))
        for si in sst.findall(XLSX_NS + "si"):
            shared.append("".join(t.text or "" for t in si.iter(XLSX_NS + "t")))
    sheets = sorted(n for n in zf.namelist() if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n))
    if not sheets:
        raise ValueError("工作簿里没有工作表")
    out = []
    for sh in sheets:  # 每个工作表独立解析（各自识别表头），跳过空表
        ws = ET.fromstring(zf.read(sh))
        rows = []
        for row in ws.iter(XLSX_NS + "row"):
            cells = {}
            for c in row.findall(XLSX_NS + "c"):
                idx = _col_index(c.get("r") or "")
                t, text = c.get("t"), ""
                if t == "s":  # 共享字符串
                    v = c.find(XLSX_NS + "v")
                    if v is not None and (v.text or "").isdigit() and int(v.text) < len(shared):
                        text = shared[int(v.text)]
                elif t == "inlineStr":
                    is_el = c.find(XLSX_NS + "is")
                    if is_el is not None:
                        text = "".join(x.text or "" for x in is_el.iter(XLSX_NS + "t"))
                else:
                    v = c.find(XLSX_NS + "v")
                    text = v.text if v is not None and v.text else ""
                if idx >= 0:
                    cells[idx] = (text or "").strip()
            if cells:
                rows.append([cells.get(i, "") for i in range(max(cells) + 1)])
        if rows:
            out.extend(rows_to_guns(rows))
    return out


W_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def parse_docx(data):
    zf = zipfile.ZipFile(io.BytesIO(data))
    body = ET.fromstring(zf.read("word/document.xml")).find(W_NS + "body")
    if body is None:
        raise ValueError("文档内容为空")
    out = []
    for el in list(body):  # 只看正文顶层：表格走表格逻辑，段落走文本逻辑
        if el.tag == W_NS + "tbl":
            trows = []
            for tr in el.findall(W_NS + "tr"):
                cells = ["".join(t.text or "" for t in tc.iter(W_NS + "t")).strip()
                         for tc in tr.findall(W_NS + "tc")]
                if any(cells):
                    trows.append(cells)
            if trows:
                out.extend(rows_to_guns(trows))
        elif el.tag == W_NS + "p":
            text = "".join(t.text or "" for t in el.iter(W_NS + "t")).strip()
            if text:
                out.extend(extract_lines([text])[0])
    return out


def parse_file(filename, data):
    """入口：按扩展名分派。返回 {"fmt":..., "guns":[...]} 或 {"error": "..."}"""
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    try:
        if ext in ("md", "markdown"):
            guns, fmt = parse_md(decode_text(data)), "Markdown(.%s)" % ext
        elif ext == "txt":
            guns, fmt = extract_lines(decode_text(data).splitlines())[0], "文本(.txt)"
        elif ext in ("csv", "tsv"):
            guns, fmt = parse_csv(decode_text(data)), "表格(.%s)" % ext
        elif ext == "xlsx":
            guns, fmt = parse_xlsx(data), "Excel(.xlsx)"
        elif ext == "docx":
            guns, fmt = parse_docx(data), "Word(.docx)"
        elif ext in ("xls", "doc"):
            return {"error": "旧版二进制 .%s 暂不支持，请在 Office 中另存为 .%sx 后重试" % (ext, ext)}
        else:
            return {"error": "暂不支持该格式，已支持：.md / .docx / .xlsx / .csv / .txt"}
    except zipfile.BadZipFile:
        return {"error": "文件已损坏或只是改了扩展名（不是真正的 Office 文件）"}
    except Exception as e:
        return {"error": "解析失败：%s" % str(e)[:100]}

    seen, dedup = set(), []  # 文件内部按改枪码去重
    for g in guns:
        if not g:
            continue
        k = g["code"].upper()
        if k in seen:
            continue
        seen.add(k)
        dedup.append(g)
    return {"fmt": fmt, "guns": dedup[:MAX_ROWS]}
