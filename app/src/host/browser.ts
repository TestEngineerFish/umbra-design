import type { HostAdapter, HostCapability } from "./types";

/** 浏览器宿主：能做的走本地 API，做不了的说清原因（doc/12 M7-3「不可用的按钮说明原因」） */
export function createBrowserHost(api: { post: (route: string, body: unknown) => Promise<{ ok: boolean; errors?: { message: string }[] }> }): HostAdapter {
  const NO_DIALOG: HostCapability = { ok: false, why: "浏览器里没有目录选择框：把目录路径粘进输入框即可" };
  return {
    kind: "browser",
    async pickDirectory() { return null; },
    async revealInFinder(path) {
      const r = await api.post("reveal_dir", { dir: path });
      if (!r.ok) throw new Error(r.errors?.[0]?.message ?? "打不开目录");
    },
    async openExternal(url) { window.open(url, "_blank", "noopener"); },
    async notify(n) {
      try {
        if ("Notification" in window && Notification.permission === "granted") { new Notification(n.title, { body: n.body }); return; }
      } catch { /* 无权限就落到页面内提示 */ }
      window.dispatchEvent(new CustomEvent("ud-toast", { detail: n }));
    },
    setTitle(title) { document.title = title ? `${title} · Umbra Studio` : "Umbra Studio"; },
    capabilities() {
      return {
        pickDirectory: NO_DIALOG,
        revealInFinder: { ok: true, why: "由核心在本机执行 open / explorer / xdg-open" },
        openExternal: { ok: true },
        notify: { ok: "Notification" in window, why: "浏览器通知要先授权；没授权就显示在页面里" },
        setTitle: { ok: true },
      };
    },
  };
}
