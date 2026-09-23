---
title: "[bug] 浏览器模式下「新建稿件」「新建项目」不可用（toast「浏览器调试模式没有 MCP 通道」）"
labels: [type:bug, from:radar, p1]
---
<!-- fp: review/umbra-design/server/ui/index.html#create-needs-mcp -->
来源：扫测 ｜ 证据：server/ui/index.html `submitNewDraft` / `submitNewProject` / `inspectDir`（改前只走 `mcp()` / `invoke()`）
发现方式：Playwright 在 `/__app/` 里提交新建稿件表单，toast 报没有 MCP 通道。【确证】
状态：已修 · commit b41379b

### 位置
应用前端的三个动作只有 Tauri 路径（MCP 或 Rust 命令），浏览器模式（`npm run ui` 打开的 `/__app/`）没有对应的本地 API 路由。

### 为什么是问题
M6-8 把浏览器入口统一到应用本体之后，浏览器模式就是正式入口之一，不再是「调试模式」；建稿建项目是主流程。

### 影响面
浏览器模式的所有用户。

### 怎么修
本地 API 加 `create_draft`（blank / copy / component 三种来源）、`create_project`、`inspect_dir`（GET）、`reveal_dir`；前端 `!T` 时走它们。实测：副本里新建「扫测新稿」落盘并自动选中；`/tmp/ud-sweep-proj` 建成并跳进去；空项目里新建第一稿 ✓。
