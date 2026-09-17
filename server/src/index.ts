#!/usr/bin/env node
/** UmbraDesign MCP server · 入口。契约见 doc/00-MCP 工具契约.md
 *
 * 第一批：检索类 + validate_draft。
 * 写入类（write_draft / patch_draft）、render_check、语义 diff 在后面几批。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { envelope, toContent, ToolError, err, type Envelope } from "./envelope.js";
import { X } from "./codes.js";
import {
  TOOL_ROOT, buildProject, draftPath, listDrafts, listProjectDirs, loadProject, projectsRoot,
} from "./project.js";
import { getComponent, getIcon, getToken, listComponents, listIcons, searchTokens } from "./assets.js";
import { validateDraft } from "./validate.js";
import { patchDraft, writeDraft } from "./write.js";
import { missingRuntime } from "./normalize.js";
import { findBrowser, renderCheck } from "./render.js";
import {
  changesSince, diffDrafts, listVersions, projectChangesSince, readSnapshot,
  resolveSnapshot, toMarkdown,
} from "./history.js";

const VERSION = "0.1.0";

/** 把工具实现包成统一信封；ToolError 转成 errors，其它异常也不许漏成裸崩。 */
async function run<T>(fn: () => Promise<Envelope<T>>) {
  try {
    return toContent(await fn());
  } catch (e) {
    if (e instanceof ToolError) {
      return toContent(envelope(e.data, [e.diagnostic]));
    }
    const m = (e as Error)?.message ?? String(e);
    return toContent(envelope(null, [
      err(X.IO, "(server)", { kind: "key", name: "internal" }, `工具内部出错：${m}`),
    ]));
  }
}

const server = new McpServer(
  { name: "umbradesign", version: VERSION },
  {
    instructions: [
      "UmbraDesign —— 本地设计稿工具（.dc.html 格式）。",
      "",
      "调用顺序（doc/00 §八）：",
      "1. get_project        拿到项目路径与限额",
      "2. get_syntax_guide   拿到模板语义与写稿规则",
      "3. search_tokens      按需取取值 —— 不要试图取全量，tokens 有 1,200+ 个叶子",
      "4. list_components    看有什么能复用；要复用就 get_component(mode:'contract')",
      "5. validate_draft     静态校验，诊断带 code / 行号 / 洞名 / 改法建议",
      "",
      "所有工具返回同一个信封：{ok, data, errors, warnings, stats}。",
      "errors 非空表示这份稿不该落盘。每条诊断都有 code、定位和 fix。",
      "⚠️ ok:true 不等于稿是对的 —— 静态校验过不了渲染那一关（render_check 后续批次提供）。",
    ].join("\n"),
  }
);

// ─────────────────────────── 项目 ───────────────────────────

server.registerTool("list_projects", {
  title: "列出设计项目",
  description: "列出项目根下的所有设计项目（租户）。项目根默认 UmbraDesign/projects，可用 --projects-root 或 UMBRADESIGN_PROJECTS_ROOT 指定。",
  inputSchema: {},
}, async () => run(async () => {
  const dirs = await listProjectDirs();
  const rows = [];
  for (const d of dirs) {
    const p = await buildProject(d);
    rows.push({
      name: p.name, title: p.title, dir: p.dir,
      drafts: (await listDrafts(p)).length,
      configured: p.config.designSystem != null,
      gitEnabled: p.gitEnabled,
    });
  }
  return envelope({ projectsRoot: projectsRoot(), projects: rows }, [], { count: rows.length });
}));

server.registerTool("get_project", {
  title: "读项目配置与稿清单",
  description: "取一个设计项目的配置（设计系统路径、tokens、图标、元素数限额）与全部稿清单。",
  inputSchema: { project: z.string().describe("项目名，或项目目录名") },
}, async ({ project }) => run(async () => {
  const p = await loadProject(project);
  const drafts = (await listDrafts(p)).map((a) => a.slice(p.dir.length + 1).split("\\").join("/"));
  const diags = [];
  if (!p.config.designSystem) {
    diags.push(err(X.BAD_INPUT, p.rel, { kind: "file", name: "project.json" },
      "这个项目还没有 project.json（或没配 designSystem）",
      { fix: "照 doc/00 §3.1 写一份 project.json，指明 designSystem.dir / tokens / icons" }));
  }
  return envelope({
    name: p.name, title: p.title, dir: p.dir,
    designSystem: p.dsDir ? { dir: p.dsDir, alias: p.dsAlias } : null,
    tokens: p.config.tokens ?? null,
    icons: p.config.icons ?? null,
    extraStyles: p.config.extraStyles ?? [],
    limits: p.limits,
    gitEnabled: p.gitEnabled,
    drafts,
  }, diags, { drafts: drafts.length });
}));

