import MarkdownIt from "markdown-it";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Core } from "../api/client";
import { timeAgo, type FileSnapshotMeta, type ReadFileResult, type Selection } from "../api/types";
import { toast } from "../ui/Toast";

/** `.md` 视图（S13 形制，M8-6 / M8-7 / M8-8）。
 *
 *  - 渲染 / 源码两档。frontmatter 在渲染视图里**收成一行元数据**，点一下看原文 ——
 *    大多只有两三个键，做成表格是浪费；也不隐藏，因为 status 这类键人是会看的。
 *  - 源码是带行号的可编辑文本框。**行号从文件第一行数起，frontmatter 计入**
 *    （设计侧问的第一件，我们定的口径：和大纲、会话里的 `L9–12` 同一个坐标系）。
 *  - 落盘走 `file_write`（第二条写入口）：带上读到时的 sha256，盘上被别人改过就拒绝。
 *    `.md` 里 Enter 是换行，所以落盘是 ⌘S / 失焦，不是 Enter。
 *  - 选一段 → `range` 药丸（路径 + 行范围 + 文本），AI 用 `write_file` 只改那一段。
 *
 *  渲染用 markdown-it，打进 app 的构建产物里 —— 不从 CDN 取，断网照常（H2）。 */
const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

export interface Outline { level: number; text: string; line: number }

