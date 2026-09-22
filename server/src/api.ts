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
import { changesSince, humanTime, listVersions, projectChangesSince, readVersionMeta, toMarkdown, workspaceState } from "./history.js";
import { draftPath, listDrafts, type Project } from "./project.js";
import { resolveDraft } from "./locate.js";
import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import { ToolError } from "./envelope.js";
import { buildIndex, indexStatus, isToolPage } from "./indexpage.js";
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
  return o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
}

export interface ApiCtx { project: Project; token: string; port: number }

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

  const p = ctx.project;
  try {
    // ── 只读 ──
    if (route === "drafts" && req.method === "GET") {
      const files = (await listDrafts(p))
        .map((a) => relative(p.dir, a).split(sep).join("/"))
        .filter((r) => !isToolPage(r));
      json(reply, 200, { ok: true, data: { project: p.name, title: p.title, files } });
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
      const since = url.searchParams.get("since") || (vs[0] as string);
      const d = await changesSince(p, rel, since);
      json(reply, 200, { ok: true, data: { file: rel, versions: vs, versionMeta, diff: d, markdown: toMarkdown(d) } });
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
          fix: "作业记录活在 MCP server 进程里，重启就没了。读数本身在 .umbradesign/checks/，可以直接 GET validate" }] });
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
