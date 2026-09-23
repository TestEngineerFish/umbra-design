/** 给**人**用的入口：起本地服务 + 生成入口页 + 打开浏览器。
 *
 *  为什么要单独有它：`serve_start` 与 `build_index` 本来只暴露成 MCP 工具，
 *  于是「我想自己看看稿」这件事要先找一个大模型来调一次 —— 而界面
 *  （S1–S5、S7）早就是给人用的。这条命令把模型从人的路径上摘出去。
 *
 *  用法：
 *      npm --prefix server run ui               # 只有一个项目时直接起它
 *      npm --prefix server run ui -- <项目名>
 *      npm --prefix server run ui -- <项目名> --port 4173 --no-open
 *
 *  起来之后停在前台：回车重跑索引（改完稿用），Ctrl-C 退出。
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { buildProject, listProjectDirs, loadProject, projectsRoot, type Project } from "./project.js";
import { serveHold, serveStart } from "./serve.js";
import { buildIndex, indexStatus } from "./indexpage.js";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const positional = argv.filter((a, i) =>
  !a.startsWith("-") && argv[i - 1] !== "--port");

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const b = (s: string) => `\x1b[1m${s}\x1b[0m`;

/** 项目：给了名字就用它；没给且只有一个就用那一个；多个就列出来让人选。 */
async function pick(): Promise<Project> {
  if (positional[0]) return await loadProject(positional[0] as string);
  const dirs = await listProjectDirs();
  if (!dirs.length) {
    console.error(`${projectsRoot()} 下没有设计项目。`);
    console.error("新建一个目录，放一个 project.json 和 .dc.html 稿进去（见 README §5）。");
    process.exit(1);
  }
  if (dirs.length === 1) return await buildProject(dirs[0] as string);
  console.error("有多个项目，说清是哪一个：");
  for (const d of dirs) console.error("  " + (d.split(/[\\/]/).pop() ?? d));
  console.error("\n  npm --prefix server run ui -- <项目名>");
  process.exit(1);
}

function openInBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // 打不开浏览器不是错 —— 地址已经印在屏上了
  }
}

const p = await pick();
const serve = await serveStart(p, opt("--port") ? Number(opt("--port")) : undefined);
const built = await buildIndex(p, serve.url);
// serve.ts 对静态服务做了 unref（MCP 不该被它挡住退出）——
// 前台用法里它就是唯一的存活理由，必须 ref 回来，否则打印完地址就退了。
serveHold(p.name);

const entry = serve.url + "__app/";   // 应用前端本体（doc/00 §四十六）；build_index 的入口页仍在 index.dc.html
console.log("");
console.log(`  ${b("Umbra Studio")}  ${p.title}`);
console.log(`  项目    ${p.dir}`);
console.log(`  稿件    ${built.drafts} 份` +
  `（ok ${built.byHealth.ok} · warn ${built.byHealth.warn} · error ${built.byHealth.error} · 没体检 ${built.byHealth.unchecked}）`);
console.log(`  界面    ${built.shells.length} 屏 · 本地 API ${built.api ? "已注入" : "没起来"}`);
console.log("");
console.log(`  ${b("打开 " + entry)}`);
console.log("");
console.log(dim("  这是和 Tauri 壳里一样的应用界面：左会话、右预览，首页是项目列表。"));
console.log(dim(`  只看稿件索引页：${serve.url}index.dc.html`));
console.log("");
console.log(dim("  回车 = 改完稿之后重跑索引 · Ctrl-C = 退出"));
console.log("");

if (!flag("--no-open")) openInBrowser(entry);

/* 索引是一次性扫目录的：之后改稿它不知道，页面上的元素数/健康/时间就全是旧的
   （§26.2）。页面自己有过期横幅，这里再给一个就地重跑的办法 ——
   不做文件监听：`build_index` 自己就往项目目录里写文件，监听会看见自己的写入。 */
if (process.stdin.isTTY) {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", async () => {
    try {
      const st = await indexStatus(p);
      const again = await buildIndex(p, serve.url);
      console.log(`  ↻ 索引重跑完 · ${again.drafts} 份稿` +
        (st.stale ? dim(`（上一版已过期：${st.reason}）`) : dim("（上一版还是新的）")));
    } catch (e) {
      console.log(`  ✗ 重跑失败：${(e as Error).message}`);
    }
  });
}

// 服务在前台挂住，Ctrl-C 退出
process.on("SIGINT", () => { console.log("\n  已停。"); process.exit(0); });
