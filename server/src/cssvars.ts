/** 一份稿自己声明的 CSS 自定义属性。属性面板的颜色控件靠它给候选。
 *
 * 为什么不是「设计系统的 token 路径」：那是两套命名空间。token 是
 * `color.light.faint`，而稿里写的是 `var(--faint)` —— 二者只是**大多数时候**
 * 能用 kebab(叶子名) 对上：实测 42 个 color.light 键里 32 个能对上，10 个
 * `catN` 对应的是稿里的 `--c1..--c10`；反过来稿里还有 27 个 var 名
 * （`--font-sans` / `--focus-ring` / `--glass-bg` …）在 color.light 里根本没有。
 * 也就是说，按 token 路径拼 `var(--…)` 有一成多的概率写出一个**这份稿里没定义**
 * 的变量 —— 那是静默失效的坏值。
 *
 * 所以候选只从**这份稿里真的声明了的**变量来，写进去一定解析得开；
 * 顺带把每个变量对上的 token 路径标出来，让人知道它是不是设计系统里的那个值。
 */
import { readFile } from "node:fs/promises";
import type { Project } from "./project.js";
import { tokenLeaves } from "./assets.js";
import { resolveDraft } from "./locate.js";
import { join } from "node:path";

export interface CssVarHit {
  /** 不带 -- 的名字，比如 faint */
  name: string;
  /** 声明里的原值 */
  value: string;
  /** 一路解到底的字面值；解不开给 null（不猜） */
  resolved: string | null;
  /** 值和设计系统某个 token 相等时给出那条路径；对不上给 null */
  token: string | null;
  /** 看得出是颜色 */
  isColor: boolean;
}

const COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|color-mix\()/i;

/** `--name: value` —— 只收 <style> 与 style 属性之外的声明块里的。
 *  值里可能有分号（`rgba(0,0,0,.5)` 没有，但 `font-family` 有逗号没分号），
 *  所以按 `;` 或 `}` 断句就够，不需要真解析 CSS。 */
const DECL_RE = /--([a-z0-9][\w-]*)\s*:\s*([^;}]+)/gi;

export async function listCssVars(
  p: Project, fileOrName: string, query?: string, limit = 40
): Promise<{ file: string; total: number; truncated: boolean; hits: CssVarHit[] }> {
  const rel = await resolveDraft(p, fileOrName);
  const src = await readFile(join(p.dir, rel), "utf8");

  // 只在 <style>…</style> 里找。style="" 属性里的 --x 是局部的，不能当全局候选。
  const decls = new Map<string, string>();
  for (const m of src.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    const css = (m[1] as string).replace(/\/\*[\s\S]*?\*\//g, "");
    DECL_RE.lastIndex = 0;
    for (const d of css.matchAll(DECL_RE)) {
      decls.set((d[1] as string), (d[2] as string).trim());
    }
  }

  /** var(--a) 链一路解到字面值。解不开（引到没声明的变量、带 fallback 的复杂式）给 null。 */
  const resolve = (v: string, seen = new Set<string>()): string | null => {
    const t = v.trim();
    const m = /^var\(\s*--([\w-]+)\s*(?:,([^)]*))?\)$/.exec(t);
    if (!m) return t;
    const nm = m[1] as string;
    if (seen.has(nm)) return null;                     // 循环引用
    seen.add(nm);
    const next = decls.get(nm);
    if (next !== undefined) return resolve(next, seen);
    const fb = (m[2] ?? "").trim();
    return fb ? resolve(fb, seen) : null;              // 没声明、也没兜底 → 解不开
  };

  const leaves = await tokenLeaves(p);
  const byValue = new Map<string, string>();
  for (const l of leaves) {
    if (typeof l.value === "string") {
      const k = l.value.trim().toLowerCase();
      if (!byValue.has(k)) byValue.set(k, l.path);     // 同值多 token 取第一条
    }
  }

  const q = (query ?? "").trim().toLowerCase();
  const all: CssVarHit[] = [...decls.entries()].map(([name, value]) => {
    const resolved = resolve(value);
    return {
      name, value, resolved,
      token: resolved ? (byValue.get(resolved.toLowerCase()) ?? null) : null,
      isColor: COLOR_RE.test(resolved ?? value),
    };
  });

  const matched = q
    ? all.filter((h) => h.name.toLowerCase().includes(q)
        || (h.token ?? "").toLowerCase().includes(q)
        || (h.resolved ?? "").toLowerCase().includes(q))
    : all;
  // 颜色排前面，其余按名字 —— 颜色控件要的就是颜色
  matched.sort((a, b) => (a.isColor === b.isColor ? a.name.localeCompare(b.name) : a.isColor ? -1 : 1));
  return {
    file: rel, total: matched.length, truncated: matched.length > limit,
    hits: matched.slice(0, limit),
  };
}
