# Umbra Studio · 00 MCP 工具契约

> **这一份是实现 Umbra Studio 的主文档。** 它定义本地 MCP server 对外暴露什么、
> 入参出参长什么样、错误怎么回。
> 需求见 `01`，运行时架构见 `02`，模板语义见 `03`，缺陷与验收见 `04`，
> 实测依据见 `05`，写稿规则见 `06`，变更交付见 `07`。

---

## 一、这一层解决什么

`.dc.html` 格式和 `support.js` 运行时已经有了（见 `05` §一）。
Umbra Studio 要做的**不是重写引擎**，是补上引擎外面那一层：

| 缺的东西 | 谁需要它 |
| --- | --- |
| 按需检索设计系统（token / 图标 / 组件契约） | 写稿的模型——它不能把 810 KB tokens 读进上下文 |
| 落盘即校验，错误带文件 / 行号 / 洞名 | 写稿的模型——它看不到浏览器控制台 |
| 判活与渲染体检 | 写稿的模型——它没有眼睛 |
| 语义变更清单 | 实现侧——文本 diff 对 inline-style HTML 没用（见 `07` §一） |
| 入口页与导航 | 人——稿越拆越多之后 |

### 1.1 阶段划分

| 阶段 | 调用方 | 形态 |
| --- | --- | --- |
| **第一阶段（本文档）** | Claude / Codex 等大模型 | 本地 MCP server，stdio |
| 第二阶段 | Umbra 秘书 | 同一个 MCP server，秘书作为另一个客户端 |
| 第二阶段 | 人（设计侧 / 产品侧） | props 面板、直接编辑、主题切换、内联打包（见 `01` §3.2） |

**第一阶段的调用方是模型，不是人。** 所有取舍以此为准：
宁可多一个结构化返回字段，不要多一个需要眼睛的界面。

---

## 二、技术选型（已定）

| 项 | 选择 | 理由 |
| --- | --- | --- |
| 语言 / 运行时 | **Node + TypeScript** | 与 `UmbraPC` 一致 |
| 协议 | **MCP over stdio** | `@modelcontextprotocol/sdk` |
| 渲染体检 | **Playwright + Chromium（headless）** | 纯本地，无需服务端；`05` §二已跑通 |
| 浏览态服务 | Node 内置 `http` 起静态目录 | 二十几行，无第三方依赖 |
| 交付物依赖 | React + ReactDOM 本地副本，**不带 Babel** | 依据见 `05` §五 |

⚠️ **`01` §3.3「不要构建步骤」约束的是交付物 `.dc.html`，不是 MCP server 本身。**
MCP server 可以有 `package.json`、可以装依赖；它产出的 `.dc.html` 不许需要构建。
这两件事在文档里不得混为一谈。

---

## 三、租户与目录

设计系统是**可插拔的项目输入**，Umbra 只是第一个租户。

⚠️ **两件东西要分清：工具 与 用户的设计项目。**

```
Umbra Studio/                    ← 工具本身。这是一个 git 仓库，只追踪工具
  doc/                          本套文档
  runtime/                      所有租户共用（第三方副本不进仓库）
    support.js                  运行时（vendor，见 05 §一）
    react.production.min.js     10.7 KB
    react-dom.production.min.js 131.8 KB
  server/                       MCP server 源码（Node + TS）
  ui/                           工具自身的界面，用 .dc.html 自举写（见 08）
    _ds-tool/tokens.css         --tool- 前缀的工具皮肤，与任何租户无关
  .gitignore                    ← 忽略 projects/

  projects/                     ← ⚠️ 只是**默认**位置，不被工具的仓库追踪
```

```
<用户指定的项目根>/              ← 默认 Umbra Studio/projects，可配置
  Umbra_design_next/            ← 一个设计项目 = 一个租户 = 一个独立 git 仓库
    .git/                       ← 它自己的
    .gitignore
    project.json                ← 租户配置，唯一的路径出处
    _ds/…                       ← 设计系统，目录名固定为 _ds
    umbra-tokens.json           ← 判据与取值的唯一出处
    umbra-icons.json
    support.js                  ← 运行时副本，与稿同层，由 MCP 维护，不进租户仓库
    react.production.min.js
    react-dom.production.min.js
    *.dc.html                   ← 页稿与组件稿
    index.dc.html               ← build_index 生成的入口页
    .umbrastudio/               ← 工具产物（快照 / 缩略图 / 索引缓存）
    CHANGELOG-设计侧.md         ← 给实现侧的变更清单（见 07）
  某客户/                        ← 另一个租户，同样形状，自己的 _ds 和自己的 git
```

**为什么工具不追踪用户的项目**：Umbra Studio 将来要打包分发，用户安装时会
指定自己的项目存储地址。让工具的仓库去追踪用户的项目，等于让用户追踪工具自身——
方向是反的。项目根的位置通过启动参数或环境变量给（`--projects-root`
/ `UMBRASTUDIO_PROJECTS_ROOT`），默认 `./projects`。

⚠️ **因此租户目录必须自包含。** 项目根可能在任何地方，稿子不能用
`../../runtime/…` 这种跨出项目根的相对路径去找运行时。

做法：**运行时副本与稿同层。** `<script src="./support.js">` 是相对**文档**解析的，
所以每一个放稿的目录都要有一份（旧项目里 `PC 端/`、`PC 端/Components/`、
`PC 端/Pages/` 各有一份 support.js，就是这个原因）。
`write_draft` 与 `build_index` 负责把工具 `runtime/` 里的三个文件
（`support.js` + 两个 React UMD，共 211 KB）分发到每个放稿的目录并保持版本一致。

> 早先版本这里写的是放在 `_runtime/` 子目录。**已改。** 子目录只会让
> 每份稿的 `<script src>` 都要改写，而全部 32 份存量稿写的都是同层的 `./support.js`——
> 为一个子目录去改 32 份稿，零收益。

这也让整个租户目录可以直接打包交给实现侧——**打开就能跑，不依赖 Umbra Studio 在不在**。

### 3.1 `project.json`

```json
{
  "name": "umbra",
  "title": "Umbra 私人 AI 助手",
  "designSystem": {
    "dir": "_ds/umbra-studio-system-ec7cf6a5-891a-4152-8562-120f755dfe2d",
    "alias": "@ds"
  },
  "tokens": "umbra-tokens.json",
  "icons": "umbra-icons.json",
  "extraStyles": ["umbra-ink-tokens.css", "umbra-preview-base.css"],
  "limits": { "elementsWarn": 1200, "elementsHard": 1500 }
}
```

两个字段**故意不在这里**：

- `runtime` —— 运行时副本与稿同层，由 MCP 分发与刷新，不配置
- `git` —— 自动探测租户目录下有没有 `.git`，不手填（`00` §3.3）

### 3.2 `@ds` 别名：只活在落盘前

模型写稿时 helmet 里写 `href="@ds/tokens/colors.css"`。
`write_draft` 落盘时按 `project.json` 的 `designSystem.dir` 把它翻译成**普通相对路径**。

> **落盘后的文件里没有任何别名。** `support.js` 不认识 `@ds`，也不需要认识。
> 稿子拿出 Umbra Studio 照样能开。填路径这件事由 MCP 在落盘那一刻完成。

`validate_draft` 反向检查：落盘后的 ds 引用必须能解析到真实文件，否则报 `E_DS_PATH`。

### 3.3 git：每个项目一个仓库，且只是兜底

`07` 的语义 diff 需要历史版本。取历史有两条路，**主次分明**：

| 路 | 出处 | 地位 |
| --- | --- | --- |
| **主路径** | `.umbrastudio/snapshots/<稿名>/v<N>.json` 的快照序列 + `CHANGELOG-设计侧.md` | 工具自己产的，不依赖任何版本控制 |
| **兜底** | `git show <ref>:<path>`，现算快照 | 只在要按任意 git ref 取版本时用 |

约定：

- **每个设计项目各自一个 git 仓库**，仓库根就是租户目录。
  MCP 在租户目录里执行 git 命令，不跨出去。
- **Umbra Studio 自身的仓库不追踪任何租户**（`.gitignore` 里 `projects/`）。
- 租户没有 git 也能用：`git.enabled` 自动探测租户目录下有没有 `.git`，
  没有就只走主路径。按 ref 取版本的请求返回 `E_GIT_DISABLED`。
- **实现侧永远不碰 git。** 它读 `CHANGELOG-设计侧.md`，或让自己的 Agent 调
  `get_changes_since`。

## 四、统一返回信封

**所有工具的返回都是同一个形状。** 这是整套契约里最重要的约定——
调用方是模型，它需要能机器解析、且自带改法建议的结果。

```json
{
  "ok": true,
  "data": { },
  "errors": [],
  "warnings": [],
  "stats": { }
}
```

### 4.1 诊断项（errors / warnings 的元素）

```json
{
  "code": "E_HOLE_UNRESOLVED",
  "level": "error",
  "file": "projects/Umbra_design_next/日志.dc.html",
  "line": 128,
  "col": 34,
  "locator": { "kind": "hole", "name": "onRetry" },
  "message": "模板第 128 行的洞 \"onRetry\" 在 renderVals() 的顶层键里找不到",
  "fix": "在 renderVals() 的每一条返回路径里补 onRetry: P.onRetry ?? NOOP"
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `code` | ✅ | 稳定标识，`E_*` / `W_*`，见 §六 |
| `level` | ✅ | `error` \| `warning` |
| `file` | ✅ | 仓库根的相对路径 |
| `line` / `col` | 尽力 | 定位不到时省略，**不许填 0 或猜** |
| `locator` | ✅ | `{kind: "hole"\|"tag"\|"import"\|"key"\|"token", name}` |
| `message` | ✅ | 人话，一句，说清是什么 |
| `fix` | 尽力 | **给模型的改法**。没有可靠改法时省略，不许写"请检查代码" |

> **禁止静默。** 任何工具不得在返回 `ok: true` 的同时隐藏一条 error。
> 任何工具不得只在控制台打日志——**模型看不到控制台**（`01` §五 R2 在 MCP 场景下的等价要求）。

---

## 五、工具清单（第一批）

### 5.1 检索类（只读）

| 工具 | 入参 | 出参 `data` |
| --- | --- | --- |
| `list_projects` | — | `[{name, title, drafts, lastChange}]` |
| `get_project` | `project` | `project.json` 内容 + 稿清单 + ds 解析后的真实路径 |
| `search_tokens` | `project`, `query`, `limit=30` | `[{path, value, kind, note}]` |
| `get_token` | `project`, `path` | 单值或子树；`path` 支持点号前缀取整棵子树 |
| `list_icons` | `project`, `query?` | `[{name, size, note}]` |
| `get_icon` | `project`, `name` | `{name, viewBox, d}` |
| `list_components` | `project` | `[{name, file, summary, props}]`，`props` 是签名不是全文 |
| `get_component` | `project`, `name`, `mode` | `mode: "contract"` → props + 状态清单；`"full"` → 源码全文 |
| `get_syntax_guide` | `topic` | `topic: template \| logic \| interaction \| checklist \| tokens` |

**`search_tokens` 不提供 `list_tokens`。** `umbra-tokens.json` 是 810 KB / 1,447 个叶子，
全量返回会直接吃掉调用模型的上下文。按需检索是这一层的核心价值。

`get_syntax_guide` 返回的是 `03`（模板语义）与 `06`（写稿规则）的规则文本，
**不是本文档**。分工：`03` 是框架语义，`06` 是租户写法约定，不要混。

### 5.2 写入类

**`write_draft` 与 `patch_draft` 是唯一写入口。** 文件不得由别的途径落盘。

| 工具 | 入参 | 行为 |
| --- | --- | --- |
| `write_draft` | `project`, `path`, `content`, `kind` | 整份写。`kind: page \| component` |
| `patch_draft` | `project`, `path`, `edits[]` | 增量改。`edits: [{old, new, count?}]`，`old` 必须唯一命中 |

唯一写入口给三条保证：

1. **归一化落盘** —— UTF-8 无 BOM、LF 换行、末尾恰好一个换行。
   这一条直接堵死 `04` 缺陷 #2 那一类"落盘方式影响结果"的怀疑，
   无论根因是什么（根因至今未证实，见 `05` §四）。

   同时做两处**确定性改写**，它们是同一类事——**源头写抽象，落盘写具体**：

   | 改写 | 源头写 | 落盘后 |
   | --- | --- | --- |
   | 设计系统路径 | `href="@ds/tokens/colors.css"` | `href="_ds/umbra-studio-system-<uuid>/tokens/colors.css"` |
   | 离线资源映射 | 什么都不写 | `support.js` 之前插入 `window.__resources` 块，把 React 的 CDN URL 指向同层本地副本 |

   ⚠️ **第二条必须由工具做，不许写进设计稿。** 理由三条：
   support.js 里 React 的 URL 是硬编码常量（`05` §1.2），映射是绕过它的唯一办法；
   设计侧的宿主自己会注入这张表，写进稿里在那边是冗余；
   React 版本升级时改一处（工具）而不是改 N 份稿。
   注入块用 `<!-- umbradesign:resources -->` 包起来，**改写幂等**——
   重复落盘不叠加，先删旧块再写新块。
2. **落盘即校验** —— 内部先跑 `validate_draft`。有 `error` 级诊断则**拒绝落盘**并原样返回诊断；
   只有 `warning` 则落盘并把 warning 一并返回。
3. **落盘即留痕** —— 写快照到 `.umbrastudio/snapshots/`，追加一条 `CHANGELOG-设计侧.md`（见 `07`）。

`patch_draft` 存在的理由是成本：改一行不该重传 175 KB。
`old` 命中 0 次或多次时返回 `E_PATCH_ANCHOR`，**并把当前文件的相关片段回给模型**，让它一轮内改对。

> 第一批**不提供删除稿的工具**。删稿由人做。

### 5.3 校验类

| 工具 | 入参 | 出参 `data` |
| --- | --- | --- |
| `validate_draft` | `project`, `path` 或 `content` | 纯静态检查，见 §六 |
| `render_check` | `project`, `path`, `options?` | 真实渲染体检，见 §七 |

### 5.4 变更类（见 `07`）

| 工具 | 入参 | 出参 `data` |
| --- | --- | --- |
| `snapshot_draft` | `project`, `path` | 归一化语义快照；`write_draft` 内部自动调 |
| `diff_drafts` | `project`, `path`, `from`, `to` | 分级语义变更清单 |
| `get_changes_since` | `project`, `since`, `paths?` | 跨版本净变更，给实现侧的 Agent |
| `build_index` | `project` | 生成入口页 `index.dc.html`（形态 A，见 `01` §四） |

---

## 六、`validate_draft` 检查项

分两级。**error 拒绝落盘，warning 放行但必须回报。**

### 6.1 error（拒绝落盘）

| code | 检查 | 出处 |
| --- | --- | --- |
| `E_TAG_UNBALANCED` | 按栈逐标签配平（不只数 `sc-if`） | `04` §三 |
| `E_LOGIC_SYNTAX` | 逻辑类能否 `new Function` 编译通过 | — |
| `E_HOLE_EXPRESSION` | 洞里出现表达式（`{{ a + b }}`、`{{ fn() }}`） | `03` §1.1 |
| `E_HOLE_UNRESOLVED` | 模板里的 `{{ 根名 }}` 不在 `renderVals()` 任一返回路径的顶层键里 | `06` §3.2 |
| `E_RETURN_PATH_GAP` | 某条 `return` 路径（含早返回）缺模板用到的键 | `06` §3.2 |
| `E_IMPORT_MISSING` | `dc-import` 的目标文件按引用方目录解析不到 | `04` §1.4 |
| `E_IMPORT_SELF_CLOSING` | `dc-import` 写成自闭合 | `03` §3.1 |
| `E_COMMENT_TAG` | 有 `<!--` 没有对应的 `-->`（后面整段被吞） | `06` §2.5 |
| `E_CONTROL_IN_TABLE` | `sc-if` / `sc-for` / `dc-import` / `x-import` 落在 `table` / `select` / `optgroup` 里 | §14.4 |
| `E_DS_PATH` | 展开后的 ds 引用解析不到真实文件 | §3.2 |

### 6.2 warning（放行但回报）

| code | 检查 | 出处 |
| --- | --- | --- |
| `W_COMMENT_TAG` | 注释里出现标签字面量（一次性渲染无害，流式打开后才是隐患） | `06` §2.5 |
| `W_DEAD_KEY` | `renderVals()` 的顶层键在模板里零命中 | `06` §3.2 |
| `W_ELEMENTS_WARN` | 静态元素标签数 > `limits.elementsWarn` | §6.3 |
| `W_ELEMENTS_HARD` | 超 `limits.elementsHard`，附建议拆分点 | §6.3 |
| `W_UNKNOWN_TAG` | 出现既非 HTML/SVG 标准、也非框架标签的标签名（大概率拼错） | `06` §6.2 |
| `W_HELMET_DUP` | helmet 里同一个**解析后绝对 URL** 被引用多次 | `02` §4.4 |
| `W_FIXED_BLUR` | 同一元素上同时有 `position:fixed` 与 `backdrop-filter` | `06` §4.6 |
| `W_HINT_IGNORED` | 用了 `hint-*` 属性（第一阶段解析但忽略，见 `03` §八） | `01` §3.3 |

### 6.3 元素数阈值：理由已改

阈值保留，但**依据换了**。旧文档写的是"超过约 1,500 个元素浏览器就不渲染"——
`05` §三实测推翻了这一条：6,507 个元素的稿完整渲染，主线程存活。

现在的理由是两条工程理由：

1. **模型写不动。** 175 KB ≈ 45 K token 一次输出，中途出错概率极高。
2. **diff 读不懂。** 语义变更清单的粒度就是文件粒度；一份稿一个模块，清单才有意义。

所以 `W_ELEMENTS_*` 的 `fix` 字段要给**拆分点建议**，按这个优先级找：
顶层 `<section>` / `<dc-import>` 边界 → 模块级 `sc-if` 分支 → 逻辑类里独立的 `*Vals()` 方法。

---

### 6.4 非校验类错误码

`validate_draft` 之外的工具也回同一个信封，这些码不属于 §6.1 / §6.2：

| code | 出自 | 含义 |
| --- | --- | --- |
| `E_PATCH_ANCHOR` | `patch_draft` | `edits[].old` 命中 0 次或多次。**返回时附上当前文件的相关片段**，让模型一轮内改对 |
| `E_GIT_DISABLED` | `diff_drafts` / `get_changes_since` | 租户 `git.enabled: false`，但请求按 git ref 取版本（`07` §七） |
| `E_PROJECT_UNKNOWN` | 所有带 `project` 入参的工具 | 租户名不存在 |
| `E_DRAFT_NOT_FOUND` | 读 / 改 / 校验类 | 目标稿不存在 |
| `E_SNAPSHOT_MISSING` | `diff_drafts` | 请求的 `v<N>` 快照不存在 |

---

## 七、`render_check`

**能做，纯本地。** headless Chromium 由 MCP server 自己起，不需要服务端，
也不违反 `01` §3.3——那一条约束交付物，不约束工具（§二已声明）。

### 7.1 做法

1. 起静态服务指向租户目录（`dc-import` 在 `file://` 下必然失败，依据见 `05` §四，**必须走 http**）
2. `window.__resources` 注入本地 React 副本，**不改 support.js 一行**（`02` §2.1）
3. 打开目标稿，轮询 DOM 节点数直到稳定
4. **判活只认 `1+1`** —— `page.waitForFunction("1+1===2", {timeout})`。
   截图会骗人：一张不对的截图和一个坏掉的页面在屏上长得一样（`04` §2.1）

### 7.2 出参

```json
{
  "alive": true,
  "nodeCount": 2307,
  "renderMs": 1840,
  "unresolvedHoles": [{"name": "onRetry", "file": "…", "line": 128}],
  "consoleWarnings": [{"level": "warn", "text": "…"}],
  "styleSheets": [{"href": "colors.css", "rules": 2}],
  "missingResources": ["_ds/…/tokens/ios.css"],
  "screenshot": ".umbrastudio/shots/日志@1440x900.png"
}
```

`styleSheets` 那一项照 `04` §2.4 的教训来：判断相对引用到不到位，
看 `document.styleSheets` 里**真实解析出的 href 与它的 `cssRules` 条数**，
不看任何宿主注入的路径警告。

`screenshot` 只作留痕与 `build_index` 的缩略图，**不作判活依据**。

---

## 八、给调用模型的使用顺序

MCP server 的 server instructions 里要写明这个顺序，让模型不用猜：

```
1. get_project           拿到租户路径与限额
2. get_syntax_guide      拿到模板语义与写稿规则
3. search_tokens         按需取取值（不要试图取全量）
4. list_components       看有什么能复用
   get_component(contract) 要复用就取契约
5. write_draft           落盘（内部自动校验 + 快照 + changelog）
   └─ 有 error → 按返回的 fix 改，patch_draft 重试
6. render_check          确认真的画出来了
7. diff_drafts           要交给实现侧时，出变更清单
```

⚠️ **第 5 步返回 `ok: true` 不等于稿是对的。** 静态校验过不了渲染这一关——
标签配平、逻辑能编译、诊断干净，三项全绿也不能证明它能渲染（`04` §2.2）。
**唯一的证据是 `render_check` 里 `alive: true` 且 `nodeCount` 合理。**

---

## 九、第一批的边界

**做：** §5.1 全部、`write_draft` / `patch_draft`、`validate_draft`、`render_check`、
`snapshot_draft` / `diff_drafts` / `get_changes_since`、`build_index`、静态服务（形态 A）。

**不做（留第二批）：**

| 项 | 原因 | 现状（2026-09-19 追记） |
| --- | --- | --- |
| `bundle_draft`（内联成单文件，形态 B） | SVG `<use>` 跨文件引用、`_ds_bundle.js` 里的相对 fetch 两点未验证，**不承诺** | 仍不承诺，两点仍未验证 |
| 流式渲染 | 第一阶段调用方是模型，一次性落盘（`01` §3.3 F6） | 仍不做 |
| props 面板 / 直接编辑 | 给人和秘书用的，第二阶段（`01` §3.2） | **已做**（§二十一、§二十七）—— 三层修改路径提前到了第一批 |
| 主题切换 / 导出 PDF | 同上 | 仍不做 |
| 删除稿的工具 | 避免误删 | 仍不做 |
| 拆分 `Umbra PC 端.dc.html` | 工具跑通后再决定拆不拆 | 那是语料侧的事，归项目自己（和调用工具的模型）决定 |

---

## 十、第一批实现记录（v0.1.0）

日期：2026-09-17　代码在 `server/`，Node 22 + TypeScript，`npx tsc -p server` 零报错。

### 10.1 已实现的十个工具

`list_projects` · `get_project` · `search_tokens` · `get_token` · `list_icons` ·
`get_icon` · `list_components` · `get_component` · `get_syntax_guide` · `validate_draft`

MCP 握手实测通过（stdio，protocolVersion 2024-11-05）。
所有返回都是 §四的信封；`errors` 非空时同时置 MCP 的 `isError`。

### 10.2 回归结果：57 份存量稿，零 error

`server/dist/selftest.js` 直接打模块，对 `Umbra_design_next` 全部 57 份稿跑校验。
**判据是「能渲染的稿一条 error 都不该报」**，现在达成。

诊断分布：`W_HINT_IGNORED` 52 · `W_COMMENT_TAG` 3 · `W_ELEMENTS_HARD` 3 ·
`W_ELEMENTS_WARN` 2 · `W_FIXED_BLUR` 2 · `W_DEAD_KEY` 2。
`W_FIXED_BLUR` 那两处与 `04` 缺陷 #6 的旧记录对得上。

### 10.3 回归抓出的两个校验器缺陷（已修）

**① SVG 的 `path` / `circle` 不是 void 元素。** 我把它们放进了 VOID_TAGS，
于是 `</path>` 去跟外层 `<svg>` 配对 —— 一份 1,500 元素的稿凭空报出 20 条
`E_TAG_UNBALANCED`，而那份稿是实测能完整渲染的。VOID_TAGS 现在只留真正的 HTML void 元素。

**② `return` 的归属。** `rows: items.map(it => { if (it.divider) return {…} })`
里的 return 属于回调，不是 `renderVals` 的返回路径。直接 grep `return` 让 5 份
能渲染的稿报出 11 条 `E_RETURN_PATH_GAP`。现在用 `ownReturns()` 维护花括号栈，
每帧判是函数体还是块级 —— `if (x) return …` 算本方法的，`=> { return … }` 不算。

### 10.4 `E_COMMENT_TAG` 降级为 warning

旧记录（`06` 自检 3）说注释里的标签字面量「会把注释提前关掉」。
那是**流式**解析下的隐患：一次性渲染时 HTML 注释只在 `-->` 处结束，标签字面量无害。
实测《Umbra PC 端》与《窗口骨架》都带这种注释且都能渲染。

所以：`W_COMMENT_TAG` 警告（提示流式打开后会坏事），
`E_COMMENT_TAG` 只留给**没闭合的注释**（`<!--` 没有对应 `-->`，后面整段被吞）。

### 10.5 一个已知的覆盖缺口

**57 份里有 25 份的洞审计被放弃**（`stats.holeAuditSkipped`）——
它们的 `renderVals` 里有解析不了的展开（`...DATA`、`...this.foo().bar` 之类）
或计算键。按「不报不能证明的错」（`04` §2.5），这时整块审计放弃而不是猜。

`stats.holeAuditSkippedWhy` 会说明放弃的原因。提高覆盖率是后面的事，
但**放弃优于误报**这一条不改。

### 10.6 下一批

`write_draft` / `patch_draft`（唯一写入口 + 归一化 + `@ds` 展开 + `__resources` 注入）→
`render_check`（Playwright）→ `snapshot_draft` / `diff_drafts` / `get_changes_since` →
`build_index` + 静态服务。

---

## 十一、第二批实现记录（唯一写入口）

日期：2026-09-17　新增 `write_draft` / `patch_draft` / `check_runtime`，共 13 个工具。

### 11.1 三条保证的落地

| 保证 | 实现 | 实测 |
| --- | --- | --- |
| ① 归一化落盘 | `normalize.ts` —— UTF-8 无 BOM / LF / 末尾单换行 → `@ds` 展开 → `__resources` 注入（幂等），顺序固定 | 传 BOM + CRLF + 三个尾换行进去，盘上是干净的 LF 单换行 |
| ② 落盘即校验 | 校验的是**改写后**的内容，也就是真正会落盘的那份。有 error 则拒绝落盘 | 塞一个 `{{ title + 1 }}` → 返回 `E_HOLE_EXPRESSION`，**文件根本没创建** |
| ③ 落盘即留痕 | 写语义快照到 `.umbrastudio/snapshots/<稿名>/v<N>.json`，版本号按稿独立计数 | v1 / v2 依次生成；内容与盘上一致时**不落盘也不升版本**，避免版本号空转 |

另加一条：**运行时副本与稿同层**。`write_draft` 把 `runtime/` 的三件套分发到稿所在目录
（大小不一致时刷新），所以写完就能直接打开。`check_runtime` 只报告不改盘。

### 11.2 `@ds` 与 `__resources`：模型只管写抽象

落盘后的文件里没有任何别名，也没有模型手写的映射块 —— 两者都是工具在落盘那一刻填的。
写稿的人/模型只需要两条：ds 路径写 `@ds/...`；不要自己写 `__resources`。

注入块用 `<!-- umbradesign:resources -->` 包起来，**改写幂等**：先删旧块再写新块。
`patch_draft` 走同一条路，所以增量改也不会把块叠加。

### 11.3 `E_PATCH_ANCHOR` 的回报内容

`old` 命中数不对时，不只报错 —— 还把**文件里最接近的几段上下文**一起回给模型：

- 命中多次：给前 3 处的命中位置与前后各 90 字
- 命中 0 次：拿 `old` 的第一行做探针找最像的 3 段

目的是让模型**一轮内改对**，而不是反复试。实测：`old: "div"` 命中 2 次 →
报 `E_PATCH_ANCHOR`，附 2 段上下文与「把 old 加上相邻文本直到唯一命中，或显式传 count」。

### 11.4 快照里排掉了一类噪声

节点的直接文本整段都是洞（`{{ x }}`）时**不进 `texts`**，只留在节点指纹里。
不排掉的话，`07` 的 L3 文案级会把每一处数据绑定都报成「改字符串」。
真文案（去掉洞之后还有字）才算文案。

### 11.5 闭环实测：写出来的稿能渲染

按 `04` §2.2 的纪律 —— 静态校验全绿不算验收，**唯一的证据是它真的画出来了**。

用 `write_draft` 写一份带 `helmet` + `@ds` 引用 + `sc-for` + 事件洞的稿，
然后在 headless Chromium 里**断网**打开：`alive` · 30 节点 · `sc-for` 三行都展开 ·
事件洞绑上 · **零外部请求 · 零 console error**。

### 11.6 还没做的

`CHANGELOG-设计侧.md` 现在不产内容 —— 它的正文要靠语义 diff（`07` §四）。
**快照从第一次落盘就开始攒，所以不会丢历史**，diff 一上线就能回溯。

下一批：`render_check`（Playwright）→ `diff_drafts` / `get_changes_since` + changelog →
`build_index` + 静态服务。

---

## 十二、第三批实现记录（render_check）

日期：2026-09-17　新增 `render_check` / `check_browser`，共 15 个工具。

### 12.1 依赖 `playwright-core`，**不自动下载浏览器**

用 `playwright-core`（+13 MB，不带浏览器），可执行文件按这个顺序找：
环境变量 `UMBRASTUDIO_CHROMIUM` → 常见安装路径（macOS 的 Chrome / Chromium / Edge / Brave、
Linux 的几个、Windows 的两个）。

找不到就返回结构化诊断，说清怎么配 —— **不猜、不下载**。
`check_browser` 是专门用来报告这件事的工具。

> Playwright 的浏览器 CDN 在受限网络下取不到，所以"自动装浏览器"这条路不能作为前提。
> 真机（macOS）上 Chrome 基本都在，`findBrowser()` 直接命中。

### 12.2 默认断网跑 —— 常态检查，不是可选项

`allowNetwork` 默认 `false`：任何非本地请求都被拦下并回报为 warning。
理由是 `08` C1：交付要能在内网机器上打开。**把它做成每次体检都查，比事后补测可靠。**

实测：引一个 Google Fonts 的 `<link>` → `externalRequests: 1`、被拦、回报
「有外部请求 …（已拦下）」，并且样式表那一栏显示 `css2?family=Inter: 跨源读不到`。

浏览器自身的后台联网（遥测 / 组件更新 / 反钓鱼）`page.route` 拦不住，
所以 launch 时用一串 `--disable-*` 关掉 —— 不关的话每次体检都在等这些请求超时。

### 12.3 ⚠️ 实测抓到的两个自身缺陷（已修）

**① 检测卡死的工具，自己在卡死面前死锁了。**
轮询节点数用的 `page.evaluate`，在页面主线程真卡死时**永远不返回** ——
一份死循环稿把整个 `render_check` 挂住直到外层超时。

修法：加 `race(promise, ms, fallback)`，**凡是跨进程等页面的调用一律加超时**：
轮询、facts 求值、截图，以及 `browser.close()`（卡死的渲染进程会让 close 也挂住，
超时就 SIGKILL 硬杀）。

修完实测：死循环稿 **7,978 ms** 判出 `alive: false` 并干净返回。

**② `findBrowser()` 只判 `existsSync`。**
`/opt/pw-browsers/chromium` 是个**目录**，`existsSync` 也过，launch 时才炸。
改成要求「是文件 且 可执行」。

### 12.4 判活只认 `1+1`

`page.waitForFunction("1+1===2", { timeout: 4000 })`。截图不作判活依据 ——
一张不对的截图和一个坏掉的页面在屏上长得一样（`04` §2.1）。

`alive: false` 时回一条 **error** 级诊断，`fix` 直接指向 `04` §2.2 的二分法。

### 12.5 回报里最值钱的一栏：`styleSheets`

照 `04` §2.4 的教训 —— 判断相对引用到不到位，看 `document.styleSheets` 里
**真实解析出的 href 与它的 `cssRules` 条数**，不看任何宿主注入的路径警告。

实测输出：`(inline):11  (inline):1  (inline):2  colors.css:1  (inline):1` ——
`colors.css:1` 说明 `@ds` 展开后的相对路径真的解析到了，且规则数对。

### 12.6 未解析的洞有两个来源

- **DOM 残迹**：渲染后还留着 `{{ ... }}` 字面量 → `unresolvedHoles`
- **运行时告警**：`support.js` 自己会打
  `[dc-runtime] hole: {{ missingKey }} never resolved — rendered as empty`
  → 被 `consoleWarnings` 捕获

实测确认后者是主渠道（运行时把取不到的洞渲染成空，DOM 里不留残迹）。
两条都收，所以洞漏不掉。

### 12.7 下一批

`diff_drafts` / `get_changes_since` + `CHANGELOG-设计侧.md`（`07`）→
`build_index` + 静态服务（形态 A）。

---

## 十三、第四批实现记录（语义 diff 与变更清单）

日期：2026-09-17　新增 `list_versions` / `snapshot_draft` / `diff_drafts` /
`get_changes_since`，共 19 个工具。`07` 的方案全部落地。

### 13.1 `07` §九 那七条验收，逐条过

| # | 验收条目 | 实测 |
| --- | --- | --- |
| 1 | 不改一个字连续两次快照 → 相同 | `semanticSha256` 一致 ✓（见 §13.2） |
| 2 | 只重排渲染等价的容器 → 只有 L4 | ✓ |
| 3 | 只改一个 padding → 只有一条 L2 且行号指对 | `L2:1`，`L12` / 真稿上 `L562` ✓ |
| 4 | 模板中间插一个 `<div>` → 后面的节点**不被全报** | 只报 1 条 `node_added` + 1 条 L4 ✓ |
| 5 | 给 props 加 `onRetry` → 报 L1 且 `impact` 写明要接回调 | ✓ |
| 6 | 连改多版同一个 padding → 只报首末值 | `14px → 22px（中间改过 1 次）` ✓ |
| 7 | 纯 L4 的落盘 → changelog 不新增小节 | 小节数 7 → 7 ✓ |

### 13.2 快照确定性：新增 `semanticSha256`

`07` §九 第 1 条原话是「快照逐字节相同」，但快照里有 `capturedAt` ——
**这条验收标准我自己写得不严谨。**

改法：加一个 `semanticSha256`，只覆盖语义部分（props / state / valKeys /
分支 / 列表 / 子组件 / token / 节点指纹与样式），**不含** `capturedAt` /
`gitCommit` / `version`。于是：

- 「语义没变」是一个可比的单值，不靠逐字段对
- `diffSnapshots` 拿它**短路**：相同就直接返回零变更（真稿上 29ms 出结果）

验收标准改成「`semanticSha256` 相同」。

### 13.3 真实规模实测

| 稿 | 节点 | 建快照 | 完全相同 | 中间插一个 div |
| --- | --- | --- | --- | --- |
| `Umbra 设计规范` | 1,503 | 43 ms | 0 条 · 29 ms | **1 条增删** + 1 条 L4 · 46 ms |
| `Umbra PC 端` | 6,323 | 170 ms | 0 条 · 154 ms | **1 条增删** + 1 条 L4 · 154 ms |

节点数平方超过 400 万时 LCS 的 DP 表会吃掉太多内存，所以超阈值自动降级成
「按指纹首次出现顺序单调配对」。6,323 节点走的就是降级路径，**同样没有连环报**。

### 13.4 ⚠️ 实测抓到一个真 parser bug（已修）

`data-props` 里的 `()=>void` 有一个**裸 `>`**。而我匹配标签开头用的是
`[^>]*>` —— 于是 `<script … data-props="…()=>void…">` 的开标签在那个 `>` 处
提前收尾，属性值的后半段被当成了逻辑类代码，报出
`E_LOGIC_SYNTAX: Unexpected token '&'`。

**HTML 允许引号内出现 `>`**，所以标签匹配必须引号感知。
`draft.ts` 的 `x-dc` / `script` / `dc-import` / `sc-if` / `sc-for` / `helmet`
六处，以及 `validate.ts` 的标签配平器，全部改成
`(?:"[^"]*"|'[^']*'|[^>"'])*`。

> 存量稿用的是 `&gt;` 转义形态，所以一直没暴露 —— 但模型写稿时完全可能写裸 `>`。
> 改完全量回归：57 份稿仍是**零 error**，警告分布一字不变。

### 13.5 `CHANGELOG-设计侧.md` 的写入纪律

只有 L1/L2/L3 至少一条非空才写（纯 L4 不写，否则清单很快没人看）。
最新在上，同一分钟内同一份稿的同一版本覆盖那一节而不是叠加。
`write_draft` 落盘后自动调，返回里带 `change.counts` 与一句结论
（「N 条契约变更必须改代码，M 条照抄新值和字符串，K 条不用管」）。

### 13.6 `from` / `to` 支持三种写法

`v<N>`（读快照）· git ref（`git show <ref>:<path>` 现算）· `工作区`（当前盘上的内容）。
没有 git 时按 ref 取返回 `E_GIT_DISABLED`，`v<N>` 与 `工作区` 照常工作 ——
主路径不依赖版本控制（`07` §七）。

### 13.7 下一批

只剩形态 A：`build_index` 生成入口页 + 静态服务。做完第一批的边界（`00` §九）就齐了。

---

## 十四、第五批实现记录（形态 A：入口页 + 静态服务）

日期：2026-09-17　新增 `build_index` / `get_index_data` / `serve_start` /
`serve_stop` / `serve_status`，共 **24 个工具**。`00` §九 列的第一批边界到此全部做完。

### 14.1 为什么形态 A 是必需的，不是方便

带 `dc-import` 的稿**双击打不开**：`dc-import` 用 `fetch` 取兄弟稿，Chrome 不允许
对 `file://` 发 fetch（`05` §4.2，`04` 缺陷 #7）。所以形态 A 的本地 http 是多文件稿
唯一能看的路。

`serve.ts` 的服务活在 MCP server 进程里，跨工具调用保持运行 —— 起一次，浏览器里一直
能开。三点实现选择：

- 进程级注册表（项目名 → 服务），重复 `serve_start` 返回已有的那个，不起第二个
- 响应头一律 `cache-control: no-store, must-revalidate` —— 设计稿改一下就要能刷出来
- `server.unref()` —— 不因为它挡住 MCP server 进程退出

### 14.2 `build_index` 产四样东西

| 产物 | 用途 |
| --- | --- |
| `.umbrastudio/index-data.json` | `08` S1 的数据契约，原样；给设计侧那份页面读 |
| `index-data.js` | 同一份数据挂成 `window.__UD_INDEX` |
| `index.dc.html` | 入口页本身，用 `.dc.html` 写（自举：工具产的页要能过自己的校验） |
| `.umbrastudio/tool-tokens.css` | 从 `ui/_ds-tool/tokens.css` 拷来的工具皮肤 |

数据里带一张 import 图，所以 `importedBy` 是算出来的，不是猜的。

> ⚠️ 这一版 `index.dc.html` 是**工具生成的过渡页**。设计侧的
> `ui/S1-稿件索引.dc.html` 数据契约已经一致，让它改读 `window.__UD_INDEX`
> 就能顶掉过渡页 —— 这件事还没做，记在这里。

### 14.3 验收时踩到自己四个坑

