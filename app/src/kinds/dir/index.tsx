import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { mem } from "../../layout/layout";
import { kindDef } from "@shared/kinds";
import type { ViewContext } from "../context";
import type { KindModule } from "../registry";
import { Seg } from "../toolbar";
import { DirView } from "./View";

/** 目录（`00` §五十九；M8-15b 拆成目录）。`ctx.path` 是目录的相对路径，`""` = 项目根。
 *
 *  住在这里的状态有三样，都是**工具栏和视图各要一半**的：
 *  范围（全部 / 只看稿件）、排布（列表 / 网格，按目录记忆）、勾选。
 *  勾选还要喂状态行的「已选 3 项」，所以它也在这一层。
 */
interface DirState {
  sel: string[]; setSel: (p: string[]) => void;
  onlyDrafts: boolean; setOnlyDrafts: (v: boolean) => void;
  manual: Record<string, "list" | "grid">; setManual: (m: Record<string, "list" | "grid">) => void;
  counts: { total: number; autoNote: string | null; view: "list" | "grid" };
  setCounts: (c: { total: number; autoNote: string | null; view: "list" | "grid" }) => void;
  dirRel: string;
}
const Ctx = createContext<DirState | null>(null);
const useDir = (): DirState => {
  const v = useContext(Ctx);
  if (!v) throw new Error("dir 的 Provider 没包上");
  return v;
};

function Provider({ ctx, children }: { ctx: ViewContext; children: ReactNode }) {
  const [sel, setSel] = useState<string[]>([]);
  const [onlyDrafts, setOnlyDrafts] = useState(false);
  const [manual, setManualRaw] = useState<Record<string, "list" | "grid">>(() => mem.get("us.viewByDir", {}));
  const [counts, setCounts] = useState({ total: 0, autoNote: null as string | null, view: "list" as "list" | "grid" });
  const setManual = (m: Record<string, "list" | "grid">) => { setManualRaw(m); mem.set("us.viewByDir", m); };

  /* 换目录、按 Esc 都清空勾选。
     ⚠️ Provider **按 kind 挂载**，换目录不会重建它，所以得自己清 ——
     不清的话在 a/ 里勾了三个、进 b/ 还显示「已选 3 项」，而那三个不在这儿。 */
  useEffect(() => { setSel([]); }, [ctx.path]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === "Escape") setSel([]); };
    document.addEventListener("keydown", on); return () => document.removeEventListener("keydown", on);
  }, []);
  /* DirView 底部的「带进会话」走一个 window 事件。**勾选本身不产生药丸** ——
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

  return <Ctx.Provider value={{ sel, setSel, onlyDrafts, setOnlyDrafts, manual, setManual, counts, setCounts, dirRel: ctx.path }}>{children}</Ctx.Provider>;
}

function Toolbar() {
  const d = useDir();
  const setView = (v: "list" | "grid") => d.setManual({ ...d.manual, [d.dirRel]: v });
  return (
    <>
      <Seg label="范围" items={[
        { label: "全部", active: !d.onlyDrafts, onPick: () => d.setOnlyDrafts(false) },
        { label: "只看稿件", active: d.onlyDrafts, onPick: () => d.setOnlyDrafts(true) },
      ]} />
      <Seg label="排布" items={[
        { label: "列表", active: d.counts.view === "list", onPick: () => setView("list") },
        { label: "网格", active: d.counts.view === "grid", onPick: () => setView("grid") },
      ]} />
      {/* 自动切网格时说明为什么 —— 不说的话用户会以为是自己上次切的 */}
      {d.counts.autoNote && <span className="text-muted text-[11px] shrink-0">{d.counts.autoNote}</span>}
      <span className="flex-1" />
    </>
  );
}

function View({ ctx }: { ctx: ViewContext }) {
  const d = useDir();
  return (
    <DirView core={ctx.core} dirRel={ctx.path} selected={d.sel} onOpen={ctx.open} onSelectionChange={d.setSel}
      onlyDrafts={d.onlyDrafts} manual={d.manual} onCounts={d.setCounts} />
  );
}

export const dir: KindModule = {
  ids: ["dir"],
  Provider, View, Toolbar,
  Status: ({ ctx }) => {
    const d = useDir();
    return <>
      <span>{kindDef(ctx.kind).label}</span>
      <span>·</span><span>{d.counts.total} 项</span>
      {d.sel.length > 0 && <><span>·</span><span className="text-accent">已选 {d.sel.length}</span></>}
    </>;
  },
};
