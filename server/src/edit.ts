/** 属性级写入与撤销。doc/09 §3.2 §3.3、doc/00 §十八
 *
 * ── set_prop 为什么不能是「整文件重写」也不能是「文本锚点」 ──
 *
 * `write_draft` 要模型把 6,000 元素的稿全文再吐一遍；`patch_draft` 的锚点是文本
 * 匹配，而 `padding:8px` 在一份稿里能出现 40 次，必然多命中。
 * L1 要的是「改这个节点的这一个属性」，所以按节点地址定位（`00` §十七）。
 *
 * ── 三条硬要求（`09` §3.2）──
 *
 *  1. 只动目标那一处，其余字节不变
 *  2. **目标是洞就拒绝**，并说清该改 `renderVals` 里哪个键 ——
 *     不能默默把洞覆盖成字面量，那会把一个联动的值改成死值，是静默破坏
 *  3. 走同一条落盘路：校验 / 归一化 / 快照 / changelog 一样不少
 *
 * ── 关于连续拖动 ──
 *
 * 一次调用 = 一次落盘 = 一个版本。拖滑块的中间态**不要**调这个 ——
 * 用运行时自带的 `window.__dcSetProps(name, overrides)` 做实时预览
 * （ClaudeDesign 的 props 面板就是这么做的，`00` §17.1），松手才调一次 set_prop。
 */
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { E, X } from "./codes.js";
import { err, ToolError, type Diagnostic } from "./envelope.js";
import { parseDraft } from "./draft.js";
import { listNodes } from "./nodeid.js";
import { draftPath, type Project } from "./project.js";
import { locateNode, resolveDraft } from "./locate.js";
import { normalizeStyle } from "./snapshot.js";
import { writeDraft, type WriteOutcome } from "./write.js";
import { listVersions, snapDir , type VersionOrigin } from "./history.js";

export type SlotKind = "style" | "attr" | "text";

export interface SetPropResult {
  file: string;
  /** 改之前的地址 */
  node: string;
  /** 改之后的地址 —— 开标签变了，哈希就变了（doc/09 §2.2）。界面要用这个接着调 */
  newNode: string | null;
  kind: SlotKind;
  name: string;
  from: string | null;
  to: string;
  write: WriteOutcome;
}

