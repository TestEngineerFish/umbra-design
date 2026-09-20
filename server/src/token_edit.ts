/** 设计系统 token 编辑：只改取值，不改结构。
 *
 * 改之前自动分析影响面（哪些稿引用了这个 token）。
 * 改完后受影响的稿会在下一次渲染时反映新值。
 */

import { readFile, writeFile } from "node:fs/promises";
import { Project } from "./project.js";
import { globalSearch } from "./search.js";

export interface TokenEditResult {
  /** 被改的 token 路径 */
  path: string;
  /** 旧值 */
  oldValue: string;
  /** 新值 */
  newValue: string;
  /** 受影响的稿数 */
  affectedDrafts: number;
  /** 受影响稿的文件列表 */
  affectedFiles: string[];
  /** 是否真的改了（旧值 != 新值） */
  changed: boolean;
}

/** 按路径设置 token 值，返回影响面 */
export async function setTokenValue(
  p: Project,
  tokenPath: string,
  newValue: string,
): Promise<TokenEditResult> {
  if (!p.tokensPath) {
    throw new Error("项目没有配置 tokens 文件");
  }

  // 读取 tokens JSON
  const jsonStr = await readFile(p.tokensPath, "utf-8");
  const tokens = JSON.parse(jsonStr);

  // 按点号路径取值
  const parts = tokenPath.split(".");
  let obj: any = tokens;
  for (const part of parts.slice(0, -1)) {
    if (obj[part] === undefined) {
      throw new Error(`token 路径不存在：${parts.slice(0, parts.indexOf(part) + 1).join(".")}`);
    }
    obj = obj[part];
  }
  const lastPart = parts[parts.length - 1]!;
  if (obj[lastPart] === undefined) {
    throw new Error(`token 不存在：${tokenPath}`);
  }

  const oldValue = String(obj[lastPart]);

  // 如果值没变，直接返回
  if (oldValue === newValue) {
    return {
      path: tokenPath,
      oldValue,
      newValue,
      affectedDrafts: 0,
      affectedFiles: [],
      changed: false,
    };
  }

  // 分析影响面：搜索引用了这个 token 的稿
  // token 在稿里通常以 var(--kebab-name) 或 @ds.dot.path 形式出现
  // 我们用 token 路径的最后一段作为搜索词
  const searchQuery = parts[parts.length - 1]!;
  const searchResult = await globalSearch(p, searchQuery, 500);
  const affectedFiles = searchResult.hits.map((h) => h.file);

  // 改值
  obj[lastPart] = newValue;

  // 写回
  await writeFile(p.tokensPath, JSON.stringify(tokens, null, 2), "utf-8");

  return {
    path: tokenPath,
    oldValue,
    newValue,
    affectedDrafts: affectedFiles.length,
    affectedFiles,
    changed: true,
  };
}
