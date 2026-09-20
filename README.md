# UmbraDesign

**一个跑在自己电脑上的设计软件。** 创建和管理设计项目、编辑设计稿 ——
而设计稿就是 `.dc.html`，一份文件同时是设计稿、规范出处和可运行原型。

参照物是 ClaudeDesign：**做一个和它基本一样的软件，最大的不同是设计稿存本地。**
三种编辑方式都在同一个窗口里：手动选中元素改 · 选中后让 AI 改 · 直接和 AI 说。

同一套能力也暴露成本地 **MCP server**，别的模型客户端（Claude Code / Codex）
可以直接连 —— 那是能力的一个出口，不是产品的全部。

- 产品需求与验收标准：`doc/01-产品需求文档.md`
- 分期与已定决策：`doc/11-路线图与分期.md`
- 进度与待办（69 条，当前 24 条完成）：`doc/12-待办清单.md`
- 实现契约：`doc/00-MCP 工具契约.md`　·　文档导航：`doc/README.md`
- **接手这个项目？先读 `CLAUDE.md`。**

**当前状态**：编辑方式 ① 已通；② ③ 要在另一个应用里做（M2 补上）；
项目与稿件的生命周期（建 / 改名 / 移动 / 删）还是空的（M1，下一步）。

---

## 快速启动

### 1. 前置

- **Node ≥ 20**（开发用的是 22）
- **一个 Chrome / Chromium** —— 只有 `render_check` 用它。macOS 上装了
  Google Chrome 就行，工具自己会找；找不到时用 `UMBRADESIGN_CHROMIUM`
  指到可执行文件。
- 不需要联网。React 与 `support.js` 都在 `runtime/` 里 vendor 好了，
  落盘时自动注入离线映射。

### 2. 装与编译

```bash
npm --prefix server install
npm --prefix server run build
```

### 3. 自检（三条，建议改完都跑一遍）

```bash
npm --prefix server run selftest     # 静态：基准 14 份 + 界面稿 7 份 + 语料（有就跑）
npm --prefix server run rendertest   # 渲染：15 份基准，真开浏览器
npm --prefix server run incoming     # 接设计侧交回来的稿（见 doc/00 §二十七）
```

`selftest` 的判据是三档：**基准精确匹配 · 界面稿零 error · 语料零误报**。
`rendertest` 没有浏览器时整块跳过，并明说「跳过不等于通过」。

### 4. 自己看稿 / 改稿（不需要模型）

界面是给**人**用的，一条命令就起：

```bash
npm --prefix server run ui                       # 只有一个项目时
npm --prefix server run ui -- <项目名>
npm --prefix server run ui -- <项目名> --port 4173 --no-open
```

它做三件事：起本地 http、生成入口页并把界面壳与本地 API 令牌部署进项目、
打开浏览器。然后停在前台 —— **回车**重跑索引（改完稿用），**Ctrl-C** 退出。

在入口页点一份稿就进单稿预览壳，那里可以：点选节点、改属性（数字框 /
拖标签 / token 色板）、看诊断、看变更清单、回退版本。**全程没有模型在场。**

要模型参与的是另一件事：让它按需求写稿、改逻辑类、解释变更 —— 那走下面的 MCP。

### 5. 注册进大模型客户端

服务走 **stdio**，入口是 `server/dist/index.js`，**不依赖工作目录** ——
命令里给绝对路径就行。

**Claude Code**

```bash
claude mcp add umbradesign -- node /Users/sam/Documents/SourceTree/Geek/UmbraDesign/server/dist/index.js
```

**Claude 桌面端** —— 编辑
`~/Library/Application Support/Claude/claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "umbradesign": {
      "command": "node",
      "args": ["/Users/sam/Documents/SourceTree/Geek/UmbraDesign/server/dist/index.js"]
    }
  }
}
```

**Codex** —— 编辑 `~/.codex/config.toml`：

```toml
[mcp_servers.umbradesign]
command = "node"
args = ["/Users/sam/Documents/SourceTree/Geek/UmbraDesign/server/dist/index.js"]
```

起来之后 stderr 会打一行
`[umbradesign] v0.1.0 已启动 · 项目根 …`，客户端里能看到 **27 个工具**。

### 6. 设计项目放哪

默认 `<仓库>/projects/`，一个子目录一个项目。要放别处，两种都行：

```bash
node server/dist/index.js --projects-root /path/to/projects
UMBRADESIGN_PROJECTS_ROOT=/path/to/projects node server/dist/index.js
```

> `projects/` **不进这个仓库**。那是用户自己的设计项目，各自独立 git；
> 里面的稿由**工具本身**（和调用它的大模型）创建和修改，不由开发侧手改。
> 工具自己的回归基准在 `fixtures/`，随仓库走。

一个项目目录里需要一个 `project.json`：

```json
{
  "name": "我的项目",
  "title": "显示用的标题",
  "tokens": "tokens.json",
  "icons": "icons.json",
  "designSystem": { "dir": "ds", "alias": "@ds" },
  "limits": { "elementsWarn": 1200, "elementsHard": 2000 }
}
```

除 `name` 外都可省。

### 7. 模型侧的调用顺序

模型按 `doc/00` §八 的顺序调工具：`get_project` → `get_syntax_guide` →
`search_tokens` / `list_components` → `validate_draft` → `write_draft` →
`render_check`。人要看稿的话，模型这边等价于 `serve_start` + `build_index`
（`npm run ui` 做的就是这两步，外加打开浏览器）。

`build_index` 往项目根写：入口页、六个界面壳、索引数据、皮肤、运行时三件套，
并把本地 API 的地址与令牌注进页面。它还会在租户的 `.gitignore` 里维护一段
`<umbradesign:generated>` —— 这些都是可重算的产物，不该进设计项目的仓库。

⚠️ **带 `dc-import` 的稿双击打不开** —— Chrome 不允许对 `file://` 发 `fetch`，
必须走 http（`npm run ui` 或 `serve_start`）。这是上一轮唯一稳定复现的挂死原因（`doc/04`）。

---

## 目录

| 目录 | 是什么 | 进仓库 |
| --- | --- | --- |
| `doc/` | 契约、需求、写稿规则、实测报告、批次记录 | ✅ |
| `server/` | MCP server（Node + TS，27 个工具） | ✅（`dist/` 除外） |
| `runtime/` | `support.js` + 两个 React UMD，**刻意 vendor**（断网可用是前提） | ✅ |
| `ui/` | 工具自己的界面稿（S1–S5、S7、IconGlyph） | ✅（派生的运行时副本除外） |
| `fixtures/` | 工具自己的回归基准，每份钉一条犯过的错 | ✅ |
| `projects/` | 用户的设计项目 | ❌ |

---

## 常见故障

| 症状 | 原因与处置 |
| --- | --- |
| 稿白屏，控制台 `[dc] failed to load React or boot` | 这份稿没走 `write_draft` 落盘，缺 `__resources` 离线映射。用 `write_draft` 重写一次 |
| `render_check` 报「找不到可用的 Chromium / Chrome」 | 装一个，或设 `UMBRADESIGN_CHROMIUM` |
| 界面上写「✗ 本地 API 没起来」 | 先 `serve_start` 再 `build_index` —— 令牌是 `build_index` 注进页面的 |
| 双击稿卡死不出东西 | 稿里有 `dc-import`，必须走 `serve_start` |
| 属性面板说「这个地址失效了」 | 稿在工具之外被改过，地址是内容哈希。回预览里重新点一下那个元素 |
