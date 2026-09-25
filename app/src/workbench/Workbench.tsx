import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Core, type ProjectHandle } from "../api/client";
import { draftTitle, type Picked, type Selection } from "../api/types";
import { ChatRail } from "../chat/ChatRail";
import { useChat } from "../chat/useChat";
import type { HostAdapter } from "../host";
import { TREE_W, computeYield, kindOf, mem, type LayoutState, type PanelId } from "../layout/layout";
import { engineLabel } from "../chat/channel";
import { useProject } from "../store/project";
import { NewDraftSheet } from "../sheets/Sheets";
import { toast } from "../ui/Toast";
import { Glyph, ICON } from "../ui/Glyph";
import { BottomBar } from "./BottomBar";
import { debugBus, wireDebug } from "../ui/debug";
import { dirtyStore } from "../ui/dirty";
import { FileTree } from "./FileTree";
/* 详情区怎么画、右边配什么面板、状态行写什么，**全在 kinds 注册表里**。
   这个文件从此不认识任何一种具体格式 —— 加 `.json` 时它一个字都没动（M8-14）。 */
import { moduleFor, type ViewContext } from "../kinds";
import { kindDef } from "@shared/kinds";
import { FileMore, ToolbarBar } from "../kinds/toolbar";
import { makeActions } from "./ctxmenu";
import { TabBar } from "./TabBar";

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
  const [sheet, setSheet] = useState<{ kind: "newDraft"; dir: string } | null>(null);
  /* 让位（R2–R5）。**主动算，不量 DOM**（M8-18 换的做法，理由见 `layout.ts` 的 computeYield）。
     量的只有一样：整个工作台有多宽。它是最外层那个容器，不会因为格式模块换 key 而重挂。 */
  const rootRef = useRef<HTMLDivElement>(null);
  const [winW, setWinW] = useState(() => window.innerWidth);
  const [menu, setMenu] = useState(false);
  const file = store.selected;
  const kind = dirMode ? "dir" : kindOf(file);
  const mod = moduleFor(kind);
  const panels = [...(mod.panels ?? [])];
  const active: PanelId | null = panels.length ? (layout.panelByKind[kind] === undefined ? panels[0]! : (layout.panelByKind[kind] && panels.includes(layout.panelByKind[kind]!) ? layout.panelByKind[kind]! : null)) : null;
  const setActive = useCallback((p: PanelId | null) => setLayout({ ...layout, panelByKind: { ...layout.panelByKind, [kind]: p } }), [layout, setLayout, kind]);
  /* 树本体抽出来：常驻列和窄窗浮层用的是同一棵，别写两遍 */
  /* ── 移到回收站的行内撤销（M8-21）──
     设计侧 §五：**不弹确认框**，删完原地给一行撤销。
     「多久算离开」按 `00` §75.4 定的四条：打开别的文件或目录 · 再删一个 ·
     开始重命名或新建 · 切项目或关窗。第四条是我们加的 ——
     不加的话关窗时那一行还悬着，重开之后用户既看不到撤销入口、文件也没真删。 */
  const [trashed, setTrashed] = useState<string[]>([]);
  const trashedRef = useRef<string[]>([]); trashedRef.current = trashed;
  const commitTrash = useCallback(() => {
    const list = trashedRef.current;
    if (!list.length) return;
    setTrashed([]);
    for (const path of list) void core.post("file_trash", { path });
  }, [core]);
  /* 关窗 / 切项目：卸载时落实 */
  useEffect(() => () => commitTrash(), [commitTrash]);

  /** 右键菜单的动作，目录列和目录视图共用（`ctxmenu.tsx`） */
  const [localTick, setLocalTick] = useState(0);
  const ctxActions = makeActions({
    core, host, projectDir: project.dir,
    onOpenFile: (f) => open(f), onOpenDir: (d) => open(d, true),
    onToChat: (paths) => { putSelection("files", { kind: "files", label: paths.length === 1 ? (paths[0]!.split("/").pop() ?? paths[0]!) : `${paths.length} 项`, detail: paths.join("\n") }); setTimeout(() => document.getElementById("chatInput")?.focus(), 50); },
    onRename: () => {},   // 就地改名由 FileTree 自己接管（它知道是哪一行）
    onNewDraft: (dir) => setSheet({ kind: "newDraft", dir }),
    onCollapseAll: () => setLayout({ ...layout, tree: { ...layout.tree, expanded: [] } }),
    onTrashed: (paths) => { commitTrash(); setTrashed(paths); },   // 「再删一个」：上一批先落实
    onRebuildIndex: () => void store.rebuildIndex(),
    refresh: () => setLocalTick((t) => t + 1),
  });

  const tree = (
    <FileTree core={core} current={dirMode ? null : file} projectName={project.name}
      expanded={layout.tree.expanded}
      onExpandedChange={(ex) => setLayout({ ...layout, tree: { ...layout.tree, expanded: ex } })}
      /* 浮层态下选完就收 —— 它盖在详情上，不收的话挡着刚打开的文件。
         并排态不收：那是常驻导航。 */
      onOpenFile={(f) => { open(f); if (!treeInline) setLayout({ ...layout, tree: { ...layout.tree, open: false } }); }}
      onOpenDir={(d) => { open(d, true); if (!treeInline) setLayout({ ...layout, tree: { ...layout.tree, open: false } }); }}
      healthOf={(path) => store.drafts.find((d) => d.file === path)?.health ?? null}
      drafts={store.drafts} indexed={store.indexed} onCollapse={() => setLayout({ ...layout, tree: { ...layout.tree, open: false } })}
      actions={ctxActions} trashed={trashed} onUndoTrash={(p) => setTrashed((xs) => xs.filter((x) => x !== p))}
      tick={`${store.lastEvent?.at ?? ""}:${localTick}`}
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
    const el = rootRef.current; if (!el) return;
    const ro = new ResizeObserver(([e]) => { const w = e!.contentRect.width; if (w > 0) setWinW(w); });
    ro.observe(el); return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      /* 三块区域（设计侧第八轮定的键）。⌘\ 这个键没变，变的是语义：
         以前是「会话栏展开 / 收成输入条」，现在是「左栏在不在」—— 半开那一态删了。 */
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") { e.preventDefault(); setLayout({ ...layout, left: !layout.left }); }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "j") { e.preventDefault(); setLayout({ ...layout, bottom: !layout.bottom }); }
      if ((e.metaKey || e.ctrlKey) && e.altKey && e.key.toLowerCase() === "b") { e.preventDefault(); if (panels.length) setLayout({ ...layout, right: !layout.right }); }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "b") { e.preventDefault(); setLayout({ ...layout, tree: { ...layout.tree, open: !layout.tree.open } }); }
      /* ⌘P 转到文件：入口在目录列头，收起时先展开它，不然浮层挂在一个不存在的列上 */
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p") {
        e.preventDefault();
        if (!layout.tree.open) setLayout({ ...layout, tree: { ...layout.tree, open: true } });
        setTimeout(() => window.dispatchEvent(new CustomEvent("ud-goto-file")), layout.tree.open ? 0 : 60);
      }
      /* ⌘L 聚焦会话输入框。**原来是 ⌘J，让给底栏了**（`00` §75.4）——
         Cursor 和 VS Code 的 Copilot Chat 都用 ⌘L 聚焦聊天输入，用户正在用 Cursor。
         左栏关着时先打开再聚焦：他按这个键的意图很清楚，别让他按了没反应。 */
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "l") {
        e.preventDefault();
        if (!layout.left) setLayout({ ...layout, left: true });
        setTimeout(() => document.getElementById("chatInput")?.focus(), layout.left ? 0 : 60);
      }
    };
    document.addEventListener("keydown", on); return () => document.removeEventListener("keydown", on);
  }, [layout, setLayout, panels.length]);

  /** 打开任意文件或目录。目录不进页签（它是一个位置，不是一份文件）。 */
  const open = (f: string, isDir = false) => {
    commitTrash();   // 「做下一件事」的第一条：打开别的文件或目录
    setPicked(null);
    setDirMode(isDir);
    store.select(isDir ? (f || "__root__") : f);
    if (isDir) return;
    mem.set(`us.lastDraft.${project.dir}`, f);
    setTabs((t) => { const n = t.includes(f) ? t : [...t, f]; mem.set(`us.tabs.${project.dir}`, n); return n; });
  };
  const dirRel = dirMode ? (file === "__root__" ? "" : (file ?? "")) : "";
  const closeTab = (f: string) => { dirtyStore.drop(f); const n = tabs.filter((x) => x !== f); setTabs(n); mem.set(`us.tabs.${project.dir}`, n); if (file === f) { const next = n[n.length - 1] ?? null; if (next) open(next); else store.select(null); } };

  /* 底栏那颗钮的红点：有没有 error。关着的时候才提示，打开看过就消。 */
  wireDebug();
  const hasDebugError = useSyncExternalStore(debugBus.subscribe, () => debugBus.hasError());


  /** 让位算一次，下面三处都用它：目录列并排还是浮层、面板体展开还是抽屉、底栏的布局读数 */
  const yieldNow = computeYield(layout, winW, panels.length > 0);
  const { panelDrawer, treeInline } = yieldNow;
  const expandChat = useCallback(() => { if (!layout.left) setLayout({ ...layout, left: true }); }, [layout, setLayout]);
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
    kind, narrow: panelDrawer, detail: yieldNow.detail,
    open,
    select: putSelection,
    ask: (text, sels) => { expandChat(); void chat.send(text, sels); },
    picked, setPicked,
    ui: { activePanel: active, openPanel: setActive, expandChat, closeFile: () => { if (file) closeTab(file); }, toast },
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


  /* 会话栏**固定在左**（第八轮：换边那一态有意删了），所以不再有 side / 换边 / 关闭三个 props。
     关会话只有一个入口：顶栏的左栏钮（或 ⌘\）。 */
  const rail = layout.left ? <ChatRail chat={chat} selections={selections} onDropSelection={(i) => setSelections((xs) => xs.filter((_, j) => j !== i))} onClearSelections={() => setSelections([])} contextLabel={dirMode ? (dirRel || "这个目录") : (file ? draftTitle(file) : null)} width={layout.chatWidth} onResize={(w) => setLayout({ ...layout, chatWidth: w })} /> : null;
  return (
    <div ref={rootRef} className="h-full flex flex-col">
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
              {/* 路径**整块可点，点了就复制**（第八轮 §三）——
                  所以菜单里不再单独放一项「复制路径」。
                  项目名不写第二遍：按钮上就是它，菜单是它的展开（M8-16 用户提的 double name）。 */}
              <button className="w-full text-left px-2 pt-1.5 pb-2 mb-1 border-b border-border hover:bg-hover"
                onClick={() => { setMenu(false); void navigator.clipboard?.writeText(project.dir).then(() => toast("路径已复制", project.dir, "ok"), () => toast("复制不了", "浏览器不让访问剪贴板", "error")); }}>
                <div className="text-[11px] text-muted mb-0.5">项目目录 · 点击复制</div>
                <div className="font-mono text-[11px] break-all leading-relaxed">{project.dir}</div>
              </button>
              {[
                /* **「新建稿件」去了目录右键**（第八轮 §三）：右键点在哪里，稿就建在哪里，
                   不用在这里点完再选一次位置。 */
                { label: "在访达中显示", run: () => void host.revealInFinder(project.dir).catch((e: Error) => toast("打开目录失败", e.message, "error")) },
                { label: "重建索引", run: () => void store.rebuildIndex() },
                { sep: true as const },
                { label: "项目设置…", hint: "⌘,", run: onSettings },
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
        {/* ═══ 窗口布局组（第八轮换的模型）═══
            三颗钮 = 左 / 底 / 右三块区域**在不在**，图标画的就是那一块。
            用户原话：「不应该是控制聊天模块显示在什么位置上，而应该是控制左侧模块是否显示，
            底部模块是否显示，右侧模块是否显示」。
            ⚠️ **目录列不在这里** —— 它属于「中间」，开关只在它自己的列头上。
            第七轮那颗目录钮就是因为这条删掉的。 */}
        <div role="group" aria-label="窗口布局" className="flex items-center gap-0.5 p-0.5 bg-panel2 border border-border rounded shrink-0">
          {([
            ["left", ICON.regionLeft, layout.left, `${layout.left ? "隐藏" : "显示"}左栏 · 会话（⌘\\）`, false],
            ["bottom", ICON.regionBottom, layout.bottom, `${layout.bottom ? "隐藏" : "显示"}底栏 · 调试（⌘J）`, false],
            ["right", ICON.regionRight, layout.right && panels.length > 0, `${layout.right ? "隐藏" : "显示"}右栏 · 面板（⌘⌥B）`, panels.length === 0],
          ] as const).map(([k, d, on, title, disabled]) => (
            <button key={k} data-ud={`region-${k}`} disabled={disabled} aria-pressed={on}
              title={disabled ? "这类文件没有从属面板" : title + (k === "bottom" && hasDebugError && !layout.bottom ? " · 有新的错误" : "")}
              onClick={() => setLayout({ ...layout, [k]: !layout[k] })}
              className={`relative w-[30px] h-6 grid place-items-center rounded-sm transition-colors disabled:opacity-40 disabled:cursor-default ${
                on ? "bg-panel text-text shadow-sm" : "text-muted hover:text-text"}`}>
              <Glyph d={d} />
              {/* 底栏关着却出了 error：挂一个红点。打开看过就消（设计侧演示态 8） */}
              {k === "bottom" && hasDebugError && !layout.bottom && <span className="absolute top-0.5 right-1 w-1.5 h-1.5 rounded-full bg-err" />}
            </button>
          ))}
        </div>
      </header>
      {/* Provider 要同时包住详情区和状态行（目录的「已选 3 项」在状态行读模块内部的勾选） */}
      {/* Provider 包住详情、工具栏、状态读数三处 —— 它们都要读格式模块内部的状态 */}
      <Wrap ctx={ctx} key={kind}>
        <div className="flex-1 min-h-0 flex relative">
          {rail}
          {/* ═══ 中间这一柱 = 目录列 + 详情列 + 底栏 ═══
            **底栏只横跨这一柱**（设计侧第八轮 §二）：会话的输入框要贴着窗口底部，
            右栏的属性面板要整列的高度，所以那两块在柱子外面。 */}
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="flex-1 min-h-0 flex relative">
              {layout.tree.open && (
                !treeInline ? (
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
              <TabBar tabs={tabs} current={dirMode ? null : file} onPick={open}
                onClose={closeTab} onCloseOthers={(keep) => { setTabs([keep]); mem.set(`us.tabs.${project.dir}`, [keep]); if (file !== keep) open(keep); }}
                extra={!layout.tree.open ? (
                  /* 目录收起后，**同一个图标、箭头反向**出现在这里 —— 目录回来的地方
                     （设计侧第八轮 §一：「收起钮和展开钮是同一个图标，只是箭头方向相反」） */
                  <button data-ud="tree-reopen" className="w-9 shrink-0 grid place-items-center border-r border-border text-muted hover:bg-hover hover:text-text"
                    onClick={() => setLayout({ ...layout, tree: { ...layout.tree, open: true } })} title="展开目录列（⌘B）" aria-label="展开目录列">
                    <Glyph d={ICON.treeExpand} />
                  </button>
                ) : null} />

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
              {/* ⚠️ **详情窄下来时整段不显示**：它是读数，是这一行里最能让的一样。
                  不让的话它会把右端的 `⋯` 挤出可视区 —— 而 `⋯` 里装着体检、对比上一版这些动作，
                  那是点得到才有用的东西（M8-24 量出来：详情 440 时 ⋯ 落在 1075，可视区到 1060）。 */}
              {yieldNow.detail >= 620 && (
                <span className="flex items-center gap-1.5 text-[11px] text-muted font-mono min-w-0 truncate">
                  {mod.Status ? <mod.Status ctx={ctx} /> : kindDef(kind).label}
                </span>
              )}
              <FileMore ctx={ctx} items={mod.menu?.(ctx) ?? []} />
            </ToolbarBar>
          )}
          <div className="flex-1 min-h-0 flex">
            {!dirMode && !file ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-2 text-muted text-xs text-center px-6 leading-relaxed bg-canvas">
                <div className="text-2xl opacity-25">◧</div>
                <div><b className="text-text2">从左边的目录里选一个文件</b></div>
                <div className="text-[11px]">双击目录能在这里以它为根打开{layout.tree.open ? "" : "；⌘B 展开目录列"}</div>
              </div>
            ) : <mod.View ctx={ctx} />}
          </div>
        </div>
      </div>
      {layout.bottom && <BottomBar layout={layout} setLayout={setLayout} store={store} chat={chat} yieldNow={yieldNow} hasPanels={panels.length > 0} />}
      </div>
      {/* 右栏和会话栏一样待在主体层 —— 它原来在详情区里，底栏一开就把它也截短了 */}
      {layout.right && mod.Panels && panels.length > 0 && <mod.Panels ctx={ctx} />}
      </div>
      </Wrap>
      {sheet?.kind === "newDraft" && <NewDraftSheet core={core} current={file} dir={sheet.dir} onClose={() => setSheet(null)} onCreated={async (f) => { await store.fetchDrafts(); open(f); }} />}
    </div>
  );
}
