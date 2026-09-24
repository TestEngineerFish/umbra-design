/** 泛型文件层（M8-1 / M8-2，doc/01 §4.2）。
 *
 *  `.dc.html` 有自己那条唯一写入口（`write_draft`：归一化 → `@ds` 展开 → `__resources` →
 *  节点地址 → 语义快照 → changelog）。别的文件没有那套语义，但**同样不能裸写**：
 *  要有写前校验、要留得住上一版。所以这里给它们一条对应的路：
 *
 *      sha256 校验（Q8）→ 存一份原文快照 s<N> → 原子写 → 返回快照号
 *
 *  两条路的快照放在同一个目录（`.umbrastudio/snapshots/<路径>/`），靠前缀分开：
 *  稿是 `v<N>.json`（语义快照），别的文件是 `s<N>.json`（原文 + 元数据）。
 *  `listVersions` 只认 `v<N>`，互不干扰。
 *
 *  **不做的**：不归一化、不改编码、不动换行、不碰 frontmatter —— 写进去什么样，盘上就什么样（H5）。
 */
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { X } from "./codes.js";
import { err, ToolError } from "./envelope.js";
import { snapDir } from "./history.js";
import { isToolPage } from "./indexpage.js";
import { writeAtomic } from "./normalize.js";
import { listDrafts, type Project } from "./project.js";

/* 类型联合也只有一份（`shared/kinds.ts`）。这儿曾经自己写了一遍，
   加 `json` 时它没跟上，编译器当场就抓出来了 —— 这正是统一的用处。 */
export type { FileKind };

/** 文本文件的上限：超过就只给元数据，不把整份塞进响应 */
export const TEXT_MAX = 2 * 1024 * 1024;

/** 文件类型认定走 `shared/kinds.ts` 那一份唯一出处（M8-14）。
 *  以前这里有一份扩展名映射、前端 `layout.ts` 里还有一份，两份今天一致纯属运气 ——
 *  没有任何机制保证下次加扩展名时两边都会改。现在只有一处。 */
/* 文件类型的认定**只有一份**，在 `shared/kinds.ts` —— 前端 `app/` 也 import 同一份
   （`@shared/kinds`）。以前前后端各写一套 `kindOf`，两边迟早判不一样。
   注意是 import 进来再 re-export：`export {} from` 只转发，本模块内部还是取不到这个名字。 */
import { kindOf, isTextualPath, type FileKind } from "./shared/kinds.js";
export { kindOf };

/** 这个扩展名的内容能不能当文本读 */
/** 是不是文本 —— 走 shared 那一份（`.svg` 是图片但也是文本，只看 kind 会误判） */
export function isTextual(rel: string): boolean { return isTextualPath(rel); }

export function sha256(s: string | Buffer): string {
  return createHash("sha256").update(s).digest("hex");
}

/** 工具自己产的东西不算用户的文件（索引页、壳页、运行时副本、缩略图目录） */
const TOOL_FILES = new Set(["index-data.js", "support.js", "react.production.min.js", "react-dom.production.min.js", ".DS_Store"]);
function isToolArtifact(rel: string): boolean {
  const name = basename(rel);
  if (TOOL_FILES.has(name)) return true;
  if (isToolPage(name)) return true;
  return rel.split("/").some((seg) => seg === "_ds-tool" || seg === "_runtime" || seg.startsWith("."));
}

export interface FileEntry {
  /** 相对项目根，始终用 / 分隔 */
  path: string;
  name: string;
  kind: FileKind;
  isDir: boolean;
  size: number;
  updatedAt: string;
  /** 目录：里面有几项；dc：元素数由索引给，这里不算 */
  count?: number;
  /** 图片的原始尺寸（读不出来就没有这一项） */
  width?: number;
  height?: number;
  /** 文本文件的第一行有效内容，给目录视图的第二行摘录用 */
  excerpt?: string;
  /** 最新快照号：稿是 v<N>，别的文件是 s<N> */
  snapshot?: string;
}

