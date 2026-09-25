import { timeAgo } from "../../api/types";
import { useMdDoc } from "./doc";
import { frontSummary } from "./parse";

/** `.md` 的详情区（S13 形制）。**只管画** —— 开关在 `Toolbar`，状态在 `doc.tsx`。
 *
 *  - 渲染 / 源码两档。frontmatter 在渲染视图里**收成一行元数据**，点一下看原文 ——
 *    大多只有两三个键，做成表格是浪费；也不隐藏，因为 status 这类键人是会看的。
 *  - 源码是带行号的可编辑文本框。**行号从文件第一行数起，frontmatter 计入**
 *    （设计侧问的第一件，我们定的口径：和大纲、会话里的 `L9–12` 同一个坐标系）。
 *  - 落盘走 `file_write`（第二条写入口）：带上读到时的 sha256，盘上被别人改过就拒绝。
 *
 *  渲染走 `ui/markdown.ts` 那一份共用实例 —— 打进 app 的构建产物，不从 CDN 取，断网照常（H2）。
 */
export function MdView() {
  const d = useMdDoc();
  return (
    <div className="flex-1 min-w-0 flex flex-col bg-bg min-h-0">
      {/* 未落盘横条**留在视图里**，不进工具栏：它是一条状态提示，
          而工具栏那一行装的是开关。混在一起的话，横条一出现工具栏就会跳。 */}
      {d.dirty && (
        <div className="h-9 px-3 flex items-center gap-2 shrink-0 border-b" style={{ background: "var(--tool-warn-soft)", borderColor: "var(--tool-warn-border)", color: "var(--tool-warn)" }}>
          <span className="text-xs">还没落盘 · {d.diffNote}</span>
          <span className="flex-1" />
          <button className="btn sm ghost" onClick={d.discard}>放弃</button>
          <button className="btn sm primary" disabled={d.busy} onClick={() => void d.save()}>{d.busy ? "正在落盘…" : "落盘 ⌘S"}</button>
        </div>
      )}
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 overflow-auto">
          {d.mode === "render" ? (
            <article className="mx-auto max-w-[760px] px-8 py-6">
              {d.front !== null && (
                <div className="mb-5 rounded border border-border bg-panel2 text-[11px]">
                  <button className="w-full flex items-center gap-2 px-3 h-8 text-left" onClick={() => d.setFmOpen(!d.fmOpen)}>
                    <span className="font-mono text-muted uppercase tracking-wide">frontmatter</span>
                    {!d.fmOpen && <span className="font-mono truncate">{frontSummary(d.front)}</span>}
                    <span className="flex-1" /><span className="text-muted">{d.fmOpen ? "收起" : "看原文"}</span>
                  </button>
                  {d.fmOpen && <pre className="px-3 pb-3 font-mono whitespace-pre-wrap text-text2">{d.front}</pre>}
                </div>
              )}
              <div className="md-body" dangerouslySetInnerHTML={{ __html: d.html }} />
            </article>
          ) : (
            <div className="flex font-mono text-[12.5px] leading-6 min-h-full">
              <div className="select-none text-right text-muted px-3 py-3 bg-panel border-r border-border shrink-0">
                {d.text.split("\n").map((_, i) => <div key={i} className={d.sel && i + 1 >= d.sel.from && i + 1 <= d.sel.to ? "text-accent font-semibold" : ""}>{i + 1}</div>)}
              </div>
              <textarea ref={d.area} data-md-source="1" value={d.text} onChange={(e) => d.setText(e.target.value)} onBlur={() => void d.save()} spellCheck={false}
                className="flex-1 min-w-0 px-3 py-3 bg-bg outline-none resize-none leading-6" style={{ minHeight: "100%" }} />
            </div>
          )}
        </div>
      </div>
      {d.snapOpen && (
        <div className="fixed inset-0 z-40 bg-black/20" onMouseDown={(e) => { if (e.target === e.currentTarget) d.setSnapOpen(false); }}>
          <div className="absolute left-1/2 top-24 -translate-x-1/2 w-[352px] max-h-[420px] flex flex-col rounded-lg border border-border bg-panel shadow-2xl text-xs">
            <header className="h-9 px-3 flex items-center gap-2 border-b border-border shrink-0"><span className="font-semibold">版本历史</span><span className="text-muted">{d.snaps ? `${d.snaps.length} 版` : "读取中…"}</span><span className="flex-1" /><button className="ib" onClick={() => d.setSnapOpen(false)}>×</button></header>
            <div className="flex-1 overflow-auto">
              {(d.snaps ?? []).slice().reverse().map((s, i) => (
                <div key={s.version} className="px-3 py-2 flex items-center gap-2 border-b border-border last:border-0">
                  <span className="font-mono font-semibold">{s.version}</span><span className="text-muted">{s.src}</span><span className="text-muted">{timeAgo(s.at)}</span>
                  <span className="flex-1 truncate text-text2">{s.note ?? ""}</span>
                  {i === 0 ? <span className="text-accent font-semibold">当前</span> : <button className="btn sm" onClick={() => void d.revert(s.version)}>回到这一版</button>}
                </div>
              ))}
              {d.snaps && d.snaps.length === 0 && <div className="p-3 text-muted">还没有快照 —— 这个文件没经这里改过。</div>}
            </div>
            <footer className="px-3 py-2 border-t border-border text-muted leading-relaxed shrink-0">回到旧版时，当前内容会先存成新快照，不会丢。</footer>
          </div>
        </div>
      )}
    </div>
  );
}
