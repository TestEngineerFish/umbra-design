/** 生命周期回归测试。M1-13
 *
 * 在临时目录里走完完整的生命周期，每步后校验引用完整性：
 *   建项目 → 建组件稿 → 建页面稿（引组件）→ 改名 → 移动 → 删除 → 恢复
 * 每步之后 validate_draft 的 E_IMPORT_MISSING 必须为 0。
 *
 * 用法：node dist/lifecycletest.js
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createProject, createDraft, loadProject, listDrafts, buildProject, updateProject, archiveProject } from "./project.js";
import { buildRefGraph, renameDraft, moveDraft, deleteDraft, restoreDraft, listTrash, deleteDraftImpact } from "./refs.js";
import { validateDraft } from "./validate.js";
import { touchProject, listRecentProjects } from "./workspace.js";

const bar = (s: string) => console.log("\n" + "─".repeat(4) + " " + s + " " + "─".repeat(Math.max(0, 62 - s.length)));
const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const fail = (msg: string) => { console.log(`  ✗ ${msg}`); failed.push(msg); };

const failed: string[] = [];
let TEMP: string;
let p: Awaited<ReturnType<typeof loadProject>>;

async function main() {
  // 创建临时目录
  TEMP = join(tmpdir(), `umbrastudio-lifecycle-${Date.now()}`);
  await mkdir(TEMP, { recursive: true });
  console.log(`临时目录 ${TEMP}`);

  try {
    await step1_createProject();
    await step2_createDrafts();
    await step3_checkReferences();
    await step4_renameDraft();
    await step5_moveDraft();
    await step6_deleteAndImpact();
    await step7_restoreFromTrash();
    await step8_workspaceTracking();
    await step9_updateProject();
    await step10_archiveProject();

    bar("总结");
    if (failed.length === 0) {
      ok("生命周期回归全通过");
    } else {
      console.log(`  ✗ ${failed.length} 条失败：`);
      for (const f of failed) console.log(`    — ${f}`);
      process.exitCode = 1;
    }
  } finally {
    // 清理临时目录（如果 archive 没把它移走的话）
    if (existsSync(TEMP)) {
      await rm(TEMP, { recursive: true, force: true });
    }
    // 清理归档目录
    const archiveParent = join(tmpdir());
    try {
      for (const d of await readdir(archiveParent)) {
        if (d.startsWith("umbrastudio-archived-")) {
          await rm(join(archiveParent, d), { recursive: true, force: true });
        }
      }
    } catch { /* 忽略 */ }
  }
}

/** 检查整个项目里没有任何 E_IMPORT_MISSING */
async function checkNoMissingImports(label: string): Promise<boolean> {
  const drafts = await listDrafts(p);
  let missing = 0;
  for (const abs of drafts) {
    const rel = abs.slice(p.dir.length + 1).split("/").join("/");
    const src = await readFile(abs, "utf8");
    const v = validateDraft(p, rel, src, rel);
    missing += v.diags.filter((d) => d.code === "E_IMPORT_MISSING").length;
  }
  if (missing === 0) {
    ok(`${label}：E_IMPORT_MISSING = 0（${drafts.length} 份稿）`);
    return true;
  } else {
    fail(`${label}：E_IMPORT_MISSING = ${missing}`);
    return false;
  }
}

async function step1_createProject() {
  bar("步骤 1：创建项目");
  const name = "lifecycle-test";

  const r = await createProject(name, {
    dir: TEMP,
    title: "生命周期测试项目",
  });

  ok(`项目创建在 ${r.dir}`);

  // 验证 project.json 存在
  const projJson = JSON.parse(await readFile(join(r.dir, "project.json"), "utf8"));
  if (projJson.name !== name) { fail("project.json name 不对"); return; }
  ok("project.json 正确");

  // 加载项目（用 buildProject 因为临时目录不在 projectsRoot 下）
  p = await buildProject(r.dir);

  // 验证 .gitignore 存在
  if (!existsSync(join(r.dir, ".gitignore"))) { fail(".gitignore 缺失"); return; }
  ok(".gitignore 存在");
}

async function step2_createDrafts() {
  bar("步骤 2：创建稿件");

  // 2a. 创建组件稿
  await createDraft(p, "PC 按钮.dc.html", { kind: "blank" });
  ok("组件稿创建：PC 按钮.dc.html");

  // 2b. 创建页面稿（空白）
  await createDraft(p, "登录页.dc.html", { kind: "blank" });
  ok("页面稿创建：登录页.dc.html");

  // 2c. 手动修改页面稿，让它引用组件稿
  const pageAbs = join(p.dir, "登录页.dc.html");
  let pageSrc = await readFile(pageAbs, "utf8");
  pageSrc = pageSrc.replace("<x-dc>", `<x-dc>\n<dc-import name="PC 按钮" hint-props='{"tone":"primary"}'></dc-import>`);
  await writeFile(pageAbs, pageSrc, "utf8");
  ok("页面稿已插入 dc-import 引用组件");

  // 验证两份稿都能通过校验（没有 E_IMPORT_MISSING）
  await checkNoMissingImports("创建后");
}