export interface ListFilesResult {
  dir: string;
  entries: FileEntry[];
  /** 这一层里非目录文件的类型分布，给「自动网格」与 S1 的类型统计用 */
  types: { dc: number; md: number; image: number; other: number };
  /** 这一层实际有多少项（截断之前）。界面用它显示「还有 N 项」 */
  total: number;
  /** entries 是不是被截断过 */
  truncated: boolean;
}

/** 列一层目录（不递归）。目录在前，其余按更新时间倒序 —— 和 S12 定的顺序一致。 */
/** 一次最多返回多少条。超出的不传 —— 一个几千项的目录全传回去，
 *  光 JSON 就几 MB，而屏幕上一次也看不了那么多。设计侧第六轮定的口径：
 *  先给 200 条，末尾让界面显示「还有 N 项 · 全部显示」。 */
export const LIST_PAGE = 200;

export async function listFiles(p: Project, dirRel = "", limit = LIST_PAGE): Promise<ListFilesResult> {
  const abs = safeJoin(p, dirRel);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new ToolError(err(X.IO, dirRel || ".", { kind: "path", name: dirRel },
      `${dirRel || "项目根"} 不是一个目录`, { fix: "先用 list_files 看看上一层有什么" }));
  }
  const entries: FileEntry[] = [];
  const types = { dc: 0, md: 0, image: 0, other: 0 };
  for (const e of await readdir(abs, { withFileTypes: true })) {
    const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
    if (isToolArtifact(rel)) continue;
    const full = join(abs, e.name);
    let st;
    try { st = statSync(full); } catch { continue; }   // 刚被删掉的，跳过
    const entry: FileEntry = {
      path: rel, name: e.name, kind: kindOf(rel, e.isDirectory()), isDir: e.isDirectory(),
      size: e.isDirectory() ? 0 : st.size, updatedAt: st.mtime.toISOString(),
    };
    if (e.isDirectory()) {
      try { entry.count = (await readdir(full)).filter((x) => !isToolArtifact(`${rel}/${x}`)).length; } catch { entry.count = 0; }
    } else {
      if (entry.kind === "dc") types.dc++;
      else if (entry.kind === "md") types.md++;
      else if (entry.kind === "image") types.image++;
      else types.other++;
      if (entry.kind === "image") Object.assign(entry, await imageSize(full));
      if (isTextual(rel) && entry.kind !== "dc" && st.size <= TEXT_MAX) entry.excerpt = await firstLine(full);
      const snaps = await listSnapshots(p, rel);
      if (snaps.length) entry.snapshot = snaps[snaps.length - 1];
    }
    entries.push(entry);
  }
  entries.sort((a, b) => (a.isDir === b.isDir ? b.updatedAt.localeCompare(a.updatedAt) : a.isDir ? -1 : 1));
  /* 截断**在排序之后** —— 先截再排的话，给出去的 200 条就不是「最该先看的 200 条」，
     而是 readdir 碰巧先读到的那些。 */
  const total = entries.length;
  const page = limit > 0 && total > limit ? entries.slice(0, limit) : entries;
  return { dir: dirRel, entries: page, types, total, truncated: page.length < total };
}

/** 整个项目的类型统计（S1 的 `project.types`）。 */
export async function countTypes(p: Project): Promise<{ dc: number; md: number; image: number; other: number }> {
  const t = { dc: 0, md: 0, image: 0, other: 0 };
  const walk = async (dirRel: string): Promise<void> => {
    for (const e of await readdir(safeJoin(p, dirRel), { withFileTypes: true })) {
      const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
      if (isToolArtifact(rel)) continue;
      if (e.isDirectory()) { await walk(rel); continue; }
      const k = kindOf(rel);
      if (k === "dc") t.dc++; else if (k === "md") t.md++; else if (k === "image") t.image++; else t.other++;
    }
  };
  await walk("");
  return t;
}

