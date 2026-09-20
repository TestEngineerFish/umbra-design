/** 唯一写入口。doc/00 §5.2
 *
 * 三条保证：
 *   ① 归一化落盘（含 @ds 展开与 __resources 注入）—— normalize.ts
 *   ② 落盘即校验：有 error 级诊断则【拒绝落盘】，原样返回诊断
 *   ③ 落盘即留痕：写快照到 .umbradesign/snapshots/
 *
 * ⚠️ 当前 ③ 只写快照，还不产 CHANGELOG —— changelog 的内容要靠语义 diff，
 * diff 在下一批。快照从第一次落盘就开始攒，所以不会丢历史。
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { X } from "./codes.js";
import { err, ToolError, warn, type Diagnostic } from "./envelope.js";
import { conclusion as conclusionOf } from "./diff.js";
import { draftPath, type Project } from "./project.js";
import { validateDraft } from "./validate.js";
import {
  ensureRuntimeBeside, prepareForDisk, readIfExists, resolveInProject, writeAtomic,
} from "./normalize.js";
import { gzipSync } from "node:zlib";
import { buildSnapshot } from "./snapshot.js";
import { listVersions, recordChange, snapDir } from "./history.js";

export interface WriteOutcome {
  path: string;
  written: boolean;
  /** 拒绝落盘的原因；written=true 时为 null */
  refused: string | null;
  steps: string[];
  bytes: number;
  version: string | null;
  snapshot: string | null;
  runtimeCopied: string[];
  unchanged: boolean;
  /** 跟上一版比出来的变更清单摘要；第一版为 null */
  change: { counts: Record<string, number>; conclusion: string } | null;
  changelog: { written: boolean; reason?: string; section?: string } | null;
}

/** 下一个版本号：按稿独立计数，取已有最大值 + 1（doc/07 §五） */
async function nextVersion(p: Project, relPath: string): Promise<string> {
  const vs = await listVersions(p, relPath);
  if (!vs.length) return "v1";
  const last = vs[vs.length - 1] as string;
  return `v${Number(last.slice(1)) + 1}`;
}

async function gitHead(p: Project): Promise<string | null> {
  if (!p.gitEnabled) return null;
  return await new Promise((res) => {
    execFile("git", ["-C", p.dir, "rev-parse", "--short", "HEAD"], (e, out) =>
      res(e ? null : out.trim() || null));
  });
}

/** 写一份稿。内容相同则不落盘也不新增快照（避免版本号空转）。 */
export async function writeDraft(
  p: Project, relPath: string, content: string, kind: "page" | "component",
  note?: string, opts?: { expectedSourceSha256?: string },
): Promise<{ outcome: WriteOutcome; diags: Diagnostic[]; stats: Record<string, unknown> }> {
  if (!/\.dc\.html$/.test(relPath)) {
    throw new ToolError(
      err(X.BAD_INPUT, relPath, { kind: "path", name: relPath },
        "稿的文件名必须以 .dc.html 结尾",
        { fix: `改成 "${relPath.replace(/\.[^.]*$/, "")}.dc.html"` }));
  }

  const abs = resolveInProject(p, relPath);
  if (!abs.startsWith(p.dir)) {
    throw new ToolError(
      err(X.BAD_INPUT, relPath, { kind: "path", name: relPath },
        "路径跨出了项目目录", { fix: "path 必须是相对项目根的路径" }));
  }

  // ① 归一化 + @ds 展开 + __resources 注入
  const prep = prepareForDisk(p, content);

  // ② 落盘即校验（校验的是**改写后**的内容，也就是真正会落盘的那份）
  const { diags, stats } = validateDraft(p, relPath, prep.content, relPath);
  const hasError = diags.some((d) => d.level === "error");
  const before = await readIfExists(abs);
  const unchanged = before === prep.content;

  // ①½ 并发写保护：如果传了预期 sha256，盘上不一致就拒绝
  if (opts?.expectedSourceSha256 && before !== undefined) {
    const currentSha = createHash("sha256").update(before as string, "utf8").digest("hex");
    if (currentSha !== opts.expectedSourceSha256) {
      return {
        outcome: {
          path: relPath, written: false,
          refused: `并发写入冲突：盘上源码 sha256=${currentSha.slice(0, 8)}…，预期 ${opts.expectedSourceSha256.slice(0, 8)}…`,
          steps: ["并发保护：源码已被其他客户端修改，拒绝覆盖"],
          bytes: prep.content.length, version: null, snapshot: null,
          runtimeCopied: [], unchanged: false, change: null, changelog: null,
        },
        diags: [], stats: {},
      };
    }
  }

  if (hasError) {
    return {
      outcome: {
        path: relPath, written: false,
        refused: `有 ${diags.filter((d) => d.level === "error").length} 条 error 级诊断，按契约拒绝落盘`,
        steps: prep.steps, bytes: prep.content.length, version: null, snapshot: null,
        runtimeCopied: [], unchanged: false, change: null, changelog: null,
      },
      diags, stats,
    };
  }

  if (unchanged) {
    return {
      outcome: {
        path: relPath, written: false, refused: null,
        steps: [...prep.steps, "内容与盘上一致，不落盘、不新增快照"],
        bytes: prep.content.length, version: null, snapshot: null,
        runtimeCopied: await ensureRuntimeBeside(abs), unchanged: true, change: null, changelog: null,
      },
      diags, stats,
    };
  }

  await writeAtomic(abs, prep.content);

  // ④ 运行时副本与稿同层
  const runtimeCopied = await ensureRuntimeBeside(abs);
  const rtDiags: Diagnostic[] = [];
  if (!existsSync(join(dirname(abs), "support.js"))) {
    rtDiags.push(warn(X.IO, relPath, { kind: "file", name: "support.js" },
      "稿所在目录没有 support.js，直接打开会白屏",
      { fix: "把 UmbraDesign/runtime/ 的三个文件放到这个目录（write_draft 会自动分发，除非 runtime/ 本身缺文件）" }));
  }

  // ③ 落盘即留痕
  const version = await nextVersion(p, relPath);
  const snap = buildSnapshot(p, relPath, prep.content, { version, gitCommit: await gitHead(p) });
  const dir = snapDir(p, relPath);
  await mkdir(dir, { recursive: true });
  const snapFile = join(dir, `${version}.json`);
  await writeFile(snapFile, JSON.stringify(snap, null, 1) + "\n", "utf8");

  // 语义快照存不了源码（它只有 sourceSha256），所以 revert_to 需要真正的源码。
  // 每版存一份 gzip：3.78MB 的全量语料压下来一版几百 KB，.umbradesign/ 本来就不进
  // 仓库，本地磁盘换「能撤销」很值 —— L1 拖滑块没有撤销不能给人用（doc/09 决策 4）。
  await writeFile(join(dir, `${version}.src.html.gz`), gzipSync(Buffer.from(prep.content, "utf8")));

  // ③ 的后半段：跟上一版比，产变更清单并追加 CHANGELOG-设计侧.md（doc/07 §五）
  const rec = await recordChange(p, relPath, version, note);
  const steps = [...prep.steps, `快照 ${version}`];
  if (rec.changelog.written) steps.push(`changelog ${rec.changelog.section}`);
  else if (rec.diff) steps.push(`changelog 未写（${rec.changelog.reason}）`);

  return {
    outcome: {
      path: relPath, written: true, refused: null,
      steps,
      bytes: prep.content.length, version,
      snapshot: snapFile.slice(p.dir.length + 1),
      runtimeCopied, unchanged: false,
      change: rec.diff ? { counts: rec.diff.counts, conclusion: conclusionOf(rec.diff) } : null,
      changelog: rec.changelog,
    },
    diags: [...diags, ...rtDiags],
    stats: { ...stats, kind },
  };
}

