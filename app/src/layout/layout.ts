/** 布局状态（R1–R5，键名照设计侧第八轮定的）。
 *
 *  **M8-18 换过一次模型。** 以前是「会话栏摆在哪、要不要收成输入条」
 *  （`chatSide` / `chatMode`），现在是「**左 / 底 / 右三块在不在**」——
 *  用户原话：「不应该是控制聊天模块显示在什么位置上，而应该是控制左侧模块是否显示，
 *  底部模块是否显示，右侧模块是否显示」。
 *
 *  换边和「收成输入条」两态**有意删掉**，设计侧的理由：
 *  「左栏钮只有开 / 关两态，表达不了半开」。想临时问一句，⌘\ 一下就回来了。
 *
 *  ⚠️ **目录列不算三块之一** —— 它属于「中间」（导航 + 内容是一对）。
 *  顶栏那三颗钮的图标一一对应屏幕的三条边；把目录也算成「左」，左边就有两样东西，
 *  一颗钮说不清管的是哪一样。所以目录的开关只在它自己的列头上。 */
/* 文件类型的认定在 `@shared/kinds`（前后端同一份）。这里只转发，不再写第二套 ——
   以前 `layout.ts` 和 `server/src/files.ts` 各有一个 `kindOf`，
   而且两边的扩展名表没有任何机制保证一致，今天碰巧一样纯属运气（M8-14）。 */
import type { FileKind } from "@shared/kinds";
export { kindOf } from "@shared/kinds";
export type { FileKind };
/** 从属面板 id。**是 `string` 不是联合类型**（M11-9，和 `FileKind` 同一个理由）——
 *  插件可以带自己的面板（Markdown 插件的大纲就是），而插件是装完才存在的，
 *  编译期不可能知道它叫什么。
 *
 *  内置的那几个用 `PANEL` 常量引用，拼错了编译期照样报。 */
export type PanelId = string;

export const PANEL = {
  props: "props", diagnostics: "diagnostics", changes: "changes",
  comments: "comments", outline: "outline", info: "info",
} as const;
export interface LayoutState {
  /** 左栏 = **目录**（⌘B）。第八轮这里是会话，第九轮换了 —— 键名按「屏幕的哪条边」命名，
   *  所以键不用改名，改的是它管哪一块。 */
  left: boolean;
  /** 底栏 = 调试（⌘J） */
  bottom: boolean;
  /** 右栏 = **聊天**（⌘\）。第八轮这里是从属面板 */
  right: boolean;
  /** 属性区开着哪一页，`null` = 收起（第九轮：它进了详情内部，**不再归顶栏管**）。
   *  收起是**完全收掉**，不留 40px 图标轨 —— 默认收起还留一条轨，
   *  等于常驻一列没人看的图标。 */
  props: PanelId | null;
  chatWidth: number;
  bottomHeight: number;
  /** 每种类型上次打开的从属面板；null = 收起（R3） */
  panelByKind: Partial<Record<FileKind, PanelId | null>>;
  theme: "system" | "light" | "dark";
  /** 目录列的宽度和展开的层级。**`open` 去掉了** —— 它并进了 `left`（第九轮第 14 条：
   *  列头那颗收起钮多余，目录的显隐只归顶栏那一颗）。 */
  tree: { width: number; expanded: string[] };
}

/** 尺寸常量，**一份**（设计侧第八轮 S11 L681–682 的同一套值）。
 *  以前 `TREE_W` 在这里、`PANEL_WIDTH` 在 `SidePanels.tsx`、480 这个阈值写死在 `Workbench.tsx`，
 *  改一处就得记着另外两处。 */
export const TREE_W = { def: 240, min: 200, max: 360 } as const;
export const BOTTOM_H = { def: 200, min: 120, max: 420 } as const;
/** 详情区的下限 —— 低于它就开始让位（R5） */
export const DETAIL_MIN = 480;
/** 从属面板的面板体宽 + 图标轨宽 */
export const PANEL_W = 300, RAIL_W = 40;

