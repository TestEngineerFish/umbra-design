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
  /** 右侧从属面板（R1）。不写 = 这种格式没有右侧列 */
  panels?: readonly PanelId[];
  /** 状态容器：`View` / `Toolbar` / `Panels` 三处要共享的状态放这儿
   *  （设计稿的 picked 与预览模式就是这种）。不需要共享就不写。 */
  Provider?: FC<{ ctx: ViewContext; children: ReactNode }>;
  /** 详情区主体 —— 唯一必须有的一样 */
  View: FC<{ ctx: ViewContext }>;
  /** 文件工具栏（34px 那条横带）。**不写就不出这条带** ——
   *  设计侧明确说了代码和其他文件没有这一行，不要给它留一条空横带。
   *  ⚠️ M8-14 只留了位置：各视图的开关**现在还在视图内部**，
   *  按第七轮形制上移到这里是 M8-15 的事。 */
  Toolbar?: FC<{ ctx: ViewContext }>;
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

export function register(m: KindModule): void {
  for (const id of m.ids) {
    /* 撞车要当场喊出来。两个模块认领同一种 kind 时，后注册的会静默覆盖前一个，
       而症状是「某种文件的工具栏莫名其妙变了」—— 那时候很难想到是注册撞了。 */
    if (REG.has(id)) throw new Error(`文件类型 ${id} 被注册了两次 —— 一种 kind 只能有一个模块`);
    REG.set(id, m);
  }
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

/** 已注册的种类 —— 只给回归用（数一数注册表和 shared 的 KINDS 对不对得上） */
export function registered(): FileKind[] { return [...REG.keys()]; }
