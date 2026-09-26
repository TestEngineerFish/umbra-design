import { z } from "zod";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { envelope } from "../envelope.js";
import { draftPath, TOOL_ROOT } from "../project.js";
import { locateNode, resolveDraft } from "../locate.js";
/* ⚠️ 注意：`server/src/edit.ts` 是**改一处**的实现，本文件是 `cap/edit.ts`（能力声明）。
   同名不同层，别看串了 —— 实现在 `src/edit.ts`，声明在这儿。 */
import { revertTo, setProp, type SlotKind } from "../edit.js";
import { patchDraft, writeDraft } from "../write.js";
import { validateDraft } from "../validate.js";
import { readCheck, sha256 } from "../check.js";
import { workspaceState } from "../history.js";
import { defineCap } from "./registry.js";
import { originOf, type CapCtx } from "./types.js";

/** 稿件的读 / 校验 / 写 / 改一处 / 回退（M11-7 第四批）。
 *
 *  **这一组是核心中的核心** —— `write_draft` 就是纪律① 那条唯一写入口：
 *  归一化 → `@ds` 展开 → `__resources` 注入 → 校验 → 落盘 → 快照 → changelog。
 *  绕过它写出来的页会因为缺 `__resources` 而在断网时白屏（`00` §十五 实测踩过）。
 *
 *  ⚠️ 搬这一组时**整段读了两侧实现**，没有用 grep 拼 —— 上一批就是按片段读把
 *  首页的缩略图搬丢了（`00` §92.1）。
 */
const p = (c: CapCtx) => c.project!;

/** 稿路径：**一律走 `resolveDraft`**（宽松，认相对路径也认文件名）。
 *  MCP 侧原来直接用 `draftPath`（严格），HTTP 侧用 `resolveDraft` ——
 *  同一件事两种严格度，而宽松那种是超集，没有理由不统一。 */
const rel = (c: CapCtx, file: string) => resolveDraft(p(c), file);

defineCap({
  name: "validate_draft", title: "静态校验一份稿", scope: "project",
  summary: [
    "对一份 .dc.html 做静态校验。**errors 非空 = 不该落盘**。",
    "查：标签配平、逻辑类能否编译、表达式洞、洞与 renderVals 键的正反向审计、",
    "每条 return 路径是否给全、dc-import 能否解析、注释里的标签字面量、",
    "helmet 重复引用、fixed+backdrop-filter、hint-*、未知标签、元素数阈值。",
    "⚠️ **全绿不等于能渲染** —— 唯一的证据是真的画出来了（render_check）。",
  ].join("\n"),
  input: { file: z.string().describe("稿的相对路径或文件名") },
  http: { route: "validate", method: "GET" },
  run: async ({ file }, c) => {
    const proj = p(c);
    const r = await rel(c, file);
    const src = await readFile(draftPath(proj, r), "utf8");
    const v = validateDraft(proj, r, src, r);
    /* ⚠️ 界面要的那三样（上次体检读数 / 体检是不是过期了 / 工作区状态）
       **原来只有 HTTP 侧给**。顶栏要显示「上次体检 · 耗时 · 节点数」和
       「我看的是不是盘上那一版」，不给它就只能写死演示数字（`00` §21.3 的教训）。
       模型那边不需要这三样：它要体检就直接调 `render_check`。 */
    if (c.via !== "http") return envelope({ project: proj.name, file: r }, v.diags, v.stats);
    const chk = await readCheck(proj, r);
    return envelope({
      file: r, diags: v.diags, stats: v.stats,
      check: chk, checkStale: !!chk && chk.srcSha256 !== sha256(src),
      workspace: await workspaceState(proj, r, src),
    }, [], v.stats);
  },
});

defineCap({
  name: "read_draft", title: "读一份稿的源码", scope: "project",
  summary: "整份读出来（带字节数和行数）。要改一处用 patch_draft，别整份重写。",
  input: { file: z.string() },
  http: { route: "source", method: "GET" },
  run: async ({ file }, c) => {
    const proj = p(c);
    const r = await rel(c, file);
    const src = await readFile(draftPath(proj, r), "utf8");
    return envelope({ file: r, bytes: Buffer.byteLength(src, "utf8"), lines: src.split("\n").length, source: src });
  },
});

