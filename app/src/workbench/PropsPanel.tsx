import { useEffect, useRef, useState } from "react";
import type { Core } from "../api/client";
import type { Picked } from "../api/types";
import { toast } from "../ui/Toast";
import { shellCmd } from "./shell";

/** 属性面板（S7 形制，M7-7 从 S2 搬进 React）：三组 style / attr / text，行高 30，标签 96；
 *  数字行有单位与步进（px 1 / Shift 10，% 5 / 25，其余 0.1 / 1）、颜色行带色板（这份稿自己声明的 CSS 变量）；
 *  可改项边敲边预览（只改 iframe 里一张 style，不落盘），回车 / 失焦 / 步进才 set_prop；
 *  改完绿条三秒「已改 · v 上一版 → 新版 · 撤销」；失败留在那一行，能重试；地址失效让人回预览重点。 */
interface Slot { kind: "style" | "attr" | "text"; name: string; value: string; holes: string[]; editable: boolean; note: string; tag: string }
interface CssVar { name: string; value: string; resolved: string | null; token: string | null; isColor: boolean }
interface Located { file: string; node: string; tag: string; at: { line: number; col: number }; inList: boolean; slots: Slot[]; origins: Record<string, { kind?: string; where?: string; why?: string; summary?: string }>; auditSkipped: boolean; auditSkippedWhy: string | null }
const GROUP: Record<Slot["kind"], string> = { style: "样式", attr: "属性", text: "文案" };
const shapeOf = (v: string) => { const t = String(v).trim(); if (/^-?\d+(\.\d+)?(px|rem|em|%|vh|vw|ms|s)?$/.test(t)) return "number"; if (/^#[0-9a-fA-F]{3,8}$/.test(t) || /^(var\(--|rgb|hsl)/.test(t)) return "color"; return "plain"; };
const stepFor = (unit: string, shift: boolean) => unit === "px" ? (shift ? 10 : 1) : unit === "%" ? (shift ? 25 : 5) : (shift ? 1 : 0.1);
const splitNum = (v: string) => { const m = /^(-?\d+(?:\.\d+)?)\s*([a-z%]*)$/i.exec(String(v).trim()); return m ? { num: m[1]!, unit: (m[2] ?? "").toLowerCase() } : { num: String(v), unit: "" }; };
const joinNum = (num: string, unit: string) => { const t = String(num).trim(); return !unit || /[a-z%]$/i.test(t) ? t : t + unit; };

export function PropsPanel({ core, file, picked, onPicked, onWritten, writeTick }: { core: Core; file: string; picked: Picked | null; onPicked: (p: Picked | null) => void; onWritten: () => void; writeTick: string }) {
  const [loc, setLoc] = useState<Located | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [errs, setErrs] = useState<Record<string, { msg: string; value: string; retriable: boolean }>>({});
  const [saved, setSaved] = useState<{ from: string | null; to: string } | null>(null);
  const [vars, setVars] = useState<CssVar[]>([]);
  const savedT = useRef<number | null>(null);
  /* 同一行在途就不再发第二次。Enter 落盘时 input 会因为 disabled 自动失焦，
     onBlur 又调一次 commit —— 两个请求并发，后到的那个撞上已经变了的地址，报 400
     「没有地址为 … 的节点」，界面上凭空多出一条错【实测 2026-09-24】。 */
  const inFlight = useRef<Set<string>>(new Set());
  const pickedRef = useRef(picked); pickedRef.current = picked;

  /* 每次这份稿被写过（自己落盘、撤销、AI 改、外部编辑器）都重新定位一次。
     地址是内容哈希，稿一变就可能失效 —— 不重新问一次，面板上留着的是一份过期的值，
     下一次改会撞 400「没有地址为 … 的节点」【实测 2026-09-24：撤销之后再改就是这条】。
     真失效了就清掉选中并说清楚，不把坏状态留在界面上。 */
  useEffect(() => {
    setDrafts({}); setErrs({});
    if (!picked) { setLoc(null); return; }
    let alive = true;
    void core.get<Located>(`locate?file=${encodeURIComponent(picked.file)}&node=${encodeURIComponent(picked.node)}`).then((r) => {
      if (!alive) return;
      if (r.ok && r.data) { setLoc(r.data); return; }
      const msg = r.errors?.[0]?.message ?? "";
      setLoc(null);
      if (/没有地址为|地址是内容哈希/.test(msg)) { onPicked(null); toast("这份稿变了，刚才选中的节点地址失效", "回预览里重新点一下那个元素"); }
      else toast("定位失败", msg, "error");
    });
    return () => { alive = false; };
  }, [core, picked, writeTick]);   // eslint-disable-line react-hooks/exhaustive-deps
  /* 色板的候选只从**这份稿自己声明的 CSS 变量**来（`cssvars`），不按设计系统 token 路径拼
     —— 两套命名空间对不齐，拼出来的 var() 有一成多在这份稿里没定义，是静默失效的坏值（doc/00 §二十五）。 */
  useEffect(() => { void core.get<{ hits?: CssVar[] }>(`cssvars?file=${encodeURIComponent(file)}&limit=60`).then((r) => setVars(r.data?.hits ?? [])).catch(() => { /* 没有也能改，只是没候选 */ }); }, [core, file]);

  if (!picked) return <div className="p-4 text-muted leading-relaxed">开「点选」后点稿里的元素，属性在这里改（字面量直接改，洞会说明来源）。</div>;
  if (!loc) return <div className="p-4 text-muted">正在定位 {picked.node}…</div>;

  const key = (s: Slot) => `${s.kind}.${s.name}`;
  const real = (s: Slot) => s.value;
  const draftOf = (s: Slot) => drafts[key(s)] ?? real(s);
  const setDraft = (s: Slot, v: string) => { setDrafts((d) => ({ ...d, [key(s)]: v })); if (s.editable && s.kind === "style") shellCmd("preview-style", { prop: s.name, value: v }); };
  const discard = (s: Slot) => { setDrafts((d) => { const n = { ...d }; delete n[key(s)]; return n; }); shellCmd("clear-style"); };
  const apply = async (s: Slot, value: string) => {
    const k = key(s); const pk = pickedRef.current; if (!pk || inFlight.current.has(k)) return;
    inFlight.current.add(k);
    setBusy(k); setErrs((e) => { const n = { ...e }; delete n[k]; return n; });
    const prev = await core.get<{ versions?: string[] }>(`changes?file=${encodeURIComponent(pk.file)}`).catch(() => null);
    const prevVer = prev?.data?.versions?.length ? prev.data.versions[prev.data.versions.length - 1]! : null;
    const r = await core.post<{ newNode?: string; written?: boolean; write?: { version?: string } }>("set_prop", { file: pk.file, node: pk.node, kind: s.kind, name: s.name, value });
    inFlight.current.delete(k);
    setBusy(null);
    if (!r.ok) {
      const msg = r.errors?.[0]?.fix ?? r.errors?.[0]?.message ?? "没落下去";
      const stale = /地址是内容哈希|节点自己被改过|没有地址为/.test(msg);
      shellCmd("clear-style");
      setDrafts((d) => { const n = { ...d }; delete n[k]; return n; });
      setErrs((e) => ({ ...e, [k]: { msg: stale ? "这份稿在别处被改过，这个地址失效了 —— 回预览里重新点一下那个元素" : msg, value, retriable: !stale } }));
      return;
    }
    const next = { ...pk, node: r.data?.newNode ?? pk.node };
    setDrafts({});
    shellCmd("applied", { node: next.node });
    onPicked(next);
    const to = r.data?.write?.version ?? null;
    if (to) { setSaved({ from: prevVer, to }); if (savedT.current) window.clearTimeout(savedT.current); savedT.current = window.setTimeout(() => setSaved(null), 3000); }
    onWritten();
  };
  const undo = async () => {
    if (!saved?.from) return;
    const r = await core.post<{ write?: { version?: string } }>("revert", { file: picked.file, version: saved.from });
    if (r.ok) { toast(`已退回 ${saved.from}`, `${r.data?.write?.version ?? "新一版"} 是回退版`, "ok"); setSaved(null); onWritten(); shellCmd("applied", { node: picked.node }); } else toast("撤销失败", r.errors?.[0]?.message, "error");
  };
  const groups = (["style", "attr", "text"] as const).map((g) => ({ g, rows: loc.slots.filter((s) => s.kind === g) })).filter((x) => x.rows.length);
  return (
    <div className="flex flex-col text-xs">
      <div className="px-3 h-9 flex items-center gap-2 border-b border-border bg-panel2 shrink-0"><span className="font-mono text-muted truncate" title={`${loc.file} L${loc.at.line}:${loc.at.col}`}>{loc.file} L{loc.at.line} &lt;{loc.tag}&gt;</span>{loc.inList && <span className="lvl info" title="这个节点在 sc-for 里，改一处会影响同模板的每一行">列表</span>}<span className="flex-1" /><button className="ib" onClick={() => { shellCmd("clear"); onPicked(null); }} title="取消选中">×</button></div>
      {saved && <div className="px-3 h-8 flex items-center gap-2 border-b" style={{ background: "var(--tool-ok-soft)", borderColor: "var(--tool-ok-border)", color: "var(--tool-ok)" }}><span className="flex-1">已改 · {saved.from ?? "—"} → {saved.to}</span>{saved.from && <button className="btn sm" onClick={() => void undo()}>撤销</button>}</div>}
      {loc.auditSkipped && <div className="px-3 py-2 text-muted border-b border-border leading-relaxed">洞审计没做：{loc.auditSkippedWhy ?? ""}。能不能改只能给一半。</div>}
      {groups.map(({ g, rows }) => (
        <section key={g} className="border-b border-border">
          <header className="px-3 h-7 flex items-center gap-2 text-[11px] font-semibold"><span>{GROUP[g]}</span><span className="text-muted font-normal">{rows.length}</span></header>
          {rows.map((s) => <Row key={key(s)} slot={s} draft={draftOf(s)} pending={s.editable && draftOf(s) !== real(s)} busy={busy === key(s)} err={errs[key(s)]} vars={vars} origin={s.holes.map((h) => loc.origins[h]).filter(Boolean)} onDraft={(v) => setDraft(s, v)} onCommit={(v) => void apply(s, v)} onDiscard={() => discard(s)} onRetry={(v) => void apply(s, v)} />)}
        </section>
      ))}
      {!groups.length && <div className="p-4 text-muted">这个节点没有可列的属性。</div>}
    </div>
  );
}

function Row({ slot, draft, pending, busy, err, vars, origin, onDraft, onCommit, onDiscard, onRetry }: { slot: Slot; draft: string; pending: boolean; busy: boolean; err?: { msg: string; value: string; retriable: boolean }; vars: CssVar[]; origin: Array<{ kind?: string; where?: string; why?: string; summary?: string }>; onDraft: (v: string) => void; onCommit: (v: string) => void; onDiscard: () => void; onRetry: (v: string) => void }) {
  const shape = slot.editable ? shapeOf(slot.value) : "locked";
  const { unit } = splitNum(slot.value);
  const [why, setWhy] = useState(false);
  const colors = vars.filter((v) => v.isColor);
  const step = (dir: 1 | -1, shift: boolean) => { const p = splitNum(draft); const n = Number(p.num); if (!Number.isFinite(n)) return; const v = joinNum(String(Math.round((n + dir * stepFor(p.unit || unit, shift)) * 100) / 100), p.unit || unit); onDraft(v); onCommit(v); };
  const commit = () => { if (pending) onCommit(draft); };
  const keys = (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") { e.preventDefault(); commit(); } if (e.key === "Escape") onDiscard(); if (shape === "number" && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); step(e.key === "ArrowUp" ? 1 : -1, e.shiftKey); } };
  const inputCls = `h-6 px-2 rounded-sm border bg-bg outline-none focus:border-accent min-w-0 flex-1 font-mono ${pending ? "border-accent" : "border-border"}`;
  return (
    <div className="px-3 flex flex-col">
      <div className="min-h-[30px] flex items-center gap-2">
        <span className={`w-24 shrink-0 truncate font-mono ${slot.editable ? "text-text" : "text-muted"}`} title={slot.name}>{slot.name}</span>
        {shape === "locked" ? (
          <><span className="flex-1 min-w-0 truncate font-mono text-muted" title={slot.value}>{slot.value}</span>{slot.tag && <span className="lvl info shrink-0">{slot.tag}</span>}<button className="ib text-[10px]" onClick={() => setWhy((w) => !w)} title="为什么不能改">?</button></>
        ) : shape === "number" ? (
          <><input className={inputCls} value={splitNum(draft).num} onChange={(e) => onDraft(joinNum(e.target.value, unit))} onBlur={commit} onKeyDown={keys} disabled={busy} /><span className="text-muted w-7 shrink-0">{unit}</span><button className="ib text-[10px]" onClick={(e) => step(-1, e.shiftKey)} title="减（Shift 大步）">－</button><button className="ib text-[10px]" onClick={(e) => step(1, e.shiftKey)} title="加（Shift 大步）">＋</button></>
        ) : shape === "color" ? (
          <><span className="w-4 h-4 rounded-sm border border-border shrink-0" style={{ background: draft }} /><input className={inputCls} value={draft} list={`vars-${slot.name}`} onChange={(e) => onDraft(e.target.value)} onBlur={commit} onKeyDown={keys} disabled={busy} /><datalist id={`vars-${slot.name}`}>{colors.map((v) => <option key={v.name} value={`var(${v.name})`}>{v.token ? `${v.resolved ?? v.value} · ${v.token}` : (v.resolved ?? v.value)}</option>)}</datalist></>
        ) : (
          <input className={inputCls} value={draft} onChange={(e) => onDraft(e.target.value)} onBlur={commit} onKeyDown={keys} disabled={busy} />
        )}
        {busy && <span className="w-3 h-3 rounded-full border border-accent border-r-transparent animate-spin shrink-0" />}
      </div>
      {why && shape === "locked" && <div className="pb-2 text-muted leading-relaxed">{slot.note}{origin.map((o, i) => <div key={i}>来源：{o.kind ?? ""} {o.where ?? ""} {o.summary ?? o.why ?? ""}</div>)}</div>}
      {err && <div className="pb-2 flex items-center gap-2 text-err"><span className="flex-1 leading-relaxed">{err.msg}</span>{err.retriable && <button className="btn sm" onClick={() => onRetry(err.value)}>重试</button>}</div>}
    </div>
  );
}
