---
title: "[chore] 项目页右上角功能按钮堆满，且和编辑壳（S2）里的按钮重复（体检 / 演示 / 诊断 / 变更 …）"
labels: [type:chore, from:user, p1]
---
<!-- fp: review/umbra-design/server/ui/index.html#canvas-toolbar-duplicates-s2-chrome -->
来源：用户（截图） ｜ 证据：server/ui/index.html `previewToolbarHtml`（改前 6 颗）+ ui/S2-单稿预览壳.dc.html 顶栏两行 + 状态栏两行 + 右侧诊断面板，全部同时显示
发现方式：用户运行后看一眼。【确证】
状态：已修 · commit 58e00c3

### 位置
进项目后的画布区：应用自己的工具栏（稿名 / 编辑壳·稿本身·源码 / 体检 / 演示 / 浏览器）之下，嵌进来的 S2 壳又画了一整套顶栏（标题 / 版本 / 健康 / 演示 / 重跑体检 / 外链 / 诊断·变更页签 / 面板开关 + 设备 / 尺寸 / 缩放 / 浅深）、右侧诊断面板、底部两行状态栏；再往下是应用的底栏（诊断 / 变更 / 评论 / 稿件信息）。

### 为什么是问题
S2 是按独立整页设计的，嵌进应用后它的 chrome 和应用的 chrome 叠在一起：「演示」「体检」各两颗，诊断三处（S2 右栏、S2 底部提示、应用底栏）。ClaudeDesign 的画布只有一条工具栏（文件页签 · 100% · 指针 · Comment / Edit / Present / Share）。

### 影响面
每一份稿的编辑态；用户第一眼就觉得乱。

### 怎么修
- S2 加「嵌入模式」（`?embed=1`）：顶栏两行、状态栏、右栏的诊断 / 变更页签全部不画（`showHead: !EMBED`），右栏只在选中节点后出现（属性 + 评论）；接收应用的指令消息 `{source:"umbradesign-app", type:"cmd", cmd: pick|preset|zoom|theme|recheck|clear}`，状态变化用 `shell-state` 回报父窗口。独立打开的 S2 不变。
- 应用画布工具栏合成一条：`[☰] [稿名 ▾] │ [编辑 | 预览 | 源码] │ [PC 1440 ▾] [－ 70% ＋] [☀/☾] …… [点选] [评论 n] [● 体检] [▷ 演示] [⋯]`，⋯ 里是在浏览器打开 / 对比上一版 / 变更与版本 / 重新加载。顶栏去掉实心「新建稿件」（在文件页签下拉和 ⋯ 里）。
- 第一次拿到壳状态时画布比 1440 窄就自动缩到刚好放下（fit）。
- 实测（Playwright）：工具栏 11 项、S2 嵌入后可见文字为空（无 chrome）；`pick` 开 → 桥 select → 属性面板出现 → `clear` 后收起；preset / zoom / theme 指令各自生效并回报（iPhone · 80% · 深）；独立打开的 S2 顶栏照旧。
