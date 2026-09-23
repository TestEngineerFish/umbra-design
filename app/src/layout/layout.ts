/** 布局引擎的最小骨架（M7-7 才做完整 R1–R5）。这里只放：会话栏三态 + 按类型记忆收放（R2 / R3）。 */
export type ChatRail = "left" | "right" | "bar";
export type FileKind = "dc" | "md" | "image" | "dir" | "other";
export interface LayoutState { chat: ChatRail; side: Record<FileKind, boolean> }
const KEY = "us.layout";
const DEFAULT: LayoutState = { chat: "left", side: { dc: true, md: true, image: false, dir: false, other: false } };
export function loadLayout(): LayoutState { try { return { ...DEFAULT, ...(JSON.parse(localStorage.getItem(KEY) ?? "null") ?? {}) }; } catch { return DEFAULT; } }
export function saveLayout(s: LayoutState): void { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* 隐私模式 */ } }
export function kindOf(file: string): FileKind {
  if (/\.dc\.html$/i.test(file)) return "dc";
  if (/\.md$/i.test(file)) return "md";
  if (/\.(png|jpe?g|webp|gif|svg)$/i.test(file)) return "image";
  return "other";
}
