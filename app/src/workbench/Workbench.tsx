import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Core, type ProjectHandle } from "../api/client";
import { draftTitle, type Picked, type Selection } from "../api/types";
import { ChatRail } from "../chat/ChatRail";
import { useChat } from "../chat/useChat";
import type { HostAdapter } from "../host";
import { PANEL_W, TREE_W, computeYield, kindOf, mem, type LayoutState, type PanelId } from "../layout/layout";
import { Frame } from "../layout/Frame";
import { engineLabel } from "../chat/channel";
import { useProject } from "../store/project";
import { NewDraftSheet } from "../sheets/Sheets";
import { toast } from "../ui/Toast";
import { installHotkeys } from "../ui/hotkeys";
import { Glyph, ICON } from "../ui/Glyph";
import { PopItem, PopSep, Popover, usePopover } from "../ui/Popover";
import { BottomBar } from "./BottomBar";
import { debugBus, wireDebug } from "../ui/debug";
import { dirtyStore } from "../ui/dirty";
import { FileTree } from "./FileTree";
/* 详情区怎么画、右边配什么面板、状态行写什么，**全在 kinds 注册表里**。
   这个文件从此不认识任何一种具体格式 —— 加 `.json` 时它一个字都没动（M8-14）。 */
import { moduleFor, type ViewContext } from "../kinds";
import { FileMore, ToolbarBar } from "../kinds/toolbar";
import { makeActions } from "./ctxmenu";
import { TabBar } from "./TabBar";
import { normalize, openTab, type Tab } from "./tabs";

