/** 跨稿全局搜索：在一份项目的所有稿里找 token / 文案 / 组件引用。
 *
 * 返回每条匹配的「稿路径 + 行号 + 上下文行」。
 * 不依赖 AI —— 纯 grep 级文本匹配。
 */

import { Project, listDrafts } from "./project.js";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";

export interface SearchHit {
  file: string;
  line: number;
  /** 匹配行内容（前后各一行上下文） */
  context: string;
  /** 匹配类型 */
  kind: "token" | "text" | "import" | "css";
}

export interface SearchResult {
  query: string;
  hits: SearchHit[];
  total: number;
  /** 搜了多少份稿 */
  scanned: number;
}

/** 在一行里找匹配的模式 */
function matchLine(line: string, query: string): SearchHit["kind"] | null {
  const q = query.toLowerCase();
  const lower = line.toLowerCase();

  // Token 引用: var(--name), @ds.name
  if (
    (line.includes("var(--") || line.includes("@ds.")) && lower.includes(q)
  ) {
    return "token";
  }
  // 组件 import
  if (line.includes("dc-import") && lower.includes(q)) {
    return "import";
  }
  // CSS 引用
  if (line.includes("stylesheet") && lower.includes(q)) {
    return "css";
  }
  // 纯文本匹配（忽略大小写）
  if (lower.includes(q)) {
    return "text";
  }
  return null;
}

/** 跨稿搜索 */
export async function globalSearch(
  p: Project,
  query: string,
  limit = 100,
): Promise<SearchResult> {
  const draftFiles = await listDrafts(p);
  const hits: SearchHit[] = [];

  for (const draftFile of draftFiles) {
    try {
      const content = await readFile(draftFile, "utf-8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const kind = matchLine(lines[i]!, query);
        if (kind) {
          const start = Math.max(0, i - 1);
          const end = Math.min(lines.length, i + 2);
          hits.push({
            file: draftFile,
            line: i + 1, // 1-based
            context: lines.slice(start, end).join("\n"),
            kind,
          });
          if (hits.length >= limit) break;
        }
      }
      if (hits.length >= limit) break;
    } catch {
      // 读不到的稿跳过（不是错，只是静默跳过）
    }
  }

  return {
    query,
    hits,
    total: hits.length,
    scanned: draftFiles.length,
  };
}
