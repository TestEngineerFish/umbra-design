/** 回归自测：不经过 MCP，直接打模块。三块，判据各不相同。
 *
 *  1. `fixtures/静态/` —— **工具自己的基准**，随仓库走，精确匹配 `expect.json`。
 *     该报的没报、不该报的报了，都算失败。这是唯一能证明「不该报的没报」的一块 ——
 *     语料里不存在的写法，再多语料也照不出来。
 *  2. `ui/` —— 工具界面稿。判据：**一条 error 都不许有**（这几份是我们自己写的）。
 *  3. `projects/<名>` —— 用户的真实语料。**有就跑，没有就跳过**：那是用户自己的项目，
 *     不进这个仓库，clone 下来不该因为它缺席就跑不了回归。判据是「零误报」——
 *     语料里的真缺陷列在 KNOWN_REAL 里，那是稿的问题，不是工具的。
 *
 * 用法：node dist/selftest.js [项目名]
 */
import { readFile, readdir } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { buildProject, listDrafts, listProjectDirs, loadProject, projectsRoot, TOOL_ROOT } from "./project.js";
import { getIcon, getToken, listComponents, listIcons, searchTokens } from "./assets.js";
import { validateDraft } from "./validate.js";
import { prepareForDisk } from "./normalize.js";

const name = process.argv[2] ?? "umbra";
const bar = (s: string) => console.log("\n" + "─".repeat(4) + " " + s + " " + "─".repeat(Math.max(0, 62 - s.length)));

// ════════════ 一、fixtures/静态 —— 工具自己的基准 ════════════
const fxDir = join(TOOL_ROOT, "fixtures");
const fxP = await buildProject(fxDir);
const expect: Record<string, { codes: string[]; why: string }> =
  JSON.parse(await readFile(join(fxDir, "expect.json"), "utf8"));

bar("fixtures/静态 —— 精确匹配");
let fxBad = 0;
for (const rel of Object.keys(expect).sort()) {
  const want = (expect[rel] as { codes: string[] }).codes;
  const v = validateDraft(fxP, rel, await readFile(join(fxDir, rel), "utf8"), rel);
  const got = [...new Set(v.diags.map((d) => String(d.code)))].sort();
  // hint-* 是写法提示，和判据无关 —— 基准稿里也不写它，这里只是防御
  const real = got.filter((c) => c !== "W_HINT_IGNORED");
  const missing = want.filter((c) => !real.includes(c));
  const extra = real.filter((c) => !want.includes(c));
  const ok = !missing.length && !extra.length;
  if (!ok) fxBad++;
  console.log(`  ${ok ? "✓" : "✗"} ${rel.replace("静态/", "").replace(".dc.html", "").slice(0, 34).padEnd(36)}` +
    (ok ? (want.length ? want.join(" ") : "（一条都不报）")
        : `${missing.length ? " 该报没报：" + missing.join(" ") : ""}${extra.length ? " 不该报却报了：" + extra.join(" ") : ""}`));
  if (!ok) {
    console.log(`      钉的是：${(expect[rel] as { why: string }).why}`);
    for (const d of v.diags.filter((x) => extra.includes(String(x.code)))) {
      console.log(`      → ${d.code} ${d.locator?.name ?? ""} — ${d.message.slice(0, 90)}`);
    }
  }
}
console.log(fxBad ? `  ✗ ${fxBad} 条基准没过` : `  ✓ ${Object.keys(expect).length} 条基准全过`);

// ════════════ 二、语料（有就跑） ════════════
const dirs = await listProjectDirs();
if (!dirs.length) {
  bar("语料");
  console.log(`  ${projectsRoot()} 下没有项目 —— 跳过这一块。`);
  console.log("  语料是用户自己的项目，不进这个仓库；基准与界面稿两块不依赖它。");
  await uiBlock();
  finish(fxBad, 0, 0);
}

const p = await loadProject(name);
console.log(`项目根 ${projectsRoot()}`);
console.log(`项目   ${p.name} · ${p.title}`);
console.log(`ds     ${p.dsDir}`);
console.log(`git    ${p.gitEnabled ? "有" : "无"}   限额 ${p.limits.elementsWarn}/${p.limits.elementsHard}`);

bar("search_tokens");
for (const q of ["danger", "#E8590C", "行高", "minTapTarget", "radius.card"]) {
  const r = await searchTokens(p, q, 3);
  console.log(`  "${q}" → ${r.total} 命中`);
  for (const h of r.hits) console.log(`      ${h.path}  [${h.kind}]  ${JSON.stringify(h.value).slice(0, 56)}`);
}

bar("get_token");
for (const path of ["color.light.bg", "color.light", "rules.orangeUsage"]) {
  const t = await getToken(p, path);
  console.log(`  ${path} → leaf=${t.leaf} kind=${t.kind ?? "-"} ${JSON.stringify(t.value).slice(0, 70)}`);
}

