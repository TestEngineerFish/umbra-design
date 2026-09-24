import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReadFileResult } from "../api/types";
import type { ViewContext } from "./context";
import type { KindModule } from "./registry";

/** JSON（M8-14 新加的一种类型）。
 *
 *  **这一种是为了验证解耦而加的**：从零到能用，动的是三处 ——
 *  `shared/kinds.ts` 加一条 `KindDef`、这个文件、`kinds/index.ts` 加一行。
 *  `Workbench.tsx` 零改动。抽象抽对了就该是这样。
 *
 *  给的能力（按「先能看，再谈编辑」的顺序）：
 *  - **结构树**：折叠、每行显示类型与值预览、对象/数组给子项数
 *  - **点一行 = 把这个路径带给 AI**，药丸的 detail 里带上它的 JSON 路径和值 ——
 *    这是 JSON 比纯文本视图值钱的地方：说「把 `channels.b.model` 改成 X」不用描述位置
 *  - **解析失败时指出行列**，并直接停在源码档上那一行
 *
 *  还没有的：就地改值（下一轮）。所以源码档现在是只读的。
 */
type Leaf = "string" | "number" | "boolean" | "null";
interface Row { path: string; key: string; depth: number; kind: Leaf | "object" | "array"; value: unknown; count: number }

function kindOfValue(v: unknown): Row["kind"] {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v === "object" ? "object" : (typeof v as Leaf);
}

/** 摊平成一维行表（和 `FileTree` 同一个套路）—— 递归渲染嵌套 div 在深层会很慢，
 *  而摊平之后每行都是兄弟节点，折叠只是从表里少几行。 */
function flatten(value: unknown, collapsed: Set<string>): Row[] {
  const out: Row[] = [];
  const walk = (v: unknown, key: string, path: string, depth: number) => {
    const kind = kindOfValue(v);
    const entries = kind === "object" ? Object.entries(v as Record<string, unknown>) : kind === "array" ? (v as unknown[]).map((x, i) => [String(i), x] as const) : [];
    out.push({ path, key, depth, kind, value: v, count: entries.length });
    if (collapsed.has(path)) return;
    for (const [k, child] of entries) walk(child, k, path ? `${path}.${k}` : k, depth + 1);
  };
  walk(value, "", "", 0);
  return out;
}

const PREVIEW: Record<Row["kind"], (r: Row) => string> = {
  string: (r) => JSON.stringify(r.value as string),
  number: (r) => String(r.value),
  boolean: (r) => String(r.value),
  null: () => "null",
  object: (r) => (r.count ? `{ ${r.count} 项 }` : "{ }"),
  array: (r) => (r.count ? `[ ${r.count} 项 ]` : "[ ]"),
};
const COLOR: Record<Row["kind"], string> = {
  string: "text-accent", number: "text-text", boolean: "text-text", null: "text-muted",
  object: "text-muted", array: "text-muted",
};

/** 把连续空白折成一个空格，并记下折叠后每个字符的原始下标 —— 给下面第 ③ 条用 */
function squeeze(text: string): { flat: string; map: number[] } {
  let flat = "", ws = false;
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { if (!ws) { flat += " "; map.push(i); ws = true; } continue; }
    ws = false; flat += c; map.push(i);
  }
  return { flat, map };
}

/** `JSON.parse` 失败在文件的哪一行。
 *
 *  ⚠️ **不能只认 `position N`** —— 这是实测栽的一次（M8-14）：
 *  V8 报 `Unexpected token ']', ..." [1, 2, 3,] } " is not valid JSON`，
 *  整条消息里**一个数字都没有**，于是回退到「第 1 行第 1 列」，
 *  而真正的错在第 3 行。报错位置指错地方比不报更坏 —— 人会照着去看那一行。
 *
 *  所以三条路依次试：
 *  ① 新引擎直接给 `line L column C`
 *  ② 老格式给字节偏移 `position N`
 *  ③ 两样都没有时，消息里带着出错处**周围的一段原文**。
 *     它被压掉了换行（`]\n}` 变成 `] }`），所以两边都把空白折平了再找。
 */
function whereFailed(text: string, err: unknown): { line: number; col: number; why: string } {
  const why = err instanceof Error ? err.message : String(err);
  const at = (i: number) => {
    const before = text.slice(0, i);
    const nl = before.lastIndexOf("\n");
    return { line: before.split("\n").length, col: i - nl, why };
  };
  const lc = /line (\d+) column (\d+)/.exec(why);
  if (lc) return { line: Number(lc[1]), col: Number(lc[2]), why };
  const pos = /position (\d+)/.exec(why);
  if (pos) return at(Number(pos[1]));
  const frag = /\.\.\."(.+?)"(?:\.\.\.)? is not valid JSON/s.exec(why) ?? /^(?:.*?)"(.+?)" is not valid JSON/s.exec(why);
  const piece = (frag?.[1] ?? "").trim();
  if (piece) {
    const { flat, map } = squeeze(text);
    const j = flat.indexOf(squeeze(piece).flat);
    if (j >= 0 && map[j] !== undefined) return at(map[j]);
  }
  return { line: 1, col: 1, why };
}

