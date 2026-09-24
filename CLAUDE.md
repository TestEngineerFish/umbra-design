# 接手 Umbra Studio · 给下一个 Agent 的须知

读完这一份再动手。全文约 5 分钟。

---

## 1. 这是什么

**Umbra Studio（原名 UmbraDesign，2026-09-23 转向）：一个目录工作台。** 打开一个目录，左边和 AI 对话，
右边看选中的文件；按文件类型给不同的预览与编辑方式；设计稿 `.dc.html` 是它最深的一种类型 ——
一份文件同时是设计稿、规范出处和可运行原型，S1–S10 那套能力全部保留。

判据：**做一个和 One Claude 里「对话 + 产物」基本一样的工作台，最大的不同是产物在你的目录里，任何模型都能接。**
三种编辑方式都在同一个窗口里：① 手动改 · ② 选中后让 AI 改 · ③ 直接和 AI 说。

同一套能力暴露成本地 MCP server：外部模型客户端直接连，**Umbra 秘书把它当文件面**（`01` §4.8）。
第一期 PC + Web 同一份前端（`01` §4.9），移动端后期走 Web 版。

**改名已执行**（`12` M7-1，2026-09-24，`00` §四十九）：本地目录 `Geek/UmbraStudio`、包名 `umbrastudio-server`、MCP 名 `umbrastudio`、配置目录 `.umbrastudio/`（旧 `.umbradesign/` 第一次打开时自动拷成新名，旧目录不删）、环境变量 `UMBRASTUDIO_*`。**格式与协议级标识不改**：`<!-- umbradesign:resources -->` 等注释标记、postMessage 的 `source`、`data-ud-node`、`x-ud-token` 照旧（`.dc.html` 格式名不改，Q28）。GitHub 仓库改名由用户操作。

---

## 2. 按这个顺序读文档

| 顺序 | 文件 | 为什么 |
| --- | --- | --- |
| 1 | `doc/01-产品需求文档.md` | 要什么、硬约束、验收标准。**2026-09-20 重写过**，以它为准 |
| 2 | `doc/12-待办清单.md` | 做到哪了（73 条，64 条完成）、下一步是哪条 |
| 3 | `doc/11-路线图与分期.md` | 分期理由、架构演进、已定决策 Q1–Q10 |
| 4 | `doc/00-MCP 工具契约.md` | 动手前全程对照。§十起是逐批实现记录，抓坑很有用 |
| 5 | `doc/04` §二 | **排查纪律**。这一节救过很多时间，不读会重犯 |
| 5.5 | `doc/16-ClaudeDesign 对照调研.md` | ClaudeDesign 本尊长什么样、我们差在哪（实见 + 资料）；待拍板项在 `doc/11` Q13–Q15 |
| 5.6 | `doc/18-方向调研：目录工作台.md` | 2026-09-23 用户提的新方向（打开任意目录、按类型预览 / 编辑、AI 在侧）的调研；**Q18–Q24 待拍板，拍板前不要按它改代码** |
| 6 | `doc/14-给 ClaudeDesign 的交办单.md` §零 + `doc/00` §三十二 | 和设计侧怎么往来、它现在欠什么（见本文 §5） |
| 按需 | `02` 格式 · `03` 运行时语义 · `06` 写稿规则 · `07` 变更交付 | 改到哪块读哪块 |

`doc/README.md` 有完整导航和**职责边界表** —— 新增文档前必读那张表，
每份文件只管一件事，重合是要修的问题。

---

## 3. 先把它跑起来（三分钟）

```bash
npm --prefix server install
npm --prefix server run build
npm --prefix app install && npm --prefix app run build    # 新前端（M7-2）；没 build 过 /__app/ 会退回旧前端

npm --prefix server run selftest     # 静态回归：基准 + 界面稿 + 语料
npm --prefix server run rendertest   # 渲染回归：真开浏览器（没 Chrome 会整块跳过）
```

`selftest` 的正常输出末行是：

