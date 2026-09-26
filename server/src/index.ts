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

server.registerTool("list_projects", {
  title: "列出设计项目",
  description: "列出项目根下的所有设计项目（租户）。项目根默认 Umbra Studio/projects，可用 --projects-root 或 UMBRASTUDIO_PROJECTS_ROOT 指定。",
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
  // 自动记录到最近项目列表
  await touchProject(p.dir, p.name, p.title);
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

// ─────────────────────── 工作区（M1-2）────────────────────────

server.registerTool("list_recent_projects", {
  title: "最近打开过的项目",
  description: [
    "列出最近打开过的设计项目，按时间倒排。",
    "每条包含目录、名称、标题、最后打开时间、打开次数、目录是否还在。",
    "删掉的目录会标「找不到」而不是崩 —— 用户可以从列表里清掉。",
  ].join("\n"),
  inputSchema: {
    limit: z.number().int().min(1).max(50).optional().describe("最多返回几条，默认全部"),
  },
}, async ({ limit }) => run(async () => {
  const r = await listRecentProjects(limit);
  return envelope(r, [], { total: r.total });
}));

server.registerTool("remove_recent_project", {
  title: "从最近列表移除项目",
  description: "从最近项目列表移除一个条目。不影响项目目录本身，只是列表操作。",
  inputSchema: { dir: z.string().describe("项目目录绝对路径") },
}, async ({ dir }) => run(async () => {
  const r = await removeRecentProject(dir);
  return envelope(r, [], { removed: r.removed });
}));

server.registerTool("clear_recent_projects", {
  title: "清空最近项目列表",
  description: "清空最近项目列表。不影响任何项目目录。",
  inputSchema: {},
}, async () => run(async () => {
  await clearRecentProjects();
  return envelope({ cleared: true });
}));

// ─────────────────────── 引用图谱（M1-0）───────────────────────

server.registerTool("list_references", {
  title: "查询稿件的引用关系",
  description: [
    "回答「谁引用了我 / 我引用了谁」。dc-import 按文件名解析（doc/01 H4），",
    "改名 / 移动 / 删除任何被引用的稿都会静默打断引用。",
    "生命周期操作前必须先查这个工具确认影响面。",
    "",
    "传 file → 返回该稿的双向引用关系；",
    "不传 file → 返回整个项目的引用图谱概览（按被引用次数排序）。",
  ].join("\n"),
  inputSchema: {
    project: z.string(),
    file: z.string().optional().describe("稿的相对路径。不给时返回整个项目的引用概览"),
  },
}, async ({ project, file }) => run(async () => {
  const p = await loadProject(project);
  const r = await listReferences(p, file);
  const data: Record<string, unknown> = { ...r };
  if (r.file) {
    return envelope(data, [], {
      imports: r.imports.length,
      importedBy: r.importedBy.length,
    });
  }
  // 没给 file 时，imports/importedBy 是空数组，重点是 overview
  return envelope(data, [], {
    drafts: r.overview?.length ?? 0,
    referenced: r.overview?.filter((o) => o.importedByCount > 0).length ?? 0,
  });
}));

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

server.registerTool("update_project", {
  title: "更新项目配置",
  description: [
    "改项目配置：标题、设计系统路径/别名、tokens / icons 文件、元素数限额。",
    "只改 project.json，不影响已有稿件。传 null 可清除对应字段。",
  ].join("\n"),
  inputSchema: {
    project: z.string(),
    title: z.string().optional().describe("新标题"),
    designSystemDir: z.string().nullable().optional().describe("设计系统目录，传 null 清除"),
    designSystemAlias: z.string().optional().describe("设计系统别名，默认 @ds"),
    tokens: z.string().nullable().optional().describe("tokens 文件相对路径，传 null 清除"),
    icons: z.string().nullable().optional().describe("icons 文件相对路径，传 null 清除"),
    elementsWarn: z.number().int().optional().describe("元素数 warning 阈值"),
    elementsHard: z.number().int().optional().describe("元素数 hard 上限"),
  },
}, async ({ project, title, designSystemDir, designSystemAlias, tokens, icons, elementsWarn, elementsHard }) => run(async () => {
  const p = await loadProject(project);
  const r = await updateProject(p, {
    title,
    designSystemDir,
    designSystemAlias,
    tokens,
    icons,
    elementsWarn,
    elementsHard,
  });
  return envelope(r, [], { updated: r.updated.length });
}));

// ─────────────────────── 项目删除/归档（M1-10）───────────────────────

server.registerTool("archive_project", {
  title: "归档项目",
  description: [
    "把项目目录移到归档目录（默认 `.archived/`）。二次确认由界面处理。",
    "归档后项目从项目列表消失，但目录仍在，可随时移回来。",
  ].join("\n"),
  inputSchema: {
    project: z.string(),
    archiveDir: z.string().optional().describe("归档目录绝对路径，默认 <工具根>/.archived"),
  },
}, async ({ project, archiveDir }) => run(async () => {
  const p = await loadProject(project);
  const r = await archiveProject(p, archiveDir);
  return envelope(r, [], { archivePath: r.archivePath });
}));

server.registerTool("delete_project", {
  title: "删除项目",
  description: [
    "删除设计项目：移到归档目录。等同于 archive_project，语义上表达「删除」意图。",
    "二次确认由界面处理。不彻底删除，归档目录还在。",
  ].join("\n"),
  inputSchema: { project: z.string() },
}, async ({ project }) => run(async () => {
  const p = await loadProject(project);
  const r = await deleteProject(p);
  return envelope(r, [], { archivePath: r.archivePath });
}));

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
    expectedSourceSha256: z.string().length(64).optional().describe("并发保护：预期盘上源码 sha256，不匹配就拒绝"),
  },
}, async ({ project, path, content, kind, expectedSourceSha256 }) => run(async () => {
  const p = await loadProject(project);
  const r = await writeDraft(p, path, content, kind ?? "page", undefined,
    expectedSourceSha256 ? { expectedSourceSha256 } : undefined);
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
    expectedSourceSha256: z.string().length(64).optional().describe("并发保护：预期盘上源码 sha256，不匹配就拒绝"),
  },
}, async ({ project, path, edits, expectedSourceSha256 }) => run(async () => {
  const p = await loadProject(project);
  const r = await patchDraft(p, path, edits,
    expectedSourceSha256 ? { expectedSourceSha256 } : undefined);
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
    { fix: "装一个 Chrome，或把可执行文件路径写进环境变量 UMBRASTUDIO_CHROMIUM" })];
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
    "  .umbrastudio/index-data.json  —— 数据（doc/08 S1 的形状）",
    "  .umbrastudio/select-bridge.js —— 预览点选桥，由壳注入 iframe",
    "  _ds-tool/tokens.css           —— 工具皮肤",
    "",
    "⚠️ **先 serve_start 再 build_index**：本地 API 的令牌在这一步注入壳页面。",
    "反了的话壳拿不到令牌，诊断与点选面板是空的（返回里 api:false 就是这个情况）。",
    "",
    "每份稿带上：类型、元素数、最新版本、更新时间、缩略图（有的话）、",
    "健康状态与诊断条数、演示态清单、引用与被引用关系。",
    "入口页优先用设计侧那份 ui/S1-稿件索引.dc.html；它缺失时才用内置过渡页兜底",
    "（返回里的 indexSource 写明用了哪个）。",
    "",
    "renderCheck=true 时，对缺截图或截图过期的稿跑一次渲染体检并生成缩略图。",
  ].join("\n"),
  inputSchema: { project: z.string(), serve: z.boolean().optional().describe("true 时顺手起静态服务并回地址"), renderCheck: z.boolean().optional().describe("true 时对缺截图的稿跑渲染体检生成缩略图（M4-5）") },
}, async ({ project, serve, renderCheck }) => run(async () => {
  const p = await loadProject(project);
  const url = serve ? (await serveStart(p)).url : null;
  const r = await buildIndex(p, url, { renderCheck });
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

// ──────────────────────────── AI 会话（M2） ────────────────────────────

server.registerTool("get_ai_config", {
  title: "获取 AI 配置",
  description: "返回当前 AI 配置（通道 A 的端点和模型名）。⚠️ 密钥不回显，只显示是否已设置。",
  inputSchema: {},
}, async () => run(async () => {
  const cfg = await getAiConfig();
  const mask = (c: { baseUrl: string; apiKey: string; model: string } | null) =>
    c ? { baseUrl: c.baseUrl, apiKeySet: !!c.apiKey, model: c.model } : null;
  return envelope({ channelA: mask(cfg.channelA), channelB: mask(cfg.channelB), defaultChannel: cfg.defaultChannel }, [], {});
}));

server.registerTool("probe_image_support", {
  title: "探一次通道吃不吃图",
  description: [
    "现场造一张随机纯色小图发给通道 A，问它什么颜色。答对了就把 supportsImage 记成 true，否则 false。",
    "为什么不靠模型名猜：deepseek-chat 文档没写多模态，实测它能看图（doc/00 §六十一）。按名字猜一定有误判。",
  ].join("\n"),
  inputSchema: { channel: z.enum(["a", "c"]).optional().describe("探哪条通道，默认 a") },
}, async ({ channel }) => run(async () => {
  const { probeImageSupport } = await import("./ai_probe.js");
  return envelope(await probeImageSupport(channel ?? "a"), [], {});
}));

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

server.registerTool("list_comments", {
  title: "列出钉在节点上的评论",
  description: "评论存 .umbrastudio/comments.json（M6-2）：稿 + 节点地址（data-ud-node）+ 一句话 + 是否已处理。模型改稿前可以看看设计侧留了什么话。",
  inputSchema: { project: z.string().describe("项目名或绝对目录"), file: z.string().optional().describe("只看这一份稿"), unresolvedOnly: z.boolean().optional().describe("只看没处理的") },
}, async ({ project, file, unresolvedOnly }) => run(async () => {
  const p = await loadProject(project);
  let list = await listComments(p.dir, file);
  if (unresolvedOnly) list = list.filter((c) => !c.resolved);
  return envelope({ comments: list }, [], { count: list.length });
}));

server.registerTool("chat_list", {
  title: "列出项目的 AI 会话",
  description: "会话存 .umbrastudio/chats/，与项目绑定。返回 id / 通道 / 模型 / 更新时间 / 条数，按更新时间倒序。",
  inputSchema: { project: z.string().describe("项目名") },
}, async ({ project }) => run(async () => {
  const p = await loadProject(project);
  const r = await listChats(p.dir);
  return envelope(r, [], { count: r.sessions.length });
}));

server.registerTool("chat_get", {
  title: "读一个 AI 会话的全部消息",
  inputSchema: { project: z.string().describe("项目名"), sessionId: z.string().describe("会话 ID") },
}, async ({ project, sessionId }) => run(async () => {
  const p = await loadProject(project);
  const s = await loadChat(p.dir, sessionId);
  if (!s) throw new Error(`没有会话 ${sessionId}`);
  return envelope(s, [], { messages: s.messages.length });
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

server.registerTool("list_chats", {
  title: "列出会话",
  description: "列出当前项目的所有 AI 会话。",
  inputSchema: { project: z.string() },
}, async ({ project }) => run(async () => {
  const p = await loadProject(project);
  const r = await listChats(p.dir);
  return envelope(r, [], {});
}));

server.registerTool("delete_chat", {
  title: "删除会话",
  description: "删除一个 AI 会话。",
  inputSchema: { project: z.string(), sessionId: z.string() },
}, async ({ project, sessionId }) => run(async () => {
  const p = await loadProject(project);
  const ok = await deleteChat(p.dir, sessionId);
  const diags = ok ? [] : [err(X.IO, p.rel, { kind: "key", name: "chat" }, `会话 ${sessionId} 不存在`)];
  return envelope({ deleted: ok }, diags, {});
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
