import { readFile, readdir, rm, stat } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { STATE_ROOT } from "../project.js";
import { checkManifest, type PluginManifest } from "./manifest.js";

/** 插件在盘上住哪、怎么列（M11-4）。
 *
 *  ⚠️ **一定是 `STATE_ROOT`，不能是 `TOOL_ROOT`**（`00` §63.1 栽过）：
 *  打包后 `TOOL_ROOT` 在 `.app` 里是**只读**的，而插件要能装、能删、能更新。
 *  这一类缺陷开发模式下测不出来 —— 开发时两个 root 都可写。
 *
 *  目录形状 `STATE_ROOT/.umbrastudio/plugins/<id>/<version>/`：
 *  版本各占一个目录，**切换是改指针，回退只要把指针改回去**（`doc/20` §6.3）。
 */
export const PLUGINS_DIR = join(STATE_ROOT, ".umbrastudio", "plugins");

export interface InstalledPlugin {
  manifest: PluginManifest;
  /** 这一版在盘上的绝对路径 */
  dir: string;
  /** 清单有毛病时装不上，但要**列得出来**并说清为什么 —— 
   *  静静不显示的话，用户只会看到「我装的插件不见了」 */
  problems: Array<{ field: string; why: string }>;
}

/** 扫一遍装了什么。坏的也列出来，带上毛病。 */
export async function listInstalled(): Promise<InstalledPlugin[]> {
  if (!existsSync(PLUGINS_DIR)) return [];
  const out: InstalledPlugin[] = [];
  for (const id of await readdir(PLUGINS_DIR)) {
    const idDir = join(PLUGINS_DIR, id);
    if (!(await stat(idDir).catch(() => null))?.isDirectory()) continue;
    const versions = (await readdir(idDir)).sort();
    const v = versions[versions.length - 1];     // 先用最新一版；指针机制等 M11-6
    if (!v) continue;
    const dir = join(idDir, v);
    let raw: unknown = null;
    try { raw = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")); }
    catch (e) { out.push({ manifest: { id } as PluginManifest, dir, problems: [{ field: "manifest.json", why: `读不了或不是合法 JSON：${(e as Error).message}` }] }); continue; }
    const r = checkManifest(raw);
    /* 清单里的 id 必须和目录名一致 —— 不一致的话，同一个插件会按两个身份存在：
       按目录名卸载，按清单 id 注册能力，卸不干净。 */
    const idMismatch = r.ok && r.manifest!.id !== id
      ? [{ field: "id", why: `清单里写的是 ${r.manifest!.id}，但装在 ${id} 目录下` }] : [];
    out.push({ manifest: (r.manifest ?? { id } as PluginManifest), dir, problems: [...r.problems, ...idMismatch] });
  }
  return out;
}

export async function uninstall(id: string): Promise<boolean> {
  const dir = join(PLUGINS_DIR, id);
  if (!existsSync(dir)) return false;
  /* 只删插件自己的目录。**插件改过的文件不动** —— 那是用户的东西（`doc/20` §6.4） */
  await rm(dir, { recursive: true, force: true });
  return true;
}

/** 一个插件当前用的那一版在哪（静态托管要用）。找不到给 null。
 *  ⚠️ **同步的** —— 它在 http 请求路径上，异步会让每个静态文件多一次事件循环往返。 */
export function pluginDirOf(id: string): string | null {
  const idDir = join(PLUGINS_DIR, id);
  if (!existsSync(idDir)) return null;
  try {
    const versions = readdirSync(idDir).sort();
    const v = versions[versions.length - 1];
    return v ? join(idDir, v) : null;
  } catch { return null; }
}