async function step3_checkReferences() {
  bar("步骤 3：引用图谱查询");

  const graph = await buildRefGraph(p);

  // 检查 PC 按钮 被谁引用
  const compEntry = graph.files.get("PC 按钮.dc.html");
  if (!compEntry) { fail("图谱里找不到 PC 按钮.dc.html"); return; }
  if (compEntry.importedBy.length !== 1) { fail(`PC 按钮应该被 1 份稿引用，实际 ${compEntry.importedBy.length}`); return; }
  if (compEntry.importedBy[0]?.rel !== "登录页.dc.html") { fail(`引用方不对：${compEntry.importedBy[0]?.rel ?? "(none)"}`); return; }
  ok("PC 按钮 被 登录页.dc.html 引用");

  // 检查 登录页 引用了谁
  const pageEntry = graph.files.get("登录页.dc.html");
  if (!pageEntry) { fail("图谱里找不到 登录页.dc.html"); return; }
  if (pageEntry.imports.length !== 1) { fail(`登录页应该引用了 1 份稿，实际 ${pageEntry.imports.length}`); return; }
  ok("登录页 引用了 PC 按钮");
}

async function step4_renameDraft() {
  bar("步骤 4：重命名组件稿");

  const renameR = await renameDraft(p, "PC 按钮.dc.html", "主按钮");
  ok(`组件重命名：PC 按钮 → 主按钮（修了 ${renameR.referencesUpdated} 处引用）`);

  // 验证文件名变了
  const oldAbs = join(p.dir, "PC 按钮.dc.html");
  const newAbs = join(p.dir, "主按钮.dc.html");
  if (existsSync(oldAbs)) { fail("旧文件还在"); return; }
  if (!existsSync(newAbs)) { fail("新文件不在"); return; }
  ok("文件已重命名");

  // 验证引用方的 dc-import name 被更新了
  const pageAbs = join(p.dir, "登录页.dc.html");
  const pageSrc = await readFile(pageAbs, "utf8");
  if (pageSrc.includes('name="PC 按钮"')) { fail("引用方里的 dc-import name 没有更新"); return; }
  if (!pageSrc.includes('name="主按钮"')) { fail("引用方里的 dc-import name 不是新名字"); return; }
  ok("引用方里的 dc-import name 已更新");

  // 验证引用完整性
  await checkNoMissingImports("重命名后");
}

async function step5_moveDraft() {
  bar("步骤 5：移动组件稿到子目录");

  const moveR = await moveDraft(p, "主按钮.dc.html", "Components");
  ok(`组件移动到 Components/（修了 ${moveR.referencesUpdated} 处引用）`);

  // 验证文件在新位置
  const oldAbs = join(p.dir, "主按钮.dc.html");
  const newAbs = join(p.dir, "Components", "主按钮.dc.html");
  if (existsSync(oldAbs)) { fail("旧位置文件还在"); return; }
  if (!existsSync(newAbs)) { fail("新位置文件不在"); return; }
  ok("文件已移动");

  // 验证引用方的 dc-import name 变成了相对路径
  const pageAbs = join(p.dir, "登录页.dc.html");
  const pageSrc = await readFile(pageAbs, "utf8");
  if (!pageSrc.includes("Components/主按钮")) { fail("引用方里的 dc-import name 没有更新为相对路径"); return; }
  ok("引用方里的 dc-import name 已更新为相对路径");

  // 验证引用完整性
  await checkNoMissingImports("移动后");
}

