#!/usr/bin/env node
/** Umbra Studio MCP server · 入口。契约见 doc/00-MCP 工具契约.md
 *
 * 第一批：检索类 + validate_draft。
 * 写入类（write_draft / patch_draft）、render_check、语义 diff 在后面几批。
 */
import { readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { existsSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { envelope, toContent, ToolError, err, type Envelope } from "./envelope.js";
import { X } from "./codes.js";
import {
  TOOL_ROOT, buildProject, createProject, createDraft, duplicateDraft, createFolder,
  updateProject, archiveProject, deleteProject,
  draftPath, listDrafts, listProjectDirs, loadProject, projectsRoot,
  type Project,
} from "./project.js";
import { getComponent, getIcon, getToken, listComponents, listIcons, searchTokens } from "./assets.js";
import { validateDraft } from "./validate.js";
import { patchDraft, writeDraft } from "./write.js";
import { missingRuntime } from "./normalize.js";
import { getAiConfig, setAiConfig, getChannelA, getChannelB, type AiConfig } from "./ai_config.js";
import { chat, type ToolDef, type ToolCall, type ChatMessage } from "./provider.js";
import { createChat, loadChat, saveChat, listChats, deleteChat, addMessage, type ChatSession, type ChatEntry } from "./chat.js";
import { findBrowser, renderCheck } from "./render.js";
import { runChatSend } from "./chat_run.js";
import { listComments } from "./comments.js";
import {
  changesSince, diffDrafts, listVersions, projectChangesSince, readSnapshot,
  resolveSnapshot, toMarkdown,
} from "./history.js";
import { serveStart, serveStatus, serveStop } from "./serve.js";
import { buildIndex, collectIndex, isToolPage } from "./indexpage.js";
import { listFiles, readAnyFile, writeAnyFile, moveFile, listSnapshotMeta } from "./files.js";
import { locateNode } from "./locate.js";
import { revertTo, setProp } from "./edit.js";
import { touchProject, listRecentProjects, removeRecentProject, clearRecentProjects } from "./workspace.js";
import { buildRefGraph, listReferences, renameDraft, moveDraft, deleteDraft, deleteDraftImpact, listTrash, restoreDraft } from "./refs.js";
import { globalSearch } from "./search.js";
import { setTokenValue } from "./token_edit.js";
import { listTemplates, saveAsTemplate, deleteTemplate } from "./templates.js";
import { exportProject, importProject } from "./export.js";

import { capsFor, type CapCtx } from "./cap/index.js";

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
      "Umbra Studio —— 本地设计稿工具（.dc.html 格式）。",
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

// ─────────────────────── 工作区（M1-2）────────────────────────

// ─────────────────────── 引用图谱（M1-0）───────────────────────

// ─────────────────────── 项目创建（M1-1）───────────────────────

server.registerTool("create_project", {
  title: "新建一个设计项目",
  description: [
    "从一个空目录起步，创建一个设计项目。写入：",
    "  project.json         项目配置（名称、标题、设计系统路径、限额）",
    "  .gitignore           租户级忽略规则",
    "  <标题>.dc.html      第一份空白稿（含一个可编辑的 div）",
    "  .git/                默认初始化 git 仓库",
    "",
    "创建完立刻 get_project 能读、build_index 能跑。",
    "dir 指定绝对路径；不给时默认在工具目录 projects/<name> 下。",
  ].join("\n"),
  inputSchema: {
    name: z.string().describe("项目名（也是目录名，除非另外传 dir）"),
    dir: z.string().optional().describe("项目目录绝对路径。不给时默认 projects/<name>"),
    title: z.string().optional().describe("项目显示标题，不给时等于 name"),
    designSystemDir: z.string().optional().describe("设计系统目录相对路径，如 _ds/umbra-studio-system-xxx"),
    designSystemAlias: z.string().optional().describe("设计系统别名，默认 @ds"),
    tokens: z.string().optional().describe("tokens 文件相对路径，如 umbra-tokens.json"),
    icons: z.string().optional().describe("icons 文件相对路径，如 umbra-icons.json"),
    elementsWarn: z.number().int().optional().describe("元素数 warning 阈值，默认 1200"),
    elementsHard: z.number().int().optional().describe("元素数 hard 上限，默认 1500"),
    initGit: z.boolean().optional().describe("是否初始化 .git，默认 true"),
  },
}, async ({ name, dir, title, designSystemDir, designSystemAlias, tokens, icons, elementsWarn, elementsHard, initGit }) => run(async () => {
  const limits: { elementsWarn?: number; elementsHard?: number } = {};
  if (elementsWarn) limits.elementsWarn = elementsWarn;
  if (elementsHard) limits.elementsHard = elementsHard;

  const r = await createProject(name, {
    dir, title, designSystemDir, designSystemAlias, tokens, icons,
    limits: Object.keys(limits).length ? limits : undefined,
    initGit,
  });
  // 自动记录到最近项目列表
  await touchProject(r.dir, r.name, r.title);
  return envelope(r, [], { created: r.created.length });
}));

// ─────────────────────── 稿件创建（M1-3）───────────────────────

// ─────────────────────── 目录探查（应用前端新建项目面板，UI-7）───────────────────────
server.registerTool("inspect_dir", {
  title: "探查一个目录能不能当项目",
  description: [
    "新建项目面板选完目录后调它：目录存不存在、是不是已经是项目（有 project.json）、里面有几份 .dc.html。",
    "面板据此提示「这个目录已是项目，直接打开」或「目录里已有 N 份稿，要不要直接接管」。只读，不写任何东西。",
  ].join("\n"),
  inputSchema: { dir: z.string().describe("目录绝对路径") },
}, async ({ dir }) => run(async () => {
  const { stat, readdir } = await import("node:fs/promises");
  let exists = false, isDir = false;
  try { const st = await stat(dir); exists = true; isDir = st.isDirectory(); } catch { /* 不存在 */ }
  if (!exists || !isDir) return envelope({ dir, exists, isDir, isProject: false, draftCount: 0, suggestedName: basename(dir) }, [], {});
  const isProject = existsSync(join(dir, "project.json"));
  let draftCount = 0;
  const walk = async (d: string, depth: number): Promise<void> => {
    if (depth > 6) return;
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const abs = join(d, e.name);
      if (e.isDirectory()) await walk(abs, depth + 1);
      else if (e.name.endsWith(".dc.html") && !isToolPage(e.name)) draftCount++;   // 工具自己的壳（S2…、index）不算稿
    }
  };
  await walk(dir, 0);
  const suggestedName = basename(dir).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  return envelope({ dir, exists, isDir, isProject, draftCount, suggestedName }, [], {});
}));

// ─────────────────────── 稿件改名（M1-4）───────────────────────

// ─────────────────────── 稿件复制（M1-5）───────────────────────

// ─────────────────────── 稿件移动（M1-6）───────────────────────

// ─────────────────────── 删除与回收站（M1-7）───────────────────────

// ─────────────────────── 文件夹（M1-8）─────────────────────────

// ─────────────────────── 项目设置（M1-9）───────────────────────

// ─────────────────────── 项目删除/归档（M1-10）───────────────────────

// ─────────────────────── 设计系统检索 ───────────────────────

// ─────────────────────── 全局搜索 ───────────────────────

// ─────────────────────── 设计系统编辑 ─────────────────────

// ─────────────────────── 稿件模板 ─────────────────────

server.registerTool("list_templates", {
  title: "列出稿件模板",
  description: "列出项目内所有已保存的稿件模板。新建稿时可以用 source=template + templateName 来基于模板创建。",
  inputSchema: { project: z.string() },
}, async ({ project }) => run(async () => {
  const p = await loadProject(project);
  const templates = await listTemplates(p);
  return envelope({ templates }, [], { total: templates.length });
}));

server.registerTool("save_as_template", {
  title: "保存稿为模板",
  description: [
    "把项目中的一份稿保存为模板，之后新建稿时可以基于此模板创建。",
    "模板存在项目的 .umbrastudio/templates/ 目录下。",
  ].join("\n"),
  inputSchema: {
    project: z.string(),
    draftPath: z.string().describe("相对项目根的稿路径"),
    name: z.string().describe("模板名称"),
  },
}, async ({ project, draftPath, name }) => run(async () => {
  const p = await loadProject(project);
  const r = await saveAsTemplate(p, draftPath, name);
  return envelope(r, [], {});
}));

server.registerTool("delete_template", {
  title: "删除稿件模板",
  description: "删除一个已保存的稿件模板。",
  inputSchema: {
    project: z.string(),
    name: z.string().describe("模板名称"),
  },
}, async ({ project, name }) => run(async () => {
  const p = await loadProject(project);
  const r = await deleteTemplate(p, name);
  const diags = r.deleted ? [] : [
    err(X.DRAFT_NOT_FOUND, p.rel, { kind: "key", name: "template" }, `模板 ${name} 不存在`),
  ];
  return envelope(r, diags, {});
}));

// ─────────────────────── 项目导出/导入 ─────────────────────

server.registerTool("export_project", {
  title: "导出项目",
  description: [
    "把整个项目目录打包成 .tar.gz，含所有稿、快照、changelog 与 .umbrastudio/ 下的全部数据。",
    "导出的文件可以在另一台机器上用 import_project 导入。",
    "outputPath 指定导出文件的绝对路径。",
  ].join("\n"),
  inputSchema: {
    project: z.string(),
    outputPath: z.string().describe("导出文件绝对路径，如 /tmp/my-project.tar.gz"),
  },
}, async ({ project, outputPath }) => run(async () => {
  const p = await loadProject(project);
  const r = await exportProject(p.dir, outputPath);
  return envelope(r, [], { size: r.sizeBytes });
}));

server.registerTool("import_project", {
  title: "导入项目",
  description: [
    "从 .tar.gz 导入项目到指定目录。",
    "导入后项目包含完整的版本历史与快照。",
    "targetDir 是目标目录路径（会创建）。",
  ].join("\n"),
  inputSchema: {
    tarPath: z.string().describe("导出文件绝对路径"),
    targetDir: z.string().describe("导入目标目录（会创建）"),
  },
}, async ({ tarPath, targetDir }) => run(async () => {
  const r = await importProject(tarPath, targetDir);
  return envelope(r, [], { drafts: r.draftCount });
}));

// ───────────────────────── 组件契约 ─────────────────────────

// ───────────────────────── 写稿规则 ─────────────────────────

const GUIDES: Record<string, { file: string; note: string }> = {
  template: { file: "03-渲染与交互逻辑.md", note: "模板语言的精确语义（框架语义，与项目无关）" },
  logic: { file: "03-渲染与交互逻辑.md", note: "逻辑类契约与渲染时序" },
  interaction: { file: "06-写稿规则.md", note: "本项目的写法约定（交互、规模、收尾）" },
  checklist: { file: "06-写稿规则.md", note: "开工前与收尾的自检" },
  tokens: { file: "06-写稿规则.md", note: "取值从哪来、@ds 别名怎么写" },
};

// ───────────────────────── 静态校验 ─────────────────────────

// ───────────────────────── 写入（唯一写入口） ─────────────────────────

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
    { fix: "装一个 Chrome，或把可执行文件路径写进环境变量 UMBRASTUDIO_CHROMIUM" })];
  return envelope({ browser: f, autoDownload: false }, diags);
}));

