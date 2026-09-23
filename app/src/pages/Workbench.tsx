import { useEffect, useState } from "react";
import type { Core, UdEvent } from "../api/client";
import type { HostAdapter } from "../host";
import { kindOf, loadLayout, saveLayout, type ChatRail } from "../layout/layout";

/** 空的工作台布局（M7-2）：左会话 / 右预览为主结构，预览永远最大（R1）；会话栏三态（R2）；
 *  从属面板按类型出现并记住收放（R3）；< 1100px 从属面板改抽屉（R5）。功能平移在 M7-5 / M7-6。 */
export function Workbench({ core, host, boot, onHome }: { core: Core; host: HostAdapter; boot: { name: string; title: string; dir: string }; onHome: () => void }) {
  const [layout, setLayout] = useState(loadLayout);
  const [drafts, setDrafts] = useState<{ file: string }[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [wsState, setWsState] = useState<"open" | "closed">("closed");
  const [lastEvent, setLastEvent] = useState<UdEvent | null>(null);
  const [narrow, setNarrow] = useState(() => window.innerWidth < 1100);
  const [drawer, setDrawer] = useState(false);
  useEffect(() => { host.setTitle(boot.title || boot.name); }, [host, boot]);
  useEffect(() => { void core.get<{ drafts: { file: string }[] }>("drafts").then((r) => setDrafts(r.ok ? (r.data?.drafts ?? []) : [])); }, [core]);
  useEffect(() => core.events((e) => setLastEvent(e), setWsState), [core]);
  useEffect(() => { const on = () => setNarrow(window.innerWidth < 1100); window.addEventListener("resize", on); return () => window.removeEventListener("resize", on); }, []);
  const kind = selected ? kindOf(selected) : "dir";
  const sideOpen = layout.side[kind];
  const setChat = (chat: ChatRail) => { const s = { ...layout, chat }; setLayout(s); saveLayout(s); };
  const toggleSide = () => { const s = { ...layout, side: { ...layout.side, [kind]: !sideOpen } }; setLayout(s); saveLayout(s); };

  const chatRail = layout.chat === "bar" ? null : (
    <aside className="w-[340px] shrink-0 border-border bg-panel flex flex-col" style={{ borderRightWidth: layout.chat === "left" ? 1 : 0, borderLeftWidth: layout.chat === "right" ? 1 : 0 }}>
      <div className="h-11 px-3 flex items-center gap-2 border-b border-border"><span className="font-semibold text-sm">AI 会话</span><span className="flex-1" />
        <button className="text-xs text-muted hover:text-text" onClick={() => setChat(layout.chat === "left" ? "right" : "left")} title="换边">⇄</button>
        <button className="text-xs text-muted hover:text-text" onClick={() => setChat("bar")} title="收成输入条">—</button></div>
      <div className="flex-1 flex items-center justify-center text-muted text-xs text-center px-6">会话面板在 M7-6 平移（方式 ② ③）</div>
      <div className="p-3 border-t border-border"><input disabled placeholder={`对 ${selected ?? "这个目录"} 说…（M7-6）`} className="w-full h-9 px-3 rounded border border-border bg-bg text-xs" /></div>
    </aside>
  );
  const sidePanel = sideOpen && selected ? (
    <aside className={`bg-panel border-border flex flex-col ${narrow ? "fixed inset-y-0 right-0 z-40 w-[360px] shadow-2xl border-l" : "w-[340px] shrink-0 border-l"}`}>
      <div className="h-11 px-3 flex items-center border-b border-border text-sm font-semibold">{kind === "dc" ? "属性 · 诊断 · 变更 · 评论" : kind === "md" ? "大纲" : "从属面板"}<span className="flex-1" /><button className="text-xs text-muted" onClick={() => (narrow ? setDrawer(false) : toggleSide())}>收起</button></div>
      <div className="flex-1 flex items-center justify-center text-muted text-xs px-6 text-center">按类型出现的从属面板（R1）。内容在 M7-6 平移。</div>
    </aside>
  ) : null;
  const showSide = narrow ? drawer : true;

  return (
    <div className="h-full flex flex-col">
      <header className="h-11 px-3 flex items-center gap-3 border-b border-border bg-panel shrink-0">
        <button className="text-sm font-semibold hover:text-accent" onClick={onHome} title="回到项目列表">Umbra Studio</button>
        <span className="text-border">|</span>
        <span className="text-sm font-semibold truncate">{boot.name}</span>
        <span className="text-xs text-muted truncate">{boot.title}</span>
        <span className="text-xs text-muted">{drafts.length} 份稿</span>
        <span className="flex-1" />
        <span className={`text-[11px] ${wsState === "open" ? "text-ok" : "text-muted"}`} title={lastEvent ? `最近事件 ${lastEvent.type} · ${lastEvent.at}` : "还没有事件"}>WS {wsState === "open" ? "已连" : "断开"}{lastEvent ? ` · ${lastEvent.type}` : ""}</span>
        <button className="text-xs text-muted hover:text-text" onClick={() => void host.revealInFinder(boot.dir)}>在访达中显示</button>
      </header>
      <div className="flex-1 min-h-0 flex">
        {layout.chat === "left" && chatRail}
        <main className="flex-1 min-w-0 flex flex-col bg-canvas">
          <div className="h-11 px-3 flex items-center gap-2 border-b border-border bg-panel shrink-0">
            <select value={selected ?? ""} onChange={(e) => setSelected(e.target.value || null)} className="h-7 px-2 rounded border border-border bg-panel text-xs max-w-[280px]">
              <option value="">选一份稿…</option>{drafts.map((d) => <option key={d.file} value={d.file}>{d.file}</option>)}
            </select>
            <span className="flex-1" />
            {selected && !sideOpen && !narrow && <button className="text-xs text-muted hover:text-text" onClick={toggleSide}>展开面板</button>}
            {selected && narrow && <button className="text-xs text-muted hover:text-text" onClick={() => setDrawer((d) => !d)}>面板</button>}
          </div>
          <div className="flex-1 flex items-center justify-center text-muted text-xs text-center px-6">{selected ? `预览区（永远最大，R1）· ${selected} · 类型 ${kind} · 预览器在 M7-6 平移` : "预览区（永远最大，R1）"}</div>
          {layout.chat === "bar" && (
            <div className="h-12 px-3 flex items-center gap-2 border-t border-border bg-panel"><button className="text-xs text-muted hover:text-text" onClick={() => setChat("left")}>展开会话栏</button><input disabled placeholder="对这个目录说…（M7-6）" className="flex-1 h-8 px-3 rounded border border-border bg-bg text-xs" /></div>
          )}
        </main>
        {showSide && sidePanel}
        {layout.chat === "right" && chatRail}
      </div>
    </div>
  );
}
