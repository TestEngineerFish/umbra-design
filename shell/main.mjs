/** Umbra Studio 桌面壳（M9-2）。doc/00 §五十 的做法：
 *  - 核心（server/dist）直接 import 进主进程：起 hub 服务 + 按需起项目服务；带 --mcp 时再把 stdio 交给 MCP（秘书 / 其它模型客户端就把这个可执行文件当 MCP server 起）
 *  - 体检走自带 Chromium：开一个隐藏窗口 + remote-debugging-port=0，把 DevTools 端口写进 UMBRASTUDIO_CDP（M9-3）
 *  - 单实例 / 菜单 / 最近项目 / 未落盘提示（上次没正常退出）
 *  前端只通过 preload 暴露的 window.umbraHost 碰壳（host adapter desktop 实现）。 */
import { app, BrowserWindow, Menu, dialog, shell, ipcMain, Notification, nativeTheme } from "electron";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** 核心根：开发时是仓库根（shell/..），打包后是 resources/core（electron-builder extraResources） */
const CORE_ROOT = app.isPackaged ? join(process.resourcesPath, "core") : join(HERE, "..");
const CORE_DIST = join(CORE_ROOT, "server", "dist");
const IS_MCP = process.argv.includes("--mcp");

app.setName("Umbra Studio");
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.commandLine.appendSwitch("remote-debugging-port", "0");
for (const f of ["disable-background-networking", "disable-component-update", "disable-sync", "no-first-run", "no-pings"]) app.commandLine.appendSwitch(f);

/** 未落盘提示的依据：启动写 session.json { cleanExit:false }，正常退出改 true；下次启动看到 false 就是被强杀过 */
const sessionFile = () => join(app.getPath("userData"), "session.json");
function readSession() { try { return JSON.parse(readFileSync(sessionFile(), "utf8")); } catch { return null; } }
function writeSession(v) { try { mkdirSync(dirname(sessionFile()), { recursive: true }); writeFileSync(sessionFile(), JSON.stringify(v)); } catch { /* 只读盘就算了 */ } }

let core = null;      // { hubStart, serveStart, buildProject, listRecentProjects, touchProject }
let hub = null;       // { url, port, token }
let mainWin = null;
let checkWin = null;
const pending = [];   // 主窗口还没 ready 时攒下来的宿主事件

function sendHost(ev) { if (mainWin && !mainWin.isDestroyed() && mainWin.webContents.isLoadingMainFrame() === false) mainWin.webContents.send("host:event", ev); else pending.push(ev); }

async function loadCore() {
  const mod = async (f) => import(pathToFileURL(join(CORE_DIST, f)).href);
  const serve = await mod("serve.js"); const project = await mod("project.js"); const workspace = await mod("workspace.js");
  core = { ...serve, ...project, ...workspace };
}

function cdpPortFromDevTools() {
  // Chromium 把它挑的端口写在 userData/DevToolsActivePort 第一行
  try { return Number(readFileSync(join(app.getPath("userData"), "DevToolsActivePort"), "utf8").split("\n")[0]) || null; } catch { return null; }
}

async function createCheckWindow() {
  checkWin = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { backgroundThrottling: false } });
  await checkWin.loadURL("about:blank#umbrastudio-check");   // 标记：核心 render.ts 按它找体检页（CDP_PAGE_MARK）
  const port = cdpPortFromDevTools();
  if (port) process.env.UMBRASTUDIO_CDP = `http://127.0.0.1:${port}`;
  return port;
}

