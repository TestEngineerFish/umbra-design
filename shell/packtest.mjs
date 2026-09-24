/** 打包产物验收（M9-4）。
 *
 *  跟 shelltest.mjs 分开，因为问的是**不一样的问题**：shelltest 问「壳的逻辑对不对」（跑源码），
 *  packtest 问「打出来的这个东西换台机器还能不能用」—— 后者只能在产物上问。
 *  开发模式下 TOOL_ROOT 和 STATE_ROOT 恰好重合，这一类缺陷永远测不出来，M9-4 一次逼出三条。
 *
 *  用法：
 *    node shell/packtest.mjs                                  验 mac arm64（默认）
 *    node shell/packtest.mjs "shell/out/mac/Umbra Studio.app"  验 mac x64（本机靠 Rosetta，读数偏慢）
 *    node shell/packtest.mjs shell/out/win-unpacked            验 win：只查结构，跑不了
 *  测试项目用 PROJ 指定，默认 projects/Umbra_design_next。
 */
import { _electron as electron } from "../server/node_modules/playwright-core/index.mjs";
import { execFileSync } from "node:child_process";
import { existsSync, statSync, rmSync, cpSync, mkdtempSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const TARGET = resolve(process.argv[2] ?? join(HERE, "out", "mac-arm64", "Umbra Studio.app"));
const PROJ = resolve(process.env.PROJ ?? join(REPO, "projects", "Umbra_design_next"));
const IS_MAC = TARGET.endsWith(".app");

let pass = 0, fail = 0;
const ok = (cond, name, detail = "") => { if (cond) { pass++; console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`); } else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); } };
const note = (s) => console.log(`  · ${s}`);
const bye = (why) => { console.log(`\n${fail === 0 ? "✓" : "✗"} 打包产物 ${pass}/${pass + fail}${why ? ` · ${why}` : ""}\n`); process.exit(fail === 0 ? 0 : 1); };

console.log(`\n打包产物验收 · ${TARGET.replace(REPO + "/", "")}\n`);

/* ── 一关：结构 ─────────────────────────────────────────
   「打出来了」和「东西齐」是两件事。全部离线，不开进程。 */
console.log("一 · 结构");
const RES = IS_MAC ? join(TARGET, "Contents", "Resources") : join(TARGET, "resources");
const EXE = IS_MAC ? join(TARGET, "Contents", "MacOS", "Umbra Studio") : join(TARGET, "Umbra Studio.exe");
ok(existsSync(EXE) && (IS_MAC ? (statSync(EXE).mode & 0o111) !== 0 : true), "可执行文件在" + (IS_MAC ? "且可执行" : ""));
for (const f of [
  "core/server/dist/index.js", "core/server/dist/project.js", "core/server/package.json",
  "core/app/dist/index.html", "core/runtime/support.js", "core/runtime/react.production.min.js",
  "core/ui/S1-稿件索引.dc.html", "core/ui/_ds-tool/tokens.css",
  "core/doc/06-写稿规则.md", "core/doc/03-渲染与交互逻辑.md",   // get_syntax_guide 真读这两份
  "core/server/node_modules/playwright-core/index.mjs",         // 体检经 CDP 也要它
  "core/server/node_modules/@modelcontextprotocol/sdk/package.json",
]) ok(existsSync(join(RES, f)), f);
// 不该在包里的：编译期依赖、我们的回归基准、收设计侧稿的暂存处
for (const f of ["core/server/node_modules/typescript", "core/server/node_modules/@types", "core/fixtures", "core/ui/_incoming"])
  ok(!existsSync(join(RES, f)), `${f} 没进包`);

if (!IS_MAC) {
  const size = execFileSync("sh", ["-c", `du -sm ${JSON.stringify(TARGET)} | cut -f1`], { encoding: "utf8" }).trim();
  note(`体积 ${size} MB`);
  note("win 产物只能验结构 —— 这台机器跑不了 .exe。真机第一次跑是 doc/12 M9-6");
  bye("win：结构关");
}

/* mac：签名。这条是 M9-4 的第三条缺陷 —— electron-builder 在 identity:null 下不签，
   剩下的 linker 签名不覆盖我们塞进 Resources 的 core/，`codesign` 一验就报
   「code has no resources…」，用户下载后双击是「已损坏，移到废纸篓」。afterPack 补的完整
   ad-hoc 签名让它自洽；这一条必须通过，否则后面「签名没被毁」那条判据就没有基线。 */
try { execFileSync("lipo", ["-archs", EXE], { encoding: "utf8" }).trim() && note(`架构 ${execFileSync("lipo", ["-archs", EXE], { encoding: "utf8" }).trim()}`); } catch { note("lipo 读不出架构"); }
const verify = (app) => { try { execFileSync("codesign", ["-v", "--deep", "--strict", app], { stdio: "pipe" }); return "自洽"; } catch (e) { return String(e.stderr ?? "").trim().split("\n").pop() || "不自洽"; } };
const sigBefore = verify(TARGET);
ok(sigBefore === "自洽", "签名自洽（不会被 macOS 判「已损坏」）", sigBefore);
{ // Gatekeeper 的判定：ad-hoc 没公证，被拦是预期。写出来免得下次有人当缺陷查
  let spctl = "?";
  try { execFileSync("spctl", ["-a", "-t", "exec", TARGET], { stdio: "pipe" }); spctl = "放行"; } catch { spctl = "拦（预期：ad-hoc 签名没经 Apple 公证）"; }
  note(`Gatekeeper：${spctl} —— 用户头一次打开要右键「打开」或在系统设置里放行；要免这一步得买证书走 notarytool（M9-5）`);
}

/* ── 二关：换个地方真跑 ──────────────────────────────────
   拷到跟仓库毫无关系的目录。若壳或核心还偷偷指着仓库，这里就会露。 */
console.log("\n二 · 换地方真跑（模拟干净机器：产物脱离仓库，状态目录全新）");
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "us-pack-")));   // realpath：macOS 的 /var 是 /private/var 的软链，不解开对不上主进程报的路径
const appCopy = join(sandbox, basename(TARGET));
cpSync(TARGET, appCopy, { recursive: true, verbatimSymlinks: true });
const projCopy = join(sandbox, "proj");
cpSync(PROJ, projCopy, { recursive: true });
rmSync(join(projCopy, ".umbrastudio"), { recursive: true, force: true });   // 没建过索引，跟第一次打开一样

const exeCopy = join(appCopy, "Contents", "MacOS", "Umbra Studio");
const userData = join(sandbox, "userdata");
const logFile = join(sandbox, "autotest.log");
const env = { ...process.env, UMBRASTUDIO_AUTOTEST_LOG: logFile };
const errLines = [];
const launch = async () => {
  const a = await electron.launch({ executablePath: exeCopy, args: [`--user-data-dir=${userData}`], env, cwd: sandbox });
  a.process().stderr?.on("data", (d) => String(d).split("\n").filter(Boolean).forEach((l) => errLines.push(l)));
  return a;
};
const dumpErr = () => console.log(errLines.length ? "    主进程 stderr:\n" + errLines.slice(-12).map((l) => "      " + l.slice(0, 220)).join("\n") : "    主进程 stderr 一行都没有");
const mainWindow = async (a) => { for (let i = 0; i < 300; i++) { const w = a.windows().find((w) => w.url().includes("__app")); if (w) return w; await new Promise((r) => setTimeout(r, 200)); } throw new Error("主窗口没出来"); };

const t0 = Date.now();
let app = await launch();
let win = await mainWindow(app);
await win.waitForFunction(() => /最近打开|还没有项目/.test(document.body.innerText), null, { timeout: 90000 });
ok(true, "启动到首页", `${Date.now() - t0} ms`);

const probe = await app.evaluate(({ app }) => ({
  packaged: app.isPackaged, stateDir: process.env.UMBRASTUDIO_STATE_DIR ?? null,
  userData: app.getPath("userData"), cdp: process.env.UMBRASTUDIO_CDP ?? null, electron: process.versions.electron,
}));
ok(probe.packaged === true, "主进程认得自己是打包版", `Electron ${probe.electron}`);
ok(probe.stateDir === probe.userData, "状态目录 = userData（不是 .app 内部）", probe.stateDir ?? "(没设)");
ok(!!probe.cdp, "自带 Chromium 的 CDP 端口已就绪", probe.cdp ?? "(没有)");
const coreRoot = JSON.parse((await readFile(logFile, "utf8")).trim().split("\n").pop()).coreRoot;
ok(coreRoot.startsWith(appCopy), "核心根指着拷过来的产物，没指回仓库", coreRoot.replace(sandbox, "<sandbox>"));

await app.evaluate(({ BrowserWindow }, dir) => {
  BrowserWindow.getAllWindows().find((w) => w.isVisible()).webContents.send("host:event", { type: "open-dir", dir });
}, projCopy);
// 判据要认 [1-9]：「0 份稿」是加载中的瞬时态，拿它当通过等于什么都没验
await win.waitForFunction(() => /[1-9]\d* 份稿/.test(document.body.innerText) && !/核心断开/.test(document.body.innerText), null, { timeout: 90000 }).catch(() => {});
const shown = await win.evaluate(() => (document.body.innerText.match(/(\d+) 份稿/) ?? [])[1] ?? "?");
ok(Number(shown) > 0, "打开一个从没建过索引的目录（索引现建）", `界面报 ${shown} 份稿`);
if (!(Number(shown) > 0)) { dumpErr(); await app.close(); rmSync(sandbox, { recursive: true, force: true }); bye("卡在索引这一步，后面没跑"); }

/* 体检：自带 Chromium 那条路的唯一硬判据。渲染不出来和渲染对了长得一样，只有读数能分。
   判活认 `alive`（页面里 1+1===2 算得出来），走的哪个浏览器认 `browser.from` ——
   `UMBRASTUDIO_CDP` 才说明用的是 Electron 自带那个，不是这台机器恰好装了 Chrome。 */
const check = await win.evaluate(async (dir) => {
  const hub = window.__UD_APP;
  const post = (u, b) => fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
  const o = await post(`${hub.url}__ud/open_project?token=${hub.token}`, { dir });
  const list = await (await fetch(`${o.data.url}__ud/drafts?token=${o.data.token}`)).json();
  const file = list.data.drafts.find((d) => !d.file.includes("/"))?.file;   // 字段是 file（api.ts 的 drafts 路由），不是 path
  const c = await post(`${o.data.url}__ud/check?token=${o.data.token}`, { file });
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const s = await (await fetch(`${o.data.url}__ud/check_status?job=${c.data.jobId}&token=${o.data.token}`)).json();
    if (s.data && s.data.running === false) {
      const dig = (v) => { if (!v || typeof v !== "object") return null; if ("alive" in v && "browser" in v) return v; for (const x of Object.values(v)) { const r = dig(x); if (r) return r; } return null; };
      const r = dig(s.data);
      return { file, found: !!r, alive: r?.alive, from: r?.browser?.from, nodes: r?.nodeCount, ms: r?.renderMs, raw: r ? null : JSON.stringify(s.data).slice(0, 500) };
    }
  }
  return { file, timeout: true };
}, projCopy);
ok(check.alive === true, "体检跑通，页面判活（1+1）", `${check.file} · ${check.nodes} 个节点 · ${check.ms} ms`);
ok(check.from === "UMBRASTUDIO_CDP", "用的是 Electron 自带 Chromium，不是系统装的浏览器", `browser.from = ${check.from ?? "(没读到)"}`);
if (!check.found) console.log("    读不到读数，原始返回:", check.raw ?? "(超时)");

await app.close();
await new Promise((r) => setTimeout(r, 1200));

/* ── 三关：写过一轮之后还起得来 ────────────────────────
   钉住第一条缺陷：状态若写进 .app，ad-hoc 签名会失效，第二次启动就被判「已损坏」。
   一关已经把签名基线校准成「自洽」，这里量到的「仍然自洽」才说明得了问题。 */
console.log("\n三 · 写过一轮之后（状态落在哪、还起不起得来）");
const stateFiles = execFileSync("sh", ["-c", `find ${JSON.stringify(userData)} -name workspace.json -o -name ai_config.json | sed 's|${userData}|<userData>|'`], { encoding: "utf8" }).trim();
ok(/workspace\.json/.test(stateFiles), "workspace.json 落在 userData", stateFiles.split("\n").join(" · "));
const insideApp = execFileSync("sh", ["-c", `find ${JSON.stringify(join(appCopy, "Contents", "Resources", "core"))} -name workspace.json -o -name ai_config.json -o -name projects -type d | wc -l`], { encoding: "utf8" }).trim();
ok(insideApp === "0", ".app 内部没有被写进任何状态", `命中 ${insideApp} 个`);
const sigAfter = verify(appCopy);
ok(sigAfter === "自洽", "跑过一轮之后签名仍然自洽（没被自己毁掉）", `${sigBefore} → ${sigAfter}`);
app = await launch(); win = await mainWindow(app);
await win.waitForFunction(() => /最近打开|还没有项目/.test(document.body.innerText), null, { timeout: 90000 });
const recent = await win.evaluate(() => /proj/.test(document.body.innerText) ? "记住了" : "没记住");
ok(recent === "记住了", "第二次启动照样起来，最近打开记在 userData 里", recent);
await app.close();


/* ── 四关：打包版当 MCP server 起 ──────────────────────
   `01` §4.8 的秘书接入就靠这条：别的模型客户端把这个可执行文件当 MCP server 起，
   stdio 归 MCP，不开窗口。打包后核心路径全变了（Resources/core），必须在产物上验。 */
console.log("\n四 · 打包版当 MCP server 起（秘书接入那条路）");
{
  const { Client } = await import("../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js");
  const { StdioClientTransport } = await import("../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js");
  const t = Date.now();
  const tr = new StdioClientTransport({ command: exeCopy, args: ["--mcp", `--user-data-dir=${userData}`], env, cwd: sandbox, stderr: "pipe" });
  const c = new Client({ name: "packtest", version: "0" });
  try {
    await c.connect(tr);
    const tools = await c.listTools();
    const r = await c.callTool({ name: "list_projects", arguments: {} });
    const j = JSON.parse(r.content[0].text);
    ok(tools.tools.length > 20, "MCP 握手成功，工具表齐", `${tools.tools.length} 件工具 · initialize ${Date.now() - t} ms`);
    ok(j.ok === true, "调一件工具拿到信封", `list_projects → 项目根 ${String(j.data?.projectsRoot ?? "?").replace(userData, "<userData>")}`);
    ok(String(j.data?.projectsRoot ?? "").startsWith(userData), "MCP 里的项目根也在 userData，不在 .app 里");
    await c.close();
  } catch (e) { ok(false, "MCP 起不来", String(e).slice(0, 200)); }
}

/* 单实例：第二个进程应当立刻退出，把请求转给第一个。
   前提是**真有**第一个在跑 —— 锁是按 userData 目录拿的，没人持锁时第二个进程就是第一个，
   不退出反而是对的（这条判据第一版就是这么写错的）。 */
{
  const { spawn } = await import("node:child_process");
  const first = await launch(); await mainWindow(first);
  const second = spawn(exeCopy, [`--user-data-dir=${userData}`], { env, stdio: "ignore" });
  const code = await new Promise((res) => { const t = setTimeout(() => { second.kill(); res("6 秒还没退"); }, 8000); second.on("exit", (c) => { clearTimeout(t); res(c); }); });
  ok(code === 0, "有实例在跑时，第二个立刻退出（单实例锁）", `退出码 ${code}`);
  await first.close();
}

rmSync(sandbox, { recursive: true, force: true });
bye();
