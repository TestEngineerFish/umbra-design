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
  TOOL_ROOT, buildProject, createProject, createDraft, duplicateDraft, createFolder,
  updateProject, archiveProject, deleteProject,
  draftPath, listDrafts, listProjectDirs, loadProject, projectsRoot,
  type Project,
} from "./project.js";
import { getComponent, getIcon, getToken, listComponents, listIcons, searchTokens } from "./assets.js";
import { validateDraft } from "./validate.js";
import { patchDraft, writeDraft } from "./write.js";
import { missingRuntime } from "./normalize.js";
import { getAiConfig, setAiConfig, getChannelA, type AiConfig } from "./ai_config.js";
import { chat, type ToolDef, type ToolCall, type ChatMessage } from "./provider.js";
import { createChat, loadChat, saveChat, listChats, deleteChat, addMessage, type ChatSession, type ChatEntry } from "./chat.js";
import { findBrowser, renderCheck } from "./render.js";
import { channelBRun, type ChannelBConfig } from "./channel_b.js";
import {
  changesSince, diffDrafts, listVersions, projectChangesSince, readSnapshot,
  resolveSnapshot, toMarkdown,
} from "./history.js";
import { serveStart, serveStatus, serveStop } from "./serve.js";
import { buildIndex, collectIndex } from "./indexpage.js";
import { locateNode } from "./locate.js";
import { revertTo, setProp } from "./edit.js";
import { touchProject, listRecentProjects, removeRecentProject, clearRecentProjects } from "./workspace.js";
import { buildRefGraph, listReferences, renameDraft, moveDraft, deleteDraft, deleteDraftImpact, listTrash, restoreDraft } from "./refs.js";
import { globalSearch } from "./search.js";
import { setTokenValue } from "./token_edit.js";

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
    designSystemDir: z.string().optional().describe("设计系统目录相对路径，如 _ds/umbra-design-system-xxx"),
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

server.registerTool("create_draft", {
  title: "新建一份稿",
  description: [
    "四种来源：",
    "  blank        —— 空白骨架（默认）",
    "  copy         —— 复制现有稿（不复制快照，新稿从 v1 起）",
    "  component    —— 把组件包一层，创建只含 dc-import 的页稿",
    "  template     —— 从模板文件复制",
    "",
    "path 相对项目根，必须以 .dc.html 结尾。文件已存在会报错。",
  ].join("\n"),
  inputSchema: {
    project: z.string(),
    path: z.string().describe("相对项目根的路径，必须以 .dc.html 结尾"),
    source: z.enum(["blank", "copy", "component", "template"]).describe("稿的来源"),
    title: z.string().optional().describe("空白稿或组件包装稿的标题，不给时用文件名"),
    sourceFile: z.string().optional().describe("source=copy 时的源稿路径（相对项目根）"),
    componentName: z.string().optional().describe("source=component 时的组件名（dc-import name）"),
    templatePath: z.string().optional().describe("source=template 时的模板绝对路径"),
  },
}, async ({ project, path, source, title, sourceFile, componentName, templatePath }) => run(async () => {
  const p = await loadProject(project);

  let src: any;
  switch (source) {
    case "blank":
      src = { kind: "blank", title };
      break;
    case "copy":
      if (!sourceFile) throw new Error("source=copy 时必须传 sourceFile");
      src = { kind: "copy", sourceFile };
      break;
    case "component":
      if (!componentName) throw new Error("source=component 时必须传 componentName");
      src = { kind: "component", componentName, title };
      break;
    case "template":
      if (!templatePath) throw new Error("source=template 时必须传 templatePath");
      src = { kind: "template", templatePath };
      break;
  }

  const r = await createDraft(p, path, src);
  return envelope(r, [], {});
}));

// ─────────────────────── 稿件改名（M1-4）───────────────────────

server.registerTool("rename_draft", {
  title: "重命名一份稿",
  description: [
    "重命名稿，并**连带更新所有引用它的 dc-import name**（doc/01 H4）。",
    "改名只改基名，不改所在目录（移动用 move_draft）。",
    "返回里会列出哪些稿被更新了 —— 改名前应该先看 list_references 确认影响面。",
  ].join("\n"),
  inputSchema: {
    project: z.string(),
    path: z.string().describe("当前稿的相对路径，如 组件A.dc.html"),
    newName: z.string().describe("新基名，如 新名字（不用加 .dc.html）"),
  },
}, async ({ project, path, newName }) => run(async () => {
  const p = await loadProject(project);
  const r = await renameDraft(p, path, newName);
  return envelope(r, [], { referencesUpdated: r.referencesUpdated });
}));

