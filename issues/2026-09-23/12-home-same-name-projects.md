---
title: "[idea] 首页两个同名项目（不同目录）在网格视图里分不清"
labels: [type:idea, from:radar, p2]
---
<!-- fp: review/umbra-design/server/ui/index.html#home-grid-dir-hint -->
来源：扫测 ｜ 证据：首页同时列出两个「umbra · Umbra 私人 AI 助手」（用户项目与测试副本）；列表视图靠整行路径区分
发现方式：Playwright 读首页行文本。【判断】：列表视图能区分，网格视图未核。
状态：待修

### 位置
`project.json` 的 `name` 不唯一（拷一份项目就重名），首页按名字显示。

### 为什么是问题
拷贝项目做实验是常见做法，重名后容易点错。

### 影响面
首页网格视图。

### 怎么修
网格卡片名字下面补一行缩短的路径（`~/…/父目录/目录`），同名时高亮父目录；或只在检测到重名时才显示。
