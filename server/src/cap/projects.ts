import { z } from "zod";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { envelope } from "../envelope.js";
import {
  archiveProject, buildProject, deleteProject, listDrafts, listProjectDirs, projectsRoot, updateProject,
} from "../project.js";
import { clearRecentProjects, listRecentProjects, removeRecentProject } from "../workspace.js";
import { listIcons, listComponents, searchTokens } from "../assets.js";
import { listTrash } from "../refs.js";
import { isToolPage } from "../indexpage.js";
import { defineCap } from "./registry.js";
import type { CapCtx } from "./types.js";

/** 项目域（M11-7 第三批）。
 *
 *  这一组里**天生只属于一个门面**的最多，所以每件都写清 `faces` 的理由：
 *  - `reveal_dir` 是「在访达里打开」—— MCP 那边没有「访达」这回事
 *  - `open_project` 起一个服务并把 url / token 交给前端 —— MCP 有 `serve_start`，形状不同
 *  - `list_recent_projects` 是**这台机器**的偏好，不属于任何项目
 *
 *  ⚠️ `project_settings` / `project_update` / `project_archive` / `project_delete`
 *  四条的唯一调用方是 **`ui/S8-项目设置.dc.html`**（它是可运行稿，自己 fetch API）。
 *  改名或改入参之前先看它 —— `captest` 会替你查，但别指望它是唯一的闸（`00` §九十）。
 */
const p = (c: CapCtx) => c.project!;

defineCap({
  name: "list_projects", title: "列出设计项目", scope: "global",
  summary: "列项目根下的所有项目（名字、标题、稿数、配没配设计系统）。项目根可用 --projects-root 或 UMBRASTUDIO_PROJECTS_ROOT 指定。",
  input: {},
  /* HTTP 侧原来叫 `projects` 且**多做一件事**：把「最近打开」合并进来排在前面。
     那是首页要的（人按最近用过排），MCP 那边不需要 —— 所以用 `via` 决定合不合并。 */
  http: { route: "projects", method: "GET" },
  run: async (_i, c) => {
    const dirs = await listProjectDirs();
    /* 「最近打开」只有首页要（人按最近用过排）。MCP 那边按项目根的顺序就行 */
    const recents = c.via === "http" ? (await listRecentProjects()).recents : [];
    const seen = new Set<string>();
    const rows: Array<Record<string, unknown>> = [];

    const describe = async (dir: string) => {
      if (seen.has(dir)) return;
      seen.add(dir);
      /* ⚠️ **整个函数体都要包住**（M11-7 第三批实测炸过）。
         原实现只包了 `buildProject`，后面的 `listDrafts` 裸着 ——
         「最近打开」里只要有一条目录已经没了（回归测试留下的临时项目就是），
         `listDrafts` 抛 ENOENT，**整个首页变空白**，控制台只有一句 400。
         一条失效的历史记录不该让整页打不开。 */
      try {
        const pj = await buildProject(dir);
        const files = (await listDrafts(pj)).map((a) => relative(pj.dir, a).split(sep).join("/")).filter((r) => !isToolPage(r));
        const row: Record<string, unknown> = {
          name: pj.name, title: pj.title, dir: pj.dir,
          drafts: files.length, gitEnabled: pj.gitEnabled,
          configured: pj.config.designSystem != null,
        };
        /* 缩略图只有首页要 —— 它是 base64 PNG，给模型是白占上下文。
           ⚠️ 这两项**在第一版搬迁里被漏掉了**，首页的卡片会变成没有图的空壳。
           按片段读实现就会这样：看到的是 `describe` 的前五行，而它有二十行。 */
        if (c.via === "http") {
          let thumb: string | null = null, generatedAt: string | null = null;
          const dataFile = join(dir, ".umbrastudio", "index-data.json");
          if (existsSync(dataFile)) {
            try {
              const data = JSON.parse(await readFile(dataFile, "utf8")) as
                { project?: { generatedAt?: string }; drafts?: Array<{ thumb: string | null; elements: number }> };
              generatedAt = data.project?.generatedAt ?? null;
              const first = (data.drafts ?? []).filter((d) => d.thumb).sort((a, b) => b.elements - a.elements)[0];
              if (first?.thumb) {
                const png = join(dir, first.thumb);
                /* 400KB 上限：首页可能列十几个项目，每个都塞一张大图会让这条响应变成几兆 */
                if (existsSync(png) && statSync(png).size < 400 * 1024) thumb = "data:image/png;base64," + (await readFile(png)).toString("base64");
              }
            } catch { /* 没索引就没缩略图 */ }
          }
          row.generatedAt = generatedAt; row.thumb = thumb;
        }
        rows.push(row);
      } catch { /* 这个目录读不了（多半已经不在了）—— 跳过它，别拖垮整页 */ }
    };

    for (const r of recents) await describe(r.dir);
    for (const d of dirs) await describe(d);
    return envelope({ projectsRoot: projectsRoot(), projects: rows }, [], { count: rows.length });
  },
});

