/** 形态 A 的静态服务。doc/01 §4.2
 *
 * 为什么必须有：`dc-import` 用 fetch 取兄弟稿，Chrome 不允许对 file:// 发 fetch
 * （doc/05 §4.2）。所以带 dc-import 的稿只能走 http，双击打不开。
 *
 * 服务活在 MCP server 进程里，跨工具调用保持运行 —— 起一次，浏览器里一直能开。
 */
import { createReadStream, existsSync, statSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, normalize, resolve, relative, sep } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { emit, subscribe } from "./events.js";
import { X } from "./codes.js";
import { err, ToolError } from "./envelope.js";
import { TOOL_ROOT, type Project } from "./project.js";
import { isToolPage } from "./indexpage.js";
import { API_PREFIX, handleApi, newToken, type ApiCtx } from "./api.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif", ".woff2": "font/woff2", ".woff": "font/woff",
  ".ttf": "font/ttf", ".map": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

interface Running { server: Server; port: number; dir: string; startedAt: string; hits: number; token: string; project: Project; wss: WebSocketServer | null; watcher: FSWatcher | null; unsubscribe: (() => void) | null }

/** 前端构建产物（`app/`，M7-2；M7-8 起是唯一的前端）。没 build 过就只能提示去 build。 */
const APP_DIST = resolve(TOOL_ROOT, "app", "dist");
export function appDistReady(): boolean { return existsSync(resolve(APP_DIST, "index.html")); }
const NO_BUILD_PAGE = `<!doctype html><meta charset="utf-8"><title>Umbra Studio</title>`
  + `<body style="margin:0;display:grid;place-items:center;height:100vh;font:13px/1.7 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;background:#f6f7f9;color:#191c21">`
  + `<div style="text-align:center"><p style="font-weight:620">前端还没构建</p>`
  + `<p style="color:#79818d">在仓库根跑一次：<code style="font-family:ui-monospace,Menlo,monospace">npm --prefix app install &amp;&amp; npm --prefix app run build</code></p></div>`;

