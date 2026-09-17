/** 节点定位：从预览里点中的东西回到源码。doc/09 §二、doc/00 §十七
 *
 * 预览里怎么拿到地址（实测，`00` §17.3）：
 *
 *   const host = el.closest('[data-sc-name]');      // 哪份稿（组件名）
 *   const id   = el.getAttribute('data-ud-node');   // 稿里的哪个节点
 *   地址 = `${host?.getAttribute('data-sc-name') ?? 页根组件名}#${id}`
 *
 * 两个属性都已经在 DOM 里 —— `data-sc-name` 是运行时自己打的组件边界，
 * `data-ud-node` 是我们落盘时打的。所以这一步不需要浏览器往服务端问。
 *
 * ⚠️ `dc-import` 元素本身在 DOM 里不存在（运行时用子件内容替换掉了），
 * 所以它在源码里可寻址、在预览里点不到。点到的是子件里的节点，
 * 带的是**子文件**的地址 —— 这就是地址必须带文件名的原因。
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { X } from "./codes.js";
import { err, ToolError } from "./envelope.js";
import { parseDraft } from "./draft.js";
import { auditRenderVals, classifyOrigin, type HoleOrigin } from "./draft.js";
import { listNodes, type NodeRef } from "./nodeid.js";
import { draftPath, listDrafts, type Project } from "./project.js";
import { normalizeStyle } from "./snapshot.js";

/** 一条可改项：节点上的一个样式声明 / 属性 / 文本 */
export interface Slot {
  kind: "style" | "attr" | "text";
  name: string;
  value: string;
  /** 值里有洞就不是字面量 —— 这时候改法取决于洞的来源 */
  holes: string[];
  editable: boolean;
  note: string;
}

export interface LocateResult {
  file: string;
  node: string;
  tag: string;
  at: { line: number; col: number };
  openTag: string;
  /** 同一个地址在渲染后可能对应多个 DOM 节点（在 sc-for 里） */
  inList: boolean;
  slots: Slot[];
  /** 这个节点用到的洞，各自的来源 */
  origins: Record<string, HoleOrigin>;
  /** 洞审计没做的话，可编辑性判断只能给一半 —— 照实说 */
  auditSkipped: boolean;
  auditSkippedWhy: string | null;
}

