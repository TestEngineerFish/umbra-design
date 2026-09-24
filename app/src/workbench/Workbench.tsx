import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Core, type ProjectHandle } from "../api/client";
import { draftTitle, HEALTH_LABEL, type Picked, type Selection } from "../api/types";
import { ChatRail } from "../chat/ChatRail";
import { useChat } from "../chat/useChat";
import type { HostAdapter } from "../host";
import { TREE_W, kindOf, mem, panelsFor, type LayoutState, type PanelId } from "../layout/layout";

const KIND_LABEL: Record<string, string> = { dir: "目录", dc: "设计稿", md: "Markdown", image: "图片", code: "代码", html: "网页", other: "其他" };
import { useProject } from "../store/project";
import { NewDraftSheet } from "../sheets/Sheets";
import { toast } from "../ui/Toast";
import { Canvas, Present, type PreviewMode } from "./Canvas";
import { DirView } from "./DirView";
import { FileTree } from "./FileTree";
import { FileCard } from "./FileCard";
import { ImageView } from "./ImageView";
import { MarkdownView, type Outline } from "./MarkdownView";
import { SidePanels } from "./SidePanels";

/** 工作台（S11 形制）：顶栏 40 · 页签 34 · 左会话 / 中画布 / 右从属面板列 · 底部状态行 24 */
export function Workbench({ project, host, layout, setLayout, onHome, onSettings }: { project: ProjectHandle; host: HostAdapter; layout: LayoutState; setLayout: (l: LayoutState) => void; onHome: () => void; onSettings: () => void }) {
  const core = useMemo(() => new Core(project.url, project.token, project.ws), [project]);
  const store = useProject(core, project.dir);
  const [tabs, setTabs] = useState<string[]>(() => mem.get(`us.tabs.${project.dir}`, []));
  /** 当前打开的是目录时，file 是目录路径（"" = 项目根），dirMode 为真 */
  const [dirMode, setDirMode] = useState(false);
  const [dirSel, setDirSel] = useState<string[]>([]);
  const [outline, setOutline] = useState<Outline[]>([]);
  const [picked, setPickedRaw] = useState<Picked | null>(null);
  /* 选中的节点有两个去处：属性面板（picked，一次只有一个 —— 桥就是单选）与会话的药丸（selections，可多颗）。
     × 掉药丸不该把属性面板也关掉，所以分开存。 */
  const [selections, setSelections] = useState<Selection[]>([]);
  const setPicked = useCallback((p: Picked | null) => {
    setPickedRaw(p);
    setSelections((xs) => {
      const rest = xs.filter((x) => x.kind !== "node");
      return p ? [...rest, { kind: "node" as const, label: `${p.tag ? `<${p.tag}> ` : ""}${draftTitle(p.file)} · ${p.node}`, detail: `${p.file} › ${p.node}`, ref: { file: p.file, node: p.node } }] : rest;
    });
  }, []);
  const [mode, setMode] = useState<PreviewMode>(() => mem.get("us.previewMode", "shell"));
  const [present, setPresent] = useState(false);
  const [fileMenu, setFileMenu] = useState(false); const [fileQ, setFileQ] = useState("");
  const [sheet, setSheet] = useState<"newDraft" | null>(null);
  /* R5 让位规则（设计侧第六轮改的口径）：**看详情区的实际宽度，不看窗口宽度**。
     会话栏拖宽、目录列展开都会挤详情，而窗口宽度一点没变 —— 按窗口判会漏。
     详情区 < 480px 时依次让位：① 从属面板改抽屉 ② 还不够，目录列改浮层。 */
  const detailRef = useRef<HTMLDivElement>(null);
  const [detailW, setDetailW] = useState(9999);
  const narrow = detailW < 480;
  const [menu, setMenu] = useState(false);
  const file = store.selected;
  const kind = dirMode ? "dir" : kindOf(file);
  const panels = panelsFor(kind);
  const active: PanelId | null = panels.length ? (layout.panelByKind[kind] === undefined ? panels[0]! : (layout.panelByKind[kind] && panels.includes(layout.panelByKind[kind]!) ? layout.panelByKind[kind]! : null)) : null;
  const setActive = useCallback((p: PanelId | null) => setLayout({ ...layout, panelByKind: { ...layout.panelByKind, [kind]: p } }), [layout, setLayout, kind]);
  /* 树本体抽出来：常驻列和窄窗浮层用的是同一棵，别写两遍 */
  const tree = (
    <FileTree core={core} current={dirMode ? null : file} projectName={project.name}
      expanded={layout.tree.expanded}
      onExpandedChange={(ex) => setLayout({ ...layout, tree: { ...layout.tree, expanded: ex } })}
      onOpenFile={(f) => { open(f); if (narrow) setLayout({ ...layout, tree: { ...layout.tree, open: false } }); }}
      onOpenDir={(d) => { open(d, true); if (narrow) setLayout({ ...layout, tree: { ...layout.tree, open: false } }); }}
      healthOf={(path) => store.drafts.find((d) => d.file === path)?.health ?? null}
      tick={store.lastEvent?.at ?? ""}
    />
  );

  const chat = useChat(core, project.dir, { selectedDraft: dirMode ? null : file, selections, afterChanges: () => { void store.fetchDrafts(); if (file) { void store.fetchDiagnostics(file); void store.fetchChanges(file); } } });

  // 进项目：自动开上次看的稿（没有就第一份）
  useEffect(() => { host.setTitle(project.title || project.name); }, [host, project]);
  useEffect(() => {
    if (store.selected) return;
    if (!store.drafts.length) { open("", true); return; }   // 不含任何 .dc.html 的普通目录：直接进目录视图（`01` 第 25 条）
    const last = mem.get<string | null>(`us.lastDraft.${project.dir}`, null);
    const pick = store.drafts.find((d) => d.file === last) ?? store.drafts[0];
    if (pick) open(pick.file);
  }, [store.drafts]);   // eslint-disable-line react-hooks/exhaustive-deps
  /* 用 ResizeObserver 量详情区自己 —— 它能同时捕捉「窗口变了」和「旁边的列变宽了」。
     监听 window.resize 只能捕捉前者。 */
  useEffect(() => {
    const el = detailRef.current; if (!el) return;
    const ro = new ResizeObserver(([e]) => setDetailW(e!.contentRect.width));
    ro.observe(el); return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape" && present) setPresent(false);
      if (e.key === "Escape" && !present && dirSel.length) setDirSel([]);
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") { e.preventDefault(); setLayout({ ...layout, chatMode: layout.chatMode === "bar" ? "expanded" : "bar" }); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") { e.preventDefault(); setLayout({ ...layout, tree: { ...layout.tree, open: !layout.tree.open } }); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") { e.preventDefault(); if (layout.chatMode === "bar") setLayout({ ...layout, chatMode: "expanded" }); setTimeout(() => document.getElementById("chatInput")?.focus(), 50); }
    };
    document.addEventListener("keydown", on); return () => document.removeEventListener("keydown", on);
  }, [present, layout, setLayout, dirSel.length]);

  /** 打开任意文件或目录。目录不进页签（它是一个位置，不是一份文件）。 */
  const open = (f: string, isDir = false) => {
    setPicked(null); setFileMenu(false); setDirSel([]);
    setDirMode(isDir);
    store.select(isDir ? (f || "__root__") : f);
    if (isDir) return;
    mem.set(`us.lastDraft.${project.dir}`, f);
    setTabs((t) => { const n = t.includes(f) ? t : [...t, f]; mem.set(`us.tabs.${project.dir}`, n); return n; });
  };
  const dirRel = dirMode ? (file === "__root__" ? "" : (file ?? "")) : "";
  const closeTab = (f: string) => { const n = tabs.filter((x) => x !== f); setTabs(n); mem.set(`us.tabs.${project.dir}`, n); if (file === f) { const next = n[n.length - 1] ?? null; if (next) open(next); else store.select(null); } };
  /* 目录视图里选中若干文件 → 一颗 files 药丸带进会话（M8-4，`01` 第 32 条） */
  useEffect(() => {
    const on = (e: Event) => {
      const paths = (e as CustomEvent<string[]>).detail ?? [];
      if (!paths.length) return;
      if (layout.chatMode === "bar") setLayout({ ...layout, chatMode: "expanded" });
      setSelections((xs) => [...xs.filter((x) => x.kind !== "files"), { kind: "files", label: paths.length === 1 ? (paths[0]!.split("/").pop() ?? paths[0]!) : `${paths.length} 个文件`, detail: paths.join("\n") }]);
      setTimeout(() => document.getElementById("chatInput")?.focus(), 50);
    };
    window.addEventListener("ud-send-files", on); return () => window.removeEventListener("ud-send-files", on);
  }, [layout, setLayout]);

  const sendToAI = (text: string, p: Picked) => {
    setPicked(p);
    if (layout.chatMode === "bar") setLayout({ ...layout, chatMode: "expanded" });
    void chat.send(text, [{ kind: "node", label: `${p.tag ? `<${p.tag}> ` : ""}${draftTitle(p.file)} · ${p.node}`, detail: `${p.file} › ${p.node}`, ref: { file: p.file, node: p.node } }]);
  };
  const setChat = (patch: Partial<LayoutState>) => setLayout({ ...layout, ...patch });
  const draft = file ? store.drafts.find((d) => d.file === file) : undefined;
  const unresolved = store.comments.filter((c) => !c.resolved).length;
  const filtered = store.drafts.filter((d) => !fileQ || `${d.title} ${d.file}`.toLowerCase().includes(fileQ.toLowerCase()));

  const rail = layout.chatMode === "expanded" ? <ChatRail chat={chat} selections={selections} onDropSelection={(i) => setSelections((xs) => xs.filter((_, j) => j !== i))} onClearSelections={() => setSelections([])} contextLabel={dirMode ? (dirRel || "这个目录") : (file ? draftTitle(file) : null)} width={layout.chatWidth} onResize={(w) => setLayout({ ...layout, chatWidth: w })} side={layout.chatSide} onCollapse={() => setChat({ chatMode: "bar" })} onSwapSide={() => setChat({ chatSide: layout.chatSide === "left" ? "right" : "left" })} /> : null;
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
            {/* 目录钮放在页签条**最左边** —— 那里本来就是详情区的起点，
                所以展开前后目录都从同一个位置出来（设计侧第六轮 6.1 的理由）。
                收起态整列收掉、不留 40px 图标轨：目录只有一样东西，留条轨就一颗钮，白占一列宽。 */}
            <button className={`w-9 shrink-0 grid place-items-center border-r border-border hover:bg-hover ${layout.tree.open ? "text-accent" : "text-muted"}`}
              onClick={() => setLayout({ ...layout, tree: { ...layout.tree, open: !layout.tree.open } })}
              title={`${layout.tree.open ? "收起" : "展开"}目录（⌘B）`}>▤</button>
            <div className="flex-1 min-w-0 flex overflow-x-auto">
              {tabs.map((t) => { const d = store.drafts.find((x) => x.file === t); const cur = t === file; return <div key={t} className={`group flex items-center gap-1.5 pl-3 pr-2 border-r border-border cursor-pointer whitespace-nowrap ${cur ? "bg-bg border-t-2 border-t-accent -mb-px" : "text-muted hover:text-text"}`} onClick={() => open(t)} title={t}><span className={`hdot ${d?.health ?? "unchecked"}`} /><span className={cur ? "font-semibold" : ""}>{draftTitle(t)}</span><button className="ib opacity-0 group-hover:opacity-100 text-[10px]" onClick={(e) => { e.stopPropagation(); closeTab(t); }} title="关闭">×</button></div>; })}
            </div>
            <button className={`px-3 border-l border-border whitespace-nowrap ${dirMode ? "text-accent font-semibold" : "text-muted hover:text-text"}`} onClick={() => open("", true)} title="目录视图：这个项目里的所有文件">▤ 目录</button>
            <button className="px-3 border-l border-border text-muted hover:text-text whitespace-nowrap" onClick={() => { setFileMenu((m) => !m); setFileQ(""); }} title="所有稿件">{store.drafts.length} 份稿 ▾</button>
            {fileMenu && <div className="absolute right-0 top-[34px] z-30 w-[380px] max-h-[60vh] flex flex-col bg-panel border border-border rounded-b-lg shadow-2xl">
              <input autoFocus value={fileQ} onChange={(e) => setFileQ(e.target.value)} placeholder="搜稿名、文件名…" className="m-2 h-8 px-3 rounded border border-border bg-bg outline-none focus:border-accent" onKeyDown={(e) => { if (e.key === "Escape") setFileMenu(false); }} />
              <div className="flex-1 overflow-auto">{filtered.length ? filtered.map((d) => <button key={d.file} className={`w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-hover ${d.file === file ? "bg-accentSoft" : ""}`} onClick={() => open(d.file)}><span className={`hdot ${d.health}`} title={d.healthWhy} /><span className="truncate flex-1">{d.title}</span><span className="text-muted font-mono">{d.version ?? ""}</span><span className="text-muted">{d.elements ? `${d.elements} 元素` : ""}</span></button>) : <div className="p-3 text-muted">没有匹配的稿</div>}</div>
              <div className="px-3 h-8 flex items-center gap-2 border-t border-border text-muted"><span>{store.indexed ? "" : "还没建索引"}</span><span className="flex-1" /><button className="btn sm" onClick={() => { setFileMenu(false); setSheet("newDraft"); }}>新建稿件</button></div>
            </div>}
          </div>
          <div className="flex-1 min-h-0 flex">
            {/* 常驻目录列（设计侧第六轮 6.1）。**贴在详情左边，会话栏换边它不动** ——
                目录是用来翻详情的，两者得挨着，视线才不用跨过会话栏。
                详情区太窄时（narrow）它让位成浮层，盖在详情上，选中文件或 Esc 就收。 */}
            {layout.tree.open && (
              narrow ? (
                <>
                  <div className="absolute inset-0 z-20 bg-black/20" onMouseDown={() => setLayout({ ...layout, tree: { ...layout.tree, open: false } })} />
                  <aside className="absolute left-0 top-0 bottom-0 z-30 bg-panel border-r border-border shadow-2xl" style={{ width: 280 }}>{tree}</aside>
                </>
              ) : (
                <aside className="relative shrink-0 border-r border-border bg-panel" style={{ width: layout.tree.width }}>
                  {tree}
                  {/* 拖右边缘改宽；双击回默认 240 */}
                  <div className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-accent/30"
                    onDoubleClick={() => setLayout({ ...layout, tree: { ...layout.tree, width: TREE_W.def } })}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      const x0 = e.clientX, w0 = layout.tree.width;
                      const mv = (ev: MouseEvent) => setLayout({ ...layout, tree: { ...layout.tree, width: Math.min(TREE_W.max, Math.max(TREE_W.min, w0 + ev.clientX - x0)) } });
                      const up = () => { document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up); document.body.style.cursor = ""; };
                      document.body.style.cursor = "col-resize";
                      document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up);
                    }} />
                </aside>
              )
            )}
            <div ref={detailRef} className="flex-1 min-w-0 flex">
            {dirMode ? <DirView core={core} dirRel={dirRel} selected={dirSel} onSelectionChange={setDirSel} onOpen={open} />
              : !file ? <div className="flex-1 flex items-center justify-center text-muted text-xs text-center px-6 leading-relaxed bg-canvas">从上面的页签或目录里选一个文件</div>
              : kind === "dc" ? <Canvas url={project.url} store={store} file={file} picked={picked} onPicked={setPicked} mode={mode} setMode={(m) => { setMode(m); mem.set("us.previewMode", m); }} onPresent={() => setPresent(true)} onOpenPanel={(p) => setActive(p)} unresolved={unresolved} />
              : kind === "md" ? <MarkdownView core={core} path={file} writeTick={String(store.fileTick(file))} onWritten={() => void store.fetchDrafts()} onOutline={setOutline} onSelection={(s) => { if (!s) { setSelections((xs) => xs.filter((x) => x.kind !== "range")); return; } if (layout.chatMode === "bar") setLayout({ ...layout, chatMode: "expanded" }); setSelections((xs) => [...xs.filter((x) => x.kind !== "range"), s]); }} />
              : kind === "image" ? <ImageView core={core} path={file} supportsImage={chat.supportsImage} channelLabel={`通道 ${chat.channel.toUpperCase()}${chat.model ? ` · ${chat.model}` : ""}`}
                  onProbed={() => void chat.reloadCaps()}
                  onSelection={(s) => { if (!s) { setSelections((xs) => xs.filter((x) => x.kind !== "region")); return; } if (layout.chatMode === "bar") setLayout({ ...layout, chatMode: "expanded" }); setSelections((xs) => [...xs.filter((x) => x.kind !== "region"), s]); }} />
              : <FileCard core={core} host={host} path={file} onOpen={open} />}
            {file && panels.length > 0 && <SidePanels core={core} store={store} file={file} picked={picked} onPicked={setPicked} panels={panels} active={active} setActive={setActive} narrow={narrow} onSendToAI={sendToAI} outline={outline} />}
            </div>
          </div>
          {layout.chatMode === "bar" && (
            <div className="h-11 px-2 flex items-center gap-2 border-t border-border bg-panel shrink-0">
              <button className="ib" onClick={() => setChat({ chatMode: "expanded" })} title="展开会话栏">◧</button>
              {selections.map((s, i) => <span key={i} className="flex items-center gap-1 rounded border border-accent bg-accentSoft px-2 h-6 text-[11px] font-mono shrink-0" title={s.detail}><span className="text-accent font-semibold">{s.kind}</span><span className="truncate max-w-[160px]">{s.label}</span><button className="ib w-4 h-4 text-[10px]" onClick={() => setSelections((xs) => xs.filter((_, j) => j !== i))}>×</button></span>)}
              <input id="chatInput" value={chat.input} onChange={(e) => chat.setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void chat.send(); }} placeholder={chat.running ? "AI 正在跑…" : dirMode ? `对${dirRel ? ` ${dirRel}` : "这个目录"}说…` : file ? `对 ${draftTitle(file)} 说…` : "说要改什么…"} className="flex-1 h-8 px-3 rounded border border-border bg-bg text-xs outline-none focus:border-accent" />
              {chat.running ? <button className="btn sm danger" onClick={() => void chat.interrupt()}>中断</button> : <button className="btn sm primary" onClick={() => void chat.send()} disabled={!chat.input.trim()}>发送</button>}
            </div>
          )}
        </div>
        {layout.chatSide === "right" && rail}
      </div>
      <footer className="h-6 px-3 flex items-center gap-3 border-t border-border bg-panel shrink-0 text-[11px] text-muted font-mono">
        {dirMode ? <><span className="truncate">{dirRel || "项目根"}</span><span>·</span><span>目录</span>{dirSel.length > 0 && <><span>·</span><span>已选 {dirSel.length} 项</span></>}</>
          : file ? <><span className="truncate">{file}</span><span>·</span><span>{kind === "dc" ? (draft?.kind === "component" ? "组件稿" : "设计稿") : KIND_LABEL[kind]}</span>{draft && kind === "dc" && <><span>·</span><span>{draft.version ?? "—"}</span><span>·</span><span>{draft.elements ?? "—"} 元素</span><span>·</span><span title={draft.healthWhy}>{HEALTH_LABEL[draft.health]}</span></>}</>
          : <span>没有打开的文件</span>}
        <span className="flex-1" />
        <span>会话在{layout.chatMode === "bar" ? "输入条" : layout.chatSide === "left" ? "左" : "右"} · {layout.chatWidth} px</span>
      </footer>
      {present && file && <Present url={project.url} file={file} onStop={() => setPresent(false)} />}
      {sheet === "newDraft" && <NewDraftSheet core={core} current={file} onClose={() => setSheet(null)} onCreated={async (f) => { await store.fetchDrafts(); open(f); }} />}
    </div>
  );
}
