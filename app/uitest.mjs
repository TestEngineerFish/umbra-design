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
/* 「起来了」的判据：树里长出了节点。
   ⚠️ 别拿界面文案当判据 —— 原来这里等的是「N 份稿」，第七轮把那颗钮挪进了
   目录列头并改叫「转到文件」，整个回归就卡在启动等待上了（M8-15 实测）。
   `role="treeitem"` 是形制变了也还在的东西。 */
await pg.waitForFunction(() => document.querySelectorAll('[role="treeitem"]').length > 0, null, { timeout: 30000 });
await pg.waitForTimeout(1500);

/* ⌘P 在**这里**测：刚启动，没有任何浮层开着。
   放到后面测会被前几步留下的状态干扰（M8-27 实测），而那不是它自己的毛病。 */
await pg.keyboard.press("Meta+p"); await pg.waitForTimeout(800);
ok(await pg.locator('input[placeholder="转到文件…"]').count() === 1, "⌘P 打开「转到文件」");
await pg.keyboard.press("Escape"); await pg.waitForTimeout(400);

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

await pg.keyboard.press("Meta+b"); await pg.waitForTimeout(600);
/* ⚠️ **收起后元素还在 DOM 里**（M8-28 起）：要做宽度动画，列就得一直在，
   靠外层收宽到 0 + overflow:hidden 裁掉里层。所以判据看的是「收起了」
   （`data-hidden` + 宽度 0），不是「卸载了」。 */
const navCol = pg.locator('[data-region="nav"]');
ok(await navCol.getAttribute("data-hidden") !== null, "⌘B 收起");
ok(((await navCol.boundingBox())?.width ?? 99) < 2, "收起后宽度收到 0", `宽 ${Math.round((await navCol.boundingBox())?.width ?? -1)}`);
await pg.keyboard.press("Meta+b"); await pg.waitForTimeout(1600);
ok(await navCol.getAttribute("data-hidden") === null, "⌘B 展开回来");
/* ⌘B 会把整棵树卸载，子层的内存缓存跟着没。再展开时内容必须回来 ——
   只剩一个展开的三角、底下空空如也，是 2026-09-24 真出过的缺陷。 */
ok(await rowsNow() >= nExpanded, "⌘B 往返后，之前展开的子目录内容还在", `${await rowsNow()} 行（收起前 ${nExpanded} 行）`);

console.log("\n会话历史与引擎名（M8-11 下 / M8-13 · 设计侧第六轮 6.3 / 6.4）");
/* 引擎名：钮上和状态行都不该再出现「通道 A/B/C」 */
const railText = await pg.locator("aside").first().innerText();
ok(!/通道\s*[ABC]\b/.test(railText), "会话栏里没有「通道 A/B/C」字样了");
ok(/DeepSeek|Claude Code|火山方舟|Codex|Cursor/.test(railText), "显示的是引擎名", (railText.match(/DeepSeek|Claude Code|火山方舟|Codex|Cursor/g) ?? []).slice(0,3).join(" / "));
/* 会话栏头在第八轮只剩两样：引擎 ▾ 和历史钮。
   「标题被挤扁」那条判据随标题一起作废了 —— 标题搬进了历史列表。 */
ok(await pg.locator('aside button[data-ud="engine"]').count() === 1, "会话栏头有引擎选择器");
ok(await pg.locator('aside button[data-ud="history"]').count() === 1, "会话栏头有历史钮");
ok(await pg.locator('aside button[title="换边"]').count() === 0 && await pg.locator('aside button[title="新会话"]').count() === 0,
   "换边 / ＋ 新会话两颗已经去掉（一件事一个入口）");
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

/* 历史入口：点历史钮整栏换成列表 */
const histBtn = pg.locator('aside button[data-ud="history"]').first();
if (await histBtn.count()) {
  await histBtn.click(); await pg.waitForTimeout(900);
  const t2 = await pg.locator("aside").first().innerText();
  ok(/新建会话/.test(t2), "历史列表第一行是「新建会话」（第八轮：＋ 收进这里）");
  ok(/今天|昨天|本周|更早|还没有会话/.test(t2), "历史按日期分组", (t2.match(/今天|昨天|本周|更早/g) ?? []).join(" "));
  ok(await pg.locator("#chatInput").count() > 0, "历史模式下输入框仍在");
  await pg.locator('aside button[data-ud="history"]').first().click(); await pg.waitForTimeout(700);
  ok(!/新建会话/.test(await pg.locator("aside").first().innerText()), "再点历史钮回到会话");
} else ok(false, "没找到历史钮");

/* ── 布局模型：左 / 底 / 右三块在不在（M8-18/19/20 · 设计侧第八轮 §一）──
   这一轮把「会话栏摆在哪」换成了「三块区域在不在」。
   **判据要落在「三块各自开得了关得了」上**，而不是某颗钮的位置 —— 位置是形制，开关才是模型。 */