export interface ReadFileResult {
  path: string; kind: FileKind; size: number; updatedAt: string; sha256: string;
  /** 文本文件的正文；二进制或超限时为 null */
  content: string | null;
  /** 没给正文的原因 */
  why?: string;
  lines?: number;
  snapshot?: string;
  /** 图片：原始尺寸 */
  width?: number; height?: number;
}

export async function readAnyFile(p: Project, rel: string): Promise<ReadFileResult> {
  const abs = mustFile(p, rel);
  const st = statSync(abs);
  const buf = await readFile(abs);
  const out: ReadFileResult = {
    path: rel, kind: kindOf(rel), size: st.size, updatedAt: st.mtime.toISOString(),
    sha256: sha256(buf), content: null,
  };
  const snaps = await listSnapshots(p, rel);
  if (snaps.length) out.snapshot = snaps[snaps.length - 1];
  if (out.kind === "image") Object.assign(out, await imageSize(abs));
  if (!isTextual(rel)) { out.why = "不是文本文件"; return out; }
  if (st.size > TEXT_MAX) { out.why = `文件 ${Math.round(st.size / 1024)} KB，超过 ${TEXT_MAX / 1024 / 1024} MB 上限`; return out; }
  out.content = buf.toString("utf8");
  out.lines = out.content.length ? out.content.split("\n").length : 0;
  return out;
}

export interface WriteFileOptions {
  /** 写前校验：盘上现在的 sha256 必须等于它，否则拒绝（Q8）。新建文件传 "0" 或不传 */
  expectSha256?: string;
  /** 记在快照元数据里，给版本历史那一列看 */
  origin?: "人手改" | "AI" | "新建";
  note?: string;
}

export interface WriteFileResult {
  path: string; written: boolean; snapshot: string | null; previous: string | null;
  bytes: number; sha256: string; steps: string[];
}

/** 泛型落盘。`.dc.html` 在这里被拒 —— 它要走 `write_draft` 那条路。 */
export async function writeAnyFile(p: Project, rel: string, content: string, opts: WriteFileOptions = {}): Promise<WriteFileResult> {
  const clean = normalizeRel(p, rel);
  if (kindOf(clean) === "dc") {
    throw new ToolError(err(X.IO, clean, { kind: "file", name: basename(clean) },
      "`.dc.html` 不走这条路",
      { fix: "设计稿用 write_draft：它会归一化、展开 @ds、注入 __resources、打节点地址、存语义快照、写 changelog。这条路一样都不做。" }));
  }
  if (isToolArtifact(clean)) {
    throw new ToolError(err(X.IO, clean, { kind: "file", name: basename(clean) },
      "这是工具自己产的文件，不该手写",
      { fix: "索引页、壳页面、运行时副本由 build_index 生成；改了也会被下一次重建覆盖。" }));
  }
  const abs = join(p.dir, clean.split("/").join(sep));
  const exists = existsSync(abs);
  const steps: string[] = [];

  // ① 写前校验（Q8）：盘上是不是还是调用方看到的那一版
  const before = exists ? await readFile(abs) : null;
  const nowSha = before ? sha256(before) : "0";
  if (opts.expectSha256 !== undefined && opts.expectSha256 !== nowSha) {
    throw new ToolError(err(X.IO, clean, { kind: "file", name: basename(clean) },
      exists ? "这个文件在你读到之后被改过了" : "这个文件已经不在了",
      { fix: `盘上现在是 ${nowSha.slice(0, 12)}…，你带来的是 ${String(opts.expectSha256).slice(0, 12)}…。重新读一次再写，别把别人的改动盖掉。` }));
  }
  steps.push(exists ? `写前校验通过（${nowSha.slice(0, 8)}）` : "新建文件");

  // ② 存上一版：先留住旧的，再写新的 —— 顺序反了就没得退
  let previous: string | null = null;
  if (before !== null) {
    previous = await saveSnapshot(p, clean, before, opts.origin ?? "人手改", opts.note);
    steps.push(`存快照 ${previous}`);
  }

  await mkdir(dirname(abs), { recursive: true });
  await writeAtomic(abs, content);
  steps.push(`写入 ${Buffer.byteLength(content, "utf8")} 字节`);

  // ③ 新内容也留一份 —— 「回到这一版」要有得回
  const snapshot = await saveSnapshot(p, clean, Buffer.from(content, "utf8"), opts.origin ?? "人手改", opts.note);
  steps.push(`当前版 ${snapshot}`);
  return { path: clean, written: true, snapshot, previous, bytes: Buffer.byteLength(content, "utf8"), sha256: sha256(content), steps };
}

