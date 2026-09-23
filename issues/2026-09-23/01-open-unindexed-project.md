---
title: "[bug] 首页打开从未建索引的项目失败：「项目根还没有 index.dc.html，打开根路径会 404」"
labels: [type:bug, from:user, p0]
---
<!-- fp: review/umbra-design/server/src/index.ts#serve-start-index-error -->
来源：用户 ｜ 证据：server/src/index.ts `serve_start` 工具（改前对 `indexExists=false` 返回 error 级诊断）；server/src/api.ts `open_project` 路由（改前不建索引）
发现方式：用户在首页点 57 份稿的「umbra」项目复现；Playwright 用项目副本复现（`pwsweep.mjs`：S2 / S6 / S8 壳全 404）。【确证】
状态：已修 · commit b41379b

### 位置
Tauri 壳：`openProjectDir` → `serve_start`，工具对没有 `index.dc.html` 的项目返回 **error**，前端当失败弹「打开项目失败」。浏览器：`open_project` 只起服务不建索引，进去后编辑壳 `S2-…?embed=1`、S6、S8、点选桥全部 404，侧栏也没有元素数 / 健康色。

### 为什么是问题
壳页面、点选桥、令牌、健康读数都靠 `build_index` 部署进项目目录；「没索引」是第一次打开的正常状态，不是错误。把它报成 error 等于所有没被我们建过索引的项目（用户自己的、从别处拷来的）都打不开。

### 影响面
任何第一次打开的项目；用户报的这条是主流程第一步。

### 怎么修
`serve_start` 没索引就顺手 `buildIndex`，返回 `note`「第一次打开，已自动建索引并部署界面壳」；`open_project` 路由同样；前端 `fetchDrafts` 收到 `indexed:false` 再兜底重建一次（只试一次）。壳内自测（`umbra_copy3`，从没建过索引）：open_project 57 份稿 ✓、select_draft 走 S2 壳 ✓、索引文件已生成。