// ─────────────────────── 设计系统检索 ───────────────────────

server.registerTool("search_tokens", {
  title: "检索设计 token",
  description: "按路径或取值模糊检索 token。**没有 list_tokens** —— tokens 有 1,200+ 个叶子，全量返回会吃掉上下文。长散文类判据会截断，用 get_token 取全文。",
  inputSchema: {
    project: z.string(),
    query: z.string().describe("路径片段或取值片段，如 danger / #E8590C / 行高"),
    limit: z.number().int().min(1).max(200).optional(),
  },
}, async ({ project, query, limit }) => run(async () => {
  const p = await loadProject(project);
  const r = await searchTokens(p, query, limit ?? 30);
  return envelope({ query, hits: r.hits }, [], { total: r.total, returned: r.hits.length, truncated: r.truncated });
}));

server.registerTool("get_token", {
  title: "取 token 全文",
  description: "按点号路径取单个 token 的完整取值，或取整棵子树（不截断）。",
  inputSchema: { project: z.string(), path: z.string().describe("点号路径，如 color.light.bg 或 color.light") },
}, async ({ project, path }) => run(async () => {
  const p = await loadProject(project);
  return envelope(await getToken(p, path));
}));

server.registerTool("list_icons", {
  title: "列出图标",
  description: "按名字 / 中文名 / 分组 / 用途检索图标，返回名字与元数据（不含 path 数据）。",
  inputSchema: { project: z.string(), query: z.string().optional(), limit: z.number().int().min(1).max(300).optional() },
}, async ({ project, query, limit }) => run(async () => {
  const p = await loadProject(project);
  const r = await listIcons(p, query, limit ?? 60);
  return envelope({ viewBox: r.viewBox, icons: r.icons }, [], { total: r.total, truncated: r.truncated });
}));

server.registerTool("get_icon", {
  title: "取图标",
  description: "取一个图标的 SVG 内容（body + viewBox + strokeWidth），可直接贴进稿子。",
  inputSchema: { project: z.string(), name: z.string() },
}, async ({ project, name }) => run(async () => {
  const p = await loadProject(project);
  return envelope(await getIcon(p, name));
}));

// ───────────────────────── 组件契约 ─────────────────────────

server.registerTool("list_components", {
  title: "列出组件与页稿",
  description: "列出项目里所有稿：名字、文件、元素数、props 签名、状态清单。只给签名，要全文用 get_component。",
  inputSchema: { project: z.string() },
}, async ({ project }) => run(async () => {
  const p = await loadProject(project);
  const list = await listComponents(p);
  return envelope({ components: list }, [], {
    total: list.length,
    withProps: list.filter((c) => c.props.length > 0).length,
  });
}));

server.registerTool("get_component", {
  title: "取组件契约或全文",
  description: "mode='contract' 给 props 与状态清单；mode='full' 给源码全文（可能很大，先用 contract）。",
  inputSchema: {
    project: z.string(), name: z.string(),
    mode: z.enum(["contract", "full"]).optional(),
  },
}, async ({ project, name, mode }) => run(async () => {
  const p = await loadProject(project);
  return envelope(await getComponent(p, name, mode ?? "contract"));
}));

// ───────────────────────── 写稿规则 ─────────────────────────

const GUIDES: Record<string, { file: string; note: string }> = {
  template: { file: "03-渲染与交互逻辑.md", note: "模板语言的精确语义（框架语义，与项目无关）" },
  logic: { file: "03-渲染与交互逻辑.md", note: "逻辑类契约与渲染时序" },
  interaction: { file: "06-写稿规则.md", note: "本项目的写法约定（交互、规模、收尾）" },
  checklist: { file: "06-写稿规则.md", note: "开工前与收尾的自检" },
  tokens: { file: "06-写稿规则.md", note: "取值从哪来、@ds 别名怎么写" },
};

