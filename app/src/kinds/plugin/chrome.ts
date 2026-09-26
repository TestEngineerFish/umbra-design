import { useSyncExternalStore } from "react";

/** 插件的 chrome（M11-9）：编辑栏 / 状态 / `⋯` 菜单**由宿主代画**。
 *
 *  **为什么不让插件自己画。** 插件只有正文那一块矩形 ——
 *  编辑栏在矩形上面、属性面板在右边、`⋯` 在页签条上，全在它够不着的地方。
 *  就算够得着也不该让它画：那样每个插件的按钮高度、圆角、hover 底色都会不一样，
 *  并排一眼就看出不是一套（这正是 M8-15 把四个视图的工具栏统一起来要解决的问题）。
 *
 *  所以走 `umbra.menu` 已经走通的那条路：**插件给数据，宿主照自己的形制画**。
 *  代价是插件只能用我们给的这几种零件；收获是它天然长得和主程序一样，
 *  而且主程序换形制时插件不用跟着改。
 */
export interface PluginSeg {
  label: string;
  items: Array<{ label: string; active?: boolean; title?: string; disabled?: boolean; toggle?: boolean }>;
}
export interface PluginChrome {
  /** 编辑栏里的段组。空 = 这种格式没有 ✎ 那颗钮 */
  toolbar: PluginSeg[];
  /** 编辑栏右端那几颗散钮 */
  buttons: Array<{ label: string; title?: string; primary?: boolean; disabled?: boolean }>;
  /** 状态行中间那一段 */
  status: string;
  /** `⋯` 里属于这种格式的项。公共尾巴由工作台补 */
  menu: Array<{ label: string; hint?: string; danger?: boolean; disabled?: boolean }>;
}

const EMPTY: PluginChrome = { toolbar: [], buttons: [], status: "", menu: [] };

/* 按「插件 id + 文件路径」存 —— **不能只按插件 id**：
   同一个插件开着两份文件时，编辑栏该各是各的（一份在源码档、一份在渲染档）。 */
const state = new Map<string, PluginChrome>();
const listeners = new Set<() => void>();
let version = 0;
const bump = () => { version++; for (const l of listeners) l(); };

/** 插件那边点了 chrome 上的东西，回调回去。`Surface` 挂载时登记。 */
const senders = new Map<string, (kind: "seg" | "button" | "menu", a: number, b?: number) => void>();

export const chromeKey = (plugin: string, path: string | null) => `${plugin}\u0000${path ?? ""}`;

export function setChrome(key: string, c: Partial<PluginChrome>): void {
  state.set(key, { ...(state.get(key) ?? EMPTY), ...c });
  bump();
}
export function dropChrome(key: string): void { if (state.delete(key)) bump(); senders.delete(key); }
export function setSender(key: string, fn: (kind: "seg" | "button" | "menu", a: number, b?: number) => void): void { senders.set(key, fn); }
export const fire = (key: string, kind: "seg" | "button" | "menu", a: number, b?: number) => senders.get(key)?.(kind, a, b);

/** 不订阅、只取当下（给非组件的 `menu` 工厂用） */
export const chromeOf = (key: string): PluginChrome => state.get(key) ?? EMPTY;

export function useChrome(key: string): PluginChrome {
  useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => version, () => version,
  );
  return state.get(key) ?? EMPTY;
}
