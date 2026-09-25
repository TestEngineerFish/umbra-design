import { SidePanels } from "../../workbench/SidePanels";
import type { ViewContext } from "../context";
import type { KindModule } from "../registry";
import { Seg } from "../toolbar";
import { MdProvider, useMdDoc } from "./doc";
import { MdView } from "./View";

export type { Outline } from "./parse";

/** Markdown（`00` §六十、M8-15b 拆成目录）。
 *
 *  一种格式的全部代码在**一个目录**里：`parse.ts` 纯函数 · `doc.tsx` 状态 ·
 *  `View.tsx` 画面 · 这里是对外的模块声明。
 *  以前它是 `workbench/MarkdownView.tsx` 一个 208 行的组件，状态、画面、工具栏混在一起，
 *  想改工具栏得先读完整个文件。
 */
function Toolbar() {
  const d = useMdDoc();
  return (
    <>
      <Seg label="视图" items={[
        { label: "渲染", active: d.mode === "render", onPick: () => d.setMode("render") },
        { label: "源码", active: d.mode === "source", onPick: () => d.setMode("source"), title: "带行号，可直接改；⌘S 或失焦落盘" },
      ]} />
      <span className="flex-1" />
      {/* 【判断】「选中这段给 AI」留在工具栏 —— 它变的是这份文件（把它的一段交出去），
          按第七轮那条判据属于第四层。设计侧这一轮没画到这颗，第八轮回来再调。 */}
      {d.sel && <span className="font-mono text-accent text-[11px] shrink-0">L{d.sel.from}{d.sel.to > d.sel.from ? `–${d.sel.to}` : ""} · 已带进会话</span>}
      <button className="btn sm shrink-0" onClick={d.pickSelection}>选中这段给 AI</button>
    </>
  );
}

function Panels({ ctx }: { ctx: ViewContext }) {
  const d = useMdDoc();
  return (
    <SidePanels core={ctx.core} store={ctx.store} file={ctx.path} picked={null} onPicked={() => {}}
      panels={["outline"]} active={ctx.ui.activePanel} setActive={ctx.ui.openPanel} narrow={ctx.narrow}
      onSendToAI={(text) => ctx.ask(text)} outline={d.outline} />
  );
}

/** 版本历史收进 `⋯` —— 它是低频动作，常驻一颗钮不值当（和第七轮把「体检」收起同一个理由） */
function StatusBit() {
  const d = useMdDoc();
  return <>{d.info?.snapshot ?? "未改过"}{d.dirty ? " · 未落盘" : ""}</>;
}

export const md: KindModule = {
  ids: ["md"],
  panels: ["outline"],
  Provider: MdProvider,
  View: MdView,
  Toolbar,
  Panels,
  Status: StatusBit,
  menu: () => [{ label: "版本历史", run: () => window.dispatchEvent(new CustomEvent("ud-md-snaps")) }],
};
