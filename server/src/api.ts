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
import { httpRoutes, type CapCtx } from "./cap/index.js";
import { z } from "zod";
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

/** 一个 zod schema 是不是 number（含 `.optional()` 包了一层的）。
 *  ⚠️ 不能只看最外层 —— `z.number().optional()` 的 `typeName` 是 `ZodOptional`，
 *  照那个判会把所有可选数字当成字符串传进去。 */
function isNumberSchema(d: unknown): boolean {
  const def = (d as { _def?: { typeName?: string; innerType?: unknown } })._def;
  if (!def) return false;
  if (def.typeName === "ZodNumber") return true;
  return def.innerType ? isNumberSchema(def.innerType) : false;
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

  /* ⚠️ **`cap/` 里 `scope: "global"` 的也算全局**（M11-7 第三批）。
     不加这一句的话，搬过去的全局能力（列项目、新建项目、看目录…）在 hub 模式下会 404 ——
     而 hub 就是桌面壳的首页，那等于首页整个不能用。
     以前只有 `GLOBAL_ROUTES` 那张手写名单，搬一条就要记得往里补一条，
     而忘了补的症状是「首页某个按钮点了报 404」，`doc/00` §八十三 记的分叉同一个病。 */
  const capOfRoute = httpRoutes().get(route);
  const isGlobal = GLOBAL_ROUTES.has(route) || capOfRoute?.scope === "global";
  if (!ctx.project && !isGlobal) {
    json(reply, 404, { ok: false, errors: [{ code: "E_API_HUB", message: `hub 服务没有项目上下文，路由 ${route} 要从项目自己的服务调（open_project 会给 url / token）` }] });
    return true;
  }
  const p = ctx.project as Project;   // 非全局路由到这里一定有项目；全局路由只在下面用 p?.dir
  try {
    // ── 只读 ──


    // M6-3 源码只读视图：当前盘上那一版的原文（应用里看，不是给模型的 read_draft）



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


    /* 颜色控件的候选：这份稿自己声明的 CSS 变量（doc/00 §二十七）。
       不是 token 路径 —— 那是另一套命名空间，按 token 拼 var(--…) 有一成多
       会写出这份稿里没定义的变量，静默失效。判据见 cssvars.ts 的头注。 */



    // ── 可写 ──



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


    /* AI 会话（M2-12：应用前端的会话面板走本地 API，和 MCP 的 chat_send 同一份逻辑） */
    /* ── 钉在节点上的评论（M6-2） ── */

    if (route === "templates" && req.method === "GET") {
      /* 新建稿件那一屏的「起始模板」（M8-24）。模板在**每个项目自己的**
         `.umbrastudio/templates/`，不是 design-system 目录 —— 设计侧猜错了，回执里纠正过。 */
      const { listTemplates } = await import("./templates.js");
      const list = await listTemplates(p);
      json(reply, 200, { ok: true, data: { templates: list.map((t) => ({ id: t.name, name: t.name, sub: t.elementCount ? `${t.elementCount} 元素` : undefined })) } });
      return true;
    }
    if (route === "save_template" && req.method === "POST") {
      /* 「存为模板…」（M8-28）。MCP 侧早有 `saveAsTemplate`，本地 API 没开过 ——
         界面上一直没有入口，所以没人发现缺。第九轮给了入口。 */
      const b = await readBody(req) as { path?: string; name?: string };
      const { saveAsTemplate } = await import("./templates.js");
      const r = await saveAsTemplate(p, str(b.path, "path"), str(b.name, "name"));
      json(reply, 200, { ok: true, data: r });
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

    /* 这台机器上装了哪些 AI CLI（M2-13）。**只回答「装了没」，不回答「登录了没」** ——
       判登录得真发一次请求，那要花钱也要花时间，不该塞在一个列清单的接口里。 */
    /* 改通道 B 用哪个本地 CLI（M2-13）。
       **只放行非密钥字段**：cli / model / maxBudgetUsd。`baseUrl` 与 `apiKey` 原样保留，
       不从这条路进也不从这条路出 —— 密钥属于机器，只在 ai_config.json 里手改（`11` Q7）。 */
    /* 问某个 CLI 有哪些模型可用。可用模型是**按账号**来的，写死在文档里一定过时 ——
       实测填 `sonnet-4` 被 cursor-agent 顶回来：Available models: auto, composer-2.5, … */
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
      const { getAiConfig, channelSupportsImage, channelBUsesLocalLogin, engineView } = await import("./ai_config.js");
      const cfg = await getAiConfig();
      const one = (c: { model: string; supportsImage?: boolean } | null | undefined, ch?: "a" | "c") =>
        c ? { model: c.model, supportsImage: channelSupportsImage(c), ...(ch ? engineView(cfg, ch) : {}) } : null;
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
        ...engineView(cfg, "b", CLI_SPECS.find((x) => x.id === bCli)?.label),
      } : null;
      json(reply, 200, { ok: true, data: { channelA: one(cfg.channelA, "a"), channelB: b, channelC: one(cfg.channelC, "c"), defaultChannel: cfg.defaultChannel } });
      return true;
    }

    /* ── M8：泛型文件（目录视图 / .md / 图片 / 通用文件卡都走这几条） ── */

    /* ── 浏览器模式的建稿 / 建项目 / 打开目录（Tauri 里走 MCP，浏览器里没有 MCP 通道，走这里；同一份实现） ── */
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

    /* ── S8 项目设置（M1-9 / M1-10 / M1-12 的界面接线，doc/00 §三十九） ── */
    /* S1「重建索引」（M5-8）。build_index 会重写入口页（S1 自己），所以界面调完要整页重载。
       serveUrl 用本服务的地址 —— 入口页里的链接都是相对路径，这个值只进 index-data 的 url 字段。 */

    /* ═══ 能力注册表 → HTTP 面（M11-1，Q36）═══
       放在**手写路由的后面**：搬过去的能力在 `cap/` 里，还没搬的照旧走上面。
       两边同名会在 `httpRoutes()` 里直接抛（重名检查），不会悄悄互相覆盖。 */
    const cap = capOfRoute;
    if (cap && req.method === (cap.http!.method)) {
      /* Origin 检查是**门面自己的事**（本地 http 的 CSRF 防线），不是能力的事 ——
         MCP 面走 stdio 根本没有 Origin 这回事。写类一律查。 */
      if (cap.http!.method === "POST" && !originOk(req, ctx.port)) {
        json(reply, 403, { ok: false, errors: [{ code: "E_API_ORIGIN", message: "Origin 不是本服务" }] });
        return true;
      }
      const raw: Record<string, unknown> = cap.http!.method === "GET"
        ? Object.fromEntries(url.searchParams.entries())
        : await readBody(req) as Record<string, unknown>;
      /* GET 的查询串**全是字符串** —— zod 里声明成 number 的会当场失败。
         先按 schema 把数字转回来；这一步漏了的症状是 `limit=50` 报「期望 number 得到 string」。 */
      const shape = cap.input as Record<string, { _def?: unknown }>;
      const input: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(raw)) {
        const def = shape[k];
        input[k] = def && z.number().safeParse(Number(v)).success && isNumberSchema(def) ? Number(v) : v;
      }
      const capCtx: CapCtx = { project: cap.scope === "project" ? p : null, via: "http", port: ctx.port, token: ctx.token };
      const out = await cap.run(input as never, capCtx);
      json(reply, out.ok ? 200 : 400, out);
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
