---
title: "[bug] 导入的稿（没经过 write_draft）没有节点地址，编辑壳里点选不到任何元素"
labels: [type:bug, from:radar, p1, 待拍板]
---
<!-- fp: review/umbra-design/runtime/select-bridge.js#pick-requires-data-ud-node -->
来源：扫测 ｜ 证据：runtime/select-bridge.js:46（`closest("[data-ud-node]")`）；用户项目 `Umbra PC 端.dc.html` 里 `data-ud-node` 出现 0 次
发现方式：Playwright：开点选、点画布正中，`state.picked` 为 null；S2 没有任何「这份稿没有地址」的提示。【确证】
状态：待拍板

### 位置
节点地址 `data-ud-node` 是我们落盘（`write_draft` 那条路）时打的；用户自己写的、从 ClaudeDesign 拷来的稿从没经过这条路，一个地址都没有。点选桥只认有地址的元素，所以什么都选不中，也没有解释。

### 为什么是问题
方式 ①（点选改属性）和方式 ②（选中给 AI）对导入稿全部失效，用户只能走方式 ③ 直接说；评论也钉不上去。这正是「本地版 ClaudeDesign」最常见的起点 —— 拿现成稿进来改。

### 影响面
所有导入的稿；用户项目里 57 份大多如此。

### 怎么修
要拍板：**(a)** 第一次在编辑壳打开时自动把稿走一遍唯一写入口（归一化 + 打地址，会改用户文件、留一版快照，来源标「工具归一化」）；**(b)** 不自动改，点选时在 S2 顶部给一条「这份稿还没有节点地址 · 一键打地址」；**(c)** 点选桥退化成按 DOM 路径临时定位，落盘时再打地址（改动最大）。判断：**(b)** 最稳，用户知道发生了什么；(a) 最顺手但动了「不碰用户稿」的边。定了再做。