/** 工作台（S11 形制）：顶栏 40 · 页签 34 · 左会话 / 中画布 / 右从属面板列 · 底部状态行 24 */
export function Workbench({ project, host, layout, setLayout, onHome, onSettings }: { project: ProjectHandle; host: HostAdapter; layout: LayoutState; setLayout: (l: LayoutState) => void; onHome: () => void; onSettings: () => void }) {
  const core = useMemo(() => new Core(project.url, project.token, project.ws), [project]);
  const store = useProject(core, project.dir);
  /** 页签三态（M8-28）。存量是 `string[]`，`normalize` 认它 */
  const [tabs, setTabsRaw] = useState<Tab[]>(() => normalize(mem.get(`us.tabs.${project.dir}`, [])));
  const setTabs = useCallback((next: Tab[]) => { setTabsRaw(next); mem.set(`us.tabs.${project.dir}`, next); }, [project.dir]);
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
  const projPop = usePopover();
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
  /** 编辑栏开着的那几份文件。**记在页签上不是全局**（设计侧 §三.1）——
   *  一份在改、另一份在看，切页签时各自保持。 */
  /* **改了内容就转正**（设计侧 §六.1）：人都开始改了，它不该再被下一次单击盖掉。
     `dirtyStore` 是每种格式各自登记的，这里订阅它。 */
  const dirtySnap = useSyncExternalStore(dirtyStore.subscribe, dirtyStore.snapshot);
  useEffect(() => {
    const dirty = dirtySnap ? dirtySnap.split("|") : [];
    if (!dirty.length) return;
    setTabsRaw((ts) => {
      if (!ts.some((t) => t.preview && dirty.includes(t.path))) return ts;
      const n = ts.map((t) => (t.preview && dirty.includes(t.path) ? { ...t, preview: false } : t));
      mem.set(`us.tabs.${project.dir}`, n);
      return n;
    });
  }, [dirtySnap, project.dir]);

  const [editBy, setEditBy] = useState<Record<string, boolean>>({});
  const editKey = dirMode ? "__dir__" : (file ?? "");
  const editOpen = !!editBy[editKey];
  const setEditOpen = useCallback((f: (o: boolean) => boolean) => {
    const next = f(editOpen);
    setEditBy((m) => ({ ...m, [editKey]: next }));
    /* 告诉格式模块「进 / 出编辑态了」—— Markdown 靠它在源码和渲染之间切 */
    window.dispatchEvent(new CustomEvent("ud-edit-toggled", { detail: next }));
    /* **展开编辑栏 = 这份文件转正**（设计侧 §六.1 列的进入「打开态」的方式之一）——
       人都开始改了，它就不该再被下一次单击盖掉 */
    if (next && editKey && editKey !== "__dir__") {
      setTabsRaw((ts) => { const n = ts.map((t) => (t.path === editKey ? { ...t, preview: false } : t)); mem.set(`us.tabs.${project.dir}`, n); return n; });
    }
    /* ⚠️ 这三件**都不能写在 `setEditBy` 的 updater 里**：updater 必须是纯函数。
       M8-28 真栽过 —— 在 updater 里调 `setTabsRaw` 和 `dispatchEvent`，
       结果整个 `setEditBy` 不生效，⌘E 按了没反应，而分支明明进去了。 */
  }, [editOpen, editKey, project.dir]);

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
      /* **单击 = 预览态、双击 = 打开态**（用户第 8 条）。
         浮层态下选完就收 —— 它盖在详情上，不收的话挡着刚打开的文件。 */
      onOpenFile={(f, dbl) => { open(f, false, dbl ? "open" : "preview"); if (!treeInline) setLayout({ ...layout, left: false }); }}
      onOpenDir={(d) => { open(d, true); if (!treeInline) setLayout({ ...layout, left: false }); }}
      healthOf={(path) => store.drafts.find((d) => d.file === path)?.health ?? null}
      drafts={store.drafts} indexed={store.indexed} reindexing={store.checking === "__index__"}
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
      /* 第九轮的键：**⌘\ 归聊天**（管的还是会话，只是换了边），⌘B 归目录 */
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") { e.preventDefault(); setLayout({ ...layout, right: !layout.right }); }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "j") { e.preventDefault(); setLayout({ ...layout, bottom: !layout.bottom }); }
      /* ⌘⌥B 第八轮是右栏（从属面板），第九轮属性区进了详情内部，这个键跟着它走 */
      if ((e.metaKey || e.ctrlKey) && e.altKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        if (panels.length) setLayout({ ...layout, props: layout.props ? null : (layout.panelByKind[kind] ?? panels[0]!) });
      }
      /* ⌘E 展开 / 收起编辑栏（第九轮新给的键）。它归格式模块自己管，这里只发事件 */
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "e") { e.preventDefault(); if (mod.Toolbar) setEditOpen((o) => !o); }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "b") { e.preventDefault(); setLayout({ ...layout, left: !layout.left }); }
      /* ⌘P 转到文件：入口在目录列头，收起时先展开它，不然浮层挂在一个不存在的列上 */
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p") {
        e.preventDefault();
        if (!layout.left) setLayout({ ...layout, left: true });
        setTimeout(() => window.dispatchEvent(new CustomEvent("ud-goto-file")), layout.left ? 0 : 60);
      }
      /* ⌘L 聚焦会话输入框。**原来是 ⌘J，让给底栏了**（`00` §75.4）——
         Cursor 和 VS Code 的 Copilot Chat 都用 ⌘L 聚焦聊天输入，用户正在用 Cursor。
         左栏关着时先打开再聚焦：他按这个键的意图很清楚，别让他按了没反应。 */
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "l") {
        e.preventDefault();
        if (!layout.right) setLayout({ ...layout, right: true });
        setTimeout(() => document.getElementById("chatInput")?.focus(), layout.right ? 0 : 60);
      }
    };
    /* ⚠️ **不是 `document.addEventListener`**（M8-29）：键盘事件不跨 iframe 边界，
       焦点落进稿里之后顶层 document 收不到 —— 用户报的「⌘E 时灵时不灵、打开 html
       刚开始不行后面又可以」就是这件事。`installHotkeys` 把同一个处理挂到顶层
       **和每一个同源 iframe 的 document** 上，iframe 后加载 / 换稿时自动补挂。 */
    return installHotkeys(on);
    /* ⚠️ **依赖一个都不能漏**。M8-28 栽过：漏了 `setEditOpen`（它随当前文件变），
       闭包捕获的是上一个文件的 `editKey`，于是 ⌘E 把编辑栏开在了**别的文件**上，
       症状是「按了没反应」—— 和用户第 11 条抱怨的一模一样。
       这种错最难查：分支进去了、state 也写了，只是写错了地方。 */
  }, [layout, setLayout, panels.length, onSettings, kind, mod.Toolbar, setEditOpen]);

  /** 打开任意文件或目录。目录不进页签（它是一个位置，不是一份文件）。 */
  const open = (f: string, isDir = false, mode: "preview" | "open" = "preview") => {
    commitTrash();   // 「做下一件事」的第一条：打开别的文件或目录
    setPicked(null);
    setDirMode(isDir);
    store.select(isDir ? (f || "__root__") : f);
    if (isDir) return;
    mem.set(`us.lastDraft.${project.dir}`, f);
    /* 单击 = 预览态（会盖掉上一个预览页签），双击 / 明确打开 = 打开态。
       这是用户第 8 条要的「不要每看一个就多一个」。 */
    setTabsRaw((t) => { const n = openTab(t, f, mode); mem.set(`us.tabs.${project.dir}`, n); return n; });
  };
  const dirRel = dirMode ? (file === "__root__" ? "" : (file ?? "")) : "";
  const closeTab = useCallback((f: string) => {
    dirtyStore.drop(f);
    /* 关页签时把编辑栏的记忆也清掉 —— 重新打开时回到收起。
       设计侧问过这一条，它的建议就是「回到收起」：重开一份文件多半是去看的，
       不是接着改的；真要改，⌘E 一下就回来。 */
    setEditBy((m) => { const n = { ...m }; delete n[f]; return n; });
    const n = tabs.filter((x) => x.path !== f);
    setTabs(n);
    if (file === f) { const next = n[n.length - 1]?.path ?? null; if (next) open(next, false, "open"); else store.select(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, file, setTabs]);
  /** 关一批（右键菜单的「关闭其他 / 右侧 / 已保存的」用） */
  const closeMany = useCallback((list: Tab[]) => {
    for (const t of list) dirtyStore.drop(t.path);
    const gone = new Set(list.map((t) => t.path));
    const n = tabs.filter((t) => !gone.has(t.path));
    setTabs(n);
    if (file && gone.has(file)) { const next = n[n.length - 1]?.path ?? null; if (next) open(next, false, "open"); else store.select(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, file, setTabs]);

  /* 底栏那颗钮的红点：有没有 error。关着的时候才提示，打开看过就消。 */
  wireDebug();
  const hasDebugError = useSyncExternalStore(debugBus.subscribe, () => debugBus.hasError());


  /** 让位算一次，下面三处都用它：目录列并排还是浮层、面板体展开还是抽屉、底栏的布局读数 */
  const yieldNow = computeYield(layout, winW, panels.length > 0);
  const { panelDrawer, treeInline } = yieldNow;
  const expandChat = useCallback(() => { if (!layout.right) setLayout({ ...layout, right: true }); }, [layout, setLayout]);
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
  const rail = <ChatRail chat={chat} selections={selections} onDropSelection={(i) => setSelections((xs) => xs.filter((_, j) => j !== i))} onClearSelections={() => setSelections([])} contextLabel={dirMode ? (dirRel || "这个目录") : (file ? draftTitle(file) : null)} />;
  /* ═══ 顶栏 38px · 只放两类：「应用 / 项目」和「窗口布局」（设计侧第七轮）═══
     判据是「点了它，变的是什么」：变的是整个项目或整扇窗的才配站在这儿。
     项目路径从顶栏拿掉了 —— 它占 280px，却只是信息，没人点它，现在进项目菜单。 */
  const topBar = (
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
          <button ref={projPop.anchorRef as React.RefObject<HTMLButtonElement>}
            className={`min-w-0 max-w-[420px] flex items-center gap-1.5 h-[26px] pl-2 pr-1.5 rounded hover:bg-hover ${projPop.open ? "bg-hover" : ""}`}
            onClick={projPop.toggle} aria-expanded={projPop.open} aria-haspopup="menu" title={project.dir}>
            <span className="font-semibold truncate">{project.title || project.name}</span>
            <Glyph d={ICON.caretDown} size={11} stroke={1.6} className="text-muted" />
          </button>
          <Popover pop={projPop} align="start">
            <div>
              {/* 路径**整块可点，点了就复制**（第八轮 §三）——
                  所以菜单里不再单独放一项「复制路径」。
                  项目名不写第二遍：按钮上就是它，菜单是它的展开（M8-16 用户提的 double name）。 */}
              <button className="w-full text-left px-2 pt-1.5 pb-2 mb-1 border-b border-border hover:bg-hover"
                onClick={() => { projPop.close(); void navigator.clipboard?.writeText(project.dir).then(() => toast("路径已复制", project.dir, "ok"), () => toast("复制不了", "浏览器不让访问剪贴板", "error")); }}>
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
                ? <PopSep key={k} />
                : <PopItem key={k} label={mi.label!} hint={mi.hint} onPick={() => { projPop.close(); mi.run!(); }} />)}
            </div>
          </Popover>
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
            /* 第九轮：三颗管的是**目录 / 调试 / 聊天**。图标画的就是框里的那一条边。
               属性区不在这里 —— 它进了详情内部，开关在 Tab 条右端。 */
            ["left", "region-tree" as const, layout.left, `${layout.left ? "隐藏" : "显示"}目录（⌘B）`, false],
            ["bottom", "region-bottom" as const, layout.bottom, `${layout.bottom ? "隐藏" : "显示"}调试栏（⌘J）`, false],
            ["right", "region-chat" as const, layout.right, `${layout.right ? "隐藏" : "显示"}聊天（⌘\\）`, false],
          ] as const).map(([k, d, on, title, disabled]) => (
            <button key={k} data-ud={`region-${k}`} disabled={disabled} aria-pressed={on}
              title={title + (k === "bottom" && hasDebugError && !layout.bottom ? " · 有新的错误" : "")}
              onClick={() => setLayout({ ...layout, [k]: !layout[k] })}
              className={`relative w-[30px] h-6 grid place-items-center rounded-sm transition-colors disabled:opacity-40 disabled:cursor-default ${
                on ? "bg-panel text-text shadow-sm" : "text-muted hover:text-text"}`}>
              <Glyph icon={d} />
              {/* 底栏关着却出了 error：挂一个红点。打开看过就消（设计侧演示态 8） */}
              {k === "bottom" && hasDebugError && !layout.bottom && <span className="absolute top-0.5 right-1 w-1.5 h-1.5 rounded-full bg-err" />}
            </button>
          ))}
        </div>
      </header>
  );

  return (
    <div ref={rootRef} className="h-full flex flex-col">
      {/* Provider 要同时包住详情区和状态行（目录的「已选 3 项」在状态行读模块内部的勾选） */}
      {/* Provider 包住详情、工具栏、状态读数三处 —— 它们都要读格式模块内部的状态 */}
      {/* ═══ 三列的顺序、宽度、让位**全在这个数组里**（M8-26）═══
          用户说「产品总是要迭代的，所以要模块化处理，方便调整」——
          两轮之内布局已经改过三次形态，每次都要翻找嵌套的 div。
          现在换位置 = 调下面这个数组的顺序，别的不动。

          ⚠️ 第九轮用户要的是「目录 | 详情 | 聊天」（聊天换到右边），
          等设计侧的形制回来一起改：到时候只要把 `chat` 挪到数组末尾、
          `resize.edge` 从 `right` 换成 `left`。 */}
      <Wrap ctx={ctx} key={kind}>
        <Frame
          top={topBar}
          regions={[
            {
              id: "nav", show: layout.left,
              width: treeInline ? layout.tree.width : 280,
              float: layout.left && !treeInline,
              onFloatClose: () => setLayout({ ...layout, left: false }),
              resize: treeInline ? { ...TREE_W, edge: "right", onResize: (w) => setLayout({ ...layout, tree: { ...layout.tree, width: w } }) } : undefined,
              node: tree,
            },
            {
              id: "detail", show: true,
              node: (
                <div className="flex-1 min-w-0 flex flex-col">
            <TabBar tabs={tabs} current={dirMode ? null : file} busy={store.checking === file}
              onPick={(p) => open(p)} onOpen={(p) => open(p, false, "open")}
              onClose={closeTab} onCloseMany={closeMany}
              onPin={(p, pinned) => setTabs(tabs.map((t) => (t.path === p ? { ...t, pinned, preview: pinned ? false : t.preview } : t)))}
              onKeep={(p) => setTabs(tabs.map((t) => (t.path === p ? { ...t, preview: false } : t)))}
              onLocate={(p) => { if (!layout.left) setLayout({ ...layout, left: true }); setTimeout(() => window.dispatchEvent(new CustomEvent("ud-locate-file", { detail: p })), layout.left ? 0 : 80); }}
              onToChat={(p) => { putSelection("files", { kind: "files", label: p.split("/").pop() ?? p, detail: p }); expandChat(); }}
              onCopyPath={(p) => void navigator.clipboard?.writeText(`${project.dir}/${p}`).then(() => toast("路径已复制", undefined, "ok"), () => toast("复制不了", "浏览器不让访问剪贴板", "error"))}
              onReveal={(p) => void host.revealInFinder(`${project.dir}/${p}`).catch((e: Error) => toast("打不开", e.message, "error"))}
              tail={(dirMode || file) ? (
                <>
                  {/* ═══ Tab 条右端三颗（第九轮 §三）═══ 位置固定，不跟着格式变。
                      ✎ **按下 = 编辑态，抬起 = 预览态** —— 它顺手吃掉了原来「编辑 / 预览」两档，
                      所以看稿时切来切去的那一下并没有多点一次。 */}
                  {mod.Toolbar && (
                    <button data-ud="toggle-edit" onClick={() => setEditOpen((o) => !o)} aria-pressed={editOpen}
                      title={`${editOpen ? "收起" : "展开"}编辑栏（⌘E）`}
                      className={`w-7 h-7 grid place-items-center rounded ${editOpen ? "bg-accentSoft text-accent" : "text-muted hover:text-text hover:bg-hover"}`}>
                      <Glyph icon="edit" />
                    </button>
                  )}
                  {panels.length > 0 && (
                    <button data-ud="toggle-props" onClick={() => setLayout({ ...layout, props: layout.props ? null : (layout.panelByKind[kind] ?? panels[0]!) })}
                      aria-pressed={layout.props !== null} title={`${layout.props ? "收起" : "展开"}属性区（⌘⌥B）`}
                      className={`relative w-7 h-7 grid place-items-center rounded ${layout.props ? "bg-accentSoft text-accent" : "text-muted hover:text-text hover:bg-hover"}`}>
                      <Glyph icon="region-props" />
                      {/* 诊断有提醒而属性区收着时挂一个 warn 点，打开就消（设计侧 §三.2） */}
                      {!layout.props && store.diags.some((d) => d.level === "error" || d.level === "warning") &&
                        <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-warn" />}
                    </button>
                  )}
                  <FileMore ctx={ctx} items={mod.menu?.(ctx) ?? []} />
                </>
              ) : null} />
            {/* ═══ 编辑栏 36px · **默认收起**（第九轮 §三）═══
                里面只有**改稿用**的开关。看稿用的（浅深、宽度缩放、演示）
                常驻在正文右下角的浮块里，不跟着收起 —— 那些是一直在用的。
                ⚠️ 第七轮这里叫「文件工具栏」且常驻，用户看了实物说
                「非必要的内容可以先收起」，以第九轮为准。 */}
            {mod.Toolbar && (dirMode || file) && (
              /* 展开是**往下推正文**，不浮在正文上 —— 浮上去就盖住稿的顶部，
                 而稿的顶部常常就是要改的导航（设计侧 §三.1）。
                 高度 0 ↔ 36，中档 180ms；里层贴底，看起来是从 Tab 条下面推出来的。 */
              <div className="shrink-0 anim-block" style={{ height: editOpen ? 36 : 0, opacity: editOpen ? 1 : 0 }}
                {...(!editOpen ? { inert: "" as unknown as boolean } : {})}>
                <ToolbarBar>
                  <mod.Toolbar ctx={ctx} />
                </ToolbarBar>
              </div>
            )}
            <div className="flex-1 min-h-0 flex relative">
              {!dirMode && !file ? (
                <div className="flex-1 flex flex-col items-center justify-center gap-2 text-muted text-xs text-center px-6 leading-relaxed bg-canvas">
                  <Glyph icon="file" size={28} className="opacity-25" />
                  <div><b className="text-text2">从左边的目录里选一个文件</b></div>
                  <div className="text-[11px]">双击目录能在这里以它为根打开{layout.left ? "" : "；⌘B 展开目录"}</div>
                </div>
              ) : <mod.View ctx={ctx} />}
              {/* ═══ 正文右下角的浮块（第九轮 §三.3）═══ 只放**看稿用**的，不占一行。 */}
              {mod.Corner && (dirMode || file) && (
                <div data-ud="corner" className="absolute right-3 bottom-3 z-10 flex items-center gap-1 px-1.5 h-8 rounded-lg bg-panel/95 border border-border shadow-lg">
                  <mod.Corner ctx={ctx} />
                </div>
              )}
              {/* ═══ 属性区（第九轮：进了详情内部）═══
                  **完全收掉，不留 40px 图标轨** —— 默认收起还留一条轨，
                  等于常驻一列没人看的图标。窄了就改抽屉浮在正文右边（R2）。 */}
              {panels.length > 0 && mod.Panels && (
                panelDrawer
                  ? (layout.props !== null && <div data-ud="props" className="absolute right-0 top-0 bottom-0 z-30 flex shadow-2xl border-l border-border bg-panel" style={{ width: PANEL_W }}><mod.Panels ctx={ctx} /></div>)
                  : (
                    /* 展开 0 ↔ 300，慢档 240ms，从正文右边推出来 */
                    <div data-ud={layout.props !== null ? "props" : undefined} className="shrink-0 anim-col border-l border-border"
                      style={{ width: layout.props !== null ? PANEL_W : 0, opacity: layout.props !== null ? 1 : 0, borderLeftWidth: layout.props !== null ? 1 : 0 }}
                      {...(layout.props === null ? { inert: "" as unknown as boolean } : {})}>
                      <div className="flex h-full" style={{ width: PANEL_W }}><mod.Panels ctx={ctx} /></div>
                    </div>
                  )
              )}
            </div>
                </div>
              ),
            },
            {
              /* **聊天固定在右**（第九轮）。手柄在它的左边沿 —— 320–520，双击回 380。
                 M8-26 抽了 Frame 之后，这次换边改的就是这几行。 */
              id: "chat", show: layout.right, width: layout.chatWidth,
              resize: { min: 320, max: 520, def: 380, edge: "left", onResize: (w) => setLayout({ ...layout, chatWidth: w }) },
              node: rail,
            },
          ]}
          bottom={layout.bottom ? {
            node: <BottomBar layout={layout} setLayout={setLayout} store={store} chat={chat} yieldNow={yieldNow} hasPanels={panels.length > 0} />,
            height: layout.bottomHeight,
            /* **通栏**（第九轮改的）：用户第 5 条「窗口最底部为调试和输出模块，
               用于**所有模块和功能**的输出」，设计稿的图也是横跨三列。
               第八轮那版只横跨中间，理由是会话的输入框要贴着窗口底部 ——
               第九轮聊天换到右边、调试栏定位成"所有模块的输出"，那条理由不成立了。 */
            spans: ["nav", "detail", "chat"],
          } : undefined}
        />
      </Wrap>
      {sheet?.kind === "newDraft" && <NewDraftSheet core={core} current={file} dir={sheet.dir} onClose={() => setSheet(null)} onCreated={async (f) => { await store.fetchDrafts(); open(f); }} />}
    </div>
  );
}
