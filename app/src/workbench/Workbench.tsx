import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Core, type ProjectHandle } from "../api/client";
import { draftTitle, type Picked, type Selection } from "../api/types";
import { ChatRail } from "../chat/ChatRail";
import { useChat } from "../chat/useChat";
import type { HostAdapter } from "../host";
import { TREE_W, kindOf, mem, type LayoutState, type PanelId } from "../layout/layout";
import { engineLabel } from "../chat/channel";
import { useProject } from "../store/project";
import { NewDraftSheet } from "../sheets/Sheets";
import { toast } from "../ui/Toast";
import { Present } from "./Canvas";
import { Glyph, ICON } from "../ui/Glyph";
import { FileTree } from "./FileTree";
/* 详情区怎么画、右边配什么面板、状态行写什么，**全在 kinds 注册表里**。
   这个文件从此不认识任何一种具体格式 —— 加 `.json` 时它一个字都没动（M8-14）。 */
import { moduleFor, type ViewContext } from "../kinds";
import { kindDef } from "@shared/kinds";
import { FileMore, ToolbarBar } from "../kinds/toolbar";

/** 工作台（S11 形制）：顶栏 40 · 页签 34 · 左会话 / 中画布 / 右从属面板列 · 底部状态行 24 */
export function Workbench({ project, host, layout, setLayout, onHome, onSettings }: { project: ProjectHandle; host: HostAdapter; layout: LayoutState; setLayout: (l: LayoutState) => void; onHome: () => void; onSettings: () => void }) {
  const core = useMemo(() => new Core(project.url, project.token, project.ws), [project]);
  const store = useProject(core, project.dir);
  const [tabs, setTabs] = useState<string[]>(() => mem.get(`us.tabs.${project.dir}`, []));
  /** 当前打开的是目录时，file 是目录路径（"" = 项目根），dirMode 为真 */
  const [dirMode, setDirMode] = useState(false);
  /* 曾经在这里的三样 state 已经搬进各自的格式模块：
     `dirSel` → `kinds/dir.tsx`（只有目录用）、`outline` → `kinds/md.tsx`（只有 Markdown 用）、
     `mode`（预览模式）→ `kinds/dc.tsx`（只有设计稿用）。
     它们留在这儿的代价不只是乱：改一个目录的勾选，整个工作台跟着重渲染。 */
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
  const [present, setPresent] = useState(false);
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
  const mod = moduleFor(kind);
  const panels = [...(mod.panels ?? [])];
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
      drafts={store.drafts} indexed={store.indexed} onSpread={() => open("", true)}
      tick={store.lastEvent?.at ?? ""}
    />
  );

  const chat = useChat(core, project.dir, { selectedDraft: dirMode ? null : file, selections, afterChanges: () => { void store.fetchDrafts(); if (file) { void store.fetchDiagnostics(file); void store.fetchChanges(file); } } });

  // 进项目：自动开上次看的稿（没有就第一份）
  useEffect(() => { host.setTitle(project.title || project.name); }, [host, project]);
  useEffect(() => {
    if (store.selected) return;
    /* 【M8-11 之后改了】以前这里会自动 `open("", true)` 进目录视图。
       那是**常驻目录列出现之前**的做法：那时候详情区不铺目录，用户就没有导航。
       现在左边一直有树，详情区再铺一份同样的内容就是重复 ——
       用户实测提的：「预览页面如果没有选中任何文件或者目录时，不应显示目录列表」。
       所以这里什么都不做，让详情区停在占位态。 */
    if (!store.drafts.length) return;
    const last = mem.get<string | null>(`us.lastDraft.${project.dir}`, null);
    const pick = store.drafts.find((d) => d.file === last) ?? store.drafts[0];
    if (pick) open(pick.file);
  }, [store.drafts]);   // eslint-disable-line react-hooks/exhaustive-deps
  /* 用 ResizeObserver 量详情区自己 —— 它能同时捕捉「窗口变了」和「旁边的列变宽了」。
     监听 window.resize 只能捕捉前者。 */
  useEffect(() => {
    const el = detailRef.current; if (!el) return;
    /* **两处都是踩出来的**（M8-14）：
       ① 依赖里要有 kind —— 格式模块的 Provider 按 kind 挂载，换格式时这个 div 会重建，
          依赖写 `[]` 的话观察器还绑在**已经卸载的旧节点**上，从此再也量不到真宽度。
       ② 0 要忽略 —— 节点卸载的那一瞬会报一次宽度 0，而 0 < 480 就是 narrow，
          于是从属面板弹出它的全屏遮罩，整个界面点不动了。这条是 uitest 抓到的：
          它报「有个 fixed inset-0 的遮罩拦住了点击」，人眼看截图只会觉得"暗了一点"。 */
    const ro = new ResizeObserver(([e]) => { const w = e!.contentRect.width; if (w > 0) setDetailW(w); });
    ro.observe(el); return () => ro.disconnect();
  }, [kind]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape" && present) setPresent(false);
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") { e.preventDefault(); setLayout({ ...layout, chatMode: layout.chatMode === "bar" ? "expanded" : "bar" }); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") { e.preventDefault(); setLayout({ ...layout, tree: { ...layout.tree, open: !layout.tree.open } }); }
      /* ⌘P 转到文件：入口在目录列头，收起时先展开它，不然浮层挂在一个不存在的列上 */
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p") {
        e.preventDefault();
        if (!layout.tree.open) setLayout({ ...layout, tree: { ...layout.tree, open: true } });
        setTimeout(() => window.dispatchEvent(new CustomEvent("ud-goto-file")), layout.tree.open ? 0 : 60);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") { e.preventDefault(); if (layout.chatMode === "bar") setLayout({ ...layout, chatMode: "expanded" }); setTimeout(() => document.getElementById("chatInput")?.focus(), 50); }
    };
    document.addEventListener("keydown", on); return () => document.removeEventListener("keydown", on);
  }, [present, layout, setLayout]);

  /** 打开任意文件或目录。目录不进页签（它是一个位置，不是一份文件）。 */
  const open = (f: string, isDir = false) => {
    setPicked(null);
    setDirMode(isDir);
    store.select(isDir ? (f || "__root__") : f);
    if (isDir) return;
    mem.set(`us.lastDraft.${project.dir}`, f);
    setTabs((t) => { const n = t.includes(f) ? t : [...t, f]; mem.set(`us.tabs.${project.dir}`, n); return n; });
  };
  const dirRel = dirMode ? (file === "__root__" ? "" : (file ?? "")) : "";
  const closeTab = (f: string) => { const n = tabs.filter((x) => x !== f); setTabs(n); mem.set(`us.tabs.${project.dir}`, n); if (file === f) { const next = n[n.length - 1] ?? null; if (next) open(next); else store.select(null); } };

  const setChat = (patch: Partial<LayoutState>) => setLayout({ ...layout, ...patch });
  const expandChat = useCallback(() => { if (layout.chatMode === "bar") setLayout({ ...layout, chatMode: "expanded" }); }, [layout, setLayout]);
  /** 同一类选区只留一颗 —— 选区是「当前选的那一块」，不是历史记录 */
  const putSelection = useCallback((k: Selection["kind"], sel: Selection | null) => {
    setSelections((xs) => [...xs.filter((x) => x.kind !== k), ...(sel ? [sel] : [])]);
    if (sel) expandChat();
  }, [expandChat]);

  /** 交给格式模块的能力面（`kinds/context.ts` 是这份契约的出处）。
   *  工作台到这里为止 —— 下面它只负责把 View / Panels / Status 摆到对的位置，
   *  再也不知道「dc 要 picked、md 要 outline、图片要问吃不吃图」这些事。 */
  const ctx: ViewContext = {
    core, host, project, store,
    path: dirMode ? dirRel : (file ?? ""),
    kind, narrow,
    open,
    select: putSelection,
    ask: (text, sels) => { expandChat(); void chat.send(text, sels); },
    picked, setPicked,
    ui: { activePanel: active, openPanel: setActive, expandChat, present: () => setPresent(true), closeFile: () => { if (file) closeTab(file); }, toast },
    ai: { supportsImage: chat.supportsImage, engineLabel: engineLabel(chat.caps, chat.channel, chat.model), reloadCaps: () => void chat.reloadCaps() },
    mem: {
      get: (k, d) => mem.get(`us.kind.${kind}.${k}`, d),
      set: (k, v) => mem.set(`us.kind.${kind}.${k}`, v),
    },
  };
  /* Provider **按 kind 挂载**（`key={kind}`）：换格式时上一种的状态跟着卸载，
     换文件时不重建 —— 否则每换一份稿 Canvas 的 iframe 都要重挂一次，会闪。
     「换文件要清什么」由各模块自己用 useEffect 决定，比一刀切的 key 精确。 */
  const Wrap = mod.Provider ?? (({ children }: { ctx: ViewContext; children: React.ReactNode }) => <>{children}</>);


  const rail = layout.chatMode === "expanded" ? <ChatRail chat={chat} selections={selections} onDropSelection={(i) => setSelections((xs) => xs.filter((_, j) => j !== i))} onClearSelections={() => setSelections([])} contextLabel={dirMode ? (dirRel || "这个目录") : (file ? draftTitle(file) : null)} width={layout.chatWidth} onResize={(w) => setLayout({ ...layout, chatWidth: w })} side={layout.chatSide} onCollapse={() => setChat({ chatMode: "bar" })} onSwapSide={() => setChat({ chatSide: layout.chatSide === "left" ? "right" : "left" })} /> : null;
  return (
    <div className="h-full flex flex-col">
      {/* ═══ 顶栏 38px · 只放两类：「应用 / 项目」和「窗口布局」（设计侧第七轮）═══
          判据是「点了它，变的是什么」：变的是整个项目或整扇窗的才配站在这儿。
          项目路径从顶栏拿掉了 —— 它占 280px，却只是信息，没人点它，现在进项目菜单。 */}
      <header className="h-[38px] px-2.5 flex items-center gap-1 border-b border-border bg-panel shrink-0 text-xs relative z-30">
        {/* **只剩图标**（M8-16，用户实测第 2 条）：应用名在窗口标题上已经有了，
            顶栏再写一遍「Umbra Studio」是重复，而且它右边紧跟着项目名，读起来像一个长名字。 */}
        <button className="w-7 h-[26px] grid place-items-center rounded hover:bg-hover shrink-0 text-accent" onClick={onHome} title="回到项目列表" aria-label="回到项目列表">
          <svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="1.5" y="1.5" width="13" height="13" rx="3.2" stroke="currentColor" strokeWidth="1.4" />
            <path d="M5 8.2h6M5 5.4h6M5 11h3.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
        <div className="relative min-w-0 flex">
          <button className={`min-w-0 max-w-[420px] flex items-center gap-1.5 h-[26px] pl-2 pr-1.5 rounded hover:bg-hover ${menu ? "bg-hover" : ""}`}
            onClick={() => setMenu((m) => !m)} aria-expanded={menu} aria-haspopup="menu" title={project.dir}>
            <span className="font-semibold truncate">{project.title || project.name}</span>
            <Glyph d={ICON.caretDown} size={11} stroke={1.6} className="text-muted" />
          </button>
          {menu && <>
            <div className="fixed inset-0 z-40" onClick={() => setMenu(false)} />
            <div role="menu" className="absolute top-[31px] left-0 z-[41] w-72 p-1 bg-panel border border-borderStrong rounded-lg shadow-2xl text-left">
              {/* 只放路径。**项目名不再写第二遍**（M8-16，用户实测第 3 条：
                  「左上角项目名称后，又出现了一个项目名称，这种 double name」）——
                  按钮上就是项目名，菜单是它的展开，展开里再报一次名字没有信息量。 */}
              <div className="px-2 pt-1.5 pb-2 mb-1 border-b border-border">
                <span className="font-mono text-[11px] text-muted break-all leading-relaxed">{project.dir}</span>
              </div>
              {[
                { label: "新建稿件", run: () => setSheet("newDraft") },
                { label: "重建索引", run: () => void store.rebuildIndex() },
                { label: "在访达中显示", run: () => void host.revealInFinder(project.dir).catch((e: Error) => toast("打开目录失败", e.message, "error")) },
                { sep: true as const },
                { label: "项目设置 · 外观", hint: "⌘,", run: onSettings },
                { sep: true as const },
                { label: "关闭项目", run: onHome },
              ].map((mi, k) => mi.sep
                ? <div key={k} className="h-px mx-1.5 my-1 bg-border" />
                : <button key={k} className="w-full flex items-center gap-2 h-7 px-2 rounded hover:bg-hover text-left"
                    onClick={() => { setMenu(false); mi.run!(); }}>
                    <span className="flex-1 min-w-0 truncate">{mi.label}</span>
                    {mi.hint && <span className="font-mono text-[11px] text-muted shrink-0">{mi.hint}</span>}
                  </button>)}
            </div>
          </>}
        </div>
        <span className="flex-1" />
        <span className={`text-[11px] ${store.wsState === "open" ? "text-muted" : "text-err"}`} title={store.lastEvent ? `最近事件 ${store.lastEvent.type} · ${store.lastEvent.at}` : "还没有事件"}>{store.wsState === "open" ? "" : "核心断开"}</span>
        {/* 窗口布局组：目录列在不在 · 会话栏在哪。**目录钮从页签条挪到这里** ——
            它变的是窗口布局，和「会话在左还是右」同一类，不是「开着哪些文件」那一类。 */}
        <div role="group" aria-label="窗口布局" className="flex items-center gap-0.5 p-0.5 bg-panel2 border border-border rounded shrink-0">
          <button data-ud="tree-toggle" className={`w-[30px] h-6 grid place-items-center rounded-sm transition-colors ${layout.tree.open ? "bg-panel text-text shadow-sm" : "text-muted hover:text-text"}`}
            onClick={() => setLayout({ ...layout, tree: { ...layout.tree, open: !layout.tree.open } })}
            aria-pressed={layout.tree.open} title={`${layout.tree.open ? "收起" : "显示"}目录列（⌘B）`}>
            <Glyph d={ICON.tree} />
          </button>
          <span className="w-px h-3.5 mx-0.5 bg-borderStrong" />
          {([["left", ICON.chatLeft, "会话在左"], ["bar", ICON.chatBar, "会话收成输入条（⌘\\）"], ["right", ICON.chatRight, "会话在右"]] as const).map(([k, d, t]) => {
            const on = k === "bar" ? layout.chatMode === "bar" : layout.chatMode === "expanded" && layout.chatSide === k;
            return <button key={k} className={`w-[30px] h-6 grid place-items-center rounded-sm transition-colors ${on ? "bg-panel text-text shadow-sm" : "text-muted hover:text-text"}`}
              onClick={() => setChat(k === "bar" ? { chatMode: "bar" } : { chatSide: k, chatMode: "expanded" })}
              aria-pressed={on} title={t}><Glyph d={d} /></button>;
          })}
        </div>
      </header>
      {/* Provider 要同时包住详情区和状态行（目录的「已选 3 项」在状态行读模块内部的勾选） */}
      <Wrap ctx={ctx} key={kind}>
      <div className="flex-1 min-h-0 flex relative">
        {layout.chatSide === "left" && rail}
        {/* ═══ 常驻目录列（第六轮 6.1；M8-15 提到主体层）═══
            **贴在详情左边，会话栏换边它不动** —— 目录是用来翻详情的，两者得挨着，
            视线才不用跨过会话栏。
            它现在**通栏**（顶栏下直达底部），页签条和文件工具栏只盖住详情列。
            M8-11 时它在页签条下方，那时候页签条最左边有目录开关，通栏是对的；
            第七轮把那颗钮挪进顶栏之后，再让页签条横跨目录列就说不通了 ——
            **页签条讲的是「开着哪些文件」，和目录列没有关系。**
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
        <div className="flex-1 min-w-0 flex flex-col">
          {/* ═══ 页签条 34px · 只管「开着哪些文件」（设计侧第七轮）═══
              原来这条带上挤了三样不属于它的东西：目录列开关（→ 顶栏布局组）、
              「▤ 目录」（→ 目录列头的「铺到详情区」）、「N 份稿 ▾」（→ 目录列头的「转到文件」）。
              两个都叫「目录」的钮其实一个变布局、一个变导航，分开之后才说得清。 */}
          <div data-ud="tabbar" className="h-[34px] flex items-stretch border-b border-border bg-panel shrink-0 text-xs">
            <div className="flex-1 min-w-0 flex overflow-x-auto">
              {tabs.map((t) => { const d = store.drafts.find((x) => x.file === t); const cur = t === file; return <div key={t} className={`group flex items-center gap-1.5 pl-3 pr-2 border-r border-border cursor-pointer whitespace-nowrap ${cur ? "bg-bg border-t-2 border-t-accent -mb-px" : "text-muted hover:text-text"}`} onClick={() => open(t)} title={t}><span className={`hdot ${d?.health ?? "unchecked"}`} /><span className={cur ? "font-semibold" : ""}>{draftTitle(t)}</span><button className="ib opacity-0 group-hover:opacity-100 text-[10px]" onClick={(e) => { e.stopPropagation(); closeTab(t); }} title="关闭">×</button></div>; })}
              {tabs.length === 0 && <span className="px-3 self-center text-muted text-[11px]">还没打开文件 —— 从左边的目录里选一个</span>}
            </div>
          </div>
          {/* ═══ 文件工具栏 34px · 只管「当前这份文件」（第七轮第四层）═══
              **模块不声明 Toolbar 就不出这条带** —— 设计侧明确说代码和其他文件没有这一行，
              不要给它留一条空横带。`⋯` 的公共尾巴由 `FileMore` 补，不用每个模块重复写。 */}
          {(dirMode || file) && mod.Toolbar && (
            <ToolbarBar>
              <mod.Toolbar ctx={ctx} />
              {/* 这份文件的读数**挪到了工具栏右端**（M8-16）。
                  它原来在底部状态行，而那条整条去掉了 —— 用户说文件名在页签上已经有、
                  元素数和体检状态他不想在底部看到。放在这儿不算重复：
                  文件工具栏本来就是「这份文件」那一层。最终要留哪些读数由第八轮定。
                  ⚠️ 只有声明了 `Toolbar` 的格式才有这条横带，所以现在只有 JSON 能看到；
                  其余四种等 M8-15b 工具栏上移时一起归位。 */}
              {/* 不声明 `Status` 就用类型名兜底 —— 这条兜底原来在状态行里，
                  搬位置时我漏了它，工具栏右端就空着（M8-16 实测）。
                  正是 `registry.ts` 那条注释警告过的「一条省略等于空白的接口，早晚有人省略」。 */}
              <span className="flex items-center gap-1.5 text-[11px] text-muted font-mono shrink-0">
                {mod.Status ? <mod.Status ctx={ctx} /> : kindDef(kind).label}
              </span>
              <FileMore ctx={ctx} items={mod.menu?.(ctx) ?? []} />
            </ToolbarBar>
          )}
          <div ref={detailRef} className="flex-1 min-h-0 flex">
            {!dirMode && !file ? (
                <div className="flex-1 flex flex-col items-center justify-center gap-2 text-muted text-xs text-center px-6 leading-relaxed bg-canvas">
                  <div className="text-2xl opacity-25">◧</div>
                  <div><b className="text-text2">从左边的目录里选一个文件</b></div>
                  <div className="text-[11px]">
                    双击目录能在这里以它为根打开{layout.tree.open ? "" : "；⌘B 展开目录列"}
                  </div>
                </div>
              ) : (
                <>
                  <mod.View ctx={ctx} />
                  {mod.Panels && panels.length > 0 && <mod.Panels ctx={ctx} />}
                </>
              )}
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
      {/* 底部状态行**整条去掉**（M8-16，用户实测第 9 / 13 条）。
          它上面那几样，每一样在别处都已经有了：文件名在页签上、类型和读数在文件工具栏、
          「会话在左 · 380 px」根本是调试信息。用户的话：这种调试信息该放进一个调试模块。
          ⚠️ **调试模块还没有** —— 形制在第八轮交给设计侧（`doc/14` §八第 8 条）。
          在那之前这些读数暂时看不到，这是有意的：宁可少显示，也不留一条谁都不看的横带。 */}
      </Wrap>
      {present && file && <Present url={project.url} file={file} onStop={() => setPresent(false)} />}
      {sheet === "newDraft" && <NewDraftSheet core={core} current={file} onClose={() => setSheet(null)} onCreated={async (f) => { await store.fetchDrafts(); open(f); }} />}
    </div>
  );
}