console.log("\n布局模型：左 / 底 / 右三块（M8-18/19/20 · 设计侧第八轮）");
const region = (k) => pg.locator(`header [data-ud="region-${k}"]`);
ok(await pg.locator('header [aria-label="窗口布局"] button').count() === 3, "顶栏布局组是三颗区域钮（不再有目录钮）");
ok(await region("left").count() === 1 && await region("bottom").count() === 1 && await region("right").count() === 1, "左 / 底 / 右三颗都在");
/* ⚠️ 第九轮三颗钮管的东西**整个换了一遍**：左=目录 · 底=调试 · 右=聊天。
   第八轮是左=会话 · 右=从属面板。判据的口径跟着换。 */
const colHidden = async (id) => (await pg.locator(`[data-region="${id}"]`).getAttribute("data-hidden")) !== null;
await region("left").click(); await pg.waitForTimeout(600);
ok(await colHidden("nav"), "关左栏：目录整列收掉");
await pg.keyboard.press("Meta+b"); await pg.waitForTimeout(600);
ok(!(await colHidden("nav")), "⌘B 把目录叫回来");
await region("right").click(); await pg.waitForTimeout(600);
ok(await colHidden("chat"), "关右栏：聊天整栏收掉");
await pg.keyboard.press("Meta+\\"); await pg.waitForTimeout(600);
ok(!(await colHidden("chat")), "⌘\\ 把聊天叫回来");
/* 底栏：默认关，⌘J 打开，三页都在 */
ok(await pg.locator('[data-ud="bottombar"]').count() === 0, "底栏默认关着");
await pg.keyboard.press("Meta+j"); await pg.waitForTimeout(700);
const bb = pg.locator('[data-ud="bottombar"]');
ok(await bb.count() === 1, "⌘J 打开底栏");
const bbText = await bb.innerText().catch(() => "");
ok(/输出/.test(bbText) && /工具调用/.test(bbText) && /连接/.test(bbText), "底栏三页：输出 / 工具调用 / 连接", bbText.split("\n").slice(0, 4).join(" · "));
ok(/左 \d+|左 关/.test(bbText) && /详情 \d+/.test(bbText), "布局读数常驻在底栏头部（不单开一页）", (bbText.match(/左 [^\n]*/) ?? [""])[0].slice(0, 46));
/* 用户第九轮第 4 条：会话栏底部的「运行中」和 token 数要挪进底栏。
   ⚠️ **判据落在结构标记上，不落在「tokens」这个词上** ——
   第一版写的是「会话栏里不含 tokens」，结果被会话内容里的工具名 `search_tokens` 蒙掉了
   （M8-25 实测）。这和 §72.4 是同一条教训的第三次。
   没跑过 AI 时那个读数不渲染，所以这里只测反向：它不该再出现在会话栏里。 */
ok(await pg.locator('aside [data-ud="turn-cost"]').count() === 0, "「本轮」读数不在会话栏里了（已挪进底栏头部）");
await pg.keyboard.press("Meta+j"); await pg.waitForTimeout(500);
ok(await pg.locator('[data-ud="bottombar"]').count() === 0, "⌘J 再按一次收起底栏");

/* ── 按钮分层（M8-15 · 设计侧第七轮）──
   它给的判据是「点了它，变的是什么」，分项目 / 窗口布局 / 导航 / 会话 / 当前文件五类，
   每类只在一个地方出现，每条横带只装一层。
   **「不该有的东西不在」和「该有的东西在」一样要测** —— 分层做对了的标志
   恰恰是页签条上少了三颗钮，而那种「少了」截图上根本看不出来。 */
console.log("\n按钮分层：顶栏 / 页签条 / 目录列头（M8-15 · 设计侧第七轮）");
const header = pg.locator("header").first();
const tabbar = pg.locator('[data-ud="tabbar"]');
/* ⚠️ 这两条在第八轮**反过来了**：目录列不算三块区域之一，它的开关只在自己列头。
   第七轮把它挪进顶栏，用户看完说「不应该有，由目录区块上的菜单图标自己控制」。 */
/* 第九轮又换回顶栏了 —— 第八轮把它挪到列头，用户看了实物说「有点多余」 */
ok(await header.locator('[data-ud="region-left"]').count() === 1, "目录开关在顶栏那一颗（第九轮第 14 条）");
/* 第九轮第 14 条：列头那颗收起钮**删掉了**，目录的显隐只归顶栏那一颗 */
ok(await pg.locator('[data-ud="tree-collapse"]').count() === 0, "列头的收起钮已删（显隐只归顶栏）");
ok(await pg.locator('[data-ud="tree-more"]').count() === 1, "目录列头有 ⋯（和空白处右键同一张菜单）");
const tabbarText = await tabbar.innerText().catch(() => "");
ok(!/份稿|▤\s*目录/.test(tabbarText), "页签条上没有「N 份稿」和「▤ 目录」了", tabbarText.slice(0, 60).replace(/\n/g, " / ") || "（只有页签）");
/* 项目菜单：路径进了菜单，顶栏上不再铺 280px 的灰字 */
const headText = await header.innerText();
ok(!headText.includes("/Users/"), "项目路径不在顶栏上了", headText.replace(/\n/g, " · ").slice(0, 70));
await header.locator("button[aria-haspopup=\"menu\"]").click(); await pg.waitForTimeout(400);
const menuText = await pg.locator('[role="menu"]').innerText();
ok(menuText.includes("/Users/"), "完整路径在项目菜单里（要复制路径时截断的没用）");
/* 第八轮精简过：**「新建稿件」去了目录右键**，「复制路径」并进了路径那一栏（整块可点） */
ok(["在访达中显示", "重建索引", "项目设置…", "关闭项目"].every((x) => menuText.includes(x)), "项目菜单只剩对整个项目的动作", menuText.split("\n").filter(Boolean).slice(2).join(" / "));
ok(!menuText.includes("新建稿件"), "项目菜单里**没有**新建稿件了（它去了目录右键）");
ok(/点击复制/.test(menuText), "路径那一栏整块可点即复制");
await pg.keyboard.press("Escape"); await pg.mouse.click(700, 400); await pg.waitForTimeout(300);
/* 目录列头的两颗导航钮 */
/* 「铺到详情区」第八轮删掉了（用户读成「放大」，而且它让详情区重复显示目录）——
   功能留在右键 / 双击 / 点项目名三处 */