server.registerTool("get_syntax_guide", {
  title: "取模板语义与写稿规则",
  description: "取写稿要遵守的规则原文。topic: template | logic | interaction | checklist | tokens。写第一份稿之前先取一次。",
  inputSchema: { topic: z.enum(["template", "logic", "interaction", "checklist", "tokens"]) },
}, async ({ topic }) => run(async () => {
  const g = GUIDES[topic] as { file: string; note: string };
  const abs = join(TOOL_ROOT, "doc", g.file);
  const text = await readFile(abs, "utf8");
  return envelope({ topic, note: g.note, source: `doc/${g.file}`, text }, [], { bytes: text.length });
}));

// ───────────────────────── 静态校验 ─────────────────────────

server.registerTool("validate_draft", {
  title: "静态校验一份稿",
  description: [
    "对一份 .dc.html 做静态校验。errors 非空 = 不该落盘。",
    "查：标签配平、逻辑类能否编译、表达式洞、洞与 renderVals 键的正反向审计、",
    "每条 return 路径是否给全、dc-import 能否解析、注释里的标签字面量、",
    "helmet 重复引用、fixed+backdrop-filter、hint-*、未知标签、元素数阈值。",
    "⚠️ 全绿不等于能渲染 —— 唯一的证据是真的画出来了（render_check，后续批次）。",
  ].join("\n"),
  inputSchema: {
    project: z.string(),
    path: z.string().describe("相对项目根的稿路径，如 日志.dc.html"),
  },
}, async ({ project, path }) => run(async () => {
  const p = await loadProject(project);
  const abs = draftPath(p, path);
  const src = await readFile(abs, "utf8");
  const { diags, stats } = validateDraft(p, path, src, path);
  return envelope({ project: p.name, path }, diags, stats);
}));

// ───────────────────────── 写入（唯一写入口） ─────────────────────────

server.registerTool("write_draft", {
  title: "整份写一份稿（唯一写入口）",
  description: [
    "把一份 .dc.html 整份落盘。文件不得由别的途径写入。",
    "落盘前做三件确定性改写：归一化（UTF-8 无 BOM / LF / 末尾单换行）、",
    "@ds 别名展开成真实相对路径、注入 __resources 离线映射（幂等）。",
    "然后跑一遍 validate_draft：**有 error 就拒绝落盘**并原样返回诊断。",
    "落盘后把运行时三件套分发到稿所在目录，并写一份语义快照。",
    "",
    "写法上你只管两件事：ds 路径写 @ds/... 别名；不要自己写 __resources 块。",
  ].join("\n"),
  inputSchema: {
    project: z.string(),
    path: z.string().describe("相对项目根的路径，必须以 .dc.html 结尾"),
    content: z.string().describe("完整文件内容"),
    kind: z.enum(["page", "component"]).optional(),
  },
}, async ({ project, path, content, kind }) => run(async () => {
  const p = await loadProject(project);
  const r = await writeDraft(p, path, content, kind ?? "page");
  return envelope(r.outcome, r.diags, r.stats);
}));

server.registerTool("patch_draft", {
  title: "增量改一份稿",
  description: [
    "按 {old, new} 替换。改一行不必重传整份文件。",
    "old 必须唯一命中（含空白逐字一致），否则返回 E_PATCH_ANCHOR，",
    "并把文件里最接近的几段回给你 —— 照它改 old，一轮就能对。",
    "替换完走的是 write_draft 的同一条路：改写、校验、落盘、快照。",
  ].join("\n"),
  inputSchema: {
    project: z.string(),
    path: z.string(),
    edits: z.array(z.object({
      old: z.string().describe("要替换的原文，逐字一致"),
      new: z.string().describe("替换成什么；空串表示删除"),
      count: z.number().int().min(1).optional().describe("期望命中几次，默认 1"),
    })).min(1),
  },
}, async ({ project, path, edits }) => run(async () => {
  const p = await loadProject(project);
  const r = await patchDraft(p, path, edits);
  return envelope(r.outcome, r.diags, r.stats);
}));

