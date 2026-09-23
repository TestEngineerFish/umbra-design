# UmbraDesign · 16 ClaudeDesign 对照调研（2026-09-23）

> **这份文件只管一件事：ClaudeDesign 本尊长什么样、我们和它差在哪。** 它是依据出处（和 `04` / `05` 一类），
> 不是需求。要不要补哪一块，登记到 `11` §四让用户拍板，定了再进 `01` / `12`。
>
> 依据分两种：【实见】= 2026-09-23 在 `claude.ai/design` 里打开我们自己的项目亲眼看的；
> 【资料】= 公开文章与它给 MCP 客户端的系统提示（`get_claude_design_prompt`）。凡【判断】都单独标。

---

## 一、ClaudeDesign 本尊

### 1.1 布局【实见】

```
┌ 左栏 ≈ 320px ────────────┬ 右侧整块画布 ──────────────────────────────────────────────┐
│ 项目名 ▾                  │ [刷新][文件列表][文件页签 ▾]       100% [指针] Comment  Edit  Present ▾  Share │
│ 聊天记录                  │                                                              │
│  · 模型的话               │   稿在这里渲染（就是 .dc.html 本身，独立 iframe）             │
│  · 「Edited 4 files」卡    │                                                              │
│  · 文件卡（可点开）        │                                                              │
│ ─────────────────────── │                                                              │
│ [Design System ▾]         │                                                              │
│ 输入框 · 模型选择 · Send  │                                                              │
└──────────────────────────┴──────────────────────────────────────────────────────────────┘
```

- **只有两栏**：左聊天、右画布。没有常驻的稿件列表栏 —— 文件切换在画布顶栏的页签下拉里。
- 顶栏右侧四颗常驻：**Comment / Edit / Present / Share**。
- 左栏的头部三颗图标：收起、全屏画布、搜索。

### 1.2 三种模式，左栏整个换掉【实见】

| 点 | 左栏变成 | 画布上 |
| --- | --- | --- |
| **Edit** | 顶部 Save / Discard；四个页签 **Simple / Pro / Code / Tweaks**。Pro：图层树（`group › div`）+ 一排工具（选择 · 文字 · 框 · 矩形 · 圆 · 钢笔 · 线 · 撤销 / 重做）+ 提示「Click any element on the canvas to edit it. Repeated elements are edited together. Shift-click to select more.」。Tweaks：`data-props` 里 `editor` 非 null 的项渲染成控件（我们的 S10 就是这个） | 点元素出上下文属性 |
| **Comment** | 「Comments · No comments yet. Leave feedback for your teammates below.」+ 底部评论输入框 | 提示「Click to comment, drag to draw」—— 评论钉在元素上，可以画框 |
| **Present** | — | 全屏演示 |

编辑是**改写到文件里**的：它的系统提示写明「A `<style id="__om-edit-overrides">` block or `data-comment-anchor` attributes mean the user touched this file in the editor」—— 直接编辑落成一段 `!important` 覆盖样式，评论锚点是元素上的属性。

### 1.3 资料里补的【资料】

- 四条改稿通道：对话、元素上的内联评论（可「Send to Claude」）、画布上直接编辑（文字 / 边框 / 颜色 / 字体 / 边距，**不能自由拖动元素**）、Tweaks 生成的上下文滑块。
- 项目 = 文件夹树（我们项目里就是 `ui/`、`uploads/`），可绑定设计系统（GitHub / 设计文件 / 上传 / 本地代码库，`/design-sync`）。
- 导出：zip / PDF / PPTX / 独立 HTML；交接给 Claude Code；Share 链接（默认私有）。
- **没有版本历史 / 回退**（多篇评测点名）；多人同时编辑「基础」；评论偶尔丢；大代码库卡。
- 它自己的工作纪律（系统提示）：每次写完必须 render → 看截图 → 「fresh eyes」复核；小改只改那一处；`.dc.html` 骨架、`support.js` 由 `create_support_js` 写、`data-props` 的 `$preview` 与 editor 类型 —— 和我们 `02` / `03` / `06` 记的一致。

---

## 二、我们现在的样子

```
┌ 侧栏 280px ─┬ 预览（S2 编辑壳，可点选 / 属性面板）──────────────┬ 会话栏 380px ─┐
│ 搜索 / 筛选  │ [稿名] [编辑壳|稿本身] [体检] [浏览器]                │ AI 回合 / 工具行 │
│ 稿件列表     │   稿                                              │ 变更卡 · 回退   │
│ 图标·健康·版本│                                                   │ 已选中节点药丸  │
├─────────────┴───────────────────────────────────────────────────┴───────────────┤
│ 底栏：诊断 / 变更 / 稿件信息 · 对比上一版 · 半屏 · 收起                                │
└────────────────────────────────────────────────────────────────────────────────────┘
顶栏：Logo · 项目名 · N 份稿 ……………………………………………… [新建稿件] [⋯]
```

三种编辑方式已在应用里闭环：① S2 属性面板（字面量 style / attr / 文案）· ② 点选节点带给 AI · ③ 直接对话。
外加它没有的：本地语义快照与四级 diff、`CHANGELOG-设计侧.md`、静态校验 + 真浏览器体检、断网可用、MCP 出口。