function serveStatic(root: string, rel: string, reply: import("node:http").ServerResponse): boolean {
  const f = resolve(root, "." + normalize(rel));
  if (!f.startsWith(root) || !existsSync(f) || statSync(f).isDirectory()) return false;
  reply.writeHead(200, { "content-type": MIME[extname(f).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" });
  createReadStream(f).pipe(reply);
  return true;
}

/** 进程级注册表：项目名 → 正在跑的服务 */
const running = new Map<string, Running>();

function makeServer(dir: string | null, onHit: () => void, api: () => ApiCtx | null): Server {
  return createServer((req, reply) => {
    onHit();

    // CORS：允许 Tauri webview（tauri://localhost 或 http://127.0.0.1:*）跨域访问
    const origin = req.headers.origin;
    const allowOrigin = origin?.startsWith('http://127.0.0.1:') || origin?.startsWith('http://localhost:') || origin === 'tauri://localhost'
      ? origin
      : null;

    // 处理 OPTIONS 预检请求
    if (req.method === 'OPTIONS') {
      if (allowOrigin) {
        reply.writeHead(204, {
          'access-control-allow-origin': allowOrigin,
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type, x-ud-token',
        });
      } else {
        reply.writeHead(403);
      }
      reply.end();
      return;
    }

    // /__ud/* 交给本地 JSON API（doc/00 §二十）。壳要的诊断 / 变更 / slots
    // 每改一次稿就变，注入解决不了，所以走接口。
    const ctx = api();
    if (ctx && (req.url ?? "").startsWith(API_PREFIX)) {
      // 设置 CORS 头
      if (allowOrigin) {
        reply.setHeader('access-control-allow-origin', allowOrigin);
      }
      void handleApi(req, reply, ctx).catch(() => {
        reply.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        reply.end(JSON.stringify({ ok: false, errors: [{ code: "E_API", message: "接口内部出错" }] }));
      });
      return;
    }
    let raw: string;
    try { raw = decodeURIComponent((req.url ?? "/").split("?")[0] as string); }
    catch { raw = "/"; }
    /* /__app/ —— 应用前端本体由本服务托管：和稿同源，令牌注入（doc/00 §四十六）。 */
    const c = api();
    const useApp = appDistReady();
    if (raw === "/__app" || raw === "/__app/" || raw === "/__app/index.html" || (useApp && raw.startsWith("/__app/") && !existsSync(resolve(APP_DIST, "." + normalize(raw.slice("/__app".length)))))) {
      reply.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      if (!useApp) { reply.end(NO_BUILD_PAGE); return; }
      // SPA：/__app/ 下任何不是静态文件的路径都回 index.html（前端自己按路径分页）
      const boot = c ? `<script>window.__UD_APP=${JSON.stringify({ url: `http://127.0.0.1:${c.port}/`, token: c.token, name: c.project?.name ?? null, title: c.project?.title ?? null, dir: c.project?.dir ?? null, ws: `ws://127.0.0.1:${c.port}${API_PREFIX}ws`, hub: !c.project })};</script>` : "";
      reply.end(readFileSync(resolve(APP_DIST, "index.html"), "utf8").replace(/<head>/i, "<head>" + boot));
      return;
    }
    if (raw.startsWith("/__app/") && serveStatic(APP_DIST, raw.slice("/__app".length), reply)) return;
    if (raw === "/" || raw.endsWith("/")) raw += "index.dc.html";
    if (dir === null) {   // hub：没有项目目录，只有 /__app/ 与全局 API
      reply.writeHead(302, { location: "/__app/home" }); reply.end(); return;
    }
    const abs = resolve(dir, "." + normalize(raw));
    if (!abs.startsWith(dir) || !existsSync(abs) || statSync(abs).isDirectory()) {
      reply.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      reply.end(`404 ${raw}`);
      return;
    }
    const head = {
      "content-type": MIME[extname(abs).toLowerCase()] ?? "application/octet-stream",
      // 设计稿改一下就要能刷出来，所以一律不缓存
      "cache-control": "no-store, must-revalidate",
      // CORS 头
      ...(allowOrigin && { "access-control-allow-origin": allowOrigin }),
    };

    /* 工具页（S1–S15 那些我们部署进项目的界面稿）的 `__UD_API` **在这里现给**，不读盘上那份。
     *
     * 盘上那份是 `build_index` 当时写的，钉着**那一刻**的端口和令牌 —— 而端口每次起服务都重随机、
     * 令牌也重新生成。于是隔一次启动再打开 S8 就是「接口读不到: Failed to fetch」：
     * 它拿着一个早就没人监听的端口在敲门（2026-09-24 用户实测，`00` §六十六）。
     *
     * 顺带解决一个更隐蔽的问题：令牌本来被写进了稿件文件，那份稿被拷走令牌就跟着走。
     * 现在盘上只留 `null`，令牌只活在这一次响应里 —— 这也才真的符合「令牌只出现在壳页面里」（§20.2）。
     */
    if (isToolPage(relFromDir(dir, abs)) && abs.endsWith(".dc.html")) {
      const api = { base: `${API_PREFIX}`, token: c?.token ?? "" };   // base 用相对路径：跟着页面自己的源走，换端口也不会错
      const src = readFileSync(abs, "utf8").replace(
        /window\.__UD_API\s*=\s*(?:\{[\s\S]*?\}|null)\s*;/,
        `window.__UD_API = ${JSON.stringify(api)};`);
      reply.writeHead(200, head);
      reply.end(src);
      return;
    }
    reply.writeHead(200, head);
    createReadStream(abs).pipe(reply);
  });
}

/** abs → 相对项目根、用 / 分隔 —— isToolPage 认的是这种形状 */
function relFromDir(dir: string, abs: string): string {
  return abs.slice(dir.length).replace(/^[/\\]/, "").split(sep).join("/");
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
    startedAt: new Date().toISOString(), hits: 0, token: newToken(), project: p, wss: null, watcher: null, unsubscribe: null };
  rec.server = makeServer(p.dir, () => { rec.hits++; },
    () => (rec.port ? { project: rec.project, token: rec.token, port: rec.port } : null));
  attachWs(rec);

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

/** hub（M9-2）：桌面壳的入口服务 —— 不属于任何项目，只托管 /__app/ 与全局路由（projects / open_project / …）。
 *  首页要在没打开项目时就能列项目，所以壳一起来就起它；项目各自的服务仍由 open_project 按需起。 */
const HUB_KEY = "__hub__";
export async function hubStart(wantPort?: number): Promise<{ url: string; port: number; token: string }> {
  const cur = running.get(HUB_KEY);
  if (cur) return { url: `http://127.0.0.1:${cur.port}/`, port: cur.port, token: cur.token };
  const rec: Running = { server: null as unknown as Server, port: 0, dir: "", startedAt: new Date().toISOString(), hits: 0, token: newToken(),
    project: null as unknown as Project, wss: null, watcher: null, unsubscribe: null };
  rec.server = makeServer(null, () => { rec.hits++; }, () => (rec.port ? { project: null, token: rec.token, port: rec.port } : null));
  attachWs(rec, true);
  await new Promise<void>((res, rej) => {
    rec.server.on("error", (e) => rej(e));
    rec.server.listen(wantPort ?? 0, "127.0.0.1", () => { const a = rec.server.address(); if (a && typeof a === "object") { rec.port = a.port; res(); } else rej(new Error("拿不到端口")); });
  });
  rec.server.unref();
  running.set(HUB_KEY, rec);
  return { url: `http://127.0.0.1:${rec.port}/`, port: rec.port, token: rec.token };
}

export function serveStop(name: string): { stopped: boolean } {
  const r = running.get(name);
  if (!r) return { stopped: false };
  r.unsubscribe?.(); r.watcher?.close(); r.wss?.close();
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

/* ── WebSocket（M7-4）：/__ud/ws?token=<令牌>。令牌与 Origin 的门槛和 HTTP 一样。
   连接上先回 hello；之后把事件总线里属于本项目（或全局）的事件原样推过去；
   同时监听项目目录，磁盘上文件变了（外部编辑器、git checkout）推一条 fs。 ── */
function attachWs(rec: Running, hub = false): void {
  const wss = new WebSocketServer({ noServer: true });
  rec.wss = wss;
  rec.server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${rec.port}`);
    const o = req.headers.origin;
    const originOk = !o || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o) || o === "null";
    if (url.pathname !== API_PREFIX + "ws" || url.searchParams.get("token") !== rec.token || !originOk) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); socket.destroy(); return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  wss.on("connection", (ws: WebSocket) => {
    ws.send(JSON.stringify({ type: "hello", projectDir: hub ? null : rec.dir, payload: { project: hub ? null : rec.project.name, port: rec.port }, at: new Date().toISOString() }));
  });
  rec.unsubscribe = subscribe((e) => {
    if (!hub && e.projectDir && e.projectDir !== rec.dir) return;   // hub 收全部事件（首页要知道哪个项目动了）
    const line = JSON.stringify(e);
    for (const c of wss.clients) if (c.readyState === c.OPEN) c.send(line);
  });
  if (hub) return;
  // 磁盘监听：只报稿与文档一类，工具自己的产物（.umbrastudio/、快照）不报；200ms 合并一次
  try {
    let pending = new Set<string>(); let timer: NodeJS.Timeout | null = null;
    rec.watcher = watch(rec.dir, { recursive: true }, (_ev, name) => {
      if (!name) return;
      const rel = String(name).split(sep).join("/");
      if (rel.startsWith(".") || rel.includes("/.") || rel.includes("node_modules")) return;
      if (!/\.(dc\.html|md|html|css|js|json|png|jpe?g|webp|gif|svg)$/i.test(rel)) return;
      pending.add(rel);
      if (!timer) timer = setTimeout(() => { const changes = [...pending]; pending = new Set(); timer = null; emit("fs", rec.dir, { changes }); }, 200);
    });
    rec.watcher.unref?.();
  } catch { rec.watcher = null; /* 平台不支持 recursive 就不监听，事件其它三种照推 */ }
}