bar("图标");
const ic = await listIcons(p, "chevron", 5);
console.log(`  viewBox ${ic.viewBox} · "chevron" ${ic.total} 命中`);
for (const i of ic.icons) console.log(`      ${i.name}  ${i.cn ?? ""}  [${i.group ?? "-"}]`);
const one = await getIcon(p, "chevron-right");
console.log(`  get_icon chevron-right → ${one.body.slice(0, 50)}`);

bar("list_components");
const comps = await listComponents(p);
console.log(`  ${comps.length} 份稿，其中 ${comps.filter((c) => c.props.length).length} 份有 props`);
for (const c of comps.filter((cc) => cc.props.length).slice(0, 5)) {
  console.log(`      ${c.name}  ${c.elements} 元素  props: ${c.props.map((x) => x.name).join(", ").slice(0, 70)}`);
}

/** 已确认为**真缺陷**的 error —— 不是误报，是存量稿里真的有问题。
 *
 * 为什么要这张表：回归的判据从来不是「零 error」，是「零误报」。
 * 洞审计的注释 bug 修掉之后（doc/00 §16.2），审计从 32 份扩到 54 份，
 * 立刻抓出两个真缺陷 —— 工具是对的，稿是错的。这时候把判据放成「零 error」
 * 只有两条路：改稿（但怎么改是设计决定，不是我的），或者把工具改回瞎。都不行。
 *
 * 所以：**这张表里的照旧放过，表外的任何 error 都算回归失败。**
 * 修好一份稿就从表里删一行。
 */
const KNOWN_REAL: Array<{ file: string; code: string; at: string; why: string }> = [
  { file: "PC 端/任务.dc.html", code: "E_HOLE_UNRESOLVED", at: "decideMeta",
    why: "模板 291 行把 {{ decideMeta }} 传给 PC 错误卡 的 meta prop（{label,value}[]），renderVals() 里没有这个键 —— 那张错误卡的信息行是空的" },
  { file: "PC 端/任务.dc.html", code: "E_HOLE_UNRESOLVED", at: "decideActions",
    why: "同上，actions prop（{label,kind?,act?}[]）也没给 —— 那张错误卡一颗按钮都没有" },
  { file: "PC 端/Pages/任务.dc.html", code: "E_HOLE_UNRESOLVED", at: "decideMeta", why: "同上，这是同一份稿的副本" },
  { file: "PC 端/Pages/任务.dc.html", code: "E_HOLE_UNRESOLVED", at: "decideActions", why: "同上，这是同一份稿的副本" },
];

const isKnown = (file: string, code: string, at: string) =>
  KNOWN_REAL.some((k) => k.file === file && k.code === code && k.at === at);

bar("validate_draft · 全量回归");
const files = await listDrafts(p);
const byCode = new Map<string, number>();
const known: Array<{ f: string; code: string; at: string; msg: string }> = [];
const unknown: Array<{ f: string; code: string; at: string; msg: string }> = [];
const rows: Array<{ f: string; e: number; w: number; el: number; skipped: boolean; codes: string[] }> = [];
for (const abs of files) {
  const rel = relative(p.dir, abs).split(sep).join("/");
  const src = await readFile(abs, "utf8");
  const { diags, stats } = validateDraft(p, rel, src, rel);
  const e = diags.filter((d) => d.level === "error");
  const w = diags.filter((d) => d.level === "warning");
  for (const d of diags) byCode.set(d.code, (byCode.get(d.code) ?? 0) + 1);
  for (const d of e) {
    const at = d.locator?.name ?? "";
    (isKnown(rel, d.code, at) ? known : unknown).push({ f: rel, code: d.code, at, msg: d.message });
  }
  rows.push({
    f: basename(rel), e: e.length, w: w.length,
    el: stats.elements as number,
    skipped: stats.holeAuditSkipped as boolean,
    codes: [...new Set(e.map((d) => d.code))],
  });
}
rows.sort((a, b) => b.e - a.e || b.w - a.w);
console.log(`  稿数 ${rows.length}`);
console.log(`  ${"稿".padEnd(30)} err  warn  元素  洞审计  error 码`);
for (const r of rows) {
  console.log(`  ${r.f.slice(0, 29).padEnd(30)} ${String(r.e).padStart(3)} ${String(r.w).padStart(5)} ${String(r.el).padStart(6)}  ${r.skipped ? "放弃" : "已做"}    ${r.codes.join(" ")}`);
}

