import { useEffect, useState } from "react";
import type { Core } from "../api/client";
import type { HostAdapter } from "../host";
import { toast } from "../ui/Toast";

interface Proj { name: string; title: string; dir: string; drafts?: number; lastOpened?: string; missing?: boolean; thumb?: string | null }

/** 首页壳：项目列表 + 导入目录。功能与旧首页对齐的部分在 M7-5 平移；这里只搭形。 */
export function Home({ core, host, onOpen }: { core: Core; host: HostAdapter; onOpen: (dir: string) => void }) {
  const [projects, setProjects] = useState<Proj[] | null>(null);
  const [q, setQ] = useState("");
  const [dirInput, setDirInput] = useState("");
  useEffect(() => { void core.get<{ projects: Proj[] }>("projects").then((r) => setProjects(r.ok ? (r.data?.projects ?? []) : [])); }, [core]);
  const cap = host.capabilities().pickDirectory;
  const importDir = async () => {
    const picked = await host.pickDirectory({ title: "导入目录" });
    const dir = picked ?? dirInput.trim();
    if (!dir) { toast("导入目录", cap.why ?? "请填目录路径"); return; }
    onOpen(dir);
  };
  const rows = (projects ?? []).filter((p) => !q || `${p.name} ${p.title} ${p.dir}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="h-full flex flex-col">
      <header className="flex items-center gap-3 px-5 h-12 border-b border-border bg-panel">
        <span className="font-semibold text-sm">Umbra Studio</span>
        <span className="text-muted text-xs">目录工作台 · 新前端骨架（M7-2）</span>
        <span className="flex-1" />
        <span className="text-xs text-muted">宿主：{host.kind === "desktop" ? "桌面壳" : "浏览器"}</span>
      </header>
      <main className="flex-1 overflow-auto px-5 py-6 max-w-5xl w-full mx-auto">
        <div className="flex items-center gap-2 mb-5">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜项目名 / 路径…" className="h-8 px-3 rounded border border-border bg-panel text-xs w-64 outline-none focus:border-accent" />
          <span className="flex-1" />
          {cap.ok ? null : <input value={dirInput} onChange={(e) => setDirInput(e.target.value)} placeholder={cap.why} title={cap.why} className="h-8 px-3 rounded border border-border bg-panel text-xs w-80 outline-none focus:border-accent" />}
          <button onClick={importDir} className="h-8 px-3 rounded border border-border bg-panel text-xs hover:bg-hover">导入目录</button>
        </div>
        {projects === null ? <div className="text-muted text-xs">读取中…</div> : rows.length === 0 ? <div className="text-muted text-xs">还没有项目。用「导入目录」打开一个目录。</div> : (
          <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {rows.map((p) => (
              <li key={p.dir} className="group rounded-lg border border-border bg-panel hover:border-borderStrong cursor-pointer overflow-hidden" onClick={() => onOpen(p.dir)}>
                <div className="h-28 bg-canvas flex items-center justify-center text-muted text-xs">{p.thumb ? <img src={p.thumb} alt="" className="h-full w-full object-cover" /> : `${p.drafts ?? 0} 份稿`}</div>
                <div className="px-3 py-2">
                  <div className="flex items-center gap-2"><span className="font-semibold text-sm truncate">{p.name}</span>{p.title && p.title !== p.name && <span className="text-muted text-xs truncate">{p.title}</span>}</div>
                  <div className="flex items-center gap-2 mt-1 text-[11px] text-muted"><span className="truncate font-mono" title={p.dir}>{p.dir}</span><span className="flex-1" />
                    <button className="opacity-0 group-hover:opacity-100 hover:text-text" title="在访达中显示" onClick={(e) => { e.stopPropagation(); void host.revealInFinder(p.dir).catch((err) => toast("打开目录失败", String(err.message ?? err), "error")); }}>📁</button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
