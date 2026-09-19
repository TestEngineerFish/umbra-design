/** 渲染回归：`fixtures/渲染/` 的每一份稿真开一次浏览器，比对 `渲染-expect.json`。
 *
 *  为什么必须单独有这一层：静态校验只看得见源码里的形状，
 *  「浏览器到底报不报」只有真跑一次才知道 —— 而这正是栽过跟头的地方
 *  （`doc/00` §二十七：`render_check` 里一行静音，让一条真判据被当成误报撤回）。
 *
 *  判据只有两种，没有中间地带：
 *   · `解析期报错: true`  —— 必须报出 SVG 解析期那一类。**报不出来就是仪器坏了。**
 *   · `解析期报错: false` —— 控制台必须干净。多报一条就是误报。
 *
 *  用法：node dist/rendertest.js
 *  要一个 chromium / Chrome。找不到就整块跳过并说清楚 —— 不算失败，
 *  但也**不算通过**（不能让「没浏览器」冒充「过了」）。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildProject, TOOL_ROOT } from "./project.js";
import { ensureRuntimeBeside } from "./normalize.js";
import { findBrowser, renderCheck } from "./render.js";

const bar = (s: string) => console.log("\n" + "─".repeat(4) + " " + s + " " + "─".repeat(Math.max(0, 58 - s.length)));

const fxDir = join(TOOL_ROOT, "fixtures");
const p = await buildProject(fxDir);
const spec: { 稿: Record<string, { 解析期报错: boolean }> } =
  JSON.parse(await readFile(join(fxDir, "渲染-expect.json"), "utf8"));
const names = Object.keys(spec.稿).sort();

const found = findBrowser();
bar("fixtures/渲染");
if (!found) {
  console.log("  找不到 chromium / Chrome —— 这一块整块跳过。");
  console.log("  装一个，或设 UMBRADESIGN_CHROMIUM 指到可执行文件。");
  console.log("  ⚠️ 跳过不等于通过：这一层是唯一能证明「浏览器到底报不报」的证据。");
  process.exitCode = 0;
} else {
  console.log(`  浏览器 ${found.path}（${found.from}）`);
  // 运行时三件套要与稿同层，否则断网取 React 失败，整份稿白屏
  await ensureRuntimeBeside(join(fxDir, "渲染", names[0]!.replace("渲染/", "")));

  let bad = 0;
  for (const key of names) {
    const rel = key;                                   // 相对 fixtures/ 的路径
    const want = spec.稿[key]!.解析期报错;
    const { diags } = await renderCheck(p, rel, { screenshot: false });
    const parse = (diags ?? []).filter((d) => d.message.startsWith("解析期报错"));
    const other = (diags ?? []).filter((d) => !d.message.startsWith("解析期报错"));
    const ok = want ? parse.length > 0 && other.length === 0
                    : parse.length === 0 && other.length === 0;
    if (!ok) bad++;
    const label = rel.replace("渲染/", "").replace(".dc.html", "");
    console.log(`  ${ok ? "✓" : "✗"} ${label.slice(0, 32).padEnd(34)}` +
      `${want ? "该报" : "该干净"} · 实际 ${parse.length ? "报了解析期" : "没报解析期"}` +
      `${other.length ? ` · 另有 ${other.length} 条` : ""}`);
    for (const d of other) console.log(`      → ${d.message.slice(0, 110)}`);
    if (!ok && want && !parse.length) {
      console.log("      ⚠️ 该报没报 —— 先怀疑仪器：render_check 是不是又把这一类静音了？");
    }
  }
  console.log(bad ? `\n✗ ${bad} 条渲染基准没过` : `\n✓ ${names.length} 条渲染基准全过`);
  process.exitCode = bad ? 1 : 0;
}
