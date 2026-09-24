---
title: "[bug] 属性面板回车落盘时发两次 set_prop，第二次撞 400「没有地址为 … 的节点」"
labels: [type:bug, from:radar, p1]
---
<!-- fp: review/umbra-studio/app/src/workbench/PropsPanel.tsx#commit-double-submit -->
来源：扫测 ｜ 证据：Playwright 请求日志同一步里两条 `→ set_prop`，一条 200 一条 400（`E_DRAFT_NOT_FOUND`）
发现方式：M7-7 扫测收尾时统计控制台错误，发现一条对不上的 400，逐请求打印时序抓到。【确证】
状态：已修 · commit a44e6d1

### 位置
`app/src/workbench/PropsPanel.tsx` 的行编辑：`onKeyDown` 的 Enter 与 `onBlur` 都调 `commit()`。

### 为什么是问题
Enter → `apply()` → `setBusy(key)` → 那一行的 `input` 变成 `disabled` → **disabled 的输入框会自动失去焦点** → 触发 `onBlur` → 第二次 `commit()`。两个请求并发：先到的那个改了节点内容，地址（内容哈希）随之变化，后到的那个拿着旧地址被服务端正确地拒了。用户侧看到的是一次改值凭空多出一条红色错误行，而改其实是成功的 —— 比失败更难判断。

### 影响面
属性面板里每一次用回车落盘。旧 vanilla 前端没有这个问题：它的输入框不 `disabled`，所以不会自动失焦。

### 怎么修
`apply()` 入口用一个 `inFlight` 集合按行去重，在途的行直接返回；请求回来再删。保留 `disabled`（它防的是重复输入）。
【实测】修前同一步两条请求（400 + 200），修后只有一条 200。
