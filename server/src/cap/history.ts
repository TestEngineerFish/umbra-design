import { z } from "zod";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { envelope } from "../envelope.js";
import { listDrafts } from "../project.js";
import { resolveDraft } from "../locate.js";
import {
  changesSince, diffDrafts, humanTime, listVersions, projectChangesSince,
  readVersionMeta, resolveSnapshot, toMarkdown,
} from "../history.js";
import { addComment, deleteComment, listComments, updateComment } from "../comments.js";
import { listReferences } from "../refs.js";
import { buildIndex, collectIndex, indexStatus, isToolPage } from "../indexpage.js";
import { defineCap } from "./registry.js";
import type { CapCtx } from "./types.js";

/** 版本 / 变更 / 索引 / 引用 / 评论（M11-7 第五批）。
 *
 *  ⚠️ **这一域里有三条留在手写路径，不搬**（`api.ts`），各有硬理由：
 *
 *  | 路由 | 为什么不能进能力分发器 |
 *  | --- | --- |
 *  | `version_html` | 它返回的是**原始 HTML 不是信封** —— 给 iframe 直接看历史版本，还要在 `<head>` 里插 `<base>` 修相对路径。分发器一律 `json(信封)`，形状根本不同 |
 *  | `check` | 走**作业系统**（起一个 job，立刻返回 jobId，前端轮询）。渲染体检要开浏览器，几秒到几十秒，同步返回会把 HTTP 连接挂住 |
 *  | `check_status` | 同上，它是轮询那一半 |
 *
 *  把它们硬塞进分发器需要给 `Cap` 加「返回原始响应」和「异步作业」两种模式，
 *  而那两种各只有一个用户 —— **为一个用户造一层抽象，比留着一条手写路径更贵**。
 */
const p = (c: CapCtx) => c.project!;
const rel = (c: CapCtx, file: string) => resolveDraft(p(c), file);

defineCap({
  name: "list_versions", title: "列出一份稿的版本", scope: "project",
  summary: "列快照版本序列（v1、v2 …）以及项目有没有 git 兜底。版本在每次 write_draft 落盘时递增，**按稿独立计数**。",
  input: { file: z.string() },
  http: { route: "versions", method: "GET" },
  run: async ({ file }, c) => {
    const proj = p(c);
    const r = await rel(c, file);
    const vs = await listVersions(proj, r);
    return envelope({ file: r, versions: vs, latest: vs[vs.length - 1] ?? null, gitEnabled: proj.gitEnabled },
      [], { count: vs.length });
  },
});

defineCap({
  name: "snapshot_draft", title: "取一份稿的语义快照", scope: "project",
  summary: "把 .dc.html 抽成归一化的语义快照（props / state / 状态分支 / 列表 / 子组件 / 用到的 token / 文案 / 节点与指纹）。write_draft 会自动存，这件用来看某一版的内容。",
  input: { file: z.string(), version: z.string().optional().describe("v<N> / git ref / 「工作区」。默认「工作区」") },
  http: { route: "snapshot", method: "GET" },
  run: async ({ file, version }, c) => {
    const snap = await resolveSnapshot(p(c), await rel(c, file), version ?? "工作区");
    return envelope(snap, [], {
      nodes: snap.nodes.length, texts: snap.texts.length,
      tokensUsed: snap.tokensUsed.length, branches: snap.branches.length,
    });
  },
});

