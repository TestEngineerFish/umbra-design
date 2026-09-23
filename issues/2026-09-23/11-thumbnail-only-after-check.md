---
title: "[idea] 首页缩略图只有跑过体检的稿才有，多数项目只显示稿数"
labels: [type:idea, from:review, p2, 待拍板]
---
<!-- fp: review/umbra-design/server/src/api.ts#projects-thumbnail-source -->
来源：看代码 ｜ 证据：server/src/api.ts `projects` 路由取「索引里元素最多且有截图的那份」；截图来自 `.umbradesign/checks/*.png`
发现方式：首页三个真项目只有一个有图。【判断】
状态：待拍板

### 位置
缩略图依赖体检截图；用户不点体检就永远是空的。ClaudeDesign 首页每个项目都有图。

### 为什么是问题
首页辨识度。

### 影响面
首页。

### 怎么修
要拍板：**(a)** 建索引时对元素最多的稿顺手截一张（多 1–2 s，要有浏览器）；**(b)** 打开项目后台补截；**(c)** 保持现状。判断：(b) 不拖慢打开，且用户第二次进首页就有图。
