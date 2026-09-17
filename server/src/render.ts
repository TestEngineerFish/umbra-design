/** render_check —— 真实渲染体检。doc/00 §七
 *
 * 为什么必须走 http：`dc-import` 用 fetch 取兄弟稿，Chrome 不允许对 file:// 发 fetch
 * （doc/05 §4.2 实测）。所以起一个本地静态服务指向项目目录。
 *
 * 为什么默认断网：交付要能在内网机器上打开（doc/08 C1）。把"不许有外部请求"
 * 做成常态检查，比事后补测可靠 —— 默认 allowNetwork=false，任何外部请求都被拦下并回报。
 *
 * 判活只认 1+1：截图会骗人，一张不对的截图和一个坏掉的页面在屏上长得一样（doc/04 §2.1）。
 */
import { createServer, type Server } from "node:http";
import { accessSync, constants, createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { saveCheck, sha256, type CheckRecord } from "./check.js";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import { X } from "./codes.js";
import { err, ToolError, warn, type Diagnostic } from "./envelope.js";
import { draftPath, type Project } from "./project.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif", ".woff2": "font/woff2", ".woff": "font/woff",
  ".ttf": "font/ttf", ".map": "application/json; charset=utf-8",
};

/** 是不是一个能执行的**文件**。只判 existsSync 会把 /opt/pw-browsers/chromium
 *  这种同名目录也当成命中，launch 时才炸 —— 验证时实际踩到过。 */
function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch { return false; }
}

/** 浏览器可执行文件：环境变量 → 常见路径。找不到返回 null（不猜、不下载）。 */
export function findBrowser(): { path: string; from: string } | null {
  const envPath = process.env.UMBRADESIGN_CHROMIUM;
  if (envPath && isExecutableFile(envPath)) return { path: envPath, from: "UMBRADESIGN_CHROMIUM" };
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome",
    "/opt/pw-browsers/chromium",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
  for (const c of candidates) if (isExecutableFile(c)) return { path: c, from: "常见路径" };
  return null;
}

/** 带超时的竞速。
 *
 * ⚠️ 为什么非要它：页面主线程真卡死时，`page.evaluate` **永远不返回** ——
 * 一个专门用来检测卡死的工具，自己会在卡死面前死锁。验证时实测到了（死循环稿把
 * 整个 render_check 挂住直到外层超时）。所以凡是跨进程等页面的调用，一律加超时。
 */
function race<T>(pr: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    pr.catch(() => onTimeout),
    new Promise<T>((res) => { timer = setTimeout(() => res(onTimeout), ms); }),
  ]).finally(() => clearTimeout(timer!));
}

function startStatic(rootDir: string): Promise<{ server: Server; port: number }> {
  return new Promise((res, rej) => {
    const server = createServer((req, reply) => {
      const raw = decodeURIComponent((req.url ?? "/").split("?")[0] as string);
      const abs = resolve(rootDir, "." + normalize(raw));
      if (!abs.startsWith(rootDir) || !existsSync(abs) || statSync(abs).isDirectory()) {
        reply.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        reply.end("404");
        return;
      }
      reply.writeHead(200, {
        "content-type": MIME[extname(abs).toLowerCase()] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      createReadStream(abs).pipe(reply);
    });
    server.on("error", rej);
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      if (a && typeof a === "object") res({ server, port: a.port });
      else rej(new Error("静态服务起不来"));
    });
  });
}

export interface RenderOptions {
  width?: number;
  height?: number;
  /** 默认 false —— 断网是常态检查，不是可选项 */
  allowNetwork?: boolean;
  /** 等渲染稳定的上限，毫秒 */
  timeoutMs?: number;
  /** 截图存不存 */
  screenshot?: boolean;
}

export interface RenderResult {
  alive: boolean;
  nodeCount: number;
  renderMs: number;
  unresolvedHoles: Array<{ raw: string; where: string; from: "控制台" | "DOM" }>;
  consoleWarnings: Array<{ level: string; text: string }>;
  styleSheets: Array<{ href: string; rules: number | "跨源读不到" }>;
  missingResources: string[];
  externalRequests: string[];
  screenshot: string | null;
  browser: { path: string; from: string };
  viewport: { width: number; height: number };
  offline: boolean;
  /** 这次读数存到哪了 —— 索引页与后续 build_index 会读它（doc/00 §十五） */
  record: string;
}