---

## 三、逐项对照

| 能力 | ClaudeDesign | UmbraDesign 现状 | 差距 |
| --- | --- | --- | --- |
| 对话改稿 | 左栏主通道 | 右栏会话面板，已闭环 | **位置不同**（见 §四 J1） |
| 点元素改属性 | Edit › Simple：上下文属性面板 | S2 属性面板（方式 ①） | 基本对等；我们只改字面量，洞会说明原因 |
| 元素评论 → 发给 AI | Comment 模式，评论钉元素、可画框、Send to Claude | 方式 ②（选中 + 说一句）覆盖了「指着改」；**没有评论列表与持久化** | 缺评论实体（`04-a`） |
| Tweaks（props 控件） | Edit › Tweaks | S10 组件 props 面板（M4-2 ✅） | 对等 |
| 图层树 / 画笔工具 | Edit › Pro | 无 | `01` §八 明确不做自由画布；**判断**：图层树值得，画笔不值 |
| Code 视图 | Edit › Code | 无（AI 有 `read_draft`，人没有） | 缺一个只读源码视图（便宜） |
| 直接改文字 | 画布上就地编辑 | 属性面板里改文案 | 就地编辑缺（`04-b`） |
| 文件组织 | 文件夹树，顶栏页签切换 | 侧栏列表 + 搜索筛选，目录分组（M1-8） | 我们更像 IDE，它更像文档 |
| 版本 | **没有** | 快照序列 + 弹层 + 一键回退 + S6 并排对比 | 我们领先 |
| 变更交付 | 交接给 Claude Code（打包） | `CHANGELOG-设计侧.md` + 四级 diff | 我们领先 |
| 校验 / 体检 | 它自己内部做 render 复核，不给用户看 | 诊断面板、健康四色、体检读数 | 我们领先 |
| 设计系统 | 绑定后 AI 用；Settings › Design systems | `project.json` 配路径；S5 浏览器；AI 走 `search_tokens` | 对等；**绑定 / 导入的界面**我们没有（S8 待接） |
| Present | 全屏演示 | 「在浏览器打开」 | 缺一颗全屏（便宜） |
| 导出 | zip / PDF / PPTX / HTML | 稿就是文件；`export_project`（tar）| `01` §八 不做 PDF；zip 已有 |
| Share | 链接 | 无（本地产品，`01` §八 不做云同步） | 按定位不做 |
| 多人 | 基础 | 无 | 按定位不做 |
| 断网 | 需要网络 | 必须可用 | 我们领先 |

---

## 四、判断（需要用户定的集中在 `11` §四 Q13–Q15）

**J1 · 会话栏在右不在左。** 我们是「先看稿、再说话」的 IDE 式；它是「先说话、稿在旁边长出来」的文档式。两种都成立，但既然定位是「基本一样的软件」，**判断**：把会话栏做成可以放左或放右（一个开关），默认跟它一样在左，稿件列表收进顶栏页签下拉或作为可收起的第二栏。改动量：前端布局一天。

**J2 · 缺的是「评论」这个实体，不是通道。** 方式 ② 已经能指着元素说话，但那句话只活在会话里，不钉在元素上、不能列出来、不能标「已处理」。它的 Comment 模式是团队协作用的（Leave feedback for your teammates）；我们单机、单人，**判断**：先做「钉在节点上的便签」（存 `.umbradesign/comments.json`，S2 里显示钉子，会话里能一键「把这条评论发给 AI」），不做画框。

**J3 · 便宜且该补的三样**：Code 只读视图（复用 `read_draft`）、Present（预览全屏 / 隐藏壳）、文字就地编辑（点选桥已能定位节点，`set_prop kind=text` 已有，缺的是画布上直接敲）。

**J4 · 不补的**：画笔 / 图形工具、Share、多人、PDF / PPTX 导出。都和「本地」「编辑 `.dc.html` 结构与取值」的定位冲突，`01` §八 已明确。

**J5 · 上一批 Agent 的设计稿方向是对的。** 十屏（索引 / 预览壳 / 诊断 / 变更 / 设计系统 / 版本对比 / 属性面板 / 项目设置 / 会话 / props 面板）覆盖了它的 Edit（Simple + Tweaks）、对话、版本（它没有的）三块，多出来的诊断 / 变更 / 对比正是「存本地」换来的。**缺口在布局取向和评论实体，不在能力面。**

---

## 五、来源

- 【实见】`https://claude.ai/design/p/26c16030-ab11-411c-a5e9-3beb734e6982`（我们自己的项目，2026-09-23）
- Anthropic 新闻：`https://www.anthropic.com/news/claude-design-anthropic-labs`
- 帮助中心「Get started with Claude Design」：`https://support.claude.com/en/articles/14604416-get-started-with-claude-design`
- Anima「What is Claude Design」：`https://animaapp.com/blog/ai-design-en/what-is-claude-design/`
- Builder.io 评测：`https://www.builder.io/blog/claude-design`
- Justin McKelvey 评测：`https://justinmckelvey.com/blog/claude-design-review`
- 它给 MCP 客户端的系统提示（`get_claude_design_prompt`，2026-09-23 取）
