import { useEffect, useRef } from "react";
import type { Picked, SourceData } from "../../api/types";
import type { ProjectStore } from "../../store/project";
import { useDc } from "./bridge";

/** 画布：S2 嵌入壳 iframe（编辑）/ 稿本身（预览）/ 源码只读。
 *  **工具栏不在这里** —— 第七轮把它搬到了统一那条横带（`index.tsx` 的 `Toolbar`）。
 *  iframe 只在换稿 / 换档时重建；其它状态变化不碰它
 *  （就地编辑的内层 iframe 会被卸掉，`00` §四十三 踩过）。 */
export function DcView({ store, picked }: { store: ProjectStore; picked: Picked | null }) {
  const d = useDc();
  const note = d.shell.editHint || d.shell.checkNote || (d.shell.apiErr ? "出错：" + d.shell.apiErr : "") || (d.shell.busy ? "落盘中…" : "");
  return (
    <div className="flex-1 min-w-0 flex flex-col bg-canvas relative">
      {/* 画布的临时提示（就地编辑中 / 体检结果 / 出错）贴在画布顶上，不占工具栏那一行 ——
          它是一条会来会走的状态，混进工具栏会让开关跟着跳 */}
      {note && <div className="h-7 px-3 flex items-center text-[11px] text-accent bg-panel border-b border-border shrink-0 truncate" title={note}>{note}</div>}
      {d.mode === "code"
        ? <CodeView src={store.source && store.source.file === d.file ? store.source : null} picked={picked} />
        : (
          <div className="flex-1 min-h-0 relative">
            <iframe ref={d.frame} key={d.src} src={d.src} title={d.file} data-shell={d.mode === "shell" ? "1" : undefined}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              className="absolute inset-0 w-full h-full border-0 bg-panel" />
          </div>
        )}
      {d.present && <Present src={d.rawSrc} onStop={() => d.setPresent(false)} />}
    </div>
  );
}

function CodeView({ src, picked }: { src: SourceData | null; picked: Picked | null }) {
  const hit = useRef<HTMLTableRowElement>(null);
  useEffect(() => { hit.current?.scrollIntoView({ block: "center" }); }, [src, picked]);
  if (!src) return <div className="flex-1 flex items-center justify-center text-muted text-xs">正在读源码…</div>;
  const needle = picked?.node ? `data-ud-node="${picked.node}"` : null;
  return (
    <div className="flex-1 min-h-0 overflow-auto bg-panel font-mono text-[11.5px] leading-5" title={`${src.file} · ${src.lines} 行 · ${src.bytes} 字节 · 只读`}>
      <table className="border-collapse w-full"><tbody>{src.source.split("\n").map((line, i) => { const h = !!needle && line.includes(needle); return <tr key={i} ref={h ? hit : undefined} className={h ? "bg-accentSoft" : ""}><td className="select-none text-right pr-3 pl-3 text-muted w-12 align-top">{i + 1}</td><td className="whitespace-pre pr-4">{line || " "}</td></tr>; })}</tbody></table>
    </div>
  );
}

/** 演示全屏：只看稿，Esc 退出 */
function Present({ src, onStop }: { src: string; onStop: () => void }) {
  useEffect(() => {
    const el = document.getElementById("present");
    el?.requestFullscreen?.().catch(() => {});
    const on = () => { if (!document.fullscreenElement) onStop(); };
    document.addEventListener("fullscreenchange", on);
    return () => { document.removeEventListener("fullscreenchange", on); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); };
  }, [onStop]);
  /* 演示看的是**稿本身**，不是 S2 嵌入壳 —— 所以用 `rawSrc` 而不是 bridge 的 `src`
     （编辑态那份带 `embed=1`，演示时会把壳的 chrome 也放大出来） */
  return (
    <div id="present" className="fixed inset-0 z-50 bg-black">
      <iframe src={src} title="演示" className="w-full h-full border-0 bg-white" />
      <button className="btn sm absolute top-3 right-3 opacity-70 hover:opacity-100" onClick={onStop}>退出演示 Esc</button>
    </div>
  );
}