server.registerTool("check_runtime", {
  title: "查稿所在目录缺不缺运行时",
  description: "列出项目里每个放稿的目录缺哪些运行时文件（support.js 与两个 React UMD）。缺了直接打开会白屏。write_draft 会自动补，这个工具只报告。",
  inputSchema: { project: z.string() },
}, async ({ project }) => run(async () => {
  const p = await loadProject(project);
  const drafts = await listDrafts(p);
  const byDir = new Map<string, string[]>();
  for (const abs of drafts) {
    const miss = missingRuntime(abs);
    if (miss.length) byDir.set(abs.slice(0, abs.lastIndexOf("/")).slice(p.dir.length + 1) || ".", miss);
  }
  return envelope({ missing: [...byDir.entries()].map(([dir, files]) => ({ dir, files })) },
    [], { dirsMissing: byDir.size, draftsScanned: drafts.length });
}));

// ───────────────────────── 渲染体检 ─────────────────────────

server.registerTool("render_check", {
  title: "真实渲染体检一份稿",
  description: [
    "起一个本地静态服务 + headless Chromium，真的把稿打开一次。",
    "**这是唯一的验收证据** —— validate_draft 全绿不等于能渲染（doc/04 §2.2）。",
    "判活只认 1+1：截图会骗人，一张不对的截图和坏掉的页面在屏上长得一样。",
    "",
    "默认【断网】跑（allowNetwork=false）：任何外部请求都会被拦下并回报 ——",
    "交付要能在内网机器上打开，所以这是常态检查，不是可选项。",
    "",
    "回报：alive / 节点数 / 渲染耗时 / 渲染后还留着的洞 / 控制台告警 /",
    "取不到的资源 / 外部请求 / 真实解析出的样式表与它的 cssRules 条数 / 截图路径。",
  ].join("\n"),
  inputSchema: {
    project: z.string(),
    path: z.string(),
    width: z.number().int().min(320).max(3840).optional(),
    height: z.number().int().min(320).max(2400).optional(),
    allowNetwork: z.boolean().optional().describe("默认 false。置 true 才允许外部请求"),
    timeoutMs: z.number().int().min(3000).max(120000).optional(),
    screenshot: z.boolean().optional(),
  },
}, async ({ project, path, width, height, allowNetwork, timeoutMs, screenshot }) => run(async () => {
  const p = await loadProject(project);
  const r = await renderCheck(p, path, { width, height, allowNetwork, timeoutMs, screenshot });
  return envelope(r.result, r.diags, {
    alive: r.result.alive, nodeCount: r.result.nodeCount, renderMs: r.result.renderMs,
    unresolvedHoles: r.result.unresolvedHoles.length,
    externalRequests: r.result.externalRequests.length,
  });
}));

server.registerTool("check_browser", {
  title: "查渲染体检用的浏览器",
  description: "报告 render_check 会用哪个浏览器可执行文件。找不到时说清怎么配（不会自动下载浏览器）。",
  inputSchema: {},
}, async () => run(async () => {
  const f = findBrowser();
  const diags = f ? [] : [err(X.IO, "(server)", { kind: "file", name: "chromium" },
    "找不到可用的 Chromium / Chrome",
    { fix: "装一个 Chrome，或把可执行文件路径写进环境变量 UMBRADESIGN_CHROMIUM" })];
  return envelope({ browser: f, autoDownload: false }, diags);
}));

// ───────────────────────── 变更交付（doc/07）─────────────────────────

server.registerTool("list_versions", {
  title: "列出一份稿的版本",
  description: "列出这份稿的快照版本序列（v1、v2 …），以及项目有没有 git 兜底。版本在每次 write_draft 落盘时递增，按稿独立计数。",
  inputSchema: { project: z.string(), path: z.string() },
}, async ({ project, path }) => run(async () => {
  const p = await loadProject(project);
  const vs = await listVersions(p, path);
  return envelope({ path, versions: vs, latest: vs[vs.length - 1] ?? null, gitEnabled: p.gitEnabled },
    [], { count: vs.length });
}));

