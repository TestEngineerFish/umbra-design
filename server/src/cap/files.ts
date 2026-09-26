import { z } from "zod";
import { envelope } from "../envelope.js";
import { countTypes, listFiles, listSnapshotMeta, moveFile, readAnyFile, referencesOf, revertFile, trashFile, writeAnyFile } from "../files.js";
import { defineCap } from "./registry.js";
import { originOf, type CapCtx } from "./types.js";

/** 泛型文件层的能力（M11-1 第一批）。
 *
 *  **为什么先搬这一组**：插件要做的就是「给某种格式加编辑方式」（Q37），
 *  而任何格式的编辑最后都落在这几件上 —— 列、读、写、改名、看版本、回退、扔、查引用。
 *  这一组定下来，插件面需要什么就清楚了。
 *
 *  ⚠️ **这里只有声明，没有实现** —— 实现在 `files.ts`，两个门面以前各包装了它一遍。
 *  这一层要做的就是把那两层样板合成一份。
 */
const p = (c: CapCtx) => c.project!;    // scope: "project" 的能力，门面保证不为 null

defineCap({
  name: "list_files", title: "列目录", scope: "project",
  summary: "列一个目录下的文件与子目录（含类型、大小、改动时间）。不递归 —— 要看深层就再调一次。",
  input: { dir: z.string().optional().describe("相对项目根的子目录，不给就是项目根"), limit: z.number().optional() },
  http: { route: "files", method: "GET" },
  run: async ({ dir, limit }, c) => envelope(await listFiles(p(c), dir ?? "", limit)),
});

defineCap({
  name: "read_file", title: "读一个文件（非设计稿）", scope: "project",
  summary: "读文本文件，返回内容与 sha256。**写回去要把这个 sha256 原样带上** —— 盘上被别人改过就会被拒绝，不会把改动盖掉。",
  input: { path: z.string().describe("相对项目根的文件路径") },
  http: { route: "file", method: "GET" },
  run: async ({ path }, c) => envelope(await readAnyFile(p(c), path)),
});

defineCap({
  name: "write_file", title: "写一个文件（非设计稿）", scope: "project",
  summary: [
    "写文本文件，顺序是：写前 sha256 校验 → 存旧版快照 → 原子写 → 存新版快照 → 返回快照号。",
    "**不归一化、不改编码、不动换行、不碰 frontmatter** —— 写进去什么样，盘上就什么样。",
    "expectSha256 传 read_file 给的那个值：盘上被别人改过就拒绝。新建文件传 \"0\"。",
    "`.dc.html` 会被拒绝并指向 write_draft（那是另一条写入口，要做归一化与资源注入）。",
  ].join("\n"),
  input: {
    path: z.string(), content: z.string(),
    expectSha256: z.string().optional().describe("read_file 返回的 sha256；新建文件给 \"0\"。不给就不做写前校验"),
    note: z.string().optional().describe("这一版为什么改，记进快照元数据"),
  },
  http: { route: "file_write", method: "POST" },
  /* `origin` 就是两个门面唯一的真实差异，现在它从 `via` 来，不再各写一遍 */
  run: async ({ path, content, expectSha256, note }, c) =>
    envelope(await writeAnyFile(p(c), path, content, { expectSha256, origin: originOf(c.via), note })),
});

defineCap({
  name: "move_file", title: "改名 / 移动一个文件（非设计稿）", scope: "project",
  summary: "改名或移动。引用它的稿会被一起改写 —— 所以不要用系统的文件管理器搬，那样引用会断。",
  input: { from: z.string(), to: z.string() },
  http: { route: "file_move", method: "POST" },
  run: async ({ from, to }, c) => envelope(await moveFile(p(c), from, to)),
});

defineCap({
  name: "trash_file", title: "把文件挪进回收站", scope: "project",
  summary: "不是真删 —— 挪进项目的回收站，可以恢复。",
  input: { path: z.string() },
  http: { route: "file_trash", method: "POST" },
  run: async ({ path }, c) => envelope(await trashFile(p(c), path)),
});

defineCap({
  name: "list_file_versions", title: "一个文件的历史版本", scope: "project",
  summary: "列这个文件存过的快照（版本号、时间、谁改的、备注）。",
  input: { path: z.string() },
  http: { route: "file_versions", method: "GET" },
  run: async ({ path }, c) => envelope({ path, snapshots: await listSnapshotMeta(p(c), path) }),
});

defineCap({
  name: "revert_file", title: "把文件回退到某一版", scope: "project",
  summary: "回退**也是一次写** —— 会先给当前内容存一版快照，所以回错了还能再回来。",
  input: { path: z.string(), version: z.string() },
  http: { route: "file_revert", method: "POST" },
  run: async ({ path, version }, c) => envelope(await revertFile(p(c), path, version)),
});

defineCap({
  name: "list_file_refs", title: "谁引用了这个文件", scope: "project",
  summary: "找出哪些稿引用了它。删之前先看这个 —— 有人引用还删，那些稿会缺资源。",
  input: { path: z.string() },
  http: { route: "file_refs", method: "GET" },
  run: async ({ path }, c) => envelope({ path, referencedBy: await referencesOf(p(c), path) }),
});

defineCap({
  name: "count_file_types", title: "项目里各类型文件各有多少", scope: "project",
  summary: "按类型统计。目录视图的筛选条用它填数字。",
  input: {},
  http: { route: "file_types", method: "GET" },
  run: async (_i, c) => envelope({ types: await countTypes(p(c)) }),
});
