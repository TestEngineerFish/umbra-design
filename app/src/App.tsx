import { useEffect, useMemo, useState } from "react";
import { boot as readBoot, Core, type ProjectHandle } from "./api/client";
import { getHost } from "./host";
import { Home } from "./pages/Home";
import { Workbench } from "./pages/Workbench";
import { Toasts, toast } from "./ui/Toast";

/** 两个核心句柄：hub（托管本页的服务，首页与全局路由走它）与 project（当前打开的项目自己的服务）。
 *  浏览器入口（npm run ui -- <项目>）时两者是同一个服务；桌面壳里 hub 不属于任何项目，项目服务由 open_project 按需起。 */
export default function App() {
  const b = useMemo(readBoot, []);
  const hub = useMemo(() => (b ? Core.fromBoot(b) : null), [b]);
  const host = useMemo(() => (hub ? getHost({ post: (r, body) => hub.post(r, body) }) : null), [hub]);
  const [project, setProject] = useState<ProjectHandle | null>(() => (b && b.name && b.dir ? { url: b.url, token: b.token, ws: b.ws, name: b.name, title: b.title ?? b.name, dir: b.dir } : null));
  const [page, setPage] = useState<"home" | "work">(() => (location.pathname.endsWith("/home") || !(b && b.name) ? "home" : "work"));
  const projectCore = useMemo(() => (project ? new Core(project.url, project.token, project.ws) : null), [project]);
  useEffect(() => { history.replaceState(null, "", page === "home" ? "/__app/home" : "/__app/"); }, [page]);
  const open = async (dir: string) => {
    if (!hub) return;
    if (project && dir === project.dir) { setPage("work"); return; }
    const r = await hub.post<ProjectHandle & { app: string }>("open_project", { dir });
    if (!r.ok || !r.data) { toast("打开项目失败", r.errors?.[0]?.message ?? "", "error"); return; }
    setProject({ url: r.data.url, token: r.data.token, ws: r.data.ws, name: r.data.name, title: r.data.title, dir: r.data.dir });
    setPage("work");
  };
  useEffect(() => host?.onEvent?.((e) => {
    if (e.type === "open-dir") void open(e.dir);
    if (e.type === "go-home") setPage("home");
    if (e.type === "dirty-restart") toast("上次没有正常退出", "如果当时有没落盘的改动，请在稿的版本历史里核对一下", "error");
  }), [host]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!b || !hub || !host) return <div className="h-full flex items-center justify-center text-muted text-sm">这一页要由核心托管打开（npm --prefix server run ui -- &lt;项目&gt;），没有拿到启动数据。</div>;
  return (
    <>
      {page === "home" || !project || !projectCore
        ? <Home core={hub} host={host} onOpen={open} />
        : <Workbench core={projectCore} host={host} boot={project} onHome={() => setPage("home")} />}
      <Toasts />
    </>
  );
}
