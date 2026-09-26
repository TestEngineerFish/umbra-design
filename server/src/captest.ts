/** 能力注册表的回归（M11-1，Q36）。
 *
 *  **这份测的不是功能，是「散不散」。** 用户的原话是「加新东西要改的地方太散」，
 *  所以判据钉的全是**结构性质**：声明了就两面都有、名字不打架、入参没写重。
 *  功能本身有 `filetest` 管。
 */
import { allCaps, capsFor, httpRoutes } from "./cap/index.js";

let pass = 0, fail = 0;
const ok = (c: boolean, what: string, detail = "") => {
  if (c) { pass++; console.log(`  ✓ ${what}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`  ✗ ${what}${detail ? " — " + detail : ""}`); }
};

console.log("能力注册表（M11-1）");
const caps = allCaps();
ok(caps.length > 0, "能力模块真的被 import 到了", `${caps.length} 件`);
/* ⚠️ `defineCap` 是 import 时的副作用 —— `cap/index.ts` 漏了一行 import，
   那一组能力就**静悄悄地整组消失**，两个门面都不会报错。这一条就是防它的。 */

for (const c of caps) {
  ok(!!c.title && !!c.summary, `${c.name}：有 title 和 summary`);
  /* MCP 面拿 summary 当 description。只复述名字的说明等于没有 —— 
     调用方是模型，它靠这句话决定什么时候用这件工具。 */
  ok(c.summary.length >= 12, `${c.name}：summary 不是复述名字`, `${c.summary.length} 字`);
  /* `scope: "project"` 的能力**不能自己声明 project** —— MCP 面会注入一个，
     写重了 MCP 侧会出现两个 project，而 TypeScript 不会管。 */
  if (c.scope === "project") ok(!("project" in c.input), `${c.name}：没有自己声明 project（MCP 面会注入）`);
}

/* 两面一致：这是整件事的目的。声明了 http 就该有路由，声明了 mcp 就该有工具名。 */
const routes = httpRoutes();
ok(routes.size === capsFor("http").length, "每件对 http 暴露的能力都有唯一路由",
  `${routes.size} 条 / ${capsFor("http").length} 件`);
const names = new Set(caps.map((c) => c.name));
ok(names.size === caps.length, "能力名不重复");

/* 这一批搬过来的九件，原来有四件**只在 HTTP 侧有** ——
   现在它们自动出现在 MCP 面上，这正是「两个门面手写」要修的那个病。 */
const wasHttpOnly = ["trash_file", "revert_file", "list_file_refs", "count_file_types"];
for (const n of wasHttpOnly) {
  const c = caps.find((x) => x.name === n);
  ok(!!c && (c.faces ?? ["mcp", "http"]).includes("mcp"), `${n}：原来只有 HTTP 侧有，现在 MCP 面也有了`);
}

/* ── 搬过来当场修掉的那个真缺陷，钉住它（M11-7）──
   HTTP 侧的 `create_draft` 原来**不认 `source: "template"`**，掉进 blank 分支，
   于是「选了模板，建出来是空白稿」，而界面只说「已新建」。
   MCP 侧一直是对的 —— 两个门面各写一遍，只有一边补了模板这一档。
   ⚠️ 判据钉在**能力的入参**上，不钉在某一侧的实现上：合成一份之后，
   两个门面用的就是同一份声明，一边有一边没有这种事从机制上不会再发生。 */
{
  const { mkdir, mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { buildProject } = await import("./project.js");
  const cap = allCaps().find((c) => c.name === "create_draft")!;
  ok(!!cap, "create_draft 搬进 cap/ 了");
  ok(Object.keys(cap.input).includes("templateName"), "**create_draft 认得 template 这一档**（HTTP 侧原来没有）");

  const dir = await mkdtemp(join(tmpdir(), "umbrastudio-captest-"));
  await writeFile(join(dir, "project.json"), JSON.stringify({ name: "captest", title: "能力回归" }));
  await mkdir(join(dir, ".umbrastudio", "templates"), { recursive: true });
  await writeFile(join(dir, ".umbrastudio", "templates", "样板.dc.html"),
    '<!DOCTYPE html><html><head><script src="./support.js"></script></head><body><x-dc><div data-tpl-mark="来自模板">标记</div></x-dc></body></html>\n');
  const proj = await buildProject(dir);
  /* **两个门面各跑一次**：同一份声明，via 不同，结果必须一样 —— 
     以前这两条是两份实现，正是分叉的来源。 */
  for (const via of ["mcp", "http"] as const) {
    const out = await cap.run({ path: `套模板-${via}.dc.html`, source: "template", templateName: "样板" } as never,
      { project: proj, via });
    const src = (out.data as { source?: string } | null)?.source ?? "";
    ok(out.ok && src !== "空白骨架", `${via} 面：选模板建出来的**不是空白稿**`, `source=${src}`);
  }
  await rm(dir, { recursive: true, force: true });
}

console.log(fail === 0 ? `\n✓ 能力注册表 ${pass}/${pass + fail}` : `\n✗ 能力注册表 ${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
