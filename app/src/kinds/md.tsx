import { createContext, useContext, useState, type ReactNode } from "react";
import { MarkdownView, type Outline } from "../workbench/MarkdownView";
import { SidePanels } from "../workbench/SidePanels";
import type { ViewContext } from "./context";
import type { KindModule } from "./registry";

/** Markdown（`00` §六十）。
 *
 *  这个模块是 `Provider` 存在意义的最好例子：**大纲由 View 产出、由 Panels 消费**。
 *  重构前它是工作台里的一个 `useState<Outline[]>` —— 一份只有 Markdown 用得上的状态，
 *  却住在所有格式共用的组件里，`.dc.html` 和图片也跟着重渲染。现在它住在这儿。
 */
interface MdState { outline: Outline[]; setOutline: (o: Outline[]) => void }
const MdCtx = createContext<MdState | null>(null);
const useMd = (): MdState => {
  const v = useContext(MdCtx);
  if (!v) throw new Error("md 的 Provider 没包上");
  return v;
};

function Provider({ children }: { ctx: ViewContext; children: ReactNode }) {
  const [outline, setOutline] = useState<Outline[]>([]);
  return <MdCtx.Provider value={{ outline, setOutline }}>{children}</MdCtx.Provider>;
}

function View({ ctx }: { ctx: ViewContext }) {
  const { setOutline } = useMd();
  return (
    <MarkdownView core={ctx.core} path={ctx.path} writeTick={String(ctx.store.fileTick(ctx.path))}
      onWritten={() => void ctx.store.fetchDrafts()} onOutline={setOutline}
      onSelection={(s) => ctx.select("range", s)} />
  );
}

function Panels({ ctx }: { ctx: ViewContext }) {
  const { outline } = useMd();
  return (
    <SidePanels core={ctx.core} store={ctx.store} file={ctx.path} picked={null} onPicked={() => {}}
      panels={["outline"]} active={ctx.ui.activePanel} setActive={ctx.ui.openPanel} narrow={ctx.narrow}
      onSendToAI={(text) => ctx.ask(text)} outline={outline} />
  );
}

export const md: KindModule = { ids: ["md"], panels: ["outline"], Provider, View, Panels };