```
✓ 基准全过 · 界面稿零 error · 语料零误报
```

**看到别的就先修它，别往下做。**

自己看界面：

```bash
npm --prefix server run ui -- Umbra_design
```

起本地 http、建索引、打开浏览器里的**应用页面**（`/__app/` = `app/dist`），然后停在前台
（回车重跑索引，Ctrl-C 退出）。前端没 build 过会给一句提示。
S1 稿件索引那一页仍在 `index.dc.html`，只是不再当入口。

桌面壳（Electron，M9-2）：`npm --prefix shell install`（Electron 二进制走 npmmirror，见 `shell/.npmrc`）→ `npm --prefix shell start`。
壳测试：`node shell/shelltest.mjs`（先把里面的 `<scratchpad>` 换成放测试项目副本的目录）。
打包：`npm --prefix shell run dist:all` → `shell/out/` 出四份（mac arm64/x64 · win x64/arm64）。
**打包产物要单独验**：`npm --prefix shell run packtest` —— 它把 .app 拷到仓库外、配一个全新 userData
再跑一遍，问的是「换台机器还能不能用」。这一类缺陷开发模式下测不出来，M9-4 一次逼出三条（`doc/00` §六十三）。

当 MCP 用（给别的模型客户端）：

```bash
claude mcp add umbrastudio -- node <仓库绝对路径>/server/dist/index.js
```

细节见根目录 `README.md`。

---

## 4. 下一步做什么

转向 Umbra Studio 的依据 `doc/18`，决策 `doc/11` Q18–Q33，条目 `doc/12` M7–M10。**顺序以 `doc/12` §〇.2 为准。**
**M7 / M8 / M9-1..4 全部完成**（`00` §五十二–§六十三）：新前端 + host adapter + HTTP/WS + 布局引擎、
旧 vanilla 前端已删、第一批类型（目录 / `.md` / 图片）三件套闭环、Electron 壳 + 自带 Chromium 体检 + 四份打包产物。

下一步两条，按这个顺序：

1. **M9-6 win 真机第一次跑** —— 把 `shell/out/Umbra Studio-0.1.0-win-x64.zip` 解到一台 Windows 上走
   `01` 第 35 条的流程。**需要用户有 Windows 机器**，我这边只验到结构（`00` §63.5）
2. **M10** 第二批类型 + 秘书接入（`11` Q27 / Q29）。Web 版用户已说不排期

每做完一条更新 `doc/12` 的状态与进度表，读数写进 `doc/00`。设计侧第五轮已收完并入，下一轮尚无交办。

**纪律**：前端只有 `app/` 一份（旧 vanilla 前端已于 M7-8 删除）。
key 只放 `.umbrastudio/ai_config.json`，**不进仓库、不写进任何文档**。
核心里**只读资产看 `TOOL_ROOT`，可写状态看 `STATE_ROOT`** —— 打包后前者在 `.app` 里（只读），
后者在 userData。新加会落盘的东西时想清楚是哪一类，混了在开发模式下测不出来（`00` §63.1）。
通道：**A** 直连 OpenAI 兼容端点（按量）· **B** 子进程 Claude Code · **C** 火山方舟 Agent Plan 订阅（OpenAI 兼容，`…/api/plan/v1`）。
默认走 `defaultChannel`；C 遇到额度类错误且这一轮没调过工具时自动退回 A（`11` Q33，`00` §六十二）。
**通道 B = 本地 CLI 这一类**（`11` Q34 / Q35，`00` §六十四、§六十五）：`channelB.cli` 选哪个，
缺省 `claude`。这些 CLI 走**登录态**而不是 API key —— 用户已经在付的订阅能直接用上。
实测跑通的是 `claude` / `cursor-agent` / `codex` 三家；`gemini` / `opencode` 按文档写、标 `verified:false`，
**别把没验过的说成验过了**。`cli: "claude"` 且 `baseUrl`/`apiKey` 都填了才是走自配的 Anthropic 端点。
能力不齐要照实说：gemini 只有纯文本（看不到工具行）、cursor-agent 不报用量、
cursor / opencode 要往项目里落一个 MCP 配置文件（**写的时候必须合并，别覆盖用户已有的 server**）。
**按文档写的适配器字段一律当没验过** —— codex 那三个字段实测全是错的（`00` §65.6）。
调不通时先 `UMBRASTUDIO_CHANNEL_B_LOG=<文件>` 把原始事件流落盘再看 —— 这类通道是黑盒，猜不出来。

