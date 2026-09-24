/** 布局状态（R2 / R3；键名照设计侧第四轮定的：chatSide / chatMode / chatWidth / panelByKind）。
 *  M7-7 才做完整布局引擎，这里只放三态 + 按类型记忆。 */
export type ChatSide = "left" | "right";
export type ChatMode = "expanded" | "bar";
export type FileKind = "dc" | "md" | "image" | "dir" | "code" | "html" | "other";
export type PanelId = "props" | "diagnostics" | "changes" | "comments" | "outline" | "info";
export interface LayoutState {
  chatSide: ChatSide; chatMode: ChatMode; chatWidth: number;
  /** 每种类型上次打开的从属面板；null = 收起（R3） */
  panelByKind: Partial<Record<FileKind, PanelId | null>>;
  theme: "system" | "light" | "dark";
}
const KEY = "us.layout";
const DEFAULT: LayoutState = { chatSide: "left", chatMode: "expanded", chatWidth: 380, panelByKind: { dc: "props", md: "outline" }, theme: "system" };
export function loadLayout(): LayoutState { try { const v = JSON.parse(localStorage.getItem(KEY) ?? "null") ?? {}; return { ...DEFAULT, ...v, panelByKind: { ...DEFAULT.panelByKind, ...(v.panelByKind ?? {}) } }; } catch { return DEFAULT; } }
export function saveLayout(s: LayoutState): void { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* 隐私模式 */ } }
export function kindOf(file: string | null): FileKind {
  if (!file) return "dir";
  if (/\.dc\.html$/i.test(file)) return "dc";
  if (/\.md$/i.test(file)) return "md";
  if (/\.(png|jpe?g|webp|gif|svg)$/i.test(file)) return "image";
  if (/\.html?$/i.test(file)) return "html";
  if (/\.(ts|tsx|js|mjs|css|json|py|rs|go|sh)$/i.test(file)) return "code";
  return "other";
}
/** R1：按类型决定有哪些从属面板 */
export function panelsFor(kind: FileKind): PanelId[] {
  if (kind === "dc") return ["props", "diagnostics", "changes", "comments", "info"];
  if (kind === "md") return ["outline"];
  return [];
}
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