defineCap({
  name: "write_draft", title: "整份写一份稿（唯一写入口）", scope: "project",
  summary: [
    "把一份 .dc.html 整份落盘。**文件不得由别的途径写入。**",
    "落盘前做三件确定性改写：归一化（UTF-8 无 BOM / LF / 末尾单换行）、",
    "@ds 别名展开成真实相对路径、注入 __resources 离线映射（幂等）。",
    "然后跑一遍 validate_draft：**有 error 就拒绝落盘**并原样返回诊断。",
    "落盘后把运行时三件套分发到稿所在目录，并写一份语义快照。",
    "",
    "写法上你只管两件事：ds 路径写 @ds/... 别名；不要自己写 __resources 块。",
  ].join("\n"),
  input: {
    path: z.string().describe("相对项目根的路径，必须以 .dc.html 结尾"),
    content: z.string().describe("完整文件内容"),
    kind: z.enum(["page", "component"]).optional(),
    expectedSourceSha256: z.string().length(64).optional().describe("并发保护：预期盘上源码 sha256，不匹配就拒绝"),
  },
  /* **不给插件面**：插件写 `.dc.html` 要走的是它自己那条路（`plugin/host.ts` 的白名单里
     只有泛型文件层）。设计稿的写入口牵着快照、changelog、资源注入，
     开给插件等于把产品最深的那层格式交出去。 */
  faces: ["mcp", "http"],
  http: { route: "draft_write", method: "POST" },
  run: async ({ path, content, kind, expectedSourceSha256 }, c) => {
    const r = await writeDraft(p(c), path, content, kind ?? "page", undefined,
      expectedSourceSha256 ? { expectedSourceSha256 } : undefined);
    return envelope(r.outcome, r.diags, r.stats);
  },
});

defineCap({
  name: "patch_draft", title: "增量改一份稿", scope: "project",
  summary: [
    "按 {old, new} 替换。改一行不必重传整份文件。",
    "old 必须唯一命中（含空白逐字一致），否则返回 E_PATCH_ANCHOR，",
    "并把文件里最接近的几段回给你 —— 照它改 old，一轮就能对。",
    "替换完走的是 write_draft 的同一条路：改写、校验、落盘、快照。",
  ].join("\n"),
  input: {
    path: z.string(),
    edits: z.array(z.object({
      old: z.string().describe("要替换的原文，逐字一致"),
      new: z.string().describe("替换成什么；空串表示删除"),
      count: z.number().int().min(1).optional().describe("期望命中几次，默认 1"),
    })).min(1),
    expectedSourceSha256: z.string().length(64).optional().describe("并发保护：预期盘上源码 sha256，不匹配就拒绝"),
  },
  faces: ["mcp", "http"],
  http: { route: "draft_patch", method: "POST" },
  run: async ({ path, edits, expectedSourceSha256 }, c) => {
    const r = await patchDraft(p(c), path, edits, expectedSourceSha256 ? { expectedSourceSha256 } : undefined);
    return envelope(r.outcome, r.diags, r.stats);
  },
});

defineCap({
  name: "locate_node", title: "把预览里点中的节点对回源码", scope: "project",
  summary: [
    "给一个节点地址，回报它在源码哪一行、开标签是什么、每一项能不能直接改。",
    "地址从预览的 DOM 里取：`el.closest('[data-sc-name]')` 给 file，`data-ud-node` 给 node。",
    "slots 里 `editable=true` 才是能直接改的；false 的话 note 写了改法。",
    "⚠️ 地址是内容哈希：节点**自己**被改过之后地址会变，重新取一次。",
    "⚠️ `inList=true` 表示它在 sc-for 里 —— 改这一处会影响渲染出的每一行。",
  ].join("\n"),
  input: {
    file: z.string().describe("稿的相对路径，或预览里 data-sc-name 给的组件名"),
    node: z.string().describe("data-ud-node 的值"),
  },
  http: { route: "locate", method: "GET" },
  run: async ({ file, node }, c) => {
    const r = await locateNode(p(c), file, node);
    return envelope(r, [], {
      slots: r.slots.length,
      editableSlots: r.slots.filter((s) => s.editable).length,
      inList: r.inList,
      holeAuditSkipped: r.auditSkipped,
    });
  },
});

