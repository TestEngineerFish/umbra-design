import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { timeAgo, type FileSnapshotMeta, type ReadFileResult } from "../../api/types";
import { renderMd } from "../../ui/markdown";
import { dirtyStore } from "../../ui/dirty";
import type { ViewContext } from "../context";
import { diffLines, headings, jumpTo, splitFrontmatter, type Outline } from "./parse";

/** 一份 `.md` 的全部状态（M8-15b）。
 *
 *  为什么要有这一层：第七轮把工具栏定成「统一的一条横带，每种格式往里填自己的东西」，
 *  于是「渲染 / 源码」这档开关就**不能再住在视图组件里** —— 工具栏和视图是两个渲染位置。
 *  一并搬上来的还有选区、快照、落盘：它们同样被工具栏和 `⋯` 用到。
 *
 *  结果是这个模块的分工变成：**这里管状态，`View` 只管画，`Toolbar` 只管开关。**
 *  以前三样混在一个 208 行的组件里，改工具栏得读完整个文件。
 */
export interface MdDoc {
  info: ReadFileResult | null;
  text: string; setText: (t: string) => void;
  mode: "render" | "source"; setMode: (m: "render" | "source") => void;
  busy: boolean;
  dirty: boolean;
  diffNote: string;
  front: string | null; html: string;
  outline: Outline[];
  sel: { from: number; to: number; text: string } | null;
  /** React 18 的 `useRef<T>(null)` 给的是 `RefObject<T>`，别写成 `T | null` —— 那样 JSX 的 ref 不收 */
  area: React.RefObject<HTMLTextAreaElement>;
  fmOpen: boolean; setFmOpen: (v: boolean) => void;
  snapOpen: boolean; setSnapOpen: (v: boolean) => void;
  snaps: FileSnapshotMeta[] | null;
  save: () => Promise<void>;
  discard: () => void;
  pickSelection: () => void;
  openSnaps: () => Promise<void>;
  revert: (version: string) => Promise<void>;
}

const Ctx = createContext<MdDoc | null>(null);
export const useMdDoc = (): MdDoc => {
  const v = useContext(Ctx);
  if (!v) throw new Error("md 的 Provider 没包上");
  return v;
};

export function MdProvider({ ctx, children }: { ctx: ViewContext; children: ReactNode }) {
  const { core, path } = ctx;
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
    if (!r.ok || !r.data) { ctx.ui.toast("读不到这个文件", r.errors?.[0]?.message, "error"); return; }
    setInfo(r.data); setText(r.data.content ?? ""); shaRef.current = r.data.sha256; setSel(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [core, path]);
  const writeTick = ctx.store.fileTick(path);
  useEffect(() => { void load(); }, [load, writeTick]);

  const dirty = !!info && text !== (info.content ?? "");
  /* 登记到全局，页签上那颗点读它 —— 未保存是这个模块知道的事，
     而要显示它的地方（页签条）不属于任何一种格式（M8-22） */
  useEffect(() => { dirtyStore.set(path, dirty); return () => dirtyStore.set(path, false); }, [path, dirty]);
  const { front, body, bodyStartLine } = useMemo(() => splitFrontmatter(text), [text]);
  const html = useMemo(() => renderMd(body), [body]);
  const outline = useMemo(() => headings(body, bodyStartLine), [body, bodyStartLine]);

  useEffect(() => {
    const on = (e: Event) => jumpTo((e as CustomEvent<Outline>).detail, mode, area, setMode);
    window.addEventListener("ud-md-jump", on); return () => window.removeEventListener("ud-md-jump", on);
  }, [mode]);
  /* 版本历史由文件 `⋯` 里的那一项触发。走事件是因为 `menu` 是个纯函数、
     拿不到 React context —— 它只能说「要开版本历史」，开的动作在这里。 */
  useEffect(() => {
    const on = () => { void openSnaps(); };
    window.addEventListener("ud-md-snaps", on); return () => window.removeEventListener("ud-md-snaps", on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const save = useCallback(async () => {
    if (!dirty || busy) return;
    setBusy(true);
    const r = await core.post<{ snapshot: string; previous: string | null }>("file_write", { path, content: text, expectSha256: shaRef.current });
    setBusy(false);
    if (!r.ok) { ctx.ui.toast("没落下去", r.errors?.[0]?.fix ?? r.errors?.[0]?.message, "error"); return; }
    ctx.ui.toast(`已落盘 · 快照 ${r.data?.snapshot}`, r.data?.previous ? `上一版 ${r.data.previous} 还在，可以退回` : undefined, "ok");
    await load(); void ctx.store.fetchDrafts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [core, path, text, dirty, busy, load]);
  /* `.md` 里 Enter 是换行，所以落盘是 ⌘S / 失焦，不是 Enter */
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
      if (!s || s.isCollapsed) { ctx.ui.toast("先选一段", "在渲染视图里拖选，或到源码视图里选"); return; }
      picked = s.toString();
      const idx = text.indexOf(picked.split("\n")[0] ?? "");
      if (idx < 0) { ctx.ui.toast("这段在源文里找不到", "渲染后的文字和源文不一致时，请到源码视图里选"); return; }
      from = text.slice(0, idx).split("\n").length;
      to = from + picked.split("\n").length - 1;
    }
    setSel({ from, to, text: picked });
    ctx.select("range", { kind: "range", label: `${path.split("/").pop()} L${from}${to > from ? `–${to}` : ""}`, detail: `${path} L${from}-${to}\n${picked.slice(0, 400)}` });
  };

  const openSnaps = async () => {
    setSnapOpen(true);
    const r = await core.get<{ snapshots: FileSnapshotMeta[] }>(`file_versions?path=${encodeURIComponent(path)}`);
    setSnaps(r.data?.snapshots ?? []);
  };
  const revert = async (version: string) => {
    const r = await core.post<{ snapshot: string }>("file_revert", { path, version });
    if (!r.ok) { ctx.ui.toast("退不回去", r.errors?.[0]?.message, "error"); return; }
    ctx.ui.toast(`已回到 ${version}`, `当前内容先存成了 ${r.data?.snapshot}，不会丢`, "ok");
    setSnapOpen(false); await load(); void ctx.store.fetchDrafts();
  };

  const value: MdDoc = {
    info, text, setText, mode, setMode, busy, dirty,
    diffNote: diffLines(info?.content ?? "", text),
    front, html, outline, sel, area,
    fmOpen, setFmOpen, snapOpen, setSnapOpen, snaps,
    save, discard: () => setText(info?.content ?? ""),
    pickSelection, openSnaps, revert,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export { timeAgo };