export interface FileSnapshotMeta { version: string; src: string; at: string; bytes: number; note?: string }

/** 这个文件的快照号，升序。只认 `s<N>` —— `v<N>` 是稿的语义快照，两套不混。 */
export async function listSnapshots(p: Project, rel: string): Promise<string[]> {
  const dir = snapDir(p, rel);
  if (!existsSync(dir)) return [];
  const ns: number[] = [];
  for (const f of await readdir(dir)) {
    const m = /^s(\d+)\.json$/.exec(f);
    if (m) ns.push(Number(m[1]));
  }
  return ns.sort((a, b) => a - b).map((n) => `s${n}`);
}

export async function listSnapshotMeta(p: Project, rel: string): Promise<FileSnapshotMeta[]> {
  const dir = snapDir(p, rel);
  const out: FileSnapshotMeta[] = [];
  for (const v of await listSnapshots(p, rel)) {
    try { out.push(JSON.parse(await readFile(join(dir, `${v}.json`), "utf8")) as FileSnapshotMeta); } catch { /* 坏了就跳过 */ }
  }
  return out;
}

async function saveSnapshot(p: Project, rel: string, buf: Buffer, src: string, note?: string): Promise<string> {
  const dir = snapDir(p, rel);
  await mkdir(dir, { recursive: true });
  const have = await listSnapshots(p, rel);
  const n = have.length ? Number(have[have.length - 1]!.slice(1)) + 1 : 1;
  const version = `s${n}`;
  const meta: FileSnapshotMeta = { version, src, at: new Date().toISOString(), bytes: buf.length, ...(note ? { note } : {}) };
  await writeFile(join(dir, `${version}.json`), JSON.stringify(meta, null, 1));
  await writeFile(join(dir, `${version}.src.gz`), gzipSync(buf));
  return version;
}

/** 读回某一版的原文 */
export async function readSnapshotContent(p: Project, rel: string, version: string): Promise<string> {
  const f = join(snapDir(p, rel), `${version}.src.gz`);
  if (!existsSync(f)) {
    const have = await listSnapshots(p, rel);
    throw new ToolError(err(X.SNAPSHOT_MISSING, rel, { kind: "key", name: version },
      `没有 ${version} 的快照`,
      { fix: have.length ? `现有：${have.join(" / ")}` : "这个文件还没有经 write_file 落过盘" }));
  }
  return gunzipSync(await readFile(f)).toString("utf8");
}

/** 回到某一版：把那一版的原文当新内容写一遍（历史不删，回退本身也留一版）。 */
export async function revertFile(p: Project, rel: string, version: string): Promise<WriteFileResult> {
  const old = await readSnapshotContent(p, rel, version);
  const r = await writeAnyFile(p, rel, old, { origin: "人手改", note: `回到 ${version}` });
  r.steps.unshift(`取 ${version} 的原文`);
  return r;
}