defineCap({
  name: "set_prop", title: "改一个节点上的一个属性", scope: "project",
  summary: [
    "按节点地址改**一处**：一条样式声明、一个属性、或紧跟开标签的那段文本。其余字节不动。",
    "**目标是洞就会被拒绝**，并告诉你该改 renderVals 里哪个键 ——",
    "把洞覆盖成字面量等于把一个联动的值改成死值，那是静默破坏。先看 locate_node 的 slots[].editable。",
    "value 传空串 = 删掉这条样式声明 / 这个属性。",
    "⚠️ 一次调用 = 一次落盘 = 一个版本。**拖动的中间态不要调这个** ——",
    "用 `window.__dcSetProps(name, overrides)` 做实时预览，松手才调一次。",
    "⚠️ 返回里的 newNode 是改完之后的新地址，界面要用它接着调。",
  ].join("\n"),
  input: {
    file: z.string(), node: z.string(),
    kind: z.enum(["style", "attr", "text"]),
    name: z.string().describe("style 时是 CSS 属性名；attr 时是属性名；text 时随便填"),
    value: z.string().describe("新值。空串 = 删掉"),
  },
  http: { route: "set_prop", method: "POST" },
  run: async ({ file, node, kind, name, value }, c) => {
    /* ⚠️ HTTP 侧原来**写死** `"人手改"`，MCP 侧不传（默认 AI）。
       这正是 `via` 该管的事 —— 写死的那一行让「谁改的」跟着门面走却没人说得清，
       而将来插件也会调它，写死就永远记成「人手改」了。 */
    const r = await setProp(p(c), file, node, kind as SlotKind, name, value, originOf(c.via));
    return envelope(r, [], {
      written: r.write.written, version: r.write.version,
      newNode: r.newNode, bytesDelta: r.write.bytes,
    });
  },
});

defineCap({
  name: "revert_to", title: "把一份稿退回某一版", scope: "project",
  summary: [
    "把 v<N> 的源码作为**新的一版**落盘。**历史只增不改** ——",
    "changelog 会照常记下这次回退，实现侧看得见「退回到了哪一版」。悄悄改历史等于变更交付有个洞（doc/07）。",
    "先用 list_versions 看有哪些版本。",
  ].join("\n"),
  input: { file: z.string(), version: z.string().describe("如 v3") },
  http: { route: "revert", method: "POST" },
  run: async ({ file, version }, c) => {
    const r = await revertTo(p(c), file, version, originOf(c.via));
    return envelope(r, [], { written: r.write.written, newVersion: r.write.version, restored: r.restored });
  },
});

/** 写稿规则的出处。**不属于任何项目** —— 它是工具自带的文档 */
const GUIDES: Record<string, { file: string; note: string }> = {
  template: { file: "02-dc-html 格式说明.md", note: "模板语法与结构" },
  logic: { file: "03-渲染与交互逻辑.md", note: "逻辑类、渲染期与交互期" },
  interaction: { file: "03-渲染与交互逻辑.md", note: "同 logic" },
  checklist: { file: "06-写稿规则.md", note: "写稿前后的自查清单" },
  tokens: { file: "06-写稿规则.md", note: "取值怎么用 tokens" },
};

defineCap({
  name: "get_syntax_guide", title: "取模板语义与写稿规则", scope: "global",
  summary: "取写稿要遵守的规则原文。**写第一份稿之前先取一次** —— 这些规则每一条都是实测踩出来的。",
  input: { topic: z.enum(["template", "logic", "interaction", "checklist", "tokens"]) },
  http: { route: "syntax_guide", method: "GET" },
  run: async ({ topic }) => {
    const g = GUIDES[topic]!;
    const text = await readFile(join(TOOL_ROOT, "doc", g.file), "utf8");
    return envelope({ topic, note: g.note, source: `doc/${g.file}`, text }, [], { bytes: text.length });
  },
});
