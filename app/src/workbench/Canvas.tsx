import { useCallback, useEffect, useRef, useState } from "react";
import type { Picked, ShellState, SourceData } from "../api/types";
import type { ProjectStore } from "../store/project";
import { toast } from "../ui/Toast";

export type PreviewMode = "shell" | "raw" | "code";
const PRESETS = ["PC 1440", "笔记本 1280", "iPhone 390", "自适应"];
const SHELL0: ShellState = { selectOn: false, preset: 0, zoom: 1, draftTheme: "light", picked: false, busy: false, editHint: null, checkNote: null, apiErr: null };

/** 画布：一条工具栏（ClaudeDesign 式，§四十八）+ S2 嵌入壳 iframe（编辑）/ 稿本身（预览）/ 源码只读。
 *  iframe 只在换稿 / 换档时重建；其它状态变化不碰它（就地编辑的内层 iframe 会被卸掉，§四十三 踩过）。 */
export function Canvas({ url, store, file, picked, onPicked, mode, setMode, onPresent, onOpenPanel, unresolved }: {
  url: string; store: ProjectStore; file: string; picked: Picked | null; onPicked: (p: Picked | null) => void;
  mode: PreviewMode; setMode: (m: PreviewMode) => void; onPresent: () => void;
  onOpenPanel: (id: "comments" | "changes" | "diagnostics") => void; unresolved: number;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [shell, setShell] = useState<ShellState>(SHELL0);
  const seen = useRef(false);
  const [menu, setMenu] = useState(false);
  const draft = store.drafts.find((d) => d.file === file);
  const checking = store.checking === file;
  const health = checking ? "unchecked" : (draft?.health ?? "unchecked");
  const src = mode === "shell" ? `${url}${encodeURIComponent("S2-单稿预览壳.dc.html")}?file=${encodeURIComponent(file)}&embed=1` : `${url}${encodeURIComponent(file).replace(/%2F/g, "/")}`;
  const cmd = useCallback((c: string, value?: unknown) => { frame.current?.contentWindow?.postMessage({ source: "umbradesign-app", type: "cmd", cmd: c, value }, "*"); }, []);
  const reload = useCallback(() => { seen.current = false; if (frame.current) frame.current.src = src; if (mode === "code") void store.fetchSource(file); }, [src, mode, store, file]);
  useEffect(() => { seen.current = false; setShell(SHELL0); }, [file, mode]);
  useEffect(() => { if (mode === "code") void store.fetchSource(file); }, [mode, file, store]);
  // S2 → 应用：选中 / 清除 / 评论变了 / 壳状态
  useEffect(() => {
    const on = (e: MessageEvent) => {
      const m = e.data as { source?: string; type?: string; payload?: Record<string, unknown> };
      if (!m || m.source !== "umbradesign-s2") return;
      if (m.type === "picked" && m.payload) onPicked({ file: (m.payload.file as string) || file, node: m.payload.node as string, tag: (m.payload.tag as string) || "" });
      if (m.type === "cleared") onPicked(null);
      if (m.type === "comments-changed") void store.fetchComments(file);
      if (m.type === "shell-state" && m.payload) {
        const p = m.payload as Partial<ShellState>; const first = !seen.current; seen.current = true;
        setShell((s) => ({ ...s, ...p }));
        if (first && p.preset === 0 && (p.zoom === 1 || !p.zoom)) { const w = (frame.current?.parentElement?.clientWidth ?? 0) - 24; if (w > 0 && w < 1440) cmd("zoom", Math.max(0.3, Math.floor(w / 1440 * 20) / 20)); }
      }
    };
    window.addEventListener("message", on); return () => window.removeEventListener("message", on);
  }, [file, onPicked, store, cmd]);
  // 落盘 / 回退之后刷新预览
  useEffect(() => { const e = store.lastEvent; if (!e || e.type !== "write") return; const p = e.payload as { file?: string }; if (p.file === file) reload(); }, [store.lastEvent]);   // eslint-disable-line react-hooks/exhaustive-deps
  const note = shell.editHint || shell.checkNote || (shell.apiErr ? "出错：" + shell.apiErr : "") || (shell.busy ? "落盘中…" : "");
  const openBrowser = () => window.open(`${url}${encodeURIComponent(file).replace(/%2F/g, "/")}`, "_blank");
  const compare = () => window.open(`${url}${encodeURIComponent("S6-版本对比.dc.html")}?file=${encodeURIComponent(file)}`, "_blank");
  return (
    <div className="flex-1 min-w-0 flex flex-col bg-canvas relative">
      <div className="h-10 px-2 flex items-center gap-1.5 border-b border-border bg-panel shrink-0 text-xs">
        <div className="seg" title="编辑：能点选节点、改属性、把选中节点带给 AI；预览：稿本身；源码：只读">
          {(["shell", "raw", "code"] as const).map((m) => <button key={m} className={mode === m ? "on" : ""} onClick={() => { onPicked(null); setMode(m); }}>{{ shell: "编辑", raw: "预览", code: "源码" }[m]}</button>)}
        </div>
        {mode === "shell" && <>
          <span className="w-px h-4 bg-border mx-1" />
          <select className="sel" value={shell.preset} onChange={(e) => cmd("preset", Number(e.target.value))} title="画布宽度">{PRESETS.map((n, i) => <option key={n} value={i}>{n}</option>)}</select>
          <button className="ib" onClick={() => cmd("zoom", Math.max(0.3, Math.round((shell.zoom - 0.1) * 10) / 10))} title="缩小">－</button>
          <span className="font-mono text-text2 w-10 text-center">{Math.round(shell.zoom * 100)}%</span>
          <button className="ib" onClick={() => cmd("zoom", Math.min(1.5, Math.round((shell.zoom + 0.1) * 10) / 10))} title="放大">＋</button>
          <button className="ib" onClick={() => cmd("theme", shell.draftTheme === "dark" ? "light" : "dark")} title={`稿的浅 / 深色（现在：${shell.draftTheme === "dark" ? "深" : "浅"}）`}>{shell.draftTheme === "dark" ? "☾" : "☼"}</button>
        </>}
        {note && <span className="text-accent truncate max-w-[260px]" title={note}>{note}</span>}
        <span className="flex-1" />
        {mode === "shell" && <button className={`btn sm ${shell.selectOn ? "on" : ""}`} onClick={() => cmd("pick")} title="点选：开着的时候点稿里的元素是「选中」，关掉才能真的用这个界面">⌖ 点选{shell.selectOn ? "：开" : ""}</button>}
        <button className="btn sm" onClick={() => onOpenPanel("comments")} title="钉在节点上的评论">评论{unresolved ? <span className="badge">{unresolved}</span> : null}</button>
        <button className="btn sm" onClick={() => void store.runCheck(file)} disabled={checking} title={`真开浏览器跑一次 render_check（${draft?.healthWhy ?? ""}）`}><span className={`hdot ${health}`} /> {checking ? "体检中…" : "体检"}</button>
        <button className="btn sm" onClick={onPresent} title="全屏只看稿，Esc 退出">▷ 演示</button>
        <div className="relative"><button className="ib" onClick={() => setMenu((m) => !m)} title="更多">⋯</button>
          {menu && <div className="menu" onMouseLeave={() => setMenu(false)}>
            <button onClick={() => { setMenu(false); openBrowser(); }}>在浏览器打开</button>
            <button onClick={() => { setMenu(false); compare(); }}>对比上一版（S6）</button>
            <button onClick={() => { setMenu(false); onOpenPanel("changes"); }}>变更与版本</button>
            <button onClick={() => { setMenu(false); reload(); }}>重新加载预览</button>
          </div>}
        </div>
      </div>
      {mode === "code" ? <CodeView src={store.source && store.source.file === file ? store.source : null} picked={picked} /> : (
        <div className="flex-1 min-h-0 relative">
          <iframe ref={frame} key={src} src={src} title={file} data-shell={mode === "shell" ? "1" : undefined} sandbox="allow-scripts allow-same-origin allow-forms allow-popups" className="absolute inset-0 w-full h-full border-0 bg-panel" />
        </div>
      )}
    </div>
  );
}

function CodeView({ src, picked }: { src: SourceData | null; picked: Picked | null }) {
  const hit = useRef<HTMLTableRowElement>(null);
  useEffect(() => { hit.current?.scrollIntoView({ block: "center" }); }, [src, picked]);
  if (!src) return <div className="flex-1 flex items-center justify-center text-muted text-xs">正在读源码…</div>;
  const needle = picked?.node ? `data-ud-node="${picked.node}"` : null;
  return (
    <div className="flex-1 min-h-0 overflow-auto bg-panel font-mono text-[11.5px] leading-5" title={`${src.file} · ${src.lines} 行 · ${src.bytes} 字节 · 只读`}>
      <table className="border-collapse w-full"><tbody>{src.source.split("\n").map((line, i) => { const h = !!needle && line.includes(needle); return <tr key={i} ref={h ? hit : undefined} className={h ? "bg-accentSoft" : ""}><td className="select-none text-right pr-3 pl-3 text-muted w-12 align-top">{i + 1}</td><td className="whitespace-pre pr-4">{line || " "}</td></tr>; })}</tbody></table>
    </div>
  );
}
export function Present({ url, file, onStop }: { url: string; file: string; onStop: () => void }) {
  useEffect(() => { const el = document.getElementById("present"); el?.requestFullscreen?.().catch(() => {}); const on = () => { if (!document.fullscreenElement) onStop(); }; document.addEventListener("fullscreenchange", on); return () => { document.removeEventListener("fullscreenchange", on); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); }; }, [onStop]);
  return <div id="present" className="fixed inset-0 z-50 bg-black"><iframe src={`${url}${encodeURIComponent(file).replace(/%2F/g, "/")}`} title="演示" className="w-full h-full border-0 bg-white" /><button className="btn sm absolute top-3 right-3 opacity-70 hover:opacity-100" onClick={onStop}>退出演示 Esc</button></div>;
}
export function useToastOnCheck() { return toast; }
