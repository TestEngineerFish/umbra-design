import { useEffect, useMemo, useState } from "react";
import type { Core } from "../api/client";
import { timeAgo, type FileEntry, type ListFilesResult } from "../api/types";
import { mem } from "../layout/layout";
import { toast } from "../ui/Toast";
import { kindDef } from "@shared/kinds";

/** 目录视图（S12 形制，M8-3 / M8-4）。
 *  默认列表；**非目录文件里图片 ≥ 60% 且 ≥ 6 张**时自动切网格，并在视图开关旁说明为什么是网格。
 *  手动切过一次，这个目录就记住手动的选择，不再自动判断（`viewByDir`，设计侧第五轮定的键名）。
 *  勾选框常驻（平时压到 55% 透明度）—— hover 才出现的话，键盘和触控都用不了。 */
const AUTO_MIN = 6, AUTO_SHARE = 0.6;
/* 名字和图标都问 `@shared/kinds` —— 以前这里、`FileTree` 里各有一张表，
   新加一种类型得记着改两处，漏一处的症状是「目录列表里有图标，树里是个 ▢」（M8-14）。 */

export function DirView({ core, dirRel, onOpen, onSelectionChange, selected }: {
  core: Core; dirRel: string; onOpen: (path: string, isDir: boolean) => void;
  onSelectionChange: (paths: string[]) => void; selected: string[];
}) {
  const [data, setData] = useState<ListFilesResult | null>(null);
  const [manual, setManual] = useState<Record<string, "list" | "grid">>(() => mem.get("us.viewByDir", {}));
  const [onlyDrafts, setOnlyDrafts] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => { setData(null); void core.get<ListFilesResult>(`files?dir=${encodeURIComponent(dirRel)}`).then((r) => { if (r.ok && r.data) setData(r.data); else toast("读目录失败", r.errors?.[0]?.message, "error"); }); }, [core, dirRel, tick]);

  const files = useMemo(() => (data?.entries ?? []).filter((e) => !e.isDir), [data]);
  const images = files.filter((e) => e.kind === "image").length;
  const auto: "list" | "grid" = images >= AUTO_MIN && files.length > 0 && images / files.length >= AUTO_SHARE ? "grid" : "list";
  const view = manual[dirRel] ?? auto;
  const autoNote = !manual[dirRel] && auto === "grid" ? `图片 ${images} / ${files.length} · 自动网格` : null;
  const setView = (v: "list" | "grid") => { const m = { ...manual, [dirRel]: v }; setManual(m); mem.set("us.viewByDir", m); };

  const rows = (data?.entries ?? []).filter((e) => !onlyDrafts || e.isDir || e.kind === "dc");
  const toggle = (path: string) => onSelectionChange(selected.includes(path) ? selected.filter((x) => x !== path) : [...selected, path]);
  const crumbs = dirRel ? dirRel.split("/") : [];
  const move = async () => {
    const to = window.prompt(`把这 ${selected.length} 项移到哪个目录？（相对项目根，留空 = 项目根）`, dirRel);
    if (to === null) return;
    const dest = to.replace(/^\/+|\/+$/g, "");
    let moved = 0, rewrote = 0;
    for (const path of selected) {
      const name = path.split("/").pop()!;
      const r = await core.post<{ rewrote: Array<{ file: string }> }>("file_move", { from: path, to: dest ? `${dest}/${name}` : name });
      if (r.ok) { moved++; rewrote += r.data?.rewrote.length ?? 0; } else toast(`${name} 没挪成`, r.errors?.[0]?.message, "error");
    }
    if (moved) toast(`挪了 ${moved} 项到 ${dest || "项目根"}`, rewrote ? `顺带改了 ${rewrote} 处引用` : undefined, "ok");
    onSelectionChange([]); setTick((t) => t + 1);
  };
  const del = async (path: string) => {
    const r = await core.post("file_trash", { path });
    if (r.ok) { toast(`${path} 已移到回收站`, undefined, "ok"); onSelectionChange([]); setTick((t) => t + 1); } else toast("删除失败", r.errors?.[0]?.message, "error");
  };

  return (
    <div className="flex-1 min-w-0 flex flex-col bg-bg min-h-0">
      <header className="h-10 px-3 flex items-center gap-2 border-b border-border bg-panel shrink-0 text-xs">
        <nav className="flex items-center gap-1 min-w-0">
          <button className="ib" onClick={() => onOpen("", true)} title="项目根">▤</button>
          {crumbs.map((c, i) => <span key={i} className="flex items-center gap-1 min-w-0"><span className="text-muted">/</span><button className={`truncate hover:text-accent ${i === crumbs.length - 1 ? "font-semibold" : "text-text2"}`} onClick={() => onOpen(crumbs.slice(0, i + 1).join("/"), true)}>{c}</button></span>)}
        </nav>
        <span className="text-muted">{data ? `${data.entries.length} 项` : ""}</span>
        <span className="flex-1" />
        {autoNote && <span className="text-muted">{autoNote}</span>}
        <div className="seg"><button className={!onlyDrafts ? "on" : ""} onClick={() => setOnlyDrafts(false)}>全部</button><button className={onlyDrafts ? "on" : ""} onClick={() => setOnlyDrafts(true)}>只看稿件</button></div>
        <div className="seg"><button className={view === "list" ? "on" : ""} onClick={() => setView("list")} title="列表">☰</button><button className={view === "grid" ? "on" : ""} onClick={() => setView("grid")} title="网格">▦</button></div>
      </header>
      <div className="flex-1 min-h-0 overflow-auto p-4">
        {!data ? <div className="text-muted text-xs text-center py-10">正在读目录…</div>
          : rows.length === 0 ? <div className="text-muted text-xs text-center py-10 leading-relaxed">{onlyDrafts ? "这一层没有设计稿" : <>这个目录是空的<br />用顶栏的「新建稿件」，或者把文件放进来</>}</div>
          : view === "grid" ? <Grid core={core} rows={rows} dirRel={dirRel} selected={selected} onToggle={toggle} onOpen={onOpen} />
          : <Table rows={rows} selected={selected} onToggle={toggle} onOpen={onOpen} />}
      </div>
      {selected.length > 0 && (
        <footer className="h-11 px-3 flex items-center gap-2 border-t border-border bg-panel shrink-0 text-xs">
          <span className="font-semibold">已选 {selected.length} 项</span>
          <span className="text-muted truncate min-w-0 flex-1">{selected.map((s) => s.split("/").pop()).join("、")}</span>
          <button className="btn sm ghost" onClick={() => onSelectionChange([])}>取消 Esc</button>
          <button className="btn sm ghost" onClick={() => void move()}>移动…</button>
          <button className="btn sm ghost danger" onClick={() => void Promise.all(selected.map(del))}>删除</button>
          <button className="btn sm primary" onClick={() => window.dispatchEvent(new CustomEvent("ud-send-files", { detail: selected }))}>带进会话</button>
        </footer>
      )}
    </div>
  );
}

