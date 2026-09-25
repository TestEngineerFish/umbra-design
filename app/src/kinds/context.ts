import type { ReactNode } from "react";
import type { Core, ProjectHandle } from "../api/client";
import type { PanelId } from "../layout/layout";
import type { FileKind } from "@shared/kinds";
import type { Picked, Selection, SelectionKind } from "../api/types";
import type { HostAdapter } from "../host";
import type { ProjectStore } from "../store/project";

/** 格式模块与工作台之间的**唯一契约**（M8-14）。
 *
 *  为什么要有这一层：以前详情区是一条
 *  `kind === "dc" ? <Canvas 十个 props/> : kind === "md" ? <MarkdownView 六个 props/> : …`
 *  的三元链，每加一种格式都要改工作台、改那一行、给新组件想一套 props。
 *  三种格式时还能看，第五种就成了一堆。
 *
 *  换成这样：**工作台只提供能力，不认识任何具体格式**。它把自己能给的一切
 *  收进这个 ctx，格式模块各取所需。加一种格式 = 新增一个文件 + 在 `index.ts` 里注册一行，
 *  工作台一个字都不用动 —— 这也是「改一种格式不影响其他格式」的由来。
 *
 *  接口该有哪些字段不是拍脑袋定的，是把现有五个视图组件的 props 求了个并集。
 *  以后要加字段，先问一句：**这是「工作台的能力」还是「某种格式自己的事」**？
 *  后者不该进来 —— 它属于那个模块内部的 state。
 */
export interface ViewContext {
  /* ── 后端与壳 ── */
  core: Core;
  host: HostAdapter;
  project: ProjectHandle;
  /** 项目级状态：稿件表、诊断、评论、变更、落盘计数 */
  store: ProjectStore;

  /** 当前打开的路径。目录时是目录的相对路径（`""` = 项目根） */
  path: string;
  /** 这个路径判出来的类型。一个模块可以认领几种（文件卡管 code / html / other），
   *  它需要知道自己这次被用在哪一种上。 */
  kind: FileKind;
  /** 详情区窄到要让位了（实测宽度 < 480px，R5）。视图该自己收掉次要的东西 */
  narrow: boolean;

  /** 打开另一个文件或目录 */
  open(path: string, isDir?: boolean): void;

  /** 把一颗药丸交给会话，传 `null` 撤掉这一类。**同一类只留一颗** ——
   *  选区是「当前选的那一块」，不是历史记录。 */
  select(kind: SelectionKind, sel: Selection | null): void;
  /** 直接开一轮 AI（会话栏是输入条时先展开它） */
  ask(text: string, sels?: Selection[]): void;

  /** 点中了稿里的一个节点。**只有设计稿用得上**，却由工作台持有 ——
   *  因为它除了喂属性面板，还要同时变成一颗会话药丸，而药丸是工作台的事。
   *  格式模块内部的状态（例如 Markdown 的大纲）不走这里，走模块自己的 Provider。 */
  picked: Picked | null;
  setPicked(p: Picked | null): void;

  ui: {
    /** 当前展开的从属面板，`null` = 收起（R3 按类型记忆，存在 layout 里） */
    activePanel: PanelId | null;
    /** 切到某个从属面板（例如画布角标点「3 条诊断」就跳到诊断）；`null` 收起 */
    openPanel(p: PanelId | null): void;
    /** 会话栏收成输入条时展开它 —— 要让用户看见 AI 在说什么 */
    expandChat(): void;
    /** 关掉当前文件的页签。它出现在文件 `⋯` 的公共尾巴里（设计侧第七轮的 `fileTail`） */
    closeFile(): void;
    toast(title: string, body?: string, kind?: "error" | "ok"): void;
  };

  /** AI 侧的能力查询。图片视图要问「这个引擎吃不吃图」，
   *  而这个答案一律靠 `probe_image_support` 探，不按模型名猜（`11` Q32）。 */
  ai: { supportsImage: boolean; engineLabel: string; reloadCaps(): void };

  /** 模块自己的小记忆。**已经按格式加了命名空间**（`us.kind.<id>.<键>`），
   *  所以两种格式用同一个键名也撞不到一起。 */
  mem: { get<T>(k: string, d: T): T; set(k: string, v: unknown): void };
}

/** 文件 `⋯` 菜单里的一项。`hint` 是右边那行灰字（快捷键或读数） */
export interface MenuItem {
  label: string;
  hint?: string;
  danger?: boolean;
  run?: () => void;
}
export const MENU_SEP: MenuItem = { label: "—" };

/** 状态行里属于这份文件的那几段（工作台负责前面的路径和后面的布局读数） */
export type StatusBits = ReactNode;