// ───────────────────────── 变更交付（doc/07）─────────────────────────

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
  let s = await serveStart(p, port);
  /* 没索引就顺手建：壳页面（S2 / S6 / S8）、点选桥、令牌都靠 build_index 部署进项目。
     原来这里报一条 error，应用从首页打开一个从没建过索引的项目会直接「打开项目失败」【实测 2026-09-23，umbra 57 份稿】。 */
  let built: string | null = null;
  if (!s.indexExists) {
    await buildIndex(p, s.url);
    s = { ...s, indexExists: true };
    built = "第一次打开，已自动建索引并部署界面壳";
  }
  return envelope({ ...s, note: built }, []);
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

// ──────────────────────────── AI 会话（M2） ────────────────────────────

server.registerTool("set_ai_config", {
  title: "设置 AI 配置",
  description: [
    "设置某一条通道的端点、API 密钥和模型名。密钥只存本地，不进任何日志或项目文件。",
    "channel=a：OpenAI 兼容端点（DeepSeek / 智谱通用 API / 其他兼容端点）；",
    "channel=b：Anthropic 兼容端点（GLM Coding Plan），给 Claude Code 子进程用。两条通道各自一套，不共用。",
  ].join("\n"),
  inputSchema: {
    channel: z.enum(["a", "b"]).optional().describe("设哪条通道，默认 a"),
    baseUrl: z.string().optional().describe("端点：a 如 https://api.deepseek.com/v1；b 如 https://open.bigmodel.cn/api/anthropic"),
    apiKey: z.string().optional().describe("API 密钥（存本地不进日志）"),
    model: z.string().optional().describe("模型名，不硬编码"),
    defaultChannel: z.enum(["a", "b"]).optional().describe("默认通道"),
  },
}, async ({ channel, baseUrl, apiKey, model, defaultChannel }) => run(async () => {
  const current = await getAiConfig();
  const ch = channel ?? "a";
  const prev = ch === "a" ? current.channelA : current.channelB;
  const next = {
    baseUrl: baseUrl ?? prev?.baseUrl ?? "",
    apiKey: apiKey ?? prev?.apiKey ?? "",
    model: model ?? prev?.model ?? "",
  };
  const updated: AiConfig = {
    channelA: ch === "a" ? next : current.channelA,
    channelB: ch === "b" ? next : current.channelB,
    defaultChannel: defaultChannel ?? current.defaultChannel,
  };
  await setAiConfig(updated);
  return envelope({ ok: true, channel: ch }, [], {});
}));

