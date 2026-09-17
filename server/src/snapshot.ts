/** 语义快照。doc/07 §二
 *
 * 归一化是整个方案的成败点：做不对，噪声就吃掉信号。
 * 逐条按 07 §2.3 实现，并且节点身份**不靠路径**（07 §2.4）——
 * 路径在插入一个元素之后会整段偏移，靠路径配对会把一次插入报成几十处变更。
 */
import { createHash } from "node:crypto";
import { auditRenderVals, parseDraft } from "./draft.js";
import { objectTopLevel } from "./scan.js";
import type { Project } from "./project.js";

export const SNAPSHOT_SCHEMA = 1;

export interface SnapNode {
  id: string;
  at: string;              // "L128" —— 给人定位，不是身份
  tag: string;
  fp: string;              // 内容指纹：配对用
  style: Record<string, string>;
  attrs: Record<string, string>;
  holes: string[];
  text?: string;
}

export interface Snapshot {
  schema: number;
  file: string;
  version: string;
  capturedAt: string;
  sourceSha256: string;
  gitCommit: string | null;
  stats: { elements: number; holes: number; imports: number };
  props: Record<string, unknown>;
  state: Record<string, unknown>;
  valKeys: string[];
  branches: Array<{ id: string; cond: string | null; at: string }>;
  lists: Array<{ id: string; list: string | null; as: string | null; at: string }>;
  imports: Array<{ name: string; props: string[]; at: string }>;
  tokensUsed: string[];
  texts: Array<{ id: string; at: string; text: string }>;
  nodes: SnapNode[];
}

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const short = (s: string) => createHash("sha1").update(s, "utf8").digest("hex").slice(0, 8);

/** 07 §2.3：数值与颜色归一 */
function normValue(v: string): string {
  let s = v.trim().replace(/\s+/g, " ");
  s = s.replace(/(^|[\s(,])0(?:px|pt|rem|em)\b/g, "$10");
  s = s.replace(/(\d+)\.0+(?=(px|pt|rem|em|%|\b))/g, "$1");
  s = s.replace(/(^|[\s(,:])\.(\d)/g, "$10.$2");
  s = s.replace(/#([0-9a-fA-F]{3,8})\b/g, (_m, h: string) => {
    const x = h.toLowerCase();
    return "#" + (x.length === 3 ? x.split("").map((c) => c + c).join("") : x);
  });
  return s;
}

/** style 属性 → 键按字母序的 map */
export function normalizeStyle(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of raw.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const k = decl.slice(0, i).trim().toLowerCase();
    if (!k) continue;
    out[k] = normValue(decl.slice(i + 1));
  }
  return Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k] as string]));
}

/** 文本：trim + 内部连续空白折成一个空格；纯空白丢弃 */
export function normalizeText(t: string): string {
  return t.replace(/\s+/g, " ").trim();
}

const SKIP_ATTRS = new Set(["style"]);

export interface SnapshotOptions { version: string; gitCommit?: string | null }

export function buildSnapshot(p: Project, relPath: string, src: string, opts: SnapshotOptions): Snapshot {
  const d = parseDraft(src, relPath);
  const audit = auditRenderVals(d);
  const tplStart = d.template?.start ?? 0;
  const tplEnd = d.template?.end ?? 0;
  const tpl = src.slice(tplStart, tplEnd);

  // ── 节点 ──
  const nodes: SnapNode[] = [];
  const texts: Snapshot["texts"] = [];
  const tokensUsed = new Set<string>();
  const seen = new Map<string, number>();     // fp → 出现次数，用来给同形节点编号

  const tagRe = /<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(tpl))) {
    const absIdx = tplStart + m.index;
    if (d.comments.some((c) => absIdx >= c.start && absIdx < c.end)) continue;
    const tag = (m[1] as string).toLowerCase();
    const attrsRaw = m[2] ?? "";

    const style: Record<string, string> = {};
    const attrs: Record<string, string> = {};
    const holes: string[] = [];
    for (const am of attrsRaw.matchAll(/([A-Za-z_:@][-\w:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      const k = (am[1] as string);
      const v = (am[3] ?? am[4] ?? "");
      for (const hm of v.matchAll(/\{\{([^}]*)\}\}/g)) holes.push((hm[1] ?? "").trim());
      for (const tm of v.matchAll(/var\(\s*(--[\w-]+)/g)) tokensUsed.add(tm[1] as string);
      if (k.toLowerCase() === "style") { Object.assign(style, normalizeStyle(v)); continue; }
      if (SKIP_ATTRS.has(k.toLowerCase())) continue;
      attrs[k.toLowerCase()] = k.toLowerCase() === "class"
        ? v.trim().split(/\s+/).filter(Boolean).sort().join(" ")
        : normValue(v);
    }

    // 紧随其后的直接文本（到下一个 < 为止）
    const after = tpl.slice(m.index + m[0].length);
    const nextLt = after.indexOf("<");
    const rawText = nextLt < 0 ? after : after.slice(0, nextLt);
    const text = normalizeText(rawText);

    const fpBase = [tag, Object.keys(style).join(","), holes.join(","), short(text)].join("|");
    const n = (seen.get(fpBase) ?? 0) + 1;
    seen.set(fpBase, n);

    const node: SnapNode = {
      id: `${tag}-${short(fpBase)}-${n}`,
      at: `L${d.at(absIdx).line}`,
      tag, fp: fpBase, style, attrs, holes,
    };
    if (text) {
      node.text = text;
      // 只有"真文案"进 texts。整段都是洞（{{ x }}）的不算文案变更，那是绑定 ——
      // 不排掉的话，L3 文案级会把每一处绑定都报成改字符串。
      const literal = text.replace(/\{\{[^}]*\}\}/g, "").trim();
      if (literal) texts.push({ id: node.id, at: node.at, text });
    }
    nodes.push(node);
  }
  for (const tm of tpl.matchAll(/var\(\s*(--[\w-]+)/g)) tokensUsed.add(tm[1] as string);

  // ── 初始 state ──
  const state: Record<string, unknown> = {};
  if (d.logic) {
    const js = src.slice(d.logic.start, d.logic.end);
    const sm = /\bstate\s*=\s*\{/.exec(js);
    if (sm) {
      const open = sm.index + sm[0].length - 1;
      // 只取顶层键名，值不求（值可能是表达式）
      for (const k of objectTopLevel(js, open).keys) state[k] = "(声明了)";
    }
  }

  return {
    schema: SNAPSHOT_SCHEMA,
    file: relPath,
    version: opts.version,
    capturedAt: new Date().toISOString(),
    sourceSha256: sha(src),
    gitCommit: opts.gitCommit ?? null,
    stats: { elements: d.elements, holes: d.holes.length, imports: d.imports.length },
    props: d.props ?? {},
    state,
    valKeys: audit.union,
    branches: d.branches.map((b, i) => ({ id: `b${i + 1}`, cond: b.cond, at: `L${b.pos.line}` })),
    lists: d.lists.map((l, i) => ({ id: `l${i + 1}`, list: l.list, as: l.as, at: `L${l.pos.line}` })),
    imports: d.imports.map((im) => ({ name: im.name, props: im.props.sort(), at: `L${im.pos.line}` })),
    tokensUsed: [...tokensUsed].sort(),
    texts,
    nodes,
  };
}