/** 删除（回收站语义，和稿一样）：移进 `.umbrastudio/trash/<时间戳>/`，不是真删 */
export async function trashFile(p: Project, rel: string): Promise<{ path: string; trashPath: string }> {
  const abs = mustFile(p, rel);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const to = join(p.dir, ".umbrastudio", "trash", stamp, clean(rel));
  await mkdir(dirname(to), { recursive: true });
  await writeFile(to, await readFile(abs));
  await rm(abs);
  return { path: rel, trashPath: relative(p.dir, to).split(sep).join("/") };
}

export interface MoveFileResult {
  from: string; to: string;
  /** 一并改写了引用的稿：{ file, count } */
  rewrote: Array<{ file: string; count: number }>;
  steps: string[];
}

/** 改名 / 移动一个普通文件，并把稿里指向它的 href / src / url() 一起改掉。
 *  S15 对用户的承诺就是这一句「改名或移动会一并改写引用」—— 不做的话那句话是假的。
 *  稿的改写走 `write_draft`（唯一写入口），所以引用改完照样有语义快照可退。 */
export async function moveFile(p: Project, fromRel: string, toRel: string): Promise<MoveFileResult> {
  const from = normalizeRel(p, fromRel), to = normalizeRel(p, toRel);
  if (kindOf(from) === "dc" || kindOf(to) === "dc") {
    throw new ToolError(err(X.IO, from, { kind: "file", name: basename(from) },
      "`.dc.html` 不走这条路", { fix: "稿的改名 / 移动用 rename_draft / move_draft，它们会跟着改 dc-import 的引用。" }));
  }
  const absFrom = mustFile(p, from);
  const absTo = join(p.dir, to.split("/").join(sep));
  if (existsSync(absTo)) {
    throw new ToolError(err(X.IO, to, { kind: "file", name: basename(to) }, `${to} 已经存在`,
      { fix: "换一个名字，或者先把那一个挪开。" }));
  }
  const refs = await referencesOf(p, from);
  const steps: string[] = [];
  await mkdir(dirname(absTo), { recursive: true });
  await writeFile(absTo, await readFile(absFrom));
  await rm(absFrom);
  steps.push(`${from} → ${to}`);

  /* 引用改写：稿里写的是相对它自己的路径，所以按每份稿的位置重算。
     改完经 write_draft 落盘 —— 引用变了也要留快照，和别的改稿一视同仁。 */
  const { writeDraft } = await import("./write.js");
  const byFile = new Map<string, number>();
  for (const r of refs) byFile.set(r.file, (byFile.get(r.file) ?? 0) + 1);
  const rewrote: Array<{ file: string; count: number }> = [];
  for (const [draftRel, count] of byFile) {
    const abs = join(p.dir, draftRel.split("/").join(sep));
    let src: string;
    try { src = await readFile(abs, "utf8"); } catch { continue; }
    const oldHref = relFromDraft(draftRel, from), newHref = relFromDraft(draftRel, to);
    const next = src.split(oldHref).join(newHref);
    if (next === src) continue;
    await writeDraft(p, draftRel, next, kindOf(draftRel) === "dc" && /<x-dc/.test(src) ? "page" : "page", `引用跟着 ${basename(from)} 的移动改了`, { origin: "人手改" });
    rewrote.push({ file: draftRel, count });
    steps.push(`改写引用 ${draftRel}（${count} 处）`);
  }
  return { from, to, rewrote, steps };
}

/** 稿里该怎么写这个文件的路径：相对稿自己的位置 */
function relFromDraft(draftRel: string, targetRel: string): string {
  const up = "../".repeat(draftRel.split("/").length - 1);
  return up + targetRel;
}

