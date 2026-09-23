/** 租户（设计项目）解析。doc/00 §三
 *
 * 要点：
 *  - 项目根只是默认在 UmbraDesign/projects，可由 --projects-root / UMBRADESIGN_PROJECTS_ROOT 指定。
 *    工具不追踪用户的项目，打包分发后 projects/ 甚至不在安装目录里。
 *  - 租户目录必须自包含：运行时副本与稿同层（不是 _runtime/ 子目录）。
 *  - git 自动探测租户目录下有没有 .git，不手填。
 */
import { readdir, readFile, stat, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, relative, dirname, basename, sep, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { X } from "./codes.js";
import { err, ToolError } from "./envelope.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** 工具自身的根：server/dist/.. → server/.. → UmbraDesign/ */
export const TOOL_ROOT = resolve(HERE, "..", "..");
export const RUNTIME_DIR = join(TOOL_ROOT, "runtime");

export interface ProjectConfig {
  name: string;
  title?: string;
  designSystem?: { dir: string; alias?: string };
  tokens?: string;
  icons?: string;
  extraStyles?: string[];
  limits?: { elementsWarn?: number; elementsHard?: number };
}

export interface Project {
  /** project.json 里的 name，没有配置文件时用目录名 */
  name: string;
  title: string;
  /** 租户目录绝对路径 */
  dir: string;
  /** 相对仓库根（用于诊断的 file 字段） */
  rel: string;
  config: ProjectConfig;
  /** ds 的真实相对路径（相对租户根），没配就是 null */
  dsDir: string | null;
  dsAlias: string;
  tokensPath: string | null;
  iconsPath: string | null;
  limits: { elementsWarn: number; elementsHard: number };
  /** 自动探测：租户目录下有没有 .git */
  gitEnabled: boolean;
}

const DEFAULT_LIMITS = { elementsWarn: 1200, elementsHard: 1500 };

export function projectsRoot(): string {
  const flag = process.argv.indexOf("--projects-root");
  if (flag >= 0 && process.argv[flag + 1]) return resolve(process.argv[flag + 1] as string);
  if (process.env.UMBRADESIGN_PROJECTS_ROOT) return resolve(process.env.UMBRADESIGN_PROJECTS_ROOT);
  return join(TOOL_ROOT, "projects");
}

/** 诊断里的 file 字段：相对项目根的路径，始终用 / 分隔 */
export function relFile(abs: string): string {
  const root = projectsRoot();
  const r = relative(root, abs);
  return (r.startsWith("..") ? abs : r).split(sep).join("/");
}

async function isDir(p: string): Promise<boolean> {
  try { return (await stat(p)).isDirectory(); } catch { return false; }
}

export async function listProjectDirs(): Promise<string[]> {
  const root = projectsRoot();
  if (!(await isDir(root))) return [];
  const out: string[] = [];
  for (const e of await readdir(root, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    out.push(join(root, e.name));
  }
  return out.sort();
}

export async function loadProject(nameOrDir: string): Promise<Project> {
  /* 绝对路径直接当项目目录（M1-2：项目可在任意路径）。以前只按 projects/ 下的名字找，
     参数叫 nameOrDir 却从没处理过 Dir —— Tauri 壳里打开 projects/ 之外的项目一律「找不到」【实测 2026-09-23】。 */
  if (isAbsolute(nameOrDir)) {
    if (!existsSync(join(nameOrDir, "project.json"))) {
      throw new ToolError(
        err(X.PROJECT_UNKNOWN, nameOrDir, { kind: "path", name: nameOrDir },
          `目录 "${nameOrDir}" 下没有 project.json，不是一个设计项目`,
          { fix: "用 create_project 在这个目录建项目（已有的稿会被接管，不改动）" }));
    }
    return await buildProject(nameOrDir);
  }
  const dirs = await listProjectDirs();
  let hit = dirs.find((d) => d.split(sep).pop() === nameOrDir) ?? null;
  if (!hit) {
    for (const d of dirs) {
      const c = await readConfig(d);
      if (c?.name === nameOrDir) { hit = d; break; }
    }
  }
  if (!hit) {
    const available = dirs.map((d) => d.split(sep).pop()).filter(Boolean) as string[];
    throw new ToolError(
      err(X.PROJECT_UNKNOWN, relFile(join(projectsRoot(), nameOrDir)),
        { kind: "path", name: nameOrDir },
        `找不到设计项目 "${nameOrDir}"`,
        { fix: `项目根是 ${projectsRoot()}，现有：${available.join(" / ") || "（空）"}` }),
      { projectsRoot: projectsRoot(), available }
    );
  }
  return await buildProject(hit);
}

async function readConfig(dir: string): Promise<ProjectConfig | null> {
  try {
    return JSON.parse(await readFile(join(dir, "project.json"), "utf8")) as ProjectConfig;
  } catch { return null; }
}

export async function buildProject(dir: string): Promise<Project> {
  const fallbackName = dir.split(sep).pop() as string;
  const config = (await readConfig(dir)) ?? { name: fallbackName };
  const dsDir = config.designSystem?.dir ?? null;
  return {
    name: config.name || fallbackName,
    title: config.title || config.name || fallbackName,
    dir,
    rel: relFile(dir),
    config,
    dsDir,
    dsAlias: config.designSystem?.alias ?? "@ds",
    tokensPath: config.tokens ? join(dir, config.tokens) : null,
    iconsPath: config.icons ? join(dir, config.icons) : null,
    limits: { ...DEFAULT_LIMITS, ...(config.limits ?? {}) },
    gitEnabled: existsSync(join(dir, ".git")),
  };
}

/** 递归列出租户下所有 .dc.html（跳过点目录） */
export async function listDrafts(p: Project): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const q = join(d, e.name);
      if (e.isDirectory()) await walk(q);
      else if (e.name.endsWith(".dc.html")) out.push(q);
    }
  }
  await walk(p.dir);
  return out.sort();
}

