/** 钉在节点上的评论（doc/12 M6-2，决策 doc/11 Q14）。
 *
 * 存 <项目>/.umbrastudio/comments.json —— 和会话一样属于项目，不进稿。
 * 一条评论 = 稿 + 节点地址 + 一句话；可标「已处理」；会话面板能把它一键发给 AI（走方式 ②）。
 * 节点地址会随内容变（doc/09 §二）：改过的节点旧地址找不到时，评论仍保留，只是钉子画不出来 ——
 * 界面上标「节点已变」，不静默丢。
 */
import { existsSync } from "node:fs";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { writeAtomic } from "./normalize.js";

export interface Comment {
  id: string;
  file: string;
  node: string;
  tag?: string;
  text: string;
  createdAt: string;
  resolved: boolean;
  resolvedAt: string | null;
}

function file(projectDir: string): string { return join(projectDir, ".umbrastudio", "comments.json"); }

export async function listComments(projectDir: string, draft?: string): Promise<Comment[]> {
  const f = file(projectDir);
  if (!existsSync(f)) return [];
  let all: Comment[] = [];
  try { all = JSON.parse(await readFile(f, "utf8")) as Comment[]; } catch { all = []; }
  if (draft) all = all.filter((c) => c.file === draft);
  return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function save(projectDir: string, all: Comment[]): Promise<void> {
  await mkdir(join(projectDir, ".umbrastudio"), { recursive: true });
  await writeAtomic(file(projectDir), JSON.stringify(all, null, 1) + "\n");
}

export async function addComment(projectDir: string, c: { file: string; node: string; tag?: string; text: string }): Promise<Comment> {
  const text = c.text.trim();
  if (!text) throw new Error("评论不能为空");
  const all = await listComments(projectDir);
  const item: Comment = { id: randomBytes(6).toString("hex"), file: c.file, node: c.node, tag: c.tag, text, createdAt: new Date().toISOString(), resolved: false, resolvedAt: null };
  all.push(item);
  await save(projectDir, all);
  return item;
}

export async function updateComment(projectDir: string, id: string, patch: { text?: string; resolved?: boolean }): Promise<Comment> {
  const all = await listComments(projectDir);
  const c = all.find((x) => x.id === id);
  if (!c) throw new Error(`没有这条评论 ${id}`);
  if (typeof patch.text === "string" && patch.text.trim()) c.text = patch.text.trim();
  if (typeof patch.resolved === "boolean") { c.resolved = patch.resolved; c.resolvedAt = patch.resolved ? new Date().toISOString() : null; }
  await save(projectDir, all);
  return c;
}

export async function deleteComment(projectDir: string, id: string): Promise<{ deleted: boolean }> {
  const all = await listComments(projectDir);
  const next = all.filter((x) => x.id !== id);
  if (next.length === all.length) return { deleted: false };
  await save(projectDir, next);
  return { deleted: true };
}