defineCap({
  name: "list_changes", title: "一份稿的版本与变更", scope: "project",
  summary: [
    "一次给全：版本序列 · 每版的「来源 · 时间 · 摘要」· 两版之间的语义变更清单。",
    "`since` 给 `prev` 是「上一版」的简写；不给就从第一版起算。",
    "`to` 给了就是**任意两版对比**；不给就是 since → 最新。",
  ].join("\n"),
  input: {
    file: z.string(),
    since: z.string().optional().describe("起点版本，或 prev（上一版）"),
    to: z.string().optional().describe("终点版本。不给就是最新"),
  },
  http: { route: "changes", method: "GET" },
  run: async ({ file, since: sinceRaw, to }, c) => {
    const proj = p(c);
    const r = await rel(c, file);
    const vs = await listVersions(proj, r);
    /* 版本弹层（S2，设计侧 §3.2）每行要「来源 · 时间 · 摘要」—— 形状按它给的 */
    const metaRaw = await readVersionMeta(proj, r);
    const versionMeta: Record<string, { src: string; time: string; summary: string }> = {};
    for (const [v, m] of Object.entries(metaRaw)) versionMeta[v] = { src: m.origin, time: humanTime(m.capturedAt), summary: m.summary };
    if (vs.length < 2) {
      return envelope({ file: r, versions: vs, versionMeta, diff: null, markdown: null,
        note: vs.length ? "只有一版，没有可比的" : "还没有快照" });
    }
    const since = sinceRaw === "prev" ? (vs[vs.length - 2] as string) : (sinceRaw || (vs[0] as string));
    const d = to ? await diffDrafts(proj, r, { from: since, to }) : await changesSince(proj, r, since);
    return envelope({ file: r, versions: vs, versionMeta, diff: d, markdown: toMarkdown(d) });
  },
});

defineCap({
  name: "list_project_changes", title: "整个项目自某一版以来改了什么", scope: "project",
  summary: "扫全项目的稿，**只回有变更的那些** —— 一个项目几十份稿，大半是「只有一版，没有可比的」，全给过去等于让人在噪声里找。",
  input: { since: z.string().optional().describe("起点版本；不给就从各自的第一版起算") },
  http: { route: "project_changes", method: "GET" },
  run: async ({ since }, c) => {
    const proj = p(c);
    const files = (await listDrafts(proj)).map((a) => relative(proj.dir, a).split(sep).join("/")).filter((x) => !isToolPage(x));
    const rows = await projectChangesSince(proj, files, since ?? null);
    const changed = rows.filter((r) => r.diff && r.diff.changes.length > 0);
    return envelope({
      project: proj.name, title: proj.title,
      scanned: rows.length, changed: changed.length, rows: changed,
      skipped: rows.filter((r) => !r.diff).map((r) => ({ path: r.path, note: r.note })),
    }, [], { scanned: rows.length, changed: changed.length });
  },
});

defineCap({
  name: "list_drafts", title: "列出项目里的稿", scope: "project",
  summary: "文件名 + 索引里算好的类型 / 健康 / 元素数 / 版本。**读的是索引缓存，不现场校验** —— 几十份稿现场校验太慢。没建过索引就只有文件名。",
  input: {},
  http: { route: "drafts", method: "GET" },
  run: async (_i, c) => {
    const proj = p(c);
    const files = (await listDrafts(proj)).map((a) => relative(proj.dir, a).split(sep).join("/")).filter((x) => !isToolPage(x));
    let indexed: Record<string, unknown> = {};
    const dataFile = join(proj.dir, ".umbrastudio", "index-data.json");
    if (existsSync(dataFile)) {
      try {
        const data = JSON.parse(await readFile(dataFile, "utf8")) as { drafts?: Array<{ file: string }> };
        for (const d of data.drafts ?? []) indexed[d.file] = d;
      } catch { indexed = {}; }
    }
    return envelope({
      project: proj.name, title: proj.title, files,
      drafts: files.map((f) => ({ file: f, ...(indexed[f] as object | undefined ?? {}) })),
      indexed: Object.keys(indexed).length > 0,
    }, [], { count: files.length });
  },
});

defineCap({
  name: "list_references", title: "查询稿件的引用关系", scope: "project",
  summary: "谁引用了它、它引用了谁。**删或改名之前看一眼** —— 引用断了那些稿会缺资源。不给 file 就是整个项目的引用概览。",
  input: { file: z.string().optional().describe("稿的相对路径。不给时返回整个项目的概览") },
  http: { route: "refs", method: "GET" },
  run: async ({ file }, c) => envelope(await listReferences(p(c), file)),
});

