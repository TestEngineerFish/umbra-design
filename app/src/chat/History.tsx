import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatSessionRow } from "../api/types";
import type { ChatStore } from "./useChat";

/** 会话历史（M8-11，形制按设计侧第六轮 6.3）。
 *
 *  **入口是顶栏的会话标题**，点它整栏换成这个列表 —— 不另加「历史」按钮
 *  （顶栏已经有返回、新会话、引擎三样），也不做下拉浮层
 *  （380px 宽的栏里再叠一层下拉，能看的只剩一条窄缝）。
 *
 *  删除**不弹确认框**：行塌成一行「已删除 · 撤销」，离开列表时才真删。
 *  这和 S1 行内撤销是同一个口径 —— 破坏性操作给一步回头路，而不是先拦一道。
 */
const GROUPS = ["今天", "昨天", "本周", "更早"] as const;
type Group = typeof GROUPS[number];

function groupOf(iso?: string): Group {
  if (!iso) return "更早";
  const d = new Date(iso), now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (day(now) - day(d)) / 86400000;
  if (diff <= 0) return "今天";
  if (diff === 1) return "昨天";
  return diff < 7 ? "本周" : "更早";
}

/** 第二行的时间：今天给时:分，昨天给「昨天 时:分」，更早给「M 月 D 日」（设计侧口径） */
function when(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  const g = groupOf(iso);
  if (g === "今天") return hm;
  if (g === "昨天") return `昨天 ${hm}`;
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

export function History({ chat, onClose }: { chat: ChatStore; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [menu, setMenu] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  /** 已经塌成「已删除 · 撤销」的行；离开列表时才真删 */
  const [pendingDel, setPendingDel] = useState<string[]>([]);
  const pendRef = useRef<string[]>([]); pendRef.current = pendingDel;

  useEffect(() => { void chat.reloadSessions(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  /* 离开列表时把攒下的删除真正落实。**用 ref 取值** —— 卸载时 state 已经是旧闭包里的了。 */
  useEffect(() => () => { for (const id of pendRef.current) void chat.deleteSession(id); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return chat.sessions.filter((s) => !kw || s.title.toLowerCase().includes(kw));
  }, [chat.sessions, q]);

  const byGroup = useMemo(() => {
    const m = new Map<Group, ChatSessionRow[]>();
    for (const s of rows.slice().sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))) {
      const g = groupOf(s.updatedAt);
      m.set(g, [...(m.get(g) ?? []), s]);
    }
    return m;
  }, [rows]);

  const pick = (id: string) => { void chat.openSession(id); onClose(); };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* 搜索框只在条数多到翻不动时才出现 —— 少数几条时它只是噪声（设计侧：超过 8 条） */}
      {chat.sessions.length > 8 && (
        <div className="px-3 pt-2 shrink-0">
          <input value={q} onChange={(e) => setQ(e.target.value)} autoFocus placeholder="搜标题…"
            className="w-full h-8 px-2.5 rounded border border-border bg-bg outline-none focus:border-accent text-xs"
            onKeyDown={(e) => { if (e.key === "Escape") { if (q) setQ(""); else onClose(); } }} />
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-auto px-2 py-2">
        {rows.length === 0 && <div className="text-[11px] text-muted text-center py-8 leading-relaxed">{q ? "没有匹配的会话" : <>还没有会话<br />说一句话就开始了</>}</div>}
        {GROUPS.filter((g) => byGroup.has(g)).map((g) => (
          <div key={g} className="mb-2">
            <div className="px-1.5 py-1 text-[11px] text-muted">{g}</div>
            {byGroup.get(g)!.map((s) => {
              const cur = s.id === chat.sessionId;
              if (pendingDel.includes(s.id)) return (
                <div key={s.id} className="flex items-center gap-2 px-2 h-8 text-[11px] text-muted">
                  <span className="flex-1 truncate">已删除 · {s.title || s.id.slice(0, 12)}</span>
                  <button className="btn sm ghost" onClick={() => setPendingDel((p) => p.filter((x) => x !== s.id))}>撤销</button>
                </div>
              );
              return (
                <div key={s.id} className={`group relative rounded px-2 py-1.5 cursor-pointer ${cur ? "bg-accentSoft" : "hover:bg-hover"}`}
                  onClick={() => { if (editing !== s.id) pick(s.id); }}>
                  <div className="flex items-center gap-1.5">
                    {editing === s.id ? (
                      <input autoFocus defaultValue={s.title} className="flex-1 h-6 px-1.5 rounded border border-accent bg-bg outline-none text-xs"
                        onClick={(e) => e.stopPropagation()}
                        onBlur={(e) => { void chat.renameSession(s.id, e.target.value); setEditing(null); }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                          if (e.key === "Escape") { e.stopPropagation(); setEditing(null); }
                        }} />
                    ) : (
                      <span className={`truncate flex-1 text-xs ${cur ? "font-semibold" : ""} ${s.titled ? "" : "text-text2"}`}
                        title={s.id}>{s.title || "未命名"}</span>
                    )}
                    {cur && <span className="text-[10px] text-accent shrink-0">当前</span>}
                    {/* 「⋯」常驻、平时压到 55%，和 S12 的勾选框同一口径：hover 才出现的话键盘和触控都够不着 */}
                    <button className={`ib text-[11px] shrink-0 ${menu === s.id ? "" : "opacity-55"}`}
                      onClick={(e) => { e.stopPropagation(); setMenu(menu === s.id ? null : s.id); }} title="更多">⋯</button>
                  </div>
                  <div className="text-[11px] text-muted truncate pr-6">
                    {[s.channel === "b" ? (s.tool ?? "本机工具") : s.model, when(s.updatedAt), s.msgCount ? `${s.msgCount} 条` : ""].filter(Boolean).join(" · ")}
                  </div>
                  {menu === s.id && (
                    <div className="absolute right-1 top-7 z-20 w-28 bg-panel border border-border rounded shadow-2xl text-xs overflow-hidden" onClick={(e) => e.stopPropagation()}>
                      <button className="w-full text-left px-2.5 py-1.5 hover:bg-hover" onClick={() => { setEditing(s.id); setMenu(null); }}>重命名</button>
                      <button className="w-full text-left px-2.5 py-1.5 hover:bg-hover text-err" onClick={() => { setPendingDel((p) => [...p, s.id]); setMenu(null); }}>删除</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
