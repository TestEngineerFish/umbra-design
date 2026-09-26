import MarkdownIt from "./markdown-it.mjs";
import { diffLines, frontSummary, headings, splitFrontmatter } from "./parse.mjs";

/** Markdown 插件的正文面（M11-9b，从 `app/src/kinds/md/` 搬来）。
 *
 *  ⚠️ **这里 `new` 了第二个 MarkdownIt 实例**，而 `ui/markdown.ts` 的注释明写着
 *  「不要在别处再 new，两个实例迟早配置不一致」。这不是疏忽 ——
 *  插件在不透明源的沙箱里，**取不到宿主的任何模块**，重复是插件化的固有代价。
 *  能做的是把配置钉在这里并写进契约：`html:false` 是安全线（`.md` 算外部输入，
 *  不解析原始 HTML 就没有注入的口子），另两项决定断行与自动链接的口径。
 *  宿主那份改了配置，这里要跟着改 —— 所以两处都留了这段话。
 */
const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

const $ = (id) => document.getElementById(id);
let path = null, info = null, text = "", sha = "", mode = "render", busy = false, fmOpen = false, sel = null;

/* ── 状态 → 画面 ── */
function render() {
  const { front, body, bodyStartLine } = splitFrontmatter(text);
  const dirty = !!info && text !== (info.content ?? "");

  $("dirty").hidden = !dirty;
  if (dirty) $("diffNote").textContent = "还没落盘 · " + diffLines(info.content ?? "", text);
  $("save").disabled = busy;
  $("save").textContent = busy ? "正在落盘…" : "落盘 ⌘S";
  umbra.setDirty(dirty);

  $("render").hidden = mode !== "render";
  $("source").hidden = mode !== "source";

  if (mode === "render") {
    $("fm").hidden = front === null;
    if (front !== null) {
      $("fmSum").textContent = fmOpen ? "" : frontSummary(front);
      $("fmSum").hidden = fmOpen;
      $("fmRaw").hidden = !fmOpen; $("fmRaw").textContent = front;
      $("fmTip").textContent = fmOpen ? "收起" : "看原文";
    }
    $("body").innerHTML = md.render(body);
  } else {
    if ($("area").value !== text) $("area").value = text;
    const g = $("gutter");
    const n = text.split("\n").length;
    if (g.childElementCount !== n) {
      g.innerHTML = "";
      for (let i = 1; i <= n; i++) { const d = document.createElement("div"); d.textContent = String(i); g.appendChild(d); }
    }
    /* 选中的行在行号里标出来 —— 和原实现一致 */
    [...g.children].forEach((d, i) => d.classList.toggle("on", !!sel && i + 1 >= sel.from && i + 1 <= sel.to));
  }

  chrome(headings(body, bodyStartLine));
}

/* ── chrome：编辑栏 / 状态 / ⋯，**由宿主画** ── */
function chrome(outline) {
  umbra.setChrome({
    /* 第九轮：**展开编辑栏 = 进源码编辑，收起 = 回渲染阅读**（设计侧 §三.3）。
       ✎ 本身就是那个开关，所以这里不再有「渲染 / 源码」两档 —— 留一档给明确切换。 */
    toolbar: [{ label: "视图", items: [
      { label: "源码", active: mode === "source", title: "带行号，可直接改；⌘S 或失焦落盘" },
      { label: "渲染", active: mode === "render", title: "只读地看" },
    ] }],
    buttons: [{ label: sel ? `L${sel.from}${sel.to > sel.from ? "–" + sel.to : ""} · 已带进会话` : "选中这段给 AI" }],
    status: (info?.snapshot ?? "未改过") + (info && text !== (info.content ?? "") ? " · 未落盘" : ""),
    menu: [{ label: "版本历史" }],
  }, onHit);
  umbra.share("outline", outline);
}

async function onHit(kind, a, b) {
  if (kind === "seg" && a === 0) { mode = b === 0 ? "source" : "render"; render(); return; }
  if (kind === "button" && a === 0) { pickSelection(); return; }
  if (kind === "menu" && a === 0) { await openSnaps(); return; }
}

/* ── 读 / 写 ── */
async function load() {
  if (!path) return;
  const r = await umbra.call("read_file", { path });
  if (!r || !r.ok) { umbra.toast("读不到这个文件", (r?.errors?.[0] || {}).message, "error"); return; }
  info = r.data; text = r.data.content ?? ""; sha = r.data.sha256; sel = null;
  render();
}