// ─────────────────────── 稿件复制（M1-5）───────────────────────

server.registerTool("duplicate_draft", {
  title: "复制一份稿",
  description: [
    "复制一份稿到同目录下，默认名 `<原名> 副本.dc.html`，冲突时自动加序号。",
    "快照不跟着复制 —— 新稿从 v1 起（doc/12 M1-5）。",
    "复制后的稿保留原有的 dc-import 引用，两份互不影响。",
  ].join("\n"),
  inputSchema: {
    project: z.string(),
    path: z.string().describe("要复制的稿的相对路径"),
    newName: z.string().optional().describe("新稿名，不给时默认 `<原名> 副本`"),
  },
}, async ({ project, path, newName }) => run(async () => {
  const p = await loadProject(project);
  const r = await duplicateDraft(p, path, { newName });
  return envelope(r, [], { newPath: r.newPath });
}));

// ─────────────────────── 稿件移动（M1-6）───────────────────────

server.registerTool("move_draft", {
  title: "移动稿到目标目录",
  description: [
    "移动稿到目标目录，跨目录移动时引用路径要跟着修（相对路径基准变了）。",
    "目标目录不存在会自动创建。目标文件已存在会自动加序号。",
    "返回里会列出哪些稿的 dc-import name 被更新了。",
  ].join("\n"),
  inputSchema: {
    project: z.string(),
    path: z.string().describe("当前稿的相对路径"),
    targetDir: z.string().describe("目标目录相对项目根的路径，如 Components 或 Pages"),
  },
}, async ({ project, path, targetDir }) => run(async () => {
  const p = await loadProject(project);
  const r = await moveDraft(p, path, targetDir);
  return envelope(r, [], { referencesUpdated: r.referencesUpdated });
}));

// ─────────────────────── 删除与回收站（M1-7）───────────────────────

server.registerTool("get_delete_impact", {
  title: "查看删除稿的影响面",
  description: [
    "删除前先看有哪些稿引用了它。删除后这些稿都会报 E_IMPORT_MISSING。",
    "这个工具不实际删除，只返回影响面。确认后再调 delete_draft。",
  ].join("\n"),
  inputSchema: {
    project: z.string(),
    path: z.string().describe("要检查的稿的相对路径"),
  },
}, async ({ project, path }) => run(async () => {
  const p = await loadProject(project);
  const impact = await deleteDraftImpact(p, path);
  return envelope(impact, [], { affectedCount: impact.affectedCount });
}));

server.registerTool("delete_draft", {
  title: "删除稿到回收站",
  description: [
    "删除稿到 `.umbradesign/trash/<时间戳>/` 目录下（回收站语义，doc/11 Q4）。",
    "不彻底删除，随时可以恢复。删除前建议先调 get_delete_impact 看影响面。",
    "如果稿被其他稿引用，删除后那些稿会报 E_IMPORT_MISSING。",
  ].join("\n"),
  inputSchema: {
    project: z.string(),
    path: z.string().describe("要删除的稿的相对路径"),
  },
}, async ({ project, path }) => run(async () => {
  const p = await loadProject(project);
  const r = await deleteDraft(p, path);
  return envelope(r, [], { trashPath: r.trashPath });
}));

server.registerTool("list_trash", {
  title: "列出回收站中的稿件",
  description: "列出回收站（`.umbradesign/trash/`）中的所有已删除稿。",
  inputSchema: { project: z.string() },
}, async ({ project }) => run(async () => {
  const p = await loadProject(project);
  const items = await listTrash(p);
  return envelope({ items }, [], { count: items.length });
}));

server.registerTool("restore_draft", {
  title: "从回收站恢复稿",
  description: [
    "从回收站恢复稿到原始位置（同名冲突时自动加序号）。",
    "恢复后，引用了这份稿的其他稿不再报 E_IMPORT_MISSING。",
  ].join("\n"),
  inputSchema: {
    project: z.string(),
    trashPath: z.string().describe("回收站路径，如 .umbradesign/trash/2026-09-20T12-00-00-000Z/组件.dc.html"),
  },
}, async ({ project, trashPath }) => run(async () => {
  const p = await loadProject(project);
  const r = await restoreDraft(p, trashPath);
  return envelope(r, [], { restored: r.originalPath });
}));

// ─────────────────────── 文件夹（M1-8）─────────────────────────