function View({ ctx }: { ctx: ViewContext }) {
  const [text, setText] = useState<string | null>(null);
  const [why, setWhy] = useState<string | null>(null);
  const [view, setView] = useState<"tree" | "source">(() => ctx.mem.get("view", "tree" as "tree" | "source"));
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [hit, setHit] = useState<string | null>(null);

  const tick = ctx.store.fileTick(ctx.path);
  const load = useCallback(async () => {
    const r = await ctx.core.get<ReadFileResult>(`file?path=${encodeURIComponent(ctx.path)}`);
    if (!r.ok || !r.data) { setWhy(r.errors?.[0]?.message ?? "读不到这个文件"); setText(null); return; }
    setText(r.data.content ?? ""); setWhy(null); setHit(null);
  }, [ctx.core, ctx.path]);
  /* 盘上变了就重读 —— AI 改完文件右边要立刻是新的（`00` §六十六第 6 条） */
  useEffect(() => { void load(); }, [load, tick]);

  const parsed = useMemo(() => {
    if (text === null) return null;
    try { return { ok: true as const, value: JSON.parse(text) as unknown }; }
    catch (e) { return { ok: false as const, ...whereFailed(text, e) }; }
  }, [text]);
  const rows = useMemo(() => (parsed?.ok ? flatten(parsed.value, collapsed).slice(1) : []), [parsed, collapsed]);

  const setV = (v: "tree" | "source") => { setView(v); ctx.mem.set("view", v); };
  /* 解析不过就没有树可看，自动停在源码那一档（但不写进记忆 —— 换个好文件要回到树） */
  const shown = parsed && !parsed.ok ? "source" : view;

  const pick = (r: Row) => {
    setHit(r.path);
    ctx.select("range", {
      kind: "range",
      label: `${ctx.path.split("/").pop()} › ${r.path}`,
      detail: `${ctx.path} 里的 ${r.path}\n${JSON.stringify(r.value, null, 2).slice(0, 2000)}`,
    });
    ctx.ui.expandChat();
  };

  if (why) return <div className="flex-1 grid place-items-center text-xs text-err bg-canvas">{why}</div>;
  if (text === null) return <div className="flex-1 grid place-items-center text-xs text-muted bg-canvas">读取中…</div>;

  return (
    <div className="flex-1 min-w-0 flex flex-col bg-canvas">
      {/* 这条工具栏还在视图内部 —— 第七轮要把它上移到统一那一行（M8-15），到时候整条搬走 */}
      <div className="h-[34px] px-2 flex items-center gap-2 border-b border-border bg-panel shrink-0 text-xs">
        <div className="seg">
          <button className={shown === "tree" ? "on" : ""} onClick={() => setV("tree")} disabled={!parsed?.ok} title={parsed?.ok ? "结构：折叠、点一行把它带给 AI" : "解析不过，先在源码里改对"}>结构</button>
          <button className={shown === "source" ? "on" : ""} onClick={() => setV("source")}>源码</button>
        </div>
        {parsed?.ok
          ? <span className="text-muted font-mono text-[11px]">{rows.length} 行 · {text.split("\n").length} 行源码</span>
          : <span className="text-err text-[11px]">第 {parsed?.line} 行第 {parsed?.col} 列解析不过 · {parsed?.why}</span>}
        <span className="flex-1" />
        {parsed?.ok && <>
          <button className="btn sm ghost" onClick={() => setCollapsed(new Set(rows.filter((r) => r.count).map((r) => r.path)))}>全折</button>
          <button className="btn sm ghost" onClick={() => setCollapsed(new Set())}>全展</button>
        </>}
      </div>
      {shown === "tree" ? (
        <div className="flex-1 min-h-0 overflow-auto py-1 font-mono text-xs">
          {rows.map((r) => {
            const branch = r.kind === "object" || r.kind === "array";
            const open = branch && !collapsed.has(r.path);
            return (
              <div key={r.path} onClick={() => pick(r)}
                className={`flex items-center gap-1.5 h-[22px] pr-3 cursor-pointer ${hit === r.path ? "bg-accentSoft" : "hover:bg-hover"}`}
                style={{ paddingLeft: 6 + (r.depth - 1) * 16 }} title={r.path}>
                <span className="w-4 shrink-0 text-[10px] text-muted grid place-items-center transition-transform"
                  style={{ transform: open ? "rotate(90deg)" : "none" }}
                  onClick={(e) => { if (!branch) return; e.stopPropagation(); setCollapsed((c) => { const n = new Set(c); n.has(r.path) ? n.delete(r.path) : n.add(r.path); return n; }); }}>
                  {branch && r.count ? "▶" : ""}
                </span>
                <span className="shrink-0 text-text2">{r.key}</span>
                <span className="text-muted">:</span>
                <span className={`truncate ${COLOR[r.kind]}`}>{PREVIEW[r.kind](r)}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <pre className="flex-1 min-h-0 overflow-auto p-3 font-mono text-xs leading-relaxed">{text.split("\n").map((ln, i) => (
          <div key={i} className={parsed && !parsed.ok && i + 1 === parsed.line ? "text-err font-semibold" : ""}>
            <span className={`inline-block w-10 text-right pr-3 select-none ${parsed && !parsed.ok && i + 1 === parsed.line ? "text-err" : "text-muted"}`}>{i + 1}</span>{ln}
          </div>
        ))}</pre>
      )}
    </div>
  );
}

export const json: KindModule = {
  ids: ["json"],
  View,
};
