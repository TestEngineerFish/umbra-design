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

console.log("\n会话历史与引擎名（M8-11 下 / M8-13 · 设计侧第六轮 6.3 / 6.4）");
/* 引擎名：钮上和状态行都不该再出现「通道 A/B/C」 */
const railText = await pg.locator("aside").first().innerText();
ok(!/通道\s*[ABC]\b/.test(railText), "会话栏里没有「通道 A/B/C」字样了");
ok(/DeepSeek|Claude Code|火山方舟|Codex|Cursor/.test(railText), "显示的是引擎名", (railText.match(/DeepSeek|Claude Code|火山方舟|Codex|Cursor/g) ?? []).slice(0,3).join(" / "));
/* 标题不能被引擎选择器挤掉 —— 三个引擎名平铺时它被压成了竖排一列（真出过） */
const titleBox = await pg.locator('aside button[title="看历史会话"]').first().boundingBox();
ok((titleBox?.width ?? 0) > 120, "顶栏标题没被挤扁", `标题宽 ${Math.round(titleBox?.width ?? 0)} px`);
/* 引擎下拉：点开能看到按计费方式分的三组 */
/* 用 data-ud 精确定位。**别用文字匹配** —— 状态行里也有引擎名，
   按文字找会先命中标题按钮，点下去进的是历史模式，而后面的分组判据会被
   会话行里的「本机工具」蒙对（2026-09-24 真出过这个假阳性）。 */
const engBtn = pg.locator('aside button[data-ud="engine"]').first();
if (await engBtn.count()) {
  await engBtn.click(); await pg.waitForTimeout(500);
  const menu = await pg.locator("aside").first().innerText();
  const groups = menu.match(/本机 · 用你已有的订阅|API · 按量计费|订阅端点/g) ?? [];
  ok(groups.length >= 2, "引擎下拉按计费方式分组", groups.join(" / ") || "（一个组名都没匹配到）");
  await engBtn.click(); await pg.waitForTimeout(300);   // 关掉下拉，别挡住后面的点击
} else ok(false, "没找到引擎选择器");

/* 历史入口：点顶栏标题整栏换成列表 */
/* 用 title 属性定位，别用 ▾ —— 进了历史之后标题变成「‹ 历史会话」，那个箭头就没了 */
const title = pg.locator('aside button[title="看历史会话"]').first();
if (await title.count()) {
  await title.click(); await pg.waitForTimeout(900);
  const t2 = await pg.locator("aside").first().innerText();
  ok(/历史会话/.test(t2), "点标题后整栏换成历史列表");
  ok(/今天|昨天|本周|更早|还没有会话/.test(t2), "历史按日期分组", (t2.match(/今天|昨天|本周|更早/g) ?? []).join(" "));
  // 输入区在历史模式下仍然在（打字 = 在当前会话继续说）
  ok(await pg.locator("#chatInput").count() > 0, "历史模式下输入框仍在");
  await pg.locator('aside button[title="回到这条会话"]').first().click(); await pg.waitForTimeout(700);
  ok(!/历史会话/.test(await pg.locator("aside").first().innerText()), "再点标题回到会话");
} else ok(false, "没找到顶栏的标题入口（▾）");

/* ── 格式注册表（M8-14）──
   这一轮把「每种文件怎么看」从 Workbench 的一条三元链搬进 `app/src/kinds/` 的独立模块。
   要守住的不是某个像素，而是**三个环节各自还通**：视图（View）、面板（Panels）、状态行（Status）。
   哪一环断了，症状都是「这种文件打开后少了点东西」，而截图上很难一眼看出少了什么。 */
console.log("\n格式注册表：每种文件的视图 / 面板 / 状态行（M8-14）");
const footText = () => pg.locator("footer").innerText();
const openByName = async (suffix) => {
  const row = pg.locator('[role="treeitem"]').filter({ hasText: suffix }).first();
  if (!(await row.count())) return false;
  await row.click(); await pg.waitForTimeout(1200);
  return true;
};

/* 设计稿：属性面板（dc 模块的 Panels）。它是唯一有五个面板的格式 */
if (await openByName(".dc.html")) {
  ok(/设计稿|组件稿/.test(await footText()), "设计稿：状态行写类型和读数", (await footText()).split("\n").slice(0, 5).join(" · "));
  ok(await pg.locator('text=属性').count() > 0, "设计稿：右侧属性面板在");
} else ok(false, "项目里没有 .dc.html，测不了设计稿");

/* Markdown：大纲。**这一条最该测** —— 大纲原来是 Workbench 的一个 state，
   现在住在 md 模块自己的 Provider 里（View 产出、Panels 消费）。
   接错了的症状是「右边那一列空着」，静态检查抓不到。 */
if (await openByName(".md")) {
  ok(/Markdown/.test(await footText()), "Markdown：状态行写类型");
  ok(await pg.locator('text=大纲').count() > 0, "Markdown：大纲面板在（它跨了 View 与 Panels 两处）");
} else ok(false, "项目里没有 .md，测不了 Markdown");

/* JSON：M8-14 新加的一种。**它存在就是「加一种格式只需新增一个文件」的证据** */
if (await openByName(".json")) {
  const t = await pg.locator("footer").innerText();
  ok(/JSON/.test(t), "JSON：状态行写 JSON（新格式的 Status 接上了）");
  const bodyTxt = await pg.locator("main, body").first().innerText();
  ok(/结构/.test(bodyTxt) && /源码/.test(bodyTxt), "JSON：结构 / 源码两档都在");
} else console.log("  – 项目里没有 .json，跳过新格式那一条（不算通过）");

console.log("\n控制台");
ok(errs.length === 0, "零 error（已排除解析期的模板洞噪声）", errs[0] ?? "");

console.log(`\n${fail ? "✗" : "✓"} 界面回归 ${pass}/${pass + fail}\n`);
await b.close();
process.exit(fail ? 1 : 0);