ok(await pg.locator('button[title="铺到详情区（多选 · 网格 · 回收站）"]').count() === 0, "⤢「铺到详情区」已从列头删掉");
/* 第九轮第 14 条：列头那颗收起钮和页签条最左那颗展开钮**都删了** ——
   目录的显隐只归顶栏那一颗（上面已经测过 ⌘B 和 region-left）。 */
ok(await pg.locator('[data-ud="tree-collapse"]').count() === 0, "列头的收起钮已删（显隐只归顶栏）");
ok(await pg.locator('[data-ud="tree-reopen"]').count() === 0, "页签条最左的展开钮也删了");
ok(await pg.locator('[data-ud="tree-more"]').count() === 1, "目录列头换成了 ⋯（和空白处右键同一张菜单）");
/* ⌘P 之前先确保目录开着 —— 它的入口在目录列头，列收起来时浮层挂在一个不存在的列上。
   （代码里 ⌘P 会先展开目录，这里等它展开完） */
if ((await pg.locator('header [data-ud="region-left"]').getAttribute("aria-pressed")) !== "true") {
  await pg.locator('header [data-ud="region-left"]').click(); await pg.waitForTimeout(600);
}
/* 点列头的 ⌕ —— 这是真实入口。⌘P 走的是同一条路（代码里派发同一个事件），
   在这一步之前测过它单独可用；放在这里测快捷键会被前面几步留下的浮层状态干扰。 */
await pg.locator('button[title="转到文件（⌘P）"]').click(); await pg.waitForTimeout(700);
ok(await pg.locator('input[placeholder="转到文件…"]').count() === 1, "列头的 ⌕ 打开「转到文件」");
await pg.keyboard.press("Escape"); await pg.waitForTimeout(300);

/* ── 格式注册表（M8-14）──
   这一轮把「每种文件怎么看」从 Workbench 的一条三元链搬进 `app/src/kinds/` 的独立模块。
   要守住的不是某个像素，而是**三个环节各自还通**：视图（View）、面板（Panels）、状态行（Status）。
   哪一环断了，症状都是「这种文件打开后少了点东西」，而截图上很难一眼看出少了什么。 */
console.log("\n格式注册表：每种文件的视图 / 面板 / 状态行（M8-14）");
const openByName = async (suffix) => {
  const row = pg.locator('[role="treeitem"]').filter({ hasText: suffix }).first();
  if (!(await row.count())) return false;
  await row.click(); await pg.waitForTimeout(1200);
  return true;
};

/* ⚠️ 底部状态行在 M8-16 整条去掉了（用户实测第 9 / 13 条），所以这一节不再拿它当判据。
   `Status` 改到文件工具栏右端，而只有声明了 `Toolbar` 的格式才有那条横带 ——
   现在只有 JSON，所以 Status 这一环只在 JSON 那几条里测。
   设计稿和 Markdown 这里改测 View 与 Panels 两环。 */

/** 第九轮起**编辑栏和属性区都默认收起**（用户第 12 条「非必要的内容可以先收起」）。
 *  所以测它们内容之前要先点开。这两颗在 Tab 条右端，位置固定不跟着格式变。 */
const openEdit = async () => { const b = pg.locator('[data-ud="toggle-edit"]'); if (await b.count() && (await b.getAttribute("aria-pressed")) !== "true") { await b.click(); await pg.waitForTimeout(400); } };
const openProps = async () => { const b = pg.locator('[data-ud="toggle-props"]'); if (await b.count() && (await b.getAttribute("aria-pressed")) !== "true") { await b.click(); await pg.waitForTimeout(400); } };

