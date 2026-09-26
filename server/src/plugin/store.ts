import { readFile, readdir, rm, stat } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { STATE_ROOT, TOOL_ROOT } from "../project.js";
import { checkManifest, type PluginManifest } from "./manifest.js";
import { PLUGIN_DEFAULT_PRIORITY, isBuiltinKind, registerKind, unregisterKindsFrom } from "../shared/kinds.js";

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

/** **内置插件**：跟主程序一起发、免费、卸不掉（`doc/20` §七：「默认我们会提供文本的编辑插件」）。
 *
 *  ⚠️ 它在 `TOOL_ROOT` 而不是 `STATE_ROOT` —— 打包后那是 `.app` 里的**只读**位置，
 *  正好对：内置插件本来就不该能删能改。用户买的插件才进 `STATE_ROOT`（可写）。
 *  **两个 root 混了在开发模式下测不出来**（开发时都可写，`00` §63.1 栽过）。 */
export const BUNDLED_DIR = join(TOOL_ROOT, "plugins");

export interface InstalledPlugin {
  manifest: PluginManifest;
  /** 这一版在盘上的绝对路径 */
  dir: string;
  /** 内置的（跟主程序一起发）：免费、卸不掉 */
  bundled: boolean;
  /** 清单有毛病时装不上，但要**列得出来**并说清为什么 —— 
   *  静静不显示的话，用户只会看到「我装的插件不见了」 */
  problems: Array<{ field: string; why: string }>;
}

/** 扫一遍装了什么。坏的也列出来，带上毛病。
 *  **内置的排在前面**，用户装的在后 —— 同 id 时以用户装的为准（他可能装了更新的一版）。 */
export async function listInstalled(): Promise<InstalledPlugin[]> {
  const out: InstalledPlugin[] = [];
  for (const root of [BUNDLED_DIR, PLUGINS_DIR]) await scanRoot(root, root === BUNDLED_DIR, out);
  return out;
}

