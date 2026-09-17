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
import { serveStart, serveStatus, serveStop } from "./serve.js";
import { buildIndex, collectIndex } from "./indexpage.js";
import { locateNode } from "./locate.js";
import { revertTo, setProp } from "./edit.js";

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
      "6. write_draft        唯一写入口（归一化 / @ds 展开 / __resources 注入都在这里）",
      "7. render_check       真浏览器渲染体检 —— 唯一的验收证据",
      "8. build_index + serve_start   生成入口页并起本地 http，人要看稿走这条",
      "",
      "所有工具返回同一个信封：{ok, data, errors, warnings, stats}。",
      "errors 非空表示这份稿不该落盘。每条诊断都有 code、定位和 fix。",
      "⚠️ ok:true 只说明静态校验过了，不等于稿能渲染出来 —— 验收必须看 render_check。",
      "⚠️ 带 dc-import 的稿双击打不开（Chrome 不允许对 file:// 发 fetch），必须走 serve_start。",
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

// ───────────────────── 形态 A：入口页与静态服务（doc/01 §4.2）─────────────────────

server.registerTool("serve_start", {
  title: "起本地静态服务",
  description: [
    "把项目目录起成本地静态服务，浏览器里打开就能看。",
    "**带 dc-import 的稿只能这样看** —— Chrome 不允许对 file:// 发 fetch，双击打不开（doc/05 §4.2）。",
    "服务活在 MCP server 进程里，起一次就一直开着；不传 port 让系统分配。",
    "",
    "它还挂着一个本地 JSON API（/__ud/*），给工具界面用：",
    "  GET  locate / validate / changes / drafts",
    "  POST set_prop / revert",
    "**顺序要紧：先 serve_start 再 build_index** —— 令牌在 build_index 时注入壳页面，",
    "反了的话壳拿不到令牌，诊断与点选面板就是空的（doc/00 §二十）。",
  ].join("\n"),
  inputSchema: { project: z.string(), port: z.number().int().min(1024).max(65535).optional() },
}, async ({ project, port }) => run(async () => {
  const p = await loadProject(project);
  const s = await serveStart(p, port);
  const diags = s.indexExists ? [] : [err(X.IO, p.rel, { kind: "file", name: "index.dc.html" },
    "项目根还没有 index.dc.html，打开根路径会 404",
    { fix: "先调 build_index 生成入口页（它同时会把本地 API 的令牌注进壳页面）" })];
  return envelope(s, diags);
}));

server.registerTool("serve_stop", {
  title: "停掉本地静态服务",
  description: "停掉某个项目的静态服务。",
  inputSchema: { project: z.string() },
}, async ({ project }) => run(async () => {
  const p = await loadProject(project);
  return envelope({ project: p.name, ...serveStop(p.name) });
}));

server.registerTool("serve_status", {
  title: "看正在跑的静态服务",
  description: "列出当前进程里正在跑的静态服务：地址、端口、起来多久、被请求过几次。",
  inputSchema: {},
}, async () => run(async () => {
  const list = serveStatus();
  return envelope({ servers: list }, [], { count: list.length });
}));

// ───────────────────── 节点定位与属性级编辑（三层修改的地基） ─────────────────────

server.registerTool("locate_node", {
  title: "把预览里点中的节点对回源码",
  description: [
    "给一个节点地址，回报它在源码哪一行、开标签是什么、每一项能不能直接改。",
    "",
    "地址从预览的 DOM 里取（两个属性都已经在那儿，不用问服务端）：",
    "  const host = el.closest('[data-sc-name]');      // file：哪份稿",
    "  const id   = el.getAttribute('data-ud-node');   // node：稿里哪个节点",
    "",
    "回报里的 slots 是这个节点上每一项可改的东西（样式声明 / 属性 / 文本），",
    "editable=true 才是人能直接拖的；false 的话 note 里写了改法（改 renderVals 里哪个键，",
    "还是这个值由调用方传入、或者干脆是算出来的只能改逻辑类）。",
    "",
    "⚠️ 地址是内容哈希：节点**自己**被改过之后地址会变，重新取一次。别处怎么改都不影响。",
    "⚠️ inList=true 表示它在 sc-for 里 —— 改这一处会影响渲染出的每一行。",
  ].join("\n"),
  inputSchema: {
    project: z.string(),
    file: z.string().describe("稿的相对路径，或预览里 data-sc-name 给的组件名"),
    node: z.string().describe("data-ud-node 的值"),
  },
}, async ({ project, file, node }) => run(async () => {
  const p = await loadProject(project);
  const r = await locateNode(p, file, node);
  return envelope(r, [], {
    slots: r.slots.length,
    editableSlots: r.slots.filter((s) => s.editable).length,
    inList: r.inList,
    holeAuditSkipped: r.auditSkipped,
  });
}));

