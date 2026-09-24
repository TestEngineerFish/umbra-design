/** 本地 JSON API。doc/09 §五、doc/00 §二十
 *
 * ── 为什么需要它 ──
 *
 * 入口页的数据是落盘时注入的（`00` §14.7），对索引够用。但预览壳要的东西不一样：
 * 诊断与变更每改一次稿就变，`slots`（某个节点上每一项能不能改）更是**点到才知道**，
 * 注入解决不了。
 *
 * ClaudeDesign 的宿主是个应用，有自己的预览通道。我们没有那个，
 * 但我们有它没有的：**静态服务就跑在 MCP 进程里**（`serve.ts`）。
 * 所以在它上面挂一个 JSON API，和 MCP 工具走**同一条代码路径** ——
 * 校验 / 归一化 / 快照 / changelog 一样不少，没有任何旁路。
 *
 * ── 为什么要令牌 ──
 *
 * L1 是「人直接拖滑块改稿」，所以这个 API **必须能写**。而 127.0.0.1 上的端口，
 * 浏览器里任何一个页面都能 fetch —— 只读还好，可写就是「任何网页都能改你的设计稿」。
 * 所以：
 *
 *  1. 只绑 127.0.0.1（`serve.ts` 本来如此）
 *  2. 每次 `serve_start` 生成一个随机令牌，`/__ud/*` 一律校验
 *  3. 令牌在落盘时注入壳页面（和 `__resources` 同一套），别的页面拿不到
 *  4. 写类请求额外校验 `Origin` —— 必须是本服务自己的源，或者没有 Origin（同源 fetch）
 *
 * 这不是「安全无虞」，是「本地工具该有的门」。判断而非定论：真要严，
 * 得走 Unix socket 或者只让 MCP 侧写。等有人提出更强的要求再收紧。
 */
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { listCssVars } from "./cssvars.js";
import { locateNode } from "./locate.js";
import { revertTo, setProp, type SlotKind } from "./edit.js";
import { validateDraft } from "./validate.js";
import { listComponents, listIcons, searchTokens } from "./assets.js";
import { renderCheck } from "./render.js";
import { get as getJob, start as startJob, view as jobView } from "./jobs.js";
import { changesSince, diffDrafts, humanTime, listVersions, projectChangesSince, readVersionMeta, snapDir, toMarkdown, workspaceState } from "./history.js";
import { gunzipSync } from "node:zlib";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { draftPath, listDrafts, type Project } from "./project.js";
import { resolveDraft } from "./locate.js";
import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import { ToolError } from "./envelope.js";
import { buildIndex, indexStatus, isToolPage } from "./indexpage.js";
import { countTypes, listFiles, listSnapshotMeta, moveFile, readAnyFile, referencesOf, revertFile, trashFile, writeAnyFile } from "./files.js";
import { runChatSend } from "./chat_run.js";
import { updateProject, archiveProject, deleteProject, listProjectDirs, buildProject, createProject, createDraft } from "./project.js";
import { listRecentProjects, touchProject } from "./workspace.js";
import { listTrash, restoreDraft, purgeTrash, emptyTrash, deleteDraft } from "./refs.js";
import { listChats, loadChat, createChat } from "./chat.js";
import { listComments, addComment, updateComment, deleteComment } from "./comments.js";
import { getAiConfig } from "./ai_config.js";
import { readCheck, sha256 } from "./check.js";

export const API_PREFIX = "/__ud/";
export const newToken = () => randomBytes(16).toString("hex");

function json(reply: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  reply.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  reply.end(s);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 2 * 1024 * 1024) throw new Error("请求体太大");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v) throw new Error(`缺参数 ${name}`);
  return v;
};

/** 写类操作要额外看 Origin —— 只认本服务自己的源，或者没有 Origin（同源 fetch） */
function originOk(req: IncomingMessage, port: number): boolean {
  const o = req.headers.origin;
  if (!o) return true;
  // Tauri 壳里的前端：打包后是 tauri://localhost（macOS）/ http://tauri.localhost（Windows），
  // tauri dev 时是 http://127.0.0.1:1430（dev server，端口和 sidecar 不同）。
  // 所以本机任何端口的 127.0.0.1 / localhost 都放行 —— 真正的门槛是随机令牌，Origin 只挡跨站页面。
  if (o === "tauri://localhost" || o === "http://tauri.localhost" || o === "https://tauri.localhost") return true;
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o);
}

export interface ApiCtx { project: Project | null; token: string; port: number }
/** hub 服务（桌面壳的首页，不属于任何项目）只有这几条路由；其余都要项目上下文 */
/* 这几条跟「打开了哪个项目」无关，首页也要能用：
   扫机器上的 CLI、问它有哪些模型、读写 AI 通道配置（配置本来就是全局的）。
   漏一条的后果很实在 —— `ai_config` 一开始没放进来，首页打开设置时读不到通道 B 的当前配置，
   模型框空着、选中项退回默认值，看着像「没配过」。 */
const GLOBAL_ROUTES = new Set(["projects", "open_project", "create_project", "inspect_dir", "reveal_dir",
  "local_clis", "local_cli_models", "ai_config", "ai_channel_b"]);

/** 作业化会话的中断句柄：jobId → AbortController（作业活在进程里，这张表也是） */
const chatAborts = new Map<string, AbortController>();

/** 归档 / 删除后停掉本项目的静态服务。serve.ts 引了本文件，所以这里延迟 import 避免循环。 */
function serveStopByName(name: string): void {
  void import("./serve.js").then((m) => m.serveStop(name)).catch(() => { /* ignore */ });
}

