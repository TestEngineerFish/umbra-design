/** 布局状态（R2 / R3；键名照设计侧第四轮定的：chatSide / chatMode / chatWidth / panelByKind）。
 *  M7-7 才做完整布局引擎，这里只放三态 + 按类型记忆。 */
export type ChatSide = "left" | "right";
export type ChatMode = "expanded" | "bar";
/* 文件类型的认定在 `@shared/kinds`（前后端同一份）。这里只转发，不再写第二套 ——
   以前 `layout.ts` 和 `server/src/files.ts` 各有一个 `kindOf`，
   而且两边的扩展名表没有任何机制保证一致，今天碰巧一样纯属运气（M8-14）。 */
import type { FileKind } from "@shared/kinds";
export { kindOf } from "@shared/kinds";
export type { FileKind };
export type PanelId = "props" | "diagnostics" | "changes" | "comments" | "outline" | "info";
export interface LayoutState {
  chatSide: ChatSide; chatMode: ChatMode; chatWidth: number;
  /** 每种类型上次打开的从属面板；null = 收起（R3） */
  panelByKind: Partial<Record<FileKind, PanelId | null>>;
  theme: "system" | "light" | "dark";
  /** 常驻目录列（M8-11，设计侧第六轮 6.1）。键名按它给的 `layout.tree`。
   *  `expanded` 存的是相对路径，和 S12 宽区共用同一份 —— 两边展开的层级要一致。 */
  tree: { open: boolean; width: number; expanded: string[] };
}

/** 目录列的宽度边界（设计侧定的）：默认 240，拖拽范围 200–360，双击边缘回默认 */
export const TREE_W = { def: 240, min: 200, max: 360 } as const;
const KEY = "us.layout";
const DEFAULT: LayoutState = { chatSide: "left", chatMode: "expanded", chatWidth: 380, panelByKind: { dc: "props", md: "outline" }, theme: "system", tree: { open: true, width: TREE_W.def, expanded: [] } };
export function loadLayout(): LayoutState {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") ?? {};
    return {
      ...DEFAULT, ...v,
      panelByKind: { ...DEFAULT.panelByKind, ...(v.panelByKind ?? {}) },
      /* tree 要逐键兜底：老用户的 localStorage 里没有这一项，
         直接用 v.tree 会得到 undefined，界面上就崩在 layout.tree.open 上。
         宽度也钳一下 —— 存过界的值（换过边界、手改过）不能让列宽失控。 */
      tree: {
        open: v.tree?.open ?? DEFAULT.tree.open,
        width: Math.min(TREE_W.max, Math.max(TREE_W.min, Number(v.tree?.width) || TREE_W.def)),
        expanded: Array.isArray(v.tree?.expanded) ? v.tree.expanded.filter((x: unknown) => typeof x === "string") : [],
      },
    };
  } catch { return DEFAULT; }
}
export function saveLayout(s: LayoutState): void { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* 隐私模式 */ } }
/* R1「按类型决定有哪些从属面板」搬去 `kinds/registry.ts` 的 `panelsOf()` 了 ——
   那里每种格式自己声明，不再在这里写一串 if。 */
export const PANEL_TITLE: Record<PanelId, string> = { props: "属性", diagnostics: "诊断", changes: "变更", comments: "评论", outline: "大纲", info: "稿件信息" };
export function applyTheme(t: LayoutState["theme"]): void {
  const dark = t === "dark" || (t === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-tool-theme", dark ? "dark" : "light");
}
/** 本地小记忆（每项目上次看的稿、页签） */
export const mem = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v === null ? d : (JSON.parse(v) as T); } catch { return d; } },
  set(k: string, v: unknown): void { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};