/* 设计稿：画布（View）+ 属性面板（Panels）。它是唯一有五个面板的格式 */
if (await openByName(".dc.html")) {
  /* ⚠️ **「有个 iframe」不是判活**（纪律②）：稿加载失败时那个 iframe 照样在。
     真判据是穿两层看见东西 —— 外层是 S2 嵌入壳，内层才是稿本身。
     数得到内层的元素，就说明 postMessage 那座桥和稿的加载都通了。 */
  await pg.waitForTimeout(1200);
  const shellFrame = pg.frameLocator("iframe").first();
  const nested = await shellFrame.locator("iframe").count().catch(() => 0);
  ok(nested > 0, "设计稿：S2 嵌入壳里装着稿本身（View 环节）", `壳里 ${nested} 层`);
  const els = nested > 0 ? await shellFrame.frameLocator("iframe").first().locator("*").count().catch(() => 0) : 0;
  ok(els > 5, "设计稿：稿真的渲染出来了（不只是有个空 iframe）", `稿里 ${els} 个元素`);
  /* ⚠️ 「默认收起」只能钉在**最早的这一次打开** —— 后面几节会把它们点开，
     而 `layout.props` 还落盘。放到后面去测，量到的是上一节留下的状态（M8-28 真栽过）。 */
  ok(await pg.locator('[data-ud="toggle-edit"]').getAttribute("aria-pressed") === "false", "编辑栏默认收起（用户第 12 条）");
  ok(await pg.locator('[data-ud="props"]').count() === 0, "属性区默认收起（不留图标轨）");
  await openProps();
  ok(await pg.locator('[data-ud="props"]').count() === 1, "设计稿：属性区展开得出来（Panels 环节）");
} else ok(false, "项目里没有 .dc.html，测不了设计稿");

/* Markdown：大纲。**这一条最该测** —— 大纲原来是 Workbench 的一个 state，
   现在住在 md 模块自己的 Provider 里（View 产出、Panels 消费）。
   接错了的症状是「右边那一列空着」，静态检查抓不到。 */
if (await openByName(".md")) {
  await openProps();
  ok(await pg.locator('[data-ud="props"]').count() === 1, "Markdown：属性区里是大纲（它跨了 View 与 Panels 两处）");
} else ok(false, "项目里没有 .md，测不了 Markdown");

/* JSON：M8-14 新加的一种。**它存在就是「加一种格式只需新增一个文件」的证据** */
if (await openByName(".json")) {
  /* ⚠️ 第九轮把「这份文件的读数」从工具栏拿掉了：工具栏变成了**编辑栏**，
     只放改稿用的开关。读数没有新家 —— 设计侧这一轮没给它安排位置，先不测。 */
  await openEdit();
  /* 这两档现在在**统一的文件工具栏**上（M8-15 把它从视图内部搬了出来），
     所以判据要落在那条带上 —— 落在 body 上的话，搬没搬都一样过，测不出东西。 */
  const tb = pg.locator('[data-ud="file-toolbar"] [role="group"][aria-label="视图"]').first();
  ok(await tb.count() > 0, "JSON：视图段组在编辑栏上");
  const tbText = await tb.innerText().catch(() => "");
  ok(/结构/.test(tbText) && /源码/.test(tbText), "JSON：结构 / 源码两档都在", tbText.replace(/\n/g, " / "));
  ok(await pg.locator('[data-ud="tabbar"] button[title="更多"]').count() > 0, "JSON：文件 ⋯ 在 Tab 条右端（第九轮从工具栏挪过来）");
} else console.log("  – 项目里没有 .json，跳过新格式那一条（不算通过）");

/* ── 文件工具栏（M8-15b）──
   四种格式的开关都从各自视图内部搬到了统一那条 34px 横带。
   **「搬干净了」的判据不是「工具栏里有」，而是「别处没有」** ——
   搬一半的症状是同一组开关出现两次（一条在工具栏、一条还在视图里），
   而「工具栏里有」这个判据对搬一半的情况照样通过。 */
console.log("\n文件工具栏：四种格式的开关都上移了（M8-15b · 设计侧第七轮第四层）");
const bar = () => pg.locator('[data-ud="file-toolbar"]');
const countIn = async (loc, re) => (((await loc.innerText().catch(() => "")).match(re) ?? []).length);
const pageCount = async (re) => (((await pg.locator("body").innerText()).match(re) ?? []).length);

for (const [suffix, label, probe] of [
  [".md", "Markdown", /渲染/g],
  [".dc.html", "设计稿", /画布/g],
  [".json", "JSON", /结构/g],
]) {
  if (!(await openByName(suffix))) { ok(false, `${label}：项目里没有这种文件`); continue; }
  await openEdit();
  const inBar = await countIn(bar(), probe);
  const onPage = await pageCount(probe);
  ok(inBar >= 1, `${label}：开关在统一工具栏上`, `工具栏里 ${inBar} 处`);
  /* 整页只该出现一次。多于一次 = 视图里还留着一条没搬走的工具栏。 */
  ok(onPage === inBar, `${label}：视图里没有第二条工具栏`, `整页 ${onPage} 处 · 工具栏里 ${inBar} 处`);
}
/* 目录：工具栏有「范围」「排布」两组，而面包屑该留在视图里（它是内容不是开关）。
   ⚠️ 进目录视图的入口第八轮换了：`⤢` 删掉，改成**点目录列头的项目名**（或右键 / 双击）。 */
await pg.locator('button[title="回到项目根（右键：对项目根的操作）"]').first().click(); await pg.waitForTimeout(1300);
await openEdit();
ok(await bar().locator('[role="group"][aria-label="范围"]').count() === 1, "目录：范围组在工具栏上");
ok(await bar().locator('[role="group"][aria-label="排布"]').count() === 1, "目录：排布组在工具栏上");
ok(await countIn(bar(), /全部/g) === 1, "目录：范围开关只有一份");

