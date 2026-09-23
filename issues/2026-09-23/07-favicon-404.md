---
title: "[bug] 应用页面每次打开都请求 /favicon.ico 并 404"
labels: [type:bug, from:radar, p2]
---
<!-- fp: review/umbra-design/server/ui/index.html#favicon -->
来源：扫测 ｜ 证据：Playwright 响应日志 `HTTP404 /favicon.ico`
发现方式：Playwright 扫测。【确证】
状态：已修 · commit 1692889

### 位置
`server/ui/index.html` 没有 `<link rel=icon>`，浏览器默认去项目根拿 favicon。

### 为什么是问题
控制台每次一条 404，排查时是噪声；壳里标签页没图标。

### 影响面
浏览器模式。

### 怎么修
加一个内联 SVG data URI 的 favicon。