**坑一：模板引用了不存在的 token。** 我写了 `--tool-ok-text` / `-warn-text` /
`-err-text`，而 `tokens.css` 只有 `ok` / `ok-soft` / `ok-border` 三档。
不是加 token，而是先算清楚三档够不够 —— 把每种组合的对比度都算了一遍：

| 组合 | 亮色 | 暗色 |
| --- | --- | --- |
| base 字 on soft 底 | 4.67 ~ 6.92 | 6.14 ~ 7.71 |
| 白字 / 深墨字 on 实色底 | 5.36 ~ 10.05 | 5.36 ~ 10.05 |

全部 ≥ 4.5（WCAG AA 正文线），所以四档收成三档是成立的，改的是我的模板不是 token 表。
最紧的一格是**亮色 `ok` 字 on `ok-soft` 底 = 4.67**，代码里留了注释：不要再调浅。

**坑二：我自己的校验器抓到了我自己生成的页。** `renderVals()` 返回了一个 `noop`
键，模板里零命中 → `W_DEAD_KEY`。删掉。自举是有用的。

**坑三（这条最该记）：`build_index` 绕过了 `prepareForDisk`。** 我直接调了
`writeAtomic`，于是生成的入口页没有 `__resources` 注入 —— 断网实测直接白屏，
去 unpkg 取 React 被拦，控制台 `[dc] failed to load React or boot`。

「唯一写入口」这条规矩（`00` §十一）管的就是这个，**工具自己产的文件也不例外**，
而我在自己的新代码里第一时间就破了它。已改成走 `prepareForDisk`，代码里留了注释记着。

**坑四：见 §14.4。**

### 14.4 `E_CONTROL_IN_TABLE`：HTML foster-parenting

入口页渲出来，**表头在、行是空的**。原因不在 `sc-for` 也不在数据：

`<table>` / `<tbody>` / `<tr>` / `<select>` / `<optgroup>` 只允许特定子元素。
HTML 解析器遇到**未知元素**（`sc-for` / `sc-if` / `dc-import` / `x-import`）会把它
**搬到表格外面去**（foster parenting）。搬走之后运行时在表里找不到它，于是
**一声不响地不渲染** —— 没有报错，没有控制台输出。

按 `04` 的判据，静默失败是最坏的一类，所以这条定为 **error 级**，
新增 `E_CONTROL_IN_TABLE`，`write_draft` 直接拒绝落盘。

写稿侧的规则同步写进了 `06` §2.7：**用 div + CSS grid，不要用 `<table>`**。
ClaudeDesign 的 `ui/S1-稿件索引.dc.html` 全篇**零个 `<table>`**（全是 div + grid），
所以它从来没撞上这个 —— 我的过渡页模板已照它改。

### 14.5 验收实测

| 项 | 结果 |
| --- | --- |
| 反例：`sc-for` 在 `<table>` 里 + `sc-if` 在 `<select>` 里 | 2 条 `E_CONTROL_IN_TABLE`，`written=false`「有 2 条 error 级诊断，按契约拒绝落盘」✓ |
| 误报：存量 57 份稿 | 合计 **error 0**，警告分布一字不变 ✓ |
| 生成页自校验 | error 0 · warning 0 · 元素 43 · `table` 标签数 **0** ✓ |
| 生成页落盘路径 | `steps: 归一化 · 注入 __resources 离线映射` ✓ |
| **断网真渲染** | `alive=ALIVE` · `nodes=118` · 被拦的外部请求**无** · 控制台 error **无** ✓ |

首屏文字：`Umbra Studio | 入口页验证 | · 3 份稿 | 索引生成于 3 分钟前 | 全部 | 页稿 |
组件稿 | 有错误 | 有提醒 | 未体检 | 稿件`。

### 14.6 第一批到此为止

`00` §九 的「做」那一列全部落地，24 个工具。

---

## 十四之二、入口页换成设计稿（§14.6 第 1 条）

日期：2026-09-17　`build_index` 的入口页从工具生成的过渡页换成
`ui/S1-稿件索引.dc.html`。没有新增工具。

### 14.7 一份文件两种用法，不分叉

关键决定：**不做「设计版 + 线上版」两份文件。** 同一份 `S1-稿件索引.dc.html`：

- 在 `ui/` 下直接打开 → 没有真实数据，走自带的 9 个演示态，设计评审照旧
- 被 `build_index` 拷进项目目录 → 落盘时注入真实数据，演示态那一条整行不出现

判据就是 `window.__UD_INDEX` 在不在。设计稿里只有一个 `const LIVE = …` 和
`pool()` 里一行短路，其余分支全是原样。

**数据不走 `<script src>`，走落盘注入**（`injectIndexData`，和 `__resources`
同一套标记包夹 + 幂等）。理由是：`<script src="./index-data.js">` 在 `ui/` 下打开
时那个文件不存在，会留一个 404 和一条控制台 error —— 控制台必须干净，否则
`render_check` 每次都带噪声（`04` §二）。注入零额外请求，两种用法都干净。
实测连跑两次 `build_index`，文件长度 46,785 → 46,785，不涨。

同理，工具皮肤从 `.umbrastudio/tool-tokens.css` 改拷到 **`_ds-tool/tokens.css`**
—— 和设计稿里 `href` 相同的相对路径，两种用法同一个 href，不改写也不 404。

### 14.8 数据契约补两个字段

| 字段 | 为什么 |
| --- | --- |
| `project.limits` | 页面上「接近上限 / 已超限」的文案原来写死 1,200，现在跟着租户 `project.json` 走。真项目上实测出的文案是「3 份稿已超过 **1,500** 个元素的上限」 |
| `project.generatedAt` | 页脚「索引生成于 N 分钟前」 |

`version` / `renderMs` / `nodeCount` 在真实数据里可能是 `null`（没落过盘 / 没跑过
体检），页面给了 `—` 占位。`08` 的 S1 契约已同步。

### 14.9 实测抓到两个真问题（都已修）

**一、`kind` 判据在真项目上错得很明显。** 原来按「有没有 props」判：

| 稿 | imports | importedBy | 原判 | 现判 |
| --- | --- | --- | --- | --- |
| `Umbra PC 端`（6,323 元素） | 115 | 0 | **组件稿** ✗ | 页稿 ✓ |
| `Umbra iOS 端`（3,371 元素） | 14 | 0 | **组件稿** ✗ | 页稿 ✓ |
| `PC 空态`（20 元素） | 0 | 12 | 组件稿 ✓ | 组件稿 ✓ |

props 上挂的其实是演示态（`kind` 枚举），跟是不是组件无关。`helmet` 也不能用作
判据 —— 57 份稿全都有。

改成按 import 图判，三条规则，没有魔法阈值：被别的稿引用 → 组件稿；引用了别的稿
→ 页稿；孤立稿退回看 props。真项目上 57 份分成 **页稿 25 / 组件稿 32**。
已知边界：还没被任何稿引用的新组件会先显示成页稿，等它被引用自己就纠正了。

**二、吸顶偏移写死，接真实数据后把卡片头盖掉了。** 筛选条原来是
`position: sticky; top: 76px` —— 76px 是「标题行 + 演示态行」的高度。演示态那行
不出现时顶栏只有 43px（实测），写死的 76px 把下面的表头盖了一半。

改成量出来：顶栏挂一个 ref，`componentDidUpdate` 与 `resize` 时测高度写进
`state.barH`（不等才 `setState`，不会自激）。顺带修掉了一个存量隐患 ——
窄窗里顶栏折行时 76px 同样是错的。

### 14.10 两种用法的实测读数

| 用法 | alive | 节点 | `__UD_INDEX` | 演示态条 | 被拦外部请求 | 控制台 error |
| --- | --- | --- | --- | --- | --- | --- |
| 设计评审（`ui/` 下打开） | ALIVE | 881 | false | 出现 | 无 ✓ | 无 ✓ |
| probe 项目（3 份稿） | ALIVE | 212 | true | 不出现 | 无 ✓ | 无 ✓ |
| 真项目（57 份稿） | ALIVE | 1,975 | true | 不出现 | 无 ✓ | 无 ✓ |

全部断网。57 份稿 `collectIndex` 耗时 **0.4 s**。真项目首屏正确显示
「3 份稿已超过 1,500 个元素的上限」，5 份超警戒线的稿带 `!` 排到最上面。

顺带：设计稿里 `demoLabel` 这个键模板从来没用过（`W_DEAD_KEY`，ClaudeDesign
原稿就带着），删了。存量 57 份稿回归仍是零 error，警告分布一字不变。

### 14.11 `visible()` 里那条排序规则

真实数据里一旦出现 error / warning / 超警戒线的稿，就按
「有问题的排最上面」重排。这不是新行为 —— 设计稿的演示态 6 就是这个意图
（「2 份报错 3 份有提醒，排到最上面」），只是把它接上了真数据。

### 14.12 下一批

1. `S2-单稿预览壳` 接真实数据。**在它接上之前，S1 点一行是直接打开那份稿本身**
   （走静态服务），`go()` 里留了注释标明要改回 S2 的那一支
2. 洞审计的覆盖率：57 份稿里有 25 份因为 `renderVals` 里有解不开的展开 / 计算键
   而跳过审计（`stats.holeAuditSkipped`）。**放弃优于误报**是当时的选择，
   但覆盖率可以往上推
3. `render_check` 把 `renderMs` / `nodeCount` 回填进索引数据 —— 现在恒为 `null`，
   页面上是 `—`
4. `bundle_draft`（形态 B）—— 两点未验证，仍**不承诺**（§九）

---

## 十五、体检读数回填索引（§14.12 第 3 条）

日期：2026-09-17　`render_check` 的读数落盘持久化，索引页的健康判定改为读它。
新增 `server/src/check.ts`，没有新增工具。

### 15.1 起因：截图不会随稿改动失效

索引页原来这样判健康：

```
有 error → 红 ; 没截图 → 未体检 ; 有 warning → 黄 ; 否则绿
```

问题在第二条的反面：**截图存在 ≠ 读数还有效。** 体检一次留下截图，之后稿改了
十遍，索引上仍然显示「通过」。这是静默失败的一种，按 `04` §二的判据必须堵掉 ——
而且它骗的正是最该被骗不得的那个人：来确认「这份稿现在到底行不行」的人。

顺带还有两条原来对不上的：

- 体检时页面**没画出来**（`alive: false`）—— 原来因为没截图而报「未体检」。
  这是错的：渲染是唯一验收证据（`04` §二），画不出来就是 **error**，
  不管静态校验多干净
- 断网体检时**有被拦的外部请求**、或渲染后**还留着洞** —— 静态校验看不到这些，
  原来一律不影响健康色

### 15.2 做法：一份稿一个体检记录，带源码 sha256

`.umbrastudio/checks/<扁平路径>.json`：

```json
{ "file": "日志.dc.html", "checkedAt": "…", "srcSha256": "…",
  "alive": true, "nodeCount": 2307, "renderMs": 1840,
  "viewport": { "width": 1440, "height": 900 }, "offline": true,
  "screenshot": ".umbrastudio/shots/…png",
  "counts": { "unresolvedHoles": 0, "missingResources": 0,
              "externalRequests": 0, "consoleWarnings": 0 } }
```

**`srcSha256` 是关键。** 索引一比对就知道这份读数还描不描述当前的文件；对不上
就是「过期」，等同于没体检，`renderMs` / `nodeCount` 一律不往外给 ——
**宁可说不知道，不可以说通过。**

按内容比而不是按 mtime 比，所以改了再改回去，读数自动重新有效（实测见 §15.4）。
一份稿一个文件（和 snapshots 同样的扁平命名），避免并发体检互相覆盖。
记录读坏了就当没体检，不把工具搞挂。

### 15.3 新的健康判定，附理由

`judgeHealth()` 五档，从硬到软：

| 条件 | health | healthWhy 示例 |
| --- | --- | --- |
| 有 error 级诊断 | error | `2 条 error 级诊断，落盘会被拒` |
| 体检 `alive: false` | **error** | `体检时页面没画出来（1+1 都算不出）` |
| 没有体检记录 | unchecked | `还没跑过 render_check` |
| 记录过期 | **unchecked** | `体检之后稿又改过，这份读数已过期` |
| 洞 / 外部请求 / 缺资源 / warning / 控制台告警 | warn | `断网体检时有 3 个外部请求被拦下` |
| 都没有 | ok | `静态校验干净，体检画得出来，断网无外部请求` |

`healthWhy` 进数据契约，挂在健康徽章的 `title` 上 —— 人不用猜颜色是怎么来的。

### 15.4 实测（容器里有 Chromium，本机 VM 没有，所以这一轮在容器跑）

两份探针稿，都经 `write_draft` 落盘（`__resources` 注入过，断网能取到 React）：

| 稿 | alive | nodes | renderMs | health | healthWhy |
| --- | --- | --- | --- | --- | --- |
| 干净稿 | true | 16 | 1,437 | **ok** | 静态校验干净，体检画得出来，断网无外部请求 |
| 死循环稿（`renderVals` 里 `while(true)`） | **false** | 0 | 3,218 | **error** | 体检时页面没画出来 |

死循环稿的静态诊断是**零** —— 标签配平、逻辑能编译、洞也都给了值。
旧判据会把它报成「未体检」，新判据报 error。这就是这一改的价值。

过期判定，同一份稿连测三次：

| 动作 | health | nodeCount | renderMs | stale |
| --- | --- | --- | --- | --- |
| 体检后，稿未动 | ok | 16 | 1,437 | false |
| 改了一个 padding | **unchecked** | **null** | **null** | **true** |
| 改回去（源码一致） | ok | 16 | 1,437 | false |

索引页真渲染：`alive=ALIVE` · 179 节点 · 断网 · 零外部请求 · 零控制台 error。
首屏读数 `死循环稿 | 0 节点 | 有错误 | 体检未通过` / `干净稿 | 16 节点 | 通过 | 干净`。

### 15.5 顺手修掉两处不自洽

**一、「有错误 / 干净」同时出现。** 诊断列原来只读静态诊断数，于是死循环稿显示
`健康=有错误` 而 `诊断=干净`，自相矛盾。改成：静态诊断为 0 而健康不绿时，
写「体检未通过」/「体检有提醒」。

**二、`nodeCount: 0` 被当成了「没读数」。** 原来写 `r.nodeCount ? … : "— 节点"`,
0 是假值，于是画不出来的页显示 `— 节点`（看起来像没体检）。
`0` 是**有效读数**，照实显示「0 节点」；只有 `null` 才是 `—`。
判空要用 `== null`，不能用真假值。

### 15.6 写稿纪律多一条

`06` §6.1 补：**改完稿要重新体检。** 读数带源码 sha256，稿动一个字就回到
「未体检」—— 工具不会拿旧读数替新文件背书。

租户 `.gitignore` 模板里 `.umbrastudio/` 已经涵盖 `checks/`，换机器重跑一次就有，
不必进仓库。

---

## 十六、洞审计覆盖率（§14.12 第 2 条）

日期：2026-09-17　放弃审计的稿从 **25/57 降到 3/57**。没有新增工具，也**没有放宽任何判据**。

### 16.1 先分类，再动手

原来 `opaque` 是一个光秃秃的布尔，从八个地方置位，不带原因 ——
所以「25 份为什么放弃」只能猜。先给 `ObjectShape` 和 `ValsAudit` 加
`why[]` / `opaqueWhy[]`，每个置位点记一句话，然后跑一遍分类：

| 条数 | 原因 |
| --- | --- |
| **48** | 认不出的键形态 |
| 2 | 没有 `renderVals()` |
| 1 | `return` 的不是字面量对象 |
| 1 | `renderVals` 里一条 `return` 都没解出来 |

52 条原因里 48 条是同一类。把那 48 条的 `seg` 打出来，全长这样：

```
认不出的键形态：/* 软底上的字色 token（批次 080…）：吐司是深底… */ toa…
认不出的键形态：/* 字面按动作写，不按状态写：钮上说的是「按下去会发生什么」。 */ …
```

### 16.2 结论：这是我的 parser bug，不是判据太严

`objectTopLevel` 切段时**跳过**注释（为了正确找到顶层逗号），但 `segStart`
没往前推 —— 于是段里还留着注释，`/* 说明 */ key: value` 这个段以 `/*` 开头，
键名正则匹配不上，落到「认不出的形态」，整份稿判 opaque。

而**逐键写一句说明是这批设计稿的常态**（`06` 通篇都是这个风格）。
所以这个 bug 专门打击写得最认真的那些稿。

修法是剥掉段首的连续注释（`stripLeadingComments`）。**这不是放宽判据 ——
判据本来就该认得出这些键。** 25 份 → 3 份。

剩下 3 份是真的审不了，继续放弃：

| 稿 | 原因 |
| --- | --- |
| `Umbra PC 端.dc.html` | 没有 `renderVals()` |
| `Umbra 网页端 · 验证与重置.dc.html` | 没有 `renderVals()` |
| `Umbra iOS 端.dc.html` | `renderVals` 里 `return v;` —— 返回变量，要数据流分析才能解 |

### 16.3 扩到 54 份之后，立刻抓出两个真缺陷

`PC 端/任务.dc.html`（及其副本 `PC 端/Pages/任务.dc.html`）第 291 行：

```html
<dc-import name="PC 错误卡" … meta="{{ decideMeta }}" actions="{{ decideActions }}">
```

`decideMeta` / `decideActions` 在整份稿里**只出现这一次** —— `renderVals()`
没有这两个键。而 `PC 错误卡` 的 props 里它们是真的：

```
meta:    {label:string; value:string}[]
actions: {label:string; kind?:'primary'|'danger'|'ghost'; act?:()=>void}[]
```

所以那张「决策失败」错误卡**信息行是空的、一颗按钮都没有**，
而且不报错、控制台干净 —— 又一个静默失败。这个缺陷在 25 份稿被跳过审计的那段
时间里一直在那儿。**这是这一改最有价值的产出。**

`W_DEAD_KEY` 从 2 条涨到 15 条，抽查了 `collapsed` / `wsKeepOn` / `whyOpen` /
`focused` 四个，全是真死键（值算出来也返回了，模板从不引用）。**零误报。**

### 16.4 回归判据改成「零误报」

判据从来不是「零 error」，是「零误报」。审计扩面之后抓出真缺陷，
这时候把判据摆成「零 error」只有两条路：改稿（但那两个键该填什么是**设计决定**，
不是我能定的），或者把工具改回瞎。都不行。

所以 `selftest.ts` 里加一张 `KNOWN_REAL` 表 —— 已确认为真缺陷的 error，
逐条带「为什么它是真的」。**表里的放过，表外的任何 error 都算回归失败**
（`process.exitCode = 1`）。修好一份稿就删一行。

现在的读数：`合计 error 4（已确认真缺陷 4 · 待核 0）· 洞审计放弃 3/57 份 · ✓ 零误报`。

### 16.5 要拍板：那两个键怎么填

`decideMeta` / `decideActions` 该给什么内容是设计决定。见 `09` §四 决策 5。

---

## 十七、节点地址与可编辑性地图（`09` 决策 1/2/3）

日期：2026-09-17　新增 `locate_node`，共 **25 个工具**。这一节是三层修改的地基。

### 17.1 先读 ClaudeDesign 的运行时 —— 它已经有一套

`support.js` 里有一整套设计模式机制，之前没人注意到：

| 东西 | 作用 |
| --- | --- |
| `compileTemplate` 给每个元素打 `data-dc-tpl="<序号>"` | 前序遍历计数，渲染出的 DOM 节点带同一序号 |
| `window.__dcAnnotatedTemplate(name)` | 把带标注的模板源码交给宿主编辑器做映射 |
| `window.__dcTemplateSource(name)` | 原始（未编码）模板源码 |
| `window.__dcSetProps(name, overrides)` | 实时改 props —— 这就是 L1 改 props 的机制 |
| `<body data-dc-editor-on>` | 编辑模式：解析不出的洞渲染成可见的 `{{ x }}` |
| `postMessage({type:"__dc_design_mode"})` | iframe 向宿主报告设计模式 |

**这套我们不能照抄，原因只有一条：我们的宿主是 Node，不是浏览器。**
`data-dc-tpl` 是「HTML 解析器解析之后」的前序序号，而解析器会凭空造元素
（表格里的隐含 `<tbody>`、`<p>`/`<li>` 自动闭合），所以在 Node 里按源码开标签
顺序数，对不上浏览器里的序号。要对上就得复刻一遍 HTML 解析，
而且每次定位开一次 Chromium —— L1 拖滑块是连续几十次交互，不可行。

**顺带从运行时里读出一个真缺陷**：解析不出的洞，运行时到底留下什么？实测：

| 洞的位置 | DOM 里 | 控制台 |
| --- | --- | --- |
| 文本 `{{ x }}` | 渲染成空，`{{ }}` **一处不剩** | warn `[dc-runtime] <稿名>: {{ x }} never resolved` |
| 属性 `a="{{ x }}"` | **整个属性被丢掉** | **一句都没有** |

而 `render_check` 是靠扫 DOM 文本里的 `{{ }}` 找它 ——
**所以 `unresolvedHoles` 这个检测项从来没报出过东西，一直是瞎的。**
已改：从控制台那句话里解析出洞名与组件名；DOM 扫描留着当第二道网
（它只在「运行时根本没 boot」时有用，那时 `{{ }}` 还是字面量）。

属性洞**没有任何运行时信号** —— 静态校验（`E_HOLE_UNRESOLVED`）是唯一的网。
`00` §16.3 抓到的 `decideMeta` / `decideActions` 正是属性洞，所以它才那么安静。
**结论：`validate_draft` 不是可选项。**

### 17.2 我们的做法：落盘时打普通属性

和 `__resources` 注入同一条规矩（§14.7）：源稿保持抽象，落盘副本带上它。
`prepareForDisk` 的**最后一步**打 `data-ud-node`——必须最后，因为 `@ds` 展开会改
helmet link 的开标签，而地址是开标签的哈希，放展开之后打，盘上那份重算才能得到
同一个 id（幂等的前提）。

**id = 短哈希(规范化开标签) + 同形元素出现序号。** 已知限制写进契约不绕过：
改了这个节点本身，它的地址就变（写入类工具的返回必须带新 id）；一串同形元素
中间插一个，后面的序号会挪。别处怎么改都不影响 —— 比行号和结构路径都稳
（`07` §2.4 已因同样理由否掉路径）。

### 17.3 实测：地址怎么进 DOM，以及一个关键发现

父子两稿（父稿两处 `dc-import` 引同一个子件，外加 `sc-for`），断网真渲染：

| DOM 里的地址 | 节点 | 说明 |
| --- | --- | --- |
| `父稿 # 69f8f743` | `<div>` | 父稿的外层 |
| `父稿 # 78bd57b9` | `<h1>` | |
| `子件 # 2eb48434` ×2 | `<div>` | 两个实例，**同一个子文件节点** |
| `父稿 # 6aeda6c1` ×2 | `<p>` | `sc-for` 两个克隆，同一个源码节点 |

完整地址就是 **`data-sc-name # data-ud-node`** —— 前者是运行时自己打的组件边界，
后者是我们打的。两个属性都已经在 DOM 里，所以「点选 → 源码」这一步
**不需要浏览器往服务端问**：

```js
const host = el.closest('[data-sc-name]');
const 地址 = (host?.getAttribute('data-sc-name') ?? 页根) + '#' + el.getAttribute('data-ud-node');
```

**关键发现：`dc-import` 元素本身在 DOM 里不存在**（运行时用子件内容替换掉了）。
所以它在源码里可寻址、在预览里点不到 —— 点到的是子件里的节点，带的是子文件的
地址。**这就是地址必须带文件名的原因**，不是为了好看。

### 17.4 打标的代价与副作用，都量过

| 项 | 读数 |
| --- | --- |
| 体积 | 全量 57 份 3.78MB → 4.21MB（**+11%**），最大的稿 +10% |
| 地址数 | 20,660 个，**零重复** |
| 诊断变化 | **0 份**（打标前后诊断签名逐条相同） |
| 元素数变化 | **0 份** |
| 语义快照变化 | **0 份**（只因打地址） |
| 幂等 | 连跑两次逐字节相同 |
| 渲染 | 父子两稿照常，子组件 props 正确，控制台干净 |

两个副作用是实测抓到的，都已修：

**一、自闭合标签不幂等。** `<img … />` 打标后剥回来是 `<img …/>`
（剥属性时把前面那个空格一起吃了），归一化结果和原来不同 → 同一个元素两个 id。
修法：规范化时连自闭合斜杠一起去掉，插入前把空白收干净。

**二、地址变成了传给子组件的 prop。** `dc-import` 的属性会被当作子件的 props，
于是 `data-ud-node` 变成一个 `dataUdNode` prop，污染了 20 份稿的语义快照。
**运行时自己就排除了这种簿记属性**（`support.js` 里 `sc-name` / `data-dc-tpl`
在属性拷贝时被跳过）—— 照它做，`parseDraft` 收 import props 时排掉。

### 17.5 可编辑性地图：逐洞来源分类

`renderVals` 的每个顶层键，值表达式归成四类。判据只看形态，**认不出就说认不出，不猜**
—— L1 的界面拿它决定给什么控件，给了一个改不动的滑块比不给更糟。

全量 57 份，覆盖 54 份、900 个键：

| 类 | 个数 | 人能直接改 | 例 |
| --- | --- | --- | --- |
| `literal` | **146 (16%)** | ✎ 能 | `'内存里只留最近 200 条…'` |
| `computed` | 414 | — | `s.logEmpty ? '还没有日志' : '…'` |
| `fn` | 191 | — | `() => this.setState(…)` |
| `props` | 149 | — | `P.label ?? '缺省'` |
| `unknown` | **0** | — | |

> 中途 unknown 有 110 个，打出来一看全是明显的算式（`!!tone` / `!dark` /
> `files[i]` / `round(atStart)` / `p.note || ''`）—— 判据漏了取反、下标、带参调用、
> 逻辑运算符。而且逻辑上**不是字面量、不是函数、不是 props 的表达式，定义上就是
> 算出来的**，所以兜底从 `unknown` 改成 `computed`。两者 `editable` 都是 false，
> 但说「算出来的」比说「认不出」准确。`unknown` 只留给真取不到值表达式的情况。

`00` §十六 把放弃审计的稿从 25 压到 3，当时看是「减少漏报」；
放到 L1 的视角，那一改是**可编辑性地图的覆盖率从 56% 提到 95%**。

### 17.6 `locate_node`

给一个地址，回报源码行号、开标签、以及 `slots` —— 这个节点上每一项可改的东西
（样式声明 / 属性 / 文本），逐项带 `editable` 与改法。真稿抽样：

```
══ e913d51b <button> L46
    — attr.onclick    = "{{ filterAll }}"   这是函数（事件 / ref），不是可调的值
    — style.(整段)     = "{{ logFAll }}"     跟着 state 走，改它要改交互逻辑
    ✎ text.(文本)      = "全部"              字面量，可以直接改
══ 90037794 <div> L42
    ✎ style.align-items = "center"          字面量，可以直接改
    ✎ style.background  = "var(--rail)"     字面量，可以直接改
```

`inList=true` 表示它在 `sc-for` 里 —— 改这一处会影响渲染出的每一行，
界面要先告诉人这件事。循环变量（`{{ r.name }}` 的 `r`）单独归一类，
来源指回那个列表。

### 17.7 下一批

1. `set_prop(project, file, node, kind, name, value)` —— 属性级写入。三条硬要求见 `09` §3.2，
   其中**目标是洞就必须拒绝并说清改哪个键**，不能默默把洞覆盖成字面量（那是静默破坏）
2. `revert_to(v)` —— L1 上线前必须有（`09` 决策 4）
3. S2 预览壳接点选：iframe 里按 §17.3 那两行取地址，`postMessage` 回外层
4. `decideMeta` / `decideActions` 填什么 —— 等设计侧（`09` 决策 5），不卡进度

---

## 十八、属性级写入与撤销（`09` 决策 4/6）

日期：2026-09-17　新增 `set_prop` / `revert_to`，共 **27 个工具**。L1 的两块必需品。

### 18.1 `set_prop`：三条硬要求逐条实测

`09` §3.2 提的三条，逐条验：

**要求 1 —— 只动目标那一处。** 在一份四节点的稿上连做六次操作
（改 padding、三次被拒、改 title、删 title），完事之后 diff 只有**两行**：

```
L10 旧: <div style="padding: 8px; color: #333" data-ud-node="1dfa0555">固定文字</div>
    新: <div style="padding: 20px; color: #333" data-ud-node="d1271a95">固定文字</div>
L12 旧: <button onClick="{{ onGo }}" title="点我" data-ud-node="65bbd478">走</button>
    新: <button onClick="{{ onGo }}" data-ud-node="2acb6425">走</button>
```

注意 `color: #333` **没有**被写成 `#333333` —— 改动直接作用在原始声明串上，
不经过归一化回写。删属性也把多出来的空格收掉了。

**要求 2 —— 目标是洞就拒绝，并说清改哪个键。** 三种洞，三种改法：

| 拒绝的目标 | 回报的改法 |
| --- | --- |
| `style="padding: {{ pad }}px"` | 改 `renderVals` 里的 `pad`（**literal：数字字面量，可以直接改**） |
| `onClick="{{ onGo }}"` | `onGo`（fn：这是函数（事件 / ref），不是可调的值） |
| `sc-for` 里的 `行 {{ r.n }}` | `r`（computed：循环变量，一行改了所有行 —— 值来自列表 `rows`） |

第一条尤其有用：它不只说「不能改」，还说了**那个键本身是字面量、一行就能改** ——
模型拿到这句话就知道下一步该干什么，不用再猜一轮。

洞审计放弃的稿另外拒一次，理由写明「判不出能不能改」——
**不确定的时候不动手**，比猜着改安全。

**要求 3 —— 走同一条落盘路。** 校验 / 归一化 / 快照 / changelog 一样不少。
实测清单里的读数：

```
[取值 · 照抄新值]  · <div>「固定文字」 的 padding 从 20px 改到 8px  (L10)
[文案]            · <button>「走」 的 title 从 别点 改到 (无)      (L12)
```

**`09` 决策 6 落实了：人手动拖出来的改动，实现侧在同一份清单里看得见。**

### 18.2 连续拖动怎么办 —— 照 ClaudeDesign 的分工

一次 `set_prop` = 一次落盘 = 一个版本。滑块拖动的中间态**不要**调它。

运行时本来就有 `window.__dcSetProps(name, overrides)`（`00` §17.1），
ClaudeDesign 的 props 面板就是用它做实时预览的。所以分工是：
**拖动过程用 `__dcSetProps` 实时改预览，松手才调一次 `set_prop` 落盘。**
工具侧不为此加特殊模式 —— 这是界面的责任，写进了 `set_prop` 的工具说明里。

### 18.3 `revert_to`：源码副本与「向前撤销」

语义快照存不了源码（它只有 `sourceSha256`），所以每次落盘多存一份
`v<N>.src.html.gz`。实测一版 **577 字节**（那份探针稿），
`.umbrastudio/` 本来就不进仓库 —— 本地磁盘换「能撤销」很值。

**撤销是向前的操作**：把 `v<K>` 的内容作为**新的一版**落盘，历史只增不改。
实测 `v6 → 退回 v1 → 落成 v7`，文件内容与 v1 逐字节相同。

为什么不直接改历史：悄悄改历史等于 `07` 的变更交付有个洞 ——
实现侧上一次读到的那一版，凭什么还能相信。

老版本（这个功能上线之前的）没有源码副本，`revert_to` 会明说恢复不了，
指向 git 兜底（`07` §七）。

### 18.4 实测抓到一个：清单里看不出这是回退

第一版做完，回退那一节读起来和普通改动一模一样 ——
「`padding` 从 20px 改到 8px」。但实现侧看「有人把 padding 改回去了」和
「这是退回 v1」是两回事，`09` 决策 6 的意义就在后者。

已改：`appendChangelog` 支持一句备注，紧跟小节标题：

```
## v7 · 2026-09-17 14:51 · 样品.dc.html

> 这一版是**回退**：把 v1 的内容原样落成新的一版（从 v6 退回）。下面列的是相对 v6 的差异。
```

### 18.5 一个顺带验出来的好性质

`listNodes` 算地址靠的是「规范化后的开标签」，而规范化第一步就是剥掉地址属性 ——
所以**打标前后算出来的地址完全一样**。全量 57 份实测：一致 57 / 不一致 0。

意思是：**存量稿不用重写就能被 `locate_node` 定位**，DOM 里的地址等它下次
落盘自然就有了。不需要一次性把 57 份稿全部重写一遍。

### 18.6 下一批

1. S2 预览壳接点选：iframe 里按 §17.3 那两行取地址，`postMessage` 回外层；
   拖动用 `__dcSetProps`，松手调 `set_prop`
2. `set_prop` 的版本膨胀：连续微调会一版一版累积。清单已按同分钟合并小节，
   但快照序列不合并 —— 等真用起来看要不要加保留策略
3. `decideMeta` / `decideActions` 填什么 —— 等设计侧（`09` 决策 5），不卡进度

---

## 十九、预览点选：L2 的链条接通（`09` 决策 7 之 S2）

日期：2026-09-17　新增 `runtime/select-bridge.js`，S2 预览壳接真稿与点选。
工具数不变（27 个）—— 这一批是把已有的零件接起来。

### 19.1 桥不进稿

点选桥跑在**被预览的那份稿**里，但**由预览壳在 iframe 载入之后注入**，不写进稿。
稿是设计事实，点选是工具行为，不混在一个文件里。壳和稿由同一个本地静态服务发出，
同源，所以塞得进去。`build_index` 把桥拷到 `.umbrastudio/select-bridge.js`。

地址就是 §17.3 那两行，两个属性都已经在 DOM 里：

```js
const host = el.closest("[data-sc-name]");        // 哪份稿（运行时打的组件边界）
const id   = el.getAttribute("data-ud-node");     // 哪个节点（我们落盘时打的）
```

**点选模式必须能关。** 预览既要「点一下选中它」，也要「点一下真的用这个界面」——
只给前者，带交互的稿在预览里就试不动了。开关是 `<html data-ud-select-on>`，
对应运行时那套 `<body data-dc-editor-on>` 的思路（§17.1）。
壳那边是底栏一颗钮 + `S` 键。

### 19.2 S2 也走 `LIVE` 门控

和 S1 同一套办法（§14.7）：地址栏带 `?file=` 就是在看真稿，不带就还是设计评审的
9 个演示态。一份文件两种用法，不分叉。实测两条路：

| | 顶栏 | 演示态行 | 点选钮 | iframe | 控制台 |
| --- | --- | --- | --- | --- | --- |
| 带 `?file=` | 被预览稿 · 稿 | 不出现 | 出现 | 真稿，7 个可寻址节点 | 干净 ✓ |
| 不带 | 日志 · v217 · 812 元素 | 在 | 不出现 | `_demo/稿件预览示例.html` | 干净 ✓ |

点选实测（断网）：

```
点标题     → 被预览稿#54ca41b5 <h1>
点子件内部 → 子件#3ff4b27e <div>              ← 跨文件，回报的是子文件地址
点 sc-for 行 → 被预览稿#6a109747 <p> ×3（改一处影响这么多）
```

再把这些地址喂给 `locate_node`，逐项可编辑性都对得上 —— **L2 的链条通了**：
预览点选 → 地址 → 源码位置 → 每一项能不能改 → `set_prop` 落盘。

### 19.3 截图暴露的问题：壳说在看 A，iframe 里是 B

第一版只接了 `previewSrc`，顶栏还是演示数字 ——「日志 · v217 · 812 元素」，
而 iframe 里是另一份稿。**这比明显的假数据更糟，它看起来像真的。**

已改：LIVE 时顶栏说真话（真文件名、版本与元素数写「—」/「读数未接」），
演示态那一行不出现，底栏明写「⚠️ 诊断与变更两栏还是演示数据，未接」。
接那两栏是下一步，但**不能拿演示数字冒充**。

### 19.4 实测抓到的 parser bug 一：`methodBodyBrace` 不是引号感知的

它拿正则找第一个 `renderVals(` 就定了。而：

- **S2** 的第一个 `renderVals(` 在**字符串**里 —— 演示用的诊断文案
  「…在 renderVals() 的顶层键里找不到」
- **《Umbra PC 端》**（6,323 元素）的第一个在**块注释**里

两份稿因此被报「没有 renderVals()」，**整份稿的洞审计直接放弃**。
我上一批还把它们当成「真的没有 renderVals，放弃是对的」。

修法：新增 `codeMask()` 标出哪些下标是真代码，`methodBodyBrace` 跳过落在
字符串 / 注释里的匹配，接着往下找。顺带把「没有逻辑类」和「有逻辑类但找不到
`renderVals` 方法体」两种情况分开报 —— 原来都是一句「没有 renderVals()」。

**读数：洞审计覆盖 54 → 55/57，键 900 → 1,165（+29%），可直接改的 146 → 194。**
仍然放弃的 2 份：`Umbra iOS 端`（`return v;`，要数据流分析）、
`Umbra 网页端 · 验证与重置`（纯静态稿，没有逻辑类，本来就没有洞要审）。
全量回归仍是**零误报**。

### 19.5 实测抓到的 parser bug 二：正则字面量（这条更坏）

S2 接完之后，我自己的校验器报它 4 个洞找不到。查下去：

```js
title: LIVE.replace(/^.*\//, "")
```

