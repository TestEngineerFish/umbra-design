import { ALL_KINDS } from "@shared/kinds";
import { register, registered, type KindModule } from "./registry";
import { dc } from "./dc";
import { dir } from "./dir";
import { fallback } from "./fallback";
import { image } from "./image";
import { json } from "./json";
import { md } from "./md";

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
const ALL: readonly KindModule[] = [dc, md, json, image, dir, fallback];
for (const m of ALL) register(m);

/* 开发期自检：`shared/kinds.ts` 里声明的每一种都得有模块认领。
   没有这条的话，加了一种 kind 却忘了写模块，界面**不会报错** ——
   它会静静落到 `other` 的文件卡上，看起来只是「这种文件还没做」，
   而真相是「做了一半」。这种错最难发现，所以让它在打开界面的第一秒就炸。 */
if (import.meta.env.DEV) {
  const claimed = new Set(registered());
  const missing = ALL_KINDS.filter((k) => !claimed.has(k));
  if (missing.length) throw new Error(`这些文件类型没有模块认领：${missing.join(" / ")} —— 在 app/src/kinds/ 下补一个，并在 index.ts 里注册`);
}

export { moduleFor, panelsOf, registered } from "./registry";
export type { KindModule } from "./registry";
export type { MenuItem, ViewContext } from "./context";
export { FileMore, Seg, SizeBtn, ToolbarBar } from "./toolbar";
