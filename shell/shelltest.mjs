import { _electron as electron } from "/Users/sam/Documents/SourceTree/Geek/UmbraStudio/server/node_modules/playwright-core/index.mjs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
const require = createRequire(import.meta.url);
const bin = require("/Users/sam/Documents/SourceTree/Geek/UmbraStudio/shell/node_modules/electron");
const S = process.env.S; const SHELL = "/Users/sam/Documents/SourceTree/Geek/UmbraStudio/shell";
const env = { ...process.env, UMBRASTUDIO_AUTOTEST_LOG: S + "/shell-autotest.log" };
const t0 = Date.now();
const mainWindow = async (app) => { for (let i = 0; i < 100; i++) { const w = app.windows().find(w => w.url().includes("__app")); if (w) return w; await new Promise(r => setTimeout(r, 200)); } throw new Error("主窗口没出来"); };
let app = await electron.launch({ executablePath: bin, args: [SHELL], env, cwd: SHELL });
let win = await mainWindow(app);
await win.waitForFunction(() => /最近打开|还没有项目/.test(document.body.innerText), null, { timeout: 30000 });
console.log("launch→home:", Date.now() - t0, "ms | projects:", await win.evaluate(() => document.querySelectorAll("li").length), "| host:", await win.evaluate(() => ({ kind: window.umbraHost?.kind, pick: window.umbraHost?.capabilities().pickDirectory.ok })));
console.log("windows:", await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), url: w.webContents.getURL().replace(/token=[^&]+/, "token=…").slice(0, 60) }))));
console.log("cdp env in main:", await app.evaluate(() => process.env.UMBRASTUDIO_CDP ?? null));
// 菜单「打开目录」→ 事件 → 前端 open_project
await app.evaluate(({ BrowserWindow }, dir) => { const w = BrowserWindow.getAllWindows().find(w => w.isVisible()); w.webContents.send("host:event", { type: "open-dir", dir }); }, S + "/umbra_copy");
await win.waitForFunction(() => /58 份稿/.test(document.body.innerText) && !/核心断开/.test(document.body.innerText), null, { timeout: 20000 }); await win.waitForTimeout(1500);
console.log("workbench:", await win.evaluate(() => document.querySelector("header")?.innerText.replace(/\s+/g, " ")));
// 体检：走项目自己的服务，主进程里 render_check 应经 CDP（UMBRASTUDIO_CDP 已设）
const r = await win.evaluate(async () => {
  // 从 React 状态拿不到句柄，直接用 hub 的 open_project 再拿一次 url/token（幂等）
  const hub = window.__UD_APP; const o = await (await fetch(`${hub.url}__ud/open_project?token=${hub.token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dir: "<scratchpad>/umbra_copy" }) })).json();
  const c = await (await fetch(`${o.data.url}__ud/check?token=${o.data.token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file: "PC 吐司.dc.html" }) })).json();
  for (let i = 0; i < 60; i++) { await new Promise(r => setTimeout(r, 500)); const s = await (await fetch(`${o.data.url}__ud/check_status?job=${c.data.jobId}&token=${o.data.token}`)).json(); if (s.data && s.data.running === false) return { ok: s.data.ok, res: s.data.result && s.data.result.result }; }
  return { timeout: true };
});
console.log("check via CDP:", JSON.stringify(r).slice(0, 200));
console.log("chrome processes launched by core? (ps count of headless chrome):", await new Promise(res => { const p = spawn("sh", ["-c", "ps aux | grep -c '[h]eadless.*--disable-background-networking'"]); let o = ""; p.stdout.on("data", d => o += d); p.on("close", () => res(o.trim())); }));
// 单实例：第二个实例应立刻退出
const second = spawn(bin, [SHELL], { env, stdio: "ignore" }); const code = await new Promise(res => { const t = setTimeout(() => { second.kill(); res("still running after 6s"); }, 6000); second.on("exit", c => { clearTimeout(t); res(c); }); });
console.log("second instance exit:", code);
// 强杀 → 重开 → 未落盘提示
const pid = await app.evaluate(() => process.pid); process.kill(pid, "SIGKILL"); await new Promise(r => setTimeout(r, 1500));
app = await electron.launch({ executablePath: bin, args: [SHELL], env, cwd: SHELL }); win = await mainWindow(app);
await win.waitForFunction(() => /上次没有正常退出/.test(document.body.innerText), null, { timeout: 15000 }).then(() => console.log("dirty-restart toast: ok")).catch(() => console.log("dirty-restart toast: 没出现"));
await app.close();
// 正常退出后再开：不该有提示
app = await electron.launch({ executablePath: bin, args: [SHELL], env, cwd: SHELL }); win = await mainWindow(app); await win.waitForTimeout(2500);
console.log("clean restart toast:", await win.evaluate(() => /上次没有正常退出/.test(document.body.innerText)) ? "有（错）" : "无（对）");
await app.close();
// --mcp：壳当 MCP server 起，stdio 归 MCP
{
  const { Client } = await import("/Users/sam/Documents/SourceTree/Geek/UmbraStudio/server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js");
  const { StdioClientTransport } = await import("/Users/sam/Documents/SourceTree/Geek/UmbraStudio/server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js");
  const t1 = Date.now(); const tr = new StdioClientTransport({ command: bin, args: [SHELL, "--mcp"], env, cwd: SHELL, stderr: "pipe" }); const c = new Client({ name: "t", version: "0" });
  await c.connect(tr); const tools = await c.listTools(); const r = await c.callTool({ name: "list_projects", arguments: {} }); const j = JSON.parse(r.content[0].text);
  console.log("--mcp: initialize", Date.now() - t1, "ms · tools", tools.tools.length, "· list_projects ok", j.ok);
  await c.close(); await new Promise(r => setTimeout(r, 800)); const alive = await new Promise(res => { const p = spawn("sh", ["-c", "ps aux | grep -c '[U]mbraStudio/shell.*--mcp'"]); let o = ""; p.stdout.on("data", d => o += d); p.on("close", () => res(o.trim())); });
  console.log("--mcp: 客户端断开后壳进程还活着:", alive, "(壳有窗口，stdin 关了不退出是预期；秘书用时窗口可见)");
}
console.log("autotest log:", (await readFile(S + "/shell-autotest.log", "utf8")).trim().split("\n").pop());
