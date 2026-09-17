/** 租户（设计项目）解析。doc/00 §三
 *
 * 要点：
 *  - 项目根只是默认在 UmbraDesign/projects，可由 --projects-root / UMBRADESIGN_PROJECTS_ROOT 指定。
 *    工具不追踪用户的项目，打包分发后 projects/ 甚至不在安装目录里。
 *  - 租户目录必须自包含：运行时副本与稿同层（不是 _runtime/ 子目录）。
 *  - git 自动探测租户目录下有没有 .git，不手填。
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, relative, dirname, sep } from "node:path";
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