/* ── 目录右键菜单（M8-21 · 设计侧第八轮 §五）──
   按**右键点在什么上**分三种。这里每种测一条「该有的」和一条「不该有的」——
   「新建只出现在目录和空白处」这条规则，只测该有的话是测不出来的。 */
console.log("\n目录右键菜单：三套（M8-21 · 设计侧第八轮 §五）");
const ctxText = async () => (await pg.locator('[data-ud="ctxmenu"]').innerText().catch(() => "")).replace(/\n/g, " / ");
const closeCtx = async () => { await pg.keyboard.press("Escape"); await pg.waitForTimeout(250); };

const ctxDirRow = pg.locator('[role="treeitem"][aria-expanded]').first();
if (await ctxDirRow.count()) {
  await ctxDirRow.click({ button: "right" }); await pg.waitForTimeout(400);
  const t = await ctxText();
  ok(/新建稿件/.test(t) && /新建目录/.test(t), "右键目录：有「新建稿件 / 新建目录」", t.slice(0, 70));
  ok(/在详情区打开/.test(t), "右键目录：有「在详情区打开」（接走了原列头的 ⤢）");
  ok(/移到回收站/.test(t) && !/删除/.test(t), "右键目录：写的是「移到回收站」不是「删除」");
  ok(!/重建索引/.test(t), "右键目录：**没有**重建索引（它作用于整个项目，只在空白处出）");
  await closeCtx();
} else ok(false, "树里没有目录行");

const fileRow = pg.locator('[role="treeitem"]:not([aria-expanded])').first();
if (await fileRow.count()) {
  await fileRow.click({ button: "right" }); await pg.waitForTimeout(400);
  const t = await ctxText();
  ok(/重命名/.test(t) && /移到回收站/.test(t), "右键文件：有重命名和移到回收站", t.slice(0, 70));
  ok(!/新建稿件/.test(t) && !/新建目录/.test(t), "右键文件：**没有**新建（在文件上说不清建在哪）");
  await closeCtx();
} else ok(false, "树里没有文件行");

/* 在**项目名**上右键 = 空白处菜单。树一满就没有空白区可点，所以列头这条路是主入口。 */
await pg.locator('button[title="回到项目根（右键：对项目根的操作）"]').click({ button: "right" });
await pg.waitForTimeout(400);
{
  const t = await ctxText();
  ok(/重建索引/.test(t), "右键空白处：有重建索引（空白处 = 项目根）", t.slice(0, 70));
  ok(/全部折叠/.test(t), "右键空白处：有「全部折叠」（从列头搬进来的）");
  await closeCtx();
}

/* ⋯ 是工具栏上**点得到才有用**的那一颗（体检、对比上一版都在里面）。
   窄下来时该让的是读数和演示，不是它 —— M8-24 量出来它会被挤到可视区外 7px。 */
{
  /* `⋯` 第九轮搬到了 Tab 条右端，和 ✎ ◨ 一组，位置固定不跟着格式变 —— 
     它再也不会被编辑栏的内容挤出去了。 */
  const tb = pg.locator('[data-ud="tabbar"]');
  const bx = await tb.boundingBox();
  const mx = await tb.locator('button[title="更多"]').boundingBox();
  ok(!!bx && !!mx && mx.x + mx.width <= bx.x + bx.width + 1, "Tab 条右端的 ⋯ 在可视区内",
     bx && mx ? `⋯ 右缘 ${Math.round(mx.x + mx.width)} · Tab 条右缘 ${Math.round(bx.x + bx.width)}` : "量不到");
}

/* ── 浮层形制（M8-28 · 设计侧第九轮 §四）──
   判据钉的是**会回归的那几样**：菜单类没写死宽度（写死过 224，长项被截）、
   菜单行 28 高、进场动画认方向、键盘 ↑↓ 能走。
   ⚠️ 不钉具体像素以外的观感 —— 那要看截图，静态判据看不出来。 */
console.log("\n浮层形制：宽度 · 行高 · 进场方向 · 键盘（M8-28）");
{
  /* 右键目录起一个菜单类浮层（`ctxmenu`）—— 它是「不给固定宽」的那一类 */
  const row = pg.locator('[role="treeitem"]').first();
  await row.click({ button: "right" }); await pg.waitForTimeout(400);
  const menu = pg.locator('[data-ud="ctxmenu"]');
  ok(await menu.count() === 1, "右键起得出菜单浮层");
  const box = await menu.evaluate((e) => { const r = e.getBoundingClientRect(); const c = getComputedStyle(e);
    return { w: r.width, h: r.height, minW: c.minWidth, maxW: c.maxWidth, anim: c.animationName, pad: c.paddingTop }; }).catch(() => null);
  ok(box && box.w >= 200 && box.w <= 320, "菜单按内容撑，落在 200–320 之间（原稿 popMinW / max-width）", box && `${Math.round(box.w)}px`);
  ok(box && (box.anim === "popDown" || box.anim === "popUp"), "进场动画认方向（下方展开 popDown / 翻到上面 popUp）", box && box.anim);
  ok(box && box.pad === "4px", "菜单类内边距 4px（原稿 popPad）", box && box.pad);
  const rowH = await menu.locator('[role="menuitem"]').first().evaluate((e) => e.getBoundingClientRect().height).catch(() => 0);
  ok(Math.abs(rowH - 28) < 1.5, "菜单行 28 高（七处原来是 28 / 30 各写一遍）", `${Math.round(rowH)}px`);
  /* 键盘：↑↓ 把焦点挪到菜单项上。**这一条钉的是漫游焦点那段** ——
     原稿用自己的 `popActive` 下标，我们换成查 DOM + focus，换错了的症状是「键盘完全不动」 */
  await pg.keyboard.press("ArrowDown"); await pg.waitForTimeout(200);
  const onItem = await pg.evaluate(() => document.activeElement?.getAttribute("role") === "menuitem");
  ok(onItem, "↓ 把焦点落到菜单项上（键盘能走菜单）");
  await pg.keyboard.press("End"); await pg.waitForTimeout(200);
  const atEnd = await pg.evaluate(() => { const m = document.querySelector('[data-ud="ctxmenu"]');
    const b = m && Array.from(m.querySelectorAll('[role="menuitem"]:not([disabled])'));
    return !!b && b[b.length - 1] === document.activeElement; });
  ok(atEnd, "End 跳到最后一项");
  await pg.keyboard.press("Escape"); await pg.waitForTimeout(300);
  ok(await pg.locator('[data-ud="ctxmenu"]').count() === 0, "Esc 收掉");
}