server.registerTool("set_prop", {
  title: "改一个节点上的一个属性",
  description: [
    "按节点地址改**一处**：一条样式声明、一个属性、或紧跟开标签的那段文本。",
    "其余字节不动。给人拖滑块 / 选颜色用，也给模型做小修用。",
    "",
    "**目标是洞就会被拒绝**，并告诉你该改 renderVals 里哪个键 ——",
    "把洞覆盖成字面量等于把一个联动的值改成死值，那是静默破坏，所以不做。",
    "先调 locate_node 看 slots[].editable，别猜。",
    "",
    "value 传空串 = 删掉这条样式声明 / 这个属性。",
    "",
    "⚠️ 一次调用 = 一次落盘 = 一个版本。**拖动的中间态不要调这个** ——",
    "用运行时自带的 window.__dcSetProps(name, overrides) 做实时预览，松手才调一次。",
    "⚠️ 返回里的 newNode 是改完之后的新地址（开标签变了，哈希就变了），界面要用它接着调。",
  ].join("\n"),
  inputSchema: {
    project: z.string(),
    file: z.string().describe("稿的相对路径，或预览里 data-sc-name 给的组件名"),
    node: z.string().describe("data-ud-node 的值"),
    kind: z.enum(["style", "attr", "text"]),
    name: z.string().describe("style 时是 CSS 属性名；attr 时是属性名；text 时随便填，如 (文本)"),
    value: z.string().describe("新值。空串 = 删掉"),
  },
}, async ({ project, file, node, kind, name, value }) => run(async () => {
  const p = await loadProject(project);
  const r = await setProp(p, file, node, kind, name, value);
  return envelope(r, [], {
    written: r.write.written,
    version: r.write.version,
    newNode: r.newNode,
    bytesDelta: r.write.bytes,
  });
}));

server.registerTool("revert_to", {
  title: "把一份稿退回某一版",
  description: [
    "把 v<N> 的源码作为**新的一版**落盘。历史只增不改 ——",
    "changelog 会照常记下这次回退，实现侧看得见「退回到了哪一版」。",
    "悄悄改历史等于变更交付有个洞（doc/07）。",
    "",
    "先用 list_versions 看有哪些版本。",
    "源码副本是从 §18.2 那一版功能上线之后才开始存的，更老的版本只能靠 git 兜底。",
  ].join("\n"),
  inputSchema: {
    project: z.string(),
    file: z.string(),
    version: z.string().describe("如 v3"),
  },
}, async ({ project, file, version }) => run(async () => {
  const p = await loadProject(project);
  const r = await revertTo(p, file, version);
  return envelope(r, [], { written: r.write.written, newVersion: r.write.version, restored: r.restored });
}));

server.registerTool("build_index", {
  title: "生成项目入口页",
  description: [
    "扫项目目录，把工具界面部署进项目并注入数据：",
    "  index.dc.html                 —— 入口页（设计侧 ui/S1 那份）",
    "  S2…S5-*.dc.html               —— 其余壳页面，必须与稿同源才能点选/调 API",
    "  .umbradesign/index-data.json  —— 数据（doc/08 S1 的形状）",
    "  .umbradesign/select-bridge.js —— 预览点选桥，由壳注入 iframe",
    "  _ds-tool/tokens.css           —— 工具皮肤",
    "",
    "⚠️ **先 serve_start 再 build_index**：本地 API 的令牌在这一步注入壳页面。",
    "反了的话壳拿不到令牌，诊断与点选面板是空的（返回里 api:false 就是这个情况）。",
    "",
    "每份稿带上：类型、元素数、最新版本、更新时间、缩略图（有的话）、",
    "健康状态与诊断条数、演示态清单、引用与被引用关系。",
    "入口页优先用设计侧那份 ui/S1-稿件索引.dc.html；它缺失时才用内置过渡页兜底",
    "（返回里的 indexSource 写明用了哪个）。",
  ].join("\n"),
  inputSchema: { project: z.string(), serve: z.boolean().optional().describe("true 时顺手起静态服务并回地址") },
}, async ({ project, serve }) => run(async () => {
  const p = await loadProject(project);
  const url = serve ? (await serveStart(p)).url : null;
  const r = await buildIndex(p, url);
  return envelope(r, [], { drafts: r.drafts, ...r.byHealth });
}));

server.registerTool("get_index_data", {
  title: "只取索引数据，不落盘",
  description: "按 doc/08 S1 的数据契约返回项目的稿件清单，不写任何文件。给要自己渲染索引的调用方用。",
  inputSchema: { project: z.string() },
}, async ({ project }) => run(async () => {
  const p = await loadProject(project);
  const d = await collectIndex(p);
  return envelope(d, [], { drafts: d.drafts.length });
}));

// ──────────────────────────── 启动 ────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[umbradesign] v${VERSION} 已启动 · 项目根 ${projectsRoot()}\n`);