export function MarkdownView({ core, path, onSelection, onOutline, writeTick, onWritten }: {
  core: Core; path: string; onSelection: (s: Selection | null) => void; onOutline: (o: Outline[]) => void; writeTick: string; onWritten: () => void;
}) {
  const [info, setInfo] = useState<ReadFileResult | null>(null);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"render" | "source">("render");
  const [busy, setBusy] = useState(false);
  const [snapOpen, setSnapOpen] = useState(false);
  const [snaps, setSnaps] = useState<FileSnapshotMeta[] | null>(null);
  const [fmOpen, setFmOpen] = useState(false);
  const [sel, setSel] = useState<{ from: number; to: number; text: string } | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const shaRef = useRef<string>("");

  const load = useCallback(async () => {
    const r = await core.get<ReadFileResult>(`file?path=${encodeURIComponent(path)}`);
    if (!r.ok || !r.data) { toast("读不到这个文件", r.errors?.[0]?.message, "error"); return; }
    setInfo(r.data); setText(r.data.content ?? ""); shaRef.current = r.data.sha256; setSel(null);
  }, [core, path]);
  useEffect(() => { void load(); }, [load, writeTick]);

  const dirty = !!info && text !== (info.content ?? "");
  const { front, body, bodyStartLine } = useMemo(() => splitFrontmatter(text), [text]);
  const html = useMemo(() => md.render(body), [body]);
  const outline = useMemo(() => headings(body, bodyStartLine), [body, bodyStartLine]);

  // 大纲归右侧那一列（S11 定的：从属面板统一在右）—— 这里只负责算，不自己画一份
  useEffect(() => { onOutline(outline); }, [outline]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const on = (e: Event) => jumpTo((e as CustomEvent<Outline>).detail, mode, area, setMode);
    window.addEventListener("ud-md-jump", on); return () => window.removeEventListener("ud-md-jump", on);
  }, [mode]);

  const save = useCallback(async () => {
    if (!dirty || busy) return;
    setBusy(true);
    const r = await core.post<{ snapshot: string; previous: string | null }>("file_write", { path, content: text, expectSha256: shaRef.current });
    setBusy(false);
    if (!r.ok) { toast("没落下去", r.errors?.[0]?.fix ?? r.errors?.[0]?.message, "error"); return; }
    toast(`已落盘 · 快照 ${r.data?.snapshot}`, r.data?.previous ? `上一版 ${r.data.previous} 还在，可以退回` : undefined, "ok");
    await load(); onWritten();
  }, [core, path, text, dirty, busy, load, onWritten]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); void save(); } };
    document.addEventListener("keydown", on); return () => document.removeEventListener("keydown", on);
  }, [save]);

  /** 选区 → 行范围。行号按整个文件算（frontmatter 计入） */
  const pickSelection = () => {
    const el = area.current;
    let from: number, to: number, picked: string;
    if (mode === "source" && el && el.selectionStart !== el.selectionEnd) {
      from = text.slice(0, el.selectionStart).split("\n").length;
      to = text.slice(0, el.selectionEnd).split("\n").length;
      picked = text.slice(el.selectionStart, el.selectionEnd);
    } else {
      const s = window.getSelection();
      if (!s || s.isCollapsed) { toast("先选一段", "在渲染视图里拖选，或到源码视图里选行"); return; }
      picked = s.toString();
      const idx = text.indexOf(picked.split("\n")[0] ?? "");
      if (idx < 0) { toast("这段在源文里找不到", "渲染后的文字和源文不一致时，请到源码视图里选"); return; }
      from = text.slice(0, idx).split("\n").length;
      to = from + picked.split("\n").length - 1;
    }
    setSel({ from, to, text: picked });
    onSelection({ kind: "range", label: `${path.split("/").pop()} L${from}${to > from ? `–${to}` : ""}`, detail: `${path} L${from}-${to}\n${picked.slice(0, 400)}` });
  };

  const openSnaps = async () => {
    setSnapOpen(true);
    const r = await core.get<{ snapshots: FileSnapshotMeta[] }>(`file_versions?path=${encodeURIComponent(path)}`);
    setSnaps(r.data?.snapshots ?? []);
  };
  const revert = async (version: string) => {
    const r = await core.post<{ snapshot: string }>("file_revert", { path, version });
    if (!r.ok) { toast("退不回去", r.errors?.[0]?.message, "error"); return; }
    toast(`已回到 ${version}`, `当前内容先存成了 ${r.data?.snapshot}，不会丢`, "ok");
    setSnapOpen(false); await load(); onWritten();
  };

  return (
    <div className="flex-1 min-w-0 flex flex-col bg-bg min-h-0">
      <header className="h-10 px-3 flex items-center gap-2 border-b border-border bg-panel shrink-0 text-xs">
        <span className="font-semibold truncate">{path.split("/").pop()}</span>
        <button className="btn sm ghost" onClick={() => void openSnaps()} title="快照历史">{info?.snapshot ?? "未改过"} ▾</button>
        <span className="flex-1" />
        {sel && <span className="font-mono text-accent">L{sel.from}{sel.to > sel.from ? `–${sel.to}` : ""} · 已带进会话</span>}
        <button className="btn sm" onClick={pickSelection}>选中这段给 AI</button>
        <div className="seg"><button className={mode === "render" ? "on" : ""} onClick={() => setMode("render")}>渲染</button><button className={mode === "source" ? "on" : ""} onClick={() => setMode("source")}>源码</button></div>
      </header>
      {dirty && (
        <div className="h-9 px-3 flex items-center gap-2 shrink-0 border-b" style={{ background: "var(--tool-warn-soft)", borderColor: "var(--tool-warn-border)", color: "var(--tool-warn)" }}>
          <span className="text-xs">还没落盘 · {diffLines(info?.content ?? "", text)}</span>
          <span className="flex-1" />
          <button className="btn sm ghost" onClick={() => setText(info?.content ?? "")}>放弃</button>
          <button className="btn sm primary" disabled={busy} onClick={() => void save()}>{busy ? "正在落盘…" : "落盘 ⌘S"}</button>
        </div>
      )}
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 overflow-auto">
          {mode === "render" ? (
            <article className="mx-auto max-w-[760px] px-8 py-6">
              {front !== null && (
                <div className="mb-5 rounded border border-border bg-panel2 text-[11px]">
                  <button className="w-full flex items-center gap-2 px-3 h-8 text-left" onClick={() => setFmOpen((o) => !o)}>
                    <span className="font-mono text-muted uppercase tracking-wide">frontmatter</span>
                    {!fmOpen && <span className="font-mono truncate">{frontSummary(front)}</span>}
                    <span className="flex-1" /><span className="text-muted">{fmOpen ? "收起" : "看原文"}</span>
                  </button>
                  {fmOpen && <pre className="px-3 pb-3 font-mono whitespace-pre-wrap text-text2">{front}</pre>}
                </div>
              )}
              <div className="md-body" dangerouslySetInnerHTML={{ __html: html }} />
            </article>
          ) : (
            <div className="flex font-mono text-[12.5px] leading-6 min-h-full">
              <div className="select-none text-right text-muted px-3 py-3 bg-panel border-r border-border shrink-0">
                {text.split("\n").map((_, i) => <div key={i} className={sel && i + 1 >= sel.from && i + 1 <= sel.to ? "text-accent font-semibold" : ""}>{i + 1}</div>)}
              </div>
              <textarea ref={area} data-md-source="1" value={text} onChange={(e) => setText(e.target.value)} onBlur={() => void save()} spellCheck={false}
                className="flex-1 min-w-0 px-3 py-3 bg-bg outline-none resize-none leading-6" style={{ minHeight: "100%" }} />
            </div>
          )}
        </div>
      </div>
      {snapOpen && (
        <div className="fixed inset-0 z-40 bg-black/20" onMouseDown={(e) => { if (e.target === e.currentTarget) setSnapOpen(false); }}>
          <div className="absolute left-1/2 top-24 -translate-x-1/2 w-[352px] max-h-[420px] flex flex-col rounded-lg border border-border bg-panel shadow-2xl text-xs">
            <header className="h-9 px-3 flex items-center gap-2 border-b border-border shrink-0"><span className="font-semibold">快照历史</span><span className="text-muted">{snaps ? `${snaps.length} 版` : "读取中…"}</span><span className="flex-1" /><button className="ib" onClick={() => setSnapOpen(false)}>×</button></header>
            <div className="flex-1 overflow-auto">
              {(snaps ?? []).slice().reverse().map((s, i) => (
                <div key={s.version} className="px-3 py-2 flex items-center gap-2 border-b border-border last:border-0">
                  <span className="font-mono font-semibold">{s.version}</span><span className="text-muted">{s.src}</span><span className="text-muted">{timeAgo(s.at)}</span>
                  <span className="flex-1 truncate text-text2">{s.note ?? ""}</span>
                  {i === 0 ? <span className="text-accent font-semibold">当前</span> : <button className="btn sm" onClick={() => void revert(s.version)}>回到这一版</button>}
                </div>
              ))}
              {snaps && snaps.length === 0 && <div className="p-3 text-muted">还没有快照 —— 这个文件没经这里改过。</div>}
            </div>
            <footer className="px-3 py-2 border-t border-border text-muted leading-relaxed shrink-0">回到旧版时，当前内容会先存成新快照，不会丢。</footer>
          </div>
        </div>
      )}
    </div>
  );
}