const ATTR_RE = /([A-Za-z_:@][-\w:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
const HOLE_RE = /\{\{([^}]*)\}\}/g;

function holesIn(v: string): string[] {
  return [...v.matchAll(HOLE_RE)].map((m) => (m[1] ?? "").trim()).filter(Boolean);
}

/** 洞的根名 —— `{{ r.name }}` 的根是 `r`，`{{ a.b.c }}` 的根是 `a` */
const rootOf = (hole: string) => (hole.split(".")[0] ?? hole).trim();

/** 按组件名或路径找到那份稿 */
export async function resolveDraft(p: Project, nameOrPath: string): Promise<string> {
  const files = (await listDrafts(p)).map((a) => a.slice(p.dir.length + 1).split("\\").join("/"));
  if (files.includes(nameOrPath)) return nameOrPath;
  const stem = nameOrPath.replace(/\.dc\.html$/, "");
  const hit = files.filter((f) => basename(f).replace(/\.dc\.html$/, "") === stem);
  if (hit.length === 1) return hit[0] as string;
  if (hit.length > 1) {
    throw new ToolError(err(X.DRAFT_NOT_FOUND, nameOrPath, { kind: "file", name: nameOrPath },
      `"${nameOrPath}" 对应 ${hit.length} 份同名稿，说不清是哪一份`,
      { fix: `用完整相对路径：${hit.join(" / ")}` }));
  }
  throw new ToolError(err(X.DRAFT_NOT_FOUND, nameOrPath, { kind: "file", name: nameOrPath },
    `找不到稿 "${nameOrPath}"`,
    { fix: "地址的文件部分来自预览里的 data-sc-name（组件名），也可以直接给相对路径" }));
}

export async function locateNode(p: Project, fileOrName: string, nodeId: string): Promise<LocateResult> {
  const rel = await resolveDraft(p, fileOrName);
  const src = await readFile(draftPath(p, rel), "utf8");
  const d = parseDraft(src, rel);
  if (!d.template) {
    throw new ToolError(err(X.IO, rel, { kind: "file", name: rel }, "这份稿没有 <x-dc> 模板区"));
  }
  const refs = listNodes(src, d.template.start, d.template.end);
  const ref = refs.find((r) => r.id === nodeId);
  if (!ref) {
    throw new ToolError(err(X.DRAFT_NOT_FOUND, rel, { kind: "key", name: nodeId },
      `稿 "${rel}" 里没有地址为 ${nodeId} 的节点`,
      { fix: `这份稿现在有 ${refs.length} 个节点。地址是内容哈希 —— 节点自己被改过之后地址会变，重新取一次（doc/09 §2.2）` }));
  }

  // 在 sc-for 之内？—— 决定「改这一处会影响渲染后的几个节点」。
  // d.lists 只记了开标签位置，所以这里按嵌套深度自己数到配对的 </sc-for>。
  const listSpan = (open: number): number => {
    const re = /<\/?sc-for\b/gi;
    re.lastIndex = open;
    let depth = 0;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      depth += m[0][1] === "/" ? -1 : 1;
      if (depth === 0) return m.index;
    }
    return src.length;
  };
  const inList = d.lists.some((l) => ref.start > l.index && ref.start < listSpan(l.index));

  const audit = auditRenderVals(d);
  const origins: Record<string, HoleOrigin> = {};
  const slots: Slot[] = [];

  const originOf = (hole: string): HoleOrigin => {
    const root = rootOf(hole);
    if (origins[root]) return origins[root] as HoleOrigin;
    // sc-for 的循环变量：它的来源是那个列表，不在 renderVals 顶层
    const asVar = d.lists.find((l) => l.as === root);
    const o: HoleOrigin = asVar
      ? { kind: "computed", expr: `sc-for as="${root}" ← {{ ${asVar.list} }}`, editable: false,
          note: `循环变量，一行改了所有行 —— 值来自列表 ${asVar.list}` }
      : audit.origins[root] ?? classifyOrigin("");
    origins[root] = o;
    return o;
  };

  const push = (kind: Slot["kind"], name: string, value: string) => {
    const hs = holesIn(value);
    if (!hs.length) {
      slots.push({ kind, name, value, holes: [], editable: true, note: "字面量，可以直接改" });
      return;
    }
    const os = hs.map(originOf);
    const allEditable = os.every((o) => o.editable);
    slots.push({
      kind, name, value, holes: hs,
      editable: false,
      note: allEditable
        ? `值来自洞 {{ ${hs.join(" }} / {{ ")} }} —— 改 renderVals 里那个字面量：${os.map((o) => o.note).join("；")}`
        : os.map((o) => o.note).join("；"),
    });
  };

  ATTR_RE.lastIndex = 0;
  for (const am of ref.openTag.matchAll(ATTR_RE)) {
    const k = (am[1] as string).toLowerCase();
    const v = am[3] ?? am[4] ?? "";
    if (k === "data-ud-node") continue;                 // 工具自己的簿记属性
    if (k === "style") {
      for (const [prop, val] of Object.entries(normalizeStyle(v))) push("style", prop, val);
      // 洞可能横跨整个 style 值（`style="{{ s }}"`），normalizeStyle 拆不出来
      if (!Object.keys(normalizeStyle(v)).length && holesIn(v).length) push("style", "(整段)", v);
      continue;
    }
    push("attr", k, v);
  }

  // 紧随开标签之后的直接文本
  const after = src.slice(ref.end);
  const nextLt = after.indexOf("<");
  const text = (nextLt < 0 ? after : after.slice(0, nextLt)).trim();
  if (text) push("text", "(文本)", text);

  return {
    file: rel, node: nodeId, tag: ref.tag,
    at: d.at(ref.start), openTag: ref.openTag,
    inList, slots, origins,
    auditSkipped: audit.opaque || audit.missing,
    auditSkippedWhy: audit.missing ? "没有 renderVals()" : audit.opaque ? audit.opaqueWhy.join("；") : null,
  };
}

export type { NodeRef };