/** 返回 true = 这个请求已经被 API 接手了 */
export async function handleApi(
  req: IncomingMessage, reply: ServerResponse, ctx: ApiCtx
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${ctx.port}`);
  if (!url.pathname.startsWith(API_PREFIX)) return false;

  const route = url.pathname.slice(API_PREFIX.length);
  const given = req.headers["x-ud-token"] ?? url.searchParams.get("token") ?? "";
  if (given !== ctx.token) {
    json(reply, 403, { ok: false, errors: [{ code: "E_API_TOKEN", message: "令牌不对或没带" }] });
    return true;
  }

  if (!ctx.project && !GLOBAL_ROUTES.has(route)) {
    json(reply, 404, { ok: false, errors: [{ code: "E_API_HUB", message: `hub 服务没有项目上下文，路由 ${route} 要从项目自己的服务调（open_project 会给 url / token）` }] });
    return true;
  }
  const p = ctx.project as Project;   // 非全局路由到这里一定有项目；全局路由只在下面用 p?.dir
  try {
    // ── 只读 ──
    if (route === "drafts" && req.method === "GET") {
      const files = (await listDrafts(p))
        .map((a) => relative(p.dir, a).split(sep).join("/"))
        .filter((r) => !isToolPage(r));
      /* 应用前端的侧栏要类型 / 健康 / 元素数 / 版本（UI-2 / UI-3），这些 build_index 已经算过并存在
         index-data.json 里 —— 直接读缓存，不在这里重新校验几十份稿。没建过索引就只有文件名。 */
      let indexed: Record<string, unknown> = {};
      const dataFile = join(p.dir, ".umbrastudio", "index-data.json");
      if (existsSync(dataFile)) {
        try {
          const data = JSON.parse(await readFile(dataFile, "utf8")) as { drafts?: Array<{ file: string }> };
          for (const d of data.drafts ?? []) indexed[d.file] = d;
        } catch { indexed = {}; }
      }
      const drafts = files.map((f) => ({ file: f, ...(indexed[f] as object | undefined ?? {}) }));
      json(reply, 200, { ok: true, data: { project: p.name, title: p.title, files, drafts, indexed: Object.keys(indexed).length > 0 } });
      return true;
    }

    if (route === "validate" && req.method === "GET") {
      const rel = await resolveDraft(p, str(url.searchParams.get("file"), "file"));
      const src = await readFile(draftPath(p, rel), "utf8");
      const v = validateDraft(p, rel, src, rel);
      // 体检读数一起给 —— 壳的顶栏要显示「上次体检 · 耗时 · 节点数」，
      // 不给它就只能写死演示数字（doc/00 §21.3 的教训）
      const chk = await readCheck(p, rel);
      const stale = !!chk && chk.srcSha256 !== sha256(src);
      // 顶栏的版本位要回答「我看的是不是盘上那一版」（设计侧 §五 第 9 项）
      const ws = await workspaceState(p, rel, src);
      json(reply, 200, {
        ok: !v.diags.some((d) => d.level === "error"),
        data: { file: rel, diags: v.diags, stats: v.stats, check: chk, checkStale: stale, workspace: ws },
      });
      return true;
    }

    // M6-3 源码只读视图：当前盘上那一版的原文（应用里看，不是给模型的 read_draft）
    if (route === "source" && req.method === "GET") {
      const rel = await resolveDraft(p, str(url.searchParams.get("file"), "file"));
      const src = await readFile(draftPath(p, rel), "utf8");
      json(reply, 200, { ok: true, data: { file: rel, bytes: Buffer.byteLength(src, "utf8"), lines: src.split("\n").length, source: src } });
      return true;
    }

    if (route === "locate" && req.method === "GET") {
      const file = str(url.searchParams.get("file"), "file");
      const node = str(url.searchParams.get("node"), "node");
      json(reply, 200, { ok: true, data: await locateNode(p, file, node) });
      return true;
    }

    if (route === "changes" && req.method === "GET") {
      const rel = await resolveDraft(p, str(url.searchParams.get("file"), "file"));
      const vs = await listVersions(p, rel);
      // 版本弹层（S2，设计侧 §3.2）每行要「来源 · 时间 · 摘要」—— 形状按它给的：versionMeta[v] = { src, time, summary }
      const metaRaw = await readVersionMeta(p, rel);
      const versionMeta: Record<string, { src: string; time: string; summary: string }> = {};
      for (const [v, m] of Object.entries(metaRaw)) {
        versionMeta[v] = { src: m.origin, time: humanTime(m.capturedAt), summary: m.summary };
      }
      if (vs.length < 2) {
        json(reply, 200, { ok: true, data: { file: rel, versions: vs, versionMeta, diff: null, markdown: null,
          note: vs.length ? "只有一版，没有可比的" : "还没有快照" } });
        return true;
      }
      // since=prev 是「上一版」的简写（S6 默认比对上一版 → 最新）；不给 since 时从第一版起算（S2 / S4 的用法）
      const sinceRaw = url.searchParams.get("since");
      const since = sinceRaw === "prev" ? (vs[vs.length - 2] as string) : (sinceRaw || (vs[0] as string));
      // to 给 S6 版本对比用：任意两版；不给就是 since → 最新（S2 / S4 的用法）
      const to = url.searchParams.get("to");
      const d = to ? await diffDrafts(p, rel, { from: since, to }) : await changesSince(p, rel, since);
      json(reply, 200, { ok: true, data: { file: rel, versions: vs, versionMeta, diff: d, markdown: toMarkdown(d) } });
      return true;
    }

    /* 某一版的源码，按 HTML 返回 —— S6 两栏 iframe 各装一版（UI-4）。
       源码在快照旁的 .src.html.gz 里（revert_to 用的同一份）。它被从 /__ud/ 下发出，
       稿里的 ./support.js 会解析错位置，所以在 <head> 里塞一个 <base> 指回稿所在目录。 */
    if (route === "version_html" && req.method === "GET") {
      const rel = await resolveDraft(p, str(url.searchParams.get("file"), "file"));
      const version = str(url.searchParams.get("version"), "version");
      if (!/^v\d+$/.test(version)) throw new Error("version 形如 v12");
      const gz = join(snapDir(p, rel), `${version}.src.html.gz`);
      if (!existsSync(gz)) throw new Error(`${rel} 没有 ${version} 的源码快照`);
      const src = gunzipSync(await readFile(gz)).toString("utf8");
      const dir = dirname(rel);
      const base = "/" + (dir === "." ? "" : dir.split("/").map(encodeURIComponent).join("/") + "/");
      const html = /<head[^>]*>/i.test(src)
        ? src.replace(/(<head[^>]*>)/i, `$1<base href="${base}">`)
        : `<base href="${base}">` + src;
      reply.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      reply.end(html);
      return true;
    }

    if (route === "tokens" && req.method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      const r = await searchTokens(p, q, Number(url.searchParams.get("limit") ?? 40));
      // S5 的契约要 resolved 与 note。`var(--x)` 这类别名我们**解不开** ——
      // 那要把整条 CSS 变量链跟下去。解不开就给 null，S5 会显示「链没解开」，
      // **不猜一个值糊上去**（doc/00 §22.2）。
      json(reply, 200, {
        ok: true,
        data: {
          total: r.total, truncated: r.truncated,
          hits: r.hits.map((t) => ({
            path: t.path,
            value: typeof t.value === "string" ? t.value : JSON.stringify(t.value),
            resolved: typeof t.value === "string" && !/^var\(/.test(t.value) ? t.value : null,
            kind: t.kind,
            note: t.preview ?? null,
          })),
        },
      });
      return true;
    }

    /* 颜色控件的候选：这份稿自己声明的 CSS 变量（doc/00 §二十七）。
       不是 token 路径 —— 那是另一套命名空间，按 token 拼 var(--…) 有一成多
       会写出这份稿里没定义的变量，静默失效。判据见 cssvars.ts 的头注。 */
    if (route === "cssvars" && req.method === "GET") {
      const f = url.searchParams.get("file");
      if (!f) { json(reply, 400, { ok: false, errors: [{ code: "E_API_BAD_INPUT", message: "缺 file" }] }); return true; }
      json(reply, 200, { ok: true,
        data: await listCssVars(p, f, url.searchParams.get("q") ?? undefined,
          Number(url.searchParams.get("limit") ?? 40)) });
      return true;
    }

    if (route === "icons" && req.method === "GET") {
      json(reply, 200, { ok: true,
        data: await listIcons(p, url.searchParams.get("q") ?? undefined,
          Number(url.searchParams.get("limit") ?? 60), true) });   // 界面要画图标，带 path
      return true;
    }

    if (route === "components" && req.method === "GET") {
      const all = await listComponents(p);
      json(reply, 200, { ok: true, data: { total: all.length, components: all } });
      return true;
    }

    // ── 可写 ──
    if (route === "set_prop" && req.method === "POST") {
      if (!originOk(req, ctx.port)) {
        json(reply, 403, { ok: false, errors: [{ code: "E_API_ORIGIN", message: "Origin 不是本服务" }] });
        return true;
      }
      const b = await readBody(req);
      const r = await setProp(p,
        str(b.file, "file"), str(b.node, "node"),
        str(b.kind, "kind") as SlotKind, str(b.name, "name"),
        typeof b.value === "string" ? b.value : "",
        "人手改");   // 本地 API 只有界面在调 —— 这一版是人落的
      json(reply, 200, { ok: true, data: r });
      return true;
    }

    if (route === "project_changes" && req.method === "GET") {
      const files = (await listDrafts(p))
        .map((a) => relative(p.dir, a).split(sep).join("/"))
        .filter((r) => !isToolPage(r));
      const since = url.searchParams.get("since");
      const rows = await projectChangesSince(p, files, since);
      // 只把有变更的稿给界面 —— 一个项目几十份稿，大半是「只有一版，没有可比的」，
      // 全给过去等于让人自己在噪声里找
      const changed = rows.filter((r) => r.diff && r.diff.changes.length > 0);
      json(reply, 200, { ok: true, data: {
        project: p.name, title: p.title,
        scanned: rows.length, changed: changed.length,
        rows: changed,
        skipped: rows.filter((r) => !r.diff).map((r) => ({ path: r.path, note: r.note })),
      } });
      return true;
    }

    if (route === "index_status" && req.method === "GET") {
      json(reply, 200, { ok: true, data: await indexStatus(p) });
      return true;
    }

    // ── 长活儿：render_check 要开 Chromium（1.4~12s），做成作业 + 轮询 ──
    if (route === "check" && req.method === "POST") {
      if (!originOk(req, ctx.port)) {
        json(reply, 403, { ok: false, errors: [{ code: "E_API_ORIGIN", message: "Origin 不是本服务" }] });
        return true;
      }
      const b = await readBody(req);
      const rel = await resolveDraft(p, str(b.file, "file"));
      const j = startJob("render_check", `${p.name}::${rel}`,
        async () => {
          const { result, diags } = await renderCheck(p, rel, {
            width: typeof b.width === "number" ? b.width : undefined,
            height: typeof b.height === "number" ? b.height : undefined,
            allowNetwork: b.allowNetwork === true,
          });
          return { file: rel, result, diags };
        },
        (e) => e instanceof ToolError
          ? { code: e.diagnostic.code, message: e.diagnostic.message, fix: e.diagnostic.fix }
          : { code: "E_JOB", message: (e as Error)?.message ?? String(e) });
      json(reply, 200, { ok: true, data: jobView(j) });
      return true;
    }

    if (route === "check_status" && req.method === "GET") {
      const id = str(url.searchParams.get("job"), "job");
      const j = getJob(id);
      if (!j) {
        json(reply, 404, { ok: false, errors: [{ code: "E_JOB_UNKNOWN", message: `没有这个作业：${id}`,
          fix: "作业记录活在 MCP server 进程里，重启就没了。读数本身在 .umbrastudio/checks/，可以直接 GET validate" }] });
        return true;
      }
      json(reply, 200, { ok: j.ok !== false, data: jobView(j) });
      return true;
    }

    if (route === "revert" && req.method === "POST") {
      if (!originOk(req, ctx.port)) {
        json(reply, 403, { ok: false, errors: [{ code: "E_API_ORIGIN", message: "Origin 不是本服务" }] });
        return true;
      }
      const b = await readBody(req);
      json(reply, 200, { ok: true, data: await revertTo(p, str(b.file, "file"), str(b.version, "version"), "人手改") });
      return true;
    }

    /* AI 会话（M2-12：应用前端的会话面板走本地 API，和 MCP 的 chat_send 同一份逻辑） */
    /* ── 钉在节点上的评论（M6-2） ── */
    if (route === "comments" && req.method === "GET") {
      const f = url.searchParams.get("file");
      json(reply, 200, { ok: true, data: { comments: await listComments(p.dir, f ? await resolveDraft(p, f) : undefined) } });
      return true;
    }
    if (route === "comment_add" && req.method === "POST") {
      if (!originOk(req, ctx.port)) { json(reply, 403, { ok: false, errors: [{ code: "E_API_ORIGIN", message: "Origin 不是本服务" }] }); return true; }
      const b = await readBody(req);
      json(reply, 200, { ok: true, data: await addComment(p.dir, { file: await resolveDraft(p, str(b.file, "file")), node: str(b.node, "node"), tag: typeof b.tag === "string" ? b.tag : undefined, text: str(b.text, "text") }) });
      return true;
    }
    if (route === "comment_update" && req.method === "POST") {
      if (!originOk(req, ctx.port)) { json(reply, 403, { ok: false, errors: [{ code: "E_API_ORIGIN", message: "Origin 不是本服务" }] }); return true; }
      const b = await readBody(req);
      json(reply, 200, { ok: true, data: await updateComment(p.dir, str(b.id, "id"), { text: typeof b.text === "string" ? b.text : undefined, resolved: typeof b.resolved === "boolean" ? b.resolved : undefined }) });
      return true;
    }
    if (route === "comment_delete" && req.method === "POST") {
      if (!originOk(req, ctx.port)) { json(reply, 403, { ok: false, errors: [{ code: "E_API_ORIGIN", message: "Origin 不是本服务" }] }); return true; }
      const b = await readBody(req);
      json(reply, 200, { ok: true, data: await deleteComment(p.dir, str(b.id, "id")) });
      return true;
    }

    if (route === "chat_list" && req.method === "GET") {
      const r = await listChats(p.dir);
      /* **空会话不进历史**（设计侧第六轮定的规矩）：会话是「点了新建」就建的，
         真发出第一条消息才算数。不滤掉的话，用户每点一次「＋」列表里就多一条空壳，
         很快就被占满。这里滤显示，盘上的文件不动 —— 删文件是另一回事，得用户说了算。 */
      json(reply, 200, { ok: true, data: { sessions: r.sessions.filter((x) => x.msgCount > 0) } });
      return true;
    }
    if (route === "chat_rename" && req.method === "POST") {
      const b = await readBody(req) as { session?: string; title?: string };
      const { renameChat } = await import("./chat.js");
      const sid = str(b.session, "session");
      const s2 = await renameChat(p.dir, sid, String(b.title ?? ""));
      json(reply, 200, { ok: true, data: { id: s2.id, title: s2.title ?? "", titled: !!s2.title } });
      return true;
    }
    if (route === "chat_delete" && req.method === "POST") {
      const b = await readBody(req) as { session?: string };
      const { deleteChat } = await import("./chat.js");
      const sid = str(b.session, "session");
      await deleteChat(p.dir, sid);
      json(reply, 200, { ok: true, data: { id: sid, deleted: true } });
      return true;
    }
    if (route === "chat_get" && req.method === "GET") {
      const s = await loadChat(p.dir, str(url.searchParams.get("session"), "session"));
      if (!s) throw new Error("没有这个会话");
      json(reply, 200, { ok: true, data: s });
      return true;
    }
    if (route === "chat_send" && req.method === "POST") {
      if (!originOk(req, ctx.port)) {
        json(reply, 403, { ok: false, errors: [{ code: "E_API_ORIGIN", message: "Origin 不是本服务" }] });
        return true;
      }
      const b = await readBody(req);
      const args = {
        message: str(b.message, "message"),
        sessionId: typeof b.sessionId === "string" ? b.sessionId : undefined,
        channel: (b.channel === "b" ? "b" : b.channel === "c" ? "c" : "a") as "a" | "b" | "c",
        selectedFiles: Array.isArray(b.selectedFiles) ? (b.selectedFiles as unknown[]).filter((x): x is string => typeof x === "string") : undefined,
        selectedRange: b.selectedRange && typeof b.selectedRange === "object"
          ? { label: String((b.selectedRange as Record<string, unknown>).label ?? ""), text: String((b.selectedRange as Record<string, unknown>).text ?? "") }
          : undefined,
        selectedRegion: b.selectedRegion && typeof b.selectedRegion === "object"
          ? { label: String((b.selectedRegion as Record<string, unknown>).label ?? ""), note: String((b.selectedRegion as Record<string, unknown>).note ?? ""),
              image: typeof (b.selectedRegion as Record<string, unknown>).image === "string" ? String((b.selectedRegion as Record<string, unknown>).image) : null }
          : undefined,
        selectedNodeFile: typeof b.selectedNodeFile === "string" ? b.selectedNodeFile : undefined,
        selectedNodeAddress: typeof b.selectedNodeAddress === "string" ? b.selectedNodeAddress : undefined,
        contextFile: typeof b.contextFile === "string" ? b.contextFile : undefined,
      };
      if (b.async !== true) { json(reply, 200, await runChatSend(p, args)); return true; }
      /* 作业化（doc/00 §四十）：立刻回 jobId + sessionId，界面边轮询 chat_get 看工具行长出来、边可中断。
         会话先建好再起作业 —— 否则界面在跑完之前不知道该轮询哪个会话。 */
      if (!args.sessionId) {
        const cfg = await getAiConfig();
        const s = await createChat(p.dir, { projectId: p.name, channel: args.channel, model: (args.channel === "b" ? cfg.channelB?.model : cfg.channelA?.model) ?? "unknown" });
        args.sessionId = s.id;
      }
      const ctl = new AbortController();
      const j = startJob("chat", `${p.name}::chat::${args.sessionId}`,
        () => runChatSend(p, { ...args, abortSignal: ctl.signal }),
        (e) => ({ code: "E_JOB", message: (e as Error)?.message ?? String(e) }));
      chatAborts.set(j.id, ctl);
      json(reply, 200, { ok: true, data: { ...jobView(j), sessionId: args.sessionId } });
      return true;
    }
    if (route === "chat_status" && req.method === "GET") {
      const j = getJob(str(url.searchParams.get("job"), "job"));
      if (!j) throw new Error("没有这个作业");
      if (!j.running) chatAborts.delete(j.id);
      json(reply, 200, { ok: true, data: jobView(j) });
      return true;
    }
    if (route === "chat_interrupt" && req.method === "POST") {
      if (!originOk(req, ctx.port)) { json(reply, 403, { ok: false, errors: [{ code: "E_API_ORIGIN", message: "Origin 不是本服务" }] }); return true; }
      const b = await readBody(req);
      const ctl = chatAborts.get(str(b.job, "job"));
      if (!ctl) { json(reply, 200, { ok: true, data: { interrupted: false, note: "作业不在跑或已结束" } }); return true; }
      ctl.abort();
      json(reply, 200, { ok: true, data: { interrupted: true, note: "已发中断：通道 A 在当前这一步结束后停下；已落盘的改动照常可审可回退" } });
      return true;
    }

    /* ── 应用首页（doc/12 M6-6）：全部项目 + 最近打开 + 缩略图。这是全局数据，不限于本服务的项目 ── */
    if (route === "projects" && req.method === "GET") {
      const recents = (await listRecentProjects()).recents;
      const seen = new Set<string>();
      const rows: Array<Record<string, unknown>> = [];
      const describe = async (dir: string) => {
        let pj: Project | null = null;
        try { pj = await buildProject(dir); } catch { return null; }
        const files = (await listDrafts(pj)).map((a) => relative(pj!.dir, a).split(sep).join("/")).filter((r) => !isToolPage(r));
        let thumb: string | null = null, generatedAt: string | null = null;
        const dataFile = join(dir, ".umbrastudio", "index-data.json");
        if (existsSync(dataFile)) {
          try {
            const data = JSON.parse(await readFile(dataFile, "utf8")) as { project?: { generatedAt?: string }; drafts?: Array<{ thumb: string | null; elements: number }> };
            generatedAt = data.project?.generatedAt ?? null;
            const first = (data.drafts ?? []).filter((d) => d.thumb).sort((a, b) => b.elements - a.elements)[0];
            if (first?.thumb) {
              const png = join(dir, first.thumb);
              if (existsSync(png) && statSync(png).size < 400 * 1024) thumb = "data:image/png;base64," + (await readFile(png)).toString("base64");
            }
          } catch { /* 没索引就没缩略图 */ }
        }
        return { name: pj.name, title: pj.title, dir: pj.dir, drafts: files.length, gitEnabled: pj.gitEnabled, generatedAt, thumb };
      };
      for (const r of recents) {
        if (seen.has(r.dir)) continue;
        seen.add(r.dir);
        if (!r.exists) continue;   // 目录不在的最近项目（多半是回归测试留下的临时目录）不上首页，免得一屏「找不到」
        const d = await describe(r.dir);
        if (d) rows.push({ ...d, lastOpened: r.lastOpened, current: r.dir === p?.dir });
      }
      for (const dir of await listProjectDirs()) {
        if (seen.has(dir)) continue;
        seen.add(dir);
        const d = await describe(dir);
        if (d) rows.push({ ...d, lastOpened: null, current: dir === p?.dir });
      }
      json(reply, 200, { ok: true, data: { current: p?.dir ?? null, projects: rows } });
      return true;
    }
    if (route === "open_project" && req.method === "POST") {
      if (!originOk(req, ctx.port)) { json(reply, 403, { ok: false, errors: [{ code: "E_API_ORIGIN", message: "Origin 不是本服务" }] }); return true; }
      const b = await readBody(req);
      const dir = str(b.dir, "dir");
      const target = await buildProject(dir);
      const { serveStart } = await import("./serve.js");
      const s = await serveStart(target);
      if (!s.indexExists) await buildIndex(target, s.url);   // 第一次打开：部署壳与令牌，否则 S2 / S6 / S8 全 404
      await touchProject(target.dir, target.name, target.title);
      json(reply, 200, { ok: true, data: { url: s.url, token: s.token, ws: `ws://127.0.0.1:${s.port}${API_PREFIX}ws`, name: target.name, title: target.title, dir: target.dir, app: s.url + "__app/" } });
      return true;
    }

    if (route === "ai_probe_image" && req.method === "POST") {
      if (!originOk(req, ctx.port)) { json(reply, 403, { ok: false, errors: [{ code: "E_API_ORIGIN", message: "Origin 不是本服务" }] }); return true; }
      const { probeImageSupport } = await import("./ai_probe.js");
      const b = await readBody(req);
      json(reply, 200, { ok: true, data: await probeImageSupport(b.channel === "c" ? "c" : "a") });
      return true;
    }
    /* 这台机器上装了哪些 AI CLI（M2-13）。**只回答「装了没」，不回答「登录了没」** ——
       判登录得真发一次请求，那要花钱也要花时间，不该塞在一个列清单的接口里。 */
    if (route === "local_clis" && req.method === "GET") {
      const { detectLocalClis } = await import("./local_cli.js");
      const rows = await detectLocalClis();
      json(reply, 200, { ok: true, data: { clis: rows, installed: rows.filter((r) => r.installed).length } });
      return true;
    }
    /* 改通道 B 用哪个本地 CLI（M2-13）。
       **只放行非密钥字段**：cli / model / maxBudgetUsd。`baseUrl` 与 `apiKey` 原样保留，
       不从这条路进也不从这条路出 —— 密钥属于机器，只在 ai_config.json 里手改（`11` Q7）。 */
    /* 问某个 CLI 有哪些模型可用。可用模型是**按账号**来的，写死在文档里一定过时 ——
       实测填 `sonnet-4` 被 cursor-agent 顶回来：Available models: auto, composer-2.5, … */
    if (route === "local_cli_models" && req.method === "GET") {
      const { listCliModels, CLI_SPECS } = await import("./local_cli.js");
      const cli = url.searchParams.get("cli") ?? "";
      if (!CLI_SPECS.some((x) => x.id === cli)) {
        json(reply, 400, { ok: false, errors: [{ code: "E_BAD_INPUT", message: `不认识的 CLI：${cli}` }] });
        return true;
      }
      const models = await listCliModels(cli as Parameters<typeof listCliModels>[0]);
      json(reply, 200, { ok: true, data: { cli, models } });
      return true;
    }
    if (route === "ai_channel_b" && req.method === "POST") {
      const b = await readBody(req) as { cli?: string; model?: string; maxBudgetUsd?: number };
      const { getAiConfig, setAiConfig } = await import("./ai_config.js");
      const { CLI_SPECS } = await import("./local_cli.js");
      const cfg = await getAiConfig();
      const cur = cfg.channelB ?? { baseUrl: "", apiKey: "", model: "sonnet" };
      const cli = b.cli ?? cur.cli ?? "claude";
      const spec = CLI_SPECS.find((x) => x.id === cli);
      if (!spec) {
        json(reply, 400, { ok: false, errors: [{ code: "E_BAD_INPUT", message: `不认识的 CLI：${cli}`,
          fix: `能选的是：${CLI_SPECS.map((x) => x.id).join(" / ")}` }] });
        return true;
      }
      /* 模型名允许空 —— 空就是「用这个 CLI 自己的默认」，各家都有默认，
         硬要用户填反而容易填错（实测把 cursor 的 `sonnet-4` 填进去直接被顶回来）。 */
      const model = b.model !== undefined ? b.model.trim() : (cur.model ?? "");
      /* 换了 CLI 就把端点清掉：那两个字段只对 Claude Code 有意义，留着会让「走的是登录态还是端点」
         这个判断说谎（`via` 会显示 endpoint 而实际上那个 CLI 根本不看它）。 */
      const keepEndpoint = cli === "claude";
      await setAiConfig({ ...cfg, channelB: {
        cli: spec.id, model,
        baseUrl: keepEndpoint ? cur.baseUrl : "",
        apiKey: keepEndpoint ? cur.apiKey : "",
        maxBudgetUsd: b.maxBudgetUsd ?? cur.maxBudgetUsd,
      } });
      json(reply, 200, { ok: true, data: { cli: spec.id, model, label: spec.label, verified: spec.verified, note: spec.note } });
      return true;
    }
    if (route === "ai_config" && req.method === "GET") {
      // 只给模型名与「吃不吃图」，**不回显 key**（密钥属于机器，`11` Q7）
      const { getAiConfig, channelSupportsImage, channelBUsesLocalLogin } = await import("./ai_config.js");
      const cfg = await getAiConfig();
      const one = (c: { model: string; supportsImage?: boolean } | null | undefined) => c ? { model: c.model, supportsImage: channelSupportsImage(c) } : null;
      /* 通道 B 多报一个 via：「本机已登录的 Claude Code」和「别家 Anthropic 兼容端点」
         在界面上得分得清 —— 分不清就会把不是 Anthropic 形状的端点填进来（2026-09-24 真发生过）。 */
      const { CLI_SPECS } = await import("./local_cli.js");
      const bCli = cfg.channelB?.cli ?? "claude";
      const b = cfg.channelB ? {
        ...one(cfg.channelB)!,
        via: channelBUsesLocalLogin(cfg.channelB) ? "local" as const : "endpoint" as const,
        cli: bCli,
        // 显示名由服务端给：CLI_SPECS 已经有了，前端再抄一份 id→名字 的表迟早对不上
        cliLabel: CLI_SPECS.find((x) => x.id === bCli)?.label ?? bCli,
      } : null;
      json(reply, 200, { ok: true, data: { channelA: one(cfg.channelA), channelB: b, channelC: one(cfg.channelC), defaultChannel: cfg.defaultChannel } });
      return true;
    }

    /* ── M8：泛型文件（目录视图 / .md / 图片 / 通用文件卡都走这几条） ── */
    if (route === "files" && req.method === "GET") {
      /* limit=0 表示「全部给我」——「还有 N 项 · 全部显示」那个入口点下去时用 */
      const lim = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined;
      json(reply, 200, { ok: true, data: await listFiles(p, url.searchParams.get("dir") ?? "", Number.isFinite(lim) ? lim! : undefined) });
      return true;
    }
    if (route === "file" && req.method === "GET") {
      json(reply, 200, { ok: true, data: await readAnyFile(p, str(url.searchParams.get("path"), "path")) });
      return true;
    }
    if (route === "file_write" && req.method === "POST") {
      if (!originOk(req, ctx.port)) { json(reply, 403, { ok: false, errors: [{ code: "E_API_ORIGIN", message: "Origin 不是本服务" }] }); return true; }
      const b = await readBody(req);
      json(reply, 200, { ok: true, data: await writeAnyFile(p, str(b.path, "path"), typeof b.content === "string" ? b.content : "",
        { expectSha256: typeof b.expectSha256 === "string" ? b.expectSha256 : undefined, origin: "人手改", note: typeof b.note === "string" ? b.note : undefined }) });
      return true;
    }
    if (route === "file_versions" && req.method === "GET") {
      const path = str(url.searchParams.get("path"), "path");
      json(reply, 200, { ok: true, data: { path, snapshots: await listSnapshotMeta(p, path) } });
      return true;
    }
    if (route === "file_revert" && req.method === "POST") {
      if (!originOk(req, ctx.port)) { json(reply, 403, { ok: false, errors: [{ code: "E_API_ORIGIN", message: "Origin 不是本服务" }] }); return true; }
      const b = await readBody(req);
      json(reply, 200, { ok: true, data: await revertFile(p, str(b.path, "path"), str(b.version, "version")) });
      return true;
    }
    if (route === "file_move" && req.method === "POST") {
      if (!originOk(req, ctx.port)) { json(reply, 403, { ok: false, errors: [{ code: "E_API_ORIGIN", message: "Origin 不是本服务" }] }); return true; }
      const b = await readBody(req);
      json(reply, 200, { ok: true, data: await moveFile(p, str(b.from, "from"), str(b.to, "to")) });
      return true;
    }
    if (route === "file_trash" && req.method === "POST") {
      if (!originOk(req, ctx.port)) { json(reply, 403, { ok: false, errors: [{ code: "E_API_ORIGIN", message: "Origin 不是本服务" }] }); return true; }
      const b = await readBody(req);
      json(reply, 200, { ok: true, data: await trashFile(p, str(b.path, "path")) });
      return true;
    }
    if (route === "file_refs" && req.method === "GET") {
      const path = str(url.searchParams.get("path"), "path");
      json(reply, 200, { ok: true, data: { path, referencedBy: await referencesOf(p, path) } });
      return true;
    }
    if (route === "file_types" && req.method === "GET") {
      json(reply, 200, { ok: true, data: { types: await countTypes(p) } });
      return true;
    }

    /* ── 浏览器模式的建稿 / 建项目 / 打开目录（Tauri 里走 MCP，浏览器里没有 MCP 通道，走这里；同一份实现） ── */
    if (route === "create_draft" && req.method === "POST") {
      if (!originOk(req, ctx.port)) { json(reply, 403, { ok: false, errors: [{ code: "E_API_ORIGIN", message: "Origin 不是本服务" }] }); return true; }
      const b = await readBody(req);
      const path = str(b.path, "path");
      const source = b.source === "copy" ? { kind: "copy" as const, sourceFile: str(b.sourceFile, "sourceFile") }
        : b.source === "component" ? { kind: "component" as const, componentName: str(b.componentName, "componentName"), title: typeof b.title === "string" ? b.title : undefined }
        : { kind: "blank" as const, title: typeof b.title === "string" ? b.title : undefined };
      json(reply, 200, { ok: true, data: await createDraft(p, path, source) });
      return true;
    }
    if (route === "create_project" && req.method === "POST") {
      if (!originOk(req, ctx.port)) { json(reply, 403, { ok: false, errors: [{ code: "E_API_ORIGIN", message: "Origin 不是本服务" }] }); return true; }
      const b = await readBody(req);
      const r = await createProject(str(b.name, "name"), { dir: typeof b.dir === "string" && b.dir ? b.dir : undefined, title: typeof b.title === "string" && b.title ? b.title : undefined });
      await touchProject(r.dir, r.name, r.title);
      json(reply, 200, { ok: true, data: r });
      return true;
    }
    if (route === "reveal_dir" && req.method === "POST") {
      if (!originOk(req, ctx.port)) { json(reply, 403, { ok: false, errors: [{ code: "E_API_ORIGIN", message: "Origin 不是本服务" }] }); return true; }
      const b = await readBody(req);
      const dir = str(b.dir, "dir");
      if (!existsSync(dir)) throw new Error(`目录不存在：${dir}`);
      const { spawn } = await import("node:child_process");
      const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
      spawn(cmd, [dir], { stdio: "ignore", detached: true }).unref();
      json(reply, 200, { ok: true, data: { revealed: dir } });
      return true;
    }
    if (route === "inspect_dir" && req.method === "GET") {
      const dir = str(url.searchParams.get("dir"), "dir");
      const { stat, readdir } = await import("node:fs/promises");
      let exists = false, isDir = false;
      try { const st = await stat(dir); exists = true; isDir = st.isDirectory(); } catch { /* 不存在 */ }
      let draftCount = 0;
      if (exists && isDir) {
        const walk = async (d: string, depth: number): Promise<void> => {
          if (depth > 6) return;
          for (const e of await readdir(d, { withFileTypes: true })) {
            if (e.name.startsWith(".") || e.name === "node_modules") continue;
            if (e.isDirectory()) await walk(join(d, e.name), depth + 1);
            else if (e.name.endsWith(".dc.html") && !isToolPage(e.name)) draftCount++;
          }
        };
        await walk(dir, 0);
      }
      json(reply, 200, { ok: true, data: { dir, exists, isDir, isProject: exists && existsSync(join(dir, "project.json")), draftCount, suggestedName: (dir.split("/").pop() || "project").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "project" } });
      return true;
    }

    /* ── S1 行内撤销（设计侧第三轮 §1.1）：删除到回收站 / 按稿名从回收站恢复最近那份 ── */
    if (route === "delete_draft" && req.method === "POST") {
      if (!originOk(req, ctx.port)) { json(reply, 403, { ok: false, errors: [{ code: "E_API_ORIGIN", message: "Origin 不是本服务" }] }); return true; }
      const b = await readBody(req);
      const rel = await resolveDraft(p, str(b.file, "file"));
      json(reply, 200, { ok: true, data: await deleteDraft(p, rel) });
      return true;
    }
    if (route === "restore_draft" && req.method === "POST") {
      if (!originOk(req, ctx.port)) { json(reply, 403, { ok: false, errors: [{ code: "E_API_ORIGIN", message: "Origin 不是本服务" }] }); return true; }
      const b = await readBody(req);
      const file = str(b.file, "file");
      const base = file.split("/").pop() as string;
      // S1 只知道稿名不知道回收站路径：取同名里最近删的那份（listTrash 已按时间倒序）
      const hit = (await listTrash(p)).find((t) => t.originalName === base);
      if (!hit) throw new Error(`回收站里没有 ${base}`);
      json(reply, 200, { ok: true, data: await restoreDraft(p, hit.trashPath) });
      return true;
    }

    /* ── S8 项目设置（M1-9 / M1-10 / M1-12 的界面接线，doc/00 §三十九） ── */
    if (route === "project_settings" && req.method === "GET") {
      const files = (await listDrafts(p)).map((a) => relative(p.dir, a).split(sep).join("/")).filter((r) => !isToolPage(r));
      let dsStats: { tokens: number; icons: number; components: number } | null = null;
      if (p.dsDir) {
        try {
          const [tk, ic, comps] = await Promise.all([
            searchTokens(p, "", 1).then((r) => (r as { total?: number }).total ?? 0).catch(() => 0),
            listIcons(p, undefined, 1).then((r) => r.total).catch(() => 0),
            listComponents(p).then((r) => r.length).catch(() => 0),
          ]);
          dsStats = { tokens: tk, icons: ic, components: comps };
        } catch { dsStats = null; }
      }
      json(reply, 200, { ok: true, data: {
        name: p.name, title: p.title, dir: p.dir, draftCount: files.length, gitEnabled: p.gitEnabled,
        designSystem: { dir: p.dsDir, alias: p.dsAlias, tokens: p.tokensPath, icons: p.iconsPath, stats: dsStats },
        limits: p.limits,
        trash: await listTrash(p),
      } });
      return true;
    }
    if (route === "project_update" && req.method === "POST") {
      if (!originOk(req, ctx.port)) { json(reply, 403, { ok: false, errors: [{ code: "E_API_ORIGIN", message: "Origin 不是本服务" }] }); return true; }
      const b = await readBody(req);
      const opts: Record<string, unknown> = {};
      for (const k of ["title", "designSystemDir", "designSystemAlias", "tokens", "icons"]) if (k in b) opts[k] = b[k];
      for (const k of ["elementsWarn", "elementsHard"]) if (typeof b[k] === "number") opts[k] = b[k];
      const r = await updateProject(p, opts as Parameters<typeof updateProject>[1]);
      // 配置变了，本服务上的 Project 对象也要换 —— 否则下一次校验还用旧限额
      const { buildProject } = await import("./project.js");
      Object.assign(p, await buildProject(p.dir));
      json(reply, 200, { ok: true, data: r });
      return true;
    }
    if (route === "trash_restore" && req.method === "POST") {
      if (!originOk(req, ctx.port)) { json(reply, 403, { ok: false, errors: [{ code: "E_API_ORIGIN", message: "Origin 不是本服务" }] }); return true; }
      const b = await readBody(req);
      json(reply, 200, { ok: true, data: await restoreDraft(p, str(b.trashPath, "trashPath")) });
      return true;
    }
    if (route === "trash_purge" && req.method === "POST") {
      if (!originOk(req, ctx.port)) { json(reply, 403, { ok: false, errors: [{ code: "E_API_ORIGIN", message: "Origin 不是本服务" }] }); return true; }
      const b = await readBody(req);
      json(reply, 200, { ok: true, data: await purgeTrash(p, str(b.trashPath, "trashPath")) });
      return true;
    }
    if (route === "trash_empty" && req.method === "POST") {
      if (!originOk(req, ctx.port)) { json(reply, 403, { ok: false, errors: [{ code: "E_API_ORIGIN", message: "Origin 不是本服务" }] }); return true; }
      json(reply, 200, { ok: true, data: await emptyTrash(p) });
      return true;
    }
    if ((route === "project_archive" || route === "project_delete") && req.method === "POST") {
      if (!originOk(req, ctx.port)) { json(reply, 403, { ok: false, errors: [{ code: "E_API_ORIGIN", message: "Origin 不是本服务" }] }); return true; }
      const b = await readBody(req);
      if (route === "project_delete" && b.typed !== p.name) throw new Error("要把项目名敲一遍才能删");
      // 两条现在都是「移到 .archived/」（delete_project = 归档，doc/12 M1-10）；目录一搬走，这个服务就该停
      const r = route === "project_delete" ? await deleteProject(p) : await archiveProject(p);
      json(reply, 200, { ok: true, data: { ...r, note: "项目目录已移走，这个服务随即关闭" } });
      setTimeout(() => { try { serveStopByName(p.name); } catch { /* ignore */ } }, 300);
      return true;
    }

    /* S1「重建索引」（M5-8）。build_index 会重写入口页（S1 自己），所以界面调完要整页重载。
       serveUrl 用本服务的地址 —— 入口页里的链接都是相对路径，这个值只进 index-data 的 url 字段。 */
    if (route === "rebuild_index" && req.method === "POST") {
      if (!originOk(req, ctx.port)) {
        json(reply, 403, { ok: false, errors: [{ code: "E_API_ORIGIN", message: "Origin 不是本服务" }] });
        return true;
      }
      const built = await buildIndex(p, `http://127.0.0.1:${ctx.port}/`);
      json(reply, 200, { ok: true, data: built });
      return true;
    }

    json(reply, 404, { ok: false, errors: [{ code: "E_API_ROUTE", message: `没有这个接口：${route}` }] });
    return true;
  } catch (e) {
    if (e instanceof ToolError) {
      json(reply, 400, { ok: false, errors: [e.diagnostic], data: e.data ?? null });
      return true;
    }
    json(reply, 400, { ok: false, errors: [{ code: "E_API", message: (e as Error).message }] });
    return true;
  }
}