defineCap({
  name: "get_project", title: "读项目配置与稿清单", scope: "project",
  summary: "取配置（设计系统路径、tokens、图标、元素数限额）与全部稿清单。**动手改稿之前先调它** —— 后面几乎所有工具都要它给的路径。",
  input: {},
  /* HTTP 侧叫 `project_settings`，**S8 在用**；它比 MCP 版多给设计系统统计和回收站
     —— 那是设置屏要显示的，MCP 那边白占上下文。同样用 `via` 分。 */
  http: { route: "project_settings", method: "GET" },
  run: async (_i, c) => {
    const proj = p(c);
    const files = (await listDrafts(proj)).map((a) => relative(proj.dir, a).split(sep).join("/")).filter((r) => !isToolPage(r));
    let dsStats: { tokens: number; icons: number; components: number } | null = null;
    if (c.via === "http" && proj.dsDir) {
      try {
        const [tk, ic, comps] = await Promise.all([
          searchTokens(proj, "", 1).then((r) => r.total).catch(() => 0),
          listIcons(proj, undefined, 1).then((r) => r.total).catch(() => 0),
          listComponents(proj).then((r) => r.length).catch(() => 0),
        ]);
        dsStats = { tokens: tk, icons: ic, components: comps };
      } catch { dsStats = null; }
    }
    return envelope({
      name: proj.name, title: proj.title, dir: proj.dir,
      draftCount: files.length, gitEnabled: proj.gitEnabled,
      designSystem: { dir: proj.dsDir, alias: proj.dsAlias, tokens: proj.tokensPath, icons: proj.iconsPath, stats: dsStats },
      limits: proj.limits,
      /* 回收站只有设置屏要 —— 模型问「有什么被删了」用 `list_trash` */
      ...(c.via === "http" ? { trash: await listTrash(proj) } : { drafts: files }),
    }, [], { drafts: files.length });
  },
});

defineCap({
  name: "update_project", title: "改项目配置", scope: "project",
  summary: "改标题、设计系统路径与别名、tokens/icons 路径、元素数限额。**只改传进来的那几项**，没传的不动。",
  input: {
    title: z.string().optional().describe("新标题"),
    designSystemDir: z.string().nullable().optional().describe("设计系统目录，传 null 清除"),
    designSystemAlias: z.string().optional().describe("设计系统别名，默认 @ds"),
    tokens: z.string().nullable().optional().describe("tokens 文件相对路径，传 null 清除"),
    icons: z.string().nullable().optional().describe("icons 文件相对路径，传 null 清除"),
    elementsWarn: z.number().int().optional().describe("元素数 warning 阈值"),
    elementsHard: z.number().int().optional().describe("元素数 hard 上限"),
  },
  http: { route: "project_update", method: "POST" },
  run: async (input, c) => {
    /* 只把**真的传了**的键交下去 —— 传 undefined 会把原值清掉 */
    const opts: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) if (v !== undefined) opts[k] = v;
    return envelope(await updateProject(p(c), opts as Parameters<typeof updateProject>[1]));
  },
});