/* ── ⌘E / ⌘⌥B 开合（M8-28 · 设计侧第九轮 §三）──
   **这一节和默认值无关**，只问「按了会不会变」：先归一到收起，再开、再收。 */
console.log("\n详情三层的开合：⌘E · ◨（M8-28）");
if (await openByName(".dc.html")) {
  await pg.waitForTimeout(1200);
  const editBtn = pg.locator('[data-ud="toggle-edit"]');
  const pressed = async () => (await editBtn.getAttribute("aria-pressed")) === "true";
  if (await pressed()) { await editBtn.click(); await pg.waitForTimeout(400); }
  /* ⚠️ 这条判据钉的是**依赖数组**：keydown 那个 effect 漏了 `setEditOpen`，
     闭包就捕获上一个文件的 key，编辑栏开在**别的文件**上 ——
     症状是「按了没反应」，而分支明明进去了（M8-28 真栽过，正是用户第 11 条）。 */
  await pg.keyboard.press("Meta+e"); await pg.waitForTimeout(500);
  ok(await pressed(), "⌘E 展开编辑栏（焦点在稿外）");
  /* ⚠️ **数得到 `file-toolbar` 不算展开** —— 收起时那个 div 高度是 0 但元素还在
     （为了做动画刻意不卸载）。要量真高度。 */
  const h = await pg.locator('[data-ud="file-toolbar"]').evaluate((e) => e.getBoundingClientRect().height).catch(() => 0);
  ok(h > 20, "编辑栏真的有高度，不是只挂着个元素", `${Math.round(h)}px`);
  await pg.keyboard.press("Meta+e"); await pg.waitForTimeout(500);
  ok(!(await pressed()), "⌘E 再按一次收起");
  /* ⚠️ **焦点在稿里也要生效**（M8-29，用户报的「时灵时不灵」）。
     键盘事件不跨 iframe 边界，所以快捷键挂在顶层 **和每一个同源 iframe 的 document** 上。
     判据里把焦点真塞进最内层的稿 —— 判它进没进去只能看**顶层** `activeElement` 变成 IFRAME，
     每个 document 自己的 `activeElement` 默认就是 BODY，拿它当判据等于没判。 */
  const into = await pg.evaluate(() => {
    const f = document.querySelector("iframe"); if (!f) return null;
    const d = f.contentDocument; const g = d && d.querySelector("iframe"); const gd = g && g.contentDocument;
    if (!gd) return null;
    const el = gd.createElement("button"); el.style.cssText = "position:fixed;left:0;top:0;opacity:0";
    gd.body.appendChild(el); el.focus();
    return document.activeElement?.tagName === "IFRAME" && gd.activeElement === el;
  });
  if (into) {
    await pg.keyboard.press("Meta+e"); await pg.waitForTimeout(500);
    ok(await pressed(), "⌘E 在**焦点落进稿里**时照样生效（事件不跨 iframe，所以挂到同源 iframe 上）");
    await pg.keyboard.press("Meta+e"); await pg.waitForTimeout(400);
  } else ok(false, "塞不进稿里的焦点，这条没测成（不是通过）");
  ok(await pg.locator('[data-ud="corner"]').count() === 1, "正文右下角的浮块常驻（看稿用的不跟着收）");
  const propsBtn = pg.locator('[data-ud="toggle-props"]');
  const pOn = async () => (await pg.locator('[data-ud="props"]').count()) === 1;
  if (await pOn()) { await propsBtn.click(); await pg.waitForTimeout(500); }
  await propsBtn.click(); await pg.waitForTimeout(500);
  ok(await pOn(), "点 ◨ 展开属性区");
  await propsBtn.click(); await pg.waitForTimeout(500);
  ok(!(await pOn()), "再点收起（完全收掉，不留图标轨）");
} else ok(false, "项目里没有 .dc.html");