export async function renderCheck(
  p: Project, relPath: string, opts: RenderOptions = {}
): Promise<{ result: RenderResult; diags: Diagnostic[] }> {
  const abs = draftPath(p, relPath);
  const found = findBrowser();
  if (!found) {
    throw new ToolError(
      err(X.IO, relPath, { kind: "file", name: "chromium" },
        "找不到可用的 Chromium / Chrome，render_check 跑不了",
        { fix: "装一个 Chrome，或把可执行文件路径写进环境变量 UMBRADESIGN_CHROMIUM。不会自动下载浏览器。" }),
      { searched: "UMBRADESIGN_CHROMIUM 与常见安装路径" }
    );
  }

  let chromium: typeof import("playwright-core").chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    throw new ToolError(err(X.IO, relPath, { kind: "key", name: "playwright-core" },
      "playwright-core 没装",
      { fix: "在 server/ 里跑 npm install（playwright-core 不带浏览器下载，只有 ~2 MB）" }));
  }

  const width = opts.width ?? 1440;
  const height = opts.height ?? 900;
  const offline = !opts.allowNetwork;
  const budget = opts.timeoutMs ?? 20000;

  const { server, port } = await startStatic(p.dir);
  const base = `http://127.0.0.1:${port}`;
  // 关掉浏览器自己的后台联网。page.route 只管页面发起的请求，拦不住浏览器级的
  // 遥测 / 组件更新 —— 一个要断网跑的工具必须把这些也关掉，否则每次体检都在等超时。
  const browser = await chromium.launch({
    executablePath: found.path,
    headless: true,
    args: [
      "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
      "--disable-component-update", "--disable-sync", "--disable-default-apps",
      "--metrics-recording-only", "--disable-domain-reliability", "--no-pings",
      "--disable-features=Translate,OptimizationHints,MediaRouter",
      "--disable-client-side-phishing-detection", "--disable-breakpad", "--disable-crash-reporter",
    ],
  });
  const diags: Diagnostic[] = [];

  try {
    const page = await browser.newPage({ viewport: { width, height } });
    const consoleWarnings: RenderResult["consoleWarnings"] = [];
    const missing: string[] = [];
    const external: string[] = [];

    page.on("console", (m) => {
      const t = m.type();
      if (t !== "error" && t !== "warning") return;
      const text = m.text();
      /* ⚠️ 这里原来有一行 `if (/attribute .*Expected/.test(text)) return;` ——
       * 把这一类整段丢掉，注释写的是「解析原始模板的噪声，不是渲染结果的问题」。
       *
       * 那行是个严重错误，而且它自己害了自己：我后来用 render_check 去**反向验证**
       * 「d 上写洞会不会报错」，4 份真实语料 + 8 个合成形状全是零 —— 于是把一条
       * **真**规则当误报撤回了（doc/00 §二十四 → §二十七 的自我纠错）。
       * 拿被自己消音过的仪器去量，量到的零是仪器的零。
       *
       * 现在改成**单独归类**：仍然不参与 alive 判定（渲染结果确实是对的），
       * 但一定报出来，并且报成自己的一类，说清是解析期的、怎么改。
       * 判据换成「凡是控制台真的说了的，工具都要说」—— 静音是不可以的。
       */
      /* ⚠️ 不能加 ^ 锚点：控制台原文是 `Error: <path> attribute d: Expected …`，
         前面带一个 "Error: "。第一版锚了行首，于是这一类又一次掉回「普通控制台
         error」那一档 —— 自己刚修的分类自己没命中，是渲染验证当场抓出来的。 */
      const svgParse = /<(\w+)> attribute ([\w:-]+): Expected/.exec(text);
      consoleWarnings.push({
        level: svgParse ? "svg-parse" : t,
        text: text.slice(0, 300),
      });
    });
    page.on("pageerror", (e) => consoleWarnings.push({ level: "pageerror", text: String(e).slice(0, 300) }));
    page.on("requestfailed", (r) => {
      const u = r.url();
      if (u.startsWith(base)) missing.push(u.slice(base.length));
    });
    page.on("response", (r) => {
      const u = r.url();
      if (u.startsWith(base) && r.status() >= 400) missing.push(`${u.slice(base.length)} → ${r.status()}`);
    });

    await page.route("**", async (route) => {
      const u = route.request().url();
      if (u.startsWith(base)) return route.continue();
      external.push(u.slice(0, 120));
      if (offline) return route.abort();
      return route.continue();
    });

    const t0 = Date.now();
    const rel = relPath.split(sep).join("/").split("/").map(encodeURIComponent).join("/");
    await page.goto(`${base}/${rel}`, { waitUntil: "commit" });

    // 轮询到节点数稳定（两次相同即停）
    let prev = -1, nodeCount = 0, polled = false;
    const deadline = Date.now() + budget;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 700));
      const left = Math.max(500, Math.min(2500, deadline - Date.now()));
      const n = await race(
        page.evaluate("document.querySelectorAll('*').length") as Promise<number>, left, -1);
      if (n < 0) break;                        // 页面没应答 —— 大概率卡死，交给 1+1 判定
      polled = true;
      nodeCount = n;
      if (nodeCount === prev && nodeCount > 0) break;
      prev = nodeCount;
    }
    void polled;
    const renderMs = Date.now() - t0;

    // 判活只认 1+1
    let alive = false;
    try { await page.waitForFunction("1+1===2", undefined, { timeout: 4000 }); alive = true; } catch { alive = false; }

    let facts = {
      unresolvedHoles: [] as RenderResult["unresolvedHoles"],
      styleSheets: [] as RenderResult["styleSheets"],
      nodeCount,
    };
    if (alive) {
      facts = await race(page.evaluate(`(() => {
        const holes = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n && holes.length < 40; n = walker.nextNode()) {
          for (const m of (n.nodeValue || '').matchAll(/\\{\\{([^}]*)\\}\\}/g)) {
            const el = n.parentElement;
            holes.push({ raw: (m[1] || '').trim(), where: '文本 · <' + (el ? el.tagName.toLowerCase() : '?') + '>', from: 'DOM' });
          }
        }
        for (const el of document.querySelectorAll('*')) {
          if (holes.length >= 40) break;
          for (const a of el.attributes) {
            const m = /\\{\\{([^}]*)\\}\\}/.exec(a.value);
            if (m) holes.push({ raw: (m[1] || '').trim(), where: '属性 ' + a.name + ' · <' + el.tagName.toLowerCase() + '>', from: 'DOM' });
          }
        }
        const sheets = [...document.styleSheets].map((s) => {
          let rules;
          try { rules = s.cssRules.length; } catch (e) { rules = '跨源读不到'; }
          return { href: (s.href || '(inline)').split('/').pop(), rules };
        });
        return { unresolvedHoles: holes, styleSheets: sheets, nodeCount: document.querySelectorAll('*').length };
      })()`) as Promise<typeof facts>, 6000, facts);
    }

    /* ⚠️ 解析不出的洞，运行时到底留下什么 —— 实测（doc/00 §17.1）：
     *
     *   文本洞 {{ x }}   → 渲染成空，DOM 里一个 {{ }} 都不剩，
     *                      只在控制台 warn 一句 "[dc-runtime] <稿名>: {{ x }} never resolved"
     *   属性洞 a="{{ x }}" → 整个属性被丢掉，**控制台一句都没有**
     *
     * 所以上面那段扫 DOM 文本的代码，在运行时正常工作时**永远扫不到东西** ——
     * 这个检测项一直是瞎的。它只在「运行时根本没 boot」时有用（那时模板没编译，
     * {{ }} 还是字面量），所以留着当第二道网。
     * 文本洞的真信号在控制台，这里捞出来。
     * 属性洞没有任何运行时信号 —— 静态校验（E_HOLE_UNRESOLVED）是唯一的网，
     * 所以 validate_draft 不是可选项。
     */
    const NEVER_RESOLVED = /^\[dc-runtime\]\s*(.*?):\s*\{\{([^}]*)\}\}\s*never resolved/;
    for (const c of consoleWarnings) {
      const m = NEVER_RESOLVED.exec(c.text);
      if (!m) continue;
      const raw = (m[2] ?? "").trim();
      if (facts.unresolvedHoles.some((h) => h.raw === raw)) continue;
      facts.unresolvedHoles.push({ raw, where: `文本 · 组件 ${m[1] || "?"}`, from: "控制台" });
    }

    let shot: string | null = null;
    if (alive && opts.screenshot !== false) {
      const dir = join(p.dir, ".umbradesign", "shots");
      await mkdir(dir, { recursive: true });
      const name = `${relPath.replace(/[\\/]/g, "__").replace(/\.dc\.html$/, "")}@${width}x${height}.png`;
      const okShot = await race(page.screenshot({ path: join(dir, name) }).then(() => true), 8000, false);
      shot = okShot ? join(".umbradesign", "shots", name).split(sep).join("/") : null;
    }

    // ── 诊断 ──
    if (!alive) {
      diags.push(err(X.IO, relPath, { kind: "file", name: relPath },
        "页面没画出来：1+1 都算不出，主线程卡死",
        { fix: "不报错的挂起只能二分（doc/04 §2.2）。先看 consoleWarnings，再逐块删内容定位。" }));
    }
    for (const h of facts.unresolvedHoles.slice(0, 8)) {
      diags.push(warn(X.IO, relPath, { kind: "hole", name: h.raw },
        h.from === "控制台"
          ? `洞 "{{ ${h.raw} }}" 渲染时解析不出，那一处渲染成了空（${h.where}）`
          : `渲染后还留着未解析的洞 "{{ ${h.raw} }}"（${h.where}）—— 运行时很可能根本没 boot`,
        { fix: "这个洞在 renderVals() 里没给值，或者根名拼错了" }));
    }
    for (const u of [...new Set(missing)].slice(0, 8)) {
      diags.push(warn(X.IO, relPath, { kind: "path", name: u }, `资源取不到：${u}`,
        { fix: "路径以引用方文件为基准；运行时三件套要与稿同层（check_runtime 可以查）" }));
    }
    if (offline && external.length) {
      for (const u of [...new Set(external)].slice(0, 5)) {
        diags.push(warn(X.IO, relPath, { kind: "path", name: u },
          `有外部请求：${u}（已拦下）`,
          { fix: "交付要能在断网机器上打开。React 走同层本地副本（write_draft 自动注入映射），字体用系统栈" }));
      }
    }
    /* 解析期的 SVG 属性报错单独一类。实测（doc/00 §二十七，15 个形状）：
       几何类属性 —— path d / polyline points / g transform / svg viewBox /
       circle cx,r / svg width / rect x,y,width,height / line x1 —— 洞必报；
       涂装类（fill、stroke-width）、HTML 属性（img width）、style 里的洞不报。
       渲染结果是对的，所以只报 warning；但**必须报**，否则控制台永远脏着
       而工具说它干净。 */
    const svgNoise = consoleWarnings.filter((c) => c.level === "svg-parse");
    for (const c of svgNoise.slice(0, 6)) {
      const m = /<(\w+)> attribute ([\w:-]+):/.exec(c.text);
      diags.push(warn(X.IO, relPath, { kind: "tag", name: m ? `${m[1]}[${m[2]}]` : "svg" },
        `解析期报错：${c.text}`,
        { fix: "SVG 几何属性在解析那一刻就按类型校验，那时洞还没被替换，必报。"
             + "洞挂到 data-* 上、渲染后抄进真属性（ui/IconGlyph.dc.html 就是这么做的），"
             + "或者直接用那个子组件（doc/06 §2.8）" }));
    }
    // 已经归成「洞」和「解析期」的那几条不再重复报一遍
    for (const c of consoleWarnings.filter((x) => !NEVER_RESOLVED.test(x.text) && x.level !== "svg-parse").slice(0, 6)) {
      diags.push(warn(X.IO, relPath, { kind: "key", name: c.level },
        `控制台 ${c.level}：${c.text}`));
    }

    // 读数落盘：索引页的「节点 / 耗时」列和健康判定都读它。
    // srcSha256 用体检时那一版源码算 —— 稿再改，索引就知道这份读数过期了。
    const rec: CheckRecord = {
      file: relPath,
      checkedAt: new Date().toISOString(),
      srcSha256: sha256(await readFile(abs, "utf8")),
      alive, nodeCount: facts.nodeCount, renderMs,
      viewport: { width, height }, offline, screenshot: shot,
      counts: {
        unresolvedHoles: facts.unresolvedHoles.length,
        missingResources: [...new Set(missing)].length,
        externalRequests: [...new Set(external)].length,
        consoleWarnings: consoleWarnings.length,
      },
    };
    const recPath = await saveCheck(p, rec);

    return {
      result: {
        alive, nodeCount: facts.nodeCount, renderMs,
        unresolvedHoles: facts.unresolvedHoles, consoleWarnings,
        styleSheets: facts.styleSheets,
        missingResources: [...new Set(missing)],
        externalRequests: [...new Set(external)],
        screenshot: shot, browser: found, viewport: { width, height }, offline,
        record: relative(p.dir, recPath).split(sep).join("/"),
      },
      diags,
    };
  } finally {
    // 卡死的渲染进程会让 close() 挂住 —— 超时就硬杀，不然工具跟着一起挂
    const closed = await race(browser.close().then(() => true), 5000, false);
    if (!closed) {
      const proc = (browser as unknown as { process?: () => { kill?: (s?: string) => void } | null }).process?.();
      try { proc?.kill?.("SIGKILL"); } catch { /* 已经没了 */ }
    }
    server.close();
  }
}
