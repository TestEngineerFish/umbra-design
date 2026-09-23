---
title: "[bug] 应用本体没有稿件改名 / 复制 / 移动 / 删除的入口（只在备用入口页 S1 有）"
labels: [type:bug, from:review, p1]
---
<!-- fp: review/umbra-design/server/ui/index.html#file-menu-no-item-actions -->
来源：看代码 ｜ 证据：server/ui/index.html `fileMenuHtml`（每行零按钮，页脚只有「新建稿件」「列表栏」）；`doc/12` 稿件生命周期一行写「✅ 100%」，但 UI 入口在 S1
发现方式：Playwright 数文件页签下拉里每行的按钮：0；grep 应用前端无 rename / copy / delete_draft 调用。【确证】
状态：待修

### 位置
M6-8 之后 `/__app/` 是正式入口、S1 退成备用页，而改名 / 复制 / 移动 / 删除 / 恢复这五个动作的界面只在 S1 行内菜单里（`doc/00` §四十五）。应用本体里一份稿建了就删不掉、改不了名。

### 为什么是问题
`12` 把「稿件生命周期 UI」标成 100% 是按 S1 算的，现在对用户不成立。

### 影响面
应用本体所有用户。

### 怎么修
文件页签下拉每行加「⋯」：改名 / 复制 / 移动到文件夹 / 删除（回收站 + 行内撤销，语义照 S1 第三轮）；后端路由已齐（`delete_draft` / `restore_draft` 有，改名 / 复制 / 移动走 MCP 的 `rename_draft` / `copy_draft` / `move_draft`，浏览器模式要补三条 API）。顺手把 `12` 那一行的验收改成「应用本体里可做」。