---

## 5. 设计侧（ClaudeDesign）：现状与你要做的

你可以**通过 MCP 直接连 ClaudeDesign 的项目**看稿、放文件、取文件，不再经用户中转。
项目：`https://claude.ai/design/p/26c16030-ab11-411c-a5e9-3beb734e6982`（id `26c16030-ab11-411c-a5e9-3beb734e6982`，名 UmbraDesign —— 云端项目名未改）。
工作方式按 `claude-design-sync` 技能：交办单与回执写进它的 `uploads/`，用户只在它的 chat 里说一句「读 uploads/xxx 照做」；
它做完用户说一声，我们按 etag 找改动、取回、过 `incoming`。**我们只读它的设计文件，不改、不删。**
⚠️【判断】ClaudeDesign MCP 具体有哪些工具（能不能上传文件、能不能发消息）我这边没验证过，
先列一次它的工具再定做法；**如果不能上传文件，就打包后请用户转交**，协议不变。

### 5.1 为什么要有协议（2026-09-21 的事故，`doc/00` §三十二）

ClaudeDesign 的项目在云端，**只拥有被上传过的东西**。之前只发文档不发文件，结果：
它没有 S6 / S8 / S9 / S10；它的 S1 / S2 是接线前的老底稿，
照交办单改完交回来丢了全部接线（S1 少 27 个键，S2 少 54 个键）。
**它的形制判断是对的，底稿是错的。** 那一轮的 S1 / S2 已判废，不要移植。

### 5.2 协议（工具化了，照着走）

1. `npm --prefix server run outgoing` → `outgoing/UmbraStudio-ui-<时间>.zip`
   （`ui/` 全套 11 份稿 + `_ds-tool` + `_demo` + 说明页；每份稿 `<head>` 后插一行 baseline 注释）。
   **ui/ 有改动就重新打包**，别发旧包
2. 把包里的文件**整体替换**进 ClaudeDesign 项目里的同名文件，连同 `doc/14` 一起给它
3. 它改完的稿（**必须保留 baseline 行**）取回来放进本地 `ui/_incoming/`
4. `npm --prefix server run incoming`：第一关查底稿 —— 「正确」才往下看；
   「过时」按提示做三方合并（共同祖先 = 对应 zip 里的同名文件）；「不明」直接退回让它在新底稿上重做
5. 过关后再把稿并进 `ui/`，跑 `selftest` + `rendertest` + 真开浏览器看一次，再提交

**绝不直接改 ClaudeDesign 那边的稿去"帮它修"**，也不把它的稿绕过 `incoming` 拷进 `ui/`。

### 5.3 截至 2026-09-22 的状态

| 项 | 状态 |
| --- | --- |
| 开发侧 `ui/` | S1–S10 + IconGlyph 共 11 份，全部可渲染、演示态可切、`selftest` 零 error |
| 最新发件包 | `outgoing/UmbraDesign-ui-20260921-1456.zip`；**ui/ 之后已变（第二轮并入 + M5-8/9 接线），下次发件前重新打包** |
| 第二轮 | ✅ 2026-09-23 收完：六份底稿正确、接线齐全，已并入；读数见 `doc/00` §三十三 |
| 第三轮 | ✅ 2026-09-23 收完：S1 行内撤销并入并接线（§四十五）；会话栏裁决与 M6-1 一致。发件包 `UmbraDesign-ui-20260923-0255` 经 MCP 放进它 `uploads/`（大文件的边界见 §四十一） |
| 本地 `ui/_incoming/` | 空（`incoming --apply` 并入后原件已移除） |