server.registerTool("snapshot_draft", {
  title: "取一份稿的语义快照",
  description: "把 .dc.html 抽成归一化的语义快照（props / state / 状态分支 / 列表 / 子组件 / 用到的 token / 文案 / 节点与指纹）。write_draft 会自动存快照，这个工具用来看某一版的快照内容。",
  inputSchema: {
    project: z.string(), path: z.string(),
    version: z.string().optional().describe("v<N> / git ref / 「工作区」。默认「工作区」"),
  },
}, async ({ project, path, version }) => run(async () => {
  const p = await loadProject(project);
  const snap = await resolveSnapshot(p, path, version ?? "工作区");
  return envelope(snap, [], {
    nodes: snap.nodes.length, texts: snap.texts.length,
    tokensUsed: snap.tokensUsed.length, branches: snap.branches.length,
  });
}));

server.registerTool("diff_drafts", {
  title: "两版之间的语义变更清单",
  description: [
    "对两版做**语义** diff，不是文本 diff —— 对 inline-style HTML 做文本 diff 没用（doc/07 §一）。",
    "四级分类，唯一目的是回答「要不要动代码」：",
    "  L1 契约 → 必须改代码（props / 状态分支 / 事件名 / 子组件契约变了）",
    "  L2 取值 → 照抄新值（颜色 / 间距 / 字号 / token 引用）",
    "  L3 文案 → 改字符串",
    "  L4 等价 → 无需处理",
    "节点配对不靠路径（靠指纹 + LCS），所以在模板中间插一个元素不会把后面全报成变更。",
    "from / to 可以是 v<N>、git ref、或「工作区」。",
  ].join("\n"),
  inputSchema: {
    project: z.string(), path: z.string(),
    from: z.string().describe("v<N> / git ref / 「工作区」"),
    to: z.string().optional().describe("默认最新的一版快照"),
    markdown: z.boolean().optional().describe("true 时附一份给人看的纯文本清单"),
  },
}, async ({ project, path, from, to, markdown }) => run(async () => {
  const p = await loadProject(project);
  const d = await diffDrafts(p, path, { from, to });
  const data: Record<string, unknown> = { ...d };
  if (markdown) data.markdown = toMarkdown(d);
  return envelope(data, [], { ...d.counts, total: d.changes.length });
}));

server.registerTool("get_changes_since", {
  title: "跨版本净变更",
  description: [
    "回答「我实现的是 v217，现在最新 v221，我要改什么」—— **不是把四份 diff 拼起来**。",
    "合并规则：同一属性多次变化只报最终值；加了又删不报；删了又加回同值不报；级别取最高。",
    "不给 path 就出整个项目的汇总，按稿分节。",
  ].join("\n"),
  inputSchema: {
    project: z.string(),
    since: z.string().describe("起点版本，如 v3"),
    path: z.string().optional().describe("不给就整个项目"),
    markdown: z.boolean().optional(),
  },
}, async ({ project, since, path, markdown }) => run(async () => {
  const p = await loadProject(project);
  if (path) {
    const d = await changesSince(p, path, since);
    const data: Record<string, unknown> = { ...d };
    if (markdown) data.markdown = toMarkdown(d);
    return envelope(data, [], { ...d.counts, spans: d.spans.length });
  }
  const drafts = (await listDrafts(p)).map((a) => a.slice(p.dir.length + 1).split("\\").join("/"));
  const rows = await projectChangesSince(p, drafts, since);
  const withChange = rows.filter((r) => r.diff && r.diff.changes.length);
  const data = {
    since,
    drafts: rows.map((r) => ({
      path: r.path,
      counts: r.diff?.counts ?? null,
      conclusion: r.diff ? undefined : r.note,
      changes: r.diff?.changes ?? [],
      spans: r.diff?.spans ?? [],
    })),
    markdown: markdown ? withChange.map((r) => toMarkdown(r.diff!)).join("\n\n———\n\n") : undefined,
  };
  return envelope(data, [], { draftsScanned: rows.length, draftsChanged: withChange.length });
}));

// ──────────────────────────── 启动 ────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[umbradesign] v${VERSION} 已启动 · 项目根 ${projectsRoot()}\n`);
