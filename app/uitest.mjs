/** 前端界面回归（M8-11 起）。
 *
 *  为什么要有它：静态回归（selftest / rendertest）看的是**稿**，看不到 React 应用本身。
 *  界面的缺陷只有真打开才暴露 —— 2026-09-24 就有一条自动测试没抓到、靠人看截图才发现的
 *  （⌘B 收起再展开后，树的三角是展开的、子项却一个都没有）。**判据要跟着补，不是补完就算。**
 *
 *  用法：
 *    npm --prefix server run ui -- <项目名>        # 另开一个终端起服务
 *    node app/uitest.mjs http://127.0.0.1:<端口>/__app/
 *
 *  判据一律「能在盘上/DOM 里数出来」，不看截图判对错（纪律②）。
 */
import { chromium } from "../server/node_modules/playwright-core/index.mjs";

const URL_ = process.argv[2];
if (!URL_) { console.error("用法：node app/uitest.mjs <__app 的 URL>"); process.exit(2); }

/* 控制台噪声白名单。
   `d="{{ icon }}"` 是 dc 模板在**解析期**的正常现象：浏览器先按 HTML 解析 SVG 的 d，
   这时洞还没填，于是抱怨一句；运行时随后会把它换成真的 path data。
   这属于语料的存量写法（`doc/06` §2.8 记着该怎么改），不是应用的缺陷 ——
   不排掉的话每次跑都是红的，久了就没人看了。 */
const NOISE = [/favicon/i, /attribute d: Expected moveto/i];

let pass = 0, fail = 0;
const ok = (c, s, d = "") => { c ? pass++ : fail++; console.log((c ? "  ✓ " : "  ✗ ") + s + (d ? ` — ${d}` : "")); };

const b = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
const pg = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errs = [];
pg.on("console", (m) => { const t = m.text(); if (m.type() === "error" && !NOISE.some((r) => r.test(t))) errs.push(t.slice(0, 120)); });
pg.on("pageerror", (e) => { const t = String(e); if (!NOISE.some((r) => r.test(t))) errs.push("pageerror: " + t.slice(0, 120)); });

await pg.goto(URL_, { waitUntil: "domcontentloaded" });
await pg.waitForFunction(() => /份稿|\d+ 项/.test(document.body.innerText), null, { timeout: 30000 });
await pg.waitForTimeout(1500);

console.log("\n常驻目录列（M8-11 · 设计侧第六轮 6.1 / 6.2）");
const tree = pg.locator('[role="tree"]');
const rowsNow = () => pg.locator('[role="treeitem"]').count();
ok(await tree.count() > 0, "目录列在");
const n0 = await rowsNow();
ok(n0 > 0, "树里有节点", `${n0} 行`);

const firstFile = pg.locator('[role="treeitem"]').filter({ hasText: ".dc.html" }).first();
await firstFile.click();
await pg.waitForTimeout(1200);
/* 这条是这一轮的要害：以前点开文件，目录会被整个换掉 */
ok(await tree.count() > 0, "打开文件后目录列仍然在");
ok(await pg.locator('[role="treeitem"][aria-selected="true"]').count() > 0, "当前文件在树里高亮");

const dirRow = pg.locator('[role="treeitem"][aria-expanded="false"]').first();
let nExpanded = n0;
if (await dirRow.count()) {
  await dirRow.click(); await pg.waitForTimeout(1200);
  nExpanded = await rowsNow();
  ok(nExpanded > n0, "展开子目录后上一层还在", `${n0} → ${nExpanded} 行`);
} else ok(false, "没找到可展开的目录");

await pg.keyboard.press("Meta+b"); await pg.waitForTimeout(500);
ok(await tree.count() === 0, "⌘B 收起");
await pg.keyboard.press("Meta+b"); await pg.waitForTimeout(1600);
ok(await tree.count() > 0, "⌘B 展开回来");
/* ⌘B 会把整棵树卸载，子层的内存缓存跟着没。再展开时内容必须回来 ——
   只剩一个展开的三角、底下空空如也，是 2026-09-24 真出过的缺陷。 */
ok(await rowsNow() >= nExpanded, "⌘B 往返后，之前展开的子目录内容还在", `${await rowsNow()} 行（收起前 ${nExpanded} 行）`);

console.log("\n控制台");
ok(errs.length === 0, "零 error（已排除解析期的模板洞噪声）", errs[0] ?? "");

console.log(`\n${fail ? "✗" : "✓"} 界面回归 ${pass}/${pass + fail}\n`);
await b.close();
process.exit(fail ? 1 : 0);