### 5.4 这一轮要设计侧交回什么（**2026-09-23：已全部交回并落地**；下一轮尚无交办，留档）

| # | 要它做的 | 在哪份稿上 | 交回后我们做 |
| --- | --- | --- | --- |
| 1 | 在**新底稿**上重做 §三：索引过期齐边横条 + 行级标记（`hasStale` / `staleHeadline` 等）、版本历史 352px 弹层（`versions[]`）、未落盘齐边横条（`hasUnsaved`，药丸写真实节点地址） | S1、S2 | `doc/12` M5-8、M5-9：按它的键名接真数据 |
| 2 | §二：给四屏定形制 | S6、S8、S9、S10 | 过 `incoming` 后并入，核对接线标记没丢 |
| 3 | §2.5：生命周期入口摆位建议 | S1 | 按建议调整 |

**不用它做、我们直接照办的**：它上一轮已给的裁决（`doc/14` §0.4：横条 vs 卡片口径、
失焦落盘保持现状、UI-1..UI-8）→ `doc/12` M5-10，**不必等它交回就能开工**。

**验收一轮设计往来的标准**：`incoming` 全部「底稿正确」、零 blocking；并入后 `selftest` 零 error、
`rendertest` 全过；S1 / S2 的接线标记（4/4、8/8）一个不少。

---

## 6. 六条纪律（都是踩出来的）

**① 唯一写入口。** 所有落盘走 `write_draft` 那条路（归一化 → `@ds` 展开 →
`__resources` 注入 → 节点地址 → 快照 → changelog）。界面编辑、AI 会话、
生命周期操作、工具自己生成的入口页，**一个都不例外**。
绕过它写出来的页会因为缺 `__resources` 而在断网时白屏（`00` §十五 实测踩过）。

**② 判活只认 `1+1`，不看截图。** 一张不对的截图和一个坏掉的页面长得一样。

**③ 不许误报。** 一条假的必改项能让设计侧白改上百处。
拿不准的一律不报（`04` §二）。

**④ 撤回一条判据之前，先证明仪器没被自己消音。**
真栽过：`render_check` 里有一行静音把某类控制台消息整段丢掉，
我拿那台被消音的仪器做反向验证，量到零，就撤了一条**真**判据。
「量到零」有两种可能：世界是零，或者仪器是零。分不清就不能撤回（`04` §2.7）。

**⑤ 每批收尾都要有读数。** 改完跑 `selftest` + `rendertest`；
动了界面就真开一次浏览器看，静态过了不等于画面对。
`fixtures/` 里每份基准都钉着一条**已经犯过的错** —— 只在真犯过之后才加新基准。

**⑥ `projects/` 下的东西不是我们的。** 那是用户自己的设计项目
（现在放着两个测试项目，随时可删，删了任何回归都不受影响）。
**开发侧不要手改里面的稿** —— 那些稿由这个软件本身和用它的 AI 来改。
回归里报出来的语料缺陷（比如 4 条 `E_HOLE_UNRESOLVED`）是工具在正常干活，不是待办。

---

## 7. 目录与命令速查

| 目录 | 是什么 | 进仓库 |
| --- | --- | --- |
| `doc/` | 需求、契约、规则、实测、路线图、待办 | ✅ |
| `server/` | MCP server + 本地 API + WS + CLI（Node + TS） | ✅（`dist/` 除外） |
| `app/` | 新前端（Vite + React + TS + Tailwind）；`src/host/` 是唯一碰壳的目录 | ✅（`dist/`、`node_modules/` 除外） |
| `shell/` | Electron 桌面壳：主进程起核心、preload 挂 `window.umbraHost`、`shelltest.mjs` | ✅（`node_modules/`、`out/` 除外） |
| `runtime/` | `support.js` + 两个 React UMD，**刻意 vendor** | ✅ |
| `ui/` | 工具自己的界面稿（S1–S10、IconGlyph）；`ui/_incoming/` 是收设计侧稿的暂存处，不进仓库 | ✅ |
| `outgoing/` | 给设计侧的发件包 | ❌ |
| `fixtures/` | 回归基准，每份钉一条犯过的错 | ✅ |
| `projects/` | **用户的设计项目** | ❌ |
| `issues/` | issue 草稿（按日期）+ `post.sh` 提交脚本，规范见 `doc/17` | ✅ |