defineCap({
  name: "build_index", title: "生成项目入口页", scope: "project",
  summary: "把项目里的稿生成一张入口页（带健康度与缩略图）。`renderCheck: true` 会对缺截图的稿跑渲染体检补缩略图 —— **那会开浏览器，慢**。",
  input: {
    renderCheck: z.boolean().optional().describe("对缺截图的稿跑渲染体检生成缩略图（慢）"),
  },
  /* HTTP 侧叫 `rebuild_index`（前端在用）。
     ⚠️ MCP 侧原来还有个 `serve: true` 顺手起服务 —— **不搬**：
     从界面调它时服务本来就开着，而「读一个东西顺手起个服务」是两件事挤在一个开关里。
     模型要起服务用 `serve_start`。 */
  http: { route: "rebuild_index", method: "POST" },
  run: async ({ renderCheck }, c) => {
    const proj = p(c);
    const url = c.port ? `http://127.0.0.1:${c.port}/` : null;
    const r = await buildIndex(proj, url, { renderCheck });
    return envelope(r, [], { drafts: r.drafts, ...r.byHealth });
  },
});

defineCap({
  name: "get_index_data", title: "只取索引数据，不落盘", scope: "project",
  summary: "按 `doc/08` S1 的数据契约返回稿件清单，**不写任何文件**。要自己渲染索引页的调用方用它，别用 build_index（那个会落盘）。",
  input: {},
  http: { route: "index_data", method: "GET" },
  run: async (_i, c) => {
    const d = await collectIndex(p(c));
    return envelope(d, [], { drafts: d.drafts.length });
  },
});

defineCap({
  name: "index_status", title: "索引是不是过期了", scope: "project",
  summary: "上次建索引之后有没有稿改过。S1 顶上那条「索引过期」横条读它。",
  input: {},
  http: { route: "index_status", method: "GET" },
  run: async (_i, c) => envelope(await indexStatus(p(c))),
});

/* ── 评论：钉在节点上的一句话（M6-2）。存 `.umbrastudio/comments.json` ── */

defineCap({
  name: "list_comments", title: "列出钉在节点上的评论", scope: "project",
  summary: "稿 + 节点地址（data-ud-node）+ 一句话 + 是否已处理。**改稿前看看设计侧留了什么话**。",
  input: {
    file: z.string().optional().describe("只看这一份稿"),
    unresolvedOnly: z.boolean().optional().describe("只看没处理的"),
  },
  http: { route: "comments", method: "GET" },
  run: async ({ file, unresolvedOnly }, c) => {
    const proj = p(c);
    let list = await listComments(proj.dir, file ? await rel(c, file) : undefined);
    if (unresolvedOnly) list = list.filter((x) => !x.resolved);
    return envelope({ comments: list }, [], { count: list.length });
  },
});

defineCap({
  name: "add_comment", title: "在一个节点上留一句话", scope: "project",
  summary: "钉在节点地址上。⚠️ **节点地址是内容哈希**，那个节点被改过之后地址会变 —— 评论会跟着失效，这是有意的（评论说的是那一版的那个东西）。",
  input: {
    file: z.string(), node: z.string().describe("data-ud-node 的值"),
    text: z.string(), tag: z.string().optional(),
  },
  http: { route: "comment_add", method: "POST" },
  run: async ({ file, node, text, tag }, c) => {
    const proj = p(c);
    return envelope(await addComment(proj.dir, { file: await rel(c, file), node, tag, text }));
  },
});

defineCap({
  name: "update_comment", title: "改一条评论 / 标记已处理", scope: "project",
  summary: "改文字，或把它标成已处理。",
  input: { id: z.string(), text: z.string().optional(), resolved: z.boolean().optional() },
  http: { route: "comment_update", method: "POST" },
  run: async ({ id, text, resolved }, c) => envelope(await updateComment(p(c).dir, id, { text, resolved })),
});

defineCap({
  name: "delete_comment", title: "删掉一条评论", scope: "project",
  summary: "真删。评论没有回收站 —— 它只是一句话。",
  input: { id: z.string() },
  http: { route: "comment_delete", method: "POST" },
  run: async ({ id }, c) => envelope(await deleteComment(p(c).dir, id)),
});