const ATTRS_IN_TAG = /([A-Za-z_:@][-\w:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
const hasHole = (v: string) => /\{\{[^}]*\}\}/.test(v);

/** 把一个 style 声明串里的某个属性换掉 / 加上 / 删掉（value 为空串就是删） */
function setStyleDecl(raw: string, prop: string, value: string): string {
  const parts = raw.split(";").map((x) => x.trim()).filter(Boolean);
  const out: string[] = [];
  let done = false;
  for (const part of parts) {
    const i = part.indexOf(":");
    if (i < 0) { out.push(part); continue; }
    if (part.slice(0, i).trim().toLowerCase() !== prop.toLowerCase()) { out.push(part); continue; }
    done = true;
    if (value) out.push(`${prop}: ${value}`);
  }
  if (!done && value) out.push(`${prop}: ${value}`);
  return out.join("; ");
}

function refuse(code: Parameters<typeof err>[0], file: string, name: string, msg: string, fix: string): never {
  throw new ToolError(err(code, file, { kind: "key", name }, msg, { fix }));
}

export async function setProp(
  p: Project, fileOrName: string, nodeId: string, kind: SlotKind, name: string, value: string,
  origin?: VersionOrigin,
): Promise<SetPropResult> {
  const rel = await resolveDraft(p, fileOrName);
  const abs = draftPath(p, rel);
  const src = await readFile(abs, "utf8");
  const d = parseDraft(src, rel);
  if (!d.template) refuse(X.IO, rel, rel, "这份稿没有 <x-dc> 模板区", "先确认这是一份 .dc.html 设计稿");

  const refs = listNodes(src, d.template.start, d.template.end);
  const ref = refs.find((r) => r.id === nodeId);
  if (!ref) {
    refuse(X.DRAFT_NOT_FOUND, rel, nodeId, `稿 "${rel}" 里没有地址为 ${nodeId} 的节点`,
      `这份稿现在有 ${refs.length} 个节点。地址是内容哈希，节点自己被改过之后会变 —— 先调 locate_node 重新取`);
  }

  // ── 要求 2：先问清楚这一处能不能改 ──
  const loc = await locateNode(p, rel, nodeId);
  const slot = loc.slots.find((s) => s.kind === kind && s.name.toLowerCase() === name.toLowerCase());

  if (slot && !slot.editable) {
    const keys = Object.entries(loc.origins)
      .map(([k, o]) => `${k}（${o.kind}：${o.note}）`).join("；");
    refuse(E.SLOT_NOT_EDITABLE, rel, `${kind}.${name}`,
      `这一处的值来自洞 {{ ${slot.holes.join(" }} / {{ ")} }}，不能直接覆盖成字面量`,
      `覆盖它会把一个联动的值改成死值。要改就改 renderVals 里的键：${keys || "（这份稿的洞审计没做，改法要人工确认）"}`);
  }
  if (loc.auditSkipped && slot && slot.holes.length) {
    refuse(E.SLOT_NOT_EDITABLE, rel, `${kind}.${name}`,
      "这一处有洞，而这份稿的洞审计没做 —— 判不出能不能改",
      `洞审计放弃的原因：${loc.auditSkippedWhy}。这种情况交给模型改逻辑类，不要走 set_prop`);
  }

  // ── 要求 1：只动目标那一处 ──
  let from: string | null = null;
  let newTag: string;
  let head = src.slice(0, ref.start);
  let tail = src.slice(ref.end);

  if (kind === "text") {
    const nextLt = tail.indexOf("<");
    from = (nextLt < 0 ? tail : tail.slice(0, nextLt));
    if (hasHole(from)) {
      refuse(E.SLOT_NOT_EDITABLE, rel, "text",
        `这个节点的文本里有洞（${from.trim().slice(0, 40)}），不能整段覆盖`,
        "改洞对应的 renderVals 键；只想改洞旁边的固定文字就用 patch_draft");
    }
    newTag = ref.openTag;
    tail = value + (nextLt < 0 ? "" : tail.slice(nextLt));
  } else {
    const attrs = new Map<string, { whole: string; value: string }>();
    ATTRS_IN_TAG.lastIndex = 0;
    for (const am of ref.openTag.matchAll(ATTRS_IN_TAG)) {
      attrs.set((am[1] as string).toLowerCase(), { whole: am[0], value: am[3] ?? am[4] ?? "" });
    }
    if (kind === "style") {
      const cur = attrs.get("style");
      const raw = cur?.value ?? "";
      if (hasHole(raw) && !Object.keys(normalizeStyle(raw)).length) {
        refuse(E.SLOT_NOT_EDITABLE, rel, `style.${name}`,
          `整个 style 值是一个洞（${raw.trim().slice(0, 40)}），改不了单个声明`,
          "改那个洞对应的 renderVals 键");
      }
      from = normalizeStyle(raw)[name.toLowerCase()] ?? null;
      const next = setStyleDecl(raw, name, value);
      newTag = cur
        ? ref.openTag.replace(cur.whole, `style="${next}"`)
        : ref.openTag.replace(/(\/?)>$/, ` style="${next}"$1>`);
    } else {
      const cur = attrs.get(name.toLowerCase());
      from = cur?.value ?? null;
      if (cur && hasHole(cur.value)) {
        refuse(E.SLOT_NOT_EDITABLE, rel, `attr.${name}`,
          `属性 ${name} 的值是一个洞（${cur.value.trim().slice(0, 40)}），不能覆盖成字面量`,
          "改那个洞对应的 renderVals 键");
      }
      newTag = value === ""
        ? (cur ? ref.openTag.replace(cur.whole, "").replace(/\s+(\/?)>$/, "$1>") : ref.openTag)
        : (cur
            ? ref.openTag.replace(cur.whole, `${name}="${value}"`)
            : ref.openTag.replace(/(\/?)>$/, ` ${name}="${value}"$1>`));
    }
  }

  const next = head + newTag + tail;
  if (next === src) {
    return { file: rel, node: nodeId, newNode: nodeId, kind, name, from, to: value,
      write: { path: rel, written: false, refused: null, steps: ["值与现状一致，什么都没改"],
        bytes: src.length, version: null, snapshot: null, runtimeCopied: [], unchanged: true,
        change: null, changelog: null } };
  }

  // ── 要求 3：走同一条落盘路 ──
  const kindOf = Object.keys(d.props ?? {}).some((k) => !k.startsWith("$")) ? "component" : "page";
  const { outcome } = await writeDraft(p, rel, next, kindOf as "page" | "component", undefined, origin ? { origin } : undefined);

  // 改过的节点地址会变 —— 回报新地址，界面才能接着调
  let newNode: string | null = null;
  if (outcome.written) {
    const after = await readFile(abs, "utf8");
    const ad = parseDraft(after, rel);
    if (ad.template) {
      const idx = refs.findIndex((r) => r.id === nodeId);
      const nr = listNodes(after, ad.template.start, ad.template.end);
      newNode = (nr[idx]?.id) ?? null;
    }
  }
  return { file: rel, node: nodeId, newNode, kind, name, from, to: value, write: outcome };
}

// ───────────────────────── 撤销 ─────────────────────────

/** 撤销是**向前**的操作：把 v<K> 的内容作为新的一版落盘，历史保持只增不改。
 *
 * 这样 changelog 会照常记下这次回退（实现侧看得见「回到了哪一版」），
 * 而不是悄悄把历史改掉 —— 悄悄改历史就是 `07` 的变更交付有个洞。
 */
export async function revertTo(
  p: Project, fileOrName: string, version: string, origin?: VersionOrigin,
): Promise<{ file: string; from: string; restored: string; write: WriteOutcome }> {
  const rel = await resolveDraft(p, fileOrName);
  const vs = await listVersions(p, rel);
  if (!vs.includes(version)) {
    refuse(X.SNAPSHOT_MISSING, rel, version, `"${version}" 不在这份稿的版本序列里`,
      vs.length ? `现有：${vs.join(" / ")}` : "这份稿还没有经 write_draft 落过盘");
  }
  const gz = join(snapDir(p, rel), `${version}.src.html.gz`);
  if (!existsSync(gz)) {
    refuse(X.SNAPSHOT_MISSING, rel, version,
      `${version} 有语义快照，但没有源码副本，恢复不了`,
      "源码副本是从这一版功能上线之后才开始存的（doc/00 §18.2）。老版本只能靠 git 兜底：diff_drafts 按 git ref 取");
  }
  const restored = gunzipSync(await readFile(gz)).toString("utf8");
  const kindOf = Object.keys(parseDraft(restored, rel).props ?? {}).some((k) => !k.startsWith("$"))
    ? "component" : "page";
  const latest = vs[vs.length - 1] as string;
  const { outcome } = await writeDraft(p, rel, restored, kindOf as "page" | "component",
    `这一版是**回退**：把 ${version} 的内容原样落成新的一版（从 ${latest} 退回）。下面列的是相对 ${latest} 的差异。`,
    origin ? { origin } : undefined);
  return { file: rel, from: latest, restored: version, write: outcome };
}

export type { Diagnostic };
