/** .dc.html 的解析。doc/03 是语义出处，这里只做**校验与快照需要的那部分**抽取。
 *
 * 一切位置都按【原始文件】的下标算，所以诊断里的 line/col 指得准。
 */
import { lineIndex, matchBrace, objectTopLevel, methodBodyBrace, ownReturns, type Pos } from "./scan.js";

export type HolePosition = "text" | "attr-whole" | "attr-interp";

export interface Hole {
  /** 洞里的原文（已 trim） */
  raw: string;
  /** 点号路径的根名；表达式洞为 null */
  root: string | null;
  /** 完整点号路径；表达式洞为 null */
  path: string | null;
  /** 字面量洞：true / false / $index */
  literal: boolean;
  position: HolePosition;
  /** attr-* 时是属性名 */
  attr?: string;
  index: number;
  pos: Pos;
}

export interface ImportRef {
  name: string;
  selfClosing: boolean;
  index: number;
  pos: Pos;
  /** kebab→camel 之后的 props 键 */
  props: string[];
}

export interface Draft {
  /** 原始文件内容 */
  src: string;
  /** 相对租户根 */
  path: string;
  /** <x-dc> 的内容区间（不含标签本身） */
  template: { start: number; end: number } | null;
  /** 逻辑类脚本的内容区间 */
  logic: { start: number; end: number } | null;
  /** data-props 的原始（已反转义）JSON 文本 */
  propsRaw: string | null;
  props: Record<string, unknown> | null;
  holes: Hole[];
  imports: ImportRef[];
  /** 所有 sc-if 的 value 洞根名 */
  branches: Array<{ cond: string | null; index: number; pos: Pos }>;
  /** 所有 sc-for */
  lists: Array<{ list: string | null; as: string | null; index: number; pos: Pos }>;
  /** helmet 里的外链（解析后的相对路径原文） */
  helmetLinks: Array<{ url: string; index: number; pos: Pos }>;
  /** 静态元素标签数（开标签计数，与 05 的口径一致） */
  elements: number;
  /** 出现过的标签名（小写，去重） */
  tags: string[];
  /** 注释区间 */
  comments: Array<{ start: number; end: number; text: string }>;
  /** 用了 hint-* 属性的位置 */
  hints: Array<{ attr: string; index: number; pos: Pos }>;
  at: (index: number) => Pos;
}

const HOLE_RE = /\{\{([^}]*)\}\}/g;

/** 标签内属性区的引号感知片段。
 *
 * ⚠️ 不能用 [^>]* —— HTML 允许引号内出现 `>`，而 data-props 里的
 * `()=>void` 就有一个裸 `>`。用 [^>]* 会让开标签提前收尾，把属性值的后半段
 * 当成标签外内容（回归时把 data-props 的一半当成了逻辑类代码，报 E_LOGIC_SYNTAX）。
 */
const ATTRS = '(?:"[^"]*"|\'[^\']*\'|[^>"\'])*';
/** 点号路径：a / a.b.c；不允许括号、运算符、引号 */
const DOT_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const LITERALS = new Set(["true", "false", "$index"]);