| 命令 | 干什么 |
| --- | --- |
| `npm --prefix server run build` | 编译核心 |
| `npm --prefix app run build` | 编译新前端到 `app/dist`（`/__app/` 托管它） |
| `npm --prefix server run selftest` | 静态回归（三层判据） |
| `npm --prefix server run lifecycletest` | 生命周期回归（建/改/删/恢复全流程） |
| `npm --prefix server run filetest` | 泛型文件层回归（第二条写入口：写前校验 / 快照 / 回退 / 引用改写） |
| `npm --prefix server run rendertest` | 渲染回归（要浏览器） |
| `npm --prefix server run ui -- <项目名>` | 起界面给人用 |
| `npm --prefix server run outgoing` | 给设计侧打包 ui/（每份稿插 baseline 行），产出 `outgoing/UmbraStudio-ui-<时间>.zip`；**每一轮交办都要随附这个包**（`doc/00` §三十二） |
| `npm --prefix server run incoming` | 接设计侧交回来的稿（`ui/_incoming/`），先查底稿（正确 / 过时 / 不明），再查合法性与接线标记；加 `-- --apply` 把过关的稿并入 `ui/` |
| `npm --prefix shell start` / `run dist` | 起 Electron 壳 / 打包 mac arm64（`doc/00` §五十三、§六十三）；`run dist:all` 出四份产物（mac arm64/x64 dmg+zip、win x64/arm64 zip） |
| `npm --prefix shell run shelltest` | 壳的**源码**测试：Playwright `_electron` 走一遍主流程（先把里面的 `<scratchpad>` 换成放测试项目副本的目录） |
| `npm --prefix shell run packtest` | 打包**产物**测试：把 .app 拷到仓库外 + 全新 userData 再跑一遍（`doc/00` §63.4）。带参数验别的产物：`node shell/packtest.mjs shell/out/win-unpacked` |

---

## 7.5 装了哪些 skill（2026-09-24）

| skill | 什么时候用 | 为什么装它 |
| --- | --- | --- |
| `claude-design-sync` | 和 ClaudeDesign 往来 | 本项目的设计侧协议（`doc/14` §零） |
| `brainstorming` | **动手做新功能 / 改形制之前** | 它逼着先问清意图、写回理解、拿到确认再动手。用户 2026-09-24 明说过「重构和页面设计不要直接开工」 |
| `writing-plans` | 有了方案，要拆成可执行的步骤 | ⚠️ 它默认把计划写进 `docs/superpowers/plans/` —— **本项目不这么放**，计划进 `doc/12 待办清单`，读数进 `doc/00` |
| `verification-before-completion` | 声称"做完了/修好了"之前 | 「Evidence before claims」，和本文 §6 纪律⑤ 是同一条，措辞更狠：没在这条消息里跑过验证命令，就不能说它通过 |
| `refactor-advisor` | 要重构时 | 扫坏味道 + 分级。它的「按 git 变更频率排优先级」是我们原来没有的角度 |

**没装的，以及为什么**（免得下次有人再查一遍）：
`frontend-design`（视觉方向该走 ClaudeDesign，不是自己画）· `webapp-testing`（Python Playwright，
我们是 Node 且已有 `packtest.mjs`）· `skill-creator` / `writing-skills`（都是 100 KB 以上的
skill 评测框架，写一份项目规范用不着）· `brainstorming` 的 `scripts/`（25 KB 的可视化服务器，会在用户机器上起服务）。