async function save() {
  const dirty = !!info && text !== (info.content ?? "");
  if (!dirty || busy) return;
  busy = true; render();
  const r = await umbra.call("write_file", { path, content: text, expectSha256: sha });
  busy = false;
  if (!r || !r.ok) { umbra.toast("没落下去", (r?.errors?.[0] || {}).fix || (r?.errors?.[0] || {}).message, "error"); render(); return; }
  umbra.toast("已落盘 · 快照 " + r.data.snapshot, r.data.previous ? `上一版 ${r.data.previous} 还在，可以退回` : undefined, "ok");
  await load();
}

/** 选区 → 行范围。行号按**整个文件**算（frontmatter 计入），和大纲、会话药丸同一个坐标系 */
function pickSelection() {
  const el = $("area");
  let from, to, picked;
  if (mode === "source" && el.selectionStart !== el.selectionEnd) {
    from = text.slice(0, el.selectionStart).split("\n").length;
    to = text.slice(0, el.selectionEnd).split("\n").length;
    picked = text.slice(el.selectionStart, el.selectionEnd);
  } else {
    const s = window.getSelection();
    if (!s || s.isCollapsed) { umbra.toast("先选一段", "在渲染视图里拖选，或到源码视图里选"); return; }
    picked = s.toString();
    const idx = text.indexOf(picked.split("\n")[0] ?? "");
    if (idx < 0) { umbra.toast("这段在源文里找不到", "渲染后的文字和源文不一致时，请到源码视图里选"); return; }
    from = text.slice(0, idx).split("\n").length;
    to = from + picked.split("\n").length - 1;
  }
  sel = { from, to, text: picked };
  umbra.ask(`${path} L${from}-${to}\n${picked.slice(0, 400)}`);
  render();
}

/* ── 版本历史：**浮层由宿主画**（插件画会被矩形裁掉） ── */
async function openSnaps() {
  const r = await umbra.call("list_file_versions", { path });
  const snaps = (r?.data?.snapshots ?? []).slice().reverse();
  if (!snaps.length) { umbra.toast("还没有快照", "这个文件没经这里改过"); return; }
  const items = snaps.map((s, i) => ({
    label: `${s.version} · ${s.src}${s.note ? " · " + s.note : ""}`,
    hint: i === 0 ? "当前" : "回到这一版", disabled: i === 0,
  }));
  const pick = await umbra.menu(24, 48, items);
  const s = snaps[pick];
  if (!s || pick === 0) return;
  const back = await umbra.call("revert_file", { path, version: s.version });
  if (!back || !back.ok) { umbra.toast("退不回去", (back?.errors?.[0] || {}).message, "error"); return; }
  umbra.toast("已回到 " + s.version, `当前内容先存成了 ${back.data.snapshot}，不会丢`, "ok");
  await load();
}

/* ── 接线 ── */
$("area").addEventListener("input", (e) => { text = e.target.value; render(); });
/* `.md` 里 Enter 是换行，所以落盘是 ⌘S / 失焦，不是 Enter */
$("area").addEventListener("blur", () => void save());
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); void save(); }
});
$("discard").addEventListener("click", () => { text = info?.content ?? ""; render(); });
$("save").addEventListener("click", () => void save());
$("fmBtn").addEventListener("click", () => { fmOpen = !fmOpen; render(); });

umbra.onContext((c) => {
  document.documentElement.dataset.theme = c.theme === "dark" ? "dark" : "light";
  if (c.path !== path) { path = c.path; void load(); }
});
/* 盘上变了就重读 —— AI 改的、别的编辑器改的。插件自己发现不了 */
umbra.onChanged(() => void load());
/* 大纲点了某一条：跳过去。**跨 frame 经宿主转发** */
umbra.onShare("jump", (h) => {
  if (mode === "source") {
    const el = $("area");
    const pos = el.value.split("\n").slice(0, h.line - 1).join("\n").length + 1;
    el.focus(); el.setSelectionRange(pos, pos);
    el.scrollTop = Math.max(0, (h.line - 3) * 24);
    return;
  }
  const hit = [...$("body").querySelectorAll("h1,h2,h3,h4,h5,h6")].find((e) => e.textContent.trim() === h.text);
  if (hit) hit.scrollIntoView({ block: "start", behavior: "smooth" });
  else { mode = "source"; render(); umbra.onShare && setTimeout(() => umbra.share("jump-again", h), 0); }
});