/** frontmatter 只认文件开头那一块 `---`；不是开头的 `---` 是分隔线，不能当它 */
function splitFrontmatter(src: string): { front: string | null; body: string; bodyStartLine: number } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { front: null, body: src, bodyStartLine: 1 };
  return { front: m[1] ?? "", body: src.slice(m[0].length), bodyStartLine: src.slice(0, m[0].length).split("\n").length };
}
function frontSummary(front: string): string {
  return front.split("\n").filter(Boolean).slice(0, 3).map((l) => l.replace(/:\s*/, " ").trim()).join(" · ");
}
/** 标题与它在**整个文件**里的行号（frontmatter 计入 —— 和源码视图、会话药丸同一个坐标系） */
function headings(body: string, offset: number): Outline[] {
  const out: Outline[] = [];
  let fence = false;
  body.split("\n").forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return; }
    if (fence) return;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) out.push({ level: m[1]!.length, text: m[2]!, line: offset + i });
  });
  return out;
}
function diffLines(a: string, b: string): string {
  const x = a.split("\n"), y = b.split("\n");
  let changed = 0;
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) changed++;
  return changed === 1 ? "改了 1 行" : `改了 ${changed} 行`;
}
function jumpTo(h: Outline, mode: "render" | "source", area: React.RefObject<HTMLTextAreaElement>, setMode: (m: "render" | "source") => void): void {
  if (mode === "source" && area.current) {
    const el = area.current;
    const pos = el.value.split("\n").slice(0, h.line - 1).join("\n").length + 1;
    el.focus(); el.setSelectionRange(pos, pos);
    el.scrollTop = Math.max(0, (h.line - 3) * 24);
    return;
  }
  // 渲染视图：按标题文字找对应的 h1..h6
  const body = document.querySelector(".md-body");
  const hit = body ? Array.from(body.querySelectorAll("h1,h2,h3,h4,h5,h6")).find((e) => e.textContent?.trim() === h.text) : null;
  if (hit) hit.scrollIntoView({ block: "start", behavior: "smooth" });
  else setMode("source");
}
