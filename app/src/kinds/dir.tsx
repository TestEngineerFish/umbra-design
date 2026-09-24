import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { DirView } from "../workbench/DirView";
import type { ViewContext } from "./context";
import { kindDef, type KindModule } from "./registry";

/** 目录（`00` §五十九）。`ctx.path` 是目录的相对路径，`""` = 项目根。
 *
 *  勾选状态住在这个模块里 —— 工作台以前替它记着一个 `dirSel`，
 *  而那是只有目录用得上的东西。状态行的「已选 3 项」也读这里，
 *  所以 `Status` 得是组件：纯函数取不到 React context。
 */
const SelCtx = createContext<{ sel: string[]; setSel: (p: string[]) => void }>({ sel: [], setSel: () => {} });

function Provider({ ctx, children }: { ctx: ViewContext; children: ReactNode }) {
  const [sel, setSel] = useState<string[]>([]);
  /* 换目录、按 Esc 都清空。
     ⚠️ Provider **按 kind 挂载**，换目录不会重建它，所以得自己清 ——
     不清的话在 a/ 里勾了三个、进 b/ 还显示「已选 3 项」，而那三个不在这儿。 */
  useEffect(() => { setSel([]); }, [ctx.path]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === "Escape") setSel([]); };
    document.addEventListener("keydown", on); return () => document.removeEventListener("keydown", on);
  }, []);
  /* DirView 的「带进会话」按钮走一个 window 事件。**勾选本身不产生药丸** ——
     勾选是在挑，按下那颗钮才是「就这些，给 AI」（`01` 第 32 条的口径）。 */
  useEffect(() => {
    const on = (e: Event) => {
      const paths = (e as CustomEvent<string[]>).detail ?? [];
      if (!paths.length) return;
      ctx.select("files", {
        kind: "files",
        label: paths.length === 1 ? (paths[0]!.split("/").pop() ?? paths[0]!) : `${paths.length} 个文件`,
        detail: paths.join("\n"),
      });
      ctx.ui.expandChat();
      setTimeout(() => document.getElementById("chatInput")?.focus(), 50);
    };
    window.addEventListener("ud-send-files", on); return () => window.removeEventListener("ud-send-files", on);
  }, [ctx]);
  return <SelCtx.Provider value={{ sel, setSel }}>{children}</SelCtx.Provider>;
}

function View({ ctx }: { ctx: ViewContext }) {
  const { sel, setSel } = useContext(SelCtx);
  return <DirView core={ctx.core} dirRel={ctx.path} selected={sel} onOpen={ctx.open} onSelectionChange={setSel} />;
}

export const dir: KindModule = {
  ids: ["dir"],
  Provider, View,
  Status: ({ ctx }) => {
    const { sel } = useContext(SelCtx);
    return <>
      <span>{kindDef(ctx.kind).label}</span>
      {sel.length > 0 && <><span>·</span><span>已选 {sel.length} 项</span></>}
    </>;
  },
};
