/** 设计系统的按需检索：token / 图标 / 组件契约。doc/00 §5.1
 *
 * 为什么没有 list_tokens：umbra-tokens.json 是 810 KB / 1,236 个叶子，
 * 全量返回会直接吃掉调用模型的上下文。按需检索是这一层的核心价值。
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { X } from "./codes.js";
import { err, ToolError } from "./envelope.js";
import { listDrafts, type Project } from "./project.js";
import { parseDraft } from "./draft.js";

export type TokenKind = "color" | "space" | "type" | "elevation" | "number" | "list" | "rule" | "text";

export interface TokenLeaf {
  path: string;
  value: unknown;
  kind: TokenKind;
  /** 长散文截断后的预览；短值不给这个字段 */
  preview?: string;
}

const cache = new Map<string, TokenLeaf[]>();

function kindOf(path: string, v: unknown): TokenKind {
  if (Array.isArray(v)) return "list";
  if (typeof v === "number") return /radius|space|gap|pad|size|width|height/i.test(path) ? "space" : "number";
  if (typeof v === "string") {
    if (/^#[0-9a-fA-F]{3,8}$/.test(v) || /^(var\(--|rgba?\(|hsla?\()/.test(v)) return "color";
    if (/^-?[\d.]+(px|pt|rem|em|%|vh|vw)$/.test(v)) return "space";
    if (/^\d+(\.\d+)?\s*\/\s*\d/.test(v) || /^(normal|bold|\d{3})\s/.test(v)) return "type";
    if (/^\d+px\s+\d+px/.test(v) || /shadow/i.test(path)) return "elevation";
    if (v.length > 80) return "rule";
    return "text";
  }
  return "text";
}

export async function tokenLeaves(p: Project): Promise<TokenLeaf[]> {
  if (!p.tokensPath) return [];
  const hit = cache.get(p.tokensPath);
  if (hit) return hit;
  let json: unknown;
  try {
    json = JSON.parse(await readFile(p.tokensPath, "utf8"));
  } catch (e) {
    throw new ToolError(err(X.IO, basename(p.tokensPath), { kind: "file", name: basename(p.tokensPath) },
      `tokens 读不了：${(e as Error).message}`,
      { fix: `project.json 里 tokens = "${p.config.tokens}"，确认这个文件存在且是合法 JSON` }));
  }
  const out: TokenLeaf[] = [];
  const walk = (o: unknown, path: string) => {
    if (o && typeof o === "object" && !Array.isArray(o)) {
      for (const [k, v] of Object.entries(o)) walk(v, path ? `${path}.${k}` : k);
      return;
    }
    const kind = kindOf(path, o);
    const leaf: TokenLeaf = { path, value: o, kind };
    if (typeof o === "string" && o.length > 160) {
      leaf.value = o.slice(0, 160) + " …";
      leaf.preview = `（原文 ${o.length} 字，用 get_token 取全文）`;
    }
    out.push(leaf);
  };
  walk(json, "");
  cache.set(p.tokensPath, out);
  return out;
}

/** 模糊检索。命中路径的排在命中值的前面，短路径优先。 */
export async function searchTokens(p: Project, query: string, limit = 30) {
  const leaves = await tokenLeaves(p);
  const q = query.trim().toLowerCase();
  if (!q) return { hits: leaves.slice(0, limit), total: leaves.length, truncated: leaves.length > limit };
  const scored: Array<{ leaf: TokenLeaf; score: number }> = [];
  for (const leaf of leaves) {
    const path = leaf.path.toLowerCase();
    const val = typeof leaf.value === "string" ? leaf.value.toLowerCase() : JSON.stringify(leaf.value ?? "").toLowerCase();
    let score = 0;
    if (path === q) score = 100;
    else if (path.endsWith("." + q)) score = 80;
    else if (path.includes(q)) score = 60 - Math.min(20, path.length / 4);
    else if (val.includes(q)) score = 30;
    if (score > 0) scored.push({ leaf, score });
  }
  scored.sort((a, b) => b.score - a.score || a.leaf.path.localeCompare(b.leaf.path));
  return {
    hits: scored.slice(0, limit).map((s) => s.leaf),
    total: scored.length,
    truncated: scored.length > limit,
  };
}

/** 取单个叶子或整棵子树的全文（不截断）。 */
export async function getToken(p: Project, path: string) {
  if (!p.tokensPath) {
    throw new ToolError(err(X.BAD_INPUT, p.rel, { kind: "token", name: path },
      "这个项目没有配 tokens", { fix: 'project.json 里加 "tokens": "umbra-tokens.json"' }));
  }
  const json = JSON.parse(await readFile(p.tokensPath, "utf8")) as Record<string, unknown>;
  let node: unknown = json;
  for (const seg of path.split(".").filter(Boolean)) {
    if (!node || typeof node !== "object") { node = undefined; break; }
    node = (node as Record<string, unknown>)[seg];
  }
  if (node === undefined) {
    const near = (await searchTokens(p, path.split(".").pop() ?? path, 6)).hits.map((h) => h.path);
    throw new ToolError(err(X.BAD_INPUT, p.rel, { kind: "token", name: path },
      `取不到 token "${path}"`,
      { fix: near.length ? `相近的有：${near.join(" / ")}` : "用 search_tokens 先查" }));
  }
  const isLeaf = !(node && typeof node === "object" && !Array.isArray(node));
  return { path, value: node, leaf: isLeaf, kind: isLeaf ? kindOf(path, node) : null };
}

// ───────────────────────────── 图标 ─────────────────────────────

interface IconRec { name: string; cn?: string; body: string; strokeWidth?: number; group?: string; note?: string }

async function iconFile(p: Project) {
  if (!p.iconsPath) return null;
  return JSON.parse(await readFile(p.iconsPath, "utf8")) as {
    viewBox?: string; defaults?: unknown; icons?: IconRec[];
  };
}

/** withPath：把 path 一起给出来。
 *  默认**不给** —— `list_icons` 是给模型的，几十条 path 白占上下文。
 *  本地 API 给界面用时才要（界面得真把图标画出来，doc/00 §22.3）。 */
export async function listIcons(p: Project, query?: string, limit = 60, withPath = false) {
  const f = await iconFile(p);
  if (!f?.icons) return { viewBox: null, icons: [], total: 0, truncated: false };
  const q = (query ?? "").trim().toLowerCase();
  const all = f.icons.filter((i) =>
    !q || i.name.toLowerCase().includes(q) || (i.cn ?? "").includes(q) ||
    (i.group ?? "").toLowerCase().includes(q) || (i.note ?? "").includes(q));
  return {
    viewBox: f.viewBox ?? null,
    icons: all.slice(0, limit).map((i) => {
      const row: Record<string, unknown> = {
        name: i.name, cn: i.cn ?? null, group: i.group ?? null,
        strokeWidth: i.strokeWidth ?? null, note: i.note ?? null,
      };
      if (withPath) row.path = (i as { path?: string }).path ?? null;
      return row;
    }),
    total: all.length,
    truncated: all.length > limit,
  };
}

export async function getIcon(p: Project, name: string) {
  const f = await iconFile(p);
  const hit = f?.icons?.find((i) => i.name === name);
  if (!hit) {
    const near = (await listIcons(p, name.split("-")[0] ?? name, 6)).icons.map((i) => i.name);
    throw new ToolError(err(X.BAD_INPUT, p.rel, { kind: "token", name },
      `没有叫 "${name}" 的图标`,
      { fix: near.length ? `相近的有：${near.join(" / ")}` : "用 list_icons 先查" }));
  }
  return { ...hit, viewBox: f?.viewBox ?? "0 0 24 24" };
}

// ─────────────────────────── 组件契约 ───────────────────────────

export interface ComponentSummary {
  name: string;
  file: string;
  kind: "page" | "component";
  elements: number;
  props: Array<{ name: string; type: string | null; editor: string | null }>;
  states: string[];
}

/** list_components 只给名字 + props 签名；要全文用 get_component(mode:"full")。 */
export async function listComponents(p: Project): Promise<ComponentSummary[]> {
  const files = await listDrafts(p);
  const out: ComponentSummary[] = [];
  for (const abs of files) {
    const src = await readFile(abs, "utf8");
    const rel = abs.slice(p.dir.length + 1).split("\\").join("/");
    const d = parseDraft(src, rel);
    const props: ComponentSummary["props"] = [];
    let states: string[] = [];
    for (const [k, v] of Object.entries(d.props ?? {})) {
      if (k.startsWith("$")) continue;
      const o = (v ?? {}) as Record<string, unknown>;
      props.push({
        name: k,
        type: typeof o.tsType === "string" ? o.tsType : null,
        editor: typeof o.editor === "string" ? o.editor : null,
      });
      if (k === "kind" && Array.isArray(o.options)) states = (o.options as unknown[]).map(String);
    }
    out.push({
      name: basename(rel).replace(/\.dc\.html$/, ""),
      file: rel,
      kind: props.length > 0 ? "component" : "page",
      elements: d.elements,
      props,
      states,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getComponent(p: Project, name: string, mode: "contract" | "full") {
  const list = await listComponents(p);
  const hit = list.find((c) => c.name === name) ?? list.find((c) => c.file === name);
  if (!hit) {
    throw new ToolError(err(X.DRAFT_NOT_FOUND, p.rel, { kind: "file", name },
      `没有叫 "${name}" 的组件或页稿`,
      { fix: `现有：${list.slice(0, 12).map((c) => c.name).join(" / ")}${list.length > 12 ? " …" : ""}` }));
  }
  if (mode === "contract") return hit;
  const src = await readFile(`${p.dir}/${hit.file}`, "utf8");
  return { ...hit, source: src };
}
