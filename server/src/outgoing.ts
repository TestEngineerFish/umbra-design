/** 把工具界面稿打包发给设计侧。和 `incoming` 是一对。
 *
 *  为什么要有它（doc/00 §三十二）：ClaudeDesign 的项目存在云端，它只拥有被上传过的东西。
 *  我们一直**只发文档不发文件**，于是：
 *   · 我们新建的稿到不了它那边（S6/S8/S9/S10 它一份都没有，§二 做不了）
 *   · 我们改过的稿也到不了（它每次都在自己那份接线之前的老底稿上改，
 *     交回来 S1 接线 4/4、S2 接线 8/8 全丢 —— 这件事已经发生过两次）
 *  它在回复里写「LIVE 分支原样保留」是真心的，但它保留的是它那份里本来就没有的东西。
 *  **它不可能知道自己没有什么** —— 所以文件必须和文档一起发。
 *
 *  做三件事：
 *   1. 把 ui/ 下全部 `.dc.html` + 皮肤 + 演示页拷一份
 *   2. 每份稿 <head> 里插一行 baseline 注释（文件名 + 我们这版的 sha256）——
 *      设计侧增量改会保留注释，交回来时 `incoming` 靠它判断「是在哪一版上改的」
 *   3. 打成一个 zip，附一页给设计侧的说明；同时在本地留一份发件记录
 *
 *  ⚠️ baseline 注释只进**发出去的副本**，永远不进 ui/ 正本。
 *     正本里要是出现了它，说明有人把交回来的文件原样覆盖进来了 —— 这里直接拒绝打包。
 *
 *  用法：npm --prefix server run outgoing
 */
import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { TOOL_ROOT } from "./project.js";
import { BASELINE_RE, shaOf } from "./baseline.js";

const UI = join(TOOL_ROOT, "ui");
const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13).replace("T", "-");

const drafts = (await readdir(UI)).filter((f) => f.endsWith(".dc.html")).sort();
const stage = join(tmpdir(), `ud-outgoing-${stamp}`);
const pack = join(stage, "ui");
await rm(stage, { recursive: true, force: true });
await mkdir(pack, { recursive: true });

const record: Record<string, string> = {};
const leaked: string[] = [];
for (const f of drafts) {
  const src = await readFile(join(UI, f), "utf8");
  if (BASELINE_RE.test(src)) { leaked.push(f); continue; }
  const sha = shaOf(src);
  record[f] = sha;
  const mark = `<!-- umbradesign:baseline file="${f}" sha="${sha}" sent="${stamp}" —— ` +
    `请保留这一行。交回时我们靠它判断你是在哪一版上改的；没有它，我们会当成旧底稿退回 -->\n`;
  const out = /<head[^>]*>\n?/i.test(src)
    ? src.replace(/(<head[^>]*>\n?)/i, `$1${mark}`)
    : mark + src;
  await writeFile(join(pack, f), out);
}
if (leaked.length) {
  console.error(`✗ 这几份 ui/ 正本里混进了 baseline 注释：${leaked.join("、")}`);
  console.error("  多半是把设计侧交回来的文件原样覆盖进来了。先去掉那一行再打包 —— 正本里不能有它。");
  process.exit(1);
}

for (const dir of ["_ds-tool", "_demo"]) {
  if (existsSync(join(UI, dir))) await cp(join(UI, dir), join(pack, dir), { recursive: true });
}
/* 运行时三件套也放进包：稿里的 umbradesign:resources 映射指向同层的 ./react*.min.js，
   设计侧的项目在云端且拿不到外网，没有它们稿一打开就白屏（设计侧回复 2026-09-21 §五）。 */
for (const f of ["support.js", "react.production.min.js", "react-dom.production.min.js"]) {
  await copyFile(join(TOOL_ROOT, "runtime", f), join(pack, f));
}

await writeFile(join(stage, "README-给设计侧.md"), `# Umbra Studio 界面稿 · ${stamp}

这个包里是我们这边 \`ui/\` 的**完整现版**，共 ${drafts.length} 份稿，外加运行时三件套（support.js + 两个 React UMD，和稿同层放）。配套的交办单是 \`doc/14\`。

## 三条规矩

1. **用这个包整体替换你项目里的同名文件**，以它为唯一底稿。
   你那边原有的 S1–S5 是接线之前的老版本，里面没有 \`LIVE\` 分支和本地 API 调用 ——
   在老版本上改，交回来接线会全丢（已经发生过两次）。
2. **每份稿 \`<head>\` 里第一行是一条 baseline 注释，请保留。**
   它记着「这份是哪一版」。交回来时我们靠它判断你是不是在这个包的底稿上改的。
3. **改完原样放进 \`ui/_incoming/\`**，连同一份回复。别整包覆盖 \`ui/\`。

## 这个包里的稿

${drafts.map((f) => `- \`${f}\``).join("\n")}
`);

/* 先在临时目录打包，再拷进 outgoing/ —— zip 写完会「替换原文件」，
   那一步要删除权限；有些环境（沙箱、只读挂载）没有。拷贝只需要写权限。 */
const outDir = join(TOOL_ROOT, "outgoing");
await mkdir(outDir, { recursive: true });
const zipName = `UmbraStudio-ui-${stamp}.zip`;
const tmpZip = join(tmpdir(), zipName);
await rm(tmpZip, { force: true });
execFileSync("zip", ["-qr", tmpZip, "."], { cwd: stage });
const zipPath = join(outDir, zipName);
await copyFile(tmpZip, zipPath);
await rm(tmpZip, { force: true });

// 本地发件记录：incoming 用它说清「是基于哪一次发出去的版本」
const recDir = join(TOOL_ROOT, ".umbrastudio", "outgoing");
await mkdir(recDir, { recursive: true });
await writeFile(join(recDir, `${stamp}.json`), JSON.stringify({ sent: stamp, files: record }, null, 2) + "\n");
await rm(stage, { recursive: true, force: true });

console.log(`✓ 已打包 ${drafts.length} 份稿 → ${zipPath.replace(TOOL_ROOT + "/", "")}`);
console.log(`  发件记录 .umbrastudio/outgoing/${stamp}.json`);
console.log("  把这个 zip 连同 doc/14 一起发给设计侧。");