defineCap({
  name: "list_recent_projects", title: "最近打开过哪些项目", scope: "global",
  summary: "按最后打开时间倒序。这是**这台机器**的偏好，不属于任何项目。",
  input: {},
  http: { route: "recent_projects", method: "GET" },
  run: async () => envelope(await listRecentProjects()),
});

defineCap({
  name: "remove_recent_project", title: "从最近列表里去掉一项", scope: "global",
  summary: "只从列表里去掉，**不动项目本身**。",
  input: { dir: z.string().describe("项目目录绝对路径") },
  http: { route: "recent_remove", method: "POST" },
  run: async ({ dir }) => envelope(await removeRecentProject(dir)),
});

defineCap({
  name: "clear_recent_projects", title: "清空最近列表", scope: "global",
  summary: "只清列表，**不动任何项目**。",
  input: {},
  http: { route: "recent_clear", method: "POST" },
  run: async () => envelope(await clearRecentProjects()),
});

/** 目录一搬走，还在托管它的那个服务就该停 —— 否则它继续对着一个已经不存在的目录发文件。
 *
 *  ⚠️ **这个副作用差点在搬迁里丢掉**：它原来藏在 HTTP handler 的最后一行
 *  （`setTimeout(() => serveStopByName(...), 300)`），而 MCP 侧根本没有。
 *  搬到能力层之后两个门面都有了 —— 「归档完服务还开着」不该因为走的门面不同而不同。
 *
 *  延迟 300ms 是为了让**这次请求的响应先发出去** —— 服务停在响应之前，
 *  调用方拿到的是连接断开，看起来像失败，而事情其实做成了。
 *  动态 import 避免 `cap/` ⇄ `serve.ts` 的循环依赖。 */
async function stopServing(name: string): Promise<void> {
  const { serveStop } = await import("../serve.js");
  setTimeout(() => { void Promise.resolve(serveStop(name)).catch(() => { /* 本来就没开 */ }); }, 300);
}

defineCap({
  name: "archive_project", title: "归档项目", scope: "project",
  summary: "把项目目录移到 `.archived/`。**不是删除** —— 目录还在，手动搬回来就能恢复。",
  input: {},
  http: { route: "project_archive", method: "POST" },
  run: async (_i, c) => {
    const proj = p(c);
    const r = await archiveProject(proj);
    await stopServing(proj.name);
    return envelope({ ...r, note: "项目目录已移走，这个服务随即关闭" });
  },
});

defineCap({
  name: "delete_project", title: "删除项目", scope: "project",
  summary: "**实际上也是移到 `.archived/`**（`doc/12` M1-10）—— 我们不真删用户的目录。界面上要用户把项目名敲一遍才放行。",
  input: {
    /* ⚠️ 这道「敲一遍项目名」的闸**原来只在 HTTP 那一侧**，MCP 侧的 delete_project 没有。
       合成一份之后两边都有了 —— 而这正是该有的：删项目这种事不该因为走的门面不同而松紧不一。
       给 optional 是为了兼容已有的 MCP 调用方，但**不传就拒**。 */
    typed: z.string().optional().describe("把项目名原样敲一遍，防手滑"),
  },
  http: { route: "project_delete", method: "POST" },
  run: async ({ typed }, c) => {
    const proj = p(c);
    if (typed !== proj.name) throw new Error(`要把项目名敲一遍才能删（typed 要等于 ${proj.name}）`);
    const r = await deleteProject(proj);
    await stopServing(proj.name);
    return envelope({ ...r, note: "项目目录已移走，这个服务随即关闭" });
  },
});
