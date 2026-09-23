/** 工作区：最近项目列表。M1-2
 *
 * 存在工具自己的目录下（TOOL_ROOT/.umbrastudio/workspace.json），
 * 不属于任何设计项目 —— 这是工具行为，不是设计事实。
 *
 * 每条记录：目录绝对路径 + 名称 + 最后打开时间 + 打开次数。
 * 列表按最后打开时间倒排；目录不存在时标「找不到」。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOL_ROOT } from "./project.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const UD_DIR = join(TOOL_ROOT, ".umbrastudio");
const WORKSPACE_FILE = join(UD_DIR, "workspace.json");

const MAX_RECENT = 20;

interface RecentEntry {
  dir: string;
  name: string;
  title: string;
  lastOpened: string;   // ISO date
  openCount: number;
}

interface Workspace {
  recents: RecentEntry[];
}

async function readWorkspace(): Promise<Workspace> {
  if (!existsSync(WORKSPACE_FILE)) return { recents: [] };
  try {
    const raw = await readFile(WORKSPACE_FILE, "utf8");
    return JSON.parse(raw) as Workspace;
  } catch {
    return { recents: [] };
  }
}

async function writeWorkspace(w: Workspace): Promise<void> {
  await mkdir(UD_DIR, { recursive: true });
  await writeFile(WORKSPACE_FILE, JSON.stringify(w, null, 2) + "\n", "utf8");
}

/** 记录一次项目打开。添加到最近列表或更新已有条目的时间。 */
export async function touchProject(dir: string, name: string, title?: string): Promise<void> {
  const w = await readWorkspace();
  const existing = w.recents.findIndex((r) => r.dir === dir);
  const entry: RecentEntry = {
    dir,
    name,
    title: title ?? name,
    lastOpened: new Date().toISOString(),
    openCount: 1,
  };

  if (existing >= 0) {
    entry.openCount = (w.recents[existing] as RecentEntry).openCount + 1;
    w.recents.splice(existing, 1);
  }

  w.recents.unshift(entry);
  // 只保留最近的 MAX_RECENT 条
  if (w.recents.length > MAX_RECENT) w.recents.length = MAX_RECENT;
  await writeWorkspace(w);
}

/** 列出最近打开过的项目。
 *  @param limit 最多返回几条，默认全部
 */
export async function listRecentProjects(limit?: number): Promise<{
  recents: Array<RecentEntry & { exists: boolean }>;
  total: number;
}> {
  const w = await readWorkspace();
  const recents = w.recents
    .slice(0, limit ?? w.recents.length)
    .map((r) => ({ ...r, exists: existsSync(join(r.dir, "project.json")) }));
  return { recents, total: w.recents.length };
}

/** 从最近列表移除一个项目。不影响项目目录本身。 */
export async function removeRecentProject(dir: string): Promise<{ removed: boolean }> {
  const w = await readWorkspace();
  const before = w.recents.length;
  w.recents = w.recents.filter((r) => r.dir !== dir);
  if (w.recents.length < before) {
    await writeWorkspace(w);
    return { removed: true };
  }
  return { removed: false };
}

/** 清空最近项目列表。 */
export async function clearRecentProjects(): Promise<void> {
  await writeWorkspace({ recents: [] });
}