function Table({ rows, selected, onToggle, onOpen }: { rows: FileEntry[]; selected: string[]; onToggle: (p: string) => void; onOpen: (p: string, d: boolean) => void }) {
  const any = selected.length > 0;
  return (
    <div className="rounded-lg border border-border bg-panel overflow-hidden">
      <div className="grid grid-cols-[32px_minmax(0,1fr)_84px_96px_104px_132px] gap-x-3 items-center h-8 px-3 text-[11px] text-muted border-b border-border"><span /><span>名称</span><span>类型</span><span className="text-right">大小</span><span>更新</span><span>读数</span></div>
      {rows.map((e) => (
        <div key={e.path} className={`grid grid-cols-[32px_minmax(0,1fr)_84px_96px_104px_132px] gap-x-3 items-center min-h-[44px] px-3 border-b border-border last:border-0 cursor-pointer hover:bg-hover ${selected.includes(e.path) ? "bg-accentSoft" : ""}`} onClick={() => onOpen(e.path, e.isDir)}>
          <input type="checkbox" checked={selected.includes(e.path)} onClick={(ev) => ev.stopPropagation()} onChange={() => onToggle(e.path)} className={`w-3.5 h-3.5 accent-[var(--tool-accent)] ${any ? "" : "opacity-55"}`} />
          <div className="min-w-0 pr-3 flex items-center gap-2">
            <span className={`shrink-0 ${e.kind === "dc" ? "text-accent" : "text-muted"}`}>{e.isDir ? kindDef("dir").icon : kindDef(e.kind).icon}</span>
            <div className="min-w-0"><div className="font-semibold truncate">{e.name}</div>{e.excerpt && <div className="text-[11px] text-muted truncate font-mono">{e.excerpt}</div>}</div>
          </div>
          <span className="text-muted">{kindDef(e.kind).label}</span>
          <span className="text-right font-mono text-muted">{e.isDir ? "—" : fmtSize(e.size)}</span>
          <span className="text-muted">{timeAgo(e.updatedAt)}</span>
          <span className="font-mono text-[11px] text-muted truncate">{reading(e)}</span>
        </div>
      ))}
    </div>
  );
}

