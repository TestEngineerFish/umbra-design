---
title: "[bug] S2 诊断面板对没有行号的诊断显示「Lundefined:undefined」"
labels: [type:bug, from:radar, p2]
---
<!-- fp: review/umbra-design/ui/S2-单稿预览壳.dc.html#diag-loc-null-check -->
来源：扫测 ｜ 证据：ui/S2-单稿预览壳.dc.html:1627-1629（`d.line !== null`）；doc/00 信封约定「line/col 定位不到就省略」（server/src/envelope.ts:5）
发现方式：Playwright 读 S2 面板文字：`W_DEAD_KEY Lundefined:undefined renderVals() 返回的 "chevStyle" 在模板里零命中`。【确证】
状态：已修 · commit b41379b

### 位置
信封约定定位不到就**省略** `line`（字段不存在 = `undefined`），S2 用 `!== null` 判断，`undefined` 漏过去拼进字符串。

### 为什么是问题
所有无定位诊断（W_DEAD_KEY 一类）在 S2 里都带一串 undefined，像是坏了。

### 影响面
S2 诊断面板。

### 怎么修
改成 `d.line != null`，`col` 同样判空。这是本地补的一行，下次 `npm run outgoing` 发包会带过去（设计侧的底稿 sha 会变，`doc/14` 已记）。
