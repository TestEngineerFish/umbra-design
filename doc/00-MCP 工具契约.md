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
| `E_COMMENT_TAG` | 注释里出现标签字面量（开标签也算） | `06` §2.5 |
| `E_DS_PATH` | 展开后的 ds 引用解析不到真实文件 | §3.2 |

### 6.2 warning（放行但回报）

| code | 检查 | 出处 |
| --- | --- | --- |
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

| 项 | 原因 |
| --- | --- |
| `bundle_draft`（内联成单文件，形态 B） | SVG `<use>` 跨文件引用、`_ds_bundle.js` 里的相对 fetch 两点未验证，**不承诺** |
| 流式渲染 | 第一阶段调用方是模型，一次性落盘（`01` §3.3 F6） |
| props 面板 / 直接编辑 / 主题切换 / 导出 PDF | 给人和秘书用的，第二阶段（`01` §3.2） |
| 删除稿的工具 | 避免误删 |
| 拆分 `Umbra PC 端.dc.html` | 工具跑通后再决定拆不拆 |

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
