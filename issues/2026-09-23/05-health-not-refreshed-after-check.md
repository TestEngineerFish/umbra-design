---
title: "[bug] 体检完成后稿件列表的健康读数不刷新，仍显示「还没跑过 render_check」"
labels: [type:bug, from:radar, p1]
---
<!-- fp: review/umbra-design/server/ui/index.html#validate-then-rebuild-index -->
来源：扫测 ｜ 证据：server/ui/index.html `handleValidate` finally 段；server/src/api.ts `drafts` 路由只读索引数据文件；`curl` 对比 rebuild_index 前后 `health`
发现方式：Playwright 对 6323 元素的稿点「体检」→ toast「体检完成：6320 节点 · 1438 ms」→ `state.drafts[].health` 仍是 `unchecked`；手动 `rebuild_index` 后变 `warn`「渲染后还留着 40 个未解析的洞」。【确证】
状态：已修 · commit 1692889

### 位置
`health / healthWhy / 缩略图` 是 `build_index` 从 `.umbradesign/checks/` 算出来写进索引数据的；`check` 作业只落体检记录不动索引，`fetchDrafts` 读到的还是旧索引。

### 为什么是问题
用户点完体检看不到结果变色，会以为体检没生效再点一次；首页缩略图也不出现。

### 影响面
每一次体检。

### 怎么修
`handleValidate` 结束后先 POST `rebuild_index` 再 `fetchDrafts`（58 份稿重建约 0.7 s）。更彻底的做法是 `check` 作业完成时服务端更新那一条索引项，留作后续。
