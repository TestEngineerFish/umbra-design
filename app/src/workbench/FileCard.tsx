import { useEffect, useState } from "react";
import type { Core } from "../api/client";
import { timeAgo, type ReadFileResult } from "../api/types";
import type { HostAdapter } from "../host";
import { toast } from "../ui/Toast";
import { fmtSize } from "./DirView";

/** 通用文件卡（S15 形制，M8-5）：没有专用预览器的文件 —— 元数据 + 被谁引用 + 四个动作。
 *  一张居中卡片，最宽 520。禁用项的原因直接写在按钮下面，不藏在 hover 里。 */
export function FileCard({ core, host, path, onOpen }: { core: Core; host: HostAdapter; path: string; onOpen: (p: string, isDir: boolean) => void }) {
  const [info, setInfo] = useState<ReadFileResult | null>(null);
  const [refs, setRefs] = useState<Array<{ file: string; line: number }> | null>(null);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    setInfo(null); setRefs(null); setConfirm(false);
    void core.get<ReadFileResult>(`file?path=${encodeURIComponent(path)}`).then((r) => { if (r.ok && r.data) setInfo(r.data); });
    void core.get<{ referencedBy: Array<{ file: string; line: number }> }>(`file_refs?path=${encodeURIComponent(path)}`).then((r) => setRefs(r.data?.referencedBy ?? []));
  }, [core, path]);
  const cap = host.capabilities().revealInFinder;
  const name = path.split("/").pop() ?? path;
  const rename = async () => {
    const next = window.prompt("改成什么名字？", name);
    if (!next || next === name) return;
    const to = path.includes("/") ? `${path.slice(0, path.lastIndexOf("/"))}/${next}` : next;
    const r = await core.post<{ rewrote: Array<{ file: string }> }>("file_move", { from: path, to });
    if (!r.ok) { toast("改名失败", r.errors?.[0]?.message, "error"); return; }
    const n = r.data?.rewrote.length ?? 0;
    toast(`已改名为 ${next}`, n ? `顺带改了 ${n} 份稿里的引用` : undefined, "ok");
    onOpen(to, false);
  };
  const del = async () => {
    const r = await core.post("file_trash", { path });
    if (r.ok) { toast(`${name} 已移到回收站`, "在项目设置的回收站里能找回", "ok"); onOpen(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "", true); }
    else toast("删除失败", r.errors?.[0]?.message, "error");
  };
  return (
    <div className="flex-1 min-w-0 overflow-auto bg-bg grid place-items-center p-6">
      <div className="w-[520px] max-w-full rounded-lg border border-border bg-panel overflow-hidden text-xs">
        <div className="flex items-center gap-3 p-4 border-b border-border">
          <span className="w-11 h-11 rounded border border-border grid place-items-center text-xl text-muted shrink-0">▢</span>
          <div className="min-w-0"><div className="text-base font-semibold truncate">{name}</div><div className="font-mono text-muted truncate">{info?.kind === "other" ? guessMime(name) : info?.kind ?? "…"}</div></div>
        </div>
        <dl className="grid grid-cols-[60px_minmax(0,1fr)] gap-x-3 gap-y-2 p-4 border-b border-border">
          <dt className="text-muted">大小</dt><dd className="font-mono">{info ? fmtSize(info.size) : "…"}</dd>
          <dt className="text-muted">修改</dt><dd>{info ? `${new Date(info.updatedAt).toLocaleString()}（${timeAgo(info.updatedAt)}）` : "…"}</dd>
          <dt className="text-muted">位置</dt><dd className="font-mono break-all">{path}</dd>
        </dl>
        <div className="p-4 border-b border-border">
          <div className="flex items-center gap-2 mb-1"><span className="text-muted">被引用</span><span className="font-mono">{refs?.length ?? "…"}</span></div>
          {refs && refs.length === 0 && <p className="text-muted leading-relaxed">没有稿件引用它，改名、移动、删除都不影响任何稿。</p>}
          {refs && refs.length > 0 && <>
            <ul className="flex flex-col gap-1 mb-2">{refs.map((r, i) => <li key={i}><button className="font-mono text-accent hover:underline" onClick={() => onOpen(r.file, false)}>{r.file}:{r.line}</button></li>)}</ul>
            <p className="leading-relaxed" style={{ color: "var(--tool-warn)" }}>改名或移动会一并改写这些引用；删除会让它们变成 404。</p>
          </>}
        </div>
        <div className="p-4 flex flex-wrap items-start gap-2">
          <button className="btn sm" onClick={() => void rename()}>改名</button>
          <button className="btn sm" onClick={() => toast("移动", "在目录视图里选中它，用底部的「移动…」")}>移动</button>
          <div className="flex flex-col gap-1">
            <button className="btn sm" disabled={!cap.ok} onClick={() => void host.revealInFinder(path)}>在访达中显示</button>
            {!cap.ok && <span className="text-muted">{cap.why}</span>}
          </div>
          <span className="flex-1" />
          {confirm
            ? <span className="flex items-center gap-2"><span style={{ color: "var(--tool-warn)" }}>移到回收站？</span><button className="btn sm danger" onClick={() => void del()}>确认</button><button className="btn sm ghost" onClick={() => setConfirm(false)}>取消</button></span>
            : <button className="btn sm danger" onClick={() => setConfirm(true)}>删除</button>}
        </div>
      </div>
    </div>
  );
}

function guessMime(name: string): string {
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  const m: Record<string, string> = { zip: "application/zip", pdf: "application/pdf", mp4: "video/mp4", mov: "video/quicktime", woff2: "font/woff2", ttf: "font/ttf", csv: "text/csv" };
  return m[ext] ?? (ext ? `application/${ext}` : "未知类型");
}
