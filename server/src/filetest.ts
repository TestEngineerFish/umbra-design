/** 泛型文件层的回归（M8-1 / M8-2）。
 *
 *  为什么单独一套：`write_file` 是**第二条写入口**。`write_draft` 那条被 selftest /
 *  rendertest / lifecycletest 从三个角度钉着，这一条一开始什么都没有 —— 而它管的是
 *  「写前校验别把别人的改动盖掉」「旧版留得住」「frontmatter 一个字节都不许动」。
 *  这三件事出错都不会让页面白屏，只会安静地丢东西，所以更需要基准。
 *
 *  用法：npm --prefix server run filetest
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProject } from "./project.js";
import { listVersions } from "./history.js";
import {
  countTypes, listFiles, listSnapshotMeta, listSnapshots, moveFile,
  readAnyFile, referencesOf, revertFile, trashFile, writeAnyFile,
} from "./files.js";
import { ToolError } from "./envelope.js";

const DIR = join(tmpdir(), `umbrastudio-filetest-${Date.now()}`);
let bad = 0;
function ok(label: string, cond: boolean, extra?: unknown): void {
  if (!cond) bad++;
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra === undefined ? "" : "  " + JSON.stringify(extra)}`);
}
const fixOf = (e: unknown) => (e as ToolError)?.diagnostic?.fix ?? "";
const msgOf = (e: unknown) => (e as ToolError)?.diagnostic?.message ?? String((e as Error)?.message ?? e);

console.log(`\n泛型文件层回归 · ${DIR}\n`);
await rm(DIR, { recursive: true, force: true });
await mkdir(join(DIR, "docs"), { recursive: true });
await writeFile(join(DIR, "project.json"), JSON.stringify({ name: "filetest", title: "回归" }));
await writeFile(join(DIR, "需求.md"), "---\nowner: sam\nstatus: draft\n---\n\n# 日志页需求\n\n正文。\n");
await writeFile(join(DIR, "docs", "note.md"), "# 笔记\n");
await writeFile(join(DIR, "conf.json"), '{"a":1}\n');
await writeFile(join(DIR, "图.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
await writeFile(join(DIR, "图.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="24"></svg>');
await writeFile(join(DIR, "稿.dc.html"), '<!DOCTYPE html><html><head><script src="./support.js"></script></head><body><x-dc><img src="图.png"><div>hi</div></x-dc></body></html>\n');
const p = await buildProject(DIR);

const l = await listFiles(p);
ok("列一层：目录在前，工具产物不列", l.entries.length === 7 && l.entries[0]!.isDir === true, { n: l.entries.length, types: l.types });
ok("图片尺寸从文件头读（png 1×1 · svg 48×24）",
  l.entries.find((e) => e.name === "图.png")?.width === 1 && l.entries.find((e) => e.name === "图.svg")?.width === 48);
ok("md 摘录跳过 frontmatter", l.entries.find((e) => e.name === "需求.md")?.excerpt === "# 日志页需求");

const r1 = await readAnyFile(p, "需求.md");
ok("读文本：正文 + sha256 + 行数", !!r1.content?.includes("日志页需求") && r1.sha256.length === 64 && r1.lines === 9);
const rimg = await readAnyFile(p, "图.png");
ok("读二进制：不给正文，但说清为什么", rimg.content === null && !!rimg.why && rimg.width === 1);

try { await writeAnyFile(p, "稿.dc.html", "x"); ok("write_file 必须拒绝 .dc.html", false); }
catch (e) { ok("write_file 拒绝 .dc.html 并指向 write_draft", /write_draft/.test(fixOf(e))); }

const w1 = await writeAnyFile(p, "需求.md", r1.content!.replace("正文。", "正文改过了。"), { expectSha256: r1.sha256 });
ok("写前校验通过 → 旧版存 s1 → 新版 s2", w1.snapshot === "s2" && w1.previous === "s1");
try { await writeAnyFile(p, "需求.md", "再改", { expectSha256: r1.sha256 }); ok("过期 sha 必须被拒（Q8）", false); }
catch (e) { ok("过期 sha 被拒，且说清两边是什么", /被改过/.test(msgOf(e)) && /重新读一次/.test(fixOf(e))); }

ok("frontmatter 逐字节不变（H5）", (await readFile(join(DIR, "需求.md"), "utf8")).startsWith("---\nowner: sam\nstatus: draft\n---\n"));

const rv = await revertFile(p, "需求.md", "s1");
ok("回到 s1：内容回来，历史不删（s1..s4）",
  (await readFile(join(DIR, "需求.md"), "utf8")).includes("正文。\n") && rv.snapshot === "s4" && (await listSnapshots(p, "需求.md")).length === 4);
const meta = await listSnapshotMeta(p, "需求.md");
ok("快照元数据：version / src / at 齐", meta.length === 4 && meta[0]!.version === "s1" && !!meta[0]!.at && meta[3]!.note === "回到 s1");

ok("referencesOf 找到引用的文件与行号", (await referencesOf(p, "图.png")).some((r) => r.file === "稿.dc.html" && r.line > 0));
const t = await countTypes(p);
ok("countTypes 全项目分布", t.dc === 1 && t.md === 2 && t.image === 2 && t.other === 2, t);

const mv = await moveFile(p, "图.png", "assets/图.png");
ok("move_file 挪文件并改写稿里的引用",
  mv.rewrote.length === 1 && /src="assets\/图\.png"/.test(await readFile(join(DIR, "稿.dc.html"), "utf8")));
ok("被改写的稿留下语义快照（走的是 write_draft）", (await listVersions(p, "稿.dc.html")).length >= 1);
try { await moveFile(p, "稿.dc.html", "x.dc.html"); ok("move_file 必须拒绝 .dc.html", false); }
catch (e) { ok("move_file 拒绝 .dc.html 并指向 move_draft", /move_draft/.test(fixOf(e))); }

const tr = await trashFile(p, "conf.json");
ok("删除是进回收站，不是真删", tr.trashPath.includes(".umbrastudio/trash/"));

/* 防穿越的做法是把 `.` `..` 段整个吃掉，不是报错 —— 所以判据是「写出来的东西落在项目里」，
   不是「抛了异常」。第一版断言写成后者，实现正确却红了。 */
const esc = await writeAnyFile(p, "../../跑出去.md", "x");
ok("路径锁在项目内（.. 被吃掉，不是写到父目录）",
  esc.path === "跑出去.md" && existsSync(join(DIR, "跑出去.md")) && !existsSync(join(DIR, "..", "跑出去.md")), { path: esc.path });

await rm(DIR, { recursive: true, force: true });
console.log(`\n${bad === 0 ? "✓" : "✗"} 泛型文件层 ${bad === 0 ? "全通过" : `${bad} 条没过`}\n`);
process.exitCode = bad === 0 ? 0 : 1;
