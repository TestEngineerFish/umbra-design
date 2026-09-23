/* 桌面宿主（Electron）的能力桥：把 host adapter 的 desktop 实现挂到 window.umbraHost。
   前端只认这个对象（app/src/host/index.ts），别处不许出现 Electron API。 */
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("umbraHost", {
  kind: "desktop",
  pickDirectory: (opts) => ipcRenderer.invoke("host:pickDirectory", opts ?? {}),
  revealInFinder: (path) => ipcRenderer.invoke("host:revealInFinder", path),
  openExternal: (url) => ipcRenderer.invoke("host:openExternal", url),
  notify: (n) => ipcRenderer.invoke("host:notify", n),
  setTitle: (title) => { void ipcRenderer.invoke("host:setTitle", title); },
  capabilities: () => ({
    pickDirectory: { ok: true }, revealInFinder: { ok: true }, openExternal: { ok: true },
    notify: { ok: true, why: "系统通知" }, setTitle: { ok: true },
  }),
  onEvent: (cb) => {
    const h = (_e, ev) => cb(ev);
    ipcRenderer.on("host:event", h);
    return () => ipcRenderer.removeListener("host:event", h);
  },
});