/** 稿的绝对路径。path 是相对租户根的。不存在就抛 E_DRAFT_NOT_FOUND。 */
export function draftPath(p: Project, path: string): string {
  const abs = resolve(p.dir, path);
  if (!abs.startsWith(p.dir)) {
    throw new ToolError(err(X.BAD_INPUT, path, { kind: "path", name: path },
      "稿的路径跨出了项目目录", { fix: "path 必须是相对项目根的路径，不能用 .. 跳出去" }));
  }
  if (!existsSync(abs)) {
    throw new ToolError(err(X.DRAFT_NOT_FOUND, relFile(abs), { kind: "file", name: path },
      `找不到稿 "${path}"`, { fix: "用 get_project 看现有的稿清单" }));
  }
  return abs;
}

/** @ds 别名 → 真实相对路径。落盘时用（00 §3.2）。 */
export function expandDsAlias(p: Project, src: string): string {
  if (!p.dsDir) return src;
  const a = p.dsAlias;
  // 只替换出现在 href/src 属性值开头的别名，避免动到正文里的字面量
  return src.replace(
    new RegExp(`((?:href|src)\\s*=\\s*["'])${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`, "g"),
    (_m, pre: string) => `${pre}${p.dsDir}/`
  );
}

// ──────────────────────── M1-1: create_project ───────────────────────

import { mkdir } from "node:fs/promises";
import { writeAtomic } from "./normalize.js";

export interface CreateProjectOpts {
  /** 项目目录绝对路径。不给时默认 projects/<name> */
  dir?: string;
  /** 项目显示名（project.json name），不给时用目录名 */
  name?: string;
  /** 项目标题 */
  title?: string;
  /** 设计系统目录。不给时不配设计系统 */
  designSystemDir?: string;
  /** 设计系统别名，默认 @ds */
  designSystemAlias?: string;
  /** tokens 文件相对路径 */
  tokens?: string;
  /** icons 文件相对路径 */
  icons?: string;
  /** 元素数阈值 */
  limits?: { elementsWarn?: number; elementsHard?: number };
  /** 是否初始化 .git */
  initGit?: boolean;
}

export interface CreateProjectResult {
  dir: string;
  name: string;
  title: string;
  firstDraft: string;
  gitEnabled: boolean;
  /** 写入了哪些文件 */
  created: string[];
}

/** 第一份空白稿的骨架。
 *  最小可渲染 .dc.html：doctype + helmet + 空 x-dc + support.js 引导。 */
