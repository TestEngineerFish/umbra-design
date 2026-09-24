import { createContext, useContext, useState, type ReactNode } from "react";
import { HEALTH_LABEL } from "../api/types";
import { Canvas, type PreviewMode } from "../workbench/Canvas";
import { SidePanels } from "../workbench/SidePanels";
import type { ViewContext } from "./context";
import type { KindModule } from "./registry";

/** `.dc.html` 设计稿 —— 这个工具最深的一种类型（`01` §1）。
 *
 *  它是唯一同时用到全部五样声明的格式：画布、五个从属面板、自己的 `⋯` 项、
 *  状态行读数，以及一份跨位置共享的状态（预览模式）。
 *  别的格式简单得多 —— 这是「基础设施按最复杂的那一种设计，简单的自然装得下」。
 */
interface DcState { mode: PreviewMode; setMode: (m: PreviewMode) => void }
const DcCtx = createContext<DcState | null>(null);
const useDc = (): DcState => {
  const v = useContext(DcCtx);
  if (!v) throw new Error("dc 的 Provider 没包上 —— 工作台必须用 mod.Provider 裹住 View / Toolbar / Panels");
  return v;
};

function Provider({ ctx, children }: { ctx: ViewContext; children: ReactNode }) {
  /* 预览模式（壳 / 预览 / 源码）记在盘上，换稿不重置 —— 用户挑好的看法是长期偏好。
     走 ctx.mem 而不是 localStorage 直接读写：它已经按格式加了命名空间。 */
  const [mode, setModeRaw] = useState<PreviewMode>(() => ctx.mem.get("previewMode", "shell" as PreviewMode));
  const setMode = (m: PreviewMode) => { setModeRaw(m); ctx.mem.set("previewMode", m); };
  return <DcCtx.Provider value={{ mode, setMode }}>{children}</DcCtx.Provider>;
}

function View({ ctx }: { ctx: ViewContext }) {
  const { mode, setMode } = useDc();
  return (
    <Canvas url={ctx.project.url} store={ctx.store} file={ctx.path} picked={ctx.picked} onPicked={ctx.setPicked}
      mode={mode} setMode={setMode} onPresent={ctx.ui.present} onOpenPanel={(p) => ctx.ui.openPanel(p)}
      unresolved={ctx.store.comments.filter((c) => !c.resolved).length} />
  );
}

function Panels({ ctx }: { ctx: ViewContext }) {
  return (
    <SidePanels core={ctx.core} store={ctx.store} file={ctx.path} picked={ctx.picked} onPicked={ctx.setPicked}
      panels={[...(dc.panels ?? [])]} active={ctx.ui.activePanel} setActive={ctx.ui.openPanel} narrow={ctx.narrow}
      onSendToAI={(text, p) => { ctx.setPicked(p); ctx.ask(text); }} outline={[]} />
  );
}

export const dc: KindModule = {
  ids: ["dc"],
  panels: ["props", "diagnostics", "changes", "comments", "info"],
  Provider, View, Panels,
  Status: ({ ctx }) => {
    const d = ctx.store.drafts.find((x) => x.file === ctx.path);
    if (!d) return <span>设计稿</span>;
    return (
      <>
        <span>{d.kind === "component" ? "组件稿" : "设计稿"}</span>
        <span>·</span><span>{d.version ?? "—"}</span>
        <span>·</span><span>{d.elements ?? "—"} 元素</span>
        <span>·</span><span title={d.healthWhy}>{HEALTH_LABEL[d.health]}</span>
      </>
    );
  },
};