**这些 skill 都不知道本项目的规矩** —— 唯一写入口、判活只认 1+1、不许误报、设计侧协议、
tokens 从哪来。那部分靠本文 §6 的六条纪律，skill 只是补上它们没覆盖的方法论。

---

## 8. 交活的规矩

1. **你自己提交，不用给用户贴 commit 文本。** 一件事做完、回归过了就提交一次，小步走；
   不要把没跑过回归的改动提交上去。**push 前先问用户**（【判断】用户只授权了提交）。
2. 提交到对的仓库：工具仓库是 `Geek/UmbraStudio`；`projects/` 下每个设计项目各自是一个仓库，
   **开发侧不往那里提交**。
3. commit 信息不要长：改了什么、为什么、实测读数（例如「selftest 19/19 · rendertest 15/15」）。
   末尾照你所在环境的规矩带署名。
3.5 **`git checkout` / `git restore` 一律带具体路径，永远不写 `.` 或 `-A`。**
   2026-09-24 栽过：清理测试残留时在仓库根跑了 `git checkout -- .`，把当时所有未提交的改动一起撤了；
   而 `dist` 是撤销前构建的，那一轮测试照样全过 —— 源码已经回退，跑的是旧产物（`00` §六十之一）。
   要清理测试产物就直接 `rm` 那个目录。
4. 结论要分清是**判断**还是**有依据的结论**；涉及技术可行性要明确标能不能做，
   不要产出实现不了的方案。
5. 需要用户拍板的问题**集中列在一处**（回复末尾一节），不要散落在文档正文和回复各处；
   新的不确定项登记到 `doc/11` §四下面。
6. 能查资料定下来的事自己查了定，别让用户跑几轮实测。
7. 每做完一批，更新 `doc/12`（状态 + 进度表）和本文 §9，别让状态列说谎。

---

## 9. 当前状态一句话（2026-09-24）

**2026-09-24 一整天的进展，按批**（每批读数在 `doc/00` 对应章节）：

| 批 | 做了什么 | 章节 |
| --- | --- | --- |
| M7-1 | 改名 UmbraDesign → Umbra Studio（格式与协议级标识不改） | §四十九 |
| M9-1 / M9-2 / M9-3 | 壳 spike → Q26 定 Electron → Electron 壳 + 自带 Chromium 跑体检；Tauri 已删 | §五十、§五十三 |
| M7-2..M7-8 | `app/` 新前端（Vite+React+TS+Tailwind）、host adapter、事件总线 + WS、平移全部能力、布局引擎 R1–R5、**旧 vanilla 前端删除** | §五十二、§五十五、§五十七 |
| M7-9 + 设计侧 | 第四轮（S11）与第五轮（S12–S15 + S1/S9）都已收完并入，零 blocking | §五十一、§五十六 |
| M8-1..M8-10 | 泛型文件层（**第二条写入口** `write_file`）、目录视图、多选进会话、通用文件卡、`.md` 三件套、图片视图 + 圈选给 AI | §五十八–§六十一 |
| 通道 C | 火山方舟 Agent Plan 订阅，与 A 同形走同一条 agent 循环；额度用完自动退回 A | §六十二 |
| M9-4 | 三平台打包：mac arm64/x64 dmg+zip、win x64/arm64 zip；**一次逼出三条打包版才会炸的缺陷**（可写状态写进 `.app`、`doc/` 没进包、签名不自洽导致下载后「已损坏」）；新增 `packtest` | §六十三 |
| 通道 B | 用本机已登录的 Claude Code 打通（用户的 Cursor Pro **接不进来**：Cloud Agent API 没有 chat/completions 也没有 messages，实测都 404）。顺带修五条，其中「硬编码工具名单过时」和通道 A 是同一个病 | §六十四 |
| M2-13 | 通道 B 抽成**本地 CLI 这一类**：扫环境、选 CLI、问可用模型。claude / cursor-agent / codex 三家实测跑通 —— 这修正了上一条的一半：**Cursor 的 API 接不进来，CLI 完全可以** | §六十五 |

