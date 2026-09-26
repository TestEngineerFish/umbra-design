import { allKinds, type FileKind } from "@shared/kinds";
import { register, registered, type KindModule } from "./registry";
import { dc } from "./dc";
import { dir } from "./dir";
import { fallback } from "./fallback";
import { image } from "./image";
import { json } from "./json";

/** **「有哪些格式」这件事只写在这里。** 加一种格式的全部工作是三步：
 *
 *  1. `server/src/shared/kinds.ts` 里加一条 `KindDef`（怎么认出它、叫什么、什么图标）——
 *     前后端同时生效，不用改两遍
 *  2. `app/src/kinds/<它>.tsx` 写它的视图 / 工具栏 / 面板 / 菜单
 *  3. 在下面这个数组里加一行
 *
 *  `Workbench.tsx` 一个字都不用动。这就是「每次迭代一个新格式，不影响其他格式」的
 *  具体含义 —— 也是判断这次抽象是否抽对了的**硬判据**：
 *  如果加一种格式还得回去改工作台，说明没抽对。
 *
 *  顺序不影响行为（匹配顺序在 `shared/kinds.ts` 里定），这里按从深到浅排，方便读。
 */
/* ⚠️ **`md` 不在这里了**（M11-9b）：它搬成了内置插件 `plugins/com.umbra.markdown/`。
   一种 kind 只能有一个模块，内置模块和插件都认领 `md` 会当场抛。
   内置插件跟主程序一起发、免费、卸不掉，所以对用户来说没有区别 —— 打开 `.md` 照样能编辑。
   代价写在 `doc/00` §八十八：markdown 渲染器在插件包里是第二份实例。 */
const ALL: readonly KindModule[] = [dc, json, image, dir, fallback];
for (const m of ALL) register(m);

/** 开发期自检：种类表里声明的每一种都得有模块认领。
 *
 *  没有这条的话，加了一种 kind 却忘了写模块，界面**不会报错** ——
 *  它会静静落到 `other` 的文件卡上，看起来只是「这种文件还没做」，
 *  而真相是「做了一半」。这种错最难发现，所以让它在打开界面的第一秒就炸。
 *
 *  ⚠️ M11-2 之后**它必须能重复跑**：种类表是运行期的，插件装上会往里加。
 *  原来这段是模块顶层的一次性代码 —— 插件加了种类却没给模块，一样会静静落到文件卡，
 *  而这一次连开发期都不会炸。所以抽成函数，装完插件再调一次。 */
export function auditKinds(): FileKind[] {
  const claimed = new Set(registered());
  return allKinds().filter((k) => !claimed.has(k));
}

/* ⚠️ 自检**不能在模块顶层跑了**（M11-9b）：`md` 现在由内置插件认领，
   而插件是启动后异步接线的 —— 顶层这一刻它必然还没到，自检会误报。
   改成由 `App` 在插件接完线之后调（`loadPlugins().then(...)`）。 */
export function auditKindsOrThrow(): void {
  if (!import.meta.env.DEV) return;
  const missing = auditKinds();
  if (missing.length) throw new Error(`这些文件类型没有模块认领：${missing.join(" / ")} —— 内置的在 app/src/kinds/ 下补并在 index.ts 注册；插件带的看它装没装上`);
}

export { moduleFor, panelsOf, registered, register, unregisterFrom, useKindRegistry } from "./registry";
export type { KindModule } from "./registry";
export type { MenuItem, ViewContext } from "./context";
export { FileMore, Seg, SizeBtn, ToolbarBar } from "./toolbar";