function kebabToCamel(k: string): string {
  return k.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&quot;/g, '"').replace(/&#34;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** 判断一个洞出现在什么位置：文本 / 整值属性 / 插值属性 */
function holePosition(src: string, holeStart: number, holeEnd: number):
  { position: HolePosition; attr?: string } {
  // 往前找最近的 < 与 >，判断是否在标签内
  const lt = src.lastIndexOf("<", holeStart);
  const gt = src.lastIndexOf(">", holeStart);
  if (lt < 0 || gt > lt) return { position: "text" };

  // 在标签内：看紧邻的属性
  const before = src.slice(lt, holeStart);
  const m = before.match(/([A-Za-z_:@][-\w:.]*)\s*=\s*(["'])([^"']*)$/);
  if (!m) return { position: "text" };
  const attr = m[1] as string;
  const quote = m[2] as string;
  const prefixInValue = m[3] as string;
  const close = src.indexOf(quote, holeEnd);
  const suffixInValue = close < 0 ? "" : src.slice(holeEnd, close);
  const whole = prefixInValue.trim() === "" && suffixInValue.trim() === "";
  return { position: whole ? "attr-whole" : "attr-interp", attr };
}

function region(src: string, openRe: RegExp, closeTag: string): { start: number; end: number } | null {
  const m = openRe.exec(src);
  if (!m) return null;
  const start = m.index + m[0].length;
  const end = src.indexOf(closeTag, start);
  return end < 0 ? null : { start, end };
}

export function parseDraft(src: string, path: string): Draft {
  const at = lineIndex(src);

  const template = region(src, new RegExp(`<x-dc${ATTRS}>`, "i"), "</x-dc>");
  const logicOpen = new RegExp(`<script${ATTRS}\\bdata-dc-script\\b${ATTRS}>`, "i").exec(src);
  const logic = logicOpen
    ? (() => {
        const start = logicOpen.index + logicOpen[0].length;
        const end = src.indexOf("</script>", start);
        return end < 0 ? null : { start, end };
      })()
    : null;

  // data-props
  let propsRaw: string | null = null;
  let props: Record<string, unknown> | null = null;
  const pm = logicOpen ? /data-props\s*=\s*"([^"]*)"/i.exec(logicOpen[0]) : null;
  if (pm?.[1]) {
    propsRaw = unescapeHtml(pm[1]);
    try { props = JSON.parse(propsRaw) as Record<string, unknown>; } catch { props = null; }
  }

  // 注释（整份文件，含模板与逻辑外的）
  const comments: Draft["comments"] = [];
  for (let i = src.indexOf("<!--"); i >= 0; i = src.indexOf("<!--", i + 4)) {
    const end = src.indexOf("-->", i + 4);
    if (end < 0) break;
    comments.push({ start: i, end: end + 3, text: src.slice(i + 4, end) });
    i = end;
  }
  const inComment = (idx: number) => comments.some((c) => idx >= c.start && idx < c.end);

  // 洞（只看模板区间）
  const holes: Hole[] = [];
  if (template) {
    const tpl = src.slice(template.start, template.end);
    HOLE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = HOLE_RE.exec(tpl))) {
      const index = template.start + m.index;
      if (inComment(index)) continue;
      const raw = (m[1] ?? "").trim();
      const literal = LITERALS.has(raw);
      const isPath = DOT_PATH.test(raw);
      const { position, attr } = holePosition(src, index, index + m[0].length);
      const h: Hole = {
        raw,
        root: isPath ? (raw.split(".")[0] as string) : null,
        path: isPath ? raw : null,
        literal,
        position,
        index,
        pos: at(index),
      };
      if (attr) h.attr = attr;
      holes.push(h);
    }
  }

  // dc-import
  const imports: ImportRef[] = [];
  const impRe = new RegExp(`<dc-import\\b(${ATTRS}?)(/?)>`, "gi");
  let im: RegExpExecArray | null;
  while ((im = impRe.exec(src))) {
    if (inComment(im.index)) continue;
    const attrs = im[1] ?? "";
    const nameM = /\bname\s*=\s*["']([^"']*)["']/i.exec(attrs);
    const propKeys: string[] = [];
    for (const am of attrs.matchAll(/([A-Za-z_][-\w]*)\s*=\s*["']/g)) {
      const k = am[1] as string;
      if (k === "name" || k === "style" || k.startsWith("hint-")) continue;
      propKeys.push(kebabToCamel(k));
    }
    imports.push({
      name: nameM?.[1] ?? "",
      selfClosing: im[2] === "/",
      index: im.index,
      pos: at(im.index),
      props: propKeys,
    });
  }

  // sc-if / sc-for
  const branches: Draft["branches"] = [];
  for (const bm of src.matchAll(new RegExp(`<sc-if\\b(${ATTRS})>`, "gi"))) {
    if (inComment(bm.index)) continue;
    const v = /\bvalue\s*=\s*["']\s*\{\{([^}]*)\}\}\s*["']/i.exec(bm[1] ?? "");
    branches.push({ cond: v?.[1]?.trim() ?? null, index: bm.index, pos: at(bm.index) });
  }
  const lists: Draft["lists"] = [];
  for (const fm of src.matchAll(new RegExp(`<sc-for\\b(${ATTRS})>`, "gi"))) {
    if (inComment(fm.index)) continue;
    const attrs = fm[1] ?? "";
    const l = /\blist\s*=\s*["']\s*\{\{([^}]*)\}\}\s*["']/i.exec(attrs);
    const a = /\bas\s*=\s*["']([^"']*)["']/i.exec(attrs);
    lists.push({ list: l?.[1]?.trim() ?? null, as: a?.[1] ?? null, index: fm.index, pos: at(fm.index) });
  }

  // helmet 外链
  const helmetLinks: Draft["helmetLinks"] = [];
  const helmet = region(src, new RegExp(`<helmet${ATTRS}>`, "i"), "</helmet>");
  if (helmet) {
    const h = src.slice(helmet.start, helmet.end);
    for (const lm of h.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
      const idx = helmet.start + (lm.index ?? 0);
      helmetLinks.push({ url: lm[1] as string, index: idx, pos: at(idx) });
    }
  }

  // hint-*
  const hints: Draft["hints"] = [];
  for (const hm of src.matchAll(/\b(hint-[a-z-]+)\s*=/gi)) {
    if (inComment(hm.index)) continue;
    hints.push({ attr: hm[1] as string, index: hm.index, pos: at(hm.index) });
  }

  // 元素标签数与标签名（只数模板区间的开标签，与 05 的 grep 口径一致）
  const tagSet = new Set<string>();
  let elements = 0;
  if (template) {
    const tpl = src.slice(template.start, template.end);
    for (const tm of tpl.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)/g)) {
      const idx = template.start + (tm.index ?? 0);
      if (inComment(idx)) continue;
      elements++;
      tagSet.add((tm[1] as string).toLowerCase());
    }
  }

  return {
    src, path, template, logic, propsRaw, props, holes, imports, branches, lists,
    helmetLinks, elements, tags: [...tagSet].sort(), comments, hints, at,
  };
}

// ───────────────────────── 逻辑类：renderVals 的键 ─────────────────────────

export interface ValsAudit {
  /** 每条 return 路径给出的顶层键（并集前先分路径存，好报 E_RETURN_PATH_GAP） */
  paths: Array<{ keys: string[]; index: number; pos: Pos }>;
  /** 所有路径的并集 */
  union: string[];
  /** true = 有搞不定的展开或计算键，审计放弃（不报不能证明的错） */
  opaque: boolean;
  /** renderVals 根本找不到 */
  missing: boolean;
}

/** 收集 renderVals()（含它展开的 this.xxxVals()）在各条 return 路径上的顶层键 */
export function auditRenderVals(d: Draft): ValsAudit {
  const out: ValsAudit = { paths: [], union: [], opaque: false, missing: false };
  if (!d.logic) { out.missing = true; return out; }
  const js = d.src.slice(d.logic.start, d.logic.end);
  const base = d.logic.start;

  const bodyOpen = methodBodyBrace(js, "renderVals");
  if (bodyOpen < 0) { out.missing = true; return out; }
  const bodyClose = matchBrace(js, bodyOpen);
  if (bodyClose < 0) { out.opaque = true; return out; }

  const seenMethods = new Set<string>(["renderVals"]);

  /** 解析一个方法体里的所有 return 对象；返回每条路径的键 */
  const collect = (open: number, close: number, depth = 0): Array<{ keys: string[]; index: number }> => {
    if (depth > 4) { out.opaque = true; return []; }
    const res: Array<{ keys: string[]; index: number }> = [];
    for (const abs of ownReturns(js, open, close)) {
      let i = abs + 6;
      while (i < close && /\s/.test(js[i] as string)) i++;
      if (js[i] !== "{") {
        // return 了别的东西（表达式 / 方法调用）—— 拿不准，标 opaque
        out.opaque = true;
        continue;
      }
      const shape = objectTopLevel(js, i);
      if (shape.opaque) out.opaque = true;
      const keys = [...shape.keys];
      for (const sp of shape.spreads) {
        const mm = /^this\.([A-Za-z_$][\w$]*)\s*\(/.exec(sp);
        if (!mm) { out.opaque = true; continue; }
        const name = mm[1] as string;
        if (seenMethods.has(name)) continue;
        seenMethods.add(name);
        const o2 = methodBodyBrace(js, name);
        const c2 = o2 >= 0 ? matchBrace(js, o2) : -1;
        if (o2 < 0 || c2 < 0) { out.opaque = true; continue; }
        for (const p of collect(o2, c2, depth + 1)) keys.push(...p.keys);
      }
      res.push({ keys, index: abs });
    }
    return res;
  };

  for (const p of collect(bodyOpen, bodyClose)) {
    out.paths.push({ keys: p.keys, index: base + p.index, pos: d.at(base + p.index) });
  }
  out.union = [...new Set(out.paths.flatMap((p) => p.keys))].sort();
  if (out.paths.length === 0) out.opaque = true;
  return out;
}