function Grid({ core, rows, dirRel, selected, onToggle, onOpen }: { core: Core; rows: FileEntry[]; dirRel: string; selected: string[]; onToggle: (p: string) => void; onOpen: (p: string, d: boolean) => void }) {
  void dirRel;
  return (
    <ul className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
      {rows.map((e) => (
        <li key={e.path} className={`group relative rounded-lg border bg-panel overflow-hidden cursor-pointer hover:border-borderStrong ${selected.includes(e.path) ? "border-accent" : "border-border"}`} onClick={() => onOpen(e.path, e.isDir)}>
          <input type="checkbox" checked={selected.includes(e.path)} onClick={(ev) => ev.stopPropagation()} onChange={() => onToggle(e.path)} className={`absolute top-2 left-2 z-10 w-3.5 h-3.5 accent-[var(--tool-accent)] ${selected.length ? "" : "opacity-55"}`} />
          <div className="h-28 bg-canvas grid place-items-center overflow-hidden">
            {e.kind === "image" ? <img src={`${core.url}${e.path.split("/").map(encodeURIComponent).join("/")}`} alt="" className="max-h-full max-w-full object-contain" style={{ background: "repeating-conic-gradient(var(--tool-panel-2) 0 25%, transparent 0 50%) 50% / 16px 16px" }} />
              : e.kind === "md" ? <div className="p-3 text-[11px] text-muted leading-relaxed line-clamp-5 w-full">{e.excerpt || "（空）"}</div>
              : e.kind === "dc" ? <div className="w-full h-full" style={{ background: "repeating-linear-gradient(135deg, var(--tool-panel-2) 0 8px, var(--tool-panel) 8px 16px)" }} />
              : <div className="flex flex-col items-center gap-1 text-muted"><span className="text-2xl">{e.isDir ? kindDef("dir").icon : kindDef(e.kind).icon}</span><span className="text-[11px] font-mono uppercase">{e.isDir ? `${e.count ?? 0} 项` : (e.name.split(".").pop() ?? "")}</span></div>}
          </div>
          <div className="px-2.5 py-2"><div className="text-xs font-semibold truncate">{e.name}</div><div className="text-[11px] text-muted truncate font-mono">{e.isDir ? `${e.count ?? 0} 项` : reading(e) || fmtSize(e.size)}</div></div>
        </li>
      ))}
    </ul>
  );
}

/** 读数一列按类型换内容（S12）：稿是健康与版本，md 是快照号，图片是尺寸，目录是项数 */
function reading(e: FileEntry): string {
  if (e.isDir) return `${e.count ?? 0} 项`;
  if (e.kind === "image") return e.width && e.height ? `${e.width}×${e.height}` : "";
  if (e.snapshot) return `快照 ${e.snapshot}`;
  return "";
}
export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
