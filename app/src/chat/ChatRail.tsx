import { useEffect, useRef, useState } from "react";
import { History } from "./History";
import { SELECTION_ICON, type ChatMessage, type Selection, type ToolCall } from "../api/types";
import type { ChatStore } from "./useChat";
import { renderMd, renderMdInline } from "../ui/markdown";

/** 会话栏，形制按 S9：用户句右对齐；一个 AI 回合共用一根左栏，文本与工具行按出现顺序排；变更卡带回退；「已选中」药丸紧挨输入框上方 */
export function ChatRail({ chat, selections, onDropSelection, onClearSelections, contextLabel, onCollapse, onSwapSide, width, onResize, side }: { chat: ChatStore; selections: Selection[]; onDropSelection: (i: number) => void; onClearSelections: () => void; contextLabel: string | null; onCollapse: () => void; onSwapSide: () => void; width: number; onResize: (w: number) => void; side: "left" | "right" }) {
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { if (body.current) body.current.scrollTop = body.current.scrollHeight; }, [chat.messages, chat.notes, chat.running]);
  /* 状态行要一眼看出**现在谁在干活**。通道 B 光写「通道 B · sonnet」不够 ——
     真正动手的是 Codex 还是 Cursor 得说出来（2026-09-24 用户实测提的）。
     model 可能是空的（留空 = 用那个 CLI 自己的默认），空就不显示，不写「undefined」。 */
  const [history, setHistory] = useState(false);
  const [engineMenu, setEngineMenu] = useState(false);
  /* 顶栏显示的标题：当前这条会话的名字。列表里找得到就用列表的（它带着"用户起的还是我们猜的"），
     找不到（刚开的新会话还没进列表）就退回一句话。 */
  const curTitle = chat.sessions.find((x) => x.id === chat.sessionId)?.title || (chat.sessionId ? "这条会话" : "新会话");
  const cap = chat.caps?.[chat.channel];
  /* 状态行格式由设计侧第六轮定：**引擎名 · 模型（有的话）· 计费方式**。
     不再写「通道 A/B/C」—— 那个词对用户没有任何意义（他脱口而出的是「模式」）。
     引擎名由服务端给，前端不抄第二份映射表。 */
  const who = [cap?.engine ?? `通道 ${chat.channel.toUpperCase()}`, chat.model || null, cap?.billing]
    .filter(Boolean).join(" · ");
  const usage = chat.usage
    ? (chat.usage.totalCostUSD != null ? `${who} · $${Number(chat.usage.totalCostUSD).toFixed(3)}` : `${who} · ${(chat.usage.totalTokens ?? 0).toLocaleString()} tokens`)
    : who;
  return (
    <aside className="relative flex flex-col bg-panel border-border shrink-0 min-h-0" style={{ width }}>
      <Grip onResize={onResize} width={width} side={side} />
      <div className="h-11 px-3 flex items-center gap-2 border-b border-border shrink-0">
        {/* 入口就是标题（后面一个 ▾）—— 不另加「历史」按钮：顶栏已经有返回、新会话、引擎三样了 */}
        <button className="min-w-0 flex-1 text-left group" onClick={() => setHistory((h) => !h)} title={history ? "回到这条会话" : "看历史会话"}>
          <div className="text-sm font-semibold leading-4 flex items-center gap-1">
            {history ? <><span className="text-[11px]">‹</span>历史会话</> : <>
              <span className="truncate">{curTitle}</span>
              <span className="text-[10px] text-muted group-hover:text-accent shrink-0">▾</span>
            </>}
          </div>
          <div className="text-[11px] text-muted truncate">
            {history ? `${chat.sessions.length} 条` : (chat.sessionId ? `${who} · ${chat.messages.filter((m) => m.role === "user").length} 条` : "新会话")}
          </div>
        </button>
        {/* 引擎选择器。
            **不能三个平铺** —— 换成引擎名之后「DeepSeek / Claude Code / 火山方舟」加起来
            远超 380px 的会话栏，实测会把左边的标题挤成竖排一列（2026-09-24 截图抓到）。
            所以收成一个下拉：平时只显示当前引擎，点开按**谁在付钱**分组（设计侧第六轮 6.4 的分法）。
            ⚠️ 分组选择器的形制设计侧这一轮没画，这里是从简的临时实现，等它定稿再调。 */}
        <div className="relative shrink-0">
          <button data-ud="engine" className="btn sm ghost max-w-[130px] flex items-center gap-1" onClick={() => setEngineMenu((v) => !v)}
            title={cap?.billing ? `${cap.engine} · ${cap.billing}` : "选引擎"}>
            <span className="truncate">{cap?.engine ?? chat.channel.toUpperCase()}</span>
            <span className="text-[9px] text-muted shrink-0">▾</span>
          </button>
          {engineMenu && (
            <div className="absolute right-0 top-8 z-30 w-[220px] bg-panel border border-border rounded-lg shadow-2xl overflow-hidden text-xs">
              {(["b", "a", "c"] as const).map((c) => {
                const k = chat.caps?.[c];
                if (!k) return null;
                return (
                  <button key={c} className={`w-full text-left px-3 py-2 hover:bg-hover flex flex-col gap-0.5 ${chat.channel === c ? "bg-accentSoft" : ""}`}
                    onClick={() => { chat.pickChannel(c); setEngineMenu(false); }}>
                    <span className="flex items-center gap-1.5">
                      <span className={`font-semibold ${chat.channel === c ? "text-accent" : ""}`}>{k.engine ?? c.toUpperCase()}</span>
                      {k.model && <span className="text-muted font-mono text-[11px] truncate">{k.model}</span>}
                    </span>
                    <span className="text-[11px] text-muted">{k.group ?? ""}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <button className="ib" onClick={chat.newSession} title="新会话">＋</button>
        <button className="ib" onClick={onSwapSide} title="换边">⇄</button>
        <button className="ib" onClick={onCollapse} title="收成输入条">—</button>
      </div>
      {history ? <History chat={chat} onClose={() => setHistory(false)} /> : <>
      <div ref={body} className="flex-1 min-h-0 overflow-auto px-3 py-3 flex flex-col gap-3">
        {chat.messages.length === 0 && chat.notes.length === 0 && !chat.running && (
          <div className="m-auto text-center text-xs text-muted leading-relaxed px-4"><b className="text-text">直接说要改什么</b><br />比如「把这个按钮改成 danger 态」。<br />AI 走唯一写入口落盘，改动可审、可回退。{contextLabel ? "" : <><br />先选一个文件，AI 会优先看它。</>}</div>
        )}
        <Turns messages={chat.messages} />
        {chat.notes.map((n, i) => n.kind === "change" ? (
          <div key={i} className="rounded border border-border bg-panel2 px-3 py-2 text-xs flex items-center gap-2"><span className="flex-1 min-w-0">改了 <b>{n.path}</b> · {n.summary}（{n.from} → {n.to}）</span>{n.reverted ? <span className="text-muted">已回退</span> : <button className="btn sm" onClick={() => void chat.revert(i)}>回退到 {n.from}</button>}</div>
        ) : <div key={i} className="text-xs text-err px-1">{n.text}</div>)}
        {chat.running && <div className="flex gap-2"><span className="mt-1 w-2 h-2 rounded-full border border-accent border-r-transparent animate-spin shrink-0" /><span className="text-xs text-muted">正在读稿、调工具、落盘…</span></div>}
      </div>
      {selections.length > 0 && <Pills selections={selections} onDrop={onDropSelection} onClear={onClearSelections} />}
      </>}
      {/* 输入区在历史模式下也留着 —— 打字就等于「在当前这条会话里继续说」，不必先退出历史 */}
      <div className="px-3 pb-2 flex gap-2 items-end shrink-0">
        <textarea id="chatInput" rows={2} value={chat.input} onChange={(e) => chat.setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void chat.send(); } if (e.key === "Escape" && chat.running) void chat.interrupt(); }}
          placeholder={selections.length ? "对选中的说…（「这里字号大一点」）" : contextLabel ? (/^[\u4e00-\u9fa5]/.test(contextLabel) ? `对${contextLabel}说…` : `对 ${contextLabel} 说…`) : "输入消息… ⏎ 发送"} className="flex-1 min-h-[40px] max-h-40 px-3 py-2 rounded border border-border bg-bg text-xs outline-none focus:border-accent resize-y" />
        {chat.running ? <button className="btn danger" onClick={() => void chat.interrupt()}>中断</button> : <button className="btn primary" onClick={() => void chat.send()} disabled={!chat.input.trim()}>发送</button>}
      </div>
      <div className="px-3 h-6 flex items-center text-[11px] text-muted border-t border-border shrink-0"><span>{usage}</span><span className="flex-1" /><span>{chat.running ? "运行中" : chat.sessions.length ? `${chat.sessions.length} 个会话` : ""}</span></div>
    </aside>
  );
}

function Turns({ messages }: { messages: ChatMessage[] }) {
  const toolResults = new Map<string, string>();
  for (const m of messages) if (m.role === "tool" && m.toolCallId) toolResults.set(m.toolCallId, m.content);
  const out: JSX.Element[] = []; let turn: JSX.Element[] = [];
  const flush = (k: number) => { if (turn.length) out.push(<div key={"t" + k} className="flex gap-2"><span className="flex flex-col items-center shrink-0 pt-1.5"><span className="w-1.5 h-1.5 rounded-full bg-accent" /><span className="flex-1 w-px bg-border mt-1" /></span><div className="min-w-0 flex-1 flex flex-col gap-1.5">{turn}</div></div>); turn = []; };
  messages.forEach((m, i) => {
    if (m.role === "user") { flush(i); out.push(<div key={i} className="self-end max-w-[85%] rounded-lg bg-accent text-onAccent px-3 py-2 text-xs whitespace-pre-wrap">{m.content}</div>); }
    else if (m.role === "assistant") {
      /* AI 的回复按 Markdown 渲染 —— 模型本来就在用 `**粗体**`、列表、代码块说话，
         当纯文本显示等于把排版符号糊在脸上（2026-09-24 用户实测）。
         渲染器和样式都走全站那一份（`ui/markdown.ts` + `.md-body`），不在这儿另起一套。 */
      if (m.content) turn.push(<div key={i + "c"} className="md-body text-xs leading-relaxed" dangerouslySetInnerHTML={{ __html: renderMd(m.content) }} />);
      if (m.toolCalls?.length) turn.push(<div key={i + "t"} className="flex flex-col gap-0.5">{m.toolCalls.map((tc) => <ToolRow key={tc.id} tc={tc} raw={toolResults.get(tc.id)} />)}</div>);
    } else if (m.role === "system") { flush(i); out.push(<div key={i} className="text-[11px] text-muted md-body" dangerouslySetInnerHTML={{ __html: renderMdInline(m.content) }} />); }
  });
  flush(messages.length);
  return <>{out}</>;
}
function ToolRow({ tc, raw }: { tc: ToolCall; raw?: string }) {
  const name = tc.function?.name ?? "?"; let args = tc.function?.arguments ?? "";
  try { const o = JSON.parse(args) as Record<string, unknown>; delete o.project; args = Object.entries(o).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(", "); } catch { /* 原样 */ }
  let ok = true, res = "…";
  if (raw !== undefined) { try { const r = JSON.parse(raw) as { ok?: boolean; version?: string; written?: boolean; error?: string }; ok = r.ok !== false; res = ok ? (r.version ?? (r.written === false ? "未落盘" : "ok")) : (r.error ?? "error"); } catch { res = String(raw).slice(0, 40); } }
  return <div className={`grid grid-cols-[auto_minmax(0,1fr)_auto] gap-2 items-baseline text-[11px] font-mono ${ok ? "text-text2" : "text-err"}`} title={`${args}\n→ ${String(raw ?? "").slice(0, 400)}`}><span className="font-semibold">{name}</span><span className="truncate text-muted">{args}</span><span>{res}</span></div>;
}

/** 「已选中」药丸（S9 第五轮）：紧挨输入框上方，自动换行，每颗带 ×，两颗及以上多一个「全部清掉」 */
function Pills({ selections, onDrop, onClear }: { selections: Selection[]; onDrop: (i: number) => void; onClear: () => void }) {
  return (
    <div className="mx-3 mb-2 flex flex-wrap items-center gap-1 shrink-0">
      {selections.map((s, i) => (
        <span key={i} className="inline-flex items-center gap-1 h-6 pl-1.5 pr-1 rounded border border-accent bg-accentSoft text-[11px] max-w-full" title={s.detail}>
          <span className="text-accent shrink-0">{SELECTION_ICON[s.kind]}</span>
          <span className="font-mono font-semibold text-accent shrink-0">{s.kind}</span>
          <span className="truncate">{s.label}</span>
          <button className="ib w-4 h-4 text-[10px]" onClick={() => onDrop(i)} title="不带这一项">×</button>
        </span>
      ))}
      {selections.length > 1 && <button className="text-[11px] text-muted hover:text-text px-1" onClick={onClear}>全部清掉</button>}
    </div>
  );
}

/** 会话栏与预览之间那条可拖的线（S11 的 chatWidth）。
 *  ⚠️ 拖动时必须在整页盖一层遮罩：预览是 iframe，鼠标一进它的地盘，mousemove 就被 iframe 吃掉，
 *  父页面再也收不到 —— 宽度会卡在鼠标刚离开会话栏的那一刻【实测 2026-09-24】。 */
function Grip({ onResize, width, side }: { onResize: (w: number) => void; width: number; side: "left" | "right" }) {
  const [dragging, setDragging] = useState(false);
  const start = (e: React.MouseEvent) => {
    e.preventDefault();
    const x0 = e.clientX, w0 = width, dir = side === "right" ? -1 : 1;
    setDragging(true);
    const move = (ev: MouseEvent) => onResize(Math.max(300, Math.min(560, w0 + dir * (ev.clientX - x0))));
    const up = () => { setDragging(false); document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  };
  return (
    <>
      <div onMouseDown={start} className={`absolute top-0 bottom-0 ${side === "right" ? "left-0 -translate-x-1/2" : "right-0 translate-x-1/2"} w-1 z-20 cursor-col-resize hover:bg-accent/40`} title="拖动调整会话栏宽度" />
      {dragging && <div className="fixed inset-0 z-50 cursor-col-resize" />}
    </>
  );
}
