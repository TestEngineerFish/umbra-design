/** 落盘前的确定性改写。doc/00 §5.2
 *
 * 三条保证里的第一条：归一化落盘。做四件事，顺序固定：
 *   ① 归一化编码与换行   ② @ds 别名展开   ③ __resources 注入   ④ 运行时副本分发
 *
 * ②③ 是同一类事 —— **源头写抽象，落盘写具体**。设计稿里不写真实 ds 路径、
 * 不写 React 的本地映射；这两件由工具在落盘那一刻填。
 */
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { RUNTIME_DIR, expandDsAlias, type Project } from "./project.js";

export const MARK_OPEN = "<!-- umbradesign:resources -->";
export const MARK_CLOSE = "<!-- /umbradesign:resources -->";

/** support.js 里硬编码的 CDN URL（doc/05 §1.2）→ 同层本地副本 */
export const RESOURCE_MAP: Record<string, string> = {
  "https://unpkg.com/react@18.3.1/umd/react.production.min.js": "./react.production.min.js",
  "https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js": "./react-dom.production.min.js",
};

/** 与稿同层的运行时三件套。`<script src>` 相对文档解析，所以每个放稿的目录都要有一份。 */
export const RUNTIME_FILES = ["support.js", "react.production.min.js", "react-dom.production.min.js"];

/** ① UTF-8 无 BOM、LF、末尾恰好一个换行 */
export function normalizeSource(s: string): string {
  return s.replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/\n*$/, "\n");
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function stripResourceBlock(src: string): string {
  const re = new RegExp(`[ \\t]*${esc(MARK_OPEN)}[\\s\\S]*?${esc(MARK_CLOSE)}\\n?`, "g");
  return src.replace(re, "");
}

function resourceBlock(): string {
  const json = JSON.stringify(RESOURCE_MAP, null, 2).replace(/\n/g, "\n  ");
  return `${MARK_OPEN}\n<script>window.__resources = ${json};</script>\n${MARK_CLOSE}\n`;
}

export interface InjectResult { out: string; injected: boolean; reason?: string }

/** ③ 在第一个引 support.js 的 <script> 之前插入映射块。幂等：先删旧块再写新块。 */
export function injectResources(src: string): InjectResult {
  const body = stripResourceBlock(src);
  const m = body.match(/[ \t]*<script[^>]*\bsrc\s*=\s*["'][^"']*support\.js["'][^>]*>\s*<\/script>/i);
  if (!m || m.index === undefined) {
    return { out: body, injected: false, reason: "找不到引 support.js 的 script 标签，没有注入点" };
  }
  return { out: body.slice(0, m.index) + resourceBlock() + body.slice(m.index), injected: true };
}

/** ①②③ 一起做。返回改写后的内容与做了什么。 */
export function prepareForDisk(p: Project, content: string) {
  const steps: string[] = [];
  let out = normalizeSource(content);
  steps.push("归一化（UTF-8 无 BOM / LF / 末尾单换行）");

  const expanded = expandDsAlias(p, out);
  if (expanded !== out) { out = expanded; steps.push(`@ds → ${p.dsDir}`); }

  const r = injectResources(out);
  out = r.out;
  steps.push(r.injected ? "注入 __resources 离线映射" : `未注入 __resources（${r.reason}）`);

  return { content: out, steps, injected: r.injected };
}

/** ④ 保证稿所在目录有运行时副本；版本不一致（大小不同）就刷新。 */
export async function ensureRuntimeBeside(draftAbs: string): Promise<string[]> {
  const dir = dirname(draftAbs);
  const done: string[] = [];
  for (const name of RUNTIME_FILES) {
    const srcFile = join(RUNTIME_DIR, name);
    if (!existsSync(srcFile)) continue;
    const dstFile = join(dir, name);
    let need = !existsSync(dstFile);
    if (!need) {
      const [a, b] = await Promise.all([stat(srcFile), stat(dstFile)]);
      need = a.size !== b.size;
    }
    if (need) { await mkdir(dir, { recursive: true }); await copyFile(srcFile, dstFile); done.push(name); }
  }
  return done;
}

/** 缺哪些运行时文件（给诊断用，不改盘） */
export function missingRuntime(draftAbs: string): string[] {
  const dir = dirname(draftAbs);
  return RUNTIME_FILES.filter((n) => existsSync(join(RUNTIME_DIR, n)) && !existsSync(join(dir, n)));
}

/** 原子写：先写临时文件再 rename，避免半截文件被浏览器读到。 */
export async function writeAtomic(abs: string, content: string): Promise<void> {
  await mkdir(dirname(abs), { recursive: true });
  const tmp = abs + ".umbradesign.tmp";
  await writeFile(tmp, content, "utf8");
  const { rename } = await import("node:fs/promises");
  await rename(tmp, abs);
}

export async function readIfExists(abs: string): Promise<string | null> {
  try { return await readFile(abs, "utf8"); } catch { return null; }
}

export function resolveInProject(p: Project, path: string): string {
  return resolve(p.dir, path);
}
