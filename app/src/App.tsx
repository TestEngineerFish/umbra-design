import { useEffect, useMemo, useState } from "react";
import { boot as readBoot, Core } from "./api/client";
import { getHost } from "./host";
import { Home } from "./pages/Home";
import { Workbench } from "./pages/Workbench";
import { Toasts, toast } from "./ui/Toast";

/** 页面只有两种：首页（项目列表）与工作台。路径：/__app/ 与 /__app/home。
 *  托管本页的核心属于某个项目（window.__UD_APP）；打开别的项目 = 让核心为它起服务并跳过去（open_project）。 */
export default function App() {
  const b = useMemo(readBoot, []);
  const [page, setPage] = useState<"home" | "work">(() => (location.pathname.endsWith("/home") ? "home" : "work"));
  const core = useMemo(() => (b ? Core.fromBoot(b) : null), [b]);
  const host = useMemo(() => (core ? getHost({ post: (r, body) => core.post(r, body) }) : null), [core]);
  useEffect(() => { history.replaceState(null, "", page === "home" ? "/__app/home" : "/__app/"); }, [page]);
  if (!b || !core || !host) return <div className="h-full flex items-center justify-center text-muted text-sm">这一页要由核心托管打开（npm --prefix server run ui -- &lt;项目&gt;），没有拿到启动数据。</div>;
  const open = async (dir: string) => {
    if (dir === b.dir) { setPage("work"); return; }
    const r = await core.post<{ app: string; url: string }>("open_project", { dir });
    if (!r.ok) { toast("打开项目失败", r.errors?.[0]?.message ?? "", "error"); return; }
    location.href = r.data!.app;
  };
  return (
    <>
      {page === "home" ? <Home core={core} host={host} onOpen={open} /> : <Workbench core={core} host={host} boot={b} onHome={() => setPage("home")} />}
      <Toasts />
    </>
  );
}