function blankDraft(title: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<!-- ${title} —— UmbraDesign 空白稿，从这里开始画 -->
<div style="padding:80px 20px;text-align:center;color:var(--ink,#888);font-family:system-ui">
  <div style="font-size:16px;font-weight:600;margin-bottom:8px">${title}</div>
  <div style="font-size:13px">选中这个元素，改它的字号 / 颜色 / 文案</div>
</div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props="{&quot;$preview&quot;:{&quot;width&quot;:375,&quot;height&quot;:667}}">
class Component extends DCLogic {
  renderVals() { return {}; }
}
</script>
</body>
</html>
`;
}

/** .gitignore 模板。新建项目时拷一次，之后由 build_index 维护生成的那段。 */
function gitignoreTemplate(): string {
  return `# ── 设计项目（租户）的仓库 ────────────────────────────────────
# 每个设计项目各自一个 git 仓库。git 在 UmbraDesign 里是【兜底手段】：
# 主路径是 .umbradesign/snapshots/ 的语义快照 + CHANGELOG-设计侧.md，
# 只有要按任意 git ref 取历史版本时才用到 git（见 doc/07 §七）。

# 工具产物：快照、缩略图、索引缓存。可由稿件重算，不必进仓库。
# ⚠️ 若希望语义 diff 的历史随仓库一起走，把下面这行注释掉，
#    改为只忽略 shots/ 与 cache/ —— 见 doc/07 §七的两种取法。
.umbradesign/

# 旧宿主（Claude Design）留下的产物，不是设计事实的出处
.image-slots.state.json
.thumbnail
uploads/
screenshots/

# 运行时副本：由 MCP 从工具的 runtime/ 拷进来并保持更新，不必进仓库
_runtime/

# 编辑器与系统
.DS_Store
Thumbs.db
*.swp
`;
}

/** 从空目录创建一个设计项目。
 *
 * 写入：
 *   <dir>/project.json        项目配置
 *   <dir>/.gitignore          租户级忽略规则
 *   <dir>/<name>.dc.html     第一份空白稿
 *   <dir>/.git/               可选，initGit=true 时
 */
export async function createProject(
  name: string,
  opts: CreateProjectOpts = {},
): Promise<CreateProjectResult> {
  const dir = opts.dir ?? join(projectsRoot(), name);

  // 目录已存在且已经有 project.json → 不是空目录
  const existingConfig = join(dir, "project.json");
  if (existsSync(existingConfig)) {
    throw new Error(
      `目录 "${dir}" 下已经有 project.json，这已经是一个设计项目。`
      + "用 get_project 查看，或用 update_project 修改。"
    );
  }

  // 目录存在但不是空的（有非隐藏文件）→ 警告但还是继续
  let isClean = true;
  if (existsSync(dir)) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      isClean = entries.every((e) => e.name.startsWith("."));
    } catch { /* 读不了就当不知道 */ }
  }

  await mkdir(dir, { recursive: true });

  const projName = opts.name ?? name;
  const projTitle = opts.title ?? projName;
  const dsAlias = opts.designSystemAlias ?? "@ds";
  const created: string[] = [];

  // 1. project.json
  const config: ProjectConfig = {
    name: projName,
    title: projTitle,
  };
  if (opts.designSystemDir) {
    config.designSystem = { dir: opts.designSystemDir, alias: dsAlias };
  }
  if (opts.tokens) config.tokens = opts.tokens;
  if (opts.icons) config.icons = opts.icons;
  if (opts.limits) config.limits = opts.limits;

  await writeAtomic(existingConfig, JSON.stringify(config, null, 2) + "\n");
  created.push("project.json");

  // 2. .gitignore
  const giPath = join(dir, ".gitignore");
  if (!existsSync(giPath)) {
    await writeAtomic(giPath, gitignoreTemplate());
    created.push(".gitignore");
  }

  // 3. 第一份空白稿
  const firstDraftName = `${projTitle}.dc.html`;
  const firstDraftPath = join(dir, firstDraftName);
  await writeAtomic(firstDraftPath, blankDraft(projTitle));
  created.push(firstDraftName);

  // 4. 可选：初始化 git
  let gitEnabled = false;
  if (opts.initGit !== false) {
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const exec = promisify(execFile);
      await exec("git", ["init"], { cwd: dir });
      gitEnabled = true;
      created.push(".git/");
    } catch {
      // 没装 git 就跳过，不影响项目使用
    }
  }

  return {
    dir,
    name: projName,
    title: projTitle,
    firstDraft: firstDraftName,
    gitEnabled,
    created,
  };
}

// ──────────────────────── M1-3: create_draft ───────────────────────

/** 新建稿的四种来源 */
export type DraftSource =
  | { kind: "blank"; title?: string }
  | { kind: "copy"; sourceFile: string }
  | { kind: "component"; componentName: string; title?: string }
  | { kind: "template"; templatePath: string };

export interface CreateDraftResult {
  path: string;
  source: string;
  elements: number;
}

/** 空白稿模板。和 createProject 用的类似但更精简。 */
function blankDraftContent(title: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<!-- ${title} —— 新建稿 -->
<div style="padding:80px 20px;text-align:center;color:var(--ink,#888);font-family:system-ui">
  <div style="font-size:16px;font-weight:600;margin-bottom:8px">${title}</div>
  <div style="font-size:13px">选中这个元素，改它的字号 / 颜色 / 文案</div>
</div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props="{&quot;$preview&quot;:{&quot;width&quot;:375,&quot;height&quot;:667}}">
class Component extends DCLogic {
  renderVals() { return {}; }
}
</script>
</body>
</html>
`;
}

