/** 版本历史与变更清单。doc/07 §五、§六、§七
 *
 * 主路径是 .umbradesign/snapshots/ 的快照序列；git 是兜底，只在要按任意 ref
 * 取版本时用（07 §七）。实现侧永远不碰 git —— 它读 CHANGELOG-设计侧.md。
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { X } from "./codes.js";
import { err, ToolError } from "./envelope.js";
import type { Project } from "./project.js";
import { buildSnapshot, type Snapshot } from "./snapshot.js";
import { conclusion, diffSnapshots, mergeDiffs, toMarkdown, type DiffResult } from "./diff.js";

export const CHANGELOG = "CHANGELOG-设计侧.md";

export function snapDir(p: Project, relPath: string): string {
  return join(p.dir, ".umbradesign", "snapshots", relPath.replace(/[\\/]/g, "__"));
}

/** 这份稿有哪些快照版本，升序 */
export async function listVersions(p: Project, relPath: string): Promise<string[]> {
  const dir = snapDir(p, relPath);
  if (!existsSync(dir)) return [];
  const ns: number[] = [];
  for (const f of await readdir(dir)) {
    const m = /^v(\d+)\.json$/.exec(f);
    if (m) ns.push(Number(m[1]));
  }
  return ns.sort((a, b) => a - b).map((n) => `v${n}`);
}

export async function readSnapshot(p: Project, relPath: string, version: string): Promise<Snapshot> {
  const f = join(snapDir(p, relPath), `${version}.json`);
  if (!existsSync(f)) {
    const have = await listVersions(p, relPath);
    throw new ToolError(err(X.SNAPSHOT_MISSING, relPath, { kind: "key", name: version },
      `没有 ${version} 的快照`,
      { fix: have.length ? `现有：${have.join(" / ")}` : "这份稿还没有经 write_draft 落过盘，所以没有快照" }));
  }
  return JSON.parse(await readFile(f, "utf8")) as Snapshot;
}

function git(p: Project, args: string[]): Promise<string> {
  return new Promise((res, rej) => {
    execFile("git", ["-C", p.dir, ...args], { maxBuffer: 32 * 1024 * 1024 }, (e, out) =>
      e ? rej(e) : res(out));
  });
}

/** 把一个"版本说明"解析成快照。支持 v<N>、git ref、以及 "工作区"（当前盘上的内容）。 */
export async function resolveSnapshot(p: Project, relPath: string, ref: string): Promise<Snapshot> {
  if (/^v\d+$/.test(ref)) return await readSnapshot(p, relPath, ref);

  if (ref === "工作区" || ref === "worktree" || ref === "HEAD~0") {
    const src = await readFile(join(p.dir, relPath), "utf8");
    return buildSnapshot(p, relPath, src, { version: "工作区" });
  }

  if (!p.gitEnabled) {
    throw new ToolError(err(X.GIT_DISABLED, relPath, { kind: "key", name: ref },
      `这个项目没有 git，取不了 "${ref}"`,
      { fix: "只支持 v<N> 与「工作区」。要按 git ref 取版本，先在项目目录 git init（doc/07 §七）" }));
  }
  let src: string;
  try {
    src = await git(p, ["show", `${ref}:${relPath}`]);
  } catch (e) {
    throw new ToolError(err(X.SNAPSHOT_MISSING, relPath, { kind: "key", name: ref },
      `git 里取不到 ${ref}:${relPath}`,
      { fix: `确认这个 ref 存在，且那一版里有这份稿。git 的话：${(e as Error).message.split("\n")[0]}` }));
  }
  return buildSnapshot(p, relPath, src, { version: ref });
}

export interface DiffRequest { from: string; to?: string }

export async function diffDrafts(p: Project, relPath: string, req: DiffRequest): Promise<DiffResult> {
  const a = await resolveSnapshot(p, relPath, req.from);
  const toRef = req.to ?? (await pickLatest(p, relPath));
  const b = await resolveSnapshot(p, relPath, toRef);
  return diffSnapshots(a, b);
}

async function pickLatest(p: Project, relPath: string): Promise<string> {
  const vs = await listVersions(p, relPath);
  return vs.length ? (vs[vs.length - 1] as string) : "工作区";
}