server.registerTool("create_folder", {
  title: "创建稿件目录",
  description: "在项目目录下创建一个子目录。稿可以用 move_draft 移进去。",
  inputSchema: {
    project: z.string(),
    path: z.string().describe("目录相对项目根的路径，如 Components 或 Pages/子目录"),
  },
}, async ({ project, path }) => run(async () => {
  const p = await loadProject(project);
  const r = await createFolder(p, path);
  return envelope(r, [], { path: r.path });
}));

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

// ─────────────────────── 全局搜索 ───────────────────────

server.registerTool("global_search", {
  title: "跨稿搜索",
  description: [
    "在一份项目的所有稿里搜索。返回匹配的稿、行号与上下文。",
    "能搜：",
    "  - token 引用：var(--xxx)、@ds.xxx",
    "  - 组件引用：dc-import name=\"X\"",
    "  - CSS 引用：stylesheet",
    "  - 任意文案（忽略大小写）",
    "没有匹配时会返回空数组；limit 控制最大返回条数。",
  ].join("\n"),
  inputSchema: {
    project: z.string(),
    query: z.string().describe("搜索词，如 token 名 / 组件名 / 任意文案"),
    limit: z.number().int().min(1).max(500).optional().describe("最大返回条数，默认 100"),
  },
}, async ({ project, query, limit }) => run(async () => {
  const p = await loadProject(project);
  const r = await globalSearch(p, query, limit ?? 100);
  return envelope({ hits: r.hits }, [], {
    total: r.total,
    scanned: r.scanned,
    query: r.query,
  });
}));

// ─────────────────────── 设计系统编辑 ─────────────────────