/** 组件包装稿：只含一个 dc-import。
 *  这样新稿就是一个页稿，引用了指定的组件，可以直接预览。 */
function componentWrapperDraft(componentName: string, title: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<!-- ${title} —— ${componentName} 的包装稿 -->
<dc-import name="${componentName}"></dc-import>
</x-dc>
<script type="text/x-dc" data-dc-script data-props="{&quot;$preview&quot;:{&quot;width&quot;:375,&quot;height&quot;:667}}">
class Component extends DCLogic {
  renderVals() { return {}; }
}
</script>
</body>
</html>
`;
}

/** 新建一份稿。
 *
 * 四种来源：
 *   blank       —— 空白骨架
 *   copy        —— 复制现有稿（不复制快照，新稿从 v1 起）
 *   component   —— 把组件包一层，创建只含 dc-import 的页稿
 *   template    —— 从模板文件复制
 *
 * path 相对项目根，必须以 .dc.html 结尾。
 * 如果文件已存在会抛出。
 */
export async function createDraft(
  p: Project,
  path: string,
  source: DraftSource,
): Promise<CreateDraftResult> {
  const abs = resolve(p.dir, path);
  if (!abs.startsWith(p.dir)) {
    throw new Error("稿的路径跨出了项目目录");
  }
  if (existsSync(abs)) {
    throw new Error(`文件 "${path}" 已经存在`);
  }
  if (!path.endsWith(".dc.html")) {
    throw new Error("稿的路径必须以 .dc.html 结尾");
  }

  let content: string;
  let sourceDesc: string;

  switch (source.kind) {
    case "blank": {
      const title = source.title ?? basename(path).replace(/\.dc\.html$/, "");
      content = blankDraftContent(title);
      sourceDesc = "空白骨架";
      break;
    }
    case "copy": {
      const srcAbs = resolve(p.dir, source.sourceFile);
      if (!existsSync(srcAbs)) {
        throw new Error(`源稿 "${source.sourceFile}" 不存在`);
      }
      content = await readFile(srcAbs, "utf8");
      sourceDesc = "复制自 " + source.sourceFile;
      break;
    }
    case "component": {
      const title = source.title ?? basename(path).replace(/\.dc\.html$/, "");
      content = componentWrapperDraft(source.componentName, title);
      sourceDesc = "组件 " + source.componentName + " 的包装稿";
      break;
    }
    case "template": {
      if (!existsSync(source.templatePath)) {
        throw new Error(`模板文件 "${source.templatePath}" 不存在`);
      }
      content = await readFile(source.templatePath, "utf8");
      sourceDesc = "模板 " + basename(source.templatePath);
      break;
    }
    default: {
      const _exhaustive: never = source;
      throw new Error("未知的稿来源类型");
    }
  }

  await writeAtomic(abs, content);

  return {
    path,
    source: sourceDesc,
    elements: 0,  // 由调用方校验后填入
  };
}

// ──────────────────────── M1-5: duplicate_draft ───────────────────────

export interface DuplicateDraftResult {
  originalPath: string;
  newPath: string;
  /** 新稿是否从 v1 开始（不复制快照） */
  startsAtV1: boolean;
}

/**
 * 复制一份稿。
 *
 * 新路径默认在原稿同目录下，名字是 `<原名> 副本.dc.html`。
 * 如果该名字冲突，自动加序号：`<原名> 副本 2.dc.html`。
 * 快照不跟着复制 —— 新稿从 v1 起（doc/12 M1-5 的建议）。
 */
export async function duplicateDraft(
  p: Project,
  path: string,
  opts: { newName?: string } = {},
): Promise<DuplicateDraftResult> {
  const srcAbs = draftPath(p, path);
  const srcDir = dirname(srcAbs);
  const srcBase = basename(path).replace(/\.dc\.html$/, "");

  // 确定新稿名
  let newBase = opts.newName ?? srcBase + " 副本";
  if (!newBase.endsWith(".dc.html")) newBase += ".dc.html";

  // 如果名字冲突，加序号
  let newAbs = resolve(srcDir, newBase);
  if (existsSync(newAbs)) {
    let i = 2;
    const baseWithoutExt = newBase.replace(/\.dc\.html$/, "");
    do {
      newBase = `${baseWithoutExt} ${i}.dc.html`;
      newAbs = resolve(srcDir, newBase);
      i++;
    } while (existsSync(newAbs) && i < 100);
  }

  // 复制内容
  const content = await readFile(srcAbs, "utf8");
  await writeAtomic(newAbs, content);

  const newRel = newAbs.slice(p.dir.length + 1).split(sep).join("/");
  return {
    originalPath: path,
    newPath: newRel,
    startsAtV1: true,
  };
}

// ──────────────────────── M1-8: create_folder ───────────────────────

export interface CreateFolderResult {
  path: string;
  /** 目录下已有的稿数 */
  draftsInFolder: number;
}

/** 在项目目录下创建一个子目录。 */
export async function createFolder(
  p: Project,
  folderPath: string,
): Promise<CreateFolderResult> {
  const abs = resolve(p.dir, folderPath);
  if (!abs.startsWith(p.dir)) {
    throw new Error("目录路径跨出了项目目录");
  }

  await mkdir(abs, { recursive: true });

  // 统计目录下的稿数
  const { listDrafts } = await import("./project.js");
  const allDrafts = await listDrafts(p);
  const draftsInFolder = allDrafts.filter((a) => a.startsWith(abs + "/") || a.startsWith(abs + sep)).length;

  return {
    path: folderPath,
    draftsInFolder,
  };
}

// ──────────────────────── M1-9: update_project ───────────────────────

export interface UpdateProjectOpts {
  title?: string;
  designSystemDir?: string | null;   // null 表示清除
  designSystemAlias?: string;
  tokens?: string | null;
  icons?: string | null;
  elementsWarn?: number;
  elementsHard?: number;
}

export interface UpdateProjectResult {
  name: string;
  title: string;
  /** 更新了哪些字段 */
  updated: string[];
}

/** 更新项目配置。 */
export async function updateProject(
  p: Project,
  opts: UpdateProjectOpts,
): Promise<UpdateProjectResult> {
  const config = { ...p.config };
  const updated: string[] = [];

  if (opts.title !== undefined) {
    config.title = opts.title;
    updated.push("title");
  }
  if (opts.designSystemDir !== undefined) {
    if (opts.designSystemDir === null) {
      delete config.designSystem;
    } else {
      config.designSystem = {
        dir: opts.designSystemDir,
        alias: opts.designSystemAlias || config.designSystem?.alias || "@ds",
      };
    }
    updated.push("designSystem");
  } else if (opts.designSystemAlias !== undefined) {
    if (config.designSystem) {
      config.designSystem.alias = opts.designSystemAlias;
      updated.push("designSystem.alias");
    }
  }
  if (opts.tokens !== undefined) {
    if (opts.tokens === null) delete config.tokens;
    else config.tokens = opts.tokens;
    updated.push("tokens");
  }
  if (opts.icons !== undefined) {
    if (opts.icons === null) delete config.icons;
    else config.icons = opts.icons;
    updated.push("icons");
  }
  if (opts.elementsWarn !== undefined || opts.elementsHard !== undefined) {
    config.limits = {
      elementsWarn: opts.elementsWarn ?? p.limits.elementsWarn,
      elementsHard: opts.elementsHard ?? p.limits.elementsHard,
    };
    updated.push("limits");
  }

  // 写回 project.json
  const configPath = join(p.dir, "project.json");
  await writeAtomic(configPath, JSON.stringify(config, null, 2) + "\n");

  return {
    name: config.name || p.name,
    title: config.title || p.title,
    updated,
  };
}

// ──────────────────────── M1-10: archive/delete_project ───────────────────────

export interface ArchiveProjectResult {
  name: string;
  archivePath: string;
  /** 是否从 projectsRoot 下移走了 */
  movedFromRoot: boolean;
}

/**
 * 归档项目：把项目目录打包/移到指定位置。
 * archiveDir 是归档目录，项目会被移到这里。
 * 不给 archiveDir 时默认 projectsRoot 同级下的 `.archived` 目录。
 */
export async function archiveProject(
  p: Project,
  archiveDir?: string,
): Promise<ArchiveProjectResult> {
  const { mkdir } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");

  const dest = archiveDir ?? join(TOOL_ROOT, ".archived");
  await mkdir(dest, { recursive: true });

  const destPath = join(dest, basename(p.dir));
  if (existsSync(destPath)) {
    throw new Error(`归档目录已有同名项目 "${destPath}"`);
  }

  await rename(p.dir, destPath);

  return {
    name: p.name,
    archivePath: destPath,
    movedFromRoot: p.dir.startsWith(projectsRoot()),
  };
}

/** 删除项目：移到归档目录（二次确认由调用方处理）。 */
export async function deleteProject(
  p: Project,
): Promise<ArchiveProjectResult> {
  return await archiveProject(p);
}