async function recentSubmenu() {
  const list = core ? (await core.listRecentProjects()).recents.filter((r) => r.exists).slice(0, 10) : [];
  if (!list.length) return [{ label: "（还没有）", enabled: false }];
  return list.map((r) => ({ label: `${r.name}  ${r.dir}`, click: () => sendHost({ type: "open-dir", dir: r.dir }) }));
}
async function buildMenu() {
  const isMac = process.platform === "darwin";
  const tpl = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    { label: "文件", submenu: [
      { label: "打开目录…", accelerator: "CmdOrCtrl+O", click: async () => { const dir = await pickDirectory({ title: "打开目录" }); if (dir) sendHost({ type: "open-dir", dir }); } },
      { label: "最近打开", submenu: await recentSubmenu() },
      { type: "separator" },
      { label: "回到项目列表", accelerator: "CmdOrCtrl+Shift+H", click: () => sendHost({ type: "go-home" }) },
      ...(isMac ? [] : [{ type: "separator" }, { role: "quit", label: "退出" }]),
    ] },
    { label: "编辑", role: "editMenu" },
    { label: "视图", submenu: [{ role: "reload", label: "重新加载" }, { role: "toggleDevTools", label: "开发者工具" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }] },
    { label: "窗口", role: "windowMenu" },
    { label: "帮助", submenu: [{ label: "在浏览器里打开当前页", click: () => { if (mainWin) void shell.openExternal(mainWin.webContents.getURL()); } }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

async function pickDirectory(opts = {}) {
  const r = await dialog.showOpenDialog(mainWin ?? undefined, { title: opts.title ?? "选择目录", properties: ["openDirectory", "createDirectory"] });
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
}

function wireIpc() {
  ipcMain.handle("host:pickDirectory", (_e, opts) => pickDirectory(opts));
  ipcMain.handle("host:revealInFinder", (_e, p) => { shell.showItemInFolder(p); });
  ipcMain.handle("host:openExternal", (_e, url) => shell.openExternal(String(url)));
  ipcMain.handle("host:notify", (_e, n) => { if (Notification.isSupported()) new Notification({ title: n?.title ?? "Umbra Studio", body: n?.body ?? "" }).show(); });
  ipcMain.handle("host:setTitle", (_e, t) => { if (mainWin) mainWin.setTitle(t ? `${t} · Umbra Studio` : "Umbra Studio"); });
}

async function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600, title: "Umbra Studio", show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#13151a" : "#f6f7f9",
    webPreferences: { preload: join(HERE, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  mainWin.once("ready-to-show", () => mainWin.show());
  mainWin.webContents.on("did-finish-load", () => { while (pending.length) mainWin.webContents.send("host:event", pending.shift()); void buildMenu(); });
  mainWin.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: "deny" }; });
  await mainWin.loadURL(hub.url + "__app/home");
  mainWin.on("closed", () => { mainWin = null; });
}

app.on("second-instance", () => { if (mainWin) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.focus(); } });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (!mainWin && hub) void createMainWindow(); });
app.on("before-quit", () => { writeSession({ cleanExit: true, at: new Date().toISOString() }); });

app.whenReady().then(async () => {
  const prev = readSession();
  writeSession({ cleanExit: false, at: new Date().toISOString() });
  await loadCore();
  hub = await core.hubStart();
  wireIpc();
  await createMainWindow();            // 主窗口先出来，体检用的隐藏窗口随后开（它只是 CDP 的宿主）
  const cdp = await createCheckWindow();
  process.stderr.write(`[shell] hub ${hub.url} · cdp ${cdp ?? "(none)"} · core ${CORE_ROOT}\n`);
  if (IS_MCP) {
    // 把 stdio 交给 MCP：核心的 index.js 在 import 时就接上 StdioServerTransport（doc/00 §五十）
    await import(pathToFileURL(join(CORE_DIST, "index.js")).href);
  }
  if (prev && prev.cleanExit === false) sendHost({ type: "dirty-restart", at: prev.at ?? null });
  if (process.env.UMBRASTUDIO_AUTOTEST_LOG) {
    // 壳内自测：把关键读数写一行，Playwright _electron 之外的最低限度证据
    try { writeFileSync(process.env.UMBRASTUDIO_AUTOTEST_LOG, JSON.stringify({ hub: hub.url, cdp, coreRoot: CORE_ROOT, packaged: app.isPackaged, electron: process.versions.electron }) + "\n", { flag: "a" }); } catch { /* ignore */ }
  }
});
