import { useState } from "react";
import type { Core } from "../api/client";
import { HEALTH_LABEL, timeAgo, type Picked } from "../api/types";
import { PANEL_TITLE, type PanelId } from "../layout/layout";
import type { ProjectStore } from "../store/project";
import { toast } from "../ui/Toast";

/** 从属面板列（S11 第 1 题的定稿）：40 px 图标轨常驻 + 面板体，同一时刻只开一个；图片 / 目录整列不出现。
 *  属性面板是 Q30 过渡态：S2 自带的面板铺进这一格（Canvas 把 iframe 向右多铺 panelWidth），这里只画空框和提示。 */
const ICON: Record<PanelId, string> = { props: "⚙", diagnostics: "⚠", changes: "⟲", comments: "✎", outline: "≡", info: "ⓘ" };
export const PANEL_WIDTH = 340;

export function SidePanels({ core, store, file, picked, panels, active, setActive, narrow, onSendToAI }: {
  core: Core; store: ProjectStore; file: string; picked: Picked | null; panels: PanelId[]; active: PanelId | null; setActive: (p: PanelId | null) => void; narrow: boolean;
  onSendToAI: (text: string, picked: Picked) => void;
}) {
  const badge: Partial<Record<PanelId, number>> = { diagnostics: store.diags.filter((d) => d.level === "error" || d.level === "warning").length, comments: store.comments.filter((c) => !c.resolved).length };
  const body = active && (
    <section className={`bg-panel border-border flex flex-col min-h-0 ${narrow ? "fixed top-[86px] bottom-6 right-10 z-40 w-[320px] shadow-2xl border-l" : "shrink-0 border-l"}`} style={narrow ? undefined : { width: PANEL_WIDTH }}>
      <header className="h-9 px-3 flex items-center gap-2 border-b border-border text-xs font-semibold shrink-0">{PANEL_TITLE[active]}{badge[active] ? <span className="badge">{badge[active]}</span> : null}<span className="flex-1" /><button className="ib" onClick={() => setActive(null)} title="收起">›</button></header>
      <div className="flex-1 min-h-0 overflow-auto text-xs">
        {active === "props" && (picked ? null : <div className="p-4 text-muted leading-relaxed">开「点选」后点稿里的元素，属性在这里改（字面量直接改，洞会说明来源）。</div>)}
        {active === "diagnostics" && <Diagnostics store={store} />}
        {active === "changes" && <Changes core={core} store={store} file={file} />}
        {active === "comments" && <Comments core={core} store={store} file={file} onSendToAI={onSendToAI} />}
        {active === "info" && <Info store={store} file={file} />}
        {active === "outline" && <div className="p-4 text-muted">Markdown 大纲在 M8 随 `.md` 类型一起做。</div>}
      </div>
    </section>
  );
  return (
    <>
      {narrow && active && <div className="fixed inset-0 z-30 bg-black/20" onClick={() => setActive(null)} />}
      {body}
      <nav className="relative z-40 w-10 shrink-0 border-l border-border bg-panel flex flex-col items-center py-1 gap-0.5">
        {panels.map((p) => <button key={p} className={`relative w-8 h-8 rounded grid place-items-center text-sm ${active === p ? "bg-accentSoft text-accent" : "text-muted hover:text-text hover:bg-hover"}`} onClick={() => setActive(active === p ? null : p)} title={PANEL_TITLE[p]}>{ICON[p]}{badge[p] ? <span className={`absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-1 rounded-full text-[9px] font-semibold text-onAccent grid place-items-center ${p === "diagnostics" ? "bg-warn" : "bg-accent"}`}>{badge[p]}</span> : null}</button>)}
      </nav>
    </>
  );
}

