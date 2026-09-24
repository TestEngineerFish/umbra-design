import { FileCard } from "../workbench/FileCard";
import type { KindModule } from "./registry";
import type { ViewContext } from "./context";

/** 还没有专门视图的类型：代码、普通网页、其他（`00` §五十九的通用文件卡）。
 *
 *  **`other` 这一条是注册表的兜底**，`moduleFor` 找不到模块时落到它 ——
 *  所以在 `shared/kinds.ts` 里加一种新 kind、忘了写模块，界面不会崩，
 *  只是暂时显示成文件卡。这是有意的：先能打开，再谈怎么编辑。
 */
export const fallback: KindModule = {
  ids: ["code", "html", "other"],
  View: ({ ctx }: { ctx: ViewContext }) => <FileCard core={ctx.core} host={ctx.host} path={ctx.path} onOpen={ctx.open} />,
};
