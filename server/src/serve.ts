/** 形态 A 的静态服务。doc/01 §4.2
 *
 * 为什么必须有：`dc-import` 用 fetch 取兄弟稿，Chrome 不允许对 file:// 发 fetch
 * （doc/05 §4.2）。所以带 dc-import 的稿只能走 http，双击打不开。
 *
 * 服务活在 MCP server 进程里，跨工具调用保持运行 —— 起一次，浏览器里一直能开。
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, normalize, resolve } from "node:path";
import { X } from "./codes.js";
import { err, ToolError } from "./envelope.js";
import type { Project } from "./project.js";
import { API_PREFIX, handleApi, newToken, type ApiCtx } from "./api.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif", ".woff2": "font/woff2", ".woff": "font/woff",
  ".ttf": "font/ttf", ".map": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

interface Running { server: Server; port: number; dir: string; startedAt: string; hits: number; token: string; project: Project }

/** 进程级注册表：项目名 → 正在跑的服务 */
const running = new Map<string, Running>();

function makeServer(dir: string, onHit: () => void, api: () => ApiCtx | null): Server {
  return createServer((req, reply) => {
    onHit();
    // /__ud/* 交给本地 JSON API（doc/00 §二十）。壳要的诊断 / 变更 / slots
    // 每改一次稿就变，注入解决不了，所以走接口。
    const ctx = api();
    if (ctx && (req.url ?? "").startsWith(API_PREFIX)) {
      void handleApi(req, reply, ctx).catch(() => {
        reply.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        reply.end(JSON.stringify({ ok: false, errors: [{ code: "E_API", message: "接口内部出错" }] }));
      });
      return;
    }
    let raw: string;
    try { raw = decodeURIComponent((req.url ?? "/").split("?")[0] as string); }
    catch { raw = "/"; }
    if (raw === "/" || raw.endsWith("/")) raw += "index.dc.html";
    const abs = resolve(dir, "." + normalize(raw));
    if (!abs.startsWith(dir) || !existsSync(abs) || statSync(abs).isDirectory()) {
      reply.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      reply.end(`404 ${raw}`);
      return;
    }
    reply.writeHead(200, {
      "content-type": MIME[extname(abs).toLowerCase()] ?? "application/octet-stream",
      // 设计稿改一下就要能刷出来，所以一律不缓存
      "cache-control": "no-store, must-revalidate",
    });
    createReadStream(abs).pipe(reply);
  });
}

export interface ServeInfo {
  project: string;
  url: string;
  port: number;
  dir: string;
  startedAt: string;
  hits: number;
  indexExists: boolean;
  /** 本地 API 的令牌 —— 壳页面靠它调 /__ud/*（doc/00 §二十） */
  token: string;
}

function info(name: string, r: Running): ServeInfo {
  return {
    project: name,
    url: `http://127.0.0.1:${r.port}/`,
    port: r.port,
    dir: r.dir,
    startedAt: r.startedAt,
    hits: r.hits,
    indexExists: existsSync(resolve(r.dir, "index.dc.html")),
    token: r.token,
  };
}

export async function serveStart(p: Project, wantPort?: number): Promise<ServeInfo> {
  const cur = running.get(p.name);
  if (cur) return info(p.name, cur);

  const rec: Running = { server: null as unknown as Server, port: 0, dir: p.dir,
    startedAt: new Date().toISOString(), hits: 0, token: newToken(), project: p };
  rec.server = makeServer(p.dir, () => { rec.hits++; },
    () => (rec.port ? { project: rec.project, token: rec.token, port: rec.port } : null));

  await new Promise<void>((res, rej) => {
    rec.server.on("error", (e: NodeJS.ErrnoException) => {
      rej(new ToolError(err(X.IO, p.rel, { kind: "key", name: String(wantPort ?? 0) },
        e.code === "EADDRINUSE" ? `端口 ${wantPort} 被占用` : `静态服务起不来：${e.message}`,
        { fix: e.code === "EADDRINUSE" ? "换一个端口，或不传 port 让系统分配" : undefined })));
    });
    rec.server.listen(wantPort ?? 0, "127.0.0.1", () => {
      const a = rec.server.address();
      if (a && typeof a === "object") { rec.port = a.port; res(); }
      else rej(new Error("拿不到端口"));
    });
  });

  /* MCP 进程的生命由客户端的 stdio 决定，静态服务不该挡住它退出 —— 所以 unref。
     ⚠️ 但**前台用法正好相反**：`npm run ui` 里这个服务就是唯一的存活理由，
     unref 之后进程打印完地址就退了，只留一个没人监听的 URL。
     实测踩到（curl 全 000），所以补了下面这个 serveHold()。 */
  rec.server.unref();
  running.set(p.name, rec);
  return info(p.name, rec);
}

/** 前台用法：把服务重新 ref 回来，让它撑住进程。
 *  只有 `ui` 这类自己就是服务的入口才调它 —— MCP 不调。 */
export function serveHold(name: string): boolean {
  const r = running.get(name);
  if (!r) return false;
  r.server.ref();
  return true;
}

export function serveStop(name: string): { stopped: boolean } {
  const r = running.get(name);
  if (!r) return { stopped: false };
  r.server.close();
  running.delete(name);
  return { stopped: true };
}

/** 这个项目当前的服务信息（没起就是 null）—— build_index 要拿令牌注入壳页面 */
export function serveOf(name: string): ServeInfo | null {
  const r = running.get(name);
  return r ? info(name, r) : null;
}

export function serveStatus(): ServeInfo[] {
  return [...running.entries()].map(([n, r]) => info(n, r));
}
