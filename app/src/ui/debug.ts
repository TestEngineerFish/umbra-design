/** 底栏调试模块的数据源（M8-20，键名照设计侧第八轮 S11 L775）。
 *
 *  设计侧划的那条线很清楚：**「工具自己的状况」进底栏，「这份文件的质量」不进。**
 *  所以体检明细不进（那是诊断面板的事）、AI 用量不进（会话栏底部已经有「本轮多少」）。
 *
 *  这里只做采集，形制在 `workbench/BottomBar.tsx`。
 *  环形缓冲 200 条 —— 调试输出是流水，留着全部只会让界面越用越慢，
 *  而人真正要看的永远是最近那几十条。
 */
export type Level = "info" | "warn" | "error";
export interface OutRow { t: string; level: Level; text: string }
export interface ToolRow { t: string; name: string; args: string; ms: number | null; ok: boolean; err?: string }
export interface ConnRow { t: string; dir: "↑" | "↓"; type: string; detail: string }

const CAP = 200;
const out: OutRow[] = [];
const conn: ConnRow[] = [];
const subs = new Set<() => void>();
const now = () => new Date().toTimeString().slice(0, 8);
const push = <T,>(arr: T[], row: T) => { arr.push(row); if (arr.length > CAP) arr.shift(); fire(); };
const fire = () => { for (const f of subs) f(); };

export const debugBus = {
  subscribe(f: () => void): () => void { subs.add(f); return () => subs.delete(f); },
  out(): readonly OutRow[] { return out; },
  conn(): readonly ConnRow[] { return conn; },
  /** 有没有没看过的 error —— 顶栏那颗底栏钮靠它挂红点 */
  hasError(): boolean { return out.some((o) => o.level === "error"); },
  log(level: Level, text: string): void { push(out, { t: now(), level, text: text.slice(0, 500) }); },
  wire(dir: "↑" | "↓", type: string, detail = ""): void { push(conn, { t: now(), dir, type, detail: detail.slice(0, 200) }); },
  clearOut(): void { out.length = 0; fire(); },
  clearConn(): void { conn.length = 0; fire(); },
};

let wired = false;
/** 接上前端这边能拿到的三种来源。**核心的 stderr 前端拿不到** ——
 *  它要么经 WS 推上来，要么只能在终端里看；这一条如实记着，别让底栏假装什么都收得到。 */
export function wireDebug(): void {
  if (wired) return;
  wired = true;
  window.addEventListener("error", (e) => debugBus.log("error", `${e.message} @ ${e.filename?.split("/").pop() ?? "?"}:${e.lineno}`));
  window.addEventListener("unhandledrejection", (e) => debugBus.log("error", `未处理的 Promise：${String((e as PromiseRejectionEvent).reason).slice(0, 200)}`));
  /* toast 是用户看得见的那些提示，过一遍这里就有了历史 —— 提示条几秒就没，出问题时人常常没来得及看清 */
  window.addEventListener("ud-toast", (e) => {
    const d = (e as CustomEvent<{ title?: string; body?: string; kind?: string }>).detail ?? {};
    debugBus.log(d.kind === "error" ? "error" : "info", [d.title, d.body].filter(Boolean).join(" · "));
  });
}
