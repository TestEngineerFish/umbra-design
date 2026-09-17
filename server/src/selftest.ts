/** 回归自测：不经过 MCP，直接打模块，拿真实存量稿验校验器。
 *
 * 判据：**能渲染的稿一条 error 都不该报。** 报了就是误报，先修校验器。
 * 用法：node dist/selftest.js [项目名]
 */
import { readFile } from "node:fs/promises";
import { basename, relative, sep } from "node:path";
import { listDrafts, loadProject, projectsRoot } from "./project.js";
import { getIcon, getToken, listComponents, listIcons, searchTokens } from "./assets.js";
import { validateDraft } from "./validate.js";

const name = process.argv[2] ?? "umbra";
const bar = (s: string) => console.log("\n" + "─".repeat(4) + " " + s + " " + "─".repeat(Math.max(0, 62 - s.length)));

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

bar("validate_draft · 全量回归");
const files = await listDrafts(p);
const byCode = new Map<string, number>();
const rows: Array<{ f: string; e: number; w: number; el: number; skipped: boolean; codes: string[] }> = [];
for (const abs of files) {
  const rel = relative(p.dir, abs).split(sep).join("/");
  const src = await readFile(abs, "utf8");
  const { diags, stats } = validateDraft(p, rel, src, rel);
  const e = diags.filter((d) => d.level === "error");
  const w = diags.filter((d) => d.level === "warning");
  for (const d of diags) byCode.set(d.code, (byCode.get(d.code) ?? 0) + 1);
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
console.log(`\n合计 error ${totalErr} · 洞审计放弃 ${skipped}/${rows.length} 份`);
console.log(totalErr === 0 ? "✓ 零 error" : "⚠️ 有 error，逐条核对是不是误报");