正则以 `\` `/` `/` 收尾。四个扫描器都在 `/` 上判「下一个字符是不是 `/`」，
于是把后一个斜杠当成**行注释开头**，吞掉整行。后果：

**S2 的 renderVals 键表从 87 个悄悄截断到 3 个，而 `opaque` 仍然是 `false`。**

不报错、不标放弃、直接给错答案 —— 这是最坏的一类（`04` §二）。
而且同一个盲点在 `matchBrace` 上更危险：`/\d{2}/` 这种正则里的花括号会被算进
深度，标签 / 方法体配平直接错。

修法：加 `regexCanStart()`（通行的「看前一个有意义字符」启发式）+ `skipRegex()`，
四个扫描器（`matchBrace` / `objectTopLevel` / `codeMask` / `ownReturns`）全部处理。
S2 键数 3 → 87。五份设计稿（S1–S5）现在全部 error 0、洞审计全部已做。

### 19.6 实测抓到的第三个：`src="{{ previewSrc }}"` 每次加载留一个 404

浏览器在运行时替换洞**之前**就会去请求字面量 `{{ previewSrc }}`。
按 `judgeHealth` 的判据（§十五），`missingResources > 0` 会让这份稿永远是黄的。

修法：`src` 先挂 `about:blank`，真地址由逻辑类在 `componentDidMount` /
`componentDidUpdate` 里设（比较当前 `src` 再赋值，不会反复重载）。
**推论写进写稿规则：`src` / `href` 这类「浏览器在解析时就会去取」的属性不要写洞。**

### 19.7 下一批

1. S2 的诊断 / 变更两栏接真数据（`validate_draft` 与 `get_changes_since` 都有了，
   缺的是壳里的数据层）
2. 选中之后的属性面板（`08` S7）—— `locate_node` 的 `slots` 就是它的数据契约
3. `decideMeta` / `decideActions` 填什么 —— 等设计侧（`09` 决策 5）

---

## 二十、本地 JSON API（`09` 新增决策 8）

日期：2026-09-17　`serve.ts` 的静态服务上挂 `/__ud/*`；`build_index` 把工具界面
部署进项目并注入令牌。工具数仍是 27 —— 这不是新工具，是给**界面**用的通道。

### 20.1 为什么非要有这条通道

入口页的数据是落盘时注入的（§14.7），对索引够用。预览壳不一样：
诊断与变更**每改一次稿就变**，`slots`（某个节点上每一项能不能改）
更是**点到才知道**。注入解决不了。

ClaudeDesign 的宿主是一个应用，自带预览通道。我们没有那个 ——
但我们有它没有的：**静态服务就跑在 MCP 进程里。** 所以在它上面挂 JSON API，
和 MCP 工具走**同一条代码路径**（`locate_node` / `validate_draft` /
`changes_since` / `set_prop` / `revert_to`），没有任何旁路。

| 方法 | 路由 | 作用 |
| --- | --- | --- |
| GET | `drafts` | 稿件清单（工具自己的页面排掉，见 `isToolPage`） |
| GET | `validate?file=` | 静态校验的诊断与 stats |
| GET | `locate?file=&node=` | 节点定位 + slots（可编辑性） |
| GET | `changes?file=&since=` | 版本序列 + 净变更 + markdown |
| POST | `set_prop` | 改一处（L1 的写入口） |
| POST | `revert` | 退回某一版 |

### 20.2 为什么要令牌 —— 这是可写带来的

L1 是「人直接拖滑块改稿」，所以这个 API **必须能写**。而 127.0.0.1 上的端口，
浏览器里**任何一个页面**都能 fetch。只读还好，可写就是「任何网页都能改你的设计稿」。

四道门：

1. 只绑 `127.0.0.1`（`serve.ts` 本来如此）
2. 每次 `serve_start` 生成随机令牌，`/__ud/*` 一律校验
3. 令牌在 `build_index` 时注入壳页面（和 `__resources` 同一套）—— 别的页面拿不到
4. 写类请求额外校验 `Origin`，必须是本服务自己的源或无 Origin（同源 fetch）

实测：不带令牌 → `E_API_TOKEN`；`Origin: https://evil.example` 写入 → `E_API_ORIGIN`。

> **这是判断，不是定论。** 它是「本地工具该有的门」，不是「安全无虞」。
> 真要更严得走 Unix socket，或者干脆只让 MCP 侧写。等有更强的要求再收紧。

### 20.3 顺序要紧：先 `serve_start` 再 `build_index`

令牌在 `build_index` 时注入壳页面。反了的话壳拿不到令牌，诊断与点选面板是空的。
两个工具的说明里都写了这一条，`build_index` 的返回里 `api: false` 就是这个情况。

`build_index` 现在还把 S2–S5 部署进项目根 —— **必须与稿同源**，
否则壳既注入不了点选桥、也调不了 API。它们是生成物，租户 `.gitignore` 模板已排除。

### 20.4 实测读数

浏览器里打开 `S2-…?file=被预览稿.dc.html`（断网、零 404、零控制台 error）：

| 项 | 读数 |
| --- | --- |
| 令牌注入 | `window.__UD_API.token` 有 ✓ |
| 统计三格 | 元素 6 · 洞 3 · import 1 —— **全部来自接口** |
| 点标题 | 右栏出现「选中的节点 · 被预览稿.dc.html L11 `<h1>`」+ 4 项可改项 |
| 点子件内部 | 「子件.dc.html L9 `<div>`」—— **跨文件**，`padding 14px` 正是刚才经 HTTP 改的那一处 |
| 变更清单 | 经 HTTP 的那次改动照常进了 `CHANGELOG-设计侧.md`（`[取值]`） |

**决策 6 在 API 这条路上也成立**：人在浏览器里拖出来的改动，实现侧在同一份清单里看得见。

### 20.5 又两处「散文里写死数字」

同 §19.3 那个坑的两种新形态，都已修：

1. 右栏绿色结论写着「143 个洞全部解析到了，4 个 dc-import…」，
   而它上面三格显示的是真数（洞 3 / import 1）—— **两句话自相矛盾**。改成接真数
2. 变更清单里出现 `<div>「子件 · {{ label 」` —— 节点标签截断**截在洞中间**，
   读起来像源码写坏了。改成先把洞换成 `⟨label⟩` 再截（`shortLabel`）

教训重复了三次，写成一条规矩：**凡是给人看的散文里带数字或带源码片段，
都必须来自同一份数据源，不能一半真一半演示。**

### 20.6 下一批

1. 属性面板（`08` S7）：`locate_node` 的 `slots` 已经是它的数据契约，
   现在 S2 右栏是个最简清单 —— 真正的滑块 / 取色器要设计侧出形
2. S4 变更清单接 `/__ud/changes`（接口已经有了）
3. `decideMeta` / `decideActions` —— 等设计侧（`09` 决策 5）

---

## 二十一、属性面板与 S4 接真数据（L1 闭环）

日期：2026-09-17　S2 右栏成了可编辑的属性面板，S4 接 `/__ud/changes`。
工具数仍是 27。**形制是我先定的一版，待设计侧出正式形 —— 清单见 §21.4。**

### 21.1 一次编辑的闭环，三件收尾少一件都不对

点 `+` 把 `font-size` 从 23px 改到 24px，实际发生的是：

1. `POST /__ud/set_prop` → 走 `set_prop`，校验 / 归一化 / 快照 / changelog 一样不少
2. **地址变了** —— 拿返回的 `newNode` 换掉界面里的选中项（`09` §2.2）
3. **iframe 要重载** 才看得到新样子（服务端 `no-store`，重载就是新的）
4. 重载之后重新拉 `slots`，并让 iframe 高亮回新地址

少第 2 件：下一次改动会因为地址失效而报错。
少第 3 件：人看不到自己改了什么。
少第 4 件：选中框跑到别的节点上去。

实测：面板里 23px → 24px，**iframe 里 `getComputedStyle(h1).fontSize` 也确实是 24px**。
断网、零 404、零控制台 error。

### 21.2 控件按值的形态给，认不出就给纯文本框

| 形态 | 判据 | 控件 |
| --- | --- | --- |
| number | `-?\d+(\.\d+)?(px\|rem\|em\|%\|vh\|vw\|ms\|s)?` | 文本框 + `−` / `+` 步进 |
| color | `#rgb…` / `var(--…)` / `rgb(` / `hsl(` | 色块 + 文本框 |
| plain | 其余 | 文本框 |
| locked | `editable: false` | 只显示值 + 改法说明，没有控件 |

`style.margin: "0 0 8px"` 这种多值的落到 plain（不硬拆），
`attr.onclick: "{{ onGo }}"` 落到 locked 并显示「这是函数，不是可调的值」。

**提交时机：`change` / `Enter` / 步进钮，不是每敲一个字符。** 值没变就不落盘，
免得白攒一个版本。连续拖动的实时预览要用运行时自带的 `__dcSetProps`（§18.2），
那条只适用于 props，样式字面量没有对应机制 —— **这是已知缺口，记在 §21.4。**

`inList=true` 时面板顶上挂一条「在 sc-for 里 · 影响每一行」。

### 21.3 同一个坑第四次，这次一次修干净

顶栏还剩三处写死的演示数字：健康徽章、`变更 12`、
`08:41 体检 · 1,840ms · 2,307 节点`。前两处能接，第三处要体检记录 ——
所以 `/__ud/validate` 顺手把 `check` 记录和 `checkStale` 一起给出来。

改完实测顶栏：`被预览稿 · 稿 · — · 6 元素 · 未体检 · 诊断 0 · 变更 1`。

**「未体检」是对的** —— 我前面几次编辑让体检读数过期了（`srcSha256` 不匹配）。
§十五 那套判据在界面上端到端生效了：改完稿不重跑体检，界面就说不知道，
不会拿旧读数替新文件背书。

### 21.4 待设计侧（不阻塞，先用我定的这版）

| # | 项 | 我这版怎么做的 | 要设计侧定什么 |
| --- | --- | --- | --- |
| 1 | 属性面板形制（`08` S7） | 一行一项：标签 104px + 控件 + 下面一行灰色改法说明 | 分组（样式 / 属性 / 文案）、密度、是否要折叠、locked 项怎么弱化 |
| 2 | 数字控件 | 文本框 + `−`/`+` 各 1px | 要不要真滑块、步长怎么定（`px` 1、`%` 5？）、要不要连着拖 |
| 3 | 颜色控件 | 17px 色块 + 文本框 | 要不要取色器、`var(--token)` 要不要给 token 检索（S5 有现成的） |
| 4 | 样式字面量的实时预览 | **没有** —— 松手才落盘 | 这是缺口：`__dcSetProps` 只管 props。要么接受「松手才见」，要么设计一条样式覆盖通道 |
| 5 | `inList` 的提示 | 顶上一条橙色胶囊 | 是否要更强的确认（改前弹一下？） |
| 6 | 落盘中的反馈 | 面板底下一行「正在落盘：…」 | 要不要 loading 态、失败怎么呈现 |
| 7 | `decideMeta` / `decideActions` 填什么 | 未动 | `09` 决策 5，那张错误卡该显示哪几行、几颗按钮 |

前 6 项都是**形制**问题，功能已经通了，换皮不动逻辑。

### 21.5 S4 接 `/__ud/changes`

`diff.ts` 的 `Change` 形状和 S4 的数据契约**本来就一致**
（`level` / `kind` / `target` / `prop` / `from` / `to` / `at` / `message` / `impact`），
所以这一项只是换数据源 + `LIVE` 门控。

实测带 `?file=` 打开：`被预览稿.dc.html · v1 → v4 · 版本序列 v1 → v2 → v3 → v4 ·
L1 契约 0 · L2 取值 1`，演示态行不出现，零 404、零控制台 error。

### 21.6 下一批

1. S3 诊断面板、S5 设计系统浏览器接真数据（接口都有了：`validate` / tokens 检索类工具）
2. `revert_to` 在界面上露出来（接口 `POST /__ud/revert` 已经有）
3. 索引页 S1 点进去要带 `?file=`，现在还是直接开那份稿（`go()` 里留了注释）

---

## 二十二、S3 / S5 接真数据 · 回退露出界面 · 一个语料级缺陷

日期：2026-09-17　五个壳全部接上真数据；`revert_to` 在界面上可用；
新增校验项 `W_HOLE_IN_PARSED_ATTR`。工具数仍是 27。

### 22.1 LIVE 判据分两种，这是有理由的

| 壳 | 判据 | 为什么 |
| --- | --- | --- |
| S1 / S2 / S3 / S4 | 地址栏 `?file=` | 它们必须知道「看的是哪一份稿」 |
| **S5** | **`window.__UD_API` 在不在** | 它是**项目级**的（token / 图标 / 组件契约），不需要知道哪一份稿 |

S1 的 `go()` 现在统一跳 `S2-…?file=`（之前 LIVE 时直接开稿本身，因为那会儿 S2 还没接数据）。

### 22.2 token 检索留在服务端

1,447 个叶子不往浏览器里搬（和 `00` §五 给模型的口径一致）。
S5 的输入框防抖 220ms 打一次 `/__ud/tokens?q=`，命中数、截断标记都由接口给。
实测探针项目：`token 8 个叶子 · 图标 3 枚 · 组件 7 份`，检索 `danger` → 2 命中。

`var(--x)` 这类别名我们**解不开**（要把整条 CSS 变量链跟下去），
所以 `resolved` 给 `null`，S5 显示「链没解开」——**不猜一个值糊上去**。

### 22.3 `list_icons` 默认不给 path，接口给

界面得真把图标画出来，所以本地 API 调 `listIcons(…, withPath = true)`。
但 `list_icons` 这个 MCP 工具默认**不给** —— 几十条 path 白占模型的上下文。
同一个函数，两个调用方，两种口径。

### 22.4 修掉一条误报：`checkControlInTable` 不是注释感知的

我在 S2 的注释里写了「不能用 `<select>` + sc-for」，结果那个 `<select>`
被当成未闭合的开标签，一路吞到文件末尾，把后面所有 `sc-for` 全报一遍 ——
**一条误报，出现在一份合法稿上。** 内层找控制流标签时本来就跳注释了，
外层找宿主开标签时漏了。已修，正反两面都测：注释里的 select 不报（0 条），
真 select 里的 sc-for 必报（1 条）。

> 顺带：那条注释本身也违反 `06` §2.5（注释里不写标签字面量）。
> 规则是我写的，然后我自己踩了两次 —— 一次是 `select` + `sc-for`（§14.4 那条规则，
> 校验器抓的），一次是注释里的标签字面量。**两次都是校验器抓出来的，不是我想出来的。**

### 22.5 语料级缺陷：149 处洞写在了「解析时就动作」的属性上

S5 接完图标之后控制台留下一条：

```
<path> attribute d: Expected moveto path command ('M' or 'm'), "{{ i.d }}"
```

值是**字面量 `{{ i.d }}`** —— 和 §19.6 的 `src` 同一类：
浏览器在解析 HTML 那一刻就对这个属性动手，而洞还没被替换。
`src` 那类是**去发请求**，SVG 这类是**立刻校验**。

扫全量语料（57 份稿 + 5 个壳）：

| 类 | 处数 | 最严重的 |
| --- | --- | --- |
| 解析时校验（SVG `d` / `cx` / `cy` …） | 多数 | `Umbra iOS 端.dc.html` **48 处 `d="{{ … }}"`** |
| 会发请求（`src` / `href`） | 少数 | `PC 端/Components/窗口骨架.dc.html` 3 处 `href` |
| **合计** | **149 处** | |

新增 `W_HOLE_IN_PARSED_ATTR`（warning，附改法）。为什么是 warning 不是 error：
它不影响最终渲染。但**为什么必须报**：`render_check` 会把它算进控制台告警，
按健康判据（§十五）这些稿就一直是黄的 ——「一条永远好不了的黄」比没有这条检查更糟。

改法写进 `06` §2.8：挂 `data-*`，逻辑类里抄过去。S5 已按此改，
实测图标画出真 path（`M2 8a6 6 0 1 0 6-6` 等），控制台干净。

> 这条检查我自己也误报了一次：正则用 `\b` 开头，而 `-` 是非单词字符，
> 于是 `data-icon-d="{{ … }}"`（正是推荐的改法）也被命中。改成负向后查
> `(?<![-\w])`，正反两面都测过。

### 22.6 回退在界面上

底栏一排版本胶囊（最近 3 版）+ 一颗「执行」。实测点下去：
胶囊从 `v5 v4 v3` 变成 `v6 v5 v4` —— 回退落成了新的一版，历史只增不改（§18.3）。
回退之后**清掉选中**：整份稿都可能变，所有节点地址作废，不能留一个失效地址。

**这里也踩了一次 §14.4：我第一版用的是 `<select>` + `sc-for`。**
校验器报 `E_CONTROL_IN_TABLE`，改成胶囊。

还有一个安静的 bug 是自己看出来的：版本胶囊的 `versionOpts` 我写成了
`(function (vs, picked) { … pick: () => this.setState(…) })(…)` ——
`function(){}` 里的 `this` 不是组件，`pick` 回调里的 `setState` 是 `undefined`，
**胶囊点不动而且不报错**。改成箭头 IIFE。

### 22.7 待设计侧（累计）

§21.4 那 7 项之外，这一批新增：

| # | 项 | 我这版 | 要设计侧定 |
| --- | --- | --- | --- |
| 8 | 回退的形制 | 底栏 3 个版本胶囊 + 一颗「执行」 | 要不要版本列表/时间轴、要不要二次确认、超过 3 版怎么翻 |
| 9 | S3 顶栏的版本位 | LIVE 时显示文件名，版本写「—」 | 版本该显示哪个（最新快照？工作区？） |
| 10 | S5 的 `resolved` 为 null 时 | 显示「链没解开」 | 要不要去解 CSS 变量链（那是另一个功能） |

### 22.8 下一批

1. `W_HOLE_IN_PARSED_ATTR` 那 149 处要不要批量改 —— **这是设计侧的稿，不是我能替他们改的**。
   改法机械（`d` → `data-icon-d` + 一个 `syncIcons`），但 149 处分布在 40 多份稿里，
   建议让 ClaudeDesign 出一版统一改法之后再动
2. S2 的「重跑体检」按钮接 `render_check`（现在是演示态；接口还没有这条 —— 它要开浏览器，
   不适合放在 GET 里，得想清楚怎么暴露）
3. `decideMeta` / `decideActions` —— 等设计侧（`09` 决策 5）

---

## 二十三、把 `render_check` 露给界面：作业 + 轮询

日期：2026-09-18　新增 `server/src/jobs.ts`，本地 API 加 `POST check` / `GET check_status`。
S2 的「重跑体检」从演示态变成真的。工具数仍是 27（`render_check` 本来就有）。

### 23.1 为什么不能做成一个同步请求

`render_check` 要开一次 Chromium，实测 1.4~12 秒。同步请求有两个问题：

1. 界面那边 fetch 挂十几秒，中途超时就**不知道到底跑没跑**
2. **连点两下会起两个 Chromium** —— 机器上抢资源，而且两份读数互相覆盖

所以：`POST check` 起作业立刻返回 `jobId`，界面轮询 `GET check_status?job=`。
同一份稿已经在跑就**返回那个作业**，不起第二个（按 `项目::稿` 上锁）。

【实测】连点两次，第二次返回**同一个 jobId**；轮询 1.6s 时 `running`，
之后 `done ok=true alive=true 26 节点 1432ms`。

### 23.2 作业不持久化，这是有意的

作业记录活在 MCP server 进程里，进程没了就没了。**读数本身已经落盘**在
`.umbrastudio/checks/`（§十五），所以作业记录不必持久化 ——
查不到作业时接口直接说「读数在 checks/ 里，可以 GET validate」。

作业表超过 200 条时清掉最老的已完成作业。界面轮到了就不需要它了。

### 23.3 实测抓到：反馈被「有没有选中节点」绑住了

第一版我把「正在落盘 / 体检完成」这条状态放在属性面板里，
而属性面板整块挂在 `sc-if hasSlots` 之下 —— 于是**没选中节点时，
点体检一个字的反馈都没有**。按钮文字会变（那在顶栏），但底下什么也不说。

已移到底栏：状态提示不该被选中状态绑住。改完实测：

| 时刻 | 按钮 | 底栏 |
| --- | --- | --- |
| 点之前 | 重跑体检 | — |
| 跑的时候 | 体检中… 0.6s | 体检中… 0.6s |
| 跑完 | 重跑体检 | **体检完成 · 26 节点 · 1436ms** |

断网、零 404、零控制台 error。

### 23.4 顺带验到一条：壳必须走 `build_index` 部署

测的时候我图快，用 `prepareForDisk` 直接把 S2 写进项目 ——
**那条路不注入 `window.__UD_API`**（只有 `build_index` 注）。
结果界面顶栏「接口读不到」，底栏 `✗ 本地 API 没起来（先 serve_start 再 build_index）`。

这既是我的操作失误，也说明**报错这条路是对的** —— 提示直接给出了修法，
不用猜。规矩记在这里：**壳页面只能由 `build_index` 部署**，
别的写入路径会静默丢掉令牌。

### 23.5 下一批

1. 那 149 处 `W_HOLE_IN_PARSED_ATTR` 等设计侧一次性处理（`doc/10` §二已交办）
2. `decideMeta` / `decideActions` 等设计侧定内容（`doc/10` §3.1）
3. 属性面板等 10 项形制等设计侧（`doc/10` §五）
4. **工具侧自己还能做的**：`get_changes_since` 的项目级汇总还没在界面上露出来
   （S4 现在只看单稿）；`build_index` 之后没有「稿变了要重跑 build_index」的提示

---

## 二十四、收回一条判断：`W_HOLE_IN_PARSED_ATTR` 的 SVG 那一半复现不了

日期：2026-09-18　**这一节是纠错。** §22.5 我说语料里有 149 处（后来改判据变成 158 处）
洞写在「解析时就动作」的属性上，必须改。**SVG 那一半是错的，已收回。**

### 24.1 怎么发现的

ClaudeDesign 开工前提了四个问题，其中一个是「图标走抽组件还是每份稿内联改」。
为了给出有依据的建议，我先去量那 149 处的洞是什么来源 ——
结果顺带发现两件事，第二件推翻了整条判断。

**先量出来的（有用）**：149 处按洞的来源分，**0 处**能靠「把 path 写回模板」解决：

| 来源 | 处数 | 例 |
| --- | --- | --- |
| 循环变量（`sc-for` 里） | **87（58%）** | `d="{{ ic.d }}"` ← `ic` |
| computed（三元选图标） | 37 | `icon` ← `tone === 'fail' ? … : …` |
| 审计没做 | 14 | |
| props / literal 对象 / fn | 11 | `icon` ← `P.icon ?? …` |

全是真动态的。

**然后发现的（推翻判断）**：我拿真稿验触发条件，**复现不了**。

| 试的东西 | 结果 |
| --- | --- |
| 语料 4 份真稿（`PC 吐司` / `PC 折叠栏` / `PC 空态` / `PC 图标选择器`），都带 `d="{{ icon }}"` | **零条** SVG 报警 |
| 合成形态 8 种：裸写 `d` / `points` / `transform` / `viewBox` / `cx` / `svg[width]` | 全不报 |
| 合成形态：`sc-for` 里 / 大页面（417 节点）/ 带 `hint-placeholder-count` / 外套 `sc-if false` | 全不报 |

只有 S5 那一次观察到过（两次独立探针都看到），**触发条件没隔离出来**。

### 24.2 为什么必须收回，而不是留着「宁可多报」

留着它就是拿**一条复现不了的判据**让设计侧改 150 多处。而「一条永远好不了的黄
比没有这条检查更糟」是我自己在 §22.5 写下的话 —— 那条黄现在成了我自己造的。

按 `doc/04` §二那条纪律：**未复现的就标未复现，不能当成必改项。**
这个项目开头就吃过这个教训 —— 旧交接文档断言的六条缺陷，实测推翻了三条。
我这次犯的是同一个错误：**从一次观察推出一条普适规则，没有反向验证。**

### 24.3 收回之后剩什么

只留「会发请求」那一半 —— 它是实测过的：§19.6 里
`src="{{ previewSrc }}"` 每次加载留一个 404，改成 `about:blank` 之后消失。

判据同时收窄成**看宿主元素**，只认实测过的组合：

| 宿主 | 属性 |
| --- | --- |
| `img` | `src` `srcset` |
| `script` / `iframe` / `source` / `audio` / `embed` / `track` / `input` | `src` |
| `link` | `href` |
| `video` | `src` `poster` |
| `object` | `data` |

**`<a href>` 不算** —— 它在解析时不发请求（语料里 `窗口骨架` 那 3 处 `href`
全是 `<a>`，之前被误报）。

**读数：158 处 → 2 处**，都是 `iframe[src]`（`Umbra PC 端` L169、
`Umbra iOS 端通用组件` L94），正是 §19.6 复现过的那一种。

### 24.4 两条顺带量出来的、还有用的结论

**一、抽图标组件几乎没有渲染成本。** 我原来担心 143 个新 `dc-import` 实例会拖慢
`Umbra PC 端`（已经 115 个 import / 6,323 元素 / 12.1s）。实测对照：

| 形态 | 节点 | 耗时 |
| --- | --- | --- |
| 150 个 `dc-import` 引一个极简图标组件 | 465 | **1,426 ms** |
| 150 个内联 `<svg>`（`data-icon-d` 方案） | 315 | **1,440 ms** |

组件方案多 150 个包装节点，**耗时反而略低**（差值在噪声内）。
所以「组件边界太贵」这个顾虑不成立 —— 这条结论保留，将来真要抽组件可以放心抽。

**二、洞挪到 `dc-import` 的属性上，浏览器不管。** 自定义元素的属性不被校验，
所以 `<dc-import name="图标" d="{{ ic.d }}">` 即使 SVG 那条判据成立也不会报。
这也是我这条检查第二次误报「正确修法」（第一次是 `data-icon-d` 被 `\b` 命中）——
**判据写松了就会拦住修法本身。**

### 24.5 文档同步

- `doc/06` §2.8 改成只讲「会发请求」那一类，SVG 那一段降成「见过一次、复现不了」的备注
- `doc/10`（已发给 ClaudeDesign 的交办单）§二 全节重写：从「批量改 149 处」
  变成「改 2 处 `iframe[src]`」
- **这是我发出去之后又改口的一次。** 记在这里，不掩饰：
  发交办单之前我应该先做 §24.1 那组反向验证。

---

## 二十五、样式覆盖通道：拖动中不落盘（`doc/10` Q4）

日期：2026-09-18　`runtime/select-bridge.js` 加样式覆盖通道，S2 接上。
这一项原来标的是「机制缺口，要设计侧定」——**其实不需要设计侧，它是运行时机制。**

### 25.1 做法

往被预览的稿里注一张 `<style id="ud-preview-override">`，按节点地址写规则：

```css
[data-ud-node="a7e7255f"]{ font-size:64px !important }
```

边敲边改这张表（`onChange` → 每个 input 事件），**不写文件**；
`Enter` / 失焦 / 步进钮才走 `set_prop` 真落盘。

两个必须解释的选择：

- **`!important`**：稿里的值写在 `style` 属性上（`06` §2.1），内联样式优先级更高，
  不加盖不住
- **`sc-for` 不用特殊处理**：一个地址对应多个 DOM 节点，选择器天然全命中 ——
  这与「改一处影响每一行」的落盘语义一致

### 25.2 只做 `style`，不做属性和文本 —— 因为所有权

`set_prop` 支持 `style` / `attr` / `text` 三种，但预览**只给 style**。

样式表是 React 不管的东西，写进去不会被下一次渲染冲掉。
而属性与文本由 React 托管 —— 直接改，下一次 `setState` 就把它还原了。
**那种"预览"会闪回，比没有预览更糟。**

### 25.3 实测

| 步骤 | iframe 里的字号 | 文件版本 | 底栏 |
| --- | --- | --- | --- |
| 起点 | 23px | v7 | — |
| 敲到 64px（只有 input 事件） | **64px** | **v7 不动** | 预览中，未落盘：style.font-size → 64px |
| 回车 | 64px | **v7 → v8** | （清空），覆盖层撤掉 |

覆盖表实测内容：`[data-ud-node="a7e7255f"]{font-size:64px !important}`。
断网、零控制台 error。

### 25.4 实测补上一条设计缺口：原来没有「取消」

第一版只有提交没有取消。失焦会落盘（这是有意的，"松手就落盘"），
于是**敲了个值改主意也没法反悔，每一次试探都会留下一个版本**。

已补：`Escape` = 取消。把草稿值退回真值 + 撤掉覆盖层。
不需要额外标志位 —— 草稿退回真值之后，紧随其后的失焦走
`draft === String(x.value)` 那条早返回，自然不落盘。

【实测】敲到 99px（版本 v9 不动）→ `Escape` → 字号回到真值 90px、
覆盖表清空、输入框复原 90px → 再失焦，**v9 → v9 不变**。

### 25.5 还有一条行为，留给设计侧定

**点 iframe 里另一个节点会顺带落盘**：那一下让输入框失焦，失焦即提交。
对表单控件来说提交在失焦是常规做法，但叠上「点预览 = 选节点」之后，
选节点这个动作顺带提交了，是有点出乎意料的。

现在有了 `Escape` 兜底，我判断可以接受。但要不要改成「必须按一颗『应用』钮」
是形制取舍（更不易误改，多一次点击）—— 已写进 `doc/10` §五 第 4 项交给设计侧。

### 25.6 下一批（工具侧还能独立做的）

1. `get_changes_since` 的**项目级汇总**还没在界面上露出来（S4 只看单稿）
2. 改完稿之后没有「索引过期了，要重跑 build_index」的提示

---

## 二十六、项目级变更汇总 · 索引过期提示（收尾两项）

日期：2026-09-18　本地 API 加 `GET project_changes` / `GET index_status`；
S4 多一种项目级形态，S1 多一条过期横幅。工具数仍是 27。
`00` §九 之后攒下的工具侧待办到此清空。

### 26.1 S4 的第三种形态：不带 `?file=` 就是项目级

判据从两种变成三种，而且是一条自然的阶梯：

| 地址 | 看什么 | 数据来源 |
| --- | --- | --- |
| `S4-…?file=x.dc.html` | 单稿净变更 | `/__ud/changes` |
| `S4-…`（不带，但本地 API 在） | **整个项目** | `/__ud/project_changes` |
| `S4-…`（连 API 都没有） | 演示态 | 自带假数据 |

S4 本来就有一个「项目级」演示态（`demo === 7`），形制现成 —— 这一项只是把
数据源接上，每份稿一节。

**接口只回有变更的稿。** 一个项目几十份稿，大半是「只有一版，没有可比的」，
全给过去等于让人在噪声里找。跳过的放在 `skipped` 里带原因，
界面上只说一句「跳过 18 份（没有可比的版本）」。

【实测】探针项目 20 份稿：`2 / 20 份稿有变更 · 各稿首版 → 当前 ·
跳过 18 份`，结论行「没有契约变更 —— 照抄 2 条取值和 0 条文案就行」。

### 26.2 索引过期：这一页不可能自己知道

`build_index` 是一次性扫目录。之后改稿它不知道 —— 于是索引页上的元素数、健康、
更新时间全是旧的，**而它看起来是新的**。

「看起来是新的旧数据」比明显缺数据坏。这和 §十五 的体检读数过期是**同一条道理**，
处理方式也一样：能说出来，就必须说出来。

S1 读的是落盘时注入的静态数据，它自己不可能知道之后有没有人改稿 ——
所以得问服务端。`GET index_status` 的判据：

- 任一份稿的 **mtime 晚于** `index-data.json` 的 `generatedAt`
- 或者稿的名单变了（新增 / 少了）

只比 mtime 不比内容：便宜，而且「碰过就该重扫」这个判断**偏保守的方向是对的**。

【实测】

| 动作 | `stale` | 理由 |
| --- | --- | --- |
| 刚 `build_index` 完 | false | — |
| 改一个 padding | **true** | `1 份在索引之后改过 —— 重跑 build_index` |
| 再新增一份稿 | **true** | `新增 1 份 · 1 份在索引之后改过 —— 重跑 build_index` |

S1 上是一条橙色横幅，摆在超限横幅上面，右侧列出改过的文件名（多于 2 份就写「等 N 份」）。
形制照超限那条抄的，待设计侧过一眼 —— 但**这条本身不能省**。

### 26.3 工具侧待办清空

`00` §九 画的第一批边界之后，攒下来的工具侧待办（§14.12 / §21.6 / §22.8 /
§23.5 / §25.6 逐批记的）到这里全部做完。剩下的都在设计侧：
`doc/10` §三（`decideMeta` / `decideActions` 的内容）与 §五（10 项形制），
外加 §五 新增的第 11 项 —— S1 这条过期横幅的形制。

---

## 二十七、接设计侧的交付 · 属性面板成形 · 一条撤回的判断被撤回

设计侧交回了 `表单色板与布局方案.zip`（S1–S5 + 新的 `S7-属性面板.dc.html` +
`IconGlyph.dc.html` + tokens.css）。这一章记三件事：怎么接、接进来之后做了什么、
以及接的过程中发现我上一批撤回错了一条判据。

### 27.1 交付怎么进来：`ui/_incoming/` + 一条命令

**不要覆盖 `ui/`。** 那五份稿里现在全是接线（LIVE 门控、本地 API、点选桥、
属性面板落盘、样式覆盖通道、版本回退…），整文件替换就全没了 —— `doc/10` §一
存在的理由就是这个。

约定：设计侧交回来的文件**原样**丢进 `ui/_incoming/`，然后

```
npm --prefix server run incoming
```

它逐份回答三件事，不用人去读 700 行：

1. 新文件还是会覆盖现有的
2. 如果会覆盖 —— **我们的接线还在吗**（按标记查，见 `incoming.ts` 的 `WIRING`）
3. 这份稿本身合不合法，以及 renderVals 键数变了多少、少了哪些键

**判据是「标记还在不在」，不是「逐行 diff 对得上」。** 设计侧改样式会动几百行，
那不该报警；接线消失才该报警。

⚠️ 校验必须在一个**落盘后的样子**里做，不能就地校验 `_incoming/`：
`dc-import` 是按引用方文件所在目录做文件系统解析的，同批交付里的 `IconGlyph`
在 `_incoming/` 里找得到、落到 `ui/` 后也找得到，但拿两边任一单独当基准都会误报。
做法是先把 `ui/` 铺一层、再把 `_incoming/` 盖上去，在这个临时叠加目录里校验。
（第一版就地校验，S7 报了 7 条假的 `E_IMPORT_MISSING`。）

`ui/_incoming/` 与 `*.zip` 都进了 `.gitignore`。

### 27.2 这一批交付里实际有什么

| 文件 | 判定 | 处置 |
| --- | --- | --- |
| `IconGlyph.dc.html` | 新文件 | 直接落地 |
| `S7-属性面板.dc.html` | 新文件 · 237 元素 · error 0 | 直接落地，当**形制判据稿** |
| S1 / S2 / S3 / S4 / S5 | 接线 4/4、8/8、3/3、3/3、3/3 全丢 | **全部丢弃**，见下 |

逐块比过模板：设计侧那五份和我们现有的**形制完全相同**（S3 差 8 行、S5 差 8 行、
S1 差 45 行、S2 差 86 行，差的全是我加的接线与 `showDemoBar` 门控）。
也就是说他们是从接线之前那一版重写的，没带我们的逻辑 —— 这符合预期，不是他们做错了。
结论：**S1–S5 保我们的，交付里只有 S7 和 IconGlyph 是新东西。**

### 27.3 属性面板照 S7 重做（§五 第 1–8 项）

S7 是「只做形制，不接数据」的判据稿，十条形制都在上面长出了样子。S2 里那块
我先定的面板整块换掉，形制照抄、接线全保：

- 分三组（样式 / 属性 / 文案），组头可折叠带条数。分组直接用 slot 的 `kind`
  —— 和「样式 / 属性 / 文案」是同一刀，不用另立判据。空组不出
- 行高 30px、标签 96px；改法说明不常驻，行末一个 `?` 点开就地展开
- 数字控件：`−`/`+` 保留，单位挂在框右边；**拖标签调数字**，步长按单位分
  （px 走 1、Shift 走 10；% 走 5；无单位走 0.1）
- 颜色控件：18px 色块点开一层候选，不给自由取色器
- 未落盘是**行级**信息：输入框边框转橙 + 行末一枚「未落盘」；底栏只留键位说明
- 落盘成功：面板底沿绿条「已落盘 v7 → v8」+ 一颗「撤销」停三秒
- 落盘中：2px 进度条 + 一行字。失败**回到出错的那一行**说，值回滚到落盘前
- 不可改项：整行 muted + 行末一枚虚线标签说明它是什么（新增 `Slot.tag`，
  服务端按洞的来源算：函数 / 引用 / 循环变量 / 计算 / 认不出 / 洞）
- `sc-for` 里的节点：改前是提示，改完换成「已改 · 影响 N 行」+ 撤销
- 回退两段式：点一下变「确认回退到 vN」，再点才执行，点别处就撤销

**三处我定的偏差**，都记在这里：

1. **拖标签只给 style 行开。** attr / text 没有覆盖通道，拖的时候一个字都看不见，
   松手却会落盘 —— 那不是手感，是盲操作。
2. **版本胶囊留在底栏，不进面板。** 进了面板就要先选中一个节点才能回退，
   那是 §23.3 那个坑的同一形状。面板底沿只放预览 / 已落盘 / 落盘中这三条 ——
   它们只在选中时才可能出现，不会被 `hasSlots` 关住。
3. **rem / em 的步长按 0.1。** 设计侧只点了 px / % / 无单位，这两个同属小数档。
4. **进度条固定 60% 宽。** 服务端不报进度，所以这条是「在动」而不是「到哪了」
   —— 不假装知道百分比。

### 27.4 颜色控件的候选不是 token 路径

设计侧写的是「里面是 S5 的 token 检索结果」。照着做会写出坏值：token 是
`color.light.faint`，稿里写的是 `var(--faint)`，**两套命名空间**。

实测语料：`color.light` 42 个键里 32 个能用 kebab(叶子名) 对上稿里的 var 名，
10 个 `catN` 对应的是 `--c1..--c10`；反过来稿里还有 27 个 var 名
（`--font-sans` / `--focus-ring` / `--glass-bg` …）在 `color.light` 里根本没有。
按 token 路径拼 `var(--…)` 有一成多会写出**这份稿里没定义**的变量 —— 静默失效。

所以新开一条 `GET /__ud/cssvars?file=`（`server/src/cssvars.ts`）：候选只从
**这份稿自己声明的 CSS 变量**来，写进去一定解析得开；再把每个变量对上的 token
路径标在行尾 —— 设计侧要的「颜色的正确答案在 token 里」由那一栏回答。
解不开的链（引到没声明的变量）给 `null`，不猜（§22.2）。

### 27.5 第 9、10 项

- **S3 顶栏的版本位**：显示最新快照号；工作区与快照不一致时挂一枚「工作区」徽标；
  从来没有快照写「—」。新开 `workspaceState()` —— `changesSince` 比的是
  **快照与快照**，看不见工作区，而这个版本位要回答的恰恰是「我现在看的是不是
  磁盘上那一版」。工具自己每次写都打快照，所以不一致只有一个来源：
  这份稿在工具之外被改过。判不了（一版快照都没有）时给 `null`，不猜成 false。
- **S5 里 `resolved` 为 null**：保留「链没解开」，把断在哪一跳写出来 ——
  下一跳做成可点的，点一下填进检索框，人自己走完。`var(--x, 兜底)` 里的兜底值
  也照实显示（链断了的时候浏览器用的就是它）。

### 27.6 回归多了一块：工具自己的界面稿

`ui/` 下那几份不在 `projects/` 下，**原来整块没被回归覆盖** —— 而它们是改得最勤的
（每批都动）。判据比存量稿更严：**一条 error 都不许有**，因为这几份是我自己写的，
没有「稿的历史问题」可推。

加进 `selftest` 的当场就有收获，见下面两条。

### 27.7 ⚠️ §二十四 那条撤回是错的

上一批我把 `W_HOLE_IN_PARSED_ATTR` 的 SVG 那一半撤回了，理由是**实测复现不了**：
4 份真实语料 + 8 个合成形状，`render_check` 全是零告警。设计侧也照这条把 S5
改回了裸写 `d="{{ i.d }}"`。

新加的 ui/ 渲染验证一跑，S5 当场报这条。隔离 15 个形状，判据换成**完全不过滤**的
console 监听：

| 报 | 不报 |
| --- | --- |
| `path d` · `polyline points` · `g transform` · `svg viewBox` | `fill` · `stroke-width`（涂装类宽容） |
| `circle cx` · `circle r` · `svg width` | `img width`（HTML 宽容） |
| `rect x/y/width/height` · `line x1` | `style` 里的洞（CSS 静默丢弃）· `use href` |
| | `data-icon-d` + 静态 `d="M0 0"`（推荐的修法本身） |

**100% 复现，一个都不漏。** 规律：SVG 里按 length / number / transform / 路径数据
这些类型解析的**几何属性**，在解析那一刻就校验，那时洞还没被替换，所以必报；
涂装类属性和 HTML 属性不校验。

为什么上次量到零 —— `render.ts` 里有这么一行，**是我自己写的**：

```js
// 浏览器解析原始模板时对 SVG 属性里的 {{ }} 报的噪声，不是渲染结果的问题
if (/attribute .*Expected/.test(text)) return;
```

**我拿一台被自己消音过的仪器去做反向验证，量到的零是仪器的零，不是世界的零。**
而 `render_check` 是我自己定的「唯一的验收证据」—— 这个盲点比那条 SVG 规则严重得多：
凡是这一类解析期报错，整套工具都看不见。

处置：

1. `render.ts` 删掉那行静音，改成**单独归类**上报（`level: "svg-parse"`）。
   仍然不参与 `alive` 判定（渲染结果确实是对的），但一定报出来，
   并且说清是解析期的、怎么改。新判据：**凡是控制台真的说了的，工具都要说。**
2. 校验器把 SVG 那一半恢复，清单是**量出来的**（`SVG_TYPED`）——
   不在清单里的属性一律不报。`polygon` / `ellipse` 没单独测，
   但属性类型和 `polyline` / `circle` 同源，归在一起；拿不准的没往里加。
3. S5 的图标网格改引 `IconGlyph` —— 设计侧自己建的那个子组件。
   一份稿里遵守一次规则，比 110 处各自兜底可靠。
4. 撤回本身撤回：`doc/06` §2.8 恢复，`doc/04` §二 的纪律加一条推论。

语料里这条现在是 **158 处 / 14 份稿**，其中 `path[d]` 110 处、
94 处集中在 `Umbra iOS 端` 与 `Umbra PC 端` 两份 —— 改法是那两份引 `IconGlyph`，
不是逐处兜底。

**这一条给纪律加一款：**

> 反向验证之前，先证明仪器没被自己消音。
> 「量到零」有两种可能：世界是零，或者仪器是零。分不清就不能撤回判断。

### 27.8 S3 的 LIVE 形态从来没被真稿走通过

同一轮渲染验证抓到的第二条，是 S3 的真缺陷：带 `?file=` 看**任何一份真稿**都会崩
（`Cannot read properties of undefined (reading 'level')`）。

`CODES` 只列了 9 个演示码，真实码二十多个。`groups` 那一处有兜底（还是我自己写的
⚠️ 注释），但 `errCount` 和 `order.sort` 直接 `CODES[code].level` —— 而真稿几乎都带
`W_HINT_IGNORED`，不在那 9 个里。

也就是说 S3 之前只在**演示态**验过：演示数据用的都是收录过的码。
已抽成 `metaOf(code)`，三处统一走它。

**教训和 §21.3 同一类**：演示态跑通不等于 LIVE 跑通。这两条形态要分别出证据。

### 27.9 这一批的实测证据

沙箱：一份写过 `write_draft` 的探针稿 + 真 chromium，全程监听 console / pageerror。

| # | 验的是什么 | 读数 |
| --- | --- | --- |
| ① | 边敲边预览不落盘 | 敲 41 → iframe `getComputedStyle` 真读到 41px，「未落盘」出现，框边框转橙 `rgb(140,90,0)` |
| ② | `Escape` 取消 | 回到 23px，标记消失，框里退回 23 |
| ③ | `Enter` 落盘 | 31px，绿条「已落盘 v1 → v2」带撤销 |
| ④ | `+` 步进 | 31 → 32px，「已落盘 v2 → v3」 |
| ⑤ | 拖标签 | 拖 30px = 10 步 × 1px → 42px，拖动中「未落盘」，松手才「已落盘 v3 → v4」 |
| ⑥ | `?` 展开 | 就地长出「字面量，可以直接改」 |
| ⑦ | 色板候选 | 4 条，`--danger-soft` 行尾标着 `color.light.dangerSoft` |
| ⑧ | 挑一个 token | 盘上写成 `var(--orange)`，iframe 真变 `rgb(232,89,12)`，绿条 v5 → v6 |
| ⑨ | 撤销 | 颜色退回 `rgb(26,26,26)` |
| ⑩ | 不可改项 | `sc-for` 节点：提示条在，锁定标签「循环变量」「洞」 |
| ⑪ | 回退两段式 | 「执行」→「确认回退到 v3」→ 点别处 → 回「执行」 |
| ⑫ | 落盘失败 | 制造地址失效：行内出红条 + 真实原因，值与预览都回滚，**不给「重试」** |
| ⑬ | 可重试的失败 | 出「重试」，点了之后 88px 落盘，错误条消失 |
| ⑭ | IconGlyph | S7 里 11 个 path 全部拿到真 `d`，控制台干净 |
| ⑮ | S3 / S5 / S7 | 117 / 246 / 359 元素，控制台全干净 |

第 ⑫ 条顺带改了一处措辞：服务端那句 fix 写的是「先调 `locate_node` 重新取」——
那是给 MCP 客户端看的，界面上没人知道那是什么。壳把这一种翻成
「这份稿在别处被改过，这个地址失效了 —— 回预览里重新点一下那个元素」，
并且**不给「重试」**：地址是内容哈希，重试一百次都是同一条 400。

### 27.10 还在设计侧的

- `doc/10` §三：`decideMeta` / `decideActions` 的内容 —— **设计侧已给出**
  （meta 三行：拒绝原因 / 调用时刻 / 重试次数；actions 两颗：
  「重试这一步」primary、「看原始响应」ghost；不放 danger 按钮）。
  内容有了，但那是 `projects/` 下设计侧自己的稿，**我没有去改** ——
  语料归他们的仓库，工具归这个仓库。要我写进去的话说一声。
  这也是回归里那 4 条 error 的全部来源。
- `doc/10` §五 第 11 项：S1 索引过期横幅的形制（这一批交付里没有）。

---

## 二十八、工具要有自己的回归基准（`fixtures/`）

### 28.1 为什么

回归本来整个跑在 `projects/` 下的真实语料上。两个问题：

1. **`projects/` 是用户自己的项目，不进这个仓库。** 换台机器 clone 下来，
   回归根本跑不起来 —— 工具没有属于自己的判据。
   而 `projects/` 下那两个项目是导入来当语料的，它们的内容归用户（和用这个工具的
   大模型）处理，不该由开发侧去改。那 4 条 `E_HOLE_UNRESOLVED` 就是工具在干正事。
2. **语料证明不了「不该报的没报」。** 误报是这套工具最贵的错 ——
   一条假的必改项能让设计侧白改一百多处，§二十七 那次就是。
   而语料里不存在的写法，再多语料也照不出来。

### 28.2 三层，判据各不相同

| 层 | 跑什么 | 判据 |
| --- | --- | --- |
| `fixtures/静态/` | 14 份 · `npm run selftest` | **精确匹配** `expect.json`：该报没报、不该报却报了，都算失败 |
| `ui/` | 7 份工具界面稿 | **一条 error 都不许有** |
| `projects/<名>` | 用户语料 · **有就跑，没有就跳过** | 零误报（真缺陷列在 `KNOWN_REAL`） |
| `fixtures/渲染/` | 15 份 · `npm run rendertest` | 真开浏览器：该报解析期的必须报，该干净的必须干净 |

每一份基准钉的都是**一条已经犯过的错**：文件名写结论，`expect.json` 的 `why`
写它哪一天怎么犯的。**只在真的犯过错之后加** —— 没犯过的错预先设防，
会攒出一堆没人看得懂来历的用例。

### 28.3 渲染那层是 §二十七 的直接产物

那次错误撤回的根因是「仪器被自己消音了」。**`fixtures/渲染/` 就是仪器的体检。**

验证方式是把那行静音**故意塞回去**再跑一遍：

```
✗ 01-path的d-报    该报 · 实际 没报解析期
    ⚠️ 该报没报 —— 先怀疑仪器：render_check 是不是又把这一类静音了？
… 11 条渲染基准没过
```

11 条当场炸，而且提示直接指向仪器。这就是那天缺的那道拦网。

没有浏览器时这一层整块跳过，并明说**跳过不等于通过** ——
不能让「没装浏览器」冒充「过了」。

### 28.4 顺带修的一个扫描器缺陷

写基准时发现：`标题: "x"` 这种**中文键**在 JS 里完全合法，但扫描器的键名正则是
`[A-Za-z_$][\w$]*`，匹配不上就走 `bail("认不出的键形态")` ——
**一个中文键废掉整份稿的洞审计**。已按 JS 标识符规则放宽到 `\p{L}`。

洞那一侧照旧要报：`support.js` 的 `IDENT_RE` 是 `/^[A-Za-z_$][A-Za-z0-9_$]*/`，
运行时**取不到**中文洞，所以 `E_HOLE_EXPRESSION` 是对的 ——
判据直接对齐运行时，不是我们另定的口味。两件事分开报，都不含糊。

（基准 14 同时钉住第三件：**不额外报 `W_DEAD_KEY`**。键名在模板里出现过，
同一件事不报两遍。）

---

## 二十九、启动说明与两处过期的界面

### 29.1 仓库根缺一份 README —— 补了

之前所有文档都在讲「怎么实现」，没有一处讲「**怎么把它跑起来**」：
装什么、编译什么、怎么注册进 Claude / Codex、项目根放哪、人要看稿走哪条路。
新建的 `README.md` 补这一块。要点：

- 服务走 stdio，入口 `server/dist/index.js`，**不依赖工作目录**
  （`TOOL_ROOT` 是从 dist 位置推出来的）—— 所以注册命令给绝对路径就够，
  不用设 cwd。已实测：从 `/tmp` 起也能读到项目根。
- 三种客户端的注册写法：`claude mcp add` / 桌面端 `claude_desktop_config.json` /
  Codex `~/.codex/config.toml`。
- 项目根：默认 `<仓库>/projects/`，可用 `--projects-root` 或
  `UMBRASTUDIO_PROJECTS_ROOT` 改。
- 自检三条命令与各自的判据（`selftest` / `rendertest` / `incoming`）。
- 五条常见故障与处置。

【实测】stdio 握手 + `tools/list` → **27 个工具**；`tools/call list_projects`
从任意 cwd 都能列出项目根下的项目。

### 29.2 S2 里两枚过期的死标签 —— 改成真链接

S2 的诊断抽屉顶上挂着一枚虚线标签「整页形态 · S3 待建」，变更概览里挂着
「完整清单 · S4 待建（第一批后续）」。那是第一批 A 留下的文案 ——
**S3 和 S4 早就有了，而且 `build_index` 每次都把它们拷到项目根。**

也就是说界面上有两条死路，指向的东西其实就在隔壁。改成真链接，
并带上当前稿的 `?file=`，过去直接看这一份稿；演示态不带，过去也是演示态。

**这一类过期文案值得单独说一句**：它不是 bug（不报错、不崩），
所以校验器、回归、渲染验证一个都照不出来 —— 只有真的照着界面走一遍才发现。
`doc/08` 的七屏里 S6（版本对比）确实还没建，S4 里那条指向 S6 的死链接是**对的**；
S3 / S4 这两条是**过期的**。两者长得一样，区别只在东西存不存在。

### 29.3 给人的入口：`npm run ui`

**问题**：界面（S1–S5、S7）本来就是给人用的，但起它要 `serve_start` +
`build_index`，而这两个只暴露成 MCP 工具 —— 于是「我想自己看看稿」这件事
得先找一个大模型来调一次。人的路径上不该站着一个模型。

`server/src/ui.ts` 补这一条：

```
npm --prefix server run ui -- <项目名> [--port N] [--no-open]
```

起服务 → 生成入口页与界面壳 → 打开浏览器 → 停在前台（回车重跑索引，Ctrl-C 退出）。
项目只有一个时名字可省；有多个又没给名字就列出来，不替人猜。

**不做文件监听**：`build_index` 自己就往项目目录里写文件，监听会看见自己的写入。
改完稿按回车重跑就行，页面上本来也有过期横幅（§26.2）。

#### 实测抓到的一个坑：`unref` 让前台入口自己退了

`serve.ts` 里有一行 `rec.server.unref()`，注释写的是「不因为它挡住进程退出」——
对 MCP 完全正确：那个进程的生命由客户端的 stdio 决定。

**但前台用法正好相反**：静态服务就是 `ui` 唯一的存活理由。unref 之后，
它打印完地址就退了，屏幕上留一个**没人监听的 URL** —— 看起来完全正常。
curl 全 000 才发现。补了 `serveHold(name)`，只有 `ui` 这类入口调它。

这一类错误的形状值得记一下：**同一个设置在两种生命周期下的正确值相反**，
而错的那一边不报错、只表现为「地址是对的但连不上」。

【实测】`npm run ui -- Umbra_design`：27 份稿、6 屏界面、本地 API 已注入；
入口页 / 六个壳 / tokens.css / support.js / 一份真稿全部 200；
`/__ud/drafts` 带令牌返回稿件清单，不带令牌 403。

### 29.4 `build_index` 自己维护租户的 `.gitignore`

**问题**：`build_index` 往项目目录里写十几个文件，而哪些文件该忽略是靠
`doc/_模板-租户 .gitignore` 手抄一份清单、新建项目时拷进去的。

实测就落后了：探针项目的 `.gitignore` 是旧版模板，**整个「工具界面与入口页」段都没有**，
于是入口页、四个壳、索引数据、皮肤全变成那个设计仓库里的未跟踪文件。
而模板本身也落后了 —— 它只列到 S5，工具后来又部署了 S7 和 IconGlyph。

**部署了什么只有 `build_index` 自己知道，所以这件事归它做。**
整段带 `<umbradesign:generated>` 标记、整段替换、幂等；
没有 `.gitignore` 就不建（不替人决定要不要用 git）；动过就在 `steps` 里说一句。

模板里那份手抄清单删了，改成一句「不用在这里列，build_index 自己维护」。

【实测】跑一次 `npm run ui`，租户 `.gitignore` 长出那一段，
`git status` 里生成物**一个都不剩**。

---

## 三十、一次漏报：三份渲染不出来的稿报了零 error

### 30.1 现象

另一个 Agent 补的 `S6-版本对比` / `S9-会话面板` / `S10-组件Props面板` 三份稿，
`validate_draft` 全绿、`selftest` 里「界面稿零 error」，而它们**一行都渲染不出来**：

- 没有 `<script src="./support.js">` —— 运行时根本不加载
- 没有 `data-dc-script` 的逻辑类 —— 没有 `renderVals()`
- 模板里却写了 98 / 38 / 49 个洞

浏览器打开只会把 `<x-dc>` 当普通 HTML 显示，`{{ … }}` 原样印在画面上，
「演示态」也切不动（切换靠逻辑类的 state）。

### 30.2 根因：把「没有逻辑类」当成了「没有洞要审」

```ts
const auditable = !audit.opaque && !audit.missing && logicOk;
```

`auditRenderVals` 在 `!d.logic` 时直接 `missing = true` 并回一句
「这份稿没有逻辑类（纯静态稿，没有洞要审）」，于是整块正反向洞审计被跳过。

**「纯静态稿」的真正判据是「模板里没有洞」，不是「没有逻辑类」。**
一份有洞却没有逻辑类的稿，每个洞都没有东西能填 —— 那是**最严重**的一种坏，
反而成了唯一不被审的一种。

### 30.3 处置

两条新 error，都只在能证明的前提下报：

| 码 | 判据 |
| --- | --- |
| `E_HOLES_WITHOUT_LOGIC` | 有 `<x-dc>` 模板 + 有非字面量的洞 + 没有逻辑类 |
| `E_RUNTIME_NOT_LOADED` | 有 `<x-dc>` 模板 + 全文没有 `<script src="…support.js">` |

三条新基准钉住它，**含一条边界**：

- `15-有洞却没有逻辑类要报` → `E_HOLES_WITHOUT_LOGIC`
- `16-没引support没法渲染要报` → `E_RUNTIME_NOT_LOADED`
- `17-真纯静态稿不报`（没有洞、也没有逻辑类）→ **一条都不报**

【实测】加完之后：三份坏稿各报 2 条 error（合计 6 条），
其余 8 份界面稿与 57 份存量语料**一条都没被误伤**，基准 17 条全过。

### 30.4 这条纪律的另一面

`04` §二 写的一直是「**不许误报**」—— 因为一条假的必改项能让设计侧白改上百处。
这次栽的是反面：**漏报**。

> 工具说干净，就必须**真的**干净。
> 「零 error」如果可能来自「这一类根本没检查」，那它就不是一个读数。

判断一条检查有没有意义，要同时问两句：它会不会误伤合法写法（基准 17 钉这个），
以及它**能不能真的抓到**那种坏（基准 15、16 钉这个）。只有前者是半张网。

---

## 三十一、补三份渲染不出来的稿 · 顺带量清一类解析期属性

接 §三十。三份稿（`S6-版本对比` / `S9-会话面板` / `S10-组件Props面板`）的
**逻辑类其实是写好的**（166 / 169 / 235 行，DEMOS、state、renderVals、演示数据方法都在）——
坏的只是骨架。所以这不是重做，是补三处。

### 31.1 补了什么

| # | 补的东西 | 为什么 |
| --- | --- | --- |
| 1 | `<script src="./support.js">` + `__resources` 离线映射 | 运行时根本没加载 |
| 2 | 逻辑那段的裸 `<script>` → `type="text/x-dc" data-dc-script data-props="…"` | 运行时与我们的解析器都按这两个标记找逻辑类，缺了等于没有 |
| 3 | `goBack` 等键进 `renderVals` 的返回 | `goBack()` 是**类方法**，不是 renderVals 的键 —— 模板里 `onClick="{{ goBack }}"` 取不到它 |
| 4 | `leftRef` / `rightRef` / `barRef` / `inputRef` 用**类字段**建 | `renderVals` 在首次渲染就会被调用，那时 `componentDidMount` 还没跑，ref 会是 undefined。类字段在首渲染前就有了 |
| 5 | S6 的 `const LIVE = …` | 它的 `goBack()` 里用了 `LIVE`，但从没定义过 |
| 6 | S9 的演示态切换条 | `demoStates` renderVals 里返回了，**模板里却没有对应标记**，所以一个按钮都没有 |

⚠️ S6 / S10 的演示条本来就是完整的，只是用 `as="d"` 且没有 `aria-pressed` ——
我第一次用 `button[aria-pressed]` 去找，第二次用 `:text-is("正常对话")` 去找，
两次都判成「没有演示钮」。按钮文本其实是 `1\n正常对话`（序号 + 标签两个 span）。
**两次都是检查写错了，不是稿坏了。** 记这一笔是因为：
在断定「东西没做」之前，先怀疑自己的选择器。

### 31.2 实测读数（真 chromium，`render_check`）

| 稿 | alive | 节点 | 未解析洞 | 404 | 外部请求 | 演示态切换 |
| --- | --- | --- | --- | --- | --- | --- |
| S6-版本对比 | ✓ | 149 | 0 | 0 | 0 | 逐个点过，内容真的变 |
| S9-会话面板 | ✓ | 144 | 0 | 0 | 0 | 同上 |
| S10-组件Props面板 | ✓ | 122 | 0 | 0 | 0 | 同上 |
| S8-项目设置 | ✓ | 115 | 0 | 0 | 0 | 同上 |

浏览器里还看到过一条 404，`render_check` 没有把它算进 `missingResources` ——
查了稿里只引 `./support.js` 与 `./_ds-tool/tokens.css`，两个都在。
那是浏览器自己要 `favicon.ico`，`render_check` 不算它是对的。

### 31.3 `render_check` 抓出的一条静态校验不认识的属性

S10 报：`The specified value "{{ p.value }}" cannot be parsed, or is out of range.`
来自 `<input type="number" value="{{ p.value }}">` —— 数字输入框的 `value`
在**解析时**就按数字校验，和 §2.8 是同一类，但我们的判据表里没有它。

拿 6 个探针量清边界，**不外推**：

| 组合 | 报不报 |
| --- | --- |
| `input[type=number][value]` | ✗ **报** |
| `input[type=number][min\|max\|step]` | ✓ 不报 |
| `input[type=range][value\|min\|max]` | ✓ 不报（静默夹取） |
| `input[type=text][value]` | ✓ 不报 |
| `progress[value\|max]` · `meter[value]` | ✓ 不报 |

所以判据只卡 `input` + `type=number` + `value` 这一个组合，
要读同一个开标签上的 `type` 才能判 —— 之前的 `parseTimeRisk(tag, attr)`
只看标签名和属性名，不够，加了第三个参数 `openTag`。

S10 已改 `type="text" inputmode="decimal"`。**S2 的属性面板一直是这么写的**，
当时只是觉得「文本框够用」，现在知道真正的原因了。

### 31.4 又一次：判据写了却不触发

第一版加完判据，基准 18 直接红：**该报没报**。
原因是 `WATCH_ATTRS` 这张「要扫哪些属性名」的表里没加 `value` ——
判据写在 `parseTimeRisk` 里，但扫描根本没走到那个属性。

和 §二十九 那条 `unref` 是同一个形状：**改动写在了一处，而生效要两处都对。**
基准第一次跑就把它照出来了 —— 这正是「只在真犯过之后加基准」还要配一条
「加完立刻跑」的原因。

### 31.5 新增的基准（共 5 条，含 2 条边界）

| 基准 | 钉住 |
| --- | --- |
| `15-有洞却没有逻辑类要报` | §三十 的漏报 |
| `16-没引support没法渲染要报` | 同上 |
| `17-真纯静态稿不报` | **边界**：没有洞也没有逻辑类是合法的 |
| `18-数字输入框的value写洞要报` | §31.3 |
| `19-数字框的minmax与文本框不报` | **边界**：判据没有外推 |

【实测】19 条基准全过 · 界面稿零 error · 语料零误报（`W_HOLE_IN_PARSED_ATTR`
仍是 158 条，说明新判据在语料上一条都没多报）。

## 三十二、设计侧的 ui/ 只到 S7：两棵 ui/ 树，从没同步过

**现象**：Sam 把 ClaudeDesign 项目里的 ui/ 导出到 `表单色板与布局方案/ui`，只有 S1–S7 + IconGlyph；开发侧 `ui/` 已到 S10。

**根因【已核实】**：ClaudeDesign 的项目在云端，**只拥有被上传过的东西**。我们一直只发文档（它的 uploads/ 里只有 6 份 .md，没有一份 .dc.html），所以：

- 它没有 S6 / S8 / S9 / S10 —— 这几屏是开发侧建的，它从没收到过；
- 它的 S1 / S2 是**接线之前的老底稿**（`LIVE` 出现 0 次）。它按 §三 改完交回的 S1 / S2 丢了全部接线：S1 915→660 行、少 27 个键（含生命周期入口），S2 1495→726 行、少 54 个键（含属性面板）；接线标记 4/4、8/8 全丢；
- 它的 S3 / S4 / S5 / S7 / IconGlyph 与上一轮字节一致（这一轮没动）。

它自己没做错：它在自己仅有的文件上干活。错在协议 —— 只发文档、不发文件。

**处置**：不在开发侧手工移植它的 S1 / S2（那是把设计判断搬进开发侧，且底稿不对）。改成把正确底稿发过去，让它在上面重做；它已经给出的裁决（`14` §0.4）由我们实现（`12` M5-8/9/10）。

**新协议（工具化，不靠记性）**：

| 环节 | 做什么 |
| --- | --- |
| `npm run outgoing` | 拷 `ui/*.dc.html` + `_ds-tool` + `_demo`，每份稿 `<head>` 后插一行 `<!-- umbradesign:baseline file sha sent -->`（sha = 正本内容 sha256 前 16 位），写 `README-给设计侧.md`，打成 `outgoing/UmbraStudio-ui-<时间>.zip`；发件记录写 `.umbrastudio/outgoing/<时间>.json`。正本里若已有 baseline 行则拒绝打包 |
| 设计侧 | 整体替换它项目里的同名文件；**保留 baseline 行**；交回放 `ui/_incoming/` |
| `npm run incoming` | ⓪ 底稿检查（覆盖现有文件的稿）：无标记 → **底稿不明**（blocking）；sha ≠ 当前正本 → **底稿过时**，提示三方合并，共同祖先 = 对应 zip 里的同名文件；一致 → **底稿正确**。之后剥掉 baseline 行，照旧在叠加目录里做合法性 + 接线标记检查 |

`BASELINE_RE / shaOf / readBaseline / stripBaseline` 在 `server/src/baseline.ts`，outgoing 与 incoming 共用（outgoing 有顶层副作用，不能被 import）。

**往返实测【实测】**：用包里的 S1 原样改一处文案放进 `_incoming` → 底稿正确、接线 4/4、行数 +1；改动 sha → 底稿过时；这一轮设计侧交回的真实 S1 / S2 → 底稿不明（blocking），正是本节要拦的情况。

## 三十三、设计侧第二轮收稿 · M5-8 / M5-9 接线 · 版本元数据（2026-09-23）

**收稿走 MCP 直连**：ClaudeDesign 的 MCP 有 `list_files / read_file / write_files / copy_files / render_preview / get_conversation / list_comments` 等；能上传（`write_files` 内联 data），不能发消息给它（只能同步会话记录进它的面板，单向）。它项目里 `uploads/UmbraDesign-ui-20260921-1456/` 已在，`ui/_incoming/` 里已放了六份稿 + 回复（归档为 `doc/_archive/16`）。

**取文件的坑【实测】**：`render_preview` 的 serve_url 用 curl 拿到的**不是原文件** —— 宿主在 `<head>` 注入一段 `<style>` + 20 KB `<script>`（`data-omelette-injected`），S1 多出 20,369 字节。做法：先拿发件包里已知内容的 S3 校准，剥掉注入块（含其后两个换行）后与 zip 原件**逐字节一致**，再用同一把尺子取六份；六份字节数与它清单里的 size 全部对上。`read_file` 是实体转义过的正文，能用但 300 KB 要过模型上下文，没走。

**`incoming` 读数**：六份底稿正确、接线 4/4 · 8/8；「少了的键」全是它回复里明说删掉的旧键（S1 `indexStale*`、S2 底栏胶囊那 10 个、S6 `left/rightHighlights`、S8 四个空函数）。一条 blocking：S8 `E_TAG_UNBALANCED` —— 它把设置区包进两层容器只补了一个闭合，浏览器自动补齐所以它那边看不出。本地在模板区末尾补一行 `</div>` 后零 blocking（已告知它，见 `doc/14` §零）。

**工具化两处**：`incoming --apply` —— 底稿正确 + 零 error + 接线齐全的稿整文件并入 ui/（剥 baseline 行，原件从 `_incoming/` 移除）；逐块移植只是底稿不对时的补救。`outgoing` 带上运行时三件套（它拿不到外网，没有 React 打开白屏）。

**读数**：selftest 零 error；六屏 `render_check` alive、洞 0、404 0、外部请求 0、控制台 0（S1 1044 节点 / S2 208 / S6 160 / S8 117 / S9 146 / S10 109）；真浏览器逐屏看过，S8 危险操作、S1 过期态、S2 版本弹层与未落盘横条形制与回复一致。

**顺带修掉**：`agenttest` 自 bf6a144 起全挂 —— 测试稿没引 `support.js`，`E_RUNTIME_NOT_LOADED` 拒绝落盘；换成校验器认可的骨架后 4/4。它的临时项目 `server/test-agent-project` 曾被提交进仓库，每跑一次就删一次，已取消跟踪并进 `.gitignore`。

### 33.1 M5-8 · S1 索引过期

本地 API 新增 `POST rebuild_index`（调 `buildIndex`，serveUrl 用本服务地址）。S1 `onRebuild` LIVE 下 POST 完**整页重载** —— build_index 重写的就是这一页，再拉一次 `index_status` 只会清横条、列表读数还是旧的。
【实测】touch 一份稿 → `index_status` stale → S1 齐边横条（时钟 + 结论 + 文件名药丸）+ 行级「文件已改」+ 三列灰、健康不灰 → 点「重建索引」→ 横条消失、版本列 v4 → v5、底栏「索引生成于 刚刚」。

### 33.2 M5-9 · S2 版本弹层 + 未落盘横条

- **版本元数据** `.umbrastudio/snapshots/<稿>/meta.json`：`{ v: { origin, capturedAt, summary } }`，在 `write_draft` 末尾记 —— 唯一写入口，所以每一版都有；快照本身可能几 MB，弹层只要三个字段，单独一张小表。
  `origin` 只有三个取值（设计侧 §3.2）：v1 一律「新建」；默认「AI」（走 MCP 的调用方都是模型）；本地 API 的 `set_prop` / `revert` 显式标「人手改」。`summary` = 最重的一条变更的 message（L1 > L2 > L3 > L4，多于一条带「另有 N 处」）；回退版用回退备注那句。
- `changes` 路由带 `versionMeta[v] = { src, time, summary }`，`time` 走 `humanTime`（今天 HH:MM / 昨天 / MM-DD）。**S2 一个字没改**就显示出来了 —— 它读的正是这个键名。
- 未落盘横条的「落盘」钮：`previewStyle` 时记 `previewSlot`，`onCommit` 调 `applyProp`（和字段上回车同一条路）。
  【实测】改 padding 不回车 → 横条 `[data-ud-node="fec4d9c9"] · style.padding → 4px 8px · 文件还是 v5` → 点落盘 → v5 → v6，撤销可用。
- **抓到一条真缺陷**：第一次点「落盘」时，输入框先失焦已经在落盘，钮又发了一次；两次并发写共用 `<稿>.umbrastudio.tmp`，第二次 `rename` 报 ENOENT（画面上是属性行一条红字）。修两处：`writeAtomic` 临时文件名唯一（pid + 时间 + 随机，失败时清掉）；`onCommit` 在 `s.busy` 时不再发。修后复测 v5 → v6 干净。

**通道 B 顺手核过**：`claude --help` 里 `--print / --output-format / --model / --brief / --mcp-config / --allowed-tools / --system-prompt` 都在（2.1.278）。但 `chat_send` 的通道 B **复用通道 A 的 baseUrl / apiKey / model** —— GLM 的 Anthropic 端点和 DeepSeek 的 OpenAI 端点不是一个地址，真跑通道 B 之前 `ai_config.json` 要拆出 `channelB`（登记在 `doc/11` §四）。

## 三十四、M5-10 应用前端 UI-1..UI-8 · S6 接真数据 · 通道 B 独立配置（2026-09-23）

**应用前端**（`server/ui/index.html`，Tauri 壳里的那一页）按设计侧八条裁决（`doc/14` §0.4）重写：

| 项 | 落地 |
| --- | --- |
| UI-1 | 底栏两档（220px / 半屏）+ 顶部拖拽把手（120px–80vh，双击切档）；收起留 32px 条，tab 仍在。档位与高度记 localStorage |
| UI-2 | 稿件图标改 SVG：页稿=文档、组件稿=六边形，path 与 S1 / IconGlyph 同一套；不再用「页」「组」字 |
| UI-3 | 体检中的那一行：spinner + 上次健康色压到 55%，不进四色。完成后按 `indexpage.judgeHealth` 同一口径就地重算健康（侧栏缓存只在 build_index 时刷） |
| UI-4 | 底栏「对比上一版」→ S6 独立窗口（Tauri `WebviewWindow`，开不了就交给系统浏览器）；S6 不进底栏 |
| UI-5 | 搜索范围不动 |
| UI-6 | 顶栏一颗实心「新建稿件」+ ⋯ 菜单（重建索引 / 在浏览器打开 / 项目设置·外观 / 关闭项目）；顶栏不会长到五颗 |
| UI-7 | 新建项目换成面板：目录（对话框或手填）→ `inspect_dir` 探查 → 「已是项目，直接打开」/「已有 N 份稿，会接管」；项目名校验；不做模板 / Git 开关 |
| UI-8 | 主题 浅 / 深 / 跟随系统（默认跟随），挂 `html[data-tool-theme]`；放「项目设置·外观」面板。S8 接线前它是这条设置的落点 |

配套服务端：`drafts` 路由合并 `index-data.json` 的类型 / 健康 / 元素数 / 版本；新增 MCP 工具 `inspect_dir`（只读）。

**顺手修掉一条接手前就有的缺陷**：前端体检轮询按 `job.id` / `status` 读，而作业接口给的是 `jobId` / `running` / `ok`（§二十三），所以「体检」永远转不完。现在对上了，完成 toast 报节点数与耗时。

**浏览器调试模式**：`index.html?url=<服务地址>&token=<令牌>&name=<项目>` 不经 Tauri，只靠本地 API（MCP 类操作会提示「要在应用里做」）。这一轮的读数就是这么量的：把前端拷进测试项目当 `app.html`，同源，所有路由都通。

### 34.1 S6 版本对比接真数据

设计侧交回的 S6 只有 `LIVE` 开关，数据全是演示的。「对比上一版」要有真实落点，所以：

- `changes` 路由加 `to`（任意两版，`diffDrafts`）和 `since=prev`（上一版）；新增 `version_html?file&version` 把 `.src.html.gz` 里的那一版按 HTML 发出，`<head>` 里塞 `<base href="/<稿目录>/">` 让 `./support.js` 解析回稿所在目录
- S6：`pull(prev, latest)` 拉 `changes`；版本下拉换一端就重拉；两栏各一个 iframe 装 `version_html`，onload 按内容高度撑开，外层滚动条对等同步照旧；变更条 / 筛选 / 清单视图 / 无差异态全部读同一份 `diff.changes`（字段和演示数据同名，设计侧当初就是照真数据形状写的）
- `SHELLS` 加 S6，build_index 会把它部署进项目

【实测】t.dc.html v5 → v6：左栏 padding 20/40、右栏 4/8，差异条 `L2 <button>「点我」 的 padding 从 8px 16px 改到 4px 8px`；render_check alive、160 节点、洞 0、404 0。

### 34.2 通道 B 独立配置（Q11 落地）

`ai_config.json` 加 `channelB: { baseUrl, apiKey, model }`；`set_ai_config` 加 `channel: a|b`；`chat_send` 通道 B 改读 `getChannelB()`，不再回落到通道 A（端点不同，回落只会打到错的地址）。两条通道仍都没真跑过 —— 等 key。

## 三十五、两条 AI 通道第一次真跑（2026-09-23）

用户给了一个智谱 key。key 只在 `.umbrastudio/ai_config.json`（`chmod 600`，`.gitignore` 内），不进仓库、不进本文。
实测脚本走 MCP stdio 真调 `chat_send`（不是 agenttest 那种模拟），判据 `01` §7.6 第 23 条。

### 35.1 通道 A（智谱通用 API，OpenAI 兼容）—— ✅ 跑通

两条真缺陷，都是代码写完从没跑过才留下的：

1. **端点拼接丢路径**：`new URL("/chat/completions", baseUrl)` 会把 `https://open.bigmodel.cn/api/paas/v4` 的路径整段丢掉，POST 到根 → nginx 405。改成字符串拼接。DeepSeek 的 base 没路径所以从没暴露。
2. **发给模型的 messages 里没有用户那句**：`chat_send` 把用户消息 `addMessage` 进会话后没拿回更新后的对象，history 从旧对象取，只剩 system 一条 → 智谱 400「messages 参数非法」。用一个 `UMBRASTUDIO_AI_DEBUG=<路径>` 开关把请求体落盘才看出来（provider.ts，留着）。回包的 messages 同样要重新读盘。

修后读数：`把「测试.dc.html」里的那个按钮改成 danger 态` → 23.6 s，12,555 tokens，模型调了我们的工具把稿从 v1 写到 v2（`background: #ff4d4f`），`changes` = L2 ×1，`revert_to v1` 后 `#0066ff` 回来。**判据三件全中。**
DeepSeek 端点没跑（没 key），同一适配器，M2-1 验收里「分别对 DeepSeek 与智谱跑通」只有后一半。

### 35.2 通道 B（Claude Code 子进程 → 智谱 Anthropic 端点）—— ⛔ 卡在套餐

`claude --print` 挂到 120 s 超时，三种变体（裸 / 去掉嵌套环境变量 / 带 `--brief`）都一样，stderr 只有 `unrecognized_model` 警告。分辨仪器还是世界：

- 直接 curl `…/api/anthropic/v1/messages`：**0.38 s 回 429**，`[1309] 您的 GLM Coding Plan 套餐已到期`
- 同一台机器用本机登录跑 `claude --print "只回复 ok"`：9.4 s 正常返回

所以链路（spawn / `--mcp-config` / `--allowed-tools` / 输出解析）没被证伪，卡的是 Claude Code 对 429 的静默重试 + 套餐过期。
加了**端点预检**：spawn 前先发一条 `max_tokens: 1` 的最小请求，非 2xx 立刻把原话回给上层（实测 0.4 s 报 `HTTP 429 …套餐已到期`），不再白等 120 s。
**通道 B 的最终验证等套餐续订**（或换一把 Coding Plan 的 key）。

`--brief` 顺便查了：它是「给 agent 开 SendUserMessage 工具」，和「简短」无关，对 headless 没用处；先留着不动，等真跑通再决定去留。

### 35.3 新增

`chat_list` / `chat_get` 两个 MCP 工具（应用前端会话面板要列会话、读历史）。

## 三十六、M2-12 · S9 会话面板接进应用前端（2026-09-23）

- `executeToolCall` + `chat_send` 主体抽成 `server/src/chat_run.ts`（`runChatSend`），MCP 工具与本地 API 共用一份逻辑；本地 API 新增 `chat_list` / `chat_get`（GET）、`chat_send`（POST）。`changes[]` 带 `from` / `to`，面板据此一键回退。
- `originOk` 放行 `tauri://localhost` / `http(s)://tauri.localhost` —— 接手前 Tauri 壳里所有 POST 路由（体检、set_prop、回退）都会被 403，这次才发现（令牌照样要带）。
- 前端右侧栏按 S9 形制：默认 380px 可拖 320–520，收起成 36px 竖条（通道字母 + 未读点 / 转圈）；一个 AI 回合一根左栏，工具调用单行（名 + 参数 + 结果，完整内容在 title）；运行中转圈 + 底部 2px accent 线，「中断 Esc」占发送位；底栏只留用量（通道 A 没有价格表，先显示 tokens）；变更卡「改了 x · L2 ×1（v6 → v7）」+「回退到 v6」；会话与项目绑定，打开项目自动接最近一条。
- 「中断」只中止前端等待（fetch abort）：服务端这一轮仍会跑完，落盘照常可审可回退；真正的中断要等流式 / 作业化（M2-5 那条的「可中断」目前就是这个口径）。
- 方式 ②（选中节点）没接：前端预览的是稿本身，不是 S2 壳，点选桥不在这一层。先把当前选中的稿名带进消息。

【实测】Playwright 驱动 Chrome 打开前端（浏览器调试模式）→ 发「把这份稿里的按钮改成 danger 态」→ 智谱 21,271 tokens，回合里列出 get_component / set_prop / validate_draft 等工具行，稿 v6 → v7（`#ff4d4f`），变更卡 L2 ×1 → 点「回退到 v6」→ v8 是回退版，按钮回到 `#0066ff`。`01` §7.6 第 23 条**在应用里闭环**（浏览器调试模式；Tauri 壳里同一份代码，差 Origin 那条已放行）。

### 35.4 DeepSeek 也跑通了 · agent 多了一个 `read_draft`（2026-09-23 晚）

用户给了 DeepSeek key，通道 A 切到 `https://api.deepseek.com` / `deepseek-chat`。第一跑 **ok 但没改稿**：模型说「I don't have a way to read the raw draft content directly」，猜了三轮 `locate_node` 的地址后转去 `render_check`，15.6 s、41k tokens、零改动。智谱之前是碰巧走到了 `get_component(mode=full)` 才拿到源码。

工具集里缺一个名字就叫「读稿」的工具 —— 模型要改稿先得看见稿。加 `read_draft(project, path)`：返回源码（60 KB 截断，带截断标记），里面每个元素自带 `data-ud-node`，`set_prop` 直接用；系统提示里点名「改稿前先 read_draft，不要猜地址」。

修后：**3.3 s、11.7k tokens**，`read_draft → set_prop(node=df30a937) → validate_draft → read_draft` 四步，v1 → v2（`#d92d20`），L2 ×1，回退成功。M2-1 验收「分别对 DeepSeek 与智谱跑通」两半都有读数了。

## 三十七、方式 ② 进应用 · 键盘可达性 · 仓库上远端（2026-09-23 晚）

### 37.1 方式 ②：应用前端的预览改走 S2 壳，选中节点带给 AI

应用壳（Tauri：`tauri://localhost`）和本地服务跨源，前端**注不进**点选桥（桥靠同源 `contentDocument`）。所以不在前端重做一套：预览 iframe 默认装 **S2 预览壳**（`S2-…?file=<稿>&embed=1`），S2 本来就注桥、有属性面板（方式 ①）；`embed=1` 让它不画「索引」链接，并把 `select` / `clear` 用 `postMessage({source:"umbradesign-s2"})` 转给父窗口。前端记 `state.picked`，会话输入区上方出药丸「已选中 <button> t.dc.html · 4a009e85」，发送时带 `selectedNodeFile / selectedNodeAddress`，服务端照 M2-8 的路 `locateNode` 解析成系统提示。预览还留一档「稿本身」。

【实测】Playwright：选中按钮 → 说「这里字号大一点」→ DeepSeek 只改那一处：diff `L2 <button>「点我」 font-size null → 20px`，别的零变更。`01` §7.6 第 22 条在应用里闭环。

顺带抓到一条真缺陷：**工具结果落盘没带 `tool_call_id`**，续接会话时历史里的 tool 条目对不上 assistant 的 tool_calls，DeepSeek 直接 422。修：`addMessage` 时存 `toolCallId / toolName`；组历史时 `sanitizeHistory` —— 没 id 的 tool 条目丢掉、配不齐结果的 `tool_calls` 从 assistant 里剥掉（留文本），旧会话也能续。

### 37.2 M5-6 键盘可达性（第一遍）

稿件列表 `role=listbox` / 行 `tabindex=0`：↑↓ 移焦点、Enter / 空格选中、Home / End；全局 `/` 聚焦搜索、`Cmd/Ctrl+J` 聚焦会话输入（收起时先展开）；面板 Esc 关、首个输入框自动聚焦、`:focus-visible` 描边。没做：面板内焦点圈死、底栏 tab 的方向键。

### 37.3 仓库第一次推上 GitHub

`git@github.com:TestEngineerFish/umbra-studio.git`。第一次推被 GH001 拒：M3-5 把 106 MB 的 `src-tauri/binaries/node-aarch64-apple-darwin` 提交进了历史。处理：打备份标签 `backup/pre-purge-node-binary` → `filter-branch` 从 master 全史剥掉它 → `.gitignore` 加 `src-tauri/binaries/node-*` → `src-tauri/binaries/README.md` 写本地生成办法（`cp $(which node) …`）。推上去 75 个提交，master 里已无 >50 MB 的对象。

## 三十八、壳内自测：Tauri 壳里第一次真走主流程（2026-09-23）

**为什么要有它**：前端这几轮的实测都在浏览器调试模式（同源）里做；Tauri 壳是另一个环境（跨源、`invoke` 参数走 Rust）。
macOS 上 `tauri-driver` 不支持，没法从外面驱动 WKWebView，只能让前端**自己在壳里跑一遍**，每步把读数写进文件。

**做法**：Rust 加两条命令 `get_autotest`（读环境变量 `UMBRASTUDIO_AUTOTEST_DIR` / `_LOG`）、`autotest_log(line)`（追加写）。
前端 `boot()` 末尾若拿到 dir，就依次：sidecar 状态 → 打开项目 → 选第一份稿 → `validate`（GET）→ `check`（POST）→ `changes` → `chat_list` →
`build_index`（MCP）→ `inspect_dir`（MCP）→ S6 新窗口 → 主题。只读、只建索引，不改稿。

```bash
pkill -f target/debug/app   # 先杀旧实例：single-instance 会让新进程静默退出，读数文件根本不会生成（2026-09-23 栽过两轮）
UMBRASTUDIO_AUTOTEST_DIR=<项目目录> UMBRASTUDIO_AUTOTEST_LOG=<读数文件> npx tauri dev --no-watch
# 看到 {"step":"done"} 就可以杀掉进程；每行一步 JSON
```

**第一跑就抓到三条壳里的真缺陷**（浏览器调试模式看不见的）：

| # | 现象 | 根因 | 修 |
| --- | --- | --- | --- |
| 1 | 任意路径的项目在壳里打不开：「找不到目录对应的项目」 | `open_project_command` 只在 `list_projects`（projects/ 根）里按目录找；`loadProject(nameOrDir)` 参数名有 Dir 却从没处理过绝对路径 —— M1-2「项目可在任意路径」在壳里是假的 | `loadProject` 认绝对路径（要有 `project.json`）；壳里找不到名字就把路径当项目标识 |
| 2 | dev 模式下所有 POST 路由 403 | 前端来源是 `http://127.0.0.1:1430`（Tauri dev server），`originOk` 只认 sidecar 自己的端口 | 本机任意端口的 `127.0.0.1` / `localhost` 放行（真正的门槛是随机令牌，Origin 只挡跨站页面） |
| 3 | 壳里所有 MCP 调用失败：`missing required key msgId` | 前端传 `msg_id`，Tauri 把 Rust 参数 `msg_id` 映射成 `msgId` —— **接手前壳里的「重建索引」从来没成功过** | 改传 `msgId` |

**读数**（修后第二跑 / 第三跑）：sidecar running → open_project（任意路径）✓ → select_draft（预览走 S2 壳 `embed=1`）✓ → validate ✓ → check POST ✓（jobId 返回）→ changes ✓（9 版 · versionMeta 9）→ chat_list ✓ → build_index（MCP）✓ → inspect_dir（MCP）✓ → S6 新窗口 ✓ → 主题 ✓。

**没盖到的**：系统目录对话框（要人点）、会话发送（要 key 与时间，浏览器模式已验）、打包后的 `tauri://localhost` 来源（`originOk` 已放行，但没在打包产物里跑过 —— `01` §7.7 第 24 条仍待干净机器一遍）。

## 三十九、S8 项目设置接进应用（2026-09-23）

应用的「项目设置」面板原来只有主题一档；设计系统、限额、回收站、危险操作这些 M1 后端能力只在 S8 设计稿里。现在：

- 本地 API 七条：`project_settings`（GET，一次给全：基本信息 · 设计系统含 token/图标/组件计数 · 限额 · 回收站清单）、`project_update`（POST，改完立刻 `buildProject` 换掉服务里的 Project 对象，下一次校验就用新限额）、`trash_restore` / `trash_purge` / `trash_empty`、`project_archive` / `project_delete`（后者要把项目名敲一遍；两者现在都是移到 `.archived/`，成功后 300ms 停掉本项目的服务）。`refs.ts` 加 `purgeTrash`（只认 `.umbrastudio/trash/` 下的路径）与 `emptyTrash`。
- S8：判据同 S5（`window.__UD_API`）；`liveVals()` 键名与演示态一模一样，模板不分叉；字段改完即存（600ms 防抖，和 S2 属性面板一个口径，没有「应用」钮）；`?embed=1` 收起索引链接；归档 / 删除成功、回收站恢复后 `postMessage` 给父窗口（`umbradesign-s8`）。重命名 / 移动两行标「未接」—— 后端没有这两个操作，不装有。
- 应用：设置面板变宽，嵌 S8 iframe；收到 `project-gone` 关项目、`drafts-changed` 刷新列表。**面板打开时整页重绘不再重建它** —— 否则稿件列表一刷新 S8 就整个重载（第一跑就撞上）。
- `SHELLS` 加 S8，build_index 部署进项目。

【实测】Playwright：设置面板里 S8 读到真配置（`meta-test · 1 份稿`、路径）；curl `project_update` 改标题与 warn 阈值，`project.json` 立刻变；先删一份稿进回收站 → S8 回收站 tab 列出 → 点「恢复」→ 稿件列表 1 → 2。S8 render_check（演示态）alive、117 节点、洞 0。

## 四十、会话作业化：边跑边看、真正能中断（2026-09-23）

`doc/12` M2-5 标的「流式 / 可中断」原来不成立：`chat_send` 同步一次返回，「中断」只停前端等待，服务端那一轮照跑；模型的消息也是循环结束才一次性落盘。现在：

- **作业化**：本地 API `chat_send` 传 `async: true` 时走 §二十三 的作业登记（键 `<项目>::chat::<会话>`，同会话不起第二个）：先建好会话再起作业，立刻回 `jobId + sessionId`；`chat_status?job=` 轮询；`chat_interrupt {job}` 触发该作业的 `AbortController`。MCP 的 `chat_send` 与 API 不带 `async` 的调用照旧同步。
- **逐步落盘**：`provider.chat` 加 `onReply` 钩子；`runChatSend` 在每条模型回复到达、每个工具出结果时立刻 `addMessage`（不再在循环末尾批量写）。界面每 1.2 s 拉一次 `chat_get`，工具行边跑边长出来；中断时已跑的步骤也在会话里。
- **中断收口**：`abortSignal` 传到 agent 循环；fetch / 读 body / 工具执行任一处因中断抛错都按 `interrupted: true` 返回，不当成错误。通道 B 的子进程暂不支持中断（只有超时）。
- 应用前端：发送 → 起作业 → 轮询（会话 + 作业状态）→ 结束时读 `changes / usage / interrupted`；「中断 Esc」发 `chat_interrupt`。

【实测】Playwright：发「改背景、文案、padding」→ 4.5 s 时 `running=true`、已见 4 条工具行 → 结束 8 条工具行，v11 → v14，L2 ×2 · L3 ×1；再发一句「整份重写成仪表盘」→ 1.5 s 后点中断 → 0.94 s 停下，注记「已中断」。

**没做的**：token 级流式（SSE 逐字出字）。现在是步级流式；要逐字得把 provider 改 `stream: true` 再往界面推，收益是「看见模型在打字」，先不排。

## 四十一、往 ClaudeDesign 发包的实况与边界（2026-09-23）

包 `UmbraDesign-ui-20260923-0255`（17 个文件、718 KB）经 MCP 直接放进它的 `uploads/`：

- `write_files` 只能内联 `data`（`local_path` 服务端未实现），子代理逐文件 `cat` → 转录 → 写入。16/17 落地，字节数逐个核过。
- **上限**：单次调用输出约 64k token。`react-dom.production.min.js`（132 KB ≈ 7.6 万 token）放不进一次调用，写不上去；base64 更大，也不行；`write_files` 无追加语义，分片拼不出单文件。→ **≥ 100 KB 的文件走 MCP 传不了，请用户拖进它的 `uploads/`。**
- **转录不保证字节精确**：S2（120 KB）子代理转录后远端 120129 vs 本地 120130。它回来时不影响底稿判定 —— `incoming` 比的是 baseline 注释里记的 sha 与我们正本的 sha，不 hash 它交回的文件 —— 但小文件也要核 size。`support.js` 的 33 字节差用 `copy_files` 从它项目里的原件服务端复制修正（同名原件在就优先走这条）。
- 第一个子代理把 S2 + react-dom 合成一批写，撞上限被终止；改成一文件一代理、一次调用才稳。

## 四十二、M6-1 / M6-3 / M6-4：会话栏在左、源码视图、演示全屏（2026-09-23）

用户拍板 Q13–Q15 后的第一批（`doc/16` 的三条便宜项）：

- **M6-1 布局**：`state.layout = chat-left | chat-right`（默认 chat-left，跟 ClaudeDesign 一样会话在左），设置面板里切；工作区按布局拼列 `[会话][把手][稿件列表][把手][预览]` 或反过来，会话栏拖拽把手的方向随布局翻转。稿件列表可收成 36px 窄条（显示稿数，点展开）。
- **M6-3 源码视图**：预览三档变四档「编辑壳 / 稿本身 / 源码」；新路由 `source?file=` 给盘上原文；表格行号，选中节点所在行（含 `data-ud-node="…"`）高亮并滚到。只读 —— 改源码是 AI 或 S2 的活，不在这里开口子。
- **M6-4 演示**：预览工具栏「演示」→ 覆盖层装稿本身的 iframe + `requestFullscreen`；Esc / 退出钮 / 系统退出全屏都收掉。

【实测】Playwright：默认列序 `chat-rail · chat-resize · sidebar · resize-handle · preview`，切 chat-right 后反过来；列表收起 36px；源码 19 行带行号；演示覆盖层装 `/t.dc.html`，Esc 收掉。

## 四十三、M6-5 文字就地编辑 · 应用前端改分区渲染（2026-09-23）

**就地编辑**：点选桥（`runtime/select-bridge.js`）在点选模式下双击 → `edit-request` 给 S2；S2 先 `locate`，只有 `kind=text` 且 `editable` 的字面量文案才回 `edit-start`，桥把元素设 `contenteditable`（全选、描边）；Enter / 失焦 `edit-commit`，Esc `edit-cancel` 还原。S2 收到 commit 走 `applyProp(slot, text, "text.(文本)")` —— 和属性面板里改文案同一条落盘路。洞上的文字给一句来源说明，不进编辑。底栏出「就地编辑中：Enter 落盘 · Esc 放弃」。不做输入期预览：文本由 React 托管，提交后 set_prop 落盘、iframe 重载，闪回比没有更糟（§二十五 的同一条理由）。S2 顶栏顺带加「演示」（iframe 全屏，M6-4 的 S2 侧）。

**应用前端改分区渲染**：原来 `render()` 每次把整个应用 `innerHTML` 重建 —— 选中节点、会话轮询（每 1.2 s）都会让 S2 壳和它里面的稿重载；就地编辑第一跑时内层 iframe 直接被卸掉。先试过「把同一个 iframe 元素挪回新 DOM」，不行：iframe 只要重新插入就重载。现在骨架只在换稿 / 换档 / 换布局时重建（`workspaceKey`），平时只替换顶栏 / 侧栏 / 预览工具栏 / 底栏 / 会话栏 / 演示层各自的元素，预览 iframe 原地不动。

【实测】Playwright：点选开 → 双击按钮 → 编辑态、底栏提示 → 改成「保存草稿」回车 → v14 → v15，diff 仅 `L3 text_changed 提交 → 保存草稿`，文件里按钮文案已变。

## 四十四、M6-2 钉在节点上的评论（2026-09-23）

决策 `11` Q14。评论是**项目的**东西（`.umbrastudio/comments.json`），不进稿：`{ id, file, node, tag, text, createdAt, resolved, resolvedAt }`。

- 后端 `comments.ts`：`listComments / addComment / updateComment / deleteComment`；本地 API `comments`（GET，可按稿）、`comment_add / comment_update / comment_delete`（POST）；MCP 工具 `list_comments`（模型改稿前能看设计侧留的话）。
- S2：属性面板底部加「评论」区 —— 只列选中节点的，textarea ⌘⏎ 添加，每条可「已处理 / 恢复」「删除」；`pullComments` 后把未处理计数按节点推给 iframe。
- 点选桥：`set-pins` 消息在节点右上角画琥珀色小圆点（数字 = 未处理数），滚动 / 缩放跟随；地址找不到（内容改过）就不画，不静默丢评论。
- 应用：底栏第四个 tab「评论」，待处理数做角标；每条「发给 AI」= 设 `state.picked` 为那个节点 + 把评论文字填进会话发送（走方式 ②）；「已处理」「删除」；S2 那边增删后 `comments-changed` 上报刷新。
- 不做画框（Q14 明说）。ClaudeDesign 的评论是给队友的；我们是单机，评论的去处是 AI。

【实测】Playwright：点选按钮 → 面板留言「这个按钮再大一号，字号 28px」→ 「1 条未处理」、稿上钉子 1 → 应用「评论」tab 列出 → 「发给 AI」→ DeepSeek 只改那一处 `font-size 24px → 28px`（v16 → v17）→ 标已处理 → 钉子 0。

## 四十五、设计侧第三轮收稿：S1 行内撤销接线（2026-09-23）

设计侧在 `UmbraDesign-ui-20260923-0255` 的 S1 上交回（`ui/_incoming/S1` + `19-设计侧回复（第三轮）.md`，归档 `doc/_archive/19`）。`incoming`：底稿正确、零 error、接线 4/4，`--apply` 并入。它同时裁决了会话栏放左（同意，理由「先说后看」+ 迁移肌肉记忆）—— 与 M6-1 已做的一致。

它给的键 `justDeleted / trashed / actionsFor`、方法 `deleteDraft / undoDelete / settleDeleted`、请求 `POST delete_draft { file }` / `POST restore_draft { file }` 全部照接：本地 API 补这两条路由 —— `delete_draft` 走 `refs.deleteDraft`（回收站语义）；`restore_draft` 只拿到稿名，取回收站里同名最近删的那份 `restoreDraft`。乐观更新由它的稿自己做（先塌行再请求，失败把行放回并说清）。

【实测】Playwright 在部署后的 S1（`index.dc.html`）：行末 ⋯ → 删除 → 该行塌成「已移到回收站 · 撤销」、磁盘上稿进 `.umbrastudio/trash/` → 点撤销 → 文件回到原位、行回来。S1 render_check alive、洞 0。

这一轮设计侧没有欠项；下次发包前照旧 `npm run outgoing`。

## 四十六、入口对齐 ClaudeDesign：首页项目列表 · 进项目直接工作台 · 浏览器入口统一（2026-09-23）

用户跑 `npm run ui` 看到的是 S1 稿件索引页，和 ClaudeDesign 的首页（项目列表）/ 项目页（左聊天右画布）都不像。根因是入口分裂：S1 那十屏是浏览器形态的设计稿，应用前端是后来另起的一页，文档的「看界面」又指向前者。三处一起改：

- **`/__app/` 由 sidecar 托管应用前端**（`serve.ts`）：读 `server/ui/index.html`，`<head>` 注入 `window.__UD_APP = { url, token, name, title, dir }`；`/__app/_ds-tool/…` 从 `server/ui/` 出。和稿同源，所有 API 直接用。`npm run ui` 打开的就是它；`index.dc.html` 退成 build_index 的入口页备用。
- **首页 = 项目列表**（M6-6）：新路由 `projects`（全局：最近打开 + projects/ 根下全部，目录已不在的不列；缩略图取索引里元素最多且有截图的那份，base64 内联）；前端列表 / 网格、搜索、星标（本地）、最近打开时间、当前项目高亮；`open_project` 路由给别的项目起服务并跳到它的 `/__app/`。Tauri 里走 `list_projects` + 最近项目（没缩略图）。
- **进项目直接工作台**（M6-7）：`enterProject()` 读稿件列表后自动打开上次看的稿（`ud.lastDraft.<dir>`）或第一份；稿件列表默认收成窄条 → 两栏；文件切换放进预览顶栏的页签下拉（带搜索、新建稿件、展开列表栏）；Logo 回首页。

缩略图只有跑过体检的稿才有（`checks/*.png`），没跑过的显示稿数。

【实测】Playwright 用真项目 `Umbra_design`（29 份稿）：`/__app/` 打开即左会话 + 右预览（自动开 PC 吐司），列序 `chat-rail · sidebar.collapsed · preview`；文件页签下拉 29 行；Logo 回首页列出 3 个真实项目（临时目录已滤掉）；列表 / 网格可切；点另一个项目 → 起它的服务并跳过去，自动开了它上次看的稿。


## 四十七、第一轮扫测：自动建索引 · 浏览器模式建稿建项目 · 导入目录 · 在访达中显示 · 体检后刷新（2026-09-23）

用户在首页点 57 份稿的「umbra」项目报「打开项目失败：项目根还没有 index.dc.html，打开根路径会 404」，并提了两条需求（首页快速打开目录、「打开目录」名字歧义）。这一轮用 Playwright（`/__app/` 浏览器模式，项目副本 `umbra_copy`）+ 壳内自测（Tauri，副本 `umbra_copy3`）做了一次探索性扫测，12 条发现按 `17` 的规范写成 issue 草稿（`issues/2026-09-23/`），状态表在 `12` §九。修掉的 7 条：

- **自动建索引**（根因）：`serve_start` 对没索引的项目原来返回 error 级诊断，壳里直接当失败；`open_project` 路由起了服务却不建索引，进去后 S2 / S6 / S8 / 点选桥全 404。改成两处都顺手 `buildIndex`，`serve_start` 返回 `note`「第一次打开，已自动建索引并部署界面壳」；前端 `fetchDrafts` 见 `indexed:false` 再兜底重建一次。
- **浏览器模式建稿 / 建项目**：新路由 `create_draft`（blank / copy / component）、`create_project`、`inspect_dir`（GET）；前端 `!T` 时走它们。
- **「打开目录」→「导入目录」**：选目录后 `inspect_dir`，是项目直接开，不是就进新建面板接管（预填路径与建议名）。浏览器模式直接进面板。
- **在访达中显示**：首页每行 + 项目「⋯」菜单；Tauri 走新 Rust 命令 `reveal_dir_command`（shell 插件 `open` 的默认作用域只放行 http / mailto / tel，本地路径过不去，所以不用它），浏览器走路由 `reveal_dir`。
- **体检后健康读数不刷新**：`health` 是 `build_index` 从体检记录算的，`check` 作业不动索引 → 前端体检结束后先 `rebuild_index` 再拉列表。
- S2 诊断无行号显示 `Lundefined:undefined`（信封约定省略 `line`，S2 用 `!== null` 判）→ `!= null`，本地补的一行，随下次发包。
- favicon 404 → 内联 SVG。

**没修、要拍板的两条**（`11` Q16 / Q17）：导入的稿没有节点地址所以点选不到（方式 ① ② 对用户自己的稿全失效，这条最重）；缩略图只有体检过的稿才有。**待修**：应用本体没有稿件改名 / 复制 / 移动 / 删除入口（只在 S1）；壳内自测被 single-instance 吞掉；首页同名项目网格分不清。

**GitHub**：token（`~/Documents/SourceTree/Geek/.secrets/gh-token`）对仓库是 admin，但建标签、建 issue 都 403「Resource not accessible by personal access token」—— 细粒度 PAT 没勾 Issues 读写。草稿与 `issues/post.sh` 已就绪，权限补上后一条命令提交（查重 fp、建标签、已修的顺手关）。

【实测】浏览器模式（`pwfix.mjs`）：从未建索引的副本 `open_project` → 索引与 S2 壳文件生成 → 进应用 57 份稿全部带元素数、S2 内层 7 节点可选；新建「扫测新稿」落盘并选中；`/tmp/ud-sweep-proj` 建成并跳入；`reveal_dir` 对不存在目录报「目录不存在」；首页「导入目录」钮与 3 个访达钮在。壳内自测（`umbra_copy3`）：sidecar running → open_project 57 ✓ → select_draft 走 S2 壳 ✓ → validate / check / changes / chat_list ✓ → build_index 57 ✓ → `reveal_dir_command` 对坏目录 rejected ✓ → inspect_dir ✓ → S6 ✓ → 主题 ✓。第二轮扫测（`pwmore.mjs`）：6323 元素大稿 S2 壳 1429 ms 画完、源码视图 17937 行 413 ms、体检 1438 ms；删除 → 恢复 ✓；1024 宽无横向溢出；空项目进去能建第一稿。回归：selftest / lifecycletest / agenttest 4/4 / rendertest 15 条全绿，`cargo check` 过。

## 四十八、画布工具栏合成一条：S2 嵌入模式收掉自己的 chrome（2026-09-23）

用户截图：进项目后右上角按钮堆满，「体检」「演示」各两颗，诊断三处。根因是 S2 按独立整页设计，嵌进应用后它的顶栏两行 + 状态栏 + 右栏页签和应用自己的工具栏、底栏叠在一起（`issues/2026-09-23/13`）。

- **S2 嵌入模式**（`EMBED`，即 `?embed=1`）：`showHead: !EMBED` 把顶栏两行、右栏标题行、底部状态栏整块 `sc-if` 掉；`isDiag / isChange` 加 `!EMBED`；`railOpen` 在嵌入时只在有 `slots`（选中节点）后为真 —— 右栏退成纯属性 + 评论面板，和 ClaudeDesign 的 Edit › Simple 一样。**独立打开的 S2 一个像素不变。**
- **父窗口指令**：S2 `onMsg` 新认 `{ source: "umbradesign-app", type: "cmd", cmd, value }`，`cmd ∈ pick | preset | zoom | theme | recheck | clear`；`componentDidUpdate` 在嵌入时把 `{ selectOn, preset, zoom, draftTheme, picked, busy, editHint, checkNote, apiErr }` 去重后用 `shell-state` 回报父窗口。
- **应用工具栏**（`previewToolbarHtml`）一条：`[☰ 列表] [稿名 ▾] │ [编辑 | 预览 | 源码] │ [PC 1440 ▾] [－ 70% ＋] [☀/☾] [就地编辑 / 落盘中 / 出错 的一句话] …… [点选] [评论 n] [● 体检] [▷ 演示] [⋯]`。`⋯` = 在浏览器打开 / 对比上一版（S6）/ 变更与版本 / 重新加载预览。画布控件只在「编辑」档显示。顶栏只剩 `⋯`（「新建稿件」进文件页签下拉和 `⋯`）。
- **fit**：第一次收到 `shell-state`（preset=PC、zoom=1）且画布比 1440 窄，就发 `zoom = floor(宽/1440×20)/20`（1036px 画布 → 70%）。换稿时重置。
- 名字：「编辑壳 / 稿本身」改叫「编辑 / 预览」，对齐 ClaudeDesign 的 Edit。

【实测】Playwright（`pwtb.mjs` / `pwtb2.mjs`）：工具栏 11 项、嵌入的 S2 可见文字为空；`pick` → 桥 `select` → 属性面板出现（12 个 style + 2 attr + 1 text）→ `clear` 收起；`preset 2 / zoom 0.8 / theme dark` 各自生效并回报；fit 70%；「预览」档只剩 8 项；独立 S2 顶栏照旧。selftest 零 error。

## 四十九、M7-1 改名 Umbra Studio（2026-09-24）

依据 `11` Q25 / Q28：仓库改名（GitHub 侧用户操作）、本地目录 `Geek/UmbraStudio`、`server` 包名 `umbrastudio-server`、MCP server 名 `umbrastudio`（`channel_b` 的白名单 `mcp__umbrastudio__*` 同步）、配置目录 `.umbradesign/` → `.umbrastudio/`、环境变量 `UMBRADESIGN_*` → `UMBRASTUDIO_*`（`PROJECTS_ROOT / CHROMIUM / AI_DEBUG / AUTOTEST_DIR / AUTOTEST_LOG`，无旧名兜底）、Tauri `productName` / `identifier` / 菜单名、发件包名 `UmbraStudio-ui-<时间>.zip`、文档全文（`_archive/` 与 `18` 不动，历史发件包名按原样留）。

**不改的（格式与协议级，`.dc.html` 格式名不改的精神）**：`<!-- umbradesign:resources -->`、`umbradesign:baseline`、`umbradesign:index-data`、`<umbradesign:generated>` 四组注释标记，postMessage 的 `source`（`umbradesign` / `umbradesign-shell` / `umbradesign-s2` / `umbradesign-app` / `umbradesign-s8`），`data-ud-node`、`x-ud-token`、localStorage `ud.*`。改这些会让现有用户稿、`fixtures/` 基准和设计侧手上的底稿全部失配，换不来任何东西。所以 M7-1 验收里「`grep -ri umbradesign` 只剩 git 历史 / `_archive` / `18`」**做不到也不该做**：剩下的命中 = 这几组标记 + `.gitignore` 里刻意保留的旧目录名一行。

**迁移**：`project.ts` 新增 `UD_DIRNAME` / `migrateUdDir(dir)` —— 项目目录下有 `.umbradesign/` 且没有 `.umbrastudio/` 时整目录拷一份（`fs.cp recursive`），旧目录不删；`buildProject`（`loadProject` 两条路都经它）和模块加载时的 `TOOL_ROOT` 各调一次。部署清单与租户 `.gitignore` 模板两个目录名都忽略。

【实测】旧项目副本（`.umbradesign/` 2 个文件）`loadProject` 一次后 `.umbrastudio/` 出现、文件数一致、旧目录仍在；工具根同样迁出 `.umbrastudio/`（`ai_config.json` 在，AI 通道不用重配）。`selftest` 零 error · `lifecycletest` 全通 · `rendertest` 15/15 · `cargo check` 过。

## 五十、M9-1 壳 spike：Electron 自带 Chromium 跑体检 · 核心跑在主进程里不影响 MCP stdio（2026-09-24）

半天封顶，两条都过。脚本在 scratchpad `spike/`（`main-cdp.js` / `spike1.mjs` / `main-core.js` / `spike2.mjs`），Electron 44.4.5（Chrome 152）、playwright-core 1.63.0。

**① playwright-core 经 CDP 接 Electron 自带 Chromium 跑 `render_check`**

`render.ts` 加一条通道：环境变量 `UMBRASTUDIO_CDP=http://127.0.0.1:<port>` 存在时不 `chromium.launch`，改 `chromium.connectOverCDP`，且不再要求系统 Chrome。Electron 的 CDP **不支持新建隔离上下文**（`newContext` / `newPage` 不可用），所以用默认上下文里壳开的那个隐藏窗口的页（`contexts()[0].pages()[0]`），再 `setViewportSize`。`page.route`（断网拦截）、console / pageerror / requestfailed 监听全部照旧生效。

| 稿 | 通道 | alive | nodes | renderMs | console | 墙钟 |
| --- | --- | --- | --- | --- | --- | --- |
| PC 吐司 | Electron CDP | true | 24 | 1501 | 2 | 2181 ms（首次） |
| Umbra PC 端（6323 元素） | Electron CDP | true | 6320 | 1421 | 52 | 1513 ms |
| PC 吐司 | Electron CDP（第二次） | true | 24 | 1421 | 2 | 1501 ms |
| PC 吐司 | 系统 Chrome（原路，对照） | true | 24 | 1430 | 2 | 3424 ms |

读数与系统 Chrome **逐项一致**（alive / nodes / console 条数 / diags 数），墙钟反而短 —— 省掉了每次起浏览器的 ~2 s。CDP 端口从 Electron 起到可连 1110 ms。

**② 核心跑在 Electron 主进程里，MCP stdio 出口不受影响**

`main-core.js`：`app.whenReady` 后开隐藏窗口、设 `UMBRASTUDIO_CDP`，然后 `await import(server/dist/index.js)` —— 核心原样在主进程里起，`StdioServerTransport` 用的就是 Electron 主进程的 `process.stdin / stdout`。外面用 MCP SDK 的 `StdioClientTransport` 把 `electron main-core.js` 当 server 起：

| 步 | 结果 | 耗时 |
| --- | --- | --- |
| initialize | ok | 568 ms（含 Electron 启动） |
| listTools | 60 个 | — |
| list_projects | 3 个项目 | 8 ms |
| serve_start（副本项目） | ok | 5 ms |
| render_check PC 吐司 | alive · 24 节点 · 1439 ms | 1757 ms |
| render_check Umbra PC 端 | alive · 6320 节点 | 1512 ms |
| validate_draft | ok | 7 ms |

协议全程走通就是 stdout 没被污染的证据（一个字节的杂音都会让 JSON-RPC 断）；Electron / Chromium 的日志全在 stderr（共 269 字节）。

**结论**（回填 `11` Q26）：**换 Electron 可做。** 一份 Electron 同时给了壳、自带 Chromium（M9-3 顺手成立，不再要系统 Chrome）和跑核心的 Node，Tauri 那 106 MB 的 sidecar 与三平台三种 webview 的问题一并消失。

**三条注意**（做 M9-2 时处理）：
- Electron 的 CDP 只有一个上下文一页，`render_check` 并发时会抢同一页 —— 壳里给体检专开一个隐藏窗口，作业本来就串行（`jobs.ts`），够用；要并发就多开几个窗口做池。
- `npm install electron` 的二进制下载在这台机器上直连 GitHub 失败（`fetch failed`），走 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 才下来 —— M9-4 打包脚本要把镜像写进 `.npmrc`。
- 主进程里跑核心时 `process.stdin` 就是 MCP 的入口，壳自己不能再用 stdin；壳与前端的通道走 HTTP + WS（M7-4），不冲突。

## 五十一、设计侧第四轮发包实况（2026-09-24）

包 `outgoing/UmbraStudio-ui-20260923-1431.zip`（改名后第一包）。和 0255 包比，去掉 baseline 行后只有 4 个文件变了：S1（并入第三轮行内撤销）、S2（嵌入模式 + 诊断行号判空）、`tokens.css`（产品名注释）、README。

做法（省 token，也省它那边的 etag 冲突）：`copy_files` 把它项目里的 `uploads/UmbraDesign-ui-20260923-0255/` 整目录服务端复制成 `uploads/UmbraStudio-ui-20260923-1431/`（17 个文件，含上轮手动拖入的 react-dom），再只覆盖变了的四个 + 两份文档 + 交办单：

| 文件 | 途径 | 云端 / 本地字节 |
| --- | --- | --- |
| `…/ui/S1-稿件索引.dc.html` | 子代理 `write_files` 内联 | 87846 / 87846 ✓ |
| `…/ui/S2-单稿预览壳.dc.html` | **传不上去**（131837 字节，超单次输出上限；`local_path` 参数服务端未实现） | 云端仍是 0255 版 120129 |
| `…/ui/_ds-tool/tokens.css`、`…/README-给设计侧.md` | `write_files` 内联 | ✓ |
| `uploads/14-给 ClaudeDesign 的交办单（2026-09-23 第四轮）.md` | 子代理内联 | 29604 / 29604 ✓ |
| `uploads/08-工具界面设计需求（2026-09-23 第四轮）.md` | 子代理内联 | 40711 / 40711 ✓ |
| `uploads/21-交办单（2026-09-23 第四轮）.md` | 内联；写明 S2 待手动拖入、本轮不改 S2 | ✓ |

S2 放在 `outgoing/手动拖入/S2-单稿预览壳.dc.html`，请用户拖进它项目的 `uploads/UmbraStudio-ui-20260923-1431/ui/` 覆盖（与上轮 react-dom 同样处理）。本轮委托不碰 S2，所以没拖之前设计侧也能开工；若它真改了 S2，`incoming` 会报「底稿过时」，按三方合并处理。

**边界再确认一次**：单个文件 > ~100 KB 经 MCP 内联传不动（上轮 react-dom 132 KB，这轮 S2 132 KB）。S2 已经到这个尺寸，后面若还长，要么拆成子组件（`dc-import`），要么发包时改走用户拖入。

触发句：「读 uploads/21-交办单（2026-09-23 第四轮）.md 照做」。

## 五十二、M7-2 / M7-3 / M7-4：新前端骨架 app/ · host adapter · 核心侧 HTTP + WS（2026-09-24）

**app/**（Vite 5 + React 18 + TS + Tailwind 3，与 UmbraPC 同栈，版本对齐它的 package.json）。`base: "/__app/"`，产物 `app/dist/`（不进仓库）。皮肤 token 直接 `@import` 一份 `ui/_ds-tool/tokens.css` 的拷贝（`src/tokens.css`），Tailwind 颜色名全部指向 `--tool-*` 变量，浅深两份靠 CSS 变量切，**token 名没换**。骨架只有两页：首页壳（项目列表 + 搜索 + 导入目录 + 在访达中显示）和空工作台（顶栏 · 会话栏三态 · 预览区永远最大 · 按类型出现的从属面板 · < 1100 px 抽屉），功能一个都没平移（M7-5 / M7-6）。

**host adapter**（`app/src/host/`）：`types.ts` 接口 `pickDirectory / revealInFinder / openExternal / notify / setTitle` + `capabilities()`；`browser.ts` 实现 —— 目录选择框没有（`capabilities().pickDirectory.why` 说清，首页给一个粘路径的输入框），`revealInFinder` 走本地 API `reveal_dir`，通知退化成页面内 toast；`index.ts` 是前端里唯一知道壳存在的地方：`window.umbraHost` 在就是 desktop（M9-2 由 preload 挂上），否则 browser。验收 `grep -r "electron\|tauri" app/src` → **零命中**（大小写不敏感也只命中 `host/` 两处注释）。

**核心侧 HTTP + WS**（M7-4）：
- `events.ts` 事件总线：`emit(type, projectDir, payload)` / `subscribe`。四种事件都是「提醒」，前端收到后按需再 HTTP 拉正文：`job`（`jobs.start` 起 / 完）、`chat`（`chat.addMessage`）、`write`（`writeDraft` 落盘后；`createDraft` 也发一条 —— 它没走 `writeDraft`，直接 `writeAtomic` 写模板，这是 M1 留下的旁路，**登记为待修**）、`fs`（`fs.watch(recursive)` 项目目录，200 ms 合并，只报稿 / 文档 / 图片一类，`.umbrastudio/` 不报）。
- `serve.ts`：每个项目服务挂一个 `ws`（`WebSocketServer noServer`）在 `/__ud/ws?token=`，令牌与 Origin 门槛同 HTTP；连上先回 `hello`。`/__app/` 改为托管 `app/dist`（SPA：非静态路径回 `index.html`，`window.__UD_APP` 多带 `ws` 与 `front`），没 build 过退回旧前端；旧前端另挂 `/__legacy/` 直到 M7-8。
- 前端 `api/client.ts`：`Core.get / post / events(onEvent)`，WS 断了 2 s 重连。

【实测】Playwright，`umbra_copy`（58 份稿）：`/__app/` 打开 `front=app`、React 挂载、标题由 host.setTitle 设为「Umbra 私人 AI 助手 · Umbra Studio」；WS `hello` 已连；往目录里写一个 `.md` → 收到 `fs`；`create_draft` → 收到 `write`；`check` 作业 → 收到两条 `job`（起 / 完）；选稿 → `.dc.html` 类型的从属面板出现；会话栏 收成输入条 → 展开 → 换边，`us.layout` 记住；窗宽 1000 时从属面板变抽屉（`aside.fixed`）；首页列出 6 个项目、`/__app/home` 深链可开；`/__legacy/` 旧前端照常。断网 build：产物 165 KB，无外链。回归：`selftest` 零 error · `lifecycletest` 全通 · `rendertest` 15/15。

**没做、下一步做的**：桌面壳（M9-2）需要一个不属于任何项目的「hub」服务（首页要在没打开项目时就能列项目）—— 现在 `/__app/` 仍由某个项目的服务托管，浏览器入口 `npm run ui -- <项目>` 不受影响；hub 随 M9-2 一起做。

## 五十三、M9-2 / M9-3：Electron 壳（2026-09-24）

`shell/`（Electron 44，`main.mjs` + `preload.cjs`，electron-builder 配置在 `package.json.build`）。Tauri 目录、根 `package.json`、sidecar 二进制规则全部删除。

**主进程起核心**（§五十 的做法）：`import()` `server/dist` 的 `serve.js / project.js / workspace.js`，起 **hub 服务** `hubStart()`（不属于任何项目：只托管 `/__app/` 与全局路由 `projects / open_project / create_project / inspect_dir / reveal_dir`，别的路由回 404 `E_API_HUB`；`ApiCtx.project` 因此可空）。主窗口开 `hub/__app/home`；项目服务由前端调 `open_project` 按需起，`open_project` 现在也返回 `ws`，前端拿 `{url, token, ws}` 直接跨端口连（CORS 与 WS 的 Origin 门槛本来就放行本机任意端口）。带 `--mcp` 时再 `import index.js`，stdio 归 MCP —— 秘书 / 其它模型客户端把这个可执行文件当 MCP server 起就行。

**desktop adapter**：`preload.cjs` 用 `contextBridge` 挂 `window.umbraHost`（`pickDirectory / revealInFinder / openExternal / notify / setTitle / capabilities / onEvent`），前端 `host/index.ts` 见到它就是 desktop。壳主动发的事走 `host:event`：菜单「打开目录」→ `open-dir`，「回到项目列表」→ `go-home`，上次没正常退出 → `dirty-restart`。

**体检走自带 Chromium**（M9-3）：`remote-debugging-port=0`，端口从 `userData/DevToolsActivePort` 读，写进 `UMBRASTUDIO_CDP`；隐藏窗口 load `about:blank#umbrastudio-check`。`render.ts` **按这个标记找页**：第一版拿 `pages()[0]`，主窗口先开之后 `pages()[0]` 就是用户的主窗口 —— 体检把它导航走了，Playwright 报「Execution context was destroyed」才抓到；现在找不到标记页且不止一页就报错，体检完把页导回标记 URL。CDP 模式只有这一页，`renderCheck` 加了串行队列。

**单实例 / 未落盘提示**：`requestSingleInstanceLock`，第二个实例退出、第一个聚焦。启动写 `userData/session.json { cleanExit:false }`，`before-quit` 改 true；下次启动见到 false 就发 `dirty-restart`，前端 toast「上次没有正常退出」。真正的逐稿未落盘状态随 M7-6 平移 S2 时接上。

**打包**：`extraResources` 把 `server/dist + server/node_modules + runtime + ui + app/dist + fixtures` 放进 `Resources/core/`，主进程按 `app.isPackaged` 切 `CORE_ROOT`。electron-builder 与 Electron 二进制都要走 npmmirror（`shell/.npmrc`）。

【实测】`shell/shelltest.mjs`（Playwright `_electron`，把 `<scratchpad>` 换成实际目录）：起壳到首页 1.3 s，列 6 个项目，`umbraHost.kind = desktop`、`pickDirectory.ok = true`；两个窗口（隐藏体检页 + 主窗口）；主进程 `UMBRASTUDIO_CDP` 已设；菜单事件 `open-dir` → 工作台「58 份稿 · WS 已连」；壳里 `check` 作业 alive · 24 节点 · 1430 ms，期间 `ps` 里 headless Chrome 进程 0；第二个实例 exit 0；SIGKILL 后重开 toast「上次没有正常退出」出现，正常退出后重开不出现；`--mcp`：MCP 客户端 initialize 678 ms · 60 工具 · `list_projects` ok，客户端断开后壳进程随之退出。打包：`electron-builder --mac --arm64 --dir` → `shell/out/mac-arm64/Umbra Studio.app` 366 MB，启动 `packaged:true`、hub 可开、`/__app/home` 200。回归：`selftest` 零 error · `lifecycletest` 全通 · `rendertest` 15/15。

**没做**：签名 / dmg / x64 / Windows（M9-4）；「干净机器双击」（`01` 第 36 条后半）没有机器可验；`createDraft` 绕过 `writeDraft` 的旁路（§五十二 提到）仍在。

## 五十四、设计侧第四轮收稿：S11 工作台布局壳 + 第 1 题答复（2026-09-24）

设计侧按 Sam 的口头要求只交三件：换底稿、S11、`08` §三之三第 1 题答复（`ui/_incoming/22-设计侧回复（第四轮）.md`，归档 `doc/_archive/22`）。S12–S14 它已画了第一版但**没放进 `_incoming/`**（等第 1 题定了再过一遍），S15 / S1 / S9 未动。

- **换底稿**：它 `ui/` 里 16 个文件的 size 与 1431 包逐个一致（S2 131837 = Sam 手动拖入的新版）。「交办单说 17 个、包里 16 个」—— 第 17 个是 `README-给设计侧.md`，在 `ui/` 外面，它没数错。
- **S11**：`read_file` 取回 36489 字节（与云端一致）→ `incoming`：新文件、error 0 · warning 1 · 141 元素、零 blocking → `--apply` 并入。新稿没有 `__resources` 块，`incoming --apply` 也不注入（原样 `writeFile`）—— 用 `node runtime/inject-resources.mjs ui` 补上；它同时想改 `IconGlyph` 与 `S7`（这两份一直没有块），**已还原**，免得设计侧手上这两份的 baseline 失配，下次发包前再统一补。
- **第 1 题答复**：从属面板**统一右侧一列**（40 px 图标轨常驻 + 300 px 面板体，同一时刻只开一个；底栏只留 24 px 状态行；图片 / 目录整列不出现；窄窗时面板体变 320 px 抽屉盖在预览上）。与 `08` 的倾向和 R1–R5 一致，**采纳**。顺带给了第 2 题（类型图标：`IconGlyph` 七种单色描边）和「已选中」药丸位置（紧挨输入框；展开态在上方，输入条态在左侧），一并采纳。
- **它提的两件需要我们表态的**：① S2 嵌入模式只留画布，属性面板由 S11 这一列装（要动 S2）→ 登记 `11` Q30 待拍板；② `layout.panelByKind: { dc: "props"|null, md: "outline"|null }` → 采纳，新前端 `layout.ts` 的 `side` 记录按它改名。`chatMode` 取值 `"expanded" | "bar"` 采纳。

【实测】并入后本地起静态服务、断外网，六个演示态逐个点：① dc 四面板 / 属性展开 · ② md 只剩大纲 · ③ 图片无从属面板 · ④ 输入条只占预览列、药丸在输入框左 · ⑤ 会话在右、从属面板贴预览 · ⑥ 1024 模拟窗、抽屉盖预览 + Esc；全部零洞、控制台零 error。截图 `S11-工作台布局壳@1440x900.png` 与回复描述一致。`selftest` 零 error（12 份界面稿）· `rendertest` 15/15。

## 五十五、M7-5 / M7-6：现有能力平移进新前端（2026-09-24）

旧 vanilla 前端（`server/ui/index.html`，1729 行）的能力按 S11 形制重写成 React 模块：`store/project.ts`（稿件 / 诊断 / 评论 / 变更 / 源码 + 体检作业 + WS 事件驱动刷新）、`chat/useChat.ts` + `ChatRail.tsx`（S9 形制，作业化轮询、工具行、变更卡回退、「已选中」药丸）、`workbench/Canvas.tsx`（§四十八那条工具栏 + S2 嵌入壳 / 稿本身 / 源码只读 / 演示全屏）、`workbench/SidePanels.tsx`（40 px 图标轨 + 340 px 面板体：属性 / 诊断 / 变更 + 版本历史回退 / 评论 + 发给 AI / 稿件信息；窄窗抽屉）、`sheets/Sheets.tsx`（新建稿件 / 新建项目 / 设置嵌 S8）、`pages/Home.tsx`（列表 / 网格 / 星标 / 搜索 / 缩略图 / 导入目录）。页签按项目记在 localStorage；布局键名照设计侧：`chatSide / chatMode / chatWidth / panelByKind`。

**Q30 过渡态**：属性面板仍是 S2 自带的 —— 面板体选「属性」且选中了节点时，S2 的 iframe 向右多铺 340 px，它的右栏正好落在面板体的位置；没选中时面板体给一句提示。M7-7 再把 S7 搬进 React。

**旧前端退役前的差异**：`doc/12` M7-8 之前 `/__legacy/` 仍可用；新前端没有做的：稿件列表侧栏（页签 + 「N 份稿」下拉替代）、底栏诊断（进右列）、稿件改名 / 复制 / 删除入口（`issues/09` 本来就没有）。

【实测】浏览器模式（`pwm76.mjs`，副本 58 份稿）：进项目自动开上次的稿、页签 + 状态行；S2 壳装上；诊断 2 条；变更面板版本历史；评论 1 条；桥 `select` → 药丸 + iframe `calc(100% + 340px)` + S2 右栏出现；源码 64 行；会话栏 收成输入条 / ⌘\ 展开 / 换边；新建稿件 → 落盘 → 自动选中；演示覆盖层（真全屏）；体检完成 14 节点；设置面板嵌 S8（基本信息 / 设计系统 / 限额 / 回收站 / 危险操作）；1000 px 窄窗面板变抽屉；首页 6 行 / 6 卡 / 搜索 5 / 从首页开项目。**落盘 → 回退闭环**（`pwrev.mjs`）：`set_prop` → v2 → WS `write` → 变更面板「2 版 · 人手改 · font-size」→ 回退 → v3 → 稿里 15px 消失、状态行 v3。壳（`shelltest.mjs`）全过。**方式 ② 真调 AI**：选中节点 + 发送 → 1 s 内回「HTTP 402 Insufficient Balance」—— DeepSeek 账户没余额，链路到 provider 为止是通的，`01` 第 21–23 条在新前端的复跑等充值后再做。零 console error。

**补跑（DeepSeek 充值后，同日）**：新前端里选中按钮节点 → 「把这个按钮的字号改成 17px，只改这一处」→ AI 调 `validate_draft` + `set_prop`，变更卡「1 处取值变更（v3 → v4）」→ 稿里出现 17px → 点「回退到 v3」→ v5，内容与改前逐字节一致（节点地址除外）。**`01` 第 21–23 条在新前端通过。** 第一次跑时 AI 回 `written:false`：稿里已是 13px，它没改就没有变更卡 —— 这是正确行为，不是缺陷。

**踩到的两处**：① 窄窗抽屉的遮罩把图标轨也盖住，点不到 —— 图标轨提到 `z-40`；② `changes` 路由的 `versionMeta` 键是 `src / time / summary`，第一版按 `origin / at` 读，列出来全空。

## 五十六、设计侧第五轮收稿：S12–S15 新屏 + S1 / S9 改动，全部并入（2026-09-24）

回复归档 `doc/_archive/24`。六份稿 `read_file` 取回，字节数与云端逐一一致；`incoming`：S1（底稿 1431，接线 4/4，1088 → 1142 行，renderVals 70 → 74 键）、S9（底稿 0255，371 → 419 行）底稿正确、零 error；S12 / S13 / S14 / S15 新文件零 error。`--apply` 并入后 `inject-resources` 补 `__resources`（IconGlyph / S7 仍不动）。

【实测】断网逐份体检：S1 1054 节点 · S9 151 · S12 218 · S13 139 · S14 87 · S15 78，全部 alive、控制台零条、零洞、零 404。`selftest` 零 error（16 份界面稿）· `rendertest` 15/15。

**质感四条**（`doc/14`）逐屏看过的判断：六屏都过。S12 读数列按类型换内容、勾选框常驻压透明度；S13 frontmatter 收成一行、大纲按右侧一列；S14 圈选真能拖、不支持时原因常显；S15 一张卡，禁用项原因写在按钮下；S1 / S9 改动都是增量。没有为了填空加的装饰。

**它问的四件，都定了**（回执 `uploads/25`）：① `outline[].line` **计入 frontmatter**，行号 = 文件真实行号（和源码视图、会话里的 `L9–12` 同一坐标系）；② 快照弹层采纳 `snapshots: [{ version, src, at }]`；③ `referencedBy[]` 采纳 `{ file, line? }`；④ 第 3 题采纳（默认列表；图片 ≥ 60% 且 ≥ 6 张自动网格；`layout.viewByDir` 记手动选择）。S1 的 `project.types { dc, md, image, other }` 由索引算；S9 的 `selections[]` 照它的形状接。

这一轮设计侧没有欠项；M7-9 到此收口，S12–S15 的接线随 M8 做。

## 五十七、M7-7 布局引擎 · M7-8 旧前端退役 · 两条落盘 / 编辑缺陷（2026-09-24）

**M7-7 布局引擎 R1–R5 完整版**
- **属性面板搬进 React**（Q30 第二步做完）：`app/src/workbench/PropsPanel.tsx` 照 S7 形制重写 —— 三组 style / attr / text；数字行带单位与步进（px 1 / Shift 10，% 5 / 25，其余 0.1 / 1，↑↓ 也走同一档）；颜色行带色板，候选**只从这份稿自己声明的 CSS 变量**来（`cssvars`），对上设计系统 token 的把路径标在候选里；可改项边敲边预览（只改 iframe 里那张覆盖样式，不落盘），回车 / 失焦 / 步进才 `set_prop`；落盘后绿条停三秒「已改 · 上一版 → 新版 · 撤销」；失败留在那一行、可重试；地址失效时说人话（「回预览里重新点一下那个元素」）而不是把给 MCP 看的 fix 原样抛出来。
- **S2 嵌入模式只剩画布**：`railOpen` 在 `EMBED` 时恒假；新增四条父窗口指令 `preview-style / clear-style / highlight / applied` —— 桥在内层 iframe 里，应用够不着，必须由 S2 转发。
- **会话栏可拖宽**（S11 的 `chatWidth`，300–560）。拖动时**必须在整页盖一层遮罩**：预览是 iframe，鼠标一进它的地盘 `mousemove` 就被 iframe 吃掉，宽度会卡在鼠标离开会话栏的那一刻【实测踩到】。
- **「已选中」药丸泛化五种**（S9 第五轮定的 `selections: [{ kind, label, detail }]`）：可多颗、自动换行、每颗带 ×、两颗以上多一个「全部清掉」。`node` 由 S2 点选桥来；另外四种（`range / region / files / dir`）等 M8 的类型接入。属性面板认的 `picked` 与会话要带的 `selections` **分开存** —— × 掉药丸不该把属性面板一起关掉。
- R3 的记忆键改成设计侧定的 `panelByKind`。

**M7-8 旧前端退役**：删 `server/ui/`（1729 行 vanilla）与 `/__legacy/` 路由；没 build 过 `app/` 时 `/__app/` 给一句「在仓库根跑 npm --prefix app run build」。前端从此只有一份。

**两条缺陷**（`issues/2026-09-24/01`、`02`，都已修）：
1. **`@ds` 展开不看稿在哪**：子目录里的稿展开成相对项目根的 `_ds/…`，浏览器去要 `/<子目录>/_ds/…` → 404，token 全部失效、颜色全错而页面照画。`expandDsAlias` 加 `relPath` 按深度补 `../`；存量稿由 `fixDsDepth` 在唯一写入口上收拾。`selftest` 加六条基准钉住（根 / 一层 / 两层 × `@ds` / 已展开 / 已经对的）。【实测】落盘前子目录解析 404 → `writeDraft` 一次 → 200。
2. **回车落盘发两次 `set_prop`**：`setBusy` 让 input `disabled`，disabled 会自动失焦 → `onBlur` 又提交一次；两个请求并发，后到的撞上已经变了的地址报 400。按行 `inFlight` 去重。旧前端没这个问题是因为它的输入框不 disabled。

【实测】M7-7 扫测（`pwm77.mjs`，项目副本）：S2 嵌入后可见文字为空（只剩画布）· 点选 → 属性面板三组 15 行、标题 `PC 吐司.dc.html L29 <button>` · font-size 行 `px` 单位 + 两颗步进 · 改值盘上不变而覆盖层里有新值 · 回车 → 绿条 `已改 · v5 → v6`、盘上 19px · 撤销 → 19px 消失 · 锁定行 ? 说出 `onclick {{ onAction }} 引用` · 药丸 · 拖宽 380 → 440 且 `us.layout` 记住 · **R4 切稿时会话栏右边界 440 → 440 不动**。回归：`selftest` 零 error（含新增六条基准）· `lifecycletest` 全通 · `agenttest` 4/4 · `rendertest` 15/15 · 壳测试全过。

## 五十八、M8-1 / M8-2：泛型文件层 —— 第二条写入口（2026-09-24）

`.dc.html` 之外的文件（`.md`、图片、json、zip…）也要能列、能读、能改、能挪。`server/src/files.ts` 给它们一条**和 `write_draft` 对应的路**：

    写前 sha256 校验（Q8）→ 存旧版快照 → 原子写 → 存新版快照 → 返回快照号

**两条路不混**。`write_file` 见到 `.dc.html` 直接拒，fix 里写明那条路会做的五件事（归一化 / `@ds` / `__resources` / 节点地址 / 语义快照 + changelog）「这条路一样都不做」；`move_file` 同理指向 `move_draft`。反过来，普通文件**不归一化、不改编码、不动换行、不碰 frontmatter** —— 写进去什么样，盘上就什么样（H5）。

快照放在同一个目录（`.umbrastudio/snapshots/<路径>/`），靠前缀分开：稿是 `v<N>.json`（语义快照），别的文件是 `s<N>.json`（原文 gzip + 元数据 `{ version, src, at, bytes, note }`）。`listVersions` 只认 `v<N>`，两套互不干扰。快照号 `s<N>` 是设计侧 S13 里用的那个形状。

**其它几件**：
- `listFiles(p, dir)` 列一层：目录在前、其余按更新时间倒序（S12 定的顺序），图片带从文件头读出的原始尺寸（PNG / GIF / WebP / JPEG 按段走到 SOFn / SVG 看 width·height 或 viewBox；读不出来就不给 —— 宁可没有，不可以给错的），文本带跳过 frontmatter 的第一行摘录，改过的带最新快照号。工具自己产的（索引页、壳页面、运行时副本、`.umbrastudio/`、`_ds-tool/`）不列。
- `moveFile` 挪文件**并改写稿里指向它的 `href` / `src` / `url()`** —— S15 对用户的承诺就是那句「改名或移动会一并改写引用」，不做的话那句话是假的。改写经 `write_draft`，所以引用变了照样有语义快照可退。
- `referencesOf` 只认出现在 `href` / `src` / `url()` 里的，正文里提到文件名不算引用（S15 的 `referencedBy: [{ file, line }]`）。
- `countTypes` 给 S1 的 `project.types { dc, md, image, other }`。
- 删除是进 `.umbrastudio/trash/<时间戳>/`，和稿一个语义。
- 路径穿越的防法是把 `.` `..` 段整个吃掉，不是报错。

**出口**：MCP 五个工具 `list_files / read_file / write_file / move_file / list_file_versions`（共 65 个）；HTTP 九条路由 `files / file / file_write / file_versions / file_revert / file_move / file_trash / file_refs / file_types`。

**新回归 `npm --prefix server run filetest`**（19 条）。为什么单独一套：`write_draft` 那条被 selftest / rendertest / lifecycletest 从三个角度钉着，这一条一开始什么都没有 —— 而它管的三件事（写前校验别把别人的改动盖掉、旧版留得住、frontmatter 一个字节不许动）**出错都不会让页面白屏，只会安静地丢东西**。

【实测】`filetest` 19 条全过：列一层 7 项 · png 1×1 / svg 48×24 · 摘录跳过 frontmatter · 读二进制不给正文但说原因 · 拒绝 `.dc.html` 并指路 · 写前校验通过后 s1 → s2 · 过期 sha 被拒且说清两边 · frontmatter 逐字节不变 · 回到 s1 后历史仍是 s1..s4 · `referencesOf` 给出文件与行号 · `move_file` 改写引用且被改的稿留下语义快照 · 删除进回收站 · `..` 被吃掉不写到父目录。其余回归：`selftest` 零 error · `lifecycletest` 全通 · `agenttest` 4/4 · `rendertest` 15/15。

## 五十九、M8-3 / M8-4 / M8-5：目录视图 · 多选进会话 · 通用文件卡（2026-09-24）

形制照设计侧第五轮的 S12 / S15，数据走 §五十八 那套泛型文件层。

**目录视图**（`DirView.tsx`）：面包屑 · 列表 / 网格 · 全部 / 只看稿件 · 多选条。
- 默认列表；**非目录文件里图片 ≥ 60% 且 ≥ 6 张**自动切网格，并在视图开关旁写「图片 7 / 7 · 自动网格」说明为什么；手动切过一次就按目录记住（`us.viewByDir`，设计侧定的键名）。
- 读数一列按类型换内容：目录是项数、图片是尺寸、改过的文件是快照号。
- 勾选框**常驻**（平时压到 55% 透明度）—— hover 才出现的话键盘和触控都用不了，这是设计侧给的理由，照办。
- 多选条贴底：已选 N 项 · 取消 Esc · 移动… · 删除 · **带进会话**（实心）。移动走 `file_move`，会顺带改写稿里的引用并在 toast 里说清改了几处。

**多选 → 会话**（M8-4）：一颗 `files` 药丸 + `chat_send` 带 `selectedFiles: string[]`。服务端把**路径、类型、大小、文本的头三行**拼进系统提示，不塞正文 —— 模型有 `read_file`，要看自己去读；这里只保证它知道是哪几个。通道 A / B 都接了。

**通用文件卡**（`FileCard.tsx`，S15）：一张 ≤ 520 的居中卡，元数据三行 + 被引用 + 四个动作。无引用时写「改名、移动、删除都不影响任何稿」；有引用时列出 `file:line` 可点，下面用 warn 色写「改名或移动会一并改写这些引用；删除会让它们变成 404」。禁用项的原因直接写在按钮下面。删除是行内二次确认，不开模态框。

**进项目的默认**：项目里一份 `.dc.html` 都没有时直接进目录视图（`01` 第 25 条）。

**改出来的三处**（真开浏览器看才发现的）：
1. `referencesOf` 把工具自己部署的壳页面（S2–S8、index）也算成「引用方」—— 一个 `support.js` 报 10 条引用，其中 9 条是 `build_index` 干的。改成跳过工具产物，剩 1 条真的。
2. 表格「大小 / 更新」两列贴在一起（`67 B刚刚`）：中文表头比数字宽，列宽 88px 不够。改列宽并加 `gap-x-3`。
3. **内部标记漏到界面上**：目录模式下当前「文件」是 `__root__`，会话输入框的占位符直接显示「对 __root__ 说…」。改成按上下文说人话（「对这个目录说…」/「对 docs 说…」），中文名不加空格、西文名两侧加空格。

【实测】`pwm8.mjs` 九条全过、零 console error：7 项目录 · 7 张图自动网格并说明 · 手动切列表后 `us.viewByDir` 记住 · 面包屑回根 · 多选 2 项 → 底部条 → `files` 药丸 · 只看稿件 · zip 开出文件卡（application/zip、大小、无引用、四个动作）· 删除问「移到回收站？」· 被引用列出 `PC 吐司.dc.html:12`。`01` 第 32 条：三个文件带进会话，`chat_send` 的 `selectedFiles` 真带了三条路径（AI 回合本身因为 DeepSeek 余额不足没跑完，见下）。`01` 第 25 条：纯 `.md` + 图片 + json 的目录 `open_project` 后直接进目录视图，三个文件都在。回归：`filetest` 19/19 · `selftest` 零 error · `lifecycletest` 全通 · `rendertest` 15/15。

**挡住的**：DeepSeek 这个 key 的账号余额 **-0.52 元**（`/user/balance` 查的，`is_available: false`），`chat/completions` 一律 402。用户说充了 10 块，但没到这个账号。AI 回合（`01` 第 30 / 31 / 32 条的后半）要等余额恢复再复跑。

## 六十、M8-6 / M8-7 / M8-8：`.md` 预览 · 源码编辑 · 选中段落给 AI（2026-09-24）

形制照设计侧 S13。

- **渲染 / 源码两档**。渲染用 markdown-it，**打进 `app/` 的构建产物**，不从 CDN 取，断网照常（H2）。`doc/12` M8-6 原写「vendor 进 `runtime/`」—— `runtime/` 是给**稿**用的（稿在 iframe 里跑），`.md` 视图是应用自己的界面，走 app 的构建更对，所以改在这里说明。
- **frontmatter** 在渲染视图里收成一行元数据（`owner sam · status draft`），点一下看原文。只认文件开头那一块 `---`；不在开头的 `---` 是分隔线，不能当它。
- **行号从文件第一行数起，frontmatter 计入** —— 这是我们回给设计侧的口径（`00` §五十六），和源码视图、大纲、会话里的 `L9–12` 同一个坐标系。
- **大纲归右侧那一列**（S11 第 1 题的定稿）。`MarkdownView` 只负责算，不自己画 —— 第一版它自带了一个 300 px 的大纲栏，和从属面板列里的「大纲」**同屏出现两份**，真开浏览器才看见。现在算好了交给 `SidePanels`，点条目经 `ud-md-jump` 事件跳回去。
- **落盘走 `file_write`**（第二条写入口）：带上读到时的 sha256。`.md` 里 Enter 是换行，所以落盘是 ⌘S / 失焦，不是 Enter。未落盘时齐边横条写「还没落盘 · 改了 N 行」，旁边是「放弃」与「落盘 ⌘S」。
- **快照弹层**：352 px，每行「回到这一版」，底下写明「回到旧版时，当前内容会先存成新快照，不会丢」。
- **源码编辑器用带行号的文本框，不是 CodeMirror**。`01` 第 29 条要的是「改一行 → 落盘 → 快照 +1 → 回退能退回；frontmatter 逐字节不变」，选区 → 行号也能做。CM6 是一套 ESM 多包（~300 KB）外加主题与输入法的坑，为了行号引它不划算。**等第二批类型（代码文件只读高亮）真需要语法高亮时再引**，登记在这里。

**AI 那一半（M8-8）**：选一段 → `range` 药丸（路径 + 行范围 + 原文）→ `chat_send.selectedRange` → 系统提示里写明「用户说「这段」时就是指它，**不要再问是哪一段**；先 read_file 拿全文与 sha256，把这一段替换掉、其余一个字都不动，再 write_file 带上那个 sha256」。

**两条挡路的，都在这一轮修了**：
1. **agent 手上没有泛型文件工具**。`chat_run.ts` 的工具表是给稿用的那 22 个，M8-2 加的 `list_files / read_file / write_file / move_file` 只加给了 MCP server（外部客户端），应用内的 AI 拿不到 —— 它面对 `.md` 只会一路撞 `patch_draft` 的「稿的文件名必须以 .dc.html 结尾」，然后诚实地回「I hit a wall」。四件工具补进 agent 表（共 26 件），系统提示里也把两类文件的分工写清楚。
2. **AI 用英文写过渡句**。系统提示开头已经写了「全程简体中文」，DeepSeek 仍会写 `I'll start by reading the file.`。把语言约束**移到系统提示末尾**单列一节后，三句话全是中文 —— 模型对末尾的指令更听话。

【实测】`pwmd.mjs` 八条全过、零 console error：渲染视图（标题 / frontmatter 一行 / 引用块）· 点开看原文 · 大纲在右侧一列且只有一份（三条，行号 L6 / L12 / L19，frontmatter 计入）· 点大纲跳到源码第 12 行 · 源码 22 行、行号 22 格、首行是 `---` · 改一行出「还没落盘 · 改了 1 行」· ⌘S → `已落盘 · 快照 s2`、盘上改了、**frontmatter 逐字节原样** · 快照弹层 2 版 → 回到上一版，改动消失。
**`01` 第 30 条通过**（`pwmdai.mjs`）：源码里选中第 14 行 → `range` 药丸 `需求.md L14` → 说「把这段改成三点列表，别动文档里其它任何地方」→ AI 用 `read_file` → `write_file`，按小节比对：`## 范围` 变了，**头部（frontmatter + 标题 + 引言）与 `## 状态` 逐字节原样**，回答全中文。
回归：`filetest` 19/19 · `selftest` 零 error · `lifecycletest` 全通 · `agenttest` 4/4 · `rendertest` 15/15。

### 六十之一、一条操作事故：`git checkout -- .` 把没提交的改动全撤了

清理测试项目的残留时在仓库根跑了 `git checkout -- .`，**把当时所有未提交的改动一起撤销了** —— `selectedRange` 的三处接线、`.md` 触发 400 的修正、`MarkdownView` 接进 `Workbench`、`md-body` 样式、`markdown-it` 依赖，全没了。

之所以没当场发现：`dist` 是撤销**之前**构建的，所以那一轮测试照样全过 —— 盘上的源码已经回退，跑的却是旧产物。直到 AI 回合报「不确定是哪一段」才顺着查出来。

**纪律**：`git checkout` / `git restore` 一律带具体路径，永远不写 `.` 或 `-A`；要清理测试产物就直接 `rm` 那个目录。已写进 `CLAUDE.md` §8。

## 六十一、M8-9 / M8-10：图片视图与圈选给 AI；顺带推翻一条「不支持图片」的判断（2026-09-24）

形制照 S14。**只看、缩放、圈一块带一句话给 AI —— 不做图像编辑**（`01` §4.2 明写不做）。

- 缩放档位 25 / 50 / 100 / 200 / 400 %，快捷键 `0` 回适配、`R` 开关圈选、`Esc` 取消。SVG 挂 ok 色小标签「矢量 · 可无损缩放」并默认 200 %。底衬棋盘格，透明区看得见。
- **圈选真能拖**：拖的时候虚线框 + 实时的原图像素尺寸，松手变实线 + 四角点，框下贴备注卡（重圈 / 带进会话 ⏎）。**坐标一律是原图像素**，和缩放无关 —— 缩放只是人看得清楚些。
- 带进会话时把圈中那块**裁出来**（canvas，原图像素）连同坐标、备注一起发。会话记录里只存文字，图不进会话文件（一张 base64 能把它撑爆）。
- 通道吃不吃图由 `ai_config.channelA.supportsImage` 决定；不支持时圈选按钮禁用，**原因常显**在一条齐边横条里，不藏在 hover 里。

### 六十一之一、实测推翻：`deepseek-chat` 能看图

用户说 DeepSeek 不支持图片，官方文档也没写多模态。**实测不是这样**：

| 问法 | 回答 |
| --- | --- |
| 纯 #CC22AA 的图 + 「这张图是什么颜色？」 | 「洋红色 #FF00FF」—— 颜色系对 |
| 上黑条 / 左下绿 / 右下黄 + 「分成几块？什么位置什么颜色？」 | 「上方黑色横条，左下绿色方块，右下黄色方块」—— **全对** |
| **同一个问题不给图**（对照） | 「左上红色，右上蓝色，下方绿色」—— 瞎编 |

有图 / 无图对照排掉了「蒙对」。所以按模型名猜一定会误判，而两个方向都难受：判成不支持，用户白白用不了圈选；判成支持，发出去是一条对面读不懂的消息。

**改成给一条硬判据**：`ai_probe.ts` 现场造一张随机纯色小图发过去问颜色，答对了才写 `supportsImage: true`。出口是 MCP 工具 `probe_image_support` 与路由 `ai_probe_image`；界面上那条「不支持」的横条里有一颗「探一次」。按模型名的正则只当没探过时的默认，且**往保守那边倒**。

### 六十一之二、提示里三处「别让它猜」

第一版跑 `01` 第 31 条，AI 答得自信但有两处错，都是前提没给够：
1. 「图是整块纯蓝色」—— 我们只发了圈中那块，它以为那是整张图。→ 提示里写明「随这条消息发过去的**只有圈中的那一块**，不是整张图」。
2. 「约在画面中部偏左上」—— 240×160 的图上 x=130 y=90 明明是右下。补了「原点在左上角，x 向右、y 向下」它还是算错。→ **方位我们自己算**（九宫格），直接写进 label：「整图 240×160 的下右角区域」。模型不用推理，读就行。

改完这一句是：「你圈的这块（原图 x=130、y=90，宽 100、高 60，即整图 240×160 的下右角区域）是纯蓝色，约 #2B4DDB」—— 位置对、颜色对（真值 #2850C8）。

【实测】`pwimg.mjs` 六条全过、零 console error：PNG 头部（240×160 / 893 B）· 缩放 ＋ / － / `0` 回适配 · SVG 矢量标签 + 200 % · 坐标换算 scale 1 时中点 (120, 80)。`pwimg2/3.mjs`：拖框得 `x 20 · y 20 · 80×50`（正是拖的那块）· 裁图 80×50、中心像素 `[220,60,60]` 与左上红块一致 · 请求体 `selectedRegion` 带 label / note / 裁图 base64。**不支持的通道不发图**（`UMBRASTUDIO_AI_DEBUG` 落盘的请求体里 `image_url` 为 false，系统提示改成「你看不到图…需要看图就直说」）。
**`01` 第 31 条通过**：圈右下蓝块 → 「这一块是什么颜色？」→ AI 引用坐标与方位并答对颜色；不支持的通道上圈选是禁用态并说明原因。
回归：`filetest` 19/19 · `selftest` 零 error · `lifecycletest` 全通 · `agenttest` 4/4 · `rendertest` 15/15。

## 六十二、通道 C：火山方舟 Agent Plan 订阅，优先用它、额度用完退回 A（2026-09-24）

用户配了第三条通道（火山方舟 Agent Plan 个人订阅），要求**优先走它，额度没了再用 A**。

**端点得自己探出来**。用户填的 `https://ark.cn-beijing.volces.com/api/plan` 直接 POST `/chat/completions` 是 404。逐条试出来：

| 路径 | 结果 |
| --- | --- |
| `/api/plan/chat/completions` | 404 |
| `/api/v3/chat/completions` | 401（订阅 key 不能用在按量端点上） |
| **`/api/plan/v1/chat/completions`** | **200，OpenAI 形状** |
| `/api/plan/v1/messages` | 200，Anthropic 形状（另一条，我们不用） |

所以 `baseUrl` 要写成 `…/api/plan/v1`（我们的 provider 会拼 `/chat/completions`）。已替用户改好，没碰 key。

**三件必须先验的，都过了**（`doubao-seed-2.1-lite`，实际模型 `doubao-seed-2-1-lite-260915`）：
- **工具调用**：给一个 `read_file` 的 schema，它回了结构正确的 `tool_calls` —— agent 循环的命根子。
- **多模态**：纯 #CC22AA 的图答「紫红色」；`probe_image_support` 探纯蓝答「蓝色」，`supportsImage` 写成 true。
- **中文与用量**：回答中文，`usage` 正常（这个模型有 `reasoning_tokens`，一轮比 DeepSeek 慢些）。

**实现**：C 和 A **同形**（都是 OpenAI 兼容），走同一条 agent 循环，只是配置不同 —— `getOpenAiChannel(ch)` 取哪一条只看通道名。`defaultChannel` 支持 `"c"`，前端三颗通道钮，脚注写当前模型名；没切过通道时跟后端的 `defaultChannel`，切过一次就一直用用户的。

**额度降级**（`11` Q33）：通道 C 报错且**像额度问题**（`looksLikeQuotaProblem`：quota / exceed / insufficient / balance / 余额 / 额度 / 限流 / 429 / 402…）且**这一轮一个工具都没调过**时，自动换 A 再跑一次，并往会话里写一条系统消息说明原委（C 的原始错误也带上）。

两个限制条件都是必要的：
- 只认额度类错误 —— 参数错、网络抖动、key 失效也降级的话，问题会被藏起来，用户只看到「换了个通道还是不行」。
- 只在没调过工具时降级 —— 已经调过工具可能已经落过盘，重跑会**重复改稿**，那比报一次错糟得多。

降级时系统提示按新通道的能力重算（「看不看得了图」那句话不一样），新通道看不了图就把消息里的图片段去掉只留文字。

【实测】
- 通道 C 真跑一轮 agent 改 `.md`：`list_files` → `read_file` → `write_file`，快照 s1 → s2，只改了那一句，回答中文。
- 降级：把 C 的 `baseUrl` 临时指向一个恒返 429 `{"code":"QuotaExceeded"}` 的本地服务 → 会话里出现「通道 C 这一轮没跑成（HTTP 429: …QuotaExceeded…），已自动换成通道 A」→ 真换了 A。（这次 A 恰好也空了，报的是 A 的 402 —— 两条都不可用时报最后那条的错，会话里能看到全过程。）
- `looksLikeQuotaProblem` 八条判据自测全对（429 / 402 / 额度用完 / 余额不足 / quota exceeded 判 true；参数非法 / fetch failed / invalid api key 判 false）。
- 前端：三颗通道钮、C 自动选中、脚注「通道 C · doubao-seed-2.1-lite」、发送时 `channel=c`、回答正常。
- 回归：`filetest` 19/19 · `selftest` 零 error · `lifecycletest` 全通 · `agenttest` 4/4 · `rendertest` 15/15。

**另记**：DeepSeek（通道 A）在这一轮测试里又用完了（余额 -0.47）。agent 循环每轮 prompt 上万 token，十几轮就把 10 块花掉了。日常走订阅的 C 更合适；A 现在只是降级时的后备，后备本身也空着这件事，得让用户知道。

---

## 六十三、M9-4：三平台打包 —— 一次逼出三条「开发模式下永远测不出来」的缺陷（2026-09-24）

`electron-builder` 的 target 从 `dir` 换成 dmg / zip，出四份产物。**但这一条真正的工作不是加 target，
是打包版第一次把 `TOOL_ROOT` 的双重身份拆开** —— 开发时它既是只读资产的根也是可写状态的根，
两者恰好重合，所以下面三条缺陷在 `npm start` 下一条都碰不到。

### 63.1 缺陷一：可写状态写进了 `.app` 内部

`TOOL_ROOT = resolve(server/dist, "..", "..")`。开发时 = 仓库根；打包后 = `Contents/Resources/core`。
于是 `ai_config.json`（**用户的 API key**）、`workspace.json`（最近打开）、`projects/`、`.archived/`
全落在 .app 内部。两条硬后果：

1. `identity: null` 打出来的是 ad-hoc 签名，**.app 内容被改动一次，下次启动就被 macOS 判「已损坏」** ——
   写进去的 key 等于写完就自毁。
2. 装在 `/Applications` 或 Windows 的 `Program Files` 还要再叠一层写权限问题。

**修法**：`project.ts` 分出 `STATE_ROOT`。只读资产（`runtime/` `ui/` `app/dist` `doc/`）仍看 `TOOL_ROOT`；
可写状态看 `STATE_ROOT`，它读 `UMBRASTUDIO_STATE_DIR`，没设时退回 `TOOL_ROOT`。
壳在 `app.isPackaged` 时把它指到 `app.getPath("userData")`。**开发模式一行行为都不变**，这也是为什么
selftest / lifecycletest / filetest 在改前改后读数完全一样 —— 它们测不到这条，得在产物上测。

### 63.2 缺陷二：`doc/` 没进包，`get_syntax_guide` 必然失败

`chat_run.ts` 的 `get_syntax_guide` 从 `TOOL_ROOT/doc` 读 `03-渲染与交互逻辑.md` 与 `06-写稿规则.md`
给 AI 看。`extraResources` 里没有 `doc/` —— 打包版里这件工具一调就是「文件不存在」。
补进 `extraResources`（只带顶层 `*.md`）。

### 63.3 缺陷三：签名不自洽，用户下载后双击是「已损坏」

这条最硬，因为它让产物在别人机器上**根本打不开**，而本机双击却是好的（本机构建的文件没有
quarantine 属性，走不到 Gatekeeper 那一步）。实测过程：

```
$ codesign -dv "Umbra Studio.app"
CodeDirectory flags=0x20002(adhoc,linker-signed)   ← Electron 二进制出厂自带的
Info.plist=not bound                               ← 不覆盖我们塞进 Resources 的 core/

$ xattr -w com.apple.quarantine "0081;…;Safari;" app && spctl -a -vvv app
app: code has no resources but signature indicates they must be present
```

`identity: null` 下 electron-builder 跳过签名，剩下的 linker 签名只签了那个可执行文件。
签名声称有资源但资源没被签 → 校验直接失败 → 用户看到的是**「已损坏，移到废纸篓」，右键打开也救不回来**。

**修法**：`afterPack.cjs` 补一次完整 ad-hoc 签名（`codesign --force --deep --sign -`），签完自己验一次。

| | 签名校验 | 用户下载后双击 |
| --- | --- | --- |
| 修之前 | `code has no resources but signature…` | 「已损坏，移到废纸篓」—— 右键打开也不行 |
| 修之后 | 自洽 | 「无法验证开发者」—— 右键「打开」或系统设置里放行即可 |

`spctl` 仍然 `rejected`，这是**预期**：ad-hoc 没有 Apple 证书也没公证。要免掉这一步得买开发者证书
走 `notarytool`，那是 M9-5。**这条写下来是为了下次别有人把它当缺陷再查一遍。**

### 63.4 `packtest.mjs`：跟 shelltest 问的是两个不同的问题

`shelltest` 跑源码，问「壳的逻辑对不对」；`packtest` 跑产物，问「换台机器还能不能用」。
做法是把 .app **拷到一个跟仓库毫无关系的目录**，配一个全新的 userData，再跑一遍主流程 ——
若壳或核心还偷偷指着仓库，这里就会露。四关：

1. **结构**（离线）：该在的 12 项都在；不该在的 4 项都不在（`typescript` `@types` `fixtures` `ui/_incoming`）；签名自洽
2. **换地方真跑**：启动 → 首页 → 打开一个**从没建过索引**的目录 → 体检
3. **写过一轮之后**：状态落在 userData、`.app` 内部零状态文件、**签名仍然自洽**
4. **当 MCP server 起**（`--mcp`）：秘书接入那条路，66 件工具 + 一次真调用；单实例锁

两条判据的写法值得记：

- **体检认 `alive` + `browser.from`**。只认 alive 不够 —— 这台机器上恰好装着 Chrome，
  体检走系统 Chrome 也会 alive。`browser.from === "UMBRASTUDIO_CDP"` 才证明用的是自带 Chromium。
- **「签名仍然自洽」这条在第一关之前是假判据**。修好补签之前基线就是「不自洽」，
  跑前跑后都不自洽，量到「一致」等于什么都没量到（`04` §2.7 那个坑的同一形状：
  分不清「世界是零」还是「仪器是零」）。先把基线校准成「自洽」，第三关才开始说明问题。

这一轮自己也写错过三次判据，都记在脚本注释里：硬编码稿数（67 是 `find` 数的文件，
57 是 `listDrafts` 过滤掉工具页后的稿，两个定义不同）；`/\d+ 份稿/` 把加载中的「0 份稿」当通过；
单实例那条忘了先起一个实例（没人持锁时第二个进程就是第一个，不退出才对）。

### 63.5 读数

```
产物（electron-builder 26 · Electron 44.4.5 · compression normal）
  mac arm64   dmg 127 MB · zip 134 MB · .app 330 MB
  mac x64     dmg 129 MB · zip 135 MB · .app 336 MB
  win x64     zip 152 MB · 解开 413 MB
  win arm64   zip 153 MB
瘦身：extraResources 排掉 typescript(23M) / @types / fixtures → .app 353 MB → 330 MB

packtest
  mac arm64  34/34   启动 1464 ms · 体检 alive · 24 节点 · 1430 ms · browser.from=UMBRASTUDIO_CDP
  mac x64    34/34   启动 53829 ms · 体检 5709 ms   ← Rosetta 翻译开销，不代表真 Intel 机
  win x64    17/17   结构关（这台机器跑不了 .exe）
  win arm64  17/17   结构关
  MCP：66 件工具 · initialize 711 ms · list_projects 的项目根在 userData
回归：selftest 零 error · lifecycletest 全通 · filetest 19/19 · agenttest 4/4 · rendertest 15/15
```

**还没验的**（诚实记下来）：① win 真机第一次跑（M9-6）；② 真 Intel Mac（本机只能靠 Rosetta）；
③ 一台**没装 Node** 的机器 —— 本机有 Node，这一条本机无论怎么测都测不到，
不过 `app.isPackaged` 分支下核心只用 Electron 自带的 Node，判据上不需要外部 Node。

---

## 六十四、通道 B 打通：用本机已登录的 Claude Code；顺带修掉五条（2026-09-24）

起因是用户想用已付费的 **Cursor Pro**，把 Cursor 的 key 填进了 `channelB`。

### 64.1 Cursor 接不进来 —— 这是能力问题，不是配置问题

【实测】拿用户那把 key 探 Cursor 的 API：

```
GET  https://api.cursor.com/v1/me               → 200（key 有效，key 名 umbra-studio）
GET  https://api.cursor.com/v1/models           → 200（Auto / Grok 4.7 / …）
POST https://api.cursor.com/v1/chat/completions → 404
POST https://api.cursor.com/v1/messages         → 404
```

Cursor 的 Cloud Agent API 是**agent 编排**：`POST /v1/agents` 创建一个在云端沙箱跑的 agent，
对 GitHub 仓库工作，结果以 PR / artifact 交付。它给的是「我帮你跑完整个 agent」，
我们要的是「给我一个模型，agent 循环和 26 件工具我自己有」——**形状根本不同**，
不是改个 baseUrl 能对上的。而且它碰不到本地目录，那正是 Umbra Studio 的核心场景。

用户那把 key 已备份到 `.umbrastudio/cursor-api-key.bak.txt`（不进仓库），没有替他丢掉。

### 64.2 替代方案：`baseUrl` / `apiKey` 留空 = 用本机已登录的 Claude Code

通道 B 本来就是「起 `claude` 子进程」，只是一直把 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`
覆盖成别人的端点（GLM Coding Plan）。**不覆盖就是用户自己的订阅** —— 用户本来就在付这份钱。

实现上有一处要小心：本机登录态时**一个 `ANTHROPIC_*` 都不能设，连空串都不行**，
而且要把父进程里已有的删掉（Umbra 自己可能正被 Claude Code 起着），否则会串到别人的端点上：

```ts
env: usesLocalLogin(cfg)
  ? Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ANTHROPIC_")))
  : { ...process.env, ANTHROPIC_BASE_URL: cfg.baseUrl, ANTHROPIC_API_KEY: cfg.apiKey },
```

端点预检也只对自带端点做 —— 本机登录态没有端点可问，登录态坏了 `claude` 自己会说。

### 64.3 打通过程中露出来的五条缺陷

第一次真跑：**120 秒超时，零工具调用**。逐条查出来的：

| # | 缺陷 | 为什么 | 修法 |
| --- | --- | --- | --- |
| 1 | 系统提示没说当前是哪个项目 | 通道 B 的工具跑在独立 MCP server 进程里，不像 A/C 那样天生知道用户在看哪个项目，只能靠 `project` 参数。不给它就 `list_projects` 猜，而用户打开的目录多半不在 `projectsRoot` 下（**这正是 Umbra Studio 的核心场景**），于是反复试到超时 | 系统提示第一段写死 `project = <绝对路径>`，并明说「不要传项目名，也不要去 list_projects 找」 |
| 2 | `--allowed-tools` 硬编码 23 个工具名 | 工具早涨到 66 件。AI 拿不到 M8 那批泛型文件工具，面对 `.md` 只会撞墙 —— **和通道 A 犯过的是同一个病**（§六十之二）：一张手写的名单，加了新工具就会忘 | 换成 server 级放行 `mcp__umbrastudio`，名单不会过时 |
| 3 | `--output-format json` 拿不到工具调用 | 原来的解析在多行里找 `type:"assistant"` 事件，但 `json` 模式**只吐一个最终对象**，那个循环永远命中不了 → 文件真改了、界面上零工具行 | 换 `stream-json --verbose`，逐行收 `tool_use`，最后一行 `type:"result"` 取回答与 usage |
| 4 | `--brief` 让回答变空 | 它启用 `SendUserMessage`，模型改用那个工具跟人说话，`result` 字段就空了 | 去掉 |
| 5 | 返回的 `messages` 里没有 AI 的回答 | `addMessage` 写的是盘上的文件，而 `messages: session.messages.slice(-10)` 取的是请求开始时读的**内存旧对象** → 前端发一次消息只看得到自己那句 | 拿 `addMessage` 的返回值覆盖 `session` |

另外三个 flag 是顺手加的，都有实测依据：

- `--strict-mcp-config`：不加的话子进程继承用户整套环境 —— **实测继承了 54 台 MCP server**
  （插件 / claude.ai 连接器 / 别的项目的 server），一堆 `needs-auth` 与 `failed` 要在启动时逐个连、超时。
- `--setting-sources ""`：不继承用户 settings。实测它把用户的「输出风格」hook 整段灌进了系统提示。
- `--max-budget-usd`（默认 0.5）：**花钱的硬上限**。agent 循环每一步都重发整段上下文，跑飞一次能烧掉一天的额度。
  撞上限是正常收尾，错误信息里要说清是「你自己设的刹车起了作用」，不然用户只看到「失败」。

### 64.4 一个会骗人的读数

`usage.inputTokens` 原来把 `cache_read_input_tokens` 也加了进去。cache read 按 10% 计价、
量却常常是十几万，加进来会让「这一轮多贵」虚高一个量级：

```
一轮实测：input 10 · cache creation 21831 · cache read 118000 · 折算 $0.072
加总报 139915 → 看着像烧了十几万 token 的钱，其实主要是缓存命中
```

现在只算真正新处理的（`input + cache_creation`）；要看权威花费就看 `totalCostUSD`，
那是 Claude Code 自己按当时价目算的。

### 64.5 读数

```
本机登录态最小验证   claude -p 回四个字：2148 ms · provider firstParty · claude-opus-5-5[1m]
                     ⚠️ 折算 $0.1768 —— 只为四个字，因为 21831 个 cache creation token。
                     所以 model 默认给 sonnet 而不是 opus，差一个量级。
通道 B 真跑改 .md    14.9 s · 5 轮 · ToolSearch → list_files → read_file → write_file
                     两处都改对（颜色 + 字号）· 快照 s2 · 回答「已把…写入成功（快照 s2）」
                     usage promptTokens 16467 · completionTokens 863
ai_config 路由       channelB: { model: "sonnet", via: "local" }
回归                 selftest 零 error · lifecycletest 全通 · filetest 19/19 · agenttest 4/4
```

**代价要说清**：本机登录态不额外花钱，但它消耗的是**用户自己那份 Claude Code 窗口配额** ——
跟用户手边正在跑的开发会话抢同一份。日常改稿走通道 C（订阅）更合适，B 适合「要一个强模型认真改一次」。

**调试留了个后门**：`UMBRASTUDIO_CHANNEL_B_LOG=<文件>` 把原始事件流落盘。
这条通道是黑盒子（子进程 + 它自带的 agent 循环），出问题时「解析不出来」和「它真没说」长得一样，
没有原始流就只能猜 —— 这一轮的第 3、4 条就是靠它分开的。
（注意别在 ESM 模块里用 `require` 记日志：会直接抛，还被 `catch` 吞掉，等于装了个坏仪器。）

---

## 六十五、M2-13 本地 CLI 通道：把装在这台机器上的 AI CLI 当通道用（2026-09-24）

用户提的方向：项目设置里能选本地的 CLI（Claude / Codex / Cursor…），并且能扫环境里装了哪些。

**结论：走得通，而且比接 API 更划算** —— 这些 CLI 走的是**登录态**而不是 API key，
用户已经在付的订阅能直接用上。而且它们都自带 agent 循环、都能加载 MCP server，
也就是说它们能用上我们那 66 件工具。

这还顺带修正了 §64.1 的一半：**Cursor 的 API 接不进来，Cursor 的 CLI 完全可以。**
「这家接不进来」和「这家的 API 接不进来」是两件事 —— 上一轮我把结论下得太宽了。

### 65.1 五家的能力，差在三处

| CLI | 非交互 | 结构化输出 | MCP 怎么接进去 | 非交互放行 | 报用量 | 实测 |
| --- | --- | --- | --- | --- | --- | --- |
| **Claude Code** | `-p` | `--output-format stream-json` | **`--mcp-config`（纯命令行，不落盘）** | `--allowed-tools mcp__umbrastudio` | ✅ | ✅ 跑通 |
| **Cursor CLI** | `-p` | `--output-format stream-json` | 项目里的 `.cursor/mcp.json` | `--approve-mcps --force` | ❌ | ✅ 跑通 |
| Codex CLI | `exec` | `--json` | `codex mcp add` → `~/.codex/config.toml` | `--ask-for-approval never` | ❌ | ⬜ 本机没装 |
| Gemini CLI | `-p` | ❌ **只有纯文本** | `gemini mcp add` → 全局 settings | `--yolo` | ❌ | ⬜ |
| opencode | `run` | `--format json` | 项目里的 `opencode.json` | — | ❌ | ⬜ |

三处差异直接决定体验，界面上要照实标：

1. **MCP 怎么接进去**。只有 Claude Code 能纯命令行给；别家都得落一个配置文件。
   落在项目里（cursor）还能接受，但**动了用户的项目就要说一声** —— 会话里记一条系统消息，
   而且**写的时候必须合并**：用户的 `.cursor/mcp.json` 里可能已经有别的 server，整份覆盖等于替他删掉。
   解析不了那个文件就宁可这一轮跑不起来，也不覆盖。
2. **输出有多结构化**。有 JSON 事件流才看得见工具行。Gemini 只有纯文本 —— 那一栏在界面上标「看不到工具行」。
3. **报不报用量**。cursor-agent 的 result 事件里没有 usage，所以「这一轮多贵」是 `null`。
   **空就写空，别编一个 0 出来。**

### 65.2 实测里露出来的四个坑

**① headless 模式会等 stdin。** `cursor-agent -p` 第一次实测干等 240 秒 ——
它跟 `claude -p` 一样在等标准输入。`stdio: ["ignore", ...]`（= /dev/null）才对。
命令行手测时要 `< /dev/null`，不然会误判成「这条路不通」。

**② cursor-agent 的工具调用不在 assistant 里。** 它有独立的 `tool_call/started` 与
`tool_call/completed` 事件，MCP 调用的参数在 `tool_call.mcpToolCall.args`。
内置工具（它自己的搜索之类）的 `tool_call` 是**空对象** `{}`，只有 MCP 调用才有 `mcpToolCall` ——
不判这个会往工具行里塞一堆空条目。

**③ MCP 工具名的前缀不一样。** Claude Code 是 `mcp__umbrastudio__read_file`，
cursor-agent 是 `umbrastudio-read_file`。剥前缀的正则要认两种（`/^umbrastudio[-_]+/`）。

**④ 可用模型是按账号来的，写死一定过时。** 我照 `--help` 把 `sonnet-4` 写进 `modelHint`，
真跑被顶回来：

```
Cannot use this model: sonnet-4.
Available models: auto, composer-2.5, cursor-grok-4.5-high, grok-4.7-low, …
```

所以加了 `listCliModels()`：能问就问（cursor-agent 有 `--list-models`，实测列出 31 个），
界面上给 datalist 而不是让人猜。问不出来（claude 没这条命令、opencode 的 `models` 子命令自己会崩）
就老实回空数组 —— **列不出来不是错误，只是没有清单**。
解析时要剥两种脏东西：ANSI 光标控制符，以及它显示名里真的塞了的零宽字符。

### 65.3 结构：`channel_b.ts` 退役，只留一处实现

原来通道 B 的实现硬编码 `spawn("claude", ...)`。现在抽成 `local_cli.ts`：
`CLI_SPECS`（五家的能力描述）+ `detectLocalClis()`（扫）+ `runLocalCli()`（起一轮）+ 各家的 `parse`。
`channel_b.ts` **删掉**，内容全进 `local_cli.ts` —— 留着会分叉，而分叉的那一份迟早说谎。

`verified` 字段是纪律：**只有在这台机器上真跑通过才是 true。** 按文档写出来的适配器一律 false，
界面上标「没实测过」，出错时在 `fix` 里说清「这个适配器没验过，请把 `UMBRASTUDIO_CHANNEL_B_LOG` 的原始输出发来」。
一个装得像验过的适配器比没有更糟。

### 65.4 配置放在哪：全局存，项目设置里改

用户说的是「项目的配置中」。实现上分两层：

- **存在全局**（`STATE_ROOT/.umbrastudio/ai_config.json` 的 `channelB`）——
  CLI 是装在机器上的，登录态也属于机器，不是项目的属性（`11` Q7 的同一条理）。
- **在 S8 项目设置的面板里改** —— 用户看到的就是那个界面，诉求满足。

写入路由 `POST ai_channel_b` **只放行非密钥字段**（`cli` / `model` / `maxBudgetUsd`）。
`baseUrl` 与 `apiKey` 不从这条路进也不从这条路出，只在 `ai_config.json` 里手改。
换 CLI 时把端点清掉 —— 那两个字段只对 Claude Code 有意义，留着会让 `via`
这个读数说谎（显示 endpoint 而那个 CLI 根本不看它）。

**没有加 MCP 工具 `detect_local_clis`**：每加一件工具都会让每一轮 agent 的 prompt 变大，
而这件事只有界面需要。HTTP 路由够了。

### 65.5 读数

```
扫描（detectLocalClis）
  ✓ claude        2.1.281                 MCP:flag            events  已实测
  ✓ cursor-agent  2026.09.23-86fc751      MCP:workspace-file  events  已实测
  · codex         (没装)                  MCP:global-config   events  未实测
  ✓ gemini        0.1.21                  MCP:global-config   text    未实测
  ✓ opencode      1.1.36                  MCP:workspace-file  events  未实测

通道 B 走 claude         15.9 s · 4 轮 · ToolSearch → read_file → write_file
                         usage prompt 8319 / completion 688 · 改对
通道 B 走 cursor-agent   26.8 s · 3 轮 · read_file → write_file · usage null（它不报）
                         两处都改对（颜色 + 圆角）· .cursor/mcp.json 只加了 umbrastudio 这一项
listCliModels            cursor-agent 31 个 · claude / opencode 0 个（没这条命令 / 它自己崩）
回归                     selftest 零 error · lifecycletest 全通 · filetest 19/19
                         agenttest 4/4 · rendertest 15/15
```

**要用户自己做的一步**：`cursor-agent login`（浏览器授权，用他的 Cursor 订阅）。
这一轮的实测是拿 `CURSOR_API_KEY` 跑的 —— 那把 key 能用，但**按量计费和订阅是两笔账**，
想用订阅额度就得 login。Codex 本机没装，装了以后那个适配器还需要一次实测才能把 `verified` 翻成 true。

### 65.6 补测：Codex CLI 与 Cursor 登录态（2026-09-24 晚）

用户 `cursor-agent login` 与 `codex login` 都做完了，两条都补测。

**Codex 原来标的三件事全错了，实测全部翻过来**：

| 原来按文档写的 | 实测 |
| --- | --- |
| `mcpVia: global-config`（要用户自己 `codex mcp add`） | **`flag`** —— `-c` 能临时注入，不碰用户的 `~/.codex/config.toml` |
| `reportsUsage: false` | **true** —— `turn.completed` 带 `input_tokens` / `cached_input_tokens` / `output_tokens` / `reasoning_output_tokens` |
| `verified: false` | **true** |

它的事件流是五家里最干净的：`item.completed` 里 `item.type === "mcp_tool_call"`，
带 `server` / `tool` / `arguments` / `result` / `error`，不用像 cursor 那样从两层嵌套里掏。

**三个参数是实测挣出来的，每个都有反例：**

1. **MCP 注入必须写成分开的 dotted path。**
   `-c mcp_servers.x.command="node" -c 'mcp_servers.x.args=["..."]'` 有效；
   `-c 'mcp_servers.x={command="node",args=[...]}'` 这种 inline table **被静默忽略** ——
   跑起来一切正常，只是那台 server 根本不在，模型回一句「没有可用的 umbrastudio 工具」。
   `codex -c ... mcp list` 能在跑之前验证覆盖进没进去，这是个好探针。
2. **`--approve-for-me`，不是 `-c approval_policy=never`。**
   后者是「从不批准」而**不是**「无需询问」—— MCP 调用直接不可用。实测那一轮它绕去用
   shell 命令翻文件，最后报「当前环境未授权使用 Umbrastudio」。
   也**不需要** `--dangerously-bypass-approvals-and-sandbox`：我们的写入走 MCP server
   那个独立进程，不受 codex 沙箱约束，没必要为了改稿去关掉它的沙箱。
3. **`--ignore-user-config`。** 不加的话它把用户全局的 MCP server 一起拉进来 ——
   实测拉进了 ChatGPT app 那几台，工具表白白大 **3 万 token**（input 163045 → 130098），
   而且**它会用错工具**：那一轮它拿别人的 `js` 工具去改文件。登录态不受影响（auth 走 `CODEX_HOME`）。

**顺带一条界面缺陷**（真开浏览器才看出来的，纪律⑤）：`local_clis` 加进了 `GLOBAL_ROUTES`，
但 `ai_config` / `ai_channel_b` 漏了。首页打开设置用的是 hub 句柄，hub 不属于任何项目 ——
于是 CLI 列表出得来、**当前配置读不到**：模型框空着、选中项退回默认值，看着像「没配过」。
四条一起补进全局路由（这几件事本来就跟打开哪个项目无关）。

**另外**：模型名现在允许留空 = 用这个 CLI 自己的默认。硬要用户填反而容易填错
（`sonnet-4` 被 cursor 顶回来那次就是）。

**读数**

```
通道 B 走 codex（端到端）      33.4 s · read_file → write_file · usage prompt 7662 / completion 381 · 两处都改对
通道 B 走 cursor-agent（登录态，不给 API key）
                              29.1 s · read_file → write_file · usage null · 两处都改对 · 快照 s1→s2
界面（真开浏览器）             五家都列出来 · 三绿「已实测」两黄「没实测过」· 能力标签与实测一致
                              切到 Cursor → placeholder 变它的写法 → 「列一下」→ 31 个模型进 datalist
回归                          selftest 零 error · lifecycletest 全通 · filetest 19/19
                              agenttest 4/4 · rendertest 15/15
```

**还没验的**：Gemini 与 opencode（用户说先不动，够用了）。它们的 `verified` 仍是 false，界面照实标。


---

## 六十六、用户第一轮真用：六条反馈，三条当场修（2026-09-24 晚）

用户拿壳跑起来用，一轮就撞出六条。分两类：**三条是 bug（当场修）**，
**三条是工作台骨架的形制（该设计侧定）**。这一节记前者，后者在 `doc/14` 第六轮交办单。

### 66.1 S8 打不开：「接口读不到: Failed to fetch」

```
projects/Umbra_design_next/S8-项目设置.dc.html
window.__UD_API = {"base":"http://127.0.0.1:55549/__ud/","token":"<钉死的>"}
```

`55549` 是**上一次跑服务时**的端口。`build_index` 把「那一刻的端口 + 令牌」写进了稿件文件，
而端口每次起服务都重随机、令牌也重新生成 —— 隔一次启动再打开，它就拿着一个没人监听的端口在敲门。

**把运行期状态固化到盘上**，这是根本错误。顺带还有第二个后果：**令牌被持久化进稿件**，
那份稿被拷走令牌就跟着走 —— 这跟「令牌只出现在壳页面里」（§20.2）是反的。

修法两处：
- `indexpage.ts`：盘上一律写 `window.__UD_API = null`
- `serve.ts`：响应工具页（`isToolPage` 且 `.dc.html`）时**现注入**当前的 base 与 token，
  且 **base 用相对路径** `/__ud/` —— 跟着页面自己的源走，换端口也不会错

### 66.2 设置弹窗撑出屏幕、滚不动

加了「本地 CLI」那一块之后内容变长，`Sheet` 没有高度上限也没有滚动容器，
底部「完成」按钮直接够不着。改成三段式：`Sheet.Head` / `Sheet.Body`（`flex-1 min-h-0 overflow-y-auto`）/ `Sheet.Foot`，
弹窗本体 `max-h-full`，外层留 `p-4`。iframe 的高度改成固定值 —— 在会滚的容器里用 `vh` 会和外层滚动打架。

### 66.3 「设置里选了 Codex，左下角还是通道 C」

同一条规则我写了两遍。`useChat` 里的规则是「`us.chatChannel` 有值用它，**没值跟后端 `defaultChannel`**」
（mem 为 null 表示"用户没手动选过"，这是有意设计）。而我在设置面板里**另判了一次**：直接读 mem，
拿到默认的 `"a"` —— 于是横条说「在用通道 A」，状态行写着「通道 C」。

抽成 `app/src/chat/channel.ts` 的 `currentChannel()` / `pickChannel()`，两边共用。
**同一个问题在两处各判一次，迟早对不上** —— 这一条和 §64.3 的「手写工具名单」是同一个病。

### 66.4 AI 改完文件，右侧详情不刷新 —— 判据换了

原来是 `writeTick={lastEvent?.type === "write" ? ... : ""}`，只认 `write` 事件。
而 `write` 只有**我们自己进程里的写入口**会发：通道 A/C 同进程 ✅；
**通道 B 的 CLI 起的是独立 MCP server 进程**，它的 `emit` 到不了这条总线。
所以这个 bug 是通道 B 特有的。

用户提的思路比打补丁好：**「如果通过监听文件变化是不是更好一些，不用管是哪个通道，
甚至其他软件修改了这个文件，都可以知道。」** —— 判据从「谁改的」换成「文件变没变」。

而那个监听我们本来就有（`serve.ts` 的 `fs.watch(recursive)`，macOS 上底层是 FSEvents，
200ms 合并后 `emit("fs", dir, { changes: [...] })`，**还带着变化的文件列表**），只是前端没拿它当主信号。

改成 `useProject` 维护 `changedAt: Record<path, number>`，`write` 与 `fs` 都往里记，
暴露 `fileTick(path)`；各视图把它放进 deps。

【实测】判据就用**外部修改**：开着界面，在这个软件之外直接改盘上的文件 ——

```
✓ 右侧显示了内容：「主色是蓝色。」
· 已在软件外部把文件里的「蓝」改成「绿」
✓ 界面自己跟着变了：「主色是绿色。」—— 没刷新页面、没点任何东西
```

外部改都能刷，那不管哪条通道改的都能刷。

### 66.5 AI 回复把 Markdown 源码显示出来

会话栏用的是 `whitespace-pre-wrap` 纯文本，而模型本来就在用 `**粗体**`、列表、代码块说话。
markdown-it 我们 M8-6 就打进构建产物了（`MarkdownView` 在用），会话这条路没接上。

**没有在 ChatRail 里再 `new MarkdownIt`** —— 抽了 `app/src/ui/markdown.ts`，
全站一个实例、一套 `.md-body` 样式。两个实例迟早配置不一致（一个开 linkify 一个没开，
同一段文字在两处长得不一样）。`html: false` 是安全线：AI 回复和用户的 `.md` 都算外部输入。

### 66.6 状态行看不出「谁在干活」

左下角原来是「通道 B · sonnet」—— 看不出动手的是 Codex 还是 Cursor。
补上 CLI 的显示名，**由服务端给**（`CLI_SPECS` 已经有了，前端再抄一份 id→名字 的表迟早对不上）。
model 允许为空（空 = 用那个 CLI 自己的默认），空就不显示，不写 `undefined`。

用户的原话值得记下来：**「左下角只显示了选择的通道（这里应该是模式）」** ——
他脱口而出的是「模式」，说明「通道 A/B/C」这个词没传达任何东西。这个命名进第六轮交办单让设计侧定。

### 66.7 读数

```
界面（真开浏览器）  Markdown 渲染正常（粗体 / 标题 / 列表都有层级，不再满屏 **）
                    左下角「通道 B · Claude Code」
                    设置弹窗封顶可滚、「完成」钉底部、标签不再被裁
                    项目设置（S8）出真数据：umbra · 57 份稿
自动化              外部改文件 → 界面自动跟上（Playwright，不跑 AI 不花额度）
回归                selftest 零 error · lifecycletest 全通 · filetest 19/19 · rendertest 15/15
```

**留了个方法没落地**：那段外部改文件的 Playwright 验证很值钱（不花额度、判据硬），
但前端目前没有自动化测试的位置 —— 建这个属于重构范围，先记在这儿。

---

## 六十七、Inkwell 那边回报的两个坑 —— 我们也中了（2026-09-24 晚）

把 `doc/19`（接入本地 CLI 的指南）给 sam 的另一个项目 Inkwell 之后，
那边的 agent 照着做，**回报了两条我们文档里没有、而我们自己代码里也存在的问题**。
两条都复现了，两条都修了。

### 67.1 要清的环境变量是**两族**，我们只清了一族

原来只过滤 `ANTHROPIC_*`。Inkwell 那边指出：服务本身被 Claude Code 起着时，
父进程里还有一族 `CLAUDE_CODE_*`。

【实测】我们这边数了一下，**8 个**，其中三个要命：

```
CLAUDE_CODE_SESSION_ID          父会话的身份
CLAUDE_CODE_MESSAGING_SOCKET    父会话的消息通道
CLAUDE_CODE_MESSAGING_TOKEN     那条通道的令牌
```

子进程继承了它们，**就不再是干净的一轮，而是带着别人的会话身份在跑**。
改成 `/^(ANTHROPIC_|CLAUDE_CODE_)/` 一起清。

### 67.2 `--system-prompt` 让 prompt 缓存整个失效 —— 我们每轮都在多花钱

Inkwell 那边实测 $0.046 → $0.109（翻倍）。我们复现了，读数是：

| | cache_read | cache_creation | 金额 |
| --- | --- | --- | --- |
| 不带 `--system-prompt` | **18639** | 28109 | $0.1162 |
| 带 `--system-prompt` | **0** | 35692 | $0.1428 |

**缓存读取直接打到零。** 这个参数替换掉默认系统提示，前缀一变缓存就全不命中。

改成并进 prompt。**约束力没有退化**，两条证据：

1. `cursor-agent` 与 `codex` **本来就没有这个参数**，我们一直是并进 prompt 的，
   它们照样严格遵守了「`project` 传这个绝对路径」这类硬约束 —— 这是现成的对照组
2. 改完重跑：14.1 s · 4 轮 · `ToolSearch → read_file → write_file` · 两处修改都正确

顺带三家统一成一种做法，代码里少一处分叉。

### 67.3 值得记下来的一件事

**这两条都不是我们自己测出来的。** 我们把踩过的坑写成文档交出去，
别人照着做，反过来发现了我们没看见的两处 —— 其中一条我们**每一轮都在多花钱**却浑然不觉。

写文档的收益不只是"别人少踩坑"，还有"别人替你把你看不见的地方照亮"。
`doc/19` 已补上这两条（§5.2 与新增的 §5.11），并注明了来源。

---

## 六十八、设计侧第六轮收稿；底稿判据从「看 baseline」换成「看接线键」（2026-09-24 晚）

### 68.1 交回了什么

S11 / S12 / S9 三份，其余一份没动（它守住了「只改交办的」）。

| 稿 | 行数 | renderVals 键 | 渲染 |
| --- | --- | --- | --- |
| S11-工作台布局壳 | 474 → 731 | 51 → 74 | 判活 ✓ · 元素 352 · error 0 |
| S12-目录视图 | 363 → 475 | 20 → 27 | 判活 ✓ · 元素 333 · error 0 |
| S9-会话面板 | 418 → 609 | 33 → 52 | 判活 ✓ · 元素 182 · error 0 |

四条委托全部答到，其中两条的**理由**比结论更值得记：

- **6.1 收起态不留 40px 图标轨**：「从属面板有四五个面板，图标轨上可以排一列图标；
  目录只有一样东西，留一条 40 px 的轨，上面也只有一颗钮，等于白占一列宽度。」
- **6.4 叫「引擎」不叫「模式」**：「Claude Code 和 Codex 自己就有模式（plan / ask / auto 之类），
  以后大概率要在界面上露出来，两个「模式」会撞车。」—— 这条我们没想到。

它还主动改了一条规则：**R5 的「窗口 < 1100 px」换成「详情区实际宽度 < 480 px」**。
这个改法是对的 —— 会话栏拖宽也会挤详情，而窗口宽度没变。

### 68.2 三份全被底稿检查拦下，而三条都是假警报

```
S11  底稿不明 —— 没有 baseline 标记
S12  底稿不明 —— 没有 baseline 标记
S9   底稿过时 —— 基于 20260923-0255（第三轮）
```

查下来根源在**我们**，不在设计侧：

- **S11 / S12 从来没有过 baseline**。核过第三轮的包，里面根本没这两份 ——
  它们是设计侧自己建的新屏，从没经过我们的 `outgoing` 打包。
  只认 baseline 的话，**每个新屏第一次交回都会被拦**。
- **S9 的戳旧，但正文是新的**。独立验证：第三轮之后我们往 S9 新增的 47 行，
  交回稿里还在 44 条（94%）；我们删掉的 5 行，复活 0 条。
  它确实在第六轮底稿上改，只是头部那行没跟着更新。

### 68.3 判据换了：从「看 baseline」到「看接线键」

想清楚一件事：**这道检查的真正目的不是「知道它基于哪一版」，而是「确保我们的改动没被丢掉」。**
§三十二 那次事故的症状就是 S1 少 27 个键、S2 少 54 个键 ——
形制看着好好的，我们后加的接线全没了，而设计侧自己不可能知道缺了什么。

`renderVals` 的键就是接线本身。**现版的键一个都没少 = 我们的东西都还在。**
这比一行 baseline 注释更直接：注释可能忘了更新（S9 这次就是），键却骗不了人。

新规则：

| baseline | 接线键 | 判定 |
| --- | --- | --- |
| 对得上 | — | 绿：底稿正确 |
| 对不上（没有 / 戳旧） | **零丢失** | 黄：**按内容认可**，并把 baseline 的实际情况一起打出来 |
| 对不上 | 有丢失 | 红：底稿不对，列出少了哪些键，拦住 |

**放宽一道检查之前，先证明它还拦得住**（纪律④）。两次实测：

1. 第一次造的坏稿**没拦住** —— 我只删了 `renderVals()` 里的定义、留着模板里的 `{{ }}` 引用，
   而 `auditRenderVals` 数的是两边的并集，所以键数没变。**这个坏稿造错了**，不是判据失效。
   （顺带暴露一个真盲区：删定义留引用，合法性检查也只报 warning 不报 error。记在这儿，不是今天的事。）
2. 换成**真实事故形状**：把第三轮的 S9 当交回稿放进去 —— 拦住了，而且精确：

```
底稿不对 —— 少了 4 个键，我们的接线被丢了
少的键：clearSelections · hasSelections · manySelections · selections
```

那 4 个正是第五轮我们加的「五种药丸」接线。

### 68.4 读数

```
incoming   三份「按内容认可」· error 0 · 零键丢失 → --apply 并入
selftest   ✓ 基准全过 · 界面稿零 error · 语料零误报
rendertest ✓ 15 条全过
渲染       三份判活 ✓ · 元素 352 / 333 / 182 · 控制台 error 0
```

一条 warning 留给下一轮：**`W_DEAD_KEY goBack`** —— S9 的 `renderVals()` 返回了 `goBack`，
模板里零命中。不影响运行，但是个该清掉的死键。

`__resources` 在 S11 / S12 里是 0（设计侧的 writer 重写 `<head>` 时丢的）。
**不是问题**：那一块由 `prepareForDisk` 在部署到项目时注入，ui/ 正本本来就不必带。

### 68.5 并入 ≠ 功能可用

这三份是**形制依据**，不是运行时。应用现在还是老样子 —— 目录树、常驻目录列、会话历史
一个都还没接。接线是下一批的工作，清单在 `doc/12` M8-11 起。

---

## 六十九、第六轮形制接线：常驻目录列 · 会话历史 ·「引擎」改名（2026-09-24 晚）

设计侧第六轮的三件形制落到代码。分三条提交：M8-12 后端字段 → M8-11 目录列 → M8-11 下 + M8-13。

### 69.1 后端（M8-12）

- **`title`**：会话列表的 id 是 `chat-<时间戳>-<随机>`，直接显示很丑。用户起的名字优先；
  没起过就从首条用户消息截 40 字**现算**。**不写回盘** —— 写回去就分不清「用户起的」和「我们猜的」，
  以后想换生成规则也改不动老会话。另给 `titled` 让界面把猜的显示得淡一点。
- **`tool`**：建会话时记下具体哪个本机 CLI。只记 channel 的话界面只能写「本机工具」。
- **空会话不进历史**：`chat_list` 滤掉 `msgCount === 0`。**只滤显示不删文件** —— 删文件得用户说了算。
- **`chat_rename` / `chat_delete`**：重命名**不动 `updatedAt`**。那一栏是「最后说话的时间」，
  历史列表按它排序；改个名字就把会话顶到最前，会打乱用户对顺序的预期。
- **分页**：`listFiles` 默认 200 条，带 `total` / `truncated`。**截断放在排序之后** ——
  先截再排的话，给出去的就不是「最该先看的 200 条」，而是 `readdir` 碰巧先读到的那些。

「按需拉子层」不用做：`listFiles(p, dirRel)` 本来就支持，`selection` 存的也已经是相对路径。

### 69.2 目录列（M8-11 上）

主区从「目录和详情轮流占位」改成并排。`FileTree` 按设计侧那套尺寸：
缩进 16px（= 三角宽度，所以子项三角正落在父项图标下方）、行高 28px、不画层级线、
三角转 90°、整行可点、当前文件祖先自动展开、健康点只在 warn/error 时挂。

**R5 的判据换了**：`window.innerWidth < 1100` → **详情区实际宽度 < 480**，用 `ResizeObserver`
量详情区自己。会话栏拖宽、目录列展开都会挤详情，而窗口宽度一点没变 —— 按窗口判会漏。

### 69.3 会话历史与「引擎」（M8-11 下 / M8-13）

入口是顶栏标题加 ▾，点它**整栏**换成列表（不做下拉浮层：380px 的栏里再叠一层，能看的只剩一条缝）。
按日期分组、超过 8 条才出搜索框、删除不弹确认而是行塌成「已删除 · 撤销」、离开列表才真删。

「引擎」的显示名**由服务端给**（`engineView` 从 baseUrl 认出 DeepSeek / 智谱 / 火山方舟），
前端不抄第二份 id→名字 的表。状态行统一成「引擎名 · 模型 · 计费方式」。

### 69.4 三条只有真开浏览器才看得见的缺陷

**这一节是重点。** 三条都过了自动测试，全靠看截图和查假阳性才暴露：

1. **⌘B 往返后树空了。** 收起时 `FileTree` 整个卸载，`children` 那份内存缓存跟着没；
   `expanded` 存在 layout 里活了下来，于是再展开看到的是「展开的三角 + 一个子项都没有」。
   修法：挂载时把 `expanded` 里的层一起拉回来。**判据也补了**（往返后行数不得减少）。

2. **顶栏标题被挤成竖排。** 把 A/B/C 换成引擎名之后，「DeepSeek / Claude Code / 火山方舟」
   三个平铺远超 380px 的会话栏，左边的标题被压成一列字。
   设计侧其实预见到了 —— 它回执里写着「按计费方式分组的选择器这一轮没画」。
   改成下拉（平时只显示当前引擎，点开按谁在付钱分三组）。**这是从简的临时实现，等它定稿再调。**
   判据补了一条量标题宽度的。

3. **测试自己的假阳性。** 引擎按钮我先按文字找（`hasText: /DeepSeek|Claude Code/`），
   **第一个命中的其实是标题按钮**（它第二行的状态行里也有引擎名）——
   所以实际点进了历史模式，而「分组」那条判据被会话行里的「本机工具」四个字蒙对了。
   改成 `data-ud="engine"` 精确定位，分组判据也改成匹配完整组名。
   **一条会蒙对的判据比没有判据更危险**，它会让你以为验过了。

### 69.5 读数

```
uitest      17/17（常驻目录列 8 条 · 会话历史与引擎 8 条 · 控制台 1 条）
selftest    零 error · filetest 19/19 · agenttest 4/4 · rendertest 15/15
```

新建 `app/uitest.mjs` —— 前端界面回归的位置。静态回归看的是**稿**，看不到 React 应用本身。
控制台噪声白名单里排掉了解析期的模板洞（`d="{{ icon }}"`），那是语料的存量写法
（`doc/06` §2.8 记着该怎么改），不排的话每次都红、久了就没人看了。

---

## 七十、设计侧第七轮：按钮按「点了它变的是什么」分四层（2026-09-24 夜）

### 70.1 起因是用户的一句话

> 「项目详情里的功能按钮太乱，需要根据分类显示在对应的位置上。」

只给了症状。交给设计侧重画 S11，它交回来的**判据比布局图有用**：

> 判断一颗钮该放哪，只问一句：**点了它，变的是什么？**

按这个分五类 —— 项目 / 窗口布局 / 导航 / 会话 / 当前文件 ——
每类只在一个地方出现；每条横带也只装一层：
**顶栏 = 项目 + 布局，页签条 = 开着哪些文件，文件工具栏 = 这份文件。**

读数：S11 从 55252 → 87542 字节，`renderVals` 键 74 → 120，16 个演示态；
渲染判活 ✓ · 元素 455 · selftest 零 error · rendertest 15/15。

值得记的几条具体裁决：

| 改动 | 它给的理由 |
| --- | --- |
| 项目路径从顶栏拿掉 | 「占 280 px，却只是信息 —— 没人点它」 |
| 两个「目录」拆开 | 一个是布局的开关（⌘B），一个是导航的「铺到详情区 ⤢」，点了变的东西不一样 |
| 点选 + 评论合成互斥的「指针」组 | 它们是同一件事的两个模式，而且只在编辑态有意义 |
| 宽度 + 缩放合成一颗读数钮 | 平时只显示读数，点开才有档位 |
| 体检钮收进 `⋯` | 「结果本来就常驻在诊断角标、状态行、树里的点上，常驻一颗钮只为手动重跑，那是低频」 |

### 70.2 顺带改了 `incoming` 的丢键提示：工具不替人判断

第七轮报「少了 3 个键」，查完是**误报**：`showTree` / `showTreeBtn` 被 `treeBtnOn` 等接走了，
`toBar` 那颗钮真删了，但功能由顶栏布局组承接。

原本想让工具自动分辨「改名」和「真丢了」。**实测判不准** ——
`toBar` 和任何新键的词根都对不上，可功能一点没丢。

所以改成：**工具只把证据摆全，判断权留给人。**
每个丢键旁边列出名字相近的新键、没有就明说没有，并给出新增键总数；
看过之后用 `--accept-renames` 放行。

这跟 §68.3 是同一个教训的下一层：那次是把判据从「看注释」换成「看键」，
这次是承认**有些判断工具做不了，摆证据比猜结论有用**。

---

## 七十一、M8-14 文件格式做成注册表：加一种格式 = 新增一个文件（2026-09-25）

### 71.1 用户提的问题

> 「关于文件格式的预览页面，设计模式需要类似工厂模式那样，有个基础的工厂，
> 其他各种格式都是在这个基础上补充不同的编辑工具……每次迭代一个支持对一个新格式的编辑，
> 不影响其他格式的编辑方式。反推到代码的规范就需要支持这种，不要把大量代码堆到一起，做好解耦。」

### 71.2 病灶：同一个知识散在七处

动手前先数了一遍「一种文件格式」的知识写在哪：

| # | 位置 | 写的是什么 |
| --- | --- | --- |
| 1 | `app/src/layout/layout.ts` `kindOf` | 扩展名 → 类型 |
| 2 | `server/src/files.ts` `kindOf` | 扩展名 → 类型（**另一份**） |
| 3 | `layout.ts` `panelsFor` | 类型 → 有哪些从属面板 |
| 4 | `Workbench.tsx` 的三元链 | 类型 → 用哪个视图 |
| 5 | `FileTree.tsx` 的 `ICON` 表 | 类型 → 图标 |
| 6 | `DirView.tsx` 的 `KIND_ICON` / `KIND_LABEL` | 类型 → 图标 + 名字（**又一份**） |
| 7 | `layout.ts` 的 `FileKind` 与 `types.ts` 的 `FileKindS` | 同一个联合类型，**两个名字** |

其中 1 和 2 最危险：前后端各有一份扩展名映射，**没有任何机制保证它们一致** ——
今天碰巧一致纯属运气。

### 71.3 分两层：底层类型认定前后端共用，上层界面归前端

- **`server/src/shared/kinds.ts`**：一个路径是什么类型。纯 TypeScript，不 import 任何东西，
  不碰 Node 也不碰 DOM —— 因为它被 `app/` 与 `server/` 两个 TS 工程同时编译。
  `app/tsconfig.json` 加 `@shared/*` 路径映射，`vite.config.ts` 加同名 alias 与 `fs.allow`。
- **`app/src/kinds/`**：这种类型怎么看。一个模块声明五样 ——
  `View`（详情区）、`Toolbar`（文件工具栏）、`Panels`（右侧列）、`menu`（`⋯`）、`Status`（状态行）。

**分界线用的是第七轮那条判据**：点了它变的是项目 / 布局 / 导航 / 会话的，归工作台；
变的是这份文件的，归格式模块。所以顶栏和页签条永远不进模块，文件工具栏永远不进工作台。

工作台和模块之间只有一份契约 `ViewContext`（`kinds/context.ts`）——
它的字段不是拍脑袋定的，是把现有五个视图组件的 props 求了个并集。

### 71.4 `Provider` 是这套设计里最不显然的一块

`picked`（点中的稿节点）、`outline`（Markdown 大纲）、目录的勾选，
这三样都**跨了两个渲染位置**：一处产出、另一处消费，而那两处在 DOM 上是兄弟。

- 放工作台 → 工作台又认识具体格式了（大纲只有 Markdown 用，却让所有格式跟着重渲染）
- 放 `View` 内部 → `Panels` 拿不到

所以模块可以声明一个 `Provider`，工作台把 `View` / `Toolbar` / `Panels` / `Status` 都包进去，
状态住在模块里、工作台只是个容器。`outline` 由此从工作台搬进了 `kinds/md.tsx`。

`picked` 是例外，留在工作台 —— 它除了喂属性面板还要变成一颗会话药丸，而药丸是工作台的事。

### 71.5 加 `.json` 验证：判据是「动了几处」

光说「解耦了」不算。**真加一种格式，数动了几个文件**：

1. `shared/kinds.ts`：加一条 `KindDef` + 联合类型里加一个名字（**前后端同时生效**）
2. `app/src/kinds/json.tsx`：新文件（结构树 / 源码 / 点一行把 JSON 路径带给 AI / 解析失败定位）
3. `app/src/kinds/index.ts`：数组里加一行

`Workbench.tsx` 里唯一提到 `json` 的地方是一句注释。判据成立。

⚠️ 诚实一句：**`Workbench.tsx` 并没有变短**（252 → 270 行）。
少了 5 个 state 和那条三元链，多了 `ViewContext` 的组装和注释。
收益在职责边界，不在行数 —— 说它「精简了」是不准确的。

顺带把后端的 `FileKind` 换成 shared 的那一份时，编译器**当场报错**：
`files.ts` 自己写的联合类型缺了 `json`。这就是统一的用处 ——
以前这种不一致只能靠运气发现。

### 71.6 这一轮抓到的四条真缺陷

**① `ResizeObserver` 绑在已卸载的旧节点上**（我自己引入的）

格式模块的 `Provider` 按 `key={kind}` 挂载，换格式时详情区那个 div 会重建。
而量宽度的 effect 依赖写的是 `[]` —— 观察器还绑在**旧节点**上，从此再也量不到真宽度。
更糟的是节点卸载那一瞬会报一次宽度 **0**，而 `0 < 480` 就是 `narrow`，
于是从属面板弹出它的全屏遮罩，**整个界面点不动了**。

这条是 `uitest` 抓到的，它报「有个 `fixed inset-0` 的遮罩拦住了点击」。
人眼看截图只会觉得「暗了一点」。修法两处都要：依赖里加 `kind`、宽度 0 一律忽略。

**② `.json` 的解析错误定位指错了行**

只认 `position N` 不够。V8 实测报的是
`Unexpected token ']', ..." [1, 2, 3,] } " is not valid JSON` ——
**整条消息里一个数字都没有**，于是回退到「第 1 行第 1 列」，而真错在第 3 行。
**报错位置指错地方比不报更坏**，人会照着去看那一行。

改成三条路依次试：`line L column C` → `position N` →
消息里带的那段上下文原文（它被压掉了换行，`]\n}` 变成 `] }`，所以两边都把空白折平再找）。
复验：第 3 行第 11 列，对上了。

**③ Markdown 模块漏写了 `Status`**，状态行只剩「文件名 ·」后面空着。
这条是新加的 uitest 判据抓到的。真正该修的不是补上那一行，而是
**给 `Status` 一个兜底**（缺省用类型名）—— 一条「省略等于空白」的接口，早晚会有人省略。

**④ 图片视图的引擎名还写着「通道 B」** —— 第六轮改名漏的一处。
同一句话在 `ChatRail` 和 `Workbench` 各写了一遍，抽成 `chat/channel.ts` 的 `engineLabel()`。

### 71.7 读数

```
后端编译 干净 · 前端类型检查 干净
selftest      基准全过 · 界面稿零 error · 语料零误报
filetest      泛型文件层 全通过
lifecycletest 生命周期回归全通过
rendertest    15 条渲染基准全过
uitest        23/23（新增 6 条：设计稿 / Markdown / JSON 各自的视图、面板、状态行）
```

`uitest` 新增那 6 条守的不是像素，是**注册表的三个环节各自还通**：
`View`、`Panels`、`Status`。哪一环断了，症状都是「这种文件打开后少了点东西」，
而截图上很难一眼看出少了什么。

### 71.8 留给下一轮（M8-15）

`Toolbar` 与 `menu` 这一轮**只留了接口，没有实现** ——
各视图的开关（Markdown 的渲染/源码、目录的范围/排布、图片的缩放、JSON 的结构/源码）
现在还在各自视图内部。按第七轮形制上移到那条 34 px 的文件工具栏是下一条。
这一轮刻意不动形制，为的是「回归全过」这个读数干净。

---

## 七十二、M8-15a 按第七轮重排按钮：顶栏 · 页签条 · 目录列头（2026-09-25）

接着 §七十一 的注册表做形制。**这一批解决的是用户最初那句抱怨** ——
「项目详情里的功能按钮太乱，需要根据分类显示在对应的位置上」。

### 72.1 三条横带各归其位

| 带 | 现在装什么 | 从哪儿搬来的 |
| --- | --- | --- |
| **顶栏 38px** | 应用 / 项目名 ▾ · 窗口布局组 | 项目级五项从原来的 `⋯` 收进项目名菜单；**路径进菜单**（它在顶栏占 280 px 却只是信息） |
| **页签条 34px** | 只有页签 | 拿掉了三样：目录开关（→ 顶栏布局组）、「▤ 目录」（→ 目录列头「铺到详情区」）、「N 份稿 ▾」（→ 目录列头「转到文件」⌘P） |
| **文件工具栏 34px** | 当前这份文件的开关 + `⋯` | 由格式模块的 `Toolbar` 填；不声明就**不出这条带** |

两个都叫「目录」的钮，一个变的是窗口布局、一个变的是看什么，
**按「点了它变的是什么」一分就说得清了** —— 这是第七轮那条判据最直接的用处。

### 72.2 截图看出来的一条：目录列该通栏

DOM 判据 33 条全过，**但截图上一眼就不对**：文件工具栏横跨了目录列，
页签条也压在目录列上方。

想清楚为什么：M8-11 时目录开关在**页签条最左边**，那时候页签条通栏是对的 ——
那颗钮管的就是它下面那一列。第七轮把钮挪进顶栏之后，
「页签条横跨目录列」就没有任何理由了：**页签条讲的是「开着哪些文件」，和目录列无关。**

改成目录列提到主体层、通栏（顶栏下直达底部），页签条和工具栏只盖详情列。
顺带把列头对齐成 34 px 并补一条下边线 —— 差 2 px 或少一条线，那条横线就是断的。

⚠️ 这条**自动判据抓不到**（DOM 结构合法，只是嵌套层不对）。
和 §71.6 的遮罩那条正好相反：那条是截图看不出、判据抓到；这条是判据全过、截图一眼看出。
**两种都要做。**

### 72.3 `Toolbar` 接口先在一种格式上验证

`json` 的状态最少，所以拿它先走通：状态提到 `Provider`，
`View` 只渲染、`Toolbar` 给段组和读数，`⋯` 的公共尾巴（复制路径 / 在访达中显示 / 关闭页签）
由 `FileMore` 统一补，不用每个模块重写。

共用零件在 `kinds/toolbar.tsx`：`Seg`（段组）、`SizeBtn`（宽度+缩放合成的读数钮）、
`FileMore`、`ToolbarBar`。**形制共用、内容各出** ——
以前四个视图各画一条工具栏，行高 34/40、按钮 22/24 各不相同，并排时一眼看出不是一套。

顺带加了 `ui/Glyph.tsx`，和稿里的 `IconGlyph` 一一对应。
有了它就能**把稿里的 `d` 原样抄过来**，不用在字符图标里找近似的 —— 形制对齐的成本降了一大截。

### 72.4 又一条：别拿界面文案当判据

`uitest` 的启动等待条件是 `/份稿|\d+ 项/` —— 「N 份稿」这颗钮被挪走改名之后，
**整个回归卡在启动上**，一条判据都没跑。

换成 `[role="treeitem"]`：形制变了它还在。
**判据要落在结构上，不要落在文案上** —— 文案是设计侧随时会改的东西。

### 72.5 读数

```
selftest      基准全过 · 界面稿零 error · 语料零误报
filetest      泛型文件层 全通过
rendertest    15 条渲染基准全过
uitest        33/33（新增 10 条：按钮分层 8 条 + JSON 工具栏 2 条）
```

新增的 8 条里有两条是**「不该有的东西不在」**：页签条上没有「N 份稿」和「▤ 目录」、
顶栏上没有项目路径。分层做对了的标志恰恰是少了几颗钮，
而「少了」在截图上根本看不出来。

### 72.6 留给 M8-15b

`.dc.html` / `.md` / 目录 / 图片**四种格式的工具栏还在各自视图内部**。
要上移得把它们的状态逐个提到模块的 `Provider`，其中画布最重 ——
它的 `preset` / `zoom` / `draftTheme` / `selectOn` 是通过 postMessage 跨 iframe 拿的，
工具栏移出去就得把那座桥也提上来。

还欠设计侧两小项（第七轮交回时就说了要补）：
`✽`（稿的浅 / 深色切换）没安家、文件 `⋯` 里缺「对比上一版（S6）」和「重新加载预览」。

---

## 七十三、用户第二轮真用：13 条反馈，4 条我们处理、9 条交设计侧（2026-09-25）

第七轮的分层刚落地，用户跑起来又提了 13 条（原文见 `doc/14` §八）。
和第一轮那六条一样，**这一批的价值不在条目本身，在他用的词**：

他管会话栏叫「聊天模块」、管右侧叫「预览」、把整个底部状态行算作「聊天模块最底部」。
**他脑子里的分区和我们画的不是一套。** 这比任何一条具体意见都重要 ——
所以第八轮交办单把他的原话整段贴过去，没有转述。

### 73.1 我们直接处理的四条

| 条 | 是什么 | 怎么处理 |
| --- | --- | --- |
| 1 / 2 | 顶栏「Umbra Studio」+ 窗口标题重复 | 窗口标题只写项目名；顶栏只留图标 |
| 3 前半 | 项目菜单里 double name | 菜单头部那个项目名去掉，只留完整路径 |
| **7** | **引擎不跟着会话走** | **真缺陷，见 73.2** |
| 8 / 9 / 13 前半 | 模型名重复三次、底部状态行全是调试信息 | 会话栏底部只留花费；**底部状态行整条去掉** |

### 73.2 第 7 条：引擎是会话的属性，不是全局偏好

用户撞到的：会话在火山方舟上 → 选成 Claude → 新建一条 → 再切回来，**又变回火山方舟**。

根因：`pickChannel` 只写了两处 —— 界面 state 和 `localStorage` ——
**没写进会话文件**，而 `chat_get` 读的是文件。
新建一条再切回去，前端就从文件里把旧值读回来了。

修法：加 `chat_channel` 路由 + `setChatChannel()`，选引擎时三处一起写。
和 `renameChat` 同一条口径：**不动 `updatedAt`**，换个引擎不该把会话顶到列表最前面。

**判据用「刷新页面」代替「切走再切回」**：刷新之后前端从零开始，
引擎只能是从会话文件里读回来的 —— 比在界面里绕一圈更直接，也不需要第二条会话。

按纪律④做了反向验证：把修复摘掉重跑，那条判据**当场失败**（刷新后变回旧值）。
这一步必须做 —— 刷新后前端也会从 `localStorage` 读一次，
判据完全可能因为那次读而「蒙对」。

### 73.3 一条自己给自己挖的坑：兜底逻辑跟着渲染位置一起删了

底部状态行整条去掉时，`Status` 的**兜底**（不声明就用类型名）也跟着没了 ——
它写在那条 footer 里。`Status` 挪进文件工具栏之后右端就空着。

而 `registry.ts` 里我自己写过一句警告：
**「一条『省略等于空白』的接口，早晚会有人省略。」**
搬位置的时候第一个省略的人是我。

### 73.4 三条横带同高，判据必须落在结构标记上

目录列头、页签条、文件工具栏都是 34 px，`uitest` 里用 `div.h-[34px]` 定位，
**三条判据全串了** —— 「页签条上没有 N 份稿」量到的其实是目录列头。

各加一个 `data-ud`（`tabbar` / `file-toolbar` / `tree-head`）之后才定得住。
这和 §72.4 是同一条教训的第二次：**判据落在结构上，别落在外观或文案上。**

### 73.5 第 11 条：功能是好的，图标读错了

「铺到详情区」那颗钮用户说「点击后没有任何反应」。实测**功能完全正常**
（点了确实把目录铺到详情区，状态行从文件名变成「项目根 · 目录」）。

真正的问题是他把 `⤢` 读成了「放大 / 展开」，而且他期望那儿有一颗**收起目录列**的钮 ——
这和第 4 条是同一个诉求：**模块的显隐开关该在模块自己身上**。

⚠️ 而设计侧第七轮恰恰把目录开关**挪进了顶栏**。
**这是用户和设计侧的分歧，不是缺陷**，所以原样交回去让它重新裁决，附上用户原话。

### 73.6 交出去的九条

第八轮交办单（`doc/14` §八，已放进它 `uploads/32-…`）里最要紧的是第 4 条：
用户要的布局模型是**「左 / 底 / 右三块的显隐」**（VS Code 那种），
而不是我们现在的「会话栏摆哪」。这会动布局引擎 R1–R5。

其余：项目菜单整合与「新建稿件」归属、`NewDraftSheet` 的形制（**这一屏设计侧从没画过**）、
会话栏顶部这一行、目录右键菜单、页签重画、目录列头图标语义、
新增底部调试模块、第七轮欠的两小项。

### 73.7 读数

```
selftest      基准全过 · 界面稿零 error · 语料零误报
filetest      泛型文件层 全通过
lifecycletest 生命周期回归全通过
rendertest    15 条渲染基准全过
uitest        34/34（新增 2 条：引擎跟着会话走，含反向验证）
```

---

## 七十四、M8-15b 四种格式的工具栏上移：把「搬工具栏」做成「搬架构」（2026-09-25）

M8-15a 只留了 `Toolbar` 接口、拿 `json` 试了一种。这一批把 `.dc.html` / `.md` /
目录 / 图片四种都搬上去，第七轮那条 34 px 横带才算真的成立。

### 74.1 搬工具栏为什么会变成改架构

第七轮的形制是「**一条统一的横带，每种格式往里填自己的东西**」。
而工具栏和视图**是两个渲染位置** —— 于是每一档开关都面临同一个问题：
状态住在视图组件的 `useState` 里，工具栏够不着。

四种格式的难度差得很远：

| 格式 | 要提上来的 | 难度 |
| --- | --- | --- |
| 目录 | `onlyDrafts` / `manual`（排布记忆） | 挪两个 `useState` |
| 图片 | `zoom` / `picking` | 挪两个 `useState` |
| Markdown | 视图档、选区、快照、落盘 | 状态多且互相缠，整份拆成 `parse / doc / View` 三层 |
| **设计稿** | `preset` / `zoom` / `draftTheme` / `selectOn` | **这些根本不在 React 里** |

最后一行是这一批真正的活：画布的开关**全住在 iframe 里的 S2 嵌入壳里**，
读它们要收 `shell-state` 消息，改它们要发 `cmd` 消息。
工具栏搬出画布组件的那一刻，**那座 postMessage 桥就得跟着搬到两边都够得着的地方**
（`kinds/dc/bridge.tsx`）。

一句话：**别的三种是挪 state，设计稿是挪架构。**

### 74.2 一种格式一个目录

```
kinds/
  dc/      bridge.tsx（桥与状态） · View.tsx（画布 + 源码 + 演示） · index.tsx（模块声明）
  md/      parse.ts（纯函数） · doc.tsx（状态） · View.tsx（画面） · index.tsx
  dir/     View.tsx · index.tsx
  image/   View.tsx · index.tsx
  json.tsx · fallback.tsx           ← 简单的一个文件就够
```

`workbench/` 于是只剩**真正通用**的六样：工作台壳、目录列、面板壳、属性面板、
通用文件卡、壳适配。以前 `MarkdownView.tsx` / `ImageView.tsx` / `DirView.tsx` / `Canvas.tsx`
都堆在那儿，看目录名根本分不出哪些是「某种格式的」、哪些是「所有格式共用的」。

顺带把 `fmtSize` 从 `DirView.tsx` 搬进 `api/types.ts` ——
文件卡和图片视图都 import 它，等于**让「目录视图」成了另外两种格式的公共依赖**。

### 74.3 判据：「搬干净了」不等于「工具栏里有」

新加的判据分两半，**第二半才是要害**：

```
✓ Markdown：开关在统一工具栏上          工具栏里 1 处
✓ Markdown：视图里没有第二条工具栏      整页 1 处 · 工具栏里 1 处
```

只测第一半的话，**搬一半照样通过** —— 症状是同一组开关出现两次
（一条在工具栏、一条还留在视图里），而那正是这种重构最容易留下的残骸。

### 74.4 画布判活：有个 iframe 不算数

原来的判据是 `pg.locator("iframe").count() > 0`。**稿加载失败时那个 iframe 照样在**，
所以它量到的只是「DOM 里有个框」。

换成穿两层：外层是 S2 嵌入壳，内层才是稿本身，数内层的元素数。
实测读数：

```
图片消息与识图状态.dc.html   稿里 675 个元素 · 文字读得出来
自定义副本 2.dc.html          稿里 23 个元素 · 没有文字
```

第二份在截图上是**一片空白**，一度以为是搬坏了 —— 穿进去数了才知道
那就是它本来的样子（8 元素的组件稿）。**纪律②：判活只认内容，一张空白的截图
和一个坏掉的页面长得一样。**

### 74.5 如实记下的两处没接上

- **评论指针接不上**：第七轮画的「指针组」是点选 + 评论互斥两档，
  但 S2 嵌入壳现在只认 `pick / preset / zoom / theme / clear / highlight / recheck` 这几条命令，
  **没有钉评论那一条**。所以工具栏上只有「点选」一半，钉评论还走右侧的评论面板。
  要补的是 S2 稿的接线（`doc/12` M8-15b 遗留）。
  ⚠️ **不做的事要说出来** —— 按形制图把两颗钮都画上去、其中一颗点了没反应，
  比少画一颗糟得多（用户第 11 条抱怨的正是「点击后没有任何反应」）。
- **`SidePanels` 还是按面板 id 分叉的一大坨**，`PropsPanel`（只有设计稿用）
  和 `FileCard`（只有 fallback 用）也还在 `workbench/`。
  那是**面板层**的同一个病，和这一轮的格式层是两件事，没有顺手一起动。

### 74.6 读数

```
selftest      基准全过 · 界面稿零 error · 语料零误报
filetest      泛型文件层 全通过
rendertest    15 条渲染基准全过
uitest        44/44（新增 10 条：四种格式的工具栏各两条 + 目录三条 + 画布判活两条）
```

---

## 七十五、设计侧第八轮收稿：布局模型换成「左 / 底 / 右三块在不在」（2026-09-25）

用户第二轮真用提的 13 条里，9 条形制交了出去（`doc/14` §八）。三份稿收回并入。

### 75.1 读数

| 稿 | 字节 | 行数 | `renderVals` 键 | 渲染 |
| --- | --- | --- | --- | --- |
| S11-工作台布局壳 | 129623 | 1064 → 1556 | 120 → **171** | error 0 · 元素 420 |
| S12-目录视图 | 41794 | 475 → 522 | 27 → 33 | error 0 · 元素 139 |
| S9-会话面板 | 48031 | 608 → 644 | 52 → 60 | error 0 · 元素 150 |

真开浏览器看过 S11：484 元素、**27 个演示态都能切**、控制台零 error。

### 75.2 丢键核对：工具拦对了，判断得人来做

`incoming` 拦下 S11：**少了 26 个键**。设计侧回复 §九 列了它有意删掉的 **25 个**
（换边 / 输入条那一套、旧的目录钮五件套、状态行四件套），逐个对得上。

第 26 个 `hasPanels` 它没写。查新稿 L1043 —— **它还在**，只是从 `renderVals` 的顶层键
降成了内部变量，功能由三处承接：右栏钮的置灰 `regionBtn("right", …, !hasPanels)`、
提示语「这类文件没有从属面板」、布局读数「右 无」。

这正是 §70.2 改判据时想要的效果：**工具只摆证据，判断留给人。**
自动判的话，`hasPanels` 和那 25 个长得一模一样 —— 都是「顶层键没了」。
回执里请它下次把这种「降成内部变量」的也列进 §九。

### 75.3 核心裁决

**① 布局模型换掉**（用户第 4 条）。顶栏右边三颗区域钮，每颗管一块在不在：

| 钮 | 管哪块 | 快捷键 |
| --- | --- | --- |
| 左栏 | 会话 | ⌘\ |
| 底栏 | 调试 | ⌘J |
| 右栏 | 从属面板 + 图标轨 | ⌘⌥B（没有面板的文件**置灰**，不是弹起） |

**目录列不算三块之一** —— 它属于「中间」（导航 + 内容一对）。
它的开关只在自己列头，收起后同一个图标箭头反向出现在页签条最左（目录回来的地方）。
这正是用户第 4 条要的「由目录区块上的菜单图标自己控制」。

**② 会话栏固定在左，R1 要改。** 换边和「收成输入条」两态**有意删掉**：
「左栏钮只有开 / 关两态，表达不了半开」。
`layout.chatSide` / `chatMode` 换成 `left` / `bottom` / `right: boolean` + `bottomHeight`。
让位从三步减到两步（面板改抽屉 → 目录成浮层）。

**③ 底栏调试**：三页（输出 / 工具调用 / 连接），默认关，可拖 120–420。
分界线是**「工具自己的状况」进，「这份文件的质量」不进** ——
所以体检明细不进（那是诊断面板的事），AI 用量不进（会话栏底部已有）。
关着的时候出 error，顶栏那颗钮挂红点。

**④ 页签**：体检状态**不上页签**（它已经在树、诊断角标、诊断面板三处）；
页签上只留**未保存**点，占关闭钮的位置，颜色用 text-2 **不用 warn 橙**
——「它表示进度，不是警告」。用户把灰点读成「未保存」恰恰因为他见过这种写法。
放不下的收进「+N ▾」，**不横向滚动也就没有滚动条**。

**⑤ ⤢「铺到详情区」删掉**，功能留在右键 / 双击 / 点项目名三处。

### 75.4 它问的三件，我们定了

**① ⌘J 真的冲突。** 我们占用 `⌘\` `⌘B` `⌘J` `⌘P` `⌘S`，其中 **⌘J 现在是「聚焦会话输入框」**。

定：⌘J 给底栏（按它的），**聚焦输入框改成 ⌘L** ——
Cursor 和 VS Code 的 Copilot Chat 都用 ⌘L 聚焦聊天输入，而用户正在用 Cursor
（他的 Pro 会员就是通道 B 的来源之一），有肌肉记忆；顺带 L = 左栏的助记。
补一条行为：**左栏关着时按 ⌘L 先打开再聚焦**。

**② 删除多久算「离开」**：采纳它的「做下一件事」，定成四条 ——
打开别的文件或目录 · 再删一个 · 开始重命名或新建 · 切项目或关窗。
**第四条是我们加的**：不加的话关窗时那一行还悬着，重开之后用户既看不到撤销入口、
文件也没真删，**状态卡在半途**。

**③ 模板来源**：不是它猜的 design-system 目录，是每个项目自己的 `.umbrastudio/templates/`
（`list_templates` / `save_as_template` / `create_draft` 的 `source: template` 都已经有）。
⚠️ 但**现在两个测试项目一个模板都没有**，所以这一组大多数时候只有「空白」和
「复制现有稿…」两项 —— 这一条反问回去了。

### 75.5 我们发现的一条：评论指针接不上

它在文件工具栏画了互斥的「点选 | 评论」，但 **S2 嵌入壳只认**
`pick · preset · zoom · theme · clear · clear-style · highlight · preview-style · recheck · applied`
—— **没有钉评论那一条**。钉评论现在走右栏的评论面板。

所以工具栏上只接了「点选」一半。**按形制图把两颗都画上、其中一颗点了没反应，
比少画一颗糟得多** —— 用户第 11 条抱怨的正是「点击后没有任何反应」。
是加 S2 的接线还是工具栏不要这一颗，问回去了。

---

## 七十六、M8-18…M8-24 第八轮全部接线：布局模型换掉、底栏、右键菜单、页签重画（2026-09-25）

设计侧第八轮的九条形制全部落地。这一批动的是**布局引擎本身**，是历来最大的一次接线。

### 76.1 布局模型：从「会话栏摆哪」到「三块在不在」

`layout.chatSide` / `chatMode` → `left` / `bottom` / `right` + `bottomHeight`。

**老 schema 有迁移**：`chatMode: "bar"`（会话收成输入条）在新模型里最接近的是「左栏关着」——
两种情况下会话都不占一整列；换边没有对应项，直接丢掉。
不迁移的话老用户打开是 `left: undefined`，**左栏直接不见**。

**让位（R2–R5）改成主动算**（`computeYield`，照 S11 L1051 那段搬的），不再量 DOM。
量 DOM 有两个毛病：

1. 量到的是「让位之后」的结果，却要靠它反过来决定让不让位 —— 是个环
2. 节点卸载的瞬间会报宽度 0，误判成最窄档（§71.6 真栽过，全屏遮罩把界面锁死）

会话固定在左之后，让位从三步减到两步：面板体改抽屉 → 目录列让位成浮层。

### 76.2 一件事一个入口，逐条兑现

| 原来两个入口 | 现在 |
| --- | --- |
| 目录开关在顶栏（第七轮）+ 用户期望在列头 | **只在列头**；收起后同一图标箭头反向出现在页签条最左 |
| 会话栏的 `×` + 顶栏的左栏钮 | 只剩顶栏左栏钮 |
| 会话标题 ▾ 进历史 + `＋` 新会话 | 只剩历史钮；**列表第一行是「新建会话 ⌘N」** |
| 项目菜单的「复制路径」+ 路径那一栏 | 路径**整块可点即复制** |
| 项目菜单的「新建稿件」 | 去了**目录右键** —— 右键点在哪，稿就建在哪 |

⌘J 让给底栏，**聚焦会话输入框改 ⌘L**（Cursor / Copilot Chat 的通行键）。

### 76.3 底栏调试

三页（输出 / 工具调用 / 连接），默认关、可拖 120–420、双击回 200。
**布局读数常驻在头部右侧，不单开一页** —— 只有一行，而且调布局时要一边拖一边看。

装什么按一条线分：**工具自己的状况进，这份文件的质量不进**。
所以体检明细不进（诊断面板的事）、AI 用量不进（会话栏底部已有）。
关着的时候出 error，顶栏那颗钮挂红点。

⚠️ **核心的 stderr 前端拿不到**，只能收 window error / unhandledrejection / toast。
这一条如实写进了 `ui/debug.ts` 的注释，别让底栏假装什么都收得到。

### 76.4 右键菜单：三套，共用一份定义

目录 / 文件 / 空白处三种菜单，**目录列（S11）和目录视图（S12）共用同一份**
（`workbench/ctxmenu.tsx`）—— 设计侧原话「和 S11 目录列同一套」。

它给的三条规则，每条都有理由：

- **新建只出现在目录和空白处** —— 只有这两处能回答「建在哪」
- **重建索引只出现在空白处** —— 它作用于整个项目，右键某个目录时出现会让人以为只建这一个
- **删除不弹确认**，菜单里写「移到回收站」，写的是它实际做的事；
  做完原地塌成一行撤销（沿用 S1 的口径），落实时机按 §75.4 的四条

**做的时候发现一个真问题**：树内容一满就**没有空白处可点**，用户等于没法在根目录新建。
补了两条路：树底部留 56px 空白 + **项目名右键 = 空白处菜单**（项目名就是项目根）。

本地 API 顺带补了三条一直缺的路由：`dir_create` · `duplicate_draft` · `templates`
（MCP 侧早就有实现，本地 API 没开过 —— 界面上没有入口，所以没人发现缺）。

### 76.5 页签重画

- **体检状态不上页签**（它已经在树、诊断角标、诊断面板三处）。页签上只留**未保存**点，
  **占关闭钮的位置**，颜色用 `text-2` **不用 warn 橙** ——「它表示进度，不是警告」。
  用户把灰点读成「未保存」，恰恰因为他见过这种写法。
- 未保存是**每种格式各自知道**的事，而显示它的地方不属于任何格式 ——
  加了 `ui/dirty.ts` 这个登记处。
- 放不下收进「+N ▾」，**不横向滚动也就没有滚动条**；当前页签永远在可见的那几个里；
  同名文件带上目录名。
- 当前页签改成**凸起块**（panel 底色 + 三面描边 + 上圆角），下边和文件工具栏连成一片。

### 76.6 截图抓到的三条，判据都抓不到

DOM 判据一路全过，这三条全是看图看出来的：

1. **底栏横跨了右栏** —— 设计侧明确说「不截右栏」。右栏和会话栏一样提到主体层，
   底栏只横跨中间那一柱。
2. **文件工具栏溢出**，读数压在属性面板上（详情列窄到 440 时装不下）。
3. **`⋯` 被挤出可视区 7px** —— 量出来它落在 1067，可视区到 1060。
   而 `⋯` 里装着体检、对比上一版这些动作，**那是点得到才有用的东西**。

第 3 条的修法值得记：给 `ViewContext` 加了 `detail`（算出来的详情宽度），
**由格式模块自己决定收哪一样** —— 只有它知道自己有几组开关、哪一样最能让。
dc 的选择是先收「演示」（低频，收进 `⋯` 照样点得到），再收读数。
工作台给数字，不替它做主。

### 76.7 读数

```
selftest      基准全过 · 界面稿零 error · 语料零误报
filetest      泛型文件层 全通过
lifecycletest 生命周期回归全通过
rendertest    15 条渲染基准全过
uitest        71/71（新增 27 条）
```

新增那 27 条里，**「不该有的东西不在」占了 6 条**：
右键目录没有重建索引、右键文件没有新建、页签上没有体检点、
顶栏没有目录钮、项目菜单没有新建稿件、列头没有 ⤢。
分层和归位做对了的标志，恰恰是某些地方少了东西。

---

## 七十七、M8-25 浮层统一封装：三个缺陷是同一个问题的三种长相（2026-09-26）

用户第九轮的 14 条里，第 2 条和第 4 条**不依赖设计侧的形制裁决**，趁它开工先做了。

### 77.1 三个缺陷，一个根因

| 用户报的 | 根因 |
| --- | --- |
| 引擎下拉**左边超出窗口**，超出的看不见 | 写死 `absolute right-0`，没人管窗口边界 |
| 下拉开着时**点别处不收起** | 那一处忘了加接外部点击的那一层 |
| **Markdown 的 `⋯` 弹不出来** | 浮层是 `absolute`，被文件工具栏的 `overflow-hidden` 整个裁掉了 |

第三条的 `overflow-hidden` **是我自己在 M8-18 加的**（防读数溢出压住属性面板）。
修一个问题带出另一个 —— 而两处代码隔着三个文件，加的时候完全没想到。

三条的共同点：**界面上有 7 处各写各的浮层，每处都漏掉一样**。
用户说的不只是修：「需要封装下，方便统一管理操作逻辑以及显示样式」。

### 77.2 `ui/Popover.tsx`：全项目一份

- **`fixed` 定位**，脱离任何 `overflow` 容器 —— 第三条从根上不会再发生
- 打开时量一次触发元素的位置，**放不下就翻到另一边**、贴边不越界
- Esc 和外部点击统一在这里

7 处全部换过去：引擎下拉 · 文件 `⋯` · 尺寸读数钮 · 转到文件 · 右键菜单 · 页签的「+N ▾」· 项目菜单。
菜单项也统一成 `PopItem` / `PopSep`（原来高度 28 / 30、hover 底色深浅各不相同）。

**一个实现细节值得记**：第一版用的是全屏遮罩接外部点击，结果**遮罩盖在触发钮上面** ——
用户点钮想关，点到的其实是遮罩（行为碰巧也对），但任何自动化点击都会报「元素被遮挡」，
而且浮层开着时整个界面都点不动。换成 `document` 的 capture 监听，
点在浮层里或触发钮上就不管，其余一律关。

样式（圆角、阴影、动画时长）**等设计侧第九轮 9.4 的形制**，到时候只改这一个文件。

### 77.3 第 4 条：调试信息挪进底栏

会话栏底部的「运行中」和 token 数搬到底栏头部左侧，和右侧的布局读数对称。

⚠️ 设计侧第八轮说过 AI 用量**不该**进底栏（理由：会话栏底部已有、人正是在那儿决定要不要停手）。
用户第九轮明确要它进来 —— **以用户为准**，第九轮交办单里也把这一条原样转给它了。

### 77.4 判据被会话内容蒙了一次

第一版判据写的是「会话栏里不含 `tokens`」，结果**被工具名 `search_tokens` 蒙掉**：
会话流里有 `search_tokens query=主题色` 这样的行，正则一匹配就中。

换成结构标记 `[data-ud="turn-cost"]`。
**这已经是同一条教训的第三次**（§72.4 拿「N 份稿」当启动判据、
§73.4 三条横带同高用 class 定位）：

> **判据要落在结构上，不要落在文案上。**
> 文案是设计侧随时会改的东西，而界面上任何一段文字都可能在别处出现。

### 77.5 读数

```
selftest      基准全过 · 界面稿零 error · 语料零误报
filetest      泛型文件层 全通过
lifecycletest 生命周期回归全通过
rendertest    15 条渲染基准全过
uitest        76/76（新增 5 条：浮层三条 + 第 4 条 + 一条反向）
```
