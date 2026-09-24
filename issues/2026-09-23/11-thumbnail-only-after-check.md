---
title: "[idea] 首页项目缩略图 —— 已裁决：暂时不要"
labels: [type:idea, from:review, p2, wontfix]
---
<!-- fp: review/umbra-design/server/src/api.ts#projects-thumbnail-source -->
来源：看代码 ｜ 证据：server/src/api.ts `projects` 路由取「索引里元素最多且有截图的那份」；截图来自 `.umbradesign/checks/*.png`
发现方式：首页三个真项目只有一个有图。【判断】
状态：已裁决 · 暂时不做（2026-09-24 用户拍板，`doc/11` Q17）

### 位置
缩略图依赖体检截图；用户不点体检就永远是空的。ClaudeDesign 首页每个项目都有图。

### 为什么是问题
首页辨识度。

### 影响面
首页。

### 裁决（2026-09-24，用户）

**暂时不要缩略图。** 原来列的 (a) 建索引时顺手截 / (b) 打开后台补截 都不做，保持现状（(c)）。

首页现在靠名称 + 路径 + 稿数辨识，够用。要图的话代价是每次建索引多跑一次浏览器，
而这件事的收益只是「好看一点」—— 不值得让打开项目变慢。