**进度 103 / 115。** 回归读数：`selftest` 零 error · `lifecycletest` 全通 · `filetest` 19/19 ·
`agenttest` 4/4 · `rendertest` 15/15 · `packtest` mac arm64 34/34 · mac x64 34/34 · win 各 17/17（结构关）。
三条通道都真跑通过一次（A 智谱 / DeepSeek · B 本机 Claude Code · C 火山方舟订阅）。
`01` 第 29–33 条通过，第 36 条部分达成（win 真机与真 Intel Mac 未验）。

**下一步**：M9-6 win 真机第一次跑（要用户有 Windows 机器），然后 M10（第二批类型 / 秘书接入；Web 版不排期）。

⚠️ **AI 通道的钱**：agent 循环每一步都要重发「工具表 + 系统提示 + 全部历史」，一轮八步就等于把上下文
发八次 —— 这是 2026-09-24 一天烧掉 10 元 DeepSeek 的原因（46 个 AI 回合 / 73 个模型回复步数）。
验收类测试一律走**通道 C 订阅**；通道 A 的模型已从 `deepseek-chat`（已下架的旧别名）换成 `deepseek-flash`。
别拿真 AI 回合当回归 —— `agenttest` 是打桩的，不花钱。
⚠️ 一条实测结论：**`deepseek-chat` 能看图**（有图 / 无图对照，`00` §六十一之一）。通道吃不吃图一律用 `probe_image_support` 探，别按模型名猜（`11` Q32）。

以下是 2026-09-23 转向当天及之前的状态，仍然有效（转向的依据在 `doc/18`，拍板在 `doc/11` Q18–Q29）：

M0 / M1 已验收；M3 外壳能跑，**应用前端 UI-1..UI-8 已按设计侧裁决落地**；界面十屏全部可渲染、演示态可切，
S1 索引过期 / S2 版本弹层 / S6 版本对比**接真数据并实测**；**通道 A 已真跑通**，通道 B 等套餐续订。
**三种编辑方式都在应用里闭环**（① S2 壳属性面板 · ② 选中节点带给 AI · ③ 直接对话），改稿 → 变更卡 → 一键回退；**首页是项目列表、进项目直接工作台、`npm run ui` 打开的就是应用本体**（§四十六）；**S8 项目设置也进了应用**；会话**作业化：边跑边看工具行、真中断**（§四十）；壳内自测（§三十八）在 Tauri 壳里走通主流程并修掉三条壳里的缺陷。进度 78 / 82。仓库已上 GitHub（`origin` = `TestEngineerFish/umbra-studio`）。**2026-09-23 第一轮扫测**：12 条发现按 `doc/17` 写成 issue 草稿（`issues/2026-09-23/`，状态表 `doc/12` §九），修掉 8 条（首页打开未建索引项目失败是根因，见 `00` §四十七；画布工具栏合成一条、S2 嵌入模式收掉自己的 chrome，见 §四十八）；Q16 / Q17 已裁决（都不做）；GitHub token 缺 Issues 权限，`issues/post.sh` 等权限补上后一键提交。对照 ClaudeDesign 的结论在 `doc/16`，Q13–Q15 已拍板并全部落地（M6-1..5：会话栏在左 + 开关、节点评论、源码视图、演示全屏、文字就地编辑）。剩通道 B 等套餐续订。

⚠️ 先看一眼 `doc/00` §三十、§三十一 —— 曾有三屏被标成 ✅ 而实际渲染不出来
（校验器当时漏报），补了判据才暴露。
**别只信状态列，跑一次 `selftest` + `rendertest` 再说。**

待清理（未进仓库的残留，确认后可删）：`outgoing/ziLBtpQN`（打包临时文件，若还在）。
