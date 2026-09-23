---
title: "[idea] 首页项目行与项目「⋯」菜单加「在访达中显示」，一键打开对应目录"
labels: [type:idea, from:user, p2]
---
<!-- fp: review/umbra-design/server/ui/index.html#reveal-dir -->
来源：用户 ｜ 证据：server/ui/index.html `renderHome` 行内工具、`menuHtml`
发现方式：用户提需求。
状态：已修 · commit 1692889

### 位置
首页项目行只有星标；项目内「⋯」菜单没有打开目录的入口。

### 为什么是问题
稿是本地文件，用户经常要去目录里拷稿、看回收站、开 git；每次手动找路径。

### 影响面
首页与项目菜单。

### 怎么修
首页每行加文件夹按钮、项目菜单加「在访达中显示项目目录」，都走 `revealDir(dir)`：Tauri 走新 Rust 命令 `reveal_dir_command`（不走 shell 插件的 open —— 它的默认作用域只放行 http/mailto/tel，本地路径过不去），浏览器走本地 API `reveal_dir`（open / explorer / xdg-open）。不存在的目录两边都报「目录不存在」。