/* ── 页签三态（M8-28 · 设计侧第九轮 §六）──
   用户第 8 条：「不应每次查看一个详情就多新增一个」。
   **最要害的判据是「单击第二个文件之后，页签数没有变多」** ——
   只测「有预览态样式」的话，覆盖逻辑坏掉了照样过。 */
console.log("\n页签三态：预览 / 打开 / 固定（M8-28）");
{
  /* ⚠️ **必须从干净状态开始**：前面的测试开过好几个页签，而「盖不盖」这件事
     取决于被点的文件在不在页签里 —— 不清干净的话，判据量到的是别的东西
     （M8-28 实测：第一次写的判据 3→4 和 4→4 自相矛盾，就是这个原因）。 */
  const tabs0 = pg.locator('[data-ud="tab"]');
  while (await tabs0.count() > 0) {
    await tabs0.first().click({ button: "right" }); await pg.waitForTimeout(350);
    const saved = pg.locator('[data-ud="tabmenu"]').getByText(/^关闭已保存的$/);
    if (await saved.count()) { await saved.click(); await pg.waitForTimeout(500); }
    else { await pg.keyboard.press("Escape"); break; }
    if (await tabs0.count() > 0) { await pg.keyboard.press("Escape"); break; }   // 关不动了（都是未保存/固定）
  }
  ok(await tabs0.count() === 0, "先把页签清干净", `剩 ${await tabs0.count()} 个`);
  const files = pg.locator('[role="treeitem"]:not([aria-expanded])');
  const n = await files.count();
  if (n >= 2) {
    await files.nth(0).click(); await pg.waitForTimeout(900);
    const after1 = await tabs0.count();
    ok(await pg.locator('[data-ud="tab"][data-preview]').count() === 1, "单击目录里的文件 → 预览页签", `${after1} 个页签`);
    await files.nth(1).click(); await pg.waitForTimeout(900);
    const after2 = await tabs0.count();
    /* 这一条是要害：单击下一个只**盖掉**预览页签，不新增 */
    ok(after2 === after1, "再单击另一个：盖掉预览页签，页签数没变多", `${after1} → ${after2}`);
    ok(await pg.locator('[data-ud="tab"][data-preview]').count() === 1, "同一时间最多一个预览页签");
    /* 双击 → 转正 */
    await files.nth(1).dblclick(); await pg.waitForTimeout(900);
    ok(await pg.locator('[data-ud="tab"][data-preview]').count() === 0, "双击转正（不再是预览态）");
    const after3 = await tabs0.count();
    await files.nth(0).click(); await pg.waitForTimeout(900);
    ok(await tabs0.count() === after3 + 1, "转正之后再单击别的：新开一个，不盖它", `${after3} → ${await tabs0.count()}`);
  } else ok(false, "树里文件不够两个，测不了覆盖");

  /* 右键菜单：三个「关闭…」要写出真会关掉的个数 */
  const anyTab = pg.locator('[data-ud="tab"]').first();
  await anyTab.click({ button: "right" }); await pg.waitForTimeout(500);
  const menu = await pg.locator('[data-ud="tabmenu"]').innerText().catch(() => "");
  ok(/关闭其他/.test(menu) && /个/.test(menu), "页签右键：三个「关闭…」写出真会关掉的个数", menu.replace(/\n/g, " / ").slice(0, 80));
  ok(/固定/.test(menu) && /在目录中显示/.test(menu), "页签右键：有固定和「在目录中显示」");
  await pg.keyboard.press("Escape"); await pg.waitForTimeout(300);
}

/* ── 浮层统一封装（M8-25 · 用户第九轮第 2 条）──
   三个缺陷是同一个问题的三种长相：7 处各写各的浮层，各漏一样。
   现在只有 `ui/Popover.tsx` 一份，这三条判据钉住它。 */
