/** 节点地址。doc/09 §二、doc/00 §十七
 *
 * ── 为什么不直接用运行时自带的那套 ──
 *
 * `support.js` 里已经有一套：`compileTemplate` 给模板里每个元素打
 * `data-dc-tpl="<序号>"`（前序遍历计数），渲染出的 DOM 节点带同一个序号，
 * 再由 `window.__dcAnnotatedTemplate(name)` 把带标注的模板源码交给宿主编辑器，
 * 宿主自己解析成 DOM 来做「DOM 节点 → 源码节点」的映射。
 * ClaudeDesign 的 props 面板走的就是这条路。
 *
 * 我们不能照抄，原因只有一条 —— **我们的宿主是 Node，不是浏览器。**
 * 那套序号是「HTML 解析器解析之后的前序序号」，而解析器会**凭空造元素**
 * （表格里的隐含 `<tbody>`、`<p>` / `<li>` 的自动闭合），
 * 所以在 Node 里按源码的开标签顺序数，对不上浏览器里的序号。
 * 要对上就得在 Node 里复刻一遍 HTML 解析 —— 不值得，而且每次定位都要开一次
 * Chromium 更不值得（L1 拖滑块是连续几十次交互）。
 *
 * 我们的做法：**自己在落盘时把地址写成普通属性**，源稿保持干净
 * （和 `__resources` 注入同一条规矩，`00` §14.7）。实测普通 `data-` 属性
 * 原样进 DOM，`sc-for` 的克隆全带同一个 id —— 那正是「选中源码里这个元素」
 * 该有的语义（`00` §17.2）。这样 `locate_node` 不需要浏览器。
 *
 * ── id 怎么来 ──
 *
 * 短哈希(规范化后的开标签) + 同形元素里的出现序号。
 *
 * **已知限制，写在契约里不绕过：**
 *  - 改了这个节点本身，它的 id 就变 —— 所以写入类工具的返回必须带**新 id**
 *  - 在一串同形元素中间插一个，后面同形的序号会挪
 * 别处怎么改都不影响。这比行号和结构路径都稳（`07` §2.4 已经因为同样的理由
 * 否掉了按路径配对）。
 */
import { createHash } from "node:crypto";

export const NODE_ATTR = "data-ud-node";

/** 引号感知的属性段 —— 属性值里可以有裸 `>`（doc/00 §13.4 踩过） */
const ATTRS = '(?:"[^"]*"|\'[^\']*\'|[^>"\'])*';
const OPEN_TAG = new RegExp(`<([a-zA-Z][\\w-]*)(${ATTRS})>`, "g");

const STRIP_RE = new RegExp(`\\s*${NODE_ATTR}\\s*=\\s*("[^"]*"|'[^']*')`, "g");

/** 规范化开标签：去掉已有的地址属性、去掉自闭合斜杠、折叠空白 ——
 *  让 id 只取决于「这个元素是什么」。
 *
 *  ⚠️ 自闭合那个 `/` 必须去掉。实测踩到：`<img … />` 打标之后剥回来是
 *  `<img …/>`（剥地址属性时把它前面那个空格一起吃掉了），和原来的
 *  `<img … />` 归一化结果不同 → 同一个元素算出两个 id，幂等也破了。
 */
function normalizeOpenTag(tag: string, attrs: string): string {
  const cleaned = attrs
    .replace(STRIP_RE, "")
    .replace(/\/\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return `<${tag.toLowerCase()} ${cleaned}>`;
}

export interface NodeRef {
  id: string;
  tag: string;
  /** 开标签在整份源码里的起止下标 */
  start: number;
  end: number;
  /** 开标签原文（含属性），用于回显与定位 */
  openTag: string;
}

/** 走一遍模板区里的开标签，算出每个元素的地址。
 *
 * 只走模板区（`<x-dc>` 之内）—— head 里的 script/link 不是设计节点。
 */
export function listNodes(src: string, tplStart: number, tplEnd: number): NodeRef[] {
  const tpl = src.slice(tplStart, tplEnd);
  const seen = new Map<string, number>();
  const out: NodeRef[] = [];
  OPEN_TAG.lastIndex = 0;
  for (const m of tpl.matchAll(OPEN_TAG)) {
    const tag = (m[1] as string);
    const attrs = (m[2] ?? "");
    const norm = normalizeOpenTag(tag, attrs);
    const h = createHash("sha256").update(norm, "utf8").digest("hex").slice(0, 8);
    const n = seen.get(h) ?? 0;
    seen.set(h, n + 1);
    out.push({
      id: n === 0 ? h : `${h}.${n}`,
      tag: tag.toLowerCase(),
      start: tplStart + (m.index as number),
      end: tplStart + (m.index as number) + m[0].length,
      openTag: m[0],
    });
  }
  return out;
}

/** 落盘用：给模板区每个元素的开标签插上地址属性。幂等 —— 已有的先剥掉再算。 */
export function stampNodes(src: string, tplStart: number, tplEnd: number): { out: string; count: number } {
  const refs = listNodes(src, tplStart, tplEnd);
  if (!refs.length) return { out: src, count: 0 };

  // 从后往前插，前面的下标才不会被挪动
  let out = src;
  for (let i = refs.length - 1; i >= 0; i--) {
    const r = refs[i] as NodeRef;
    // 先剥掉这个开标签里可能已有的地址属性（幂等），再把插入点前的空白收干净 ——
    // 否则自闭合标签会多留一个空格，第二次跑出来的字节数就不一样了
    const clean = r.openTag.replace(STRIP_RE, "");
    const selfClose = /\/\s*>$/.test(clean);
    const head = clean.slice(0, clean.length - (selfClose ? clean.length - clean.lastIndexOf("/") : 1)).replace(/\s+$/, "");
    const stamped = `${head} ${NODE_ATTR}="${r.id}"${selfClose ? " />" : ">"}`;
    out = out.slice(0, r.start) + stamped + out.slice(r.end);
  }
  return { out, count: refs.length };
}

/** 剥掉所有地址属性 —— 从落盘副本回到源稿形态时用 */
export function unstampNodes(src: string): string {
  return src.replace(new RegExp(`\\s*${NODE_ATTR}\\s*=\\s*("[^"]*"|'[^']*')`, "g"), "");
}