/** 跨版本净变更：把 since 之后每一版的 diff 合并成一份（07 §六） */
export async function changesSince(p: Project, relPath: string, since: string): Promise<DiffResult> {
  const vs = await listVersions(p, relPath);
  const i = vs.indexOf(since);
  if (i < 0) {
    throw new ToolError(err(X.SNAPSHOT_MISSING, relPath, { kind: "key", name: since },
      `"${since}" 不在这份稿的版本序列里`,
      { fix: vs.length ? `现有：${vs.join(" / ")}` : "这份稿还没有快照" }));
  }
  const tail = vs.slice(i);
  if (tail.length < 2) {
    const only = await resolveSnapshot(p, relPath, since);
    return { file: relPath, from: since, to: since, counts: { L1: 0, L2: 0, L3: 0, L4: 0 }, changes: [], spans: [only.version] };
  }
  const diffs: DiffResult[] = [];
  for (let k = 0; k + 1 < tail.length; k++) {
    const a = await readSnapshot(p, relPath, tail[k] as string);
    const b = await readSnapshot(p, relPath, tail[k + 1] as string);
    diffs.push(diffSnapshots(a, b));
  }
  return mergeDiffs(diffs);
}

/** 整个项目的变更汇总：每份稿从 since 之后的净变更 */
export async function projectChangesSince(p: Project, drafts: string[], since: string | null) {
  const rows: Array<{ path: string; diff: DiffResult | null; note?: string }> = [];
  for (const rel of drafts) {
    const vs = await listVersions(p, rel);
    if (vs.length < 2) { rows.push({ path: rel, diff: null, note: vs.length ? "只有一版，没有可比的" : "没有快照" }); continue; }
    const from = since && vs.includes(since) ? since : (vs[0] as string);
    try { rows.push({ path: rel, diff: await changesSince(p, rel, from) }); }
    catch (e) { rows.push({ path: rel, diff: null, note: (e as Error).message }); }
  }
  return rows;
}

// ───────────────────── CHANGELOG-设计侧.md ─────────────────────

const HEADER = [
  `# 设计侧变更`,
  ``,
  `> 实现侧只读这一份。级别含义：`,
  `> [契约] 要改代码 · [取值] 照抄新值 · [文案] 改字符串 · [等价] 无需处理`,
  ``,
].join("\n");

/** 同一分钟内同一份稿的多次落盘合并成一节（07 §五）。节标题里带时间戳做判据。 */
function sectionKey(version: string, minute: string, file: string): string {
  return `## ${version} · ${minute} · ${file}`;
}

function nowMinute(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 写入纪律：只有 L1/L2/L3 至少一条非空才写。纯 L4 不写，否则清单很快没人看。 */
export async function appendChangelog(
  p: Project, relPath: string, d: DiffResult, note?: string
): Promise<{ written: boolean; reason?: string; section?: string }> {
  const { L1, L2, L3 } = d.counts;
  if (L1 + L2 + L3 === 0) {
    return { written: false, reason: "只有等价级变更（或无变更），按纪律不写 changelog" };
  }
  const file = join(p.dir, CHANGELOG);
  const old = existsSync(file) ? await readFile(file, "utf8") : "";
  const body = old.startsWith("# ") ? old.slice(old.indexOf("\n## ") < 0 ? old.length : old.indexOf("\n## ") + 1) : old;

  const minute = nowMinute();
  const head = sectionKey(d.to, minute, relPath);   // 顺序照 doc/07 §五：版本 · 时间 · 稿名
  // 备注紧跟标题 —— 回退、批量改这类「这次改动是怎么来的」必须写在清单里，
  // 否则实现侧看「有人把 padding 改回去了」和「这是退回 v1」是两回事（doc/00 §18.4）
  const section = `${head}\n\n${note ? `> ${note}\n\n` : ""}${toMarkdown(d)}\n`;

  // 同一分钟、同一份稿、同一版本 → 覆盖那一节，而不是再加一节
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^## ${esc(d.to)} · ${esc(minute)} · ${esc(relPath)}[\\s\\S]*?(?=\\n## |$)`, "m");
  const merged = re.test(body) ? body.replace(re, section.trimEnd()) : section + "\n" + body;

  await mkdir(p.dir, { recursive: true });
  const body2 = merged.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\n*$/, "\n");
  await writeFile(file, HEADER + body2, "utf8");
  return { written: true, section: head };
}

/** write_draft 落盘之后调：跟上一版比，产变更清单并追加 changelog。 */
export async function recordChange(
  p: Project, relPath: string, version: string, note?: string
): Promise<{ diff: DiffResult | null; changelog: { written: boolean; reason?: string; section?: string } }> {
  const vs = await listVersions(p, relPath);
  const i = vs.indexOf(version);
  if (i <= 0) {
    return { diff: null, changelog: { written: false, reason: "这是第一版，没有可比的上一版" } };
  }
  const a = await readSnapshot(p, relPath, vs[i - 1] as string);
  const b = await readSnapshot(p, relPath, version);
  const d = diffSnapshots(a, b);
  const cl = await appendChangelog(p, relPath, d, note);
  return { diff: d, changelog: cl };
}

export { conclusion, toMarkdown };
