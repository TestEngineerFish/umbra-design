import { ImageView } from "../workbench/ImageView";
import type { ViewContext } from "./context";
import type { KindModule } from "./registry";

/** 图片（`00` §六十一）。没有从属面板 —— 一张图没有「属性」可列。
 *
 *  它唯一要问工作台的是**这个引擎吃不吃图**，而这个答案一律靠 `probe_image_support` 探，
 *  不按模型名猜：实测 `deepseek-chat` 能看图，按名字猜会猜错（`11` Q32）。
 */
export const image: KindModule = {
  ids: ["image"],
  View: ({ ctx }: { ctx: ViewContext }) => (
    <ImageView core={ctx.core} path={ctx.path} supportsImage={ctx.ai.supportsImage} channelLabel={ctx.ai.engineLabel}
      onProbed={ctx.ai.reloadCaps} onSelection={(s) => ctx.select("region", s)} />
  ),
};