function Diagnostics({ store }: { store: ProjectStore }) {
  if (!store.diags.length) return <div className="p-4 text-muted">暂无诊断 · 点「体检」跑一次 render_check</div>;
  return <ul className="divide-y divide-border">{store.diags.map((d, i) => <li key={i} className="px-3 py-2 flex flex-col gap-1"><div className="flex items-center gap-2"><span className={`lvl ${d.level}`}>{d.level}</span><span className="font-mono text-muted">{d.code}</span><span className="flex-1" />{d.line != null && <span className="font-mono text-muted">L{d.line}{d.col != null ? `:${d.col}` : ""}</span>}</div><div className="leading-relaxed">{d.message}</div>{d.fix && <div className="text-muted leading-relaxed">改法：{d.fix}</div>}</li>)}</ul>;
}
function Changes({ core, store, file }: { core: Core; store: ProjectStore; file: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const c = store.changes;
  if (!c) return <div className="p-4 text-muted">正在读…</div>;
  const versions = (c.versions ?? []).slice().reverse();
  const revert = async (v: string) => {
    setBusy(v);
    const r = await core.post<{ write?: { version?: string } }>("revert", { file, version: v });
    if (r.ok) { toast(`已退回 ${v}`, `历史不删，${r.data?.write?.version ?? "新一版"} 是回退版`, "ok"); void store.fetchChanges(file); void store.fetchDrafts(); } else toast("回退失败", r.errors?.[0]?.message, "error");
    setBusy(null);
  };
  return (
    <div className="flex flex-col">
      <div className="px-3 py-2 text-[11px] text-muted border-b border-border">最新一版与上一版的语义差异</div>
      {c.diff?.changes?.length ? <ul className="divide-y divide-border">{c.diff.changes.map((x, i) => <li key={i} className="px-3 py-2 flex gap-2"><span className="lvl info">{x.level ?? "变更"}</span><span className="font-mono text-muted">{x.at}</span><span className="flex-1">{x.message ?? `${x.target ?? ""} ${x.kind ?? ""}`.trim()}</span></li>)}</ul> : <div className="p-3 text-muted">只有一版，或还没有快照</div>}
      <div className="px-3 py-2 text-[11px] text-muted border-y border-border">版本历史 · {versions.length} 版</div>
      <ul className="divide-y divide-border">{versions.map((v, i) => { const m = c.versionMeta?.[v] ?? {}; return <li key={v} className="px-3 py-2 flex items-center gap-2"><span className="font-mono font-semibold">{v}</span><span className="text-muted">{m.src ?? ""}</span><span className="text-muted">{m.time ?? ""}</span><span className="flex-1 min-w-0 truncate text-text2" title={m.summary}>{m.summary ?? m.note ?? ""}</span>{i === 0 ? <span className="text-accent font-semibold">当前</span> : <button className="btn sm" disabled={!!busy} onClick={() => void revert(v)}>{busy === v ? "…" : "回退"}</button>}</li>; })}</ul>
    </div>
  );
}
function Comments({ core, store, file, onSendToAI }: { core: Core; store: ProjectStore; file: string; onSendToAI: (text: string, picked: Picked) => void }) {
  const upd = async (id: string, resolved: boolean) => { const r = await core.post("comment_update", { id, resolved }); if (!r.ok) toast("更新评论失败", r.errors?.[0]?.message, "error"); void store.fetchComments(file); };
  const del = async (id: string) => { const r = await core.post("comment_delete", { id }); if (!r.ok) toast("删除评论失败", r.errors?.[0]?.message, "error"); void store.fetchComments(file); };
  if (!store.comments.length) return <div className="p-4 text-muted leading-relaxed">这份稿还没有评论。开「点选」选中一个节点，属性面板底部可以留一句话。</div>;
  return <ul className="divide-y divide-border">{store.comments.map((c) => <li key={c.id} className={`px-3 py-2 flex flex-col gap-1 ${c.resolved ? "opacity-60" : ""}`}><div className="flex items-center gap-2"><span className={`lvl ${c.resolved ? "info" : "warning"}`}>{c.resolved ? "已处理" : "待处理"}</span><span className="font-mono text-muted truncate" title={c.node}>{c.tag ? `<${c.tag}>` : ""} {c.node}</span><span className="flex-1" /><span className="text-muted">{timeAgo(c.createdAt)}</span></div><div className={c.resolved ? "line-through" : ""}>{c.text}</div><div className="flex gap-1">{!c.resolved && <button className="btn sm" onClick={() => onSendToAI(c.text, { file: c.file, node: c.node, tag: c.tag ?? "" })} title="把这句话连同节点地址发给 AI（方式 ②）">发给 AI</button>}<button className="btn sm ghost" onClick={() => void upd(c.id, !c.resolved)}>{c.resolved ? "恢复" : "已处理"}</button><button className="btn sm ghost" onClick={() => void del(c.id)}>删除</button></div></li>)}</ul>;
}
function Info({ store, file }: { store: ProjectStore; file: string }) {
  const d = store.drafts.find((x) => x.file === file);
  if (!d) return <div className="p-4 text-muted">找不到稿件信息</div>;
  const rows: Array<[string, string]> = [["文件名", d.file], ["类型", d.kind === "component" ? "组件稿" : "页稿"], ["元素数", String(d.elements ?? "—")], ["版本", d.version ?? "—"], ["更新", timeAgo(d.updatedAt)], ["演示态", d.states.join(", ") || "—"], ["被谁引用", d.importedBy.join(", ") || "无"], ["引用了谁", d.imports.join(", ") || "无"], ["健康", `${HEALTH_LABEL[d.health]} · ${d.healthWhy || "—"}`]];
  return <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-2 p-3">{rows.map(([k, v]) => <><dt key={k + "k"} className="text-muted">{k}</dt><dd key={k + "v"} className="break-all">{v}</dd></>)}</dl>;
}