console.log("\n浮层：不越界 / 点外面收起 / 不被 overflow 裁掉（M8-25）");
{
  /* ① 引擎下拉原来写死 `absolute right-0`，在 380px 的会话栏里左边会出窗口 */
  const eng = pg.locator('aside button[data-ud="engine"]').first();
  await eng.click(); await pg.waitForTimeout(400);
  const pop = pg.locator('[data-ud="popover"]').first();
  const pb = await pop.boundingBox();
  ok(!!pb && pb.x >= 0 && pb.x + pb.width <= 1440, "浮层不越出窗口左右边界",
     pb ? `left ${Math.round(pb.x)} · right ${Math.round(pb.x + pb.width)}` : "量不到");
  /* ② 原来引擎下拉少了接外部点击那一层，开着就关不掉 */
  await pg.mouse.click(700, 500); await pg.waitForTimeout(400);
  ok(await pg.locator('[data-ud="popover"]').count() === 0, "点浮层外面就收起");

  /* ⚠️ **点在稿上（iframe 里）也要收起** —— 这是那个 bug 的另一半：
     事件被 iframe 吃掉，外面的 document 监听收不到。浮层开着时让 iframe 不接事件。
     只测「点外面」的话这一半测不出来（M8-28 实测：修完第一半之后它还在）。 */
  if (await openByName(".dc.html")) {
    await pg.waitForTimeout(1500);
    await pg.locator('[data-ud="tabbar"] button[title="更多"]').click();
    await pg.waitForTimeout(400);
    const fr = await pg.locator("iframe").first().boundingBox();
    if (fr && await pg.locator('[data-ud="popover"]').count() === 1) {
      await pg.mouse.click(fr.x + fr.width / 2, fr.y + fr.height / 2);
      await pg.waitForTimeout(500);
      ok(await pg.locator('[data-ud="popover"]').count() === 0, "点在稿上（iframe 里）也收起");
    } else ok(false, "没开出浮层或没有 iframe");
  }

  /* ③ Markdown 的 ⋯ ——「弹不出来」的根因是浮层用 absolute，
        被文件工具栏的 overflow-hidden 整个裁掉了。现在它是 fixed。
        （第九轮把 ⋯ 从编辑栏挪到了 Tab 条右端，判据跟着挪。） */
  if (await openByName(".md")) {
    await pg.locator('[data-ud="tabbar"] button[title="更多"]').click();
    await pg.waitForTimeout(400);
    const more = pg.locator('[data-ud="popover"]').first();
    const mb = await more.boundingBox();
    ok(await more.count() === 1, "Markdown 的 ⋯ 弹得出来了");
    /* 判据落在「它整个在视口里」，而不是「它存在」—— 被裁的时候它也存在 */
    ok(!!mb && mb.height > 20 && mb.y + mb.height <= 900 + 1, "而且没被工具栏的 overflow 裁掉",
       mb ? `高 ${Math.round(mb.height)} · 底 ${Math.round(mb.y + mb.height)}` : "量不到");
    await pg.keyboard.press("Escape"); await pg.waitForTimeout(300);
  } else ok(false, "项目里没有 .md");
}

/* ── 页签（M8-22 · 设计侧第八轮 §六）── */
console.log("\n页签：状态点 / 溢出 / 当前态（M8-22）");
{
  /* 开三份文件，看页签的形制 */
  for (const n of [".md", ".json", ".dc.html"]) await openByName(n);
  const tabs = pg.locator('[data-ud="tab"]');
  ok(await tabs.count() >= 2, "页签条里有多个页签", `${await tabs.count()} 个`);
  ok(await pg.locator('[data-ud="tab"][data-current]').count() === 1, "当前页签只有一个，且标成了凸起块");
  /* 体检状态**不该**上页签（它在树、诊断角标、诊断面板三处）。
     旧实现是每个页签都挂一颗 hdot —— 用户把它读成了「未保存」。 */
  ok(await pg.locator('[data-ud="tab"] .hdot').count() === 0, "页签上没有体检点了（只留未保存）");
}

/* ── 引擎是会话的属性（M8-16，用户实测第 7 条）──
   撞到的场景：会话在火山方舟上 → 选成 Claude → 新建一条 → 再切回来，**又变回火山方舟**。
   根因是选引擎只改了前端 state 和 localStorage，没写进会话文件，而 `chat_get` 读的是文件。
   **判据用刷新页面代替「切走再切回」** —— 刷新之后前端从零开始，
   引擎只能是从会话文件里读回来的，这比在界面里绕一圈更直接、也不需要第二条会话。 */
console.log("\n引擎跟着会话走（M8-16 · 用户实测第 7 条）");
const engineBtn = () => pg.locator('aside button[data-ud="engine"]').first();
const engName = async () => (await engineBtn().innerText()).replace(/[\n▾]/g, " ").trim();
const before = await engName();
await engineBtn().click(); await pg.waitForTimeout(400);
let switched = null;
for (const c of ["b", "a", "c"]) {
  const o = pg.locator(`aside [data-ud="engine-opt-${c}"]`);
  if (await o.count() && (await o.getAttribute("aria-pressed")) !== "true") { switched = (await o.innerText()).split("\n")[0].trim(); await o.click(); break; }
}
if (!switched) { console.log("  – 只配了一个引擎，这条测不了（不算通过）"); }
else {
  await pg.waitForTimeout(900);
  ok((await engName()).includes(switched.split(" ")[0]), "换引擎后钮上跟着变", `${before} → ${await engName()}`);
  await pg.reload({ waitUntil: "domcontentloaded" });
  await pg.waitForFunction(() => document.querySelectorAll('[role="treeitem"]').length > 0, null, { timeout: 30000 });
  await pg.waitForTimeout(1800);
  const after = await engName();
  ok(after.includes(switched.split(" ")[0]), "刷新后还是它（说明写进会话文件了，不只是 localStorage）", `刷新后 ${after}`);
  /* 还原成原来的引擎 —— 这是用户的项目数据，回归不该留下痕迹 */
  await pg.locator('aside button[data-ud="engine"]').first().click(); await pg.waitForTimeout(400);
  for (const c of ["a", "b", "c"]) {
    const o = pg.locator(`aside [data-ud="engine-opt-${c}"]`);
    if (await o.count() && (await o.innerText()).split("\n")[0].trim() === before) { await o.click(); break; }
  }
  await pg.waitForTimeout(700);
}

console.log("\n控制台");
ok(errs.length === 0, "零 error（已排除解析期的模板洞噪声）", errs[0] ?? "");

console.log(`\n${fail ? "✗" : "✓"} 界面回归 ${pass}/${pass + fail}\n`);
await b.close();
process.exit(fail ? 1 : 0);