async function step6_deleteAndImpact() {
  bar("步骤 6：删除前影响分析 + 删除");

  // 先把稿移回顶层（restore_draft 恢复后放在基名位置，不在子目录）。
  // 这样删除/恢复都在顶层，name 是基名，恢复后引用路径不变。
  await moveDraft(p, "Components/主按钮.dc.html", ".");
  ok("组件移回顶层（准备删除/恢复测试）");
  await checkNoMissingImports("移回顶层后");

  // 6a. 影响分析
  const impact = await deleteDraftImpact(p, "主按钮.dc.html");
  if (impact.affectedCount !== 1) { fail(`影响分析应该显示 1 个引用方，实际 ${impact.affectedCount}`); return; }
  if (!impact.importedBy.some((r) => r.rel === "登录页.dc.html")) { fail("影响分析没列出 登录页.dc.html"); return; }
  ok(`影响分析正确：1 个引用方（${impact.importedBy[0]?.rel ?? "(none)"}）`);

  // 6b. 执行删除
  const delR = await deleteDraft(p, "主按钮.dc.html");
  ok(`组件已删除，移入回收站：${delR.trashPath}`);

  // 验证原文件不在了
  const compAbs = join(p.dir, "主按钮.dc.html");
  if (existsSync(compAbs)) { fail("组件文件还在（没被移进回收站）"); return; }
  ok("组件文件已移走");

  // 验证回收站目录里有东西
  const trashItems = await listTrash(p);
  if (trashItems.length !== 1) { fail(`回收站里应该有 1 项，实际 ${trashItems.length}`); return; }
  ok(`回收站有 ${trashItems.length} 项`);

  // 删除后引用方应该报 E_IMPORT_MISSING —— 这是预期的
  const pageAbs = join(p.dir, "登录页.dc.html");
  const pageSrc = await readFile(pageAbs, "utf8");
  const v = validateDraft(p, "登录页.dc.html", pageSrc, "登录页.dc.html");
  const missing = v.diags.filter((d) => d.code === "E_IMPORT_MISSING");
  if (missing.length !== 1) { fail(`删除后页面稿应该报 1 个 E_IMPORT_MISSING，实际 ${missing.length}`); return; }
  ok("删除后引用方正确报 E_IMPORT_MISSING（预期行为）");
}

async function step7_restoreFromTrash() {
  bar("步骤 7：从回收站恢复");

  const trashItems = await listTrash(p);
  const trashItem = trashItems[0];
  if (!trashItem) { fail("回收站里没有项"); return; }
  const trashPath = trashItem.trashPath;

  const restoreR = await restoreDraft(p, trashPath);
  ok(`组件已从回收站恢复到 ${restoreR.originalPath}`);

  // 验证文件回来了
  const restoredAbs = join(p.dir, restoreR.originalPath);
  if (!existsSync(restoredAbs)) { fail("恢复后的文件不在"); return; }
  ok("文件已恢复到原位置");

  // 验证引用完整性（恢复后应该不再报 E_IMPORT_MISSING）
  await checkNoMissingImports("恢复后");

  // 验证回收站空了
  const trashAfter = await listTrash(p);
  if (trashAfter.length !== 0) { fail(`恢复后回收站应该为空，实际 ${trashAfter.length} 项`); return; }
  ok("回收站已空");
}

async function step8_workspaceTracking() {
  bar("步骤 8：工作区与最近项目");

  // touch 这个项目
  await touchProject(p.dir, p.name, p.title);
  ok("已 touch 项目");

  // 查最近项目列表
  const recents = await listRecentProjects(5);
  if (recents.recents.length < 1) { fail("最近项目列表为空"); return; }

  const first = recents.recents[0];
  if (!first) { fail("最近项目列表为空"); return; }

  // 我们的项目应该在列表最前面
  if (first.dir !== p.dir) { fail(`最近项目应该是我们刚 touch 的，实际是 ${first.dir}`); return; }
  ok(`最近项目列表第一条是我们：${first.name}`);
}

async function step9_updateProject() {
  bar("步骤 9：更新项目配置");

  await updateProject(p, {
    title: "生命周期测试项目-改名后",
    elementsWarn: 800,
    elementsHard: 1000,
  });
  ok("项目配置已更新");

  // 重新加载验证
  const p2 = await buildProject(p.dir);
  if (p2.title !== "生命周期测试项目-改名后") { fail("标题没更新"); return; }
  if (p2.limits.elementsWarn !== 800) { fail("elementsWarn 没更新"); return; }
  if (p2.limits.elementsHard !== 1000) { fail("elementsHard 没更新"); return; }
  ok("重新加载后配置正确");
}

async function step10_archiveProject() {
  bar("步骤 10：归档项目");

  const archiveDir = join(tmpdir(), `umbrastudio-archived-${Date.now()}`);
  const archiveR = await archiveProject(p, archiveDir);

  ok(`项目已归档到 ${archiveR.archivePath}`);

  // 验证原目录不在了
  if (existsSync(p.dir)) { fail("项目目录还在（归档没生效）"); return; }
  ok("原项目目录已移走");

  // 验证归档目录存在
  if (!existsSync(archiveR.archivePath)) { fail("归档目录不存在"); return; }
  ok("归档目录存在");
}

// ─── 入口 ───
main().catch((e) => {
  console.error("lifecycletest 异常：", e);
  process.exitCode = 1;
  process.exit(1);
});
