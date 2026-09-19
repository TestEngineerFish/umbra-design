# UmbraDesign

一份 `.dc.html` 同时是设计稿、规范出处和可运行原型；外面包一层**本地 MCP**，
让大模型能安全地写它、校它、体检它，并把变更讲清楚给实现侧。

调用方是 Claude / Codex 这类大模型（第一阶段），Umbra 秘书是第二阶段。
文档导航见 `doc/README.md`；实现契约见 `doc/00-MCP 工具契约.md`。

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

### 4. 注册进大模型客户端

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

### 5. 设计项目放哪

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

### 6. 人要看稿的时候

模型侧按 `doc/00` §八 的顺序调工具。**人**要看稿走这条：

```
serve_start  →  build_index  →  浏览器打开入口页 index.dc.html
```

`build_index` 会在项目根生成入口页、把 S1–S5/S7 那几个界面壳和运行时拷过去、
并把本地 API 的地址与令牌注进页面。入口页里点一份稿就进单稿预览壳，
在那里点选节点、改属性、看诊断、看变更、回退版本。

⚠️ **带 `dc-import` 的稿双击打不开** —— Chrome 不允许对 `file://` 发 `fetch`，
必须走 `serve_start` 起的 http。这是上一轮唯一稳定复现的挂死原因（`doc/04`）。

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
