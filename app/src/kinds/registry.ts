import { useSyncExternalStore } from "react";
import type { FC, ReactNode } from "react";
import { kindDef, kindOf, type FileKind } from "@shared/kinds";
import type { PanelId } from "../layout/layout";
import type { MenuItem, ViewContext } from "./context";

export type { FileKind };
export { kindDef, kindOf };

/** 一种文件格式的**全部知识**都在一个模块里（M8-14）。
 *
 *  「全部」包含五样：怎么看（View）、有哪些开关（Toolbar）、右边配什么面板（Panels）、
 *  `⋯` 里有什么（menu）、状态行写什么（status）。
 *  这五样以前散在 `Workbench.tsx`、`layout.ts`、`DirView.tsx` 三个文件的六处分叉里。
 *
 *  设计侧第七轮给的判据正好是同一个分界：**「点了它，变的是什么」** ——
 *  变的是项目 / 窗口布局 / 导航 / 会话的，归工作台；**变的是这份文件的，归这里**。
 *  所以顶栏和页签条永远不进模块，文件工具栏永远不进工作台。
 */
export interface KindModule {
  /** 认领哪些 kind。一个模块可以管几种（文件卡就管 code / html / other） */
  ids: readonly FileKind[];
  /** 哪个插件带来的。内置的不写。卸载插件时按它把模块摘掉（M11-3） */
  from?: string;
  /** 右侧从属面板（R1）。不写 = 这种格式没有右侧列 */
  panels?: readonly PanelId[];
  /** 状态容器：`View` / `Toolbar` / `Panels` 三处要共享的状态放这儿
   *  （设计稿的 picked 与预览模式就是这种）。不需要共享就不写。 */
  Provider?: FC<{ ctx: ViewContext; children: ReactNode }>;
  /** 详情区主体 —— 唯一必须有的一样 */
  View: FC<{ ctx: ViewContext }>;
  /** **编辑栏**（36px，Tab 条下面那一行；第九轮改的语义）。
   *  里面只放**改稿用**的开关：点选、撤销、源码、圈选、范围排布……
   *  **默认收起**，点 Tab 条右端的 ✎ 才展开 —— 不写就没有 ✎ 这颗钮
   *  （代码和其他文件就是这样）。
   *
   *  ⚠️ 第七轮这里叫「文件工具栏」且常驻，第九轮用户看了实物说
   *  「非必要的内容可以先收起」，设计侧据此改成默认收起。 */
  Toolbar?: FC<{ ctx: ViewContext }>;
  /** **正文右下角的浮块**（第九轮）。里面只放**看稿用**的：
   *  稿的浅深色、宽度缩放、演示、图片缩放。
   *
   *  为什么和编辑栏分开：这两类的使用频率完全不同 ——
   *  看稿用的一直在用（所以常驻），改稿用的是进入编辑态之后才用（所以收起）。
   *  混在一行里，要么全常驻（占地方），要么全收起（每次看稿都要多点一下）。 */
  Corner?: FC<{ ctx: ViewContext }>;
  /** 右侧面板列。声明了 `panels` 就该有它 */
  Panels?: FC<{ ctx: ViewContext }>;
  /** `⋯` 菜单里属于这种格式的项。公共尾巴（复制路径 / 在访达中显示 / 关闭页签）由工作台补。
   *  ⚠️ 同 `Toolbar`：M8-14 只留位置，它的落脚点是文件工具栏右侧那颗 `⋯`（M8-15）。 */
  menu?: (ctx: ViewContext) => MenuItem[];
  /** 状态行中间那几段（前面的路径、后面的布局读数是工作台的事）。
   *  **是组件不是函数** —— 目录要显示「已选 3 项」，而勾选状态住在模块的 Provider 里，
   *  纯函数取不到 React context。
   *
   *  不写就用类型名兜底（`kindDef(kind).label`）。**这个兜底是必要的**：
   *  M8-14 里 Markdown 模块漏写了它，状态行就只剩「文件名 ·」后面空着 ——
   *  一条「省略等于空白」的接口，早晚会有人省略。 */
  Status?: FC<{ ctx: ViewContext }>;
}

const REG = new Map<FileKind, KindModule>();

/* ═══ 迟到注册（M11-3，Q37）═══
   插件是**启动之后**才装上的，所以注册表不能只在模块加载时填一次。
   难的不是"往 Map 里再塞一个" —— 是**塞完之后界面要重画**：
   用户装了视频插件，正开着的那个 `.mp4` 页签应该当场从「通用文件卡」变成视频编辑器，
   而不是要他关掉重开。

   用 `useSyncExternalStore` 而不是自己发事件 + setState：
   React 18 并发渲染下，自己发事件容易读到撕裂的状态（一半组件看到新注册表、一半看到旧的）。 */
let version = 0;
const listeners = new Set<() => void>();
const bump = () => { version++; for (const l of listeners) l(); };

/** 订阅注册表的变化。**只有真变了才会 bump** —— 每次渲染都 bump 会打死循环。 */
export function useKindRegistry(): number {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => version,
    () => version,     // 服务端快照：和客户端一样，这个表不依赖浏览器
  );
}

export function register(m: KindModule): void {
  for (const id of m.ids) {
    /* 撞车要当场喊出来。两个模块认领同一种 kind 时，后注册的会静默覆盖前一个，
       而症状是「某种文件的工具栏莫名其妙变了」—— 那时候很难想到是注册撞了。

       ⚠️ 插件装上时这一条更要紧：两个插件抢同一种格式，用户看到的是
       「装了 B 之后 A 就不работает了」，而两边都没报错。 */
    if (REG.has(id)) throw new Error(`文件类型 ${id} 被注册了两次 —— 一种 kind 只能有一个模块（先来的：${REG.get(id)!.from ?? "内置"}，后来的：${m.from ?? "内置"}）`);
    REG.set(id, m);
  }
  bump();
}

/** 卸载插件：把它带来的模块全摘掉。返回摘了几种。
 *  摘完 bump 一次 —— 正开着那种文件的页签要退回通用文件卡，不能停在一个已经没了的视图上。 */
export function unregisterFrom(pluginId: string): number {
  let n = 0;
  for (const [id, m] of [...REG]) if (m.from === pluginId) { REG.delete(id); n++; }
  if (n) bump();
  return n;
}

/** 取这种 kind 的模块。**永远有返回值** —— 没人认领的一律落到 `other`（文件卡）。 */
export function moduleFor(kind: FileKind): KindModule {
  const m = REG.get(kind) ?? REG.get("other");
  if (!m) throw new Error("注册表是空的 —— `kinds/index.ts` 没被 import");
  return m;
}

/** 这种 kind 有哪些从属面板。`layout.panelsFor` 以前写死了 dc / md，现在问模块。 */
export function panelsOf(kind: FileKind): PanelId[] {
  return [...(moduleFor(kind).panels ?? [])];
}

/** 已注册的种类 —— 给回归用（数一数注册表和 shared 的种类表对不对得上），
 *  也给插件加载器用（装完之后核对它声明的 kind 真的都认领了） */
export function registered(): FileKind[] { return [...REG.keys()]; }
