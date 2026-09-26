import { useCallback, useEffect, useMemo, useState } from "react";
import { boot as readBoot, Core, type ProjectHandle } from "./api/client";
import { getHost } from "./host";
import { applyTheme, loadLayout, saveLayout, type LayoutState } from "./layout/layout";
import { Home } from "./pages/Home";
import { NewProjectSheet, SettingsSheet } from "./sheets/Sheets";
import { Toasts, toast } from "./ui/Toast";
import { auditKindsOrThrow } from "./kinds";
import { loadPlugins } from "./kinds/plugin/loader";
import { Workbench } from "./workbench/Workbench";

/** 两个核心句柄：hub（托管本页的服务，首页与全局路由走它）与 project（当前项目自己的服务）。
 *  浏览器入口（npm run ui -- <项目>）时两者是同一个服务；桌面壳里 hub 不属于任何项目，项目服务由 open_project 按需起。 */
export default function App() {
  const b = useMemo(readBoot, []);
  const hub = useMemo(() => (b ? Core.fromBoot(b) : null), [b]);
  const host = useMemo(() => (hub ? getHost({ post: (r, body) => hub.post(r, body) }) : null), [hub]);
  const [project, setProject] = useState<ProjectHandle | null>(() => (b && b.name && b.dir ? { url: b.url, token: b.token, ws: b.ws, name: b.name, title: b.title ?? b.name, dir: b.dir } : null));
  const [page, setPage] = useState<"home" | "work">(() => (location.pathname.endsWith("/home") || !(b && b.name) ? "home" : "work"));
  const [layout, setLayoutRaw] = useState<LayoutState>(loadLayout);
  const [sheet, setSheet] = useState<{ kind: "newProject"; dir?: string } | { kind: "settings" } | null>(null);
  const [projectsVersion, bump] = useState(0);
  const setLayout = useCallback((l: LayoutState) => { setLayoutRaw(l); saveLayout(l); }, []);
  useEffect(() => { applyTheme(layout.theme); const mq = window.matchMedia("(prefers-color-scheme: dark)"); const on = () => applyTheme(layout.theme); mq.addEventListener("change", on); return () => mq.removeEventListener("change", on); }, [layout.theme]);
  useEffect(() => { history.replaceState(null, "", page === "home" ? "/__app/home" : "/__app/"); }, [page]);
  /* 插件接线（M11-5）。**装不上的要说出来** —— 静静不显示的话，
     用户只会看到「我装的插件不见了」，而他刚付过钱。
     `loadPlugins` 可以重复调（装完 / 卸完再调一次），内部按 id 去重。 */
  const wirePlugins = useCallback(() => {
    if (!hub) return;
    void loadPlugins(hub).then(({ off }) => {
      for (const x of off) toast(`插件 ${x.id} 没能接上`, x.why, "error");
      /* 插件接完线才自检 —— `md` 现在由内置插件认领，接线前查必然误报 */
      auditKindsOrThrow();
    });
  }, [hub]);
  useEffect(() => { wirePlugins(); }, [wirePlugins]);
  /* ⚠️ **装 / 切版本 / 卸完要当场重新接线**（M11-10）。
     不接这一句的话，服务端那边已经生效了，界面却要刷新页面才看得见 ——
     而用户刚点完「安装」，那一刻最不该让他刷新。 */
  useEffect(() => {
    if (!hub) return;
    return hub.events((e) => {
      if (e.type !== "plugin") return;
      const { what, id } = (e.payload ?? {}) as { what?: string; id?: string };
      wirePlugins();
      toast(`插件 ${id ?? ""} ${what === "uninstalled" ? "已卸载" : what === "switched" ? "已切换版本" : "已装好"}`, undefined, "ok");
    });
  }, [hub, wirePlugins]);
  const open = useCallback(async (dir: string) => {
    if (!hub) return;
    if (project && dir === project.dir) { setPage("work"); return; }
    const r = await hub.post<ProjectHandle & { app: string }>("open_project", { dir });
    if (!r.ok || !r.data) { toast("打开项目失败", r.errors?.[0]?.message ?? "", "error"); return; }
    setProject({ url: r.data.url, token: r.data.token, ws: r.data.ws, name: r.data.name, title: r.data.title, dir: r.data.dir });
    setPage("work"); bump((v) => v + 1);
  }, [hub, project]);
  /** 导入目录：已是项目直接开；只是一堆稿 / 空目录进新建面板接管 */
  const importDir = useCallback(async () => {
    if (!host || !hub) return;
    const dir = await host.pickDirectory({ title: "导入目录：已是项目就直接打开，否则接管为新项目" });
    if (!dir) { if (!host.capabilities().pickDirectory.ok) setSheet({ kind: "newProject" }); return; }
    const r = await hub.get<{ isProject: boolean }>("inspect_dir?dir=" + encodeURIComponent(dir));
    if (r.ok && r.data?.isProject) void open(dir); else setSheet({ kind: "newProject", dir });
  }, [host, hub, open]);
  useEffect(() => host?.onEvent?.((e) => {
    if (e.type === "open-dir") void (async () => { const r = await hub!.get<{ isProject: boolean }>("inspect_dir?dir=" + encodeURIComponent(e.dir)); if (r.ok && r.data?.isProject) void open(e.dir); else setSheet({ kind: "newProject", dir: e.dir }); })();
    if (e.type === "go-home") setPage("home");
    if (e.type === "dirty-restart") toast("上次没有正常退出", "如果当时有没落盘的改动，请在稿的版本历史里核对一下", "error");
  }), [host, hub, open]);
  if (!b || !hub || !host) return <div className="h-full flex items-center justify-center text-muted text-sm">这一页要由核心托管打开（npm --prefix server run ui -- &lt;项目&gt;），没有拿到启动数据。</div>;
  return (
    <>
      {page === "home" || !project
        ? <Home core={hub} host={host} onOpen={(d) => void open(d)} onNewProject={() => setSheet({ kind: "newProject" })} onImport={() => void importDir()} onSettings={() => setSheet({ kind: "settings" })} projectsVersion={projectsVersion} />
        : <Workbench key={project.dir} project={project} host={host} layout={layout} setLayout={setLayout} onHome={() => { setPage("home"); bump((v) => v + 1); }} onSettings={() => setSheet({ kind: "settings" })} />}
      {sheet?.kind === "newProject" && <NewProjectSheet hub={hub} host={host} initialDir={sheet.dir} onClose={() => setSheet(null)} onOpen={(d) => void open(d)} />}
      {sheet?.kind === "settings" && <SettingsSheet core={hub} projectUrl={page === "work" && project ? project.url : null} layout={layout} setLayout={setLayout} onClose={() => setSheet(null)} />}
      <Toasts />
    </>
  );
}