export interface PatchEdit { old: string; new: string; count?: number }

/** 增量改。old 必须唯一命中；命中 0 次或多次返回 E_PATCH_ANCHOR，并把相关片段回给模型。 */
export async function patchDraft(
  p: Project, relPath: string, edits: PatchEdit[],
  opts?: { expectedSourceSha256?: string; note?: string },
) {
  const abs = draftPath(p, relPath);
  const original = (await readIfExists(abs)) ?? "";

  // 并发写保护
  if (opts?.expectedSourceSha256 && original !== "") {
    const currentSha = createHash("sha256").update(original, "utf8").digest("hex");
    if (currentSha !== opts.expectedSourceSha256) {
      throw new ToolError(
        err(X.BAD_INPUT, relPath, { kind: "key", name: "sourceSha256" },
          `并发写入冲突：盘上源码 sha256=${currentSha.slice(0, 8)}…，预期 ${opts.expectedSourceSha256.slice(0, 8)}…`,
          { fix: "重新 read_snapshot 或 get_component 取最新版本后再改" }));
    }
  }

  let cur = original;
  const applied: Array<{ old: string; at: number }> = [];

  for (const [i, e] of edits.entries()) {
    if (!e.old) {
      throw new ToolError(
        err(X.BAD_INPUT, relPath, { kind: "key", name: `edits[${i}].old` },
          "edits[].old 不能为空", { fix: "要整份替换就用 write_draft" }));
    }
    const want = e.count ?? 1;
    const hits: number[] = [];
    for (let at = cur.indexOf(e.old); at >= 0; at = cur.indexOf(e.old, at + 1)) hits.push(at);
    if (hits.length !== want) {
      const near = hits.length
        ? hits.slice(0, 3).map((at) => ({ at, context: cur.slice(Math.max(0, at - 90), at + e.old.length + 90) }))
        : sniff(cur, e.old);
      throw new ToolError(
        err(X.PATCH_ANCHOR, relPath, { kind: "key", name: `edits[${i}]` },
          `edits[${i}].old 命中 ${hits.length} 次，期望 ${want} 次`,
          { fix: hits.length === 0
              ? "old 要与文件内容逐字一致（含空白）。下面给了最接近的片段，照它改 old"
              : "把 old 加上相邻文本直到唯一命中，或显式传 count" }),
        { hits: hits.length, expected: want, candidates: near });
    }
    for (const at of hits) applied.push({ old: e.old, at });
    cur = cur.split(e.old).join(e.new);
  }

  const r = await writeDraft(p, relPath, cur, "page", opts?.note);
  return { ...r, outcome: { ...r.outcome, steps: [`应用 ${edits.length} 处 edit`, ...r.outcome.steps] } };
}

/** old 命中不到时，找几段最像的回给模型 —— 让它一轮内改对，而不是反复试。 */
function sniff(src: string, old: string) {
  const probe = old.trim().split("\n")[0]?.trim().slice(0, 40) ?? "";
  if (probe.length < 6) return [];
  const out: Array<{ at: number; context: string }> = [];
  for (let at = src.indexOf(probe); at >= 0 && out.length < 3; at = src.indexOf(probe, at + 1)) {
    out.push({ at, context: src.slice(Math.max(0, at - 90), at + 200) });
  }
  return out;
}
