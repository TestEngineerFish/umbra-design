import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ChatStore } from "../chat/useChat";
import { BOTTOM_H, type LayoutState, type Yield } from "../layout/layout";
import type { ProjectStore } from "../store/project";
import { debugBus } from "../ui/debug";

/** 底栏 · 调试（M8-20，形制按设计侧第八轮 §二）。
 *
 *  **只横跨中间**（目录 + 详情），不横跨会话和右栏 ——
 *  会话的输入框要贴着窗口底部，右栏的属性面板要整列的高度。
 *  它挤掉的只是详情的高度，宽度不受影响，所以**不牵动 R2–R5 的让位**。
 *
 *  装什么按一条线分：**工具自己的状况**进，**这份文件的质量**不进。
 *  所以没有「体检明细」（诊断面板的事），也没有「AI 用量」（会话栏底部已经有）。
 */
type Tab = "output" | "tools" | "conn";

export function BottomBar({ layout, setLayout, store, chat, yieldNow, hasPanels }: {
  layout: LayoutState; setLayout: (l: LayoutState) => void; store: ProjectStore; chat: ChatStore;
  yieldNow: Yield; hasPanels: boolean;
}) {
  const [tab, setTab] = useState<Tab>("output");
  const snap = useSyncExternalStore(debugBus.subscribe, () => debugBus.out().length + debugBus.conn().length * 1000);
  void snap;   // 只用来触发重渲染

  /* WS 的每一次状态变化记一行 —— 断线重连是最常要回看的一段 */
  useEffect(() => { debugBus.wire("↓", "ws", store.wsState === "open" ? "已连接" : "断开"); }, [store.wsState]);
  useEffect(() => { const e = store.lastEvent; if (e) debugBus.wire("↓", e.type, typeof e.payload === "object" ? JSON.stringify(e.payload).slice(0, 120) : String(e.payload ?? "")); }, [store.lastEvent]);

  /** 工具调用从会话消息里抽 —— 这份数据本来就有，不必另建一套采集 */
  const tools = useMemo(() => {
    const rows: Array<{ name: string; args: string; ok: boolean }> = [];
    for (const m of chat.messages) {
      for (const c of m.toolCalls ?? []) rows.push({ name: c.function?.name ?? "?", args: (c.function?.arguments ?? "").slice(0, 120), ok: true });
    }
    return rows.slice(-200);
  }, [chat.messages]);

  const out = debugBus.out();
  const conn = debugBus.conn();
  const errCount = out.filter((o) => o.level === "error").length;
  const rows = tab === "output" ? out.length : tab === "tools" ? tools.length : conn.length;

  const drag = (e: React.MouseEvent) => {
    e.preventDefault();
    const y0 = e.clientY, h0 = layout.bottomHeight;
    const mv = (ev: MouseEvent) => setLayout({ ...layout, bottomHeight: Math.max(BOTTOM_H.min, Math.min(BOTTOM_H.max, Math.round(h0 - (ev.clientY - y0)))) });
    const up = () => { document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up); document.body.style.cursor = ""; };
    document.body.style.cursor = "row-resize";
    document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up);
  };

  return (
    <div data-ud="bottombar" className="shrink-0 flex flex-col border-t border-border bg-panel relative" style={{ height: layout.bottomHeight }}>
      {/* 拖上边缘改高；双击回默认 200 */}
      <div className="absolute -top-0.5 left-0 right-0 h-1 cursor-row-resize hover:bg-accent/30 z-10"
        onMouseDown={drag} onDoubleClick={() => setLayout({ ...layout, bottomHeight: BOTTOM_H.def })} />
      <div className="h-8 px-2 flex items-center gap-1 border-b border-border shrink-0 text-xs">
        {([["output", "输出"], ["tools", "工具调用"], ["conn", "连接"]] as const).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} aria-pressed={tab === id}
            className={`h-6 px-2 rounded-sm flex items-center gap-1.5 ${tab === id ? "bg-panel2 text-text font-semibold" : "text-muted hover:text-text"}`}>
            {label}
            {/* 输出页签上的数字：有 error 就报 error 条数并标红，没有就报总条数 */}
            {id === "output" && out.length > 0 && <span className={`text-[10px] font-mono ${errCount ? "text-err font-bold" : "text-muted"}`}>{errCount || out.length}</span>}
            {id === "tools" && tools.length > 0 && <span className="text-[10px] font-mono text-muted">{tools.length}</span>}
            {id === "conn" && <span className={`hdot ${store.wsState === "open" ? "ok" : "error"}`} />}
          </button>
        ))}
        <span className="flex-1" />
        {/* 布局读数**常驻在头部右边，不单开一页** —— 只有一行，单开一页太浪费；
            而且调布局时要一边拖一边看，切到别的页也得看得见（设计侧的理由） */}
        <span className="font-mono text-[11px] text-muted tabular-nums truncate max-w-[45%]" title="布局读数">{layoutReadout(layout, yieldNow, hasPanels)}</span>
        <button className="btn sm ghost shrink-0" onClick={() => { if (tab === "output") debugBus.clearOut(); else if (tab === "conn") debugBus.clearConn(); }}
          disabled={tab === "tools"} title={tab === "tools" ? "工具调用来自会话记录，清不了" : "只清当前这一页"}>清空</button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto font-mono text-[11px] leading-5 px-2 py-1">
        {rows === 0 && <div className="text-muted text-center py-6">{tab === "output" ? "没有输出" : tab === "tools" ? "这条会话还没调过工具" : "还没有事件"}</div>}
        {tab === "output" && out.slice().reverse().map((o, i) => (
          <div key={i} className="flex gap-2"><span className="text-muted shrink-0">{o.t}</span>
            <span className={`shrink-0 w-10 ${o.level === "error" ? "text-err font-semibold" : o.level === "warn" ? "text-warn" : "text-muted"}`}>{o.level}</span>
            <span className="flex-1 break-all">{o.text}</span></div>
        ))}
        {tab === "tools" && tools.slice().reverse().map((t, i) => (
          <div key={i} className="flex gap-2"><span className="text-accent shrink-0">{t.name}</span><span className="text-muted truncate">{t.args}</span></div>
        ))}
        {tab === "conn" && <>
          <div className="text-muted mb-1">{store.wsState === "open" ? "已连接" : "断开"} · {conn.length} 条事件</div>
          {conn.slice().reverse().map((c, i) => (
            <div key={i} className="flex gap-2"><span className="text-muted shrink-0">{c.t}</span><span className="shrink-0">{c.dir}</span>
              <span className="text-text2 shrink-0 w-14">{c.type}</span><span className="flex-1 truncate text-muted">{c.detail}</span></div>
          ))}
        </>}
      </div>
    </div>
  );
}

/** 布局读数，格式照设计侧 S11 L1179 那一段 */
export function layoutReadout(l: LayoutState, y?: { treeInline: boolean; yielded: boolean; panelDrawer: boolean; detail: number }, hasPanels = true): string {
  const bits = [
    l.left ? `左 ${l.chatWidth}` : "左 关",
    y ? (y.treeInline ? `目录 ${l.tree.width}` : y.yielded ? "目录 让位" : "目录 收起") : (l.tree.open ? `目录 ${l.tree.width}` : "目录 收起"),
    y ? `详情 ${y.detail}` : null,
    !hasPanels ? "右 无" : !l.right ? "右 关" : y?.panelDrawer ? "右 抽屉" : "右 340",
  ];
  return bits.filter(Boolean).join(" · ");
}
