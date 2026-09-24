import { useCallback, useEffect, useMemo, useState } from "react";
import { Core, type ProjectHandle } from "../api/client";
import { draftTitle, HEALTH_LABEL, type Picked } from "../api/types";
import { ChatRail } from "../chat/ChatRail";
import { useChat } from "../chat/useChat";
import type { HostAdapter } from "../host";
import { kindOf, mem, panelsFor, type LayoutState, type PanelId } from "../layout/layout";
import { useProject } from "../store/project";
import { NewDraftSheet } from "../sheets/Sheets";
import { toast } from "../ui/Toast";
import { Canvas, Present, type PreviewMode } from "./Canvas";
import { PANEL_WIDTH, SidePanels } from "./SidePanels";

/** 工作台（S11 形制）：顶栏 40 · 页签 34 · 左会话 / 中画布 / 右从属面板列 · 底部状态行 24 */
export function Workbench({ project, host, layout, setLayout, onHome, onSettings }: { project: ProjectHandle; host: HostAdapter; layout: LayoutState; setLayout: (l: LayoutState) => void; onHome: () => void; onSettings: () => void }) {
  const core = useMemo(() => new Core(project.url, project.token, project.ws), [project]);
  const store = useProject(core, project.dir);
  const [tabs, setTabs] = useState<string[]>(() => mem.get(`us.tabs.${project.dir}`, []));
  const [picked, setPicked] = useState<Picked | null>(null);
  const [mode, setMode] = useState<PreviewMode>(() => mem.get("us.previewMode", "shell"));
  const [present, setPresent] = useState(false);
  const [fileMenu, setFileMenu] = useState(false); const [fileQ, setFileQ] = useState("");
  const [sheet, setSheet] = useState<"newDraft" | null>(null);
  const [narrow, setNarrow] = useState(() => window.innerWidth < 1100);
  const [menu, setMenu] = useState(false);
  const file = store.selected;
  const kind = kindOf(file);
  const panels = panelsFor(kind);
  const active: PanelId | null = panels.length ? (layout.panelByKind[kind] === undefined ? panels[0]! : (layout.panelByKind[kind] && panels.includes(layout.panelByKind[kind]!) ? layout.panelByKind[kind]! : null)) : null;
  const setActive = useCallback((p: PanelId | null) => setLayout({ ...layout, panelByKind: { ...layout.panelByKind, [kind]: p } }), [layout, setLayout, kind]);
  const chat = useChat(core, project.dir, { selectedDraft: file, picked, afterChanges: () => { void store.fetchDrafts(); if (file) { void store.fetchDiagnostics(file); void store.fetchChanges(file); } } });

  // 进项目：自动开上次看的稿（没有就第一份）
  useEffect(() => { host.setTitle(project.title || project.name); }, [host, project]);
  useEffect(() => {
    if (store.selected || !store.drafts.length) return;
    const last = mem.get<string | null>(`us.lastDraft.${project.dir}`, null);
    const pick = store.drafts.find((d) => d.file === last) ?? store.drafts[0];
    if (pick) open(pick.file);
  }, [store.drafts]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const on = () => setNarrow(window.innerWidth < 1100); window.addEventListener("resize", on); return () => window.removeEventListener("resize", on); }, []);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape" && present) setPresent(false);
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") { e.preventDefault(); setLayout({ ...layout, chatMode: layout.chatMode === "bar" ? "expanded" : "bar" }); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") { e.preventDefault(); if (layout.chatMode === "bar") setLayout({ ...layout, chatMode: "expanded" }); setTimeout(() => document.getElementById("chatInput")?.focus(), 50); }
    };
    document.addEventListener("keydown", on); return () => document.removeEventListener("keydown", on);
  }, [present, layout, setLayout]);

  const open = (f: string) => {
    store.select(f); setPicked(null); setFileMenu(false);
    mem.set(`us.lastDraft.${project.dir}`, f);
    setTabs((t) => { const n = t.includes(f) ? t : [...t, f]; mem.set(`us.tabs.${project.dir}`, n); return n; });
  };
  const closeTab = (f: string) => { const n = tabs.filter((x) => x !== f); setTabs(n); mem.set(`us.tabs.${project.dir}`, n); if (file === f) { const next = n[n.length - 1] ?? null; if (next) open(next); else store.select(null); } };
  const sendToAI = (text: string, p: Picked) => { setPicked(p); if (layout.chatMode === "bar") setLayout({ ...layout, chatMode: "expanded" }); void chat.send(text, p); };
  const setChat = (patch: Partial<LayoutState>) => setLayout({ ...layout, ...patch });
  const draft = file ? store.drafts.find((d) => d.file === file) : undefined;
  const unresolved = store.comments.filter((c) => !c.resolved).length;
  const filtered = store.drafts.filter((d) => !fileQ || `${d.title} ${d.file}`.toLowerCase().includes(fileQ.toLowerCase()));

  const rail = layout.chatMode === "expanded" ? <ChatRail chat={chat} picked={picked} onClearPicked={() => setPicked(null)} selectedDraft={file} width={layout.chatWidth} onCollapse={() => setChat({ chatMode: "bar" })} onSwapSide={() => setChat({ chatSide: layout.chatSide === "left" ? "right" : "left" })} /> : null;
  const panelOpen = !!file && !!active && !narrow;
  return (
    <div className="h-full flex flex-col">
      <header className="h-10 px-3 flex items-center gap-3 border-b border-border bg-panel shrink-0 text-xs">
        <button className="text-sm font-semibold hover:text-accent" onClick={onHome} title="回到项目列表">Umbra Studio</button>
        <span className="text-border">|</span>
        <span className="text-sm font-semibold truncate">{project.title || project.name}</span>
        <span className="font-mono text-muted truncate max-w-[360px]" dir="rtl" title={project.dir}>{project.dir}</span>
        <span className="flex-1" />
        <span className={`text-[11px] ${store.wsState === "open" ? "text-muted" : "text-err"}`} title={store.lastEvent ? `最近事件 ${store.lastEvent.type} · ${store.lastEvent.at}` : "还没有事件"}>{store.wsState === "open" ? "" : "核心断开"}</span>
        <div className="seg" title="会话栏：左 / 输入条 / 右（⌘\\ 切换展开与输入条）">
          <button className={layout.chatSide === "left" && layout.chatMode === "expanded" ? "on" : ""} onClick={() => setChat({ chatSide: "left", chatMode: "expanded" })} title="在左">◧</button>
          <button className={layout.chatMode === "bar" ? "on" : ""} onClick={() => setChat({ chatMode: "bar" })} title="收成输入条">▭</button>
          <button className={layout.chatSide === "right" && layout.chatMode === "expanded" ? "on" : ""} onClick={() => setChat({ chatSide: "right", chatMode: "expanded" })} title="在右">◨</button>
        </div>
        <div className="relative"><button className="ib" onClick={() => setMenu((m) => !m)} title="更多">⋯</button>
          {menu && <div className="menu" onMouseLeave={() => setMenu(false)}>
            <button onClick={() => { setMenu(false); setSheet("newDraft"); }}>新建稿件</button>
            <button onClick={() => { setMenu(false); void store.rebuildIndex(); }}>重建索引</button>
            <button onClick={() => { setMenu(false); void host.revealInFinder(project.dir).catch((e: Error) => toast("打开目录失败", e.message, "error")); }}>在访达中显示项目目录</button>
            <button onClick={() => { setMenu(false); onSettings(); }}>项目设置 · 外观</button>
            <hr className="border-border my-1" />
            <button onClick={() => { setMenu(false); onHome(); }}>关闭项目</button>
          </div>}
        </div>
      </header>
      <div className="flex-1 min-h-0 flex">
        {layout.chatSide === "left" && rail}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="h-[34px] flex items-stretch border-b border-border bg-panel shrink-0 text-xs relative">
            <div className="flex-1 min-w-0 flex overflow-x-auto">
              {tabs.map((t) => { const d = store.drafts.find((x) => x.file === t); const cur = t === file; return <div key={t} className={`group flex items-center gap-1.5 pl-3 pr-2 border-r border-border cursor-pointer whitespace-nowrap ${cur ? "bg-bg border-t-2 border-t-accent -mb-px" : "text-muted hover:text-text"}`} onClick={() => open(t)} title={t}><span className={`hdot ${d?.health ?? "unchecked"}`} /><span className={cur ? "font-semibold" : ""}>{draftTitle(t)}</span><button className="ib opacity-0 group-hover:opacity-100 text-[10px]" onClick={(e) => { e.stopPropagation(); closeTab(t); }} title="关闭">×</button></div>; })}
            </div>
            <button className="px-3 border-l border-border text-muted hover:text-text whitespace-nowrap" onClick={() => { setFileMenu((m) => !m); setFileQ(""); }} title="所有稿件">{store.drafts.length} 份稿 ▾</button>
            {fileMenu && <div className="absolute right-0 top-[34px] z-30 w-[380px] max-h-[60vh] flex flex-col bg-panel border border-border rounded-b-lg shadow-2xl">
              <input autoFocus value={fileQ} onChange={(e) => setFileQ(e.target.value)} placeholder="搜稿名、文件名…" className="m-2 h-8 px-3 rounded border border-border bg-bg outline-none focus:border-accent" onKeyDown={(e) => { if (e.key === "Escape") setFileMenu(false); }} />
              <div className="flex-1 overflow-auto">{filtered.length ? filtered.map((d) => <button key={d.file} className={`w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-hover ${d.file === file ? "bg-accentSoft" : ""}`} onClick={() => open(d.file)}><span className={`hdot ${d.health}`} title={d.healthWhy} /><span className="truncate flex-1">{d.title}</span><span className="text-muted font-mono">{d.version ?? ""}</span><span className="text-muted">{d.elements ? `${d.elements} 元素` : ""}</span></button>) : <div className="p-3 text-muted">没有匹配的稿</div>}</div>
              <div className="px-3 h-8 flex items-center gap-2 border-t border-border text-muted"><span>{store.indexed ? "" : "还没建索引"}</span><span className="flex-1" /><button className="btn sm" onClick={() => { setFileMenu(false); setSheet("newDraft"); }}>新建稿件</button></div>
            </div>}
          </div>
          <div className="flex-1 min-h-0 flex">
            {file ? <Canvas url={project.url} store={store} file={file} picked={picked} onPicked={setPicked} mode={mode} setMode={(m) => { setMode(m); mem.set("us.previewMode", m); }} onPresent={() => setPresent(true)} panelWidth={panelOpen && active === "props" ? PANEL_WIDTH : 0} onOpenPanel={(p) => setActive(p)} unresolved={unresolved} />
              : <div className="flex-1 flex items-center justify-center text-muted text-xs text-center px-6 leading-relaxed bg-canvas">{store.drafts.length ? "从右上角「N 份稿」里选一份" : <>这个项目还没有稿<br /><button className="btn sm mt-3" onClick={() => setSheet("newDraft")}>新建稿件</button></>}</div>}
            {file && panels.length > 0 && <SidePanels core={core} store={store} file={file} picked={picked} panels={panels} active={active} setActive={setActive} narrow={narrow} onSendToAI={sendToAI} />}
          </div>
          {layout.chatMode === "bar" && (
            <div className="h-11 px-2 flex items-center gap-2 border-t border-border bg-panel shrink-0">
              <button className="ib" onClick={() => setChat({ chatMode: "expanded" })} title="展开会话栏">◧</button>
              {picked && <span className="flex items-center gap-1 rounded border border-accent bg-accentSoft px-2 h-6 text-[11px] font-mono"><span className="text-accent font-semibold">node</span>{picked.tag ? `<${picked.tag}>` : picked.node}<button className="ib text-[10px]" onClick={() => setPicked(null)}>×</button></span>}
              <input id="chatInput" value={chat.input} onChange={(e) => chat.setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void chat.send(); }} placeholder={chat.running ? "AI 正在跑…" : file ? `对 ${draftTitle(file)} 说…` : "说要改什么…"} className="flex-1 h-8 px-3 rounded border border-border bg-bg text-xs outline-none focus:border-accent" />
              {chat.running ? <button className="btn sm danger" onClick={() => void chat.interrupt()}>中断</button> : <button className="btn sm primary" onClick={() => void chat.send()} disabled={!chat.input.trim()}>发送</button>}
            </div>
          )}
        </div>
        {layout.chatSide === "right" && rail}
      </div>
      <footer className="h-6 px-3 flex items-center gap-3 border-t border-border bg-panel shrink-0 text-[11px] text-muted font-mono">
        {file ? <><span className="truncate">{file}</span><span>·</span><span>{draft?.kind === "component" ? "组件稿" : "设计稿"}</span>{draft && <><span>·</span><span>{draft.version ?? "—"}</span><span>·</span><span>{draft.elements ?? "—"} 元素</span><span>·</span><span title={draft.healthWhy}>{HEALTH_LABEL[draft.health]}</span></>}</> : <span>没有选中的稿</span>}
        <span className="flex-1" />
        <span>会话在{layout.chatMode === "bar" ? "输入条" : layout.chatSide === "left" ? "左" : "右"} · {layout.chatWidth} px</span>
      </footer>
      {present && file && <Present url={project.url} file={file} onStop={() => setPresent(false)} />}
      {sheet === "newDraft" && <NewDraftSheet core={core} current={file} onClose={() => setSheet(null)} onCreated={async (f) => { await store.fetchDrafts(); open(f); }} />}
    </div>
  );
}