server.registerTool("chat_send", {
  title: "发送 AI 会话消息",
  description: [
    "向 AI 发送一条用户消息，自动跑 agent 循环（通道 A）。",
    "返回模型的回复和所有工具调用结果。",
    "不指定 sessionId 时自动新建；指定了则追加到已有会话。",
    "",
    "选中节点参数（编辑方式 ②）：当用户在预览中选中了一个元素并发送消息时，",
    "带上该元素的地址和所在稿名，模型能针对这个元素做精确修改。",
  ].join("\n"),
  inputSchema: {
    message: z.string().describe("用户消息"),
    sessionId: z.string().optional().describe("会话 ID，不填自动新建"),
    project: z.string().describe("项目名"),
    channel: z.enum(["a", "b"]).optional().describe("通道，默认 a"),
    selectedNodeFile: z.string().optional().describe("选中节点所在稿的相对路径（data-sc-name）"),
    selectedNodeAddress: z.string().optional().describe("选中节点的 data-ud-node 值"),
  },
}, async ({ message, sessionId, project, channel, selectedNodeFile, selectedNodeAddress }) => run(async () => {
  const p = await loadProject(project);
  return runChatSend(p, { message, sessionId, channel, selectedNodeFile, selectedNodeAddress });
}));

// ──────────────────────── M8-2：泛型文件工具 ────────────────────────
/* 设计稿之外的文件（`.md`、图片、json、zip…）也要能列、能读、能改、能挪。
   `.dc.html` 在 write_file / move_file 里被显式拒绝并指回 write_draft / move_draft ——
   那条路做的归一化、@ds 展开、__resources、节点地址、语义快照，这条路一样都不做。 */

