# UmbraDesign · 00 MCP 工具契约

> **这一份是实现 UmbraDesign 的主文档。** 它定义本地 MCP server 对外暴露什么、
> 入参出参长什么样、错误怎么回。
> 需求见 `01`，运行时架构见 `02`，模板语义见 `03`，缺陷与验收见 `04`，
> 实测依据见 `05`，写稿规则见 `06`，变更交付见 `07`。

---

## 一、这一层解决什么

`.dc.html` 格式和 `support.js` 运行时已经有了（见 `05` §一）。
UmbraDesign 要做的**不是重写引擎**，是补上引擎外面那一层：

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
UmbraDesign/                    ← 工具本身。这是一个 git 仓库，只追踪工具
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
<用户指定的项目根>/              ← 默认 UmbraDesign/projects，可配置
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
    .umbradesign/               ← 工具产物（快照 / 缩略图 / 索引缓存）
    CHANGELOG-设计侧.md         ← 给实现侧的变更清单（见 07）
  某客户/                        ← 另一个租户，同样形状，自己的 _ds 和自己的 git
```

**为什么工具不追踪用户的项目**：UmbraDesign 将来要打包分发，用户安装时会
指定自己的项目存储地址。让工具的仓库去追踪用户的项目，等于让用户追踪工具自身——
方向是反的。项目根的位置通过启动参数或环境变量给（`--projects-root`
/ `UMBRADESIGN_PROJECTS_ROOT`），默认 `./projects`。

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

这也让整个租户目录可以直接打包交给实现侧——**打开就能跑，不依赖 UmbraDesign 在不在**。

### 3.1 `project.json`

```json
{
  "name": "umbra",
  "title": "Umbra 私人 AI 助手",
  "designSystem": {
    "dir": "_ds/umbra-design-system-ec7cf6a5-891a-4152-8562-120f755dfe2d",
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
> 稿子拿出 UmbraDesign 照样能开。填路径这件事由 MCP 在落盘那一刻完成。

`validate_draft` 反向检查：落盘后的 ds 引用必须能解析到真实文件，否则报 `E_DS_PATH`。

### 3.3 git：每个项目一个仓库，且只是兜底

`07` 的语义 diff 需要历史版本。取历史有两条路，**主次分明**：

| 路 | 出处 | 地位 |
| --- | --- | --- |
| **主路径** | `.umbradesign/snapshots/<稿名>/v<N>.json` 的快照序列 + `CHANGELOG-设计侧.md` | 工具自己产的，不依赖任何版本控制 |
| **兜底** | `git show <ref>:<path>`，现算快照 | 只在要按任意 git ref 取版本时用 |

约定：

- **每个设计项目各自一个 git 仓库**，仓库根就是租户目录。
  MCP 在租户目录里执行 git 命令，不跨出去。
- **UmbraDesign 自身的仓库不追踪任何租户**（`.gitignore` 里 `projects/`）。
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
   | 设计系统路径 | `href="@ds/tokens/colors.css"` | `href="_ds/umbra-design-system-<uuid>/tokens/colors.css"` |
   | 离线资源映射 | 什么都不写 | `support.js` 之前插入 `window.__resources` 块，把 React 的 CDN URL 指向同层本地副本 |

   ⚠️ **第二条必须由工具做，不许写进设计稿。** 理由三条：
   support.js 里 React 的 URL 是硬编码常量（`05` §1.2），映射是绕过它的唯一办法；
   设计侧的宿主自己会注入这张表，写进稿里在那边是冗余；
   React 版本升级时改一处（工具）而不是改 N 份稿。
   注入块用 `<!-- umbradesign:resources -->` 包起来，**改写幂等**——
   重复落盘不叠加，先删旧块再写新块。
2. **落盘即校验** —— 内部先跑 `validate_draft`。有 `error` 级诊断则**拒绝落盘**并原样返回诊断；
   只有 `warning` 则落盘并把 warning 一并返回。
3. **落盘即留痕** —— 写快照到 `.umbradesign/snapshots/`，追加一条 `CHANGELOG-设计侧.md`（见 `07`）。

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
  "screenshot": ".umbradesign/shots/日志@1440x900.png"
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
| ③ 落盘即留痕 | 写语义快照到 `.umbradesign/snapshots/<稿名>/v<N>.json`，版本号按稿独立计数 | v1 / v2 依次生成；内容与盘上一致时**不落盘也不升版本**，避免版本号空转 |

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
环境变量 `UMBRADESIGN_CHROMIUM` → 常见安装路径（macOS 的 Chrome / Chromium / Edge / Brave、
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
| `.umbradesign/index-data.json` | `08` S1 的数据契约，原样；给设计侧那份页面读 |
| `index-data.js` | 同一份数据挂成 `window.__UD_INDEX` |
| `index.dc.html` | 入口页本身，用 `.dc.html` 写（自举：工具产的页要能过自己的校验） |
| `.umbradesign/tool-tokens.css` | 从 `ui/_ds-tool/tokens.css` 拷来的工具皮肤 |

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

首屏文字：`UmbraDesign | 入口页验证 | · 3 份稿 | 索引生成于 3 分钟前 | 全部 | 页稿 |
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

同理，工具皮肤从 `.umbradesign/tool-tokens.css` 改拷到 **`_ds-tool/tokens.css`**
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

`.umbradesign/checks/<扁平路径>.json`：

```json
{ "file": "日志.dc.html", "checkedAt": "…", "srcSha256": "…",
  "alive": true, "nodeCount": 2307, "renderMs": 1840,
  "viewport": { "width": 1440, "height": 900 }, "offline": true,
  "screenshot": ".umbradesign/shots/…png",
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

租户 `.gitignore` 模板里 `.umbradesign/` 已经涵盖 `checks/`，换机器重跑一次就有，
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
`.umbradesign/` 本来就不进仓库 —— 本地磁盘换「能撤销」很值。

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
同源，所以塞得进去。`build_index` 把桥拷到 `.umbradesign/select-bridge.js`。

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
`.umbradesign/checks/`（§十五），所以作业记录不必持久化 ——
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
  `UMBRADESIGN_PROJECTS_ROOT` 改。
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
