---
title: "[bug] 子目录里的稿 @ds 展开成相对项目根的路径，浏览器 404，设计 token 全部失效"
labels: [type:bug, from:radar, p1]
---
<!-- fp: review/umbra-studio/server/src/project.ts#ds-alias-relative-depth -->
来源：扫测 ｜ 证据：server/src/project.ts `expandDsAlias`（改前 `${pre}${p.dsDir}/`，不看稿在哪）；Playwright 控制台 `HTTP404 /PC 端/_ds/…/tokens/colors.css`
发现方式：M7-7 的 Playwright 扫测里切到子目录的稿，响应日志抓到 404。【确证】
状态：已修 · commit c4481f0

### 位置
`expandDsAlias(p, src)` 把稿里的 `@ds/…` 展开成 `p.dsDir + "/…"`，而 `dsDir` 是**相对项目根**的（`_ds/<设计系统 id>`）。稿在项目根时对；稿在子目录（`PC 端/PC 吐司.dc.html`）时，浏览器按稿自己的位置解析，去要 `/PC 端/_ds/…`。

### 为什么是问题
那是一个 404。`colors.css` 一类 token 文件取不到，稿里所有 `var(--…)` 退回浏览器默认值 —— 页面还画得出来，颜色是错的。`render_check` 会把它记进 `missingResources`，但健康判定里它只压到 warn，人不看诊断就发现不了；应用里更是只在控制台留一行。**一份看上去正常、颜色全错的稿**，正是纪律 ② 说的那种「不对的截图和坏掉的页面长得一样」。

### 影响面
所有放在子目录里、又用了设计系统的稿。语料里 `PC 端/` 下 7 份稿全中。根目录的稿不受影响，所以一直没被发现。

### 怎么修
- `expandDsAlias(p, src, relPath)` 按稿所在目录补 `../`：`"../".repeat(depth) + dsDir`。
- 存量稿（盘上已经是展开错的 `_ds/…` 字面量，不会再被展开）由 `normalize.prepareForDisk` 的 `fixDsDepth` 收拾：只认「正好以 `dsDir/` 开头、前面没有 `../`」的那一种形状，经唯一写入口再落一次盘就修好，`steps` 里记一句「修正 @ds 相对深度」。
- `selftest` 加一块「落盘归一化 —— @ds 相对深度」六条基准：根 / 一层 / 两层子目录 × 稿里写 `@ds` / 盘上是展开过的 `_ds` / 已经对的不该再补。
- 【实测】子目录稿落盘前从子目录解析 404 → `writeDraft` 一次（steps 出现「修正 @ds 相对深度（子目录稿，补 ../）」）→ 同一路径 200。