server.registerTool("set_token_value", {
  title: "修改 token 取值",
  description: [
    "只改 token 的取值，不改结构（不增删 token、不改层级）。",
    "改之前自动分析影响面：哪些稿引用了这个 token。",
    "改完后受影响的稿在下一次渲染时会反映新值。",
    "新旧值相同时不会写入文件，直接返回。",
  ].join("\n"),
  inputSchema: {
    project: z.string(),
    path: z.string().describe("token 的点号路径，如 color.light.danger"),
    value: z.string().describe("新取值（字符串）"),
  },
}, async ({ project, path, value }) => run(async () => {
  const p = await loadProject(project);
  const r = await setTokenValue(p, path, value);
  const diags = r.changed ? [] : [
    err(X.IO, p.rel, { kind: "key", name: "token" },
      `token ${path} 的取值未改变：${r.oldValue}`),
  ];
  return envelope(r, diags, { affected: r.affectedDrafts });
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

/** agent 循环中真正执行一个工具调用。返回 JSON 字符串给模型。 */
async function executeToolCall(p: Project, tc: ToolCall): Promise<string> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(tc.function.arguments);
  } catch {
    return JSON.stringify({ ok: false, error: `参数解析失败: ${tc.function.arguments.slice(0, 200)}` });
  }

  try {
    switch (tc.function.name) {
      // ── 项目/稿件读取 ──
      case "get_project": {
        const drafts = (await listDrafts(p)).map((a) => a.slice(p.dir.length + 1).split("\\").join("/"));
        return JSON.stringify({
          ok: true,
          name: p.name, title: p.title, dir: p.dir,
          designSystem: p.config.designSystem ? { dir: p.dsDir, alias: p.dsAlias } : null,
          tokens: p.config.tokens ?? null, icons: p.config.icons ?? null,
          limits: p.limits, gitEnabled: p.gitEnabled,
          drafts,
        });
      }
      case "list_drafts": {
        const drafts = (await listDrafts(p)).map((a) => a.slice(p.dir.length + 1).split("\\").join("/"));
        return JSON.stringify({ ok: true, drafts });
      }

      // ── 设计系统检索 ──
      case "search_tokens": {
        const r = await searchTokens(p, args.query as string, (args.limit as number) ?? 30);
        return JSON.stringify({ ok: true, hits: r.hits.length, total: r.total, truncated: r.truncated });
      }
      case "get_token": {
        const r = await getToken(p, args.path as string);
        return JSON.stringify({ ok: true, ...r });
      }
      case "list_components": {
        const list = await listComponents(p);
        return JSON.stringify({ ok: true, components: list, total: list.length });
      }
      case "get_component": {
        const r = await getComponent(p, args.name as string, (args.mode as "contract" | "full") ?? "contract");
        return JSON.stringify({ ok: true, ...r });
      }
      case "list_icons": {
        const r = await listIcons(p, args.query as string | undefined, (args.limit as number) ?? 60);
        return JSON.stringify({ ok: true, viewBox: r.viewBox, icons: r.icons, total: r.total });
      }
      case "get_icon": {
        const r = await getIcon(p, args.name as string);
        return JSON.stringify({ ok: true, ...r });
      }
      case "get_syntax_guide": {
        const topic = args.topic as string;
        const g = GUIDES[topic] as { file: string; note: string } | undefined;
        if (!g) return JSON.stringify({ ok: false, error: `未知 topic: ${topic}` });
        const text = await readFile(join(TOOL_ROOT, "doc", g.file), "utf8");
        return JSON.stringify({ ok: true, topic, note: g.note, source: `doc/${g.file}`, text: text.slice(0, 20000) });
      }

      // ── 校验与写入 ──
      case "validate_draft": {
        const path = args.path as string;
        const abs = draftPath(p, path);
        const src = await readFile(abs, "utf8");
        const { diags, stats } = validateDraft(p, path, src, path);
        return JSON.stringify({ ok: true, project: p.name, path, errors: diags.filter((d) => d.level === "error").length, warnings: diags.filter((d) => d.level === "warning").length, diags: diags.slice(0, 50), stats });
      }
      case "write_draft": {
        const path = args.path as string;
        const content = args.content as string;
        const kind = (args.kind as "page" | "component") ?? "page";
        const r = await writeDraft(p, path, content, kind);
        return JSON.stringify({ ok: r.outcome.written, outcome: r.outcome, stats: r.stats, errors: r.diags.filter((d) => d.level === "error").length });
      }
      case "patch_draft": {
        const path = args.path as string;
        const edits = args.edits as Array<{ old: string; new: string; count?: number }>;
        const r = await patchDraft(p, path, edits);
        return JSON.stringify({ ok: r.outcome.written, outcome: r.outcome, stats: r.stats, errors: r.diags.filter((d) => d.level === "error").length });
      }
      case "render_check": {
        const path = args.path as string;
        const r = await renderCheck(p, path, {
          width: args.width as number | undefined,
          height: args.height as number | undefined,
        });
        return JSON.stringify({
          ok: true, alive: r.result.alive, nodeCount: r.result.nodeCount,
          renderMs: r.result.renderMs,
          unresolvedHoles: r.result.unresolvedHoles.length,
          consoleWarnings: r.result.consoleWarnings?.length ?? 0,
          externalRequests: r.result.externalRequests.length,
        });
      }

      // ── 版本与变更 ──
      case "list_versions": {
        const path = args.path as string;
        const vs = await listVersions(p, path);
        return JSON.stringify({ ok: true, path, versions: vs, latest: vs[vs.length - 1] ?? null, count: vs.length });
      }
      case "diff_drafts": {
        const path = args.path as string;
        const from = args.from as string;
        const to = (args.to as string) ?? undefined;
        const d = await diffDrafts(p, path, { from, to });
        return JSON.stringify({ ok: true, path, from, to: to ?? "latest", counts: d.counts, changes: d.changes.slice(0, 100) });
      }
      case "snapshot_draft": {
        const path = args.path as string;
        const version = (args.version as string) ?? "工作区";
        const snap = await resolveSnapshot(p, path, version);
        return JSON.stringify({
          ok: true, path, version,
          nodes: snap.nodes.length, texts: snap.texts.length,
          tokensUsed: snap.tokensUsed.length, branches: snap.branches.length,
          props: snap.props,
        });
      }
      case "get_changes_since": {
        const since = args.since as string;
        const path = (args.path as string) ?? undefined;
        if (path) {
          const d = await changesSince(p, path, since);
          return JSON.stringify({ ok: true, path, since, counts: d.counts, changes: d.changes.slice(0, 100) });
        }
        const drafts = (await listDrafts(p)).map((a) => a.slice(p.dir.length + 1).split("\\").join("/"));
        const rows = await projectChangesSince(p, drafts, since);
        const changed = rows.filter((r) => r.diff && r.diff.changes.length > 0);
        return JSON.stringify({
          ok: true, since,
          draftsScanned: rows.length,
          draftsChanged: changed.length,
          drafts: changed.map((r) => ({ path: r.path, counts: r.diff?.counts })),
        });
      }
      case "revert_to": {
        const file = args.file as string;
        const version = args.version as string;
        const r = await revertTo(p, file, version);
        return JSON.stringify({ ok: true, written: r.write.written, newVersion: r.write.version, restored: r.restored });
      }

      // ── 节点定位与属性编辑 ──
      case "locate_node": {
        const file = args.file as string;
        const node = args.node as string;
        const r = await locateNode(p, file, node);
        return JSON.stringify({
          ok: true, file, node, line: r.at.line, col: r.at.col, tag: r.tag,
          slots: r.slots.map((s) => ({ kind: s.kind, name: s.name, value: s.value, editable: s.editable, note: s.note })),
          inList: r.inList,
        });
      }
      case "set_prop": {
        const file = args.file as string;
        const node = args.node as string;
        const kind = args.kind as "style" | "attr" | "text";
        const name = args.name as string;
        const value = args.value as string;
        const r = await setProp(p, file, node, kind, name, value);
        return JSON.stringify({
          ok: true, written: r.write.written, version: r.write.version,
          newNode: r.newNode, bytesDelta: r.write.bytes,
        });
      }

      // ── 引用图谱 ──
      case "list_references": {
        const file = args.file as string | undefined;
        const r = await listReferences(p, file);
        return JSON.stringify({ ok: true, file: r.file ?? null, imports: r.imports, importedBy: r.importedBy, overview: r.overview?.slice(0, 30) });
      }

      default:
        return JSON.stringify({ ok: false, error: `未实现的工具: ${tc.function.name}` });
    }
  } catch (e) {
    const m = (e as Error)?.message ?? String(e);
    return JSON.stringify({ ok: false, error: `${tc.function.name} 执行失败: ${m}` });
  }
}

server.registerTool("get_ai_config", {
  title: "获取 AI 配置",
  description: "返回当前 AI 配置（通道 A 的端点和模型名）。⚠️ 密钥不回显，只显示是否已设置。",
  inputSchema: {},
}, async () => run(async () => {
  const cfg = await getAiConfig();
  const masked = cfg.channelA ? {
    baseUrl: cfg.channelA.baseUrl,
    apiKeySet: !!cfg.channelA.apiKey,
    model: cfg.channelA.model,
  } : null;
  return envelope({ channelA: masked, defaultChannel: cfg.defaultChannel }, [], {});
}));

server.registerTool("set_ai_config", {
  title: "设置 AI 配置",
  description: "设置通道 A 的 OpenAI 兼容端点、API 密钥和模型名。密钥只存本地，不进任何日志或项目文件。",
  inputSchema: {
    baseUrl: z.string().optional().describe("OpenAI 兼容端点，如 https://api.deepseek.com/v1"),
    apiKey: z.string().optional().describe("API 密钥（存本地不进日志）"),
    model: z.string().optional().describe("模型名，不硬编码"),
    defaultChannel: z.enum(["a", "b"]).optional().describe("默认通道"),
  },
}, async ({ baseUrl, apiKey, model, defaultChannel }) => run(async () => {
  const current = await getAiConfig();
  const updated: AiConfig = {
    channelA: {
      baseUrl: baseUrl ?? current.channelA?.baseUrl ?? "",
      apiKey: apiKey ?? current.channelA?.apiKey ?? "",
      model: model ?? current.channelA?.model ?? "",
    },
    defaultChannel: defaultChannel ?? current.defaultChannel,
  };
  await setAiConfig(updated);
  return envelope({ ok: true }, [], {});
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
  const ch = channel ?? "a";

  // 加载或新建会话
  let session: ChatSession | null = sessionId ? await loadChat(p.dir, sessionId) : null;
  if (!session) {
    const cfg = await getAiConfig();
    session = await createChat(p.dir, {
      projectId: p.name,
      channel: ch as "a" | "b",
      model: cfg.channelA?.model ?? "unknown",
    });
  }

  // 用户消息写入会话
  await addMessage(p.dir, session.id, { role: "user", content: message });

  // ── 选中节点上下文（M2-8） ──
  let nodeContext: string | null = null;
  if (selectedNodeFile && selectedNodeAddress) {
    try {
      const loc = await locateNode(p, selectedNodeFile, selectedNodeAddress);
      const editableSlots = loc.slots.filter((s) => s.editable);
      nodeContext = [
        `【当前选中节点】`,
        `  稿: ${loc.file}`,
        `  节点地址: ${loc.node}`,
        `  标签: ${loc.tag}`,
        `  源码位置: 第 ${loc.at.line} 行第 ${loc.at.col} 列`,
        `  在 sc-for 循环中: ${loc.inList ? "是（改动会影响循环所有行）" : "否"}`,
        `  可编辑项 (${editableSlots.length} 个):`,
        ...editableSlots.slice(0, 15).map((s) => `    - ${s.kind}: ${s.name} = "${String(s.value).slice(0, 80)}"`),
        ...(editableSlots.length > 15 ? [`    ... 还有 ${editableSlots.length - 15} 个可编辑项`] : []),
      ].join("\n");
    } catch {
      // 节点地址可能已过期，静默忽略
    }
  }

  // 通道 A：跑 agent 循环
  if (ch === "a") {
    const providerCfg = await getChannelA();

    // ── 记录循环前各稿的版本（用于审计变更） ──
    const draftVersionsBefore: Map<string, string> = new Map();
    try {
      const allDrafts = await listDrafts(p);
      for (const abs of allDrafts) {
        const rel = abs.slice(p.dir.length + 1).split("\\").join("/");
        const vs = await listVersions(p, rel);
        if (vs.length > 0) draftVersionsBefore.set(rel, vs[vs.length - 1] as string);
      }
    } catch { /* 忽略，不影响主流程 */ }

    const history: ChatMessage[] = session.messages.map((m) => ({
      role: m.role as ChatMessage["role"],
      content: m.content,
      ...(m.toolCalls ? { tool_calls: m.toolCalls } : {}),
      ...(m.toolCallId ? { tool_call_id: m.toolCallId, name: m.toolName } : {}),
    }));

    // 工具定义：把我们现有的 MCP 工具暴露给模型
    const tools: ToolDef[] = [
      { type: "function", function: { name: "get_project", description: "取项目配置与稿清单", parameters: { type: "object", properties: { project: { type: "string" } }, required: ["project"] } } },
      { type: "function", function: { name: "list_drafts", description: "列出项目所有稿", parameters: { type: "object", properties: { project: { type: "string" } }, required: ["project"] } } },
      { type: "function", function: { name: "search_tokens", description: "按路径或取值模糊检索 token", parameters: { type: "object", properties: { project: { type: "string" }, query: { type: "string" }, limit: { type: "number" } }, required: ["project", "query"] } } },
      { type: "function", function: { name: "get_token", description: "取单个 token 全文", parameters: { type: "object", properties: { project: { type: "string" }, path: { type: "string" } }, required: ["project", "path"] } } },
      { type: "function", function: { name: "list_components", description: "列出所有组件与页稿", parameters: { type: "object", properties: { project: { type: "string" } }, required: ["project"] } } },
      { type: "function", function: { name: "get_component", description: "取组件契约或全文", parameters: { type: "object", properties: { project: { type: "string" }, name: { type: "string" }, mode: { type: "string", enum: ["contract", "full"] } }, required: ["project", "name"] } } },
      { type: "function", function: { name: "list_icons", description: "检索图标", parameters: { type: "object", properties: { project: { type: "string" }, query: { type: "string" }, limit: { type: "number" } }, required: ["project"] } } },
      { type: "function", function: { name: "get_icon", description: "取图标 SVG", parameters: { type: "object", properties: { project: { type: "string" }, name: { type: "string" } }, required: ["project", "name"] } } },
      { type: "function", function: { name: "get_syntax_guide", description: "取模板语义与写稿规则", parameters: { type: "object", properties: { topic: { type: "string", enum: ["template", "logic", "interaction", "checklist", "tokens"] } }, required: ["topic"] } } },
      { type: "function", function: { name: "validate_draft", description: "静态校验一份稿，errors 非空=不该落盘", parameters: { type: "object", properties: { project: { type: "string" }, path: { type: "string" } }, required: ["project", "path"] } } },
      { type: "function", function: { name: "write_draft", description: "整份写一份稿（唯一写入口），自动归一化/@ds展开/__resources注入/校验/快照", parameters: { type: "object", properties: { project: { type: "string" }, path: { type: "string" }, content: { type: "string" }, kind: { type: "string", enum: ["page", "component"] } }, required: ["project", "path", "content"] } } },
      { type: "function", function: { name: "patch_draft", description: "按 {old,new} 增量替换稿中的文本", parameters: { type: "object", properties: { project: { type: "string" }, path: { type: "string" }, edits: { type: "array" } }, required: ["project", "path", "edits"] } } },
      { type: "function", function: { name: "render_check", description: "真实渲染体检——唯一验收证据", parameters: { type: "object", properties: { project: { type: "string" }, path: { type: "string" }, width: { type: "number" }, height: { type: "number" } }, required: ["project", "path"] } } },
      { type: "function", function: { name: "list_versions", description: "列出一份稿的版本序列", parameters: { type: "object", properties: { project: { type: "string" }, path: { type: "string" } }, required: ["project", "path"] } } },
      { type: "function", function: { name: "diff_drafts", description: "两版之间的语义 diff（L1-L4 四级分类）", parameters: { type: "object", properties: { project: { type: "string" }, path: { type: "string" }, from: { type: "string" }, to: { type: "string" } }, required: ["project", "path", "from"] } } },
      { type: "function", function: { name: "snapshot_draft", description: "取一份稿的语义快照", parameters: { type: "object", properties: { project: { type: "string" }, path: { type: "string" }, version: { type: "string" } }, required: ["project", "path"] } } },
      { type: "function", function: { name: "locate_node", description: "把预览里点中的节点对回源码", parameters: { type: "object", properties: { project: { type: "string" }, file: { type: "string" }, node: { type: "string" } }, required: ["project", "file", "node"] } } },
      { type: "function", function: { name: "set_prop", description: "改一个节点上的一处属性/样式/文本", parameters: { type: "object", properties: { project: { type: "string" }, file: { type: "string" }, node: { type: "string" }, kind: { type: "string", enum: ["style", "attr", "text"] }, name: { type: "string" }, value: { type: "string" } }, required: ["project", "file", "node", "kind", "name", "value"] } } },
      { type: "function", function: { name: "revert_to", description: "把稿退回某一版（历史只增不改）", parameters: { type: "object", properties: { project: { type: "string" }, file: { type: "string" }, version: { type: "string" } }, required: ["project", "file", "version"] } } },
      { type: "function", function: { name: "list_references", description: "查询稿件的引用关系（谁引用了我/我引用了谁）", parameters: { type: "object", properties: { project: { type: "string" }, file: { type: "string" } }, required: ["project"] } } },
      { type: "function", function: { name: "get_changes_since", description: "跨版本净变更，回答「我实现的是 vX，现在最新 vY，我要改什么」", parameters: { type: "object", properties: { project: { type: "string" }, since: { type: "string" }, path: { type: "string" } }, required: ["project", "since"] } } },
    ];

    // 系统提示：设计助手角色 + 选中节点上下文
    const systemParts: string[] = [
      "你是 UmbraDesign 设计助手。你可以通过工具调用读取和修改设计稿。",
      "修改稿必须用 write_draft 或 patch_draft 落盘，不要口头说改了什么。",
      "修改前先 validate_draft 确认当前状态，修改后再次 validate 确认无 error。",
      "⚠️ set_prop 只能改一处（一条样式/一个属性），用户说改多处时先改当前选中的。",
    ];
    if (nodeContext) {
      systemParts.push("", "### 当前选中节点（用户正在编辑的元素）", nodeContext, "", "用户说「这个」「这里」「字号大一点」等指向性描述时，就是指这个节点。用 set_prop 修改它的可编辑项，或调用 write_draft/patch_draft 做更大改动。");
    }

    const result = await chat(providerCfg, {
      systemPrompt: systemParts.join("\n"),
      messages: history,
      tools,
      maxSteps: 10,
      onToolCall: async (tc: ToolCall) => {
        return executeToolCall(p, tc);
      },
    });

    // 模型回复存入会话
    for (const m of result.messages.slice(history.length)) {
      await addMessage(p.dir, session.id, {
        role: m.role as ChatEntry["role"],
        content: m.content ?? "",
        ...(m.tool_calls ? { toolCalls: m.tool_calls } : {}),
      });
    }

    const diags = result.error ? [err(X.IO, p.rel, { kind: "key", name: "ai" }, result.error)] : [];

    // ── 审计本次 AI 会话对稿件的变更（M2-9） ──
    const changes: Array<{ path: string; counts: Record<string, number>; summary: string }> = [];
    try {
      const allDrafts = await listDrafts(p);
      for (const abs of allDrafts) {
        const rel = abs.slice(p.dir.length + 1).split("\\").join("/");
        const vs = await listVersions(p, rel);
        if (!vs.length) continue;
        const before = draftVersionsBefore.get(rel);
        if (!before) continue;
        const after = vs[vs.length - 1];
        if (after === before) continue;  // 这个稿没变

        // 有变更，计算 diff
        const d = await diffDrafts(p, rel, { from: before, to: after });
        if (d.changes.length > 0) {
          changes.push({
            path: rel,
            counts: d.counts,
            summary: `${d.counts.L1 ?? 0} 处契约变更(需改代码) · ${d.counts.L2 ?? 0} 处取值变更 · ${d.counts.L3 ?? 0} 处文案变更 · ${d.counts.L4 ?? 0} 处等价变更`,
          });
        }
      }
    } catch { /* 忽略，不影响主流程 */ }

    const chVal: "a" | "b" = ch;
    return envelope<{ sessionId: string; channel: "a" | "b"; messages: ChatEntry[]; usage: typeof result.usage; interrupted: boolean; changes: typeof changes }>({
      sessionId: session.id,
      channel: chVal,
      messages: session.messages.slice(-10),
      usage: result.usage,
      interrupted: result.interrupted,
      changes,
    }, diags, {});
  }

  // 通道 B：Claude Code 子进程（M2-3）

  // 记录循环前各稿的版本（用于审计变更）
  const draftVersionsBeforeB: Map<string, string> = new Map();
  try {
    const allDrafts = await listDrafts(p);
    for (const abs of allDrafts) {
      const rel = abs.slice(p.dir.length + 1).split("\\").join("/");
      const vs = await listVersions(p, rel);
      if (vs.length > 0) draftVersionsBeforeB.set(rel, vs[vs.length - 1] as string);
    }
  } catch { /* 忽略 */ }

  const providerCfg = await getChannelA();  // 通道 B 复用通道 A 的端点配置
  const ccConfig: ChannelBConfig = {
    baseUrl: providerCfg.baseUrl,
    apiKey: providerCfg.apiKey,
    model: providerCfg.model,
    mcpServerPath: join(TOOL_ROOT, "server", "dist", "index.js"),
  };

  // 通道 B 的系统提示（含选中节点上下文）
  const bSystemParts: string[] = [
    "你是 UmbraDesign 设计助手。你可以通过 MCP 工具 umbradesign 读取和修改设计稿。",
    "修改稿必须用 write_draft 或 patch_draft 落盘。修改前先 validate_draft，修改后再次 validate。",
  ];
  if (nodeContext) {
    bSystemParts.push("", "### 当前选中节点", nodeContext, "", "用户说「这个」「这里」时，就是指这个节点。");
  }

  const ccResult = await channelBRun(ccConfig, message, bSystemParts.join("\n"), 120000);

  // 把结果存入会话
  if (ccResult.result) {
    await addMessage(p.dir, session.id, { role: "assistant", content: ccResult.result });
  }

  const usageInfo = ccResult.usage
    ? { promptTokens: ccResult.usage.inputTokens, completionTokens: ccResult.usage.outputTokens, totalTokens: ccResult.usage.inputTokens + ccResult.usage.outputTokens }
    : null;

  const diagsB = ccResult.error ? [err(X.IO, p.rel, { kind: "key", name: "channel-b" }, ccResult.error)] : [];

  // ── 审计本次 AI 会话对稿件的变更（M2-9，通道 B） ──
  const changesB: Array<{ path: string; counts: Record<string, number>; summary: string }> = [];
  try {
    const allDrafts = await listDrafts(p);
    for (const abs of allDrafts) {
      const rel = abs.slice(p.dir.length + 1).split("\\").join("/");
      const vs = await listVersions(p, rel);
      if (!vs.length) continue;
      const before = draftVersionsBeforeB.get(rel);
      if (!before) continue;
      const after = vs[vs.length - 1];
      if (after === before) continue;

      const d = await diffDrafts(p, rel, { from: before, to: after });
      if (d.changes.length > 0) {
        changesB.push({
          path: rel,
          counts: d.counts,
          summary: `${d.counts.L1 ?? 0} 处契约变更(需改代码) · ${d.counts.L2 ?? 0} 处取值变更 · ${d.counts.L3 ?? 0} 处文案变更 · ${d.counts.L4 ?? 0} 处等价变更`,
        });
      }
    }
  } catch { /* 忽略 */ }

  const chValB: "a" | "b" = ch as "a" | "b";
  return envelope<{ sessionId: string; channel: "a" | "b"; messages: ChatEntry[]; usage: typeof usageInfo; interrupted: boolean; toolCalls: typeof ccResult.toolCalls; numTurns: number; changes: typeof changesB }>({
    sessionId: session.id,
    channel: chValB,
    messages: session.messages.slice(-10),
    usage: usageInfo,
    interrupted: false,
    toolCalls: ccResult.toolCalls,
    numTurns: ccResult.numTurns,
    changes: changesB,
  }, diagsB, {});
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

// ──────────────────────────── 启动 ────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[umbradesign] v${VERSION} 已启动 · 项目根 ${projectsRoot()}\n`);