const KEY = "us.layout";
const DEFAULT: LayoutState = {
  left: true, bottom: false, right: true,
  props: null,   // 属性区默认收起（第九轮）
  chatWidth: 380, bottomHeight: BOTTOM_H.def,
  panelByKind: { dc: "props", md: "outline" }, theme: "system",
  tree: { width: TREE_W.def, expanded: [] },
};
export function loadLayout(): LayoutState {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") ?? {};
    /* **老 schema 的迁移**（M8-18）：`chatSide` / `chatMode` 没了。
       `chatMode: "bar"`（会话收成输入条）在新模型里最接近的是「左栏关着」——
       两种情况下会话都不占一整列。换边没有对应项，直接丢掉：会话固定在左了。
       不迁移的话，老用户打开是 `left: undefined`，左栏直接不见。 */
    /* 老 schema 迁移。**两代都要认**：
       - 第七轮及更早：`chatMode` / `chatSide`
       - 第八轮：`left` = 会话、`right` = 从属面板、`tree.open` = 目录
       第九轮把三块换了一遍（左 = 目录、右 = 聊天），所以第八轮存下来的值
       直接用会**张冠李戴**：本来关着会话，打开变成关着目录。 */
    const v8 = v.tree && typeof v.tree.open === "boolean";   // 第八轮的形状
    const migrated = v.chatMode !== undefined || v.chatSide !== undefined
      ? { left: true, bottom: false, right: v.chatMode !== "bar", props: null }
      : v8
        ? { left: v.tree.open !== false, right: v.left !== false, props: null }
        : {};
    return {
      ...DEFAULT, ...v, ...migrated,
      chatWidth: Number(v.chatWidth) || DEFAULT.chatWidth,
      bottomHeight: Math.min(BOTTOM_H.max, Math.max(BOTTOM_H.min, Number(v.bottomHeight) || BOTTOM_H.def)),
      panelByKind: { ...DEFAULT.panelByKind, ...(v.panelByKind ?? {}) },
      /* tree 要逐键兜底：老用户的 localStorage 里没有这一项，
         直接用 v.tree 会得到 undefined，界面上就崩在 layout.tree.open 上。
         宽度也钳一下 —— 存过界的值（换过边界、手改过）不能让列宽失控。 */
      tree: {
        width: Math.min(TREE_W.max, Math.max(TREE_W.min, Number(v.tree?.width) || TREE_W.def)),
        expanded: Array.isArray(v.tree?.expanded) ? v.tree.expanded.filter((x: unknown) => typeof x === "string") : [],
      },
    };
  } catch { return DEFAULT; }
}
/** 让位计算（R2–R5）。**照 S11 L1051 那段算法搬的，不是自己发明的。**
 *
 *  会话固定在左之后只剩两步：**面板体改抽屉 → 目录列让位成浮层**。
 *  （原来还有一步「会话收成输入条」，那一态在第八轮删了。）
 *
 *  ⚠️ **主动算，不量 DOM**。以前是用 `ResizeObserver` 量详情区的实际宽度，
 *  那样有两个毛病：① 量到的是「让位之后」的结果，要靠它反过来决定让不让位，是个环；
 *  ② 节点卸载的瞬间会报宽度 0，误判成最窄档（`00` §71.6 真栽过，全屏遮罩把界面锁死）。
 *  按各列的宽度直接算就没有这两件事。
 */
export interface Yield {
  /** 面板体改抽屉（图标轨留在原位） */
  panelDrawer: boolean;
  /** 目录列还并排着（false = 让位成浮层） */
  treeInline: boolean;
  /** 用户是开着目录的，但被挤成了浮层 —— 和「用户自己收起来的」要分开显示 */
  yielded: boolean;
  /** 详情区算出来有多宽，给底栏的布局读数用 */
  detail: number;
}
export function computeYield(l: LayoutState, winW: number, hasPanels: boolean): Yield {
  /* 第九轮换了三块的含义：`left` = 目录、`right` = 聊天、属性区在详情内部（`props`）。
     让位顺序也换了，按「多久用一次」排，最不常用的先让：
     属性区（看完一眼就关）→ 目录（挑完文件就不看）→ 聊天收窄 → 聊天让位。 */
  const propsOn = l.props !== null && hasPanels;
  const chatW = l.right ? l.chatWidth : 0;
  const tw = l.tree.width;
  /** 属性区**完全收掉**，不留图标轨（第九轮）—— 所以收起时它占 0，不是 40 */
  const propsW = (inline: boolean) => (propsOn && inline ? PANEL_W : 0);
  let panelDrawer = false;
  let treeInline = l.left;
  let detail = winW - chatW - (treeInline ? tw : 0) - propsW(true);
  // R2：属性区先改抽屉（浮在正文右边）
  if (detail < DETAIL_MIN && propsOn) { panelDrawer = true; detail = winW - chatW - (treeInline ? tw : 0); }
  // R3：还不够，目录让位成浮层
  if (treeInline && detail < DETAIL_MIN) { treeInline = false; detail = winW - chatW; }
  return { panelDrawer, treeInline, yielded: l.left && !treeInline, detail: Math.round(detail) };
}

export function saveLayout(s: LayoutState): void { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* 隐私模式 */ } }
/* R1「按类型决定有哪些从属面板」搬去 `kinds/registry.ts` 的 `panelsOf()` 了 ——
   那里每种格式自己声明，不再在这里写一串 if。 */
const TITLES: Record<string, string> = { props: "属性", diagnostics: "诊断", changes: "变更", comments: "评论", outline: "大纲", info: "稿件信息" };

/** 插件带来的面板也要有标题。**注册进来而不是各处硬写** ——
 *  硬写的话插件的面板在图标轨上会显示成 id（`com.umbra.md.outline`）。 */
export function registerPanelTitle(id: PanelId, title: string): void { TITLES[id] = title; }
export function unregisterPanelTitles(prefix: string): void {
  for (const k of Object.keys(TITLES)) if (k.startsWith(prefix + ".")) delete TITLES[k];
}
/** ⚠️ **是函数不是常量**（M11-9）：常量在模块加载时就定死了，插件后注册的看不到。 */
export const panelTitle = (id: PanelId): string => TITLES[id] ?? id;
export const PANEL_TITLE = new Proxy({} as Record<string, string>, { get: (_t, k) => panelTitle(String(k)) });
export function applyTheme(t: LayoutState["theme"]): void {
  const dark = t === "dark" || (t === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-tool-theme", dark ? "dark" : "light");
}
/** 本地小记忆（每项目上次看的稿、页签） */
export const mem = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v === null ? d : (JSON.parse(v) as T); } catch { return d; } },
  set(k: string, v: unknown): void { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};