// ──────────────────────────── 启动 ────────────────────────────

/* ═══════════════════ 能力注册表 → MCP 面（M11-1，Q36）═══════════════════
   以前每件能力在这里手写一个 `registerTool`，在 `api.ts` 里再手写一条路由 ——
   **没有任何机制保证两边一致**，M8 那批就补过五条 MCP 侧早有、本地侧漏掉的能力。
   现在一件能力在 `cap/` 里声明一次，两个门面各自遍历生成。

   上面那些还没搬过来的 `registerTool` 照旧 —— 一次全搬 66 个风险太大，
   分批搬，`captest` 钉着「声明了就必须两面都有」。 */
for (const cap of capsFor("mcp")) {
  /* `scope: "project"` 的能力入参里**没有** `project`（见 `Cap.input` 的告诫），
     这里统一注入 —— MCP 的调用方是外部客户端，它没有「当前打开了哪个项目」这回事。 */
  const inputSchema = cap.scope === "project"
    ? { project: z.string().describe("项目名，或项目目录名"), ...cap.input }
    : cap.input;
  server.registerTool(cap.name, { title: cap.title, description: cap.summary, inputSchema },
    async (args: Record<string, unknown>) => run(async () => {
      const { project, ...rest } = args as { project?: string };
      const ctx: CapCtx = { project: cap.scope === "project" ? await loadProject(project!) : null, via: "mcp" };
      return cap.run(rest as never, ctx);
    }));
}

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[umbrastudio] v${VERSION} 已启动 · 项目根 ${projectsRoot()}\n`);