async function scanRoot(root: string, bundled: boolean, out: InstalledPlugin[]): Promise<void> {
  if (!existsSync(root)) return;
  for (const id of await readdir(root)) {
    const idDir = join(root, id);
    if (!(await stat(idDir).catch(() => null))?.isDirectory()) continue;
    const v = await pickVersion(idDir);
    if (!v) continue;
    const dir = join(idDir, v);
    let raw: unknown = null;
    try { raw = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")); }
    catch (e) { out.push({ manifest: { id } as PluginManifest, dir, bundled, problems: [{ field: "manifest.json", why: `读不了或不是合法 JSON：${(e as Error).message}` }] }); continue; }
    const r = checkManifest(raw);
    /* 清单里的 id 必须和目录名一致 —— 不一致的话，同一个插件会按两个身份存在：
       按目录名卸载，按清单 id 注册能力，卸不干净。 */
    const idMismatch = r.ok && r.manifest!.id !== id
      ? [{ field: "id", why: `清单里写的是 ${r.manifest!.id}，但装在 ${id} 目录下` }] : [];
    const row = { manifest: (r.manifest ?? { id } as PluginManifest), dir, bundled, problems: [...r.problems, ...idMismatch] };
    /* 同 id 覆盖：用户装的那一份压过内置 —— 他可能装了更新的一版 */
    const at = out.findIndex((x) => x.manifest.id === row.manifest.id);
    if (at >= 0) out[at] = row; else out.push(row);
  }
}

export async function uninstall(id: string): Promise<boolean> {
  /* 内置的卸不掉。**这里要挡住** —— 不挡的话打包后它会去删 `.app` 里的目录，
     在 macOS 上那会毁掉签名，应用下次打开就「已损坏」（`00` §六十三 栽过同类的）。 */
  const dir = join(PLUGINS_DIR, id);
  if (!existsSync(dir)) return false;
  /* 只删插件自己的目录。**插件改过的文件不动** —— 那是用户的东西（`doc/20` §6.4） */
  await rm(dir, { recursive: true, force: true });
  return true;
}

/** 一个插件当前用的那一版在哪（静态托管要用）。找不到给 null。
 *  ⚠️ **同步的** —— 它在 http 请求路径上，异步会让每个静态文件多一次事件循环往返。 */
/** 用哪一版：**先看 `current` 指针**，没有就用最新的。
 *  指针是 M11-6 加的 —— 切版本 / 回退靠改它，所以读的地方必须认它，
 *  不认的话「切回上一版」点了没反应（列表显示切了，加载的还是新版）。 */
async function pickVersion(idDir: string): Promise<string | null> {
  const versions = (await readdir(idDir)).filter((x) => x !== "current").sort();
  try {
    const cur = (await readFile(join(idDir, "current"), "utf8")).trim();
    if (cur && versions.includes(cur)) return cur;
  } catch { /* 没指针，用最新 */ }
  return versions[versions.length - 1] ?? null;
}

export function pluginDirOf(id: string): string | null {
  /* 用户装的优先 —— 和 `listInstalled` 的覆盖顺序保持一致。
     不一致的话会出现「列表里显示新版，实际加载的是内置旧版」这种最难查的错。 */
  for (const root of [PLUGINS_DIR, BUNDLED_DIR]) {
    const idDir = join(root, id);
    if (!existsSync(idDir)) continue;
    try {
      const versions = readdirSync(idDir).filter((x) => x !== "current").sort();
      let v = versions[versions.length - 1];
      /* 同步读指针 —— 这个函数在 http 请求路径上，异步会给每个静态文件多一次往返 */
      try {
        const cur = readFileSync(join(idDir, "current"), "utf8").trim();
        if (cur && versions.includes(cur)) v = cur;
      } catch { /* 没指针 */ }
      if (v) return join(idDir, v);
    } catch { /* 下一个 root */ }
  }
  return null;
}

/** 把装好的插件加的文件类型注册进**服务端**的类型表（M11-5）。
 *
 *  ⚠️ **这一步漏掉过一次。** 前端和服务端各有一份类型表（`shared/kinds.ts` 是同一份源码，
 *  但跑在两个进程里，是两个实例）。只在前端注册的话：详情区能认出这种文件、
 *  用插件的视图打开，但**目录列里的类型列和图标还是「其他」** ——
 *  因为那一列是服务端 `list_files` 算好给的。
 *  症状是「插件装上了，但文件在列表里看着没变化」。
 */
export async function registerPluginKinds(): Promise<{ id: string; kinds: string[] }[]> {
  /* ⚠️ **必须可重复调**（M11-10）：装完 / 切版本 / 卸完都要再跑一次。
     先把插件加的类型全摘掉再重新注册 —— 不摘的话第二次调用会全部撞「已经有了」，
     而那时新装的插件一种类型都注册不上，症状是「装了没反应」。
     内置类型不受影响（`unregisterKindsFrom` 只摘带 `from` 的）。 */
  for (const p of await listInstalled()) unregisterKindsFrom(p.manifest.id);
  const out: { id: string; kinds: string[] }[] = [];
  for (const p of await listInstalled()) {
    if (p.problems.length) continue;
    const ids: string[] = [];
    for (const k of p.manifest.kinds ?? []) {
      /* **认领**内置类型：类型本来就在表里，不用（也不能）再注册一次。
         只有内置插件能这么做 —— 第三方插件认领 `dc` 就等于劫持设计稿。 */
      if (isBuiltinKind(k.id)) { if (p.bundled) ids.push(k.id); continue; }
      try {
        registerKind({
          id: k.id, label: k.label, icon: k.icon, priority: k.priority ?? PLUGIN_DEFAULT_PRIORITY,
          textual: k.textual, match: (n) => k.ext.some((e) => n.endsWith(e)), from: p.manifest.id,
        });
        ids.push(k.id);
      } catch { /* 撞车 / 想劫持内置类型：跳过这一种，别让一个坏插件把整轮注册带崩 */ }
    }
    if (ids.length) out.push({ id: p.manifest.id, kinds: ids });
  }
  return out;
}
