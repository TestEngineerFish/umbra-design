import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { TOOL_ROOT } from "../project.js";

/** 插件市场的目录（M11-6 接线）。
 *
 *  **现在是本地固定清单**，以后换成服务端接口。放 `TOOL_ROOT/plugins/catalog.json`。
 *
 *  ⚠️ 这一层**不是权威**：一个插件「要什么权限」的权威出处是**包里的 manifest**，
 *  目录里那份只是给用户装之前看一眼的。两者不一致时以包里的为准 ——
 *  否则伪造目录就能让用户看到一份假的权限清单（`install.ts` 里记过同一条）。
 */
export interface CatalogEntry {
  id: string; name: string; author: string; version: string;
  /** 积分。0 = 免费；`builtin` 的不显示价格 */
  price: number;
  builtin?: boolean;
  brief: string;
  /** 它认领哪些扩展名 —— 市场按这个筛，也用来回答「有没有插件能编辑 .xyz」 */
  formats: string[];
  permissions: { files?: string[]; net?: string[] };
  size?: string;
  updated?: string;
  /** B 面：给大模型的能力。`sample` 用来算那道「读写账」 */
  tools?: Array<{
    name: string; id: string; desc: string;
    sample?: { task: string; without: "whole" | "none" | string; with: string };
  }>;
}

/** 扩展名 → 大类。**前端和这里各有一份是有意的**：
 *  前端那份用来筛选（纯展示），这一份用来回答「有没有插件能编辑它」（要和目录一致）。
 *  ⚠️ 不要把它塞进插件清单 —— 分类是市场的事，不是插件的事：
 *  同一个插件在不同市场里可以归不同的类。 */
export const KIND_OF_EXT: Record<string, string> = {
  ".md": "文本", ".markdown": "文本", ".txt": "文本", ".srt": "文本", ".json": "文本",
  ".csv": "表格", ".tsv": "表格", ".xlsx": "表格",
  ".mp4": "视频", ".mov": "视频", ".webm": "视频",
  ".html": "网页", ".htm": "网页",
};

const FILE = join(TOOL_ROOT, "plugins", "catalog.json");

/** 读目录。没有这个文件就是空市场 —— **空市场不是错误**，
 *  第一期很可能就只有内置的那一个。 */
export async function readCatalog(): Promise<CatalogEntry[]> {
  if (!existsSync(FILE)) return [];
  try {
    const raw = JSON.parse(await readFile(FILE, "utf8")) as { plugins?: CatalogEntry[] };
    return raw.plugins ?? [];
  } catch { return []; }
}

/** 有没有插件能编辑这个扩展名。**✎ 那颗钮要问它**（用户 2026-09-26 定的模型）。 */
export async function whoHandles(ext: string): Promise<CatalogEntry[]> {
  const e = ext.toLowerCase();
  return (await readCatalog()).filter((c) => c.formats.some((f) => f.toLowerCase() === e));
}