bar("诊断码分布");
for (const [c, n] of [...byCode.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${c.padEnd(24)} ${n}`);
}
const totalErr = rows.reduce((s, r) => s + r.e, 0);
const skipped = rows.filter((r) => r.skipped).length;
console.log(`\n合计 error ${totalErr}（已确认真缺陷 ${known.length} · 待核 ${unknown.length}）· 洞审计放弃 ${skipped}/${rows.length} 份`);

if (known.length) {
  bar("已确认的真缺陷（稿的问题，不是工具的）");
  for (const k of known) console.log(`  ${k.f}  ${k.code}  ${k.at}`);
}
if (unknown.length) {
  bar("⚠️ 表外的 error —— 逐条核对是不是误报");
  for (const u of unknown) console.log(`  ${u.f}  ${u.code}  ${u.at}\n      ${u.msg}`);
}
const uiErr = await uiBlock();
finish(fxBad, unknown.length, uiErr);


/** 落盘归一化的基准：@ds 展开要按**稿所在目录**算相对深度。
 *  钉的是 2026-09-24 犯过的错 —— 展开时不管稿在哪，一律贴相对项目根的 `_ds/…`，
 *  子目录里的稿于是去要 `/<子目录>/_ds/…`，404，token 全部失效（`00` §五十七）。
 *  四种情形各钉一条：根 / 子目录 × 稿里写 @ds / 盘上已是展开过的 _ds。 */
function dsDepthBlock(): number {
  bar("落盘归一化 —— @ds 相对深度");
  const p = { ...fxP, dsDir: "_ds/x", dsAlias: "@ds" };
  const href = (s: string) => (/href="([^"]*)"/.exec(s) ?? [])[1] ?? "(没有)";
  const cases: Array<{ rel: string; src: string; want: string; why: string }> = [
    { rel: "a.dc.html", src: `<link href="@ds/t.css">`, want: "_ds/x/t.css", why: "根目录的稿：展开成相对项目根的路径" },
    { rel: "子/a.dc.html", src: `<link href="@ds/t.css">`, want: "../_ds/x/t.css", why: "子目录的稿：要补 ../，否则浏览器去要 /子/_ds/…" },
    { rel: "子/深/a.dc.html", src: `<link href="@ds/t.css">`, want: "../../_ds/x/t.css", why: "两层子目录：补两个 ../" },
    { rel: "子/a.dc.html", src: `<link href="_ds/x/t.css">`, want: "../_ds/x/t.css", why: "存量稿：上一版展开错的路径，再落一次盘要修好" },
    { rel: "a.dc.html", src: `<link href="_ds/x/t.css">`, want: "_ds/x/t.css", why: "根目录的存量稿：不该被动" },
    { rel: "子/a.dc.html", src: `<link href="../_ds/x/t.css">`, want: "../_ds/x/t.css", why: "已经对的不该被再补一层" },
  ];
  let bad = 0;
  for (const c of cases) {
    const got = href(prepareForDisk(p, c.src, c.rel).content);
    const ok = got === c.want;
    if (!ok) bad++;
    console.log(`  ${ok ? "✓" : "✗"} ${c.rel.padEnd(14)} ${c.src.slice(6, 40).padEnd(28)} → ${got}${ok ? "" : `（该是 ${c.want}）`}`);
    if (!ok) console.log(`      钉的是：${c.why}`);
  }
  console.log(bad ? `  ✗ ${bad} 条没过` : `  ✓ ${cases.length} 条全过`);
  return bad;
}

/** 工具自己的界面稿。它们不在 projects/ 下，原来整块没被回归覆盖 ——
 *  而这几份恰恰是改得最勤的（每个批次都动）。判据比语料更严：
 *  **一条 error 都不许有**，因为这几份是我们自己写的，没有「稿的历史问题」可推。
 *  import 以 ui/ 为基准解析（S7 引 IconGlyph），所以这里用 ui/ 当 dir。 */
async function uiBlock(): Promise<number> {
  fxBad += dsDepthBlock();
  bar("工具界面稿 ui/");
  const uiDir = join(TOOL_ROOT, "ui");
  const uiP = { ...fxP, dir: uiDir };
  let uiErr = 0;
  for (const f of (await readdir(uiDir)).filter((x) => x.endsWith(".dc.html")).sort()) {
    const v = validateDraft(uiP, f, await readFile(join(uiDir, f), "utf8"), f);
    const e = v.diags.filter((d) => d.level === "error");
    const w = v.diags.filter((d) => d.level === "warning");
    uiErr += e.length;
    console.log(`  ${f.slice(0, 29).padEnd(30)} ${String(e.length).padStart(3)} ${String(w.length).padStart(5)} ` +
      `${String(v.stats.elements).padStart(6)}  ${v.stats.holeAuditSkipped ? "放弃" : "已做"}    ` +
      `${[...new Set(e.map((d) => d.code))].join(" ")}`);
    for (const d of e) console.log(`      ✗ ${d.code} ${d.locator?.name ?? ""} — ${d.message}`);
    for (const d of w) console.log(`      · ${d.code} ${d.locator?.name ?? ""} — ${d.message}`);
  }
  return uiErr;
}

/** 三块的结论合成一条。基准和界面稿任一不过就是失败 —— 语料那块只看误报。 */
function finish(fx: number, unknownErr: number, uiErr: number): never {
  const parts = [
    fx ? `基准 ${fx} 条没过` : "基准全过",
    uiErr ? `界面稿 error ${uiErr} 条` : "界面稿零 error",
    unknownErr ? `语料表外 error ${unknownErr} 条` : "语料零误报",
  ];
  const fail = fx + unknownErr + uiErr;
  console.log(`\n${fail === 0 ? "✓" : "✗"} ${parts.join(" · ")}`);
  process.exitCode = fail === 0 ? 0 : 1;
  process.exit(fail === 0 ? 0 : 1);
}
