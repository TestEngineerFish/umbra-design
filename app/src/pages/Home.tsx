import { useEffect, useState } from "react";
import type { Core } from "../api/client";
import { timeAgo, type ProjectRow } from "../api/types";
import type { HostAdapter } from "../host";
import { mem } from "../layout/layout";
import { toast } from "../ui/Toast";

/** 首页：项目列表（列表 / 网格、搜索、星标、最近打开、缩略图）+ 导入目录 + 新建项目（M6-6 平移） */
export function Home({ core, host, onOpen, onNewProject, onImport, onSettings, projectsVersion }: { core: Core; host: HostAdapter; onOpen: (dir: string) => void; onNewProject: () => void; onImport: () => void; onSettings: () => void; projectsVersion: number }) {
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [q, setQ] = useState(""); const [view, setView] = useState<"list" | "grid">(() => mem.get("us.homeView", "list"));
  const [stars, setStars] = useState<string[]>(() => mem.get("us.stars", [])); const [starOnly, setStarOnly] = useState(false);
  useEffect(() => { let alive = true; void core.get<{ projects: ProjectRow[] }>("projects").then((r) => { if (!alive) return; if (!r.ok) toast("读项目列表失败", r.errors?.[0]?.message, "error"); setProjects(r.data?.projects ?? []); }); return () => { alive = false; }; }, [core, projectsVersion]);
  const toggleStar = (dir: string) => { const s = stars.includes(dir) ? stars.filter((x) => x !== dir) : [...stars, dir]; setStars(s); mem.set("us.stars", s); };
  const pickView = (v: "list" | "grid") => { setView(v); mem.set("us.homeView", v); };
  let rows = (projects ?? []).filter((p) => !q || `${p.name} ${p.title} ${p.dir}`.toLowerCase().includes(q.toLowerCase()));
  if (starOnly) rows = rows.filter((p) => stars.includes(p.dir));
  rows = rows.slice().sort((a, b) => (b.lastOpened ?? "").localeCompare(a.lastOpened ?? "") || a.name.localeCompare(b.name));
  const reveal = (p: ProjectRow) => void host.revealInFinder(p.dir).catch((e: Error) => toast("打开目录失败", e.message, "error"));
  const Star = ({ p }: { p: ProjectRow }) => <button className={`ib ${stars.includes(p.dir) ? "text-warn" : ""}`} onClick={(e) => { e.stopPropagation(); toggleStar(p.dir); }} title={stars.includes(p.dir) ? "取消星标" : "星标"}>{stars.includes(p.dir) ? "★" : "☆"}</button>;
  const Thumb = ({ p }: { p: ProjectRow }) => <div className="bg-canvas text-muted text-[11px] grid place-items-center overflow-hidden h-full w-full">{p.thumb ? <img src={p.thumb} alt="" className="h-full w-full object-cover object-top" /> : p.missing ? "目录不在" : p.drafts ? `${p.drafts} 份稿` : "空项目"}</div>;
  return (
    <div className="h-full flex flex-col">
      <header className="h-11 px-4 flex items-center gap-3 border-b border-border bg-panel shrink-0">
        <span className="font-semibold text-sm">Umbra Studio</span><span className="flex-1" />
        <span className="text-[11px] text-muted mr-2">{host.kind === "desktop" ? "桌面" : "浏览器"}</span>
        <button className="btn ghost sm" onClick={onSettings}>外观</button>
        <button className="btn sm" onClick={onImport} title="选一个目录：已是项目就直接打开；只是一堆 .dc.html 就接管成新项目">导入目录</button>
        <button className="btn sm primary" onClick={onNewProject}>新建项目</button>
      </header>
      <main className="flex-1 overflow-auto"><div className="max-w-5xl mx-auto px-6 py-8">
        <div className="mb-6"><h1 className="text-xl font-semibold tracking-tight">项目</h1><p className="text-xs text-muted mt-1">本地目录工作台 · 稿存在自己电脑上</p></div>
        <div className="flex items-center gap-2 mb-4">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索项目" className="h-8 px-3 rounded border border-border bg-panel text-xs w-64 outline-none focus:border-accent" />
          <span className="flex-1" />
          <button className={`ib ${starOnly ? "text-warn" : ""}`} onClick={() => setStarOnly((s) => !s)} title="只看星标">{starOnly ? "★" : "☆"}</button>
          <div className="seg"><button className={view === "list" ? "on" : ""} onClick={() => pickView("list")}>列表</button><button className={view === "grid" ? "on" : ""} onClick={() => pickView("grid")}>网格</button></div>
        </div>
        {projects === null ? <div className="text-muted text-xs py-10 text-center">正在读项目列表…</div>
          : rows.length === 0 ? <div className="text-muted text-xs py-10 text-center leading-relaxed">{projects.length ? "没有匹配的项目" : <>还没有项目<br />「新建项目」从一个目录起步，或「导入目录」接管已有的稿件目录</>}</div>
          : view === "grid" ? (
            <ul className="grid grid-cols-2 lg:grid-cols-3 gap-3">{rows.map((p) => <li key={p.dir} className={`group rounded-lg border bg-panel cursor-pointer overflow-hidden hover:border-borderStrong ${p.current ? "border-accent" : "border-border"}`} onClick={() => onOpen(p.dir)}><div className="h-28"><Thumb p={p} /></div><div className="px-3 py-2 flex items-start gap-2"><div className="min-w-0 flex-1"><div className="text-sm font-semibold truncate" title={p.dir}>{p.name}</div><div className="text-[11px] text-muted truncate font-mono">{p.title && p.title !== p.name ? p.title : p.dir}</div></div><Star p={p} /></div></li>)}</ul>
          ) : (
            <div className="rounded-lg border border-border bg-panel overflow-hidden">
              <div className="grid grid-cols-[56px_minmax(0,1fr)_110px_72px_72px] items-center px-3 h-8 text-[11px] text-muted border-b border-border"><span /><span>名称</span><span>最近打开</span><span>稿件</span><span /></div>
              {rows.map((p) => <div key={p.dir} className={`grid grid-cols-[56px_minmax(0,1fr)_110px_72px_72px] items-center px-3 h-14 border-b border-border last:border-0 cursor-pointer hover:bg-hover group ${p.current ? "bg-accentSoft/40" : ""}`} onClick={() => onOpen(p.dir)} title={p.dir}>
                <div className="w-11 h-9 rounded overflow-hidden border border-border"><Thumb p={p} /></div>
                <div className="min-w-0 pr-3"><div className="text-sm font-semibold truncate">{p.name}{p.title && p.title !== p.name && <span className="font-normal text-muted"> · {p.title}</span>}</div><div className="text-[11px] text-muted truncate font-mono">{p.dir}</div></div>
                <span className="text-[11px] text-muted">{p.lastOpened ? timeAgo(p.lastOpened) : "—"}</span>
                <span className="text-[11px] text-muted">{p.missing ? <span className="text-err">找不到</span> : `${p.drafts ?? "—"} 份`}</span>
                <div className="flex justify-end gap-1 opacity-0 group-hover:opacity-100"><button className="ib" onClick={(e) => { e.stopPropagation(); reveal(p); }} title="在访达中显示">📁</button><Star p={p} /></div>
              </div>)}
            </div>
          )}
      </div></main>
    </div>
  );
}