/** 谁引用了这个文件（S15 的 referencedBy）：扫所有稿的 href / src / url()，返回 { file, line }。 */
export async function referencesOf(p: Project, rel: string): Promise<Array<{ file: string; line: number }>> {
  const target = basename(rel);
  const out: Array<{ file: string; line: number }> = [];
  for (const abs of await listDrafts(p)) {
    const draftRel = relative(p.dir, abs).split(sep).join("/");
    // 工具自己部署进项目的壳页面（S2–S8、index）不算「引用方」——
    // 它们引 support.js 是 build_index 干的，跟用户的文件组织没关系
    if (isToolArtifact(draftRel)) continue;
    let src: string;
    try { src = await readFile(abs, "utf8"); } catch { continue; }
    if (!src.includes(target)) continue;          // 先粗筛，避免每份稿都逐行
    src.split("\n").forEach((line, i) => {
      // 只认出现在 href / src / url() 里的 —— 正文里提到文件名不算引用
      if (new RegExp(`(?:href|src)\\s*=\\s*["'][^"']*${escapeRe(target)}|url\\(\\s*["']?[^"')]*${escapeRe(target)}`).test(line)) {
        out.push({ file: draftRel, line: i + 1 });
      }
    });
  }
  return out;
}

// ──────────────────────── 内部 ────────────────────────

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const clean = (rel: string) => rel.split(/[\\/]/).filter((x) => x && x !== "." && x !== "..").join("/");

function normalizeRel(p: Project, rel: string): string {
  const c = clean(rel);
  if (!c) {
    throw new ToolError(err(X.IO, rel, { kind: "path", name: rel }, "路径是空的",
      { fix: "给一个相对项目根的路径，比如 需求.md 或 docs/需求.md" }));
  }
  void p;
  return c;
}

function safeJoin(p: Project, rel: string): string {
  const c = clean(rel);
  const abs = c ? join(p.dir, c.split("/").join(sep)) : p.dir;
  if (!abs.startsWith(p.dir)) {
    throw new ToolError(err(X.IO, rel, { kind: "path", name: rel }, "路径跑到项目外面去了",
      { fix: "只能读写项目目录里的文件。" }));
  }
  return abs;
}

function mustFile(p: Project, rel: string): string {
  const abs = safeJoin(p, rel);
  if (!existsSync(abs) || statSync(abs).isDirectory()) {
    throw new ToolError(err(X.DRAFT_NOT_FOUND, rel, { kind: "file", name: rel },
      `项目里没有文件 ${rel}`, { fix: "先用 list_files 看看这一层有什么" }));
  }
  return abs;
}

async function firstLine(abs: string): Promise<string> {
  try {
    const head = (await readFile(abs, "utf8")).slice(0, 4000);
    const body = head.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");   // 跳过 frontmatter
    const line = body.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
    return line ? line.slice(0, 120) : "";
  } catch { return ""; }
}

/** 从文件头读图片尺寸。只认这几种，读不出来就不给 —— 宁可没有，不可以给错的。 */
async function imageSize(abs: string): Promise<{ width?: number; height?: number }> {
  try {
    const ext = extname(abs).toLowerCase();
    if (ext === ".svg") {
      const s = (await readFile(abs, "utf8")).slice(0, 4000);
      const w = /\bwidth\s*=\s*["']?(\d+(?:\.\d+)?)/.exec(s), h = /\bheight\s*=\s*["']?(\d+(?:\.\d+)?)/.exec(s);
      if (w && h) return { width: Math.round(Number(w[1])), height: Math.round(Number(h[1])) };
      const vb = /viewBox\s*=\s*["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)/.exec(s);
      return vb ? { width: Math.round(Number(vb[1])), height: Math.round(Number(vb[2])) } : {};
    }
    const b = await readFile(abs);
    if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };   // PNG
    if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };   // GIF
    if (b.length > 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
      const fmt = b.toString("ascii", 12, 16);
      if (fmt === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
      if (fmt === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      if (fmt === "VP8L") { const n = b.readUInt32LE(21); return { width: (n & 0x3fff) + 1, height: ((n >> 14) & 0x3fff) + 1 }; }
      return {};
    }
    if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {   // JPEG：按段走到 SOFn
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const marker = b[i + 1] as number;
        const len = b.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
    return {};
  } catch { return {}; }
}
