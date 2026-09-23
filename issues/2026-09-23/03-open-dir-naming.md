---
title: "[chore] 首页右上角「打开目录」名字有歧义：是导入项目吗"
labels: [type:chore, from:user, p2]
---
<!-- fp: review/umbra-design/server/ui/index.html#open-dir-button-name -->
来源：用户 ｜ 证据：server/ui/index.html 首页顶栏按钮 `handleOpenProject`
发现方式：用户提问。【确证】
状态：已修 · commit 1692889

### 位置
首页顶栏按钮叫「打开目录」，点了只弹目录选择框；选到不是项目的目录会报错，选到项目才打开。

### 为什么是问题
「打开目录」像是在访达里打开什么；用户真正想做的是「把一个目录当项目导进来」。

### 影响面
首页。

### 怎么修
改名「导入目录」（tooltip 说明两种结果）：选目录后先 `inspect_dir`，已是项目（有 project.json）直接打开；只是一堆 `.dc.html` 或空目录就进「新建项目」面板预填路径与建议名，接管它。浏览器模式没有目录对话框，直接进面板填路径。
