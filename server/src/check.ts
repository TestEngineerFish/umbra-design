/** 渲染体检记录的持久化。doc/00 §十五
 *
 * 为什么要存：`render_check` 的读数原来只活在一次调用的返回里，索引页因此只能
 * 靠「截图文件在不在」判健康 —— 而截图**不会随稿改动失效**，改完稿不重新体检，
 * 索引上仍然显示「通过」。这是静默失败的一种，按 `04` §二的判据必须堵掉。
 *
 * 所以记录里存 `srcSha256`：索引一比对就知道这份读数还描不描述当前的文件。
 * 对不上就是「过期」，等同于没体检 —— 宁可说不知道，不可以说通过。
 *
 * 一份稿一个文件（和 snapshots 同样的扁平命名），避免并发体检互相覆盖。
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Project } from "./project.js";

export interface CheckRecord {
  file: string;
  checkedAt: string;
  /** 体检时那一版源码的 sha256 —— 用来判读数有没有过期 */
  srcSha256: string;
  alive: boolean;
  nodeCount: number;
  renderMs: number;
  viewport: { width: number; height: number };
  offline: boolean;
  screenshot: string | null;
  counts: {
    unresolvedHoles: number;
    missingResources: number;
    externalRequests: number;
    consoleWarnings: number;
  };
}

export const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function checkFile(p: Project, relPath: string): string {
  return join(p.dir, ".umbradesign", "checks", relPath.replace(/[\\/]/g, "__") + ".json");
}

export async function saveCheck(p: Project, rec: CheckRecord): Promise<string> {
  const f = checkFile(p, rec.file);
  await mkdir(join(p.dir, ".umbradesign", "checks"), { recursive: true });
  await writeFile(f, JSON.stringify(rec, null, 1) + "\n", "utf8");
  return f;
}

export async function readCheck(p: Project, relPath: string): Promise<CheckRecord | null> {
  const f = checkFile(p, relPath);
  if (!existsSync(f)) return null;
  try { return JSON.parse(await readFile(f, "utf8")) as CheckRecord; }
  catch { return null; }           // 记录坏了就当没体检，不要把工具搞挂
}
